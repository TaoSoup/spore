// The story timeline (lib/timeline.mjs, GET /api/timeline): stories from the stored 5-minute series, listed by their
// busiest bucket, newest start first; second filings (t:, g:) and the site row stay out of the list; rows are read for
// the listed stories only; the query is checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../lib/db.mjs";
import { buildTimeline, timelineQuery, listedKey, MIN_DEFAULT, BUCKET_S, STORIES_MAX } from "../lib/timeline.mjs";

const T = 1_795_500_000 - (1_795_500_000 % 300);
const row = (key, k, buyers, more = {}) => ({ key, t: T + k * BUCKET_S, buyers, buyUsd: buyers * 10, launches: 0, leaderMint: null, leaderBuyers: 0, coins: 1, ...more });
/** What the db gives the builder, from plain rows: the grouped pass and the rows of asked keys (recording which were asked). */
function fromRows(rows, from, to) {
  const by = new Map();
  for (const r of rows) if (r.t >= from && r.t < to) { const p = by.get(r.key); if (!p) by.set(r.key, { key: r.key, peak: r.buyers, firstT: r.t }); else { p.peak = Math.max(p.peak, r.buyers); p.firstT = Math.min(p.firstT, r.t); } }
  const asked = [];
  return { peaks: [...by.values()], asked, rowsOf: (keys) => { asked.push(...keys); return rows.filter((r) => keys.includes(r.key)); } };
}

test("timeline: listed by peak, newest start first, gaps as zeros, the leader with the most leader buyers, carried-over starts marked; rows read for listed stories only", () => {
  const rows = [
    row("n:1", 0, 5), row("n:1", 2, 40, { leaderMint: "B", leaderBuyers: 30, coins: 4 }), row("n:1", 3, 10, { leaderMint: "A", leaderBuyers: 9 }), row("n:1", 1, 3, { leaderMint: "A", leaderBuyers: 2 }),
    row("123", 4, 25, { launches: 2 }),
    row("n:2", 1, 19), // under the default 20: hidden
    row("t:jensen", 2, 500), row("g:huang-jensen", 2, 500), row("*", 2, 900), // second filings and the site row: never listed
  ];
  const src = fromRows(rows, T, T + 3600);
  const starts = (keys) => new Map([["n:1", { startAt: T - 3600, source: "buyers" }]].filter(([k]) => keys.includes(k)));
  const b = buildTimeline({ ...src, siteRows: [{ t: T + 300, buyers: 7 }, { t: T, buyers: 5 }], starts, from: T, to: T + 3600, asOf: T + 3600,
    describe: (k) => ({ kind: k.startsWith("n:") ? "narrative" : "post", title: `story ${k}` }), coinOf: (m) => ({ mint: m, symbol: m.toLowerCase(), name: null, image: null }) });
  assert.equal(b.min, MIN_DEFAULT);
  assert.deepEqual(b.stories.map((s) => s.key), ["123", "n:1"], "the post started at its first bucket (T+20 min), the narrative an hour before the window");
  assert.deepEqual(src.asked.sort(), ["123", "n:1"], "rows were read for the listed stories only");
  const n1 = b.stories[1];
  assert.deepEqual([n1.peak, n1.peakT, n1.coins, n1.buyUsd, n1.carried, n1.startSource], [40, T + 600, 4, 580, true, "buyers"]);
  assert.deepEqual(n1.series, [5, 3, 40, 10]);
  assert.equal(n1.leader.mint, "B");
  assert.equal(n1.title, "story n:1");
  assert.deepEqual([b.stories[0].carried, b.stories[0].startSource, b.stories[0].launches], [false, "first-bucket", 2]);
  assert.deepEqual([b.listed, b.hidden, b.more], [2, 1, 0]);
  assert.deepEqual(b.site, [{ t: T, buyers: 5 }, { t: T + 300, buyers: 7 }]);
  assert.deepEqual(buildTimeline({ ...fromRows(rows, T, T + 3600), from: T, to: T + 3600, min: 5, asOf: 0 }).stories.map((s) => s.key), ["123", "n:2", "n:1"]);
  assert.equal(listedKey("*") || listedKey("t:x") || listedKey("g:x"), false);
});

