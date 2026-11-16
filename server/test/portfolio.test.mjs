// GET /api/portfolio/:wallet against a fake RPC: the model's creator index (built at load, kept by
// every upsert, a coin added after boot), holdings over both token programs resolved to tracked coins
// with their parent and USD value, the launched list, the 10 s per-wallet cache and the shared
// in-flight read, a failed chain read answered as holdingsOk false / solLamports null, input
// validation and the route's own rate limit. Also: a launched coin stays listed once a curve re-read
// names the fee-sharing config as its creator (the launcher field, or the coin's fee shares when
// there is none), the size cap on the token-account read, and the overall deadline of the chain reads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/api.mjs";
import { Model } from "../lib/model.mjs";
import { createPortfolio, PORTFOLIO_CACHE_MS, PORTFOLIO_CACHE_MAX, PORTFOLIO_LAUNCHED_MAX, PORTFOLIO_MAX_BYTES, PORTFOLIO_DEADLINE_MS } from "../lib/portfolio.mjs";
import { DEFAULT_RATES } from "../lib/config.mjs";
import { EventHub } from "../lib/events.mjs";
import { Rpc } from "../lib/rpc.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { PublicKey, USDC_MINT, TOKEN_PROGRAM_ID } from "../lib/sdk.mjs";
import { buildTree, K, PLATFORM, T22, base, quiet } from "./helpers/tree.mjs";

const key = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
const WALLET = K.U, OTHER = key(20), FOREIGN = key(21), USDC_CHILD = key(22), LATE = key(23);
const SPL = TOKEN_PROGRAM_ID.toBase58();
/** A token account as getTokenAccountsByOwner answers it with base64 + a 72-byte slice: mint, owner, amount. */
const tokenAccount = (mint, amount, owner = WALLET) => {
  const buf = Buffer.alloc(72);
  new PublicKey(mint).toBuffer().copy(buf, 0); new PublicKey(owner).toBuffer().copy(buf, 32); buf.writeBigUInt64LE(BigInt(amount), 64);
  return { pubkey: key(99), account: { data: [buf.toString("base64"), "base64"], owner: SPL, lamports: 2_039_280 } };
};

let server, url, model, db, hub, dir, t = 1_700_000_000_000;
const calls = [];
// The fake chain: token accounts per program, the SOL balance, and switches to fail or hold a read.
const chain = { [SPL]: [], [T22]: [], lamports: 1_500_000_000, failTokens: false, failBalance: false, gate: null };
const rpc = {
  call: async (method, params, opts) => {
    calls.push({ method, params, opts });
    if (chain.gate) await chain.gate;
    if (method === "getBalance") { if (chain.failBalance) throw new Error("balance down"); return { context: { slot: 1 }, value: chain.lamports }; }
    if (method === "getTokenAccountsByOwner") { if (chain.failTokens) throw new Error("tokens down"); return { context: { slot: 1 }, value: chain[params[1].programId] }; }
    throw new Error(`unexpected ${method}`);
  },
};
const appOf = (extra = {}) => createApp({ model, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc, hub, images: new ImageCache(dir), meta: null, platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet, now: () => t, ...extra });

