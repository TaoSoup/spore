import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync, useStats } from "../lib/hooks";
import { usd } from "../lib/format";
import { ROOT_SPLIT, SPLIT_BPS } from "../lib/policy";
import { AGENT_SEED_SOL, CHILD_PCT, LISTS_SCOPE, NETWORK_RENT_SOL, PUMP_CREATOR_FEE_PCT, ROOT_PCT, SPORE_BUYBACK } from "../lib/copy";
import SporeCanvas from "../components/SporeCanvas";
import { DepthBadge, Skeleton } from "../components/Bits";
import Term from "../components/Term";
import Reveal from "../components/ui/Reveal";
import StoryNav from "../components/docs/StoryNav";
import StorySection from "../components/docs/StorySection";
import FeeDial from "../components/docs/FeeDial";
import { DepthIllus, FeeFlowIllus, NeverGlyph } from "../components/docs/illus/StoryIllus";
import type { Tone } from "../components/illus/base";
import "../components/docs/story.css";

// "0.02 SOL", "0.025 SOL": the page quotes fees, where lib/format's fixed four decimals read as noise.
const solText = (s: number) => `${Number(s.toFixed(4))} SOL`;
const MAX_CREATOR_FEE_BPS = 300;

const NAV = [["ledger", "One launch"], ["split", "Creator fees"], ["depth", "Depth cap"], ["rules", "pump.fun's rules"], ["never", "What it never does"], ["risks", "Risks, plainly"]] as const;

/// One refusal, drawn: a node whose filament is cut before it reaches anything.
const No = ({ tone = "lime", lock = false, children }: { tone?: Tone; lock?: boolean; children: ReactNode }) => (
  <li><i aria-hidden="true"><NeverGlyph tone={tone} lock={lock} /></i><span>{children}</span></li>
);

