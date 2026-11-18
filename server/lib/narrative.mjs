// Linked posts (GET /api/narrative/:mint): the X posts a family's coins link to. A coin's creator may put a post link
// in the coin's metadata (`twitter`, sometimes `website`); for a parent the posts its direct children link are grouped
// and the ones several launch addresses share are listed, for a child its own post and the siblings that link the same
// one. The posts are picked by coin creators and nothing here checks them: the body says which coins link a post, never
// more. A link can name any handle (x.com/<anything>/status/<id> redirects to the real author), so only the id is
// taken from it and the one URL sent to clients is rebuilt from those digits; a post's handle and text come from the
// fetcher (lib/xposts.mjs).
// The pure functions come first (links, post times, grouping, ranking, common name words, the embed answer), then the
// `Narrative` class: one sliced walk per family, cached FAMILY_TTL_MS, and the body.
import { hasSlur, wordsOf as blockWords } from "./agents/blocklist.mjs";
import { SOL_MINT } from "./jupiter.mjs";
import { runSliced, drain } from "./sliced.mjs";

/** A member is a tracked direct child created within NEW_S or with a trade in the last 24 h. */
export const NEW_S = 72 * 3600;
/** A family entry is served this long, and at most this many are kept (the oldest goes first). */
export const FAMILY_TTL_MS = 30_000, FAMILY_CACHE = 300;
/** Ranked posts an entry keeps, and how many of them a body lists. */
export const RANK_KEEP = 12, POSTS_MAX = 5;
/** What one coin's 24 h volume can add to a post's score (USD): one heavily traded coin does not carry a post. */
export const USD_CAP = 5_000;
export const WORDS_MAX = 6, TEXT_MAX = 600;

const POST_HOSTS = new Set(["x.com", "twitter.com"].flatMap((h) => [h, `www.${h}`, `mobile.${h}`, `m.${h}`]));
const ID_RE = /^[1-9]\d{0,18}$/, HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const ID_MAX = 9223372036854775807n;
/** Ids below this are from before snowflake ids: they carry no time. */
const SNOWFLAKE_MIN = 30_000_000_000n, SNOWFLAKE_EPOCH_MS = 1288834974657n;
const DAY_S = 86_400;

/** The path segments of an http(s) URL on X (x.com or twitter.com, bare or www./mobile./m.), or null. */
function xPath(url) {
  if (typeof url !== "string" || url.length > 2048) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.port) return null;
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  return POST_HOSTS.has(host) ? u.pathname.split("/").filter(Boolean) : null;
}

/**
 * `{ id }` of an X post link, or null: `<handle>/status/<id>`, `<handle>/statuses/<id>`, `i/status/<id>` or
 * `i/web/status/<id>` (whatever follows the id is ignored). One leading segment that is itself an X host is skipped:
 * the metadata cleaner stores a bare `www.x.com/u/status/1` as `https://x.com/www.x.com/u/status/1`. The handle is
 * not returned.
 */
export function parsePost(url) {
  const seg = xPath(url);
  if (!seg) return null;
  if (seg.length && POST_HOSTS.has(seg[0].toLowerCase())) seg.shift();
  let id = null;
  if (seg.length >= 4 && seg[0] === "i" && seg[1] === "web" && seg[2] === "status") id = seg[3];
  else if (seg.length >= 3 && HANDLE_RE.test(seg[0]) && (seg[1] === "status" || seg[1] === "statuses")) id = seg[2];
  if (id == null || !ID_RE.test(id) || BigInt(id) > ID_MAX) return null;
  return { id };
}

/** When a post was made (unix s), read from its id; null for an id that is no snowflake or says a time more than a day after `nowMs`. */
export function postTime(id, nowMs = Date.now()) {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  const n = BigInt(id);
  if (n < SNOWFLAKE_MIN) return null;
  const ms = Number((n >> 22n) + SNOWFLAKE_EPOCH_MS);
  return ms > nowMs + DAY_S * 1000 ? null : Math.floor(ms / 1000);
}