before(async () => {
  ({ db, model } = buildTree());
  // The wallet created A (child of ROOT) and a root-level coin quoted in USDC; G was created by someone else.
  model.upsertCoin({ mint: K.A, creator: WALLET });
  model.upsertCoin({ mint: USDC_CHILD, curve: "C_UC", depth: 0, quoteMint: USDC_MINT, ...base, creator: WALLET, virtualQuoteReserves: "1000000000", createdAt: 5000, migrated: true, complete: true });
  model.setMint({ mint: USDC_CHILD, decimals: 6, tokenProgram: T22, name: "Dollar coin", symbol: "USDX", onchainAt: 1 });
  model.upsertCoin({ mint: K.G, creator: OTHER });
  model.activity.now = () => Math.floor(t / 1000);
  model.recordTrade({ sig: "P1", mint: K.A, idx: 0, slot: 1, time: Math.floor(t / 1000) - 120, isBuy: true, user: "U", baseAmount: "1000000", quoteAmount: "2000000", priceQuote: 2, priceUsd: 2e-5, valueUsd: 12.5 });
  hub = new EventHub({ heartbeatMs: 200 });
  dir = mkdtempSync(join(tmpdir(), "spore-portfolio-"));
  await new Promise((r) => { server = appOf().listen(0, "127.0.0.1", r); });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { hub.close(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
const get = (p, u = url) => fetch(u + p).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));

test("creator index: built at load, kept by upserts, a coin added after boot, a changed creator, eviction", () => {
  const mints = (w, m = model) => m.createdBy(w).map((c) => c.mint).sort();
  assert.deepEqual(mints(WALLET), [K.A, USDC_CHILD].sort());
  assert.deepEqual(mints(OTHER), [K.G]);
  assert.deepEqual(mints(key(50)), []);
  // A second model on the same database: the index comes back from the stored rows.
  const again = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], log: quiet });
  again.load();
  assert.deepEqual(mints(WALLET, again), [K.A, USDC_CHILD].sort());
  assert.deepEqual(mints(OTHER, again), [K.G]);
  // Added after boot.
  model.upsertCoin({ mint: LATE, curve: "C_LATE", depth: 1, quoteMint: K.ROOT, ...base, creator: OTHER, virtualQuoteReserves: "1000000000000000", createdAt: 9000 });
  assert.deepEqual(mints(OTHER), [K.G, LATE].sort());
  // A reserve update keeps the entry; a corrected creator moves it.
  model.upsertCoin({ mint: LATE, virtualQuoteReserves: "1100000000000000" });
  assert.deepEqual(mints(OTHER), [K.G, LATE].sort());
  model.upsertCoin({ mint: LATE, creator: key(51) });
  assert.deepEqual(mints(OTHER), [K.G]);
  assert.deepEqual(mints(key(51)), [LATE]);
  model.upsertCoin({ mint: LATE, creator: OTHER });
  assert.equal(model.creators.has(key(51)), false);
  // An untracked coin (looked up for a page) is not listed, and leaves the index when it is evicted.
  model.upsertCoin({ mint: FOREIGN, curve: "C_F", depth: 0, quoteMint: null, ...base, creator: key(52), tracked: false });
  assert.deepEqual(mints(key(52)), []);
  assert.equal(model.creators.get(key(52)).size, 1);
  assert.equal(model.evictUntracked({ idleMs: -60_000 }), 1);
  assert.equal(model.creators.has(key(52)), false);
});

