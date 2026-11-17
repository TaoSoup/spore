// Chart history (lib/chart-history.mjs): the opt-in, when history is needed, the GeckoTerminal row (units, venues,
// createdAt, retention, re-asks, the seam check, budgets and queues), the chain sampling (trigger, quiet, exact,
// sampled, anchors, caps and outages, USD, extension, a migrated coin), restarts, pruning, health and the lane.
// GeckoTerminal is a fake fetch answering real Responses, the chain a fake (helpers/chain.mjs), the clock fake. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChartHistory, HIST_SOL_POOL, USDC_MINT, HIST_SETTLE_S, HIST_EXTEND_S, HIST_NONE_RETRY_S, HIST_MISMATCH_RETRY_S, HIST_RETRY_MS, HIST_MAX_QUEUE, HIST_COIN_GT_DAILY,
  HIST_SAMPLES, HIST_LIST_PAGES, HIST_JOB_CALLS, HIST_PARTIAL_RETRY_S, HIST_OUTAGE_PAUSE_MS, HIST_SAMPLE_EXTEND_S, HIST_KEEP_S, HIST_MAX_ROWS, HIST_TOUCH_S, HIST_HOLE_MIN } from "../lib/chart-history.mjs";
import { Gecko } from "../lib/gecko.mjs";
import { buildCandles, createApp } from "../lib/api.mjs";
import { SOL_MINT } from "../lib/jupiter.mjs";
import { tradeOfEvent } from "../lib/indexer.mjs";
import { decodeEvent } from "../lib/decode.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { BN, PublicKey, pumpIdl } from "../lib/sdk.mjs";
import { PLATFORM, quiet } from "./helpers/tree.mjs";
import { key, CURVE as CURVE_PROGRAM, AMM, W, payload, poolEvent, frame, txOf, setup, fakeChain, fakeClock } from "./helpers/chain.mjs";

const NOW = 1_700_006_400;  // a UTC midnight: every test has the whole day's budgets ahead
const R = 300;
// A: a SOL coin on its curve; A2: another; G: a graduated SOL coin (pool + curve); CH: quoted in A; U: quoted in USDC;
// L: quoted in a listed asset; X: not tracked.
const A = key(120), A_CURVE = key(121), A2 = key(122), A2_CURVE = key(123);
const G = key(130), G_CURVE = key(131), G_POOL = key(132), G_BASE_VAULT = key(133), G_QUOTE_VAULT = key(134);
const CH = key(140), CH_CURVE = key(141), U = key(150), U_CURVE = key(151), L = key(160), L_CURVE = key(161), LISTED = key(162), X = key(170), X_CURVE = key(171);
/** Two-byte keys for the bulk coins of the queue test. */
const key2 = (a, b) => { const buf = Buffer.alloc(32, a); buf[0] = b; return new PublicKey(buf).toBase58(); };
const CURVE_STATE = { virtualTokenReserves: "1000000000000000", virtualQuoteReserves: "2000000000000000", realTokenReserves: "500000000000000", realQuoteReserves: "0", tokenTotalSupply: "1000000000000000", initialVirtualQuoteReserves: "0", complete: false, migrated: false, creator: "CR" };
function addCoin(m, mint, curve, more = {}) { m.upsertCoin({ mint, curve, depth: more.quoteMint ? 1 : 0, quoteMint: null, ...CURVE_STATE, tracked: true, ...more }); }
function addCoins(m) {
  addCoin(m, A, A_CURVE); addCoin(m, A2, A2_CURVE);
  addCoin(m, G, G_CURVE, { virtualTokenReserves: "0", virtualQuoteReserves: "0", realTokenReserves: "0", realQuoteReserves: "0", migrated: true, complete: true, pool: G_POOL, poolBaseVault: G_BASE_VAULT, poolQuoteVault: G_QUOTE_VAULT, poolBase: "200000000000000", poolQuote: "85000000000", poolVirtualQuote: "0" });
  addCoin(m, CH, CH_CURVE, { quoteMint: A }); addCoin(m, U, U_CURVE, { quoteMint: USDC_MINT }); addCoin(m, L, L_CURVE, { quoteMint: LISTED });
  addCoin(m, X, X_CURVE, { tracked: false });
  m.setQuoteUsd(LISTED, 5);
}
/** Candles every `R` s over [from, to], close `c` (a function of t, or a number), volume `v`. */
const flat = (from, to, res, c, v = 10) => { const out = []; for (let t = Math.floor(from / res) * res; t <= to; t += res) { const x = typeof c === "function" ? c(t) : c; out.push({ t, o: x, h: x, l: x, c: x, v }); } return out; };
/** GeckoTerminal as a fake fetch: `pools` pool → { base, quote, usd, token } (candles) or (params, n) → Response; unknown pools 404. */
function fakeGt(pools, clock) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url), parts = u.pathname.split("/");
    const p = { pool: parts[6], tf: parts[8], agg: Number(u.searchParams.get("aggregate")), currency: u.searchParams.get("currency"), token: u.searchParams.get("token"), before: Number(u.searchParams.get("before_timestamp")), limit: Number(u.searchParams.get("limit")), at: clock.now() };
    calls.push(p);
    const e = pools.get(p.pool);
    if (typeof e === "function") return e(p, calls.length);
    if (!e) return new Response("{}", { status: 404 });
    const list = (e[p.currency] ?? []).filter((c) => c.t <= p.before).sort((a, b) => b.t - a.t).slice(0, p.limit).map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]);
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } }, meta: { base: { address: e.base }, quote: { address: e.quote } } }), { status: 200 });
  };
  f.calls = calls;
  f.of = (pool) => calls.filter((c) => c.pool === pool);
  return f;
}
const r8 = (x) => Number(x.toPrecision(8));
const status = (n, headers = {}) => () => new Response("{}", { status: n, headers });
/** A stored trade, as the live path stores one. */
const put = (db, mint, sig, time, { pq = 0.002, pu = 0.2, quote = "1000", slot = 1 } = {}) => db.insertTrade({ sig, mint, idx: 0, slot, time, isBuy: true, user: W, baseAmount: "1", quoteAmount: quote, priceQuote: pq, priceUsd: pu, valueUsd: pu });
/** One trade every `step` s over [from, to]; the first one's signature is `${tag}${from}`. */
const ownTrades = (db, mint, from, to, opts = {}, step = R, tag = "own") => { for (let t = from; t <= to; t += step) put(db, mint, `${tag}${t}`, t, opts); };
/** A pump curve TradeEvent of `mint` with its own price (virtual quote reserves `vq`) and quote amount. */
const evt = (mint, at, { vq = "2000000000000000", quote = "1000" } = {}) => payload(pumpIdl, "TradeEvent", { mint: new PublicKey(mint), user: new PublicKey(W), timestamp: new BN(at), is_buy: true, token_amount: new BN("5000000"), quote_amount: new BN(quote),
  virtual_quote_reserves: new BN(vq), virtual_token_reserves: new BN("1000000000000000"), real_quote_reserves: new BN("700"), real_token_reserves: new BN("500000000000000") });
const sig = (signature, slot, blockTime, err = null) => ({ signature, slot, blockTime, err });
const curveTx = (mint, s, opts) => txOf(frame(CURVE_PROGRAM, evt(mint, s.blockTime, opts)), { slot: s.slot, blockTime: s.blockTime });
/** Signatures newest first: `n` of them spread over [from, to), slots `slot0 + i` (older lower). */
const spread = (prefix, n, from, to, slot0 = 1000) => Array.from({ length: n }, (_, i) => sig(`${prefix}${i}`, slot0 + i, from + Math.floor(((to - from) * i) / n))).reverse();

