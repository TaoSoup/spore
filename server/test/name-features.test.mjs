// Name features for the name waves (lib/name-features.mjs): whole words, camelCase parts, known token + residual only
// inside a word that is itself new (critique fixes B and G), Unicode words (H), and the name folds the clone rule uses (F).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameFeatures, nameKey, nameRest, camelParts, bestCut, featureOk, featsText, parseFeats, featsV2, FUNCTION_WORDS, NAME_FILLER, SUFFIXES, MAX_FEATURES } from "../lib/name-features.mjs";

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

test("symbol-only words are y (v2); the strongest carriage wins; function words and numbers are dropped; at most 12 features", () => {
  assert.deepEqual(fs("Mr Veto", "VETO"), ["veto:w"], "the symbol repeats a name word: one feature");
  assert.deepEqual(fs("Big Dog", "BDOG"), ["big:w", "dog:w", "bdog:y"], "a word only the symbol carries is the weakest label (v2)");
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
  assert.equal(featsText(f), "elonmas:w,elon:s:mas,mas:s:elon,xmas:y");
  assert.deepEqual(parseFeats(featsText(f)), f);
  assert.deepEqual(parseFeats(""), []);
});

test("rules v2: no grammar-suffix cut (buy + ing, farm + ing, pump + ing); a new compound still splits; a prefix-side residual is unaffected", () => {
  const v = vocab({ buy: 500, farm: 300, pump: 800 });
  const known = (f) => ["elon", "harry", "cat", "christ", "leone", "dog", "buy", "farm", "pump"].includes(f);
  const vk = { ...v, known };
  assert.equal(bestCut("buying", vk), null, "buy + ing is grammar");
  assert.equal(bestCut("farming", vk), null);
  assert.equal(bestCut("pumping", vk), null);
  assert.equal(bestCut("dogness", vk), null, "ness");
  assert.deepEqual(fs("Buying Dog", "", vk), ["buying:w", "dog:w"]);
  assert.deepEqual(bestCut("elonmas", vk), { known: "elon", rest: "mas" }, "-mas is not a grammar suffix");
  assert.deepEqual(bestCut("ingcat", vk), { known: "cat", rest: "ing" }, "only the suffix side is refused");
  assert.ok(Object.isFrozen(SUFFIXES) && SUFFIXES.includes("ing") && SUFFIXES.every((x) => x.length >= 3));
});

test("rules v2: the suffix cut is refused when the ending itself is a known token (ing + buy, less + hope)", () => {
  const known = (f) => ["elon", "dog", "buy", "farm", "ing", "hope", "less", "care", "able", "drink", "fash", "ion"].includes(f);
  const vk = { whole: (f) => ({ elon: 900, dog: 2000, buy: 500, farm: 300, ing: 50, hope: 400, less: 80, care: 300, able: 60, drink: 100, fash: 20, ion: 40 })[f] ?? 0, known, n: 1_000_000 };
  for (const w of ["buying", "farming", "hopeless", "careless", "drinkable", "fashion"]) assert.equal(bestCut(w, vk), null, w);
  assert.deepEqual(fs("Hopeless Dog", "HOPE", vk), ["hopeless:w", "dog:w", "hope:y"]);
  assert.deepEqual(fs("Buying Dog", "ING", vk), ["buying:w", "dog:w", "ing:y"]);
  assert.deepEqual(bestCut("elonmas", vk), { known: "elon", rest: "mas" }, "a new compound still splits");
});

test("rules v2: a word only the symbol carries is y; a word the name carries keeps w or p; symbol words are not split", () => {
  assert.deepEqual(fs("Peter Waves", "URCOIN"), ["peter:w", "waves:w", "urcoin:y"]);
  assert.deepEqual(fs("UrCoin", "URCOIN"), ["urcoin:w", "coin:p"], "the name carries it: w");
  assert.deepEqual(fs("HarryMas", "MAS"), ["harrymas:w", "harry:p", "mas:p"], "a camel part beats the symbol");
  assert.deepEqual(fs("Big", "ELONMAS"), ["big:w", "elonmas:y"], "no cut of a ticker");
  assert.deepEqual(parseFeats("urcoin:y,peter:w,mas:p,elon:s:mas"), [{ f: "urcoin", how: "y" }, { f: "peter", how: "w" }, { f: "mas", how: "p" }, { f: "elon", how: "s", other: "mas" }]);
  const f = nameFeatures("Peter Waves", "URCOIN", vocab());
  assert.deepEqual(parseFeats(featsText(f)), f);
});

