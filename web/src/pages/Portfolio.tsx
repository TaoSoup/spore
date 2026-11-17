// The Portfolio page: for one wallet, three lists under four summary figures (value, unrealized and realized profit,
// fees to claim).
// HOLDINGS: the coins the wallet bought (it holds them and did not launch them), one flat list, largest value first,
// each with its unrealized profit; its "Closed" side lists the coins it traded and no longer holds.
// YOUR SPORES: the pairs the wallet launched (a child coin under a parent, priced in the parent's token) and the coins
// whose creator fees it shares, one card per parent coin; each row has its fees to claim. A coin is in one list only.
// The wallet shown is the user's trading wallet (the browser wallet they trade with; its address is known while it is
// locked). There is no switch between wallets: a connected extension wallet is how the account was made, so the pairs
// it launched before and the fees their splits pay it are listed with the trading wallet's own. Without a trading
// wallet the connected wallet is shown. /portfolio?wallet=<address> shows any address
// read-only. Numbers come from /api/portfolio/:wallet and /api/claims/:wallet (lib/portfolio.ts sorts them into the
// two lists); the SOL line comes from the tab's balance store (lib/balances.ts), which reads it again at the slot of
// each trade that lands, and falls back to the API's figure.
// AFTER A TRADE: the store tells the page the slot of every transaction of the wallet shown (or of the connected wallet
// beside it) that lands, sent here or seen on the live stream. The page reloads at once (at most once per 10 s, the
// rest at the end of that time), asking the API for figures read at that slot or later (?after=, past every cache);
// under an open ticket, popover or claim it waits until they close (the rows must not move under them). For about 19 s
// after such a reload the wallet's plain reloads skip the browser's cache too, which may still hold the body from
// before the trade. A second reload 4 s later picks up the indexer's P&L and prices. Only the user's own wallets react
// to landings: an address previewed read-only keeps the 15 s poll (a busy bot wallet would otherwise reload it nonstop).
// ACTIVITY: the wallet's own trades, newest first (/api/activity/:wallet).
// Profit and loss comes from /api/pnl/:wallet, joined with the holdings in lib/pnl.ts. It is a read of its own: when it
// fails or is rate limited the rest of the page works and the P&L places show a dash. The server reads a wallet's
// past transactions once, in the background; while it does the page asks again every 5 s and says how far it is.
// Every P&L dollar is at today's price of SOL / the parent coin, without network fees and tips.
// MONEY: the page keeps every money figure in USD and writes it through one formatter, `money()` (lib/money.ts),
// handed down by MoneyCtx: the "USD | SOL" switch beside the period turns all of them into SOL at the current SOL
// price (off, and said why, while that price is not known). Percentages, token amounts and a coin's price stay.
// The card under the tiles draws the realized P&L over the period (/api/pnl/:wallet/series, PnlChart.tsx); it is
// read with the P&L, one request at a time, and an API without that route (404) leaves the card's empty line.
// Buy / Sell trade with the wallet shown: a locked trading wallet is asked to unlock first (the panel closes once it
// is unlocked and the user presses again), and an unlocked one is made the wallet that trades (lib/trader.ts).
// With instant trades on (Trade settings, the default) the button shows the user's presets (TradePresets.tsx) and a
// preset trades at once through lib/instant-trade.ts (components/useInstantTrade.ts, shared with the map): no ticket.
// A trade that fails one of its checks opens the ticket with the amount filled in and a toast that says why; "Custom…"
// and instant trades off open the ticket as before.
// One trade runs at a time: while one does, every trade button of the page is off.
// Claims are built in the browser and signed by the account wallet (useClaimFlow, lib/trader.ts useAccount): the
// trading wallet when there is one (unlocked first; it signs on the confirm dialog's button, with no popup), else the
// connected wallet. A payout is permissionless and pays the wallets of the coin's fee split, so the trading wallet
// also runs the payouts of coins the connected wallet launched: their part goes to the connected wallet, and the
// dialog says so. Long lists are cut:
// 10 holdings, 12 parent cards and 5 rows a card, the rest behind a button.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { api, ApiError, errorMessage, pumpUrl, solscanTx, type Candle, type Candles, type ClaimCoin, type Coin, type Pnl, type PnlSeries, type WalletTrade } from "../lib/api";
import { useAsync, useSolBalance, useStats } from "../lib/hooks";
import { subscribeLanded } from "../lib/balances";
import { ago, amount, count, lamportsToSol, plural, short, signedPct, sol, tokens, usd, usdCard, when } from "../lib/format";
import type { InstantSpec } from "../lib/instant-trade";
import { appendPage, buildPnl, historyLine, historyRunning, mergeFirstPage, pnlAvailable, pnlPct, pnlTone, quotePrices, type PnlAmount, type PnlRow, type TradeList } from "../lib/pnl";
import { makeMoney, MONEY_UNITS, type Money, type MoneyUnit } from "../lib/money";
import { seriesPoints } from "../lib/pnl-chart";
import { buildPortfolio, claimableRows, type PfClaim, type PfGroup, type PfRow } from "../lib/portfolio";
import { blockText, hardBlock, loadTradeRoute, type TradeBlock } from "../lib/trade-route";
import { openTradeSettings, openTradingWallet, useTrader } from "../lib/trader";
import type { Side } from "../lib/pump";
import { Addr, ErrorBox, Logo, SkeletonRows, sym } from "../components/Bits";
import { Sprout } from "../components/LaunchButton";
import QuickTrade from "../components/QuickTrade";
import TradePresets from "../components/TradePresets";
import { useInstantTrade } from "../components/useInstantTrade";
import PnlChart from "../components/portfolio/PnlChart";
import { candleChange, spanLabel } from "../components/map/panel/Sparkline";
import SlidingPill from "../components/ui/SlidingPill";
import { useToast } from "../components/Toast";
import { useClaimFlow, type ClaimTarget } from "../components/claim/useClaimFlow";
import "../components/portfolio/portfolio.css";

const POLL_MS = 15_000;
const CLAIM_CACHE_MS = 16_000; // the API caches a coin's fees for 15 s; read again after a claim once it has turned over
const TRADE_SETTLE_MS = 4_000; // a trade's P&L and new price reach the indexer a few seconds after it lands
const LANDING_GAP_MS = 10_000;  // landings reload the page at most this often (the newest slot is the one asked)
// after a reload with ?after=, the wallet's plain reloads skip the browser's cache this long: its copy of the plain
// answer may predate the trade, and the server lets the browser serve it up to 15 s (max-age 3 + stale-while-revalidate 12)
const FRESH_MS = POLL_MS + TRADE_SETTLE_MS;
const BLOCK_READ_MS = 5_000;   // a "not tradable here" reason stays at least this long, so a refresh right after the click does not hide it unread
const CARDS_STEP = 12;         // parent cards shown at first, and added by "Show more"
const ROWS_MAX = 5;            // rows a card shows before "Show all"
const DUST_USD = 1;             // "Hide small" drops holdings worth less than this (a holding without a price stays)
const PNL_POLL_MS = 5_000;      // how often the P&L is asked again while the server still reads the wallet's history
const SINCE_STEP_S = 600;       // a period's start is rounded down to this, so refreshes ask the server for the same window
const ACTIVITY_PAGE = 25;       // trades a page of the Activity list
const CLOSED_MAX = 10;          // closed positions shown before "Show all"
type Tab = "holdings" | "spores" | "activity";
type HoldSort = "value" | "pnl" | "volume" | "recent";
const SORTS: [HoldSort, string, string][] = [["value", "Value", "Largest value held first"], ["pnl", "P&L", "Largest unrealized profit first"], ["volume", "Volume", "Most traded in 24 h first"], ["recent", "Recent", "Most recently traded first"]];
/// The period of the realized P&L and of the closed positions: its key, its button, its days (null: everything), its name.
type Period = "1d" | "7d" | "30d" | "all";
const PERIODS: [Period, string, number | null, string][] = [["1d", "1d", 1, "last 24 hours"], ["7d", "7d", 7, "last 7 days"], ["30d", "30d", 30, "last 30 days"], ["all", "All", null, "all time"]];
const sinceOf = (p: Period): number | null => {
  const days = PERIODS.find(([k]) => k === p)?.[2] ?? null;
  return days === null ? null : Math.floor((Date.now() / 1000 - days * 86_400) / SINCE_STEP_S) * SINCE_STEP_S;
};
/// True when an answer's window is the one of the period chosen. A refresh can be some steps behind the clock, never
/// half a day: the periods lie days apart.
const sameWindow = (since: number | null, p: Period) => { const want = sinceOf(p); return since === null || want === null ? since === want : Math.abs(since - want) < 43_200; };
const PNL_NOTE = "P&L is valued at today's price of SOL or the parent coin. Network fees and tips are not included.";
const SOLD_UNKNOWN = "Coins sold without a recorded buy, or without a price to value them with";
const APPROX_NOTE = "Approximate: some tokens were received without a recorded buy, so they are left out";
/// Where the P&L read stands: no answer yet, failed (or rate limited), answered without P&L, answered while the
/// holdings could not be read (realized figures only), or there.
type PnlState = "loading" | "failed" | "off" | "nohold" | "ok";
const PNL_WHY: Record<PnlState, string | undefined> = { loading: "Reading the trades", failed: "P&L could not be read just now", off: "P&L is not available right now", nohold: "Holdings could not be read just now", ok: undefined };
/// A small choice kept in this browser (the tab, the sort, the dust switch); storage may be blocked.
function usePick<T extends string>(key: string, allowed: readonly T[], initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => { try { const x = localStorage.getItem(key) as T | null; return x && allowed.includes(x) ? x : initial; } catch { return initial; } });
  const set = useCallback((n: T) => { setV(n); try { localStorage.setItem(key, n); } catch { /* blocked storage */ } }, [key]);
  return [v, set];
}
const HOLDINGS_MAX = 10;       // holdings shown before "Show all"
/// The page's money formatter (lib/money.ts): the unit chosen and the SOL price, for every part of the page.
const MoneyCtx = createContext<Money>(makeMoney("usd", null));
const useMoney = () => useContext(MoneyCtx);
const NO_SOL_PRICE = "The SOL price is not known right now, so figures stay in dollars";
const target = (c: ClaimCoin): ClaimTarget => ({ mint: c.mint, symbol: c.symbol, image: c.image, quoteSymbol: c.quoteSymbol, quoteDecimals: c.quoteDecimals, total: c.total, perShare: c.perShare, depth: c.depth });
const feeText = (k: PfClaim) => amount(tokens(k.amount, k.quoteDecimals), k.quoteSymbol);
const mapLink = (mint: string) => `/map?focus=${encodeURIComponent(mint)}`;
/// A base58 Solana address, or null.
function address(s: string | null): string | null {
  if (!s) return null;
  try { return new PublicKey(s.trim()).toBase58(); } catch { return null; }
}

