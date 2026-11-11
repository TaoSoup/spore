// The map's last-trade filter (DESIGN §11.5 "Map v2", the Key): a set of last-trade buckets from `?last=` (the engine's
// four heat classes, map3 engine/tokens.js heatClass: within 30 min, 3 h, 24 h, older) that HIDES every coin whose
// bucket is off: the page's nodes and byMint are never filtered, a hidden coin is only not drawn, not pickable and
// unlabelled, so the map can be read from afar. The classic map hides in place (its layout never moves); the WebGL map is
// BUILT from `buildSet` (the shown coins, their lineage and the pins) on every mask change, so each family is laid out
// compactly around what is shown, and hides in place only between builds (a coin that ages out). The default hides
// "older" (no trade in 24 h, never traded included). Every coin gets a level: SHOWN (its bucket is on, it is pinned, or
// it was born in the last 30 min while that bucket is on), ANCHOR (not shown itself, but an ancestor of a shown coin up
// to its family top: drawn dim, so a shown coin never floats without its lineage) or hidden (absent from the levels map).
// Pure, like highlight.ts: the page computes the levels at most every 2 s, the WebGL engine its own per trade
// (EngineHandle.setLastFilter), and the classic map writes one hide bit per node.
// Ages run on the heat poll's clock (`heat.at`), never the wall clock: a fixture serving an old heat file still sorts.
import type { HeatIndex } from "./heat";
import type { BubbleNode } from "./types";

export type LastKey = "30m" | "3h" | "24h" | "old";
/// Canonical order (heat class 0 → 3): the Key renders in it and `?last=` is always written in it, so one filter has one URL.
export const LAST_KEYS: readonly LastKey[] = ["30m", "3h", "24h", "old"];
/// The default: everything that traded in the last 24 h; "older" is hidden.
export const LAST_DEFAULT: readonly LastKey[] = ["30m", "3h", "24h"];
/// The mask with every bucket on: the filter is off (the engine and the classic map then do exactly what they did before it).
export const LAST_ALL = 15;
export const LAST_LABEL: Record<LastKey, string> = { "30m": "within 30 min", "3h": "within 3 h", "24h": "within 24 h", old: "older" };
/// The short forms (the dock pill's tag, aria labels).
export const LAST_SHORT: Record<LastKey, string> = { "30m": "30 min", "3h": "3 h", "24h": "24 h", old: "older" };
/// Upper bounds (s, inclusive) of heat classes 0, 1 and 2: exactly engine/tokens.js heatClass (a test pins the parity).
export const LAST_EDGES: readonly [number, number, number] = [1_800, 10_800, 86_400];
/// A coin created this recently (s, on the heat clock) counts as traded within 30 min even before its heat row exists.
export const NEWBORN_S = 1_800;

export type Level = "shown" | "anchor";
export type Levels = ReadonlyMap<string, Level>;
export type LastCounts = [number, number, number, number];

const KNOWN = new Set<string>(LAST_KEYS);
const isKey = (s: string): s is LastKey => KNOWN.has(s);

/// `?last=30m,3h` → ["30m", "3h"]; "all" → all four; no param, an empty list or nothing known → the default. Unknown
/// keys and duplicates are dropped and the order is canonical; the result is never empty (an empty map is no map).
export function parseLast(param: string | null): LastKey[] {
  if (param == null) return [...LAST_DEFAULT];
  const s = param.trim().toLowerCase();
  if (s === "all") return [...LAST_KEYS];
  const want = new Set<LastKey>();
  for (const part of s.split(",")) { const k = part.trim(); if (isKey(k)) want.add(k); }
  const out = LAST_KEYS.filter((k) => want.has(k));
  return out.length ? out : [...LAST_DEFAULT];
}
/// The inverse: null for the default (the param is then deleted), "all" for all four, else the canonical list. An
/// empty set formats as the default (null), as parseLast reads it.
export function formatLast(keys: readonly LastKey[]): string | null {
  const want = new Set(keys);
  const out = LAST_KEYS.filter((k) => want.has(k));
  if (out.length === LAST_KEYS.length) return "all";
  if (out.length === 0 || (out.length === LAST_DEFAULT.length && LAST_DEFAULT.every((k) => want.has(k)))) return null;
  return out.join(",");
}
/// Bit k = show heat class k (LAST_KEYS[k]); 15 = all.
export function lastMask(keys: readonly LastKey[]): number {
  let m = 0;
  for (const k of keys) { const i = LAST_KEYS.indexOf(k); if (i >= 0) m |= 1 << i; }
  return m;
}
/// The keys of a mask, canonical order.
export const lastKeysOf = (mask: number): LastKey[] => LAST_KEYS.filter((_, i) => (mask >> i) & 1);
/// The one-line tag of a shown set for the collapsed Key: null for all four; "≤ 24 h" for the buckets up to one; else the short words.
export function lastTag(keys: readonly LastKey[]): string | null {
  const m = lastMask(keys);
  if (m === LAST_ALL) return null;
  if (m === 1 || m === 3 || m === 7) return `≤ ${LAST_SHORT[LAST_KEYS[m === 1 ? 0 : m === 3 ? 1 : 2]]}`;
  return lastKeysOf(m).map((k) => LAST_SHORT[k]).join(" · ");
}

