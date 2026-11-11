// The map's last-trade filter (lib/map/visibility.ts, the Key's "Last trade" toggles): ?last= parsing and writing,
// masks, the classes at their edges (and their parity with the engine's heatClass), the bucket counts and the levels
// (shown / anchor / hidden) with their anchors and pins; what the highlight chips count (litTest); the classic map's
// bits running ahead of the page's 2 s old levels (map/store.ts applyLevels / revealUp / revealOnTrade); the one heat the
// page and the WebGL engine share on a warm reopen (lib/map/heat.ts warmHeat / useMapHeat).
//
//   node --import tsx --test test/map-visibility.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  LAST_ALL, LAST_DEFAULT, LAST_EDGES, LAST_KEYS, NEWBORN_S, classOfAge, coinClass, formatLast, lastClass, lastCounts, lastKeysOf, lastMask, lastShownOf, lastTag, litTest, parseLast, visibleLevels, visibleTest,
  type LastKey,
} from "../src/lib/map/visibility.ts";
import { heatClass } from "../src/components/map3/engine/tokens.js";
import { WARM_HEAT_MS, applyTrade, rememberHeat, useMapHeat, warmHeat, type HeatIndex, type HeatRow } from "../src/lib/map/heat.ts";
import { F_ANCHOR, F_HIDDEN, F_OURS, MapStore, applyLevels, revealOnTrade, revealUp } from "../src/components/map/store.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";

// an old poll on purpose: the classes run on heat.at, never on the wall clock
const AT = 1_700_000_000;
const node = (mint: string, parentMint: string | null, depth: number, o: Partial<BubbleNode> = {}): BubbleNode => ({
  mint, parentMint, depth, name: `${mint} coin`, symbol: mint.toUpperCase(), image: null, mcapUsd: 500, lockedUsd: null, children: 0, migrated: false, createdAt: AT - 30 * 86_400, ...o,
});
const row = (last: number): HeatRow => ({ t1h: 0, n24: 1, v24: 0, last, buys1h: 0 });
const heatOf = (ages: Record<string, number>, at = AT): HeatIndex => ({ at, version: 1, rows: new Map(Object.entries(ages).map(([m, a]) => [m, row(at - a)])) });

// ---------------------------------------------------------------- parse / format
test("parseLast: default, all, canonical order, garbage and empty never give an empty set", () => {
  assert.deepEqual(parseLast(null), ["30m", "3h", "24h"]);
  assert.deepEqual(parseLast("all"), ["30m", "3h", "24h", "old"]);
  assert.deepEqual(parseLast(" ALL "), ["30m", "3h", "24h", "old"]);
  assert.deepEqual(parseLast("old,30m"), ["30m", "old"]);
  assert.deepEqual(parseLast("24h,24h, 3h"), ["3h", "24h"]);
  assert.deepEqual(parseLast(""), [...LAST_DEFAULT]);
  assert.deepEqual(parseLast(","), [...LAST_DEFAULT]);
  assert.deepEqual(parseLast("nope,1d"), [...LAST_DEFAULT]);
  assert.deepEqual(parseLast("old"), ["old"]);
  // a fresh array each time: a caller may mutate it
  const a = parseLast(null); a.push("old");
  assert.deepEqual(parseLast(null), ["30m", "3h", "24h"]);
});
test("formatLast: the default deletes the param, all four write 'all', else the canonical list", () => {
  assert.equal(formatLast(["30m", "3h", "24h"]), null);
  assert.equal(formatLast(["24h", "3h", "30m"]), null);
  assert.equal(formatLast([]), null);
  assert.equal(formatLast(["old", "24h", "30m", "3h"]), "all");
  assert.equal(formatLast(["old", "30m"]), "30m,old");
  assert.equal(formatLast(["3h", "3h"]), "3h");
});
test("parse ∘ format is the identity on every non-empty subset", () => {
  for (let m = 1; m <= LAST_ALL; m++) {
    const keys = lastKeysOf(m);
    const back = parseLast(formatLast(keys));
    assert.deepEqual(back, keys, `mask ${m}`);
    assert.equal(lastMask(back), m);
  }
});
test("lastMask / lastKeysOf: bit k = class k", () => {
  assert.equal(lastMask(["30m"]), 1);
  assert.equal(lastMask(["3h"]), 2);
  assert.equal(lastMask(["24h"]), 4);
  assert.equal(lastMask(["old"]), 8);
  assert.equal(lastMask([...LAST_DEFAULT]), 7);
  assert.equal(lastMask([...LAST_KEYS]), LAST_ALL);
  assert.equal(lastMask(["old", "old"] as LastKey[]), 8);
  assert.deepEqual(lastKeysOf(5), ["30m", "24h"]);
});
test("lastTag: none for all, ≤ for a prefix, else the short words", () => {
  assert.equal(lastTag([...LAST_KEYS]), null);
  assert.equal(lastTag([...LAST_DEFAULT]), "≤ 24 h");
  assert.equal(lastTag(["30m", "3h"]), "≤ 3 h");
  assert.equal(lastTag(["30m"]), "≤ 30 min");
  assert.equal(lastTag(["old"]), "older");
  assert.equal(lastTag(["3h", "old"]), "3 h · older");
});

