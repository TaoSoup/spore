// Wake-ups (lib/wakeups.mjs): the WAKE rule's edges (buyers, coins, $1 buys, the 5x baseline over exactly 288
// buckets or the buckets observed, the 6 h of history before anything fires, an existing child at the 30-minute line,
// the 3 h alert gap and the silent relisting), the boot seed (no event, the 3 h rule kept, a steadily busy family not
// listed), filled trades, live/cooling/dropped timing (current baseline, 2 h live, 6 h cap), the creator facts and the
// recorded launch flow, the post and copyOf, sinceStart and mcapUsd, the list order and its caps, the quiet answer
// (no coin nobody bought), one SSE event per wake-up, GET /api/discover(/:mint), and the per-trade cost of a 50 000-
// trade burst. A fake clock and sqlite in memory. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Wakeups, BUCKET_S, BASE_BUCKETS, REFIRE_S, DROP_S, GRACE_S, LIST_MAX, COINS_MAX, WAKE_TTL_MS, SET_MAX, MIN_SEEN, FACT_UNKNOWN_MS, DEAD_SOLD_S, QUIET_SCAN } from "../lib/wakeups.mjs";
import { Narrative, postUrl, postTime } from "../lib/narrative.mjs";
import { createApp } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { SOL_MINT } from "../lib/jupiter.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";
import { fakeClock } from "./helpers/chain.mjs";

const B = BUCKET_S, DAY = 86_400, HOUR = 3_600;
/** A bucket edge: bucket K0 is [NOW_S, NOW_S + 300). */
const NOW_S = 1_770_000_000, K0 = NOW_S / B;
const OLD = NOW_S - 2 * DAY;
/** Mint number `i` of a made-up series (`fill` tells series apart). */
const mintN = (i, fill = 6) => { const b = Buffer.alloc(32, fill); b.writeUInt32BE(i, 28); return new PublicKey(b).toBase58(); };
/** A post id made at `s` (unix s; snowflake: ms since X's epoch << 22); `n` tells ids of one moment apart. */
const idAt = (s, n = 0) => String(((BigInt(s * 1000) - 1288834974657n) << 22n) + BigInt(n));
const link = (id) => `https://x.com/anyone/status/${id}`;
const PAR = mintN(1, 1), PAR2 = mintN(2, 1);

/**
 * A model on a fake clock with PAR (a SOL coin) and an events recorder as the hub. `seen`: the trade stream counts as
 * watched since well over a day before K0 (no bucket fires before 6 h of it); false leaves it to the first trade.
 */
function world({ hub = null, parent = true, at = NOW_S, seen = true } = {}) {
  const clock = fakeClock(at * 1000), db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", now: clock.now, log: quiet });
  model.load(); model.setSolUsd(100);
  if (seen) model.wakeups.firstK = K0 - BASE_BUCKETS - 100;
  const events = [];
  model.wakeups.attach({ hub: hub ?? { emit: (e, d) => events.push([e, d]) } });
  let seq = 0;
  const w = { clock, db, model, wk: model.wakeups, events };
  w.wakes = () => events.filter((e) => e[0] === "wake");
  /** A coin; `parent` null makes a SOL root (quote mint null, as pump.fun's first curves). */
  w.coin = (mint, symbol, { parent = PAR, createdAt = OLD, launcher = null, post = null, tracked = true } = {}) => {
    model.upsertCoin({ mint, curve: `C_${mint.slice(0, 8)}`, depth: parent ? 1 : 0, quoteMint: parent, ...base, virtualQuoteReserves: parent ? "1000000000000000" : "100000000000", createdAt, launcher, tracked });
    model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, uri: `https://ipfs.io/ipfs/${mint}`, onchainAt: 1 });
    model.setMeta(`https://ipfs.io/ipfs/${mint}`, { image: `https://ipfs.io/ipfs/img-${symbol}`, description: null, twitter: post, telegram: null, website: null, fetchedAt: 1, ok: true });
    return mint;
  };
  /** One live trade. */
  w.trade = (mint, user, time, { usd = 5, isBuy = true, baseAmount = "1000", priceUsd = 1e-5 } = {}) =>
    model.recordTrade({ sig: `S${seq++}`, mint, idx: 0, slot: seq, time, isBuy, user, baseAmount, quoteAmount: "1", priceQuote: 1e-3, priceUsd, valueUsd: usd });
  /** `n` distinct buyers (`tag` + i) in bucket `k`, spread over `coins` in turn. */
  w.burst = (k, n, coins, { tag = "u", usd = 5 } = {}) => { for (let i = 0; i < n; i++) w.trade(coins[i % coins.length], `${tag}${i}`, k * B + (i % (B - 10)), { usd }); };
  /** The list body as of unix s `s` (the cache bypassed). */
  w.list = async (s) => { clock.t = s * 1000; w.wk.hit = null; return w.wk.serve(); };
  w.close = () => { w.wk.stop(); db.close(); };
  if (parent) w.coin(PAR, "PAR", { parent: null, createdAt: OLD - DAY });
  return w;
}
/** A world with PAR's three existing children E0-E2. */
function three(opts) {
  const w = world(opts);
  w.E = [0, 1, 2].map((i) => w.coin(mintN(100 + i), `E${i}`));
  return w;
}
const closeAt = (k) => (k + 1) * B + GRACE_S; // the tick that closes bucket k
const OPTS = { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet };
/** A stored row, as the next boot reads it (`keep` lifts the per-mint trim, which goes by the real clock). */
const row = (db, sig, mint, time, { user = "s", isBuy = true, usd = 5, baseAmount = "1", priceUsd = 1e-5 } = {}) =>
  db.insertTrade({ sig, mint, idx: 0, slot: 1, time, isBuy, user, baseAmount, quoteAmount: "1", priceQuote: 1e-3, priceUsd, valueUsd: usd }, 1e9);

