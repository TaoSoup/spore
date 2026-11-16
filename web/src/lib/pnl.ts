// Profit and loss for the Portfolio page (pages/Portfolio.tsx): the per-coin answer of /api/pnl/:wallet joined with
// what the wallet holds now (/api/portfolio/:wallet).
// The server counts in each coin's QUOTE (SOL, or the parent's token) and converts at TODAY's price of that quote, so
// every dollar figure here is "at today's price of SOL / the parent coin"; network fees and tips are not counted.
// UNREALIZED: value of the tokens held now minus what they cost. The trades and the wallet can disagree (tokens sent
// in or out, or a history that was cut), so only the part both agree on is used: min(balance, heldBase), with the
// cost and the value scaled to it. A row is PARTIAL when the wallet holds more than the trades explain, or when the
// server says its trades are incomplete. Without a recorded cost there is no figure (null), never a zero.
// REALIZED: what the sells of the chosen period made (the server windows it). CLOSED: coins traded in the period
// that the wallet no longer holds, or holds only as dust.
// Pure: no React, no DOM, no fetches, so it runs under node:test (test/pnl.test.mts). Nothing here returns NaN or
// Infinity: a figure that cannot be worked out is null.
import type { Pnl, PnlCoin, PnlHistory } from "./api";
import { signedPct, usd } from "./format";

/// What the wallet holds of one coin (a row of /api/portfolio's `holdings` fits): raw units and the value in USD.
export type PnlHolding = { mint: string; amount: string; valueUsd: number | null };
/// An amount of a coin's quote in whole units, and in USD at today's price (null without one).
export type PnlAmount = { quote: number; usd: number | null };
/// Why a held coin has no unrealized figure: no buy of it is recorded, or a price is missing (the coin's or its quote's).
export type PnlGap = "no-cost" | "no-price";
/// One coin the wallet traded.
/// `held`: the wallet holds some now; `dust`: what it holds is worth less than the dust limit.
/// `balance` / `matched`: whole tokens held, and the part of them the trades explain (the part with a known cost).
/// `costUsd`, `avgCostUsd` (per token), `valueUsd`, `unrealizedUsd`, `unrealizedPct` (a ratio) are of the matched
/// part; all null when `gap` is set. `partial`: see the head of this file; it is about the unrealized figures.
/// `realizedPartial`: the server says some of the coin's sells or holdings have no recorded buy, so the realized figure
/// is approximate (tokens the wallet merely holds on top of its trades do not make it so).
/// `bought` / `sold` / `realizedUsd` / `realizedPct` / `buys` / `sells` are of the period asked for. `realizedUsd` is
/// null when nothing was sold in it, when the sells have no recorded buy, or without a price; `realizedPct` is the
/// profit over the cost of the tokens sold (null when that cost is unknown or zero).
export type PnlRow = {
  mint: string; coin: PnlCoin["coin"]; quoteMint: string | null; quoteSymbol: string; quoteUsd: number | null;
  held: boolean; dust: boolean; balance: number; matched: number; partial: boolean; realizedPartial: boolean; gap: PnlGap | null;
  costUsd: number | null; avgCostUsd: number | null; valueUsd: number | null; unrealizedUsd: number | null; unrealizedPct: number | null;
  bought: PnlAmount; sold: PnlAmount; realizedUsd: number | null; realizedPct: number | null;
  buys: number; sells: number; firstAt: number | null; lastAt: number | null;
};
/// `unrealizedUsd` / `unrealizedPct` / `costUsd`: over the `counted` held coins with a figure (null when none);
/// `partial` of them are approximate. Left out: `noCost` held coins without a recorded buy (coins the P&L answer does
/// not list included) and `unpriced` ones with a cost but no price.
/// `realizedUsd`: the period's sells over `realizedCoins` coins; `realizedPartial` of them are approximate and
/// `realizedLeftOut` coins were sold but have no figure. It is null (unknown, not zero) when coins were sold and none
/// of them has a figure; 0 when nothing was sold.
export type PnlTotals = {
  unrealizedUsd: number | null; unrealizedPct: number | null; costUsd: number; counted: number; partial: number; noCost: number; unpriced: number;
  realizedUsd: number | null; realizedCoins: number; realizedPartial: number; realizedLeftOut: number;
};
/// `byMint`: every coin of the answer. `closed`: traded in the period and no longer held (or only dust), latest trade
/// first. `since`: the period's start (unix s), null = everything.
export type PnlView = { byMint: Map<string, PnlRow>; closed: PnlRow[]; totals: PnlTotals; since: number | null };

