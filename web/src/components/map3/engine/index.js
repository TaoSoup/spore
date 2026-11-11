// index.js (map3 port): the engine's entry point; replaces the prototype's app.js. The typed surface is index.d.ts.
//
// mountEngine(container, opts) builds the map inside a div the app owns:
//   layers (in this order): div.m3-stage > canvas.m3-canvas (WebGL2), canvas.m3-leaders, div.m3-labels, div.m3-tip
//   build (one macrotask between steps; the abort signal is checked after every await):
//     ingest (+ vis.js createVis: the Key's last-trade filter, opts.last) -> layout + placeDust (+ applyMoved: the coins this
//     mount's viewer dragged keep their place) -> scene -> bubbles
//     -> links -> dust -> swarm (family-all: material + family texture; the slots come after the first frame) -> labels (font
//     race <= 1.5 s) -> focus -> motion -> labels.ready() -> motion.start() -> the first rendered frame (callbacks.onFirstFrame,
//     then the promise resolves)
//   rejects with EngineError: 'aborted' (signal; everything created so far is disposed), 'empty' (no roots), 'webgl' (no
//   WebGL2 context or no EXT_color_buffer_float, or the context was lost while building), 'build' (anything else; the
//   original error is the cause). The engine creates the WebGL2 context itself and hands {canvas, context} to three, so
//   three never logs a context-creation error.
// destroy() is idempotent: S.dead, the frame loop stops, S.life releases every listener / timer / frame / observer /
// image subscription / font listener, every module disposes its GPU objects, renderer.dispose() + forceContextLoss(),
// the four layer elements are removed and S drops its arrays. engineCounters() = {live, created, destroyed} is the only
// module-level mutable state.
import * as THREE from "three";
import { createState, createLife, nextTask, EngineError } from "./state.js";
import { ingest } from "./data.js";
import { buildLayout } from "./layout.js";
import { placeDust, buildDust } from "./dust.js";
import { buildScene } from "./scene.js";
import { buildBubbles } from "./bubbles.js";
import { buildLinks } from "./links.js";
import { buildLabels } from "./labels.js";
import { buildMotion, applyMoved } from "./motion.js";
import { buildFocus } from "./focus.js";
import { buildSwarm, DUST0 } from "./swarm.js";
import { createVis } from "./vis.js";

export { EngineError };

// (focus lane) select(m, {fly: true}) flies through S.focus (zoom until the coin is >= 80 px, then the pulse); a coin selected
// at mount is framed by S.focus.target and pulsed on the first frame. This wraps motion's api so it does not depend on
// motion's own select branch: the selection (ring, branch, labels) stays motion's, only the camera call moves here.
// Newborns (not in the layout arrays) keep motion's own flight.
function installFocus(S) {
  const F = S.focus, api = S.api;
  S.focusAtMount = -1;
  if (!F || !api) return;
  const sel0 = api.select;
  api.select = (m, o) => {
    const fly = !!(o && o.fly);
    let i = m != null && S.mintIdx ? S.mintIdx.get(m) : undefined;
    // (family-all) a loaded real speck: the same fly + pulse (focus.js targets dust indices too)
    if (i === undefined && m != null && S.swarm && S.swarm.on) { const d = S.swarm.indexOf(m); if (d >= DUST0) i = d; }
    if (!fly || i === undefined || !((i >= 0 && i < S.N) || i >= DUST0)) return sel0(m, o);
    const ok = sel0(m, { ...o, fly: false });
    if (ok) { S.lastInputAt = performance.now(); F.fly(i); }
    return ok;
  };
  const i0 = S.opts.select != null && S.mintIdx ? S.mintIdx.get(S.opts.select) : undefined;
  if (i0 !== undefined && i0 >= 0 && i0 < S.N) {
    const t = F.target(i0);
    if (t) { S.motion.setCam(t.x, t.y, t.k, true); S.focusAtMount = i0; }
  }
}

// (logos that come later, 2026-11-10) image URLs that changed after the build ({mint, image}: a node patch from a since= delta
// or a mapdelta, a late metadata read) reach the coins they belong to: built coins by S.mintIdx, newborns by the mint
// bubbles.addCoin saw. An entry without an `image` key (an mcap-only patch) is skipped, an unchanged URL costs one compare.
// Returns how many coins took a new URL.
function patchImages(S, list) {
  const B = S.bubbles;
  if (!Array.isArray(list) || !B || typeof B.patchImage !== "function") return 0;
  let n = 0;
  for (const p of list) {
    if (!p || typeof p.mint !== "string" || p.image === undefined) continue;
    const i = B.coinIndex(p.mint);
    if (i >= 0 && B.patchImage(i, p.image)) n++;
  }
  return n;
}

