// The selected coin beside the map (desktop) or in the bottom sheet (phone). Numbers that describe the
// tree (mcap, locked by children, children, descendants) come from the map node: that is the all-scope
// truth, while /api/coin is scoped to Spore launches in production and reports 0 there. Trading numbers
// (price, 24 h volume, curve, socials, ours) come from a light /api/coin call (no children, no trades),
// debounced so an arrow-key walk does not fire a request per step; the sparkline reads
// /api/candles?scope=all and shows "—" when the server has none (or predates the route). The family block
// shows the dominance of the coin's family (its top's share of the whole map, lib/map/dominance.ts) and its true size
// (drawn members + the asset family's undrawn coins). A listed asset's kids list is one sorted sequence over every coin
// the family store has paged in (lib/map/family.ts, DESIGN-FAMILY-ALL §6), the drawn kids among them (a drawn one shows
// its live node); until the family is in, it is the drawn kids with a note saying how many of the family it sorts.
// Only the rows shown become nodes.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Link } from "react-router-dom";
import { api, pumpUrl, xShareUrl, type Candles, type Coin } from "../../../lib/api";
import { blockText, hardBlock, type TradeRoute } from "../../../lib/trade-route";
import type { Side } from "../../../lib/pump";
import { copyText, useAsync, useDebounced } from "../../../lib/hooks";
import { age, ago, count, pct, short, signedPct, usd } from "../../../lib/format";
import type { HeatRow } from "../../../lib/map/heat";
import { mapLink, shareText } from "../../../lib/map/share";
import { shareOf, type DomRow } from "../../../lib/map/dominance";
import type { BubbleNode, SizeMode } from "../../../lib/map/types";
import type { BubbleMapHandle } from "../../BubbleMap";
import { DepthBadge, Logo, ProgressBar, Skeleton, listedQuoteOf, nameOf, sym, Firstborn } from "../../Bits";
import { EMPTY_FIRSTBORNS } from "../../../lib/map/firstborn";
import { familyOrder, mintAtPos, useFamilyInfo } from "../../../lib/map/family";
import type { FamilyChunk, FamilyStore } from "../../../lib/map/family-types";
import LaunchButton, { launchBlock } from "../../LaunchButton";
import { useToast } from "../../Toast";
import DominanceLine from "../../DominanceLine";
import SlidingPill from "../../ui/SlidingPill";
import Sparkline, { candleChange, spanLabel } from "./Sparkline";
import Brood from "./Brood";

const PAGE = 40;
/// The price line's height: tall enough to read, short enough that the children list starts above the fold at 900 px.
const SPARK_H = 42;
export type KidSort = "mcap" | "new";
/// The children-list order (and what ↓ / ← / → walk): market cap, then locked value.
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
  coin: Coin | null; coinError: string | null;
  heat: HeatRow | null; heatOn: boolean;
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
};

