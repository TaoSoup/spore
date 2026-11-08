// Dominance (DESIGN §11.5, owner 2026-10-20: "the market share of a pair given the sum of the pair
// value"): each family's share of the whole map's value, for pages that do not load the map (the coin
// page). A family is a root of the all-scope map (a SOL root, or a listed asset such as $PUMP) and every
// coin drawn under it; its value is what its top bubble is drawn by on the map, so the numbers here and
// the map's agree: `familyValueOf` and the per-family sum mirror web/src/lib/map/sizing.ts (familyValueOf,
// familyWeights), lib/map/dominance.ts and the WebGL map's engine data.js exactly. Built from the cached whole-forest tree (mapAll).

/** How long one mode's table is served before it is rebuilt from the (10 s) map cache. */
export const DOMINANCE_CACHE_MS = 30_000;

/**
 * A coin's part of its family's value in a size mode (null = nothing known; a family sums the positive finite
 * parts of its members). "mcap" (the default): its market cap, capped by its liquidity (mcapCapUsd, pricing.mjs
 * LIQ_X) when the API capped it; a listed asset top (USDC, PUMP, CARDS, ...) counts 0 there, its family is the
 * sum of its members. "locked": lockedUsd, what its direct children lock in their curves (a leaf adds nothing).
 */
export function familyValueOf(c, mode) {
  if (mode === "mcap") return c.asset ? 0 : (c.mcapCapUsd ?? c.mcapUsd ?? null);
  return c.lockedUsd ?? null;
}
/** The old name, the same rule. */
export const valueOf = familyValueOf;

/**
 * Thin-family guard for "mcap" (2026-10-21 review: 2-3 coin families with a $0.1-1B market cap and
 * nothing locked drew as the biggest discs): a family of at most THIN_MAX_COINS (5) coins whose members
 * lock less than THIN_LOCKED_USD in all is weighed in "locked" terms (Σ lockedUsd: the family stays small).
 * The same rule as web/src/lib/map/sizing.ts isThinFamily.
 */
export const THIN_MAX_COINS = 5, THIN_LOCKED_USD = 100;
export const isThinFamily = (coins, lockedSum) => coins <= THIN_MAX_COINS && !(lockedSum >= THIN_LOCKED_USD);

/**
 * `roots` = mapAll's `{ coin, children }` trees. Returns `{ mode, total, families }`, every family with
 * `{ mint, symbol, value, share, coins }`, biggest first (ties: more coins, then mint). Values are USD
 * rounded to cents; shares (0..1) are not rounded, so they add up to 1 (2 k families of mostly tiny
 * shares lost 0.03 % of the total to a 1e-6 rounding).
 */
export function familyShares(roots, mode) {
  const rows = [];
  let total = 0;
  const stack = [];
  const members = [];
  for (const r of roots) {
    let value = 0, coins = 0, locked = 0;
    members.length = 0;
    stack.length = 0; stack.push(r);
    while (stack.length) {
      const n = stack.pop();
      coins++;
      members.push(n.coin);
      if (n.coin.lockedUsd != null && n.coin.lockedUsd > 0) locked += n.coin.lockedUsd;
      for (const k of n.children) stack.push(k);
    }
    // a thin family is weighed in locked terms in "mcap" (isThinFamily)
    const m = mode === "mcap" && isThinFamily(coins, locked) ? "locked" : mode;
    for (const c of members) {
      const v = familyValueOf(c, m);
      if (v != null && Number.isFinite(v) && v > 0) value += v;
    }
    total += value;
    rows.push({ mint: r.coin.mint, symbol: r.coin.symbol ?? null, value, share: 0, coins });
  }
  for (const row of rows) row.share = total > 0 ? row.value / total : 0;
  rows.sort((a, b) => b.value - a.value || b.coins - a.coins || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  for (const row of rows) row.value = Math.round(row.value * 100) / 100;
  return { mode, total: Math.round(total * 100) / 100, families: rows };
}
