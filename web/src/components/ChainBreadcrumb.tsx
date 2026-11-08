import { Link } from "react-router-dom";
import type { Coin, CoinRef } from "../lib/api";
import { Logo, sym } from "./Bits";
import Term from "./Term";
import "./coin.css";

/// Root first, this coin last: SOL › $ROOT › $PARENT › $COIN, each coin with its image so the
/// chain reads like a route, not a path string. The quote of the root (SOL, USDC, a stock mint)
/// opens the trail so a non-SOL chain is obvious at a glance; when no quote is shown the first coin
/// carries no "›". `images` off gives the plain text trail for tight spots. `variant="header"` (the
/// coin page) says what a root is priced in ("priced in SOL") instead of repeating its own name.
export default function ChainBreadcrumb({ coin, rootQuote, images = true, variant = "route" }: { coin: Coin; rootQuote?: string | null; images?: boolean; variant?: "route" | "header" }) {
  if (variant === "header" && coin.depth === 0) {
    return (
      <span className="crumbs priced">
        <Term k="quote">priced in</Term>
        <span className="crumb quote mono">{coin.quoteSymbol === "SOL" && images ? <i className="crumb-sol" aria-hidden="true" /> : null}{coin.quoteSymbol}</span>
      </span>
    );
  }
  const trail: CoinRef[] = [...coin.ancestors].reverse();
  const quote = rootQuote ?? (coin.depth === 0 ? coin.quoteSymbol : null);
  const sep = (first: boolean) => (first && !quote ? null : <i aria-hidden="true">›</i>);
  return (
    <nav className="crumbs" aria-label="Parent chain">
      {quote && <span className="crumb quote mono">{quote === "SOL" && images ? <i className="crumb-sol" aria-hidden="true" /> : null}{quote}</span>}
      {trail.map((a, i) => (
        <span key={a.mint} className="crumb-seg">{sep(i === 0)}<Link to={`/c/${a.mint}`} className="crumb" title={`${a.name || a.mint} · depth ${a.depth}`}>{images && <Logo src={a.image} label={a.symbol} size={18} />}{sym(a)}</Link></span>
      ))}
      <span className="crumb-seg">{sep(trail.length === 0)}<span className="crumb self" aria-current="page">{images && <Logo src={coin.image} label={coin.symbol} size={18} />}{sym(coin)}</span></span>
    </nav>
  );
}
