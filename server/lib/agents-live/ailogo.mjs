// A logo drawn by the model (DESIGN §13.1; owner 2026-10-19: the agent does name, ticker and logo).
// The model answers with an SVG document; it is sanitised to a strict vector subset (shapes, paths,
// gradients, text with no external fonts; no scripts, no links, no images, no foreignObject, no
// external references) and rasterised to a 512×512 PNG with resvg (WebAssembly, no native code).
// Anything that fails a check falls back to the deterministic template logo so a launch is never
// blocked on art.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderLogo, LOGO_SIZE, pngSize } from "../agents/logo.mjs";

const require = createRequire(import.meta.url);

export const SVG_MAX_BYTES = 24 * 1024;
const ALLOWED_TAGS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "title", "desc"]);
const BANNED_RE = /<\s*(script|foreignobject|image|use|iframe|object|embed|link|style|animate|animatetransform|animatemotion|set|a)\b/i;
const EXTERNAL_RE = /(xlink:href|href)\s*=\s*["'](?!#)/i;       // only in-document references (#gradient)
const EVENT_RE = /\son[a-z]+\s*=/i;
const URL_FUNC_RE = /url\(\s*["']?\s*(?!#)/i;                      // fill="url(#id)" is fine; url(http…) is not
const ENTITY_RE = /<!(?:DOCTYPE|ENTITY)/i;

export class LogoError extends Error { constructor(message) { super(message); this.name = "LogoError"; } }

/** The SVG text with everything outside the allowed subset refused (throws) — never rewritten silently. */
export function sanitizeSvg(text) {
  if (typeof text !== "string") throw new LogoError("no SVG");
  const svg = text.trim();
  if (Buffer.byteLength(svg) > SVG_MAX_BYTES) throw new LogoError(`SVG over ${SVG_MAX_BYTES} bytes`);
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) throw new LogoError("not one <svg> document");
  if (ENTITY_RE.test(svg)) throw new LogoError("SVG declares entities");
  if (BANNED_RE.test(svg)) throw new LogoError("SVG uses a banned element");
  if (EXTERNAL_RE.test(svg)) throw new LogoError("SVG references something outside itself");
  if (EVENT_RE.test(svg)) throw new LogoError("SVG has event handlers");
  if (URL_FUNC_RE.test(svg)) throw new LogoError("SVG loads an external url()");
  for (const m of svg.matchAll(/<\s*\/?\s*([a-zA-Z][\w:-]*)/g)) {
    const tag = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) throw new LogoError(`SVG element <${tag}> is not allowed`);
  }
  return svg;
}

/** Pulls the SVG out of a model answer (bare, fenced, or inside a JSON string field `svg`). */
export function extractSvg(answer) {
  const text = typeof answer === "string" ? answer : typeof answer?.svg === "string" ? answer.svg : "";
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) throw new LogoError("answer has no <svg>");
  return m[0];
}

let ready = null;
async function resvg() {
  if (!ready) {
    ready = (async () => {
      // One wasm instance per process and initWasm() may run only once: let the template renderer
      // (lib/agents/logo.mjs) own that initialisation, then share its module.
      await renderLogo({ symbol: "A", palette: [], seed: "init" }).catch(() => {});
      const mod = await import("@resvg/resvg-wasm");
      try { await mod.initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))); }
      catch (e) { if (!/already initiali[sz]ed/i.test(String(e?.message ?? e))) throw e; }
      return mod;
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

/** 512×512 PNG from sanitised SVG text; throws when resvg cannot parse it or the output is blank-sized. */
export async function rasterize(svg) {
  const { Resvg } = await resvg();
  let img;
  try { img = new Resvg(svg, { fitTo: { mode: "width", value: LOGO_SIZE }, font: { loadSystemFonts: false, defaultFontFamily: "sans-serif" } }); }
  catch (e) { throw new LogoError(`SVG does not parse: ${String(e?.message ?? e).slice(0, 120)}`); }
  try {
    const png = Buffer.from(img.render().asPng());
    const size = pngSize(png);
    if (!size || size.width !== LOGO_SIZE) throw new LogoError("rasteriser produced no 512 px image");
    return png;
  } finally { img.free(); }
}

export const LOGO_PROMPT = (idea, profile) => [
  { role: "system", content: "You draw small, bold, flat vector logos for internet coins. Answer with ONE complete <svg> document and nothing else: viewBox=\"0 0 512 512\", only these elements: svg g path rect circle ellipse line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask title. No images, no scripts, no links, no external fonts or references, no style elements; inline fill/stroke attributes only. Under 12 KB. A filled background shape, one clear central motif, at most two words of text." },
  { role: "user", content: `Coin: ${idea.name} ($${idea.symbol}). Theme words: ${(profile?.themes ?? []).join(", ") || "playful"}. Tone: ${profile?.tone ?? "playful"}. Palette: ${(profile?.palette ?? []).join(", ") || "#111111, #d7ff4a"}. Avoid: ${(profile?.avoid ?? []).join("; ") || "real people, brands"}.` },
];

/**
 * The logo for `idea`: asks `llm` (lib/agents/llm.mjs or ./pay.mjs shape) for an SVG, sanitises and
 * rasterises it; on any failure (or no model) renders the template logo. Returns
 * `{ png, svg|null, source: "model"|"template", error|null }`.
 */
export async function drawLogo(idea, profile, { llm = null, image = null, seed = "", log = console } = {}) {
  let error = null;
  // 1. A real raster logo from the image model (imagegen.mjs), when configured.
  if (image?.available) {
    try {
      const { IMAGE_PROMPT } = await import("./imagegen.mjs");
      const png = await image.generate(IMAGE_PROMPT(idea, profile));
      return { png, svg: null, source: "image", error: null };
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 160);
      log.warn?.(`agents: image logo for $${idea.symbol} failed (${error}); trying the model's SVG`);
    }
  }
  // 2. An SVG the language model draws.
  if (llm?.available) {
    try {
      const raw = await llm.chatText?.(LOGO_PROMPT(idea, profile), { maxTokens: 2500, temperature: 0.9 }) ?? await llm.chatJson(LOGO_PROMPT(idea, profile), { maxTokens: 2500, temperature: 0.9 });
      const svg = sanitizeSvg(extractSvg(raw));
      const png = await rasterize(svg);
      return { png, svg, source: "model", error: null };
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 160);
      log.warn?.(`agents: model logo for $${idea.symbol} rejected (${error}); using the template`);
    }
  }
  const png = await renderLogo({ symbol: idea.symbol, palette: profile?.palette ?? [], seed });
  return { png, svg: null, source: "template", error };
}
