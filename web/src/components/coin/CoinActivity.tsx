// The coin page's one Activity card: Trades | Children | Family tree. The tab mirrors the URL hash
// (#trades, #children, #tree) without a router navigation, the arrow keys move between tabs, and the
// family tree (a canvas and its worker) is only loaded the first time its tab opens.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { pumpUrl, solscanAccount, solscanTx, type Coin, type Trade } from "../../lib/api";
import { agentProvenance, useAgentIndex } from "../../lib/agent-index";
import { useNow } from "../../lib/hooks";
import { age, amount, clock, count, plural, price, short, tokens, usd, usdCard, when } from "../../lib/format";
import { AgentChip, Empty, Ext, Logo, nameOf, sym } from "../Bits";
import { CoinBubbleMap } from "../BubbleMap";
import LaunchButton, { launchBlock } from "../LaunchButton";
import { LiveDot } from "../SpawnFeed";
import Term from "../Term";
import SlidingPill from "../ui/SlidingPill";
import { useInView } from "../../lib/motion";
import RadialTree from "./RadialTree";
import { HeatStrip, Sparkline, sparkLabel, sparkTone, useSpark } from "./viz";
import { MAX_TRADES, NEW_CHILD_MS, tradeUsd, useLive, type LiveCoin } from "./useLiveCoin";

export type ActivityTab = "trades" | "children" | "tree";
export const ACTIVITY_TABS: ActivityTab[] = ["trades", "children", "tree"];
export const isActivityTab = (s: string): s is ActivityTab => (ACTIVITY_TABS as string[]).includes(s);
/// Trades when there are any, else Children when there are any, else the tree.
export const defaultTab = (trades: number, children: number): ActivityTab => (trades > 0 ? "trades" : children > 0 ? "children" : "tree");

/// The tree map (a canvas and its layout worker) is the heaviest thing on the page: it mounts the
/// first time its tab opens, and is memoized so a trade on the tape never re-renders the canvas host.
/// (BubbleMap is in the main bundle already, through the map page, so a dynamic import would not split it.)
const FamilyTree = memo(function FamilyTree({ mint, height }: { mint: string; height: number }) {
  return <CoinBubbleMap mint={mint} height={height} />;
});

type Props = { store: LiveCoin; tab: ActivityTab; onTab: (t: ActivityTab) => void; maxDepth: number | undefined; narrow: boolean; otherChildren?: number };

