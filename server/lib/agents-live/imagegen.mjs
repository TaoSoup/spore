// Real raster logos for agent coins (owner 2026-10-19: "it does not make the logo for the memecoin").
// NanoGPT's OpenAI-compatible image endpoint (POST …/v1/images/generations, the same account key as
// the chat models) draws one square image per coin — flux-3 klein at 768×768 costs $0.008 — and the
// result is fitted into the 512×512 PNG every coin logo on Spore is (resvg rasterises an SVG wrapper
// with the image embedded; no native image library). Pure data in, PNG out; nothing on-chain.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { LOGO_SIZE, pngSize, renderLogo } from "../agents/logo.mjs";

const require = createRequire(import.meta.url);
export const DEFAULT_IMAGE_URL = "https://api.nano-gpt.com/v1/images/generations";
export const DEFAULT_IMAGE_MODEL = "blackforestlabs/flux-3/klein/text-to-image";
export const DEFAULT_IMAGE_SIZE = "768x768";
export const DEFAULT_IMAGE_USD = 0.008;
const TIMEOUT_MS = 90_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export class ImageError extends Error { constructor(message) { super(message); this.name = "ImageError"; } }

/** The image endpoint that goes with a chat endpoint on the same provider, or null when unknown. */
export function imageUrlFor(chatUrl) {
  try { const h = new URL(String(chatUrl)).hostname; if (/nano-gpt\.com$/i.test(h)) return DEFAULT_IMAGE_URL; } catch { /* unknown */ }
  return null;
}

let ready = null;
async function resvg() {
  if (!ready) {
    ready = (async () => {
      await renderLogo({ symbol: "A", palette: [], seed: "init" }).catch(() => {}); // the template renderer owns initWasm()
      const mod = await import("@resvg/resvg-wasm");
      try { await mod.initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))); } catch (e) { if (!/already initiali[sz]ed/i.test(String(e?.message ?? e))) throw e; }
      return mod;
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

/** Fits a PNG or JPEG into the 512×512 logo square (cover crop, centred). */
export async function fitLogo(bytes, mime = "image/png") {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new ImageError("empty image");
  const { Resvg } = await resvg();
  const href = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${LOGO_SIZE}" height="${LOGO_SIZE}" viewBox="0 0 ${LOGO_SIZE} ${LOGO_SIZE}"><rect width="${LOGO_SIZE}" height="${LOGO_SIZE}" fill="#0b0f0c"/><image xlink:href="${href}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" preserveAspectRatio="xMidYMid slice"/></svg>`;
  const img = new Resvg(svg, { fitTo: { mode: "width", value: LOGO_SIZE }, font: { loadSystemFonts: false } });
  try {
    const png = Buffer.from(img.render().asPng());
    const size = pngSize(png);
    if (!size || size.width !== LOGO_SIZE) throw new ImageError("rasteriser produced no 512 px image");
    return png;
  } finally { img.free(); }
}

/** People briefs (DESIGN §13.3): a caricature of the person the coin is named after. */
export const PEOPLE_IMAGE_PROMPT = (name) => `a bold meme-style caricature portrait of ${String(name).trim()}, head and shoulders, flat vivid colours, no text, no logo`;

export const IMAGE_PROMPT = (idea, profile) => idea?.mode === "people" ? PEOPLE_IMAGE_PROMPT(idea.name) :
  `Meme coin logo for "${idea.name}" ($${idea.symbol}). ${idea.description ? idea.description.slice(0, 160) + ". " : ""}Style: bold flat cartoon mascot or icon, centered, thick outlines, vivid colours (${(profile?.palette ?? []).join(", ") || "lime green, black, white"}), simple clean background, square crop, no text, no letters, no watermark, no real people, no brand logos.`;

/**
 * `createImageGen({ url, keyFile, model, size, usdPerImage })` → `{ available, model, generate(prompt) → PNG, costUsd, snapshot }`.
 * The key is read once into a closure and only ever sent as the Authorization header.
 */
export function createImageGen({ url = null, keyFile = null, keyText = null, model = DEFAULT_IMAGE_MODEL, size = DEFAULT_IMAGE_SIZE, usdPerImage = DEFAULT_IMAGE_USD, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, log = console } = {}) {
  let key = keyText;
  if (key == null && keyFile) { try { key = readFileSync(keyFile, "utf8").trim(); } catch (e) { log.warn?.(`agents: image key file unreadable (${e.code ?? "error"}); logos fall back to the model's SVG or the template`); key = null; } }
  const available = !!(url && key && model);
  const state = { calls: 0, failures: 0, lastError: null };

  async function generate(prompt) {
    if (!available) throw new ImageError("image generation not configured");
    state.calls++;
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model, prompt, n: 1, size, response_format: "b64_json" }), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      const text = await res.text();
      if (text.length > MAX_IMAGE_BYTES * 1.4) throw new ImageError("image answer too large");
      if (res.status < 200 || res.status >= 300) throw new ImageError(`image provider answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the key)" : res.status === 402 ? " (balance)" : ""}`);
      let json; try { json = JSON.parse(text); } catch { throw new ImageError("image answer is not JSON"); }
      const item = json?.data?.[0];
      let bytes = null, mime = "image/png";
      if (item?.b64_json) bytes = Buffer.from(item.b64_json, "base64");
      else if (item?.url) {
        const u = new URL(item.url); if (u.protocol !== "https:") throw new ImageError("image url is not https");
        const r2 = await fetchImpl(u.href, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
        if (!r2.ok) throw new ImageError(`image download HTTP ${r2.status}`);
        mime = /jpe?g/i.test(r2.headers?.get?.("content-type") ?? "") ? "image/jpeg" : "image/png";
        bytes = Buffer.from(await r2.arrayBuffer());
      }
      if (!bytes?.length) throw new ImageError("image answer carries no image");
      if (bytes.length > MAX_IMAGE_BYTES) throw new ImageError("image over the size limit");
      if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = "image/jpeg";
      return fitLogo(bytes, mime);
    } catch (e) {
      state.failures++; state.lastError = String(e?.message ?? e).slice(0, 160);
      throw e instanceof ImageError ? e : new ImageError(state.lastError);
    }
  }

  return { available, model: available ? model : null, costUsd: usdPerImage, generate, snapshot: () => ({ available, model: available ? model : null, calls: state.calls, failures: state.failures, lastError: state.lastError }) };
}
