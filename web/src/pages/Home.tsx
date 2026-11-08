// The front page (elevation 2026-10-24, lane home). Order: the arrival (the colony bleeding off the right
// edge, the headline, one sentence, Launch + Explore + the agents, the trust row, the search) → the live
// pulse at the fold → how Spore works → the numbers → the agents → the most active launches → the biggest
// trees. Every fee and agent sentence comes from lib/copy.ts; every number comes from the API.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type Coin } from "../lib/api";
import { useAsync, useStats, type Async } from "../lib/hooks";
import { plural } from "../lib/format";
import { AGENT_CADENCE, AGENT_LINE, CHILD_SPLIT_YOU, LISTS_SCOPE, NETWORK_RENT_SOL, NO_LAUNCH_FEE, ROOT_SPLIT_YOU, SPORE_BUYBACK, TRUST_POINTS, WHAT_IS_SPORE } from "../lib/copy";
import Search from "../components/Search";
import CoinCard, { CoinCardSkeleton } from "../components/CoinCard";
import LaunchButton from "../components/LaunchButton";
import AgentsStrip from "../components/agents/AgentsStrip";
import { agentsCached, runState } from "../components/agents/data";
import Term from "../components/Term";
import { Empty, ErrorBox, sym } from "../components/Bits";
import TreeRow, { TreeRowSkeleton } from "../components/TreeRow";
import { TreePreview } from "../components/home/LiveTree";
import Pulse from "../components/home/Pulse";
import FlowDiagram from "../components/home/FlowDiagram";
import Numbers from "../components/home/Numbers";
import { AgentOrbit, IllusGrow, IllusLaunch, IllusSplit } from "../components/home/illus/HomeIllus";
import SporeColony from "../components/hero/SporeColony";
import SectionHead from "../components/ui/SectionHead";
import Reveal from "../components/ui/Reveal";
import Tilt from "../components/ui/Tilt";
import "../components/discover.css";
import "../components/home/home.css";

const SEARCH_LABEL = "Have a coin in mind? Find any pump.fun coin to launch under it";

/* ---------- glyphs (24-unit grid, stroked in currentColor) */
const Ico = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const MapIco = () => <Ico><path d="M9 4 3.5 6.2v13.6L9 17.6l6 2.4 5.5-2.2V4.2L15 6.4 9 4Z" /><path d="M9 4v13.6M15 6.4V20" /><circle cx="15" cy="11" r="1.4" /></Ico>;
const SproutIco = () => <Ico><path d="M12 21V10" /><path d="M12 14c0-3.5 2.5-6 6-6h2c0 3.5-2.5 6-6 6h-2Z" /><path d="M12 10C12 6.5 9.5 4 6 4H4c0 3.5 2.5 6 6 6h2Z" /></Ico>;
const AgentIco = () => <Ico><path d="M11 3.5c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5 3.9-.5 6-2.6 6.5-6.5Z" /><path d="M18 14.5c.25 1.7 1.05 2.5 2.75 2.75-1.7.25-2.5 1.05-2.75 2.75-.25-1.7-1.05-2.5-2.75-2.75 1.7-.25 2.5-1.05 2.75-2.75Z" /></Ico>;
const Check = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg>;
const Arrow = ({ dir = "right" }: { dir?: "left" | "right" }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{dir === "right" ? <path d="M5 12h14M13 6l6 6-6 6" /> : <path d="M19 12H5M11 6l-6 6 6 6" />}</svg>;

/// "2 agents live · 14 coins launched by them", from the shared agent list (one request a minute at
/// most); the plain sentence while it loads or when no agent exists. Never a made-up number.
function AgentsLine() {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    agentsCached().then((r) => {
      if (!alive || r.agents.length === 0) return;
      const live = r.agents.filter((a) => runState(a).state === "live").length;
      const launches = r.agents.reduce((n, a) => n + a.totals.launches, 0);
      setLine(`${plural(live, "agent")} live · ${plural(launches, "coin")} launched by them`);
    }, () => { /* no agents routes or the API is down: keep the plain sentence */ });
    return () => { alive = false; };
  }, []);
  return <>{line ?? "AI agents that launch coins on their own"}</>;
}

/// LISTS_SCOPE with "the map" explained in place.
function ScopeHint() {
  const [a, b] = LISTS_SCOPE.split("the map");
  return <p className="hint arrive-hint">{b === undefined ? LISTS_SCOPE : <>{a}<Term k="mapAll">the map</Term>{b}</>}</p>;
}