type Opening = { mint: string; side: Side } | null;
type Blocked = Record<string, { short: string; body: string; at: number }>;
type Flow = ReturnType<typeof useClaimFlow>;
/// What a card needs from the page: the trade opener and its state, and the claim flow (null: no Claim buttons).
/// `buy`: a wallet of the user's can trade; `sell`: that wallet is the one shown, so its holdings are the ticket's.
/// `readOnly`: the wallet shown is not the user's.
/// `instant`: Buy / Sell show the presets and a preset trades at once (`onInstant`); off, they open the ticket
/// (`onTrade`, also what "Custom…" does). `ready`: the wallet step before a trade: false when the trading wallet had
/// to be asked to unlock first (nothing else happens then). `onMenu`: a preset popover opened or closed (the page does
/// not refresh in the background under an open one).
type Actions = { opening: Opening; blocked: Blocked; onTrade: (mint: string, side: Side) => void; flow: Flow | null; buy: boolean; sell: boolean; readOnly: boolean;
  instant: boolean; presets: { buy: number[]; sell: number[] }; ready: () => boolean; onInstant: (mint: string, spec: InstantSpec, label: string) => void; onMenu: (open: boolean) => void };
/// The small "~" before a figure that leaves out tokens without a recorded buy.
const Approx = ({ n }: { n: number | null }) => (n !== null && Math.abs(n) >= 0.005 ? <span className="pf-approx" title={APPROX_NOTE}>~<span className="sr-only">approximately </span></span> : null);

