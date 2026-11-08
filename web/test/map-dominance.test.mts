// Dominance (DESIGN §11.5, owner 2026-10-20): each family's share of the whole map in both size modes.
// The share math (lib/map/dominance.ts): a family's value is its top's bubble weight (sizing.ts
// familyWeights), shares add up to 1 per mode, a lone coin is a family of one, ranks and the title tags;
// the "23%" format; and that the server's GET /api/map/dominance table (server/lib/dominance.mjs) gives
// the same numbers for the same tree, so the coin page and the map agree.
//
//   node --import tsx --test test/map-dominance.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPACT_TAG_MIN, DOM_WORDS, dominance, dominanceTable, shareOf, sharePct, titleTags } from "../src/lib/map/dominance.ts";
import { families, familyValueOf, familyWeights, isThinFamily } from "../src/lib/map/sizing.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";
// the server's twin of the table (a plain ES module, no types)
import { familyShares, familyValueOf as srvValueOf } from "../../server/lib/dominance.mjs";

const node = (mint: string, parentMint: string | null, depth: number, o: Partial<BubbleNode> = {}): BubbleNode => ({
  mint, parentMint, depth, name: `${mint} coin`, symbol: mint.toUpperCase(), image: null, mcapUsd: null, lockedUsd: null, children: 0, migrated: false, ...o,
});

