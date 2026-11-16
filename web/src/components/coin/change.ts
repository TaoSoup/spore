// The coin page's change figure and 24 h spark points, from hourly candles (api.candles(mint, 3600)). Shared by the
// coin bar, the phone bar and the parent card ("Priced in $PARENT"), so the coin and its parent read the same way.
import type { Candles } from "../../lib/api";
import { age } from "../../lib/format";

/// `label` names the basis in full ("· 24h", "since first trade (21h)"); `short` is the phone bar's ("24h", "21h").
export type Change = { ratio: number; label: string; short: string; title: string };
/// The price now, in the candles' two units (whichever the series is kept in).
export type PriceNow = { priceUsd: number | null; priceQuote: number | null };

/// The one change figure of a coin. From hourly candles: the close of the last candle that ended at least 24 h ago
/// ("· 24h"); when the series is younger, the first open ("since first trade (21h)").
export function change24h(rows: Candles["candles"], now: PriceNow, priceKey: Candles["priceKey"]): Change | null {
  if (!rows.length) return null;
  const cutoff = Math.floor(Date.now() / 1000) - 86_400;
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const ref = [...sorted].reverse().find((r) => r.t + 3600 <= cutoff);
  const current = (priceKey === "usd" ? now.priceUsd : now.priceQuote) ?? sorted[sorted.length - 1].c;
  if (ref && ref.c > 0) return { ratio: current / ref.c - 1, label: "· 24h", short: "24h", title: "Change over the last 24 hours (hourly candles)" };
  const first = sorted[0];
  if (first.o > 0 && sorted.length > 1) return { ratio: current / first.o - 1, label: `since first trade (${age(first.t)})`, short: age(first.t), title: `Change since the first trade the indexer saw, ${age(first.t)} ago` };
  return null;
}

/// The last day of hourly closes (the last 48 when the day holds fewer than two), ending on the live price so the
/// line's dot is the number beside it. null when there is nothing to draw (never a flat stand-in).
export function daySpark(daily: Candles | null | undefined, now: PriceNow): number[] | null {
  if (!daily?.candles.length) return null;
  const at = Date.now() / 1000;
  const rows = [...daily.candles].sort((a, b) => a.t - b.t);
  const day = rows.filter((r) => r.t >= at - 86_400);
  const use = day.length >= 2 ? day : rows.slice(-48);
  const live = daily.priceKey === "usd" ? now.priceUsd : now.priceQuote;
  const pts = use.map((r) => r.c).filter((v) => Number.isFinite(v) && v > 0);
  if (live != null && Number.isFinite(live) && live > 0) pts.push(live);
  return pts.length >= 2 ? pts : null;
}

/// "up 5.6% in 24 h" / "down 12% since 21h" / "flat over 24 h", for accessible names.
export function changeWords(c: Change | null): string {
  if (!c) return "";
  const basis = c.short === "24h" ? "in 24 h" : `since ${c.short} ago`;
  const p = Math.abs(c.ratio * 100);
  const n = p >= 100 ? p.toFixed(0) : p >= 10 ? p.toFixed(1) : p.toFixed(2);
  return c.ratio > 0.0005 ? `up ${n}% ${basis}` : c.ratio < -0.0005 ? `down ${n}% ${basis}` : `flat ${basis}`;
}