export default function Portfolio() {
  useEffect(() => { document.title = "Portfolio · Spore"; return () => { document.title = "Spore"; }; }, []);
  const [params] = useSearchParams();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const { trader, tw } = useTrader();
  const { stats } = useStats();
  const toast = useToast();

  // The wallet shown: the trading wallet, else the connected wallet; ?wallet= shows any address read-only.
  const ext = wallet.publicKey?.toBase58() ?? null;
  const mine = tw.address ?? ext;
  const asked = params.get("wallet");
  const preview = address(asked);
  const shown = preview ?? mine;
  const readOnly = !!preview && preview !== tw.address && preview !== ext;
  const isTrading = !!shown && shown === tw.address;
  const shownKey = useMemo(() => (shown ? new PublicKey(shown) : null), [shown]);
  const solLive = useSolBalance(connection, shownKey).lamports;
  // The connected wallet beside a trading wallet: it signed the launches, so its pairs and fees belong on the page.
  const also = !preview && tw.address && ext && ext !== tw.address ? ext : null;
  // Tickets trade with the wallet shown: the trading wallet (unlocked on the click), or the connected wallet when
  // there is no trading wallet. A read-only view can still buy with the user's own wallet.
  const tradeAddr = tw.address ?? trader.publicKey?.toBase58() ?? null;
  const tradesShown = !!shown && !readOnly && shown === tradeAddr;
  const locked = isTrading && !readOnly && tw.status !== "unlocked";

  // Latest reloaders, read when a claim or a trade lands (the flow hook is created before the fetches).
  const reloadRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => reloadRef.current(), []);
  const onClaimed = useCallback(() => { refresh(); setTimeout(refresh, CLAIM_CACHE_MS); }, [refresh]);
  const flow = useClaimFlow(onClaimed);
  // The slot of the latest landed transaction of each wallet whose figures have not been read at it yet: every reload
  // asks the API for that slot or later until an answer reaches it (a degraded answer has no slot and keeps it; an
  // older server sends no slot, so one reload uses it up).
  const afters = useRef(new Map<string, number>());
  // wallet -> until when its reloads skip the browser's cache (FRESH_MS after a reload with `after`)
  const freshUntil = useRef(new Map<string, number>());
  const readPf = useCallback((w: string) => {
    const after = afters.current.get(w), now = Date.now();
    if (after !== undefined) freshUntil.current.set(w, now + FRESH_MS);
    return api.portfolio(w, after, (freshUntil.current.get(w) ?? 0) > now).then((b) => {
      if (after !== undefined && afters.current.get(w) === after && (b.slot === undefined || (b.slot !== null && b.slot >= after))) afters.current.delete(w);
      return b;
    });
  }, []);
  const pf = useAsync(() => (shown ? readPf(shown) : Promise.resolve(null)), [shown]);
  const pf2 = useAsync(() => (also ? readPf(also).catch(() => null) : Promise.resolve(null)), [also]);
  // Fees are a second read: when it fails the holdings still show, without amounts to claim.
  const claims = useAsync(() => (shown ? api.claimsFor(shown) : Promise.resolve(null)), [shown]);
  const claims2 = useAsync(() => (also ? api.claimsFor(also).catch(() => null) : Promise.resolve(null)), [also]);
  // Profit and loss of the wallet shown, a read of its own: a failure leaves the lists as they are.
  const [period, setPeriod] = usePick<Period>("spore:pf-period", ["1d", "7d", "30d", "all"], "all");
  // One request at a time: a refresh asked for while one is in flight is skipped (the hook drops the answer of a call
  // it has replaced, so a slow answer would otherwise never land under the 5 s poll).
  const pnlFlight = useRef<object | null>(null);
  const pnlQ = useAsync<Pnl | null>(() => {
    if (!shown) return Promise.resolve(null);
    const mark = {};
    pnlFlight.current = mark;
    return api.pnl(shown, sinceOf(period)).finally(() => { if (pnlFlight.current === mark) pnlFlight.current = null; });
  }, [shown, period]);
  // The answer of another period stays for the unrealized figures (they do not depend on the period) while the new one loads.
  // (For one render after the wallet or the period changed the hook still holds the answer before: it is not used,
  // told by its wallet and by the start of its window.)
  const pnlNow = pnlQ.data && pnlQ.data.wallet === shown && sameWindow(pnlQ.data.since, period) ? pnlQ.data : null;
  const lastPnl = useRef<Pnl | null>(null);
  if (pnlNow) lastPnl.current = pnlNow;
  const pnlAny = pnlNow ?? (lastPnl.current && lastPnl.current.wallet === shown ? lastPnl.current : null);
  const reloadPnlNow = pnlQ.reload;
  const reloadPnl = useCallback(() => { if (!pnlFlight.current) reloadPnlNow(); }, [reloadPnlNow]);
  // The realized P&L over time, for the chart: read with the P&L (same wallet, same period, one request at a time).
  // An API that does not have the route yet answers 404: that reads as "no points", the card's empty line.
  const seriesFlight = useRef<object | null>(null);
  const seriesQ = useAsync<PnlSeries | null>(() => {
    if (!shown) return Promise.resolve(null);
    const mark = {}, wallet = shown, since = sinceOf(period);
    seriesFlight.current = mark;
    return api.pnlSeries(wallet, since)
      .catch((e): PnlSeries => { if (e instanceof ApiError && e.status === 404) return { ok: true, wallet, at: Math.floor(Date.now() / 1000), since, solUsd: null, points: [], unpriced: 0 }; throw e; })
      .finally(() => { if (seriesFlight.current === mark) seriesFlight.current = null; });
  }, [shown, period]);
  const seriesNow = seriesQ.data && seriesQ.data.wallet === shown && sameWindow(seriesQ.data.since, period) ? seriesQ.data : null;
  const seriesOk = !!seriesNow && seriesNow.ok !== false;
  const chartPoints = useMemo(() => (seriesNow && seriesNow.ok !== false ? seriesPoints(seriesNow.points) : []), [seriesNow]);
  const reloadSeriesNow = seriesQ.reload;
  const reloadSeries = useCallback(() => { if (!seriesFlight.current) reloadSeriesNow(); }, [reloadSeriesNow]);
  // (a landing waiting for the page to be idle is covered by any reload)
  const landing = useRef(false);
  reloadRef.current = () => { landing.current = false; pf.reload(); claims.reload(); reloadPnl(); reloadSeries(); if (also) { pf2.reload(); claims2.reload(); } };
  // While the server reads the wallet's history the P&L is asked again sooner; never while the tab is hidden.
  const reading = historyRunning(pnlNow);
  useEffect(() => {
    if (!shown || !reading) return;
    const t = setInterval(() => { if (!document.hidden) { reloadPnl(); reloadSeries(); } }, PNL_POLL_MS);
    return () => clearInterval(t);
  }, [shown, reading, reloadPnl, reloadSeries]);

  const [trade, setTrade] = useState<{ coin: Coin; side: Side; amount?: string } | null>(null);
  const [blocked, setBlocked] = useState<Blocked>({});
  // A coin that cannot be traded here says why in its row.
  const showBlock = useCallback((block: TradeBlock, coin: Coin) => {
    const t = blockText(block, coin);
    // a gap passes once the index holds the coins above: it is said once and the buttons stay, so the next click checks again
    if (block.kind === "gap") toast.info(`${t.title}. ${t.body}`);
    else setBlocked((b) => ({ ...b, [coin.mint]: { short: t.short, body: t.body, at: Date.now() } }));
  }, [toast]);
  // The instant trade (components/useInstantTrade.ts): the wallet step before any trade (`ready`), one trade at a time
  // on the page (`busy` / `begin` / `end`, shared with the ticket opener below), the toasts, and what follows each answer.
  // A preset trades at once through lib/instant-trade.ts (every check runs before it signs); what does not pass a check
  // opens the ticket with the amount filled in; nothing is sent again by itself after a failure.
  // the reload at once came from the landing notice (below); this one is for the P&L and prices
  const onLanded = useCallback(() => { setTimeout(refresh, TRADE_SETTLE_MS); }, [refresh]);
  const { ready, opening, busy, begin, end, alive, settings, run: onInstant } = useInstantTrade({ onTicket: setTrade, onBlocked: showBlock, onLanded });
  // Buy / Sell through the ticket: it needs the coin's full record.
  const onTrade = useCallback(async (mint: string, side: Side) => {
    if (busy()) return;
    if (!ready()) return;
    begin(mint, side);
    try {
      const { coin } = await api.coin(mint, { children: false, trades: false });
      // a route check that fails (the RPC) opens the ticket anyway: it checks the route itself and offers a retry
      const route = await loadTradeRoute(connection, coin).catch(() => null);
      if (!alive.current) return;
      const block = hardBlock(route);
      if (!block) setTrade({ coin, side });
      else showBlock(block, coin);
    } catch (e) {
      toast.error(`Could not open the trade: ${errorMessage(e)}`);
    } finally {
      end();
    }
  }, [connection, toast, ready, showBlock, busy, begin, end, alive]);
  // a trade sent from the ticket was heard as it landed; it is reloaded once the ticket is closed (the idle effect below)
  const closeTrade = useCallback(() => { setTrade(null); setTimeout(refresh, TRADE_SETTLE_MS); }, [refresh]);

  // Refresh while the tab is visible, and at once when it comes back; never under an open ticket, an open preset popover
  // (the rows must not move under it) or a running claim.
  const [menus, setMenus] = useState(0);
  const onMenu = useCallback((open: boolean) => setMenus((n) => Math.max(0, n + (open ? 1 : -1))), []);
  const idle = !flow.busy && !trade && menus === 0;
  const idleRef = useRef(idle);
  idleRef.current = idle;
  useEffect(() => {
    if (!shown || !idle) return;
    const tick = () => { if (!document.hidden) refresh(); };
    // a landing heard while the page was busy (or hidden) is read as soon as it is idle again
    if (landing.current) tick();
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [shown, idle, refresh]);
  // A transaction of the wallet shown (or of the connected wallet beside it) landed at `slot`: the next reloads ask for
  // that slot; idle and visible, the page reloads at once, else when it is idle again. At most one such reload per
  // LANDING_GAP_MS: one heard sooner waits for the end of it (and asks the newest slot heard by then). Not for an
  // address previewed read-only. The store calls this synchronously, inside the send, so nothing here may throw or wait.
  const landAt = useRef(0);
  useEffect(() => {
    if (!shown || readOnly) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reload = () => {
      if (idleRef.current && !document.hidden) { landAt.current = Date.now(); refresh(); }
      else landing.current = true;
    };
    const off = subscribeLanded((owner, slot) => {
      if (owner !== shown && owner !== also) return;
      afters.current.set(owner, Math.max(afters.current.get(owner) ?? 0, slot));
      if (timer) return; // a reload is already due, and asks for this slot too
      const wait = landAt.current + LANDING_GAP_MS - Date.now();
      if (wait <= 0) reload();
      else timer = setTimeout(() => { timer = null; reload(); }, wait);
    });
    return () => { off(); if (timer) { clearTimeout(timer); landing.current = true; } }; // (a reload still due: on the next idle tick)
  }, [shown, also, readOnly, refresh]);

  // The page's portfolio: the wallet shown, with the pairs the connected wallet launched added to its own.
  const data = useMemo(() => {
    const a = pf.data, b = also ? pf2.data : null;
    if (!a || !b) return a;
    const seen = new Set(a.launched.map((c) => c.mint));
    return { ...a, launched: [...a.launched, ...b.launched.filter((c) => !seen.has(c.mint))], launchedTotal: a.launchedTotal + b.launchedTotal };
  }, [pf.data, pf2.data, also]);
  const claimCoins = useMemo(() => [...(claims.data?.coins ?? []), ...((also ? claims2.data?.coins : null) ?? [])], [claims.data, claims2.data, also]);
  // A stored reason is dropped when the portfolio is read again (and with the wallet shown): the buttons come back and
  // the next click checks the route again.
  useEffect(() => {
    setBlocked((b) => {
      const now = Date.now(), keep = Object.entries(b).filter(([, v]) => now - v.at >= 0 && now - v.at < BLOCK_READ_MS);
      return keep.length === Object.keys(b).length ? b : Object.fromEntries(keep);
    });
  }, [data]);
  const [cards, setCards] = useState(CARDS_STEP);
  useEffect(() => { setCards(CARDS_STEP); }, [shown]);
  const view = useMemo(() => buildPortfolio(data, claimCoins), [data, claimCoins]);
  const toClaim = useMemo(() => claimableRows(view), [view]);
  const { totals, groups } = view;
  // One list at a time: what the wallet bought, or what it launched. The choices stay in this browser.
  const [tab, setTab] = usePick<Tab>("spore:pf-tab", ["holdings", "spores", "activity"], "holdings");
  const [sort, setSort] = usePick<HoldSort>("spore:pf-sort", ["value", "pnl", "volume", "recent"], "value");
  const [side, setSide] = usePick<"open" | "closed">("spore:pf-side", ["open", "closed"], "open");
  // P&L: the answer joined with what the wallet holds. Without the holdings (their read failed) only the realized
  // figures stand: nothing held is known, so there is no unrealized figure and no closed list.
  const known = useMemo(() => {
    const m: [string | null, number | null][] = [[null, stats?.solUsd ?? null]];
    for (const h of data?.holdings ?? []) m.push([h.mint, h.coin.priceUsd]);
    for (const c of data?.launched ?? []) m.push([c.mint, c.priceUsd]);
    return m;
  }, [data, stats?.solUsd]);
  const holdOk = !!data?.holdingsOk;
  const pv = useMemo(() => (data && pnlAvailable(pnlAny) ? buildPnl(pnlAny, data.holdingsOk ? data.holdings : [], { quoteUsd: known, dustUsd: DUST_USD }) : null), [data, pnlAny, known]);
  const prices = useMemo(() => quotePrices(pnlAny, known), [pnlAny, known]);
  const pnlState: PnlState = !pnlAny ? (pnlQ.error ? "failed" : "loading") : !pnlAvailable(pnlAny) ? "off" : !pv ? "loading" : holdOk ? "ok" : "nohold";
  // the realized figures and the closed list are of the period chosen: they wait for that period's answer
  const pvPeriod = pnlNow ? pv : null;
  const periodName = PERIODS.find(([k]) => k === period)?.[3] ?? "all time";
  const histLine = pnlQ.error && !pnlNow ? "P&L could not be read just now." : historyLine(pnlAny, !readOnly);
  const [dust, setDust] = usePick<"hide" | "show">("spore:pf-dust", ["hide", "show"], "hide");
  // Dollars or SOL, for every money figure of the page; SOL needs the SOL price (without it the page stays in USD).
  const [unit, setUnit] = usePick<MoneyUnit>("spore:pf-unit", MONEY_UNITS, "usd");
  const solUsd = stats?.solUsd ?? null;
  const m = useMemo(() => makeMoney(unit, solUsd), [unit, solUsd]);
  // the dust limit in the unit in use: "$1" in dollars, its SOL worth ("0.0067 SOL") in SOL mode
  const dustText = m.unit === "sol" ? m.money(DUST_USD) : `$${DUST_USD}`;
  const small = useMemo(() => view.holdings.filter((r) => r.held?.valueUsd != null && r.held.valueUsd < DUST_USD).length, [view.holdings]);
  const holdings = useMemo(() => {
    const list = dust === "hide" ? view.holdings.filter((r) => !(r.held?.valueUsd != null && r.held.valueUsd < DUST_USD)) : [...view.holdings];
    // buildPortfolio's order is by value; the other two orders fall back to it (the sort is stable)
    if (sort === "volume") list.sort((a, b) => (b.coin.vol24Usd ?? 0) - (a.coin.vol24Usd ?? 0));
    else if (sort === "pnl") {
      // a coin without a figure goes last
      const of = (r: PfRow) => pv?.byMint.get(r.coin.mint)?.unrealizedUsd ?? null;
      list.sort((a, b) => { const x = of(a), y = of(b); return x === null ? (y === null ? 0 : 1) : y === null ? -1 : y - x; });
    }
    else if (sort === "recent") list.sort((a, b) => (b.coin.lastTradeAt ?? 0) - (a.coin.lastTradeAt ?? 0));
    return list;
  }, [view.holdings, dust, sort, pv]);
  const sporeRows = groups.reduce((n, g) => n + g.rows.length + (g.self && g.rows.length === 0 ? 1 : 0), 0);
  const [allHeld, setAllHeld] = useState(false);
  useEffect(() => { setAllHeld(false); }, [shown]);
  // the SOL line: the store's balance (read again at each landed trade), else the API's figure
  const solLamports = solLive ?? (data?.solLamports != null ? BigInt(data.solLamports) : null);
  const solBalance = solLamports !== null ? lamportsToSol(solLamports) : null;
  const canClaim = !readOnly && !!flow.me;
  const actions: Actions = { opening, blocked, onTrade, flow: canClaim ? flow : null, buy: !!tradeAddr, sell: tradesShown, readOnly,
    instant: settings.instant, presets: { buy: settings.buyPresets, sell: settings.sellPresets }, ready, onInstant, onMenu };
  const feesFailed = !!claims.error && !claims.data;
  // before the first answer for this wallet; a background refresh keeps the amount on screen
  const feesPending = !claims.data && !claims.error;

  return (
    <MoneyCtx.Provider value={m}>
      <div className="pf-page">
        <header className="pf-head">
          <h1>Portfolio</h1>
          <p className="pf-sub">{readOnly ? "The coins this wallet holds, and the pairs it launched." : "The coins you hold, and the pairs you launched."}</p>
          {asked && !preview && <p className="pf-note" role="status">"{short(asked, 6)}" is not a wallet address.{shown ? " Showing your own wallet." : ""}</p>}
          {shown && (
            <p className="pf-note pf-trades" role="status">
              {readOnly
                ? <span>Viewing <Addr a={shown} />, read only{mine && <> · <Link to="/portfolio" className="pf-link">Back to my wallet</Link></>}</span>
                : <span>{isTrading ? "Trading wallet" : "Connected wallet"} <Addr a={shown} />{locked && " · locked"}</span>}
              {locked && <button type="button" className="btn sm ghost" onClick={() => openTradingWallet("unlock")}>Unlock</button>}
            </p>
          )}
        </header>

        {!shown ? (
          <section className="card pf-connect" aria-labelledby="pf-connect-h">
            <h2 id="pf-connect-h">See what your wallet holds</h2>
            <p>Connect a wallet, or create a trading wallet in this browser, to see your coins, the coins you launched and the fees they earned.</p>
            <div className="pf-connect-acts">
              <button type="button" className="btn accent" onClick={() => setVisible(true)}>Connect wallet</button>
              <button type="button" className="btn ghost" onClick={() => openTradingWallet()}>Create trading wallet</button>
            </div>
          </section>
        ) : pf.loading && !data ? (
          <div aria-busy="true" aria-label="Loading the portfolio"><SkeletonRows n={4} h={72} /></div>
        ) : pf.error && !data ? (
          <ErrorBox error="The portfolio could not be loaded." retry={pf.reload} details={pf.error} />
        ) : data && (
          <>
            <dl className="pf-sum" aria-label="Summary">
              <div className="pf-tile pf-tile-wide">
                <dt>Total value</dt>
                <dd className="pf-num">{data.holdingsOk ? m.money(totals.valueUsd, { card: true }) : "—"}</dd>
                <dd className="pf-tile-sub">
                  {data.holdingsOk ? `${plural(totals.holdings, "holding")} · ${plural(totals.sporeTotal, "spore")}` : "could not be read"}
                  {totals.unpriced > 0 && ` · ${totals.unpriced} without a price`}
                  {data.untracked > 0 && ` · ${plural(data.untracked, "other token")} not on Spore`}
                </dd>
                <dd className="pf-tile-sub" title="The wallet's SOL balance; it is not part of the total value">
                  {solBalance === null ? "SOL balance could not be read"
                    : m.solUsd === null ? <>+ <span className="pf-num">{sol(solBalance)}</span></>
                    : m.unit === "sol" ? <>+ <span className="pf-num">{sol(solBalance)}</span> · {usdCard(solBalance * m.solUsd)}</>
                    : <>+ <span className="pf-num">{usdCard(solBalance * m.solUsd)}</span> · {sol(solBalance)}</>}
                </dd>
              </div>
              <div className="pf-tile">
                <dt title={PNL_NOTE}>Unrealized P&amp;L</dt>
                {pv && holdOk && pv.totals.unrealizedUsd !== null ? (
                  <>
                    <dd className={`pf-num pf-pl ${pnlTone(pv.totals.unrealizedUsd)}`}>{pv.totals.partial > 0 && <Approx n={pv.totals.unrealizedUsd} />}{m.money(pv.totals.unrealizedUsd, { signed: true })}</dd>
                    <dd className="pf-tile-sub">
                      {pv.totals.unrealizedPct !== null && <><span className="pf-num">{pnlPct(pv.totals.unrealizedPct)}</span> · </>}{plural(pv.totals.counted, "coin")}
                      {pv.totals.noCost + pv.totals.unpriced > 0 && <span title={leftOutTitle(pv.totals.noCost, pv.totals.unpriced)}>, {pv.totals.noCost + pv.totals.unpriced} left out</span>}
                    </dd>
                  </>
                ) : (
                  <>
                    <dd className="pf-num" aria-busy={pnlState === "loading"}>—</dd>
                    <dd className="pf-tile-sub">
                      {pnlState === "loading" ? "reading…" : pnlState === "off" ? "not available right now"
                        : pnlState === "failed" ? <>could not be read · <button type="button" className="linkish" onClick={reloadPnl}>retry</button></>
                        : pnlState === "nohold" ? <>holdings could not be read · <button type="button" className="linkish" onClick={pf.reload}>retry</button></>
                        : pv && pv.totals.noCost + pv.totals.unpriced > 0 ? <span title={leftOutTitle(pv.totals.noCost, pv.totals.unpriced)}>{plural(pv.totals.noCost + pv.totals.unpriced, "coin")} without a known cost</span>
                        : "no bought coins held"}
                    </dd>
                  </>
                )}
              </div>
              <div className="pf-tile">
                <dt title={PNL_NOTE}>Realized P&amp;L</dt>
                {pvPeriod ? (
                  <>
                    <dd className={`pf-num pf-pl ${pnlTone(pvPeriod.totals.realizedUsd)}`}>{pvPeriod.totals.realizedUsd !== null && pvPeriod.totals.realizedPartial > 0 && <Approx n={pvPeriod.totals.realizedUsd} />}{m.money(pvPeriod.totals.realizedUsd, { signed: true })}</dd>
                    <dd className="pf-tile-sub">
                      {periodName} · {pvPeriod.totals.realizedUsd === null
                        ? <span title={SOLD_UNKNOWN}>{plural(pvPeriod.totals.realizedLeftOut, "coin")} sold without a known cost</span>
                        : <>{pvPeriod.totals.realizedCoins > 0 ? `${plural(pvPeriod.totals.realizedCoins, "coin")} sold` : "nothing sold"}
                          {pvPeriod.totals.realizedLeftOut > 0 && <span title={SOLD_UNKNOWN}>, {pvPeriod.totals.realizedLeftOut} left out</span>}</>}
                    </dd>
                  </>
                ) : (
                  <>
                    <dd className="pf-num" aria-busy={pnlState === "loading" || (pv !== null && pnlQ.loading)}>—</dd>
                    <dd className="pf-tile-sub">{pnlState === "off" ? "not available right now" : pnlState === "failed" || (pnlQ.error && !pnlNow) ? "could not be read" : "reading…"}</dd>
                  </>
                )}
              </div>
              <div className="pf-tile pf-tile-wide">
                <dt>Fees to claim</dt>
                <dd className="pf-num" aria-busy={feesPending}>{feesFailed || feesPending ? "—" : m.money(totals.claimUsd, { card: true })}</dd>
                <dd className="pf-tile-sub pf-tile-act">
                  {feesFailed ? <>could not be read · <button type="button" className="linkish" onClick={claims.reload}>retry</button></>
                    : feesPending ? "reading…"
                    : toClaim.length === 0 ? "nothing waiting"
                    : readOnly ? plural(toClaim.length, "coin")
                    : !flow.me ? <button type="button" className="linkish" onClick={() => setVisible(true)}>Connect a wallet to claim</button>
                    : (
                      <button type="button" className="btn sm accent" disabled={flow.bulk ? flow.bulk.stopping : flow.busy} onClick={() => (flow.bulk ? flow.stop() : flow.claimAll(toClaim.map(target), totals.claimUsd))}
                        title={flow.bulk ? "Stops after the coin in flight; coins already paid out stay paid" : flow.locked ? "Your trading wallet signs the payouts: unlock it first" : flow.silent ? "One payout per coin, signed by your trading wallet after you confirm the list with each coin's cost" : "One payout per coin, each approved in the connected wallet"}>
                        {flow.bulk ? (flow.bulk.stopping ? "Stopping…" : `Stop · claiming ${flow.bulk.i + 1} of ${flow.bulk.n}`) : flow.locked ? `Unlock to claim (${toClaim.length})` : `Claim all (${toClaim.length})`}
                      </button>
                    )}
                </dd>
              </div>
            </dl>

            <div className="pf-pnl-bar">
              <p className="pf-hist">{histLine && <><span className="pf-hist-state">{histLine}</span> </>}{PNL_NOTE}</p>
              <span className="pf-bar-picks">
                <span className="pf-period">
                  <span className="pf-k" id="pf-period-l">Realized over</span>
                  <span className="seg pf-sort" role="group" aria-labelledby="pf-period-l">
                    <SlidingPill />
                    {PERIODS.map(([k, label, , name]) => <button key={k} type="button" aria-pressed={period === k} title={`Realized P&L and closed positions: ${name}`} onClick={() => setPeriod(k)}>{label}</button>)}
                  </span>
                </span>
                <span className="seg pf-sort pf-unit" role="group" aria-label="Show money in" title={m.can ? undefined : NO_SOL_PRICE}>
                  <SlidingPill />
                  <button type="button" aria-pressed={m.unit === "usd"} title="Money figures in dollars" onClick={() => setUnit("usd")}>USD</button>
                  <button type="button" aria-pressed={m.unit === "sol"} disabled={!m.can} title={m.can ? `Money figures in SOL, at the current price of SOL (${usd(m.solUsd)})` : NO_SOL_PRICE} onClick={() => setUnit("sol")}>SOL</button>
                </span>
                {actions.buy && <button type="button" className="linkish pf-link pf-settings" title={settings.instant ? "Instant trades are on: Buy and Sell trade at once from your presets" : "Instant trades are off: Buy and Sell open the ticket"} onClick={() => openTradeSettings()}>Trade settings</button>}
              </span>
            </div>

            {pnlState !== "off" && (
              <PnlChart points={chartPoints} periodName={periodName} money={m} note={PNL_NOTE} unpriced={seriesOk ? seriesNow.unpriced : 0}
                state={seriesNow ? (seriesOk ? "ok" : "failed") : seriesQ.error ? "failed" : "loading"} />
            )}

            <div className="pf-tabs">
              <span className="seg" role="group" aria-label="List shown">
                <SlidingPill />
                <button type="button" aria-pressed={tab === "holdings"} onClick={() => setTab("holdings")}>Holdings <span className="pf-tab-n">{view.holdings.length}</span></button>
                <button type="button" aria-pressed={tab === "spores"} onClick={() => setTab("spores")}>{readOnly ? "Spores" : "Your spores"} <span className="pf-tab-n">{sporeRows}</span></button>
                <button type="button" aria-pressed={tab === "activity"} onClick={() => setTab("activity")}>Activity</button>
              </span>
              {tab === "holdings" && (
                <span className="pf-tools">
                  <span className="pf-switch" role="group" aria-label="Positions shown">
                    <button type="button" className="linkish" aria-pressed={side === "open"} title="The coins the wallet holds" onClick={() => setSide("open")}>Open</button>
                    <button type="button" className="linkish" aria-pressed={side === "closed"} title="Coins the wallet traded and no longer holds" onClick={() => setSide("closed")}>Closed</button>
                  </span>
                  {side === "closed" && <span className="pf-count">{periodName}</span>}
                  {side === "open" && view.holdings.length > 1 && small > 0 && (
                    <button type="button" className="linkish pf-link" aria-pressed={dust === "hide"} onClick={() => setDust(dust === "hide" ? "show" : "hide")}
                      title={`Holdings worth less than ${dustText}`}>
                      {dust === "hide" ? `Show ${small} under ${dustText}` : `Hide ${small} under ${dustText}`}
                    </button>
                  )}
                  {side === "open" && view.holdings.length > 1 && (
                    <span className="seg pf-sort" role="group" aria-label="Sort holdings by">
                      <SlidingPill />
                      {SORTS.map(([k, label, title]) => <button key={k} type="button" aria-pressed={sort === k} title={title} onClick={() => setSort(k)}>{label}</button>)}
                    </span>
                  )}
                </span>
              )}
              {tab === "activity" && <span className="pf-count">{readOnly ? "This wallet's trades" : "Your trades"}, newest first</span>}
              {tab === "spores" && groups.length > 0 && <span className="pf-count">{readOnly ? "Pairs this wallet launched" : "Pairs you launched"}, by parent coin</span>}
            </div>

            {tab === "holdings" && (
            <section className="pf-sec" aria-labelledby="pf-held-h">
              <h2 id="pf-held-h" className="sr-only">Holdings</h2>
              {side === "closed" ? (
                !data.holdingsOk ? <p className="pf-warn" role="status">Holdings could not be read just now, so closed positions cannot be told apart. <button type="button" className="linkish" onClick={pf.reload}>Retry</button></p>
                  : pvPeriod ? <ClosedList key={`${shown}:${period}`} rows={pvPeriod.closed} a={actions} periodName={periodName} />
                  : pnlState === "loading" || (pnlState === "ok" && !pnlQ.error) ? <div aria-busy="true" aria-label="Loading the closed positions"><SkeletonRows n={3} h={52} /></div>
                  : <p className="pf-empty">{pnlState === "off" ? "Closed positions are not available right now." : <>Closed positions could not be read just now. <button type="button" className="linkish pf-link" onClick={reloadPnl}>Retry</button></>}</p>
              ) : !data.holdingsOk ? (
                <p className="pf-warn" role="status">Holdings could not be read just now, so only the coins this wallet launched are listed. <button type="button" className="linkish" onClick={pf.reload}>Retry</button></p>
              ) : view.holdings.length === 0 ? (
                <p className="pf-empty">{readOnly ? "This wallet holds no coins it bought." : "Coins you buy show up here."} <Link to="/map" className="pf-link">Find one on the map</Link></p>
              ) : holdings.length === 0 ? (
                <p className="pf-empty">Every holding is worth less than {dustText}. <button type="button" className="linkish pf-link" onClick={() => setDust("show")}>Show {small}</button></p>
              ) : (
                <div className={`card pf-holds ${actions.buy ? "" : "pf-holds-plain"}`}>
                  <div className="pf-hold pf-hold-cols" aria-hidden="true">
                    <span /><span>Coin</span><span>Price</span><span>Amount</span><span>Value</span><span title={PNL_NOTE}>P&amp;L</span>{actions.buy && <span />}
                  </div>
                  <ul className="pf-rows" aria-label="Holdings">
                    {(allHeld ? holdings : holdings.slice(0, HOLDINGS_MAX)).map((r) => <HoldingRow key={r.coin.mint} r={r} a={actions} p={pv?.byMint.get(r.coin.mint)} state={pnlState} periodName={pvPeriod ? periodName : null} />)}
                  </ul>
                  {holdings.length > HOLDINGS_MAX && (
                    <button type="button" className="linkish pf-link pf-all" aria-expanded={allHeld} onClick={() => setAllHeld((v) => !v)}>
                      {allHeld ? "Show fewer" : `Show all ${holdings.length}`}<span className="sr-only"> holdings</span>
                    </button>
                  )}
                </div>
              )}
            </section>
            )}

            {tab === "spores" && (
            <section className="pf-sec" aria-labelledby="pf-spores-h">
              <h2 id="pf-spores-h" className="sr-only">{readOnly ? "Spores" : "Your spores"}</h2>
              {groups.length === 0 ? (
                <p className="pf-empty">
                  {readOnly ? "This wallet has not launched a pair." : "A pair you launch shows up here, with the fees it earns."}
                  {!readOnly && <> <Link to="/launch" className="btn sm accent"><Sprout />Launch a coin</Link></>}
                </p>
              ) : (
                <div className="pf-grid">
                  {groups.slice(0, cards).map((g) => <GroupCard key={g.mint} g={g} a={actions} />)}
                </div>
              )}
              {groups.length > cards && (
                <button type="button" className="btn ghost pf-more" onClick={() => setCards((n) => n + CARDS_STEP)}>
                  Show more <span className="pf-k">{cards} of {groups.length} parents</span>
                </button>
              )}
              {data.launchedTotal > data.launched.length && <p className="pf-note">Showing the newest {data.launched.length} of {data.launchedTotal} launched coins.</p>}
            </section>
            )}

            {tab === "activity" && shown && (
            <section className="pf-sec" aria-labelledby="pf-act-h">
              <h2 id="pf-act-h" className="sr-only">Activity</h2>
              <Activity key={shown} wallet={shown} stamp={`${pnlAny?.trades ?? 0}:${pnlAny ? pnlAny.history?.state ?? "none" : "-"}`} total={pnlAny?.trades ?? 0} prices={prices} readOnly={readOnly} reading={reading} />
            </section>
            )}
          </>
        )}
      </div>
      {flow.dialog}
      {trade && <QuickTrade coin={trade.coin} side={trade.side} amount={trade.amount} solUsd={stats?.solUsd ?? null} onClose={closeTrade} />}
    </MoneyCtx.Provider>
  );
}

