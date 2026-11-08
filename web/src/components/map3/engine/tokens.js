// tokens.js: the judge's design tokens, pasted VERBATIM from the binding spec (only `export` added).
// (map3 port) copied from the prototype unchanged; FONT added (the site's Geist / Geist Mono replace the prototype's faces).
// Final polish (2026-10-21): palette retuned after the critics (cooling teal -> cyan-blue so it never fuses with lime;
// greyscale steps L* 93 / 68 / 55 / 38), live-only lime cores, quieter body tints. Values otherwise as ruled.
// FROZEN: values change only by a judge ruling. Ownership of the keys (who is expected to consume them)
// is listed in LANES.md. CSS twin: tokens.css.
//
// EXPORTS  TOK, heatClass(ageSec) -> 0 live | 1 cooling | 2 quiet | 3 cold, coreBoost(ageSec), EASE, DUR

/* ---------- JS ---------- */
export const TOK = {
  bg: 0x0b0e0d, vigC: 0x0e1211, vigE: 0x070908,
  ink: 0xe7ece9, ink2: 0xb5bdb9, muted: 0x7e8783, faint: 0x59615d,
  // heat classes: 0 live <30 min, 1 cooling <3 h, 2 quiet <24 h, 3 cold (L* 93 / 68 / 55 / 38)
  rim:   [0xb6ff5c, 0x5ab0d6, 0x7c83a8, 0x535b58],
  rimA:  [0.95, 0.85, 0.75, 0.65],
  flatA: [1.0, 0.85, 0.70, 0.55],      // flat discs 1-3 px; sub-px coverage dots use flatA*max(rCss,0.15)
  tint:  [0.10, 0.08, 0.07, 0.07],      // body tint toward rim at r>=9px; 0.16 for 5-9px bodies
  body: 0x171b1a, sep: 0x0b0e0d, monoFill: 0x1c201f, monoInk: 0x9aa39f,
  core: [0xc4ff74, 0x9fd3ea],          // live (the only core drawn); cooling kept for back-compat, never drawn
  coreK: { live5: 1.6, live30: 1.3, cool: 0.9 },   // only live cores exceed 1.0 (bloom)
  logoSat: [0.92, 0.92, 0.75, 0.55], logoVal: [1.0, 1.0, 0.92, 0.82],  // full on hover
  dustA: [0.95, 0.60, 0.40, 0.22],     // live additive, others premultiplied over
  // (veins lane, look fix 2026-10-22) the owner: "the veins between the bubbles are far too big and unprofessional; the
  // previous site looked better". Flat veins are HAIRLINES again, heat-coloured, premultiplied "over" (never additive):
  // quiet 8c93b8, cold 9aa49f, lime / cyan for live / cooling. linkW = the gen-1 core in CSS px AT k0 (+ linkWGen1 for
  // gen-1 and pod trunks, x linkWGen2 for gen >= 2), x clamp(sqrt(k / k0), 1, 1.5) on zoom (so x1.5 from 2.25 k0 up),
  // hard cap linkWMax. No width floor: a core under 1 device px is drawn 1 px wide at coverage alpha (links.js hairWidth).
  // linkA = the base alpha by class; the OLD brood budget (budgetOf(n) link-equivalents, water-filled by importance) and the
  // per-brood ANGULAR ROOM (a brood's veins share at most half of the parent's drawn rim) do the rest; no alpha floor.
  // links.js reads these (flat only; the galaxy look has its own linkW0 / linkK below).
  link:  [0xb6ff5c, 0x5ab0d6, 0x8c93b8, 0x9aa49f],
  linkA: [0.55, 0.40, 0.30, 0.24],
  linkW: [1.2, 1.0, 0.85, 0.75], linkWGen1: 0.1, linkWMax: 1.5, linkWGen2: 0.75, linkWRim: 0.75,
  arc: 0xb5bdb9, arcA: 0.6, arcTrackA: 0.08, arcMinR: 8, arcGap: 3, arcLogDen: Math.log10(5001),
  hover: 0xe7ece9, hoverA: 0.9,
  genArcA: 0.07, genArcAFocus: 0.12, genArcW: 0.75, hullA: 0.12, leaderA: 0.28,
  dim: 0.28, labelDim: 0.35,
  pulse: 0xe9ffc9, pulseK: 1.4, pulseMax: 12, pulseTailPx: 14,
  bloom: { strength: 0.38, radius: 0.15, threshold: 1.0 },
  chipR: (share, maxShare, phone) => (6 + 11 * Math.sqrt(share / maxShare)) * (phone ? 0.85 : 1),
};
export const heatClass = (age) => age <= 1800 ? 0 : age <= 10800 ? 1 : age <= 86400 ? 2 : 3;
export const coreBoost = (age) => age <= 300 ? TOK.coreK.live5 : age <= 1800 ? TOK.coreK.live30 : age <= 10800 ? TOK.coreK.cool : 0;
export const EASE = { out: [0.22, 1, 0.36, 1], inOut: [0.65, 0, 0.35, 1], std: [0.4, 0, 0.2, 1] };
export const DUR = { xs: 120, s: 160, m: 240, l: 400, xl: 600, pulse: 1100, flightMin: 450, flightMax: 1100, dwell: 80, tipDelay: 60 };
// (map3 port) DOM / canvas text faces: the site's own (index.html loads them; only 400 / 500 / 600 are used)
export const FONT = { sans: '"Geist", system-ui, sans-serif', mono: '"Geist Mono", ui-monospace, monospace' };

