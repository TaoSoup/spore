// Story attention on Discover (web/src/lib/story-attention.ts): the glance line's words (phase, buyers, start, leader,
// multiple), that no phase gets an arrow or forecast words, the chart's mode (times normal vs raw buyers), its points
// (missing buckets as 0, the origin at the start or the first bucket), its geometry and the hover words.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoryAttention, StorySeries } from "../src/lib/api.ts";
const { glance, spanWords, timesWords, tickerWords, chartMode, attSeries, attGeo, nearestAt, pointWords, afterWords, PHASE_TITLE, NEW_TITLE, NORMAL_TITLE } = await import("../src/lib/story-attention.ts");

const NOW = 1_800_000_000, B = 300;
const att = (o: Partial<StoryAttention> = {}): StoryAttention => ({ phase: "rising", buyers5m: { now: 3, last: 12 }, multiple: 2.43, startAt: NOW - 18 * 60, startSource: "post", minutes: 18, leader: { mint: "M", symbol: "NEEDLE", share: 0.314 }, ...o });

test("glance: the phase, the multiple second, buyers · 5 min, first linked / started, the leader with its share", () => {
  const g = glance(att(), NOW)!;
  assert.deepEqual([g.phase, g.muted, g.buyers, g.buyersLabel, g.start, g.leader, g.multiple], ["rising", false, "12", "buyers · 5 min", "first linked 18 min ago", "$NEEDLE leads · 31%", "2.4× its normal"]);
  assert.equal(g.multipleTitle, NORMAL_TITLE);
  assert.match(g.multipleTitle, /share of all buyers on Spore, against its median share over its own history/);
  assert.match(g.buyersTitle, /3 so far in the current 5 minutes/);
  const n = glance(att({ phase: "new", multiple: null, startSource: "buyers", startAt: NOW - 3 * 3600 - 59, leader: null }), NOW)!;
  assert.deepEqual([n.phase, n.muted, n.multiple, n.start, n.leader], ["new", true, null, "started 3 h ago", ""]);
  assert.equal(glance(att({ startSource: "wake", startAt: NOW + 30 }), NOW)!.start, "started just now", "a server a little ahead");
  assert.equal(glance(att({ startAt: null, minutes: null }), NOW)!.start, "");
  assert.equal(glance(att({ startAt: NOW - 400 * 86_400 }), NOW)!.start, "first linked 1 yr ago");
  assert.equal(glance(null, NOW), null, "an older server: no line");
  assert.equal(glance(undefined, NOW), null);
  assert.equal(glance(att({ phase: "bogus" as never }), NOW)!.phase, "new");
  assert.equal(glance(att({ leader: { mint: "M", symbol: "<b>", share: 0.5 } }), NOW)!.leader, "$b leads · 50%", "a ticker is cleaned");
  assert.equal(glance(att({ multiple: 14.6 }), NOW)!.multiple, "15× its normal");
});

test("glance: no 0 next to a leader: with no buyer in the last complete 5 minutes, the current ones so far, labelled so", () => {
  const g = glance(att({ phase: "new", multiple: null, buyers5m: { now: 25, last: 0 }, startAt: NOW - 180, leader: { mint: "M", symbol: "NEEDLE", share: 1 } }), NOW)!;
  assert.deepEqual([g.buyers, g.buyersLabel, g.partial, g.start, g.leader], ["25", "buyers so far · this 5 min", true, "first linked 3 min ago", "$NEEDLE leads · 100%"]);
  assert.match(g.buyersTitle, /so far in the current 5 minutes/);
  const z = glance(att({ buyers5m: { now: 0, last: 0 }, leader: null }), NOW)!;
  assert.deepEqual([z.buyers, z.buyersLabel, z.partial], ["0", "buyers · 5 min", false]);
  assert.deepEqual([glance(att({ buyers5m: { now: 9, last: 4 } }), NOW)!.buyers, glance(att({ buyers5m: { now: 9, last: 4 } }), NOW)!.partial], ["4", false], "a complete count wins");
});

test("glance: a \"new\" story's tooltip names the gate that failed", () => {
  const t = (newWhy: StoryAttention["newWhy"]) => glance(att({ phase: "new", multiple: null, newWhy }), NOW)!.phaseTitle;
  assert.deepEqual([t("history"), t(null), t(undefined), t("quiet"), t("unseen")], [NEW_TITLE.history, NEW_TITLE.history, NEW_TITLE.history, NEW_TITLE.quiet, NEW_TITLE.unseen]);
  assert.match(NEW_TITLE.quiet, /too few buyers in the last hour/);
  assert.match(NEW_TITLE.history, /6 h since its first buyers and 12 earlier 5-minute buckets/);
  assert.equal(glance(att({ phase: "fading", newWhy: "quiet" }), NOW)!.phaseTitle, PHASE_TITLE.fading);
  for (const w of ["history", "quiet", "unseen"] as const) assert.ok(!/[↑↓▲▼⬆⬇]|recover|flatten|will |expect|soon/i.test(NEW_TITLE[w]));
});

