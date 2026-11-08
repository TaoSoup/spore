// Pure logic of the map's data layer (DESIGN §11.5 "Map v2"): live pair counting, highlight keys and
// counts, the rails, the "since your last visit" digest, the full re-sync rule and the bubble sizes
// (family tops weigh their whole family). Share texts: test/share.test.mts.
//
//   node --import tsx --test test/map-logic.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDelta, applyPair, normalise, upsert, type NodeSet } from "../src/lib/map/nodes.ts";
import { HL_KEYS, formatHl, hlCounts, hlPredicate, hlTest, parseHl, type HlCtx, type HlKey } from "../src/lib/map/highlight.ts";
import { railGrowing, railHot, railNew, railSpore, sinceDigest } from "../src/lib/map/rails.ts";
import { earlier, firstborns } from "../src/lib/map/firstborn.ts";

import { applyTrade, indexHeat, type HeatIndex } from "../src/lib/map/heat.ts";
import { FULL_EVERY_MS, needsFull } from "../src/lib/map/use-map-data.ts";
import { SIZE_MODE_LINE, TOP_GROW, TOP_LOG, TOP_MIN, TOP_RATIO, coinRadius, familyRadii, familyValueOf, familyWeights, families, mcapRadius, rangeFor, topMaxWeight, valueOf } from "../src/lib/map/sizing.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";
import type { MapCoin } from "../src/lib/api.ts";

const NOW = 1_800_000_000; // unix s
const node = (mint: string, parentMint: string | null, depth: number, o: Partial<BubbleNode> = {}): BubbleNode => ({
  mint, parentMint, depth, name: `${mint} coin`, symbol: mint.toUpperCase(), image: null, mcapUsd: 500, lockedUsd: null, children: 0, descendants: 0, migrated: false, ours: false, createdAt: NOW - 30 * 86_400, ...o,
});
const coin = (n: BubbleNode): MapCoin => ({ mint: n.mint, name: n.name, symbol: n.symbol, image: n.image, depth: n.depth, mcapUsd: n.mcapUsd, lockedUsd: n.lockedUsd, children: n.children, descendants: n.descendants ?? 0, migrated: n.migrated, createdAt: n.createdAt ?? null, parentMint: n.parentMint });

// root ─ a ─ a1, a2      root2 ─ b      (createdAt chosen per test)
function fixture(): BubbleNode[] {
  return [
    node("root", null, 0, { children: 2, descendants: 4, lockedUsd: 40_000, mcapUsd: 90_000, ours: false }),
    node("a", "root", 1, { children: 2, descendants: 2, lockedUsd: 3_000, mcapUsd: 12_000, createdAt: NOW - 1_800, migrated: true }),
    node("a1", "a", 2, { mcapUsd: 1_500, createdAt: NOW - 600, ours: true }),
    node("a2", "a", 2, { mcapUsd: 800, createdAt: null }),
    node("c", "root", 1, { mcapUsd: 2_000, createdAt: NOW - 20 * 3_600, ours: true }),
    node("root2", null, 0, { children: 1, descendants: 1, lockedUsd: 5_000, mcapUsd: 7_000 }),
    node("b", "root2", 1, { mcapUsd: 300, createdAt: NOW - 40 * 3_600 }),
  ];
}
const setOf = (ns: BubbleNode[]): NodeSet => new Map(ns.map((n) => [n.mint, n]));
const heatOf = (rows: Record<string, { t1h: number; n24?: number; v24?: number; last?: number; buys1h?: number }>): HeatIndex => ({
  at: NOW, version: 1, rows: new Map(Object.entries(rows).map(([m, r]) => [m, { t1h: r.t1h, n24: r.n24 ?? r.t1h, v24: r.v24 ?? 0, last: r.last ?? (r.t1h ? NOW - 60 : NOW - 7_200), buys1h: r.buys1h ?? 0 }])),
});

// ---------------------------------------------------------------- applyPair
test("applyPair: a new grandchild counts on every ancestor the set holds", () => {
  const set = setOf(fixture());
  const child = node("a3", "a", 2, { createdAt: NOW });
  applyPair(set, { coin: coin(child), parent: coin(set.get("a")!) });
  assert.equal(set.get("a")!.children, 3);
  assert.equal(set.get("a")!.descendants, 3);
  assert.equal(set.get("root")!.children, 2, "the root's direct children do not change");
  assert.equal(set.get("root")!.descendants, 5);
  assert.equal(set.get("a3")!.parentMint, "a");
  // the same event again (a replay) changes nothing
  applyPair(set, { coin: coin(child), parent: coin(set.get("a")!) });
  assert.equal(set.get("root")!.descendants, 5);
  assert.equal(set.get("a")!.children, 3);
});
test("applyPair: an unknown parent under a known root adds both, the root counts two", () => {
  const set = setOf(fixture());
  const parent = node("p", "root2", 1, { children: 1, descendants: 1 });
  const child = node("p1", "p", 2);
  applyPair(set, { coin: coin(child), parent: coin(parent) });
  assert.ok(set.has("p") && set.has("p1"));
  assert.equal(set.get("p")!.children, 1, "the parent keeps the server's counts");
  assert.equal(set.get("root2")!.children, 2);
  assert.equal(set.get("root2")!.descendants, 3);
});
test("applyPair: a brand-new root is inserted from the event", () => {
  const set = setOf(fixture());
  const parent = node("r3", null, 0, { children: 1, descendants: 1 });
  applyPair(set, { coin: coin(node("r3c", "r3", 1)), parent: coin(parent) });
  assert.equal(set.get("r3")!.descendants, 1);
  assert.equal(set.get("r3c")!.parentMint, "r3");
  assert.equal(set.get("root")!.descendants, 4);
});