test("GET /api/portfolio/:wallet: holdings of both token programs, parents, values, launched coins", async () => {
  // 3 A in two accounts (one per program read), 5 G, 2 USDX, an empty ROOT account, two accounts of mints the index does not track.
  chain[SPL] = [tokenAccount(K.A, 1_000_000), tokenAccount(K.ROOT, 0), tokenAccount(key(60), 7)];
  chain[T22] = [tokenAccount(K.A, 2_000_000), tokenAccount(K.G, 5_000_000), tokenAccount(USDC_CHILD, 2_000_000), tokenAccount(key(61), 1)];
  calls.length = 0;
  const { status, body, headers } = await get(`/api/portfolio/${WALLET}`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ["wallet", "at", "solLamports", "holdingsOk", "holdings", "untracked", "launched", "launchedTotal"]);
  assert.equal(body.wallet, WALLET); assert.equal(body.at, Math.floor(t / 1000));
  assert.equal(body.solLamports, "1500000000"); assert.equal(body.holdingsOk, true); assert.equal(body.untracked, 2);
  // One balance read and one token read per program, never the parsed form.
  assert.deepEqual(calls.map((c) => c.method).sort(), ["getBalance", "getTokenAccountsByOwner", "getTokenAccountsByOwner"]);
  const tokenCalls = calls.filter((c) => c.method === "getTokenAccountsByOwner");
  assert.deepEqual(tokenCalls.map((c) => c.params[1].programId).sort(), [SPL, T22].sort());
  for (const c of tokenCalls) { assert.equal(c.params[0], WALLET); assert.equal(c.params[2].encoding, "base64"); assert.deepEqual(c.params[2].dataSlice, { offset: 0, length: 72 }); }
  const byMint = new Map(body.holdings.map((h) => [h.mint, h]));
  assert.deepEqual([...byMint.keys()].sort(), [K.A, K.G, USDC_CHILD].sort());
  const a = byMint.get(K.A), g = byMint.get(K.G), u = byMint.get(USDC_CHILD);
  assert.deepEqual(Object.keys(a), ["mint", "amount", "decimals", "uiAmount", "valueUsd", "coin"]);
  assert.equal(a.amount, "3000000"); assert.equal(a.decimals, 6); assert.equal(a.uiAmount, 3);
  // A is 2 ROOT = 2e-5 USD, G is 0.5 A = 1e-5 USD.
  assert.ok(Math.abs(a.valueUsd - 6e-5) < 1e-12); assert.ok(Math.abs(g.valueUsd - 5e-5) < 1e-12);
  // Largest value first, an unknown value last.
  for (let i = 1; i < body.holdings.length; i++) assert.ok((body.holdings[i - 1].valueUsd ?? -1) >= (body.holdings[i].valueUsd ?? -1));
  for (const h of body.holdings) assert.equal(h.valueUsd, h.coin.priceUsd == null ? null : h.uiAmount * h.coin.priceUsd);
  // CoinRef: every contract field, the parent of a child, heat, graduated.
  assert.deepEqual(Object.keys(a.coin), ["mint", "name", "symbol", "image", "depth", "parent", "creator", "mcapUsd", "priceUsd", "vol24Usd", "trades1h", "trades24h", "lastTradeAt", "graduated", "createdAt"]);
  assert.equal(a.coin.symbol, "AAA"); assert.equal(a.coin.name, "AAA coin"); assert.equal(a.coin.depth, 1); assert.equal(a.coin.creator, WALLET);
  assert.ok(a.coin.image.startsWith("/api/img?u="));
  assert.deepEqual(a.coin.parent, { mint: K.ROOT, name: "ROOT coin", symbol: "ROOT", image: null });
  assert.ok(Math.abs(a.coin.priceUsd - 2e-5) < 1e-12); assert.ok(Math.abs(a.coin.mcapUsd - 2e-5 * 1e9) < 1e-6);
  assert.equal(a.coin.vol24Usd, 12.5); assert.equal(a.coin.trades1h, 1); assert.equal(a.coin.lastTradeAt, Math.floor(t / 1000) - 120);
  assert.equal(a.coin.graduated, false); assert.equal(a.coin.createdAt, 2000);
  assert.deepEqual(g.coin.parent, { mint: K.A, name: "AAA coin", symbol: "AAA", image: a.coin.image });
  assert.equal(g.coin.creator, OTHER); assert.equal(g.coin.vol24Usd, 0); assert.equal(g.coin.trades1h, 0); assert.equal(g.coin.lastTradeAt, null);
  // A parent the index does not hold as a coin: its mint and symbol only.
  assert.deepEqual(u.coin.parent, { mint: USDC_MINT, name: null, symbol: "USDC", image: null });
  assert.equal(u.coin.graduated, true);
  // Launched: the wallet's coins, newest first; a root has no parent.
  assert.deepEqual(body.launched.map((c) => c.mint), [USDC_CHILD, K.A]);
  assert.equal(body.launchedTotal, 2);
  assert.deepEqual(body.launched[1], a.coin);
  const none = (await get(`/api/portfolio/${key(70)}`)).body; // launched nothing
  assert.deepEqual(none.launched, []); assert.equal(none.launchedTotal, 0);
  model.upsertCoin({ mint: K.ROOT, creator: key(71) });
  assert.equal((await get(`/api/portfolio/${key(71)}`)).body.launched[0].parent, null);
  assert.match(headers.get("cache-control"), /max-age=3/);
  assert.ok(headers.get("etag"));
});

