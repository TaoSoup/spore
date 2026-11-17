// The price chart while the server reads a coin's missed trades back from the chain (the candles' `fill`: server
// lib/trade-fill.mjs). Kept apart from the component so the timing and the wording can be tested without a DOM.

/// Every 5 s for the first 36 asks (3 min), then every 30 s for as long as the server still answers with `fill`. A job
/// can outlast 3 min on the public RPC (300 calls per coin a run at 1 call a second), and a coin whose run stopped at a
/// cap is queued again only by the next ask, so the chart keeps asking; the server ends it (its caps answer without
/// `fill`).
export const FILL_POLL_MS = 5_000, FILL_POLLS = 36, FILL_POLL_SLOW_MS = 30_000;

/// The wait before ask number `n + 1` (`n` asks made so far).
export const fillPollDelay = (n: number): number => (n < FILL_POLLS ? FILL_POLL_MS : FILL_POLL_SLOW_MS);

/// The line of a chart with fewer than 2 candles: while missed trades are being read back it says so, not "no trades".
export function thinChartText(n: number, filling: boolean): string {
  if (filling) return "Reading missed trades from the chain…";
  return n === 0 ? "No trades yet — the chart starts with the first buy." : "Not enough price points yet — the chart fills in as trades land.";
}