/** The one post URL sent to clients, made from the id's digits. */
export const postUrl = (id) => `https://x.com/i/status/${id}`;

/**
 * Members by the post they link: `Map<id, { id, coins, creators, usd, usdCapped, t1h, firstAt, lastAt, mints }>`.
 * `members`: `[{ mint, key, createdAt, usd, trades, t1h, postId }]` (`key`: the creator key or null); those without a
 * `postId` are left out. `creators` counts distinct keys, every coin without one together as a single creator.
 */
export function groupPosts(members) { return drain(groupPostsGen(members)); }
/** groupPosts in steps (a yield every 2 048 members), for the sliced family walk. */
export function* groupPostsGen(members) {
  const groups = new Map(), keys = new Map();
  let n = 0;
  for (const m of members) {
    if ((++n & 2047) === 0) yield;
    const id = m.postId;
    if (!id) continue;
    let g = groups.get(id);
    if (!g) { groups.set(id, g = { id, coins: 0, creators: 0, usd: 0, usdCapped: 0, t1h: 0, firstAt: null, lastAt: null, mints: [] }); keys.set(id, new Set()); }
    const usd = Number.isFinite(m.usd) && m.usd > 0 ? m.usd : 0;
    g.coins++; g.usd += usd; g.usdCapped += Math.min(usd, USD_CAP); g.t1h += m.t1h > 0 ? m.t1h : 0; g.mints.push(m.mint);
    if (m.createdAt != null) {
      if (g.firstAt == null || m.createdAt < g.firstAt) g.firstAt = m.createdAt;
      if (g.lastAt == null || m.createdAt > g.lastAt) g.lastAt = m.createdAt;
    }
    const seen = keys.get(id), k = m.key ?? null;
    if (!seen.has(k)) { seen.add(k); g.creators++; }
  }
  return groups;
}

/**
 * The groups worth listing, best first, each with its post time `at` and `score`. A post is admitted only when two or
 * more creators link it and its id gives a time; volume never admits one. Score: 3·log2(1 + creators) + 1.5·ln(1 +
 * capped volume) + ln(1 + trades in the last hour), +3 for a post under 24 h old, +1 under 72 h, −4 over 30 days.
 * Ties: more coins, then the id.
 */
export function rankPosts(groups, { nowS = Math.floor(Date.now() / 1000) } = {}) {
  const out = [];
  for (const g of groups instanceof Map ? groups.values() : groups) {
    if (!(g.creators >= 2)) continue;
    const at = postTime(g.id, nowS * 1000);
    if (at == null) continue;
    const age = nowS - at;
    const fresh = age < DAY_S ? 3 : age < 3 * DAY_S ? 1 : age > 30 * DAY_S ? -4 : 0;
    out.push({ ...g, at, score: 3 * Math.log2(1 + g.creators) + 1.5 * Math.log1p(g.usdCapped) + Math.log1p(g.t1h) + fresh });
  }
  return out.sort((a, b) => b.score - a.score || b.coins - a.coins || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const STOP = new Set(["coin", "coins", "token", "tokens", "the", "and", "for", "with", "from", "this", "that", "you", "your", "our", "not", "are", "was", "its",
  "official", "sol", "solana", "pump", "pumpfun", "fun", "inu", "new", "real", "meme", "memecoin", "usd", "usdc", "http", "https", "www", "com"]);
const WORD_SPLIT = /[^\p{L}\p{N}\p{M}]+/u, LATIN_WORD = /^[a-z0-9]{3,24}$/, HAS_LETTER = /[a-z]/;
const CJK_WORD = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]{2,12}$/u;

/**
 * The words of a coin name or symbol that can be counted: NFKC, lowercased, and only single-script ones, either
 * a-z0-9 with at least one letter (3 to 24 characters) or CJK only (2 to 12). Everything else is dropped, mixed
 * scripts first of all (look-alike letters).
 */
export function nameTokens(text) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  for (const t of text.slice(0, 200).normalize("NFKC").toLowerCase().split(WORD_SPLIT)) {
    if (t && (LATIN_WORD.test(t) ? HAS_LETTER.test(t) : CJK_WORD.test(t))) out.push(t);
  }
  return out;
}

