// A full map body is built on the server in slices (2026-11-11) while the event stream keeps patching the page's
// node set: a `mapdelta` that lands during the build carries newer data than the full body that arrives after it,
// and a full load puts its nodes in as they are. useMapData's sync therefore asks for one delta from the body's
// generatedAt right after a full load (deltaAfterFull), which puts the newer state back at once. This replays the
// race with the real merge functions; the hook itself needs a browser (test/map-sync.mts drives it end to end).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deltaAfterFull } from "../src/lib/map/use-map-data.ts";
import { applyDelta, normalise, upsert, type NodeSet } from "../src/lib/map/nodes.ts";
import type { MapCoin } from "../src/lib/api.ts";

const ROOT = "RootMint1111111111111111111111111111111111", X = "XMint11111111111111111111111111111111111111";
const LOGO = "/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2Flogo";
const coin = (mint: string, image: string | null, extra: Partial<MapCoin> = {}): MapCoin => ({
  mint, name: mint.slice(0, 4), symbol: mint.slice(0, 3), image, depth: mint === ROOT ? 0 : 1,
  mcapUsd: 1000, lockedUsd: 10, children: mint === ROOT ? 1 : 0, descendants: mint === ROOT ? 1 : 0, migrated: false, createdAt: null, ...extra,
});

test("deltaAfterFull: a full load that carried generatedAt is followed by one delta from it; a delta is not", () => {
  assert.equal(deltaAfterFull(null, 1_800_000_000_000), 1_800_000_000_000);
  assert.equal(deltaAfterFull(1_799_999_000_000, 1_800_000_000_000), null, "a delta needs no follow-up (and none chains)");
  assert.equal(deltaAfterFull(null, null), null, "no generatedAt (an older server): nothing to ask from");
  assert.equal(deltaAfterFull(null, Number.NaN), null);
});

test("the race it closes: a mapdelta applied during the build is undone by the older full body, and the follow-up delta restores it", () => {
  const set: NodeSet = new Map();
  // the page holds X without a logo (an earlier load)
  upsert(set, normalise({ roots: [{ coin: coin(ROOT, null), children: [{ coin: coin(X, null), children: [] }] }], generatedAt: 1_000 }).nodes);
  // during the server's next full build X's logo resolves: the stream's mapdelta brings it at once
  applyDelta(set, [{ mint: X, mcapUsd: 1000, lockedUsd: 10, children: 0, descendants: 0, migrated: false, name: null, symbol: null, image: LOGO }]);
  assert.equal(set.get(X)?.image, LOGO);
  // then the full body arrives, with X as the build read it, before the logo resolved: the newer logo is gone
  const full = normalise({ roots: [{ coin: coin(ROOT, null), children: [{ coin: coin(X, null), children: [] }] }], generatedAt: 2_000 });
  upsert(set, full.nodes);
  assert.equal(set.get(X)?.image, null, "the race: the full load put the older node back");
  // the follow-up delta from the body's generatedAt: X's row changed after it, so it comes back with its logo
  const cursor = deltaAfterFull(null, full.generatedAt);
  assert.equal(cursor, 2_000);
  const delta = normalise({ nodes: [coin(X, LOGO, { parentMint: ROOT })], removed: [], generatedAt: 2_400, total: 2 });
  upsert(set, delta.nodes);
  assert.equal(set.get(X)?.image, LOGO, "restored by the follow-up delta");
  assert.equal(set.get(X)?.parentMint, ROOT);
  assert.equal(deltaAfterFull(cursor, delta.generatedAt), null, "and that delta asks for nothing more");
});