// ---------------------------------------------------------------- classes
test("classOfAge: the edges are inclusive, as the engine's heatClass", () => {
  const ages = [0, 1, 1_799, 1_800, 1_801, 10_799, 10_800, 10_801, 86_399, 86_400, 86_401, 10 * 86_400, Infinity];
  for (const a of ages) assert.equal(classOfAge(a), heatClass(a), `age ${a}`);
  assert.deepEqual([...LAST_EDGES], [1_800, 10_800, 86_400]);
  assert.equal(classOfAge(1_800), 0);
  assert.equal(classOfAge(1_801), 1);
  assert.equal(classOfAge(86_400), 2);
  assert.equal(classOfAge(86_401), 3);
});
test("lastClass: age from heat.at (not the wall clock), no row / no heat / no trade → 3, a trade after the poll → 0", () => {
  const heat = heatOf({ a: 1_800, b: 1_801, c: 10_800, d: 86_400, e: 86_401 });
  assert.equal(lastClass("a", heat), 0);
  assert.equal(lastClass("b", heat), 1);
  assert.equal(lastClass("c", heat), 1);
  assert.equal(lastClass("d", heat), 2);
  assert.equal(lastClass("e", heat), 3);
  assert.equal(lastClass("missing", heat), 3);
  assert.equal(lastClass("a", null), 3);
  heat.rows.set("never", row(0));
  assert.equal(lastClass("never", heat), 3);
  heat.rows.set("later", row(AT + 40)); // a live trade bumped the row after the poll
  assert.equal(lastClass("later", heat), 0);
  // parity with the engine for every age class at this poll
  for (const [m, r] of heat.rows) if (r.last > 0) assert.equal(lastClass(m, heat), heatClass(Math.max(0, AT - r.last)), m);
});
test("coinClass: a coin born in the last 30 min counts as 30 min before its heat row", () => {
  const heat = heatOf({ old: 5 * 86_400 });
  assert.equal(coinClass(node("fresh", null, 0, { createdAt: AT - 60 }), heat), 0);
  assert.equal(coinClass(node("edge", null, 0, { createdAt: AT - NEWBORN_S }), heat), 0);
  assert.equal(coinClass(node("past", null, 0, { createdAt: AT - NEWBORN_S - 1 }), heat), 3);
  assert.equal(coinClass(node("old", null, 0, { createdAt: AT - 60 }), heat), 0, "born now, an old row: born wins");
  assert.equal(coinClass(node("nil", null, 0, { createdAt: null }), heat), 3);
  assert.equal(coinClass(node("fresh", null, 0, { createdAt: AT - 60 }), null), 3, "no heat: no clock either");
});
test("lastCounts / lastShownOf: one bucket per node", () => {
  const nodes = [node("a", null, 0), node("b", "a", 1), node("c", "a", 1), node("d", "c", 2), node("e", null, 0), node("f", "e", 1, { createdAt: AT - 10 })];
  const heat = heatOf({ a: 60, b: 3_600, c: 50_000, d: 4 * 86_400 });
  const c = lastCounts(nodes, heat);
  assert.deepEqual(c, [2, 1, 1, 2]);
  assert.equal(c.reduce((x, y) => x + y, 0), nodes.length);
  assert.equal(lastShownOf(c, 7), 4);
  assert.equal(lastShownOf(c, LAST_ALL), 6);
  assert.equal(lastShownOf(c, 8), 2);
  assert.deepEqual(lastCounts(nodes, null), [0, 0, 0, 6]);
});

