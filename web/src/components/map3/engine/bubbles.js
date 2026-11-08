// (map3 port) Copied from the prototype. Changed: logos come ONLY through opts.images (the app's bounded loader: hi logos
// want(url, 256), lo logos want(url, 128), lo requested first so the planet tops get the newest stamps; re-checked on
// images.onLoaded at most every 250 ms; no Image(), no fetch); canvas fonts are Geist Mono (monograms stay disabled);
// a highlight mask per instance (setHl: unmatched coins dim to TOK.dim, 160 ms crossfade); every geometry, material,
// atlas texture and the glyph texture is disposed with the engine; __bubbleLOD -> S.debugFns.bubbleLOD.
// bubbles.js: the coins. Logo atlases + one instanced impostor mesh (flat opaque dots, matte spheres, crisp 1 px heat
// rims that double as the 24 h gauge, live-only cores, logo chips, quiet monograms, knock-out halos, hover/selection rings).
// FINAL POLISH (2026-10-21, see LANES.md section 14): every coin (planet tops too) shows its OWN last trade; no presence
// badge; the 24 h activity is a bright segment ON the rim (no offset arc); below 8 px a coin is a flat opaque dot.
// OWNER: BUBBLES lane. Does not touch layout, links, labels, the camera or the tick loop.
// Spec: "SPORE MAP: GRAPHITE INSTRUMENT", lane BUBBLES + R3/R4/R10/R15. Colours come only from TOK.
//
// EXPORTS
//   buildBubbles(S)   needs S.gfx.scene and final WORLD X/Y/R (after placeDust). Fills S.bubbles:
//     mesh                    the InstancedMesh (one draw, renderOrder 10, premultiplied One/OneMinusSrcAlpha)
//     perm, invIdx            instance k draws coin perm[k]; invIdx[coin] = k. Instances are sorted
//                             cold -> live, small -> large, planet tops last. aB.y keeps the real coin index.
//     atlasHi, atlasLo        CanvasTextures (sRGB, mipmapped). atlas = atlasHi (back-compat)
//     logoIdx (Int16Array N)  -1 = no cell; 0..63 = atlasHi cell (8x8 x 256 px); 64+j = atlasLo cell j (16 x 128 px)
//     logoList                coin indices that own a cell (planet tops first)
//     cls (Uint8Array N)      the heat class each coin is drawn with now (0 live, 1 cooling, 2 quiet, 3 cold)
//     setCoinHeat(i, cls, boost, tSec)   class change crossfades in 600 ms (same class: only the core boost moves)
//     flashRim(i, tSec)                  rim x1.25 for 300 ms, ease-out (pulse arrival)
//     selectCoin(i | -1)                 persistent selection ring (private uniform uSelected)
//     screenR(i), outerR(i)              (addition) drawn disc radius / outermost drawn radius (the 1.5 px knock-out halo),
//                                        CSS px at the current zoom, so label obstacles and hit radii match the pixels
//     setInside(coinIdxList)             (final polish) coins whose name the labels lane prints INSIDE the disc: no core,
//                                        no monogram under the text
//     hasLogo(i)                         true when the coin owns a logo cell (labels never print a name over a logo)
//   ROUND 2 (LANES.md section 15, bubbles):
//     live coins BREATHE (amendment A): radius +-3 %, a 4-6 s period and a phase per coin, live class only, crossfading
//     with the class, OFF under reduced motion. The frame hook keeps frames flowing while a breathing coin >= 3 px is on
//     screen, at the rate the breathing needs (every step <= 0.1 px: 15 Hz for overview chips, up to 60 Hz deep in).
//     birth(i, tSec?, mode?)             (amendment C) mode 'scale' (default): the coin scales 0 -> 1 over 500 ms, cubic
//                                        ease-out; 'fade': it fades in over 500 ms (parent unknown). A tSec in the future
//                                        keeps the coin hidden until then (start it when the spark lands). Reduced motion:
//                                        appears at once. Returns false for a coin the mesh does not hold (see addCoin).
//     flashFamily(fam, tSec?)            (amendment B) fam = family id or object: the family top (the planet chip at the
//                                        overview) flashes once: its rim goes toward TOK.pulse, 1 -> 1.75 px, alpha 1,
//                                        300 ms ease-out; a live core pin brightens x1.25 (only cores/pulse heads > 1.0)
//     flashRim(i, tSec)                  now also brightens a FLAT dot (< 8 px coins have no rim; before, arrivals there
//                                        showed nothing)
//     syncXY(list?)                      re-read S.X/S.Y for these coins (every coin when omitted) and upload. The frame
//                                        hook ALSO detects any coin whose S.X/S.Y changed (one 21k compare, ~0.05 ms), so a
//                                        lane that moves coins (dragging, amendment E) only has to mutate S.X/S.Y in place
//     addCoin(i, opts?)                  append a coin that was not in the map at build (SPARE = 512 free instances).
//                                        Reads S.X/Y/R/famOf/age/n24/sym/notable[i] when present, else opts {x, y, r, fam,
//                                        age, n24, sym}. Returns the instance index, or -1 when full/invalid. Then birth(i).
//     tSec is on the uTime clock (seconds, performance.now()/1000); omitted -> S.U.uTime.value.
//   One frame hook: throttled atlas upload (400 ms) while logos stream in; returns true while an atlas upload,
//   a class crossfade or a rim flash is still animating (render-on-demand keeps drawing).
//   Reads shared uniforms: uPx uDpr uTime uDustExpand uHover uHoverFam uMinScale uDimMix uHoverT uK0 uFadeP uFadeD
//   uFocusFam uFocusMix (final polish: other families recede when one owns the view).
//   Debug: S.debug.obj.bubbles (shadows stays null: the drop-shadow pass is deleted); S.debug.map.logos;
//          S.debugFns.bubbleLOD() -> per-LOD instance counts at the current zoom + HDR emitter count.
//   (map3 port) setHl(bitOf(i) -> 0|1, tSec?)  highlight mask over every instance (births included); logoPx(i) = atlas
//                                cell px once that coin's logo is drawn (256 hi, 128 lo), else 0.
import * as THREE from "three";
import { TOK, GAL, FONT, heatClass, coreBoost } from "./tokens.js";
import { rnd } from "./util.js";

// LOD (screen radius, CSS px; spec R10). Bands crossfade over +-0.4 px so zooming never pops.
// (final polish) bands moved up from the spec 3 / 8: below 8 px a coin is a FLAT, OPAQUE disc (no rim: a seed head reads as
// a halftone, not bubble wrap); 8-11 px a dark body + 1 px rim; 11 px and up a matte sphere. Logos from 6 px.
// A coin with no logo cell that is drawn at 14 px or more carries a quiet mono monogram (never an empty dark disc).
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LOD = { body: 8, sphere: 11, logo: 6 };
// (fixer 21:35Z, flat) every family top shows its logo from LOGO_MIN_PX radius (fully in; fades in over the 0.8 px below):
// at the overview 2,305 of 2,366 tops are 3-6 px, so a 6 px threshold left ~97 % of the families as plain dots from far.
// Galaxy is unchanged.
// (bubbles lane, look fix 2026-10-22) flat CHILDREN share the same threshold: a child drawn >= LOGO_MIN_PX takes a LO atlas cell
// (assignCells, biggest first, <= ASSIGN_MAX new cells per pass, LRU eviction of off-screen children only); galaxy keeps 10 px.
// At inu 20x the five biggest children are 4.7-7.6 px and none reached the old 10 px gate.
const LOGO_MIN_PX = 4.5, ASSIGN_MAX = 400;
// flat-disc strength per class (mixed into the ground, opaque): live 0.88, cooling 0.62, quiet 0.52, cold 0.55 (cold is
// a neutral grey that must stay visible); lower than TOK.flatA so a hot seed head is a texture, not a neon mass
const FLAT = [0.80, 0.66, 0.62, 0.48];   // L* 77 / 48 / 37 / 21: the classes separate in greyscale
// sub-pixel stipple dots (the overview colonies) keep the spec strength TOK.flatA x coverage, so a cold colony stays legible
// knock-out halo: every disc of 3 px and up sits in a 1.5 px ring of ground, so hairlines stop short of the beads
const HALO_PX = 1.5;
const FOCUS_DIM = 0.42;   // other families at full focus (alpha factor)
// 24 h arcs: spec section 5 lists them under "above 4k0" (and R4: screen radius >= 8 px). They fade in 3k0 -> 4k0.
// (final polish) the 24 h activity is drawn ON the rim (a brighter 1.5 px segment over a dimmed track), not as a separate
// offset arc, so it can appear earlier without adding an ornament: it fades in 2k0 -> 3k0.
const ARC_K0 = [2.0, 3.0];
// overview stipple (spec section 5: "children as a stipple of 1 to 1.5 px coverage dots", i.e. dot DIAMETERS, like the dust):
// children of planets are capped at a 0.75 px radius (notable ones at 1.5 px) until 1.3k0, released by 2k0
const STIP_PX = 0.75, STIP_NOTABLE_PX = 1.0, STIP_K0 = [1.3, 2.0];
// (flat fix 2026-10-21, bubbles lane; owner items 3 + 5) FLAT-look constants (tokens.js belongs to the veins lane):
//   every child is a visible disc: stipple radii 1.0 / 1.25 CSS px, a 1-device-px radius floor, sub-px coverage >= 0.6;
//   FLAT_F: flat-disc mix per class (live, cooling, quiet, cold): cold rim 0x535b58 x 0.80 over the ground = max channel 76,
//   quiet x 0.70 = 122 (>= 64 at every size), luminance order live > cooling > quiet > cold kept, lime unchanged;
//   FLAT_DOT_F: sub-px dot strength (cold 1.0 x cov 0.6 over the ground = max 60); BODY_TINT_F: the 8 px+ bodies tint toward
//   their rim, so a child's body centre reads max >= 48 (cold 56) instead of the 0x171b1a plate
// (bubbles lane, look fix 2026-10-22) FLAT_F quiet / cold 0.70 / 0.80 -> 0.58 / 0.58: at 4x the 1.4-3 px children of every small
// family read as bright grey fuzz; 0.58 keeps the cold disc's max channel at ~59 (>= 48, the visibility probe) and the class order.
// Stipple radii 1.0 / 1.25 -> 0.85 / 1.1 px and the sub-px dot strength back toward TOK.flatA (quiet 0.75, cold 0.70): a cold
// stipple dot still reads max channel ~60 (>= 48) at the 0.6 coverage floor, and the colonies are a stipple again, not a grey fill.
const STIP_PX_F = 0.85, STIP_NOTABLE_PX_F = 1.1, COV_MIN_F = 0.6;
const FLAT_F = [0.80, 0.66, 0.58, 0.58];
const FLAT_DOT_F = [1.0, 0.85, 0.75, 0.70];
const BODY_TINT_F = [0.22, 0.30, 0.34, 0.45];
// every family top, both looks: min(6, 3 + 3 sqrt(share / maxDustShare)) CSS px (planets: TOK.chipR), floor TOP_MIN_PX (x 0.85 phone)
const TOP_MIN_PX = 3;
// HI (256 px) logo upgrades only for tops drawn at >= HI_UP_PX radius (flat; galaxy keeps asking 256 for its planets)
const HI_UP_PX = 32;
// (round 2) amendment A: live coins breathe, radius +-3 %, period 4-6 s, phase per coin. BREATH_STEP_PX: the largest
// per-render change of a breathing edge we accept, which sets how often the frame hook asks for a render.
const BREATH_A = 0.03, BREATH_P = [4.0, 6.0], BREATH_MIN_PX = 3, BREATH_STEP_PX = 0.1;
// (final fix) battery: the breathing and the rim shimmer are what keeps an idle overview rendering 15 times a second. They
// fade out (BREATH_FADE_MS) once nobody has touched the map for BREATH_SLEEP_MS and come back with the next pointer, wheel,
// touch or camera call; pulses, flashes and births are not affected. Asleep, an idle map renders at the motion loop's 2 Hz.
const BREATH_SLEEP_MS = 30_000, BREATH_FADE_MS = 1_500;
const BIRTH_S = 0.5;        // amendment C: scale-in / fade-in, cubic ease-out
// (round 2) seed-head children (broods over 60, as layout defines them) lose the 1.5 px "notable" floor (down to the
// 0.5 px coverage floor), and below $10k (the legend's smallest size key) they follow a steeper size scale:
// r = rad($10k) x (mcap / $10k)^0.8, never above layout's R, never below 0.25 u. A seed head is ~1,000 coins of almost the
// same value ($3-4k): on rad's log scale they are one size; on this scale the few that took money stand out and the
// untouched launches recede. At and above $10k the size is exactly rad(), so the legend keys stay true.
const SEED_BROOD = 60, SEED_M = 1e4, SEED_G = 0.8, SEED_RMIN = 0.25, SEED_NOCAP = 0.4;
const FAMFLASH_S = 0.3;     // amendment B: family rim flash, ease-out
const SPARE = 512;          // free instances for coins born after the build (addCoin)
const smoothJ = (a, b, t) => { t = Math.max(0, Math.min(1, (t - a) / (b - a))); return t * t * (3 - 2 * t); };

const f3 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