function world({ now = NOW, cfg = {}, pools = new Map(), sigsOf = new Map(), txs = new Map(), slotOf = null, busy = null, daily = 5000, sample = true, onCall = null, rpcExtra = {} } = {}) {
  const { db, m } = setup();
  addCoins(m);
  const clock = fakeClock(now * 1000);
  if (!pools.has(HIST_SOL_POOL)) pools.set(HIST_SOL_POOL, { base: SOL_MINT, quote: USDC_MINT, usd: flat(now - 1000 * 3600, now, 3600, (t) => 100 + (t - now) / 3600 / 100) });
  const fetch = fakeGt(pools, clock);
  const chain = fakeChain([], txs, { sigsOf, slotOf, onCall });
  const rpc = { call: chain.call, ...rpcExtra };
  const fill = { busy: busy ?? (() => false) };
  const logs = [];
  const log = { info: (s) => logs.push(s), warn: (s) => logs.push(s), error: () => {} };
  const make = (extra = {}) => new ChartHistory({ model: m, gecko: new Gecko({ perMin: 600, daily, db, fetch, now: clock.now, sleep: clock.sleep, log }), rpc: sample ? rpc : null, fill, cfg, now: clock.now, sleep: clock.sleep, log, ...extra });
  const w = { db, m, clock, fetch, chain, rpc, fill, logs, pools, sigsOf, txs, make, hist: make() };
  /** What the route does for `history=1`: our own candles of the window, the first stored trade, serve. */
  w.ask = (mint, res = R, { hist = w.hist, mayQueue } = {}) => {
    const nowS = Math.floor(clock.now() / 1000);
    const own = buildCandles(db.tradesSince(mint, nowS - res * 500), res);
    return hist.serve(m.get(mint), res, own, db.tradeAfter(mint, -1), { mayQueue });
  };
  w.run = async (hist = w.hist) => { if (!hist.started) hist.start(); await hist.idle(); };
  w.nowS = () => Math.floor(clock.now() / 1000);
  w.row = (mint, res, unit) => w.db.histGet(mint, res, unit);
  w.samples = (mint) => { const r = w.db.samplesGet(mint); return r ? { ...r, pts: JSON.parse(r.data) } : null; };
  w.close = () => { w.hist.stop(); db.close(); };
  return w;
}
const listings = (chain) => chain.calls.filter((c) => c.method === "getSignaturesForAddress");
const reads = (chain) => chain.calls.filter((c) => c.method === "getTransaction");
/** An app over the world's model with `chartHistory`; requests through HTTP. */
async function serveApp(w, { rates = null, chartHistory = w.hist } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spore-hist-api-"));
  const hub = new EventHub({ heartbeatMs: 200 });
  const app = createApp({ model: w.m, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc: { call: async () => { throw new Error("no chain in this test"); } }, hub, images: new ImageCache(dir), meta: null,
    platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet, chartHistory, rates });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (p) => fetch(url + p).then(async (r) => { const text = await r.text(); return { status: r.status, text, body: JSON.parse(text) }; }),
    close: async () => { await new Promise((r) => server.close(r)); hub.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
/** A coin created 20 h ago whose first stored trade is 8 h after that, priced 0.2 USD (0.002 SOL), with GeckoTerminal candles of its curve over the whole window. */
function recorded(w, mint = A, curve = A_CURVE, { created = w.nowS() - 20 * 3600, after = 8 * 3600, pu = 0.2, pq = 0.002, gt = true } = {}) {
  w.m.upsertCoin({ mint, createdAt: created });
  const B = Math.floor((created + after) / R) * R;
  ownTrades(w.db, mint, B, w.nowS() - 60, { pu, pq });
  if (gt) w.pools.set(curve, { base: mint, quote: SOL_MINT, usd: flat(created, w.nowS() + 86_400 * 3, R, pu), token: flat(created, w.nowS() + 86_400 * 3, R, pq, 2) });
  return { created, B, b0: Math.floor(B / R) * R };
}

// ---------------------------------------------------------------- opt-in
test("14. opt-in: without history=1 the body is today's, before and after rows exist; scope=all, res=120, an untracked coin and CHART_HISTORY=0 add nothing and call nothing", async () => {
  const w = world({ now: Math.floor(Date.now() / 1000) });
  recorded(w);
  const app = await serveApp(w), plain = await serveApp(w, { chartHistory: null });
  try {
    const today = (await plain.get(`/api/candles/${A}?res=300`)).text;
    assert.equal((await app.get(`/api/candles/${A}?res=300`)).text, today);
    assert.equal(w.fetch.calls.length, 0);
    const first = await app.get(`/api/candles/${A}?res=300&history=1`);
    assert.deepEqual(Object.keys(first.body), ["candles", "priceKey", "history"]);
    assert.equal(first.body.history.state, "loading");
    await w.run();
    const done = await app.get(`/api/candles/${A}?res=300&history=1`);
    assert.equal(done.body.history.gecko, A_CURVE);
    assert.ok(done.body.candles.length > JSON.parse(today).candles.length, "history in front of ours");
    assert.equal((await app.get(`/api/candles/${A}?res=300`)).text, (await plain.get(`/api/candles/${A}?res=300`)).text, "rows exist: still today's body");
    const calls = w.fetch.calls.length;
    for (const q of ["res=300&history=1&scope=all", "res=120&history=1", "res=60&history=0"]) {
      const r = await app.get(`/api/candles/${A}?${q}`);
      assert.equal(r.status, 200); assert.equal("history" in r.body, false, q);
    }
    assert.equal(w.hist.serve(w.m.get(X), R, { candles: [], priceKey: "usd" }, null), null, "an untracked coin");
    const off = w.make({ cfg: { enabled: false } }), offApp = await serveApp(w, { chartHistory: off });
    try { assert.equal("history" in (await offApp.get(`/api/candles/${A2}?res=300&history=1`)).body, false, "CHART_HISTORY=0"); } finally { await offApp.close(); }
    assert.equal(w.fetch.calls.length, calls, "no GeckoTerminal call for any of them");
  } finally { await app.close(); await plain.close(); w.close(); }
});

test("15. not needed: a coin first stored within 2R of its creation, or whose first stored trade is before the window → null, nothing queued, no call", () => {
  const w = world();
  const created = NOW - 20 * 3600;
  w.m.upsertCoin({ mint: A, createdAt: created });
  ownTrades(w.db, A, created + R, NOW - 60);
  assert.equal(w.ask(A), null);
  ownTrades(w.db, A2, NOW - 500 * R - 600, NOW - 60, {}, 3600, "old");
  assert.equal(w.ask(A2), null, "B ≤ W");
  assert.deepEqual([w.hist.gtQueue.size, w.fetch.calls.length, w.hist.stats.asked], [0, 0, 0]);
  w.close();
});

// ---------------------------------------------------------------- the GeckoTerminal row
test("16. first ask: loading, one queue entry however often asked; then done with gecko set and GT candles below b0; exactly 1 call, before = top, limit = (top − lo)/R + 1", async () => {
  const w = world();
  const { created, b0 } = recorded(w);
  for (let i = 0; i < 4; i++) assert.deepEqual(w.ask(A).history, { state: "loading", gecko: null, chain: null });
  assert.deepEqual([w.hist.gtQueue.size, w.hist.stats.queued], [1, 1]);
  await w.run();
  const done = w.ask(A);
  assert.deepEqual(done.history, { state: "done", gecko: A_CURVE, chain: null });
  const lo = Math.floor(created / R) * R, top = Math.floor((NOW - HIST_SETTLE_S) / R) * R - R;
  assert.equal(w.fetch.calls.length, 1);
  assert.deepEqual([w.fetch.calls[0].pool, w.fetch.calls[0].currency, w.fetch.calls[0].before, w.fetch.calls[0].limit], [A_CURVE, "usd", top, (top - lo) / R + 1]);
  const below = done.candles.filter((c) => c.t < b0);
  assert.equal(below.length, (b0 - lo) / R);
  assert.ok(below.every((c) => c.c === 0.2 && c.v === 10));
  assert.equal(done.priceKey, "usd");
  const row = w.row(A, R, "usd");
  assert.deepEqual([row.state, JSON.parse(row.pools), row.cov_from, row.cov_to], ["ok", [A_CURVE], lo, top + R]);
  assert.equal(JSON.parse(row.data).at(-1)[0], top, "nothing newer than the settled top is stored");
  w.close();
});

test("17. units: quote-keyed asks currency=token (v × 1e9 for SOL, × 1e6 for a coin quote); usd-keyed asks usd; meta of another quote → mismatch, nothing served; a key flip fetches the other unit once and keeps both", async () => {
  const w = world({ sample: false });
  recorded(w, A, A_CURVE, { pu: null });
  recorded(w, CH, CH_CURVE, { pu: null, pq: 3 });
  w.pools.get(CH_CURVE).base = CH; w.pools.get(CH_CURVE).quote = A; w.pools.get(CH_CURVE).token = flat(NOW - 20 * 3600, NOW, R, 3, 3);
  assert.equal(w.ask(A).priceKey, "quote"); w.ask(CH);
  await w.run();
  assert.deepEqual(w.fetch.calls.map((c) => c.currency), ["token", "token"]);
  assert.equal(JSON.parse(w.row(A, R, "quote").data)[0][5], 2e9, "whole SOL → lamports");
  assert.equal(JSON.parse(w.row(CH, R, "quote").data)[0][5], 3e6, "whole parent tokens → atoms (6 decimals)");
  assert.equal(w.ask(A).history.gecko, A_CURVE);
  // usd-keyed; the meta names another quote: mismatch, nothing served
  const v = world({ sample: false });
  const { b0 } = recorded(v, A2, A2_CURVE);
  v.pools.get(A2_CURVE).quote = USDC_MINT;
  v.ask(A2); await v.run();
  assert.equal(v.fetch.calls[0].currency, "usd");
  assert.equal(v.row(A2, R, "usd").state, "mismatch");
  const r = v.ask(A2);
  assert.equal(r.history, undefined); assert.ok(r.candles.every((c) => c.t >= b0), "only ours");
  // key flip: a trade without USD in the window makes the series quote-keyed: the other row is fetched once, both stay
  recorded(v, A, A_CURVE);
  v.ask(A); await v.run();
  put(v.db, A, "nousd", NOW - 30, { pu: null });
  assert.equal(v.ask(A).history.state, "loading");
  await v.run();
  assert.equal(v.ask(A).priceKey, "quote");
  v.ask(A); await v.run();
  assert.deepEqual(v.fetch.of(A_CURVE).map((c) => c.currency), ["usd", "token"]);
  assert.deepEqual([v.row(A, R, "usd").state, v.row(A, R, "quote").state], ["ok", "ok"]);
  w.close(); v.close();
});

test("18. graduated: the pool first, the curve up to the pool's oldest candle (2 calls, their shared bucket combined); a pool covering everything → 1 call; pool empty + curve ending 17 days ago → ok with pools [curve] and a hole", async () => {
  const w = world({ sample: false });
  const created = NOW - 20 * 3600;
  w.m.upsertCoin({ mint: G, createdAt: created });
  ownTrades(w.db, G, NOW - 4 * 3600, NOW - 60);
  const split = NOW - 10 * 3600;
  w.pools.set(G_POOL, { base: G, quote: SOL_MINT, usd: flat(split, NOW, R, 0.2) });
  // the curve's last trades share the pool's first bucket (the migration's)
  w.pools.set(G_CURVE, { base: SOL_MINT, quote: G, usd: flat(created, split, R, 0.1) });
  w.ask(G); await w.run();
  const [p, c] = w.fetch.calls;
  assert.deepEqual([w.fetch.calls.length, p.pool, c.pool, c.before], [2, G_POOL, G_CURVE, split]);
  assert.equal(c.limit, (split - created) / R + 1);
  const row = w.row(G, R, "usd"), data = JSON.parse(row.data);
  assert.deepEqual(JSON.parse(row.pools), [G_POOL, G_CURVE]);
  assert.equal(data.length, (Math.floor((NOW - HIST_SETTLE_S) / R) * R - R - created) / R + 1, "every bucket from one venue or the other");
  assert.deepEqual([data[0][4], data.at(-1)[4]], [0.1, 0.2]);
  const mig = data.find((x) => x[0] === split);
  assert.deepEqual([mig[1], mig[4], mig[5]], [0.1, 0.2, 20], "the migration's bucket: the curve's open, the pool's close, both volumes");
  assert.equal(w.ask(G).history.gecko, G_POOL, "credit: the newest venue");
  // the pool covers the whole window: 1 call
  const v = world({ sample: false });
  v.m.upsertCoin({ mint: G, createdAt: created });
  ownTrades(v.db, G, NOW - 4 * 3600, NOW - 60);
  v.pools.set(G_POOL, { base: G, quote: SOL_MINT, usd: flat(created, NOW, R, 0.2) });
  v.ask(G); await v.run();
  assert.deepEqual(v.fetch.calls.map((x) => x.pool), [G_POOL]);
  // the pool has no candle, the curve's end 17 days ago (1 h chart): ok, [curve], and its tail is a hole
  const u = world();
  ownTrades(u.db, G, NOW - 12 * 3600, NOW - 60, {}, 600);
  u.pools.set(G_POOL, { base: G, quote: SOL_MINT, usd: [] });
  u.pools.set(G_CURVE, { base: G, quote: SOL_MINT, usd: flat(NOW - 20 * 86_400, NOW - 17 * 86_400 - 3600, 3600, 0.01) });
  u.ask(G, 3600); await u.run();
  assert.deepEqual([u.row(G, 3600, "usd").state, JSON.parse(u.row(G, 3600, "usd").pools)], ["ok", [G_CURVE]]);
  assert.equal(u.hist.stats.holes, 1);
  assert.equal(u.samples(G).from_t, NOW - 17 * 86_400, "sampled from where GeckoTerminal stopped");
  w.close(); v.close(); u.close();
});

test("18b. graduated, the curve's call failing: the pool's page is kept (cov_from at its oldest candle), both asked again after 10 min; a coin with room for 1 call left is not queued for a 2-call job", async () => {
  const w = world({ sample: false });
  const created = NOW - 20 * 3600, split = NOW - 10 * 3600;
  w.m.upsertCoin({ mint: G, createdAt: created });
  ownTrades(w.db, G, NOW - 4 * 3600, NOW - 60);
  w.pools.set(G_POOL, { base: G, quote: SOL_MINT, usd: flat(split, NOW, R, 0.2) });
  w.pools.set(G_CURVE, status(500));
  w.ask(G); await w.run();
  const row = w.row(G, R, "usd");
  assert.ok(row, "the pool's page is stored");
  assert.deepEqual([row.state, JSON.parse(row.pools), row.cov_from, JSON.parse(row.data)[0][0], w.hist.stats.failed], ["ok", [G_POOL], split, split, 0]);
  assert.equal(w.ask(G).history.gecko, G_POOL);
  await w.run();
  assert.equal(w.fetch.calls.length, 2, "not asked again at once");
  w.pools.set(G_CURVE, { base: SOL_MINT, quote: G, usd: flat(created, split - R, R, 0.1) });
  w.clock.t += HIST_RETRY_MS;
  w.ask(G); await w.run();
  assert.deepEqual(w.fetch.calls.slice(2).map((c) => c.pool), [G_POOL, G_CURVE]);
  const full = w.row(G, R, "usd");
  assert.deepEqual([full.cov_from, JSON.parse(full.data)[0][0], JSON.parse(full.data)[0][4], JSON.parse(full.pools)], [created, created, 0.1, [G_POOL, G_CURVE]]);
  w.ask(G); await w.run();
  assert.equal(w.fetch.calls.length, 4, "complete: not asked again");
  // 15 of the coin's 16 calls spent: a graduated coin's job (2 calls) is refused, a curve coin's (1 call) is not
  const v = world({ sample: false });
  recorded(v);
  v.m.upsertCoin({ mint: G, createdAt: created });
  ownTrades(v.db, G, NOW - 4 * 3600, NOW - 60);
  v.pools.set(G_POOL, { base: G, quote: SOL_MINT, usd: flat(split, NOW, R, 0.2) });
  for (const m of [G, A]) v.hist.coinCalls.set(m, { day: Math.floor(NOW / 86_400), n: HIST_COIN_GT_DAILY - 1 });
  v.ask(G); v.ask(A); await v.run();
  assert.deepEqual([v.fetch.calls.map((c) => c.pool), v.hist.stats.refusedCoinCap], [[A_CURVE], 1]);
  w.close(); v.close();
});

test("18c. graduated, the server's GeckoTerminal day running out between the pool's call and the curve's: the pool's page is kept (cov_from at its oldest candle)", async () => {
  const w = world({ sample: false, daily: 1 });
  const created = NOW - 20 * 3600, split = NOW - 10 * 3600;
  w.m.upsertCoin({ mint: G, createdAt: created });
  ownTrades(w.db, G, NOW - 4 * 3600, NOW - 60);
  w.pools.set(G_POOL, { base: G, quote: SOL_MINT, usd: flat(split, NOW, R, 0.2) });
  w.pools.set(G_CURVE, { base: SOL_MINT, quote: G, usd: flat(created, split - R, R, 0.1) });
  w.ask(G); await w.run();
  const row = w.row(G, R, "usd");
  assert.ok(row, "the pool's page is stored");
  assert.deepEqual([row.state, JSON.parse(row.pools), row.cov_from, w.fetch.calls.map((c) => c.pool), w.hist.gtQueue.size], ["ok", [G_POOL], split, [G_POOL], 0]);
  assert.equal(w.ask(G).history.gecko, G_POOL);
  w.close();
});

test("19. createdAt null: lo = W, one call; the next ask and a new ChartHistory on the same db make no call", async () => {
  const w = world({ sample: false });
  ownTrades(w.db, A, NOW - 4 * 3600, NOW - 60);
  w.pools.set(A_CURVE, { base: A, quote: SOL_MINT, usd: flat(NOW - 600 * R, NOW, R, 0.2) });
  w.ask(A); await w.run();
  const top = Math.floor((NOW - HIST_SETTLE_S) / R) * R - R, Wl = NOW - 500 * R;
  assert.deepEqual([w.fetch.calls.length, w.fetch.calls[0].limit], [1, (top - Wl) / R + 1]);
  assert.equal(w.row(A, R, "usd").cov_from, Wl);
  assert.equal(w.ask(A).history.state, "done");
  const again = w.make();
  assert.equal(w.ask(A, R, { hist: again }).history.gecko, A_CURVE);
  await w.run(again);
  assert.equal(w.fetch.calls.length, 1);
  again.stop(); w.close();
});

test("20. retention: B moving within cov_to → no call; 25 h later with B past cov_to → one silent extension (done throughout, merged by t); a failed extension keeps the row", async () => {
  const make = () => {
    const w = world({ sample: false });
    const created = NOW - 20 * 3600;
    w.m.upsertCoin({ mint: A, createdAt: created });
    ownTrades(w.db, A, NOW - 4 * 3600, NOW - 60);
    w.pools.set(A_CURVE, { base: A, quote: SOL_MINT, usd: flat(created, NOW + 2 * 86_400, R, 0.2) });
    return w;
  };
  const w = make();
  w.ask(A); await w.run();
  const before = w.row(A, R, "usd");
  // retention trims the oldest hour: B moves, but within what the row covers
  w.db.db.prepare("DELETE FROM trades WHERE mint = ? AND time < ?").run(A, NOW - 3 * 3600);
  w.clock.t += 7 * 3600_000;
  assert.equal(w.ask(A).history.state, "done"); await w.run();
  assert.equal(w.fetch.calls.length, 1);
  // a day later every old trade is gone: B lies past cov_to
  w.clock.t += 18 * 3600_000;
  w.db.db.prepare("DELETE FROM trades WHERE mint = ?").run(A);
  ownTrades(w.db, A, NOW + 24 * 3600, NOW + 25 * 3600 - 60);
  const gt = w.pools.get(A_CURVE);
  gt.usd = gt.usd.filter((c) => c.t !== NOW - 5 * 3600).map((c) => (c.t >= NOW - 10 * 3600 ? { ...c, c: 0.2000001 } : c));
  assert.equal(w.ask(A).history.state, "done", "silent");
  assert.equal(w.hist.gtQueue.size + (w.hist.gtRunning ? 1 : 0), 1, "queued (and already running: the worker is started)");
  await w.run();
  assert.equal(w.ask(A).history.state, "done"); await w.run();
  assert.equal(w.fetch.calls.length, 2, "exactly one extension");
  const after = w.row(A, R, "usd"), data = new Map(JSON.parse(after.data).map((x) => [x[0], x]));
  assert.equal(data.get(NOW - 5 * 3600)[4], 0.2, "an old candle the new answer did not have is kept");
  assert.equal(data.get(NOW - 4 * 3600)[4], 0.2000001, "the new one wins on equal t");
  assert.ok(after.cov_to > before.cov_to && after.fetched_at > before.fetched_at);
  assert.ok([...data.keys()].every((t) => t >= after.cov_from - R), "older than the new lo − R dropped");
  // the same, with GeckoTerminal failing: the old row stays as it was
  const v = make();
  v.ask(A); await v.run();
  const kept = v.row(A, R, "usd");
  v.clock.t += 25 * 3600_000;
  v.db.db.prepare("DELETE FROM trades WHERE mint = ?").run(A);
  ownTrades(v.db, A, NOW + 24 * 3600, NOW + 25 * 3600 - 60);
  v.pools.set(A_CURVE, status(500));
  v.ask(A); await v.run();
  const { asked_at: a1, ...still } = v.row(A, R, "usd"), { asked_at: a0, ...was } = kept;
  assert.deepEqual(still, was, "the failed extension changed nothing (asked_at only moves with the asks)");
  assert.equal(v.hist.stats.failed, 1);
  w.close(); v.close();
});

test("21. re-asks: 'none' waits 6 h and is asked once after; 'mismatch' waits 24 h; a GeckoTerminal error stores nothing and is not queued again for 10 min", async () => {
  const w = world({ sample: false });
  recorded(w, A, A_CURVE, { gt: false });
  w.ask(A); await w.run();
  assert.equal(w.row(A, R, "usd").state, "none");
  w.clock.t += (HIST_NONE_RETRY_S - 1) * 1000;
  w.ask(A); await w.run();
  assert.equal(w.fetch.calls.length, 1);
  w.clock.t += 1000;
  assert.equal(w.ask(A).history, undefined, "silent"); await w.run();
  w.ask(A); await w.run();
  assert.equal(w.fetch.calls.length, 2);
  // mismatch: 24 h
  recorded(w, A2, A2_CURVE);
  w.pools.get(A2_CURVE).base = USDC_MINT;
  w.ask(A2); await w.run();
  assert.equal(w.row(A2, R, "usd").state, "mismatch");
  w.clock.t += HIST_NONE_RETRY_S * 1000;
  w.ask(A2); await w.run();
  assert.equal(w.fetch.of(A2_CURVE).length, 1);
  w.clock.t += (HIST_MISMATCH_RETRY_S - HIST_NONE_RETRY_S) * 1000;
  w.ask(A2); await w.run();
  assert.equal(w.fetch.of(A2_CURVE).length, 2);
  // an error: nothing stored, not queued for 10 min
  const v = world({ sample: false });
  recorded(v, A, A_CURVE, { gt: false });
  v.pools.set(A_CURVE, status(500));
  v.ask(A); await v.run();
  assert.equal(v.row(A, R, "usd"), null);
  v.clock.t += HIST_RETRY_MS - 1000;
  assert.equal(v.ask(A).history, undefined, "nothing stored, nothing queued");
  assert.equal(v.hist.gtQueue.size, 0);
  v.clock.t += 1000;
  assert.equal(v.ask(A).history.state, "loading");
  w.close(); v.close();
});

test("22. seam check: GT closes 1 000× ours → mismatch, logged once as decimals, nothing served; 1.4× → served, seamWarn counted", async () => {
  const w = world({ sample: false });
  recorded(w, A, A_CURVE, { pu: 0.2 });
  w.pools.get(A_CURVE).usd = flat(NOW - 20 * 3600, NOW, R, 200);
  w.ask(A); await w.run();
  assert.deepEqual([w.row(A, R, "usd").state, w.row(A, R, "usd").data, w.hist.stats.seamMismatch], ["mismatch", "[]", 1]);
  assert.equal(w.ask(A).history, undefined);
  w.clock.t += HIST_MISMATCH_RETRY_S * 1000;
  ownTrades(w.db, A, NOW + 60, w.nowS() - 60);
  w.ask(A); await w.run();
  assert.equal(w.hist.stats.seamMismatch, 2);
  assert.deepEqual(w.logs.filter((l) => l.includes("off ours")), [`history: ${A} GeckoTerminal prices are 10^3 off ours (decimals?)`]);
  const v = world({ sample: false });
  recorded(v, A, A_CURVE, { pu: 0.2 });
  v.pools.get(A_CURVE).usd = flat(NOW - 20 * 3600, NOW, R, 0.28);
  v.ask(A); await v.run();
  assert.deepEqual([v.row(A, R, "usd").state, v.hist.stats.seamWarn], ["ok", 1]);
  assert.equal(v.ask(A).history.gecko, A_CURVE);
  w.close(); v.close();
});

test("23. budgets: the GT day spent → done, nothing queued, logged once; the 17th call of one coin a day is refused; the queue holds 50, the most recent first, the longest unasked displaced", async () => {
  const w = world({ sample: false, daily: 1 });
  recorded(w); recorded(w, A2, A2_CURVE);
  w.ask(A); await w.run();
  for (let i = 0; i < 2; i++) assert.equal(w.ask(A2).history, undefined);
  assert.deepEqual([w.hist.gtQueue.size, w.hist.stats.refusedBudget, w.fetch.calls.length], [0, 2, 1]);
  assert.equal(w.logs.filter((l) => l.includes("GeckoTerminal requests are spent")).length, 1);
  // a graduated coin both of whose venues answer 404: 2 calls a row; 4 resolutions × 2 units = 16 calls, then refused
  const v = world({ sample: false });
  const usd = { candles: [], priceKey: "usd" }, quote = { candles: [{ t: NOW - 60, o: 1, h: 1, l: 1, c: 1, v: 1 }], priceKey: "quote" };
  for (const res of [60, 300, 900, 3600]) for (const own of [usd, quote]) { v.hist.serve(v.m.get(G), res, own, null); await v.run(); }
  assert.equal(v.fetch.of(G_POOL).length + v.fetch.of(G_CURVE).length, HIST_COIN_GT_DAILY);
  v.clock.t += HIST_NONE_RETRY_S * 1000;
  v.hist.serve(v.m.get(G), 300, usd, null); await v.run();
  assert.equal(v.fetch.calls.length, HIST_COIN_GT_DAILY);
  assert.equal(v.hist.stats.refusedCoinCap, 1);
  // the queue: 51 coins asked, the first displaced; asked again, a coin runs first
  const q = world({ sample: false });
  const coins = Array.from({ length: HIST_MAX_QUEUE + 1 }, (_, i) => [key2(200, i), key2(201, i)]);
  for (const [mint, curve] of coins) addCoin(q.m, mint, curve);
  for (const [mint] of coins) { q.clock.t += 1; q.hist.serve(q.m.get(mint), R, usd, null); }
  assert.deepEqual([q.hist.gtQueue.size, q.hist.stats.displaced, q.hist.gtQueue.has(`${coins[0][0]}:${R}:usd`)], [HIST_MAX_QUEUE, 1, false]);
  q.clock.t += 1;
  q.hist.serve(q.m.get(coins[1][0]), R, usd, null);
  await q.run();
  assert.deepEqual([q.fetch.calls[0].pool, q.fetch.calls[1].pool], [coins[1][1], coins[HIST_MAX_QUEUE][1]]);
  w.close(); v.close(); q.close();
});

test("23b. RATE_HISTNEW = 2: the 3rd new job of one IP is refused (limited), stored rows are still served, never a 429", async () => {
  const w = world({ now: Math.floor(Date.now() / 1000), sample: false });
  recorded(w); recorded(w, A2, A2_CURVE); recorded(w, G, G_CURVE);
  w.pools.set(G_CURVE, { base: G, quote: SOL_MINT, usd: flat(w.nowS() - 20 * 3600, w.nowS(), R, 0.2) });
  const app = await serveApp(w, { rates: { histnew: { limit: 2, windowMs: 3_600_000 } } });
  try {
    for (const m of [A, A2]) assert.equal((await app.get(`/api/candles/${m}?res=300&history=1`)).body.history.state, "loading");
    const third = await app.get(`/api/candles/${G}?res=300&history=1`);
    assert.deepEqual([third.status, "history" in third.body, w.hist.stats.limited], [200, false, 1]);
    await w.run();
    const stored = await app.get(`/api/candles/${A}?res=300&history=1`);
    assert.deepEqual([stored.status, stored.body.history.gecko], [200, A_CURVE]);
    assert.equal(w.fetch.of(G_CURVE).length, 0);
  } finally { await app.close(); w.close(); }
});

// ---------------------------------------------------------------- chain sampling
/** A quote-keyed SOL coin (no USD in its trades) with no GeckoTerminal candles, created 20 h ago, first stored 4 h ago as "FIRST". */
function sampler(w, mint = A, curve = A_CURVE, { created = NOW - 20 * 3600, B = NOW - 4 * 3600, pu = null } = {}) {
  w.m.upsertCoin({ mint, createdAt: created });
  put(w.db, mint, `FIRST-${mint}`, B, { pu, slot: 50_000 });
  ownTrades(w.db, mint, B + R, NOW - 60, { pu });
  return { created, B, a: created, anchor: `FIRST-${mint}`, first: sig(`FIRST-${mint}`, 50_000, B) };
}

test("24. sampling trigger: a hole queues a chain job (sampling); CHART_SAMPLE=0 never does; no chain call while fill.busy(), and the job starts within one poll of it clearing", async () => {
  let during = null, polls = 0;
  const busyAt = [];
  const w = world({ busy: () => ++polls <= 5, onCall: () => { busyAt.push(polls <= 5); during ??= w.ask(A); } });
  const { a, first } = sampler(w);
  w.sigsOf.set(A_CURVE, [first, sig("old", 10, a - 100)]);
  assert.equal(w.ask(A).history.state, "loading");
  const t0 = w.clock.t;
  await w.run();
  assert.equal(during.history.state, "sampling", "the GT row is stored, the samples row is not yet");
  assert.ok(busyAt.length > 0 && busyAt.every((b) => !b), "no chain call while the fill was busy");
  assert.equal(polls, 6, "the first poll after it cleared went on");
  assert.equal(w.hist.snapshot().chain.yielded, 1);
  assert.ok(w.clock.t - t0 >= 4 * 2000, "it slept between the polls");
  assert.equal(w.samples(A).state, "quiet");
  // CHART_SAMPLE=0: nothing
  const v = world({ sample: false });
  sampler(v);
  v.ask(A); await v.run();
  assert.equal(v.ask(A).history, undefined);
  assert.deepEqual([v.chain.calls.length, v.hist.chainQueue.size, v.hist.snapshot().sample], [0, 0, false]);
  w.close(); v.close();
});

test("25. quiet: an anchored first page with nothing in [a, b) → quiet after exactly 1 listing (2 for a migrated coin)", async () => {
  const w = world();
  const { a, first } = sampler(w);
  w.sigsOf.set(A_CURVE, [first, sig("old", 10, a - 100)]);
  w.ask(A); await w.run();
  assert.equal(listings(w.chain).length, 1);
  assert.equal(listings(w.chain)[0].params[1].before, first.signature);
  assert.deepEqual([w.samples(A).state, w.samples(A).pts, w.samples(A).retry_at], ["quiet", [], 0]);
  assert.equal(w.ask(A).history, undefined, "nothing to show, nothing pending");
  const v = world({ slotOf: new Map([[`FIRST-${G}`, 50_000]]) });
  const s = sampler(v, G, G_CURVE);
  v.sigsOf.set(G_POOL, [s.first, sig("pold", 10, s.a - 100)]);
  v.sigsOf.set(G_CURVE, [sig("cold", 9, s.a - 200)]);
  v.ask(G); await v.run();
  assert.deepEqual(listings(v.chain).map((c) => [c.params[0], c.params[1].before]), [[G_POOL, s.anchor], [G_CURVE, s.anchor]]);
  assert.equal(v.samples(G).state, "quiet");
  w.close(); v.close();
});

test("26. exact: 40 signatures in the stretch → all read, real OHLCV with summed quote atoms, the event's own priceQuote, failed ones skipped, chain: exact; priced in USD too (one samples row serves both units)", async () => {
  const w = world();
  const { a, B, first } = sampler(w);
  const list = Array.from({ length: 40 }, (_, i) => sig(`x${i}`, 1000 + i, a + 600 + Math.floor(i / 2) * 1000 + (i % 2) * 10)).reverse();
  const failed = [sig("bad1", 999, a + 700, { InstructionError: [0, "Custom"] }), sig("bad2", 998, a + 800, { InstructionError: [0, "Custom"] })];
  w.sigsOf.set(A_CURVE, [first, ...list, ...failed, sig("old", 10, a - 100)]);
  const opts = (i) => ({ vq: String(2e15 + i * 1e12), quote: String(1000 + i) });
  list.forEach((s) => w.txs.set(s.signature, curveTx(A, s, opts(Number(s.signature.slice(1))))));
  w.ask(A); await w.run();
  assert.equal(reads(w.chain).length, 40);
  assert.ok(!reads(w.chain).some((c) => c.params[0].startsWith("bad")));
  const smp = w.samples(A);
  assert.deepEqual([smp.state, smp.pts.length, smp.pts.every((p) => p[4] === 1 && p[2] > 0)], ["exact", 40, true]);
  const want = tradeOfEvent(w.m, w.m.get(A), "TradeEvent", decodeEvent("TradeEvent", evt(A, list.at(-1).blockTime, opts(0))), { sig: "x0", slot: 1000, idx: 0, time: list.at(-1).blockTime }).priceQuote;
  assert.equal(smp.pts[0][1], want);
  const r = w.ask(A);
  assert.deepEqual(r.history, { state: "done", gecko: null, chain: "exact" });
  const t0 = Math.floor((a + 600) / R) * R, c0 = r.candles.find((c) => c.t === t0);
  assert.deepEqual([c0.o, c0.c, c0.v, c0.s], [smp.pts[0][1], smp.pts[1][1], 1000 + 1001, undefined]);
  assert.ok(r.candles.filter((c) => c.t < Math.floor(B / R) * R).length >= 20);
  assert.equal(w.fetch.of(HIST_SOL_POOL).length, 1, "quote-keyed: the USD reference all the same");
  w.close();
});

test("27. sampled: 3 000 signatures → 120 reads; points become s: 1 candles, chain: sampled; trades, tradeAfter and fill_coins are untouched", async () => {
  const w = world();
  const { a, B, first } = sampler(w);
  const list = spread("y", 3000, a + 600, B - 600);
  w.sigsOf.set(A_CURVE, [first, ...list, sig("old", 10, a - 100)]);
  w.txs.get = (s) => (s.startsWith("y") ? curveTx(A, list[list.length - 1 - Number(s.slice(1))], { vq: String(2e15 + Number(s.slice(1)) * 1e11) }) : undefined);
  const count = () => w.db.db.prepare("SELECT COUNT(*) AS n FROM trades").get().n;
  const n0 = count(), oldest = w.db.tradeAfter(A, -1);
  w.ask(A); await w.run();
  assert.equal(reads(w.chain).length, HIST_SAMPLES);
  const smp = w.samples(A);
  assert.deepEqual([smp.state, smp.pts.length, smp.pts.every((p) => p[4] === 0)], ["sampled", HIST_SAMPLES, true]);
  const r = w.ask(A);
  assert.equal(r.history.chain, "sampled");
  const pts = r.candles.filter((c) => c.s === 1);
  assert.ok(pts.length > 50 && pts.every((c) => c.o === c.c && c.h === c.c && c.l === c.c && c.v === 0));
  assert.equal(count(), n0, "no trades row");
  assert.deepEqual(w.db.tradeAfter(A, -1), oldest);
  assert.equal(w.db.db.prepare("SELECT COUNT(*) AS n FROM fill_coins").get().n, 0);
  w.close();
});

test("28. anchors: both addresses listed from the first stored trade's signature; an unknown anchor → an unanchored walk skipping blockTime ≥ b, at most 20 pages", async () => {
  const w = world({ slotOf: new Map([[`FIRST-${G}`, 50_000]]) }); // the node resolves the pool's anchor for the curve through its slot
  const s = sampler(w, G, G_CURVE);
  w.sigsOf.set(G_POOL, [s.first, sig("p1", 40_000, s.B - 100), sig("pold", 10, s.a - 100)]);
  w.sigsOf.set(G_CURVE, [sig("c1", 30_000, s.a + 100), sig("cold", 9, s.a - 200)]);
  w.ask(G); await w.run();
  assert.deepEqual(listings(w.chain).map((c) => c.params[1].before), [s.anchor, s.anchor]);
  // the node does not know the anchor: the walk starts at the top, skips what is at or after b
  const v = world();
  const t = sampler(v);
  const newer = spread("n", 5, t.B + 10, NOW), inside = spread("i", 3, t.a + 100, t.B - 100);
  v.sigsOf.set(A_CURVE, [...newer, ...inside, sig("old", 1, t.a - 100)]); // no FIRST in it, no slot known for it
  [...newer, ...inside].forEach((x) => v.txs.set(x.signature, curveTx(A, x)));
  v.ask(A); await v.run();
  assert.deepEqual(listings(v.chain).map((c) => c.params[1].before ?? null), [t.anchor, null]);
  assert.equal(v.chain.count("getSignatureStatuses"), 1);
  assert.deepEqual(reads(v.chain).map((c) => c.params[0]).sort(), ["i0", "i1", "i2"]);
  assert.equal(v.hist.snapshot().chain.anchorMisses, 1);
  // a busy address: the walk stops at 20 pages
  const u = world();
  const z = sampler(u);
  const many = spread("m", 25_000, z.B + 10, NOW + 3600, 100_000);
  u.sigsOf.set(A_CURVE, many);
  u.ask(A); await u.run();
  assert.equal(listings(u.chain).length, HIST_LIST_PAGES);
  assert.equal(u.samples(A).state, "partial");
  assert.equal(reads(u.chain).length, 0, "nothing of the stretch was reached");
  w.close(); v.close(); u.close();
});

test("29. caps and outages: 20 pages → partial from the oldest listed time; 200 job calls → partial; 5 unanswered reads → partial, retry in 30 min, paused 30 s, points kept; the day spent → partial until tomorrow, queue emptied; a re-run replaces only with as many points", async () => {
  // 25 000 signatures inside the stretch: listed 20 pages deep, the rest is cut
  const w = world();
  const s = sampler(w);
  const many = spread("m", 25_000, s.a + 600, s.B - 600, 100_000);
  w.sigsOf.set(A_CURVE, [s.first, ...many]);
  w.txs.get = (x) => (x.startsWith("m") ? curveTx(A, many[many.length - 1 - Number(x.slice(1))]) : undefined);
  w.ask(A); await w.run();
  const smp = w.samples(A), cut = many[HIST_LIST_PAGES * 1000 - 1]; // listed after FIRST: 20 pages of 1 000
  assert.deepEqual([smp.state, smp.from_t, smp.retry_at, listings(w.chain).length], ["partial", cut.blockTime, 0, HIST_LIST_PAGES]);
  assert.ok(smp.pts.length >= HIST_SAMPLES - 2 && smp.pts.every((p) => p[0] >= cut.blockTime));
  // every read answered null (each tried 3 times): the job's 200 calls run out
  const v = world();
  const t = sampler(v);
  v.sigsOf.set(A_CURVE, [t.first, ...spread("n", 500, t.a + 600, t.B - 600), sig("old", 1, t.a - 100)]);
  v.ask(A); await v.run();
  assert.deepEqual([v.chain.calls.length, v.samples(A).state, v.samples(A).retry_at, v.hist.snapshot().chain.jobCaps], [HIST_JOB_CALLS, "partial", 0, 1]);
  // an outage after 10 good reads: partial, retried in 30 min, the worker paused 30 s, the points kept
  const u = world();
  const z = sampler(u);
  const list = spread("o", 300, z.a + 600, z.B - 600);
  u.sigsOf.set(A_CURVE, [z.first, ...list, sig("old", 1, z.a - 100)]);
  const picksRead = [];
  let failing = true;
  u.txs.get = (x) => { if (!x.startsWith("o")) return undefined; picksRead.push(x); return failing && picksRead.length > 10 ? () => new Error("socket hang up") : curveTx(A, list[list.length - 1 - Number(x.slice(1))]); };
  u.ask(A); await u.run();
  const o = u.samples(A);
  assert.deepEqual([o.state, o.retry_at, u.hist.snapshot().chain.outages], ["partial", u.nowS() + HIST_PARTIAL_RETRY_S, 1]);
  assert.equal(u.hist.snapshot().pausedMs, HIST_OUTAGE_PAUSE_MS);
  assert.ok(o.pts.length >= 9, `points kept: ${o.pts.length}`);
  // re-run once retry_at passed: fewer points (fails sooner) → the stored ones stay; all points → replaced
  u.clock.t += HIST_PARTIAL_RETRY_S * 1000;
  picksRead.length = 8; // the next read is the 9th: 2 more good ones, then failures
  u.ask(A); await u.run();
  assert.equal(u.samples(A).pts.length, o.pts.length, "a worse re-run keeps the stored points");
  assert.ok(u.samples(A).retry_at > o.retry_at);
  u.clock.t += HIST_PARTIAL_RETRY_S * 1000;
  failing = false;
  u.ask(A); await u.run();
  assert.deepEqual([u.samples(A).state, u.samples(A).pts.length, u.samples(A).retry_at], ["sampled", HIST_SAMPLES, 0]);
  // the day's chain calls run out in the middle: partial until the next UTC day; the other coin's queued job is dropped
  const q = world({ cfg: { sampleDaily: 30 } });
  const y = sampler(q), y2 = sampler(q, A2, A2_CURVE);
  const l1 = spread("d", 300, y.a + 600, y.B - 600);
  q.sigsOf.set(A_CURVE, [y.first, ...l1, sig("old", 1, y.a - 100)]);
  q.sigsOf.set(A2_CURVE, [y2.first, sig("old2", 1, y2.a - 100)]);
  q.txs.get = (x) => (x.startsWith("d") ? curveTx(A, l1[l1.length - 1 - Number(x.slice(1))]) : undefined);
  q.ask(A); q.ask(A2);
  q.hist.start();
  await new Promise((r) => setImmediate(r));
  await q.hist.idle();
  const d = q.samples(A);
  assert.deepEqual([d.state, d.retry_at, q.hist.snapshot().chain.budgetStops, q.hist.chainQueue.size, q.samples(A2)], ["partial", NOW + 86_400, 1, 0, null]);
  assert.equal(q.chain.calls.length, 30);
  w.close(); v.close(); u.close(); q.close();
});

test("30. USD of points: SOL coins share one hourly reference call; k = the hourly close at or before t, solUsd past cov_to; USDC → 1; a tracked parent's stored price, else its own row (1 call, its own); a listed quote with a USD key → skipped, no chain call, 24 h", async () => {
  const w = world();
  const s1 = sampler(w, A, A_CURVE, { pu: 0.2, B: NOW - 300 }), s2 = sampler(w, A2, A2_CURVE, { pu: 0.2 });
  const p1 = [sig("e1", 100, NOW - 5000), sig("e2", 101, NOW - 400)].reverse();
  w.sigsOf.set(A_CURVE, [s1.first, ...p1, sig("old", 1, s1.a - 100)]);
  w.sigsOf.set(A2_CURVE, [s2.first, sig("f1", 100, s2.B - 3000), sig("old2", 1, s2.a - 100)]);
  p1.forEach((x) => w.txs.set(x.signature, curveTx(A, x)));
  w.txs.set("f1", curveTx(A2, sig("f1", 100, s2.B - 3000)));
  w.ask(A); w.ask(A2); await w.run();
  assert.equal(w.fetch.of(HIST_SOL_POOL).length, 1, "one reference call for both");
  const sol = JSON.parse(w.row(SOL_MINT, 3600, "usd").data), covTo = w.row(SOL_MINT, 3600, "usd").cov_to;
  const closeAt = (t) => sol.filter((c) => c[0] <= t).at(-1)[4];
  const pts = w.samples(A).pts;
  assert.ok(NOW - 400 >= covTo && NOW - 5000 < covTo);
  assert.equal(pts[0][2], pts[0][1] * closeAt(NOW - 5000), "the hourly close at or before t");
  assert.equal(pts[1][2], pts[1][1] * 100, "past cov_to: today's solUsd");
  // USDC: k = 1
  const u = world();
  const su = sampler(u, U, U_CURVE, { pu: 1 });
  u.sigsOf.set(U_CURVE, [su.first, sig("u1", 100, su.B - 3000), sig("old", 1, su.a - 100)]);
  u.txs.set("u1", curveTx(U, sig("u1", 100, su.B - 3000)));
  u.ask(U); await u.run();
  assert.equal(u.samples(U).pts[0][2], u.samples(U).pts[0][1]);
  assert.equal(u.fetch.of(HIST_SOL_POOL).length, 0);
  // a tracked parent: its stored price at t when it has one, else its own hourly row (fetched once, counted against it)
  const p = world();
  const sc = sampler(p, CH, CH_CURVE, { pu: 0.5 });
  put(p.db, A, "Aold", sc.B - 2000, { pu: 0.3 });
  p.pools.set(A_CURVE, { base: A, quote: SOL_MINT, usd: flat(NOW - 30 * 86_400, NOW, 3600, 0.25) });
  const pc = [sig("k1", 100, sc.B - 9 * 3600), sig("k2", 101, sc.B - 1000)].reverse();
  p.sigsOf.set(CH_CURVE, [sc.first, ...pc, sig("old", 1, sc.a - 100)]);
  pc.forEach((x) => p.txs.set(x.signature, curveTx(CH, x)));
  p.ask(CH); await p.run();
  const [k1, k2] = p.samples(CH).pts;
  assert.equal(k2[2], k2[1] * 0.3, "the parent's stored price at t");
  assert.equal(k1[2], k1[1] * 0.25, "before it: the parent's hourly row");
  assert.deepEqual(p.fetch.of(A_CURVE).map((c) => [c.tf, c.currency]), [["hour", "usd"]]);
  // a listed quote with a USD key: skipped, no chain call, not again for 24 h
  const l = world();
  sampler(l, L, L_CURVE, { pu: 5 });
  l.ask(L); await l.run();
  assert.deepEqual([l.samples(L).state, l.samples(L).retry_at, l.chain.calls.length, l.hist.stats.skippedUsd], ["skipped", NOW + 86_400, 0, 1]);
  l.clock.t += (86_400 - 60) * 1000;
  l.ask(L); await l.run();
  assert.equal(l.hist.stats.skippedUsd, 1);
  l.clock.t += 60_000;
  l.ask(L); await l.run();
  assert.deepEqual([l.hist.stats.skippedUsd, l.chain.calls.length], [2, 0]);
  w.close(); u.close(); p.close(); l.close();
});

test("31. extension: the first stored trade moving more than HIST_HOLE_MIN past to_t, a day after the job → one job for [to_t, B), appended", async () => {
  const w = world();
  const s = sampler(w, A, A_CURVE, { created: NOW - 5 * 86_400, B: NOW - 2 * 86_400 });
  const old = spread("q", 10, s.a + 3600, s.B - 3600);
  w.sigsOf.set(A_CURVE, [s.first, ...old, sig("old", 1, s.a - 100)]);
  old.forEach((x) => w.txs.set(x.signature, curveTx(A, x)));
  w.ask(A, 3600); await w.run();
  const first = w.samples(A);
  assert.deepEqual([first.state, first.pts.length, first.to_t], ["exact", 10, s.B]);
  // a day later retention dropped the first 5 h: B moved; the trades in between are read from the new anchor
  w.clock.t += HIST_SAMPLE_EXTEND_S * 1000;
  w.db.db.prepare("DELETE FROM trades WHERE mint = ? AND time < ?").run(A, s.B + 5 * 3600);
  const nb = w.db.tradeAfter(A, -1);
  const gap = spread("r", 4, s.B, nb.time - 60, 60_000);
  w.sigsOf.set(A_CURVE, [sig(nb.sig, 70_000, nb.time), ...gap, ...old.slice(0, 2)]);
  gap.forEach((x) => w.txs.set(x.signature, curveTx(A, x)));
  w.ask(A, 3600); await w.run(); // the GeckoTerminal 'none' row is asked again first (silent)
  w.ask(A, 3600); await w.run();
  const ext = w.samples(A);
  assert.deepEqual([ext.pts.length, ext.to_t, ext.from_t, ext.state], [14, nb.time, first.from_t, "exact"]);
  assert.equal(listings(w.chain).at(-1).params[1].before, nb.sig);
  w.ask(A, 3600); await w.run();
  assert.equal(w.samples(A).pts.length, 14, "once");
  w.close();
});

test("30b. reference rows: a parent's hourly row ending days before the points is fetched again (not today's price); past its end only recent points take today's; a SOL/USD row that is not ok fails the job (no unpriced final points) and is fetched again an hour later", async () => {
  // the parent A's (3600, usd) row was fetched 10 days ago; A has no stored trade
  const p = world();
  const sc = sampler(p, CH, CH_CURVE, { pu: 0.5 });
  const today = p.m.quoteUsdOf(A);
  assert.ok(today > 0 && today !== 0.25 && today !== 0.4, `today: ${today}`);
  const old = NOW - 10 * 86_400, stale = flat(old - 20 * 86_400, old - 3600, 3600, 0.25);
  const storeA = (w, fetchedAt) => w.db.histSet({ mint: A, res: 3600, unit: "usd", state: "ok", pools: [A_CURVE], covFrom: stale[0].t, covTo: old, fetchedAt, askedAt: fetchedAt, data: stale.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]) });
  storeA(p, old);
  p.pools.set(A_CURVE, { base: A, quote: SOL_MINT, usd: flat(NOW - 30 * 86_400, NOW, 3600, 0.4) });
  const pc = [sig("k1", 100, sc.B - 9 * 3600), sig("k2", 101, sc.B - 1000)].reverse();
  p.sigsOf.set(CH_CURVE, [sc.first, ...pc, sig("old", 1, sc.a - 100)]);
  pc.forEach((x) => p.txs.set(x.signature, curveTx(CH, x)));
  p.ask(CH); await p.run();
  assert.equal(p.fetch.of(A_CURVE).length, 1, "the parent's row fetched again");
  assert.deepEqual(p.samples(CH).pts.map((x) => r8(x[2] / x[1])), [0.4, 0.4], "priced from its fresh row");
  // the same row fetched within the hour (a 'none' answer kept its old end): no call; an old point is unpriced, a recent one takes today's
  const q = world();
  const sq = sampler(q, CH, CH_CURVE, { pu: 0.5 });
  storeA(q, NOW - 600);
  const qc = [sig("k1", 100, sq.B - 9 * 3600), sig("k2", 101, sq.B - 1000)].reverse();
  q.sigsOf.set(CH_CURVE, [sq.first, ...qc, sig("old", 1, sq.a - 100)]);
  qc.forEach((x) => q.txs.set(x.signature, curveTx(CH, x)));
  q.ask(CH); await q.run();
  const [q1, q2] = q.samples(CH).pts;
  assert.deepEqual([q.fetch.of(A_CURVE).length, q1[2], r8(q2[2] / q2[1])], [0, null, r8(today)]);
  // the SOL/USDC pool answers another pair: mismatch, the job fails and writes nothing; an hour later it is fetched again
  const w = world({ pools: new Map([[HIST_SOL_POOL, { base: SOL_MINT, quote: A, usd: flat(NOW - 1000 * 3600, NOW + 2 * 3600, 3600, 100) }]]) });
  const s = sampler(w, A2, A2_CURVE, { pu: 0.2 });
  w.sigsOf.set(A2_CURVE, [s.first, sig("f1", 100, s.B - 3000), sig("old2", 1, s.a - 100)]);
  w.txs.set("f1", curveTx(A2, sig("f1", 100, s.B - 3000)));
  w.ask(A2); await w.run();
  assert.deepEqual([w.row(SOL_MINT, 3600, "usd").state, w.samples(A2), w.hist.stats.failed], ["mismatch", null, 1]);
  w.pools.get(HIST_SOL_POOL).quote = USDC_MINT;
  w.clock.t += HIST_RETRY_MS;
  w.ask(A2); await w.run();
  assert.deepEqual([w.fetch.of(HIST_SOL_POOL).length, w.samples(A2), w.hist.stats.failed], [1, null, 2], "within the hour: no call, failed again");
  w.clock.t += 3600_000;
  w.ask(A2); await w.run();
  assert.equal(w.fetch.of(HIST_SOL_POOL).length, 2);
  assert.equal(r8(w.samples(A2).pts[0][2] / w.samples(A2).pts[0][1]), 100, "priced");
  p.close(); q.close(); w.close();
});

