// The designer of a root agent (DESIGN §13): six candidate coins per run on the root's themes,
// filtered, then ranked by a small rubric; the winner becomes the proposal and the other survivors
// are kept as runners-up.
//
// Candidates come from the language model when one is configured (asked for more than six, the
// first six that parse are used) and otherwise, or to top the batch up, from a deterministic
// generator: theme words with nouns that fit the root's tone, portmanteaus, rhymes on the root's
// ticker. The filters are the same whatever wrote the idea:
//   - name 1-32 characters of plain text, ticker 2-10 of A-Z/0-9, description 1-280, no links
//   - no real person or brand (blocklist.mjs), no slur
//   - not a ticker one of the root's children already uses, nor one of the 2 000 biggest coins
//     the index knows, nor a child's exact name
//   - not a near-duplicate of the root's own ticker (GTA → GTA2, GTAX, GPA)
// Rubric (0-100): theme fit 45 %, brevity 25 %, uniqueness against existing tickers 30 %.
//
// A root with an owner's brief (brief.mjs, DESIGN §13.3) changes three things: the brief goes into
// the prompt as the governing instruction; the biggest-coins and near-the-root's-ticker filters do
// not apply (the owner allows any ticker), while the child, batch and own-proposal duplicates still
// do; the rubric's uniqueness term is neutral and "fit" is the order the model (or the fallback list)
// ranked the ideas in. In mode "people" each idea is one famous real person (name = full name,
// ticker = the name they go by): real names are allowed, brands are still refused in the name and
// ticker, a person already launched under the root is refused by ticker, by name and by person key
// (people.mjs), people known for atrocities never pass, and the fallback is a list of ~350 people.
import { createHash } from "node:crypto";
import { namedEntity, hasSlur, normalizeWord, wordsOf } from "./blocklist.mjs";
import { familyOf } from "./profile.mjs";
import { FAMOUS_PEOPLE, CATEGORY_LINES, HYPE_LINES, neverPerson, personKey } from "./people.mjs";
import { units } from "../pricing.mjs";

export const NAME_MAX = 32, SYMBOL_MAX = 10, SYMBOL_MIN = 2, DESC_MAX = 280, CANDIDATES = 6, TOP_COINS = 2_000;
const MAX_ROUNDS = 3;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '’.&!:,-]*$/u;
const LINK_RE = /https?:\/\/|www\.|\.(?:com|io|xyz|fun|net|org)\b/i;

/** Small seeded PRNG (mulberry32): the same root and run number give the same fallback ideas. */
export function rng(seed) {
  let a = createHash("sha256").update(String(seed)).digest().readUInt32BE(0);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];
const cap = (s) => String(s).split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
const tickerOf = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Edit distance (two-row Levenshtein); tickers are at most a few characters long. */
export function lev(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return a.length || b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i), cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Same coin as the root under another coat: equal, the root plus a character or two, or one/two edits away. */
export function nearDuplicate(symbol, rootSymbol) {
  const s = tickerOf(symbol), r = tickerOf(rootSymbol);
  if (!s || !r) return false;
  if (s === r) return true;
  if (r.length >= 3 && (s.startsWith(r) || s.endsWith(r)) && s.length - r.length <= 2) return true;
  return lev(s, r) <= (r.length <= 4 ? 1 : 2);
}

/**
 * A ticker from a name: the words joined when they fit in 10 ("Pepe Goblin" → PEPEGOBLIN), else the
 * initials of the first words and the whole last word ("Truth Cipher" → TCIPHER), else prefixes.
 */
export function symbolFor(name) {
  const words = String(name).split(/\s+/).map(tickerOf).filter(Boolean);
  const joined = words.join("");
  if (joined.length <= SYMBOL_MAX) return joined;
  const last = words[words.length - 1], initials = words.slice(0, -1).map((w) => w[0]).join("");
  if (words.length > 1 && initials.length + last.length <= SYMBOL_MAX) return initials + last;
  return words.map((w, i) => (i === words.length - 1 ? w.slice(0, 5) : w.slice(0, 3))).join("").slice(0, SYMBOL_MAX);
}