// ---------------------------------------------------------------- levels
//   USDC (listed asset top) ─ p ─ p1 (hot), p2 (cold)
//   root ─ a ─ a1 ─ a11 (hot)       root ─ b (cold)       lone (cold)
function forest() {
  const nodes = [
    node("usdc", null, 0, { asset: true }), node("p", "usdc", 1), node("p1", "p", 2), node("p2", "p", 2),
    node("root", null, 0), node("a", "root", 1), node("a1", "a", 2), node("a11", "a1", 3), node("b", "root", 1),
    node("lone", null, 0),
  ];
  const byMint = new Map(nodes.map((n) => [n.mint, n]));
  const heat = heatOf({ p1: 120, a11: 7_200, a: 50_000, b: 3 * 86_400 });
  return { nodes, byMint, heat };
}
test("visibleLevels: all four or no heat → null (nothing hidden); anchors climb to the family top, assets included", () => {
  const { nodes, byMint, heat } = forest();
  assert.equal(visibleLevels(nodes, byMint, LAST_ALL, heat), null);
  assert.equal(visibleLevels(nodes, byMint, 7, null), null, "no heat yet: the map never goes blank");
  const lv = visibleLevels(nodes, byMint, 7, heat)!;
  assert.equal(lv.get("p1"), "shown");
  assert.equal(lv.get("p"), "anchor");
  assert.equal(lv.get("usdc"), "anchor", "a listed-asset top anchors its shown coins");
  assert.equal(lv.get("a11"), "shown");
  assert.equal(lv.get("a1"), "anchor");
  assert.equal(lv.get("a"), "shown", "a 24 h coin is shown itself, not an anchor");
  assert.equal(lv.get("root"), "anchor");
  for (const m of ["p2", "b", "lone"]) assert.equal(lv.has(m), false, `${m} hidden`);
  assert.equal(lv.size, 7);
  const vis = visibleTest(lv)!;
  assert.equal(vis("a1"), true);
  assert.equal(vis("b"), false);
  assert.equal(visibleTest(null), null);
});
test("visibleLevels: only the 30 min bucket; only 'older'", () => {
  const { nodes, byMint, heat } = forest();
  const hot = visibleLevels(nodes, byMint, 1, heat)!;
  assert.deepEqual([...hot.entries()].sort(), [["p", "anchor"], ["p1", "shown"], ["usdc", "anchor"]]);
  const cold = visibleLevels(nodes, byMint, 8, heat)!;
  for (const m of ["usdc", "p", "p2", "root", "b", "lone", "a1"]) assert.equal(cold.get(m), "shown", m);
  assert.equal(cold.get("a"), "anchor", "a 24 h coin above a cold one anchors it");
  assert.equal(cold.has("a11"), false);
  assert.equal(cold.has("p1"), false);
});
test("visibleLevels: pins are shown with their lineage, an off-map pin too", () => {
  const { nodes, byMint, heat } = forest();
  const lv = visibleLevels(nodes, byMint, 1, heat, ["b", "root"])!;
  assert.equal(lv.get("b"), "shown");
  assert.equal(lv.get("root"), "shown");
  assert.equal(lv.has("a"), false, "a pin anchors nothing below it");
  const off = visibleLevels(nodes, byMint, 1, heat, ["not-drawn"])!;
  assert.equal(off.get("not-drawn"), "shown");
  // a pinned cold coin whose parent is not pinned still brings its lineage as anchors
  const lone = visibleLevels(nodes, byMint, 1, heat, ["p2"])!;
  assert.equal(lone.get("p2"), "shown");
  assert.equal(lone.get("p"), "anchor");
});
test("visibleLevels: a newborn is shown while the 30 min bucket is on; a parent cycle cannot hang the walk", () => {
  const { nodes, byMint, heat } = forest();
  const baby = node("baby", "b", 2, { createdAt: AT + 5 });
  const all = [...nodes, baby];
  const m2 = new Map(byMint); m2.set("baby", baby);
  const lv = visibleLevels(all, m2, 1, heat)!;
  assert.equal(lv.get("baby"), "shown");
  assert.equal(lv.get("b"), "anchor");
  assert.equal(lv.get("root"), "anchor");
  assert.equal(visibleLevels(all, m2, 2, heat)!.has("baby"), false, "the 30 min bucket off: a newborn hides like any coin");
  const x = node("x", "y", 1), y = node("y", "x", 1);
  const cyc = visibleLevels([x, y], new Map([["x", x], ["y", y]]), 1, { at: AT, version: 1, rows: new Map([["x", row(AT - 10)]]) })!;
  assert.equal(cyc.get("x"), "shown");
  assert.equal(cyc.get("y"), "anchor");
});