/// Buy / Sell for one coin, or the reason it cannot be traded here with the way out. Sell only when the wallet shown
/// holds the coin and is the wallet the ticket trades with; nothing when no wallet of the user's can trade.
/// With instant trades on, a button opens the presets under it (TradePresets) and a preset is the trade; off, it
/// opens the ticket.
function TradeButtons({ mint, label, held, a }: { mint: string; label: string; held: boolean; a: Actions }) {
  const [menu, setMenu] = useState<Side | null>(null);
  const buyRef = useRef<HTMLButtonElement>(null), sellRef = useRef<HTMLButtonElement>(null);
  // a trade under way anywhere on the page, or instant trades turned off, closes the presets
  const off = !!a.opening || !a.instant;
  useEffect(() => { if (off) setMenu(null); }, [off]);
  // the page holds its background refresh while a popover is open
  const open = !!menu && !off && !(menu === "sell" && !(a.sell && held)), onMenu = a.onMenu;
  useEffect(() => { if (!open) return; onMenu(true); return () => onMenu(false); }, [open, onMenu]);
  if (!a.buy) return null;
  const canSell = a.sell && held;
  const why = a.blocked[mint];
  if (why) return <span className="pf-why" title={why.body}>Not tradable here: {why.short} · <a href={pumpUrl(mint)} target="_blank" rel="noreferrer">pump.fun ↗</a></span>;
  const busy = (side: Side) => a.opening?.mint === mint && a.opening.side === side;
  const press = (side: Side) => {
    if (!a.instant) { a.onTrade(mint, side); return; }
    if (menu === side) { setMenu(null); return; }
    // a locked trading wallet is asked to unlock, and nothing else happens
    if (a.ready()) setMenu(side);
  };
  const shown = menu === "sell" && !canSell ? null : off ? null : menu;
  const pop = (side: Side) => (a.instant ? { "aria-haspopup": "dialog" as const, "aria-expanded": shown === side } : {});
  return (
    <span className="pf-trade">
      <button ref={buyRef} type="button" className={`btn sm ghost pf-buy ${busy("buy") ? "is-busy" : ""}`} disabled={!!a.opening} aria-busy={busy("buy")} aria-label={`Buy ${label}`} {...pop("buy")} onClick={() => press("buy")}>Buy</button>
      {canSell && <button ref={sellRef} type="button" className={`btn sm ghost pf-sell ${busy("sell") ? "is-busy" : ""}`} disabled={!!a.opening} aria-busy={busy("sell")} aria-label={`Sell ${label}`} {...pop("sell")} onClick={() => press("sell")}>Sell</button>}
      {shown && (
        <TradePresets side={shown} label={`${shown === "buy" ? "Buy" : "Sell"} ${label}`} anchor={(shown === "buy" ? buyRef : sellRef).current}
          presets={shown === "buy" ? a.presets.buy.map((v) => `${v} SOL`) : a.presets.sell.map((v) => `${v}%`)}
          onPick={(i) => a.onInstant(mint, shown === "buy" ? { side: "buy", sol: a.presets.buy[i] } : { side: "sell", pct: a.presets.sell[i] }, label)}
          onCustom={() => a.onTrade(mint, shown)} onClose={() => setMenu(null)} />
      )}
    </span>
  );
}

