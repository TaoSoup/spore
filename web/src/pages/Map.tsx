import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useStats } from "../lib/hooks";
import { useStreamStatus } from "../lib/events";
import { ago, count, usd } from "../lib/format";
import { useMapData } from "../lib/map/use-map-data";
import { assetTopIn, coinNode, softwareGl, undrawnByTop, useFamilyNode, useFamilyStore, type FamilyTier } from "../lib/map/family";
import { useMapHeat } from "../lib/map/heat";
import { formatHl, parseHl, type HlKey } from "../lib/map/highlight";
import { LAST_ALL, LAST_DEFAULT, coinClass, formatLast, lastCounts, lastKeysOf, lastMask, lastTag, litTest, parseLast, visibleLevels, type LastCounts } from "../lib/map/visibility";
import { sinceDigest } from "../lib/map/rails";
import { DEBUG_HOOKS } from "../lib/map/debug";
import { rootCmp } from "../lib/map/nodes";
import { COMPACT_TAG_MIN, dominance, shareOf, sharePct, titleTags } from "../lib/map/dominance";
import type { BubbleNode, RootsLimit, SizeMode } from "../lib/map/types";
import { familyValueOf } from "../lib/map/sizing";
import BubbleMap, { type BubbleMapHandle } from "../components/BubbleMap";
import { launchBlock } from "../components/LaunchButton";
import { ErrorBox, NoSpawnsYet, Skeleton, nameOf, sym } from "../components/Bits";
import { LiveDot } from "../components/SpawnFeed";
import LiveNumber from "../components/LiveNumber";
import SlidingPill from "../components/ui/SlidingPill";
import SidePanel, { kidCmp, usePanelCoin } from "../components/map/panel/SidePanel";
import QuickTrade from "../components/QuickTrade";
import { isDialogOpen } from "../lib/dialog";
import type { Coin } from "../lib/api";
import type { Side } from "../lib/pump";
import { hardBlock, useTradeRoute } from "../lib/trade-route";
import { firstborns } from "../lib/map/firstborn";
import MapSearch from "../components/map/panel/MapSearch";
import Highlights, { useHighlight } from "../components/map/panel/Highlights";
import Rails from "../components/map/panel/Rails";
import MapKey from "../components/map/panel/MapKey";
import Sheet, { type SheetState } from "../components/map/panel/Sheet";
import { createCamStore, useCamK, type CamStore } from "../components/map/panel/cam";
import { useThrottled } from "../components/map/panel/util";
import { webgl2Available } from "../components/map3/probe";
import { MapBoundary, cachedFlag, fetchFlag, flagOff, forgetFailure, rememberFailure, stickyFailure } from "../components/map3/guard";
import type { FallbackReason, ThreeMapHandle, ThreeMapProps } from "../components/map3/types";

// The WebGL map (components/map3, map3 spec section 7) is its own lazy chunk: three.js and the engine load
// only on /map, starting at mount so the download runs in parallel with the map data. A chunk that fails
// to load renders ChunkFailed, which hands the page to the classic renderer.
let threeChunk: Promise<typeof import("../components/map3/ThreeMap")> | null = null;
const loadThreeMap = () => (threeChunk ??= import("../components/map3/ThreeMap"));
function ChunkFailed({ onFallback }: ThreeMapProps) {
  useEffect(() => { onFallback("chunk-load"); }, [onFallback]);
  return null;
}
const ThreeMap: ComponentType<ThreeMapProps> = lazy(() => loadThreeMap().then((m): { default: ComponentType<ThreeMapProps> } => ({ default: m.default }), (): { default: ComponentType<ThreeMapProps> } => ({ default: ChunkFailed })));

const LIMITS: RootsLimit[] = ["all", 200, 60];
/// Phones default to the top 200 roots (DESIGN §11.5); "all" stays one tap away.
const PHONE_W = 700;
/// The left column, Key and side panel dock beside the map above this width; below it they become pills and a bottom sheet.
const WIDE_W = 900;
const STATUS_LABEL = { idle: "offline", connecting: "connecting", live: "live", reconnecting: "reconnecting" } as const;
const DIGEST_MIN_AGE_MS = 10 * 60_000;
const PAN_PX = 80;
type Pop = "live" | "filters" | "key" | null;

const typing = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable); };
const isRoot = (n: BubbleNode, byMint: Map<string, BubbleNode>) => !n.parentMint || !byMint.has(n.parentMint);
/// What a screen reader hears for the depth: a depth-0 coin drawn under a listed asset (PUMP, USDC…) is "under $PUMP", not a root.
const depthWord = (n: BubbleNode, byMint: Map<string, BubbleNode>) => { if (n.depth > 0) return `d${n.depth}`; const p = n.parentMint ? byMint.get(n.parentMint) : undefined; return p ? `under ${sym(p)}` : "root"; };
const sinceWord = (ms: number) => ago(Math.floor(ms / 1000));
/// The ← / → walk over the roots: the map's own order (family value in market cap; a listed asset counts 0 there), then kidCmp.
const rootWalkCmp = (a: BubbleNode, b: BubbleNode) => (familyValueOf(b, "mcap") ?? 0) - (familyValueOf(a, "mcap") ?? 0) || kidCmp(a, b);
const countOrDash = (n: number | null | undefined) => (n == null ? "—" : count(n));
/// The map's COINS figure, exact at every size (289,168, never "289K"): it is the headline number once the asset
/// families are in, and it sits beside the site's exact count.
const exact = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US"));
/// The phone pills' glyphs (12-unit, hairline, currentColor): filters as three tapering rules (the key's: keyGlyph).
const PILL_GLYPH = {
  filters: <svg className="map-pill-glyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 3h9M3 6h6M4.6 9h2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>,
};
/// The Key pill's glyph: one dot per last-trade bucket (the Key's colours), a hidden bucket's dot drawn hollow.
const KEY_DOTS = [{ c: "#aaef56", x: 1.9, r: 1.7 }, { c: "#4d98b9", x: 5, r: 1.45 }, { c: "#666c8b", x: 7.9, r: 1.2 }, { c: "#4a514e", x: 10.5, r: 1 }];
const keyGlyph = (mask: number) => (
  <svg className="map-pill-glyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    {KEY_DOTS.map((d, i) => ((mask >> i) & 1 ? <circle key={i} cx={d.x} cy="6" r={d.r} fill={d.c} /> : <circle key={i} cx={d.x} cy="6" r={Math.max(0.8, d.r - 0.35)} fill="none" stroke={d.c} strokeWidth="0.8" />))}
  </svg>
);
/// The Key pill's badge while the last-trade filter hides something: "≤ 24 h" for a prefix of the buckets, else "2/4".
const keyBadge = (mask: number) => { const keys = lastKeysOf(mask), t = lastTag(keys); return t && t.startsWith("≤") ? t.replace(/ /g, "") : `${keys.length}/4`; };
const NO_PINS: readonly string[] = [];

