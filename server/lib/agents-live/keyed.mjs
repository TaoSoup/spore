// The keyed rail (owner 2026-10-19): the server calls the model provider with the owner's API key
// (lib/agents/llm.mjs, OpenAI-compatible endpoint), and every call is booked in the ledger against
// the agent that asked — model, tokens, an estimated USD cost from models.mjs prices — so each
// agent's thinking cost is known per root even though the money leaves the owner's provider
// account, not the agent's wallet. Nothing on-chain happens here.
//
// Spend is bounded BEFORE each call (review 2026-10-19): the output token budget is
// derived from the model's per-call cap and its output price, and a daily USD ceiling per agent and
// for all agents together pauses thinking for the rest of the day once reached.
import { modelInfo, keyedId, estimateUsd } from "./models.mjs";

export const KEYED_DEFAULTS = Object.freeze({ dailyUsdPerAgent: 2, dailyUsdTotal: 10 });

/** One day's spend counters (UTC day), shared by every booked provider of a process. */
export function createSpendMeter({ dailyUsdPerAgent = KEYED_DEFAULTS.dailyUsdPerAgent, dailyUsdTotal = KEYED_DEFAULTS.dailyUsdTotal, now = Date.now } = {}) {
  let day = null, total = 0; const perRoot = new Map();
  const roll = () => { const d = Math.floor(now() / 86_400_000); if (d !== day) { day = d; total = 0; perRoot.clear(); } };
  return {
    /** Why `root` may not think now, or null. */
    refusal(root, nextCallUsd = 0) {
      roll();
      if (total + nextCallUsd > dailyUsdTotal) return `daily model budget for all agents reached ($${total.toFixed(2)} of $${dailyUsdTotal})`;
      if ((perRoot.get(root) ?? 0) + nextCallUsd > dailyUsdPerAgent) return `daily model budget for this agent reached ($${(perRoot.get(root) ?? 0).toFixed(2)} of $${dailyUsdPerAgent})`;
      return null;
    },
    add(root, usd) { roll(); total += usd; perRoot.set(root, (perRoot.get(root) ?? 0) + usd); },
    snapshot() { roll(); return { day, totalUsd: total, perAgent: Object.fromEntries(perRoot), dailyUsdPerAgent, dailyUsdTotal }; },
  };
}

/** The most output tokens a call may produce within `capUsd` at this model's output price (prompt share reserved). */
export function maxTokensFor(info, requested, { promptTokens = 1500 } = {}) {
  const budget = info.capUsd - (promptTokens * info.inUsdPerM) / 1e6;
  const cap = Math.floor((Math.max(0.002, budget) * 1e6) / info.outUsdPerM);
  return Math.max(200, Math.min(requested, cap));
}

/** `{ available, model, chatText, chatJson, snapshot }` bound to one root; `llm` is the shared keyed provider. */
export function bookedLlm({ llm, root, model, ledger = null, meter = null, idStyle = "nanogpt", log = console }) {
  const info = modelInfo(model);
  const provider = info ? keyedId(info.id, idStyle) : null;
  const available = !!(llm?.available && provider);
  const state = { calls: 0, failures: 0, estUsd: 0, lastError: null, refused: 0 };
  const book = (status, extra = {}) => ledger?.record({ kind: "ai", rail: "keyed", root, model: info?.id ?? model, provider, status, ...extra });

  async function run(kind, messages, opts) {
    if (!available) throw new Error("keyed language model not configured");
    const why = meter?.refusal(root, info.capUsd);
    if (why) { state.refused++; state.lastError = why; book("refused", { note: why }); throw new Error(why); }
    state.calls++;
    const maxTokens = maxTokensFor(info, opts.maxTokens ?? 900);
    try {
      const o = { ...opts, maxTokens, model: provider };
      const out = kind === "text" ? await llm.chatText(messages, o) : await llm.chatJson(messages, o);
      const u = llm.lastUsage?.() ?? null;
      const estUsd = u ? estimateUsd(info.id, u) : info.capUsd; // unknown usage is charged at the cap
      state.estUsd += estUsd; meter?.add(root, estUsd);
      book("done", { promptTokens: u?.prompt_tokens ?? null, completionTokens: u?.completion_tokens ?? null, maxTokens, estUsd });
      return out;
    } catch (e) {
      state.failures++; state.lastError = String(e?.message ?? e).slice(0, 160);
      book("failed", { note: state.lastError });
      log.warn?.(`agents: keyed model call failed for ${root}: ${state.lastError}`);
      throw e;
    }
  }

  return {
    available, model: available ? info.id : null, rail: "keyed",
    chatText: (m, o = {}) => run("text", m, o),
    chatJson: (m, o = {}) => run("json", m, o),
    snapshot: () => ({ available, model: available ? info.id : null, rail: "keyed", calls: state.calls, failures: state.failures, refused: state.refused, paidUsd: state.estUsd, lastError: state.lastError }),
  };
}