/**
 * The words most creators put in their coins' names: `[{ w, n }]`, at most WORDS_MAX, `n` = distinct creator keys
 * (coins without one count together as one) with the word in a `name` or `symbol`. A word needs max(3, 3 % of the
 * distinct keys), must not be a filler word, and must not contain or be contained in a word of `exclude` that has 3+
 * letters or is a CJK word (the subject's own name and symbol: its children repeat them). `isSlur` costs a hash per substring, so it is asked
 * only for the candidates, best first, until WORDS_MAX passed.
 */
export function nameWords(members, opts = {}) { return drain(nameWordsGen(members, opts)); }
/** nameWords in steps (a yield every 1 024 members), for the sliced family walk. */
export function* nameWordsGen(members, { exclude = [], isSlur = hasSlur } = {}) {
  // Members by key first, so a word is counted once per key with one number per word (`k`: the last key that had it).
  const byKey = new Map();
  let n = 0;
  for (const m of members) {
    if ((++n & 2047) === 0) yield;
    const k = m.key ?? null, list = byKey.get(k);
    if (list) list.push(m); else byKey.set(k, [m]);
  }
  const counts = new Map();
  let kid = 0;
  n = 0;
  for (const list of byKey.values()) {
    kid++;
    for (const m of list) {
      if ((++n & 1023) === 0) yield;
      for (const text of [m.name, m.symbol]) {
        for (const w of nameTokens(text)) {
          const e = counts.get(w);
          if (!e) counts.set(w, { n: 1, k: kid }); else if (e.k !== kid) { e.n++; e.k = kid; }
        }
      }
    }
  }
  yield;
  const min = Math.max(3, Math.ceil(0.03 * byKey.size));
  const own = [...exclude].filter((x) => typeof x === "string" && ([...x].length >= 3 || CJK_WORD.test(x)));
  const cands = [];
  for (const [w, e] of counts) {
    if (e.n < min || STOP.has(w) || own.some((x) => w.includes(x) || x.includes(w))) continue;
    cands.push({ w, n: e.n });
  }
  cands.sort((a, b) => b.n - a.n || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0));
  const out = [];
  for (const c of cands) {
    if (out.length >= WORDS_MAX) break;
    if (!isSlur(c.w)) out.push(c);
  }
  return out;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026" };
const codePoint = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "");
/** Characters a post text never shows: C0/C1 controls (the newline stays), the bidi and invisible format marks (U+200D stays: emoji need it), tag characters. */
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/** `s` without its tags (their inner text stays), `<br>` a newline. An "<" that never closes is text. One pass with indexOf: no pattern that could rescan a hostile body. */
function stripTags(s) {
  let out = "", i = 0;
  for (;;) {
    const lt = s.indexOf("<", i), gt = lt < 0 ? -1 : s.indexOf(">", lt);
    if (gt < 0) return out + s.slice(i);
    out += s.slice(i, lt) + (/^<br\b/i.test(s.slice(lt, lt + 4)) ? "\n" : "");
    i = gt + 1;
  }
}
/** The plain text of the first paragraph of an embed's HTML, or null when it has none. */
function embedText(html) {
  if (typeof html !== "string") return null;
  const open = /<p(?=[\s>])/i.exec(html);
  const from = open ? html.indexOf(">", open.index) + 1 : 0;
  if (!from) return null;
  const len = html.slice(from).search(/<\/p\s*>/i);
  if (len < 0) return null;
  let s = stripTags(html.slice(from, from + len).replace(/[\t\n\r\f]+/g, " ")) // source line breaks are spaces in HTML; the post's own are <br>
    // one pass, so a decoded "&" never starts a second entity ("&amp;lt;" is the text "&lt;")
    .replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{2,8});/gi, (all, e) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
      return codePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    })
    .replace(HIDDEN, "")
    .replace(/[ \u00a0]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const cps = Array.from(s);
  if (cps.length > TEXT_MAX) s = `${cps.slice(0, TEXT_MAX).join("").trimEnd()}\u2026`;
  return s;
}