// ---------------------------------------------------------------- highlight
const ctx = (o: Partial<HlCtx> = {}): HlCtx => ({ nowS: NOW, seenAtS: NOW - 3 * 3_600, heat: heatOf({ a: { t1h: 4 }, b: { t1h: 0, last: NOW - 1_200 }, c: { t1h: 0 } }), ...o });
test("hlCounts equals a manual filter for every key", () => {
  const ns = fixture(), c = ctx();
  const counts = hlCounts(ns, c);
  const manual: Record<HlKey, (n: BubbleNode) => boolean> = {
    ours: (n) => !!n.ours,
    new1h: (n) => n.createdAt != null && n.createdAt >= NOW - 3_600,
    new24h: (n) => n.createdAt != null && n.createdAt >= NOW - 86_400,
    grad: (n) => n.migrated,
    min1k: (n) => (n.mcapUsd ?? 0) >= 1_000,
    active: (n) => n.mint === "a" || n.mint === "b",
    since: (n) => n.createdAt != null && n.createdAt > NOW - 3 * 3_600,
  };
  for (const k of HL_KEYS) assert.equal(counts[k], ns.filter(manual[k]).length, k);
  assert.deepEqual(counts, { ours: 2, new1h: 2, new24h: 3, grad: 1, min1k: 5, active: 2, since: 2 });
});
test("hlTest: createdAt null is never new; without heat nothing is active; first visit has no 'since'", () => {
  const a2 = fixture().find((n) => n.mint === "a2")!;
  for (const k of ["new1h", "new24h", "since"] as HlKey[]) assert.equal(hlTest(k, a2, ctx()), false, k);
  assert.equal(hlTest("active", fixture()[1], ctx({ heat: null })), false);
  assert.equal(hlTest("since", fixture()[2], ctx({ seenAtS: null })), false);
});
test("hlPredicate: AND of the keys, null when empty", () => {
  const c = ctx();
  assert.equal(hlPredicate([], c), null);
  const p = hlPredicate(["ours", "min1k"], c)!;
  assert.deepEqual(fixture().filter(p).map((n) => n.mint), ["a1", "c"]);
  const q = hlPredicate(["ours", "new1h"], c)!;
  assert.deepEqual(fixture().filter(q).map((n) => n.mint), ["a1"]);
  const r = hlPredicate(["grad", "active", "new1h"], c)!;
  assert.deepEqual(fixture().filter(r).map((n) => n.mint), ["a"]);
});
test("parseHl / formatHl round trip, canonical order, unknown keys dropped", () => {
  assert.deepEqual(parseHl(null), []);
  assert.deepEqual(parseHl(""), []);
  assert.deepEqual(parseHl("grad,bogus,ours,grad, MIN1K "), ["ours", "grad", "min1k"]);
  assert.equal(formatHl([]), null);
  assert.equal(formatHl(["since", "ours"]), "ours,since");
  for (const keys of [["ours"], ["new1h", "active"], [...HL_KEYS]] as HlKey[][]) assert.deepEqual(parseHl(formatHl(keys)), keys);
  assert.equal(formatHl(parseHl("active,ours,x")), "ours,active");
});

