// Market cap of migrated coins (owner 2026-10-21, "the system shows the market cap wrong for most coins"):
// a PumpSwap pool is priced on its effective quote side, the quote vault plus the pool's signed
// `virtual_quote_reserves` (pump-amm and the SDK's chainCoinHop do the same), and every coin quoted in
// it inherits that price down the chain. Locked value and the liquidity cap keep the real vault. A listed
// asset's bubble shows its circulating market cap. No network: the RPC and the price feed are stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer } from "../lib/indexer.mjs";
import { poolPriceQuote, priceQuoteOf, liqQuoteOf, units } from "../lib/pricing.mjs";
import { POOL_DISCRIMINATOR, EVENT_DISCRIMINATORS } from "../lib/decode.mjs";
import { familyShares } from "../lib/dominance.mjs";
import { BN, PublicKey, pumpIdl, pumpAmmIdl, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, bondingCurvePda, canonicalPumpPoolPdaWithQuote, normalizeQuoteMint, pk } from "../lib/sdk.mjs";
import { PLATFORM, quiet, T22 } from "./helpers/tree.mjs";

const key = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const supply = "1000000000000000"; // 1e9 tokens at 6 decimals
const near = (a, b, tol = 1e-9) => assert.ok(a != null && b != null && Math.abs(a / b - 1) <= tol, `${a} vs ${b}`);
const zeros = { virtualTokenReserves: "0", virtualQuoteReserves: "0", realTokenReserves: "0", realQuoteReserves: "0" };

function model(db = new Db(":memory:")) {
  const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load();
  m.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  m.setSolUsd(100);
  return m;
}
/** pump-amm Pool account bytes: vault keys at 139/171, the i128 virtual quote reserves at 245. */
function poolAccount({ baseMint, quoteMint, baseVault, quoteVault, vq = 0n }) {
  const buf = Buffer.alloc(300);
  POOL_DISCRIMINATOR.copy(buf, 0);
  for (const [k, o] of [[baseMint, 43], [quoteMint, 75], [baseVault, 139], [quoteVault, 171]]) new PublicKey(k).toBuffer().copy(buf, o);
  const v = BigInt.asUintN(128, BigInt(vq));
  buf.writeBigUInt64LE(v & ((1n << 64n) - 1n), 245); buf.writeBigUInt64LE(v >> 64n, 253);
  return { data: buf, owner: PUMP_AMM_PROGRAM_ID.toBase58() };
}
/** SPL token account bytes: mint, owner, amount (u64 at 64). */
function tokenAccount(mint, amount) {
  const buf = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(buf, 0);
  buf.writeBigUInt64LE(BigInt(amount), 64);
  return { data: buf, owner: "TokenkegQfeZyiNwAJbNbGYPyBuqQQ4dZz8dqFgzbW4" };
}
/** An RPC that serves a mutable address → account map and records the keys of every call. */
function fakeRpc(accounts) {
  const calls = [];
  return { calls, rpc: { getMultipleAccounts: async (keys) => { calls.push(keys); return keys.map((k) => accounts.get(k) ?? null); }, snapshot: () => ({}) } };
}

test("pool price: (quote vault + signed virtual quote) / base vault; null vq = the vault-only price; effective side <= 0 has none", () => {
  const q = "85000000000", b = "200000000000000"; // 85 SOL / 200M tokens
  const vaultOnly = 85 / 200_000_000;
  assert.equal(poolPriceQuote(q, b, 6, 9), vaultOnly, "no vq argument: today's number exactly");
  assert.equal(poolPriceQuote(q, b, 6, 9, null), vaultOnly);
  assert.equal(poolPriceQuote(q, b, 6, 9, "0"), vaultOnly);
  near(poolPriceQuote(q, b, 6, 9, "170000000000"), 3 * vaultOnly); // +170 SOL virtual: x3
  near(poolPriceQuote(q, b, 6, 9, "-42500000000"), 0.5 * vaultOnly); // negative: -42.5 SOL halves it
  assert.equal(poolPriceQuote(q, b, 6, 9, "-85000000000"), null, "effective quote side = 0");
  assert.equal(poolPriceQuote(q, b, 6, 9, "-90000000000"), null, "effective quote side < 0");
  assert.equal(poolPriceQuote(q, "0", 6, 9, "170000000000"), null, "empty base vault");
  assert.equal(poolPriceQuote(null, b, 6, 9, "170000000000"), null, "no vault read yet");
  near(poolPriceQuote("1", "1000000", 6, 6, (2n ** 70n).toString()), Number(2n ** 70n + 1n) / 1e6); // an i128 beyond 2^64 adds in BigInt
  assert.equal(poolPriceQuote(q, b, 6, 9, "garbage"), vaultOnly, "a malformed value counts as 0");
  const mig = { migrated: true, ...zeros, poolQuote: q, poolBase: b, poolVirtualQuote: "170000000000" };
  near(priceQuoteOf(mig, 6, 9), 3 * vaultOnly);
  assert.equal(priceQuoteOf({ ...mig, poolVirtualQuote: null }, 6, 9), vaultOnly);
  assert.equal(liqQuoteOf(mig, 9), 85, "the liquidity behind the price is the real vault");
  // a curve coin never reads it
  assert.equal(priceQuoteOf({ migrated: false, virtualTokenReserves: supply, virtualQuoteReserves: "30000000000", poolVirtualQuote: "999999999999" }, 6, 9), 30 / 1e9);
});

