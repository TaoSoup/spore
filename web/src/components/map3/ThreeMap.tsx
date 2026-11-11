// /map's WebGL renderer (map3 spec section 6): the React shell around the JS engine in ./engine.
//
// - Data: the page's already-loaded nodes, heat and the tab's one event stream, through ./adapter and
//   ./use-engine-sync. Nothing here fetches or opens a stream.
// - Engines: one per build, mounted into its own div.m3-layer that this component creates imperatively
//   (never a React child). A build runs for the first paint and for a change of size mode, roots limit
//   or phone band, an unknown selection, drift and a lost context; never per data version. The new
//   engine renders hidden (.pending) while the old one stays on screen; on success the old layer fades
//   (.out) and is destroyed 160 ms later. At rest exactly one engine is alive; an unmount aborts any
//   build in flight and destroys everything (StrictMode's double effects included).
// - The page owns selection (?focus): the engine reports clicks through onSelect, the page answers with
//   the `select` prop, and the echo below only acts when the two differ. Insets and the page chrome's
//   rects (obstacles for the labels) reach the engine before the echo in the same commit, so a flight
//   lands in the area the side panel or sheet leaves visible.
// - Failure: a missing WebGL2 context, a build error, a chunk that fails or a context lost three times
//   hands over to the classic renderer through onFallback (one console.warn, never console.error).
// - (family-all, DESIGN-FAMILY-ALL.md §5.4) every coin of a capped asset family: the engine draws ghosts by itself and asks
//   for the families on screen (onSwarmWant -> families.want(tops, "view")); the store's pages reach it as swarmAdd, its
//   evictions as swarmDrop, and every (re)build replays the loaded chunks of the engine's ghosted families. A selection
//   inside a family that is still loading waits for its chunk (the select echo re-runs on the store's version) instead
//   of rebuilding. ?swarm=0 (debug builds / ?debug) turns the layer off for an A/B.
// - The Key's last-trade filter (`last`, a 4-bit mask, and `pinned`, the selection's lineage). (compact layout, 2026-11-10) A
//   mask change REBUILDS (reason "last", once the toggles settled and the map is still: LAST_SETTLE_MS) from
//   lib/map/visibility.ts buildSet: the shown coins, all their ancestors (dim
//   anchors) and the pins; a family with nothing shown is left out. So every family is laid out compactly around what is
//   shown (a $PUMP with 40 shown children is framed on those 40, not on 14.5k), while its chip, share, rank and size label
//   stay whole-family (adapter.ts familyTotals -> EngineOptions.compact). Mask 15 (and no heat yet) builds from the whole
//   node list exactly as before. Between builds the engine hides in place (setLastFilter): a coin that ages out fades where it
//   is, the engine on screen hides at once (the Key's mask within the build's) while the new one builds, and a page coin that
//   comes into view (a trade, a heat poll, a node pass, a page hover, a new pair's parent) is added live next to its parent
//   (EngineHandle.reveal, no new-pair fanfare); the sync re-compacts when idle (adapter.ts shouldRebuild, filtered branch).
//   `pinned` never rebuilds by itself; a page selection the build left out (a search, rail or ?focus pick) is shown at once as
//   a stand-in and rebuilt right away as select-unknown (its pins bring it, its lineage and its family in; a Dominance row of a
//   family the build left out selects its top through fitCluster, the same rebuild). The drift never re-compacts while a coin
//   card is open, and the drags of a galaxy map and a mode switch's family order only follow the engine that landed. ?hl never
//   rebuilds and never removes a coin. The page and this map share one heat (the page's useMapHeat, which starts a warm reopen
//   from the previous mount's index: lib/map/heat.ts warmHeat), so the mask the page reports is the one the engine applies;
//   the first build waits longer for the heat when the page wants a filter (so it is built filtered once, not full then
//   filtered), and always for the node list's source (never from a few live pairs that beat the snapshot).
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EngineError, mountEngine, type EngineCallbacks, type EngineFrameStats, type EngineHandle, type EngineImages, type EngineRect } from "./engine/index.js";
import { buildRoots, familyTotals, heatPayload, keepsOrder, movedFor, movedLanded, PHONE_BAND_PX, reducedMotionNow, tagFn, valueFn, valueFns, WIDE_PX, type BuiltInput, type MovedMaps, type WholeTotals } from "./adapter";
import { buildSet, LAST_ALL } from "../../lib/map/visibility";
import { useEngineSync } from "./use-engine-sync";
import { registerMap3Debug } from "./debug-hooks";
import { imageFailed, imageFor, imageReady, imageRetryAt, onImageLoaded, registerLogoMints } from "../../lib/map/images";
import { DEBUG_HOOKS } from "../../lib/map/debug";
import type { BubbleNode, RootsLimit, SizeMode } from "../../lib/map/types";
import type { FallbackReason, ThreeMapHandle, ThreeMapProps } from "./types";
import "./map3.css";

type BuildReason = "first" | "mode" | "limit" | "band" | "last" | "select-unknown" | "drift" | "context";
type Rebuild = { n: number; reason: BuildReason };
/// mask: the Key's last-trade mask the build was made from (15 = the whole node list); filtered: set once its engine landed
/// (it was built from buildSet's filtered set)
type BuildParts = { mode: SizeMode; limit: RootsLimit; band: boolean; mask: number; n: number; filtered?: boolean };
/// (compact layout) the whole-family inputs of one node list, reused by every build of the same list (a quick run of toggles)
type FullPrep = { nodes: readonly BubbleNode[]; full: BuiltInput; fns: ReturnType<typeof valueFns>; whole: WholeTotals | null };
type Job = { ctrl: AbortController; settled: boolean };
type Retiring = { h: EngineHandle; layer: HTMLDivElement; t: ReturnType<typeof setTimeout> | null };

