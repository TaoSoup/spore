// DESIGN-FAMILY-ALL.md §5.1 / §7: the swarm's slot field (engine/swarm-slots.js, pure) and the ghost count (data.js).
//   - slots fill the annulus r0..r1 (r1 fitted to the drawn extent), avoid every drawn member's disc + clear, run inner ->
//     outer (slot j = the j-th undrawn coin in server order), are deterministic in (seed, members, n), and the slice form
//     equals the one-shot build;
//   - (fix round) the field follows the drawn silhouette (no halo ring, no circle), thins out toward a member instead of a
//     hard crater, and anchors every slot to its nearest member by edge distance;
//   - the fallbacks (second half-offset pass, then counted overlaps) still return n slots;
//   - rankCut caps the shown ghosts by a hash rank; the pick grid finds the nearest accepted point;
//   - data.js: ghost = max(0, top.children - drawn kids) on listed-asset tops only, size = members + ghost.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS engine module
import { buildSlots, createSlotBuilder, fnv1a, hash01, strideOf, rankCut, thinRank, buildPointGrid, nearestInGrid, slotsHash, countInDiscs } from "../src/components/map3/engine/swarm-slots.js";
// @ts-expect-error plain JS engine module
import { ingest } from "../src/components/map3/engine/data.js";

type Disc = { x: number; y: number; r: number };
type Slots = { x: Float32Array; y: Float32Array; anchor: Int32Array; n: number; spacing: number; spacingMean: number; p: number; candidates: number; pass2: number; overlaps: number; ms: number; r0: number; r1: number; r95: number; ramp: number };
const lcg = (seed: number) => { let s = seed >>> 0 || 1; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; };
/// a $PUMP-like family: 2,500 drawn members (r 0.5-3 u) scattered over a disc of 150 u around (cx, cy)
function members(cx: number, cy: number, n = 2500, R = 150, seed = 7): Disc[] {
  const rnd = lcg(seed), out: Disc[] = [];
  for (let i = 0; i < n; i++) { const r = R * Math.sqrt(rnd()), a = rnd() * 2 * Math.PI; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), r: 0.5 + 2.5 * rnd() ** 3 }); }
  return out;
}
const CX = 37.5, CY = -12.25, SEED = fnv1a("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");

test("fnv1a and hash01 are stable", () => {
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("pump"), fnv1a("pump"));
  assert.notEqual(fnv1a("pumpA"), fnv1a("pumpB"));
  const h = hash01(SEED, 3);
  assert.ok(h >= 0 && h < 1);
  assert.equal(h, hash01(SEED, 3));
  let s = 0; for (let q = 0; q < 10_000; q++) s += hash01(SEED, q);
  assert.ok(Math.abs(s / 10_000 - 0.5) < 0.02, `mean ${s / 10_000}`);
});

test("slots fill the annulus, clear of every drawn disc, inner to outer, n of them", () => {
  const mem = members(CX, CY), r0 = 9.9, r1 = 160;
  const res = buildSlots({ cx: CX, cy: CY, r0, r1, n: 20_000, seed: SEED, members: mem, clear: 1.2 }) as Slots;
  assert.equal(res.n, 20_000);
  assert.equal(res.x.length, 20_000);
  assert.equal(res.overlaps, 0);
  // r1 is fitted to the drawn extent (members reach 150 + 3 u), never past the given bound
  assert.ok(res.r1 <= r1 && res.r1 > 145 && res.r1 < 158, `fitted r1 ${res.r1}`);
  assert.ok(res.r95 > 140 && res.r95 < 152, `r95 ${res.r95}`);
  let outside = 0;
  for (let j = 0; j < res.n; j++) { const d = Math.hypot(res.x[j], res.y[j]); if (d < r0 - 1e-3 || d > res.r1 + 1e-3) outside++; }
  assert.equal(outside, 0, "every slot inside the annulus");
  // clear of every member's disc + 1.2 u (positions are relative to the centre)
  const rel = mem.map((m) => ({ x: m.x - CX, y: m.y - CY, r: m.r + 1.2 - 1e-3 }));
  assert.equal(countInDiscs(res.x, res.y, res.n, rel), 0, "no slot on a drawn coin (+ clear)");
  // inner -> outer: the radius trend over slot order (deciles) is increasing
  const dec = Array.from({ length: 10 }, (_, k) => { let s = 0; const a = Math.floor(k * res.n / 10), b = Math.floor((k + 1) * res.n / 10); for (let j = a; j < b; j++) s += Math.hypot(res.x[j], res.y[j]); return s / (b - a); });
  for (let k = 1; k < 10; k++) assert.ok(dec[k] > dec[k - 1], `decile ${k} ${dec[k]} > ${dec[k - 1]}`);
  // the spacing: the candidate spacing sqrt(pi (r1^2 - r0^2) / candidates) = the densest slot spacing; the mean is wider
  assert.ok(Math.abs(res.spacing - Math.sqrt(Math.PI * (res.r1 * res.r1 - r0 * r0) / res.candidates)) < 1e-9);
  assert.ok(res.spacingMean >= res.spacing, `mean ${res.spacingMean} >= densest ${res.spacing}`);
  assert.ok(res.p > 0.15 && res.p < 1, `mean acceptance ${res.p}`);   // 2,500 members with 1.2 u clearance + their ramps take room
  // every slot has an anchor
  let noA = 0; for (let j = 0; j < res.n; j++) if (res.anchor[j] < 0 || res.anchor[j] >= mem.length) noA++;
  assert.equal(noA, 0);
});

