// The compact layout under the Key's last-trade filter (2026-11-10): the WebGL map is BUILT from the filtered set (the shown
// coins, their lineage, the pins) so every family is laid out compactly around what is shown.
//   1. Pure: lib/map/visibility.ts buildSet (the build input), adapter.ts familyTotals (whole-family numbers), shouldRebuild's
//      filtered branch, diffNodes' wanted / wantMax / pageParents.
//   2. data.js ingest with EngineOptions.compact: chips, shares, ranks, sizes, ghosts equal the full ingest's.
//   3. The engine headless (test/map3-headless.mts), built from buildSet's set: live reveals (no fanfare, chains top-down,
//      the build's mask, capacity, left-out families, heat rows of mints the page does not hold), births, drift accounting,
//      stable seeds across filtered builds, picking, the readability probe, the heat colour of a coin added live.
//   npx tsx --test test/map3-compact.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSet, visibleLevels, coinClass } from "../src/lib/map/visibility.ts";
import { buildRoots, diffNodes, createDiffState, familyTotals, filteredUnknown, keepsOrder, movedFor, movedLanded, quickAfterCache, revealWanted, shouldRebuild, valueFns, valueFn, type DriftInput, type MovedMaps } from "../src/components/map3/adapter.ts";
import type { HeatIndex } from "../src/lib/map/heat.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";
import { mountHeadless, type Any } from "./map3-headless.mts";
// @ts-expect-error plain JS engine module
import { ingest } from "../src/components/map3/engine/data.js";
// @ts-expect-error plain JS engine module
import { visLevels } from "../src/components/map3/engine/vis.js";

const T0 = Date.parse("2026-11-10T12:00:00Z") / 1000;

// ---------- fixture: a page node list ----------

const node = (mint: string, parentMint: string | null, v: number, o: Partial<BubbleNode> = {}): BubbleNode => ({
  mint, parentMint, depth: 0, name: null, symbol: mint.toUpperCase(), image: null, mcapUsd: v * 10, lockedUsd: v, children: 0, migrated: false, ...o,
});
/// P: top + P0..P39 (P0..P9 traded 60 s ago; P0 has grandchildren P0g0..P0g2; P1 -> P1a -> P1b -> P1c); Q: Q0..Q4 (Q2 2 h
/// ago); W: W0..W2 (W1 10 h ago); Z: Z0..Z3 (no trade: dropped by the default filter); X: a listed asset top with 3 drawn
/// kids and 500 children (ghosts), X0 traded 60 s ago. `extra` rows: [mint, age s]. o.vals: a mint's value (locked; mcap 10x);
/// o.wKids: W's child count (3).
function fixture(extra: [string, number][] = [], o: { crt?: Record<string, number>; vals?: Record<string, number>; wKids?: number } = {}) {
  const nodes: BubbleNode[] = [];
  const add = (n: BubbleNode) => {
    if (o.crt && n.mint in o.crt) n.createdAt = o.crt[n.mint];
    if (o.vals && n.mint in o.vals) { n.lockedUsd = o.vals[n.mint]; n.mcapUsd = 10 * o.vals[n.mint]; }
    nodes.push(n);
  };
  add(node("P", null, 5e6));
  for (let k = 0; k < 40; k++) {
    add(node(`P${k}`, "P", 2e4 + 500 * (40 - k)));
    if (k === 0) for (let g = 0; g < 3; g++) add(node(`P0g${g}`, "P0", 3e3));
    if (k === 1) { add(node("P1a", "P1", 4e3)); add(node("P1b", "P1a", 3e3)); add(node("P1c", "P1b", 2e3)); }
  }
  add(node("Q", null, 2e6)); for (let k = 0; k < 5; k++) add(node(`Q${k}`, "Q", 1e4));
  add(node("W", null, 1e6)); for (let k = 0; k < (o.wKids ?? 3); k++) add(node(`W${k}`, "W", 1e4));
  add(node("Z", null, 3e6)); for (let k = 0; k < 4; k++) add(node(`Z${k}`, "Z", 1e4));
  add(node("X", null, 8e5, { asset: true, children: 503 })); for (let k = 0; k < 3; k++) add(node(`X${k}`, "X", 1e4));
  for (const n of nodes) n.children = Math.max(n.children, nodes.filter((c) => c.parentMint === n.mint).length);
  const rows: [string, number][] = [...Array.from({ length: 10 }, (_, k) => [`P${k}`, 60] as [string, number]), ["Q2", 7200], ["W1", 36000], ["X0", 60], ...extra];
  const heat = { at: T0, mint: rows.map((r) => r[0]), last: rows.map((r) => T0 - r[1]), n24: rows.map(() => 3), t1h: rows.map(() => 1), v24: rows.map(() => 100), buys1h: rows.map(() => 1) };
  const hi: HeatIndex = { at: T0, version: 1, rows: new Map(rows.map((r) => [r[0], { t1h: 1, n24: 3, v24: 100, last: T0 - r[1], buys1h: 1 }])) } as HeatIndex;
  const byMint = new Map(nodes.map((n) => [n.mint, n]));
  return { nodes, byMint, heat, hi };
}

/// `n` cold page coins S0..S{n-1} under P0..P9 (built under the default: P0..P9 traded; no row of their own: left out).
function addCold(F: ReturnType<typeof fixture>, n: number) {
  for (let k = 0; k < n; k++) { const m = `S${k}`; const x = node(m, `P${k % 10}`, 1e3); F.nodes.push(x); F.byMint.set(m, x); }
}
/// A heat payload of `rows` ([mint, age s]) at `at`.
const heatOf = (rows: [string, number][], at: number) => ({ at, mint: rows.map((r) => r[0]), last: rows.map((r) => at - r[1]), n24: rows.map(() => 1), t1h: rows.map(() => 0), v24: rows.map(() => 0), buys1h: rows.map(() => 0) });
const baseRows = (F: ReturnType<typeof fixture>, at: number): [string, number][] => F.heat.mint.map((m, r) => [m, at - F.heat.last[r]]);

/// What ThreeMap hands the engine for a build under `mask` (the compact options when filtered).
function inputs(F: ReturnType<typeof fixture>, mask: number, pinned: string[] = [], keep?: (n: BubbleNode) => boolean) {
  const full = buildRoots(F.nodes), fns = valueFns(full.roots), whole = familyTotals(full, fns);
  const set = buildSet(F.nodes, F.byMint, mask, F.hi, pinned, { keepTop: keep });
  const input = set.filtered ? buildRoots(set.nodes) : full;
  const compact = set.filtered ? { mask, lookup: (m: string) => F.byMint.get(m) ?? null, ...whole } : undefined;
  return { full, fns, whole, set, input, compact };
}
/// o.key: the Key's mask the engine starts with (default: the build's; narrower = a Key toggle whose rebuild is on its way)
async function mountFor(F: ReturnType<typeof fixture>, mask: number, o: { pinned?: string[]; select?: string; key?: number } = {}) {
  const I = inputs(F, mask, o.pinned ?? []);
  const e = await mountHeadless({ roots: I.input.roots, heat: F.heat, last: { mask: o.key ?? mask, pinned: o.pinned ?? [] }, compact: I.compact, values: I.fns, valueOf: valueFn("locked", I.full.roots), select: o.select ?? null });
  return { ...e, I };
}
const DEFAULT = 7;

// ---------- 1. pure ----------

test("buildSet: mask 15 and no heat are the identity (the same array object)", () => {
  const F = fixture();
  const a = buildSet(F.nodes, F.byMint, 15, F.hi);
  assert.equal(a.nodes, F.nodes); assert.equal(a.filtered, false);
  const b = buildSet(F.nodes, F.byMint, DEFAULT, null);
  assert.equal(b.nodes, F.nodes); assert.equal(b.filtered, false);
});