test("featsV2 reads v1 launch features as v2: a symbol word stored as w becomes y, a split of a symbol word goes, name features stay", () => {
  assert.deepEqual(featsV2(parseFeats("big:w,dog:w,bdog:w"), "Big Dog"), [{ f: "big", how: "w" }, { f: "dog", how: "w" }, { f: "bdog", how: "y" }]);
  assert.deepEqual(featsV2(parseFeats("big:w,elonmas:w,elon:s:mas,mas:s:elon"), "Big"), [{ f: "big", how: "w" }, { f: "elonmas", how: "y" }]);
  assert.deepEqual(featsV2(parseFeats("harrymas:w,harry:p,mas:p,xmas:w"), "HarryMas"), [{ f: "harrymas", how: "w" }, { f: "harry", how: "p" }, { f: "mas", how: "p" }, { f: "xmas", how: "y" }]);
  assert.deepEqual(featsV2(parseFeats("vetocat:w,cat:s:veto,veto:s:cat"), "The Vetocat"), parseFeats("vetocat:w,cat:s:veto,veto:s:cat"), "a split of a name word stays");
  const v2 = nameFeatures("Elonmas", "XMAS", vocab());
  assert.deepEqual(featsV2(parseFeats(featsText(v2)), "Elonmas"), v2, "a v2 row comes back unchanged");
});

test("featsV2 drops both halves of a v1 grammar-suffix cut, whichever side was known; other cuts of the same name stay", () => {
  assert.deepEqual(featsV2(parseFeats("buying:w,buy:s:ing,ing:s:buy"), "Buying"), [{ f: "buying", how: "w" }]);
  assert.deepEqual(featsV2(parseFeats("hopeless:w,less:s:hope,hope:s:less,dog:w"), "Hopeless Dog"), [{ f: "hopeless", how: "w" }, { f: "dog", how: "w" }]);
  assert.deepEqual(featsV2(parseFeats("buying:w,elonmas:w,buy:s:ing,ing:s:buy,elon:s:mas,mas:s:elon"), "Buying Elonmas"),
    parseFeats("buying:w,elonmas:w,elon:s:mas,mas:s:elon"));
  assert.deepEqual(featsV2(parseFeats("ingcat:w,cat:s:ing,ing:s:cat"), "Ingcat"), parseFeats("ingcat:w,cat:s:ing,ing:s:cat"), "the ending on the prefix side is no suffix cut");
});

test("rules v3: featsV2 with dropCuts drops every split (made with an older vocabulary) and keeps whole words, parts and symbol words", () => {
  const stored = parseFeats("sisterdog:w,sister:p,dog:p,elonmas:w,elon:s:mas,mas:s:elon,terrier:w,ter:s:rier,rier:s:ter,xmas:y");
  const name = "SisterDog Elonmas Terrier";
  const v3 = featsV2(stored, name, { dropCuts: true });
  assert.equal(v3.filter((x) => x.how === "s").length, 0, "no split survives");
  assert.deepEqual(v3, parseFeats("sisterdog:w,sister:p,dog:p,elonmas:w,terrier:w,xmas:y"));
  assert.deepEqual(featsV2(stored, name).filter((x) => x.how === "s").map((x) => x.f), ["elon", "mas", "ter", "rier"], "without dropCuts a split of a name word stays");
  assert.deepEqual(featsV2(parseFeats("big:w,dog:w,bdog:w"), "Big Dog", { dropCuts: true }), [{ f: "big", how: "w" }, { f: "dog", how: "w" }, { f: "bdog", how: "y" }], "a v1 symbol word still becomes y");
});