// ---------------------------------------------------------------- rails
test("railNew: depth ≥ 1 by createdAt desc, live arrivals first, cap, createdAt null excluded", () => {
  const ns = fixture(), by = setOf(ns);
  const rows = railNew(ns, by, [], 15);
  assert.deepEqual(rows.map((r) => r.node.mint), ["a1", "a", "c", "b"]);
  assert.equal(rows[0].parent?.mint, "a");
  assert.equal(rows[0].root?.mint, "root");
  assert.equal(rows[0].metric, NOW - 600);
  assert.deepEqual(railNew(ns, by, [], 2).map((r) => r.node.mint), ["a1", "a"]);
  // a live pair goes first even when it is older than the top of the list
  assert.deepEqual(railNew(ns, by, [by.get("b")!], 3).map((r) => r.node.mint), ["b", "a1", "a"]);
  // a live entry without createdAt, or not on the map, is skipped
  assert.deepEqual(railNew(ns, by, [by.get("a2")!, node("gone", "root", 1)], 2).map((r) => r.node.mint), ["a1", "a"]);
});
test("railHot: by trades in the last hour, ties by 24 h volume; [] without heat", () => {
  const ns = fixture(), by = setOf(ns);
  const heat = heatOf({ a: { t1h: 4, v24: 10 }, c: { t1h: 9, v24: 1 }, b: { t1h: 4, v24: 50 }, zz: { t1h: 99 }, a2: { t1h: 0, v24: 900 } });
  const rows = railHot(ns, by, heat, 12);
  assert.deepEqual(rows.map((r) => [r.node.mint, r.metric]), [["c", 9], ["b", 4], ["a", 4]]);
  assert.deepEqual(railHot(ns, by, heat, 1).map((r) => r.node.mint), ["c"]);
  assert.deepEqual(railHot(ns, by, null), []);
});
test("railGrowing: roots by descendants created in the window", () => {
  const ns = fixture(), by = setOf(ns);
  const rows = railGrowing(ns, by, NOW, 86_400, 10);
  assert.deepEqual(rows.map((r) => [r.node.mint, r.metric]), [["root", 3]]);
  assert.equal(rows[0].root, null, "a root row has no separate root");
  const wide = railGrowing(ns, by, NOW, 3 * 86_400, 10);
  assert.deepEqual(wide.map((r) => [r.node.mint, r.metric]), [["root", 3], ["root2", 1]]);
  assert.deepEqual(railGrowing(ns, by, NOW, 3 * 86_400, 1).map((r) => r.node.mint), ["root"]);
});
test("railSpore: Spore launches by mcap", () => {
  const ns = fixture(), by = setOf(ns);
  assert.deepEqual(railSpore(ns, by).map((r) => [r.node.mint, r.metric]), [["c", 2_000], ["a1", 1_500]]);
  assert.deepEqual(railSpore(ns, by, 1).map((r) => r.node.mint), ["c"]);
});
test("sinceDigest: pairs after the last visit, trees they landed in, top trees", () => {
  const ns = fixture(), by = setOf(ns);
  const d = sinceDigest(ns, by, NOW - 3 * 3_600);
  assert.equal(d.pairs, 2);
  assert.equal(d.roots, 1);
  assert.deepEqual(d.top.map((r) => [r.node.mint, r.metric]), [["root", 2]]);
  const all = sinceDigest(ns, by, NOW - 10 * 86_400);
  assert.equal(all.pairs, 4);
  assert.equal(all.roots, 2);
  assert.deepEqual(sinceDigest(ns, by, null), { pairs: 0, roots: 0, top: [] });
  assert.equal(sinceDigest(ns, by, NOW).pairs, 0, "strictly after the visit");
});


// ---------------------------------------------------------------- heat
test("indexHeat + applyTrade: rows by mint, live trades counted in place", () => {
  const idx = indexHeat({ at: NOW, since: NOW - 86_400, mint: ["a", "b"], t1h: [2, 0], n24: [5, 1], v24: [10.5, 2], last: [NOW - 30, NOW - 7_000], buys1h: [1, 0] });
  assert.deepEqual(idx.get("a"), { t1h: 2, n24: 5, v24: 10.5, last: NOW - 30, buys1h: 1 });
  applyTrade(idx, { mint: "a", time: NOW, isBuy: true, valueUsd: 4.25 }, NOW);
  assert.deepEqual(idx.get("a"), { t1h: 3, n24: 6, v24: 14.75, last: NOW, buys1h: 2 });
  applyTrade(idx, { mint: "n", time: NOW - 2 * 3_600, isBuy: false, valueUsd: null }, NOW);
  assert.deepEqual(idx.get("n"), { t1h: 0, n24: 1, v24: 0, last: NOW - 7_200, buys1h: 0 });
  applyTrade(idx, { mint: "old", time: NOW - 2 * 86_400, isBuy: true, valueUsd: 1 }, NOW);
  assert.equal(idx.has("old"), false);
});

// ---------------------------------------------------------------- full re-sync rule
test("needsFull: never loaded, or the last complete load is older than 15 min", () => {
  const now = 1_760_000_000_000;
  assert.equal(FULL_EVERY_MS, 15 * 60_000);
  assert.equal(needsFull(null, now), true);
  assert.equal(needsFull(Number.NaN, now), true);
  assert.equal(needsFull(now - 60_000, now), false);
  assert.equal(needsFull(now - FULL_EVERY_MS, now), false);
  assert.equal(needsFull(now - FULL_EVERY_MS - 1, now), true);
  assert.equal(needsFull(now - 20 * 60_000, now), true);
});