test("30c. a quote-keyed job's points carry USD, so the chart keyed USD later (its USD-less trades gone) shows them; a quiet parent's stored trades starting before the stretch still leave its hourly row fetched for the hours they do not price", async () => {
  const w = world();
  const s = sampler(w);
  const pts = [sig("v1", 100, s.B - 5000), sig("v2", 101, s.B - 3000)].reverse();
  w.sigsOf.set(A_CURVE, [s.first, ...pts, sig("old", 1, s.a - 100)]);
  pts.forEach((x) => w.txs.set(x.signature, curveTx(A, x)));
  assert.equal(w.ask(A).priceKey, "quote");
  await w.run();
  assert.equal(w.samples(A).state, "exact");
  // retention took the USD-less trades: the same coin's trades now all have USD
  w.db.db.prepare("DELETE FROM trades WHERE mint = ?").run(A);
  put(w.db, A, s.anchor, s.B, { pu: 0.2, slot: 50_000 });
  ownTrades(w.db, A, s.B + R, NOW - 60, { pu: 0.2 });
  w.ask(A); await w.run();
  const r = w.ask(A);
  assert.equal(r.priceKey, "usd");
  assert.equal(r.history?.chain, "exact", "the chain candles are in the USD chart");
  assert.equal(r.candles.filter((c) => c.t < Math.floor(s.B / R) * R).length, 2);
  // a parent with one stored trade before the stretch and one near its end: the point 9 h before B has none within 6 h
  const p = world();
  const sc = sampler(p, CH, CH_CURVE, { pu: 0.5 });
  put(p.db, A, "Aold", sc.a - 100, { pu: 0.3 }); put(p.db, A, "Anew", sc.B - 2000, { pu: 0.3 });
  p.pools.set(A_CURVE, { base: A, quote: SOL_MINT, usd: flat(NOW - 30 * 86_400, NOW, 3600, 0.25) });
  const pc = [sig("k1", 100, sc.B - 9 * 3600), sig("k2", 101, sc.B - 1000)].reverse();
  p.sigsOf.set(CH_CURVE, [sc.first, ...pc, sig("old", 1, sc.a - 100)]);
  pc.forEach((x) => p.txs.set(x.signature, curveTx(CH, x)));
  p.ask(CH); await p.run();
  const [k1, k2] = p.samples(CH).pts;
  assert.deepEqual([r8(k1[2] / k1[1]), r8(k2[2] / k2[1]), p.fetch.of(A_CURVE).length], [0.25, 0.3, 1]);
  // a parent stored every hour over the stretch: its stored prices do, no row is fetched
  const q = world();
  const sq = sampler(q, CH, CH_CURVE, { pu: 0.5 });
  ownTrades(q.db, A, sq.a - 3600, sq.B, { pu: 0.3 }, 3600, "Ah");
  q.pools.set(A_CURVE, { base: A, quote: SOL_MINT, usd: flat(NOW - 30 * 86_400, NOW, 3600, 0.25) });
  const qc = [sig("k1", 100, sq.B - 9 * 3600), sig("k2", 101, sq.B - 1000)].reverse();
  q.sigsOf.set(CH_CURVE, [sq.first, ...qc, sig("old", 1, sq.a - 100)]);
  qc.forEach((x) => q.txs.set(x.signature, curveTx(CH, x)));
  q.ask(CH); await q.run();
  assert.deepEqual([...q.samples(CH).pts.map((x) => r8(x[2] / x[1])), q.fetch.of(A_CURVE).length], [0.3, 0.3, 0]);
  w.close(); p.close(); q.close();
});