test("buildSet: the default filter keeps exactly the shown coins, their lineage and the pins, in input order", () => {
  const F = fixture();
  const lv = visibleLevels(F.nodes, F.byMint, DEFAULT, F.hi)!;
  const s = buildSet(F.nodes, F.byMint, DEFAULT, F.hi);
  assert.equal(s.filtered, true);
  assert.deepEqual(s.nodes.map((n) => n.mint), F.nodes.filter((n) => lv.has(n.mint)).map((n) => n.mint), "the page's levels, input order kept");
  assert.equal(s.shown, 13); assert.equal(s.anchors, 4, "P, Q, W, X");
  assert.equal(s.families, 4); assert.equal(s.dropped, 1, "Z: nothing shown");
  // a pinned cold coin and its chain; a pin the list does not hold is ignored
  const p = buildSet(F.nodes, F.byMint, DEFAULT, F.hi, ["P1c", "P1b", "P1a", "P1", "P", "speck-not-a-node"]);
  for (const m of ["P1c", "P1b", "P1a", "P1"]) assert.ok(p.nodes.some((n) => n.mint === m), m);
  assert.equal(p.pins, 4, "P1c..P1 are pinned, not shown by class (P is an anchor anyway... and pinned: shown)");
  // the input's pre-order is a subsequence of the full one
  const full = buildRoots(F.nodes), sub = buildRoots(s.nodes);
  const order = (r: ReturnType<typeof buildRoots>) => { const out: string[] = []; const st = [...r.roots].reverse(); while (st.length) { const t = st.pop()!; out.push(t.coin.mint); for (let k = t.children.length - 1; k >= 0; k--) st.push(t.children[k]); } return out; };
  const fo = order(full), so = order(sub);
  let j = 0; for (const m of fo) if (j < so.length && so[j] === m) j++;
  assert.equal(j, so.length, "subsequence");
});

test("buildSet: the newborn rule (created within 30 min of heat.at, no row) is kept; keepTop keeps a capped top", () => {
  const F = fixture([], { crt: { Z2: T0 - 600 } });
  const s = buildSet(F.nodes, F.byMint, DEFAULT, F.hi);
  assert.ok(s.nodes.some((n) => n.mint === "Z2") && s.nodes.some((n) => n.mint === "Z"), "the newborn and its top");
  assert.equal(coinClass(F.byMint.get("Z2")!, F.hi), 0);
  // X's slice shows X0 under the default; under mask 8 (older only) X1, X2 are shown anyway: build a case where nothing shows
  const G = fixture();
  const only30 = buildSet(G.nodes, G.byMint, 1, G.hi, [], { keepTop: (n) => n.mint === "W" });
  assert.ok(only30.nodes.some((n) => n.mint === "W"), "kept with nothing shown");
  assert.equal(only30.kept, 1);
  assert.ok(!only30.nodes.some((n) => n.mint === "Q"), "Q: nothing within 30 min, not kept");
});

test("buildSet: a 70-deep chain keeps its whole lineage (one root), a 2-cycle terminates", () => {
  const nodes: BubbleNode[] = [node("R", null, 1e5)];
  for (let d = 1; d <= 70; d++) nodes.push(node(`R${d}`, d === 1 ? "R" : `R${d - 1}`, 1e3));
  nodes.push(node("C1", "C2", 1e3), node("C2", "C1", 1e3));
  const byMint = new Map(nodes.map((n) => [n.mint, n]));
  const hi = { at: T0, version: 1, rows: new Map([["R70", { t1h: 0, n24: 1, v24: 0, last: T0 - 30, buys1h: 0 }], ["C1", { t1h: 0, n24: 1, v24: 0, last: T0 - 30, buys1h: 0 }]]) } as HeatIndex;
  const s = buildSet(nodes, byMint, 1, hi);
  assert.equal(s.nodes.filter((n) => n.mint.startsWith("R")).length, 71, "R and all 70 descendants");
  const r = buildRoots(s.nodes);
  assert.equal(r.roots.filter((t) => t.coin.mint.startsWith("R")).length, 1, "no spurious root at the 64th ancestor");
  assert.ok(s.nodes.some((n) => n.mint === "C2"));
});

test("familyTotals: whole values per mode (the thin rule), members, kids, ghosts, totals, maxShare, pre-order seeds", () => {
  const F = fixture();
  const full = buildRoots(F.nodes), fns = valueFns(full.roots), w = familyTotals(full, fns);
  const P = w.families.get("P")!;
  assert.equal(P.members, 47); assert.equal(P.kids, 40); assert.equal(P.ghost, 0);
  assert.equal(P.locked, F.nodes.filter((n) => n.mint === "P" || n.mint.startsWith("P")).reduce((a, n) => a + (n.lockedUsd ?? 0), 0));
  const X = w.families.get("X")!;
  assert.equal(X.ghost, 500, "children - drawn kids");
  assert.equal(w.ghosts, 500); assert.equal(w.coins, F.nodes.length); assert.equal(w.familyCount, 5);
  assert.equal(w.totals.locked, [...w.families.values()].reduce((a, f) => a + f.locked, 0));
  assert.equal(w.maxShare.locked, P.locked / w.totals.locked);
  assert.equal(w.seed.get("P"), 0); assert.equal(w.seed.get("P0"), 1); assert.equal(w.seed.get("P0g0"), 2); assert.equal(w.seed.get("Q"), 47);
  assert.deepEqual(w.list.map((f) => f.start), [0, 47, 53, 57, 62]);
});

