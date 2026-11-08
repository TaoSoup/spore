// Dry-run launches for root agents (DESIGN §13, phase 0). Builds the exact create_v2 transaction an
// agent would send for a proposal (the same instructions web/src/lib/pump/spawn.ts builds for a
// child: compute budget, optional launch fee, create_v2 quoted in the root, the sharing config's
// vault token account, create_fee_sharing_config and update_fee_shares_v2 with Spore's split, in one
// v0 transaction over Spore's lookup table, or create + split in two when it would not fit) and runs
// it through simulateTransaction. Nothing is ever signed or sent.
//
// Why sending is impossible here, not just avoided:
//   - The agent's wallet and the coin's mint are placeholder keys: program-derived addresses under a
//     namespace no program owns. A PDA is off the ed25519 curve, so no private key exists for it and
//     no one, this code included, can ever produce its signature.
//   - The transactions are built unsigned (signatures stay zero) and simulated with
//     `sigVerify: false`; there is no keypair type, signing call or send path in lib/agents.
//   - Every chain call goes through `readOnlyRpc`, which refuses any method but five reads and
//     simulateTransaction.
// A launch that does not fit one transaction is two (create, then sweep + split), as on the web;
// only the first can be simulated before the coin exists, so the second one's rent is computed
// from the sizes of the two accounts it creates and its fee from its signatures and compute limit.
// The simulation needs a fee payer with SOL, which the placeholder cannot be: the simulated variant
// prepends one transfer from a funded public probe wallet to the placeholder and lets the probe pay
// the fee. The reported size is the real transaction's (the placeholder pays, no transfer); the cost
// is what the placeholder spent in the simulation (rent, launch fee) plus the real fee.
import { createHash } from "node:crypto";
import { Rpc } from "../rpc.mjs";
import { reasonFor } from "../eligibility.mjs";
import {
  PUMP_SDK, OnlinePumpSdk, PublicKey, VersionedTransaction, ComputeBudgetProgram, SystemProgram, TransactionMessage, AddressLookupTableAccount,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, feeSharingConfigPda, creatorVaultPda, TOKEN_2022_PROGRAM_ID,
} from "../sdk.mjs";

export const LOOKUP_TABLE = "5WK4tafybAnHV4grvSipYfLfV8Bd7Rzcwb5eNE1PQRnx"; // Spore's frozen table (DESIGN §11.4), the one web/src/lib/pump/alt.ts uses
export const PROBE_PAYER = "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs";  // a funded public wallet; only its address is used
export const MAX_TX_BYTES = 1232;
export const CU_PRICE_MICRO = 50_000;   // the web builder's priority fee (trade.ts)
export const CU_SINGLE = 450_000, CU_SPLIT = 300_000; // spawn.ts limits: create + split in one, or each half
export const SIM_FUND_LAMPORTS = 100_000_000n; // what the probe lends the placeholder inside the simulation (0.1 SOL)
const BASE_FEE_LAMPORTS = 5_000;        // per signature
const ANY_BLOCKHASH = "11111111111111111111111111111111"; // replaced by the node (replaceRecentBlockhash)
const READS = new Set(["getAccountInfo", "getMultipleAccounts", "getBalance", "getMinimumBalanceForRentExemption", "simulateTransaction"]);
// What the second transaction of a split launch creates, for its rent: pump-fees allocates 1024 bytes
// per sharing config (measured 2026-10-19 on live Spore children), and the vault's quote token
// account is 170 bytes under Token-2022 (ImmutableOwner), 165 under SPL Token.
export const SHARING_CONFIG_BYTES = 1024;
const ATA_BYTES = { token2022: 170, spl: 165 };

/** Placeholder keys live under this namespace (a hash, not a deployed program), so they are PDAs nobody can sign for. */
export const NAMESPACE = new PublicKey(createHash("sha256").update("spore/root-agents/dry-run/v1").digest());
/** The address that stands in for a root's future agent wallet in dry mode (stable per root, off-curve). */
export function agentPlaceholder(root) { return PublicKey.findProgramAddressSync([Buffer.from("agent"), new PublicKey(root).toBuffer()], NAMESPACE)[0]; }
/** A proposal's stand-in mint (stable per root and seed, off-curve). */
export function mintPlaceholder(root, seed) { return PublicKey.findProgramAddressSync([Buffer.from("mint"), new PublicKey(root).toBuffer(), createHash("sha256").update(String(seed)).digest()], NAMESPACE)[0]; }

/**
 * The only chain access the agents get: five reads and simulateTransaction, each on the caller's
 * RPC lane (`rpc.call(method, params)`), with the account helpers rebuilt on top of the guarded
 * call so nothing can reach the client's other methods. Anything else throws.
 */
