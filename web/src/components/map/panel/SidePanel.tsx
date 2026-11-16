// The selected coin beside the map (desktop) or in the bottom sheet (phone). Numbers that describe the
// tree (mcap, locked by children, children, descendants) come from the map node: that is the all-scope
// truth, while /api/coin is scoped to Spore launches in production and reports 0 there. Trading numbers
// (price, 24 h volume, curve, socials, ours) come from a light /api/coin call (no children, no trades),
// debounced so an arrow-key walk does not fire a request per step; the sparkline reads
// /api/candles?scope=all and shows "—" when the server has none (or predates the route). The family block
// shows the dominance of the coin's family (its top's share of the whole map, lib/map/dominance.ts) and its true size
// (drawn members + the asset family's undrawn coins). Under the actions there is ONE list at a time, picked by tabs: the
// coin's children (most traded first while the heat sidecar is in), its family's most active coins, its same-name
// copies. A listed asset's kids list is one sorted sequence over every coin
// the family store has paged in (lib/map/family.ts, DESIGN-FAMILY-ALL §6), the drawn kids among them (a drawn one shows
// its live node); until the family is in, it is the drawn kids with a note saying how many of the family it sorts.
// Only the rows shown become nodes.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Link } from "react-router-dom";
import { api, pumpUrl, xShareUrl, type Candles, type Coin } from "../../../lib/api";
import { blockText, hardBlock, type TradeRoute } from "../../../lib/trade-route";
import type { Side } from "../../../lib/pump";
import type { InstantSpec } from "../../../lib/instant-trade";
import { copyText, useAsync, useDebounced } from "../../../lib/hooks";
import { age, ago, count, pct, short, signedPct, usd } from "../../../lib/format";
import type { HeatIndex, HeatRow } from "../../../lib/map/heat";
import { mapLink, shareText } from "../../../lib/map/share";
import { shareOf, sharePct, type DomRow } from "../../../lib/map/dominance";
import type { BubbleNode, SizeMode } from "../../../lib/map/types";
import type { BubbleMapHandle } from "../../BubbleMap";
import { DepthBadge, Logo, ProgressBar, Skeleton, listedQuoteOf, nameOf, sym, Firstborn } from "../../Bits";
import { EMPTY_FIRSTBORNS } from "../../../lib/map/firstborn";
import { familyOrder, mintAtPos, useFamilyInfo } from "../../../lib/map/family";
import type { FamilyChunk, FamilyStore } from "../../../lib/map/family-types";
import LaunchButton, { launchBlock } from "../../LaunchButton";
import { useToast } from "../../Toast";
import SlidingPill from "../../ui/SlidingPill";
import TradePresets from "../../TradePresets";
import Sparkline, { candleChange, spanLabel } from "./Sparkline";
import Brood from "./Brood";
import type { Leader } from "../../../lib/map/volume";

const PAGE = 40;
/// The price line's height: tall enough to read, short enough that the children list starts above the fold at 900 px.
const SPARK_H = 42;
export type KidSort = "mcap" | "new";
/// The children list's orders: the family store's two (KidSort), and by 24 h volume over the coins on the map.
type ListSort = KidSort | "vol";
/// The list under the actions.
type PanelTab = "kids" | "active" | "copies";
/// The reader's last tab, kept across coins and panel mounts.
let lastTab: PanelTab = "kids";
/// The market-cap order (the list's "mcap" sort; the page's ↓ / ← / → walk it when there is no heat): market cap, then locked value.
export const kidCmp = (a: BubbleNode, b: BubbleNode) => (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0) || (b.lockedUsd ?? 0) - (a.lockedUsd ?? 0) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
const SORTS: Record<KidSort, (a: BubbleNode, b: BubbleNode) => number> = {
  mcap: kidCmp,
  new: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || kidCmp(a, b),
};
/// The depth colours the map draws (map/store COLORS), for the lineage nodes in the crumbs.
const DEPTH_TONE = ["var(--accent)", "var(--teal)", "var(--violet)", "var(--warn)"];
const TINT_RGB = ["var(--accent-rgb)", "var(--teal-rgb)", "var(--violet-rgb)", "255,207,92"];
const toneOf = (d: number) => DEPTH_TONE[Math.min(Math.max(0, d), DEPTH_TONE.length - 1)];

/// The content width of an element (ResizeObserver), for the full-width price line.
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [w, setW] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect(); ro.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const r = new ResizeObserver(() => setW(Math.floor(el.clientWidth)));
    r.observe(el); ro.current = r;
    setW(Math.floor(el.clientWidth));
  }, []);
  return [ref, w];
}

const httpUrl = (u: string | null | undefined): string | null => { if (!u) return null; try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; } };

/// /api/coin for the selected mint, light (children=0, trades=0) and debounced 150 ms. The result is only
/// returned while it belongs to `mint`, so a fast walk never shows the previous coin's numbers.
export function usePanelCoin(mint: string | null): { coin: Coin | null; error: string | null } {
  const dm = useDebounced(mint, 150);
  const a = useAsync(() => (dm ? api.coin(dm, { children: false, trades: false }) : Promise.resolve(null)), [dm]);
  const coin = a.data && mint && a.data.coin.mint === mint ? a.data.coin : null;
  return { coin, error: dm === mint && !coin ? a.error : null };
}