/** Trims and shapes one raw idea (from the model or the generator); null when a field is missing. */
export function normalizeIdea(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  const symbol = typeof raw.symbol === "string" ? raw.symbol.trim().replace(/^\$/, "").toUpperCase() : "";
  const description = typeof raw.description === "string" ? raw.description.replace(/\s+/g, " ").trim() : "";
  if (!name || !symbol || !description) return null;
  // The hype line (DESIGN §13.1, owner: "say why it launched this coin"): optional, one sentence.
  const why = typeof raw.why === "string" ? raw.why.replace(/\s+/g, " ").trim().slice(0, 140) : "";
  return why && !/[<>\u0000-\u001f\u007f]/.test(why) && !/https?:\/\/|www\./i.test(why) ? { name, symbol, description, why } : { name, symbol, description };
}

/**
 * Why an idea is refused, or null when it passes. `ctx`: `rootSymbol`, `childSymbols` / `topSymbols` /
 * `proposedSymbols` (Sets of uppercase tickers; the last one is the agent's own recent proposals),
 * `childNames` (Set of squashed lowercase names), `slurs` (optional index for tests); for a briefed
 * root `brief` ({ text, mode }) and, in people mode, `childPersons` / `proposedNames` (Sets of personKey).
 */
export function checkIdea(idea, ctx) {
  const { name, symbol, description } = idea;
  const brief = ctx.brief ?? null, people = brief?.mode === "people";
  if (name.length > NAME_MAX) return `name over ${NAME_MAX} characters`;
  if (!NAME_RE.test(name)) return "name must be plain text";
  if (symbol.length > SYMBOL_MAX) return `ticker over ${SYMBOL_MAX} characters`;
  if (symbol.length < SYMBOL_MIN || !/^[A-Z0-9]+$/.test(symbol)) return `ticker must be ${SYMBOL_MIN}-${SYMBOL_MAX} letters A-Z or digits`;
  if (description.length > DESC_MAX) return `description over ${DESC_MAX} characters`;
  if (/[<>\u0000-\u001f\u007f]/.test(description) || LINK_RE.test(description) || LINK_RE.test(name)) return "links and markup are not allowed";
  for (const [field, text, symbolMode] of [["name", name, false], ["ticker", symbol, true], ["description", description, false]]) {
    // People mode: real people are the point; brands stay out of the name and ticker (a description
    // may say where the person made their name), and nobody known for atrocities passes.
    if (people) {
      const never = neverPerson(text, { symbol: symbolMode });
      if (never) return `${field} names a person agents never launch (${never})`;
    }
    const hit = people ? (field === "description" ? null : namedEntity(text, { symbol: symbolMode, people: [] })) : namedEntity(text, { symbol: symbolMode });
    if (hit) return `${field} names a ${hit.kind} (${hit.term})`;
    if (hasSlur(text, ctx.slurs)) return `${field} contains a blocked word`;
  }
  if (ctx.childSymbols?.has(symbol)) return `ticker $${symbol} is already used by a child of this root`;
  if (ctx.proposedSymbols?.has(symbol)) return `this agent already proposed $${symbol}`;
  if (!brief && ctx.topSymbols?.has(symbol)) return `ticker $${symbol} belongs to one of the ${TOP_COINS} biggest coins`;
  if (ctx.childNames?.has(normalizeWord(name))) return "a child of this root already has this name";
  if (people) {
    const key = personKey(name);
    if (key && ctx.childPersons?.has(key)) return "this person already has a coin under this root";
    if (key && ctx.proposedNames?.has(key)) return "this agent already proposed this person";
  }
  if (!brief && nearDuplicate(symbol, ctx.rootSymbol)) return `ticker too close to the root's $${tickerOf(ctx.rootSymbol)}`;
  return null;
}

