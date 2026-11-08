// A root agent's "purpose" (DESIGN §13): what the coin is about, in a form the designer can use.
// Built from the root's own words (name, ticker, description, socials) and the names of the
// children it already has, once per agent (rebuilt on demand from the CLI):
//   { summary ≤ 280 chars, themes: 3-8 keywords, tone, avoid[], palette: 2-3 hex, source, builtAt }
// The language model writes it when one is configured; otherwise, or when its answer does not
// validate, a deterministic fallback extracts keywords and picks a tone and palette from them.
import { createHash } from "node:crypto";
import { namedEntity, entityWords, hasSlur, wordsOf } from "./blocklist.mjs";

export const SUMMARY_MAX = 280;
const THEMES_MIN = 3, THEMES_MAX = 8, THEME_LEN = 24;
export const BASE_AVOID = ["real people's names", "brand names and trademarks", "slurs or hateful language", "price promises or financial advice"];

/** Tone families: the words that suggest one, the tone line and the base palette (accent, second, deep). */
export const FAMILIES = [
  { key: "organic", tone: "organic, curious, grow-together", palette: ["#b6ff5c", "#2f8f4e", "#0b1a12"],
    words: ["spore", "spores", "mycelium", "mushroom", "mushrooms", "fungi", "fungus", "hyphae", "shroom", "shrooms", "moss", "forest", "tree", "trees", "root", "roots", "seed", "seeds", "sprout", "bloom", "garden", "nature", "grow", "grows", "psilocybe", "mycology", "micology", "connected"] },
  { key: "technical", tone: "calm, technical, quietly confident", palette: ["#b08cff", "#3c2c7a", "#0c0a1a"],
    words: ["privacy", "private", "zk", "zero", "knowledge", "protocol", "layer", "infrastructure", "wallet", "wallets", "defi", "shield", "encrypted", "terminal", "code", "onchain", "chain", "launchpad", "vanity", "address", "addresses", "random", "hash", "proof", "data", "agent", "bot", "simulator", "simulation", "hivemind", "truth"] },
  { key: "gritty", tone: "gritty, satirical, street-smart humor", palette: ["#ff4fa3", "#28e0c8", "#140a16"],
    words: ["crime", "heist", "gang", "city", "street", "streets", "santos", "vice", "worse", "chaos", "villain", "outlaw", "shadow", "hustle", "cars", "police", "gta", "getaway", "racing"] },
  { key: "playful", tone: "playful, irreverent meme energy", palette: ["#ffcf3f", "#ff7a59", "#1a1208"],
    words: ["meme", "memes", "doge", "pepe", "frog", "cat", "cats", "dog", "dogs", "inu", "shiba", "kitty", "baby", "lol", "fun", "funny", "bonk", "moon", "degen", "dope", "goat", "ape", "monkey", "memecoin"] },
];

const STOP = new Set(("a an and are as at be been but by can for from get gets got has have how if in into is it its just more most new now of on one or our out over so than that the their them then there these they this to too up us was we what when where which who will with you your all any each few other some such no nor not only own same very s t don should " +
  "coin coins token tokens solana sol pump fun pumpfun crypto official community project time post posts make making made like via get yours www com https http x twitter telegram website launch " +
  "child children parent under while within through across about after before also still back again many much even here well being doing going want need look see first best every good great big little real next " +
  "simple easy available based using use used help helps makes create creates created explore enable enables enabling users user manage assets greater control financial information expose staying already know " +
  "experience leveraging technology preserving transactions designed design accessible activity way day world life people built build home join holders hold buy sell price chart dev devs team").split(/\s+/));

// Nationalities, ethnicities and religions are never themes: a coin named after a people is a bad idea
// however the root's community uses the word.
const NOT_THEMES = new Set("chinese japanese korean african american mexican jewish jew arab arabic indian asian russian european muslim christian hindu black white".split(" "));

