// The bytes every thread instantiates resvg's WebAssembly module (@resvg/resvg-wasm) from: the package's own module with
// the maximum of its memory set to RESVG_MEMORY_MAX_BYTES. An allocation past it fails and resvg traps at once, instead
// of taking GBs (two nested pattern tiles of a 0.4 KB SVG took ~3.7 GB, a 22 KB png of 8000 x 8000 px ~300 MB decoded).
// The main thread (agents/logo.mjs, which owns its initWasm there) and the image worker (img-worker.mjs) use the same
// bytes, so V8 compiles the module once per process and a fresh worker starts on code already compiled (different bytes
// cost a cold worker ~200 ms of extra drawing time, measured 2026-11-11 under the test suite's load).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** resvg's wasm memory can never grow past this: a share card, logos and thumbnails up to ~5000 px fit with room to spare. */
export const RESVG_MEMORY_MAX_BYTES = 384 * 1024 * 1024;

const require = createRequire(import.meta.url);
/**
 * The wasm module `bin` with the maximum of the memory it defines set to `maxBytes` (in 64 KB pages, never under its
 * minimum), so that a grow past it fails; `bin` itself when it defines no single plain memory of its own. Only the memory
 * section is rewritten.
 */
export function capWasmMemory(bin, maxBytes) {
  const b = Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength);
  if (b.length < 8 || b.readUInt32LE(0) !== 0x6d736100) return bin;
  const leb = (n) => { const out = []; do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; out.push(x); } while (n); return out; };
  let i = 8;
  const read = () => { let r = 0, s = 1, x; do { x = b[i++]; r += (x & 0x7f) * s; s *= 128; } while (x & 0x80 && i < b.length); return r; };
  while (i < b.length) {
    const at = i, id = b[i++], size = read(), start = i;
    if (id === 5) {
      if (read() !== 1) return bin;
      const flags = b[i++];
      if (flags !== 0 && flags !== 1) return bin; // a shared or 64-bit memory is left as it is
      const min = read(), max = flags ? read() : Infinity;
      if (i !== start + size) return bin;
      const body = Buffer.from([1, 1, ...leb(min), ...leb(Math.max(min, Math.min(max, Math.floor(maxBytes / 65536))))]);
      return Buffer.concat([b.subarray(0, at), Buffer.from([5, ...leb(body.length)]), body, b.subarray(start + size)]);
    }
    i = start + size;
  }
  return bin;
}

const byCap = new Map();
/** The bytes to hand resvg's initWasm: its module with its memory capped at `maxBytes` (the package's own bytes if that cannot be done). */
export function resvgWasm(maxBytes = RESVG_MEMORY_MAX_BYTES) {
  let bin = byCap.get(maxBytes);
  if (!bin) {
    const raw = readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"));
    const capped = capWasmMemory(raw, maxBytes);
    bin = capped !== raw && WebAssembly.validate(capped) ? capped : raw;
    byCap.set(maxBytes, bin);
  }
  return bin;
}
