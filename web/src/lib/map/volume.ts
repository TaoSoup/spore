// Colour by volume (the Key's "Colour" switch; the default since 2026-11-15, `?colour=last` is the other): every coin's rank
// by 24 h volume INSIDE its family, so a busy family still has a clear top. By last trade a family where everything traded in the last half hour is
// all one colour; by rank the few coins that carry the volume stand out and the tail goes quiet.
//   - A family is a root and everything under it; the root itself is not ranked (it keeps its own last-trade colour).
//   - Only coins with volume in the last 24 h are ranked: most first, ties by trades in the last hour, then by mint.
//   - Four tiers, the engine's four heat colours: the top 5 % (at least one coin, at most 10), up to the top 20 % (at most
//     24), the rest of the top half, the rest. The caps (2026-11-15): once graduated coins reported their trades a big
//     family ranked 2,000 coins, and 5 % of that is a hundred "leaders": nobody finds the runner among a hundred.
// The WebGL engine colours by a clock, so a tier is handed to it as a made-up "last trade" (`clast`, engine/index.d.ts
// EngineHeat) inside that tier's heat class; the real `last` still drives the Key's last-trade filter, the counts and the
// tooltips. Pure: the map shell calls it once per heat poll.
import type { HeatIndex } from "./heat";
import type { BubbleNode } from "./types";

export type ColourMode = "last" | "volume";
/// `?colour=last` → by last trade; no param or anything else → by volume (the default: the param is then deleted).
export const parseColour = (param: string | null): ColourMode => (param === "last" ? "last" : "volume");
export const formatColour = (c: ColourMode): string | null => (c === "last" ? "last" : null);

export type VolRank = { /** 1 = the family's most traded coin. */ rank: number; /** Ranked coins in the family. */ of: number; tier: 0 | 1 | 2 | 3 };
/// Cumulative shares of a family's ranked coins that end tiers 0, 1 and 2.
export const VOL_TIER_END: readonly [number, number, number] = [0.05, 0.2, 0.5];
/// The most coins tiers 0 and 0-1 hold, however large the family.
export const VOL_TIER_MAX: readonly [number, number] = [10, 24];
/// The made-up age (s) a tier is drawn with: inside heat classes 0, 1 and 2 (engine/tokens.js heatClass: ≤ 30 min, ≤ 3 h,
/// ≤ 24 h). The family's three leaders get the engine's brightest core (≤ 5 min). Tier 3 has no age: the cold colour.
export const VOL_TIER_AGE: readonly [number, number, number] = [900, 5_400, 43_200];
export const VOL_LEAD_AGE = 60, VOL_LEADERS = 3;

export function volTier(rank: number, of: number): 0 | 1 | 2 | 3 {
  if (rank <= Math.max(1, Math.min(VOL_TIER_MAX[0], Math.ceil(of * VOL_TIER_END[0])))) return 0;
  if (rank <= Math.max(2, Math.min(VOL_TIER_MAX[1], Math.ceil(of * VOL_TIER_END[1])))) return 1;
  if (rank <= Math.ceil(of * VOL_TIER_END[2])) return 2;
  return 3;
}

/// A node's family top (its root), walking parentMint; a cycle or a missing parent ends the walk where it stands.
export function topFn(byMint: ReadonlyMap<string, BubbleNode>): (n: BubbleNode) => string {
  const memo = new Map<string, string>();
  return (n) => {
    const hit = memo.get(n.mint);
    if (hit !== undefined) return hit;
    const path = new Set<string>();
    let cur = n, top = n.mint;
    for (;;) {
      const known = memo.get(cur.mint);
      if (known !== undefined) { top = known; break; }
      path.add(cur.mint);
      const p = cur.parentMint ? byMint.get(cur.parentMint) : undefined;
      if (!p || path.has(p.mint)) { top = cur.mint; break; }
      cur = p;
    }
    for (const m of path) memo.set(m, top);
    return top;
  };
}

