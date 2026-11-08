import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Coin, type RootSort } from "../lib/api";
import { useEvents } from "../lib/events";
import { useAsync, useDebounced, useMediaQuery, useStats, useTick } from "../lib/hooks";
import { age, count, pctCurve, plural, usd, usdCard } from "../lib/format";
import { LISTS_SCOPE } from "../lib/copy";
import { agentProvenance, useAgentIndex, type AgentIndex } from "../lib/agent-index";
import Search from "../components/Search";
import SporeCanvas from "../components/SporeCanvas";
import Term from "../components/Term";
import CoinCard, { ChangeChip, CoinCardSkeleton, Sparkline, sparkTone, useOnScreen, useSparkline } from "../components/CoinCard";
import TreeRow, { TreeRowSkeleton, treeMetricValue, type TreeMetric } from "../components/TreeRow";
import LaunchButton from "../components/LaunchButton";
import { LiveDot } from "../components/SpawnFeed";
import { AgentChip, DepthBadge, ErrorBox, Logo, NoSpawnsYet, ParentPill, Skeleton, nameOf, sym } from "../components/Bits";
import SlidingPill from "../components/ui/SlidingPill";
import EmptySpore from "../components/illus/EmptySpore";
import { Filament, Illus, Motes, Node, Ring, curve } from "../components/illus/base";
import "../components/discover.css";

type Sort = "new" | "locked" | "mcap" | "children" | "volume";
type Tab = "coins" | "trees";
type View = "cards" | "rows" | "table";
type Grad = "any" | "yes" | "no";
type By = "any" | "agents" | "people";
/// Plain words on the buttons; the pump.fun / Spore term goes into the title.
const SORTS: { key: Sort; label: string; title: string }[] = [
  { key: "new", label: "Newest", title: "Newest launches first" },
  { key: "mcap", label: "Market cap", title: "Market cap (mcap): price × total supply, in dollars" },
  { key: "volume", label: "Volume 24h", title: "24h volume: dollars traded in the last 24 hours" },
  { key: "children", label: "Most children", title: "Children: coins launched directly under it, then every coin below it" },
  { key: "locked", label: "Locked", title: "Locked: value of parent tokens parked in its children's curves" },
];
const DEPTH_NAMES = ["Roots", "Children", "Grandchildren"];
const DEPTH_TITLES = ["Depth 0: the first coin of a tree, bought with SOL", "Depth 1: launched under a root, priced in it", "Depth 2: launched under a child"];
const STAGES: { key: Grad; label: string; title?: string }[] = [
  { key: "any", label: "Any" },
  { key: "no", label: "On the bonding curve", title: "Bonding curve: still trading on its pump.fun curve, not graduated yet" },
  { key: "yes", label: "Graduated to PumpSwap", title: "Graduated: its curve filled, so it trades in a PumpSwap pool" },
];
const BYS: { key: By; label: string; title?: string }[] = [
  { key: "any", label: "Anyone" },
  { key: "agents", label: "Agents", title: "Named, drawn and launched by a root's AI agent from its own wallet" },
  { key: "people", label: "People", title: "Launched by a person's wallet, not by an agent" },
];
const TREE_SORTS: { key: RootSort; label: string; explain: string }[] = [
  { key: "locked", label: "Locked", explain: "Locked = value of this root's tokens parked in its children's curves." },
  { key: "children", label: "Children", explain: "Children = every coin that grew under this root, at any depth." },
  { key: "volume", label: "Volume 24h", explain: "Volume 24h = dollars traded in the root coin itself over the last 24 hours." },
  { key: "new", label: "Newest", explain: "Newest = trees with the most recent launch under them first." },
];
const MINS = [0, 100, 1_000, 10_000, 100_000];
const PAGE = 60;
const ROOTS_PAGE = 50;
const LOCKED_TITLE = "Value of parent tokens parked in its children's curves";

const byNum = (f: (c: Coin) => number | null) => (a: Coin, b: Coin) => (f(b) ?? 0) - (f(a) ?? 0);
const ORDER: Record<Sort, (a: Coin, b: Coin) => number> = {
  new: byNum((c) => c.createdAt),
  locked: (a, b) => byNum((c) => c.lockedUsd)(a, b) || byNum((c) => c.mcapUsd)(a, b),
  mcap: (a, b) => byNum((c) => c.mcapUsd)(a, b) || byNum((c) => c.lockedUsd)(a, b),
  volume: (a, b) => byNum((c) => c.volume24hUsd)(a, b) || byNum((c) => c.mcapUsd)(a, b),
  children: (a, b) => byNum((c) => c.children)(a, b) || byNum((c) => c.descendants)(a, b) || byNum((c) => c.lockedUsd)(a, b),
};
const oneOf = <T extends string>(v: string | null, ok: readonly T[], dflt: T): T => (v && (ok as readonly string[]).includes(v) ? (v as T) : dflt);

