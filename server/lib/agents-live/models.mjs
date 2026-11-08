// The models a root agent may think with (owner, 2026-10-19: Claude only, called with the owner's
// API key — the keyed rail). `id` is the public name the launch form and the API use; `keyed` is the
// provider's model id on its OpenAI-compatible endpoint; `inUsdPerM` / `outUsdPerM` price a call for
// the ledger's estimate (list prices, 2026); `maxUsd` / `capUsd` bound one design call on the
// per-request rails (pay.mjs) and stay as a sanity cap for estimates.
export const AGENT_MODELS = Object.freeze([
  { id: "anthropic/claude-sonnet-5.5", keyed: "claude-sonnet-5-5", family: "claude", label: "Claude Sonnet 5.5", inUsdPerM: 3, outUsdPerM: 15, maxUsd: 0.014, capUsd: 0.03, default: true },
  { id: "anthropic/claude-opus-5.5", keyed: "claude-opus-5-5", family: "claude", label: "Claude Opus 5.5", inUsdPerM: 15, outUsdPerM: 75, maxUsd: 0.027, capUsd: 0.06 },
]);

export const DEFAULT_MODEL = AGENT_MODELS.find((m) => m.default).id;

export function modelInfo(id) { return AGENT_MODELS.find((m) => m.id === id) ?? null; }

/**
 * The model id to send on the keyed rail, or null. `style` names the provider's catalogue:
 * "nanogpt" (NanoGPT's OpenAI-compatible endpoint uses our public ids as they are) or "anthropic"
 * (the vendor's own endpoint wants its dashed ids).
 */
export function keyedId(id, style = "nanogpt") {
  const m = modelInfo(id);
  if (!m) return null;
  return style === "anthropic" ? m.keyed : m.id;
}

/** Which catalogue a provider URL speaks, from its host. */
export function idStyleFor(url) {
  try { const h = new URL(String(url)).hostname; if (/anthropic\.com$/i.test(h)) return "anthropic"; } catch { /* unknown */ }
  return "nanogpt";
}

/** Estimated USD of one call from its token usage (OpenAI-style `usage`), or null. */
export function estimateUsd(id, usage) {
  const m = modelInfo(id);
  const pin = Number(usage?.prompt_tokens), pout = Number(usage?.completion_tokens);
  if (!m || !Number.isFinite(pin) || !Number.isFinite(pout)) return null;
  return Math.round(((pin * m.inUsdPerM + pout * m.outUsdPerM) / 1e6) * 1e6) / 1e6;
}

/** The model id, or throws when it is not one of the allowed models. */
export function assertModel(id) {
  const m = modelInfo(id);
  if (!m) throw new Error(`model not allowed: ${String(id).slice(0, 60)} (allowed: ${AGENT_MODELS.map((x) => x.id).join(", ")})`);
  return m.id;
}