/// Everything Spore charges and everything it refuses to do, on one page: the launch fee (live
/// from the API, so an env change shows up here), the root and child creator-fee splits (from the
/// pinned policy through lib/copy.ts), the depth cap, the rules pump.fun enforces, and the risks.
/// Linked from the footer and the launch page.
export default function Fees() {
  const { stats } = useStats();
  // The SOL pool's eligibility carries the launch fee without a wallet.
  const elig = useAsync(() => api.eligibilitySol(null), []);
  useEffect(() => { document.title = "Fees & rules · Spore"; return () => { document.title = "Spore"; }; }, []);
  const fee = elig.data ? (elig.data.launchFee?.sol ?? 0) : null;
  const solUsd = stats?.solUsd ?? null;
  const inUsd = (s: number) => (solUsd ? usd(s * solUsd) : null);
  const maxDepth = stats?.maxDepth ?? 2;
  const Amount = ({ s }: { s: number | null }) => (s === null ? <Skeleton w={70} h={16} /> : <>{solText(s)}{inUsd(s) && <small>{inUsd(s)}</small>}</>);
  return (
    <>
      <SporeCanvas density={0.5} />
      <div className="container story story-fees">
        <header className="story-hero">
          <div className="story-hero-text">
            <span className="eyebrow">Fees &amp; rules</span>
            <h1 className="story-title"><span className="story-line">What it costs.</span> <span className="story-line">What it <em>never</em> does.</span></h1>
            <p className="lead">Spore charges no launch fee. It earns one thing: its share of the creator fee on coins launched here ({ROOT_PCT.spore} of a root's trades, {CHILD_PCT.spore} of a child's creator fee), shown before you sign and written on-chain.</p>
          </div>
          <figure className="story-hero-art" aria-hidden="true"><FeeFlowIllus shares={{ creator: ROOT_SPLIT.creator, spore: ROOT_SPLIT.platform, agent: ROOT_SPLIT.agent }} /></figure>
        </header>

        <Reveal as="dl" className="story-facts" aria-label="At a glance">
          <div><dt className="label">Launch fee</dt><dd className={`num-display${fee ? " accent" : ""}`}>{fee === null ? <Skeleton w={64} h={24} /> : fee > 0 ? solText(fee) : "none"}</dd><small>read live from the API</small></div>
          <div><dt className="label">Network rent</dt><dd className="num-display">~{NETWORK_RENT_SOL}</dd><small>SOL, held by the coin's own accounts</small></div>
          <div><dt className="label">Spore's share</dt><dd className="num-display">{ROOT_PCT.spore}</dd><small>of a root's trades, once graduated</small></div>
          <div><dt className="label">Split changes</dt><dd className="num-display">never</dd><small>the admin is revoked on first use</small></div>
        </Reveal>

        <div className="story-body">
          <StoryNav items={NAV} title="Fees & rules" />
          <div className="story-main">
            <StorySection id="ledger" n="01" title="One launch, line by line" lede="Every line a launch can cost, and where it goes." wide>
              <dl className="story-ledger">
                <div><dt><b>Launch fee</b><small>{fee === 0 ? "None is charged, so the launch page hides this line." : "Transferred to Spore inside the launch transaction. Zero hides this line on the launch page."}</small><span className="who spore">to Spore</span></dt><dd className={fee ? "accent" : "faint"}>{fee === null ? <Skeleton w={70} h={16} /> : fee > 0 ? <Amount s={fee} /> : "none"}</dd></div>
                <div><dt><b>Network rent</b><small>Held by the coin's own accounts on Solana: mint, bonding curve, fee-sharing config and the curve's vault. An estimate, hence the “~”.</small><span className="who">to the network</span></dt><dd>~<Amount s={NETWORK_RENT_SOL} /></dd></div>
                <div><dt><b>Agent's starting gas</b><small>Roots only. The launch sends your coin's new AI agent this much SOL in the same signature, so it can pay for its first claims. It stays in the agent's wallet.</small><span className="who agent">to your coin's agent</span></dt><dd><Amount s={AGENT_SEED_SOL} /></dd></div>
                <div><dt><b>Network fees</b><small>Solana's transaction fee plus the priority fee your wallet adds. Fractions of a cent.</small><span className="who">to validators</span></dt><dd>≈ 0.0001 SOL</dd></div>
                <div><dt><b>First buy</b><small>Optional. A second signature buys your coin with SOL right after it exists, through every hop of the chain.</small><span className="who">your choice</span></dt><dd>0 – any</dd></div>
              </dl>
              <p className="story-ledger-total">{fee === null ? "Reading the current fee…" : fee > 0 ? `A launch therefore costs about ${solText(fee + NETWORK_RENT_SOL)} before any first buy, and the launch page checks your balance against that total, with a small margin for network fees.` : "No launch fee is charged: a launch costs the network rent and fees, plus the agent's starting gas for a root."}</p>
            </StorySection>

            <StorySection id="split" n="02" title="Creator fees, split at launch" lede="Three shareholders for a root, two for a child. Written in the launch transaction." wide>
              <div className="story-dials">
                <FeeDial title="Root coin" note="priced in SOL · of every trade once graduated" read={`${PUMP_CREATOR_FEE_PCT}%`} readSub="creator fee, graduated" rows={[
                  { key: "creator", tone: "lime", v: ROOT_SPLIT.creator, value: ROOT_PCT.creator, who: "you, the creator", detail: "the wallet that signs the launch" },
                  { key: "spore", tone: "ink", v: ROOT_SPLIT.platform, value: ROOT_PCT.spore, who: "Spore", detail: "buys $SPORE and locks it" },
                  { key: "agent", tone: "agent", v: ROOT_SPLIT.agent, value: ROOT_PCT.agent, who: "your coin's agent", detail: "its own wallet: claims, launches, pays its AI bill" },
                ]} />
                <FeeDial title="Child coin" note="priced in its parent · share of the creator fee, paid in the parent coin" read="2" readSub="shareholders" rows={[
                  { key: "creator", tone: "lime", v: SPLIT_BPS[0], value: CHILD_PCT.creator, who: "you, the creator", detail: "the wallet that launches the child" },
                  { key: "spore", tone: "ink", v: SPLIT_BPS[3], value: CHILD_PCT.spore, who: "Spore", detail: "buys $SPORE and locks it" },
                ]} />
              </div>
              <p className="story-note">On the bonding curve pump.fun's creator fee is 0.30% of volume, so the same split pays proportionally less until the coin graduates. Once graduated it is {PUMP_CREATOR_FEE_PCT}%, which is what the root figures above are measured against.</p>
              <div className="story-cols">
                <p>Every trade of a pump.fun coin pays a <Term k="creatorFee">creator fee</Term> to the coin's creator: pump's default schedule, or a custom rate you pick at launch, up to {MAX_CREATOR_FEE_BPS / 100}%. Spore writes a fee-sharing config in the launch transaction, three shareholders for a root and two for a child, and pump revokes the admin on first use, so <b>the split can never be changed</b> by anyone, Spore included.</p>
                <p>Payouts arrive in the coin's quote: <b>SOL</b> for a root coin, <b>the parent coin</b> for a child. Anyone can trigger <span className="mono">distribute_creator_fees_v2</span>; Spore's keeper does it on a schedule, and each root's agent claims for its root and the coins it launched. Parent creators get no share of a child's fees: they earn through the parent tokens the child buys and locks. {SPORE_BUYBACK}</p>
                <p>pump.fun's own protocol fee on every trade goes to pump.fun, as on any pump coin. Spore takes nothing from trades beyond its share of the creator fee.</p>
              </div>
            </StorySection>

            <StorySection id="depth" n="03" title="Depth cap" lede="One hop deeper per generation, up to pump.fun's setting."
              art={<DepthIllus maxDepth={maxDepth} />}
              caption={<span className="depth-row"><DepthBadge depth={0} title="root: priced in SOL" /><DepthBadge depth={1} title="child: priced in the root" />{maxDepth >= 2 && <DepthBadge depth={2} title="grandchild: priced in the child" />}{maxDepth >= 3 && <DepthBadge depth={3} />}<span className="ghost">depth {maxDepth + 1} not allowed</span></span>}>
              <p>A root is priced in SOL (<Term k="depth" vars={{ maxDepth: stats?.maxDepth }}>depth</Term> 0). A child is priced in its parent, one deeper. pump.fun's <span className="mono">Global.maxCurveDepth</span> is <b>{stats ? stats.maxDepth : "…"}</b> right now, so the deepest coin possible is depth {maxDepth}; the launch button is greyed out on any coin at the cap, with the reason in its tooltip. The program's hard limit is 5; if pump.fun raises its setting, Spore follows automatically.</p>
            </StorySection>

            <StorySection id="rules" n="04" title="Rules pump.fun enforces" wide>
              <ol className="story-rules">
                <li>A <b>mayhem-mode</b> coin cannot be a parent.</li>
                <li>A coin cannot be launched under a chain where any coin has <b>graduated but not migrated</b> yet: wait for the migration.</li>
                <li>Only coins priced in a listed mint (SOL, USDC, tokenized stocks) can be roots; a chain not rooted in SOL cannot be bought from SOL in-app.</li>
                <li><b>Holder rewards are off</b> on Spore launches: a holder-reward coin routes fees to holders through a PDA, which would defeat the split.</li>
                <li>Names are at most 32 characters, tickers 1–13 letters or digits, images under 2 MB. Metadata is content-addressed on Spore's own host.</li>
              </ol>
            </StorySection>

            <StorySection id="never" n="05" title={<>What Spore <span className="serif-em">never</span> does</>} lede="Each of these is a filament that was never connected." wide>
              <ul className="story-never">
                <No tone="ink"><b>Never holds your keys or funds.</b> Every transaction you make is built in your browser, simulated, then signed by your wallet. The only keys Spore keeps are the agents' own wallets, encrypted at rest.</No>
                <No tone="lime"><b>Never launches coins from its own wallet.</b> Spore is a launchpad, not a coin project: its only revenue is its share of creator fees on coins launched here; there is no launch fee. A root's agent launches from that agent's own wallet.</No>
                <No tone="lime" lock><b>Never changes a split after launch.</b> It cannot: pump revokes the config's admin the moment the shares are written.</No>
                <No tone="teal"><b>Never lists a coin it did not launch.</b> {LISTS_SCOPE} Other coins on the map and in breadcrumbs are context, never listings.</No>
                <No tone="violet"><b>Never trades on your behalf</b> and never takes a cut of a trade beyond the creator-fee share above. <Term k="slippage">Slippage</Term> is enforced on-chain through <span className="mono">minAmountOut</span>.</No>
                <No tone="agent"><b>Never promises a price.</b> These are pump.fun memecoins; most go to zero.</No>
              </ul>
            </StorySection>

            <StorySection id="risks" n="06" title="Risks, plainly" wide>
              <ul className="story-marks warn">
                <li>A child's price is the product of every price on its chain: when the parent drops, every child drops with it.</li>
                <li>Multi-hop swaps cost more compute and can fail on slippage when any hop moves. A failed transaction costs only the network fee.</li>
                <li>There is no launch fee: a launch costs only Solana's network rent and fees, and if the transaction fails, only the network fee is spent.</li>
                <li>Creator fees are paid in parent tokens for a child coin, so their value follows the parent, not SOL.</li>
              </ul>
            </StorySection>
          </div>
        </div>

        <footer className="story-foot">
          <div className="story-foot-actions"><Link to="/launch" className="btn lg accent">Launch a coin <span className="arrow" aria-hidden="true">→</span></Link><Link to="/how" className="btn lg ghost">How it works</Link></div>
          <p className="hint">The launch fee and depth cap on this page are read live from the API; the splits are the ones the launch signs; the network rent is an estimate.</p>
        </footer>
      </div>
    </>
  );
}
