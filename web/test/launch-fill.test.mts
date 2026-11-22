// The "Launch a child" fill (lib/launch-fill.ts): what a pasted link is (an X post, an image link, junk), and the name
// and ticker suggested from a post's words. Deterministic, pure; also the route line the trade card shares with the
// ticket (lib/route-line.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
await import("./cjs-sdk-hook.mjs");
const F = await import("../src/lib/launch-fill.ts");
const { routeLine } = await import("../src/lib/route-line.ts");

const ID = "2120644813917925721";

test("parseFillLink: x.com and twitter.com post links give the id", () => {
  for (const u of [`https://x.com/alice/status/${ID}`, `https://twitter.com/bob/status/${ID}?s=20`, `https://www.x.com/a/status/${ID}/photo/1`, `https://mobile.twitter.com/a/statuses/${ID}`,
    `https://x.com/i/web/status/${ID}`, `https://x.com/i/status/${ID}`, ` https://x.com/alice/status/${ID} `, `http://x.com/a/status/${ID}`]) {
    assert.deepEqual(F.parseFillLink(u), { kind: "post", id: ID }, u);
  }
});

test("parseFillLink: an https image link is recognised (not fetched); junk is none", () => {
  assert.deepEqual(F.parseFillLink("https://example.com/cat.PNG"), { kind: "image", url: "https://example.com/cat.PNG" });
  assert.deepEqual(F.parseFillLink("https://cdn.example.com/a/b.webp?x=1"), { kind: "image", url: "https://cdn.example.com/a/b.webp?x=1" });
  for (const junk of ["", "   ", "hello", "x.com/a/status/1", "http://example.com/cat.png", "https://example.com/page", "https://x.com/alice", "https://x.com/a/status/abc",
    "https://x.com.evil.example/a/status/1", "https://user:pw@x.com/a/status/1", "https://x.com:8443/a/status/1", "javascript:alert(1)", "data:image/png;base64,AAAA",
    `https://x.com/a/status/${ID}`.padEnd(400, "x"), "https://x.com/a/status/9223372036854775808", "https://t.co/abc", null, undefined, 42, {}]) {
    assert.deepEqual(F.parseFillLink(junk as unknown), { kind: "none" }, String(junk).slice(0, 60));
  }
});

test("nameFromPost: the first clean phrase, at most 32 characters, cut on a word", () => {
  assert.equal(F.nameFromPost("Little Pepe is here! https://t.co/abc @someone"), "Little Pepe is here");
  assert.equal(F.nameFromPost("@dev @other\n#Moon cat on the rise 🚀🚀"), "Moon cat on the rise");
  assert.equal(F.nameFromPost("The quick brown fox jumps over the lazy dog again and again"), "The quick brown fox jumps over");
  assert.ok(F.nameFromPost("x".repeat(80)).length <= F.NAME_MAX);
  assert.equal(F.nameFromPost("", "cool_dev"), "cool dev", "a media-only post: the handle");
  assert.equal(F.nameFromPost("https://t.co/x pic.twitter.com/abc", "a"), "a");
  assert.equal(F.nameFromPost(null, null), "");
  assert.equal(F.nameFromPost("Hello. World"), "Hello", "the first sentence");
  assert.equal(F.nameFromPost("Hello. World"), F.nameFromPost("Hello. World"), "deterministic");
  // astral letters (math bold) are folded to plain ones; a cut never leaves half a letter
  const bold = [..."SUPERCALIFRAGILISTIC"].map((c) => String.fromCodePoint(0x1d400 + c.charCodeAt(0) - 65)).join("");
  assert.equal(F.nameFromPost(bold), "SUPERCALIFRAGILISTIC");
  for (const t of ["A" + bold, "A" + "\u{20000}".repeat(30), "\u{20000}".repeat(40), "AB\u{20000}".repeat(20)]) {
    const n = F.nameFromPost(t);
    assert.ok(n.length <= F.NAME_MAX, `at most 32 units: ${n.length}`);
    assert.doesNotMatch(n, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone high surrogate");
  }
});

test("tickerFromName: up to 10 of A-Z 0-9", () => {
  assert.equal(F.tickerFromName("Little Pepe"), "LITTLEPEPE");
  assert.equal(F.tickerFromName("Moon cat on the rise"), "MCOTR", "too long: initials");
  assert.equal(F.tickerFromName("Supercalifragilistic dog"), "SUPERCALIF", "two words: the joined words cut");
  assert.equal(F.tickerFromName("Café 42"), "CAFE42");
  assert.equal(F.tickerFromName("🚀🚀"), "");
  assert.equal(F.tickerFromName(""), "");
  for (const n of ["a b c d e f g h i j k l m", "x".repeat(50), "Ünïcödé näme"]) assert.match(F.tickerFromName(n), /^[A-Z0-9]{1,10}$/, n);
});

test("routeLine: SOL to the coin on a buy, reversed on a sell; Jupiter before a quote", () => {
  const coin = (mint: string, symbol: string, quoteMint: string | null = null) => ({ mint, symbol, image: null, quoteMint, quoteSymbol: null, decimals: 6 });
  const child = coin("CHILD", "KID", "ROOT"), root = coin("ROOT", "TREE");
  const r = { coins: [child, root], asset: null, via: "sol" as const, chain: [{}, {}] };
  assert.deepEqual(routeLine(r as never, child, "buy"), { path: "SOL → $TREE → $KID", hops: "2 hops" });
  assert.deepEqual(routeLine(r as never, child, "sell"), { path: "$KID → $TREE → SOL", hops: "2 hops" });
  assert.deepEqual(routeLine({ coins: [root], asset: null, via: "sol", chain: [{}] } as never, root, "buy"), { path: "SOL → $TREE", hops: "1 hop" });
  assert.equal(routeLine(null, root, "buy"), null);
});