/* ---------- galaxy look (2026-10-21): overrides applied on top of TOK when S.look === "galaxy"; TOK itself stays frozen ---------- */
// GAL pasted VERBATIM from the galaxy binding spec §2. Consumers read S.tok (= tokensFor(S.look)); flat gets TOK unchanged.
export const GAL = {
  bg: 0x07100b, vigC: 0x0a1710, vigE: 0x050c08,
  rim:  [0xb6ff5c, 0x5ce0c8, 0x7f68c4, 0x4a4466],        // heat colours live/cooling/quiet/cold (M:17)
  heatK: [1.9, 1.25, 0.9, 0.75],                         // HDR boost per class (M:24) → >1.0 blooms
  link: [0xb6ff5c, 0x5ce0c8, 0x7f68c4, 0x4a4466], linkK: [1.9, 1.05, 0.55, 0.42],   // (lead) quiet/cold veins darker: the reference shows them as faint hairlines   // heatK × (live?1:0.85)
  linkA: 0.42, linkANotable: 0.70, linkW0: (R) => Math.min(1.4, Math.max(0.22, 0.42 * R + 0.12)), linkW1: 0.32,  // world u (M:311)
  linkFloorPx: [1.0, 2.5], linkMaxPx: 14, ovLinkA: 0.30,  // floor overview→opened (mix by uGalT); hard cap; overview alpha factor for planet veins
  flow: { periodPx: 28, speed: 0.9, liveX: 1.5, coldX: 0.5, ampOv: 0.15, ampOpen: 0.45 },
  pathLit: { ms: 1100, gain: 1.8 },
  coreA: 0.30, coreRk: 5, coreMinPx: (share, max) => 5 + 14 * Math.sqrt(share / max), hullA: [0.045, 0.025], hullRk: 1.1,
  breath: { liveAmp: 0.35, liveHz: 1.9, restAmp: 0.10, restHz: 0.8 },
  birth: { ms: 1200, r0: 1.0, r1: 3.5, w: 0.25, a0: 0.6, col: 0xe9ffc9, k: 1.3 },
  hoverSweep: { ms: 400, band: 0.25, add: 0.5, gain: 1.35 },
  // (look lane 16:00Z) the old 0.55 / 0.26 / 64 px were tuned while nothing rendered (AdditiveBlending + FS alpha 0): back to the
  // monolith (M:378) and re-tuned against ref-overview.png with the blending fixed (dust.js addMat); see LANES.md "look lane"
  nebula: { frac: 0.30, rk: 6, rAdd: 40, rMinPx: 50, teal: 0x5ce0c8, purple: 0x6a54b0, a: 0.09 },
  ambient: { n: 6000, nPhone: 2500, rk: 1.5, teal: 0x5ce0c8, lav: 0x8a6fe0, tealFrac: 0.6, a0: 0.05, a1: 0.12 },
  dustDrift: { amp0: 5, ampK: 0.45, sp0: 0.25, sp1: 0.35 },
  genArc: 0x1bbe93, genArcA: 0.16, genArcHoverX: 2.5, orbit: 0x5ce0c8, orbitA: 0.10,
  // (look lane 16:20Z) monolith 0.72 measured 2.8x the ref's lit share on today's sources (see scene.js): 0.40, mips 3-4 muted
  bloom: { strength: 0.40, radius: 0.42, threshold: 0.85 }, bloomPhone: { strength: 0.40, radius: 0.42, threshold: 0.85 },
  shade: { L: [-0.45, 0.55, 0.75], specPow: 22, fresnelPow: 2.6 },
  gen: { GAP: 0.7, GAPR: 2.4, firstX: 1.6, stepK: 1.4, subMax: 4, acceptK: 0.85, labelPx: 220 },
};
// (look lane) continuous heat colour + emissive boost, verbatim from the monolith (M:17-24), for any consumer:
//   GAL.heatHex(ageS) -> [r, g, b] sRGB 0..1: lime b6ff5c (<= 30 min) -> teal 5ce0c8 (3 h) -> violet 7f68c4 (24 h); cold 4a4466
//   GAL.heatBoost(ageS) -> 1.9 live | 1.5 -> 1.0 cooling | 0.9 quiet | 0.75 cold (HDR, > 1 feeds the bloom)
const HEXL = { lime: 0xb6ff5c, teal: 0x5ce0c8, violet: 0x7f68c4, cold: 0x4a4466 };
const rgbOf = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const lerp3 = (a, b, t) => { t = Math.max(0, Math.min(1, t)); const A = rgbOf(a), B = rgbOf(b); return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]; };
GAL.heatHex = (age) => { const a = Number.isFinite(age) ? age : Infinity;
  return a <= 1800 ? rgbOf(HEXL.lime) : a <= 10800 ? lerp3(HEXL.lime, HEXL.teal, (a - 1800) / 9000) : a <= 86400 ? lerp3(HEXL.teal, HEXL.violet, (a - 10800) / 75600) : rgbOf(HEXL.cold); };
GAL.heatBoost = (age) => { const a = Number.isFinite(age) ? age : Infinity;
  return a <= 1800 ? 1.9 : a <= 10800 ? 1.0 + 0.5 * (1 - (a - 1800) / 9000) : a <= 86400 ? 0.9 : 0.75; };
const GALTOK = Object.freeze({ ...TOK, ...GAL });
export const tokensFor = (look) => look === "galaxy" ? GALTOK : TOK;
