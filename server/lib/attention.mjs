// Story attention (README §Story attention): how many wallets each story (lib/stories.mjs: a narrative, an X post, a
// waking family) draws per 5 minutes, against its own normal, so the Discover cards can say how much attention a story
// gets NOW, as context. Nothing here predicts anything: a phase says what the last hour looked like, not what comes next.
// Three quiet recorders ride on the same trades and the same 5-minute close: a calibration log (what followed each
// snapshot), coin days (a coin's daily high, low and close, kept after the trades are trimmed) and the pre-registered
// event log (server/prereg/events.json).
//
// The feed: model.recordTrade hands every live trade of a tracked coin to record() (never the boot seed, never a gap-fill
// row: the buckets are stored, so a seed would count them twice). record() is O(1): it adds the trade to its coin's
// entry in the open 5-minute bucket (clock-aligned, like lib/wakeups.mjs), to the site-wide buyer Set (the denominator),
// to the coin's day, and, while a pre-registered event is recording, to that event when the coin's name matches.
// A buyer is a wallet with a $1+ buy (rowshared MIN_USD, the trending and wake rule); a trade without a USD value is $0.
//
// The close: a timer looks every TICK_MS; a bucket that ended GRACE_S ago is closed by ONE sliced job (lib/sliced.mjs:
// a yield every few dozen coins, every write a small transaction). In it, each coin of the bucket is filed under its
// story (coinStoryKey, the cards' own precedence): its narrative when that narrative is "on" (below), else its linked
// post when that post may be shown, else its waking family (under the family's chosen post when that may be shown).
// A narrative is on when 2+ of its coins (copies folded by copyKey: a coin and its copy are one) had a $1+ buyer in
// the last NARR_WIN buckets (1 h, the widest card timeframe, so the series stays continuous; it can include buckets
// where a 5m card would not show the narrative), and stays on until that has been false for NARR_WIN buckets in a row.
// Bot dust (stories.mjs dustWhy) is left out of every story, as the cards leave it out: "paper" from the coin's market
// cap and liquidity now, "tiny" from the bucket itself (all USD over $1+ buyers; the cards use their timeframe, which
// the close cannot know, so the two can differ at the edge). Dust still counts in the site row, which is every $1+
// buyer of every tracked coin. The key is fixed when the bucket closes (at most 5 minutes after the trade) and never
// rewritten: a coin tagged later counts under its narrative from then on only. A story's buyers are the distinct
// wallets over its coins. One row per story with a trade (at most ROWS_MAX, most buyers first) and one row for the whole
// site (key "*") go to story_buckets; the bucket of the first live trade the process saw is flagged partial (flags 1).
// A bucket is "seen" when its "*" row exists and is not partial: the bucket open at a shutdown, the buckets of a
// downtime and the boot bucket are not. A phase, a multiple and a calibration snapshot need all of the last 12 buckets
// seen (else the phase is "new" with `newWhy` "unseen" for about an hour after a restart), and a calibration outcome
// stores how many buckets of its window were seen (cov_1h / cov_6h; the script reads only whole windows).
//
// Normal (the baseline): the median, over the story's own buckets older than 1 h (within the 14 days kept) that had a
// buyer and are not partial, of buyers / site buyers. Buckets with no buyer are left out (with them the median of a
// sporadic story is 0) and so are buckets the server did not see. It is read from sqlite at most every BASE_REFRESH_MS
// per story, in the close job, for at most BASE_PER_CLOSE stories a close (most buyers in the last hour first); never
// in a request. A story has a multiple only when it saw its first buyers 6 h ago or more, has 12+ baseline buckets and
// 10+ buyers in its last 12 buckets (a sum of bucket buyers), all 12 seen; else `multiple` is null and its phase is "new",
// with `newWhy` the gate that failed: "history" (6 h / 12 buckets), "quiet" (under 10 buyers in the hour), "unseen".
// multiple = (buyers / site buyers in the last closed bucket) / normal.
//
// Phase (phaseOf, the first rule that holds, in this order; last30 / prev30 = the summed bucket buyers of the last 6
// closed buckets and of the 6 before them; peak30 = the most any 6 consecutive buckets of the story summed, last30
// included):
//   1. "new"     no multiple (the gates above);
//   2. "rising"  last30 >= 1.25 x prev30 and last30 > prev30, and multiple > 1;
//   3. "peaked"  last30 >= 0.7 x peak30 and last30 < prev30;
//   4. "fading"  last30 <= 0.75 x prev30, or last30 <= 0.5 x peak30;
//   5. "steady"  otherwise.
// A fall of 25 % that is still within 30 % of the peak is "peaked" (rule 3 comes first).
//
// Story start (story_starts, written once, never moved but for one case): a post story starts at the post's time; a
// family story at its wake-up's start (a family's key is its parent, reused by every wake-up: a later wake-up moves it
// forward); a narrative story at its first bucket with a buyer (its shown post changes from build to build). Every story
// also keeps the bucket it first had a buyer in (`first_buyers_at`, the 6 h gate).
//
// Memory: the open buckets (at most OPEN_MAX: per coin a buyer Set, all coins at most PAIRS_MAX wallets; the site Set at
// most SITE_MAX), the stories with a buyer in the last hour (at most STORIES_MAX: 12 small numbers each, a baseline and a
// start; a story idle for an hour is dropped and read back from sqlite when it returns), the last bucket's per-coin buyer
// counts, the coins launched in the last 2 buckets, the coin days touched since the last flush (at most DAYS_MAX), the
// starts and post checks (LRUs) and a small cache of series bodies. Nothing scans the trades table.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { runSliced, drain } from "./sliced.mjs";
import { MIN_USD, r2 } from "./rowshared.mjs";
import { SOL_MINT } from "./jupiter.mjs";
import { postOf, postTime } from "./narrative.mjs";
import { coinStoryKey, parseStoryKey, copyKey, dustWhy, SITE_KEY } from "./stories.mjs";
import { BUCKET_S, GRACE_S } from "./wakeups.mjs";
import { units } from "./pricing.mjs";