test("a migrated root's vq moves its own price and its curve child's down the chain; locked and the LIQ_X cap keep the real vault", () => {
  const m = model();
  const ROOT = key(51), KID = key(52), MKID = key(53);
  // ROOT: SOL-quoted, migrated; pool 100 SOL / 1e8 tokens = 1e-6 SOL per token from the vault alone.
  m.upsertCoin({ mint: ROOT, curve: "C_R", depth: 0, quoteMint: null, ...zeros, tokenTotalSupply: supply, migrated: true, complete: true, pool: key(61), poolBaseVault: key(62), poolQuoteVault: key(63), poolBase: "100000000000000", poolQuote: "100000000000", creator: "CR" });
  // KID: on its curve, 2 ROOT per token, 5M ROOT raised. MKID: migrated under ROOT, its pool holds 3M ROOT + 9M virtual.
  m.upsertCoin({ mint: KID, curve: "C_K", depth: 1, quoteMint: ROOT, virtualTokenReserves: supply, virtualQuoteReserves: "2000000000000000", realTokenReserves: "1", realQuoteReserves: "5000000000000", tokenTotalSupply: supply, creator: "CR" });
  m.upsertCoin({ mint: MKID, curve: "C_M", depth: 1, quoteMint: ROOT, ...zeros, tokenTotalSupply: supply, migrated: true, complete: true, pool: key(64), poolBaseVault: key(65), poolQuoteVault: key(66), poolBase: "1000000000000", poolQuote: "3000000000000", poolVirtualQuote: "9000000000000", creator: "CR" });
  for (const [mint, symbol] of [[ROOT, "ROOT"], [KID, "KID"], [MKID, "MKID"]]) m.setMint({ mint, decimals: 6, tokenProgram: T22, name: symbol, symbol, onchainAt: 1 });
  assert.equal(m.get(ROOT).poolVirtualQuote, null, "upsertCoin default");
  const r0 = m.view(m.get(ROOT)), k0 = m.view(m.get(KID));
  near(r0.priceUsd, 1e-4); near(r0.mcapUsd, 1e5); near(k0.priceUsd, 2e-4); near(k0.mcapUsd, 2e5);
  near(m.view(m.get(MKID)).priceQuote, 12, 1e-12); // (3M + 9M) ROOT / 1M tokens

  // vq read from the pool: +200 SOL → x3 on ROOT and on everything quoted in it
  m.upsertCoin({ mint: ROOT, poolVirtualQuote: "200000000000" });
  const r1 = m.view(m.get(ROOT)), k1 = m.view(m.get(KID));
  near(r1.priceUsd, 3e-4); near(r1.mcapUsd, 3e5); near(k1.priceUsd, 6e-4); near(k1.mcapUsd, 6e5);
  near(m.priceOf(KID).priceUsd, k1.priceUsd); near(m.priceOf(ROOT).priceUsd, r1.priceUsd); // live trade path = forest pass
  const node = m.mapAll({ all: true }).body.roots.find((x) => x.coin.mint === ROOT);
  near(node.coin.mcapUsd, 3e5); near(node.children.find((x) => x.coin.mint === KID).coin.mcapUsd, 6e5);

  // locked quote = KID's real curve reserves + MKID's real pool vault (never its virtual quote)
  assert.equal(r1.lockedQuote, "8000000000000");
  assert.equal(r0.lockedQuote, r1.lockedQuote, "vq does not move the locked quote");
  near(r1.lockedUsd, units("8000000000000", 6) * r1.priceUsd);

  // LIQ_X cap on the real vault: 100 SOL x $100 x 50 = $500k, whatever the virtual side says
  m.upsertCoin({ mint: ROOT, poolVirtualQuote: "2000000000000" }); // 2,100 SOL effective → $2.1M mcap
  const r2 = m.view(m.get(ROOT));
  near(r2.mcapUsd, 2.1e6); assert.equal(r2.mcapCapUsd, 500_000);
  // a negative vq that empties the effective side: no price, the child has none either
  m.upsertCoin({ mint: ROOT, poolVirtualQuote: "-100000000000" });
  assert.equal(m.view(m.get(ROOT)).priceUsd, null); assert.equal(m.view(m.get(KID)).priceUsd, null);
});

