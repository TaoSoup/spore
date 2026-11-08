#!/usr/bin/env node
// Spore fee keeper (owner, 2026-11-06): the platform wallet claims its creator-fee share on every Spore
// coin and spends every SOL above a reserve on $SPORE once that is worth at least MIN_BUY_USD. Fees that
// arrive as $SPORE (children quoted in it) are kept; fees in other pump coins are sold to SOL through
// pump-amm's multi-hop route when they are worth a buy, and the next cycle turns that SOL into $SPORE.
//
//   KEEPER_KEY=./keeper.json RPC_URL=… node scripts/fee-keeper.mjs [--once] [--dry]
//
// Env: API_URL (https://sporepad.com; on the VPS http://127.0.0.1:8793), SPORE_MINT, KEEPER_INTERVAL_MS
// (300000), MIN_BUY_USD (1), MIN_CLAIM_USD_SOL (0.05), MIN_CLAIM_USD_TOKEN (0.25: a first token claim also
// pays ~0.002 SOL of ATA rent), RESERVE_SOL (0.02: fees, WSOL rent, new ATAs), SLIPPAGE_BPS (300),
// KEEPER_PRIORITY_MICROLAMPORTS (50000), LOG_FILE (server/data/fee-keeper.jsonl). Never prints the key.
import { createRequire } from "node:module";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const BN = require("bn.js");
const sdk = require("@pump-fun/pump-sdk");
const { Connection, Keypair, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } = web3;
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } = spl;
const { PUMP_SDK, multiHopRouteEnds, bondingCurvePda, creatorVaultPda, ammCreatorVaultPda, feeSharingConfigPda, canonicalPumpPoolPdaWithQuote, isBondingCurveMigrated, isLegacyQuoteMint, normalizeQuoteMint } = sdk;

const here = dirname(fileURLToPath(import.meta.url));
const ONCE = process.argv.includes("--once"), DRY = process.argv.includes("--dry");
const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const num = (k, d) => { const v = Number(env(k, d)); if (!Number.isFinite(v)) throw new Error(`${k} must be a number`); return v; };
const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const RPC = env("RPC_URL", "https://api.mainnet.solana.com");
const API = env("API_URL", "https://sporepad.com").replace(/\/$/, "");
const SPORE_MINT = new PublicKey(env("SPORE_MINT", "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY"));
const LOOKUP_TABLE = new PublicKey(env("LOOKUP_TABLE", "5WK4tafybAnHV4grvSipYfLfV8Bd7Rzcwb5eNE1PQRnx"));
const INTERVAL_MS = num("KEEPER_INTERVAL_MS", 300_000);
const MIN_BUY_USD = num("MIN_BUY_USD", 1);
const MIN_CLAIM_USD_SOL = num("MIN_CLAIM_USD_SOL", 0.05);
const MIN_CLAIM_USD_TOKEN = num("MIN_CLAIM_USD_TOKEN", 0.25);
const RESERVE_LAMPORTS = BigInt(Math.round(num("RESERVE_SOL", 0.02) * 1e9));
const SLIPPAGE_BPS = BigInt(Math.round(num("SLIPPAGE_BPS", 300)));
const CU_PRICE_MICRO = num("KEEPER_PRIORITY_MICROLAMPORTS", 50_000);
const LOG_FILE = env("LOG_FILE", join(here, "..", "data", "fee-keeper.jsonl"));
const QUOTE_CU_LIMIT = 1_400_000, MAX_TX_BYTES = 1232, BASE_FEE_LAMPORTS = 5_000;

const keyPath = env("KEEPER_KEY", "./keeper.json");
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(expand(keyPath), "utf8"))));
const WALLET = keeper.publicKey;
const conn = new Connection(RPC, "confirmed");

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), ...a);
const warn = (...a) => console.warn(ts(), "WARN", ...a);
function record(entry) {
  try { mkdirSync(dirname(LOG_FILE), { recursive: true }); appendFileSync(LOG_FILE, JSON.stringify({ at: ts(), dry: DRY, ...entry }) + "\n"); } catch (e) { warn(`log file: ${e.message}`); }
}
const fmt = (raw, decimals, digits = 6) => (Number(raw) / 10 ** decimals).toFixed(digits);
const sol = (lamports) => fmt(lamports, 9, 6);

