// Candles: our own trades bucketed (buildCandles, what /api/candles has always answered) and the pure pieces of the
// chart history (lib/chart-history.mjs): GeckoTerminal's OHLCV pages checked and normalised, the two venues of a
// graduated coin combined, the seam check of their closes against ours, where the history still has a hole, which
// signatures of a stretch to sample, and the merge of all of it with our own candles. No I/O here: every function is
// a function of its arguments, so each rule is tested on its own (test/candles.test.mjs).

/**
 * The least stretch (s) without GeckoTerminal candles before our first stored trade that counts as a hole worth
 * sampling from the chain at resolution `R`: three candles, and never under 30 minutes (a quiet half hour is not
 * worth a listing).
 */
export const HIST_HOLE_MIN = (R) => Math.max(3 * R, 1_800);

/** Trades → OHLC candles of `res` seconds; USD when every trade has a USD price, else quote units. */
export function buildCandles(trades, res) {
  const usd = trades.length > 0 && trades.every((t) => t.priceUsd != null);
  const key = usd ? "priceUsd" : "priceQuote";
  const buckets = new Map();
  for (const t of trades) {
    const bucket = Math.floor(t.time / res) * res;
    const price = t[key];
    const vol = usd ? (t.valueUsd ?? 0) : Number(BigInt(t.quoteAmount));
    const c = buckets.get(bucket);
    if (!c) buckets.set(bucket, { t: bucket, o: price, h: price, l: price, c: price, v: vol });
    else { c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.v += vol; }
  }
  return { candles: [...buckets.values()].sort((a, b) => a.t - b.t), priceKey: usd ? "usd" : "quote" };
}

/** Buckets in the chart's window: the newest window (the route's read from now − 500 R) and every older page. */
export const HIST_BUCKETS = 500;

/**
 * `buildCandles` with the price key forced (an older page of the coin page's chart is always in the newest window's
 * key, never converted): `{ candles, priceKey: key, unpriced }`. `usd`: trades without a USD price are left out and
 * counted (`unpriced`), volume `valueUsd ?? 0`; `quote`: every trade, volume in quote atoms (as buildCandles).
 */
export function buildCandlesKeyed(trades, res, key) {
  const usd = key === "usd", buckets = new Map();
  let unpriced = 0;
  for (const t of trades) {
    if (usd && t.priceUsd == null) { unpriced++; continue; }
    const bucket = Math.floor(t.time / res) * res;
    const price = usd ? t.priceUsd : t.priceQuote;
    const vol = usd ? (t.valueUsd ?? 0) : Number(BigInt(t.quoteAmount));
    const c = buckets.get(bucket);
    if (!c) buckets.set(bucket, { t: bucket, o: price, h: price, l: price, c: price, v: vol });
    else { c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.v += vol; }
  }
  return { candles: [...buckets.values()].sort((a, b) => a.t - b.t), priceKey: key, unpriced };
}

/** The rows of one page: `from <= t < hi` (the page answers authoritatively for that stretch, and pages never overlap). */
export const clipPage = (candles, from, hi) => candles.filter((c) => c.t >= from && c.t < hi);

/**
 * Where the page below `lo` starts (its `before`), or null when nothing is older: the largest of our newest stored trade
 * before `lo` (its bucket + R), GeckoTerminal's newest stored candle before `lo` (t + R), the row's `covFrom` when
 * GeckoTerminal was not asked down to the coin's start yet (`!gtFloor`, `covFrom > (cLo ?? 0)`: an unknown stretch lies
 * below it) and the newest chain point before `lo` (its bucket + R). Never above `lo`; null at or below the coin's
 * creation bucket `cLo`.
 */
