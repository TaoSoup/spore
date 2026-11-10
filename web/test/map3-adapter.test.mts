// The map3 data adapter (src/components/map3/adapter.ts, map3 spec section 5): the app's node list turned
// into the engine's forest in the server's DFS order, the per-mode value and family shares (equal to
// lib/map/dominance by construction), the heat payload, the dominance tags, the live node diff (births,
// patches, unknown, removed), the drift rebuild rule and the highlight test.
//
//   npx tsx --test test/map3-adapter.test.mts
//   MAP3_FIXTURE=<map.json> npx tsx --test test/map3-adapter.test.mts   # the fixture tests on another /api/map
//   payload (default: test/fixtures/map3-sample.json, 24 roots / 927 coins cut from the prototype's map.json in the
//   server's own order; any full /api/map?scope=all&limit=all response works, e.g. the prototype's whole map.json)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BIRTH_MAX_AGE_S, PHONE_BAND_PX, WIDE_PX, buildRoots, createDiffState, diffNodes, familyShares, heatPayload, highlightTest,
  reducedMotionNow, shouldRebuild, tagFn, valueFn, valueFns, type BuiltInput,
} from "../src/components/map3/adapter.ts";
import { normalise } from "../src/lib/map/nodes.ts";
import { dominance } from "../src/lib/map/dominance.ts";
import { indexHeat, type HeatIndex } from "../src/lib/map/heat.ts";
import type { BubbleNode, SizeMode } from "../src/lib/map/types.ts";
import type { HeatResponse, MapResponse } from "../src/lib/api.ts";

const FIXTURE = process.env.MAP3_FIXTURE ?? fileURLToPath(new URL("./fixtures/map3-sample.json", import.meta.url));
const HAVE_FIXTURE = existsSync(FIXTURE);
const NOW = 1_800_000_000; // unix s

const node = (mint: string, parentMint: string | null, o: Partial<BubbleNode> = {}): BubbleNode => ({
  mint, parentMint, depth: 0, name: `${mint} coin`, symbol: mint.toUpperCase(), image: null, mcapUsd: 1_000, lockedUsd: null, children: 0, descendants: 0, migrated: false, ours: false, createdAt: NOW - 30 * 86_400, ...o,
});
type Tree = BuiltInput["roots"][number];
const preorder = (roots: readonly Tree[]): string[] => { const out: string[] = []; const walk = (t: Tree) => { out.push(t.coin.mint); t.children.forEach(walk); }; roots.forEach(walk); return out; };
const kids = (roots: readonly Tree[], mint: string): string[] | null => { let hit: string[] | null = null; const walk = (t: Tree) => { if (t.coin.mint === mint) hit = t.children.map((c) => c.coin.mint); else t.children.forEach(walk); }; roots.forEach(walk); return hit; };

// r1 ─ a ─ a1, a2      r2 ─ c      o (parent "gone", not in the list: a root)
//    └ b
const base = (): BubbleNode[] => [
  node("r1", null, { lockedUsd: 40_000, mcapUsd: 90_000 }), node("a", "r1", { lockedUsd: 3_000, mcapUsd: 12_000 }), node("a1", "a", { mcapUsd: 1_500 }), node("a2", "a", { mcapUsd: 800 }),
  node("b", "r1", { mcapUsd: 2_000 }), node("r2", null, { lockedUsd: 5_000, mcapUsd: 7_000 }), node("c", "r2", { mcapUsd: 300 }), node("o", "gone", { mcapUsd: 50_000 }),
];

test("constants: phone band 700 px, wide tags above 900 px, births within 900 s", () => {
  assert.equal(PHONE_BAND_PX, 700);
  assert.equal(WIDE_PX, 900);
  assert.equal(BIRTH_MAX_AGE_S, 900);
});

test("buildRoots: roots and children in array order, pre-order DFS, the coin is the node itself", () => {
  const ns = base();
  const b = buildRoots(ns);
  assert.deepEqual(b.roots.map((r) => r.coin.mint), ["r1", "r2", "o"]);
  assert.deepEqual(preorder(b.roots), ["r1", "a", "a1", "a2", "b", "r2", "c", "o"]);
  assert.deepEqual(kids(b.roots, "r1"), ["a", "b"]);
  assert.deepEqual(kids(b.roots, "a"), ["a1", "a2"]);
  assert.equal(b.count, 8);
  assert.equal(b.cyclesBroken, 0);
  assert.deepEqual([...b.mints].sort(), ns.map((n) => n.mint).sort());
  assert.equal(b.roots[0].coin, ns[0], "the engine coin is the BubbleNode object");
  assert.deepEqual(buildRoots([]), { roots: [], mints: new Set(), count: 0, cyclesBroken: 0 });
});

