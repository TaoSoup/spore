// The image work behind GET /api/img?w=, GET /api/logo-sheet and GET /api/card/<mint>.png: a w x w
// cover thumbnail of one logo (png/jpeg/gif through resvg, webp through libwebp + a box downsample),
// the composition of up to 256 such thumbnails into one sheet (RGBA blit, then webp or png), the
// rasterization of a share card's svg (lib/card.mjs) in the vendored Geist faces, and the drawing of
// a downloaded SVG logo into the PNG the image proxy keeps as its original (rasterizeSvg: SVG bytes
// are never stored or served, they can script on our origin). All are CPU-bound for 1-110 ms, so
// ImgWork (lib/meta.mjs) runs this file in a worker thread; the same functions are exported for the
// inline mode (tests, or when a worker cannot be spawned; never for an SVG logo, whose drawing ImgWork
// can only bound by ending the worker). Loaded as a worker with `workerData.role === "img"` the file
// answers `{ id, op, ... }` messages in order, one at a time.
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { encodePng, decodePng, coverBox } from "./png.mjs";
import { RESVG_MEMORY_MAX_BYTES, resvgWasm } from "./resvg-wasm.mjs";
import { decodeWebp, encodeWebp } from "./webp.mjs";
import { fontBuffers, FAMILY } from "./card-fonts.mjs";

/** Thumbnail widths the proxy serves (the map asks for 64 / 128 / 256 px logos); anything else gets the original. */
export const IMAGE_THUMB_SIZES = new Set([64, 128, 256]);
/** Raster types a thumbnail can be made of (sniffed, never declared). */
export const THUMB_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const SHEET_COLS = 16;
export const SHEET_MAX_CELLS = 256;
export const SHEET_WEBP = { quality: 75, method: 2 };
/** An SVG logo is drawn into a PNG that fits this square, keeping its aspect, on a transparent ground (the map's largest thumbnail is 256 px). */
export const SVG_RASTER_PX = 256;
/**
 * An SVG body over this is refused (a logo: the Backpack stock logos are 0.4-2 KB). Parsing is linear (1 MB of shapes:
 * ~80 ms); drawing is not, which SVG_DRAW_MAX_MS bounds.
 */
export const SVG_MAX_BYTES = 1024 * 1024;
/**
 * Entity declarations may add at most this many characters to the document in all (references x value length; an
 * Illustrator export declares its namespaces this way, a few hundred characters). An entity whose value holds a
 * reference or markup (billion laughs) is refused, as is an external or a parameter entity: resvg's parser catches the
 * first and cannot read the second, but a 100 KB value referenced 100k times (10 GB) held it for over a minute.
 */
export const SVG_ENTITY_MAX_CHARS = 64 * 1024;
/**
 * A drawing still running this long after the worker took it up is stopped by ending the worker (resvg cannot be
 * interrupted) and the logo is refused. A logo draws in 1-30 ms; measured 2026-11-11: a 250-byte feMorphology of radius
 * 100000, a blur on each of 10k shapes, a feConvolveMatrix of order 300 and a 100 KB entity referenced 100k times each
 * ran past 60 s (all refused before resvg now: SVG_ELEMENTS, entities), a stroked path of 20k segments takes 2.2 s, 5000
 * opacity groups over a huge rect 40 s (both allowed, both stopped here).
 */
export const SVG_DRAW_MAX_MS = 1500;
/**
 * A worker whose wasm memory (`external`) is past this after a job is replaced once idle: wasm memory never shrinks, and
 * what one job grew it to would be held for good. Measured 2026-11-11, `external` after a job: a logo 8-10 MB, a share card
 * 17, a 256-cell sheet 37, a 2000 px thumbnail 34-51; a 4000 px webp 179 (replaced).
 */
export const WORKER_RECYCLE_BYTES = 128 * 1024 * 1024;
/**
 * A job that grows the process by more than this while it runs on the worker ends that worker at once, whatever the job
 * (ImgWork's watchdog: the main thread samples RSS every few ms); the job fails for good, as one past its deadline. Its
 * deadline bounds time, not memory: a 0.4 KB SVG of two nested pattern tiles took ~3.7 GB in about a second, a 22 KB
 * 1-bit png of 8000 x 8000 px ~300 MB as a thumbnail. Measured 2026-11-11, the peak rise of real jobs: a logo ~0, a card
 * 28 MB, a sheet 51, a 2000 px thumbnail 39, a 4000 px webp 141.
 */