test("glance: neutral words for every phase: no arrows, no forecast, fading said as plainly as rising", () => {
  for (const p of ["new", "rising", "peaked", "fading", "steady"] as const) {
    const g = glance(att({ phase: p }), NOW)!;
    const all = [g.phase, g.phaseTitle, g.multiple, g.start, g.leader, g.buyersLabel, g.buyersTitle].join(" ");
    assert.ok(!/[↑↓▲▼⬆⬇]|recover|flatten|will |expect|soon|moon|buy now|opportunit/i.test(all), `${p}: ${all}`);
    assert.equal(PHASE_TITLE[p].split(":")[0].toLowerCase(), p);
  }
});

test("spans, multiples, tickers", () => {
  assert.deepEqual([0, 4.9, 59, 60, 119, 47 * 60, 48 * 60, 59 * 1440, 61 * 1440, 400 * 1440].map(spanWords), ["0 min", "4 min", "59 min", "1 h", "1 h", "47 h", "2 d", "59 d", "2 mo", "1 yr"]);
  assert.deepEqual([0, 0.96, 2.43, 9.94, 10, 12.5].map(timesWords), ["0.0×", "1.0×", "2.4×", "9.9×", "10×", "13×"]);
  assert.deepEqual([tickerWords("NEEDLE"), tickerWords(""), tickerWords(null), tickerWords("$$"), tickerWords("ABCDEFGHIJKLMNOP")], ["$NEEDLE", null, null, null, "$ABCDEFGHIJKL"]);
});

const series = (o: Partial<StorySeries> = {}): StorySeries => ({
  key: "n:1", asOf: NOW - 2400, bucketS: B, startAt: NOW - 3600, startSource: "post", firstBuyersAt: NOW - 3300,
  baseline: { ratio: 0.02, buckets: 40, ready: true },
  buckets: [
    { t: NOW - 3300, buyers: 2, siteBuyers: 100, launchesFast: 1, launches: 2, buyUsd: 10, partial: false },
    { t: NOW - 2700, buyers: 8, siteBuyers: 100, launchesFast: 0, launches: 0, buyUsd: 40, partial: false },
    { t: NOW - 3000, buyers: 4, siteBuyers: 50, launchesFast: 0, launches: 0, buyUsd: 20, partial: false },
  ], ...o,
});

test("chart: mode, points (a missing bucket as 0), origin at the start or the first bucket, the post mark", () => {
  assert.equal(chartMode(series()), "multiple");
  assert.equal(chartMode(series({ baseline: { ratio: 0.02, buckets: 3, ready: false } })), "buyers", "no normal that means something yet");
  assert.equal(chartMode(series({ baseline: null })), "buyers");
  assert.equal(chartMode(null), "buyers");
  const a = attSeries(series(), NOW - 3600);
  assert.deepEqual([a.mode, a.origin, a.originKind], ["multiple", NOW - 3600, "start"]);
  assert.deepEqual(a.points.map((p) => [p.x, Math.round(p.y * 100) / 100, p.buyers]), [[300, 1, 2], [600, 4, 4], [900, 4, 8]], "sorted; y = (buyers / site) / normal");
  assert.equal(a.postX, 0, "the post, one bucket before the first");
  const gap = attSeries(series({ buckets: [series().buckets[0], { ...series().buckets[1], t: NOW - 1500 }] }));
  assert.deepEqual(gap.points.map((p) => [p.x, p.buyers]), [[300, 2], [600, 0], [900, 0], [1200, 0], [1500, 0], [1800, 0], [2100, 8]]);
  const raw = attSeries(series({ baseline: null }));
  assert.deepEqual(raw.points.map((p) => p.y), [2, 4, 8], "raw buyers per 5 min");
  const old = attSeries(series({ startAt: NOW - 365 * 86_400 }), NOW - 365 * 86_400);
  assert.deepEqual([old.originKind, old.origin, old.points[0].x, old.postX], ["first", NOW - 3300, 0, null], "a year-old post does not squeeze the chart");
  assert.deepEqual(attSeries(series({ buckets: [] })).points, []);
});