/// Heat class of an age in seconds (engine/tokens.js heatClass).
export const classOfAge = (age: number): 0 | 1 | 2 | 3 => (age <= LAST_EDGES[0] ? 0 : age <= LAST_EDGES[1] ? 1 : age <= LAST_EDGES[2] ? 2 : 3);
/// A coin's last-trade class: age = heat.at − its row's last trade (never negative: a live trade after the poll is age 0).
/// No heat, no row or no trade on record → 3 ("older").
export function lastClass(mint: string, heat: HeatIndex | null): 0 | 1 | 2 | 3 {
  const r = heat?.rows.get(mint);
  if (!heat || !r || !(r.last > 0)) return 3;
  return classOfAge(Math.max(0, heat.at - r.last));
}
/// The class a node is filed under: its last-trade class, except that a coin born in the last NEWBORN_S counts as class 0.
export function coinClass(n: BubbleNode, heat: HeatIndex | null): 0 | 1 | 2 | 3 {
  const c = lastClass(n.mint, heat);
  if (c === 0 || !heat) return c;
  const born = n.createdAt;
  return typeof born === "number" && Number.isFinite(born) && born >= heat.at - NEWBORN_S ? 0 : c;
}
/// How many nodes each bucket holds (coinClass), [30 min, 3 h, 24 h, older].
export function lastCounts(nodes: readonly BubbleNode[], heat: HeatIndex | null): LastCounts {
  const out: LastCounts = [0, 0, 0, 0];
  for (const n of nodes) out[coinClass(n, heat)]++;
  return out;
}
/// The shown count of a mask: the sum of its buckets.
export const lastShownOf = (counts: readonly number[], mask: number) => counts.reduce((a, c, i) => a + ((mask >> i) & 1 ? c : 0), 0);

