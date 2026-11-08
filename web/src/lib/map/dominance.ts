// Dominance (owner 2026-10-20: "the market share of a pair given the sum of the pair value, so you can
// see which pairs have the biggest dominance outside of the size of the cells"): each family's share of
// the whole map's value, in both size modes. A family is a top (a SOL root, or a listed asset such as
// $PUMP) and every coin under it; its value is the weight its top bubble is drawn by (sizing.ts
// familyWeights: Σ familyValueOf over the family: market cap in "mcap", the asset top at 0; lockedUsd in
// "locked", no market-cap slice), so the number and the bubble always agree. A coin alone on the map counts as a family of one, so the
// shares of every mode add up to exactly 100 %.
// Pure, over the node list: the page recomputes it once per data change (families() is one O(n) pass
// with a mint index, the two weightings are O(n) each, the sort is over ~2 k tops), never per frame.
import { families, familyWeights, type Families } from "./sizing";
import type { BubbleNode, SizeMode } from "./types";

/// `node` = the family's top, `value` its weight (USD), `share` 0..1, `members` coins in it, `rank` 1 = biggest.
export type DomRow = { node: BubbleNode; value: number; share: number; members: number; rank: number };
export type DomTable = {
  mode: SizeMode;
  /// Σ of every family's value (USD).
  total: number;
  /// Every family, biggest share first (ties: more members, then mint).
  ranked: DomRow[];
  /// Family top mint → its row.
  byTop: Map<string, DomRow>;
};
export type Dominance = { locked: DomTable; mcap: DomTable };

/// One mode's table from the family structure (shared between the two modes).
export function dominanceTable(nodes: readonly BubbleNode[], fam: Families, mode: SizeMode): DomTable {
  const w = familyWeights(nodes, fam, mode);
  const ranked: DomRow[] = [];
  let total = 0;
  for (let q = 0; q < nodes.length; q++) {
    if (fam.top[q] !== q) continue;
    const v = w[q] > 0 && Number.isFinite(w[q]) ? w[q] : 0; // NaN (nothing known) and 0 alike
    total += v;
    ranked.push({ node: nodes[q], value: v, share: 0, members: fam.members[q], rank: 0 });
  }
  for (const r of ranked) r.share = total > 0 ? r.value / total : 0;
  ranked.sort((a, b) => b.value - a.value || b.members - a.members || (a.node.mint < b.node.mint ? -1 : a.node.mint > b.node.mint ? 1 : 0));
  const byTop = new Map<string, DomRow>();
  for (let i = 0; i < ranked.length; i++) { ranked[i].rank = i + 1; byTop.set(ranked[i].node.mint, ranked[i]); }
  return { mode, total, ranked, byTop };
}

/// Both modes' tables, from one family pass.
export function dominance(nodes: readonly BubbleNode[]): Dominance {
  const fam = families(nodes);
  return { locked: dominanceTable(nodes, fam, "locked"), mcap: dominanceTable(nodes, fam, "mcap") };
}

/// A share (0..1) as the map writes it: one decimal below 10 %, whole numbers from there, "<0.1%" for a
/// sliver that would read as zero.
export function sharePct(share: number | null | undefined): string {
  if (share == null || !Number.isFinite(share) || share <= 0) return "0%";
  const p = share * 100;
  if (p < 0.05) return "<0.1%";
  if (p < 9.95) return `${p.toFixed(1)}%`;
  return `${Math.round(Math.min(100, p))}%`;
}

/// A row's share, or null when nothing in the family is priced (value 0: unknown, not "0 %"; ~100 families
/// of tokenized-stock tops have no USD price in either mode). The panels show "—" for it.
export const shareOf = (r: DomRow | null | undefined): number | null => (r && r.value > 0 ? r.share : null);

/// Family top mint → title tag ("23%") for every priced family in `t` with at least `minShare`, for the
/// map's cluster titles (an unpriced family's title keeps no number). Phones tag only the families of
/// 1 % and more (COMPACT_TAG_MIN): on a crowded phone overview those are the numbers worth the room.
export function titleTags(t: DomTable | null | undefined, minShare = 0): Map<string, string> {
  const out = new Map<string, string>();
  if (t) for (const r of t.ranked) if (r.value > 0 && r.share >= minShare) out.set(r.node.mint, sharePct(r.share));
  return out;
}
export const COMPACT_TAG_MIN = 0.01;

/// Mode words the panels use next to a share.
export const DOM_WORDS: Record<SizeMode, string> = { locked: "of all locked value", mcap: "of market cap" };
