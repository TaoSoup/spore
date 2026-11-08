// util.js: pure helpers shared by every lane. (map3 port) sharePct follows the app's rule (lib/map/dominance.ts).
// FROZEN in the prototype (lead/judge only). Need a new helper? Define it in
// your own module; do not change these (other lanes depend on their exact output).
//
// EXPORTS
//   GOLDEN, TAU                      constants
//   clamp01(t), smooth(a, b, t)      smoothstep on [a, b]
//   rnd(i, seed) -> [0, 1)           deterministic hash
//   fmtN(n)                          '21,301'
//   sharePct(s)                      '40%', '6.2%', '<0.1%'
//   fmtUsd(v)                        '$4.0B', '$34k', '$1.2k', '$512', '–'
//   fmtAge(ageSec)                   'traded 4 min ago' ...
//   lin(hex, k = 1) -> [r, g, b]     sRGB hex -> linear rgb (THREE.Color), times k
import * as THREE from "three";

export const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export const TAU = Math.PI * 2;
export const clamp01 = (t) => Math.max(0, Math.min(1, t));
export const rnd = (i, s) => { const x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); };
export const fmtN = (n) => n.toLocaleString("en-US");
// (map3 port) the app's sharePct: "0%" for <= 0 (or not a number), "<0.1%" below 0.05 %, one decimal below 9.95 %, then whole
export const sharePct = (s) => { if (s == null || !Number.isFinite(s) || s <= 0) return "0%"; const p = s * 100; if (p < 0.05) return "<0.1%"; if (p < 9.95) return p.toFixed(1) + "%"; return Math.round(Math.min(100, p)) + "%"; };
export const fmtUsd = (v) => !(v > 0) ? "–" : v >= 1e9 ? "$" + (v / 1e9).toFixed(1) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? "$" + (v / 1e3).toFixed(v < 1e4 ? 1 : 0) + "k" : "$" + Math.round(v);
export const fmtAge = (a) => a === Infinity ? "no trades 24 h" : a < 60 ? "traded just now" : a < 3600 ? `traded ${Math.round(a / 60)} min ago` : `traded ${(a / 3600).toFixed(1)} h ago`;
export const smooth = (a, b, t) => { t = clamp01((t - a) / (b - a)); return t * t * (3 - 2 * t); };
export const lin = (hex, k = 1) => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; };