test("shouldRebuild: the filtered branch (threshold, idle gates, the room used up; a stand-in selection is no reason); mask 15 unchanged", () => {
  const base: DriftInput = { unknown: 0, removed: 0, coins: 100_000, idleMs: 20_000, sinceBuildMs: 700_000, firstSyncAfterCache: false };
  const f = { built: 4000, hidden: 0, revealed: 0, missed: 0, family: 0, full: false, select: false };
  assert.equal(shouldRebuild({ ...base, unknown: 999 }), false, "mask 15: below 1 %");
  assert.equal(shouldRebuild({ ...base, unknown: 1000 }), true);
  assert.equal(shouldRebuild({ ...base, filtered: { ...f, hidden: 399 } }), false, "below 10 % of the built coins");
  assert.equal(shouldRebuild({ ...base, filtered: { ...f, hidden: 200, revealed: 150, missed: 50 } }), true);
  assert.equal(shouldRebuild({ ...base, idleMs: 9_000, filtered: { ...f, hidden: 500 } }), false, "not idle");
  assert.equal(shouldRebuild({ ...base, sinceBuildMs: 100_000, filtered: { ...f, hidden: 500 } }), false, "too young");
  assert.equal(shouldRebuild({ ...base, sinceBuildMs: 30_000, filtered: { ...f, full: true } }), false, "full: never within 2 min of the build");
  assert.equal(shouldRebuild({ ...base, sinceBuildMs: 130_000, filtered: { ...f, full: true } }), true);
  assert.equal(shouldRebuild({ ...base, sinceBuildMs: 130_000, idleMs: 5_000, filtered: { ...f, full: true } }), false, "full: 10 s idle");
  // a stand-in selection: its card is open, the map does not relayout under it (ThreeMap's echo rebuilds an explicit pick at once)
  assert.equal(shouldRebuild({ ...base, sinceBuildMs: 5_000, idleMs: 60_000, filtered: { ...f, select: true } }), false, "a stand-in selection alone");
  assert.equal(shouldRebuild({ ...base, filtered: { ...f, select: true, hidden: 500 } }), true, "the churn still counts (no card)");
  // a coin card open: no re-compaction whatever drifted (it waits for the card to close); a mask-15 build ignores the card
  assert.equal(shouldRebuild({ ...base, card: true, filtered: { ...f, hidden: 5000 } }), false, "card open: the churn waits");
  assert.equal(shouldRebuild({ ...base, card: true, sinceBuildMs: 130_000, filtered: { ...f, full: true } }), false, "card open: the room used up waits");
  assert.equal(shouldRebuild({ ...base, card: true, filtered: { ...f, family: 3 } }), false, "card open: a left-out family waits");
  assert.equal(shouldRebuild({ ...base, card: true, unknown: 1000 }), true, "mask 15: the card is not read");
  // a coin wanted from a family the build left out (never placed live): enough by itself once the build is 30 min old
  assert.equal(shouldRebuild({ ...base, sinceBuildMs: 1_800_000, filtered: { ...f, family: 1, missed: 1 } }), true, "one left-out-family coin, 30 min");
  assert.equal(shouldRebuild({ ...base, filtered: { ...f, family: 1, missed: 1 } }), false, "10 min is too young for a woken family alone");
  assert.equal(shouldRebuild({ ...base, filtered: { ...f, family: 1, missed: 1, hidden: 500 } }), true, "with the churn, 10 min is enough");
  assert.equal(shouldRebuild({ ...base, sinceBuildMs: 300_000, filtered: { ...f, family: 1, missed: 1 } }), false, "too young");
  assert.equal(shouldRebuild({ ...base, idleMs: 5_000, filtered: { ...f, family: 1, missed: 1 } }), false, "not idle");
  assert.equal(shouldRebuild({ ...base, sinceBuildMs: 300_000, firstSyncAfterCache: true, filtered: { ...f, family: 1, missed: 1 } }), false, "the quick cache rule needs the churn");
  assert.equal(shouldRebuild({ ...base, filtered: { ...f, missed: 1 } }), false, "a coin missed for room alone is no reason");
});

test("quickAfterCache: the first engine of a cache paint, and a Key filter's build from the cache's list, within the window", () => {
  const W = 120_000;
  assert.equal(quickAfterCache({ firstBuildFromCache: true, seq: 1, cacheInput: false, sinceBuildMs: 5_000 }, W), true, "the first engine (HEAD's rule)");
  assert.equal(quickAfterCache({ firstBuildFromCache: true, seq: 2, cacheInput: false, sinceBuildMs: 5_000 }, W), false, "a later engine from the network list");
  assert.equal(quickAfterCache({ firstBuildFromCache: true, seq: 2, cacheInput: true, sinceBuildMs: 5_000 }, W), true, "a 'last' rebuild from the cache's list replaced the first engine");
  assert.equal(quickAfterCache({ firstBuildFromCache: false, seq: 1, cacheInput: false, sinceBuildMs: 5_000 }, W), false, "no cache paint");
  assert.equal(quickAfterCache({ firstBuildFromCache: true, seq: 2, cacheInput: true, sinceBuildMs: W }, W), false, "outside the window");
});

test("keepsOrder: a mode switch keeps the order of the engine ON SCREEN with the same mask, never a filtered engine's into a full build", () => {
  assert.equal(keepsOrder({ mask: 15, filtered: false }, 15, false), true, "mask 15: as before");
  assert.equal(keepsOrder(null, 15, false), false, "no engine on screen yet");
  assert.equal(keepsOrder({ mask: 7, filtered: true }, 7, true), true, "the same filtered mask");
  // the race: K (mask 15) is pending, the size pill aborts it; the last build STARTED is the mask-15 one, the engine on screen
  // is still the mask-7 compact one: its order lists only its ~700 families
  assert.equal(keepsOrder({ mask: 7, filtered: true }, 15, false), false, "a mask-7 engine's order into a mask-15 build");
  assert.equal(keepsOrder({ mask: 7, filtered: true }, 7, false), false, "a filtered engine's order into a full build (no heat)");
  assert.equal(keepsOrder({ mask: 7, filtered: false }, 7, true), true, "a full engine's order (every family) into a filtered build");
});

test("movedFor / movedLanded: a filtered build of another mask that is aborted keeps the drags of the engine on screen", () => {
  const mv: MovedMaps = { full: new Map(), filt: new Map(), filtMask: -1 };
  assert.equal(movedFor(mv, false, 15), mv.full, "a full build: the full map");
  movedLanded(mv, false, 15, mv.full);
  assert.equal(mv.filtMask, -1, "a full build leaves the filtered map");
  const a = movedFor(mv, true, 7);
  movedLanded(mv, true, 7, a);
  a.set("P3", { dx: 120, dy: -77 });   // a drag on the mask-7 map
  // 24 h off: the mask-3 build starts (its own empty map), then 24 h on again aborts it
  const b = movedFor(mv, true, 3);
  assert.notEqual(b, a); assert.equal(b.size, 0);
  assert.equal(mv.filt, a); assert.equal(mv.filtMask, 7, "nothing changed until a build lands");
  // a later rebuild at mask 7 (size pill, band, drift, select-unknown) starts from the drags
  assert.equal(movedFor(mv, true, 7), a);
  assert.deepEqual(movedFor(mv, true, 7).get("P3"), { dx: 120, dy: -77 });
  // a mask-3 build that lands starts mask 3 empty
  const c = movedFor(mv, true, 3); movedLanded(mv, true, 3, c);
  assert.equal(mv.filt, c); assert.equal(mv.filtMask, 3);
});

test("revealWanted: lasting refusals do not use the budget; at most `scan` mints looked at", () => {
  const res = (m: string) => (m.startsWith("A") ? "family" : m.startsWith("S") ? "parent" : "ok");
  const seen: string[] = [];
  const used = revealWanted([...Array.from({ length: 70 }, (_, k) => `A${k}`), "S0", "B0", "B1", "B2"], (m) => { seen.push(m); return res(m); }, 2);
  assert.equal(used, 2); assert.deepEqual(seen.slice(-3), ["S0", "B0", "B1"], "B0 and B1 got the budget; B2 was not tried");
  const n: string[] = [];
  revealWanted(Array.from({ length: 100 }, (_, k) => `A${k}`), (m) => { n.push(m); return "family"; }, 32, 50);
  assert.equal(n.length, 50, "scan cap");
  const c: string[] = [];
  assert.equal(revealWanted(["B0", "B1", "B2"], (m) => { c.push(m); return "capacity"; }, 2), 2, "a capacity refusal uses the budget");
  assert.equal(c.length, 2);
});

test("filteredUnknown: a wanted coin the engine already counts as missed (or drew since) is not counted again", () => {
  assert.equal(filteredUnknown(10, 10, 10), 10, "all still out, none missed");
  assert.equal(filteredUnknown(10, 10, 3), 3, "7 missed or drawn");
  assert.equal(filteredUnknown(12, 10, 3), 5, "2 beyond the collected list still count");
  assert.equal(filteredUnknown(10, 10, undefined), 10, "an engine without the answer");
  assert.equal(filteredUnknown(0, 0, 0), 0);
});

