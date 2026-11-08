// What an agent may never put in a coin's name, ticker or description (DESIGN §13 designer filters):
// real people, brands and trademarks, slurs, and sexual or vulgar words.
//
// People and brands are listed in plain text. Slurs and vulgar words are stored only as truncated sha256 digests of
// their normalised form, so this public file does not spell them out; matching hashes every token
// (and, for the longer entries, every substring of the squashed text) the same way. Normalising
// folds case, accents and common digit/symbol substitutions ("3" for "e", "$" for "s") so trivial
// spellings do not slip through.
import { createHash } from "node:crypto";

/** Real people a coin must not be named after (heads of state, founders, celebrities, crypto figures). */
export const PEOPLE = [
  "elon musk", "elon", "musk", "donald trump", "trump", "melania", "barron trump", "joe biden", "biden", "kamala harris", "kamala", "barack obama", "obama",
  "adolf hitler", "hitler", "joseph stalin", "stalin", "pol pot", "bin laden", "osama", "vladimir putin", "putin", "zelensky", "xi jinping", "jinping", "narendra modi", "netanyahu", "erdogan", "macron", "kim jong un", "jong un", "king charles", "pope francis", "pope leo",
  "vitalik buterin", "vitalik", "buterin", "changpeng zhao", "cz", "sbf", "bankman fried", "michael saylor", "saylor", "do kwon", "justin sun", "anatoly yakovenko", "brian armstrong",
  "mark zuckerberg", "zuckerberg", "zuck", "jeff bezos", "bezos", "bill gates", "warren buffett", "buffett", "jensen huang", "tim cook", "satya nadella", "sundar pichai",
  "kanye", "ye west", "taylor swift", "beyonce", "rihanna", "eminem", "snoop dogg", "travis scott", "kim kardashian", "kardashian", "mrbeast", "mr beast", "pewdiepie", "logan paul", "jake paul",
  "andrew tate", "charlie kirk", "kirk", "joe rogan", "rogan", "cristiano ronaldo", "ronaldo", "lionel messi", "messi", "lebron", "michael jordan", "tiger woods", "neymar",
];

/** Brands and trademarks (consumer, media, games, finance and the big crypto venues). */
export const BRANDS = [
  "apple", "iphone", "google", "alphabet", "microsoft", "amazon", "netflix", "facebook", "instagram", "whatsapp", "tiktok", "youtube", "twitter", "snapchat", "reddit", "telegram", "spotify",
  "tesla", "spacex", "nvidia", "intel", "samsung", "sony", "playstation", "xbox", "nintendo", "pokemon", "pikachu", "super mario", "zelda", "sega", "sonic the hedgehog",
  "disney", "pixar", "marvel", "star wars", "mickey mouse", "warner bros", "hello kitty", "sanrio", "barbie", "lego", "hasbro", "mattel", "minecraft", "fortnite", "roblox", "grand theft auto", "vice city", "san andreas", "rockstar games",
  "nike", "adidas", "gucci", "louis vuitton", "chanel", "prada", "hermes", "rolex", "balenciaga",
  "coca cola", "cocacola", "pepsi", "red bull", "monster energy", "mcdonalds", "burger king", "starbucks", "kfc", "dominos", "walmart", "costco", "ikea",
  "ferrari", "lamborghini", "porsche", "mercedes", "bmw", "toyota", "honda", "ford", "chevrolet",
  "visa", "mastercard", "paypal", "american express", "jpmorgan", "goldman sachs", "blackrock", "robinhood",
  "binance", "coinbase", "kraken", "bybit", "okx", "phantom wallet", "metamask", "pumpfun", "pump fun", "raydium", "jupiter exchange",
];

/** Truncated sha256 (16 hex) of normalised vulgar and sexual words, matched like SLURS (merged into one index). */
export const NSFW = {
  whole: [
    "98d44e13f455d916", "7f5a9ba14cb89dc2", "8c5c04391361cbf4", "0033728f0fbc83a0", "c6603565c5159fbe", "594810adcbee20bd",
    "ad505b0be8a49b89", "99e367bcad7a502f", "796e43a5a8cdb73b", "94a2b576a9f577e9", "0f28c4960d96647e", "e99d55248f67be76",
    "7e85c676fd97d370", "13a465fc6616da8d", "1600725e92dc8cb0", "05b71b9303ad6c74", "7902e27065cfa96f", "d92f4cf1e2d7e812",
    "6577be77529947bf", "12a667c9be6ff8f6", "6ac3c336e4094835", "522788b65f01ccc0", "31506a8448a761a4", "bb61ef40814ce34c",
    "85fc17f7069acd39", "986c99004163a6c5", "59cc3cb8a4297301", "a76d588d0047e3b0", "82e695c9e75f5bc6", "793922ac29bcc4f3",
    "dd32831e9d5f3da3", "6ccffa4977d4246e", "dcd2ee35085fdfb0", "6556c1a58444e10f", "4140197ec7959b1c", "eff26b18165ece9c",
    "566f532d486c9477", "9ae315a94e428a7e", "c2c3b68b48832afd", "11cf8376a1575fdc", "d75a838dc758ba17", "5a9d9dcefb56e593",
    "83621b34ec5955e5", "f6952d6eef555ddd", "0508a634445d4016", "665cb762e3bc03d0", "dcb50ee3659fb742", "d516dbecbf6a8cb4",
  ],
  stems: [
    "8:b95fdb800957759d", "9:3522d72b7b62a171", "10:1b0f93c2886c5724", "7:4d9128c239659d26", "7:665cb762e3bc03d0",
  ],
};

