// The key points of a Discover subject line (web/src/lib/discover.ts keySpans, lineKeysOf, fallbackKeys, and
// subjectLine's `keys`): the few words of the sentence a reader should catch first, drawn brighter. A model's own pick
// (`line.keys`) checked again on the page (whole words, in the sentence, not the whole of it, no overlap, at most 3,
// in the order they stand), the page's own pick when a line carries none (names, figures with a sign or a unit, words
// in quote marks), none on the poster's own words, and the markup (components/DiscoverLine.tsx: <mark> text nodes).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoryCard, StoryRow } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");

const NOW = 1_770_000_000, ID = "1895000000000000001";
const post = { id: ID, handle: "TheKindDev", text: "elon changed his pfp to a dog lol", at: NOW - 3600, url: "x" };
const row = { mint: "M1", name: "Dog", symbol: "DOG" } as StoryRow;
const card = (line: unknown, o: Partial<StoryCard> = {}): StoryCard => ({ kind: "post", key: ID, post, family: null, buyers5m: 0, coinsN: 1, coins: [row], line: line as StoryCard["line"], ...o });
const ELON = "Elon Musk changes his profile picture to a dog";
const marked = (spans: { text: string; key: boolean }[]) => spans.filter((s) => s.key).map((s) => s.text);

test("1. keySpans cuts the sentence into plain and key parts, in order, covering all of it", () => {
  const sp = D.keySpans(ELON, ["profile picture", "dog"]);
  assert.equal(sp.map((s) => s.text).join(""), ELON, "the parts read as the same sentence");
  assert.deepEqual(sp, [
    { text: "Elon Musk changes his ", key: false }, { text: "profile picture", key: true }, { text: " to a ", key: false }, { text: "dog", key: true },
  ]);
  // keys in any order; matched ignoring case, the sentence's own letters kept
  assert.deepEqual(marked(D.keySpans(ELON, ["DOG", "elon musk"])), ["Elon Musk", "dog"]);
  // no keys, or keys not in it: one plain part
  assert.deepEqual(D.keySpans(ELON, []), [{ text: ELON, key: false }]);
  assert.deepEqual(D.keySpans(ELON, ["cat", ""]), [{ text: ELON, key: false }]);
  assert.deepEqual(D.keySpans("", ["a"]), [{ text: "", key: false }]);
});

test("2. keySpans: whole words only, first free place, never overlapping", () => {
  // "Musk" is not found inside "Muskrat"; its whole-word place is used
  assert.deepEqual(marked(D.keySpans("Muskrat fans cheer Musk", ["Musk"])), ["Musk"]);
  assert.equal(D.keySpans("Muskrat fans cheer Musk", ["Musk"])[0].text, "Muskrat fans cheer ");
  // the first place a key does not overlap an earlier key
  assert.deepEqual(D.keySpans("Dog Coin and dog", ["Dog Coin", "dog"]).map((s) => [s.text, s.key]), [["Dog Coin", true], [" and ", false], ["dog", true]]);
  // a key inside one already placed and nowhere else is left out
  assert.deepEqual(marked(D.keySpans(ELON, ["Elon Musk", "Musk"])), ["Elon Musk"]);
  // signs bound a figure: "$1 million", "95%"
  assert.deepEqual(marked(D.keySpans("Raises $1 million, up 95% today", ["$1 million", "95%"])), ["$1 million", "95%"]);
  // a key with regex signs in it is plain text
  assert.deepEqual(marked(D.keySpans("Price (a.k.a. GOAT) rises", ["(a.k.a. GOAT)"])), ["(a.k.a. GOAT)"]);
});

test("3. lineKeysOf checks a model's keys again: strings in the sentence on word boundaries, short, not all of it, no overlap, at most 3, in sentence order", () => {
  const k = (keys: unknown, h = ELON) => D.lineKeysOf({ line: { keys } }, h);
  assert.deepEqual(k(["dog", "profile picture"]), ["profile picture", "dog"], "in the order they stand");
  assert.deepEqual(k(["profile picture", 5, null, { a: 1 }, "cat", "pic", "Dog"]), ["profile picture", "Dog"], "not a string, not in the sentence, inside a word: dropped");
  assert.deepEqual(k([ELON, ELON.toUpperCase()]), [], "never the whole sentence");
  assert.deepEqual(k(["Elon Musk changes his profile"]), [], "more than 4 words");
  assert.deepEqual(k(["x".repeat(41)], `a ${"x".repeat(41)} b`), [], "longer than 40 characters");
  assert.deepEqual(k(["...", " "], "Wait ... what"), [], "no letter or digit");
  assert.deepEqual(k(["Elon Musk", "Musk", "dog", "dog"]), ["Elon Musk", "dog"], "an overlap or a repeat is dropped");
  assert.deepEqual(k(["Elon", "Musk", "profile", "picture", "dog"]), ["Elon", "Musk", "profile"], "at most 3");
  assert.deepEqual(k([" profile​ picture\n"]), ["profile picture"], "made plain like every model text");
  // no keys list at all (an older line): null, the page picks for itself; an empty list: nothing to mark
  assert.equal(D.lineKeysOf({ line: { subject: "A", happened: ELON, kind: "event" } }, ELON), null);
  assert.equal(D.lineKeysOf({ line: { keys: "dog" } }, ELON), null);
  assert.equal(D.lineKeysOf({ line: null }, ELON), null);
  assert.equal(D.lineKeysOf(null, ELON), null);
  assert.deepEqual(k([]), []);
});