test("diffNodes: wanted / wantMax count and collect only the coins the view wants; pageParents births", () => {
  const F = fixture();
  const I = inputs(F, DEFAULT);
  const known = new Set(I.set.nodes.map((n) => n.mint));
  const st = createDiffState([]);
  const plain = diffNodes(st, F.nodes, F.byMint, (m) => known.has(m), T0);
  assert.equal(plain.unknown, F.nodes.length - known.size, "every left-out coin counts without options");
  const want = new Set(["P20", "Z1", "Q0"]);
  const d = diffNodes(createDiffState([]), F.nodes, F.byMint, (m) => known.has(m), T0, { wanted: (n) => want.has(n.mint), wantMax: 2 });
  assert.equal(d.unknown, 3); assert.equal(d.wanted.length, 2);
  // a new pair under a parent the engine does not know (the page holds it)
  const kid = node("NEW", "P30", 100, { createdAt: T0 - 10 });
  const nodes = [...F.nodes, kid], byMint = new Map(nodes.map((n) => [n.mint, n]));
  assert.equal(diffNodes(createDiffState([]), nodes, byMint, (m) => known.has(m), T0, { wanted: () => false }).births.length, 0);
  const b = diffNodes(createDiffState([]), nodes, byMint, (m) => known.has(m), T0, { wanted: () => false, pageParents: true });
  assert.deepEqual(b.births.map((x) => x.coin.mint), ["NEW"]);
  // the parent lookups run only for coins young enough to be births: an old unknown coin costs one knows() (its own)
  const calls: string[] = [];
  const o = diffNodes(createDiffState([]), nodes, byMint, (m) => { calls.push(m); return known.has(m); }, T0, { wanted: () => true, wantMax: 10, pageParents: true });
  assert.equal(calls.length, nodes.length + 1, "one knows() per node, plus NEW's parent");
  assert.deepEqual(o.births.map((x) => x.coin.mint), ["NEW"]);
  assert.equal(o.unknown, nodes.length - known.size - 1, "the same counts");
});

// ---------- 2. ingest with compact: whole-family chips ----------

test("ingest: a compact build's shares, maxShare, ranks, sizes and ghosts equal the full build's", () => {
  const F = fixture();
  for (const mode of ["locked", "mcap"] as const) {
    const I = inputs(F, DEFAULT);
    const vf = valueFn(mode, I.full.roots);
    const SF: Any = { N_PLANETS: 3, debug: { map: {} } }, SC: Any = { N_PLANETS: 3, debug: { map: {} } };
    ingest(SF, { roots: I.full.roots, heat: F.heat, mode, values: I.fns, valueOf: vf });
    ingest(SC, { roots: I.input.roots, heat: F.heat, mode, values: I.fns, valueOf: vf, compact: I.compact });
    const byTop = (S: Any) => new Map(S.fams.map((f: Any) => [S.mint[f.top], f]));
    const fF = byTop(SF), fC = byTop(SC);
    assert.equal(SC.fams.length, 4, "Z left out");
    for (const [m, c] of fC as Map<string, Any>) {
      const f = fF.get(m) as Any;
      for (const k of ["share", "shareL", "shareM", "valueL", "valueM", "size", "ghost"]) assert.equal(c[k], f[k], `${mode} ${m}.${k}`);
    }
    assert.equal(SC.maxShare, SF.maxShare, `${mode} maxShare`);
    const rel = (S: Any) => S.ranked.map((f: Any) => S.mint[f.top]).filter((m: string) => fC.has(m));
    assert.deepEqual(rel(SC), rel(SF), `${mode}: the present families keep their relative order`);
    assert.equal(SC.whole.coins, F.nodes.length); assert.equal(SC.whole.families, 5);
    assert.equal(SF.seed, null, "a full build seeds by index");
  }
});

test("ingest: the largest-share family left out of the compact build: maxShare, ranks and the tie order stay the full build's", () => {
  // Z (no trade: dropped by the default filter) is the biggest family; Q and W tie on value in both modes, W has more members
  // (9 vs 6) but the compact build holds 2 of each (Q, Q2 / W, W1): the tie must still go by the whole family
  const F = fixture([], { vals: { Z: 2e7, W: 1.97e6 }, wKids: 8 });
  for (const mode of ["locked", "mcap"] as const) {
    const I = inputs(F, DEFAULT);
    assert.ok(!I.set.nodes.some((n) => n.mint === "Z"), "Z left out");
    const vf = valueFn(mode, I.full.roots);
    const SF: Any = { N_PLANETS: 3, debug: { map: {} } }, SC: Any = { N_PLANETS: 3, debug: { map: {} } };
    ingest(SF, { roots: I.full.roots, heat: F.heat, mode, values: I.fns, valueOf: vf });
    ingest(SC, { roots: I.input.roots, heat: F.heat, mode, values: I.fns, valueOf: vf, compact: I.compact });
    const byTop = (S: Any) => new Map<string, Any>(S.fams.map((f: Any) => [S.mint[f.top], f]));
    const fF = byTop(SF), fC = byTop(SC);
    assert.equal(SF.ranked[0], fF.get("Z"), `${mode}: Z ranks first in the full build`);
    assert.equal(fF.get("Q").valueL, fF.get("W").valueL, "Q and W tie (locked)");
    assert.equal(fF.get("Q").valueM, fF.get("W").valueM, "Q and W tie (mcap)");
    assert.equal(fC.get("Q").members.length, fC.get("W").members.length, "the compact build holds as many of each");
    assert.equal(SC.maxShare, SF.maxShare, `${mode}: maxShare is Z's, though Z is not in the build`);
    const rel = (S: Any) => S.ranked.map((f: Any) => S.mint[f.top]).filter((m: string) => fC.has(m));
    assert.deepEqual(rel(SC), rel(SF), `${mode}: relative order (W before Q: more members in the whole family)`);
    assert.ok(rel(SF).indexOf("W") < rel(SF).indexOf("Q"), "the tie goes to W");
    for (const [m, c] of fC) { const f = fF.get(m); assert.equal(c.share, f.share, `${mode} ${m}.share`); assert.equal(c.rankL, f.rankL - 1, `${mode} ${m}.rankL: one up (Z is gone)`); }
  }
});

test("ingest: a mode switch's order that lacks a family the compact build holds keeps that family at its computed place", () => {
  const F = fixture();
  const I = inputs(F, DEFAULT);
  const vf = valueFn("mcap", I.full.roots);
  const tops = (S: Any) => S.ranked.map((f: Any) => S.mint[f.top]) as string[];
  const S0: Any = { N_PLANETS: 3, debug: { map: {} } };
  ingest(S0, { roots: I.input.roots, heat: F.heat, mode: "mcap", values: I.fns, valueOf: vf, compact: I.compact });
  const base = tops(S0);
  assert.equal(base.length, 4);
  // the previous (filtered) engine did not hold Q (its first trade came after that build), and listed the others reversed
  const q = base[1], prev = base.filter((m) => m !== q).reverse();
  let j = 0; const want = base.map((m) => (m === q ? q : prev[j++]));
  const SC: Any = { N_PLANETS: 3, debug: { map: {} } };
  ingest(SC, { roots: I.input.roots, heat: F.heat, mode: "mcap", values: I.fns, valueOf: vf, compact: I.compact, order: prev });
  assert.deepEqual(tops(SC), want, `${q} keeps its place; the listed families keep the previous order`);
  assert.equal(SC.planets.some((f: Any) => SC.mint[f.top] === q), true, `${q} is still a planet`);
  // a full build (mask 15) keeps today's rule: a family the order does not list follows every listed one
  const SF: Any = { N_PLANETS: 3, debug: { map: {} } }, SF0: Any = { N_PLANETS: 3, debug: { map: {} } };
  ingest(SF0, { roots: I.full.roots, heat: F.heat, mode: "mcap", values: I.fns, valueOf: vf });
  const fb = tops(SF0), fq = fb[1], fprev = fb.filter((m) => m !== fq);
  ingest(SF, { roots: I.full.roots, heat: F.heat, mode: "mcap", values: I.fns, valueOf: vf, order: fprev });
  assert.deepEqual(tops(SF), [...fprev, fq]);
});

