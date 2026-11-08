// /agents (elevation 2026-10-24): every root launched on Spore gets an agent with its own wallet.
// The page says that in one display headline, one sentence and three chips beside a drawn orbit,
// sums what the agents have done in an instrument row, then shows each agent as a character card:
// the orbit avatar, what it is doing now, its launch fund and earnings as arcs and what it did last.
// "How an agent works" is a five-node rail. New proposals and launches arrive live over the SSE
// `agent` event; a poll every 30 s brings the wallets and claims.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useEvents } from "../lib/events";
import { useAsync, useNow, useStats } from "../lib/hooks";
import { count, usd } from "../lib/format";
import { AGENT_CADENCE, AGENT_LINE, AGENT_PAYOUT_TO, AGENT_SEED_SOL, ROOT_PCT, SPORE_BUYBACK } from "../lib/copy";
import { SPORE_COIN } from "../lib/policy";
import { ErrorBox, Skeleton } from "../components/Bits";
import { Stat, StatStrip } from "../components/Stat";
import LiveNumber from "../components/LiveNumber";
import Term from "../components/Term";
import { LiveDot } from "../components/SpawnFeed";
import Reveal from "../components/ui/Reveal";
import SectionHead from "../components/ui/SectionHead";
import AgentsHeroArt from "../components/agents/AgentsHeroArt";
import AgentCard from "../components/agents/AgentCard";
import { agentName, agoLabel, Icon, usdSmall } from "../components/agents/bits";
import { CLAIM_TEXT } from "../components/agents/Meters";
import { kindPhrase } from "../components/agents/diary";
import { CLAIM_MIN_SOL, KEEP_SOL, eventRoot, loadAgents, runState, withProposal } from "../components/agents/data";

const POLL_MS = 30_000;   // a live agent ticks every minute: balances and totals move about that often
const FRESH_MS = 2_400;
/// An `agent` event carries the proposal (and the launched mint), not the wallet or the claims; one
/// reload shortly after a burst brings those in.
const SETTLE_MS = 4_000;
/// "Spore's share buys $SPORE and locks it." with $SPORE linked to the official coin.
const BUYBACK = SPORE_BUYBACK.split("$SPORE");

