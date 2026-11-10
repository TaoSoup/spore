// WebP in and out of the logo pipeline through @jsquash/webp (libwebp compiled to WebAssembly,
// no native build). Most pump.fun launchpad CDNs serve logos as webp, which resvg cannot read, so
// a thumbnail of one is made from the decoded RGBA; the logo sheet is encoded as lossy webp
// because 256 cells at q75 weigh ~280 KB against ~2.3 MB as PNG. The codec modules are instantiated
// once per thread from the non-SIMD wasm files (the package's own `init` would pick the SIMD build
// by feature detection and then run our module through the wrong glue).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initEmscriptenModule } from "@jsquash/webp/utils.js";
import { defaultOptions } from "@jsquash/webp/meta.js";

const require = createRequire(import.meta.url);
let dec = null, enc = null;
async function decoder() {
  dec ??= (async () => {
    const { default: factory } = await import("@jsquash/webp/codec/dec/webp_dec.js");
    return initEmscriptenModule(factory, await WebAssembly.compile(readFileSync(require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm"))));
  })();
  dec.catch(() => { dec = null; });
  return dec;
}
async function encoder() {
  enc ??= (async () => {
    const { default: factory } = await import("@jsquash/webp/codec/enc/webp_enc.js");
    return initEmscriptenModule(factory, await WebAssembly.compile(readFileSync(require.resolve("@jsquash/webp/codec/enc/webp_enc.wasm"))));
  })();
  enc.catch(() => { enc = null; });
  return enc;
}
const ownArrayBuffer = (bytes) => { const u8 = new Uint8Array(bytes.byteLength); u8.set(bytes); return u8.buffer; };

/**
 * `{ width, height, data }` (RGBA, Uint8ClampedArray) of a webp, or null (truncated, not webp). An animated
 * webp, which libwebp's still decoder refuses, gives its first frame (firstFrameWebp): a logo needs one.
 */
export async function decodeWebp(bytes) {
  if (!bytes || bytes.byteLength < 12) return null;
  const still = await decodeStill(bytes);
  if (still) return still;
  const frame = firstFrameWebp(bytes);
  return frame ? decodeStill(frame) : null;
}
async function decodeStill(bytes) {
  try {
    const m = await decoder();
    const r = m.decode(ownArrayBuffer(bytes));
    if (!r || !(r.width > 0) || !(r.height > 0) || !r.data || r.data.length < r.width * r.height * 4) return null;
    return { width: r.width, height: r.height, data: r.data };
  } catch { return null; }
}

const fourcc = (b, at) => b.toString("latin1", at, at + 4);
/** One RIFF chunk: the 8-byte header, the payload and the pad byte an odd payload takes. */
function riffChunk(id, payload) {
  const head = Buffer.alloc(8);
  head.write(id, 0, "latin1"); head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, Buffer.alloc(payload.length & 1)]);
}
/**
 * The first frame of an animated webp (RIFF / VP8X with the animation flag / ANIM / ANMF ...) as a still
 * webp, or null when `bytes` is not one. The frame's own chunks are copied as they are: a lossless VP8L or
 * a lossy VP8 alone make a simple file; a lossy VP8 with its ALPH plane gets a VP8X header (alpha flag, the
 * frame's size). Every length is checked against the buffer, so a truncated or hostile file is null.
 */
export function firstFrameWebp(bytes) {
  if (!bytes || bytes.byteLength < 30) return null;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourcc(b, 0) !== "RIFF" || fourcc(b, 8) !== "WEBP" || fourcc(b, 12) !== "VP8X" || !(b[20] & 0x02)) return null;
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4));
  for (let p = 12; p + 8 <= riffEnd;) {
    const size = b.readUInt32LE(p + 4), body = p + 8, end = body + size;
    if (end > riffEnd) return null;
    if (fourcc(b, p) === "ANMF") {
      if (size < 16 + 8) return null;
      const w = 1 + b.readUIntLE(body + 6, 3), h = 1 + b.readUIntLE(body + 9, 3);
      let alph = null, image = null;
      for (let q = body + 16; q + 8 <= end;) {
        const id = fourcc(b, q), n = b.readUInt32LE(q + 4);
        if (q + 8 + n > end) return null;
        const payload = b.subarray(q + 8, q + 8 + n);
        if (id === "ALPH") alph = payload;
        else if (id === "VP8 " || id === "VP8L") { image = { id, payload }; break; }
        q += 8 + n + (n & 1);
      }
      if (!image) return null;
      const chunks = [];
      if (image.id === "VP8 " && alph) {
        const x = Buffer.alloc(10);
        x[0] = 0x10; x.writeUIntLE(w - 1, 4, 3); x.writeUIntLE(h - 1, 7, 3); // alpha flag; canvas = the frame
        chunks.push(riffChunk("VP8X", x), riffChunk("ALPH", alph));
      }
      chunks.push(riffChunk(image.id, image.payload));
      const rest = Buffer.concat(chunks), head = Buffer.alloc(12);
      head.write("RIFF", 0, "latin1"); head.writeUInt32LE(4 + rest.length, 4); head.write("WEBP", 8, "latin1");
      return Buffer.concat([head, rest]);
    }
    p = end + (size & 1);
  }
  return null;
}

/** WebP bytes of a w x h RGBA buffer: lossy at `quality` (alpha kept, its own channel at full quality), `method` 0 (fast) … 6 (slow). */
export async function encodeWebp(rgba, w, h, { quality = 75, method = 2 } = {}) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || rgba.length < w * h * 4) throw new Error("webp: bad input");
  const m = await encoder();
  const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4);
  const r = m.encode(data, w, h, { ...defaultOptions, quality, method });
  if (!r) throw new Error("webp: encode failed");
  return Buffer.from(r.buffer, r.byteOffset, r.byteLength);
}