// ---------------------------------------------------------------- what the highlight chips count
test("litTest: shown coins and pins light up, an anchor (drawn dim) does not; no levels → no test", () => {
  const { nodes, byMint, heat } = forest();
  const lv = visibleLevels(nodes, byMint, 1, heat)!; // p1 shown; p and usdc anchors; the rest hidden
  assert.equal(litTest(null), null);
  assert.equal(litTest(null, ["p2"]), null, "the filter off: everything lights up, pins or not");
  const lit = litTest(lv)!;
  assert.equal(lit("p1"), true);
  assert.equal(lit("p"), false, "an anchor matches nothing: it is drawn dim");
  assert.equal(lit("usdc"), false);
  assert.equal(lit("b"), false);
  const vis = visibleTest(lv)!;
  assert.equal(vis("p"), true, "the arrow walk still steps onto an anchor");
  // a selected cold coin (the page's pins: its lineage) lights up although its bucket is off
  const pinned = litTest(lv, ["b", "root"])!;
  assert.equal(pinned("b"), true);
  assert.equal(pinned("root"), true);
  assert.equal(pinned("p"), false);
  assert.equal(nodes.filter((n) => pinned(n.mint)).length, 3);
});

// ---------------------------------------------------------------- the classic map's bits (map/store.ts)
//   forest() as a MapStore (parent[] from rebuildLinks), lone flagged ours: the filter's bits must leave it alone
function classic(extra: ReturnType<typeof node>[] = []) {
  const { nodes, byMint, heat } = forest();
  const all = [...nodes, ...extra];
  const st = new MapStore();
  for (const n of all) st.add(n, 0, 0, 5, 0, n.mint === "lone" ? F_OURS : 0);
  st.rebuildLinks();
  const i = (m: string) => st.idx.get(m)!;
  const bits = (m: string) => st.flags[i(m)] & (F_HIDDEN | F_ANCHOR);
  const level = (m: string) => (bits(m) & F_HIDDEN ? "hidden" : bits(m) & F_ANCHOR ? "anchor" : "shown");
  const cnt = { hidden: -1, anchors: -1 };
  const count = () => { let h = 0, a = 0; for (let k = 0; k < st.n; k++) { if (st.flags[k] & F_HIDDEN) h++; else if (st.flags[k] & F_ANCHOR) a++; } return { hidden: h, anchors: a }; };
  return { nodes, byMint, heat, st, i, level, cnt, count };
}
test("applyLevels: the page's levels as bits, pins on top; the filter off clears every bit, other flags untouched", () => {
  const { nodes, byMint, heat, st, level, cnt, count } = classic();
  const lv = visibleLevels(nodes, byMint, 7, heat)!;
  applyLevels(st, lv, [], 7, heat, cnt);
  for (const n of nodes) assert.equal(level(n.mint), lv.get(n.mint) ?? "hidden", n.mint);
  assert.deepEqual(cnt, count());
  assert.deepEqual(cnt, { hidden: 3, anchors: 4 });
  applyLevels(st, lv, ["b", "root"], 7, heat, cnt);
  assert.equal(level("b"), "shown", "a pin is shown whatever its bucket");
  assert.equal(level("root"), "shown");
  assert.deepEqual(cnt, count());
  applyLevels(st, null, [], LAST_ALL, heat, cnt);
  for (const n of nodes) assert.equal(level(n.mint), "shown", n.mint);
  assert.deepEqual(cnt, { hidden: 0, anchors: 0 });
  assert.equal(st.flags[st.idx.get("lone")!], F_OURS, "the filter's bits only");
});
test("applyLevels: a coin the stale levels hide is shown with its lineage once its live class is in the mask (a trade since, a newborn)", () => {
  // a newborn appended live under b (cold, hidden), and a trade on lone (cold), both after the page computed its levels
  const baby = node("baby", "b", 2, { createdAt: AT + 30 });
  const { nodes, byMint, heat, st, level, cnt, count } = classic([baby]);
  const stale = visibleLevels(nodes, byMint, 7, heat)!; // from before: no baby, lone hidden
  assert.equal(stale.has("baby"), false);
  applyTrade(heat.rows, { mint: "lone", time: AT + 20, isBuy: true, valueUsd: 5 }, AT + 20);
  applyLevels(st, stale, [], 7, heat, cnt);
  assert.equal(level("baby"), "shown", "a newborn is class 0: shown at once, never hidden by the stale levels");
  assert.equal(level("b"), "anchor", "its hidden parent anchors it");
  assert.equal(level("root"), "anchor");
  assert.equal(level("lone"), "shown", "a coin that traded since the levels were made");
  assert.equal(level("p2"), "hidden", "a coin still cold stays hidden");
  assert.deepEqual(cnt, count());
  // the 30 min bucket off: neither shows ahead of the levels
  applyLevels(st, visibleLevels(nodes, byMint, 6, heat)!, [], 6, heat, cnt);
  assert.equal(level("baby"), "hidden");
  assert.equal(level("lone"), "hidden");
  assert.deepEqual(cnt, count());
});
test("applyLevels: an anchor whose own class is now in the mask is shown (not dim) ahead of the levels", () => {
  const { nodes, byMint, heat, st, level, cnt, count } = classic();
  const lv = visibleLevels(nodes, byMint, 1, heat)!; // p anchors p1
  assert.equal(lv.get("p"), "anchor");
  heat.rows.set("p", { t1h: 1, n24: 1, v24: 0, last: AT, buys1h: 0 });
  applyLevels(st, lv, [], 1, heat, cnt);
  assert.equal(level("p"), "shown");
  assert.equal(level("usdc"), "anchor");
  assert.deepEqual(cnt, count());
});
test("revealUp / revealOnTrade: a trade shows a hidden coin and turns its hidden ancestors into anchors, O(depth), counts kept", () => {
  const { nodes, byMint, heat, st, i, level, cnt, count } = classic();
  applyLevels(st, visibleLevels(nodes, byMint, 1, heat)!, [], 1, heat, cnt); // only p1 (+ p, usdc as anchors)
  for (const m of ["a11", "a1", "a", "root", "b"]) assert.equal(level(m), "hidden", m);
  // the 30 min bucket off: a trade changes nothing
  assert.equal(revealOnTrade(st.flags, st.parent, i("a11"), 6, cnt), false);
  assert.equal(level("a11"), "hidden");
  assert.equal(revealOnTrade(st.flags, st.parent, i("a11"), 1, cnt), true);
  assert.equal(level("a11"), "shown");
  for (const m of ["a1", "a", "root"]) assert.equal(level(m), "anchor", m);
  assert.equal(level("b"), "hidden", "a sibling branch stays hidden");
  assert.deepEqual(cnt, count());
  // an anchor that trades is shown itself; a shown coin is left alone
  assert.equal(revealOnTrade(st.flags, st.parent, i("a1"), 1, cnt), true);
  assert.equal(level("a1"), "shown");
  assert.equal(level("a"), "anchor");
  assert.equal(revealOnTrade(st.flags, st.parent, i("a11"), 1, cnt), false);
  assert.deepEqual(cnt, count());
  // a parent cycle cannot hang the walk
  const flags = new Uint8Array([F_HIDDEN, F_HIDDEN]), parent = new Int32Array([1, 0]), c = { hidden: 2, anchors: 0 };
  assert.equal(revealUp(flags, parent, 0, c), true);
  assert.deepEqual([...flags], [0, F_ANCHOR]);
  assert.deepEqual(c, { hidden: 0, anchors: 1 });
});

