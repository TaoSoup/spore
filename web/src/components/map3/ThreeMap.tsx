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
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EngineError, mountEngine, type EngineCallbacks, type EngineFrameStats, type EngineHandle, type EngineImages, type EngineRect } from "./engine/index.js";
import { buildRoots, heatPayload, PHONE_BAND_PX, reducedMotionNow, tagFn, valueFn, valueFns, WIDE_PX } from "./adapter";
import { useEngineSync } from "./use-engine-sync";
import { registerMap3Debug } from "./debug-hooks";
import { imageFailed, imageFor, imageReady, onImageLoaded, registerLogoMints } from "../../lib/map/images";
import { DEBUG_HOOKS } from "../../lib/map/debug";
import type { BubbleNode, RootsLimit, SizeMode } from "../../lib/map/types";
import type { HeatIndex } from "../../lib/map/heat";
import type { FallbackReason, ThreeMapHandle, ThreeMapProps } from "./types";
import "./map3.css";

type BuildReason = "first" | "mode" | "limit" | "band" | "select-unknown" | "drift" | "context";
type Rebuild = { n: number; reason: BuildReason };
type BuildParts = { mode: SizeMode; limit: RootsLimit; band: boolean; n: number };
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
/// A lost WebGL context is rebuilt this many times per mount; the next loss falls back to the classic map.
const MAX_CONTEXT_REBUILDS = 2;
/// Engine exceptions caught in this component's effects are logged this many times per mount.
const MAX_ERRORS = 3;
/// (final fix) The last heat index a ThreeMap saw, kept across mounts: a warm reopen (SPA back to /map) builds at once
/// with it when it is younger than WARM_HEAT_MS, instead of waiting up to FIRST_BUILD_WAIT_MS for the page's first poll
/// (measured: that wait alone took a warm reopen from ~0.4 s to 1.65 s when the heat answer was slow). The fresh payload
/// follows through setHeat (its `at` is newer). One reference, replaced by every newer index: nothing accumulates.
const WARM_HEAT_MS = 120_000;
let lastHeat: { heat: HeatIndex; seenAt: number } | null = null;
const warmHeat = (): HeatIndex | null => (lastHeat && performance.now() - lastHeat.seenAt < WARM_HEAT_MS ? lastHeat.heat : null);

