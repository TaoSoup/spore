// Bubblemaps-style map on a canvas, built for the whole pump.fun pair tree (DESIGN §11.5).
//
// Architecture (performance budget: ≤ 16 ms/frame settled, ≤ 33 ms settling at 20 k nodes):
// - Layout: d3-force in a Web Worker (map/layout.worker.ts), as the first launch had it. It runs for a
//   cold open without cached positions, an explicit relayout (the size-mode change) and every drag, and
//   sleeps (posts nothing) once alpha falls under its minimum. While it runs the main thread receives
//   positions as transferred Float32Arrays; buffers are returned after each frame, so nothing is
//   allocated on either side, and the draw loop interpolates between the last two worker frames
//   (store.tickAt / tickDt). Clusters are placed once with d3.packSiblings (one circle per root); a root
//   that arrives later gets a spot on the periphery, never a re-pack. Each family's top is pulled to its
//   cluster centre and every member is kept outside the top's disc.
// - Sizes (lib/map/sizing.ts, owner 2026-10-19 "like Bubblemaps"): a family top (a SOL root or a listed
//   asset) is drawn by its family value in the size mode, area ∝ value on one scale for the whole map, so
//   it is the biggest bubble of its tree (≥ 1.5× its largest member) and its size compares trees; every
//   other coin by its own market cap, the same in both modes. The coin page (focus) sizes this coin and
//   its ancestors by their value in the mode and every coin under it by its own market cap.
// - Store: structure-of-arrays (map/store.ts): x/y/r in Float32Arrays, flags/colour/depth in byte
//   arrays, draw order as an Int32Array sorted by radius (family tops after everything else), CSR
//   child lists for hover highlighting, per-cluster title anchors (centroid, enclosing radius, top
//   edge) and hull polygons of the 60 largest clusters in preallocated arrays (refreshed on worker
//   frames, not per draw), and the live activity per node (`lastTrade` epoch ms, `t1h` trades in the
//   last hour).
// - Draw (map/draw.ts): offscreen culling, three tiers by on-screen radius (specks batched into a
//   few Path2D fills, shared sprites per colour+size, per-node sprites with the glow baked in and the
//   logo once it loads), links batched per colour and skipped into specks, labels from cached bitmaps
//   for every bubble ≥ 9 px (overlap-culled, cap 160), cluster titles at overview zoom (on /map followed
//   by the family's dominance where it fits, lib/map/dominance.ts via titleTags), Spore beacons,
//   hulls that fade out as you zoom in, zero per-node allocation. Sprite economy: shared letter
//   sprites, and a per-frame build budget (smaller during a wheel or pinch gesture, which this file
//   signals through `zoomingUntil`) with the last sprite scaled meanwhile.
// - Camera (map/camera.ts): every programmatic move is a flight on the van Wijk zoom-and-pan path
//   (fit, +/−, cluster click, selection with its parent and children in frame); a follow keeps a still-
//   moving node centred after landing; any user wheel/drag/pinch cancels it. A cold open starts at the
//   fit of the initial placement, so the first frame is never the k = 1 view of a 16 k-node forest.
// - Render loop: dirty-flag rendering. A frame is drawn only when something changed (camera, hover,
//   selection, data, drag, a worker tick, a loaded logo: everything goes through draw.ts invalidate())
//   or while something animates: a flight, the settle interpolation, grow-in and pulse rings and
//   leftover sprite builds follow at the display's rate (ANIM_MOTION); trade fx, radius tweens, link
//   dots, beacon breathing and the selection ring alone are redrawn every ~33 ms (ANIM_AMBIENT); a
//   static picture is not redrawn at all, so an idle map costs nothing.
// - Interaction: a bubble ≥ 3 px on screen is hovered/clicked as a bubble; anything smaller hands the
//   pointer to its cluster or its title (hover = tree tooltip, click = fly to the tree and select its root).
// - Drag (the live simulation, owner 2026-10-20 "the map as it was when we first opened the site"):
//   pressing a bubble ≥ 3 px and moving past CLICK_PX grabs that bubble; at overview a tree's title (or,
//   for a mouse, its hull) grabs the tree's root, so a family can be dragged from far out. The grabbed
//   bubble follows the pointer exactly (this thread sets its position and posts {t: "drag", phase} to
//   the worker), and the worker reheats the simulation for as long as the pointer is down: its children
//   trail behind it on their links, the neighbours flow out of the way and the map breathes. On release
//   the bubble is let go and the layout cools to rest over a second or two (a root glides back toward
//   its family's centre); the settled positions then go to the cache. Below CLICK_PX it is a click.
// - Live: `live` subscribes to SSE trades and pushes ripples/comets into map/fx.ts (fixed slot ring,
//   only while the map is visible); `heat` (the /api/map/heat sidecar) seeds each node's last trade
//   and hourly count; `highlight` writes a match bit per node that dims the rest without moving it.
// - Data changes are diffs: a handful of new nodes is appended in place (links, cluster, draw order:
//   store.addLinks / addToClusters / insertOrder) and each is put next to its parent by one
//   deterministic rule (lib/map/place.ts: rings around the parent, outward from the family's top, the
//   first spot clear of the family's other bubbles); changed values tween the radius in place. Nothing
//   else is rebuilt or moved. Cached positions (IndexedDB) make a warm open paint settled bubbles on
//   the first frame; a layout that settles again (after a drag) writes the moved rows back.
// - Images: lib/map/images.ts loads lazily by visibility and zoom through /api/img, ≤ 8 in flight,
//   downsampled to 64–256 px thumbnails under a pixel budget; a bubble shows its letter until the logo
//   arrives and swaps without a flicker.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useNavigate } from "react-router-dom";
import { drag, pointer, scaleSqrt, select, zoom, zoomIdentity, type D3DragEvent, type D3ZoomEvent, type ZoomTransform } from "d3";
import { api, type MapNode, type TreeNode } from "../lib/api";
import { subscribe } from "../lib/events";
import { useAsync } from "../lib/hooks";
import { ago, count, usd } from "../lib/format";
import { imageFor, imageStats, onImageLoaded } from "../lib/map/images";
import { DEBUG_HOOKS } from "../lib/map/debug";
import type { HeatIndex } from "../lib/map/heat";
import type { BubbleNode, SizeMode } from "../lib/map/types";
import { coinMcap, coinRadius, familyRadii, familyWeights, families, rangeFor, topMaxWeight } from "../lib/map/sizing";
import { ErrorBox, Skeleton, nameOf, sym } from "./Bits";
import { ANIM_MOTION, clusterAt, draw, fitFor, hitTest, invalidate, makeState, screenR, TWEEN_MS, type Inset, type State } from "./map/draw";
import { cancelFlight, contextTarget, flyTo } from "./map/camera";
import { clearFx, pushTrade } from "./map/fx";
import { hexA } from "./map/sprites";
import { COLORS, F_ANC, F_FIXED, F_FOCUS, F_MATCH, F_MIG, F_OURS, MapStore, colorIdx, valueOf } from "./map/store";
import "./bubblemap.css";

export type { BubbleNode, SizeMode } from "../lib/map/types";
export { COLORS } from "./map/store";
export type FrameStats = { frames: number; settling: { n: number; avg: number; p95: number; max: number }; settled: { n: number; avg: number; p95: number; max: number }; labels: number; drawn: number };
export type BubbleMapHandle = {
  /// Flight to the whole map.
  fit: () => void;
  /// Select a coin and fly to it; `context` (the default) frames it with its parent and children.
  focusNode: (mint: string, opts?: { context?: boolean }) => void;
  /// Flight to a whole tree; `select` (the default) also selects its root (onSelect fires, no second flight).
  fitCluster: (rootMint: string, opts?: { select?: boolean }) => void;
  /// Zoom about the centre of the visible (inset) viewport, as a flight.
  scaleBy: (f: number) => void;
  /// Instant pan by screen pixels (positive dx looks right).
  panBy: (dx: number, dy: number) => void;
  /// Pins the hover on a coin (tooltip + relatives lit), null clears it: the side panel's lists use it.
  hoverNode: (mint: string | null) => void;
  /// World radius of a bubble worth `value` in the current size mode (multiply by zoom() for pixels).
  worldRadius: (value: number) => number;
  zoom: () => number;
  frameStats: () => FrameStats;
};
/// `inset` is the screen area overlays cover (the /map stats panel), so "fit" centres the bubbles in what is actually visible.
/// `focus` pins a coin at the centre with its ancestors above (coin page). `select` + `onSelect` turn
/// clicks into a selection (the /map side panel) instead of navigation; the camera flies to a newly
/// selected node with its parent and children in frame. `fresh` holds mints that arrived live (pulse
/// ring; the set is drained once drawn); `onLayout` receives settled positions for the cache.
/// `highlight` dims every coin it rejects (nothing moves); `live` draws trade ripples from the event
/// stream; `heat` seeds last-trade times and hourly counts; `hideLegend` drops the built-in legend
/// (the /map page has its own key); `onCamera` reports the zoom at most 4 times a second.
/// `titleTags` (family top mint → text, the family's dominance on /map) is appended to each tree's title,
/// `titleTagsCompact` instead on narrow screens (defaults to titleTags); `clusterInfo` adds rows to the
/// hovered tree's tooltip (by its top's mint).
type Props = {
  nodes: BubbleNode[]; focus?: string; select?: string | null; onSelect?: (n: BubbleNode | null) => void; height: number | string; mode?: SizeMode; onModeChange?: (m: SizeMode) => void;
  /// false hides the locked-value UI (the size toggle and the locked tooltip rows).
  lockedUi?: boolean;
  ref?: Ref<BubbleMapHandle>; className?: string; inset?: Inset; fresh?: Set<string>; onLayout?: (pos: { mint: string; x: number; y: number }[]) => void;
  highlight?: ((n: BubbleNode) => boolean) | null; live?: boolean; heat?: HeatIndex | null; hideLegend?: boolean; onCamera?: (c: { k: number }) => void;
  titleTags?: ReadonlyMap<string, string> | null; titleTagsCompact?: ReadonlyMap<string, string> | null; clusterInfo?: (topMint: string) => ReactNode;
};