test("no members: area-uniform inside, thinning out over the outer taper (no hard circle)", () => {
  // no silhouette to follow: the plain annulus; the acceptance tapers over the last max(3 s0, 0.06 r1) before r1
  const r0 = 5, r1 = 100, inner = 88;
  const res = buildSlots({ cx: 0, cy: 0, r0, r1, n: 30_000, seed: 12345, members: [], clear: 1.2 }) as Slots;
  assert.equal(res.r1, r1, "nothing to fit");
  const A = inner * inner - r0 * r0, rings = 6, cnt = Array.from({ length: rings }, () => 0);
  let nIn = 0, outer = 0;
  for (let j = 0; j < res.n; j++) {
    const d = Math.hypot(res.x[j], res.y[j]);
    if (d >= inner) { if (d >= 97) outer++; continue; }
    nIn++; cnt[Math.min(rings - 1, Math.floor(rings * (d * d - r0 * r0) / A))]++;
  }
  for (const c of cnt) assert.ok(Math.abs(c / nIn - 1 / rings) < 0.012, `ring share ${c / nIn}`);
  // the last 3 u hold far fewer slots than their area share (~6 % of the annulus): the field thins out at its edge
  assert.ok(outer / res.n < 0.02, `outer band share ${outer / res.n}`);
  // quadrants too (the golden-angle spiral plus jitter has no direction)
  const q = [0, 0, 0, 0];
  for (let j = 0; j < res.n; j++) q[(res.x[j] >= 0 ? 0 : 1) + (res.y[j] >= 0 ? 0 : 2)]++;
  for (const c of q) assert.ok(Math.abs(c / res.n - 0.25) < 0.01, `quadrant share ${c / res.n}`);
});

test("deterministic: same inputs, same slots (hash); another seed, another field", () => {
  const mem = members(CX, CY, 800, 80, 3);
  const o = { cx: CX, cy: CY, r0: 6, r1: 78, n: 5_000, seed: SEED, members: mem, clear: 1.2 };
  const a = buildSlots(o) as Slots, b = buildSlots(o) as Slots, c = buildSlots({ ...o, seed: SEED + 1 }) as Slots;
  assert.equal(slotsHash(a.x, a.y, a.n), slotsHash(b.x, b.y, b.n));
  assert.notEqual(slotsHash(a.x, a.y, a.n), slotsHash(c.x, c.y, c.n));
});

test("the slice form (<= 8 ms steps) builds exactly the one-shot field", () => {
  const mem = members(CX, CY);
  const o = { cx: CX, cy: CY, r0: 9.9, r1: 145, n: 50_000, seed: SEED, members: mem, clear: 1.2 };
  const one = buildSlots(o) as Slots;
  const b = createSlotBuilder(o);
  let steps = 0, maxMs = 0;
  for (;;) { const t = performance.now(); const done = b.step(t + 2); maxMs = Math.max(maxMs, performance.now() - t); steps++; if (done) break; }
  const sl = b.result() as Slots;
  assert.ok(steps > 1, "it took more than one slice");
  assert.ok(maxMs < 8, `max slice ${maxMs.toFixed(2)} ms`);
  assert.equal(slotsHash(sl.x, sl.y, sl.n), slotsHash(one.x, one.y, one.n));
});