export function pageNext({ lo, cLo = null, ownOlderT = null, gt = [], gtFloor = true, covFrom = null, pts = [], R }) {
  const bucket = (t) => Math.floor(t / R) * R;
  let next = -Infinity;
  if (ownOlderT != null) next = Math.max(next, bucket(ownOlderT) + R);
  for (let i = gt.length - 1; i >= 0; i--) if (gt[i].t < lo) { next = Math.max(next, gt[i].t + R); break; }
  if (!gtFloor && covFrom != null && covFrom > (cLo ?? 0)) next = Math.max(next, covFrom);
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i][0] < lo) { next = Math.max(next, bucket(pts[i][0]) + R); break; }
  if (!Number.isFinite(next)) return null;
  next = Math.min(next, lo);
  return cLo != null && next <= cLo ? null : next;
}

/** GeckoTerminal's timeframe and aggregate for a chart resolution (s); null for one it has no candles of. */
export function timeframeOf(R) {
  switch (R) {
    case 60: return { tf: "minute", agg: 1 };
    case 300: return { tf: "minute", agg: 5 };
    case 900: return { tf: "minute", agg: 15 };
    case 3600: return { tf: "hour", agg: 1 };
    default: return null;
  }
}

/** 8 significant digits: a stored row is about 40 bytes a candle, and a price this close is as good as the source's. */
const r8 = (x) => Number(x.toPrecision(8));

/**
 * One GeckoTerminal OHLCV page (`ohlcv_list` as sent: `[t, o, h, l, c, v]` rows, newest first) → our candles
 * `{ t, o, h, l, c, v }`, oldest first, for buckets `lo ≤ t ≤ top` only (a newer candle is not final and is never
 * stored). A row that is not six finite numbers, has a price ≤ 0 or a volume < 0 is bad; more than 10 % bad rejects the
 * page (null: something is off with the source, not with one candle). Times are floored to the resolution (`unaligned`
 * counts the ones that were not), rows of one bucket merged (the first's open, the last's close), h/l repaired to hold
 * the open and close, and `v` scaled by `scaleV` (10^decimals of the quote for `currency=token`, whose volume comes in
 * whole quote tokens: ours is in atoms).
 */
export function parseOhlcv(list, { R, lo, top, scaleV = 1 }) {
  if (!Array.isArray(list)) return null;
  let bad = 0, unaligned = 0;
  const total = list.length, byT = new Map();
  // Oldest first, so a bucket's open is its earliest row's and its close the latest's.
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i];
    if (!Array.isArray(row) || row.length !== 6 || !row.every((x) => typeof x === "number" && Number.isFinite(x))) { bad++; continue; }
    const [t0, o, h0, l0, c, v] = row;
    if (!(o > 0 && h0 > 0 && l0 > 0 && c > 0) || v < 0) { bad++; continue; }
    const t = Math.floor(t0 / R) * R;
    if (t !== t0) unaligned++;
    if (t < lo || t > top) continue;
    const h = Math.max(o, h0, c), l = Math.min(o, l0, c);
    const prev = byT.get(t);
    if (!prev) byT.set(t, { t, o, h, l, c, v });
    else { prev.h = Math.max(prev.h, h); prev.l = Math.min(prev.l, l); prev.c = c; prev.v += v; }
  }
  if (bad > 0.1 * total) return null;
  const candles = [...byT.values()].sort((a, b) => a.t - b.t)
    .map((x) => ({ t: x.t, o: r8(x.o), h: r8(x.h), l: r8(x.l), c: r8(x.c), v: r8(x.v * scaleV) }));
  return { candles, bad, total, unaligned };
}

/**
 * A graduated coin's two venues in one series (both oldest first): in a bucket both traded in (the migration's), the
 * open is the curve's (it traded first), the close the pool's, h/l the widest, and the volumes add up (different trades
 * on different venues). Every other bucket is taken as it is.
 */