test("30d. a reference that fails, or ends days before the stretch, fails the job whatever the key: no final points without USD or at today's SOL price; retried after 10 min", async () => {
  // quote-keyed (USD-less trades): the SOL/USDC call fails → nothing written; once it answers, the points carry USD
  let down = true;
  const sol = flat(NOW - 1000 * 3600, NOW, 3600, 90);
  const w = world({ pools: new Map([[HIST_SOL_POOL, (p) => (down ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ data: { attributes: { ohlcv_list: sol.filter((c) => c.t <= p.before).sort((a, b) => b.t - a.t).slice(0, p.limit).map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]) } }, meta: { base: { address: SOL_MINT }, quote: { address: USDC_MINT } } }), { status: 200 }))]]) });
  const s = sampler(w);
  w.sigsOf.set(A_CURVE, [s.first, sig("v1", 100, s.B - 5000), sig("old", 1, s.a - 100)]);
  w.txs.set("v1", curveTx(A, sig("v1", 100, s.B - 5000)));
  assert.equal(w.ask(A).priceKey, "quote");
  await w.run();
  assert.deepEqual([w.samples(A), w.hist.stats.failed], [null, 1]);
  down = false;
  w.clock.t += HIST_RETRY_MS;
  w.ask(A); await w.run();
  assert.deepEqual([w.samples(A).state, r8(w.samples(A).pts[0][2] / w.samples(A).pts[0][1])], ["exact", 90]);
  // the stored SOL/USD row ends 3 days ago and the pool now answers 404 ('none' keeps the old end, fetched now): the job fails
  const v = world({ pools: new Map([[HIST_SOL_POOL, status(404)]]) });
  const old = flat(NOW - 40 * 86_400, NOW - 3 * 86_400 - 3600, 3600, 80);
  v.db.histSet({ mint: SOL_MINT, res: 3600, unit: "usd", state: "ok", pools: [HIST_SOL_POOL], covFrom: old[0].t, covTo: NOW - 3 * 86_400, fetchedAt: NOW - 7200, askedAt: NOW - 7200, data: old.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]) });
  const t = sampler(v, A2, A2_CURVE, { pu: 0.2 });
  v.sigsOf.set(A2_CURVE, [t.first, sig("f1", 100, t.B - 3000), sig("old2", 1, t.a - 100)]);
  v.txs.set("f1", curveTx(A2, sig("f1", 100, t.B - 3000)));
  v.ask(A2); await v.run();
  assert.deepEqual([v.fetch.of(HIST_SOL_POOL).length, v.row(SOL_MINT, 3600, "usd").cov_to, v.samples(A2), v.hist.stats.failed], [1, NOW - 3 * 86_400, null, 1]);
  w.close(); v.close();
});

