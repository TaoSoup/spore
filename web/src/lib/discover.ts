// The Discover page (pages/Discover.tsx): the parents getting new coins right now (GET /api/discover, `Discover` in
// lib/api.ts), as the words and bars of a row. Pure: no DOM, no network (test/discover.test.mts). Every line says what
// is counted (coins launched under a parent, what those coins traded), never why, and never how a coin will do.
import type { Discover, DiscoverParent } from "./api";
import { count, plural, short, usd } from "./format";

/// How often the page reads the list while its tab is visible (the server builds it at most every ~10 s).
export const DISCOVER_POLL_MS = 15_000;
/// Bars in a row's strip: one per bin of the window, oldest first.
export const BARS = 12;

/// The strip's counts: exactly BARS whole numbers, oldest first. A longer list keeps its newest bins, a shorter one
/// is padded on the old side; anything that is not a count reads as 0.
export function binsOf(bins: unknown): number[] {
  const src = Array.isArray(bins) ? bins.slice(-BARS) : [];
  const out = src.map((n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0));
  return [...Array.from({ length: BARS - out.length }, () => 0), ...out];
}
/// The bars' heights as a share of the strip: the tallest bin is 1, an empty bin 0 (drawn as a stub).
export function barHeights(bins: unknown): number[] {
  const b = binsOf(bins), max = Math.max(...b);
  return max > 0 ? b.map((n) => n / max) : b;
}
/// "1h", "30m": the window in the row's count line.
export const windowLabel = (windowS: number | null | undefined): string => {
  const s = typeof windowS === "number" && windowS > 0 ? windowS : 3600;
  return s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}m`;
};
const minutes = (binS: number | null | undefined) => Math.max(1, Math.round((typeof binS === "number" && binS > 0 ? binS : 300) / 60));
/// The strip in words, for a reader who cannot see it: "250 new coins in the last hour, 31 in the last 5 minutes,
/// at most 40 in 5 minutes".
export function barsLabel(p: { new1h: number; bins: unknown }, binS?: number | null, windowS?: number | null): string {
  const b = binsOf(p.bins), m = minutes(binS);
  const span = windowLabel(windowS) === "1h" ? "hour" : windowLabel(windowS);
  return `${plural(p.new1h, "new coin")} in the last ${span}, ${count(b[BARS - 1])} in the last ${plural(m, "minute")}, at most ${count(Math.max(...b))} in ${plural(m, "minute")}`;
}
/// "250 new coins · 1h", as its parts (the number is set apart in the row).
export const countWords = (p: { new1h: number }): string => (p.new1h === 1 ? "new coin" : "new coins");
export const countLine = (p: { new1h: number }, windowS?: number | null): string => `${count(p.new1h)} ${countWords(p)} · ${windowLabel(windowS)}`;
/// The coins after "Leading": at most two of the parent's new coins that traded, with their 24 h volume.
export type Leading = { mint: string; sym: string; vol: string };
export function leading(p: { top: DiscoverParent["top"] }): Leading[] {
  const top = Array.isArray(p.top) ? p.top : [];
  return top.filter((c) => c && typeof c.mint === "string" && typeof c.usd24 === "number" && c.usd24 > 0).slice(0, 2)
    .map((c) => ({ mint: c.mint, sym: c.symbol ? `$${c.symbol}` : short(c.mint), vol: usd(c.usd24) }));
}

/// "Launched by 90 creators": how many wallets launched the row's new coins (shown in the open row; nothing for none).
export const creatorsNote = (p: { creators1h: number }): string | null =>
  (typeof p.creators1h === "number" && p.creators1h >= 1 ? `Launched by ${plural(Math.floor(p.creators1h), "creator")}` : null);
/// A row whose parent left the list while the row stayed on screen: in place of the window in its count line, and
/// the longer form where there is room.
export const LEFT_SHORT = "no longer listed";
export const LEFT_NOTE = "No longer in the list. The numbers are the last read.";

/// A row on screen: a parent of the list, or (`left`) a row kept after its parent left the list.
export type DiscoverRow = DiscoverParent & { left?: boolean };
/// The rows after a refresh. Rows are told apart by mint, so the open row stays open wherever it lands.
/// Idle (`hold` false): the fresh list in the server's order; the open row whose parent is no longer listed is kept
/// at the end with the numbers it last had, marked `left`, so a timeline being read does not vanish.
/// In use (`hold`: the pointer is over the list, a row has focus or a row is open): no row moves. The rows on screen
/// keep their order and take the fresh numbers in place, a parent new to the list is appended at the end, and a row
/// whose parent left stays where it is with its last numbers, marked `left`. The page applies the server's order
/// (hold false) once the list is idle again.
export function discoverRows(fresh: Discover | null | undefined, shown: readonly DiscoverRow[], open: string | null, hold = false): DiscoverRow[] {
  const by = new Map<string, DiscoverRow>();
  for (const p of fresh && Array.isArray(fresh.parents) ? fresh.parents : []) {
    if (!p || typeof p.mint !== "string" || by.has(p.mint)) continue;
    by.set(p.mint, p);
  }
  if (hold) {
    const kept = new Set<string>(), rows: DiscoverRow[] = [];
    for (const r of shown) { if (kept.has(r.mint)) continue; kept.add(r.mint); rows.push(by.get(r.mint) ?? { ...r, left: true }); }
    for (const p of by.values()) if (!kept.has(p.mint)) rows.push(p);
    return rows;
  }
  const rows = [...by.values()];
  if (open && !by.has(open)) { const was = shown.find((r) => r.mint === open); if (was) rows.push({ ...was, left: true }); }
  return rows;
}
