// /c/:mint — a coin, price first. Someone arriving from a shared link should read the price, the CA
// and how to buy within three seconds, and see the chart without scrolling: one compact coin bar
// (identity, price and change with its basis, market cap, 24h volume, locked by children, the
// copyable CA and the links), the chart sized to the window under it, and the trade widget beside it
// on desktop (behind a sticky Buy / Sell bar on phones). With instant trades on (Trade settings) and
// a wallet that can sign, the user's presets trade at once: a row of them above the widget on
// desktop, a popover from the bar's Buy / Sell on phones (components/useInstantTrade.ts, as on the
// Portfolio page and the map). Under the chart the Activity card (trades, children, family tree),
// then the posts the coin or its children link (components/coin/CoinNarrative.tsx), creator fees, the agent and the
// folded details; under the trade widget "Your position" (what the header's
// wallet holds of the coin and its P&L, components/coin/YourPosition.tsx; under the chart on phones), then a calm info card
// (what the coin is, its family, status, dominance) answers the second question: what this coin is
// in its tree.
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import { api, pumpUrl, solscanAccount, solscanTx, type Candles, type Coin as CoinT } from "../lib/api";
import { copyText, useAsync, useMediaQuery, useNow, useScrollLock, useStats } from "../lib/hooks";
import { useDialog } from "../lib/dialog";
import { provenanceFromAgentCoin, useAgentCoin } from "../lib/agent-index";
import { OFFICIAL_CA } from "../lib/copy";
import { age, amount, count, pctCurve, plural, price, short, sol, tokens, usd, usdCard, when } from "../lib/format";
import type { Side } from "../lib/pump";
import type { InstantSpec } from "../lib/instant-trade";
import { presetChoices } from "../lib/instant-outcome";
import { blockText, hardBlock, useTradeRoute, type TradeBlock } from "../lib/trade-route";
import { motionPaused } from "../components/SporeCanvas";
import ChainBreadcrumb from "../components/ChainBreadcrumb";
import PriceChart from "../components/PriceChart";
import TradeWidget, { type TradeWidgetProps } from "../components/TradeWidget";
import TradePresets from "../components/TradePresets";
import { useInstantTrade } from "../components/useInstantTrade";
import InstantRow from "../components/coin/InstantRow";
import FeeSplitAction from "../components/FeeSplitAction";
import ClaimFees from "../components/ClaimFees";
import CoinAgentCard from "../components/agents/CoinAgentCard";
import DominanceLine from "../components/DominanceLine";
import LaunchButton from "../components/LaunchButton";
import Search from "../components/Search";
import Term from "../components/Term";
import { Delta } from "../components/Stat";
import { Addr, AgentChip, DepthBadge, ErrorBox, Ext, Logo, ProgressBar, Skeleton, listedQuoteOf, nameOf, sym, useTint } from "../components/Bits";
import { useToast } from "../components/Toast";
import CoinActivity, { defaultTab, hashTab, useActivityTab } from "../components/coin/CoinActivity";
import { CoinIntro, NewToSpore } from "../components/coin/CoinIntro";
import FamilyStrip from "../components/coin/FamilyStrip";
import ShareMenu from "../components/coin/ShareMenu";
import { tradeUsd, useLive, useLiveCoinStore, type LiveCoin } from "../components/coin/useLiveCoin";
import { Sparkline, Tween, sparkTone } from "../components/coin/viz";
import { change24h, changeWords, daySpark } from "../components/coin/change";
import ParentPrice, { ParentBarLine } from "../components/coin/ParentPrice";
import YourPosition from "../components/coin/YourPosition";
import CoinNarrative from "../components/coin/CoinNarrative";
import { parentOf } from "../lib/priced-in";
import Reveal from "../components/ui/Reveal";
import "../components/coin.css";
import "../components/coin/terminal.css";

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
  // A coin whose route cannot start from SOL gets no Buy / Sell (phone bar, chart): pump.fun instead, with the reason.
  const tradeRoute = useTradeRoute(coin);
  const tradeBlocked = coin ? hardBlock(tradeRoute.data) : null;
  // the phone's trade sheet: its side, and the amount it opens with when an instant trade handed the trade back; `n`
  // remounts it, so a ticket handed back while it is open shows that side and amount
  const [sheet, setSheet] = useState<{ side: Side; amount?: string; n: number } | null>(null);
  const sheetN = useRef(0);
  const sheetOpenNow = useRef(false);
  sheetOpenNow.current = !!sheet;
  // a ticket changed by the user while an instant trade runs (see the instant trades below)
  const editedInHold = useRef(false);
  // a sheet opened by hand starts with nothing changed in it
  const openSheet = useCallback((side: Side) => { editedInHold.current = false; setSheet({ side, n: ++sheetN.current }); }, []);
  const amountRef = useRef<HTMLInputElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!narrow) setSheet(null); }, [narrow]);

  // Instant trades (components/useInstantTrade.ts, as on the Portfolio page and the map): one at a time, the wallet
  // step first, the toasts. The page shows the Trade-with switch in its widget, so that choice signs ("chosen") and is
  // never changed here. A check that does not pass hands the trade to the ticket with the amount filled in: the widget
  // on the page (desktop, remounted with it) or the sheet (phones). A coin found not tradable here says why where the
  // buttons are (a gap in the index is said once in a toast and the buttons stay, so the next press checks again).
  // One trade at a time with the widget too: it tells the page while it sends (`ticketBusy`: no preset meanwhile), and
  // it sends nothing while an instant trade runs (`hold`). Each widget reports for itself (`reportTicketBusy`, one owner
  // per mounted widget): one that unmounts mid-flight (a layout switch, another coin) keeps the page held until its own
  // trade ends, and the widget mounted in its place cannot clear that.
  // A ticket the user changed while an instant trade was checked (`editedInHold`) is not filled in again over what
  // they entered: the trade they were setting up there stays as it is.
  const toast = useToast();
  const mintNow = useRef(mint);
  mintNow.current = mint;
  const narrowNow = useRef(narrow);
  narrowNow.current = narrow;
  const [prefill, setPrefill] = useState<{ n: number; mint: string; side: Side; amount: string } | null>(null);
  const [instantBlock, setInstantBlock] = useState<{ mint: string; short: string; body: string } | null>(null);
  const busyOwners = useRef(new Set<object>());
  const [ticketBusy, setTicketBusy] = useState(false);
  const reportTicketBusy = useCallback((owner: object, b: boolean) => {
    const s = busyOwners.current;
    if (b) s.add(owner); else s.delete(owner);
    setTicketBusy(s.size > 0);
  }, []);
  const onInstantTicket = useCallback((t: { coin: CoinT; side: Side; amount: string }) => {
    // the page moved to another coin while the trade was checked: the toast said why, no ticket of another coin opens
    if (t.coin.mint !== mintNow.current) return;
    if (editedInHold.current && (!narrowNow.current || sheetOpenNow.current)) {
      toast.info("The ticket keeps what you entered in it while this was checked.");
      return;
    }
    if (narrowNow.current) setSheet({ side: t.side, amount: t.amount, n: ++sheetN.current });
    else setPrefill((p) => ({ n: (p?.n ?? 0) + 1, mint: t.coin.mint, side: t.side, amount: t.amount }));
  }, [toast]);
  const onInstantBlock = useCallback((block: TradeBlock, c: CoinT) => {
    const t = blockText(block, c);
    if (block.kind === "gap") toast.info(`${t.title}. ${t.body}`);
    else setInstantBlock({ mint: c.mint, short: t.short, body: t.body });
  }, [toast]);
  // A trade that landed needs nothing here: the balance store (lib/balances.ts) reads the wallet again at its slot, and
  // the widget shows it; the tape follows the stream.
  const instant = useInstantTrade({ onTicket: onInstantTicket, onBlocked: onInstantBlock }, { signer: "chosen" });
  const { run: instantRun, opening: instantOpening, busy: instantBusy } = instant;
  useEffect(() => { setInstantBlock(null); setPrefill(null); }, [mint]);
  const runInstant = useCallback((spec: InstantSpec) => {
    if (!coin) return;
    if (busyOwners.current.size) { toast.info("A trade from the ticket is still in flight. Nothing else was sent."); return; }
    if (!instantBusy()) editedInHold.current = false;
    void instantRun(coin.mint, spec, sym(coin));
  }, [coin, instantRun, instantBusy, toast]);
  // a change made in a ticket (its side, amount, settings) while an instant trade runs; the instant row is not the ticket
  const markTicketEdit = useCallback((e: SyntheticEvent) => {
    if (!instantBusy()) return;
    const t = e.target;
    if (t instanceof Element && t.closest(".coin-instant")) return;
    editedInHold.current = true;
  }, [instantBusy]);
  // The ticket an instant trade fell back to (desktop): the widget is on screen, filled in; its amount field gets the
  // focus as soon as it is there (the widget shows it once the route is known).
  useEffect(() => {
    if (!prefill) return;
    sideRef.current?.scrollIntoView({ behavior: smooth(), block: "nearest" });
    let frames = 0, raf = 0;
    const focus = () => {
      const el = amountRef.current;
      if (el && !el.disabled) { el.focus({ preventScroll: true }); return; }
      if (++frames < 180) raf = requestAnimationFrame(focus);
    };
    raf = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(raf);
  }, [prefill]);
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
  useCoinLayout(pageRef, chartRef, !narrow && !!page.data);
  const onBuy = useCallback(() => {
    if (narrow) { openSheet("buy"); return; }
    amountRef.current?.focus({ preventScroll: true });
    amountRef.current?.scrollIntoView({ behavior: smooth(), block: "nearest" });
  }, [narrow, openSheet]);

  if (page.loading) return <div className="container coin-page"><CoinSkeleton priced /></div>;
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
  const instantWhy = instantBlock && instantBlock.mint === coin.mint ? instantBlock : null;
  const blockedShort = tradeBlocked ? blockText(tradeBlocked, coin).short : instantWhy?.short ?? null;
  // Instant trades: on with the setting and a wallet that can sign (without one, Buy / Sell open the ticket, which
  // offers to connect). The desktop row waits for the route check (a blocked coin shows the widget's own notice).
  const instantOn = instant.settings.instant && instant.hasWallet;
  const presets = { buy: instant.settings.buyPresets, sell: instant.settings.sellPresets };
  const running = !!instantOpening || ticketBusy;
  const busySide = instantOpening && instantOpening.mint === coin.mint ? instantOpening.side : null;
  const pf = prefill && prefill.mint === coin.mint ? prefill : null;

  return (
    <div ref={pageRef} className={`container coin-page ${narrow ? "has-bar" : ""}`}>
      <NewToSpore />
      <TitleSync store={store} />
      <div className="coin-grid">
        <div className="coin-main">
          <CoinBar coin={coin} store={store} daily={daily.data} maxDepth={maxDepth} />
          <div className="coin-chart" ref={chartRef}><PriceChart coin={coin} onBuy={tradeBlocked || instantWhy ? undefined : onBuy} live={store} aside={<LastTrade store={store} />} /></div>
          {/* phones: what the wallet holds of the coin, under the chart (the sticky bar has no room for it) */}
          {narrow && <YourPosition coin={coin} store={store} solUsd={solUsd} />}
          <div className="coin-activity" ref={activityRef}>
            <Reveal><CoinActivity store={store} tab={tab} onTab={setTab} maxDepth={maxDepth} narrow={narrow} otherChildren={page.data.otherChildren ?? 0} /></Reveal>
          </div>
          {/* phones: the info card follows the tabs (on desktop it sits under the trade card) */}
          {narrow && <CoinInfo coin={coin} store={store} agentCoin={agentCoin} onChildren={openChildren} />}
          {/* the X posts this coin, or the coins under it, link (nothing for a coin without any); phones: after the info card */}
          <CoinNarrative key={coin.mint} coin={coin} />
          <div className={`coin-money ${solo ? "solo" : ""}`}>
            <div className="coin-fees"><ClaimFees coin={coin} /></div>
            <AgentSlot coin={coin} />
          </div>
          {/* A child without a fee-sharing config: its creator can still lock the split (Spore's
              own split section is gone; the fee card above shows who gets what). */}
          {!coin.shares?.length && coin.depth > 0 && <div className="coin-lock"><FeeSplitAction coin={coin} onDone={page.reload} /></div>}
          <Reveal className="coin-details-wrap"><Details coin={coin} narrow={narrow} /></Reveal>
        </div>
        {!narrow && (
          // Two landmarks side by side: the trade ("Buy or sell $X") and the info card ("About $X", its own section).
          <div ref={sideRef} className="coin-side">
            <aside className="coin-ticket" aria-label={`Buy or sell ${sym(coin)}`} onClickCapture={markTicketEdit} onChangeCapture={markTicketEdit}>
              {instantOn && !tradeBlocked && (tradeRoute.data || tradeRoute.error) && (
                <InstantRow label={sym(coin)} mint={coin.mint} presets={presets} running={running} busySide={busySide} blocked={instantWhy} onRun={runInstant} />
              )}
              {/* remounted with the amount when an instant trade handed the trade back to it */}
              <PageTicket key={pf ? `ticket-${pf.n}` : "ticket"} coin={coin} solUsd={solUsd} amountRef={amountRef} current={store.coin} compact
                initialSide={pf?.side} initialAmount={pf?.amount} report={reportTicketBusy} hold={!!instantOpening} />
            </aside>
            {/* under the trade card, never above it: the ticket's top does not move when the card appears */}
            <YourPosition coin={coin} store={store} solUsd={solUsd} />
            <CoinInfo coin={coin} store={store} agentCoin={agentCoin} onChildren={openChildren} />
          </div>
        )}
      </div>
      {narrow && <PhoneBar store={store} daily={daily.data} onOpen={openSheet} blocked={blockedShort}
        instant={{ on: instantOn, presets, ready: instant.ready, run: runInstant, running, busySide }} />}
      {narrow && sheet && <TradeSheet key={sheet.n} coin={coin} store={store} side={sheet.side} amount={sheet.amount} solUsd={solUsd} onClose={() => setSheet(null)}
        report={reportTicketBusy} onEdit={markTicketEdit} hold={!!instantOpening} />}
    </div>
  );
}

