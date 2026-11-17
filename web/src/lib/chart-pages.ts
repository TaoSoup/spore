// The coin page's chart scrolled back: older candles loaded a page at a time as the first candle nears the left edge
// (server: /api/candles before=, lib/chart-history.mjs page). Every rule the component follows is here, without a DOM:
// which rows a page or a re-read replaces, when to ask, what an answer does, how the view keeps the same candles while
// rows are prepended, and what the foot says.
import type { Candle, CandlePage } from "./api";

/// A `loading` page is asked again every 4 s for 3 min, then the chart waits as for `held`.
export const PAGE_POLL_MS = 4_000, PAGE_POLLS = 45;
/// The wait before asking again after a `held` answer, and after a failed request.
export const HELD_MS = 60_000, ERROR_MS = 30_000;
/// Rows the chart holds at most; past it no more pages (a larger candle size covers more time).
export const MAX_ROWS = 10_000;
/// The next page is asked once the first loaded candle is this many bars (or half the visible bars) from the left edge.
export const EDGE_MIN_BARS = 20;

type Row = Candle;
type Range = { from: number; to: number };
/// The paging state of one series (coin, resolution, price key). `cursor`: the `before` of the next older page (null:
/// nothing older, or not known yet); `busy`: a request is in flight or a `loading` page waits for its next ask;
/// `moved`: the user dragged, pinched, wheeled or keyed the chart (nothing loads before that; a tap does not count); `pages`: pages applied;
/// `gecko` / `chain`: credits for what the pages brought (sticky).
export type Back = {
  key: string; cursor: number | null; busy: boolean; polls: number; heldUntil: number;
  pages: number; moved: boolean; gecko: string | null; chain: "exact" | "sampled" | null; state: "idle" | "loading" | "held" | "full" | "end";
};

/// What resets the pages: another coin, resolution or price key. The display unit (MC, Price, quote) is not in it: it
/// is a factor over the same raw rows.
export const seriesKey = (mint: string, res: number, priceKey: "usd" | "quote") => `${mint}|${res}|${priceKey}`;
/// A series' paging state before any page.
export const freshBack = (key: string, cursor: number | null): Back =>
  ({ key, cursor, busy: false, polls: 0, heldUntil: 0, pages: 0, moved: false, gecko: null, chain: null, state: "idle" });
/// An answer is applied only by the series generation that asked for it (each reset bumps the generation).
export const takesAnswer = (askedGen: number, gen: number) => askedGen === gen;

/// Sort, dedupe and normalise to seconds: the chart library rejects unsorted or repeated times.
export function normalize(rows: readonly Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of rows) {
    if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)) continue;
    const t = c.t > 1e12 ? Math.floor(c.t / 1000) : Math.floor(c.t);
    m.set(t, { ...c, t, v: Number.isFinite(c.v) ? c.v : 0 });
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/// Sorted, deduped union: rows of `kept` in [lo, hi) are replaced by `incoming` (normalised to seconds; only its rows
/// in [lo, hi) count, the stretch the server answered for).
export function mergeRange(kept: readonly Row[], incoming: readonly Row[], lo: number, hi: number): Row[] {
  const fresh = normalize(incoming).filter((c) => c.t >= lo && c.t < hi);
  const out = kept.filter((c) => c.t < lo || c.t >= hi);
  if (!fresh.length) return out.length === kept.length ? [...kept] : out;
  return normalize([...out, ...fresh]);
}

/// A fresh newest-window answer: authoritative from its first row on; older rows (pages, and newest rows that fell out
/// of the moving window) are kept.
export function mergeFresh(kept: readonly Row[], fresh: readonly Row[]): Row[] {
  const f = normalize(fresh);
  return mergeRange(kept, f, f[0]?.t ?? Infinity, Infinity);
}

/// The first cursor of a series: its oldest row's t, or null when it has fewer than 2 rows (a thin chart: taken once a
/// re-read fills it) or its oldest row is in the coin's creation bucket (nothing older exists).
export function firstCursor(rows: readonly Row[], res: number, createdAt: number | null): number | null {
  if (rows.length < 2) return null;
  const t = rows[0].t;
  return createdAt != null && t <= Math.floor(createdAt / res) * res ? null : t;
}

/// Whether the visible logical range moved from `start` (taken as a pointer or touch went down) to `now`: a drag or a
/// pinch did, a tap, a click or a page scroll that began on the chart did not (by more than a hundredth of a bar).
export function rangeMoved(start: Range | null, now: Range | null): boolean {
  if (!start || !now) return false;
  return Math.abs(now.from - start.from) > 0.01 || Math.abs(now.to - start.to) > 0.01;
}

/// How far a press travels before it is a drag (px).
export const PRESS_SLOP_PX = 4;
/// A pointer or touch held on the chart: the view and the place where it went down, and whether it has since travelled
/// past PRESS_SLOP_PX or a second finger came (a pinch). The chart changes the view by itself too (a live trade's new
/// bucket shifts it by a bar, a re-read or poll answer refits it), also under a finger held to read the crosshair: only
/// a dragged press counts a change of the view as the user's move (pressMoved).
export type Press = { range: Range | null; x: number; y: number; dragged: boolean };
export function pressAt(range: Range | null, x: number, y: number, dragged = false): Press {
  return { range: range && { from: range.from, to: range.to }, x, y, dragged };
}
/// The press after the pointer moved to (x, y), or a second finger came (`pinch`).
export function pressMove(p: Press | null, x: number, y: number, pinch = false): Press | null {
  if (!p || p.dragged) return p;
  return pinch || Math.hypot(x - p.x, y - p.y) > PRESS_SLOP_PX ? { ...p, dragged: true } : p;
}
/// Whether the view `now` is the user's move during press `p` (rangeMoved, for a dragged press only).
export function pressMoved(p: Press | null, now: Range | null): boolean {
  return !!p?.dragged && rangeMoved(p.range, now);
}

