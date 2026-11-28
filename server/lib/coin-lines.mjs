// Coin story lines (GET /api/stories `row.storyLine`, and the header of a card without a worded post): one "Subject:
// what happened" line for EVERY coin the page lists, so a coin is never shown without whatever context there is.
//
// Where a line comes from:
// - by "model": the narrative tagger (lib/narrtags.mjs) asks for it in the same request as the coin's tag, from what
//   the request shows of that coin only (its name, ticker, description, site, X handle or search, its linked post's
//   text and, with NARRATIVE_IMAGES=on, its picture). It is checked here (checkCoinLine) with the post lines' own
//   checks (lib/post-lines.mjs checkLine: length caps, no price, hype, link, day, block-list words, no number or name
//   the coin's texts do not have) and its key phrases with keepKeys. A line that fails is dropped: the tag is stored
//   as ever, never held back by its line.
// - by "server": everything else, written here from facts only (coinServerLine): a description, else the linked post,
//   in quote marks when the server's quote rules let it through (lib/post-lines.mjs quoteText: no prediction, promise
//   of gain or call to buy, no block-list, hype or price words, not noise) and the model has not read the coin;
//   otherwise "Name only: ...", saying honestly what the coin has (nothing, or what was not read yet, or what the model
//   read and found no subject in). Never blank.
//
// `source` (where the line's substance is from; the server's reading, never the model's word):
// - a model line: the first of "post", "description" that holds a content word of the line that the coin's name and
//   ticker do not; else "picture" when its picture was sent (words a picture shows cannot be checked against text);
//   else the first text the coin has ("description", "post"); "name" when the line adds nothing to the name at all.
// - a server line: "description" or "post" for a quote, "name" for every "Name only" line.
// A line of source "name" is "name only": it never heads a card while another coin of the card has more.
//
// COIN_LINE_VERSION names the rules and instructions a stored line was made under (coin_tags.line_v). A coin whose
// stored answer is older (0: made before lines existed) is read once more for its line when it is listed on Discover
// (lib/narrtags.mjs NarrTags reline): its tag is kept, only its line is written.
import { checkLine, cleanField, keepKeys, quoteText, quoteRefused, sharedWord, postText as cleanPost, coinText, SUBJECT_MAX } from "./post-lines.mjs";
import { flagText } from "./narrative.mjs";
import { cleanText } from "./narrtags.mjs";

export const COIN_LINE_VERSION = 1;
/** The line of a coin that has no description, no picture and no post. */
export const NAME_ONLY = "Name only: no description, picture or post";
/** The header of a card whose coins have nothing but their names. */
export const NAME_ONLY_MANY = "Name only: no description, picture or post on these coins";
/** The header of a card whose coins have something, none of it read by the model yet (or nothing at all). */
export const NAME_ONLY_UNREAD = "Name only: these coins are not read yet";
/** The header of a card whose coins were read, and nothing names a subject. */
export const NAME_ONLY_SOME = "Name only: nothing on these coins names a clear subject";
/** How a coin's "Name only" line ends when what it has was not read by the model yet. */
export const NOT_READ = "not read yet";
export const SOURCES = Object.freeze(["description", "picture", "post", "name"]);