test("GET /api/portfolio/:wallet: one RPC round per wallet per 10 s, concurrent requests share it", async () => {
  const w = key(80);
  calls.length = 0;
  let open; chain.gate = new Promise((r) => { open = r; });
  const all = Promise.all([get(`/api/portfolio/${w}`), get(`/api/portfolio/${w}`), get(`/api/portfolio/${w}`)]);
  await new Promise((r) => setTimeout(r, 100));
  open(); chain.gate = null;
  const answers = await all;
  for (const a of answers) { assert.equal(a.status, 200); assert.deepEqual(a.body, answers[0].body); }
  assert.equal(calls.length, 3); // one balance + two token reads, not nine
  t += PORTFOLIO_CACHE_MS - 1;
  chain.lamports = 7;
  assert.equal((await get(`/api/portfolio/${w}`)).body.solLamports, "1500000000");
  assert.equal(calls.length, 3);
  t += 1;
  const fresh = await get(`/api/portfolio/${w}`);
  assert.equal(fresh.body.solLamports, "7"); assert.equal(fresh.body.at, Math.floor(t / 1000));
  assert.equal(calls.length, 6);
  chain.lamports = 1_500_000_000;
});

test("GET /api/portfolio/:wallet: a failed chain read degrades, is retried sooner, never 500", async () => {
  const w = key(81);
  model.upsertCoin({ mint: K.B, creator: w });
  chain.failTokens = true;
  let r = await get(`/api/portfolio/${w}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.holdingsOk, false); assert.deepEqual(r.body.holdings, []); assert.equal(r.body.untracked, 0);
  assert.equal(r.body.solLamports, "1500000000");
  assert.deepEqual(r.body.launched.map((c) => c.mint), [K.B]); // the model's part still answers
  chain.failTokens = false; chain.failBalance = true;
  t += 3_000; // a failed body is kept 3 s, not 10
  r = await get(`/api/portfolio/${w}`);
  assert.equal(r.status, 200); assert.equal(r.body.solLamports, null); assert.equal(r.body.holdingsOk, true); assert.ok(r.body.holdings.length > 0);
  chain.failBalance = false;
  t += 3_000;
  r = await get(`/api/portfolio/${w}`);
  assert.equal(r.body.solLamports, "1500000000"); assert.equal(r.body.holdingsOk, true);
  // A client without `call` (no RPC at all) degrades the same way.
  const p = createPortfolio({ model, rpc: {}, log: quiet });
  const body = await p.get(w);
  assert.equal(body.holdingsOk, false); assert.equal(body.solLamports, null); assert.equal(body.launchedTotal, 1);
});

test("portfolio cache is bounded; the launched list is capped", async () => {
  const p = createPortfolio({ model, rpc, log: quiet, now: () => t, max: 3 });
  for (let i = 0; i < 5; i++) await p.get(key(100 + i));
  assert.equal(p.snapshot().cached, 3);
  assert.ok(PORTFOLIO_CACHE_MAX >= 100);
  const maker = key(90);
  for (let i = 0; i < PORTFOLIO_LAUNCHED_MAX + 5; i++) {
    const mint = new PublicKey(Buffer.concat([Buffer.from([200, i >> 8, i & 255]), Buffer.alloc(29, 9)])).toBase58();
    model.upsertCoin({ mint, curve: `C_M${i}`, depth: 1, quoteMint: K.ROOT, ...base, creator: maker, virtualQuoteReserves: "1000000000000000", createdAt: 10_000 + i });
  }
  const body = await p.get(maker);
  assert.equal(body.launched.length, PORTFOLIO_LAUNCHED_MAX); assert.equal(body.launchedTotal, PORTFOLIO_LAUNCHED_MAX + 5);
  assert.equal(body.launched[0].createdAt, 10_000 + PORTFOLIO_LAUNCHED_MAX + 4);
  assert.equal(body.launched[1].createdAt, 10_000 + PORTFOLIO_LAUNCHED_MAX + 3);
});

test("GET /api/portfolio/:wallet: 400 on a bad address, its own rate limit", async () => {
  for (const bad of ["not-a-wallet", "0x1234", WALLET + WALLET]) {
    const r = await get(`/api/portfolio/${bad}`);
    assert.equal(r.status, 400); assert.equal(r.body.error, "invalid wallet");
  }
  assert.deepEqual(DEFAULT_RATES.portfolio, [20, 60_000]);
  let s2;
  await new Promise((r) => { s2 = appOf({ rates: { portfolio: { limit: 2, windowMs: 60_000 } } }).listen(0, "127.0.0.1", r); });
  try {
    const u2 = `http://127.0.0.1:${s2.address().port}`;
    assert.equal((await get(`/api/portfolio/${WALLET}`, u2)).status, 200);
    assert.equal((await get(`/api/portfolio/${WALLET}`, u2)).status, 200);
    const r = await get(`/api/portfolio/${WALLET}`, u2);
    assert.equal(r.status, 429); assert.ok(r.body.retryAfter >= 1);
    assert.match(r.headers.get("x-ratelimit-policy"), /name=portfolio/);
    assert.equal((await get(`/api/coin/${K.ROOT}`, u2)).status, 200); // other reads are not affected
  } finally { s2.close(); }
});