/// 5-minute candles of any tracked coin; an error (404 on an older server in ours mode) reads as "none".
function useCandles(mint: string): Candles | null | undefined {
  const dm = useDebounced(mint, 150);
  const a = useAsync<Candles>(() => api.candles(dm, 300, "all").catch(() => ({ candles: [], priceKey: "usd" as const })), [dm]);
  return dm !== mint || a.loading ? undefined : a.data;
}

const Icon = {
  x: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.9L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" /></svg>,
  tg: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.9 4.3 18.8 19c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.6 12.8 1.9 11.3c-1-.3-1-1 .2-1.5L20.5 2.7c.9-.3 1.6.2 1.4 1.6Z" /></svg>,
  web: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></svg>,
  copy: <svg className="ic-copy" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2" /><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" /></svg>,
  check: <svg className="ic-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" pathLength="1" /></svg>,
};

/// `ghost`: the family's coins the map does not draw (a listed asset's undrawn coins, lib/map/family ghostOf); 0 for SOL tops.
type Family = { top: BubbleNode; locked: DomRow | null; mcap: DomRow | null; families: number; ghost?: number };
const NO_ROWS: { chunks: readonly FamilyChunk[]; extra: readonly BubbleNode[]; pos: Uint32Array } = { chunks: [], extra: [], pos: new Uint32Array(0) };
/// The list's loading counter is visual only; a screen reader hears the start and, once the pages stop for this long, the end.
const SAY_DONE_MS = 700;
type Props = {
  node: BubbleNode; byMint: Map<string, BubbleNode>;
  /// Direct children on the map, in kidCmp order.
  kids: BubbleNode[];
  /// The most traded coins of the selection's whole family by 24 h volume (lib/map/volume.ts familyLeaders); absent or
  /// empty = no list.
  leaders?: Leader[];
  /// The selection's stack: its same-ticker siblings, itself included, the most traded first (lib/map/copies.ts copyGroup);
  /// fewer than two = no section.
  copyList?: BubbleNode[];
  /// The stack's first coin has 24 h volume (else the order is by market cap: "largest", not "most traded").
  copyTraded?: boolean;
  coin: Coin | null; coinError: string | null;
  heat: HeatRow | null; heatOn: boolean;
  /// The whole heat sidecar: the children list sorts by 24 h volume with it (absent = market cap, as before).
  heatIndex?: HeatIndex | null;
  /// The coin's place in its family by 24 h volume (lib/map/volume.ts), while the map is coloured by volume.
  volRank?: { rank: number; of: number } | null;
  maxDepth: number | undefined;
  map: RefObject<BubbleMapHandle | null>;
  onPick: (mint: string) => void; onClose: () => void;
  /// Mints that are the first child of their parent (lib/map/firstborn, from the full node list): the head
  /// and the kids list carry the "1st" chip for them.
  firstborn?: ReadonlySet<string>;
  /// Phone peek: the coin, its market cap and change, and the two actions only.
  peek?: boolean;
  /// The coin's family (its top) and the family's dominance rows in both modes; `families` = how many
  /// there are; `mode` = the map's size mode (the share the bar draws).
  family?: Family | null;
  mode?: SizeMode;
  /// The family loader: a listed asset's undrawn coins continue its kids list. Absent = drawn kids only.
  families?: FamilyStore | null;
  /// The coin's own last-trade bucket is off in the Key's filter (lib/map/visibility.ts): the map draws it only because it
  /// is selected. The panel says so, with the way back to every coin (`onShowAll`: ?last=all).
  lastHidden?: boolean; onShowAll?: () => void;
  /// Opens the quick trade over the map (Map.tsx) for this coin; absent = no Buy / Sell row. `trade` is the selected
  /// coin's route as the page checked it (useTradeRoute). `solUsd` is unused here (the dialog reads it) but keeps the
  /// props one object the page builds once.
  onTrade?: (side: Side, coin: Coin) => void; solUsd?: number | null;
  trade?: { data: TradeRoute | null; error: string | null; reload: () => void } | null;
  /// Instant trades (Trade settings; the page runs them through components/useInstantTrade.ts). Absent or `on` false:
  /// Buy / Sell open the ticket (`onTrade`) as before.
  instant?: PanelInstant | null;
};
/// What the Buy / Sell row needs for instant trades: with `on`, a button opens the presets (TradePresets) after the
/// wallet step (`ready`: false when a locked trading wallet was asked to unlock, and nothing else happens), a preset
/// runs the trade (`run`), "Custom…" opens the ticket. `opening`: the trade under way on the page (one at a time; both
/// buttons are off while it runs). `blocked`: why the last instant trade of a coin found it not tradable here.
export type PanelInstant = {
  on: boolean; presets: { buy: readonly number[]; sell: readonly number[] }; ready: () => boolean;
  run: (mint: string, spec: InstantSpec, label: string) => void;
  opening: { mint: string; side: Side } | null;
  blocked: { mint: string; short: string; body: string } | null;
};

