// Name features for the name waves (lib/name-features.mjs): whole words, camelCase parts, known token + residual only
// inside a word that is itself new (critique fixes B and G), Unicode words (H), and the name folds the clone rule uses (F).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameFeatures, nameKey, nameRest, camelParts, bestCut, featureOk, featsText, parseFeats, FUNCTION_WORDS, NAME_FILLER, MAX_FEATURES } from "../lib/name-features.mjs";

// a vocabulary: elon, harry, cat, christ and leone are known tokens; christmas and thomas have their own history
const WHOLE = { elon: 900, harry: 400, cat: 3000, christ: 60, christmas: 800, thomas: 200, leone: 50, dog: 2000, mas: 30 };
const vocab = (extra = {}) => { const w = { ...WHOLE, ...extra }; return { whole: (f) => w[f] ?? 0, known: (f) => ["elon", "harry", "cat", "christ", "leone", "dog"].includes(f), n: 1_000_000 }; };
const fs = (name, symbol = "", v = vocab()) => nameFeatures(name, symbol, v).map((x) => (x.how === "s" ? `${x.f}:s:${x.other}` : `${x.f}:${x.how}`));

test("every example of the spec: a new compound splits around its known token; a word with history, an abbreviation and three CJK characters stay whole", () => {
  assert.deepEqual(fs("Elonmas"), ["elonmas:w", "elon:s:mas", "mas:s:elon"]);
  assert.deepEqual(fs("Harrymas"), ["harrymas:w", "harry:s:mas", "mas:s:harry"]);
  assert.deepEqual(fs("HarryMas"), ["harrymas:w", "harry:p", "mas:p"], "camel parts need no vocabulary and no cut is tried");
  assert.deepEqual(fs("HarryMas", "", null), ["harrymas:w", "harry:p", "mas:p"]);
  assert.deepEqual(fs("Veto Corleone"), ["veto:w", "corleone:w", "leone:s:cor", "cor:s:leone"], "leone known and corleone new: split (the context rule stops it forming)");
  assert.deepEqual(fs("vetocat"), ["vetocat:w", "cat:s:veto", "veto:s:cat"]);
  assert.deepEqual(fs("Christmas"), ["christmas:w"], "christ is known but christmas is not new");
  assert.deepEqual(fs("Thomas"), ["thomas:w"]);
  assert.deepEqual(fs("NVDA"), ["nvda:w"]);
  assert.deepEqual(fs("汤姆猫"), ["汤姆猫:w"], "no cut leaves 2 + 2 of 3 code points");
});

test("camel boundaries: XMASTree, iPhone, DeFi, a digit stays with the part before it", () => {
  assert.deepEqual(camelParts("XMASTree"), ["XMAS", "Tree"]);
  assert.deepEqual(camelParts("iPhone"), ["i", "Phone"]);
  assert.deepEqual(camelParts("DeFi"), ["De", "Fi"]);
  assert.deepEqual(camelParts("Veto2Cat"), ["Veto2", "Cat"]);
  assert.deepEqual(camelParts("VETO"), ["VETO"]);
  assert.deepEqual(fs("XMASTree"), ["xmastree:w", "xmas:p", "tree:p"]);
  assert.deepEqual(fs("iPhone"), ["iphone:w", "phone:p"], "a one-letter part is no feature");
  assert.deepEqual(fs("DeFi"), ["defi:w"], "two-letter ASCII parts are no features");
});

test("symbol words are whole words; the strongest carriage wins; function words and numbers are dropped; at most 12 features", () => {
  assert.deepEqual(fs("Mr Veto", "VETO"), ["veto:w"], "the symbol repeats a name word: one feature");
  assert.deepEqual(fs("Big Dog", "BDOG"), ["big:w", "dog:w", "bdog:w"]);
  assert.deepEqual(fs("DogCoin", "dogcoin"), ["dogcoin:w", "dog:p", "coin:p"], "dogcoin is whole (w) though a split would also carry it");
  assert.deepEqual(fs("The 2025 cat of the year"), ["cat:w", "year:w"], "the, of, numbers and short words are no features");
  for (const w of FUNCTION_WORDS) assert.equal(featureOk(w), false, w);
  assert.equal(featureOk("12345"), false); assert.equal(featureOk("ab"), false); assert.equal(featureOk("猫猫"), true); assert.equal(featureOk("x".repeat(33)), false);
  const many = nameFeatures("alpha bravo charlie delta echoes foxtrot golfer hotel india juliet kilos limas mikes", "NOVEMBER", null);
  assert.equal(many.length, MAX_FEATURES); assert.equal(many[0].f, "alpha");
});

