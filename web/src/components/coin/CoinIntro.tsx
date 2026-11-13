// Two ways the coin page explains itself in plain words. CoinIntro: one sentence built only from
// API fields (what this coin is, where it sits in its tree, what its agent did). NewToSpore: a
// dismissible strip for a visitor whose first page this session was a shared coin link.
import { useState } from "react";
import { Link } from "react-router-dom";
import type { AgentCoin, Coin, CoinRef } from "../../lib/api";
import { age, count, usdCard } from "../../lib/format";
import { sym } from "../Bits";
import Term from "../Term";

const CoinLink = ({ c }: { c: CoinRef }) => <Link to={`/c/${c.mint}`} className="intro-coin">{sym(c)}</Link>;

export function CoinIntro({ coin, agentCoin }: { coin: Coin; agentCoin: AgentCoin | null | undefined }) {
  const s = sym(coin);
  const parent = coin.parent ?? coin.ancestors[0] ?? null;
  const root = coin.root ?? coin.ancestors[coin.ancestors.length - 1] ?? null;
  let body;
  if (coin.depth === 0) {
    const launches = agentCoin?.role === "root" && agentCoin.agent ? agentCoin.agent.totals.launches : null;
    const grows = coin.children === 0 ? " Nothing grows under it yet."
      : ` ${count(coin.children)} ${coin.children === 1 ? "coin grows" : "coins grow"} under it${coin.lockedUsd != null && coin.lockedUsd > 0 ? ` and ${coin.children === 1 ? "holds" : "hold"} ${usdCard(coin.lockedUsd)} of it` : ""}.`;
    // A depth-0 coin priced in a listed asset (PUMP, USDC, a stock…) is a pair under that asset, not a SOL root.
    const listed = coin.quoteMint ? (coin.quoteSymbol.includes("…") ? coin.quoteSymbol : `$${coin.quoteSymbol}`) : null;
    body = (
      <>
        <b>{s}</b> is {listed ? <>a pump.fun coin <Term k="quote">priced in</Term> {listed}</> : <>a <Term k="root">root coin</Term>{coin.ours ? " launched on Spore" : " on pump.fun"}</>}{coin.createdAt ? ` ${age(coin.createdAt)} ago` : ""}.{grows}
        {launches != null && launches > 0 && <> Its <Term k="agent">AI agent</Term> has launched {launches <= coin.children ? `${count(launches)} of them` : `${count(launches)} coins under it`}.</>}
      </>
    );
  } else if (parent && (coin.depth === 1 || !root || root.mint === parent.mint)) {
    body = <><b>{s}</b> grows under <CoinLink c={parent} />: buying {s} also buys {sym(parent)} and <Term k="locked">locks</Term> it in {s}'s {coin.migrated ? "pool" : "curve"}.</>;
  } else if (parent && root && coin.depth === 2) {
    body = <><b>{s}</b> grows under <CoinLink c={parent} />, which grows under <CoinLink c={root} />: one buy moves all three.</>;
  } else if (parent && root) {
    body = <><b>{s}</b> grows under <CoinLink c={parent} />, {coin.depth} levels below <CoinLink c={root} />: one buy moves the whole chain.</>;
  } else return null;
  return <p className="coin-intro">{body}</p>;
}

const ENTRY_KEY = "spore.entry", SEEN_KEY = "spore.seen";
function shouldShow(): boolean {
  try { return (sessionStorage.getItem(ENTRY_KEY) ?? "").startsWith("/c/") && !localStorage.getItem(SEEN_KEY); }
  catch { return false; }
}

export function NewToSpore() {
  const [show, setShow] = useState(shouldShow);
  if (!show) return null;
  const dismiss = () => { setShow(false); try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* storage blocked: hidden for this view */ } };
  return (
    <aside className="new-strip" aria-label="About Spore">
      <span className="new-strip-dot" aria-hidden="true" />
      <p><b>New to Spore?</b> It's a pump.fun launchpad where coins grow under coins, and every root has an AI agent. <Link to="/how" onClick={dismiss}>How it works →</Link></p>
      <button type="button" className="new-strip-x" aria-label="Dismiss" onClick={dismiss}>×</button>
    </aside>
  );
}
