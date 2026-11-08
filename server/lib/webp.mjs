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

/** `{ width, height, data }` (RGBA, Uint8ClampedArray) of a still webp, or null (animated, truncated, not webp). */
export async function decodeWebp(bytes) {
  if (!bytes || bytes.byteLength < 12) return null;
  try {
    const m = await decoder();
    const r = m.decode(ownArrayBuffer(bytes));
    if (!r || !(r.width > 0) || !(r.height > 0) || !r.data || r.data.length < r.width * r.height * 4) return null;
    return { width: r.width, height: r.height, data: r.data };
  } catch { return null; }
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