test("the WAKE rule: 50 distinct buyers of existing children, over 3 coins, buys of $1 and up; one wallet counts once", () => {
  const fired = (setup) => { const w = three(); setup(w); w.wk.tick(closeAt(K0)); const n = w.wakes().length; w.close(); return n; };
  assert.equal(fired((w) => w.burst(K0, 50, w.E)), 1, "50 buyers over 3 coins, baseline 0");
  assert.equal(fired((w) => w.burst(K0, 49, w.E)), 0, "49 buyers");
  assert.equal(fired((w) => w.burst(K0, 50, w.E.slice(0, 2))), 0, "two coins");
  assert.equal(fired((w) => { w.burst(K0, 50, w.E.slice(0, 2)); w.trade(w.E[2], "seller", K0 * B + 5, { isBuy: false }); }), 0, "a sell is no buy of the third coin");
  assert.equal(fired((w) => { w.burst(K0, 49, w.E); w.trade(w.E[0], "small", K0 * B + 5, { usd: 0.99 }); }), 0, "a buy under $1 is not counted");
  assert.equal(fired((w) => { w.burst(K0, 49, w.E); w.trade(w.E[0], "even", K0 * B + 5, { usd: 1 }); }), 1, "$1 is");
  assert.equal(fired((w) => { w.burst(K0, 49, w.E); for (const e of w.E) w.trade(e, "u0", K0 * B + 7); }), 0, "a wallet buying three coins is one buyer");
  assert.equal(fired((w) => { w.burst(K0, 49, w.E); w.coin(mintN(200), "NULLAT", { createdAt: null }); w.trade(mintN(200), "x", K0 * B + 1); }), 1, "a child with no creation time is existing");
  assert.equal(fired((w) => { const o = w.coin(mintN(201), "OTHER", { parent: PAR2 }); w.burst(K0, 49, w.E); w.trade(o, "x", K0 * B + 1); }), 0, "a buyer under another parent counts there");
  assert.equal(fired((w) => { const r = [0, 1, 2].map((i) => w.coin(mintN(300 + i), `R${i}`, { parent: SOL_MINT })); w.burst(K0, 60, r); }), 0, "SOL's mint is no parent");
  assert.equal(fired((w) => { const r = [0, 1, 2].map((i) => w.coin(mintN(300 + i), `R${i}`, { parent: null })); w.burst(K0, 60, r); }), 0, "nor are roots without a quote mint");
});

test("the WAKE rule: a child launched more than 30 min before the bucket starts is existing; at exactly 30 min it is new", () => {
  const run = (createdAt) => {
    const w = three();
    const c = w.coin(mintN(110), "C30", { createdAt });
    // 20 + 20 buyers of two old coins, 10 of the coin at the line: existing only if it counts
    for (let i = 0; i < 20; i++) { w.trade(w.E[0], `a${i}`, K0 * B + i); w.trade(w.E[1], `b${i}`, K0 * B + i); }
    for (let i = 0; i < 10; i++) w.trade(c, `c${i}`, K0 * B + i);
    w.wk.tick(closeAt(K0));
    const n = w.wakes().length; w.close(); return n;
  };
  assert.equal(run(K0 * B - 1801), 1, "1 801 s before the bucket starts: existing (50 buyers, 3 coins)");
  assert.equal(run(K0 * B - 1800), 0, "1 800 s: new, its buyers are not counted (40 buyers, 2 coins)");
});

test("the WAKE rule: 5x the trailing 24 h mean, the 288 buckets before (empty ones count as 0)", () => {
  // the ratios of the wake-ups bucket K0 starts (a heavy bucket in the history fires on its own)
  const run = (setup, n = 50) => { const w = three(); setup(w); w.burst(K0, n, w.E); w.wk.tick(closeAt(K0)); const r = w.wakes().filter((e) => e[1].startedAt === (K0 + 1) * B).map((e) => e[1].ratio); w.close(); return r; };
  const daily = (per) => (w) => { for (let j = BASE_BUCKETS; j >= 1; j--) w.burst(K0 - j, per, w.E, { tag: `h${j}-` }); };
  assert.deepEqual(run(daily(10)), [5], "10 per bucket: 50 is exactly 5x");
  assert.deepEqual(run(daily(11)), [], "11 per bucket: 50 is under 55");
  assert.deepEqual(run(daily(11), 55), [5], "55 is 5x");
  // one heavy bucket: 2 881 buyers are a mean of 10.003 while inside the 288, nothing once the bucket is 289 back
  assert.deepEqual(run((w) => w.burst(K0 - BASE_BUCKETS, 2881, w.E)), [], "288 buckets back: inside the window");
  assert.deepEqual(run((w) => w.burst(K0 - BASE_BUCKETS - 1, 2881, w.E)), [50], "289 back: outside (ratio against a floor of 1)");
});

test("nothing fires before 6 h of trades were observed; the baseline is the mean over the buckets observed", () => {
  const run = (setup, n = 60) => { const w = three({ seen: false }); setup(w); w.burst(K0, n, w.E, { tag: "x" }); w.wk.tick(closeAt(K0)); const r = w.wakes().map((e) => e[1].ratio); w.close(); return r; };
  assert.deepEqual(run(() => {}), [], "the burst is the first trade seen");
  // the first trade seen (any coin, here the parent itself) 71 or 72 buckets before
  assert.deepEqual(run((w) => w.trade(PAR, "p", (K0 - MIN_SEEN + 1) * B)), [], "71 buckets of history");
  assert.deepEqual(run((w) => w.trade(PAR, "p", (K0 - MIN_SEEN) * B)), [60], "72: a parent quiet in all of them");
  // 12 per bucket over the 100 observed: a mean of 12 (over 288 it would read 4.2), so 60 is 5x and 59 is not
  const busy = (w) => { for (let j = 100; j >= 1; j--) w.burst(K0 - j, 12, w.E, { tag: `h${j}-` }); };
  assert.deepEqual(run(busy), [5]);
  assert.deepEqual(run(busy, 59), []);
});

test("a firing bucket keeps the wake-up going; after it was dropped one lists the family again, alerting only 3 h after the last alert", () => {
  // [alerts (startedAt), the wake-up listed (startedAt)]
  const run = (ks) => { const w = three(); for (const k of ks) w.burst(k, 50, w.E, { tag: `k${k}-` }); w.wk.tick(closeAt(ks.at(-1))); const r = [w.wakes().map((e) => e[1].startedAt), [...w.wk.waking].map((P) => P.wake.startedAt)]; w.close(); return r; };
  const T1 = (K0 + 1) * B;
  assert.deepEqual(run([K0, K0 + 1, K0 + 12, K0 + 30]), [[T1], [T1]], "firing buckets inside the wake-up: one");
  // dropped 2 h after its last hot bucket (T1): a burst ending 10 500 s after the alert is listed without one, 10 800 s after with one
  assert.deepEqual(run([K0, K0 + 35]), [[T1], [(K0 + 36) * B]]);
  assert.deepEqual(run([K0, K0 + 36]), [[T1, (K0 + 37) * B], [(K0 + 37) * B]]);
  assert.equal((K0 + 37) * B - T1, REFIRE_S);
});

