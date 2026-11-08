// /c/:mint — a coin, price first. Someone arriving from a shared link should read the price, the CA
// and how to buy within three seconds: the header carries price, change (with its basis), market
// cap, the copyable CA and the last trade; the trade widget sits beside it on desktop and behind a
// sticky Buy / Sell bar on phones. Everything below (chart, creator fees, the agent, one Activity
// card, the folded details) answers the second question: what this coin is in its tree.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import { api, pumpUrl, solscanAccount, solscanTx, type Candles, type Coin as CoinT } from "../lib/api";
import { copyText, useAsync, useMediaQuery, useNow, useScrollLock, useStats } from "../lib/hooks";
import { useDialog } from "../lib/dialog";
import { provenanceFromAgentCoin, useAgentCoin } from "../lib/agent-index";
import { OFFICIAL_CA } from "../lib/copy";
import { age, amount, count, pctCurve, plural, price, short, sol, tokens, usd, usdCard, when } from "../lib/format";
import type { Side } from "../lib/pump";
import { motionPaused } from "../components/SporeCanvas";
import ChainBreadcrumb from "../components/ChainBreadcrumb";
import PriceChart from "../components/PriceChart";
import TradeWidget from "../components/TradeWidget";
import FeeSplitAction from "../components/FeeSplitAction";
import ClaimFees from "../components/ClaimFees";
import CoinAgentCard from "../components/agents/CoinAgentCard";
import DominanceLine from "../components/DominanceLine";
import LaunchButton from "../components/LaunchButton";
import Search from "../components/Search";
import Term from "../components/Term";
import { Delta, Stat, StatStrip } from "../components/Stat";
import { Addr, AgentChip, DepthBadge, ErrorBox, Ext, Logo, ProgressBar, Skeleton, nameOf, sym, useTint } from "../components/Bits";
import { useToast } from "../components/Toast";
import CoinActivity, { defaultTab, hashTab, useActivityTab } from "../components/coin/CoinActivity";
import { CoinIntro, NewToSpore } from "../components/coin/CoinIntro";
import FamilyStrip from "../components/coin/FamilyStrip";
import ShareMenu from "../components/coin/ShareMenu";
import { tradeUsd, useLive, useLiveCoinStore, type LiveCoin } from "../components/coin/useLiveCoin";
import { Sparkline, Tween, sparkTone } from "../components/coin/viz";
import Reveal from "../components/ui/Reveal";
import "../components/coin.css";
import "../components/coin/terminal.css";

/// `label` names the basis in full ("· 24h", "since first trade (21h)"); `short` is the phone bar's ("24h", "21h").
type Change = { ratio: number; label: string; short: string; title: string };

/// The one change figure of the page. From hourly candles: the close of the last candle that ended
/// at least 24 h ago ("· 24h"); when the series is younger, the first open ("since first trade (21h)").
function change24h(rows: Candles["candles"], coin: CoinT, priceKey: Candles["priceKey"]): Change | null {
  if (!rows.length) return null;
  const cutoff = Math.floor(Date.now() / 1000) - 86_400;
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const ref = [...sorted].reverse().find((r) => r.t + 3600 <= cutoff);
  const current = (priceKey === "usd" ? coin.priceUsd : coin.priceQuote) ?? sorted[sorted.length - 1].c;
  if (ref && ref.c > 0) return { ratio: current / ref.c - 1, label: "· 24h", short: "24h", title: "Change over the last 24 hours (hourly candles)" };
  const first = sorted[0];
  if (first.o > 0 && sorted.length > 1) return { ratio: current / first.o - 1, label: `since first trade (${age(first.t)})`, short: age(first.t), title: `Change since the first trade the indexer saw, ${age(first.t)} ago` };
  return null;
}