test("db: pool_vquote round-trips signed values beyond 2^64, and an old coins table gains the column on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-vq-"));
  try {
    const file = join(dir, "spore.sqlite");
    const row = { mint: "M1", curve: "C1", depth: 0, quoteMint: null, creator: "CR", tracked: true, ...zeros, tokenTotalSupply: supply, initialVirtualQuoteReserves: "0", complete: true, migrated: true, mayhem: false, holderReward: false, creatorFeeBps: 0, pool: "P", poolBaseVault: "B", poolQuoteVault: "Q", poolBase: "1", poolQuote: "2" };
    // the schema as it was: the column dropped from a fresh file
    const old = new Db(file);
    old.db.exec("ALTER TABLE coins DROP COLUMN pool_vquote");
    old.db.exec("INSERT INTO coins (mint, curve, depth, creator, pool_quote) VALUES ('OLD', 'C0', 0, 'CR', '7')");
    old.db.close();
    const db = new Db(file);
    assert.ok(db.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "pool_vquote"), "migrated");
    assert.equal(db.allCoins().find((c) => c.mint === "OLD").poolVirtualQuote, null, "old rows read as never read");
    db.migrate(); db.migrate(); // idempotent
    const big = "-123456789012345678901234567890";
    db.upsertCoin({ ...row, poolVirtualQuote: big });
    assert.equal(db.allCoins().find((c) => c.mint === "M1").poolVirtualQuote, big);
    db.close();
    const again = new Db(file);
    assert.equal(again.allCoins().find((c) => c.mint === "M1").poolVirtualQuote, big, "survives reopening");
    again.upsertCoin({ ...row, poolVirtualQuote: "0" });
    assert.equal(again.allCoins().find((c) => c.mint === "M1").poolVirtualQuote, "0");
    // and through the model: a reloaded model prices the pool with it
    const m = new Model(again, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], log: quiet });
    m.load();
    m.upsertCoin({ mint: "M1", poolVirtualQuote: "-1" });
    const m2 = new Model(again, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], log: quiet });
    m2.load();
    assert.equal(m2.get("M1").poolVirtualQuote, "-1");
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ensurePools backfills vq for a coin whose pool and vaults are known (read from its own pool); refreshVaults re-reads it in 99-account calls", async () => {
  const m = model();
  const M = key(71), POOL = key(72), BV = key(73), QV = key(74);
  // `pool` is deliberately not the canonical PDA: a known pool is read as stored, not re-derived.
  m.upsertCoin({ mint: M, curve: "C_M", depth: 0, quoteMint: null, ...zeros, tokenTotalSupply: supply, migrated: true, complete: true, pool: POOL, poolBaseVault: BV, poolQuoteVault: QV, poolBase: "200000000000000", poolQuote: "85000000000", creator: "CR" });
  const accounts = new Map([[POOL, poolAccount({ baseMint: M, quoteMint: "So11111111111111111111111111111111111111112", baseVault: BV, quoteVault: QV, vq: 170_000_000_000n })], [BV, tokenAccount(M, "200000000000000")], [QV, tokenAccount(M, "85000000000")]]);
  const { rpc, calls } = fakeRpc(accounts);
  const ix = new Indexer({ rpc, model: m, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  const before = m.view(m.get(M)).priceQuote;
  const n = await ix.ensurePools();
  assert.deepEqual(n, { coins: 1, read: 1, vqNonZero: 1, vqNegative: 0 });
  assert.deepEqual(calls[0], [POOL], "the stored pool, one call");
  assert.deepEqual(calls[1], [BV, QV], "then the vaults only");
  assert.equal(m.get(M).poolVirtualQuote, "170000000000");
  near(m.view(m.get(M)).priceQuote, 3 * before);
  assert.equal(m.db.allCoins().find((c) => c.mint === M).poolVirtualQuote, "170000000000", "persisted");
  const nCalls = calls.length;
  assert.equal((await ix.ensurePools()).coins, 0, "backfilled once: a second pass has nothing to read");
  assert.equal(calls.length, nCalls);

  // refreshVaults re-reads the pool with its vaults: vq moved (negative now) and a trade moved the vaults
  accounts.set(POOL, poolAccount({ baseMint: M, quoteMint: "So11111111111111111111111111111111111111112", baseVault: BV, quoteVault: QV, vq: -42_500_000_000n }));
  accounts.set(QV, tokenAccount(M, "85000000001"));
  await ix.refreshVaults([m.get(M)]);
  assert.deepEqual(calls.at(-1), [POOL, BV, QV]);
  assert.equal(m.get(M).poolVirtualQuote, "-42500000000"); assert.equal(m.get(M).poolQuote, "85000000001");
  // a pool account that does not decode keeps the last vq; the vaults still update
  accounts.delete(POOL); accounts.set(QV, tokenAccount(M, "85000000002"));
  await ix.refreshVaults([m.get(M)]);
  assert.equal(m.get(M).poolVirtualQuote, "-42500000000"); assert.equal(m.get(M).poolQuote, "85000000002");

  // 40 coins: [pool, base, quote] x 33 = 99 keys, then 7 x 3 = 21
  const many = Array.from({ length: 40 }, (_, i) => ({ mint: key(100 + i), migrated: true, pool: key(150 + i), poolBaseVault: key(200 + i), poolQuoteVault: key(210 + (i % 40)) }));
  const c0 = calls.length;
  await ix.refreshVaults(many);
  assert.deepEqual(calls.slice(c0).map((k) => k.length), [99, 21]);
  // backfillPoolVq: concurrent callers share one pass
  const a = ix.backfillPoolVq(), b = ix.backfillPoolVq();
  assert.equal(a, b); await a;
});