/// Filter/sort/view state lives in the URL so a filtered list can be shared and survives reload;
/// defaults are omitted from the query string. Without `view=` a phone (≤ 560 px) gets rows.
function useExploreParams() {
  const [params, setParams] = useSearchParams();
  const narrow = useMediaQuery("(max-width: 560px)");
  const viewDefault: View = narrow ? "rows" : "cards";
  const state = {
    tab: oneOf<Tab>(params.get("tab"), ["coins", "trees"], "coins"),
    sort: oneOf<Sort>(params.get("sort"), ["new", "locked", "mcap", "volume", "children"], "new"),
    view: oneOf<View>(params.get("view"), ["cards", "rows", "table"], viewDefault),
    grad: oneOf<Grad>(params.get("grad"), ["any", "yes", "no"], "any"),
    by: oneOf<By>(params.get("by"), ["any", "agents", "people"], "any"),
    tsort: oneOf<RootSort>(params.get("tsort"), ["locked", "children", "volume", "new"], "locked"),
    depth: params.get("depth") != null && /^\d$/.test(params.get("depth")!) ? Number(params.get("depth")) : -1,
    min: MINS.includes(Number(params.get("min"))) ? Number(params.get("min")) : 0,
    q: params.get("q") ?? "",
  };
  const set = useCallback((patch: Partial<typeof state>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      const put = (k: string, v: string | number, dflt: string | number) => { if (String(v) === String(dflt)) n.delete(k); else n.set(k, String(v)); };
      if (patch.tab !== undefined) put("tab", patch.tab, "coins");
      if (patch.sort !== undefined) put("sort", patch.sort, "new");
      if (patch.view !== undefined) put("view", patch.view, viewDefault);
      if (patch.grad !== undefined) put("grad", patch.grad, "any");
      if (patch.by !== undefined) put("by", patch.by, "any");
      if (patch.tsort !== undefined) put("tsort", patch.tsort, "locked");
      if (patch.depth !== undefined) put("depth", patch.depth, -1);
      if (patch.min !== undefined) put("min", patch.min, 0);
      if (patch.q !== undefined) put("q", patch.q.trim(), "");
      return n;
    }, { replace: true });
  }, [setParams, viewDefault]);
  return [state, set] as const;
}