// ---------- 3. the engine, headless ----------

test("engine: a compact build holds the shown coins + lineage; nothing hidden, no drift right after the build", async () => {
  const F = fixture();
  const e = await mountFor(F, DEFAULT);
  try {
    assert.equal(e.S.N, e.I.set.nodes.length);
    assert.deepEqual(e.api.driftStats(), { filtered: true, built: e.S.N, hidden: 0, revealed: 0, missed: 0, family: 0, full: false, select: false });
    assert.equal(e.api.lastFilterStats().hidden, 0);
  } finally { e.dispose(); }
  // an engine that starts at a narrower Key mask than its build's (a toggle whose rebuild is on its way): the coins hidden at
  // the build are not drift
  const G = fixture();
  const n = await mountFor(G, DEFAULT, { key: 1 });
  try {
    assert.ok(n.api.lastFilterStats().hidden >= 2, `hidden at the build ${n.api.lastFilterStats().hidden} (Q2, W1)`);
    assert.equal(n.api.driftStats().hidden, 0);
  } finally { n.dispose(); }
});

test("engine: a trade on a left-out coin reveals it next to its parent, no fanfare; its chain comes first, top-down", async () => {
  const F = fixture();
  const e = await mountFor(F, DEFAULT);
  try {
    const { api, dbg, S, fx } = e;
    const placed0 = dbg.live().births.placed;
    assert.equal(api.knows("P11"), false);
    api.applyEvent({ name: "trade", data: { mint: "P11", time: T0 + 30, isBuy: true, valueUsd: 50 } });
    assert.equal(api.knows("P11"), true);
    assert.equal(api.visibility("P11"), "shown", "live now: class 0");
    await e.flush(20);
    assert.deepEqual(fx, { spark: 0, ring: 0, toast: 0 }, "no new-pair fanfare");
    assert.equal(dbg.live().births.placed, placed0, "not a birth");
    assert.equal(dbg.live().reveals.added, 1);
    const i = dbg.indexOf("P11"), p = dbg.indexOf("P");
    assert.ok(i >= S.N, "an index past the build");
    const a = dbg.world(i), b = dbg.world(p);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < b.r + 6 * a.r + 40, "next to its parent");
    // a chain: P1c's parent and grandparent were left out (cold; P1 is built: it traded a minute ago)
    api.applyEvent({ name: "trade", data: { mint: "P1c", time: T0 + 40, isBuy: true, valueUsd: 50 } });
    for (const m of ["P1a", "P1b", "P1c"]) assert.ok(api.knows(m), m);
    const ix = ["P1", "P1a", "P1b", "P1c"].map((m) => dbg.indexOf(m));
    assert.ok(ix[0] < S.N && ix[1] >= S.N, "P1 built, P1a added");
    assert.deepEqual([...ix].sort((x, y) => x - y), ix, "added top-down (each parent's index is lower)");
    assert.equal(api.visibility("P1c"), "shown"); assert.equal(api.visibility("P1b"), "anchor"); assert.equal(api.visibility("P1a"), "anchor"); assert.equal(api.visibility("P1"), "shown");
    assert.equal(dbg.live().reveals.chains, 1);
    // the levels equal a full recompute
    const V = S.vis, full = visLevels(V.par, V.cls, V.mask, [], V.fam, S.fams.length, { n: V.st.n, virt: Int32Array.from(V.virt) });
    assert.deepEqual(Array.from(V.st.level.subarray(0, V.st.n)), Array.from(full.level.subarray(0, V.st.n)));
    assert.deepEqual(dbg.children(dbg.indexOf("P1a")), [dbg.indexOf("P1b")], "children of a coin added live");
    assert.deepEqual(fx, { spark: 0, ring: 0, toast: 0 });
    // a coin added live is a pick target where it is drawn
    dbg.zoomTo(dbg.indexOf("P1c"), 40);
    assert.equal(dbg.pick(S.W() / 2, S.H() / 2).i, dbg.indexOf("P1c"));
    assert.equal(api.driftStats().revealed, 4);
  } finally { e.dispose(); }
});

test("engine: no reveal when the Key or the build's mask does not show the class; a left-out family is missed, not placed", async () => {
  const F = fixture();
  const e = await mountFor(F, DEFAULT);
  try {
    const { api } = e;
    api.setLastFilter(0b1000);   // the Key: older only (a rebuild for it would be on its way)
    api.applyEvent({ name: "trade", data: { mint: "P12", time: T0 + 30, isBuy: true, valueUsd: 50 } });
    assert.equal(api.knows("P12"), false, "class 0 is not in 7 & 8");
    api.setLastFilter(DEFAULT);
    api.applyEvent({ name: "trade", data: { mint: "Z1", time: T0 + 30, isBuy: true, valueUsd: 50 } });
    assert.equal(api.knows("Z1"), false, "Z was left out: never an orphan at the rim");
    assert.equal(api.driftStats().missed, 1);
    assert.equal(api.reveal("Z1"), "family");
    assert.equal(api.reveal("nope"), "unknown");
    assert.equal(api.reveal("P"), "known");
  } finally { e.dispose(); }
});

test("engine: heat rows of mints the page does not hold never count; page coins in the mask come in (64 per poll, the rest missed)", async () => {
  const F = fixture();
  const e = await mountFor(F, DEFAULT);
  try {
    const { api, S } = e;
    const h = (rows: [string, number][], at: number) => ({ at, mint: rows.map((r) => r[0]), last: rows.map((r) => at - r[1]), n24: rows.map(() => 1), t1h: rows.map(() => 0), v24: rows.map(() => 0), buys1h: rows.map(() => 0) });
    const base: [string, number][] = F.heat.mint.map((m, r) => [m, T0 - F.heat.last[r]]);
    const specks: [string, number][] = Array.from({ length: 5000 }, (_, k) => [`speck${k}`, 30]);
    api.setHeat(h([...base, ...specks], T0 + 15));
    await e.flush(30);
    assert.deepEqual(api.driftStats(), { filtered: true, built: S.N, hidden: 0, revealed: 0, missed: 0, family: 0, full: false, select: false }, "5000 rows of non-page mints: nothing");
    // 30 cold P children trade: all are page coins in the mask
    const kids: [string, number][] = Array.from({ length: 30 }, (_, k) => [`P${10 + k}`, 20 + k]);
    api.setHeat(h([...base, ...kids], T0 + 30));
    for (let k = 0; k < 20 && api.driftStats().revealed < 30; k++) await e.flush(20);
    assert.equal(api.driftStats().revealed, 30);
    for (const [m] of kids) assert.equal(api.visibility(m), "shown", m);
  } finally { e.dispose(); }
  // 100 cold page coins trade in one poll: 64 come in (most recent first), the other 36 wait as missed
  const G = fixture();
  addCold(G, 100);
  const g = await mountFor(G, DEFAULT);
  try {
    const rows: [string, number][] = Array.from({ length: 100 }, (_, k) => [`S${k}`, 10 + k]);
    g.api.setHeat(heatOf([...baseRows(G, T0 + 30), ...rows], T0 + 30));
    for (let k = 0; k < 50 && g.dbg.live().reveals.queued > 0; k++) await g.flush(10);
    const ds = g.api.driftStats();
    assert.equal(ds.revealed, 64, "REVEAL_HEAT_MAX per poll");
    assert.equal(ds.missed, 36);
    assert.ok(g.api.knows("S0") && g.api.knows("S63") && !g.api.knows("S64") && !g.api.knows("S99"), "the most recent trades first");
    // the next poll brings the rest
    g.api.setHeat(heatOf([...baseRows(G, T0 + 45), ...rows.map(([m, a]) => [m, a + 15] as [string, number])], T0 + 45));
    for (let k = 0; k < 50 && g.dbg.live().reveals.queued > 0; k++) await g.flush(10);
    assert.equal(g.api.driftStats().revealed, 100); assert.equal(g.api.driftStats().missed, 0);
  } finally { g.dispose(); }
});