const CopyGlyph = () => <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15" /></svg>;
const CheckGlyph = () => <svg className="ic-check" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" /></svg>;
/// A copy that confirms in place: the icon turns into a check and "copied" flashes for 1.6 s (the toast stays too).
function useCopied(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  return [on, () => { setOn(true); if (t.current) clearTimeout(t.current); t.current = setTimeout(() => setOn(false), 1_600); }];
}
const quoteDecimalsOf = (c: CoinT) => (c as CoinT & { quoteDecimals?: number }).quoteDecimals ?? (c.quoteMint === null ? 9 : 6);
const priceText = (c: CoinT) => (c.priceUsd != null ? usd(c.priceUsd) : price(c.priceQuote, c.quoteSymbol));
const mcText = (c: CoinT) => (c.mcapUsd != null ? `MC ${usd(c.mcapUsd)}${c.mcapSol != null ? ` · ${sol(c.mcapSol)}` : ""}` : c.mcapSol != null ? `MC ${sol(c.mcapSol)}` : "MC —");
/// The header's MC line; the SOL half is dropped on phones (the class hides it).
const McLine = ({ c }: { c: CoinT }) => (c.mcapUsd != null && c.mcapSol != null ? <span className="price-mc mono">MC {usd(c.mcapUsd)}<span className="mc-sol"> · {sol(c.mcapSol)}</span></span> : <span className="price-mc mono">{mcText(c)}</span>);
const smooth = (): ScrollBehavior => (motionPaused() ? "auto" : "smooth");

export default function CoinPage() {
  const { mint = "" } = useParams();
  const page = useAsync(() => api.coin(mint), [mint]);
  // Hourly candles just for the header's change figure; the chart has its own series.
  const daily = useAsync(() => api.candles(mint, 3600).catch(() => null), [mint]);
  const { stats } = useStats();
  const solUsd = stats?.solUsd ?? null;
  const maxDepth = stats?.maxDepth;
  const narrow = useMediaQuery("(max-width: 980px)");
  const store = useLiveCoinStore(page.data, solUsd);
  const coin = page.data?.coin ?? null;
  const agentCoin = useAgentCoin(coin);
  const [sheet, setSheet] = useState<Side | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!narrow) setSheet(null); }, [narrow]);
  const [tab, setTab, presetTab] = useActivityTab("trades");
  // The default tab is decided once per coin, when its record is in; a shared #children link wins
  // and scrolls to the card.
  const tabFor = useRef<string | null>(null);
  useEffect(() => {
    if (!page.data || tabFor.current === page.data.coin.mint) return;
    tabFor.current = page.data.coin.mint;
    const linked = hashTab();
    if (linked) { presetTab(linked); requestAnimationFrame(() => activityRef.current?.scrollIntoView({ block: "start" })); }
    else presetTab(defaultTab(page.data.trades.length, page.data.coin.children));
  }, [page.data, presetTab]);

  const openChildren = useCallback(() => { setTab("children"); activityRef.current?.scrollIntoView({ behavior: smooth(), block: "start" }); }, [setTab]);
  const onBuy = useCallback(() => {
    if (narrow) { setSheet("buy"); return; }
    amountRef.current?.focus({ preventScroll: true });
    amountRef.current?.scrollIntoView({ behavior: smooth(), block: "nearest" });
  }, [narrow]);

  if (page.loading) return <div className="container coin-page"><CoinSkeleton /></div>;
  if (page.error && !page.data) {
    const invalid = /invalid/i.test(page.error);
    const unknown = invalid || page.error.includes("404") || /not found|unknown/i.test(page.error);
    return unknown ? <UnknownCoin mint={mint} invalid={invalid} /> : (
      <div className="container coin-page">
        <div className="page-head"><h1>Could not load this coin</h1><p className="lead">The API did not answer. The page recovers by itself when it comes back; or retry now.</p></div>
        <ErrorBox error={page.error} retry={page.reload} />
      </div>
    );
  }
  if (!page.data || !coin || !store) return null;
  const solo = agentCoin === null || agentCoin === undefined;

  return (
    <div className={`container coin-page ${narrow ? "has-bar" : ""}`}>
      <NewToSpore />
      <TitleSync store={store} />
      <div className="coin-grid">
        <div className="coin-main">
          <CoinHeader coin={coin} store={store} daily={daily.data} maxDepth={maxDepth} agentCoin={agentCoin} onChildren={openChildren} />
          <div className="coin-about">
            <LiveIntro store={store} agentCoin={agentCoin} />
            {coin.description && <Description text={coin.description} />}
          </div>
          <CoinStats store={store} />
          {coin.depth === 0 && <CoinDominance mint={coin.mint} />}
          <div className="coin-chart"><PriceChart coin={coin} onBuy={onBuy} live={store} /></div>
          <div className={`coin-money ${solo ? "solo" : ""}`}>
            <div className="coin-fees"><ClaimFees coin={coin} /></div>
            <AgentSlot coin={coin} />
          </div>
          {/* A child without a fee-sharing config: its creator can still lock the split (Spore's
              own split section is gone; the fee card above shows who gets what). */}
          {!coin.shares?.length && coin.depth > 0 && <div className="coin-lock"><FeeSplitAction coin={coin} onDone={page.reload} /></div>}
          <div className="coin-activity" ref={activityRef}>
            <Reveal><CoinActivity store={store} tab={tab} onTab={setTab} maxDepth={maxDepth} narrow={narrow} otherChildren={page.data.otherChildren ?? 0} /></Reveal>
          </div>
          <Reveal className="coin-details-wrap"><Details coin={coin} narrow={narrow} /></Reveal>
        </div>
        {!narrow && (
          <aside className="coin-side" aria-label={`Buy or sell ${sym(coin)}`}>
            <TradeWidget coin={coin} solUsd={solUsd} amountRef={amountRef} current={store.coin} />
          </aside>
        )}
      </div>
      {narrow && <PhoneBar store={store} daily={daily.data} onOpen={setSheet} />}
      {narrow && sheet && <TradeSheet coin={coin} store={store} side={sheet} solUsd={solUsd} onClose={() => setSheet(null)} />}
    </div>
  );
}