test("launched coins survive a curve re-read: the launcher field, then the fee shares, never the platform's share", async () => {
  const mints = (w, m = model) => m.createdBy(w).map((c) => c.mint).sort();
  const reload = () => { const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], log: quiet }); m.load(); return m; };
  const W = key(110), PDA = key(111), LIVE = key(112), OLD = key(113), W2 = key(114), W3 = key(115), PARENT = key(116), GONE = key(117);
  const before = mints(PLATFORM);
  // Created live: the CreateEvent names the wallet as creator and launcher (indexer #insertCreate).
  model.upsertCoin({ mint: LIVE, curve: "C_LIVE", depth: 1, quoteMint: K.ROOT, ...base, creator: W, launcher: W, virtualQuoteReserves: "1000000000000000", createdAt: 20_000 });
  assert.deepEqual(mints(W), [LIVE]);
  // The next curve re-read carries the curve's creator, now the fee-sharing config's address, and no launcher.
  model.upsertCoin({ mint: LIVE, creator: PDA, virtualQuoteReserves: "1100000000000000" });
  assert.equal(model.get(LIVE).launcher, W);
  assert.deepEqual(mints(W), [LIVE]);
  // Its shares name the parent's creator too: with a launcher known, only the launcher counts.
  model.upsertCoin({ mint: LIVE, shares: [{ address: W, bps: 5000 }, { address: PARENT, bps: 3500 }, { address: PLATFORM, bps: 1500 }], sharesAt: 1 });
  assert.deepEqual(mints(W), [LIVE]); assert.deepEqual(mints(PARENT), []);
  // A coin from before the launcher was kept: the curve names the config, only the shares name the wallet.
  model.upsertCoin({ mint: OLD, curve: "C_OLD", depth: 1, quoteMint: K.ROOT, ...base, creator: PDA, virtualQuoteReserves: "1000000000000000", createdAt: 19_000 });
  assert.deepEqual(mints(W2), []);
  model.upsertCoin({ mint: OLD, shares: [{ address: W2, bps: 5000 }, { address: PLATFORM, bps: 5000 }], sharesAt: 1 });
  assert.deepEqual(mints(W2), [OLD]);
  // The platform wallet is in every Spore split and is not indexed through it.
  assert.deepEqual(mints(PLATFORM), before);
  assert.equal(model.creators.get(PLATFORM)?.has(OLD) ?? false, false);
  // Both survive a restart (the launcher column, the stored shares).
  const again = reload();
  assert.equal(again.get(LIVE).launcher, W);
  assert.deepEqual(mints(W, again), [LIVE]); assert.deepEqual(mints(W2, again), [OLD]); assert.deepEqual(mints(PARENT, again), []);
  assert.deepEqual(mints(PLATFORM, again), before);
  // A later re-read without a launcher does not erase the stored one either.
  model.upsertCoin({ mint: LIVE, creator: PDA, refreshedAt: 5 });
  assert.equal(reload().get(LIVE).launcher, W);
  // Changed shares move the entry; a refresh that carries no shares keeps it; shares gone drops it.
  model.upsertCoin({ mint: OLD, shares: [{ address: W3, bps: 5000 }, { address: PLATFORM, bps: 5000 }], sharesAt: 2 });
  assert.deepEqual(mints(W2), []); assert.equal(model.creators.has(W2), false); assert.deepEqual(mints(W3), [OLD]);
  model.upsertCoin({ mint: OLD, virtualQuoteReserves: "1200000000000000" });
  assert.deepEqual(mints(W3), [OLD]);
  model.upsertCoin({ mint: OLD, shares: null, sharesAt: 3 });
  assert.deepEqual(mints(W3), []); assert.equal(model.creators.has(W3), false);
  model.upsertCoin({ mint: OLD, shares: [{ address: W2, bps: 5000 }, { address: PLATFORM, bps: 5000 }], sharesAt: 4 });
  assert.deepEqual(mints(W2), [OLD]);
  // An evicted coin leaves every entry it had: launcher, curve creator and shares.
  model.upsertCoin({ mint: GONE, curve: "C_GONE", depth: 0, quoteMint: null, ...base, creator: key(118), shares: [{ address: key(119), bps: 10_000 }], tracked: false });
  model.upsertCoin({ mint: key(120), curve: "C_GONE2", depth: 0, quoteMint: null, ...base, creator: key(121), launcher: key(122), tracked: false });
  for (const w of [key(118), key(119), key(121), key(122)]) assert.equal(model.creators.get(w).size, 1);
  assert.equal(model.evictUntracked({ idleMs: -60_000 }), 2);
  for (const w of [key(118), key(119), key(121), key(122)]) assert.equal(model.creators.has(w), false);

  // The route: both coins are answered as launched with the wallet as creator, also where they are held.
  chain[SPL] = [tokenAccount(LIVE, 1_000_000, W)]; chain[T22] = [tokenAccount(OLD, 1_000_000, W)];
  const a = (await get(`/api/portfolio/${W}`)).body;
  assert.deepEqual(a.launched.map((c) => c.mint), [LIVE]); assert.equal(a.launched[0].creator, W);
  const held = new Map(a.holdings.map((h) => [h.mint, h.coin]));
  assert.equal(held.get(LIVE).creator, W);   // launched by this wallet
  assert.equal(held.get(OLD).creator, PDA);  // someone else's coin without a launcher: the curve's creator
  const b = (await get(`/api/portfolio/${W2}`)).body;
  assert.deepEqual(b.launched.map((c) => c.mint), [OLD]); assert.equal(b.launched[0].creator, W2);
  assert.equal(b.holdings.find((h) => h.mint === OLD).coin.creator, W2);
  assert.equal(b.holdings.find((h) => h.mint === LIVE).coin.creator, W); // held, launched by another wallet: its launcher
  assert.deepEqual(Object.keys(b.launched[0]), Object.keys(a.launched[0]));
  chain[SPL] = []; chain[T22] = [];
});