export const WORKER_JOB_MAX_BYTES = 256 * 1024 * 1024;
// resvg's wasm memory can never grow past RESVG_MEMORY_MAX_BYTES (lib/resvg-wasm.mjs): in a worker an allocation past it
// traps at once and the worker is replaced, even while the main thread is too busy to watch it (WORKER_JOB_MAX_BYTES)
export { RESVG_MEMORY_MAX_BYTES };

const resvgMaxBytes = Number(workerData?.resvgMaxBytes) > 0 ? Number(workerData.resvgMaxBytes) : RESVG_MEMORY_MAX_BYTES;
/**
 * One resvg wasm per thread. On the main thread the logo renderer (agents/logo.mjs) owns initWasm and
 * would throw on a second init, so it goes first there; a worker thread initialises its own copy. Both
 * from resvgWasm(): memory capped at RESVG_MEMORY_MAX_BYTES (`workerData.resvgMaxBytes` in a test).
 */
let resvgReady = null;
async function resvg() {
  resvgReady ??= (async () => {
    const mod = await import("@resvg/resvg-wasm");
    if (isMainThread) { try { const { renderLogo } = await import("./agents/logo.mjs"); await renderLogo({ symbol: "A", palette: [], seed: "init" }); } catch { /* the init below decides */ } }
    try { await mod.initWasm(resvgWasm(isMainThread ? RESVG_MEMORY_MAX_BYTES : resvgMaxBytes)); }
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

// ---------------------------------------------------------------- SVG logos
const isSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
/**
 * Where the root element of XML text `t` starts, past a BOM, the XML declaration, comments, processing instructions and
 * a doctype, or -1 when anything else comes first.
 */
function rootAt(t) {
  let i = t.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < t.length && isSpace(t.charCodeAt(i))) i++;
    if (t.startsWith("<?", i)) { const j = t.indexOf("?>", i + 2); if (j < 0) return -1; i = j + 2; }
    else if (t.startsWith("<!--", i)) { const j = t.indexOf("-->", i + 4); if (j < 0) return -1; i = j + 3; }
    else if (t.startsWith("<!DOCTYPE", i)) {
      const j = doctypeEnd(t, i + 9);
      if (j < 0) return -1;
      i = j;
    } else return t.charCodeAt(i) === 0x3c ? i : -1;
  }
}
/** The index just past the doctype whose body starts at `i` (quoted strings, its internal subset and the comments and processing instructions in it skipped), or -1. */
function doctypeEnd(t, i) {
  let subset = false;
  for (; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === "'") { const j = t.indexOf(c, i + 1); if (j < 0) return -1; i = j; }
    else if (subset && t.startsWith("<!--", i)) { const j = t.indexOf("-->", i + 4); if (j < 0) return -1; i = j + 2; }
    else if (subset && t.startsWith("<?", i)) { const j = t.indexOf("?>", i + 2); if (j < 0) return -1; i = j + 1; }
    else if (c === "[") subset = true;
    else if (c === "]") subset = false;
    else if (c === ">" && !subset) return i + 1;
  }
  return -1;
}
const SVG_ROOT_RE = /^<(?:[A-Za-z_][\w.-]*:)?svg[\s/>]/;
/** Is `bytes` an XML document whose root element is <svg> (what the proxy draws into a PNG whatever the declared type)? */
export function isSvgDocument(bytes) {
  if (!bytes?.byteLength) return false;
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 64 * 1024)).toString("utf8");
  const i = rootAt(head);
  return i >= 0 && SVG_ROOT_RE.test(head.slice(i, i + 80));
}
const ENTITY_DECL_RE = /<!ENTITY\s+([^\s"'%<>&;]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g;
const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * The SVG elements a logo may hold; anything else is refused before resvg sees the document (review 2026-11-11). Left out
 * on purpose: pattern, mask, filter and every fe* (resvg allocates a pixmap of each one's own size: two nested
 * 22000-unit pattern tiles in 0.4 KB took ~3.7 GB, and a blur or a morphology ran for minutes), image (an embedded raster
 * is decoded whole, an embedded SVG cannot be checked from here), foreignObject, script, marker, textPath, a. An
 * unprefixed element is held to this list whatever its namespace; one whose prefix names another namespace (editor
 * metadata: rdf:RDF, sodipodi:namedview, i:pgf) is skipped by resvg with all it holds, and is refused only when its
 * name is that of an SVG element left out here (SVG_REFUSED), as what it holds is checked all the same.
 */
export const SVG_ELEMENTS = new Set(["svg", "g", "defs", "symbol", "use", "switch", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "linearGradient", "radialGradient", "stop", "clipPath", "text", "tspan", "style", "title", "desc", "metadata"]);
const SVG_REFUSED = new Set(["pattern", "mask", "filter", "image", "foreignObject", "script", "marker", "textPath", "tref", "a"]);
/** Elements may nest this deep, the root included (32 nested opacity groups make resvg allocate ~95 MB of layers; real logos nest a few levels). */
export const SVG_MAX_DEPTH = 32;
/** A logo may hold at most this many elements (the Backpack stock logos hold 2-6; an editor's export a few hundred). */
export const SVG_MAX_ELEMENTS = 10_000;
/** A logo's <text> may hold at most this many characters in all (a wordmark holds a few dozen; 880 KB of text took resvg past 256 MB). */
export const SVG_MAX_TEXT_CHARS = 2000;
const PREDEFINED = new Map([["lt", "<"], ["gt", ">"], ["amp", "&"], ["apos", "'"], ["quot", '"']]);
const NAME_RE = /[^\s/>="'<]+/y;
const ATTR_RE = /([^\s/>="'<]+)\s*=\s*(["'])/y;
const NOT_WELL_FORMED = "not well-formed";
const printable = (s) => s.replace(/[^\w.-]/g, "?").slice(0, 40);
const countOf = (t, s) => { let n = 0; for (let i = t.indexOf(s); i >= 0; i = t.indexOf(s, i + s.length)) n++; return n; };
/** `s` with its character and entity references replaced (`entities`: the document's plain internal ones), or null when one is neither. */
function unref(s, entities) {
  let i = s.indexOf("&");
  if (i < 0) return s;
  let out = s.slice(0, i);
  while (i >= 0) {
    const j = s.indexOf(";", i + 1);
    if (j < 0 || j - i > 256) return null;
    const ref = s.slice(i + 1, j);
    let v;
    if (/^#(?:[0-9]{1,7}|[xX][0-9a-fA-F]{1,6})$/.test(ref)) {
      const cp = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (cp > 0x10ffff) return null;
      v = String.fromCodePoint(cp);
    } else v = PREDEFINED.get(ref) ?? entities.get(ref);
    if (v === undefined) return null;
    const k = s.indexOf("&", j + 1);
    out += v + s.slice(j + 1, k < 0 ? s.length : k);
    i = k;
  }
  return out;
}
/** Why a stylesheet (a <style> element's text, a style attribute) is refused, or null: resvg draws `filter: blur(...)` and the like without any <filter> element. */
function cssProblem(css) {
  let plain = "", k = 0;
  for (;;) { // comments out, in one pass (an unclosed one runs to the end)
    const a = css.indexOf("/*", k);
    if (a < 0) { plain += css.slice(k); break; }
    plain += `${css.slice(k, a)} `;
    const b = css.indexOf("*/", a + 2);
    if (b < 0) break;
    k = b + 2;
  }
  return /filter\s*:/i.test(plain) ? "it uses a filter" : null;
}
/**
 * Why the document `t`, whose root element starts at `i`, is refused, or null. One tag-level pass (comments, CDATA,
 * processing instructions, start and end tags with their quoted attributes; indexOf and anchored patterns only, so linear)
 * holds every element to SVG_ELEMENTS, SVG_MAX_DEPTH and SVG_MAX_ELEMENTS, every href to a reference within the document
 * (`#id`), the text in <text> to SVG_MAX_TEXT_CHARS, and refuses a filter as an attribute or in a stylesheet. Attribute
 * values, stylesheet and <text> content are read with their character and entity references replaced, as resvg reads
 * them, so no spelling hides an href or a filter. What this pass cannot read as XML is refused (resvg would not draw it
 * either). ~50 ms for the worst 1 MB measured (166k attributes); 2-25 ms for most.
 */
function bodyProblem(t, i, entities) {
  const stack = []; // open elements: { name, ns: the prefixes it binds (or null), css: its text when it is a stylesheet (else null), text: within a <text> }
  let count = 0, rooted = false, textChars = 0;
  const nsOf = (prefix) => { for (let k = stack.length - 1; k >= 0; k--) { const v = stack[k].ns?.get(prefix); if (v !== undefined) return v; } return undefined; };
  /** Text content `s` of the open element `top` (references replaced when `decode`): a stylesheet's is kept, a <text>'s counted. */
  const content = (top, s, decode) => {
    if (top.css === null && !top.text) return null;
    const v = decode ? unref(s, entities) : s;
    if (v === null) return NOT_WELL_FORMED;
    if (top.css !== null) top.css += v;
    if (top.text && (textChars += v.length) > SVG_MAX_TEXT_CHARS) return `it holds over ${SVG_MAX_TEXT_CHARS} characters of text`;
    return null;
  };
  for (;;) {
    const lt = t.indexOf("<", i), end = lt < 0 ? t.length : lt;
    if (end > i) {
      const top = stack[stack.length - 1];
      if (top) { const why = content(top, t.slice(i, end), true); if (why) return why; }
      else if (/\S/.test(t.slice(i, end))) return NOT_WELL_FORMED; // text after the root
    }
    if (lt < 0) break;
    if (t.startsWith("<!--", lt)) { const e = t.indexOf("-->", lt + 4); if (e < 0) return NOT_WELL_FORMED; i = e + 3; continue; }
    if (t.startsWith("<?", lt)) { const e = t.indexOf("?>", lt + 2); if (e < 0) return NOT_WELL_FORMED; i = e + 2; continue; }
    if (t.startsWith("<![CDATA[", lt)) {
      const e = t.indexOf("]]>", lt + 9), top = stack[stack.length - 1];
      if (e < 0 || !top) return NOT_WELL_FORMED;
      const why = content(top, t.slice(lt + 9, e), false);
      if (why) return why;
      i = e + 3; continue;
    }
    if (t[lt + 1] === "!") return NOT_WELL_FORMED; // a declaration past the prolog
    if (t[lt + 1] === "/") {
      const e = t.indexOf(">", lt + 2), top = stack.pop();
      if (e < 0 || !top || t.slice(lt + 2, e).trimEnd() !== top.name) return NOT_WELL_FORMED;
      if (top.css !== null) { const why = cssProblem(top.css); if (why) return why; }
      i = e + 1; continue;
    }
    if (rooted && !stack.length) return NOT_WELL_FORMED; // a second root
    NAME_RE.lastIndex = lt + 1;
    const name = NAME_RE.exec(t)?.[0];
    if (!name) return NOT_WELL_FORMED;
    let j = lt + 1 + name.length, selfClosed = false;
    const attrs = [];
    for (;;) {
      const s0 = j;
      while (j < t.length && isSpace(t.charCodeAt(j))) j++;
      if (t.startsWith("/>", j)) { selfClosed = true; j += 2; break; }
      if (t[j] === ">") { j++; break; }
      if (j === s0 || j >= t.length) return NOT_WELL_FORMED; // attributes are set apart by white space
      ATTR_RE.lastIndex = j;
      const m = ATTR_RE.exec(t);
      if (!m) return NOT_WELL_FORMED;
      const from = j + m[0].length, to = t.indexOf(m[2], from);
      if (to < 0) return NOT_WELL_FORMED;
      const value = unref(t.slice(from, to), entities);
      if (value === null || t.slice(from, to).includes("<")) return NOT_WELL_FORMED;
      attrs.push([m[1], value]);
      j = to + 1;
    }
    let ns = null;
    for (const [a, v] of attrs) if (a === "xmlns" || a.startsWith("xmlns:")) (ns ??= new Map()).set(a.slice(6), v);
    const el = { name, ns, css: null, text: !!stack[stack.length - 1]?.text };
    stack.push(el); rooted = true;
    if (stack.length > SVG_MAX_DEPTH) return `it nests elements deeper than ${SVG_MAX_DEPTH}`;
    if (++count > SVG_MAX_ELEMENTS) return `it has over ${SVG_MAX_ELEMENTS} elements`;
    const c = name.indexOf(":"), local = name.slice(c + 1);
    const svg = c < 0 || nsOf(name.slice(0, c)) === SVG_NS;
    if (svg ? !SVG_ELEMENTS.has(local) : SVG_REFUSED.has(local) || /^fe[A-Z]/.test(local)) return `it uses <${printable(local)}>`;
    for (const [a, v] of attrs) {
      if (a === "xmlns" || a.startsWith("xmlns:")) continue;
      const an = a.slice(a.indexOf(":") + 1); // any namespace: what another one holds is not read by resvg, and is checked all the same
      if (an === "href" && !/^\s*#/.test(v)) return "it links outside itself";
      if (an === "filter") return "it uses a filter";
      if (an === "style") { const why = cssProblem(v); if (why) return why; }
    }
    // resvg reads every element named style as a stylesheet, whatever its namespace
    if (local === "style") el.css = "";
    if (local === "text") el.text = true;
    if (selfClosed) stack.pop();
    i = j;
  }
  return stack.length ? NOT_WELL_FORMED : null;
}
/**
 * Why the SVG text `t` is refused before resvg sees it, or null: not an <svg> document, entities (SVG_ENTITY_MAX_CHARS),
 * then what a logo does not need (bodyProblem: SVG_ELEMENTS, SVG_MAX_DEPTH, SVG_MAX_ELEMENTS, a link out, a filter).
 */
function svgProblem(t) {
  const i = rootAt(t);
  if (i < 0 || !SVG_ROOT_RE.test(t.slice(i, i + 80))) return "not an svg document";
  // declarations are looked for in all that comes before the root (wherever a parser might end the doctype), and every
  // one must be a plain internal entity; references count from the root on (only content expands them)
  const prolog = t.slice(0, i), declared = countOf(prolog, "<!ENTITY"), entities = new Map();
  if (declared) {
    let plain = 0, chars = 0;
    const body = t.slice(i);
    for (const m of prolog.matchAll(ENTITY_DECL_RE)) {
      plain++;
      const value = m[2] ?? m[3];
      if (/[&<%]/.test(value)) return "an entity holds references or markup";
      if (!entities.has(m[1])) entities.set(m[1], value); // the first declaration binds
      chars += countOf(body, `&${m[1]};`) * value.length;
      if (chars > SVG_ENTITY_MAX_CHARS) return `entities expand past ${SVG_ENTITY_MAX_CHARS / 1024} KB`;
    }
    if (plain !== declared) return "external or parameter entities";
  }
  return bodyProblem(t, i, entities);
}
const freeQuietly = (o) => { try { o?.free?.(); } catch { /* after a wasm trap the handle is poisoned: the worker is replaced (ImgWork) */ } };
/**
 * PNG bytes of an SVG logo fitted into SVG_RASTER_PX x SVG_RASTER_PX (aspect kept, transparent ground), or a throw saying
 * why it cannot be drawn: over SVG_MAX_BYTES, not an SVG, entities, an element or a link a logo does not need, a filter
 * (svgProblem), a parse or render error, no size, nothing drawn. resvg loads nothing from outside: no system fonts (text
 * is set in the vendored Geist faces), no image (refused), the wasm build has no file access, and the text is handed over
 * as a string, so a gzip body (svgz) is never inflated. Event handlers and animation are not part of what resvg draws. The
 * time and memory it may take are bounded by the caller (SVG_DRAW_MAX_MS, WORKER_JOB_MAX_BYTES: ImgWork) and by resvg's
 * capped memory in a worker (RESVG_MEMORY_MAX_BYTES).
 */
export async function rasterizeSvg(bytes) {
  if (!bytes?.byteLength) throw new Error("svg: empty");
  if (bytes.byteLength > SVG_MAX_BYTES) throw new Error(`svg: over ${SVG_MAX_BYTES / 1024} KB`);
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const why = svgProblem(text);
  if (why) throw new Error(`svg: ${why}`);
  const { Resvg } = await resvg();
  const font = /<(?:[\w.-]+:)?text[\s>]/.test(text)
    ? { fontBuffers: fontBuffers(), loadSystemFonts: false, defaultFontFamily: FAMILY.sans, sansSerifFamily: FAMILY.sans, serifFamily: FAMILY.sans, cursiveFamily: FAMILY.sans, fantasyFamily: FAMILY.sans, monospaceFamily: FAMILY.mono }
    : { loadSystemFonts: false };
  // a parse or render error (a trap included: `cause` keeps it, the worker is replaced for it) is the logo's
  try { return drawSvg(Resvg, text, font); }
  catch (e) {
    if (String(e?.message).startsWith("svg: ")) throw e;
    throw new Error(`svg: cannot be drawn (${String(e?.message ?? e).slice(0, 120)})`, { cause: e });
  }
}
function drawSvg(Resvg, text, font) {
  const open = (mode) => new Resvg(text, { fitTo: { mode, value: SVG_RASTER_PX }, font });
  // the size getters are the document's own size, rounded: a tall one is fitted by its height (a wide one by its width
  // would be 256 px wide and any height); a near-square one the rounding misjudged is fitted again the other way
  let mode = "width", r = open(mode);
  try {
    if (!(r.width >= 1 && r.height >= 1)) throw new Error(`svg: no size (${r.width} x ${r.height})`);
    if (r.height > r.width) { freeQuietly(r); r = null; mode = "height"; r = open(mode); }
    for (let pass = 0; ; pass++) {
      const out = r.render();
      try {
        const w = out.width, h = out.height;
        if (w < 1 || h < 1) throw new Error(`svg: drew ${w} x ${h}`);
        if (w > SVG_RASTER_PX || h > SVG_RASTER_PX) {
          if (pass) throw new Error(`svg: drew ${w} x ${h}`);
          freeQuietly(r); r = null; mode = mode === "width" ? "height" : "width"; r = open(mode);
          continue; // `out` is freed on the way (finally)
        }
        // resvg skips what it cannot draw without an error: a fully transparent result is no logo
        if (!anyAlpha(out.pixels)) throw new Error("svg: draws nothing");
        return Buffer.from(out.asPng());
      } finally { freeQuietly(out); }
    }
  } finally { freeQuietly(r); }
}

/** Runs one `{ op, ... }` request (the worker protocol and the inline mode share it). */
export async function runOp(msg) {
  if (msg.op === "thumb") { const bytes = await renderThumb(msg.bytes, msg.type, msg.w); return { bytes, type: "image/png" }; }
  if (msg.op === "sheet") return composeSheet({ cells: msg.cells, cols: msg.cols, cell: msg.cell, format: msg.format });
  if (msg.op === "card") return { bytes: await renderCardSvg(String(msg.svg ?? "")), type: "image/png" };
  if (msg.op === "svg") return { bytes: await rasterizeSvg(msg.bytes), type: "image/png" };
  throw new Error(`unknown op ${msg.op}`);
}

// A trap inside resvg (a failed allocation, an "unreachable") surfaces as a RuntimeError, or as the poisoned handle's
// "recursive use of an object" when a finally block frees it: the instance and its grown memory are not to be trusted
const trapped = (e) => !!e && (e instanceof WebAssembly.RuntimeError || /recursive use of an object|unsafe aliasing/.test(String(e.message ?? e)) || (e.cause !== e && trapped(e.cause)));
const recycleBytes = Number(workerData?.recycleBytes) > 0 ? Number(workerData.recycleBytes) : WORKER_RECYCLE_BYTES;
const overMemory = () => { try { return process.memoryUsage().external > recycleBytes; } catch { return false; } };
/** Why this worker asks to be replaced once idle ("trap", "memory"), or "" (ImgWork logs it). */
const recycleWhy = (e) => (e && trapped(e) ? "trap" : overMemory() ? "memory" : "");

if (!isMainThread && parentPort && workerData?.role === "img") {
  let chain = Promise.resolve();
  parentPort.on("message", (msg) => {
    chain = chain.then(async () => {
      // a job with a deadline (an SVG logo) says when it starts: ImgWork times it from here, not from the queue
      if (msg.deadlineMs) parentPort.postMessage({ id: msg.id, started: true });
      try {
        const r = await runOp(msg);
        const bytes = r.bytes ? new Uint8Array(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength) : null;
        // the result buffer is handed over, not copied (it was made here and is not used again)
        parentPort.postMessage({ id: msg.id, ok: true, bytes, type: r.type, failed: r.failed ?? [], recycle: recycleWhy(null) }, bytes && bytes.buffer.byteLength === bytes.byteLength ? [bytes.buffer] : []);
      } catch (e) {
        parentPort.postMessage({ id: msg.id, ok: false, error: String(e?.message ?? e).slice(0, 200), recycle: recycleWhy(e) });
      }
    });
  });
}