// ---------------------------------------------------------------- sizes: family tops weigh their family
test("families: tops, members and the walk to the top (an unknown parent makes a top)", () => {
  const ns = [...fixture(), node("orphan", "nowhere", 1), node("o1", "orphan", 2)];
  const f = families(ns);
  const at = (m: string) => ns.findIndex((n) => n.mint === m);
  assert.deepEqual([...f.top].map((q) => ns[q].mint), ["root", "root", "root", "root", "root", "root2", "root2", "orphan", "orphan"]);
  assert.equal(f.members[at("root")], 5);
  assert.equal(f.members[at("root2")], 2);
  assert.equal(f.isTop[at("root")], 1);
  assert.equal(f.isTop[at("orphan")], 1, "a coin whose parent is not on the map tops its family");
  assert.equal(f.isTop[at("a")], 0);
  assert.equal(f.parent[at("a1")], at("a"));
  // a lone bubble is not a top
  const lone = families([node("solo", null, 0)]);
  assert.equal(lone.isTop[0], 0);
});
test("familyWeights: a top weighs its family value (Σ familyValueOf, own included), the rest their own", () => {
  const ns = fixture();
  const f = families(ns);
  const w = familyWeights(ns, f, "locked");
  const at = (m: string) => ns.findIndex((n) => n.mint === m);
  // locked = Σ lockedUsd: root locks 40 000, a 3 000; the leaves lock nothing and add nothing (no market-cap slice)
  assert.equal(w[at("root")], 40_000 + 3_000);
  assert.equal(w[at("a")], 3_000);
  assert.ok(Number.isNaN(w[at("a1")]), "a leaf with no lockedUsd: nothing known (it is sized by its own market cap)");
  assert.equal(w[at("root2")], 5_000);
  assert.equal(valueOf, familyValueOf, "the old name is the same rule");
  assert.equal(familyValueOf({ lockedUsd: 0, mcapUsd: 10_000 }, "locked"), 0);
  assert.equal(familyValueOf({ lockedUsd: null, mcapUsd: 1e6 }, "locked"), null);
  assert.equal(familyValueOf({ lockedUsd: 12, mcapUsd: 1_000 }, "locked"), 12);
  assert.equal(familyValueOf({ lockedUsd: 7, mcapUsd: null }, "mcap"), null);
  assert.equal(familyValueOf({ lockedUsd: 7, mcapUsd: 1e9, mcapCapUsd: 50 }, "mcap"), 50);
  assert.equal(familyValueOf({ lockedUsd: 7, mcapUsd: 1e9, asset: true }, "mcap"), 0);
  assert.deepEqual(Object.keys(SIZE_MODE_LINE).sort(), ["locked", "mcap"]);
  assert.equal(SIZE_MODE_LINE.locked, "Families: share of the value locked in their children's curves · coins: their own market cap");
  assert.equal(SIZE_MODE_LINE.mcap, "Families: share of market cap (every coin in the family) · coins: their own market cap");
  const m = familyWeights(ns, f, "mcap");
  assert.equal(m[at("root")], 90_000 + 12_000 + 1_500 + 800 + 2_000);
  // no value at all: NaN for a member, 0 for a top
  const bare = [node("t", null, 0, { mcapUsd: null }), node("k", "t", 1, { mcapUsd: null })];
  const bw = familyWeights(bare, families(bare), "mcap");
  assert.equal(bw[0], 0);
  assert.ok(Number.isNaN(bw[1]));
});
test("size by mcap: asset tops and the liquidity cap travel from the wire into the node set and the weights", () => {
  // a tree with an asset top (CARDS) and a junk member the server capped; then a delta clears the cap
  const res = { roots: [{ coin: { ...coin(node("cards", null, 0, { mcapUsd: 364_000_000, lockedUsd: 9_000 })), asset: true } as MapCoin, children: [
    { coin: coin(node("poke", "cards", 0, { mcapUsd: 356_700 })), children: [{ coin: coin(node("char", "poke", 1, { mcapUsd: 25_330 })), children: [] }] },
    { coin: { ...coin(node("junk", "cards", 0, { mcapUsd: 1.09e9 })), mcapCapUsd: 100 } as MapCoin, children: [] },
  ] }] };
  const set: NodeSet = new Map();
  upsert(set, normalise(res).nodes);
  assert.equal(set.get("cards")!.asset, true);
  assert.equal(set.get("poke")!.asset, undefined);
  assert.equal(set.get("junk")!.mcapCapUsd, 100);
  assert.equal(set.get("poke")!.mcapCapUsd, null);
  const ns = [...set.values()];
  const w = familyWeights(ns, families(ns), "mcap");
  assert.equal(w[ns.findIndex((n) => n.mint === "cards")], 356_700 + 25_330 + 100, "Σ members (junk at its cap), the asset's own mcap excluded");
  assert.equal(valueOf(set.get("cards")!, "locked"), 9_000, "locked mode is unchanged");
  // a newer server's delta row carries mcapCapUsd (null clears it); an older one omits it (kept)
  applyDelta(set, [{ mint: "junk", mcapUsd: 1.09e9, lockedUsd: null, children: 0, descendants: 0, migrated: false, mcapCapUsd: null } as never]);
  assert.equal(set.get("junk")!.mcapCapUsd, null);
  applyDelta(set, [{ mint: "poke", mcapUsd: 400_000, lockedUsd: null, children: 0, descendants: 0, migrated: false }]);
  assert.equal(set.get("poke")!.mcapUsd, 400_000); assert.equal(set.get("poke")!.mcapCapUsd, null);
  // a full tree that newly flags an asset replaces a cached node that lacked the flag
  const stale: NodeSet = new Map([["cards", { ...set.get("cards")!, asset: undefined }]]);
  assert.equal(upsert(stale, normalise(res).nodes).some((n) => n.mint === "cards"), true);
  assert.equal(stale.get("cards")!.asset, true);
});