test("bursts at 0, +2.5 h and +5 h: listed after each one, alerted at 0 and +5 h", async () => {
  const w = three();
  const out = [];
  for (const k of [K0, K0 + 30, K0 + 60]) { w.burst(k, 50, w.E, { tag: `k${k}-` }); out.push((await w.list(closeAt(k))).families.map((f) => [f.startedAt, f.state])); }
  assert.deepEqual(out, [[[(K0 + 1) * B, "live"]], [[(K0 + 31) * B, "live"]], [[(K0 + 61) * B, "live"]]]);
  assert.deepEqual([w.wakes().map((e) => e[1].startedAt), w.wk.snapshot().relisted], [[(K0 + 1) * B, (K0 + 61) * B], 1]);
  w.close();
});

test("a family that stays busy for 20 h: judged against its current baseline, live 2 h at most, dropped 6 h after its start, never woken by its new normal", async () => {
  const w = three();
  const seen = [];
  for (let j = 0; j < 240; j++) {
    const k = K0 + j;
    for (let i = 0; i < 60; i++) w.wk.record({ mint: w.E[i % 3], time: k * B + i, isBuy: true, valueUsd: 5, user: `u${i}` });
    if ([12, 36, 71, 72, 239].includes(j)) seen.push([j, ...(await w.list(closeAt(k))).families.map((f) => [f.state, f.ratio, f.baseline])]);
  }
  // at +12 the 12 buckets of 60 before are a mean of 2.5 (over 288): 24x; at +36 still firing (60 >= 5 x 7.5) but over 2 h old
  assert.deepEqual(seen, [[12, ["live", 24, 2.5]], [36, ["cooling", 8, 7.5]], [71, ["cooling", 4.1, 14.8]], [72], [239]]);
  assert.equal(w.wakes().length, 1);
  w.close();
});

test("live, cooling and dropped: live while the latest complete bucket is 3x the baseline, listed until 2 h after the last such bucket", async () => {
  const w = three();
  const at = async (s) => (await w.list(s)).families.map((f) => [f.state, f.ratio, f.buyers5m]);
  w.burst(K0, 50, w.E);
  assert.deepEqual(await at((K0 + 1) * B + 1), [], "the firing bucket is not closed within the grace (5 s)");
  assert.deepEqual(await at(closeAt(K0)), [["live", 50, 50]]);
  w.burst(K0 + 1, 3, w.E, { tag: "v" }); // 3x the floored baseline (0 → 1)
  assert.deepEqual(await at(closeAt(K0 + 1)), [["live", 3, 3]], "3 buyers: still 3x");
  w.burst(K0 + 2, 2, w.E, { tag: "z" });
  assert.deepEqual(await at(closeAt(K0 + 2)), [["cooling", 2, 2]], "2 buyers: cooling");
  assert.deepEqual(await at(closeAt(K0 + 3)), [["cooling", 0, 0]], "a bucket without a trade reads 0");
  const hot = (K0 + 2) * B; // the end of the last bucket at 3x
  assert.deepEqual(await at(hot + DROP_S - 1), [["cooling", 0, 0]]);
  assert.deepEqual(await at(hot + DROP_S), [], "2 h after it: dropped");
  assert.deepEqual([w.wk.waking.size, w.wakes().length], [0, 1]);
  // a wake-up the tick never dropped is not revived by a later bucket of the parent (2 h past its last hot bucket)
  const v = three();
  v.burst(K0, 50, v.E);
  v.wk.tick(closeAt(K0));
  v.burst(K0 + 30, 3, v.E); v.burst(K0 + 31, 1, v.E);
  assert.equal(v.wk.waking.size, 0);
  v.close(); w.close();
});

