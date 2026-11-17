// The price chart while the server reads a coin's missed trades back from the chain (the candles' `fill`: server
// lib/trade-fill.mjs) or its earlier history (the candles' `history`: server lib/chart-history.mjs). Kept apart from
// the component so the timing and the wording can be tested without a DOM.

/// Every 5 s for the first 36 asks (3 min), then every 30 s for as long as the server still answers with `fill`. A job
/// can outlast 3 min on the public RPC (300 calls per coin a run at 1 call a second), and a coin whose run stopped at a
/// cap is queued again only by the next ask, so the chart keeps asking; the server ends it (its caps answer without
/// `fill`).
export const FILL_POLL_MS = 5_000, FILL_POLLS = 36, FILL_POLL_SLOW_MS = 30_000;

/// The wait before ask number `n + 1` (`n` asks made so far).
export const fillPollDelay = (n: number): number => (n < FILL_POLLS ? FILL_POLL_MS : FILL_POLL_SLOW_MS);

/// Whether the server is still reading this chart's earlier history.
export const historyPending = (h?: { state: string } | null): boolean => !!h && (h.state === "loading" || h.state === "sampling");

/// What the chart waits for, as a key that changes when an answer moves on (null = nothing pending): the poll applies
/// an answer only when its key differs from the shown one, so the view refits at most a few times, never every 5 s.
export function pendingOf(d: { fill?: unknown; history?: { state: string } | null }): string | null {
  const f = !!d.fill, h = historyPending(d.history) ? d.history!.state : "";
  return f || h ? `${f ? "fill" : ""}|${h}` : null;
}

/// GeckoTerminal's page of the pool whose candles the chart shows before the server's first stored trade (the credit).
export const geckoPoolUrl = (pool: string) => `https://www.geckoterminal.com/solana/pools/${pool}`;

/// The line of a chart with fewer than 2 candles: while missed trades or earlier history are being read it says so,
/// not "no trades".
export function thinChartText(n: number, filling: boolean, history = false): string {
  if (filling) return "Reading missed trades from the chain…";
  if (history) return "Reading this coin's earlier history…";
  return n === 0 ? "No trades yet — the chart starts with the first buy." : "Not enough price points yet — the chart fills in as trades land.";
}

/// The screen-reader summary's note for sampled chain prices among the rows (`s`), wherever they fall: after
/// GeckoTerminal's candles, before ours, or the newest part of a coin with no stored trade. Empty without any.
export const sampledSummary = (rows: readonly { s?: 1 }[]): string => (rows.some((c) => c.s) ? ", some prices sampled from the chain" : "");

/// Which series carries the last-value label and price line: the line ("area") when the newest row is a sampled price
/// (the candle series has no bar there, only whitespace), else the candles, whose label takes the up/down colour.
export const lastMarkOn = (rows: readonly { s?: 1 }[]): "area" | "candles" => (rows[rows.length - 1]?.s ? "area" : "candles");

type Row = { t: number; o: number; h: number; l: number; c: number; v: number; s?: 1 };
/// The row a live trade (price `p`, volume `v`, in bucket `bucket`) makes of the newest row `last`: `last` extended, or a
/// new row after it; null when the trade is older than `last` (the server's re-read places it). A sampled row (`s`)
/// becomes a real candle opened at its price: the bucket now has a trade with a high, a low and a volume.
export function liveCandle(last: Row, bucket: number, p: number, v: number): Row | null {
  if (bucket === last.t) { const { s: _s, ...rest } = last; return { ...rest, h: Math.max(last.h, p), l: Math.min(last.l, p), c: p, v: last.v + v }; }
  if (bucket > last.t) return { t: bucket, o: last.c, h: Math.max(last.c, p), l: Math.min(last.c, p), c: p, v };
  return null;
}