test("4. fallbackKeys: names, figures with a sign or a unit, words in quote marks; never filler, never the first word alone", () => {
  assert.deepEqual(D.fallbackKeys(ELON), ["Elon Musk"], "a name of two capitals at the start counts");
  assert.deepEqual(D.fallbackKeys("Poster says Cupsey changed his name to Top Floor Boss on a stream"), ["Cupsey", "Top Floor Boss"], "the first word alone is just the sentence's start");
  assert.deepEqual(D.fallbackKeys("The White House says tariffs rise 95% next week"), ["White House", "95%"], "a leading 'The' is dropped");
  assert.deepEqual(D.fallbackKeys("Trump's son Barron raises $1 million; Ralphie joins"), ["Trump", "Barron", "$1 million"], "a possessive name; a clause start after ';' is a first word too; at most 3");
  assert.deepEqual(D.fallbackKeys("Coin named “Top G” after a stream by Andrew Tate, CEO of Hustlers"), ["Top G", "Andrew Tate", "CEO"], "words in quote marks; a comma ends a name");
  assert.deepEqual(D.fallbackKeys("Fans of Ralphie, the dog, cheer in 2014 with 3 coins"), ["Ralphie"], "a bare number is not a figure");
  assert.deepEqual(D.fallbackKeys("Volume hits 300k as fees reach $2.5M"), ["300k", "$2.5M"]);
  assert.deepEqual(D.fallbackKeys("Poster says New York Times and Now TV wrote about the New Coin"), ["New York Times", "Now TV", "New Coin"], "only an article is dropped from the front of a name");
  assert.deepEqual(D.fallbackKeys("Linked post has no text"), []);
  assert.deepEqual(D.fallbackKeys("a dog on the moon"), []);
  assert.deepEqual(D.fallbackKeys(""), []);
  assert.deepEqual(D.fallbackKeys("Make America Great Again Now Forever rally"), ["Make America Great Again"], "a long run of capitals is cut to 4 words");
  // whatever it picks, keySpans finds again
  for (const h of ["Poster says Cupsey changed his name to Top Floor Boss on a stream", "Trump's son Barron raises $1 million; Ralphie joins"]) {
    assert.deepEqual(marked(D.keySpans(h, D.fallbackKeys(h))), D.fallbackKeys(h));
  }
});

test("5. subjectLine's keys: the model's (checked), else the page's own; an empty list from the model marks nothing; none on the poster's words", () => {
  const model = (o: Record<string, unknown> = {}) => ({ subject: "Elon Musk", happened: ELON, kind: "event", by: "model", chips: ["ai"], ...o });
  assert.deepEqual(D.subjectLine(card(model({ keys: ["dog", "profile picture", "cat"] })), NOW)!.keys, ["profile picture", "dog"]);
  assert.deepEqual(D.subjectLine(card(model({ keys: [] })), NOW)!.keys, [], "a thin line: nothing to mark");
  assert.deepEqual(D.subjectLine(card(model()), NOW)!.keys, ["Elon Musk"], "an older line: the page's own pick");
  // the server's own quote: the poster's text, no marks
  const q = D.subjectLine(card({ subject: "Dog", happened: "Elon Musk is a Dog Person now", kind: "thin", by: "server", quote: true, chips: [] }), NOW)!;
  assert.deepEqual([q.quote, q.keys], [true, []]);
  // a server's own sentence keeps no model keys even if a body sent some
  const own = D.subjectLine(card({ subject: "Ansem", happened: "3 of 4 coins are named Ansem; 2 launched under $Slingoor", kind: "thin", by: "server", chips: [], keys: ["coins"] }, { kind: "narrative", key: "n:1", coinsN: 4, post: null, narrative: { id: 1, title: "ansem", theme: "crypto native" } }), NOW, true, { coinsN: 4 })!;
  assert.deepEqual(own.keys, ["Ansem"]);
  // a line still pending: the poster's words in quote marks, no marks
  const pend = D.subjectLine(card(undefined, { post: { ...post, text: "Elon Musk changed his pfp" } }), NOW)!;
  assert.deepEqual([pend.quote, pend.keys], [true, []]);
});

// ---- the markup (components/DiscoverLine.tsx)
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SubjectLineBlock } = await import("../src/components/DiscoverLine.tsx");
const draw = (L: NonNullable<ReturnType<typeof D.subjectLine>>) => renderToStaticMarkup(createElement(SubjectLineBlock, { L }));

test("6. the sentence as drawn: key points in <mark class=\"dsc-key\">, text nodes only, the same sentence read aloud", () => {
  const L = D.subjectLine(card({ subject: "Elon Musk", happened: ELON, kind: "event", by: "model", chips: ["ai"], keys: ["profile picture", "dog"] }), NOW)!;
  const html = draw(L);
  assert.ok(html.includes("<span class=\"dsc-ln-h\">Elon Musk changes his <mark class=\"dsc-key\">profile picture</mark> to a <mark class=\"dsc-key\">dog</mark></span>"), html);
  // a stranger's markup in a key or the sentence is text
  const evil = D.subjectLine(card({ subject: "X", happened: "Poster says <b>Bob</b> & <i>Al</i> won", kind: "event", by: "model", chips: [], keys: ["<b>Bob</b>"] }), NOW)!;
  const e = draw(evil);
  assert.ok(e.includes("<mark class=\"dsc-key\">&lt;b&gt;Bob&lt;/b&gt;</mark>") && !e.includes("<b>Bob") && !e.includes("<i>"), e);
  // the poster's words: in quote marks, no mark
  const q = draw(D.subjectLine(card({ subject: "Dog", happened: "Elon Musk is a Dog Person now", kind: "thin", by: "server", quote: true, chips: [] }), NOW)!);
  assert.ok(q.includes("<span class=\"dsc-ln-h\">“Elon Musk is a Dog Person now”</span>") && !q.includes("<mark"));
});