/// The page chrome that floats over the map (spec 6.5): planet labels and callouts keep clear of it.
const OBSTACLES = ".map-overlay > *, .map-key, .map-side, .map-sheet, .map-toast";
/// The first build waits this long for the heat sidecar, so the first frame already shows the trade colours.
const FIRST_BUILD_WAIT_MS = 1_200;
/// A width that crosses the phone band must hold this long before the engine is rebuilt for it.
const BAND_DEBOUNCE_MS = 300;
/// "Building the map…" appears only for a build slower than this.
const STATUS_AFTER_MS = 300;
/// The old engine's layer fades out over this, then it is destroyed (the CSS transition is --m3-t-s).
const SWAP_MS = 160;
/// A selection the engine does not know rebuilds at most this often (and once per mint).
const SELECT_UNKNOWN_MS = 30_000;
/// (compact layout) ... on a filtered build, where an explicit pick of a coin the build left out (search, a rail, ?focus) rebuilds
/// at once: the cap only spaces a quick run of such picks (one waiting inside it is retried when it ends).
const SELECT_UNKNOWN_FILTERED_MS = 3_000;
/// (compact layout) the first build waits this long for the heat when the page wants a filter, so it is built filtered once
/// (a full build first would be the most expensive one, then thrown away for the filtered one).
const FIRST_BUILD_WAIT_FILTERED_MS = 4_000;
/// (compact layout) the first build waits for the node list itself (data.source: the IndexedDB cache or the network), at most
/// this long after mount: a live pair that arrives before the snapshot must not become a 2-coin map.
const FIRST_BUILD_WAIT_SOURCE_MS = 10_000;
/// (compact layout) an engine built from a node list this many times smaller than the current one (and at least TINY_MIN
/// coins smaller), within TINY_WINDOW_MS of its build, is rebuilt at once (a safety net behind the source wait).
const TINY_FACTOR = 10, TINY_MIN = 500, TINY_WINDOW_MS = 60_000;
/// (compact layout) a Key toggle rebuilds once the mask held this long and the map has been still (no press, wheel, touch or
/// camera move) for LAST_STILL_MS, or at the latest LAST_MAX_WAIT_MS after the toggle; meanwhile the engine on screen fades in
/// place (use-engine-sync applies the Key's mask within the build's).
const LAST_SETTLE_MS = 450, LAST_STILL_MS = 700, LAST_MAX_WAIT_MS = 5_000;
/// A lost WebGL context is rebuilt this many times per mount; the next loss falls back to the classic map.
const MAX_CONTEXT_REBUILDS = 2;
/// Engine exceptions caught in this component's effects are logged this many times per mount.
const MAX_ERRORS = 3;

const IMAGES: EngineImages = { want: imageFor, onLoaded: onImageLoaded, ready: imageReady, failed: imageFailed, retryAt: imageRetryAt };
/// (logos that come later, 2026-11-10) A new engine is handed every node's logo URL once, this long after it mounted: the
/// node list may have changed while it was building (a since= delta right after a cache paint is the usual case), and the
/// sync's first node pass (use-engine-sync, <= 1 s after the mount) only records what it sees, so a logo that arrived in
/// between would never reach the bubbles. The engine skips unchanged URLs; later changes come as node patches.
const IMAGE_RECONCILE_MS = 2_500;
/// (family-all) ?swarm=0 on a debug build (dev, or ?debug) mounts without the swarm layer: the A/B for every look pair.
const SWARM_ON = !(DEBUG_HOOKS && typeof location !== "undefined" && /[?&]swarm=0(&|$)/.test(location.search));
const zeroStats = (): EngineFrameStats => ({ frames: 0, settling: { n: 0, avg: 0, p95: 0, max: 0 }, settled: { n: 0, avg: 0, p95: 0, max: 0 }, labels: 0, drawn: 0 });

const errCode = (e: unknown): string | null => {
  if (e instanceof EngineError) return e.code;
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") return (e as { code: string }).code;
  return null;
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const destroyQuietly = (h: EngineHandle) => { try { h.destroy(); } catch { /* already torn down */ } };

/// The chrome elements over the map: the page's overlays plus this map's own controls.
function obstacleEls(root: HTMLElement): Element[] {
  const out: Element[] = [];
  const page = root.closest(".map-page");
  if (page) { const list = page.querySelectorAll(OBSTACLES); for (let i = 0; i < list.length; i++) out.push(list[i]); }
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) { const el = kids[i]; if (el.classList.contains("bm-controls") || el.classList.contains("bm-size")) out.push(el); }
  return out;
}

/// Their boxes in root-relative CSS px; hidden (zero-size) ones are skipped.
function collectObstacles(root: HTMLElement | null): EngineRect[] {
  if (!root) return [];
  const rr = root.getBoundingClientRect();
  const out: EngineRect[] = [];
  for (const el of obstacleEls(root)) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    out.push({ x0: r.left - rr.left, y0: r.top - rr.top, x1: r.right - rr.left, y1: r.bottom - rr.top });
  }
  return out;
}