/* ---------- header */

function CoinHeader({ coin, store, daily, maxDepth, agentCoin, onChildren }: { coin: CoinT; store: LiveCoin; daily: Candles | null; maxDepth: number | undefined; agentCoin: ReturnType<typeof useAgentCoin>; onChildren: () => void }) {
  const toast = useToast();
  const prov = provenanceFromAgentCoin(agentCoin);
  // The header takes the coin's own colour: its logo's halo and the light behind the identity.
  const [tint, onLogo] = useTint(coin.image, coin.mint);
  const [copied, flashCopied] = useCopied();
  const copyCa = async () => { if (await copyText(coin.mint)) { flashCopied(); toast.success("Contract address copied"); } else toast.error("Could not copy the contract address"); };
  const toAgent = (e: ReactMouseEvent) => { const el = document.getElementById("agent"); if (!el || !el.firstElementChild) return; e.preventDefault(); el.scrollIntoView({ behavior: smooth(), block: "center" }); };
  const status = coin.complete && !coin.migrated ? <span className="chip warn" title="The curve filled; pump.fun is moving the coin to a PumpSwap pool">migrating</span>
    : coin.migrated ? <span className="chip good"><Term k="graduated">graduated</Term>&nbsp;· PumpSwap</span>
    : <span className="chip neutral">on <Term k="curve">curve</Term>&nbsp;· {pctCurve(coin.progress)}</span>;
  return (
    <header className="coin-head" style={{ "--tint": tint } as CSSProperties}>
      <span className="coin-aura" aria-hidden="true" />
      <span className="coin-logo-wrap"><Logo src={coin.image} label={coin.symbol} size={64} className="coin-logo" onLoad={onLogo} /></span>
      <div className="coin-id">
        <div className="coin-title">
          <h1 title={nameOf(coin)}>{nameOf(coin)}</h1>
          <span className="ticker mono">{sym(coin)}</span>
          <DepthBadge depth={coin.depth} long term maxDepth={maxDepth} />
        </div>
        {/* Two rows on desktop; one wrapping run of tags on phones. */}
        <div className="coin-tags">
        <div className="coin-lineage">
          <ChainBreadcrumb coin={coin} variant="header" rootQuote={null} />
          <FamilyStrip store={store} onChildren={onChildren} showLineage={false} />
        </div>
        <div className="coin-status">
          {status}
          {coin.mint === OFFICIAL_CA ? <span className="spore-mark"><span aria-hidden="true">✓</span> official $SPORE</span>
            : coin.ours ? <span className="spore-mark" title="Its on-chain fee split names the Spore wallet"><span aria-hidden="true">✓</span> launched on Spore</span>
            : coin.oursPending ? <span className="spore-mark pending" title="Reported as a Spore launch; the indexer is verifying the fee split on-chain">verifying launch</span> : null}
          {coin.holderReward && <span className="chip violet" title="Creator fees go to holders; the fee split does not apply">holder rewards</span>}
          {prov?.role === "child" && <AgentChip prov={prov} />}
          {prov?.role === "root" && <a href="#agent" className="agent-anchor" onClick={toAgent} title="Jump to this coin's agent"><AgentChip prov={prov} link={false} /></a>}
        </div>
        </div>
      </div>
      <div className="coin-addr">
        <button type="button" className={`ca-pill ${copied ? "done" : ""}`} onClick={copyCa} aria-label={`Copy contract address ${coin.mint}`} title={coin.mint}>
          <span className="ca-k">CA</span><span className="mono ca-v">{coin.mint.slice(0, 4)}…{coin.mint.slice(-5)}</span>
          <span className="ca-ic"><CopyGlyph /><CheckGlyph /></span>
          <span className="ca-copied" aria-hidden="true">copied</span>
        </button>
        <span className="coin-links">
          <Ext href={pumpUrl(coin.mint)}>pump.fun ↗</Ext>
          <Ext href={solscanAccount(coin.mint)} className="solscan-link">solscan ↗</Ext>
          {coin.twitter && <Ext href={coin.twitter}>X ↗</Ext>}
          {coin.telegram && <Ext href={coin.telegram}>Telegram ↗</Ext>}
          {coin.website && <Ext href={coin.website}>Website ↗</Ext>}
        </span>
      </div>
      <PriceBlock store={store} daily={daily} />
      <div className="coin-actions">
        <ShareMenu coin={coin} current={store.coin} />
        <LaunchButton coin={coin} maxDepth={maxDepth} variant="ghost" size="sm" label={`Launch under ${sym(coin)}`} />
      </div>
    </header>
  );
}

