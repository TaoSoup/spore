// Image logos (lib/agents-live/imagegen.mjs): the provider is mocked; rasterising is real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createImageGen, fitLogo, imageUrlFor, IMAGE_PROMPT, ImageError } from "../lib/agents-live/imagegen.mjs";
import { drawLogo } from "../lib/agents-live/ailogo.mjs";
import { renderLogo, pngSize } from "../lib/agents/logo.mjs";

test("imagegen: the image endpoint follows the chat endpoint's provider", () => {
  assert.equal(imageUrlFor("https://nano-gpt.com/api/v1/chat/completions"), "https://api.nano-gpt.com/v1/images/generations");
  assert.equal(imageUrlFor("https://api.anthropic.com/v1/chat/completions"), null);
  assert.equal(imageUrlFor("nope"), null);
});

test("imagegen: fitLogo crops any PNG into the 512 px square", async () => {
  const src = await renderLogo({ symbol: "ZZ", palette: ["#123456"], seed: "x" });
  const png = await fitLogo(src, "image/png");
  assert.deepEqual(pngSize(png), { width: 512, height: 512 });
  await assert.rejects(fitLogo(Buffer.alloc(0)), ImageError);
});

test("imagegen: generate posts the prompt with the key, decodes b64 and returns a 512 px PNG; errors are typed", async () => {
  const src = await renderLogo({ symbol: "Q", palette: [], seed: "y" });
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }); return { status: 200, text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from(src).toString("base64") }] }) }; };
  const gen = createImageGen({ url: "https://img.example/v1/images/generations", keyText: "k", model: "m", size: "768x768", usdPerImage: 0.008, fetchImpl });
  assert.equal(gen.available, true);
  const png = await gen.generate("a frog");
  assert.deepEqual(pngSize(png), { width: 512, height: 512 });
  assert.equal(seen[0].body.model, "m"); assert.equal(seen[0].body.size, "768x768"); assert.equal(seen[0].body.response_format, "b64_json"); assert.equal(seen[0].auth, "Bearer k");
  assert.equal(gen.snapshot().calls, 1);
  const bad = createImageGen({ url: "https://img.example/x", keyText: "k", fetchImpl: async () => ({ status: 402, text: async () => "{}" }) });
  await assert.rejects(bad.generate("x"), /HTTP 402 \(balance\)/);
  assert.equal(createImageGen({}).available, false);
  assert.match(IMAGE_PROMPT({ name: "Frog Pilot", symbol: "FPILOT", description: "d" }, { palette: ["#0f0"] }), /Frog Pilot.*no text/s);
});

test("drawLogo: the image provider comes first; its failure falls through to the SVG model, then the template", async () => {
  const src = await renderLogo({ symbol: "I", palette: [], seed: "z" });
  const idea = { name: "Mycelium", symbol: "MYC", description: "d" }, profile = { palette: ["#111111"], themes: ["fungi"] };
  const ok = await drawLogo(idea, profile, { image: { available: true, generate: async () => src }, llm: { available: true, chatText: async () => "<svg/>" } });
  assert.equal(ok.source, "image"); assert.deepEqual(pngSize(ok.png), { width: 512, height: 512 });
  const svgFallback = await drawLogo(idea, profile, { image: { available: true, generate: async () => { throw new ImageError("balance"); } }, llm: { available: true, chatText: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#123"/></svg>' }, log: { warn() {} } });
  assert.equal(svgFallback.source, "model");
  const template = await drawLogo(idea, profile, { image: { available: true, generate: async () => { throw new ImageError("balance"); } }, llm: null, log: { warn() {} } });
  assert.equal(template.source, "template"); assert.match(template.error, /balance/);
});
