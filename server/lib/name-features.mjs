// Name features for the name waves (lib/waves.mjs, WAVES=shadow): what a launch's name and symbol are made of, in one
// namespace. A feature is a lower-case run of letters and digits; how it was carried is a label, not another feature:
//  - "w": a whole word of the name;
//  - "p": a camelCase part of a name word ("HarryMas" → harry, mas), taken before lower-casing, which words() loses;
//  - "s": a known token and its residual inside a whole word of the name that is itself new ("Elonmas" → elon + mas when
//    "elon" is a known token and "elonmas" has no history of its own), so a naming format ("-mas") and a referent word
//    ("jensen") are counted by the same test. A word with its own history is a word, not a formation: "Christmas" never
//    splits into christ + mas (critique fix B), and "Thomas" never does either ("tho" is not a known token);
//  - "y" (rules v2): a whole word that comes only from the symbol, not from any word or camelCase part of the name. It is
//    the weakest carriage, so a feature the name carries keeps "w"/"p"/"s"; lib/waves.mjs offers a "y" carrier as a
//    candidate but never counts it toward a formation and never lets it join by name alone (a ticker such as "URCOIN"
//    on a coin named something else is another story). Symbol words are not split (v2): a cut of a ticker would be a
//    symbol-only carriage too.
// Rules v2 also refuses grammar-suffix cuts: a new word is never split into a known stem and an inflection or derivation
// ending ("buying" → buy + "ing", "farming", "pumping"), whose residual gathered 102 unrelated coins into one wave in
// the v1 run (SUFFIXES). The cut is refused whichever side is the known token: "ing" itself becomes known once ING
// tickers count as whole words, and buy+"ing" must not come back as "ing"+buy.
// Unicode letters and digits count (critique fix H; the same split as lib/narrtags.mjs titleKey), so a non-ASCII name is
// a name. Pure: no imports, no state; the vocabulary is handed in (lib/name-counts.mjs builds it from 30 days of counts).
//
// Known limits, on purpose:
//  - a single CJK character is not a feature (2 code points at least outside ASCII, 3 inside);
//  - once a compound has history of its own its clones stop feeding the residual: "elonmas" coins a week later count as
//    "elonmas", not as "-mas";
//  - abbreviations, misspellings and ticker cuts (NVDA, J3NSEN) are other features (critique I);
//  - a suffix cut refused leaves the word's other cuts: a doubled consonant ("running" → run + "ning") still cuts.

/** Words that are never a feature: grammar only, no topical word (the burst test, not a ban list, judges topics). */
export const FUNCTION_WORDS = Object.freeze(["the", "and", "for", "with", "from", "you", "your", "his", "her", "its", "our", "not", "this", "that", "are", "was", "were", "has", "have", "had", "but", "all", "any", "who", "what", "when", "how", "why", "into", "onto", "over", "out", "off", "she", "him", "they", "them", "their", "will", "can"]);
/**
 * Words dropped from a name before names are compared (nameKey, nameRest): articles, "coin"/"token"/"official", the
 * chain, and the common clone suffixes ("Vetocat AI", "Vetocat Inu", "Vetocat 2" are one name: review fix for F).
 * Digit-only words are dropped as well, by rule.
 */
export const NAME_FILLER = Object.freeze(["the", "a", "an", "of", "on", "coin", "token", "official", "sol", "solana", "inu", "ai", "2", "20", "real", "og", "classic", "v2", "ceo", "wif"]);

/**
 * English inflection and derivation endings of 3+ letters (rules v2): a cut whose right-hand (suffix) side is one of these
 * ("buy" + "ing") is grammar, not a naming format, and is never made, whether the stem or the ending is the known token.
 * Like FUNCTION_WORDS this is grammar, not a topic ban list (the burst test judges topics). A cut whose ending sits on
 * the prefix (left) side is not affected.
 */
export const SUFFIXES = Object.freeze(["ing", "ings", "ers", "est", "ies", "ion", "ions", "ness", "ment", "ments", "able", "ible", "ful", "less", "ism", "isms", "ist", "ists", "ity", "ous", "ive", "ish"]);

const FUNC = new Set(FUNCTION_WORDS), FILLER = new Set(NAME_FILLER), SUFFIX = new Set(SUFFIXES);
const SPLIT = /[^\p{L}\p{N}]+/u, LETTER = /\p{L}/u, NON_ASCII = /[^\x00-\x7f]/, DIGITS = /^\p{N}+$/u;
const UP = /\p{Lu}/u, LOW = /\p{Ll}/u, NUM = /\p{N}/u;
const STRENGTH = { w: 0, p: 1, s: 2, y: 3 };
export const MAX_FEATURES = 12;

