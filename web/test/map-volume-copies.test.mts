// Colour by volume (lib/map/volume.ts) and copycat stacking (lib/map/copies.ts): the rank inside a family and its tiers,
// the colour clock the engine is handed (its heat class per tier, the real `last` untouched), the spotlight, the side
// panel's leaders; which same-ticker siblings stack, who leads, and what never stacks.
//
//   node --import tsx --test test/map-volume-copies.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { VOL_LEADERS, VOL_LEAD_AGE, VOL_TIER_AGE, colourLast, familyLeaders, formatColour, parseColour, spotlight, topFn, volTier, volumeRanks } from "../src/lib/map/volume.ts";
import { copyGroup, parseCopies, stackCopies, tickerKey } from "../src/lib/map/copies.ts";
import { heatPayload } from "../src/components/map3/adapter.ts";
import { heatClass } from "../src/components/map3/engine/tokens.js";
import { ingest } from "../src/components/map3/engine/data.js";
import type { HeatIndex, HeatRow } from "../src/lib/map/heat.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";

const AT = 1_700_000_000;
const node = (mint: string, parentMint: string | null, o: Partial<BubbleNode> = {}): BubbleNode => ({
  mint, parentMint, depth: parentMint ? 1 : 0, name: `${mint} coin`, symbol: mint.toUpperCase(), image: null, mcapUsd: 500, lockedUsd: null, children: 0, migrated: false, createdAt: AT - 30 * 86_400, ...o,
});
const row = (v24: number, o: Partial<HeatRow> = {}): HeatRow => ({ t1h: 0, n24: v24 > 0 ? 1 : 0, v24, last: AT - 100, buys1h: 0, ...o });
const heatOf = (rows: Record<string, HeatRow>): HeatIndex => ({ at: AT, version: 1, rows: new Map(Object.entries(rows)) });
const index = (nodes: BubbleNode[]) => new Map(nodes.map((n) => [n.mint, n]));

// a family of 40 ranked coins under root "r" (c1 the most traded), one coin with no volume, a grandchild, and a second family
const family = () => {
  const nodes = [node("r", null), node("s", null)];
  const rows: Record<string, HeatRow> = { r: row(5, { last: AT - 7_000 }) };
  for (let i = 1; i <= 40; i++) { nodes.push(node(`c${i}`, i === 40 ? "c1" : "r")); rows[`c${i}`] = row(10_000 / i); }
  nodes.push(node("quiet", "r")); rows.quiet = row(0);
  nodes.push(node("s1", "s")); rows.s1 = row(1);
  return { nodes, byMint: index(nodes), heat: heatOf(rows) };
};

test("parseColour / parseCopies: the defaults unless asked", () => {
  assert.equal(parseColour(null), "volume"); assert.equal(parseColour("last"), "last"); assert.equal(parseColour("x"), "volume");
  assert.equal(formatColour("volume"), null, "the default leaves no param"); assert.equal(formatColour("last"), "last");
  assert.equal(parseCopies(null), "stack"); assert.equal(parseCopies("all"), "all"); assert.equal(parseCopies("x"), "stack");
});