const counters = { live: 0, created: 0, destroyed: 0 };
export function engineCounters() { return { live: counters.live, created: counters.created, destroyed: counters.destroyed }; }

// S fields that hold the data / layout arrays and objects: dropped on destroy so a stray reference to S keeps nothing alive
const HEAVY = ["heat", "heatIdx", "sym", "img", "mint", "mintIdx", "par", "gen", "famOf", "kids", "mc", "val", "age", "n24", "crt",
  "fams", "ranked", "planets", "dust", "R", "X", "Y", "TH", "NR", "notable", "planetHulls", "worldGrid", "drag", "api", "engineDebug",
  "gl", "layers", "container", "images", "callbacks", "opts", "debugFns", "gfx", "overview", "bubbles", "links", "labels", "motion", "rad",
  "swarm", "vis", "seed", "whole"];

export async function mountEngine(container, opts) {
  if (!container || !opts) throw new EngineError("build", "mountEngine needs a container and options");
  const signal = opts.signal || null;
  if (signal && signal.aborted) throw new EngineError("aborted", "aborted");
  if (opts.failForTest) throw new EngineError("build", "failForTest (debug)");
  const tMount = performance.now();
  counters.created++; counters.live++;
  const life = createLife();

  // ---- layers ----
  const doc = container.ownerDocument || document;
  const stage = doc.createElement("div"); stage.className = "m3-stage";
  const canvas = doc.createElement("canvas"); canvas.className = "m3-canvas"; canvas.tabIndex = -1;
  canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "Spore map");
  stage.appendChild(canvas);
  const leaders = doc.createElement("canvas"); leaders.className = "m3-leaders"; leaders.setAttribute("aria-hidden", "true");
  const labels = doc.createElement("div"); labels.className = "m3-labels"; labels.setAttribute("aria-hidden", "true");
  const tip = doc.createElement("div"); tip.className = "m3-tip"; tip.setAttribute("role", "tooltip");
  container.append(stage, leaders, labels, tip);

  let S = null, gl = null, dead = false;
  const teardown = () => {
    if (dead) return;
    dead = true;
    if (S) S.dead = true;
    life.disposeAll();
    // three's forceContextLoss already ran when the renderer existed; otherwise release the context here
    try { if (gl && !gl.isContextLost()) { const ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext(); } } catch { /* ignore */ }
    gl = null;
    for (const e of [stage, leaders, labels, tip]) { try { e.remove(); } catch { /* ignore */ } }
    if (S) { for (const k of HEAVY) { try { S[k] = null; } catch { /* ignore */ } } }
    S = null;
    counters.live--; counters.destroyed++;
  };

  // ---- WebGL2 on our own canvas (a failure is an EngineError, never a three console error) ----
  try { gl = canvas.getContext("webgl2", { antialias: false, stencil: false, powerPreference: "high-performance" }); } catch { gl = null; }
  if (!gl || gl.isContextLost()) { teardown(); throw new EngineError("webgl", "WebGL2 is not available"); }
  if (!gl.getExtension("EXT_color_buffer_float")) { teardown(); throw new EngineError("webgl", "EXT_color_buffer_float is not available"); }

  // ---- abort / loss while building ----
  let rejectAbort = null, rejectLost = null;
  const abortP = new Promise((_, rej) => { rejectAbort = rej; });
  const lostP = new Promise((_, rej) => { rejectLost = rej; });
  abortP.catch(() => {}); lostP.catch(() => {});
  if (signal) life.on(signal, "abort", () => rejectAbort(new EngineError("aborted", "aborted")), { once: true });
  const offLost = life.on(canvas, "webglcontextlost", () => rejectLost(new EngineError("webgl", "the WebGL context was lost while building")));
  const check = () => { if (dead || (signal && signal.aborted)) throw new EngineError("aborted", "aborted"); };
  // (final fix) the longest stretch of synchronous build work between two yields, and where it ended (S.debug.map
  // buildMaxTaskMs / buildMaxTaskAt): the build's own share of a long task
  let taskT = performance.now(), taskMax = 0, taskAt = "", where = "start";
  const step = async (p, at = where) => {
    const d = performance.now() - taskT; if (d > taskMax) { taskMax = d; taskAt = at; }
    const v = await Promise.race([p, abortP, lostP]); check(); taskT = performance.now(); return v;
  };

  try {
    S = createState(container, { stage, canvas, leaders, labels, tip }, opts, life);
    S.gl = gl;
    const tm = {};
    let tStep = performance.now();
    const mark = (key) => { const n = performance.now(); tm[key] = Math.round(n - tStep); tStep = n; };
    ingest(S, opts); mark("ingestMs");
    // (the Key's last-trade filter) the levels before anything is built (opts.last): the first frame of a mount or a rebuild
    // draws exactly what the Key shows, never everything for a frame
    S.vis = createVis(S, opts.last && typeof opts.last === "object" ? opts.last : null);
    await step(nextTask(), "ingest");
    const pause = () => step(nextTask(), where);
    where = "layout"; await buildLayout(S, pause); mark("layoutStepMs");
    await step(nextTask(), "layout (packing)");
    where = "placeDust"; await placeDust(S, pause); mark("placeDustMs");
    // (focus lane) the positions the viewer dragged coins to (opts.moved, kept by the React shell for the mount) survive
    // every rebuild: motion.js applyMoved copies the designed layout into S.XD/S.YD and offsets X/Y and f.cx/f.cy
    applyMoved(S, opts.moved && typeof opts.moved.get === "function" ? opts.moved : new Map());
    await step(nextTask(), "placeDust");
    buildScene(S); mark("sceneMs");
    await step(nextTask(), "scene");
    buildBubbles(S); mark("bubblesStepMs");
    await step(nextTask(), "bubbles");
    where = "links"; await buildLinks(S, pause); mark("linksStepMs");
    await step(nextTask(), "links (tail)");
    buildDust(S); mark("dustBuildMs");
    // (family-all) the swarm layer: material, family texture and a placeholder geometry only (so the program compiles with the
    // scene below); its slots are generated after the first frame in <= 8 ms slices
    buildSwarm(S); mark("swarmBuildMs");
    await step(nextTask(), "dust");
    where = "labels"; await step(buildLabels(S), "labels"); mark("labelsStepMs");
    buildFocus(S);
    buildMotion(S); mark("motionMs");
    installFocus(S);
    where = "motion + compile";
    // the scene's programs compile in parallel where the browser can (KHR_parallel_shader_compile), so the first frame is
    // not one long task; a browser without compileAsync compiles them in the first render as before
    // (family-all) compiled against the composer's linear target, the one the RenderPass draws into: compiled with no target
    // bound, three keyed every program to the sRGB output and the first frame compiled every scene program a second time
    if (typeof S.gfx.renderer.compileAsync === "function") {
      S.motion.applyCam();
      const r = S.gfx.renderer, rt = S.gfx.composer && (S.gfx.composer.renderTarget2 || S.gfx.composer.renderTarget1), prev = r.getRenderTarget();
      let pc;
      try { if (rt) r.setRenderTarget(rt); pc = r.compileAsync(S.gfx.scene, S.gfx.camera); } finally { r.setRenderTarget(prev); }
      await step(pc);
    }
    mark("compileMs");
    S.labels.ready();
    S.motion.start();
    if (S.focusAtMount >= 0) { const i0 = S.focusAtMount; Promise.resolve(S.api.firstFrame).then(() => { if (S && !S.dead && S.focus && !S.focus.active()) S.focus.pulse(i0); }, () => {}); }
    await step(S.api.firstFrame, "compile -> first frame"); mark("firstFrameStepMs");
    offLost();
    // (family-all) the swarm's slots are generated now, after the first frame, in <= 8 ms slices
    if (S.swarm && typeof S.swarm.start === "function") S.swarm.start();
    Object.assign(S.debug.map, tm, {
      dustMs: (tm.placeDustMs || 0) + (tm.dustBuildMs || 0),
      buildMs: Math.round(performance.now() - tMount),
      firstFrameMs: Math.round((S.firstFrameAt || performance.now()) - tMount),
      buildMaxTaskMs: Math.round(taskMax), buildMaxTaskAt: taskAt,
      three: THREE.REVISION,
    });
  } catch (e) {
    teardown();
    if (e instanceof EngineError) throw e;
    throw new EngineError("build", e && e.message ? String(e.message) : String(e), { cause: e });
  }

  // ---- the handle: every method is a safe no-op after destroy ----
  const api = S.api;
  let errs = 0;
  const guard = (f, dflt) => (...a) => {
    if (dead) return dflt;
    try { return f(...a); } catch (e) { if (errs++ < 3) console.error("map3", e); return dflt; }
  };
  const zero = { n: 0, avg: 0, p95: 0, max: 0 };
  let debug = null;
  if (opts.debug && S.engineDebug) {
    const fns = S.debugFns;
    if (typeof S.engineDebug.call !== "function") S.engineDebug.call = (name, ...a) => (typeof fns[name] === "function" ? fns[name](...a) : null);
    if (typeof S.engineDebug.focusState !== "function") S.engineDebug.focusState = () => (typeof fns.focusState === "function" ? fns.focusState() : null);
    debug = {};
    for (const [k, f] of Object.entries(S.engineDebug)) debug[k] = typeof f === "function" ? guard(f, null) : f;
  }
  const handle = {
    fit: guard(() => api.fit()),
    flyToFamily: guard((m) => !!api.flyToFamily(m), false),
    flyToCoin: guard((m) => !!api.flyToCoin(m), false),
    zoomBy: guard((f) => api.zoomBy(f)),
    panBy: guard((dx, dy) => api.panBy(dx, dy)),
    select: guard((m, o) => !!api.select(m, o), false),
    selected: guard(() => api.selected(), null),
    hover: guard((m) => api.hover(m)),
    setHighlight: guard((t) => api.setHighlight(t)),
    // (the Key's last-trade filter, 2026-11-10) see index.d.ts
    setLastFilter: guard((mask, pinned) => api.setLastFilter(mask, pinned), { shown: 0, anchors: 0, hidden: 0 }),
    visibility: guard((m) => api.visibility(m), null),
    lastFilterStats: guard(() => api.lastFilterStats(), { mask: 15, shown: 0, anchors: 0, hidden: 0, byClass: [0, 0, 0, 0] }),
    setHeat: guard((h) => api.setHeat(h)),
    applyEvent: guard((e) => api.applyEvent(e)),
    // a node patch carries `image` when the coin's URL changed: the market cap goes to motion, the URL to the bubbles
    patchCoins: guard((p) => { api.patchCoins(p); patchImages(S, p); }),
    patchImages: guard((p) => patchImages(S, p), 0),
    setTags: guard((fn) => S.labels.setTags(fn)),
    setInset: guard((a, b, c) => api.setInset(a, b, c)),
    setReducedMotion: guard((on) => api.setReducedMotion(on)),
    setFeed: guard((st) => api.setFeed(st)),
    resize: guard(() => api.resize()),
    knows: guard((m) => !!api.knows(m), false),
    // (family-all) the capped families' real dust (DESIGN-FAMILY-ALL.md §5)
    swarmAdd: guard((c) => (S.swarm ? S.swarm.add(c) : 0), 0),
    swarmDrop: guard((top) => { if (S.swarm) S.swarm.drop(top); }),
    swarmFamilies: guard(() => (S.swarm ? S.swarm.families() : []), []),
    topOf: guard((m) => api.topOf(m), null),
    focusedFamily: guard(() => api.focusedFamily(), null),
    // (compact layout, 2026-11-10) a build made from the Key's filtered set: live reveals, drift, the view's family
    reveal: guard((m, why) => api.reveal(m, why), "off"),
    driftStats: guard((wanted) => api.driftStats(wanted), { filtered: false, built: 0, hidden: 0, revealed: 0, missed: 0, full: false, select: false }),
    viewFamily: guard(() => api.viewFamily(), null),
    familyOrder: guard(() => api.familyOrder(), []),
    camera: guard(() => api.camera(), { x: 0, y: 0, k: 1, k0: 1 }),
    zoom: guard(() => api.zoom(), 1),
    worldRadius: guard((m) => api.worldRadius(m), 0),
    chipRadius: guard((s) => api.chipRadius(s), 0),
    maxShare: guard(() => api.maxShare(), 1),
    frameStats: guard(() => api.frameStats(), { frames: 0, settling: zero, settled: zero, labels: 0, drawn: 0 }),
    get debug() { return dead ? null : debug; },
    destroy: () => { teardown(); debug = null; },
  };
  return handle;
}