test("buildRoots: an appended child is its parent's LAST child; an appended root is the LAST root", () => {
  const ns = [...base(), node("d", "r1"), node("r3", null), node("a3", "a")];
  const b = buildRoots(ns);
  assert.deepEqual(kids(b.roots, "r1"), ["a", "b", "d"]);
  assert.deepEqual(kids(b.roots, "a"), ["a1", "a2", "a3"]);
  assert.deepEqual(b.roots.map((r) => r.coin.mint), ["r1", "r2", "o", "r3"]);
  assert.deepEqual(preorder(b.roots), ["r1", "a", "a1", "a2", "a3", "b", "d", "r2", "c", "o", "r3"]);
  assert.equal(b.count, 11);
});

test("buildRoots: a parent cycle A↔B is walked once (cyclesBroken 1); a self-parent node is a root", () => {
  const ns = [node("x", "y"), node("y", "x"), node("s", "s"), node("k", "s")];
  const b = buildRoots(ns);
  assert.equal(b.cyclesBroken, 1);
  assert.equal(b.count, 4);
  assert.deepEqual(b.roots.map((r) => r.coin.mint), ["s", "x"], "array-order roots first, then the cycle from its first node");
  assert.deepEqual(preorder(b.roots), ["s", "k", "x", "y"]);
  assert.deepEqual(kids(b.roots, "x"), ["y"]);
  assert.deepEqual(kids(b.roots, "y"), [], "the edge back into the walk is dropped");
});

test("buildRoots on the fixture reproduces the API's DFS order and root count", { skip: HAVE_FIXTURE ? false : `no fixture at ${FIXTURE}` }, () => {
  const json = JSON.parse(readFileSync(FIXTURE, "utf8")) as MapResponse;
  const { nodes } = normalise(json);
  const want: string[] = [];
  const walk = (n: { coin: { mint: string }; children?: unknown[] }) => { want.push(n.coin.mint); for (const k of (n.children ?? []) as typeof n[]) walk(k); };
  for (const r of json.roots ?? []) walk(r as unknown as { coin: { mint: string }; children?: unknown[] });
  const t0 = performance.now();
  const b = buildRoots(nodes);
  const ms = performance.now() - t0;
  assert.equal(b.roots.length, (json.roots ?? []).length);
  assert.equal(b.count, want.length);
  assert.equal(b.cyclesBroken, 0);
  const got = preorder(b.roots);
  assert.equal(got.length, want.length);
  const firstDiff = got.findIndex((m, i) => m !== want[i]);
  assert.equal(firstDiff, -1, `pre-order differs from the fixture's DFS at index ${firstDiff}`);
  assert.ok(ms < 250, `buildRoots took ${ms.toFixed(1)} ms on ${want.length} coins`);
});

