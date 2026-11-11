// LOOK LANE (2026-10-21 16:00Z, owner list 3/4/10): nebula + ambient REAL cause fixed: THREE.AdditiveBlending with
// premultipliedAlpha false is blendFunc(SRC_ALPHA, ONE), and both shaders wrote alpha 0, so nothing was ever added. Now
// CustomBlending One/One (alpha channel kept) + FS alpha 1, as the monolith (M:389/M:418); re-tuned from the monolith
// (rnd(id,14) < 0.12, r = 6 Rc + 40, teal <= 3 h else #6a54b0, a 0.05). The nebula follows drags ("positions") and dims
// under uFocusDim; galaxy specks: no edge feather, hidden when S.bubbles.drawsDustTops (bubbles draws every family top).
// S.debug.obj.nebula / .ambient (obj.glows stays the coronas of bubbles.js).
// FINAL POLISH (2026-10-21, LANES.md section 14): tighter field (clearance 8, pad 2.2, no edge skipping); at the overview it
// is a halo that starts at the colonies' outline and dissolves by 1.6 Rcl, dots 2.0 -> 0.8 px by value rank; quieter live dust.
// dust.js: the overview field. Dust placement (the ~2,170 small families), the single member-offset loop,
// and the dust Points (one draw).
// (map3 port) Copied from the prototype. Changed: debug functions go to S.debugFns (dustCheck, dustFlash); a highlight
// mask per speck (setDustVis: a speck dims to TOK.dim when its family has no match, 160 ms crossfade);
// the geometry and material are disposed with the engine.
// OWNER: OVERVIEW lane (with scene.js). Spec: "SPORE MAP: GRAPHITE INSTRUMENT" R7 + overview lane 4/5.
//
// EXPORTS
//   placeDust(S)   runs right after buildLayout(S) (needs S.planetHulls, S.Rcl, f.Rc, planets' f.cx/f.cy).
//                  Sets f.cx/f.cy for dust families on a jittered Vogel spiral with planet-hull rejection, then
//                  THE single member-offset loop (X[i] += f.cx, Y[i] += f.cy for every family; after this X/Y
//                  are WORLD coordinates). Fills S.Rout (98th pct of |c|+Rc over dust), S.RoutMax (max),
//                  S.dustTypR (median dust Rc; scene.js may lower it at each fit, see there; motion uses it for
//                  uDustExpand), S.overview.dustRcMedian, and S.dustCaption {x, y} (world anchor of the
//                  '+2,174 smaller families' caption; scene.js keeps it at {0, -0.9*Rvis}).
//   buildDust(S)   needs S.gfx.scene and S.overview.uRvis (scene.js). Adds the dust Points (renderOrder 1, one
//                  draw call). No frame hook: drift runs on uTime/uDrift, which motion drives.
//                  S.overview.setDustHeat(famIdx, cls)   direct attribute write for the heat poller.
//                  (integrator, round 2) S.overview.flashDust(famId, tSec)  a trade in a dust family at the overview: the
//                    speck brightens toward TOK.pulse and a 1 CSS px ring pings 2.5 -> 6.5 px around it, 380 ms ease-out,
//                    "over"-blended and <= 0.9 linear (never HDR). Same meaning and colour as links' planet-chip ping.
//                  (integrator, round 2) S.overview.setPositions(famIds, n)  specks follow dust families that the drag
//                    simulation floats (motion calls it every frame something moved; the frame hook lands them home).
//                  (map3 port + the Key's last-trade filter, 2026-11-10) S.overview.setDustVis(famIds | null, tSec = now): a speck's
//                    alpha follows its family's code in S.vis.fa (vis.js: 0 = nothing of the family drawn, 1 = dim: a
//                    highlight matches none of it, 2 = full), the galaxy nebula blob its family's (0 or 1), each crossfading
//                    160 ms from what it shows now (per speck / blob: a family a trade reveals fades in alone)
//   Debug: S.debugFns.dustCheck() -> {dustDust, dustHull, minDustGap, minHullGap, n}
//          S.debug.obj.dustPts, .nebula, .ambient (= .ambPts); obj.glows is NOT written here (bubbles' coronas);
//          S.debug.map.{Rout, dustField}
//
// PLACEMENT (R7: dust is NOT co-packed with planets, "dust between planets reads as their children").
// A spiral slot is accepted when its circle (f.Rc + 3) clears every planet hull by >= 10 u, does not hit an
// accepted dust circle, and has OPEN SKY: of 16 rays cast from it, at least 4 let the circle slide out to
// infinity without touching a planet. That keeps dust out of the gaps between planets (and out of narrow
// channels leading into them) while it still fills the dents of the cluster outline, whatever its shape.
// Spacing: s = 1.1 * median(2*(Rc + 3)) is read as the NEIGHBOUR spacing, so the Vogel constant is
// c = 0.525*s (hex neighbour distance of a Vogel spiral is ~1.9 c). With the spec's c = s the field came out
// ~4x the planet cluster's radius and half empty.
// DRAWING: crisp 1.2-2.4 CSS px discs in the heat class colour (TOK.rim / TOK.dustA), live additive, the rest
// premultiplied over; an edge feather that, at the overview, dissolves the field at the frame (Rvis) and opens
// to the true extent (0.8 Rout .. RoutMax) past 1.3 k0; crossfade hand-off to the family bubbles on uDustExpand.
import * as THREE from "three";
import { GOLDEN, rnd } from "./util.js";
import { TOK, GAL, heatClass } from "./tokens.js";
import { VIS_ALPHA } from "./vis.js";

// (final polish) a tighter field: the halo hugs the colonies (clearance 8 u, pad 2.2 u) and no longer thins its outer
// 30 % by skipping slots; the overview fade (buildDust) does the dissolving, so the field reads as a halo whose
// density and brightness fall off with distance, not as a uniform starfield
const HULL_CLEAR = 8;    // u, min clearance between a dust circle and a planet hull (spec 10)
const PAD = 2.2;         // u, dust circle = f.Rc + PAD (spec 3)