test("engine: a left-out-family coin wanted by a node pass and a heat poll counts once in the drift", async () => {
  const F = fixture();
  const e = await mountFor(F, DEFAULT);
  try {
    const { api } = e;
    // Z1 trades: Z was left out (nothing of it shown at the build), so the heat poll's reveal is refused and Z1 is missed
    api.setHeat(heatOf([...baseRows(F, T0 + 30), ["Z1", 5]], T0 + 30));
    for (let k = 0; k < 20 && e.dbg.live().reveals.queued > 0; k++) await e.flush(10);
    assert.equal(api.driftStats().missed, 1);
    // the sync's node pass wants Z1 too (its class is shown now): it reveals it (refused again) and counts it
    const hi = { at: T0 + 30, version: 2, rows: new Map([...F.hi.rows, ["Z1", { t1h: 1, n24: 1, v24: 1, last: T0 + 25, buys1h: 1 }]]) } as HeatIndex;
    const d = diffNodes(createDiffState([]), F.nodes, F.byMint, (m) => api.knows(m), T0 + 30, { wanted: (n) => ((DEFAULT >> coinClass(n, hi)) & 1) === 1, wantMax: 50_000 });
    assert.deepEqual(d.wanted, ["Z1"]); assert.equal(d.unknown, 1);
    assert.equal(api.reveal("Z1", "node"), "family");
    const ds = api.driftStats(d.wanted);
    assert.equal(ds.wanted, 0, "already missed");
    const unknown = filteredUnknown(d.unknown, d.wanted.length, ds.wanted);
    assert.equal(unknown + ds.missed + ds.hidden + ds.revealed, 1, "churn 1, not 2");
    // a wanted coin that is neither drawn nor missed still counts
    assert.equal(api.driftStats(["P30"]).wanted, 1);
  } finally { e.dispose(); }
});

test("engine: births in a compact build: a parent left out comes in silently, the newborn keeps its fanfare; class 0 off or a left-out family: not placed", async () => {
  const F = fixture();
  const e = await mountFor(F, DEFAULT);
  try {
    const { api, dbg, fx } = e;
    const nowS = Date.now() / 1000;
    const pair = (mint: string, parent: string) => dbg.feed({ name: "pair", data: { coin: { mint, symbol: mint, name: null, image: null, mcapUsd: 5000, lockedUsd: 0, createdAt: nowS }, parent: { mint: parent } } });
    pair("N1", "P25");   // P25: a page coin the build left out
    assert.ok(api.knows("P25") && api.knows("N1"));
    assert.equal(api.visibility("N1"), "shown"); assert.equal(api.visibility("P25"), "anchor");
    await e.flush(20);
    assert.equal(fx.spark, 0, "no spark: its parent was added live");
    assert.equal(fx.ring, 1); assert.equal(fx.toast, 1, "the newborn's ring and label");
    assert.equal(dbg.live().reveals.added, 1, "the parent was revealed");
    pair("N2", "Z2");   // Z: left out
    assert.equal(api.knows("N2"), false, "no orphan at the rim");
    assert.equal(api.driftStats().missed, 1, "the new pair (its parent's refusal is not counted twice)");
    api.setLastFilter(0b0110);   // class 0 off
    pair("N3", "P");
    assert.equal(api.knows("N3"), false, "the Key does not show it: not placed");
    assert.equal(dbg.live().births.unwanted, 1);
    assert.equal(api.driftStats().missed, 1, "not counted");
  } finally { e.dispose(); }
});

test("engine: the room runs out -> capacity, full; a mask-15 build reveals nothing and has no drift", async () => {
  const F = fixture();
  const e = await mountFor(F, DEFAULT);
  try {
    const { api, dbg } = e;
    const room = dbg.live().reveals.room;
    assert.ok(room > 500);
    // eat the room: page coins that are not on the fixture's list are not page coins, so add nodes to the lookup
    for (let k = 0; k < room + 5; k++) { const m = `R${k}`; F.byMint.set(m, node(m, "P", 1e3)); }
    let ok = 0, cap = 0;
    for (let k = 0; k < room + 5; k++) { const r = api.reveal(`R${k}`); if (r === "ok") ok++; else if (r === "capacity") cap++; }
    assert.ok(ok === room && cap === 5, `${ok} placed, ${cap} refused`);
    assert.equal(api.driftStats().full, true);
  } finally { e.dispose(); }
  // a chain that does not fit in the room less REVEAL_ROOM (8) for a node / heat reveal is refused whole: nothing of it placed
  const H = fixture();
  const h = await mountFor(H, DEFAULT);
  try {
    const room = h.dbg.live().reveals.room;
    for (let k = 0; k < room - 10; k++) { const m = `R${k}`; H.byMint.set(m, node(m, "P", 1e3)); assert.equal(h.api.reveal(m), "ok"); }
    assert.equal(h.dbg.live().reveals.room, 10);
    const added = h.dbg.live().reveals.added;
    assert.equal(h.api.reveal("P1c", "node"), "capacity", "P1c, P1b, P1a: 3 > 10 - 8");
    for (const m of ["P1a", "P1b", "P1c"]) assert.equal(h.api.knows(m), false, `${m} not placed`);
    assert.equal(h.dbg.live().reveals.added, added);
    assert.equal(h.api.driftStats().missed, 1, "a node reveal's refusal is missed");
    assert.equal(h.api.reveal("P1c", "select"), "ok", "a selection may use the reserve");
  } finally { h.dispose(); }
  const G = fixture();
  const I = inputs(G, 15);
  const f = await mountHeadless({ roots: I.input.roots, heat: G.heat, last: { mask: 15 }, values: I.fns, valueOf: valueFn("locked", I.full.roots) });
  try {
    assert.equal(f.api.reveal("P11"), "off");
    assert.deepEqual(f.api.driftStats(), { filtered: false, built: f.S.N, hidden: 0, revealed: 0, missed: 0, family: 0, full: false, select: false });
  } finally { f.dispose(); }
});

test("engine: a heat poll that ages a built coin out of the mask is drift (hidden); a coin added live wears its heat", async () => {
  const F = fixture();
  const e = await mountFor(F, 1);   // 30 min only: P0..P9, X0
  try {
    const { api, dbg, S } = e;
    assert.equal(api.driftStats().hidden, 0);
    api.applyEvent({ name: "trade", data: { mint: "P20", time: T0 + 10, isBuy: true, valueUsd: 50 } });
    const i = dbg.indexOf("P20");
    assert.equal(S.bubbles.cls[i], 0, "live");
    // an hour later: P0..P9 and P20 aged out of 30 min
    const at = T0 + 3600, rows = [...F.heat.mint.map((m, r) => [m, F.heat.last[r]] as [string, number]), ["P20", T0 + 10] as [string, number]];
    api.setHeat({ at, mint: rows.map((r) => r[0]), last: rows.map((r) => r[1]), n24: rows.map(() => 1), t1h: rows.map(() => 0), v24: rows.map(() => 0), buys1h: rows.map(() => 0) });
    assert.equal(api.visibility("P3"), "hidden");
    assert.ok(api.driftStats().hidden >= 10, `hidden ${api.driftStats().hidden}`);
    assert.equal(S.bubbles.cls[i], 1, "the coin added live cooled with the heat poll (class 1)");
  } finally { e.dispose(); }
});

