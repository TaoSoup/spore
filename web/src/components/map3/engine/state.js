// state.js: the shared context `S` that every module receives.
// (map3 port) Copied from the prototype and changed for the app:
//   - S lives in a CONTAINER the app owns (container-relative CSS px everywhere; W()/H() are the cached container size,
//     re-read by resize()); no URL parameters; N_PLANETS comes from the options.
//   - S.life is the one place that touches timers, listeners, animation frames and observers. Every module goes through
//     it, so destroy() (index.js) releases everything with S.life.disposeAll(). Promise continuations check S.dead.
//   - insets: S.inset / S.fitInset (the page's chrome bands) and S.obstacles (page chrome rects, padded by 8 px) are set
//     at mount and by setInset(). S.insetRect() / S.fitRect() are the container minus those bands.
//   - debug functions go into S.debugFns (index.js maps them onto EngineDebug when opts.debug).
//
// EXPORTS
//   createState(container, layers, opts) -> S
//   createLife() -> the S.life registry (also used by index.js before S exists)
//   nextTask() -> Promise   one macrotask (the build yields between steps)
//   EngineError             the engine's error class (index.js re-exports it)
//
// RULES FOR EVERY MODULE (unchanged from the prototype)
// - Modules talk only through S. Call other modules through their namespace AT CALL TIME: S.bubbles.flashRim(i).
// - Typed arrays and arrays on S are mutated in place and never reassigned after their builder runs.
// - Shared uniforms live in S.U and are declared HERE, before any material exists.
// - Per-frame work: S.onFrame((now, dt) => needsAnotherFrame). S.invalidate() asks for one more rendered frame.
// - Events: S.on(name, fn) / S.emit(name, ...args). Names in use: 'resize', 'heat', 'positions', 'birth'.
import * as THREE from "three";
// (galaxy) tokensFor(look) comes from tokens.js (planets lane); the namespace import keeps this module linking even
// before it lands (a missing NAMED export fails at link time). Flat: tokensFor("flat") === TOK.
import * as TOKENS from "./tokens.js";

export class EngineError extends Error {
  constructor(code, message, options) {
    super(message || code, options);
    this.name = "EngineError";
    this.code = code;
  }
}

// one macrotask (MessageChannel: never clamped like nested timeouts, never throttled by a rAF)
export function nextTask() {
  return new Promise((res) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.onmessage = null; ch.port1.close(); ch.port2.close(); res(); };
    ch.port2.postMessage(0);
  });
}

// ---- S.life: every listener, timer, frame and observer the engine owns ----
export function createLife() {
  const offs = new Set(), timers = new Set(), intervals = new Set(), rafs = new Set(), observers = new Set(), disposers = [];
  let dead = false;
  const life = {
    get dead() { return dead; },
    // addEventListener with automatic removal; returns an off() function
    on(target, type, fn, options) {
      if (dead || !target || typeof target.addEventListener !== "function") return () => {};
      target.addEventListener(type, fn, options);
      const off = () => { if (offs.delete(off)) target.removeEventListener(type, fn, options); };
      offs.add(off);
      return off;
    },
    timeout(fn, ms) {
      if (dead) return 0;
      const id = setTimeout(() => { timers.delete(id); if (!dead) fn(); }, ms);
      timers.add(id);
      return id;
    },
    clearTimeout(id) { if (id && timers.delete(id)) clearTimeout(id); },
    interval(fn, ms) {
      if (dead) return 0;
      const id = setInterval(() => { if (!dead) fn(); }, ms);
      intervals.add(id);
      return id;
    },
    clearInterval(id) { if (id && intervals.delete(id)) clearInterval(id); },
    raf(fn) {
      if (dead) return 0;
      const id = requestAnimationFrame((t) => { rafs.delete(id); if (!dead) fn(t); });
      rafs.add(id);
      return id;
    },
    cancelRaf(id) { if (id && rafs.delete(id)) cancelAnimationFrame(id); },
    observe(o) { if (dead) { try { o.disconnect(); } catch { /* ignore */ } return o; } observers.add(o); return o; },
    onDispose(fn) { if (dead) { try { fn(); } catch { /* ignore */ } return; } disposers.push(fn); },
    // releases everything, then runs the disposers in reverse registration order (scene.js, registered first, runs last)
    disposeAll() {
      if (dead) return;
      dead = true;
      for (const off of [...offs]) { try { off(); } catch { /* ignore */ } }
      offs.clear();
      for (const id of timers) clearTimeout(id);
      timers.clear();
      for (const id of intervals) clearInterval(id);
      intervals.clear();
      for (const id of rafs) cancelAnimationFrame(id);
      rafs.clear();
      for (const o of observers) { try { o.disconnect(); } catch { /* ignore */ } }
      observers.clear();
      for (let j = disposers.length - 1; j >= 0; j--) { try { disposers[j](); } catch (e) { console.warn("map3 dispose", e); } }
      disposers.length = 0;
    },
  };
  return life;
}

