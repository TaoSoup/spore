// (map3 port) Copied from the prototype. Changed: d3's line/curveBundle come from the app's "d3" package; reduced motion
// comes from S.motion.reduced only (no media query, no URL); a highlight mask (setHl): a link dims to TOK.dim when its
// CHILD does not match (160 ms crossfade, the mask rides in the offset texture's free 4th channel); the debug functions
// go to S.debugFns; every mesh, geometry, material and DataTexture is disposed with the engine.
// links.js: parent -> child links as HAIRLINE bundled splines, the generation arcs, the (retired) hull ring, and every
// event mark of the map: trade pulses, family flashes and birth sparks.
// ROUND 2 (2026-10-21, LANES.md section "Links lane, round 2"):
//   - level of detail by generation: gen-1 links always; gen-2 fade in over LOD_G2 (x k0), gen-3+ over LOD_G3, unless the
//     branch is emphasised (hover lineage via setEmphasis, selection via setBranch): that branch draws at any zoom.
//   - one alpha BUDGET per brood: a parent with n > 8 children spends 8 + 0.6 sqrt(n - 8) "link equivalents", water-filled
//     by importance (R^2 x (1 + 1.5 log2(1 + subtree))). Big broods never draw a visible fan; their few structural
//     children stay wired. Broods of 9-40 get x k/4k0 (max x4) past 4 k0. Live links share an additive budget per trunk.
//   - detached pods (6+ children packed away from their parent) collapse to ONE trunk link (dormant on a layout that
//     centres broods on their parents).
//   - bundling beta 0.5, and deeper links straighten over their last 32 % toward the child (no brooms / whisks).
//   - links, arcs, pulses, flashes and sparks FOLLOW MOVING COINS: whoever moves a coin mutates S.X / S.Y in place; links
//     diff them against the designed layout every frame (and right before drawing) and feeds a per-coin offset texture
//     to the vertex shader (the displaced tangent is exact for a linear blend along the arc length).
//   - pulses: 24 slots, extras evict the OLDEST; at the overview (links hidden) a spawn becomes a family flash.
//     flashFamily(fam) = a one-shot 300 ms ring ping on the planet chip (+ bubbles.flashRim / optional flashCore);
//     spark(from, to) = a birth spark parent -> child that draws the child's link on behind it.
// OWNER: LINKS lane. Consumes layout (TH/NR/X/Y/f.*); does not touch layout math, bubbles, labels, the camera.
//
// Every line here is drawn in SCREEN px with one technique: a thin quad strip extruded in the vertex shader by
// a constant CSS-px half-width (never world units, so nothing grows into a tube when you zoom), with a 1-device-px
// coverage ramp on both edges. Anything thinner than 1 device px is drawn 1 device px wide at reduced alpha
// (coverage), so no geometry is ever sub-pixel. Blending is premultiplied One/OneMinusSrcAlpha everywhere:
// non-live output (c*a, a) = "over"; live output (c*a, 0) = additive. Every material is single-pass (forceSinglePass):
// three would otherwise draw a transparent DoubleSide mesh twice (back faces, then front faces).
//
// EXPORTS
//   buildLinks(S, pause?) (async; final fix: yields while building)   needs S.gfx.scene and final world X/Y (after placeDust). Fills S.links:
//     mesh, lGeo                         the link mesh: ONE draw, renderOrder 4
//     setLinkHeat(c, cls, tSec)          link of child c crossfades to heat class cls over 0.6 s from tSec
//     setEmphasis(coinIdxList)           links whose CHILD is in the list = the hover lineage (cap 1,500); [] clears.
//                                        Emphasised links ignore the generation LOD and get a brood floor.
//     setBranch(coin | -1)               (r2) the selected branch: the coin's ancestor chain + its whole subtree draws at any
//                                        zoom (160 ms fade). Expected caller: motion's select(i).
//     follow(list?, n?), setPositions(list, n)   (r2) optional: "these coins moved, S.X/S.Y hold their new positions";
//                                        forces an offset sync now. Without calls, links diff S.X/S.Y every frame by itself.
//     addBornLink(parent, x, y, r) -> id (r2) the link of a newborn that got no spark (reduced motion); -1 if refused
//     linkPolyline(c) -> Float32Array|null   world points [x0,y0,...] from the child rim to the parent rim (current positions)
//     genArcInfo(famId) -> [{gen, r, spans}] generation arcs of a family: r in world u, spans = [[a0, a1], ...]
//                                        in radians, world frame (0 = east, counter-clockwise, y up; 12 o'clock =
//                                        PI/2), a1 > a0, may exceed 2PI. [] when the family has no arcs.
//     genArcs.mesh, genArcs.setKnockouts([{fam, gen, angle, half}]), genArcs.setTagged(fam, gens)
//     hull.mesh, hull.show(famId | -1)   the ring is retired; show() still marks the focused family
//     pulses.mesh, pulses.spawn(c, tSec?) -> bool   a 1100 ms pulse from child c's rim to its parent's rim. 24 slots; a
//                                        spawn when all are busy evicts the oldest. At the overview (links hidden) it
//                                        becomes flashFamily(famOf[c]).
//     pulses.flashFamily(famId, tSec?) -> bool      (r2) one-shot ring ping (300 ms ease-out) on the family's top chip;
//                                        also calls S.bubbles.flashRim(top) and, if it exists, S.bubbles.flashCore(top)
//     pulses.spark(from, to, tSec?) -> number|false (r2) birth spark parent -> child (650 ms, ease-out). from/to = coin
//                                        index or {x, y} world point. When `to` has a link it draws on behind the
//                                        spark. Returns the arrival time (s, uTime clock); calls S.links.onSparkArrive(to)
//     pulses.active() -> number, pulses.stats() -> {...}   slots in use / counters
//   ROUND 2 FINAL (LANES.md "Round 2 result"): links are NEUTRAL hairlines in every class (no lime, all "over"); long links
//     thin to 0.6 px and fade to 22 % by 320 px; the overview hover veil is quiet (<= 0.22).
//     pulses.spawn(c, tSec?, {size: 0|1|2, sell}) -> bool  head radius / tail length by trade value; a sell = hollow head;
//                                        the pulse's own link is lit (alpha >= 0.32) while it runs
//     pulses.flashCoin(i, tSec?, {scale, alpha, dur, at: {x, y, r, fam}}) -> bool   ring ping on ANY coin (or a point)
//     onPulseArrive(parentIdx), onSparkArrive(coin)   NOT assigned here (motion owns both slots)
//   Registers one frame hook (offset sync, attribute flushes, pulse / flash / spark animation); returns true while animating.
//   Debug: S.debug.obj.{links, lGeo, genArcs, hull, pulses, flashes}; S.debug.map.{linkVerts, linkTris, linkCount,
//          genArcVerts, genArcFams, linksMs}
//          S.debugFns.linkMaxPx()          widest vein core in CSS px at the current zoom (flatWA: the shader's formula)
//          S.debugFns.linkInk(cls = -1)    GPU truth: renders only the links, ink / visible length = mean drawn width
//          S.debugFns.linkHdr({pulses})    renders only this lane's layers: pixels > 1.0 (only pulse heads may)
//          S.debugFns.linkVisible(thr)     (r2) links on screen whose alpha >= thr (default 0.02), by generation
//          S.debugFns.linkDemo(kind, key)  (r2) 'pulse' | 'flash' | 'spark' | 'drag' on a ticker / coin, for verification
//   (map3 port) setHl(bitOf(coin) -> 0|1, tSec?, bornBit(childIdx) -> 0|1)  highlight mask by child coin
import * as THREE from "three";
import { line, curveBundle } from "d3";
import { TAU, rnd } from "./util.js";
import { TOK, heatClass, EASE, DUR } from "./tokens.js";

const DEG = Math.PI / 180;
const XY_NET_FRAMES = 30;               // (local perf) safety-net cadence of the moved-coin scan (see syncOffsetsFrame)
// (veins lane, 2026-10-21 16:00Z, LANES.md "veins — live curves") galaxy veins = ONE instanced draw of live cubics. Every
// vein runs centre to centre; the cubic is rebuilt per vertex from the LIVE end positions (position texture uPos) and two
// control points stored in the chord frame, so veins re-bend every frame as coins move (no offsets, no shear, no lag).
// Numbers: spec section 2 ("VEINS: live curves"). Flat keeps the baked hairline mesh below.
const VEIN = {
  nseg: 20, nsegPhone: 12,              // strip segments per vein
  PW: 2048,                              // position texture width (texel i = X, Y, Rdraw, minPx)
  minPx0: 0.5,                           // minPx fallback (CSS px) when S.minPx is absent
  wK: 0.42, wB: 0.12, wMin: 0.22, wMax: 1.4,   // w0 = clamp(wK Rdraw[c] + wB, wMin, wMax) world
  // (fixer 2026-10-21) deep zoom was ~2x the ref's brightness: cap 18 -> 12, gl = min(0.9 core, 6 dpr) + 1 dpr, glow 0.35 -> 0.2
  capPx: 15, taper: 0.6, endCap: 1.6,    // core cap (x dpr), child taper, end cap (x rimPx)
  glowK: 0.9, glowMax: 6.0, glowB: 1.5, glowA: 0.28,  // gl = min(glowK core, glowMax dpr) + glowB dpr; glow alpha glowA exp(-3 (d/gl)^2)
  // (fixer) per-family overlap normaliser (white blowout of dense hot broods at the overview): a *= clamp(ovK / overlap, ovMin, 1),
  // overlap = nVeins Lmean W / (pi Rc^2) in px; additive contribution of non-notable / gen >= 2 veins capped at hotCap
  ovK: 1.2, ovMin: 0.04, hotCap: 0.6,
  hairCol: 0xa8b0ac, hairK: 0.45,         // quiet / cold non-notable veins: grey-white hairline (no violet wash, no glow, no dash)
  // quiet / cold raised from the spec's 0.55 / 0.4 (measured: violet share 0.0005 at $PUMP 4x, 0.003 deep, gates 0.03 / 0.04;
  // at 0.4 a cold gen-2 vein measured below bg + 24 luminance at the rim, i.e. invisible: owner item 1)
  aNotable: 0.85, aOther: 0.7, aGen2: 0.75, aQuiet: 0.8, aCold: 0.7, aOv: 0.75, aDust: 0.6,   // aOther / aGen2 raised from 0.55 / 0.6 (veinShare gates)
  // w0 is spec'd in world units of the monolith layout (k0 = 1); this layout's k0 is ~0.17 px/u, so w0 x k alone stayed under
  // the F floor until ~6x (veinShare 0.046 at $PUMP 4x, 0.011 deep). wPerK0 = 1 reads w0 as CSS px AT k0 (w0 x k / k0)
  wPerK0: 1,
  dashAmp: 0.10, focusA: 0.0, focusDim: 0.6,   // (fixer) dash 0.25 -> 0.10 (0 on hairlines, faded at rims); focus 1.5 -> 0.4, dim 0.4 -> 0.6
  heat: [0xb6ff5c, 0x5ce0c8, 0x7f68c4, 0x4a4466],   // monolith heatHex stops (sRGB): lime, teal, violet, cold
  cpuSeg: 16,                            // CPU samples of the live cubic (pulses, linkPolyline, veinPath)
};
const FOCUS_DIM = 0.42;                  // (final polish) non-focused families' link alpha factor at full focus
const f3 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const GAPR = 2.4;                        // layout's generation gutter (fallback arc radius only)
// ---- round 2 ----
const LOD_G2 = [3.0, 5.0];               // x k0: gen-2 links fade in (0 below 3 k0, full from 5 k0)
const LOD_G3 = [6.0, 9.0];               // x k0: gen-3 and deeper
const BETA = 0.5;                        // bundling strength (0.85 -> 0.6 -> 0.5): a soft lead-out, never a waist
const STRAIGHT0 = 0.68;                  // deeper links straighten toward the child over the last 32 % of their length
const TRUNK_MIN = 6;                     // a brood of 6+ children laid out as a detached pod gets ONE trunk line
const BUDGET_FULL = 8;                   // broods up to 8 children: every link at full alpha
const BUDGET_ZOOM = [4, 4, 40];           // the brood budget of a SMALL brood (9..40 children) grows with zoom past 4 k0, x k/4k0 up
                                         // to x4: up close its links are long and far apart. Bigger broods keep their budget at
                                         // every zoom (a compact seed head would turn into a spiky dandelion); hover or select a
                                         // coin to see its whole brood
const budgetOf = (n) => (n <= BUDGET_FULL ? n : BUDGET_FULL + 0.6 * Math.sqrt(n - BUDGET_FULL));
const PULSE_MAX = 24;                    // lead amendment B (overrides TOK.pulseMax 12): 24 concurrent, oldest evicted
const FLASH_MAX = 24, FLASH_S = 0.32;    // family flashes: a 320 ms ring ping (alpha (1 - u)^1.5, radius ease-out)
const BORN_MAX = 128, BORN_PTS = 17;     // links of coins born after load (drawn on by their spark), oldest recycled
const SPARK_S = 0.65, SPARK_TAIL = 22;   // birth spark: 650 ms, ease-out (cubic, the shader's draw-on uses the same curve)
// (integrator, round 2) constant ink for LONG links: a line's weight grows with its length, so the few long single links the
// units layout keeps (satellite stalks, 240-410 px at 4 k0) outweighed whole broods and read as lone strands. A link longer
// than LONG_PX[0] CSS px fades toward LONG_PX[2] of its alpha by LONG_PX[1] px (per link, so the per-link cull holds); a
// hovered or selected one keeps at least LONG_PX[3]. LONG_PX[2] = 1 switches it off.
const LONG_PX = [100, 320, 0.22, 0.6];
// (round 2 final) links carry STRUCTURE, never heat: every class draws in one neutral line colour (lime appears only on
// live coins and on pulses while they travel). Heat still sets a link's weight a little (alpha and width by class).
// Long links also thin toward LONG_W px (CSS) past LONG_PX[0], so a satellite stalk never outweighs a brood.
const LINK_NEUTRAL = [0xa3aca8, 0x939c98, 0x8a9490, 0x8a9490], LONG_W = 0.6;   // (veins flat fix) LINK_NEUTRAL: reference only
// (veins lane, look fix 2026-10-22) the owner: "the veins between the bubbles are far too big and unprofessional; the previous
// site looked better" (the 2026-10-21 fix drew 2.6-6 px cores at alpha >= 0.45: every family a starburst, big broods a solid
// disc). Flat veins are HAIRLINES again: heat colours + alphas from TOK (premultiplied over), core TOK.linkW (CSS px at k0,
// +linkWGen1 for gen-1 / trunks, x linkWGen2 for gen >= 2) x clamp(sqrt(k / k0), 1, FLAT_W.sMax), cap TOK.linkWMax; no width
// floor (hairWidth draws a sub-device-px core 1 px wide at coverage alpha). Two budgets, both per brood:
//   - ANGULAR ROOM: a brood's n veins share half of the parent's DRAWN rim: w <= pi rRim / n at the rim (floored at
//     TOK.linkWRim so the structural veins of a 1,800-brood keep a visible hairline), pi (rRim + L) / n at the child end, with
//     a smooth taper over the first 60 % of the vein toward the parent. A 300-child family is never a solid disc.
//   - ALPHA: the old brood budget (dens = budgetOf(n) link-equivalents water-filled by importance, aInfo.w; broods of 9..40
//     grow x k/4k0 up to x4), no alpha floor; the generation LOD at FLAT_LOD (softer than the galaxy's LOD_G2 / LOD_G3).
// Veins stay on at every zoom for planets (no overview fade: the owner's ask); specks of families (Rc k < 24 px) carry none.
const LINK_A = TOK.linkA.slice();
const FLAT_LOD = [2.0, 3.5, 4.0, 6.0];     // x k0: gen-2 veins fade in 2 -> 3.5 k0, gen-3+ 4 -> 6 k0 (4+: 6 -> 9 k0)
const FLAT_W = { gen2: TOK.linkWGen2 ?? 0.75, cap: TOK.linkWMax ?? 1.5, rim: TOK.linkWRim ?? 0.75, sMax: 1.5, smallFam: [24, 72], long: [200, 600, 0.8] };
const OV_VEIL = 0.35, OV_EMPH_MAX = 0.22;  // the overview hover veil: quiet neutral hairlines, never a starburst
// (repair, look fix 2026-10-22) the brood floor of an emphasised vein (hover lineage / selected subtree) in the flat look:
// alpha >= linkA x EMPH_FLOOR / sqrt(n). The old build used 3 at linkA 0.11-0.45; today's linkA is 0.24-0.55 (x2.2 for the
// hairline look), so 1.5 gives the old hover intensity (inu 20x hover: 0.077 per vein, the old build 0.070; the 0.8 linkA floor
// of 23:21Z gave 0.35 and a disc, 2 gave 0.103 and a visible fan of 71 hairlines).
const EMPH_FLOOR = 1.5;
const LIT_A = 0.32;                        // a pulse's own link is at least this visible while the pulse runs
const FRESH_S = 3.5;                     // a link a spark just drew ignores the generation LOD this long (then 1 s fade)
const OW = 256;                          // offset texture width (texels); capacity N + 1024
const easeOut3 = (u) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 3);
const HEAT_LO = [0, 1800, 10800, 86400];  // (veins lane) heat class lower bounds, s since the last trade (tokens heatClass)

// cubic-bezier easing, the CSS way (x -> y)
function bez(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t, dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break; t -= e / d; }
    return sy(Math.min(1, Math.max(0, t)));
  };
}
const linC = (hex, k = 1) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r * k, c.g * k, c.b * k); };
const bigSphere = () => new THREE.Sphere(new THREE.Vector3(), 1e7);   // frustumCulled is off; this only stops
                                                                       // three from computing bounds on 2-D positions
// shared GLSL: the screen-space hairline (side from gl_VertexID parity: even = -1, odd = +1)
const HAIR_GLSL = /* glsl */`
float hairSide(){ return (gl_VertexID % 2 == 0) ? -1.0 : 1.0; }
// CSS width -> device half-width incl. a 1 px AA ramp; cov = coverage alpha for widths under 1 device px
vec2 hairWidth(float wCss, float dpr){ float wd = wCss * dpr, cov = 1.0; if (wd < 1.0) { cov = wd; wd = 1.0; } return vec2(wd * 0.5 + 0.5, cov); }`;
// offset texture lookup: texel i = (dx, dy, parentIdx, 0) in world units
const OFF_GLSL = /* glsl */`
uniform sampler2D uOff;
ivec2 offUV(int i){ return ivec2(i - (i / ${OW}) * ${OW}, i / ${OW}); }`;