test("mcapRadius is map3 layout.js rad(); coinRadius = clamp(floor, maxR, floor × rad / 0.55)", () => {
  // the engine's own formula, verbatim
  const rad = (m: number) => !(m > 0) ? 0.55 : m < 2000 ? 0.55 + 0.45 * Math.max(0, Math.min(1, Math.log(m / 300) / Math.log(2000 / 300))) : Math.min(7, 1 + 1.54 * Math.log10(m / 2000));
  for (const m of [0, -5, NaN, 1, 300, 800, 1_999, 2_000, 20_000, 1e6, 1e9, 1e12]) assert.equal(mcapRadius(m), rad(m), String(m));
  assert.equal(mcapRadius(null), 0.55); assert.equal(mcapRadius(undefined), 0.55);
  assert.equal(mcapRadius(2_000), 1); assert.equal(mcapRadius(1e12), 7);
  const sc = { floor: 5, maxR: 52 };
  assert.equal(coinRadius(null, sc), 5, "no market cap: the floor");
  assert.equal(coinRadius(2_000, sc), 5 / 0.55);
  assert.equal(coinRadius(1e12, sc), 52, "capped at maxR");
  assert.ok(coinRadius(20_000, sc) > coinRadius(2_000, sc));
});
test("familyRadii: tops by family value (area ∝ value), every other coin by its own market cap in both modes", () => {
  // a top with two children and a crowd of tiny ones; a second family of 700 near-zero coins; a $1B lone coin
  const ns = [node("t", null, 0, { lockedUsd: 30_000, mcapUsd: 90_000 }), node("big", "t", 1, { lockedUsd: 10_000, mcapUsd: 400_000 }), node("mid", "t", 1, { lockedUsd: 2_500, mcapUsd: 25_000 }),
    ...Array.from({ length: 30 }, (_, i) => node(`s${i}`, "t", 1, { lockedUsd: 1, mcapUsd: 300 })), node("crowd", null, 0, { lockedUsd: 1 }),
    ...Array.from({ length: 700 }, (_, i) => node(`c${i}`, "crowd", 1, { lockedUsd: 0.5, mcapUsd: 1 })), node("x", "big", 2, { mcapUsd: null, lockedUsd: null }),
    node("lone", null, 0, { mcapUsd: 1e9, lockedUsd: 1e7 })];
  const f = families(ns);
  const at = (m: string) => ns.findIndex((n) => n.mint === m);
  const radii: Record<string, Float32Array> = {};
  for (const mode of ["locked", "mcap"] as const) {
    const w = familyWeights(ns, f, mode);
    const maxW = topMaxWeight(f, w);
    assert.equal(maxW, w[at("t")], `${mode}: maxW is the heaviest TOP, never the lone coin`);
    const sc = { maxW, rangeR: 200, floor: 5, maxR: 52 };
    const r = familyRadii(f, w, sc, ns);
    radii[mode] = r;
    assert.ok(Math.abs(r[at("t")] - Math.max(200, TOP_RATIO * r[at("big")])) < 1e-3, `${mode}: the heaviest family's top at rangeR (or its ratio floor)`);
    for (const m of ["big", "mid", "s0", "c0", "x", "lone"]) assert.equal(r[at(m)], Math.fround(coinRadius(ns[at(m)].mcapUsd, sc)), `${mode} ${m}: own market cap`);
    // every top is ≥ TOP_RATIO × its largest member and at least its count floor
    for (const top of ["t", "crowd"]) {
      const q = at(top);
      let biggest = 0; for (let i = 0; i < ns.length; i++) if (i !== q && f.top[i] === q && r[i] > biggest) biggest = r[i];
      assert.ok(r[q] >= TOP_RATIO * biggest - 1e-4 && TOP_RATIO >= 1.5, `${mode} ${top}: ${r[q]} vs largest member ${biggest}`);
      assert.ok(r[q] >= 5 * (TOP_MIN + TOP_LOG * Math.log10(f.members[q])) - 1e-4, `${mode} ${top}: count floor`);
    }
    // the crowded family's coins hold almost nothing: its top still stands out (≥ 3× the floor at 700)
    assert.ok(r[at("crowd")] >= 15, `crowd top ${r[at("crowd")]}`);
  }
  // non-top radii are byte-identical across the modes; only the tops move
  for (let q = 0; q < ns.length; q++) if (!f.isTop[q]) assert.equal(radii.locked[q], radii.mcap[q], ns[q].mint);
  assert.ok(radii.mcap[at("big")] > radii.mcap[at("mid")], "a bigger market cap draws a bigger child");
  // a heavy member forces its top up to TOP_RATIO × it even when the family value alone is small
  const pair = [node("p", null, 0, { lockedUsd: 1 }), node("q", "p", 1, { lockedUsd: 90_000, mcapUsd: 5e6 })];
  const pf = families(pair), pw = familyWeights(pair, pf, "locked");
  const pr = familyRadii(pf, pw, { maxW: pw[0], rangeR: 100, floor: 5, maxR: 52 }, pair);
  assert.ok(pr[0] >= TOP_RATIO * pr[1] - 1e-4);
});
test("rangeFor: TOP_GROW × maxR on a big forest, never below maxR, capped on a small one", () => {
  const big = [node("t", null, 0, { lockedUsd: 1e6 }), ...Array.from({ length: 16_000 }, (_, i) => node(`k${i}`, "t", 1, { lockedUsd: 1 }))];
  const bf = families(big), bw = familyWeights(big, bf, "locked");
  assert.equal(rangeFor(bf, bw, { maxW: bw[0], floor: 5, maxR: 52 }, big), 52 * TOP_GROW);
  const small = [node("t", null, 0, { lockedUsd: 1e6 }), node("k", "t", 1, { lockedUsd: 1 }), node("j", "t", 1, { lockedUsd: 1 })];
  const sf = families(small), sw = familyWeights(small, sf, "locked");
  const rr = rangeFor(sf, sw, { maxW: sw[0], floor: 7, maxR: 52 }, small);
  assert.equal(rr, 52, "a three-coin map keeps today's largest radius (the fit cap would shrink it below)");
  // a lone coin heavier than every top is not "the heaviest": the cap excludes the heaviest TOP's own disc
  const withLone = [...small, node("solo", null, 0, { lockedUsd: 1e9 })];
  const lf = families(withLone), lw = familyWeights(withLone, lf, "locked");
  assert.equal(topMaxWeight(lf, lw), 1e6 + 2, "t and its two members, not solo");
  assert.equal(rangeFor(lf, lw, { maxW: topMaxWeight(lf, lw), floor: 7, maxR: 52 }, withLone), 52);
  const mid = [node("t", null, 0, { lockedUsd: 1e6 }), ...Array.from({ length: 400 }, (_, i) => node(`m${i}`, "t", 1, { lockedUsd: 1 }))];
  const mf = families(mid), mw = familyWeights(mid, mf, "locked");
  const mr = rangeFor(mf, mw, { maxW: mw[0], floor: 5, maxR: 52 }, mid);
  assert.ok(mr > 52 && mr < 52 * TOP_GROW, `a 400-coin map is capped between: ${mr}`);
});