export function buildBubbles(S) {
  const { N, fams, planets, famOf, sym, img, mc, age, n24, notable, R, X, Y, maxShare, U } = S;
  const scene = S.gfx.scene;
  // (visibility lane) shared focus uniforms (physics declares them in state.js; ??= keeps this file working before that lands)
  U.uFocusCoin ??= { value: -1 }; U.uFocusT ??= { value: 0 }; U.uFocusDim ??= { value: 0 };
  const tBuild = performance.now();
  // (galaxy look, 2026-10-21) G = galaxy look; T = S.tok (GAL over TOK) or TOK, so the flat look reads the very same values.
  // Every galaxy change in JS sits behind G, every GLSL change behind #ifdef GALAXY (defines set only when G): flat stays
  // pixel-identical. Galaxy: lit spheres (x heatK, HDR), full-annulus 24 h rims, brightness breathing on uAnimT, additive
  // coronas (S.bubbles.glows), birth ripple, hover sweep.
  const G = S.look === "galaxy", T = S.tok || TOK;
  const SP = G ? STIP_PX : STIP_PX_F, SPN = G ? STIP_NOTABLE_PX : STIP_NOTABLE_PX_F;   // (flat fix) stipple radii per look
  const GRIM = T.rim, GHEATK = T.heatK || GAL.heatK, GSHADE = T.shade || GAL.shade, GBR = T.breath || GAL.breath, GBIRTH = T.birth || GAL.birth, GSWEEP = T.hoverSweep || GAL.hoverSweep;
  const GL3 = new THREE.Vector3(...GSHADE.L).normalize();

  // ======================= logo atlases (visibility lane, 2026-10-21) =======================
  // Two GPU-only atlases (render-target textures, cleared to the pre-fill #123020, never a CPU-side canvas):
  //   LO: 64 x 64 cells of 64 px (4096^2; phone 32 px cells, 2048^2) = 4,096 cells: every family top first, then children
  //       drawn >= LOGO_MIN_PX (flat; galaxy 10 px) by drawn size, LRU eviction of off-screen children. Code 64 + j.
  //   HI: 8 x 8 cells of 256 px (2048^2; phone 128 px, 1024^2) = 64 cells: the planet tops; cell 62 = the selected coin,
  //       63 = the focused coin (S.U.uFocusCoin). Code 0..63.
  // A logo lands in its cell with texSubImage2D (renderer.copyTextureToTexture) in batches <= every 250 ms, <= 2 ms each,
  // then one generateMipmap; the shader clamps the lod so a cell never bleeds into its neighbour. Until the logo is there a
  // coin that owns a cell shows the pre-fill disc (#123020 + its heat-coloured letter, from the glyph texture).
  const CAP = N + SPARE;
  const PHONE = typeof S.phone === "function" ? !!S.phone() : false;
  const LO_CELL = PHONE ? 32 : 64, LO_COLS = 64, LO_N = LO_COLS * LO_COLS, LO_SZ = LO_CELL * LO_COLS;
  const HI_CELL = PHONE ? 128 : 256, HI_COLS = 8, HI_N = HI_COLS * HI_COLS, HI_SZ = HI_CELL * HI_COLS;
  const HI_SEL = HI_N - 2, HI_FOC = HI_N - 1, HI_PLANETS = HI_N - 2;
  const LO_PX = 64, HI_PX = PHONE ? 128 : 256;          // thumbnail sizes asked from the loader
  const PREFILL = 0x123020;
  const logoIdx = new Int16Array(CAP).fill(-1);         // the code each coin draws NOW (-1 = none; 0..63 hi; 64 + j lo)
  const loC = new Int16Array(CAP).fill(-1), hiC = new Int8Array(CAP).fill(-1);   // cell owned per coin
  const loHas = new Uint16Array(CAP), hiHas = new Uint16Array(CAP);              // logo px landed in that cell (0 = pre-fill)
  const loOwn = new Int32Array(LO_N).fill(-1), hiOwn = new Int32Array(HI_N).fill(-1);
  const loUse = new Float64Array(LO_N);                 // last time the owner was wanted (LRU)
  const loPin = new Uint8Array(LO_N);                   // family tops never leave their cell
  const isTopOfPlanet = new Uint8Array(N); for (const f of planets) isTopOfPlanet[f.top] = 1;
  const isTop = new Uint8Array(CAP); for (const f of fams) if (f.top >= 0 && f.top < N) isTop[f.top] = 1;
  const glyphOf = (i) => { const s = String((sym && sym[i]) || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); const q = s ? GLYPHS.indexOf(s[0]) : -1; return q < 0 ? 0 : q; };
  const mkRT = (sz) => {
    const rt = new THREE.WebGLRenderTarget(sz, sz, { depthBuffer: false, stencilBuffer: false, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.SRGBColorSpace, type: THREE.UnsignedByteType });
    rt.texture.anisotropy = 4;
    return rt;
  };
  const renderer = S.gfx && S.gfx.renderer;
  const gl = renderer ? renderer.getContext() : null;
  const HIa = { rt: mkRT(HI_SZ), cell: HI_CELL, cols: HI_COLS, ok: false }, LOa = { rt: mkRT(LO_SZ), cell: LO_CELL, cols: LO_COLS, ok: false };
  const genMips = (A) => {
    if (!renderer || !gl) return;
    const p = renderer.properties.get(A.rt.texture);
    if (!p.__webglTexture) return;
    renderer.state.bindTexture(gl.TEXTURE_2D, p.__webglTexture); gl.generateMipmap(gl.TEXTURE_2D); renderer.state.unbindTexture();
  };
  function clearAtlas(A) {
    if (!renderer) return;
    const prev = renderer.getRenderTarget(), cc = new THREE.Color(), ca = renderer.getClearAlpha(); renderer.getClearColor(cc);
    renderer.setRenderTarget(A.rt); renderer.setClearColor(new THREE.Color(PREFILL), 1); renderer.clear(true, false, false);
    renderer.setRenderTarget(prev); renderer.setClearColor(cc, ca);
    genMips(A); A.ok = true;
  }
  try { clearAtlas(HIa); clearAtlas(LOa); } catch { /* a lost context: the logos stay pre-fill discs */ }
  // one scratch canvas + texture per cell size (a thumbnail of another size is scaled into it)
  const mkScratch = (sz) => { const c = document.createElement("canvas"); c.width = c.height = sz; const t = new THREE.CanvasTexture(c); t.flipY = false; return { c, ctx: c.getContext("2d"), t }; };
  const scLo = mkScratch(LO_CELL), scHi = mkScratch(HI_CELL);
  const dstV = new THREE.Vector2();
  const rawT = {};   // marker: upload the loader's bitmap itself (no scratch canvas)
  const up = { batches: 0, cells: 0, lastMs: 0, maxMs: 0, at: -1e9, fail: 0 };
  // cell assignment
  function takeLo(i, now, pin) {
    if (loC[i] >= 0) { loUse[loC[i]] = now; return loC[i]; }
    let j = -1;
    for (let q = freeLoAt; q < LO_N; q++) if (loOwn[q] < 0) { j = q; freeLoAt = q + 1; break; }
    if (j < 0) return -1;
    loOwn[j] = i; loC[i] = j; loUse[j] = now; loPin[j] = pin ? 1 : 0; loHas[i] = 0;
    return j;
  }
  let freeLoAt = 0;
  function dropLo(j) {
    const o = loOwn[j]; if (o < 0) return;
    loC[o] = -1; loHas[o] = 0; loOwn[j] = -1; loPin[j] = 0; if (j < freeLoAt) freeLoAt = j;
    pendingLogo.delete(o); setCode(o);
  }
  function takeHi(i, cell) {
    if (hiC[i] === cell) return cell;
    const o = hiOwn[cell]; if (o >= 0 && o !== i) { hiC[o] = -1; hiHas[o] = 0; setCode(o); }
    if (hiC[i] >= 0) { hiOwn[hiC[i]] = -1; }
    hiOwn[cell] = i; hiC[i] = cell; hiHas[i] = 0;
    return cell;
  }
  const hiList = [];
  planets.forEach((f) => { if (hiList.length < HI_PLANETS) { takeHi(f.top, hiList.length); hiList.push(f.top); } });
  const loTops = [];
  for (const f of fams) if (f.top >= 0 && f.top < N && hiC[f.top] < 0 && takeLo(f.top, 0, true) >= 0) loTops.push(f.top);
  const logoList = [...hiList, ...loTops];
  // what a coin draws: a landed logo (hi before lo), else the pre-fill letter while its logo may still come, else -1
  // (galaxy: a family top with no logo URL at all carries a quiet monogram, code -50 - glyph)
  function codeFor(i) {
    if (hiC[i] >= 0 && hiHas[i]) return hiC[i];
    if (loC[i] >= 0 && loHas[i]) return 64 + loC[i];
    if (!G) return -1;
    if ((hiC[i] >= 0 || loC[i] >= 0) && img[i] && !failedLogo.has(i)) return -2 - glyphOf(i);
    if (isTop[i]) return -50 - glyphOf(i);
    return -1;
  }
  let setCode = () => {};   // replaced once the instance attributes exist
  const failedLogo = new Set();
  const drawnImg = new Array(CAP).fill(null);
  const images = S.images && typeof S.images.want === "function" ? S.images : null;
  const pendingLogo = new Set();                         // coins whose logo is wanted and not yet in their cell
  const dirty = new Map();                               // coin -> {A, im} waiting for the next upload batch
  const imSize = (im) => (im ? Math.min(im.naturalWidth || im.width || 0, im.naturalHeight || im.height || 0) : 0);
  // (flat fix) a planet asks its 64 first like every other top; the 256 follows once it is drawn >= HI_UP_PX (assignCells),
  // or at once for the selected / focused coin (reserveHi). Galaxy keeps asking 256 for its HI cells.
  const hiWant = new Uint8Array(CAP);
  const wantPx = (i) => (hiC[i] >= 0 && (G || hiWant[i] || hiC[i] >= HI_PLANETS) ? HI_PX : LO_PX);
  // (repair, look fix 2026-10-22) a source the loader gave up on (a 404, a dead sheet cell, a decode failure) is failed here
  // too: before, such a top stayed in pendingLogo for ever (the engine learned a failure only from the test proxy's 1x1)
  // and roots6Dead undercounted, so QA's done condition (roots6Drawn + roots6Dead == roots6) could never be reached.
  const srcFailed = (i) => { if (!images || typeof images.failed !== "function") return false; try { return !!images.failed(img[i]); } catch { return false; } };
  function wantLogo(i) {
    if (!images || !img[i]) return;
    if (srcFailed(i)) { failedLogo.add(i); pendingLogo.delete(i); setCode(i); return; }
    let im = null;
    try { im = images.want(img[i], wantPx(i)); } catch { im = null; }
    if (!im) { pendingLogo.add(i); return; }
    const sz = imSize(im);
    if (!(sz > 2)) { failedLogo.add(i); pendingLogo.delete(i); setCode(i); return; }   // the proxy's 1x1 for a dead upstream
    if (im !== drawnImg[i]) dirty.set(i, im);
    if (sz >= Math.min(wantPx(i), hiC[i] >= 0 ? HI_CELL : LO_CELL)) pendingLogo.delete(i); else pendingLogo.add(i);
  }
  // draw one coin's thumbnail into its cell(s): straight from the bitmap when it is exactly the cell size, else via scratch
  function uploadOne(i, im) {
    let n = 0;
    for (const [A, cell, sc, has] of [[HIa, hiC[i], scHi, hiHas], [LOa, loC[i], scLo, loHas]]) {
      if (cell < 0 || !A.ok) continue;
      const x = (cell % A.cols) * A.cell, y = Math.floor(cell / A.cols) * A.cell;
      const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height, s = Math.min(w, h);
      let src = sc.t;
      if (w === A.cell && h === A.cell) src = rawT;   // the loader's square thumbnail fits the cell: no canvas
      else {
        const ctx = sc.ctx;
        ctx.fillStyle = hex(PREFILL); ctx.fillRect(0, 0, A.cell, A.cell);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
        try { ctx.drawImage(im, (w - s) / 2, (h - s) / 2, s, s, 0, 0, A.cell, A.cell); }
        catch { drawnImg[i] = null; pendingLogo.add(i); return n; }   // a bitmap the loader already closed: ask again
      }
      // one raw texSubImage2D into the bound atlas (three's copyTextureToTexture re-binds, queries 5 unpack parameters and
      // unbinds per call: ~3x slower for a 64 px cell); the unpack state three relies on is set once per batch
      const wt = renderer.properties.get(A.rt.texture).__webglTexture;
      try {
        if (!wt) throw new Error("atlas");
        renderer.state.bindTexture(gl.TEXTURE_2D, wt);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, src === rawT ? im : sc.c);
      } catch { drawnImg[i] = null; pendingLogo.add(i); return n; }
      A.dirtyMips = true; has[i] = Math.min(s, A.cell); n++;
    }
    drawnImg[i] = im;
    return n;
  }
  function uploadBatch(now) {
    // (bubbles lane, look fix 2026-10-22) a burst of logos (a zoom that lands 100+ children / tops at once) is uploaded in 6 ms
    // batches every 100 ms instead of 2 ms every 250 ms, so a screenful reaches the atlas in ~0.3 s, not 2-4 s
    const burst = dirty.size > 32;
    if (!dirty.size || !renderer || now - up.at < (burst ? 100 : 250)) return false;
    const budgetMs = burst ? 6 : 2;
    const t0 = performance.now();
    let n = 0;
    const done = [];
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    for (const [i, im] of dirty) {
      done.push(i);
      if (S.dead) break;
      if (hiC[i] < 0 && loC[i] < 0) continue;
      try { n += uploadOne(i, im); } catch { up.fail++; }
      if (performance.now() - t0 > budgetMs) break;
    }
    for (const i of done) { dirty.delete(i); setCode(i); }
    renderer.state.unbindTexture();
    const tm = performance.now();
    for (const A of [HIa, LOa]) if (A.dirtyMips) { genMips(A); A.dirtyMips = false; }
    const ms = performance.now() - t0; up.mipMs = +(performance.now() - tm).toFixed(3); up.lastN = n;
    up.at = now; up.batches++; up.cells += n; up.lastMs = +ms.toFixed(3); up.maxMs = Math.max(up.maxMs, up.lastMs);
    S.invalidate();
    return true;
  }
  const hex = (h) => "#" + h.toString(16).padStart(6, "0");
  let logoCheckAt = -1e9, logoTimer = 0;
  const recheckLogos = () => {
    logoTimer = 0; logoCheckAt = performance.now();
    if (S.dead || !images || !pendingLogo.size) return;
    for (const i of [...pendingLogo]) {
      let rdy = false; try { rdy = images.ready(img[i]); } catch { rdy = false; }
      if (rdy || srcFailed(i)) wantLogo(i);
    }
  };
  if (images) {
    // newest want first: the most important coin is asked LAST (lo tops by share, then the planet tops by family rank)
    const loByShare = loTops.filter((i) => img[i]).sort((a, b) => (fams[famOf[a]].share || 0) - (fams[famOf[b]].share || 0));
    if (G) {
      for (const i of loByShare) wantLogo(i);
      for (let q = hiList.length - 1; q >= 0; q--) wantLogo(hiList[q]);
    } else {
      // (bubbles lane, look fix 2026-10-22) flat: at build only the PLANET tops are asked (at 64, smallest share first: the biggest
      // is asked last, served first). A dust-family top is not drawn at the overview (its disc fades in with uDustExpand from
      // 1.6 k0, see the vertex shader), so its logo is asked by assignCells (P1) once it is on screen and drawn >= LOGO_MIN_PX.
      // Before, every one of the ~2,300 tops was queued at the overview and the on-screen ones at 4x waited ~20 s behind them.
      const all = hiList.filter((i) => img[i]).sort((a, b) => (fams[famOf[a]].share || 0) - (fams[famOf[b]].share || 0));
      for (const i of all) wantLogo(i);
    }
    let off = null;
    try {
      off = images.onLoaded(() => {
        if (S.dead || logoTimer || !pendingLogo.size) return;
        logoTimer = S.life.timeout(recheckLogos, Math.max(0, logoCheckAt + 250 - performance.now()));
      });
    } catch { off = null; }
    S.life.onDispose(() => { try { if (typeof off === "function") off(); } catch { /* ignore */ } });
  }

  // ======================= monogram glyphs (coins without a logo cell) =======================
  const GC = 128, GCOLS = 6, gCan = document.createElement("canvas"); gCan.width = GC * GCOLS; gCan.height = GC * GCOLS;
  const gTex = new THREE.CanvasTexture(gCan); gTex.generateMipmaps = true; gTex.minFilter = THREE.LinearMipmapLinearFilter; gTex.magFilter = THREE.LinearFilter; gTex.anisotropy = 4;
  // (map3 port) monograms stay disabled (no instance samples this texture); it is drawn once, in the site's mono face
  const drawGlyphs = () => {
    const g = gCan.getContext("2d"); g.clearRect(0, 0, gCan.width, gCan.height);
    g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle"; g.font = `500 ${Math.round(GC * 0.5)}px ${FONT.mono}`;
    [...GLYPHS].forEach((ch, q) => g.fillText(ch, (q % GCOLS) * GC + GC / 2, Math.floor(q / GCOLS) * GC + GC / 2 + GC * 0.02));
    gTex.needsUpdate = true; S.invalidate();
  };
  drawGlyphs();

  // ======================= instances =======================
  const famTop = (i) => i === fams[famOf[i]].top;
  // (final polish) every coin, planet tops included, is coloured by ITS OWN last trade: one meaning per channel, and the
  // tooltip can never say "just now" next to "24 h trades 0". A family's activity shows in its stipple of children.
  // (fixer 15:14Z, galaxy only) the monolith M:200/205 colours a family's ROOT by the family's age (min of its members) and rings it
  // by the family's 24 h trades: that is why the refs' roots are lit lime spheres. Flat keeps the coin's own values.
  const ageOf = (i) => (G && famTop(i) ? fams[famOf[i]].age : age[i]);
  const n24Of = (i) => (G && famTop(i) ? fams[famOf[i]].n24 : n24[i]);
  const famMinCls = (f) => { let c = 3; for (const m of f.members) { if (m !== f.top && cls[m] < c) { c = cls[m]; if (!c) break; } } return c; };   // children only: the root's stored class is the family's
  // CAP (instances and coin indices the mesh can hold; coins N.. are added by addCoin) is declared with the atlases
  const cls = new Uint8Array(CAP);
  for (let i = 0; i < N; i++) cls[i] = heatClass(ageOf(i));
  // draw order: cold first, live last; small before large; planet tops last of all
  const perm = Array.from({ length: N }, (_, i) => i).sort((a, b) =>
    (isTopOfPlanet[a] - isTopOfPlanet[b]) || (cls[b] - cls[a]) || (R[a] - R[b]) || (a - b));
  const invIdx = new Int32Array(CAP).fill(-1); perm.forEach((i, k) => { invIdx[i] = k; });
  let count = N;   // instances in use

  const quad = new THREE.PlaneGeometry(2, 2);
  const bGeo = new THREE.InstancedBufferGeometry(); bGeo.index = quad.index; bGeo.setAttribute("position", quad.getAttribute("position"));
  const aHeat = new Float32Array(CAP * 4), aA = new Float32Array(CAP * 4), aB = new Float32Array(CAP * 4);
  const aFlash = new Float32Array(CAP * 3).fill(-1e3);   // (round 2) t (s) of the last rim flash, family flash, core flash
  // (round 2) birth start (s), birth mode (0 scale, 1 fade), seed-head size factor (drawn / layout R once zoomed past 2k0)
  const aBirth = new Float32Array(CAP * 3); for (let k = 0; k < CAP; k++) { aBirth[k * 3] = -1e3; aBirth[k * 3 + 1] = 0; aBirth[k * 3 + 2] = 1; }
  const aXY = new Float32Array(CAP * 2);                 // (round 2) world centre, re-read from S.X/S.Y when a coin moves
  const aHl = new Float32Array(CAP * 2).fill(1);         // (map3 port) highlight: (shown when the crossfade started, target)
  const mX = new Float32Array(CAP), mY = new Float32Array(CAP);   // the S.X/S.Y values last uploaded, per COIN
  const m4 = new THREE.Matrix4();
  const bubbles = new THREE.InstancedMesh(bGeo, null, CAP);
  bubbles.count = N;
  const { par, kids } = S;
  const seedKid = (i) => par[i] >= 0 && kids[par[i]] && kids[par[i]].length > SEED_BROOD;
  const radFn = typeof S.rad === "function" ? S.rad : (m) => (!(m > 0) ? 0.55 : m < 2000 ? 0.55 + 0.45 * Math.max(0, Math.min(1, Math.log(m / 300) / Math.log(2000 / 300))) : Math.min(7, 1 + 1.54 * Math.log10(m / 2000)));
  const rSeed10k = radFn(SEED_M);
  // drawn world radius per coin (layout's R, or the seed-head scale); exported as S.bubbles.drawR
  const drawR = new Float32Array(CAP);
  let nSeedKids = 0, nShrunk = 0;
  // (visibility lane) exports for the veins / focus / physics lanes: the static CSS-px floor per coin (phone factor applied)
  const PHK = PHONE ? 0.85 : 1;
  let maxDustShare = 0; for (const f of fams) if (!f.planet && (f.share || 0) > maxDustShare) maxDustShare = f.share;
  if (!(maxDustShare > 0)) maxDustShare = 1;
  const minPxS = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const i = perm[k], f = fams[famOf[i]], top = i === f.top, a = ageOf(i);
    aHeat.set([cls[i], cls[i], -1e3, coreBoost(a)], k * 4);
    const seed = !top && seedKid(i); if (seed) nSeedKids++;
    let rr = R[i];
    if (seed && mc[i] > 0 && mc[i] < SEED_M) { const s = Math.max(SEED_RMIN, rSeed10k * Math.pow(mc[i] / SEED_M, SEED_G)); if (s < rr) { rr = s; nShrunk++; } }
    else if (seed && !(mc[i] > 0) && rr > SEED_NOCAP) { rr = SEED_NOCAP; nShrunk++; }   // (round 2 final) no market cap in the data
    drawR[i] = rr;
    // (visibility lane) galaxy: every dust-family top is a lit disc at the overview, 3 + 3 sqrt(share / maxDustShare) px (<= 6)
    // (flat fix) both looks: every dust-family top is a disc of min(6, 3 + 3 sqrt(share / maxDustShare)) >= 3 CSS px
    const minPx = top && f.planet ? TOK.chipR(f.share, maxShare, false) : top ? Math.max(TOP_MIN_PX, Math.min(6, 3 + 3 * Math.sqrt(Math.max(0, f.share || 0) / maxDustShare))) : notable[i] && !seed ? 1.5 : 0;   // phone x0.85 via uMinScale
    minPxS[i] = Math.max(0.5, minPx * PHK, G && !f.planet ? (top ? 2.5 : 1.0) : 0);
    const sweep = Math.min(1, Math.log10(1 + Math.max(0, n24Of(i))) / TOK.arcLogDen);
    const lz = codeFor(i); logoIdx[i] = lz;   // (visibility lane) -1 none, >= 0 a landed logo cell, <= -2 the galaxy pre-fill letter
    aA.set([minPx, sweep, lz, notable[i]], k * 4);
    aB.set([f.planet ? 0 : 1, i, f.id, top ? 1 : 0], k * 4);
    aBirth[k * 3 + 2] = R[i] > 0 ? rr / R[i] : 1;
    m4.makeScale(R[i], R[i], 1); m4.setPosition(X[i], Y[i], f.planet ? 2 : 1); bubbles.setMatrixAt(k, m4);
    aXY[k * 2] = mX[i] = X[i]; aXY[k * 2 + 1] = mY[i] = Y[i];
  }
  const aIn = new Float32Array(CAP), atIn = new THREE.InstancedBufferAttribute(aIn, 1); atIn.setUsage(THREE.DynamicDrawUsage);
  bGeo.setAttribute("aIn", atIn);
  const atHeat = new THREE.InstancedBufferAttribute(aHeat, 4), atFlash = new THREE.InstancedBufferAttribute(aFlash, 3);
  const atBirth = new THREE.InstancedBufferAttribute(aBirth, 3), atXY = new THREE.InstancedBufferAttribute(aXY, 2);
  const atA = new THREE.InstancedBufferAttribute(aA, 4), atB = new THREE.InstancedBufferAttribute(aB, 4);
  const atHl = new THREE.InstancedBufferAttribute(aHl, 2);
  for (const at of [atHeat, atFlash, atBirth, atXY, atHl, atA]) at.setUsage(THREE.DynamicDrawUsage);
  // (visibility lane) a coin's atlas code changed (logo landed, cell lost, pre-fill): one float of aA
  setCode = (i) => { const k = invIdx[i]; const c = codeFor(i); if (i < CAP) logoIdx[i] = c; if (k < 0 || aA[k * 4 + 2] === c) return; aA[k * 4 + 2] = c; touch(atA, k * 4 + 2, 1); S.invalidate(); };
  bGeo.setAttribute("aHl", atHl);
  bGeo.setAttribute("aHeat", atHeat);
  bGeo.setAttribute("aA", atA);
  bGeo.setAttribute("aB", atB);
  bGeo.setAttribute("aFlash", atFlash);
  bGeo.setAttribute("aBirth", atBirth);
  bGeo.setAttribute("aXY", atXY);

  // ======================= shaders =======================
  // Every length is in DEVICE px (vP, vR). rc = vR / uDpr is the CSS radius the LOD bands use.
  // Output is premultiplied; only the pin of a live core exceeds 1.0 (bloom threshold 1.0).
  const L = new THREE.Vector3(-0.25, 0.65, 0.72).normalize();
  const BUBBLE_VS = /* glsl */`
uniform float uPx, uDpr, uTime, uDustExpand, uHover, uHoverFam, uMinScale, uDimMix, uHoverT, uK0, uFadeP, uFadeD, uSelected, uFocusFam, uFocusMix;
uniform vec3 uRim[4]; uniform float uRimA[4]; uniform float uFlatA[4]; uniform vec3 uBodyS[4]; uniform vec3 uBodyF[4]; uniform vec3 uFlatC[4];
uniform float uLogoSat[4]; uniform float uLogoVal[4]; uniform vec3 uCore[2]; uniform vec3 uGround;
uniform float uBreath; uniform vec3 uPulseCol, uGlowCol;
uniform float uHlT0;    // (map3 port) start of the last highlight crossfade (s, uTime clock)
uniform float uAnimT, uGalT, uFlow, uLook; uniform float uHeatK[4];   // (galaxy) declared in both looks, read under GALAXY only
uniform float uFocusCoin, uFocusT, uFocusDim;   // (visibility lane) the focus lane animates them
#ifdef GALAXY
varying vec2 vFoc;      // (visibility lane) focus weight of THIS coin (uFocusT), dim factor for every other coin
varying vec4 vGal;      // (galaxy) brightness breath, rim annulus thickness (device px), hover-sweep x (9 = none), birth ripple t (-1 = none)
varying vec2 vGal2;     // (galaxy) full radius (device px, before the birth scale), live weight
#endif
attribute vec2 aHl;     // (map3 port) highlight: (shown value when the crossfade started, target); 1 = match, 0 = dimmed
attribute vec2 aXY;     // (round 2) world centre (follows S.X/S.Y; the instance matrix keeps scale + z)
attribute vec3 aBirth;  // (round 2) birth start (s), mode (0 scale, 1 fade), seed-head size factor
attribute vec4 aHeat;   // cls, prevCls, tChange (s), coreBoost
attribute vec4 aA;      // minPx (CSS), arcSweep 0..1, logoIdx, notable
attribute vec4 aB;      // isDust, coinIdx, famId, isTop
attribute vec3 aFlash;  // time (s) of the last rim flash, family flash, core flash
attribute float aIn;    // (final polish) 1 while the labels lane prints this coin's name inside its disc
varying vec2 vP;        // fragment offset from the centre, device px
varying float vR;       // drawn radius, device px
varying vec4 vRim;      // rim rgb (flash applied, linear), rim alpha
varying vec4 vK;        // unused, coverage (sub-px dots), logo saturation, logo value
varying vec3 vFlat;     // flat-disc colour (opaque premix of the rim into the ground)
varying vec3 vFlatD;    // stipple-dot colour (sub-px coins): rim premixed at TOK.flatA
varying vec3 vBodyS;    // matte-sphere body (rc >= 8): body tinted toward the rim by TOK.tint, mixed in sRGB
varying vec3 vBodyF;    // flat body (3-8 px): body tinted 35 % toward the rim, mixed in sRGB
varying vec4 vCore;     // core rgb (HDR when live), core weight (live only)
varying vec4 vG;        // core min radius (device px), core radius fraction, arc sweep, arc visibility
varying vec4 vF;        // logoIdx, ring alpha (hover/selected), instance alpha (gate*fade*dim), hover t
varying float vTop;     // 1 for a planet chip (its logo keeps most of its colour whatever the heat)
varying vec3 vT;        // LOD weights: flat->body+rim, flat body->sphere, body->logo
varying float vFam;     // (round 2) family-flash weight 0..1 (rim width)
const float TAU_V = 6.28318530718;
vec3 coreCol(float c, float boost){ return c < 0.5 ? uCore[0] * boost : uCore[1] * ${f3(TOK.coreK.cool)}; }
void main(){
  vec3 c = vec3(aXY, instanceMatrix[3].z);
  // true radius, device px. (round 2) seed-head children below $10k switch to the steeper size scale (aBirth.z) while the
  // overview stipple releases (1.3k0 -> 2k0), so the overview keeps its look and the hierarchy shows once zoomed in
  float rel = smoothstep(${f3(STIP_K0[0])} * uK0, ${f3(STIP_K0[1])} * uK0, uPx / uDpr);
  float rpx0 = length(instanceMatrix[0].xyz) * uPx * mix(1.0, aBirth.z, rel);
  float rpx = max(rpx0, aA.x * uDpr * uMinScale);
  float cov = 1.0;
  if (aA.w < 0.5) cov = clamp(rpx0 / uDpr, ${G ? "0.15" : f3(COV_MIN_F)}, 1.0);   // sub-px coins: 1-device-px dot, thinness as alpha (flat: >= 0.6)
  cov = max(cov, 0.85 * exp(-max(0.0, uTime - max(aFlash.x, aFlash.y)) / 16.0));   // (round 2 final) afterglow keeps a traded speck visible
  rpx = max(rpx, ${G ? "0.5 * uDpr" : "max(0.5 * uDpr, 1.0)"});   // (flat fix: radius >= 1 device px) the 0.5 px coverage floor (round 2: every coin; seed-head notables have no 1.5 px floor)
  // overview stipple (spec section 5, integration): at k <= 1.3k0 a planet's children are 1-1.5 px coverage dots, so a
  // colony reads as a fine stipple around its chip, not a filled disc; they grow to their true size by 2k0.
  // (round 2 final) a stipple dot that traded keeps a slightly larger, brighter afterglow (~50 s): the overview shows WHERE
  // the last minute's trades happened as fading specks across the colonies
  float glowE = exp(-max(0.0, uTime - max(aFlash.x, aFlash.y)) / 16.0);
  if (aB.w < 0.5 && aB.x < 0.5) rpx = mix(min(rpx, ((aA.w > 0.5 ? ${f3(SPN)} : ${f3(SP)}) + 0.75 * glowE) * uDpr), rpx, rel);
#ifdef GALAXY
  // (visibility lane) every family is a bubble at the overview: a dust-family top is a lit disc of >= 2.5 px (its aA.x floor
  // x uMinScale), a dust-family member a 1 px speck at alpha 0.7 (full once it is drawn at 3 px); nothing waits for uDustExpand
  float a = 1.0;
  if (aB.w > 0.5) cov = 1.0;
  if (aB.x > 0.5) {
    if (aB.w > 0.5) rpx = max(rpx, max(aA.x * uMinScale, 2.5) * uDpr);
    else { rpx = max(rpx, 1.0 * uDpr); cov = 1.0; a = mix(0.7, 1.0, smoothstep(1.0, 3.0, rpx0 / uDpr)); }
  }
#else
  // dust families appear as the dust field hands off (1.6 k0 ->): at the overview a small family is a 1.2-2 px speck drawn by
  // dust.js, not a disc. (bubbles lane, look fix 2026-10-22: the flat fix's "every top alpha 1 at every zoom" made the overview a
  // dense ball of 6-12 px heat discs; the 3-6 px floor (aA.x) still applies once the family opens, which is what reads far in)
  float a = mix(1.0, uDustExpand, aB.x);
  if (aB.w > 0.5) cov = 1.0;                                  // a family top is never a coverage dot
#endif
  a *= aB.x > 0.5 ? uFadeD : uFadeP;
  if (uHoverFam > -0.5 && abs(aB.z - uHoverFam) > 0.5) a *= mix(1.0, ${f3(TOK.dim)}, uDimMix);
  // (final polish) focus: when a family owns the view the others recede
  if (uFocusFam > -0.5 && abs(aB.z - uFocusFam) > 0.5 && abs(aB.z - uHoverFam) > 0.5) a *= mix(1.0, ${f3(G ? 1.0 : FOCUS_DIM)}, uFocusMix);
  // (map3 port) highlight: a coin that does not match dims like the hover dim (160 ms crossfade); hit-testing is unchanged
  a *= mix(${f3(TOK.dim)}, 1.0, mix(aHl.x, aHl.y, smoothstep(uHlT0, uHlT0 + 0.16, uTime)));
  // heat class crossfade in time (never through hue space)
  int ci = int(aHeat.x + 0.5), pi = int(aHeat.y + 0.5);
  float t = smoothstep(aHeat.z, aHeat.z + 0.6, uTime);
  // rim flash (pulse arrival): x1.25 and (round 2) 45 % toward the pulse colour, 300 ms; (1 - t)^2 = ease-out
  float fr = uTime >= aFlash.x ? pow(1.0 - clamp((uTime - aFlash.x) / 0.3, 0.0, 1.0), 2.0) : 0.0;
  float flash = 1.0 + 0.25 * fr;
  // (round 2, amendment B) family flash: the rim runs toward the pulse colour, full alpha, 1.75 px, 300 ms ease-out
  float ff = uTime >= aFlash.y ? pow(1.0 - clamp((uTime - aFlash.y) / ${f3(FAMFLASH_S)}, 0.0, 1.0), 2.0) : 0.0;
  vFam = ff;
  float toP = max(0.45 * fr, 0.85 * ff);
  vRim = vec4(mix(mix(uRim[pi], uRim[ci], t) * flash, uPulseCol, toP), mix(mix(uRimA[pi], uRimA[ci], t), 1.0, max(0.5 * fr, ff)));
  vK = vec4(0.0, cov, mix(uLogoSat[pi], uLogoSat[ci], t), mix(uLogoVal[pi], uLogoVal[ci], t));
  // (round 2) flat dots (< 8 px) have no rim: a flash shows on the dot itself (capped at 0.92 in the fragment shader)
  float toPF = max(0.45 * fr, 0.6 * ff);
  vFlat = mix(mix(uFlatC[pi], uFlatC[ci], t) * flash, uPulseCol, toPF);
  vFlatD = mix(mix(uGround, mix(uRim[pi], uRim[ci], t), mix(uFlatA[pi], uFlatA[ci], t)) * flash, uPulseCol, toPF);
  vTop = (aB.w > 0.5 && aA.x > 0.0) ? 1.0 : 0.0;
  vBodyS = mix(uBodyS[pi], uBodyS[ci], t); vBodyF = mix(uBodyF[pi], uBodyF[ci], t);
  float wP = aHeat.y < 0.5 ? 1.0 : 0.0, wC = aHeat.x < 0.5 ? 1.0 : 0.0;   // (final polish) a core marks LIVE only
  vec3 cP = coreCol(aHeat.y, ${f3(TOK.coreK.live30)}), cC = coreCol(aHeat.x, aHeat.w);
  vCore = vec4(wP * wC > 0.5 ? mix(cP, cC, t) : (wC > 0.5 ? cC : cP), mix(wP, wC, t));
  // (round 2) a live core pin brightens x1.25 with a family flash or flashCore (300 ms ease-out; only the pin passes 0.92)
  float fc = uTime >= aFlash.z ? pow(1.0 - clamp((uTime - aFlash.z) / ${f3(FAMFLASH_S)}, 0.0, 1.0), 2.0) : 0.0;
  vCore.rgb *= 1.0 + 0.25 * max(ff, fc);
  vec2 cr = vec2(1.25, 0.14);
  float rc = rpx / uDpr, k = uPx / uDpr;
  // (round 2 final) 'live' is the rim alone on an ordinary coin: the lime core pin stays on family tops (roots and planet
  // chips) and on coins drawn >= 40 px. A ring + olive fill + pin on every live coin read as a row of radio buttons.
  vCore.w *= max(aB.w > 0.5 ? 1.0 : 0.0, smoothstep(36.0, 44.0, rc));
  float arcOn = smoothstep(${f3(LOD.sphere - 0.6)}, ${f3(LOD.sphere + 0.6)}, rc) * smoothstep(${f3(ARC_K0[0])} * uK0, ${f3(ARC_K0[1])} * uK0, k);   // rim gauge (also for 0 trades: an all-track rim)
  vG = vec4(cr.x * uDpr, cr.y, aA.y, arcOn);
  float hv = abs(aB.y - uHover) < 0.5 ? uHoverT : 0.0;
  float sel = abs(aB.y - uSelected) < 0.5 ? 1.0 : 0.0;
  float ringA = max(hv, sel) * ${f3(TOK.hoverA)};
  float glyphOK = (aHeat.x > 0.5 && aIn < 0.5) ? 1.0 : 0.0;   // monogram: not on live coins (core), not under a name
  vF = vec4(aA.z < -1.5 && glyphOK < 0.5 ? -1.0 : aA.z, ringA, a, hv);
  if (aIn > 0.5) vCore.w = 0.0;
  // LOD bands (spec R10) crossfade over a fraction of a px. Planet chips (min ${TOK.chipR(0, 1, true).toFixed(1)} px on phone) always carry their logo.
  float lo = ${G ? `(aB.w > 0.5 && aA.x > 0.0) ? 4.0 : ${f3(LOD.logo - 0.8)}` : f3(LOGO_MIN_PX - 0.8)};   // (fixer) flat: every coin from LOGO_MIN_PX (look fix: children too)
  vT = vec3(smoothstep(${f3(LOD.body - 0.4)}, ${f3(LOD.body + 0.4)}, rc), smoothstep(${f3(LOD.sphere - 0.6)}, ${f3(LOD.sphere + 0.6)}, rc), aA.z > -0.5 ? smoothstep(lo, lo + 0.8, rc) : 0.0);
  vT.x = max(vT.x, vT.z);   // (final polish) a logo chip is a body + rim from its logo threshold, below the 8 px body band
  // (round 2, amendment A) live coins breathe: radius +-3 %, 4-6 s period, phase per coin (golden-ratio hashes of the coin
  // index), crossfading with the heat class. The LOD bands above use the steady radius, so a coin sitting on a band edge
  // never flickers between looks. uBreath = 0 under reduced motion.
  float liveW = mix(wP, wC, t);
  float per = ${f3(BREATH_P[0])} + ${f3(BREATH_P[1] - BREATH_P[0])} * fract(aB.y * 0.7548776662 + 0.137);
  float breath = 1.0 + ${f3(BREATH_A)} * uBreath * liveW * smoothstep(16.0, 24.0, rc) * sin(TAU_V * (uTime / per + fract(aB.y * 0.6180339887)));
  // (round 2 final) +-3 % of a 15 px overview chip is +-0.45 px: invisible, so the radius breathes only from ~20 px. Live
  // rims also shimmer in opacity (0.6 <-> 1, 4.3-6.1 s, phase per coin), which reads at every zoom. uBreath = 0 under
  // reduced motion.
  float shim = 1.0 - 0.55 * uBreath * liveW * (0.5 + 0.5 * sin(TAU_V * (uTime / (per * 0.8) + fract(aB.y * 0.3819660113 + 0.29))));
  // afterglow: a rim (or flat dot) that flashed keeps a brighter level that decays over ~50 s, so a busy family shows its
  // tempo between flashes. Toward ink, never lime (lime = live only).
  float glow = exp(-max(0.0, uTime - max(aFlash.x, aFlash.y)) / 16.0) * (1.0 - max(fr, ff));
  vRim.a = mix(vRim.a * shim, 1.0, 0.55 * glow);
  vRim.rgb = mix(vRim.rgb, uGlowCol, 0.28 * glow);
  vFlat = mix(vFlat, uGlowCol, 0.22 * glow); vFlatD = mix(vFlatD, uGlowCol, 0.45 * glow);
#ifdef GALAXY
  // (galaxy) the heat colour is HDR (rim x heatK: live 1.9 blooms), crossfaded in time and pushed toward the pulse colour by a
  // flash; no radius breathing / rim shimmer here (the brightness breathes instead, below); lit spheres from 3 px
  {
    vec3 hc = mix(uRim[pi] * uHeatK[pi], uRim[ci] * uHeatK[ci], t) * flash;
    vRim = vec4(mix(hc, uPulseCol * 1.6, toP), 0.95);
    breath = 1.0;
    // 24 h ring level from the log sweep (arcLogDen = log10(5001)): 0 / <20 -> 1 / <200 -> 2 / <2000 -> 3 / else 4
    float n24 = pow(10.0, aA.y * 3.699057) - 1.0;
    float lvl = n24 < 0.5 ? 0.0 : n24 < 20.0 ? 1.0 : n24 < 200.0 ? 2.0 : n24 < 2000.0 ? 3.0 : 4.0;
    float ph = fract(sin(aB.y * 12.9898 + 3.0 * 78.233) * 43758.5453) * TAU_V;   // rnd(i, 3)
    float bm = mix(${f3(1 - GBR.restAmp)} + ${f3(GBR.restAmp)} * sin(${f3(GBR.restHz)} * uAnimT + ph), ${f3(1 - GBR.liveAmp)} + ${f3(GBR.liveAmp)} * sin(${f3(GBR.liveHz)} * uAnimT + ph), liveW);
    float ripple = uTime >= aBirth.x && uTime < aBirth.x + ${f3(GBIRTH.ms / 1000)} ? (uTime - aBirth.x) / ${f3(GBIRTH.ms / 1000)} : -1.0;
    vGal = vec4(mix(1.0, bm, uBreath), (0.5 + 0.7 * lvl) * uDpr, hv > 0.0 ? mix(-1.2, 1.2, hv) : 9.0, ripple);
    vGal2 = vec2(rpx, liveW);
    // (visibility lane) lit discs from 2.5 px; a landed logo (or the pre-fill letter) shows at ANY size
    vT.z = aA.z > -0.5 ? 1.0 : 0.0;
    vT.x = max(smoothstep(2.1, 2.9, rc), vT.z); vT.y = vT.x;
    vF.x = aA.z;
    float isF = (uFocusCoin > -0.5 && abs(aB.y - uFocusCoin) < 0.5) ? 1.0 : 0.0;
    vFoc = vec2(isF * uFocusT, uFocusCoin > -0.5 && isF < 0.5 ? 1.0 - 0.6 * uFocusDim : 1.0);
  }
#endif
  // (round 2, amendment C) birth: scale 0 -> 1 (cubic ease-out), or fade in when the parent is unknown
  float bt = clamp((uTime - aBirth.x) / ${f3(BIRTH_S)}, 0.0, 1.0), be = 1.0 - (1.0 - bt) * (1.0 - bt) * (1.0 - bt);
  float rD = rpx * breath * (aBirth.y > 0.5 ? 1.0 : be);
  a *= aBirth.y > 0.5 ? be : 1.0;
  vF.z = a;
  // quad extent: disc + knock-out halo (+ hover ring) + AA
  float ext = rD + ${f3(HALO_PX + 1.0)} * uDpr;
  if (ringA > 0.0) ext = rD + 5.0 * uDpr;
#ifdef GALAXY
  ext = max(ext, rD + 2.3 * uDpr + vGal.y);                                             // the rim annulus sits outside the disc
  if (vGal.w >= 0.0) ext = max(ext, ${f3(GBIRTH.r1 + GBIRTH.w)} * rpx + 1.0 * uDpr);   // the birth ripple
  if (vFoc.x > 0.0) ext = max(ext, max(2.4 * rD, (rD + 8.0 * uDpr) * 1.15 + 2.0 * uDpr));   // focus: quad x 2.4 (ring + halo)
#endif
  vP = position.xy * ext; vR = rD;
  gl_Position = projectionMatrix * viewMatrix * vec4(c.xy + position.xy * ext / uPx, c.z, 1.0);
  if (a * max(cov, ringA) < 0.003 || rD <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // fully faded / unborn: cull
}`;
  const BUBBLE_FS = /* glsl */`
uniform sampler2D uAtlasHi, uAtlasLo, uGlyphs;
uniform vec4 uAtlHi, uAtlLo;   // (visibility lane) per atlas: cell px, columns, atlas px, max lod (the cell never bleeds)
uniform vec3 uPrefill, uFocusCol; uniform float uAnimT;
uniform float uDpr, uArcA, uTrackA;
uniform vec3 uBody, uSep, uArcCol, uHoverCol, uGround, uMonoInk;
uniform vec3 uBirthCol;
varying vec2 vP; varying float vR;
#ifdef GALAXY
varying vec4 vGal; varying vec2 vGal2; varying vec2 vFoc;
const vec3 GLIGHT = vec3(${GL3.x.toFixed(5)}, ${GL3.y.toFixed(5)}, ${GL3.z.toFixed(5)});
#endif
varying vec4 vRim, vK, vCore, vG, vF; varying vec3 vT, vBodyS, vBodyF, vFlat, vFlatD; varying float vTop, vFam;
const float AA = 0.75;                 // edge feather, device px
const float TAU = 6.28318530718;
const vec3 LIGHT = vec3(${L.x.toFixed(5)}, ${L.y.toFixed(5)}, ${L.z.toFixed(5)});
const vec3 CAP = vec3(0.92);           // every non-core colour stays <= 0.92 linear
float inside(float d, float r){ return clamp(0.5 + (r - d) / AA, 0.0, 1.0); }
float stroke(float dist, float hw){ return clamp(0.5 + (hw - dist) / AA, 0.0, 1.0); }
void over(inout vec4 acc, vec3 col, float a){ acc = vec4(col * a, a) + acc * (1.0 - a); }
// (visibility lane) u: unit disc, y up; samples 87.5 % of the cell's circle. rl = the drawn logo radius in device px, so the
// lod is exact (texels per device px) and clamped to log2(cell) - 3: a mip texel never spans two cells.
vec3 atlasAt(sampler2D tex, vec4 A, float j, vec2 u, float rl){
  vec2 px = vec2(mod(j, A.y), floor(j / A.y)) * A.x + 0.5 * A.x + vec2(u.x, -u.y) * (0.4375 * A.x);
  float lod = clamp(log2(max(1e-3, 0.4375 * A.x / max(rl, 0.5))), 0.0, A.w);
  vec4 t = textureLod(tex, px / A.z, lod);
  return mix(uPrefill, t.rgb, t.a);   // a transparent logo (bitmap uploaded as is) sits on the pre-fill, never on black
}
vec3 logoTex(float idx, vec2 u, float rl){
  if (idx < 63.5) return atlasAt(uAtlasHi, uAtlHi, idx, u, rl);
  return atlasAt(uAtlasLo, uAtlLo, idx - 64.0, u, rl);
}
void main(){
  float d = length(vP), R = vR, dpr = uDpr, rc = R / dpr;
  vec3 rim = vRim.rgb;
  vec4 acc = vec4(0.0);
  // knock-out halo (final polish): a 1.5 px ring of ground under every disc of 3 px and up, so links, generation arcs and the
  // dust stop short of the bead instead of running over it
  float halo = smoothstep(2.5, 3.5, rc);
#ifdef GALAXY
  halo = 0.0;   // (fixer) galaxy: no knock-out ring (it cut a 3 px dark gap between every vein and its sphere, G3; and bubble-wrapped dust tops)
#endif
  if (halo > 0.0) over(acc, uGround, 0.9 * halo * inside(d, R + ${f3(HALO_PX)} * dpr));
  // hover / selection ring: 1 px, 3 px outside the rim
  if (vF.y > 0.0) over(acc, uHoverCol, vF.y * stroke(abs(d - (R + 3.0 * dpr)), 0.5 * dpr));
  // the disc
  float disc = inside(d, R);
  float tB = vT.x, tS = vT.y, tL = vT.z;
  if (disc > 0.0) {
    // (a)/(b) coverage dot / flat disc: the rim colour premixed into the ground, OPAQUE (a bead never shows a line through it)
    vec3 col = min(mix(vFlatD, vFlat, smoothstep(0.8, 1.4, rc)), CAP); float alpha = vK.y;
#ifdef GALAXY
    // (galaxy) a lit sphere from 3 px: diffuse + specular + fresnel in the HDR heat colour (no 0.92 cap); the logo keeps its own
    // colour; the body breathes in brightness; hover x1.35 + a white sweep band
    if (tB > 0.0) {
      vec2 p = vP / R; vec3 n = vec3(p, sqrt(max(0.0, 1.0 - dot(p, p))));
      float dif = max(dot(n, GLIGHT), 0.0);
      float spec = pow(max(reflect(-GLIGHT, n).z, 0.0), ${f3(GSHADE.specPow)});
      float fres = pow(1.0 - n.z, ${f3(GSHADE.fresnelPow)});
      vec3 hc = rim;
      vec3 b = hc * 0.82;
      vec3 body = b * (0.55 + 0.55 * dif) + 0.22 * spec * min(vec3(1.0), hc + 0.3) + 0.55 * fres * hc;
      // (visibility lane, monolith M:196-268) a landed logo: atlas (0.78 + 0.32 dif) + 0.28 spec + 0.9 rim x heat colour
      if (tL > 0.0 && vF.x > -0.5) {
        float rl = max(R - 0.5 * dpr, 0.5);
        vec3 lc = logoTex(vF.x, vP / rl, rl);
        vec3 lb = lc * (0.78 + 0.32 * dif) + 0.28 * spec + 0.9 * fres * hc;
        body = mix(body, lb, tL);
      }
      // the pre-fill (logo on its way): #123020 lit like a logo, with the coin's first letter in its heat colour
      if (vF.x < -1.5 && vF.x > -49.5) {
        vec3 pf = uPrefill * (0.78 + 0.32 * dif) + 0.28 * spec + 0.9 * fres * hc;
        float gq = -vF.x - 2.0, gw = smoothstep(4.0, 6.0, rc);
        vec2 gu = vP / (1.65 * R) + 0.5;
        if (gw > 0.0 && gu.x > 0.0 && gu.x < 1.0 && gu.y > 0.0 && gu.y < 1.0) {
          vec2 cellP = vec2(mod(gq, 6.0), floor(gq / 6.0));
          float ga = texture2D(uGlyphs, vec2((cellP.x + gu.x) / 6.0, 1.0 - (cellP.y + 1.0 - gu.y) / 6.0)).a;
          pf = mix(pf, hc, ga * gw);
        }
        body = pf;
      }
      // a family top with no logo URL: the lit heat sphere with a quiet inked monogram (the ref's grey 'U' on $USDC)
      if (vF.x < -49.5) {
        float gq = -vF.x - 50.0, gw = smoothstep(13.0, 15.0, rc) * tB;
        vec2 gu = vP / (1.65 * R) + 0.5;
        if (gw > 0.0 && gu.x > 0.0 && gu.x < 1.0 && gu.y > 0.0 && gu.y < 1.0) {
          vec2 cellP = vec2(mod(gq, 6.0), floor(gq / 6.0));
          float ga = texture2D(uGlyphs, vec2((cellP.x + gu.x) / 6.0, 1.0 - (cellP.y + 1.0 - gu.y) / 6.0)).a;
          body = mix(body, uMonoInk, 0.5 * ga * gw);
        }
      }
      // (fixer) small discs without a landed logo (pre-fill or no URL): heat x 0.9 floor, so a 3-6 px dust top is a solid lit
      // dot, not a dark #123020 bead
      if (vF.x < -0.5) body = max(body, hc * 0.9 * (1.0 - smoothstep(6.0, 9.0, rc)));
      body *= vGal.x * (1.0 + 0.35 * vF.w);
      if (vGal.z < 5.0) body += ${f3(GSWEEP.add)} * exp(-pow((p.x - vGal.z) / ${f3(GSWEEP.band)}, 2.0)) * inside(d, R);
      col = mix(col, body, tB); alpha = mix(alpha, 1.0, tB);
    }
#else
    if (tB > 0.0) {
      vec2 p = vP / R; vec3 n = vec3(p, sqrt(max(0.0, 1.0 - dot(p, p))));
      float ndl = dot(n, LIGHT);
      // matte sphere: a soft top light and a gentle limb, no specular
      float shade = 0.80 + 0.26 * ndl, limb = mix(1.0, 0.78, pow(1.0 - n.z, 3.0));
      vec3 body = mix(vBodyF, vBodyS * shade * limb, tS);
      if (tL > 0.0) {                                                              // (e) logo chip
        float rl = R - 1.75 * dpr;
        vec3 lc = logoTex(vF.x, vP / max(rl, 1.0), rl) * (0.90 + 0.10 * ndl);
        float sat = mix(max(vK.z, 0.85 * vTop), 1.0, vF.w), val = mix(max(vK.w, 0.94 * vTop), 1.0, vF.w);
        lc = mix(vec3(dot(lc, vec3(0.2126, 0.7152, 0.0722))), lc, sat) * val;
        lc = min(lc, vec3(0.80));                                                   // white logos never punch a hole in the plate
        body = mix(body, mix(uSep, lc, inside(d, rl)), tL);                        // 0.75 px separation ring in uSep
      }
      // monogram for a big coin with no logo cell: the first letter, mono, muted, ~0.9 r tall (fades in 13 -> 15 px)
      if (vF.x < -1.5) {
        float gq = -vF.x - 2.0, gw = smoothstep(13.0, 15.0, rc) * tS;
        if (gw > 0.0) {
          vec2 gu = vP / (1.65 * R) + 0.5;           // cell = 1.65 r: the letter is ~0.6 r tall
          if (gu.x > 0.0 && gu.x < 1.0 && gu.y > 0.0 && gu.y < 1.0) {
            vec2 cellP = vec2(mod(gq, 6.0), floor(gq / 6.0));
            float ga = texture2D(uGlyphs, vec2((cellP.x + gu.x) / 6.0, 1.0 - (cellP.y + 1.0 - gu.y) / 6.0)).a;
            body = mix(body, uMonoInk, 0.36 * ga * gw);
          }
        }
      }
      body = min(body, CAP);
      body *= 1.0 - 0.45 * inside(R - 1.5 * dpr, d) * (1.0 - tL);                  // 0.5 px inner separator rgba(0,0,0,.45)
      float cR = max(vG.x, vG.y * R);
      // live core dot; only its 1.25 px pin keeps the HDR boost, so bloom stays a pin-point spark, never a halo
      vec3 core = mix(min(vCore.rgb, CAP), vCore.rgb, inside(d, 1.25 * dpr));
      body = mix(body, core, inside(d, cR) * vCore.w * tS * (1.0 - tL));
      // 1 px heat rim inside the edge. From 2k0 it doubles as the 24 h gauge: the arc (12 o'clock, clockwise, log-scaled
      // trades) is the rim at full strength and 1.5 px; the rest of the ring is a dimmed track. Same hue as the rim, so
      // lime still appears only on live coins.
      float rimA = vRim.a, rimW = dpr * (1.0 + 0.75 * vFam);   // (round 2) a family flash widens the rim to 1.75 px
      if (vG.w > 0.0) {
        float ang = atan(vP.x, vP.y); if (ang < 0.0) ang += TAU;
        float end = vG.z * TAU;
        float inA = vG.z > 0.997 ? 1.0 : clamp((end - ang) * R / dpr + 0.5, 0.0, 1.0) * clamp(ang * R / dpr + 0.5, 0.0, 1.0);
        rimA *= mix(1.0, mix(0.55, 1.0, inA), vG.w);
        rimW = max(rimW, mix(dpr, mix(dpr, 1.5 * dpr, inA), vG.w));
      }
      body = mix(body, min(rim, CAP), rimA * inside(R - rimW, d));
      col = mix(col, body, tB); alpha = mix(alpha, 1.0, tB);
    }
#endif
    over(acc, col, alpha * disc);
  }
#ifdef GALAXY
  // (galaxy) the 24 h rim: a full annulus outside the disc, 1.3 px off the edge, (0.5 + 0.7 level) px thick, heat x 1.15
  if (tB > 0.0) {
    float r0 = R + 1.3 * dpr, r1 = r0 + vGal.y;
    float ann = inside(d, r1) * (1.0 - inside(d, r0)) * smoothstep(6.0, 12.0, rc);   // (fixer) no annulus on 3-6 px dust tops
    acc.rgb += rim * 1.15 * (0.95 * tB * ann);   // (fixer) additive: a dark (cold) 24 h ring no longer cuts the vein at the rim (G3)
  }
  // (galaxy) birth ripple: a ring 1.0 R -> 3.5 R over 1.2 s, 0.25 R wide, alpha 0.6 -> 0, additive
  if (vGal.w >= 0.0) {
    float Rf = vGal2.x, rr = mix(${f3(GBIRTH.r0)}, ${f3(GBIRTH.r1)}, vGal.w) * Rf, hw = 0.5 * ${f3(GBIRTH.w)} * Rf;
    float band = stroke(abs(d - rr), max(hw, 0.6 * dpr));
    acc.rgb += uBirthCol * (${f3(GBIRTH.a0)} * (1.0 - vGal.w) * band);
  }
  // (visibility lane) focus: a pulsing lime ring (rim + 4 -> + 8 px, radius x (1 + 0.15 sin(2 pi 1.6 t)), HDR x 1.9) and a
  // soft halo outside the rim; every other coin's colour x (1 - 0.4 uFocusDim)
  if (vFoc.x > 0.0) {
    // (fixer 2026-10-21) the pulse breathes in px (+-1.5 px), not x R: on an 80 px coin x(1 + 0.15 sin) threw the ring 12 px
    // out of the [r + 2, r + 14] band and over the view; LDR lime (no bloom wash), a tight halo that ends by r + 16 px
    float pul = 1.5 * sin(TAU * 1.6 * uAnimT);
    float r0 = R + (4.0 + pul) * dpr, r1 = R + (9.0 + pul) * dpr;
    float ring = inside(d, r1) * (1.0 - inside(d, r0));
    float hal = d > R ? exp(-pow((d - R) / (6.0 * dpr), 2.0)) * 0.12 : 0.0;
    hal *= 1.0 - smoothstep(R + 12.0 * dpr, R + 16.0 * dpr, d);
    acc.rgb += uFocusCol * hal * vFoc.x;
    over(acc, uFocusCol, ring * vFoc.x);
  }
  acc.rgb *= vFoc.y;
  gl_FragColor = acc * vF.z;
  if (max(gl_FragColor.a, max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b))) < 0.003) discard;
#else
  gl_FragColor = acc * vF.z;
  if (gl_FragColor.a < 0.003) discard;
#endif
}`;
  const C = (h) => new THREE.Color(h);
  // tints are mixed in sRGB (as the legend swatches in CSS are), then handed to the shader in linear
  const mixS = (a, b, t) => { const ch = (h, s) => ((h >> s) & 255) / 255; const m = (s) => ch(a, s) + (ch(b, s) - ch(a, s)) * t; return new THREE.Color().setRGB(m(16), m(8), m(0), THREE.SRGBColorSpace); };
  const bMat = new THREE.ShaderMaterial({
    uniforms: {
      ...U,
      uAtlasHi: { value: HIa.rt.texture }, uAtlasLo: { value: LOa.rt.texture },
      uAtlHi: { value: new THREE.Vector4(HI_CELL, HI_COLS, HI_SZ, Math.log2(HI_CELL) - 3) }, uAtlLo: { value: new THREE.Vector4(LO_CELL, LO_COLS, LO_SZ, Math.log2(LO_CELL) - 3) },
      uPrefill: { value: C(PREFILL) }, uFocusCol: { value: C(0xb6ff5c) },
      uRim: { value: T.rim.map(C) }, uRimA: { value: TOK.rimA.slice() }, uFlatA: { value: (G ? TOK.flatA : FLAT_DOT_F).slice() }, uBodyS: { value: T.rim.map((h, c) => mixS(TOK.body, h, G ? (c === 0 ? 0 : TOK.tint[c]) : BODY_TINT_F[c])) }, uBodyF: { value: T.rim.map((h, c) => mixS(TOK.body, h, G ? (c === 0 ? 0 : 0.16) : BODY_TINT_F[c])) },
      uFlatC: { value: T.rim.map((h, c) => mixS(T.bg, h, (G ? FLAT : FLAT_F)[c])) }, uGround: { value: C(T.bg) },
      // (galaxy) HDR boost per heat class, the animation clock / opened-ness / flow switch (state.js owns them in S.U; the
      // locals below are fallbacks that keep this file compiling before they land: ...U above wins when present)
      uHeatK: { value: GHEATK.slice() }, uBirthCol: { value: C(GBIRTH.col).multiplyScalar(GBIRTH.k) },
      ...(U.uAnimT ? {} : { uAnimT: { value: 0 } }), ...(U.uGalT ? {} : { uGalT: { value: 0 } }), ...(U.uFlow ? {} : { uFlow: { value: 1 } }), ...(U.uLook ? {} : { uLook: { value: G ? 1 : 0 } }),
      uGlyphs: { value: gTex }, uMonoInk: { value: C(0x7e8783) },
      uLogoSat: { value: TOK.logoSat.slice() }, uLogoVal: { value: TOK.logoVal.slice() }, uCore: { value: TOK.core.map(C) },
      uBody: { value: C(TOK.body) }, uSep: { value: C(TOK.sep) }, uArcCol: { value: C(TOK.arc) }, uHoverCol: { value: C(TOK.hover) },
      uArcA: { value: TOK.arcA }, uTrackA: { value: TOK.arcTrackA }, uSelected: { value: -1 },
      uBreath: { value: 0 }, uPulseCol: { value: C(TOK.pulse) }, uGlowCol: { value: C(TOK.ink).multiplyScalar(0.8) },
      uHlT0: { value: -1e3 },
    },
    vertexShader: BUBBLE_VS, fragmentShader: BUBBLE_FS,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    defines: G ? { GALAXY: 1 } : {},
  });
  bubbles.material = bMat;
  bubbles.instanceMatrix.needsUpdate = true; bubbles.frustumCulled = false; bubbles.renderOrder = 10;
  scene.add(bubbles);

  // ======================= (galaxy) coronas: one additive InstancedMesh, two instances per planet =======================
  // core: r = 5 coreR (screen floor coreMinPx(share, maxShare) x 2.6 dpr), family heat x heatK, alpha 0.30 fading in by 1.6 k0;
  // hull: r = 1.1 Rc, alpha 0.045 live / 0.025 fading in by 3 k0. FS g = exp(-4.2 d^2) (1 - smoothstep(0.85, 1, d)). The core
  // breathes like its body (uAnimT), flashCorona(i) doubles it for 600 ms. Both follow the family top (drags carry them).
  let glows = null, flashCorona = () => false, glowTick = () => false;
  if (G && planets.length) {
    const NP = planets.length, NG = NP * 2;
    const gGeo = new THREE.InstancedBufferGeometry(); gGeo.index = quad.index; gGeo.setAttribute("position", quad.getAttribute("position"));
    const aGC = new Float32Array(NG * 2), aGP = new Float32Array(NG * 4), aGH = new Float32Array(NG * 2);
    const offX = new Float32Array(NP), offY = new Float32Array(NP), famCls = new Uint8Array(NP);
    const coreMinPx = typeof T.coreMinPx === "function" ? T.coreMinPx : GAL.coreMinPx;
    const famClass = (f) => { let c = cls[f.top]; for (const m of f.members) { const v = cls[m]; if (v < c) { c = v; if (!c) break; } } return c; };
    planets.forEach((f, q) => {
      offX[q] = f.cx - X[f.top]; offY[q] = f.cy - Y[f.top]; famCls[q] = famClass(f);
      const coreR = f.coreR || R[f.top] || 1, Rc = f.Rc || coreR;
      aGC.set([X[f.top], Y[f.top]], q * 4); aGC.set([f.cx, f.cy], q * 4 + 2);
      aGP.set([(T.coreRk || GAL.coreRk) * coreR, 0, f.id, coreMinPx(f.share, maxShare)], q * 8);
      aGP.set([(T.hullRk || GAL.hullRk) * Rc, 1, f.id, 0], q * 8 + 4);
      aGH.set([famCls[q], -1e3, famCls[q], -1e3], q * 4);
    });
    const atGC = new THREE.InstancedBufferAttribute(aGC, 2), atGP = new THREE.InstancedBufferAttribute(aGP, 4), atGH = new THREE.InstancedBufferAttribute(aGH, 2);
    atGC.setUsage(THREE.DynamicDrawUsage); atGH.setUsage(THREE.DynamicDrawUsage);
    gGeo.setAttribute("aGC", atGC); gGeo.setAttribute("aGP", atGP); gGeo.setAttribute("aGH", atGH);
    const hullA = T.hullA || GAL.hullA;
    const gMat = new THREE.ShaderMaterial({
      uniforms: { ...U, uRim: bMat.uniforms.uRim, uHeatK: bMat.uniforms.uHeatK, uBreath: bMat.uniforms.uBreath,
        ...(U.uAnimT ? {} : { uAnimT: bMat.uniforms.uAnimT }) },
      vertexShader: /* glsl */`
uniform float uPx, uDpr, uTime, uAnimT, uK0, uHoverFam, uDimMix, uFadeP, uFocusFam, uFocusMix, uBreath;
uniform vec3 uRim[4]; uniform float uHeatK[4];
attribute vec2 aGC; attribute vec4 aGP; attribute vec2 aGH;
varying vec2 vP; varying vec3 vCol; varying float vA;
const float TAU_V = 6.28318530718;
void main(){
  int ci = int(aGH.x + 0.5);
  float k = uPx / uDpr, rpx = aGP.x * uPx, a;
  if (aGP.y < 0.5) {
    rpx = max(rpx, aGP.w * 2.6 * uDpr);
    a = ${f3(T.coreA || GAL.coreA)} * (1.0 - 0.35 * smoothstep(0.5 * uK0, 1.6 * uK0, k));   // (fixer) the opened root keeps its corona (was -70 %)
    float ph = fract(sin(aGP.z * 12.9898 + 3.0 * 78.233) * 43758.5453) * TAU_V;
    float liveW = ci == 0 ? 1.0 : 0.0;
    float bm = mix(${f3(1 - GBR.restAmp)} + ${f3(GBR.restAmp)} * sin(${f3(GBR.restHz)} * uAnimT + ph), ${f3(1 - GBR.liveAmp)} + ${f3(GBR.liveAmp)} * sin(${f3(GBR.liveHz)} * uAnimT + ph), liveW);
    a *= liveW > 0.5 ? mix(1.0, 0.75 + 0.35 * sin(1.9 * uAnimT + ph), uBreath) : mix(1.0, bm, uBreath);   // (visibility) monolith M:375-390
    float ft = uTime - aGH.y; if (ft >= 0.0 && ft < 0.6) a *= 2.0 - ft / 0.6;
  } else {
    a = (ci == 0 ? ${f3(hullA[0])} : ${f3(hullA[1])}) * (1.0 - 0.6 * smoothstep(0.8 * uK0, 3.0 * uK0, k));
  }
  a *= uFadeP;
  if (uHoverFam > -0.5 && abs(aGP.z - uHoverFam) > 0.5) a *= mix(1.0, ${f3(TOK.dim)}, uDimMix);
  if (uFocusFam > -0.5 && abs(aGP.z - uFocusFam) > 0.5 && abs(aGP.z - uHoverFam) > 0.5) a *= mix(1.0, ${f3(G ? 1.0 : FOCUS_DIM)}, uFocusMix);
  vCol = uRim[ci]; vA = a; vP = position.xy;   // (visibility) monolith M:377: lin(heatHex) x alpha, no HDR heatK (x1.9 blew $Kimchi out to white)
  gl_Position = projectionMatrix * viewMatrix * vec4(aGC + position.xy * rpx / uPx, 0.5, 1.0);
  if (a < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`,
      fragmentShader: /* glsl */`
varying vec2 vP; varying vec3 vCol; varying float vA;
void main(){
  float d = length(vP);
  float g = exp(-4.2 * d * d) * (1.0 - smoothstep(0.85, 1.0, d));
  vec3 c = vCol * (vA * g);
  if (max(c.r, max(c.g, c.b)) < 0.002) discard;
  gl_FragColor = vec4(c, 0.0);
}`,
      // (visibility lane) the real bug: AdditiveBlending without premultipliedAlpha is blendFunc(SRC_ALPHA, ONE), so a fragment
      // with alpha 0 added NOTHING. One/One adds the (already alpha-weighted) colour; the destination alpha is kept.
      transparent: true, depthTest: false, depthWrite: false, defines: { GALAXY: 1 },
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    glows = new THREE.InstancedMesh(gGeo, gMat, NG); glows.count = NG; glows.frustumCulled = false; glows.renderOrder = 1;
    glows.instanceMatrix.needsUpdate = true; scene.add(glows);
    let glowHeatAt = -1e9;
    // per frame: follow the family tops (a drag moves S.X/S.Y), refresh the family heat class once a second
    glowTick = (now) => {
      let any = false;
      for (let q = 0; q < NP; q++) {
        const f = planets[q], tx = X[f.top], ty = Y[f.top];
        if (tx !== tx || ty !== ty) continue;
        if (aGC[q * 4] !== tx || aGC[q * 4 + 1] !== ty) { aGC[q * 4] = tx; aGC[q * 4 + 1] = ty; aGC[q * 4 + 2] = tx + offX[q]; aGC[q * 4 + 3] = ty + offY[q]; any = true; }
      }
      if (any) atGC.needsUpdate = true;
      if (now - glowHeatAt > 1000) {
        glowHeatAt = now;
        let ch = false;
        for (let q = 0; q < NP; q++) { const c = famClass(planets[q]); if (c !== famCls[q]) { famCls[q] = c; aGH[q * 4] = c; aGH[q * 4 + 2] = c; ch = true; } }
        if (ch) { atGH.needsUpdate = true; any = true; }
      }
      return any;
    };
    const qOfFam = new Int32Array(fams.length).fill(-1); planets.forEach((f, q) => { qOfFam[f.id] = q; });
    flashCorona = (i, tSec) => {
      if (!(i >= 0 && i < famOf.length)) return false;
      const q = qOfFam[famOf[i]]; if (q < 0) return false;
      const t = tSec == null ? U.uTime.value : tSec;
      aGH[q * 4 + 1] = t; atGH.needsUpdate = true; S.invalidate();
      glowFlashUntil = Math.max(glowFlashUntil, t + 0.65);
      return true;
    };
    S.life.onDispose(() => { scene.remove(glows); if (!S.contextLost) { gGeo.dispose(); gMat.dispose(); } });
  }
  let glowFlashUntil = 0;

  // ======================= runtime API (spec section 6) =======================
  let animUntil = 0;
  const nowT = (t) => (t == null ? U.uTime.value : t);
  const RANGE_CAP = 512;   // beyond this many pending ranges, one full upload is cheaper
  // (integrator, round 2) once the ranges are cleared (= full upload) they must STAY cleared until the upload happened:
  // before, the next touch() added a range again, so a frame that moved > 512 coins (a $PUMP drag moves 1,481) uploaded
  // only the last few hundred and the rest were drawn at stale positions. three calls onUpload after every upload.
  const fullAttrs = new Set();
  function touch(attr, start, count) {
    if (!fullAttrs.has(attr)) {
      if (attr.updateRanges.length < RANGE_CAP) attr.addUpdateRange(start, count);
      else { attr.clearUpdateRanges(); fullAttrs.add(attr); if (!attr.__fullHook) { attr.__fullHook = true; attr.onUpload(() => fullAttrs.delete(attr)); } }
    }
    attr.needsUpdate = true;
  }
  function setCoinHeat(i, c, boost, tSec) {
    if (!(i >= 0 && i < CAP) || invIdx[i] < 0) return;
    if (G && i < N && famTop(i)) { const f = fams[famOf[i]]; cls[i] = c; c = Math.min(c, famMinCls(f)); }   // (fixer) galaxy root = family class (M:200)
    const o = invIdx[i] * 4, t = nowT(tSec);
    if (aHeat[o] !== c) { aHeat[o + 1] = aHeat[o]; aHeat[o + 2] = t; aHeat[o] = c; animUntil = Math.max(animUntil, t + 0.65); }
    aHeat[o + 3] = boost == null ? aHeat[o + 3] : boost;
    cls[i] = c;
    touch(atHeat, o, 4); S.invalidate();
    if (G && c === 0 && i < N) { const f = fams[famOf[i]]; if (f.top !== i && invIdx[f.top] >= 0 && aHeat[invIdx[f.top] * 4] !== 0) setCoinHeat(f.top, 0, null, tSec); }   // (fixer) a live child lights its root
  }
  function flashRim(i, tSec) {
    if (!(i >= 0 && i < CAP) || invIdx[i] < 0) return;
    const k = invIdx[i], t = nowT(tSec);
    aFlash[k * 3] = t; animUntil = Math.max(animUntil, t + 0.35);
    touch(atFlash, k * 3, 1); S.invalidate();
  }
  // (round 2, amendment B) one family flash on the family's top (the planet chip at the overview)
  function flashFamily(fam, tSec) {
    const f = fam != null && typeof fam === "object" ? fam : fams[fam];
    if (!f || !(f.top >= 0) || invIdx[f.top] < 0) return false;
    const k = invIdx[f.top], t = nowT(tSec);
    aFlash[k * 3 + 1] = t; animUntil = Math.max(animUntil, t + FAMFLASH_S + 0.05);
    touch(atFlash, k * 3 + 1, 1); S.invalidate();
    return true;
  }
  // (round 2) links lane hook: the coin's live core pin brightens x1.25, 300 ms ease-out (no core drawn -> no change)
  function flashCore(i, tSec) {
    if (!(i >= 0 && i < CAP) || invIdx[i] < 0) return false;
    const k = invIdx[i], t = nowT(tSec);
    aFlash[k * 3 + 2] = t; animUntil = Math.max(animUntil, t + FAMFLASH_S + 0.05);
    touch(atFlash, k * 3 + 2, 1); S.invalidate();
    return true;
  }
  // (round 2, amendment C) birth: 'scale' (default) 0 -> 1 in 500 ms ease-out, or 'fade' (parent unknown)
  function birth(i, tSec, mode) {
    if (!(i >= 0 && i < CAP) || invIdx[i] < 0) return false;
    const k = invIdx[i], t = nowT(tSec), rm = !!(S.motion && S.motion.reduced);
    aBirth[k * 3] = rm ? -1e3 : t; aBirth[k * 3 + 1] = mode === "fade" ? 1 : 0;
    if (!rm) animUntil = Math.max(animUntil, t + BIRTH_S + 0.05);
    touch(atBirth, k * 3, 2); S.invalidate();
    return true;
  }
  // (round 2, amendment E) coins that move: re-read S.X/S.Y. The frame hook also finds them by itself (scanXY).
  function putXY(i) {
    const k = invIdx[i], x = X[i], y = Y[i];
    if (k < 0 || x !== x || y !== y) return false;   // NaN never reaches the GPU
    mX[i] = x; mY[i] = y; aXY[k * 2] = x; aXY[k * 2 + 1] = y;
    touch(atXY, k * 2, 2); return true;
  }
  function syncXY(list) {
    let n = 0;
    if (list == null) { for (let k = 0; k < count; k++) { const i = perm[k]; if (i < X.length && putXY(i)) n++; } }
    else for (const i of list) if (i >= 0 && i < X.length && putXY(i)) n++;
    if (n) S.invalidate();
    return n;
  }
  let lastMoved = 0;
  function scanXY() {
    let n = 0;
    const nX = Math.min(X.length, Y.length);
    for (let k = 0; k < count; k++) {
      const i = perm[k];
      if (i >= nX) continue;
      if (X[i] === mX[i] && Y[i] === mY[i]) continue;
      if (putXY(i)) n++;
    }
    lastMoved = n;
    if (n) S.invalidate();
    return n;
  }
  // (integrator, round 2) place one instance at (x, y) world. For coins S.X/S.Y has no slot for (newborns at index >= N):
  // motion moves a newborn with its parent's drag offset. Coins below S.X.length follow S.X/S.Y (scanXY) instead.
  function moveCoin(i, x, y) {
    if (!(i >= 0 && i < CAP) || invIdx[i] < 0 || !(Number.isFinite(x) && Number.isFinite(y))) return false;
    const k = invIdx[i];
    if (aXY[k * 2] === Math.fround(x) && aXY[k * 2 + 1] === Math.fround(y)) return true;
    aXY[k * 2] = x; aXY[k * 2 + 1] = y; mX[i] = x; mY[i] = y;
    touch(atXY, k * 2, 2); S.invalidate();
    return true;
  }
  // (round 2) a coin that was not in the map at build time. Data from S when the arrays reach index i, else from opts.
  function addCoin(i, o = {}) {
    if (!(i >= 0 && i < CAP)) return -1;
    if (invIdx[i] >= 0) return invIdx[i];
    if (count >= CAP) return -1;
    const get = (arr, d) => (arr && i < arr.length && arr[i] != null && !Number.isNaN(arr[i]) ? arr[i] : d);
    const famId = get(famOf, o.fam ?? -1), f = famId >= 0 ? fams[famId] : null;
    const x = o.x ?? get(X, 0), y = o.y ?? get(Y, 0), r = o.r ?? get(R, 0.55), ag = o.age ?? get(age, Infinity), nn = o.n24 ?? get(n24, 0);
    const k = count++, c = heatClass(ag), top = !!(f && f.top === i);
    cls[i] = c; perm[k] = i; invIdx[i] = k;
    aHeat.set([c, c, -1e3, coreBoost(ag)], k * 4);
    const nt = get(notable, 0) ? 1 : 0;
    aA.set([nt ? 1.5 : 0, Math.min(1, Math.log10(1 + Math.max(0, nn)) / TOK.arcLogDen), -1, nt], k * 4);   // (round 2 final) no monogram
    aB.set([f && f.planet ? 0 : 1, i, f ? f.id : -1, top ? 1 : 0], k * 4);
    aFlash[k * 3] = aFlash[k * 3 + 1] = aFlash[k * 3 + 2] = -1e3; aBirth[k * 3] = -1e3; aBirth[k * 3 + 1] = 0; aBirth[k * 3 + 2] = 1; aIn[k] = 0;
    { const hv = typeof S.hlBit === "function" ? (S.hlBit(i) ? 1 : 0) : 1; aHl[k * 2] = hv; aHl[k * 2 + 1] = hv; touch(atHl, k * 2, 2); }   // (map3 port)
    aXY[k * 2] = mX[i] = x; aXY[k * 2 + 1] = mY[i] = y;
    m4.makeScale(r, r, 1); m4.setPosition(x, y, f && f.planet ? 2 : 1); bubbles.setMatrixAt(k, m4); drawR[i] = r;
    touch(bubbles.instanceMatrix, k * 16, 16);
    touch(atHeat, k * 4, 4); touch(atA, k * 4, 4); touch(atB, k * 4, 4); touch(atFlash, k * 3, 3); touch(atBirth, k * 3, 3); touch(atXY, k * 2, 2); touch(atIn, k, 1);
    bubbles.count = count; S.invalidate();
    return k;
  }
  // (round 2) drawn world radius of instance q at zoom k: the matrix scale (layout's R, or addCoin's r) times the seed-head
  // factor, which engages over 1.3k0 -> 2k0 exactly as in the vertex shader
  const scaleAt = (q, k) => { const s = aBirth[q * 3 + 2], k0 = U.uK0.value; return bubbles.instanceMatrix.array[q * 16] * (s === 1 ? 1 : 1 + (s - 1) * smoothJ(STIP_K0[0] * k0, STIP_K0[1] * k0, k)); };
  // drawn geometry in CSS px at the CURRENT zoom, for label obstacles and hit radii (labels / motion may adopt them):
  //   screenR(i)  the disc (minPx, uMinScale and the 1-device-px floor included)
  //   outerR(i)   the outermost drawn thing: the knock-out halo (r + 1.5) from 3 px
  const screenR = (i) => {
    if (!(invIdx[i] >= 0)) return 0;
    const q = invIdx[i] * 4, sc = scaleAt(invIdx[i], S.cam.k);   // the drawn world radius at this zoom
    let r = Math.max(sc * S.cam.k, aA[q] * U.uMinScale.value, 0.5);
    if (!aB[q + 3] && !aB[q]) { const k0 = U.uK0.value; r += (Math.min(r, aA[q + 3] ? SPN : SP) - r) * (1 - smoothJ(STIP_K0[0] * k0, STIP_K0[1] * k0, S.cam.k)); }
    if (!G && !aB[q + 3]) r = Math.max(r, 1 / (S.DPR || 1));   // (flat fix) the 1-device-px radius floor
    if (G && aB[q]) r = aB[q + 3] ? Math.max(r, Math.max(aA[q] * U.uMinScale.value, 2.5)) : Math.max(r, 1.0);   // (visibility) the VS dust floors
    return r;
  };
  // (final polish) nothing is drawn outside the disc any more but the knock-out halo (the gauge sits on the rim)
  // (round 2) a breathing live coin reaches r x 1.03 at its peak
  const outerR = (i) => { let r = screenR(i); if (cls[i] === 0 && bMat.uniforms.uBreath.value > 0) r *= 1 + BREATH_A; return r >= 3 ? r + HALO_PX : r; };
  // (final polish) labels lane: the coins whose name is printed inside their disc right now (core + monogram hidden)
  let insideNow = new Set();
  function setInside(list) {
    const next = new Set(list); let any = false;
    for (const i of insideNow) if (!next.has(i)) { const k = invIdx[i]; aIn[k] = 0; touch(atIn, k, 1); any = true; }
    for (const i of next) if (!insideNow.has(i)) { const k = invIdx[i]; aIn[k] = 1; touch(atIn, k, 1); any = true; }
    insideNow = next; if (any) S.invalidate();
  }
  function selectCoin(i) { bMat.uniforms.uSelected.value = i == null || i < 0 ? -1 : i; selCoin = i == null || i < 0 ? -1 : i; S.invalidate(); }
  // (map3 port) highlight mask: bitOf(coin) -> 1 match / 0 dimmed, for every instance in use (births included). One
  // crossfade for all of them (160 ms): each starts from what it shows now.
  const uHlT0 = bMat.uniforms.uHlT0;
  function setHl(bitOf, tSec) {
    const t = nowT(tSec), e = smoothJ(uHlT0.value, uHlT0.value + 0.16, t);
    for (let k = 0; k < count; k++) {
      const o = k * 2, i = perm[k], cur = bitOf(i) ? 1 : 0;
      aHl[o] = aHl[o] + (aHl[o + 1] - aHl[o]) * e; aHl[o + 1] = cur;
    }
    uHlT0.value = t; animUntil = Math.max(animUntil, t + 0.2);
    atHl.clearUpdateRanges(); fullAttrs.delete(atHl); atHl.needsUpdate = true; S.invalidate();
  }
  const hlOf = (i) => { const k = invIdx[i]; return k >= 0 ? aHl[k * 2 + 1] : 1; };
  const logoPx = (i) => (i >= 0 && i < CAP ? (hiC[i] >= 0 && hiHas[i] ? hiHas[i] : loC[i] >= 0 && loHas[i] ? loHas[i] : 0) : 0);

  // ======================= (visibility lane) atlas cell assignment + coverage debug =======================
  // Every family top owns a cell from the build (pinned). Children drawn >= 10 px on screen with a logo URL take LO cells,
  // biggest first; a full atlas evicts the least recently wanted child cell. Re-evaluated at most every 250 ms while the
  // camera moves, and once more when it settles. HI_SEL / HI_FOC follow selectCoin and S.U.uFocusCoin.
  const onScreenQ = (q, r, W, H, k) => {
    const sx = (aXY[q * 2] - S.cam.x) * k + W / 2, sy = H / 2 - (aXY[q * 2 + 1] - S.cam.y) * k;
    return sx >= -r && sx <= W + r && sy >= -r && sy <= H + r;
  };
  let assignAt = -1e9, needAssign = true, selCoin = -1, lastSel = -1, lastFoc = -1;
  const aCam = { x: NaN, y: NaN, k: NaN };
  const asg = { passes: 0, lastMs: 0, assigned: 0, evicted: 0 };
  function reserveHi(i, cell) {
    const o = hiOwn[cell];
    if (o === i) return false;
    if (o >= 0) { hiOwn[cell] = -1; hiC[o] = -1; hiHas[o] = 0; if (loC[o] < 0) drawnImg[o] = null; setCode(o); }
    if (!(i >= 0 && i < CAP) || invIdx[i] < 0 || (hiC[i] >= 0 && hiC[i] < HI_PLANETS)) return o >= 0;
    takeHi(i, cell); drawnImg[i] = null; setCode(i); wantLogo(i);
    return true;
  }
  function assignCells(now) {
    let any = false;
    const fc = U.uFocusCoin.value | 0;
    if (selCoin !== lastSel) { lastSel = selCoin; any = reserveHi(selCoin, HI_SEL) || any; }
    if (fc !== lastFoc) { lastFoc = fc; any = reserveHi(fc, HI_FOC) || any; }
    if (now - assignAt < 250) return any;
    const moved = S.cam.x !== aCam.x || S.cam.y !== aCam.y || S.cam.k !== aCam.k;
    if (moved) { aCam.x = S.cam.x; aCam.y = S.cam.y; aCam.k = S.cam.k; needAssign = true; assignAt = now; return any; }   // settle first
    if (!needAssign) return any;
    needAssign = false; assignAt = now;
    const t0 = performance.now(), W = S.W(), H = S.H(), k = S.cam.k, nI = img ? img.length : 0;
    // (bubbles lane, look fix 2026-10-22) flat children take a cell from LOGO_MIN_PX (4.5 px, the tops' threshold); galaxy 10 px
    const KID_PX = G ? 10 : LOGO_MIN_PX;
    const cand = [], cr = [];
    for (let q = 0; q < count; q++) {
      const i = perm[q];
      if (i >= nI || isTop[i] || !img[i] || failedLogo.has(i)) continue;
      if (drawR[i] * k * 1.05 < KID_PX && aA[q * 4] < KID_PX) continue;   // cheap bound before the exact mirror
      const r = screenR(i);
      if (r < KID_PX || !onScreenQ(q, r, W, H, k)) continue;
      cand.push(i); cr.push(r);
    }
    const ord = cand.map((_, j) => j).sort((a, b) => cr[b] - cr[a]);
    const want = [];
    // pass 1: every candidate that already owns a cell is touched FIRST, so the LRU eviction list below never holds an
    // on-screen cell (before, the list was built lazily at the first miss, before smaller on-screen owners were touched)
    for (const j of ord) { const i = cand[j]; if (loC[i] >= 0) { loUse[loC[i]] = now; if (!loHas[i]) want.push(j); } }
    // pass 2: assign, biggest first, at most ASSIGN_MAX new cells per pass (the next pass, 250 ms on, continues); a full
    // atlas evicts the least recently wanted unpinned (child) cell = an off-screen child; pinned tops never move
    let ev = null, evAt = 0, assigned = 0;
    for (const j of ord) {
      const i = cand[j];
      if (loC[i] >= 0) continue;
      if (assigned >= ASSIGN_MAX) { needAssign = true; break; }
      let c = takeLo(i, now, false);
      if (c < 0) {
        if (!ev) { ev = []; for (let q = 0; q < LO_N; q++) if (!loPin[q] && loOwn[q] >= 0 && loUse[q] < now) ev.push(q); ev.sort((a, b) => loUse[a] - loUse[b]); }
        if (evAt >= ev.length) break;                              // every cell is in use on this screen: no thrash
        dropLo(ev[evAt++]); asg.evicted++;
        c = takeLo(i, now, false);
        if (c < 0) break;
      }
      drawnImg[i] = null; setCode(i); want.push(j); asg.assigned++; assigned++; any = true;
    }
    want.sort((a, b) => cr[b] - cr[a]);   // biggest first (the loader serves the newest want first: the calls below run in reverse)
    for (let q = 0; q < want.length; q++) want[q] = cand[want[q]];
    // (flat fix) request order (the loader serves the newest want first, so the calls run in REVERSE): P3 the HI 256 upgrades
    // of tops drawn >= HI_UP_PX, then P2 the children >= KID_PX (biggest last), then P1 the on-screen tops still without a
    // logo (smallest share first, biggest last). Off-screen tops (P4) keep their older build-time stamps.
    // (look fix) P1 asks only for tops that are DRAWN: planets always, a dust-family top once the field has handed off
    // (S.dustExpand > 0) and it is drawn >= LOGO_MIN_PX; at the overview that is ~60 planets, not every family
    const p3 = [], p1 = [];
    const dustOn = G || S.dustExpand > 0.02;
    if (!G) for (const f of fams) {
      const i = f.top; if (!(i >= 0) || i >= nI || !img[i] || failedLogo.has(i) || invIdx[i] < 0) continue;
      if (!f.planet && !dustOn) continue;
      const q = invIdx[i], r = screenR(i); if (r < LOGO_MIN_PX || !onScreenQ(q, r, W, H, k)) continue;
      if (hiC[i] >= 0 && r >= HI_UP_PX && !hiWant[i]) { hiWant[i] = 1; p3.push(i); }
      else if (!(hiHas[i] || loHas[i])) p1.push(i);
    }
    for (const i of p3) wantLogo(i);
    for (let q = want.length - 1; q >= 0; q--) wantLogo(want[q]);   // the loader serves the newest want first: biggest last
    p1.sort((a, b) => (fams[famOf[a]].share || 0) - (fams[famOf[b]].share || 0));
    for (const i of p1) wantLogo(i);
    asg.p1 = p1.length; asg.p2 = want.length; asg.p3 = p3.length;
    asg.passes++; asg.lastMs = +(performance.now() - t0).toFixed(3);
    return any;
  }
  // (visibility lane) QA: show/hide this file's meshes ("bubbles" | "coronas") to attribute pixels
  S.debugFns.visToggle = (name, on) => { const m = name === "coronas" ? glows : name === "bubbles" ? bubbles : null; if (!m) return null; m.visible = !!on; S.invalidate(); return m.visible; };
  S.debugFns.coverage = () => {
    const W = S.W(), H = S.H(), k = S.cam.k, hist = { lt1: 0, "1to3": 0, "3to6": 0, ge6: 0 };
    let tops = 0, onScreen = 0, minTopPx = Infinity;
    for (const f of fams) {
      const i = f.top; if (!(i >= 0) || invIdx[i] < 0) continue;
      const r = screenR(i); tops++;
      if (onScreenQ(invIdx[i], r, W, H, k)) onScreen++;
      if (r < minTopPx) minTopPx = r;
      hist[r < 1 ? "lt1" : r < 3 ? "1to3" : r < 6 ? "3to6" : "ge6"]++;
    }
    // (flat fix) on-screen = the coin's centre inside the fit rect (spec 2)
    const fr = S.fitRect ? S.fitRect() : { x0: 0, y0: 0, x1: W, y1: H };
    let inRect = 0, minOn = Infinity;
    for (const f of fams) {
      const i = f.top; if (!(i >= 0) || invIdx[i] < 0) continue;
      const p = scrOf(invIdx[i]); if (p.x < fr.x0 || p.x > fr.x1 || p.y < fr.y0 || p.y > fr.y1) continue;
      inRect++; const r = screenR(i); if (r < minOn) minOn = r;
    }
    return { tops, onScreen, hist, minTopPx: +minTopPx.toFixed(2), minTopPxOnScreen: +(Number.isFinite(minOn) ? minOn : 0).toFixed(2), inRect, allOnScreen: inRect === tops && onScreen === tops };
  };
  // (flat fix) debug probes. scrOf(q): instance q's centre in CSS px. probePx(): the bubble mesh ALONE through the composer
  // (bloom off, every other scene object hidden, cleared to the ground colour), read back once; maxAt(css x, y) = max channel
  // over the 3 x 3 device pixels at that point. Everything is restored and the view invalidated.
  const scrOf = (q) => { const k = S.cam.k; return { x: (aXY[q * 2] - S.cam.x) * k + S.W() / 2, y: S.H() / 2 - (aXY[q * 2 + 1] - S.cam.y) * k }; };
  // (look fix) withDust: keep the dust specks (dust.js, S.debug.obj.dustPts) in the probe too: in the flat look a small family's
  // top at the overview IS its speck, so topVis counts it there
  const probePx = (withDust = false) => {
    const gfx = S.gfx, rr = gfx && gfx.renderer, comp = gfx && gfx.composer, sc = gfx && gfx.scene;
    if (!rr || !comp || !sc || S.contextLost) return null;
    if (S.motion && typeof S.motion.applyCam === "function") S.motion.applyCam();
    const hidden = [];
    const keepDust = withDust && S.debug && S.debug.obj ? S.debug.obj.dustPts : null;
    sc.traverse((o) => { if (o !== sc && o !== bubbles && o !== keepDust && o.visible && (o.isMesh || o.isPoints || o.isLine)) { o.visible = false; hidden.push(o); } });
    const bl = gfx.bloom, blWas = bl ? bl.enabled : false, cc = new THREE.Color(); rr.getClearColor(cc); const ca = rr.getClearAlpha();
    const g = rr.getContext(), w = g.drawingBufferWidth, h = g.drawingBufferHeight, buf = new Uint8Array(w * h * 4);
    try {
      if (bl) bl.enabled = false; rr.setClearColor(new THREE.Color(T.bg), 1);
      comp.render(); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, buf);
    } finally { for (const o of hidden) o.visible = true; if (bl) bl.enabled = blWas; rr.setClearColor(cc, ca); S.invalidate(); }
    const dpr = w / Math.max(1, S.W());
    const maxAt = (x, y) => {
      const cx = Math.floor(x * dpr), cy = Math.floor(y * dpr); let m = -1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const px = cx + dx, py = cy + dy; if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const o = ((h - 1 - py) * w + px) * 4; m = Math.max(m, buf[o], buf[o + 1], buf[o + 2]);
      }
      return m;
    };
    return { maxAt, w, h, dpr };
  };
  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
  const inFit = (p, fr) => p.x >= fr.x0 && p.x <= fr.x1 && p.y >= fr.y0 && p.y <= fr.y1;
  // (look fix) topVis(minMax, withDust = true): bubbles + the dust specks (flat: a small family's top at the overview is its speck);
  // litDust / litDisc split the lit tops by which layer draws them now; withDust = false probes the bubble mesh alone as before
  S.debugFns.topVis = (minMax = 48, withDust = true) => {
    const P = probePx(withDust && !G); if (!P) return null;
    const fr = S.fitRect ? S.fitRect() : { x0: 0, y0: 0, x1: S.W(), y1: S.H() };
    const dustOn = S.dustExpand > 0.5;
    let tops = 0, onScreen = 0, lit = 0, litDust = 0, litDisc = 0, specks = 0; const mx = [], mxD = [];
    for (const f of fams) {
      const i = f.top; if (!(i >= 0) || invIdx[i] < 0) continue; tops++;
      const p = scrOf(invIdx[i]); if (!inFit(p, fr)) continue; onScreen++;
      const m = P.maxAt(p.x, p.y); mx.push(m);
      const speck = !G && !f.planet && !dustOn; if (speck) { specks++; mxD.push(m); }
      if (m >= minMax) { lit++; if (speck) litDust++; else litDisc++; }
    }
    mx.sort((a, b) => a - b); mxD.sort((a, b) => a - b);
    return { tops, onScreen, lit, litDust, litDisc, specks, share: onScreen ? +(lit / onScreen).toFixed(4) : 0, p10Max: pct(mx, 0.1), p50Max: pct(mx, 0.5), speckP10Max: pct(mxD, 0.1), speckP50Max: pct(mxD, 0.5), minMax, withDust: !!withDust && !G, look: G ? "galaxy" : "flat" };
  };
  const famAtCentre = () => { let best = -1, bs = Infinity; for (const f of fams) { if (!f || !(f.Rc > 0)) continue; const d = Math.hypot(f.cx - S.cam.x, f.cy - S.cam.y); if (d <= f.Rc + 1e-6 && d / f.Rc < bs) { bs = d / f.Rc; best = f.id; } } return best; };
  S.debugFns.kidVis = (key, minMax = 48) => {
    const byKey = key != null && S.famBy ? S.famBy(String(key).replace(/^\$+/, "")) : null;
    const fi = byKey ? byKey.id : U.uFocusFam.value >= 0 ? U.uFocusFam.value : famAtCentre();
    const f = fi >= 0 ? fams[fi] : null; if (!f) return { fam: fi, kids: 0 };
    const P = probePx(); if (!P) return null;
    const fr = S.fitRect ? S.fitRect() : { x0: 0, y0: 0, x1: S.W(), y1: S.H() }, dpr = S.DPR || 1;
    let kidsN = 0, inRect = 0, drawn1px = 0, visible = 0; const mx = [], byHeat = [0, 1, 2, 3].map(() => ({ n: 0, vis: 0 }));
    for (const i of f.members) {
      if (i === f.top || invIdx[i] < 0) continue; kidsN++;
      const p = scrOf(invIdx[i]); if (!inFit(p, fr)) continue; inRect++;
      if (screenR(i) * dpr >= 0.5) drawn1px++;
      const m = P.maxAt(p.x, p.y); mx.push(m); const v = m >= minMax; if (v) visible++;
      const b = byHeat[cls[i]] || byHeat[3]; b.n++; if (v) b.vis++;
    }
    mx.sort((a, b) => a - b);
    for (const b of byHeat) b.share = b.n ? +(b.vis / b.n).toFixed(4) : null;
    return { fam: f.id, sym: sym ? sym[f.top] : "", kids: kidsN, inRect, drawn1px, visible, share: inRect ? +(visible / inRect).toFixed(4) : 0, p10Max: pct(mx, 0.1), p50Max: pct(mx, 0.5), byHeat, k: S.cam.k, k0: U.uK0.value, look: G ? "galaxy" : "flat" };
  };
  S.debugFns.nodePx = (key) => {
    let i = -1;
    if (typeof key === "number") i = key;
    else if (key != null) {
      const s0 = String(key).replace(/^\$+/, "");
      if (S.mintIdx && S.mintIdx.has(s0)) i = S.mintIdx.get(s0);
      if (i < 0 && S.famBy) { const fb = S.famBy(s0); if (fb) i = fb.top; }
    }
    if (!(i >= 0) || !(invIdx[i] >= 0)) return null;
    const p = scrOf(invIdx[i]), fr = S.fitRect ? S.fitRect() : { x0: 0, y0: 0, x1: S.W(), y1: S.H() };
    return { i, r: +screenR(i).toFixed(2), x: +p.x.toFixed(1), y: +p.y.toFixed(1), onScreen: inFit(p, fr), logo: logoIdx[i] >= 0 };
  };
  // (look fix) roots6 counts only tops that are DRAWN as discs (planets, and dust-family tops once the field handed off), so at
  // the flat overview it is the planets; roots6Dead = those whose upstream is dead (never drawable), so QA's done condition is
  // roots6Drawn + roots6Dead == roots6. kids5* = children >= LOGO_MIN_PX (4.5 px) on screen (kids45* are the same numbers);
  // kids10* kept.
  // (look fix) kidLogos(minR, max): the on-screen children drawn >= minR px, biggest first, with their logo state (cell owned,
  // logo landed, wanted and pending, failed, the loader's ready flag, the image host) - to tell a loader / network wait from a
  // cell-assignment miss
  S.debugFns.kidLogos = (minR = 10, max = 60) => {
    const W = S.W(), H = S.H(), k = S.cam.k, nI = img ? img.length : 0, rows = [];
    for (let q = 0; q < count; q++) {
      const i = perm[q]; if (isTop[i] || i >= nI) continue;
      const r = screenR(i); if (r < minR || !onScreenQ(q, r, W, H, k)) continue;
      let rdy = null; try { rdy = images && img[i] ? !!images.ready(img[i]) : null; } catch { rdy = null; }
      let host = null; try { host = img[i] ? new URL(String(img[i]), location.href).searchParams.get("u") : null; host = host ? new URL(host).host : (img[i] ? String(img[i]).slice(0, 40) : null); } catch { host = img[i] ? String(img[i]).slice(0, 40) : null; }
      rows.push({ i, sym: sym ? sym[i] : "", r: +r.toFixed(2), img: !!img[i], cell: loC[i], has: loHas[i], code: logoIdx[i], pending: pendingLogo.has(i), failed: failedLogo.has(i), ready: rdy, dirty: dirty.has(i), host });
    }
    rows.sort((a, b) => b.r - a.r);
    const n = rows.length, drawn = rows.filter((x) => x.code >= 0).length, noCell = rows.filter((x) => x.img && x.cell < 0).length, pend = rows.filter((x) => x.pending).length;
    return { n, drawn, noCell, pending: pend, rows: rows.slice(0, max) };
  };
  S.debugFns.logoCoverage = () => {
    const W = S.W(), H = S.H(), k = S.cam.k, nI = img ? img.length : 0;
    const dustOn = G || S.dustExpand > 0.02;
    const o = { rootsOnScreen: 0, rootsWithImage: 0, rootsDrawn: 0, roots6: 0, roots6Drawn: 0, roots6Dead: 0, kids5: 0, kids5WithImage: 0, kids5Drawn: 0, kids10: 0, kids10WithImage: 0, kids10Drawn: 0, cellsLo: LO_N, cellsHi: HI_N, usedLo: 0, usedHi: 0 };
    for (let q = 0; q < count; q++) {
      const i = perm[q], r = screenR(i);
      if (isTop[i]) {
        if (!onScreenQ(q, r, W, H, k)) continue;
        o.rootsOnScreen++; if (i < nI && img[i]) { o.rootsWithImage++; if (aA[q * 4 + 2] >= 0) o.rootsDrawn++; }
        // (fixer) what the viewer sees: tops drawn at >= LOGO_MIN_PX (the logo threshold) and those showing a logo
        const shown = dustOn || !!isTopOfPlanet[i];
        if (shown && r >= (G ? LOD.logo : LOGO_MIN_PX)) { o.roots6++; if (aA[q * 4 + 2] >= 0) o.roots6Drawn++; else if (!(i < nI && img[i]) || failedLogo.has(i)) o.roots6Dead++; }
      } else if (r >= LOGO_MIN_PX && onScreenQ(q, r, W, H, k)) {
        const hasImg = i < nI && !!img[i], drawn = aA[q * 4 + 2] >= 0;
        o.kids5++; if (hasImg) { o.kids5WithImage++; if (drawn) o.kids5Drawn++; }
        if (r >= 10) { o.kids10++; if (hasImg) { o.kids10WithImage++; if (drawn) o.kids10Drawn++; } }
      }
    }
    o.kids45 = o.kids5; o.kids45WithImage = o.kids5WithImage; o.kids45Drawn = o.kids5Drawn; o.kidLogoPx = G ? 10 : LOGO_MIN_PX; o.dustOn = dustOn;
    for (let q = 0; q < LO_N; q++) if (loOwn[q] >= 0) o.usedLo++;
    for (let q = 0; q < HI_N; q++) if (hiOwn[q] >= 0) o.usedHi++;
    o.upload = { ...up }; o.assign = { ...asg }; o.dirty = dirty.size; o.pending = pendingLogo.size; o.failed = failedLogo.size;
    o.loCell = LO_CELL; o.hiCell = HI_CELL; o.t = performance.now();
    return o;
  };

  // (round 2) breathing: is a live coin drawn >= BREATH_MIN_PX on screen, and how large is the largest? Checked every
  // 200 ms (and at once when the camera moved); one pass over the instances (~0.1 ms).
  const uBreath = bMat.uniforms.uBreath;
  const breath = { vis: 0, rMax: 0, at: -1e9, cx: NaN, cy: NaN, ck: NaN, reqAt: -1e9, interval: 66, requests: 0 };
  function breathCheck(now) {
    const k = S.cam.k, ms = U.uMinScale.value, W = S.W(), H = S.H(), k0 = U.uK0.value, dustOn = S.dustExpand > 0.05;
    const rel = 1 - smoothJ(STIP_K0[0] * k0, STIP_K0[1] * k0, k);
    let vis = 0, rMax = 0;
    for (let q = 0; q < count; q++) {
      if (aHeat[q * 4] !== 0) continue;                       // drawn class: live only
      if (aB[q * 4] > 0.5 && !dustOn) continue;              // dust families are hidden at the overview
      let r = Math.max(scaleAt(q, k) * k, aA[q * 4] * ms);
      if (!aB[q * 4 + 3] && !aB[q * 4]) r += (Math.min(r, aA[q * 4 + 3] ? STIP_NOTABLE_PX : STIP_PX) - r) * rel;
      if (r < BREATH_MIN_PX) continue;
      const sx = (aXY[q * 2] - S.cam.x) * k + W / 2, sy = H / 2 - (aXY[q * 2 + 1] - S.cam.y) * k;
      if (sx < -r || sx > W + r || sy < -r || sy > H + r) continue;
      vis++; if (r > rMax) rMax = r;
    }
    breath.vis = vis; breath.rMax = rMax; breath.at = now; breath.cx = S.cam.x; breath.cy = S.cam.y; breath.ck = k;
    // fastest edge speed = 2 pi A r / Pmin (px/s): render often enough that no step exceeds BREATH_STEP_PX
    const speed = (2 * Math.PI * BREATH_A * rMax) / BREATH_P[0];
    breath.interval = Math.max(16, Math.min(66, speed > 0 ? (1000 * BREATH_STEP_PX) / speed : 66));
  }

  // per frame: upload a changed atlas at most every 400 ms; follow moved coins; keep frames coming while something animates
  let lastNow = 0;
  S.onFrame((now) => {
    let busy = false;
    // (map3 port) one render per atlas upload: a dirty atlas waiting out its 400 ms throttle no longer asks for a render on
    // every frame (the app's loader delivers logos over tens of seconds; the hook runs every frame anyway, so the upload
    // still happens on time). The look is unchanged.
    // (visibility lane) cell assignment (<= every 250 ms and on camera settle) + dirty-cell upload batch (<= 2 ms)
    if (assignCells(now)) busy = true;
    if (uploadBatch(now)) busy = true;
    if (dirty.size) busy = true;
    // (round 2, amendment E) a lane that moves coins mutates S.X/S.Y in place; follow it the same frame
    scanXY();
    if (glows && glowTick(now)) busy = true;
    if (glows && U.uTime.value < glowFlashUntil) busy = true;
    // (round 2, amendment A) breathing: off (at once) under reduced motion, else eases in over 600 ms
    // (final fix) and asleep BREATH_SLEEP_MS after the last input: it eases out over BREATH_FADE_MS
    const dt = Math.min(100, Math.max(0, now - lastNow)); lastNow = now;
    const rm = !!(S.motion && S.motion.reduced);
    const asleep = !rm && now - (S.lastInputAt || 0) > BREATH_SLEEP_MS;
    breath.asleep = asleep;
    const bTo = rm || asleep ? 0 : 1;
    if (uBreath.value !== bTo) { uBreath.value = rm ? 0 : asleep ? Math.max(0, uBreath.value - dt / BREATH_FADE_MS) : Math.min(1, uBreath.value + dt / 600); busy = true; }
    if (!rm && !asleep) {
      if (now - breath.at > 200 || breath.cx !== S.cam.x || breath.cy !== S.cam.y || breath.ck !== S.cam.k) breathCheck(now);
      if (breath.vis && now - breath.reqAt >= breath.interval - 2) { breath.reqAt = now; breath.requests++; busy = true; }
    }
    return busy || U.uTime.value < animUntil;
  });

  // debug: how many instances sit in each LOD band right now (CSS px), and how many can emit HDR
  S.debugFns.bubbleLOD = () => {
    const k = S.cam.k, dpr = S.DPR, ms = U.uMinScale.value, out = { k: +k.toFixed(3), k0: +(U.uK0.value).toFixed(3), hidden: 0, dot: 0, flat: 0, body: 0, sphere: 0, logo: 0, arcs: 0, hdr: 0 };
    for (let q = 0; q < count; q++) {
      const i = perm[q], f = fams[famOf[i]] || { planet: false };
      if (!f.planet && S.dustExpand < 0.01) { out.hidden++; continue; }
      let r = Math.max(scaleAt(q, k) * k, aA[q * 4] * ms, 0.5);
      if (!aB[q * 4 + 3] && f.planet) r += (Math.min(r, notable[i] ? STIP_NOTABLE_PX : STIP_PX) - r) * (1 - smoothJ(STIP_K0[0] * U.uK0.value, STIP_K0[1] * U.uK0.value, k));
      const chip = isTopOfPlanet[i] && aA[q * 4] > 0, logoAt = chip ? 4.8 : LOD.logo;
      const band = logoIdx[i] >= 0 && r >= logoAt ? "logo" : r < 1 ? "dot" : r < LOD.body ? "flat" : r < LOD.sphere ? "body" : "sphere";
      out[band]++;
      if (r >= TOK.arcMinR && aA[q * 4 + 1] > 0 && k >= ARC_K0[1] * U.uK0.value) out.arcs++;
      if (cls[i] === 0 && (band === "sphere" || band === "logo")) out.hdr++;
    }
    out.breathing = { on: +uBreath.value.toFixed(2), asleep: !!breath.asleep, sleepMs: BREATH_SLEEP_MS, visible: breath.vis, rMaxPx: +breath.rMax.toFixed(1), renderEveryMs: Math.round(breath.interval), requests: breath.requests };
    out.instances = count; out.capacity = CAP; out.movedLastFrame = lastMoved;
    return out;
  };

  // (look fix) drawsDustTops: galaxy only. Flat: dust.js draws every small family as a speck at the overview (every family visible,
  // calm); bubbles' dust-top discs fade in with uDustExpand (motion.js picks a dust top through the dust grid until then)
  Object.assign(S.bubbles, { mesh: bubbles, perm, invIdx, cls, atlas: HIa.rt.texture, atlasHi: HIa.rt.texture, atlasLo: LOa.rt.texture, logoIdx, logoList, setCoinHeat, flashRim, selectCoin, screenR, outerR, setInside, hasLogo: (i) => logoIdx[i] >= 0, drawnPx: screenR, drawsDustTops: G, atlasStats: () => ({ ...up, dirty: dirty.size, pending: pendingLogo.size }),
    flashFamily, flashCore, birth, syncXY, addCoin, moveCoin, capacity: CAP, count: () => count, drawR, rangesSafe: true,
    glows, flashCorona, look: G ? "galaxy" : "flat",
    setHl, hlOf, logoPx, breathState: () => ({ on: +uBreath.value.toFixed(2), asleep: !!breath.asleep, sleepMs: BREATH_SLEEP_MS, sinceInputMs: Math.round(performance.now() - (S.lastInputAt || 0)), visible: breath.vis, rMaxPx: +breath.rMax.toFixed(1), renderEveryMs: Math.round(breath.interval), requests: breath.requests }) });
  // (map3 port) teardown: the mesh, its geometry (+ the quad it borrows from), the material, both atlases and the glyphs
  S.life.onDispose(() => {
    scene.remove(bubbles);
    if (!S.contextLost) { bGeo.dispose(); quad.dispose(); bMat.dispose(); HIa.rt.dispose(); LOa.rt.dispose(); scLo.t.dispose(); scHi.t.dispose(); gTex.dispose(); }   // a lost context took them already
    scLo.c.width = scLo.c.height = 0; scHi.c.width = scHi.c.height = 0; gCan.width = gCan.height = 0;
    drawnImg.fill(null); pendingLogo.clear(); dirty.clear();
  });
  Object.assign(S.debug.obj, { bubbles, shadows: null, glows, coronas: glows });
  // (visibility lane) exports before buildLinks: drawn world radius (seed-head shrink applied) and the static CSS-px floor
  S.Rdraw = drawR.subarray(0, N); S.minPx = minPxS;
  S.debug.map.logos = logoList.length;
  S.debug.map.seedKids = nSeedKids; S.debug.map.seedShrunk = nShrunk;
  S.debug.map.bubblesMs = Math.round(performance.now() - tBuild);
}
