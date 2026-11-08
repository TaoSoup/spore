// Root agents: generated logos are real 512×512 PNGs (resvg-wasm), deterministic, drawn from the
// palette with every ticker character the font knows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLogo, logoSvg, logoRows, pngSize, GLYPHS, LOGO_SIZE } from "../lib/agents/logo.mjs";

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("logo: PNG magic bytes, IHDR 512×512, deterministic per (symbol, palette, seed)", async () => {
  const opts = { symbol: "GLOWCAP", palette: ["#b6ff5c", "#2f8f4e", "#0b1a12"], seed: "abc" };
  const png = await renderLogo(opts);
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual(png.subarray(0, 8), PNG_MAGIC);
  assert.deepEqual(pngSize(png), { width: 512, height: 512 });
  assert.equal(LOGO_SIZE, 512);
  assert.ok(png.length > 5_000 && png.length < 400_000, String(png.length));
  assert.deepEqual(await renderLogo(opts), png, "same input, same bytes");
  assert.notDeepEqual(await renderLogo({ ...opts, seed: "other" }), png);
  assert.equal(pngSize(Buffer.from("not a png at all, long enough")), null);
});

test("logo: the SVG uses the palette, falls back on bad colours, draws every glyph and wraps long tickers", async () => {
  const svg = logoSvg({ symbol: "AB", palette: ["#112233", "#445566", "#010101"], seed: "s" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="512" height="512"/);
  for (const c of ["#445566", "#010101"]) assert.ok(svg.includes(c), c);
  assert.ok(!/<text|font-family|<image|href=/.test(svg), "no text, fonts or external images: strokes only");
  const fallback = logoSvg({ symbol: "AB", palette: ["red", null], seed: "s" });
  assert.ok(fallback.includes("#b6ff5c") && fallback.includes("#b08cff"));
  assert.equal(Object.keys(GLYPHS).length, 36);
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") assert.ok(GLYPHS[c]?.length, c);
  assert.deepEqual(logoRows("GROVE"), [["G", "R", "O", "V", "E"]]);
  assert.deepEqual(logoRows("CGROVE").map((r) => r.join("")), ["CGROVE"], "six letters stay on one row");
  assert.deepEqual(logoRows("ABCDEFGHIJ").map((r) => r.join("")), ["ABCDE", "FGHIJ"]);
  assert.deepEqual(logoRows("ABCDEFG").map((r) => r.join("")), ["ABCD", "EFG"]);
  assert.deepEqual(logoRows("BABYGOBLIN", "Baby Goblin").map((r) => r.join("")), ["BABY", "GOBLIN"], "split at the name's word break");
  assert.deepEqual(logoRows("MINIFROG", "Mini Frog").map((r) => r.join("")), ["MINI", "FROG"]);
  assert.deepEqual(logoRows("MOUTLAW", "Memes Outlaw").map((r) => r.join("")), ["MOUT", "LAW"], "a one-letter row is avoided: middle split");
  assert.deepEqual(logoRows("$$"), []);
  const all = await renderLogo({ symbol: "0123456789", palette: [], seed: "digits" });
  assert.deepEqual(pngSize(all), { width: 512, height: 512 });
});