test("an ancestor that arrives already migrated gets its pool read at once, so the chain under it is priced", async () => {
  const m = model();
  const PARENT = key(121), KID = key(122), BV = key(123), QV = key(124);
  // KID is on its curve, 2 PARENT per token; PARENT is unknown to the model and migrated on chain.
  m.upsertCoin({ mint: KID, curve: "C_KID", depth: 1, quoteMint: PARENT, virtualTokenReserves: supply, virtualQuoteReserves: "2000000000000000", realTokenReserves: "1", realQuoteReserves: "1", tokenTotalSupply: supply, creator: "CR" });
  const fields = pumpIdl.types.find((x) => x.name === "BondingCurve").type.fields;
  const v = {};
  for (const f of fields) v[f.name] = f.type === "pubkey" ? PublicKey.default : f.type === "bool" ? false : /^[ui](8|16|32)$/.test(f.type) ? 0 : new BN(0);
  Object.assign(v, { token_total_supply: new BN(supply), complete: true, creator: new PublicKey(Buffer.alloc(32, 3)), depth: 0 }); // all reserves 0 = migrated
  const curveAcc = { data: await new anchor.BorshAccountsCoder(pumpIdl).encode("BondingCurve", v), owner: PUMP_PROGRAM_ID.toBase58() };
  const pool = canonicalPumpPoolPdaWithQuote(pk(PARENT), normalizeQuoteMint(null)).toBase58();
  const accounts = new Map([
    [bondingCurvePda(PARENT).toBase58(), curveAcc],
    [pool, poolAccount({ baseMint: PARENT, quoteMint: "So11111111111111111111111111111111111111112", baseVault: BV, quoteVault: QV, vq: 200_000_000_000n })],
    [BV, tokenAccount(PARENT, "100000000000000")], [QV, tokenAccount(PARENT, "100000000000")], // 100 SOL / 1e8 tokens
  ]);
  const { rpc } = fakeRpc(accounts);
  const ix = new Indexer({ rpc, model: m, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  await ix.ensureAncestors();
  const p = m.get(PARENT);
  assert.ok(p?.migrated, "the parent joined the tree");
  assert.equal(p.pool, pool); assert.equal(p.poolVirtualQuote, "200000000000"); assert.equal(p.poolQuote, "100000000000");
  near(m.view(p).priceQuote, 3e-6); // (100 + 200) SOL / 1e8 tokens
  near(m.view(m.get(KID)).priceUsd, 2 * 3e-6 * 100); // priced through the parent, not null
});

test("a pump-amm trade is recorded at the pool's effective price (vault reserves from the event + the pool's stored vq)", async () => {
  const m = model();
  const M = key(81), POOL = key(82);
  m.upsertCoin({ mint: M, curve: "C_T", depth: 0, quoteMint: null, ...zeros, tokenTotalSupply: supply, migrated: true, complete: true, pool: POOL, poolBaseVault: key(83), poolQuoteVault: key(84), poolBase: "1", poolQuote: "1", poolVirtualQuote: "170000000000", creator: "CR" });
  m.setMint({ mint: M, decimals: 6, tokenProgram: T22, name: "T", symbol: "T", onchainAt: 1 });
  const events = [];
  const ix = new Indexer({ rpc: fakeRpc(new Map()).rpc, model: m, meta: null, hub: { emit: (ev, data) => events.push([ev, data]) }, log: quiet, opts: { backfill: false } });
  // a BuyEvent with pool reserves 200M tokens / 85 SOL, encoded with the pump-amm IDL
  const t = pumpAmmIdl.types.find((x) => x.name === "BuyEvent");
  const v = {};
  for (const f of t.type.fields) v[f.name] = f.type === "pubkey" ? new PublicKey(Buffer.alloc(32, 9)) : f.type === "string" ? "buy" : f.type === "bool" ? false : new BN(0);
  Object.assign(v, { timestamp: new BN(1_792_000_000), pool: new PublicKey(POOL), base_amount_out: new BN("1000000"), quote_amount_in: new BN("425"), pool_base_token_reserves: new BN("200000000000000"), pool_quote_token_reserves: new BN("85000000000") });
  const payload = Buffer.concat([EVENT_DISCRIMINATORS.BuyEvent, new anchor.BorshCoder(pumpAmmIdl).types.encode("BuyEvent", v)]);
  const amm = PUMP_AMM_PROGRAM_ID.toBase58();
  ix.onLogs({ slot: 5, signature: "SIG1", err: null, logs: [`Program ${amm} invoke [1]`, `Program data: ${payload.toString("base64")}`, `Program ${amm} success`] });
  const [row] = m.db.tradesFor(M);
  assert.ok(row, "the trade was stored");
  near(row.priceQuote, 3 * 85 / 200_000_000); // (85 + 170) SOL / 200M tokens
  near(row.priceUsd, row.priceQuote * 100);
  assert.equal(m.get(M).poolQuote, "85000000000"); assert.equal(m.get(M).poolVirtualQuote, "170000000000", "the event does not overwrite the stored vq");
  const trade = events.find(([ev]) => ev === "trade")?.[1];
  near(trade.priceQuote, row.priceQuote); near(m.view(m.get(M)).mcapUsd, row.priceUsd * 1e9);
});

test("a listed asset's bubble shows its circulating market cap from the price feed; on-chain supply is the fallback; sizing still counts it 0", async () => {
  const m = model();
  const R = key(91);
  m.setMint({ mint: PUMP, decimals: 6, tokenProgram: T22, name: "Pump", symbol: "PUMP", supply: "826660000000000000", onchainAt: 1 }); // 826.66B on chain
  m.upsertCoin({ mint: R, curve: "C_R", depth: 0, quoteMint: PUMP, virtualTokenReserves: supply, virtualQuoteReserves: "1000000000000000", realTokenReserves: "1", realQuoteReserves: "4000000000", tokenTotalSupply: supply, creator: "CR" });
  m.setMint({ mint: R, decimals: 6, tokenProgram: T22, name: "R", symbol: "R", onchainAt: 1 });
  m.setQuoteUsd(PUMP, 0.005);
  near(m.assetMapRef(PUMP).mcapUsd, 0.005 * 826.66e9, 1e-9);
  const locked0 = m.assetMapRef(PUMP).lockedUsd;
  const famValue = () => { m.mapCache = null; return familyShares([m.mapAll({ all: true }).body.roots.find((x) => x.coin.mint === PUMP)], "mcap").families[0].value; };
  const fam0 = famValue();

  // the CoinGecko call that prices PUMP also carries its market cap
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, json: async () => ({ solana: { usd: 150 }, "pump-fun": { usd: 0.005, usd_market_cap: 2_010_000_000 } }) }; };
  try {
    const ix = new Indexer({ rpc: fakeRpc(new Map()).rpc, model: m, meta: null, hub: null, log: quiet, opts: { backfill: false } });
    await ix.refreshSolUsd();
  } finally { globalThis.fetch = realFetch; }
  assert.match(urls[0], /include_market_cap=true/);
  assert.equal(m.quoteMcapOf(PUMP), 2_010_000_000);
  const v0 = m.version;
  assert.equal(m.setQuoteMcap(PUMP, 2_010_000_000), false, "an unchanged value does not bump");
  assert.equal(m.version, v0);
  assert.equal(m.setQuoteMcap(PUMP, -1), false); assert.equal(m.setQuoteMcap(PUMP, NaN), false);
  const a = m.assetMapRef(PUMP);
  assert.equal(a.mcapUsd, 2_010_000_000);
  assert.equal(a.lockedUsd, locked0, "locked value untouched");
  m.mapCache = null; // the whole-forest map is cached for MAP_CACHE_MS
  const top = m.mapAll({ all: true }).body.roots.find((x) => x.coin.mint === PUMP);
  assert.equal(top.coin.mcapUsd, 2_010_000_000);
  assert.equal(famValue(), fam0, "sizing: the asset top's own mcap still counts 0, its family value does not move");
  // persisted and restored
  const m2 = new Model(m.db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m2.load();
  assert.equal(m2.quoteMcapOf(PUMP), 2_010_000_000);
  assert.equal(m2.quoteMcapOf(key(92)), null);
});

test("pools that price other coins are re-read on their own faster cycle: biggest family first, at start-up and in slices per tick", async () => {
  const m = model();
  const SOL = "So11111111111111111111111111111111111111112";
  const P = key(161), POOL = key(162), BV = key(163), QV = key(164);
  const Q = key(165), QPOOL = key(166), QBV = key(167), QQV = key(168);
  const X = key(169), XPOOL = key(170), XBV = key(171), XQV = key(172);
  const pool = (mint, p, bv, qv) => ({ mint, curve: `C_${mint}`, depth: 0, quoteMint: null, ...zeros, tokenTotalSupply: supply, migrated: true, complete: true, pool: p, poolBaseVault: bv, poolQuoteVault: qv, poolBase: "200000000000000", poolQuote: "85000000000", poolVirtualQuote: "0", creator: "CR" });
  m.upsertCoin(pool(P, POOL, BV, QV)); m.upsertCoin(pool(Q, QPOOL, QBV, QQV)); m.upsertCoin(pool(X, XPOOL, XBV, XQV));
  // P prices two children, Q one, X none (X is only refreshed by the full pass).
  const kid = (seed, quoteMint) => ({ mint: key(seed), curve: `C_${seed}`, depth: 1, quoteMint, virtualTokenReserves: supply, virtualQuoteReserves: "2000000000000000", realTokenReserves: "1", realQuoteReserves: "1", tokenTotalSupply: supply, creator: "CR" });
  m.upsertCoin(kid(181, P)); m.upsertCoin(kid(182, P)); m.upsertCoin(kid(183, Q));
  const ix = new Indexer({ rpc: fakeRpc(new Map()).rpc, model: m, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  assert.deepEqual(ix.pricingPools().map((c) => c.mint), [P, Q], "migrated parents of tracked children, most children first");

  const accounts = new Map([
    [POOL, poolAccount({ baseMint: P, quoteMint: SOL, baseVault: BV, quoteVault: QV, vq: 85_000_000_000n })], [BV, tokenAccount(P, "200000000000000")], [QV, tokenAccount(P, "85000000000")],
    [QPOOL, poolAccount({ baseMint: Q, quoteMint: SOL, baseVault: QBV, quoteVault: QQV })], [QBV, tokenAccount(Q, "200000000000000")], [QQV, tokenAccount(Q, "90000000000")],
  ]);
  const { rpc, calls } = fakeRpc(accounts);
  ix.rpc = rpc;
  const kidBefore = m.view(m.get(key(181))).priceUsd;
  assert.equal(await ix.refreshPricingPools(), 2);
  assert.deepEqual(calls, [[POOL, BV, QV, QPOOL, QBV, QQV]], "one call, X untouched");
  assert.equal(m.get(P).poolVirtualQuote, "85000000000");
  assert.equal(m.get(Q).poolQuote, "90000000000");
  near(m.view(m.get(key(181))).priceUsd, 2 * kidBefore, 1e-9); // P doubled (vault + equal virtual quote), so its child did too
  assert.ok(ix.snapshot().pricingPoolsAt > 0);

  // per tick: at least 20 (here the whole set of 2), the cursor wraps
  assert.deepEqual(ix.pricingSlice().map((c) => c.mint), [P, Q]);
  assert.deepEqual(ix.pricingSlice().map((c) => c.mint), [P, Q]);
});