test("the token-account read is capped: an answer over PORTFOLIO_MAX_BYTES is holdingsOk false with launched answered, never a 500", async () => {
  assert.equal(PORTFOLIO_MAX_BYTES, 4 * 1024 * 1024);
  // The route passes the cap on the token reads only.
  calls.length = 0;
  await get(`/api/portfolio/${key(130)}`);
  for (const c of calls) assert.equal(c.opts.maxBytes, c.method === "getTokenAccountsByOwner" ? PORTFOLIO_MAX_BYTES : undefined);
  // Through the real client: an owner whose answer is larger than the cap. The body is not read to the end,
  // nothing is parsed, the read is not retried, and the balance (a small answer) still arrives.
  const w = key(131);
  model.upsertCoin({ mint: key(132), curve: "C_BIG", depth: 1, quoteMint: K.ROOT, ...base, creator: w, virtualQuoteReserves: "1000000000000000", createdAt: 21_000 });
  let tokenFetches = 0, pulled = 0;
  const chunk = new Uint8Array(256 * 1024).fill(0x20);
  const endless = () => new Response(new ReadableStream({ pull(ctl) { pulled += chunk.byteLength; ctl.enqueue(chunk); } }));
  const real = new Rpc({ url: "https://rpc.example", rps: 1000, apiRps: 1000, log: quiet, fetchImpl: async (u, init) => {
    const { method } = JSON.parse(init.body);
    if (method === "getBalance") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: 5 } }));
    tokenFetches++;
    return endless();
  } });
  const p = createPortfolio({ model, rpc: real.lane("api"), log: quiet, now: () => t });
  const t0 = Date.now();
  const body = await p.get(w);
  assert.equal(body.holdingsOk, false); assert.deepEqual(body.holdings, []); assert.equal(body.solLamports, "5");
  assert.deepEqual(body.launched.map((c) => c.mint), [key(132)]);
  assert.equal(tokenFetches, 2, "one request per token program, no retry of an oversized answer");
  assert.ok(pulled <= 2 * (PORTFOLIO_MAX_BYTES + 4 * chunk.byteLength), `read ${pulled} bytes`);
  assert.ok(Date.now() - t0 < 5_000);
  assert.equal(real.lanes.api.inFlight, 0);
  assert.equal(p.snapshot().failed, 1);
  // The same owner over HTTP: 200.
  chain.failTokens = true;
  const r = await get(`/api/portfolio/${w}`);
  chain.failTokens = false;
  assert.equal(r.status, 200); assert.equal(r.body.holdingsOk, false); assert.equal(r.body.launchedTotal, 1);
});