function Arrival() {
  return (
    <section className="arrive" aria-labelledby="arrive-title">
      <div className="arrive-copy">
        <span className="eyebrow arrive-eyebrow"><span>pump.fun launchpad ·</span> <span>coin family trees ·</span> <span>live AI agents</span></span>
        <h1 id="arrive-title" className="display arrive-title">Coins that <em>grow</em> coins.</h1>
        <p className="arrive-lead">{WHAT_IS_SPORE}</p>
        <div className="arrive-actions">
          <div className="arrive-btns">
            <Link to="/launch" className="btn lg accent arrive-launch"><SproutIco />Launch a coin<span className="arrow" aria-hidden="true">→</span></Link>
            <Link to="/map" className="btn lg ghost sweep arrive-map"><MapIco />Explore the map</Link>
          </div>
          <p className="arrive-rent">No launch fee · from ~{NETWORK_RENT_SOL} SOL network rent · one signature</p>
          <Link to="/agents" className="arrive-agents">
            <span className="arrive-agents-ico"><AgentIco /></span>
            <span className="arrive-agents-text"><b>Watch the agents</b><span><AgentsLine /></span></span>
            <span className="arrive-agents-arrow"><Arrow /></span>
          </Link>
        </div>
        <ul className="arrive-trust" aria-label="Why it is safe to try">
          {TRUST_POINTS.map((p) => <li key={p}><Check />{p}</li>)}
        </ul>
        <div className="arrive-search">
          <p className="arrive-search-label" aria-hidden="true">{SEARCH_LABEL}</p>
          <Search size="md" label={SEARCH_LABEL} placeholder="Name, ticker or mint" />
          <ScopeHint />
        </div>
      </div>
    </section>
  );
}

function HowWorks({ maxDepth }: { maxDepth: number }) {
  const steps = [
    { illus: <IllusLaunch />, title: <>Launch a <Term k="root">root</Term></>, body: <>A normal pump.fun coin, bought with SOL. No launch fee, and it gets its own <Term k="agent">AI agent</Term>.</> },
    { illus: <IllusGrow />, title: <>Coins grow under it</>, body: <>Anyone can launch a <Term k="child">child</Term> priced in your coin, and your coin's agent launches one {AGENT_CADENCE}. Every buy of a child buys your coin and <Term k="locked">locks it</Term> in the child's curve.</> },
    { illus: <IllusSplit />, title: <><Term k="creatorFee">Fees</Term> split forever</>, body: <>Root: {ROOT_SPLIT_YOU}. Child: {CHILD_SPLIT_YOU}. {SPORE_BUYBACK}</> },
  ];
  return (
    <section className="hw" aria-labelledby="hw-title">
      <SectionHead n="01" id="hw-title" title="How Spore works" lede="Buying a child is one swap: SOL buys the root, the root buys the child, and the root coins stay locked in the child's curve."
        action={<Link to="/how" className="more-link">Full details <Arrow /></Link>} />
      <ol className="hw-steps">
        {steps.map((s, i) => (
          <Reveal as="li" key={i} i={i} className="hw-step">
            <div className="hw-art">{s.illus}</div>
            <span className="hw-n" aria-hidden="true">Step {i + 1}</span>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </Reveal>
        ))}
      </ol>
      <Reveal><FlowDiagram maxDepth={maxDepth} className="hw-flow" /></Reveal>
    </section>
  );
}

function NumbersSection({ stats, error }: { stats: ReturnType<typeof useStats>["stats"]; error: string | null }) {
  return (
    <section className="home-numbers" aria-labelledby="hn-title">
      <SectionHead n="02" id="hn-title" title="Spore in numbers" lede="Live from the index, refreshed every 30 seconds." />
      <Reveal><Numbers stats={stats} error={error} /></Reveal>
    </section>
  );
}

function AgentsBand({ n }: { n: string }) {
  return (
    <section className="ag-band" aria-labelledby="ag-title">
      <SectionHead n={n} id="ag-title" title="Agents at work" action={<Link to="/agents" className="more-link">All agents <Arrow /></Link>} />
      <Reveal className="ag-band-body">
        <div className="ag-band-art"><AgentOrbit /></div>
        <div className="ag-band-text">
          <p className="ag-band-line">{AGENT_LINE}</p>
          <AgentsStrip />
        </div>
      </Reveal>
    </section>
  );
}

/// The empty launchpad: nothing launched yet must read as "be first", never as a page that failed to load.
function EmptyLaunchpad() {
  return (
    <section className="empty-hero glass">
      <div className="empty-hero-text">
        <span className="eyebrow">nothing launched yet</span>
        <h2>Be the first tree on Spore.</h2>
        <p>{LISTS_SCOPE} So the first launch is the whole front page. Three steps from an idea to a family tree:</p>
        <ol className="empty-steps">
          <li><div><b>Launch a root with SOL.</b><span>A plain pump.fun coin, one signature. {NO_LAUNCH_FEE} Its fee split is written on-chain at creation, and it gets its own AI agent.</span></div></li>
          <li><div><b>Launch the next coin under it.</b><span>The child is priced in the parent, so every buy of the child buys the parent and locks it in the child's curve.</span></div></li>
          <li><div><b>One fee rule, forever.</b><span>Root: {ROOT_SPLIT_YOU}. Child: {CHILD_SPLIT_YOU}. {SPORE_BUYBACK}</span></div></li>
        </ol>
        <div className="empty-hero-cta"><Link className="btn lg accent" to="/launch">Launch the first coin</Link><Link className="btn lg ghost" to="/how">How it works</Link></div>
      </div>
      <TreePreview />
    </section>
  );
}

