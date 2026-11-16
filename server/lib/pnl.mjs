// Profit and loss of one wallet from its own trades: pure maths, no clock, no database, no network.
//
// Everything is counted in the coin's QUOTE units (lamports for a coin quoted in SOL, the parent's
// smallest units for a child) with exact BigInt sums; nothing here knows a USD price. The method is
// average cost: a buy adds its base and its quote to the position, a sell takes out the position's
// cost in proportion to the base it sells and realizes (proceeds − that cost).
//
// A wallet can sell more than its recorded buys: tokens transferred in, or buys older than the history
// that was read. The cost of that part is unknown, so only the explained part of such a sell is
// realized (its proceeds in proportion), the rest is left out of the profit and the coin is flagged
// `partial`. The sold sums still count the whole sell.
//
// `since` (unix seconds) gives a window: sums, counts and realized profit cover the trades at or after
// it, while the cost basis is always built from the whole history (a sell this week is measured
// against buys from last month). `heldBase`, `costQuote`, `partial`, `firstAt` and `lastAt` are not
// windowed. The quote amount of a trade is what the wallet paid (a buy) or received (a sell), the venue's fees included
// (lib/decode.mjs `userQuoteAmount`), so the profit is the wallet's own; the network fee and tips are not in it.

/**
 * Trade order: time, then slot, then `ord` (the place of the trade's transaction among the wallet's transactions of that
 * slot, as the chain ran them: lib/pnl-tracker.mjs), then the event's index in its transaction. The signature only makes
 * the order of rows without an `ord` repeatable; it says nothing about which ran first.
 */
export const byTradeOrder = (a, b) => a.time - b.time || (a.slot ?? 0) - (b.slot ?? 0) || (a.ord ?? 0) - (b.ord ?? 0) || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0) || (a.idx ?? 0) - (b.idx ?? 0);

const big = (v) => { try { const n = BigInt(v ?? 0); return n > 0n ? n : 0n; } catch { return 0n; } };

export function blankEntry() {
  return { boughtBase: 0n, boughtQuote: 0n, soldBase: 0n, soldQuote: 0n, realizedQuote: 0n, costQuote: 0n, heldBase: 0n, partial: false, buys: 0, sells: 0, firstAt: null, lastAt: null };
}

/** Applies one trade (in trade order) to a coin's running entry. */
export function applyTrade(e, t, since = 0) {
  const base = big(t.baseAmount), quote = big(t.quoteAmount), inWindow = t.time >= since;
  if (e.firstAt == null || t.time < e.firstAt) e.firstAt = t.time;
  if (e.lastAt == null || t.time > e.lastAt) e.lastAt = t.time;
  if (t.isBuy) {
    e.heldBase += base; e.costQuote += quote;
    if (inWindow) { e.boughtBase += base; e.boughtQuote += quote; e.buys++; }
    return e;
  }
  const explained = base < e.heldBase ? base : e.heldBase;
  if (explained < base) e.partial = true;
  // The cost leaving the position: all of it when the position closes (no rounding dust left behind), else its share.
  const cost = explained === e.heldBase ? e.costQuote : (e.costQuote * explained) / e.heldBase;
  const proceeds = base === 0n ? 0n : explained === base ? quote : (quote * explained) / base;
  e.heldBase -= explained; e.costQuote -= cost;
  if (inWindow) { e.soldBase += base; e.soldQuote += quote; e.sells++; if (explained > 0n) e.realizedQuote += proceeds - cost; }
  return e;
}

/**
 * Per-coin profit and loss of a list of trades `{ mint, time, isBuy, baseAmount, quoteAmount }` given
 * in trade order (byTradeOrder): `Map<mint, entry>` with BigInt amounts. A coin without a trade in
 * the window and without a remaining position is left out.
 */
export function pnlOfTrades(trades, { since = 0 } = {}) {
  const all = new Map();
  for (const t of trades) {
    let e = all.get(t.mint);
    if (!e) all.set(t.mint, (e = blankEntry()));
    applyTrade(e, t, since);
  }
  return listed(all);
}
/** The entries worth listing: a trade in the window, or a position still held. */
export function listed(all) {
  const out = new Map();
  for (const [mint, e] of all) if (e.buys + e.sells > 0 || e.heldBase > 0n) out.set(mint, e);
  return out;
}

/** Smallest units → a float amount (for a USD estimate only; the exact value stays in the string). */
export const unitsOf = (amount, decimals) => Number(amount) / 10 ** decimals;

/** A quote amount at the quote's price now, null when the quote has no price. */
export const usdNow = (amount, decimals, quoteUsd) => (quoteUsd != null && Number.isFinite(quoteUsd) ? unitsOf(amount, decimals) * quoteUsd : null);

