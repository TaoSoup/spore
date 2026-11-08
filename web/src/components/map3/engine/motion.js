// motion.js: the camera (eased wheel/trackpad zoom anchored at the cursor, 1:1 drag with inertia, 1:1 touch
// pinch, van Wijk flights), input (click rules, double-click zoom), hover focus (dwell, then dim the rest and emphasise the
// lineage), the world grid, THE TICK LOOP with render-on-demand, live trades / births / heat, load fades, reduced motion,
// coin dragging with the liquid local simulation, and the engine API the handle exposes (S.api) plus EngineDebug.
// (map3 port) Changed from the prototype:
//   - no URL reads or writes, no keyboard (only Esc while a coin is held), no heat polling, no feed, no /api/coin lookups,
//     no visibilitychange, no media queries, no window resize: the app drives all of it through the handle (setHeat,
//     applyEvent, setReducedMotion, setFeed, resize, setInset, select, hover, setHighlight, patchCoins).
//   - framing uses the page's chrome: famK / frameCircle fit inside S.insetRect(), the overview inside S.fitRect().
//   - click (pointerup within 5 px, mouse or pen): a coin of the focused family -> select + onSelect(mint); a coin, chip,
//     speck or colony of an unfocused family -> flyToFamily + select(top) + onSelect(topMint); nothing -> select(-1) +
//     onSelect(null). Touch: first tap = hover + docked card; a second tap (or the dock button) follows the click rule.
//   - selection is persistent (ring + links.setBranch) and owned by the page; no pinned tooltip; fit() keeps it.
//   - every listener, timer and frame goes through S.life; the tick stops on destroy or context loss.
//   - frame stats (CPU time of frame(), settling vs settled), onCamera relay (<= 4 Hz while moving + settle + first frame).
import { smooth, rnd, GOLDEN } from "./util.js";
import { TOK, heatClass, coreBoost, EASE, DUR } from "./tokens.js";
import { validHeat } from "./data.js";
// (family-all) the swarm's dust index space (DUST0 + global slot): a loaded real speck of a capped asset family
import { DUST0 } from "./swarm.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// cubic-bezier(x1, y1, x2, y2) as an easing function of t in [0, 1] (Newton, then bisection as a fallback)
export function bez(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t, dsx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let n = 0; n < 8; n++) { const e = sx(t) - x; if (Math.abs(e) < 1e-6) return sy(t); const d = dsx(t); if (Math.abs(d) < 1e-6) break; t -= e / d; if (t < 0 || t > 1) break; }
    let lo = 0, hi = 1; t = x;
    for (let n = 0; n < 24; n++) { const v = sx(t); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}
const easeOut = bez(...EASE.out), easeInOut = bez(...EASE.inOut);

// van Wijk & Nuij smooth zoom+pan (port of d3-interpolate's interpolateZoom), rho = 1.2. p = [cx, cy, w].
const RHO = 1.2, RHO2 = RHO * RHO, RHO4 = RHO2 * RHO2;
const cosh = (x) => ((x = Math.exp(x)) + 1 / x) / 2, sinh = (x) => ((x = Math.exp(x)) - 1 / x) / 2, tanh = (x) => ((x = Math.exp(2 * x)) - 1) / (x + 1);
function zoomPath(p0, p1) {
  const [ux0, uy0, w0] = p0, [ux1, uy1, w1] = p1, dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
  let i, S;
  if (d2 < 1e-12) { S = Math.log(w1 / w0) / RHO; i = (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(RHO * t * S)]; }
  else {
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * d1), b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    const ch0 = cosh(r0), sh0 = sinh(r0);
    S = (r1 - r0) / RHO;
    i = (t) => { const s = t * S, u = w0 / (RHO2 * d1) * (ch0 * tanh(RHO * s + r0) - sh0); return [ux0 + u * dx, uy0 + u * dy, w0 * ch0 / cosh(RHO * s + r0)]; };
  }
  i.duration = Math.abs(S) * 1000 * RHO / Math.SQRT2;
  return i;
}