/// The six most traded launches as a snap strip of tilted cards; arrows page it on a pointer.
function MostActive({ feed, maxDepth }: { feed: Async<{ coins: Coin[] }>; maxDepth: number | undefined }) {
  const top = useMemo(() => [...(feed.data?.coins ?? [])]
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd || (b.lockedUsd ?? 0) - (a.lockedUsd ?? 0) || (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0))
    .slice(0, 6), [feed.data]);
  const strip = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const sync = () => {
    const el = strip.current;
    if (!el) return;
    setEdge({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 });
  };
  useEffect(sync, [top.length]);
  const page = (dir: 1 | -1) => {
    const el = strip.current;
    const card = el?.querySelector<HTMLElement>(".ma-card");
    if (!el || !card) return;
    el.scrollBy({ left: dir * (card.offsetWidth + 20), behavior: "smooth" });
  };
  const nav = top.length > 1 && (
    <div className="ma-nav">
      <button type="button" className="ma-arrow" onClick={() => page(-1)} disabled={edge.start} aria-label="Previous coins"><Arrow dir="left" /></button>
      <button type="button" className="ma-arrow" onClick={() => page(1)} disabled={edge.end} aria-label="Next coins"><Arrow /></button>
      <Link to="/explore?sort=new" className="more-link">All launches <Arrow /></Link>
    </div>
  );
  return (
    <section className="home-active" aria-labelledby="ha-title">
      <SectionHead n="04" id="ha-title" title="Most active on Spore · 24h" lede="Coins launched on Spore, ranked by trading in the last 24 hours." action={nav || <Link to="/explore?sort=new" className="more-link">All launches <Arrow /></Link>} />
      {feed.loading ? <div className="ma-strip" aria-hidden="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className="ma-card"><CoinCardSkeleton /></div>)}</div>
        : feed.error && !feed.data ? <ErrorBox error="The launch list did not load." retry={feed.reload} />
        : !top.length ? <Empty title="Nothing launched yet" hint="Coins launched on Spore appear here, the most traded first." action={<Link to="/launch" className="btn sm accent">Launch a coin</Link>} />
        : (
          <div ref={strip} className="ma-strip" onScroll={sync} tabIndex={0} role="region" aria-label="Most active coins, scroll sideways">
            {top.map((c, i) => (
              <Tilt key={c.mint} className="ma-card" max={3} style={{ "--i": i } as CSSProperties}>
                <CoinCard coin={c} rank={c.volume24hUsd > 0 ? i + 1 : undefined} action={<LaunchButton coin={c} maxDepth={maxDepth} variant="soft" label={`Launch under ${sym(c)}`} className="block" />} />
              </Tilt>
            ))}
          </div>
        )}
    </section>
  );
}

/// Roots ranked by what their children have locked: the trees worth launching under.
function BiggestTrees({ maxDepth }: { maxDepth: number | undefined }) {
  const roots = useAsync(() => api.roots("locked", 6, 0), []);
  const rows = roots.data?.roots ?? [];
  const top = Math.max(0, ...rows.map((r) => r.lockedUsd ?? 0));
  return (
    <section className="home-trees" aria-labelledby="ht-title">
      <SectionHead n="05" id="ht-title" title="Biggest trees" lede={<>Roots ranked by the parent coins their children have <Term k="locked">locked</Term>.</>} action={<Link to="/map" className="more-link">Open the map <Arrow /></Link>} />
      {roots.loading ? <div className="ht-list" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <TreeRowSkeleton key={i} />)}</div>
        : roots.error && !roots.data ? <ErrorBox error="The trees did not load." retry={roots.reload} />
        : !rows.length ? <Empty title="No trees yet" hint="A tree appears with the first coin launched under a root." action={<Link to="/launch" className="btn sm accent">Launch a root</Link>} />
        : <div className="ht-list">{rows.map((c, i) => <Reveal key={c.mint} i={i} className="ht-row"><TreeRow coin={c} rank={i + 1} maxDepth={maxDepth} metric="locked" top={top} /></Reveal>)}</div>}
    </section>
  );
}

export default function Home() {
  const { stats, error } = useStats();
  // One feed request feeds the pulse (backfill + the mints whose trades it reports) and the cards.
  const feed = useAsync(() => api.feed(60), []);
  const ours = stats?.mode === "ours";
  const launches = stats ? (ours ? stats.ourCoins ?? stats.coins : stats.coins) : null;
  const noSpawns = !!stats && (launches ?? 0) === 0;
  const maxDepth = stats?.maxDepth;
  return (
    <div className="home-page">
      <Arrival />
      <SporeColony className="home-colony" />
      <div className="home-pulse"><Pulse coins={feed.data?.coins ?? (feed.error ? [] : null)} /></div>
      <div className="container home">
        <HowWorks maxDepth={maxDepth ?? 2} />
        {noSpawns ? <EmptyLaunchpad /> : <NumbersSection stats={stats} error={error} />}
        <AgentsBand n={noSpawns ? "02" : "03"} />
        {!noSpawns && <MostActive feed={feed} maxDepth={maxDepth} />}
        {!noSpawns && <BiggestTrees maxDepth={maxDepth} />}
      </div>
    </div>
  );
}
