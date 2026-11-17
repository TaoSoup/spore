// The cost-based figures of "Your position" (YourPosition.tsx): Avg buy, Unrealized and Realized P&L from the joined row
// (lib/position.ts) and the P&L state. Apart from the card so they render under node:test (test/position.test.mts):
// no CSS, no hooks. The pragma gives tsx (the tests, which read the root tsconfig without `jsx`) the build's JSX runtime.
/** @jsxRuntime automatic */
import type { ReactNode } from "react";
import { usd } from "../../lib/format";
import { APPROX_NOTE, pnlPct, pnlTone, signedUsd, type PnlRow } from "../../lib/pnl";
import type { PnlState } from "../../lib/position";

const NO_BUY = "No buy of this coin is recorded for this wallet, so its cost is not known";
const NO_PRICE = "No price to value the cost with";
const SOLD_UNKNOWN = "Sold without a recorded buy, or without a price to value it with";
const WHY: Record<Exclude<PnlState, "ok">, string> = { loading: "Reading the trades", failed: "P&L could not be read just now", off: "P&L is not available right now", updating: "Updating after your trade" };

const BEHIND_NOTE = "Approximate: your latest trade of this coin is not counted in it yet";
/// A figure while a trade of this coin is not counted yet (lib/position.ts settleBehind) and nothing of it is known.
const NOT_YET: Fig = { text: "—", sub: "not counted yet", title: BEHIND_NOTE };

/// The small "~" before an approximate figure: tokens without a recorded buy left out (as the Portfolio's), or the
/// latest trade not counted yet.
const Mark = ({ title = APPROX_NOTE }: { title?: string }) => <span className="pos-approx" title={title}>~<span className="sr-only">approximately </span></span>;
/// Before a dollar total: not when it rounds to nothing.
const Approx = ({ n, title }: { n: number | null; title?: string }) => (n !== null && Math.abs(n) >= 0.005 ? <Mark title={title} /> : null);

/// One cost-based figure: its text, the small line under it, its colour, the reason in its title, busy while read.
export type Fig = { text: ReactNode; sub?: string; tone?: string; title?: string; busy?: boolean };
/// A cost-based figure while the P&L is not "ok": a dash (or "…" while it catches up with a trade) and the reason.
/// Every cost figure has a small line in every state (BLANK when there is nothing to say), so the card keeps its
/// height as the answer arrives or changes.
const waiting = (state: Exclude<PnlState, "ok">): Fig =>
  state === "loading" ? { text: "—", sub: "reading…", title: WHY.loading, busy: true }
    : state === "updating" ? { text: "…", sub: "updating…", title: WHY.updating, busy: true }
    : { text: "—", sub: state === "failed" ? "not read" : "not available", title: WHY[state] };
/// The small line when there is nothing to say under a figure (a no-break space: it keeps the line's height).
const BLANK = "\u00a0";
/// Why a figure is approximate: the latest trade not counted yet (`behind`) first, else tokens without a recorded buy.
const why = (partial: boolean, behind: boolean) => (behind ? BEHIND_NOTE : partial ? APPROX_NOTE : undefined);

/// `behind`: the answer has not counted the wallet's latest trade of this coin (PositionView.behind): every figure is
/// marked approximate, and one that answer knows nothing of says so rather than "no recorded buy" or "nothing sold".
export function avgFig(state: PnlState, r: PnlRow | null, behind = false): Fig {
  if (state !== "ok") return waiting(state);
  if (behind && (!r || r.gap === "no-cost")) return NOT_YET;
  if (!r || r.gap === "no-cost") return { text: "—", sub: "no recorded buy", title: NO_BUY };
  if (r.gap === "no-price" || r.avgCostUsd === null) return { text: "—", sub: "no price", title: NO_PRICE };
  // a price per token, often far below a cent: marked whenever it is approximate (it never rounds to nothing in usd())
  const title = why(r.partial, behind);
  return { text: <>{title && <Mark title={title} />}{usd(r.avgCostUsd)}</>, sub: `cost ${usd(r.costUsd)}`, title };
}
export function unrealizedFig(state: PnlState, r: PnlRow | null, behind = false): Fig {
  if (state !== "ok") return waiting(state);
  if (behind && (!r || r.gap === "no-cost")) return NOT_YET;
  if (!r || r.gap === "no-cost") return { text: "—", sub: "no recorded buy", title: NO_BUY };
  if (r.gap === "no-price" || r.unrealizedUsd === null) return { text: "—", sub: "no price", title: NO_PRICE };
  const title = why(r.partial, behind);
  return { text: <>{title && <Approx n={r.unrealizedUsd} title={title} />}{signedUsd(r.unrealizedUsd)}</>, sub: r.unrealizedPct !== null ? pnlPct(r.unrealizedPct) : BLANK, tone: pnlTone(r.unrealizedUsd), title };
}
export function realizedFig(state: PnlState, r: PnlRow | null, behind = false): Fig {
  if (state !== "ok") return waiting(state);
  if (behind && (!r || r.sells <= 0)) return NOT_YET;   // a sell not counted yet: never "nothing sold"
  if (!r) return { text: "—", sub: "no recorded buy", title: NO_BUY };
  if (r.sells <= 0) return { text: "—", sub: "nothing sold" };
  if (r.realizedUsd === null) return { text: "—", sub: "not known", title: SOLD_UNKNOWN };
  const sub = `all time${r.realizedPct !== null ? ` · ${pnlPct(r.realizedPct)}` : ""}`;
  const title = why(r.realizedPartial, behind);
  // an approximate figure that rounds to nothing says nothing: a dash with the reason (as the Portfolio's closed list)
  if (title && Math.abs(r.realizedUsd) < 0.005) return { text: "—", sub, title };
  return { text: <>{title && <Approx n={r.realizedUsd} title={title} />}{signedUsd(r.realizedUsd)}</>, sub, tone: pnlTone(r.realizedUsd), title };
}
