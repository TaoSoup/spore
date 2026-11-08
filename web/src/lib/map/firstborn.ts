// The first child of every parent (owner's partner, 2026-10-22): among the coins quoted in a parent,
// the one created first. The rails, the side panel head and its kids list mark it with a small
// pulsing "1st" chip, so the coin that opened a family's line is visible at a glance. Pure, O(n),
// computed once per nodes array (WeakMap) — the page passes the FULL node list, not the drawn
// subset, so the pick stays right when the page draws only the top 60 / 200 roots.
import type { BubbleNode } from "./types";

const cache = new WeakMap<BubbleNode[], Set<string>>();
const createdOf = (n: BubbleNode) => (typeof n.createdAt === "number" && Number.isFinite(n.createdAt) ? n.createdAt : null);

/// `a` was created before `b`: by createdAt, an unknown createdAt after any known one, a tie by mint so the
/// pick is stable from one payload to the next.
export function earlier(a: BubbleNode, b: BubbleNode): boolean {
  const ca = createdOf(a), cb = createdOf(b);
  if (ca != null && cb != null && ca !== cb) return ca < cb;
  if ((ca == null) !== (cb == null)) return ca != null;
  return a.mint < b.mint;
}

/// Mints that are the first child of their parent. A parent whose earliest child has no createdAt gets
/// a pick only when that child is its only one: with two undated children the order is unknown, so
/// neither is marked rather than guessing.
export function firstborns(nodes: BubbleNode[]): Set<string> {
  const hit = cache.get(nodes);
  if (hit) return hit;
  const best = new Map<string, { n: BubbleNode; count: number }>();
  for (const n of nodes) {
    const p = n.parentMint;
    if (!p || p === n.mint) continue;
    const cur = best.get(p);
    if (!cur) best.set(p, { n, count: 1 });
    else { cur.count++; if (earlier(n, cur.n)) cur.n = n; }
  }
  const out = new Set<string>();
  for (const { n, count } of best.values()) if (createdOf(n) != null || count === 1) out.add(n.mint);
  cache.set(nodes, out);
  return out;
}

export const EMPTY_FIRSTBORNS: ReadonlySet<string> = new Set();
