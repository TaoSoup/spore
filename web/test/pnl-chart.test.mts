// The realized P&L chart's geometry (web/src/lib/pnl-chart.ts): the points of /api/pnl/:wallet/series cleaned and laid
// out as one step line on a scale that always holds zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChartGeo } from "../src/lib/pnl-chart.ts";
const { chartGeo, hasSeries, pointAt, seriesPoints } = await import("../src/lib/pnl-chart.ts");

const W = 600, H = 140, PX = 6, PY = 12;
const T0 = 1_800_000_000;
const pts = (...usd: number[]) => usd.map((v, i) => ({ t: T0 + i * 3600, usd: v }));
const geo = (g: ChartGeo | null): ChartGeo => { assert.ok(g, "geometry"); return g; };
const allFinite = (g: ChartGeo) => {
  for (const n of [...g.xs, ...g.ys, g.zeroY, g.lo, g.hi]) assert.ok(Number.isFinite(n), `not finite: ${n}`);
  assert.ok(!/NaN|Infinity/.test(g.line + g.area), "path holds NaN");
};

test("seriesPoints keeps finite rows, time ascending", () => {
  const raw = [{ t: 30, usd: 3 }, { t: 10, usd: 0 }, null, { t: "20", usd: 1 }, { t: 20, usd: NaN }, { t: 20, usd: 2 }, { usd: 5 }, { t: 30, usd: 4 }];
  assert.deepEqual(seriesPoints(raw), [{ t: 10, usd: 0 }, { t: 20, usd: 2 }, { t: 30, usd: 3 }, { t: 30, usd: 4 }]);
  for (const bad of [null, undefined, "x", 5, {}]) assert.deepEqual(seriesPoints(bad), []);
});

test("a single point, or none, has no geometry and is not a series", () => {
  assert.equal(chartGeo([], W, H), null);
  assert.equal(chartGeo(pts(5), W, H), null);
  assert.equal(hasSeries([]), false);
  assert.equal(hasSeries(pts(5)), false);
  assert.equal(chartGeo(pts(0, 5), 0, H), null);
  assert.equal(chartGeo(pts(0, 5), W, NaN), null);
});

test("a rising series: zero at the bottom, the last point at the top right, tone up", () => {
  const g = geo(chartGeo(pts(0, 10, 25), W, H, PX, PY));
  allFinite(g);
  assert.equal(g.tone, "up");
  assert.equal(g.zeroY, H - PY);
  assert.equal(g.ys[0], H - PY);
  assert.equal(g.ys[2], PY);
  assert.equal(g.xs[0], PX);
  assert.equal(g.xs[2], W - PX);
  assert.equal(g.xs[1], W / 2);
  assert.deepEqual([g.lo, g.hi, g.loI, g.hiI], [0, 25, 0, 2]);
  // a step: level to the next point's time, then up or down to its value
  assert.equal(g.line, "M6.0 128.0H300.0V81.6H594.0V12.0");
  assert.ok(g.area.startsWith(g.line) && g.area.endsWith("V128.0H6.0Z"));
});

test("a series that crosses zero keeps the zero line between its low and its high", () => {
  const g = geo(chartGeo(pts(0, 30, -10, -5), W, H, PX, PY));
  allFinite(g);
  assert.equal(g.tone, "down");
  assert.deepEqual([g.lo, g.hi, g.loI, g.hiI], [-10, 30, 2, 1]);
  assert.equal(g.ys[1], PY);
  assert.equal(g.ys[2], H - PY);
  assert.ok(g.zeroY > g.ys[1] && g.zeroY < g.ys[2], "zero lies between the high and the low");
  assert.equal(g.zeroY, g.ys[0]);
  // zero is three quarters of the way down a scale from 30 to -10
  assert.ok(Math.abs(g.zeroY - (PY + 0.75 * (H - 2 * PY))) < 1e-9);
});

test("a loss only: zero at the top, tone down", () => {
  const g = geo(chartGeo(pts(0, -4, -8), W, H, PX, PY));
  assert.equal(g.tone, "down");
  assert.equal(g.zeroY, PY);
  assert.equal(g.ys[2], H - PY);
});

test("a level series sits on the middle of the box and is not worth drawing", () => {
  const flat = pts(0, 0, 0);
  const g = geo(chartGeo(flat, W, H, PX, PY));
  allFinite(g);
  assert.equal(g.tone, "none");
  assert.deepEqual(g.ys, [H / 2, H / 2, H / 2]);
  assert.equal(g.zeroY, H / 2);
  assert.equal(hasSeries(flat), false);
  assert.equal(hasSeries(pts(0, 0.004)), false);
  assert.equal(hasSeries(pts(0, 0.01)), true);
  assert.equal(hasSeries(pts(0, -3, 0)), true);
});

test("ends at zero after a move: tone none, still a series", () => {
  const g = geo(chartGeo(pts(0, 12, 0), W, H));
  assert.equal(g.tone, "none");
  assert.equal(hasSeries(pts(0, 12, 0)), true);
});

test("points of one moment do not divide by zero", () => {
  const g = geo(chartGeo([{ t: T0, usd: 0 }, { t: T0, usd: 7 }], W, H, PX, PY));
  allFinite(g);
  assert.deepEqual(g.xs, [W - PX, W - PX]);
});

test("a box smaller than its padding stays finite", () => {
  allFinite(geo(chartGeo(pts(0, 5, -5), 8, 8, PX, PY)));
});

test("pointAt reads the step under the pointer", () => {
  const xs = [6, 300, 594];
  assert.equal(pointAt([], 10), -1);
  assert.equal(pointAt(xs, -50), 0);
  assert.equal(pointAt(xs, 6), 0);
  assert.equal(pointAt(xs, 299), 0);
  assert.equal(pointAt(xs, 300), 1);
  assert.equal(pointAt(xs, 593), 1);
  assert.equal(pointAt(xs, 593.6), 2);
  assert.equal(pointAt(xs, 9999), 2);
  // points that share a pixel: the latest of them
  assert.equal(pointAt([6, 300, 300, 594], 300), 2);
});
