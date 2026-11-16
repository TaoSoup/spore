// The Portfolio page's realized P&L chart (components/portfolio/PnlChart.tsx): the points of
// /api/pnl/:wallet/series (the wallet's cumulative realized profit over time, in USD at today's prices) cleaned and
// turned into the geometry of one line. The line is a STEP: realized profit only changes at a sell, so it runs level
// to the time of the next point and then jumps. The scale always holds zero, so the zero line is on the chart and a
// series that crosses it shows both sides.
// Pure: no React, no DOM, so it runs under node:test (test/pnl-chart.test.mts). Nothing here returns NaN or Infinity.
export type SeriesPoint = { t: number; usd: number };
/// `xs` / `ys`: the pixel of each point. `line`: the step path. `area`: the same path closed onto the zero line.
/// `zeroY`: the pixel of zero. `lo` / `hi`: the lowest and highest value of the points (not of the scale), at
/// `loI` / `hiI`. `tone`: where the period ends, "up" above zero, "down" below, "none" at (or within half a cent of) it.
export type ChartGeo = {
  w: number; h: number; xs: number[]; ys: number[]; line: string; area: string; zeroY: number;
  lo: number; hi: number; loI: number; hiI: number; first: SeriesPoint; last: SeriesPoint; tone: "up" | "down" | "none";
};

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const f1 = (n: number) => n.toFixed(1);

/// The points of an answer, safe to draw: rows with a finite time and value, time ascending (the order given is kept
/// among equal times). Anything else (null, a string, a missing field) is dropped.
export function seriesPoints(raw: unknown): SeriesPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: SeriesPoint[] = [];
  for (const p of raw) { const q = p as Partial<SeriesPoint> | null; if (q && fin(q.t) && fin(q.usd)) out.push({ t: q.t, usd: q.usd }); }
  return out.map((p, i) => ({ p, i })).sort((a, b) => a.p.t - b.p.t || a.i - b.i).map((x) => x.p);
}

/// True when there is a line worth drawing: two points or more and some profit or loss among them (a wallet that sold
/// nothing in the period answers a level line at zero).
export const hasSeries = (points: readonly SeriesPoint[]): boolean => points.length >= 2 && points.some((p) => Math.abs(p.usd) >= 0.005);

/// The geometry of the points in a `w` × `h` box with `padX` / `padY` kept free; null with fewer than two points.
export function chartGeo(points: readonly SeriesPoint[], w: number, h: number, padX = 6, padY = 12): ChartGeo | null {
  if (points.length < 2 || !fin(w) || !fin(h) || w <= 0 || h <= 0) return null;
  let lo = Infinity, hi = -Infinity, loI = 0, hiI = 0;
  points.forEach((p, i) => { if (p.usd < lo) { lo = p.usd; loI = i; } if (p.usd > hi) { hi = p.usd; hiI = i; } });
  // the scale holds zero; a level series (all zero) sits on the middle of the box
  const sLo = Math.min(0, lo), sHi = Math.max(0, hi), span = sHi - sLo;
  const first = points[0], last = points[points.length - 1], dt = last.t - first.t;
  const innerW = Math.max(0, w - 2 * padX), innerH = Math.max(0, h - 2 * padY);
  const px = (t: number) => padX + (dt > 0 ? (t - first.t) / dt : 1) * innerW;
  const py = (v: number) => (span > 0 ? padY + (1 - (v - sLo) / span) * innerH : h / 2);
  const xs = points.map((p) => px(p.t)), ys = points.map((p) => py(p.usd));
  const zeroY = py(0);
  let line = `M${f1(xs[0])} ${f1(ys[0])}`;
  for (let i = 1; i < points.length; i++) line += `H${f1(xs[i])}V${f1(ys[i])}`;
  const area = `${line}V${f1(zeroY)}H${f1(xs[0])}Z`;
  return { w, h, xs, ys, line, area, zeroY, lo, hi, loI, hiI, first, last, tone: Math.abs(last.usd) < 0.005 ? "none" : last.usd > 0 ? "up" : "down" };
}

/// The point a pointer at pixel `x` reads: the last one at or left of it (the value of the step there), the first
/// point when the pointer is left of them all. -1 for no points.
export function pointAt(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1;
  let i = 0;
  // half a pixel of grace, so the last point is reached at the right edge
  for (let k = 1; k < xs.length; k++) { if (xs[k] <= x + 0.5) i = k; else break; }
  return i;
}