test("30e. a parent's reference: a row whose curve call failed prices nothing before its start (asked again after 10 min); a busy parent's stored trades past an old row's end spare the call; a trade stored without USD does not hide an older priced one", async () => {
  // A's (3600, usd) row starts 10 h ago (the curve's call failed), fetched a minute ago: the point 13 h ago is unpriced, not the row's first open
  const short = flat(NOW - 10 * 3600, NOW - 7200, 3600, 0.4);
  const storeShort = (w, fetchedAt) => w.db.histSet({ mint: A, res: 3600, unit: "usd", state: "ok", pools: [A_CURVE], covFrom: NOW - 10 * 3600, covTo: NOW - 3600, fetchedAt, askedAt: fetchedAt, data: short.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]) });
  const child = (w) => {
    const sc = sampler(w, CH, CH_CURVE, { pu: 0.5 });
    w.pools.set(A_CURVE, { base: A, quote: SOL_MINT, usd: flat(NOW - 30 * 86_400, NOW, 3600, 0.25) });
    const pc = [sig("k1", 100, sc.B - 9 * 3600), sig("k2", 101, sc.B - 1000)].reverse();
    w.sigsOf.set(CH_CURVE, [sc.first, ...pc, sig("old", 1, sc.a - 100)]);
    pc.forEach((x) => w.txs.set(x.signature, curveTx(CH, x)));
    return sc;
  };
  // the job fails rather than store that point final without USD; 10 min later the row is asked again and prices it
  const p = world();
  child(p); storeShort(p, NOW - 60);
  p.ask(CH); await p.run();
  assert.deepEqual([p.fetch.of(A_CURVE).length, p.samples(CH), p.hist.stats.failed], [0, null, 1]);
  p.clock.t += HIST_RETRY_MS;
  p.ask(CH); await p.run();
  assert.deepEqual([p.fetch.of(A_CURVE).length, ...p.samples(CH).pts.map((x) => r8(x[2] / x[1]))], [1, 0.25, 0.25]);
  // A graduated: its row fetched now, the pool's page came back but the curve's call met a 429 (a short row): the job fails too
  const v = world();
  const A_POOL = key(124);
  v.m.upsertCoin({ mint: A, migrated: true, complete: true, pool: A_POOL });
  child(v);
  v.pools.set(A_POOL, { base: A, quote: SOL_MINT, usd: flat(NOW - 10 * 3600, NOW, 3600, 0.4) });
  v.pools.set(A_CURVE, status(429));
  v.ask(CH); await v.run();
  assert.deepEqual([v.fetch.of(A_POOL).length, v.fetch.of(A_CURVE).length, v.row(A, 3600, "usd").state, v.samples(CH), v.hist.stats.failed], [1, 1, "ok", null, 1]);
  v.close();
  // the same row 10 min old: asked again, and the whole stretch is priced from it
  const q = world();
  child(q); storeShort(q, NOW - HIST_RETRY_MS / 1000);
  q.ask(CH); await q.run();
  assert.deepEqual([q.fetch.of(A_CURVE).length, ...q.samples(CH).pts.map((x) => r8(x[2] / x[1]))], [1, 0.25, 0.25]);
  // A's row ends 10 h ago, fetched 2 h ago; A's stored trades price every hour since: no call charged to A
  const u = world();
  child(u);
  const lo = Math.floor((NOW - 500 * 3600) / 3600) * 3600, early = flat(lo, NOW - 11 * 3600, 3600, 0.25);
  u.db.histSet({ mint: A, res: 3600, unit: "usd", state: "ok", pools: [A_CURVE], covFrom: lo, covTo: NOW - 10 * 3600, fetchedAt: NOW - 7200, askedAt: NOW - 7200, data: early.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]) });
  ownTrades(u.db, A, NOW - 11 * 3600, NOW - 60, { pu: 0.3 }, 3600, "Ah");
  u.ask(CH); await u.run();
  assert.deepEqual([u.fetch.of(A_CURVE).length, ...u.samples(CH).pts.map((x) => r8(x[2] / x[1]))], [0, 0.25, 0.3]);
  // A's trades price the stretch, one stored without USD among them: the point after it takes the priced one before it
  const r = world();
  const sc = sampler(r, CH, CH_CURVE, { pu: 0.5 });
  r.pools.set(A_CURVE, { base: A, quote: SOL_MINT, usd: flat(NOW - 30 * 86_400, NOW, 3600, 0.25) });
  for (const [i, h] of [-60 / 3600, 4, 5, 10, 15].entries()) put(r.db, A, `P${i}`, sc.a + h * 3600, { pu: 0.3 });
  put(r.db, A, "N1", sc.a + 4.5 * 3600, { pu: null });
  const k = sig("k1", 100, sc.a + 4.7 * 3600);
  r.sigsOf.set(CH_CURVE, [sc.first, k, sig("old", 1, sc.a - 100)]);
  r.txs.set("k1", curveTx(CH, k));
  r.ask(CH); await r.run();
  assert.deepEqual([r.fetch.of(A_CURVE).length, r8(r.samples(CH).pts[0][2] / r.samples(CH).pts[0][1])], [0, 0.3]);
  p.close(); q.close(); u.close(); r.close();
});

