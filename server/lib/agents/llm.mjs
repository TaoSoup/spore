// Pluggable language-model provider for the root agents (DESIGN §13), configured only by env:
// LLM_URL (a chat-completions endpoint in the common JSON format), LLM_KEY_FILE (a file holding the key)
// and LLM_MODEL. Everything that calls it has a deterministic fallback, so an unset or failing
// provider degrades the agents to template ideas instead of stopping them.
//
// The key is read from its file once, kept in a closure and only ever written into the
// Authorization header. It is never logged, never part of an error message and never returned:
// error texts are built from the status code and a sanitised slice of the provider's answer.
import { readFileSync } from "node:fs";

const TIMEOUT_MS = 25_000;
const MAX_ANSWER_BYTES = 256 * 1024;
const BREAKER_FAILS = 3;              // consecutive failures before the provider is skipped
const BREAKER_PAUSE_MS = 10 * 60_000; // ... for this long (the agents run on fallbacks meanwhile)

export class LlmError extends Error { constructor(message) { super(message); this.name = "LlmError"; } }

/** Pulls the first JSON object out of a model answer (bare, fenced in ``` or surrounded by prose). */
export function parseJsonAnswer(text) {
  if (typeof text !== "string") throw new LlmError("empty answer");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new LlmError("answer has no JSON object");
  try { return JSON.parse(body.slice(start, end + 1)); } catch { throw new LlmError("answer is not valid JSON"); }
}

/**
 * `{ available, model, chatJson(messages, opts) }`. `available` is false when LLM_URL or the key is
 * missing; `chatJson` then rejects at once and callers use their fallback. `keyText` exists for
 * tests (the server always passes `keyFile`).
 */
export function createLlm({ url = null, keyFile = null, keyText = null, model = null, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, log = console, now = Date.now } = {}) {
  let key = keyText;
  if (key == null && keyFile) {
    try { key = readFileSync(keyFile, "utf8").trim(); }
    catch (e) { log.warn?.(`agents: language model key file unreadable (${e.code ?? "error"}); using the fallback`); key = null; }
  }
  const available = !!(url && key && model);
  const state = { fails: 0, pausedUntil: 0, calls: 0, failures: 0, lastError: null };
  // Some compatible servers reject `response_format`; remember that after the first refusal.
  let jsonMode = true;

  async function post(body) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (text.length > MAX_ANSWER_BYTES) throw new LlmError(`answer over ${MAX_ANSWER_BYTES} bytes`);
    return { status: res.status, text };
  }

  /**
   * The model's answer as text. `opts.model` overrides the configured model for this call (the live
   * agents pick a model per root); `opts.json` asks for a JSON object. The provider's token usage of
   * the last call is kept for the caller's accounting (`lastUsage()`).
   */
  async function chatText(messages, { maxTokens = 900, temperature = 0.8, model: modelOverride = null, json: wantJson = false } = {}) {
    if (!available) throw new LlmError("language model not configured");
    if (now() < state.pausedUntil) throw new LlmError("language model paused after repeated failures");
    state.calls++;
    try {
      const base = { model: modelOverride || model, messages, temperature, max_tokens: maxTokens };
      let r = await post(wantJson && jsonMode ? { ...base, response_format: { type: "json_object" } } : base);
      if (wantJson && jsonMode && r.status === 400 && /response_format|json_object/i.test(r.text)) { jsonMode = false; r = await post(base); }
      if (r.status < 200 || r.status >= 300) throw new LlmError(`provider answered HTTP ${r.status}${r.status === 401 || r.status === 403 ? " (check the key)" : ""}`);
      let json;
      try { json = JSON.parse(r.text); } catch { throw new LlmError("provider answer is not JSON"); }
      state.lastUsage = json?.usage && typeof json.usage === "object" ? { prompt_tokens: Number(json.usage.prompt_tokens ?? json.usage.input_tokens) || 0, completion_tokens: Number(json.usage.completion_tokens ?? json.usage.output_tokens) || 0 } : null;
      const content = json?.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
      state.fails = 0;
      return text;
    } catch (e) {
      state.failures++; state.fails++;
      // The key never reaches a message: provider bodies are not echoed, fetch errors carry no headers.
      const msg = e instanceof LlmError ? e.message : e?.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : `request failed (${e?.code ?? e?.name ?? "error"})`;
      state.lastError = msg;
      if (state.fails >= BREAKER_FAILS) { state.pausedUntil = now() + BREAKER_PAUSE_MS; state.fails = 0; }
      throw new LlmError(msg);
    }
  }

  /** The first JSON object in the model's answer (asks for JSON mode where the provider supports it). */
  const chatJson = async (messages, opts = {}) => parseJsonAnswer(await chatText(messages, { ...opts, json: true }));

  return {
    available, model: available ? model : null,
    chatText, chatJson,
    lastUsage: () => state.lastUsage ?? null,
    snapshot: () => ({ available, model: available ? model : null, calls: state.calls, failures: state.failures, pausedMs: Math.max(0, state.pausedUntil - now()), lastError: state.lastError }),
  };
}

/** The provider used when nothing is configured: never available, every call rejects. */
export const NO_LLM = createLlm({});
