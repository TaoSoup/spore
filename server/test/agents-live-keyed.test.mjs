// The keyed rail: the owner's provider key serves every agent, each call booked against its root
// (lib/agents-live/keyed.mjs over lib/agents/llm.mjs). The provider is mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlm } from "../lib/agents/llm.mjs";
import { bookedLlm } from "../lib/agents-live/keyed.mjs";
import { estimateUsd, keyedId, AGENT_MODELS } from "../lib/agents-live/models.mjs";

const ROOT = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
const answer = (content, usage = { prompt_tokens: 1000, completion_tokens: 200 }) => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }], usage }) });

test("models: Claude only, each with a provider id and prices", () => {
  assert.ok(AGENT_MODELS.every((m) => m.family === "claude" && m.keyed && m.inUsdPerM > 0 && m.outUsdPerM > 0));
  assert.equal(keyedId("anthropic/claude-sonnet-5.5"), "anthropic/claude-sonnet-5.5", "NanoGPT-style endpoints take our public ids");
  assert.equal(keyedId("anthropic/claude-sonnet-5.5", "anthropic"), "claude-sonnet-5-5", "the vendor's own endpoint wants dashed ids");
  assert.equal(keyedId("openai/gpt-5.5"), null);
  assert.equal(estimateUsd("anthropic/claude-sonnet-5.5", { prompt_tokens: 1_000_000, completion_tokens: 0 }), 3);
  assert.equal(estimateUsd("anthropic/claude-opus-5.5", { prompt_tokens: 0, completion_tokens: 1_000_000 }), 75);
  assert.equal(estimateUsd("anthropic/claude-sonnet-5.5", null), null);
});

test("llm: chatText returns the text, honours a per-call model override and keeps usage", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { const b = JSON.parse(init.body); seen.push(b); return b.response_format ? answer('{"a":1}') : answer("plain <svg/>"); };
  const llm = createLlm({ url: "https://llm.example/v1/chat/completions", keyText: "k", model: "default-model", fetchImpl });
  assert.equal(await llm.chatText([{ role: "user", content: "x" }], { model: "claude-opus-5-5" }), "plain <svg/>");
  assert.equal(seen[0].model, "claude-opus-5-5"); assert.equal(seen[0].response_format, undefined);
  assert.deepEqual(llm.lastUsage(), { prompt_tokens: 1000, completion_tokens: 200 });
  assert.deepEqual(await llm.chatJson([{ role: "user", content: "x" }]), { a: 1 });
  assert.equal(seen[1].model, "default-model"); assert.deepEqual(seen[1].response_format, { type: "json_object" });
});

test("keyed: bookedLlm routes to the provider id of the root's model and books tokens and cost per root", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body).model); return answer('{"name":"Mycelium","symbol":"MYC"}'); };
  const keyed = createLlm({ url: "https://llm.example/v1/chat/completions", keyText: "k", model: "claude-sonnet-5-5", fetchImpl });
  const ledger = { entries: [], record(e) { this.entries.push(e); } };
  const llm = bookedLlm({ llm: keyed, root: ROOT, model: "anthropic/claude-opus-5.5", ledger, idStyle: "anthropic" });
  assert.equal(llm.available, true); assert.equal(llm.rail, "keyed");
  assert.deepEqual(await llm.chatJson([{ role: "user", content: "x" }]), { name: "Mycelium", symbol: "MYC" });
  assert.deepEqual(calls, ["claude-opus-5-5"]);
  const e = ledger.entries[0];
  assert.equal(e.kind, "ai"); assert.equal(e.rail, "keyed"); assert.equal(e.root, ROOT); assert.equal(e.model, "anthropic/claude-opus-5.5"); assert.equal(e.provider, "claude-opus-5-5"); assert.equal(e.status, "done");
  assert.equal(e.promptTokens, 1000); assert.equal(e.completionTokens, 200);
  assert.equal(e.estUsd, 0.03); // 1000 × $15/M + 200 × $75/M
  assert.equal(llm.snapshot().paidUsd, 0.03);
  assert.ok(!JSON.stringify(ledger.entries).includes('"k"'), "no key in the ledger");
});

test("keyed: a failing provider is booked as failed and the error surfaces; no key → unavailable", async () => {
  const keyed = createLlm({ url: "https://llm.example/v1/chat/completions", keyText: "k", model: "m", fetchImpl: async () => ({ status: 401, text: async () => "no" }) });
  const ledger = { entries: [], record(e) { this.entries.push(e); } };
  const llm = bookedLlm({ llm: keyed, root: ROOT, model: "anthropic/claude-sonnet-5.5", ledger, log: { warn() {} } });
  await assert.rejects(llm.chatText([{ role: "user", content: "x" }]), /HTTP 401/);
  assert.equal(ledger.entries[0].status, "failed");
  assert.equal(bookedLlm({ llm: createLlm({}), root: ROOT, model: "anthropic/claude-sonnet-5.5" }).available, false);
  assert.equal(bookedLlm({ llm: keyed, root: ROOT, model: "openai/gpt-5.5" }).available, false, "a model without a provider id is unavailable");
});