/// A coin's fees waiting for the wallet, with Claim when a payout can run and the page may claim.
function Fee({ k, label, a }: { k: PfClaim; label: string; a: Actions }) {
  const flow = a.flow, { money } = useMoney();
  return (
    <span className="pf-fee">
      <span className="pf-k">Fees</span>
      <span className="pf-num" title={k.usd != null ? money(k.usd) : undefined}>{feeText(k)}</span>
      {!k.claimable ? <span className="pf-k" title={k.row.reason ?? undefined}>not claimable</span>
        : flow && <button type="button" className="btn sm soft" disabled={flow.busy} aria-label={flow.locked ? `Unlock your trading wallet to claim the fees of ${label}` : `Claim the fees of ${label}`} title={flow.locked ? "Your trading wallet signs the payout: unlock it first" : undefined} onClick={() => flow.start(target(k.row))}>{flow.labelFor(k.row.mint) ?? (flow.locked ? "Unlock to claim" : "Claim")}</button>}
    </span>
  );
}

/// What the wallet holds of a coin: its value, or the token amount when it has no price; a dash when it holds none.
const heldText = (r: PfRow | null, m: Money) => (!r?.held ? "—" : r.held.valueUsd != null ? m.money(r.held.valueUsd, { card: true }) : amount(r.held.uiAmount));
const heldTitle = (r: PfRow | null) => (r?.held ? `${amount(r.held.uiAmount)} ${sym(r.coin)}` : undefined);
/// Why a coin is among the spores: the wallet launched it, or only shares its fees.
const SporeTag = ({ r }: { r: PfRow }) => (r.launched ? <span className="pf-tag">launched</span> : r.feeShare ? <span className="pf-tag" title="Listed because this wallet receives a share of the coin's creator fees">fee share</span> : null);