/// Desktop: the chart fills the window under the coin bar and leaves the Activity tabs' head in view. That needs an
/// offset CSS cannot know (the bar wraps, the note above it comes and goes): measured here into --chart-top (the
/// chart's offset in the document); the CSS has a fallback. (The side column needs nothing: it sticks below the nav
/// and scrolls inside itself when it is taller than the window, so the trade card's top never moves.)
function useCoinLayout(pageRef: RefObject<HTMLDivElement | null>, chartRef: RefObject<HTMLDivElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const root = pageRef.current;
    if (!on || !root) return;
    const put = (k: string, v: number) => { const t = `${Math.round(v)}px`; if (root.style.getPropertyValue(k) !== t) root.style.setProperty(k, t); };
    let raf = 0;
    const apply = () => {
      raf = 0;
      const c = chartRef.current;
      if (c) put("--chart-top", c.getBoundingClientRect().top + window.scrollY);
    };
    const later = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    const ro = new ResizeObserver(later);
    ro.observe(root);
    window.addEventListener("resize", later);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener("resize", later); root.style.removeProperty("--chart-top"); };
  }, [pageRef, chartRef, on]);
}

/* ---------- the coin bar */

/// The coin in two tight lines: who it is (name, ticker, depth, status) with the CA and its links, then the numbers
/// that move (price and change with its basis, market cap, 24h volume, locked by children, the curve) with Share and
/// Launch. A narrow desktop column wraps it to a third line; phones stack it, the numbers as one sideways row. A coin
/// priced in another token (a child's parent, a root's listed quote) gets one more tight row under the numbers: that
/// token's price, change, 24 h line and market cap (ParentPrice), since the child's liquidity is that token.
function CoinBar({ coin, store, daily, maxDepth }: { coin: CoinT; store: LiveCoin; daily: Candles | null; maxDepth: number | undefined }) {
  const toast = useToast();
  // The bar takes the coin's own colour: its logo's halo and the light behind the identity.
  const [tint, onLogo] = useTint(coin.image, coin.mint);
  const [copied, flashCopied] = useCopied();
  const copyCa = async () => { if (await copyText(coin.mint)) { flashCopied(); toast.success("Contract address copied"); } else toast.error("Could not copy the contract address"); };
  const status = coin.complete && !coin.migrated ? <span className="chip warn" title="The curve filled; pump.fun is moving the coin to a PumpSwap pool">migrating</span>
    : coin.migrated ? <span className="chip good" title="Trades in its PumpSwap pool"><Term k="graduated">graduated</Term></span>
    : <span className="chip neutral">on <Term k="curve">curve</Term></span>;
  return (
    <header className={`coin-bar ${parentOf(coin) ? "has-parent" : ""}`} style={{ "--tint": tint } as CSSProperties}>
      <span className="coin-aura" aria-hidden="true" />
      <span className="coin-logo-wrap"><Logo src={coin.image} label={coin.symbol} size={44} className="coin-logo" onLoad={onLogo} /></span>
      <div className="cb-line cb-l1">
      <div className="cb-id">
        <h1 title={nameOf(coin)}>{nameOf(coin)}</h1>
        <span className="ticker mono">{sym(coin)}</span>
        <DepthBadge depth={coin.depth} long term maxDepth={maxDepth} quote={listedQuoteOf(coin)} />
        {status}
      </div>
      <div className="cb-tools">
        <button type="button" className={`ca-pill ${copied ? "done" : ""}`} onClick={copyCa} aria-label={`Copy contract address ${coin.mint}`} title={coin.mint}>
          <span className="ca-k">CA</span><span className="mono ca-v">{coin.mint.slice(0, 4)}…{coin.mint.slice(-4)}</span>
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
      </div>
      <div className="cb-line cb-l2">
        <BarNums store={store} daily={daily} />
        <div className="coin-actions">
          <ShareMenu coin={coin} current={store.coin} />
          <LaunchButton coin={coin} maxDepth={maxDepth} variant="ghost" size="sm" label={`Launch under ${sym(coin)}`} />
        </div>
      </div>
      {/* what the pool is paired with (a child's parent, a root's listed quote): its own tight row under the numbers */}
      <ParentPrice store={store} />
    </header>
  );
}