test("engine: a selection the build left out is a revealed stand-in (drift select); a page hover reveals after a dwell, within a budget", async () => {
  const F = fixture();
  const e = await mountFor(F, DEFAULT);
  try {
    const { api } = e;
    assert.equal(api.select("P33"), true);
    assert.equal(api.selected(), "P33"); assert.equal(api.visibility("P33"), "shown");
    assert.equal(api.driftStats().select, true);
    api.select(null);
    assert.equal(api.driftStats().select, false);
    api.hover("P34");
    assert.equal(api.knows("P34"), false, "not at once");
    await e.flush(220);
    assert.equal(api.knows("P34"), true, "after the dwell");
    assert.equal(api.visibility("P34"), "shown", "while the page points at it");
    api.hover(null);
    assert.equal(api.visibility("P34"), "hidden");
    assert.equal(api.driftStats().revealed, 1, "hover reveals are not drift (only the selection's)");
    api.hover("Z3"); await e.flush(220);
    assert.equal(api.driftStats().missed, 0, "a hover refusal is not counted");
    assert.equal(api.driftStats().hidden, 0, "a hover reveal hidden again is not drift");
  } finally { e.dispose(); }
  // HOVER_MAX (32) page-hover reveals per build: the 33rd is refused
  const G = fixture();
  addCold(G, 40);
  const g = await mountFor(G, DEFAULT);
  try {
    for (let k = 0; k < 34; k++) { g.api.hover(`S${k}`); await g.flush(170); }
    g.api.hover(null);
    await g.flush(20);
    let known = 0; for (let k = 0; k < 34; k++) if (g.api.knows(`S${k}`)) known++;
    assert.equal(known, 32, "HOVER_MAX");
    assert.equal(g.dbg.live().reveals.hover, 32);
    assert.equal(g.dbg.live().reveals.refused.capacity, 2);
    const ds = g.api.driftStats();
    assert.equal(ds.hidden, 0, "the 32 hidden again are not drift");
    assert.equal(ds.revealed, 0); assert.equal(ds.missed, 0);
  } finally { g.dispose(); }
});

test("engine: the layout seeds are the full build's: a family kept whole keeps its shape whatever else the build holds", async () => {
  // Q comes after P in the list; build 1 drops most of P (default), build 2 keeps all of P (pinned): Q's coins get other
  // indices, the seeds stay
  const F = fixture([["Q0", 60], ["Q1", 60], ["Q3", 60], ["Q4", 60]]);
  const pins = F.nodes.filter((n) => n.mint.startsWith("P")).map((n) => n.mint);
  const a = await mountFor(F, DEFAULT), b = await mountFor(F, DEFAULT, { pinned: pins });
  try {
    assert.notEqual(a.dbg.indexOf("Q0"), b.dbg.indexOf("Q0"), "Q's coins are numbered differently");
    const rel = (e: Any) => ["Q0", "Q1", "Q2", "Q3", "Q4"].map((m) => { const p = e.dbg.world(e.dbg.indexOf(m)), t = e.dbg.world(e.dbg.indexOf("Q")); return [+(p.x - t.x).toFixed(4), +(p.y - t.y).toFixed(4)]; });
    assert.deepEqual(rel(a), rel(b));
  } finally { a.dispose(); b.dispose(); }
  // the family's own rotation too: Q is family 1 under the default (P first), family 0 under 3 h only (P has nothing shown);
  // the pins give Q the same members in both
  const qPins = ["Q0", "Q1", "Q3", "Q4", "Q"];
  const c = await mountFor(F, DEFAULT, { pinned: qPins }), d = await mountFor(F, 2, { pinned: qPins });
  try {
    const famId = (e: Any) => e.S.famOf[e.dbg.indexOf("Q")];
    assert.notEqual(famId(c), famId(d), "Q's family index differs");
    assert.equal(c.S.fams[famId(c)].members.length, d.S.fams[famId(d)].members.length);
    const rel = (e: Any) => ["Q0", "Q1", "Q2", "Q3", "Q4"].map((m) => { const p = e.dbg.world(e.dbg.indexOf(m)), t = e.dbg.world(e.dbg.indexOf("Q")); return [+(p.x - t.x).toFixed(4), +(p.y - t.y).toFixed(4)]; });
    assert.deepEqual(rel(c), rel(d), "the same bearings around Q's top");
  } finally { c.dispose(); d.dispose(); }
});

test("engine: the compact family is framed larger: shown children's on-screen radius at the family fit grows", async () => {
  const F = fixture();
  const I = inputs(F, 15);
  const full = await mountHeadless({ roots: I.input.roots, heat: F.heat, last: { mask: DEFAULT }, values: I.fns, valueOf: valueFn("locked", I.full.roots) });
  const comp = await mountFor(F, DEFAULT);
  try {
    const pf = full.dbg.compact("P"), pc = comp.dbg.compact("P");
    assert.equal(pf.shown, 10); assert.equal(pc.shown, 10);
    assert.equal(pc.filtered, true); assert.equal(pf.filtered, false);
    assert.ok(pc.medRpx > 1.5 * pf.medRpx, `median radius ${pf.medRpx} -> ${pc.medRpx} px`);
    assert.ok(pc.Rc < pf.Rc, `Rc ${pf.Rc} -> ${pc.Rc}`);
  } finally { full.dispose(); comp.dispose(); }
});

test("engine: 64 heat reveals with ~440 coins already added stay in short slices", async () => {
  const F = fixture();
  for (let k = 0; k < 520; k++) { const m = `S${k}`; const n = node(m, `P${k % 40}`, 1e3); F.nodes.push(n); F.byMint.set(m, n); }
  const e = await mountFor(F, DEFAULT);
  try {
    const { api } = e;
    for (let k = 0; k < 440; k++) api.reveal(`S${k}`);
    const rows: [string, number][] = [...F.heat.mint.map((m, r) => [m, T0 - F.heat.last[r]] as [string, number]), ...Array.from({ length: 64 }, (_, k) => [`S${440 + k}`, 10] as [string, number])];
    const t0 = performance.now();
    api.setHeat({ at: T0 + 15, mint: rows.map((r) => r[0]), last: rows.map((r) => T0 + 15 - r[1]), n24: rows.map(() => 1), t1h: rows.map(() => 0), v24: rows.map(() => 0), buys1h: rows.map(() => 0) });
    const pollMs = performance.now() - t0;
    for (let k = 0; k < 100 && e.dbg.live().reveals.queued > 0; k++) await e.flush(5);
    assert.equal(e.dbg.live().reveals.queued, 0);
    assert.ok(pollMs < 50, `the poll itself took ${pollMs.toFixed(1)} ms (reveals run later, in slices)`);
  } finally { e.dispose(); }
});

/// Three built coins (P0..P2) age out of 24 h at `at`.
const agedOut = (F: ReturnType<typeof fixture>, at: number) => heatOf(baseRows(F, at).map(([m, age]) => (m === "P0" || m === "P1" || m === "P2" ? [m, 90_000] : [m, age]) as [string, number]), at);