test("valueFn: locked = lockedUsd (no market-cap slice); mcap = mcapCapUsd ?? mcapUsd, an asset 0; null, NaN and negatives are 0", () => {
  const L = valueFn("locked"), M = valueFn("mcap");
  assert.equal(L(node("q", null, { lockedUsd: 300, mcapUsd: 9_000 })), 300);
  assert.equal(L(node("q", null, { lockedUsd: 0, mcapUsd: 10_000 })), 0, "a coin that locks nothing adds nothing");
  assert.equal(L(node("q", null, { lockedUsd: null, mcapUsd: 100_000 })), 0);
  assert.equal(L(node("q", null, { lockedUsd: -5, mcapUsd: 1_000 })), 0);
  const both = valueFns();
  for (const o of [{ lockedUsd: 300, mcapUsd: 9_000 }, { lockedUsd: null, mcapUsd: 1e9, mcapCapUsd: 5 }, { mcapUsd: 7e9, lockedUsd: 4, asset: true }]) {
    assert.equal(both.locked(node("q", null, o)), L(node("q", null, o)));
    assert.equal(both.mcap(node("q", null, o)), M(node("q", null, o)));
  }
  assert.equal(L(node("q", null, { lockedUsd: null, mcapUsd: null })), 0);
  assert.equal(L(node("q", null, { lockedUsd: null, mcapUsd: Number.NaN })), 0);
  assert.equal(L(node("q", null, { lockedUsd: null, mcapUsd: -400 })), 0);
  assert.equal(L(node("q", null, { lockedUsd: Number.POSITIVE_INFINITY, mcapUsd: 5 })), 0);
  assert.equal(M(node("q", null, { mcapUsd: 7_000, lockedUsd: 99 })), 7_000);
  assert.equal(M(node("q", null, { mcapUsd: null })), 0);
  assert.equal(M(node("q", null, { mcapUsd: Number.NaN })), 0);
  assert.equal(M(node("q", null, { mcapUsd: -1 })), 0);
  // mcap mode (the default, owner 2026-10-21): the server's liquidity cap wins; an asset top's own mcap is 0
  assert.equal(M(node("q", null, { mcapUsd: 1.09e9, mcapCapUsd: 100 })), 100);
  assert.equal(M(node("q", null, { mcapUsd: 7.69e9, asset: true })), 0);
  assert.equal(L(node("q", null, { mcapUsd: 7.69e9, lockedUsd: 50, asset: true })), 50, "locked mode is unchanged");
  assert.equal(M(node("q", null, { mcapUsd: 7_000, mcapCapUsd: null })), 7_000);
});

const sharesMatchDominance = (ns: BubbleNode[], mode: SizeMode) => {
  const b = buildRoots(ns);
  const fs = familyShares(b, valueFn(mode, b.roots));
  const dom = dominance(ns)[mode];
  let priced = 0, sum = 0;
  for (const s of fs.values()) sum += s;
  for (const row of dom.ranked) {
    if (!(row.value > 0)) continue;
    priced++;
    const s = fs.get(row.node.mint);
    assert.ok(s !== undefined, `${mode}: family ${row.node.mint} missing from familyShares`);
    assert.ok(Math.abs(s - row.share) <= 1e-12, `${mode}: ${row.node.mint} share ${s} vs dominance ${row.share}`);
  }
  assert.equal(fs.size, dom.ranked.length, `${mode}: family count`);
  if (priced) assert.ok(Math.abs(sum - 1) < 1e-9, `${mode}: shares add up to ${sum}`);
  return priced;
};

test("familyShares equals lib/map/dominance byTop share on a synthetic set, both modes", () => {
  // o locks 700 in children the map does not draw (a leaf adds nothing to "locked"): three priced families in both modes
  const ns = [...base().map((n) => (n.mint === "o" ? { ...n, lockedUsd: 700 } : n)), node("z", null, { mcapUsd: null, lockedUsd: null }), node("z1", "z", { mcapUsd: null })];
  for (const mode of ["locked", "mcap"] as const) assert.ok(sharesMatchDominance(ns, mode) >= 3);
});

test("familyShares equals lib/map/dominance byTop share on the fixture, both modes", { skip: HAVE_FIXTURE ? false : `no fixture at ${FIXTURE}` }, () => {
  const { nodes } = normalise(JSON.parse(readFileSync(FIXTURE, "utf8")) as MapResponse);
  const roots = nodes.filter((n) => !n.parentMint).length, need = Math.min(100, Math.floor(roots / 2));   // the sample has 24 roots
  for (const mode of ["locked", "mcap"] as const) assert.ok(sharesMatchDominance(nodes, mode) > need, `${mode}: priced families (> ${need})`);
});

test("heatPayload: indexHeat → heatPayload gives the same values by mint; null in, null out", () => {
  const res: HeatResponse = { at: NOW, since: NOW - 86_400, mint: ["m1", "m2", "m3"], t1h: [5, 0, 2], n24: [9, 4, 2], v24: [120.5, 33, 2.25], last: [NOW - 30, NOW - 4_000, NOW - 1_200], buys1h: [3, 0, 1] } as HeatResponse;
  const h: HeatIndex = { at: NOW, version: 3, rows: indexHeat(res) };
  const p = heatPayload(h)!;
  assert.equal(p.at, NOW);
  assert.equal(p.mint.length, 3);
  for (const k of ["last", "n24", "t1h", "v24", "buys1h"] as const) assert.equal(p[k].length, 3, k);
  const resRec = res as unknown as Record<string, number[]>, pRec = p as unknown as Record<string, number[]>;
  for (let i = 0; i < res.mint.length; i++) {
    const k = p.mint.indexOf(res.mint[i]);
    assert.ok(k >= 0, res.mint[i]);
    for (const f of ["last", "n24", "t1h", "v24", "buys1h"]) assert.equal(pRec[f][k], resRec[f][i], `${res.mint[i]}.${f}`);
  }
  assert.deepEqual(p.mint, [...h.rows.keys()], "rows Map order");
  assert.equal(heatPayload(null), null);
});

