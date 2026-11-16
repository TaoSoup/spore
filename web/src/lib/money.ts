// One money vocabulary for the Portfolio page (pages/Portfolio.tsx): every dollar figure can be read in dollars or in
// SOL at the current SOL price. The page keeps its figures in USD and formats them through ONE helper, `money()`, made
// by makeMoney(unit, solUsd); percentages, token amounts and a coin's own price are not money and never pass here.
// Without a usable SOL price the unit falls back to USD (`can` is false and the page disables its switch).
// Pure: no React, no DOM, so it runs under node:test (test/money.test.mts). Nothing here returns "NaN": a figure that
// cannot be worked out reads "—".
import { amount, sol, usd, usdCard } from "./format";
import { signedUsd } from "./pnl";

export type MoneyUnit = "usd" | "sol";
export const MONEY_UNITS: readonly MoneyUnit[] = ["usd", "sol"];
/// `signed`: a profit or a loss ("+", "−", "≈" under a cent). `card`: a tile or a row, where dust reads "< …" instead
/// of a subscript figure. `signed` wins over `card`.
export type MoneyOpts = { signed?: boolean; card?: boolean };
/// `unit`: the unit in use (USD when SOL was asked for without a price). `can`: SOL can be shown. `money`: a USD
/// figure in the unit in use. `other`: the same figure in the other unit, null when there is no SOL price.
/// `toUnit`: the bare number in the unit in use, null when it is not a number.
export type Money = {
  unit: MoneyUnit; can: boolean; solUsd: number | null;
  money: (usdValue: number | null | undefined, opts?: MoneyOpts) => string;
  other: (usdValue: number | null | undefined, opts?: MoneyOpts) => string | null;
  toUnit: (usdValue: number | null | undefined) => number | null;
};

const fin = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
/// A SOL price that can convert: finite and above zero.
export const solPrice = (solUsd: number | null | undefined): number | null => { const p = fin(solUsd); return p !== null && p > 0 ? p : null; };
/// The unit a page can really use: SOL only with a price.
export const moneyUnit = (unit: MoneyUnit, solUsd: number | null | undefined): MoneyUnit => (unit === "sol" && solPrice(solUsd) !== null ? "sol" : "usd");

/// A positive SOL amount: sol() under 1,000 (4 dp under 1, a subscript for dust), compact above (12.4K SOL).
const solText = (v: number): string => (v >= 1000 ? amount(v, "SOL") : sol(v));

/// A USD figure as text in `unit`, converted at `solUsd`. USD: usd() / usdCard() / signedUsd(). SOL mirrors them:
/// "0 SOL" · "1.25 SOL" · "< 0.0001 SOL" (card) · "+0.5000 SOL" · "−2.10 SOL" · "≈ 0 SOL" (signed and under a cent:
/// the same threshold as in dollars, so a figure is "about nothing" in both units or in neither).
export function formatMoney(usdValue: number | null | undefined, unit: MoneyUnit, solUsd: number | null | undefined, opts: MoneyOpts = {}): string {
  const v = fin(usdValue);
  if (v === null) return "—";
  const p = solPrice(solUsd);
  if (unit !== "sol" || p === null) return opts.signed ? signedUsd(v) : opts.card ? usdCard(v) : usd(v);
  const s = v / p;
  if (v === 0 || s === 0) return "0 SOL";
  if (opts.signed) return Math.abs(v) < 0.01 ? "≈ 0 SOL" : `${v > 0 ? "+" : "−"}${solText(Math.abs(s))}`;
  if (s < 0) return `-${solText(-s)}`;
  if (opts.card && s < 0.0001) return "< 0.0001 SOL";
  return solText(s);
}

/// The page's formatter for the unit chosen and the SOL price known now.
export function makeMoney(unit: MoneyUnit, solUsd: number | null | undefined): Money {
  const p = solPrice(solUsd), u = moneyUnit(unit, p);
  return {
    unit: u, can: p !== null, solUsd: p,
    money: (x, opts) => formatMoney(x, u, p, opts),
    other: (x, opts) => (p === null ? null : formatMoney(x, u === "sol" ? "usd" : "sol", p, opts)),
    toUnit: (x) => { const v = fin(x); return v === null ? null : u === "sol" && p !== null ? fin(v / p) : v; },
  };
}