/// Price, change, market cap and the last trade: the block that moves. A price move flashes once
/// (at most every 600 ms) and leaves a small static arrow for two seconds that survives reduced motion.
function PriceBlock({ store, daily }: { store: LiveCoin; daily: Candles | null }) {
  const coin = useLive(store, (s) => s.coin);
  const tick = useLive(store, (s) => s.tick);
  const delta = useMemo(() => (daily ? change24h(daily.candles, coin, daily.priceKey) : null), [daily, coin]);
  const [arrow, setArrow] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (!tick) return;
    setArrow(tick.dir);
    const t = setTimeout(() => setArrow(null), 2_000);
    return () => clearTimeout(t);
  }, [tick]);
  const main = priceText(coin);
  // The last day of hourly closes, ending on the live price, so the dot is the number above it.
  const spark = useMemo(() => {
    if (!daily?.candles.length) return null;
    const now = Date.now() / 1000;
    const rows = [...daily.candles].sort((a, b) => a.t - b.t);
    const day = rows.filter((r) => r.t >= now - 86_400);
    const use = day.length >= 2 ? day : rows.slice(-48);
    const live = daily.priceKey === "usd" ? coin.priceUsd : coin.priceQuote;
    const pts = use.map((r) => r.c).filter((v) => Number.isFinite(v) && v > 0);
    if (live != null && live > 0) pts.push(live);
    return pts.length >= 2 ? pts : null;
  }, [daily, coin.priceUsd, coin.priceQuote]);
  return (
    <div className="coin-price">
      <span className="price-k" aria-hidden="true">price</span>
      <div className="price-row">
        {arrow && <span className={`tick-arrow ${arrow}`} aria-hidden="true">{arrow === "up" ? "▲" : "▼"}</span>}
        <b key={tick?.id ?? 0} className={`price-now mono ${tick ? `tick-${tick.dir}` : ""}`}>{main}</b>
        {/[₀-₉]/.test(main) && <Term k="subscript" icon>What does the small digit mean?</Term>}
      </div>
      <div className="price-sub">
        {/* Phones show the short basis ("· 4h") so the change fits on the price line. */}
        {delta ? <><span className="d-long"><Delta ratio={delta.ratio} label={delta.label} title={delta.title} /></span><span className="d-short"><Delta ratio={delta.ratio} label={`· ${delta.short}`} title={delta.title} /></span></> : <span className="delta flat" title="Not enough price history for a change figure yet">— <small>no history yet</small></span>}
        <McLine c={coin} />
      </div>
      {spark && <div className="price-spark"><Sparkline points={spark} tone={sparkTone(delta?.ratio ?? (spark[spark.length - 1] / spark[0] - 1))} w={240} h={40} label={`Price over ${delta?.short === "24h" || !delta ? "the last 24 hours" : delta.short}${delta ? `, ${delta.ratio >= 0 ? "up" : "down"} ${Math.abs(delta.ratio * 100).toFixed(1)} %` : ""}`} /></div>}
      <LastTrade store={store} />
    </div>
  );
}