/// The numbers that move: price (a move flashes once, at most every 600 ms, and leaves a small static arrow for two
/// seconds that survives reduced motion) with its change, then market cap, 24h volume, locked by children and, on the
/// curve, how far it is to graduation. The detail behind each (trades, buys and sells, the locked amount, the pool)
/// is in the info card.
function BarNums({ store, daily }: { store: LiveCoin; daily: Candles | null }) {
  const coin = useLive(store, (s) => s.coin);
  const numsRef = useRef<HTMLDivElement>(null);
  const tick = useLive(store, (s) => s.tick);
  const delta = useMemo(() => (daily ? change24h(daily.candles, coin, daily.priceKey) : null), [daily, coin]);
  const spark = useMemo(() => daySpark(daily, coin), [daily, coin]);
  const sparkOn = useSparkRoom(numsRef, !!spark);
  const [arrow, setArrow] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (!tick) return;
    setArrow(tick.dir);
    const t = setTimeout(() => setArrow(null), 2_000);
    return () => clearTimeout(t);
  }, [tick]);
  const main = priceText(coin);
  // A real amount gets the accent; dust reads "< $0.01" like the cards (the exact figure is in the title).
  const locked = coin.lockedUsd != null && coin.lockedUsd >= 0.01;
  const dust = coin.lockedUsd != null && coin.lockedUsd > 0 && !locked;
  return (
    <div ref={numsRef} className="cb-nums">
      <div className="cb-price">
        <span className="sr-only">Price</span>
        {arrow && <span className={`tick-arrow ${arrow}`} aria-hidden="true">{arrow === "up" ? "▲" : "▼"}</span>}
        <b key={tick?.id ?? 0} className={`price-now mono ${tick ? `tick-${tick.dir}` : ""}`}>{main}</b>
        {/[₀-₉]/.test(main) && <Term k="subscript" icon>What does the small digit mean?</Term>}
        {/* Phones show the short basis ("· 4h") so the change fits beside the price. */}
        {delta ? <><span className="d-long"><Delta ratio={delta.ratio} label={delta.label} title={delta.title} /></span><span className="d-short"><Delta ratio={delta.ratio} label={`· ${delta.short}`} title={delta.title} /></span></> : <span className="delta flat" title="Not enough price history for a change figure yet">— <small>no history yet</small></span>}
        {spark && sparkOn && <span className="cb-spark"><Sparkline points={spark} tone={sparkTone(delta?.ratio ?? spark[spark.length - 1] / spark[0] - 1)} w={84} h={24} label={`Price over ${!delta || delta.short === "24h" ? "the last 24 hours" : `the last ${delta.short}`}${delta ? `, ${changeWords(delta)}` : ""}`} /></span>}
      </div>
      <dl className="cb-stats">
        <div className="cb-stat"><dt><Term k="mcap">Market cap</Term></dt>
          <dd className="mono" title={coin.mcapUsd != null && coin.mcapSol != null ? `${usd(coin.mcapUsd)} · ${sol(coin.mcapSol)}` : undefined}>{coin.mcapUsd != null ? <Tween value={coin.mcapUsd} format={usd} /> : sol(coin.mcapSol)}{coin.mcapUsd != null && coin.mcapSol != null && <span className="mc-sol"> · {sol(coin.mcapSol)}</span>}</dd></div>
        <div className="cb-stat"><dt><Term k="volume">24h volume</Term></dt>
          <dd className="mono">{coin.volume24hUsd > 0 ? <Tween value={coin.volume24hUsd} format={usd} /> : <span className="zero">{usd(coin.volume24hUsd)}</span>}</dd></div>
        <div className={`cb-stat ${locked ? "hero" : ""}`}><dt><Term k="locked">Locked by children</Term></dt>
          <dd className="mono">{locked ? <Tween value={coin.lockedUsd ?? 0} format={usd} /> : dust ? <span title={usd(coin.lockedUsd)}>{usdCard(coin.lockedUsd)}</span> : <span className="zero">—</span>}</dd></div>
        {!coin.migrated && !coin.complete && (
          <div className="cb-stat cb-curve"><dt><Term k="curve">To graduation</Term></dt>
            <dd className="mono">{pctCurve(coin.progress)}<ProgressBar value={coin.progress} /></dd></div>
        )}
      </dl>
    </div>
  );
}