/// Flatten /api/tree: the focus coin's ancestors (nearest first) become a chain of nodes above it,
/// so the map can show where the coin hangs from, not only what hangs from it.
export function flattenTree(t: TreeNode): BubbleNode[] {
  const out: BubbleNode[] = [];
  const anc = t.coin.ancestors;
  anc.forEach((a, i) => out.push({ mint: a.mint, parentMint: anc[i + 1]?.mint ?? null, depth: a.depth, name: a.name, symbol: a.symbol, image: a.image, mcapUsd: null, lockedUsd: null, children: 0, migrated: false }));
  const walk = (n: TreeNode, parentMint: string | null) => {
    const c = n.coin;
    out.push({ mint: c.mint, parentMint, depth: c.depth, name: c.name, symbol: c.symbol, image: c.image, mcapUsd: c.mcapUsd, lockedUsd: c.lockedUsd, children: c.children, descendants: c.descendants, migrated: c.migrated, ours: !!c.ours });
    n.children.forEach((k) => walk(k, c.mint));
  };
  walk(t, anc[0]?.mint ?? null);
  return out;
}
export function flattenMap(roots: MapNode[]): BubbleNode[] {
  const out: BubbleNode[] = [];
  const walk = (n: MapNode, parentMint: string | null) => {
    const c = n.coin;
    out.push({ mint: c.mint, parentMint, depth: c.depth, name: c.name, symbol: c.symbol, image: c.image, mcapUsd: c.mcapUsd, lockedUsd: c.lockedUsd, children: c.children, descendants: c.descendants, migrated: c.migrated, ours: !!c.ours });
    n.children.forEach((k) => walk(k, c.mint));
  };
  roots.forEach((r) => walk(r, null));
  return out;
}

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const GOLDEN = 2.399963;
/// Below this on-screen radius a bubble hands the pointer to its cluster (and never starts a drag).
const MIN_HIT_PX = 3;
/// A press that moves less than this (screen px) is a click; past it, the grabbed subtree is dragged.
const CLICK_PX = 4;
/// Up to this many newcomers in one data change are appended in place (no rebuild, no settle); more at
/// once (a wider roots limit) rebuild the derived structures and settle the uncached ones among the rest.
const ADD_INCREMENTAL_MAX = 64;
/// Redraw period while only the ambient decorations (link dots, beacons, the selection ring) animate.
const AMBIENT_MS = 33;
/// Delay before the spots of newly placed coins are written to the cache (bursts coalesce).
const PERSIST_SOON_MS = 2_000;
const CAMERA_HZ_MS = 250;
const pct = (arr: Float32Array, n: number, p: number) => { if (!n) return 0; const a = Array.from(arr.subarray(0, Math.min(n, arr.length))).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
const stat = (arr: Float32Array, n: number) => { const len = Math.min(n, arr.length); let sum = 0, max = 0; for (let i = 0; i < len; i++) { sum += arr[i]; if (arr[i] > max) max = arr[i]; } return { n, avg: len ? sum / len : 0, p95: pct(arr, n, 0.95), max }; };

/// maxV = the heaviest weight (value, or a top's family total) drawn at radius rangeR; maxR = the base
/// largest radius (the coin page's scale, and the fallback for coins with no known value).
type Scale = { maxV: number; maxR: number; rangeR: number; floor: number; mode: SizeMode; focus: string | undefined; count: number };

/// Uploads nodes [from, n) and their links to the worker: "init" rebuilds the simulation, "add" appends.
/// Arrays are copies, transferred, so the store keeps its own. `pin` marks nodes held still for this
/// settle besides the F_FIXED ones (bulk arrivals settle among a pinned map).
function postLayout(s: State, w: Worker, from: number, type: "init" | "add", alpha: number, pin?: Uint8Array) {
  const store = s.store;
  const cnt = store.n - from;
  const x = store.nx.slice(from, store.n), y = store.ny.slice(from, store.n), r = store.rT.slice(from, store.n), depth = store.depth.slice(from, store.n);
  const cx = new Float32Array(cnt), cy = new Float32Array(cnt), fixed = new Uint8Array(cnt);
  for (let i = from; i < store.n; i++) { const c = store.clusters[store.cluster[i]]; cx[i - from] = c?.cx ?? 0; cy[i - from] = c?.cy ?? 0; fixed[i - from] = store.flags[i] & F_FIXED || (pin && pin[i]) ? 1 : 0; }
  const srcL: number[] = [], dstL: number[] = [];
  for (let l = 0; l < store.m; l++) if (type === "init" || store.lsrc[l] >= from || store.ldst[l] >= from) { srcL.push(store.lsrc[l]); dstL.push(store.ldst[l]); }
  const src = Int32Array.from(srcL), dst = Int32Array.from(dstL);
  w.postMessage({ t: type, n: cnt, x, y, r, cx, cy, depth, fixed, src, dst, alpha, focus: !!s.focus, hPx: s.hPx, ancShift: s.hasAnc ? 1 : 0 }, [x.buffer, y.buffer, r.buffer, cx.buffer, cy.buffer, depth.buffer, fixed.buffer, src.buffer, dst.buffer]);
}

/// What the client cache already holds per node index (mint + rounded position): a save writes only the
/// nodes that moved, so a warm open that changed nothing writes nothing, and a local relaxation after a
/// live pair writes a few hundred rows instead of all 16 k.
type SavedPos = { ids: string[]; x: Float32Array; y: Float32Array };
const POS_EPS = 0.5;
function movedPositions(store: MapStore, sv: SavedPos): { mint: string; x: number; y: number }[] {
  if (sv.x.length < store.n) { const cap = Math.max(store.n, sv.x.length * 2, 256); const x = new Float32Array(cap), y = new Float32Array(cap); x.set(sv.x); y.set(sv.y); sv.x = x; sv.y = y; }
  const out: { mint: string; x: number; y: number }[] = [];
  for (let i = 0; i < store.n; i++) {
    const x = Math.round(store.nx[i] * 10) / 10, y = Math.round(store.ny[i] * 10) / 10;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (sv.ids[i] === store.ids[i] && Math.abs(sv.x[i] - x) < POS_EPS && Math.abs(sv.y[i] - y) < POS_EPS) continue;
    sv.ids[i] = store.ids[i]; sv.x[i] = x; sv.y[i] = y;
    out.push({ mint: store.ids[i], x, y });
  }
  return out;
}
const markSaved = (sv: SavedPos, i: number, mint: string, x: number, y: number) => {
  if (sv.x.length <= i) { const cap = Math.max(i + 1, sv.x.length * 2, 256); const nx = new Float32Array(cap), ny = new Float32Array(cap); nx.set(sv.x); ny.set(sv.y); sv.x = nx; sv.y = ny; }
  sv.ids[i] = mint; sv.x[i] = x; sv.y[i] = y;
};

/// Bubble under a screen point that is big enough to be a bubble target, or -1.
const grab = (s: State, x: number, y: number) => { const i = hitTest(s, x, y); return i >= 0 && screenR(s, i) >= MIN_HIT_PX ? i : -1; };
/// Cluster whose overview title (as drawn last frame) is under a screen point, or -1.
function titleAt(s: State, x: number, y: number): number {
  const p = s.perf, cl = s.store.clusters, t = s.t;
  const n = Math.min(p.titles ?? 0, p.titleIdx?.length ?? 0);
  for (let q = 0; q < n; q++) {
    const c = cl[p.titleIdx[q]];
    if (!c || !c.anchored) continue;
    const w = Math.max(c.tsp?.width ?? 0, c.tspA?.width ?? 0) || c.tspW || 120;
    const ax = c.ccx * t.k + t.x, ay = c.minY * t.k + t.y - 4;
    if (x >= ax - w / 2 && x <= ax + w / 2 && y >= ay - 22 && y <= ay + 2) return p.titleIdx[q];
  }
  return -1;
}
/// What the pointer is over: a bubble ≥ 3 px, else a tree's title or the tree itself (overview; not on
/// the coin page), else a tiny bubble, else nothing. `i` is a node index, `c` a cluster index; at most one is ≥ 0.
function pointerTarget(s: State, x: number, y: number): { i: number; c: number } {
  const i = hitTest(s, x, y);
  if (i >= 0 && screenR(s, i) >= MIN_HIT_PX) return { i, c: -1 };
  if (!s.focus) { const tc = titleAt(s, x, y), c = tc >= 0 ? tc : clusterAt(s, x, y); if (c >= 0) return { i: -1, c }; }
  return { i, c: -1 };
}
/// What a press grabs: a bubble ≥ 3 px, else at overview (not on the coin page) a tree's title or, for a
/// mouse, its hull, which grab the tree's root; -1 = the press pans the map.
function pressTarget(s: State, x: number, y: number, touch: boolean): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  const i = grab(s, x, y);
  if (i >= 0 || s.focus) return i;
  let c = titleAt(s, x, y);
  if (c < 0 && !touch) c = clusterAt(s, x, y);
  const root = c >= 0 ? s.store.clusters[c]?.root ?? -1 : -1;
  return root >= 0 && root < s.store.n ? root : -1;
}
/// The screen point of a mouse or touch event relative to the canvas (the touch that changed).
function eventPoint(ev: Event, cv: HTMLCanvasElement): [number, number] {
  const te = ev as TouchEvent;
  const t = te.changedTouches?.[0] ?? te.touches?.[0];
  return t ? pointer(t, cv) : pointer(ev, cv);
}
/// A press in progress: the node it grabbed, press point (screen), whether it became a drag, and the
/// grab offset (world units, pointer minus node) once it did.
type Grab = { i: number; x: number; y: number; active: boolean; ox: number; oy: number };