const fin = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
const big = (s: string | null | undefined): bigint => { try { return BigInt(s ?? "0"); } catch { return 0n; } };
const pow10 = (d: number) => 10 ** (Number.isInteger(d) && d >= 0 && d <= 30 ? d : 0);
const whole = (raw: bigint, decimals: number) => Number(raw) / pow10(decimals);
/// a / b as a number, null when b is zero or the result is not a number.
const div = (a: number, b: number): number | null => (b === 0 ? null : fin(a / b));
const quoteKey = (mint: string | null) => mint ?? "SOL";
const DUST_USD = 1;

/// True when the answer carries P&L: the store answered and the server tracks this wallet's trades.
export const pnlAvailable = (pnl: Pnl | null | undefined): pnl is Pnl & { history: PnlHistory } =>
  !!pnl && pnl.ok !== false && !!pnl.history && pnl.history.state !== "full" && pnl.history.state !== "off";

/// Today's USD price of each quote, by quote mint ("SOL" for SOL): what the answer's own USD figures imply, else a
/// price the page knows (`known`: [mint or null for SOL, price]). A quote without either is left out.
export function quotePrices(pnl: Pnl | null | undefined, known: Iterable<readonly [string | null, number | null | undefined]> = []): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of pnl?.coins ?? []) {
    const k = quoteKey(c.quoteMint);
    if (out.has(k)) continue;
    const cost = whole(big(c.costQuote), c.quoteDecimals), real = whole(big(c.realizedQuote), c.quoteDecimals);
    const p = (cost > 0 ? div(fin(c.costUsdNow) ?? 0, cost) : null) || (real !== 0 ? div(fin(c.realizedUsdNow) ?? 0, real) : null);
    if (p && p > 0) out.set(k, p);
  }
  for (const [mint, price] of known) { const p = fin(price); if (p && p > 0 && !out.has(quoteKey(mint))) out.set(quoteKey(mint), p); }
  return out;
}

function rowOf(c: PnlCoin, h: PnlHolding | undefined, prices: ReadonlyMap<string, number>, dustUsd: number): PnlRow {
  const quoteUsd = prices.get(quoteKey(c.quoteMint)) ?? null;
  const inQuote = (raw: bigint): PnlAmount => { const q = whole(raw, c.quoteDecimals); return { quote: fin(q) ?? 0, usd: quoteUsd === null ? null : fin(q * quoteUsd) }; };
  const balanceRaw = big(h?.amount), heldRaw = big(c.heldBase), costRaw = big(c.costQuote);
  const held = balanceRaw > 0n, value = held ? fin(h?.valueUsd) : null;
  const matchedRaw = balanceRaw < heldRaw ? balanceRaw : heldRaw;
  const balance = fin(whole(balanceRaw, c.baseDecimals)) ?? 0, matched = matchedRaw > 0n ? fin(whole(matchedRaw, c.baseDecimals)) ?? 0 : 0;

  // the cost of the matched part: the server's cost of `heldBase`, scaled when the wallet holds less than that
  let gap: PnlGap | null = null, costUsd: number | null = null, valueUsd: number | null = null;
  if (held) {
    const costAll = fin(c.costUsdNow) ?? (quoteUsd === null ? null : fin(whole(costRaw, c.quoteDecimals) * quoteUsd));
    if (matchedRaw <= 0n || costRaw <= 0n) gap = "no-cost";
    else if (costAll === null || value === null) gap = "no-price";
    else {
      costUsd = fin(costAll * (Number(matchedRaw) / Number(heldRaw)));
      valueUsd = fin(value * (Number(matchedRaw) / Number(balanceRaw)));
      if (costUsd === null || valueUsd === null) { gap = "no-price"; costUsd = valueUsd = null; }
    }
  }
  const unrealizedUsd = costUsd !== null && valueUsd !== null ? fin(valueUsd - costUsd) : null;

  const realRaw = big(c.realizedQuote), soldRaw = big(c.soldQuote);
  const sells = fin(c.sells) ?? 0, buys = fin(c.buys) ?? 0;
  // a sell of tokens without a recorded buy realizes nothing the server can count: no figure, not a zero. (`partial`
  // covers everything stored, not the period; a profit of exactly zero beside it is taken as "not counted": quote
  // amounts carry the venue's fees, so an explained sell practically never lands on zero to the smallest unit.)
  const realizedKnown = sells > 0 && !(c.partial && realRaw === 0n);
  const realizedUsd = !realizedKnown ? null : fin(c.realizedUsdNow) ?? (realRaw === 0n ? 0 : inQuote(realRaw).usd);
  // what the sold tokens had cost = what they brought in minus the profit; unknown when part of them has no buy
  const basisRaw = soldRaw - realRaw;
  const realizedPct = realizedKnown && !c.partial && basisRaw > 0n ? div(Number(realRaw), Number(basisRaw)) : null;

  return {
    mint: c.mint, coin: c.coin ?? { name: null, symbol: null, image: null }, quoteMint: c.quoteMint, quoteSymbol: c.quoteSymbol || (c.quoteMint ? "" : "SOL"), quoteUsd,
    held, dust: held && value !== null && value < dustUsd, balance, matched,
    partial: !!c.partial || balanceRaw > heldRaw, realizedPartial: !!c.partial, gap,
    costUsd, avgCostUsd: costUsd !== null && matched > 0 ? div(costUsd, matched) : null, valueUsd, unrealizedUsd,
    unrealizedPct: unrealizedUsd !== null && costUsd !== null && costUsd > 0 ? div(unrealizedUsd, costUsd) : null,
    bought: inQuote(big(c.boughtQuote)), sold: inQuote(soldRaw), realizedUsd, realizedPct,
    buys, sells, firstAt: fin(c.firstAt), lastAt: fin(c.lastAt),
  };
}