export default function SidePanel({ node, byMint, kids, coin: c, coinError, heat, heatOn, maxDepth, map, onPick, onClose, peek = false, family = null, mode = "mcap", firstborn = EMPTY_FIRSTBORNS, leaders = [], copyList = [], copyTraded = false, heatIndex = null, volRank = null, families = null, lastHidden = false, onShowAll, onTrade, trade = null, instant = null }: Props) {
  const toast = useToast();
  const candles = useCandles(node.mint);
  const [sparkRef, sparkW] = useWidth();
  const [broodRef, broodW] = useWidth();
  // The CA pill's copy confirmation: the icon turns into a check and the pill flashes for 1.4 s.
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1_400); return () => clearTimeout(t); }, [copied]);
  useEffect(() => setCopied(false), [node.mint]);
  const change = candleChange(candles?.candles);
  const parent = node.parentMint ? byMint.get(node.parentMint) ?? null : null;
  const chain = useMemo(() => {
    const out: BubbleNode[] = [];
    let cur: BubbleNode | undefined = node;
    for (let hops = 0; cur && hops < 12; hops++) { out.unshift(cur); cur = cur.parentMint ? byMint.get(cur.parentMint) : undefined; }
    return out;
  }, [node, byMint]);
  const root = chain[0] ?? node;
  // most traded first once the heat is in; the reader's own pick stays
  const [sortWant, setSortWant] = useState<ListSort | null>(null);
  const sorts: ListSort[] = heatIndex ? ["vol", "mcap", "new"] : ["mcap", "new"];
  const sort: ListSort = sortWant && sorts.includes(sortWant) ? sortWant : sorts[0];
  const [tabWant, setTabWant] = useState<PanelTab>(lastTab);
  // the stack's first 50, the selection always among them
  const shownCopies = useMemo(() => {
    const out = copyList.slice(0, 50);
    if (copyList.length > 50 && !out.some((k) => k.mint === node.mint)) { const me = copyList.find((k) => k.mint === node.mint); if (me) out[49] = me; }
    return out;
  }, [copyList, node.mint]);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [node.mint]);
  const sorted = useMemo(() => {
    if (sort === "mcap") return kids;
    if (sort === "new") return kids.slice().sort(SORTS.new);
    const v = (k: BubbleNode) => heatIndex?.rows.get(k.mint)?.v24 ?? 0, t = (k: BubbleNode) => heatIndex?.rows.get(k.mint)?.t1h ?? 0;
    return kids.slice().sort((a, b) => v(b) - v(a) || t(b) - t(a) || kidCmp(a, b));
    // the order follows the poll (`at`), like the rank and the most-active list; the live bumps between two polls do not reorder
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kids, sort, heatIndex?.at]);
  // A listed asset drawn as a family top: its `children` is the true count. Once the store holds some of its rows the
  // list is ONE order over all of them (sorted once per sort and per batch of pages; a drawn mint keeps its row, sorted
  // by and shown as its live node), plus any drawn kid the rows lack (born since the snapshot). "show more" past what
  // is loaded, or a sort change (the drawn slice is the family's top by locked value, so it gives no sort's full-family order), asks the store for the family.
  const assetTop = !!families && node.asset === true && (!node.parentMint || !byMint.has(node.parentMint));
  const fam = useFamilyInfo(assetTop ? families : null, assetTop ? node.mint : null);
  // the mint whose rest the reader asked for (so a newly selected coin never inherits the previous one's want)
  const [wantFor, setWantFor] = useState<string | null>(null);
  const wantMore = wantFor === node.mint;
  useEffect(() => {
    if (!families) return;
    families.want(assetTop && wantMore ? [node.mint] : [], "panel");
  }, [families, assetTop, wantMore, node.mint]);
  useEffect(() => () => { families?.want([], "panel"); }, [families]);
  // by volume the list is the coins on the map (the store's rows carry no volume)
  const hasRows = assetTop && sort !== "vol" && !!families && !!fam.info && fam.info.loaded > 0;
  // the drawn kids the loaded rows do not hold, as a stable key (kids is a new array on every live event; the order is not)
  const extraKey = useMemo(() => {
    if (!hasRows || !families) return "";
    let s = "";
    for (const k of kids) if (families.familyOf(k.mint) !== node.mint) s += (s ? "," : "") + k.mint;
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRows, families, kids, node.mint, fam.version]);
  const rows = useMemo(() => {
    if (!hasRows || !families) return NO_ROWS;
    const chunks = families.chunks(node.mint);
    const extra = extraKey ? extraKey.split(",").map((m) => byMint.get(m)).filter((n): n is BubbleNode => !!n) : [];
    return { chunks, extra, pos: familyOrder(chunks, sort, (m) => byMint.get(m), extra) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRows, families, node.mint, sort, fam.version, byMint, extraKey]);
  const listLen = rows.pos.length > 0 ? rows.pos.length : sorted.length;
  const kidsTotal = assetTop ? Math.max(node.children, listLen) : sorted.length;
  const shownKids = useMemo(() => {
    if (!rows.pos.length) return sorted.slice(0, shown);
    const out: BubbleNode[] = [];
    for (let j = 0; j < rows.pos.length && out.length < shown; j++) {
      const m = mintAtPos(rows.chunks, rows.pos[j], rows.extra);
      // a drawn coin shows its live node, a loaded speck the store's
      const n = m ? byMint.get(m) ?? families?.node(m) ?? null : null;
      if (n) out.push(n);
    }
    return out;
    // `sorted` moves with every live event: the drawn rows re-read their live numbers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, shown, rows, families, byMint]);
  // by volume the list is complete over the coins on the map: nothing is loading for it
  const famLoading = assetTop && sort !== "vol" && fam.info?.state === "loading";
  const partial = assetTop && kidsTotal > listLen;
  // screen readers: "loading the rest" when the pages start, "N coins listed" once they have stopped (not every step)
  const [said, setSaid] = useState("");
  const sayRef = useRef<{ busy: boolean; t: ReturnType<typeof setTimeout> | null; len: number }>({ busy: false, t: null, len: 0 });
  sayRef.current.len = listLen;
  useEffect(() => {
    const s = sayRef.current;
    if (famLoading) {
      if (s.t) { clearTimeout(s.t); s.t = null; }
      if (!s.busy) { s.busy = true; setSaid("loading the rest of the list"); }
      return;
    }
    if (!s.busy || s.t) return;
    s.t = setTimeout(() => { s.t = null; s.busy = false; setSaid(`${count(s.len)} coins listed`); }, SAY_DONE_MS);
  }, [famLoading]);
  useEffect(() => { const s = sayRef.current; if (s.t) clearTimeout(s.t); s.t = null; s.busy = false; setSaid(""); }, [node.mint]);
  useEffect(() => () => { const t = sayRef.current.t; if (t) clearTimeout(t); }, []);
  // A loaded speck (or the pending node of one) has no name or logo: the head takes them from the light /api/coin.
  const head = c && c.mint === node.mint && !byMint.has(node.mint) && (node.name == null || node.image == null) ? { ...node, name: node.name ?? c.name, image: node.image ?? c.image } : node;
  const created = c?.createdAt ?? node.createdAt ?? null;
  const ours = c?.ours ?? node.ours;
  const block = launchBlock({ depth: node.depth, mayhem: c?.mayhem }, maxDepth);
  const link = mapLink(node.mint);
  // The post text: the family top from the dominance block (or the crumb chain), "1st" from the firstborn
  // set, and, for the top itself, its family's share in the map's size mode.
  const top = family?.top ?? root;
  const domShare = top.mint === node.mint ? shareOf(mode === "mcap" ? family?.mcap : family?.locked) : null;
  const post = shareText(node, parent, { root: top, firstborn: firstborn.has(node.mint), dominance: domShare != null ? { share: domShare, mode } : null });
  const copy = async (text: string, what: string) => { if (await copyText(text)) { toast.success(`${what} copied`); if (text === node.mint) setCopied(true); } else toast.error("Could not copy"); };
  const changeEl = change
    ? <span className={`map-chg ${change.ratio >= 0 ? "up" : "down"}`} title={`Change over the candles the indexer has (${spanLabel(change.spanS)})`}>{signedPct(change.ratio)} · {spanLabel(change.spanS)}</span>
    : <span className="map-chg none" title="No candles for this coin yet">—</span>;
  // A long ticker is cut so the button keeps one line beside "Open coin".
  const tick = sym(node);
  const launchLabel = `Launch under ${tick.length > 7 ? `${tick.slice(0, 6)}…` : tick}`;
  const launch = c ? <LaunchButton coin={c} maxDepth={maxDepth} className="block" label={launchLabel} />
    : block ? <button type="button" className="btn accent block" disabled title={block}>{launchLabel}</button>
    : <Link to={`/launch?parent=${node.mint}`} className="btn accent block launch-cta" title={`Launch a coin under ${tick}`}>{launchLabel}</Link>;
  const mainActs = <div className="map-side-main">{launch}<Link to={`/c/${node.mint}`} className="btn ghost">Open coin →</Link></div>;
  // Buy / Sell open the quick trade; a coin whose route cannot start from SOL gets pump.fun instead, with the reason,
  // so the button never leads to a dead end. Only for a coin with a record (a listed asset top such as PUMP has none),
  // and only once this coin's route is known (the page checks it: lib/trade-route, the same answer the B key reads).
  // An instant trade that found the coin not tradable here (its route read again) says why in the same place.
  const routeFor = trade?.data && trade.data.coins[0]?.mint === node.mint ? trade.data : null;
  const blocked = hardBlock(routeFor);
  const why = (blocked && c ? blockText(blocked, c) : null) ?? (instant?.blocked && instant.blocked.mint === node.mint ? instant.blocked : null);
  const tradeActs = !onTrade || !trade || !c || c.mint !== node.mint ? null
    : why ? (
      <div className="map-side-trade blocked">
        <a className="btn ghost" href={pumpUrl(node.mint)} target="_blank" rel="noopener noreferrer" title={why.body}>Trade on pump.fun ↗</a>
        <span className="map-side-why" title={why.body}>{why.short}</span>
      </div>
    ) : routeFor ? (
      // keyed by the coin: a new selection never inherits an open popover (peek and full are two mounts as well)
      <TradeRow key={node.mint} coin={c} label={sym(node)} jupiter={routeFor.via === "jupiter"} onTrade={onTrade} instant={instant} />
    ) : trade.error ? (
      <div className="map-side-trade blocked">
        <a className="btn ghost" href={pumpUrl(node.mint)} target="_blank" rel="noopener noreferrer">Trade on pump.fun ↗</a>
        <span className="map-side-why" title={trade.error}>route check failed · <button type="button" className="linkish" onClick={trade.reload}>retry</button></span>
      </div>
    ) : (
      <div className="map-side-trade" aria-busy="true">
        <button type="button" className="btn buy" disabled title="Checking the route…">Buy</button>
        <button type="button" className="btn sell" disabled title="Checking the route…">Sell</button>
      </div>
    );
  const close = <button type="button" className="map-side-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>×</button>;

  if (peek) {
    return (
      <div className="map-side-in peek">
        {close}
        <div className="map-side-head">
          <Logo src={head.image} label={node.symbol} size={36} className="ring" />
          <div className="map-side-title"><b>{nameOf(head)}</b><span className="mono muted">{sym(node)} · {usd(node.mcapUsd)} mcap</span></div>
          {changeEl}
        </div>
        {tradeActs}
        {mainActs}
      </div>
    );
  }

  const tw = httpUrl(c?.twitter), tg = httpUrl(c?.telegram), web = httpUrl(c?.website);
  const hasKids = kids.length > 0 || (assetTop && node.children > 0);
  // One list at a time (2026-11-15: the three were stacked, 1,000 px of rows under the fold). The reader's last choice
  // is kept across coins; a coin without that list shows the first it has: its children, the family's most active, its copies.
  const tabs: { k: PanelTab; label: string; n?: number }[] = [];
  if (hasKids) tabs.push({ k: "kids", label: "Children", n: Math.max(node.children, kids.length) });
  if (leaders.length > 0) tabs.push({ k: "active", label: "Most active" });
  if (copyList.length > 1) tabs.push({ k: "copies", label: "Same name", n: copyList.length });
  const tab = tabs.some((t) => t.k === tabWant) ? tabWant : tabs[0]?.k ?? null;
  const pickTab = (k: PanelTab) => { lastTab = k; setTabWant(k); };
  const hover = (m: string | null) => map.current?.hoverNode(m);
  const volOf = (k: BubbleNode) => heatIndex?.rows.get(k.mint)?.v24 ?? 0;
  return (
    <div className="map-side-in">
      {close}
      <div className="map-side-head">
        <span className="map-side-logo" aria-hidden="true" style={{ "--tint": TINT_RGB[Math.min(node.depth, TINT_RGB.length - 1)] } as CSSProperties}><Logo src={head.image} label={node.symbol} size={44} className="ring" /></span>
        <div className="map-side-title">
          <b title={nameOf(head)}>{nameOf(head)}</b>
          <span className="mono muted">{sym(node)}{created ? ` · ${age(created)}` : ""}{firstborn.has(node.mint) && <Firstborn parent={parent} className="ml" />}</span>
          <span className="map-side-ids">
            <button type="button" className={`map-ca ${copied ? "done" : ""}`} onClick={() => copy(node.mint, "Contract address")} title={`Copy ${node.mint}`}><span className="map-ca-text">{short(node.mint, 4)}</span><span className="map-ca-ok" aria-hidden="true">copied</span>{Icon.copy}{Icon.check}</button>
            {node.migrated ? <span className="map-side-state good">graduated</span> : c?.complete ? <span className="map-side-state warn">migrating</span> : null}
            {ours ? <span className="map-side-state accent" title="Launched on Spore">Spore</span> : c?.oursPending ? <span className="map-side-state warn">verifying</span> : null}
            {tw && <a className="map-soc" href={tw} target="_blank" rel="noopener noreferrer" aria-label="X / Twitter" title={tw}>{Icon.x}</a>}
            {tg && <a className="map-soc" href={tg} target="_blank" rel="noopener noreferrer" aria-label="Telegram" title={tg}>{Icon.tg}</a>}
            {web && <a className="map-soc" href={web} target="_blank" rel="noopener noreferrer" aria-label="Website" title={web}>{Icon.web}</a>}
          </span>
        </div>
        <DepthBadge depth={node.depth} quote={c && c.mint === node.mint ? listedQuoteOf(c) : undefined} />
      </div>
      <nav className="map-crumbs" aria-label="Family">
        <ol>
          {chain.map((n, i) => (
            <li key={n.mint} style={{ "--node": toneOf(n.depth) } as CSSProperties}>{i > 0 && <span className="sep" aria-hidden="true" />}<i className="map-crumb-node" aria-hidden="true" />{n === node ? <b aria-current="true">{sym(n)}</b> : <button type="button" onClick={() => onPick(n.mint)} title={`Select ${nameOf(n)}`}>{sym(n)}</button>}</li>
          ))}
        </ol>
        <button type="button" className="map-frame" onClick={() => map.current?.fitCluster(root.mint, { select: false })} title={`Frame the whole ${sym(root)} tree (F)`}>Frame tree</button>
      </nav>
      <div className="map-side-market">
        <div className="map-side-price">
          <em>price</em>
          <strong>{c ? usd(c.priceUsd) : coinError ? "—" : <Skeleton w={96} h={22} />}</strong>
          {candles === undefined ? <Skeleton w={70} h={18} r={999} /> : changeEl}
          {heatOn && <p className="map-side-heat">{heat && heat.last > 0 ? <>last trade {ago(heat.last)}{c && c.trades24h > 0 ? <> · {count(c.trades24h)} tx 24h</> : null}</> : "no trade in 24 h"}</p>}
        </div>
        <div className="map-side-spark" ref={sparkRef}>{candles === undefined || sparkW === 0 ? <Skeleton h={SPARK_H} r={8} /> : candles && candles.candles.length >= 2 ? <Sparkline candles={candles.candles} w={sparkW} h={SPARK_H} unit={candles.priceKey} title={`${sym(node)} price, last ${spanLabel(change?.spanS ?? 0)}, ${change ? signedPct(change.ratio) : "no change"}`} /> : <span className="map-spark-none">no candles yet</span>}</div>
      </div>
      {lastHidden && <p className="map-side-hidden">Hidden by the Key filter · {heat && heat.last > 0 ? <>last trade {ago(heat.last)}</> : "no trade on record"}{onShowAll && <> · <button type="button" className="linkish" onClick={onShowAll} title="Show every coin, whatever its last trade (?last=all)">show all</button></>}</p>}
      <div className="map-side-stats">
        <div><em>mcap</em><strong>{usd(node.mcapUsd)}</strong></div>
        <div><em>24h volume</em><strong title={c && c.trades24h > 0 ? `${count(c.trades24h)} trades in 24 h` : undefined}>{c ? usd(c.volume24hUsd) : coinError ? "—" : <Skeleton w={48} h={14} />}</strong></div>
        <div><em>trades 1h</em><strong className={heat && heat.t1h > 0 ? "accent" : undefined}>{heatOn ? count(heat?.t1h ?? 0) : "—"}</strong></div>
      </div>
      {family && <FamilyBlock family={family} mode={mode} node={node} rank={volRank} onPick={onPick} />}
      {c && !c.migrated && <div className="map-side-progress"><span><em>curve</em><strong>{pct(c.progress)}</strong></span><ProgressBar value={c.progress} /></div>}
      <div className="map-side-actions">
        {tradeActs}
        {mainActs}
        <div className="map-side-links">
          <button type="button" className="linkish" onClick={() => copy(link, "Map link")} title={link}>Share</button>
          <a className="linkish" href={xShareUrl(post, link)} target="_blank" rel="noopener noreferrer" title="Post this coin's family tree on X">Post on X</a>
          <button type="button" className="linkish" onClick={() => map.current?.fit()} title="Zoom back out to the whole map (0)">Whole map</button>
        </div>
      </div>
      {tab && (
        <section className="map-kids" aria-label={tab === "kids" ? `Coins under ${sym(node)}` : tab === "active" ? `Most active coins in the ${family ? sym(family.top) : sym(node)} family` : `Coins named ${sym(node)} under the same parent`} ref={broodRef}>
          {tabs.length > 1 ? (
            <div className="map-tabs" role="group" aria-label="Lists">
              {tabs.map((t) => <button type="button" key={t.k} aria-pressed={tab === t.k} onClick={() => pickTab(t.k)}>{t.label}{t.n != null && <i>{count(t.n)}</i>}</button>)}
            </div>
          ) : <header><em>{tabs[0].label}{tabs[0].n != null ? ` · ${count(tabs[0].n)}` : ""}</em></header>}
          {tab === "kids" && (
            <>
              <header>
                <em>under {sym(node)}{(node.descendants ?? 0) > node.children ? ` · ${count(node.descendants)} in tree` : ""}</em>
                <div className="seg sm" role="group" aria-label="Sort children"><SlidingPill />{sorts.map((k) => <button type="button" key={k} aria-pressed={sort === k} onClick={() => { setSortWant(k); if (partial && k !== "vol") setWantFor(node.mint); }} title={k === "vol" ? "Most traded in 24 h first" : k === "mcap" ? "Largest market cap first" : "Newest first"}>{k === "vol" ? "volume" : k}</button>)}</div>
              </header>
              {sort === "new" && broodW > 0 && <Brood node={node} kids={kids} width={broodW} onPick={onPick} onHover={hover} />}
              {/* the order covers only what is loaded: say so, so the top of a sort never claims the whole family */}
              {partial && <p className="map-kids-note">sorted over {count(listLen)} of {count(kidsTotal)}{famLoading ? " · loading the rest…" : rows.pos.length === 0 ? " (the coins on the map)" : ""}</p>}
              <div className="map-kids-cols" aria-hidden="true"><span>coin</span><span>{sort === "vol" ? "24h vol" : "mcap"}</span><span>age</span></div>
              <p className="map-sr" aria-live="polite" aria-atomic="true">{said}</p>
              <ul onMouseLeave={() => hover(null)} aria-busy={famLoading || undefined}>
                {shownKids.map((k) => (
                  <li key={k.mint}>
                    <button type="button" className="map-kid" onClick={() => onPick(k.mint)} onMouseEnter={() => hover(k.mint)} onFocus={() => hover(k.mint)} title={nameOf(k)}>
                      <Logo src={k.image} label={k.symbol} size={18} />
                      <b>{sym(k)}{firstborn.has(k.mint) && <Firstborn parent={node} className="ml" />}</b>
                      {sort === "vol" ? <span className="mono" title="24 h volume">{volOf(k) > 0 ? usd(volOf(k)) : "—"}</span> : <span className="mono" title="market cap">{usd(k.mcapUsd)}</span>}
                      <span className="mono muted" title="age">{k.createdAt ? age(k.createdAt) : "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {listLen > shown ? <button type="button" className="map-more linkish" onClick={() => setShown((s) => s + PAGE)}>show {Math.min(PAGE, listLen - shown)} more of {count((sort === "vol" ? listLen : kidsTotal) - shown)}</button>
                : assetTop && kidsTotal > listLen ? (
                  sort === "vol" ? <p className="map-more-note">by volume lists the coins on the map · mcap or new lists all {count(kidsTotal)}</p>
                  : fam.info?.state === "error" ? <p className="map-more-note">the rest did not load · <button type="button" className="linkish" onClick={() => { families?.want([], "panel"); families?.want([node.mint], "panel"); }}>retry</button></p>
                  : fam.info?.state === "done" && fam.info.loaded < fam.info.total ? <p className="map-more-note">{count(listLen)} of {count(kidsTotal)} listed on this screen</p>
                  : wantMore ? <p className="map-more-note">loading… {count(fam.info?.loaded ?? 0)} of {count(fam.info?.total ?? node.children)}</p>
                  : <button type="button" className="map-more linkish" onClick={() => { setShown(listLen + PAGE); setWantFor(node.mint); }}>show {Math.min(PAGE, kidsTotal - listLen)} more of {count(kidsTotal - listLen)}</button>
                ) : null}
            </>
          )}
          {tab === "active" && (
            <div className="map-active">
              <header><em>{family ? sym(family.top) : sym(node)} family · by 24 h volume</em></header>
              <div className="map-kids-cols" aria-hidden="true"><span>coin</span><span>24h vol</span><span>1h</span></div>
              <ol onMouseLeave={() => hover(null)}>
                {leaders.map((l) => (
                  <li key={l.node.mint}>
                    <button type="button" className="map-kid" aria-current={l.node.mint === node.mint || undefined} onClick={() => onPick(l.node.mint)} onMouseEnter={() => hover(l.node.mint)} onFocus={() => hover(l.node.mint)} title={`#${l.rank} in the family by 24 h volume · ${nameOf(l.node)}`}>
                      <i className="map-active-rank mono" aria-hidden="true">{l.rank}</i>
                      <b>{sym(l.node)}</b>
                      <span className="mono" title="24 h volume">{usd(l.v24)}</span>
                      <span className="mono muted" title="trades in the last hour">{count(l.t1h)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {tab === "copies" && (
            <div className="map-active">
              <header><em>named {sym(node)} · same parent</em></header>
              <div className="map-kids-cols" aria-hidden="true"><span>coin</span><span>mcap</span><span>age</span></div>
              <ol className="map-copies" onMouseLeave={() => hover(null)}>
                {shownCopies.map((k) => (
                  <li key={k.mint}>
                    <button type="button" className="map-kid" aria-current={k.mint === node.mint || undefined} onClick={() => onPick(k.mint)} onMouseEnter={() => hover(k.mint)} onFocus={() => hover(k.mint)} title={`${nameOf(k)} · ${k.mint}`}>
                      <Logo src={k.image} label={k.symbol} size={18} />
                      <b>{sym(k)}{k === copyList[0] && <span className="map-copy-lead">{copyTraded ? "most traded" : "largest"}</span>}</b>
                      <span className="mono" title="market cap">{usd(k.mcapUsd)}</span>
                      <span className="mono muted" title="age">{k.createdAt ? age(k.createdAt) : "—"}</span>
                    </button>
                  </li>
                ))}
              </ol>
              {copyList.length > 50 && <p className="map-kids-note">{copyTraded ? "the 50 most traded" : "the first 50"} of {count(copyList.length)}</p>}
            </div>
          )}
        </section>
      )}
      {coinError && !c && <p className="hint">{coinError}</p>}
    </div>
  );
}

/// Buy / Sell for the selected coin. With instant trades on, a button opens the user's presets under it (TradePresets,
/// portalled to the body, so the side panel's scrolling and the bottom sheet's transform do not move it) and a preset
/// is the trade; "Custom…" and instant trades off open the ticket. Sell shows without a position check: the instant sell
/// reads the balance from the chain, and a wallet that holds none is told so. The B key opens the ticket (Map.tsx).
function TradeRow({ coin, label, jupiter, onTrade, instant }: { coin: Coin; label: string; jupiter: boolean; onTrade: (side: Side, coin: Coin) => void; instant: PanelInstant | null }) {
  const [menu, setMenu] = useState<Side | null>(null);
  const buyRef = useRef<HTMLButtonElement>(null), sellRef = useRef<HTMLButtonElement>(null);
  const on = !!instant?.on;
  // a trade under way (on any coin: one at a time), or instant trades turned off, closes the presets
  const running = !!instant?.opening;
  useEffect(() => { if (running || !on) setMenu(null); }, [running, on]);
  const shown = running || !on ? null : menu;
  const busy = (side: Side) => instant?.opening?.mint === coin.mint && instant.opening.side === side;
  const press = (side: Side) => {
    if (!instant || !on) { onTrade(side, coin); return; }
    if (menu === side) { setMenu(null); return; }
    // a locked trading wallet is asked to unlock, and nothing else happens
    if (instant.ready()) setMenu(side);
  };
  const pop = (side: Side) => (on ? { "aria-haspopup": "dialog" as const, "aria-expanded": shown === side } : {});
  const via = jupiter ? " through Jupiter" : "";
  const title = (side: Side) => (on
    ? `${side === "buy" ? "Buy" : "Sell"} ${label}${via}: pick a preset amount, or Custom… for the ticket${side === "buy" ? " (B opens the ticket)" : ""}`
    : side === "buy" ? `Buy ${label} with SOL${via} (B)` : `Sell ${label} for SOL${via}`);
  return (
    <div className="map-side-trade" aria-busy={running || undefined}>
      <button ref={buyRef} type="button" className={`btn buy ${busy("buy") ? "is-busy" : ""}`} disabled={running} aria-busy={busy("buy")} {...pop("buy")} onClick={() => press("buy")} title={title("buy")}>Buy</button>
      <button ref={sellRef} type="button" className={`btn sell ${busy("sell") ? "is-busy" : ""}`} disabled={running} aria-busy={busy("sell")} {...pop("sell")} onClick={() => press("sell")} title={title("sell")}>Sell</button>
      {shown && instant && (
        <TradePresets side={shown} label={`${shown === "buy" ? "Buy" : "Sell"} ${label}`} anchor={(shown === "buy" ? buyRef : sellRef).current}
          presets={shown === "buy" ? instant.presets.buy.map((v) => `${v} SOL`) : instant.presets.sell.map((v) => `${v}%`)}
          onPick={(i) => instant.run(coin.mint, shown === "buy" ? { side: "buy", sol: instant.presets.buy[i] } : { side: "sell", pct: instant.presets.sell[i] }, label)}
          onCustom={() => onTrade(shown, coin)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/// The coin's family in two lines: whose it is, how big, where it ranks on the map with its share (in the map's size
/// mode) on a thin bar; and, coloured by volume, the coin's own place in that family by 24 h volume.
function FamilyBlock({ family, mode, node, rank, onPick }: { family: Family; mode: SizeMode; node: BubbleNode; rank: { rank: number; of: number } | null; onPick: (mint: string) => void }) {
  const row = (mode === "mcap" ? family.mcap : family.locked) ?? family.locked ?? family.mcap;
  const share = shareOf(mode === "mcap" ? family.mcap : family.locked) ?? shareOf(family.locked) ?? shareOf(family.mcap);
  if (!row || share == null) return null;
  // the true size: the drawn members and the coins the map leaves out of a listed asset's family
  const size = row.members + (family.ghost ?? 0);
  const isTop = family.top.mint === node.mint;
  return (
    <section className="map-side-dom" aria-label={`${sym(family.top)} family`}>
      <p className="map-fam-line">
        <span>{isTop ? <b>{sym(family.top)}</b> : <button type="button" className="linkish" onClick={() => onPick(family.top.mint)} title={`Select ${nameOf(family.top)}`}>{sym(family.top)}</button>} family · {count(size)} coin{size === 1 ? "" : "s"}</span>
        <span title={`#${count(row.rank)} of ${count(family.families)} families · ${sharePct(share)} of all ${mode === "mcap" ? "market cap" : "locked value"} on the map`}>#{count(row.rank)} · <b>{sharePct(share)}</b></span>
      </p>
      <span className="map-fam-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }} /></span>
      {rank && <p className="map-fam-line"><span>volume rank in family</span><span className={rank.rank <= 10 ? "is-lead" : undefined}><b>#{count(rank.rank)}</b> of {count(rank.of)}</span></p>}
    </section>
  );
}