function LastTrade({ store }: { store: LiveCoin }) {
  const t = useLive(store, (s) => s.trades[0] ?? null);
  const fresh = t ? Date.now() / 1000 - t.time < 3_600 : false;
  const now = useNow(fresh ? 1_000 : 60_000);
  if (!t) return <p className="last-trade none">No trades seen yet</p>;
  const ago = Math.max(0, now - t.time);
  if (ago >= 3_600) return <p className="last-trade none">Last trade {age(t.time)} ago</p>;
  const coin = store.get().coin;
  const size = coin.quoteMint === null ? sol(tokens(t.quoteAmount, 9)) : (tradeUsd(t, coin.decimals) != null ? usdCard(tradeUsd(t, coin.decimals)) : amount(tokens(t.quoteAmount, quoteDecimalsOf(coin)), coin.quoteSymbol));
  return (
    <a className={`last-trade ${t.isBuy ? "buy" : "sell"}`} href={solscanTx(t.sig)} target="_blank" rel="noreferrer" title="Open the transaction on solscan">
      <i aria-hidden="true" />{t.isBuy ? "Buy" : "Sell"} {size}<span className="lt-who"> · {short(t.user, 4)}</span> · {ago < 5 ? "just now" : ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`}
    </a>
  );
}

/// The intro sentence counts children: it follows a new child, never a trade.
function LiveIntro({ store, agentCoin }: { store: LiveCoin; agentCoin: ReturnType<typeof useAgentCoin> }) {
  useLive(store, (s) => s.coin.children);
  return <CoinIntro coin={store.coin()} agentCoin={agentCoin} />;
}

/// Two-line description with "more" when it is longer than that.
function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { const el = ref.current; if (el) setLong(el.scrollHeight > el.clientHeight + 2); }, [text]);
  return (
    <div className={`coin-desc ${open ? "open" : ""}`}>
      <p ref={ref}>{text}</p>
      {(long || open) && <button type="button" className="linkish" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "less" : "more"}</button>}
    </div>
  );
}

/* ---------- stats */

function CoinStats({ store }: { store: LiveCoin }) {
  const coin = useLive(store, (s) => s.coin);
  const trades = useLive(store, (s) => s.trades);
  const now = Math.floor(Date.now() / 1000);
  const day = trades.filter((t) => now - t.time < 86_400);
  const buys = day.filter((t) => t.isBuy).length, sells = day.length - buys;
  // The tape holds the last 50 trades: when the day had more, the split is of the latest ones.
  const covers = day.length >= coin.trades24h;
  const lockedQuote = tokens(coin.lockedQuote, coin.decimals);
  // Hero only for a real amount; dust reads "< $0.01" like the cards (the exact figure is in the title).
  const locked = coin.lockedUsd != null && coin.lockedUsd >= 0.01;
  const dust = coin.lockedUsd != null && coin.lockedUsd > 0 && !locked;
  return (
    <StatStrip className="coin-stats">
      <Stat label={<Term k="mcap">Market cap</Term>} value={coin.mcapUsd != null ? <Tween value={coin.mcapUsd} format={usd} /> : sol(coin.mcapSol)} sub={coin.mcapUsd != null && coin.mcapSol != null ? sol(coin.mcapSol) : undefined} />
      <Stat label={<Term k="volume">24h volume</Term>} value={coin.volume24hUsd > 0 ? <Tween value={coin.volume24hUsd} format={usd} /> : <span className="zero">{usd(coin.volume24hUsd)}</span>}
        sub={<>
          <span className="vol-sub">{plural(coin.trades24h, "trade")}{day.length > 0 && <> · {covers ? "" : `last ${day.length}: `}{buys} buys / {sells} sells</>}</span>
          {day.length > 0 && <span className="bs-bar" role="img" aria-label={`${buys} buys and ${sells} sells among the latest trades`}><i className="b" style={{ flexGrow: buys }} /><i className="s" style={{ flexGrow: sells }} /></span>}
        </>} />
      <Stat label={<Term k="locked">Locked by children</Term>} hero={locked}
        value={locked ? <Tween value={coin.lockedUsd ?? 0} format={usd} /> : dust ? <span title={usd(coin.lockedUsd)}>{usdCard(coin.lockedUsd)}</span> : <span className="zero">—</span>}
        sub={locked || dust ? `${amount(lockedQuote, sym(coin))} in ${plural(coin.children, "child", "children")}` : coin.children === 0 ? "no children yet" : "children hold none yet"} />
      {coin.migrated
        ? <Stat label="status" value="graduated" sub={<>trades on PumpSwap{coin.pool && <> · <a href={solscanAccount(coin.pool)} target="_blank" rel="noreferrer" className="mono">pool {short(coin.pool, 4)}</a></>}</>} />
        : coin.complete
          ? <Stat label="status" value="migrating" sub="moving to a PumpSwap pool" />
          : <Stat label={<Term k="curve">to graduation</Term>} value={pctCurve(coin.progress)} sub={<ProgressBar value={coin.progress} />} />}
    </StatStrip>
  );
}

/// A root's family on the map (DESIGN §11.5 "Dominance"): its share of all locked value and of all market
/// cap, the numbers the map shows on its title. From GET /api/map/dominance (the page does not load the
/// map), one row per mode; nothing when the coin is not a family top on the map (no pairs, or a root that
/// hangs under a listed asset such as $PUMP), when nothing in its family is priced, or on a server
/// without the route.
const CoinDominance = memo(function CoinDominance({ mint }: { mint: string }) {
  const a = useAsync(() => Promise.all([api.dominance("locked", mint), api.dominance("mcap", mint)]).catch(() => null), [mint]);
  // a family with nothing priced (value 0) has no share to speak of: "—", and no line when neither mode has one
  const l = a.data?.[0].families[0], m = a.data?.[1].families[0];
  const locked = l && l.value > 0 ? l.share : null, mcap = m && m.value > 0 ? m.share : null;
  if (locked == null && mcap == null) return null;
  return (
    <DominanceLine className="coin-dom" variant="inline" locked={locked} mcap={mcap}>
      <Link to={`/map?focus=${mint}`} className="coin-dom-map">on the map →</Link>
    </DominanceLine>
  );
});

/* ---------- money row, details */

/// CoinAgentCard (agents lane) inside the #agent anchor; memoized so a trade never re-renders it.
const AgentSlot = memo(function AgentSlot({ coin }: { coin: CoinT }) {
  return <div id="agent" className="coin-agent"><CoinAgentCard coin={coin} /></div>;
});

const Details = memo(function Details({ coin, narrow }: { coin: CoinT; narrow: boolean }) {
  const toast = useToast();
  const copy = async (text: string, what: string) => { if (await copyText(text)) toast.success(`${what} copied`); else toast.error(`Could not copy the ${what.toLowerCase()}`); };
  const holders = (coin as CoinT & { holders?: number | null }).holders;
  return (
    // Folded on phones (the page has to stay short), open on desktop; remounted when that changes.
    <details key={narrow ? "n" : "w"} className="card coin-details" open={!narrow}>
      <summary><span className="card-label">About &amp; details</span>{coin.createdAt != null && <span className="muted">{coin.ours || coin.oursPending ? "launched" : "created"} {age(coin.createdAt)} ago</span>}</summary>
      {coin.description && <p className="details-desc">{coin.description}</p>}
      {/* A definition grid: each term and its value grouped in one cell (a <div> inside <dl> is valid HTML). */}
      <dl className="kv dgrid">
        <div className="dcell wide"><dt>Creator</dt><dd className="addr-row"><Addr a={coin.creator} n={6} /><CopyBtn onClick={() => copy(coin.creator, "Creator address")} label="Copy creator address" /></dd></div>
        <div className="dcell wide"><dt>Mint</dt><dd className="addr-row"><Addr a={coin.mint} n={6} /><CopyBtn onClick={() => copy(coin.mint, "Contract address")} label="Copy contract address" /></dd></div>
        <div className="dcell"><dt><Term k="quote">Priced in</Term></dt><dd>{coin.parent ? <Link to={`/c/${coin.parent.mint}`}>{sym(coin.parent)}</Link> : coin.quoteSymbol}{coin.quoteMint && <> · <Addr a={coin.quoteMint} /></>}</dd></div>
        <div className="dcell"><dt>Root</dt><dd>{coin.root ? <Link to={`/c/${coin.root.mint}`}>{sym(coin.root)}</Link> : coin.depth === 0 ? "this coin" : "—"}</dd></div>
        <div className="dcell"><dt>Token program</dt><dd className="mono">{coin.tokenProgram.startsWith("Tokenz") ? "Token-2022" : "SPL Token"}</dd></div>
        <div className="dcell"><dt>Supply</dt><dd className="mono">{amount(tokens(coin.totalSupply, coin.decimals))}</dd></div>
        {holders != null && <div className="dcell"><dt>Holders</dt><dd className="mono">{count(holders)}</dd></div>}
        <div className="dcell"><dt><Term k="creatorFee">Creator fee</Term></dt><dd className="mono">{coin.creatorFeeBps ? `${coin.creatorFeeBps / 100}% (${coin.creatorFeeBps} bps)` : "pump.fun default"}</dd></div>
        {coin.pool && <div className="dcell"><dt>Pool</dt><dd><a className="mono" href={solscanAccount(coin.pool)} target="_blank" rel="noreferrer">{short(coin.pool, 6)}</a></dd></div>}
        <div className="dcell wide"><dt>Created</dt><dd>{coin.createdAt != null ? when(coin.createdAt) : "before the indexer"}{coin.createdSlot ? <span className="muted"> · slot {coin.createdSlot.toLocaleString("en-US")}</span> : null}</dd></div>
        <div className="dcell"><dt>Updated</dt><dd>{age(coin.updatedAt)} ago</dd></div>
      </dl>
    </details>
  );
});

const CopyBtn = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" className="copy" onClick={onClick} aria-label={label} title={label}><CopyGlyph /></button>
);

/* ---------- live bits outside the page tree's render path */

/// "{SYM} · MC $29.3K · Spore", at most every 2 s; the previous title comes back on unmount.
function TitleSync({ store }: { store: LiveCoin }) {
  const coin = useLive(store, (s) => s.coin);
  const text = `${sym(coin)} · MC ${coin.mcapUsd != null ? usd(coin.mcapUsd) : sol(coin.mcapSol)} · Spore`;
  const latest = useRef(text);
  latest.current = text;
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const prev = document.title;
    return () => { if (timer.current) clearTimeout(timer.current); timer.current = null; document.title = prev; };
  }, []);
  useEffect(() => {
    const apply = () => { timer.current = null; last.current = Date.now(); document.title = latest.current; };
    const wait = 2_000 - (Date.now() - last.current);
    if (wait <= 0) apply();
    else if (!timer.current) timer.current = setTimeout(apply, wait);
  }, [text]);
  return null;
}

/// The phone's sticky bar: price, change and market cap on the left, Buy and Sell on the right, and
/// the curve's progress as a 2 px line along the top edge.
function PhoneBar({ store, daily, onOpen }: { store: LiveCoin; daily: Candles | null; onOpen: (s: Side) => void }) {
  const coin = useLive(store, (s) => s.coin);
  const tick = useLive(store, (s) => s.tick);
  const delta = useMemo(() => (daily ? change24h(daily.candles, coin, daily.priceKey) : null), [daily, coin]);
  return (
    <div className="trade-bar" role="region" aria-label={`Trade ${sym(coin)}`}>
      {!coin.migrated && <i className="bar-progress" style={{ transform: `scaleX(${Math.max(0.01, Math.min(1, coin.progress))})` }} aria-hidden="true" />}
      <div className="trade-bar-price">
        <b key={tick?.id ?? 0} className={`bar-price mono ${tick ? `tick-${tick.dir}` : ""}`}>{priceText(coin)}</b>
        <span className="bar-sub">{delta && <Delta ratio={delta.ratio} label={delta.short} title={delta.title} />}<span className="mono">{coin.mcapUsd != null ? `MC ${usd(coin.mcapUsd)}` : mcText(coin)}</span></span>
      </div>
      <button type="button" className="btn accent" onClick={() => onOpen("buy")}>Buy</button>
      <button type="button" className="btn violet" onClick={() => onOpen("sell")}>Sell</button>
    </div>
  );
}

/// The phone trade sheet: a real modal (portal, focus trap, Escape, focus back to the bar).
function TradeSheet({ coin, store, side, solUsd, onClose }: { coin: CoinT; store: LiveCoin; side: Side; solUsd: number | null; onClose: () => void }) {
  const amountRef = useRef<HTMLInputElement>(null);
  const ref = useDialog<HTMLDivElement>(true, onClose, { initialFocus: amountRef });
  const titleId = useId();
  useScrollLock(true);
  return createPortal(
    <div className="trade-sheet-backdrop" onClick={onClose}>
      <div ref={ref} className="trade-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <TradeWidget coin={coin} solUsd={solUsd} initialSide={side} sheet onClose={onClose} amountRef={amountRef} titleId={titleId} current={store.coin} />
      </div>
    </div>,
    document.body,
  );
}

/* ---------- states */

function UnknownCoin({ mint, invalid }: { mint: string; invalid: boolean }) {
  return (
    <div className="container coin-page coin-unknown">
      <div className="page-head">
        <h1>Unknown coin</h1>
        <p className="lead">{invalid ? <>That is not a Solana contract address.</> : <>Spore has no record of <span className="mono">{short(mint, 6)}</span>. It serves the coins launched on it, their parents and the pump.fun pairs on the map.</>} Search by name, ticker or contract address.</p>
      </div>
      <Search size="md" label="Search coins by name, ticker or contract address" autoFocus />
      <div className="unknown-links">
        {!invalid && <Ext href={pumpUrl(mint)} className="btn ghost">Open on pump.fun ↗</Ext>}
        <Link to="/map" className="btn ghost">Explore the map</Link>
        <Link to="/explore" className="btn ghost">Coins launched on Spore</Link>
      </div>
    </div>
  );
}

function CoinSkeleton() {
  return (
    <div className="coin-grid" aria-busy="true" aria-label="Loading the coin">
      <div className="coin-main">
        <header className="coin-head sk-head">
          <Skeleton w={64} h={64} r={18} className="coin-logo" />
          <div className="sk-id stack-2"><Skeleton w="55%" h={30} /><Skeleton w="40%" h={20} /><Skeleton w="45%" h={22} /></div>
          <div className="coin-addr"><Skeleton w={150} h={32} r={999} /></div>
          <div className="coin-price stack-2"><Skeleton w={150} h={34} /><Skeleton w={120} h={16} /><Skeleton w={160} h={14} /></div>
        </header>
        <div className="coin-about"><Skeleton h={20} w="70%" /></div>
        <div className="stats coin-stats">{[0, 1, 2, 3].map((i) => <div className="stat" key={i}><Skeleton w="50%" h={11} /><Skeleton w="70%" h={26} /><Skeleton w="60%" h={11} /></div>)}</div>
        <div className="coin-chart"><Skeleton h={372} r={16} /></div>
        <div className="coin-money solo"><div className="coin-fees"><Skeleton h={180} r={16} /></div></div>
        <div className="coin-activity"><Skeleton h={420} r={16} /></div>
      </div>
      <aside className="coin-side sk-side"><Skeleton h={460} r={16} /></aside>
    </div>
  );
}

