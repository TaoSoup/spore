// Root agents: the profile ("purpose") with and without a language model, and the provider wrapper
// (key read from a file, never in a log line or an error message, breaker after repeated failures).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackProfile, buildProfile, cleanProfile, profileInput, keywords, familyOf, SUMMARY_MAX } from "../lib/agents/profile.mjs";
import { createLlm, parseJsonAnswer, NO_LLM } from "../lib/agents/llm.mjs";
import { agentTree, fakeLlm, K, quiet } from "./helpers/agents.mjs";

const HEX = /^#[0-9a-f]{6}$/;
const shape = (p) => {
  assert.equal(typeof p.summary, "string"); assert.ok(p.summary.length > 0 && p.summary.length <= SUMMARY_MAX, `summary ${p.summary.length}`);
  assert.ok(Array.isArray(p.themes) && p.themes.length >= 3 && p.themes.length <= 8, `themes ${p.themes}`);
  for (const t of p.themes) assert.ok(typeof t === "string" && t.length <= 24, t);
  assert.equal(typeof p.tone, "string"); assert.ok(p.tone.length > 0);
  assert.ok(Array.isArray(p.avoid) && p.avoid.length >= 4);
  assert.ok(p.palette.length >= 2 && p.palette.length <= 3 && p.palette.every((c) => HEX.test(c)), p.palette.join());
  assert.ok(["model", "fallback"].includes(p.source)); assert.equal(typeof p.builtAt, "number");
};

test("fallback profile from the root's own words: themes from name/description/recurring child words, tone, palette, summary ≤ 280", () => {
  const { model } = agentTree();
  const input = profileInput(model, K.ROOT);
  assert.equal(input.name, "Mushroom Grove"); assert.equal(input.symbol, "GROVE");
  assert.deepEqual(input.children.sort(), ["Glow Cat", "Spore Cat"]);
  const p = fallbackProfile(input, { now: 123 });
  shape(p);
  assert.equal(p.source, "fallback"); assert.equal(p.builtAt, 123);
  assert.ok(p.themes.includes("mushroom") && p.themes.includes("grove"), p.themes.join());
  assert.ok(p.themes.includes("cat"), "a word two children share is a theme");
  assert.ok(!p.themes.includes("glow") || p.themes.includes("cat"));
  assert.equal(p.tone, "organic, curious, grow-together");
  assert.match(p.summary, /^\$GROVE \(Mushroom Grove\): A glowing mushroom grove/);
  assert.ok(p.avoid.some((a) => /GROVE/.test(a)), "no clones of the root");
  // Deterministic, and per root: the same input gives the same palette; another mint shifts it.
  assert.deepEqual(fallbackProfile(input).palette, p.palette);
  assert.notDeepEqual(fallbackProfile({ ...input, mint: K.B }).palette, p.palette);
});

test("fallback keywords skip stop words, brands, people, slurs and one-off child names; short inputs are padded to 3 themes", () => {
  const kw = keywords({ name: "Nike Moon", symbol: "NMOON", description: "The official coin. Buy now!", children: ["Elon Cat", "Lonely Dog", "Grand Theft Auto VI Cat", "Moon Cat"] });
  assert.ok(kw.includes("moon") && kw.includes("cat"), kw.join());
  for (const bad of ["nike", "elon", "official", "coin", "buy", "lonely", "grand", "theft", "auto"]) assert.ok(!kw.includes(bad), `${bad} in ${kw}`);
  assert.ok(!keywords({ name: "Chinese Frog", symbol: "CFROG", description: null, children: ["Chinese Cat", "Chinese Dog"] }).includes("chinese"), "no nationality themes");
  const p = fallbackProfile({ mint: K.X, name: "Zq", symbol: "ZQ", description: null, children: [] });
  shape(p);
  assert.match(p.summary, /\$ZQ \(Zq\): a playful community coin\./);
  const long = fallbackProfile({ mint: K.X, name: "Long", symbol: "LONG", description: `${"word ".repeat(200)}end.`, children: [] });
  assert.ok(long.summary.length <= SUMMARY_MAX && /… Its children riff on .*\.$/.test(long.summary), long.summary);
  assert.equal(familyOf({ name: "Veil", symbol: "VEIL", description: "The privacy layer for wallets.", children: Array(40).fill("Veil Cat") }).key, "technical", "the root's own words outweigh its children");
});