const IMAGES: EngineImages = { want: imageFor, onLoaded: onImageLoaded, ready: imageReady, failed: imageFailed };
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
  const { nodes, byMint, limit, source, mode, inset, fitInset, select, fresh, highlight, heat, streamStatus, titleTags, titleTagsCompact } = props;
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
  const contextRebuildsRef = useRef(0);
  const selUnknownRef = useRef<{ mint: string | null; at: number }>({ mint: null, at: -Infinity });
  /// (galaxy) where the viewer dragged coins, by mint (the engine's onMoved entries, merged): every rebuild of this mount
  /// (mode, limit, band, select-unknown, drift, context) passes it back as opts.moved, so a dropped coin stays dropped.
  /// It lives only as long as this mount; nothing is stored beyond the page.
  const movedRef = useRef(new Map<string, { dx: number; dy: number }>());
  const [live, setLive] = useState<{ engine: EngineHandle; builtAt: number } | null>(null);
  const engine = live?.engine ?? null;
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
      const h = engineRef.current;
      engineRef.current = null;
      if (h) destroyQuietly(h);
      layerRef.current?.remove();
      layerRef.current = null;
      builtPartsRef.current = null;
      startedPartsRef.current = null;
    };
  }, []);

  // ---- the first build waits for the heat sidecar, or FIRST_BUILD_WAIT_MS after mount
  const [gate, setGate] = useState(() => heat != null || warmHeat() != null);
  useEffect(() => { if (heat && (!lastHeat || lastHeat.heat !== heat)) lastHeat = { heat, seenAt: performance.now() }; }, [heat]);
  useEffect(() => {
    if (gate) return;
    if (heat) { setGate(true); return; }
    const t = setTimeout(() => setGate(true), Math.max(0, FIRST_BUILD_WAIT_MS - (performance.now() - mountedAt)));
    return () => clearTimeout(t);
  }, [gate, heat, mountedAt]);

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
    if (!gate || band === null || failedRef.current) return;
    const root = rootRef.current;
    if (!root || nodesRef.current.length === 0) return;
    const parts: BuildParts = { mode, limit, band, n: rebuild.n };
    const same = (a: BuildParts | null) => !!a && a.mode === mode && a.limit === limit && a.band === band && a.n === rebuild.n;
    // A key that went away and came back while its build was pending (a quick double toggle) needs no new engine.
    if (engineRef.current && same(builtPartsRef.current)) { startedPartsRef.current = parts; return; }
    const was = startedPartsRef.current;
    startedPartsRef.current = parts;
    const reason: BuildReason = !was ? "first" : was.mode !== mode ? "mode" : was.limit !== limit ? "limit" : was.band !== band ? "band" : rebuild.reason;
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
      onCamera: (c) => { if (!current()) return; lastInteractRef.current = performance.now(); onCameraRef.current(c); },
      onFirstFrame: () => { if (firstPaintRef.current === 0 && !ctrl.signal.aborted) firstPaintRef.current = performance.now(); },
      onLost: () => { if (current()) onContextLost(); },
      onSwarmWant: (tops) => {
        if (!current() || !Array.isArray(tops)) return;
        try { familiesRef.current?.want(tops, "view"); } catch (e) { if (errorsRef.current++ < MAX_ERRORS) console.error("map3", e); }
      },
      onMoved: (entries) => {
        if (!current() || !Array.isArray(entries)) return;
        const m = movedRef.current;
        for (const e of entries) if (e && typeof e.mint === "string" && Number.isFinite(e.dx) && Number.isFinite(e.dy)) m.set(e.mint, { dx: e.dx, dy: e.dy });
      },
    };

    let input: ReturnType<typeof buildRoots>;
    registerLogoMints(nodesRef.current); // source -> mint for the logo sheets, before the engine asks for any logo
    try { input = buildRoots(nodesRef.current); }
    catch (e) { settle(); layer.remove(); fail("mount-error", e); return; }
    let focusFamily: string | null = null;
    try { focusFamily = engineRef.current?.focusedFamily() ?? null; } catch { focusFamily = null; }
    // A size-mode switch keeps the family order of the engine on screen (SPEC 3.3: the planet set and order are mode-independent).
    let order: string[] | undefined;
    if (reason === "mode") { try { order = engineRef.current?.familyOrder() ?? undefined; } catch { order = undefined; } }
    const w0 = root.clientWidth, h0 = root.clientHeight;

    // (a synchronous throw from mountEngine becomes a rejection, so it falls back instead of crashing the page)
    new Promise<EngineHandle>((resolve) => resolve(mountEngine(layer, {
      roots: input.roots, heat: heatPayload(heatRef.current ?? warmHeat()), valueOf: valueFn(mode, input.roots), values: valueFns(input.roots), order, mode, tagOf: tagFn(tagsRef.current),
      inset: insetRef.current, fitInset: fitInsetRef.current, obstacles: collectObstacles(root),
      reducedMotion: reducedMotionNow(), feed: streamRef.current === "live" ? "up" : "down", images: IMAGES,
      select: selectRef.current, focusFamily, callbacks, look: lookRef.current, moved: movedRef.current, swarm: SWARM_ON,
      debug: DEBUG_HOOKS, signal: ctrl.signal, failForTest: DEBUG_HOOKS && typeof location !== "undefined" && location.search.includes("m3fail"),
    }))).then((h) => {
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
      builtPartsRef.current = parts;
      buildsRef.current++;
      let stats: Record<string, unknown> = {};
      try { stats = h.debug?.build() ?? {}; } catch { stats = {}; }
      lastBuildRef.current = { reason, ...stats };
      if (root.clientWidth !== w0 || root.clientHeight !== h0) guard(() => h.resize());
      setLive({ engine: h, builtAt: performance.now() });
      guard(() => onCameraRef.current({ k: h.zoom() }));
    }, (err: unknown) => {
      settle();
      layer.remove();
      if (ctrl.signal.aborted || errCode(err) === "aborted" || !aliveRef.current) return;
      fail(errCode(err) === "webgl" ? "webgl" : "mount-error", err);
    });

    return () => { if (!job.settled) { clearTimeout(slowT); ctrl.abort(); } };
  }, [gate, band, mode, limit, rebuild, fail, guard, onContextLost]);

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
    guard(() => {
      if (select === engine.selected()) return;
      if (select == null) { if (changed) engine.select(null); return; }
      if (engine.knows(select)) {
        // a new selection, or one that waited for its coin to arrive (a birth)
        if (changed || waiting === select) engine.select(select, { fly: true });
        return;
      }
      echoRef.current.waiting = select;
      if (!byMintRef.current.has(select)) return;
      // (family-all) a coin of a capped family that is loading (or loaded) is a speck to come, not a reason to rebuild
      const fam = familiesRef.current;
      if (fam && (fam.busy() || fam.familyOf(select))) return;
      const s = selUnknownRef.current, now = performance.now();
      if (s.mint !== select && now - s.at >= SELECT_UNKNOWN_MS && requestRebuild("select-unknown")) selUnknownRef.current = { mint: select, at: now };
    });
  }, [select, engine, nodes, famVer, guard, requestRebuild]);

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
    const f = () => { lastInteractRef.current = performance.now(); };
    const types = ["pointerdown", "pointermove", "wheel", "touchstart"] as const;
    for (const t of types) root.addEventListener(t, f, { passive: true });
    return () => { for (const t of types) root.removeEventListener(t, f); };
  }, []);
  const lastInteract = useCallback(() => lastInteractRef.current, []);
  const onDrift = useCallback(() => { requestRebuild("drift"); }, [requestRebuild]);

  // ---- live data: trades, pairs, heat, nodes, stream, reduced motion, highlight, tags
  useEffect(() => { registerLogoMints(nodes); }, [nodes]); // patched images arrive as new sources: keep source -> mint current for the logo sheets
  const sync = useEngineSync({
    engine, nodes, byMint, fresh, heat, streamStatus, highlight, tags, families,
    builtAt: live?.builtAt ?? 0, firstBuildFromCache: fromCache, lastInteract, onDrift,
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
        if (!e?.flyToFamily(mint) || opts?.select === false) return;
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
      {slow && <div className="m3-status" role="status">Building the map…</div>}
    </div>
  );
}