export function buildMotion(S) {
  const { N, fams, planets, dust, famOf, par, kids, sym, mint, mc, R, X, Y, notable, maxShare, U, cam, tgt, W, H, phone, toS, toW } = S;
  const { camera } = S.gfx;
  const el = S.layers.canvas;
  const life = S.life, cb = S.callbacks || {};
  const call = (name, ...a) => { try { const f = cb[name]; if (typeof f === "function") f(...a); } catch (e) { if (errors++ < 3) console.error("map3", e); } };

  // ---------- galaxy look (2026-10-21): animation clock, opened-ness, 30 Hz awake cadence ----------
  // Everything galaxy in this module sits behind G: under ?look=flat the hook below is never registered, uAnimT stays 0,
  // galTrade is a no-op and the hover tween keeps its 120 ms, so flat behaviour is unchanged.
  //   uAnimT  animation clock in seconds: advances by dt while awake (input within GAL_AWAKE_MS) and not reduced; frozen otherwise
  //   uGalT   opened-ness 0..1 = smoothstep(1.3 k0, 2.6 k0, cam.k), each frame
  //   uFlow   0 under reduced motion (the veins' flow stops), else 1
  const G = !!S.galaxy;
  const GAL_AWAKE_MS = 30000, GAL_HOOK_MS = 33, GAL_LIT_MS = 1200;
  let galAwake = true, galFired = false; const galT = [];   // galT: times (ms) of the renders the galaxy hook asked for (galHz)
  const HOV_MS = G ? DUR.l : DUR.xs;   // hover ring / sweep tween 0 -> 1: 400 ms in galaxy (the bubbles shader's sweep), 120 ms flat

  // ---------- reduced motion (map3 port: the app's switch, setReducedMotion) ----------
  let rm = !!S.opts.reducedMotion;
  const setRm = (v) => {
    rm = !!v; S.motion.reduced = rm; U.uDrift.value = rm ? 0 : 1;
    if (U.uFlow) U.uFlow.value = rm ? 0 : 1;   // (galaxy) the veins' flow; declared in state.js for both looks, read by the galaxy shaders only
    if (rm) { inertia = null; pq.length = 0; }
    S.invalidate();
  };

  // ---------- static lookups ----------
  const k0 = () => S.overview.k0 || 1;
  // (galaxy physics) 1600 so the focus flight can put even the smallest coin (R ~ 0.05) at >= 80 px; flat keeps 80
  const K_MAX = G ? 1600 : 80, clampK = (k) => clamp(k, 0.6 * k0(), K_MAX);
  const isPlanetTop = new Uint8Array(N); for (const f of planets) isPlanetTop[f.top] = 1;
  let Rmax = 0; for (let i = 0; i < N; i++) if (!isPlanetTop[i] && R[i] > Rmax) Rmax = R[i];
  const panR = () => (S.RoutMax || S.Rout || S.Rcl || 1000) * 1.1;

  // world grid of coins (labels uses it for obstacles; hover uses it for the hit-test)
  const CELLW = 24, grid = new Map();
  const gkey = (gx, gy) => (gx + 4096) * 8192 + (gy + 4096);
  for (let i = 0; i < N; i++) { const k = gkey(Math.floor(X[i] / CELLW), Math.floor(Y[i] / CELLW)); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
  const forEachIn = (wx0, wy0, wx1, wy1, fn) => {
    for (let gx = Math.floor(wx0 / CELLW); gx <= Math.floor(wx1 / CELLW); gx++) for (let gy = Math.floor(wy0 / CELLW); gy <= Math.floor(wy1 / CELLW); gy++) {
      const a = grid.get(gkey(gx, gy)); if (a) for (const i of a) fn(i);
    }
  };
  S.worldGrid = { cell: CELLW, cells: grid, key: gkey, forEachIn };
  // grid of the small families (one dust speck each at overview)
  const DCELL = 48, dgrid = new Map(); let maxDustRc = 0;
  for (const f of dust) { const k = gkey(Math.floor(f.cx / DCELL), Math.floor(f.cy / DCELL)); let a = dgrid.get(k); if (!a) dgrid.set(k, (a = [])); a.push(f); if (f.Rc > maxDustRc) maxDustRc = f.Rc; }
  const forEachDust = (wx0, wy0, wx1, wy1, fn) => {
    for (let gx = Math.floor(wx0 / DCELL); gx <= Math.floor(wx1 / DCELL); gx++) for (let gy = Math.floor(wy0 / DCELL); gy <= Math.floor(wy1 / DCELL); gy++) {
      const a = dgrid.get(gkey(gx, gy)); if (a) for (const f of a) fn(f);
    }
  };

  // ---------- camera ----------
  function applyCam() {
    camera.left = -W() / 2; camera.right = W() / 2; camera.top = H() / 2; camera.bottom = -H() / 2;
    camera.zoom = cam.k; camera.position.set(cam.x, cam.y, 50); camera.updateProjectionMatrix();
    U.uPx.value = cam.k * S.DPR; U.uCam.value.set(cam.x, cam.y); U.uMinScale.value = phone() ? 0.85 : 1;
  }
  const clampC = (o) => { const d = Math.hypot(o.x, o.y), m = panR(); if (d > m) { o.x *= m / d; o.y *= m / d; return true; } return false; };
  let anchor = null;    // eased zoom keeps this world point under this screen point: {sx, sy, wx, wy}
  let inertia = null;   // {vx, vy} in CSS px per 16.7 ms frame
  let tween = null;     // anchored zoom tween (double-click, +/-): {sx, sy, wx, wy, ka, kb, t0, dur}
  let flight = null;    // {path, m, t0, dur, ease, x, y, k, kind, fam, onEnd, resolves[]}
  const setCam = (x, y, k, snap = true) => { tgt.x = x; tgt.y = y; tgt.k = clampK(k); anchor = null; if (snap) { Object.assign(cam, tgt); tween = null; inertia = null; } S.dirty = true; };
  function zoomAt(sx, sy, factor) {
    const [wx, wy] = toW(sx, sy);
    anchor = { sx, sy, wx, wy };
    tgt.k = clampK(tgt.k * factor);
    tgt.x = wx - (sx - W() / 2) / tgt.k; tgt.y = wy + (sy - H() / 2) / tgt.k;
    if (rm) { Object.assign(cam, tgt); anchor = null; }
    S.dirty = true;
  }
  function zoomTween(sx, sy, factor, dur) {
    cancelAll();
    const [wx, wy] = toW(sx, sy), kb = clampK(cam.k * factor);
    if (rm) { cam.k = kb; cam.x = wx - (sx - W() / 2) / kb; cam.y = wy + (sy - H() / 2) / kb; Object.assign(tgt, cam); S.dirty = true; return; }
    tween = { sx, sy, wx, wy, ka: cam.k, kb, t0: performance.now(), dur };
  }
  function panBy(dx, dy) { cancelAll(); anchor = null; tgt.x += dx / cam.k; tgt.y += dy / cam.k; if (rm) Object.assign(cam, tgt); S.dirty = true; }

  // ---------- framing inside the page's chrome (map3 port) ----------
  // The inset rect is the container minus the page's bands (overlay, side panel, sheet); 6 px of the container edge stay free.
  const viewRect = () => { const ir = S.insetRect(); return { x0: Math.max(ir.x0, 6), y0: Math.max(ir.y0, 6), x1: Math.min(ir.x1, W() - 6), y1: Math.min(ir.y1, H() - 6) }; };
  // camera {x, y, k} that shows the world circle (cx, cy, rw) whole inside the inset rect, centred on it (shrink to fit)
  function frameCircle(cx, cy, rw, k) {
    const v = viewRect(), mx = (v.x0 + v.x1) / 2, my = (v.y0 + v.y1) / 2, w = W(), h = H();
    for (let attempt = 0; attempt < 7; attempt++) {
      const r = rw * k;
      if (2 * r <= v.x1 - v.x0 + 1 && 2 * r <= v.y1 - v.y0 + 1) break;
      k *= 0.94;
    }
    return { x: cx - (mx - w / 2) / k, y: cy + (my - h / 2) / k, k };
  }
  // zoom that frames a family: f.Rc * 1.06 into 94 % of the inset rect's short side. Tiny families stop where their top is
  // 64 px in radius.
  const insetMin = () => { const ir = S.insetRect(); return Math.max(40, Math.min(ir.x1 - ir.x0, ir.y1 - ir.y0)); };
  const famK = (f) => clampK(Math.min((insetMin() * 0.94) / (2 * f.Rc * 1.06), 64 / Math.max(R[f.top], 0.05)));
  const famTarget = (f) => frameCircle(f.cx, f.cy, f.Rc * 1.06, famK(f));
  // (map3 port) a coin too small in its family's framing is centred at 14 px in the inset rect's centre
  function coinTarget(i) {
    const t = famTarget(fams[famOf[i]]);
    if (R[i] * t.k >= 10) return t;
    const k = clampK(14 / Math.max(R[i], 0.01)), v = viewRect(), mx = (v.x0 + v.x1) / 2, my = (v.y0 + v.y1) / 2;
    return { x: X[i] - (mx - W() / 2) / k, y: Y[i] + (my - H() / 2) / k, k };
  }
  // (family-all) a speck: centred in the inset rect at k = max(its family's frame, 16 / slot spacing) (16 px between slots)
  function dustTarget(i) {
    const p = posOf(i), f = famOfIdx(i); if (!p || !f) return null;
    const sp = S.swarm ? S.swarm.spacing(i) : 0;
    const k = clampK(Math.max(famK(f), sp > 0 ? 16 / sp : 0)), v = viewRect(), mx = (v.x0 + v.x1) / 2, my = (v.y0 + v.y1) / 2;
    return { x: p[0] - (mx - W() / 2) / k, y: p[1] + (my - H() / 2) / k, k, fam: f.id };
  }
  const famByKey = (s) => { if (!s) return null; const f = S.famBy(s); if (f) return f; const i = S.mintIdx && S.mintIdx.get(s); return i === undefined ? null : fams[famOf[i]]; };
  // the family that owns the view: k past 1.3 k0, the inset rect's centre inside it, and big enough on screen
  function familyAtCentre() {
    const kk = cam.k, m = insetMin(); if (kk < 1.3 * k0()) return -1;
    const ir = S.insetRect(), [vx, vy] = toW((ir.x0 + ir.x1) / 2, (ir.y0 + ir.y1) / 2);
    let best = -1, bs = Infinity;
    const test = (f) => {
      const d = Math.hypot(f.cx - vx, f.cy - vy); if (d > f.Rc + 4 / kk) return;
      if (f.Rc * kk >= 0.3 * m || kk >= 0.6 * famK(f)) { const s = d / Math.max(f.Rc, 1e-3); if (s < bs) { bs = s; best = f.id; } }
    };
    for (const f of planets) test(f);
    forEachDust(vx - maxDustRc, vy - maxDustRc, vx + maxDustRc, vy + maxDustRc, test);
    return best;
  }
  function isFocused(f) {
    const kk = cam.k; if (kk < 1.3 * k0()) return false;
    const [sx, sy] = toS(f.cx, f.cy), r = f.Rc * kk, ir = S.insetRect();
    if (sx + r < ir.x0 || sx - r > ir.x1 || sy + r < ir.y0 || sy - r > ir.y1) return false;
    return r >= 0.3 * insetMin() || kk >= 0.6 * famK(f);
  }

  // ---------- flights (van Wijk) ----------
  let lastClickFlight = null;   // {t, x, y, fam}: the second click of a double-click must not cancel this flight
  function cancelFlight() {
    if (!flight) return;
    const f = flight; flight = null; Object.assign(tgt, cam); anchor = null;
    for (const r of f.resolves) r({ cancelled: true, x: cam.x, y: cam.y, k: cam.k });
  }
  function cancelAll() { cancelFlight(); tween = null; inertia = null; }
  function startFlight(x, y, k, opts = {}) {
    k = clampK(k);
    const prev = flight; flight = null;
    tween = null; inertia = null; anchor = null;
    setHover(-1);
    const m = Math.min(W(), H());
    const p0 = [cam.x, cam.y, m / cam.k], p1 = [x, y, m / k];
    const trivial = Math.hypot(x - cam.x, y - cam.y) * cam.k < 0.5 && Math.abs(Math.log(k / cam.k)) < 2e-3;
    const fl = { x, y, k, m, kind: opts.kind || "point", fam: opts.fam ?? -1, coin: opts.coin ?? -1, onEnd: opts.onEnd, resolves: prev ? prev.resolves : [], t0: performance.now() };
    const done = new Promise((res) => fl.resolves.push(res));
    if (rm || trivial) { flight = fl; endFlight(); return done; }
    fl.path = zoomPath(p0, p1);
    let wmax = 0; for (let s = 1; s < 24; s++) wmax = Math.max(wmax, fl.path(s / 24)[2]);
    fl.ease = wmax > Math.max(p0[2], p1[2]) * 1.001 ? easeInOut : easeOut;   // ease-out unless the path rises above both ends
    fl.dur = clamp(0.45 * fl.path.duration, DUR.flightMin, DUR.flightMax);
    flight = fl;
    return done;
  }
  function endFlight() {
    const f = flight; flight = null; if (!f) return;
    cam.x = f.x; cam.y = f.y; cam.k = f.k; Object.assign(tgt, cam); S.dirty = true;
    focusedFam = f.kind === "fam" ? f.fam : familyAtCentre();
    pointer.dirty = true; labelsDirty = true;
    if (f.onEnd) f.onEnd();
    if (f.kind !== "overview") keepSelectedVisible();   // (map3 port) e.g. the phone sheet rose while the flight ran
    const ms = Math.round(performance.now() - f.t0);
    for (const r of f.resolves) r({ x: cam.x, y: cam.y, k: cam.k, ms });
  }
  const flyTo = (x, y, k) => startFlight(x, y, k);
  const flyToFamily = (f) => { if (!f) return Promise.resolve(null); const t = famTarget(f); return startFlight(t.x, t.y, t.k, { kind: "fam", fam: f.id }); };
  // (map3 port) a pure camera move: the page owns the selection (no temporary select on arrival)
  const flyToCoin = (i) => {
    if (i >= DUST0) { const t = dustTarget(i); if (!t) return Promise.resolve(null); return startFlight(t.x, t.y, t.k, { kind: "fam", fam: t.fam, coin: i }); }
    if (i >= N) { const b = bornAt(i); if (!b) return Promise.resolve(null); const [bx, by] = bornXY(b); return startFlight(bx, by, clampK(Math.max(cam.k, 14 / Math.max(b.r, 0.01))), { kind: b.fam >= 0 ? "fam" : "point", fam: b.fam }); }
    if (!(i >= 0 && i < N)) return Promise.resolve(null); const t = coinTarget(i); return startFlight(t.x, t.y, t.k, { kind: "fam", fam: famOf[i], coin: i });
  };
  // (map3 port) fit() keeps the selection (the prototype's flyOverview cleared it)
  const flyOverview = () => { const t = S.overview.overviewTarget(); return startFlight(t.x, t.y, t.k, { kind: "overview" }); };
  const fitAll = (snap = true) => { if (!snap) return flyOverview(); const t = S.overview.overviewTarget(); setCam(t.x, t.y, t.k, true); focusedFam = -1; };
  const focus = (s, snap = true) => { const f = famByKey(s); if (!f) return; if (!snap) return flyToFamily(f); const t = famTarget(f); setCam(t.x, t.y, t.k, true); focusedFam = f.id; };
  const focusKey = (f) => { const t = (sym[f.top] || "").replace(/^\$+/, ""); return t && S.famBy(t) === f ? t : mint[f.top]; };

  // ---------- selection (map3 port: owned by the page; persistent ring + selected branch, never a tooltip) ----------
  let selected = -1;
  function select(i) {
    if (!(i >= 0)) i = -1;
    if (i === selected) return;
    selected = i;
    S.bubbles.selectCoin(i); S.invalidate();
    if (S.swarm && S.swarm.on) S.swarm.select(i);   // (family-all) a selected speck wears its ring
    if (typeof S.links.setBranch === "function") S.links.setBranch(i >= 0 && i < N ? i : -1);   // (round 2) the selected branch draws at any zoom
    if (i >= 0 && tipShownFor === i) hideTipNow();
    labelsDirty = true;
  }
  // (map3 port) the selected coin stays inside the inset rect: when the page's chrome moved over it (a sheet rose, a panel
  // opened), the camera eases so the coin sits at the inset rect's centre
  function keepSelectedVisible() {
    if (selected < 0 || flight) return false;
    const p = posOf(selected); if (!p) return false;
    const [sx, sy] = toS(p[0], p[1]), ir = S.insetRect();
    if (sx >= ir.x0 && sx <= ir.x1 && sy >= ir.y0 && sy <= ir.y1) return false;
    const mx = (ir.x0 + ir.x1) / 2, my = (ir.y0 + ir.y1) / 2;
    tween = null; inertia = null; anchor = null;
    tgt.x = p[0] - (mx - W() / 2) / tgt.k; tgt.y = p[1] + (my - H() / 2) / tgt.k;
    if (rm) Object.assign(cam, tgt);
    S.dirty = true; S.invalidate();
    return true;
  }

  // ---------- hover: hit-test, dwell, dim, emphasis, tooltip ----------
  const pointer = { x: 0, y: 0, inside: false, dirty: false };
  let hovI = -1, hovDust = false, hovX = 0, hovY = 0, dwell = null, leaveDue = 0, dimOn = false, emphOn = false, hovFamApplied = -1;
  let tipShownFor = -1, tipDue = 0, labelsDirty = false, focusedFam = -1, hullFam = -1, focusWant = -1;
  const hideTipNow = () => { tipDue = 0; if (tipShownFor >= 0) { S.labels.hideTip(); tipShownFor = -1; } };
  // (map3 port) via: 'chip' | 'coin' | 'speck' | 'colony' | 'none' (EngineDebug.pick reports it)
  function hitTest(sx, sy, touch) {
    const k = cam.k, [wx, wy] = toW(sx, sy), ph = phone(), slop = touch ? 10 : 4;
    let best = -1, bs = Infinity, via = "none";
    for (const f of planets) {
      const i = f.top, cr = Math.max(R[i] * k, TOK.chipR(f.share, maxShare, ph));
      const d = Math.hypot(X[i] - wx, Y[i] - wy) * k, hr = Math.max(cr + slop, ph || touch ? 22 : 10);
      if (d < hr) { const s = d < cr ? d - 1e3 : d - cr; if (s < bs) { bs = s; best = i; via = "chip"; } }
    }
    if (bs < -500) return { i: best, dust: false, via };       // inside a chip: chips draw on top
    const showDust = S.dustExpand >= 0.5, reach = Rmax + (slop + 8) / k;
    // (galaxy physics) the drawn radius when the visibility lane exports it; coins on the rope are tested by their LIVE
    // position first (the grid holds their homes until the commit re-buckets them)
    const hasDrawn = G && typeof S.bubbles.drawnPx === "function", hitR = (i) => Math.max(hasDrawn ? drawnR(i) : R[i] * k, notable[i] ? 1.5 : 0);
    if (ropeOrd.length) for (const i of ropeOrd) {
      if (isPlanetTop[i] || (!showDust && !fams[famOf[i]].planet)) continue;
      const rp = hitR(i); if (rp < 1) continue;
      const d = Math.hypot(X[i] - wx, Y[i] - wy) * k; if (d >= rp + slop) continue;
      const s = d - rp; if (s < bs) { bs = s; best = i; via = "coin"; }
    }
    forEachIn(wx - reach, wy - reach, wx + reach, wy + reach, (i) => {
      if (isPlanetTop[i] || inRope[i] || (!showDust && !fams[famOf[i]].planet)) return;
      const rp = hitR(i); if (rp < 1) return;   // sub-pixel stipple is not a target
      const d = Math.hypot(X[i] - wx, Y[i] - wy) * k; if (d >= rp + slop) return;
      const s = d - rp; if (s < bs) { bs = s; best = i; via = "coin"; }
    });
    if (best >= 0) return { i: best, dust: false, via };
    // (family-all) a real speck of a capped asset family (chip > drawn coin > real speck > dust-field speck > colony); the
    // swarm answers only when the slot spacing is >= 3 px on screen; ghosts are never targets
    if (S.swarm && S.swarm.on) { const d = S.swarm.pick(sx, sy, touch); if (d >= DUST0) return { i: d, dust: false, via: "dust" }; }
    if (!showDust) {                                           // a dust speck = one small family
      const dr = (touch ? 14 : 6) / k; let bd = Infinity, bf = null;
      forEachDust(wx - dr, wy - dr, wx + dr, wy + dr, (f) => { const d = Math.hypot(f.cx - wx, f.cy - wy); if (d < dr && d < bd) { bd = d; bf = f; } });
      if (bf) return { i: bf.top, dust: true, via: "speck" };
    }
    if (k <= 1.3 * k0()) for (const f of planets) if (Math.hypot(f.cx - wx, f.cy - wy) < f.Rc) return { i: f.top, dust: false, via: "colony" };   // the colony itself
    return { i: -1, dust: false, via: "none" };
  }
  const emphList = (i) => { if (!(i >= 0 && i < N)) return []; const out = []; for (let c = i; c >= 0 && par[c] >= 0 && out.length < 64; c = par[c]) out.push(c); for (const c of kids[i]) { if (out.length >= 1500) break; out.push(c); } return out; };
  // (map3 port) src: 'pointer' (the pointer over the canvas: onHover is called on a change), 'page' (the page's hover(mint):
  // pinned until hover(null) or the next pointermove, no echo), 'engine' (flights, grabs, pinches: onHover only when they
  // end a pointer hover). noTip: the page pinned a coin that is off screen.
  let hoverSrc = null, pinnedHover = false, noTip = false;
  function setHover(i, sx = hovX, sy = hovY, isDust = false, immediateTip = false, src = "engine", tipOff = false) {
    const now = performance.now();
    if (i === hovI) {
      if (src === "page") { pinnedHover = i >= 0; hoverSrc = i >= 0 ? "page" : null; noTip = tipOff; if (tipOff && i >= 0) { hideTipNow(); return; } }
      if (i < 0) return;
      hovX = sx; hovY = sy;
      if (noTip) return;
      if (tipShownFor === i) S.labels.showTip(i, sx, sy); else if (!tipDue) tipDue = immediateTip ? now : now + DUR.tipDelay;
      return;
    }
    const prevSrc = hoverSrc;
    hoverSrc = i >= 0 ? src : null; pinnedHover = src === "page" && i >= 0; noTip = i >= 0 && tipOff;
    if (src === "pointer" || (src === "engine" && prevSrc === "pointer")) call("onHover", i >= 0 ? mintOf(i) : null);
    hovI = i; S.hoverI = i; hovDust = isDust; hovX = sx; hovY = sy; labelsDirty = true;
    if (i >= N && i < DUST0) {   // (map3 port) a newborn (page hover): its ring only, no family dim, no card
      dwell = null; leaveDue = 0; hideTipNow();
      U.uHover.value = i; U.uHoverT.value = 0; animate("hoverT", U.uHoverT, 1, HOV_MS, easeOut);
      return;
    }
    if (i >= 0) {
      leaveDue = 0;
      const fam = famIdOf(i);   // (family-all) a speck belongs to its asset family
      U.uHover.value = i; U.uHoverT.value = 0; animate("hoverT", U.uHoverT, 1, HOV_MS, easeOut);
      if (U.uHoverFam.value !== fam) {                          // another family: drop the old lineage + hull now
        if (emphOn) { S.links.setEmphasis([]); emphOn = false; }
        hovFamApplied = -1;
      }
      U.uHoverFam.value = fam;                                 // the family brightens at once; the dim waits for the dwell
      if (isDust) { dimOn = false; if (U.uDimMix.value > 0) animate("dim", U.uDimMix, 0, DUR.m, easeOut); else anims.delete("dim"); dwell = { i, fam, t: now, dim: false }; }
      else if (dimOn || U.uDimMix.value > 0.001) { dimOn = true; animate("dim", U.uDimMix, 1, DUR.s, easeOut); dwell = { i, fam, t: now, dim: false }; }
      else dwell = { i, fam, t: now, dim: true };
      if (noTip) hideTipNow();
      else if (tipShownFor >= 0 || immediateTip) { S.labels.showTip(i, sx, sy); tipShownFor = i; tipDue = 0; } else tipDue = now + DUR.tipDelay;
      if (!gesture && src !== "page") el.style.cursor = "pointer";
    } else {
      // the ring and the card go at once; the family dim/hull/emphasis wait one dwell (80 ms), so the gap
      // between two colonies never dips the scene (leaveDue in the tick)
      dwell = null; leaveDue = now + DUR.dwell;
      hideTipNow();
      animate("hoverT", U.uHoverT, 0, DUR.xs, easeOut, 0, () => { if (hovI < 0) U.uHover.value = -1; });
      if (!gesture) el.style.cursor = "grab";
    }
  }
  // (map3 port) the page pins a hover (a side-panel row, the rails): ring + lineage after the dwell, the card at the coin's
  // screen point (none when the coin is off screen); null clears a page hover
  function hoverMint(m) {
    const i = m == null ? -1 : idxOf(m);
    if (i < 0) { if (hovI >= 0 && hoverSrc === "page") setHover(-1, hovX, hovY, false, false, "page"); pinnedHover = false; return; }
    const p = posOf(i); if (!p) return;
    const [sx, sy] = toS(p[0], p[1]), r = i < N && typeof S.bubbles.screenR === "function" ? S.bubbles.screenR(i) : i >= DUST0 && S.swarm ? Math.max(2, S.swarm.screenR(i)) : 4;
    const off = sx + r < 0 || sy + r < 0 || sx - r > W() || sy - r > H();
    setHover(i, sx, sy, false, true, "page", off);
  }
  // (map3 port) the docked card's '×' (and a pointer leaving): drop the hover
  const clearHover = (fromPointer = true) => { pinnedHover = false; setHover(-1, hovX, hovY, false, false, fromPointer ? "pointer" : "engine"); };
  function releaseHoverFamily() {
    leaveDue = 0; hovFamApplied = -1; dimOn = false;
    if (U.uDimMix.value > 0) animate("dim", U.uDimMix, 0, DUR.m, easeOut, 0, () => { if (hovI < 0) U.uHoverFam.value = -1; labelsDirty = true; });
    else { anims.delete("dim"); U.uHoverFam.value = -1; }
    if (emphOn) { S.links.setEmphasis([]); emphOn = false; }
    labelsDirty = true;
  }
  const hoverAt = (sx, sy) => { const h = hitTest(sx, sy, false); setHover(h.i, sx, sy, h.dust); };

  // ---------- tiny tween engine for uniforms ----------
  const anims = new Map();
  function animate(name, obj, to, dur, ease = easeOut, delay = 0, onDone) {
    if (rm) { dur = Math.min(dur, 120); delay = Math.min(delay, 60); }
    if (dur <= 0 && delay <= 0) { obj.value = to; anims.delete(name); if (onDone) onDone(); return; }
    anims.set(name, { obj, from: obj.value, to, t0: performance.now() + delay, dur: Math.max(1, dur), ease, onDone });
  }
  function stepAnims(now) {
    let any = false;
    for (const [n, a] of anims) {
      any = true;
      const u = (now - a.t0) / a.dur; if (u < 0) continue;
      if (u >= 1) { a.obj.value = a.to; anims.delete(n); if (a.onDone) a.onDone(); continue; }
      a.obj.value = a.from + (a.to - a.from) * a.ease(u);
    }
    return any;
  }

  // ---------- coin drag (round 2, amendment E): a liquid local simulation ----------
  // Home is the designed layout (X0/Y0, never mutated). While a coin is held:
  //   - its family runs PER COIN: rest-length springs along every parent/child link (d3 forceLink, strength 0.7, degree
  //     bias), a pull toward each coin's designed position (0.25 top / 0.06 member, x alpha: the live site's TOP_PULL /
  //     MEMBER_PULL, but toward the coin's own home so the shape comes back), rest-relative collision (r + gap, 0.9), and a
  //     charge from the grabbed coin (-30, d3 form, distanceMax ~ 220 px) measured AGAINST the designed layout, so the
  //     layout itself is force-free: what is ahead of the coin is pushed away, what is behind flows into the space it
  //     left (the liquid wake);
  //   - every other family near it is a rigid FLOATING BODY: the same delta charge acts on it (by edge distance), moving
  //     coins and other bodies push it when they come closer than they sit at home (plus a 10 px cushion), and it is
  //     sprung home. So neighbours glide away and flow back, and a push travels on through the packing.
  // velocityDecay 0.45, alphaTarget 0.25 while held (alpha >= 0.3 on grab), 0 after release (alpha decays 0.04 per 16.7
  // ms). After release an alpha-free pull home ramps in, so the region always lands EXACTLY on the designed layout in
  // ~1-1.5 s (the last sub-0.02 px is written as the exact home value). Positions go into S.X/S.Y in place every frame.
  const X0 = Float32Array.from(X), Y0 = Float32Array.from(Y);
  const nF = fams.length, NB = N + 4096;   // (births may append coins past N: the sim never touches them)
  const deg = new Float32Array(N); for (let i = 0; i < N; i++) deg[i] = kids[i].length + (par[i] >= 0 ? 1 : 0);
  const VX = new Float32Array(N), VY = new Float32Array(N);
  const fUx = new Float64Array(nF), fUy = new Float64Array(nF), fVx = new Float64Array(nF), fVy = new Float64Array(nF);
  const fPx = new Float64Array(nF), fPy = new Float64Array(nF), fPm = new Float64Array(nF);
  const fSx = new Float64Array(nF), fSy = new Float64Array(nF), fSm = new Float64Array(nF);   // (integrator) push sums, see pushBody
  const fMode = new Uint8Array(nF);        // 0 at home, 1 floating body, 2 per coin
  // designed family centres. While a family is displaced its f.cx/f.cy follow its top coin (tops sit exactly on the
  // family centre in the layout), so everything anchored on f.cx (planet labels, focus, flights) moves with it; they are
  // written back to these exact values when the family is home.
  const HX = new Float64Array(nF), HY = new Float64Array(nF); for (const f of fams) { HX[f.id] = f.cx; HY[f.id] = f.cy; }
  const syncCentre = (id) => { const f = fams[id], t = f.top; if (fMode[id] === 0) { f.cx = HX[id]; f.cy = HY[id]; } else { f.cx = HX[id] + (X[t] - X0[t]); f.cy = HY[id] + (Y[t] - Y0[t]); } };
  const fInvM = new Float32Array(nF); for (const f of fams) fInvM[f.id] = 1 / (1 + 0.012 * Math.sqrt(f.members.length));
  const SIM = {
    linkK: 0.7, homeTop: 0.25, homeMember: 0.06, keep: 0.55,          // live site constants (layout.worker.ts)
    linkShape: 0.8,                                                     // share of each link spring that keeps the designed OFFSET
                                                                        // (the family glides along as one body); the rest is d3's
                                                                        // rest-length spring (children may swing)
    collide: 0.9, gapPx: 2,                                             // rest-relative collision: r1 + r2 + 2 px
    chargePx: 30, chargeMaxPx: 220,                                     // grabbed coin: -30 (d3 units at k = 1 px/u), ~220 px reach
    settleK: 0.1, settleRampMs: 250,                                    // after release: alpha-free pull home
    bodyHome: 0.045, bodyPadPx: 10, bodyPush: 0.9, bodyCharge: 1.0,     // floating bodies (neighbour families)
    bodySettle: 0.05,                                                   // after release only: extra spring home (the glide itself is untouched)
    pushMode: "blend",                                                  // (integrator, round 2) "blend" (default) or "max" (the lane's original)
    alphaDrag: 0.25, alphaKick: 0.3, alphaDecay: 0.04, restPx: 0.02,
    grabMinPx: 6, grabMinPxG: 0.75,
    // (round 2 final) at the overview a planet chip carries its WHOLE family as one rigid body (its children are a stipple
    // there, not coins you can see move), and that body is a hard disc for the neighbours: they are projected out of its
    // hull (+ hullPadPx) every tick on top of the soft push, so the held family never slides over another one.
    rigidK0: 1.6, hullPadPx: 10,
  };
  const pcFams = [], bodies = [];
  const pcList = new Int32Array(N); let pcN = 0;
  const drag = { i: -1, fam: -1, sx: 0, sy: 0, ox: 0, oy: 0, tx: 0, ty: 0, vx: 0, vy: 0, alpha: 0, aTarget: 0, relT: 0, active: false, grabs: 0, ticks: 0, simMs: 0, simMax: 0 };
  // published read-only state (LANES.md section on the feel lane): S.drag
  const movedBuf = new Int32Array(2 * N); let movedN = 0;
  const famMovedBuf = new Int32Array(nF); let famMovedN = 0;
  const famOn = new Uint8Array(nF);
  S.drag = { active: false, settling: false, grabbed: -1, fam: -1, X0, Y0, moved: movedBuf, nMoved: 0, fams: famMovedBuf, nFams: 0, famDX: fUx, famDY: fUy, famMode: fMode, version: 0 };
  // body grid (families registered at HOME, disc Rc + margin), built at the first grab
  const BCELL = 32, BMARGIN = 40; let bgrid = null;
  const bstamp = new Uint32Array(nF); let bstampN = 1;
  function buildBodyGrid() {
    bgrid = new Map();
    for (const f of fams) {
      const r = f.Rc + BMARGIN;
      const cx = HX[f.id], cy = HY[f.id];
      for (let gx = Math.floor((cx - r) / BCELL); gx <= Math.floor((cx + r) / BCELL); gx++) for (let gy = Math.floor((cy - r) / BCELL); gy <= Math.floor((cy + r) / BCELL); gy++) {
        const k = gkey(gx, gy); let a = bgrid.get(k); if (!a) bgrid.set(k, (a = [])); a.push(f.id);
      }
    }
  }
  const forEachBody = (x0, y0, x1, y1, fn) => {
    const st = ++bstampN;
    for (let gx = Math.floor(x0 / BCELL); gx <= Math.floor(x1 / BCELL); gx++) for (let gy = Math.floor(y0 / BCELL); gy <= Math.floor(y1 / BCELL); gy++) {
      const a = bgrid.get(gkey(gx, gy)); if (!a) continue;
      for (const id of a) if (bstamp[id] !== st) { bstamp[id] = st; fn(id); }
    }
  };
  // dust families float only where their coins are drawn (zoomed in) or when the overview lane can move its specks
  const bodyAllowed = (f) => f.planet || S.dustExpand >= 0.5 || typeof S.overview.setPositions === "function";
  function wakeBody(id) { if (fMode[id] === 0) { fMode[id] = 1; bodies.push(id); } }
  function toPerCoin(id) {
    if (fMode[id] === 2) return;
    const f = fams[id];
    if (fMode[id] === 1) {   // a floating body becomes per coin: its offset and velocity carry over to every coin
      for (const i of f.members) { X[i] = X0[i] + fUx[id]; Y[i] = Y0[i] + fUy[id]; VX[i] = fVx[id]; VY[i] = fVy[id]; }
      const b = bodies.indexOf(id); if (b >= 0) bodies.splice(b, 1);
    } else for (const i of f.members) { VX[i] = 0; VY[i] = 0; }
    fUx[id] = fUy[id] = fVx[id] = fVy[id] = 0;
    fMode[id] = 2; pcFams.push(id); rebuildPcList();
  }
  function rebuildPcList() { pcN = 0; for (const id of pcFams) for (const i of fams[id].members) pcList[pcN++] = i; }
  // spatial hash for the per-coin collision (big coins are entered in every cell their extent covers)
  const HS = 1 << 15, hHead = new Int32Array(HS), eCoin = new Int32Array(N * 4), eNext = new Int32Array(N * 4), seen = new Int32Array(N);
  let seenStamp = 0;
  const hcell = (gx, gy) => (((gx * 73856093) ^ (gy * 19349663)) >>> 0) & (HS - 1);
  function collide(gapW, s) {
    if (pcN < 2) return;
    let rs = 0; for (let q = 0; q < pcN; q++) rs += R[pcList[q]];
    const cs = Math.max(2 * (rs / pcN + gapW) * 1.5, 0.5);
    hHead.fill(-1); let ne = 0;
    for (let q = 0; q < pcN; q++) {
      const i = pcList[q], e = R[i] + gapW;
      const gx0 = Math.floor((X[i] - e) / cs), gx1 = Math.floor((X[i] + e) / cs), gy0 = Math.floor((Y[i] - e) / cs), gy1 = Math.floor((Y[i] + e) / cs);
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) { if (ne >= eCoin.length) break; const h = hcell(gx, gy); eCoin[ne] = i; eNext[ne] = hHead[h]; hHead[h] = ne++; }
    }
    // after release the collision fades with alpha, so two coins that crossed while the family was stretched can slide
    // past each other on the way home instead of pinning each other off their designed spots
    const st = SIM.collide * (drag.i >= 0 ? 1 : Math.min(1, drag.alpha / 0.12));
    if (st <= 0.001) return;
    for (let q = 0; q < pcN; q++) {
      const i = pcList[q], ri = R[i] + gapW * 0.5, ext = R[i] + gapW, st0 = ++seenStamp;
      const gx0 = Math.floor((X[i] - ext) / cs), gx1 = Math.floor((X[i] + ext) / cs), gy0 = Math.floor((Y[i] - ext) / cs), gy1 = Math.floor((Y[i] + ext) / cs);
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
        for (let e = hHead[hcell(gx, gy)]; e >= 0; e = eNext[e]) {
          const j = eCoin[e]; if (j <= i || seen[j] === st0) continue; seen[j] = st0;
          const rr = ri + R[j] + gapW * 0.5;
          let dx = X[i] + VX[i] - X[j] - VX[j], dy = Y[i] + VY[i] - Y[j] - VY[j], l2 = dx * dx + dy * dy;
          if (l2 >= rr * rr) continue;
          const d0 = Math.hypot(X0[i] - X0[j], Y0[i] - Y0[j]), lim = Math.min(rr, d0);
          if (l2 >= lim * lim) continue;                 // never closer than they sit at home: the layout is collision-free
          let l = Math.sqrt(l2); if (l < 1e-6) { dx = rnd(i, j) - 0.5; dy = rnd(j, i) - 0.5; l = Math.hypot(dx, dy) || 1; }
          const m = (lim - l) / l * st * Math.min(1, s), ri2 = R[i] * R[i], rj2 = R[j] * R[j], w = rj2 / (ri2 + rj2);
          VX[i] += dx * m * w; VY[i] += dy * m * w; VX[j] -= dx * m * (1 - w); VY[j] -= dy * m * (1 - w);
        }
      }
    }
  }
  // d3 charge of the grabbed coin, minus the same charge in the designed layout (smooth reach falloff)
  const reach = (d, dm) => { if (d >= dm) return 0; const u = d / dm; return (1 - u * u) * (1 - u * u); };
  function grabbedTarget() { const [wx, wy] = toW(drag.sx, drag.sy); drag.tx = wx + drag.ox; drag.ty = wy + drag.oy; }
  // the held family's hull for the neighbours (world u): its tight bound, or its overview chip when that is larger
  const hullOf = (f) => Math.max(f.Rc, f.planet ? chipPx(f) / cam.k : 0);
  function grab(i, sx, sy) {
    if (!(i >= 0 && i < N)) return false;
    const id = famOf[i];
    if (G) {   // (galaxy physics) the rope: grab offset = pointerWorld - P_g, so the coin never jumps
      const [wx, wy] = toW(sx, sy);
      Object.assign(drag, { i, fam: id, rigid: false, sx, sy, ox: X[i] - wx, oy: Y[i] - wy, tx: X[i], ty: Y[i], vx: 0, vy: 0, aTarget: 0, relT: 0, active: true });
      drag.grabs++; ropeGrab(i);
    } else {
      if (!bgrid) buildBodyGrid();
      const rigid = !rm && i === fams[id].top && fams[id].planet && cam.k < SIM.rigidK0 * k0() && fMode[id] !== 2;
      if (rigid) wakeBody(id); else toPerCoin(id);
      const [wx, wy] = toW(sx, sy);
      Object.assign(drag, { i, fam: id, rigid, sx, sy, ox: X[i] - wx, oy: Y[i] - wy, tx: X[i], ty: Y[i], vx: 0, vy: 0, aTarget: rm ? 0 : SIM.alphaDrag, relT: 0, active: true });
      drag.alpha = Math.max(drag.alpha, rm ? 0 : SIM.alphaKick); drag.grabs++;
    }
    S.drag.active = true; S.drag.grabbed = i; S.drag.fam = id;
    cancelAll(); setHover(-1); hideTipNow();
    U.uHover.value = i; animate("hoverT", U.uHoverT, 1, DUR.xs, easeOut);   // the held coin wears the hover ring, no dim
    el.style.cursor = "grabbing";
    // (map3 port) Esc lets go of the held coin; the window listener lives only while a coin is held
    if (!escOff) escOff = life.on(window, "keydown", (e) => { if (e.key === "Escape" && drag.i >= 0) { release(); if (gesture) gesture.coin = false; } });
    return true;
  }
  let escOff = null;
  function dragMove(sx, sy) { if (drag.i >= 0) { drag.sx = sx; drag.sy = sy; } }
  function release() {
    if (drag.i < 0) return;
    const i = drag.i;
    if (G) { grabbedTarget(); ropeRelease(i); }   // (galaxy physics) no throw: g stays exactly at the drop point
    else if (!rm) { if (drag.rigid) { fVx[drag.fam] = drag.vx * 0.3; fVy[drag.fam] = drag.vy * 0.3; } else { VX[i] = drag.vx * 0.3; VY[i] = drag.vy * 0.3; } }   // a little of the throw carries (d3 would zero it)
    drag.i = -1; drag.aTarget = 0; drag.relT = performance.now(); drag.active = false;
    S.drag.active = false; S.drag.grabbed = -1;
    if (escOff) { escOff(); escOff = null; }
    animate("hoverT", U.uHoverT, 0, DUR.xs, easeOut, 0, () => { if (hovI < 0 && drag.i < 0) U.uHover.value = -1; });
    el.style.cursor = hovI >= 0 ? "pointer" : "grab";
    pointer.dirty = pointer.inside;
  }
  // hit test for a grab: a coin DRAWN at >= 6 px under the pointer (planet chips first: they draw on top)
  // (fixer 2026-10-21, galaxy) small bubbles are grabbable: floor 2.5 px drawn, reach max(drawn + slop, 7 px mouse /
  // 10 px touch); dust tops are grabbable at the overview (galaxy draws them as bubbles there).
  function grabHit(sx, sy, touch) {
    const k = cam.k, [wx, wy] = toW(sx, sy), ph = phone(), slop = touch ? 8 : 2, sR = G ? drawnR : S.bubbles.screenR;
    const minPx = G ? SIM.grabMinPxG : SIM.grabMinPx, reachMin = G ? (touch ? 10 : 7) : 0;
    // a coin drawn under 2.5 px (the 4x stipple of an opened family) reaches 2 px less, so empty space between them still pans
    const reach = (cr) => Math.max(cr + slop, cr >= 2.5 ? reachMin : reachMin - 2);
    let best = -1, bs = Infinity;
    for (const f of planets) {
      const i = f.top, cr = typeof sR === "function" ? sR(i) : Math.max(R[i] * k, TOK.chipR(f.share, maxShare, ph));
      if (!(cr >= minPx)) continue;
      const d = Math.hypot(X[i] - wx, Y[i] - wy) * k; if (d < reach(cr) && d - cr < bs) { bs = d - cr; best = i; }
    }
    if (best >= 0) return best;
    const showDust = S.dustExpand >= 0.5, rch = Rmax + (Math.max(slop, reachMin) + 2) / k;
    const dustTopsOn = !!S.bubbles.drawsDustTops;   // (flat fix) both looks: bubbles.js draws every family top, so it is pickable
    const skip = (i) => !showDust && !fams[famOf[i]].planet && !(dustTopsOn && fams[famOf[i]].top === i);
    // (galaxy physics) coins on the rope first, by their live position
    if (ropeOrd.length) for (const i of ropeOrd) {
      if (isPlanetTop[i] || skip(i)) continue;
      const rp = sR(i); if (!(rp >= minPx)) continue;
      const d = Math.hypot(X[i] - wx, Y[i] - wy) * k; if (d >= reach(rp)) continue;
      if (d - rp < bs) { bs = d - rp; best = i; }
    }
    forEachIn(wx - rch - 40, wy - rch - 40, wx + rch + 40, wy + rch + 40, (i) => {
      if (isPlanetTop[i] || inRope[i] || skip(i)) return;
      const rp = typeof sR === "function" ? sR(i) : R[i] * k; if (!(rp >= minPx)) return;
      const d = Math.hypot(X[i] - wx, Y[i] - wy) * k; if (d >= reach(rp)) return;
      if (d - rp < bs) { bs = d - rp; best = i; }
    });
    return best;
  }
  const noteMoved = (i) => { movedBuf[movedN++] = i; };
  // ---------- (galaxy, physics lane 2026-10-21) rope drag: the grabbed coin leads, its subtree trails on stretchy veins ----------
  // Galaxy only (flat keeps the liquid sim above, spring-back and all). While a coin g is held:
  //   - P_g = pointerWorld(latest pointermove) + grab offset, every frame: no smoothing, no clamp (zero lag).
  //   - D = the descendants of g (parents before children). Nothing else is EVER written: ancestors, siblings and other
  //     families keep their positions bit for bit (no collision, no charge, no push, no home pull).
  //   - each c in D hangs from its parent p on a damped spring toward the anchor A = P_p + r_c (r_c = the offset at grab,
  //     or the pending one while c still settles from an earlier drag): a = -K G e - C_ABS v_c - C_REL (v_c - v_p), with a
  //     generous slack zone (G = 1 up to 0.6 L0, then stiffer) and a hard stretch limit |e| <= L0 (L0 = max(|r_c|, R_p + R_c)).
  //     Semi-implicit Euler, n = clamp(round(dt / (1/120 s)), 1, 4) substeps of dt / n each (dt clamped to 1/30 s), parents
  //     before children in every substep, the held coin interpolated across the substeps: zero frame lag down the chain.
  // On release g stays exactly at the drop point; D glides to its anchors (soft overshoot) and the whole set COMMITS as
  // the new home: X0/Y0 := X/Y, the family centres move by the top's displacement, the grids re-bucket, onMoved(entries).
  // Nothing ever springs back. Measured constants: zeta ~ 0.6, rest ~ 0.8 s, ~ 9 % overshoot, trail ~ 0.086 s x speed.
  // (fixer 2026-10-21) K 70 -> 100 and C_ABS 6 -> 8 keep zeta ~ 0.6 and a ~0.08 s trail but settle faster; the stretch limit
  // gets a screen-space floor (floorPx / k) so kids trail tens of px at the overview; the rest test commits at 0.5 px x 4 frames.
  const RP = { K: 100, CABS: 8, CREL: 4, H: 1 / 120, slack: 0.6, gain: 12, stretch: 1.0, floorPx: 24, restVPx: 0.05, restEPx: 0.5, restFrames: 4, restMs: 3000 };
  const inRope = new Uint8Array(N);                    // 0 free, 1 integrated (in some D), 2 pinned (held, or dropped and fixed)
  const rRX = new Float32Array(N), rRY = new Float32Array(N);   // rest vectors r_c = P_c - P_parent(c)
  let ropeOrd = new Int32Array(0);                      // every coin in the rope set, parents before children
  const ropeFams = new Set();
  const ropeLog = { grabs: 0, commits: 0, movedCoins: 0, lastSettleMs: -1, relT: 0, quiet: 0, maxDevPx: 0, maxStretch: 0, lagPx: 0, maxLagPx: 0, t05: -1 };
  let ropePrevX = 0, ropePrevY = 0;                     // the held coin's position last frame (interpolated across substeps)
  // (galaxy) the drawn hit radius (visibility lane's JS mirror of the vertex shader), else today's screenR, else R k
  const drawnR = (i) => {
    const dp = S.bubbles.drawnPx, sR = S.bubbles.screenR;
    try { if (typeof dp === "function") { const v = dp(i); if (Number.isFinite(v)) return v; } if (typeof sR === "function") { const v = sR(i); if (Number.isFinite(v)) return v; } } catch { /* ignore */ }
    return R[i] * cam.k;
  };
  function ropeRebuildOrder() {
    const out = [];
    for (const id of ropeFams) {
      const f = fams[id], q = [f.top];
      for (let h = 0; h < q.length; h++) { const c = q[h]; if (inRope[c]) out.push(c); for (const k2 of kids[c]) if (k2 < N) q.push(k2); }
    }
    ropeOrd = Int32Array.from(out);
  }
  function ropeGrab(i) {
    const q = [i];
    for (let h = 0; h < q.length; h++) for (const c of kids[q[h]]) if (c < N) q.push(c);
    for (let h = 1; h < q.length; h++) {
      const c = q[h], p = par[c];
      if (inRope[c] === 1) continue;                    // still settling: keep its pending rest vector (and velocity)
      rRX[c] = X[c] - X[p]; rRY[c] = Y[c] - Y[p]; VX[c] = 0; VY[c] = 0; inRope[c] = 1;
    }
    if (inRope[i] === 1) { /* a settling coin is caught: its pending r_i stays for when it is released into a parent's D */ }
    inRope[i] = 2; VX[i] = 0; VY[i] = 0;
    ropeFams.add(famOf[i]); ropeRebuildOrder();
    ropePrevX = X[i]; ropePrevY = Y[i];
    ropeLog.grabs++; ropeLog.quiet = 0; ropeLog.maxStretch = 0;
  }
  function ropeRelease(i) {
    if (i >= 0) { X[i] = drag.tx; Y[i] = drag.ty; VX[i] = 0; VY[i] = 0; }   // exactly at the drop point
    ropeLog.relT = performance.now(); ropeLog.quiet = 0; ropeLog.t05 = -1;
  }
  function ropeStep(now, dt) {
    if (!ropeOrd.length) return false;
    const t0 = performance.now(), k = cam.k, held = drag.i;
    dt = Math.min(Math.max(dt, 0), 1 / 30); if (!(dt > 0)) dt = 1 / 60;
    const n = clamp(Math.round(dt / RP.H), 1, 4), h = dt / n;
    let gx0 = 0, gy0 = 0, gx1 = 0, gy1 = 0, gvx = 0, gvy = 0;
    if (held >= 0) {
      grabbedTarget();
      gx0 = ropePrevX; gy0 = ropePrevY; gx1 = drag.tx; gy1 = drag.ty;
      gvx = (gx1 - gx0) / dt; gvy = (gy1 - gy0) / dt; drag.vx = gvx; drag.vy = gvy;
    }
    movedN = 0; famMovedN = 0;
    const ord = ropeOrd, m = ord.length;
    let maxE = 0, maxV = 0, maxS = 0;
    if (rm) {   // reduced motion: no glide, the chain sits on its anchors at once
      if (held >= 0) { X[held] = gx1; Y[held] = gy1; }
      for (let q = 0; q < m; q++) { const c = ord[q]; if (inRope[c] !== 1) continue; const p = par[c]; X[c] = X[p] + rRX[c]; Y[c] = Y[p] + rRY[c]; VX[c] = VY[c] = 0; }
    } else for (let sub = 1; sub <= n; sub++) {
      if (held >= 0) { const u = sub / n; X[held] = gx0 + (gx1 - gx0) * u; Y[held] = gy0 + (gy1 - gy0) * u; }
      const last = sub === n;
      for (let q = 0; q < m; q++) {
        const c = ord[q]; if (inRope[c] !== 1) continue;
        const p = par[c], pvx = p === held ? gvx : inRope[p] === 1 ? VX[p] : 0, pvy = p === held ? gvy : inRope[p] === 1 ? VY[p] : 0;
        const ax = X[p] + rRX[c], ay = Y[p] + rRY[c];
        let ex = X[c] - ax, ey = Y[c] - ay;
        const L0 = Math.max(Math.hypot(rRX[c], rRY[c]), R[p] + R[c], RP.floorPx / k, 1e-6), el0 = Math.hypot(ex, ey), s = el0 / L0;
        const Gk = s <= RP.slack ? 1 : 1 + RP.gain * (s - RP.slack) * (s - RP.slack);
        let vx = VX[c], vy = VY[c];
        vx += (-RP.K * Gk * ex - RP.CABS * vx - RP.CREL * (vx - pvx)) * h;
        vy += (-RP.K * Gk * ey - RP.CABS * vy - RP.CREL * (vy - pvy)) * h;
        let x = X[c] + vx * h, y = Y[c] + vy * h;
        ex = x - ax; ey = y - ay;
        const el = Math.hypot(ex, ey), lim = RP.stretch * L0;
        if (el > lim) {
          const nx = ex / el, ny = ey / el;
          x = ax + nx * lim; y = ay + ny * lim; ex = nx * lim; ey = ny * lim;
          const vr = (vx - pvx) * nx + (vy - pvy) * ny; if (vr > 0) { vx -= vr * nx; vy -= vr * ny; }
        }
        X[c] = x; Y[c] = y; VX[c] = vx; VY[c] = vy;
        if (last) { const e2 = Math.hypot(ex, ey); if (e2 > maxE) maxE = e2; const v2 = Math.hypot(vx, vy); if (v2 > maxV) maxV = v2; if (e2 / L0 > maxS) maxS = e2 / L0; }
      }
    }
    if (held >= 0) { X[held] = gx1; Y[held] = gy1; ropePrevX = gx1; ropePrevY = gy1; }
    ropeLog.maxDevPx = maxE * k; if (maxS > ropeLog.maxStretch) ropeLog.maxStretch = maxS;
    if (held >= 0) {   // the rendered lag: the coin this frame vs the latest pointer, through the current camera
      const [px, py] = toS(X[held] - drag.ox, Y[held] - drag.oy); ropeLog.lagPx = Math.hypot(px - drag.sx, py - drag.sy);
      if (ropeLog.lagPx > ropeLog.maxLagPx) ropeLog.maxLagPx = ropeLog.lagPx;
    }
    for (let q = 0; q < m; q++) noteMoved(ord[q]);
    for (const id of ropeFams) { const f = fams[id], t = f.top; f.cx = HX[id] + (X[t] - X0[t]); f.cy = HY[id] + (Y[t] - Y0[t]); famMovedBuf[famMovedN++] = id; }
    // rest test (released only): |v| < 0.05 px/frame and |e| < 0.3 px for 8 frames in a row, or 3 s since the release
    if (held < 0) {
      if (maxV * k / 60 < RP.restVPx && maxE * k < RP.restEPx) ropeLog.quiet++; else ropeLog.quiet = 0;
      if (maxE * k < 0.5) { if (ropeLog.t05 < 0) ropeLog.t05 = Math.round(now - ropeLog.relT); } else ropeLog.t05 = -1;   // G10: all of D within 0.5 px
      if (ropeLog.quiet >= RP.restFrames || now - ropeLog.relT >= RP.restMs) { ropeCommit(now); return true; }
    }
    publishMoved();
    const spent = performance.now() - t0;
    drag.ticks++; drag.simMs = drag.simMs * 0.9 + spent * 0.1; if (spent > drag.simMax) drag.simMax = spent;
    return true;
  }
  const XD = S.XD instanceof Float32Array && S.XD.length >= N ? S.XD : (S.XD = Float32Array.from(X));
  const YD = S.YD instanceof Float32Array && S.YD.length >= N ? S.YD : (S.YD = Float32Array.from(Y));
  let movedEntries = 0;
  const movedMints = new Set();
  // a coin that already has an entry (this mount or opts.moved) always re-emits, so a move back to ~0 overrides it
  const hadMoved = new Uint8Array(N);
  if (S.opts.moved && typeof S.opts.moved.forEach === "function") S.opts.moved.forEach((_v, m) => { const j = S.mintIdx && S.mintIdx.get(m); if (j !== undefined && j < N) hadMoved[j] = 1; });
  function rebucket(i, ox, oy) {
    const ko = gkey(Math.floor(ox / CELLW), Math.floor(oy / CELLW)), kn = gkey(Math.floor(X[i] / CELLW), Math.floor(Y[i] / CELLW));
    if (ko === kn) return;
    const a = grid.get(ko); if (a) { const j = a.indexOf(i); if (j >= 0) { a[j] = a[a.length - 1]; a.pop(); } if (!a.length) grid.delete(ko); }
    let b = grid.get(kn); if (!b) grid.set(kn, (b = [])); b.push(i);
  }
  function rebucketDust(f, ox, oy) {
    const ko = gkey(Math.floor(ox / DCELL), Math.floor(oy / DCELL)), kn = gkey(Math.floor(f.cx / DCELL), Math.floor(f.cy / DCELL));
    if (ko === kn) return;
    const a = dgrid.get(ko); if (a) { const j = a.indexOf(f); if (j >= 0) a.splice(j, 1); if (!a.length) dgrid.delete(ko); }
    let b = dgrid.get(kn); if (!b) dgrid.set(kn, (b = [])); b.push(f);
  }
  function ropeCommit(now) {
    const ord = ropeOrd, m = ord.length;
    for (let q = 0; q < m; q++) { const c = ord[q]; if (inRope[c] !== 1) continue; const p = par[c]; X[c] = X[p] + rRX[c]; Y[c] = Y[p] + rRY[c]; }
    // newborns under a moved parent: bake their offset (it is measured against X0, which is about to change)
    if (born.size) for (const b of born.values()) {
      if (!(b.p >= 0 && b.p < N) || !inRope[b.p]) continue;
      b.x += X[b.p] - X0[b.p]; b.y += Y[b.p] - Y0[b.p]; b.ox = 0; b.oy = 0;
      if (b.idx >= 0 && typeof S.bubbles.moveCoin === "function") S.bubbles.moveCoin(b.idx, b.x, b.y);
    }
    for (const id of ropeFams) {
      const f = fams[id], t = f.top, dx = X[t] - X0[t], dy = Y[t] - Y0[t], ocx = HX[id], ocy = HY[id];
      HX[id] += dx; HY[id] += dy; f.cx = HX[id]; f.cy = HY[id];
      if (!f.planet) rebucketDust(f, ocx, ocy);
    }
    const entries = [];
    for (let q = 0; q < m; q++) {
      const c = ord[q], p = par[c];
      let dx = X[c] - XD[c], dy = Y[c] - YD[c];
      if (p >= 0) { dx -= X[p] - XD[p]; dy -= Y[p] - YD[p]; }
      if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4 || hadMoved[c]) { entries.push({ mint: mint[c], dx, dy }); hadMoved[c] = 1; movedMints.add(mint[c]); }
      rebucket(c, X0[c], Y0[c]);
      X0[c] = X[c]; Y0[c] = Y[c]; VX[c] = 0; VY[c] = 0; inRope[c] = 0; rRX[c] = 0; rRY[c] = 0;
    }
    bgrid = null;   // the flat body grid is rebuilt from the new homes on its next use
    movedN = 0; for (let q = 0; q < m; q++) movedBuf[movedN++] = ord[q];
    famMovedN = 0; for (const id of ropeFams) famMovedBuf[famMovedN++] = id;
    ropeOrd = new Int32Array(0); ropeFams.clear();
    ropeLog.commits++; ropeLog.movedCoins += m; ropeLog.lastSettleMs = ropeLog.relT ? Math.round(now - ropeLog.relT) : -1; ropeLog.lastWithin05Ms = ropeLog.t05; ropeLog.quiet = 0;
    drag.fam = -1; S.drag.fam = -1;
    movedEntries += entries.length;
    // publish the final frame (moved buffers + 'positions' as every frame), then the commit
    publishMoved();
    const P = S.drag;
    P.version++;
    try { S.emit("positions", { ...P, moved: ord, nMoved: m, committed: true, coins: ord }); } catch (e) { if (errors++ < 3) console.error(e); }
    if (entries.length) call("onMoved", entries);
    labelsDirty = true; S.invalidate();
  }
  const ropeActive = () => ropeOrd.length > 0;
  function simStep(now, dt) {
    if (G) return ropeStep(now, dt);   // (galaxy physics) the rope; everything below is the flat look's liquid sim
    if (!pcFams.length && !bodies.length) return false;
    const t0 = performance.now(), s = Math.max(0.25, Math.min(3, dt / 0.01667)), keep = Math.pow(SIM.keep, s), k = cam.k;
    drag.alpha += (drag.aTarget - drag.alpha) * (1 - Math.pow(1 - SIM.alphaDecay, s));
    const alpha = drag.alpha, held = drag.i;
    // after release an alpha-free pull home ramps in (under reduced motion it is strong: back in ~100 ms, no glide)
    const settle = held < 0 && drag.relT ? (rm ? 0.45 : SIM.settleK * smooth(0, SIM.settleRampMs, now - drag.relT)) : 0;
    if (held >= 0) grabbedTarget();
    movedN = 0; famMovedN = 0;
    // ---- per-coin families ----
    if (pcN) {
      // links (d3 forceLink: rest length = designed length, strength 0.7, bias by degree)
      const lk = SIM.linkK * alpha * s;
      const ks = lk * SIM.linkShape, kl = lk * (1 - SIM.linkShape);
      if (lk > 0) for (let q = 0; q < pcN; q++) {
        const c = pcList[q], p = par[c]; if (p < 0) continue;
        const dx = X[c] + VX[c] - X[p] - VX[p], dy = Y[c] + VY[c] - Y[p] - VY[p], l = Math.hypot(dx, dy) || 1e-6;
        const ox = X0[c] - X0[p], oy = Y0[c] - Y0[p], L0 = Math.hypot(ox, oy), m = (l - L0) / l * kl, b = deg[p] / (deg[p] + deg[c]);
        const ex = (dx - ox) * ks + dx * m, ey = (dy - oy) * ks + dy * m;
        VX[c] -= ex * b; VY[c] -= ey * b; VX[p] += ex * (1 - b); VY[p] += ey * (1 - b);
      }
      // home pull
      for (let q = 0; q < pcN; q++) {
        const i = pcList[q], kh = ((par[i] < 0 ? SIM.homeTop : SIM.homeMember) * alpha + settle) * s;
        VX[i] += (X0[i] - X[i]) * kh; VY[i] += (Y0[i] - Y[i]) * kh;
      }
      // the grabbed coin's charge on its own family, measured against the designed layout
      if (held >= 0 && alpha > 0) {
        const dm = SIM.chargeMaxPx / k, Q = SIM.chargePx / (k * k) * alpha * s, gx = drag.tx, gy = drag.ty, hx = X0[held], hy = Y0[held];
        for (const i of fams[drag.fam].members) {
          if (i === held) continue;
          const dx = X[i] - gx, dy = Y[i] - gy, d = Math.hypot(dx, dy), dx0 = X0[i] - hx, dy0 = Y0[i] - hy, d0 = Math.hypot(dx0, dy0);
          const mn = R[i] + R[held] + 1 / k, a = reach(d, dm) * Q / Math.max(d, mn) / Math.max(d, mn), b = reach(d0, dm) * Q / Math.max(d0, mn) / Math.max(d0, mn);
          VX[i] += dx * a - dx0 * b; VY[i] += dy * a - dy0 * b;
        }
      }
      if (!rm) collide(SIM.gapPx / k, s);
      // integrate
      for (let q = 0; q < pcN; q++) {
        const i = pcList[q], ox = X[i], oy = Y[i];
        if (i === held) {
          const nx = drag.tx, ny = drag.ty;
          drag.vx = (nx - ox) / s; drag.vy = (ny - oy) / s; VX[i] = 0; VY[i] = 0; X[i] = nx; Y[i] = ny;
        } else { VX[i] *= keep; VY[i] *= keep; X[i] += VX[i] * s; Y[i] += VY[i] * s; }
        if (X[i] !== ox || Y[i] !== oy) noteMoved(i);
      }
    }
    // ---- floating bodies (the other families near the moving coins) ----
    const padW = SIM.bodyPadPx / k;
    // (integrator, round 2) a body squeezed between two pushers (the dragged family on one side, a heavier body on the other)
    // used to take only the LARGEST push each frame, so the winner flipped from frame to frame: a 3-frame limit cycle of
    // +-1.5 px (measured on $YAJUCoin while $PUMP was held next to $Kimchi). "blend" takes the vector SUM of the frame's
    // pushes scaled to the largest magnitude: identical to the max when the pushes agree (a push that travels through the
    // packing is unchanged), and they cancel when they oppose, so a squeezed body holds still instead of vibrating.
    const pushBody = (id, px, py) => {
      const m = px * px + py * py;
      if (m > fPm[id]) { fPm[id] = m; fPx[id] = px; fPy[id] = py; }
      fSx[id] += px; fSy[id] += py; fSm[id] += Math.sqrt(m);
    };
    // (round 2 final) the held rigid family (overview): it follows the pointer 1:1 and is never pushed itself
    const rb = drag.rigid && held >= 0 ? drag.fam : -1;
    if (rb >= 0) {
      const nx = drag.tx - X0[held], ny = drag.ty - Y0[held];
      drag.vx = (nx - fUx[rb]) / s; drag.vy = (ny - fUy[rb]) / s;
      fUx[rb] = nx; fUy[rb] = ny; fVx[rb] = 0; fVy[rb] = 0;
    }
    // moving coins push bodies when they come closer than they sit at home (plus the cushion)
    if (!rm) for (let q = 0; q < pcN; q++) {
      const i = pcList[q];
      if (Math.abs(X[i] - X0[i]) + Math.abs(Y[i] - Y0[i]) < 1e-4 && i !== held) continue;
      const pad = padW + (i === held ? 18 / k : 0), e = R[i] + pad;
      forEachBody(X[i] - e, Y[i] - e, X[i] + e, Y[i] + e, (id) => {
        if (fMode[id] === 2 || id === famOf[i] || id === rb) return;
        const f = fams[id]; if (!bodyAllowed(f)) return;
        const cx = HX[id] + fUx[id], cy = HY[id] + fUy[id], dx = cx - X[i], dy = cy - Y[i], d = Math.hypot(dx, dy) || 1e-6;
        const need = R[i] + f.Rc + pad, d0 = Math.hypot(HX[id] - X0[i], HY[id] - Y0[i]), lim = Math.min(need, d0);
        if (d >= lim) return;
        wakeBody(id); pushBody(id, dx / d * (lim - d), dy / d * (lim - d));
      });
    }
    // the grabbed coin's charge on nearby bodies (by edge distance), against the designed layout: the wake
    if (held >= 0 && alpha > 0 && SIM.bodyCharge > 0 && !rm) {
      const dm = SIM.chargeMaxPx / k, Q = SIM.chargePx * SIM.bodyCharge / (k * k) * alpha * s, gx = drag.tx, gy = drag.ty, hx = X0[held], hy = Y0[held];
      const visit = (id) => {
        if (fMode[id] === 2 || id === rb) return; const f = fams[id]; if (!bodyAllowed(f)) return;
        const cx = HX[id] + fUx[id], cy = HY[id] + fUy[id];
        const soft = 8 / k;   // soft core: the push never spikes when the coin touches the colony's edge
        const dx = cx - gx, dy = cy - gy, dc = Math.hypot(dx, dy) || 1e-6, de = Math.max(dc - f.Rc, 0) + soft;
        const dx0 = HX[id] - hx, dy0 = HY[id] - hy, dc0 = Math.hypot(dx0, dy0) || 1e-6, de0 = Math.max(dc0 - f.Rc, 0) + soft;
        const a = reach(de - soft, dm) * Q / de / dc, b = reach(de0 - soft, dm) * Q / de0 / dc0;
        const vx = (dx * a - dx0 * b) * fInvM[id], vy = (dy * a - dy0 * b) * fInvM[id];
        if (vx * vx + vy * vy < 1e-12) return;
        wakeBody(id); fVx[id] += vx; fVy[id] += vy;
      };
      const r = dm + BMARGIN;
      forEachBody(gx - r, gy - r, gx + r, gy + r, visit);
      forEachBody(hx - r, hy - r, hx + r, hy + r, visit);
    }
    // bodies push bodies (rest-relative) so a push travels on through the packing
    for (let b = 0; b < bodies.length; b++) {
      const a = bodies[b], fa = fams[a], ax = HX[a] + fUx[a], ay = HY[a] + fUy[a], ra = a === rb ? hullOf(fa) + SIM.hullPadPx / k : fa.Rc, e = ra + padW;
      forEachBody(ax - e, ay - e, ax + e, ay + e, (id) => {
        if (id === a || fMode[id] === 2) return;
        const fb = fams[id]; if (!bodyAllowed(fb)) return;
        const bx = HX[id] + fUx[id], by = HY[id] + fUy[id], dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1e-6;
        const rbb = id === rb ? hullOf(fb) + SIM.hullPadPx / k : fb.Rc;
        const need = ra + rbb + padW, d0 = Math.hypot(HX[id] - HX[a], HY[id] - HY[a]), lim = Math.min(need, d0);
        if (d >= lim) return;
        // the held rigid family is immovable: the other body takes the whole push
        const pen = lim - d, wa = a === rb ? 0 : id === rb ? 1 : fInvM[a] / (fInvM[a] + fInvM[id]);
        wakeBody(id); pushBody(id, dx / d * pen * (1 - wa), dy / d * pen * (1 - wa)); pushBody(a, -dx / d * pen * wa, -dy / d * pen * wa);
      });
    }
    // integrate bodies, sleep the ones that are home again, write their members
    for (let b = bodies.length - 1; b >= 0; b--) {
      const id = bodies[b];
      if (id === rb) { fPm[id] = 0; fSx[id] = fSy[id] = fSm[id] = 0; continue; }   // set from the pointer above
      if (fPm[id] > 0) {
        let px = fPx[id], py = fPy[id];
        if (SIM.pushMode === "blend" && fSm[id] > 0) { const sc = Math.sqrt(fPm[id]) / fSm[id]; px = fSx[id] * sc; py = fSy[id] * sc; }
        fVx[id] += px * SIM.bodyPush * fInvM[id] * Math.min(1, s); fVy[id] += py * SIM.bodyPush * fInvM[id] * Math.min(1, s);
        fPm[id] = 0; fSx[id] = fSy[id] = fSm[id] = 0;
      }
      const kb = (SIM.bodyHome + (held < 0 && drag.relT ? SIM.bodySettle * smooth(0, SIM.settleRampMs, now - drag.relT) : 0)) * s;
      fVx[id] += -fUx[id] * kb; fVy[id] += -fUy[id] * kb;
      fVx[id] *= keep; fVy[id] *= keep; fUx[id] += fVx[id] * s; fUy[id] += fVy[id] * s;
    }
    // (round 2 final) hard constraint: no neighbour inside the held family's hull (+ pad), measured rest-relative (never
    // closer than it sits at home), so the held family DENTS the packing instead of sliding over it. The inward velocity
    // goes too, so a projected body does not bounce back in.
    if (rb >= 0) {
      const fr = fams[rb], hx = HX[rb] + fUx[rb], hy = HY[rb] + fUy[rb], hr = hullOf(fr) + SIM.hullPadPx / k, reachW = hr + 160;
      const proj = (id) => {
        if (id === rb || fMode[id] === 2) return; const f = fams[id]; if (!bodyAllowed(f)) return;
        const cx = HX[id] + fUx[id], cy = HY[id] + fUy[id], dx = cx - hx, dy = cy - hy, d = Math.hypot(dx, dy) || 1e-6;
        const d0 = Math.hypot(HX[id] - HX[rb], HY[id] - HY[rb]), lim = Math.min(hr + f.Rc, d0);
        if (d >= lim) return;
        wakeBody(id);
        const nx = dx / d, ny = dy / d, pen = lim - d;
        fUx[id] += nx * pen; fUy[id] += ny * pen;
        const vn = fVx[id] * nx + fVy[id] * ny; if (vn < 0) { fVx[id] -= vn * nx; fVy[id] -= vn * ny; }
      };
      forEachBody(hx - reachW, hy - reachW, hx + reachW, hy + reachW, proj);
      drag.projN = (drag.projN || 0) + 1;
    }
    for (let b = bodies.length - 1; b >= 0; b--) {
      const id = bodies[b];
      let done = false;
      if (id !== rb && Math.hypot(fUx[id], fUy[id]) * k < SIM.restPx && Math.hypot(fVx[id], fVy[id]) * k < SIM.restPx) { fUx[id] = fUy[id] = fVx[id] = fVy[id] = 0; done = true; }
      const ux = fUx[id], uy = fUy[id];
      for (const i of fams[id].members) { const nx = X0[i] + ux, ny = Y0[i] + uy; if (X[i] !== nx || Y[i] !== ny) { X[i] = nx; Y[i] = ny; noteMoved(i); } }
      famMovedBuf[famMovedN++] = id;
      if (done) { fMode[id] = 0; bodies.splice(b, 1); }
      syncCentre(id);
    }
    // retire per-coin families that are home again (the last sub-0.02 px lands on the exact designed value)
    for (let q = pcFams.length - 1; q >= 0; q--) {
      const id = pcFams[q]; if (id === drag.fam && held >= 0) { famMovedBuf[famMovedN++] = id; syncCentre(id); continue; }
      let rest = true;
      for (const i of fams[id].members) { if (Math.hypot(X[i] - X0[i], Y[i] - Y0[i]) * k >= SIM.restPx || Math.hypot(VX[i], VY[i]) * k >= SIM.restPx) { rest = false; break; } }
      if (rest && (held < 0 || drag.alpha < 0.02)) {
        for (const i of fams[id].members) { if (X[i] !== X0[i] || Y[i] !== Y0[i]) { X[i] = X0[i]; Y[i] = Y0[i]; noteMoved(i); } VX[i] = VY[i] = 0; }
        fMode[id] = 0; pcFams.splice(q, 1); rebuildPcList();
      } else famMovedBuf[famMovedN++] = id;
      syncCentre(id);
    }
    if (!pcFams.length && !bodies.length && held < 0) { drag.alpha = 0; drag.relT = 0; drag.fam = -1; drag.rigid = false; S.drag.fam = -1; }
    publishMoved();
    const spent = performance.now() - t0;
    drag.ticks++; drag.simMs = drag.simMs * 0.9 + spent * 0.1; if (spent > drag.simMax) drag.simMax = spent;
    return true;
  }
  // tell the other lanes what moved this frame (bubbles follows S.X/S.Y by itself; see LANES.md, feel lane)
  function publishMoved() {
    const P = S.drag;
    P.nMoved = movedN; P.nFams = famMovedN; P.settling = !drag.active && (pcFams.length > 0 || bodies.length > 0 || ropeOrd.length > 0);
    if (!movedN && !famMovedN) return;
    P.version++;
    // (integrator, round 2) a newborn (index >= N, no slot in S.X/S.Y) moves rigidly with its parent's offset; links moves
    // its born link's child end by the same offset (links.js bornSync)
    if (born.size && typeof S.bubbles.moveCoin === "function") for (const b of born.values()) {
      if (!(b.idx >= 0) || !(b.p >= 0)) continue;
      const ox = X[b.p] - X0[b.p], oy = Y[b.p] - Y0[b.p];
      if (ox === (b.ox || 0) && oy === (b.oy || 0)) continue;
      b.ox = ox; b.oy = oy; S.bubbles.moveCoin(b.idx, b.x + ox, b.y + oy);
    }
    // links.js (round 2) diffs S.X/S.Y against the designed layout every frame by itself (S.links.follow exists): nothing to do
    try { if (typeof S.overview.setPositions === "function") S.overview.setPositions(famMovedBuf, famMovedN); } catch (e) { if (errors++ < 3) console.error(e); }
    try { if (typeof S.labels.setPositions === "function") S.labels.setPositions(movedBuf, movedN); } catch (e) { if (errors++ < 3) console.error(e); }
    S.emit("positions", P);
    labelsDirty = true; S.invalidate();
  }
  // (map3 port) the prototype's aXY full-upload guard and link-vertex fallback served older bubbles.js / links.js; both
  // modules here have the fixes (S.bubbles.rangesSafe, S.links.follow), so they are not ported.

  // ---------- input (map3 port: every listener through S.life; container-relative px) ----------
  let rect = el.getBoundingClientRect();
  const refreshRect = () => { rect = el.getBoundingClientRect(); };
  const P = (e) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  const ptrs = new Map();
  let gesture = null;   // {downX, downY, t, pinch, dragging, samples[], type}
  let pinchPrev = null;
  el.style.cursor = "grab";
  // (final fix) every input on the map (and the page's camera calls in S.api) wakes the live coins' breathing (bubbles.js)
  const wake = () => { S.lastInputAt = performance.now(); };
  for (const t of ["pointerdown", "pointermove", "wheel", "dblclick"]) life.on(el, t, wake, { passive: true });
  // (final fix) touch hygiene: a long-press grabs a coin, so the browser's context menu / callout never opens on the map
  life.on(el, "contextmenu", (e) => e.preventDefault());
  // (final fix) the engine reads pointer events only; a tap's compatibility mouse events and click are suppressed. They
  // landed on whatever the tap had just put under the finger: a tap low on the screen docks the card there, and the
  // click then pressed its "Open family" button.
  life.on(el, "touchend", (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  life.on(el, "pointerenter", refreshRect);
  life.on(el, "wheel", (e) => {
    e.preventDefault();
    refreshRect();
    cancelAll();
    const p = P(e), dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H() : 1);
    zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)));
    pointer.x = p.x; pointer.y = p.y; pointer.inside = true; pointer.dirty = true;
  }, { passive: false });
  life.on(el, "pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    refreshRect();
    const p = P(e), now = performance.now();
    try { el.setPointerCapture(e.pointerId); } catch {}
    const lc = lastClickFlight;
    if (flight && !(lc && now - lc.t < 450 && Math.hypot(p.x - lc.x, p.y - lc.y) < 8)) cancelFlight();
    tween = null; inertia = null;
    ptrs.set(e.pointerId, { x: p.x, y: p.y });
    if (ptrs.size === 1) {
      gesture = { downX: p.x, downY: p.y, lastX: p.x, lastY: p.y, t: now, pinch: false, dragging: false, coin: false, grabI: -1, grabTimer: 0, samples: [{ t: e.timeStamp, x: p.x, y: p.y }], type: e.pointerType };
      // (round 2) a press on a coin drawn >= 6 px grabs it: at once with a mouse/pen (the drag starts after 3 px), after a
      // 250 ms long-press with a finger (a plain touch pans). Empty space pans as before.
      const gi = grabHit(p.x, p.y, e.pointerType === "touch");
      if (gi >= 0) {
        gesture.grabI = gi;
        if (e.pointerType === "touch") {
          const g = gesture;
          g.grabTimer = life.timeout(() => {
            g.grabTimer = 0;
            if (gesture !== g || g.dragging || g.pinch || ptrs.size !== 1) return;
            g.coin = true; g.dragging = true; grab(gi, g.downX, g.downY); dragMove(g.lastX, g.lastY);
          }, 250);
        }
      }
    }
    else if (gesture) {
      if (gesture.grabTimer) { life.clearTimeout(gesture.grabTimer); gesture.grabTimer = 0; }
      if (gesture.coin) { release(); gesture.coin = false; }        // a second finger: the coin drops, the pinch takes over
      gesture.pinch = true; gesture.dragging = false; setHover(-1);
      const [a, b] = [...ptrs.values()];
      pinchPrev = { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
    }
  });
  life.on(el, "pointermove", (e) => {
    const p = P(e), q = ptrs.get(e.pointerId);
    // (map3 port) a real pointermove ends a page-pinned hover (the hit test takes over again)
    if (!q) { if (e.pointerType !== "touch") { pointer.x = p.x; pointer.y = p.y; pointer.inside = true; pointer.dirty = true; pinnedHover = false; } return; }
    if (ptrs.size === 1 && gesture) {
      gesture.lastX = p.x; gesture.lastY = p.y;
      if (gesture.coin) { dragMove(p.x, p.y); q.x = p.x; q.y = p.y; return; }
      const far = Math.hypot(p.x - gesture.downX, p.y - gesture.downY);
      // a finger resting on a coin may jitter a few px while the long-press runs: it pans only past 8 px
      if (!gesture.dragging && !gesture.pinch && far > (gesture.grabTimer ? 8 : 3)) {
        if (gesture.grabTimer) { life.clearTimeout(gesture.grabTimer); gesture.grabTimer = 0; }
        if (gesture.grabI >= 0 && gesture.type !== "touch") { gesture.coin = true; gesture.dragging = true; grab(gesture.grabI, gesture.downX, gesture.downY); dragMove(p.x, p.y); q.x = p.x; q.y = p.y; return; }
        gesture.dragging = true; el.style.cursor = "grabbing"; setHover(-1); hideTipNow();
      }
      if (gesture.dragging) {
        const dx = (p.x - q.x) / cam.k, dy = (p.y - q.y) / cam.k;
        cam.x -= dx; cam.y += dy; tgt.x -= dx; tgt.y += dy; if (anchor) { anchor.wx -= dx; anchor.wy += dy; }
        q.x = p.x; q.y = p.y; S.dirty = true;
        gesture.samples.push({ t: e.timeStamp, x: p.x, y: p.y }); while (gesture.samples.length > 2 && e.timeStamp - gesture.samples[0].t > 120) gesture.samples.shift();
      }
      return;
    }
    q.x = p.x; q.y = p.y;
    if (ptrs.size >= 2) {   // touch pinch: 1:1, the content stays under the fingers (zoom + two-finger pan)
      const [a, b] = [...ptrs.values()], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      if (pinchPrev) {
        const [wx, wy] = toW(pinchPrev.mx, pinchPrev.my), k1 = clampK(cam.k * d / pinchPrev.d);
        cam.k = k1; cam.x = wx - (mx - W() / 2) / k1; cam.y = wy + (my - H() / 2) / k1; Object.assign(tgt, cam); anchor = null; S.dirty = true;
      }
      pinchPrev = { mx, my, d };
    }
  });
  function endPointer(e, cancelled) {
    if (!ptrs.has(e.pointerId)) return;
    const p = P(e), now = performance.now();
    ptrs.delete(e.pointerId);
    if (ptrs.size === 1 && gesture && !gesture.coin) {   // pinch -> one finger left: keep panning from where it is, no click
      pinchPrev = null; gesture.pinch = true; gesture.dragging = true; return;
    }
    if (ptrs.size > 0 || !gesture) return;
    const g = gesture; gesture = null; pinchPrev = null;
    if (g.grabTimer) { life.clearTimeout(g.grabTimer); g.grabTimer = 0; }
    if (g.coin) { release(); return; }                              // a held coin is let go: the region flows home
    const tot = Math.hypot(p.x - g.downX, p.y - g.downY);
    if (!cancelled && !g.pinch && !g.dragging && tot < 5) onClick(p.x, p.y, g.type, now);
    else if (!cancelled && g.dragging && !g.pinch && !rm) {
      const s = g.samples, last = s[s.length - 1];
      if (e.timeStamp - last.t < 50) {
        let first = last; for (let j = s.length - 1; j >= 0 && last.t - s[j].t <= 80; j--) first = s[j];
        const dtm = last.t - first.t;
        if (dtm > 8) { const vx = (last.x - first.x) / dtm * 16.7, vy = (last.y - first.y) / dtm * 16.7; if (Math.hypot(vx, vy) > 0.5) inertia = { vx, vy }; }
      }
    }
    el.style.cursor = hovI >= 0 ? "pointer" : "grab";
    if (g.type !== "touch") { pointer.x = p.x; pointer.y = p.y; pointer.inside = true; pointer.dirty = true; }
  }
  life.on(el, "pointerup", (e) => endPointer(e, false));
  life.on(el, "pointercancel", (e) => endPointer(e, true));
  life.on(el, "pointerleave", (e) => { if (e.pointerType === "touch" || ptrs.size) return; pointer.inside = false; pointer.dirty = false; if (hoverSrc === "pointer") setHover(-1, hovX, hovY, false, false, "pointer"); });
  // (map3 port) the page owns the selection: every decision goes through callbacks.onSelect
  const emitSelect = (i) => call("onSelect", i >= 0 ? mintOf(i) : null);
  // the click rule (also a second tap on the same coin, and the phone card's 'Open family' / 'Select')
  function clickRule(i, sx, sy, now) {
    if (i >= N) { select(i); emitSelect(i); return; }   // a newborn (page-selected or hovered): select it
    const f = fams[famOf[i]];
    if (isFocused(f)) { select(i); emitSelect(i); return; }
    if (!(flight && flight.kind === "fam" && flight.fam === f.id)) { lastClickFlight = { t: now, x: sx, y: sy }; flyToFamily(f); }   // else already on its way
    select(f.top); emitSelect(f.top);
  }
  function onClick(sx, sy, type, now) {
    const touch = type === "touch", h = hitTest(sx, sy, touch), i = h.i;
    if (touch) {   // first tap = hover (docked card), a second tap on the same coin = the click rule
      if (i < 0) { clearHover(true); select(-1); emitSelect(-1); return; }
      if (i !== hovI) { setHover(i, sx, sy, h.dust, true, "pointer"); return; }
    } else if (i < 0) { select(-1); emitSelect(-1); return; }
    clickRule(i, sx, sy, now);
  }
  // (final fix) phone: the docked card covers the bottom of the screen (labels.js passes its top edge). A hovered coin it
  // would cover glides up until it sits above the card, never above the inset rect's top (the page's overlay).
  function keepAbove(i, yMax) {
    if (!phone() || gesture || drag.i >= 0 || flight) return;
    const p = posOf(i); if (!p) return;
    const [, sy] = toS(p[0], p[1]);
    const r = Math.max(4, S.bubbles.outerR ? S.bubbles.outerR(i) : p[2] * cam.k);
    const over = sy + r - yMax; if (over <= 0) return;
    const ir = S.insetRect(), d = Math.min(over, sy - r - (ir.y0 + 4));
    if (d < 2) return;
    panBy(0, -d);   // world y up: looking down moves the content up
  }
  // the phone card's button: exactly a second tap on the hovered coin
  const tapAction = (i) => { if (!(i >= 0)) return; const p = posOf(i); const [sx, sy] = p ? toS(p[0], p[1]) : [W() / 2, H() / 2]; clickRule(i, sx, sy, performance.now()); clearHover(true); };
  life.on(el, "dblclick", (e) => { e.preventDefault(); if (flight) return; refreshRect(); const p = P(e); zoomTween(p.x, p.y, 2, 300); });
  // (map3 port) the container changed size (the app's ResizeObserver calls handle.resize): re-read it and the DPR
  function resize() {
    const atOverview = !flight && Math.abs(cam.k / k0() - 1) < 0.03;
    S.measure();
    S.gfx.resize();   // renderer + composer + bloom; recomputes k0
    refreshRect();
    if (atOverview) { const t = S.overview.overviewTarget(); setCam(t.x, t.y, t.k, true); }
    else { cam.k = clampK(cam.k); tgt.k = clampK(tgt.k); }
    S.dirty = true; S.invalidate(); S.emit("resize");
    labelsDirty = true;
  }
  // (map3 port) the page's chrome moved: insets, the fit inset (k0) and the label obstacles
  function setInset(inset, fitInset, obstacles) {
    const atOverview = !flight && !tween && Math.abs(cam.k / k0() - 1) < 0.03;
    S.setInsets(inset, fitInset, obstacles);
    const t = S.overview.overviewTarget();   // refreshes k0 from the new fit rect
    // a running flight is retargeted against the new rect (a click opened the side panel or the phone sheet mid-flight)
    if (flight && flight.kind === "fam" && fams[flight.fam]) {
      const f = fams[flight.fam], c = flight.coin, ft = (c >= DUST0 ? dustTarget(c) : null) || (c >= 0 && c < N ? coinTarget(c) : famTarget(f)), onEnd = flight.onEnd;
      startFlight(ft.x, ft.y, ft.k, { kind: "fam", fam: f.id, coin: c, onEnd });
    }
    else if (flight && flight.kind === "overview") startFlight(t.x, t.y, t.k, { kind: "overview" });
    else if (atOverview) setCam(t.x, t.y, t.k, rm);
    else keepSelectedVisible();
    S.labels.setInsets?.();
    labelsDirty = true; S.dirty = true; S.invalidate();
  }

  // ---------- data life (round 2, amendments B, C, D): live trades, heat payloads, class changes, pulses, births ----------
  const cls = new Uint8Array(N), boost = new Float64Array(N), lastT = new Float64Array(N).fill(-Infinity);   // Float64: coreBoost values must compare exactly
  const famCls = new Uint8Array(fams.length);
  // (final polish) every coin, planet tops included, shows its OWN last trade (bubbles.js does the same at build)
  const coinClass = (i) => heatClass(S.age[i]);
  const coinBoost = (i) => coreBoost(S.age[i]);
  for (let i = 0; i < N; i++) { cls[i] = coinClass(i); boost[i] = coinBoost(i); }
  for (const f of fams) famCls[f.id] = heatClass(f.age);
  if (S.heat && Array.isArray(S.heat.mint)) for (let r = 0; r < S.heat.mint.length; r++) { const i = S.mintIdx.get(S.heat.mint[r]); if (i !== undefined) lastT[i] = S.heat.last[r]; }
  // (map3 port) built without heat (S.heatStatus 'offline': an empty payload stamped now), the first real payload must apply
  let heatAt = S.heatStatus === "ok" && S.heat ? S.heat.at || 0 : 0, heatStatus = S.heatStatus || "ok";
  let animUntil = 0;   // ms: bubbles/links animate on uTime (crossfades, flashes, pulses, births) until then
  // (map3 port) the app's stream status (setFeed): 'up' | 'down'. It only sets how far apart the pulses of a heat payload's
  // trades are spread (30 s with the stream, 60 s without)
  let feedState = S.opts.feed === "up" ? "up" : "down", statsDirty = false, statsAt = 0;
  const pollMs = () => (feedState === "up" ? 30000 : 60000);
  // pulse policy (amendment B): a trade shows when its family is >= 24 px on screen and in view. Zoomed in (links drawn)
  // it is a pulse child -> parent along the link; at the overview the family chip flashes once (merged per family within
  // 600 ms). At most 24 visual events at once; a queued trade waits up to 1.5 s for a slot; queue overflow drops the oldest.
  // (round 2 final) FAM_MERGE_MS 600 -> 1500: a busy family's chip no longer strobes (sustained tempo shows as the rim's
  // afterglow in bubbles.js); the trades it absorbs still ping their own coin's speck (links.pulses.flashCoin)
  const PULSE_CAP = 24, Q_MAX = 240, Q_TTL = 1500, FAM_MERGE_MS = 1500, DUST_MERGE_MS = 600, FLASH_MS = 360, PING_MS = 420, WHALE_USD = 10000;
  // trade value -> mark size (links.pulses.spawn / flashCoin): < $100, < $5k, >= $5k; unknown value = middle
  const sizeOf = (v) => (!(v > 0) ? 1 : v < 100 ? 0 : v < 5000 ? 1 : 2);
  const fmtK = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);
  const arriveT = new Map();   // parent -> last arrival ring (ms), so converging pulses ring once per 400 ms
  const pq = []; let pqSorted = true;
  const liveEnds = [];   // end times (ms) of the visual events in flight
  const famFlashT = new Float64Array(nF).fill(-1e9), sseT = new Float64Array(N).fill(-Infinity);
  const L = { events: 0, trades: 0, tradesMapped: 0, coins: 0, pairs: 0, stats: 0, fired: 0, flashes: 0, rims: 0, refused: 0, merged: 0, dropped: 0, expired: 0,
    culled: { small: 0, offscreen: 0, dust: 0, drag: 0, flight: 0, short: 0, rm: 0 }, births: { seen: 0, placed: 0, spark: 0, fade: 0, noSlot: 0, skipped: 0, polled: 0 },
    lat: [], evT: [], visT: [], feedUp: 0, reconnects: 0 };
  const ring = (a, v, n) => { a.push(v); if (a.length > n) a.splice(0, a.length - n); };
  // (map3 port) start times (ms) of the visual events that are not pulses (flashes, rims, pings, births): EngineDebug.fx()
  const fxT = [];
  const fxMark = (t = performance.now()) => ring(fxT, t, 256);
  function schedulePulse(i, due, src, tr = due, v = null, buy = null) {
    if (rm || !(i >= 0 && i < N)) return;
    pq.push({ i, due, src, tr, v, buy }); pqSorted = false;
    if (pq.length > Q_MAX) { pq.sort((a, b) => a.due - b.due); pqSorted = true; const n = pq.length - Q_MAX; pq.splice(0, n); L.dropped += n; }
  }
  const chipPx = (f) => f.planet ? TOK.chipR(f.share, maxShare, phone()) : 0;
  const linkVis = (f) => smooth(1.3 * k0(), 2.2 * k0(), cam.k) * smooth(40, 140, f.Rc * cam.k);   // the links shader's own fade
  // (galaxy) a drawn trade also lights the coin's vein path up to its family top (links.lightPath, 1.1 s) and flashes the
  // planet's corona (bubbles.flashCorona, 600 ms); both arrive from their own modules (optional chaining until they land).
  // Flat: never called. The overview's flashFamily path is unchanged in both looks.
  const galTrade = (i, now) => {
    if (!G) return;
    S.links.lightPath?.(i, U.uTime.value); S.bubbles.flashCorona?.(i);
    animUntil = Math.max(animUntil, now + GAL_LIT_MS);
  };
  // decide what one trade looks like right now; true = something was drawn
  function fireOne(i, now, tr, v = null, buy = null) {
    const f = fams[famOf[i]], kk = cam.k, w = W(), h = H(), tS = now / 1000;
    const mark = { size: sizeOf(v), sell: buy === false };
    // (round 2 final) a whale (>= $10k) also gets a ring at the coin and a 2 s label '$TICKER +$12k' (wherever it is drawn)
    if (v >= WHALE_USD && fMode[f.id] === 0 && !flight) {
      const [sx, sy] = toS(X[i], Y[i]);
      if (sx > 0 && sy > 0 && sx < w && sy < h && (f.planet || S.dustExpand >= 0.5)) {
        S.links.pulses.flashCoin?.(i, tS, { scale: 2.2, alpha: 0.7, dur: 0.6 });
        S.labels.toast?.(i, `${buy === false ? "−" : "+"}${fmtK(v)}`, 2000);
        L.whales = (L.whales || 0) + 1; fxMark(now);
      }
    }
    if (fMode[f.id] !== 0) { L.culled.drag++; return false; }               // its family is moving: paths are stale
    if (flight) { L.culled.flight++; return false; }
    if (!f.planet && S.dustExpand < 0.5) {                                  // a dust speck at the overview
      if (typeof S.overview.flashDust === "function" && now - famFlashT[f.id] >= DUST_MERGE_MS) { const [sx, sy] = toS(f.cx, f.cy); if (sx > 0 && sy > 0 && sx < w && sy < h) { S.overview.flashDust(f.id, tS); famFlashT[f.id] = now; L.flashes++; fxMark(now); return true; } }
      L.culled.dust++; return false;
    }
    const [fx, fy] = toS(f.cx, f.cy), rpx = Math.max(f.Rc * kk, chipPx(f));
    if (rpx < 24) { L.culled.small++; return false; }
    if (fx + rpx < 0 || fy + rpx < 0 || fx - rpx > w || fy - rpx > h) { L.culled.offscreen++; return false; }
    const inV = (x, y, m = 40) => x > -m && x < w + m && y > -m && y < h + m;
    if (linkVis(f) >= 0.35) {
      const p = par[i], [sx, sy] = toS(X[i], Y[i]);
      if (p >= 0) {
        const [px, py] = toS(X[p], Y[p]);
        if (Math.hypot(sx - px, sy - py) >= 16 && (inV(sx, sy) || inV(px, py))) {
          if (S.links.pulses.spawn(i, tS, mark)) { L.fired++; liveEnds.push(now + DUR.pulse); animUntil = Math.max(animUntil, now + DUR.pulse + 400); ring(L.lat, now - tr, 200); galTrade(i, now); return true; }
          L.refused++; return false;
        }
      }
      // too short a link (or a top): the coin's own rim flashes
      const rr = typeof S.bubbles.screenR === "function" ? S.bubbles.screenR(i) : R[i] * kk;
      if (rr >= 2 && inV(sx, sy, 0)) { S.bubbles.flashRim(i, tS); L.rims++; fxMark(now); liveEnds.push(now + FLASH_MS); animUntil = Math.max(animUntil, now + FLASH_MS + 100); ring(L.lat, now - tr, 200); galTrade(i, now); return true; }
      L.culled.short++; return false;
    }
    // overview: (round 2 final) the coin that traded pings its OWN speck inside the stipple (its position is known), so the
    // overview twinkles across the colonies instead of strobing four chips; the family chip flashes once (amendment B),
    // bursts merged within FAM_MERGE_MS
    let drew = false;
    if (i !== f.top && typeof S.links.pulses.flashCoin === "function") {
      const [sx, sy] = toS(X[i], Y[i]);
      if (sx > -4 && sy > -4 && sx < w + 4 && sy < h + 4 && liveEnds.length < PULSE_CAP) {
        if (S.links.pulses.flashCoin(i, tS, { scale: [0.8, 1, 1.4][mark.size], alpha: 0.6 })) { L.pings = (L.pings || 0) + 1; fxMark(now); liveEnds.push(now + PING_MS); drew = true; }
      }
    }
    if (now - famFlashT[f.id] < FAM_MERGE_MS) { L.merged++; if (drew) { animUntil = Math.max(animUntil, now + PING_MS + 100); ring(L.lat, now - tr, 200); } return true; }
    famFlashT[f.id] = now;
    // links' flashFamily = its ring ping + bubbles.flashFamily (the chip rim + core pin); without links, bubbles alone
    if (typeof S.links.pulses.flashFamily === "function") S.links.pulses.flashFamily(f.id, tS);
    else if (typeof S.bubbles.flashFamily === "function") S.bubbles.flashFamily(f.id, tS); else S.bubbles.flashRim(f.top, tS);
    L.flashes++; fxMark(now); liveEnds.push(now + FLASH_MS); animUntil = Math.max(animUntil, now + Math.max(FLASH_MS, drew ? PING_MS : 0) + 100); ring(L.lat, now - tr, 200);
    return true;
  }
  function firePulses(now) {
    while (liveEnds.length && liveEnds[0] <= now) liveEnds.shift();
    if (!pq.length) return;
    if (!pqSorted) { pq.sort((a, b) => a.due - b.due); pqSorted = true; }
    let n = 0;
    while (pq.length && pq[0].due <= now && n < 6) {
      const e = pq[0];
      if (now - e.due > Q_TTL) { pq.shift(); L.expired++; continue; }
      if (rm) { pq.shift(); L.culled.rm++; continue; }
      if (liveEnds.length >= PULSE_CAP) break;                   // wait for a slot (until the entry expires)
      pq.shift();
      if (fireOne(e.i, now, e.tr, e.v, e.buy)) { n++; ring(L.visT, now, 4000); liveEnds.sort((a, b) => a - b); }
    }
  }
  // (round 2 final) an arriving pulse also rings its parent once (converging pulses: one ring per 400 ms per parent)
  S.links.onPulseArrive = (p) => {
    if (!(p >= 0)) return;
    const now = performance.now();
    if (now - (arriveT.get(p) || -1e9) >= 400 && typeof S.links.pulses.flashCoin === "function") { arriveT.set(p, now); if (arriveT.size > 256) arriveT.clear(); S.links.pulses.flashCoin(p, now / 1000, { scale: 0.7, alpha: 0.42, dur: 0.36 }); }
    else S.bubbles.flashRim(p, now / 1000);
    animUntil = Math.max(animUntil, now + 450);
  };
  // a birth spark landed: the newborn's scale-in was already scheduled for this moment (bubbles.birth(i, tArrive))
  S.links.onSparkArrive = () => { animUntil = Math.max(animUntil, performance.now() + 600); };
  function heatCounts() {
    const c = { live: 0, cooling: 0, quiet: 0, cold: 0 };
    for (let i = 0; i < N; i++) { const h = heatClass(S.age[i]); if (h === 0) c.live++; else if (h === 1) c.cooling++; else if (h === 2) c.quiet++; else c.cold++; }
    return c;
  }
  function pushStats() {
    const c = heatCounts();
    Object.assign(c, { coins: N, families: fams.length, status: heatStatus, offline: heatStatus === "offline", stale: heatStatus === "stale", at: heatAt, feed: feedState });
    S.labels.updateStats(c, heatAt, heatStatus);
    statsDirty = false; statsAt = performance.now();
    return c;
  }
  // one coin traded just now (a feed event): live class at once, the family too, then a pulse within a second
  function tradeNow(i, tSrv, now, v = null, buy = null) {
    if (tSrv > lastT[i]) lastT[i] = tSrv;
    sseT[i] = Math.max(sseT[i], tSrv);
    S.age[i] = 0; S.n24[i] += 1;
    const f = fams[famOf[i]]; f.age = 0; f.n24 += 1;
    const b = coreBoost(0), tS = now / 1000;
    if (cls[i] !== 0) { S.bubbles.setCoinHeat(i, 0, b, tS); if (par[i] >= 0) S.links.setLinkHeat(i, 0, tS); cls[i] = 0; boost[i] = b; animUntil = Math.max(animUntil, now + DUR.xl + 100); statsDirty = true; }
    else if (boost[i] !== b) { S.bubbles.setCoinHeat(i, 0, b, tS); boost[i] = b; }
    if (!f.planet && famCls[f.id] !== 0) { S.overview.setDustHeat(f.id, 0); famCls[f.id] = 0; }
    else if (f.planet) famCls[f.id] = 0;
    schedulePulse(i, now + rnd(i, tSrv % 997) * 120, "sse", now, v, buy);
  }
  function onFeed(name, d) {
    const now = performance.now(); L.events++; ring(L.evT, now, 2000);
    if (name === "trade") {
      L.trades++;
      const i = d && S.mintIdx.get(d.mint);
      if (i === undefined) {
        const b = d && born.get(d.mint);
        if (b) { b.lastT = Math.max(b.lastT || 0, Number(d.time) || Date.now() / 1000); if (!rm && b.idx >= 0) { S.bubbles.flashRim(b.idx, now / 1000); fxMark(now); animUntil = Math.max(animUntil, now + 400); } }
        // (family-all) a loaded real speck: dust.js's flash on the speck, live class
        else if (d && S.swarm && S.swarm.on && S.swarm.trade(d.mint, Number(d.time) || Date.now() / 1000)) { L.specks = (L.specks || 0) + 1; if (!rm) fxMark(now); }
        return;
      }
      L.tradesMapped++; tradeNow(i, Number(d.time) || Date.now() / 1000, now, Number(d.valueUsd) > 0 ? Number(d.valueUsd) : null, typeof d.isBuy === "boolean" ? d.isBuy : null);
    } else if (name === "coin") { L.coins++; if (d && d.mint && !S.mintIdx.has(d.mint) && !born.has(d.mint)) maybeBirth(d, now); }
    // (integrator, round 2) `pair` is the live API's spawn announcement (indexer.announcePair: {coin: {...mapRef, parentMint},
    // parent: {...mapRef}}), sent for every new child of a tracked coin. `coin` only goes out for the platform's own coins in
    // the production "ours" mode, so without this branch no live birth ever reached the map.
    else if (name === "pair") {
      L.pairs++;
      const c = d && d.coin;
      if (c && c.mint && !S.mintIdx.has(c.mint) && !born.has(c.mint)) maybeBirth({ ...c, parent: d.parent && d.parent.mint ? d.parent : (c.parentMint ? { mint: c.parentMint } : null) }, now);
    }
    else if (name === "stats") L.stats++;
  }
  const setFeed = (st) => { const v = st === "up" ? "up" : "down"; if (v === feedState) return; if (v === "up") L.feedUp++; else if (feedState === "up") L.reconnects++; feedState = v; statsDirty = true; };

  // ---------- births (amendment C): a coin the loaded map has never seen ----------
  const born = new Map();   // mint -> {idx, x, y, r, p, fam, sym, t, mint}
  const bornIdx = new Map();   // (map3 port) engine index (>= N) -> born entry
  let nextBorn = N;
  // (map3 port) engine indices: 0..N-1 built coins, N.. newborns (bubbles' spare instances)
  function bornAt(i) { return bornIdx.get(i) || null; }
  // a newborn moves rigidly with its parent's drag offset (publishMoved)
  function bornXY(b) { return [b.x + (b.ox || 0), b.y + (b.oy || 0)]; }
  // (family-all) dust indices (>= DUST0): the swarm answers for loaded real specks
  function mintOf(i) { if (i >= 0 && i < N) return mint[i]; if (i >= DUST0) return S.swarm ? S.swarm.mintAt(i) : null; const b = bornAt(i); return b ? b.mint : null; }
  function idxOf(m) { if (m == null) return -1; const i = S.mintIdx.get(m); if (i !== undefined) return i; const b = born.get(m); if (b && b.idx >= 0) return b.idx; const d = S.swarm && S.swarm.on ? S.swarm.indexOf(m) : -1; return d >= DUST0 ? d : -1; }
  function famIdOf(i) { if (i >= 0 && i < N) return famOf[i]; const f = famOfIdx(i); return f ? f.id : -1; }
  function posOf(i) { if (i >= 0 && i < N) return [X[i], Y[i], R[i]]; if (i >= DUST0) return S.swarm ? S.swarm.pos(i) : null; const b = bornAt(i); if (!b) return null; const [x, y] = bornXY(b); return [x, y, b.r]; }
  const clearAt = (x, y, r, skip = -1) => {   // free disc? (coins at their current positions + earlier births)
    let ok = true; const e = r + 0.9 + Rmax;
    forEachIn(x - e, y - e, x + e, y + e, (j) => { if (ok && j !== skip && Math.hypot(X[j] - x, Y[j] - y) < R[j] + r + 0.9) ok = false; });
    if (ok) for (const b of born.values()) if (Math.hypot(b.x - x, b.y - y) < b.r + r + 0.9) { ok = false; break; }
    return ok;
  };
  function placeNear(p, r) {
    const f = fams[famOf[p]], ks = kids[p];
    let dist = R[p] + 3 * r + 2;
    if (ks.length) { const ds = ks.map((c) => Math.hypot(X[c] - X[p], Y[c] - Y[p])).sort((a, b) => a - b); dist = Math.max(dist, ds[ds.length >> 1]); }
    const base = par[p] < 0 ? GOLDEN * (ks.length + born.size) : Math.atan2(Y[p] - f.cy, X[p] - f.cx);
    // (round 2 final) a newborn lands on the parent's OUTWARD side (within +-52 deg of the bearing from the family top through
    // the parent, then +-92 deg), stepping out in radius before it ever turns inward, and never closer to the family top
    // than its parent: it used to land between $COCKROACH and the $PUMP top and read as the top's child
    const t0x = X[f.top], t0y = Y[f.top], dP = Math.hypot(X[p] - t0x, Y[p] - t0y);
    const outward = (x, y) => par[p] < 0 || Math.hypot(x - t0x, y - t0y) >= dP + 0.5 * r;
    for (const spread of [0.9, 1.6]) for (const sc of [1, 1.3, 1.65, 2.1, 2.7]) for (let t = 0; t <= 2 * Math.ceil(spread / 0.13); t++) {
      const a = base + (t % 2 ? 1 : -1) * Math.ceil(t / 2) * 0.13; if (Math.abs(a - base) > spread) continue;
      const x = X[p] + Math.cos(a) * dist * sc, y = Y[p] + Math.sin(a) * dist * sc;
      if (outward(x, y) && clearAt(x, y, r, p)) return [x, y];
    }
    for (const sc of [1, 1.25, 0.8, 1.55]) for (let t = 0; t < 24; t++) {
      const a = base + (t % 2 ? 1 : -1) * Math.ceil(t / 2) * 0.26, x = X[p] + Math.cos(a) * dist * sc, y = Y[p] + Math.sin(a) * dist * sc;
      if (clearAt(x, y, r, p)) return [x, y];
    }
    return [X[p] + Math.cos(base) * dist * 1.8, Y[p] + Math.sin(base) * dist * 1.8];
  }
  function placeFree(r) {
    const R0 = (S.Rcl || 300) * 1.04;
    for (let t = 0; t < 80; t++) {
      const a = rnd(born.size + 1, t) * Math.PI * 2, d = R0 * (1 + 0.18 * rnd(t, born.size + 7)), x = Math.cos(a) * d, y = Math.sin(a) * d;
      let ok = clearAt(x, y, r);
      if (ok) forEachDust(x - 12, y - 12, x + 12, y + 12, (g) => { if (Math.hypot(g.cx - x, g.cy - y) < g.Rc + r + 3) ok = false; });
      if (ok) return [x, y];
    }
    return [R0 * 1.25, 0];
  }
  function maybeBirth(v, now) {
    L.births.seen++;
    const ageS = Date.now() / 1000 - Number(v.createdAt || 0);
    if (!(v.createdAt > 0) || ageS > 900) { L.births.skipped++; return null; }   // an old coin the feed re-announces is not a birth
    const pm = v.parent && v.parent.mint, p = pm ? S.mintIdx.get(pm) : undefined;
    const r = typeof S.rad === "function" ? S.rad(Number(v.mcapUsd) || 0) : 0.55;
    const [x, y] = p !== undefined ? placeNear(p, r) : placeFree(r);
    const idx = nextBorn, cap = S.bubbles.capacity || N;
    const tS = now / 1000;
    // (map3 port) the newborn's highlight bit is known before anything draws it (bubbles.addCoin, the born link read it)
    if (idx < hlMask.length) { let m = 1; if (hlTest) { try { m = hlTest(v.mint) ? 1 : 0; } catch { m = 0; } } hlMask[idx] = m; if (m && p !== undefined) famMatch[famOf[p]]++; }
    let tArrive = tS, sparked = false;
    if (p !== undefined && !rm && typeof S.links.pulses.spark === "function") {
      try { const res = S.links.pulses.spark(p, { x, y, r, ci: idx }, tS); if (res) { sparked = true; tArrive = typeof res === "number" && res > tS ? res : tS + 0.65; } } catch (e) { if (errors++ < 3) console.error(e); }
    }
    let added = -1;
    if (idx < cap && typeof S.bubbles.addCoin === "function") {
      try { added = S.bubbles.addCoin(idx, { x, y, r, fam: p !== undefined ? famOf[p] : -1, age: 0, n24: 0, sym: v.symbol || v.name || String(v.mint).slice(0, 4), img: v.image || null, mint: v.mint }); } catch (e) { if (errors++ < 3) console.error(e); }
    }
    // no spark (reduced motion, or links without spark): the newborn still gets its link
    if (p !== undefined && !sparked && typeof S.links.addBornLink === "function") { try { S.links.addBornLink(p, x, y, r, idx); } catch (e) { if (errors++ < 3) console.error(e); } }
    if (added >= 0) {
      nextBorn++; S.bubbles.birth?.(idx, tArrive, p !== undefined ? "scale" : "fade");
      // (round 2 final) the birth is the headline event: a ring on arrival and a 4 s 'new · $TICKER' label
      if (!rm) {
        const fam = p !== undefined ? famOf[p] : -1, ms = Math.max(0, tArrive * 1000 - now);
        life.timeout(() => { try { S.links.pulses.flashCoin?.(idx, tArrive, { at: { x, y, r, fam }, scale: 2, alpha: 0.75, dur: 0.6 }); } catch (e) { if (errors++ < 3) console.error(e); } }, ms);
        fxMark(now + ms);
        try { S.labels.toast?.({ x, y, r, sym: v.symbol || v.name || "" }, "new ·", 4000 + ms); } catch (e) { if (errors++ < 3) console.error(e); }
      }
    }
    else L.births.noSlot++;
    const entry = { idx: added >= 0 ? idx : -1, x, y, r, p: p ?? -1, fam: p !== undefined ? famOf[p] : -1, sym: v.symbol || "", t: now, sparked, mint: v.mint };
    born.set(v.mint, entry); if (added >= 0) bornIdx.set(idx, entry);
    L.births.placed++; if (sparked) L.births.spark++; if (p === undefined) L.births.fade++;
    animUntil = Math.max(animUntil, tArrive * 1000 + 700); S.invalidate();
    S.emit("birth", { mint: v.mint, idx: added >= 0 ? idx : -1, parent: p ?? -1, x, y, r });
    return { idx: added >= 0 ? idx : -1, parent: p ?? -1, x, y, r, sparked };
  }
  // apply one heat payload: ages, classes (crossfades), newly-live rim flashes, dust colours, pulses for real trades
  function applyHeat(p, opts = {}) {
    if (!p || !Array.isArray(p.mint) || !(p.at > 0)) return null;
    const now = performance.now(), tS = now / 1000, at = p.at, prevAt = heatAt, spread = opts.spreadMs ?? pollMs();
    const newLast = new Float64Array(N).fill(-Infinity), newN24 = new Float64Array(N), heatIdx = new Map();
    for (let r = 0; r < p.mint.length; r++) { heatIdx.set(p.mint[r], r); const i = S.mintIdx.get(p.mint[r]); if (i === undefined) continue; newLast[i] = p.last[r]; newN24[i] = (p.n24 && p.n24[r]) || 0; }
    const traded = [];
    for (let i = 0; i < N; i++) {
      const seen = sseT[i];   // the stream already pulsed (and lit) this trade
      if (newLast[i] > lastT[i] && newLast[i] > prevAt - 1 && !(seen >= newLast[i] - 1)) traded.push([i, newN24[i] - S.n24[i]]);
      const nl = Math.max(newLast[i], seen);   // the stream can know a later trade than the 15 s heat snapshot
      lastT[i] = nl;
      S.age[i] = nl > -Infinity ? Math.max(0, at - nl) : Infinity; S.n24[i] = newN24[i];
    }
    for (const f of fams) { let a = Infinity, t = 0; for (const i of f.members) { if (S.age[i] < a) a = S.age[i]; t += S.n24[i]; } f.age = a; f.n24 = t; }
    let changed = 0, flashed = 0, dustChanged = 0, scheduled = 0;
    for (let i = 0; i < N; i++) {
      const c = coinClass(i), b = coinBoost(i);
      if (c !== cls[i]) {
        S.bubbles.setCoinHeat(i, c, b, tS);
        if (par[i] >= 0) S.links.setLinkHeat(i, c, tS);   // planet tops have no parent link
        if (c === 0 && cls[i] > 0 && !rm && prevAt > 0) { S.bubbles.flashRim(i, tS); flashed++; }
        cls[i] = c; boost[i] = b; changed++;
      } else if (b !== boost[i]) { S.bubbles.setCoinHeat(i, c, b, tS); boost[i] = b; }
    }
    for (const f of dust) { const c = heatClass(f.age); if (c !== famCls[f.id]) { S.overview.setDustHeat(f.id, c); famCls[f.id] = c; dustChanged++; } }
    for (const f of planets) famCls[f.id] = heatClass(f.age);
    Object.assign(S, { heat: p, nowS: at, heatIdx });
    heatAt = at; heatStatus = "ok";
    // (map3 port) the first real payload after a build without heat only sets the classes: its trades are not news
    if (!rm && prevAt > 0) for (const [i, dn] of traded) {
      const n = dn >= 5 ? 2 : 1, seed = Math.floor(at) % 997;
      for (let j = 0; j < n; j++) { const due = now + rnd(i, seed + j * 7) * spread; schedulePulse(i, due, "poll", due); scheduled++; }
    }
    animUntil = Math.max(animUntil, now + DUR.xl + 100);
    S.invalidate(); labelsDirty = true;
    const counts = pushStats();
    S.emit("heat", p);
    return { at, traded: traded.length, changed, flashed, dustChanged, scheduled, counts };
  }
  // (map3 port) the app hands over heat payloads (setHeat); a payload is applied only when it is newer than the last one
  function setHeat(p) {
    if (!validHeat(p) || !(p.at > heatAt)) return null;
    return applyHeat(p, { spreadMs: pollMs() });
  }

  // ---------- frame ----------
  let lastT0 = performance.now(), lastMoveT = -1e9, lastRenderT = -1e9, wasMoving = false, movedPrev = false;
  let renders = 0, skips = 0, fadeStarted = false, errors = 0; const whyN = {};
  // (map3 port) onCamera relay: at most every 250 ms while the camera changes, once when it settles, once at the first frame
  let camEmitAt = -1e9;
  const emitCamera = () => { camEmitAt = performance.now(); call("onCamera", { k: cam.k / k0() }); };
  function onMoveStart() { if (tipShownFor >= 0 && !phone()) hideTipNow(); }
  function onSettle() {
    pointer.dirty = pointer.inside;
    focusedFam = familyAtCentre();
    labelsDirty = true;
    if (hoverSrc === "page" && hovI >= 0) hoverMint(mintOf(hovI));   // the pinned card follows its coin
    emitCamera();
  }
  // (map3 port) frame stats: CPU time of frame() for the rendered frames, while the view moves vs settled
  const FS_N = 2048;
  const fsBuf = [new Float32Array(FS_N), new Float32Array(FS_N)], fsN = [0, 0], fsMax = [0, 0], fsSum = [0, 0];
  let fsFrames = 0;
  const recordFrame = (ms, settling) => { const c = settling ? 0 : 1; fsBuf[c][fsN[c] % FS_N] = ms; fsN[c]++; fsSum[c] += ms; if (ms > fsMax[c]) fsMax[c] = ms; fsFrames++; };
  const statOf = (c) => {
    const n = fsN[c]; if (!n) return { n: 0, avg: 0, p95: 0, max: 0 };
    const m = Math.min(n, FS_N), a = Array.from(fsBuf[c].subarray(0, m)).sort((x, y) => x - y);
    return { n, avg: +(fsSum[c] / n).toFixed(3), p95: +a[Math.min(m - 1, Math.floor(0.95 * m))].toFixed(3), max: +fsMax[c].toFixed(3) };
  };
  const frameStats = () => ({ frames: fsFrames, settling: statOf(0), settled: statOf(1), labels: S.labels.labelCount ? S.labels.labelCount() : 0, drawn: S.labels.drawnCount ? S.labels.drawnCount() : 0 });
  const resetFrames = () => { fsN[0] = fsN[1] = 0; fsMax[0] = fsMax[1] = 0; fsSum[0] = fsSum[1] = 0; fsFrames = 0; };
  // (final fix) quality governor: the intervals between back-to-back rendered frames (a pan, a zoom, a flight, a drag,
  // pulses), 90 at a time from 3 s after the start. When their 80th percentile is over GOV_MS (under ~42 fps) the engine
  // steps down once, then waits 2 s: drawing-buffer DPR 2 -> 1.5 -> 1, then the bloom pass off. Never back up within an
  // engine (a rebuild starts again at the top). On the M4 at 60 Hz the percentile is 16.7 ms and nothing changes.
  const GOV_N = 90, GOV_MS = 24;
  const gov = { buf: new Float32Array(GOV_N), n: 0, lastT: 0, lastDrew: false, holdUntil: performance.now() + 3000, steps: [], p80: 0 };
  function govern(now, drew) {
    if (drew && gov.lastDrew && now > gov.holdUntil && !document.hidden) {
      const iv = now - gov.lastT;
      if (iv > 0 && iv < 250) gov.buf[gov.n++] = iv;
      if (gov.n >= GOV_N) {
        const s = Array.from(gov.buf).sort((a, b) => a - b), p80 = s[Math.floor(0.8 * GOV_N)];
        gov.n = 0; gov.p80 = +p80.toFixed(1);
        if (p80 > GOV_MS) stepDown(now, p80);
      }
    }
    gov.lastT = now; gov.lastDrew = drew;
  }
  function stepDown(now, p80) {
    let step = null;
    if (S.DPR > 1.5) { S.dprCap = 1.5; step = "dpr 1.5"; }
    else if (S.DPR > 1) { S.dprCap = 1; step = "dpr 1"; }
    else if (S.gfx.bloom && S.gfx.bloom.enabled !== false) { S.gfx.setBloom?.(false); step = "bloom off"; }
    if (!step) { gov.holdUntil = Infinity; return; }
    gov.steps.push({ step, p80: +p80.toFixed(1), at: Math.round(now) });
    gov.holdUntil = now + 2000;
    if (step.startsWith("dpr")) resize();
  }
  // (map3 port) the first rendered frame resolves the mount (index.js); callbacks.onFirstFrame fires just before
  let firstDone = false, firstResolve = null;
  const firstFrame = new Promise((res) => { firstResolve = res; });
  let tickId = 0;
  function tick(now) {
    tickId = 0;
    if (S.dead || S.contextLost) return;   // (map3 port) the loop stops with the engine and on a lost context
    tickId = life.raf(tick);
    try { frame(now); } catch (err) { if (errors++ < 3) console.error(err); }
  }
  function frame(now) {
    const tF0 = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - lastT0) / 1000)); lastT0 = now; S.frame++;
    let moved = S.dirty;
    // 1. camera: flight | tween | (inertia + eased zoom)
    if (flight) {
      const u = clamp((now - flight.t0) / flight.dur, 0, 1);
      if (u >= 1) endFlight();
      else { const p = flight.path(flight.ease(u)); cam.x = p[0]; cam.y = p[1]; cam.k = flight.m / p[2]; Object.assign(tgt, cam); }
      moved = true;
    } else if (tween) {
      const u = clamp((now - tween.t0) / tween.dur, 0, 1), k = Math.exp(Math.log(tween.ka) + Math.log(tween.kb / tween.ka) * easeOut(u));
      cam.k = k; cam.x = tween.wx - (tween.sx - W() / 2) / k; cam.y = tween.wy + (tween.sy - H() / 2) / k; Object.assign(tgt, cam);
      if (u >= 1) tween = null;
      moved = true;
    } else {
      if (inertia) {
        const fr = dt / 0.0167, dx = inertia.vx * fr / cam.k, dy = inertia.vy * fr / cam.k;
        cam.x -= dx; cam.y += dy; tgt.x -= dx; tgt.y += dy; if (anchor) { anchor.wx -= dx; anchor.wy += dy; }
        const dec = Math.pow(0.92, fr); inertia.vx *= dec; inertia.vy *= dec;
        if (Math.hypot(inertia.vx, inertia.vy) < 0.05) inertia = null;
        moved = true;
      }
      const lk = Math.log(tgt.k / cam.k);
      if (Math.abs(lk) > 1e-4 || Math.hypot(tgt.x - cam.x, tgt.y - cam.y) * cam.k > 0.05) {
        const e = 1 - Math.exp(-dt / 0.09);
        cam.k = Math.exp(Math.log(cam.k) + lk * e);
        if (anchor) { cam.x = anchor.wx - (anchor.sx - W() / 2) / cam.k; cam.y = anchor.wy + (anchor.sy - H() / 2) / cam.k; }
        else { cam.x += (tgt.x - cam.x) * e; cam.y += (tgt.y - cam.y) * e; }
        if (Math.abs(Math.log(tgt.k / cam.k)) < 1e-4 && (anchor || Math.hypot(tgt.x - cam.x, tgt.y - cam.y) * cam.k < 0.05)) { Object.assign(cam, tgt); anchor = null; }
        moved = true;
      }
    }
    if (clampC(tgt) | clampC(cam)) moved = true;
    if (moved) { applyCam(); lastMoveT = now; if (!wasMoving) onMoveStart(); wasMoving = true; }
    else if (wasMoving && now - lastMoveT > 120) { wasMoving = false; onSettle(); }
    // 2. shared uniforms
    const k = cam.k, K0 = k0();
    S.dustExpand = smooth(6 / S.dustTypR, 14 / S.dustTypR, k); S.dustA = 1 - S.dustExpand;
    U.uDustExpand.value = S.dustExpand; U.uTime.value = now / 1000; U.uFine.value = smooth(1.3 * K0, 4 * K0, k); U.uK0.value = K0;
    if (G) {   // (galaxy) opened-ness + the animation clock (seconds; frozen asleep and under reduced motion)
      U.uGalT.value = smooth(1.3 * K0, 2.6 * K0, k);
      galAwake = now - S.lastInputAt < GAL_AWAKE_MS;
      if (!rm && galAwake) U.uAnimT.value += dt;
    }
    if (!fadeStarted && renders > 0) { fadeStarted = true; animate("fadeP", U.uFadeP, 1, DUR.l, easeOut); animate("fadeD", U.uFadeD, 1, DUR.l, easeOut, 150); }
    // (round 2) the coin-drag simulation: after the camera (the held coin follows the pointer through the current view),
    // before the frame hooks (bubbles reads S.X/S.Y in its hook on this same frame)
    let simOn = false;
    try { simOn = simStep(now, dt); } catch (err) { if (errors++ < 3) console.error(err); }
    if (statsDirty && now - statsAt > 2000) pushStats();
    // 3. hover (only once the camera is still; a page-pinned hover holds until the next pointermove), dwell, tooltip delay,
    //    hull
    if (pointer.dirty && pointer.inside && !pinnedHover && !gesture && !flight && !tween && !inertia && !moved && now - lastMoveT > 120) {
      pointer.dirty = false; const h = hitTest(pointer.x, pointer.y, false); setHover(h.i, pointer.x, pointer.y, h.dust, false, "pointer");
    }
    if (dwell && now - dwell.t >= DUR.dwell) {
      const d = dwell; dwell = null;
      if (d.dim) { dimOn = true; animate("dim", U.uDimMix, 1, DUR.s, easeOut); }
      if (hovI === d.i) { S.links.setEmphasis(emphList(d.i)); emphOn = true; hovFamApplied = d.fam; labelsDirty = true; }
    }
    if (leaveDue && now >= leaveDue && hovI < 0) releaseHoverFamily();
    if (tipDue && now >= tipDue) { tipDue = 0; if (hovI >= 0 && (hovI < N || hovI >= DUST0) && !noTip) { S.labels.showTip(hovI, hovX, hovY); tipShownFor = hovI; } }
    const hullWant = k <= 1.3 * K0 ? hovFamApplied : focusedFam;
    if (hullWant !== hullFam) { hullFam = hullWant; S.links.hull.show(hullWant); animUntil = Math.max(animUntil, now + DUR.s + 40); }
    // (final polish) focus: once a family owns the view (zoomed past 1.3 k0), every other family recedes (uFocusMix).
    // A change of family crossfades: the old one releases (160 ms), then the new one takes the view (240 ms).
    const fw = k >= 1.3 * K0 && focusedFam >= 0 ? focusedFam : -1;
    if (fw !== focusWant) {
      focusWant = fw;
      const take = () => { U.uFocusFam.value = focusWant; if (focusWant >= 0) animate("focus", U.uFocusMix, 1, DUR.m, easeOut); S.invalidate(); labelsDirty = true; };
      if (U.uFocusMix.value > 0.01 && U.uFocusFam.value !== fw) animate("focus", U.uFocusMix, 0, DUR.s, easeOut, 0, take);
      else if (fw >= 0) take();
      else if (U.uFocusMix.value > 0.01) animate("focus", U.uFocusMix, 0, DUR.s, easeOut, 0, () => { if (focusWant < 0) U.uFocusFam.value = -1; labelsDirty = true; });
      else U.uFocusFam.value = -1;
      labelsDirty = true;
    }
    // 4. pulses, uniform tweens, frame hooks, render on demand
    firePulses(now);
    const animating = stepAnims(now);
    const hooks = S.runFrameHooks(now, dt);
    const why = moved ? "moved" : simOn ? "sim" : animating ? "tween" : hooks ? "hook" : S.needsRender ? "invalidate" : now < animUntil ? "anim" : !rm && now - lastRenderT >= 500 ? "idle2Hz" : "";
    let drew = false;
    if (why) { drew = S.gfx.render(); S.needsRender = false; lastRenderT = now; if (drew) { renders++; whyN[why] = (whyN[why] || 0) + 1; } }
    else skips++;
    if (galFired) { if (drew) ring(galT, now, 64); galFired = false; }   // (galaxy) renders the galaxy hook asked for (galHz)
    govern(now, drew);
    // 5. labels
    if ((moved && (!phone() || S.frame % 2 === 0)) || (movedPrev && !moved) || labelsDirty || S.frame % 10 === 0) { S.labels.layoutLabels(); labelsDirty = false; }
    movedPrev = moved; S.dirty = false;
    // 6. (map3 port) the page: camera relay, frame stats, the first frame
    if (moved && now - camEmitAt >= 250) emitCamera();
    if (drew) {
      recordFrame(performance.now() - tF0, moved || simOn || !!flight || !!tween || !!inertia);
      if (!firstDone) { firstDone = true; S.firstFrameAt = performance.now(); S.debug.map.firstRenderMs = Math.round(S.firstFrameAt - tF0); call("onFirstFrame"); emitCamera(); if (firstResolve) firstResolve(); }
    }
  }
  const start = () => {
    U.uFadeP.value = 0; U.uFadeD.value = 0; U.uDrift.value = rm ? 0 : 1;
    applyCam(); S.dirty = true;
    if (!tickId) tickId = life.raf(tick);
    pushStats();
    const t0 = performance.now();
    if (!rm) for (let i = 0; i < N; i++) if (S.age[i] < 60) { const due = t0 + 700 + rnd(i, 77) * 7000; schedulePulse(i, due, "load", due); }
  };

  // ---------- highlight (map3 port): a mask over every engine coin, births included; 1 = matches, 0 = dimmed ----------
  const hlMask = new Uint8Array(Math.max(S.bubbles.capacity || 0, N + 512)).fill(1);
  const famMatch = new Int32Array(nF);
  for (const f of fams) famMatch[f.id] = f.members.length;
  let hlTest = null;   // the page's predicate by mint (a newborn is tested at birth)
  S.hlBit = (i) => (i >= 0 && i < hlMask.length ? hlMask[i] : 1);
  S.hlFam = (id) => !S.hlOn || famMatch[id] > 0;
  function applyHl(byIdx) {
    const tS = performance.now() / 1000;
    famMatch.fill(0);
    let n = 0;
    if (!byIdx) {
      hlMask.fill(1);
      for (const f of fams) famMatch[f.id] = f.members.length;
      for (const b of bornIdx.values()) if (b.fam >= 0) famMatch[b.fam]++;
      n = N + bornIdx.size;
    } else {
      for (let i = 0; i < N; i++) { let m = 0; try { m = byIdx(i) ? 1 : 0; } catch { m = 0; } hlMask[i] = m; if (m) { famMatch[famOf[i]]++; n++; } }
      for (const b of bornIdx.values()) { let m = 0; try { m = byIdx(b.idx) ? 1 : 0; } catch { m = 0; } hlMask[b.idx] = m; if (m) { n++; if (b.fam >= 0) famMatch[b.fam]++; } }
    }
    S.hlOn = !!byIdx;
    try { S.bubbles.setHl?.((i) => hlMask[i], tS); } catch (e) { if (errors++ < 3) console.error(e); }
    try { S.links.setHl?.(byIdx ? (i) => hlMask[i] : null, tS, (ci) => hlMask[ci]); } catch (e) { if (errors++ < 3) console.error(e); }
    try { S.overview.setDustHlAll?.((id) => !byIdx || famMatch[id] > 0, tS); } catch (e) { if (errors++ < 3) console.error(e); }
    try { S.swarm?.setHl?.(byIdx ? hlTest : null); } catch (e) { if (errors++ < 3) console.error(e); }   // (family-all) ghosts dim, specks by mint
    try { S.labels.setHl?.(); } catch (e) { if (errors++ < 3) console.error(e); }
    labelsDirty = true; S.invalidate();
    return n;
  }
  const setHighlight = (test) => { hlTest = typeof test === "function" ? test : null; return applyHl(hlTest ? (i) => { const m = mintOf(i); return m != null && hlTest(m); } : null); };
  const testHighlight = (test) => { hlTest = typeof test === "function" ? (m) => { const i = idxOf(m); return i >= 0 && !!test(i); } : null; return applyHl(typeof test === "function" ? test : null); };

  // ---------- the page's updates (map3 port) ----------
  function applyEvent(e) {
    if (!e || typeof e !== "object") return;
    if (e.name === "trade" && e.data) onFeed("trade", e.data);
    else if (e.name === "pair" && e.data) onFeed("pair", e.data);
  }
  // a mapdelta's market caps: tooltip and callout numbers (radius and layout wait for a rebuild)
  function patchCoins(list) {
    if (!Array.isArray(list)) return;
    let any = false;
    for (const p of list) {
      const i = p && S.mintIdx.get(p.mint); if (i === undefined) continue;
      const v = Number(p.mcapUsd), m = v > 0 ? v : 0;
      if (mc[i] === m) continue;
      mc[i] = m; any = true;
      try { S.labels.patched?.(i); } catch { /* ignore */ }
    }
    if (any) { labelsDirty = true; S.invalidate(); }
  }
  const topOf = (m) => {
    const i = idxOf(m); if (i < 0) return null;
    if (i < N) return mint[fams[famOf[i]].top];
    if (i >= DUST0) { const f = famOfIdx(i); return f ? mint[f.top] : null; }
    const b = bornAt(i); return b && b.fam >= 0 ? mint[fams[b.fam].top] : b ? b.mint : null;
  };
  const famOfIdx = (i) => { if (i >= 0 && i < N) return fams[famOf[i]]; if (i >= DUST0) return S.swarm ? S.swarm.famOf(i) : null; const b = bornAt(i); return b && b.fam >= 0 ? fams[b.fam] : null; };

  // ---------- first camera (map3 port): opts.select (a coin, selected), opts.focusFamily (a family), else the overview ----------
  {
    const i0 = idxOf(S.opts.select), f0 = S.opts.focusFamily ? famByKey(S.opts.focusFamily) : null;
    if (i0 >= 0 && i0 < N) {
      // (galaxy physics) the focus lane's framing + pulse when it exists (S.focus is built before motion)
      let t = null; try { if (S.focus && typeof S.focus.target === "function") t = S.focus.target(i0); } catch (e) { if (errors++ < 3) console.error("map3", e); }
      if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y) || !(t.k > 0)) t = coinTarget(i0);
      setCam(t.x, t.y, t.k, true); focusedFam = famOf[i0]; select(i0);
      if (S.focus && typeof S.focus.pulse === "function") life.raf(() => life.raf(() => { try { S.focus.pulse(i0); } catch (e) { if (errors++ < 3) console.error("map3", e); } }));
    }
    else if (f0) { const t = famTarget(f0); setCam(t.x, t.y, t.k, true); focusedFam = f0.id; }
    else fitAll(true);
  }

  // (galaxy) the frame hook: while the look is awake (input within GAL_AWAKE_MS) and motion is not reduced, ask for a render
  // whenever GAL_HOOK_MS have passed since the LAST render, whatever caused it (a 30 Hz ceiling for the veins' flow, the
  // breathing and the dust drift, shared with the other hooks' requests instead of added to them; the why accounting
  // counts these as "hook"). Asleep or reduced: false -> the existing 2 Hz floor / nothing. Flat: not registered.
  if (G) S.onFrame((now) => {
    if (rm || !galAwake || now - lastRenderT < GAL_HOOK_MS) return false;
    galFired = true; return true;
  });

  Object.assign(S.motion, {
    applyCam, setCam, zoomAt, fitAll, focus, hoverAt, start, flyTo, flyToFamily, flyToCoin, flyOverview, select,
    selected: () => selected, focusedFam: () => focusedFam, reduced: rm,
    // (round 2) coin drag + live feed
    grab: (i, sx, sy) => grab(i, sx, sy), dragTo: (sx, sy) => dragMove(sx, sy), release: () => release(), dragging: () => drag.i,
    home: (i) => [X0[i], Y0[i]], live: () => liveStats(),
    // (map3 port) the phone card's buttons; (final fix) the docked card keeps its coin visible
    tapAction, clearHover, keepAbove,
  });
  setRm(rm);

  // ---------- the engine API (map3 port): index.js wraps it into the EngineHandle ----------
  // (final fix) the page's camera calls count as input for the breathing's sleep (S.lastInputAt)
  const woke = (f) => (...a) => { S.lastInputAt = performance.now(); return f(...a); };
  S.api = {
    fit: woke(() => { flyOverview(); }),
    flyToFamily: woke((m) => { const i = idxOf(m); if (i < 0) return false; const f = famOfIdx(i); if (f) flyToFamily(f); else flyToCoin(i); return true; }),
    flyToCoin: woke((m) => { const i = idxOf(m); if (i < 0) return false; flyToCoin(i); return true; }),
    zoomBy: woke((f) => { if (!(f > 0) || !Number.isFinite(f)) return; const ir = S.insetRect(); zoomTween((ir.x0 + ir.x1) / 2, (ir.y0 + ir.y1) / 2, f, DUR.m); }),
    // +dx looks right, +dy looks DOWN (the prototype's panBy has world y up)
    panBy: woke((dx, dy) => { panBy(Number(dx) || 0, -(Number(dy) || 0)); }),
    select: (m, opts) => {
      if (m == null) { select(-1); return true; }
      const i = idxOf(m); if (i < 0) return false;
      S.lastInputAt = performance.now();
      select(i);
      if (opts && opts.fly) { if ((i < N || i >= DUST0) && S.focus && typeof S.focus.fly === "function") S.focus.fly(i); else flyToCoin(i); }   // (galaxy physics) focus lane's fly + pulse
      return true;
    },
    selected: () => (selected >= 0 ? mintOf(selected) : null),
    hover: (m) => { if (m != null) S.lastInputAt = performance.now(); hoverMint(m); },
    setHighlight: (test) => { setHighlight(test); },
    setHeat: (p) => { setHeat(p); },
    applyEvent, patchCoins, setInset, resize, setFeed,
    setReducedMotion: (on) => setRm(!!on),
    knows: (m) => idxOf(m) >= 0, topOf,
    focusedFamily: () => (focusedFam >= 0 && fams[focusedFam] ? mint[fams[focusedFam].top] : null),
    familyOrder: () => (Array.isArray(S.ranked) ? S.ranked.map((f) => mint[f.top]) : []),
    camera: () => ({ x: cam.x, y: cam.y, k: cam.k, k0: k0() }),
    zoom: () => cam.k / k0(),
    worldRadius: (m) => (typeof S.rad === "function" ? S.rad(Number(m) || 0) : 0.55) * k0(),
    chipRadius: (s) => TOK.chipR(Math.max(0, Number(s) || 0), S.maxShare || 1, phone()),
    maxShare: () => S.maxShare || 1,
    frameStats, resetFrames, firstFrame,
  };

  // ---------- EngineDebug (map3 port): index-based probes; index.js exposes them only when opts.debug ----------
  // (round 2) live-feed stats: events/s over the last 10 s, visual events per minute, latency event -> drawn (ms)
  function liveStats() {
    const now = performance.now(), ev10 = L.evT.filter((t) => now - t < 10000).length, vis60 = L.visT.filter((t) => now - t < 60000).length;
    const lat = L.lat.slice().sort((a, b) => a - b), q = (p) => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))]) : null;
    return { feed: feedState, spreadMs: pollMs(), eventsPerSec: +(ev10 / 10).toFixed(2), events: L.events, trades: L.trades, tradesMapped: L.tradesMapped, coins: L.coins, pairs: L.pairs,
      visualPerMin: vis60, fired: L.fired, flashes: L.flashes, pings: L.pings || 0, whales: L.whales || 0, rims: L.rims, merged: L.merged, refused: L.refused, culled: { ...L.culled }, dropped: L.dropped, expired: L.expired,
      queued: pq.length, inFlight: liveEnds.filter((t) => t > now).length, cap: PULSE_CAP, latency: { n: lat.length, p50: q(0.5), p95: q(0.95), max: lat.length ? Math.round(lat[lat.length - 1]) : null },
      births: { ...L.births, born: born.size }, feedUp: L.feedUp, reconnects: L.reconnects, reduced: rm };
  }
  const galHzNow = () => { const now = performance.now(); let n = 0; for (const t of galT) if (now - t <= 1000) n++; return n; };
  const motionStats = () => ({ renders, skips, why: { ...whyN }, flight: !!flight, tween: !!tween, inertia: !!inertia, hoverI: hovI, hoverSrc, dim: +U.uDimMix.value.toFixed(3), hoverT: +U.uHoverT.value.toFixed(3),
    fadeP: U.uFadeP.value, fadeD: U.uFadeD.value, selected, focusedFam, focusKey: focusedFam >= 0 ? focusKey(fams[focusedFam]) : null, hull: hullFam, emph: emphOn,
    pulses: { fired: L.fired, flashes: L.flashes, rims: L.rims, culled: Object.values(L.culled).reduce((a, b) => a + b, 0), refused: L.refused, queued: pq.length, live: liveEnds.filter((t) => t > performance.now()).length },
    heat: { at: heatAt, status: heatStatus }, feed: feedState, drag: { held: drag.i, pcFams: pcFams.length, bodies: bodies.length, alpha: +drag.alpha.toFixed(3), simMs: +drag.simMs.toFixed(2) },
    reduced: rm, k: cam.k, k0: k0(), breathing: S.bubbles.breathState ? S.bubbles.breathState() : null,
    // (galaxy) galHz = renders the galaxy hook asked for over the last second (0 in flat, asleep and under reduced motion)
    look: S.look, galHz: galHzNow(), galaxy: G ? { awake: galAwake, animT: +(U.uAnimT ? U.uAnimT.value : 0).toFixed(2), galT: +(U.uGalT ? U.uGalT.value : 0).toFixed(3), flow: U.uFlow ? U.uFlow.value : 1 } : null,
    quality: { dpr: S.DPR, dprCap: S.dprCap, bloom: !(S.gfx.bloom && S.gfx.bloom.enabled === false), p80: gov.p80, steps: gov.steps.slice() } });
  const keyIdx = (key) => (typeof key === "number" ? key : (famByKey(key) || {}).top);
  // scripted coin drag (verification): grab coin i (or a ticker's top) where it is drawn, move it by (dx, dy) CSS px over
  // ms (ease in-out), hold, release, and wait until the region is home. Reports frame times while held and while settling,
  // how far neighbours (other families) and the coin's own family moved, and whether every coin landed exactly home.
  const dragCoin = (key, dx = 160, dy = 0, ms = 900, opts = {}) => new Promise((res) => {
    const i = keyIdx(key);
    if (!(i >= 0 && i < N)) { res(null); return; }
    const hold = opts.hold ?? 250, [sx0, sy0] = toS(X[i], Y[i]), famId = famOf[i], k = cam.k;
    const tsD = [], tsS = []; let phase = "drag", tRel = 0, last = performance.now(), maxNb = 0, maxFam = 0, maxBodies = 0; const nbFams = new Set(), sim = [];
    drag.simMax = 0; let tVis = -1, maxSib = 0; const sibMoved = new Set();
    const inSub = new Uint8Array(N); { const st = [i]; while (st.length) { const c = st.pop(); inSub[c] = 1; for (const q of kids[c]) st.push(q); } for (let c = par[i]; c >= 0; c = par[c]) inSub[c] = 2; }
    // (round 2 final) intrusion: coins of OTHER families inside the held family's visible disc
    const ft = fams[famId].top, md = fams[famId].members.map((j) => Math.hypot(X0[j] - X0[ft], Y0[j] - Y0[ft])).sort((a, b) => a - b);
    const rv = (md[Math.floor(0.9 * (md.length - 1))] || 0) + 2 / k;
    const inDisc = (cx, cy) => { let n = 0; for (let j = 0; j < N; j++) if (famOf[j] !== famId && Math.abs(X[j] - cx) < rv && Math.abs(Y[j] - cy) < rv && Math.hypot(X[j] - cx, Y[j] - cy) < rv) n++; return n; };
    const base = inDisc(X0[ft], Y0[ft]); let intrMax = 0, intrFrames = 0, intrN = 0, chipOff = 0;
    const t0 = performance.now();
    if (!grab(i, sx0, sy0)) { res(null); return; }
    const wasRigid = !!drag.rigid;
    const step = (t) => {
      if (S.dead) { res(null); return; }
      const d = t - last; last = t; (phase === "drag" ? tsD : tsS).push(d);
      if ((++intrN % 5) === 0) { const n = inDisc(X[ft], Y[ft]) - base; intrFrames++; if (n > intrMax) intrMax = n;
        if (drag.rigid) { let mx = 0; for (const j of fams[famId].members) mx = Math.max(mx, Math.hypot((X[j] - X0[j]) - (X[ft] - X0[ft]), (Y[j] - Y0[j]) - (Y[ft] - Y0[ft]))); chipOff = Math.max(chipOff, mx * cam.k); } }
      const u = Math.min(1, (t - t0) / ms), e = easeInOut(u);
      if (phase === "drag") { dragMove(sx0 + dx * e, sy0 + dy * e); if (t - t0 >= ms + hold) { phase = "settle"; tRel = t; release(); } }
      for (let q = 0; q < S.drag.nMoved; q++) {
        const j = movedBuf[q], dd = Math.hypot(X[j] - X0[j], Y[j] - Y0[j]) * cam.k;
        if (famOf[j] !== famId) { if (dd > maxNb) maxNb = dd; if (dd > 1) nbFams.add(famOf[j]); }
        else { if (dd > maxFam) maxFam = dd; if (!inSub[j]) { if (dd > maxSib) maxSib = dd; if (dd > 1) sibMoved.add(j); } }
      }
      maxBodies = Math.max(maxBodies, bodies.length); sim.push(drag.simMs);
      if (phase === "settle" && tVis < 0) {
        let mu = 0; for (let q = 0; q < pcN; q++) { const j = pcList[q]; mu = Math.max(mu, Math.abs(X[j] - X0[j]), Math.abs(Y[j] - Y0[j])); }
        for (const id of bodies) mu = Math.max(mu, Math.abs(fUx[id]), Math.abs(fUy[id]));
        if (mu * cam.k < 0.5) tVis = t - tRel;
      }
      const homeNow = !pcFams.length && !bodies.length;
      if ((phase === "settle" && homeNow) || t - t0 > ms + hold + 6000) {
        let off = 0; for (let j = 0; j < N; j++) if (X[j] !== X0[j] || Y[j] !== Y0[j]) off++;
        const st = (a) => { const s = a.slice(1).sort((x, y) => x - y); return s.length ? { frames: s.length, p50: +s[s.length >> 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2) } : null; };
        sim.sort((a, b) => a - b);
        res({ coin: i, sym: sym[i], fam: sym[fams[famId].top], famSize: fams[famId].members.length, k: +k.toFixed(3), dx, dy, held: st(tsD), settle: st(tsS), settleMs: phase === "settle" ? Math.round(t - tRel) : null, visualSettleMs: Math.round(tVis),
          rigid: wasRigid, intrusion: { visibleDiscPx: +(rv * k).toFixed(1), base, maxExtraCoins: intrMax, frames: intrFrames }, chipToFamilyPx: +chipOff.toFixed(2),
          maxNeighbourPx: +maxNb.toFixed(1), neighbourFamsMoved: nbFams.size, maxFamilyPx: +maxFam.toFixed(1), maxUnlinkedPx: +maxSib.toFixed(1), unlinkedMoved: sibMoved.size, maxBodies, simMsP95: +(sim[Math.floor(sim.length * 0.95)] || 0).toFixed(2), simMax: +drag.simMax.toFixed(2), coinsOffHome: off });
        return;
      }
      life.raf(step);
    };
    life.raf(step);
  });
  // (galaxy physics) scripted rope drag (verification): grab coin i where it is drawn, move it by (dx, dy) CSS px over ms
  // (ease in-out), hold, release, and wait for the commit. Reports the rendered lag (coin vs pointer, every frame), how far
  // ANY coin outside g + D moved (must be 0), the settle time (release -> commit), where g is vs the drop point, the
  // displacement kept at 1.5 s / 3 s, the gen-1 trail while dragging and the overshoot after release.
  const dragCoinRope = (key, dx = 160, dy = 0, ms = 900, opts = {}) => new Promise((res) => {
    const i = keyIdx(key);
    if (!(i >= 0 && i < N)) { res(null); return; }
    const hold = opts.hold ?? 250, [sx0, sy0] = toS(X[i], Y[i]), k = cam.k, famId = famOf[i];
    const SX = Float32Array.from(X), SY = Float32Array.from(Y), inSet = new Uint8Array(N), D = [i];
    for (let h = 0; h < D.length; h++) { inSet[D[h]] = 1; for (const c of kids[D[h]]) if (c < N) D.push(c); }
    const g1 = kids[i].filter((c) => c < N);
    const tsD = [], tsS = []; let phase = "drag", tRel = 0, last = performance.now(), nbMax = 0, nbCoin = -1;
    let trailMax = 0, lagged = 0, r1500 = null, drop1500 = null, desc3 = null; const e0 = new Map(), over = new Map(), overL = new Map();
    const dragW = Math.hypot(dx, dy) / k;
    ropeLog.maxLagPx = 0; drag.simMax = 0;
    const t0 = performance.now();
    if (!grab(i, sx0, sy0)) { res(null); return; }
    const step = (t) => {
      if (S.dead) { res(null); return; }
      const d = t - last; last = t; (phase === "drag" ? tsD : tsS).push(d);
      for (let j = 0; j < N; j++) if (!inSet[j]) { const m = Math.max(Math.abs(X[j] - SX[j]), Math.abs(Y[j] - SY[j])) * k; if (m > nbMax) { nbMax = m; nbCoin = j; } }
      const u = Math.min(1, (t - t0) / ms), ee = easeInOut(u);
      for (const c of g1) {
        const ex = X[c] - (X[i] + rRX[c]), ey = Y[c] - (Y[i] + rRY[c]), L0 = Math.max(Math.hypot(rRX[c], rRY[c]), R[i] + R[c], 1e-6), el = Math.hypot(ex, ey);
        if (phase === "drag" && t - t0 < ms) { if (el / L0 > trailMax) trailMax = el / L0; if (el * k > 0.5) lagged++; }
        else if (inRope[c] === 1) {   // overshoot: from the moment the pointer stops (step response), past the anchor
          if (!e0.has(c)) e0.set(c, [ex, ey]);
          const [ax, ay] = e0.get(c), a = Math.hypot(ax, ay);
          if (a * k > 2) { const pr = -(ex * ax + ey * ay) / a / a; if (pr > (over.get(c) || 0)) over.set(c, pr); }
          const pl = -(ex * ax + ey * ay) / Math.max(a, 1e-9) / L0; if (pl > (overL.get(c) || 0)) overL.set(c, pl);
        }
      }
      if (phase === "drag") { dragMove(sx0 + dx * ee, sy0 + dy * ee); if (t - t0 >= ms + hold) { phase = "settle"; tRel = t; release(); } }
      if (phase === "settle") {
        if (r1500 === null && t - tRel >= 1500) {
          r1500 = Math.hypot(X[i] - SX[i], Y[i] - SY[i]) / Math.max(dragW, 1e-9);
          const [gx, gy] = toS(X[i], Y[i]); drop1500 = Math.hypot(gx - (sx0 + dx), gy - (sy0 + dy));
        }
        if (desc3 === null && t - tRel >= 3000) {
          let sum = 0, n = 0; for (const c of D) if (c !== i) { sum += Math.hypot(X[c] - SX[c], Y[c] - SY[c]); n++; }
          desc3 = n ? sum / n / Math.max(dragW, 1e-9) : 1;
        }
      }
      const done = phase === "settle" && !ropeOrd.length && r1500 !== null && desc3 !== null;
      if (done || t - t0 > ms + hold + 8000) {
        const st = (a) => { const s = a.slice(1).sort((x, y) => x - y); return s.length ? { frames: s.length, p50: +s[s.length >> 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2) } : null; };
        const [gx, gy] = toS(X[i], Y[i]), ov = [...over.values()].sort((a, b) => a - b);
        res({ coin: i, sym: sym[i], fam: sym[fams[famId].top], famSize: fams[famId].members.length, nD: D.length - 1, gen1: g1.length, k: +k.toFixed(3), dx, dy, ms,
          held: st(tsD), settle: st(tsS), maxLagPx: +ropeLog.maxLagPx.toFixed(3), neighbourMaxPx: +nbMax.toFixed(4), neighbourCoin: nbCoin,
          settleMs: ropeLog.lastSettleMs, within05Ms: ropeLog.lastWithin05Ms ?? -1, dropDeltaPx: +Math.hypot(gx - (sx0 + dx), gy - (sy0 + dy)).toFixed(3), dropDelta1500Px: drop1500 === null ? null : +drop1500.toFixed(3),
          homeDeltaRatio1500: r1500 === null ? null : +r1500.toFixed(4), descRatio3s: desc3 === null ? null : +desc3.toFixed(4),
          trailMaxStretch: +trailMax.toFixed(3), gen1LagFrames: lagged, overshootPctMedian: ov.length ? +(100 * ov[ov.length >> 1]).toFixed(1) : null, overshootPctMax: ov.length ? +(100 * ov[ov.length - 1]).toFixed(1) : null, overshootL0PctMedian: overL.size ? +(100 * [...overL.values()].sort((a, b) => a - b)[overL.size >> 1]).toFixed(1) : null, overshootL0PctMax: overL.size ? +(100 * Math.max(...overL.values())).toFixed(1) : null,
          simMax: +drag.simMax.toFixed(2), commits: ropeLog.commits, committed: !ropeOrd.length });
        return;
      }
      life.raf(step);
    };
    life.raf(step);
  });
  // frame-time probe. Every mode forces a render each frame (pan/zoom move the camera, idle/hover invalidate),
  // so render-on-demand never flatters the numbers. hover sweeps a synthetic mouse across the largest colony ($PUMP).
  const measure = (ms, mode) => new Promise((res) => {
    const ts = [], t0 = performance.now(), c0 = { ...cam }, r0 = renders, pump = S.famBy("PUMP") || planets[0];
    const f = (t) => {
      if (S.dead) { res({ mode, frames: 0, renders: 0, fps: 0, p50: 0, p95: 0, max: 0 }); return; }
      ts.push(t); const u = (t - t0) / 1000;
      if (mode === "pan") setCam(c0.x + Math.sin(u * 2.2) * W() * 0.3 / c0.k, c0.y + Math.cos(u * 1.7) * H() * 0.2 / c0.k, c0.k);
      else if (mode === "zoom") setCam(c0.x, c0.y, c0.k * Math.exp(Math.sin(u * 1.4) * 1.6));
      else if (mode === "hover" && pump) {
        const [px, py] = toS(pump.cx, pump.cy), rr = Math.max(24, Math.min(pump.Rc * cam.k, Math.min(W(), H()) * 0.45)) * 0.9;
        el.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + px + Math.cos(u * 2.3) * rr * Math.sin(u * 0.9 + 0.5), clientY: rect.top + py + Math.sin(u * 3.1) * rr * 0.8, pointerType: "mouse", pointerId: 1, isPrimary: true, bubbles: true }));
        S.invalidate();
      } else S.invalidate();
      if (t - t0 < ms) life.raf(f);
      else {
        if (mode === "hover") { pointer.inside = false; setHover(-1); }
        if (mode === "pan" || mode === "zoom") setCam(c0.x, c0.y, c0.k);
        const d = ts.slice(1).map((v, i) => v - ts[i]).sort((a, b) => a - b);
        res({ mode, frames: d.length, renders: renders - r0, fps: +(d.length / ((ts[ts.length - 1] - ts[0]) / 1000)).toFixed(1), p50: +(d[d.length >> 1] || 0).toFixed(2), p95: +(d[Math.floor(d.length * 0.95)] || 0).toFixed(2), max: +(d[d.length - 1] || 0).toFixed(2) });
      }
    };
    life.raf(f);
  });
  const screenOf = (i) => {
    const p = posOf(i); if (!p) return null;
    const [x, y] = toS(p[0], p[1]);
    let r = p[2] * cam.k; try { if (typeof S.bubbles.screenR === "function" && (S.bubbles.invIdx ? S.bubbles.invIdx[i] >= 0 : true)) r = S.bubbles.screenR(i); } catch { /* ignore */ }
    return { x, y, r };
  };
  const primitives = (o) => { const out = {}; for (const [kk, v] of Object.entries(o)) if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[kk] = v; return out; };
  const fn = (name) => (...a) => (typeof S.debugFns[name] === "function" ? S.debugFns[name](...a) : null);
  S.engineDebug = {
    coins: () => N + bornIdx.size, built: () => N, indexOf: (m) => idxOf(m), mintAt: (i) => mintOf(i),
    world: (i) => { const p = posOf(i); return p ? { x: p[0], y: p[1], r: p[2] } : null; },
    screen: (i) => screenOf(i),
    familyScreen: (i) => { const f = famOfIdx(i); if (!f) return null; const [x, y] = toS(f.cx, f.cy); return { x, y, r: f.Rc * cam.k }; },
    zoomTo: (i, kRel) => { const p = posOf(i); if (!p) return; setCam(p[0], p[1], (Number(kRel) || 1) * k0(), true); labelsDirty = true; },
    flying: () => !!flight,
    settled: () => !flight && !tween && !inertia && !anchor && drag.i < 0 && !pcFams.length && !bodies.length && !ropeOrd.length && Math.abs(Math.log(tgt.k / cam.k)) < 1e-4 && Math.hypot(tgt.x - cam.x, tgt.y - cam.y) * cam.k < 0.05 && performance.now() - lastMoveT >= 120,
    selected: () => selected, hovered: () => hovI,
    hoverTop: () => { const f = U.uHoverFam.value >= 0 ? fams[U.uHoverFam.value] : null; return hovI >= 0 && f ? f.top : -1; },
    children: (i) => { const out = i >= 0 && i < N ? kids[i].slice() : []; for (const b of bornIdx.values()) if (b.p === i) out.push(b.idx); return out; },
    members: (i) => { const f = famOfIdx(i); if (!f) return i >= N && bornAt(i) ? [i] : []; const out = f.members.slice(); for (const b of bornIdx.values()) if (b.fam === f.id) out.push(b.idx); return out; },
    topOf: (i) => { const f = famOfIdx(i); return f ? f.top : bornAt(i) ? i : -1; },
    families: (n = 10) => S.ranked.slice(0, Math.max(0, n | 0)).map((f) => ({ top: f.top, count: f.members.length, size: f.size ?? f.members.length, value: f.value, share: f.share, rank: f.rank, planet: !!f.planet, cx: f.cx, cy: f.cy, Rc: f.Rc, title: "$" + String(sym[f.top] || "").replace(/^\$+/, "") })),
    pick: (cx, cy) => { const h = hitTest(cx, cy, false), f = h.i >= 0 ? famOfIdx(h.i) : null; return { i: h.i, top: f ? f.top : -1, via: h.via }; },
    lastTrade: (i) => { if (i >= 0 && i < N) return lastT[i] > -Infinity ? lastT[i] * 1000 : 0; if (i >= DUST0) { const t = S.swarm ? S.swarm.tip(i) : null; return t && t.lastTrade ? t.lastTrade * 1000 : 0; } const b = bornAt(i); return b && b.lastT ? b.lastT * 1000 : 0; },
    t1h: (i) => { const r = i >= 0 && i < N ? S.heatIdx?.get(mint[i]) : undefined; return r !== undefined && S.heat && S.heat.t1h ? Number(S.heat.t1h[r]) || 0 : 0; },
    fx: () => { const now = performance.now(); let n = 0; for (const t of fxT) if (t <= now && now - t < 1500) n++; try { n += S.links.pulses.active ? S.links.pulses.active() : 0; } catch { /* ignore */ } return n; },
    titles: () => (S.labels.titles ? S.labels.titles() : []), taggedTitles: () => (S.labels.taggedTitles ? S.labels.taggedTitles() : []),
    labelCount: () => (S.labels.labelCount ? S.labels.labelCount() : 0), drawnCount: () => (S.labels.drawnCount ? S.labels.drawnCount() : 0),
    logoPx: (i) => (S.bubbles.logoPx ? S.bubbles.logoPx(i) : 0),
    hlBit: (i) => S.hlBit(i), testHighlight: (test) => testHighlight(test),
    allXY: () => ({ n: N, x: Float32Array.from(X), y: Float32Array.from(Y) }),
    drag: () => (drag.i >= 0 ? { i: drag.i, top: fams[famOf[drag.i]].top, rigid: !!drag.rigid } : null),
    renders: () => renders, resetFrames,
    sim: () => ({ ticks: drag.ticks, tickMs: +drag.simMs.toFixed(3), alpha: +drag.alpha.toFixed(4), active: drag.i >= 0 || pcFams.length > 0 || bodies.length > 0 || ropeOrd.length > 0 }),
    // (galaxy physics) EngineDebug.call(name, ...a) -> S.debugFns[name](...a)
    call: (name, ...a) => (typeof S.debugFns[name] === "function" ? S.debugFns[name](...a) : undefined),
    build: () => primitives({ ...S.debug.map, gpu: S.gfx.gpu, dpr: S.DPR, w: W(), h: H(), contextLost: !!S.contextLost, reduced: rm, feed: feedState, look: S.look }),
    gl: () => { const r = S.gfx.renderer, mem = r && r.info ? r.info.memory : null; return { geometries: mem ? mem.geometries : 0, textures: mem ? mem.textures : 0, programs: r && r.info && r.info.programs ? r.info.programs.length : 0, contextLost: !!S.contextLost }; },
    tip: () => (S.labels.tipInfo ? S.labels.tipInfo() : { on: false, i: -1, dock: false, text: "" }),
    measure, dragCoin: G ? (...a) => dragCoinRope(...a) : dragCoin,
    feed: (e) => { const b0 = L.births.placed; applyEvent(e); const b = L.births.placed > b0 ? [...born.values()].pop() : null; return { live: liveStats(), birth: b ? { ...b } : null }; },
    live: () => liveStats(), motion: () => motionStats(), labels: fn("labels"),
    overlapCheck: fn("overlapCheck"), dustCheck: fn("dustCheck"), limeShare: fn("limeShare"), hdrCheck: fn("hdrCheck"), linkMaxPx: fn("linkMaxPx"),
    veinShare: fn("veinShare"),
    swarm: () => (S.swarm ? S.swarm.stats() : null),   // (family-all) EngineSwarmStats   // (galaxy) scene.js: share of lit vein pixels inside the focused family's disc; null until it lands / in flat
    hover: (key) => {
      if (key == null) { hoverMint(null); return null; }
      const i = keyIdx(key); if (!(i >= 0)) return null;
      const m = mintOf(i); if (m == null) return null;
      hoverMint(m);
      const p = posOf(i), [sx, sy] = toS(p[0], p[1]);
      return { i, sym: i < N ? sym[i] : (bornAt(i) || {}).sym, sx, sy };
    },
    focusFamily: (key) => { const f = famByKey(key); return f ? flyToFamily(f) : Promise.resolve(null); },
  };
  S.debugFns.simTunables = SIM;
  // (galaxy physics) debug: committed home, rope state, moved-coin count; RP = the rope constants (tunable live)
  S.debugFns.home = (i) => (i >= 0 && i < N ? { x: X0[i], y: Y0[i], xd: XD[i], yd: YD[i] } : null);
  S.debugFns.rope = () => {
    let n = 0; for (const c of ropeOrd) if (inRope[c] === 1) n++;
    return { active: drag.i >= 0 || ropeOrd.length > 0, held: drag.i, n, set: ropeOrd.length, maxDevPx: +ropeLog.maxDevPx.toFixed(3), settling: drag.i < 0 && ropeOrd.length > 0,
      maxStretch: +ropeLog.maxStretch.toFixed(3), lagPx: +ropeLog.lagPx.toFixed(3), maxLagPx: +ropeLog.maxLagPx.toFixed(3), grabs: ropeLog.grabs, commits: ropeLog.commits, lastSettleMs: ropeLog.lastSettleMs, within05Ms: ropeLog.lastWithin05Ms ?? -1, galaxy: G };
  };
  S.debugFns.moved = () => movedMints.size;
  S.debugFns.ropeTunables = RP;
}