export default function BubbleMap({ nodes, focus, select: selectProp, onSelect, height, mode: modeProp = "locked", onModeChange, lockedUi = true, ref, className = "", inset, fresh, onLayout, highlight = null, live = false, heat = null, hideLegend = false, onCamera, titleTags = null, titleTagsCompact, clusterInfo }: Props) {
  const nav = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<SizeMode>(modeProp);
  const [hover, setHover] = useState<number>(-1);
  const [hoverCluster, setHoverCluster] = useState<number>(-1);
  /// A drag is in progress (hides the tooltips; the renderer reads store.dragging)
  const [dragging, setDragging] = useState(false);
  useEffect(() => setMode(modeProp), [modeProp]);

  // Everything the render loop touches lives in refs: React re-renders only for the tooltip and the
  // small DOM controls, never per frame.
  const st = useRef<State>(null as unknown as State);
  if (!st.current) st.current = makeState({ mode, focus, inset, static: reduced() });
  st.current.focus = focus; st.current.inset = inset; st.current.mode = mode;
  st.current.onSelect = onSelect ? (i) => onSelect(i >= 0 ? st.current.store.data[i] : null) : undefined;
  const worker = useRef<Worker | null>(null);
  /// The running settle holds the cached nodes still (bulk arrivals): released once it settles.
  const pinnedSettle = useRef(false);
  /// A drag reheated the layout: its settled positions go to the cache as soon as it is at rest.
  const dragMoved = useRef(false);
  const workerInfo = useRef<{ ticks: number; tickMs: number; frames: number; n: number; alpha: number; settled: boolean; at: number } | null>(null);
  const scale = useRef<Scale | null>(null);
  const layoutSavedAt = useRef(0);
  /// Positions moved since the last save (a worker tick arrived): leaving the page writes them only then,
  /// so a settled map does not rewrite every position on each navigation (and the next open's cache read
  /// does not queue behind that write).
  const layoutDirty = useRef(false);
  const savedPos = useRef<SavedPos>({ ids: [], x: new Float32Array(0), y: new Float32Array(0) });
  /// Hands the positions that moved since the last save to the cache (nothing when none did).
  const persistLayout = useCallback(() => {
    const store = st.current.store, f = onLayoutRef.current;
    if (!f || !store.n) return;
    layoutDirty.current = false;
    const moved = movedPositions(store, savedPos.current);
    if (moved.length) f(moved);
  }, []);
  const onLayoutRef = useRef(onLayout); onLayoutRef.current = onLayout;
  /// Newly placed coins reach the cache a moment after they arrive (one write per burst, moved rows only).
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistSoon = useCallback(() => { layoutDirty.current = true; if (persistTimer.current) return; persistTimer.current = setTimeout(() => { persistTimer.current = null; if (st.current.store.settled) persistLayout(); }, PERSIST_SOON_MS); }, [persistLayout]);
  useEffect(() => () => { if (persistTimer.current) { clearTimeout(persistTimer.current); persistTimer.current = null; } }, []);
  const onCameraRef = useRef(onCamera); onCameraRef.current = onCamera;
  const camNotify = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | null }>({ last: 0, timer: null });

  /// d3-zoom keeps its own copy of the transform: every programmatic jump goes through it.
  const syncZoom = useCallback(() => { const s = st.current, cv = canvas.current; if (s.zoom && cv) select(cv).call(s.zoom.transform, s.t); }, []);
  /// Zoom reports for the page (size key), at most every 250 ms with a trailing call.
  const reportCamera = useCallback(() => {
    const c = camNotify.current;
    if (!onCameraRef.current) return;
    const wait = CAMERA_HZ_MS - (performance.now() - c.last);
    if (wait <= 0) { c.last = performance.now(); onCameraRef.current({ k: st.current.t.k }); return; }
    if (!c.timer) c.timer = setTimeout(() => { c.timer = null; c.last = performance.now(); onCameraRef.current?.({ k: st.current.t.k }); }, wait);
  }, []);
  useEffect(() => () => { if (camNotify.current.timer) clearTimeout(camNotify.current.timer); }, []);

  // ---- worker: created once per mount, positions come back as transferred buffers
  useEffect(() => {
    const s = st.current;
    const w = new Worker(new URL("./map/layout.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    // a worker that dies would otherwise fail silently: surface it (the perf script fails on console errors)
    w.onerror = (e) => console.error("map layout worker error", e.message, e.filename, e.lineno);
    w.onmessageerror = () => console.error("map layout worker: message could not be deserialised");
    let frames = 0;
    w.onmessage = (ev: MessageEvent<{ t: string; x: Float32Array; y: Float32Array; n: number; alpha: number; settled: boolean; ticks: number; tickMs: number }>) => {
      const m = ev.data;
      if (m.t !== "tick") return;
      workerInfo.current = { ticks: m.ticks, tickMs: m.tickMs, frames: frames + 1, n: m.n, alpha: m.alpha, settled: m.settled, at: performance.now() };
      const store = s.store;
      const n = Math.min(m.n, store.n);
      const now = performance.now();
      if (store.settled) { store.px.set(store.x.subarray(0, n)); store.py.set(store.y.subarray(0, n)); }
      else { store.px.set(store.nx.subarray(0, n)); store.py.set(store.ny.subarray(0, n)); }
      store.nx.set(m.x.subarray(0, n)); store.ny.set(m.y.subarray(0, n));
      // the grabbed bubble is ahead of the worker (its last moves may still be in flight): it stays
      // exactly under the pointer, where this thread put it
      const g = store.dragging ? store.dragRoot : -1;
      if (g >= 0 && g < n) { store.px[g] = store.nx[g] = store.x[g]; store.py[g] = store.ny[g] = store.y[g]; }
      const dt = now - store.tickAt;
      store.tickDt = store.tickAt ? Math.min(120, Math.max(8, store.tickDt * 0.6 + dt * 0.4)) : 40;
      store.tickAt = now;
      store.alpha = m.alpha;
      store.settled = m.settled;
      if (m.settled) { store.x.set(store.nx.subarray(0, n)); store.y.set(store.ny.subarray(0, n)); }
      frames++;
      layoutDirty.current = true;
      if (m.settled || frames % 3 === 0) store.refreshHulls();
      // Positions go to the cache once the layout is quiet (settled, or nearly: a live stream nudging
      // radii every few seconds must not keep the next open from painting instantly). The worker sends
      // no tick after it settles, so the first settled tick always saves even inside the 10 s window
      // (a cold layout settles ~7 s after navigation; without this the cache held nodes but no positions).
      // A drag's settle is saved as soon as it comes to rest.
      const due = now - layoutSavedAt.current > 10_000 || (m.settled && (!layoutSavedAt.current || dragMoved.current));
      if ((m.settled || m.alpha < 0.03) && due && store.n && onLayoutRef.current) { layoutSavedAt.current = now; persistLayout(); }
      if (m.settled) {
        dragMoved.current = false;
        // a partial settle is over: the nodes it held still take part in the next drag again
        if (pinnedSettle.current) { pinnedSettle.current = false; const fixed = new Uint8Array(store.n); for (let i = 0; i < store.n; i++) fixed[i] = store.flags[i] & F_FIXED ? 1 : 0; w.postMessage({ t: "unpin", fixed }, [fixed.buffer]); }
      }
      w.postMessage({ t: "buf", x: m.x, y: m.y }, [m.x.buffer, m.y.buffer]);
      invalidate(s);
    };
    // A populated store (StrictMode double-mount, remount) must reach the new worker too.
    if (s.store.n) postLayout(s, w, 0, "init", s.store.settled ? 0 : 0.3);
    // Leaving the page (route change, reload, tab close) saves the layout so the next open paints it as is.
    const save = () => { if (s.store.alpha < 0.1 && layoutDirty.current) persistLayout(); };
    window.addEventListener("pagehide", save);
    return () => { save(); window.removeEventListener("pagehide", save); w.postMessage({ t: "stop" }); w.terminate(); worker.current = null; };
  }, []);

  // ---- data → store (a diff: survivors keep their position, newcomers sit next to their parent)
  useEffect(() => {
    const s = st.current, store = s.store, w = worker.current;
    const now = performance.now();
    if (!s.w && box.current) { const b = box.current.getBoundingClientRect(); s.w = Math.round(b.width); s.h = Math.round(b.height); }
    if (nodes.length && !s.perf.dataAt) s.perf.dataAt = now;
    const hPx = typeof height === "number" ? height : s.h || 600;
    const focusNode = focus ? nodes.find((n) => n.mint === focus) : undefined;
    const hasAnc = !!focusNode && nodes.some((n) => n.depth < focusNode.depth);
    s.hPx = hPx; s.hasAnc = hasAnc;

    // Radius scale (lib/map/sizing.ts): off the coin page a family top is drawn by its family value (area ∝
    // value on one scale for the whole map, so it is the biggest bubble of its tree) and every other coin
    // by its own market cap, the same in both modes. The scale (the heaviest TOP weight) is kept across
    // small changes so a live insert does not resize the whole map; recomputed when the mode/focus
    // changes, the set grows a lot, or the heaviest weight moves by more than 15 %. Only a mode or
    // focus change lays the forest out again (relayout); a drifting scale just tweens the radii in place.
    // On the coin page (focus) the value scale is this coin's and its ancestors'; the coins under it are
    // drawn by their own market cap (below this coin's size), in both modes.
    const fam = focus ? null : families(nodes);
    const wts = fam ? familyWeights(nodes, fam, mode) : null;
    const spine = (d: BubbleNode) => d.mint === focus || (!!focusNode && d.depth < focusNode.depth);
    let maxV = 1;
    if (fam && wts) maxV = Math.max(1, topMaxWeight(fam, wts));
    else for (const n of nodes) { if (!spine(n)) continue; const v = valueOf(n, mode) ?? 0; if (v > maxV) maxV = v; }
    const sc = scale.current;
    const rescale = !sc || sc.mode !== mode || sc.focus !== focus || maxV > sc.maxV * 1.15 || maxV < sc.maxV * 0.6 || nodes.length > sc.count * 1.5 || nodes.length < sc.count * 0.6;
    const relayout = !!sc && (sc.mode !== mode || sc.focus !== focus);
    if (rescale) {
      const maxR = focus ? Math.max(18, Math.min(44, hPx / 11)) : Math.max(18, Math.min(52, hPx / (nodes.length > 150 ? 16 : nodes.length > 60 ? 13 : 10)));
      const floor = nodes.length > 150 ? 5 : 7;
      const rangeR = fam && wts ? rangeFor(fam, wts, { maxW: maxV, floor, maxR }, nodes) : maxR;
      scale.current = { maxV, maxR, rangeR, floor, mode, focus, count: nodes.length };
    }
    const { maxR, floor, rangeR } = scale.current!;
    const radii = fam && wts ? familyRadii(fam, wts, { maxW: scale.current!.maxV, rangeR, floor, maxR }, nodes) : null;
    const rScale = scaleSqrt().domain([0, scale.current!.maxV]).range([0, maxR]);
    /// node `d` at position `q` of `nodes`
    const radiusOf = (d: BubbleNode, q: number) => {
      if (radii) return radii[q];
      if (!spine(d)) return coinRadius(coinMcap(d), { floor, maxR: maxR * FOCUS_KID_MAX });
      const v = valueOf(d, mode);
      const anc = !!focusNode && d.depth < focusNode.depth && d.mint !== focus;
      let r = v == null ? maxR * (anc ? 0.55 : 0.4) : Math.max(floor, rScale(v));
      if (d.mint === focus) r = Math.max(r, maxR * 0.85);
      return r;
    };
    const flagsOf = (d: BubbleNode) => (d.ours ? F_OURS : 0) | (d.migrated ? F_MIG : 0) | (focusNode && d.depth < focusNode.depth && d.mint !== focus ? F_ANC : 0) | (d.mint === focus ? F_FOCUS : 0);

    // removals → rebuild the store (rare: roots limit change); positions survive through the records.
    // Counted before anything is appended (mints are unique): no 17 k Set on the common live pair.
    let newcomers = 0;
    for (const n of nodes) if (!store.idx.has(n.mint)) newcomers++;
    const removed = store.n ? Math.max(0, store.n + newcomers - nodes.length) : 0;
    const cold = store.n === 0;
    let hadPositions = 0;
    if (removed) {
      // indices are about to change: store what moved first, so the saved-position marks stay exact
      if (store.settled) persistLayout();
      const keep = new Set<string>();
      for (const n of nodes) keep.add(n.mint);
      for (let i = 0; i < store.n; i++) { const d = store.data[i]; if (keep.has(d.mint) && store.settled) { d.x = store.nx[i]; d.y = store.ny[i]; } }
      Object.assign(store, new MapStore());
      // node indices now mean other coins: drop the effects in flight and every index-keyed selection
      // (a drag in progress ends with the old store: its moves no longer apply)
      clearFx(s.fx);
      cancelFlight(s);
      scale.current = { ...scale.current!, count: nodes.length };
      s.hover = -1; s.pinned = -1; s.selected = -1; s.hoverCluster = -1; setHover(-1); setHoverCluster(-1);
    }
    const oldN = store.n;
    const added: number[] = [];
    const changedR: number[] = [];
    const idxOf = new Int32Array(nodes.length);
    for (let q = 0; q < nodes.length; q++) {
      const d = nodes[q];
      let i = store.idx.get(d.mint);
      const r = radiusOf(d, q);
      if (i === undefined) {
        const hasPos = d.x != null && d.y != null && Number.isFinite(d.x) && Number.isFinite(d.y);
        if (hasPos) hadPositions++;
        i = store.add(d, hasPos ? d.x! : NaN, hasPos ? d.y! : NaN, r, 0, flagsOf(d));
        if (hasPos) markSaved(savedPos.current, i, d.mint, d.x!, d.y!); // the cache already holds this one
        added.push(i);
      } else {
        if (store.data[i] !== d) {
          if (store.data[i].image !== d.image) store.gen[i]++;
          store.data[i] = d;
          store.flags[i] = (store.flags[i] & (F_FIXED | F_MATCH)) | flagsOf(d);
          if (store.parent[i] < 0 || d.depth > 0) { store.depth[i] = Math.min(255, d.depth); store.color[i] = colorIdx(d.depth); } // a family member under a listed asset keeps its generation (store.applyGenerations)
        }
        if (Math.abs(store.rT[i] - r) > 0.25) { store.r0[i] = store.r[i]; store.rT[i] = r; store.rt0[i] = now; changedR.push(i); }
      }
      idxOf[q] = i;
    }
    if (!store.n) { s.focusIdx = -1; return; }
    const parentChanged = !added.length && nodes.some((d, q) => { const pi = d.parentMint ? store.idx.get(d.parentMint) : undefined; return (pi ?? -1) !== store.parent[idxOf[q]]; });
    s.focusIdx = focus ? store.idx.get(focus) ?? -1 : -1;

    const aspect = Math.max(1, s.w - (inset?.left ?? 0)) / Math.max(1, s.h - (inset?.top ?? 0) - (inset?.bottom ?? 0));
    // A handful of live pairs on a map that is already laid out: appended in place (links, cluster,
    // draw order), each put next to its parent by one deterministic rule (store.placeNear), and nothing
    // else is rebuilt, measured or moved. The full rebuild below stays for a cold open, removals, the
    // coin page and bulk arrivals (a wider roots limit), whose uncached newcomers settle among the rest.
    const incremental = added.length > 0 && !cold && !removed && !focus && added.length <= ADD_INCREMENTAL_MAX;
    let uncached = 0;
    if (incremental) {
      const newTops = store.addLinks(added);
      const touched = store.addToClusters(added);
      for (const i of added) {
        const d = store.data[i], p = store.parent[i];
        if (Number.isFinite(store.nx[i])) { /* cached */ }
        else if (p >= 0 && Number.isFinite(store.nx[p])) store.placeNear(i, p);
        else { const c = store.clusters[store.cluster[i]]; store.nx[i] = c ? c.cx : 0; store.ny[i] = c ? c.cy : 0; }
        store.x[i] = store.px[i] = store.nx[i]; store.y[i] = store.py[i] = store.ny[i];
        store.born[i] = s.static ? 0 : now;
        if (fresh?.has(d.mint)) { store.pulse[i] = now; fresh.delete(d.mint); }
        store.insertOrder(i);
      }
      if (newTops.length) store.reorderSome(newTops);
      for (const ci of touched) { const c = store.clusters[ci]; if (c) store.measure(c, store.nx, store.ny, false); }
      // the worker records them (indices stay aligned; a drag's simulation moves them with the rest)
      if (w) postLayout(s, w, oldN, "add", 0);
      persistSoon();
    } else if (added.length) {
      store.rebuildLinks();
      // Clusters: a cold start without any cached position packs them; otherwise existing centres (the
      // centroids of the cached members) stay and new roots go to the rim.
      const allCached = cold && hadPositions === nodes.length;
      store.rebuildClusters(cold && !hadPositions && !focus, aspect);
      if (allCached || (cold && hadPositions)) {
        // the cached layout decides where clusters are: centres = centroids of what is cached
        for (const c of store.clusters) { let sx = 0, sy = 0, k = 0; for (const i of c.members) if (Number.isFinite(store.nx[i])) { sx += store.nx[i]; sy += store.ny[i]; k++; } if (k) { c.cx = sx / k; c.cy = sy / k; } }
        let ext = 0; for (const c of store.clusters) if (Number.isFinite(c.cx)) ext = Math.max(ext, Math.hypot(c.cx, c.cy) + c.R);
        let q = 0; for (const c of store.clusters) if (!Number.isFinite(c.cx)) { const a = q * GOLDEN; const dd = ext + c.R + 20; c.cx = Math.cos(a) * dd; c.cy = Math.sin(a) * dd; q++; }
      }
      // Initial positions for newcomers: next to the parent when it has one, else a sunflower around
      // the cluster centre (root at the middle, biggest children innermost). The force only polishes.
      const perCluster = new Map<number, number>();
      const stagger = cold && !s.static && !hadPositions;
      // a warm open whose cache misses a few coins (they arrived after the last write): placed next to
      // their parent by the live rule, nothing settles; past the limit they settle among the pinned rest
      const fewMissing = hadPositions > 0 && nodes.length - hadPositions <= ADD_INCREMENTAL_MAX;
      for (const i of added) {
        const d = store.data[i];
        const ci = store.cluster[i], c = store.clusters[ci];
        const p = store.parent[i];
        if (Number.isFinite(store.nx[i])) { /* cached */ }
        else if (p >= 0 && Number.isFinite(store.nx[p]) && (!cold || fewMissing)) {
          if (fewMissing) store.placeNear(i, p);
          else {
            uncached++;
            const a = (i * GOLDEN) % (Math.PI * 2), dd = store.rT[p] + store.rT[i] + 8;
            store.nx[i] = store.nx[p] + Math.cos(a) * dd; store.ny[i] = store.ny[p] + Math.sin(a) * dd;
          }
        } else if (p < 0) { if (!fewMissing) uncached++; store.nx[i] = c.cx; store.ny[i] = c.cy; }
        else {
          uncached++;
          const k = perCluster.get(ci) ?? 0; perCluster.set(ci, k + 1);
          const a = k * GOLDEN, dd = (c.R * 0.9) * Math.sqrt((k + 1) / Math.max(2, c.members.length)) + store.rT[store.rootOf(i)] + 4;
          store.nx[i] = c.cx + Math.cos(a) * dd; store.ny[i] = c.cy + Math.sin(a) * dd;
          if (d.depth >= 2 && p >= 0 && Number.isFinite(store.nx[p])) { store.nx[i] = store.nx[p] + Math.cos(a) * (store.rT[p] + store.rT[i] + 6); store.ny[i] = store.ny[p] + Math.sin(a) * (store.rT[p] + store.rT[i] + 6); }
        }
        store.x[i] = store.px[i] = store.nx[i]; store.y[i] = store.py[i] = store.ny[i];
        store.born[i] = s.static ? 0 : cold ? (stagger ? now + d.depth * 160 + (i % 7) * 40 : 0) : now;
        if (fresh?.has(d.mint)) { store.pulse[i] = now; fresh.delete(d.mint); }
      }
      // focus layout: the coin at the origin, its ancestors stacked upward, all pinned
      if (s.focusIdx >= 0) {
        const f = s.focusIdx; store.nx[f] = store.ny[f] = 0; store.flags[f] |= F_FIXED;
        let up = f, level = 1;
        while (store.parent[up] >= 0) { const a = store.parent[up]; store.nx[a] = 0; store.ny[a] = -(hPx * 0.22) * level; store.flags[a] |= F_FIXED; up = a; level++; }
        for (const i of added) { store.x[i] = store.px[i] = store.nx[i]; store.y[i] = store.py[i] = store.ny[i]; }
      }
      store.rebuildOrder();
      if (fewMissing && hadPositions < nodes.length) persistSoon();
      if (w) {
        if (cold) {
          // every spot cached (or the few missing ones just placed): final; most cached: the rest settles
          // among the pinned ones; nothing cached: the full settle
          const done = hadPositions === nodes.length || fewMissing;
          store.settled = done; store.tickAt = 0;
          let pin: Uint8Array | undefined;
          if (!done && hadPositions) { pin = new Uint8Array(store.n).fill(1); for (const i of added) if (savedPos.current.ids[i] !== store.ids[i]) pin[i] = 0; }
          pinnedSettle.current = !!pin;
          postLayout(s, w, 0, "init", done ? 0 : hadPositions ? 0.3 : 1, pin);
        } else {
          // bulk arrivals on a laid-out map: the newcomers without a cached spot settle among the rest,
          // which stays pinned for that settle; nothing to settle when every spot was cached
          store.settled = uncached === 0; store.tickAt = 0;
          let pin: Uint8Array | undefined;
          if (uncached) { pin = new Uint8Array(store.n).fill(1); for (const i of added) if (!(savedPos.current.ids[i] === store.ids[i])) pin[i] = 0; }
          pinnedSettle.current = !!pin;
          postLayout(s, w, 0, "init", uncached ? 0.3 : 0, pin);
        }
      }
      if (cold) {
        store.refreshHulls();
        // Start where the auto-fit is heading: the first frame is the fit of the initial placement,
        // never the k = 1 view (which drew giant hull rings for up to a second on a cold open).
        if (!s.follow && !s.flight) { const t0 = fitFor(s, 36); if (t0) { s.t = t0; syncZoom(); } }
        s.autoFit = !s.follow && !s.flight;
      } else store.refreshHulls(); // the rebuild reset every hull: measure now, not on a later worker tick
    } else if (parentChanged) {
      store.rebuildClusters(false, aspect);
      store.rebuildOrder();
      store.refreshHulls();
    }
    if (changedR.length) {
      s.tweenUntil = now + TWEEN_MS + 30;
      // the draw order follows the target radii: re-sorted for the changed nodes only (the full paths
      // above rebuilt it already)
      if (!cold && !removed && (incremental || !added.length)) store.reorderSome(changedR);
      if (rescale) { for (const c of store.clusters) { let mx = 0; for (const i of c.members) if (store.rT[i] > mx) mx = store.rT[i]; c.maxR = mx; } }
    }
    if (w && relayout && !cold && !removed) {
      // an explicit relayout (size mode, focus): the whole forest settles again from its current spots
      store.settled = false; store.tickAt = 0; pinnedSettle.current = false;
      postLayout(s, w, 0, "init", 0.3);
    } else if (w && changedR.length && !store.settled && !cold && !removed) {
      // a settle in progress learns the new collision radii of the bubbles it already has (no reheat)
      const idx = Int32Array.from(changedR.filter((i) => i < oldN)), r = new Float32Array(idx.length);
      for (let q = 0; q < idx.length; q++) r[q] = store.rT[idx[q]];
      if (idx.length) w.postMessage({ t: "radius", idx, r }, [idx.buffer, r.buffer]);
    }
    if (s.hover >= store.n) { s.hover = -1; setHover(-1); }
    if (s.hoverCluster >= store.clusters.length) { s.hoverCluster = -1; setHoverCluster(-1); }
    if (s.pinned >= store.n) s.pinned = -1;
    if (s.selected >= store.n) s.selected = -1;
    invalidate(s);
    const dataMs = performance.now() - now;
    s.perf.dataMs = dataMs; if (dataMs > s.perf.dataMaxMs) s.perf.dataMaxMs = dataMs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, mode, focus, height]);

  // ---- highlight filter: one match bit per node, no layout change (after the data effect: a store
  // rebuild re-applies it)
  useEffect(() => {
    const s = st.current, store = s.store, f = store.flags, data = store.data;
    s.highlight = !!highlight;
    if (highlight) { for (let i = 0; i < store.n; i++) f[i] = highlight(data[i]) ? f[i] | F_MATCH : f[i] & ~F_MATCH; }
    else for (let i = 0; i < store.n; i++) f[i] &= ~F_MATCH;
    invalidate(s);
  }, [highlight, nodes]);

  // ---- title tags (the family's dominance on /map): one string per tree, by its top's mint. After the
  // data effect, so trees it just created get theirs in the same commit; a changed tag rebuilds that one
  // title's bitmap (draw.ts keys it on title + tag). Nothing moves and nothing is measured.
  useEffect(() => {
    const s = st.current;
    let changed = false;
    const compact = titleTagsCompact === undefined ? titleTags : titleTagsCompact;
    for (const c of s.store.clusters) {
      const t = titleTags?.get(c.id) ?? "", tc = compact?.get(c.id) ?? "";
      if (c.tag !== t || c.tagC !== tc) { c.tag = t; c.tagC = tc; changed = true; }
    }
    if (changed) invalidate(s);
  }, [titleTags, titleTagsCompact, nodes]);

  // ---- heat sidecar → last trade + hourly count per node (the server's numbers win at every poll)
  useEffect(() => {
    if (!heat) return;
    const store = st.current.store;
    store.t1h.fill(0, 0, store.n);
    for (const [mint, row] of heat.rows) {
      const i = store.idx.get(mint);
      if (i === undefined) continue;
      const lt = row.last * 1000;
      if (lt > store.lastTrade[i]) store.lastTrade[i] = lt;
      store.t1h[i] = Math.min(65535, Math.max(0, row.t1h));
    }
    invalidate(st.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heat?.at, heat?.rows, nodes]);

  // ---- a logo that finished loading, or a tooltip/selection that React just mounted, is drawn once
  useEffect(() => onImageLoaded(() => invalidate(st.current)), []);
  useEffect(() => { invalidate(st.current); }, [hover, hoverCluster, dragging]);

  // ---- live trades → ripples and comets (only while the map is on screen; nothing queues while hidden)
  useEffect(() => {
    if (!live) return;
    return subscribe({
      trade: (t) => {
        const s = st.current;
        if (!s.visible || document.hidden || !t?.mint) return;
        const i = s.store.idx.get(t.mint);
        if (i === undefined) return;
        pushTrade(s.fx, s.store, i, !!t.isBuy, typeof t.valueUsd === "number" ? t.valueUsd : null, t.sig ?? "", performance.now());
        // a ripple off screen needs no frame (the draw loop is asleep on a static map)
        const { x, y, r } = s.store, tr = s.t, sx = x[i] * tr.k + tr.x, sy = y[i] * tr.k + tr.y, m = r[i] * tr.k + 40;
        if (sx + m >= 0 && sy + m >= 0 && sx - m <= s.w && sy - m <= s.h) invalidate(s);
      },
    });
  }, [live]);

  // ---- selection from the outside (?focus=<mint>, search, the side panel's lists, keyboard): fly to
  // the coin with its parent and children in frame. A selection this component made itself (cluster
  // click, focusNode) already set `selected` and flew, so it is not flown twice.
  useEffect(() => {
    const s = st.current;
    if (!onSelect) return;
    const i = selectProp ? s.store.idx.get(selectProp) ?? -1 : -1;
    if (i === s.selected) return;
    s.selected = i;
    s.pinned = -1;
    if (i >= 0) {
      const target = contextTarget(s, i);
      // keep a still-moving node in view after landing; a settled layout keeps the framed context
      flyTo(s, target, performance.now(), { follow: s.store.settled ? null : { i, k: target.k } });
    }
    invalidate(s);
  }, [selectProp, nodes, onSelect]);

  // ---- canvas sizing + zoom/drag behaviours + pointer
  useEffect(() => {
    const el = box.current, cv = canvas.current;
    if (!el || !cv) return;
    const s = st.current;
    const resize = () => {
      const r = el.getBoundingClientRect();
      s.w = Math.max(1, Math.round(r.width)); s.h = Math.max(1, Math.round(r.height)); s.dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(s.w * s.dpr); cv.height = Math.round(s.h * s.dpr);
      if (!s.t || s.t === zoomIdentity) s.t = zoomIdentity.translate(s.w / 2, s.h / 2);
    };
    resize();
    const ro = new ResizeObserver(() => { const w = s.w, h = s.h; resize(); if (w && h) { s.t = zoomIdentity.translate(s.t.x + (s.w - w) / 2, s.t.y + (s.h - h) / 2).scale(s.t.k); syncZoom(); } invalidate(s); });
    ro.observe(el);
    const cursor = () => { cv.style.cursor = s.store.dragging ? "grabbing" : s.hover >= 0 || s.hoverCluster >= 0 ? "pointer" : "grab"; };
    const setHov = (i: number) => { if (i !== s.hover) { s.store.setRelated(s.hover, i); s.hover = i; setHover(i); invalidate(s); } };
    const setHovCluster = (c: number) => { if (c !== s.hoverCluster) { s.hoverCluster = c; setHoverCluster(c); invalidate(s); } };

    // One press at a time: `press` is the current one (a second finger neither drags nor pinches meanwhile).
    let press: Grab | null = null;
    // d3-zoom pans and pinches only where a press grabs nothing (the two filters are complements)
    const z = zoom<HTMLCanvasElement, unknown>().scaleExtent([0.05, 6])
      .filter((ev: Event & { button?: number; ctrlKey?: boolean }) => {
        if (ev.type === "wheel") return true;
        if (ev.type === "mousedown" || ev.type === "touchstart") {
          if (ev.button || press) return false;
          if (ev.type === "touchstart" && (ev as TouchEvent).touches.length > 1) return true; // pinch
          const [x, y] = eventPoint(ev, cv);
          return pressTarget(s, x, y, ev.type === "touchstart") < 0;
        }
        return !ev.button;
      })
      .on("zoom", (ev: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        s.t = ev.transform;
        // a user gesture (wheel, pinch, pan) takes the camera and tells the renderer to economise sprites
        if (ev.sourceEvent) { cancelFlight(s); s.zoomingUntil = performance.now() + 150; }
        invalidate(s);
        reportCamera();
      });
    s.zoom = z;
    const sel = select(cv);
    // a cold open may already have placed the camera at the fit (data effect): keep that view
    sel.call(z).call(z.transform, s.t).on("dblclick.zoom", null);
    // A press becomes a drag only past CLICK_PX (below it the click handler selects or opens). The grabbed
    // bubble then stays under the pointer (offset kept, any zoom) and the worker's simulation, reheated
    // for the drag, moves everything else around it.
    const place = (i: number, wx: number, wy: number) => { const st = s.store; st.x[i] = st.px[i] = st.nx[i] = wx; st.y[i] = st.py[i] = st.ny[i] = wy; };
    const begin = (g: Grab): boolean => {
      const st = s.store;
      if (g.i < 0 || g.i >= st.n) return false;
      cancelFlight(s);
      const [wx, wy] = s.t.invert([g.x, g.y]);
      g.ox = wx - st.x[g.i]; g.oy = wy - st.y[g.i];
      st.beginDrag(g.i);
      st.tickAt = 0;
      worker.current?.postMessage({ t: "drag", i: g.i, x: st.x[g.i], y: st.y[g.i], phase: "start" });
      g.active = true;
      el.classList.add("dragging"); cursor(); setDragging(true);
      invalidate(s);
      return true;
    };
    const finish = () => {
      const st = s.store;
      el.classList.remove("dragging"); setDragging(false);
      if (!st.dragging) { cursor(); return; } // the store was rebuilt under the drag: nothing of it is left
      const i = st.dragRoot;
      st.endDrag();
      // let go: the layout cools to rest (a root glides back toward its home) and is saved once settled
      worker.current?.postMessage({ t: "drag", i, x: st.nx[i], y: st.ny[i], phase: "end" });
      dragMoved.current = true;
      layoutDirty.current = true;
      cursor();
      invalidate(s);
    };
    const dg = drag<HTMLCanvasElement, unknown, Grab>()
      .clickDistance(CLICK_PX)
      .subject((ev: D3DragEvent<HTMLCanvasElement, unknown, unknown>) => {
        if (press) return null as never;
        const touch = !!(ev.sourceEvent as Event | undefined)?.type?.startsWith("touch");
        const i = pressTarget(s, ev.x, ev.y, touch);
        if (i < 0) return null as never;
        // subject x/y = the press point, so every drag event's x/y is the pointer itself
        return { i, x: ev.x, y: ev.y, active: false, ox: 0, oy: 0 };
      })
      .on("start", (ev) => { press = ev.subject; })
      .on("drag", (ev) => {
        const g = ev.subject;
        if (g !== press) return;
        if (!g.active) { const dx = ev.x - g.x, dy = ev.y - g.y; if (dx * dx + dy * dy <= CLICK_PX * CLICK_PX || !begin(g)) return; }
        const st = s.store;
        if (!st.dragging || st.dragRoot !== g.i) return; // the store was rebuilt under the drag
        const [wx, wy] = s.t.invert([ev.x, ev.y]);
        const x = wx - g.ox, y = wy - g.oy;
        place(g.i, x, y);
        invalidate(s);
        worker.current?.postMessage({ t: "drag", i: g.i, x, y, phase: "move" });
      })
      .on("end", (ev) => { const g = ev.subject; if (g !== press) return; press = null; if (g.active) finish(); });
    sel.call(dg);

    const move = (ev: MouseEvent) => {
      const [x, y] = pointer(ev, cv);
      const { i, c } = pointerTarget(s, x, y);
      if (i !== s.hover) { if (s.pinned >= 0) invalidate(s); s.pinned = -1; setHov(i); }
      setHovCluster(c);
      cursor();
    };
    const leave = () => { if (s.hover >= 0 && s.pinned < 0) setHov(-1); setHovCluster(-1); cv.style.cursor = "grab"; };
    const click = (ev: MouseEvent) => {
      const [x, y] = pointer(ev, cv);
      const { i, c } = pointerTarget(s, x, y);
      // the tree flies in under the pointer: its tooltip would now point at nothing
      if (i < 0 && c >= 0) { const cl = s.store.clusters[c]; setHovCluster(-1); cursor(); if (cl) fitClusterRef.current(cl.id, { select: !!s.onSelect }); return; }
      if (s.onSelect) { s.onSelect(i); return; }
      if (i >= 0 && !(s.store.flags[i] & F_FOCUS)) nav(`/c/${s.store.ids[i]}`);
    };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { s.pinned = -1; setHov(-1); setHovCluster(-1); if (s.onSelect && s.selected >= 0) s.onSelect(-1); invalidate(s); } };
    cv.addEventListener("mousemove", move); cv.addEventListener("mouseleave", leave); cv.addEventListener("click", click); el.addEventListener("keydown", key);
    return () => { if (press?.active) finish(); press = null; ro.disconnect(); sel.on(".zoom", null).on(".drag", null); cv.removeEventListener("mousemove", move); cv.removeEventListener("mouseleave", leave); cv.removeEventListener("click", click); el.removeEventListener("keydown", key); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fit = useCallback(() => { const s = st.current; const t = fitFor(s, 36); if (t) flyTo(s, t, performance.now()); }, []);
  const scaleBy = useCallback((f: number) => {
    const s = st.current;
    const il = s.inset?.left ?? 0, it = s.inset?.top ?? 0, ib = s.inset?.bottom ?? 0, ir = s.inset?.right ?? 0;
    const cx = il + (s.w - il - ir) / 2, cy = it + (s.h - it - ib) / 2;
    const k0 = s.t.k, k1 = Math.min(6, Math.max(0.05, k0 * f));
    const ux = (cx - s.t.x) / k0, uy = (cy - s.t.y) / k0;
    flyTo(s, zoomIdentity.translate(cx - ux * k1, cy - uy * k1).scale(k1), performance.now());
  }, []);
  const panBy = useCallback((dx: number, dy: number) => {
    const s = st.current, cv = canvas.current;
    if (!cv || !s.zoom) return;
    cancelFlight(s);
    select(cv).call(s.zoom.transform, s.t.translate(-dx / s.t.k, -dy / s.t.k));
    invalidate(s);
  }, []);
  /// Select a coin and fly to it. With a side panel (onSelect) the selection goes through the page,
  /// whose ?focus echo is then recognised as already flown; the coin page pins the hover instead.
  const focusNode = useCallback((mint: string, opts?: { context?: boolean }) => {
    const s = st.current; const i = s.store.idx.get(mint); if (i === undefined) return;
    const context = opts?.context !== false;
    const target = context ? contextTarget(s, i) : centerOnNode(s, i);
    flyTo(s, target, performance.now(), { follow: s.store.settled ? null : { i, k: target.k } });
    if (s.onSelect) { s.selected = i; s.pinned = -1; s.onSelect(i); }
    else { s.pinned = i; s.store.setRelated(s.hover, i); s.hover = i; setHover(i); }
    invalidate(s);
  }, []);
  const fitCluster = useCallback((rootMint: string, opts?: { select?: boolean }) => {
    const s = st.current, store = s.store;
    let ci = store.clusterOf.get(rootMint);
    if (ci === undefined) { const i = store.idx.get(rootMint); if (i !== undefined && store.cluster[i] >= 0) ci = store.cluster[i]; }
    const c = ci === undefined ? undefined : store.clusters[ci];
    if (!c) return;
    const t = fitFor(s, 40, c.members);
    if (t) flyTo(s, t, performance.now());
    const root = c.root >= 0 && c.root < store.n ? c.root : store.idx.get(c.id) ?? -1;
    if (opts?.select !== false && root >= 0 && s.onSelect) { s.selected = root; s.pinned = -1; s.onSelect(root); }
  }, []);
  const fitClusterRef = useRef(fitCluster); fitClusterRef.current = fitCluster;
  const hoverNode = useCallback((mint: string | null) => {
    const s = st.current;
    const i = mint ? s.store.idx.get(mint) ?? -1 : -1;
    if (i < 0) { if (s.pinned >= 0 || s.hover >= 0) { s.pinned = -1; s.store.setRelated(s.hover, -1); s.hover = -1; setHover(-1); invalidate(s); } return; }
    s.pinned = i; s.store.setRelated(s.hover, i); s.hover = i; setHover(i);
    invalidate(s);
  }, []);
  const worldRadius = useCallback((value: number) => {
    const sc = scale.current;
    if (!sc || !(value > 0)) return sc?.floor ?? 0;
    return Math.max(sc.floor, Math.sqrt(value / Math.max(1e-9, sc.maxV)) * sc.rangeR);
  }, []);
  const zoomK = useCallback(() => st.current.t.k, []);
  const frameStats = useCallback((): FrameStats => { const p = st.current.perf; return { frames: p.frames, settling: stat(p.settling, p.sn), settled: stat(p.settled, p.dn), labels: p.labels, drawn: p.drawn }; }, []);
  useImperativeHandle(ref, () => ({ fit, focusNode, fitCluster, scaleBy, panBy, hoverNode, worldRadius, zoom: zoomK, frameStats }), [fit, focusNode, fitCluster, scaleBy, panBy, hoverNode, worldRadius, zoomK, frameStats]);

  // Dev only: lets the headless scripts (web/test/map-perf.mts, map-interact.mts) read timings and poke the map.
  useEffect(() => {
    if (!DEBUG_HOOKS) return;
    const s = st.current;
    const rootMintOf = (ci: number) => { const c = s.store.clusters[ci]; if (!c) return null; return c.root >= 0 && c.root < s.store.n ? s.store.ids[c.root] : c.id; };
    const page = (x: number, y: number) => { const b = canvas.current!.getBoundingClientRect(); return [x - b.left, y - b.top] as const; };
    const dbg = {
      frameStats, resetFrames: () => { const p = s.perf; p.sn = p.dn = p.si = p.di = 0; p.max = 0; },
      nodes: () => s.store.n, labels: () => s.perf.labels, drawn: () => s.perf.drawn, settled: () => s.store.settled, alpha: () => s.store.alpha,
      has: (mint: string) => s.store.idx.has(mint), node: (mint: string) => { const i = s.store.idx.get(mint); return i === undefined ? null : { ...s.store.data[i], r: s.store.rT[i], x: s.store.nx[i], y: s.store.ny[i] }; }, images: imageStats, worker: () => workerInfo.current,
      firstPaintAt: () => s.perf.firstPaintAt, dataAt: () => s.perf.dataAt, mountedAt: () => s.perf.mountedAt,
      anyRoot: () => { for (let i = 0; i < s.store.n; i++) if (s.store.parent[i] < 0) return s.store.ids[i]; return null; },
      screenOf: (mint: string) => { const i = s.store.idx.get(mint); if (i === undefined) return null; const b = canvas.current!.getBoundingClientRect(); const t = s.t; return { x: b.left + s.store.x[i] * t.k + t.x, y: b.top + s.store.y[i] * t.k + t.y, r: s.store.r[i] * t.k }; },
      fit, zoom: () => s.t.k,
      zoomTo: (mint: string, k: number) => { const i = s.store.idx.get(mint); if (i === undefined) return false; s.flight = null; s.follow = { i, k }; s.autoFit = false; invalidate(s); return true; },
      /// draws so far, what the last frame found animating (draw.ts ANIM_* bits), whether a frame is pending
      draws: () => s.perf.frames, anim: () => s.anim, pending: () => s.raf > 0,
      /// main-thread cost of the last data change (a live pair, a value tick) and the largest seen
      dataMs: () => ({ last: s.perf.dataMs, max: s.perf.dataMaxMs }), resetDataMs: () => { s.perf.dataMaxMs = 0; },
      // ---- map v2 hooks
      titles: () => { const p = s.perf, out: string[] = []; for (let q = 0; q < (p.titles ?? 0); q++) { const m = rootMintOf(p.titleIdx[q]); if (m) out.push(m); } return out; },
      /// the titles drawn last frame that also drew their dominance tag (root mints)
      taggedTitles: () => { const p = s.perf, out: string[] = []; for (let q = 0; q < (p.titles ?? 0); q++) { const m = p.titleTagged[q] ? rootMintOf(p.titleIdx[q]) : null; if (m) out.push(m); } return out; },
      fx: () => s.perf.fx ?? 0,
      lastTrade: (mint: string) => { const i = s.store.idx.get(mint); return i === undefined ? 0 : s.store.lastTrade[i]; },
      t1h: (mint: string) => { const i = s.store.idx.get(mint); return i === undefined ? 0 : s.store.t1h[i]; },
      sample: (n: number) => {
        const out: { mint: string; parent: string }[] = [];
        for (const c of s.store.clusters) { for (const i of c.members) { const p = s.store.parent[i]; if (p >= 0) { out.push({ mint: s.store.ids[i], parent: s.store.ids[p] }); if (out.length >= n) return out; } } }
        return out;
      },
      fly: (mint: string) => { if (!s.store.idx.has(mint)) return false; focusNode(mint, { context: true }); return true; },
      flying: () => !!s.flight,
      camera: () => ({ x: s.t.x, y: s.t.y, k: s.t.k }),
      clusterAt: (x: number, y: number) => { const [cx, cy] = page(x, y); const c = clusterAt(s, cx, cy); return c >= 0 ? rootMintOf(c) : null; },
      hoverCluster: () => (s.hoverCluster >= 0 ? rootMintOf(s.hoverCluster) : null),
      /// what a pointer at page (x, y) would hover: a bubble's mint, or a cluster's root mint
      pick: (x: number, y: number) => { const [cx, cy] = page(x, y); const { i, c } = pointerTarget(s, cx, cy); return { node: i >= 0 ? s.store.ids[i] : null, cluster: c >= 0 ? rootMintOf(c) : null }; },
      /// side of the logo thumbnail a node currently draws (0 = none yet)
      logo: (mint: string) => { const i = s.store.idx.get(mint); if (i === undefined) return 0; const img = imageFor(s.store.data[i].image); return img ? img.width : 0; },
      clusters: (n = 10) => s.store.clusters.slice(0, n).map((c) => ({ root: c.root >= 0 && c.root < s.store.n ? s.store.ids[c.root] : c.id, count: c.members.length, title: c.title, tag: c.tag ?? "", tagC: c.tagC ?? "", cx: c.ccx, cy: c.ccy, cr: c.cr, hullN: c.hullN })),
      members: (rootMint: string) => { const ci = s.store.clusterOf.get(rootMint); return ci === undefined ? [] : s.store.clusters[ci].members.map((i) => s.store.ids[i]); },
      testHighlight: (kind: "ours" | "min1k" | null) => {
        const store = s.store, f = store.flags;
        if (!kind) { s.highlight = false; for (let i = 0; i < store.n; i++) f[i] &= ~F_MATCH; return 0; }
        const pred = kind === "ours" ? (d: BubbleNode) => !!d.ours : (d: BubbleNode) => (d.mcapUsd ?? 0) >= 1_000;
        let m = 0;
        for (let i = 0; i < store.n; i++) { if (pred(store.data[i])) { f[i] |= F_MATCH; m++; } else f[i] &= ~F_MATCH; }
        s.highlight = true;
        return m;
      },
      children: (mint: string) => { const i = s.store.idx.get(mint); if (i === undefined) return []; const out: string[] = []; for (let k = s.store.childStart[i]; k < s.store.childStart[i + 1]; k++) out.push(s.store.ids[s.store.childList[k]]); return out; },
      selected: () => (s.selected >= 0 ? s.store.ids[s.selected] : null),
      /// drawn positions (world units) of the given coins as a flat [x0, y0, x1, y1, …] list (NaN = absent)
      xy: (mints: string[]) => { const out: number[] = []; for (const m of mints) { const i = s.store.idx.get(m); if (i === undefined) out.push(NaN, NaN); else out.push(s.store.x[i], s.store.y[i]); } return out; },
      /// store indices of the given coins (-1 = absent), to read allXY() by family
      idx: (mints: string[]) => mints.map((m) => s.store.idx.get(m) ?? -1),
      /// every node's drawn position, by store index (with the mints, for a still-map check)
      allXY: () => ({ n: s.store.n, x: Array.from(s.store.x.subarray(0, s.store.n)), y: Array.from(s.store.y.subarray(0, s.store.n)) }),
      /// the drag in progress: grabbed node, its tree's root, nodes the page moves itself (null = none)
      drag: () => { const st = s.store; if (!st.dragging) return null; const c = st.clusters[st.dragCluster]; return { node: st.ids[st.dragRoot], root: c ? rootMintOf(st.dragCluster) : null, n: 1 }; },
    };
    (window as unknown as { __sporeMap?: unknown }).__sporeMap = dbg;
    return () => { if ((window as unknown as { __sporeMap?: unknown }).__sporeMap === dbg) delete (window as unknown as { __sporeMap?: unknown }).__sporeMap; };
  }, [frameStats, fit, focusNode]);

  // ---- render loop: runs only while the element is on screen and the tab is visible, and draws only
  // when the picture changed (invalidate) or something animates (draw.ts ANIM_* bits): a static map
  // sleeps until the next invalidate(), ambient decorations alone are redrawn every AMBIENT_MS
  useEffect(() => {
    const el = box.current, cv = canvas.current;
    if (!el || !cv) return;
    const s = st.current;
    const ctx = cv.getContext("2d")!;
    let running = false, lastDraw = 0;
    // Exactly one callback chain: s.raf is the pending request, or DRAWING while a frame runs, so an
    // invalidate() raised from inside draw() (d3-zoom's event when the camera steps) only marks the
    // picture dirty and the chain's own re-arm picks it up; a second chain would double every frame.
    const DRAWING = -1;
    const frame = () => {
      s.raf = DRAWING;
      if (!running) { s.raf = 0; return; }
      const t0 = performance.now();
      const ambientOnly = (s.anim & ANIM_MOTION) === 0 && s.anim !== 0;
      if (!s.dirty && !(s.anim & ANIM_MOTION)) {
        // nothing changed: ambient animation waits for its slot (a cheap callback meanwhile), a static
        // picture sleeps until invalidate() wakes the loop
        if (!ambientOnly) { s.raf = 0; return; }
        if (t0 - lastDraw < AMBIENT_MS - 1) { s.raf = requestAnimationFrame(frame); return; }
      }
      draw(ctx, s, tipEl.current, t0);
      lastDraw = t0;
      const dt = performance.now() - t0;
      const p = s.perf; p.frames++; if (dt > p.max) p.max = dt;
      if (s.store.n) { if (s.store.settled && !s.tweenUntil) { p.settled[p.di] = dt; p.di = (p.di + 1) % p.settled.length; p.dn++; } else { p.settling[p.si] = dt; p.si = (p.si + 1) % p.settling.length; p.sn++; } }
      s.raf = s.anim || s.dirty ? requestAnimationFrame(frame) : 0;
    };
    s.wake = () => { if (running && s.raf === 0) s.raf = requestAnimationFrame(frame); };
    const update = () => {
      const want = s.visible && !document.hidden;
      if (want && !running) { running = true; s.dirty = true; s.raf = requestAnimationFrame(frame); }
      if (!want && running) { running = false; if (s.raf > 0) cancelAnimationFrame(s.raf); s.raf = 0; }
    };
    const io = new IntersectionObserver((es) => { s.visible = es.some((e) => e.isIntersecting); update(); }, { threshold: 0 });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    update();
    return () => { running = false; s.wake = null; if (s.raf > 0) cancelAnimationFrame(s.raf); s.raf = 0; io.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);

  const changeMode = (m: SizeMode) => { setMode(m); onModeChange?.(m); };
  const store = st.current.store;
  const hov = hover >= 0 && hover < store.n ? store.data[hover] : null;
  const hovFlags = hover >= 0 && hover < store.n ? store.flags[hover] : 0;
  const parentOf = hov?.parentMint ? store.data[store.idx.get(hov.parentMint) ?? -1] ?? null : null;
  const hasAnc = useMemo(() => (focus ? nodes.some((n) => { const f = nodes.find((x) => x.mint === focus); return f && n.depth < f.depth; }) : false), [nodes, focus]);
  const hasOurs = useMemo(() => nodes.some((n) => n.ours), [nodes]);
  const showTip = !!hov && !dragging && (!onSelect || hover !== st.current.selected);
  const hovColor = hov ? COLORS[colorIdx(hov.depth)] : COLORS[0];
  const hovT1h = hov ? store.t1h[hover] : 0;
  const hovLast = hov ? store.lastTrade[hover] : 0;
  // the tree under the pointer (overview): its root, size and three largest children
  const cl = !showTip && !dragging && hoverCluster >= 0 && hoverCluster < store.clusters.length ? store.clusters[hoverCluster] : null;
  const clRoot = cl && cl.root >= 0 && cl.root < store.n ? store.data[cl.root] : null;
  const clTop = useMemo(() => {
    if (!cl || cl.root < 0 || cl.root >= store.n) return [];
    const out: number[] = [];
    for (let k = store.childStart[cl.root]; k < store.childStart[cl.root + 1]; k++) out.push(store.childList[k]);
    return out.sort((a, b) => store.rT[b] - store.rT[a]).slice(0, 3).map((i) => store.data[i]);
  }, [cl, store]);
  // the tooltip's "last trade · 3m ago" stays current while it is open
  const [, setTick] = useState(0);
  useEffect(() => { if (!showTip || !hovLast) return; const t = setInterval(() => setTick((v) => v + 1), 5_000); return () => clearInterval(t); }, [showTip, hovLast]);

  return (
    <div ref={box} className={`bm ${className}`} style={{ height }} tabIndex={-1} role="img" aria-label="Bubble map of the coin family">
      <canvas ref={canvas} className="bm-canvas" />
      <div className="bm-vignette" aria-hidden="true" />
      {showTip && hov && (
        <div ref={tipEl} className="bm-tip" role="tooltip">
          <div className="bm-tip-head"><i style={{ background: hovColor, boxShadow: `0 0 10px ${hovColor}` }} /><b>{nameOf(hov)}</b><span className="mono">{sym(hov)}</span></div>
          <div className="bm-tip-row"><em>depth</em><strong className={`depth d${Math.min(hov.depth, 3)}`}>d{hov.depth}</strong></div>
          {hov.mcapUsd != null && <div className="bm-tip-row"><em>mcap</em><strong>{usd(hov.mcapUsd)}</strong></div>}
          {lockedUi && hov.lockedUsd != null && <div className="bm-tip-row"><em>locked by children</em><strong>{usd(hov.lockedUsd)}</strong></div>}
          <div className="bm-tip-row"><em>children</em><strong>{count(hov.children)}</strong></div>
          {hovT1h > 0 && <div className="bm-tip-row"><em>trades 1h</em><strong>{count(hovT1h)}</strong></div>}
          {hovLast > 0 && <div className="bm-tip-row"><em>last trade</em><strong>{ago(Math.floor(hovLast / 1000))}</strong></div>}
          {parentOf && <div className="bm-tip-under">↳ under {sym(parentOf)}</div>}
          {hov.migrated && <div className="bm-tip-under good">graduated · PumpSwap</div>}
          {hov.ours && <div className="bm-tip-under accent">launched on Spore</div>}
          <div className="bm-tip-cta">{hovFlags & F_FOCUS ? "this coin" : onSelect ? "click to select" : "click to open"}</div>
        </div>
      )}
      {cl && clRoot && (
        <div ref={tipEl} className="bm-tip bm-tip-cluster" role="tooltip">
          <div className="bm-tip-head"><i style={{ background: COLORS[0], boxShadow: `0 0 10px ${COLORS[0]}` }} /><b>{nameOf(clRoot)}</b><span className="mono">{sym(clRoot)}</span></div>
          <div className="bm-tip-row"><em>coins</em><strong>{count(cl.members.length)}</strong></div>
          {lockedUi && <div className="bm-tip-row"><em>locked</em><strong>{usd(clRoot.lockedUsd)}</strong></div>}
          <div className="bm-tip-row"><em>mcap Σ</em><strong>{usd(cl.mcapSum)}</strong></div>
          {clusterInfo?.(cl.id)}
          {clTop.length > 0 && <ul className="bm-tip-list">{clTop.map((d) => <li key={d.mint}><b>{sym(d)}</b><span>{usd(d.mcapUsd)}</span></li>)}</ul>}
          <div className="bm-tip-cta">click to open this tree</div>
        </div>
      )}
      <div className="bm-controls" role="group" aria-label="Map controls">
        <button type="button" onClick={() => scaleBy(1.5)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" onClick={() => scaleBy(1 / 1.5)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" onClick={fit} aria-label="Fit to view" title="Fit"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" /></svg></button>
      </div>
      {lockedUi && (
        <div className="bm-size seg" role="group" aria-label="Size bubbles by">
          <span className="bm-size-label">size</span>
          <button type="button" aria-pressed={mode === "locked"} onClick={() => changeMode("locked")}>locked</button>
          <button type="button" aria-pressed={mode === "mcap"} onClick={() => changeMode("mcap")}>mcap</button>
        </div>
      )}
      {!hideLegend && (
        <div className="bm-legend">
          {focus && <span><i className="focus" /> this coin</span>}
          {hasAnc && <span><i style={{ borderStyle: "dashed", borderColor: COLORS[0] }} /> ancestors</span>}
          {hasOurs && <span><i style={{ borderColor: COLORS[0], borderWidth: 2, boxShadow: `0 0 6px ${hexA(COLORS[0], .6)}` }} /> launched on Spore</span>}
          <span><i style={{ background: hexA(COLORS[0], .25), borderColor: COLORS[0] }} /> root</span>
          <span><i style={{ background: hexA(COLORS[1], .25), borderColor: COLORS[1] }} /> d1</span>
          <span><i style={{ background: hexA(COLORS[2], .25), borderColor: COLORS[2] }} /> d2</span>
          <span className="muted bm-legend-note" title={`Dots travel from child to parent the way buys do: every buy of a child buys its parent first.${focus ? "" : " A tree's centre bubble is sized by its whole family."}`}>area = {mode === "locked" ? "locked value" : "market cap"}</span>
        </div>
      )}
    </div>
  );
}

/// Centre a node at a zoom that makes it readable (≥ 70 px across, never below the current zoom).
function centerOnNode(s: State, i: number): ZoomTransform {
  const il = s.inset?.left ?? 0, it = s.inset?.top ?? 0, ib = s.inset?.bottom ?? 0, ir = s.inset?.right ?? 0;
  const k = Math.max(s.t.k, Math.min(3, 70 / Math.max(0.01, s.store.rT[i])));
  return zoomIdentity.translate(il + (s.w - il - ir) / 2 - k * s.store.nx[i], it + (s.h - it - ib) / 2 - k * s.store.ny[i]).scale(k);
}

/// On the coin page a coin under the focused one is drawn at most this share of maxR (the focused coin is
/// at least 0.85 × maxR), so the tree's centre stays its biggest bubble.
const FOCUS_KID_MAX = 0.7;

// Inside the card the size toggle (top right) and legend (bottom left) cover the canvas edges, so
// the fit centres on the strip between them; otherwise a leaf's pinned bubble ends up under the legend.
const CARD_INSET = { top: 44, bottom: 60 };

/// The coin page's family tree: this coin in the middle, ancestors above, descendants (3 levels)
/// around it. Fetches /api/tree itself so the page only has to place it.
export function CoinBubbleMap({ mint, height = 520 }: { mint: string; height?: number }) {
  const data = useAsync(() => api.tree(mint, 3), [mint]);
  const nodes = useMemo(() => (data.data ? flattenTree(data.data) : []), [data.data]);
  if (data.loading) return <Skeleton h={height} r={16} />;
  if (data.error && !data.data) return <ErrorBox error={data.error} retry={data.reload} />;
  return <BubbleMap nodes={nodes} focus={mint} height={height} mode="locked" className="bm-card" inset={CARD_INSET} live />;
}
