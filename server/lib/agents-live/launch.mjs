// A real launch by a root agent (DESIGN §13.1): the same transaction the dry run simulates
// (lib/agents/simulate.mjs buildLaunch — create_v2 under the root, Spore's fee split where the agent's
// wallet is the creator), with the agent's real wallet, a fresh mint keypair and a real blockhash,
// simulated once more at the moment of sending and then signed and sent.
//
// Order of operations, each a gate: resolve the root as a pump coin that can take children → publish
// the metadata (logo + JSON) on our host → build → simulate the first transaction with the real
// payer and price the second exactly (rent of the sharing config and the vault's quote account plus
// its fee) → the budget must cover cost + margin + reserve → ledger + registry record → sign (agent +
// mint) → send → confirm; the second transaction (fee split) follows with its own blockhash and is
// recorded as owed if it does not land, so a later pass can finish it (`finishSplit`). The mint
// keypair lives only in this call. Fund-critical.
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { OnlinePumpSdk, TOKEN_2022_PROGRAM_ID } from "../sdk.mjs";
import { Rpc } from "../rpc.mjs";
import { buildLaunch, MAX_TX_BYTES, CU_PRICE_MICRO, CU_SPLIT, SHARING_CONFIG_BYTES } from "../agents/simulate.mjs";
import { splitShares } from "../pricing.mjs";
import { canLaunch, LAMPORTS_PER_SOL } from "./budget.mjs";
import { recentBlockhash, lookupTable, simulate, sendAndConfirm, TxError } from "./tx.mjs";

export class LaunchError extends Error { constructor(message, code = "launch") { super(message); this.name = "LaunchError"; this.code = code; } }

const BASE_FEE_LAMPORTS = 5_000;
const ATA_BYTES = { spl: 165, token2022: 170 };
const sig58 = (tx) => bs58.encode(tx.signatures[0]);

/** The two reads the SDK's resolveQuoteMint makes, answered through our RPC. */
function connectionOver(rpc) {
  const info = (v) => { const a = Rpc.account(v); return a ? { owner: new PublicKey(a.owner), lamports: a.lamports, data: a.data, executable: !!a.executable, rentEpoch: 0 } : null; };
  return {
    rpcEndpoint: "agents-live", commitment: "confirmed",
    async getAccountInfo(key) { return info((await rpc.call("getAccountInfo", [new PublicKey(key).toBase58(), { encoding: "base64", commitment: "confirmed" }]))?.value); },
    async getMultipleAccountsInfo(keys) { return ((await rpc.call("getMultipleAccounts", [keys.map((k) => new PublicKey(k).toBase58()), { encoding: "base64", commitment: "confirmed" }]))?.value ?? []).map(info); },
  };
}

async function resolveRoot(rpc, root) {
  const resolved = await new OnlinePumpSdk(connectionOver(rpc)).resolveQuoteMint(new PublicKey(root.mint));
  if (resolved.source !== "pumpCoin" || !resolved.pumpQuote) throw new LaunchError("the root is not a pump.fun coin that can take children", "root");
  return resolved;
}

/** Lamports the second transaction (sweep + vault account + sharing config + split) costs: rent + fee. */
async function secondTxCost(rpc, resolved) {
  const ata = resolved.quoteTokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? ATA_BYTES.token2022 : ATA_BYTES.spl;
  const [cfg, vault] = await Promise.all([rpc.call("getMinimumBalanceForRentExemption", [SHARING_CONFIG_BYTES]), rpc.call("getMinimumBalanceForRentExemption", [ata])]);
  return Number(cfg) + Number(vault) + BASE_FEE_LAMPORTS + Math.ceil((CU_PRICE_MICRO * CU_SPLIT) / 1e6);
}