/**
 * `{ handle, text }` from X's oEmbed answer for post `id`, or null when it is not that. `json.url` must be a link to
 * the same id; the handle is the one path segment of `json.author_url` on X; the text is the first paragraph of
 * `json.html` as plain text (`<br>` a newline, tags dropped, entities decoded once, hidden characters removed, at most
 * TEXT_MAX code points). The author's display name is not kept (free text anyone can set to another's name). An empty
 * text is fine (a post of media only).
 */
export function parseOembed(json, id) {
  if (!json || typeof json !== "object" || typeof id !== "string") return null;
  if (parsePost(json.url)?.id !== id) return null;
  const seg = xPath(json.author_url);
  if (!seg || seg.length !== 1 || !HANDLE_RE.test(seg[0])) return null;
  const text = embedText(json.html);
  return text == null ? null : { handle: seg[0], text };
}

/** Characters that draw nothing (soft hyphen, joiners, variation selectors, format marks): a word reads the same with one inside it. */
const UNSEEN = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
/**
 * Whether any word of `text` is on the block list: each word on its own, never the text squashed into one string (that
 * finds words across word borders). The words are taken from the text as it is and from a lowercased copy without the
 * characters that draw nothing, so a word written in mixed case or with an unseen character inside it is still one
 * word. The text itself is not changed.
 */
export function flagText(text, { isSlur = hasSlur, wordsOf = blockWords } = {}) {
  if (typeof text !== "string" || !text) return false;
  const flat = text.replace(UNSEEN, "").toLowerCase();
  for (const w of new Set([...wordsOf(text), ...wordsOf(flat)])) if (isSlur(w)) return true;
  return false;
}

/** The post a coin links: the first of its metadata's `twitter` and `website` that is an X post link; its id or null. */
export const postOf = (meta) => (meta ? (parsePost(meta.twitter) ?? parsePost(meta.website))?.id ?? null : null);