/// The coin's 24 h line beside its price is the first thing the bar gives up: shown unless it makes the bar wrap (the
/// stats under the price, a stat onto a second line, or Share / Launch under the numbers). Dropped at a bar width, it
/// is tried again only once the bar is wider than that, so it never flickers in and out.
function useSparkRoom(numsRef: RefObject<HTMLDivElement | null>, has: boolean): boolean {
  const [offAt, setOffAt] = useState<number | null>(null);
  const offRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const nums = numsRef.current;
    const bar = nums?.closest<HTMLElement>(".coin-bar");
    if (!has || !nums || !bar) return;
    const wrapped = () => {
      const top = (e: Element | null) => (e ? e.getBoundingClientRect().top : 0);
      const price = nums.querySelector(".cb-price"), stats = nums.querySelectorAll(".cb-stat");
      if (price && stats.length && top(stats[0]) >= price.getBoundingClientRect().bottom - 2) return true;
      if (stats.length > 1 && top(stats[stats.length - 1]) > top(stats[0]) + 2) return true;
      const line = bar.querySelector<HTMLElement>(".cb-l2"), act = line?.querySelector(".coin-actions");
      return !!(line && act && getComputedStyle(line).display === "flex" && top(act) > top(nums) + 4);
    };
    const check = () => {
      const w = bar.clientWidth;
      if (offRef.current != null) {
        if (w > offRef.current) { offRef.current = null; setOffAt(null); }
        return;
      }
      const s = nums.querySelector(".cb-spark");
      if (!s || getComputedStyle(s).display === "none") return;
      if (wrapped()) { offRef.current = w; setOffAt(w); }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [numsRef, has, offAt]);
  return has && offAt == null;
}

