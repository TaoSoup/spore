// Bubble sizes on the forest map (DESIGN §11.5, owner 2026-10-19: "in Bubblemaps a holder with 10 % is
// drawn much bigger than the rest"; 2026-10-21: "before it sorted by the size of the child, which was cool;
// now I don't understand what mcap means").
//
// The size toggle sizes FAMILIES; the coins inside a family are always sized by their own market cap.
// - A family top (a node with no parent on the map: a SOL root, or a listed asset such as $PUMP that coins
//   are quoted in) is drawn by its family value, Σ familyValueOf over every member (the top included), on one
//   scale for the whole map (area ∝ value), so its size says how big the tree is next to the others:
//     mcap   = Σ market cap of every coin in the family (the server's liquidity cap when it sent one; a listed
//              asset top counts 0, its family is the sum of its members; a thin family, isThinFamily, is
//              weighed in locked terms instead);
//     locked = Σ lockedUsd (a coin's lockedUsd is the quote its direct children lock in their curves, so the
//              sum is everything the family locks).
// - Every other coin (a child, or a coin alone on the map) is drawn by its OWN market cap on the map3 scale
//   (mcapRadius, a port of map3 layout.js rad()), identically in both modes: switching modes never resizes
//   a child, so it never loses its logo.
// Clamps: a coin is floor..maxR; a top is at least TOP_RATIO × its largest member and at least
// floor × (TOP_MIN + TOP_LOG · log10(members)), so a crowded family whose coins hold almost nothing still
// has a visible centre. The top scale's end (`rangeR`, the radius of the heaviest top) is TOP_GROW × the
// base largest radius (maxR), capped so that bubble stays within FIT_SHARE of the viewport at fit zoom
// (estimated from the packed area of everything else).
// The family rule is the same in server lib/dominance.mjs familyValueOf, lib/map/dominance.ts and the WebGL
// map (map3/adapter.ts valueFns, engine data.js), so shares agree everywhere.
// Pure functions over the node list (no DOM): the data effect calls them once per data change.
import type { BubbleNode, SizeMode } from "./types";

/// The heaviest weight's radius as a multiple of the base largest radius (before the fit cap).
export const TOP_GROW = 4;
/// A top is at least this many times as wide as its largest member (a hair over 1.5 so float32
/// radii never read below it).
export const TOP_RATIO = 1.52;
/// A top's floor: floor × (TOP_MIN + TOP_LOG · log10(members)) (2 members ≈ 1.8×, 100 = 3.3×, 700 ≈ 4.1×).
export const TOP_MIN = 1.5, TOP_LOG = 0.9;
/// The heaviest bubble's diameter at fit zoom stays within about this share of the viewport.
export const FIT_SHARE = 0.22;
/// The viewport's shorter side at fit zoom, in world units, per sqrt(Σ (r + 6)²) of the bubbles
/// (cluster padding, packing gaps, aspect stretch, insets): 3.3 at 1440×900 and 3.0 at 390×844 on the
/// full map (16.5 k coins, 2026-10-19). The heaviest radius R stays ≤ FIT_SHARE / 2 × that side.
const EXTENT_PER_SQRT_AREA = 2.9;

/// What each size mode means, one line each: the map key and the size toggle's titles print these.
export const SIZE_MODE_LINE: Record<SizeMode, string> = {
  locked: "Families: share of the value locked in their children's curves · coins: their own market cap",
  mcap: "Families: share of market cap (every coin in the family) · coins: their own market cap",
};

/// A coin's part of its family's value in `mode` (null = nothing known); a family value sums the positive
/// finite parts of its members. "mcap" (the default, owner 2026-10-21: "Pokémon is a very big coin but looks
/// tiny"): the market cap, or the server's liquidity cap when it sent one (a 1e9-supply coin on a dollar of
/// liquidity must not draw as a billion-dollar family); a listed asset top counts 0. "locked": lockedUsd,
/// what the coin's direct children lock in their curves (a leaf adds nothing; there is no market-cap slice).
export const familyValueOf = (d: Pick<BubbleNode, "mcapUsd" | "lockedUsd" | "asset" | "mcapCapUsd">, mode: SizeMode): number | null =>
  mode === "mcap" ? (d.asset ? 0 : (d.mcapCapUsd ?? d.mcapUsd ?? null)) : (d.lockedUsd ?? null);