const clip = (s, max) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); if (t.length <= max) return t; const cut = t.slice(0, max - 1); const sp = cut.lastIndexOf(" "); return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, "")}…`; };
const hash32 = (s) => createHash("sha256").update(String(s)).digest().readUInt32BE(0);
const isHex = (s) => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s.trim());

/** What the profile is built from, read off the model: the root's words plus its children's names (most locked value first). */
export function profileInput(model, mint, { maxChildren = 120 } = {}) {
  const c = model.get(mint);
  const { name, symbol } = model.nameOf(mint);
  const meta = c ? model.metaFor(c) : null;
  const d = model.computed();
  const kids = model.childrenOf(mint).sort((a, b) => (d.get(b.mint)?.lockedUsd ?? -1) - (d.get(a.mint)?.lockedUsd ?? -1));
  const names = [], symbols = [];
  for (const k of kids) {
    const n = model.nameOf(k.mint);
    if (n.symbol) symbols.push(n.symbol);
    const label = n.name || n.symbol;
    if (label && names.length < maxChildren && !names.includes(label)) names.push(label);
  }
  return { mint, name, symbol, description: meta?.description ?? null, twitter: meta?.twitter ?? null, telegram: meta?.telegram ?? null, website: meta?.website ?? null, children: names, childSymbols: symbols };
}

/** Keywords by weight: capitalised phrases of the description ×3, name words ×3, ticker ×2, description words 2 → 0.5 by position, child-name words used by 2+ children ×(number of children). */
export function keywords(input) {
  const score = new Map();
  // Words that only appear as part of a named brand or person ("grand theft auto") are not themes.
  const banned = new Set([input.name, input.description, ...(input.children ?? [])].flatMap((t) => [...entityWords(t ?? "")]));
  const add = (w, k) => { if (w.length < 3 || STOP.has(w) || NOT_THEMES.has(w) || banned.has(w) || /^\d+$/.test(w) || namedEntity(w) || hasSlur(w)) return; score.set(w, (score.get(w) ?? 0) + k); };
  const desc = String(input.description ?? "").slice(0, 600);
  for (const m of desc.matchAll(/(^|[.!?]\s+|\s)((?:[A-Z][a-z]+\s+){1,2}[A-Z][a-z]+)/g)) {
    // A phrase that opens a sentence carries the sentence's first word ("Making Los Santos"): drop it.
    let words = m[2].split(/\s+/);
    if (m[1] === "" || /[.!?]/.test(m[1])) words = words.slice(1);
    if (words.length >= 2) { const p = words.join(" ").toLowerCase(); if (!namedEntity(p) && !hasSlur(p)) score.set(p, (score.get(p) ?? 0) + 3); }
  }
  for (const w of wordsOf(input.name)) add(w, 3);
  const sym = String(input.symbol ?? "").toLowerCase();
  if (/^[a-z]{3,}$/.test(sym)) add(sym, 2);
  // Earlier description words weigh more: the first sentence usually says what the coin is.
  wordsOf(desc).slice(0, 120).forEach((w, i) => add(w, Math.max(0.5, 2 * (1 - i / 120))));
  // A child-name word counts only when at least two children use it: recurring motifs ("cat",
  // "baby", the root's own name) say what the tree is about; a single child's name says little.
  const childWords = new Map();
  for (const n of input.children ?? []) for (const w of new Set(wordsOf(n))) childWords.set(w, (childWords.get(w) ?? 0) + 1);
  for (const [w, n] of childWords) if (n >= 2) add(w, n);
  // Fold plurals into a singular that is also present ("cats" into "cat").
  for (const w of [...score.keys()]) if (w.length > 4 && w.endsWith("s") && score.has(w.slice(0, -1))) { score.set(w.slice(0, -1), score.get(w.slice(0, -1)) + score.get(w)); score.delete(w); }
  // A phrase absorbs its words so "los santos" does not also list "santos".
  for (const p of [...score.keys()].filter((k) => k.includes(" "))) for (const w of p.split(" ")) score.delete(w);
  return [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);
}

/**
 * The tone family whose words weigh most: the root's name and ticker ×3, its description ×2, its
 * children ×0.5 capped at 3 (a tree of cat coins under a privacy coin is still a privacy coin).
 * Playful when nothing matches.
 */
export function familyOf(input) {
  const own = wordsOf([input.name, input.symbol].join(" ")), desc = wordsOf(input.description ?? ""), kids = (input.children ?? []).flatMap((n) => wordsOf(n));
  let best = FAMILIES[3], bestScore = 0;
  for (const f of FAMILIES) {
    const set = new Set(f.words), hits = (ws) => ws.filter((w) => set.has(w)).length;
    const score = 3 * hits(own) + 2 * hits(desc) + Math.min(3, 0.5 * hits(kids));
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best;
}

// ---- colours: the family palette, hue-shifted per root so two agents of one family differ
const hexToHsl = (hex) => {
  const n = parseInt(hex.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};
const hslToHex = ([h, s, l]) => {
  const f = (n) => { const k = (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};
export function shiftPalette(palette, seed) {
  const shift = (hash32(seed) % 41) - 20;
  return palette.map((hex) => { const [h, s, l] = hexToHsl(hex); return hslToHex([(h + shift + 360) % 360, s, l]); });
}

/** The deterministic profile: keywords, family tone and palette, a templated summary. */
export function fallbackProfile(input, { now = Math.floor(Date.now() / 1000) } = {}) {
  const family = familyOf(input);
  let themes = keywords(input).filter((t) => t.length <= THEME_LEN).slice(0, THEMES_MAX);
  for (const pad of [family.key === "organic" ? "growth" : "community", "memes", "culture"]) if (themes.length < THEMES_MIN && !themes.includes(pad)) themes.push(pad);
  const sym = input.symbol ? `$${String(input.symbol).toUpperCase()}` : "This root";
  const first = String(input.description ?? "").split(/(?<=[.!?])\s+/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  // The first sentence is clipped on its own so the summary keeps its closing clause.
  const about = first ? clip(first.replace(/[.!?]+$/, ""), 170) : `a ${family.tone.split(",")[0]} community coin`;
  const summary = clip(`${sym}${input.name ? ` (${input.name})` : ""}: ${about}${about.endsWith("…") ? "" : "."} Its children riff on ${themes.slice(0, 3).join(", ")}.`, SUMMARY_MAX);
  return {
    summary, themes, tone: family.tone,
    avoid: [...BASE_AVOID, ...(input.symbol ? [`clones of ${sym}`] : [])],
    palette: shiftPalette(family.palette, input.mint ?? input.symbol ?? ""),
    source: "fallback", builtAt: now,
  };
}

/** Validates a model answer field by field; anything missing or malformed comes from `fallback`. */
export function cleanProfile(raw, fallback) {
  const out = { ...fallback };
  let fromModel = 0;
  if (typeof raw?.summary === "string" && raw.summary.trim().length >= 20) { out.summary = clip(raw.summary, SUMMARY_MAX); fromModel++; }
  if (Array.isArray(raw?.themes)) {
    const t = [...new Set(raw.themes.filter((x) => typeof x === "string").map((x) => x.toLowerCase().replace(/[^a-z0-9 '-]/g, "").replace(/\s+/g, " ").trim()).filter((x) => x.length >= 2 && x.length <= THEME_LEN && !namedEntity(x) && !hasSlur(x) && !x.split(" ").some((w) => NOT_THEMES.has(w))))].slice(0, THEMES_MAX);
    if (t.length >= THEMES_MIN) { out.themes = t; fromModel++; }
  }
  if (typeof raw?.tone === "string" && raw.tone.trim() && raw.tone.length <= 80) out.tone = clip(raw.tone, 60);
  if (Array.isArray(raw?.avoid)) out.avoid = [...new Set([...BASE_AVOID, ...raw.avoid.filter((x) => typeof x === "string" && x.trim()).map((x) => clip(x, 60))])].slice(0, 10);
  if (Array.isArray(raw?.palette)) { const p = raw.palette.filter(isHex).map((x) => x.trim().toLowerCase()).slice(0, 3); if (p.length >= 2) out.palette = p; }
  out.source = fromModel === 2 ? "model" : "fallback";
  return out;
}

const SYSTEM = "You study a meme coin community on pump.fun and describe its purpose so new coins can be launched under it on the same theme. Answer with one JSON object and nothing else.";

/** The profile: from the language model when it answers with a valid one, else the fallback. */
export async function buildProfile(input, { llm = null, log = console, now = Math.floor(Date.now() / 1000) } = {}) {
  const fallback = fallbackProfile(input, { now });
  if (!llm?.available) return fallback;
  const user = JSON.stringify({
    coin: { name: input.name, ticker: input.symbol, description: input.description, twitter: input.twitter, telegram: input.telegram, website: input.website },
    existingChildren: (input.children ?? []).slice(0, 40),
    reply: {
      summary: `what this coin and its community are about, at most ${SUMMARY_MAX} characters`,
      themes: `${THEMES_MIN}-${THEMES_MAX} short lowercase keywords new child coins can play on`,
      tone: "a few words describing the voice",
      avoid: "things new coins under it must avoid",
      palette: "2-3 hex colours like #aabbcc that fit its look",
    },
    rules: ["never use real people's names or brand names as themes", "plain text, no hashtags, no emojis"],
  });
  try {
    const raw = await llm.chatJson([{ role: "system", content: SYSTEM }, { role: "user", content: user }], { maxTokens: 600, temperature: 0.4 });
    return cleanProfile(raw, fallback);
  } catch (e) {
    log.warn?.(`agents: profile for ${input.mint ?? input.symbol}: language model unavailable (${e.message}); fallback used`);
    return fallback;
  }
}