/// The feed, page by page (`before` = oldest createdAt seen), plus live prepends from SSE.
function useFeedPages() {
  const [coins, setCoins] = useState<Coin[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [done, setDone] = useState(false);
  const busy = useRef(false);
  const merge = (cur: Coin[], add: Coin[], front = false) => { const seen = new Set(cur.map((c) => c.mint)); const fresh = add.filter((c) => !seen.has(c.mint)); return front ? [...fresh, ...cur] : [...cur, ...fresh]; };
  const load = useCallback(async (before?: number) => {
    if (busy.current) return;
    busy.current = true;
    if (before === undefined) { setState("loading"); setDone(false); } else setMore(true);
    try {
      const r = await api.feed(PAGE, before);
      setCoins((cur) => (before === undefined ? r.coins : merge(cur, r.coins)));
      // A page shorter than asked, or one with no usable cursor, is the end of the feed.
      if (r.coins.length < PAGE || !r.coins.some((c) => c.createdAt != null)) setDone(true);
      setState("ready"); setError(null);
    } catch (e) {
      setError((e as Error).message);
      if (before === undefined) setState("error");
    } finally { busy.current = false; setMore(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const loadMore = useCallback(() => {
    if (done || busy.current) return;
    const oldest = coins.reduce<number | null>((m, c) => (c.createdAt != null && (m === null || c.createdAt < m) ? c.createdAt : m), null);
    if (oldest === null) { setDone(true); return; }
    load(oldest);
  }, [coins, done, load]);
  useEvents({ coin: (c: Coin) => setCoins((cur) => merge(cur, [c], true)) });
  return { coins, state, error, more, done, loadMore, reload: () => load() };
}

const matches = (c: Coin, needle: string) => {
  if (!needle) return true;
  const n = needle.toLowerCase().replace(/^\$/, "");
  return (c.symbol ?? "").toLowerCase().startsWith(n) || (c.name ?? "").toLowerCase().includes(n) || c.mint.toLowerCase().startsWith(n) || (c.parent?.symbol ?? "").toLowerCase() === n;
};
const byAgent = (c: Coin, index: AgentIndex) => agentProvenance(c, index)?.role === "child";

/// "the map" inside LISTS_SCOPE becomes a Term that explains what the map shows.
function ScopeHint({ extra }: { extra?: ReactNode }) {
  const i = LISTS_SCOPE.indexOf("the map");
  const text = i < 0 ? LISTS_SCOPE : <>{LISTS_SCOPE.slice(0, i)}<Term k="mapAll">the map</Term>{LISTS_SCOPE.slice(i + "the map".length)}</>;
  return <p className="ex-scope">{text}{extra}</p>;
}

/// A segmented group of plain-word options (toggle buttons, aria-pressed).
/// The pressed option carries a pill that slides to the next pick (SlidingPill).
function Seg<T extends string | number>({ label, value, options, onPick, wide = false, className = "" }: { label: string; value: T; options: { key: T; label: ReactNode; title?: string }[]; onPick: (k: T) => void; wide?: boolean; className?: string }) {
  return (
    <div className={`ex-group ${wide ? "wide" : ""} ${className}`} role="group" aria-label={label}>
      <span className="ex-group-label" aria-hidden="true">{label}</span>
      <div className="ex-opts"><SlidingPill items="button" />{options.map((o) => <button key={String(o.key)} type="button" aria-pressed={value === o.key} title={o.title} onClick={() => onPick(o.key)}>{o.label}</button>)}</div>
    </div>
  );
}

/// The depth key drawn in the illustration language: a root (lime) with a child (teal) on a filament and a
/// grandchild (violet) one step further, each labelled with its depth, over a faint spore cloud. It is the
/// colour legend of every list below (depth badges, the trees' orbits, search's depth lines).
function DepthKey() {
  const a = [44, 92] as const, b = [150, 52] as const, c = [246, 86] as const;
  return (
    <figure className="ex-key" aria-label="Depth colours: roots lime, children teal, grandchildren violet">
      <Illus viewBox="0 0 288 144" className="ex-key-art">
        <Motes seed={7} n={26} box={[8, 10, 272, 124]} tone={["lime", "teal", "violet"]} />
        <Ring cx={a[0]} cy={a[1]} r={24} opacity={0.22} />
        <Filament d={curve(a[0], a[1], b[0], b[1], -0.22)} tone="teal" mote />
        <Filament d={curve(b[0], b[1], c[0], c[1], 0.24)} tone="violet" mote delay={1.4} />
        <Filament d={curve(b[0], b[1], 196, 124, -0.2)} tone="teal" dashed opacity={0.4} />
        <Node cx={a[0]} cy={a[1]} r={11} tone="lime" pulse />
        <Node cx={b[0]} cy={b[1]} r={7.5} tone="teal" />
        <Node cx={c[0]} cy={c[1]} r={5} tone="violet" />
        <Node cx={196} cy={124} r={2.5} tone="teal" dim />
      </Illus>
      <figcaption aria-hidden="true">
        <span style={{ left: `${(a[0] / 288) * 100}%`, top: `${((a[1] + 30) / 144) * 100}%` }}><i className="d0" />d0 root</span>
        <span style={{ left: `${(b[0] / 288) * 100}%`, top: `${((b[1] - 30) / 144) * 100}%` }}><i className="d1" />d1 child</span>
        <span style={{ left: `${(c[0] / 288) * 100}%`, top: `${((c[1] + 22) / 144) * 100}%` }}><i className="d2" />d2 grandchild</span>
      </figcaption>
    </figure>
  );
}

/// The head's instrument row while /api/stats is in flight: the same labels and line boxes, skeleton values.
const SK_STATS: [string, number][] = [["Coins", 34], ["Trees", 22], ["Locked", 64], ["Volume 24h", 56]];
function ExStatsSkeleton() {
  return (
    <dl className="ex-stats is-pending" aria-hidden="true">
      {SK_STATS.map(([t, w]) => <div key={t}><dt>{t}</dt><dd><Skeleton w={w} h={15} className="sk-in" /></dd></div>)}
    </dl>
  );
}

const ICONS: Record<View, ReactNode> = {
  cards: <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="1" y="1" width="5" height="5" rx="1" /><rect x="8" y="1" width="5" height="5" rx="1" /><rect x="1" y="8" width="5" height="5" rx="1" /><rect x="8" y="8" width="5" height="5" rx="1" /></svg>,
  rows: <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="1" y="1" width="12" height="5" rx="1.4" /><rect x="1" y="8" width="12" height="5" rx="1.4" /></svg>,
  table: <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="1" y="1.5" width="12" height="2" rx="1" /><rect x="1" y="6" width="12" height="2" rx="1" /><rect x="1" y="10.5" width="12" height="2" rx="1" /></svg>,
};
const VIEW_NAMES: Record<View, string> = { cards: "Cards", rows: "Rows", table: "Table" };
/// The view switch reads as density: cards are airy, rows are a list, the table is compact.
const VIEW_HINT: Record<View, string> = { cards: "airy", rows: "list", table: "compact" };

/// True while a sticky bar is stuck under the nav (its top edge sits at its sticky offset): the bar then
/// detaches from the filter panel and floats as glass.
function useStuck<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const top = parseFloat(getComputedStyle(el).top) || 0;
    const io = new IntersectionObserver(([e]) => setStuck(e.intersectionRatio < 1 && e.boundingClientRect.top <= top + 2), { threshold: [1], rootMargin: `-${Math.round(top) + 1}px 0px 0px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, stuck];
}

/// Every coin launched through Spore: plain-word filters, sorts, filter-as-you-type, cards, rows or a
/// table, pages that load as you scroll, all in the URL. "Trees" ranks the roots the launches grew under.
export default function Explore() {
  const [st, set] = useExploreParams();
  const { stats, error: statsError } = useStats();
  // Until /api/stats answers, the instrument row and the tab count hold their final boxes (skeleton values),
  // so the lists below never jump when the numbers land (cold-load CLS).
  const statsPending = !stats && !statsError;
  const statsOn = stats?.mode === "ours" && stats.coins > 0;
  useEffect(() => { document.title = "Coins · Spore"; return () => { document.title = "Spore"; }; }, []);
  const tabs: Tab[] = ["coins", "trees"];
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = tabs[(tabs.indexOf(st.tab) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    set({ tab: next });
    document.getElementById(`ex-tab-${next}`)?.focus();
  };
  return (
    <>
      <SporeCanvas density={0.5} />
      <div className="container explore">
        <header className="page-head ex-head">
          <div className="ex-head-text">
            <span className="eyebrow">Explore</span>
            <h1>Coins launched<br /> on <em>Spore</em></h1>
            <p className="lead">Pick any coin and press “Launch under” (the sprout) to launch your own coin priced in it.</p>
            <ScopeHint extra={<> <Link to="/map" className="ex-maplink">Open the map <span aria-hidden="true">→</span></Link></>} />
            {statsPending && <ExStatsSkeleton />}
            {statsOn && (
              <dl className="ex-stats" aria-label="Spore launches at a glance">
                <div><dt>Coins</dt><dd>{count(stats.coins)}</dd></div>
                <div><dt>Trees</dt><dd className={stats.roots ? "" : "is-zero"}>{count(stats.roots)}</dd></div>
                <div><dt><Term k="locked">Locked</Term></dt><dd className={stats.lockedUsd >= 0.01 ? "accent" : "is-zero"}>{usdCard(stats.lockedUsd)}</dd></div>
                <div><dt>Volume 24h</dt><dd className={stats.volume24hUsd > 0 ? "" : "is-zero"}>{usdCard(stats.volume24hUsd)}</dd></div>
              </dl>
            )}
          </div>
          <DepthKey />
        </header>

        <section className="ex-body">
          <div className="ex-tabs" role="tablist" aria-label="What to list">
            <SlidingPill items="button" className="ex-tabs-pill" />
            <button type="button" role="tab" id="ex-tab-coins" aria-controls="ex-panel-coins" aria-selected={st.tab === "coins"} tabIndex={st.tab === "coins" ? 0 : -1} onKeyDown={onTabKey} onClick={() => set({ tab: "coins" })}>
              Coins{statsOn ? <small>{count(stats.coins)}</small> : statsPending ? <small className="is-pending" aria-hidden="true">{" "}</small> : null}
            </button>
            <button type="button" role="tab" id="ex-tab-trees" aria-controls="ex-panel-trees" aria-selected={st.tab === "trees"} tabIndex={st.tab === "trees" ? 0 : -1} onKeyDown={onTabKey} onClick={() => set({ tab: "trees" })} title="The roots the launches grew under, ranked">
              Trees
            </button>
          </div>
          {st.tab === "trees"
            ? <div role="tabpanel" id="ex-panel-trees" aria-labelledby="ex-tab-trees" className="ex-panelwrap"><Roots sort={st.tsort} onSort={(s) => set({ tsort: s })} maxDepth={stats?.maxDepth} /></div>
            : <div role="tabpanel" id="ex-panel-coins" aria-labelledby="ex-tab-coins" className="ex-panelwrap"><Coins st={st} set={set} maxDepth={stats?.maxDepth} /></div>}
        </section>
      </div>
    </>
  );
}

type St = ReturnType<typeof useExploreParams>[0];
type SetSt = ReturnType<typeof useExploreParams>[1];

function Coins({ st, set, maxDepth }: { st: St; set: SetSt; maxDepth: number | undefined }) {
  const feed = useFeedPages();
  const index = useAgentIndex();
  const phone = useMediaQuery("(max-width: 760px)");
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [bar, stuck] = useStuck<HTMLDivElement>();
  // When a list first lands (or the view changes) its first items rise in, staggered; the class comes off
  // after the stagger, so later live updates (new coins, trade rings) never replay it.
  const [entering, setEntering] = useState(false);
  const ready = feed.state === "ready";
  useEffect(() => {
    if (!ready) return;
    setEntering(true);
    const t = setTimeout(() => setEntering(false), 1_600);
    return () => clearTimeout(t);
  }, [ready, st.view]);
  const enter = entering ? "is-entering" : "";
  const dq = useDebounced(st.q, 120);
  useTick(30_000);
  useEvents({ coin: (c: Coin) => { setFresh((s) => new Set(s).add(c.mint)); setTimeout(() => setFresh((s) => { const n = new Set(s); n.delete(c.mint); return n; }), 5_000); } });

  const depths = useMemo(() => Array.from({ length: (maxDepth ?? 2) + 1 }, (_, d) => d), [maxDepth]);
  const byDepth = useMemo(() => { const n = new Map<number, number>(); for (const c of feed.coins) n.set(c.depth, (n.get(c.depth) ?? 0) + 1); return n; }, [feed.coins]);
  // Until the agent list answers, "Launched by" cannot tell agents from people: it is not applied.
  const byOn = st.by !== "any" && index.ready;
  const filtered = useMemo(() => feed.coins.filter((c) =>
    (st.depth < 0 || c.depth === st.depth) && (st.grad === "any" || (st.grad === "yes") === c.migrated) && ((c.lockedUsd ?? 0) >= st.min)
    && (!byOn || (st.by === "agents") === byAgent(c, index)) && matches(c, dq)).sort(ORDER[st.sort]),
  [feed.coins, st.depth, st.grad, st.min, st.sort, st.by, byOn, index, dq]);
  const active = (st.depth >= 0 ? 1 : 0) + (st.grad !== "any" ? 1 : 0) + (st.min > 0 ? 1 : 0) + (st.by !== "any" ? 1 : 0);
  const filtering = active > 0 || dq.trim() !== "";

  // Infinite scroll: a sentinel under the list asks for the next page; with filters on, keep
  // paging while the visible list is short so a narrow filter still finds older matches.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || feed.done) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) feed.loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [feed.done, feed.loadMore]);
  useEffect(() => { if (filtering && !feed.done && feed.state === "ready" && filtered.length < 12) feed.loadMore(); }, [filtering, filtered.length, feed.done, feed.state, feed.loadMore]);

  // Phone filter panel: Done, Esc or a tap outside closes it; opening it brings it into view.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); toggle.current?.focus(); } };
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (!panel.current?.contains(t) && !toggle.current?.contains(t)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    const r = panel.current?.getBoundingClientRect();
    if (r && r.top < 0) panel.current?.scrollIntoView({ block: "start" });
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open]);
  useEffect(() => { if (!phone) setOpen(false); }, [phone]);

  const n = filtered.length, total = feed.coins.length;
  const reset = () => set({ depth: -1, grad: "any", min: 0, q: "", by: "any" });
  const sortLabel = SORTS.find((s) => s.key === st.sort)?.label ?? "";
  const lockedShare = n ? filtered.filter((c) => (c.lockedUsd ?? 0) > 0).length / n : 1;
  const launch = (c: Coin, variant: "soft" | "icon") => variant === "icon"
    ? <LaunchButton coin={c} maxDepth={maxDepth} variant="icon" size="md" />
    : <LaunchButton coin={c} maxDepth={maxDepth} variant="soft" className="block" label="Launch under" />;

  // While the feed loads, each count keeps an empty slot of its final width, so the groups never re-wrap.
  const pendingN = feed.state === "loading" ? <b className="is-pending" aria-hidden="true">{" "}</b> : null;
  const depthOpts = [{ key: -1, label: <>Any{total > 0 ? <b>{count(total)}</b> : pendingN}</>, title: "Every depth" }, ...depths.map((d) => ({
    key: d, title: DEPTH_TITLES[d] ?? `Depth ${d}`,
    label: <>{DEPTH_NAMES[d] ?? `Depth ${d}`} <span className="ex-d">d{d}</span>{feed.state === "ready" ? <b>{count(byDepth.get(d) ?? 0)}</b> : pendingN}</>,
  }))];

  return (
    <>
      <div className={`ex-panel ${open ? "is-open" : ""}`} id="ex-filters" ref={panel}>
        <Seg label="Sort" value={st.sort} options={SORTS} onPick={(k) => set({ sort: k })} wide className="ex-g-sort" />
        <Seg label="Depth" value={st.depth} options={depthOpts} onPick={(k) => set({ depth: k })} wide />
        <Seg label="Stage" value={st.grad} options={STAGES} onPick={(k) => set({ grad: k })} />
        <Seg label="Launched by" value={st.by} options={BYS} onPick={(k) => set({ by: k })} />
        <label className="ex-group ex-min" title={LOCKED_TITLE}>
          <span className="ex-group-label">Min locked</span>
          <select className="filter-sel" value={st.min} onChange={(e) => set({ min: Number(e.target.value) })}>{MINS.map((m) => <option key={m} value={m}>{m === 0 ? "Any" : `≥ ${usd(m)}`}</option>)}</select>
        </label>
        <div className="ex-panel-foot">
          {active > 0 && <button type="button" className="btn sm ghost" onClick={reset}>Clear filters</button>}
          <button type="button" className="btn sm ex-done" onClick={() => { setOpen(false); toggle.current?.focus(); }}>Done</button>
        </div>
      </div>

      <div className={`ex-sticky ${stuck ? "is-stuck" : ""}`} ref={bar}>
        <div className="filter-search">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
          <input className="input" type="search" value={st.q} onChange={(e) => set({ q: e.target.value })} placeholder={phone ? "Filter…" : "Filter by name, ticker, parent or mint…"} aria-label="Filter coins by name, ticker, parent or mint" autoComplete="off" spellCheck={false} enterKeyHint="search" />
          {st.q && <button type="button" className="clear" aria-label="Clear filter" onClick={() => set({ q: "" })}>×</button>}
        </div>
        <button type="button" ref={toggle} className={`btn sm ghost ex-filters-btn ${active ? "on" : ""}`} aria-expanded={open} aria-controls="ex-filters" onClick={() => setOpen((o) => !o)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M2 4h12M4.5 8h7M7 12h2" /></svg>
          <span className="ex-filters-word">Filters</span>{active > 0 && <b>{active}<span className="sr-only"> active</span></b>}
        </button>
        <Seg label="Sort" value={st.sort} options={SORTS} onPick={(k) => set({ sort: k })} className="ex-sort-inline" />
        <div className="view-toggle" role="group" aria-label="View">
          <SlidingPill items="button" />
          {(["cards", "rows", "table"] as View[]).map((v) => <button key={v} type="button" aria-pressed={st.view === v} title={`${VIEW_NAMES[v]} · ${VIEW_HINT[v]}`} aria-label={VIEW_NAMES[v]} onClick={() => set({ view: v })}>{ICONS[v]}</button>)}
        </div>
      </div>

      <div className="explore-body">
        {/* the meta line holds its box while the first page loads, so the list below starts where it stays */}
        {feed.state === "loading" && (
          <div className="explore-meta" aria-hidden="true">
            <p><span>Sorted by <b>{sortLabel}</b> · <Skeleton w={24} h={11} className="sk-in" /> coins</span></p>
            <span className="ex-meta-r"><LiveDot /></span>
          </div>
        )}
        {feed.state === "loading" ? (
          st.view === "table" ? <TableSkeleton /> : st.view === "rows" ? <div className="ex-rows"><RowsHead />{Array.from({ length: 8 }, (_, i) => <CoinCardSkeleton key={i} size="row" />)}</div>
            : <div className="grid-cards ex-cards">{Array.from({ length: 8 }, (_, i) => <CoinCardSkeleton key={i} />)}</div>
        ) : feed.state === "error" ? <ErrorBox error="The coin list is not answering right now. Check your connection, then retry." retry={feed.reload} />
          // An empty list is the launchpad's starting state, not a broken page: the card says so.
          : total === 0 ? <NoSpawnsYet hint={LISTS_SCOPE} />
          : <>
              <div className="explore-meta">
                <p>
                  <span>Sorted by <b>{sortLabel}</b> · {filtering ? <><b>{count(n)}</b> of {count(total)}{feed.done ? "" : "+"} coins</> : <><b>{count(total)}</b>{feed.done ? "" : "+"} coin{total === 1 ? "" : "s"}</>}</span>
                  {st.sort === "locked" && n > 0 && lockedShare < 0.25 && <span className="ex-note">Most coins have no children yet, so locked is $0 for them.</span>}
                  {st.by !== "any" && !index.ready && <span className="ex-note">Checking which coins agents launched…</span>}
                </p>
                <span className="ex-meta-r">{filtering && <button type="button" className="linkish" onClick={reset}>Clear filters</button>}<LiveDot /></span>
              </div>
              {n === 0 ? (
                <div className="explore-none" role="status">
                  <EmptySpore className="explore-none-art" />
                  <b>No coin matches these filters{feed.done ? "" : " yet"}.</b>
                  <span>{feed.done ? "Loosen a filter or clear them all." : "Older pages are still loading…"}</span>
                  <button type="button" className="btn sm ghost" onClick={reset}>Clear filters</button>
                </div>
              ) : st.view === "table" ? <CoinTable className={enter} coins={filtered} sort={st.sort} onSort={(s) => set({ sort: s })} fresh={fresh} launch={(c) => phone ? launch(c, "icon") : <LaunchButton coin={c} maxDepth={maxDepth} variant="soft" size="sm" label="Launch" />} index={index} maxDepth={maxDepth} />
                : st.view === "rows" ? <div className={`ex-rows ${enter}`}><RowsHead sort={st.sort} />{filtered.map((c) => <CoinCard key={c.mint} coin={c} size="row" fresh={fresh.has(c.mint)} action={launch(c, "icon")} />)}</div>
                : <div className={`grid-cards ex-cards ${enter}`}>{filtered.map((c) => <CoinCard key={c.mint} coin={c} fresh={fresh.has(c.mint)} maxDepth={maxDepth} action={launch(c, "soft")} />)}</div>}
              <div ref={sentinel} className="explore-sentinel" aria-hidden="true" />
              {feed.more ? <div className="explore-more"><span className="search-busy" style={{ position: "static", margin: 0 }} aria-hidden="true" />Loading older launches…</div>
                : feed.done ? <div className="explore-end">That&apos;s every coin launched on Spore · {plural(total, "coin")}</div>
                : <div className="explore-more"><button type="button" className="btn ghost sm" onClick={feed.loadMore}>Load older</button></div>}
              {feed.error && feed.state === "ready" && <ErrorBox error="Older launches did not load." retry={feed.loadMore} compact />}
            </>}
      </div>
    </>
  );
}

/// The list view's column heads (shown once the list is wide enough for its columns); the sorted one is lit.
function RowsHead({ sort }: { sort?: Sort }) {
  return (
    <div className="ex-rows-head" aria-hidden="true">
      <span className="c-coin">Coin</span><span className="c-spark">24h</span>
      <span className={`num ${sort === "volume" ? "is-sorted" : ""}`}>Vol 24h</span><span className={`num ${sort === "mcap" ? "is-sorted" : ""}`}>Market cap</span><span />
    </div>
  );
}

/// Sparkline cell for the table: fetched when the row is on screen (and only for coins that traded), cached with the cards.
function RowSpark({ coin }: { coin: Coin }) {
  const [ref, seen] = useOnScreen<HTMLDivElement>();
  const sp = useSparkline(coin.mint, seen && coin.trades24h > 0);
  return (
    <div ref={ref} role="cell" className="ctable-spark c-spark">
      {sp ? <><Sparkline points={sp.points} tone={sparkTone(sp)} /><ChangeChip spark={sp} className="ctable-chg" /></> : <span className="is-zero ctable-flat">{coin.trades24h === 0 ? "no trades" : sp === null ? "—" : ""}</span>}
    </div>
  );
}

function TableSkeleton() {
  return <div className="ctable card" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <div key={i} className="ctable-row sk-row"><span className="ctable-coin c-coin"><Skeleton w={32} h={32} r={16} /><span className="ctable-name"><Skeleton w={120} h={13} /><Skeleton w={80} h={11} /></span></span><Skeleton className="c-mcap" w={60} h={13} style={{ justifySelf: "end" }} /><Skeleton className="c-act" w={36} h={32} r={16} style={{ justifySelf: "end" }} /></div>)}</div>;
}

function CoinTable({ coins, sort, onSort, fresh, launch, index, maxDepth, className = "" }: { className?: string; coins: Coin[]; sort: Sort; onSort: (s: Sort) => void; fresh: Set<string>; launch: (c: Coin) => ReactNode; index: AgentIndex; maxDepth: number | undefined }) {
  const Head = ({ k, children, className = "", title }: { k?: Sort; children: ReactNode; className?: string; title?: string }) => k
    ? <span role="columnheader" aria-sort={sort === k ? "descending" : undefined} className={`${className} ${sort === k ? "is-sorted" : ""}`}><button type="button" aria-pressed={sort === k} title={title ?? `Sort by ${String(children).toLowerCase()}`} onClick={() => onSort(k)}>{children}<span className="ctable-arrow" aria-hidden="true">↓</span></button></span>
    : <span role="columnheader" className={className} title={title}>{children}</span>;
  const lit = (k: Sort) => (sort === k ? "is-sorted" : "");
  return (
    <div className={`ctable card ${className}`} role="table" aria-label={`Coins, sorted by ${SORTS.find((s) => s.key === sort)?.label.toLowerCase() ?? sort}`}>
      <div className="ctable-row head" role="row">
        <Head className="c-coin">Coin</Head><Head className="c-under">Under</Head><Head k="mcap" className="num c-mcap" title="Sort by market cap">Market cap</Head><Head k="locked" className="num c-locked" title={`Sort by locked: ${LOCKED_TITLE.toLowerCase()}`}>Locked</Head>
        <Head k="volume" className="num c-vol" title="Sort by 24h volume">Vol 24h</Head><Head k="children" className="num c-kids" title="Sort by children">Children</Head><Head className="c-spark">24h</Head><Head className="num c-curve" title="Bonding curve progress to graduation">Curve</Head><Head className="c-act"><span className="sr-only">Launch</span></Head>
      </div>
      {coins.map((c) => {
        const prov = agentProvenance(c, index);
        return (
          <div key={c.mint} role="row" className={`ctable-row ${fresh.has(c.mint) ? "is-new" : ""}`}>
            <span role="cell" className="ctable-coin c-coin">
              <Logo src={c.image} label={c.symbol} size={32} />
              <span className="ctable-name"><b><Link className="stretch-link" to={`/c/${c.mint}`} title={nameOf(c)}>{nameOf(c)}</Link></b><span>{sym(c)} · {age(c.createdAt)}{c.migrated ? " · graduated" : ""}</span></span>
            </span>
            <span role="cell" className={`ctable-parent c-under ${prov?.role === "child" && prov.agent.root.mint === c.parent?.mint ? "same-root" : ""}`}><DepthBadge depth={c.depth} maxDepth={maxDepth} /><ParentPill parent={c.parent} />{prov && <AgentChip prov={prov} />}</span>
            <span role="cell" className={`num c-mcap ${lit("mcap")} ${c.mcapUsd === 0 ? "is-zero" : ""}`}>{usdCard(c.mcapUsd)}</span>
            <span role="cell" className={`num c-locked ${lit("locked")} ${(c.lockedUsd ?? 0) >= 0.01 ? "accent" : "is-zero"}`}>{usdCard(c.lockedUsd)}</span>
            <span role="cell" className={`num c-vol ${lit("volume")} ${c.volume24hUsd ? "" : "is-zero"}`}>{usdCard(c.volume24hUsd)}</span>
            <span role="cell" className={`num c-kids ${lit("children")} ${c.children ? "" : "is-zero"}`}>{count(c.children)}{c.descendants > c.children ? <small> / {count(c.descendants)}</small> : null}</span>
            <RowSpark coin={c} />
            <span role="cell" className="ctable-progress c-curve">{c.migrated ? <span>PumpSwap</span> : <span className={c.progress > 0 ? "" : "is-zero"}>{pctCurve(c.progress)}</span>}<span className={`cc-bar ${c.migrated ? "done" : ""}`} aria-hidden="true"><i style={{ width: `${c.migrated ? 100 : Math.max(c.progress > 0 ? 2 : 0, Math.min(100, c.progress * 100))}%` }} /></span></span>
            <span role="cell" className="ctable-action c-act">{launch(c)}</span>
          </div>
        );
      })}
    </div>
  );
}

/// The trees board: roots ranked by the chosen metric (server order), with load more.
function Roots({ sort, onSort, maxDepth }: { sort: RootSort; onSort: (s: RootSort) => void; maxDepth: number | undefined }) {
  const [extra, setExtra] = useState<{ sort: RootSort; coins: Coin[] }>({ sort, coins: [] });
  const [more, setMore] = useState(false);
  const [exhausted, setExhausted] = useState<RootSort | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const page = useAsync(() => api.roots(sort, ROOTS_PAGE, 0), [sort]);
  const first = page.data?.roots ?? [];
  const rows = extra.sort === sort ? [...first, ...extra.coins.filter((c) => !first.some((f) => f.mint === c.mint))] : first;
  const metric: TreeMetric = sort;
  const top = rows.reduce((m, c) => Math.max(m, treeMetricValue(c, metric)), 0);
  const total = (page.data as { total?: number } | null)?.total;
  const explain = TREE_SORTS.find((t) => t.key === sort)?.explain;
  async function loadMore() {
    setMore(true); setMoreError(null);
    try {
      const r = await api.roots(sort, ROOTS_PAGE, rows.length);
      setExtra((x) => ({ sort, coins: x.sort === sort ? [...x.coins, ...r.roots] : r.roots }));
      if (r.roots.length < ROOTS_PAGE) setExhausted(sort);
    } catch { setMoreError("More trees did not load."); }
    finally { setMore(false); }
  }
  const phone = useMediaQuery("(max-width: 760px)");
  const search = <Search size="md" label="Jump to any pump.fun coin" placeholder="Jump to any pump.fun coin…" />;
  const empty = !page.loading && !(page.error && !page.data) && rows.length === 0;
  const end = !page.loading && rows.length > 0 && (exhausted === sort || (total != null && rows.length >= total) || rows.length < ROOTS_PAGE);
  return (
    <>
      {/* phones: the search sits above and the rank tabs are the one sticky row; wider screens share the row */}
      {phone && <div className="ex-trees-head">{search}</div>}
      <div className="ex-sticky ex-sticky-trees">
        <div className="ex-tsort" role="group" aria-label="Rank trees by">
          <span className="ex-group-label" aria-hidden="true">Rank by</span>
          <div className="ex-opts"><SlidingPill items="button" />{TREE_SORTS.map((t) => <button key={t.key} type="button" aria-pressed={sort === t.key} onClick={() => onSort(t.key)}>{t.label}</button>)}</div>
        </div>
        {!phone && search}
      </div>
      <div className="explore-meta">
        <p><span className="ex-explain">{explain}</span>{total != null && total > 0 ? <span className="ex-count"><b>{count(total)}</b> tree{total === 1 ? "" : "s"}</span>
          : page.loading ? <span className="ex-count" aria-hidden="true"><Skeleton w={16} h={11} className="sk-in" /> trees</span> : null}</p>
        <span className="ex-meta-r"><LiveDot /></span>
      </div>
      {empty ? <NoSpawnsYet hint={LISTS_SCOPE} />
        : page.error && !page.data ? <ErrorBox error="The trees are not answering right now. Check your connection, then retry." retry={page.reload} />
        : (
          <div className="trees card ex-board">
            {page.loading ? Array.from({ length: 8 }, (_, i) => <TreeRowSkeleton key={i} />)
              : rows.map((c, i) => <TreeRow key={c.mint} coin={c} rank={i + 1} maxDepth={maxDepth} metric={metric} top={top} />)}
          </div>
        )}
      {moreError && <ErrorBox error={moreError} retry={loadMore} compact />}
      {!page.loading && !end && rows.length > 0 && <div className="explore-more"><button type="button" className="btn ghost" disabled={more} onClick={loadMore}>{more ? "Loading…" : "Load more"}</button></div>}
      {end && <div className="explore-end">That&apos;s every tree · {plural(rows.length, "tree")}</div>}
    </>
  );
}