test("31b. an extension stopped by an outage keeps to_t and the stored points, and its retry is the extension (the stretch appended); points older than the 1 h chart's window are dropped", async () => {
  let down = false;
  const w = world({ onCall: (method) => { if (down && method === "getSignaturesForAddress") throw new Error("socket hang up"); } });
  const s = sampler(w, A, A_CURVE, { created: NOW - 5 * 86_400, B: NOW - 2 * 86_400 });
  const old = spread("q", 10, s.a + 3600, s.B - 3600);
  w.sigsOf.set(A_CURVE, [s.first, ...old, sig("old", 1, s.a - 100)]);
  old.forEach((x) => w.txs.set(x.signature, curveTx(A, x)));
  w.ask(A, 3600); await w.run();
  const first = w.samples(A);
  assert.deepEqual([first.state, first.pts.length, first.to_t], ["exact", 10, s.B]);
  w.clock.t += HIST_SAMPLE_EXTEND_S * 1000;
  w.db.db.prepare("DELETE FROM trades WHERE mint = ? AND time < ?").run(A, s.B + 5 * 3600);
  const nb = w.db.tradeAfter(A, -1);
  const gap = spread("r", 4, s.B, nb.time - 60, 60_000);
  w.sigsOf.set(A_CURVE, [sig(nb.sig, 70_000, nb.time), ...gap, ...old.slice(0, 2)]);
  gap.forEach((x) => w.txs.set(x.signature, curveTx(A, x)));
  down = true;
  w.ask(A, 3600); await w.run();
  w.ask(A, 3600); await w.run();
  const cut = w.samples(A);
  assert.deepEqual([cut.to_t, cut.pts.length, cut.state, cut.retry_at], [s.B, 10, "exact", w.nowS() + HIST_PARTIAL_RETRY_S], "to_t stays: [to_t, B) was not read");
  // the retry is the extension again (not a re-run of the whole hole): it reads [to_t, B) and appends
  down = false;
  w.clock.t += HIST_PARTIAL_RETRY_S * 1000;
  const listed = listings(w.chain).length;
  w.ask(A, 3600); await w.run();
  const done = w.samples(A);
  assert.deepEqual([done.to_t, done.pts.length, done.retry_at, done.state], [nb.time, 14, 0, "exact"]);
  assert.deepEqual(listings(w.chain).slice(listed).map((c) => c.params[1].before), [nb.sig], "one listing, from the new anchor");
  w.close();
  // a day on, the extension drops the points before the 1 h chart's window
  const v = world();
  const t = sampler(v, A, A_CURVE, { created: NOW - 30 * 86_400, B: NOW - 2 * 86_400 });
  const a = NOW - 500 * 3600, early = spread("q", 10, a + 3600, a + 11 * 3600);
  v.sigsOf.set(A_CURVE, [t.first, ...early, sig("old", 1, a - 100)]);
  early.forEach((x) => v.txs.set(x.signature, curveTx(A, x)));
  v.ask(A, 3600); await v.run();
  assert.deepEqual([v.samples(A).pts.length, v.samples(A).from_t], [10, a]);
  v.clock.t += HIST_SAMPLE_EXTEND_S * 1000;
  v.db.db.prepare("DELETE FROM trades WHERE mint = ? AND time < ?").run(A, t.B + 5 * 3600);
  const nv = v.db.tradeAfter(A, -1), gv = spread("r", 4, t.B, nv.time - 60, 60_000);
  v.sigsOf.set(A_CURVE, [sig(nv.sig, 70_000, nv.time), ...gv]);
  gv.forEach((x) => v.txs.set(x.signature, curveTx(A, x)));
  v.ask(A, 3600); await v.run();
  v.ask(A, 3600); await v.run();
  const floor = v.nowS() - 500 * 3600;
  assert.deepEqual([v.samples(A).pts.length, v.samples(A).from_t, v.samples(A).to_t], [4, floor, nv.time]);
  v.close();
});

