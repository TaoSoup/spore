// The image work behind GET /api/img?w=, GET /api/logo-sheet and GET /api/card/<mint>.png: a w x w
// cover thumbnail of one logo (png/jpeg/gif through resvg, webp through libwebp + a box downsample),
// the composition of up to 256 such thumbnails into one sheet (RGBA blit, then webp or png), and the
// rasterization of a share card's svg (lib/card.mjs) in the vendored Geist faces. All three are
// CPU-bound for 1-110 ms, so ImgWork (lib/meta.mjs) runs this file in a worker thread; the same
// functions are exported for the inline mode (tests, or when a worker cannot be spawned). Loaded as
// a worker with `workerData.role === "img"` the file answers `{ id, op, ... }` messages in order,
// one at a time.
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { encodePng, decodePng, coverBox } from "./png.mjs";
import { decodeWebp, encodeWebp } from "./webp.mjs";
import { fontBuffers, FAMILY } from "./card-fonts.mjs";

/** Thumbnail widths the proxy serves (the map asks for 64 / 128 / 256 px logos); anything else gets the original. */
export const IMAGE_THUMB_SIZES = new Set([64, 128, 256]);
/** Raster types a thumbnail can be made of (sniffed, never declared). */
export const THUMB_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const SHEET_COLS = 16;
export const SHEET_MAX_CELLS = 256;
export const SHEET_WEBP = { quality: 75, method: 2 };

const require = createRequire(import.meta.url);
/**
 * One resvg wasm per thread. On the main thread the logo renderer (agents/logo.mjs) owns initWasm and
 * would throw on a second init, so it goes first there; a worker thread initialises its own copy.
 */
let resvgReady = null;
async function resvg() {
  resvgReady ??= (async () => {
    const mod = await import("@resvg/resvg-wasm");
    if (isMainThread) { try { const { renderLogo } = await import("./agents/logo.mjs"); await renderLogo({ symbol: "A", palette: [], seed: "init" }); } catch { /* the init below decides */ } }
    try { await mod.initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))); }
    catch (e) { if (!/already initiali[sz]ed/i.test(String(e?.message ?? e))) throw e; }
    return mod;
  })();
  resvgReady.catch(() => { resvgReady = null; });
  return resvgReady;
}

const anyAlpha = (px) => { for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return true; return false; };

/**
 * PNG bytes of a w x w centre-cropped (cover) thumbnail of a raster image, or null when it cannot be
 * drawn (unknown type or size, undecodable webp, a fully transparent result). An animated webp is drawn
 * from its first frame (decodeWebp).
 */
export async function renderThumb(bytes, type, w) {
  if (!THUMB_TYPES.has(type) || !IMAGE_THUMB_SIZES.has(w) || !bytes?.byteLength) return null;
  if (type === "image/webp") {
    const im = await decodeWebp(bytes);
    if (!im) return null;
    const rgba = coverBox(Buffer.from(im.data.buffer, im.data.byteOffset, im.width * im.height * 4), im.width, im.height, w);
    return anyAlpha(rgba) ? encodePng(rgba, w, w, { level: 6 }) : null;
  }
  const { Resvg } = await resvg();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 ${w} ${w}"><image x="0" y="0" width="${w}" height="${w}" preserveAspectRatio="xMidYMid slice" href="data:${type};base64,${Buffer.from(bytes).toString("base64")}"/></svg>`;
  const r = new Resvg(svg, { fitTo: { mode: "original" }, font: { loadSystemFonts: false } });
  try {
    const out = r.render();
    try {
      // resvg skips an image it cannot decode without an error: a fully transparent result is a failure, not a logo
      if (out.width !== w || out.height !== w || !anyAlpha(out.pixels)) return null;
      return Buffer.from(out.asPng());
    } finally { out.free?.(); }
  } finally { r.free(); }
}

/**
 * One sheet of `cells` (PNG thumbnails of `cell` px, or null for an empty cell), `cols` per row, as
 * `{ bytes, type, failed }`: cell i sits at ((i % cols) * cell, floor(i / cols) * cell); an empty or
 * undecodable cell stays fully transparent (the undecodable ones are listed in `failed` so the
 * caller can drop the bad file). `format` is "webp" (lossy, SHEET_WEBP) or "png" (lossless).
 */
export async function composeSheet({ cells, cols = SHEET_COLS, cell = 64, format = "webp" }) {
  const n = cells.length;
  if (n < 1 || n > SHEET_MAX_CELLS) throw new Error("sheet: 1 to 256 cells");
  const rows = Math.ceil(n / cols), W = cols * cell, H = rows * cell;
  const sheet = Buffer.alloc(W * H * 4);
  const failed = [];
  for (let i = 0; i < n; i++) {
    const png = cells[i];
    if (!png) continue;
    let im;
    try { im = decodePng(Buffer.isBuffer(png) ? png : Buffer.from(png.buffer, png.byteOffset, png.byteLength)); } catch { failed.push(i); continue; }
    if (im.w !== cell || im.h !== cell) { failed.push(i); continue; }
    const x0 = (i % cols) * cell, y0 = Math.floor(i / cols) * cell, stride = cell * 4;
    for (let y = 0; y < cell; y++) im.rgba.copy(sheet, ((y0 + y) * W + x0) * 4, y * stride, (y + 1) * stride);
  }
  if (format === "png") return { bytes: encodePng(sheet, W, H, { level: 6 }), type: "image/png", failed };
  return { bytes: await encodeWebp(sheet, W, H, SHEET_WEBP), type: "image/webp", failed };
}

/**
 * PNG bytes of a share card's svg (lib/card.mjs cardSvg, which carries its own width and height) set
 * in the vendored Geist faces; the fonts are read once per thread. 35-110 ms of CPU per card.
 */
export async function renderCardSvg(svg) {
  const { Resvg } = await resvg();
  const r = new Resvg(svg, { fitTo: { mode: "original" }, font: { fontBuffers: fontBuffers(), loadSystemFonts: false, defaultFontFamily: FAMILY.sans } });
  try { const out = r.render(); try { return Buffer.from(out.asPng()); } finally { out.free?.(); } } finally { r.free(); }
}

/** Runs one `{ op, ... }` request (the worker protocol and the inline mode share it). */
export async function runOp(msg) {
  if (msg.op === "thumb") { const bytes = await renderThumb(msg.bytes, msg.type, msg.w); return { bytes, type: "image/png" }; }
  if (msg.op === "sheet") return composeSheet({ cells: msg.cells, cols: msg.cols, cell: msg.cell, format: msg.format });
  if (msg.op === "card") return { bytes: await renderCardSvg(String(msg.svg ?? "")), type: "image/png" };
  throw new Error(`unknown op ${msg.op}`);
}

if (!isMainThread && parentPort && workerData?.role === "img") {
  let chain = Promise.resolve();
  parentPort.on("message", (msg) => {
    chain = chain.then(async () => {
      try {
        const r = await runOp(msg);
        const bytes = r.bytes ? new Uint8Array(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength) : null;
        // the result buffer is handed over, not copied (it was made here and is not used again)
        parentPort.postMessage({ id: msg.id, ok: true, bytes, type: r.type, failed: r.failed ?? [] }, bytes && bytes.buffer.byteLength === bytes.byteLength ? [bytes.buffer] : []);
      } catch (e) {
        parentPort.postMessage({ id: msg.id, ok: false, error: String(e?.message ?? e).slice(0, 200) });
      }
    });
  });
}