/**
 * Launches `form` ({ name, symbol, description }) with `imageBytes` (PNG) under `root` (a model coin,
 * depth 0) from the agent's wallet. `budget` is a fresh budget.mjs snapshot. Returns
 * `{ mint, signatures, estCostSol, metadataUri, splitDone }`; throws LaunchError / TxError. A coin whose
 * create landed but whose split did not is recorded in the registry with `splitDone: false`.
 */
export async function launchLive({ rpc, signer, root, form, imageBytes, metaHost, budget, cfg, ledger = null, registry = null, log = console, mintKeypair = null }) {
  if (!cfg?.platformWallet || !Array.isArray(cfg.splitBps)) throw new LaunchError("platform wallet / split not configured", "config");
  const resolved = await resolveRoot(rpc, root);
  // Agents are not humans behind an IP: the daily per-ip upload quota does not apply to them.
  const meta = await metaHost.publish({ name: form.name, symbol: form.symbol, description: form.description ?? "", website: form.website ?? "", imageBytes, imageType: "image/png" }, { ip: `agent:${root.mint}`, quota: false });
  const mintKp = mintKeypair ?? Keypair.generate();
  const mint = mintKp.publicKey, agent = signer.publicKey;
  const shares = splitShares({ creator: signer.address, parentCreator: root.creator, grandparentCreator: null, platform: cfg.platformWallet, bps: cfg.splitBps });
  const table = await lookupTable(rpc);
  const built = await buildLaunch({ rootMint: root.mint, resolved, agent, mint, form: { name: form.name, symbol: form.symbol, uri: meta.metadataUri }, shares, launchFee: null, tables: [table] });
  if (built.bytes.some((b) => b === null || b > MAX_TX_BYTES)) throw new LaunchError(`transaction too large (${built.bytes.join(" + ")} bytes)`, "too_large");
  // Real blockhash on the first transaction, one simulation with the agent paying.
  const bh = await recentBlockhash(rpc);
  built.txs[0].message.recentBlockhash = bh.blockhash;
  const sim = await simulate(rpc, built.txs[0], { addresses: [signer.address] });
  if (!sim || sim.err != null) throw new LaunchError(`launch simulation failed: ${JSON.stringify(sim?.err ?? "no result").slice(0, 160)}${sim?.logs?.length ? ` — ${sim.logs.filter((l) => /error|failed/i.test(l)).slice(-1)[0] ?? ""}` : ""}`, "sim");
  const after = Number(sim.accounts?.[0]?.lamports ?? NaN);
  if (!Number.isFinite(after)) throw new LaunchError("simulation returned no balance for the agent", "sim");
  const firstLamports = budget.lamports - after;
  const secondLamports = built.txs.length > 1 ? await secondTxCost(rpc, resolved) : 0;
  const estCostSol = (firstLamports + secondLamports) / LAMPORTS_PER_SOL;
  const g = canLaunch(budget, estCostSol, cfg.budget ?? {});
  if (!g.ok) throw new LaunchError(g.reason, "budget");
  const mintB58 = mint.toBase58();
  ledger?.record({ kind: "launch", root: root.mint, address: signer.address, mint: mintB58, name: form.name, symbol: form.symbol, uri: meta.metadataUri, estCostSol, txs: built.txs.length, status: "pending" });
  // 1. Create (agent + mint sign).
  const tx1 = built.txs[0];
  signer.signTransaction(tx1); tx1.sign([mintKp]);
  const s1 = sig58(tx1);
  ledger?.record({ kind: "launch", root: root.mint, mint: mintB58, step: 1, of: built.txs.length, signature: s1, status: "sent" });
  let r1;
  try { r1 = await sendAndConfirm(rpc, tx1, { lastValidBlockHeight: bh.lastValidBlockHeight }); }
  catch (e) {
    ledger?.record({ kind: "launch", root: root.mint, mint: mintB58, step: 1, signature: e?.signature ?? s1, status: e instanceof TxError ? e.code : "uncertain", note: String(e.message).slice(0, 160) });
    throw e;
  }
  const splitInFirst = built.txs.length === 1;
  registry?.markLaunched?.(root.mint, { mint: mintB58, proposalId: form.proposalId ?? null, signature: r1.signature, splitDone: splitInFirst });
  ledger?.record({ kind: "launch", root: root.mint, mint: mintB58, step: 1, of: built.txs.length, signature: r1.signature, slot: r1.slot, status: splitInFirst ? "landed" : "step_landed" });
  const signatures = [r1.signature];
  let splitDone = splitInFirst;
  // 2. The fee split, when it did not fit: its own blockhash; if it does not land the coin stays
  //    recorded as owed and a later pass finishes it.
  if (!splitInFirst) {
    try {
      const r2 = await sendSplit(rpc, signer, built.txs[1]);
      signatures.push(r2.signature); splitDone = true;
      registry?.markSplit?.(mintB58, r2.signature);
      ledger?.record({ kind: "launch", root: root.mint, mint: mintB58, step: 2, of: 2, signature: r2.signature, slot: r2.slot, status: "landed" });
    } catch (e) {
      ledger?.record({ kind: "launch", root: root.mint, mint: mintB58, step: 2, of: 2, signature: e?.signature ?? null, status: e instanceof TxError ? e.code : "uncertain", note: `split owed: ${String(e.message).slice(0, 140)}` });
      log.warn?.(`agents: ${root.symbol ?? root.mint}: $${form.symbol} created (${r1.signature}) but its fee split did not land (${String(e.message).slice(0, 120)}); will retry`);
    }
  }
  log.info?.(`agents: ${root.symbol ?? root.mint} launched $${form.symbol} "${form.name}" → ${mintB58} (${signatures.join(", ")}, ~${estCostSol.toFixed(4)} SOL${splitDone ? "" : ", split owed"})`);
  return { mint: mintB58, signatures, estCostSol, metadataUri: meta.metadataUri, splitDone };
}