test("tagFn: the page's tag by family-top mint, null when absent or without a map", () => {
  const f = tagFn(new Map([["r1", "23%"], ["r2", "<0.1%"]]));
  assert.equal(f("r1"), "23%");
  assert.equal(f("r2"), "<0.1%");
  assert.equal(f("nope"), null);
  assert.equal(tagFn(null)("r1"), null);
  assert.equal(tagFn(undefined)("r1"), null);
});

test("diffNodes: births within 900 s under a known parent, identity patches with a new mcap, unknown and removed", () => {
  const ns = base();
  const state = createDiffState(ns);
  const known = new Set(ns.map((n) => n.mint));
  const knows = (m: string) => known.has(m);
  const a2 = { ...ns[1], mcapUsd: 99_000 }; // a: new object, new mcap → patch
  const b2 = { ...ns[4] }; // b: new object, same mcap → no patch
  const born = node("born", "a", { createdAt: NOW - 100 });
  const edge = node("edge", "a1", { createdAt: NOW - BIRTH_MAX_AGE_S }); // exactly 900 s: still a birth
  const old = node("old", "a", { createdAt: NOW - BIRTH_MAX_AGE_S - 1 }); // too old: unknown
  const noDate = node("nodate", "a", { createdAt: null }); // unknown
  const orphan = node("orphan", "zzz", { createdAt: NOW }); // parent not known: unknown
  const next = [ns[0], a2, ns[2], ns[3], b2, ns[5], ns[6], ns[7], born, edge, old, noDate, orphan];
  const byMint = new Map(next.map((n) => [n.mint, n]));
  const d = diffNodes(state, next, byMint, knows, NOW);
  assert.deepEqual(d.births.map((b) => b.coin.mint), ["born", "edge"]);
  assert.equal(d.births[0].coin, born);
  assert.equal(d.births[0].parent, a2, "the parent is the page's latest node");
  assert.equal(d.births[1].parent, ns[2]);
  assert.deepEqual(d.patches, [{ mint: "a", mcapUsd: 99_000 }]);
  assert.equal(d.unknown, 3);
  assert.equal(d.removed, 0);
  // the same list again: the identities were recorded, nothing to patch
  const again = diffNodes(state, next, byMint, knows, NOW);
  assert.deepEqual(again.patches, [], "a second pass over unchanged objects patches nothing");
  // the engine placed the birth: it is known now, and its first sighting is no patch
  known.add("born");
  const placed = diffNodes(state, next, byMint, knows, NOW);
  assert.deepEqual(placed.births.map((b) => b.coin.mint), ["edge"]);
  assert.deepEqual(placed.patches, []);
  // b leaves the list: one removed
  const gone = next.filter((n) => n.mint !== "b");
  const r = diffNodes(state, gone, new Map(gone.map((n) => [n.mint, n])), knows, NOW);
  assert.equal(r.removed, 1);
});

