// swarm.js (family-all, ENGINE lane; DESIGN-FAMILY-ALL.md §2, §5.2): every coin of a capped asset family on the map.
// The server draws a capped slice of each listed-asset family (ASSET_FAMILY_DRAW); the top's `children` is the true count.
// This layer shows the rest: one THREE.Points (renderOrder 1, after dust.js's specks, below gen arcs / links / bubbles)
// with a GHOST speck per undrawn coin (procedural, no per-coin data) and REAL specks once the page loads the family's coins
// (swarmAdd). Undrawn coins never enter layout.js, links.js, the family value or the sim.
//
// EXPORTS
//   DUST0 = 4,194,304       the dust index space: engine index DUST0 + global slot (drawn 0..N-1, newborns N.. are disjoint)
//   buildSwarm(S)           during the build, after buildDust (needs S.gfx.scene, final X/Y/R, f.ghost from data.js). Creates
//                           the material, the family texture and a placeholder geometry (so compileAsync compiles the program
//                           with the scene); the slots are generated after the first frame in <= 8 ms idle slices, then the
//                           layer fades in over 400 ms (at once under reduced motion). opts.swarm === false: no layer at all.
//   S.swarm                 { on, DUST0, isDust(i), add(chunk) -> rows queued, drop(top), families() -> EngineSwarmFamily[],
//                             indexOf(mint) -> i | -1, mintAt(i), pos(i) -> [x, y, rWorld] | null, famOf(i) -> f | null,
//                             screenR(i) (CSS px), spacing(i) (world u), tip(i) -> data | null, pick(sx, sy, touch) -> i | -1,
//                             select(i), trade(mint, tSec) -> 0 | 1 | 2, setHl(testByMint | null), stats(),
//                             ghosted(famId) -> bool, setMask(rects: number[] (x0, y0, x1, y1 world, flat), n),
//                             (the Key's last-trade filter, 2026-11-10) setVis(mask, pinnedMints), setPins(pinnedMints),
//                             isShown(i) }
//   LAST-TRADE FILTER: ghosts are class 3 (drawn while mask bit 3 is on); a real speck is drawn when its own heat class is in
//   the mask or its mint is pinned (motion.js: the page's pins it does not know as coins, a selected / focused / hovered
//   speck). Hidden specks are not picked and their trade flash is not drawn; trade() answers 0 (not loaded), 1 (loaded, the
//   filter hides it), 2 (drawn). A family whose loaded specks are drawn tells motion.js (S.motion.visSpeck(famId, on)): they
//   anchor the family top. The ghosts' and each real speck's alpha (aF y / z, uSwHlA / B) fold the filter and the highlight.
//   S.debugFns.swarm(), swarmCheck() -> {outside, onDrawn, overlaps, hash, slots}, swarmSynth(top, n) -> rows queued,
//   swarmTune({aDot, sigMin, aReal, kReal}) (live look knobs), swarmShow(bool), swarmMask() (the label rects in force)
//
// LOOK (fix round after the critics, 2026-10-24: the density-normalised alpha drew a grey veil / "grey moon" at every zoom
// where a ghost is smaller than a pixel; the map's language is separate dots). Now every speck is drawn the way the map
// draws a coin: a separate dot, 1 device px (GHOST_D_DEV), at a FIXED alpha (A_DOT 0.42) in the cold rim colour (flat:
// TOK.rim[3] #535b58, one step under a drawn cold coin's disc; galaxy: rim[3] x 0.9 heatK[3]), the dust disc shader (0.75
// device px feather), premultiplied "over", LDR. ZOOM THINNING instead of alpha: sigma = the family's densest slot spacing in
// device px; slot j is shown when its thinning rank (swarm-slots thinRank, a hash: a thinned Vogel spiral forms no spokes) is
// under q = min(tau, (sigma / SIG_MIN)^2), SIG_MIN = max(2.5, 1.5 DPR) device px, so the shown dots are never closer than
// SIG_MIN where the family is densest, more of them appear as you zoom in, all of them past sigma = SIG_MIN; ranks q ..
// 1.25 q fade in instead of popping. tau = the tier cap's rank cut (phone 5k / software 3k ghosts per family;
// 1 on desktop). Real specks: live / cooling keep their heat colour (live additive, A_REAL 0.55) and are never thinned;
// quiet ones mix(rim[2], muted, 0.5), cold ones the ghost colour, both at A_DOT x K_REAL (1.0: loading a family does not
// brighten it); the diameter grows with MARKET CAP, not rank (1 device px at the curve floor, ~1.5x it = MC_FLOOR, up to 2
// CSS px on a log scale at MC_FLOOR x MC_SPAN), capped at 0.5 max(sigma, SIG_MIN). The ghost -> real crossfade is 300 ms. Visibility = the family's drawn members: planets x uFadeP, dust
// families x uFadeD x uDustExpand (flat), hover dim, focus dim (flat 0.42); a ghost dims to TOK.dim under any highlight (it
// has no data), a real speck by its own match. Labels: labels.js hands over the rects of the planet / child / gen labels
// (and the pinned name) placed over a ghosted family (setMask, world units, <= LAB_MAX); a speck inside one is hidden, with
// a LAB_PAD_PX soft edge, so no dot sits between the words of '$PUMP 6.3% · 79.9k coins'. A hovered / selected speck wears
// a 1 px ring, a focused one the lime pulse (uFocusCoin), and neither is thinned nor masked.
//
// DRAG: every slot is anchored to its nearest drawn member (swarm-slots anchor, by edge distance) and drawn at its build
// position plus that member's displacement from the positions at build (the anchor rows of the family texture: half an
// RGBA texel per member of a ghosted family, rewritten on every "positions" event for the families that moved). The grain
// trails with its chain: dragging the top moves the slots near it at once and the rest with the children they sit by;
// nothing pushes, nothing springs back that the drawn coins do not.
import * as THREE from "three";
import { TOK, GAL, heatClass } from "./tokens.js";
import { createSlotBuilder, fnv1a, strideOf, rankCut, thinRank, buildPointGrid, nearestInGrid, slotsHash, countInDiscs } from "./swarm-slots.js";

export const DUST0 = 4194304;

// ---- look constants (§2 + the fix round; the lane reports any retune, LANES.md "family-all") ----
// (fix round) the doc's density-normalised alpha (A_GHOST / C_MAX, then the 0.06 + EDGE feather retune) is gone: below
// ~1.5 device px of spacing it blended into a grey veil. Separate dots at a fixed alpha, thinned by zoom (see LOOK).
const A_DOT = 0.42;        // alpha of one shown ghost (a cold coin's dot is ~0.35-0.45 of its rim over the ground)
const SIG_MIN = [2.5, 1.5];   // the shown dots' minimum spacing: max(2.5 device px, 1.5 CSS px)
const GHOST_D_DEV = 1.0;   // ghost diameter, device px
const A_REAL = 0.55;       // alpha of a live / cooling real speck
const K_REAL = 1.0;        // a quiet / cold real speck's alpha relative to a ghost's (1.0: loading does not brighten a family)
const MC_FLOOR = 4500, MC_SPAN = 100;   // real speck size: 1 device px up to MC_FLOOR (~1.5x the curve floor), 2 CSS px at x MC_SPAN (log)
const LAB_MAX = 24, LAB_PAD_PX = 4;   // label rects the specks keep out of, and their soft edge (CSS px)
// ---- field constants ----
const CLEAR = 0.3;         // u, hard clearance around every drawn member's disc (the acceptance ramps 0 -> 1 outside it)
const RAMP = 2;            // the ramp width in slot spacings (swarm-slots caps it at a third of the member spacing)
const R1_FRAC = 0.97;      // the field never passes 0.97 f.Rc (inside today's disc); swarm-slots fits it to the drawn extent
const SPARE_MAX = 512, SPARE_FRAC = 0.02;   // extra slots for coins the index adds after the map payload
// ---- timing ----
const GEN_SLICE_MS = 8, GEN_SLACK_MS = 3, ADD_SLICE_MS = 4, ADD_SLACK_MS = 2, FADE_MS = 400, XFADE_S = 0.3, HL_S = 0.16;
const WANT_MS = 300, WANT_SETTLE_MS = 120, WANT_R = 0.22, WANT_COVER = 0.25;
const PICK_SIGMA_PX = 3;   // a real speck is a pick target only when the slot spacing is >= 3 CSS px on screen
// ---- tiers (§2 table; the store has its own family / row limits) ----
const TIERS = {
  desktop: { ghostFam: Infinity, ghostTotal: Infinity, realFam: 100000, realTotal: Infinity },
  phone: { ghostFam: 5000, ghostTotal: Infinity, realFam: 20000, realTotal: Infinity },
  software: { ghostFam: 3000, ghostTotal: 30000, realFam: 20000, realTotal: 40000 },
};
const FOCUS_DIM = 0.42;    // bubbles.js flat: other families at full focus