/** Truncated sha256 (16 hex) of normalised slurs: `whole` match a whole token, `stems` any substring (entry = `<length>:<digest>`). */
export const SLURS = {
  whole: [
    "9915ba2d822280f2", "17bde8b4064612e2", "98b52c4b6b7d1f48", "044eb98b18769b88", "c3de533e9b7fe63b", "268651b3ece98010",
    "3c8400b402baa7f1", "f9d0d9b18ae9033a", "45cd3e1bb472d8e2", "cc02032349c833ac", "82159dd02870c13e", "e7b98c6aa5b944e0",
    "daec0c235d3135fc", "0be9b885f4a35a18", "886d51e97ad7931d", "92a9bf818e7e0002", "619bc82e0d200e4a", "0dcc4d3364433181",
    "3b1e0d7c5dd45583", "7122c9a14ba2d20e", "7d2969e37aa4ff60", "429fecdc0e189e96", "1802d081455e60cd", "94a877e2ce63725e",
    "267463e5e36cd787", "27a62b68179c96f5", "be00f1af522eaa99", "6122fdf4ae1474fb", "6d1833779e389477", "70e4043b678ff365",
    "e742d17ff490c87e", "9bc997ae6adeaff8", "65961619eae0bfcd", "0ca06fe6268c760d", "70aafb4266950c0d", "acc96930e3a69737",
    "33740da8a87dc7de", "66415f8ce37b74a5", "7c686cf2ae588bdf", "469c0fdb6020d4bf", "0515b9e67e0e8306", "e9e8b6c5afa7794f",
  ],
  stems: [
    "6:120f6e5b4ea32f65", "5:08a841e996781e9e", "6:1290d04b901d01be", "6:8f5083e3e5c7dc89", "5:63bd9333b1a0b11d", "6:158869a97379229b",
    "6:16ea09fc78ca83ca", "8:402f7ebd98864afe", "7:eef3bd091670c344", "6:12e6274e4309293e", "7:22fc75e65a0e9d34", "9:333f7618092958c7",
    "7:717c0e327023d5be", "11:325c687181b4f516", "5:74e511a71a007176", "9:27eb0c4ad7072067", "6:b3cec2f6ece2cef2", "6:99ce26f09dc0e425",
    "12:4d4a1600018aac18", "11:aebbda5a07740a73", "10:9d57436661e1dce7", "8:1c4bfd100aa92982", "7:d00a3db7315ab70d",
  ],
};

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", "$": "s", "!": "i", "|": "i" };
/** Lowercase, accents folded, look-alike digits/symbols mapped to letters, everything else dropped. */
export function normalizeWord(s) {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c).replace(/[^a-z]/g, "");
}
/** Words of a text: split on non-letters and on camelCase boundaries ("ElonDoge" → elon, doge), normalised. */
export function wordsOf(text) {
  return String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9@$!|]+/).map(normalizeWord).filter(Boolean);
}
export const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

const termsOf = (list) => list.map((t) => ({ words: wordsOf(t), squashed: normalizeWord(t) })).filter((t) => t.squashed);
const PEOPLE_TERMS = termsOf(PEOPLE), BRAND_TERMS = termsOf(BRANDS);

/**
 * The first person or brand named in `text`, or null. A single-word term matches a whole word
 * ("trump" in "Trump Cat", not in "trumpet"); a multi-word term also matches its squashed form
 * anywhere ("taylorswift" in "TaylorSwiftInu"). A ticker (`symbol: true`, no word boundaries) also
 * matches a term of 4+ letters at its start or end ("ELONDOGE", "DOGEELON").
 */
export function namedEntity(text, { symbol = false, people = PEOPLE_TERMS, brands = BRAND_TERMS } = {}) {
  const words = wordsOf(text);
  const squashed = normalizeWord(text);
  if (!squashed) return null;
  const wordSet = new Set(words);
  for (const [kind, terms] of [["person", people], ["brand", brands]]) {
    for (const t of terms) {
      if (t.words.length === 1 ? wordSet.has(t.squashed) : squashed.includes(t.squashed)) return { kind, term: t.words.join(" ") };
      if (symbol && t.squashed.length >= 4 && (squashed.startsWith(t.squashed) || squashed.endsWith(t.squashed))) return { kind, term: t.words.join(" ") };
    }
  }
  return null;
}

/** Words of every multi-word person or brand named in `text` ("Grand Theft Auto VI" → grand, theft, auto). */
export function entityWords(text, { people = PEOPLE_TERMS, brands = BRAND_TERMS } = {}) {
  const squashed = normalizeWord(text), out = new Set();
  if (!squashed) return out;
  for (const t of [...people, ...brands]) if (t.words.length > 1 && squashed.includes(t.squashed)) for (const w of t.words) out.add(w);
  return out;
}

/** Index of a hashed list: whole-word digests and substring digests grouped by length. */
export function slurIndex(...lists) {
  const stems = new Map(), whole = new Set();
  for (const list of lists) {
    for (const h of list.whole ?? []) whole.add(h);
    for (const e of list.stems ?? []) { const [n, h] = e.split(":"); const len = Number(n); if (!stems.has(len)) stems.set(len, new Set()); stems.get(len).add(h); }
  }
  return { whole, stems };
}
const DEFAULT_INDEX = slurIndex(SLURS, NSFW);

/** Whether `text` contains a listed slur or vulgar word (hashed comparison; see SLURS and NSFW). */
export function hasSlur(text, index = DEFAULT_INDEX) {
  for (const w of wordsOf(text)) if (index.whole.has(digest(w))) return true;
  const squashed = normalizeWord(text);
  for (const [len, set] of index.stems) {
    for (let i = 0; i + len <= squashed.length; i++) if (set.has(digest(squashed.slice(i, i + len)))) return true;
  }
  return false;
}