test("model profile: a valid answer is used (source model), field by field validation keeps the fallback for the rest", async () => {
  const { model } = agentTree();
  const input = profileInput(model, K.ROOT);
  const llm = fakeLlm([{ summary: "A cosy forest of glowing mushrooms where every spore starts a new coin.", themes: ["Glow", "mycelium", "forest walk", "Nike", "x"], tone: "warm and curious", avoid: ["rug talk"], palette: ["#AABBCC", "#112233", "nope"] }]);
  const p = await buildProfile(input, { llm, log: quiet, now: 5 });
  shape(p);
  assert.equal(p.source, "model");
  assert.deepEqual(p.themes, ["glow", "mycelium", "forest walk"], "lowercased, brand and too-short entries dropped");
  assert.equal(p.tone, "warm and curious");
  assert.deepEqual(p.palette, ["#aabbcc", "#112233"]);
  assert.ok(p.avoid.includes("rug talk") && p.avoid.includes("brand names and trademarks"), "base rules always kept");
  const sent = JSON.parse(llm.calls[0].messages[1].content);
  assert.equal(sent.coin.ticker, "GROVE"); assert.ok(sent.existingChildren.includes("Spore Cat"));
  // Too few valid themes: the model's summary alone does not make it a model profile.
  const partial = cleanProfile({ summary: "A long enough summary from the model, really.", themes: ["one"] }, fallbackProfile(input));
  assert.equal(partial.source, "fallback");
});

test("model profile: unavailable, throwing or garbage answers fall back to the deterministic profile", async () => {
  const { model } = agentTree();
  const input = profileInput(model, K.ROOT);
  const want = fallbackProfile(input, { now: 9 });
  assert.deepEqual(await buildProfile(input, { llm: NO_LLM, log: quiet, now: 9 }), want);
  const warns = [];
  assert.deepEqual(await buildProfile(input, { llm: fakeLlm([new Error("down")]), log: { warn: (m) => warns.push(m) }, now: 9 }), want);
  assert.equal(warns.length, 1);
  assert.deepEqual(await buildProfile(input, { llm: fakeLlm([{ nonsense: true }]), log: quiet, now: 9 }), want);
});

test("llm: key from LLM_KEY_FILE in the Authorization header only; never in logs or errors; JSON answers parsed; breaker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-llm-"));
  const KEY = "sk-test-very-secret-0123456789";
  try {
    writeFileSync(join(dir, "key"), `${KEY}\n`);
    const seen = [];
    let mode = "ok", t = 1_000;
    const fetchImpl = async (url, init) => {
      seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      if (mode === "ok") return new Response(JSON.stringify({ choices: [{ message: { content: "Sure!\n```json\n{\"ideas\": [1]}\n```" } }] }), { status: 200 });
      if (mode === "echo") return new Response(`invalid key ${KEY}`, { status: 401 });
      throw Object.assign(new Error(`connect failed ${KEY}`), { code: "ECONNREFUSED" });
    };
    const logs = [];
    const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
    const llm = createLlm({ url: "https://llm.example/v1/chat/completions", keyFile: join(dir, "key"), model: "m1", fetchImpl, log, now: () => t });
    assert.equal(llm.available, true);
    assert.deepEqual(await llm.chatJson([{ role: "user", content: "hi" }]), { ideas: [1] });
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    assert.equal(seen[0].body.model, "m1"); assert.deepEqual(seen[0].body.response_format, { type: "json_object" });
    mode = "echo";
    await assert.rejects(llm.chatJson([]), (e) => { assert.ok(!e.message.includes(KEY), e.message); assert.match(e.message, /HTTP 401 \(check the key\)/); return true; });
    mode = "throw";
    await assert.rejects(llm.chatJson([]), (e) => { assert.ok(!e.message.includes(KEY)); assert.match(e.message, /ECONNREFUSED/); return true; });
    await assert.rejects(llm.chatJson([]));
    // Three failures in a row pause the provider; it answers again after the pause.
    const n = seen.length;
    await assert.rejects(llm.chatJson([]), /paused/);
    assert.equal(seen.length, n, "no request while paused");
    t += 11 * 60_000; mode = "ok";
    assert.deepEqual(await llm.chatJson([]), { ideas: [1] });
    const snap = JSON.stringify(llm.snapshot());
    assert.ok(!snap.includes(KEY) && !logs.join("\n").includes(KEY));
    // Missing pieces: not available, rejects at once, no request.
    const off = createLlm({ url: "https://llm.example", keyFile: join(dir, "missing"), model: "m", fetchImpl, log });
    assert.equal(off.available, false);
    await assert.rejects(off.chatJson([]), /not configured/);
    assert.ok(logs.some((l) => /key file unreadable/.test(l)) && !logs.join("\n").includes(KEY));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(parseJsonAnswer('{"a":1}'), { a: 1 });
  assert.throws(() => parseJsonAnswer("no json here"), /no JSON/);
});
