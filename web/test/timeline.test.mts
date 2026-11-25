// The story timeline page's view logic (web/src/lib/timeline.ts): day windows in local time, hour groups, words and
// chart geometry. No DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimelineStory } from "../src/lib/api.ts";
const L = await import("../src/lib/timeline.ts");

const story = (key: string, startAt: number, o: Partial<TimelineStory> = {}): TimelineStory => ({
  key, kind: "narrative", title: "T", startAt, startSource: "buyers", carried: false, firstT: startAt, lastT: startAt + 600, peak: 30, peakT: startAt, buyUsd: 0, launches: 0, coins: 2, leader: null, series: [1, 30, 2], ...o,
});

test("timeline view: day choices parse, windows follow local midnight, earlier days go back from two days ago", () => {
  assert.equal(L.parseDay(null), "24h");
  assert.equal(L.parseDay("today"), "today");
  const now0 = new Date(2026, 10, 25, 1, 30).getTime();
  assert.equal(L.parseDay("2026-11-20", now0), "d:2026-11-20");
  assert.equal(L.parseDay("2026-11-25", now0), "today");
  assert.equal(L.parseDay("2026-11-24", now0), "yesterday");
  for (const bad of ["2026-13-99x", "2026-02-31", "2026-11-26", "2026-11-01", "2026-11-1"]) assert.equal(L.parseDay(bad, now0), "24h", bad);
  assert.equal(L.parseDay("2026-11-11", now0), "d:2026-11-11", "14 days back is the oldest");
  assert.equal(L.dayParam("d:2026-11-20"), "2026-11-20");
  const now = new Date(2026, 10, 25, 1, 30).getTime(), nowS = Math.floor(now / 1000);
  const mid = new Date(2026, 10, 25).getTime() / 1000;
  assert.deepEqual(L.windowOf("24h", now), { from: nowS - 86400, to: nowS });
  assert.deepEqual(L.windowOf("today", now), { from: mid, to: nowS });
  assert.deepEqual(L.windowOf("yesterday", now), { from: new Date(2026, 10, 24).getTime() / 1000, to: mid });
  assert.deepEqual(L.windowOf("d:2026-11-20", now), { from: new Date(2026, 10, 20).getTime() / 1000, to: new Date(2026, 10, 21).getTime() / 1000 });
  assert.equal(L.earlierDays(now).length, 13);
  const e = L.earlierDays(now, 4);
  assert.deepEqual(e.map((d) => d.key), ["d:2026-11-23", "d:2026-11-22", "d:2026-11-21"]);
  assert.equal(L.parseMin("100"), "100"); assert.equal(L.parseMin("7"), "20");
});

test("timeline view: hour groups newest first, carried stories last by peak; words; spark and band geometry", () => {
  const h = new Date(2026, 10, 24, 19).getTime() / 1000;
  const g = L.hourGroups([story("a", h + 60), story("b", h + 3700), story("c", h - 7200, { carried: true, peak: 5 }), story("d", h - 7200, { carried: true, peak: 50 }), story("e", h + 1800)]);
  assert.deepEqual(g.map((x) => x.stories.map((s) => s.key)), [["b"], ["a", "e"], ["d", "c"]]);
  assert.equal(g[1].label, "19:00 – 20:00");
  assert.equal(g[2].key, "before");
  assert.equal(L.spanWords({ firstT: 0, lastT: 7500 }), "2 h 10 m");
  assert.equal(L.spanWords({ firstT: 0, lastT: 0 }), "5 m");
  assert.equal(L.titleOf(story("p", 0, { kind: "post", handle: null, title: "An X post" })), "An X post (not stored)");
  assert.equal(L.titleOf(story("p", 0, { kind: "post", handle: "elon", title: "hi" })), "hi");
  assert.equal(L.sparkPath([], 96, 26), "");
  assert.match(L.sparkPath([0, 10], 96, 26), /^M0\.0,25\.0L96\.0,1\.0$/);
  const b = L.bandGeo({ from: 0, to: 3600, site: [{ t: 0, buyers: 10 }, { t: 1800, buyers: 20 }], stories: [story("x", 1800, { peak: 100 }), story("y", 0, { carried: true })] }, 360, 80);
  assert.equal(b.marks.length, 1);
  assert.equal(b.marks[0].x, 180);
  assert.ok(b.area.startsWith("M0.0,80") && b.area.endsWith("Z"));
  assert.equal((b.area.match(/M/g) ?? []).length, 2, "a gap between buckets splits the band into two pieces");
  assert.equal((L.bandGeo({ from: 0, to: 3600, site: [{ t: 0, buyers: 1 }, { t: 300, buyers: 2 }], stories: [] }, 360, 80).area.match(/M/g) ?? []).length, 1);
  const day = new Date(2026, 10, 24, 1, 15).getTime() / 1000, ticks = L.axisTicks(day, day + 86400);
  assert.deepEqual(ticks.map((t) => t.text), ["03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00", "Wed 25"]);
  assert.ok(ticks.every((t) => t.at > 0 && t.at < 1));
  assert.deepEqual(L.axisTicks(day, day + 3 * 3600).map((t) => t.text), ["01:30", "02:00", "02:30", "03:00", "03:30", "04:00"]);
  assert.deepEqual(L.nearestSite([{ t: 0, buyers: 1 }, { t: 300, buyers: 2 }], 320), { t: 300, buyers: 2 });
  assert.equal(L.nearestSite([{ t: 0, buyers: 1 }, { t: 900, buyers: 2 }], 500), null, "inside a gap: nothing recorded");
});

test("timeline view: gate passes by local hour; hours with only gate passes still get a group; words", () => {
  const h = new Date(2026, 10, 25, 3).getTime() / 1000;
  const coins = [{ mint: "A", at: h + 100, secs: 8, symbol: "A", mcapUsd: 4000, outcome: "shadow" as const }, { mint: "B", at: h + 3700, secs: 90, symbol: "B", mcapUsd: 9000, outcome: "promoted" as const }];
  const g = L.gateHours({ gateCoins: coins, gateStories: [{ key: "t:j", title: "Jensen", passes: 1, firstAt: h + 200, best: { at: h + 200, buyers: 25, lift: 5.3, inflowSol: 10, coins5: 2, word: "jensen" } }] });
  assert.deepEqual([...g.keys()].sort(), [h, h + 3600]);
  assert.deepEqual(g.get(h)!.coins.map((c) => c.mint), ["A"]);
  assert.equal(g.get(h)!.stories[0].key, "t:j");
  const groups = L.hourGroups([story("s", h + 3700)], g.keys());
  assert.deepEqual(groups.map((x) => [x.t, x.stories.length]), [[h + 3600, 1], [h, 0]]);
  assert.equal(L.gateWords({ best: { lift: 5.3, buyers: 25 } }), "5.3× normal · 25 buyers");
  assert.deepEqual([L.secsWords(8), L.secsWords(90), L.secsWords(3900), L.secsWords(null)], ["8 s", "2 min", "1 h 5 min", "—"]);
});