/** `{ total 0-100, fit, brevity, uniqueness }` of a valid idea against the profile and the known tickers. */
export function rubric(idea, profile, ctx) {
  if (ctx.brief) return briefRubric(idea, ctx.brief);
  const themeWords = new Set((profile.themes ?? []).flatMap((t) => wordsOf(t)).filter((w) => w.length >= 3));
  const touches = (text) => wordsOf(text).some((w) => themeWords.has(w) || [...themeWords].some((t) => t.length >= 4 && (w.includes(t) || (w.length >= 4 && t.includes(w)))));
  const descHits = new Set(wordsOf(idea.description).filter((w) => themeWords.has(w))).size;
  const fit = 0.6 * (touches(idea.name) || touches(idea.symbol.toLowerCase()) ? 1 : 0) + 0.4 * Math.min(1, descHits / 2);
  const s = idea.symbol.length;
  const brevity = brevityOf(idea);
  let nearest = Infinity;
  for (const set of [ctx.childSymbols, ctx.topSymbols]) for (const t of set ?? []) { if (Math.abs(t.length - s) >= nearest) continue; const d = lev(idea.symbol, t); if (d < nearest) nearest = d; if (nearest <= 1) break; }
  const uniqueness = nearest >= 3 ? 1 : nearest === 2 ? 0.7 : 0.4;
  const total = Math.round(100 * (0.45 * fit + 0.25 * brevity + 0.30 * uniqueness));
  return { total, fit: Math.round(fit * 100) / 100, brevity: Math.round(brevity * 100) / 100, uniqueness };
}

const brevityOf = (idea) => {
  const n = idea.name.length, s = idea.symbol.length;
  return 0.6 * (n <= 12 ? 1 : Math.max(0, 1 - (n - 12) / 20)) + 0.4 * (s >= 3 && s <= 6 ? 1 : s <= 8 ? 0.7 : 0.4);
};
/**
 * The rubric of a briefed root: fit is the rank the idea came in (the model is asked to list the
 * best first, the fallback list is in fame order), uniqueness is neutral, and brevity counts only
 * outside people mode (a person's name is as long as it is).
 */
function briefRubric(idea, brief) {
  const fit = Math.max(0.5, 1 - (Number.isFinite(idea.rank) ? idea.rank : 0) / 24);
  const brevity = brief.mode === "people" ? 1 : brevityOf(idea);
  const uniqueness = 1;
  const total = Math.round(100 * (0.45 * fit + 0.25 * brevity + 0.30 * uniqueness));
  return { total, fit: Math.round(fit * 100) / 100, brevity: Math.round(brevity * 100) / 100, uniqueness };
}

// ---------------------------------------------------------------- people mode fallback
const fill = (s, map) => s.replace(/\{(\w)\}/g, (m, k) => map[k] ?? m);
/**
 * `count` famous people (people.mjs) not launched or proposed under this root yet, nor in `skip`
 * (tickers) / `skipPeople` (person keys): in fame order with a seeded jitter of a few places, so
 * two runs do not always pick the same next person.
 */
export function fallbackPeople(ctx, { seed = "", count = CANDIDATES, skip = null, skipPeople = null, jitter = 6 } = {}) {
  const r = rng(`${ctx.rootMint ?? ctx.rootSymbol}:people:${seed}`);
  const avail = [];
  FAMOUS_PEOPLE.forEach((p, i) => {
    const key = personKey(p.name);
    if (ctx.childSymbols?.has(p.symbol) || ctx.proposedSymbols?.has(p.symbol) || skip?.has(p.symbol)) return;
    if (ctx.childNames?.has(normalizeWord(p.name)) || ctx.childPersons?.has(key) || ctx.proposedNames?.has(key) || skipPeople?.has(key)) return;
    avail.push([i + r() * jitter, p]);
  });
  avail.sort((a, b) => a[0] - b[0]);
  return avail.slice(0, count).map(([, p]) => {
    const line = pick(r, CATEGORY_LINES[p.cat] ?? CATEGORY_LINES.h);
    const why = fill(pick(r, HYPE_LINES), { N: p.name, T: `$${p.symbol}` });
    return { name: p.name, symbol: p.symbol, description: `${p.name}: ${line}.`, why: why.length <= 140 ? why : `${p.name}, now onchain as $${p.symbol}.`, source: "fallback" };
  });
}