const num = (v) => (Number.isFinite(v) ? v : 0);

export function createState(container, layers, opts, life = createLife()) {
  const noop = () => {};
  const hooks = [], listeners = new Map();
  // container size, cached (W()/H() are called thousands of times per frame); resize() re-reads it
  let cw = Math.max(1, container.clientWidth || 1), ch = Math.max(1, container.clientHeight || 1);
  const S = {
    opts, life, layers, container, dead: false, contextLost: false,
    N_PLANETS: Number.isFinite(opts.nPlanets) && opts.nPlanets > 0 ? Math.floor(opts.nPlanets) : 60,
    // (galaxy) one engine, two looks: "galaxy" (default) or "flat" (?look=flat keeps the colony-plate look). Fixed per mount.
    // S.tok is the token set modules read at build time (const T = S.tok || TOK); for flat it IS TOK.
    look: opts.look === "flat" ? "flat" : "galaxy",
    galaxy: opts.look !== "flat",
    tok: null,
    DPR: Math.min(2, window.devicePixelRatio || 1),
    // (final fix) the quality governor (motion.js) may lower this cap (2 -> 1.5 -> 1); measure() honours it
    dprCap: 2,
    // (final fix) last user input on the map or through the page's camera calls (motion.js); the live coins' breathing
    // sleeps BREATH_SLEEP_MS after it (bubbles.js)
    lastInputAt: performance.now(),
    W: () => cw,
    H: () => ch,
    phone: () => cw <= 700,
    // (map3 port) re-read the container size and the device pixel ratio (capped at 2); true when anything changed
    measure: () => {
      const w = Math.max(1, container.clientWidth || cw), h = Math.max(1, container.clientHeight || ch), d = Math.min(S.dprCap, window.devicePixelRatio || 1);
      const changed = w !== cw || h !== ch || d !== S.DPR;
      cw = w; ch = h; S.DPR = d; S.U.uDpr.value = d;
      return changed;
    },

    // ---- page chrome (map3 port): insets and obstacles, container CSS px ----
    inset: {}, fitInset: {}, obstacles: [], obstaclesRaw: [],
    setInsets: (inset, fitInset, obstacles) => {
      S.inset = { ...(inset || {}) }; S.fitInset = { ...(fitInset || {}) };
      const raw = [];
      for (const r of Array.isArray(obstacles) ? obstacles : []) {
        if (!r || !(r.x1 - r.x0 > 0) || !(r.y1 - r.y0 > 0)) continue;
        raw.push({ x0: num(r.x0), y0: num(r.y0), x1: num(r.x1), y1: num(r.y1) });
      }
      S.obstaclesRaw = raw;
      S.obstacles = raw.map((r) => ({ x0: r.x0 - 8, y0: r.y0 - 8, x1: r.x1 + 8, y1: r.y1 + 8 }));
    },
    rectOf: (ins) => {
      const w = cw, h = ch;
      let x0 = Math.max(0, num(ins && ins.left)), y0 = Math.max(0, num(ins && ins.top));
      let x1 = w - Math.max(0, num(ins && ins.right)), y1 = h - Math.max(0, num(ins && ins.bottom));
      // a band that leaves less than 40 px is ignored on that axis (a degenerate rect would break every fit)
      if (x1 - x0 < 40) { x0 = 0; x1 = w; }
      if (y1 - y0 < 40) { y0 = 0; y1 = h; }
      return { x0, y0, x1, y1 };
    },
    insetRect: () => S.rectOf(S.inset),
    fitRect: () => S.rectOf(S.fitInset),

    // ---- data (data.js) ----
    heat: null, nowS: 0, heatIdx: null, heatStatus: "ok",
    sym: null, img: null, mint: null, mintIdx: null, par: null, gen: null, famOf: null, kids: null,
    mc: null, val: null, age: null, n24: null, crt: null,
    fams: null, N: 0, total: 0, ranked: null, planets: null, dust: null, dustShare: 0, maxShare: 1,
    famBy: () => undefined,
    mode: opts.mode === "mcap" ? "mcap" : "locked",
    modeWord: opts.mode === "mcap" ? "market cap" : "locked value",
    tagOf: typeof opts.tagOf === "function" ? opts.tagOf : () => null,
    callbacks: opts.callbacks || {},
    images: opts.images,

    // ---- layout (layout.js) ----
    R: null, X: null, Y: null, TH: null, NR: null, notable: null,
    // (galaxy physics) designed positions before the owner's moved-coin offsets (motion.js applyMoved)
    XD: null, YD: null,
    Rcl: 0, planetHulls: null,

    // ---- overview composition (dust.js) ----
    Rout: 0, RoutMax: 0, dustTypR: 6, dustCaption: { x: 0, y: 0 },

    // ---- camera + runtime (motion.js mutates; everyone reads) ----
    cam: { x: 0, y: 0, k: 1 }, tgt: { x: 0, y: 0, k: 1 },
    dirty: true, needsRender: true, frame: 0,
    // (local perf 2026-11-09) frames left in which a coin may have moved (motion.js sets it while the coin sim steps): the
    // O(N) "did anything move" scans of bubbles (scanXY) and links (syncOffsets) run only then, plus every XY_NET_FRAMES
    // as a safety net. 58k coins x several scans x 144-165 frames/s kept the main thread busy on an idle map.
    xyScan: 3,
    dustExpand: 0, dustA: 1, hoverI: -1,
    worldGrid: null,

    // ---- highlight mask (map3 port; motion.js setHighlight fills it; 1 = matches, 0 = dimmed) ----
    hlOn: false,
    hlBit: () => 1,

    // ---- shared uniforms (declared here only) ----
    U: {
      uPx: { value: 1 }, uDpr: { value: 1 }, uTime: { value: 0 }, uDustExpand: { value: 0 },
      uHover: { value: -1 }, uHoverFam: { value: -1 }, uCam: { value: new THREE.Vector2() },
      uFine: { value: 0 }, uMinScale: { value: 1 },
      uDimMix: { value: 0 }, uHoverT: { value: 0 }, uK0: { value: 1 },
      uFadeP: { value: 1 }, uFadeD: { value: 1 }, uDrift: { value: 1 },
      uFocusFam: { value: -1 }, uFocusMix: { value: 0 },
      // (galaxy) uLook 1 = galaxy, 0 = flat; uAnimT = animation clock in SECONDS (motion.js advances it only while the
      // galaxy look is awake and motion is not reduced, frozen otherwise); uGalT = opened-ness 0..1 =
      // smoothstep(1.3 k0, 2.6 k0, cam.k) (motion.js, each frame); uFlow = 0 under reduced motion, else 1.
      uLook: { value: opts.look !== "flat" ? 1 : 0 }, uAnimT: { value: 0 }, uGalT: { value: 0 },
      uFlow: { value: opts.reducedMotion ? 0 : 1 },
      // (galaxy focus) the coin a paste/search/?focus flew to (-1 = none); uFocusT 0..1 = its pulse/halo strength;
      // uFocusDim 0..1 = how much every OTHER coin/vein dims. focus.js ramps them; consumers also write ??= defaults.
      uFocusCoin: { value: -1 }, uFocusT: { value: 0 }, uFocusDim: { value: 0 },
    },

    // ---- module APIs: stubs now, filled by each module's build (Object.assign onto these objects) ----
    gfx: { renderer: null, scene: null, camera: null, composer: null, bloom: null, render: noop, resize: noop },
    overview: { k0: 1, overviewTarget: () => ({ x: 0, y: 0, k: 1 }), setDustHeat: noop, setDustHl: noop },
    bubbles: { mesh: null, setCoinHeat: noop, flashRim: noop, selectCoin: noop, setHl: noop },
    links: { mesh: null, setLinkHeat: noop, setEmphasis: noop, linkPolyline: () => null, genArcInfo: () => [], setHl: noop,
             genArcs: { mesh: null, setKnockouts: noop }, hull: { show: noop }, pulses: { spawn: () => false },
             onPulseArrive: noop },
    labels: { layoutLabels: noop, readHud: noop, showTip: noop, hideTip: noop, updateStats: noop, ready: noop, setTags: noop, setHl: noop },
    motion: { applyCam: noop, setCam: noop, fitAll: noop, focus: noop, zoomAt: noop, hoverAt: noop,
              flyTo: noop, flyToFamily: noop, flyToCoin: noop, flyOverview: noop, start: noop, reduced: !!opts.reducedMotion },

    // ---- plumbing ----
    onFrame: (fn) => { hooks.push(fn); },
    runFrameHooks: (now, dt) => { let more = false; for (const h of hooks) if (h(now, dt)) more = true; return more; },
    invalidate: () => { S.needsRender = true; },
    on: (name, fn) => { let a = listeners.get(name); if (!a) listeners.set(name, (a = [])); a.push(fn); },
    emit: (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args); },

    // world <-> screen (container CSS px), from the CURRENT camera
    toS: (wx, wy) => [(wx - S.cam.x) * S.cam.k + cw / 2, ch / 2 - (wy - S.cam.y) * S.cam.k],
    toW: (sx, sy) => [S.cam.x + (sx - cw / 2) / S.cam.k, S.cam.y - (sy - ch / 2) / S.cam.k],

    // debug surfaces: S.debug.map (numbers, reported by EngineDebug.build()); S.debugFns (functions, see index.js)
    debug: { obj: {}, map: {} },
    debugFns: {},
  };
  S.U.uDpr.value = S.DPR;
  {
    const tf = typeof TOKENS.tokensFor === "function" ? TOKENS.tokensFor : () => TOKENS.TOK;
    S.tok = tf(S.look) || TOKENS.TOK;
  }
  S.setInsets(opts.inset, opts.fitInset, opts.obstacles);
  life.onDispose(() => { S.dead = true; hooks.length = 0; listeners.clear(); });
  return S;
}