test("timeline: a stored start after the story's first bucket (a later wake-up) gives way to the first bucket; a story bought from the window's first bucket is carried", () => {
  const starts = () => new Map([["fam", { startAt: T + 20 * 3600, source: "wake" }], ["post", { startAt: T + 3600 + 100, source: "post" }]]);
  const b = buildTimeline({ ...fromRows([row("fam", 12, 30), row("post", 12, 30), row("edge", 0, 30)], T, T + 86400), starts, from: T, to: T + 86400, asOf: 0 });
  const by = Object.fromEntries(b.stories.map((s) => [s.key, s]));
  assert.deepEqual([by.fam.startAt, by.fam.startSource, by.fam.carried], [T + 3600, "first-bucket", false]);
  assert.deepEqual([by.post.startAt, by.post.startSource], [T + 3600 + 100, "post"], "a post time inside its first bucket stands");
  assert.equal(by.edge.carried, true);
});

test("timeline: a series with a gap keeps the gap; a story outside the window is ignored; past STORIES_MAX only the newest are read and the rest counted", () => {
  const b = buildTimeline({ ...fromRows([row("p", 0, 30), row("p", 5, 30), row("q", 20, 99)], T, T + 3600), from: T, to: T + 3600, asOf: 0 });
  assert.deepEqual(b.stories.map((s) => [s.key, s.series]), [["p", [30, 0, 0, 0, 0, 30]]]);
  const many = Array.from({ length: STORIES_MAX + 5 }, (_, i) => row(`k${i}`, i % 200, 30));
  const src = fromRows(many, T, T + 200 * BUCKET_S);
  const m = buildTimeline({ ...src, from: T, to: T + 200 * BUCKET_S, asOf: 0 });
  assert.deepEqual([m.listed, m.more, src.asked.length], [STORIES_MAX, 5, STORIES_MAX]);
});

test("timeline query: defaults to the last 24 h in whole buckets, a lone from to the 24 h after it; bad windows and sizes are refused", () => {
  const now = T + 123;
  assert.deepEqual(timelineQuery({}, now), { from: T + 300 - 86400, to: T + 300, min: MIN_DEFAULT });
  assert.deepEqual(timelineQuery({ from: String(T + 10), to: String(T + 3590), min: "5" }, now), { from: T, to: T + 3600, min: 5 });
  assert.deepEqual(timelineQuery({ from: String(T - 3 * 86400) }, now), { from: T - 3 * 86400, to: T - 2 * 86400, min: MIN_DEFAULT });
  assert.deepEqual(timelineQuery({ from: String(T - 3600) }, now), { from: T - 3600, to: T + 300, min: MIN_DEFAULT });
  for (const q of [{ from: "x" }, { from: String(T), to: String(T) }, { from: String(T - 30 * 3600), to: String(T) }, { from: String(T - 20 * 86400), to: String(T - 19 * 86400) }, { min: "0" }, { min: "1.5" }, { min: "1" }, { min: "50" }])
    assert.ok(timelineQuery(q, now).error, JSON.stringify(q));
});