// ---- positions are data (owner 2026-10-20): deterministic placement and the incremental store paths
import { placeChild } from "../src/lib/map/place.ts";
import { MapStore, PLACE_GAP } from "../src/components/map/store.ts";

/// Every pair in the draw order respects rebuildOrder's key (tops last, radius ascending, generation descending).
function orderSorted(st: MapStore): boolean {
  const o = st.order, n = st.n;
  if (st.orderN !== n) return false;
  const seen = new Uint8Array(n);
  for (let q = 0; q < n; q++) { if (seen[o[q]]) return false; seen[o[q]] = 1; }
  for (let q = 1; q < n; q++) {
    const a = o[q - 1], b = o[q];
    const key = st.top[a] - st.top[b] || st.rT[a] - st.rT[b] || st.depth[b] - st.depth[a];
    if (key > 0) return false;
  }
  for (let q = 0; q < n; q++) if ((q >= st.topStart) !== (st.top[o[q]] === 1)) return false;
  return true;
}
function fill(st: MapStore, ns: BubbleNode[], r: (n: BubbleNode) => number) {
  for (const n of ns) st.add(n, (n.x ?? NaN), (n.y ?? NaN), r(n), 0);
}
const radius = (n: BubbleNode) => (n.parentMint ? 6 + (n.mcapUsd ?? 0) / 500 : 24);