export { BUCKET_S, GRACE_S, SITE_KEY };
/** Buckets kept in story_buckets (s), and the calibration log (s). */
export const KEEP_S = 14 * 86_400, CALIB_KEEP_S = 90 * 86_400;
/** The baseline: buckets older than this (s); the gates: history since the first buyers (s), baseline buckets, buyers in the last 12 buckets. */
export const BASE_AGE_S = 3600, MIN_HISTORY_S = 6 * 3600, MIN_BASE_BUCKETS = 12, MIN_HOUR_BUYERS = 10;
/** The phase rule's thresholds (phaseOf). */
export const RISE = 1.25, FALL = 0.75, PEAK_NEAR = 0.7, PEAK_LOW = 0.5;
export const PHASES = Object.freeze(["new", "rising", "peaked", "fading", "steady"]);
/** A launch is "same-minute" when the coin was created within this many seconds of its story's post. */
export const FAST_S = 60;
/** Bucket flags: the bucket the process started in (not whole). */
export const PARTIAL = 1;
/** Memory caps: open buckets, wallets per coin per bucket, coin-wallet pairs per bucket, site wallets per bucket, coins per bucket, stories held, coin days held. */
export const OPEN_MAX = 3, SET_MAX = 20_000, PAIRS_MAX = 500_000, SITE_MAX = 200_000, COINS_MAX = 50_000, STORIES_MAX = 5_000, DAYS_MAX = 200_000;
/** Per close: story rows written at most, rows per transaction, baselines read at most, calibration snapshots at most, outcomes filled per horizon at most, coin days per transaction, calibration rows per transaction. */
export const ROWS_MAX = 2_000, CHUNK = 200, BASE_PER_CLOSE = 100, CALIB_MAX = 300, CALIB_FILL = 300, DAY_CHUNK = 100, CALIB_CHUNK = 100;
/** A story's baseline is read again after this long (ms). */
export const BASE_REFRESH_MS = 30 * 60_000;
/** The trims run this often (s), deleting this many rows per step (story rows fewer: a step's rows are taken story by story, so they share pages). */
export const TRIM_EVERY_S = 3600, TRIM_CHUNK = 2_000, STORY_TRIM_CHUNK = 200;
/** Series bodies cached this long (ms), at most this many; rows a series reads at most (14 days). */
export const SERIES_TTL_MS = 30_000, SERIES_MAX = 64, SERIES_ROWS = KEEP_S / BUCKET_S;
/** Events: a coin is pre-existing when created this long before T (s); the recorder keeps an event's rows from REC_BEFORE_S before T to REC_AFTER_S after it. */
export const PRE_EXISTING_S = 36 * 3600, REC_BEFORE_S = 14 * 86_400, REC_AFTER_S = 36 * 3600;
export const EVENTS_FILE = new URL("../prereg/events.json", import.meta.url);
/** A narrative's window (buckets): its coins with a buyer in it, and how long it stays on after that falls under 2; narratives and coins per narrative held at most. */
export const NARR_WIN = 12, NARR_MAX = 10_000, NARR_COINS_MAX = 1_000;
const TICK_MS = 5_000, STARTS_MAX = 20_000, POSTS_MAX = 20_000, POST_TTL_S = 300, EV_MEMO_MAX = 100_000, SEEN_KEEP = 24;