// ---------------------------------------------------------------- realized profit over time
/** The most points a series has, its first and last included. */
export const SERIES_MAX_POINTS = 240;

/**
 * A wallet's cumulative realized profit over time, in USD at today's quote prices (the conversion of usdNow).
 * Fed trade by trade in trade order, every coin together:
 *   const s = seriesStart(since); for (const t of trades) seriesApply(s, t); const { points, unpriced } = seriesEnd(s, { at, priceOf });
 * so a caller can read its rows in slices. The cost basis comes from the whole history, the window only decides which
 * sells count (applyTrade's `since`); a sell whose cost is unknown adds nothing, as in pnlOfTrades.
 */
export function seriesStart(since = 0) {
  return { since: since > 0 ? since : 0, all: new Map(), steps: [], firstAt: null, n: 0 };
}
/** Applies one trade; a sell that changes its coin's realized profit is remembered as a step `{ t, mint, realized }`. */
export function seriesApply(s, t) {
  let e = s.all.get(t.mint);
  if (!e) s.all.set(t.mint, (e = blankEntry()));
  const was = e.realizedQuote;
  applyTrade(e, t, s.since);
  s.n++;
  if (s.firstAt == null || t.time < s.firstAt) s.firstAt = t.time;
  if (e.realizedQuote !== was) s.steps.push({ t: t.time, mint: t.mint, realized: e.realizedQuote });
  return s;
}
/**
 * The series: `{ points: [{ t, usd }], unpriced }`.
 * `priceOf(mint)` → `{ decimals, usd }` of the coin's quote (usd null = the quote has no price now), or null for a coin
 * the index no longer holds (left out, as /api/pnl leaves it out). Coins without a price are skipped and counted in
 * `unpriced` (the listed ones, the count /api/pnl gives). No trade at all → no points. Otherwise:
 *   - the first point is `{ t: the window's start (the first trade's time when there is no window), usd: 0 }`;
 *   - then one point per sell that realized profit or loss, the running total after it; sells of one second are one
 *     point (the last value), and a sell at `at` is the last point;
 *   - the last point is `{ t: at, usd: the total }`, summed coin by coin exactly as /api/pnl sums `totals.realizedUsdNow`.
 * Times ascend (only the first two points can share one: a sell in the window's first second). More than `max` points:
 * the time from start to `at` is cut into equal slices and each keeps its last point.
 */
export function seriesEnd(s, { at, priceOf, max = SERIES_MAX_POINTS }) {
  if (!s.n) return { points: [], unpriced: 0 };
  const price = new Map();
  const of = (mint) => { let p = price.get(mint); if (p === undefined) price.set(mint, (p = priceOf(mint) ?? null)); return p; };
  const start = Math.min(s.since || s.firstAt, at);
  const per = new Map(); // mint → its realized profit in USD so far
  let total = 0, mid = [];
  for (const step of s.steps) {
    const p = of(step.mint);
    if (!p || p.usd == null || !Number.isFinite(p.usd)) continue;
    const usd = usdNow(step.realized, p.decimals, p.usd);
    total += usd - (per.get(step.mint) ?? 0); per.set(step.mint, usd);
    const t = Math.max(start, Math.min(step.t, at));
    if (mid.length && mid[mid.length - 1].t === t) mid[mid.length - 1].usd = total; else mid.push({ t, usd: total });
  }
  while (mid.length && mid[mid.length - 1].t >= at) mid.pop();
  // The total as /api/pnl sums it (coin by coin in first-trade order), so the two agree to the last bit.
  let final = 0, unpriced = 0;
  for (const [mint, e] of s.all) {
    const p = of(mint);
    if (!p) continue;
    if (p.usd == null || !Number.isFinite(p.usd)) { if (e.buys + e.sells > 0 || e.heldBase > 0n) unpriced++; continue; }
    final += usdNow(e.realizedQuote, p.decimals, p.usd);
  }
  const room = Math.max(1, max - 2);
  if (mid.length > room) {
    const span = Math.max(1, at - start), kept = new Array(room);
    for (const p of mid) kept[Math.min(room - 1, Math.floor(((p.t - start) * room) / span))] = p; // time ascending: the last of a slice wins
    mid = kept.filter(Boolean);
  }
  return { points: [{ t: start, usd: 0 }, ...mid, { t: at, usd: final }], unpriced };
}
/** The series of a list of trades in trade order (byTradeOrder): seriesStart, seriesApply and seriesEnd in one. */
export function realizedSeries(trades, { since = 0, at, priceOf, max = SERIES_MAX_POINTS }) {
  const s = seriesStart(since);
  for (const t of trades) seriesApply(s, t);
  return seriesEnd(s, { at, priceOf, max });
}
