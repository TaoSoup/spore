// /agents/:root (elevation 2026-10-24): one root agent as a character sheet. The orbit avatar, who it
// is and what it is doing right now, its fee jar and launch fund as instrument arcs that count up,
// whether it pays for itself as earned-vs-spent areas over its ledger (claims and launches marked),
// the fee rule as the chain has it on a 270° split arc, the coins it launched as tilted cards, its
// diary on a vertical rail with a glowing node per kind, its purpose and the ideas it designed as a
// compact stack. Live: SSE `agent` events fold proposals and launches in at once, SSE trades on the
// root shimmer the fee jar, and a 30 s poll brings wallets and claims; new diary entries slide in.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type ActivityItem, type AgentLaunched, type AgentProposal, type Coin } from "../lib/api";
import { useEvents } from "../lib/events";
import { useAsync, useNow, useStats } from "../lib/hooks";
import { age, count, short, usdCard, when } from "../lib/format";
import { ErrorBox, Logo, Skeleton, nameOf, sym } from "../components/Bits";
import Term from "../components/Term";
import { LiveDot } from "../components/SpawnFeed";
import SectionHead from "../components/ui/SectionHead";
import SlidingPill from "../components/ui/SlidingPill";
import Reveal from "../components/ui/Reveal";
import { SheetBackdrop } from "../components/agents/AgentsHeroArt";
import { AddressRow, AgentAvatar, Mini, agentName, agoLabel, CREATE_V2_TEXT, Icon, LaunchedCard, Palette, MOMENTUM_TEXT, ProposalLogo, ScoreBar, SIMULATED_TEXT, SimChip, SimDetails, SourceChip, StatusBadge, ThemeChips, FeeRule } from "../components/agents/bits";
import { FeeJar, LaunchFund, PaysForItself } from "../components/agents/Meters";
import ActivityBars from "../components/agents/ActivityBars";
import Diary from "../components/agents/DiaryList";
import { diffActivity, groupActivity, statusSentence } from "../components/agents/diary";
import { detailWithProposal, eventRoot, launchNeed, loadAgent, modelLabel, paletteTint, runState, toSec } from "../components/agents/data";

const POLL_MS = 30_000;
const FRESH_MS = 2_400;
const IDEA_OPEN_MS = 6_000;
const FEES_EVERY_MS = 15_000;
const LAUNCHED_PAGE = 8;
const IDEAS_PAGE = 5;
const NONE: ActivityItem[] = [];

