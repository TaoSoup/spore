// $baton under PUMP (Nov 13 2026): a listed asset quoted in another listed asset comes twice in the map bodies (a coin
// under that asset, and the top of its own family). The page keeps one node, the coin under its parent, in either order;
// and the WebGL engine, which never moves a built coin, rebuilds when a coin it drew sits in another family than its
// parent says (a build from a cache saved before the server fix).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalise, upsert, type NodeSet } from "../src/lib/map/nodes.ts";
import { createDiffState, diffNodes, shouldRebuild } from "../src/components/map3/adapter.ts";
import type { MapCoin, MapNode, MapResponse } from "../src/lib/api.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";

const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", BATON = "Hg5Ja55T5wESq4vyFoiVCMeHXtGyVA69X2UHq8hgpump", KID = "Kid1111111111111111111111111111111111111111";
const coin = (mint: string, over: Partial<MapCoin> & { asset?: boolean } = {}): MapCoin => ({ mint, name: null, symbol: mint.slice(0, 4), image: null, depth: 0, mcapUsd: 1, lockedUsd: 1, children: 0, descendants: 0, migrated: true, createdAt: 1, ...over }) as MapCoin;
const node = (c: MapCoin, children: MapNode[] = []): MapNode => ({ coin: c, children });
// the body the server sends: PUMP's family with baton (a coin, graduated) under it, and baton's own family as a top
const batonCoin = coin(BATON, { children: 1, descendants: 1, mcapUsd: 3_500_000 });
const batonTop = coin(BATON, { asset: true, migrated: false, children: 575, descendants: 576, mcapUsd: null });
const pumpTop = coin(PUMP, { asset: true, migrated: false, children: 1, descendants: 3 });
const body = (order: "pump-first" | "baton-first"): MapResponse => {
  const roots = [node(pumpTop, [node(batonCoin, [node(coin(KID))])]), node(batonTop, [node(coin(KID))])];
  return { roots: order === "pump-first" ? roots : roots.reverse(), generatedAt: 1, total: 5 } as unknown as MapResponse;
};

test("a nested asset is one node under its parent, with the coin's own fields, whatever order its two copies arrive in", () => {
  for (const order of ["pump-first", "baton-first"] as const) {
    const set: NodeSet = new Map();
    upsert(set, normalise(body(order)).nodes);
    const b = set.get(BATON)!;
    assert.equal(b.parentMint, PUMP, `${order}: under PUMP`);
    assert.equal(b.asset, undefined, `${order}: not an asset top`);
    assert.equal(b.migrated, true, `${order}: graduated, as the coin (the top copy says false)`);
    assert.equal(b.mcapUsd, 3_500_000, `${order}: the coin's market cap`);
    assert.equal(set.get(PUMP)!.asset, true, "PUMP stays an asset top");
    assert.equal(set.get(KID)!.parentMint, BATON);
  }
});

test("a node cached as the merged asset copy (asset, migrated false, under PUMP) heals when the coin copy comes", () => {
  const set: NodeSet = new Map([[BATON, { mint: BATON, parentMint: PUMP, depth: 0, name: null, symbol: "baton", image: null, mcapUsd: null, lockedUsd: 1, children: 575, descendants: 576, migrated: false, ours: false, createdAt: null, asset: true } as BubbleNode]]);
  // a since= delta: the asset copy first (sorted by locked value), then the coin
  upsert(set, normalise({ nodes: [{ ...batonTop, parentMint: null }, { ...batonCoin, parentMint: PUMP }], generatedAt: 2 } as unknown as MapResponse).nodes);
  const b = set.get(BATON)!;
  assert.equal(b.parentMint, PUMP); assert.equal(b.asset, undefined); assert.equal(b.migrated, true);
  // a later delta with only the top copy leaves it alone
  upsert(set, normalise({ nodes: [{ ...batonTop, parentMint: null, children: 600 }], generatedAt: 3 } as unknown as MapResponse).nodes);
  assert.equal(set.get(BATON)!.asset, undefined); assert.equal(set.get(BATON)!.children, 1);
});

test("the node pass reports a coin the engine drew in another family than its page parent, and that rebuilds once the map is idle", () => {
  const set: NodeSet = new Map();
  upsert(set, normalise(body("pump-first")).nodes);
  const nodes = Array.from(set.values()), byMint = new Map(nodes.map((n) => [n.mint, n]));
  // the engine built from an old list where baton was a root: baton and its kid are their own family
  const engineTop: Record<string, string> = { [PUMP]: PUMP, [BATON]: BATON, [KID]: BATON };
  const knows = (m: string) => m in engineTop, topOf = (m: string) => engineTop[m] ?? null;
  const first = diffNodes(createDiffState([]), nodes, byMint, knows, 0, { topOf, checkAll: true });
  assert.deepEqual(first.relinked, [BATON], "baton's page parent (PUMP) is in another engine family; its kid follows baton, so it is not listed");
  // after the rebuild the engine agrees: nothing to report
  engineTop[BATON] = PUMP; engineTop[KID] = PUMP;
  assert.deepEqual(diffNodes(createDiffState([]), nodes, byMint, knows, 0, { topOf, checkAll: true }).relinked, []);
  // a page root the engine drew under something else is reported too; a parent the engine does not hold is not checked
  engineTop[PUMP] = BATON;
  assert.ok(diffNodes(createDiffState([]), nodes, byMint, knows, 0, { topOf, checkAll: true }).relinked.includes(PUMP));
  const partial = (m: string) => m !== PUMP && m in engineTop;
  assert.deepEqual(diffNodes(createDiffState([]), nodes, byMint, partial, 0, { topOf, checkAll: true }).relinked.filter((m) => m === BATON), [], "parent outside the build");
  // without checkAll only changed nodes are looked at
  const st = createDiffState([]);
  diffNodes(st, nodes, byMint, knows, 0, {});
  engineTop[PUMP] = PUMP; engineTop[BATON] = BATON;
  assert.deepEqual(diffNodes(st, nodes, byMint, knows, 0, { topOf }).relinked, [], "nothing changed since the last pass");

  const base = { unknown: 0, removed: 0, coins: 100_000, sinceBuildMs: 1_000, firstSyncAfterCache: false };
  assert.equal(shouldRebuild({ ...base, idleMs: 3_500, relinked: 1 }), true, "a wrong family rebuilds at once when idle, however young the build");
  assert.equal(shouldRebuild({ ...base, idleMs: 3_500, relinked: 1, card: true }), true, "even under an open coin card (likely the coin drawn wrong)");
  assert.equal(shouldRebuild({ ...base, idleMs: 1_000, relinked: 1 }), false, "not while the user is moving the map");
  assert.equal(shouldRebuild({ ...base, idleMs: 3_500, relinked: 0 }), false);
});

test("a full load stores the merged set in the cache (one row per mint), not the body's list, where a nested asset's top copy comes last", async () => {
  const set: NodeSet = new Map();
  const norm = normalise(body("pump-first")).nodes;
  upsert(set, norm);
  // the cache keeps one row per mint, the last one written (IndexedDB put on keyPath "mint")
  const store = (rows: BubbleNode[]) => { const m = new Map<string, BubbleNode>(); for (const r of rows) m.set(r.mint, r); return m; };
  assert.equal(store(norm).get(BATON)!.parentMint, null, "the raw list's last baton is its own top: written as is, the next visit paints a root");
  assert.equal(store(Array.from(set.values())).get(BATON)!.parentMint, PUMP, "the merged set keeps it under PUMP");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/map/use-map-data.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /saveNodes\(norm\.nodes/, "use-map-data's full load must persist the merged set");
});
