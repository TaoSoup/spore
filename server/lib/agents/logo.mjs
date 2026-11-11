// Logos for agent proposals (DESIGN §13): a 512×512 PNG drawn from the root's palette, a motif picked
// per proposal and the ticker's letters, without native dependencies. The SVG is built here and
// rasterised by resvg compiled to WebAssembly (@resvg/resvg-wasm, loaded once per process).
//
// Letters are drawn as strokes from a small built-in font (A-Z, 0-9 on a 4×6 grid; a ticker over five
// characters wraps onto two rows, at the name's word break when it has one) instead of text,
// so rendering never depends on fonts installed on the machine and the same input always gives the
// same bytes.
import { rng } from "./designer.mjs";
import { resvgWasm } from "../resvg-wasm.mjs";

export const LOGO_SIZE = 512;

// Glyphs: polylines on a 4-wide, 6-high grid (y down).
const O = [[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]];
const P = [[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]];
export const GLYPHS = {
  A: [[[0, 6], [0, 2], [2, 0], [4, 2], [4, 6]], [[0, 4], [4, 4]]],
  B: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[3, 3], [4, 4], [4, 5], [3, 6], [0, 6]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 0], [3, 0]], [[2, 0], [2, 6]], [[1, 6], [3, 6]]],
  J: [[[4, 0], [4, 5], [3, 6], [1, 6], [0, 5]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 4]], [[1.4, 2.9], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [O],
  P: [P],
  Q: [O, [[2.5, 4.5], [4, 6]]],
  R: [P, [[2, 3], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 3], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  0: [O, [[1, 4.5], [3, 1.5]]],
  1: [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
  2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  3: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1.5, 3]], [[3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  5: [[[4, 0], [0, 0], [0, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  6: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]],
  7: [[[0, 0], [4, 0], [1.5, 6]]],
  8: [[[1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3]]],
  9: [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [4, 3]]],
};

const f1 = (n) => Math.round(n * 10) / 10;
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const validHex = (s) => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);

/**
 * The letters drawn for a ticker (the font's A-Z and 0-9, up to ten), in rows: one row up to six;
 * else two, split where the coin's name splits into words when the ticker spells them ("Baby Goblin"
 * → BABY / GOBLIN) and both rows keep 2-6 letters, otherwise in the middle.
 */
export function logoRows(symbol, name = "") {
  const letters = String(symbol ?? "").toUpperCase().split("").filter((c) => GLYPHS[c]).slice(0, 10);
  if (letters.length <= 6) return letters.length ? [letters] : [];
  const joined = letters.join("");
  let cut = Math.ceil(letters.length / 2);
  const words = String(name).toUpperCase().split(/\s+/).map((w) => w.replace(/[^A-Z0-9]/g, "")).filter(Boolean);
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(""), tail = words.slice(i).join("");
    if (head + tail === joined && head.length >= 2 && head.length <= 6 && tail.length >= 2 && tail.length <= 6) { cut = head.length; break; }
  }
  return [letters.slice(0, cut), letters.slice(cut)];
}

function glyphPaths(rows, { cx, cy, maxW, maxH }) {
  if (!rows.length) return null;
  const gap = 1.6, lineGap = 2.2;
  const widths = rows.map((l) => l.length * 4 + (l.length - 1) * gap);
  const h = rows.length * 6 + (rows.length - 1) * lineGap;
  const u = Math.min(maxW / Math.max(...widths), maxH / h);
  const d = [];
  rows.forEach((letters, row) => {
    const x0 = cx - (widths[row] * u) / 2, y0 = cy - (h * u) / 2 + row * (6 + lineGap) * u;
    letters.forEach((ch, i) => {
      const ox = x0 + i * (4 + gap) * u;
      for (const line of GLYPHS[ch]) d.push(`M${line.map(([x, y]) => `${f1(ox + x * u)} ${f1(y0 + y * u)}`).join(" L")}`);
    });
  });
  return { d: d.join(" "), stroke: f1(u * 0.95) };
}

