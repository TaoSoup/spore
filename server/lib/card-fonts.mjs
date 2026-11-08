// The faces the share card is set in (lib/card.mjs), on their own so two threads can load them:
// the main thread needs the metrics (cmap, advances) to measure and fit text, the image worker
// (lib/img-worker.mjs) needs the raw TTF bytes to hand resvg, and neither should pull the other's
// imports (the renderer brings the model, pricing and the Solana SDK; the worker must stay small).
// The six Geist TTFs are vendored under lib/fonts (OFL.txt beside them): resvg-wasm cannot read
// system fonts, and the npm package that ships them wants Next.js as a peer.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The six faces the card sets text in, vendored under lib/fonts (Geist 1.8.2). */
const FONT_DIR = new URL("./fonts/", import.meta.url);
export const FONT_FILES = {
  "sans:400": "Geist-Regular.ttf", "sans:500": "Geist-Medium.ttf", "sans:600": "Geist-SemiBold.ttf", "sans:700": "Geist-Bold.ttf",
  "mono:400": "GeistMono-Regular.ttf", "mono:500": "GeistMono-Medium.ttf",
};
export const FAMILY = { sans: "Geist", mono: "Geist Mono" };

/** The cmap (code point → glyph), horizontal advances and units-per-em of a TrueType font: enough to measure a line. */
export function parseFont(buf) {
  const u16 = (o) => buf.readUInt16BE(o), u32 = (o) => buf.readUInt32BE(o), i16 = (o) => buf.readInt16BE(o);
  const tables = {};
  for (let i = 0, n = u16(4); i < n; i++) { const o = 12 + i * 16; tables[buf.toString("latin1", o, o + 4)] = u32(o + 8); }
  for (const t of ["head", "hhea", "hmtx", "cmap"]) if (tables[t] == null) throw new Error(`font: no ${t} table`);
  const upem = u16(tables.head + 18) || 1000;
  const nhm = u16(tables.hhea + 34);
  const adv = new Uint16Array(nhm);
  for (let i = 0; i < nhm; i++) adv[i] = u16(tables.hmtx + i * 4);
  // the best Unicode subtable: format 12 (full range) over format 4 (BMP)
  let best = null;
  for (let i = 0, n = u16(tables.cmap + 2); i < n; i++) {
    const off = tables.cmap + u32(tables.cmap + 8 + i * 8), fmt = u16(off), score = fmt === 12 ? 2 : fmt === 4 ? 1 : 0;
    if (score > (best?.score ?? 0)) best = { score, off, fmt };
  }
  if (!best) throw new Error("font: no unicode cmap");
  const cmap = new Map();
  if (best.fmt === 4) {
    const o = best.off, segX2 = u16(o + 6), endO = o + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = u16(endO + s * 2), start = u16(startO + s * 2), delta = i16(deltaO + s * 2), ro = u16(rangeO + s * 2);
      if (start === 0xffff) continue;
      for (let cp = start; cp <= end; cp++) {
        let g;
        if (ro === 0) g = (cp + delta) & 0xffff;
        else { const a = rangeO + s * 2 + ro + (cp - start) * 2; if (a + 2 > buf.length) continue; g = u16(a); if (g) g = (g + delta) & 0xffff; }
        if (g) cmap.set(cp, g);
      }
    }
  } else {
    const o = best.off;
    for (let gi = 0, n = u32(o + 12); gi < n; gi++) { const go = o + 16 + gi * 12, s = u32(go), e = u32(go + 4), g0 = u32(go + 8); for (let cp = s; cp <= e && cp - s < 65_536; cp++) cmap.set(cp, g0 + (cp - s)); }
  }
  return { upem, adv, nhm, cmap };
}

let buffers = null, fontSet = null;
/** The six faces' bytes, read once, in FONT_FILES order: what resvg takes as `fontBuffers`. */
export function fontBuffers() {
  buffers ??= Object.values(FONT_FILES).map((file) => new Uint8Array(readFileSync(fileURLToPath(new URL(file, FONT_DIR)))));
  return buffers;
}
/** The six faces, parsed once: `buffers` for resvg, `metrics` per "family:weight" for measuring. */
export function fonts() {
  if (fontSet) return fontSet;
  const bufs = fontBuffers(), metrics = {};
  Object.keys(FONT_FILES).forEach((key, i) => { metrics[key] = parseFont(Buffer.from(bufs[i].buffer, bufs[i].byteOffset, bufs[i].byteLength)); });
  fontSet = { buffers: bufs, metrics };
  return fontSet;
}