/// Every ranked coin's place in its family (see the top of this file). Unranked coins (roots, no volume, no heat row) are absent.
export function volumeRanks(nodes: readonly BubbleNode[], byMint: ReadonlyMap<string, BubbleNode>, heat: HeatIndex | null): Map<string, VolRank> {
  const out = new Map<string, VolRank>();
  if (!heat) return out;
  const topOf = topFn(byMint);
  const fams = new Map<string, { mint: string; v: number; t: number }[]>();
  for (const n of nodes) {
    const r = heat.rows.get(n.mint);
    if (!r || !(r.v24 > 0)) continue;
    const top = topOf(n);
    if (top === n.mint) continue;
    let list = fams.get(top);
    if (!list) fams.set(top, (list = []));
    list.push({ mint: n.mint, v: r.v24, t: r.t1h });
  }
  for (const list of fams.values()) {
    list.sort((a, b) => b.v - a.v || b.t - a.t || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    const of = list.length;
    for (let k = 0; k < of; k++) out.set(list[k].mint, { rank: k + 1, of, tier: volTier(k + 1, of) });
  }
  return out;
}

/// The colour clock of one heat row (unix s; 0 = the cold colour): a ranked coin's tier, a root's own last trade, else 0.
export function colourLast(mint: string, last: number, at: number, ranks: ReadonlyMap<string, VolRank>, byMint: { get(mint: string): BubbleNode | undefined; has(mint: string): boolean }): number {
  const rk = ranks.get(mint);
  if (rk) return rk.tier === 3 ? 0 : at - (rk.rank <= VOL_LEADERS && rk.tier === 0 ? VOL_LEAD_AGE : VOL_TIER_AGE[rk.tier]);
  const n = byMint.get(mint);
  const root = !!n && (!n.parentMint || n.parentMint === n.mint || !byMint.has(n.parentMint));
  return root ? last : 0;
}

/// The spotlight of the volume colours: the map's highlight test (lib/map/highlight.ts hlPredicate, null = none) narrowed
/// to the coins that carry a family's volume (tiers 0 and 1: its top 20 %, at most 24) and the roots, so the tail is drawn dim, as a
/// highlight dims what does not match. `ranks` null (coloured by last trade) returns `base` itself.
export function spotlight(base: ((n: BubbleNode) => boolean) | null, ranks: ReadonlyMap<string, VolRank> | null, byMint: { has(mint: string): boolean }): ((n: BubbleNode) => boolean) | null {
  if (!ranks) return base;
  return (n) => {
    const rk = ranks.get(n.mint);
    const lit = rk ? rk.tier <= 1 : !n.parentMint || n.parentMint === n.mint || !byMint.has(n.parentMint);
    return lit && (!base || base(n));
  };
}

export type Leader = { node: BubbleNode; rank: number; v24: number; t1h: number };
/// The `n` most traded coins of one family (its top's mint) by 24 h volume, ties as volumeRanks; the top itself is not listed.
/// Walks the heat rows (the coins that traded), not the node list.
export function familyLeaders(top: string, byMint: ReadonlyMap<string, BubbleNode>, heat: HeatIndex | null, n = 10): Leader[] {
  if (!heat) return [];
  const topOf = topFn(byMint);
  const list: Leader[] = [];
  for (const [mint, r] of heat.rows) {
    if (!(r.v24 > 0) || mint === top) continue;
    const node = byMint.get(mint);
    if (node && topOf(node) === top) list.push({ node, rank: 0, v24: r.v24, t1h: r.t1h });
  }
  list.sort((a, b) => b.v24 - a.v24 || b.t1h - a.t1h || (a.node.mint < b.node.mint ? -1 : a.node.mint > b.node.mint ? 1 : 0));
  list.length = Math.min(list.length, n);
  list.forEach((l, i) => { l.rank = i + 1; });
  return list;
}