/// The old name, the same rule (store.ts and BubbleMap import it).
export const valueOf = familyValueOf;

/// A coin's radius by its own market cap in map3 world units: map3 engine layout.js rad() verbatim. 0.55 with
/// no market cap; under $2k 0.55 → 1 on a log scale from $300; from $2k 1 + 1.54 · log10(m / 2000), capped at 7.
export const mcapRadius = (m: number | null | undefined): number => {
  const v = m ?? NaN;
  return !(v > 0) ? 0.55 : v < 2000 ? 0.55 + 0.45 * Math.max(0, Math.min(1, Math.log(v / 300) / Math.log(2000 / 300))) : Math.min(7, 1 + 1.54 * Math.log10(v / 2000));
};
/// A non-top coin's radius (world units), the same in both modes: floor at no market cap (mcapRadius 0.55),
/// growing with mcapRadius, clamped to floor..maxR. `mcapUsd` is coinMcap(node).
export const coinRadius = (mcapUsd: number | null | undefined, sc: { floor: number; maxR: number }): number =>
  Math.min(sc.maxR, Math.max(sc.floor, (sc.floor * mcapRadius(mcapUsd)) / 0.55));
/// The market cap a coin is drawn by: the server's liquidity cap when it sent a positive one, else mcapUsd (map3
/// engine data.js mc[] reads the same).
export const coinMcap = (d: Pick<BubbleNode, "mcapUsd" | "mcapCapUsd">): number | null => (d.mcapCapUsd != null && d.mcapCapUsd > 0 ? d.mcapCapUsd : d.mcapUsd);

/// Thin-family guard for "mcap" (2026-10-21 review: the 12 biggest discs were 2-3 coin families with a
/// $0.1-1B market cap and nothing locked, e.g. a 2-coin family at $1.07B while $PUMP's 1,600 coins drew
/// at 0.1 %): a family of at most THIN_MAX_COINS coins whose members lock less than THIN_LOCKED_USD in
/// all is weighed in "locked" terms instead (Σ lockedUsd, under THIN_LOCKED_USD: the family stays small).
/// The same rule as server lib/dominance.mjs familyShares and map3/adapter.ts valueFn.
export const THIN_MAX_COINS = 5, THIN_LOCKED_USD = 100;
export const isThinFamily = (coins: number, lockedSum: number): boolean => coins <= THIN_MAX_COINS && !(lockedSum >= THIN_LOCKED_USD);

/// Family structure of a node list, by position: parent (-1 = none on the map), family top (the same
/// walk as MapStore.rootOf: at most 16 hops), member count at each top's position, and the tops
/// themselves (a top has at least one member besides itself).
export type Families = { parent: Int32Array; top: Int32Array; members: Uint32Array; isTop: Uint8Array };
export function families(nodes: readonly BubbleNode[]): Families {
  const n = nodes.length, at = new Map<string, number>();
  for (let q = 0; q < n; q++) at.set(nodes[q].mint, q);
  const parent = new Int32Array(n), top = new Int32Array(n), members = new Uint32Array(n), isTop = new Uint8Array(n);
  for (let q = 0; q < n; q++) { const p = nodes[q].parentMint, pq = p ? at.get(p) : undefined; parent[q] = pq === undefined || pq === q ? -1 : pq; }
  for (let q = 0; q < n; q++) { let cur = q, hops = 0; while (parent[cur] >= 0 && hops++ < 16) cur = parent[cur]; top[q] = cur; members[cur]++; }
  for (let q = 0; q < n; q++) isTop[q] = top[q] === q && members[q] > 1 ? 1 : 0;
  return { parent, top, members, isTop };
}