export default function SidePanel({ node, byMint, kids, coin: c, coinError, heat, heatOn, maxDepth, map, onPick, onClose, peek = false, family = null, mode = "mcap", firstborn = EMPTY_FIRSTBORNS, families = null, lastHidden = false, onShowAll, onTrade, trade = null }: Props) {
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
  const [sort, setSort] = useState<KidSort>("mcap");
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [node.mint]);
  const sorted = useMemo(() => (sort === "mcap" ? kids : kids.slice().sort(SORTS[sort])), [kids, sort]);
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
  const hasRows = assetTop && !!families && !!fam.info && fam.info.loaded > 0;
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
  const famLoading = assetTop && fam.info?.state === "loading";
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
  const routeFor = trade?.data && trade.data.coins[0]?.mint === node.mint ? trade.data : null;
  const blocked = hardBlock(routeFor);
  const why = blocked && c ? blockText(blocked, c) : null;
  const tradeActs = !onTrade || !trade || !c || c.mint !== node.mint ? null
    : why ? (
      <div className="map-side-trade blocked">
        <a className="btn ghost" href={pumpUrl(node.mint)} target="_blank" rel="noopener noreferrer" title={why.body}>Trade on pump.fun ↗</a>
        <span className="map-side-why" title={why.body}>{why.short}</span>
      </div>
    ) : routeFor ? (
      <div className="map-side-trade">
        <button type="button" className="btn buy" onClick={() => onTrade("buy", c)} title={`Buy ${sym(node)} with SOL${routeFor.via === "jupiter" ? " through Jupiter" : ""} (B)`}>Buy</button>
        <button type="button" className="btn sell" onClick={() => onTrade("sell", c)} title={`Sell ${sym(node)} for SOL${routeFor.via === "jupiter" ? " through Jupiter" : ""}`}>Sell</button>
      </div>
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
      {(node.migrated || c?.complete || ours || c?.oursPending) && (
        <div className="map-side-row">
          {node.migrated ? <span className="chip good">graduated</span> : c?.complete ? <span className="chip warn">migrating</span> : null}
          {ours ? <span className="chip accent">launched on Spore</span> : c?.oursPending ? <span className="chip warn">verifying</span> : null}
        </div>
      )}
      <div className="map-side-market">
        <div className="map-side-price">
          <em>price</em>
          <strong>{c ? usd(c.priceUsd) : coinError ? "—" : <Skeleton w={96} h={22} />}</strong>
          {candles === undefined ? <Skeleton w={70} h={18} r={999} /> : changeEl}
          {heatOn && <p className="map-side-heat">{heat && heat.t1h > 0 ? <><b>{count(heat.t1h)}</b> trade{heat.t1h === 1 ? "" : "s"} 1h</> : "no trades 1h"}{heat && heat.last > 0 ? <> · last trade {ago(heat.last)}</> : null}</p>}
        </div>
        <div className="map-side-spark" ref={sparkRef}>{candles === undefined || sparkW === 0 ? <Skeleton h={SPARK_H} r={8} /> : candles && candles.candles.length >= 2 ? <Sparkline candles={candles.candles} w={sparkW} h={SPARK_H} unit={candles.priceKey} title={`${sym(node)} price, last ${spanLabel(change?.spanS ?? 0)}, ${change ? signedPct(change.ratio) : "no change"}`} /> : <span className="map-spark-none">no candles yet</span>}</div>
      </div>
      {lastHidden && <p className="map-side-hidden">Hidden by the Key filter · {heat && heat.last > 0 ? <>last trade {ago(heat.last)}</> : "no trade on record"}{onShowAll && <> · <button type="button" className="linkish" onClick={onShowAll} title="Show every coin, whatever its last trade (?last=all)">show all</button></>}</p>}
      <div className="map-side-stats">
        <div><em>mcap</em><strong>{usd(node.mcapUsd)}</strong></div>
        <div><em>children</em><strong>{count(node.children)}{(node.descendants ?? 0) > node.children ? <small> / {count(node.descendants)}</small> : null}</strong></div>
        <div><em>24h volume</em><strong>{c ? usd(c.volume24hUsd) : coinError ? "—" : <Skeleton w={48} h={14} />}{c && c.trades24h > 0 ? <small> · {count(c.trades24h)} tx</small> : null}</strong></div>
      </div>
      {family && <FamilyBlock family={family} mode={mode} />}
      {c && !c.migrated && <div className="map-side-progress"><span><em>curve</em><strong>{pct(c.progress)}</strong></span><ProgressBar value={c.progress} /></div>}
      <div className="map-side-actions">
        {tradeActs}
        {mainActs}
        <div className="map-side-links">
          <button type="button" className="btn ghost sm" onClick={() => copy(link, "Map link")} title={link}>Share</button>
          <a className="btn ghost sm" href={xShareUrl(post, link)} target="_blank" rel="noopener noreferrer" title="Post this coin's family tree on X">Post on X</a>
          <button type="button" className="btn ghost sm" onClick={() => copy(node.mint, "Contract address")}>Copy CA</button>
          <button type="button" className="btn ghost sm" onClick={() => map.current?.fit()} title="Zoom back out to the whole map (0)">Whole map</button>
        </div>
      </div>
      {(kids.length > 0 || (assetTop && node.children > 0)) && (
        <section className="map-kids" aria-label={`Coins under ${sym(node)}`} ref={broodRef}>
          <header>
            <em>under {sym(node)} · {count(assetTop ? node.children : kids.length)}</em>
            <div className="seg sm" role="group" aria-label="Sort children"><SlidingPill />{(["mcap", "new"] as const).map((k) => <button type="button" key={k} aria-pressed={sort === k} onClick={() => { setSort(k); if (partial) setWantFor(node.mint); }}>{k}</button>)}</div>
          </header>
          {broodW > 0 && <Brood node={node} kids={kids} width={broodW} onPick={onPick} onHover={(m) => map.current?.hoverNode(m)} />}
          {/* the order covers only what is loaded: say so, so the top of an mcap or new sort never claims the whole family */}
          {partial && <p className="map-kids-note">sorted over {count(listLen)} of {count(kidsTotal)}{famLoading ? " · loading the rest…" : rows.pos.length === 0 ? " (the drawn coins)" : ""}</p>}
          <div className="map-kids-cols" aria-hidden="true"><span>coin</span><span>mcap</span><span>age</span></div>
          <p className="map-sr" aria-live="polite" aria-atomic="true">{said}</p>
          <ul onMouseLeave={() => map.current?.hoverNode(null)} aria-busy={famLoading || undefined}>
            {shownKids.map((k) => (
              <li key={k.mint}>
                <button type="button" className="map-kid" onClick={() => onPick(k.mint)} onMouseEnter={() => map.current?.hoverNode(k.mint)} onFocus={() => map.current?.hoverNode(k.mint)} title={nameOf(k)}>
                  <Logo src={k.image} label={k.symbol} size={18} />
                  <b>{sym(k)}{firstborn.has(k.mint) && <Firstborn parent={node} className="ml" />}</b>
                  <span className="mono" title="market cap">{usd(k.mcapUsd)}</span>
                  <span className="mono muted" title="age">{k.createdAt ? age(k.createdAt) : "—"}</span>
                </button>
              </li>
            ))}
          </ul>
          {listLen > shown ? <button type="button" className="map-more linkish" onClick={() => setShown((s) => s + PAGE)}>show {Math.min(PAGE, listLen - shown)} more of {count(kidsTotal - shown)}</button>
            : assetTop && kidsTotal > listLen ? (
              fam.info?.state === "error" ? <p className="map-more-note">the rest did not load · <button type="button" className="linkish" onClick={() => { families?.want([], "panel"); families?.want([node.mint], "panel"); }}>retry</button></p>
              : fam.info?.state === "done" && fam.info.loaded < fam.info.total ? <p className="map-more-note">{count(listLen)} of {count(kidsTotal)} listed on this screen</p>
              : wantMore ? <p className="map-more-note">loading… {count(fam.info?.loaded ?? 0)} of {count(fam.info?.total ?? node.children)}</p>
              : <button type="button" className="map-more linkish" onClick={() => { setShown(listLen + PAGE); setWantFor(node.mint); }}>show {Math.min(PAGE, kidsTotal - listLen)} more of {count(kidsTotal - listLen)}</button>
            ) : null}
        </section>
      )}
      {coinError && !c && <p className="hint">{coinError}</p>}
    </div>
  );
}

/// The coin's family and its share of the whole map: both modes' numbers, the bar and rank in the map's size mode.
function FamilyBlock({ family, mode }: { family: Family; mode: SizeMode }) {
  const row = (mode === "mcap" ? family.mcap : family.locked) ?? family.locked ?? family.mcap;
  const locked = shareOf(family.locked), mcap = shareOf(family.mcap);
  if (!row || (locked == null && mcap == null)) return null;
  // the true size: the drawn members and the coins the map leaves out of a listed asset's family
  const size = row.members + (family.ghost ?? 0);
  return (
    <section className="map-side-dom" aria-label={`${sym(family.top)} family dominance`}>
      <DominanceLine locked={locked} mcap={mcap} mode={mode} only={mode === "mcap" ? "mcap" : undefined}
        label={<><b>{sym(family.top)}</b> family · {count(size)} coin{size === 1 ? "" : "s"} · #{count(row.rank)} of {count(family.families)}</>} />
    </section>
  );
}
