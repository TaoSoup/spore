// lib/png.mjs: the PNG codec the logo sheet relies on (encode what the thumbnailer writes, decode it
// and resvg's own output pixel-exact, every row filter, refuse what it cannot read) and coverBox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { encodePng, decodePng, coverBox } from "../lib/png.mjs";
import { renderThumb } from "../lib/meta.mjs";
import { renderLogo, logoSvg, pngSize } from "../lib/agents/logo.mjs";

// a second tiny writer, so the decoder is tested against bytes the encoder under test did not make
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
/** A PNG of `pixels` (w x h, `ch` channels per pixel, colour type `ct`) with every row filtered by `filter`. */
function makePng(pixels, w, h, { ch = 4, ct = 6, filter = 0, depth = 8, interlace = 0 } = {}) {
  const stride = w * ch, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i], a = i >= ch ? pixels[y * stride + i - ch] : 0, b = y > 0 ? pixels[(y - 1) * stride + i] : 0, c = y > 0 && i >= ch ? pixels[(y - 1) * stride + i - ch] : 0;
      const pred = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = ct; ihdr[12] = interlace;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("encodePng -> decodePng round trip keeps every RGBA byte, including alpha", () => {
  const w = 3, h = 2, rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
  const png = encodePng(rgba, w, h);
  assert.deepEqual(pngSize(png), { width: 3, height: 2 });
  assert.equal(png[25], 6, "colour type 6 (RGBA)"); assert.equal(png[24], 8, "8-bit");
  const back = decodePng(png);
  assert.equal(back.w, 3); assert.equal(back.h, 2);
  assert.deepEqual([...back.rgba], [...rgba]);
  assert.ok(encodePng(rgba, w, h, { level: 1 }).length >= 60, "level is honoured without breaking the container");
});

test("decodePng reads resvg's own output pixel-exact (a logo and a renderThumb)", async () => {
  const opts = { symbol: "P", palette: ["#ff3366", "#113322", "#ffffff"], seed: "png" };
  const logo = await renderLogo(opts);
  const { Resvg } = await import("@resvg/resvg-wasm"); // initialised by renderLogo above
  const r = new Resvg(logoSvg(opts), { fitTo: { mode: "width", value: 512 }, font: { loadSystemFonts: false } });
  const out = r.render();
  try {
    const d = decodePng(logo);
    assert.equal(d.w, out.width); assert.equal(d.h, out.height);
    assert.equal(Buffer.compare(d.rgba, Buffer.from(out.pixels)), 0, "every pixel equals resvg's RGBA");
  } finally { out.free?.(); r.free(); }
  const thumb = await renderThumb(logo, "image/png", 64);
  const t = decodePng(thumb);
  assert.equal(t.w, 64); assert.equal(t.h, 64); assert.equal(t.rgba.length, 64 * 64 * 4);
  assert.ok(t.rgba.some((v, i) => i % 4 === 3 && v > 0), "the thumbnail is not transparent");
});

test("decodePng undoes all five row filters and expands grey / rgb / grey+alpha to RGBA", () => {
  const w = 5, h = 4;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 2) * 11) & 0xff;
  for (const filter of [0, 1, 2, 3, 4]) {
    const d = decodePng(makePng(rgba, w, h, { filter }));
    assert.deepEqual([...d.rgba], [...rgba], `filter ${filter}`);
  }
  const rgb = Buffer.alloc(w * h * 3); for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 53) & 0xff;
  const d2 = decodePng(makePng(rgb, w, h, { ch: 3, ct: 2, filter: 4 }));
  for (let p = 0; p < w * h; p++) assert.deepEqual([...d2.rgba.subarray(p * 4, p * 4 + 4)], [rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2], 255]);
  const grey = Buffer.from(Array.from({ length: w * h }, (_, i) => (i * 7) & 0xff));
  const d0 = decodePng(makePng(grey, w, h, { ch: 1, ct: 0, filter: 1 }));
  for (let p = 0; p < w * h; p++) assert.deepEqual([...d0.rgba.subarray(p * 4, p * 4 + 4)], [grey[p], grey[p], grey[p], 255]);
  const ga = Buffer.from(Array.from({ length: w * h * 2 }, (_, i) => (i * 13) & 0xff));
  const d4 = decodePng(makePng(ga, w, h, { ch: 2, ct: 4, filter: 3 }));
  for (let p = 0; p < w * h; p++) assert.deepEqual([...d4.rgba.subarray(p * 4, p * 4 + 4)], [ga[p * 2], ga[p * 2], ga[p * 2], ga[p * 2 + 1]]);
});

test("decodePng refuses 16-bit, interlaced, palette and non-PNG input", () => {
  const rgba = Buffer.alloc(2 * 2 * 4, 7);
  assert.throws(() => decodePng(makePng(rgba, 2, 2, { depth: 16 })), /unsupported png/);
  assert.throws(() => decodePng(makePng(rgba, 2, 2, { interlace: 1 })), /unsupported png/);
  assert.throws(() => decodePng(makePng(Buffer.alloc(4, 1), 2, 2, { ch: 1, ct: 3 })), /unsupported png/);
  assert.throws(() => decodePng(Buffer.from("RIFF....WEBPVP8 " + "x".repeat(40))), /not a png/);
  assert.throws(() => decodePng(encodePng(rgba, 2, 2).subarray(0, 40)), /png/);
});

test("coverBox: centre crop to the short side, then box means", () => {
  // 8 x 4 image: red ramps left to right (0..7 -> x * 32), alpha ramps top to bottom (y * 60)
  const w = 8, h = 4, rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; rgba[o] = x * 32; rgba[o + 1] = 100; rgba[o + 2] = 0; rgba[o + 3] = y * 60; }
  const out = coverBox(rgba, w, h, 2);
  assert.equal(out.length, 2 * 2 * 4);
  // the crop is x 2..5 (the centre 4 columns), rows 0..3; each output cell averages a 2 x 2 block
  const cell = (cx, cy) => [...out.subarray((cy * 2 + cx) * 4, (cy * 2 + cx) * 4 + 4)];
  assert.deepEqual(cell(0, 0), [Math.round((2 * 32 + 3 * 32) / 2), 100, 0, Math.round((0 + 60) / 2)]);
  assert.deepEqual(cell(1, 0), [Math.round((4 * 32 + 5 * 32) / 2), 100, 0, 30]);
  assert.deepEqual(cell(0, 1), [80, 100, 0, Math.round((120 + 180) / 2)]);
  assert.deepEqual(cell(1, 1), [144, 100, 0, 150]);
  const up = coverBox(rgba, w, h, 8); // an upscale repeats pixels and never divides by zero
  assert.equal(up.length, 8 * 8 * 4); assert.equal(up[3], 0); assert.equal(up[(7 * 8) * 4 + 3], 180);
});