// (final fix) pause: optional async yield, as in layout.js: the slot search yields every 40 ms of work (same order, same
// result)
export async function placeDust(S, pause = null) {
  const t0 = performance.now();
  const { fams, dust, planets, X, Y } = S;
  const hulls = (S.planetHulls && S.planetHulls.length ? S.planetHulls : planets.map((f) => ({ x: f.cx, y: f.cy, r: f.Rc })))
    .map((h) => ({ x: h.x, y: h.y, r: h.r, d: Math.hypot(h.x, h.y) }));
  let Rcl = S.Rcl; if (!(Rcl > 0)) { Rcl = 0; for (const h of hulls) Rcl = Math.max(Rcl, h.d + h.r); }

  const diam = dust.map((f) => 2 * (f.Rc + PAD)).sort((a, b) => a - b);
  const s = 1.1 * (diam.length ? diam[diam.length >> 1] : 10);
  const c = 0.525 * s;                       // Vogel constant: nearest-neighbour spacing ~ s (see header)
  let maxRc = 0; for (const f of dust) maxRc = Math.max(maxRc, f.Rc);
  const cell = 2 * (maxRc + PAD) + 6;
  const grid = new Map(), gk = (gx, gy) => (gx + 32768) * 65536 + (gy + 32768);
  const hitsDust = (x, y, rc) => {
    const g0x = Math.floor((x - rc - maxRc - PAD) / cell), g1x = Math.floor((x + rc + maxRc + PAD) / cell);
    const g0y = Math.floor((y - rc - maxRc - PAD) / cell), g1y = Math.floor((y + rc + maxRc + PAD) / cell);
    for (let gx = g0x; gx <= g1x; gx++) for (let gy = g0y; gy <= g1y; gy++) {
      const a = grid.get(gk(gx, gy)); if (!a) continue;
      for (const q of a) { const dx = x - q.x, dy = y - q.y, m = rc + q.r; if (dx * dx + dy * dy < m * m) return true; }
    }
    return false;
  };
  // hull clearance + open sky (see header): rays vs hulls inflated by HULL_CLEAR + rc
  const NRAY = 16, SKY = 4;
  const DIRS = Array.from({ length: NRAY }, (_, i) => [Math.cos((i + 0.5) * 2 * Math.PI / NRAY), Math.sin((i + 0.5) * 2 * Math.PI / NRAY)]);
  const tooClose = (x, y, rc) => { for (const h of hulls) { const dx = x - h.x, dy = y - h.y, R2 = h.r + HULL_CLEAR + rc; if (dx * dx + dy * dy < R2 * R2) return true; } return false; };
  const enclosed = (x, y, rc) => {
    let open = 0;
    for (let q = 0; q < NRAY; q++) {
      const [ux, uy] = DIRS[q]; let hit = false;
      for (const h of hulls) {
        const ox = h.x - x, oy = h.y - y, t = ox * ux + oy * uy; if (t <= 0) continue;
        const R2 = h.r + HULL_CLEAR + rc, perp2 = ox * ox + oy * oy - t * t; if (perp2 < R2 * R2) { hit = true; break; }
      }
      if (!hit && ++open >= SKY) return false;
      if (q + 1 - open > NRAY - SKY) return true;
    }
    return true;
  };
  const blocked = (x, y, rc) => tooClose(x, y, rc) || enclosed(x, y, rc);

  // Vogel slots, area-true (slot k sits at c*sqrt(k)). Two refinements keep the COUNT density even, which is
  // what the eye reads (every dot is drawn at ~1.2 px whatever its family size):
  // - a slot lost to a dust collision (a big family next to its neighbours) is kept in a short free list and
  //   offered to the next, smaller families, so the big ones near the cluster do not leave a sparse moat;
  // - the last EDGE share of the field skips slots with a rising probability, so the field thins out
  //   (dissolves) instead of ending on the spiral's last circle. The alpha feather in buildDust adds to it.
  const EDGE = 0;
  // (bubbles lane, look fix 2026-10-22, flat only) a LANDSCAPE frame gets an elliptical field with the fit rect's aspect (x * ax,
  // y / ax: area-true, so the slot density and the neighbour spacing stay what the Vogel constant set). The overview keeps
  // every family in frame (scene.js), and a round field of radius ~Rout inside a 1076 x 805 rect pinned k0 to 0.55 (the old
  // frame fit was 0.76): the oval fits the frame at ~0.63. Portrait frames (phones) and the galaxy look keep the round field.
  // (repair, look fix 2026-10-22) a PORTRAIT frame (phones) gets the same treatment the other way round (x / ax, y * ax with
  // ax = sqrt(A), A >= 1 / 1.8): the overview now keeps every family in frame on a phone too (scene.js all-tops rule), and
  // the round field fitted a 390 x 581 rect only at k0 0.26 (the planet fit gave 0.50); the oval fits it at ~0.32.
  let ax = 1;
  if (S.look !== "galaxy" && typeof S.fitRect === "function") {
    try {
      const fr = S.fitRect(), A = (fr.x1 - fr.x0) / Math.max(1, fr.y1 - fr.y0);
      if (A > 1.05) ax = Math.sqrt(Math.min(A, 1.8)); else if (A < 0.95) ax = Math.sqrt(Math.max(A, 1 / 1.8));
    } catch { ax = 1; }
  }
  let k = Math.ceil((0.55 * Rcl / c) ** 2), tries = 0;
  const kStart = k, free = [];
  const slotXY = (kk, jr, j2) => { const r = c * Math.sqrt(kk) * (1 + jr), th = kk * GOLDEN + j2 * 0.7 * c / r; return [Math.cos(th) * r * ax, Math.sin(th) * r / ax]; };
  const accept = (f, x, y, rc) => { f.cx = x; f.cy = y; const key = gk(Math.floor(x / cell), Math.floor(y / cell)); let a = grid.get(key); if (!a) grid.set(key, (a = [])); a.push({ x, y, r: rc }); };
  const placeOne = (f, idx) => {
    // (compact layout) f.seed: the family's id in the full build (data.js), so its jitter is the same in every filtered build
    const fsd = f.seed ?? f.id, rc = f.Rc + PAD, jr = (rnd(fsd, 41) - 0.5) * 0.12, j2 = rnd(fsd, 42) - 0.5;
    const u = idx / Math.max(1, dust.length - 1), pSkip = u > 1 - EDGE ? 0.8 * ((u - (1 - EDGE)) / EDGE) ** 1.5 : 0;
    for (let q = 0; q < free.length && q < 24; q++) {
      const [x, y] = slotXY(free[q], jr, j2); tries++;
      if (!blocked(x, y, rc) && !hitsDust(x, y, rc)) { free.splice(q, 1); accept(f, x, y, rc); return; }
    }
    for (;;) {
      tries++;
      const kk = k++;
      if (pSkip > 0 && rnd(kk, 43) < pSkip) continue;
      const [x, y] = slotXY(kk, jr, j2);
      if (blocked(x, y, rc)) continue;
      if (hitsDust(x, y, rc)) { free.push(kk); if (free.length > 160) free.shift(); continue; }
      accept(f, x, y, rc); return;
    }
  };
  let tSlice = performance.now();
  for (let idx = 0; idx < dust.length; idx++) {
    placeOne(dust[idx], idx);
    if (pause && performance.now() - tSlice > 40) { await pause(); tSlice = performance.now(); }
  }

  // extents: Rout = 98th percentile of |c| + Rc, RoutMax = max
  const ext = dust.map((f) => Math.hypot(f.cx, f.cy) + f.Rc).sort((a, b) => a - b);
  const Rout = ext.length ? ext[Math.min(ext.length - 1, Math.floor(ext.length * 0.98))] : Rcl;
  const RoutMax = ext.length ? ext[ext.length - 1] : Rcl;

  // THE single member-offset loop: family-local -> world
  for (const f of fams) for (const i of f.members) { X[i] += f.cx; Y[i] += f.cy; }

  const byRc = dust.map((f) => f.Rc).sort((a, b) => a - b);
  S.Rout = Rout; S.RoutMax = RoutMax;
  S.dustTypR = byRc.length ? byRc[byRc.length >> 1] : 6;
  S.overview.dustRcMedian = S.dustTypR;          // scene.js caps S.dustTypR from this at every fit
  S.dustCaption = { x: 0, y: -0.9 * Rout };
  S.debug.map.Rout = Math.round(Rout);
  S.debug.map.dustField = { s: +s.toFixed(2), c: +c.toFixed(2), kStart, kEnd: k, tries, RoutMax: Math.round(RoutMax), Rcl: Math.round(Rcl), ax: +ax.toFixed(3), ms: +(performance.now() - t0).toFixed(1) };

  S.debugFns.dustCheck = () => {
    let dustDust = 0, dustHull = 0, minDustGap = Infinity, minHullGap = Infinity;
    const G = new Map(), C = 2 * maxRc + 4;
    for (const f of dust) { const key = gk(Math.floor(f.cx / C), Math.floor(f.cy / C)); let a = G.get(key); if (!a) G.set(key, (a = [])); a.push(f); }
    for (const f of dust) {
      const gx = Math.floor(f.cx / C), gy = Math.floor(f.cy / C);
      for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (const q of G.get(gk(x, y)) || []) {
        if (q.id <= f.id) continue;
        const gap = Math.hypot(f.cx - q.cx, f.cy - q.cy) - f.Rc - q.Rc; minDustGap = Math.min(minDustGap, gap); if (gap < 0) dustDust++;
      }
      for (const h of hulls) { const gap = Math.hypot(f.cx - h.x, f.cy - h.y) - f.Rc - h.r; minHullGap = Math.min(minHullGap, gap); if (gap < 0) dustHull++; }
    }
    return { dustDust, dustHull, minDustGap: +minDustGap.toFixed(2), minHullGap: +minHullGap.toFixed(2), n: dust.length };
  };
}