// ---------------------------------------------------------------- one heat for the page and the engine
test("warmHeat: the last index published is a start for the next mount while younger than WARM_HEAT_MS; null forgets it", () => {
  const h = heatOf({ a: 60 });
  try {
    rememberHeat(h, 1_000);
    assert.equal(warmHeat(1_000), h);
    assert.equal(warmHeat(1_000 + WARM_HEAT_MS - 1), h);
    assert.equal(warmHeat(1_000 + WARM_HEAT_MS), null, "too old: the next mount waits for its poll");
    rememberHeat(null, 2_000);
    assert.equal(warmHeat(2_000), null, "a 404 (no heat route) forgets it");
  } finally { rememberHeat(null); }
});
test("useMapHeat: a warm reopen starts from the cached index, so the page's filter and the engine's build agree at once", () => {
  let got: HeatIndex | null | undefined;
  const Probe = ({ enabled }: { enabled: boolean }) => { got = useMapHeat(enabled); return null; };
  const h = heatOf({ a: 60 });
  try {
    rememberHeat(null);
    renderToString(createElement(Probe, { enabled: true }));
    assert.equal(got, null, "a cold open: null until the first poll");
    rememberHeat(h);
    renderToString(createElement(Probe, { enabled: true }));
    assert.equal(got, h, "a warm reopen: the previous mount's index from the first render");
    renderToString(createElement(Probe, { enabled: false }));
    assert.equal(got, null, "a disabled hook never starts from it");
    rememberHeat(h, performance.now() - WARM_HEAT_MS - 1);
    renderToString(createElement(Probe, { enabled: true }));
    assert.equal(got, null, "an index older than WARM_HEAT_MS is not used");
  } finally { rememberHeat(null); }
});