test("31c. a final partial row (its listing cut) whose extension an outage stopped: the retry is that extension, not a re-run of the hole", async () => {
  let down = false;
  const w = world({ onCall: (method) => { if (down && method === "getSignaturesForAddress") throw new Error("socket hang up"); } });
  const s = sampler(w, A, A_CURVE, { created: NOW - 5 * 86_400, B: NOW - 2 * 86_400 });
  const old = spread("q", 10, s.a + 3600, s.B - 3600);
  w.sigsOf.set(A_CURVE, [s.first, ...old, sig("old", 1, s.a - 100)]);
  old.forEach((x) => w.txs.set(x.signature, curveTx(A, x)));
  w.ask(A, 3600); await w.run();
  // as a job cut at its listing pages leaves it: partial, final
  const r0 = w.db.samplesGet(A);
  w.db.samplesSet({ mint: A, state: "partial", fromT: r0.from_t, toT: r0.to_t, calls: r0.calls, at: r0.at, askedAt: r0.asked_at, retryAt: 0, data: r0.data });
  w.hist.cache.clear();
  w.clock.t += HIST_SAMPLE_EXTEND_S * 1000;
  w.db.db.prepare("DELETE FROM trades WHERE mint = ? AND time < ?").run(A, s.B + 5 * 3600);
  const nb = w.db.tradeAfter(A, -1);
  const gap = spread("r", 4, s.B, nb.time - 60, 60_000);
  w.sigsOf.set(A_CURVE, [sig(nb.sig, 70_000, nb.time), ...gap, ...old.slice(0, 2)]);
  gap.forEach((x) => w.txs.set(x.signature, curveTx(A, x)));
  down = true;
  w.ask(A, 3600); await w.run();
  w.ask(A, 3600); await w.run();
  const cut = w.samples(A);
  assert.deepEqual([cut.to_t, cut.pts.length, cut.state, cut.retry_at, cut.retry_ext], [s.B, 10, "partial", w.nowS() + HIST_PARTIAL_RETRY_S, 1]);
  down = false;
  w.clock.t += HIST_PARTIAL_RETRY_S * 1000;
  w.ask(A, 3600); await w.run();
  const done = w.samples(A);
  assert.deepEqual([done.to_t, done.pts.length, done.retry_at, done.retry_ext, done.state], [nb.time, 14, 0, 0, "partial"]);
  w.close();
});