test("crowded annulus: free slots first, counted overlaps when the candidates run out; always n slots", () => {
  // members cover most of the annulus, so the first pass runs out of candidates
  const mem: Disc[] = [];
  for (let a = 0; a < 2 * Math.PI; a += 0.05) for (const r of [12, 20, 28]) mem.push({ x: r * Math.cos(a), y: r * Math.sin(a), r: 1.6 });
  const res = buildSlots({ cx: 0, cy: 0, r0: 8, r1: 32, n: 4_000, seed: 99, members: mem, clear: 1.2 }) as Slots;
  assert.equal(res.n, 4_000);
  assert.ok(res.p < 0.6, `the rings take room: free share ${res.p}`);
  for (let j = 0; j < res.n; j++) assert.ok(Number.isFinite(res.x[j]) && Number.isFinite(res.y[j]));
  assert.ok(countInDiscs(res.x, res.y, res.n, mem.map((m) => ({ ...m, r: m.r + 1.2 - 1e-3 }))) <= res.overlaps, "only counted overlaps sit on a disc");
  // a degenerate request (no room at all) still answers n slots, every one an overlap
  const full = buildSlots({ cx: 0, cy: 0, r0: 2, r1: 3, n: 50, seed: 1, members: [{ x: 0, y: 0, r: 10 }], clear: 0 }) as Slots;
  assert.equal(full.n, 50);
  assert.equal(full.overlaps, 50);
  // n = 0
  assert.equal((buildSlots({ cx: 0, cy: 0, r0: 2, r1: 30, n: 0, seed: 1, members: [], clear: 1 }) as Slots).n, 0);
});

test("rankCut: a tier cap shows the ghosts whose hash rank is under tau, never more than the cap", () => {
  assert.equal(strideOf(0, 5000), 1);
  assert.equal(strideOf(5001, 5000), 2);
  assert.equal(strideOf(48_877, 5000), 10);
  assert.equal(rankCut(SEED, 4_999, 5000), 1);
  assert.equal(rankCut(SEED, 5_000, 5000), 1);
  for (const [g, cap] of [[48_877, 5000], [20_000, 3000], [76_470, 5000], [7, 3], [5_001, 5000]]) {
    const tau = rankCut(SEED, g, cap); let shown = 0; for (let j = 0; j < g; j++) if (thinRank(SEED, j) < tau) shown++;
    assert.ok(shown <= cap, `${g}/${cap}: ${shown}`);
    assert.ok(shown >= cap - Math.ceil(g / 4096) - 1, `${g}/${cap}: ${shown} (within one histogram bin of the cap)`);
  }
  // the rank is a hash: the shown subset of an area-true spiral has no direction (quadrants equal within 2 %)
  const res = buildSlots({ cx: 0, cy: 0, r0: 4, r1: 90, n: 40_000, seed: SEED, members: [], clear: 0 }) as Slots;
  const tau = rankCut(SEED, res.n, 4000), q = [0, 0, 0, 0]; let shown = 0;
  for (let j = 0; j < res.n; j++) if (thinRank(SEED, j) < tau) { q[(res.x[j] >= 0 ? 0 : 1) + (res.y[j] >= 0 ? 0 : 2)]++; shown++; }
  for (const c of q) assert.ok(Math.abs(c / shown - 0.25) < 0.02, `quadrant share ${c / shown}`);
});

test("the field follows the drawn silhouette: no halo ring past the members, no grain where there are none", () => {
  // members fill the right half-disc of radius 100 only; the bound is a 150 u disc
  const rnd = lcg(5), mem: Disc[] = [{ x: 0, y: 0, r: 4 }];
  for (let i = 0; i < 1500; i++) { const r = 100 * Math.sqrt(rnd()), a = (rnd() - 0.5) * Math.PI; mem.push({ x: r * Math.cos(a), y: r * Math.sin(a), r: 0.4 + 0.6 * rnd() }); }
  const res = buildSlots({ cx: 0, cy: 0, r0: 4, r1: 150, n: 15_000, seed: 77, members: mem, clear: 0.3 }) as Slots;
  assert.ok(res.r1 < 110, `fitted r1 ${res.r1} (bound 150)`);
  let left = 0, deepLeft = 0, past = 0;
  for (let j = 0; j < res.n; j++) {
    if (res.x[j] < 0) left++;
    if (res.x[j] < -25) deepLeft++;
    if (Math.hypot(res.x[j], res.y[j]) > 104) past++;
  }
  assert.ok(left / res.n < 0.12, `left half share ${left / res.n}`);
  assert.ok(deepLeft / res.n < 0.01, `well left of the members ${deepLeft / res.n}`);
  assert.ok(past / res.n < 0.01, `past the members' rim ${past / res.n}`);
});