test("timeline db reads: the grouped pass without the site row and second filings; rows of asked keys in the window; starts of a list of keys", () => {
  const db = new Db(":memory:");
  const put = db.db.prepare("INSERT INTO story_buckets (story_key, t, buyers, buy_usd, sells, launches_fast, launches, site_buyers, leader_mint, leader_buyers, coins, flags) VALUES (?, ?, ?, 1, 0, 0, 0, 0, NULL, 0, 1, 0)");
  for (const [k, t, b] of [["n:1", T, 3], ["n:1", T + 600, 8], ["*", T, 9], ["t:x", T, 4], ["g:y", T, 4], ["55", T + 300, 2], ["n:1", T + 7200, 1]]) put.run(k, t, b);
  assert.deepEqual(db.timelinePeaks(T, T + 3600).sort((a, b) => (a.key < b.key ? -1 : 1)), [{ key: "55", peak: 2, firstT: T + 300 }, { key: "n:1", peak: 8, firstT: T }]);
  assert.deepEqual(db.timelineRowsOf(["n:1"], T, T + 3600).map((r) => [r.key, r.t, r.buyers]), [["n:1", T, 3], ["n:1", T + 600, 8]]);
  assert.deepEqual(db.timelineRowsOf([], T, T + 3600), []);
  db.storyStartsPut([{ key: "n:1", startAt: T - 60, source: "post", firstBuyersAt: T }, { key: "77", startAt: T, source: "buyers", firstBuyersAt: T }], T);
  assert.deepEqual([...db.timelineStarts(["n:1", "nope"])], [["n:1", { startAt: T - 60, source: "post" }]]);
  assert.equal(db.timelineStarts([]).size, 0);
  db.close();
});

test("timeline gates: a listed story carries its story-gate passes (best = highest lift); passes of stories not listed come apart; coin-gate passes with seconds from launch", () => {
  const src = fromRows([row("n:1", 2, 40), row("n:2", 3, 30)], T, T + 3600);
  const storyPasses = [
    { key: "n:1", at: T + 700, title: "one", buyers: 20, lift: 4, inflowSol: 12, coins5: 2, word: "x" },
    { key: "n:1", at: T + 4000 - 3600 + 1800, title: "one", buyers: 25, lift: 9, inflowSol: 15, coins5: 3, word: "x" },
    { key: "t:jensen", at: T + 900, title: "Jensen Huang", buyers: 25, lift: 5.3, inflowSol: 10, coins5: 2, word: "jensen" },
    { key: "n:9", at: T - 10, title: "outside", buyers: 1, lift: 1, inflowSol: 1, coins5: 0, word: null },
  ];
  const coinPasses = [{ mint: "M1", at: T + 100, createdAt: T + 92, outcome: "shadow", symbol: "HUMAN", mcapUsd: 4270 }, { mint: "M2", at: T + 7200, createdAt: T, outcome: "shadow", symbol: "LATE", mcapUsd: 1 }];
  const b = buildTimeline({ ...src, from: T, to: T + 3600, asOf: 0, storyPasses, coinPasses });
  const n1 = b.stories.find((s) => s.key === "n:1");
  assert.deepEqual([n1.gate.passes, n1.gate.firstAt, n1.gate.best.lift, n1.gate.best.buyers], [2, T + 700, 9, 25]);
  assert.equal(b.stories.find((s) => s.key === "n:2").gate, undefined);
  assert.deepEqual(b.gateStories.map((g) => [g.key, g.title, g.passes, g.best.lift]), [["t:jensen", "Jensen Huang", 1, 5.3]]);
  assert.deepEqual(b.gateCoins, [{ mint: "M1", at: T + 100, secs: 8, symbol: "HUMAN", mcapUsd: 4270, outcome: "shadow" }]);
});

test("timeline gates: a story the gate passed is kept past the STORIES_MAX cut", () => {
  const many = Array.from({ length: STORIES_MAX + 3 }, (_, i) => row(`k${i}`, 10 + (i % 150), 30));
  many.push(row("old", 1, 30));
  const src = fromRows(many, T, T + 200 * BUCKET_S);
  const b = buildTimeline({ ...src, from: T, to: T + 200 * BUCKET_S, asOf: 0, storyPasses: [{ key: "old", at: T + 600, title: "old", buyers: 20, lift: 4, inflowSol: 12, coins5: 2, word: null }] });
  assert.equal(b.stories.length, STORIES_MAX);
  assert.ok(b.stories.some((s) => s.key === "old" && s.gate), "the oldest story would be cut, but it passed the gate");
  assert.equal(b.gateStories.length, 0);
});
