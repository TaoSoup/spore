// Story attention (lib/attention.mjs): the story key (lib/stories.mjs), the 5-minute bucket accounting (distinct buyers
// over a story's coins, the site-wide denominator, the same-minute launch split, late prints, no seed), the baseline and
// its gates, the phase rule as a table, the story start, the calibration outcomes, coin days, the pre-registered event
// recorder and its hit rule, the API (additive `attention` on story cards, GET /api/story-series/:key, health), and the
// close's bounded work (slices, small transactions, no read of the trades table). A fake clock and sqlite in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Attention, baselineOf, multipleOf, phaseOf, median, nameWords, matchKeywords, parseEvent, eventResult, offsetS,
  BUCKET_S, GRACE_S, PARTIAL, CHUNK, ROWS_MAX, MIN_HISTORY_S, MIN_BASE_BUCKETS, MIN_HOUR_BUYERS, FAST_S, PRE_EXISTING_S, SERIES_ROWS } from "../lib/attention.mjs";
import { storyKey, parseStoryKey, coinStoryKey, groupStories, SITE_KEY } from "../lib/stories.mjs";
import { BASE_BUCKETS } from "../lib/wakeups.mjs";
import { Narrative } from "../lib/narrative.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { createApp } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";
import { fakeClock } from "./helpers/chain.mjs";
import { calibTable, bandOf } from "../scripts/attention-calib.mjs";
import { eventResults } from "../scripts/event-results.mjs";

const B = BUCKET_S, HOUR = 3600, DAY = 86_400;
const NOW = 1_770_000_000, K0 = NOW / B, T0 = K0 * B, OLD = NOW - 2 * DAY;
const mintN = (i, fill = 6) => { const b = Buffer.alloc(32, fill); b.writeUInt32BE(i, 28); return new PublicKey(b).toBase58(); };
const PAR = mintN(1, 1);
const OPTS = { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet };
/** A post id made at unix s `s`. */
const idAt = (s, n = 0) => String(((BigInt(s * 1000) - 1288834974657n) << 22n) + BigInt(n));

function world({ at = NOW } = {}) {
  const clock = fakeClock(at * 1000), db = new Db(":memory:");
  const model = new Model(db, { ...OPTS, now: clock.now });
  model.load(); model.setSolUsd(100);
  model.wakeups.firstK = K0 - BASE_BUCKETS - 100;
  model.wakeups.attach({ hub: { emit() {} } });
  const att = model.attention;
  att.bootK = -1; // no bucket of these tests is the boot's partial one unless a test says so
  let seq = 0;
  const w = { clock, db, model, att, wk: model.wakeups };
  w.coin = (mint, symbol, { parent = PAR, createdAt = OLD, name = null, post = null } = {}) => {
    model.upsertCoin({ mint, curve: `C_${mint.slice(0, 8)}`, depth: parent ? 1 : 0, quoteMint: parent, ...base, virtualQuoteReserves: parent ? "1000000000000000" : "100000000000", createdAt, tracked: true });
    model.setMint({ mint, decimals: 6, tokenProgram: T22, name: name ?? `${symbol} coin`, symbol, uri: `https://ipfs.io/ipfs/${mint}`, onchainAt: 1 });
    model.setMeta(`https://ipfs.io/ipfs/${mint}`, { image: `https://ipfs.io/ipfs/img-${symbol}`, description: null, twitter: post ? `https://x.com/a/status/${post}` : null, telegram: null, website: null, fetchedAt: 1, ok: true });
    return mint;
  };
  w.trade = (mint, user, time, { usd = 5, isBuy = true, priceUsd = 1e-5 } = {}) =>
    model.recordTrade({ sig: `S${seq++}`, mint, idx: 0, slot: seq, time, isBuy, user, baseAmount: "1000", quoteAmount: "1", priceQuote: 1, priceUsd, valueUsd: usd });
  /** Posts that may be shown (the post store's peek). */
  w.posts = (ids) => {
    const records = new Map(ids.map((id) => [id, { id, state: "ok", handle: "poster", text: "news", flagged: false }]));
    const posts = { peek: (id) => records.get(id) ?? null, canQueue: () => "cached", want: () => "cached", state: () => "idle", snapshot: () => ({}), start() {}, stop() {} };
    w.wk.attach({ narrative: new Narrative({ model, posts, now: clock.now, log: quiet }) });
    return records;
  };
  /** Closes every bucket due at unix s `s`. */
  w.close = (s) => { clock.t = s * 1000; return att.closeNow(s); };
  w.rowsOf = (key) => db.storyRows(key, 0);
  w.end = () => { w.wk.stop(); att.stop(); db.close(); };
  w.coin(PAR, "PAR", { parent: null, createdAt: OLD - DAY });
  return w;
}