// ---------------------------------------------------------------- deterministic generator
const NOUNS = {
  organic: ["Sprout", "Spawn", "Bloom", "Puff", "Cap", "Grove", "Seedling", "Moss", "Hypha", "Glow"],
  technical: ["Node", "Relay", "Shard", "Cipher", "Signal", "Vault", "Proof", "Mesh", "Ghost", "Byte"],
  gritty: ["Crew", "Heist", "Getaway", "Outlaw", "Siren", "Turf", "Riot", "Racer", "Hustler", "Boss"],
  playful: ["Pup", "Kitten", "Goblin", "Gremlin", "Buddy", "Club", "Gang", "Frog", "Duck", "Bean"],
};
const ADJ = { organic: ["tiny", "wild", "glowing", "curious"], technical: ["quiet", "encrypted", "silent", "clever"], gritty: ["reckless", "loud", "late-night", "unhinged"], playful: ["silly", "chaotic", "tiny", "lucky"] };
const ONSETS = ["B", "D", "F", "G", "H", "J", "K", "L", "M", "N", "P", "R", "S", "T", "V", "W", "Z", "CH", "SH", "TR", "BR", "GR", "FL", "SN"];
// A rhyme is used only when it lands on a common word ("DOPE" → HOPE, NOPE, ROPE), never on a made-up one.
const COMMON = new Set(("hope nope rope cope pope dope soap mope lope " +
  "cat bat hat mat rat pat fat sat vat chat flat brat " +
  "dog fog hog log jog bog frog " +
  "fun bun run sun gun nun pun " +
  "moon soon spoon noon loon boon " +
  "pump bump dump jump lump rump hump stump " +
  "coin join loin " +
  "meme team dream cream steam scream beam seam " +
  "goat boat coat moat float " +
  "ape cape tape grape shape drape " +
  "veil mail nail tail sail rail jail hail fail pail snail trail " +
  "grove drove stove cove love dove " +
  "root boot hoot loot shoot scoot toot " +
  "spore core more bore lore pore sore store snore shore chore tore wore " +
  "doge lodge " +
  "pepe " +
  "cap map nap rap tap sap zap trap snap flap chap " +
  "bot hot lot not pot rot dot shot " +
  "pill hill mill bill fill will chill drill grill " +
  "wild mild child " +
  "game fame lame name same tame flame shame " +
  "gang bang hang rang sang fang " +
  "king ring sing wing bling thing sting " +
  "bear pear wear tear gear " +
  "duck luck truck " +
  "glow flow slow snow grow show crow blow throw " +
  "rich ditch pitch witch switch " +
  "punk junk funk bunk drunk skunk " +
  "rock sock lock dock clock shock flock " +
  "city pity witty kitty").split(/\s+/));

/** One portmanteau of two words: most of the first, the tail of the second ("spore" + "goblin" → "Spoblin"). */
export function blend(a, b) {
  const x = a.toLowerCase().replace(/[^a-z]/g, ""), y = b.toLowerCase().replace(/[^a-z]/g, "");
  if (x.length < 3 || y.length < 3) return null;
  return cap(x.slice(0, Math.ceil(x.length * 0.6)) + y.slice(Math.floor(y.length * 0.4)));
}
/** A rhyme on a ticker: its leading consonants swapped ("DOPE" → "HOPE"). Null without a vowel after the onset. */
export function rhyme(symbol, r) {
  const s = tickerOf(symbol);
  const m = s.match(/^([^AEIOUY]*)([AEIOUY][A-Z]*)$/);
  if (!m || m[2].length < 2) return null;
  const options = ONSETS.filter((o) => o !== m[1] && COMMON.has((o + m[2]).toLowerCase()));
  return options.length ? pick(r, options) + m[2] : null;
}
const article = (w) => (/^[aeiou]/i.test(w) ? "an" : "a");