/// Every node's level under `mask` (absent = hidden), or null when nothing is hidden: the mask is all four, or there is
/// no heat yet (the map never goes blank while the heat sidecar loads). `pinned` (the selection and its ancestor chain)
/// is always shown. Anchors: every ancestor of a shown coin, through parentMint up to and including its family top
/// (a listed asset drawn as a top included), that is not shown itself. O(n) plus one walk per shown coin that stops at
/// the first ancestor already placed.
export function visibleLevels(nodes: readonly BubbleNode[], byMint: ReadonlyMap<string, BubbleNode>, mask: number, heat: HeatIndex | null, pinned: readonly string[] = []): Map<string, Level> | null {
  if ((mask & LAST_ALL) === LAST_ALL || !heat) return null;
  const out = new Map<string, Level>();
  const shown: BubbleNode[] = [];
  const pin = pinned.length ? new Set(pinned) : null;
  for (const n of nodes) {
    if ((pin && pin.has(n.mint)) || (mask >> coinClass(n, heat)) & 1) { out.set(n.mint, "shown"); shown.push(n); }
  }
  // a pin the list does not hold (an off-map selection) is shown all the same, with its lineage
  if (pin) for (const m of pin) if (!out.has(m)) { out.set(m, "shown"); const n = byMint.get(m); if (n) shown.push(n); }
  for (const n of shown) {
    let cur = n;
    for (let hops = 0; cur.parentMint && hops < 64; hops++) {
      const p = byMint.get(cur.parentMint);
      if (!p || p === cur || out.has(p.mint)) break;
      out.set(p.mint, "anchor");
      cur = p;
    }
  }
  return out;
}
/// What the WebGL map is BUILT from under a filter (2026-11-10, compact layout): the coins `visibleLevels` shows, all their
/// ancestors (anchors, drawn dim) and the pins, so every family is laid out compactly around what is shown; a family with
/// nothing shown or pinned is left out entirely.
export type BuildSet = {
  /** Mask 15 or no heat: the SAME array object (a mask-15 build is bit-identical); else the kept nodes in input order. */
  nodes: readonly BubbleNode[];
  filtered: boolean;
  /** Kept nodes by level: shown (class bit or pin), anchors (everything else kept: ancestors and the kept tops), pins
   * (pinned nodes whose class is not shown; counted in `shown` too). */
  shown: number; anchors: number; pins: number;
  /** Family tops kept with nothing shown (opts.keepTop: a capped family whose ghosts the mask draws). */
  kept: number;
  /** Roots kept / roots of `nodes` left out entirely. */
  families: number; dropped: number;
};
/// The build input under `mask` (see BuildSet). Same rule as visibleLevels (coinClass incl. the newborn rule, pins shown), so
/// the engine's levels at build equal the page's; the ancestor walk is not hop-capped here (a coin of a 70-deep chain keeps
/// its whole lineage, so buildRoots never makes a spurious root of the 64th ancestor). Pins the list does not hold are
/// ignored (the engine gets them through EngineOptions.last). Input order is kept. O(n) plus the ancestor walks, each stopping
/// at the first coin already kept. opts.emptyTops: a filter that keeps nothing at all (the buckets on are empty, nothing pinned)
/// keeps every family top instead (counted in `kept`; all hidden), so the build is still a compact one, cheap, and the coins
/// that come into those buckets later are added live next to their tops (the whole list would be the most expensive build).
export function buildSet(nodes: readonly BubbleNode[], byMint: ReadonlyMap<string, BubbleNode>, mask: number, heat: HeatIndex | null, pinned: readonly string[] = [], opts: { keepTop?: (top: BubbleNode) => boolean; emptyTops?: boolean } = {}): BuildSet {
  const lv = visibleLevels(nodes, byMint, mask, heat, pinned);
  if (!lv) return { nodes, filtered: false, shown: 0, anchors: 0, pins: 0, kept: 0, families: 0, dropped: 0 };
  const keep = new Set<string>();
  for (const [m] of lv) keep.add(m);
  // the whole lineage of every kept coin (visibleLevels stops at 64 hops; ancestors added here are visited too: their walk
  // stops at once)
  for (const m of keep) {
    let cur = byMint.get(m);
    for (let hops = 0; cur && cur.parentMint && hops < 1_000_000; hops++) {
      const p = byMint.get(cur.parentMint);
      if (!p || p === cur || keep.has(p.mint)) break;
      keep.add(p.mint);
      cur = p;
    }
  }
  const isRoot = (n: BubbleNode) => !n.parentMint || n.parentMint === n.mint || !byMint.has(n.parentMint);
  let kept = 0, rootsAll = 0;
  for (const n of nodes) {
    if (!isRoot(n)) continue;
    rootsAll++;
    if (!keep.has(n.mint) && opts.keepTop && opts.keepTop(n)) { keep.add(n.mint); kept++; }
  }
  const pin = pinned.length ? new Set(pinned) : null;
  const out: BubbleNode[] = [];
  let shown = 0, anchors = 0, pins = 0, families = 0;
  for (const n of nodes) {
    if (!keep.has(n.mint)) continue;
    out.push(n);
    if (isRoot(n)) families++;
    if (lv.get(n.mint) === "shown") { shown++; if (pin && pin.has(n.mint) && !((mask >> coinClass(n, heat)) & 1)) pins++; }
    else anchors++;
  }
  // nothing kept (a pin the list does not hold keeps no node): every top, hidden (opts.emptyTops)
  if (out.length === 0 && opts.emptyTops) for (const n of nodes) if (isRoot(n) && !keep.has(n.mint)) { keep.add(n.mint); out.push(n); kept++; families++; anchors++; }
  return { nodes: out, filtered: true, shown, anchors, pins, kept, families, dropped: Math.max(0, rootsAll - families) };
}
/// The levels as a test (null = everything is visible): shown or anchor. What the map draws (the arrow walk steps on it).
export const visibleTest = (levels: Levels | null): ((mint: string) => boolean) | null => (levels ? (m) => levels.has(m) : null);
/// What a highlight can light up under the levels (null = everything): a shown coin or a pin. An anchor is drawn dim even
/// when it matches, so a chip does not count it; a pin (the selection's lineage, whatever its bucket) is drawn lit, so it
/// does. The highlight chips count through this test, so a chip's number is what lights up.
export function litTest(levels: Levels | null, pinned: readonly string[] = []): ((mint: string) => boolean) | null {
  if (!levels) return null;
  const pin = pinned.length ? new Set(pinned) : null;
  return (m) => levels.get(m) === "shown" || (pin !== null && pin.has(m));
}