/// The last trade, in the chart's foot: a link to it on solscan while it is under an hour old. It is the chart card's
/// only "last trade … ago" (PriceChart leaves its head line out when it has this aside). On a narrow foot the side
/// and size give way (an ellipsis) and the time stays.
function LastTrade({ store }: { store: LiveCoin }) {
  const t = useLive(store, (s) => s.trades[0] ?? null);
  const fresh = t ? Date.now() / 1000 - t.time < 3_600 : false;
  const now = useNow(fresh ? 1_000 : 60_000);
  if (!t) return <span className="last-trade none"><span className="lt-what">No trades seen yet</span></span>;
  const ago = Math.max(0, now - t.time);
  if (ago >= 3_600) return <span className="last-trade none"><span className="lt-what">Last trade</span><span className="lt-ago">{age(t.time)} ago</span></span>;
  const coin = store.get().coin;
  const size = coin.quoteMint === null ? sol(tokens(t.quoteAmount, 9)) : (tradeUsd(t, coin.decimals) != null ? usdCard(tradeUsd(t, coin.decimals)) : amount(tokens(t.quoteAmount, quoteDecimalsOf(coin)), coin.quoteSymbol));
  return (
    <a className={`last-trade ${t.isBuy ? "buy" : "sell"}`} href={solscanTx(t.sig)} target="_blank" rel="noreferrer" title="Open the transaction on solscan">
      <i aria-hidden="true" /><span className="lt-what">{t.isBuy ? "Buy" : "Sell"} {size}<span className="lt-who"> · {short(t.user, 4)}</span></span>
      <span className="lt-ago">· {ago < 5 ? "just now" : ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`}</span>
    </a>
  );
}

/* ---------- the info card (under the trade card; after the tabs on phones) */

/// What the coin is, in plain words: the intro sentence and the description, where it hangs (breadcrumb, children),
/// its status and pool, the day's trades, what its children lock, its marks (Spore launch, holder rewards, agent)
/// and, for a root, its dominance on the map.
function CoinInfo({ coin, store, agentCoin, onChildren }: { coin: CoinT; store: LiveCoin; agentCoin: ReturnType<typeof useAgentCoin>; onChildren: () => void }) {
  const prov = provenanceFromAgentCoin(agentCoin);
  const toAgent = (e: ReactMouseEvent) => { const el = document.getElementById("agent"); if (!el || !el.firstElementChild) return; e.preventDefault(); el.scrollIntoView({ behavior: smooth(), block: "center" }); };
  const mark = coin.mint === OFFICIAL_CA ? <span className="spore-mark"><span aria-hidden="true">✓</span> official $SPORE</span>
    : coin.ours ? <span className="spore-mark" title="Its on-chain fee split names the Spore wallet"><span aria-hidden="true">✓</span> launched on Spore</span>
    : coin.oursPending ? <span className="spore-mark pending" title="Reported as a Spore launch; the indexer is verifying the fee split on-chain">verifying launch</span> : null;
  const marks = mark || coin.holderReward || prov;
  return (
    <section className="card coin-info" aria-label={`About ${sym(coin)}`}>
      <div className="coin-about">
        <LiveIntro store={store} agentCoin={agentCoin} />
        {coin.description && <Description text={coin.description} />}
      </div>
      <div className="coin-lineage">
        <ChainBreadcrumb coin={coin} variant="header" rootQuote={null} />
        <FamilyStrip store={store} onChildren={onChildren} showLineage={false} />
      </div>
      <InfoFacts store={store} />
      {marks && (
        <div className="coin-status">
          {mark}
          {coin.holderReward && <span className="chip violet" title="Creator fees go to holders; the fee split does not apply">holder rewards</span>}
          {prov?.role === "child" && <AgentChip prov={prov} />}
          {prov?.role === "root" && <a href="#agent" className="agent-anchor" onClick={toAgent} title="Jump to this coin's agent"><AgentChip prov={prov} link={false} /></a>}
        </div>
      )}
      {coin.depth === 0 && <CoinDominance mint={coin.mint} />}
    </section>
  );
}

/// The detail behind the bar's numbers, one quiet line each: status and pool, the day's trades with the buy / sell
/// split of the latest ones, and what the children lock.
function InfoFacts({ store }: { store: LiveCoin }) {
  const coin = useLive(store, (s) => s.coin);
  const trades = useLive(store, (s) => s.trades);
  const now = Math.floor(Date.now() / 1000);
  const day = trades.filter((t) => now - t.time < 86_400);
  const buys = day.filter((t) => t.isBuy).length, sells = day.length - buys;
  // The tape holds the last 50 trades: when the day had more, the split is of the latest ones.
  const covers = day.length >= coin.trades24h;
  const lockedQuote = tokens(coin.lockedQuote, coin.decimals);
  const some = coin.lockedUsd != null && coin.lockedUsd > 0;
  return (
    <ul className="coin-facts">
      <li>{coin.migrated ? <>Graduated · trades on PumpSwap{coin.pool && <> · <a href={solscanAccount(coin.pool)} target="_blank" rel="noreferrer" className="mono">pool {short(coin.pool, 4)}</a></>}</>
        : coin.complete ? <>Migrating · moving to a PumpSwap pool</>
        : <>On the <Term k="curve">curve</Term> · {pctCurve(coin.progress)} to graduation</>}</li>
      <li className="fact-trades">
        <span>{plural(coin.trades24h, "trade")} in 24h{day.length > 0 && <> · {covers ? "" : `last ${day.length}: `}{buys} buys / {sells} sells</>}</span>
        {day.length > 0 && <span className="bs-bar" role="img" aria-label={`${buys} buys and ${sells} sells among the latest trades`}><i className="b" style={{ flexGrow: buys }} /><i className="s" style={{ flexGrow: sells }} /></span>}
      </li>
      <li>{some ? <>{amount(lockedQuote, sym(coin))} locked in {plural(coin.children, "child", "children")}</> : coin.children === 0 ? "No children yet" : "Its children hold none yet"}</li>
    </ul>
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
/// `blocked`: why the coin cannot be traded here (lib/trade-route): the bar offers pump.fun instead of Buy and Sell.
/// `instant`: with `on`, Buy / Sell open the user's presets under the button (TradePresets) after the wallet step
/// (`ready`), a preset is the trade (`run`) and "Custom…" opens the sheet; off, they open the sheet as before. While a
/// trade of the page runs (`running`) both buttons are off, the pressed side (`busySide`) with a spinner.
function PhoneBar({ store, daily, onOpen, blocked = null, instant }: { store: LiveCoin; daily: Candles | null; onOpen: (s: Side) => void; blocked?: string | null; instant: BarInstant }) {
  const coin = useLive(store, (s) => s.coin);
  const tick = useLive(store, (s) => s.tick);
  const delta = useMemo(() => (daily ? change24h(daily.candles, coin, daily.priceKey) : null), [daily, coin]);
  const [menu, setMenu] = useState<Side | null>(null);
  const buyRef = useRef<HTMLButtonElement>(null), sellRef = useRef<HTMLButtonElement>(null);
  // a trade under way, instant trades turned off or a blocked coin closes the presets
  const off = instant.running || !instant.on || !!blocked;
  useEffect(() => { if (off) setMenu(null); }, [off]);
  const shown = off ? null : menu;
  const press = (side: Side) => {
    if (!instant.on) { onOpen(side); return; }
    if (menu === side) { setMenu(null); return; }
    // a locked trading wallet is asked to unlock, and nothing else happens
    if (instant.ready()) setMenu(side);
  };
  const pop = (side: Side) => (instant.on ? { "aria-haspopup": "dialog" as const, "aria-expanded": shown === side } : {});
  const spin = (side: Side) => instant.busySide === side;
  const choices = shown ? presetChoices(shown, shown === "buy" ? instant.presets.buy : instant.presets.sell) : [];
  return (
    <div className="trade-bar" role="region" aria-label={`Trade ${sym(coin)}`}>
      {!coin.migrated && <i className="bar-progress" style={{ transform: `scaleX(${Math.max(0.01, Math.min(1, coin.progress))})` }} aria-hidden="true" />}
      <div className="trade-bar-price">
        <b key={tick?.id ?? 0} className={`bar-price mono ${tick ? `tick-${tick.dir}` : ""}`}>{priceText(coin)}</b>
        <span className="bar-sub">{delta && <Delta ratio={delta.ratio} label={delta.short} title={delta.title} />}<span className="mono">{coin.mcapUsd != null ? `MC ${usd(coin.mcapUsd)}` : mcText(coin)}</span></span>
        {/* the token the pool is paired with: its price moves this coin's (nothing for SOL) */}
        <ParentBarLine store={store} />
      </div>
      {blocked
        ? <span className="trade-bar-blocked"><Ext href={pumpUrl(coin.mint)} className="btn ghost trade-bar-ext" title={`Not tradable here: ${blocked}`}>Trade on pump.fun ↗</Ext><small>not tradable here · {blocked}</small></span>
        : <><button ref={buyRef} type="button" className={`btn accent${spin("buy") ? " is-busy" : ""}`} disabled={instant.running} aria-busy={spin("buy") || undefined} {...pop("buy")} onClick={() => press("buy")}>Buy</button>
          <button ref={sellRef} type="button" className={`btn violet${spin("sell") ? " is-busy" : ""}`} disabled={instant.running} aria-busy={spin("sell") || undefined} {...pop("sell")} onClick={() => press("sell")}>Sell</button></>}
      {shown && (
        <TradePresets side={shown} label={`${shown === "buy" ? "Buy" : "Sell"} ${sym(coin)}`} anchor={(shown === "buy" ? buyRef : sellRef).current}
          presets={choices.map((c) => c.text)} onPick={(i) => { const c = choices[i]; if (c) instant.run(c.spec); }}
          onCustom={() => onOpen(shown)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
type BarInstant = { on: boolean; presets: { buy: readonly number[]; sell: readonly number[] }; ready: () => boolean; run: (spec: InstantSpec) => void; running: boolean; busySide: Side | null };

/// One mounted ticket's own report of its trade in flight (`report` with this widget as the owner): the page counts
/// owners, so a widget that mounts while another one that unmounted is still sending cannot clear that one's busy.
function useOwnBusy(report: ((owner: object, busy: boolean) => void) | undefined) {
  const owner = useRef({});
  return useCallback((b: boolean) => report?.(owner.current, b), [report]);
}

/// The desktop trade card's widget, reporting its trade in flight for itself (useOwnBusy).
function PageTicket({ report, ...props }: Omit<TradeWidgetProps, "onBusy"> & { report: (owner: object, busy: boolean) => void }) {
  const onBusy = useOwnBusy(report);
  return <TradeWidget {...props} onBusy={onBusy} />;
}

/// The phone trade sheet: a real modal (portal, focus trap, Escape, focus back to the bar).
/// `amount`: what its field opens with (an instant trade handed back to the ticket); `report` / `hold`: one trade at a
/// time with the page's instant trades (TradeWidget, useOwnBusy); `onEdit`: a change made in it (click or input).
function TradeSheet({ coin, store, side, amount, solUsd, onClose, report, onEdit, hold }: { coin: CoinT; store: LiveCoin; side: Side; amount?: string; solUsd: number | null; onClose: () => void; report?: (owner: object, busy: boolean) => void; onEdit?: (e: SyntheticEvent) => void; hold?: boolean }) {
  const amountRef = useRef<HTMLInputElement>(null);
  // A trade in flight keeps the sheet open (its progress, and no second trade started beside it).
  const busy = useRef(false);
  const reportOwn = useOwnBusy(report);
  const onBusy = useCallback((b: boolean) => { busy.current = b; reportOwn(b); }, [reportOwn]);
  const close = useCallback(() => { if (!busy.current) onClose(); }, [onClose]);
  const ref = useDialog<HTMLDivElement>(true, close, { initialFocus: amountRef });
  const titleId = useId();
  useScrollLock(true);
  return createPortal(
    <div className="trade-sheet-backdrop" onClick={close}>
      <div ref={ref} className="trade-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()} onClickCapture={onEdit} onChangeCapture={onEdit}>
        <TradeWidget coin={coin} solUsd={solUsd} initialSide={side} initialAmount={amount} sheet onClose={close} amountRef={amountRef} titleId={titleId} current={store.coin} onBusy={onBusy} hold={hold} />
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

/// The loading page in the loaded page's shape (bar, a chart of the same height, the tabs; the trade and info cards).
/// `priced`: the bar keeps the "Priced in" row's room (a coin seen before is known; an unknown one is taken for a
/// child, as most coins here are, and a root's bar then loses the row when it loads).
function CoinSkeleton({ priced }: { priced: boolean }) {
  return (
    <div className="coin-grid" aria-busy="true" aria-label="Loading the coin">
      <div className="coin-main">
        <header className={`coin-bar sk-bar ${priced ? "has-parent" : ""}`}>
          <span className="coin-logo-wrap"><Skeleton w={44} h={44} r={13} /></span>
          <div className="cb-line cb-l1"><div className="cb-id"><Skeleton w={260} h={28} /></div><div className="cb-tools"><Skeleton w={300} h={30} r={999} /></div></div>
          <div className="cb-line cb-l2"><div className="cb-nums"><Skeleton w={420} h={34} /></div><div className="coin-actions"><Skeleton w={220} h={30} r={999} /></div></div>
          {priced && <div className="cb-parent"><Skeleton className="sk-pc" w={380} h={34} r={999} /></div>}
        </header>
        <div className="coin-chart"><Skeleton className="sk-chart" r={16} /></div>
        <div className="coin-activity"><Skeleton h={420} r={16} /></div>
      </div>
      <aside className="coin-side sk-side"><Skeleton h={430} r={16} /><Skeleton h={250} r={16} /></aside>
    </div>
  );
}