/// Weight per node in `mode`: its own familyValueOf, or for a top its family value (the sum over the
/// family, own value included). NaN = no value known (not a top). Only a top's weight sizes a bubble
/// (familyRadii); a lone coin's is its family-of-one value for the dominance table.
export function familyWeights(nodes: readonly BubbleNode[], fam: Families, mode: SizeMode): Float64Array {
  const n = nodes.length, own = new Float64Array(n), sum = new Float64Array(n);
  // mcap: a thin family (isThinFamily: Σ lockedUsd over its members) is weighed in locked terms
  let thin: Uint8Array | null = null;
  if (mode === "mcap") {
    const lk = new Float64Array(n);
    for (let q = 0; q < n; q++) { const l = nodes[q].lockedUsd; if (l != null && l > 0) lk[fam.top[q]] += l; }
    thin = new Uint8Array(n);
    for (let q = 0; q < n; q++) { const t = fam.top[q]; if (isThinFamily(fam.members[t], lk[t])) thin[q] = 1; }
  }
  for (let q = 0; q < n; q++) {
    const v = familyValueOf(nodes[q], thin && thin[q] ? "locked" : mode);
    own[q] = v == null || !Number.isFinite(v) ? NaN : Math.max(0, v);
    if (own[q] > 0) sum[fam.top[q]] += own[q];
  }
  for (let q = 0; q < n; q++) if (fam.isTop[q]) own[q] = sum[q];
  return own;
}

/// The heaviest TOP weight (0 when the map has no family of two or more): the top scale's `maxW`. A lone
/// coin or a child never sets it (they are sized by their own market cap).
export function topMaxWeight(fam: Families, w: Float64Array): number {
  let m = 0;
  for (let q = 0; q < w.length; q++) if (fam.isTop[q] && w[q] > m) m = w[q];
  return m;
}

/// The scale: `maxW` = the heaviest top weight (topMaxWeight), drawn at radius `rangeR`; `floor` = the
/// smallest radius; `maxR` = the base largest radius (the largest a non-top coin is drawn).
export type SizeScale = { maxW: number; rangeR: number; floor: number; maxR: number };

/// Radius per node (world units) for top weights `w` on scale `sc`: a non-top coin by its own market cap
/// (coinRadius, mode-independent); a top max(√w · k, its count floor, TOP_RATIO × its largest member) with
/// k = rangeR / √maxW.
export function familyRadii(fam: Families, w: Float64Array, sc: SizeScale, nodes: readonly BubbleNode[]): Float32Array {
  const n = w.length, r = new Float32Array(n), biggest = new Float32Array(n);
  const k = sc.rangeR / Math.sqrt(Math.max(1e-9, sc.maxW));
  for (let q = 0; q < n; q++) {
    if (fam.isTop[q]) continue;
    r[q] = coinRadius(coinMcap(nodes[q]), sc);
    const t = fam.top[q];
    if (t !== q && r[q] > biggest[t]) biggest[t] = r[q];
  }
  for (let q = 0; q < n; q++) {
    if (!fam.isTop[q]) continue;
    const v = w[q] > 0 ? w[q] : 0;
    r[q] = Math.max(Math.sqrt(v) * k, sc.floor * (TOP_MIN + TOP_LOG * Math.log10(fam.members[q])), TOP_RATIO * biggest[q]);
  }
  return r;
}

/// The top scale's end for these weights: TOP_GROW × maxR, lowered (never below maxR) so the heaviest top
/// stays within FIT_SHARE of the viewport at fit, from the packed area of every other bubble.
export function rangeFor(fam: Families, w: Float64Array, base: { maxW: number; floor: number; maxR: number }, nodes: readonly BubbleNode[]): number {
  const hi = base.maxR * TOP_GROW;
  const r = familyRadii(fam, w, { ...base, rangeR: hi }, nodes);
  let heavy = -1, hw = -Infinity;
  for (let q = 0; q < w.length; q++) if (fam.isTop[q] && w[q] > hw) { hw = w[q]; heavy = q; }
  let area = 0;
  for (let q = 0; q < r.length; q++) if (q !== heavy) area += (r[q] + 6) ** 2;
  const cap = (FIT_SHARE / 2) * EXTENT_PER_SQRT_AREA * Math.sqrt(area);
  return Math.max(base.maxR, Math.min(hi, cap));
}