test("the boot seed: the last 24 h is counted with no event; a wake-up found in it is listed and the 3 h rule holds", async () => {
  const w = three();
  // stored rows only (a replayed day), as the next boot reads them: the parent's own trade 100 buckets before is where the history starts
  row(w.db, "W0", PAR, (K0 - 100) * B);
  for (let i = 0; i < 60; i++) w.db.insertTrade({ sig: `D${i}`, mint: w.E[i % 3], idx: 0, slot: i, time: K0 * B + i, isBuy: true, user: `s${i}`, baseAmount: "1", quoteAmount: "1", priceQuote: 1e-3, priceUsd: 1e-5, valueUsd: 5 });
  assert.equal(w.wakes().length, 0);
  const clock = fakeClock(((K0 + 2) * B + 10) * 1000);
  const again = new Model(w.db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", now: clock.now, log: quiet });
  const events = [];
  again.wakeups.attach({ hub: { emit: (e, d) => events.push([e, d]) } });
  again.load();
  const s = again.wakeups.snapshot();
  assert.deepEqual([events.length, s.seededWakes, s.started, s.seedRows, s.trades, s.seedMs >= 0], [0, 1, 0, 60, 0, true], "seeded: no event");
  const body = await again.wakeups.serve();
  assert.deepEqual(body.families.map((f) => [f.parent.mint, f.startedAt, f.state]), [[PAR, (K0 + 1) * B, "cooling"]]);
  // live buying 30 min later fires again, inside 3 h of the seeded firing: no new wake-up, no event
  let seq = 0;
  for (let i = 0; i < 50; i++) again.recordTrade({ sig: `L${seq++}`, mint: w.E[i % 3], idx: 0, slot: 1000 + i, time: (K0 + 6) * B + i, isBuy: true, user: `n${i}`, baseAmount: "1", quoteAmount: "1", priceQuote: 1e-3, priceUsd: 1e-5, valueUsd: 5 });
  again.wakeups.tick(closeAt(K0 + 6));
  assert.deepEqual([events.length, again.wakeups.snapshot().started], [0, 0]);
  clock.t = closeAt(K0 + 6) * 1000;
  again.wakeups.hit = null;
  assert.deepEqual((await again.wakeups.serve()).families.map((f) => [f.startedAt, f.state, f.buyers5m]), [[(K0 + 1) * B, "live", 50]]);
  w.close();
});

test("the boot seed: a family as busy all day as now is not listed after a restart (the seed's first buckets do not fire)", async () => {
  const w = three();
  let n = 0;
  w.db.transaction(() => { for (let k = K0 - BASE_BUCKETS; k < K0; k++) for (let i = 0; i < 60; i++) row(w.db, `D${n++}`, w.E[i % 3], k * B + 10 + i, { user: `s${i}` }); });
  const clock = fakeClock(closeAt(K0 - 1) * 1000);
  const again = new Model(w.db, { ...OPTS, now: clock.now });
  const events = [];
  again.wakeups.attach({ hub: { emit: (e, d) => events.push([e, d]) } });
  again.load();
  const s = again.wakeups.snapshot();
  assert.deepEqual([s.seedRows, s.seededWakes, s.relisted, s.waking, events.length], [BASE_BUCKETS * 60, 0, 0, 0, 0]);
  assert.deepEqual((await again.wakeups.serve()).families, []);
  // the same 60 the next bucket, live: its normal, nothing
  for (let i = 0; i < 60; i++) again.recordTrade({ sig: `L${i}`, mint: w.E[i % 3], idx: 0, slot: 9, time: K0 * B + i, isBuy: true, user: `n${i}`, baseAmount: "1", quoteAmount: "1", priceQuote: 1e-3, priceUsd: 1e-5, valueUsd: 5 });
  clock.t = closeAt(K0) * 1000; again.wakeups.hit = null;
  assert.deepEqual([(await again.wakeups.serve()).families, events.length], [[], 0]);
  again.wakeups.stop(); w.close();
});

test("filled trades (read back from the chain) never count or fire", () => {
  const w = three();
  for (let i = 0; i < 60; i++) w.model.storeFilled({ sig: `F${i}`, mint: w.E[i % 3], idx: 0, slot: i, time: K0 * B + i, isBuy: true, user: `f${i}`, baseAmount: "1", quoteAmount: "1", priceQuote: 1e-3, priceUsd: 1e-5, valueUsd: 5 });
  w.wk.tick(closeAt(K0));
  assert.deepEqual([w.wakes().length, w.wk.snapshot().trades, w.wk.parents.size], [0, 0, 0]);
  w.close();
});

test("one SSE `wake` event per wake-up, on the real hub", () => {
  const hub = new EventHub({ heartbeatMs: 60_000 });
  const got = [];
  hub.subscribe((e, d) => got.push([e, d]));
  const w = three({ hub });
  for (const k of [K0, K0 + 1, K0 + 2]) w.burst(k, 60, w.E, { tag: `k${k}-` });
  w.wk.tick(closeAt(K0 + 2));
  const wakes = got.filter((e) => e[0] === "wake");
  assert.deepEqual(wakes, [["wake", { parent: { mint: PAR, symbol: "PAR", name: "PAR coin" }, startedAt: (K0 + 1) * B, ratio: 60, buyers5m: 60 }]]);
  assert.equal(w.wk.snapshot().events, 1);
  hub.close(); w.close();
});

test("the family body: its numbers, the spark, coins by buyers then volume (at most 6, `more` for the rest), existing vs new, mcap and sinceStart", async () => {
  const w = three();
  const extra = [3, 4, 5, 6, 7].map((i) => w.coin(mintN(100 + i), `E${i}`));
  const fresh = w.coin(mintN(120), "NEWC", { createdAt: NOW_S + 60 }); // launched during the wake-up
  const all = [...w.E, ...extra];
  // two days of 1 buyer per bucket: baseline 1
  for (let j = BASE_BUCKETS; j >= 1; j--) w.trade(w.E[0], `h${j}`, (K0 - j) * B);
  w.burst(K0, 60, w.E, { usd: 5 });
  // the next bucket: 8 coins traded; E0 most buyers, E3..E7 one buyer each with growing volume, the new coin two
  for (let i = 0; i < 6; i++) w.trade(w.E[0], `p${i}`, (K0 + 1) * B + i);
  for (let i = 0; i < 3; i++) w.trade(w.E[1], `q${i}`, (K0 + 1) * B + i);
  extra.forEach((m, i) => w.trade(m, `r${i}`, (K0 + 1) * B + 20 + i, { usd: 10 * (i + 1) }));
  w.trade(fresh, "n1", (K0 + 1) * B + 30, { priceUsd: 2e-5 }); w.trade(fresh, "n2", (K0 + 1) * B + 31, { priceUsd: 2e-5 }); w.trade(fresh, "n1", (K0 + 1) * B + 32, { isBuy: false, usd: 1 });
  const body = await w.list(closeAt(K0 + 1));
  assert.deepEqual(Object.keys(body), ["asOf", "bucketS", "families"]);
  assert.deepEqual([body.asOf, body.bucketS], [closeAt(K0 + 1), 300]);
  const [f] = body.families;
  assert.deepEqual(Object.keys(f), ["parent", "startedAt", "state", "ratio", "peakRatio", "buyers5m", "trades5m", "spark", "baseline", "coinsTrading", "post", "coins", "more", "hidden"]);
  const img = (s) => `/api/img?u=${encodeURIComponent(`https://ipfs.io/ipfs/img-${s}`)}`;
  assert.deepEqual(f.parent, { mint: PAR, name: "PAR coin", symbol: "PAR", image: img("PAR"), isCoin: true });
  // latest bucket: 6 + 3 + 5 + 2 = 16 buyers, 17 trades; existing buyers 14 (the new coin's 2 are not); the current
  // baseline (287 x 1 + 60) / 288 = 1.2, so 11.6x; the peak is the first bucket's 60 over 1
  assert.deepEqual([f.startedAt, f.state, f.ratio, f.peakRatio, f.buyers5m, f.trades5m, f.baseline, f.coinsTrading, f.more, f.hidden, f.post], [(K0 + 1) * B, "live", 11.6, 60, 16, 17, 1.2, 8, 2, 0, null]);
  assert.deepEqual([f.spark.length, f.spark.slice(-3)], [24, [1, 60, 16]], "oldest first, the last is the latest complete bucket");
  assert.deepEqual(f.coins.map((c) => c.symbol), ["E0", "E1", "NEWC", "E7", "E6", "E5"], "buyers, then volume since the start (E0's 60/3 count in it)");
  assert.deepEqual(f.coins.map((c) => c.buyers5m), [6, 3, 2, 1, 1, 1]);
  const e0 = f.coins[0], nc = f.coins[2];
  assert.deepEqual(Object.keys(e0), ["mint", "name", "symbol", "image", "createdAt", "existing", "mcapUsd", "sinceStart", "buyers5m", "copyOf"]);
  assert.deepEqual([e0.existing, e0.createdAt, nc.existing, nc.createdAt, e0.copyOf, nc.copyOf], [true, OLD, false, NOW_S + 60, null, null], "no post: no copyOf");
  const pr = w.model.priceOf(w.E[0]);
  assert.ok(e0.mcapUsd > 0 && e0.sinceStart > 0);
  assert.equal(e0.mcapUsd, Math.round(pr.priceUsd * 1e9 * 100) / 100);
  assert.equal(e0.sinceStart, Math.round((pr.priceUsd / 1e-5) * 100) / 100, "last price over the price of the last trade at the start");
  assert.equal(nc.sinceStart, null, "a new coin has none: from its first trade it would count its own launch buy");
  w.close();
});

test("creator facts: sold its buy within 10 min, 10+ launches in the hour before, a relaunch of its ticker under the same parent", async () => {
  const w = three();
  const L = mintN(900, 9), M = mintN(901, 9), N = mintN(902, 9), Q = mintN(903, 9);
  const flow = (mint, ops) => ops.forEach(([dt, isBuy, amt], i) => w.db.insertTrade({ sig: `CF${mint.slice(0, 6)}${i}`, mint, idx: 0, slot: i, time: OLD + dt, isBuy, user: L, baseAmount: String(amt), quoteAmount: "1", priceQuote: 1e-3, priceUsd: 1e-5, valueUsd: 5 }));
  const s90 = w.coin(mintN(500), "S90", { launcher: L }); flow(s90, [[1, true, 1000], [599, false, 900]]);
  const s89 = w.coin(mintN(501), "S89", { launcher: L, createdAt: OLD - 2 * HOUR }); flow(s89, [[1 - 2 * HOUR, true, 1000], [599 - 2 * HOUR, false, 899]]);
  const late = w.coin(mintN(502), "LATE", { launcher: L, createdAt: OLD - 4 * HOUR }); flow(late, [[1 - 4 * HOUR, true, 1000], [600 - 4 * HOUR, false, 1000]]);
  const why = (m) => w.wk.deadWhy(w.model.get(m));
  assert.deepEqual([why(s90), why(s89), why(late)], ["sold", null, null], "90 % within 600 s; 89.9 %; a sale at 600 s is after the window");
  // M launched 9 coins in the hour before X and one 3 601 s before: X is fine; Y, one more inside the hour, is not
  for (let i = 0; i < 9; i++) w.coin(mintN(600 + i), `M${i}`, { parent: PAR2, launcher: M, createdAt: NOW_S - 100 - i * 300 });
  w.coin(mintN(610), "M9", { parent: PAR2, launcher: M, createdAt: NOW_S - 3601 });
  const x = w.coin(mintN(611), "MX", { launcher: M, createdAt: NOW_S });
  assert.equal(why(x), null, "9 in the hour");
  const y = w.coin(mintN(613), "MY", { launcher: M, createdAt: NOW_S + 1 });
  assert.equal(why(y), "spree", "10 in the hour before it, under any parent (M0-M8 and MX)");
  // N: "JEN" under PAR, then " jen" under PAR again (dead), "JEN" under PAR2 (fine); Q's "JEN" under PAR is fine
  const j1 = w.coin(mintN(700), "JEN", { launcher: N, createdAt: NOW_S - 5000 });
  const j2 = w.coin(mintN(701), " jen", { launcher: N, createdAt: NOW_S - 4000 });
  const j3 = w.coin(mintN(702), "JEN", { parent: PAR2, launcher: N, createdAt: NOW_S - 3000 });
  const j4 = w.coin(mintN(703), "JEN", { launcher: Q, createdAt: NOW_S - 2000 });
  assert.deepEqual([why(j1), why(j2), why(j3), why(j4)], [null, "relaunch", null, null]);
  // in a family: dead coins are left out of `coins`, counted in `hidden`; their buyers still count for the rule
  w.burst(K0, 50, [w.E[0], w.E[1], s90, j2]);
  const [f] = (await w.list(closeAt(K0))).families;
  assert.deepEqual([f.coins.map((c) => c.symbol).sort(), f.hidden, f.more, f.coinsTrading], [["E0", "E1"], 2, 0, 4]);
  // a coin under 10 min old is asked again after 30 s (its creator may still sell); an old one is final
  const young = w.coin(mintN(800), "YNG", { launcher: L, createdAt: NOW_S - 60 });
  assert.equal(why(young), null);
  w.db.insertTrade({ sig: "Y1", mint: young, idx: 0, slot: 1, time: NOW_S - 59, isBuy: true, user: L, baseAmount: "100", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd: 5 });
  w.db.insertTrade({ sig: "Y2", mint: young, idx: 0, slot: 2, time: NOW_S - 50, isBuy: false, user: L, baseAmount: "100", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd: 5 });
  assert.equal(why(young), null, "cached");
  w.clock.t += 30_000;
  assert.equal(why(young), "sold");
  w.close();
});

test("the creator's 10-minute flow: recorded from the trades, kept past the trim and a restart; without it an old coin's fact is unknown, counted and asked again", () => {
  const w = three();
  const L = mintN(910, 9), at = NOW_S - 100;
  const why = (m, wk = w.wk) => wk.deadWhy(wk.model.get(m));
  const dump = w.coin(mintN(520), "DUMP", { launcher: L, createdAt: at }), kept = w.coin(mintN(521), "KEPT", { launcher: L, createdAt: at });
  const nodev = w.coin(mintN(522), "NODEV", { launcher: L, createdAt: at }), late = w.coin(mintN(523), "LATE", { launcher: L, createdAt: at });
  w.trade(dump, L, at, { baseAmount: "1000" }); w.trade(dump, "x", at + 5); w.trade(dump, L, at + 300, { isBuy: false, baseAmount: "950" });
  w.trade(kept, L, at, { baseAmount: "1000" }); w.trade(kept, L, at + 300, { isBuy: false, baseAmount: "100" });
  w.trade(nodev, "x", at + 2);                       // seen from its launch: no creator buy is a fact
  w.trade(late, "x", at + 200);                      // first seen 200 s in: proves nothing
  w.trade(dump, L, at + DEAD_SOLD_S, { isBuy: false, baseAmount: "1" }); // after the window
  w.wk.tick(at + DEAD_SOLD_S + GRACE_S - 1);
  assert.equal(w.db.launchFlowGet(dump), null, "open until 10 min and the grace");
  w.wk.tick(at + DEAD_SOLD_S + GRACE_S);
  assert.deepEqual([dump, kept, nodev, late].map((m) => w.db.launchFlowGet(m)), [{ bought: 1000, sold: 950, createdAt: at }, { bought: 1000, sold: 100, createdAt: at }, { bought: 0, sold: 0, createdAt: at }, null]);
  assert.deepEqual([w.wk.snapshot().launchSaved, w.wk.snapshot().launchSkipped, w.wk.snapshot().launching], [3, 1, 0]);
  // the trim took every row: the record decides, and after a restart too
  w.db.db.exec("DELETE FROM trades");
  w.clock.t = (at + 700) * 1000;
  assert.deepEqual([why(dump), why(kept), why(nodev), w.wk.snapshot().factsUnknown], ["sold", null, null, 0]);
  const again = new Model(w.db, { ...OPTS, now: w.clock.now });
  again.load();
  assert.deepEqual([why(dump, again.wakeups), why(kept, again.wakeups)], ["sold", null]);
  // LATE and an old coin whose launch rows are gone: unknown (shown, counted), asked again after 10 min, never cached as "not sold"
  const lost = w.coin(mintN(524), "LOST", { launcher: L, createdAt: OLD });
  row(w.db, "R1", lost, NOW_S, { user: L });
  const q0 = w.wk.snapshot().factQueries;
  assert.deepEqual([why(late), why(lost), w.wk.snapshot().factsUnknown], [null, null, 2]);
  w.clock.t += FACT_UNKNOWN_MS - 1;
  assert.deepEqual([why(lost), w.wk.snapshot().factQueries - q0], [null, 2], "cached");
  w.clock.t += 1;
  assert.deepEqual([why(lost), w.wk.snapshot().factQueries - q0, w.wk.snapshot().factsUnknown], [null, 3, 2], "asked again, still one unknown");
  // rows that still reach back to the launch decide, and are recorded
  const rows = w.coin(mintN(525), "ROWS", { launcher: L, createdAt: OLD });
  row(w.db, "R2", rows, OLD + 1, { user: L, baseAmount: "10" }); row(w.db, "R3", rows, OLD + 60, { user: L, isBuy: false, baseAmount: "10" });
  assert.deepEqual([why(rows), w.db.launchFlowGet(rows)], ["sold", { bought: 10, sold: 10, createdAt: OLD }]);
  again.wakeups.stop(); w.close();
  // a database made before the table gets it on open
  const dir = mkdtempSync(join(tmpdir(), "spore-wake-db-")), file = join(dir, "old.db");
  let d = new Db(file); d.db.exec("DROP TABLE launch_flow"); d.close();
  d = new Db(file);
  assert.deepEqual([d.launchFlowPut("M", 1, 2, 3), d.launchFlowPut("M", 9, 9, 9), d.launchFlowGet("M")], [true, false, { bought: 1, sold: 2, createdAt: 3 }], "the first record wins");
  d.close(); rmSync(dir, { recursive: true, force: true });
});

test("the post: the one most children traded since the start link (2+), its text from the fetcher, one X does not show passed over; copyOf for new coins", async () => {
  const w = three();
  const X = idAt(NOW_S - HOUR, 1), Y = idAt(NOW_S - 2 * HOUR, 2), Z = idAt(NOW_S - 3 * HOUR, 3);
  for (const m of w.E) w.model.setMeta(`https://ipfs.io/ipfs/${m}`, { image: null, description: null, twitter: link(X), telegram: null, website: null, fetchedAt: 1, ok: true });
  const n0 = w.coin(mintN(130), "N0", { post: link(X), createdAt: NOW_S - 900, launcher: mintN(1, 3) });
  const n1 = w.coin(mintN(131), "N1", { post: link(X), createdAt: NOW_S - 600, launcher: mintN(2, 3) });
  const y1 = w.coin(mintN(132), "Y1", { post: link(Y) }), y2 = w.coin(mintN(133), "Y2", { post: link(Y) });
  const z1 = w.coin(mintN(134), "Z1", { post: link(Z) });
  w.coin(mintN(135), "QUIETX", { post: link(X) }); // links X, never traded: not counted for the post, counted as an earlier copy
  w.burst(K0, 50, w.E);
  for (const m of [n0, n1, y1, y2, z1]) w.trade(m, `t${m.slice(0, 4)}`, (K0 + 1) * B + 5);
  // no narrative: the post is listed as a link, "idle"; no copyOf
  let [f] = (await w.list(closeAt(K0 + 1))).families;
  assert.deepEqual(f.post, { id: X, url: postUrl(X), at: NOW_S - HOUR, handle: null, text: null, state: "idle", coins: 5 });
  assert.equal(postTime(X, NOW_S * 1000), NOW_S - HOUR);
  assert.ok(f.coins.every((c) => c.copyOf === null));
  // with the linked posts and a fetcher that knows X is gone and Y's text
  const records = new Map([[X, { id: X, state: "none", handle: null, text: null }], [Y, { id: Y, state: "ok", handle: "real", text: "the post" }]]);
  const asked = [];
  const posts = { peek: (id) => records.get(id) ?? null, canQueue: (id) => (records.has(id) ? "cached" : "ok"), want: (id) => { asked.push(id); return "ok"; }, state: () => "wait", snapshot: () => ({}), start() {}, stop() {} };
  w.wk.attach({ narrative: new Narrative({ model: w.model, posts, now: w.clock.now, log: quiet }) });
  [f] = (await w.list(closeAt(K0 + 1) + 10)).families;
  assert.deepEqual(f.post, { id: Y, url: postUrl(Y), at: NOW_S - 2 * HOUR, handle: "real", text: "the post", state: "ok", coins: 2 }, "X is passed over, Z has one coin");
  const by = Object.fromEntries(f.coins.map((c) => [c.symbol, c]));
  assert.deepEqual([by.N1.existing, by.N1.copyOf, by.N0.copyOf, by.Y1.copyOf, by.Z1.copyOf], [false, 5, 4, null, null], "N1: E0-E2, QUIETX and N0 linked X before it; existing coins carry no copyOf");
  // a fetcher with nothing stored: the post's text is asked for, the state says "wait"
  records.clear();
  [f] = (await w.list(closeAt(K0 + 1) + 20)).families;
  assert.deepEqual([f.post.id, f.post.state, f.post.text, asked.includes(X)], [X, "wait", null, true]);
  w.close();
});

test("the list: live first, newest start first, then cooling; at most 12", async () => {
  const w = world();
  const fam = (p, i) => { w.coin(p, `P${i}`, { parent: null, createdAt: OLD - DAY }); return [0, 1, 2].map((j) => w.coin(mintN(1000 + i * 10 + j), `C${i}${j}`, { parent: p })); };
  const A = mintN(50, 2), Bm = mintN(51, 2), C = mintN(52, 2);
  const a = fam(A, 1), b = fam(Bm, 2), c = fam(C, 3);
  w.burst(K0 - 2, 50, a, { tag: "a" }); w.burst(K0, 5, a, { tag: "a2" }); // fired first, still hot
  w.burst(K0 - 1, 50, b, { tag: "b" });                                   // fired, then quiet: cooling
  w.burst(K0, 50, c, { tag: "c" });                                       // fired last
  let body = await w.list(closeAt(K0));
  assert.deepEqual(body.families.map((f) => [f.parent.mint, f.state]), [[C, "live"], [A, "live"], [Bm, "cooling"]]);
  const many = Array.from({ length: 14 }, (_, i) => mintN(60 + i, 2));
  many.forEach((p, i) => w.burst(K0 + 1, 50, fam(p, 10 + i), { tag: `m${i}-` }));
  body = await w.list(closeAt(K0 + 1));
  assert.equal(body.families.length, LIST_MAX);
  assert.deepEqual(body.families.map((f) => f.parent.mint), [...many].sort().slice(0, LIST_MAX), "same start: by mint");
  assert.equal(w.wk.snapshot().waking, 17);
  w.close();
});

test("the quiet answer: the 3 children most wallets bought in the last 15 min (dead coins left out); SOL and unknown mints are none", async () => {
  const w = three();
  const q = [0, 1, 2, 3, 4].map((i) => w.coin(mintN(140 + i), `Q${i}`));
  const dead = w.coin(mintN(150), "DEAD", { launcher: mintN(5, 9) }), dead2 = w.coin(mintN(151), " dead", { launcher: mintN(5, 9), createdAt: OLD + 10 });
  // in time order (a late print counts in the open bucket)
  for (let i = 0; i < 10; i++) w.trade(q[4], `e${i}`, (K0 - 4) * B + i);    // 25 min back: outside
  for (let i = 0; i < 5; i++) w.trade(q[0], `a${i}`, (K0 - 2) * B + i);
  for (let i = 0; i < 2; i++) w.trade(q[2], `c${i}`, (K0 - 1) * B + i);
  for (let i = 2; i < 7; i++) w.trade(q[0], `a${i}`, K0 * B + i);           // 7 distinct over 15 min, 5 in the latest bucket
  for (let i = 0; i < 6; i++) w.trade(q[1], `b${i}`, K0 * B + i);
  w.trade(q[3], "d0", K0 * B);
  for (let i = 0; i < 9; i++) w.trade(dead2, `f${i}`, K0 * B + i);          // DEAD's relaunch: left out
  // under PAR2: one child bought, one only sold, one bought for $0.99: only the first is moving
  const p2 = [0, 1, 2].map((i) => w.coin(mintN(170 + i), `T${i}`, { parent: PAR2 }));
  for (let i = 0; i < 5; i++) w.trade(p2[0], `g${i}`, K0 * B + 10 + i);
  w.trade(p2[1], "g0", K0 * B + 20, { isBuy: false }); w.trade(p2[2], "g1", K0 * B + 21, { usd: 0.99 });
  assert.equal(w.wk.deadWhy(w.model.get(dead)), null);
  w.clock.t = closeAt(K0) * 1000;
  const body = await w.wk.serveOne(PAR);
  assert.deepEqual(Object.keys(body), ["parent", "startedAt", "state", "ratio", "peakRatio", "buyers5m", "trades5m", "spark", "baseline", "coinsTrading", "post", "coins", "more", "hidden"]);
  assert.deepEqual([body.state, body.startedAt, body.ratio, body.peakRatio, body.spark, body.baseline, body.post, body.more, body.hidden], ["quiet", null, null, null, null, null, null, 0, 0]);
  assert.deepEqual([body.buyers5m, body.trades5m, body.coinsTrading], [5 + 6 + 1 + 9, 5 + 6 + 1 + 9, 4]);
  assert.deepEqual(body.coins.map((c) => [c.symbol, c.buyers15m, c.buyers5m, c.sinceStart, c.copyOf, c.existing]), [["Q0", 7, 5, null, null, true], ["Q1", 6, 6, null, null, true], ["Q2", 2, 0, null, null, true]]);
  assert.deepEqual((await w.wk.serveOne(PAR2)).coins.map((c) => [c.symbol, c.buyers15m]), [["T0", 5]], "no \"0 buyers\" row");
  assert.equal(await w.wk.serveOne(SOL_MINT), null);
  assert.equal(await w.wk.serveOne(mintN(999, 4)), null, "unknown");
  const leaf = await w.wk.serveOne(q[3]);
  assert.deepEqual([leaf.state, leaf.coins, leaf.parent.isCoin], ["quiet", [], true], "a tracked coin without children");
  // a waking parent answers its family object
  w.burst(K0 + 1, 50, w.E);
  w.clock.t = closeAt(K0 + 1) * 1000 + WAKE_TTL_MS;
  const one = await w.wk.serveOne(PAR), list = await w.wk.serve();
  assert.deepEqual([one.state, one], ["live", list.families[0]]);
  w.close();
});

test("the quiet answer looks at most QUIET_SCAN children (many left out are no long step)", async () => {
  const w = three();
  const L = mintN(7, 9);
  // 400 relaunches of one ticker launched in the last 20 min (new: no wake-up; the first, never traded, is the original):
  // left out, each bought by 2 wallets, ranked above the 3 clean children bought by 1 wallet each
  w.coin(mintN(1999), "SAME", { launcher: L, createdAt: OLD });
  const dead = Array.from({ length: 400 }, (_, i) => w.coin(mintN(2000 + i), "SAME", { launcher: L, createdAt: NOW_S - 1000 + i }));
  dead.forEach((m, i) => { w.trade(m, `a${i}`, K0 * B + (i % 290)); w.trade(m, `b${i}`, K0 * B + (i % 290)); });
  w.E.forEach((m, i) => w.trade(m, `c${i}`, K0 * B + 295));
  w.clock.t = closeAt(K0) * 1000;
  const body = await w.wk.serveOne(PAR);
  assert.deepEqual(body.coins, [], "the clean ones are past the cap");
  assert.equal(w.wk.facts.size, QUIET_SCAN, "one creator check per child looked at");
  w.close();
});

test("mcapUsd: the model's USD price, else the newest stored trade's (read once per build), else null", async () => {
  const w = three();
  const ASSET = mintN(3, 1); // a parent that is no tracked coin (a listed asset): the model has no USD price for its children
  const a = [0, 1, 2].map((i) => w.coin(mintN(160 + i), `A${i}`, { parent: ASSET }));
  for (let i = 0; i < 3; i++) w.trade(a[0], `x${i}`, K0 * B + i, { priceUsd: i < 2 ? 2e-5 : 4e-5 });
  for (let i = 0; i < 2; i++) w.trade(a[1], `y${i}`, K0 * B + 10 + i, { priceUsd: 2e-5 });
  w.trade(a[2], "z0", K0 * B + 20, { priceUsd: null });
  assert.equal(w.model.priceOf(a[0]).priceUsd, null);
  let reads = 0;
  const lastPriceUsd = w.db.lastPriceUsd.bind(w.db);
  w.db.lastPriceUsd = (m) => { reads++; return lastPriceUsd(m); };
  w.clock.t = closeAt(K0) * 1000;
  const body = await w.wk.serveOne(ASSET);
  assert.deepEqual(body.coins.map((c) => [c.symbol, c.mcapUsd]), [["A0", 40_000], ["A1", 20_000], ["A2", null]]);
  assert.equal(reads, 3);
  w.close();
});

async function serveApp(w) {
  const dir = mkdtempSync(join(tmpdir(), "spore-wake-api-"));
  const hub = new EventHub({ heartbeatMs: 60_000 });
  const app = createApp({ model: w.model, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc: { call: async () => { throw new Error("no chain in this test"); } }, hub, images: new ImageCache(dir), meta: null,
    platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet, now: w.clock.now });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (p, headers = {}) => fetch(url + p, { headers }).then(async (r) => { const text = await r.text(); return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null }; }),
    close: async () => { await new Promise((r) => server.close(r)); hub.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("GET /api/discover and /api/discover/:mint: the bodies, 5 s with no stale-while-revalidate, 400/404; health carries `wakeups`", async () => {
  const w = three();
  w.burst(K0, 50, w.E);
  w.clock.t = closeAt(K0) * 1000;
  const app = await serveApp(w);
  try {
    const r = await app.get("/api/discover");
    assert.deepEqual([r.status, r.headers.get("cache-control")], [200, "public, max-age=5"]);
    assert.deepEqual([r.body.families.length, r.body.families[0].parent.mint, r.body.families[0].state], [1, PAR, "live"]);
    assert.equal((await app.get("/api/discover", { "if-none-match": r.headers.get("etag") })).status, 304);
    const one = await app.get(`/api/discover/${PAR}`);
    assert.deepEqual([one.status, one.headers.get("cache-control"), one.body], [200, "public, max-age=5", r.body.families[0]]);
    const q = await app.get(`/api/discover/${w.E[0]}`);
    assert.deepEqual([q.status, q.body.state, q.body.coins], [200, "quiet", []]);
    for (const bad of ["nope", "0OIl", "123"]) assert.deepEqual((await app.get(`/api/discover/${bad}`)).status, 400);
    for (const none of [SOL_MINT, mintN(999, 4)]) assert.deepEqual([(await app.get(`/api/discover/${none}`)).status, (await app.get(`/api/discover/${none}`)).body], [404, { error: "unknown mint" }]);
    const health = (await app.get("/api/health")).body;
    assert.equal(health.discover, undefined);
    assert.deepEqual([health.wakeups.started, health.wakeups.waking, health.wakeups.live, health.wakeups.builds >= 1, typeof health.wakeups.capped], [1, 1, 1, true, "number"]);
  } finally { await app.close(); }
  w.close();
});

test("cost: a 50 000-trade burst is O(1) per trade, wallet sets stay bounded, and the list builds in slices", async (t) => {
  const w = world({ parent: false });
  const PARENTS = 200, KIDS = 5, N = 50_000;
  const kids = [];
  w.db.transaction(() => {
    for (let p = 0; p < PARENTS; p++) {
      const pm = mintN(p, 3);
      w.coin(pm, `P${p}`, { parent: null, createdAt: OLD - DAY });
      for (let j = 0; j < KIDS; j++) kids.push(w.coin(mintN(p * KIDS + j, 4), `K${p}_${j}`, { parent: pm }));
    }
  });
  // 4 buckets of trades: 12 500 per bucket, every parent waking in the second one (62 buyers each)
  const trades = new Array(N);
  for (let i = 0; i < N; i++) {
    const k = K0 + Math.floor((i * 4) / N), mint = kids[i % kids.length];
    trades[i] = { mint, time: k * B + (i % 290), isBuy: k === K0 + 1 || i % 5 !== 0, valueUsd: 2 + (i % 7), user: `w${i % (k === K0 + 1 ? 100_000 : 25)}` };
  }
  let maxCall = 0;
  const t0 = performance.now();
  for (const tr of trades) { const a = performance.now(); w.wk.record(tr); const d = performance.now() - a; if (d > maxCall) maxCall = d; }
  const total = performance.now() - t0;
  w.wk.tick(closeAt(K0 + 3));
  const s = w.wk.snapshot();
  t.diagnostic(`50 000 trades over ${PARENTS} parents: ${total.toFixed(1)} ms (${((total * 1000) / N).toFixed(2)} µs a trade), longest call ${maxCall.toFixed(2)} ms, ${s.closes} closes, ${s.started} wake-ups`);
  assert.equal(s.started, PARENTS, "every parent woke once");
  assert.ok((total * 1000) / N < 25, `${((total * 1000) / N).toFixed(2)} µs a trade`);
  assert.ok(maxCall < 50, `longest call ${maxCall.toFixed(2)} ms`);
  assert.deepEqual([s.open, s.walletsOpen], [0, 0], "closed buckets hold no wallet map");
  let held = 0;
  for (const P of w.wk.parents.values()) for (const h of P.hist) for (const c of h.coins.values()) held += c.buyers.size;
  assert.ok(held <= N, "coin sets hold at most one entry per buy");
  // the list: 200 families built in slices, 12 listed
  w.clock.t = closeAt(K0 + 3) * 1000;
  const body = await w.wk.serve();
  const snap = w.wk.snapshot();
  t.diagnostic(`list build ${snap.lastBuildMs} ms of CPU, longest slice ${snap.maxSliceMs} ms`);
  assert.equal(body.families.length, LIST_MAX);
  assert.ok(body.families.every((f) => f.coins.length <= COINS_MAX));
  assert.ok(snap.maxSliceMs < 40, `longest slice ${snap.maxSliceMs} ms`);
  // the cap on one bucket's wallets
  const v = three();
  for (let i = 0; i <= SET_MAX; i++) v.wk.record({ mint: v.E[0], time: K0 * B + 1, isBuy: true, valueUsd: 5, user: `c${i}` });
  const P = v.wk.parents.get(PAR);
  assert.deepEqual([P.buyers.size, P.allN, v.wk.snapshot().capped >= 1], [SET_MAX, SET_MAX, true]);
  v.close(); w.close();
});

test("Wakeups on its own: no hub, no narrative, a model without trades", async () => {
  const w = world();
  const wk = new Wakeups({ model: w.model, now: w.clock.now, log: quiet });
  assert.deepEqual(await wk.serve(), { asOf: NOW_S, bucketS: 300, families: [] });
  wk.start(); wk.start(); wk.stop(); wk.stop();
  w.close();
});