test("placeChild: next to the parent, clear of the siblings and the top, outward, deterministic", () => {
  // top at the origin, parent to its right, three children already around the parent
  const x = new Float32Array([0, 80, 110, 100, 90, NaN]), y = new Float32Array([0, 0, 20, -25, 30, NaN]), r = new Float32Array([24, 10, 6, 6, 6, 7]);
  const members = [0, 1, 2, 3, 4, 5];
  const [px, py] = placeChild(x, y, r, 5, 1, 0, members, PLACE_GAP);
  assert.ok(Number.isFinite(px) && Number.isFinite(py));
  // on the first ring, outward (to the right of the parent, away from the top)
  assert.ok(Math.abs(Math.hypot(px - 80, py) - (10 + 7 + PLACE_GAP)) < 1e-3, "first ring");
  assert.ok(px > 80, "placed on the far side of the parent from the top");
  for (const m of [2, 3, 4]) assert.ok(Math.hypot(px - x[m], py - y[m]) >= r[5] + r[m], `clear of sibling ${m}`);
  assert.ok(Math.hypot(px, py) >= 24 + 7, "outside the top's disc");
  const again = placeChild(x, y, r, 5, 1, 0, members, PLACE_GAP);
  assert.deepEqual(again, [px, py]);
  // a crowded first ring: the spot moves to the next ring, still clear
  const cx = new Float32Array(40), cy = new Float32Array(40), cr = new Float32Array(40).fill(5);
  cx[0] = 0; cy[0] = 0; cr[0] = 20;
  for (let q = 1; q < 39; q++) { const a = (q / 38) * Math.PI * 2; cx[q] = Math.cos(a) * 33; cy[q] = Math.sin(a) * 33; }
  cx[39] = NaN; cy[39] = NaN;
  const mem = Array.from({ length: 40 }, (_, q) => q);
  const [qx, qy] = placeChild(cx, cy, cr, 39, 0, 0, mem, PLACE_GAP);
  for (let q = 1; q < 39; q++) assert.ok(Math.hypot(qx - cx[q], qy - cy[q]) >= 10, `crowded: clear of ${q}`);
  assert.ok(Math.hypot(qx, qy) > 33, "crowded: on an outer ring");
});