test("diffNodes: a changed logo URL is a patch with `image` (null -> url, url -> url, url -> null); an mcap-only change has no image key", () => {
  const ns = base();
  const state = createDiffState(ns);
  const known = new Set(ns.map((n) => n.mint));
  const knows = (m: string) => known.has(m);
  const u1 = "/api/img?u=https%3A%2F%2Fipfs.test%2Fa.png", u2 = "/api/img?u=https%3A%2F%2Fcdn.test%2Fa.png";
  // a: its metadata arrived (null -> url) with a new mcap; b: a new object with the same image and mcap (nothing); c: mcap only
  let next = ns.map((n) => (n.mint === "a" ? { ...n, image: u1, mcapUsd: 13_000 } : n.mint === "b" ? { ...n } : n.mint === "c" ? { ...n, mcapUsd: 301 } : n));
  let d = diffNodes(state, next, new Map(next.map((n) => [n.mint, n])), knows, NOW);
  assert.deepEqual(d.patches, [{ mint: "a", mcapUsd: 13_000, image: u1 }, { mint: "c", mcapUsd: 301 }]);
  assert.equal("image" in d.patches[1], false, "an mcap-only patch never touches the engine's image");
  // the URL moves (url -> url), then goes away (url -> null); the mcap stays
  next = next.map((n) => (n.mint === "a" ? { ...n, image: u2 } : n));
  d = diffNodes(state, next, new Map(next.map((n) => [n.mint, n])), knows, NOW);
  assert.deepEqual(d.patches, [{ mint: "a", mcapUsd: 13_000, image: u2 }]);
  next = next.map((n) => (n.mint === "a" ? { ...n, image: null } : n));
  d = diffNodes(state, next, new Map(next.map((n) => [n.mint, n])), knows, NOW);
  assert.deepEqual(d.patches, [{ mint: "a", mcapUsd: 13_000, image: null }]);
  // undefined and null are the same "no image" (an older cache row without the field)
  next = next.map((n) => (n.mint === "a" ? ({ ...n, image: undefined } as unknown as BubbleNode) : n));
  d = diffNodes(state, next, new Map(next.map((n) => [n.mint, n])), knows, NOW);
  assert.deepEqual(d.patches, []);
  // a newborn the engine placed (first sighting) is only recorded; its logo arriving later is a patch like any other
  const born = node("born", "a", { createdAt: NOW - 10 });
  next = [...next, born];
  d = diffNodes(state, next, new Map(next.map((n) => [n.mint, n])), knows, NOW);
  assert.deepEqual(d.births.map((b) => b.coin.mint), ["born"]);
  known.add("born");
  d = diffNodes(state, next, new Map(next.map((n) => [n.mint, n])), knows, NOW);
  assert.deepEqual(d.patches, []);
  next = next.map((n) => (n.mint === "born" ? { ...n, image: u1 } : n));
  d = diffNodes(state, next, new Map(next.map((n) => [n.mint, n])), knows, NOW);
  assert.deepEqual(d.patches, [{ mint: "born", mcapUsd: 1_000, image: u1 }]);
});

test("shouldRebuild: max(200, 1 % of coins) drifted AND idle (3 s after a cache paint, else 10 s idle and 10 min since the build)", () => {
  const go = { unknown: 0, removed: 0, coins: 10_000, idleMs: 10_000, sinceBuildMs: 600_000, firstSyncAfterCache: false };
  assert.equal(shouldRebuild({ ...go, unknown: 199 }), false);
  assert.equal(shouldRebuild({ ...go, unknown: 200 }), true);
  assert.equal(shouldRebuild({ ...go, unknown: 120, removed: 80 }), true, "unknown + removed");
  assert.equal(shouldRebuild({ ...go, coins: 50_000, unknown: 499 }), false);
  assert.equal(shouldRebuild({ ...go, coins: 50_000, unknown: 500 }), true);
  assert.equal(shouldRebuild({ ...go, unknown: 200, idleMs: 9_900 }), false);
  assert.equal(shouldRebuild({ ...go, unknown: 200, idleMs: 10_000 }), true);
  assert.equal(shouldRebuild({ ...go, unknown: 200, sinceBuildMs: 599_999 }), false);
  assert.equal(shouldRebuild({ ...go, unknown: 200, sinceBuildMs: 600_000 }), true);
  const cache = { ...go, firstSyncAfterCache: true, sinceBuildMs: 0, unknown: 200 };
  assert.equal(shouldRebuild({ ...cache, idleMs: 2_999 }), false);
  assert.equal(shouldRebuild({ ...cache, idleMs: 3_000 }), true);
  assert.equal(shouldRebuild({ ...cache, unknown: 199, idleMs: 60_000 }), false);
});

test("highlightTest: the page predicate by mint; unknown mints never match; null stays null", () => {
  const ns = base().map((n) => (n.mint === "a1" || n.mint === "c" ? { ...n, ours: true } : n));
  const byMint = new Map(ns.map((n) => [n.mint, n]));
  assert.equal(highlightTest(null, byMint), null);
  const t = highlightTest((n) => !!n.ours, byMint)!;
  assert.deepEqual(ns.filter((n) => t(n.mint)).map((n) => n.mint), ["a1", "c"]);
  assert.equal(t("not-on-the-map"), false);
});

test("reducedMotionNow is false without a DOM", () => {
  assert.equal(reducedMotionNow(), false);
});