export function readOnlyRpc(rpc) {
  if (rpc?.__agentsReadOnly) return rpc;
  const call = (method, params = []) => {
    if (!READS.has(method)) throw new Error(`agents: ${method} is not available to agents (dry run: read and simulate only)`);
    return rpc.call(method, params);
  };
  return Object.freeze({
    __agentsReadOnly: true,
    call,
    async getAccountInfo(key) { return Rpc.account((await call("getAccountInfo", [key, { encoding: "base64", commitment: "confirmed" }])).value); },
    async getMultipleAccounts(keys) {
      const out = [];
      for (let i = 0; i < keys.length; i += 100) out.push(...(await call("getMultipleAccounts", [keys.slice(i, i + 100), { encoding: "base64", commitment: "confirmed" }])).value.map(Rpc.account));
      return out;
    },
    async simulate(tx, addresses = []) {
      return (await call("simulateTransaction", [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses } }])).value;
    },
  });
}

/** The two reads the SDK's `resolveQuoteMint` makes, answered through the read-only client. */
function connectionOver(ro) {
  const info = (a) => (a ? { owner: new PublicKey(a.owner), lamports: a.lamports, data: a.data, executable: !!a.executable, rentEpoch: 0 } : null);
  return {
    rpcEndpoint: "agents-read-only", commitment: "confirmed",
    async getAccountInfo(key) { return info(await ro.getAccountInfo(new PublicKey(key).toBase58())); },
    async getMultipleAccountsInfo(keys) { return (await ro.getMultipleAccounts(keys.map((k) => new PublicKey(k).toBase58()))).map(info); },
  };
}

let tableCache = null; // the frozen table never changes: fetched once per process (a failure is not cached)
async function lookupTable(ro) {
  if (!tableCache) {
    tableCache = ro.getAccountInfo(LOOKUP_TABLE).then((a) => {
      if (!a) throw new Error(`lookup table ${LOOKUP_TABLE} not found`);
      return new AddressLookupTableAccount({ key: new PublicKey(LOOKUP_TABLE), state: AddressLookupTableAccount.deserialize(a.data) });
    });
    tableCache.catch(() => { tableCache = null; });
  }
  return tableCache;
}

const compile = (payer, ixs, tables) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: ANY_BLOCKHASH, instructions: ixs }).compileToV0Message(tables));
const sizeOf = (tx) => { try { return tx.serialize().length; } catch { return null; } };
const cu = (units) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO })];
const feeOf = (tx, units) => BASE_FEE_LAMPORTS * tx.message.header.numRequiredSignatures + Math.ceil((CU_PRICE_MICRO * units) / 1e6);

/**
 * The instructions of an agent launch under `rootMint`, offline once `resolved` (the SDK's
 * `resolveQuoteMint` answer: `quoteTokenProgram`, `pumpQuote.accounts`) is known. Returns the real
 * transaction(s) the agent would send and the probe-funded variant of the first one to simulate.
 */
export function buildLaunch({ rootMint, resolved, agent, mint, form, shares, launchFee = null, tables = [], probe = PROBE_PAYER, fund = SIM_FUND_LAMPORTS }) {
  const quoteMint = new PublicKey(rootMint), quoteTokenProgram = resolved.quoteTokenProgram;
  const fee = launchFee && BigInt(launchFee.lamports) > 0n ? [SystemProgram.transfer({ fromPubkey: agent, toPubkey: new PublicKey(launchFee.to), lamports: BigInt(launchFee.lamports) })] : [];
  return Promise.all([
    PUMP_SDK.createV2Instruction({ mint, name: form.name, symbol: form.symbol, uri: form.uri, creator: agent, user: agent, mayhemMode: false, quoteMint, quoteTokenProgram, holderReward: false, pumpQuote: resolved.pumpQuote.accounts }),
    PUMP_SDK.createFeeSharingConfig({ creator: agent, mint, pool: null }),
    PUMP_SDK.updateFeeSharesV2({ authority: agent, mint, currentShareholders: [agent], newShareholders: shares.map((s) => ({ address: new PublicKey(s.address), shareBps: s.bps })), quoteMint, quoteTokenProgram, bondingCurveComplete: false }),
    PUMP_SDK.sweepCreatorFeeInstruction({ payer: agent, mint, creator: agent, quoteMint, quoteTokenProgram }),
  ]).then(([create, config, split, sweep]) => {
    const vault = creatorVaultPda(feeSharingConfigPda(mint));
    const vaultAta = createAssociatedTokenAccountIdempotentInstruction(agent, getAssociatedTokenAddressSync(quoteMint, vault, true, quoteTokenProgram), vault, quoteMint, quoteTokenProgram);
    const funding = SystemProgram.transfer({ fromPubkey: new PublicKey(probe), toPubkey: agent, lamports: fund });
    const single = [...fee, create, vaultAta, config, split];
    const one = compile(agent, [...cu(CU_SINGLE), ...single], tables);
    const n = sizeOf(one);
    // The probe-funded variant carries one more instruction and one more key than the real
    // transaction; when only the real one fits (seen live 2026-10-19: 1232 vs ~1335 bytes), the
    // launch takes the two-transaction path so what is simulated is what is sent.
    const simOne = compile(new PublicKey(probe), [...cu(CU_SINGLE), funding, ...single], tables);
    const ns = sizeOf(simOne);
    if (n !== null && n <= MAX_TX_BYTES && ns !== null && ns <= MAX_TX_BYTES) {
      return { txs: [one], units: [CU_SINGLE], bytes: [n], simTx: simOne };
    }
    // As spawn.ts does when one transaction is too large: create first, then sweep + split.
    const tx1 = compile(agent, [...cu(CU_SPLIT), ...fee, create], tables), tx2 = compile(agent, [...cu(CU_SPLIT), sweep, vaultAta, config, split], tables);
    return { txs: [tx1, tx2], units: [CU_SPLIT, CU_SPLIT], bytes: [sizeOf(tx1), sizeOf(tx2)], simTx: compile(new PublicKey(probe), [...cu(CU_SPLIT), funding, ...fee, create], tables) };
  });
}