export default function CoinActivity({ store, tab, onTab, maxDepth, narrow, otherChildren = 0 }: Props) {
  // Name, mint and ancestry never change; only the counts are live.
  const coin = store.get().coin;
  const nChildren = useLive(store, (s) => s.coin.children);
  const nDesc = useLive(store, (s) => s.coin.descendants);
  const nTrades = useLive(store, (s) => s.trades.length);
  const kidPulse = useLive(store, (s) => s.kidPulse);
  const [treeOpened, setTreeOpened] = useState(tab === "tree");
  useEffect(() => { if (tab === "tree") setTreeOpened(true); }, [tab]);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const labels: Record<ActivityTab, string> = { trades: "Trades", children: "Children", tree: "Family tree" };
  const counts: Record<ActivityTab, string> = { trades: nTrades >= MAX_TRADES ? `${MAX_TRADES}+` : String(nTrades), children: count(nChildren), tree: count(nDesc) };
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const n = ACTIVITY_TABS.length;
    const j = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    onTab(ACTIVITY_TABS[j]);
    tabs.current[j]?.focus();
  };

  return (
    <section className="card activity" id="activity" aria-label="Activity">
      <div className="act-head">
        <div className="act-tabs" role="tablist" aria-label="Activity">
          <SlidingPill items="[role=tab]" className="act-pill" />
          {ACTIVITY_TABS.map((t, i) => (
            <button key={t} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab" id={`act-tab-${t}`} aria-controls={`act-panel-${t}`} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1}
              onClick={() => onTab(t)} onKeyDown={(e) => onKey(e, i)}>
              {labels[t]} <span key={t === "children" ? kidPulse : undefined} className={`act-count mono ${t === "children" && kidPulse > 0 ? "pulse-once" : ""}`}>{counts[t]}</span>
            </button>
          ))}
        </div>
        <div className="act-aside">
          {tab === "trades" && <LiveDot />}
          {tab === "tree" && <Link to={`/map?focus=${coin.mint}`} className="more">whole ecosystem →</Link>}
        </div>
      </div>
      <div role="tabpanel" id={`act-panel-${tab}`} aria-labelledby={`act-tab-${tab}`} className={`act-panel ${tab}`}>
        {tab === "trades" && <TradesTab store={store} narrow={narrow} />}
        {tab === "children" && <ChildrenTab store={store} coin={coin} maxDepth={maxDepth} narrow={narrow} other={otherChildren} />}
        {treeOpened && (
          <div className="act-tree" hidden={tab !== "tree"}>
            <TreeViews coin={coin} nDesc={nDesc} narrow={narrow} />
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------- family tree: orbits (the radial family) or bubbles (the map engine) */

type TreeView = "orbits" | "bubbles";
function TreeViews({ coin, nDesc, narrow }: { coin: Coin; nDesc: number; narrow: boolean }) {
  const [view, setView] = useState<TreeView>("orbits");
  const [bubblesOpened, setBubblesOpened] = useState(false);
  useEffect(() => { if (view === "bubbles") setBubblesOpened(true); }, [view]);
  return (
    <>
      <div className="tree-head">
        <p className="act-note muted">{plural(nDesc, "descendant")} · {plural(coin.ancestors.length, "ancestor")}. {view === "orbits" ? "Each ring is one generation; a node's size is the value its children lock." : "Bubbles are sized by the value children lock; this coin sits in the middle."} <Link to={`/map?focus=${coin.mint}`} className="more">See the whole ecosystem →</Link></p>
        <span className="seg" role="group" aria-label="Family tree view">
          <SlidingPill />
          <button type="button" aria-pressed={view === "orbits"} onClick={() => setView("orbits")}>Orbits</button>
          <button type="button" aria-pressed={view === "bubbles"} onClick={() => setView("bubbles")}>Bubbles</button>
        </span>
      </div>
      <div hidden={view !== "orbits"}><RadialTree coin={coin} /></div>
      {bubblesOpened && <div hidden={view !== "bubbles"}><FamilyTree mint={coin.mint} height={narrow ? 360 : 460} /></div>}
    </>
  );
}

/* ---------- trades */

/// Relative time with its own clock: seconds tick every second, minutes every 30 s, older rows rarely.
function TapeTime({ t, sig }: { t: number; sig: string }) {
  const fresh = Date.now() / 1000 - t;
  const now = useNow(fresh < 60 ? 1_000 : fresh < 3_600 ? 30_000 : 300_000);
  return (
    <span className="t" role="cell">
      <a className="mono" href={solscanTx(sig)} target="_blank" rel="noreferrer" title={`${when(t)} · ${clock(t)} · open the transaction`}>
        {now - t < 5 ? "now" : age(t)}<small>{now - t < 60 ? "" : clock(t).slice(0, 5)}</small>
      </a>
    </span>
  );
}

function TradesTab({ store, narrow }: { store: LiveCoin; narrow: boolean }) {
  const trades = useLive(store, (s) => s.trades);
  const fresh = useLive(store, (s) => s.fresh);
  // Decimals and quote never change; read once from the record instead of subscribing to the coin.
  const coin = store.get().coin;
  const [all, setAll] = useState(false);
  const quoteDecimals = (coin as Coin & { quoteDecimals?: number }).quoteDecimals ?? (coin.quoteMint === null ? 9 : 6);
  if (trades.length === 0) return <Empty title="No trades seen yet — the first buy shows here the moment it lands." hint="The indexer keeps the trades it watched live; older history is on the explorer." />;
  const limit = narrow ? 10 : 15;
  const shown = all ? trades : trades.slice(0, limit);
  const maxVal = Math.max(0, ...shown.map((t) => tradeUsd(t, coin.decimals) ?? 0));
  return (
    <>
      <TapeHeat trades={trades} />
      <div className="tape-table" role="table" aria-label={`Latest trades of ${sym(coin)}`}>
        <div className="tape-row head" role="row">
          <span role="columnheader">time</span><span role="columnheader">side</span><span role="columnheader" className="amt">{sym(coin)}</span><span role="columnheader" className="for">for</span><span role="columnheader" className="px">price</span><span role="columnheader" className="val">value</span><span role="columnheader" className="who">trader</span>
        </div>
        {shown.map((t) => <TapeRow key={t.sig} t={t} coin={coin} quoteDecimals={quoteDecimals} isNew={fresh.has(t.sig)} maxVal={maxVal} />)}
      </div>
      <div className="tape-foot">
        {trades.length > shown.length && <button type="button" className="btn ghost sm" onClick={() => setAll(true)}>Show {trades.length - shown.length} more</button>}
        {all && trades.length >= MAX_TRADES && <span className="muted">The last {MAX_TRADES} trades the indexer kept. <Ext href={solscanAccount(coin.mint)}>Full history on solscan ↗</Ext></span>}
      </div>
    </>
  );
}

/// The 24 h heat strip over the tape; its clock moves once a minute, so a new hour rolls in by itself.
function TapeHeat({ trades }: { trades: Trade[] }) {
  const now = useNow(60_000);
  return <HeatStrip trades={trades} full={trades.length >= MAX_TRADES} now={now} />;
}

const TapeRow = memo(function TapeRow({ t, coin, quoteDecimals, isNew, maxVal }: { t: Trade; coin: Coin; quoteDecimals: number; isNew: boolean; maxVal: number }) {
  const value = tradeUsd(t, coin.decimals);
  // The trade's size as a faint bar behind the row (square-root scale so small trades still register).
  const size = value && maxVal > 0 ? Math.max(0.02, Math.sqrt(value / maxVal)) : 0;
  return (
    <div className={`tape-row ${t.isBuy ? "buy" : "sell"} ${isNew ? "is-new" : ""}`} role="row" style={{ "--size": size.toFixed(3) } as CSSProperties}>
      <TapeTime t={t.time} sig={t.sig} />
      <span role="cell" className="side"><span className={`chip side-chip ${t.isBuy ? "buy" : "sell"}`}>{t.isBuy ? "buy" : "sell"}</span></span>
      <span role="cell" className="amt mono">{amount(tokens(t.baseAmount, coin.decimals))}</span>
      <span role="cell" className="for mono">{amount(tokens(t.quoteAmount, quoteDecimals), coin.quoteSymbol)}</span>
      <span role="cell" className="px mono">{t.priceUsd != null ? usd(t.priceUsd) : price(t.priceQuote, coin.quoteSymbol)}</span>
      <span role="cell" className={`val mono ${!value ? "zero" : ""}`}>{value != null ? usdCard(value) : "—"}</span>
      <span role="cell" className="who"><a className="mono" href={solscanAccount(t.user)} target="_blank" rel="noreferrer" title={`${t.user} · open the wallet`}>{short(t.user, 4)}</a></span>
    </div>
  );
});

/* ---------- children */

type Sort = "locked" | "mcap" | "new";
const SORTS: [Sort, string][] = [["locked", "Locked"], ["mcap", "MC"], ["new", "Newest"]];
const HOUR = 3_600;

function ChildrenTab({ store, coin, maxDepth, narrow, other }: { store: LiveCoin; coin: Coin; maxDepth: number | undefined; narrow: boolean; other: number }) {
  const children = useLive(store, (s) => s.children);
  const newKids = useLive(store, (s) => s.newKids);
  const index = useAgentIndex();
  const [sort, setSort] = useState<Sort>("locked");
  const [all, setAll] = useState(false);
  const now = useNow(60_000);
  // The server sends children by locked value; that order is the default (new arrivals on top).
  const sorted = useMemo(() => sort === "locked" ? children
    : [...children].sort((a, b) => sort === "mcap" ? (b.mcapUsd ?? -1) - (a.mcapUsd ?? -1) : (b.createdAt ?? 0) - (a.createdAt ?? 0)), [children, sort]);
  const s = sym(coin);
  const block = launchBlock(coin, maxDepth);
  if (children.length === 0) {
    return (
      <Empty title={`Nothing grows under ${s} yet.`}
        hint={block ? `${block}.` : `Launch the first child: its curve will buy and lock ${s} on every trade.`}
        action={<LaunchButton coin={coin} maxDepth={maxDepth} variant="soft" size="sm" label={`Launch under ${s}`} />} />
    );
  }
  const limit = narrow ? 6 : 10;
  const shown = all ? sorted : sorted.slice(0, limit);
  return (
    <>
      <div className="kids-head">
        <p className="muted">Each child is <Term k="quote">priced in</Term> {s}: every buy of a child buys {s} and <Term k="locked">locks</Term> it in the child's curve.{other > 0 && <> <Ext href={pumpUrl(coin.mint)}>{count(other)} more on pump.fun ↗</Ext></>}</p>
        <div className="kids-ctl">
          <span className="seg" role="group" aria-label="Sort children">
            <SlidingPill />
            {SORTS.map(([k, label]) => <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>{label}</button>)}
          </span>
          <LaunchButton coin={coin} maxDepth={maxDepth} variant="ghost" size="sm" label={`Launch under ${s}`} />
        </div>
      </div>
      <div className="kids" role="list" aria-label={`Coins growing under ${s}`}>
        <div className="kid-row head" aria-hidden="true"><span /><span>coin</span><span className="kid-spark-h">24h</span><span className="num mc">MC</span><span className="num locked">locked</span><span className="num vol">24h vol</span><span className="num age">age</span><span /></div>
        {shown.map((c) => {
          const arrived = newKids.get(c.mint);
          const young = (arrived != null && Date.now() - arrived < NEW_CHILD_MS) || (c.createdAt != null && now - c.createdAt < HOUR);
          return <KidRow key={c.mint} c={c} maxDepth={maxDepth} young={young} isNew={arrived != null} prov={agentProvenance(c, index)} />;
        })}
      </div>
      {sorted.length > shown.length && <div className="tape-foot"><button type="button" className="btn ghost sm" onClick={() => setAll(true)}>Show all {count(sorted.length)}</button></div>}
    </>
  );
}

const KidRow = memo(function KidRow({ c, maxDepth, young, isNew, prov }: { c: Coin; maxDepth: number | undefined; young: boolean; isNew: boolean; prov: ReturnType<typeof agentProvenance> }) {
  const lockedQuote = tokens(c.lockedQuote, c.decimals);
  return (
    <div className={`kid-row ${isNew ? "is-new" : ""}`} role="listitem">
      <Logo src={c.image} label={c.symbol} size={32} />
      <div className="kid-name">
        <Link to={`/c/${c.mint}`} className="kid-link" title={c.name ?? undefined}>{nameOf(c)}</Link>
        <span className="kid-sub">
          <span className="mono">{sym(c)}</span>
          {young && <span className="chip accent chip-sm">new</span>}
          <AgentChip prov={prov} />
        </span>
      </div>
      <KidSpark c={c} />
      <span className={`num mono mc ${c.mcapUsd ? "" : "zero"}`}>{usdCard(c.mcapUsd)}</span>
      <span className={`num mono locked ${c.lockedUsd ? "" : "zero"}`} title={lockedQuote > 0 ? `${amount(lockedQuote)} locked in its children` : undefined}>{usdCard(c.lockedUsd)}</span>
      <span className={`num mono vol ${c.volume24hUsd ? "" : "zero"}`}>{usdCard(c.volume24hUsd)}</span>
      <span className="num mono age" title={when(c.createdAt)}>{age(c.createdAt)}</span>
      <LaunchButton coin={c} maxDepth={maxDepth} variant="icon" />
    </div>
  );
});

/// A child's 24 h line, asked for only once its row is on screen and only when it traded today.
function KidSpark({ c }: { c: Coin }) {
  const [ref, seen] = useInView<HTMLSpanElement>({ once: true, rootMargin: "120px" });
  const spark = useSpark(c.mint, seen && c.volume24hUsd > 0);
  return (
    <span ref={ref} className="kid-spark">
      {c.volume24hUsd <= 0 ? <i className="kid-spark-flat" title="No trades in 24h" />
        : spark ? <Sparkline points={spark.points} tone={sparkTone(spark.change)} w={100} h={28} label={sparkLabel(spark)} />
        : spark === null ? <i className="kid-spark-flat" title="No price history" /> : <i className="kid-spark-wait" />}
    </span>
  );
}

/// The tab in the hash, if the link carried one.
export const hashTab = (): ActivityTab | null => { const h = typeof window !== "undefined" ? window.location.hash.slice(1) : ""; return isActivityTab(h) ? h : null; };
/// [tab, choose, preset]: `choose` is the reader's pick and is written to the hash without a router
/// navigation (a navigation would scroll the page to an element with that id); `preset` sets the
/// default once the record is known and leaves the URL alone.
export function useActivityTab(initial: ActivityTab): [ActivityTab, (t: ActivityTab) => void, (t: ActivityTab) => void] {
  const [tab, setTab] = useState<ActivityTab>(() => hashTab() ?? initial);
  const choose = useCallback((t: ActivityTab) => {
    setTab(t);
    try { window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${t}`); } catch { /* sandboxed frame */ }
  }, []);
  return [tab, choose, setTab];
}