/// The P&L answer joined with the wallet's holdings. `quoteUsd`: prices the page knows (see quotePrices);
/// `dustUsd`: a holding worth less counts as closed (default $1). A null answer gives an empty view.
export function buildPnl(pnl: Pnl | null | undefined, holdings: readonly PnlHolding[] = [], opts: { quoteUsd?: Iterable<readonly [string | null, number | null | undefined]>; dustUsd?: number } = {}): PnlView {
  const dustUsd = opts.dustUsd ?? DUST_USD;
  const prices = quotePrices(pnl, opts.quoteUsd);
  const heldBy = new Map<string, PnlHolding>();
  for (const h of holdings) if (!heldBy.has(h.mint)) heldBy.set(h.mint, h);
  const byMint = new Map<string, PnlRow>();
  for (const c of pnl?.coins ?? []) if (!byMint.has(c.mint)) byMint.set(c.mint, rowOf(c, heldBy.get(c.mint), prices, dustUsd));

  const t: PnlTotals = { unrealizedUsd: null, unrealizedPct: null, costUsd: 0, counted: 0, partial: 0, noCost: 0, unpriced: 0, realizedUsd: 0, realizedCoins: 0, realizedPartial: 0, realizedLeftOut: 0 };
  let unrealized = 0, realized = 0;
  for (const h of heldBy.values()) {
    if (big(h.amount) <= 0n) continue;
    const r = byMint.get(h.mint);
    if (!r || r.gap === "no-cost") t.noCost++;
    else if (r.gap === "no-price" || r.unrealizedUsd === null || r.costUsd === null) t.unpriced++;
    else { unrealized += r.unrealizedUsd; t.costUsd += r.costUsd; t.counted++; if (r.partial) t.partial++; }
  }
  if (t.counted > 0) { t.unrealizedUsd = fin(unrealized); t.unrealizedPct = t.costUsd > 0 ? div(unrealized, t.costUsd) : null; }
  for (const r of byMint.values()) {
    if (r.sells <= 0) continue;
    if (r.realizedUsd === null) t.realizedLeftOut++;
    else { realized += r.realizedUsd; t.realizedCoins++; if (r.realizedPartial) t.realizedPartial++; }
  }
  t.realizedUsd = t.realizedCoins === 0 && t.realizedLeftOut > 0 ? null : fin(realized) ?? 0;
  const closed = [...byMint.values()].filter((r) => (!r.held || r.dust) && r.buys + r.sells > 0)
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || (a.mint < b.mint ? -1 : 1));
  return { byMint, closed, totals: t, since: fin(pnl?.since) };
}