test("the chain reads share one deadline: an RPC that never answers degrades the body and frees the wallet's cache entry", async () => {
  assert.equal(PORTFOLIO_DEADLINE_MS, 12_000);
  const w = key(140);
  model.upsertCoin({ mint: key(141), curve: "C_HANG", depth: 1, quoteMint: K.ROOT, ...base, creator: w, virtualQuoteReserves: "1000000000000000", createdAt: 22_000 });
  // A client that ignores the signal and never settles.
  const signals = [];
  const dead = { call: (method, params, opts) => { signals.push(opts.signal); return new Promise(() => {}); } };
  let clock = t;
  const p = createPortfolio({ model, rpc: dead, log: quiet, now: () => clock, deadlineMs: 60 });
  const t0 = Date.now();
  const [a, b] = await Promise.all([p.get(w), p.get(w)]); // the second request shares the read and is released with it
  assert.ok(Date.now() - t0 >= 50 && Date.now() - t0 < 2_000, `answered after ${Date.now() - t0} ms`);
  assert.equal(a, b);
  assert.equal(a.holdingsOk, false); assert.equal(a.solLamports, null); assert.deepEqual(a.holdings, []);
  assert.deepEqual(a.launched.map((c) => c.mint), [key(141)]); assert.equal(a.launchedTotal, 1);
  assert.equal(signals.length, 3);
  for (const s of signals) { assert.equal(s.aborted, true); assert.match(s.reason.message, /no answer within 60 ms/); }
  assert.deepEqual({ ...p.snapshot() }, { cached: 1, builds: 1, hits: 0, shared: 1, failed: 1, late: 1 });
  // The entry holds the degraded body for the short window, then a new read starts: nothing is pinned.
  await p.get(w);
  assert.equal(p.snapshot().hits, 1);
  clock += 3_000;
  await p.get(w);
  assert.equal(p.snapshot().builds, 2); assert.equal(signals.length, 6);

  // Through the real client: the free RPC answers 429 to everything, which pauses the lane for longer than the deadline.
  let fetches = 0;
  const limited = new Rpc({ url: "https://rpc.example", rps: 1000, apiRps: 1000, log: quiet, backoffMinMs: 30_000, fetchImpl: async () => { fetches++; return new Response("", { status: 429 }); } });
  const q = createPortfolio({ model, rpc: limited.lane("api"), log: quiet, deadlineMs: 80 });
  const t1 = Date.now();
  const body = await q.get(w);
  assert.ok(Date.now() - t1 < 2_000, `answered after ${Date.now() - t1} ms`);
  assert.equal(body.holdingsOk, false); assert.equal(body.solLamports, null); assert.equal(body.launchedTotal, 1);
  // The abandoned calls left the lane: nothing in flight, nothing queued, no further request once the pause ends.
  await new Promise((r) => setTimeout(r, 20));
  const lane = limited.laneSnapshot().api;
  assert.equal(lane.inFlight, 0); assert.equal(lane.queued, 0);
  assert.ok(fetches <= 3, `${fetches} requests`);
});