// (final fix) pause: optional async yield, as in layout.js: the geometry loop yields every SLICE_MS of work and the build
// yields between its phases. The computation and its order are unchanged.
const SLICE_MS = 40;
export async function buildLinks(S, pause = null) {
  const t0 = performance.now();
  let tSlice = t0;
  // the longest slice ending at each checkpoint (S.debug.map.linksSliceMs), and its yields
  const sliceMs = {};
  let tMark = t0;
  const maybePause = async (at = "geometry") => {
    const now = performance.now(); sliceMs[at] = Math.max(sliceMs[at] || 0, Math.round(now - tMark));
    if (pause && now - tSlice > SLICE_MS) { await pause(); tSlice = performance.now(); }
    tMark = performance.now();
  };
  const { N, fams, par, gen, famOf, kids, age, R, X, Y, TH, NR, U, maxShare } = S;
  const scene = S.gfx.scene;
  // (map3 port) reduced motion is the app's switch only (setReducedMotion -> S.motion.reduced)
  const reducedNow = () => !!(S.motion && S.motion.reduced);
  // ---------- GALAXY look (2026-10-21, layout+veins lane) ----------
  // One engine, two looks: every galaxy change sits behind G in JS and behind #ifdef GALAXY in GLSL (material.defines),
  // so the flat path stays pixel-identical. Token values come from S.tok (GAL via tokensFor) with the spec's literals as
  // fallbacks; the animation uniforms come from S.U (uLook/uAnimT/uGalT/uFlow) with local stand-ins until state.js has them.
  const G = S.look === "galaxy", T = S.tok || TOK;
  const galU = { uLook: U.uLook || { value: G ? 1 : 0 }, uAnimT: U.uAnimT || { value: 0 }, uGalT: U.uGalT || { value: 0 }, uFlow: U.uFlow || { value: 1 } };
  const galDefines = G ? { GALAXY: 1 } : {};
  const linkW0 = typeof T.linkW0 === "function" ? T.linkW0 : (r) => Math.min(1.4, Math.max(0.22, 0.42 * r + 0.12));
  const GAL_LINK = (T.link && G ? T.link : [0xb6ff5c, 0x5ce0c8, 0x7f68c4, 0x4a4466]), GAL_LINKK = (T.linkK && G ? T.linkK : [1.9, 1.05, 0.77, 0.64]);
  const galLinkCol = GAL_LINK.map((h, q) => linC(h, GAL_LINKK[q]));
  const galLime = linC(0xb6ff5c, 1.9);
  const notableOf = S.notable || new Uint8Array(N);
  const LZ = G ? [LOD_G2[0], LOD_G2[1], LOD_G3[0], LOD_G3[1]] : FLAT_LOD;   // (veins flat fix) the shader's uLod

  // ------------------------------------------------------------------------------------------------------------
  // 1. GEOMETRY: one polyline per link, parent rim -> child rim, world units
  // ------------------------------------------------------------------------------------------------------------
  let pts = [];
  const NS = 8;                           // samples per cubic
  const sampler = {
    moveTo(x, y) { pts.push(x, y); this.x = x; this.y = y; }, lineTo(x, y) { pts.push(x, y); this.x = x; this.y = y; }, closePath() {},
    bezierCurveTo(x1, y1, x2, y2, x, y) {
      const x0 = this.x, y0 = this.y;
      for (let s = 1; s <= NS; s++) { const t = s / NS, u = 1 - t; pts.push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y); }
      this.x = x; this.y = y;
    },
  };
  // (r2) beta 0.85 -> 0.6 -> 0.5: a soft shared lead-out, never a pinched waist that splays again (brooms / whisks)
  const bundle = line().curve(curveBundle.beta(BETA)).context(sampler);
  // (r2) straighten the tail of a deeper link toward its child: over the last 32 % the spline blends into the chord,
  // so the links of one brood arrive like combed hair, each on its own bearing, instead of fanning out of one point
  const straighten = (P0x, P0y, P1x, P1y) => {
    const n = pts.length / 2; if (n < 3) return;
    const cum = new Float64Array(n); for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]);
    const L = cum[n - 1] || 1;
    for (let k = 1; k < n - 1; k++) {
      const t = cum[k] / L, u = Math.max(0, Math.min(1, (t - STRAIGHT0) / (1 - STRAIGHT0))), w = u * u * (3 - 2 * u);
      if (w <= 0) continue;
      pts[2 * k] += (P0x + (P1x - P0x) * t - pts[2 * k]) * w; pts[2 * k + 1] += (P0y + (P1y - P0y) * t - pts[2 * k + 1]) * w;
    }
  };

  // gen-1 lead-out: a root's children are grouped into angular sectors (contiguous, gap <= 14 deg, width <= 30 deg);
  // each sector's links leave the root together along the sector bearing, then fan to their children. This is
  // what bundling means for the first generation (deeper links already leave along their parent's bearing), and
  // it is why the PUMP / Kimchi hubs read as a few soft trunks instead of a starburst of straight spokes.
  const leadAng = new Float32Array(N);
  const trunkOf = new Int32Array(N).fill(-1);          // links that leave a parent together: a gen-1 sector, else the parent
  let nTrunk = N;                                      // trunk ids: the parent index for gen >= 2, N + k for gen-1 sectors
  for (const f of fams) {
    const ch = kids[f.top]; const n = ch.length; if (!n) continue;
    // a slight, family-consistent curl: even a lone gen-1 link leaves as a drafted arc, never a ruler-straight spoke
    const curl = (rnd(f.id, 17) < 0.5 ? -1 : 1) * 7 * DEG;
    const a = ch.map((c) => [((TH[c] % TAU) + TAU) % TAU, c]).sort((p, q) => p[0] - q[0]);
    let gi = 0, gmax = -1;
    for (let k = 0; k < n; k++) { const g = (k + 1 < n ? a[k + 1][0] : a[0][0] + TAU) - a[k][0]; if (g > gmax) { gmax = g; gi = (k + 1) % n; } }
    // big root broods (> 60, laid out as a phyllotaxis seed head) are NOT gathered into trunks: a dozen trunks over
    // a thousand seeds read as a star; one curled hairline per seed (most of them below the brood budget) reads as an even veil
    const big = n > 60;
    const GAPMAX = big ? 0 : 14 * DEG, WMAX = big ? 0 : 30 * DEG;
    let sec = [], startA = 0, prevA = 0;
    const flush = () => { if (!sec.length) return; let m = 0; for (const s of sec) m += s[0]; m /= sec.length; const id = nTrunk++; for (const s of sec) { leadAng[s[1]] = m + curl; trunkOf[s[1]] = id; } sec = []; };
    for (let j = 0; j < n; j++) {
      const q = a[(gi + j) % n], ang = q[0] + (gi + j >= n ? TAU : 0);
      if (sec.length && (ang - prevA > GAPMAX || ang - startA > WMAX)) flush();
      if (!sec.length) startA = ang;
      sec.push([ang, q[1]]); prevA = ang;
    }
    flush();
  }

  const linkStart = new Int32Array(N).fill(-1), linkLen = new Int32Array(N);
  const polyOff = new Int32Array(N).fill(-1), polyN = new Int32Array(N);
  let PL = new Float32Array(1 << 20), plN = 0;          // packed polyline points (x, y)
  const pushP = (x, y) => { if (plN + 2 > PL.length) { const b = new Float32Array(PL.length * 2); b.set(PL); PL = b; } PL[plN++] = x; PL[plN++] = y; };
  const cut = (ax, ay, bx, by, ox, oy, r) => { let lo = 0, hi = 1; for (let it = 0; it < 14; it++) { const m = (lo + hi) / 2, x = ax + (bx - ax) * m, y = ay + (by - ay) * m; (Math.hypot(x - ox, y - oy) < r) ? (lo = m) : (hi = m); } const m = (lo + hi) / 2; return [ax + (bx - ax) * m, ay + (by - ay) * m]; };
  let nLinks = 0, nPts = 0;
  // (veins lane) galaxy: vIdx[c] = instance of the vein into c (-1 none); vCtl = (u1, v1, u2, v2) in the chord frame
  const vIdx = G ? new Int32Array(N).fill(-1) : null, vCtl = G ? new Float32Array(N * 4) : null;
  let vCount = 0;
  const vB = [0, 0, 0, 0];
  for (let c = 0; c < N; c++) {
    if ((c & 255) === 0) await maybePause();
    const p = par[c]; if (p < 0) continue;
    const f = fams[famOf[c]], d = gen[c];
    if (d !== 1) trunkOf[c] = p;
    const rp = NR[p], rc = NR[c], cx = f.cx, cy = f.cy, dr = rc - rp;
    const pol = (th, r) => [cx + Math.cos(th) * r, cy + Math.sin(th) * r];
    const ctrl = d === 1
      ? [[X[p], Y[p]], pol(leadAng[c], R[p] + 0.35 * dr), pol(TH[c], R[p] + 0.68 * dr), [X[c], Y[c]]]
      : [[X[p], Y[p]], pol(TH[p], rp + dr * 0.42), pol(TH[c], rp + dr * 0.6), [X[c], Y[c]]];
    pts.length = 0; bundle(ctrl);
    if (d !== 1) straighten(X[p], Y[p], X[c], Y[c]);
    if (G) {   // (veins lane) B1, B2 = the designed bundle (centre to centre, uncut) at 1/3 and 2/3 of its arc length
      const n0 = pts.length / 2; let Lb = 0;
      for (let k = 1; k < n0; k++) Lb += Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]);
      const x0 = X[p], y0 = Y[p], x3 = X[c], y3 = Y[c];
      vB[0] = x0 + (x3 - x0) / 3; vB[1] = y0 + (y3 - y0) / 3; vB[2] = x0 + 2 * (x3 - x0) / 3; vB[3] = y0 + 2 * (y3 - y0) / 3;
      if (n0 >= 2 && Lb > 1e-9) {
        let acc = 0, wi = 0, want = Lb / 3;
        for (let k = 1; k < n0 && wi < 2; k++) {
          const ax = pts[2 * k - 2], ay = pts[2 * k - 1], sl = Math.hypot(pts[2 * k] - ax, pts[2 * k + 1] - ay);
          while (wi < 2 && acc + sl >= want) { const u = sl > 0 ? (want - acc) / sl : 0; vB[2 * wi] = ax + (pts[2 * k] - ax) * u; vB[2 * wi + 1] = ay + (pts[2 * k + 1] - ay) * u; wi++; want = 2 * Lb / 3; }
          acc += sl;
        }
      }
      // the cubic through P0, B1 (t = 1/3), B2 (t = 2/3), P3
      const p1x = (-5 * x0 + 18 * vB[0] - 9 * vB[2] + 2 * x3) / 6, p1y = (-5 * y0 + 18 * vB[1] - 9 * vB[3] + 2 * y3) / 6;
      const p2x = (2 * x0 - 9 * vB[0] + 18 * vB[2] - 5 * x3) / 6, p2y = (2 * y0 - 9 * vB[1] + 18 * vB[3] - 5 * y3) / 6;
      const chx = x3 - x0, chy = y3 - y0, L2 = chx * chx + chy * chy, q = 4 * c;
      if (L2 > 1e-12) {   // P = P0 + u ch + v (-ch.y, ch.x)
        vCtl[q] = ((p1x - x0) * chx + (p1y - y0) * chy) / L2; vCtl[q + 1] = (-(p1x - x0) * chy + (p1y - y0) * chx) / L2;
        vCtl[q + 2] = ((p2x - x0) * chx + (p2y - y0) * chy) / L2; vCtl[q + 3] = (-(p2x - x0) * chy + (p2y - y0) * chx) / L2;
      } else { vCtl[q] = 1 / 3; vCtl[q + 1] = 0; vCtl[q + 2] = 2 / 3; vCtl[q + 3] = 0; }
      vIdx[c] = vCount++;
    }
    const n = pts.length / 2, Rp = R[p] + 0.25, Rc = R[c] + 0.25;
    let s0 = -1, s1 = -1;
    for (let k = 1; k < n; k++) if (Math.hypot(pts[2 * k] - X[p], pts[2 * k + 1] - Y[p]) > Rp) { s0 = k; break; }
    for (let k = n - 2; k >= 0; k--) if (Math.hypot(pts[2 * k] - X[c], pts[2 * k + 1] - Y[c]) > Rc) { s1 = k; break; }
    if (s0 < 0 || s1 < 0 || s1 < s0 - 1) continue;
    polyOff[c] = plN;
    const a0 = cut(pts[2 * s0 - 2], pts[2 * s0 - 1], pts[2 * s0], pts[2 * s0 + 1], X[p], Y[p], Rp); pushP(a0[0], a0[1]);
    for (let k = s0; k <= s1; k++) pushP(pts[2 * k], pts[2 * k + 1]);
    const e = cut(pts[2 * s1 + 2], pts[2 * s1 + 3], pts[2 * s1], pts[2 * s1 + 1], X[c], Y[c], Rc); pushP(e[0], e[1]);
    polyN[c] = (plN - polyOff[c]) / 2;
    nLinks++; nPts += polyN[c];
  }

  await maybePause("geometry (tail)");
  // ------------------------------------------------------------------------------------------------------------
  // 1b. (r2) BROOD BUDGET: a parent with n > 8 children spends budgetOf(n) link-equivalents of alpha, water-filled by
  //     importance. dens[c] in (0, 1] is the alpha factor of the link c -> par[c].
  // ------------------------------------------------------------------------------------------------------------
  const sub = new Float32Array(N);                       // descendants per coin
  { const ord = Array.from({ length: N }, (_, i) => i).sort((a, b) => gen[b] - gen[a]); for (const c of ord) { const p = par[c]; if (p >= 0) sub[p] += 1 + sub[c]; } }
  const dens = new Float32Array(N).fill(1);
  for (let p = 0; p < N; p++) {
    const ch = kids[p], n = ch ? ch.length : 0; if (n <= BUDGET_FULL) continue;
    const B = budgetOf(n), w = new Float64Array(n);
    let rest = 0; for (let j = 0; j < n; j++) { const c = ch[j]; w[j] = R[c] * R[c] * (1 + 1.5 * Math.log2(1 + sub[c])) + 1e-9; rest += w[j]; }
    const order = Array.from({ length: n }, (_, j) => j).sort((a, b) => w[b] - w[a]);
    let lam = 0;
    for (let ks = 0; ks < n; ks++) { lam = (B - ks) / rest; if (lam * w[order[ks]] <= 1) break; rest -= w[order[ks]]; }
    for (let j = 0; j < n; j++) dens[ch[j]] = Math.min(1, lam * w[j]);
  }

  await maybePause("brood budget");
  // ------------------------------------------------------------------------------------------------------------
  // 1c. (r2) DETACHED PODS -> TRUNKS. A brood of TRUNK_MIN+ children packed as a pod away from its parent (the crowded-band
  //     tiers: Gato's 371 seeds sit ~54 u out) drew a broom of hundreds of long parallel hairlines. Now the link to the
  //     pod's FRONT child (the one nearest the parent) is promoted to the brood's trunk: full alpha (no budget, no hub
  //     fade), the generation LOD of its parent's level, and the heat of the brood's hottest fifth. The other children
  //     become twigs: they keep their brood budget but take the NEXT generation's LOD window, so up close the twigs
  //     appear and the trunk recedes to 45 %. Pulses of a twig ride the trunk while the twigs are hidden.
  // ------------------------------------------------------------------------------------------------------------
  const kindOf = new Uint8Array(N);                      // 0 link, 1 twig (child of a trunked brood), 2 trunk (pod front child)
  const lodLv = new Float32Array(N);                     // generation-LOD level of each link (gen, +1 for twigs, -1 for trunks)
  const podOf = new Int32Array(N).fill(-1), pods = [];   // parent -> pod index; pod = {p, anchor, n, cnt[4]}
  for (let c = 0; c < N; c++) lodLv[c] = gen[c];
  for (let p = 0; p < N; p++) {
    const ch = kids[p], n = ch ? ch.length : 0; if (n < TRUNK_MIN) continue;
    let cx = 0, cy = 0; for (const c of ch) { cx += X[c]; cy += Y[c]; } cx /= n; cy /= n;
    const ds = ch.map((c) => Math.hypot(X[c] - cx, Y[c] - cy) + R[c]).sort((a, b) => a - b);
    const r85 = ds[Math.min(n - 1, Math.floor(0.85 * n))], D = Math.hypot(cx - X[p], cy - Y[p]);
    if (!(D - r85 - R[p] > Math.max(6, 0.6 * r85) && r85 < 0.7 * D)) continue;   // hugging its parent, or spread around it: no pod
    const ux = (X[p] - cx) / D, uy = (Y[p] - cy) / D;
    let anchor = -1, best = -Infinity;
    for (const c of ch) { if (polyOff[c] < 0) continue; const pr = (X[c] - cx) * ux + (Y[c] - cy) * uy + R[c] - 0.15 * Math.abs((X[c] - cx) * uy - (Y[c] - cy) * ux); if (pr > best) { best = pr; anchor = c; } }
    if (anchor < 0) continue;
    podOf[p] = pods.length; pods.push({ p, anchor, n, cnt: [0, 0, 0, 0] });
    for (const c of ch) { kindOf[c] = 1; lodLv[c] = gen[c] + 1; }
    kindOf[anchor] = 2; lodLv[anchor] = Math.max(1, gen[anchor] - 1); dens[anchor] = 1;
    trunkOf[anchor] = nTrunk++;                          // its own additive budget
  }
  // a pod's trunk takes the heat of its brood's hottest fifth (one live coin in 371 does not make the trunk lime)
  const podClass = (q) => { const need = Math.max(1, Math.ceil(0.2 * q.n)); let s = 0; for (let k = 0; k < 4; k++) { s += q.cnt[k]; if (s >= need) return k; } return 3; };

  await maybePause("pods");
  // ------------------------------------------------------------------------------------------------------------
  // 2. VERTEX DATA (2 vertices per polyline point; side = gl_VertexID parity)
  // ------------------------------------------------------------------------------------------------------------
  const V = nPts * 2;
  const aPos = new Float32Array(V * 2), aNrm = new Float32Array(V * 2), aS = new Float32Array(V * 2);
  const aHeat = new Float32Array(V * 3), aInfo = new Float32Array(V * 4), aPar = new Float32Array(V * 4);
  const aRc = new Float32Array(V * 4), aEmph = new Float32Array(V), aCoin = new Float32Array(V);
  const aW = new Float32Array(V * 2);   // galaxy: (world width, tapered w0 at the parent -> 0.32 w0 at the child; notable flag)
  // (veins look fix) aPar.w = the DRAWN floor of a family top in CSS px (bubbles.js minPx: planets TOK.chipR, dust tops
  // 3 + 3 sqrt(share / maxDustShare) <= 6 px, x uMinScale on phones): the angular room is measured on the rim that is drawn
  let maxDustShare = 0; for (const f of fams) if (!f.planet && (f.share || 0) > maxDustShare) maxDustShare = f.share;
  if (!(maxDustShare > 0)) maxDustShare = 1;
  const topFloor = (f) => (f.planet ? TOK.chipR(f.share, maxShare, false) : Math.max(3, Math.min(6, 3 + 3 * Math.sqrt(Math.max(0, f.share || 0) / maxDustShare))));
  // live links are additive, so a trunk's live links share ONE additive budget: liveK = 1 / max(1, sum of their brood
  // alpha). A lone live link keeps its full alpha; a trunk of live links stays a lime veil and never sums past 1.0
  // (which would bloom). Recomputed per trunk whenever setLinkHeat changes a class.
  const clsOf = new Uint8Array(N), ownCls = new Uint8Array(N), trunkLinks = new Map();
  for (let c = 0; c < N; c++) {
    ownCls[c] = heatClass(age[c]);
    if (par[c] >= 0 && podOf[par[c]] >= 0) pods[podOf[par[c]]].cnt[ownCls[c]]++;
  }
  for (let c = 0; c < N; c++) {
    if (polyOff[c] < 0) continue;
    clsOf[c] = kindOf[c] === 2 ? podClass(pods[podOf[par[c]]]) : ownCls[c];
    let L = trunkLinks.get(trunkOf[c]); if (!L) trunkLinks.set(trunkOf[c], (L = [])); L.push(c);
  }
  const liveKOf = (t, clsNow) => { const L = trunkLinks.get(t); let s = 0; for (const c of L) if (clsNow(c) === 0) s += dens[c]; return 1 / Math.max(1, s); };
  const liveK0 = new Map(); for (const t of trunkLinks.keys()) liveK0.set(t, liveKOf(t, (c) => clsOf[c]));
  let v = 0;
  for (let c = 0; c < N; c++) {
    if ((c & 511) === 0) await maybePause("vertex data");
    if (polyOff[c] < 0) continue;
    const p = par[c], f = fams[famOf[c]], o = polyOff[c], m = polyN[c];
    linkStart[c] = v; linkLen[c] = 2 * m;
    const cls = clsOf[c], lk = liveK0.get(trunkOf[c]);
    const nSib = kindOf[c] === 2 ? 1 : kids[p].length;    // a trunk is one line: no hub fade, no brood floor
    const pMin = p === f.top ? topFloor(f) : 0;              // family tops are drawn at least this big (chip / dust-top floor)
    let Lt = 0; for (let k = 1; k < m; k++) Lt += Math.hypot(PL[o + 2 * k] - PL[o + 2 * k - 2], PL[o + 2 * k + 1] - PL[o + 2 * k - 1]);
    let s = 0;
    const w0 = linkW0(R[c]), w1 = 0.32 * w0, LtW = Math.max(Lt, 1e-4), notC = notableOf[c] ? 1 : 0;
    for (let k = 0; k < m; k++) {
      const x = PL[o + 2 * k], y = PL[o + 2 * k + 1];
      if (k > 0) s += Math.hypot(x - PL[o + 2 * k - 2], y - PL[o + 2 * k - 1]);
      const ka = Math.max(0, k - 1), kb = Math.min(m - 1, k + 1);
      let tx = PL[o + 2 * kb] - PL[o + 2 * ka], ty = PL[o + 2 * kb + 1] - PL[o + 2 * ka + 1]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      for (let sd = 0; sd < 2; sd++, v++) {
        aPos[2 * v] = x; aPos[2 * v + 1] = y; aNrm[2 * v] = -ty; aNrm[2 * v + 1] = tx;
        aS[2 * v] = s; aS[2 * v + 1] = Lt - s;
        aHeat[3 * v] = cls; aHeat[3 * v + 1] = cls; aHeat[3 * v + 2] = -1e4;
        aInfo[4 * v] = f.planet ? 0 : 1; aInfo[4 * v + 1] = f.id; aInfo[4 * v + 2] = gen[c]; aInfo[4 * v + 3] = dens[c];
        aPar[4 * v] = R[p]; aPar[4 * v + 1] = nSib; aPar[4 * v + 2] = R[c]; aPar[4 * v + 3] = pMin;
        aRc[4 * v] = f.Rc; aRc[4 * v + 1] = lk; aRc[4 * v + 2] = lodLv[c]; aRc[4 * v + 3] = kindOf[c]; aCoin[v] = c;
        aW[2 * v] = w0 + (w1 - w0) * (s / LtW); aW[2 * v + 1] = notC;
      }
    }
  }
  await maybePause("vertex data");
  // index buffer: cold -> quiet -> cooling -> live, so live (additive) links are LAST
  const nIdx = (nPts - nLinks) * 6, idx = V > 65535 ? new Uint32Array(nIdx) : new Uint16Array(nIdx);
  const writeIdx = (clsNow) => {        // also re-run (debounced) when live classes change at runtime
    let ii = 0;
    for (const want of [3, 2, 1, 0]) for (let c = 0; c < N; c++) {
      if (linkStart[c] < 0 || clsNow(c) !== want) continue;
      const b = linkStart[c], m = linkLen[c] / 2;
      for (let k = 1; k < m; k++) { const q = b + 2 * k; idx[ii++] = q - 2; idx[ii++] = q - 1; idx[ii++] = q; idx[ii++] = q - 1; idx[ii++] = q + 1; idx[ii++] = q; }
    }
  };
  writeIdx((c) => clsOf[c]);
  const lGeo = new THREE.BufferGeometry();
  lGeo.setAttribute("position", new THREE.BufferAttribute(aPos, 2));
  lGeo.setAttribute("aNrm", new THREE.BufferAttribute(aNrm, 2));
  lGeo.setAttribute("aS", new THREE.BufferAttribute(aS, 2));
  const heatAttr = new THREE.BufferAttribute(aHeat, 3).setUsage(THREE.DynamicDrawUsage);
  const emphAttr = new THREE.BufferAttribute(aEmph, 1).setUsage(THREE.DynamicDrawUsage);
  lGeo.setAttribute("aHeat", heatAttr);
  lGeo.setAttribute("aInfo", new THREE.BufferAttribute(aInfo, 4));
  lGeo.setAttribute("aPar", new THREE.BufferAttribute(aPar, 4));
  const rcAttr = new THREE.BufferAttribute(aRc, 4).setUsage(THREE.DynamicDrawUsage);
  lGeo.setAttribute("aRc", rcAttr);
  lGeo.setAttribute("aEmph", emphAttr);
  lGeo.setAttribute("aCoin", new THREE.BufferAttribute(aCoin, 1));
  lGeo.setAttribute("aW", new THREE.BufferAttribute(aW, 2));
  const idxAttr = new THREE.BufferAttribute(idx, 1);
  lGeo.setIndex(idxAttr);
  lGeo.boundingSphere = bigSphere();

  await maybePause("index + attributes");
  // ------------------------------------------------------------------------------------------------------------
  // 2b. (r2) FOLLOW MOVING COINS: offset texture, texel i = (S.X[i] - X0[i], S.Y[i] - Y0[i], par[i], 0)
  // ------------------------------------------------------------------------------------------------------------
  const X0 = Float32Array.from(X), Y0 = Float32Array.from(Y);     // the designed layout the geometry is baked at
  const OH = Math.ceil((N + 1024) / OW), offData = new Float32Array(OW * OH * 4);
  for (let i = 0; i < N; i++) offData[4 * i + 2] = par[i] >= 0 ? par[i] : i;
  // (map3 port) the 4th channel carries the highlight mask of the link whose CHILD is this texel: w = 4 * target + shown
  // (shown = the value when the last crossfade started, 0..1; target 0 | 1). 5 = matches, no crossfade.
  for (let t = 0; t < OW * OH; t++) offData[4 * t + 3] = 5;
  const offTex = new THREE.DataTexture(offData, OW, OH, THREE.RGBAFormat, THREE.FloatType);
  offTex.magFilter = THREE.NearestFilter; offTex.minFilter = THREE.NearestFilter; offTex.generateMipmaps = false; offTex.needsUpdate = true;
  const offX = new Float32Array(N), offY = new Float32Array(N);  // CPU mirror (world units)
  let offCount = 0, offFrameChanged = 0, offSyncs = 0;
  const offOn = { value: 0 };                                     // shared by the link and arc materials
  const EPS = 1e-4;
  let bornSync = null;   // (integrator, round 2) set in section 5: born links' child ends follow their parent's offset
  function syncOffsets() {
    let changed = 0;
    for (let i = 0; i < N; i++) {
      let dx = X[i] - X0[i], dy = Y[i] - Y0[i];
      if (dx > -EPS && dx < EPS && dy > -EPS && dy < EPS) { dx = 0; dy = 0; }
      if (dx === offX[i] && dy === offY[i]) continue;
      offCount += (dx || dy ? 1 : 0) - (offX[i] || offY[i] ? 1 : 0);
      offX[i] = dx; offY[i] = dy; offData[4 * i] = dx; offData[4 * i + 1] = dy; changed++;
    }
    if (bornSync) changed += bornSync();
    if (changed) { offTex.needsUpdate = true; offOn.value = offCount > 0 ? 1 : 0; offFrameChanged = changed; offSyncs++; }
    return changed;
  }
  // the feel lane hands over the coins it moved this frame (S.drag.moved, n): sync just those (the per-frame scan stays as
  // the safety net for any other mover)
  function syncList(list, n) {
    let changed = 0; const m = Math.min(n | 0, list ? list.length : 0);
    for (let q = 0; q < m; q++) {
      const i = list[q]; if (!(i >= 0 && i < N)) continue;
      let dx = X[i] - X0[i], dy = Y[i] - Y0[i];
      if (dx > -EPS && dx < EPS && dy > -EPS && dy < EPS) { dx = 0; dy = 0; }
      if (dx === offX[i] && dy === offY[i]) continue;
      offCount += (dx || dy ? 1 : 0) - (offX[i] || offY[i] ? 1 : 0);
      offX[i] = dx; offY[i] = dy; offData[4 * i] = dx; offData[4 * i + 1] = dy; changed++;
    }
    if (bornSync) changed += bornSync();
    if (changed) { offTex.needsUpdate = true; offOn.value = offCount > 0 ? 1 : 0; offFrameChanged = changed; offSyncs++; }
    return changed;
  }
  // (local perf 2026-11-09) the per-frame callers (the frame hook and three onBeforeRender hooks) share one scan per frame, and
  // only while a coin may be moving (S.xyScan, motion.js) or every XY_NET_FRAMES as a safety net: an O(N) pass over 58k coins
  // four times a frame at 144-165 Hz was the top JS cost of an idle map. Explicit movers (setPositions, follow) sync directly.
  let syncFrame = -1;
  function syncOffsetsFrame() {
    if (syncFrame === S.frame) return 0;
    syncFrame = S.frame;
    if (!(S.xyScan > 0) && S.frame % XY_NET_FRAMES !== 0) return 0;
    return syncOffsets();
  }
  const offAt = (i, out, o) => { if (i >= 0 && i < N) { out[o] = offX[i]; out[o + 1] = offY[i]; } else { out[o] = 0; out[o + 1] = 0; } };

  const premult = (m) => { m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; m.forceSinglePass = true; return m; };
  const linkCol = TOK.link.map((h) => linC(h));                              // (veins flat fix) heat colours, every class "over" (no additive lime)
  const growC = new Array(4).fill(-1), growT = new Array(4).fill(-1e4);
  const litC = new Array(PULSE_MAX).fill(-1), litT = new Array(PULSE_MAX).fill(-1e4);
  const lU = {
    ...U, ...galU,
    uGalLink: { value: galLinkCol }, uGalLime: { value: galLime },
    uLinkCol: { value: linkCol }, uLinkA: { value: LINK_A.slice() }, uLinkW: { value: TOK.linkW.slice() },
    uLinkWGen1: { value: TOK.linkWGen1 }, uLinkWMax: { value: TOK.linkWMax }, uDimK: { value: TOK.dim },
    uEmphOn: { value: 0 }, uDebugSolid: { value: 0 },
    // (r2)
    uLod: { value: new THREE.Vector4(LZ[0], LZ[1], LZ[2], LZ[3]) },
    // (veins look fix) uFlatW = (gen >= 2 width factor, zoom growth cap sqrt(k / k0) <= sMax, angular-room floor px, 0)
    uFlatW: { value: new THREE.Vector4(FLAT_W.gen2, FLAT_W.sMax, FLAT_W.rim, 0) }, uLodOff: { value: 0 }, uBranchT: { value: 0 },
    uOff: { value: offTex }, uOffOn: offOn, uGrowC: { value: growC }, uGrowT: { value: growT }, uGrowD: { value: SPARK_S },
    // (round 2 final) the link a pulse rides is lit (alpha >= LIT_A) for the pulse's lifetime, so a comet never crosses an
    // empty dot field where the brood budget or the generation LOD hides its link
    uLitC: { value: litC }, uLitT: { value: litT }, uLitN: { value: 0 },
    // (map3 port) highlight: on while a mask is set or crossfading; start of the last crossfade (s, uTime clock)
    uHlOn: { value: 0 }, uHlT0: { value: -1e3 },
  };
  const lMat = premult(new THREE.ShaderMaterial({
    uniforms: lU, defines: { ...galDefines }, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
uniform float uPx, uDpr, uTime, uDustExpand, uHoverFam, uDimMix, uFadeP, uFadeD, uMinScale, uK0, uFocusFam, uFocusMix;
uniform float uGalT, uFlow; uniform vec3 uGalLink[4]; uniform vec3 uGalLime; attribute vec2 aW; varying vec2 vFlow;
uniform vec3 uLinkCol[4]; uniform float uLinkA[4]; uniform float uLinkW[4];
uniform float uLinkWGen1, uLinkWMax, uDimK, uEmphOn, uDebugSolid;
uniform vec4 uFlatW;
uniform vec4 uLod; uniform float uLodOff, uBranchT, uOffOn, uGrowD; uniform float uGrowC[4]; uniform float uGrowT[4];
uniform float uLitC[${PULSE_MAX}]; uniform float uLitT[${PULSE_MAX}]; uniform float uLitN;
uniform float uHlOn, uHlT0;
attribute vec2 aNrm; attribute vec2 aS; attribute vec3 aHeat; attribute vec4 aInfo; attribute vec4 aPar; attribute vec4 aRc; attribute float aEmph; attribute float aCoin;
varying vec3 vCol; varying float vA, vSide, vHw, vLive, vT, vRev; varying vec4 vGap;
${HAIR_GLSL}
${OFF_GLSL}
// generation LOD by level: 1 always, 2 over uLod.xy, 3 over uLod.zw, 4+ over uLod.w -> 1.5 uLod.w (x k0)
float lodOf(float lv, float kk){ return lv < 1.5 ? 1.0 : (lv < 2.5 ? smoothstep(uLod.x, uLod.y, kk) : (lv < 3.5 ? smoothstep(uLod.z, uLod.w, kk) : smoothstep(uLod.w, 1.5 * uLod.w, kk))); }
void main(){
  float k = uPx / uDpr;                                   // CSS px per world unit
  int cls = int(aHeat.x + 0.5), prv = int(aHeat.y + 0.5);
  float fx = smoothstep(aHeat.z, aHeat.z + 0.6, uTime);   // class crossfade (600 ms)
  float Lt = max(aS.x + aS.y, 1e-4), t = aS.x / Lt;       // 0 at the parent rim, 1 at the child rim
#ifdef GALAXY
  float g1 = (aInfo.z < 1.5 || aRc.w > 1.5 ? 1.0 : 0.0) * uLinkWGen1;     // gen-1 links and pod trunks: +0.1 px
  float w = mix(min(uLinkW[prv] + g1, uLinkWMax), min(uLinkW[cls] + g1, uLinkWMax), fx);
  w = mix(w, min(w, ${f3(LONG_W)}), smoothstep(${f3(LONG_PX[0])}, ${f3(LONG_PX[0] + 80)}, Lt * k));   // (round 2 final) long links thin out
#else
  // (veins look fix) hairline core wN = (linkW[cls] + gen-1 bonus) x gen-2 factor x clamp(sqrt(k / k0), 1, sMax), then the
  // brood's ANGULAR ROOM: its n veins share half of the parent's DRAWN rim (pi rRim / n each, floored at uFlatW.z x dens px so
  // the structural veins of a 1,800-brood keep a visible hairline) and half of the circle their far ends sit on
  // (pi (rRim + L) / n); the core tapers from the rim value to the far value over the first 60 % of the vein; cap uLinkWMax.
  // A trunk is one line (aPar.y = 1): no cap. Mirrored by flatWA() in JS.
  bool tier1 = aInfo.z < 1.5 || aRc.w > 1.5;
  float sW = clamp(sqrt(k / uK0), 1.0, uFlatW.y);
  float wN = (mix(uLinkW[prv], uLinkW[cls], fx) + (tier1 ? uLinkWGen1 : 0.0)) * (tier1 ? 1.0 : uFlatW.x) * sW;
  float nSib = max(aPar.y, 1.0);
  float rRim = max(max(aPar.x * k, aPar.w * uMinScale), 1.0);
  // (repair, look fix 2026-10-22) the uFlatW.z floor is scaled by the vein's brood-budget share (aInfo.w = dens, 1 for the
  // structural veins, small for the rest of a big brood): a brood's rim cores then sum to at most pi rRim + 0.75 budgetOf(n)
  // px (Kimchi 4x: 0.72 of the circumference, was 12.2 with the flat floor), so the geometry can no longer become a disc
  // when the alpha rises (hover, selection); the structural veins of a 1,800-brood keep their 0.75 px hairline.
  float fl = uFlatW.z * clamp(aInfo.w, 0.0, 1.0);
  float wP = min(wN, max(3.14159265 * rRim / nSib, fl));
  float wC = min(wN, max(3.14159265 * (rRim + Lt * k) / nSib, fl));
  float w = min(mix(wP, wC, smoothstep(0.0, 0.6, t)), uLinkWMax);
  float covC = min(1.0, min(wC, uLinkWMax) * uDpr);   // coverage at the far end = the vein's widest point (the per-link cull)
#endif
  vec2 hwc = hairWidth(w, uDpr);
#ifdef GALAXY
  // galaxy veins: world-unit width (tapered), floored at 1 px (overview) -> 2.5 px (opened), capped at 14 px, +0.6 px AA
    // (integrator) widths are spec'd at k0 = 1 (1.4 px overview / 5.6 px at 4x for an R = 7 child): divide by k0 so they hold at any fixture scale
  // (fixer 15:10Z) back to the monolith M:341-343: width = aW * uPx (no / k0), floor 1 px at every zoom (no 2.5 px opened floor),
  // coverage alpha 0.42..1, 14 px cap kept: quiet gen-2 veins stay 1 px hairlines in an opened family, big children 3-18 px bands
  { float wpxG = aW.x * uPx, floorG = 1.0 * uDpr; float covG = clamp(wpxG / floorG, 0.42, 1.0); wpxG = clamp(max(wpxG, floorG), 0.0, 14.0 * uDpr); hwc = vec2(wpxG * 0.5 + 0.6 * uDpr, covG); }
#endif
  float side = hairSide();
  // (r2) follow moving coins: blend the parent's and the child's offsets along the arc length. The displaced tangent of a
  // linear blend is exact (T + (offC - offP) / L), so the strip keeps its CSS width however far a coin is dragged.
  vec2 nrm = aNrm, off = vec2(0.0); float stretch = 1.0;
  if (uOffOn > 0.5) {
    vec4 tc = texelFetch(uOff, offUV(int(aCoin + 0.5)), 0);
    vec4 tp = texelFetch(uOff, offUV(int(tc.z + 0.5)), 0);
    off = mix(tp.xy, tc.xy, t);
    vec2 T = vec2(aNrm.y, -aNrm.x) + (tc.xy - tp.xy) / Lt;
    stretch = max(length(T), 1e-4); nrm = vec2(-T.y, T.x) / stretch;
  }
  vec2 p = position.xy + off + nrm * side * hwc.x / uPx;
#ifdef GALAXY
  // galaxy alpha: notable 0.70 / 0.42, x coverage, x dust-open, x (0.55 + 0.45 notable -> 1 as the family opens), hover x 2.6,
  // planet families keep >= 0.30 at the overview (veins are the structure); births draw on, lit paths gain and turn lime
  float notable = aW.y, emS = (aEmph > 1.5 ? 1.0 : 0.0) * uBranchT, em = emS;
  float rev = 1.0, fresh = 0.0, hub = 1.0;
  for (int j = 0; j < 4; j++) if (abs(aCoin - uGrowC[j]) < 0.5) { float u = clamp((uTime - uGrowT[j]) / uGrowD, 0.0, 1.0); rev = 1.0 - (1.0 - u) * (1.0 - u) * (1.0 - u); fresh = 1.0; }
  float a = mix(0.42, 0.70, notable) * hwc.y * mix(0.55 + 0.45 * notable, 1.0, uGalT);
  a *= mix(1.0, 0.45, step(1.5, aInfo.z) * (1.0 - notable));   // (lead) the gen-2+ mass of quiet veins reads as a faint fan, not a wash (ref b/c)
  float isHov = (uHoverFam > -0.5 && abs(aInfo.y - uHoverFam) < 0.5) ? 1.0 : 0.0;
  float ovT = smoothstep(1.3 * uK0, 2.2 * uK0, k);
  a *= max(max(max(ovT, 1.0 - aInfo.x), isHov * uDimMix), max(emS, fresh));   // (fixer) planet veins: no overview fade (M:347); dust keeps it
  a *= mix(1.0, uDustExpand, aInfo.x);
  float litG = 0.0;
  if (uLitN > 0.5) { for (int j = 0; j < ${PULSE_MAX}; j++) { if (abs(aCoin - uLitC[j]) < 0.5) litG = max(litG, clamp(1.0 - (uTime - uLitT[j]) / 1.1, 0.0, 1.0)); } }
  if (uHoverFam > -0.5) { if (isHov > 0.5) a *= 1.0 + 1.6 * uDimMix; else a *= mix(1.0, uDimK, uDimMix); }
  vec3 colG = mix(uGalLink[prv], uGalLink[cls], fx);
  colG = mix(colG, uGalLime, step(0.001, litG)) * (1.0 + 0.8 * litG);
  float spdG = 0.9 * (cls == 0 ? 1.5 : (cls == 3 ? 0.5 : 1.0)) * uFlow;
#else
  // alpha, in the spec's order
  // (veins look fix) base alpha by class (over-blended: no live trunk budget) x the brood budget: dens = aInfo.w (budgetOf(n)
  // link-equivalents water-filled by importance), broods of 9..40 grow x k/4k0 up to x4 past 4 k0; no alpha floor
  float a0 = mix(uLinkA[prv], uLinkA[cls], fx);
  // (r2) emphasis: 1 = hover lineage (motion's setEmphasis), 2 = selected branch (setBranch), 3 = both
  float emH = (mod(aEmph, 2.0) > 0.5 ? 1.0 : 0.0) * uDimMix, emS = (aEmph > 1.5 ? 1.0 : 0.0) * uBranchT, em = max(emH, emS);
  float dz = aPar.y > ${f3(BUDGET_ZOOM[2])} ? aInfo.w : min(1.0, aInfo.w * clamp(k / (uK0 * ${f3(BUDGET_ZOOM[0])}), 1.0, ${f3(BUDGET_ZOOM[1])}));
  // (repair, look fix 2026-10-22) an emphasised branch (hover lineage / selected subtree) gets a brood floor (EMPH_FLOOR / sqrt(n))
  // and NOTHING more: the earlier "max(a, 0.8 a0)" floor lit every one of a 1,800-brood's veins at 0.2-0.4 alpha on hover
  // or selection, which is exactly the starburst / solid disc the owner rejected (measured: Kimchi 4x hover rim ink 2.96,
  // ring r60 97 % lit; the old build 0.05 / 31 %). The budget holds under emphasis as it did in the old build; the floor is
  // EMPH_FLOOR / sqrt(n) (1.5: the old build's 3 at its 2.2x lower linkA, so the hovered 71-brood of inu reads as the same quiet fan).
  float a = a0 * mix(dz, max(dz, min(1.0, ${f3(EMPH_FLOOR)} * inversesqrt(max(aPar.y, 1.0)))), em);
  // (r2) generation LOD: gen-1 always, gen-2 from uLod.xy (x k0), gen-3+ from uLod.zw (twigs one level later, trunks one
  // level earlier); an emphasised branch at any zoom. A trunk recedes to 45 % once its twigs are in.
  float kk = k / uK0;
  // (r2) birth: the link a spark draws on (same cubic ease-out as the spark head) and keeps for FRESH_S whatever the LOD
  float rev = 1.0, fresh = 0.0;
  for (int j = 0; j < 4; j++) if (abs(aCoin - uGrowC[j]) < 0.5) { float u = clamp((uTime - uGrowT[j]) / uGrowD, 0.0, 1.0); rev = 1.0 - (1.0 - u) * (1.0 - u) * (1.0 - u); fresh = 1.0 - smoothstep(${f3(FRESH_S)}, ${f3(FRESH_S + 1)}, uTime - uGrowT[j]); }
  a *= max(max(max(lodOf(aRc.z, kk), em), uLodOff), fresh);
  if (uLitN > 0.5) {   // (round 2 final) a pulse's own link: lit while the pulse runs (rise 100 ms, fade 400 ms after arrival)
    float lit = 0.0;
    for (int j = 0; j < ${PULSE_MAX}; j++) { if (abs(aCoin - uLitC[j]) < 0.5) { float dt = uTime - uLitT[j]; lit = max(lit, smoothstep(0.0, 0.1, dt) * (1.0 - smoothstep(${f3(DUR.pulse / 1000)}, ${f3(DUR.pulse / 1000 + 0.4)}, dt))); } }
    a = max(a, ${f3(LIT_A)} * lit);
  }
  if (aRc.w > 1.5) a *= 1.0 - 0.55 * lodOf(aRc.z + 2.0, kk);
  { float lf = mix(1.0, ${f3(FLAT_W.long[2])}, smoothstep(${f3(FLAT_W.long[0])}, ${f3(FLAT_W.long[1])}, Lt * k)); a *= mix(lf, 1.0, max(em, fresh)); }   // (veins flat fix) mild long fade
  float hub = aPar.y > 40.0 ? mix(0.12, 1.0, smoothstep(0.0, 0.4, t)) : 1.0;   // hub fade near busy parents
  // (coverage hwc.y is applied with the hub fade at the end: it varies along a tapered vein, the per-link cull uses covC)
  a *= smoothstep(${f3(FLAT_W.smallFam[0])}, ${f3(FLAT_W.smallFam[1])}, aRc.x * k);   // specks of families (Rc k < 24 px): no veins
  // (veins flat fix) the owner: veins visible at EVERY zoom, the overview included (no 1.3 k0 -> 2.2 k0 fade-in any more)
  float isHov = (uHoverFam > -0.5 && abs(aInfo.y - uHoverFam) < 0.5) ? 1.0 : 0.0;
  a *= mix(1.0, uDustExpand, aInfo.x);                                        // dust families open on zoom
  if (uHoverFam > -0.5) {
    if (abs(aInfo.y - uHoverFam) < 0.5) {
      // (repair) the hover boost is capped at OV_EMPH_MAX at the overview (-> 0.75 / 0.7 from 2.2 k0 up), as in the old
      // build: a hovered chip at the overview shows a quiet veil, never a starburst
      float ovT = smoothstep(1.3 * uK0, 2.2 * uK0, k);
      float boosted = uEmphOn > 0.5 ? (mod(aEmph, 2.0) > 0.5 ? min(a * 1.8, mix(${f3(OV_EMPH_MAX)}, 0.75, ovT)) : a * 0.6) : min(a * 1.6, mix(${f3(OV_EMPH_MAX)}, 0.7, ovT));
      a = mix(a, boosted, uDimMix);
    } else a *= mix(1.0, uDimK, uDimMix);
  }
#endif
  // focus (final polish): when a family owns the view, the others recede
  if (uFocusFam > -0.5 && abs(aInfo.y - uFocusFam) > 0.5 && abs(aInfo.y - uHoverFam) > 0.5) a *= mix(1.0, ${f3(FOCUS_DIM)}, uFocusMix);
  a *= mix(uFadeP, uFadeD, aInfo.x);
  // (map3 port) highlight: the link of a child that does not match dims like the hover dim (constant along the link, so the
  // per-link cull below still holds)
  if (uHlOn > 0.5) {
    float hw = texelFetch(uOff, offUV(int(aCoin + 0.5)), 0).w, hc = step(2.0, hw), hs = hw - 4.0 * hc;
    a *= mix(uDimK, 1.0, mix(hs, hc, smoothstep(uHlT0, uHlT0 + 0.16, uTime)));
  }
#ifdef GALAXY
  if (uDebugSolid > 0.5) a = hwc.y;
#else
  if (uDebugSolid > 0.5) a = 1.0;   // x coverage below
#endif
  // drafted ends (evaluated per fragment): the parent end clears its chip / 24 h arc, the child end its rim or arc
  float rpv = max(aPar.x * k, aPar.w * uMinScale);
  float gp = (rpv >= 8.0 ? 3.5 : 2.0) + max(0.0, rpv - aPar.x * k);
  float gc = aPar.z * k >= 8.0 ? 3.0 : 2.0;
  if (uDebugSolid > 0.5) { gp = 0.0; gc = 0.0; }
  vGap = vec4(aS.x * k * stretch, aS.y * k * stretch, gp, gc);
  vT = t; vRev = rev;
#ifdef GALAXY
  vLive = 1.0; vCol = colG; vFlow = vec2(aS.x, spdG);   // additive, heat-coloured, HDR (blooms); flow phase along the arc length
#else
  vLive = 0.0;   // (round 2 final) neutral links blend "over" in every class: nothing stacks past its own alpha
  vCol = mix(uLinkCol[prv], uLinkCol[cls], fx);
#endif
#ifdef GALAXY
  vA = a * hub;
#else
  vA = a * hwc.y * hub;   // (veins look fix) coverage last: it varies along a tapered vein
#endif
  vSide = side; vHw = hwc.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 0.0, 1.0);
  // (integration) the cull must be decided PER LINK: every factor of a is constant along a link except the hub fade, so it
  // is left out here. A per-vertex cull let a triangle keep one live vertex and send the others to clip (2, 2): a hairline
  // sliver shot from the colony to the top-right corner. Sub-threshold fragments are still discarded in the fragment shader.
  // (veins look fix) flat: the coverage varies along the vein too, so the cull reads the far end's (its maximum).
#ifdef GALAXY
  if (a < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
#else
  if (a * covC < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
#endif
}`,
    fragmentShader: /* glsl */`
varying vec3 vCol; varying float vA, vSide, vHw, vLive, vT, vRev; varying vec4 vGap;
#ifdef GALAXY
uniform float uPx, uDpr, uAnimT, uGalT; varying vec2 vFlow;
#endif
void main(){
  float e = clamp(vHw - abs(vSide) * vHw, 0.0, 1.0);
  float g = smoothstep(vGap.z - 0.5, vGap.z + 0.5, vGap.x) * smoothstep(vGap.w - 0.5, vGap.w + 0.5, vGap.y);
  float a = vA * e * g;
  if (vRev < 0.999) a *= 1.0 - smoothstep(vRev - 0.02, vRev, vT);
#ifdef GALAXY
  // flow: a 28 px dash train runs parent -> child (live x 1.5, cold x 0.5; uFlow = 0 under reduced motion); additive, so
  // scaling a scales the colour
  { float ph = fract((vFlow.x * uPx / uDpr) / 28.0 - uAnimT * vFlow.y); float dash = smoothstep(0.30, 0.55, ph) * (1.0 - smoothstep(0.75, 1.0, ph)); float amp = mix(0.15, 0.30, uGalT); a *= 1.0 - amp + 2.0 * amp * dash; }
#endif
  if (a < 0.002) discard;
#ifdef GALAXY
  gl_FragColor = vec4(vCol * a, 0.0);   // (galaxy) additive like the monolith: veins add light, never cover the field
#else
  gl_FragColor = vec4(vCol * a, a * (1.0 - vLive));
#endif
}`,
  }));
  // (veins lane) galaxy: the baked hairline mesh stays built (heat / emphasis bookkeeping, linkInk, born links share its
  // material) but is not drawn; the live-cubic vein mesh below is the galaxy's links mesh
  const links = new THREE.Mesh(lGeo, lMat); links.frustumCulled = false; links.renderOrder = 4; if (!G) scene.add(links);
  // the drag sim may run after this lane's frame hook: sync the offsets right before drawing too (texture + uniform
  // uploads happen after onBeforeRender, so links never trail a dragged coin by a frame)
  links.onBeforeRender = () => { syncOffsetsFrame(); };

  // ------------------------------------------------------------------------------------------------------------
  // 2c. (veins lane) GALAXY VEINS: one InstancedBufferGeometry; base strip (NSEG + 1) x 2 vertices, position = (t, side, 0);
  //     instances: aEnds (p, c), aCtl (u1, v1, u2, v2), aW (w0 at build, notable, gen, tTrade = uTime - age),
  //     aMeta (fam, flags: 1 hover lineage + 2 selected branch, dust, s = clamp((log10 mc - 4) / 3, 0, 1)).
  //     uPos: RGBA32F, texel i = (X, Y, Rdraw, minPx), re-uploaded whenever any of them changes (scan per frame + right
  //     before drawing, so a dragged coin's veins never trail it).
  // ------------------------------------------------------------------------------------------------------------
  let veins = null, vGeo = null, vMat = null, posTex = null, posData = null, vWv = null, vMeta = null, vWAttr = null, vMetaAttr = null;
  let vWDirty = false, vMetaDirty = false, posSig = 0, posUploads = 0;
  const vList = [];
  let syncPos = () => 0;
  if (G) {
    S.U.uFocusCoin ??= { value: -1 }; S.U.uFocusT ??= { value: 0 }; S.U.uFocusDim ??= { value: 0 };
    const NSEG = S.phone() ? VEIN.nsegPhone : VEIN.nseg, PW = VEIN.PW, PH = Math.max(1, Math.ceil(N / PW));
    const base = new Float32Array((NSEG + 1) * 2 * 3), bIdx = new Uint16Array(NSEG * 6);
    for (let j = 0; j <= NSEG; j++) for (let sd = 0; sd < 2; sd++) { const q = 2 * j + sd; base[3 * q] = j / NSEG; base[3 * q + 1] = sd ? 1 : -1; }
    for (let j = 0; j < NSEG; j++) { const q = 2 * j; bIdx.set([q, q + 1, q + 2, q + 1, q + 3, q + 2], 6 * j); }
    const nV = vCount, iEnds = new Float32Array(nV * 2), iCtl = new Float32Array(nV * 4);
    vWv = new Float32Array(nV * 4); vMeta = new Float32Array(nV * 4);
    const vDen = new Float32Array(nV);
    const tNow = U.uTime.value, mcA = S.mc || null;
    // (fixer) per-family vein density D = n Lmean / (pi Rc^2) (world^-1); overlap px = D W / uPx in the VS
    const famN = new Float64Array(fams.length), famL = new Float64Array(fams.length);
    for (let c = 0; c < N; c++) { if (vIdx[c] < 0) continue; const id = famOf[c]; famN[id]++; famL[id] += Math.hypot(X[c] - X[par[c]], Y[c] - Y[par[c]]); }
    for (let c = 0; c < N; c++) {
      const q = vIdx[c]; if (q < 0) continue;
      vList[q] = c;
      const f = fams[famOf[c]], ag = age ? age[c] : Infinity, mcc = mcA ? mcA[c] : 0;
      iEnds[2 * q] = par[c]; iEnds[2 * q + 1] = c;
      iCtl.set(vCtl.subarray(4 * c, 4 * c + 4), 4 * q);
      vWv[4 * q] = linkW0(R[c]); vWv[4 * q + 1] = notableOf[c] ? 1 : 0; vWv[4 * q + 2] = gen[c];
      vWv[4 * q + 3] = Number.isFinite(ag) ? tNow - Math.max(0, ag) : -1e9;
      vMeta[4 * q] = f.id; vMeta[4 * q + 1] = 0; vMeta[4 * q + 2] = f.planet ? 0 : 1;
      vMeta[4 * q + 3] = mcc > 0 ? Math.max(0, Math.min(1, (Math.log10(mcc) - 4) / 3)) : 0;
      const rc = Math.max(f.Rc || 0, 1e-3); vDen[q] = famL[f.id] / (Math.PI * rc * rc);
    }
    vGeo = new THREE.InstancedBufferGeometry();
    vGeo.setAttribute("position", new THREE.BufferAttribute(base, 3));
    vGeo.setIndex(new THREE.BufferAttribute(bIdx, 1));
    vGeo.setAttribute("aEnds", new THREE.InstancedBufferAttribute(iEnds, 2));
    vGeo.setAttribute("aCtl", new THREE.InstancedBufferAttribute(iCtl, 4));
    vWAttr = new THREE.InstancedBufferAttribute(vWv, 4).setUsage(THREE.DynamicDrawUsage); vGeo.setAttribute("aW", vWAttr);
    vMetaAttr = new THREE.InstancedBufferAttribute(vMeta, 4).setUsage(THREE.DynamicDrawUsage); vGeo.setAttribute("aMeta", vMetaAttr);
    vGeo.setAttribute("aDen", new THREE.InstancedBufferAttribute(vDen, 1));
    vGeo.instanceCount = nV; vGeo.boundingSphere = bigSphere();
    posData = new Float32Array(PW * PH * 4);
    posTex = new THREE.DataTexture(posData, PW, PH, THREE.RGBAFormat, THREE.FloatType);
    posTex.magFilter = THREE.NearestFilter; posTex.minFilter = THREE.NearestFilter; posTex.generateMipmaps = false;
    syncPos = (force = false) => {
      const Rd = S.Rdraw && S.Rdraw.length >= N ? S.Rdraw : null, Mp = S.minPx && S.minPx.length >= N ? S.minPx : null;
      let ch = 0;
      for (let i = 0; i < N; i++) {
        const o = 4 * i, x = X[i], y = Y[i], r = Math.fround(Rd ? Rd[i] : R[i]), m = Math.fround(Mp ? Mp[i] : VEIN.minPx0);
        if (!force && posData[o] === x && posData[o + 1] === y && posData[o + 2] === r && posData[o + 3] === m) continue;
        posData[o] = x; posData[o + 1] = y; posData[o + 2] = r; posData[o + 3] = m; ch++;
      }
      if (ch) { posTex.needsUpdate = true; posSig++; posUploads++; }
      return ch;
    };
    syncPos(true);
    const srgb = (h) => new THREE.Vector3(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);
    const vU = {
      ...U, ...galU, uPos: { value: posTex }, uOff: { value: offTex }, uOffOn: offOn,
      uHeat: { value: VEIN.heat.map(srgb) }, uLimeL: { value: linC(0xb6ff5c, 1.9) },
      uDimK: lU.uDimK, uBranchT: lU.uBranchT, uEmphOn: lU.uEmphOn, uLitC: lU.uLitC, uLitT: lU.uLitT, uLitN: lU.uLitN,
      uGrowC: lU.uGrowC, uGrowT: lU.uGrowT, uGrowD: lU.uGrowD, uHlOn: lU.uHlOn, uHlT0: lU.uHlT0,
      uFocusCoin: S.U.uFocusCoin, uFocusT: S.U.uFocusT, uFocusDim: S.U.uFocusDim,
    };
    if (!vU.uFocusFam) vU.uFocusFam = { value: -1 };
    if (!vU.uFocusMix) vU.uFocusMix = { value: 0 };
    vMat = premult(new THREE.ShaderMaterial({
      uniforms: vU, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
uniform sampler2D uPos;
uniform float uPx, uDpr, uTime, uDustExpand, uHoverFam, uDimMix, uFadeP, uFadeD, uFocusFam, uFocusMix, uGalT, uFlow, uDimK, uBranchT, uK0;
uniform float uFocusCoin, uFocusT, uFocusDim;
uniform vec3 uHeat[4]; uniform vec3 uLimeL;
uniform float uGrowC[4]; uniform float uGrowT[4]; uniform float uGrowD;
uniform float uLitC[${PULSE_MAX}]; uniform float uLitT[${PULSE_MAX}]; uniform float uLitN;
uniform float uHlOn, uHlT0;
attribute vec2 aEnds; attribute vec4 aCtl; attribute vec4 aW; attribute vec4 aMeta; attribute float aDen;
varying vec3 vCol; varying float vA, vD, vCore, vGl, vT, vRev, vS, vSpd, vLen, vRP, vRC, vDash, vCap;
${OFF_GLSL}
ivec2 posUV(int i){ return ivec2(i - (i / ${VEIN.PW}) * ${VEIN.PW}, i / ${VEIN.PW}); }
vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void main(){
  float t = position.x, side = position.y;
  int ip = int(aEnds.x + 0.5), ic = int(aEnds.y + 0.5);
  vec4 Pp = texelFetch(uPos, posUV(ip), 0), Pc = texelFetch(uPos, posUV(ic), 0);
  // the LIVE cubic: P0 = parent centre, P3 = child centre, P1 / P2 rebuilt on the live chord
  vec2 P0 = Pp.xy, P3 = Pc.xy, chd = P3 - P0, nch = vec2(-chd.y, chd.x);
  vec2 P1 = P0 + aCtl.x * chd + aCtl.y * nch, P2 = P0 + aCtl.z * chd + aCtl.w * nch;
  float u = 1.0 - t, Lw = length(chd);
  vec2 B = u * u * u * P0 + 3.0 * u * u * t * P1 + 3.0 * u * t * t * P2 + t * t * t * P3;
  vec2 dB = 3.0 * u * u * (P1 - P0) + 6.0 * u * t * (P2 - P1) + 3.0 * t * t * (P3 - P2);
  float dl = length(dB);
  vec2 tg = dl > 1e-6 ? dB / dl : (Lw > 1e-6 ? chd / Lw : vec2(1.0, 0.0));
  vec2 nr = vec2(-tg.y, tg.x);
  float notable = aW.y, gen = aW.z, age = max(0.0, uTime - aW.w);
  float grey = (notable < 0.5 && age > 10800.0) ? 1.0 : 0.0;   // (fixer) quiet / cold non-notable: grey-white, no dash
  float hair = grey * step(1.5, gen);                            // ... and a hairline from gen 2 (no violet sheet over the fan)
  float fam = aMeta.x, flags = aMeta.y, dust = aMeta.z;
  // width, device px: core = max(w0 px, F), capped, tapered to 0.6x at the child (never below F), each end capped at 1.6 rimPx
  float rimP = max(Pp.z * uPx, Pp.w * uDpr), rimC = max(Pc.z * uPx, Pc.w * uDpr);
  float w0 = clamp(${f3(VEIN.wK)} * Pc.z + ${f3(VEIN.wB)}, ${f3(VEIN.wMin)}, ${f3(VEIN.wMax)});
  float F = uDpr * (1.0 + 1.5 * aMeta.w) * (notable > 0.5 ? 1.25 : 1.0);
  float core = min(max(w0 * uPx / (${VEIN.wPerK0 ? "max(uK0, 1e-6)" : "1.0"}), F), ${f3(VEIN.capPx)} * uDpr);
  core = max(core * mix(1.0, ${f3(VEIN.taper)}, t), F);
  if (hair > 0.5) core = F;
  float dP = t * Lw * uPx, dC = (1.0 - t) * Lw * uPx;
  core = min(core, min(${f3(VEIN.endCap)} * rimP + 0.5 * max(0.0, dP - rimP), ${f3(VEIN.endCap)} * rimC + 0.5 * max(0.0, dC - rimC)));
  float gl = (min(${f3(VEIN.glowK)} * core, ${f3(VEIN.glowMax)} * uDpr) + ${f3(VEIN.glowB)} * uDpr) * (1.0 - hair), hw = 0.5 * core + gl + 0.5 * uDpr;
  vec2 p = B + nr * side * hw / max(uPx, 1e-6);
  // alpha
  float a = notable > 0.5 ? ${f3(VEIN.aNotable)} : ${f3(VEIN.aOther)};
  if (gen > 1.5 && notable < 0.5) a *= ${f3(VEIN.aGen2)};
  a *= age > 86400.0 ? ${f3(VEIN.aCold)} : (age > 10800.0 ? ${f3(VEIN.aQuiet)} : 1.0);
  a *= mix(${f3(VEIN.aOv)}, 1.0, uGalT);
  { float ov = aDen * (core + 2.0 * gl) / max(uPx, 1e-6); a *= mix(clamp(${f3(VEIN.ovK)} / max(ov, 1e-4), ${f3(VEIN.ovMin)}, 1.0), 1.0, uGalT); }   // overview only (the opened family is sparse in px)
  a *= mix(1.0, mix(${f3(VEIN.aDust)}, 1.0, uDustExpand), dust);
  float emH = mod(flags, 2.0) > 0.5 ? 1.0 : 0.0, emS = (flags > 1.5 ? 1.0 : 0.0) * uBranchT;
  a *= 1.0 + 0.5 * emS + 0.35 * emH * uDimMix;
  float rev = 1.0;
  for (int j = 0; j < 4; j++) if (abs(aEnds.y - uGrowC[j]) < 0.5) { float g = clamp((uTime - uGrowT[j]) / uGrowD, 0.0, 1.0); rev = 1.0 - (1.0 - g) * (1.0 - g) * (1.0 - g); }
  float litG = 0.0;
  if (uLitN > 0.5) { for (int j = 0; j < ${PULSE_MAX}; j++) { if (abs(aEnds.y - uLitC[j]) < 0.5) litG = max(litG, clamp(1.0 - (uTime - uLitT[j]) / 1.1, 0.0, 1.0)); } }
  float isHov = (uHoverFam > -0.5 && abs(fam - uHoverFam) < 0.5) ? 1.0 : 0.0;
  if (uHoverFam > -0.5) { if (isHov > 0.5) a *= 1.0 + 1.6 * uDimMix; else a *= mix(1.0, uDimK, uDimMix); }
  // (fixer) galaxy: neighbours do not recede while a family is open (the ref keeps them lit); the pulse dim stays
  a *= mix(uFadeP, uFadeD, dust);
  if (uHlOn > 0.5) {
    float hwk = texelFetch(uOff, offUV(ic), 0).w, hc = step(2.0, hwk), hs = hwk - 4.0 * hc;
    a *= mix(uDimK, 1.0, mix(hs, hc, smoothstep(uHlT0, uHlT0 + 0.16, uTime)));
  }
  // colour: the monolith's continuous heatHex x heatBoost x (live ? 1 : 0.85), linear, HDR
  vec3 hs3 = age <= 1800.0 ? uHeat[0] : (age <= 10800.0 ? mix(uHeat[0], uHeat[1], (age - 1800.0) / 9000.0) : (age <= 86400.0 ? mix(uHeat[1], uHeat[2], (age - 10800.0) / 75600.0) : uHeat[3]));
  float hb = age <= 1800.0 ? 1.9 : (age <= 10800.0 ? 1.0 + 0.5 * (1.0 - (age - 1800.0) / 9000.0) : (age <= 86400.0 ? 0.9 : 0.75));
  vec3 col = toLin(hs3) * hb * (age <= 1800.0 ? 1.0 : 0.85);
  if (grey > 0.5) col = toLin(vec3(${[0xa8, 0xb0, 0xac].map((v) => (v / 255).toFixed(4)).join(", ")})) * ${f3(VEIN.hairK)};
  col = mix(col, uLimeL, step(0.001, litG)) * (1.0 + 0.8 * litG);
  // focus: the focused coin's veins light up lime, the rest recede
  float isF = (uFocusCoin > -0.5 && (abs(aEnds.x - uFocusCoin) < 0.5 || abs(aEnds.y - uFocusCoin) < 0.5)) ? 1.0 : 0.0;
  if (isF > 0.5) { a *= 1.0 + ${f3(VEIN.focusA)} * uFocusT; col = mix(col, uLimeL / 1.9, uFocusT); } else a *= 1.0 - ${f3(VEIN.focusDim)} * uFocusDim;
  vCol = col; vA = a; vD = side * hw; vCore = core; vGl = gl; vT = t; vRev = rev;
  vLen = Lw * uPx / uDpr; vRP = rimP / uDpr; vRC = rimC / uDpr; vDash = grey > 0.5 ? 0.0 : ${f3(VEIN.dashAmp)};
  vCap = isF > 0.5 ? 1.0 : ((notable > 0.5 && gen < 1.5) ? 8.0 : ${f3(VEIN.hotCap)});
  vS = t * Lw * uPx / uDpr; vSpd = 0.9 * (age <= 1800.0 ? 1.5 : (age > 86400.0 ? 0.5 : 1.0)) * uFlow;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 0.0, 1.0);
  if (a < 0.002 || Lw * uPx < 0.25) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // per-instance cull (every factor is per vein)
}`,
      fragmentShader: /* glsl */`
uniform float uAnimT;
varying vec3 vCol; varying float vA, vD, vCore, vGl, vT, vRev, vS, vSpd, vLen, vRP, vRC, vDash, vCap;
void main(){
  float dd = abs(vD), hc = 0.5 * vCore;
  float cA = 1.0 - smoothstep(hc - 0.3, hc + 0.3, dd);                 // AA core, 0.6 px edge
  float dO = max(0.0, dd - hc) / max(vGl, 1e-3);
  float a = vA * (cA + (1.0 - cA) * ${f3(VEIN.glowA)} * exp(-3.0 * dO * dO));   // + the glow outside the core
  if (vRev < 0.999) a *= 1.0 - smoothstep(vRev - 0.02, vRev, vT);      // a birth draws its vein on
  { float ph = fract(vS / 28.0 - uAnimT * vSpd); float dash = smoothstep(0.30, 0.55, ph) * (1.0 - smoothstep(0.75, 1.0, ph));
    // (fixer) no dash run at either rim (G3): the amplitude fades in over 1.5 rimPx past each rim
    float amp = vDash * smoothstep(vRP, 2.5 * vRP + 2.0, vS) * smoothstep(vRC, 2.5 * vRC + 2.0, vLen - vS);
    a *= 1.0 - amp + 2.0 * amp * dash; }
  if (a < 0.002) discard;
  vec3 cc = vCol * a; float cm = max(cc.r, max(cc.g, cc.b)); if (cm > vCap) cc *= vCap / cm;   // hue-preserving cap
  gl_FragColor = vec4(cc, 0.0);   // additive under the premultiplied One / OneMinusSrcAlpha blend
}`,
    }));
    veins = new THREE.Mesh(vGeo, vMat); veins.frustumCulled = false; veins.renderOrder = 4; scene.add(veins);
    veins.onBeforeRender = () => { syncOffsetsFrame(); syncPos(); };
  }
  // CPU mirror of the live cubic of the vein into c (parent -> child), n segments -> out[2 (n + 1)] world
  const cubicInto = (c, n, out) => {
    const p = par[c], q = 4 * c, x0 = X[p], y0 = Y[p], chx = X[c] - x0, chy = Y[c] - y0;
    const p1x = x0 + vCtl[q] * chx - vCtl[q + 1] * chy, p1y = y0 + vCtl[q] * chy + vCtl[q + 1] * chx;
    const p2x = x0 + vCtl[q + 2] * chx - vCtl[q + 3] * chy, p2y = y0 + vCtl[q + 2] * chy + vCtl[q + 3] * chx;
    for (let k = 0; k <= n; k++) {
      const t = k / n, u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      out[2 * k] = b0 * x0 + b1 * p1x + b2 * p2x + b3 * X[c]; out[2 * k + 1] = b0 * y0 + b1 * p1y + b2 * p2y + b3 * Y[c];
    }
    return out;
  };
  const wK0 = () => (VEIN.wPerK0 ? Math.max(U.uK0.value, 1e-6) : 1);   // the shader's w0 scale (CSS px per world at k0)
  const hasLink = (c) => (vIdx ? c >= 0 && c < N && vIdx[c] >= 0 : c >= 0 && c < N && polyOff[c] >= 0);

  await maybePause("offsets + material");
  // ------------------------------------------------------------------------------------------------------------
  // 3. GENERATION ARCS: hairline arcs over the occupied angles of each generation (never empty full circles)
  // ------------------------------------------------------------------------------------------------------------
  const wrapA = (a) => ((a % TAU) + TAU) % TAU;
  function mergeSpans(iv, pad, gapMerge) {
    if (!iv.length) return [];
    const s = iv.map(([a0, a1]) => { const b = wrapA(a0 - pad); return [b, b + (a1 - a0) + 2 * pad]; }).sort((p, q) => p[0] - q[0]);
    const out = [];
    for (const q of s) { const l = out[out.length - 1]; if (l && q[0] - l[1] < gapMerge) l[1] = Math.max(l[1], q[1]); else out.push(q.slice()); }
    // wrap-around: the last span may reach (or nearly reach) the first one across 2PI
    if (out.length > 1) { const f0 = out[0], l = out[out.length - 1]; if (f0[0] + TAU - l[1] < gapMerge) { l[1] = Math.max(l[1], f0[1] + TAU); out.shift(); } }
    let cov = 0; for (const q of out) cov += q[1] - q[0];
    if (cov >= 354 * DEG || out.some((q) => q[1] - q[0] >= 354 * DEG)) return [[0, TAU]];
    return out;
  }
  const arcInfo = new Map();
  for (const f of fams) {
    const nG = f.count ? f.count.length : f.maxGen + 1;
    if (G) {   // galaxy: a full ring at every generation's mean radius; planets at every zoom, dust families when opened
      if (nG < 2 || !f.ring || (!f.planet && f.members.length < 4)) continue;
      const list = []; for (let d = 1; d < nG; d++) if (f.ring[d] > 0.5) list.push({ gen: d, r: f.ring[d], spans: [[0, TAU]], coarse: !f.planet });
      if (list.length) arcInfo.set(f.id, list);
      continue;
    }
    // spec: 2+ generations and Rc >= 30 u; layout packs families under 40 members with narrow gutters and no arcs
    if (nG < 2 || !(f.Rc >= 30) || f.members.length < 40) continue;
    const byG = []; for (const i of f.members) { const g = gen[i]; if (g > 0) (byG[g] ||= []).push(i); }
    const list = [];
    for (let d = 1; d < byG.length; d++) {
      const mem = byG[d]; if (!mem || !mem.length) continue;
      if (f.noArc && f.noArc[d]) continue;   // (final polish) a generation with a pulled-in stray has no clean gutter
      let r = f.arcR && f.arcR[d] > 0 ? f.arcR[d] : 0;
      if (!r) { let mn = Infinity; for (const i of mem) mn = Math.min(mn, NR[i] - R[i]); r = mn - 0.5 * GAPR; }
      if (!(r > 1)) continue;
      let spans = f.genSpan && f.genSpan[d] && f.genSpan[d].length ? f.genSpan[d].map(([a0, a1]) => a1 >= a0 ? [a0, a1] : [a0, a1 + TAU]) : null;
      if (spans) { if (spans.some((q) => q[1] - q[0] >= 354 * DEG)) spans = [[0, TAU]]; }
      else spans = mergeSpans(mem.map((i) => { const h = Math.asin(Math.min(1, (R[i] + 0.4) / Math.max(NR[i], 1e-3))); return [TH[i] - h, TH[i] + h]; }), 3 * DEG, 8 * DEG);
      // (integration) an arc names a GROUP of a generation. A span holding 1-2 coins (a lone far brood, e.g. PUMP's sparse
      // gen 3 or USDC's single gen-3 coin) drew a 6-10 deg scratch that read as a stray line, and got a 'GEN 3 · 1' tag.
      // Keep spans with >= 3 members; a generation with none left gets no arc and no tag.
      if (!(spans.length === 1 && spans[0][1] - spans[0][0] >= TAU - 1e-6)) {
        spans = spans.filter(([a0, a1]) => { if (a1 - a0 < 20 * DEG) return false; let n = 0; for (const i of mem) { if (((TH[i] - a0) % TAU + TAU) % TAU <= a1 - a0 && ++n >= 3) return true; } return false; });
        if (!spans.length) continue;
      }
      list.push({ gen: d, r, spans });
    }
    if (list.length) arcInfo.set(f.id, list);
  }
  let gV = 0;
  const segsOf = (r, span, coarse = false) => coarse ? 48 : Math.max(2, Math.ceil(span / Math.min(0.035, Math.max(0.005, Math.sqrt(0.05 / r)))));
  for (const [, list] of arcInfo) for (const a of list) for (const [a0, a1] of a.spans) gV += 2 * (segsOf(a.r, a1 - a0, a.coarse) + 1);
  const gPos = new Float32Array(gV * 2), gNrm = new Float32Array(gV * 2), gArc = new Float32Array(gV * 4), gR = new Float32Array(gV * 3);
  let gIdxN = 0; for (const [, list] of arcInfo) for (const a of list) for (const [a0, a1] of a.spans) gIdxN += 6 * segsOf(a.r, a1 - a0, a.coarse);
  const gIdx = gV > 65535 ? new Uint32Array(gIdxN) : new Uint16Array(gIdxN);
  { let w = 0, q = 0;
    for (const [fid, list] of arcInfo) {
      const f = fams[fid];
      for (const a of list) for (const [a0, a1] of a.spans) {
        const full = a1 - a0 >= TAU - 1e-6, ns = segsOf(a.r, a1 - a0, a.coarse), base = w;
        for (let s = 0; s <= ns; s++) {
          const th = a0 + (a1 - a0) * s / ns, ct = Math.cos(th), st = Math.sin(th), endD = full ? 1e3 : Math.min(th - a0, a1 - th);
          for (let sd = 0; sd < 2; sd++, w++) {
            gPos[2 * w] = f.cx + ct * a.r; gPos[2 * w + 1] = f.cy + st * a.r; gNrm[2 * w] = ct; gNrm[2 * w + 1] = st;
            gArc[4 * w] = fid; gArc[4 * w + 1] = a.gen; gArc[4 * w + 2] = th; gArc[4 * w + 3] = endD;
            gR[3 * w] = a.r; gR[3 * w + 1] = f.Rc; gR[3 * w + 2] = f.planet ? 0 : 1;
          }
          if (s > 0) { const b = base + 2 * s; gIdx[q++] = b - 2; gIdx[q++] = b - 1; gIdx[q++] = b; gIdx[q++] = b - 1; gIdx[q++] = b + 1; gIdx[q++] = b; }
        }
      }
    }
  }
  const gGeo = new THREE.BufferGeometry();
  gGeo.setAttribute("position", new THREE.BufferAttribute(gPos, 2));
  gGeo.setAttribute("aNrm", new THREE.BufferAttribute(gNrm, 2));
  gGeo.setAttribute("aArc", new THREE.BufferAttribute(gArc, 4));
  gGeo.setAttribute("aR", new THREE.BufferAttribute(gR, 3));
  gGeo.setIndex(new THREE.BufferAttribute(gIdx, 1));
  gGeo.boundingSphere = bigSphere();
  const knock = Array.from({ length: 12 }, () => new THREE.Vector4(-1, -1, 0, 0));
  // (final polish) an arc is drawn only where the labels lane placed its tag: a generation ring always says what it is
  const gU = { ...U, ...galU, uKnock: { value: knock }, uFocusFam: { value: -1 }, uTagFam: { value: -1 }, uGenShow: { value: new Array(16).fill(0) }, uArcCol: { value: linC(G ? (T.genArc ?? 0x1bbe93) : TOK.ink) },
    uArcA: { value: G ? (T.genArcA ?? 0.16) : TOK.genArcA }, uArcAF: { value: TOK.genArcAFocus }, uArcW: { value: TOK.genArcW }, uDimK: { value: TOK.dim },
    // (r2) arcs follow the tagged family's top while coins move, and fade while the family is deformed (they would no
    // longer sit in the gutter between generations)
    uArcOff: { value: new THREE.Vector2() }, uArcFade: { value: 1 } };
  const gMat = premult(new THREE.ShaderMaterial({
    uniforms: gU, defines: { ...galDefines }, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
uniform float uPx, uDpr, uHoverFam, uDimMix, uFadeP, uFocusFam, uArcA, uArcAF, uArcW, uDimK, uTagFam, uArcFade; uniform vec2 uArcOff;
uniform float uGenShow[16]; uniform float uK0, uDustExpand;
attribute vec2 aNrm; attribute vec4 aArc; attribute vec3 aR;
varying float vA, vSide, vHw, vAng, vRk, vEnd; varying vec2 vFG;
${HAIR_GLSL}
void main(){
  float k = uPx / uDpr;
  vec2 hwc = hairWidth(uArcW, uDpr);
  float side = hairSide();
#ifdef GALAXY
  // galaxy: every planet family's generation rings at every zoom (0.16, hovered / focused x 2.5), dust families when opened;
  // only the tagged family follows its dragged top (uArcOff) and fades while deformed
  float isTag = abs(aArc.x - uTagFam) < 0.5 ? 1.0 : 0.0;
  vec2 p = position.xy + uArcOff * isTag + aNrm * side * hwc.x / uPx;
  float isHF = (abs(aArc.x - uHoverFam) < 0.5 || abs(aArc.x - uFocusFam) < 0.5) ? 1.0 : 0.0;
  float a = uArcA * smoothstep(0.12 * uK0, 0.5 * uK0, k) * hwc.y * mix(1.0, 2.5, isHF) * mix(1.0, uDustExpand, aR.z) * uFadeP * mix(1.0, uArcFade, isTag);
  if (uHoverFam > -0.5 && abs(aArc.x - uHoverFam) > 0.5) a *= mix(1.0, uDimK, uDimMix);
#else
  vec2 p = position.xy + uArcOff + aNrm * side * hwc.x / uPx;
  bool hot = abs(aArc.x - uTagFam) < 0.5 && uGenShow[int(clamp(aArc.y, 0.0, 15.0) + 0.5)] > 0.5;
  // (final polish) generation arcs belong to the family you are looking at: the focused or hovered one only
  float a = (hot ? uArcAF : 0.0) * hwc.y * smoothstep(220.0, 320.0, aR.y * k) * uFadeP * uArcFade;
  if (uHoverFam > -0.5 && abs(aArc.x - uHoverFam) > 0.5) a *= mix(1.0, uDimK, uDimMix);
#endif
  vA = a; vSide = side; vHw = hwc.x; vAng = aArc.z; vRk = aR.x * k; vEnd = aArc.w; vFG = aArc.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 0.0, 1.0);
  if (a < 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`,
    fragmentShader: /* glsl */`
uniform vec3 uArcCol; uniform vec4 uKnock[12];
varying float vA, vSide, vHw, vAng, vRk, vEnd; varying vec2 vFG;
const float PI = 3.141592653589793;
void main(){
  float e = clamp(vHw - abs(vSide) * vHw, 0.0, 1.0);
  float a = vA * e * smoothstep(0.0, 0.0524, vEnd);          // ends feather over the 3 deg padding
  for (int j = 0; j < 12; j++) {
    vec4 q = uKnock[j];
    if (q.x < -0.5) continue;
    if (abs(q.x - vFG.x) < 0.5 && abs(q.y - vFG.y) < 0.5) {
      float d = vAng - q.z; d = abs(d - 2.0 * PI * floor((d + PI) / (2.0 * PI)));
      a *= smoothstep(q.w, q.w + 1.5 / max(vRk, 1e-3), d);     // contour-label knock-out, 1.5 px soft edge
    }
  }
  if (a < 0.001) discard;
#ifdef GALAXY
  gl_FragColor = vec4(uArcCol * a, 0.0);   // additive
#else
  gl_FragColor = vec4(uArcCol * a, a);
#endif
}`,
  }));
  const genArcs = new THREE.Mesh(gGeo, gMat); genArcs.frustumCulled = false; genArcs.renderOrder = 2; scene.add(genArcs);
  // (r2) arcs draw before the links: the offset sync runs here first (cheap when nothing moved), then the arc follow
  let arcDevFam = -2, arcDevSig = -1;
  function arcFollow() {
    const fam = gU.uTagFam.value;
    if (!offCount || fam < 0) { gU.uArcOff.value.set(0, 0); gU.uArcFade.value = 1; return; }
    const f = fams[fam]; if (!f) return;
    const top = f.top, ox = offX[top], oy = offY[top];
    gU.uArcOff.value.set(ox, oy);
    if (arcDevFam !== fam || arcDevSig !== offSyncs) {          // max deviation from the top's offset, in world units
      arcDevFam = fam; arcDevSig = offSyncs; let m = 0;
      for (const i of f.members) { const d = Math.hypot(offX[i] - ox, offY[i] - oy); if (d > m) m = d; }
      arcFollow.dev = m;
    }
    const px = (arcFollow.dev || 0) * S.cam.k, u = Math.max(0, Math.min(1, (px - 1.5) / 4.5));
    gU.uArcFade.value = 1 - u * u * (3 - 2 * u);
  }
  genArcs.onBeforeRender = () => { syncOffsetsFrame(); arcFollow(); };
  const setKnockouts = (list = []) => {
    for (let j = 0; j < 12; j++) { const q = list[j]; if (q && q.fam >= 0) knock[j].set(q.fam, q.gen, q.angle, q.half); else knock[j].set(-1, -1, 0, 0); }
    S.invalidate();
  };
  const setTagged = (fam, gens = []) => {
    gU.uTagFam.value = fam >= 0 ? fam : -1; const g = gU.uGenShow.value; g.fill(0); for (const d of gens) if (d >= 0 && d < 16) g[d] = 1; S.invalidate();
  };
  const genArcInfo = (famId) => (arcInfo.get(famId) || []).map((a) => ({ gen: a.gen, r: a.r, spans: a.spans.map((q) => q.slice()) }));

  await maybePause("generation arcs");
  // ------------------------------------------------------------------------------------------------------------
  // 4. HULL RING: one 128-segment hairline circle, moved by uniforms
  // ------------------------------------------------------------------------------------------------------------
  const HS = 128, hPos = new Float32Array((HS + 1) * 4), hIdx = new Uint16Array(HS * 6);
  for (let s = 0; s <= HS; s++) { const a = s / HS * TAU; for (let sd = 0; sd < 2; sd++) { hPos[(2 * s + sd) * 2] = Math.cos(a); hPos[(2 * s + sd) * 2 + 1] = Math.sin(a); } if (s > 0) { const b = 2 * s; hIdx.set([b - 2, b - 1, b, b - 1, b + 1, b], (s - 1) * 6); } }
  const hGeo = new THREE.BufferGeometry(); hGeo.setAttribute("position", new THREE.BufferAttribute(hPos, 2)); hGeo.setIndex(new THREE.BufferAttribute(hIdx, 1)); hGeo.boundingSphere = bigSphere();
  const hU = { ...U, uHullC: { value: new THREE.Vector2() }, uHullR: { value: 1 }, uHullA: { value: 0 }, uHullCol: { value: linC(TOK.hover) }, uHullK: { value: TOK.hullA }, uHullW: { value: TOK.genArcW } };
  const hMat = premult(new THREE.ShaderMaterial({
    uniforms: hU, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
uniform float uPx, uDpr, uHullR, uHullW; uniform vec2 uHullC;
varying float vSide, vHw, vCov;
${HAIR_GLSL}
void main(){
  vec2 hwc = hairWidth(uHullW, uDpr); float side = hairSide();
  vec2 p = uHullC + position.xy * uHullR + position.xy * side * hwc.x / uPx;
  // the ring names a family that is SMALL on screen (overview hover); once the family fills the view the
  // generation arcs carry its structure and an outline at f.Rc would only be an empty circle: fade 160 -> 320 px
  vSide = side; vHw = hwc.x; vCov = hwc.y * (1.0 - smoothstep(160.0, 320.0, uHullR * uPx / uDpr));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 0.0, 1.0);
}`,
    fragmentShader: /* glsl */`
uniform vec3 uHullCol; uniform float uHullA, uHullK, uFadeP;
varying float vSide, vHw, vCov;
void main(){ float a = uHullK * uHullA * uFadeP * vCov * clamp(vHw - abs(vSide) * vHw, 0.0, 1.0); if (a < 0.001) discard; gl_FragColor = vec4(uHullCol * a, a); }`,
  }));
  const hull = new THREE.Mesh(hGeo, hMat); hull.frustumCulled = false; hull.renderOrder = 3; hull.visible = false; scene.add(hull);
  // galaxy: orbit circles around every planet family (the reference's faint rings): r = 1.04 Rc, 0x5ce0c8, 0.75 px,
  // alpha 0.10 (1 - 0.6 uGalT), additive. Built once in world space (they do not follow a drag; neither does the hull).
  let orbits = null, oGeo = null, oMat = null;
  if (G) {
    const PL_ = (S.planets || fams.filter((f) => f.planet)), OS = 96, nO = PL_.length;
    const oPos = new Float32Array(nO * (OS + 1) * 4), oNrm = new Float32Array(nO * (OS + 1) * 4), oTop = new Float32Array(nO * (OS + 1) * 2);
    const oIdx = nO * (OS + 1) * 2 > 65535 ? new Uint32Array(nO * OS * 6) : new Uint16Array(nO * OS * 6);
    let w = 0, q = 0;
    for (const f of PL_) {
      const r = 1.04 * f.Rc, base = w;
      for (let sg = 0; sg <= OS; sg++) {
        const a = sg / OS * TAU, ct = Math.cos(a), st = Math.sin(a);
        for (let sd = 0; sd < 2; sd++, w++) { oPos[2 * w] = f.cx + ct * r; oPos[2 * w + 1] = f.cy + st * r; oNrm[2 * w] = ct; oNrm[2 * w + 1] = st; oTop[w] = f.top; }
        if (sg > 0) { const b = base + 2 * sg; oIdx[q++] = b - 2; oIdx[q++] = b - 1; oIdx[q++] = b; oIdx[q++] = b - 1; oIdx[q++] = b + 1; oIdx[q++] = b; }
      }
    }
    oGeo = new THREE.BufferGeometry(); oGeo.setAttribute("position", new THREE.BufferAttribute(oPos, 2)); oGeo.setAttribute("aNrm", new THREE.BufferAttribute(oNrm, 2)); oGeo.setAttribute("aTop", new THREE.BufferAttribute(oTop, 1)); oGeo.setIndex(new THREE.BufferAttribute(oIdx, 1)); oGeo.boundingSphere = bigSphere();
    // (veins lane) orbits follow their family: the top's offset (= f.cx/f.cy - home, as the physics keeps it) from uOff
    oMat = premult(new THREE.ShaderMaterial({
      uniforms: { ...U, ...galU, uOrbCol: { value: linC(T.orbit ?? 0x5ce0c8) }, uOrbA: { value: T.orbitA ?? 0.10 }, uOff: { value: offTex }, uOffOn: offOn }, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
uniform float uPx, uDpr, uGalT, uFadeP, uOrbA, uOffOn; attribute vec2 aNrm; attribute float aTop;
varying float vSide, vHw, vA;
${HAIR_GLSL}
${OFF_GLSL}
void main(){
  vec2 hwc = hairWidth(0.75, uDpr); float side = hairSide();
  vec2 off = uOffOn > 0.5 ? texelFetch(uOff, offUV(int(aTop + 0.5)), 0).xy : vec2(0.0);
  vec2 p = position.xy + off + aNrm * side * hwc.x / uPx;
  vSide = side; vHw = hwc.x; vA = uOrbA * (1.0 - 0.6 * uGalT) * hwc.y * uFadeP;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 0.0, 1.0);
}`,
      fragmentShader: /* glsl */`
uniform vec3 uOrbCol; varying float vSide, vHw, vA;
void main(){ float a = vA * clamp(vHw - abs(vSide) * vHw, 0.0, 1.0); if (a < 0.001) discard; gl_FragColor = vec4(uOrbCol * a, 0.0); }`,
    }));
    orbits = new THREE.Mesh(oGeo, oMat); orbits.frustumCulled = false; orbits.renderOrder = 3; scene.add(orbits);
  }
  const easeOut = bez(...EASE.out), easeStd = bez(...EASE.std);
  const HULL_MS = DUR.s;
  const hT = { fam: -1, from: null, to: null, t0: 0, run: false };
  hU.uHullK.value = 0;   // (final polish) the ring is retired; show() still marks the focused family for the arcs
  const showHull = (famId = -1) => {
    const f = famId >= 0 ? fams[famId] : null;
    gU.uFocusFam.value = f ? famId : -1;
    if (hU.uHullK.value === 0) { hT.fam = f ? famId : -1; hull.visible = false; return; }
    if ((f ? famId : -1) === hT.fam) return;
    hT.fam = f ? famId : -1;
    const cur = { x: hU.uHullC.value.x, y: hU.uHullC.value.y, r: hU.uHullR.value, a: hU.uHullA.value };
    const to = f ? { x: f.cx, y: f.cy, r: f.Rc, a: 1 } : { ...cur, a: 0 };
    if (cur.a < 0.02 && f) Object.assign(cur, { x: to.x, y: to.y, r: to.r });   // appearing: no slide, just fade in
    hT.from = cur; hT.to = to; hT.t0 = performance.now(); hT.run = true; hull.visible = true; S.invalidate();
  };


  await maybePause("hull");
  // ------------------------------------------------------------------------------------------------------------
  // 5. EVENT MARKS (r2): pulses (child -> parent) and birth sparks (parent -> child) share 24 slots of 16 tail samples
  //    + a head quad, one draw; family flashes are 24 ring quads, one draw. Both at renderOrder 11 (the pulse layer).
  // ------------------------------------------------------------------------------------------------------------
  const TAIL = 16, PV = TAIL * 2 + 4, PI6 = (TAIL - 1) * 6 + 6;
  const pPos = new Float32Array(PULSE_MAX * PV * 2), pUV = new Float32Array(PULSE_MAX * PV * 2), pK = new Float32Array(PULSE_MAX * PV * 3), pIdx = new Uint16Array(PULSE_MAX * PI6);
  for (let j = 0; j < PULSE_MAX; j++) {
    const b = j * PV, o = j * PI6;
    for (let s = 1; s < TAIL; s++) { const q = b + 2 * s; pIdx.set([q - 2, q - 1, q, q - 1, q + 1, q], o + (s - 1) * 6); }
    const h = b + TAIL * 2; pIdx.set([h, h + 1, h + 2, h, h + 2, h + 3], o + (TAIL - 1) * 6);
  }
  const pGeo = new THREE.BufferGeometry();
  const pPosA = new THREE.BufferAttribute(pPos, 2).setUsage(THREE.DynamicDrawUsage), pUVA = new THREE.BufferAttribute(pUV, 2).setUsage(THREE.DynamicDrawUsage), pKA = new THREE.BufferAttribute(pK, 3).setUsage(THREE.DynamicDrawUsage);
  pGeo.setAttribute("position", pPosA); pGeo.setAttribute("aUV", pUVA); pGeo.setAttribute("aK", pKA); pGeo.setIndex(new THREE.BufferAttribute(pIdx, 1)); pGeo.boundingSphere = bigSphere();
  const pU = { uPulseCol: { value: linC(TOK.pulse) }, uPulseK: { value: TOK.pulseK } };
  const pMat = premult(new THREE.ShaderMaterial({
    uniforms: pU, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
attribute vec2 aUV; attribute vec3 aK; varying vec2 vUV; varying vec3 vK;
void main(){ vUV = aUV; vK = aK; gl_Position = projectionMatrix * viewMatrix * vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
uniform vec3 uPulseCol; uniform float uPulseK;
varying vec2 vUV; varying vec3 vK;   // vK = (kind 0 tail | 1 head, alpha, half-width or radius in device px)
void main(){
  float a;
  vec3 col = uPulseCol;
  float head = step(0.5, vK.x);
  if (head < 0.5) a = vK.y * clamp(vK.z - abs(vUV.y), 0.0, 1.0);
  else if (vK.x < 1.5) { a = vK.y * (1.0 - smoothstep(vK.z - 0.375, vK.z + 0.375, length(vUV))); col *= uPulseK; }
  else { float d = length(vUV); a = vK.y * clamp(0.9 - abs(d - (vK.z - 0.75)), 0.0, 1.0); col *= uPulseK; }   // (round 2 final) a SELL: hollow head
  if (a < 0.002) discard;
  // tail: premultiplied OVER (so tail + a live link under it can never pass 1.0); head: additive and HDR (x1.4),
  // the only part of a pulse that reaches the bloom
  gl_FragColor = vec4(col * a, a * (1.0 - head));
}`,
  }));
  const pulseMesh = new THREE.Mesh(pGeo, pMat); pulseMesh.frustumCulled = false; pulseMesh.renderOrder = 11; pulseMesh.visible = false; scene.add(pulseMesh);

  // family flash rings: one quad each, the ring is computed per fragment (1 CSS px, over-blended, never above 1.0)
  const fPos = new Float32Array(FLASH_MAX * 4 * 2), fUV = new Float32Array(FLASH_MAX * 4 * 2), fK = new Float32Array(FLASH_MAX * 4 * 3), fIdx = new Uint16Array(FLASH_MAX * 6);
  for (let j = 0; j < FLASH_MAX; j++) { const h = j * 4; fIdx.set([h, h + 1, h + 2, h, h + 2, h + 3], j * 6); }
  const fGeo = new THREE.BufferGeometry();
  const fPosA = new THREE.BufferAttribute(fPos, 2).setUsage(THREE.DynamicDrawUsage), fUVA = new THREE.BufferAttribute(fUV, 2).setUsage(THREE.DynamicDrawUsage), fKA = new THREE.BufferAttribute(fK, 3).setUsage(THREE.DynamicDrawUsage);
  fGeo.setAttribute("position", fPosA); fGeo.setAttribute("aUV", fUVA); fGeo.setAttribute("aK", fKA); fGeo.setIndex(new THREE.BufferAttribute(fIdx, 1)); fGeo.boundingSphere = bigSphere();
  const fMat = premult(new THREE.ShaderMaterial({
    uniforms: { uCol: { value: linC(TOK.pulse) } }, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
attribute vec2 aUV; attribute vec3 aK; varying vec2 vUV; varying vec3 vK;
void main(){ vUV = aUV; vK = aK; gl_Position = projectionMatrix * viewMatrix * vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
uniform vec3 uCol;
varying vec2 vUV; varying vec3 vK;   // vK = (ring radius, alpha, half-width incl. the AA ramp), device px
void main(){
  float a = vK.y * clamp(vK.z - abs(length(vUV) - vK.x), 0.0, 1.0);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uCol * a, a);
}`,
  }));
  const flashMesh = new THREE.Mesh(fGeo, fMat); flashMesh.frustumCulled = false; flashMesh.renderOrder = 11; flashMesh.visible = false; scene.add(flashMesh);

  const slots = Array.from({ length: PULSE_MAX }, () => null);
  const flashes = Array.from({ length: FLASH_MAX }, () => null);
  const st = { born: 0, pulses: 0, sparks: 0, flashes: 0, degraded: 0, evicted: 0, refused: 0, merged: 0, arrived: 0, sparkArrived: 0, peak: 0 };
  const isCoin = (v) => Number.isInteger(v) && v >= 0 && v < N;
  const cumOf = (pl) => { const m = pl.length / 2, cum = new Float32Array(m); for (let k = 1; k < m; k++) cum[k] = cum[k - 1] + Math.hypot(pl[2 * k] - pl[2 * k - 2], pl[2 * k + 1] - pl[2 * k - 1]); return cum; };
  // the base (designed-layout) polyline of link c in travel order: dir +1 = child -> parent, -1 = parent -> child
  // (veins lane) galaxy: a link's path is the vein's LIVE cubic (same control points as the shader), refreshed whenever
  // the position texture changed (P.sig vs posSig); s0 / s1 cut it at the drawn rims, so pulses ride the moving vein
  const cubTmp = new Float32Array(2 * (VEIN.cpuSeg + 1));
  const rimW = (i) => {
    const k = S.cam.k || 1, Rd = S.Rdraw && S.Rdraw.length >= N ? S.Rdraw[i] : R[i], Mp = S.minPx && S.minPx.length >= N ? S.minPx[i] : VEIN.minPx0;
    return Math.max(Rd, Mp / k);
  };
  function livePath(P) {
    const c = P.live, n = VEIN.cpuSeg, m = n + 1;
    if (!P.pl || P.pl.length !== 2 * m) { P.pl = new Float32Array(2 * m); P.cum = new Float32Array(m); }
    cubicInto(c, n, cubTmp);
    for (let k = 0; k < m; k++) { const kk = P.dir > 0 ? m - 1 - k : k; P.pl[2 * k] = cubTmp[2 * kk]; P.pl[2 * k + 1] = cubTmp[2 * kk + 1]; }
    P.cum[0] = 0; for (let k = 1; k < m; k++) P.cum[k] = P.cum[k - 1] + Math.hypot(P.pl[2 * k] - P.pl[2 * k - 2], P.pl[2 * k + 1] - P.pl[2 * k - 1]);
    P.L = P.cum[m - 1] || 1e-6;
    const ra = rimW(P.dir > 0 ? c : par[c]), rb = rimW(P.dir > 0 ? par[c] : c);
    P.s0 = Math.min(ra, 0.45 * P.L); P.s1 = Math.max(P.L - rb, 0.55 * P.L);
    P.sig = posSig;
  }
  function pathOfLink(c, dir) {
    if (vIdx && vIdx[c] >= 0) { const P = { live: c, dir, a: -1, b: -1, sig: -1, pl: null, cum: null, L: 1e-6, s0: 0, s1: 0 }; livePath(P); return P; }
    const o = polyOff[c], m = polyN[c], pl = new Float32Array(m * 2);
    for (let k = 0; k < m; k++) { const kk = dir > 0 ? m - 1 - k : k; pl[2 * k] = PL[o + 2 * kk]; pl[2 * k + 1] = PL[o + 2 * kk + 1]; }
    const cum = cumOf(pl), L = cum[m - 1] || 1e-6;
    return { pl, cum, L, a: dir > 0 ? c : par[c], b: dir > 0 ? par[c] : c, s0: 0, s1: L };
  }
  // a path between two world points with no link (a newborn not in the geometry): a gentle drafted arc, rim to rim
  function pathOfPoints(A, B, seed) {
    const n = 17, dx = B.x - A.x, dy = B.y - A.y, L0 = Math.hypot(dx, dy) || 1e-6, bend = (rnd(seed, 23) < 0.5 ? -1 : 1) * 0.14 * L0;
    const mx = (A.x + B.x) / 2 - (dy / L0) * bend, my = (A.y + B.y) / 2 + (dx / L0) * bend, pl = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) { const t = k / (n - 1), u = 1 - t; pl[2 * k] = u * u * A.x + 2 * u * t * mx + t * t * B.x; pl[2 * k + 1] = u * u * A.y + 2 * u * t * my + t * t * B.y; }
    const cum = cumOf(pl), L = cum[n - 1] || 1e-6;
    return { pl, cum, L, a: -1, b: -1, s0: Math.min(L * 0.45, (A.r || 0) + 0.25), s1: Math.max(L * 0.55, L - (B.r || 0) - 0.25) };
  }
  // ---- links of coins born after load (amendment C): drawn on behind their spark, then a link like any other ----
  const BV = BORN_MAX * BORN_PTS * 2, bornBase = OW * OH - BORN_MAX;   // offset-texture ids of the born links (texel z = parent)
  const bA = { position: new Float32Array(BV * 2), aNrm: new Float32Array(BV * 2), aS: new Float32Array(BV * 2), aHeat: new Float32Array(BV * 3), aInfo: new Float32Array(BV * 4), aPar: new Float32Array(BV * 4), aRc: new Float32Array(BV * 4), aEmph: new Float32Array(BV), aCoin: new Float32Array(BV), aW: new Float32Array(BV * 2) };
  const bSize = { position: 2, aNrm: 2, aS: 2, aHeat: 3, aInfo: 4, aPar: 4, aRc: 4, aEmph: 1, aCoin: 1, aW: 2 };
  const bGeo = new THREE.BufferGeometry(), bAttr = {};
  for (const k of Object.keys(bA)) { bAttr[k] = new THREE.BufferAttribute(bA[k], bSize[k]).setUsage(THREE.DynamicDrawUsage); bGeo.setAttribute(k, bAttr[k]); }
  { const ix = new Uint32Array(BORN_MAX * (BORN_PTS - 1) * 6); let q = 0; for (let j = 0; j < BORN_MAX; j++) for (let k = 1; k < BORN_PTS; k++) { const v = j * BORN_PTS * 2 + 2 * k; ix[q++] = v - 2; ix[q++] = v - 1; ix[q++] = v; ix[q++] = v - 1; ix[q++] = v + 1; ix[q++] = v; } bGeo.setIndex(new THREE.BufferAttribute(ix, 1)); }
  bGeo.boundingSphere = bigSphere();
  for (let v = 0; v < BV; v++) bA.aRc[4 * v] = 0;      // famRc 0: an unused slot is fully culled (smoothstep(40, 140, 0) = 0)
  const bornMesh = new THREE.Mesh(bGeo, lMat); bornMesh.frustumCulled = false; bornMesh.renderOrder = 4; bornMesh.visible = false; scene.add(bornMesh);
  const born = [];                                      // [{slot, p, t0, cls}]
  let bornNext = 0;
  // (integrator, round 2) the child end of a born link carries the parent's offset, so the link stays rim to rim while the
  // parent's family is dragged (motion moves the newborn's bubble by the same offset: S.bubbles.moveCoin)
  bornSync = () => {
    let c = 0;
    for (const b of born) { const o = 4 * b.id, dx = offX[b.p], dy = offY[b.p]; if (offData[o] !== dx || offData[o + 1] !== dy) { offData[o] = dx; offData[o + 1] = dy; c++; } }
    return c;
  };
  function addBornLink(p, path, t) {
    if (!isCoin(p)) return -1;
    const j = bornNext++ % BORN_MAX, id = bornBase + j, f = fams[famOf[p]];
    const prev = born.findIndex((b) => b.slot === j); if (prev >= 0) born.splice(prev, 1);
    offData[4 * id] = 0; offData[4 * id + 1] = 0; offData[4 * id + 2] = p; offTex.needsUpdate = true;
    // resample the spark's path between the parent rim and the child rim into BORN_PTS points
    const L = path.s1 - path.s0, pts = new Float32Array(BORN_PTS * 4), tmp4 = [0, 0, 0, 0], o0 = offCount; offCount = 0;   // base path, no offsets
    for (let k = 0; k < BORN_PTS; k++) { at(path, path.s0 + L * k / (BORN_PTS - 1), tmp4); pts.set(tmp4, 4 * k); }
    offCount = o0;
    // the spark's path is in CURRENT positions; the shader adds the parent's offset (blended to 0 at the child), so bake
    // the link at the parent's designed position (a birth next to a family that is still gliding home lands right)
    const opx = offX[p], opy = offY[p];
    if (opx || opy) for (let k = 0; k < BORN_PTS; k++) { const w = 1 - k / (BORN_PTS - 1); pts[4 * k] -= opx * w; pts[4 * k + 1] -= opy * w; }
    const cr = path.childR || 0;
    for (let k = 0; k < BORN_PTS; k++) for (let sd = 0; sd < 2; sd++) {
      const v = (j * BORN_PTS + k) * 2 + sd, s = L * k / (BORN_PTS - 1);
      bA.position[2 * v] = pts[4 * k]; bA.position[2 * v + 1] = pts[4 * k + 1]; bA.aNrm[2 * v] = -pts[4 * k + 3]; bA.aNrm[2 * v + 1] = pts[4 * k + 2];
      bA.aS[2 * v] = s; bA.aS[2 * v + 1] = L - s;
      bA.aHeat.set([0, 0, -1e4], 3 * v);
      bA.aInfo.set([f.planet ? 0 : 1, f.id, gen[p] + 1, 1], 4 * v);
      bA.aPar.set([R[p], 1, cr, p === f.top ? topFloor(f) : 0], 4 * v);
      bA.aRc.set([f.Rc, 1, gen[p] + 1, 0], 4 * v); bA.aEmph[v] = 0; bA.aCoin[v] = id;
      { const bw0 = linkW0(cr || 0.55); bA.aW[2 * v] = bw0 + (0.32 * bw0 - bw0) * (k / (BORN_PTS - 1)); bA.aW[2 * v + 1] = 1; }
    }
    for (const k of Object.keys(bAttr)) bAttr[k].needsUpdate = true;
    // (map3 port) the born link's highlight follows its newborn (path.childIdx, the engine's coin index) when known
    const ci = Number.isInteger(path.childIdx) ? path.childIdx : -1;
    offData[4 * id + 3] = ci >= 0 && typeof S.hlBit === "function" && !S.hlBit(ci) ? 0 : 5;
    born.push({ slot: j, id, p, t0: t, cls: 0, ci }); bornMesh.visible = true; st.born++;
    return id;
  }
  // a born link's heat follows its coin's age (the coin was born live and cools like any other)
  function ageBorn(tNow) {
    for (const b of born) {
      const cls = heatClass(Math.max(0, tNow - b.t0)); if (cls === b.cls) continue;
      const v0 = b.slot * BORN_PTS * 2; for (let v = v0; v < v0 + BORN_PTS * 2; v++) bA.aHeat.set([cls, b.cls, tNow], 3 * v);
      b.cls = cls; bAttr.aHeat.needsUpdate = true; lastHeatT = Math.max(lastHeatT, tNow); S.invalidate();
    }
  }
  // public: the link of a coin born after load with NO spark (reduced motion, or a birth found by polling): parent coin ->
  // world point (x, y), child radius r (world u). Returns an id (>= N, private to links) or -1.
  const bornLink = (p, x, y, r = 0, ci = -1) => {
    const A = ptOf(p), B = ptOf({ x, y, r }); if (!isCoin(p) || !A || !B) return -1;
    const path = pathOfPoints(A, B, Math.round(x * 131 + y * 17)); path.childR = r || 0; path.childIdx = ci;
    return addBornLink(p, path, U.uTime.value);
  };
  const ptOf = (v) => {
    if (Number.isInteger(v) && v >= 0 && S.X && v < S.X.length && Number.isFinite(S.X[v])) return { x: S.X[v], y: S.Y[v], r: (S.R && S.R[v]) || 0 };
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x, y: v.y, r: v.r || 0 };
    return null;
  };
  function takeSlot(pool) {
    let j = pool.indexOf(null);
    if (j < 0) { j = 0; for (let q = 1; q < pool.length; q++) if (pool[q].t0 < pool[j].t0) j = q; st.evicted++; }   // oldest first
    return j;
  }
  // current points of link c (child rim -> parent rim), following moved coins
  const linkPolyline = (c) => {
    if (vIdx && isCoin(c) && vIdx[c] >= 0) {   // (veins lane) the live cubic, child rim -> parent rim, 17 points
      const P = pathOfLink(c, +1), m = VEIN.cpuSeg + 1, out = new Float32Array(2 * m), t4 = [0, 0, 0, 0];
      for (let k = 0; k < m; k++) { at(P, P.s0 + (P.s1 - P.s0) * k / (m - 1), t4); out[2 * k] = t4[0]; out[2 * k + 1] = t4[1]; }
      return out;
    }
    if (!isCoin(c) || polyOff[c] < 0) return null;
    const P = pathOfLink(c, +1), m = P.cum.length, out = new Float32Array(m * 2);
    const ax = offX[P.a], ay = offY[P.a], bx = offX[P.b], by = offY[P.b];
    for (let k = 0; k < m; k++) { const t = P.cum[k] / P.L; out[2 * k] = P.pl[2 * k] + ax + (bx - ax) * t; out[2 * k + 1] = P.pl[2 * k + 1] + ay + (by - ay) * t; }
    return out;
  };
  const lodJS = (lv, kk) => (lv < 1.5 ? 1 : lv < 2.5 ? smoothN(LZ[0], LZ[1], kk) : lv < 3.5 ? smoothN(LZ[2], LZ[3], kk) : smoothN(LZ[3], 1.5 * LZ[3], kk));
  // a twig whose own link is still hidden: hop from the child to the pod's front child, then ride the trunk home
  function pathViaTrunk(c) {
    const q = pods[podOf[par[c]]], A = pathOfLink(q.anchor, +1);
    const sx = X0[c], sy = Y0[c], ex = A.pl[0], ey = A.pl[1], d = Math.hypot(ex - sx, ey - sy) || 1e-6, r0 = Math.min(R[c] + 0.25, d * 0.4);
    const m = A.cum.length, pl = new Float32Array((m + 1) * 2);
    pl[0] = sx + (ex - sx) / d * r0; pl[1] = sy + (ey - sy) / d * r0; pl.set(A.pl, 2);
    const cum = cumOf(pl), L = cum[m] || 1e-6;
    return { pl, cum, L, a: c, b: par[c], s0: 0, s1: L };
  }
  // (round 2 final) o = {size: 0 | 1 | 2 (trade value < $100, < $5k, >= $5k), sell: bool}: the head grows and the tail
  // lengthens with the trade's value; a sell draws a hollow head (shape, not a new hue, so each channel keeps one meaning)
  const PSIZE = [[1.4, 16], [1.9, 22], [2.6, 30]];
  const spawn = (c, tSec, o = null) => {
    if (!isCoin(c) || !hasLink(c) || reducedNow()) { st.refused++; return false; }
    const t = Number.isFinite(tSec) ? tSec : U.uTime.value, f = fams[famOf[c]], k = S.cam.k, K0 = U.uK0.value;
    // at the overview the links are hidden (they fade in over 1.3 -> 2.2 k0): the trade shows as a flash on the chip
    const hov = U.uHoverFam.value === f.id && U.uDimMix.value > 0.5;
    if (smoothN(1.3 * K0, 2.2 * K0, k) < 0.25 && !hov) { st.degraded++; return flashFamily(f.id, t); }
    const j = takeSlot(slots);
    const viaTrunk = !G && kindOf[c] === 1 && lodJS(lodLv[c], k / K0) < 0.5 && polyOff[pods[podOf[par[c]]].anchor] >= 0;
    const ps = PSIZE[o && o.size >= 0 && o.size <= 2 ? o.size | 0 : 1];
    litC[j] = c; litT[j] = t; lU.uLitN.value = 1;
    slots[j] = { kind: 0, c, p: par[c], fam: f.id, t0: t, dur: DUR.pulse / 1000, ease: easeStd, headR: ps[0], tailPx: ps[1], sell: !!(o && o.sell), ...(viaTrunk ? pathViaTrunk(c) : pathOfLink(c, +1)) };
    st.pulses++; pulseMesh.visible = true; S.invalidate();
    return true;
  };
  const flashFamily = (famId, tSec) => {
    const f = fams[famId]; if (!f) { st.refused++; return false; }
    const t = Number.isFinite(tSec) ? tSec : U.uTime.value;
    let j = flashes.findIndex((q) => q && q.fam === famId && !q.coin);
    if (j >= 0 && Math.abs(t - flashes[j].t0) < 0.12) { st.merged++; return true; }   // the same family twice in a blink: one flash
    if (j < 0) j = takeSlot(flashes);
    flashes[j] = { fam: famId, top: f.top, t0: t, fired: false };
    st.flashes++; flashMesh.visible = true; S.invalidate();
    return true;
  };
  // (round 2 final) a ring ping on ANY coin (the traded child's own speck at the overview, a pulse's arrival at its parent,
  // a whale trade): the coin's rim / dot flashes (bubbles.flashRim) and a 1 px ring grows from its drawn rim. o.scale sets
  // how far the ring travels (1 = 5 px), o.alpha its strength. Shares the flash slots (oldest evicted).
  // o.at = {x, y, r, fam}: ring a point instead (a newborn that S.X has no slot for); i may then be -1 (or the newborn's
  // instance index, whose rim bubbles flashes)
  const flashCoin = (i, tSec, o = {}) => {
    const at = o.at && Number.isFinite(o.at.x) && Number.isFinite(o.at.y) ? o.at : null;
    if ((!at && !(Number.isInteger(i) && i >= 0 && S.X && i < S.X.length)) || reducedNow()) { st.refused++; return false; }
    const t = Number.isFinite(tSec) ? tSec : U.uTime.value, fam = at ? (at.fam >= 0 ? at.fam : -1) : famOf[i];
    const j = takeSlot(flashes);
    flashes[j] = { fam, top: i, at, t0: t, fired: false, coin: true, scale: o.scale || 1, a0: o.alpha || 0.6, dur: o.dur || 0.42 };
    st.coinFlashes = (st.coinFlashes || 0) + 1; flashMesh.visible = true; S.invalidate();
    return true;
  };
  const growAt = (c, t) => {
    let j = growC.indexOf(c); if (j < 0) j = growC.indexOf(-1);
    if (j < 0) { j = 0; for (let q = 1; q < 4; q++) if (growT[q] < growT[j]) j = q; }
    growC[j] = c; growT[j] = t;
  };
  // spark(from, to, tSec) with to = coin | {x, y}; also the feel lane's spark(from, x, y, tSec) for a newborn not yet in S.X
  const spark = function (from, to, tSec, t4) {
    if (arguments.length >= 4 || (typeof to === "number" && !Number.isInteger(to) && typeof tSec === "number")) { to = { x: to, y: tSec }; tSec = t4; }
    if (reducedNow()) { st.refused++; return false; }
    const t = Number.isFinite(tSec) ? tSec : U.uTime.value;
    let path = null, grow = -1;
    if (isCoin(to) && hasLink(to) && (from == null || !isCoin(from) || from === par[to])) { path = pathOfLink(to, -1); grow = to; }
    else {
      const A = ptOf(from == null && isCoin(to) && par[to] >= 0 ? par[to] : from), B = ptOf(to);
      if (!A || !B) { st.refused++; return false; }
      path = pathOfPoints(A, B, isCoin(to) ? to : 7);
      path.childR = B.r || 0; path.childIdx = to && Number.isInteger(to.ci) ? to.ci : -1;   // (map3 port) highlight key
      // a newborn the geometry never had: keep the link the spark draws (from = parent coin)
      const pc = from == null && isCoin(to) && par[to] >= 0 ? par[to] : from;
      if (isCoin(pc) && !(isCoin(to) && hasLink(to))) { const id = addBornLink(pc, path, t); if (id >= 0) grow = id; }
    }
    const fam = isCoin(to) ? famOf[to] : isCoin(from) ? famOf[from] : -1;
    const j = takeSlot(slots);
    slots[j] = { kind: 1, c: Number.isInteger(to) ? to : -1, p: Number.isInteger(from) ? from : -1, fam, t0: t, dur: SPARK_S, ease: easeOut3, headR: 1.75, tailPx: SPARK_TAIL, ...path };
    if (grow >= 0) growAt(grow, t);
    st.sparks++; pulseMesh.visible = true; S.invalidate();
    return t + SPARK_S;
  };
  const at = (P, s, out) => {           // point + unit tangent at arc length s along the base path, then the coins' offsets
    if (P.live >= 0 && P.sig !== posSig) livePath(P);   // (veins lane) galaxy: the live cubic (no offsets: a, b = -1)
    const { pl, cum } = P, m = cum.length;
    let lo = 0, hi = m - 1; s = Math.max(0, Math.min(P.L, s));
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; (cum[mid] <= s) ? (lo = mid) : (hi = mid); }
    const segL = cum[hi] - cum[lo] || 1, u = (s - cum[lo]) / segL;
    const ax = pl[2 * lo], ay = pl[2 * lo + 1], bx = pl[2 * hi], by = pl[2 * hi + 1];
    let tx = bx - ax, ty = by - ay; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    let px = ax + (bx - ax) * u, py = ay + (by - ay) * u;
    if (offCount && (P.a >= 0 || P.b >= 0)) {
      const oax = P.a >= 0 ? offX[P.a] : 0, oay = P.a >= 0 ? offY[P.a] : 0, obx = P.b >= 0 ? offX[P.b] : 0, oby = P.b >= 0 ? offY[P.b] : 0, w = s / P.L;
      px += oax + (obx - oax) * w; py += oay + (oby - oay) * w;
      tx += (obx - oax) / P.L; ty += (oby - oay) / P.L; const l2 = Math.hypot(tx, ty) || 1; tx /= l2; ty /= l2;
    }
    out[0] = px; out[1] = py; out[2] = tx; out[3] = ty;
  };
  const screenRof = (i) => {
    try { if (typeof S.bubbles.screenR === "function") { const r = S.bubbles.screenR(i); if (Number.isFinite(r)) return r; } } catch { /* fall through */ }
    const f = fams[famOf[i]]; return Math.max(R[i] * S.cam.k, i === f.top && f.planet ? TOK.chipR(f.share, maxShare, S.phone()) * U.uMinScale.value : 0);
  };
  const tmp = [0, 0, 0, 0];
  const CS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  function updateMarks(tNow) {
    let live = 0;
    const k = S.cam.k, dpr = S.DPR, upx = k * dpr, hwT = hairW(1.0), rm = reducedNow();
    const famDim = (fam) => (fam >= 0 && U.uHoverFam.value >= 0 && U.uHoverFam.value !== fam ? 1 + (TOK.dim - 1) * U.uDimMix.value : 1);
    for (let j = 0; j < PULSE_MAX; j++) {
      const P = slots[j], b = j * PV;
      if (P) {
        const pr = (tNow - P.t0) / P.dur;
        if (pr >= 1) {
          slots[j] = null;
          if (P.kind === 0) { st.arrived++; try { S.links.onPulseArrive(P.p); } catch (e) { console.warn(e); } }
          else { st.sparkArrived++; try { if (typeof S.links.onSparkArrive === "function") S.links.onSparkArrive(P.c); } catch (e) { console.warn(e); } }
        } else if (pr >= 0) {
          live++;
          if (P.live >= 0 && P.sig !== posSig) livePath(P);
          const f = P.fam >= 0 ? fams[P.fam] : null;
          // same visibility as the family it rides on: screen size, dust hand-off, load fade, hover dim (never the brood budget
          // or the generation LOD: the event is shown even where the link itself is quiet)
          const famVis = f ? smoothN(40, 140, f.Rc * k) : 1;
          const alpha = famDim(P.fam) * famVis * (f ? (f.planet ? U.uFadeP.value : U.uFadeD.value * U.uDustExpand.value) : U.uFadeP.value);
          const sh = P.s0 + (P.s1 - P.s0) * P.ease(pr);
          const s0 = Math.max(P.s0, sh - P.tailPx / k);
          for (let s = 0; s < TAIL; s++) {
            const u = s / (TAIL - 1); at(P, s0 + (sh - s0) * u, tmp);
            const nx = -tmp[3], ny = tmp[2];
            for (let sd = 0; sd < 2; sd++) {
              const v = b + 2 * s + sd, sg = sd ? 1 : -1;
              pPos[2 * v] = tmp[0] + nx * sg * hwT.hw / upx; pPos[2 * v + 1] = tmp[1] + ny * sg * hwT.hw / upx;
              pUV[2 * v] = 0; pUV[2 * v + 1] = sg * hwT.hw;
              pK[3 * v] = 0; pK[3 * v + 1] = alpha * 0.9 * u * hwT.cov; pK[3 * v + 2] = hwT.hw;
            }
          }
          at(P, sh, tmp);
          const h = b + TAIL * 2, headR = P.headR * dpr, headHalf = (headR + 1) / upx;
          for (let q = 0; q < 4; q++) {
            const v = h + q; pPos[2 * v] = tmp[0] + CS[q][0] * headHalf; pPos[2 * v + 1] = tmp[1] + CS[q][1] * headHalf;
            pUV[2 * v] = CS[q][0] * (headR + 1); pUV[2 * v + 1] = CS[q][1] * (headR + 1);
            pK[3 * v] = P.sell ? 2 : 1; pK[3 * v + 1] = alpha; pK[3 * v + 2] = headR;
          }
          continue;
        } else live++;   // scheduled in the future: holds its slot, draws nothing yet
      }
      for (let v = b; v < b + PV; v++) pK[3 * v + 1] = 0;
    }
    let liveF = 0;
    for (let j = 0; j < FLASH_MAX; j++) {
      const F = flashes[j], b = j * 4; let drawn = false;
      if (F) {
        const u = (tNow - F.t0) / (F.dur || FLASH_S * 1.2);
        if (u >= 1) flashes[j] = null;
        else if (u >= 0) {
          liveF++;
          if (!F.fired) {      // the chip's own rim flash + core pin belong to bubbles (S.bubbles.flashFamily); the ring ping is ours
            F.fired = true;
            try { if (F.coin) { if (F.top >= 0) S.bubbles.flashRim(F.top, F.t0); } else if (typeof S.bubbles.flashFamily === "function") S.bubbles.flashFamily(F.fam, F.t0); else S.bubbles.flashRim(F.top, F.t0); } catch (e) { console.warn(e); }
          }
          const f = fams[F.fam] || { planet: true }, top = F.top, e = easeOut(u);
          const rCss = Math.max(F.at ? (F.at.r || 0.5) * k : screenRof(top), 1.5);
          // (round 2 final) the ring travels further and fades faster (alpha (1 - u)^2), so a frozen frame shows a faint
          // wide ring, never a crisp second rim that reads as a selection
          const ringR = (rCss + 2 + (rm ? 1.5 : (F.coin ? 5 * F.scale : 7) * e)) * dpr, ext = ringR + hwT.hw + 2;
          const a0 = F.coin ? F.a0 : f.planet ? 0.62 : 0.5;
          const vis = F.coin && !f.planet ? U.uFadeD.value * U.uDustExpand.value : f.planet ? U.uFadeP.value : U.uFadeD.value;
          const alpha = a0 * Math.pow(1 - u, 2) * Math.min(1, u / 0.06) * hwT.cov * famDim(F.fam) * vis;
          const cx = F.at ? F.at.x : X[top], cy = F.at ? F.at.y : Y[top];     // S.X / S.Y are live: a dragged chip carries its ring
          for (let q = 0; q < 4; q++) {
            const v = b + q; fPos[2 * v] = cx + CS[q][0] * ext / upx; fPos[2 * v + 1] = cy + CS[q][1] * ext / upx;
            fUV[2 * v] = CS[q][0] * ext; fUV[2 * v + 1] = CS[q][1] * ext;
            fK[3 * v] = ringR; fK[3 * v + 1] = alpha; fK[3 * v + 2] = hwT.hw;
          }
          drawn = true;
        } else liveF++;
      }
      if (!drawn) for (let v = b; v < b + 4; v++) fK[3 * v + 1] = 0;
    }
    st.peak = Math.max(st.peak, live);
    pPosA.needsUpdate = true; pUVA.needsUpdate = true; pKA.needsUpdate = true;
    fPosA.needsUpdate = true; fUVA.needsUpdate = true; fKA.needsUpdate = true;
    pulseMesh.visible = slots.some(Boolean); flashMesh.visible = flashes.some(Boolean);
    return live > 0 || liveF > 0 || pulseMesh.visible || flashMesh.visible;
  }
  const smoothN = (a, b, t) => { t = Math.max(0, Math.min(1, (t - a) / (b - a))); return t * t * (3 - 2 * t); };
  function hairW(wCss) { let wd = wCss * S.DPR, cov = 1; if (wd < 1) { cov = wd; wd = 1; } return { hw: wd * 0.5 + 0.5, cov }; }

  await maybePause("event marks");
  // ------------------------------------------------------------------------------------------------------------
  // 6. RUNTIME UPDATES (heat, emphasis, branch), flushed once per frame
  // ------------------------------------------------------------------------------------------------------------
  const heatDirty = new Set(), emphDirty = new Set();
  let emphList = []; var lastHeatT = -1e9;   // (var: born links in section 5 touch it too)
  const writeHeat = (c, cls, t) => {
    if (linkStart[c] < 0) return;
    const b = linkStart[c], cur = aHeat[3 * b];
    if (cur === cls) return;
    for (let q = b; q < b + linkLen[c]; q++) { aHeat[3 * q] = cls; aHeat[3 * q + 1] = cur; aHeat[3 * q + 2] = t; }
    heatDirty.add(c); if (cur === 0 || cls === 0) trunkDirty.add(trunkOf[c]);
    lastHeatT = Math.max(lastHeatT, t); S.invalidate();
  };
  const setLinkHeat = (c, cls, tSec) => {
    if (!(c >= 0 && c < N) || !(cls >= 0 && cls <= 3)) return;
    const t = Number.isFinite(tSec) ? tSec : U.uTime.value, prev = ownCls[c], p = par[c];
    if (vIdx && vIdx[c] >= 0) {   // (veins lane) the vein's colour runs on the age clock: move tTrade into the class's range
      const q = 4 * vIdx[c] + 3, lo = HEAT_LO[cls], hi = cls < 3 ? HEAT_LO[cls + 1] : Infinity, ageNow = U.uTime.value - vWv[q];
      if (!(ageNow >= lo && ageNow <= hi)) { vWv[q] = t - lo; vWDirty = true; S.invalidate(); }
    }
    ownCls[c] = cls;
    const q = p >= 0 && podOf[p] >= 0 ? pods[podOf[p]] : null;
    if (q) { q.cnt[prev]--; q.cnt[cls]++; writeHeat(q.anchor, podClass(q), t); if (c === q.anchor) return; }   // the trunk carries the pod's heat
    writeHeat(c, cls, t);
  };
  const trunkDirty = new Set(), rcDirty = new Set();
  let reorderAt = 0;
  const flushTrunks = () => {
    for (const t of trunkDirty) {
      const lk = liveKOf(t, (c) => aHeat[3 * linkStart[c]]);
      for (const c of trunkLinks.get(t)) { const b = linkStart[c]; if (aRc[4 * b + 1] === lk) continue; for (let q = b; q < b + linkLen[c]; q++) aRc[4 * q + 1] = lk; rcDirty.add(c); }
    }
    trunkDirty.clear();
  };
  // aEmph = hover lineage (1) + selected branch (2)
  const emH = new Uint8Array(N), emS = new Uint8Array(N);
  const writeEmph = (c) => {
    const b = linkStart[c], val = emH[c] + 2 * emS[c];
    if (b >= 0) { for (let q = b; q < b + linkLen[c]; q++) aEmph[q] = val; emphDirty.add(c); }
    if (vIdx && vIdx[c] >= 0) { vMeta[4 * vIdx[c] + 1] = val; vMetaDirty = true; }   // (veins lane) flags of the vein into c
  };
  const setEmphasis = (list = []) => {
    for (const c of emphList) { emH[c] = 0; writeEmph(c); }
    emphList = [];
    for (const c of list || []) { if (emphList.length >= 1500) break; if (c >= 0 && c < N && (linkStart[c] >= 0 || hasLink(c)) && !emH[c]) { emphList.push(c); emH[c] = 1; writeEmph(c); } }
    lU.uEmphOn.value = emphList.length ? 1 : 0;
    S.invalidate();
  };
  // (r2) selected branch: the ancestor chain + the whole subtree draws at any zoom; 160 ms fade in / out
  let branchCoin = -1, branchList = [];
  const brT = { from: 0, to: 0, t0: 0, run: false };
  const clearBranch = () => { for (const c of branchList) { emS[c] = 0; writeEmph(c); } branchList = []; };
  const setBranch = (i = -1) => {
    if (!(i >= 0 && i < N)) i = -1;
    if (i === branchCoin) return;
    branchCoin = i;
    if (i < 0) { Object.assign(brT, { from: lU.uBranchT.value, to: 0, t0: performance.now(), run: true }); S.invalidate(); return; }
    clearBranch();
    for (let c = i; c >= 0 && par[c] >= 0 && branchList.length < 64; c = par[c]) branchList.push(c);
    const stack = [...kids[i]];
    while (stack.length && branchList.length < 3000) { const c = stack.pop(); branchList.push(c); for (const g of kids[c]) stack.push(g); }
    for (const c of branchList) if (linkStart[c] >= 0 || hasLink(c)) { emS[c] = 1; writeEmph(c); }
    Object.assign(brT, { from: 0, to: 1, t0: performance.now(), run: true }); lU.uBranchT.value = 0; S.invalidate();
  };
  // an explicit mover also wakes the per-frame position scans (bubbles' scanXY, breathCheck), which otherwise run only while
  // the sim steps; 3 frames because motion.js counts it down before those hooks run
  const follow = (list, n) => { S.xyScan = 3; const m = list && list.length ? syncList(list, n == null ? list.length : n) : syncOffsets(); if (m) S.invalidate(); return m; };
  // (map3 port) highlight mask: bitOf(coin) for the links of built coins (texel = child), born links follow their newborn
  // (b.ci, bornBit). One 160 ms crossfade from what each link shows now; uHlOn stays on while a mask is set or fading out.
  let hlActive = false;
  const setHl = (bitOf, tSec, bornBit) => {
    const t = Number.isFinite(tSec) ? tSec : U.uTime.value, t0 = lU.uHlT0.value, e = smoothN(t0, t0 + 0.16, t);
    const put = (tx, cur) => { const w = offData[4 * tx + 3], hc = w >= 2 ? 1 : 0, hs = w - 4 * hc, shown = hs + (hc - hs) * e; offData[4 * tx + 3] = 4 * cur + shown; };
    let any = false;
    for (let i = 0; i < N; i++) { const cur = bitOf ? (bitOf(i) ? 1 : 0) : 1; if (!cur) any = true; put(i, cur); }
    for (const b of born) { const cur = !bitOf ? 1 : b.ci >= 0 && typeof bornBit === "function" ? (bornBit(b.ci) ? 1 : 0) : 1; if (!cur) any = true; put(b.id, cur); }
    hlActive = any; lU.uHlT0.value = t; lU.uHlOn.value = 1; offTex.needsUpdate = true; S.invalidate();
  };
  // the feel lane's call (motion.js publishMoved): positions are already in S.X / S.Y. Having this function also switches
  // off motion's fallback that would otherwise move the link vertices a second time.
  const setPositions = (list, n) => follow(list, n);
  const flushAttr = (attr, set) => {
    if (!set.size) return;
    attr.clearUpdateRanges();
    if (set.size <= 48) {
      const rs = [...set].map((c) => [linkStart[c], linkLen[c]]).sort((p, q) => p[0] - q[0]);
      let cur = null;
      for (const [s, l] of rs) { if (cur && s <= cur[0] + cur[1]) cur[1] = Math.max(cur[1], s + l - cur[0]); else { if (cur) attr.addUpdateRange(cur[0] * attr.itemSize, cur[1] * attr.itemSize); cur = [s, l]; } }
      if (cur) attr.addUpdateRange(cur[0] * attr.itemSize, cur[1] * attr.itemSize);
    }
    attr.needsUpdate = true; set.clear();
  };

  S.onFrame((now) => {
    let more = false;
    if (syncOffsetsFrame()) more = true;                        // coins moved (drag sim): links/arcs follow this frame
    if (G) {   // (veins lane) live positions + instance flushes
      syncPos();
      if (vWDirty) { vWAttr.needsUpdate = true; vWDirty = false; }
      if (vMetaDirty) { vMetaAttr.needsUpdate = true; vMetaDirty = false; }
    }
    if (trunkDirty.size) { flushTrunks(); reorderAt = now + 1000; }
    if (reorderAt && now >= reorderAt) { reorderAt = 0; writeIdx((c) => aHeat[3 * linkStart[c]]); idxAttr.needsUpdate = true; S.invalidate(); }   // keep live links last
    flushAttr(heatAttr, heatDirty); flushAttr(emphAttr, emphDirty); flushAttr(rcAttr, rcDirty);
    if (U.uTime.value - lastHeatT < 0.65) more = true;          // class crossfades in flight
    if (hT.run) {
      const u = Math.min(1, (now - hT.t0) / HULL_MS), e = easeOut(u), a = hT.from, b = hT.to;
      hU.uHullC.value.set(a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e); hU.uHullR.value = a.r + (b.r - a.r) * e; hU.uHullA.value = a.a + (b.a - a.a) * e;
      if (u >= 1) { hT.run = false; if (hT.fam < 0) hull.visible = false; }
      more = true;
    }
    if (brT.run) {
      const u = Math.min(1, (now - brT.t0) / (reducedNow() ? 120 : DUR.s)), e = easeOut(u);
      lU.uBranchT.value = brT.from + (brT.to - brT.from) * e;
      if (u >= 1) { brT.run = false; if (brT.to === 0) clearBranch(); }
      more = true;
    }
    let growing = false;
    for (let j = 0; j < 4; j++) if (growC[j] >= 0) { if (U.uTime.value > growT[j] + FRESH_S + 1.1) growC[j] = -1; else growing = true; }
    if (growing) more = true;
    if (slots.some(Boolean) || flashes.some(Boolean)) { if (updateMarks(now / 1000)) more = true; }
    if (lU.uLitN.value > 0) { const tn = U.uTime.value; if (litT.every((t) => tn - t > DUR.pulse / 1000 + 0.5)) { lU.uLitN.value = 0; litC.fill(-1); } else more = true; }
    if (born.length && (S.frame % 30 === 0)) ageBorn(now / 1000);
    // (map3 port) highlight crossfade in flight; once a cleared mask has faded back in, the per-vertex lookup switches off
    if (lU.uHlOn.value > 0 && U.uTime.value < lU.uHlT0.value + 0.2) more = true;
    else if (lU.uHlOn.value > 0 && !hlActive) lU.uHlOn.value = 0;
    return more;
  });

  // ------------------------------------------------------------------------------------------------------------
  // 7. EXPORTS + DEBUG
  // ------------------------------------------------------------------------------------------------------------
  const statsOf = () => ({ ...st, live: slots.filter(Boolean).length, liveFlashes: flashes.filter(Boolean).length, cap: PULSE_MAX, flashCap: FLASH_MAX, offsetCoins: offCount, offsetSyncs: offSyncs });
  Object.assign(S.links, { mesh: G ? veins : links, flatMesh: links, veins, lGeo, setLinkHeat, setEmphasis, setBranch, follow, setPositions, addBornLink: bornLink, linkPolyline, genArcInfo, setHl,
    lod: { g2: LOD_G2.slice(), g3: LOD_G3.slice(), budgetFull: BUDGET_FULL, trunkMin: TRUNK_MIN, pods: pods.length } });   // never onPulseArrive / onSparkArrive (motion's slots)
  // galaxy: light the path from coin i to its family's top (the trade pulse's "vein lighting"): every link on the way takes a
  // lit slot (oldest reused); the GALAXY vertex shader gains it +80 % -> 0 over 1.1 s and turns it lime. No-op in flat.
  const lightPath = (i, tSec) => {
    if (!G || !isCoin(i)) return 0;
    const t = Number.isFinite(tSec) ? tSec : U.uTime.value; let n = 0;
    for (let c = i; c >= 0 && n < PULSE_MAX; c = par[c]) {
      if (!hasLink(c)) continue;
      let j = 0; for (let q = 1; q < PULSE_MAX; q++) if (litT[q] < litT[j]) j = q;
      litC[j] = c; litT[j] = t; n++;
    }
    if (n) { lU.uLitN.value = 1; S.invalidate(); }
    return n;
  };
  S.links.lightPath = lightPath;
  Object.assign(S.links.genArcs, { mesh: genArcs, setKnockouts, setTagged });
  Object.assign(S.links.hull, { mesh: hull, show: showHull });
  Object.assign(S.links.pulses, { mesh: pulseMesh, flashMesh, spawn, flashFamily, flashCoin, spark, active: () => slots.filter(Boolean).length, stats: statsOf });

  // widest vein core in CSS px at the current zoom (the shader's own formula)
  S.debugFns.linkMaxPx = () => {
    if (G) {   // (veins lane) widest vein core in CSS px at the current zoom: min(cap, max(w0 k, F)) (the shader's formula)
      const k = S.cam.k, Rd = S.Rdraw && S.Rdraw.length >= N ? S.Rdraw : R; let m = 0;
      for (let q = 0; q < vList.length; q++) {
        const c = vList[q], w0 = Math.min(VEIN.wMax, Math.max(VEIN.wMin, VEIN.wK * Rd[c] + VEIN.wB)), F = (1 + 1.5 * vMeta[4 * q + 3]) * (vWv[4 * q + 1] ? 1.25 : 1);
        const core = Math.min(VEIN.capPx, Math.max(w0 * k / wK0(), F)); if (core > m) m = core;
      }
      return +m.toFixed(3);
    }
    // (veins look fix) flat: the widest vein core at the CURRENT zoom (flatWA: hairline core + angular room + taper, cap)
    let m = 0;
    for (let c = 0; c < N; c++) if (linkStart[c] >= 0) { const w = flatWA(c).w; if (w > m) m = w; }
    return +m.toFixed(3);
  };
  // (veins flat fix) the family of a key (symbol / mint / coin index), else the focused family, else the one at the camera centre
  const famOfKey = (key) => {
    if (typeof key === "number" && key >= 0 && key < N) return fams[famOf[key]];
    if (key != null) {
      const sk = String(key).replace(/^\$+/, "");
      const f = S.famBy ? S.famBy(sk) : null; if (f) return f;
      const i = S.mint && S.mint.indexOf ? S.mint.indexOf(sk) : -1; if (i >= 0) return fams[famOf[i]];
      return null;
    }
    if (U.uFocusFam && U.uFocusFam.value >= 0) return fams[U.uFocusFam.value];
    let best = null, bs = Infinity;
    for (const f of fams) { if (!f || !(f.Rc > 0)) continue; const d = Math.hypot(f.cx - S.cam.x, f.cy - S.cam.y) / f.Rc; if (d <= 1 && d < bs) { bs = d; best = f; } }
    return best;
  };
  // the narrowest gen-1 vein core of a family, CSS px, at the current zoom (flat: at the vein's far end, its widest point)
  S.debugFns.linkMinPx = (key) => {
    const f = famOfKey(key); if (!f) return null;
    let m = Infinity;
    for (const c of f.members) { if (linkStart[c] < 0 || !(gen[c] === 1 || kindOf[c] === 2)) continue; const w = flatWA(c).w; if (w < m) m = w; }
    return Number.isFinite(m) ? +m.toFixed(3) : null;
  };
  // the family's vein alphas after the budget (alphaOf: the shader's per-link alpha, hub fade left out) + the ink numbers:
  //   inkShare (= discInk): sum(core x length x alpha) / the family's on-screen disc area (pi (Rc k)^2)
  //   rim: the top's brood at the top's DRAWN rim: n veins, px = rim radius, geo = sum(rim core) / circumference (geometric
  //        overlap factor), ink = sum(rim core x alpha) / circumference (alpha-weighted share of the rim), far = the same at
  //        the far ends (core there / the circle the mean far end sits on). The angular-room cap keeps geo <= 0.5 wherever
  //        the room (not its floor) decides; ink is what the eye sees under "over" blending.
  S.debugFns.veinAlpha = (key) => {
    const f = famOfKey(key); if (!f) return null;
    const k = S.cam.k, al = [], a1 = []; let ink = 0;
    let rimN = 0, rimPx = 0, rimGeo = 0, rimInk = 0, farGeo = 0, farInk = 0, farL = 0;
    for (const c of f.members) {
      if (linkStart[c] < 0) continue;
      const a = alphaOf(c); al.push(a);
      const fw = flatWA(c);
      if (!G && fw.tier1) a1.push(a);   // gen-1 veins and pod trunks
      const b = linkStart[c], Lt = aS[2 * b] + aS[2 * b + 1];
      ink += (G ? fw.w : fw.w - 0.3 * (fw.w - fw.wRim)) * Lt * k * a;   // flat: the taper covers the first 60 % of the vein
      if (!G && par[c] === f.top && kindOf[c] !== 2) { rimN++; rimPx = fw.rRim; rimGeo += fw.wRim; rimInk += fw.wRim * a; farGeo += fw.w; farInk += fw.w * a; farL += Lt * k; }
    }
    al.sort((x, y) => x - y);
    const area = Math.PI * (f.Rc * k) ** 2, circ = 2 * Math.PI * Math.max(rimPx, 1e-6), farC = 2 * Math.PI * Math.max(rimPx + (rimN ? farL / rimN : 0), 1e-6);
    return { fam: f.id, sym: S.sym ? S.sym[f.top] : null, n: al.length, min: al.length ? +al[0].toFixed(3) : null, p50: al.length ? +al[al.length >> 1].toFixed(3) : null,
      max: al.length ? +al[al.length - 1].toFixed(3) : null, gen1: (a1.sort((x, y) => x - y), { n: a1.length, min: a1.length ? +a1[0].toFixed(3) : null, p50: a1.length ? +a1[a1.length >> 1].toFixed(3) : null }), inkShare: area > 0 ? +(ink / area).toFixed(4) : null,
      rim: rimN ? { n: rimN, px: +rimPx.toFixed(2), geo: +(rimGeo / circ).toFixed(3), ink: +(rimInk / circ).toFixed(4), far: { geo: +(farGeo / farC).toFixed(3), ink: +(farInk / farC).toFixed(4), px: +(farC / (2 * Math.PI)).toFixed(1) } } : null,
      kOverK0: +(k / U.uK0.value).toFixed(3) };
  };
  // (r2) the shader's per-link alpha (its maximum along the link: hub fade and end gaps left out), at the current camera
  const lerp = (a, b, t) => a + (b - a) * t;
  // (veins look fix) the flat shader's width for link c at the current zoom (hairline core + angular room + taper, cap):
  // { w: core at the far end (the vein's widest, CSS px), wRim: core at the parent rim, wN: uncapped core, rRim: the parent's
  //   drawn rim px, n: siblings, tier1, a0: base alpha by class, dz: the brood budget factor at this zoom }
  function flatWA(c) {
    const b = linkStart[c]; if (b < 0) return { w: 0, wRim: 0, wN: 0, rRim: 0, n: 1, tier1: false, a0: 0, dz: 0 };
    const k = S.cam.k, K0 = U.uK0.value, uT = U.uTime.value, ms = U.uMinScale.value;
    const cls = aHeat[3 * b], prv = aHeat[3 * b + 1], fx = smoothN(aHeat[3 * b + 2], aHeat[3 * b + 2] + 0.6, uT);
    const tier1 = aInfo[4 * b + 2] < 1.5 || aRc[4 * b + 3] > 1.5;
    const sW = Math.min(FLAT_W.sMax, Math.max(1, Math.sqrt(k / K0)));
    const wN = (lerp(TOK.linkW[prv], TOK.linkW[cls], fx) + (tier1 ? TOK.linkWGen1 : 0)) * (tier1 ? 1 : FLAT_W.gen2) * sW;
    const n = Math.max(aPar[4 * b + 1], 1), rRim = Math.max(aPar[4 * b] * k, aPar[4 * b + 3] * ms, 1), Lt = aS[2 * b] + aS[2 * b + 1];
    const dn = aInfo[4 * b + 3], fl = FLAT_W.rim * Math.max(0, Math.min(1, dn));   // (repair) the floor scaled by the budget share
    const wRim = Math.min(wN, Math.max(Math.PI * rRim / n, fl), FLAT_W.cap);
    const w = Math.min(wN, Math.max(Math.PI * (rRim + Lt * k) / n, fl), FLAT_W.cap);
    const dz = n > BUDGET_ZOOM[2] ? dn : Math.min(1, dn * Math.max(1, Math.min(BUDGET_ZOOM[1], k / (K0 * BUDGET_ZOOM[0]))));
    return { w, wRim, wN, rRim, n, tier1, a0: lerp(LINK_A[prv], LINK_A[cls], fx), dz };
  }
  function alphaOf(c) {
    const b = linkStart[c]; if (b < 0) return 0;
    if (!G) return alphaFlat(c, b);
    const k = S.cam.k, dpr = S.DPR, K0 = U.uK0.value, uT = U.uTime.value;
    const cls = aHeat[3 * b], prv = aHeat[3 * b + 1], fx = smoothN(aHeat[3 * b + 2], aHeat[3 * b + 2] + 0.6, uT);
    const g = aInfo[4 * b + 2], lv = aRc[4 * b + 2], kind = aRc[4 * b + 3], g1 = g < 1.5 || kind > 1.5 ? TOK.linkWGen1 : 0;
    const w = lerp(Math.min(TOK.linkW[prv] + g1, TOK.linkWMax), Math.min(TOK.linkW[cls] + g1, TOK.linkWMax), fx);
    const lk = aRc[4 * b + 1];
    let a = lerp(LINK_A[prv] * (prv === 0 ? lk : 1), LINK_A[cls] * (cls === 0 ? lk : 1), fx);
    const e = aEmph[b], emHv = (e % 2 >= 0.5 ? 1 : 0) * U.uDimMix.value, emSv = (e > 1.5 ? 1 : 0) * lU.uBranchT.value, em = Math.max(emHv, emSv);
    const d = aPar[4 * b + 1] > BUDGET_ZOOM[2] ? aInfo[4 * b + 3] : Math.min(1, aInfo[4 * b + 3] * Math.max(1, Math.min(BUDGET_ZOOM[1], k / (K0 * BUDGET_ZOOM[0])))); a *= lerp(d, Math.max(d, Math.min(1, 3 / Math.sqrt(Math.max(aPar[4 * b + 1], 1)))), em);
    const kk = k / K0;
    a *= Math.max(lodJS(lv, kk), em, lU.uLodOff.value);
    if (kind > 1.5) a *= 1 - 0.55 * lodJS(lv + 2, kk);
    a *= Math.min(1, w * dpr);
    a *= smoothN(40, 140, aRc[4 * b] * k);
    const hf = U.uHoverFam.value, fid = aInfo[4 * b + 1], isHov = hf > -0.5 && Math.abs(fid - hf) < 0.5 ? 1 : 0;
    a *= Math.max(smoothN(1.3 * K0, 2.2 * K0, k), 0.75 * isHov * U.uDimMix.value, emSv);
    a *= lerp(1, U.uDustExpand.value, aInfo[4 * b]);
    if (hf > -0.5) {
      if (isHov) { const boosted = lU.uEmphOn.value > 0.5 ? (e % 2 >= 0.5 ? Math.min(a * 1.8, 0.9) : a * 0.6) : Math.min(a * 1.6, 0.85); a = lerp(a, boosted, U.uDimMix.value); }
      else a *= lerp(1, TOK.dim, U.uDimMix.value);
    }
    const ff = U.uFocusFam.value; if (!G && ff > -0.5 && Math.abs(fid - ff) > 0.5 && Math.abs(fid - hf) > 0.5) a *= lerp(1, FOCUS_DIM, U.uFocusMix.value);
    return a * lerp(U.uFadeP.value, U.uFadeD.value, aInfo[4 * b]);
  }
  // (veins look fix) the flat shader's per-link alpha (hub fade, end gaps and the pulse-lit floor left out), same order as
  // the vertex shader; the coverage factor is the far end's (the vein's maximum along its length)
  function alphaFlat(c, b) {
    const k = S.cam.k, dpr = S.DPR, K0 = U.uK0.value;
    const fw = flatWA(c), lv = aRc[4 * b + 2], kind = aRc[4 * b + 3];
    const e = aEmph[b], emHv = (e % 2 >= 0.5 ? 1 : 0) * U.uDimMix.value, emSv = (e > 1.5 ? 1 : 0) * lU.uBranchT.value, em = Math.max(emHv, emSv);
    let a = fw.a0 * lerp(fw.dz, Math.max(fw.dz, Math.min(1, EMPH_FLOOR / Math.sqrt(fw.n))), em);   // (repair) no 0.8 a0 floor: the budget holds under emphasis
    const kk = k / K0;
    a *= Math.max(lodJS(lv, kk), em, lU.uLodOff.value);
    if (kind > 1.5) a *= 1 - 0.55 * lodJS(lv + 2, kk);
    const Lt = aS[2 * b] + aS[2 * b + 1], lf = lerp(1, FLAT_W.long[2], smoothN(FLAT_W.long[0], FLAT_W.long[1], Lt * k)); a *= lerp(lf, 1, em);
    a *= smoothN(FLAT_W.smallFam[0], FLAT_W.smallFam[1], aRc[4 * b] * k);
    a *= lerp(1, U.uDustExpand.value, aInfo[4 * b]);
    const hf = U.uHoverFam.value, fid = aInfo[4 * b + 1], isHov = hf > -0.5 && Math.abs(fid - hf) < 0.5 ? 1 : 0;
    if (hf > -0.5) {
      const ovT = smoothN(1.3 * K0, 2.2 * K0, k);   // (repair) the overview cap on the hover boost, as the shader
      if (isHov) { const boosted = lU.uEmphOn.value > 0.5 ? (e % 2 >= 0.5 ? Math.min(a * 1.8, lerp(OV_EMPH_MAX, 0.75, ovT)) : a * 0.6) : Math.min(a * 1.6, lerp(OV_EMPH_MAX, 0.7, ovT)); a = lerp(a, boosted, U.uDimMix.value); }
      else a *= lerp(1, TOK.dim, U.uDimMix.value);
    }
    const ff = U.uFocusFam.value; if (ff > -0.5 && Math.abs(fid - ff) > 0.5 && Math.abs(fid - hf) > 0.5) a *= lerp(1, FOCUS_DIM, U.uFocusMix.value);
    a *= lerp(U.uFadeP.value, U.uFadeD.value, aInfo[4 * b]);
    return a * Math.min(1, fw.w * dpr);
  }
  // (r2) how many links are actually visible: on screen (any point inside the viewport) and alpha >= thr
  S.debugFns.linkVisible = (thr = 0.02) => {
    S.motion.applyCam();
    const W = S.W(), H = S.H(), out = { thr, visible: 0, byGen: {}, links: nLinks, k: +S.cam.k.toFixed(3), kOverK0: +(S.cam.k / U.uK0.value).toFixed(2) };
    for (let c = 0; c < N; c++) {
      if (linkStart[c] < 0) continue;
      const a = alphaOf(c); if (a < thr) continue;
      const pl = linkPolyline(c); let on = false;
      for (let q = 0; q < pl.length; q += 2) { const [sx, sy] = S.toS(pl[q], pl[q + 1]); if (sx >= 0 && sx <= W && sy >= 0 && sy <= H) { on = true; break; } }
      if (!on) continue;
      out.visible++; const g = gen[c] >= 3 ? "3+" : String(gen[c]); out.byGen[g] = (out.byGen[g] || 0) + 1;
      const kd = ["plain", "twigs", "trunks"][kindOf[c]]; out[kd] = (out[kd] || 0) + 1;
    }
    return out;
  };
  // (r2) verification hooks: links-lane events on demand (key = ticker | coin index)
  S.debugFns.linkDemo = (kind, key = "PUMP", a1, a2) => {
    const fam = typeof key === "number" ? fams[famOf[key]] : S.famBy(key);
    if (kind === "flash") return fam ? flashFamily(fam.id) : false;
    if (kind === "undrag") { for (let i = 0; i < N; i++) { X[i] = X0[i]; Y[i] = Y0[i]; } S.invalidate(); return follow(); }
    if (!fam) return null;
    // the most visible links of the family on screen, longest first
    const W = S.W(), H = S.H(), cand = [];
    for (const c of fam.members) {
      if (linkStart[c] < 0) continue;
      const [sx, sy] = S.toS(X[c], Y[c]), [px, py] = S.toS(X[par[c]], Y[par[c]]);
      if (sx < 40 || sx > W - 40 || sy < 40 || sy > H - 40) continue;
      cand.push([Math.hypot(sx - px, sy - py) * (alphaOf(c) + 0.05), c]);
    }
    cand.sort((p, q) => q[0] - p[0]);
    const pick = typeof key === "number" ? key : cand.length ? cand[Math.min(cand.length - 1, a1 | 0)][1] : -1;
    if (pick < 0) return null;
    if (kind === "pulse") return { c: pick, ok: spawn(pick) };
    if (kind === "pulses") { let n = 0; for (let q = 0; q < Math.min(cand.length, a1 || 24); q++) if (spawn(cand[q][1], U.uTime.value + q * 0.06)) n++; return n; }
    if (kind === "spark") return { c: pick, arrive: spark(par[pick], pick) };
    if (kind === "drag") {      // move one coin by (dx, dy) world units and let its neighbours glide with a smooth falloff
      const dx = a1 || 0, dy = a2 || 0, cx = X0[pick], cy = Y0[pick], rr = 40;
      for (const i of fam.members) { const d = Math.hypot(X0[i] - cx, Y0[i] - cy), w = i === pick ? 1 : Math.exp(-(d * d) / (2 * rr * rr)) * 0.6; X[i] = X0[i] + dx * w; Y[i] = Y0[i] + dy * w; }
      S.invalidate(); return { c: pick, moved: follow() };
    }
    return null;
  };
  // pixel truth: render ONLY the links (alpha forced to coverage) into a float target; ink sum / visible length
  // = the mean drawn width in CSS px for heat class `cls` (or all). Proves the GPU output, not the formula.
  S.debugFns.linkInk = (cls = -1) => {
    S.motion.applyCam();                 // the camera matrices may lag S.cam by a frame (e.g. right after __zoomTo)
    const { renderer, camera } = S.gfx; const W = S.W(), H = S.H(), dpr = S.DPR;
    const rt = new THREE.WebGLRenderTarget(Math.round(W * dpr), Math.round(H * dpr), { type: THREE.FloatType });
    const sc = new THREE.Scene();
    // a sub-geometry with only the requested class
    const sel = []; for (let c = 0; c < N; c++) if (linkStart[c] >= 0 && (cls < 0 || clsOf[c] === cls)) sel.push(c);
    const ix = []; let lenPx = 0; const k = S.cam.k;
    for (const c of sel) {
      const b = linkStart[c], m = linkLen[c] / 2, o = polyOff[c];
      for (let q = 1; q < m; q++) {
        const ax = PL[o + 2 * q - 2], ay = PL[o + 2 * q - 1], bx = PL[o + 2 * q], by = PL[o + 2 * q + 1];
        const [sx0, sy0] = S.toS(ax, ay), [sx1, sy1] = S.toS(bx, by);
        if (Math.max(sx0, sx1) < 4 || Math.min(sx0, sx1) > W - 4 || Math.max(sy0, sy1) < 4 || Math.min(sy0, sy1) > H - 4) continue;
        lenPx += Math.hypot(bx - ax, by - ay) * k;
        const v0 = b + 2 * q; ix.push(v0 - 2, v0 - 1, v0, v0 - 1, v0 + 1, v0);
      }
    }
    const g = lGeo.clone(); g.setIndex(ix); g.boundingSphere = bigSphere();
    const mat = lMat.clone(); mat.uniforms = { ...lU, uDebugSolid: { value: 1 } };
    mat.blending = THREE.CustomBlending; mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneFactor; mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneFactor;
    mat.fragmentShader = mat.fragmentShader.replace("gl_FragColor = vec4(vCol * a, a * (1.0 - vLive));", "gl_FragColor = vec4(a, 0.0, 0.0, 1.0);");
    const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; sc.add(mesh);
    const prevRT = renderer.getRenderTarget(), prevCol = new THREE.Color(); renderer.getClearColor(prevCol); const prevA = renderer.getClearAlpha();
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(sc, camera);
    const px = new Float32Array(rt.width * rt.height * 4); renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, px);
    renderer.setRenderTarget(prevRT); renderer.setClearColor(prevCol, prevA);
    let ink = 0, maxPix = 0; for (let q = 0; q < px.length; q += 4) { ink += px[q]; if (px[q] > maxPix) maxPix = px[q]; }
    g.dispose(); mat.dispose(); rt.dispose();
    return { cls, links: sel.length, visibleLenCss: Math.round(lenPx), meanWidthCss: lenPx > 0 ? +(ink / dpr / dpr / lenPx).toFixed(3) : null, maxPixelCover: +maxPix.toFixed(3) };
  };

  // HDR audit of THIS lane's layers alone (links + arcs + hull + pulses + flashes over the graphite ground) at the current
  // camera: pixels whose max channel exceeds 1.0 would feed the bloom (threshold 1.0). Only pulse / spark heads may.
  S.debugFns.linkHdr = (opt = {}) => {
    S.motion.applyCam();
    const { renderer, camera } = S.gfx; const w = Math.round(S.W() * S.DPR), h = Math.round(S.H() * S.DPR);
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
    const sc = new THREE.Scene(); sc.background = new THREE.Color(TOK.bg);
    const objs = opt.pulses === false ? [links, genArcs, hull, flashMesh] : [links, genArcs, hull, pulseMesh, flashMesh], parents = objs.map((o) => o.parent);
    for (const o of objs) sc.add(o);
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.render(sc, camera);
    const px = new Uint16Array(w * h * 4); renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    renderer.setRenderTarget(prevRT);
    objs.forEach((o, i) => parents[i] && parents[i].add(o));
    let over = 0, max = 0;
    for (let q = 0; q < px.length; q += 4) { const m = Math.max(THREE.DataUtils.fromHalfFloat(px[q]), THREE.DataUtils.fromHalfFloat(px[q + 1]), THREE.DataUtils.fromHalfFloat(px[q + 2])); if (m > max) max = m; if (m > 1.0) over++; }
    rt.dispose();
    return { over, max: +max.toFixed(3), pulses: slots.filter(Boolean).length, flashes: flashes.filter(Boolean).length };
  };

  Object.assign(S.debug.obj, { links: G ? veins : links, flatLinks: links, lGeo, vGeo, genArcs, hull, pulses: pulseMesh, flashes: flashMesh, orbits });
  // (veins lane) the live curve into coin c (index or mint): CSS px points parent -> child + both drawn rims (CSS px)
  S.debugFns.veinPath = (c, n = 16) => {
    if (typeof c === "string") c = S.mint ? S.mint.indexOf(c) : -1;
    if (!vIdx || !hasLink(c)) return null;
    S.motion.applyCam();
    const out = cubicInto(c, n, new Float32Array(2 * (n + 1))), pts = [];
    for (let k = 0; k <= n; k++) { const [x, y] = S.toS(out[2 * k], out[2 * k + 1]); pts.push({ x: +x.toFixed(2), y: +y.toFixed(2) }); }
    const k = S.cam.k, q = vIdx[c], Rd = S.Rdraw && S.Rdraw.length >= N ? S.Rdraw : R;
    const w0 = Math.min(VEIN.wMax, Math.max(VEIN.wMin, VEIN.wK * Rd[c] + VEIN.wB)), F = (1 + 1.5 * vMeta[4 * q + 3]) * (vWv[4 * q + 1] ? 1.25 : 1);
    return { c, p: par[c], pts, rimP: +(rimW(par[c]) * k).toFixed(2), rimC: +(rimW(c) * k).toFixed(2), coreCss: +Math.min(VEIN.capPx, Math.max(w0 * k / wK0(), F)).toFixed(2), posSig };
  };
  S.debugFns.veinStats = () => ({ veins: vList.length, nseg: G ? (S.phone() ? VEIN.nsegPhone : VEIN.nseg) : 0, posUploads, posSig, offsetCoins: offCount });
  // (map3 port) teardown: every mesh, geometry, material and the offset DataTexture
  S.life.onDispose(() => {
    for (const m of [links, genArcs, hull, pulseMesh, flashMesh, bornMesh]) scene.remove(m);
    if (orbits) scene.remove(orbits);
    if (veins) scene.remove(veins);
    if (!S.contextLost) { if (vGeo) vGeo.dispose(); if (vMat) vMat.dispose(); if (posTex) posTex.dispose(); }
    if (!S.contextLost) {   // a lost context took the GPU objects already
      for (const g of [lGeo, gGeo, hGeo, pGeo, fGeo, bGeo]) g.dispose();
      for (const m of [lMat, gMat, hMat, pMat, fMat]) m.dispose();
      if (oGeo) oGeo.dispose(); if (oMat) oMat.dispose();
      offTex.dispose();
    }
    born.length = 0; slots.fill(null); flashes.fill(null);
  });
  sliceMs.end = Math.round(performance.now() - tMark);
  Object.assign(S.debug.map, { linksSliceMs: JSON.stringify(sliceMs), linkVerts: V, linkTris: nIdx / 3, linkCount: nLinks, genArcVerts: gV, genArcFams: arcInfo.size, look: G ? "galaxy" : "flat", orbitFams: orbits ? (S.planets || []).length : 0, linksMs: Math.round(performance.now() - t0) });
}
