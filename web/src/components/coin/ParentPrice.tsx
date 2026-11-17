// The coin bar's "Priced in $PARENT" card: what the coin's pool is paired with, at a glance. A child's liquidity is
// its parent token, so the parent's price moves the child's dollar price and value as much as the child's own trades
// do: the card shows the parent's logo and ticker, its USD price, its 24 h change, a small 24 h line and its market
// cap, and links to the parent's page. The price is the newer of two readings: the parent's own record (refreshed at
// most once a minute while the page is visible, with its hourly candles) and the child's last trade that carried
// both its USD and its parent-unit price. A parent without candles shows price and change (or just price) and no
// line; a parent the index does not track shows its ticker and price and opens on solscan (it has no page here).
// Nothing for a coin priced in SOL (or in a dollar stablecoin, whose price says nothing).
// ParentBarLine is the same reading as one short line in the phone Buy / Sell bar. Both share one feed per parent
// (useParentData), so the parent is asked for once a minute however many of them are on screen.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, solscanAccount, type Candles, type Coin as CoinT } from "../../lib/api";
import { short, usd } from "../../lib/format";
import { parentOf, type ParentRef } from "../../lib/priced-in";
import { coinCached, coinCachedAt } from "../../lib/trade-route";
import { Logo, sym } from "../Bits";
import { Delta } from "../Stat";
import Term from "../Term";
import { change24h, changeWords, daySpark } from "./change";
import { useLive, type LiveCoin } from "./useLiveCoin";
import { Sparkline, sparkTone } from "./viz";

const REFRESH_MS = 60_000;

/// `coin`: the parent's record (null while loading, after a failed first fetch, or when the index does not track it:
/// `tracked` false, and then nothing is asked again), asked for at `at` (ms); `candles`: its hourly series (null
/// without one).
type ParentData = { mint: string; coin: CoinT | null; at: number; tracked: boolean; candles: Candles | null };
type Feed = { data: ParentData | null; subs: Set<() => void>; stop: () => void; kick: () => void; linger: ReturnType<typeof setTimeout> | null };
/// One loader per parent mint while anything shows it. It lingers a minute after the last one goes (asking nothing
/// meanwhile), so a reselection on the map or a remount (the phone sheet's peek and full views) reads it at once.
const feeds = new Map<string, Feed>();
const LINGER_MS = 60_000;

function startFeed(mint: string): Feed {
  const f: Feed = { data: null, subs: new Set(), stop: () => {}, kick: () => {}, linger: null };
  let alive = true, last = 0, busy = false, untracked = false;
  const load = async () => {
    if (busy || untracked || document.visibilityState === "hidden") return;
    busy = true;
    last = Date.now();
    const asked = last;
    // undefined: no answer this time (keep what was there); null: the index does not know the mint (and then has no
    // candles of it either: not asked). The record comes through the trade route's one-minute cache, which the
    // route above the trade widget reads too.
    const c = await coinCached(mint).catch((e) => (e instanceof ApiError && e.status === 404 ? null : undefined));
    // scope=all: the chart of any tracked coin (the map shows every pump.fun pair; without it ours mode answers only
    // for our coins and their ancestors); the plain route if the server has no such scope
    const k = c === null ? undefined : await api.candles(mint, 3600, "all").catch((e) => (e instanceof ApiError && e.status === 404 ? api.candles(mint, 3600) : Promise.reject(e))).catch(() => undefined);
    busy = false;
    if (!alive) return;
    if (c === null) untracked = true;
    // a record that came from the cache is as old as the request that filled it
    const at = Math.min(asked, coinCachedAt(mint) ?? asked);
    const p = f.data;
    const keep = c === undefined;
    f.data = { mint, coin: keep ? p?.coin ?? null : c, at: keep ? p?.at ?? 0 : at, tracked: c !== null, candles: k === undefined ? p?.candles ?? null : k.candles.length ? k : null };
    for (const cb of [...f.subs]) cb();
  };
  void load();
  const timer = setInterval(() => { if (f.subs.size && Date.now() - last >= REFRESH_MS - 1_000) void load(); }, REFRESH_MS);
  const onVis = () => { if (f.subs.size && document.visibilityState === "visible" && Date.now() - last >= REFRESH_MS) void load(); };
  // a reader back on a lingering feed: a fresh reading if the last is a minute old
  f.kick = () => { if (Date.now() - last >= REFRESH_MS) void load(); };
  document.addEventListener("visibilitychange", onVis);
  f.stop = () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  return f;
}