/** The SVG text of a logo; deterministic in (symbol, palette, seed, name). */
export function logoSvg({ symbol, palette = [], seed = "", name = "" }) {
  const S = LOGO_SIZE, c = S / 2;
  const r = rng(`logo:${seed}:${symbol}`);
  const accent = validHex(palette[0]) ? palette[0] : "#b6ff5c";
  const second = validHex(palette[1]) ? palette[1] : "#b08cff";
  const deep = validHex(palette[2]) ? palette[2] : "#0b1a12";
  const ink = contrast(accent, deep) >= 3 ? accent : lum(deep) < 0.3 ? "#f4f7f2" : "#101010";
  const parts = [];
  const motif = ["spores", "rings", "rays", "hex", "blob"][Math.floor(r() * 5)];
  if (motif === "spores") {
    const n = 14 + Math.floor(r() * 9);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.3, rad = 180 + r() * 50, size = 6 + r() * 22;
      parts.push(`<circle cx="${f1(c + Math.cos(a) * rad)}" cy="${f1(c + Math.sin(a) * rad)}" r="${f1(size)}" fill="${i % 3 ? accent : second}" fill-opacity="${f1(0.35 + r() * 0.55)}"/>`);
    }
  } else if (motif === "rings") {
    const n = 3 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) parts.push(`<circle cx="${c}" cy="${c}" r="${f1(170 + i * (70 / n) + r() * 6)}" fill="none" stroke="${i % 2 ? accent : second}" stroke-width="${f1(3 + r() * 9)}" stroke-opacity="${f1(0.4 + r() * 0.5)}"/>`);
  } else if (motif === "rays") {
    const n = 12 + Math.floor(r() * 13);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, r0 = 165, r1 = 205 + r() * 50;
      parts.push(`<line x1="${f1(c + Math.cos(a) * r0)}" y1="${f1(c + Math.sin(a) * r0)}" x2="${f1(c + Math.cos(a) * r1)}" y2="${f1(c + Math.sin(a) * r1)}" stroke="${i % 2 ? second : accent}" stroke-width="${f1(5 + r() * 8)}" stroke-linecap="round" stroke-opacity="0.75"/>`);
    }
  } else if (motif === "hex") {
    const turn = r() * Math.PI;
    for (const [rad, color, w] of [[228, second, 10], [196, accent, 4]]) {
      const pts = Array.from({ length: 6 }, (_, i) => { const a = turn + (i / 6) * Math.PI * 2; return `${f1(c + Math.cos(a) * rad)},${f1(c + Math.sin(a) * rad)}`; }).join(" ");
      parts.push(`<polygon points="${pts}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-opacity="0.8"/>`);
    }
  } else {
    const n = 9, pts = Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2, rad = 190 + r() * 45; return [c + Math.cos(a) * rad, c + Math.sin(a) * rad]; });
    // Closed Catmull-Rom spline through the points, as cubic Béziers: an organic blob.
    let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      d += ` C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
    }
    parts.push(`<path d="${d} Z" fill="${second}" fill-opacity="0.55"/>`);
  }
  const g = glyphPaths(logoRows(symbol, name), { cx: c, cy: c, maxW: 220, maxH: 150 });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`,
    `<defs><radialGradient id="bg" cx="50%" cy="42%" r="75%"><stop offset="0" stop-color="${second}" stop-opacity="0.55"/><stop offset="0.55" stop-color="${deep}"/><stop offset="1" stop-color="${deep}"/></radialGradient></defs>`,
    `<rect width="${S}" height="${S}" fill="${deep}"/><rect width="${S}" height="${S}" fill="url(#bg)"/>`,
    ...parts,
    `<circle cx="${c}" cy="${c}" r="150" fill="${deep}" stroke="${accent}" stroke-width="6"/>`,
    g ? `<path d="${g.d}" fill="none" stroke="${deep}" stroke-width="${f1(g.stroke * 1.8)}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.6"/><path d="${g.d}" fill="none" stroke="${ink}" stroke-width="${g.stroke}" stroke-linecap="round" stroke-linejoin="round"/>` : "",
    "</svg>",
  ].join("");
}

let ready = null;
async function resvg() {
  ready ??= (async () => {
    const mod = await import("@resvg/resvg-wasm");
    // the bytes the image worker uses too (memory capped): V8 compiles the module once for both
    await mod.initWasm(resvgWasm());
    return mod;
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

/** The PNG bytes (512×512) of a logo. */
export async function renderLogo(opts) {
  const { Resvg } = await resvg();
  const img = new Resvg(logoSvg(opts), { fitTo: { mode: "width", value: LOGO_SIZE }, font: { loadSystemFonts: false } });
  try { return Buffer.from(img.render().asPng()); } finally { img.free(); }
}

/** `{ width, height }` from a PNG's IHDR, or null when the bytes are not a PNG. */
export function pngSize(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!buf || buf.length < 24 || sig.some((b, i) => buf[i] !== b) || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