/** `count` template ideas on the profile's themes, seeded so a run is reproducible. */
export function fallbackIdeas(profile, root, { seed = "", count = CANDIDATES } = {}) {
  const r = rng(`${root.mint ?? root.symbol}:${seed}`);
  const family = familyOf({ name: root.name, symbol: root.symbol, description: profile.summary, children: profile.themes });
  const nouns = NOUNS[family.key] ?? NOUNS.playful, adjs = ADJ[family.key] ?? ADJ.playful;
  const themes = (profile.themes?.length ? profile.themes : ["community"]).filter((t) => !nearDuplicate(t, root.symbol) && normalizeWord(t) !== normalizeWord(root.name));
  const T = themes.length ? themes : ["community"];
  const R = tickerOf(root.symbol) || "ROOT", rootName = root.name || `$${R}`;
  const describe = (name, a, b) => pick(r, [
    () => `${name} sprouts under $${R}: ${a} meets ${b}.`,
    () => { const adj = pick(r, adjs); return `${cap(article(adj))} ${adj} offshoot of the $${R} tree. ${cap(a)} energy, ${b} vibes, nothing serious.`; },
    () => { const adj = pick(r, adjs); return `Born in the ${rootName} family, ${name} takes ${a} and gives it ${article(adj)} ${adj} twist. Community first.`; },
    () => `${name} carries the ${a} spirit of $${R} into a new branch of the tree.`,
    () => `${cap(a)} and ${b}, the ${pick(r, adjs)} way. A new branch under $${R}.`,
  ])();
  const makers = [
    () => { const a = pick(r, T); return `${cap(a)} ${pick(r, nouns)}`; },
    () => blend(pick(r, T), pick(r, nouns)),
    () => { const w = rhyme(R, r); return w ? `${cap(w.toLowerCase())} ${cap(pick(r, T))}` : null; },
    () => `${cap(pick(r, adjs))} ${pick(r, nouns)}`,
    () => { const a = pick(r, T).split(" ")[0]; return pick(r, [`Lil ${cap(a)}`, `${cap(a)}kin`, `${cap(a)}ling`, `Mini ${cap(a)}`]); },
    () => { const a = pick(r, T), b = pick(r, T); return a !== b ? blend(a, b) : null; },
  ];
  const out = [], seen = new Set();
  for (let guard = 0; out.length < count && guard < count * 12; guard++) {
    const name = makers[guard % makers.length]();
    if (!name || name.length > NAME_MAX) continue;
    const symbol = symbolFor(name);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const a = pick(r, T), b = pick(r, T.length > 1 ? T.filter((t) => t !== a) : T);
    let description = describe(name, a, b);
    if (description.length > DESC_MAX) description = description.slice(0, DESC_MAX - 1).replace(/\s+\S*$/, "") + "…";
    out.push({ name, symbol, description, source: "fallback" });
  }
  return out;
}

// ---------------------------------------------------------------- context + the run
/** Tickers and names the filters compare against: the root's children (all of them) and the 2 000 biggest coins by market cap. */
export function designContext(model, rootMint, { top = TOP_COINS } = {}) {
  const { name: rootName, symbol: rootSymbol } = model.nameOf(rootMint);
  // childLabels (name + ticker of every child) feed a people-mode brief's "already launched" list.
  const childSymbols = new Set(), childNames = new Set(), childPersons = new Set(), childLabels = [];
  for (const k of model.childrenOf(rootMint)) {
    const n = model.nameOf(k.mint); const t = tickerOf(n.symbol);
    if (t) childSymbols.add(t);
    if (n.name) { childNames.add(normalizeWord(n.name)); const key = personKey(n.name); if (key) childPersons.add(key); }
    if (n.name || t) childLabels.push({ name: n.name ?? null, symbol: t || null });
  }
  const d = model.computed(), caps = [];
  for (const c of model.coins.values()) {
    const p = d.get(c.mint)?.priceUsd;
    if (!(p > 0)) continue;
    caps.push([p * units(c.tokenTotalSupply, model.decimalsOf(c.mint)), c.mint]);
  }
  caps.sort((a, b) => b[0] - a[0]);
  const topSymbols = new Set();
  for (const [, mint] of caps.slice(0, top)) { const t = tickerOf(model.nameOf(mint).symbol); if (t) topSymbols.add(t); }
  return { rootMint, rootName, rootSymbol, childSymbols, childNames, childPersons, childLabels, topSymbols };
}