/// Whether to ask for the next older page now: only after the user moved the chart, one page at a time, while there is
/// one, not before a wait ends, under MAX_ROWS, and with the first candle near the left edge (within EDGE_MIN_BARS bars
/// or half the visible bars; a negative `from` is space left of the first candle).
export function wantOlder(b: Back, range: Range | null, n: number, nowMs: number): boolean {
  return b.moved && !b.busy && b.cursor != null && nowMs >= b.heldUntil && n >= 2 && n < MAX_ROWS && range != null
    && range.from < Math.max(EDGE_MIN_BARS, (range.to - range.from) / 2);
}

/// What an answer to the page asked with `before = hi` does: the next state, the rows to apply (`[lo, hi)` replaced by
/// `rows`; null: nothing to apply) and when to ask the same page again (null: not by itself).
export function applyPage(b: Back, page: CandlePage, hi: number, nowMs: number): { back: Back; apply: { rows: Row[]; lo: number; hi: number } | null; retryInMs: number | null } {
  const credits = {
    gecko: b.gecko ?? page.gecko ?? null,
    chain: b.chain === "sampled" || page.chain === "sampled" ? "sampled" as const : b.chain ?? page.chain ?? null,
  };
  if (page.state === "loading") {
    const polls = b.polls + 1;
    if (polls >= PAGE_POLLS) return { back: { ...b, polls: 0, state: "held", heldUntil: nowMs + HELD_MS }, apply: null, retryInMs: null };
    return { back: { ...b, polls, state: "loading" }, apply: null, retryInMs: PAGE_POLL_MS };
  }
  const from = Math.min(page.from, hi);
  const apply = from < hi ? { rows: page.candles, lo: from, hi } : null;
  const pages = b.pages + (apply ? 1 : 0);
  if (page.state === "held") return { back: { ...b, ...credits, cursor: page.next ?? b.cursor, pages, polls: 0, state: "held", heldUntil: nowMs + HELD_MS }, apply, retryInMs: null };
  // done: a `next` that does not move down would ask the same page forever
  const cursor = page.next != null && page.next < hi ? page.next : null;
  return { back: { ...b, ...credits, cursor, pages, polls: 0, state: cursor == null ? "end" : "idle" }, apply, retryInMs: null };
}

/// The logical range that keeps the same candles in view after `oldRows` became `newRows` (the first visible candle
/// stays first); null when the view was at the right edge (`to >= oldN - 1`: it follows the newest candle, as before).
export function keepView(range: Range | null, oldRows: readonly Row[], newRows: readonly Row[]): Range | null {
  const n = oldRows.length;
  if (!range || !n || !newRows.length || range.to >= n - 1) return null;
  const i = Math.max(0, Math.min(n - 1, Math.round(range.from)));
  const shift = lowerBound(newRows, oldRows[i].t) - i;
  return { from: range.from + shift, to: range.to + shift };
}
/// Bars kept between the keyboard's candle and the edge it was brought in from.
export const KEY_MARGIN_BARS = 2;
/// The logical range that brings row `i` (the keyboard's candle) into view, the same width, the candle KEY_MARGIN_BARS
/// inside the edge it crossed; null when it is in view. Keys cannot drag: without this the rows a page prepends stay
/// left of a right-anchored view, the crosshair sits off-screen and wantOlder never sees the left edge again.
export function keyView(range: Range | null, i: number): Range | null {
  if (!range) return null;
  const w = range.to - range.from;
  if (i < range.from + 0.5) return { from: i - KEY_MARGIN_BARS, to: i - KEY_MARGIN_BARS + w };
  if (i > range.to - 0.5) return { from: i + KEY_MARGIN_BARS - w, to: i + KEY_MARGIN_BARS };
  return null;
}

/// The index of the first row with t >= `t`.
function lowerBound(rows: readonly Row[], t: number): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}

/// The foot's note about older candles ("" when there is nothing to say).
export function backHint(b: Back, n: number): string {
  if (b.busy || b.state === "loading") return " · loading earlier candles…";
  if (b.state === "held") return " · earlier candles unavailable for now";
  if (b.cursor != null && (b.state === "full" || n >= MAX_ROWS)) return " · older candles: pick a larger candle size";
  return "";
}

/// The "in view" change's rows: the first and last visible row indices of the visible logical range, clamped to the
/// rows; null with no rows or a range wholly outside them.
export function viewSpan(range: Range | null, n: number): [number, number] | null {
  if (!range || n < 1 || range.to < -0.5 || range.from > n - 0.5) return null;
  const clamp = (x: number) => Math.max(0, Math.min(n - 1, Math.round(x)));
  const i0 = clamp(range.from), i1 = clamp(range.to);
  return i0 <= i1 ? [i0, i1] : null;
}
