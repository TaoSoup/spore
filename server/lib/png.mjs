// A minimal PNG codec on node:zlib for the logo pipeline: the thumbnailer writes 8-bit RGBA PNGs
// (colour type 6, one IDAT, unfiltered rows) and the logo sheet reads them back pixel-exact to blit
// into one RGBA canvas. The decoder covers what a resvg render or a plain exporter produces (8-bit,
// non-interlaced, colour types 0/2/4/6, all five row filters); anything else throws so the caller
// re-renders instead of guessing. `coverBox` is the centre-crop + box-average downsample the webp
// path uses (resvg cannot read webp, so those thumbs are made from decoded RGBA).
import { deflateSync, inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** PNG bytes (8-bit RGBA, colour type 6, filter 0 on every row, one IDAT) of a w x h RGBA buffer. */
export function encodePng(rgba, w, h, { level = 6 } = {}) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new Error("png: bad size");
  if (rgba.length < w * h * 4) throw new Error("png: rgba too short");
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level })), chunk("IEND", Buffer.alloc(0))]);
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };
/**
 * `{ w, h, rgba }` of an 8-bit non-interlaced PNG of colour type 0 (grey), 2 (rgb), 4 (grey+alpha) or
 * 6 (rgba); every row filter (none/sub/up/average/paeth) is undone. Palette, 16-bit and interlaced
 * images throw ("unsupported png"), as does a truncated or non-PNG buffer.
 */
export function decodePng(buf) {
  if (!buf || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error("png: not a png");
  let p = 8, w = 0, h = 0, depth = 0, ct = -1, interlace = 0, seen = false;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error("png: truncated chunk");
    const data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; interlace = data[12]; seen = true; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!seen || !idat.length) throw new Error("png: missing IHDR or IDAT");
  if (depth !== 8 || interlace !== 0 || !(ct in CHANNELS)) throw new Error(`unsupported png (depth ${depth}, colour type ${ct}, interlace ${interlace})`);
  if (w <= 0 || h <= 0 || w * h > 64 * 1024 * 1024) throw new Error("png: bad size");
  const ch = CHANNELS[ct], stride = w * ch;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error("png: short image data");
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride), rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    raw.copy(cur, 0, rp, rp + stride); rp += stride;
    if (f === 1) for (let i = ch; i < stride; i++) cur[i] = (cur[i] + cur[i - ch]) & 0xff;
    else if (f === 2) for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
    else if (f === 3) for (let i = 0; i < stride; i++) cur[i] = (cur[i] + (((i >= ch ? cur[i - ch] : 0) + prev[i]) >> 1)) & 0xff;
    else if (f === 4) for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    } else if (f !== 0) throw new Error(`png: bad filter ${f}`);
    const row = y * w * 4;
    if (ch === 4) cur.copy(out, row);
    else if (ch === 3) for (let x = 0, s = 0, o = row; x < w; x++, s += 3, o += 4) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; }
    else if (ch === 2) for (let x = 0, s = 0, o = row; x < w; x++, s += 2, o += 4) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1]; }
    else for (let x = 0, o = row; x < w; x++, o += 4) { out[o] = out[o + 1] = out[o + 2] = cur[x]; out[o + 3] = 255; }
    [prev, cur] = [cur, prev];
  }
  return { w, h, rgba: out };
}

/**
 * s x s RGBA "cover" thumbnail of a w x h RGBA image: the centre square (short side) is cut out and
 * box-averaged down (every source pixel of a cell weighs the same; an upscale repeats pixels).
 */
export function coverBox(rgba, w, h, s) {
  const side = Math.min(w, h), ox = (w - side) >> 1, oy = (h - side) >> 1, out = Buffer.alloc(s * s * 4);
  if (side <= 0 || rgba.length < w * h * 4) throw new Error("coverBox: bad input");
  for (let y = 0; y < s; y++) {
    const y0 = oy + Math.floor((y * side) / s), y1 = oy + Math.max(Math.floor(((y + 1) * side) / s), Math.floor((y * side) / s) + 1);
    for (let x = 0; x < s; x++) {
      const x0 = ox + Math.floor((x * side) / s), x1 = ox + Math.max(Math.floor(((x + 1) * side) / s), Math.floor((x * side) / s) + 1);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0, o = (yy * w + x0) * 4; xx < x1; xx++, o += 4) { r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; a += rgba[o + 3]; n++; }
      const o = (y * s + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}