function useParentData(mint: string): ParentData | null {
  const subscribe = useCallback((cb: () => void) => {
    let f = feeds.get(mint);
    if (!f) { f = startFeed(mint); feeds.set(mint, f); }
    else if (f.linger) { clearTimeout(f.linger); f.linger = null; f.kick(); }
    const feed = f;
    feed.subs.add(cb);
    return () => {
      feed.subs.delete(cb);
      if (feed.subs.size || feed.linger) return;
      feed.linger = setTimeout(() => {
        feed.linger = null;
        if (feed.subs.size) return;
        feed.stop();
        if (feeds.get(mint) === feed) feeds.delete(mint);
      }, LINGER_MS);
    };
  }, [mint]);
  const read = useCallback(() => feeds.get(mint)?.data ?? null, [mint]);
  return useSyncExternalStore(subscribe, read, read);
}

/// The small line is the first thing the card gives up: it shows unless it would cut the parent's ticker (the card is
/// only as wide as its row; the ticker is the one part of it that gives way, so it is what would be cut). Dropped at a
/// bar width, it is tried again only once the bar is wider than that, so it never flickers in and out.
function useSparkRoom(rootRef: RefObject<HTMLDivElement | null>, has: boolean): boolean {
  const [offAt, setOffAt] = useState<number | null>(null);
  const offRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const bar = root?.closest<HTMLElement>(".coin-bar");
    const k = root?.querySelector<HTMLElement>(".pc-k");
    if (!has || !root || !bar || !k) return;
    const check = () => {
      const w = bar.clientWidth;
      if (offRef.current != null) {
        if (w > offRef.current) { offRef.current = null; setOffAt(null); }
        return;
      }
      const s = root.querySelector(".pc-spark");
      if (!s || getComputedStyle(s).display === "none") return;
      if (k.scrollWidth > k.clientWidth) { offRef.current = w; setOffAt(w); }
    };
    check();
    // the bar's width, and the ticker's own (a longer price or change narrows it at the same bar width)
    const ro = new ResizeObserver(check);
    ro.observe(bar);
    ro.observe(k);
    return () => ro.disconnect();
  }, [rootRef, has, offAt]);
  return has && offAt == null;
}

/// A plain number for accessible names ("0.00154", not the subscript form).
export const plainUsd = (n: number) => `$${n.toLocaleString("en-US", n >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 })}`;

