import { useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync, useStats } from "../lib/hooks";
import { count, usd } from "../lib/format";
import { ROOT_SPLIT } from "../lib/policy";
import { AGENT_LINE, AGENT_SEED_SOL, CHILD_PCT, CHILD_SPLIT_YOU, LISTS_SCOPE, NETWORK_RENT_SOL, PUMP_CREATOR_FEE_PCT, ROOT_PCT, ROOT_SPLIT_YOU, ROOT_TILE, SPORE_BUYBACK } from "../lib/copy";
import SporeCanvas from "../components/SporeCanvas";
import Term from "../components/Term";
import Reveal from "../components/ui/Reveal";
import StoryNav from "../components/docs/StoryNav";
import StorySection from "../components/docs/StorySection";
import FeeDial from "../components/docs/FeeDial";
import { AgentIllus, ColonyIllus, DepthIllus, GrowIllus, LaunchIllus, RouteIllus } from "../components/docs/illus/StoryIllus";
import "../components/docs/story.css";

const solText = (s: number) => `${Number(s.toFixed(4))} SOL`;

// A root's creator fee is split three ways (DESIGN §13.1); a child's between its creator and the
// launchpad (DESIGN §4). The percentages come from lib/copy.ts, which derives them from the policy.
const SPLIT = [["Creator", ROOT_PCT.creator, "you, the wallet that signs the launch"], ["Spore", ROOT_PCT.spore, "the launchpad wallet; buys and locks $SPORE"], ["Your agent", ROOT_PCT.agent, "your coin's agent wallet; pays for the coins it launches under yours"]];
const CHILD_SPLIT = [["Creator", CHILD_PCT.creator, "the wallet that launches a child"], ["Spore", CHILD_PCT.spore, "the launchpad wallet"]];

const NAV = [["launching", "Launching"], ["agent", "The agent"], ["why", "Why a child helps"], ["fees", "Fees"], ["depth", "Depth and listing"], ["trading", "Trading here"], ["risks", "Risks, plainly"]] as const;