/// "0.5 SOL ($100)": an amount of a coin's quote, with its money at today's price when there is one. In SOL an
/// amount of SOL stands alone (the bracket would repeat it). `quoteMint`: null for SOL.
const quoteText = (x: PnlAmount, symbol: string, quoteMint: string | null, m: Money) =>
  `${amount(x.quote, symbol)}${x.usd !== null && !(m.unit === "sol" && quoteMint === null) ? ` (${m.money(x.usd)})` : ""}`;
const leftOutTitle = (noCost: number, unpriced: number) =>
  [noCost > 0 ? `${plural(noCost, "coin")} held without a recorded buy` : "", unpriced > 0 ? `${plural(unpriced, "coin")} without a price` : ""].filter(Boolean).join(", ");

/// A holding's unrealized profit: dollars (signed, coloured) over the percent of its cost; a dash with the reason in
/// its title when there is no figure. The title carries the average cost and what was bought and sold in the period.
function PnlCell({ p, state, periodName }: { p: PnlRow | undefined; state: PnlState; periodName: string | null }) {
  const m = useMoney();
  const why = state !== "ok" ? PNL_WHY[state]
    : !p || p.gap === "no-cost" ? "No buy of this coin is recorded for this wallet, so its cost is not known"
    : p.gap === "no-price" || p.unrealizedUsd === null ? "No price to value the cost with" : null;
  if (why || !p) return <span className="pf-hold-pnl" title={why ?? undefined}><span className="pf-k">P&amp;L</span> <span className="pf-num pf-pl none">—</span></span>;
  const title = [
    `Average cost ${usd(p.avgCostUsd)} per token, ${m.money(p.costUsd)} for what is held.`,
    periodName ? `Bought ${quoteText(p.bought, p.quoteSymbol, p.quoteMint, m)}, sold ${quoteText(p.sold, p.quoteSymbol, p.quoteMint, m)} (${periodName}).` : "",
    p.partial ? `${APPROX_NOTE}.` : "",
  ].filter(Boolean).join(" ");
  return (
    <span className="pf-hold-pnl" title={title}>
      <span className="pf-k">P&amp;L</span>{" "}
      <b className={`pf-num pf-pl ${pnlTone(p.unrealizedUsd)}`}>{p.partial && <Approx n={p.unrealizedUsd} />}{m.money(p.unrealizedUsd, { signed: true })}</b>{" "}
      {p.unrealizedPct !== null && <span className="pf-num pf-pl-pct">{pnlPct(p.unrealizedPct)}</span>}
    </span>
  );
}