export function buildDust(S) {
  const { dust, U } = S;
  U.uFocusDim ??= { value: 0 };   // (look lane) shared with the focus flow (state.js declares it; ??= keeps lanes independent)
  const scene = S.gfx.scene;
  const n = dust.length;
  // (galaxy look, 2026-10-21) G = galaxy; T = S.tok (GAL over TOK) or TOK. JS behind G, GLSL behind #ifdef GALAXY: flat is
  // pixel-identical. Galaxy: specks in the heat colour x 0.9 heatK (HDR lime when live, additive), size max(2.6, 2.4 coreR) u,
  // a slow world-unit drift on uAnimT + a parallax lag on pans, nebula blobs under 12 % of the small families, and an ambient
  // star field (6000 points, 2500 on a phone) that never fades.
  const G = S.look === "galaxy", T = S.tok || TOK;
  const GHEATK = T.heatK || GAL.heatK, GDRIFT = T.dustDrift || GAL.dustDrift, GNEB = T.nebula || GAL.nebula, GAMB = T.ambient || GAL.ambient;
  const f3 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

  // per point: position = family centre; aD = (disc diameter CSS px, top radius in world u, drift omega, drift phase);
  // aE = (heat class, family id, |c| world radius for the edge feather, flash start on the uTime clock)
  let vmax = 0; for (const f of dust) vmax = Math.max(vmax, f.value);
  const pos = new Float32Array(n * 3), aD = new Float32Array(n * 4), aE = new Float32Array(n * 4);
  const aG = new Float32Array(n * 4);   // (galaxy) Rc (u), drift speed, parallax depth 0.04-0.14, drift phase
  const kOf = new Int32Array(S.fams.length).fill(-1);
  dust.forEach((f, k) => {
    kOf[f.id] = k;
    pos[k * 3] = f.cx; pos[k * 3 + 1] = f.cy;
    // (final polish) diameter by value RANK (the placement order), 2.0 px next to the colonies down to 1.2 px at the rim of the
    // field: this reads as a gradient (the biggest small families closest), not as a uniform starfield
    // (bubbles lane, look fix 2026-10-22) 0.8 -> 1.2 px at the rim: the field no longer feathers out (every family stays
    // visible at the overview, the owner's ask), so the far ring must still read as a dot
    const dCss = 2.0 - 0.8 * Math.sqrt(k / Math.max(1, n - 1));
    const period = 14 + 12 * rnd(f.id, 12);                                    // (round 2 final) 14-26 s (was 30-60 s: invisible)
    aD.set([dCss, f.coreR || 1, (2 * Math.PI) / period, rnd(f.id, 11) * 2 * Math.PI], k * 4);
    aE.set([heatClass(f.age), f.id, Math.hypot(f.cx, f.cy), -1e3], k * 4);
    aG.set([f.Rc || 1, GDRIFT.sp0 + GDRIFT.sp1 * rnd(f.id, 4), 0.04 + 0.10 * rnd(f.id, 6), rnd(f.id, 9) * 2 * Math.PI], k * 4);
  });
  const g = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("position", posAttr);
  g.setAttribute("aD", new THREE.BufferAttribute(aD, 4));
  const aEAttr = new THREE.BufferAttribute(aE, 4); aEAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("aE", aEAttr);
  g.setAttribute("aG", new THREE.BufferAttribute(aG, 4));   // (galaxy) unused under flat
  // (map3 port) highlight, (last-trade filter) and visibility, per speck: alpha (shown when its crossfade started, target,
  // start s on the uTime clock); target VIS_ALPHA[S.vis.fa[family]] = 0 (nothing of the family drawn), TOK.dim, 1
  const V = S.vis || null, famA = (id) => VIS_ALPHA[V && id < V.fa.length ? V.fa[id] : 2];
  const aHl = new Float32Array(n * 3);
  dust.forEach((f, k) => { aHl[k * 3] = aHl[k * 3 + 1] = famA(f.id); aHl[k * 3 + 2] = -1e3; });
  const aHlAttr = new THREE.BufferAttribute(aHl, 3); aHlAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("aHl", aHlAttr);

  const view = new THREE.Vector2(S.W(), S.H());
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...U,
      uRim: { value: T.rim.map((h) => new THREE.Color(h)) },                 // linear (sRGB hex in); galaxy: GAL.rim
      uHeatK: { value: GHEATK.slice() },
      ...(U.uAnimT ? {} : { uAnimT: { value: 0 } }), ...(U.uFlow ? {} : { uFlow: { value: 1 } }),   // (galaxy) state.js owns these in S.U
      // TOK.dustA, with the +0.06 the spec allows on cold/quiet ("if it reads too dark, raise only the cold/quiet
      // dust alpha, max +0.06"): at the compact layout the field is sparse (one dot per ~22 px) and read as empty
      // (final polish) live dust 0.8 (was 0.95) and cooling 0.5: a live small family is a spark, not a lime sprinkle; quiet/cold +0.06 (spec allowance)
      uDustA: { value: [0.72, 0.42, TOK.dustA[2] + 0.04, TOK.dustA[3] + 0.04] },
      // (look fix) quiet / cold specks are half desaturated toward TOK.muted (7e8783): 2,000 faint heat-coloured dots read as
      // noise, grey ones as a field; live / cooling keep their colour (heat only reads on >= 5 px discs anyway)
      uMuted: { value: new THREE.Color(TOK.muted) },
      uDim: { value: TOK.dim },
      uPulse: { value: new THREE.Color(TOK.pulse) },
      uView: { value: view },
      uRvis: S.overview.uRvis,                                                // overview field radius (scene.js overviewTarget keeps it current)
      uRout: { value: S.Rout }, uRoutMax: { value: S.RoutMax }, uRcl: { value: S.Rcl },                                                  // CSS px viewport (drift in clip space)
    },
    vertexShader: /* glsl */`
uniform float uPx, uDpr, uTime, uDustExpand, uHoverFam, uDimMix, uFadeD, uDrift, uDim, uK0, uRvis, uRout, uRoutMax, uFocusFam, uFocusMix, uRcl;
uniform vec2 uView;
uniform vec3 uRim[4], uPulse, uMuted;
uniform float uDustA[4];
uniform float uAnimT, uFlow; uniform float uHeatK[4]; uniform vec2 uCam; uniform float uFocusDim;
attribute vec4 aD;
attribute vec4 aE;
attribute vec3 aHl;
#ifdef GALAXY
attribute vec4 aG;
#endif
varying vec3 vCol; varying float vA, vRad, vAdd, vSize, vRingR, vRingA, vDev;
void main(){
  int cls = int(aE.x + 0.5);
  // crisp disc at the spec diameter (a coverage dot, like the children stipple); during the hand-off it grows
  // to the family top's true size, so the bubble that replaces it appears where and as big as the dot was
#ifdef GALAXY
  // (galaxy) a glowing speck: max(2.6, 2.4 coreR) world units, never under 1.6 nor over 56 device px
  float dDev = clamp(max(2.6, 2.4 * aD.y) * uPx, 1.6 * uDpr, 56.0 * uDpr);
  float cov = 1.0;
#else
  float dDev = mix(aD.x, max(aD.x, 2.0 * aD.y * uPx / uDpr), uDustExpand) * uDpr;
  float cov = 1.0;
  if (dDev < 1.0) { cov = dDev; dDev = 1.0; }                                  // never under 1 device px: coverage alpha
  dDev = min(dDev, 62.0);
#endif
  // edge feather: at the overview the field dissolves at the visible field radius uRvis (the frame edge);
  // zooming in past 1.3 k0 opens it to the true extent (spec: 0.8 Rout .. RoutMax), so no family stays hidden
  // (final polish) at the overview the halo starts at the colonies' outline and dissolves by ~1.75 Rcl (a falling density
  // curve, not a hard edge); the dot also shrinks a little outward, so the field reads as structure around the map
  // (look lane, galaxy) owner item 3: every family is visible at the overview, the far ones too (no feather)
  // (bubbles lane, look fix 2026-10-22, flat) the same: the old halo feather (1.0 Rcl -> 1.6 Rcl) hid the far families; now every
  // speck is drawn at its full uDustA alpha and the field is calm through size (1.2-2.0 px) and the muted quiet / cold colour
  float edge = 1.0;
  float vis = edge * (1.0 - uDustExpand) * uFadeD;
#ifdef GALAXY
  vis *= 1.0 - 0.6 * uFocusDim;
#endif
  if (uHoverFam > -0.5 && abs(aE.y - uHoverFam) > 0.5) vis *= mix(1.0, uDim, uDimMix);
  if (uFocusFam > -0.5 && abs(aE.y - uFocusFam) > 0.5) vis *= mix(1.0, 0.42, uFocusMix);
  // (map3 port) highlight: a family with no matching coin dims like the hover dim (160 ms crossfade); (last-trade filter) a
  // family with nothing drawn has no speck (vis 0: culled below, the flash ring scales with vis too)
  vis *= mix(aHl.x, aHl.y, smoothstep(aHl.z, aHl.z + 0.16, uTime));
#ifdef GALAXY
  float a = (cls == 0 ? 1.0 : cls < 3 ? 0.8 : 0.5) * cov * vis;
#else
  float a = uDustA[cls] * cov * vis;
#endif
  // (integrator, round 2) trade flash: the speck brightens toward the pulse colour and grows 1.5 px, and a 1 CSS px ring
  // pings 2.5 -> 6.5 px; (1 - u)^2 / cubic ease-out over 380 ms, scaled by the speck's own visibility (edge, hand-off, dim)
  float ft = uTime - aE.w, fl = 0.0, ringR = 0.0, ringA = 0.0;
#ifdef GALAXY
  vec3 col = uRim[cls] * (0.9 * uHeatK[cls]);
#else
  vec3 col = cls >= 2 ? mix(uRim[cls], uMuted, 0.5) : uRim[cls];   // (look fix) quiet / cold specks half muted
#endif
  if (ft >= 0.0 && ft < 0.38) {
    float u = ft / 0.38, iu = 1.0 - u;
    fl = iu * iu;
    ringR = mix(2.5, 6.5, 1.0 - iu * iu * iu) * uDpr;
    ringA = 0.55 * pow(iu, 1.5) * vis;
    a = mix(a, 0.9 * vis, fl);
    col = mix(col, uPulse, 0.85 * fl);
    dDev += 1.5 * fl * uDpr;
  }
  // (round 2 final) afterglow: a speck that traded stays brighter and a little larger for ~50 s, toward ink (never lime)
  if (ft >= 0.38) { float ag = exp(-(ft - 0.38) / 16.0); a = mix(a, max(a, 0.8 * vis), 0.7 * ag); col = mix(col, vec3(0.70, 0.74, 0.72), 0.4 * ag); dDev += 0.9 * ag * uDpr; }
#ifdef GALAXY
  // (galaxy) drift in world units on the animation clock (amp 5 + 0.45 Rc, speed 0.25-0.6), gone once the field hands off;
  // parallax: the field lags a pan by its depth (zero at the overview centre, so the specks sit where the layout put them)
  vec2 wp = position.xy + vec2(sin(uAnimT * aG.y + aG.w), cos(0.8 * uAnimT * aG.y + 1.3 * aG.w)) * (${f3(GDRIFT.amp0)} + ${f3(GDRIFT.ampK)} * aG.x) * (1.0 - uDustExpand) * uFlow;
  wp += uCam * aG.z * (1.0 - uDustExpand);
  vec4 clip = projectionMatrix * viewMatrix * vec4(wp, 0.0, 1.0);
  gl_Position = clip;
#else
  vec4 clip = projectionMatrix * viewMatrix * vec4(position.xy, 0.0, 1.0);
  vec2 drift = vec2(sin(uTime * aD.z + aD.w), cos(uTime * aD.z * 0.83 + aD.w * 1.7)) * 0.8 * uDrift;   // <= 0.8 CSS px (round 2 final)
  clip.xy += drift * 2.0 / uView;
  gl_Position = clip;
#endif
  gl_PointSize = ringA > 0.0 ? max(dDev + 2.0, 2.0 * (ringR + uDpr) + 2.0) : dDev + 2.0;
  vSize = gl_PointSize; vRingR = ringR; vRingA = ringA; vDev = uDpr;
#ifdef GALAXY
  vRad = 0.5 * dDev; vCol = col; vA = a; vAdd = fl <= 0.0 ? 1.0 : 0.0;   // (galaxy) every speck is additive (a flashing one is "over")
#else
  vRad = 0.5 * dDev; vCol = col; vA = a; vAdd = cls == 0 && fl <= 0.0 ? 1.0 : 0.0;   // a flashing speck is "over"
#endif
  if (max(a, ringA) < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`,
    fragmentShader: /* glsl */`
uniform vec3 uPulse;
varying vec3 vCol; varying float vA, vRad, vAdd, vSize, vRingR, vRingA, vDev;
void main(){
  float d = length(gl_PointCoord - 0.5) * vSize;                              // device px from the centre
  float a = vA * clamp((vRad - d) / 0.75 + 0.5, 0.0, 1.0);                    // 0.75 device px feather
  float ring = vRingA > 0.0 ? vRingA * clamp(0.5 * vDev + 0.5 - abs(d - vRingR), 0.0, 1.0) : 0.0;   // ~1 CSS px stroke
  if (a < 0.002 && ring < 0.002) discard;
  if (ring > 0.0) { float o = a + ring * (1.0 - a); gl_FragColor = vec4(vCol * a + min(uPulse, vec3(0.9)) * ring * (1.0 - a), o); return; }
  gl_FragColor = vec4(vCol * a, vAdd > 0.5 ? 0.0 : a);                       // live: additive, rest: premultiplied over
}`,
    transparent: true, depthTest: false, depthWrite: false, defines: G ? { GALAXY: 1 } : {},
  });
  mat.blending = THREE.CustomBlending; mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  const dustPts = new THREE.Points(g, mat); dustPts.frustumCulled = false; dustPts.renderOrder = 1; scene.add(dustPts);
  if (S.bubbles && S.bubbles.drawsDustTops) dustPts.visible = false;   // (flat fix) both looks: bubbles.js draws every family top
  S.on("resize", () => { view.set(S.W(), S.H()); });
  // (look lane) galaxy: bubbles.js draws every family top as a lit disc (S.bubbles.drawsDustTops), so the specks hide; their
  // pick data (dgrid), setPositions and the caption stay
  const hideSpecks = () => { const h = !!(S.bubbles && S.bubbles.drawsDustTops); if (dustPts.visible === h) { dustPts.visible = !h; S.invalidate(); } };

  // ---------- (galaxy) nebula blobs: 12 % of the small families (rnd(f.id, 7) < 0.12) get a soft additive glow, r = 6 Rc + 40 u,
  // teal when the family traded within 3 h, else purple, alpha 0.05; dissolves with the field (same edge as the specks)
  let nebula = null, ambPts = null, aNV = null, aNVAttr = null;
  const glowFS = /* glsl */`
varying vec2 vP; varying vec3 vCol; varying float vA;
void main(){
  float d = length(vP);
  float g = exp(-4.2 * d * d) * (1.0 - smoothstep(0.85, 1.0, d));
  vec3 c = vCol * (vA * g);
  if (max(c.r, max(c.g, c.b)) < 0.0008) discard;
  gl_FragColor = vec4(c, 1.0);   // (look lane) One/One blending: rgb is added as is; the alpha channel is kept (see addMat)
}`;
  // (look lane) THE nebula/ambient fix: One/One on rgb (pure add, whatever the FS alpha), destination alpha kept
  const addMat = (m) => { m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; m.blendEquation = THREE.AddEquation;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; m.blendEquationAlpha = THREE.AddEquation; return m; };
  const nebOf = new Int32Array(S.fams.length).fill(-1);
  if (G) {
    const neb = dust.filter((f) => rnd(f.id, 14) < GNEB.frac);   // (look lane) monolith M:378 seed 14
    if (neb.length) {
      const quad = new THREE.PlaneGeometry(2, 2);
      const nGeo = new THREE.InstancedBufferGeometry(); nGeo.index = quad.index; nGeo.setAttribute("position", quad.getAttribute("position"));
      const aN = new Float32Array(neb.length * 4), aNC = new Float32Array(neb.length * 3);
      const teal = new THREE.Color(GNEB.teal), purple = new THREE.Color(GNEB.purple);
      neb.forEach((f, q) => {
        const c = (f.age ?? 1e9) <= 10800 ? teal : purple;   // (look lane) monolith: teal when it traded within 3 h, else #6a54b0
        nebOf[f.id] = q;
        aN.set([f.cx, f.cy, GNEB.rk * f.Rc + GNEB.rAdd, Math.hypot(f.cx, f.cy)], q * 4); aNC.set([c.r, c.g, c.b], q * 3);
      });
      const aNAttr = new THREE.InstancedBufferAttribute(aN, 4); aNAttr.setUsage(THREE.DynamicDrawUsage);
      nGeo.setAttribute("aN", aNAttr); nGeo.setAttribute("aNC", new THREE.InstancedBufferAttribute(aNC, 3));
      // (last-trade filter) per blob (shown when its crossfade started, target, start s): 0 when nothing of its family is drawn
      aNV = new Float32Array(neb.length * 3);
      neb.forEach((f, q) => { const v = famA(f.id) > 0 ? 1 : 0; aNV.set([v, v, -1e3], q * 3); });
      aNVAttr = new THREE.InstancedBufferAttribute(aNV, 3); aNVAttr.setUsage(THREE.DynamicDrawUsage); nGeo.setAttribute("aNV", aNVAttr);
      // (look lane) the nebula follows drags: on every "positions" event the blob centres re-read f.cx/f.cy (a few hundred compares)
      S.on("positions", () => {
        let any = false;
        for (let q = 0; q < neb.length; q++) {
          const f = neb[q], x = Math.fround(f.cx), y = Math.fround(f.cy);
          if (aN[q * 4] === x && aN[q * 4 + 1] === y) continue;
          aN[q * 4] = x; aN[q * 4 + 1] = y; any = true;
        }
        if (any) { aNAttr.needsUpdate = true; S.invalidate(); }
      });
      const nMat = new THREE.ShaderMaterial({
        uniforms: { ...U, uRvis: S.overview.uRvis, uRout: mat.uniforms.uRout, uRoutMax: mat.uniforms.uRoutMax, uRcl: mat.uniforms.uRcl },
        vertexShader: /* glsl */`
uniform float uPx, uDpr, uDustExpand, uFadeD, uK0, uRcl, uRout, uRoutMax, uFocusDim, uTime;
attribute vec4 aN; attribute vec3 aNC; attribute vec3 aNV;
varying vec2 vP; varying vec3 vCol; varying float vA;
void main(){
  float open = smoothstep(1.3 * uK0, 2.2 * uK0, uPx / uDpr);
  float fin = mix(1.0 * uRcl, 0.80 * uRout, open), fout = mix(max(1.6 * uRcl, 1.0 * uRcl + 1.0), uRoutMax + 1.0, open);
  float e0 = mix(1.0, 1.0 - smoothstep(fin, max(fout, fin + 1.0), aN.w), open);   // (lead) the halo is whole at the overview; the field edge only bites as a family opens
  float a = ${f3(GNEB.a)} * e0 * (1.0 - 0.7 * uDustExpand) * uFadeD * (1.0 - 0.6 * uFocusDim);
  a *= mix(aNV.x, aNV.y, smoothstep(aNV.z, aNV.z + 0.16, uTime));   // (last-trade filter) a family with nothing drawn: no nebula
  vCol = aNC; vA = a; vP = position.xy;
  float rN = max(aN.z, ${f3(GNEB.rMinPx || 0)} * uDpr / uPx);   // (look lane) world radius 6 Rc + 40 (monolith); optional px floor
  gl_Position = projectionMatrix * viewMatrix * vec4(aN.xy + position.xy * rN, 0.0, 1.0);
  if (a < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`,
        fragmentShader: glowFS, transparent: true, depthTest: false, depthWrite: false,
      });
      addMat(nMat);
      nebula = new THREE.InstancedMesh(nGeo, nMat, neb.length); nebula.count = neb.length; nebula.frustumCulled = false; nebula.renderOrder = 1;
      nebula.instanceMatrix.needsUpdate = true; scene.add(nebula);
      S.life.onDispose(() => { scene.remove(nebula); if (!S.contextLost) { nGeo.dispose(); quad.dispose(); nMat.dispose(); } });
    }
    // ---------- (galaxy) ambient star field: n points in a disc of 1.5 Rout, depth 0.25-0.85 (parallax lag on pans), size
    // 1.2-3.4 px, drift 3-11 u on the animation clock, 60 % teal / 40 % lavender, alpha 0.05 + 0.12 (1 - depth); never fades
    const NA = S.phone() ? GAMB.nPhone : GAMB.n, RA = GAMB.rk * Math.max(S.Rout, S.Rcl, 1);
    const aPos = new Float32Array(NA * 3), aAm = new Float32Array(NA * 4), aAC = new Float32Array(NA * 3);
    const tealC = new THREE.Color(GAMB.teal), lavC = new THREE.Color(GAMB.lav);
    for (let q = 0; q < NA; q++) {
      const r = RA * Math.sqrt(rnd(q, 21)), th = rnd(q, 22) * 2 * Math.PI, depth = 0.25 + 0.6 * rnd(q, 23);
      aPos.set([r * Math.cos(th), r * Math.sin(th), 0], q * 3);
      aAm.set([1.2 + 2.2 * rnd(q, 24), depth, 3 + 8 * rnd(q, 25), rnd(q, 26) * 2 * Math.PI], q * 4);
      const c = rnd(q, 27) < GAMB.tealFrac ? tealC : lavC; aAC.set([c.r, c.g, c.b], q * 3);
    }
    const aGeo = new THREE.BufferGeometry();
    aGeo.setAttribute("position", new THREE.BufferAttribute(aPos, 3)); aGeo.setAttribute("aAm", new THREE.BufferAttribute(aAm, 4)); aGeo.setAttribute("aAC", new THREE.BufferAttribute(aAC, 3));
    const aMat = new THREE.ShaderMaterial({
      uniforms: { ...U, ...(U.uAnimT ? {} : { uAnimT: mat.uniforms.uAnimT }), ...(U.uFlow ? {} : { uFlow: mat.uniforms.uFlow }) },
      vertexShader: /* glsl */`
uniform float uPx, uDpr, uAnimT, uFlow, uK0, uFocusDim; uniform vec2 uCam;
attribute vec4 aAm; attribute vec3 aAC;
varying vec3 vCol; varying float vA;
void main(){
  float sp = 0.08 + 0.06 * fract(aAm.w);
  vec2 wp = position.xy + vec2(sin(uAnimT * sp + aAm.w), cos(0.8 * uAnimT * sp + 1.3 * aAm.w)) * aAm.z * uFlow;
  wp += uCam * aAm.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 0.0, 1.0);
  gl_PointSize = aAm.x * uDpr * clamp(uPx / uDpr / max(uK0, 1e-4), 0.75, 2.0);
  vCol = aAC; vA = (${f3(GAMB.a0)} + ${f3(GAMB.a1)} * (1.0 - aAm.y)) * (1.0 - 0.6 * uFocusDim);
}`,
      fragmentShader: /* glsl */`
varying vec3 vCol; varying float vA;
void main(){
  vec2 q = (gl_PointCoord - 0.5) * 2.0; float d2 = dot(q, q); if (d2 > 1.0) discard;
  gl_FragColor = vec4(vCol * (vA * exp(-3.2 * d2)), 1.0);
}`,
      transparent: true, depthTest: false, depthWrite: false,
    });
    addMat(aMat);
    ambPts = new THREE.Points(aGeo, aMat); ambPts.frustumCulled = false; ambPts.renderOrder = 0; scene.add(ambPts);
    S.life.onDispose(() => { scene.remove(ambPts); if (!S.contextLost) { aGeo.dispose(); aMat.dispose(); } });
    S.debug.map.galaxyDust = { nebula: neb.length, ambient: NA, ambientR: Math.round(RA) };
  }

  // (integrator, round 2) partial uploads with a real "full" fallback: once too many ranges are pending, the ranges are
  // cleared (= full upload) and stay cleared until the upload happened (three calls onUpload after every upload)
  const full = new Set();
  const touch = (attr, start, count) => {
    if (!full.has(attr)) { if (attr.updateRanges.length < 256) attr.addUpdateRange(start, count); else { attr.clearUpdateRanges(); full.add(attr); } }
    attr.needsUpdate = true;
  };
  for (const at of [posAttr, aEAttr, aHlAttr]) at.onUpload(() => full.delete(at));
  const fullUp = (attr) => { attr.clearUpdateRanges(); full.add(attr); attr.needsUpdate = true; };
  const setDustHeat = (famIdx, cls) => {
    const k = kOf[famIdx]; if (k < 0) return;
    if (aE[k * 4] === cls) return;
    aE[k * 4] = cls; touch(aEAttr, k * 4, 1); S.invalidate();
  };
  // (integrator, round 2) a trade in a dust family at the overview (motion calls it; merges per family are motion's)
  let flashUntil = 0;
  const flashDust = (famId, tSec) => {
    const k = kOf[famId]; if (k < 0) return false;
    const t = tSec == null ? U.uTime.value : tSec;
    aE[k * 4 + 3] = t; touch(aEAttr, k * 4 + 3, 1);
    flashUntil = Math.max(flashUntil, t + 0.42); S.invalidate();
    return true;
  };
  // (integrator, round 2) specks follow floating dust families (the drag simulation writes f.cx/f.cy); the frame hook
  // keeps syncing a family until motion reports it home (famMode 0), so the last frame lands exactly on the design
  const moving = new Set();
  const syncSpeck = (id) => {
    const k = kOf[id], f = S.fams[id];
    const x = Math.fround(f.cx), y = Math.fround(f.cy);
    if (pos[k * 3] === x && pos[k * 3 + 1] === y) return false;
    pos[k * 3] = x; pos[k * 3 + 1] = y; touch(posAttr, k * 3, 2); return true;
  };
  const setPositions = (famIds, n = famIds.length) => {
    let any = false;
    for (let q = 0; q < n; q++) { const id = famIds[q]; if (!(kOf[id] >= 0)) continue; moving.add(id); if (syncSpeck(id)) any = true; }
    if (any) S.invalidate();
  };
  // (look lane) the rope drag may not report famMode: every "positions" event re-syncs all specks from f.cx/f.cy
  S.on("positions", () => { let any = false; for (let k = 0; k < n; k++) if (syncSpeck(dust[k].id)) any = true; if (any) S.invalidate(); });
  S.onFrame(() => {
    if (G) hideSpecks();
    if (moving.size) {
      const mode = S.drag && S.drag.famMode;
      let any = false;
      for (const id of moving) { if (syncSpeck(id)) any = true; if (!mode || mode[id] === 0) moving.delete(id); }
      if (any) S.invalidate();
    }
    return U.uTime.value < flashUntil;
  });
  S.debugFns.dustFlash = (n = 12) => { const t = U.uTime.value; let c = 0; for (const f of dust) { if (c >= n) break; if (rnd(f.id, Math.floor(t)) < 0.02) { flashDust(f.id, t); c++; } } return c; };
  // (look fix) dustVis(): the specks' alpha as the flat vertex shader computes it now (edge 1, hand-off, fade, highlight; hover /
  // focus dims left out), per speck: n, how many are on screen / inside the fit rect, the min and 10th-percentile alpha, the
  // min alpha within 24 px of the fit rect's edge (the far ring), the diameter range and whether the Points layer is visible
  S.debugFns.dustVis = () => {
    const k = S.cam.k, W = S.W(), H = S.H(), fr = S.fitRect ? S.fitRect() : { x0: 0, y0: 0, x1: W, y1: H }, dpr = S.DPR || 1;
    const A = mat.uniforms.uDustA.value, t = U.uTime.value, vis0 = (1 - (U.uDustExpand.value || 0)) * (U.uFadeD ? U.uFadeD.value : 1);
    const al = [], byCls = [0, 1, 2, 3].map(() => ({ n: 0, onScreen: 0, minA: Infinity }));
    let onScreen = 0, inRect = 0, edgeMinA = Infinity, edgeN = 0, dMin = Infinity, dMax = 0, hidden = 0;
    for (let q = 0; q < n; q++) {
      const cls = aE[q * 4] | 0, dDev = aD[q * 4] * dpr, cov = Math.min(1, dDev);
      const hl = hlShown(q, t);   // (map3 port + last-trade filter) the speck's own alpha factor
      if (aHl[q * 3 + 1] === 0) hidden++;
      const a = A[cls] * cov * vis0 * hl;
      const sx = (pos[q * 3] - S.cam.x) * k + W / 2, sy = H / 2 - (pos[q * 3 + 1] - S.cam.y) * k;
      const b = byCls[cls] || byCls[3]; b.n++;
      if (sx < -2 || sy < -2 || sx > W + 2 || sy > H + 2) continue;
      onScreen++; b.onScreen++; al.push(a); if (a < b.minA) b.minA = a;
      if (aD[q * 4] < dMin) dMin = aD[q * 4]; if (aD[q * 4] > dMax) dMax = aD[q * 4];
      if (sx >= fr.x0 && sx <= fr.x1 && sy >= fr.y0 && sy <= fr.y1) {
        inRect++;
        const dEdge = Math.min(sx - fr.x0, fr.x1 - sx, sy - fr.y0, fr.y1 - sy);
        if (dEdge <= 24) { edgeN++; if (a < edgeMinA) edgeMinA = a; }
      }
    }
    al.sort((x, y) => x - y);
    const fin = (v) => (Number.isFinite(v) ? +v.toFixed(3) : null);
    for (const b of byCls) b.minA = fin(b.minA);
    return { n, onScreen, inRect, hidden, visible: dustPts.visible, drawsDustTops: !!(S.bubbles && S.bubbles.drawsDustTops), dustExpand: fin(S.dustExpand || 0),
      minA: fin(al[0]), p10A: fin(al[Math.floor(al.length * 0.1)]), p50A: fin(al[al.length >> 1]), edgeN, edgeMinA: fin(edgeMinA), dCssMin: fin(dMin), dCssMax: fin(dMax), byCls, k, k0: U.uK0.value, look: G ? "galaxy" : "flat" };
  };
  // (map3 port) highlight + (last-trade filter) visibility: these families (null: every small family) take their code's alpha
  // (S.vis.fa: motion.js), each speck crossfading 160 ms from what it shows now; the galaxy nebula blob of a family follows
  // whether anything of it is drawn
  const fadeAt = (arr, o, t) => { const z = arr[o + 2], e = Math.max(0, Math.min(1, (t - z) / 0.16)), s = e * e * (3 - 2 * e); return arr[o] + (arr[o + 1] - arr[o]) * s; };
  const hlShown = (k, t) => fadeAt(aHl, k * 3, t);
  const setDustVis = (famIds, tSec) => {
    const t = tSec == null ? performance.now() / 1000 : tSec;   // a fade starts now (uTime is the last frame's time)
    let ns = 0, nn = 0;
    const one = (id) => {
      const k = id >= 0 && id < kOf.length ? kOf[id] : -1; if (!(k >= 0)) return;
      const to = Math.fround(famA(id)), o = k * 3;
      if (aHl[o + 1] !== to) { aHl[o] = fadeAt(aHl, o, t); aHl[o + 1] = to; aHl[o + 2] = t; if (famIds != null) touch(aHlAttr, o, 3); ns++; }
      const q = aNV ? nebOf[id] : -1;
      if (q >= 0) { const tv = to > 0 ? 1 : 0, p = q * 3; if (aNV[p + 1] !== tv) { aNV[p] = fadeAt(aNV, p, t); aNV[p + 1] = tv; aNV[p + 2] = t; nn++; } }
    };
    if (famIds == null) { for (const f of dust) one(f.id); if (ns) fullUp(aHlAttr); }
    else for (const id of famIds) one(id);
    if (nn) aNVAttr.needsUpdate = true;
    if (ns || nn) { flashUntil = Math.max(flashUntil, t + 0.2); S.invalidate(); }
    return ns + nn;
  };
  Object.assign(S.overview, { setDustHeat, flashDust, setPositions, setDustVis });
  // (look lane) debug: show/hide the look's own layers (QA isolates their share of a shot); returns what is visible now
  S.debugFns.lookLayers = (o = {}) => {
    if (nebula && typeof o.nebula === "boolean") nebula.visible = o.nebula;
    if (ambPts && typeof o.ambient === "boolean") ambPts.visible = o.ambient;
    if (typeof o.specks === "boolean") dustPts.visible = o.specks;
    if (typeof o.bloom === "boolean" && S.gfx.setBloom) S.gfx.setBloom(o.bloom);
    const bl = S.gfx.bloom;
    if (bl && Array.isArray(o.bloomTints)) o.bloomTints.forEach((v, j) => { if (bl.bloomTintColors[j]) bl.bloomTintColors[j].setScalar(v); });
    if (bl && typeof o.bloomStrength === "number") bl.strength = o.bloomStrength;
    if (bl && typeof o.bloomRadius === "number") bl.radius = o.bloomRadius;
    if (bl && typeof o.bloomThreshold === "number") bl.threshold = o.bloomThreshold;
    // hide every scene object of these renderOrders (debug attribution of a shot), or [] to show them again
    if (Array.isArray(o.hideOrders)) { const h = new Set(o.hideOrders); scene.traverse((ob) => { if (ob === dustPts || ob === nebula || ob === ambPts || ob.renderOrder === -10) return; if (ob.isMesh || ob.isPoints || ob.isLine) { if (ob.userData.lookHid === undefined) ob.userData.lookHid = ob.visible; ob.visible = h.has(ob.renderOrder) ? false : ob.userData.lookHid; } }); }
    S.invalidate();
    return { nebula: nebula ? nebula.visible : null, nebulaN: nebula ? nebula.count : 0, ambient: ambPts ? ambPts.visible : null, specks: dustPts.visible };
  };
  Object.assign(S.debug.obj, { dustPts, nebula, ambient: ambPts, ambPts });   // (look lane) obj.glows is the coronas (bubbles.js)
  Object.assign(S.overview, { nebula, ambPts });
  S.life.onDispose(() => { scene.remove(dustPts); if (!S.contextLost) { g.dispose(); mat.dispose(); } });
}
