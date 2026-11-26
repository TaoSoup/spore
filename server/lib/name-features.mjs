// Name features for the name waves (lib/waves.mjs, WAVES=shadow): what a launch's name and symbol are made of, in one
// namespace. A feature is a lower-case run of letters and digits; how it was carried is a label, not another feature:
//  - "w": a whole word of the name or the symbol;
//  - "p": a camelCase part of a name word ("HarryMas" → harry, mas), taken before lower-casing, which words() loses;
//  - "s": a known token and its residual inside a whole word that is itself new ("Elonmas" → elon + mas when "elon" is a
//    known token and "elonmas" has no history of its own), so a naming format ("-mas") and a referent word ("jensen")
//    are counted by the same test. A word with its own history is a word, not a formation: "Christmas" never splits
//    into christ + mas (critique fix B), and "Thomas" never does either ("tho" is not a known token).
// Unicode letters and digits count (critique fix H; the same split as lib/narrtags.mjs titleKey), so a non-ASCII name is
// a name. Pure: no imports, no state; the vocabulary is handed in (lib/name-counts.mjs builds it from 30 days of counts).
//
// Known limits, on purpose:
//  - a single CJK character is not a feature (2 code points at least outside ASCII, 3 inside);
//  - once a compound has history of its own its clones stop feeding the residual: "elonmas" coins a week later count as
//    "elonmas", not as "-mas";
//  - abbreviations, misspellings and ticker cuts (NVDA, J3NSEN) are other features (critique I).

/** Words that are never a feature: grammar only, no topical word (the burst test, not a ban list, judges topics). */
export const FUNCTION_WORDS = Object.freeze(["the", "and", "for", "with", "from", "you", "your", "his", "her", "its", "our", "not", "this", "that", "are", "was", "were", "has", "have", "had", "but", "all", "any", "who", "what", "when", "how", "why", "into", "onto", "over", "out", "off", "she", "him", "they", "them", "their", "will", "can"]);
/**
 * Words dropped from a name before names are compared (nameKey, nameRest): articles, "coin"/"token"/"official", the
 * chain, and the common clone suffixes ("Vetocat AI", "Vetocat Inu", "Vetocat 2" are one name: review fix for F).
 * Digit-only words are dropped as well, by rule.
 */
export const NAME_FILLER = Object.freeze(["the", "a", "an", "of", "on", "coin", "token", "official", "sol", "solana", "inu", "ai", "2", "20", "real", "og", "classic", "v2", "ceo", "wif"]);

const FUNC = new Set(FUNCTION_WORDS), FILLER = new Set(NAME_FILLER);
const SPLIT = /[^\p{L}\p{N}]+/u, LETTER = /\p{L}/u, NON_ASCII = /[^\x00-\x7f]/, DIGITS = /^\p{N}+$/u;
const UP = /\p{Lu}/u, LOW = /\p{Ll}/u, NUM = /\p{N}/u;
const STRENGTH = { w: 0, p: 1, s: 2 };
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
 * 10,000 launches, and at most a tenth of the known side's). Longest known side first, then the higher whole count,
 * then the prefix side.
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
 * The features of a launch: `[{ f, how, other? }]`, de-duplicated with the strongest carriage kept (w, then p, then s),
 * at most MAX_FEATURES (whole words first). `vocab` (`{ whole(f), known(f), n }`) enables the known-token splits.
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
  for (const raw of [...nameWords, ...symWords]) { const w = raw.toLowerCase(); put(w, "w"); wholes.push(w); }
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
  return [...out.values()].sort((a, b) => STRENGTH[a.how] - STRENGTH[b.how]).slice(0, MAX_FEATURES);
}

/** Whether a name or symbol has a non-ASCII character (health: the share of such launches). */
export const nonAscii = (name, symbol) => NON_ASCII.test(`${name ?? ""}${symbol ?? ""}`);

/** `feats` as stored in wave_launches: "elonmas:w,elon:s:mas,mas:s:elon". */
export function featsText(feats) { return feats.map((x) => (x.how === "s" ? `${x.f}:s:${x.other ?? ""}` : `${x.f}:${x.how}`)).join(","); }
/** The inverse of featsText. */
export function parseFeats(text) {
  if (!text) return [];
  return String(text).split(",").filter(Boolean).map((s) => { const [f, how, other] = s.split(":"); return how === "s" ? { f, how, other: other ?? "" } : { f, how: how === "p" ? "p" : "w" }; });
}
