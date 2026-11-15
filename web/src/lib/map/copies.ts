// Copycat stacking (the Key's "Copies" switch, `?copies=all` turns it off): under one parent, coins that carry the SAME
// ticker are one stack. The map draws the stack's leader only; the others are left out of what the WebGL map is built
// from, so a parent with 400 "$KIMCHI" children shows one. On the local index (2026-11-15) 39 % of the drawn coins were
// such copies (46.8k of 120.8k), and 30 % of the ones that traded in 24 h.
//   - Same ticker = the symbol without leading "$" and surrounding space, upper-cased ("$kimchi" = "KIMCHI"). Names that
//     only look alike (FUND, FUNDINU, FUNDCAT) are different coins and never stack. No symbol = never stacked.
//   - Only siblings stack (the same parent). Roots never do.
//   - The leader is the copy with the most 24 h volume; ties: market cap, then the older coin, then the mint. Under the
//     Key's last-trade filter a copy whose bucket is shown leads before one whose bucket is hidden, so a stack with a
//     shown coin is never represented by a hidden one.
//   - A copy with children of its own on the map stays drawn (its children hang off it), and so does a pinned one (the
//     selection and its lineage: picking a copy in the side panel shows it).
// Pure, like visibility.ts: the page stacks at most once per heat poll and node pass.
import type { HeatIndex } from "./heat";
import { LAST_ALL, coinClass } from "./visibility";
import type { BubbleNode } from "./types";

export type CopiesMode = "stack" | "all";
export const parseCopies = (param: string | null): CopiesMode => (param === "all" ? "all" : "stack");

/// The ticker two copies share, or null when a coin has none.
export function tickerKey(n: Pick<BubbleNode, "symbol">): string | null {
  const s = n.symbol;
  if (s == null || s === "") return null;
  let k = keyCache.get(s);
  if (k === undefined) {
    k = String(s).trim().replace(/^\$+/, "").trim().toUpperCase() || null;
    if (keyCache.size > 400_000) keyCache.clear();
    keyCache.set(s, k);
  }
  return k;
}
/// symbol → its key: the map restacks the whole list (120k coins) on every pass, and the symbols hardly change.
const keyCache = new Map<string, string | null>();

export type Stacked = {
  /** What the map draws: the input without the hidden copies, in input order (the SAME array when nothing is hidden). */
  nodes: readonly BubbleNode[];
  byMint: ReadonlyMap<string, BubbleNode>;
  /** Leader mint → how many copies it stands for (the hidden ones, not itself). */
  count: ReadonlyMap<string, number>;
  /** Hidden copy mint → its leader's mint. */
  leaderOf: ReadonlyMap<string, string>;
  hidden: number;
};

const EMPTY_N: ReadonlyMap<string, number> = new Map(), EMPTY_S: ReadonlyMap<string, string> = new Map();
/// The order inside a stack: the leader first.
export function copyCmp(heat: HeatIndex | null): (a: BubbleNode, b: BubbleNode) => number {
  const vol = (n: BubbleNode) => heat?.rows.get(n.mint)?.v24 ?? 0;
  return (a, b) => vol(b) - vol(a) || (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0) || (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
}

export function stackCopies(nodes: readonly BubbleNode[], byMint: ReadonlyMap<string, BubbleNode>, heat: HeatIndex | null, pinned: readonly string[] = [], mask = LAST_ALL): Stacked {
  // parent → ticker → the first coin seen, or (from the second on) the group's list: most tickers are alone under their parent
  const parents = new Map<string, Map<string, BubbleNode | BubbleNode[]>>();
  const groups: BubbleNode[][] = [];
  for (const n of nodes) {
    const pm = n.parentMint;
    if (!pm || pm === n.mint || !byMint.has(pm)) continue;
    let m = parents.get(pm);
    if (!m) parents.set(pm, (m = new Map()));
    const k = tickerKey(n);
    if (!k) continue;
    const g = m.get(k);
    if (g === undefined) m.set(k, n);
    else if (Array.isArray(g)) g.push(n);
    else { const list = [g, n]; m.set(k, list); groups.push(list); }
  }
  const pin = pinned.length ? new Set(pinned) : null;
  const cmp = copyCmp(heat);
  // (the last-trade filter) 1 = the Key shows this copy's bucket; all 1 with the filter off or without heat
  const filter = !!heat && (mask & LAST_ALL) !== LAST_ALL;
  const on = (n: BubbleNode) => (filter ? (mask >> coinClass(n, heat)) & 1 : 1);
  const leaderOf = new Map<string, string>(), count = new Map<string, number>();
  for (const list of groups) {
    let top = list[0];
    let topOn = on(top);
    for (let i = 1; i < list.length; i++) { const o = on(list[i]); if (o > topOn || (o === topOn && cmp(list[i], top) < 0)) { top = list[i]; topOn = o; } }   // the leader only: no sort
    const lead = top.mint;
    let k = 0;
    for (let i = 0; i < list.length; i++) {
      const m = list[i].mint;
      if (m === lead || parents.has(m) || (pin && pin.has(m))) continue;
      leaderOf.set(m, lead); k++;
    }
    if (k) count.set(lead, k);
  }
  if (!leaderOf.size) return { nodes, byMint, count: EMPTY_N, leaderOf: EMPTY_S, hidden: 0 };
  const out: BubbleNode[] = [], map = new Map<string, BubbleNode>();
  for (const n of nodes) if (!leaderOf.has(n.mint)) { out.push(n); map.set(n.mint, n); }
  return { nodes: out, byMint: map, count, leaderOf, hidden: leaderOf.size };
}

/// The stack a coin belongs to: its same-ticker siblings in `kids` (its parent's children), itself included, the leader
/// first. Fewer than two = no stack ([]).
export function copyGroup(node: BubbleNode, kids: readonly BubbleNode[], heat: HeatIndex | null): BubbleNode[] {
  const k = tickerKey(node);
  if (!k) return [];
  const list = kids.filter((x) => tickerKey(x) === k);
  return list.length < 2 ? [] : list.sort(copyCmp(heat));
}