const SYSTEM = "You invent new meme coins that will be launched as children of a parent coin on pump.fun, on the parent's theme. Answer with one JSON object and nothing else.";
const SYSTEM_BRIEFED = "You invent new meme coins that will be launched as children of a parent coin on pump.fun. The parent's owner has given you a brief: it governs every idea — follow it exactly; it overrides the parent's themes. Answer with one JSON object and nothing else.";
export const TAKEN_MAX = 400;

/** "Name ($TICKER)" of every coin already launched (children) or proposed under the root, newest proposals included, at most TAKEN_MAX. */
export function takenPeople(ctx) {
  const out = [], seen = new Set();
  for (const l of [...(ctx.childLabels ?? []), ...(ctx.proposedLabels ?? [])]) {
    const label = [l.name, l.symbol ? `($${l.symbol})` : null].filter(Boolean).join(" ");
    if (!label || seen.has(label)) continue;
    seen.add(label); out.push(label);
    if (out.length >= TAKEN_MAX) break;
  }
  return out;
}

/** The user message for the model: the default theme prompt, or a briefed one (free or people mode). */
export function ideaPrompt(profile, ctx) {
  const R = tickerOf(ctx.rootSymbol);
  const brief = ctx.brief ?? null, people = brief?.mode === "people";
  if (!brief) return JSON.stringify({
    parent: { name: ctx.rootName, ticker: ctx.rootSymbol, summary: profile.summary, themes: profile.themes, tone: profile.tone, avoid: profile.avoid },
    existingChildTickers: [...(ctx.childSymbols ?? [])].slice(0, 80),
    rules: [
      `name at most ${NAME_MAX} characters, plain text`, `symbol ${SYMBOL_MIN}-${SYMBOL_MAX} uppercase letters or digits, not an existing child ticker and not a variant of $${R}`,
      `description at most ${DESC_MAX} characters, no links, no hashtags`, "never name real people, brands or trademarks; no slurs; no price promises",
      `every coin exists to pump its parent $${R}: each trade of the child routes through the parent and parks parent tokens in the child's curve — the why line must say how this coin pushes $${R}`,
    ],
    reply: { ideas: [{ name: "string", symbol: "string", description: "string", why: "one punchy sentence, at most 140 characters: why this coin belongs under the parent right now — the hype line a trader would repeat" }], count: 8 },
  });
  const ownerBrief = { instruction: "THE OWNER'S BRIEF — follow it exactly; it overrides the themes.", text: brief.text, mode: brief.mode };
  // A people brief asks for real people: the profile's own "avoid real people" line would contradict it.
  const avoid = (profile.avoid ?? []).filter((a) => !(people && /real people|person/i.test(a)));
  if (people) return JSON.stringify({
    ownerBrief,
    parent: { name: ctx.rootName, ticker: ctx.rootSymbol, summary: profile.summary, avoid },
    takenPeople: takenPeople(ctx),
    rules: [
      "every idea is ONE real, world-famous public figure (an adult), living or historical — one person per idea, never the same person twice in this answer",
      "name = the person's full real name as the world knows it (\"Elon Musk\", \"Donald Trump\", \"Lionel Messi\"), at most 32 characters, plain text",
      `symbol = the name they are known by (ELON, TRUMP, MESSI), ${SYMBOL_MIN}-${SYMBOL_MAX} uppercase letters or digits`,
      "never anyone in takenPeople: they already have a coin under this parent (the same person under another spelling counts)",
      `description = one punchy line, at most ${DESC_MAX} characters, on why this human matters — meme tone, playful or admiring, never hateful`,
      "no slurs, no sexual content, no claims presented as facts about anyone's private life (health, relationships, family, crimes); no price promises",
      "never say or imply that the person made, owns, endorses or is connected to the coin: it is a tribute",
      "never private individuals, minors, or people known mainly for atrocities, terrorism or violent or sexual crimes",
      "no links, no hashtags, no brand names in the name or symbol",
      "list the most famous first",
    ],
    reply: { ideas: [{ name: "string", symbol: "string", description: "string", why: "one punchy sentence, at most 140 characters: a hype line about this person that a trader would repeat" }], count: 8 },
  });
  return JSON.stringify({
    ownerBrief,
    parent: { name: ctx.rootName, ticker: ctx.rootSymbol, summary: profile.summary, themes: profile.themes, tone: profile.tone, avoid },
    existingChildTickers: [...(ctx.childSymbols ?? [])].slice(0, 80),
    rules: [
      `name at most ${NAME_MAX} characters, plain text`, `symbol ${SYMBOL_MIN}-${SYMBOL_MAX} uppercase letters or digits, not an existing child ticker`,
      `description at most ${DESC_MAX} characters, no links, no hashtags`, "no slurs; no price promises; no brand names or trademarks unless the brief asks for them",
      `every coin exists to pump its parent $${R}: the why line says why this coin belongs under it`,
      "list the best idea first",
    ],
    reply: { ideas: [{ name: "string", symbol: "string", description: "string", why: "one punchy sentence, at most 140 characters: the hype line a trader would repeat" }], count: 8 },
  });
}