export default function AgentDetail() {
  const { root = "" } = useParams();
  const page = useAsync(() => loadAgent(root), [root]);
  // One extra request for the root and its children's markets (the launched cards and the "born" age).
  const coinPage = useAsync(() => api.coin(root, { trades: false }).catch(() => null), [root]);
  const fees = useAsync(() => api.fees(root), [root]);
  const now = useNow(5_000);
  const { stats } = useStats();
  const [freshMint, setFreshMint] = useState<string | null>(null);
  const [freshIdea, setFreshIdea] = useState<string | null>(null);
  const [sheen, setSheen] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const lastFees = useRef(Date.now());
  const lastSheen = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);

  const found = page.data && !("missing" in page.data) ? page.data : null;
  const agent = found?.agent ?? null;
  useEffect(() => { document.title = agent ? `${agentName(agent.root)} · Spore` : "Agent · Spore"; return () => { document.title = "Spore"; }; }, [agent]);
  useEffect(() => {
    if (page.data?.fixture) return;
    const t = setInterval(() => { if (!document.hidden) page.reload(); }, POLL_MS);
    return () => clearInterval(t);
  }, [page.reload, page.data?.fixture]);
  useEvents({
    agent: (e) => {
      if (eventRoot(e) !== root) return;
      page.setData((d) => (d && !("missing" in d) ? { ...detailWithProposal(d, e.proposal), fixture: d.fixture } : d));
      const id = String(e.proposal.id);
      setFreshIdea(id); later(() => setFreshIdea((x) => (x === id ? null : x)), IDEA_OPEN_MS);
      const m = e.proposal.launched?.mint ?? null;
      if (m) { setFreshMint(m); later(() => setFreshMint((x) => (x === m ? null : x)), FRESH_MS); }
      if (!found?.fixture) { if (settle.current) clearTimeout(settle.current); settle.current = setTimeout(page.reload, 4_000); }
    },
    // A trade on the root fills the agent's fee jar: a sweep of light, and a fresh read at most every 15 s.
    trade: (t) => {
      if (t.mint !== root) return;
      if (Date.now() - lastSheen.current > 3_000) { lastSheen.current = Date.now(); setSheen((n) => n + 1); }
      if (Date.now() - lastFees.current > FEES_EVERY_MS) { lastFees.current = Date.now(); fees.reload(); }
    },
  });

  // New ledger lines since the previous read slide in.
  const activity = found?.activity ?? NONE;
  const prevKeys = useRef<Set<string> | null>(null);
  const [newKeys, setNewKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => { prevKeys.current = null; }, [root]);
  useEffect(() => {
    if (!found) return;
    const { keys, fresh } = diffActivity(prevKeys.current, activity);
    prevKeys.current = keys;
    if (!fresh.size) return;
    setNewKeys(fresh);
    later(() => setNewKeys((cur) => (cur === fresh ? new Set() : cur)), FRESH_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity]);
  const entries = useMemo(() => groupActivity(activity), [activity]);

  if (page.loading && !page.data) return <div className="container agent-page"><DetailSkeleton /></div>;
  const missing = !!page.data && "missing" in page.data;
  if (missing) return <Missing root={root} coin={coinPage.data?.coin ?? null} loading={coinPage.loading && !coinPage.data} />;
  if (page.error && !page.data) {
    return (
      <div className="container agent-page">
        <Link to="/agents" className="agent-back">← All agents</Link>
        <div className="page-head"><h1>Could not load this agent</h1></div>
        <ErrorBox error={page.error} retry={page.reload} />
      </div>
    );
  }
  if (!found || !agent) return null;
  const { proposals, launched } = found;
  const { profile, stats: aStats, totals, wallet } = agent;
  const tint = paletteTint(profile?.palette);
  const state = runState(agent);
  const S = sym(agent.root);
  const need = launchNeed(agent);
  const born = toSec(coinPage.data?.coin.createdAt);
  const lastAt = toSec(totals.lastActivityAt);
  const model = modelLabel(agent.model);
  const shares = fees.data?.shares ?? coinPage.data?.coin.shares ?? null;
  const title = agentName(agent.root).replace(/agent$/, "");

  return (
    <div className={`container agent-page st-${state.state}`} style={tint ? ({ "--tint": tint } as CSSProperties) : undefined}>
      <Link to="/agents" className="agent-back">← All agents</Link>

      <header className="card agent-sheet">
        <SheetBackdrop />
        <div className="agent-sheet-top">
          <AgentAvatar root={agent.root} state={state.state} size={84} />
          <div className="agent-sheet-id">
            <span className="label agent-sheet-kicker">root agent</span>
            <div className="agent-sheet-title"><h1>{title}<em>agent</em></h1><StatusBadge agent={agent} now={now} /></div>
            <p className="agent-sheet-meta mono">
              <span>born with <Link to={`/c/${agent.root.mint}`}>{S}</Link>{born ? <> <span title={when(born)}>{age(born)}</span> ago</> : null}</span>
              {model && <span>thinks with {model}</span>}
              {wallet && <span className="agent-sheet-wallet">wallet <AddressRow address={wallet.address} label="Agent wallet address" /></span>}
            </p>
          </div>
          <Link to={`/c/${agent.root.mint}`} className="btn ghost agent-sheet-cta">Open {S} <span className="arrow">→</span></Link>
        </div>
        <div className="agent-sheet-now">
          <p className="agent-sheet-status">{statusSentence(agent, entries, now, need)}</p>
          <dl className="agent-sheet-stats">
            <Mini label="passes">{count(aStats.runs)}</Mini>
            <Mini label="ideas">{count(aStats.proposals)}</Mini>
            <Mini label="coins">{count(totals.launches)}</Mini>
            <Mini label="model calls">{count(totals.aiCalls)}</Mini>
          </dl>
          <div className="agent-sheet-pulse">
            <ActivityBars activity={activity} now={now} />
            {lastAt != null && <span className={`agent-last mono ${now - lastAt < 60 ? "recent" : ""}`} title={when(lastAt)}><i aria-hidden="true" />last action {agoLabel(lastAt)}</span>}
          </div>
        </div>
        <div className="agent-sheet-meters">
          <FeeJar fees={fees.data} loading={fees.loading} agent={wallet?.address ?? null} symbol={S} sheen={sheen} />
          <LaunchFund wallet={wallet} need={need} />
        </div>
      </header>

      {import.meta.env.DEV && found.fixture && <p className="notice compact" role="status"><span><b>Development fixture.</b> This API has no agents to show; sample data shaped like the contract.</span></p>}

      <Reveal as="section" className="agent-sec" aria-labelledby="agent-pays-title">
        <SectionHead n="01" id="agent-pays-title" title={<>Does it pay for <em className="serif-em">itself</em>?</>} lede="What it claimed against what its launches and its model cost." />
        <div className="agent-economy">
          <section className="card pad agent-pays-card" aria-label="Earned against spent">
            <PaysForItself totals={totals} wallet={wallet} solUsd={stats?.solUsd} activity={activity} />
          </section>
          <section className="card pad agent-rule-card" aria-labelledby="agent-rule-title">
            <div className="agent-panel-head"><h3 id="agent-rule-title">Its income, on-chain</h3><span className="mono faint">{S}'s <Term k="creatorFee">creator fee</Term></span></div>
            <FeeRule symbol={S} shares={shares} agent={wallet?.address ?? null} loading={fees.loading && !fees.data && coinPage.loading} />
          </section>
        </div>
      </Reveal>

      <Launched launched={launched} kids={coinPage.data?.children ?? null} loading={coinPage.loading && !coinPage.data} root={agent.root.mint} S={S} palette={profile?.palette} freshMint={freshMint} asleep={state.state === "asleep"} />

      <Reveal as="section" className="agent-sec" aria-labelledby="agent-diary-title">
      <SectionHead n="03" id="agent-diary-title" title="Diary" lede="Every claim, launch, payout and model call, with its transaction." action={<span className="muted mono agent-panel-sub">{activity.length ? `${count(activity.length)}${activity.length >= 200 ? "+" : ""} ledger lines · newest first` : "nothing yet"} · <LiveDot /></span>} />
      <div className="agent-layout">
        <section className="card pad agent-diary-card" aria-label="Diary entries">
          <Diary activity={activity} now={now} launched={launched} palette={profile?.palette} newKeys={newKeys} />
        </section>

        <aside className="agent-side">
          <section className="card pad agent-profile" aria-labelledby="agent-purpose-title">
            <div className="agent-panel-head"><h3 id="agent-purpose-title">Its purpose</h3><SourceChip source={profile?.source} /></div>
            {profile ? (
              <>
                <p className="agent-profile-summary">{profile.summary}</p>
                <div className="agent-field"><span className="agent-label">Themes</span><ThemeChips themes={profile.themes} max={6} /></div>
                <details className="agent-field agent-more-fields">
                  <summary className="agent-label">Tone, limits and palette</summary>
                  <p><span className="agent-label">Tone</span> {profile.tone}</p>
                  {profile.avoid.length > 0 && <p className="muted"><span className="agent-label">Avoids</span> {profile.avoid.join(" · ")}</p>}
                  {profile.palette.length > 0 && <Palette colors={profile.palette} />}
                </details>
                <p className="hint">Learned from {S}'s name, ticker, description, socials and its children's names{toSec(profile.builtAt) ? `, ${agoLabel(profile.builtAt)}` : ""}.</p>
              </>
            ) : <p className="muted">Not built yet: the agent learns {S}'s purpose on its first pass.</p>}
          </section>
          <section className="card pad" aria-label="Root momentum">
            <ScoreBar score={aStats.score} reason={aStats.scoreReason} />
            <p className="agent-score-foot mono">{count(aStats.runs)} pass{aStats.runs === 1 ? "" : "es"} · {count(aStats.proposals)} idea{aStats.proposals === 1 ? "" : "s"}{aStats.lastRunAt ? <> · last pass <span title={when(toSec(aStats.lastRunAt))}>{agoLabel(aStats.lastRunAt)}</span></> : null}</p>
          </section>
        </aside>
      </div>
      </Reveal>

      <Ideas proposals={proposals} total={aStats.proposals} launched={launched} palette={profile?.palette} freshIdea={freshIdea} onSeen={() => setFreshIdea(null)} />
    </div>
  );
}

/* ---------- coins it launched (A7) */
function Launched({ launched, kids, loading, root, S, palette, freshMint, asleep }: { launched: AgentLaunched[]; kids: Coin[] | null; loading: boolean; root: string; S: string; palette?: string[] | null; freshMint: string | null; asleep: boolean }) {
  const [sort, setSort] = useState<"newest" | "biggest">("newest");
  const [all, setAll] = useState(false);
  const [pos, setPos] = useState(1);
  const byMint = useMemo(() => new Map((kids ?? []).map((c) => [c.mint, c])), [kids]);
  const market = (mint: string): Coin | null | undefined => (loading ? undefined : byMint.get(mint) ?? null);
  const sorted = useMemo(() => (sort === "newest" ? launched : [...launched].sort((a, b) => (byMint.get(b.mint)?.mcapUsd ?? -1) - (byMint.get(a.mint)?.mcapUsd ?? -1))), [launched, sort, byMint]);
  const shown = all ? sorted : sorted.slice(0, LAUNCHED_PAGE);
  const indexed = launched.map((l) => byMint.get(l.mint)).filter((c): c is Coin => !!c);
  const mcap = indexed.reduce((n, c) => n + (c.mcapUsd ?? 0), 0);
  const traded = indexed.filter((c) => c.trades24h > 0).length;
  const onScroll = (el: HTMLOListElement) => {
    const first = el.firstElementChild as HTMLElement | null;
    if (!first) return;
    const step = first.getBoundingClientRect().width + 12;
    const i = Math.min(shown.length, Math.max(1, Math.round(el.scrollLeft / step) + 1));
    if (i !== pos) setPos(i);
  };
  return (
    <Reveal as="section" className="agent-launched-sec agent-sec" aria-labelledby="agent-launched-title">
      <SectionHead n="02" id="agent-launched-title" title="Coins it launched" lede={<span className="mono">{launched.length ? <>{count(launched.length)} coin{launched.length === 1 ? "" : "s"}{indexed.length ? <> · combined mcap {usdCard(mcap)} · {count(traded)} traded today</> : null}</> : "none yet"}</span>} action={launched.length > 1 ? (
          <div className="agent-sec-tools">
            <div className="seg" role="group" aria-label="Sort coins">
              <SlidingPill />
              <button type="button" aria-pressed={sort === "newest"} onClick={() => setSort("newest")}>newest</button>
              <button type="button" aria-pressed={sort === "biggest"} onClick={() => setSort("biggest")}>biggest</button>
            </div>
            <Link to={`/map?focus=${root}`} className="more">see them on the map →</Link>
          </div>
        ) : undefined} />
      {launched.length === 0 ? (
        <div className="empty"><b>Nothing launched yet</b><p>{asleep ? "It starts launching once its wallet can pay for a launch." : `Its first coin goes out on an upcoming pass, once its wallet covers a launch: a name and a logo on ${S}'s theme, launched under it from its own wallet.`}</p></div>
      ) : (
        <>
          <ol className="agent-launched-grid" onScroll={(e) => onScroll(e.currentTarget)}>
            {shown.map((c, i) => <li key={c.mint}><LaunchedCard coin={c} market={market(c.mint)} palette={palette} eager={i < 4} fresh={freshMint === c.mint} /></li>)}
          </ol>
          <div className="agent-launched-foot">
            <span className="agent-launched-pos mono" aria-hidden="true">{pos} / {shown.length}</span>
            {sorted.length > LAUNCHED_PAGE && <button type="button" className="btn ghost sm" onClick={() => setAll((x) => !x)}>{all ? "Show fewer" : `Show all ${count(sorted.length)}`}</button>}
          </div>
        </>
      )}
    </Reveal>
  );
}

/* ---------- ideas it had (A8) */
function Ideas({ proposals, total, launched, palette, freshIdea, onSeen }: { proposals: AgentProposal[]; total: number; launched: AgentLaunched[]; palette?: string[] | null; freshIdea: string | null; onSeen: () => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [all, setAll] = useState(false);
  const shown = all ? proposals : proposals.slice(0, IDEAS_PAGE);
  const launchedMint = (p: AgentProposal) => launched.find((l) => l.symbol === p.symbol && l.name === p.name)?.mint ?? null;
  const toggle = (id: string, isOpen: boolean) => {
    if (freshIdea === id) onSeen();
    setOpen((s) => { const n = new Set(s); if (isOpen) n.delete(id); else n.add(id); return n; });
  };
  return (
    <Reveal as="section" className="agent-ideas agent-sec" aria-labelledby="agent-ideas-title">
      <SectionHead n="04" id="agent-ideas-title" title="Ideas it had" lede="Names it designed and tested before launch; launched ones link to the coin." action={proposals.length > 0 ? <span className="mono faint">{count(proposals.length)}{total > proposals.length ? ` of ${count(total)}` : ""}</span> : undefined} />
      {proposals.length === 0 ? (
        <div className="empty"><b>No ideas yet</b><p>Each coin the agent designs shows up here the moment it is made, with its logo, runners-up and a simulated launch.</p></div>
      ) : (
        <>
          <ol className={`agent-idea-list ${!all && proposals.length > IDEAS_PAGE ? "stacked" : ""}`}>
            {shown.map((p) => {
              const id = String(p.id);
              const isOpen = open.has(id) || freshIdea === id;
              return <IdeaRow key={id} p={p} palette={palette} launchedMint={launchedMint(p)} open={isOpen} fresh={freshIdea === id} onToggle={() => toggle(id, isOpen)} />;
            })}
          </ol>
          {proposals.length > IDEAS_PAGE && <button type="button" className="btn ghost sm agent-more" onClick={() => setAll((x) => !x)}>{all ? "Show the latest 5" : `Show all ${count(proposals.length)}`}</button>}
        </>
      )}
    </Reveal>
  );
}

function IdeaRow({ p, palette, launchedMint, open, fresh, onToggle }: { p: AgentProposal; palette?: string[] | null; launchedMint: string | null; open: boolean; fresh: boolean; onToggle: () => void }) {
  const panel = `idea-${p.id}`;
  const t = toSec(p.createdAt);
  return (
    <li className={`agent-idea ${p.status === "rejected" ? "rejected" : ""} ${fresh ? "is-new" : ""}`}>
      <button type="button" className="agent-idea-row" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <ProposalLogo p={p} palette={palette} size={40} />
        <span className="agent-idea-main">
          <span className="agent-idea-name"><b>{p.name}</b><span className="mono">${p.symbol}</span></span>
          <span className="agent-idea-chips">
            {launchedMint ? <span className="chip good">launched</span> : p.status === "rejected" ? <span className="chip bad">rejected</span> : null}
            <SourceChip source={p.source} />
          </span>
        </span>
        <span className="agent-idea-score mono" title="Root momentum when it was designed">{Math.round(p.score)}</span>
        <time className="mono" title={when(t)}>{t ? age(t) : "—"}</time>
        <Icon kind="chev" className="agent-idea-chev" />
      </button>
      {open && (
        <div id={panel} className="agent-idea-panel">
          <p className="agent-idea-desc">{p.description}</p>
          {p.why && <p className="agent-why big"><span className="agent-label">Why</span>{p.why}</p>}
          {p.status === "rejected" && p.rejectedReason && <p className="hint bad">Rejected: {p.rejectedReason}</p>}
          <p className="agent-idea-reason"><span className="agent-label"><Term k="agent" text={MOMENTUM_TEXT}>Momentum</Term> {Math.round(p.score)}</span>{p.reason.replace(/^momentum \d+\/100:\s*/i, "")}</p>
          <div className="agent-idea-sim">
            <SimChip sim={p.sim} />
            <span className="hint">the <Term k="agent" text={CREATE_V2_TEXT}>create_v2</Term> launch, <Term k="agent" text={SIMULATED_TEXT}>simulated</Term> before sending</span>
            <SimDetails sim={p.sim} />
          </div>
          {p.runnersUp.length > 0 && (
            <div className="agent-runners"><span className="agent-label">Runners-up</span>
              <ul>{p.runnersUp.map((r) => <li key={`${r.symbol}-${r.name}`}><b>{r.name}</b> <span className="mono">${r.symbol}</span></li>)}</ul>
            </div>
          )}
          {launchedMint && <Link to={`/c/${launchedMint}`} className="more">Open ${p.symbol} →</Link>}
        </div>
      )}
    </li>
  );
}

/* ---------- a root without an agent */
function Missing({ root, coin, loading }: { root: string; coin: Coin | null; loading: boolean }) {
  const S = coin ? sym(coin) : short(root);
  useEffect(() => { document.title = "No agent · Spore"; }, []);
  return (
    <div className="container agent-page">
      <Link to="/agents" className="agent-back">← All agents</Link>
      <section className="card agent-missing">
        {/* The coin on an empty, dashed orbit: no agent circles it. */}
        <span className="agent-missing-art">{loading ? <Skeleton w={72} h={72} r={36} /> : <Logo src={coin?.image} label={coin?.symbol ?? "?"} size={72} />}<i aria-hidden="true" /></span>
        <div className="agent-missing-text">
          <h1>{coin ? <>{nameOf(coin)} has no agent</> : "No agent for this coin"}</h1>
          <p className="lead">{coin && coin.depth > 0 ? `Agents are born with roots launched on Spore, and ${S} is not a root, so no agent runs for it.` : `Agents are born with roots launched on Spore, and ${S} has none, so nothing runs for it.`}</p>
          <div className="agent-missing-actions">
            <Link to={`/c/${root}`} className="btn accent">Open {S}</Link>
            <Link to="/agents" className="btn ghost">See all agents</Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="agent-skel" aria-busy="true">
      <Skeleton w={110} h={14} />
      <div className="card agent-sheet">
        <div className="agent-sheet-top"><Skeleton w={84} h={84} r={42} /><div className="agent-sheet-id"><Skeleton w={90} h={12} /><Skeleton w="55%" h={48} /><Skeleton w="70%" h={14} /></div></div>
        <div className="agent-sheet-now"><Skeleton h={30} w="80%" /><Skeleton h={58} r={10} /><Skeleton h={40} r={8} /></div>
        <div className="agent-sheet-meters">{[0, 1].map((i) => <div key={i} className="agent-gauge"><Skeleton w={150} h={150} r={75} /><Skeleton w={80} h={12} /><Skeleton w={110} h={20} /></div>)}</div>
      </div>
      <div className="agent-economy"><Skeleton h={340} r={16} /><Skeleton h={340} r={16} /></div>
      <Skeleton h={220} r={16} />
    </div>
  );
}