/// One coin the wallet bought: logo, symbol over its pair, amount, value, unrealized P&L, Buy / Sell. The cells line
/// up in columns on a wide screen (portfolio.css); on a phone the value sits over the amount on the first line and
/// the P&L and the buttons take the second. Every figure keeps a label for a screen reader.
function HoldingRow({ r, a, p, state, periodName }: { r: PfRow; a: Actions; p: PnlRow | undefined; state: PnlState; periodName: string | null }) {
  const c = r.coin, name = sym(c), h = r.held;
  const { money } = useMoney();
  return (
    <li className="pf-hold">
      <Logo src={c.image} label={c.symbol} size={28} />
      <span className="pf-hold-main">
        <Link to={mapLink(c.mint)} className="pf-sym" title={`${c.name ?? name} on the map`}>{name}</Link>
        {c.parent && <span className="pf-name" title={`Priced in ${sym(c.parent)}`}>in {sym(c.parent)}</span>}
      </span>
      <span className="pf-hold-val">
        <span className="sr-only">Value </span>
        {h?.valueUsd != null ? <b className="pf-num">{money(h.valueUsd, { card: true })}</b> : <span className="pf-k">no price</span>}
      </span>
      <span className="pf-hold-amt"><span className="sr-only">Amount </span><span className="pf-num">{amount(h?.uiAmount)}</span></span>
      <PriceCell r={r} />
      <div className="pf-hold-foot">
        <PnlCell p={p} state={state} periodName={periodName} />
        {a.buy && <span className="pf-hold-act"><TradeButtons mint={c.mint} label={name} held={!!h} a={a} /></span>}
      </div>
    </li>
  );
}

/// The coins the wallet traded in the period and no longer holds (or holds only as dust): what was bought and sold,
/// and what the sells made, in the page's money unit at today's price of the quote and as a percent of the sold
/// tokens' cost.
function ClosedList({ rows, a, periodName }: { rows: PnlRow[]; a: Actions; periodName: string }) {
  const [all, setAll] = useState(false);
  const { money } = useMoney();
  if (rows.length === 0) return <p className="pf-empty">No closed positions in the {periodName === "all time" ? "trades read so far" : periodName}.</p>;
  const side = (x: PnlAmount, symbol: string) => (x.usd !== null ? <span className="pf-num" title={amount(x.quote, symbol)}>{money(x.usd, { card: true })}</span> : <span className="pf-num">{amount(x.quote, symbol)}</span>);
  return (
    <div className={`card pf-holds ${a.buy ? "" : "pf-holds-plain"}`}>
      <div className="pf-shut pf-shut-cols" aria-hidden="true">
        <span /><span>Coin</span><span>Bought</span><span>Sold</span><span title={PNL_NOTE}>Realized P&amp;L</span>{a.buy && <span />}
      </div>
      <ul className="pf-rows" aria-label={`Closed positions, ${periodName}`}>
        {(all ? rows : rows.slice(0, CLOSED_MAX)).map((r) => {
          const name = sym({ symbol: r.coin.symbol, mint: r.mint });
          return (
            <li key={r.mint} className="pf-shut">
              <Logo src={r.coin.image} label={r.coin.symbol} size={28} />
              <span className="pf-hold-main">
                <Link to={mapLink(r.mint)} className="pf-sym" title={`${r.coin.name ?? name} on the map`}>{name}</Link>
                <span className="pf-name" title={r.lastAt !== null ? `Last trade ${when(r.lastAt)}` : undefined}>last trade {ago(r.lastAt)}</span>
              </span>
              <span className="pf-shut-pl" title={r.realizedUsd === null ? (r.sells > 0 ? "Sold without a recorded buy, or without a price to value it with" : "Nothing sold in this period") : r.realizedPartial ? APPROX_NOTE : undefined}>
                <span className="sr-only">Realized P&amp;L </span>
                <b className={`pf-num pf-pl ${pnlTone(r.realizedUsd)}`}>{r.realizedPartial && r.realizedUsd !== null && Math.abs(r.realizedUsd) < 0.005 ? <span title={APPROX_NOTE}>—</span> : <>{r.realizedPartial && <Approx n={r.realizedUsd} />}{money(r.realizedUsd, { signed: true })}</>}</b>
                {r.realizedPct !== null && <span className="pf-num pf-pl-pct">{pnlPct(r.realizedPct)}</span>}
              </span>
              <div className="pf-shut-foot">
                <span className="pf-shut-amt"><span className="pf-k">Bought</span> {side(r.bought, r.quoteSymbol)}</span>
                <span className="pf-shut-amt"><span className="pf-k">Sold</span> {side(r.sold, r.quoteSymbol)}</span>
                {a.buy && <span className="pf-hold-act"><TradeButtons mint={r.mint} label={name} held={r.held} a={a} /></span>}
              </div>
            </li>
          );
        })}
      </ul>
      {rows.length > CLOSED_MAX && (
        <button type="button" className="linkish pf-link pf-all" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}<span className="sr-only"> closed positions</span>
        </button>
      )}
    </div>
  );
}

/// The wallet's trades, newest first, a page at a time. `stamp` changes when the server stored more of them or the
/// state of the history read changed: the first page is then read again. A list the reader has not extended is
/// replaced whole; one extended with "Load more" keeps what it holds and takes the trades it lacks (lib/pnl.ts
/// mergeFirstPage). One first-page request at a time: a change that comes while one is in flight asks once more after
/// it, so a slow answer still lands. `total`: the trades the server stores for the wallet (0: not known).
/// `prices`: today's USD price of a quote, by quote mint.
const tradeKey = (t: WalletTrade) => `${t.sig}:${t.mint}:${t.side}:${t.baseAmount}`;
function Activity({ wallet, stamp, total, prices, readOnly, reading }: { wallet: string; stamp: string; total: number; prices: ReadonlyMap<string, number>; readOnly: boolean; reading: boolean }) {
  const [list, setList] = useState<TradeList<WalletTrade> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const m = useMoney();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const totalRef = useRef(total);
  totalRef.current = total;
  const extended = useRef(false); // "Load more" was used (or is in flight): a refresh merges, it does not replace
  const slack = useRef(0);        // stored trades the list did not hold when it last reached its end
  const flight = useRef(false), again = useRef(false), moreFlight = useRef(false);
  const loadFirst = useCallback(() => {
    if (flight.current) { again.current = true; return; }
    flight.current = true;
    api.activity(wallet, { limit: ACTIVITY_PAGE }).then((a) => {
      if (!alive.current) return;
      setError(null);
      const page = { trades: a.trades, next: a.next, tracked: a.tracked };
      setList((cur) => (!cur || !extended.current ? page : mergeFirstPage(cur, page, tradeKey, totalRef.current - slack.current)));
    }).catch((e) => { if (alive.current) setError(errorMessage(e)); })
      .finally(() => { flight.current = false; if (alive.current && again.current) { again.current = false; loadFirst(); } });
  }, [wallet]);
  useEffect(() => { loadFirst(); }, [loadFirst, stamp]);
  const loadMore = async () => {
    const before = list?.next;
    if (!before || moreFlight.current) return;
    moreFlight.current = true;
    extended.current = true;
    setMore(true);
    try {
      const a = await api.activity(wallet, { limit: ACTIVITY_PAGE, before });
      if (!alive.current) return;
      setError(null);
      setList((cur) => {
        if (!cur) return cur;
        const out = appendPage(cur, a, tradeKey);
        if (out.next === null) slack.current = Math.max(0, totalRef.current - out.trades.length);
        return out;
      });
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      moreFlight.current = false;
      if (alive.current) setMore(false);
    }
  };

  if (!list) {
    return error
      ? <p className="pf-empty">The trades could not be loaded just now. <button type="button" className="linkish pf-link" onClick={() => { setError(null); loadFirst(); }}>Retry</button></p>
      : <div aria-busy="true" aria-label="Loading the trades"><SkeletonRows n={5} h={44} /></div>;
  }
  if (list.trades.length === 0) {
    return (
      <p className="pf-empty">
        {reading ? `Reading ${readOnly ? "this wallet's" : "your"} trade history. Trades show up here as they are found.`
          : !list.tracked ? "The trade history of this wallet is not available right now."
          : readOnly ? "No trades of this wallet were found." : "Trades you make show up here."}
      </p>
    );
  }
  return (
    <div className="card pf-holds">
      <div className="pf-act pf-act-cols" aria-hidden="true">
        <span>Time</span><span>Side</span><span>Coin</span><span>Amount</span><span>Paid / received</span><span />
      </div>
      <ul className="pf-rows" aria-label="Trades">
        {list.trades.map((t, i) => {
          const name = sym({ symbol: t.coin?.symbol ?? null, mint: t.mint });
          const buy = t.side === "buy";
          const quote = t.quoteDecimals === null ? null : tokens(t.quoteAmount, t.quoteDecimals);
          const price = prices.get(t.quoteMint ?? "SOL");
          const dollars = quote !== null && price !== undefined ? quote * price : null;
          // what was paid in SOL is the SOL figure already: its second figure stays in dollars in either unit
          const solQuote = !t.quoteMint;
          return (
            <li key={`${tradeKey(t)}:${i}`} className="pf-act">
              <span className="pf-act-time" title={when(t.time)}>{ago(t.time)}</span>
              <span className={`pf-act-side ${buy ? "up" : "down"}`}>{buy ? "Buy" : "Sell"}</span>
              <span className="pf-act-coin">
                <Logo src={t.coin?.image} label={t.coin?.symbol} size={22} />
                <Link to={mapLink(t.mint)} className="pf-sym" title={`${t.coin?.name ?? name} on the map`}>{name}</Link>
              </span>
              <span className="pf-act-amt"><span className="sr-only">Amount </span><span className="pf-num">{amount(tokens(t.baseAmount, t.baseDecimals))}</span></span>
              <span className="pf-act-quote" title={dollars !== null ? (solQuote || m.unit === "usd" ? "In dollars at today's price" : "In SOL at today's prices") : undefined}>
                <span className="sr-only">{buy ? "Paid " : "Received "}</span>
                <span className="pf-num">{quote === null ? "—" : amount(quote, t.quoteSymbol ?? (t.quoteMint ? "" : "SOL"))}</span>
                {dollars !== null && <span className="pf-num pf-act-usd">{solQuote ? usdCard(dollars) : m.money(dollars, { card: true })}</span>}
              </span>
              <a className="pf-link pf-act-tx" href={solscanTx(t.sig)} target="_blank" rel="noreferrer" aria-label={`Transaction of this ${buy ? "buy" : "sell"} of ${name} on Solscan`} title="Transaction on Solscan">tx ↗</a>
            </li>
          );
        })}
      </ul>
      {error && <p className="pf-note" role="status">More trades could not be loaded just now.</p>}
      {list.next && (
        <button type="button" className="linkish pf-link pf-all" disabled={more} aria-busy={more} onClick={loadMore}>{more ? "Loading…" : "Load more"}</button>
      )}
    </div>
  );
}