/** Asks the model for ideas; [] when it is not configured or fails (the generator fills in). */
async function modelIdeas(profile, ctx, { llm, log }) {
  if (!llm?.available) return [];
  const user = ideaPrompt(profile, ctx);
  try {
    const raw = await llm.chatJson([{ role: "system", content: ctx.brief ? SYSTEM_BRIEFED : SYSTEM }, { role: "user", content: user }], { maxTokens: 1200, temperature: 0.9 });
    return (Array.isArray(raw?.ideas) ? raw.ideas : []).map(normalizeIdea).filter(Boolean).map((i) => ({ ...i, source: "model" }));
  } catch (e) {
    log?.warn?.(`agents: ideas for ${ctx.rootMint}: language model unavailable (${e.message}); fallback used`);
    return [];
  }
}

/**
 * One design run: `{ best, runnersUp, filtered, source, rounds, considered }`. `best` is null when
 * no candidate survived three rounds of six. Each surviving idea carries its rubric.
 */
export async function design(profile, root, ctx, { llm = null, log = console, seed = "" } = {}) {
  const people = ctx.brief?.mode === "people";
  const fromModel = await modelIdeas(profile, ctx, { llm, log });
  const survivors = [], filtered = [], seen = new Set(), seenPeople = new Set();
  const samePerson = (x, y) => people && personKey(x.name) === personKey(y.name);
  let rounds = 0, considered = 0;
  for (let round = 0; round < MAX_ROUNDS && !survivors.length; round++) {
    rounds++;
    const batch = round === 0 ? fromModel.slice(0, CANDIDATES) : [];
    if (batch.length < CANDIDATES) {
      // People mode tops up with famous people nobody under this root has yet, never with theme templates.
      const more = people
        ? fallbackPeople(ctx, { seed: `${seed}:${round}`, count: CANDIDATES * 2, skip: seen, skipPeople: seenPeople })
        : fallbackIdeas(profile, root, { seed: `${seed}:${round}`, count: CANDIDATES * 2 });
      batch.push(...more.filter((i) => !batch.some((x) => x.symbol === i.symbol || samePerson(x, i))).slice(0, CANDIDATES - batch.length));
    }
    batch.forEach((idea, k) => {
      considered++;
      const key = people ? personKey(idea.name) : null;
      const why = seen.has(idea.symbol) ? "duplicate ticker in this batch" : checkIdea(idea, ctx) ?? (key && seenPeople.has(key) ? "duplicate person in this batch" : null);
      seen.add(idea.symbol); if (key) seenPeople.add(key);
      // The rank (position: the model's order first, then the fallback's) is the briefed rubric's fit.
      if (why) filtered.push({ name: idea.name, symbol: idea.symbol, source: idea.source, why });
      else survivors.push({ ...idea, rubric: rubric({ ...idea, rank: round * CANDIDATES + k }, profile, ctx) });
    });
  }
  survivors.sort((a, b) => b.rubric.total - a.rubric.total);
  const best = survivors[0] ?? null;
  return { best, runnersUp: survivors.slice(1).map((i) => ({ name: i.name, symbol: i.symbol })), filtered, source: best?.source ?? "fallback", rounds, considered };
}