test("chart: the right edge is the last complete bucket (a quiet story ends on its zeros, never on its last busy bucket); the axis starts at the start so the post is marked", () => {
  const quiet = attSeries(series({ asOf: NOW + 3 * 3600 + 120 }), NOW - 3600);
  const last = quiet.points[quiet.points.length - 1];
  assert.deepEqual([last.t, last.buyers, last.y], [NOW + 3 * 3600 - B, 0, 0], "the bucket still open is left out");
  assert.equal(quiet.points.length, (3 * 3600 + 3300 - B) / B + 1);
  assert.equal(pointWords(quiet, last), "0 buyers · 0.0× normal · +3 h after the start");
  // a post 30 min before the first bucket: the axis starts at it, the line at the first bucket
  const late = attSeries(series({ startAt: NOW - 3300 - 1800 }), NOW - 3300 - 1800);
  assert.deepEqual([late.originKind, late.from, late.postX, late.points[0].x], ["start", 0, 0, 1800]);
  const g = attGeo(late, 400, 120)!;
  assert.deepEqual([g.x0, g.postPx], [0, 4]);
  assert.ok(g.xs[0] > 100, "the line begins at the first bucket, not at the start");
});

test("chart: geometry (the dashed 1× line, the post mark), the nearest point, hover words", () => {
  const a = attSeries(series(), NOW - 3600);
  const g = attGeo(a, 400, 120)!;
  assert.ok(g && g.oneY !== null && g.oneY > 0 && g.oneY < 120);
  assert.ok(!/NaN|Infinity/.test(g.line));
  assert.equal(g.xs.length, 3);
  assert.equal(g.postPx, 4, "the post is left of the first bucket: drawn at the edge");
  assert.equal(attGeo(attSeries(series({ baseline: null })), 400, 120)!.oneY, null, "no 1× line in raw mode");
  assert.equal(attGeo(attSeries(series({ asOf: NOW - 3000, buckets: [series().buckets[0]] })), 400, 120), null, "one complete bucket: no line");
  assert.deepEqual([nearestAt(g.xs, 0), nearestAt(g.xs, 399), nearestAt([], 5)], [0, 2, -1]);
  assert.equal(pointWords(a, a.points[2]), "8 buyers · 4.0× normal · +15 min after the start");
  assert.equal(pointWords(attSeries(series({ baseline: null, startAt: null })), { t: 0, x: 0, y: 1, buyers: 1, siteBuyers: 9 }), "1 buyer · +0 min after the first bucket");
  assert.deepEqual([afterWords(-5), afterWords(7200)], ["", "+2 h"]);
});

test("the card's attention rides through the page's view, filters and one list unchanged; a card without it (an older server) has none", async () => {
  const D = await import("../src/lib/discover.ts");
  const T = 1_770_000_100;
  const row = (mint: string, b: number) => ({ mint, name: mint, symbol: mint, image: null, createdAt: T - 7200, existing: true, mcapUsd: 41_000, priceUsd: 0.000041, sinceStart: null, buyers5m: b,
    tf: { p0: 0.00003, chg: 3, volUsd: 900, buys: 52, sells: 9, buyers: b, holding: 1 }, liqUsd: 5_200, parent: null, family: null });
  const a = att();
  const cards = [
    { kind: "post" as const, key: "1895000000000000001", post: { id: "1895000000000000001", handle: "p", text: "t", at: T - 600, url: "" }, family: null, buyers5m: 0, coinsN: 2, coins: [row("A", 10), row("B", 5)], attention: a },
    { kind: "post" as const, key: "1895000000000000002", post: { id: "1895000000000000002", handle: "p", text: "t", at: T - 600, url: "" }, family: null, buyers5m: 0, coinsN: 2, coins: [row("C", 9), row("D", 4)] },
  ];
  const v = D.storiesView({ asOf: T, tf: "5m", cards, loose: [], dust: [], hidden: { dust: 0 } }, null);
  const r = D.oneList(D.filterStories(v, "all"), T);
  assert.deepEqual(r.entries.map((e) => [e.key, e.card?.attention ?? null]), [["post:1895000000000000001", a], ["post:1895000000000000002", null]]);
  assert.equal(glance(r.entries[1].card?.attention, T), null);
});

test("chartKeyOf: a card of several stories charts all its keys (comma-separated, the server sums them); one story, its key", async () => {
  const { chartKeyOf } = await import("../src/lib/story-attention.ts");
  assert.equal(chartKeyOf({ key: "n:7" }), "n:7");
  assert.equal(chartKeyOf({ key: "n:7", keys: ["n:7"] }), "n:7");
  assert.equal(chartKeyOf({ key: "n:7", keys: ["n:7", "1987238502124409321"] }), "n:7,1987238502124409321");
  // a card of more stories than one request may name: its first SERIES_KEYS_MAX (the server answers 400 past it)
  const { SERIES_KEYS_MAX } = await import("../src/lib/story-attention.ts");
  const many = Array.from({ length: SERIES_KEYS_MAX + 5 }, (_, i) => String(1987238502124409321n + BigInt(i)));
  assert.deepEqual(chartKeyOf({ key: many[0], keys: many }).split(","), many.slice(0, SERIES_KEYS_MAX));
});