export default function How() {
  const { stats } = useStats();
  const elig = useAsync(() => api.eligibilitySol(null), []);
  useEffect(() => { document.title = "How it works · Spore"; return () => { document.title = "Spore"; }; }, []);
  const maxDepth = stats?.maxDepth ?? 2;
  const fee = elig.data ? (elig.data.launchFee?.sol ?? 0) : null;
  const ours = stats?.mode === "ours";
  const launches = stats ? (ours ? stats.ourCoins ?? stats.coins : stats.coins) : null;
  return (
    <>
      <SporeCanvas density={0.5} />
      <div className="container story story-how">
        <header className="story-hero">
          <div className="story-hero-text">
            <span className="eyebrow">How it works</span>
            <h1 className="story-title">A coin that <em>grows</em> coins.</h1>
            <p className="lead">pump.fun's <span className="mono">create_v2</span> lets a coin be priced in another pump.fun coin instead of SOL. Spore is a launchpad for that: launch a <Term k="root">root</Term> with SOL, then launch coins under it. Root creator fee: {ROOT_SPLIT_YOU}. Child creator fee: {CHILD_SPLIT_YOU}. {LISTS_SCOPE}</p>
          </div>
          <figure className="story-hero-art" aria-hidden="true"><ColonyIllus /></figure>
        </header>

        <Reveal as="dl" className="story-facts" aria-label="Key numbers">
          <div><dt className="label">Launch fee</dt><dd className={`num-display${fee ? " accent" : ""}`}>{fee === null ? "…" : fee > 0 ? solText(fee) : "none"}</dd><small>only network rent, ~{NETWORK_RENT_SOL} SOL</small></div>
          <div><dt className="label">Depth cap</dt><dd className="num-display">{stats ? stats.maxDepth : "…"}</dd><small>root → child → grandchild</small></div>
          <div className="wide"><dt className="label">Creator fee split</dt><dd className="num-display">{ROOT_TILE}</dd><small>root: you / Spore / agent · child: creator {CHILD_PCT.creator} · Spore {CHILD_PCT.spore}</small></div>
          <div><dt className="label">{ours || !stats ? "Spore launches" : "coins indexed"}</dt><dd className="num-display">{launches === null ? "…" : count(launches)}</dd><small>{stats && launches ? `${usd(stats.lockedUsd)} locked by children` : "coins launched here"}</small></div>
        </Reveal>

        <div className="story-body">
          <StoryNav items={NAV} title="How it works" />
          <div className="story-main">
            <StorySection id="launching" n="01" title="Launching" lede="A root starts with SOL; every coin after it grows under another coin."
              art={<LaunchIllus />} caption={<><i className="k ink" />your wallet <i className="k lime" />the new root <i className="k agent" />its agent <i className="k teal dim" />children to come</>}>
              <ol className="story-steps">
                <li><b>Launch a root with SOL.</b> The first coin of a tree is a plain pump.fun coin: priced in SOL, no parent needed. Name, ticker, image, description and socials become a content-addressed metadata file on Spore's own host.</li>
                <li><b>Or launch under a coin.</b> Press “Launch a coin” on any coin below the depth cap, here or by searching all of pump.fun. The new coin is a <Term k="child">child</Term> priced in that parent: its <Term k="curve">curve</Term> collects parent tokens instead of SOL. The eligibility check runs against the live chain before you sign.</li>
                <li><b>Check the cost, sign once.</b> The cost box shows {fee !== null && fee > 0 ? `the launch fee (${solText(fee)})` : "that there is no launch fee"}, the network rent (~{NETWORK_RENT_SOL} SOL for the mint, curve, fee config and vault) and your optional first buy, against your wallet balance. A root's launch also sends its agent wallet {AGENT_SEED_SOL} SOL of starting gas. One signature creates the coin and writes its fee split. Full list on <Link to="/fees">Fees &amp; rules</Link>.</li>
              </ol>
            </StorySection>

            <StorySection id="agent" n="02" title={<>Every root gets an <Term k="agent">AI agent</Term></>} lede="It lives on its root's orbit and works while you sleep."
              art={<AgentIllus />} caption={<><i className="k lime" />the root <i className="k agent" />its agent <i className="k teal" />coins it launched</>}>
              <p>{AGENT_LINE}</p>
              <p>The agent picks each new coin's name, ticker and logo, and nothing else. It earns from its root's trades and from the coins it launched, and its wallet, launches and payments are public on its page. <Link to="/agents">Watch the agents <span className="arrow" aria-hidden="true">→</span></Link></p>
            </StorySection>

            <StorySection id="why" n="03" title="Why a child helps its parent" lede="Every buy of a child buys its parent first, and keeps it."
              art={<GrowIllus />} caption={<><i className="k ink" />SOL <i className="k lime" />root <i className="k teal" />child <i className="k lime lock" />root tokens locked in the child's curve</>}>
              <p>Buying a child from SOL is a multi-hop swap: SOL buys the root, the root buys the child. The root tokens stay parked in the child's curve and, once the child <Term k="graduated">graduates</Term>, locked in the child/root PumpSwap pool. Selling runs the hops in reverse.</p>
              <p>So every child is permanent buy pressure and locked liquidity for its parent. That is the <Term k="locked">locked</Term> number on every card: the parent tokens its children hold.</p>
            </StorySection>

            <StorySection id="fees" n="04" title="Fees" lede="Split at launch, written on-chain, never changed."
              art={<FeeDial compact title="Root coin" read={`${PUMP_CREATOR_FEE_PCT}%`} readSub="creator fee" size={216}
                rows={[{ key: "creator", tone: "lime", v: ROOT_SPLIT.creator, value: ROOT_PCT.creator, who: "creator" }, { key: "spore", tone: "ink", v: ROOT_SPLIT.platform, value: ROOT_PCT.spore, who: "Spore" }, { key: "agent", tone: "agent", v: ROOT_SPLIT.agent, value: ROOT_PCT.agent, who: "agent" }]} />}
              caption={<><i className="k lime" />creator {ROOT_PCT.creator} <i className="k ink" />Spore {ROOT_PCT.spore} <i className="k agent" />agent {ROOT_PCT.agent}</>}>
              <p>A coin's <Term k="creatorFee">creator fee</Term> is paid on every trade of it. Spore writes a fee-sharing config in the launch transaction. For a <b>root coin</b> (priced in SOL) the creator fee, {PUMP_CREATOR_FEE_PCT}% of each trade once the coin graduates and 0.30% on the curve, is split three ways:</p>
              <div className="story-table"><table className="table">
                <thead><tr><th>Shareholder</th><th className="num-col">Of each trade</th><th>Who</th></tr></thead>
                <tbody>{SPLIT.map(([a, b, c]) => <tr key={a}><td>{a}</td><td className="num-col">{b}</td><td className="muted">{c}</td></tr>)}</tbody>
              </table></div>
              <p>For a <b>child coin</b> (priced in its parent) the creator fee has exactly two shareholders:</p>
              <div className="story-table"><table className="table">
                <thead><tr><th>Shareholder</th><th className="num-col">Share</th><th>Who</th></tr></thead>
                <tbody>{CHILD_SPLIT.map(([a, b, c]) => <tr key={a}><td>{a}</td><td className="num-col">{b}</td><td className="muted">{c}</td></tr>)}</tbody>
              </table></div>
              <p>Payouts arrive in the coin's quote: SOL for a root, the parent coin for a child. {SPORE_BUYBACK} The split is shown before you sign and is <b>immutable afterwards</b>: pump's <span className="mono">update_fee_shares_v2</span> revokes the admin on first use, so neither Spore nor you can change it. Parent creators earn through locked liquidity, not a fee share.</p>
            </StorySection>

            <StorySection id="depth" n="05" title="Depth, and what is listed" lede="Each hop is one level deeper, up to pump.fun's cap."
              art={<DepthIllus maxDepth={maxDepth} />} caption={<><i className="k lime" />depth 0 <i className="k teal" />1 <i className="k violet" />2 <i className="k ink dim" />depth {maxDepth + 1}: not allowed</>}>
              <p>A coin priced in SOL is <Term k="depth" vars={{ maxDepth: stats?.maxDepth }}>depth</Term> 0, its child depth 1, and so on. pump.fun's <span className="mono">Global.maxCurveDepth</span> is <b>{stats ? stats.maxDepth : "…"}</b> today, so the chain is root → child → grandchild; the launch button greys out at the cap. Mayhem-mode coins cannot be parents, and a chain waits while any coin on it is graduated but not yet migrated.</p>
              <p>Lists show coins launched on Spore{stats && launches !== null && ours ? <>: <b>{count(launches)}</b> so far{launches > 0 ? <>, with <b>{usd(stats.lockedUsd)}</b> of parent tokens locked by children</> : null}</> : null}. <Term k="mapAll">The map</Term> shows every pump.fun pair. Any pump.fun coin can still be a parent; search covers all of pump.fun.</p>
            </StorySection>

            <StorySection id="trading" n="06" title="Trading here" lede="The preview is a simulation of the real swap."
              art={<RouteIllus />} caption={<><i className="k lime" />buy route <i className="k teal" />the on-chain minimum <i className="k violet" />sell, hops reversed</>}>
              <p>The trade widget quotes by simulating the real <span className="mono">multi_hop_swap</span> and reading the resulting event, so the preview is what the program will do. <Term k="slippage">Slippage</Term> is enforced on-chain through <span className="mono">minAmountOut</span>. Chains not rooted in SOL link out to pump.fun.</p>
            </StorySection>

            <StorySection id="risks" n="07" title="Risks, plainly" className="tone-warn">
              <ul className="story-marks warn">
                <li>These are pump.fun memecoins. A child's price is the product of every price on its chain: when the parent drops, every child drops with it.</li>
                <li>Multi-hop swaps pay more compute and can fail on slippage when any hop moves; a failed transaction costs only the network fee.</li>
                <li>The fee split cannot be changed after launch. Check it in the preview.</li>
                <li>Spore holds none of your keys or funds. Your transactions are built client-side, simulated, then signed by your wallet. The API indexes public chain data and proxies an allow-listed RPC. The only keys Spore keeps are the agents' own wallets, encrypted at rest.</li>
              </ul>
            </StorySection>
          </div>
        </div>

        <footer className="story-foot">
          <div className="story-foot-actions"><Link to="/launch" className="btn lg accent">Launch a coin <span className="arrow" aria-hidden="true">→</span></Link><Link to="/explore" className="btn lg ghost">Explore launches</Link></div>
          <p className="hint">Every fee and rule, in full: <Link to="/fees">Fees &amp; rules</Link>. Building a terminal or a coin page? The family-tree data and widgets are open: <Link to="/docs/api">API &amp; embeds</Link>.</p>
        </footer>
      </div>
    </>
  );
}