const fin = (x) => typeof x === "number" && Number.isFinite(x);
export const round1 = (x) => Math.round(x * 10) / 10;
/** 'YYYY-MM-DD' (UTC) of unix s `t`. */
export const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- pure rules
/** The median of numbers, null for none. */
export function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * A story's normal from its stored rows (`[{ t, buyers, siteBuyers, flags }]`, oldest first): `{ ratio, n, firstAt,
 * peak30 }`. `ratio`: the median of buyers / siteBuyers over the rows that ended at or before `nowS` - BASE_AGE_S, had a
 * buyer and a site buyer and are not partial (null for none); `n`: how many; `firstAt`: the first row with a buyer;
 * `peak30`: the most buyers 6 consecutive buckets summed (a missing bucket is 0).
 */
export function baselineOf(rows, nowS) {
  const cut = nowS - BASE_AGE_S, ratios = [];
  let firstAt = null, peak30 = 0, sum = 0, h = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], b = fin(r.buyers) ? r.buyers : 0;
    if (b > 0 && firstAt == null) firstAt = r.t;
    sum += b;
    while (rows[h].t <= r.t - 6 * BUCKET_S) { sum -= fin(rows[h].buyers) ? rows[h].buyers : 0; h++; }
    if (sum > peak30) peak30 = sum;
    if (r.t + BUCKET_S > cut || (r.flags & PARTIAL) || !(b > 0) || !(r.siteBuyers > 0)) continue;
    ratios.push(b / r.siteBuyers);
  }
  return { ratio: median(ratios), n: ratios.length, firstAt, peak30 };
}

/** The history gates: a normal from 12+ buckets, and the first buyers 6 h ago or more. */
export function historyReady({ base, firstBuyersAt, nowS }) {
  return !!(base && base.ratio > 0 && base.n >= MIN_BASE_BUCKETS && fin(firstBuyersAt) && nowS - firstBuyersAt >= MIN_HISTORY_S);
}

/** The gates, then (buyers / site buyers of the last closed bucket) / normal, 1 dp; null when a gate fails. */
export function multipleOf({ base, firstBuyersAt, nowS, last, lastSite, hourBuyers }) {
  if (!historyReady({ base, firstBuyersAt, nowS })) return null;
  if (!(hourBuyers >= MIN_HOUR_BUYERS) || !(lastSite > 0) || !fin(last)) return null;
  return round1(last / lastSite / base.ratio);
}

/** The phase (the head of the file): the first of new, rising, peaked, fading that holds, else steady. */
export function phaseOf({ multiple, last30, prev30, peak30 }) {
  if (multiple == null) return "new";
  if (last30 > prev30 && last30 >= RISE * prev30 && multiple > 1) return "rising";
  if (peak30 > 0 && last30 >= PEAK_NEAR * peak30 && last30 < prev30) return "peaked";
  if (last30 <= FALL * prev30 || last30 <= PEAK_LOW * peak30) return "fading";
  return "steady";
}

// ---------------------------------------------------------------- pre-registered events (pure)
const WORD_RE = /[^\p{L}\p{N}]+/u;
/** The words of a coin's name and symbol (lower case, NFKC) and the same text with everything but letters and digits removed. */
export function nameWords(name, symbol) {
  const s = `${typeof name === "string" ? name : ""} ${typeof symbol === "string" ? symbol : ""}`.normalize("NFKC").toLowerCase();
  return { words: s.split(WORD_RE).filter(Boolean), flat: s.replace(/[^\p{L}\p{N}]+/gu, "") };
}
/** Whether `kw` (`{ words, phrases, parts }`) matches a coin's nameWords: a whole word, consecutive whole words, or a part anywhere. */
export function matchKeywords(kw, { words, flat }) {
  const set = new Set(words);
  for (const w of kw.words ?? []) if (set.has(w)) return true;
  for (const p of kw.phrases ?? []) {
    const ps = p.split(" ").filter(Boolean);
    for (let i = 0; i + ps.length <= words.length; i++) if (ps.every((x, j) => words[i + j] === x)) return true;
  }
  for (const p of kw.parts ?? []) if (p && flat.includes(p)) return true;
  return false;
}
/** Seconds of an offset like "-7d", "+12h", "0". */
export function offsetS(v) {
  const m = /^([+-]?)(\d+)([dhm]?)$/.exec(String(v ?? "").trim());
  if (!m) throw new Error(`bad offset ${v}`);
  const n = Number(m[2]) * ({ d: 86_400, h: 3600, m: 60, "": 1 })[m[3]];
  return m[1] === "-" ? -n : n;
}
const cleanList = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string" && x.trim()).map((x) => x.normalize("NFKC").toLowerCase().trim()) : []);
/** One event of the file, checked: `{ id, what, T, kw, windows: { baseline, pre, event, after } as [from, to) unix s, recFrom, recTo }`; throws for a bad one. */
export function parseEvent(e) {
  if (!e || typeof e.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(e.id)) throw new Error("event id must be lower-case letters, digits and dashes");
  const T = Math.floor(Date.parse(e.at) / 1000);
  if (!Number.isFinite(T)) throw new Error(`event ${e.id}: bad time`);
  const kw = { words: cleanList(e.keywords?.words), phrases: cleanList(e.keywords?.phrases), parts: cleanList(e.keywords?.parts).map((p) => p.replace(/[^\p{L}\p{N}]+/gu, "")).filter(Boolean) };
  if (!kw.words.length && !kw.phrases.length && !kw.parts.length) throw new Error(`event ${e.id}: no keywords`);
  const w = e.windows ?? {}, win = {};
  for (const name of ["baseline", "pre", "event", "after"]) {
    const v = w[name] ?? { baseline: ["-7d", "-2d"], pre: ["-24h", "0"], event: ["0", "+12h"], after: ["+12h", "+36h"] }[name];
    win[name] = [T + offsetS(v[0]), T + offsetS(v[1])];
  }
  return { id: e.id, what: typeof e.what === "string" ? e.what : "", T, kw, windows: win, recFrom: T - REC_BEFORE_S, recTo: Math.max(T + REC_AFTER_S, win.after[1]) };
}

/**
 * An event's result by the pre-registered rule (server/prereg/events.json `rule`): `ev` from parseEvent; `rows`: Map
 * bucket t → `{ buyers, preBuyers, newBuyers }` (event_buckets); `site`: Map bucket t → site buyers (event_buckets
 * `site_buyers`: the recorder writes a row for every bucket it closed while the event recorded, 0 matched buyers
 * included, so a bucket with no row is one it did not watch). Returns the window shares, the comparison days and the verdict ("HIT" | "MISS" | "NOT ENOUGH DATA").
 */
export function eventResult(ev, rows, site, { minDays = 5, minObserved = 72 } = {}) {
  const share = (from, to, field = "buyers") => {
    let num = 0, den = 0, obs = 0;
    for (let t = from - (((from % BUCKET_S) + BUCKET_S) % BUCKET_S); t < to; t += BUCKET_S) {
      if (t < from) continue;
      const s = site.get(t);
      if (!(s > 0)) continue;
      obs++; den += s; num += rows.get(t)?.[field] ?? 0;
    }
    return { share: den > 0 ? num / den : null, buyers: num, siteBuyers: den, observed: obs };
  };
  const W = ev.windows, len = W.event[1] - W.event[0];
  const out = { id: ev.id, T: ev.T, baseline: share(...W.baseline), pre: share(...W.pre), event: share(...W.event), after: share(...W.after),
    preBaseline: share(...W.baseline, "preBuyers"), preEvent: share(...W.event, "preBuyers"), comparison: [], p90: null, verdict: "NOT ENOUGH DATA", why: "" };
  for (let d = 1; d <= 14; d++) {
    const from = W.event[0] - d * 86_400, s = share(from, from + len);
    if (s.observed >= Math.min(minObserved, len / BUCKET_S / 2) && s.share != null) out.comparison.push({ day: d, ...s });
  }
  const xs = out.comparison.map((c) => c.share).sort((a, b) => a - b);
  if (xs.length) out.p90 = xs[Math.max(0, Math.ceil(0.9 * xs.length) - 1)];
  if (xs.length < minDays) { out.why = `${xs.length} comparison days (needs ${minDays})`; return out; }
  if (out.event.share == null) { out.why = "the event window was not observed"; return out; }
  if (out.preBaseline.share == null || out.preEvent.share == null) { out.why = "no observed baseline for the pre-existing coins"; return out; }
  const above = out.event.share > out.p90, pre = out.preEvent.share > out.preBaseline.share;
  out.verdict = above && pre ? "HIT" : "MISS";
  out.why = `event share ${above ? ">" : "<="} p90 of ${xs.length} days; pre-existing coins ${pre ? "above" : "not above"} their baseline`;
  return out;
}

// ---------------------------------------------------------------- the recorder
function bucketState(k, partial) { return { k, partial, coins: new Map(), site: new Set(), pairs: 0, ev: null }; }

export class Attention {
  /** `model`: the index (read only, plus its db); `events`: a parsed events file (tests), else start() reads EVENTS_FILE; `now` in ms. */
  constructor({ model, now = Date.now, log = console, events = null } = {}) {
    this.model = model; this.now = now; this.log = log;
    // A bucket at or before it is partial: set at the first live trade (record), from the clock then, not at construction
    // (the live streams start 20 s or more after it, so a start-up that crossed a bucket edge left a partial bucket whole).
    this.bootK = null;
    this.open = new Map();     // bucket number → state: { k, partial, coins: mint → { b: Set | null, buys, usd, vol, sells, p, pt }, site: Set, pairs, ev }
    this.seen = new Set(); this.seenInit = false; // the bucket numbers seen whole (the last SEEN_KEEP)
    this.narr = new Map();     // narrative id → { coins: copy key → the last bucket with a $1+ buyer, onK: the last bucket it had 2+ } (LRU)
    this.closedK = -1;         // the newest bucket closed (a later print goes to the one after it)
    this.stories = new Map();  // story key → { key, hist: [{ k, b, s }] (its last 12 buckets with a buyer), base, baseAt, fill, peak30, att, lead, lastK, usd, start }, least recently active first
    this.starts = new Map();   // story key → { startAt, source, firstBuyersAt } | null (LRU)
    this.posts = new Map();    // post id → { ok, at } (LRU): whether the post may be shown, checked at most every POST_TTL_S
    this.lastCoin = new Map(); this.lastK = -1; // the last closed bucket's buyers per coin (a card's leader)
    this.launched = new Map(); // coin mint → the bucket its launch was counted in (the last 2 buckets)
    this.days = new Map();     // mint|day → the coin's day since the last flush
    this.events = []; this.evOpen = []; this.evMemo = new Map();
    this.series = new Map();   // story key|since → { at, body }
    this.job = null; this.timer = null; this.trimmedAt = 0;
    this.stats = { trades: 0, capped: 0, late: 0, daysCapped: 0, closes: 0, lastCloseMs: null, maxSliceMs: 0, lastStepMs: null, lastStepAt: null, maxStepMs: 0, maxStepAt: null, rows: 0, lastRows: 0, baselines: 0, calib: 0, filled: 0, dayRows: 0, eventRows: 0, trimmed: 0, evictions: 0, errors: 0 };
    if (events) this.setEvents(events);
  }
  #nowS() { return Math.floor(this.now() / 1000); }
  snapshot() {
    let held = 0;
    for (const b of this.open.values()) held += b.pairs;
    return { open: this.open.size, walletsOpen: held, stories: this.stories.size, days: this.days.size, events: this.events.length, eventsRecording: this.evOpen.map((e) => e.id), closing: !!this.job, ...this.stats };
  }

  /** Reads the pre-registered events (server/prereg/events.json); a bad file or event is logged and skipped. */
  loadEvents(file = EVENTS_FILE) {
    try { this.setEvents(JSON.parse(readFileSync(file, "utf8"))); } catch (e) { this.log.warn?.(`attention: events not loaded (${e?.code ?? e?.message ?? "error"})`); }
    return this;
  }
  setEvents(doc) {
    const list = Array.isArray(doc) ? doc : doc?.events ?? [];
    this.events = [];
    for (const e of list) { try { this.events.push(parseEvent(e)); } catch (err) { this.log.warn?.(`attention: event skipped: ${err.message}`); } }
    this.evMemo.clear(); this.#refreshEvents(this.#nowS());
    return this;
  }
  #refreshEvents(nowS) { this.evOpen = this.events.filter((e) => nowS >= e.recFrom - BUCKET_S && nowS < e.recTo + BUCKET_S); }

  start({ eventsFile = EVENTS_FILE } = {}) {
    if (!this.events.length && eventsFile) this.loadEvents(eventsFile);
    if (!this.timer) { this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.stats.errors++; this.log.warn?.(`attention: ${e?.message ?? e}`); } }, TICK_MS); this.timer.unref?.(); }
    return this;
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  // ---------------------------------------------------------------- the feed
  /** One live trade `{ mint, time, isBuy, valueUsd, user, priceUsd }` of the model: O(1). */
  record(t) {
    const time = Math.floor(Number(t?.time));
    if (!Number.isFinite(time) || typeof t.mint !== "string") return;
    const c = this.model.coins.get(t.mint);
    if (!c || !c.tracked) return;
    this.stats.trades++;
    const nowK = Math.floor(this.#nowS() / BUCKET_S);
    let k = Math.floor(time / BUCKET_S);
    if (k > nowK + 1) k = nowK;                    // a block time far ahead of our clock
    if (k <= this.closedK) k = this.closedK + 1;   // a late print: the first bucket still open
    if (this.bootK == null) this.bootK = Math.max(nowK, k); // the first live trade: its bucket and the one open now are partial
    let b = this.open.get(k);
    if (!b) {
      if (this.open.size >= OPEN_MAX) { let top = -1; for (const x of this.open.keys()) if (x > top) top = x; b = this.open.get(top); this.stats.late++; }
      else this.open.set(k, b = bucketState(k, k <= this.bootK));
    }
    const usd = fin(t.valueUsd) ? t.valueUsd : 0, p = fin(t.priceUsd) && t.priceUsd > 0 ? t.priceUsd : null;
    const buyer = !!t.isBuy && usd >= MIN_USD && typeof t.user === "string";
    this.#day(t.mint, time, p, usd, buyer);
    let C = b.coins.get(t.mint);
    if (!C) {
      if (b.coins.size >= COINS_MAX) { this.stats.capped++; return; }
      b.coins.set(t.mint, C = { b: null, buys: 0, usd: 0, vol: 0, sells: 0, p: null, pt: -Infinity });
    }
    C.vol += usd;
    if (t.isBuy) { C.buys++; C.usd += usd; } else C.sells++;
    if (p != null && time >= C.pt) { C.p = p; C.pt = time; }
    if (buyer) {
      const s = (C.b ??= new Set());
      if (!s.has(t.user)) { if (s.size < SET_MAX && b.pairs < PAIRS_MAX) { s.add(t.user); b.pairs++; } else this.stats.capped++; }
      if (b.site.size < SITE_MAX) b.site.add(t.user); else if (!b.site.has(t.user)) this.stats.capped++;
    }
    if (this.evOpen.length) this.#event(b, c, time, buyer ? t.user : null);
  }

  /** The coin's day (UTC): high, low and close from priced trades, buys, trades, USD volume; buyers are added at the close. */
  #day(mint, time, p, usd, buyer) {
    const d = Math.floor(time / 86_400), key = `${mint}|${d}`;
    let D = this.days.get(key);
    if (!D) {
      if (this.days.size >= DAYS_MAX) { this.stats.daysCapped++; return; }
      this.days.set(key, D = { mint, d, hi: null, lo: null, close: null, ct: null, buyers: 0, buys: 0, trades: 0, vol: 0 });
    }
    D.trades++; D.vol += usd;
    if (buyer) D.buys++;
    if (p != null) {
      if (D.hi == null || p > D.hi) D.hi = p;
      if (D.lo == null || p < D.lo) D.lo = p;
      if (D.ct == null || time >= D.ct) { D.ct = time; D.close = p; }
    }
  }
  #dayBuyers(mint, k, n) {
    if (!(n > 0)) return;
    const d = Math.floor((k * BUCKET_S) / 86_400), key = `${mint}|${d}`;
    let D = this.days.get(key);
    if (!D) {
      if (this.days.size >= DAYS_MAX) { this.stats.daysCapped++; return; }
      this.days.set(key, D = { mint, d, hi: null, lo: null, close: null, ct: null, buyers: 0, buys: 0, trades: 0, vol: 0 });
    }
    D.buyers += n;
  }

  /** The events a coin's name matches (all events, memoized once the coin has a name). */
  #evIds(mint) {
    const hit = this.evMemo.get(mint);
    if (hit) return hit;
    const { name, symbol } = this.model.nameOf(mint);
    if (!name && !symbol) return [];
    const w = nameWords(name, symbol), ids = this.events.filter((e) => matchKeywords(e.kw, w)).map((e) => e.id);
    this.evMemo.set(mint, ids);
    if (this.evMemo.size > EV_MEMO_MAX) this.evMemo.delete(this.evMemo.keys().next().value);
    return ids;
  }
  #event(b, c, time, user) {
    const ids = this.#evIds(c.mint);
    if (!ids.length) return;
    for (const e of this.evOpen) {
      if (time < e.recFrom || time >= e.recTo || !ids.includes(e.id)) continue;
      const M = (b.ev ??= new Map());
      let E = M.get(e.id);
      if (!E) M.set(e.id, E = { all: new Set(), pre: new Set(), nw: new Set(), preC: new Set(), newC: new Set() });
      const pre = c.createdAt != null && c.createdAt < e.T - PRE_EXISTING_S;
      (pre ? E.preC : E.newC).add(c.mint);
      if (user && E.all.size < SET_MAX) { E.all.add(user); (pre ? E.pre : E.nw).add(user); }
    }
  }

  // ---------------------------------------------------------------- the close
  /** Starts the close of the oldest bucket that ended GRACE_S ago (one job at a time); returns its promise, or null when none is due. */
  tick(nowS = this.#nowS()) {
    this.#refreshEvents(nowS);
    if (this.job) return this.job;
    const b = this.#takeDue(nowS);
    if (!b) return null;
    this.job = runSliced(this.closeGen(b, nowS)).then((run) => {
      this.stats.lastCloseMs = r2(run.cpuMs);
      if (run.maxSliceMs > this.stats.maxSliceMs) this.stats.maxSliceMs = r2(run.maxSliceMs);
      this.stats.lastStepMs = r2(run.maxStepMs); this.stats.lastStepAt = run.maxStepAt;
      if (run.maxStepMs > this.stats.maxStepMs) { this.stats.maxStepMs = r2(run.maxStepMs); this.stats.maxStepAt = run.maxStepAt; }
    }).catch((e) => { this.stats.errors++; this.log.warn?.(`attention: close failed: ${e?.message ?? e}`); }).finally(() => { this.job = null; });
    return this.job;
  }
  #takeDue(nowS) {
    let due = null;
    for (const k of this.open.keys()) if ((k + 1) * BUCKET_S + GRACE_S <= nowS && (due == null || k < due)) due = k;
    if (due == null) return null;
    const b = this.open.get(due);
    this.open.delete(due);
    if (due > this.closedK) this.closedK = due;
    return b;
  }
  /** Every due close at once (tests, scripts); returns how many ran. */
  closeNow(nowS = this.#nowS()) {
    this.#refreshEvents(nowS);
    let n = 0, b;
    while ((b = this.#takeDue(nowS))) { drain(this.closeGen(b, nowS)); n++; }
    return n;
  }

  /** Whether post `id` may be shown (stored, ok, with a handle, not flagged): the post store's own peek, no fetch queued; checked at most every POST_TTL_S. */
  #postOk(id, nowS) {
    const hit = this.posts.get(id);
    if (hit && nowS - hit.at < POST_TTL_S) return hit.ok;
    let ok = false;
    try { const r = this.model.wakeups?.narrative?.posts?.peek?.(id); ok = !!(r && r.state === "ok" && r.handle && !r.flagged); } catch { ok = false; }
    this.posts.delete(id); this.posts.set(id, { ok, at: nowS });
    if (this.posts.size > POSTS_MAX) this.posts.delete(this.posts.keys().next().value);
    return ok;
  }
  #remember(map, key, v, max) { map.delete(key); map.set(key, v); if (map.size > max) map.delete(map.keys().next().value); }

  /** The story's start (story_starts): read once, written when new or when a family's later wake-up moves it. */
  #startOf(key, s, T, out) {
    let r = this.starts.get(key);
    if (r === undefined) { try { r = this.model.db.storyStartGet(key); } catch { r = null; } this.#remember(this.starts, key, r, STARTS_MAX); }
    const kind = parseStoryKey(key)?.kind;
    if (!r) {
      let startAt = T, source = "buyers";
      if (kind === "post") { const pt = postTime(key, this.now()); if (pt != null) { startAt = pt; source = "post"; } }
      else if (kind === "family" && fin(s.fam?.startedAt)) { startAt = s.fam.startedAt; source = "wake"; }
      r = { startAt, source, firstBuyersAt: T };
      out.push({ key, ...r }); this.#remember(this.starts, key, r, STARTS_MAX);
    } else if (kind === "family" && fin(s.fam?.startedAt) && s.fam.startedAt > r.startAt) {
      r = { ...r, startAt: s.fam.startedAt, source: "wake" };
      out.push({ key, ...r }); this.#remember(this.starts, key, r, STARTS_MAX);
    }
    return r;
  }

  /** Whether a coin of the bucket is bot dust (stories.mjs dustWhy): "paper" from its market cap and liquidity now (memory only), "tiny" from the bucket's USD over its $1+ buyers. */
  #dustOf(c, C, nb, px) {
    let liqUsd = null, mcapUsd = null;
    const model = this.model, cr = model.coinRows;
    if (c && typeof cr?.liqUsdOf === "function") {
      try { liqUsd = cr.liqUsdOf(c, px); } catch { liqUsd = null; }
      if (liqUsd > 0) {
        try {
          const p = model.priceOf?.(c.mint)?.priceUsd;
          const v = p > 0 ? p * units(c.tokenTotalSupply ?? 0, model.decimalsOf(c.mint)) : null;
          mcapUsd = fin(v) ? v : null;
        } catch { mcapUsd = null; }
      }
    }
    return dustWhy({ liqUsd, mcapUsd, tf: { buyers: nb, volUsd: C.vol ?? C.usd } });
  }
  /** What folds a coin with its copies (stories.mjs copyKey: ticker and image), else its mint. */
  #copyKeyOf(m) {
    let k = null;
    try { k = copyKey({ symbol: this.model.nameOf(m)?.symbol, image: this.model.metaFor({ mint: m })?.image }); } catch { k = null; }
    return k ?? m;
  }
  /** Narrative `id` had a $1+ buyer of coin (copy key) `ck` in bucket `K`. */
  #narrSaw(id, ck, K) {
    let N = this.narr.get(id);
    if (N) this.narr.delete(id); else N = { coins: new Map(), onK: null };
    this.narr.set(id, N);
    if (N.coins.has(ck)) N.coins.delete(ck); else if (N.coins.size >= NARR_COINS_MAX) return;
    N.coins.set(ck, K); // oldest first, so the window's cut stops at the first one inside it
    while (this.narr.size > NARR_MAX) this.narr.delete(this.narr.keys().next().value);
  }
  /** Whether narrative `id` is on at bucket `K` (the head of the file); a narrative with nothing left is let go. */
  #narrOn(id, K) {
    const N = this.narr.get(id);
    if (!N) return false;
    for (const [ck, k] of N.coins) { if (k > K - NARR_WIN) break; N.coins.delete(ck); }
    if (N.coins.size >= 2) N.onK = K;
    const on = N.onK != null && K - N.onK < NARR_WIN;
    if (!on && !N.coins.size) this.narr.delete(id);
    return on;
  }

  /**
   * The close of bucket `b`, in steps (the head of the file): each coin's facts (a yield every 64 coins: a narrative
   * tag may be one indexed read), the stories (a yield every 256 coins and every 8 192 wallets merged), the rows (a
   * transaction of CHUNK rows per step), the stories' state, the baselines due (one read per step), the attention of
   * every story held, the calibration snapshots and outcomes, the coin days, the event rows, and once an hour the trims.
   */
  *closeGen(b, nowS) {
    const model = this.model, db = model.db, K = b.k, T = K * BUCKET_S, nowMs = this.now();
    const nt = model.coinRows?.narr?.on ? model.coinRows.narr : null, wk = model.wakeups;
    this.stats.closes++;
    let st = "coins"; // the step's label (lib/sliced.mjs: the slowest step's is kept in stats)
    // 1. each coin's facts: its story's inputs, whether it is dust, its narrative's window
    const list = [], tags = new Set(), px = new Map();
    let n = 0;
    for (const [m, C] of b.coins) {
      if ((++n & 63) === 0) yield st;
      const c = model.coins.get(m) ?? null;
      let tagId = null;
      try { const tg = nt ? nt.tagOf(m) : null; tagId = tg && Number.isInteger(tg.id) ? tg.id : null; } catch { tagId = null; }
      let pid = null;
      try { pid = c ? postOf(model.metaFor(c)) : null; } catch { pid = null; }
      const pok = pid != null && this.#postOk(pid, nowS);
      let fam = null;
      const q = c?.quoteMint;
      if (q && q !== SOL_MINT) {
        let w = null;
        try { w = wk?.wakeOf?.(q, nowS) ?? null; } catch { w = null; }
        if (w && w.live && !w.silent) fam = { mint: q, postId: w.postId ?? null, postOk: w.postId != null && this.#postOk(w.postId, nowS), startedAt: w.startedAt };
      }
      const nb = C.b?.size ?? 0, dust = this.#dustOf(c, C, nb, px) != null;
      if (tagId != null) { tags.add(tagId); if (nb > 0 && !dust) this.#narrSaw(tagId, this.#copyKeyOf(m), K); }
      list.push({ m, C, c, tagId, pid, pok, fam, dust });
    }
    yield st;
    st = "narratives";
    const narrOn = new Set();
    for (const id of tags) { if ((++n & 255) === 0) yield st; if (this.#narrOn(id, K)) narrOn.add(id); }
    // 2. the stories of the bucket
    yield st; // the step before ends here, under its own label
    st = "stories";
    const per = new Map();
    let siteUsd = 0, siteSells = 0, siteLaunches = 0, siteFast = 0;
    for (const x of list) {
      if ((++n & 255) === 0) yield st;
      const C = x.C, nb = C.b?.size ?? 0;
      siteUsd += C.usd; siteSells += C.sells;
      this.#dayBuyers(x.m, K, nb);
      const at = x.c?.createdAt;
      const launch = fin(at) && at >= T - BUCKET_S && at < T + BUCKET_S && !this.launched.has(x.m);
      if (launch) { this.launched.set(x.m, K); siteLaunches++; }
      if (x.dust) continue; // bot dust: in the site row, in no story (as on the cards)
      const key = coinStoryKey({ narrativeId: x.tagId, narrativeCoins: narrOn.has(x.tagId) ? 2 : 0, postId: x.pid, postOk: x.pok, family: x.fam });
      if (key == null) continue;
      let s = per.get(key);
      if (!s) per.set(key, s = { key, sets: [], usd: 0, sells: 0, coins: 0, launches: 0, fast: 0, lead: null, leadN: 0, leadP: null, fam: null, buyers: 0 });
      s.usd += C.usd; s.sells += C.sells; s.coins++;
      if (x.fam && !s.fam) s.fam = x.fam;
      if (launch) {
        s.launches++;
        // the story's post: a post story's own; a narrative's, the post this coin links (when it may be shown); a family has none
        const kind = parseStoryKey(key)?.kind;
        const pa = kind === "post" ? postTime(key, nowMs) : kind === "narrative" && x.pok ? postTime(x.pid, nowMs) : null;
        if (pa != null && Math.abs(at - pa) <= FAST_S) { s.fast++; siteFast++; }
      }
      if (nb > 0) {
        s.sets.push(C.b);
        if (nb > s.leadN || (nb === s.leadN && x.m < s.lead)) { s.lead = x.m; s.leadN = nb; s.leadP = C.p; }
      }
    }
    yield st;
    st = "merge";
    let merged = 0;
    for (const s of per.values()) {
      if (s.sets.length === 1) s.buyers = s.sets[0].size;
      else if (s.sets.length > 1) {
        const u = new Set();
        for (const set of s.sets) for (const w of set) { u.add(w); if ((++merged & 8191) === 0) yield st; }
        s.buyers = u.size;
      }
      s.sets = null;
      if ((++n & 255) === 0) yield st;
    }
    yield st;
    const ranked = [...per.values()].sort((x, y) => y.buyers - x.buyers || y.coins - x.coins || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const kept = ranked.slice(0, ROWS_MAX), flags = b.partial ? PARTIAL : 0, siteN = b.site.size;
    // 3. the rows: one per story kept, one for the site
    yield st; // the step before ends here, under its own label
    st = "rows";
    const rows = kept.map((s) => ({ key: s.key, t: T, buyers: s.buyers, buyUsd: r2(s.usd), sells: s.sells, launchesFast: s.fast, launches: s.launches, siteBuyers: siteN, leaderMint: s.lead, leaderBuyers: s.leadN, coins: s.coins, flags }));
    rows.push({ key: SITE_KEY, t: T, buyers: siteN, buyUsd: r2(siteUsd), sells: siteSells, launchesFast: siteFast, launches: siteLaunches, siteBuyers: siteN, leaderMint: null, leaderBuyers: 0, coins: b.coins.size, flags });
    for (let i = 0; i < rows.length; i += CHUNK) {
      yield st;
      try { db.storyBucketsPut(rows.slice(i, i + CHUNK)); } catch (e) { this.stats.errors++; this.log.warn?.(`attention: rows not stored (${e?.code ?? e?.message ?? "error"})`); }
    }
    this.stats.rows += rows.length; this.stats.lastRows = rows.length;
    yield st; // the step before ends here, under its own label
    st = "seen";
    // the buckets seen whole: the process's first close reads the last hour's site rows back once (one indexed read)
    if (!this.seenInit) {
      this.seenInit = true;
      let rs = [];
      try { rs = db.storyRows(SITE_KEY, T - 12 * BUCKET_S, 12); } catch { rs = []; }
      for (const r of rs) if (r.t < T && !(r.flags & PARTIAL)) this.seen.add(Math.floor(r.t / BUCKET_S));
    }
    if (!b.partial) this.seen.add(K);
    for (const k of this.seen) if (k <= K - SEEN_KEEP) this.seen.delete(k);
    let seenLast = 0, seenPrev = 0;
    for (let j = 0; j < 12; j++) if (this.seen.has(K - j)) { if (j < 6) seenLast++; else seenPrev++; }
    const whole = seenLast === 6 && seenPrev === 6; // the last hour was seen whole: a phase, a multiple and a snapshot mean something
    // 4. the stories' state
    yield st; // the step before ends here, under its own label
    st = "state";
    const starts = [];
    for (const s of kept) {
      if (!(s.buyers > 0)) continue;
      if ((++n & 63) === 0) yield st;
      let S = this.stories.get(s.key);
      if (S) this.stories.delete(s.key);
      else S = { key: s.key, hist: [], base: null, baseAt: -Infinity, fill: true, peak30: 0, att: null, lead: null, lastK: -1, usd: 0, start: null };
      this.stories.set(s.key, S); // to the end: the most recently active
      S.start = this.#startOf(s.key, s, T, starts);
      S.hist.push({ k: K, b: s.buyers, s: siteN });
      S.lead = s.lead ? { mint: s.lead, n: s.leadN, p: s.leadP } : null; S.lastK = K; S.usd = s.usd;
    }
    while (this.stories.size > STORIES_MAX) { this.stories.delete(this.stories.keys().next().value); this.stats.evictions++; }
    yield st; // the step before ends here, under its own label
    st = "starts";
    try { db.storyStartsPut(starts, nowS); } catch (e) { this.stats.errors++; this.log.warn?.(`attention: starts not stored (${e?.code ?? e?.message ?? "error"})`); }
    yield st;
    // 5. the baselines due: most buyers in the last hour first; a story new to memory reads its last hour back too
    yield st; // the step before ends here, under its own label
    st = "baselines";
    const hourOf = (S) => { let h = 0; for (const x of S.hist) if (x.k > K - 12) h += x.b; return h; };
    const due = [];
    for (const S of this.stories.values()) {
      if ((++n & 255) === 0) yield st;
      const h = hourOf(S), first = S.start?.firstBuyersAt;
      if (S.fill || (h >= MIN_HOUR_BUYERS && fin(first) && nowS - first >= MIN_HISTORY_S && nowMs - S.baseAt >= BASE_REFRESH_MS)) due.push([S, h]);
    }
    due.sort((x, y) => y[1] - x[1]);
    for (const [S] of due.slice(0, BASE_PER_CLOSE)) {
      yield st;
      let rs = [];
      try { rs = db.storyBaseRows(S.key, nowS - KEEP_S, SERIES_ROWS + 16); } catch { rs = []; }
      S.base = baselineOf(rs, nowS); S.baseAt = nowMs; this.stats.baselines++;
      if (S.base.peak30 > S.peak30) S.peak30 = S.base.peak30;
      if (S.fill) {
        const have = new Set(S.hist.map((x) => x.k));
        for (const r of rs) { const k = Math.floor(r.t / BUCKET_S); if (k > K - 12 && k < K && !have.has(k) && r.buyers > 0) S.hist.push({ k, b: r.buyers, s: r.siteBuyers }); }
        S.hist.sort((x, y) => x.k - y.k);
        S.fill = false;
      }
    }
    yield st;
    // 6. every story's attention as of this close; a story with no buyer in 12 buckets is let go
    yield st; // the step before ends here, under its own label
    st = "attention";
    for (const [key, S] of this.stories) {
      if ((++n & 255) === 0) yield st;
      while (S.hist.length && S.hist[0].k <= K - 12) S.hist.shift();
      if (!S.hist.length) { this.stories.delete(key); continue; }
      const last = S.lastK === K ? S.hist[S.hist.length - 1].b : 0;
      let last30 = 0, prev30 = 0;
      for (const x of S.hist) { if (x.k > K - 6) last30 += x.b; else prev30 += x.b; }
      if (whole && last30 > S.peak30) S.peak30 = last30;
      const firstBuyersAt = S.start?.firstBuyersAt;
      const multiple = whole ? multipleOf({ base: S.base, firstBuyersAt, nowS, last, lastSite: siteN, hourBuyers: last30 + prev30 }) : null;
      const newWhy = multiple != null ? null : !whole ? "unseen" : !historyReady({ base: S.base, firstBuyersAt, nowS }) ? "history" : "quiet";
      S.att = { k: K, last, last30, prev30, hour: last30 + prev30, multiple, phase: phaseOf({ multiple, last30, prev30, peak30: S.peak30 }), newWhy };
    }
    yield st;
    // 7. calibration: a snapshot of the busiest stories (only when the last hour was seen whole: a restart's hole would
    // read as a drop), then the outcomes that came due (1 h and 6 h after)
    yield st; // the step before ends here, under its own label
    st = "calib";
    const snaps = !whole ? [] : [...this.stories.values()].filter((S) => S.att && S.att.hour > 0).sort((x, y) => y.att.hour - x.att.hour || (x.key < y.key ? -1 : 1)).slice(0, CALIB_MAX);
    const crow = [];
    for (const S of snaps) {
      if ((++n & 15) === 0) yield st;
      const lead = S.lead?.mint ?? null;
      let p = lead ? b.coins.get(lead)?.p ?? null : null;
      if (lead && p == null) { try { p = db.usdPriceAt(lead, T + BUCKET_S)?.priceUsd ?? null; } catch { p = null; } }
      crow.push({ key: S.key, t: T, phase: S.att.phase, multiple: S.att.multiple, buyers5m: S.att.last, hourBuyers: S.att.hour, leaderMint: lead, leaderPriceUsd: p, storyBuyUsd: S.lastK === K ? r2(S.usd) : 0 });
    }
    for (let i = 0; i < crow.length; i += CALIB_CHUNK) {
      if (i) yield st;
      try { db.calibPut(crow.slice(i, i + CALIB_CHUNK)); this.stats.calib += Math.min(CALIB_CHUNK, crow.length - i); } catch (e) { this.stats.errors++; this.log.warn?.(`attention: calibration not stored (${e?.code ?? e?.message ?? "error"})`); }
    }
    yield st; // the step before ends here, under its own label
    st = "fill";
    yield* this.#fillGen(T);
    // 8. coin days: the deltas since the last flush
    yield st; // the step before ends here, under its own label
    st = "days";
    const days = [...this.days.values()];
    this.days = new Map();
    for (let i = 0; i < days.length; i += DAY_CHUNK) {
      yield st;
      try { db.coinDaysAdd(days.slice(i, i + DAY_CHUNK).map((D) => ({ mint: D.mint, day: dayOf(D.d * 86_400), high: D.hi, low: D.lo, close: D.close, closeT: D.ct, buyers: D.buyers, buys: D.buys, trades: D.trades, volume: r2(D.vol) }))); this.stats.dayRows += Math.min(DAY_CHUNK, days.length - i); }
      catch (e) { this.stats.errors++; this.log.warn?.(`attention: coin days not stored (${e?.code ?? e?.message ?? "error"})`); }
    }
    yield st; // the step before ends here, under its own label
    st = "events";
    // 9. the events' rows: one per event recording at this bucket, with 0 matched buyers too, carrying the site's buyers
    // (the denominator, kept with the event: story_buckets is trimmed after 14 days) and the flags
    const evs = this.evOpen.filter((e) => T + BUCKET_S > e.recFrom && T < e.recTo);
    if (evs.length) {
      yield st;
      const er = evs.map((e) => { const E = b.ev?.get(e.id); return { id: e.id, t: T, buyers: E?.all.size ?? 0, preBuyers: E?.pre.size ?? 0, newBuyers: E?.nw.size ?? 0, preCoins: E?.preC.size ?? 0, newCoins: E?.newC.size ?? 0, siteBuyers: siteN, flags }; });
      try { db.eventBucketsPut(er); this.stats.eventRows += er.length; } catch (e) { this.stats.errors++; this.log.warn?.(`attention: event rows not stored (${e?.code ?? e?.message ?? "error"})`); }
    }
    // 10. the last bucket's per-coin buyers (a card's leader), the launches of the last 2 buckets, the series cache
    yield st; // the step before ends here, under its own label
    st = "last";
    const lc = new Map();
    for (const x of list) { const nb = x.C.b?.size ?? 0; if (nb > 0) lc.set(x.m, nb); }
    this.lastCoin = lc; this.lastK = K;
    for (const [m, k] of this.launched) { if (k >= K - 1) break; this.launched.delete(m); }
    this.series.clear();
    // 11. the trims, once an hour, a few thousand rows a step
    yield st; // the step before ends here, under its own label
    st = "trims";
    if (nowS - this.trimmedAt >= TRIM_EVERY_S) {
      this.trimmedAt = nowS;
      // story rows go an hour window at a time (db.storyTrim), so a short step does not mean the end: they stop at 0
      for (const [trim, before, chunk, untilNone] of [[(x, l) => db.storyTrim(x, l), nowS - KEEP_S, STORY_TRIM_CHUNK, true], [(x, l) => db.calibTrim(x, l), nowS - CALIB_KEEP_S, TRIM_CHUNK, false]]) {
        for (;;) {
          yield st;
          let got = 0;
          try { got = trim(before, chunk); } catch { got = 0; }
          this.stats.trimmed += got;
          if (untilNone ? got === 0 : got < chunk) break;
        }
      }
    }
    yield st; // the last step carries its label too ("end" is then an empty step)
  }

  /**
   * The calibration outcomes that came due by bucket `T` (its rows are written): per snapshot one sum of story rows and
   * one indexed price read per horizon, and per snapshot time one count of the window's buckets seen whole (`cov`: a
   * bucket the server did not see would read as 0 buyers; the script keeps only whole windows).
   */
  *#fillGen(T) {
    const db = this.model.db;
    let n = 0;
    for (const h of [1, 6]) {
      const H = h * 3600, covs = new Map();
      let due = [];
      try { due = db.calibDue(h, T - H, CALIB_FILL); } catch { due = []; }
      const out = [];
      for (const r of due) {
        if ((++n & 15) === 0) yield `fill${h}h`;
        const from = r.t + BUCKET_S, to = from + H;
        let buyers = null, priceUsd = null, cov = covs.get(r.t);
        try { buyers = db.storyBuyersIn(r.key, from, to).buyers; } catch { buyers = null; }
        if (cov === undefined) { try { cov = db.siteSeenIn(from, to); } catch { cov = null; } covs.set(r.t, cov); }
        if (r.leaderMint) { try { priceUsd = db.usdPriceAt(r.leaderMint, to)?.priceUsd ?? null; } catch { priceUsd = null; } }
        out.push({ key: r.key, t: r.t, buyers, priceUsd, cov });
      }
      for (let i = 0; i < out.length; i += CALIB_CHUNK) {
        yield `fill${h}h`;
        try { db.calibFill(h, out.slice(i, i + CALIB_CHUNK)); this.stats.filled += Math.min(CALIB_CHUNK, out.length - i); } catch (e) { this.stats.errors++; this.log.warn?.(`attention: outcomes not stored (${e?.code ?? e?.message ?? "error"})`); }
      }
      yield `fill${h}h`;
    }
  }

  // ---------------------------------------------------------------- reads (memory only, except the series)
  #openNow(nowS) {
    const k = Math.floor(nowS / BUCKET_S), b = this.open.get(k);
    if (b) return b;
    let top = null;
    for (const x of this.open.values()) if (!top || x.k > top.k) top = x;
    return top && top.k <= k ? top : null;
  }

  /**
   * The `attention` of a stories card (GET /api/stories, README §API), from memory only: `{ phase, buyers5m: { now,
   * last }, multiple, newWhy, startAt, startSource, minutes, leader: { mint, symbol, share } | null }` (`newWhy`, only
   * for "new": "history" | "quiet" | "unseen", the gate that failed; a story with no close yet is "history"). `now`: distinct wallets
   * that bought the card's coins (copies included) in the bucket still open; `last`: the story's buyers in the last
   * closed bucket. `leader`: the card's coin with the most buyers over the last closed bucket and the open one (per
   * coin a wallet counts once per bucket), `share` of all the card's coins' such buyers (0-1, 2 dp). A story the
   * series has not closed a bucket for yet is "new", with its post's time or its family's wake-up start.
   */
  cardAttention(card, nowS = this.#nowS()) {
    const S = this.stories.get(card?.key) ?? null, open = this.#openNow(nowS), nowK = Math.floor(nowS / BUCKET_S);
    const fresh = this.lastK >= nowK - 2; // the last close's per-coin counts are still the last bucket's
    let first = null, u = null, best = null, bestN = 0, total = 0;
    const each = (mint, symbol) => {
      const set = open?.coins.get(mint)?.b ?? null, o = set?.size ?? 0;
      if (o) { if (!first) first = set; else { if (!u) u = new Set(first); for (const w of set) u.add(w); } }
      const v = o + (fresh ? this.lastCoin.get(mint) ?? 0 : 0);
      total += v;
      if (v > bestN || (v > 0 && v === bestN && mint < best.mint)) { best = { mint, symbol: symbol ?? null }; bestN = v; }
    };
    for (const r of card?.coins ?? []) { each(r.mint, r.symbol); for (const cp of r.copies ?? []) each(cp.mint, r.symbol); }
    const att = S?.att && S.att.k >= nowK - 2 ? S.att : null;
    let start = S?.start ?? this.starts.get(card?.key) ?? null;
    if (!start) {
      if (card?.kind === "post" && fin(card.post?.at)) start = { startAt: card.post.at, source: "post" };
      else if (card?.kind === "family" && fin(card.family?.startedAt)) start = { startAt: card.family.startedAt, source: "wake" };
    }
    const phase = att?.phase ?? "new";
    return {
      phase,
      buyers5m: { now: u ? u.size : first ? first.size : 0, last: att?.last ?? 0 },
      multiple: att?.multiple ?? null,
      newWhy: phase !== "new" ? null : att?.newWhy ?? "history",
      startAt: start?.startAt ?? null, startSource: start?.source ?? null,
      minutes: fin(start?.startAt) ? Math.max(0, Math.floor((nowS - start.startAt) / 60)) : null,
      leader: best && total > 0 ? { mint: best.mint, symbol: best.symbol, share: r2(bestN / total) } : null,
    };
  }

  /**
   * GET /api/story-series/:key?since= (README §API): the story's stored buckets from `since` (unix s; default and
   * floor: 14 days back), oldest first, `{ t, buyers, siteBuyers, launchesFast, launches, buyUsd, partial }`, with its
   * start and normal: `{ key, asOf, bucketS, startAt, startSource, firstBuyersAt, baseline: { ratio, buckets, ready } |
   * null, buckets }` (`ready`: the history and bucket gates are met, so a multiple of normal means something). One
   * indexed read per key and `since` bucket, cached SERIES_TTL_MS (and dropped at every close). The cache key is the
   * asked bucket (or "all"), never the moving 14-day floor, so two asks seconds apart share one read; the read always
   * starts at the floor (a story not held in memory takes its normal from the same rows).
   */
  seriesOf(key, since = null) {
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000);
    const sinceB = fin(since) ? Math.floor(since / BUCKET_S) * BUCKET_S : null;
    const ck = `${key}|${sinceB ?? "all"}`, hit = this.series.get(ck);
    if (hit && nowMs - hit.at < SERIES_TTL_MS) return hit.body;
    const floor = nowS - KEEP_S, from = Math.max(floor, sinceB ?? floor);
    const db = this.model.db;
    let rs = [];
    try { rs = db.storyRows(key, floor, SERIES_ROWS + 16); } catch { rs = []; }
    const S = this.stories.get(key);
    let start = S?.start ?? this.starts.get(key);
    if (start === undefined) { try { start = db.storyStartGet(key); } catch { start = null; } }
    const base = S?.base ?? baselineOf(rs, nowS);
    const ready = historyReady({ base, firstBuyersAt: start?.firstBuyersAt, nowS });
    const body = {
      key, asOf: nowS, bucketS: BUCKET_S, startAt: start?.startAt ?? null, startSource: start?.source ?? null, firstBuyersAt: start?.firstBuyersAt ?? null,
      baseline: base && base.ratio != null ? { ratio: base.ratio, buckets: base.n, ready } : null,
      buckets: rs.filter((r) => r.t >= from).map((r) => ({ t: r.t, buyers: r.buyers, siteBuyers: r.siteBuyers, launchesFast: r.launchesFast, launches: r.launches, buyUsd: r.buyUsd, partial: !!(r.flags & PARTIAL) })),
    };
    this.series.delete(ck); this.series.set(ck, { at: nowMs, body });
    while (this.series.size > SERIES_MAX) this.series.delete(this.series.keys().next().value);
    return body;
  }
}