test("fix B: Christmas, Thomas and Dogmas split only while the whole word has no history of its own", () => {
  assert.deepEqual(fs("Dogmas"), ["dogmas:w", "dog:s:mas", "mas:s:dog"], "no history: a formation");
  assert.deepEqual(fs("Dogmas", "", vocab({ dogmas: 500 })), ["dogmas:w"], "a word with its own history is a word");
  assert.deepEqual(fs("Dogmas", "", vocab({ dogmas: 150 })), ["dogmas:w"], "over 1 in 10,000 launches");
  assert.deepEqual(fs("Dogmas", "", vocab({ dogmas: 90 })), ["dogmas:w", "dog:s:mas", "mas:s:dog"], "under 1 in 10,000 and a tenth of dog's: still new");
  assert.deepEqual(fs("Christmas", "", vocab({ christmas: 0 })), ["christmas:w", "christ:s:mas", "mas:s:christ"], "without its history it would split");
  assert.deepEqual(fs("Thomas", "", vocab({ thomas: 0 })), ["thomas:w"], "tho is not a known token and mas is not either");
});

test("one cut per word: the longest known side, then the higher whole count, then the prefix side", () => {
  const v = (known, whole) => ({ whole: (f) => whole[f] ?? 0, known: (f) => known.includes(f), n: 1e6 });
  assert.deepEqual(bestCut("catdogs", v(["cat", "dogs"], { cat: 10, dogs: 10 })), { known: "dogs", rest: "cat" }, "dogs is longer");
  assert.deepEqual(bestCut("catdog", v(["cat", "dog"], { cat: 10, dog: 50 })), { known: "dog", rest: "cat" }, "same length: dog has more history");
  assert.deepEqual(bestCut("catdog", v(["cat", "dog"], { cat: 10, dog: 10 })), { known: "cat", rest: "dog" }, "a full tie: the prefix side");
  assert.equal(bestCut("catdo", v(["cat"], { cat: 10 })), null, "under 6 code points");
  assert.equal(bestCut("cat123", v(["cat"], { cat: 10 })), null, "the residual needs a letter");
  assert.equal(nameFeatures("catdog", "", v(["cat", "dog"], { cat: 10, dog: 10 })).length, 3, "one cut: the word and two sides");
});

test("nameKey folds Veto, VETO coin and The Veto; nameRest is the rest of the name with clone words and digits gone", () => {
  assert.equal(nameKey("Veto"), "veto"); assert.equal(nameKey("VETO coin"), "veto"); assert.equal(nameKey("The Veto"), "veto");
  assert.equal(nameKey("The Coin"), "the coin", "nothing left: the unfiltered words");
  for (const n of ["Vetocat", "Vetocat 2", "Vetocat AI", "Vetocat Inu", "Vetocat 2.0"]) assert.equal(nameRest(n, "vetocat", "w"), "", n);
  assert.equal(nameRest("Mr Veto", "veto", "w"), "mr"); assert.equal(nameRest("MR. VETO", "veto", "w"), "mr"); assert.equal(nameRest("Veto Cat", "veto", "w"), "cat");
  assert.equal(nameRest("DON VETO CORLEONE", "veto", "w"), "corleone don"); assert.equal(nameRest("Corleone Don Veto", "veto", "w"), "corleone don", "word order is not a new name");
  assert.equal(nameRest("HarryMas", "mas", "p"), "harry"); assert.equal(nameRest("The Vetocat", "veto", "s", "cat"), "~cat");
  assert.ok(NAME_FILLER.includes("inu") && NAME_FILLER.includes("ai"));
});

test("features round-trip through the stored text", () => {
  const f = nameFeatures("Elonmas", "XMAS", vocab());
  assert.equal(featsText(f), "elonmas:w,xmas:w,elon:s:mas,mas:s:elon");
  assert.deepEqual(parseFeats(featsText(f)), f);
  assert.deepEqual(parseFeats(""), []);
});