// pump (a listed asset top, locks 5 000) ─ p1 (locks 300) ─ p11 ($40k leaf), p12 (no mcap)
//                                      ─ p2 ($10k leaf)
// sol (locks 1 200) ─ s1 (locks 0, $2k mcap) ─ s11 ($1k leaf)
// lone (a root with nothing under it on the map: a family of one, $150 mcap, locks 3 in children the map does not draw)
// zero ─ z1 (nothing priced anywhere: a family worth 0, i.e. unknown)
// A leaf adds nothing to "locked" (no market-cap slice since 2026-10-21).
function fixture(): BubbleNode[] {
  return [
    node("pump", null, -1, { lockedUsd: 5_000, mcapUsd: 3_000_000, children: 2, asset: true }),
    node("p1", "pump", 0, { lockedUsd: 300, mcapUsd: 60_000, children: 2 }),
    node("p11", "p1", 1, { mcapUsd: 40_000 }),
    node("p12", "p1", 1, {}),
    node("p2", "pump", 0, { mcapUsd: 10_000 }),
    node("sol", null, 0, { lockedUsd: 1_200, mcapUsd: 90_000, children: 1 }),
    node("s1", "sol", 1, { lockedUsd: 0, mcapUsd: 2_000 }),
    node("s11", "s1", 2, { mcapUsd: 1_000 }),
    node("lone", null, 0, { mcapUsd: 150, lockedUsd: 3 }),
    node("zero", null, 0, { children: 1 }),
    node("z1", "zero", 1, {}),
  ];
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test("a family's value is its top's bubble weight; shares of the total add up to 1 in both modes", () => {
  const nodes = fixture();
  const d = dominance(nodes);
  const fam = families(nodes);
  for (const mode of ["locked", "mcap"] as const) {
    const w = familyWeights(nodes, fam, mode);
    const t = d[mode];
    assert.equal(t.mode, mode);
    assert.equal(t.ranked.length, 4, "pump, sol, lone, zero: every top, the lone root included");
    for (const r of t.ranked) {
      const q = nodes.indexOf(r.node);
      assert.ok(near(r.value, Number.isFinite(w[q]) ? w[q] : 0), `${mode} ${r.node.mint}: the value is the top's bubble weight`);
      assert.equal(t.byTop.get(r.node.mint), r);
    }
    assert.ok(near(t.ranked.reduce((s, r) => s + r.share, 0), 1), `${mode}: shares add up to 100 %`);
    assert.ok(near(t.total, t.ranked.reduce((s, r) => s + r.value, 0)));
    assert.deepEqual(t.ranked.map((r) => r.rank), [1, 2, 3, 4]);
  }
  // locked: pump = 5 000 + 300 (the leaves lock nothing) = 5 300; sol = 1 200 (s1 locks 0); lone = 3
  assert.deepEqual(d.locked.ranked.map((r) => [r.node.mint, r.value, r.members]), [["pump", 5_300, 5], ["sol", 1_200, 3], ["lone", 3, 1], ["zero", 0, 2]]);
  assert.equal(d.locked.total, 6_503);
  assert.ok(near(d.locked.byTop.get("pump")!.share, 5_300 / 6_503));
  // mcap: pump = 60 000 + 40 000 + 10 000 (an asset top's own $3M never counts, owner 2026-10-21); sol = 93 000;
  // lone = 3: a thin family (1 coin, locking under $100) is weighed by what it locks, not its $150 mcap
  assert.deepEqual(d.mcap.ranked.map((r) => [r.node.mint, r.value]), [["pump", 110_000], ["sol", 93_000], ["lone", 3], ["zero", 0]]);
  // thin-family guard: a 2-coin family at $1.07B locking ~0 weighs what it locks (1e-6; no market-cap slice), far under sol
  const junk = [...fixture(), node("xto", null, 0, { mcapUsd: 1.07e9, lockedUsd: 1e-6, children: 1 }), node("x1", "xto", 1, { mcapUsd: 1e6 })];
  assert.ok(near(dominance(junk).mcap.byTop.get("xto")!.value, 1e-6, 1e-12));
  assert.equal(dominance(junk).mcap.ranked[0].node.mint, "pump");
  assert.equal(isThinFamily(5, 99.99), true); assert.equal(isThinFamily(5, 100), false); assert.equal(isThinFamily(6, 0), false);
  // the liquidity cap: a member capped by the server weighs its cap, not its mcap
  const capped = fixture().map((n) => (n.mint === "s11" ? { ...n, mcapUsd: 5e9, mcapCapUsd: 1_000 } : n));
  assert.equal(dominance(capped).mcap.byTop.get("sol")!.value, 93_000);
  assert.equal(d.mcap.byTop.get("zero")!.share, 0);
  // a member is not a family
  assert.equal(d.locked.byTop.get("p1"), undefined);
});

test("ties rank by more members, then mint; an empty or worthless map divides by nothing", () => {
  const nodes = [node("b", null, 0, { lockedUsd: 10 }), node("b1", "b", 1, {}), node("a", null, 0, { lockedUsd: 10 }), node("c", null, 0, { lockedUsd: 10 })];
  assert.deepEqual(dominance(nodes).locked.ranked.map((r) => r.node.mint), ["b", "a", "c"]);
  const empty = dominance([]);
  assert.equal(empty.locked.total, 0); assert.deepEqual(empty.mcap.ranked, []);
  const none = dominanceTable([node("x", null, 0)], families([node("x", null, 0)]), "mcap");
  assert.equal(none.ranked[0].share, 0); assert.equal(none.total, 0);
});

test("the share format: one decimal below 10 %, whole numbers from there, a sliver is <0.1%", () => {
  const cases: [number | null | undefined, string][] = [
    [0.23, "23%"], [0.235, "24%"], [0.1, "10%"], [0.0996, "10%"], [0.0994, "9.9%"], [0.056, "5.6%"], [0.012, "1.2%"],
    [0.00049, "<0.1%"], [0.0006, "0.1%"], [1, "100%"], [1.0000001, "100%"], [0, "0%"], [-0.1, "0%"], [NaN, "0%"], [null, "0%"], [undefined, "0%"],
  ];
  for (const [v, want] of cases) assert.equal(sharePct(v), want, String(v));
  const tags = titleTags(dominance(fixture()).locked);
  assert.equal(tags.get("pump"), "82%"); assert.equal(tags.get("sol"), "18%"); assert.equal(tags.get("lone"), "<0.1%");
  assert.equal(tags.has("zero"), false, "an unpriced family's title carries no number");
  const phone = titleTags(dominance(fixture()).locked, COMPACT_TAG_MIN);
  assert.deepEqual([...phone.keys()], ["pump", "sol"], "phones tag only the families of 1 % and more");
  const d = dominance(fixture());
  assert.equal(shareOf(d.locked.byTop.get("zero")), null, "unpriced reads as unknown (—), not 0 %");
  assert.ok(near(shareOf(d.locked.byTop.get("sol"))!, 1_200 / 6_503));
  assert.equal(shareOf(undefined), null);
  assert.equal(titleTags(null).size, 0);
  assert.deepEqual(DOM_WORDS, { locked: "of all locked value", mcap: "of market cap" });
});

test("the server's table (GET /api/map/dominance) gives the map's numbers for the same tree", () => {
  const nodes = fixture();
  const kids = (m: string) => nodes.filter((n) => n.parentMint === m);
  const tree = (n: BubbleNode): { coin: BubbleNode; children: unknown[] } => ({ coin: n, children: kids(n.mint).map(tree) });
  const roots = nodes.filter((n) => !n.parentMint).map(tree);
  const d = dominance(nodes);
  for (const mode of ["locked", "mcap"] as const) {
    const srv = familyShares(roots, mode) as { total: number; families: { mint: string; value: number; share: number; coins: number }[] };
    assert.ok(near(srv.total, d[mode].total, 0.01));
    assert.deepEqual(srv.families.map((f) => f.mint), d[mode].ranked.map((r) => r.node.mint), `${mode}: same order`);
    for (const f of srv.families) {
      const r = d[mode].byTop.get(f.mint)!;
      assert.ok(near(f.value, r.value, 0.01), `${mode} ${f.mint} value`);
      assert.ok(near(f.share, r.share, 1e-12), `${mode} ${f.mint} share`);
      assert.equal(f.coins, r.members);
    }
  }
});

test("one family rule everywhere: the server's familyValueOf and familyShares equal the web's on a shared fixture (|Δ share| < 1e-9)", () => {
  // a seeded forest of 400 families with assets, liquidity caps, nulls, zeros and negatives
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pick = (): number | null => { const x = rnd(); return x < 0.15 ? null : x < 0.2 ? 0 : x < 0.22 ? -5 : Math.round(10 ** (1 + 7 * rnd())); };
  const nodes: BubbleNode[] = [];
  for (let t = 0; t < 400; t++) {
    const top = node(`t${t}`, null, 0, { mcapUsd: pick(), lockedUsd: pick(), asset: rnd() < 0.05 ? true : undefined });
    nodes.push(top);
    const kidsN = Math.floor(rnd() * 12);
    for (let k = 0; k < kidsN; k++) {
      const parent = k > 2 && rnd() < 0.4 ? `t${t}k${Math.floor(rnd() * k)}` : top.mint;
      nodes.push(node(`t${t}k${k}`, parent, 1, { mcapUsd: pick(), lockedUsd: pick(), mcapCapUsd: rnd() < 0.1 ? Math.round(rnd() * 500) : undefined }));
    }
  }
  for (const n of nodes) for (const mode of ["locked", "mcap"] as const) assert.equal(srvValueOf(n, mode), familyValueOf(n, mode), `${n.mint} ${mode}`);
  const kids = (m: string) => nodes.filter((n) => n.parentMint === m);
  const tree = (n: BubbleNode): { coin: BubbleNode; children: unknown[] } => ({ coin: n, children: kids(n.mint).map(tree) });
  const roots = nodes.filter((n) => !n.parentMint).map(tree);
  const d = dominance(nodes);
  for (const mode of ["locked", "mcap"] as const) {
    const srv = familyShares(roots, mode) as { families: { mint: string; share: number }[] };
    let worst = 0;
    for (const f of srv.families) worst = Math.max(worst, Math.abs(f.share - d[mode].byTop.get(f.mint)!.share));
    assert.ok(worst < 1e-9, `${mode}: worst share gap ${worst}`);
    assert.equal(srv.families.length, 400);
  }
});