test("32. migrated sampling: pool and curve listed from one anchor; the curve's last and the pool's first signatures are among the picks", async () => {
  const w = world({ slotOf: new Map([[`FIRST-${G}`, 50_000]]) });
  const s = sampler(w, G, G_CURVE);
  const mid = s.a + Math.floor((s.B - s.a) / 2);
  const pool = spread("P", 200, mid, s.B - 600, 20_000), curve = spread("C", 200, s.a + 600, mid - 600, 10_000);
  w.sigsOf.set(G_POOL, [s.first, ...pool]);
  w.sigsOf.set(G_CURVE, [...curve, sig("cold", 1, s.a - 100)]);
  const at = new Map([...pool, ...curve].map((x) => [x.signature, x]));
  w.txs.get = (x) => (at.has(x) ? (x.startsWith("P") ? txOf(frame(AMM, poolEvent("BuyEvent", W, { pool: G_POOL, at: at.get(x).blockTime })), { slot: at.get(x).slot, blockTime: at.get(x).blockTime }) : curveTx(G, at.get(x))) : undefined);
  w.ask(G); await w.run();
  assert.deepEqual(listings(w.chain).slice(0, 2).map((c) => [c.params[0], c.params[1].before]), [[G_POOL, s.anchor], [G_CURVE, s.anchor]]);
  const read = new Set(reads(w.chain).map((c) => c.params[0]));
  assert.ok(read.has(curve[0].signature), "the curve's newest");
  assert.ok(read.has(pool.at(-1).signature), "the pool's oldest");
  assert.equal(w.samples(G).state, "sampled");
  w.close();
});

test("33. restart: a new ChartHistory on the same db serves stored rows as done without a call; a partial row past its retry_at runs again on the next ask", async () => {
  const w = world();
  const s = sampler(w);
  w.sigsOf.set(A_CURVE, [s.first, ...spread("z", 30, s.a + 600, s.B - 600), sig("old", 1, s.a - 100)]);
  let fail = true;
  w.txs.get = (x) => (x.startsWith("z") ? (fail ? () => new Error("down") : curveTx(A, sig(x, 1000, s.a + 1000))) : undefined);
  w.ask(A); await w.run();
  assert.equal(w.samples(A).state, "partial");
  w.hist.stop();
  const calls = [w.fetch.calls.length, w.chain.calls.length];
  const next = w.make();
  w.hist = next;
  assert.equal(w.ask(A).history, undefined, "done, nothing to credit");
  await w.run();
  assert.deepEqual([w.fetch.calls.length, w.chain.calls.length], calls);
  w.clock.t += HIST_PARTIAL_RETRY_S * 1000;
  fail = false;
  w.ask(A); await w.run();
  assert.equal(w.samples(A).state, "exact");
  assert.equal(w.ask(A).history.chain, "exact");
  w.close();
});

test("34. prune: unasked 14 days → gone; over 5 000 rows the least recently asked go; asked_at written at most hourly; the SOL row stays while samples are recent", async () => {
  const w = world({ sample: false });
  recorded(w);
  w.ask(A); await w.run();
  const touched = () => w.hist.stats.touched;
  w.clock.t += (HIST_TOUCH_S - 1) * 1000; w.ask(A);
  assert.equal(touched(), 0);
  w.clock.t += 1000; w.ask(A); w.ask(A);
  assert.equal(touched(), 1);
  assert.equal(w.row(A, R, "usd").asked_at, w.nowS());
  // the SOL row and a samples row written lately
  const row = (mint, res, askedAt) => ({ mint, res, unit: "usd", state: "none", pools: [], covFrom: 0, covTo: 0, fetchedAt: askedAt, askedAt, data: [] });
  w.db.histSet(row(SOL_MINT, 3600, w.nowS() - HIST_KEEP_S - 10));
  w.db.samplesSet({ mint: A2, state: "quiet", fromT: 0, toT: 0, at: w.nowS() - 100, askedAt: w.nowS() - 100, data: [] });
  w.db.histSet(row(A2, 300, w.nowS() - HIST_KEEP_S - 10));
  assert.equal(w.hist.prune(), 1);
  assert.ok(w.row(SOL_MINT, 3600, "usd"), "kept: samples are recent");
  assert.equal(w.row(A2, 300, "usd"), null);
  w.clock.t += (HIST_KEEP_S + 1) * 1000;
  assert.equal(w.hist.prune(), 3, "A's row, the samples row, and the SOL row once no samples row is recent");
  // over the cap
  w.db.transaction(() => { for (let i = 0; i < HIST_MAX_ROWS + 2; i++) w.db.histSet(row(key2(220, i % 250) + "", 60 + (Math.floor(i / 250)), w.nowS() - 10_000 + i)); });
  assert.equal(w.hist.prune(), 2);
  assert.equal(w.db.histCounts().history, HIST_MAX_ROWS);
  assert.equal(w.db.histGet(key2(220, 0), 60, "usd"), null, "the least recently asked went");
  w.close();
});

test("35. health: every §15 field is there; 429, mismatch, quiet, partial and yielded are counted", async () => {
  let polls = 0;
  const w = world({ now: Math.floor(Date.now() / 1000), busy: () => ++polls === 1 });
  const s = sampler(w, A2, A2_CURVE, { created: w.nowS() - 20 * 3600, B: w.nowS() - 4 * 3600 });
  w.sigsOf.set(A2_CURVE, [s.first, sig("old", 1, s.a - 100)]);
  recorded(w, A, A_CURVE); w.pools.set(A_CURVE, status(429, { "retry-after": "1" }));
  recorded(w, G, G_CURVE); w.pools.set(G_CURVE, { base: G, quote: USDC_MINT, usd: flat(w.nowS() - 20 * 3600, w.nowS(), R, 0.2) });
  const p = sampler(w, U, U_CURVE, { created: w.nowS() - 20 * 3600, B: w.nowS() - 4 * 3600 });
  w.sigsOf.set(U_CURVE, [p.first, ...spread("h", 40, p.a + 600, p.B - 600)]);
  w.txs.get = (x) => (x.startsWith("h") ? () => new Error("down") : undefined);
  for (const m of [A, G, A2, U]) w.ask(m);
  await w.run();
  const app = await serveApp(w);
  try {
    const h = (await app.get("/api/health")).body.history;
    for (const f of ["enabled", "sample", "queue", "running", "chainQueue", "chainRunning", "pausedMs", "gecko", "chain", "stats", "rows", "pruned"]) assert.ok(f in h, f);
    for (const f of ["callsToday", "daily", "perMin", "waiting", "pausedMs", "calls", "ok", "notFound", "rateLimited", "errors", "timeouts", "tooLarge", "badJson", "refused", "dropped", "lastMs", "lastError"]) assert.ok(f in h.gecko, `gecko.${f}`);
    for (const f of ["callsToday", "daily", "listed", "anchorMisses", "txRead", "txRetries", "txUnread", "points", "outages", "budgetStops", "jobCaps", "yielded"]) assert.ok(f in h.chain, `chain.${f}`);
    for (const f of ["asked", "queued", "displaced", "limited", "refusedBudget", "refusedCoinCap", "fetched", "extended", "ok", "none", "mismatch", "seamMismatch", "seamWarn", "badCandles", "unaligned", "holes", "quiet", "exact", "sampled", "partial", "skippedUsd", "unpriced", "failed", "lastError"]) assert.ok(f in h.stats, `stats.${f}`);
    // quiet: A2, and G (its mismatch row is a hole; nothing on chain either)
    assert.deepEqual([h.gecko.rateLimited, h.stats.mismatch >= 1, h.stats.quiet, h.stats.partial, h.chain.yielded, h.chain.outages], [1, true, 2, 1, 1, 1]);
    assert.ok(h.rows.history >= 3 && h.rows.samples === 3, JSON.stringify(h.rows));
  } finally { await app.close(); w.close(); }
});

test("36. lane: every chain call goes to the rpc handed in; ChartHistory asks it for no other lane", async () => {
  const w = world({ rpcExtra: { lane: () => { throw new Error("no other lane"); }, laneSnapshot: () => { throw new Error("no"); } } });
  const s = sampler(w);
  const list = spread("l", 30, s.a + 600, s.B - 600);
  w.sigsOf.set(A_CURVE, [s.first, ...list, sig("old", 1, s.a - 100)]);
  list.forEach((x) => w.txs.set(x.signature, curveTx(A, x)));
  w.ask(A); await w.run();
  assert.equal(w.hist.rpc, w.rpc);
  assert.equal(w.samples(A).state, "exact");
  assert.equal(w.chain.calls.length, w.hist.snapshot().chain.callsToday);
  assert.ok(w.chain.calls.every((c) => c.opts?.signal && c.opts.timeoutMs > 0), "the fill lane's read options");
  w.close();
});