/// 5-minute candles of a coin, shared by every row that asks and read again after a minute. null: none to show.
const CANDLES_MS = 60_000;
const candleCache = new Map<string, { at: number; p: Promise<Candles | null> }>();
function useCandles(mint: string, on = true): Candles | null | undefined {
  const [got, setGot] = useState<{ mint: string; c: Candles | null } | null>(null);
  const epoch = Math.floor(Date.now() / CANDLES_MS);
  useEffect(() => {
    if (!on) return;
    let live = true;
    let e = candleCache.get(mint);
    if (!e || Date.now() - e.at >= CANDLES_MS) { e = { at: Date.now(), p: api.candles(mint, 300, "all").catch(() => null) }; candleCache.set(mint, e); }
    e.p.then((c) => { if (live) setGot({ mint, c }); });
    return () => { live = false; };
  }, [mint, epoch, on]);
  return got && got.mint === mint ? got.c : undefined;
}

/// The closes of the candle window as one quiet line: lime when it ends above its open, red when below.
const LINE_W = 96, LINE_H = 26;
function MiniLine({ candles }: { candles: Candle[] }) {
  const d = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const k of candles) { if (k.c < lo) lo = k.c; if (k.c > hi) hi = k.c; }
    const span = hi - lo || Math.abs(hi) || 1, t0 = candles[0].t, dt = candles[candles.length - 1].t - t0 || 1;
    return candles.map((k, i) => `${i ? "L" : "M"}${(2 + ((k.t - t0) / dt) * (LINE_W - 4)).toFixed(1)} ${(3 + (1 - (k.c - lo) / span) * (LINE_H - 6)).toFixed(1)}`).join("");
  }, [candles]);
  const up = candles[candles.length - 1].c >= candles[0].o;
  return <svg className={`pf-line ${up ? "up" : "down"}`} width={LINE_W} height={LINE_H} viewBox={`0 0 ${LINE_W} ${LINE_H}`} aria-hidden="true"><path d={d} fill="none" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

/// A coin's market at a glance: price, the line of the candles the index has, the change over them, and how lately
/// and how often it trades. The candles are read once the row is near the screen, so a long page asks for few.
function PriceCell({ r }: { r: PfRow }) {
  const c = r.coin;
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = box.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const candles = useCandles(c.mint, seen);
  const list = candles?.candles ?? [];
  const change = candleChange(list);
  const n24 = c.trades24h ?? 0;
  return (
    <div className="pf-hold-px" ref={box}>
      <span className="pf-px-main">
        <span className="sr-only">Price </span><b className="pf-num">{usd(c.priceUsd)}</b>
        <span className="pf-px-meta" title={c.lastTradeAt ? `Last trade ${ago(c.lastTradeAt)}${n24 > 0 ? `, ${count(n24)} trades in 24 h` : ""}` : undefined}>{c.lastTradeAt ? <>{ago(c.lastTradeAt)}{n24 > 0 && <> · {n24 >= 10_000 ? amount(n24) : count(n24)} tx 24h</>}</> : "no trade in 24 h"}</span>
      </span>
      <span className="pf-px-line">{list.length >= 2 && <MiniLine candles={list} />}</span>
      {change
        ? <span className={`pf-chg ${change.ratio >= 0 ? "up" : "down"}`} title={`Change over the last ${spanLabel(change.spanS)}`}>{signedPct(change.ratio)} · {spanLabel(change.spanS)}</span>
        : <span className="pf-chg none" title={candles === undefined ? "Reading the chart" : "No chart for this coin yet"}>—</span>}
    </div>
  );
}

/// One parent coin and the pairs the wallet launched under it. The header is the parent; it carries a tag, fees and
/// Buy / Sell of its own only when the parent is itself one of the wallet's spores (`g.self`).
function GroupCard({ g, a }: { g: PfGroup; a: Actions }) {
  const id = useId();
  const [all, setAll] = useState(false);
  const p = g.parent, self = g.self;
  const m = useMoney();
  const label = sym(p);
  // a parent the index does not track (a listed asset such as USDC) has no ticket and takes no child here
  const tracked = g.tracked;
  const rows = all ? g.rows : g.rows.slice(0, ROWS_MAX);
  return (
    <article className="card pf-card" aria-labelledby={id}>
      <header className="pf-card-head">
        <Logo src={p.image} label={p.symbol} size={40} />
        <div className="pf-card-title">
          <h3 id={id}><Link to={mapLink(p.mint)} className="pf-sym" title={`${label} on the map`}>{label}</Link>{self && <SporeTag r={self} />}</h3>
          <span className="pf-name" title={p.mint}>{p.name ?? (tracked ? short(p.mint, 4) : "not on Spore")}</span>
        </div>
        {g.rows.length > 0 && <span className="pf-count">{plural(g.rows.length, "pair")}</span>}
      </header>
      {self && (self.held || self.claim || a.buy) && (
        <div className="pf-card-own">
          {self.held && <span className="pf-meta"><span className="pf-k">{a.readOnly ? "Holds" : "You hold"}</span> <span className="pf-num" title={heldTitle(self)}>{heldText(self, m)}</span></span>}
          {self.claim && <Fee k={self.claim} label={label} a={a} />}
          {tracked && <TradeButtons mint={p.mint} label={label} held={!!self.held} a={a} />}
        </div>
      )}
      {g.rows.length > 0 && (
        <ul className="pf-rows" aria-label={`${a.readOnly ? "Pairs" : "Your pairs"} under ${label}`}>
          {rows.map((r) => {
            const c = r.coin, name = sym(c);
            return (
              <li key={c.mint} className="pf-row">
                <Logo src={c.image} label={c.symbol} size={28} />
                <span className="pf-row-main">
                  <Link to={mapLink(c.mint)} className="pf-sym" title={`${c.name ?? name} on the map`}>{name}</Link>
                  {r.feeShare && <SporeTag r={r} />}
                </span>
                <TradeButtons mint={c.mint} label={name} held={!!r.held} a={a} />
                <PriceCell r={r} />
                <div className="pf-row-foot">
                  <span className="pf-meta"><span className="pf-k">Mcap</span> <span className="pf-num">{m.money(c.mcapUsd)}</span></span>
                  <span className="pf-meta"><span className="pf-k">24 h vol</span> <span className="pf-num">{m.money(c.vol24Usd)}</span></span>
                  <span className="pf-meta"><span className="pf-k">{a.readOnly ? "Holds" : "You hold"}</span> <span className="pf-num" title={heldTitle(r)}>{heldText(r, m)}</span></span>
                  {r.claim && <Fee k={r.claim} label={name} a={a} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {g.rows.length > ROWS_MAX && (
        <button type="button" className="linkish pf-link pf-all" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${g.rows.length}`}<span className="sr-only"> pairs under {label}</span>
        </button>
      )}
      <div className="pf-links">
        <Link to={mapLink(p.mint)} className="pf-link">View on map</Link>
        {tracked && <Link to={`/launch?parent=${encodeURIComponent(p.mint)}`} className="pf-link">Launch a child</Link>}
      </div>
    </article>
  );
}