test("a seed head thins the grain around it instead of cutting a crater; anchors are the nearest member by edge", () => {
  // one big member (R 10) in a field of small ones; slots inside R + clear never, then a ramp
  const rnd = lcg(9), mem: Disc[] = [{ x: 0, y: 0, r: 3 }, { x: 50, y: 0, r: 10 }];
  for (let i = 0; i < 800; i++) { const r = 95 * Math.sqrt(rnd()), a = rnd() * 2 * Math.PI, x = r * Math.cos(a), y = r * Math.sin(a); if (Math.hypot(x - 50, y) < 18) continue; mem.push({ x, y, r: 0.4 }); }
  const res = buildSlots({ cx: 0, cy: 0, r0: 3, r1: 100, n: 12_000, seed: 31, members: mem, clear: 0.3, ramp: 2 }) as Slots;
  assert.equal(countInDiscs(res.x, res.y, res.n, mem.map((m) => ({ ...m, r: m.r + 0.3 - 1e-3 }))), 0, "nothing inside a disc + clear");
  // edge-distance bands around the big member: the density rises from the disc outward (a ramp, not a step)
  const band = [0, 0, 0];   // e in [0.3, 2), [2, 5), [5, 8)
  for (let j = 0; j < res.n; j++) { const e = Math.hypot(res.x[j] - 50, res.y[j]) - 10; if (e < 2) band[0]++; else if (e < 5) band[1]++; else if (e < 8) band[2]++; }
  const area = (a: number, b: number) => Math.PI * ((10 + b) ** 2 - (10 + a) ** 2);
  const dens = [band[0] / area(0.3, 2), band[1] / area(2, 5), band[2] / area(5, 8)];
  assert.ok(dens[0] < dens[1] && dens[1] <= dens[2] * 1.15, `ramp densities ${dens.map((d) => d.toFixed(3))}`);
  assert.ok(band[0] > 0, "some grain right by the seed head (no hard crater)");
  // anchors: the nearest member by |p - m| - R (brute force over a sample)
  for (let j = 0; j < res.n; j += 97) {
    let best = -1, bd = Infinity;
    for (let q = 0; q < mem.length; q++) { const d = Math.hypot(res.x[j] - mem[q].x, res.y[j] - mem[q].y) - mem[q].r; if (d < bd) { bd = d; best = q; } }
    const a = res.anchor[j], da = Math.hypot(res.x[j] - mem[a].x, res.y[j] - mem[a].y) - mem[a].r;
    assert.ok(a === best || Math.abs(da - bd) < 1e-4, `slot ${j}: anchor ${a} (${da}) vs nearest ${best} (${bd})`);
  }
});

test("pick grid: the nearest accepted point within reach", () => {
  const x = Float32Array.from([0, 1, 5, 5.2, -3]), y = Float32Array.from([0, 0, 5, 5, 4]);
  const g = buildPointGrid(x, y, 5, 1);
  assert.equal(nearestInGrid(g, 0.9, 0.1, 0.5), 1);
  assert.equal(nearestInGrid(g, 5.15, 5, 1), 3);
  assert.equal(nearestInGrid(g, 5.15, 5, 1, (j: number) => j !== 3), 2);
  assert.equal(nearestInGrid(g, 10, 10, 1), -1);
  assert.equal(nearestInGrid(g, -3, 4.4, 0.5), 4);
  // only the first n points take part (the family's filled slots)
  const g2 = buildPointGrid(x, y, 2, 1);
  assert.equal(nearestInGrid(g2, 5, 5, 1), -1);
});

test("data.js: ghost on listed-asset tops only (children - drawn kids), size = members + ghost", () => {
  const kid = (m: string) => ({ coin: { mint: m, symbol: m, mcapUsd: 3000, lockedUsd: 0 }, children: [] });
  const roots = [
    { coin: { mint: "PUMP", symbol: "PUMP", asset: true, children: 51_441, mcapUsd: 2e9, lockedUsd: 1e6 }, children: [kid("p1"), kid("p2"), { ...kid("p3"), children: [kid("p3a")] }] },
    { coin: { mint: "SOLTOP", symbol: "S", children: 900, mcapUsd: 5e5, lockedUsd: 1e4 }, children: [kid("s1")] },   // not an asset: drawn whole
    { coin: { mint: "USDC", symbol: "USDC", asset: true, children: 2, mcapUsd: null, lockedUsd: 0 }, children: [kid("u1"), kid("u2"), kid("u3")] },   // more drawn than counted
  ];
  const S: Record<string, unknown> = { N_PLANETS: 2, debug: { map: {} } };
  ingest(S, { roots, heat: null, mode: "mcap" });
  const fams = S.fams as { ghost: number; size: number; members: number[] }[];
  assert.equal(fams[0].ghost, 51_441 - 3);
  assert.equal(fams[0].size, 5 + 51_441 - 3);
  assert.equal(fams[1].ghost, 0);
  assert.equal(fams[1].size, 2);
  assert.equal(fams[2].ghost, 0);
  assert.equal(fams[2].size, 4);
  assert.equal(S.ghostTotal, 51_438);
});