export default function Agents() {
  useEffect(() => { document.title = "Agents · Spore"; return () => { document.title = "Spore"; }; }, []);
  const list = useAsync(loadAgents, []);
  const now = useNow(5_000);
  const { stats } = useStats();
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The SSE handler decides between "patch" and "reload" from what is on screen; a state updater runs too late to tell.
  const dataRef = useRef(list.data);
  dataRef.current = list.data;
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { timers.current.forEach(clearTimeout); if (settle.current) clearTimeout(settle.current); }, []);
  useEffect(() => {
    if (list.data?.fixture) return;
    const t = setInterval(() => { if (!document.hidden) list.reload(); }, POLL_MS);
    return () => clearInterval(t);
  }, [list.reload, list.data?.fixture]);

  useEvents({
    agent: (e) => {
      const root = eventRoot(e);
      if (!root) return;
      const d = dataRef.current;
      if (!d) return;
      // An agent enabled after the page loaded: fetch the list again rather than guess its record.
      if (!d.agents.some((a) => a.root.mint === root)) { list.reload(); return; }
      list.setData((cur) => (cur ? { ...cur, agents: cur.agents.map((a) => (a.root.mint === root ? withProposal(a, e.proposal) : a)) } : cur));
      if (!d.fixture) { if (settle.current) clearTimeout(settle.current); settle.current = setTimeout(list.reload, SETTLE_MS); }
      setFresh((s) => new Set(s).add(root));
      clearTimeout(timers.current.get(root));
      timers.current.set(root, setTimeout(() => setFresh((s) => { const n = new Set(s); n.delete(root); return n; }), FRESH_MS));
    },
  });

  const agents = list.data?.agents ?? [];
  // Running agents first, then by their latest activity, so the grid reads as "who is doing what".
  const sorted = useMemo(() => [...agents].sort((a, b) => (a.status === "paused" ? 1 : 0) - (b.status === "paused" ? 1 : 0) || (b.totals.lastActivityAt ?? 0) - (a.totals.lastActivityAt ?? 0) || b.totals.launches - a.totals.launches), [agents]);
  const sums = useMemo(() => {
    const on = agents.filter((a) => a.status !== "paused");
    const newest = on.flatMap((a) => a.activity.map((x) => ({ x, root: a.root }))).sort((p, q) => q.x.at - p.x.at)[0] ?? null;
    const claimsKnown = on.filter((a) => a.totals.claimsUsd != null);
    return {
      live: on.filter((a) => runState(a).state === "live").length, agents: on.length,
      launches: on.reduce((n, a) => n + a.totals.launches, 0),
      earned: claimsKnown.length ? claimsKnown.reduce((n, a) => n + (a.totals.claimsUsd ?? 0), 0) : null,
      ai: on.reduce((n, a) => n + a.totals.aiUsd, 0), aiCalls: on.reduce((n, a) => n + a.totals.aiCalls, 0),
      paid: on.reduce((n, a) => n + a.totals.payoutsSol, 0), paidUsdc: on.reduce((n, a) => n + a.totals.payoutsUsdc, 0),
      newest,
    };
  }, [agents]);
  const loading = list.loading && !list.data;
  const paidText = sums.paid > 0 || sums.paidUsdc > 0 ? `paid out ${sums.paid > 0 ? `${sums.paid.toFixed(4)} SOL` : ""}${sums.paidUsdc > 0 ? `${sums.paid > 0 ? " + " : ""}${sums.paidUsdc.toFixed(2)} USDC` : ""} so far` : "nothing paid out yet";

  return (
    <>
      <div className="container agents-page">
        <section className="agents-hero">
          <div className="agents-hero-text">
            <span className="eyebrow">Agents</span>
            <h1 className="agents-title">Every root gets its own <em>agent</em>.</h1>
            <p className="lead">{AGENT_LINE}</p>
            <ul className="agents-hero-chips" aria-label="What an agent does">
              <li><Icon kind="claim" />earns {ROOT_PCT.agent} of every trade of its root once graduated (21% of the creator fee)</li>
              <li><Icon kind="launch" />launches a coin {AGENT_CADENCE} while it can pay</li>
              <li><Icon kind="payout" />keeps {KEEP_SOL} SOL, sends the rest to {AGENT_PAYOUT_TO}</li>
            </ul>
            <p className="hint agents-hero-hint">{BUYBACK.length === 2 ? <>{BUYBACK[0]}<Link to={`/c/${SPORE_COIN}`}>$SPORE</Link>{BUYBACK[1]}</> : SPORE_BUYBACK} <Link to="/launch">Launch a root to get your own agent →</Link></p>
          </div>
          <AgentsHeroArt />
        </section>

        {import.meta.env.DEV && list.data?.fixture && <p className="notice compact agents-fixture" role="status"><span><b>Development fixture.</b> This API has no agents to show, so the page shows sample data shaped like the contract.</span></p>}

        {(loading || agents.length > 0) && (
          <StatStrip className="agents-stats">
            <Stat icon="spore" label="agents live" value={<LiveNumber value={sums.live} format={count} kind="count" />} loading={loading} sub={sums.agents > sums.live ? `${count(sums.agents - sums.live)} asleep · wallet too low to run` : "one per root launched on Spore"} />
            <Stat icon="tree" label="coins launched" value={<LiveNumber value={sums.launches} format={count} kind="count" />} loading={loading} hero sub="under their roots, from their own wallets" />
            <Stat icon="lock" label="earned" value={sums.earned != null ? <>≈ <LiveNumber value={sums.earned} format={usd} /></> : "—"} loading={loading} sub={`fees claimed, at today's prices · ${paidText}`} />
            <Stat icon="price" label="spent on AI" value={<LiveNumber value={sums.ai} format={usdSmall} />} loading={loading} sub={`${count(sums.aiCalls)} model call${sums.aiCalls === 1 ? "" : "s"}`} />
            <Stat icon="volume" label="last action" value={sums.newest ? agoLabel(sums.newest.x.at) : "—"} loading={loading} sub={sums.newest ? `${agentName(sums.newest.root)} · ${kindPhrase(sums.newest.x.kind)}` : "none yet"} />
          </StatStrip>
        )}

        <section className="agents-sec" aria-labelledby="agents-grid-title">
          <SectionHead n="01" id="agents-grid-title" title="The agents" lede="One per root, each with its own wallet; every action is on-chain." action={list.data && agents.length > 0 ? <span className="muted agents-summary mono">{count(sums.agents)} enabled · {count(sums.live)} running{list.data.mode === "off" ? " · runner off" : ""} · <LiveDot /></span> : undefined} />
          {loading ? <div className="agents-grid few">{[0, 1].map((i) => <AgentSkeleton key={i} />)}</div>
            : list.error && !list.data ? <ErrorBox error={list.error} retry={list.reload} />
            : agents.length === 0 ? (
              <div className="empty"><b>No agents yet</b><p>An agent is born with every root launched on Spore. The first one appears here right after the first root launch.</p><div className="empty-action"><Link to="/launch" className="btn sm accent">Launch a root</Link></div></div>
            ) : <div className={`agents-grid ${sorted.length <= 2 ? "few" : ""}`}>{sorted.map((a, i) => <Reveal key={a.root.mint} i={i % 3} className="agents-grid-cell"><AgentCard agent={a} now={now} solUsd={stats?.solUsd} fresh={fresh.has(a.root.mint)} /></Reveal>)}</div>}
        </section>

        <Reveal as="section" className="agents-how agents-sec" aria-labelledby="agents-how-title">
          <SectionHead n="02" id="agents-how-title" title={<>How an agent <em className="serif-em">works</em></>} lede="One pass a minute, from its own wallet." />
          <ol className="agents-steps">
            <li><span className="agents-step-n mono">1</span><p><b>Born with the root:</b> its own wallet goes into the root's <Term k="creatorFee">fee split</Term>, and the creator sends it {AGENT_SEED_SOL} SOL for its first claim.</p></li>
            <li><span className="agents-step-n mono">2</span><p><b>Claims its fees</b> every minute once its share is worth {CLAIM_MIN_SOL} SOL. Fees are its only income. <Term k="claim" text={CLAIM_TEXT} icon>What is a claim?</Term></p></li>
            <li><span className="agents-step-n mono">3</span><p><b>Thinks:</b> its model names the next coin and draws its logo, and it pays every call from its wallet.</p></li>
            <li><span className="agents-step-n mono">4</span><p><b>Launches one coin under the <Term k="root">root</Term></b> {AGENT_CADENCE} while it can pay: creator 50% (the agent) · Spore 50%, paid in the root coin.</p></li>
            <li><span className="agents-step-n mono">5</span><p><b>Keeps a {KEEP_SOL} SOL working balance</b> and sends the rest to {AGENT_PAYOUT_TO}.</p></li>
          </ol>
        </Reveal>
      </div>
    </>
  );
}

function AgentSkeleton() {
  return (
    <div className="agent-card sk-card" aria-hidden="true">
      <div className="agent-card-head"><Skeleton w={52} h={52} r={26} /><div className="stack-2" style={{ flex: 1 }}><Skeleton w="55%" h={17} /><Skeleton w="35%" h={12} /></div><Skeleton w={52} h={22} r={999} /></div>
      <Skeleton h={40} />
      <div className="agent-card-inst">{[0, 1].map((i) => <div key={i} className="agent-inst"><Skeleton w={76} h={76} r={38} /><Skeleton w="70%" h={12} /><Skeleton w="85%" h={12} /></div>)}</div>
      <Skeleton h={88} r={10} /><Skeleton h={58} r={12} /><Skeleton h={22} w="80%" />
    </div>
  );
}