export function combineVenues(pool, curve) {
  const byT = new Map(curve.map((c) => [c.t, { ...c }]));
  for (const p of pool) {
    const c = byT.get(p.t);
    if (!c) byT.set(p.t, { ...p });
    else byT.set(p.t, { t: p.t, o: c.o, h: Math.max(c.h, p.h), l: Math.min(c.l, p.l), c: p.c, v: c.v + p.v });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * The closes of GeckoTerminal and ours in the buckets both have (the newest 12 at most, ours with a close > 0):
 * `{ n, abs, ln }`, `abs` the median of |ln(gt / ours)| and `ln` the median of ln(gt / ours) (its sign and size tell a
 * decimals error: ±ln(10^k)).
 */
export function seamStats(gt, own) {
  const ours = new Map(own.filter((c) => c.c > 0).map((c) => [c.t, c.c]));
  const r = [];
  for (let i = gt.length - 1; i >= 0 && r.length < 12; i--) {
    const o = ours.get(gt[i].t);
    if (o != null && gt[i].c > 0) r.push(Math.log(gt[i].c / o));
  }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return { n: r.length, abs: r.length ? med(r.map(Math.abs)) : null, ln: r.length ? med(r) : null };
}

/**
 * Whether GeckoTerminal's candles are the same series as ours where both have one: "ok" (median close within 15 %),
 * "mismatch" (off by 2× or more: another unit, other decimals, another pool), "warn" (in between: served, counted),
 * null with fewer than 3 shared buckets (no verdict).
 */
export function seamCheck(gt, own) {
  const s = seamStats(gt, own);
  if (s.n < 3) return null;
  return s.abs <= Math.log(1.15) ? "ok" : s.abs >= Math.log(2) ? "mismatch" : "warn";
}

/**
 * Where the history of one chart row still has a hole worth reading from the chain: `{ from }` (unix s) or null. `end`
 * is our first stored trade's bucket (`b0`), or now (floored to `R`) for a coin with no stored trade. GeckoTerminal
 * stopped before our data (its newest candle ends HIST_HOLE_MIN or more before `end`): from that end. GeckoTerminal has
 * nothing (a `none` or `mismatch` row, or no candle in it): from the coin's creation, or the 1 h chart's window when that
 * is later, so one sampling job serves every resolution. Gaps between GeckoTerminal candles and the stretch from the
 * creation to its first candle are not holes: quiet periods cannot be told from its misses without a listing, and the
 * chart squeezes missing time out anyway.
 */
export function holeOf(row, { lo, b0, R, W3600, createdAt, nowS }) {
  const end = b0 === Infinity ? Math.floor(nowS / R) * R : b0;
  const c = row?.state === "ok" && row.candles?.length ? row.candles : null;
  const gtEnd = c ? c[c.length - 1].t + R : -Infinity;
  if (gtEnd > lo) return end - gtEnd >= HIST_HOLE_MIN(R) ? { from: gtEnd } : null;
  return end - lo >= HIST_HOLE_MIN(R) ? { from: Math.max(W3600, createdAt ?? W3600) } : null;
}

/**
 * The signatures of a stretch to read when it holds more than `K` (`S` oldest first): the last of each of `K - 1`
 * slices of equal count, the oldest, and `forced` (signature strings: a migrated coin's last curve and first pool
 * signature), deduplicated, oldest first. Equal-count slices put more samples where trading was dense, and every pick
 * is a real trade's transaction (or one next to it). `S` itself when it holds `K` or fewer.
 */
export function pickSamples(S, K, forced = []) {
  const n = S.length;
  if (n <= K) return S.slice();
  const m = K - 1, at = new Set([0]);
  for (let j = 0; j < m; j++) at.add(Math.floor(((j + 1) * n) / m) - 1);
  const want = new Set(forced);
  if (want.size) S.forEach((s, i) => { if (want.has(s.signature)) at.add(i); });
  return [...at].filter((i) => i >= 0 && i < n).sort((a, b) => a - b).map((i) => S[i]);
}

/**
 * The candle of one bucket of chain points (`[time, priceQuote, priceUsd | null, quoteAtoms, exact 0|1]`, oldest
 * first) in the series key `key`: null when a USD series has a point without a USD price (the bucket is left out).
 * Every point exact (the stretch was read whole): a real candle, its volume the points' quote atoms (USD: each point's
 * atoms at its own USD per quote unit). Otherwise only the last price is known: a point (`s: 1`, o = h = l = c, no
 * volume), never made-up highs and lows.
 */
function pointCandle(t, ps, key, qd) {
  const price = (p) => (key === "usd" ? p[2] : p[1]);
  if (ps.some((p) => !(price(p) > 0))) return null;
  const c = price(ps[ps.length - 1]);
  if (!ps.every((p) => p[4] === 1)) return { t, o: c, h: c, l: c, c, v: 0, s: 1 };
  let h = -Infinity, l = Infinity, v = 0;
  for (const p of ps) {
    h = Math.max(h, price(p)); l = Math.min(l, price(p));
    v += key === "usd" ? (p[3] / 10 ** qd) * (p[2] / p[1]) : p[3];
  }
  return { t, o: price(ps[0]), h, l, c, v };
}

/**
 * The chart's candles with the history before our first stored trade `B` (bucket `b0`; `B` null = no stored trade,
 * everything is history) in the window from `lo`. Below `b0`: GeckoTerminal's candle where it has one; past its newest
 * candle (`gtEnd`), chain points (before `B`) as candles; else nothing. At `b0` (the seam) GeckoTerminal's closed candle
 * holds every trade of the bucket, ours only those from `B` on: its open, our close, the widest h/l and the larger
 * volume (never both: that would count our trades twice). From `b0 + R` on: ours only. `{ candles, gtShown, chain,
 * unpriced }`: whether a GeckoTerminal candle is in the answer (its credit), "sampled" | "exact" | null for chain
 * candles in it, and buckets of points left out for want of a USD price.
 */
export function mergeHistory({ own, gt, pts, key, R, lo, b0, B, qd }) {
  const out = [];
  let gtShown = false, sampled = false, exact = false, unpriced = 0;
  const gtAt = new Map(gt.map((c) => [c.t, c]));
  const gtEnd = gt.length ? gt[gt.length - 1].t + R : -Infinity;
  for (const g of gt) if (g.t >= lo && g.t < b0) { out.push({ t: g.t, o: g.o, h: g.h, l: g.l, c: g.c, v: g.v }); gtShown = true; }
  const buckets = new Map();
  for (const p of pts) {
    if (B != null && !(p[0] < B)) continue;
    const t = Math.floor(p[0] / R) * R;
    if (t < lo || t >= b0 || t < gtEnd || gtAt.has(t)) continue;
    let ps = buckets.get(t);
    if (!ps) buckets.set(t, (ps = []));
    ps.push(p);
  }
  for (const [t, ps] of buckets) {
    ps.sort((a, b) => a[0] - b[0]); // stable: points of one second keep their stored (slot, idx) order
    const c = pointCandle(t, ps, key, qd);
    if (!c) { unpriced++; continue; }
    if (c.s) sampled = true; else exact = true;
    out.push(c);
  }
  let seamDone = false;
  for (const c of own) {
    const g = c.t === b0 ? gtAt.get(b0) : null;
    if (g) { out.push({ t: c.t, o: g.o, h: Math.max(g.h, c.h), l: Math.min(g.l, c.l), c: c.c, v: Math.max(g.v, c.v) }); gtShown = true; seamDone = true; }
    else out.push(c);
  }
  // Ours always has the seam bucket (B is in it); kept for a caller whose own series starts later.
  if (!seamDone && Number.isFinite(b0) && gtAt.has(b0) && !own.some((c) => c.t === b0) && b0 >= lo) { const g = gtAt.get(b0); out.push({ t: g.t, o: g.o, h: g.h, l: g.l, c: g.c, v: g.v }); gtShown = true; }
  out.sort((a, b) => a.t - b.t);
  return { candles: out, gtShown, chain: sampled ? "sampled" : exact ? "exact" : null, unpriced };
}