export default function ThreeMap(props: ThreeMapProps) {
  const { nodes, byMint, limit, source, mode, onModeChange, inset, fitInset, select, fresh, highlight, heat, streamStatus, titleTags, titleTagsCompact, last, pinned } = props;
  const lastWant = props.lastWant ?? last;
  const families = props.families ?? null;
  const familiesRef = useRef(families); familiesRef.current = families;
  const rootRef = useRef<HTMLDivElement>(null);
  const [mountedAt] = useState(() => performance.now());
  // the look is fixed per page load (Map.tsx reads ?look once): not a BuildPart, never a rebuild
  const look: "galaxy" | "flat" = props.look === "galaxy" ? "galaxy" : "flat";
  const lookRef = useRef(look);

  // ---- the latest props, for the engine callbacks, the handle and the builds (read at call time)
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const byMintRef = useRef(byMint); byMintRef.current = byMint;
  const heatRef = useRef(heat); heatRef.current = heat;
  const selectRef = useRef(select); selectRef.current = select;
  const insetRef = useRef(inset); insetRef.current = inset;
  const fitInsetRef = useRef(fitInset); fitInsetRef.current = fitInset;
  const streamRef = useRef(streamStatus); streamRef.current = streamStatus;
  const sourceRef = useRef(source); sourceRef.current = source;
  const onSelectRef = useRef(props.onSelect); onSelectRef.current = props.onSelect;
  const onHoverRef = useRef(props.onHover); onHoverRef.current = props.onHover;
  const onCameraRef = useRef(props.onCamera); onCameraRef.current = props.onCamera;
  const onFallbackRef = useRef(props.onFallback); onFallbackRef.current = props.onFallback;
  const tagsWideRef = useRef(titleTags); tagsWideRef.current = titleTags;
  const tagsCompactRef = useRef(titleTagsCompact); tagsCompactRef.current = titleTagsCompact;
  // the last-trade filter: the mask is a BuildPart (a change rebuilds from the filtered set); the pins never rebuild (a build
  // starts with both in force, so it never flashes everything)
  const lastRef = useRef(last); lastRef.current = last;
  const pinnedRef = useRef(pinned); pinnedRef.current = pinned;
  const prepRef = useRef<FullPrep | null>(null);

  // ---- engine bookkeeping
  const engineRef = useRef<EngineHandle | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<Job | null>(null);
  const retiringRef = useRef(new Set<Retiring>());
  /// The key of the engine on screen and of the last build started (aborted ones included).
  const builtPartsRef = useRef<BuildParts | null>(null);
  const startedPartsRef = useRef<BuildParts | null>(null);
  const aliveRef = useRef(true);
  const failedRef = useRef(false);
  const errorsRef = useRef(0);
  const buildsRef = useRef(0);
  const lastBuildRef = useRef<Record<string, unknown> | null>(null);
  const dataAtRef = useRef(0);
  const firstPaintRef = useRef(0);
  const lastInteractRef = useRef(0);
  /// (compact layout) the last press, wheel, touch or camera move on the map (not a bare pointer move): a Key toggle's rebuild
  /// waits for LAST_STILL_MS of this
  const activeRef = useRef(0);
  const selRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextRebuildsRef = useRef(0);
  const selUnknownRef = useRef<{ mint: string | null; at: number }>({ mint: null, at: -Infinity });
  /// (galaxy) where the viewer dragged coins, by mint (the engine's onMoved entries, merged): every rebuild of this mount
  /// (mode, limit, band, select-unknown, drift, context) passes it back as opts.moved, so a dropped coin stays dropped.
  /// It lives only as long as this mount; nothing is stored beyond the page. (compact layout) offsets are relative to the
  /// designed spots, and a filtered build designs other spots: a full build keeps `full`, filtered builds keep `filt` for as
  /// long as the mask of the filtered engine on screen stays the same (a new mask starts it empty once that build lands:
  /// adapter.ts movedFor / movedLanded, so a build that is aborted changes nothing).
  const movedRef = useRef<MovedMaps>({ full: new Map(), filt: new Map(), filtMask: -1 });
  const reconcileRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /// all: the length of the node list the engine was built from (the tiny-build safety net); cacheInput: (compact layout) a Key
  /// filter's build (filtered, or a toggle's) made from the IndexedDB cache's list, before the network sync (the quick cache rule)
  const [live, setLive] = useState<{ engine: EngineHandle; builtAt: number; filtered: boolean; mask: number; all: number; cacheInput: boolean } | null>(null);
  const engine = live?.engine ?? null;
  const liveRef = useRef(live); liveRef.current = live;
  const [rebuild, setRebuild] = useState<Rebuild>({ n: 0, reason: "first" });
  const [fromCache, setFromCache] = useState(false);
  const [slow, setSlow] = useState(false);

  // ---- container width: the phone band (debounced; a crossing rebuilds) and the wide/compact tags
  const [width, setWidth] = useState(0);
  const [band, setBand] = useState<boolean | null>(null);
  const tags = width > WIDE_PX ? titleTags : titleTagsCompact;
  const tagsRef = useRef(tags); tagsRef.current = tags;

  const guard = useCallback((f: () => void) => {
    try { f(); } catch (e) { if (errorsRef.current++ < MAX_ERRORS) console.error("map3", e); }
  }, []);

  const fail = useCallback((reason: FallbackReason, err?: unknown) => {
    if (failedRef.current || !aliveRef.current) return;
    failedRef.current = true;
    console.warn("map3: the WebGL map cannot run here", reason, err ?? "");
    onFallbackRef.current(reason, err == null ? undefined : errMsg(err));
  }, []);

  /// Asks for a fresh engine; false when one is already being built (a context loss always goes through).
  const requestRebuild = useCallback((reason: BuildReason): boolean => {
    if (!aliveRef.current || failedRef.current) return false;
    if (reason !== "context" && pendingRef.current) return false;
    setRebuild((r) => ({ n: r.n + 1, reason }));
    return true;
  }, []);

  const onContextLost = useCallback(() => {
    if (contextRebuildsRef.current >= MAX_CONTEXT_REBUILDS) { fail("context-lost"); return; }
    contextRebuildsRef.current++;
    requestRebuild("context");
  }, [fail, requestRebuild]);

  // ---- unmount: abort the build in flight, destroy every engine, drop the layers
  useEffect(() => {
    aliveRef.current = true;
    const retiring = retiringRef.current;
    return () => {
      aliveRef.current = false;
      pendingRef.current?.ctrl.abort();
      pendingRef.current = null;
      for (const r of retiring) { if (r.t) clearTimeout(r.t); destroyQuietly(r.h); r.layer.remove(); }
      retiring.clear();
      if (reconcileRef.current) { clearTimeout(reconcileRef.current); reconcileRef.current = null; }
      const h = engineRef.current;
      engineRef.current = null;
      if (h) destroyQuietly(h);
      layerRef.current?.remove();
      layerRef.current = null;
      builtPartsRef.current = null;
      startedPartsRef.current = null;
    };
  }, []);

  // ---- the first build waits for the heat sidecar, or FIRST_BUILD_WAIT_MS after mount. A warm reopen (SPA back to /map)
  // builds at once: the page's heat then starts from the previous mount's index (lib/map/heat.ts warmHeat; measured: waiting
  // for the first poll took a warm reopen from ~0.4 s to 1.65 s when the heat answer was slow), and the fresh poll follows
  // through setHeat (its `at` is newer). One heat for the page and the engine: the build starts with the mask the page reports.
  // (compact layout) a page that wants a filter (lastWant != 15) waits up to FIRST_BUILD_WAIT_FILTERED_MS: without heat the build
  // would be the full one, and the heat's arrival would rebuild it filtered right after the first paint.
  const [gate, setGate] = useState(() => heat != null);
  const wantsFilter = (lastWant & LAST_ALL) !== LAST_ALL;
  useEffect(() => {
    if (gate) return;
    if (heat) { setGate(true); return; }
    const wait = wantsFilter ? FIRST_BUILD_WAIT_FILTERED_MS : FIRST_BUILD_WAIT_MS;
    const t = setTimeout(() => setGate(true), Math.max(0, wait - (performance.now() - mountedAt)));
    return () => clearTimeout(t);
  }, [gate, heat, mountedAt, wantsFilter]);

  // (compact layout) the node list's source has answered (cache or network), or FIRST_BUILD_WAIT_SOURCE_MS passed: flips once
  const [sourced, setSourced] = useState(() => source !== null);
  useEffect(() => {
    if (sourced) return;
    if (source !== null) { setSourced(true); return; }
    const t = setTimeout(() => setSourced(true), Math.max(0, FIRST_BUILD_WAIT_SOURCE_MS - (performance.now() - mountedAt)));
    return () => clearTimeout(t);
  }, [sourced, source, mountedAt]);

  // (compact layout) the mask the builds use: the Key's at once until the first build started, then after the toggles settled
  // and the map is still (LAST_SETTLE_MS). In between the engine on screen fades in place.
  const [buildLast, setBuildLast] = useState(last);
  useEffect(() => {
    if (buildLast === last) return;
    if (!startedPartsRef.current) { setBuildLast(last); return; }
    const t0 = performance.now();
    let id: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const now = performance.now();
      if (now - activeRef.current < LAST_STILL_MS && now - t0 < LAST_MAX_WAIT_MS) { id = setTimeout(tick, 200); return; }
      id = null;
      setBuildLast(last);
    };
    id = setTimeout(tick, LAST_SETTLE_MS);
    return () => { if (id) clearTimeout(id); };
  }, [last, buildLast]);

  // ---- resize: the engine follows the container; the band flips after BAND_DEBOUNCE_MS
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const w0 = root.clientWidth;
    setWidth(w0);
    setBand(w0 <= PHONE_BAND_PX);
    if (typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      const w = root.clientWidth;
      setWidth(w);
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; setBand(w <= PHONE_BAND_PX); }, BAND_DEBOUNCE_MS);
      const e = engineRef.current;
      if (e) guard(() => e.resize());
    });
    ro.observe(root);
    return () => { ro.disconnect(); if (t) clearTimeout(t); };
  }, [guard]);

  // ---- builds: one per (mode, limit, band) and per explicit rebuild
  useEffect(() => {
    if (!gate || !sourced || band === null || failedRef.current) return;
    const root = rootRef.current;
    if (!root || nodesRef.current.length === 0) return;
    const mask = buildLast & LAST_ALL;
    const parts: BuildParts = { mode, limit, band, mask, n: rebuild.n };
    const same = (a: BuildParts | null) => !!a && a.mode === mode && a.limit === limit && a.band === band && a.mask === mask && a.n === rebuild.n;
    // A key that went away and came back while its build was pending (a quick double toggle) needs no new engine.
    if (engineRef.current && same(builtPartsRef.current)) { startedPartsRef.current = parts; return; }
    const was = startedPartsRef.current;
    startedPartsRef.current = parts;
    const reason: BuildReason = !was ? "first" : was.mode !== mode ? "mode" : was.limit !== limit ? "limit" : was.band !== band ? "band" : was.mask !== mask ? "last" : rebuild.reason;
    if (dataAtRef.current === 0) { dataAtRef.current = performance.now(); setFromCache(sourceRef.current === "cache"); }

    const ctrl = new AbortController();
    const job: Job = { ctrl, settled: false };
    pendingRef.current = job;
    const layer = document.createElement("div");
    layer.className = "m3-layer pending";
    root.prepend(layer);
    const slowT = setTimeout(() => { if (!job.settled && aliveRef.current) setSlow(true); }, STATUS_AFTER_MS);
    const settle = () => {
      job.settled = true;
      clearTimeout(slowT);
      const mine = pendingRef.current === job;
      if (mine) pendingRef.current = null;
      if (aliveRef.current && (mine || !pendingRef.current)) setSlow(false);
    };

    // Callbacks act only while their engine is the one on screen (a fading or pending one is ignored).
    const slot: { h: EngineHandle | null } = { h: null };
    const current = () => slot.h !== null && engineRef.current === slot.h;
    const callbacks: EngineCallbacks = {
      onSelect: (mint) => {
        if (!current()) return;
        if (mint == null) { onSelectRef.current(null); return; }
        // a drawn coin, else a loaded speck of a capped family (the store's node)
        const n = byMintRef.current.get(mint) ?? familiesRef.current?.node(mint) ?? null;
        if (n) onSelectRef.current(n);
      },
      onHover: (mint) => { if (current()) onHoverRef.current?.(mint); },
      onCamera: (c) => { if (!current()) return; lastInteractRef.current = activeRef.current = performance.now(); onCameraRef.current(c); },
      onFirstFrame: () => { if (firstPaintRef.current === 0 && !ctrl.signal.aborted) firstPaintRef.current = performance.now(); },
      onLost: () => { if (current()) onContextLost(); },
      onSwarmWant: (tops) => {
        if (!current() || !Array.isArray(tops)) return;
        try { familiesRef.current?.want(tops, "view"); } catch (e) { if (errorsRef.current++ < MAX_ERRORS) console.error("map3", e); }
      },
      onMoved: (entries) => {
        if (!current() || !Array.isArray(entries)) return;
        const m = moved.map;
        for (const e of entries) if (e && typeof e.mint === "string" && Number.isFinite(e.dx) && Number.isFinite(e.dy)) m.set(e.mint, { dx: e.dx, dy: e.dy });
      },
    };

    // (compact layout) the input: the whole node list (mask 15, or no heat yet: exactly as before), else buildSet's filtered
    // set; family values, shares, ghosts and the layout seeds always come from the whole list (cached per node list). The prep
    // runs in up to three macrotasks (the whole list's tree, its family totals, the filtered set), each one only when it has
    // work, so a Key toggle's prep never becomes one long task; an abort in between stops it (the rejection below is ignored).
    const builtNodes = nodesRef.current, builtByMint = byMintRef.current, cacheList = sourceRef.current === "cache";
    registerLogoMints(builtNodes); // source -> mint for the logo sheets, before the engine asks for any logo
    const moved: { map: Map<string, { dx: number; dy: number }> } = { map: movedRef.current.full };
    let filtered = false, buildInfo: Record<string, unknown> = {}, w0 = 0, h0 = 0;
    const nextTask = () => new Promise<void>((res) => setTimeout(res, 0));
    const stillOn = () => { if (ctrl.signal.aborted || !aliveRef.current) throw new EngineError("aborted", "aborted"); };
    const start = async (): Promise<EngineHandle> => {
      let busy = 0, t0 = performance.now();
      const all = builtNodes;
      let p = prepRef.current;
      if (!p || p.nodes !== all) {
        const full = buildRoots(all); p = { nodes: all, full, fns: valueFns(full.roots), whole: null }; prepRef.current = p;
        busy += performance.now() - t0; await nextTask(); stillOn(); t0 = performance.now();
      }
      const filterOn = mask !== LAST_ALL && !!heatRef.current;
      if (filterOn && !p.whole) {
        p.whole = familyTotals(p.full, p.fns);
        busy += performance.now() - t0; await nextTask(); stillOn(); t0 = performance.now();
      }
      const prep = p, whole = p.whole;
      // a capped asset family whose ghosts the mask draws (class 3) keeps its top even with nothing of its slice shown; buckets
      // that hold nothing at all (and nothing pinned) keep every top, all hidden (emptyTops: still a compact, cheap build that
      // the coins coming into those buckets are added to, not the whole map hidden)
      const keepTop = (n: BubbleNode) => (mask & 8) !== 0 && (whole?.families.get(n.mint)?.ghost ?? 0) > 0;
      let set = filterOn ? buildSet(all, builtByMint, mask, heatRef.current, pinnedRef.current, { keepTop, emptyTops: true }) : buildSet(all, builtByMint, LAST_ALL, null);
      let input: BuiltInput = set.filtered ? buildRoots(set.nodes) : prep.full;
      if (input.count === 0) { input = prep.full; set = { ...set, nodes: all, filtered: false }; }   // no node at all (a safety net): the whole map
      busy += performance.now() - t0;
      filtered = set.filtered && !!whole;
      const compact = filtered && whole ? { mask, lookup: (m: string) => byMintRef.current.get(m) ?? null, ...whole } : undefined;
      // the drags this build starts from and records into (MovedMaps; a filtered build of a new mask takes its own map only
      // when it lands, below)
      moved.map = movedFor(movedRef.current, filtered, mask);
      let focusFamily: string | null = null;
      try { focusFamily = engineRef.current?.focusedFamily() ?? null; } catch { focusFamily = null; }
      // a bucket toggle while zoomed in keeps the family the view is on (null at the overview: the new build fits all)
      if (!focusFamily && reason === "last") { try { focusFamily = engineRef.current?.viewFamily() ?? null; } catch { focusFamily = null; } }
      // A size-mode switch keeps the family order of the engine on screen (SPEC 3.3: the planet set and order are mode-independent);
      // only an engine built with this mask (the last build started may be an aborted one of another), and not a filtered
      // engine's order into a full build (it lists only the families it held): adapter.ts keepsOrder.
      let order: string[] | undefined;
      const shown = builtPartsRef.current;
      if (reason === "mode" && keepsOrder(shown ? { mask: shown.mask, filtered: !!shown.filtered } : null, mask, filtered)) { try { order = engineRef.current?.familyOrder() ?? undefined; } catch { order = undefined; } }
      w0 = root.clientWidth; h0 = root.clientHeight;
      // rootsKept: buildSet's families (the engine's own `families` build stat stays as it is)
      buildInfo = { filtered, mask, built: input.count, all: builtNodes.length, shown: set.shown, anchors: set.anchors, pins: set.pins, kept: set.kept, rootsKept: set.families, dropped: set.dropped, prepMs: Math.round(busy * 10) / 10 };
      return mountEngine(layer, {
        roots: input.roots, heat: heatPayload(heatRef.current), valueOf: valueFn(mode, prep.full.roots), values: prep.fns, order, mode, tagOf: tagFn(tagsRef.current),
        inset: insetRef.current, fitInset: fitInsetRef.current, obstacles: collectObstacles(root),
        reducedMotion: reducedMotionNow(), feed: streamRef.current === "live" ? "up" : "down", images: IMAGES,
        select: selectRef.current, focusFamily, callbacks, look: lookRef.current, moved: moved.map, swarm: SWARM_ON,
        last: { mask: filtered ? lastRef.current & mask : lastRef.current, pinned: pinnedRef.current }, compact,
        debug: DEBUG_HOOKS, signal: ctrl.signal, failForTest: DEBUG_HOOKS && typeof location !== "undefined" && location.search.includes("m3fail"),
      });
    };

    // (a throw in the prep or from mountEngine becomes a rejection, so it falls back instead of crashing the page)
    start().then((h) => {
      settle();
      if (ctrl.signal.aborted || !aliveRef.current || failedRef.current) { destroyQuietly(h); layer.remove(); return; }
      slot.h = h;
      const old = engineRef.current, oldLayer = layerRef.current;
      if (old && oldLayer) {
        oldLayer.classList.add("out");
        const r: Retiring = { h: old, layer: oldLayer, t: null };
        r.t = setTimeout(() => { retiringRef.current.delete(r); destroyQuietly(old); oldLayer.remove(); }, SWAP_MS);
        retiringRef.current.add(r);
      } else if (old) destroyQuietly(old);
      layer.classList.remove("pending");
      engineRef.current = h;
      layerRef.current = layer;
      builtPartsRef.current = { ...parts, filtered };
      movedLanded(movedRef.current, filtered, mask, moved.map);
      buildsRef.current++;
      let stats: Record<string, unknown> = {};
      try { stats = h.debug?.build() ?? {}; } catch { stats = {}; }
      lastBuildRef.current = { reason, ...stats, ...buildInfo };
      if (root.clientWidth !== w0 || root.clientHeight !== h0) guard(() => h.resize());
      setLive({ engine: h, builtAt: performance.now(), filtered, mask, all: builtNodes.length, cacheInput: cacheList && (filtered || reason === "last") });
      guard(() => onCameraRef.current({ k: h.zoom() }));
      if (reconcileRef.current) clearTimeout(reconcileRef.current);
      reconcileRef.current = setTimeout(() => {
        reconcileRef.current = null;
        const now = nodesRef.current;
        if (engineRef.current === h && now !== builtNodes) guard(() => { h.patchImages(now); });
      }, IMAGE_RECONCILE_MS);
    }, (err: unknown) => {
      settle();
      layer.remove();
      if (ctrl.signal.aborted || errCode(err) === "aborted" || !aliveRef.current) return;
      fail(errCode(err) === "webgl" ? "webgl" : "mount-error", err);
    });

    return () => { if (!job.settled) { clearTimeout(slowT); ctrl.abort(); } };
  }, [gate, sourced, band, mode, limit, buildLast, rebuild, fail, guard, onContextLost]);

  // (compact layout) the tiny-build safety net: an engine built from a node list far smaller than the one now (a few live pairs
  // that beat the snapshot, past the source wait) is rebuilt at once, not after the drift rule's 10 min
  const tinyRef = useRef<EngineHandle | null>(null);
  const nNodes = nodes.length;
  useEffect(() => {
    if (!live || pendingRef.current || tinyRef.current === live.engine) return;
    if (nNodes > Math.max(TINY_FACTOR * live.all, live.all + TINY_MIN) && performance.now() - live.builtAt < TINY_WINDOW_MS) {
      tinyRef.current = live.engine;
      requestRebuild("drift");
    }
  }, [nNodes, live, requestRebuild]);

  // ---- insets and obstacles (before the select echo: a flight must land in the new visible area)
  useLayoutEffect(() => {
    if (!engine) return;
    const rects = collectObstacles(rootRef.current);
    guard(() => engine.setInset(inset, fitInset, rects));
  }, [inset, fitInset, select, width, engine, guard]);

  // The chrome moves without a prop change (Key opened, a popover, a toast, the sheet dragged): watch it.
  useEffect(() => {
    const root = rootRef.current;
    if (!engine || !root || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const e = engineRef.current;
      if (e) guard(() => e.setInset(insetRef.current, fitInsetRef.current, collectObstacles(root)));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
    const ro = new ResizeObserver(schedule);
    const observeAll = () => { ro.disconnect(); for (const el of obstacleEls(root)) ro.observe(el); };
    observeAll();
    const page = root.closest(".map-page");
    const overlay = page?.querySelector(".map-overlay") ?? null;
    const mo = typeof MutationObserver === "function" ? new MutationObserver(() => { observeAll(); schedule(); }) : null;
    if (mo && page) mo.observe(page, { childList: true });
    if (mo && overlay) mo.observe(overlay, { childList: true });
    return () => { ro.disconnect(); mo?.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [engine, guard]);

  // ---- select echo: the page's ?focus → the engine (a click the engine already made is a no-op)
  const echoRef = useRef<{ select: string | null | undefined; engine: EngineHandle | null; waiting: string | null }>({ select: undefined, engine: null, waiting: null });
  // (family-all) the store's version while a selection waits for its family's chunk (no re-render per page otherwise)
  const [famVer, setFamVer] = useState(0);
  useEffect(() => {
    if (!engine) return;
    const prev = echoRef.current;
    const changed = prev.select !== select || prev.engine !== engine;
    const waiting = changed ? null : prev.waiting;
    echoRef.current = { select, engine, waiting: null };
    // (compact layout) a filtered build rebuilds for an explicit pick it left out: once per mint, at most every
    // SELECT_UNKNOWN_FILTERED_MS (a pick inside that window is retried when it ends; a build in flight answers false, and its
    // landing re-runs this echo with the new engine)
    const filtered = !!liveRef.current?.filtered;
    const rebuildFor = (m: string) => {
      const s = selUnknownRef.current, now = performance.now();
      if (s.mint === m) return;
      const wait = s.at + SELECT_UNKNOWN_FILTERED_MS - now;
      if (wait > 0) {
        if (selRetryRef.current) clearTimeout(selRetryRef.current);
        selRetryRef.current = setTimeout(() => { selRetryRef.current = null; if (aliveRef.current) setFamVer((v) => v + 1); }, wait + 20);
        return;
      }
      if (requestRebuild("select-unknown")) selUnknownRef.current = { mint: m, at: now };
    };
    guard(() => {
      if (select === engine.selected()) {
        // (compact layout) a selection that is only a revealed stand-in still wants its build
        if (filtered && select != null && engine.driftStats().select) rebuildFor(select);
        return;
      }
      if (select == null) { if (changed) engine.select(null); return; }
      if (engine.knows(select)) {
        // a new selection, or one that waited for its coin to arrive (a birth)
        if (changed || waiting === select) engine.select(select, { fly: true });
        return;
      }
      echoRef.current.waiting = select;
      if (filtered) {
        if (!byMintRef.current.has(select)) {
          // a coin of a capped family (a speck): wait for its chunk when the build holds its family; a family the build left
          // out (nothing of it shown) is rebuilt in (the pins carry the top: [coin, top])
          const pins = pinnedRef.current;
          const top = familiesRef.current?.familyOf(select) ?? (pins.length > 1 && pins[0] === select ? pins[pins.length - 1] : null);
          if (top && !engine.knows(top)) rebuildFor(select);
          return;
        }
        // a page coin the filtered build left out: shown at once as a stand-in next to its parent (it is the coin the panel
        // is about), and rebuilt right away with it built (the new engine opens framed on it, behind the cross-fade)
        if (engine.reveal(select, "select") === "ok" && engine.knows(select)) { echoRef.current.waiting = null; engine.select(select, { fly: true }); }
        rebuildFor(select);
        return;
      }
      if (!byMintRef.current.has(select)) return;
      // (family-all) a coin of a capped family that is loading (or loaded) is a speck to come, not a reason to rebuild
      const fam = familiesRef.current;
      if (fam && (fam.busy() || fam.familyOf(select))) return;
      const s = selUnknownRef.current, now = performance.now();
      if (s.mint !== select && now - s.at >= SELECT_UNKNOWN_MS && requestRebuild("select-unknown")) selUnknownRef.current = { mint: select, at: now };
    });
  }, [select, engine, nodes, famVer, guard, requestRebuild]);
  useEffect(() => () => { if (selRetryRef.current) clearTimeout(selRetryRef.current); }, []);

  // ---- (family-all) the family store -> the engine: replay every loaded chunk of the engine's ghosted families after a
  // (re)build (swarmAdd only queues: the engine drains the rows in <= 4 ms slices, in order), then follow chunks and evictions
  useEffect(() => {
    if (!engine || !families) return;
    guard(() => {
      for (const f of engine.swarmFamilies()) for (const c of families.chunks(f.top)) engine.swarmAdd(c);
    });
    return families.subscribe((e) => {
      if (engineRef.current !== engine) return;
      guard(() => {
        if (e.kind === "chunk") engine.swarmAdd(e.chunk);
        else if (e.kind === "evict") engine.swarmDrop(e.top);
      });
      if (echoRef.current.waiting) setFamVer(families.version());
    });
  }, [engine, families, guard]);
  // a selection whose family is loaded but whose speck the engine has not drained yet: look again shortly (bounded)
  const waitTriesRef = useRef<{ mint: string | null; n: number }>({ mint: null, n: 0 });
  useEffect(() => {
    const w = echoRef.current.waiting;
    if (!engine || !families || !w) return;
    let known = false, held = false;
    try { known = engine.knows(w); held = !!families.familyOf(w); } catch { return; }
    if (known || !held) return;
    const t = waitTriesRef.current;
    if (t.mint !== w) { t.mint = w; t.n = 0; }
    if (t.n++ >= 60) return;
    const id = setTimeout(() => setFamVer((v) => v + 1), 100);
    return () => clearTimeout(id);
  }, [engine, families, famVer, select]);

  // ---- idle tracking for the drift rule (pointer, wheel, touch on the map; flights via onCamera)
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const f = (e: Event) => { const now = performance.now(); lastInteractRef.current = now; if (e.type !== "pointermove") activeRef.current = now; };
    const types = ["pointerdown", "pointermove", "wheel", "touchstart"] as const;
    for (const t of types) root.addEventListener(t, f, { passive: true });
    return () => { for (const t of types) root.removeEventListener(t, f); };
  }, []);
  const lastInteract = useCallback(() => lastInteractRef.current, []);
  const onDrift = useCallback(() => { requestRebuild("drift"); }, [requestRebuild]);

  // ---- live data: trades, pairs, heat, nodes, stream, reduced motion, highlight, tags
  useEffect(() => { registerLogoMints(nodes); }, [nodes]); // patched images arrive as new sources: keep source -> mint current for the logo sheets
  const sync = useEngineSync({
    engine, nodes, byMint, fresh, heat, streamStatus, highlight, tags, families, last, pinned,
    builtAt: live?.builtAt ?? 0, firstBuildFromCache: fromCache, lastInteract, onDrift,
    filtered: live?.filtered ?? false, buildMask: live?.mask ?? LAST_ALL, select, cacheInput: live?.cacheInput ?? false,
  });
  const syncRef = useRef(sync); syncRef.current = sync;

  // ---- the imperative handle (stable; it reads the engine on screen)
  const handle = useMemo<ThreeMapHandle>(() => {
    const select = (n: BubbleNode | undefined) => { if (n) onSelectRef.current(n); };
    return {
      renderer: "three",
      fit: () => { engineRef.current?.fit(); },
      focusNode: (mint: string) => {
        const e = engineRef.current;
        if (e?.select(mint, { fly: true })) select(byMintRef.current.get(mint));
      },
      fitCluster: (mint: string, opts?: { select?: boolean }) => {
        const e = engineRef.current;
        if (!e) return;
        if (!e.flyToFamily(mint)) {
          // (compact layout) a family the filtered build left out (a Dominance row of a family with nothing shown): select it;
          // the select echo rebuilds it in at once (select-unknown: the pins bring the top), framed on it. A full build holds
          // every family the page draws: nothing to do, as before.
          if (opts?.select !== false && liveRef.current?.filtered) select(byMintRef.current.get(mint));
          return;
        }
        if (opts?.select === false) return;
        const top = e.topOf(mint);
        if (top && e.select(top)) select(byMintRef.current.get(top));
      },
      scaleBy: (f: number) => { engineRef.current?.zoomBy(f); },
      panBy: (dx: number, dy: number) => { engineRef.current?.panBy(dx, dy); },
      hoverNode: (mint: string | null) => { engineRef.current?.hover(mint); },
      worldRadius: (v: number) => engineRef.current?.worldRadius(v) ?? 0,
      zoom: () => engineRef.current?.zoom() ?? 1,
      frameStats: () => engineRef.current?.frameStats() ?? zeroStats(),
      chipRadius: (s: number) => engineRef.current?.chipRadius(s) ?? 0,
      maxShare: () => engineRef.current?.maxShare() ?? 0,
    };
  }, []);
  useImperativeHandle(props.ref, () => handle, [handle]);

  // ---- debug hooks for the QA scripts (only when DEBUG_HOOKS; window.__sporeMap goes with the unmount)
  useEffect(() => registerMap3Debug({
    root: () => rootRef.current,
    engine: () => engineRef.current,
    byMint: () => byMintRef.current,
    tags: () => ({ wide: tagsWideRef.current, compact: tagsCompactRef.current }),
    mountedAt,
    dataAt: () => dataAtRef.current,
    firstPaintAt: () => firstPaintRef.current,
    builds: () => buildsRef.current,
    lastBuild: () => lastBuildRef.current,
    sync: () => syncRef.current,
    fit: () => handle.fit(),
    focusNode: (mint: string) => handle.focusNode(mint),
  }), [mountedAt, handle]);

  return (
    <div ref={rootRef} className={`bm bm-full m3 look-${look}`} data-renderer="three">
      <div className="bm-controls" role="group" aria-label="Map controls">
        <button type="button" onClick={() => handle.scaleBy(1.5)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" onClick={() => handle.scaleBy(1 / 1.5)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" onClick={() => handle.fit()} aria-label="Fit to view" title="Fit"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" /></svg></button>
      </div>
      {onModeChange && (
        <div className="bm-size seg" role="group" aria-label="Size bubbles by">
          <span className="bm-size-label">size</span>
          <button type="button" aria-pressed={mode === "locked"} onClick={() => onModeChange("locked")}>locked</button>
          <button type="button" aria-pressed={mode === "mcap"} onClick={() => onModeChange("mcap")}>mcap</button>
        </div>
      )}
      {slow && <div className="m3-status" role="status">Building the map…</div>}
    </div>
  );
}