test("store: appending live pairs in place equals a full rebuild (links, children, tops, order, clusters)", () => {
  const base: BubbleNode[] = [];
  for (let t = 0; t < 4; t++) {
    base.push(node(`r${t}`, null, 0, { children: 3, mcapUsd: 5_000 * (t + 1) }));
    for (let c = 0; c < 3 + t; c++) { base.push(node(`r${t}c${c}`, `r${t}`, 1, { mcapUsd: 300 * (c + 1) })); if (c % 2) base.push(node(`r${t}c${c}g`, `r${t}c${c}`, 2, { mcapUsd: 100 })); }
  }
  base.push(node("lone", null, 0, { mcapUsd: 900 })); // a root without children: not a top until its first child arrives
  base.forEach((n, q) => { n.x = (q % 7) * 40; n.y = Math.floor(q / 7) * 40; });
  const inc = new MapStore();
  fill(inc, base, radius);
  inc.rebuildLinks(); inc.rebuildClusters(true, 1.6); inc.rebuildOrder();
  for (const c of inc.clusters) inc.measure(c, inc.nx, inc.ny, false);
  assert.ok(orderSorted(inc));
  // live: two pairs under r1c0, one under the lone root, one brand-new root
  const live = [node("newA", "r1c0", 2, { mcapUsd: 2_000 }), node("newB", "r1c0", 2, { mcapUsd: 50 }), node("loneKid", "lone", 1, { mcapUsd: 400 }), node("freshRoot", null, 0, { mcapUsd: 10 })];
  const added: number[] = [];
  for (const n of live) added.push(inc.add(n, NaN, NaN, radius(n), 0));
  const newTops = inc.addLinks(added);
  assert.deepEqual(newTops, [inc.idx.get("lone")], "the lone root became a top");
  const touched = inc.addToClusters(added);
  for (const i of added) { const p = inc.parent[i]; if (p >= 0) inc.placeNear(i, p); else { const c = inc.clusters[inc.cluster[i]]; inc.nx[i] = c.cx; inc.ny[i] = c.cy; } inc.insertOrder(i); }
  inc.reorderSome(newTops);
  for (const ci of touched) inc.measure(inc.clusters[ci], inc.nx, inc.ny, false);
  assert.ok(orderSorted(inc), "draw order stays sorted after the inserts");
  // the full rebuild of the same list
  const full = new MapStore();
  fill(full, base.concat(live), radius);
  full.rebuildLinks(); full.rebuildClusters(true, 1.6); full.rebuildOrder();
  assert.equal(inc.n, full.n);
  assert.deepEqual(Array.from(inc.parent.subarray(0, inc.n)), Array.from(full.parent.subarray(0, full.n)), "parents");
  assert.deepEqual(Array.from(inc.childStart), Array.from(full.childStart), "CSR starts");
  assert.deepEqual(Array.from(inc.childList), Array.from(full.childList), "CSR lists");
  assert.deepEqual(Array.from(inc.top.subarray(0, inc.n)), Array.from(full.top.subarray(0, full.n)), "tops");
  assert.deepEqual(Array.from(inc.depth.subarray(0, inc.n)), Array.from(full.depth.subarray(0, full.n)), "generations");
  assert.equal(inc.m, full.m, "link count");
  assert.equal(inc.topStart, full.topStart);
  assert.ok(orderSorted(full));
  const members = (st: MapStore) => new Map(st.clusters.map((c) => [c.id, { m: c.members.map((i) => st.ids[i]).sort(), count: c.count, title: c.title, mcap: Math.round(c.mcapSum) }]));
  assert.deepEqual(members(inc), members(full), "cluster members, counts, titles, mcap sums");
  for (let i = 0; i < inc.n; i++) assert.equal(inc.clusters[inc.cluster[i]].id, full.clusters[full.cluster[i]].id, `cluster of ${inc.ids[i]}`);
  assert.deepEqual(Array.from(inc.titleOrder).map((ci) => inc.clusters[ci].id), Array.from(full.titleOrder).map((ci) => full.clusters[ci].id), "title ranking");
  // placed next to the parent and clear of the family
  for (const i of added) {
    const p = inc.parent[i];
    if (p < 0) continue;
    assert.ok(Number.isFinite(inc.nx[i]) && Number.isFinite(inc.ny[i]));
    const d = Math.hypot(inc.nx[i] - inc.nx[p], inc.ny[i] - inc.ny[p]);
    assert.ok(d >= inc.rT[i] + inc.rT[p] + PLACE_GAP - 1e-3 && d < inc.rT[i] + inc.rT[p] + PLACE_GAP + 8 * (2 * inc.rT[i] + PLACE_GAP) + 1e-3, `next to the parent (${d.toFixed(1)})`);
    for (const j of inc.clusters[inc.cluster[i]].members) { if (j === i || j === p || !Number.isFinite(inc.nx[j])) continue; assert.ok(Math.hypot(inc.nx[i] - inc.nx[j], inc.ny[i] - inc.ny[j]) >= inc.rT[i] + inc.rT[j], `${inc.ids[i]} clear of ${inc.ids[j]}`); }
  }
  // a radius change re-sorts only that node; past REORDER_MAX changes the whole order is rebuilt
  const big = inc.idx.get("r0c0")!;
  inc.rT[big] = 100; inc.reorderSome([big]);
  assert.ok(orderSorted(inc), "re-sorted after one radius change");
  assert.equal(inc.order[inc.topStart - 1], big, "the biggest non-top is drawn last of its run");
  for (let i = 0; i < inc.n; i++) inc.rT[i] = 5 + ((i * 7919) % 50);
  inc.reorderSome(Array.from({ length: inc.n }, (_, i) => i));
  assert.ok(orderSorted(inc), "full rebuild keeps the invariant");
});

// ---------------------------------------------------------------- firstborn
test("firstborns: earliest child per parent; undated child only when alone; stable ties; cached per array", () => {
  const ns = fixture();
  const first = firstborns(ns);
  // root: a (NOW-1800) vs c (NOW-20h) → c; a: a1 (NOW-600) vs a2 (undated) → a1; root2: b alone → b
  assert.deepEqual([...first].sort(), ["a1", "b", "c"]);
  assert.equal(firstborns(ns), first, "same array → same set");
  // an undated only child counts; two undated children mark nobody
  const lone = [node("p", null, 0), node("k", "p", 1, { createdAt: null })];
  assert.deepEqual([...firstborns(lone)], ["k"]);
  const twoUndated = [node("p", null, 0), node("k2", "p", 1, { createdAt: null }), node("k1", "p", 1, { createdAt: null })];
  assert.deepEqual([...firstborns(twoUndated)], []);
  // a dated child beats an undated one whatever the order; equal createdAt → the smaller mint
  const mixed = [node("p", null, 0), node("z", "p", 1, { createdAt: null }), node("y", "p", 1, { createdAt: NOW - 5 }), node("x", "p", 1, { createdAt: NOW - 5 })];
  assert.deepEqual([...firstborns(mixed)], ["x"]);
  assert.equal(earlier(mixed[3], mixed[2]), true);
  assert.equal(earlier(mixed[2], mixed[1]), true);
  // a self-quoted or parentless node is never a child
  assert.deepEqual([...firstborns([node("s", "s", 1), node("r", null, 0)])], []);
});