// (galaxy physics) persistence across rebuilds. index.js calls this right after placeDust, before the scene: it keeps the
// designed positions in S.XD/S.YD and applies the owner's moves (ThreeMap's movedRef, the onMoved format: a top's entry is
// its displacement from the design, any other coin's is relative to its parent's). A coin without an entry inherits its
// parent's displacement, so births and untouched children stay with a moved parent. Unknown mints are ignored.
export function applyMoved(S, moved) {
  const { N, X, Y, fams, kids, mint, par } = S;
  if (!X || !Y || !(N > 0)) return 0;
  S.XD = Float32Array.from(X); S.YD = Float32Array.from(Y);
  if (!moved || typeof moved.get !== "function" || !(moved.size > 0)) return 0;
  const DX = new Float64Array(N), DY = new Float64Array(N);
  let n = 0;
  for (const f of fams) {
    const q = [f.top];
    for (let h = 0; h < q.length; h++) {
      const c = q[h], p = par[c], e = moved.get(mint[c]);
      let dx = p >= 0 ? DX[p] : 0, dy = p >= 0 ? DY[p] : 0;
      if (e && Number.isFinite(e.dx) && Number.isFinite(e.dy)) { dx += e.dx; dy += e.dy; n++; }
      DX[c] = dx; DY[c] = dy;
      for (const k of kids[c]) if (k < N) q.push(k);
    }
    const t = f.top; if (DX[t] || DY[t]) { f.cx += DX[t]; f.cy += DY[t]; }
  }
  if (n) for (let i = 0; i < N; i++) { X[i] = S.XD[i] + DX[i]; Y[i] = S.YD[i] + DY[i]; }
  return n;
}