/// The card, as its own tight row of the coin bar (grid area "parent"). null for a coin priced in SOL.
export default function ParentPrice({ store }: { store: LiveCoin }) {
  const coin = useLive(store, (s) => s.coin);
  const ref = useMemo(() => parentOf(coin), [coin.parent?.mint, coin.quoteMint]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref ? <ParentCard key={ref.mint} store={store} parent={ref} /> : null;
}

/// The parent's USD price as the server valued a child (its USD price over its price in parent units), or null.
export const parentUsdOf = (c: { priceUsd: number | null; priceQuote: number | null }) =>
  c.priceUsd != null && c.priceQuote != null && c.priceQuote > 0 && c.priceUsd > 0 ? c.priceUsd / c.priceQuote : null;

export type ParentReading = ReturnType<typeof useParentReading>;
/// The parent's reading at the price shown: the newer of `live` (a child trade applied after the parent's record was
/// asked for) and that record; until either lands, `loaded` (the value from the child's record). The map's side panel
/// has no live trades and passes null.
export function useParentReading(ref: ParentRef, loaded: number | null, live: { usd: number; at: number } | null) {
  const data = useParentData(ref.mint);
  const pc = data?.coin ?? null;
  const fromPc = pc?.priceUsd != null && pc.priceUsd > 0 ? pc.priceUsd : null;
  const priceUsd = live && (fromPc == null || live.at > (data?.at ?? 0)) ? live.usd : fromPc ?? loaded;
  const now = { priceUsd, priceQuote: pc?.priceQuote ?? null };
  const candles = data?.candles ?? null;
  const delta = candles ? change24h(candles.candles, now, candles.priceKey) : null;
  // its market cap at the price shown (the record's own figure when that is the record's price)
  const mcap = pc?.mcapUsd != null ? (priceUsd != null && fromPc != null && priceUsd !== fromPc ? (pc.mcapUsd * priceUsd) / fromPc : pc.mcapUsd) : null;
  return {
    pc, now, candles, delta, mcap, priceUsd,
    label: pc?.symbol ?? ref.symbol ? sym({ symbol: pc?.symbol ?? ref.symbol, mint: ref.mint }) : short(ref.mint, 4),
    image: pc?.image ?? ref.image,
    // a parent the index does not track has no page here; `tracked` is null until the first answer
    untracked: data?.tracked === false,
    tracked: data ? data.tracked : null,
  };
}

/// The coin page's reading: live from the coin's trades. `loaded` is from the store's first record only: a later
/// trade without a USD price moves the parent-unit price and not the USD one.
function useParentQuote(store: LiveCoin, ref: ParentRef) {
  const live = useLive(store, (s) => s.quoteUsd);
  const loaded = useMemo(() => parentUsdOf(store.get().coin), [store]);
  return useParentReading(ref, loaded, live);
}

function ParentCard({ store, parent: ref }: { store: LiveCoin; parent: ParentRef }) {
  const { pc, now, candles, delta, mcap, priceUsd, label, image, untracked } = useParentQuote(store, ref);
  const rootRef = useRef<HTMLDivElement>(null);
  const spark = daySpark(candles, now);
  const sparkOn = useSparkRoom(rootRef, !!spark);
  const tone = sparkTone(delta?.ratio ?? (spark ? spark[spark.length - 1] / spark[0] - 1 : null));
  const aria = [
    `Priced in ${label}`,
    priceUsd != null ? `${label} price ${plainUsd(priceUsd)}` : `${label} price unknown`,
    changeWords(delta),
    mcap != null ? `market cap ${plainUsd(mcap)}` : "",
  ].filter(Boolean).join(", ") + `. Open ${label}`;
  // a parent the index does not track: the pill opens it on solscan
  const body = (
    <>
      <Logo src={image} label={pc?.symbol ?? ref.symbol} size={22} className="pc-logo" />
      <span className="pc-id">
        <span className="pc-k"><span className="pc-in">Priced in </span><b>{label}</b></span>
        <span className="pc-v"><b className="mono pc-price">{priceUsd != null ? usd(priceUsd) : "—"}</b>{delta && <Delta ratio={delta.ratio} label={`· ${delta.short}`} title={delta.title} />}</span>
      </span>
      {spark && sparkOn && <span className="pc-spark"><Sparkline points={spark} tone={tone} w={92} h={26} /></span>}
      {mcap != null && <span className="pc-mc"><span className="pc-mck">MC</span><b className="mono">{usd(mcap)}</b></span>}
    </>
  );
  return (
    <div ref={rootRef} className="cb-parent">
      <span className="pc-label"><Term k="quote">Priced in</Term></span>
      {untracked
        ? <a href={solscanAccount(ref.mint)} target="_blank" rel="noreferrer" className="pc" aria-label={aria.replace(/\. Open (.*)$/, ". Open $1 on solscan")} title={`${label}: the token this coin's pool is paired with (not indexed by Spore). Open it on solscan`}>{body}<span className="pc-go" aria-hidden="true">↗</span></a>
        : <Link to={`/c/${ref.mint}`} className="pc" aria-label={aria} title={`${label}: the token this coin's pool is paired with. Open its page`}>{body}<span className="pc-go" aria-hidden="true">→</span></Link>}
    </div>
  );
}

/// The phone Buy / Sell bar's line under the coin's price: the parent's logo, ticker, price and change, so its moves
/// are in view while trading. Plain text, not a link (the card in the coin bar opens the parent; a tap here, next to
/// Buy and Sell, should not leave the page). null for a coin priced in SOL.
export function ParentBarLine({ store }: { store: LiveCoin }) {
  const coin = useLive(store, (s) => s.coin);
  const ref = useMemo(() => parentOf(coin), [coin.parent?.mint, coin.quoteMint]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref ? <BarLine key={ref.mint} store={store} parent={ref} /> : null;
}

function BarLine({ store, parent: ref }: { store: LiveCoin; parent: ParentRef }) {
  const { delta, priceUsd, label, image, pc } = useParentQuote(store, ref);
  const said = [`Priced in ${label}`, priceUsd != null ? `${label} price ${plainUsd(priceUsd)}` : `${label} price unknown`, changeWords(delta)].filter(Boolean).join(", ");
  return (
    <span className="bar-parent">
      <span className="sr-only">{said}</span>
      <span className="bar-parent-v" aria-hidden="true" title={`${label}: the token this coin's pool is paired with`}>
        <Logo src={image} label={pc?.symbol ?? ref.symbol} size={14} className="bar-parent-logo" />
        <span className="bar-parent-k">{label}</span>
        <b className="mono">{priceUsd != null ? usd(priceUsd) : "\u2014"}</b>
        {delta && <Delta ratio={delta.ratio} label={delta.short === "24h" ? "" : delta.short} title={delta.title} />}
      </span>
    </span>
  );
}