const round2 = (x) => Math.round(x * 100) / 100;
/** Best first among the coins of one post: 24 h volume, then the newest, then the mint. */
const byVolume = (a, b) => b.usd - a.usd || (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
const NO_FAMILY = Object.freeze({ at: 0, members: 0, linked: 0, ranked: Object.freeze([]), groups: new Map(), words: Object.freeze([]) });

export class Narrative {
  /** `model`: the index; `posts`: the post-text fetcher (lib/xposts.mjs) or null (every post then reads "idle": a link without text); `now` in ms. */
  constructor({ model, posts = null, now = Date.now, log = console } = {}) {
    this.model = model; this.posts = posts; this.now = now; this.log = log;
    this.cache = new Map(); // subject mint → family entry, oldest first
    this.jobs = new Map();  // subject mint → the walk under way (askers share it)
    this.stats = { builds: 0, lastBuildMs: null, maxSliceMs: 0, served: 0 };
    this.stopped = false;
  }
  start() { this.posts?.start?.(); return this; }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.posts?.stop?.();
  }
  snapshot() { return { cached: this.cache.size, ...this.stats, posts: this.posts?.snapshot?.() ?? null }; }

  /** A coin ref as the other API bodies give one (model.ref: the logo through the image proxy), with its 24 h volume. */
  #ref(mint, usd) {
    const c = this.model.get(mint);
    if (!c) return null;
    const r = this.model.ref(c);
    return { mint: r.mint, name: r.name, symbol: r.symbol, image: r.image, usd24: round2(usd) };
  }

  /**
   * The family entry of `mint`: `{ at, members, linked, ranked, groups, words }`. `ranked`: the RANK_KEEP best posts
   * `{ id, at, coins, usd24, top }` (`top`: the refs of its 3 best coins); `groups`: every linked post, ranked or not,
   * as `{ coins, mints, top }` (`top`: its 4 best coins `{ mint, usd }`, one more than shown so the asking coin can be
   * left out) for the sibling look-ups. A mint without children costs nothing and is not cached.
   */
  #family(mint) {
    if (!this.model.children.get(mint)?.size) return NO_FAMILY;
    const hit = this.cache.get(mint);
    if (hit && this.now() - hit.at < FAMILY_TTL_MS) return hit;
    let job = this.jobs.get(mint);
    if (!job) {
      job = runSliced(this.#buildGen(mint)).then((run) => {
        this.stats.builds++; this.stats.lastBuildMs = Math.round(run.cpuMs * 100) / 100;
        if (run.maxSliceMs > this.stats.maxSliceMs) this.stats.maxSliceMs = Math.round(run.maxSliceMs * 100) / 100;
        this.cache.delete(mint); this.cache.set(mint, run.value);
        while (this.cache.size > FAMILY_CACHE) this.cache.delete(this.cache.keys().next().value);
        return run.value;
      }).finally(() => this.jobs.delete(mint));
      this.jobs.set(mint, job);
    }
    return job;
  }

  /** The walk over a subject's direct children, in steps: a yield every 2 048 children or 256 members, before the grouping and before the words. */
  *#buildGen(mint) {
    const model = this.model, nowMs = this.now(), nowS = Math.floor(nowMs / 1000), vol = model.volumes();
    const members = [];
    let seen = 0, fresh = 0, linked = 0;
    for (const m of model.children.get(mint) ?? []) {
      if (++seen >= 2048 || fresh >= 256) { yield; seen = 0; fresh = 0; }
      const c = model.get(m);
      if (!c || !c.tracked) continue;
      const v = vol.get(m), trades = v?.trades ?? 0;
      if (!(trades > 0) && !(c.createdAt != null && nowS - c.createdAt <= NEW_S)) continue;
      const { name, symbol } = model.nameOf(m), postId = postOf(model.metaFor(c));
      if (postId) linked++;
      members.push({ mint: m, key: model.creatorKey(c), createdAt: c.createdAt ?? null, usd: v?.usd ?? 0, trades, t1h: trades > 0 ? model.activity.get(m)?.t1h ?? 0 : 0, postId, name, symbol });
      fresh++;
    }
    yield;
    const groups = yield* groupPostsGen(members);
    // Each post's best coins in one pass over the members (a group can hold thousands; only four are kept).
    const tops = new Map();
    let n = 0;
    for (const m of members) {
      if ((++n & 2047) === 0) yield;
      if (!m.postId) continue;
      let top = tops.get(m.postId);
      if (!top) tops.set(m.postId, top = []);
      if (top.length < 4 || byVolume(m, top[3]) < 0) { top.push(m); top.sort(byVolume); if (top.length > 4) top.length = 4; }
    }
    const byId = new Map();
    for (const g of groups.values()) byId.set(g.id, { coins: g.coins, mints: g.mints, top: tops.get(g.id).map((m) => ({ mint: m.mint, usd: m.usd })) });
    yield;
    const ranked = rankPosts(groups, { nowS }).slice(0, RANK_KEEP).map((g) => ({
      id: g.id, at: g.at, coins: g.coins, usd24: round2(g.usd), top: byId.get(g.id).top.slice(0, 3).map((t) => this.#ref(t.mint, t.usd)).filter(Boolean),
    }));
    yield;
    const self = model.nameOf(mint);
    const words = yield* nameWordsGen(members, { exclude: [...nameTokens(self.name), ...nameTokens(self.symbol)] });
    return { at: nowMs, members: members.length, linked, ranked, groups: byId, words };
  }

  /**
   * What is stored of post `id`, `{ state, handle, text }`, once per body (`ctx.seen`). An id whose text is not stored
   * (or is due a recheck) is asked for: the fetcher's own refusals first, then `mayQueue` (the asker's allowance, spent
   * only on an id about to be queued), then the queue. Without a fetcher, or when it fails, the post reads "idle".
   */
  #post(id, low, ctx) {
    let s = ctx.seen.get(id);
    if (s) return s;
    s = { state: "idle", handle: null, text: null };
    ctx.seen.set(id, s);
    const x = this.posts;
    if (!x) return s;
    try {
      const rec = x.peek(id);
      if (x.canQueue(id, { low }) === "ok" && ctx.mayQueue()) x.want(id, { low });
      if (rec?.state === "ok") { s.state = "ok"; s.handle = rec.handle ?? null; s.text = rec.text ?? ""; }
      else s.state = rec ? "none" : x.state(id);
    } catch (e) { this.log.warn?.(`narrative: post ${id}: ${String(e?.message ?? e).slice(0, 160)}`); }
    return s;
  }
  /** The first `max` ranked posts of a family whose post is not known to be unavailable, as body items. A dropped one is still asked for again when its recheck is due. */
  #list(fam, max, ctx) {
    const out = [];
    for (const g of fam.ranked) {
      if (out.length >= max) break;
      const s = this.#post(g.id, false, ctx);
      if (s.state !== "none") out.push({ id: g.id, url: postUrl(g.id), at: g.at, coins: g.coins, usd24: g.usd24, state: s.state, handle: s.handle, text: s.text, top: g.top });
    }
    return out;
  }

  /**
   * The body of GET /api/narrative/:mint (README §API), or null when `mint` is no subject. A subject is a tracked coin,
   * or a mint with children: a listed asset, also one that an untracked coin record exists for (a pump.fun coin that
   * a coin look-up cached). Such a record is never read: the asset is served as a mint without a coin (no `own`, no
   * `under`). SOL, an untracked coin without children and an unknown mint are no subjects. `mayQueue()`: whether the
   * asker may start one more post-text fetch.
   */
  async serve(mint, { mayQueue = () => true } = {}) {
    const model = this.model;
    if (typeof mint !== "string" || mint === SOL_MINT) return null;
    const rec = model.get(mint), c = rec?.tracked ? rec : null;
    if (!c && !model.children.get(mint)?.size) return null;
    this.stats.served++;
    const fam = await this.#family(mint);
    const nowMs = this.now(), ctx = { mayQueue, seen: new Map() };
    const posts = this.#list(fam, POSTS_MAX, ctx);
    let own = null, under = null;
    if (c) {
      const parent = c.quoteMint && c.quoteMint !== SOL_MINT ? c.quoteMint : null;
      const id = postOf(model.metaFor(c));
      if (id) {
        // The siblings come from the parent's entry: the coins under it that link the same post, without this one.
        let siblings = null, top = [], par = null;
        if (parent) {
          const g = (await this.#family(parent)).groups.get(id);
          siblings = g ? g.coins - (g.mints.includes(mint) ? 1 : 0) : 0;
          if (g) top = g.top.filter((t) => t.mint !== mint).slice(0, 3).map((t) => this.#ref(t.mint, t.usd)).filter(Boolean);
          par = { mint: parent, ...model.nameOf(parent) };
        }
        const at = postTime(id, nowMs);
        const s = this.#post(id, !siblings || at == null, ctx);
        own = { id, url: postUrl(id), at, state: s.state, handle: s.handle, text: s.text, siblings, top, parent: par };
      } else if (parent && !posts.length) {
        const [post] = this.#list(await this.#family(parent), 1, ctx);
        if (post) under = { mint: parent, ...model.nameOf(parent), post };
      }
    }
    const pending = posts.some((p) => p.state === "wait") || own?.state === "wait" || under?.post.state === "wait";
    return { mint, asOf: Math.floor(nowMs / 1000), members: fam.members, linked: fam.linked, posts, words: fam.words, own, under, pending };
  }
}
