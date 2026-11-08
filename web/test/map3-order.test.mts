// SPEC 3.3 (size modes): the planet set and the family order are mode-independent. Ranks come from both modes'
// values, and a mode switch also passes the previous engine's order, so prices that ticked between the two builds
// cannot reshuffle the planets.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS engine module
import { ingest } from "../src/components/map3/engine/data.js";

type C = { mint: string; symbol: string; mcapUsd: number; lockedUsd: number };
const fam = (mint: string, mcapUsd: number, lockedUsd: number, kids = 0) => ({
  coin: { mint, symbol: mint, mcapUsd, lockedUsd } as C,
  children: Array.from({ length: kids }, (_, i) => ({ coin: { mint: `${mint}-k${i}`, symbol: `${mint}k${i}`, mcapUsd: 10, lockedUsd: 0 } as C, children: [] })),
});
const run = (roots: unknown[], mode: "locked" | "mcap", order?: string[]) => {
  const S: Record<string, unknown> = { N_PLANETS: 2, debug: { map: {} } };
  ingest(S, { roots, heat: null, mode, order });
  const ranked = S.ranked as { top: number }[];
  const mint = S.mint as string[];
  return { order: ranked.map((f) => mint[f.top]), planets: (S.planets as { top: number }[]).map((f) => mint[f.top]) };
};

test("family order and planet set are the same in both modes for the same data", () => {
  const roots = [fam("A", 1000, 0), fam("B", 10, 900), fam("C", 500, 500), fam("D", 1, 1)];
  const l = run(roots, "locked"), m = run(roots, "mcap");
  assert.deepEqual(l.order, m.order);
  assert.deepEqual(l.planets, m.planets);
});

test("a mode switch keeps the previous order even when prices moved between the builds; new families follow", () => {
  const before = run([fam("A", 1000, 0), fam("B", 10, 900), fam("C", 500, 500), fam("D", 1, 1)], "locked");
  // D pumped between the builds and E appeared: without `order` D would move up into the planets
  const after = [fam("A", 1000, 0), fam("B", 10, 900), fam("C", 500, 500), fam("D", 5000, 5000), fam("E", 9000, 9000)];
  assert.notDeepEqual(run(after, "mcap").planets, before.planets, "the drift this guards against");
  const kept = run(after, "mcap", before.order);
  assert.deepEqual(kept.order, [...before.order, "E"]);
  assert.deepEqual(kept.planets, before.planets);
});