async function sendSplit(rpc, signer, tx) {
  const bh = await recentBlockhash(rpc);
  tx.message.recentBlockhash = bh.blockhash;
  const sim = await simulate(rpc, tx);
  if (!sim || sim.err != null) throw new LaunchError(`fee split simulation failed: ${JSON.stringify(sim?.err ?? "no result").slice(0, 160)}`, "sim");
  signer.signTransaction(tx);
  return sendAndConfirm(rpc, tx, { lastValidBlockHeight: bh.lastValidBlockHeight });
}

/**
 * Sends the owed fee split of `mint` (sweep + vault account + sharing config + split), rebuilt from
 * the same builder; the mint's secret is not needed. Returns `{ signature, slot }`.
 */
export async function finishSplit({ rpc, signer, root, mint, cfg, ledger = null, log = console }) {
  const resolved = await resolveRoot(rpc, root);
  const shares = splitShares({ creator: signer.address, parentCreator: root.creator, grandparentCreator: null, platform: cfg.platformWallet, bps: cfg.splitBps });
  const built = await buildLaunch({ rootMint: root.mint, resolved, agent: signer.publicKey, mint: new PublicKey(mint), form: { name: "x", symbol: "X", uri: "https://x" }, shares, launchFee: null, tables: [await lookupTable(rpc)] });
  if (built.txs.length < 2) throw new LaunchError("this launch carried its split in the create transaction", "no_split_tx");
  ledger?.record({ kind: "split", root: root.mint, address: signer.address, mint, status: "pending" });
  try {
    const r = await sendSplit(rpc, signer, built.txs[1]);
    ledger?.record({ kind: "split", root: root.mint, mint, signature: r.signature, slot: r.slot, status: "landed" });
    log.info?.(`agents: ${root.symbol ?? root.mint}: fee split of ${mint} landed (${r.signature})`);
    return r;
  } catch (e) {
    ledger?.record({ kind: "split", root: root.mint, mint, signature: e?.signature ?? null, status: e instanceof TxError ? e.code : "uncertain", note: String(e.message).slice(0, 160) });
    throw e;
  }
}