/// The state of the wallet's trade history as one calm line, null when there is nothing to say. `own`: the wallet is
/// the reader's ("your trade history"), else "this wallet's".
export function historyLine(pnl: Pnl | null | undefined, own = true): string | null {
  if (!pnl) return null;
  const h = pnl.ok === false ? null : pnl.history;
  if (!h || h.state === "full" || h.state === "off") return "P&L is not available right now.";
  const n = (v: number) => Math.max(0, Math.round(fin(v) ?? 0)).toLocaleString("en-US");
  if (h.state === "queued" || h.state === "running") {
    const whose = own ? "your" : "this wallet's";
    return (fin(h.total) ?? 0) > 0 ? `Reading ${whose} trade history: ${n(Math.min(h.scanned, h.total))} of ${n(h.total)} transactions.` : `Reading ${whose} trade history…`;
  }
  if (h.state === "failed") return "Trade history could not be read just now; it is retried.";
  const parts: string[] = [];
  const since = fin(h.since);
  if (h.cut) parts.push(since !== null ? `Trades before ${new Date(since * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })} are not included.` : "The oldest trades are not included.");
  if ((fin(h.unread) ?? 0) > 0 || h.gap != null) parts.push("Some trades may be missing.");
  return parts.length ? parts.join(" ") : null;
}

/// True while the server is still reading the wallet's history (the page asks again sooner).
export const historyRunning = (pnl: Pnl | null | undefined) => !!pnl?.history && (pnl.history.state === "queued" || pnl.history.state === "running");

/// A profit or a loss in dollars: +$12.40 · −$3.10 · $0. An amount under a cent reads "≈ $0"; null reads "—".
export const signedUsd = (n: number | null | undefined): string => {
  const v = fin(n);
  if (v === null) return "—";
  if (v === 0) return "$0";
  if (Math.abs(v) < 0.01) return "≈ $0";
  return `${v > 0 ? "+" : "−"}${usd(Math.abs(v))}`;
};
/// The colour of a profit or a loss: "up", "down", or "none" for nothing, under a cent, or unknown.
export const pnlTone = (n: number | null | undefined): "up" | "down" | "none" => { const v = fin(n); return v === null || Math.abs(v) < 0.01 ? "none" : v > 0 ? "up" : "down"; };
/// A profit or a loss as a percent of its cost: signedPct, but a ratio that rounds to nothing reads "0.00%", never
/// "+0.00%" or "−0.00%".
export const pnlPct = (ratio: number | null | undefined): string => { const t = signedPct(ratio); return /^[+−]0\.00%$/.test(t) ? "0.00%" : t; };

/// A list of the wallet's trades as the Activity tab holds it: newest first, `next` the cursor of the page after (null
/// at the end), `tracked` as the server last said.
export type TradeList<T> = { trades: T[]; next: string | null; tracked: boolean };
/// A fresh first page merged into a list the reader has extended with "Load more" (or is extending): nothing loaded
/// is dropped, trades the list does not hold yet are added in time order, newest first. `expect`: how many trades
/// the list should hold when it is complete (0: not known). A list that had reached its end and now holds fewer gets
/// a cursor again, so trades stored later (the history read finds older ones) can be loaded: `before` takes a unix
/// second and answers the trades strictly older, hence the last row's second plus one (rows held already are skipped
/// by their key).
export function mergeFirstPage<T extends { time: number }>(cur: TradeList<T>, page: TradeList<T>, key: (t: T) => string, expect = 0): TradeList<T> {
  const seen = new Set(cur.trades.map(key));
  const fresh = page.trades.filter((t) => !seen.has(key(t)));
  const trades = fresh.length ? [...fresh, ...cur.trades].sort((a, b) => (fin(b.time) ?? 0) - (fin(a.time) ?? 0)) : cur.trades;
  const last = trades.length ? fin(trades[trades.length - 1].time) : null;
  const next = cur.next === null && last !== null && expect > trades.length ? String(Math.floor(last) + 1) : cur.next;
  return { trades, next, tracked: page.tracked };
}
/// A page loaded with "Load more" put after the list; rows the list holds already are skipped.
export function appendPage<T>(cur: TradeList<T>, page: { trades: T[]; next: string | null }, key: (t: T) => string): TradeList<T> {
  const seen = new Set(cur.trades.map(key));
  return { ...cur, trades: [...cur.trades, ...page.trades.filter((t) => !seen.has(key(t)))], next: page.next };
}
