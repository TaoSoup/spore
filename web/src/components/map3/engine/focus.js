// focus.js (map3): the "find this coin" moment. A pasted mint, a search pick, a rail pick and ?focus all end here
// (engine.select(mint, {fly: true}) -> S.focus.fly(i)).
//
//   target(i) -> {x, y, k}: the coin centred in the inset rect, zoomed so its drawn radius is >= 80 CSS px (50 on a phone)
//                and at least as close as its family's frame; k <= 1600 (motion clamps it again to its own K_MAX)
//   fly(i)    -> Promise: S.motion.flyTo(target) and, on arrival, pulse(i) (at once when the camera is already there or
//                motion is reduced: the flight then ends in the same task). A newer fly() or a cancelled flight never pulses.
//   pulse(i)  -> the highlight: S.U.uFocusCoin = i, uFocusT and uFocusDim ramp 0 -> 1 in 150 ms, hold to 1.9 s, ease to
//                0 by 2.5 s (a frame hook keeps the loop rendering while it runs). The spheres (ring + halo), the veins and
//                the nebula read the uniforms; the labels pin the coin's name and every other label fades to 0.6.
//   state()   -> {i, t, dim, rPx, k, label}
//
// Shared uniforms (state.js declares them too; ??= keeps one object per name): uFocusCoin {-1}, uFocusT {0}, uFocusDim {0}.
// (family-all) dust indices (>= DUST0, a loaded real speck of a capped asset family): target() centres the speck at
// k = max(its family's frame, 16 / slot spacing) (<= K_CAP); fly() and pulse() take it like a coin (the swarm shader draws
// its lime ring from uFocusCoin); state().rPx is the speck's drawn radius.
import { DUST0 } from "./swarm.js";
const T_IN = 150, T_HOLD = 1900, T_END = 2500;
const K_CAP = 1600;
const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function buildFocus(S) {
  const U = S.U;
  U.uFocusCoin ??= { value: -1 };
  U.uFocusT ??= { value: 0 };
  U.uFocusDim ??= { value: 0 };
  const labelsEl = S.layers && S.layers.labels;
  let coin = -1, t0 = -1, tok = 0, lastDim = -1;

  const Rd = (i) => { const a = S.Rdraw; const v = a && i < a.length ? a[i] : 0; return v > 0 ? v : Math.max(S.R[i] || 0, 1e-4); };
  const viewRect = () => { const ir = S.insetRect(), w = S.W(), h = S.H(); return { x0: Math.max(ir.x0, 6), y0: Math.max(ir.y0, 6), x1: Math.min(ir.x1, w - 6), y1: Math.min(ir.y1, h - 6) }; };

  function dustTarget(i) {
    const p = S.swarm && S.swarm.pos(i), f = S.swarm && S.swarm.famOf(i);
    if (!p || !f) return null;
    const v = viewRect(), m = Math.max(40, Math.min(v.x1 - v.x0, v.y1 - v.y0));
    const kFam = f.Rc > 0 ? (m * 0.94) / (2 * f.Rc * 1.06) : 0, sp = S.swarm.spacing(i);
    const k = Math.min(K_CAP, Math.max(kFam, sp > 0 ? 16 / sp : kFam));
    const mx = (v.x0 + v.x1) / 2, my = (v.y0 + v.y1) / 2, w = S.W(), h = S.H();
    return { x: p[0] - (mx - w / 2) / k, y: p[1] + (my - h / 2) / k, k };
  }
  function target(i) {
    if (i >= DUST0) return dustTarget(i);
    if (!(i >= 0 && i < S.N)) return null;
    const v = viewRect(), m = Math.max(40, Math.min(v.x1 - v.x0, v.y1 - v.y0));
    const f = S.fams[S.famOf[i]];
    const kFam = f && f.Rc > 0 ? (m * 0.94) / (2 * f.Rc * 1.06) : 0;
    const P = (S.phone() ? 50 : 80) * 1.01; // +1 %: float32 Rdraw and the px mirror land a hair under the target otherwise
    // the coin's radius may not exceed 40 % of the short side (a family top bigger than the view still reads as a coin)
    const kMaxCoin = (0.4 * m) / Rd(i);
    let k = Math.max(kFam, P / Rd(i));
    if (k > kMaxCoin && kMaxCoin * Rd(i) >= P) k = kMaxCoin;
    k = Math.min(K_CAP, k);
    const mx = (v.x0 + v.x1) / 2, my = (v.y0 + v.y1) / 2, w = S.W(), h = S.H();
    return { x: S.X[i] - (mx - w / 2) / k, y: S.Y[i] + (my - h / 2) / k, k };
  }

  function setLabelDim(d) {
    const q = Math.round(d * 40) / 40;
    if (q === lastDim || !labelsEl) return;
    lastDim = q;
    if (q > 0) labelsEl.style.setProperty("--m3-fdim", String(1 - 0.4 * q)); else labelsEl.style.removeProperty("--m3-fdim");
  }
  const relayout = () => { try { if (S.labels && typeof S.labels.layoutLabels === "function") S.labels.layoutLabels(); } catch { /* labels not ready */ } };

  function pulse(i) {
    if (S.dead || !(i >= 0)) return;
    coin = i;
    U.uFocusCoin.value = i;
    try { S.motion.visPin?.("foc", i); } catch { /* motion not built */ }   // (last-trade filter) the pulsing coin is drawn
    t0 = performance.now();
    U.uFocusT.value = Math.max(U.uFocusT.value, 0.001);
    S.lastInputAt = performance.now();
    relayout();
    S.invalidate();
  }

  function stop() {
    t0 = -1;
    U.uFocusT.value = 0; U.uFocusDim.value = 0; U.uFocusCoin.value = -1;
    try { S.motion.visPin?.("foc", -1); } catch { /* motion gone */ }
    setLabelDim(0);
  }

  S.onFrame((now) => {
    if (t0 < 0) return false;
    const e = Math.max(0, performance.now() - t0);
    if (e >= T_END) { stop(); relayout(); return true; }   // one more frame draws the cleared state
    const a = e < T_IN ? easeOut(e / T_IN) : e < T_HOLD ? 1 : 1 - easeInOut((e - T_HOLD) / (T_END - T_HOLD));
    U.uFocusT.value = Math.max(a, 0.001);
    U.uFocusDim.value = a;
    setLabelDim(a);
    return true;
  });

  function fly(i) {
    const my = ++tok;
    const done = (r) => { if (my === tok && !S.dead && !(r && r.cancelled)) pulse(i); return r; };
    if (i >= DUST0) {
      const t = target(i);
      if (!t) return Promise.resolve(null);
      return Promise.resolve(S.motion.flyTo(t.x, t.y, t.k)).then(done);
    }
    if (!(i >= 0 && i < S.N)) {
      // a newborn (not in the layout arrays): motion's own coin flight, then the pulse
      const p = S.motion.flyToCoin ? S.motion.flyToCoin(i) : null;
      return Promise.resolve(p).then(done);
    }
    const t = target(i);
    return Promise.resolve(S.motion.flyTo(t.x, t.y, t.k)).then(done);
  }

  function state() {
    const i = coin;
    let rPx = 0;
    if (i >= DUST0 && S.swarm) rPx = S.swarm.screenR(i);
    else if (i >= 0 && i < S.N) {
      try { rPx = S.bubbles && typeof S.bubbles.drawnPx === "function" ? S.bubbles.drawnPx(i) : Rd(i) * S.cam.k; } catch { rPx = Rd(i) * S.cam.k; }
    }
    const pin = S.labels && typeof S.labels.pinned === "function" ? S.labels.pinned() : null;
    return { i, t: U.uFocusT.value, dim: U.uFocusDim.value, rPx, k: S.cam.k, label: !!(pin && pin.on && pin.i === i && i >= 0) };
  }

  S.focus = { target, fly, pulse, state, active: () => t0 >= 0 };
  S.debugFns.focusState = state;
  S.life.onDispose(() => { t0 = -1; tok++; if (labelsEl) labelsEl.style.removeProperty("--m3-fdim"); });
  return S.focus;
}