test("volTier: top 5 % (at least one), next 15 %, next 30 %, the rest", () => {
  assert.deepEqual([1, 2, 3, 8, 9, 20, 21, 40].map((r) => volTier(r, 40)), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(volTier(1, 1), 0, "a family's only traded coin leads it");
  assert.deepEqual([1, 2, 3].map((r) => volTier(r, 3)), [0, 1, 3]);
});

test("volumeRanks: ranked inside the family by 24 h volume; roots, coins without volume and other families apart", () => {
  const { nodes, byMint, heat } = family();
  const rk = volumeRanks(nodes, byMint, heat);
  assert.deepEqual(rk.get("c1"), { rank: 1, of: 40, tier: 0 });
  assert.deepEqual(rk.get("c40"), { rank: 40, of: 40, tier: 3 }, "a grandchild ranks in the same family");
  assert.equal(rk.has("r"), false, "the root is not ranked"); assert.equal(rk.has("quiet"), false, "no volume, no rank");
  assert.deepEqual(rk.get("s1"), { rank: 1, of: 1, tier: 0 }, "another family has its own top");
  assert.equal(volumeRanks(nodes, byMint, null).size, 0);
  // ties: trades in the last hour, then the mint
  const tie = [node("r", null), node("a", "r"), node("b", "r"), node("c", "r")], h = heatOf({ a: row(5), b: row(5, { t1h: 3 }), c: row(5) });
  const t = volumeRanks(tie, index(tie), h);
  assert.deepEqual(["b", "a", "c"].map((m) => t.get(m)!.rank), [1, 2, 3]);
  // a parent cycle ends the walk instead of hanging
  const loop = [node("x", "y"), node("y", "x")];
  assert.equal(typeof topFn(index(loop))(loop[0]), "string");
});

test("the colour clock: each tier lands in its heat class, the real last trade stays as it is", () => {
  const { nodes, byMint, heat } = family();
  const p = heatPayload(heat, { ranks: volumeRanks(nodes, byMint, heat), byMint })!;
  const at = (m: string) => p.mint.indexOf(m);
  const cls = (m: string) => { const c = p.clast![at(m)]; return c > 0 ? heatClass(p.at - c) : 3; };
  assert.deepEqual(["c1", "c2", "c3", "c8", "c9", "c20", "c21", "c40", "quiet"].map(cls), [0, 0, 1, 1, 2, 2, 3, 3, 3]);
  assert.equal(p.at - p.clast![at("c1")], VOL_LEAD_AGE, "the leaders burn brightest");
  assert.ok(VOL_LEADERS >= 1 && VOL_TIER_AGE.every((a, i) => heatClass(a) === i));
  assert.equal(p.clast![at("r")], AT - 7_000, "a root keeps its own last trade");
  assert.deepEqual(p.last, [...heat.rows.values()].map((r) => r.last), "`last` is never rewritten");
  assert.equal(p.vrank![at("c1")], 1); assert.equal(p.vrank![at("quiet")], 0);
  assert.equal(colourLast("gone", AT - 5, AT, new Map(), byMint), 0, "a row the page does not hold is cold");
  const plain = heatPayload(heat)!;
  assert.equal(plain.clast, undefined); assert.equal(plain.vrank, undefined);
});

test("engine ingest: coloured by the colour clock, filtered and counted by the real one", () => {
  const { nodes, byMint, heat } = family();
  const tree = (m: string): { coin: BubbleNode; children: ReturnType<typeof tree>[] } => ({ coin: byMint.get(m)!, children: nodes.filter((n) => n.parentMint === m).map((n) => tree(n.mint)) });
  const build = (payload: ReturnType<typeof heatPayload>) => { const S: Record<string, any> = { N_PLANETS: 60, debug: { map: {} } }; ingest(S, { roots: [tree("r"), tree("s")], heat: payload, mode: "locked" }); return S; };
  const S = build(heatPayload(heat, { ranks: volumeRanks(nodes, byMint, heat), byMint }));
  const i = (m: string) => S.mintIdx.get(m);
  assert.equal(S.rankMode, true);
  assert.equal(heatClass(S.age[i("c1")]), 0); assert.equal(heatClass(S.age[i("c30")]), 3, "the tail is drawn cold");
  assert.equal(S.ageReal[i("c30")], 100, "though it traded 100 s ago: the filter still shows it");
  assert.equal(S.age[i("quiet")], Infinity);
  assert.equal(S.fams[0].ageReal, 100);
  const P = build(heatPayload(heat));
  assert.equal(P.rankMode, false);
  assert.deepEqual([...P.age], [...P.ageReal], "without ranks the two clocks are one");
});

test("spotlight: the top 20 % and the roots stay lit; no ranks, no change", () => {
  const { nodes, byMint, heat } = family();
  const rk = volumeRanks(nodes, byMint, heat), lit = spotlight(null, rk, byMint)!;
  const on = (m: string) => lit(byMint.get(m)!);
  assert.deepEqual(["r", "c1", "c8", "c9", "c40", "quiet"].map(on), [true, true, true, false, false, false]);
  const base = (n: BubbleNode) => n.mint !== "c1";
  assert.equal(spotlight(base, rk, byMint)!(byMint.get("c1")!), false, "the page's own highlight still narrows it");
  assert.equal(spotlight(base, null, byMint), base); assert.equal(spotlight(null, null, byMint), null);
});

test("familyLeaders: the family's most traded coins in order, the top itself left out", () => {
  const { byMint, heat } = family();
  const l = familyLeaders("r", byMint, heat, 3);
  assert.deepEqual(l.map((x) => [x.node.mint, x.rank, x.v24]), [["c1", 1, 10_000], ["c2", 2, 5_000], ["c3", 3, 10_000 / 3]]);
  assert.deepEqual(familyLeaders("s", byMint, heat).map((x) => x.node.mint), ["s1"]);
  assert.deepEqual(familyLeaders("r", byMint, null), []);
});

test("tickerKey: the symbol without $ and case; none = never a copy", () => {
  assert.equal(tickerKey({ symbol: " $kimchi " }), "KIMCHI"); assert.equal(tickerKey({ symbol: "Kimchi" }), "KIMCHI");
  assert.notEqual(tickerKey({ symbol: "FUND" }), tickerKey({ symbol: "FUNDINU" }));
  assert.equal(tickerKey({ symbol: null }), null); assert.equal(tickerKey({ symbol: "$" }), null);
});

test("stackCopies: same-ticker siblings stand behind the most traded one; parents, pins, roots and other parents do not stack", () => {
  const nodes = [
    node("root", null, { symbol: "ROOT" }), node("root2", null, { symbol: "ROOT" }),
    node("k1", "root", { symbol: "$KIMCHI", mcapUsd: 900 }), node("k2", "root", { symbol: "kimchi" }), node("k3", "root", { symbol: "Kimchi" }), node("k4", "root", { symbol: "KIMCHI" }),
    node("kid", "k4", { symbol: "X" }),
    node("other", "root", { symbol: "FUND" }), node("alike", "root", { symbol: "FUNDINU" }),
    node("far", "root2", { symbol: "KIMCHI" }), node("anon1", "root", { symbol: null }), node("anon2", "root", { symbol: null }),
  ];
  const byMint = index(nodes), heat = heatOf({ k2: row(50), k3: row(20), k1: row(0) });
  const s = stackCopies(nodes, byMint, heat);
  assert.deepEqual(s.nodes.map((n) => n.mint), ["root", "root2", "k2", "k4", "kid", "other", "alike", "far", "anon1", "anon2"]);
  assert.deepEqual([...s.count], [["k2", 2]], "k2 leads (most volume) and stands for k1 and k3");
  assert.deepEqual([...s.leaderOf], [["k1", "k2"], ["k3", "k2"]]);
  assert.equal(s.hidden, 2); assert.equal(s.byMint.has("k1"), false); assert.equal(s.byMint.get("k4"), byMint.get("k4"), "a copy with children stays");
  assert.deepEqual(stackCopies(nodes, byMint, heat, ["k3", "root"]).nodes.map((n) => n.mint).filter((m) => /^k\d/.test(m)), ["k2", "k3", "k4"], "a pinned copy is drawn");
  // without volume: market cap, then the older coin
  assert.deepEqual([...stackCopies(nodes, byMint, null).count.keys()], ["k1"]);
  const plain = [node("root", null), node("a", "root"), node("b", "root")], pm = index(plain), same = stackCopies(plain, pm, heat);
  assert.equal(same.nodes, plain, "nothing to stack: the same list"); assert.equal(same.byMint, pm); assert.equal(same.hidden, 0);
});

test("copyGroup: a coin's stack for the side panel, the leader first", () => {
  const kids = [node("k1", "root", { symbol: "KIMCHI" }), node("k2", "root", { symbol: "kimchi" }), node("o", "root", { symbol: "FUND" })];
  const heat = heatOf({ k2: row(9) });
  assert.deepEqual(copyGroup(kids[0], kids, heat).map((n) => n.mint), ["k2", "k1"]);
  assert.deepEqual(copyGroup(kids[2], kids, heat), []);
});

// ---------- the engine for real, headless (test/map3-headless.mts), coloured by volume ----------
test("engine, by volume: a trade pulses but keeps the tier; a heat payload moves it; the filter keeps reading the real last trade", async () => {
  const { mountHeadless } = await import("./map3-headless.mts");
  const nodes = [node("r", null)], rows: Record<string, HeatRow> = { r: row(1) };
  for (let i = 1; i <= 20; i++) { nodes.push(node(`c${i}`, "r")); rows[`c${i}`] = row(1_000 / i); }
  nodes.push(node("old", "r")); rows.old = row(0, { last: AT - 5 * 86_400, n24: 0 });
  const byMint = index(nodes), heat = heatOf(rows);
  const tree = { coin: byMint.get("r")!, children: nodes.slice(1).map((n) => ({ coin: n, children: [] })) };
  const e = await mountHeadless({ roots: [tree], heat: heatPayload(heat, { ranks: volumeRanks(nodes, byMint, heat), byMint }), last: { mask: 7 } });
  try {
    const S = e.S, i = (m: string) => e.idx(m), cls = (m: string) => heatClass(S.age[i(m)]);
    assert.equal(S.rankMode, true);
    assert.deepEqual(["c1", "c2", "c4", "c5", "c10", "c11", "c20"].map(cls), [0, 1, 1, 2, 2, 3, 3], "tiers of 20: 1 / 3 / 6 / 10");
    assert.equal(S.vis.cls[i("c20")], 0, "the tail traded 100 s ago: the filter files it under 30 min");
    assert.equal(S.vis.cls[i("old")], 3);
    // a live trade on a tail coin: a pulse, the real clock moves, the colour does not
    e.api.applyEvent({ name: "trade", data: { mint: "c20", time: AT + 10, isBuy: true, valueUsd: 5 } });
    assert.equal(cls("c20"), 3); assert.equal(S.ageReal[i("c20")], 0);
    e.api.applyEvent({ name: "trade", data: { mint: "old", time: AT + 11, isBuy: true, valueUsd: 5 } });
    assert.equal(S.vis.cls[i("old")], 0, "a coin the filter hid is live now"); assert.equal(cls("old"), 3, "and still unranked");
    // the next heat payload: c20 now carries the volume
    const rows2 = { ...rows, c20: row(50_000, { last: AT + 10 }), old: row(5, { last: AT + 11 }) }, heat2: HeatIndex = { at: AT + 60, version: 2, rows: new Map(Object.entries(rows2)) };
    e.api.setHeat(heatPayload(heat2, { ranks: volumeRanks(nodes, byMint, heat2), byMint }));
    assert.equal(cls("c20"), 0, "the new leader"); assert.equal(cls("c1"), 0, "21 ranked now: two in the top tier"); assert.equal(cls("c2"), 1); assert.equal(S.ageReal[i("c1")], 160);
    assert.equal(S.fams[0].ageReal, 49, "the family's real last trade");
    // back to last-trade colours: one clock again
    e.api.setHeat(heatPayload({ ...heat2, at: AT + 120 }));
    assert.equal(S.rankMode, false);
    assert.equal(S.age[i("c11")], S.ageReal[i("c11")]); assert.equal(cls("c11"), 0);
  } finally { e.dispose(); }
});

// ---------- review fixes (2026-11-15) ----------
test("stackCopies under the last-trade filter: a copy the Key shows leads before a bigger one it hides", () => {
  const nodes = [node("root", null), node("big", "root", { symbol: "K", mcapUsd: 9_000 }), node("live", "root", { symbol: "K", mcapUsd: 10 }), node("cold", "root", { symbol: "K" })];
  const byMint = index(nodes);
  // "big" has the volume but traded 30 h ago (bucket "older"); "live" traded 100 s ago
  const heat = heatOf({ big: row(900, { last: AT - 30 * 3_600 }), live: row(1) });
  assert.deepEqual([...stackCopies(nodes, byMint, heat).count], [["big", 2]], "filter off: the most traded leads");
  const s = stackCopies(nodes, byMint, heat, [], 7);
  assert.deepEqual([...s.count], [["live", 2]], "mask 7 (older hidden): the shown copy leads, so the stack is on the map");
  assert.deepEqual([...stackCopies(nodes, byMint, null, [], 7).count.keys()], ["big"], "no heat: nothing is filtered");
});

test("engine, by volume: a family's clock is the real one, a family top goes live on its own trade, a ranked coin keeps its tier", async () => {
  const { mountHeadless } = await import("./map3-headless.mts");
  const nodes = [node("r", null), node("q", null)], rows: Record<string, HeatRow> = { r: row(1, { last: AT - 5 * 3_600 }), q: row(0, { last: AT - 6 * 3_600, n24: 1 }) };
  for (let i = 1; i <= 6; i++) { nodes.push(node(`c${i}`, "r")); rows[`c${i}`] = row(100 / i, { last: AT - 4 * 3_600 }); }
  nodes.push(node("q1", "q")); rows.q1 = row(3, { last: AT - 20 * 3_600 });
  const byMint = index(nodes), heat = heatOf(rows);
  const tree = (m: string): { coin: BubbleNode; children: unknown[] } => ({ coin: byMint.get(m)!, children: nodes.filter((n) => n.parentMint === m).map((n) => tree(n.mint)) });
  const e = await mountHeadless({ roots: [tree("r"), tree("q")], heat: heatPayload(heat, { ranks: volumeRanks(nodes, byMint, heat), byMint }), last: { mask: 15 } });
  try {
    const S = e.S, i = (m: string) => e.idx(m), fam = (m: string) => S.fams[S.famOf[i(m)]];
    assert.equal(heatClass(S.age[i("q1")]), 0, "q1 leads its family: drawn in the top tier");
    assert.equal(fam("q").age, 6 * 3_600, "but the family last traded 6 h ago (its top), and its clock says so");
    assert.equal(fam("q").age, fam("q").ageReal);
    assert.equal(heatClass(S.age[i("r")]), 2, "a top wears its own last trade (5 h)");
    e.api.applyEvent({ name: "trade", data: { mint: "r", time: AT + 5, isBuy: true, valueUsd: 9 } });
    assert.equal(heatClass(S.age[i("r")]), 0, "and goes live on its own trade");
    e.api.applyEvent({ name: "trade", data: { mint: "c6", time: AT + 6, isBuy: true, valueUsd: 9 } });
    assert.equal(heatClass(S.age[i("c6")]), 3, "a ranked coin keeps its tier"); assert.equal(fam("r").age, 0, "its family is live");
    // a poll whose snapshot predates the top's stream trade: the top stays live
    e.api.setHeat(heatPayload({ ...heat, at: AT + 30, version: 2 }, { ranks: volumeRanks(nodes, byMint, heat), byMint }));
    assert.equal(heatClass(S.age[i("r")]), 0);
  } finally { e.dispose(); }
});
