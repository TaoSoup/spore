// "Your position" on the coin page: what the wallet the header shows holds of this coin (amount, value in USD and SOL,
// the price) and, when the server knows it, the average buy, the cost and the unrealized / realized P&L, joined as on
// the Portfolio page (usePosition, lib/position.ts). Desktop: under the trade card (never above it: the ticket's top
// does not move when the card appears). Phones: under the chart. Nothing shows for a wallet that does not hold the
// coin. No address in the card (the wallet tag is a name); the figures are not live regions (a price tick must not
// chatter): one polite status line carries the state changes.
import { memo, useId } from "react";
import { Link } from "react-router-dom";
import type { Coin } from "../../lib/api";
import { amount, price, sol, usd, usdCard } from "../../lib/format";
import { PNL_NOTE } from "../../lib/pnl";
import { closedNote } from "../../lib/position";
import { avgFig, realizedFig, unrealizedFig, type Fig } from "./positionFigs";
import { sym } from "../Bits";
import { usePosition } from "./usePosition";
import type { LiveCoin } from "./useLiveCoin";

/// One cell of the grid: the term over its figure and the small line.
function Cell({ k, f, note, wide }: { k: string; f: Fig; note?: boolean; wide?: boolean }) {
  return (
    <div className={wide ? "pos-wide" : undefined}>
      <dt title={note ? PNL_NOTE : undefined}>{k}</dt>
      <dd className={f.tone ? `pos-pl ${f.tone}` : undefined} title={f.title} aria-busy={f.busy || undefined}>{f.text}{f.sub && <span className="pos-sub">{f.sub}</span>}</dd>
    </div>
  );
}

function YourPosition({ coin, store, solUsd }: { coin: Coin; store: LiveCoin; solUsd: number | null }) {
  const p = usePosition(coin, store, solUsd);
  const headId = useId(), noteId = useId();
  if (p.mode === "none") return null;
  const c = p.live, label = sym(c), closed = p.mode === "closed";
  const priceTxt = c.priceUsd != null ? usd(c.priceUsd) : price(c.priceQuote, c.quoteSymbol);
  const value: Fig = p.valueUsd !== null ? { text: usdCard(p.valueUsd), sub: p.valueSol !== null ? sol(p.valueSol) : undefined, title: usd(p.valueUsd) } : { text: <span className="muted">no price</span> };
  // the closed note stands where the holding was; the status line still announces it (once, for a screen reader)
  const closedLine = closed ? closedNote(label) : null;
  const quiet = closedLine !== null && p.status === closedLine;
  return (
    <section className={`card coin-position ${closed ? "closed" : ""}`} aria-labelledby={headId}>
      <header className="pos-head">
        <h2 id={headId} className="card-label">Your position<span className="sr-only"> in {label}</span></h2>
        <span className="pos-wallet">{p.walletLabel}</span>
      </header>
      {closedLine && <p className="pos-closed">{closedLine}</p>}
      <dl className="pos-grid" aria-describedby={noteId}>
        {!closed && <>
          <Cell k="Value" f={value} />
          <Cell k="Holding" f={{ text: amount(p.balance, label) }} />
          <Cell k="Price" f={{ text: priceTxt }} />
          <Cell k="Avg buy" f={avgFig(p.pnl, p.row, p.behind)} />
          <Cell k="Unrealized P&L" f={unrealizedFig(p.pnl, p.row, p.behind)} note />
        </>}
        <Cell k="Realized P&L" f={realizedFig(p.pnl, p.row, p.behind)} note wide={closed} />
      </dl>
      <p className="sr-only" id={noteId}>{PNL_NOTE}</p>
      <footer className="pos-foot">
        <span role="status">
          {quiet ? <span className="sr-only">{p.status}</span> : p.status}
          {p.pnl === "failed" && <> <button type="button" className="linkish" onClick={p.retry}>Retry</button></>}
        </span>
        {p.portfolioLink && <Link to="/portfolio" className="pos-link" aria-label="Open your portfolio">Portfolio →</Link>}
      </footer>
    </section>
  );
}

export default memo(YourPosition);