/** One readable line from a failed simulation: the error, pump's custom code when there is one, and the last error log. */
export function explainSimulation(err, logs = []) {
  const custom = logs.join("\n").match(/custom program error: 0x([0-9a-f]+)/i);
  const last = [...logs].reverse().find((l) => /error|failed|insufficient/i.test(l));
  return `${typeof err === "string" ? err : JSON.stringify(err)}${custom ? ` (custom ${parseInt(custom[1], 16)})` : ""}${last ? `: ${last}` : ""}`.slice(0, 300);
}

/**
 * Builds and simulates the launch of `form` under `root` (a model coin, depth 0) for the root's
 * placeholder agent. Resolves to the stored `sim_json`:
 *   { ok, bytes, unitsConsumed, err, estCostSol, txs, feeTxBytes, agent, mint, payer, simulatedAt, costBasis }
 * `ok` false with `err` covers an ineligible root (pump's own typed errors), a transaction over the
 * size limit and a failed simulation; an RPC failure rejects.
 */
export async function simulateLaunch({ rpc, root, form, shares, launchFee = null, seed, probe = PROBE_PAYER, now = () => Math.floor(Date.now() / 1000) }) {
  const ro = readOnlyRpc(rpc);
  const agent = agentPlaceholder(root.mint), mint = mintPlaceholder(root.mint, seed);
  const base = { ok: false, bytes: null, unitsConsumed: null, err: null, estCostSol: null, txs: 0, feeTxBytes: null, agent: agent.toBase58(), mint: mint.toBase58(), payer: probe, simulatedAt: now() };
  let resolved;
  try { resolved = await new OnlinePumpSdk(connectionOver(ro)).resolveQuoteMint(new PublicKey(root.mint)); }
  catch (e) {
    if (/^(CurveDepthExceeded|QuoteBondingCurveNotEligible|QuoteCurveAwaitingMigration|QuoteReservesOutOfRange|QuotePoolNotFound|UnsupportedQuoteMint)Error$/.test(e?.name ?? "")) return { ...base, err: reasonFor(e, { mint: root.mint, depth: (root.depth ?? 0) + 1, maxDepth: 2, mayhem: !!root.mayhem }) };
    throw e;
  }
  if (resolved.source !== "pumpCoin" || !resolved.pumpQuote) return { ...base, err: "the root is not a pump.fun coin that can take children" };
  const built = await buildLaunch({ rootMint: root.mint, resolved, agent, mint, form, shares, launchFee, tables: [await lookupTable(ro)], probe });
  const out = { ...base, txs: built.txs.length, bytes: built.bytes[0], feeTxBytes: built.bytes[1] ?? null };
  if (built.bytes.some((b) => b === null || b > MAX_TX_BYTES)) return { ...out, err: `transaction too large (${built.bytes.map((b) => b ?? `>${MAX_TX_BYTES}`).join(" + ")} bytes)` };
  const v = await ro.simulate(built.simTx, [agent.toBase58()]);
  const logs = v?.logs ?? [];
  if (v?.err) return { ...out, unitsConsumed: v.unitsConsumed ?? null, err: explainSimulation(v.err, logs) };
  const left = BigInt(v?.accounts?.[0]?.lamports ?? 0);
  const spent = SIM_FUND_LAMPORTS - left; // rent of every account the launch creates, plus the launch fee
  const fees = built.txs.reduce((a, tx, i) => a + feeOf(tx, built.units[i]), 0);
  let rent2 = 0n;
  if (built.txs.length > 1) {
    const ata = resolved.quoteTokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? ATA_BYTES.token2022 : ATA_BYTES.spl;
    const [cfg, vault] = await Promise.all([ro.call("getMinimumBalanceForRentExemption", [SHARING_CONFIG_BYTES]), ro.call("getMinimumBalanceForRentExemption", [ata])]);
    rent2 = BigInt(cfg) + BigInt(vault);
  }
  return { ...out, ok: true, unitsConsumed: v.unitsConsumed ?? null, estCostSol: Number(spent + rent2 + BigInt(fees)) / 1e9, costBasis: built.txs.length > 1 ? "first transaction simulated, second computed" : "simulated" };
}