async function serveApp(w) {
  const dir = mkdtempSync(join(tmpdir(), "spore-att-api-"));
  const hub = new EventHub({ heartbeatMs: 60_000 });
  const app = createApp({ model: w.model, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc: { call: async () => { throw new Error("no chain"); } }, hub, images: new ImageCache(dir), meta: null,
    platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet, now: w.clock.now });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (p) => fetch(url + p).then(async (r) => { const text = await r.text(); return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null }; }),
    close: async () => { await new Promise((r) => server.close(r)); hub.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------- the story key
test("story keys: one function for cards and series; narrative 2+ coins, else the coin's post, else its waking family (under its post when shown)", () => {
  assert.deepEqual([storyKey("narrative", 7), storyKey("post", "1987238502124409321"), storyKey("family", PAR)], ["n:7", "1987238502124409321", PAR]);
  assert.throws(() => storyKey("loose", 1));
  assert.deepEqual([parseStoryKey("n:7"), parseStoryKey("1987238502124409321"), parseStoryKey(PAR)], [{ kind: "narrative", id: 7 }, { kind: "post", id: "1987238502124409321" }, { kind: "family", id: PAR }]);
  assert.deepEqual(["n:", "n:07", "*", "", "abc", "0123", null, "n:1:2", "x".repeat(50)].map(parseStoryKey), Array(9).fill(null));
  const fam = { mint: PAR, postId: null, postOk: false };
  const table = [
    [{ narrativeId: 7, narrativeCoins: 2, postId: "11", postOk: true, family: fam }, "n:7"],
    [{ narrativeId: 7, narrativeCoins: 1, postId: "11", postOk: true, family: fam }, "11"],
    [{ narrativeId: 7, narrativeCoins: 1, postId: "11", postOk: false, family: fam }, PAR],
    [{ postId: "11", postOk: false, family: { mint: PAR, postId: "22", postOk: true } }, "22"],
    [{ postId: "11", postOk: false, family: { mint: PAR, postId: "22", postOk: false } }, PAR],
    [{ narrativeId: 7, narrativeCoins: 1 }, null],
    [{}, null],
  ];
  for (const [input, want] of table) assert.equal(coinStoryKey(input), want, JSON.stringify(input));
  // groupStories gives its cards the same keys
  const row = (mint, sym, extra = {}) => ({ mint, symbol: sym, image: null, buyers5m: 3, tf: { buyers: 3, volUsd: 100 }, liqUsd: 100, mcapUsd: 1000, parent: null, ...extra });
  const g = groupStories({ rows: [row("A1", "A"), row("B1", "B"), row("C1", "C", { parent: { mint: PAR } })], postIdOf: (r) => (r.mint === "C1" ? null : r.mint === "B1" ? "22" : null),
    postOf: () => ({ handle: "h", text: "t" }), wakes: new Map([[PAR, { mint: PAR, startedAt: 1, postId: null }]]), tagOf: (r) => (r.mint === "A1" ? { id: 9, title: "x", theme: "y" } : null) });
  assert.deepEqual(g.cards.map((c) => [c.kind, c.key, parseStoryKey(c.key)?.kind]).sort(), [["family", PAR, "family"], ["post", "22", "post"]], "a lone narrative coin is no card (loose here)");
});

// ---------------------------------------------------------------- the buckets
test("buckets: a post story's distinct buyers over its coins, the site row's denominator, same-minute and later launches, the start; no row for a coin of no story", () => {
  const w = world();
  const X = idAt(T0 - 30, 1);
  w.posts([X]);
  const A = w.coin(mintN(10), "AAA", { parent: null, createdAt: T0 - 10, post: X });    // 20 s after the post: same-minute
  const Bc = w.coin(mintN(11), "BBB", { parent: null, createdAt: T0 + 100, post: X });  // 130 s after: later
  const Cold = w.coin(mintN(12), "OLD", { parent: null, post: X });                   // an old coin: no launch
  const L = w.coin(mintN(13), "LOOSE", { parent: null });
  w.trade(A, "u1", T0 + 1); w.trade(A, "u2", T0 + 2); w.trade(A, "u1", T0 + 3);
  w.trade(Bc, "u2", T0 + 110); w.trade(Bc, "u3", T0 + 111);
  w.trade(Cold, "u4", T0 + 120, { isBuy: false }); w.trade(Cold, "u5", T0 + 121, { usd: 0.5 });
  w.trade(L, "u6", T0 + 130); w.trade(L, "u1", T0 + 131, { usd: 2, priceUsd: null });
  assert.equal(w.close(T0 + B + GRACE_S - 1), 0, "not closed before the grace");
  assert.equal(w.close(T0 + B + GRACE_S), 1);
  const [x] = w.rowsOf(X), [site] = w.rowsOf(SITE_KEY);
  assert.deepEqual([x.t, x.buyers, x.sells, x.launches, x.launchesFast, x.coins, x.siteBuyers, x.leaderBuyers, x.flags], [T0, 3, 1, 2, 1, 3, 4, 2, 0], "u1 u2 u3; u4 sold; u5 under $1");
  assert.equal(x.leaderMint, [A, Bc].sort()[0], "a tie in buyers goes to the lower mint");
  assert.equal(x.buyUsd, 5 * 5 + 0.5);
  assert.deepEqual([site.buyers, site.siteBuyers, site.launches, site.launchesFast, site.coins, site.leaderMint], [4, 4, 2, 1, 4, null], "u1 u2 u3 u6: every tracked coin");
  assert.deepEqual(w.rowsOf(L), [], "a coin of no story has no row");
  assert.deepEqual(w.db.storyStartGet(X), { startAt: T0 - 30, source: "post", firstBuyersAt: T0 });
  assert.deepEqual(w.att.lastCoin.get(A), 2);
  // a launch is counted once: the same coin in the next bucket is not a launch again
  w.trade(Bc, "u7", T0 + B + 5);
  w.close(T0 + 2 * B + GRACE_S);
  assert.deepEqual(w.rowsOf(X).map((r) => [r.t, r.buyers, r.launches]), [[T0, 3, 2], [T0 + B, 1, 0]]);
  w.end();
});

test("buckets: a late print goes to the first open bucket; the boot seed is never counted; the boot's own bucket is partial", () => {
  const w = world();
  const A = w.coin(mintN(20), "AAA", { parent: null });
  w.db.insertTrade({ sig: "OLD1", mint: A, idx: 0, slot: 1, time: NOW - 600, isBuy: true, user: "seed", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1e-5, valueUsd: 5 });
  // a second model over the same file: load() seeds activity, wake-ups and coin rows, never the attention
  const m2 = new Model(w.db, { ...OPTS, now: w.clock.now });
  m2.load();
  assert.deepEqual([m2.attention.open.size, m2.attention.stats.trades], [0, 0]);
  assert.equal(m2.attention.bootK, null, "no live trade yet: no boot bucket");
  m2.attention.record({ mint: A, time: T0 + 1, isBuy: true, valueUsd: 5, user: "a", priceUsd: 1e-5 });
  assert.equal(m2.attention.bootK, K0, "the first live trade's bucket is the boot's");
  m2.attention.closeNow(T0 + B + GRACE_S);
  assert.equal(w.db.storyRows(SITE_KEY, 0)[0].flags, PARTIAL);
  // constructed before a bucket edge, the first live trade after it: that later bucket is the partial one
  const w3 = world({ at: T0 + 2 * B + 290 });
  const a3 = new Attention({ model: w3.model, now: w3.clock.now, log: quiet });
  w3.clock.t = (T0 + 3 * B + 12) * 1000;
  a3.record({ mint: w3.coin(mintN(21), "BBB", { parent: null }), time: T0 + 3 * B + 12, isBuy: true, valueUsd: 5, user: "a" });
  assert.deepEqual([a3.bootK, a3.open.get(K0 + 3).partial], [K0 + 3, true]);
  w3.end();
  // late print: bucket K0 is closed, a print of K0 lands in K0 + 1
  w.trade(A, "x", T0 + 10); w.close(T0 + B + GRACE_S);
  w.trade(A, "y", T0 + 20); // block time inside the closed bucket
  assert.deepEqual([...w.att.open.keys()], [K0 + 1]);
  w.end();
});

test("buckets: a narrative takes its coins once 2+ of them had buyers in the last hour; a lone tagged coin stays on its post; a live family's coins go under the parent", () => {
  const w = world();
  const X = idAt(T0 - 5000, 2);
  w.posts([X]);
  const N1 = w.coin(mintN(30), "N1", { parent: null }), N2 = w.coin(mintN(31), "N2", { parent: null }), LONE = w.coin(mintN(32), "LONE", { parent: null, post: X });
  const KID = w.coin(mintN(33), "KID");
  const tags = new Map([[N1, { id: 7, title: "t", theme: "x" }], [N2, { id: 7, title: "t", theme: "x" }], [LONE, { id: 8, title: "u", theme: "x" }]]);
  w.model.coinRows.narr = { on: true, tagOf: (m) => tags.get(m) ?? null };
  w.wk.wakeOf = (m) => (m === PAR ? { startedAt: T0 - 900, live: true, silent: false, postId: null } : null);
  w.trade(N1, "a", T0 + 1); w.trade(N2, "a", T0 + 2); w.trade(N2, "b", T0 + 3); w.trade(LONE, "c", T0 + 4); w.trade(KID, "d", T0 + 5);
  w.close(T0 + B + GRACE_S);
  assert.deepEqual([w.rowsOf("n:7")[0]?.buyers, w.rowsOf("n:7")[0]?.coins, w.rowsOf("n:8").length, w.rowsOf(X)[0]?.buyers, w.rowsOf(PAR)[0]?.buyers], [2, 2, 0, 1, 1]);
  assert.deepEqual([w.db.storyStartGet("n:7").source, w.db.storyStartGet(PAR)], ["buyers", { startAt: T0 - 900, source: "wake", firstBuyersAt: T0 }]);
  // only one N coin bought next bucket: N1 was bought within the hour, so N2 stays under its narrative
  w.trade(N2, "e", T0 + B + 1);
  w.wk.wakeOf = (m) => (m === PAR ? { startedAt: T0 + 3 * HOUR, live: true, silent: false, postId: null } : null);
  w.trade(KID, "f", T0 + B + 2);
  w.close(T0 + 2 * B + GRACE_S);
  assert.deepEqual([w.rowsOf("n:7").map((r) => r.buyers), w.rowsOf(PAR).length], [[2, 1], 2]);
  assert.equal(w.db.storyStartGet(PAR).startAt, T0 + 3 * HOUR, "a family's later wake-up moves its start; first_buyers_at stays");
  assert.equal(w.db.storyStartGet(PAR).firstBuyersAt, T0);
  w.end();
});

test("buckets: a narrative whose second coin is bought only now and then keeps one continuous series; it lets go an hour after", () => {
  const w = world();
  const A = w.coin(mintN(34), "AAA", { parent: null }), Bc = w.coin(mintN(35), "BBB", { parent: null });
  w.model.coinRows.narr = { on: true, tagOf: (m) => (m === A || m === Bc ? { id: 7, title: "t", theme: "x" } : null) };
  const per = [];
  for (let i = 0; i < 12; i++) {
    const t = T0 + i * B;
    for (let j = 0; j < 30; j++) w.trade(A, `a${j}`, t + 1 + j);
    if (i % 6 === 5) w.trade(Bc, "b", t + 40);
    w.close(t + B + GRACE_S);
    per.push(w.rowsOf("n:7").at(-1)?.t === t ? w.rowsOf("n:7").at(-1).buyers : 0);
  }
  assert.deepEqual(per, [0, 0, 0, 0, 0, 31, 30, 30, 30, 30, 30, 31], "from the first bucket with 2 coins on, a row every bucket");
  assert.equal(w.att.stories.get("n:7").att.last, 31);
  // B not bought again: on while B is in the hour's window, then held an hour, then let go
  let k = 12;
  const run = (n) => { const out = []; for (let i = 0; i < n; i++, k++) { const t = T0 + k * B; w.trade(A, `a${i}`, t + 1); w.close(t + B + GRACE_S); out.push(w.rowsOf("n:7").at(-1)?.t === t); } return out; };
  assert.deepEqual(run(29), [...Array(22).fill(true), ...Array(7).fill(false)]);
  w.end();
});

test("buckets: a coin and its copy are one coin (no narrative row); bot dust is in the site row but in no story", () => {
  const w = world();
  const C1 = w.coin(mintN(36), "CPY", { parent: null }), C2 = w.coin(mintN(37), "CPY", { parent: null }); // same ticker, same image
  w.model.coinRows.narr = { on: true, tagOf: (m) => (m === C1 || m === C2 ? { id: 9, title: "t", theme: "x" } : null) };
  w.wk.wakeOf = (m) => (m === PAR ? { startedAt: T0 - 900, live: true, silent: false, postId: null } : null);
  const REAL = w.coin(mintN(38), "REAL"), WASH = w.coin(mintN(39), "WASH");
  w.trade(C1, "a", T0 + 1); w.trade(C2, "b", T0 + 2);
  for (let i = 0; i < 15; i++) w.trade(REAL, `r${i}`, T0 + 3, { usd: 20 });
  for (let i = 0; i < 200; i++) w.trade(WASH, `x${i}`, T0 + 4, { usd: 1 }); // $1 a wallet: "tiny"
  w.close(T0 + B + GRACE_S);
  assert.deepEqual(w.rowsOf("n:9"), [], "a coin and its copy alone are no narrative");
  const [fam] = w.rowsOf(PAR), [site] = w.rowsOf(SITE_KEY);
  assert.deepEqual([fam.buyers, fam.coins, fam.leaderMint, site.buyers], [15, 1, REAL, 217], "the wash coin's 200 wallets count on the site only");
  w.end();
});

// ---------------------------------------------------------------- baseline, gates, phase
test("baseline: the median share of site buyers over non-empty, whole buckets older than 1 h; the gates (6 h, 12 buckets, 10 buyers an hour)", () => {
  assert.deepEqual([median([]), median([3, 1, 2]), median([4, 1, 3, 2])], [null, 2, 2.5]);
  const nowS = T0;
  const rows = [];
  for (let i = 80; i >= 1; i--) rows.push({ t: T0 - i * B, buyers: i % 2 ? 2 : 4, siteBuyers: 100, flags: 0 });
  rows[0].flags = PARTIAL; rows[1].buyers = 0;
  const b = baselineOf(rows, nowS);
  assert.equal(b.n, 80 - 12 - 2, "the last 12 buckets (1 h) are left out, so are the partial and the empty one");
  assert.equal(Math.round(b.ratio * 1e9) / 1e9, 0.03);
  assert.equal(b.firstAt, T0 - 80 * B);
  assert.equal(b.peak30, 18, "6 buckets: 3 x 4 + 3 x 2");
  const gate = { base: b, firstBuyersAt: nowS - MIN_HISTORY_S, nowS, last: 6, lastSite: 100, hourBuyers: MIN_HOUR_BUYERS };
  assert.equal(multipleOf(gate), 2);
  assert.equal(multipleOf({ ...gate, firstBuyersAt: nowS - MIN_HISTORY_S + 1 }), null, "under 6 h of history");
  assert.equal(multipleOf({ ...gate, hourBuyers: MIN_HOUR_BUYERS - 1 }), null, "under 10 buyers in the hour");
  assert.equal(multipleOf({ ...gate, base: { ...b, n: MIN_BASE_BUCKETS - 1 } }), null, "under 12 baseline buckets");
  assert.equal(multipleOf({ ...gate, base: { ...b, ratio: null } }), null);
  assert.equal(multipleOf({ ...gate, lastSite: 0 }), null);
  assert.equal(multipleOf({ ...gate, base: { ...b, n: MIN_BASE_BUCKETS } }), 2);
  // a gap the server did not see changes nothing: only buckets with a buyer count
  assert.equal(Math.round(baselineOf(rows.filter((_, j) => j < 30 || j > 31), nowS).ratio * 1e9) / 1e9, 0.03);
});

test("phase: the rule table, in its order (new, rising, peaked, fading, steady)", () => {
  const table = [
    // multiple, last30, prev30, peak30 → phase
    [null, 50, 10, 50, "new"],
    [2, 25, 20, 25, "rising"],         // +25 %, above normal
    [2, 24, 20, 24, "steady"],         // +20 %: not enough
    [0.9, 30, 20, 30, "steady"],       // +50 % but under normal: not rising
    [1.5, 10, 0, 10, "rising"],        // from nothing
    [1.5, 75, 100, 100, "peaked"],     // -25 % but within 30 % of the peak: peaked comes first
    [1.5, 90, 100, 100, "peaked"],
    [1.5, 69, 100, 100, "fading"],     // -31 % and under 70 % of the peak
    [1.5, 45, 40, 100, "fading"],      // rising a little but at 45 % of its peak
    [1.5, 50, 50, 100, "fading"],      // exactly half the peak
    [1.5, 60, 60, 100, "steady"],
    [1.5, 0, 12, 40, "fading"],
    [3, 80, 70, 100, "steady"],        // +14 %: steady
  ];
  for (const [multiple, last30, prev30, peak30, want] of table) assert.equal(phaseOf({ multiple, last30, prev30, peak30 }), want, JSON.stringify({ multiple, last30, prev30, peak30 }));
});

test("close: a story with 7 h of stored history gets its normal, a multiple and a phase; one baseline read, the last hour read back once", () => {
  const w = world();
  const X = idAt(T0 - 9 * HOUR, 3);
  w.posts([X]);
  // 7 h of history: 2 buyers of 100 per bucket
  const hist = [];
  for (let i = 84; i >= 1; i--) hist.push({ key: X, t: T0 - i * B, buyers: 2, siteBuyers: 100, coins: 1 }, { key: SITE_KEY, t: T0 - i * B, buyers: 100, siteBuyers: 100, coins: 50 });
  w.db.storyBucketsPut(hist);
  w.db.storyStartsPut([{ key: X, startAt: T0 - 9 * HOUR, source: "post", firstBuyersAt: T0 - 84 * B }], T0);
  const A = w.coin(mintN(40), "AAA", { parent: null, post: X }), O = w.coin(mintN(41), "OTHER", { parent: null });
  for (let i = 0; i < 6; i++) w.trade(A, `a${i}`, T0 + i);
  for (let i = 0; i < 14; i++) w.trade(O, `o${i}`, T0 + i);
  const reads = [];
  const orig = w.db.storyRows.bind(w.db), origBase = w.db.storyBaseRows.bind(w.db);
  w.db.storyRows = (...a) => { reads.push(a[0]); return orig(...a); };
  w.db.storyBaseRows = (...a) => { reads.push(a[0]); return origBase(...a); };
  w.close(T0 + B + GRACE_S);
  const S = w.att.stories.get(X);
  assert.deepEqual(reads, [SITE_KEY, X], "the site's last hour once (the buckets seen), then one read for its baseline and last hour");
  assert.deepEqual([S.base.ratio, S.base.n, S.att.last, S.att.last30, S.att.prev30, S.att.hour], [0.02, 73, 6, 16, 12, 28]);
  assert.equal(S.att.multiple, 15, "(6 / 20) / 0.02");
  assert.equal(S.att.phase, "rising", "16 vs 12 (+33 %), above normal");
  // the calibration snapshot
  const c = w.db.db.prepare("SELECT * FROM calib WHERE story_key = ?").get(X);
  assert.deepEqual([c.t, c.phase, c.multiple, c.buyers5m, c.hour_buyers, c.leader_mint, c.leader_price_usd, c.filled_1h], [T0, "rising", 15, 6, 28, A, 1e-5, 0]);
  // a second close within 30 min reads no baseline again
  w.trade(A, "z", T0 + B + 1);
  w.close(T0 + 2 * B + GRACE_S);
  assert.deepEqual(reads, [SITE_KEY, X]);
  w.end();
});

test("restart: buckets the server did not see (lost at the stop, down, the partial boot bucket) give no phase, multiple or snapshot until a whole hour was seen", () => {
  const w = world();
  const X = idAt(T0 - 9 * HOUR, 5);
  w.posts([X]);
  // 8 h of a steady story: 20 buyers of 20 per bucket (its normal: a share of 1)
  const hist = [];
  for (let i = 96; i >= 1; i--) hist.push({ key: X, t: T0 - i * B, buyers: 20, siteBuyers: 20, coins: 1 }, { key: SITE_KEY, t: T0 - i * B, buyers: 20, siteBuyers: 20, coins: 1 });
  w.db.storyBucketsPut(hist);
  w.db.storyStartsPut([{ key: X, startAt: T0 - 9 * HOUR, source: "post", firstBuyersAt: T0 - 96 * B }], T0);
  const A = w.coin(mintN(42), "AAA", { parent: null, post: X });
  // the process stopped 4 min into K0 (that bucket is never written), was down through K0 + 1 and came back 4 min into K0 + 2
  const att = (w.model.attention = new Attention({ model: w.model, now: w.clock.now, log: quiet }));
  const got = [];
  for (let k = K0 + 2; k <= K0 + 14; k++) {
    const t0 = k * B + (k === K0 + 2 ? 240 : 1);
    w.clock.t = t0 * 1000;
    for (let j = 0; j < (k === K0 + 2 ? 4 : 20); j++) w.trade(A, `u${j}`, t0 + j);
    w.clock.t = ((k + 1) * B + GRACE_S) * 1000;
    att.closeNow((k + 1) * B + GRACE_S);
    const a = att.stories.get(X).att;
    got.push([a.phase, a.newWhy, a.multiple]);
  }
  assert.equal(att.bootK, K0 + 2);
  assert.deepEqual(got.slice(0, 12), Array(12).fill(["new", "unseen", null]), "no fading for a story whose buying never changed");
  assert.deepEqual(got[12], ["steady", null, 1], "the first close with 12 whole buckets behind it");
  assert.deepEqual(w.db.db.prepare("SELECT t FROM calib").all().map((r) => r.t), [(K0 + 14) * B], "no snapshot over an hour with a hole");
  assert.deepEqual([att.cardAttention({ key: X, kind: "post", coins: [] }, (K0 + 15) * B + 10)].map((x) => [x.phase, x.newWhy]), [["steady", null]]);
  w.end();
});

// ---------------------------------------------------------------- calibration
test("calibration: outcomes 1 h and 6 h after a snapshot: the story's buyers in the hour(s) after it and the leader's price then", () => {
  const w = world();
  const L = w.coin(mintN(50), "LEAD", { parent: null });
  w.db.calibPut([{ key: "n:3", t: T0, phase: "rising", multiple: 2.5, buyers5m: 6, hourBuyers: 20, leaderMint: L, leaderPriceUsd: 1e-5, storyBuyUsd: 50 }]);
  w.db.calibPut([{ key: "n:3", t: T0, phase: "steady", multiple: 1, buyers5m: 0, hourBuyers: 0 }]); // one per story and bucket: ignored
  const rows = [];
  for (let i = 1; i <= 80; i++) rows.push({ key: "n:3", t: T0 + i * B, buyers: i <= 12 ? 1 : 2, siteBuyers: 50 }, { key: SITE_KEY, t: T0 + i * B, buyers: 50, siteBuyers: 50 });
  w.db.storyBucketsPut(rows);
  w.db.insertTrade({ sig: "P1", mint: L, idx: 0, slot: 1, time: T0 + B + HOUR - 30, isBuy: true, user: "p", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 3e-5, valueUsd: 5 }, 1e9);
  w.db.insertTrade({ sig: "P2", mint: L, idx: 0, slot: 2, time: T0 + B + HOUR + 30, isBuy: true, user: "p", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 9e-5, valueUsd: 5 }, 1e9);
  // a close 1 h later (any trade opens a bucket): the 1 h outcome only
  w.clock.t = (T0 + 13 * B + 1) * 1000;
  w.att.record({ mint: L, time: T0 + 13 * B + 1, isBuy: false, valueUsd: 1, user: "q", priceUsd: 2e-5 });
  w.close(T0 + 14 * B + GRACE_S);
  let c = w.db.db.prepare("SELECT * FROM calib").get();
  assert.deepEqual([c.phase, c.buyers_1h, c.price_1h, c.cov_1h, c.filled_1h, c.filled_6h], ["rising", 12, 3e-5, 12, 1, 0], "buckets T0+5min .. T0+65min, all 12 seen; the price at or before T0+65min");
  w.clock.t = (T0 + 73 * B + 1) * 1000;
  w.att.record({ mint: L, time: T0 + 73 * B + 1, isBuy: false, valueUsd: 1, user: "q" });
  w.close(T0 + 74 * B + GRACE_S);
  c = w.db.db.prepare("SELECT * FROM calib").get();
  assert.deepEqual([c.buyers_6h, c.price_6h, c.cov_6h, c.filled_6h], [12 + 60 * 2, 9e-5, 72, 1]);
  // the read-only script's table: an outcome over a window with a bucket not seen whole is left out (and counted)
  const t = calibTable([c, { ...c, phase: "fading", multiple: null }, { ...c, cov_1h: 11, cov_6h: 70 }]);
  assert.deepEqual(t.map((g) => [g.phase, g.band, g.n, g.n1h, g.n6h, g.gaps1h, g.gaps6h, g.nextOverPrev, g.moreNext, r2(g.price1h), r2(g.price6h), g.up6h]),
    [["rising", "2-4x", 2, 1, 1, 1, 1, 0.6, 0, 3, 9, 1], ["fading", "none", 1, 1, 1, 0, 0, 0.6, 0, 3, 9, 1]]);
  // a partial site row or a missing one is not seen
  w.db.storyBucketsPut([{ key: SITE_KEY, t: T0 + 5 * B, buyers: 1, siteBuyers: 1, flags: PARTIAL }]);
  w.db.db.prepare("DELETE FROM story_buckets WHERE story_key = '*' AND t = ?").run(T0 + 6 * B);
  assert.equal(w.db.siteSeenIn(T0 + B, T0 + 13 * B), 10);
  assert.deepEqual([null, 0.5, 1, 3.9, 4].map(bandOf), ["none", "<1x", "1-2x", "2-4x", "4x+"]);
  w.end();
});

// ---------------------------------------------------------------- coin days
test("coin days: high, low and close from priced trades (the newest by time wins), buys and buyers, volume; deltas added at every flush", () => {
  const w = world();
  const A = w.coin(mintN(60), "AAA", { parent: null });
  const D = new Date(T0 * 1000).toISOString().slice(0, 10);
  w.trade(A, "a", T0 + 1, { priceUsd: 1e-5, usd: 10 });
  w.trade(A, "b", T0 + 2, { priceUsd: 3e-5, usd: 10 });
  w.trade(A, "a", T0 + 3, { priceUsd: 0.5e-5, usd: 0.5 });
  w.trade(A, "c", T0 + 9, { priceUsd: 2e-5, usd: 4, isBuy: false });
  w.trade(A, "d", T0 + 8, { priceUsd: 7e-5, usd: 1 });       // arrives late but is older than the sale
  w.trade(A, "e", T0 + 10, { priceUsd: null, usd: 3 });       // no USD price: no high, low or close
  w.close(T0 + B + GRACE_S);
  let [d] = w.db.coinDays(A);
  assert.deepEqual([d.day, d.highUsd, d.lowUsd, d.closeUsd, d.closeT, d.trades, d.buys, d.buyers, d.volumeUsd], [D, 7e-5, 0.5e-5, 2e-5, T0 + 9, 6, 4, 4, 28.5], "buyers: a b d e; buys of $1+: a b d e");
  w.trade(A, "a", T0 + B + 1, { priceUsd: 4e-5, usd: 2 });
  w.trade(A, "f", T0 + B + 2, { priceUsd: 0.1e-5, usd: 2 });
  w.close(T0 + 2 * B + GRACE_S);
  [d] = w.db.coinDays(A);
  assert.deepEqual([d.highUsd, d.lowUsd, d.closeUsd, d.trades, d.buys, d.buyers, d.volumeUsd], [7e-5, 0.1e-5, 0.1e-5, 8, 6, 6, 32.5], "a wallet in two buckets counts in both");
  // a trade of the next UTC day is its own row
  w.clock.t = (T0 + DAY) * 1000;
  w.trade(A, "g", T0 + DAY, { priceUsd: 5e-5 });
  w.close(T0 + DAY + B + GRACE_S);
  assert.deepEqual(w.db.coinDays(A).map((r) => r.day), [D, new Date((T0 + DAY) * 1000).toISOString().slice(0, 10)]);
  w.end();
});

// ---------------------------------------------------------------- events
test("events: keywords (whole words, phrases, name parts), the recorder only while open, pre-existing vs new coins, the rows", () => {
  const { words, flat } = nameWords("Sam Bankman-Fried", "$SBF");
  assert.deepEqual([words, flat], [["sam", "bankman", "fried", "sbf"], "sambankmanfriedsbf"]);
  const kw = { words: ["turkey", "gobble"], phrases: ["know your cat"], parts: ["bankman"] };
  const m = (n, s = "") => matchKeywords(kw, nameWords(n, s));
  assert.deepEqual([m("Turkey Time"), m("TURKEY"), m("Gobbler"), m("Gobble Coin"), m("Know Your Cat"), m("Know Your Customer"), m("SamBankmanFried"), m("Turkeys")], [true, true, false, true, true, false, true, false]);
  assert.deepEqual([offsetS("-7d"), offsetS("+12h"), offsetS("0"), offsetS("30m")], [-7 * DAY, 12 * HOUR, 0, 1800]);
  assert.throws(() => parseEvent({ id: "Bad Id", at: "2026-11-25T00:00:00Z", keywords: { words: ["a"] } }));
  assert.throws(() => parseEvent({ id: "x", at: "2026-11-25T00:00:00Z", keywords: {} }));
  const w = world();
  const at = new Date((T0 + HOUR) * 1000).toISOString();
  w.att.setEvents({ events: [
    { id: "turkey-test", at, keywords: { words: ["turkey"], phrases: ["know your cat"], parts: ["bankman"] } },
    { id: "far-future", at: new Date((T0 + 60 * DAY) * 1000).toISOString(), keywords: { words: ["turkey"] } },
  ] });
  assert.deepEqual(w.att.evOpen.map((e) => e.id), ["turkey-test"]);
  const OLDT = w.coin(mintN(70), "TURKEY", { parent: null, name: "Turkey", createdAt: T0 + HOUR - PRE_EXISTING_S - 1 });
  const CAT = w.coin(mintN(71), "KYC", { parent: null, name: "Know Your Cat", createdAt: T0 - 100 });
  const SBF = w.coin(mintN(72), "SBF", { parent: null, name: "SamBankmanFried", createdAt: null });
  const GOB = w.coin(mintN(73), "GOB", { parent: null, name: "Gobbler" });
  w.trade(OLDT, "a", T0 + 1); w.trade(OLDT, "b", T0 + 2); w.trade(CAT, "a", T0 + 3); w.trade(SBF, "c", T0 + 4, { isBuy: false });
  w.trade(SBF, "d", T0 + 5, { usd: 0.2 }); w.trade(GOB, "e", T0 + 6);
  w.close(T0 + B + GRACE_S);
  const r = w.db.db.prepare("SELECT * FROM event_buckets").all();
  assert.deepEqual(r.map((x) => [x.event_id, x.t, x.buyers, x.pre_buyers, x.new_buyers, x.pre_coins, x.new_coins, x.site_buyers]), [["turkey-test", T0, 2, 2, 1, 1, 2, 3]],
    "a and b on the old coin, a on the new: 2 distinct; the undated SBF counts as new (sold and a $0.20 buy: no buyer)");
  // a bucket with no matching buyer still gets its row while the event records: the site's buyers are kept with the event
  w.trade(GOB, "f", T0 + B + 1);
  w.close(T0 + 2 * B + GRACE_S);
  assert.deepEqual({ ...w.db.db.prepare("SELECT t, buyers, pre_buyers, new_buyers, site_buyers FROM event_buckets WHERE t = ?").get(T0 + B) }, { t: T0 + B, buyers: 0, pre_buyers: 0, new_buyers: 0, site_buyers: 1 });
  // after the window: nothing recorded
  const late = T0 + HOUR + 37 * HOUR;
  w.clock.t = late * 1000; w.att.tick(late);
  assert.deepEqual(w.att.evOpen, []);
  w.trade(OLDT, "z", late + 1);
  w.close(late + B + GRACE_S);
  assert.equal(w.db.db.prepare("SELECT COUNT(*) AS n FROM event_buckets").get().n, 2);
  w.end();
});

test("events: the pre-registered hit rule (share above the comparison days' p90 AND pre-existing coins above their own baseline), and the script", () => {
  const T = T0 + 20 * DAY;
  const ev = parseEvent({ id: "e", at: new Date(T * 1000).toISOString(), keywords: { words: ["x"] } });
  assert.deepEqual([ev.windows.baseline, ev.windows.event, ev.recFrom, ev.recTo], [[T - 7 * DAY, T - 2 * DAY], [T, T + 12 * HOUR], T - 14 * DAY, T + 36 * HOUR]);
  const build = ({ eventBuyers = 5, preEvent = 1, preBase = 0.5, days = 14 } = {}) => {
    const site = new Map(), rows = new Map();
    for (let t = T - days * DAY; t < T + 36 * HOUR; t += B) {
      site.set(t, 100);
      const inEvent = t >= T && t < T + 12 * HOUR;
      rows.set(t, { buyers: inEvent ? eventBuyers : 1, preBuyers: inEvent ? preEvent : preBase, newBuyers: 0 });
    }
    return [rows, site];
  };
  let r = eventResult(ev, ...build());
  assert.deepEqual([r.verdict, r.comparison.length, r.p90, r.event.share, r.preEvent.share, r.preBaseline.share], ["HIT", 14, 0.01, 0.05, 0.01, 0.005]);
  assert.equal(eventResult(ev, ...build({ preEvent: 0.5 })).verdict, "MISS", "pre-existing coins not above their baseline");
  assert.equal(eventResult(ev, ...build({ eventBuyers: 1 })).verdict, "MISS", "not above the p90");
  r = eventResult(ev, ...build({ days: 4 }));
  assert.deepEqual([r.verdict, r.comparison.length], ["NOT ENOUGH DATA", 4], "4 days of rows: 4 comparison days, under the 5 needed");
  // the script over a database: the denominator comes from the event's own rows, so the 14-day trim of the site rows
  // ('*', none here at all) changes nothing however late the script is run
  const db = new Db(":memory:");
  const [rows] = build();
  db.eventBucketsPut([...rows].map(([t, x]) => ({ id: "e", t, buyers: x.buyers, preBuyers: x.preBuyers, newBuyers: 0, preCoins: 1, newCoins: 0, siteBuyers: 100 })));
  const doc = { events: [{ id: "e", at: new Date(T * 1000).toISOString(), keywords: { words: ["x"] } }, { id: "BAD" }] };
  const out = eventResults(db.db, doc, T + 40 * HOUR);
  assert.deepEqual(out.map((x) => [x.id, x.verdict ?? x.error != null]), [["e", "HIT"], ["BAD", true]]);
  assert.deepEqual([eventResults(db.db, doc, T + 30 * DAY)[0].verdict, eventResults(db.db, doc, T + 30 * DAY)[0].comparison.length], ["HIT", 14], "a month later: the same verdict");
  assert.equal(eventResults(db.db, doc, T + HOUR)[0].verdict, "OPEN");
  db.close();
});

// ---------------------------------------------------------------- the API
test("API: story cards carry `attention` (additive), GET /api/story-series/:key with start and normal, 400 for a bad key, health", async () => {
  const w = world();
  const X = idAt(T0 - 120, 4);
  w.posts([X]);
  const A = w.coin(mintN(80), "NEEDLE", { parent: null, post: X, createdAt: T0 - 100 }), C = w.coin(mintN(81), "PIN", { parent: null, post: X, createdAt: T0 - 90 });
  for (let i = 0; i < 4; i++) w.trade(A, `a${i}`, T0 + i);
  w.trade(C, "a0", T0 + 5); w.trade(C, "c1", T0 + 6);
  w.close(T0 + B + GRACE_S);
  w.trade(A, "n1", T0 + B + 10); w.trade(C, "n1", T0 + B + 11); w.trade(C, "n2", T0 + B + 12);
  w.clock.t = (T0 + B + 60) * 1000;
  const app = await serveApp(w);
  try {
    const s = (await app.get("/api/stories")).body;
    const card = s.cards.find((c) => c.key === X);
    assert.ok(card, "the post card");
    assert.deepEqual(Object.keys(card.attention), ["phase", "buyers5m", "multiple", "newWhy", "startAt", "startSource", "minutes", "leader"]);
    assert.deepEqual(card.attention, { phase: "new", buyers5m: { now: 2, last: 5 }, multiple: null, newWhy: "unseen", startAt: T0 - 120, startSource: "post", minutes: 8,
      leader: { mint: A, symbol: "NEEDLE", share: r2(5 / 9) } }, "NEEDLE: 4 + 1 of 9 coin buyers over the two buckets");
    assert.deepEqual(Object.keys(s), ["asOf", "tf", "floor", "floor5m", "candidates", "cards", "loose", "dust", "hidden", "tagging", "themes", "siteBuyers"], "the body's keys are unchanged");
    const ser = await app.get(`/api/story-series/${X}`);
    assert.deepEqual([ser.status, ser.headers.get("cache-control")], [200, "public, max-age=30"]);
    assert.deepEqual(ser.body, { key: X, asOf: T0 + B + 60, bucketS: B, startAt: T0 - 120, startSource: "post", firstBuyersAt: T0, baseline: null,
      buckets: [{ t: T0, buyers: 5, siteBuyers: 5, launchesFast: 2, launches: 2, buyUsd: 30, partial: false }] });
    assert.deepEqual([(await app.get(`/api/story-series/${X}?since=${T0 + 1}`)).body.buckets.length, (await app.get(`/api/story-series/${X}?since=${T0 + B}`)).body.buckets.length], [1, 0], "since counts from the bucket it falls in");
    assert.equal((await app.get(`/api/story-series/${encodeURIComponent("n:5")}`)).body.key, "n:5");
    assert.deepEqual([(await app.get("/api/story-series/abc")).status, (await app.get("/api/story-series/n%3Ax")).status, (await app.get(`/api/story-series/${X}?since=soon`)).status, (await app.get("/api/story-series/%2A")).status], [400, 400, 400, 400]);
    const h = (await app.get("/api/health")).body.attention;
    assert.deepEqual([h.closes, h.stories, h.open, h.errors], [1, 1, 1, 0]);
  } finally { await app.close(); }
  w.end();
});

test("series: two asks seconds apart share one read (the cache key is the asked bucket, not the moving 14-day floor)", () => {
  const w = world();
  const X = idAt(T0 - 600, 6);
  w.db.storyBucketsPut([{ key: X, t: T0 - B, buyers: 3, siteBuyers: 9 }]);
  const reads = [];
  const orig = w.db.storyRows.bind(w.db);
  w.db.storyRows = (...a) => { reads.push(a); return orig(...a); };
  w.clock.t = (T0 + 10) * 1000;
  const b1 = w.att.seriesOf(X);
  w.clock.t = (T0 + 17) * 1000;
  const b2 = w.att.seriesOf(X);
  assert.equal(b1, b2);
  assert.equal(reads.length, 1);
  assert.equal(w.att.seriesOf(X, T0 - B + 7), w.att.seriesOf(X, T0 - B + 100), "a since inside the same bucket: the same entry");
  assert.equal(reads.length, 2);
  assert.deepEqual(b1.buckets.map((r) => r.buyers), [3]);
  w.end();
});

// ---------------------------------------------------------------- bounded work
test("close: bounded work: slices every 64 coins, story rows in transactions of 200, no read of the trades table, memory let go", async () => {
  const db = new Db(":memory:");
  const coins = new Map();
  const N = 6_000;
  for (let i = 0; i < N; i++) coins.set(`M${i}`, { mint: `M${i}`, tracked: true, createdAt: OLD, quoteMint: null });
  const posts = { peek: () => ({ state: "ok", handle: "h", text: "t" }) };
  const metas = new Map([...coins.keys()].map((m, i) => [m, { twitter: `https://x.com/a/status/${1_000_000 + (i % 2500)}` }]));
  const model = { coins, db, metaFor: (c) => metas.get(c.mint), nameOf: () => ({ name: null, symbol: null }), wakeups: { narrative: { posts } }, coinRows: null };
  const clock = fakeClock(NOW * 1000);
  const att = new Attention({ model, now: clock.now, log: quiet });
  att.bootK = -1;
  for (let i = 0; i < N; i++) att.record({ mint: `M${i}`, time: T0 + (i % 290), isBuy: true, valueUsd: 6, user: `w${i % 4000}`, priceUsd: 1e-6 });
  const spied = [];
  for (const k of ["tradesWindow", "tradesSince", "tradesFor", "tradesRange", "volume24hAll", "volume24h", "tradeFirstTime", "lastPriceUsd"]) { const f = db[k].bind(db); db[k] = (...a) => { spied.push(k); return f(...a); }; }
  const chunks = [];
  const put = db.storyBucketsPut.bind(db);
  db.storyBucketsPut = (rows) => { chunks.push(rows.length); return put(rows); };
  clock.t = (T0 + B + GRACE_S) * 1000;
  // stepped by hand: no step may cover more than 64 coins' facts
  const b = att.open.get(K0);
  att.open.delete(K0); att.closedK = K0;
  const gen = att.closeGen(b, T0 + B + GRACE_S);
  let steps = 0, maxMs = 0, r;
  do { const t = performance.now(); r = gen.next(); maxMs = Math.max(maxMs, performance.now() - t); steps++; } while (!r.done);
  assert.ok(steps >= N / 64, `${steps} steps for ${N} coins`);
  assert.ok(maxMs < 250, `longest step ${maxMs.toFixed(1)} ms`);
  assert.deepEqual(spied, [], "the trades table is never read by the close");
  assert.ok(chunks.length >= 2 && chunks.every((n) => n <= CHUNK), `row transactions: ${chunks}`);
  assert.equal(db.storyRows(SITE_KEY, 0)[0].buyers, 4000);
  assert.equal(att.stories.size, ROWS_MAX, "the busiest ROWS_MAX stories are stored and held");
  assert.equal(db.storyRows(SITE_KEY, 0)[0].coins, N);
  // the timer's path: a sliced job, one at a time
  att.record({ mint: "M1", time: T0 + B + 1, isBuy: true, valueUsd: 2, user: "x" });
  clock.t = (T0 + 2 * B + GRACE_S) * 1000;
  const job = att.tick();
  assert.equal(att.tick(), job, "one close at a time");
  await job;
  assert.equal(att.job, null);
  assert.ok(att.stats.maxSliceMs < 250);
  // an hour later with no buyer, every story is let go
  clock.t = (T0 + 14 * B + 1) * 1000;
  att.record({ mint: "M2", time: T0 + 14 * B + 1, isBuy: false, valueUsd: 2, user: "x" });
  att.closeNow(T0 + 15 * B + GRACE_S);
  assert.deepEqual([att.stories.size, att.open.size], [0, 0]);
  assert.ok(SERIES_ROWS === 4032 && FAST_S === 60);
  db.close();
});

const r2 = (x) => Math.round(x * 100) / 100;