test("engine: an engine built while the Key was narrower (a toggle during the prep, toggled back) still counts its ageing", async () => {
  const F = fixture();
  const a = await mountFor(F, DEFAULT);
  try {
    a.api.setHeat(agedOut(F, T0 + 100));
    assert.equal(a.api.driftStats().hidden, 3, "control: built and shown at 7");
  } finally { a.dispose(); }
  // built for 7 while the Key read 1 (24 h and 3 h off during the prep), back to 7 within the settle: this engine stays
  const G = fixture();
  const b = await mountFor(G, DEFAULT, { key: 1 });
  try {
    assert.equal(b.api.driftStats().hidden, 0, "the Key's own hiding is not drift");
    b.api.setLastFilter(DEFAULT);   // the sync: last & buildMask
    assert.equal(b.api.driftStats().hidden, 0);
    b.api.setHeat(agedOut(G, T0 + 100));
    assert.equal(b.api.lastFilterStats().hidden, 3);
    assert.equal(b.api.driftStats().hidden, 3, "the same three coins aged out count");
    // while the Key is narrower again (a rebuild for it on its way) the count holds: the Key's hiding is not ageing
    b.api.setLastFilter(1);
    assert.ok(b.api.lastFilterStats().hidden > 3);
    assert.equal(b.api.driftStats().hidden, 3);
  } finally { b.dispose(); }
});

/// A family A (top + 70 coins, no trade at the build: left out of the default build) ahead of everything in the node list,
/// and S0, a cold page coin under P0 (P is built: S0 can be placed).
function withLeftOut() {
  const F = fixture();
  const A: BubbleNode[] = [node("A", null, 1e6, { children: 70 })];
  for (let k = 0; k < 70; k++) A.push(node(`A${k}`, "A", 1e3));
  F.nodes.unshift(...A); for (const n of A) F.byMint.set(n.mint, n);
  addCold(F, 1);
  return { F, A };
}

test("engine: coins of a family the build left out never take the heat polls' reveal slots from a placeable coin", async () => {
  const { F, A } = withLeftOut();
  const e = await mountFor(F, DEFAULT);
  try {
    const { api, dbg } = e;
    assert.equal(api.knows("A"), false, "A left out");
    const poll = async (k: number) => {
      const at = T0 + 30 + 15 * k;
      // A0..A69 traded 1..70 s before this poll, S0 100 s before it: all class 0, the 70 most recent are A's
      api.setHeat(heatOf([...baseRows(F, at), ...A.slice(1).map((n, q) => [n.mint, 1 + q] as [string, number]), ["S0", 100]], at));
      for (let q = 0; q < 50 && dbg.live().reveals.queued > 0; q++) await e.flush(10);
    };
    await poll(0);
    assert.equal(api.knows("S0"), false, "the first poll: S0 is 71st, past the 64 of the poll");
    await poll(1);
    assert.equal(api.knows("S0"), true, "the next poll skips A's lasting refusals: S0 comes in");
    const ds = api.driftStats();
    assert.equal(ds.missed, 70, "A0..A69 are still wanted (missed)");
    assert.equal(ds.family, 70, "... from a family the build left out");
    const refused = dbg.live().reveals.refused.family;
    await poll(2);
    assert.equal(dbg.live().reveals.refused.family, refused, "no chain walked again");
  } finally { e.dispose(); }
});

test("engine + revealWanted: a node pass reaches a placeable coin behind more than NODE_REVEAL_MAX left-out-family coins", async () => {
  const { F, A } = withLeftOut();
  const e = await mountFor(F, DEFAULT);
  try {
    const { api } = e;
    const row = (last: number) => ({ t1h: 1, n24: 1, v24: 1, last, buys1h: 1 });
    const rows = new Map<string, Any>(F.hi.rows); for (const n of A.slice(1)) rows.set(n.mint, row(T0 + 90)); rows.set("S0", row(T0 + 80));
    const hi = { at: T0 + 100, version: 3, rows } as HeatIndex;
    const d = diffNodes(createDiffState([]), F.nodes, F.byMint, (m) => api.knows(m), T0 + 100, { wanted: (n) => ((DEFAULT >> coinClass(n, hi)) & 1) === 1, wantMax: 50_000, pageParents: true });
    assert.equal(d.wanted.length, 71); assert.equal(d.wanted.indexOf("S0"), 70, "S0 is last");
    revealWanted(d.wanted, (m) => api.reveal(m, "node"), 32);
    assert.equal(api.knows("S0"), true, "placed in the first pass");
    assert.equal(api.driftStats().family, 70);
    // the next passes answer A's coins from the cache
    const walked = e.dbg.live().reveals.refused.family;
    revealWanted(d.wanted, (m) => api.reveal(m, "node"), 32);
    assert.equal(e.dbg.live().reveals.refused.family, walked);
    assert.ok(e.dbg.live().reveals.cached >= 70);
  } finally { e.dispose(); }
});

test("buildSet emptyTops + engine: buckets that hold nothing build every top (hidden), and coins that come in are placed by them", async () => {
  const F = fixture();
  // 3 h only, and nothing traded 30 min - 3 h ago (Q2's row dropped): nothing to show, nothing pinned
  F.hi.rows.delete("Q2");
  const qi = F.heat.mint.indexOf("Q2");
  for (const k of ["mint", "last", "n24", "t1h", "v24", "buys1h"] as const) (F.heat[k] as unknown[]).splice(qi, 1);
  const none = buildSet(F.nodes, F.byMint, 2, F.hi);
  assert.equal(none.filtered, true); assert.equal(none.nodes.length, 0, "without the option: nothing");
  const s = buildSet(F.nodes, F.byMint, 2, F.hi, [], { emptyTops: true });
  assert.deepEqual(s.nodes.map((n) => n.mint), ["P", "Q", "W", "Z", "X"]);
  assert.equal(s.kept, 5); assert.equal(s.shown, 0); assert.equal(s.anchors, 5); assert.equal(s.families, 5); assert.equal(s.dropped, 0);
  assert.deepEqual(buildSet(F.nodes, F.byMint, 2, F.hi, ["off-the-list"], { emptyTops: true }).nodes.map((n) => n.mint), ["P", "Q", "W", "Z", "X"], "a pin the list does not hold keeps no node: the tops");
  // a filter that shows something is unchanged by the option
  assert.deepEqual(buildSet(F.nodes, F.byMint, DEFAULT, F.hi, [], { emptyTops: true }).nodes, buildSet(F.nodes, F.byMint, DEFAULT, F.hi).nodes);
  const full = buildRoots(F.nodes), fns = valueFns(full.roots), whole = familyTotals(full, fns);
  const e = await mountHeadless({ roots: buildRoots(s.nodes).roots, heat: F.heat, last: { mask: 2 }, compact: { mask: 2, lookup: (m: string) => F.byMint.get(m) ?? null, ...whole }, values: fns, valueOf: valueFn("locked", full.roots) });
  try {
    const { api } = e;
    assert.equal(e.S.N, 5);
    assert.equal(api.lastFilterStats().shown, 0); assert.equal(api.lastFilterStats().anchors, 0, "all hidden");
    assert.equal(api.driftStats().filtered, true, "a compact build: the filtered drift and reveals apply");
    // Q3 traded 1.5 h ago (class 1): it comes in next to its top
    api.setHeat(heatOf([...baseRows(F, T0 + 30), ["Q3", 5400]], T0 + 30));
    for (let k = 0; k < 20 && e.dbg.live().reveals.queued > 0; k++) await e.flush(10);
    assert.equal(api.visibility("Q3"), "shown"); assert.equal(api.visibility("Q"), "anchor");
    assert.equal(api.driftStats().revealed, 1);
  } finally { e.dispose(); }
});