async function api(path) {
  const res = await fetch(`${API}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------------ transactions
let tablesCache = null;
async function lookupTables() {
  if (tablesCache) return tablesCache;
  const r = await conn.getAddressLookupTable(LOOKUP_TABLE);
  tablesCache = r.value ? [r.value] : [];
  if (!tablesCache.length) warn("lookup table not found; transactions will be larger");
  return tablesCache;
}
const cuIxs = (units) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO })];
const compileV0 = (blockhash, ixs, tables) => new VersionedTransaction(new TransactionMessage({ payerKey: WALLET, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables));
const txBytes = (tx) => { try { return tx.serialize().length; } catch { return null; } };
const tokenAmount = (data) => (data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true) : 0n);
const u64At = (data, off) => (data.length >= off + 8 ? new DataView(data.buffer, data.byteOffset + off, 8).getBigUint64(0, true) : 0n);

/** Builds, simulates and (unless --dry) sends one transaction. Returns { signature, logs } or null when it failed. */
async function send(label, ixs, { units = 400_000, simAccounts = [] } = {}) {
  const [{ blockhash, lastValidBlockHeight }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables()]);
  const tx = compileV0(blockhash, [...cuIxs(units), ...ixs], tables);
  const n = txBytes(tx);
  if (n === null || n > MAX_TX_BYTES) { warn(`${label}: transaction too large (${n ?? ">1232"} bytes)`); return null; }
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: simAccounts.length ? { encoding: "base64", addresses: simAccounts.map((a) => a.toBase58()) } : undefined });
  if (sim.value.err) { warn(`${label}: simulation failed ${JSON.stringify(sim.value.err)} :: ${explain(sim.value.logs ?? [])}`); return null; }
  if (DRY) { log(`[dry] ${label}: ${ixs.length} instructions, ${n} bytes, ${sim.value.unitsConsumed} CU`); return { signature: null, logs: sim.value.logs ?? [], sim }; }
  tx.sign([keeper]);
  const signature = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
  const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) { warn(`${label}: ${signature} failed on chain ${JSON.stringify(conf.value.err)}`); return null; }
  const got = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
  log(`${label}: ${signature}`);
  return { signature, logs: got?.meta?.logMessages ?? [], sim };
}
function explain(logs) {
  const m = logs.join("\n").match(/custom program error: 0x([0-9a-f]+)/i);
  if (m) { const code = parseInt(m[1], 16); const e = (sdk.pump?.errors ?? []).find((x) => x.code === code); if (e) return `${e.msg || e.name} (${code})`; return `custom error ${code}`; }
  if (logs.some((l) => /insufficient lamports|insufficient funds/i.test(l))) return "insufficient SOL";
  const last = [...logs].reverse().find((l) => l.startsWith("Program log:") && !/^Program log: Instruction:/.test(l));
  return last ? last.replace(/^Program log:\s*/, "") : "no program log";
}

// ------------------------------------------------------------------ claims (ported from web/src/lib/pump/claim.ts)
async function readClaimState(mint) {
  const sharing = feeSharingConfigPda(mint);
  const [curveInfo, configInfo] = await conn.getMultipleAccountsInfo([bondingCurvePda(mint), sharing], "confirmed");
  if (!curveInfo) throw new Error("no bonding curve");
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  const isSol = isLegacyQuoteMint(curve.quoteMint);
  const quoteMint = normalizeQuoteMint(curve.quoteMint);
  const quoteTokenProgram = isSol ? TOKEN_PROGRAM_ID : (await conn.getAccountInfo(quoteMint, "confirmed"))?.owner ?? TOKEN_PROGRAM_ID;
  const migrated = isBondingCurveMigrated(curve);
  const vaultPda = creatorVaultPda(sharing), ammPda = ammCreatorVaultPda(sharing);
  const vaultHolder = isSol ? vaultPda : getAssociatedTokenAddressSync(quoteMint, vaultPda, true, quoteTokenProgram);
  const ammAta = getAssociatedTokenAddressSync(quoteMint, ammPda, true, quoteTokenProgram);
  const pool = canonicalPumpPoolPdaWithQuote(mint, quoteMint);
  const [vaultInfo, ammInfo, poolInfo] = await conn.getMultipleAccountsInfo([vaultHolder, ammAta, pool], "confirmed");
  const bucket = BigInt(curve.creatorFee.toString());
  const vault = isSol ? BigInt(vaultInfo?.lamports ?? 0) : tokenAmount(vaultInfo?.data);
  const poolCoinCreator = poolInfo && poolInfo.data.length >= 243 ? new PublicKey(poolInfo.data.subarray(211, 243)) : null;
  const poolBucket = poolInfo ? u64At(poolInfo.data, 279) : 0n;
  const amm = migrated ? poolBucket + tokenAmount(ammInfo?.data) : 0n;
  return { mint, sharing, config: configInfo ? PUMP_SDK.decodeSharingConfig(configInfo) : null, quoteMint, quoteTokenProgram, isSol, migrated, holderReward: curve.isHolderReward, curveCreator: curve.creator, poolCoinCreator, bucket, vault, amm, total: bucket + vault + amm };
}
async function claimInstructions(s) {
  if (s.holderReward) throw new Error("holder-reward coin: nothing to claim through a sharing config");
  if (!s.config) throw new Error("no fee-sharing config");
  if (!s.curveCreator.equals(s.sharing)) throw new Error("fees are not routed through the sharing config");
  const { mint, quoteMint, quoteTokenProgram } = s, payer = WALLET;
  const ixs = [];
  if (s.bucket > 0n || !s.migrated) ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer, mint, creator: s.sharing, quoteMint, quoteTokenProgram }));
  if (s.migrated) {
    ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer, mint, coinCreator: s.poolCoinCreator ?? s.sharing, quoteMint, quoteTokenProgram }));
    ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer, mint, quoteMint, quoteTokenProgram }));
  }
  ixs.push(await PUMP_SDK.distributeCreatorFeesV2({ mint, sharingConfig: s.config, sharingConfigAddress: s.sharing, quoteMint, payer, shouldInitializeAta: true, quoteTokenProgram }));
  return ixs;
}
function distributedOf(logs) {
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m) continue;
    try { const ev = PUMP_SDK.decodeDistributeCreatorFeesEvent(Buffer.from(m[1], "base64").subarray(8)); if (ev?.distributed !== undefined) return BigInt(ev.distributed.toString()); } catch { /* another event */ }
  }
  return null;
}

/** Claims every coin whose platform share is worth claiming. Returns the number of claims sent. */
async function claimAll() {
  const { coins } = await api(`/api/claims/${WALLET.toBase58()}`);
  let sent = 0;
  for (const c of coins) {
    const ours = (c.perShare ?? []).find((s) => s.address === WALLET.toBase58());
    if (!c.claimable || !ours || BigInt(ours.amount ?? 0) <= 0n) continue;
    const isSol = c.quoteMint == null;
    const ourUsd = (c.totalUsd ?? 0) * (ours.bps / 10_000);
    const floor = isSol ? MIN_CLAIM_USD_SOL : MIN_CLAIM_USD_TOKEN;
    if (!(ourUsd >= floor)) continue;
    const label = `claim ${c.symbol} (${c.quoteSymbol} ${fmt(ours.amount, c.quoteDecimals)} ≈ $${ourUsd.toFixed(2)})`;
    try {
      const s = await readClaimState(new PublicKey(c.mint));
      if (s.total <= 0n) { log(`${label}: nothing on chain any more`); continue; }
      const ixs = await claimInstructions(s);
      const r = await send(label, ixs, { units: s.migrated ? 250_000 : 200_000 });
      if (!r) continue;
      sent++;
      const distributed = distributedOf(r.logs);
      record({ kind: "claim", mint: c.mint, symbol: c.symbol, quoteMint: c.quoteMint, quoteSymbol: c.quoteSymbol, ourBps: ours.bps, ourAmount: String(ours.amount), ourUsd: +ourUsd.toFixed(4), distributed: distributed == null ? null : String(distributed), signature: r.signature });
    } catch (e) { warn(`${label}: ${e.message}`); }
  }
  return sent;
}

// ------------------------------------------------------------------ swaps (ported from web/src/lib/pump/trade.ts)
const fromB64 = (s) => Buffer.from(s, "base64");
async function coinChain(mint) {
  // self first, down to the SOL root, as pump-amm's multi_hop_swap wants it.
  const { coin } = await api(`/api/coin/${mint}`);
  const links = [coin];
  let cur = coin;
  while (cur.quoteMint && cur.quoteMint !== NATIVE_MINT.toBase58()) {
    const parent = (await api(`/api/coin/${cur.quoteMint}`)).coin;
    links.push(parent); cur = parent;
    if (links.length > 6) throw new Error("chain deeper than the program allows");
  }
  if (cur.quoteMint && cur.quoteMint !== NATIVE_MINT.toBase58()) throw new Error("not rooted in SOL");
  return links.map((l, i) => ({
    venue: l.migrated ? "pool" : "curve",
    baseMint: new PublicKey(l.mint),
    quoteMint: l.quoteMint ? new PublicKey(l.quoteMint) : NATIVE_MINT,
    baseTokenProgram: new PublicKey(l.tokenProgram ?? TOKEN_2022_PROGRAM_ID.toBase58()),
    quoteTokenProgram: l.quoteMint ? new PublicKey(links[i + 1]?.tokenProgram ?? TOKEN_2022_PROGRAM_ID.toBase58()) : TOKEN_PROGRAM_ID,
  }));
}
async function swapIxs(hops, side, amountIn, minOut) {
  return PUMP_SDK.multiHopSwapInstructions({ user: WALLET, hops, side, amountIn: new BN(amountIn.toString()), minAmountOut: new BN(minOut.toString()) });
}
/** Output of a route by simulation: the balance change of the account the route pays. */
async function quoteSwap(hops, side, amountIn) {
  const ixs = await swapIxs(hops, side, amountIn, 1n);
  const { input, output } = multiHopRouteEnds(hops, side);
  const solOut = output.mint.equals(NATIVE_MINT);
  const outAccount = solOut ? WALLET : getAssociatedTokenAddressSync(output.mint, WALLET, true, output.tokenProgram);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, WALLET, true, TOKEN_PROGRAM_ID);
  const [[pre, wsolPre], { blockhash }, tables] = await Promise.all([conn.getMultipleAccountsInfo([outAccount, wsolAta], "confirmed"), conn.getLatestBlockhash("confirmed"), lookupTables()]);
  const tx = compileV0(blockhash, [...cuIxs(QUOTE_CU_LIMIT), ...ixs], tables);
  const n = txBytes(tx);
  if (n === null || n > MAX_TX_BYTES) throw new Error(`route too large (${n ?? ">1232"} bytes)`);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [outAccount.toBase58(), wsolAta.toBase58()] } });
  const logs = sim.value.logs ?? [];
  if (sim.value.err) throw new Error(explain(logs));
  const post = sim.value.accounts?.[0] ?? null, wsolPost = sim.value.accounts?.[1] ?? null;
  const lam = (a) => BigInt(a?.lamports ?? 0);
  const before = solOut ? lam(pre) + lam(wsolPre) : tokenAmount(pre?.data);
  const after = solOut ? lam(post) + lam(wsolPost) : tokenAmount(post ? fromB64(post.data[0]) : null);
  let amountOut = after - before;
  if (solOut) amountOut += BigInt(BASE_FEE_LAMPORTS + Math.ceil((QUOTE_CU_LIMIT * CU_PRICE_MICRO) / 1_000_000));
  if (amountOut <= 0n) throw new Error("route returned nothing");
  return { amountOut, unitsConsumed: sim.value.unitsConsumed ?? 0, outAccount, input, output, solOut };
}
async function swap(label, hops, side, amountIn) {
  const q = await quoteSwap(hops, side, amountIn);
  const minOut = (q.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const ixs = await swapIxs(hops, side, amountIn, minOut);
  const units = Math.min(QUOTE_CU_LIMIT, Math.max(150_000 + 80_000 * hops.length, Math.ceil(q.unitsConsumed * 1.3)));
  const r = await send(`${label}: in ${amountIn} → ≥ ${minOut} (quote ${q.amountOut})`, ixs, { units });
  return r ? { ...r, quote: q.amountOut, minOut } : null;
}

/** Every SOL above the reserve buys $SPORE when that is worth MIN_BUY_USD. */
async function buySpore(solUsd) {
  const balance = BigInt(await conn.getBalance(WALLET, "confirmed"));
  const spend = balance - RESERVE_LAMPORTS;
  const usd = (Number(spend) / 1e9) * solUsd;
  if (spend <= 0n || usd < MIN_BUY_USD) { log(`buy: ${sol(balance)} SOL in the wallet, ${spend > 0n ? sol(spend) : "0"} above the reserve ≈ $${Math.max(usd, 0).toFixed(2)} < $${MIN_BUY_USD}; waiting`); return false; }
  const hops = await coinChain(SPORE_MINT.toBase58());
  const r = await swap(`buy $SPORE with ${sol(spend)} SOL (≈ $${usd.toFixed(2)})`, hops, "buy", spend);
  if (!r) return false;
  record({ kind: "buy", mint: SPORE_MINT.toBase58(), lamportsIn: String(spend), usdIn: +usd.toFixed(4), quoteOut: String(r.quote), minOut: String(r.minOut), signature: r.signature });
  return true;
}

/** Fee tokens in other pump coins (children quoted in a parent that is not $SPORE): sold to SOL when worth a buy. */
async function sellForeignTokens(solUsd) {
  let sold = 0;
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await conn.getParsedTokenAccountsByOwner(WALLET, { programId: program }, "confirmed");
    for (const acc of value) {
      const info = acc.account.data.parsed?.info;
      const mint = info?.mint, raw = BigInt(info?.tokenAmount?.amount ?? 0);
      if (!mint || raw <= 0n || mint === SPORE_MINT.toBase58() || mint === NATIVE_MINT.toBase58()) continue;
      let coin;
      try { coin = (await api(`/api/coin/${mint}`)).coin; } catch { continue; } // not a pump coin we know
      const usd = (Number(raw) / 10 ** (coin.decimals ?? 6)) * (coin.priceUsd ?? 0);
      if (!(usd >= MIN_BUY_USD)) { log(`hold ${coin.symbol}: ${fmt(raw, coin.decimals ?? 6, 2)} ≈ $${usd.toFixed(2)} < $${MIN_BUY_USD}`); continue; }
      try {
        const hops = await coinChain(mint);
        const r = await swap(`sell ${coin.symbol} ${fmt(raw, coin.decimals ?? 6, 2)} (≈ $${usd.toFixed(2)}) for SOL`, hops, "sell", raw);
        if (r) { sold++; record({ kind: "sell", mint, symbol: coin.symbol, amountIn: String(raw), usdIn: +usd.toFixed(4), quoteOut: String(r.quote), signature: r.signature }); }
      } catch (e) { warn(`sell ${coin.symbol}: ${e.message}`); }
    }
  }
  return sold;
}

// ------------------------------------------------------------------ cycle
async function cycle() {
  const stats = await api("/api/stats");
  const solUsd = Number(stats.solUsd);
  if (!(solUsd > 0)) throw new Error("no SOL price from the API");
  const claims = await claimAll();
  const sold = await sellForeignTokens(solUsd);
  const bought = await buySpore(solUsd);
  const held = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(SPORE_MINT, WALLET, true, (await conn.getAccountInfo(SPORE_MINT, "confirmed"))?.owner ?? TOKEN_2022_PROGRAM_ID), "confirmed").then((r) => r.value.uiAmountString).catch(() => "0");
  log(`cycle done: claims ${claims}, sells ${sold}, buy ${bought ? "yes" : "no"}, SOL/USD ${solUsd}, $SPORE held ${held}`);
}

log(`fee keeper ${WALLET.toBase58()} rpc=${RPC.replace(/api-key=[^&]+/, "api-key=…")} api=${API} spore=${SPORE_MINT.toBase58()} reserve=${sol(RESERVE_LAMPORTS)} SOL minBuy=$${MIN_BUY_USD} every ${INTERVAL_MS / 1000}s ${DRY ? "DRY" : ""}`);
let stopped = false;
process.on("SIGTERM", () => { stopped = true; log("stopping"); });
process.on("SIGINT", () => { stopped = true; log("stopping"); });
for (;;) {
  try { await cycle(); } catch (e) { warn(`cycle: ${e.stack ?? e}`); }
  if (ONCE || stopped) break;
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
  if (stopped) break;
}