const hasWords = (s) => typeof s === "string" && /[\p{L}\p{N}]/u.test(s);
const wordsOf = (s) => String(s ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
// Words that carry no substance of their own in a coin line.
const STOP = new Set(["the", "and", "for", "with", "from", "into", "onto", "about", "after", "this", "that", "its", "it's", "his", "her", "their", "was", "are", "has", "had", "have", "says", "said", "named", "name", "names", "coin", "coins", "token", "tokens", "meme", "post", "posts", "linked", "description", "picture", "shows", "show", "showing", "called", "refers", "refer", "who", "what", "which", "not", "one"]);
// What a coin line never says, beyond the post lines' checks (a coin's description is mostly the dev's promotion, and
// the model is asked to attribute its claims, so the claim itself would be on the page): a prediction (a modal or
// "going to" before a rise word: "will go up", "is going to pump", "could double"), a call to act ("before it's gone",
// "holders should", "don't miss", "get in"), and the server's own quote refusals (lib/post-lines.mjs QUOTE_REFUSE:
// pump, rich, guaranteed, buy, profit, early, potential, ...), in any part of the line.
const RISE = String.raw`(?:rise|rises|go(?:es)?\s+up|grow|increase|climb|soar|skyrocket|surge|double|triple|multiply|rally|gain|moon|pump|explode|fly|take\s+off|make\s+(?:holders?|every\s+holder))`;
const PROMISE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:(?:will|shall|gonna|could|might|may|should|(?:is|are|it['’]s)?\s*(?:going|set|about|bound)\s+to)\s+(?:[\p{L}']+\s+){0,2}?${RISE}(?![\p{L}\p{N}])|before\s+(?:it['’]?s|it\s+is|they['’]?re|its)\s+(?:gone|too\s+late|sold\s+out)|holders?\s+(?:should|must|need\s+to)|(?:don['’]?t|do\s+not)\s+miss|get\s+in(?![\p{L}\p{N}])|grab\s+(?:it|yours|some|a\s+bag)|to\s+the\s+moon)`, "iu");
/** Whether a coin line (`subject` and `happened`) holds a prediction, a promise of gain or a call to act. */
export const linePromises = (l) => { const t = `${l?.subject ?? ""} : ${l?.happened ?? ""}`; return quoteRefused(t) || PROMISE_RE.test(t); };
const inHay = (w, hay) => hay.includes(w) || (w.length > 4 && w.endsWith("s") && hay.includes(w.slice(0, -1)));

/**
 * A reply's `line` read for storage: `{ subject, happened, keys }` with every field cleaned (cleanField; `happened`
 * without a final stop), `keys` only through keepKeys; `happened` "" (and no keys) when the model found nothing; null
 * when it is not an object with string subject and happened. Whether it may be shown is checkCoinLine's business.
 */
export function readCoinLine(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.subject !== "string" || typeof raw.happened !== "string") return null;
  const happened = cleanField(raw.happened, { stop: true });
  return { subject: cleanField(raw.subject), happened, keys: hasWords(happened) ? keepKeys(raw.keys, happened) : [] };
}

/**
 * What a coin's line may draw on, from a tagger description `d` (`{ name, symbol, description, website, twitter,
 * post: { handle, text } | null }`): the coin's own texts as one lower-case haystack per source.
 */
export function evidenceOf(d) {
  const post = cleanPost(d?.post?.text ?? "");
  const desc = [cleanText(d?.description, 400), cleanText(d?.website, 120), cleanText(d?.twitter, 120)].filter(Boolean).join(" ");
  return { name: `${d?.name ?? ""} ${d?.symbol ?? ""}`, post, desc, handle: cleanText(d?.post?.handle, 20) };
}

/** Where a checked model line's substance is from (see the head of the file). */
export function lineSource(line, d, { picture = false } = {}) {
  const ev = evidenceOf(d), own = new Set(wordsOf(ev.name));
  const words = wordsOf(`${line.subject} ${line.happened}`).filter((w) => [...w].length >= 3 && !STOP.has(w) && !own.has(w));
  if (!words.length) return "name";
  const post = ev.post.toLowerCase(), desc = ev.desc.toLowerCase();
  if (post && words.some((w) => inHay(w, post))) return "post";
  if (desc && words.some((w) => inHay(w, desc))) return "description";
  if (picture) return "picture";
  return desc ? "description" : post ? "post" : "name";
}

/**
 * A model's line for coin `d` checked: `{ line, why }`. `line` `{ subject, happened, keys, source }` when it may be
 * shown, else null with `why`: "empty" (the model found nothing: happened ""), "missing" (no usable line in the reply),
 * "promise" (a prediction, a promise of gain or a call to act: linePromises, which the attribution check of a post's
 * claim does not cover, so "Description says buy before it pumps" is refused too), or a lib/post-lines.mjs checkLine
 * reason ("long", "hype", "price", "ungrounded", ...). The evidence is the coin's own
 * texts (its description and links count here: they are the coin's own words) and its name and ticker; with its picture
 * sent (`picture`), a name or number the texts do not have may come from the picture, so "ungrounded" and "number" are
 * let through then and only then. Pure but for the block list.
 */
export function checkCoinLine(raw, d, { picture = false } = {}) {
  const l = raw && typeof raw === "object" && "happened" in raw && "subject" in raw && typeof raw.happened === "string" ? raw : null;
  if (!l) return { line: null, why: "missing" };
  if (!hasWords(l.happened)) return { line: null, why: "empty" };
  if (linePromises(l)) return { line: null, why: "promise" };
  const ev = evidenceOf(d);
  const src = { handle: ev.handle, coins: [{ name: d?.name ?? "", symbol: d?.symbol ?? "" }] }, line = { subject: l.subject, happened: l.happened, kind: "event" };
  let why = checkLine(line, `${ev.post} ${ev.desc}`, src);
  // With its picture, a name or number may be the picture's: the checks run once more with the line's own words as
  // evidence, so only those two pass and every later check (hype, price, link, day, block list) still runs.
  if (picture && (why === "ungrounded" || why === "number")) why = checkLine(line, `${ev.post} ${ev.desc} ${l.subject} ${l.happened}`, src);
  if (why) return { line: null, why };
  const keys = keepKeys(l.keys, l.happened);
  return { line: { subject: l.subject, happened: l.happened, keys, source: lineSource(l, d, { picture }) }, why: null };
}

/** A stored line (JSON from coin_tags.line) read back, its key phrases checked again; null for anything unusable. */
export function storedLine(v) {
  let o = v;
  if (typeof v === "string") { try { o = JSON.parse(v); } catch { return null; } }
  if (!o || typeof o !== "object" || typeof o.subject !== "string" || !hasWords(o.happened) || !hasWords(o.subject)) return null;
  return { subject: o.subject, happened: o.happened, keys: keepKeys(o.keys, o.happened), source: SOURCES.includes(o.source) ? o.source : "name" };
}

const listOf = (parts) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
/** A subject the server may write from a coin's name: its name, else its ticker, cleaned and not flagged; "This coin" when neither may be shown. */
export function nameSubject(name, symbol, flag = flagText) {
  for (const s of [name, symbol]) {
    const t = cleanField(cleanText(s, SUBJECT_MAX * 2));
    if (!hasWords(t)) continue;
    try { if (!flag(t)) return [...t].length > SUBJECT_MAX ? `${[...t].slice(0, SUBJECT_MAX - 1).join("").trimEnd()}…` : t; } catch { /* next */ }
  }
  return "This coin";
}

/**
 * The line the server writes for a coin with no model line to show: `{ subject, happened, keys: [], by: "server",
 * source, quote? }`. `f`: `{ name, symbol, description (raw), post (the linked post's raw text, or null), image (the coin
 * has a picture), read (the model read it under COIN_LINE_VERSION), hadImg (its picture was sent), dropped (the
 * model's line failed the checks) }`.
 * - Not read by the model, or its line was dropped: its description, else its post, in quote marks when quoteText lets
 *   it through (`quote: true`, source "description" / "post").
 * - Nothing: NAME_ONLY. Read: "Name only: its <what it read> name(s) no clear subject" (and "; picture not read yet"
 *   for a picture it was not sent with). Not read: "Name only: <what it has> not read yet".
 */
export function coinServerLine(f, { flag = flagText } = {}) {
  const subject = nameSubject(f?.name, f?.symbol, flag);
  const desc = coinText(f?.description ?? ""), post = cleanPost(f?.post ?? ""), image = !!f?.image;
  const mk = (happened, source, quote = false) => ({ subject, happened, keys: [], by: "server", source, ...(quote ? { quote: true } : null) });
  const coins = [{ name: f?.name ?? "", symbol: f?.symbol ?? "" }];
  if (!f?.read || f?.dropped) {
    const d = desc ? quoteText(desc, coins, { flag }) : null;
    if (d) return mk(d, "description", true);
    const p = post ? quoteText(f.post, coins, { flag }) : null;
    if (p) return mk(p, "post", true);
  }
  if (!desc && !post && !image) return mk(NAME_ONLY, "name");
  if (f?.read) {
    const seen = [desc && "description", f.hadImg && image && "picture", post && "post"].filter(Boolean);
    if (seen.length) return mk(`Name only: its ${listOf(seen)} name${seen.length === 1 ? "s" : ""} no clear subject${image && !f.hadImg ? "; picture not read yet" : ""}`, "name");
  }
  return mk(`Name only: ${listOf([desc && "description", image && "picture", post && "post"].filter(Boolean))} ${NOT_READ}`, "name");
}

/**
 * A coin's story line as a row carries it: the model's stored line (`m`: lib/narrtags.mjs NarrTags storyLineOf, `{ line,
 * read, hadImg, dropped }` or null) when there is one, `by: "model"`; else coinServerLine over the facts `f`.
 */
export function coinStoryLine(m, f, { flag = flagText } = {}) {
  const l = m?.read ? storedLine(m.line) : null;
  if (l) return { subject: l.subject, happened: l.happened, keys: l.keys, by: "model", source: l.source };
  return coinServerLine({ ...f, read: !!m?.read, hadImg: !!m?.hadImg, dropped: !!m?.dropped }, { flag });
}

/** Whether a story line is "name only" (it says nothing beyond the coin's name). */
export const nameOnly = (l) => !l || l.source === "name";

/**
 * A card's header (`card.line`) from its coins' story lines, for a card whose post has no words (or none): `rows` the
 * card's coin rows in page order, each with `storyLine`, `tf.buyers` and `buyers5m`; `keep` the mint the last build
 * chose (kept while it still has a line of the same kind as the best, so the header does not flip between coins as
 * buyers move). The chosen coin: the most bought (the timeframe's buyers, then the last 5 minutes') whose line is not
 * name only, a model's line before a quote. Its line becomes the header: a model's `{ kind: "event", by: "model",
 * chips: ["ai", "coin_line"], keys, of }`, a quote `{ kind: "thin", by: "server", quote: true, chips: ["coin_line"],
 * of }` (`of`: `{ mint, symbol }` of that coin, so the page can say whose line it is). No such coin: one row keeps its
 * own name-only line; several get their shared name (sharedWord, else the title, the family's ticker, the first coin's
 * name) with NAME_ONLY_MANY when every coin has nothing at all, NAME_ONLY_UNREAD when what they have was not read
 * yet, else NAME_ONLY_SOME. "ai_group" is added for a grouping
 * a model made (`grouped`). Returns `{ line, mint }` (`mint` null for a name-only header).
 */
export function headerLine(rows, { keep = null, title = null, familySymbol = null, grouped = false, flag = flagText } = {}) {
  const list = (rows ?? []).filter((r) => r?.storyLine);
  const g = grouped ? ["ai_group"] : [];
  const bought = (r) => [Number(r.tf?.buyers) || 0, Number(r.buyers5m) || 0];
  const rank = [...list].filter((r) => !nameOnly(r.storyLine)).sort((a, b) => {
    const ma = a.storyLine.by === "model" ? 1 : 0, mb = b.storyLine.by === "model" ? 1 : 0;
    const [ba, fa] = bought(a), [bb, fb] = bought(b);
    return mb - ma || bb - ba || fb - fa;
  });
  if (rank.length) {
    const kept = keep ? rank.find((r) => r.mint === keep && r.storyLine.by === rank[0].storyLine.by) : null;
    const r = kept ?? rank[0], l = r.storyLine, of = { mint: r.mint, symbol: r.symbol ?? null };
    if (l.by === "model") return { mint: r.mint, line: { subject: l.subject, happened: l.happened, kind: "event", by: "model", quote: false, chips: ["ai", "coin_line", ...g], ...(l.keys?.length ? { keys: [...l.keys] } : null), of } };
    return { mint: r.mint, line: { subject: l.subject, happened: l.happened, kind: "thin", by: "server", quote: true, chips: ["coin_line", ...g], of } };
  }
  if (!list.length) return { mint: null, line: null };
  if (list.length === 1) { const l = list[0].storyLine; return { mint: null, line: { subject: l.subject, happened: l.happened, kind: "thin", by: "server", quote: false, chips: g } }; }
  const w = sharedWord(list.map((r) => ({ name: r.name, symbol: r.symbol })), flag);
  const t = title ? nameSubject(title, null, flag) : "";
  const fam = familySymbol ? nameSubject(null, familySymbol, flag) : "";
  const subject = w?.word ?? (title && t !== "This coin" ? t.replace(/^\p{Ll}/u, (c) => c.toUpperCase()) : fam && fam !== "This coin" ? `$${fam.replace(/^\$+/, "")}` : nameSubject(list[0].name, list[0].symbol, flag));
  const h = list.map((r) => r.storyLine.happened);
  const happened = h.every((x) => x === NAME_ONLY) ? NAME_ONLY_MANY : h.every((x) => x === NAME_ONLY || x.endsWith(NOT_READ)) ? NAME_ONLY_UNREAD : NAME_ONLY_SOME;
  return { mint: null, line: { subject, happened, kind: "thin", by: "server", quote: false, chips: g } };
}