/// The centred hint: fades out after the first gesture on the map, and while zoomed in past k 1.2.
function MapHint({ cam, gone, renderer }: { cam: CamStore; gone: boolean; renderer: "three" | "classic" }) {
  const k = useCamK(cam);
  return (
    <div className={`map-hint ${gone || k > 1.2 ? "gone" : ""}`} aria-hidden={gone || k > 1.2}>
      {renderer === "three"
        ? <><b>click</b> a family to open it · <b>scroll</b> to zoom · <b>drag</b> a coin · <b>/</b> search · <b>← ↑ → ↓</b> walk the tree</>
        : <><b>click</b> a cluster to open it · <b>scroll</b> to zoom · <b>/</b> search · <b>← ↑ → ↓</b> walk the tree</>}
    </div>
  );
}

/// The whole pump.fun pair ecosystem as one map (DESIGN §11.5): every root with a tracked child and every
/// descendant, rendered from the IndexedDB cache first and patched by `since=` deltas and live events.
/// URL state: `?focus=<mint>` selects a coin (the camera flies to it with its parent and children),
/// `?size=mcap` sizes by market cap instead of locked value (the on-map size pill; no param or `?size=locked` = locked), `?roots=all|200|60` picks how many root clusters are drawn, `?hl=<keys>` dims everything that does not match the highlight keys,
/// `?last=<buckets>|all` picks which last-trade buckets are drawn (the Key's toggles, lib/map/visibility.ts: `30m,3h,24h,old`;
/// no param = the default, every coin that traded in 24 h, "older" hidden; `all` = the filter off). nodes and byMint are
/// never filtered: a hidden coin is only not drawn and not pickable (the classic map hides it in place; the WebGL map is
/// rebuilt from the shown set, lib/map/visibility.ts buildSet), the ancestors of a shown coin stay as dim anchors, and the
/// selected coin and its ancestor chain are always shown. While the
/// heat sidecar has not answered (or the server has none) nothing is hidden. The left column
/// holds the counters, search, highlight chips and live rails; the selected coin opens a side panel
/// (a bottom sheet on phones). Arrow keys walk the tree; Esc clears. Each family's share of the whole map
/// (lib/map/dominance.ts, both size modes) rides on its title, its tooltip, the side panel and the
/// Dominance rail; it is recomputed from the whole set at most once a second.
/// The map itself is the WebGL renderer (components/map3) by default and draws every root on every device;
/// `?renderer=classic`, a browser without WebGL2, a chunk that fails to load, an engine that fails to
/// mount or a context lost for good fall back to the classic Canvas 2D BubbleMap (phones: top 200 roots).
export default function MapPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const focus = params.get("focus");
  const [phone] = useState(() => typeof window !== "undefined" && window.innerWidth <= PHONE_W);
  // The map's look, fixed per page load: the 2.5D colony plate ("flat") is the default; ?look=galaxy opts into the galaxy.
  const [look] = useState<"galaxy" | "flat">(() => params.get("look") === "galaxy" ? "galaxy" : "flat");
  // The renderer, decided once at mount (components/map3/guard.tsx): ?renderer=classic, no WebGL2, the kill switch's last
  // known value, a recent failure on this device; ?renderer=three overrides the last two.
  const [init] = useState((): { renderer: "three" | "classic"; fallback: FallbackReason | null; forced: boolean } => {
    const p = params.get("renderer");
    if (p === "classic") return { renderer: "classic", fallback: "param", forced: true };
    if (!webgl2Available()) return { renderer: "classic", fallback: "no-webgl2", forced: false };
    if (p === "three") { forgetFailure(); return { renderer: "three", fallback: null, forced: true }; }
    if (flagOff(cachedFlag())) return { renderer: "classic", fallback: "off", forced: false };
    if (stickyFailure()) return { renderer: "classic", fallback: "sticky", forced: false };
    return { renderer: "three", fallback: null, forced: false };
  });
  const [renderer, setRenderer] = useState<"three" | "classic">(init.renderer);
  const [fallback, setFallback] = useState<FallbackReason | null>(init.fallback);
  const onFallback = useCallback((r: FallbackReason, d?: string) => {
    console.warn("map: using the classic renderer", r, d ?? "");
    // a forced test failure (?m3fail, debug hooks only) is not a device problem
    if (typeof location === "undefined" || !location.search.includes("m3fail")) rememberFailure(r);
    setFallback(r); setRenderer("classic");
  }, []);
  useEffect(() => { if (renderer === "three") void loadThreeMap().catch(() => {}); }, [renderer]);
  // The kill switch, read once per visit (not when the URL forced a renderer or the browser cannot run WebGL2).
  useEffect(() => {
    if (init.forced || init.fallback === "no-webgl2") return;
    const ctrl = new AbortController();
    void fetchFlag(ctrl.signal).then((f) => { if (!ctrl.signal.aborted && flagOff(f) && rendererRef.current === "three") onFallback("off"); });
    return () => ctrl.abort();
  }, [init, onFallback]);
  const rendererRef = useRef(renderer); rendererRef.current = renderer;
  const fallbackRef = useRef(fallback); fallbackRef.current = fallback;
  const rootsParam = params.get("roots");
  const limit: RootsLimit = rootsParam === "all" ? "all" : rootsParam === "200" ? 200 : rootsParam === "60" ? 60 : renderer === "three" ? "all" : phone ? 200 : "all";
  // Locked value is the default, as before c515fcb; the on-map "size: locked | mcap" pill (both renderers) sets `?size=mcap`
  // (`?size=locked` reads as the default). The engine rebuilds on a switch and keeps its family order (ThreeMap BuildReason "mode").
  const mode: SizeMode = params.get("size") === "mcap" ? "mcap" : "locked";
  const hlParam = params.get("hl");
  const keys = useMemo(() => parseHl(hlParam), [hlParam]);
  // The Key's last-trade filter (`?last=`, lib/map/visibility.ts): the buckets the reader wants, as the 4-bit mask the
  // engine takes (bit k = heat class k). Not `?show=`: the server's SHOW env means something else.
  const lastParam = params.get("last");
  const lastWant = useMemo(() => lastMask(parseLast(lastParam)), [lastParam]);
  const stress = import.meta.env.DEV ? Math.min(100_000, Number(params.get("stress")) || 0) : 0;
  const map = useRef<BubbleMapHandle>(null);
  const data = useMapData({ stress });
  // The coins each listed asset's family has beyond the drawn slice, paged in on demand (lib/map/family.ts): the engine's
  // dust, the panel's list and the search box read it; its events never re-render this page per page of rows. Its caps
  // follow the engine's tier (engine/state.js, swarm.js): a map ≤ 700 px wide is a phone, a software rasteriser (read
  // from the engine's own context once its canvas is up) its own tier.
  const pageRef = useRef<HTMLDivElement>(null);
  const pageWRef = useRef(0);
  const softRef = useRef<boolean | null>(null);
  const familyTier = useCallback((): FamilyTier => {
    if (softRef.current === null) softRef.current = softwareGl(pageRef.current?.querySelector<HTMLCanvasElement>("canvas.m3-canvas"));
    if (softRef.current) return "software";
    const w = pageWRef.current || (typeof window !== "undefined" ? window.innerWidth : 0);
    return w > 0 && w <= PHONE_W ? "phone" : "desktop";
  }, []);
  const families = useFamilyStore({ byMint: data.byMint, tier: familyTier });
  const heat = useMapHeat(true);
  const { stats } = useStats();
  // The quick trade over the map (side panel Buy / Sell, the B key): the coin as it was when it opened.
  const [trade, setTrade] = useState<{ coin: Coin; side: Side } | null>(null);
  const openTrade = useCallback((side: Side, coin: Coin) => setTrade({ coin, side }), []);
  const status = useStreamStatus();
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth > WIDE_W);
  useEffect(() => { const f = () => setWide(window.innerWidth > WIDE_W); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  // `mountedAt` is taken once: the effect re-runs as the data source changes, and a fresh stamp each time would make "paint after mount" read as 0.
  const [mountedAt] = useState(() => performance.now());
  const cam = useMemo(() => createCamStore(), []);

  // The view: everything, or the subtrees of the top-n roots (server order: locked, mcap, descendants).
  // The by-mint index is the data layer's live Map (one object for the life of the page; every memo
  // below also keys on `data.nodes`, which is a new array per version).
  const allByMint = data.byMint;
  const nodes = useMemo<BubbleNode[]>(() => {
    const all = data.nodes;
    if (limit === "all") return all;
    const set = allByMint;
    const roots = all.filter((n) => !n.parentMint || !set.has(n.parentMint)).sort(rootCmp).slice(0, limit);
    const keep = new Set(roots.map((r) => r.mint));
    const rootOf = new Map<string, string>();
    const top = (n: BubbleNode) => { const hit = rootOf.get(n.mint); if (hit) return hit; let cur = n, hops = 0; while (cur.parentMint && set.has(cur.parentMint) && hops++ < 8) cur = set.get(cur.parentMint)!; rootOf.set(n.mint, cur.mint); return cur.mint; };
    return all.filter((n) => keep.has(top(n)));
  }, [data.nodes, allByMint, limit]);
  const byMint = useMemo(() => (nodes === data.nodes ? allByMint : new Map(nodes.map((n) => [n.mint, n]))), [nodes, data.nodes, allByMint]);
  // Children of one coin among the drawn nodes, in the children-list order: one O(n) pass, only for the
  // selected coin (per version) and on an arrow key, never an index of the whole set per live event.
  const kidsOf = useCallback((mint: string) => nodes.filter((n) => n.parentMint === mint).sort(kidCmp), [nodes]);
  // A focus the drawn set does not hold (DESIGN-FAMILY-ALL §6): the family store's node once its family is loaded, else a
  // pending node from the search pick or the light /api/coin when the coin is quoted in an asset drawn as a family top.
  // /api/coin is asked for any focus: it is the panel's trading numbers, and what tells such a coin from one that is
  // not on the map at all.
  const offMap = focus && !allByMint.has(focus) ? focus : null;
  const famNode = useFamilyNode(families, offMap);
  const panel = usePanelCoin(focus);
  // The selected coin's trade route (lib/trade-route): the side panel's Buy / Sell row and the B key read the same answer.
  const tradeRoute = useTradeRoute(panel.coin && panel.coin.mint === focus ? panel.coin : null);
  const tradeOk = !!tradeRoute.data && !!focus && tradeRoute.data.coins[0]?.mint === focus && !hardBlock(tradeRoute.data);
  const [picked, setPicked] = useState<BubbleNode | null>(null);
  const pending = useMemo(() => {
    if (!offMap) return null;
    if (picked && picked.mint === offMap) return picked;
    const c = panel.coin;
    const top = c && c.mint === offMap ? assetTopIn(allByMint, c.quoteMint) : null;
    return c && top ? coinNode(c, top.mint) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offMap, picked, panel.coin, allByMint, data.version]);
  const selected = focus ? byMint.get(focus) ?? famNode ?? pending ?? null : null;
  // such a selection keeps its family wanted ("select"): it loads, then stays out of the LRU while selected; past the
  // family's cap (phones: 20k rows) the store seeks that one coin, so the engine still draws it and flies there
  const selTop = offMap ? families.familyOf(offMap) ?? pending?.parentMint ?? null : null;
  useEffect(() => { families.want(selTop ? [selTop] : [], "select"); families.seek(selTop ? offMap : null, selTop); }, [families, selTop, offMap]);
  const kids = useMemo(() => (selected ? kidsOf(selected.mint) : []), [selected, kidsOf]);
  // The selected coin's lineage, itself first and its family top last (the family block's top, and the filter's pins).
  const lineage = useMemo(() => {
    if (!selected) return null;
    const out = [selected];
    let cur = selected;
    for (let hops = 0; cur.parentMint && hops < 16; hops++) { const p = allByMint.get(cur.parentMint); if (!p || p === cur) break; out.push(p); cur = p; }
    return out;
  }, [selected, allByMint]);
  const famTop = lineage ? lineage[lineage.length - 1] : null;

  // ---- the last-trade filter. The effective mask is all four (the filter off) until the heat sidecar has answered, so
  // the map never goes blank. Pins: the selected coin and its ancestor chain, always shown; one array per selection
  // (keyed on the mints, not on the node objects that change with every data version), so the engine is told once.
  const lastEff = heat ? lastWant : LAST_ALL;
  const pinKey = lineage ? lineage.map((n) => n.mint).join(",") : focus ?? "";
  const pinned = useMemo(() => (pinKey ? pinKey.split(",") : NO_PINS), [pinKey]);
  // The page's own copy of the levels (the classic map draws from it; the arrow walk, the chip counts and the Key read it),
  // at most every 2 s as the nodes and the heat change, and at once on a filter change; the pins are applied on top (the
  // classic map's bits, the arrow walk), so a selection costs no O(n) pass here. The WebGL engine keeps its own levels,
  // live per trade (setLastFilter).
  const visNodes = useThrottled(nodes, 2_000);
  const visHeat = useThrottled(heat, 2_000);
  const visByMint = useThrottled(byMint, 2_000); // a new Map per version under a roots limit
  const levels = useMemo(() => visibleLevels(visNodes, visByMint, lastEff, visHeat), [visNodes, visByMint, lastEff, visHeat]);
  // the highlight chips count what lights up: shown coins and the pins (an anchor is drawn dim even when it matches)
  const lit = useMemo(() => litTest(levels, pinned), [levels, pinned]);
  // Bucket counts for the Key (the drawn coins, plus every asset family's undrawn ones, which have no heat: "older").
  const lastCnt = useMemo<LastCounts | null>(() => (visHeat ? lastCounts(visNodes, visHeat) : null), [visNodes, visHeat]);
  const hl = useHighlight(nodes, byMint, keys, data.seenAt, heat, lit);

  // Counts from what is actually drawn, so the numbers match the picture; "new pairs" from the same set. `total` is the
  // map's true size: the drawn coins plus every asset family's undrawn ones (familyTotal = nodes + Σ ghost, the server's
  // `indexed`). COINS shows the pump.fun coins in it: the listed assets drawn as family tops (USDC, WBTC, a tokenized
  // stock …) are not coins of the index the site's own counter reports, so they are left out of the headline.
  const ghosts = useMemo(() => undrawnByTop(nodes, byMint), [nodes, byMint]);
  const drawn = useMemo(() => {
    let roots = 0, fresh24 = 0, ghost = 0, assets = 0, locked = 0;
    for (const g of ghosts.values()) ghost += g;
    const from = Math.floor(Date.now() / 1000) - 86_400;
    for (const n of nodes) {
      if (n.asset === true) assets++;
      // a coin's lockedUsd is what its direct children lock in their curves, so the sum over the drawn coins is the map's total
      if (n.lockedUsd != null && n.lockedUsd > 0) locked += n.lockedUsd;
      if (!n.parentMint || !byMint.has(n.parentMint)) roots++;
      else if ((n.createdAt ?? 0) >= from) fresh24++;
    }
    const total = nodes.length + ghost;
    return { roots, total, coins: total - assets, assets, ghost, fresh24, locked };
  }, [nodes, byMint, ghosts]);
  const coinsTitle = `${exact(drawn.coins)} pump.fun coins on the map: ${exact(drawn.coins - drawn.ghost)} drawn and ${exact(drawn.ghost)} more in the listed assets' families${drawn.assets > 0 ? `; the ${exact(drawn.assets)} listed assets drawn as family tops (USDC, WBTC, …) are not counted` : ""}`;
  const keyCounts = useMemo<LastCounts | null>(() => (lastCnt ? [lastCnt[0], lastCnt[1], lastCnt[2], lastCnt[3] + drawn.ghost] : null), [lastCnt, drawn.ghost]);
  // the selected coin's own bucket is off (it is drawn only because it is selected): the side panel says so
  const selHidden = !!selected && !!heat && lastEff !== LAST_ALL && !((lastEff >> coinClass(selected, heat)) & 1);
  const tradesPerMin = useMemo(() => { if (!heat) return null; let t = 0; for (const r of heat.rows.values()) t += r.t1h; return t / 60; }, [heat]);
  // Dominance: every family's share of the whole map (all roots, whatever the roots limit draws), both
  // modes, from one family pass (~3 ms at 17 k coins), at most once a second while the stream patches.
  const domNodes = useThrottled(data.nodes, 1_000);
  const dom = useMemo(() => (domNodes.length ? dominance(domNodes) : null), [domNodes]);
  // First children of their parent, from the full list (O(n), cached per array); the rails compute their own from the same array.
  const firstborn = useMemo(() => firstborns(data.nodes), [data.nodes]);
  const tags = useMemo(() => titleTags(dom?.[mode]), [dom, mode]);
  const tagsCompact = useMemo(() => titleTags(dom?.[mode], COMPACT_TAG_MIN), [dom, mode]);
  const family = useMemo(() => (famTop && dom ? { top: famTop, locked: dom.locked.byTop.get(famTop.mint) ?? null, mcap: dom.mcap.byTop.get(famTop.mint) ?? null, families: dom.locked.ranked.length, ghost: ghosts.get(famTop.mint) ?? 0 } : null), [famTop, dom, ghosts]);
  const clusterInfo = useCallback((top: string) => {
    const m = shareOf(dom?.[mode].byTop.get(top));
    if (m == null) return null;
    const cur = m;
    return (
      <>
        <div className="bm-tip-row"><em>dominance</em><strong><span className="cur">{sharePct(m)}</span> of {mode === "locked" ? "locked value" : "market cap"}</strong></div>
        <div className="bm-tip-bar" aria-hidden="true">{cur > 0 && <i style={{ width: `${Math.min(100, cur * 100)}%` }} />}</div>
      </>
    );
  }, [dom, mode]);
  const seenAt = data.seenAt;
  const digestNodes = useThrottled(data.nodes, 3_000);
  const digest = useMemo(() => (seenAt != null && Date.now() - seenAt > DIGEST_MIN_AGE_MS ? sinceDigest(digestNodes, new Map(digestNodes.map((n) => [n.mint, n])), Math.floor(seenAt / 1000)) : null), [seenAt, digestNodes]);

  useEffect(() => { document.title = "Map · Spore"; return () => { document.title = "Spore"; }; }, []);

  // ---- URL writers (replace: the map's state is not history)
  const limitRef = useRef(limit); limitRef.current = limit;
  const viewRef = useRef(byMint); viewRef.current = byMint;
  const allRef = useRef(allByMint); allRef.current = allByMint;
  const select = useCallback((mint: string | null) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (!mint) { n.delete("focus"); return n; }
      n.set("focus", mint);
      // A coin outside the drawn roots: draw everything first (the widen path frames it once it is there).
      if (limitRef.current !== "all" && !viewRef.current.has(mint) && allRef.current.has(mint)) n.set("roots", "all");
      return n;
    }, { replace: true });
  }, [setParams]);
  const setLimit = useCallback((l: RootsLimit) => setParams((p) => { const n = new URLSearchParams(p); n.set("roots", String(l)); return n; }, { replace: true }), [setParams]);
  const setMode = useCallback((m: SizeMode) => setParams((p) => { const n = new URLSearchParams(p); if (m === "mcap") n.set("size", "mcap"); else n.delete("size"); return n; }, { replace: true }), [setParams]);
  const setKeys = useCallback((ks: HlKey[]) => setParams((p) => { const n = new URLSearchParams(p); const v = formatHl(ks); if (v) n.set("hl", v); else n.delete("hl"); return n; }, { replace: true }), [setParams]);
  const toggleKey = useCallback((k: HlKey) => setKeys(keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k]), [keys, setKeys]);
  // The Key's last-trade buckets: the default deletes the param, all four write `last=all` (formatLast). A function gets the
  // mask in the URL as it is now, not the render's: a second click or K before the page re-rendered toggles from the first
  // one's result (the router's functional update reads the render's params; BrowserRouter writes the URL synchronously).
  const setLast = useCallback((next: number | ((cur: number) => number)) => setParams((p) => {
    const mask = typeof next === "function" ? next(lastMask(parseLast(new URLSearchParams(window.location.search).get("last")))) : next;
    const n = new URLSearchParams(p); const v = formatLast(lastKeysOf(mask & LAST_ALL)); if (v) n.set("last", v); else n.delete("last"); return n;
  }, { replace: true }), [setParams]);
  const showAllLast = useCallback(() => setLast(LAST_ALL), [setLast]);
  const onSelect = useCallback((n: BubbleNode | null) => select(n?.mint ?? null), [select]);
  const [pop, setPop] = useState<Pop>(null);
  // A pick (a pasted mint, a search result, a rail row) of the coin already in ?focus flies and highlights it again: the
  // URL does not change, so the map's select echo would not act; the handle's focusNode is the same select(m, {fly}).
  const focusRef = useRef(focus); focusRef.current = focus;
  // A pick the drawn set does not hold (a loaded speck, an asset-quoted search hit) is kept as the pending selection.
  const pickNode = useCallback((n: BubbleNode) => { if (!allRef.current.has(n.mint)) setPicked(n); if (focusRef.current === n.mint) map.current?.focusNode(n.mint); else select(n.mint); setPop(null); }, [select]);
  // A Dominance row: fly to the whole family and select its top (the cluster click's flight); a family
  // outside the drawn roots is selected instead, which widens to everything and flies there.
  const pickFamily = useCallback((mint: string) => { setPop(null); if (viewRef.current.has(mint)) map.current?.fitCluster(mint); else select(mint); }, [select]);
  const hoverNode = useCallback((mint: string | null) => map.current?.hoverNode(mint), []);

  // A focus mint outside the drawn roots: widen to everything once, so a deep link to a small tree still
  // lands. Only once the set has loaded and only when the full set has the coin (else the toast explains).
  const widened = useRef(false);
  useEffect(() => {
    if (!focus || limit === "all" || widened.current) return;
    if (data.nodes.length === 0 || byMint.has(focus) || !allByMint.has(focus)) return;
    widened.current = true;
    setLimit("all");
  }, [focus, limit, data.nodes.length, byMint, allByMint, setLimit]);

  // ---- the hint goes away after the first gesture on the canvas (pageRef: the page, above)
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    const el = pageRef.current;
    if (!el || touched) return;
    const f = (e: Event) => { if ((e.target as Element | null)?.closest?.(".bm-canvas, .m3-canvas")) setTouched(true); };
    el.addEventListener("pointerdown", f, { capture: true, passive: true });
    el.addEventListener("wheel", f, { capture: true, passive: true });
    return () => { el.removeEventListener("pointerdown", f, { capture: true }); el.removeEventListener("wheel", f, { capture: true }); };
  }, [touched]);

  // ---- measured insets: what the overlays cover, so fits and flights centre in what is visible
  const overlayRef = useRef<HTMLDivElement>(null);
  const [ov, setOv] = useState({ right: 336, bottom: 0 });
  useLayoutEffect(() => {
    const el = overlayRef.current, page = pageRef.current;
    if (!el || !page || typeof ResizeObserver === "undefined") return;
    const measure = () => { const r = el.getBoundingClientRect(), p = page.getBoundingClientRect(); pageWRef.current = Math.round(p.width); const next = { right: Math.round(r.right - p.left), bottom: Math.round(r.bottom - p.top) }; setOv((o) => (o.right === next.right && o.bottom === next.bottom ? o : next)); };
    const ro = new ResizeObserver(measure);
    ro.observe(el); ro.observe(page);
    measure();
    return () => ro.disconnect();
  }, []);
  const [sideW, setSideW] = useState(340);
  const sideRo = useRef<ResizeObserver | null>(null);
  const sideRef = useCallback((el: HTMLElement | null) => {
    sideRo.current?.disconnect(); sideRo.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSideW(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el); sideRo.current = ro;
  }, []);
  const [sheet, setSheet] = useState<SheetState>("peek");
  const sheetRef = useRef(sheet); sheetRef.current = sheet;
  const [peekH, setPeekH] = useState(170);
  useEffect(() => setSheet("peek"), [focus]);
  const onSheetHeight = useCallback((h: number) => { if (sheetRef.current === "peek" && h > 0) setPeekH(h); }, []);
  const hasSel = !!selected;
  // Desktop: the column's right edge and the side panel's width. Phone: the overlay's bottom and the
  // sheet's peek height (a full sheet covers the map anyway, so the camera keeps the peek framing).
  const edge = wide ? ov.right : ov.bottom, side = wide ? sideW : peekH;
  const inset = useMemo(() => (wide
    ? { left: edge + 12, top: 16, bottom: 16, right: hasSel ? side + 28 : 16 }
    : { top: edge + 8, bottom: hasSel ? side + 8 : 56 }), [wide, edge, hasSel, side]);
  // The WebGL map's overview fit ignores the side panel and the sheet: "fit" frames the whole map in the
  // area the left column (or the phone overlay) leaves, whatever is selected.
  const fitInset = useMemo(() => (wide ? { left: edge + 12, top: 16, bottom: 16, right: 16 } : { top: edge + 8, bottom: 56 }), [wide, edge]);

  // ---- keyboard: walk the tree, open, launch, frame; zoom and pan without a selection
  // The last-trade filter's part: ↓ ← → step only onto coins the map draws (shown, anchors, the pins); ↑ may climb to a
  // hidden parent, which the selection then pins. K toggles the filter between the default and everything.
  const keyState = useRef({ selected, byMint, kidsOf, nodes, maxDepth: stats?.maxDepth, mayhem: panel.coin?.mayhem, coin: panel.coin, tradeOk, pop, focus, levels, pinned, lastWant, heatOn: !!heat });
  keyState.current = { selected, byMint, kidsOf, nodes, maxDepth: stats?.maxDepth, mayhem: panel.coin?.mayhem, coin: panel.coin, tradeOk, pop, focus, levels, pinned, lastWant, heatOn: !!heat };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog (the quick trade, a confirm sheet) owns the keyboard: arrows, L or B must not act on the map behind it.
      if (isDialogOpen()) return;
      const s = keyState.current;
      if (e.key === "Escape") { if (s.pop) setPop(null); else if (s.focus) select(null); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || typing(e.target)) return;
      const m = map.current;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const onControl = tag === "BUTTON" || tag === "A";
      const n = s.selected;
      const lv = s.levels;
      const drawnCoin = (x: BubbleNode) => !lv || x === n || lv.has(x.mint) || s.pinned.includes(x.mint);
      let handled = true;
      if (e.key === "0") m?.fit();
      else if (e.key === "+" || e.key === "=") m?.scaleBy(1.5);
      else if (e.key === "-" || e.key === "_") m?.scaleBy(1 / 1.5);
      else if ((e.key === "k" || e.key === "K") && s.heatOn) setLast((cur) => (cur === LAST_ALL ? lastMask(LAST_DEFAULT) : LAST_ALL));
      else if (n) {
        const siblings = () => (n.parentMint && s.byMint.has(n.parentMint) ? s.kidsOf(n.parentMint) : s.nodes.filter((x) => isRoot(x, s.byMint)).sort(rootWalkCmp));
        if (e.key === "ArrowUp") { if (n.parentMint && s.byMint.has(n.parentMint)) select(n.parentMint); }
        else if (e.key === "ArrowDown") { const k = s.kidsOf(n.mint).find(drawnCoin); if (k) select(k.mint); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const all = siblings(), sib = lv ? all.filter(drawnCoin) : all; const i = sib.findIndex((x) => x.mint === n.mint);
          if (sib.length > 1 && i >= 0) select(sib[(i + (e.key === "ArrowRight" ? 1 : sib.length - 1)) % sib.length].mint);
        }
        else if (e.key === "Enter" && !onControl) nav(`/c/${n.mint}`);
        else if (e.key === "l" || e.key === "L") { if (!launchBlock({ depth: n.depth, mayhem: s.mayhem }, s.maxDepth)) nav(`/launch?parent=${n.mint}`); }
        else if (e.key === "b" || e.key === "B") { if (s.coin && s.coin.mint === n.mint && s.tradeOk) openTrade("buy", s.coin); }
        else if (e.key === "f" || e.key === "F") { let r = n; for (let h = 0; r.parentMint && s.byMint.has(r.parentMint) && h < 12; h++) r = s.byMint.get(r.parentMint)!; m?.fitCluster(r.mint, { select: false }); }
        else handled = false;
      }
      else if (e.key === "ArrowLeft") m?.panBy(-PAN_PX, 0);
      else if (e.key === "ArrowRight") m?.panBy(PAN_PX, 0);
      else if (e.key === "ArrowUp") m?.panBy(0, -PAN_PX);
      else if (e.key === "ArrowDown") m?.panBy(0, PAN_PX);
      else handled = false;
      if (handled) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [select, nav, setLast, openTrade]);
  const announce = selected ? `${nameOf(selected)}, ${sym(selected)}, ${depthWord(selected, allByMint)}, ${count(selected.children)} ${selected.children === 1 ? "child" : "children"}` : "";

  // ---- debug hooks for the headless QA scripts
  const lastDbg = { want: lastWant, eff: lastEff, counts: keyCounts, levels, pinned };
  const dbg = useRef({ counts: hl.counts, inset, keys, dom, total: drawn.total, coins: drawn.coins, indexed: data.indexed, families, renders: 0, last: lastDbg });
  dbg.current = { counts: hl.counts, inset, keys, dom, total: drawn.total, coins: drawn.coins, indexed: data.indexed, families, renders: dbg.current.renders + 1, last: lastDbg };
  useEffect(() => {
    if (!DEBUG_HOOKS) return;
    const w = window as unknown as { __sporeMapPage?: unknown };
    const hooks = { mountedAt, source: () => data.source, total: () => data.total, cacheInfo: () => data.cacheInfo, generatedAt: () => data.generatedAt, sync: data.reload, hlCounts: () => dbg.current.counts, hl: () => dbg.current.keys, inset: () => dbg.current.inset, seenAt: () => data.seenAt,
      /// family shares as the page computed them: total and the top-n per mode (mint, symbol, share, members)
      dominance: (n = 20) => { const d = dbg.current.dom; if (!d) return null; const t = (m: "locked" | "mcap") => ({ total: d[m].total, families: d[m].ranked.length, sum: d[m].ranked.reduce((a, r) => a + r.share, 0), top: d[m].ranked.slice(0, n).map((r) => ({ mint: r.node.mint, symbol: r.node.symbol, share: r.share, value: r.value, members: r.members })) }); return { locked: t("locked"), mcap: t("mcap") }; },
      /// which map is drawn ("three" | "classic") and why the classic one is (null while the WebGL map runs)
      renderer: () => rendererRef.current, fallback: () => fallbackRef.current,
      /// the map's true size as the page derives it (drawn + Σ ghost), the server's last `indexed`, and the header's COINS
      /// (the same less the listed assets drawn as family tops)
      indexed: () => ({ derived: dbg.current.total, server: dbg.current.indexed, shown: dbg.current.coins }),
      /// the family store: wants, families held, pages, evictions, per-page ms
      families: () => dbg.current.families.stats(),
      /// how often this page rendered (QA: a family's pages must not re-render it)
      renders: () => dbg.current.renders,
      /// the Key's last-trade filter as the page sees it: the buckets asked for (keys, mask), the mask in force (15 until
      /// the heat answers), the bucket counts [30 min, 3 h, 24 h, older] (+ the undrawn asset coins in "older"), the
      /// shown / anchor / hidden counts of the page's own levels (null levels = nothing hidden) and the pins
      last: () => {
        const l = dbg.current.last, lv = l.levels;
        let shown = 0, anchors = 0;
        if (lv) for (const v of lv.values()) { if (v === "shown") shown++; else anchors++; }
        const total = dbg.current.total;
        return { keys: lastKeysOf(l.want), mask: l.want, eff: l.eff, counts: l.counts, levels: lv ? { shown, anchors, hidden: Math.max(0, total - shown - anchors) } : null, pinned: [...l.pinned] };
      },
      /// the page's level of one coin under the filter in force ("shown" | "anchor" | "hidden"; pins count as shown)
      level: (mint: string) => { const l = dbg.current.last; if (!l.levels || l.pinned.includes(mint)) return "shown"; return l.levels.get(mint) ?? "hidden"; } };
    w.__sporeMapPage = hooks;
    return () => { if (w.__sporeMapPage === hooks) delete w.__sporeMapPage; };
  }, [mountedAt, data.source, data.total, data.cacheInfo, data.generatedAt, data.reload, data.seenAt]);

  const ready = !data.loading || data.nodes.length > 0;
  const heatRow = selected && heat ? heat.rows.get(selected.mint) ?? null : null;
  const rootsSeg = (
    <div className="map-tools">
      <span className="tools-label">roots</span>
      <div className="seg" role="group" aria-label="How many roots to draw"><SlidingPill />{LIMITS.map((l) => <button type="button" key={l} aria-pressed={limit === l} onClick={() => setLimit(l)}>{l === "all" ? "all" : `top ${l}`}</button>)}</div>
    </div>
  );
  const heatLine = <p className="map-heatline"><span className="map-heat-i"><i className="map-heat-glyph g-new" aria-hidden="true" /><b>{count(drawn.fresh24)}</b> new pairs 24h</span>{tradesPerMin != null && <><span className="map-heat-sep" aria-hidden="true"> · </span><span className="map-heat-i"><i className="map-heat-glyph g-trades" aria-hidden="true" /><b>{tradesPerMin >= 10 ? Math.round(tradesPerMin) : tradesPerMin.toFixed(1)}</b> trades/min</span></>}</p>;
  const digestChip = digest && digest.pairs > 0 && seenAt != null ? (
    <button type="button" className="map-digest" aria-pressed={keys.includes("since")} onClick={() => toggleKey("since")} title="Highlight the pairs created since your last visit">
      <b>{count(digest.pairs)}</b> new pair{digest.pairs === 1 ? "" : "s"} since {sinceWord(seenAt)}{digest.top[0] && <> · {sym(digest.top[0].node)} <span className="good">+{count(digest.top[0].metric)}</span></>}
    </button>
  ) : null;
  const highlights = <Highlights keys={keys} onKeys={setKeys} counts={hl.counts} seenAt={seenAt} heatOn={!!heat}>{rootsSeg}</Highlights>;
  const rails = (variant: "card" | "pop") => <Rails nodes={data.nodes} byMint={allByMint} recent={data.recent} heat={heat} version={data.version} onPick={pickNode} onHover={hoverNode} dom={dom} mode={mode} onPickFamily={pickFamily} variant={variant} />;
  const worldRadius = useCallback((v: number) => map.current?.worldRadius(v) ?? 0, []);
  const chipRadius = useCallback((s: number) => (map.current as Partial<ThreeMapHandle> | null)?.chipRadius?.(s) ?? 0, []);
  const keyChip = renderer === "three" ? chipRadius : null;
  const panelProps = selected ? { node: selected, byMint: allByMint, kids, coin: panel.coin, coinError: panel.error, heat: heatRow, heatOn: !!heat, maxDepth: stats?.maxDepth, map, onPick: select, onClose: () => select(null), family, mode, firstborn, families, lastHidden: selHidden, onShowAll: showAllLast, solUsd: stats?.solUsd ?? null, onTrade: openTrade, trade: { data: tradeRoute.data, error: tradeRoute.error, reload: tradeRoute.reload } } : null;
  // the lead's one line on the filter (only while it hides something): the default reads as "no trade in 24 h"
  const lastOn = !!heat && lastWant !== LAST_ALL;
  const lastLead = lastOn ? (lastWant === lastMask(LAST_DEFAULT) ? " Coins with no trade in 24 h are hidden by default; the Key brings them back." : " Some last-trade buckets are hidden; the Key brings them back.") : "";
  const keyProps = { mode, cam, worldRadius, renderer, chipRadius: keyChip, look, last: lastWant, onLast: setLast, counts: keyCounts, heatOn: !!heat };

  return (
    <div ref={pageRef} className={`map-page ${selected ? "has-side" : ""} ${wide ? "wide" : "narrow"}`}>
      {!ready && !data.error && <div className="map-state"><Skeleton h={600} r={0} style={{ height: "100%" }} /></div>}
      {data.error && data.nodes.length === 0 && <div className="map-state"><ErrorBox error={data.error} retry={data.reload} /></div>}
      {ready && !data.error && nodes.length === 0 && <div className="map-state launch"><NoSpawnsYet hint="The map draws every root coin a pair was opened under on pump.fun and the coins beneath it. It fills in as pairs appear." /></div>}
      {nodes.length > 0 && (renderer === "three" ? (
        <MapBoundary onError={(d) => onFallback("mount-error", d)}><Suspense fallback={<div className="bm bm-full" aria-busy="true" />}>
          <ThreeMap ref={map} nodes={nodes} byMint={byMint} limit={limit} source={data.source} mode={mode} onModeChange={setMode} inset={inset} fitInset={fitInset} select={focus} onSelect={onSelect}
            fresh={data.fresh} highlight={hl.predicate} heat={heat} streamStatus={status} onCamera={cam.set} titleTags={tags} titleTagsCompact={tagsCompact} onFallback={onFallback} look={look} families={families} last={lastEff} lastWant={lastWant} pinned={pinned} />
        </Suspense></MapBoundary>
      ) : (
        <BubbleMap ref={map} nodes={nodes} height="100%" mode={mode} onModeChange={setMode} className="bm-full" inset={inset} select={focus} onSelect={onSelect}
          fresh={data.fresh} onLayout={data.persistPositions} highlight={hl.predicate} live heat={heat} hideLegend onCamera={cam.set} titleTags={tags} titleTagsCompact={tagsCompact} clusterInfo={clusterInfo} visible={levels} last={lastEff} pinned={pinned} />
      ))}
      <div className="map-overlay" ref={overlayRef}>
        {wide ? (
          <div className="map-panel card">
            <div className="map-panel-top">
              <span className="map-eyebrow">pair ecosystem · {limit === "all" ? "all roots" : `top ${limit} roots`}</span>
              <span className={`map-live is-${status}`}><LiveDot short /> {STATUS_LABEL[status]}</span>
            </div>
            <h1>Ecosystem <em>map</em></h1>
            {renderer === "three"
              ? <p className="lead">Each colony is a root coin and every pair under it. A family's chip is sized by its share of {mode === "locked" ? "locked value" : "market cap"}; the coins inside are sized by {mode === "locked" ? "the value they lock" : "market cap"}. Colour is the last trade, lime within 30 min; the rim's bright arc counts trades in 24 h. A pulse runs along a link when a coin trades and a ring marks a new pair. Drag a coin and the map flows around it.{lastLead}</p>
              : <p className="lead">Clusters are root coins and every pair under them. The big bubble in the middle is the root: its size is the whole family. Every other bubble is sized by {mode === "locked" ? "the value it locks" : "its own market cap"}. Rings flash on trades; dots flow on pairs that traded in the last 30 min. Lime ring = launched on Spore.{lastLead}</p>}
            <div className="map-stats">
              <div><em>roots</em><strong><LiveNumber value={ready ? drawn.roots : null} format={countOrDash} kind="count" /></strong></div>
              <div><em>coins</em><strong title={ready ? coinsTitle : undefined}><LiveNumber value={ready ? drawn.coins : null} format={exact} kind="count" /></strong></div>
              <div><em>locked</em><strong className="accent" title="value locked in the curves of the drawn coins' children">{ready ? usd(drawn.locked) : "—"}</strong></div>
            </div>
            {ready && heatLine}
            {digestChip}
            {(data.syncing || data.error) && data.nodes.length > 0 && <p className="map-sync">{data.error ? <>update failed · <button type="button" className="linkish" onClick={data.reload}>retry</button></> : data.source === "cache" ? "from cache · fetching what changed…" : "fetching what changed…"}</p>}
          </div>
        ) : (
          // Phones: one stats line (and the roots note), nothing transient, so the measured inset (and with it
          // the camera) does not jump while the data syncs.
          <div className="map-panel card compact">
            <h1 className="map-sr">Ecosystem map</h1>
            <p className="map-line" title={`stream ${STATUS_LABEL[status]}`}><LiveDot short /><span><b>{ready ? count(drawn.roots) : "—"}</b> roots<i className="map-line-sep" aria-hidden="true" /><b title={ready ? coinsTitle : undefined}>{ready ? exact(drawn.coins) : "—"}</b> coins<i className="map-line-sep" aria-hidden="true" /><b className="accent">{ready ? usd(drawn.locked) : "—"}</b> locked</span></p>
            {phone && limit !== "all" && <p className="map-line sub">top {limit} roots on this screen · <button type="button" className="linkish" onClick={() => setLimit("all")}>show all {count(data.total)}</button></p>}
            {data.error && data.nodes.length > 0 && <p className="map-line sub">update failed · <button type="button" className="linkish" onClick={data.reload}>retry</button></p>}
          </div>
        )}
        <MapSearch nodes={data.nodes} byMint={allByMint} onPick={pickNode} families={families} />
        {wide ? <>{highlights}{rails("card")}</> : (
          <div className="map-pills" role="group" aria-label="Map panels">
            <button type="button" className="map-pill" aria-expanded={pop === "live"} onClick={() => setPop((p) => (p === "live" ? null : "live"))}><LiveDot short /> Live</button>
            <button type="button" className="map-pill" aria-expanded={pop === "filters"} onClick={() => setPop((p) => (p === "filters" ? null : "filters"))}>{PILL_GLYPH.filters}Filters{keys.length > 0 && <b>{keys.length}</b>}</button>
            <button type="button" className="map-pill" aria-expanded={pop === "key"} onClick={() => setPop((p) => (p === "key" ? null : "key"))} title={lastOn ? `Key · last trade: ${lastKeysOf(lastWant).length} of 4 buckets shown` : undefined}>{keyGlyph(heat ? lastWant : LAST_ALL)}Key{lastOn && <b>{keyBadge(lastWant)}</b>}</button>
          </div>
        )}
        {!wide && pop && (
          <div className={`map-pop card is-${pop}`} role="dialog" aria-label={pop === "live" ? "Live rails" : pop === "filters" ? "Filters" : "Key"}>
            <button type="button" className="map-pop-close" aria-label="Close" onClick={() => setPop(null)}>×</button>
            {pop === "live" ? <>{ready && heatLine}{rails("pop")}</> : pop === "filters" ? <>{digestChip}{highlights}</> : <MapKey {...keyProps} variant="pop" />}
          </div>
        )}
      </div>
      {wide && <MapKey {...keyProps} />}
      {panelProps && (wide
        ? <aside ref={sideRef} className="map-side card" aria-label={`${nameOf(panelProps.node)} details`}><SidePanel {...panelProps} /></aside>
        : <Sheet state={sheet} onState={setSheet} onClose={() => select(null)} onHeight={onSheetHeight} label={`${nameOf(panelProps.node)} details`}><SidePanel {...panelProps} peek={sheet === "peek"} /></Sheet>)}
      {/* only once /api/coin answered: a coin quoted in an on-map asset is not "off the map", it is a speck of that family */}
      {focus && ready && !selected && !data.loading && !data.syncing && !allByMint.has(focus) && !!(panel.coin || panel.error) && !families.familyOf(focus) && <div className="map-toast">That coin is not on the map yet. <Link to={`/c/${focus}`}>Open its page</Link> · <button type="button" className="linkish" onClick={() => select(null)}>dismiss</button></div>}
      <MapHint cam={cam} gone={touched} renderer={renderer} />
      <div className="map-sr" aria-live="polite" aria-atomic="true">{announce}</div>
      {trade && <QuickTrade coin={trade.coin} side={trade.side} solUsd={stats?.solUsd ?? null} onClose={() => setTrade(null)} />}
    </div>
  );
}