const f3 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const nowMs = () => performance.now();

function stubSwarm(on) {
  const none = () => null;
  return {
    on, DUST0, isDust: (i) => i >= DUST0, add: () => 0, drop: () => {}, families: () => [], indexOf: () => -1, mintAt: none, pos: none,
    famOf: none, screenR: () => 0, spacing: () => 0, tip: none, pick: () => -1, select: () => {}, trade: () => 0, setHl: () => {},
    ghosted: () => false, setMask: () => {}, setVis: () => {}, setPins: () => {}, isShown: () => false,
    stats: () => ({ tier: "desktop", families: 0, slots: 0, ghostVisible: 0, real: 0, queued: 0, genMs: 0, genSliceMaxMs: 0, addSliceMaxMs: 0, overlaps: 0, drops: 0, byFamily: [] }),
  };
}

export function buildSwarm(S) {
  if (S.opts && S.opts.swarm === false) {
    S.swarm = stubSwarm(false);
    S.debugFns.swarm = () => ({ ...S.swarm.stats(), off: true });
    S.debugFns.swarmCheck = () => ({ outside: 0, onDrawn: 0, overlaps: 0, hash: 0, slots: 0, off: true });
    S.debugFns.swarmSynth = () => 0;
    return;
  }
  const { fams, X, Y, R, U } = S;
  const G = S.look === "galaxy", T = S.tok || TOK;
  const scene = S.gfx.scene;
  const gpu = String(S.gfx.gpu || "");
  const tier = /swiftshader|llvmpipe/i.test(gpu) ? "software" : S.phone() ? "phone" : "desktop";
  const TI = TIERS[tier];

  // ---------- the ghosted families (data.js f.ghost: asset tops only) ----------
  const list = [];
  const sfOfFam = new Int32Array(fams.length).fill(-1);
  const byTop = new Map();
  const Xb = Float32Array.from(X), Yb = Float32Array.from(Y);   // positions at build: the drag displacements are measured from here
  let M = 0, NA = 1;   // slots; anchor texels (texel 0 = no member, never displaced)
  for (const f of fams) {
    const ghost = f.ghost | 0;
    if (!(ghost > 0)) continue;
    const top = f.top, spare = Math.min(SPARE_MAX, Math.ceil(SPARE_FRAC * ghost));
    const n = Math.max(0, Math.min(ghost + spare, TI.realFam));
    if (!(n > 0)) continue;
    // the field starts at the edge of the top's disc around the centre (the top is a member: its disc + CLEAR is off limits
    // and the acceptance ramps up outside it) and never passes 0.97 Rc; swarm-slots fits the outer radius to the drawn extent
    const dTop = Math.hypot(Xb[top] - f.cx, Yb[top] - f.cy);
    const r0 = Math.max(0, R[top] - dTop), r1 = Math.max(r0 + 0.5, R1_FRAC * f.Rc);
    const mem = Int32Array.from(f.members);
    const sf = {
      id: list.length, f, top, topMint: S.mint[top], ghost, n, base: M, r0, r1, seed: fnv1a(S.mint[top]),
      cx: f.cx, cy: f.cy, mem, ancBase: NA, dispAny: false, dispV: 0, anchor: null,
      ghostSlots: Math.min(ghost, n), ghostCap: TI.ghostFam, tau: 1, ghostShown: 0, spacing: 0, spacingMean: 0, p: 1, overlaps: 0, built: false, x: null, y: null,
      cap: TI.realFam, real: 0, realOnGhost: 0, next: 0, ht: null, hmask: 0, mints: null, sym: null, mc: null, lk: null, crt: null, lastT: null,
      shownReal: 0,   // (last-trade filter) loaded real specks the filter draws (their alpha target > 0)
      grid: null, gridAt: 0, gridV: -1, drops: 0, genMs: 0, r95: 0,
    };
    list.push(sf); sfOfFam[f.id] = sf.id; byTop.set(sf.topMint, sf);
    M += n; NA += mem.length;
  }
  // visible ghost caps (phone / software): per family, then the software total; each family shows the ghosts whose
  // thinning rank is under its rank cut tau (a hash subsample: no spokes, the same grain as the full set)
  {
    let tot = 0;
    for (const sf of list) { sf.ghostCap = Math.min(sf.ghostSlots, TI.ghostFam); tot += sf.ghostCap; }
    const sc = tot > TI.ghostTotal ? TI.ghostTotal / tot : 1;
    for (const sf of list) if (sc < 1) sf.ghostCap = Math.max(1, Math.floor(sf.ghostCap * sc));   // tau: writeFamily (rankCut is O(ghosts), off the build)
  }
  const nSF = list.length;
  S.ghostSlots = M;

  // ---------- the family texture (one RGBA float texture, TW wide; the layer adds exactly one texture):
  // family rows: texel (x, 2 row) = centre at build, engine family id, kind; texel (x, 2 row + 1) = densest slot spacing (u),
  // ghost rank cut tau, ghost slots, field radius. Anchor rows from FH on: two members per texel (xy, zw) = each member's
  // drag displacement from its position at build ----------
  const TW = 1024, FH = 2 * Math.max(1, Math.ceil(nSF / TW)), AH = Math.max(1, Math.ceil(Math.ceil(NA / 2) / TW)), TH = FH + AH;
  const texData = new Float32Array(TW * TH * 4);
  const tex = new THREE.DataTexture(texData, TW, TH, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter; tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.flipY = false;
  const texAt = (id, row) => (((Math.floor(id / TW) * 2 + row) * TW) + (id % TW)) * 4;
  const ancAt = (a) => FH * TW * 4 + (a >> 1) * 4 + (a & 1) * 2;   // float offset of anchor a's displacement
  const writeTex = (sf) => {
    const a = texAt(sf.id, 0), b = texAt(sf.id, 1);
    texData[a] = sf.cx; texData[a + 1] = sf.cy; texData[a + 2] = sf.f.id; texData[a + 3] = sf.f.planet ? 0 : 1;
    texData[b] = sf.spacing; texData[b + 1] = sf.tau; texData[b + 2] = sf.ghostSlots; texData[b + 3] = sf.r1;
  };
  for (const sf of list) writeTex(sf);
  tex.needsUpdate = true;

  // ---------- material ----------
  const sigMin0 = () => Math.max(SIG_MIN[0], SIG_MIN[1] * (S.DPR || 1));
  const uSwK = { value: new THREE.Vector4(A_DOT, sigMin0(), A_REAL, K_REAL) };   // the look knobs (debug: swarmTune)
  let sigMinTuned = false;
  // (last-trade filter) the Key's mask (vis.js, motion.js keeps it) and the speck mints drawn whatever their class
  let vMask = S.vis ? S.vis.mask : 15, vPins = new Set(S.vis && Array.isArray(S.vis.pinMints) ? S.vis.pinMints : []);
  // ghost alpha (shown when the crossfade started, target): 0 while bit 3 is off, TOK.dim under a highlight, else 1
  const ghostA0 = (vMask & 8) ? 1 : 0;
  const uSwFade = { value: 0 }, uSwHlA = { value: ghostA0 }, uSwHlB = { value: ghostA0 }, uSwHlT0 = { value: -1e4 }, uSwSel = { value: -1 };
  const uSwLab = { value: Array.from({ length: LAB_MAX }, () => new THREE.Vector4(0, 0, 0, 0)) }, uSwLabN = { value: 0 }, uSwLabPad = { value: 1 };
  U.uFocusCoin ??= { value: -1 }; U.uFocusT ??= { value: 0 }; U.uFocusDim ??= { value: 0 };
  const heatK = (T.heatK || GAL.heatK).slice();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...U,
      ...(U.uAnimT ? {} : { uAnimT: { value: 0 } }),
      uSwTex: { value: tex }, uSwW: { value: TW }, uSwFH: { value: FH },
      uSwFade, uSwHlA, uSwHlB, uSwHlT0, uSwSel, uSwK, uSwLab, uSwLabN, uSwLabPad,
      uRim: { value: T.rim.map((h) => new THREE.Color(h)) }, uHeatK: { value: heatK },
      uMuted: { value: new THREE.Color(TOK.muted) }, uPulse: { value: new THREE.Color(TOK.pulse) },
      uFocusCol: { value: new THREE.Color(0xb6ff5c) }, uRingCol: { value: new THREE.Color(TOK.hover) }, uDim: { value: TOK.dim },
    },
    vertexShader: /* glsl */`
uniform float uPx, uDpr, uTime, uDustExpand, uHoverFam, uDimMix, uFadeP, uFadeD, uFocusFam, uFocusMix, uFocusCoin, uFocusT, uFocusDim, uHover, uHoverT, uAnimT;
uniform sampler2D uSwTex; uniform int uSwW, uSwFH;
uniform float uSwFade, uSwHlA, uSwHlB, uSwHlT0, uSwSel, uDim;
uniform vec4 uSwK;   // A_DOT, SIG_MIN (device px), A_REAL, K_REAL
uniform vec4 uSwLab[${LAB_MAX}]; uniform int uSwLabN; uniform float uSwLabPad;   // label rects (world), their soft edge (world)
uniform vec3 uRim[4], uMuted, uPulse, uFocusCol, uRingCol; uniform float uHeatK[4];
attribute vec4 aS;   // swarm family index, slot j in the family, thinning rank [0, 1), anchor texel
attribute vec4 aR;   // real (0 ghost, 1 real), crossfade start (s, uTime clock), heat class, size t (0 floor .. 1 = 2 CSS px)
attribute vec3 aF;   // trade flash start (s), alpha (shown when the crossfade started, target): 0 hidden by the Key, TOK.dim, 1
varying vec3 vCol, vRingC; varying float vA, vRad, vAdd, vSize, vRingR, vRingW, vRingA;
const float DUST0 = ${f3(DUST0)};
// the zoom share qz shows every rank under qz fully and fades ranks qz .. 1.25 qz in (no pop); past the cap all are full
float thin(float rk, float qz) { return clamp((1.25 * qz - rk) / max(0.25 * qz, 1e-6), 0.0, 1.0); }
void main(){
  int fi = int(aS.x + 0.5), row = fi / uSwW;
  ivec2 tc = ivec2(fi - row * uSwW, row * 2);
  vec4 F0 = texelFetch(uSwTex, tc, 0);
  vec4 F1 = texelFetch(uSwTex, tc + ivec2(0, 1), 0);
  int ai = int(aS.w + 0.5), at = ai / 2, ar = at / uSwW;
  vec4 AD = texelFetch(uSwTex, ivec2(at - ar * uSwW, uSwFH + ar), 0);
  vec2 wp = F0.xy + position.xy + (ai - at * 2 == 0 ? AD.xy : AD.zw);   // + the anchor member's drag displacement
  float sig = max(F1.x * uPx, 1e-4);                       // the densest slot spacing, device px
  float qz = sig / uSwK.y; qz *= qz;                         // the zoom's share: shown dots never closer than SIG_MIN
  float rk = aS.z, gi = float(gl_VertexID);
  float xr = smoothstep(aR.y, aR.y + ${f3(XFADE_S)}, uTime);
  float real = aR.x > 0.5 ? xr : 1.0 - xr;
  int cls = int(aR.z + 0.5);
  // ghost: j < ghost slots and rank < tau (the tier cap), thinned by zoom; a 1 device px dot at a fixed alpha
  float aG = aS.y < F1.z && rk < F1.y ? uSwK.x * thin(rk, qz) : 0.0;
  float dG = ${f3(GHOST_D_DEV)};
  // real speck: live / cooling are never thinned (few, and they carry the heat); size by market cap, capped at half the
  // shown spacing (the coins with real market cap are drawn bubbles already: the server keeps the biggest of every family)
  float keepR = cls <= 1 ? 1.0 : thin(rk, qz);
  float dR = clamp(mix(${f3(GHOST_D_DEV)}, 2.0 * uDpr, aR.w), 1.0, max(1.0, 0.5 * max(sig, uSwK.y)));
  float aRl = (cls <= 1 ? uSwK.z : uSwK.x * uSwK.w) * keepR;
  float dDev = mix(dG, dR, real);
  float a = mix(aG, aRl, real);
  // visibility mirrors the family's drawn members
#ifdef GALAXY
  float vis = uSwFade * (F0.w > 0.5 ? uFadeD : uFadeP);
#else
  float vis = uSwFade * (F0.w > 0.5 ? uFadeD * uDustExpand : uFadeP);
#endif
  if (uHoverFam > -0.5 && abs(F0.z - uHoverFam) > 0.5) vis *= mix(1.0, uDim, uDimMix);
#ifndef GALAXY
  if (uFocusFam > -0.5 && abs(F0.z - uFocusFam) > 0.5 && abs(F0.z - uHoverFam) > 0.5) vis *= mix(1.0, ${f3(FOCUS_DIM)}, uFocusMix);
#endif
  float isF = abs(uFocusCoin - DUST0 - gi) < 0.5 ? 1.0 : 0.0;
#ifdef GALAXY
  vis *= isF > 0.5 ? 1.0 : 1.0 - 0.6 * uFocusDim;
#endif
  // highlight + (last-trade filter) visibility: alpha factors (a ghost: uSwHlA -> B, a real speck: its own aF.y -> z)
  float hlT = smoothstep(uSwHlT0, uSwHlT0 + ${f3(HL_S)}, uTime);
  vis *= mix(mix(uSwHlA, uSwHlB, hlT), mix(aF.y, aF.z, hlT), real);
  // labels placed over the family: no speck between their words (a soft edge of uSwLabPad)
  float lm = 1.0;
  for (int q = 0; q < ${LAB_MAX}; q++) {
    if (q >= uSwLabN) break;
    vec4 b = uSwLab[q];
    vec2 dd = max(max(b.xy - wp, wp - b.zw), 0.0);
    lm = min(lm, smoothstep(0.0, uSwLabPad, length(dd)));
  }
  a *= vis * lm;
  // colour: ghosts and cold specks one step under a drawn cold coin; live / cooling keep their heat colour
#ifdef GALAXY
  vec3 cG = uRim[3] * (0.9 * uHeatK[3]);
  vec3 cR = min(uRim[cls] * (0.9 * uHeatK[cls]), vec3(0.84));
#else
  vec3 cG = uRim[3];
  vec3 cR = cls == 2 ? mix(uRim[2], uMuted, 0.5) : uRim[cls];
#endif
  vec3 col = mix(cG, cR, real);
  float add = real > 0.5 && cls == 0 ? 1.0 : 0.0;
  // trade flash (dust.js flashDust): brighter toward the pulse colour, +1.5 px, a 1 CSS px ring 2.5 -> 6.5 px, 380 ms
  float ft = uTime - aF.x, ringR = 0.0, ringW = 0.5 * uDpr, ringA = 0.0; vec3 ringC = min(uPulse, vec3(0.9));
  if (real > 0.5 && ft >= 0.0 && ft < 0.38) {
    float u = ft / 0.38, iu = 1.0 - u, fl = iu * iu;
    ringR = mix(2.5, 6.5, 1.0 - iu * iu * iu) * uDpr;
    ringA = 0.55 * pow(iu, 1.5) * vis;
    a = mix(a, 0.9 * vis, fl); col = mix(col, uPulse, 0.85 * fl); dDev += 1.5 * fl * uDpr; add = 0.0;
  }
  if (real > 0.5 && ft >= 0.38) { float ag = exp(-(ft - 0.38) / 16.0); a = mix(a, max(a, 0.6 * vis), 0.7 * ag); dDev += 0.6 * ag * uDpr; }
  // hover / selected: a 1 px ring; focused (uFocusCoin): the lime pulse ring, focus.js timing (never thinned, never masked)
  float hv = abs(uHover - DUST0 - gi) < 0.5 ? uHoverT : 0.0, sl = abs(uSwSel - gi) < 0.5 ? 1.0 : 0.0;
  float rh = max(hv, sl) * ${f3(TOK.hoverA)} * max(vis, 0.6);
  if (rh > ringA) { ringR = 0.5 * dDev + 2.5 * uDpr; ringW = 0.5 * uDpr; ringA = rh; ringC = uRingCol; }
  if (isF > 0.5 && uFocusT > 0.0) {
    float pul = 1.5 * sin(6.28318530718 * 1.6 * uAnimT);
    ringR = 0.5 * dDev + (6.5 + pul) * uDpr; ringW = 2.5 * uDpr; ringA = uFocusT; ringC = uFocusCol; a = max(a, 0.9 * uFocusT);
  }
  if (hv > 0.0 || sl > 0.0 || isF > 0.5) { a = max(a, 0.85 * max(vis, 0.6) * max(max(hv, sl), isF * uFocusT)); dDev = max(dDev, 2.0 * uDpr); add = 0.0; }
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 0.0, 1.0);
  gl_PointSize = ringA > 0.0 ? max(dDev + 2.0, 2.0 * (ringR + ringW + uDpr) + 2.0) : dDev + 2.0;
  vSize = gl_PointSize; vRad = 0.5 * dDev; vCol = col; vA = a; vAdd = add;
  vRingR = ringR; vRingW = ringW; vRingA = ringA; vRingC = ringC;
  if (max(a, ringA) < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`,
    fragmentShader: /* glsl */`
varying vec3 vCol, vRingC; varying float vA, vRad, vAdd, vSize, vRingR, vRingW, vRingA;
void main(){
  float d = length(gl_PointCoord - 0.5) * vSize;                              // device px from the centre
  float a = vA * clamp((vRad - d) / 0.75 + 0.5, 0.0, 1.0);                    // 0.75 device px feather
  float ring = vRingA > 0.0 ? vRingA * clamp(vRingW + 0.5 - abs(d - vRingR), 0.0, 1.0) : 0.0;
  if (a < 0.002 && ring < 0.002) discard;
  if (ring > 0.0) { float o = a + ring * (1.0 - a); gl_FragColor = vec4(vCol * a + vRingC * ring * (1.0 - a), o); return; }
  gl_FragColor = vec4(vCol * a, vAdd > 0.5 ? 0.0 : a);                       // live: additive, rest: premultiplied over
}`,
    transparent: true, depthTest: false, depthWrite: false, defines: G ? { GALAXY: 1 } : {},
  });
  mat.blending = THREE.CustomBlending; mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  // SIG_MIN follows the DPR (a window moved to another screen) unless a QA tune pinned it
  S.on("resize", () => { if (!sigMinTuned) uSwK.value.y = sigMin0(); });

  // a one-vertex placeholder with the real layout: the program compiles with the scene (index.js compileAsync); the
  // generated geometry replaces it after the first frame
  const mkGeo = (pos, aS, aR, aF, index) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 2));
    g.setAttribute("aS", new THREE.BufferAttribute(aS, 4));
    const r = new THREE.BufferAttribute(aR, 4); r.setUsage(THREE.DynamicDrawUsage); g.setAttribute("aR", r);
    const fl = new THREE.BufferAttribute(aF, 3); fl.setUsage(THREE.DynamicDrawUsage); g.setAttribute("aF", fl);
    const ix = new THREE.BufferAttribute(index, 1); ix.setUsage(THREE.DynamicDrawUsage); g.setIndex(ix);
    // positions are 2-component and relative (the shader adds the family centre): three's bounds would read NaN z, and the
    // layer is never culled anyway; the renderer only needs a centre for its transparent sort (z = 0 like every layer)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e7);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e7, -1e7, -1), new THREE.Vector3(1e7, 1e7, 1));
    return g;
  };
  let geo = mkGeo(new Float32Array(2), new Float32Array(4), new Float32Array([0, -1e4, 3, 0]), new Float32Array([-1e4, 1, 1]), new Uint32Array(1));
  geo.setDrawRange(0, 0);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; points.renderOrder = 1;
  scene.add(points);
  S.life.onDispose(() => { scene.remove(points); if (!S.contextLost) { try { geo.dispose(); mat.dispose(); tex.dispose(); } catch { /* ignore */ } } });

  // ---------- generated arrays (after the first frame) ----------
  let posA = null, aS = null, aR = null, aF = null, index = null, inIdx = null, idxN = 0;
  let attrR = null, attrF = null, attrI = null;
  const ranges = { r: [Infinity, -1], f: [Infinity, -1], i: [Infinity, -1] };
  const touch = (key, g) => { const rr = ranges[key]; if (g < rr[0]) rr[0] = g; if (g > rr[1]) rr[1] = g; };
  const flush = () => {
    if (!attrR) return;
    const up = (attr, rr, w) => {
      if (rr[1] < rr[0]) return;
      if (attr.updateRanges.length < 64) attr.addUpdateRange(rr[0] * w, (rr[1] - rr[0] + 1) * w); else attr.clearUpdateRanges();
      attr.needsUpdate = true; rr[0] = Infinity; rr[1] = -1;
    };
    up(attrR, ranges.r, 4); up(attrF, ranges.f, 3); up(attrI, ranges.i, 1);
    geo.setDrawRange(0, idxN);
    S.invalidate();
  };
  const pushIdx = (g) => { if (inIdx[g]) return; inIdx[g] = 1; index[idxN] = g; touch("i", idxN); idxN++; };
  const ghostShownAt = (sf, j) => j < sf.ghostSlots && aS[(sf.base + j) * 4 + 2] < sf.tau;

  // ---------- state ----------
  let genState = "wait";   // wait | run | done
  let genQ = 0, builder = null, genT0 = 0, genMs = 0, genWallMs = 0, genSliceMax = 0, addSliceMax = 0, fadeT0 = -1;
  let totalReal = 0, drops = 0, overlaps = 0, animUntil = 0, hlTest = null, drainMax = 0, jobMax = 0;
  const sliceLog = [];   // drain slice durations (ms), for the p95 next to the max
  const slowLog = [];    // slices over 4 ms: rows filled and the allocation time in them
  const queue = [];   // {sf, chunk, r}
  const jobs = [];    // heat / highlight passes over the real specks: {kind, sf list, q, j, t}
  const tSec = () => U.uTime.value || nowMs() / 1000;
  const reduced = () => !!(S.motion && S.motion.reduced);

  function startGen() {
    if (genState !== "wait" || S.dead) return;
    genState = "run"; genT0 = nowMs();
    posA = new Float32Array(Math.max(1, M) * 2); aS = new Float32Array(Math.max(1, M) * 4);
    aR = new Float32Array(Math.max(1, M) * 4); aF = new Float32Array(Math.max(1, M) * 3);
    for (let g = 0; g < M; g++) { aR[g * 4 + 1] = -1e4; aR[g * 4 + 2] = 3; aF[g * 3] = -1e4; aF[g * 3 + 1] = 1; aF[g * 3 + 2] = 1; }
    index = new Uint32Array(Math.max(1, M)); inIdx = new Uint8Array(Math.max(1, M));
    S.life.timeout(genSlice, 0);
  }
  function genSlice() {
    if (S.dead || genState !== "run") return;
    // (fix round) the deadline leaves GEN_SLACK_MS for the work unit that crosses it (the setup of a family, a 64-candidate
    // batch) and the family's write-out: slices stayed at 8.0-8.5 ms with a 1.5 ms slack
    const t = nowMs(), dl = t + GEN_SLICE_MS - GEN_SLACK_MS;
    while (genQ < nSF) {
      const sf = list[genQ];
      if (!builder) {
        const members = [];
        for (const i of sf.mem) members.push({ x: Xb[i], y: Yb[i], r: R[i] });
        builder = createSlotBuilder({ cx: sf.cx, cy: sf.cy, r0: sf.r0, r1: sf.r1, n: sf.n, seed: sf.seed, members, clear: CLEAR, ramp: RAMP });
      }
      const done = builder.step(dl);
      if (done) { writeFamily(sf, builder.result()); builder = null; genQ++; }
      if (nowMs() >= dl) break;
    }
    const d = nowMs() - t; genMs += d; if (d > genSliceMax) genSliceMax = d;
    if (genQ < nSF) S.life.timeout(genSlice, 0); else finishGen();
  }
  function writeFamily(sf, res) {
    sf.x = res.x; sf.y = res.y; sf.anchor = res.anchor; sf.spacing = res.spacing; sf.spacingMean = res.spacingMean; sf.p = res.p;
    sf.overlaps = res.overlaps; sf.genMs = res.ms; sf.r1 = res.r1; sf.r95 = res.r95; overlaps += res.overlaps;
    const b = sf.base;
    sf.tau = rankCut(sf.seed, sf.ghostSlots, sf.ghostCap);
    let shown = 0;
    for (let j = 0; j < sf.n; j++) {
      const g = b + j, a = res.anchor[j], rk = thinRank(sf.seed, j);
      posA[g * 2] = res.x[j]; posA[g * 2 + 1] = res.y[j];
      aS[g * 4] = sf.id; aS[g * 4 + 1] = j; aS[g * 4 + 2] = rk; aS[g * 4 + 3] = a >= 0 ? sf.ancBase + a : 0;
      if (j < sf.ghostSlots && rk < sf.tau) { inIdx[g] = 1; index[idxN++] = g; shown++; }
    }
    sf.ghostShown = shown;
    sf.built = true;
    writeTex(sf);
  }
  function finishGen() {
    genState = "done"; genWallMs = nowMs() - genT0;
    const old = geo;
    geo = mkGeo(posA, aS, aR, aF, index);
    attrR = geo.getAttribute("aR"); attrF = geo.getAttribute("aF"); attrI = geo.index;
    geo.setDrawRange(0, idxN);
    points.geometry = geo;
    if (!S.contextLost) old.dispose();
    tex.needsUpdate = true;
    // a drag during generation: the anchors start where their members are now
    let any = false; for (const sf of list) if (syncAnchors(sf)) any = true;
    if (any) tex.needsUpdate = true;
    fadeT0 = reduced() ? -1 : nowMs(); uSwFade.value = reduced() ? 1 : 0;
    if (hlTest) setHl(hlTest);   // a highlight set before the slots existed: ghosts dim now
    S.debug.map.swarm = { tier, families: nSF, slots: M, ghostShown: idxN, genMs: Math.round(genMs), genWallMs: Math.round(genWallMs), genSliceMaxMs: +genSliceMax.toFixed(2), overlaps };
    evalWant(nowMs(), true);
    S.invalidate();
  }

  // ---------- drag: every member's displacement from the build (the anchor texture) ----------
  function syncAnchors(sf) {
    const mem = sf.mem, base = sf.ancBase;
    let changed = false, anyD = false;
    for (let q = 0; q < mem.length; q++) {
      const i = mem[q], dx = X[i] - Xb[i], dy = Y[i] - Yb[i], t = ancAt(base + q);
      if (texData[t] !== dx || texData[t + 1] !== dy) { texData[t] = dx; texData[t + 1] = dy; changed = true; }
      if (dx !== 0 || dy !== 0) anyD = true;
    }
    if (changed) { sf.dispV++; sf.dispAny = anyD; }
    return changed;
  }
  S.on("positions", (P) => {
    let any = false;
    if (P && P.fams && P.nFams > 0 && !P.committed) {
      for (let q = 0; q < P.nFams; q++) { const id = P.fams[q], s = id >= 0 && id < sfOfFam.length ? sfOfFam[id] : -1; if (s >= 0 && syncAnchors(list[s])) any = true; }
    } else for (const sf of list) if (syncAnchors(sf)) any = true;
    if (any) { tex.needsUpdate = true; S.invalidate(); }
  });
  // a slot's displacement now (its anchor member's), world u
  const dispOf = (sf, j) => {
    const a = sf.anchor ? sf.anchor[j] : -1; if (!(a >= 0)) return [0, 0];
    const t = ancAt(sf.ancBase + a); return [texData[t], texData[t + 1]];
  };

  // ---------- real specks ----------
  const ensureData = (sf) => {
    if (sf.mints) return;
    // mints / tickers: packed arrays of the slot count up front (fix round: growing them by push copied 64k-element arrays
    // inside the 4 ms drain slices); the numbers are typed arrays of the slot count
    sf.mints = Array(sf.n).fill(null); sf.sym = Array(sf.n).fill(null);
    // mint -> slot: an open-addressing table sized for every slot up front (a Map growing to 76k entries rehashed in
    // multi-ms steps inside the 4 ms slices)
    let size = 1024; while (size < 2 * sf.n) size <<= 1;
    sf.ht = new Int32Array(size).fill(-1); sf.hmask = size - 1;
    sf.mc = new Float64Array(sf.n); sf.lk = new Float64Array(sf.n); sf.crt = new Float64Array(sf.n); sf.lastT = new Float64Array(sf.n).fill(-Infinity);
  };
  const strHash = (m) => { let h = 0x811c9dc5; for (let q = 0; q < m.length; q++) { h ^= m.charCodeAt(q); h = Math.imul(h, 0x01000193); } return h >>> 0; };
  const htGet = (sf, m) => {
    if (!sf.ht) return -1;
    for (let q = strHash(m) & sf.hmask; ; q = (q + 1) & sf.hmask) { const j = sf.ht[q]; if (j < 0) return -1; if (sf.mints[j] === m) return j; }
  };
  const htSet = (sf, m, j) => { let q = strHash(m) & sf.hmask; while (sf.ht[q] >= 0) q = (q + 1) & sf.hmask; sf.ht[q] = j; };
  const heatOf = (m) => {
    const h = S.heatIdx ? S.heatIdx.get(m) : undefined;
    if (h === undefined || !S.heat) return -Infinity;
    const v = Number(S.heat.last[h]); return Number.isFinite(v) ? v : -Infinity;
  };
  const clsOf = (last) => heatClass(last > -Infinity ? Math.max(0, (S.nowS || Date.now() / 1000) - last) : Infinity);
  const hlOf = (m) => { if (!hlTest) return 1; try { return hlTest(m) ? 1 : 0; } catch { return 0; } };
  // (last-trade filter) a real speck's alpha: 0 when the Key hides its class (and it is not pinned), else the highlight's
  // 1 / TOK.dim; ghosts are class 3. Float32 targets (aF) compare against Math.fround
  const alphaOf = (m, c) => (((vMask >> (c >= 0 && c <= 3 ? c : 3)) & 1) || vPins.has(m) ? (hlOf(m) ? 1 : TOK.dim) : 0);
  const ghostTarget = () => ((vMask & 8) ? (hlTest ? TOK.dim : 1) : 0);
  // a speck's alpha target changed between hidden and drawn: the family's count; crossing 0 tells motion (the top anchors it)
  const countShown = (sf, was, now) => {
    if ((was > 0) === (now > 0)) return;
    sf.shownReal += now > 0 ? 1 : -1;
    if (sf.shownReal === (now > 0 ? 1 : 0)) { try { S.motion.visSpeck?.(sf.f.id, sf.shownReal > 0); } catch (e) { console.error("map3", e); } }
  };
  // specks' alpha targets changed (a filter / highlight pass, a heat class, a pin, a trade): a hovered speck the filter now
  // hides (the pointer's tip, the phone's docked card) loses the hover (motion.js decides; a page hover is pinned, drawn)
  const hoverCheck = () => { if (S.hoverI >= DUST0) { try { S.motion.dropHiddenHover?.(); } catch (e) { console.error("map3", e); } } };
  // one speck's alpha at once (no crossfade): a trade, a heat class change, a pin
  const snapAlpha = (sf, g, m, c) => {
    const a = Math.fround(alphaOf(m, c)), was = aF[g * 3 + 2];
    if (was === a && aF[g * 3 + 1] === a) return false;
    aF[g * 3 + 1] = a; aF[g * 3 + 2] = a; touch("f", g); countShown(sf, was, a);
    return true;
  };
  // (fix round) size by MARKET CAP, not by rank: ~99 % of a family sits at the curve floor, rank sizes invented differences
  // and brightened the family core. t = 0 up to MC_FLOOR, 1 at MC_FLOOR x MC_SPAN (log); the shader maps t to 1 device px .. 2 CSS px
  const LOG_SPAN = Math.log(MC_SPAN);
  const compactLookup = S.opts && S.opts.compact && typeof S.opts.compact.lookup === "function" ? S.opts.compact.lookup : null;
  const sizeT = (mc) => (mc > MC_FLOOR ? Math.min(1, Math.log(mc / MC_FLOOR) / LOG_SPAN) : 0);
  function fillRow(sf, ch, r, t) {
    const m = ch.mints[r];
    if (typeof m !== "string" || !m) return;
    if (S.mintIdx && S.mintIdx.has(m)) return;            // the engine draws it already
    // (compact layout) a page coin the filtered build left out is never a speck (it would take a ghost's slot): it is added
    // as a coin when it comes into view (motion.js reveal)
    if (compactLookup) { let n = null; try { n = compactLookup(m); } catch { n = null; } if (n) return; }
    let j = htGet(sf, m);
    const mc = Number(ch.mcapUsd && ch.mcapUsd[r]) || 0;
    if (j < 0) {
      if (sf.next >= sf.n || sf.real >= sf.cap || totalReal >= TI.realTotal) { sf.drops++; drops++; return; }
      j = sf.next++;
      sf.mints[j] = m; htSet(sf, m, j);
      sf.real++; totalReal++;
      const g = sf.base + j;
      const last = heatOf(m);
      sf.lastT[j] = last;
      aR[g * 4] = 1; aR[g * 4 + 1] = t; aR[g * 4 + 2] = clsOf(last); aR[g * 4 + 3] = sizeT(mc);
      const h = Math.fround(alphaOf(m, aR[g * 4 + 2])); aF[g * 3 + 1] = h; aF[g * 3 + 2] = h; countShown(sf, 0, h);   // (last-trade filter)
      touch("r", g); touch("f", g);
      if (ghostShownAt(sf, j)) sf.realOnGhost++; else pushIdx(g);
      sf.grid = null;
    } else {
      const g = sf.base + j, st = sizeT(mc);
      if (aR[g * 4 + 3] !== st) { aR[g * 4 + 3] = st; touch("r", g); }
    }
    sf.sym[j] = ch.symbols ? ch.symbols[r] ?? null : null;
    sf.mc[j] = mc; sf.lk[j] = Number(ch.lockedUsd && ch.lockedUsd[r]) || 0; sf.crt[j] = Number(ch.createdAt && ch.createdAt[r]) || 0;
  }
  function drainQueue() {
    if (!queue.length || genState !== "done") return false;
    const t0 = nowMs(), dl = t0 + ADD_SLICE_MS - ADD_SLACK_MS, ts = reduced() ? -1e4 : tSec();
    let n = 0, allocMs = 0;
    while (queue.length) {
      const q = queue[0], ch = q.chunk, end = Math.min(ch.n, ch.mints.length);
      // a family's first rows: its arrays are allocated in a slice of their own (~1 ms for 76k slots)
      if (!q.sf.mints) { const ta = nowMs(); ensureData(q.sf); allocMs += nowMs() - ta; if (n > 0 || nowMs() - t0 > 0.5) break; }
      while (q.r < end) { fillRow(q.sf, ch, q.r++, ts); if ((++n & 15) === 0 && nowMs() > dl) break; }
      if (q.r >= end) queue.shift();
      if (nowMs() > dl) break;
    }
    flush();
    animUntil = Math.max(animUntil, nowMs() + XFADE_S * 1000 + 50);
    const d = nowMs() - t0; if (d > addSliceMax) addSliceMax = d; if (d > drainMax) drainMax = d;
    if (sliceLog.length < 4096) sliceLog.push(+d.toFixed(2));
    if (d > 4 && slowLog.length < 32) slowLog.push({ ms: +d.toFixed(2), rows: n, alloc: allocMs });
    return true;
  }
  function add(chunk) {
    if (!chunk || typeof chunk.top !== "string" || !Array.isArray(chunk.mints)) return 0;
    const sf = byTop.get(chunk.top); if (!sf) return 0;
    const n = Math.min(Number(chunk.n) || chunk.mints.length, chunk.mints.length);
    if (!(n > 0)) return 0;
    queue.push({ sf, chunk, r: 0 });
    S.invalidate();
    return n;
  }
  function drop(top) {
    const sf = byTop.get(top); if (!sf) return;
    for (let q = queue.length - 1; q >= 0; q--) if (queue[q].sf === sf) queue.splice(q, 1);
    for (let q = jobs.length - 1; q >= 0; q--) if (jobs[q].sf === sf) jobs.splice(q, 1);
    if (!sf.real && !sf.mints) return;
    const ts = reduced() ? -1e4 : tSec();
    if (aR) for (let j = 0; j < sf.next; j++) { const g = sf.base + j; if (aR[g * 4] > 0.5) { aR[g * 4] = 0; aR[g * 4 + 1] = ts; touch("r", g); } }
    // the page's selection / hover inside this family goes with it
    const sel = S.motion && typeof S.motion.selected === "function" ? S.motion.selected() : -1;
    if (sel >= DUST0 && famIdxOfSlot(sel - DUST0) === sf.id) { try { S.motion.select(-1); } catch { /* ignore */ } }
    if (S.hoverI >= DUST0 && famIdxOfSlot(S.hoverI - DUST0) === sf.id) { try { S.motion.clearHover?.(false); } catch { /* ignore */ } }
    if (sf.shownReal > 0) { sf.shownReal = 0; try { S.motion.visSpeck?.(sf.f.id, false); } catch (e) { console.error("map3", e); } }   // (last-trade filter)
    totalReal -= sf.real; sf.real = 0; sf.realOnGhost = 0; sf.next = 0; sf.ht = null;
    sf.mints = null; sf.sym = null; sf.mc = null; sf.lk = null; sf.crt = null; sf.lastT = null; sf.grid = null;
    flush();
    animUntil = Math.max(animUntil, nowMs() + XFADE_S * 1000 + 50);
  }

  // ---------- heat / highlight passes (<= 4 ms slices) ----------
  const realFams = () => list.filter((sf) => sf.real > 0);
  function runJobs() {
    if (!jobs.length || genState !== "done") return false;
    const t0 = nowMs(), dl = t0 + ADD_SLICE_MS - 0.5;
    let n = 0;
    while (jobs.length) {
      const jb = jobs[0], sf = jb.sf;
      if (!sf.mints) { jobs.shift(); continue; }
      for (; jb.j < sf.next; jb.j++) {
        const j = jb.j, g = sf.base + j, m = sf.mints[j];
        if (m) {
          if (jb.kind === "heat") {
            const last = Math.max(sf.lastT[j], heatOf(m)); sf.lastT[j] = last;
            // (last-trade filter) a class that crosses the Key's line: the speck appears / goes at once
            const c = clsOf(last); if (aR[g * 4 + 2] !== c) { aR[g * 4 + 2] = c; touch("r", g); if (vMask !== 15) snapAlpha(sf, g, m, c); }
          } else {   // "hl": the highlight or the filter changed (one crossfade for every speck, from what it shows now)
            const e = Math.max(0, Math.min(1, (jb.t - jb.t0) / HL_S)), s = e * e * (3 - 2 * e), was = aF[g * 3 + 2];
            aF[g * 3 + 1] = aF[g * 3 + 1] + (was - aF[g * 3 + 1]) * s; aF[g * 3 + 2] = alphaOf(m, aR[g * 4 + 2]); touch("f", g);
            countShown(sf, was, aF[g * 3 + 2]);
          }
        }
        if ((++n & 127) === 0 && nowMs() > dl) break;
      }
      if (jb.j >= sf.next) jobs.shift();
      if (nowMs() > dl) break;
    }
    flush();
    hoverCheck();
    const d = nowMs() - t0; if (d > addSliceMax) addSliceMax = d; if (d > jobMax) jobMax = d;
    return true;
  }
  S.on("heat", () => { for (let q = jobs.length - 1; q >= 0; q--) if (jobs[q].kind === "heat") jobs.splice(q, 1); for (const sf of realFams()) jobs.push({ kind: "heat", sf, j: 0 }); });
  let hlT0Prev = -1e4;
  // a new crossfade for the ghosts (uniforms) and every real speck (an "hl" pass): the highlight, or the Key's filter, changed
  // (last-trade filter) the crossfade starts NOW on uTime's clock (performance.now() / 1000: frame() sets uTime from the rAF
  // timestamp, same origin, but uTime is the LAST frame's time: stale on a hidden tab, so a Key toggle's fade would be over)
  function restartAlpha() {
    const t = nowMs() / 1000, e = Math.max(0, Math.min(1, (t - uSwHlT0.value) / HL_S)), s = e * e * (3 - 2 * e);
    uSwHlA.value = uSwHlA.value + (uSwHlB.value - uSwHlA.value) * s; uSwHlB.value = ghostTarget();
    hlT0Prev = uSwHlT0.value; uSwHlT0.value = t;
    for (let q = jobs.length - 1; q >= 0; q--) if (jobs[q].kind === "hl") jobs.splice(q, 1);
    for (const sf of realFams()) jobs.push({ kind: "hl", sf, j: 0, t, t0: hlT0Prev });
    animUntil = Math.max(animUntil, nowMs() + HL_S * 1000 + 50);
    S.invalidate();
  }
  function setHl(test) {
    hlTest = typeof test === "function" ? test : null;
    restartAlpha();
  }
  // (last-trade filter) the Key's mask and the pinned speck mints (motion.js)
  function setVis(mask, pins) {
    const m = typeof mask === "number" && Number.isFinite(mask) ? (mask | 0) & 15 : 15;
    if (m === vMask) { setPins(pins); return; }   // the pins alone
    vPins = pins instanceof Set ? new Set(pins) : new Set(Array.isArray(pins) ? pins : []);
    vMask = m; restartAlpha();
  }
  // the pinned speck mints changed (a selected / hovered / focused speck, the page's pins): only those specks, at once
  function setPins(pins) {
    const next = pins instanceof Set ? new Set(pins) : new Set(Array.isArray(pins) ? pins : []);
    const diff = []; for (const m of vPins) if (!next.has(m)) diff.push(m); for (const m of next) if (!vPins.has(m)) diff.push(m);
    vPins = next;
    if (!aR || genState !== "done") return;
    let any = false;
    for (const m of diff) { const o = slotOf(indexOf(m)); if (o && aR[o.g * 4] > 0.5 && snapAlpha(o.sf, o.g, m, aR[o.g * 4 + 2])) any = true; }
    if (any) { flush(); S.invalidate(); hoverCheck(); }
  }
  const isShown = (i) => { const o = realAt(i); return !!o && aF[o.g * 3 + 2] > 0; };

  // ---------- the label mask (labels.js: the rects of the labels placed over a ghosted family) ----------
  // called by every label layout pass (each moving frame): no allocation, a redraw only when a rect changed
  function setMask(rects, n) {
    n = Math.max(0, Math.min(LAB_MAX, n | 0, rects ? Math.floor(rects.length / 4) : 0));
    const pad = LAB_PAD_PX / Math.max(1e-6, S.cam.k);
    let changed = n !== uSwLabN.value || pad !== uSwLabPad.value;
    for (let q = 0; q < n; q++) {
      const x0 = Math.min(rects[4 * q], rects[4 * q + 2]), x1 = Math.max(rects[4 * q], rects[4 * q + 2]);
      const y0 = Math.min(rects[4 * q + 1], rects[4 * q + 3]), y1 = Math.max(rects[4 * q + 1], rects[4 * q + 3]);
      const v = uSwLab.value[q];
      if (v.x !== x0 || v.y !== y0 || v.z !== x1 || v.w !== y1) { v.set(x0, y0, x1, y1); changed = true; }
    }
    uSwLabN.value = n; uSwLabPad.value = pad;
    if (changed) S.invalidate();
  }
  const ghosted = (famId) => famId >= 0 && famId < sfOfFam.length && sfOfFam[famId] >= 0;

  // ---------- index space ----------
  const famIdxOfSlot = (g) => {
    if (!(g >= 0 && g < M)) return -1;
    let lo = 0, hi = nSF - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (list[mid].base <= g) lo = mid; else hi = mid - 1; }
    return list[lo] && g - list[lo].base < list[lo].n ? lo : -1;
  };
  const slotOf = (i) => {
    if (!(i >= DUST0)) return null;
    const g = i - DUST0, s = famIdxOfSlot(g); if (s < 0) return null;
    const sf = list[s], j = g - sf.base;
    return { sf, j, g };
  };
  const realAt = (i) => { const o = slotOf(i); return o && o.sf.mints && o.j < o.sf.next && o.sf.mints[o.j] && aR && aR[o.g * 4] > 0.5 ? o : null; };
  const indexOf = (m) => {
    if (typeof m !== "string") return -1;
    for (const sf of list) { if (!sf.real) continue; const j = htGet(sf, m); if (j >= 0) return DUST0 + sf.base + j; }
    return -1;
  };
  const mintAt = (i) => { const o = realAt(i); return o ? o.sf.mints[o.j] : null; };
  // a speck's drawn radius, CSS px (the shader's diameter rule)
  const rCss = (o) => {
    const dpr = S.DPR || 1, sig = o.sf.spacing * S.cam.k * dpr, t = aR ? aR[o.g * 4 + 3] : 0;
    const dDev = Math.max(1, Math.min(GHOST_D_DEV + (2 * dpr - GHOST_D_DEV) * t, Math.max(1, 0.5 * Math.max(sig, uSwK.value.y))));
    return 0.5 * dDev / dpr;
  };
  const pos = (i) => {
    const o = slotOf(i); if (!o || !o.sf.built) return null;
    const sf = o.sf, [dx, dy] = dispOf(sf, o.j);
    return [sf.cx + sf.x[o.j] + dx, sf.cy + sf.y[o.j] + dy, rCss(o) / S.cam.k];
  };
  const famOf = (i) => { const o = slotOf(i); return o ? o.sf.f : null; };
  const screenR = (i) => { const o = slotOf(i); return o ? rCss(o) : 0; };
  const spacing = (i) => { const o = slotOf(i); return o ? o.sf.spacing : 0; };
  const tip = (i) => {
    const o = realAt(i); if (!o) return null;
    const { sf, j } = o, m = sf.mints[j];
    const last = Math.max(sf.lastT[j], heatOf(m));
    return { i, mint: m, symbol: sf.sym[j], mcapUsd: sf.mc[j], lockedUsd: sf.lk[j], createdAt: sf.crt[j] || null, lastTrade: last > -Infinity ? last : null,
      age: last > -Infinity ? Math.max(0, (S.nowS || Date.now() / 1000) - last) : Infinity, top: sf.top, fam: sf.f, size: sf.f.size, rank: j };
  };
  const famVisible = (sf) => sf.f.planet || G || S.dustExpand >= 0.5;
  // the pick grid over the real specks where they are drawn now (build position + anchor displacement)
  const pickGrid = (sf) => {
    if (sf.grid && sf.gridAt === sf.next && sf.gridV === sf.dispV) return sf.grid;
    let gx = sf.x, gy = sf.y;
    if (sf.dispAny) {
      gx = new Float32Array(sf.next); gy = new Float32Array(sf.next);
      for (let j = 0; j < sf.next; j++) { const [dx, dy] = dispOf(sf, j); gx[j] = sf.x[j] + dx; gy[j] = sf.y[j] + dy; }
    }
    sf.grid = buildPointGrid(gx, gy, sf.next, Math.max(sf.spacing * 2, 0.5)); sf.gridAt = sf.next; sf.gridV = sf.dispV;
    return sf.grid;
  };
  function pick(sx, sy, touchIn) {
    if (genState !== "done") return -1;
    const k = S.cam.k, [wx, wy] = S.toW(sx, sy);
    const sigMinCss = uSwK.value.y / (S.DPR || 1);
    let best = -1, bd = Infinity;
    for (const sf of list) {
      if (!sf.real || !famVisible(sf)) continue;
      // a target only when every speck is shown (no thinning at this zoom) and >= 3 CSS px apart
      const sigC = sf.spacing * k; if (sigC < Math.max(PICK_SIGMA_PX, sigMinCss)) continue;
      const reachPx = touchIn ? 10 : Math.max(4, 0.5 * sigC), reach = reachPx / k;
      const rx = wx - sf.cx, ry = wy - sf.cy;
      if (!sf.dispAny && Math.hypot(rx, ry) > sf.r1 + reach) continue;
      const grid = pickGrid(sf);
      const j = nearestInGrid(grid, rx, ry, reach, (jj) => aR[(sf.base + jj) * 4] > 0.5 && aF[(sf.base + jj) * 3 + 2] > 0);   // (last-trade filter) drawn specks only
      if (j < 0) continue;
      const d = Math.hypot(grid.x[j] - rx, grid.y[j] - ry);
      if (d < bd) { bd = d; best = DUST0 + sf.base + j; }
    }
    return best;
  }
  const select = (i) => { uSwSel.value = i >= DUST0 ? i - DUST0 : -1; S.invalidate(); };
  // (last-trade filter) 0 = not a loaded speck, 1 = loaded but the Key hides it (even live now), 2 = drawn; a hidden speck
  // whose new class (live) the Key shows appears at once
  function trade(m, tS) {
    const i = indexOf(m); if (i < 0) return 0;
    const o = slotOf(i); const { sf, j, g } = o;
    sf.lastT[j] = Math.max(sf.lastT[j], Number(tS) || Date.now() / 1000);
    let snapped = false;
    if (aR[g * 4 + 2] !== 0) { aR[g * 4 + 2] = 0; touch("r", g); snapped = snapAlpha(sf, g, m, 0); }
    const shown = aF[g * 3 + 2] > 0;
    if (!reduced() && shown) { aF[g * 3] = tSec(); touch("f", g); }
    flush();
    if (snapped && !shown) hoverCheck();   // live now, but the Key hides 'within 30 min'
    if (shown) animUntil = Math.max(animUntil, nowMs() + 420);
    return shown ? 2 : 1;
  }

  // ---------- want: the families the page should load ----------
  let wantKey = "", wantAt = -1e9, camX = NaN, camY = NaN, camK = NaN, camAt = 0, settledDone = true;
  function coverOf(sx, sy, r, ir) {
    // the share of the disc inside the inset rect (32 vertical strips)
    const x0 = Math.max(ir.x0, sx - r), x1 = Math.min(ir.x1, sx + r);
    if (!(x1 > x0) || !(r > 0)) return 0;
    let a = 0; const n = 32, dx = (x1 - x0) / n;
    for (let q = 0; q < n; q++) {
      const x = x0 + (q + 0.5) * dx, h = Math.sqrt(Math.max(0, r * r - (x - sx) * (x - sx)));
      const y0 = Math.max(ir.y0, sy - h), y1 = Math.min(ir.y1, sy + h); if (y1 > y0) a += (y1 - y0) * dx;
    }
    return a / (Math.PI * r * r);
  }
  function evalWant(now, force = false) {
    wantAt = now;
    if (!nSF) return;
    const ir = S.insetRect(), short = Math.max(40, Math.min(ir.x1 - ir.x0, ir.y1 - ir.y0)), k = S.cam.k;
    const focused = S.motion && typeof S.motion.focusedFam === "function" ? S.motion.focusedFam() : -1;
    const out = [];
    for (const sf of list) {
      const f = sf.f, r = f.Rc * k, [sx, sy] = S.toS(f.cx, f.cy);
      const cov = coverOf(sx, sy, r, ir);
      if (f.id === focused || (r >= WANT_R * short && cov >= WANT_COVER)) out.push({ m: sf.topMint, a: cov * r * r + (f.id === focused ? 1e12 : 0) });
    }
    out.sort((a, b) => b.a - a.a);
    const tops = out.map((o) => o.m), key = tops.join(",");
    if (key === wantKey && !force) return;
    wantKey = key;
    const cb = S.callbacks && S.callbacks.onSwarmWant;
    if (typeof cb === "function") { try { cb(tops); } catch (e) { console.error("map3", e); } }
  }

  // ---------- the frame hook: fade-in, queued chunks, passes, want ----------
  S.onFrame((now) => {
    let more = false;
    if (fadeT0 >= 0) { const u = (now - fadeT0) / FADE_MS; if (u >= 1) { uSwFade.value = 1; fadeT0 = -1; } else { uSwFade.value = u * u * (3 - 2 * u); more = true; } }
    if (queue.length && genState === "done") { drainQueue(); more = true; }
    else if (jobs.length && genState === "done") { runJobs(); more = true; }
    if (now < animUntil) more = true;
    const c = S.cam;
    if (c.x !== camX || c.y !== camY || c.k !== camK) { camX = c.x; camY = c.y; camK = c.k; camAt = now; settledDone = false; if (now - wantAt >= WANT_MS) evalWant(now); }
    else if (!settledDone && now - camAt >= WANT_SETTLE_MS) { settledDone = true; evalWant(now); }
    return more;
  });
  S.on("resize", () => { evalWant(nowMs(), false); });

  // ---------- stats + debug ----------
  const families = () => list.map((sf) => ({ top: sf.topMint, ghost: sf.ghost, slots: sf.n, real: sf.real, cap: sf.cap }));
  const queuedRows = () => { let n = 0; for (const q of queue) n += Math.max(0, Math.min(q.chunk.n, q.chunk.mints.length) - q.r); return n; };
  const stats = () => {
    let ghostVisible = 0, real = 0;
    for (const sf of list) { ghostVisible += genState === "done" ? Math.max(0, sf.ghostShown - sf.realOnGhost) : 0; real += sf.real; }
    return { tier, families: nSF, slots: M, ghostVisible, real, queued: queuedRows(), genMs: +genMs.toFixed(2), genWallMs: +genWallMs.toFixed(1), genSliceMaxMs: +genSliceMax.toFixed(2),
      addSliceMaxMs: +addSliceMax.toFixed(2), drainSliceMaxMs: +drainMax.toFixed(2), drainSlices: sliceLog.length,
      drainSlow: slowLog.slice(), drainSliceP95Ms: sliceLog.length ? sliceLog.slice().sort((a, b) => a - b)[Math.floor(0.95 * (sliceLog.length - 1))] : 0, jobSliceMaxMs: +jobMax.toFixed(2), overlaps, drops, state: genState, drawn: idxN, fade: +uSwFade.value.toFixed(3), wants: wantKey ? wantKey.split(",").length : 0,
      sigMinDev: +uSwK.value.y.toFixed(3), labelRects: uSwLabN.value,
      byFamily: list.map((sf) => ({ top: sf.topMint, ghost: sf.ghost, slots: sf.n, real: sf.real, cap: sf.cap, stride: strideOf(sf.ghostSlots, sf.ghostCap), tau: +sf.tau.toFixed(4), ghostShown: Math.max(0, sf.ghostShown - sf.realOnGhost),
        spacing: +sf.spacing.toFixed(4), spacingMean: +sf.spacingMean.toFixed(4), p: +sf.p.toFixed(3), r0: +sf.r0.toFixed(2), r1: +sf.r1.toFixed(2), r95: +sf.r95.toFixed(2), Rc: +sf.f.Rc.toFixed(2),
        overlaps: sf.overlaps, drops: sf.drops, genMs: sf.genMs, sym: S.sym[sf.top] })) };
  };
  S.debugFns.swarm = stats;
  S.debugFns.swarmCheck = () => {
    let outside = 0, onDrawn = 0, slots = 0, noAnchor = 0, h = 0x811c9dc5;
    for (const sf of list) {
      if (!sf.built) continue;
      slots += sf.n;
      const f = sf.f, rTop = R[sf.top], tx = Xb[sf.top] - sf.cx, ty = Yb[sf.top] - sf.cy;
      for (let j = 0; j < sf.n; j++) {
        const d = Math.hypot(sf.x[j], sf.y[j]);
        if (d > f.Rc + 1e-3 || Math.hypot(sf.x[j] - tx, sf.y[j] - ty) < rTop) outside++;
        if (!(sf.anchor[j] >= 0)) noAnchor++;
      }
      const members = []; for (const i of sf.mem) members.push({ x: Xb[i] - sf.cx, y: Yb[i] - sf.cy, r: R[i] });
      onDrawn += countInDiscs(sf.x, sf.y, sf.n, members);
      h = Math.imul(h ^ slotsHash(sf.x, sf.y, sf.n), 0x01000193) >>> 0;
    }
    return { outside, onDrawn, onDrawnShare: slots ? +(onDrawn / slots).toFixed(5) : 0, overlaps, noAnchor, hash: h >>> 0, slots, state: genState };
  };
  // the look knobs live (QA tuning): {aDot, sigMin (device px), aReal, kReal}; returns the values in force
  S.debugFns.swarmTune = (o = {}) => {
    const v = uSwK.value;
    if (Number.isFinite(o.aDot)) v.x = o.aDot;
    if (Number.isFinite(o.sigMin)) { v.y = o.sigMin; sigMinTuned = true; }
    if (o.sigMin === null) { v.y = sigMin0(); sigMinTuned = false; }
    if (Number.isFinite(o.aReal)) v.z = o.aReal; if (Number.isFinite(o.kReal)) v.w = o.kReal;
    S.invalidate();
    return { aDot: v.x, sigMin: v.y, aReal: v.z, kReal: v.w };
  };
  // the renderer's programs (QA: the layer adds one): count and how many share a shader pair
  S.debugFns.programs = () => { const ps = (S.gfx.renderer && S.gfx.renderer.info.programs) || []; const by = {}; for (const q of ps) { const k = String(q.cacheKey).split(",").slice(0, 2).join(","); by[k] = (by[k] || 0) + 1; } return { n: ps.length, dup: Object.values(by).filter((v) => v > 1).length }; };
  // the in-page A/B (look gate): hide / show the layer on the same frame clock; returns the visibility now
  S.debugFns.swarmShow = (on) => { if (typeof on === "boolean") { points.visible = on; S.invalidate(); } return points.visible; };
  // QA (drag follow): every step-th slot of a family where the shader draws it now (build position + its anchor's
  // displacement) and where it was built, world u; plus the anchor member's displacement
  S.debugFns.swarmSample = (key, step = 50) => {
    const sf = byTop.get(key); if (!sf || !sf.built) return null;
    const out = [];
    for (let j = 0; j < sf.n; j += Math.max(1, step | 0)) {
      const [dx, dy] = dispOf(sf, j), a = sf.anchor[j];
      out.push({ j, x: sf.cx + sf.x[j] + dx, y: sf.cy + sf.y[j] + dy, bx: sf.cx + sf.x[j], by: sf.cy + sf.y[j], anchor: a >= 0 ? S.mint[sf.mem[a]] : null, dx, dy });
    }
    return { n: sf.n, dispAny: sf.dispAny, sample: out };
  };
  S.debugFns.swarmMask = () => ({ n: uSwLabN.value, pad: uSwLabPad.value, rects: uSwLab.value.slice(0, uSwLabN.value).map((r) => [r.x, r.y, r.z, r.w].map((v) => +v.toFixed(2))) });
  S.debugFns.swarmSynth = (key, n = 1000) => {
    let sf = byTop.get(key);
    if (!sf) { const f = S.famBy ? S.famBy(key) : null; if (f && sfOfFam[f.id] >= 0) sf = list[sfOfFam[f.id]]; }
    if (!sf) return 0;
    n = Math.max(0, Math.min(Number(n) || 0, sf.n));
    let rows = 0;
    for (let from = 0; from < n; from += 5000) {
      const m = Math.min(5000, n - from), mints = Array.from({ length: m }, () => ""), symbols = Array.from({ length: m }, () => "");
      const mcapUsd = new Float64Array(m), lockedUsd = new Float64Array(m), createdAt = new Float64Array(m), migrated = new Uint8Array(m), children = new Uint32Array(m);
      for (let r = 0; r < m; r++) { const q = from + r; mints[r] = `synth${sf.id}x${q}pump`; symbols[r] = `SYN${q}`; mcapUsd[r] = 4200 - q * (1500 / Math.max(1, n)); lockedUsd[r] = NaN; createdAt[r] = Date.now() / 1000 - 3600 * (1 + q % 500); }
      rows += add({ top: sf.topMint, from, n: m, mints, symbols, mcapUsd, lockedUsd, createdAt, migrated, children });
    }
    return rows;
  };

  // index.js calls start() once the first frame is on screen (build time and first frame stay what they are)
  const start = () => { if (genState === "wait" && !S.dead) S.life.timeout(startGen, 0); };
  S.swarm = { on: true, DUST0, isDust: (i) => i >= DUST0, start, add, drop, families, indexOf, mintAt, pos, famOf, screenR, spacing, tip, pick, select, trade, setHl, stats, ghosted, setMask,
    setVis, setPins, isShown, ready: () => genState === "done" };
  Object.assign(S.debug.obj, { swarm: points });
  S.debug.map.swarmPlan = { tier, families: nSF, slots: M };
}