/** NFKC, apostrophes removed, split on anything that is not a letter or digit; case kept. */
export function rawWords(text) { return String(text ?? "").normalize("NFKC").replace(/['’]/g, "").split(SPLIT).filter(Boolean); }

/** Code points of a string. */
const cps = (s) => Array.from(s);

/** Whether `f` may be a feature: 3+ code points (2+ with a non-ASCII one), at most 32, a letter, not a function word. */
export function featureOk(f) {
  if (!f) return false;
  const n = cps(f).length;
  return n <= 32 && n >= (NON_ASCII.test(f) ? 2 : 3) && LETTER.test(f) && !FUNC.has(f);
}

/**
 * camelCase parts of one raw word, case kept: a boundary before an upper-case letter that follows a lower-case letter
 * or a digit, and before the last upper-case letter of a run that a lower-case letter follows ("XMASTree" → XMAS,
 * Tree). Digits stay with the part before them ("Veto2Cat" → Veto2, Cat).
 */
export function camelParts(raw) {
  const c = cps(String(raw ?? "")), out = [];
  let cur = "";
  for (let i = 0; i < c.length; i++) {
    const x = c[i], prev = c[i - 1], next = c[i + 1];
    if (cur && UP.test(x) && prev && (LOW.test(prev) || NUM.test(prev) || (UP.test(prev) && next && LOW.test(next)))) { out.push(cur); cur = ""; }
    cur += x;
  }
  if (cur) out.push(cur);
  return out;
}

/** The fold used to compare names: lower case, the filler and digit-only words dropped; the unfiltered words if none is left. */
export function nameKey(name) {
  const all = rawWords(name).map((w) => w.toLowerCase());
  const kept = all.filter((w) => !FILLER.has(w) && !DIGITS.test(w));
  return (kept.length ? kept : all).join(" ");
}

/**
 * The context of a carrier of feature `f` (critique fix F, with the review's clone rule): for a word or part, the rest of
 * its name once `f`, the filler and digit-only words are gone (its words sorted, so word order does not make a new
 * name), "" for a bare-anchor name; for a split ("s"), "~" + the other side. A wave needs 3+ distinct contexts, all bare
 * names counting as one, so a clone set ("Vetocat", "Vetocat 2", "Vetocat AI") never forms one.
 */
export function nameRest(name, f, how, other = null) {
  if (how === "s") return `~${other ?? ""}`;
  const toks = [];
  for (const raw of rawWords(name)) {
    const parts = camelParts(raw).map((p) => p.toLowerCase());
    if (parts.length >= 2 && parts.includes(f)) { for (const p of parts) toks.push(p); }
    else toks.push(raw.toLowerCase());
  }
  const rest = [...new Set(toks.filter((w) => w !== f && !FILLER.has(w) && !DIGITS.test(w)))].sort();
  return rest.join(" ");
}

/** Whether a side of a cut is long enough: 3+ code points, 2+ when it has a non-ASCII character. */
const sideOk = (s, n) => n >= (NON_ASCII.test(s) ? 2 : 3);

/**
 * The one cut of a new whole word into a known token and a residual, or null: every cut leaving a long enough side on
 * both ends, where one side is known, the other has a letter, and the word is new (its own whole count at most 1 in
 * 10,000 launches, and at most a tenth of the known side's), and the right-hand side is not a grammar suffix (SUFFIXES,
 * rules v2, whichever side is known). Longest known side first, then the higher whole count, then the prefix side.
 */
export function bestCut(word, vocab) {
  if (!vocab) return null;
  const c = cps(word);
  if (c.length < 6) return null;
  const whole = vocab.whole(word) || 0, n = vocab.n || 0;
  if (n > 0 ? whole / n > 1e-4 : whole > 0) return null;
  let best = null;
  for (let i = 2; i <= c.length - 2; i++) {
    const left = c.slice(0, i).join(""), right = c.slice(i).join("");
    if (!sideOk(left, i) || !sideOk(right, c.length - i)) continue;
    // "buy" + "ing": grammar, not a formation, whichever side is the known one ("ing" is known once ING tickers count)
    if (SUFFIX.has(right)) continue;
    for (const [known, rest, prefix] of [[left, right, true], [right, left, false]]) {
      if (!vocab.known(known) || !LETTER.test(rest)) continue;
      const kw = vocab.whole(known) || 0;
      if (whole * 10 > kw) continue;
      const cand = { known, rest, len: cps(known).length, kw, prefix };
      if (!best || cand.len > best.len || (cand.len === best.len && (cand.kw > best.kw || (cand.kw === best.kw && cand.prefix && !best.prefix)))) best = cand;
    }
  }
  return best ? { known: best.known, rest: best.rest } : null;
}

/**
 * The features of a launch: `[{ f, how, other? }]`, de-duplicated with the strongest carriage kept (w, then p, then s,
 * then y), at most MAX_FEATURES (whole words first, symbol-only words last). `vocab` (`{ whole(f), known(f), n }`)
 * enables the known-token splits of the name's whole words.
 */
export function nameFeatures(name, symbol, vocab = null) {
  const out = new Map();
  const put = (f, how, other = null) => {
    if (!featureOk(f)) return;
    const prev = out.get(f);
    if (prev && STRENGTH[prev.how] <= STRENGTH[how]) return;
    out.set(f, other != null && how === "s" ? { f, how, other } : { f, how });
  };
  const nameWords = rawWords(name), symWords = rawWords(symbol);
  const wholes = [];
  for (const raw of nameWords) { const w = raw.toLowerCase(); put(w, "w"); wholes.push(w); }
  const camel = new Set();
  for (const raw of nameWords) {
    const parts = camelParts(raw);
    if (parts.length < 2) continue;
    camel.add(raw.toLowerCase());
    for (const p of parts) put(p.toLowerCase(), "p");
  }
  if (vocab) {
    for (const w of new Set(wholes)) {
      if (camel.has(w) || !featureOk(w)) continue;
      const cut = bestCut(w, vocab);
      if (!cut) continue;
      put(cut.known, "s", cut.rest); put(cut.rest, "s", cut.known);
    }
  }
  // last: a word the name carries (whole, part or split side) keeps its stronger label; the rest of the symbol is "y"
  for (const raw of symWords) put(raw.toLowerCase(), "y");
  return [...out.values()].sort((a, b) => STRENGTH[a.how] - STRENGTH[b.how]).slice(0, MAX_FEATURES);
}

/** Whether a name or symbol has a non-ASCII character (health: the share of such launches). */
export const nonAscii = (name, symbol) => NON_ASCII.test(`${name ?? ""}${symbol ?? ""}`);

/** `feats` as stored in wave_launches: "elonmas:w,elon:s:mas,mas:s:elon,xmas:y". */
export function featsText(feats) { return feats.map((x) => (x.how === "s" ? `${x.f}:s:${x.other ?? ""}` : `${x.f}:${x.how}`)).join(","); }
/** The inverse of featsText. */
export function parseFeats(text) {
  if (!text) return [];
  return String(text).split(",").filter(Boolean).map((s) => { const [f, how, other] = s.split(":"); return how === "s" ? { f, how, other: other ?? "" } : { f, how: how === "p" || how === "y" ? how : "w" }; });
}

/**
 * Launch features stored under rules v1 (wave_launches), read as v2 (lib/waves.mjs #restore): v1 labelled symbol words
 * "w" and split them, so a "w" feature that is not a lower-cased word or camelCase part of `name` becomes "y", and an
 * "s" feature whose word (the feature and its other side, in either order) is not a word of `name` goes; so do both
 * halves of a v1 grammar-suffix cut (the word is stem + ending with the ending in SUFFIXES), which v2's bestCut refuses.
 * v2 rows come back unchanged. `dropCuts` (rules v3, a launch stored before kv waveRulesAt) drops every "s" feature:
 * its cuts were made with an older vocabulary.
 */
export function featsV2(feats, name, { dropCuts = false } = {}) {
  const words = new Set(), parts = new Set();
  for (const raw of rawWords(name)) { words.add(raw.toLowerCase()); for (const p of camelParts(raw)) parts.add(p.toLowerCase()); }
  const out = [];
  for (const x of feats) {
    if (x.how === "w" && !words.has(x.f) && !parts.has(x.f)) out.push({ f: x.f, how: "y" });
    else if (x.how === "s") {
      if (dropCuts) continue;
      const o = x.other ?? "", fo = words.has(`${x.f}${o}`), of = words.has(`${o}${x.f}`);
      if (!fo && !of) continue;
      // a v1 grammar-suffix cut ("buy"+"ing", both halves): v2's bestCut refuses it, so it is not restored either
      if ((fo && SUFFIX.has(o)) || (of && SUFFIX.has(x.f))) continue;
      out.push(x);
    } else out.push(x);
  }
  return out;
}
