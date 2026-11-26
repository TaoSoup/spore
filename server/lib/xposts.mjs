// The handle and text of X posts, for the linked posts (lib/narrative.mjs), from X's public embed API
// (https://publish.x.com/oembed: keyless and documented). One endpoint only, and only a post id's digits ever enter the
// URL. One fetcher for the whole server, in the manner of lib/gecko.mjs: ids wait in one line and go out one at a time,
// `gapMs` apart (XPOST_PER_MIN, no burst), at most XPOST_DAILY a UTC day (kv xpostCalls; every request sent counts,
// whatever the answer). An answer is stored in sqlite (`x_posts`) with a small in-memory copy in front, so a post is
// fetched once and then again only when its recheck is due. Nothing is retried here: a later ask queues the id again.
// A redirect is refused, the body is read with a byte cap (rpc.mjs readText), and what is kept of it is what
// narrative.mjs parseOembed lets through.
// When X pauses us (a 429) or the endpoint stops answering usefully (BREAK_AFTER failed answers in a row, the breaker),
// the line is emptied and nothing is queued until the pause ends: the people who asked are gone by then, and a later
// ask starts over. A 401 or 403 is X's answer about that one post (protected, withheld) and no sign of that.
//
// Link reading (for the post lines, lib/post-lines.mjs): a starting post often says little itself and links the post
// it is about ("Sending 10% https://t.co/…"). For such a post the last t.co link of its stored text is resolved by ONE
// request to https://t.co/<code> (the code is letters and digits only) with redirects not followed: only the status and
// the Location header are read, never a body. A Location that is an https x.com / twitter.com /status/<digits> link is
// the quoted post, and that post is then read through the same embed call as any other (only its digits enter the
// URL). Everything else is stored as a kind ("article", "website", "picture") with its host and is never fetched. A
// link request waits in the same line (behind the pages' own posts), `gapMs` apart, counts toward the same day's
// budget and stops at half of it; what it found is kept in sqlite (`post_links`). A link that could not be read is
// tried again after 10 min, 1 h and 6 h, then left. A failing t.co pauses the link reads only, never the post reads.
// Whatever a quoted post says is a stranger's text like any other: stored through the same flag, shown and sent as data.
import { performance } from "node:perf_hooks";
import { readText } from "./rpc.mjs";
import { abortableSleep } from "./tx-events.mjs";
import { parseOembed, parsePost, postTime, postUrl } from "./narrative.mjs";

export const XPOST_URL = "https://publish.x.com/oembed";
export const XPOST_TIMEOUT_MS = 8_000, XPOST_MAX_BYTES = 64 * 1024;
/** Ids in line at most; requests that are `low` stop at half of it, as they stop at half the day's budget. */
export const MAX_WAITING = 40;
/** An id whose fetch failed without an answer worth storing (5xx, timeout, network, redirect, oversize, bad JSON) is not queued again for this long. */
export const RETRY_MS = 600_000;
/** A 429 without a usable Retry-After, or the breaker, pauses every fetch this long, doubling each time up to the max; a post or a 404 resets the doubling. */
export const XPOST_PAUSE_MS = 60_000, XPOST_PAUSE_MAX_MS = 900_000;
/**
 * This many failed answers in a row trip the breaker: a 429, a 5xx or other unexpected status, no answer (network,
 * timeout, redirect), one too large, one that is not JSON, and a 200 that is not the post. A post or a 404 ends the
 * run; a 401/403 neither counts nor ends it.
 */
export const BREAK_AFTER = 5;
/** state() says "wait" for an id in flight or this near the head of the line (about 40 s at the default pace). */
export const WAIT_AHEAD = 10;
/** Records kept in memory in front of sqlite. */
export const XPOST_LRU = 5_000;
/** `asked_at` is rewritten at most this often per row (s); rows not asked for XPOST_KEEP_S go, and the least recently asked past XPOST_MAX_ROWS; checked every XPOST_PRUNE_MS. */
export const XPOST_TOUCH_S = 3_600, XPOST_KEEP_S = 30 * 86_400, XPOST_MAX_ROWS = 50_000, XPOST_PRUNE_MS = 3_600_000;
/** A peek's asked-for time is not written at once (a write per post, in a request or the attention close, held the loop
 * 35 ms after a restart, Nov 23 2026): it waits in memory and goes every XPOST_FLUSH_MS, at most XPOST_FLUSH_MAX rows in
 * one transaction (the rest at the next flush; the prune writes one batch and waits for its next hour while more wait; stop() writes them all). */
export const XPOST_FLUSH_MS = 10_000, XPOST_FLUSH_MAX = 100;
/** When a stored answer is asked for again (s after its fetch): a 404; a 401/403 or an answer that did not parse; a post younger than RECHECK_YOUNG_S; an older post. */
export const RECHECK_GONE_S = 7 * 86_400, RECHECK_DENIED_S = 6 * 3_600, RECHECK_NEW_S = 3 * 86_400, RECHECK_OLD_S = 14 * 86_400, RECHECK_YOUNG_S = 30 * 86_400;
const DAY_MS = 86_400_000;
/** The budget is saved this often (calls), when the day becomes spent, and at stop(). */
const SAVE_EVERY = 10;
/** Ids kept in the retry list at most (the oldest goes first). */
export const FAILED_MAX = 2_000;
const ID_RE = /^[1-9]\d{0,18}$/;
const isId = (id) => typeof id === "string" && ID_RE.test(id);

// ---------------------------------------------------------------- link reading (pure)
/** The one host a link request goes to, and what a code may be made of. */
export const TCO_URL = "https://t.co/";
// A code directly followed by the cut mark is not taken: our own text cap (narrative.mjs parseOembed, TEXT_MAX code
// points and "…") can end a stored text inside its last link, and half a code is somebody else's link. X's own
// shortening writes the mark before a link ("text… https://t.co/x"), so a whole link never has one behind it.
const TCO_RE = /https:\/\/t\.co\/([A-Za-z0-9]{1,40})(?![A-Za-z0-9…])/g;
const PIC_RE = /(?<![\p{L}\p{N}.])pic\.(?:twitter|x)\.com\/[A-Za-z0-9]/u;
/** What a link can lead to. "post": another post on X (the only kind that is read); the others are never fetched. */
export const LINK_KINDS = Object.freeze(["post", "article", "website", "picture"]);
/** A link that could not be read is tried again this long after its 1st, 2nd and 3rd failed read (s); after the 4th it is left. */
export const LINK_RETRY_S = Object.freeze([600, 3_600, 21_600]);
/** This many link reads in a row without a redirect pause the link reads (only them), doubling like the posts' pause. */
export const LINK_BREAK_AFTER = 5;
/** Link rows kept in memory in front of sqlite. */
export const LINK_LRU = 5_000;
const X_HOSTS = new Set(["x.com", "twitter.com"].flatMap((h) => [h, `www.${h}`, `mobile.${h}`, `m.${h}`]));

/**
 * The code of the last whole t.co link in a post's text ("https://t.co/Ab12" gives "Ab12"), or null. Letters and digits
 * only. A link the text cap cut ("https://t.co/Ab…") has no code: only a link the post really carries is ever read.
 */
export function linkCodeOf(text) {
  if (typeof text !== "string") return null;
  let code = null;
  for (const m of text.matchAll(TCO_RE)) code = m[1];
  return code;
}
/** Whether a post's text shows attached media ("pic.twitter.com/…" is what the embed writes for a picture or a video). */
export const hasPicture = (text) => typeof text === "string" && PIC_RE.test(text);

/**
 * What a redirect's Location leads to, read from the URL alone (nothing is fetched): `{ kind: "post", id }` for an
 * https x.com / twitter.com link to a post (`<handle>/status/<digits>`, `i/status/<digits>`, `i/web/status/<digits>`)
 * that is not `ownId` itself and not one of its pictures; `{ kind: "picture", host }` for a post's photo or video or the
 * post's own link; `{ kind: "article", host }` for an article on X; `{ kind: "website", host }` for any other http(s)
 * address (an http link to a post included: only https is accepted as a post); null for anything that is no absolute
 * http(s) URL. `host` is the address's host name, lower case, at most 80 characters: a label, never a place we go.
 */
export function classifyTarget(location, ownId = null) {
  if (typeof location !== "string" || !location || location.length > 2048) return null;
  let u;
  try { u = new URL(location); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  host = host.slice(0, 80);
  if (!host) return null;
  if (/^pic\.(?:twitter|x)\.com$/.test(host)) return { kind: "picture", host };
  if (X_HOSTS.has(host) && !u.username && !u.password && !u.port) {
    const seg = u.pathname.split("/").filter(Boolean);
    const post = u.protocol === "https:" ? parsePost(u.href) : null;
    if (post) {
      const i = seg.indexOf(post.id);
      const media = i >= 0 && (seg[i + 1] === "photo" || seg[i + 1] === "video");
      return media || post.id === ownId ? { kind: "picture", host } : { kind: "post", id: post.id };
    }
    if (seg.length >= 3 && seg[seg.length - 2] === "article" && /^\d{1,20}$/.test(seg[seg.length - 1])) return { kind: "article", host };
  }
  return { kind: "website", host };
}

export class XPosts {
  /**
   * `perMin`: requests a minute (XPOST_PER_MIN); `daily`: requests a UTC day (0 = no cap); `db`: where the answers
   * (x_posts) and the day's count (kv xpostCalls) are kept, null = memory only; `flag(text)`: true for a text that
   * must not be shown (asked once, when a post is stored). `fetch`, `now` (ms), `sleep(ms, signal)` and `timeoutMs` are
   * injectable for tests.
   */
  constructor({ perMin = 20, daily = 3000, db = null, fetch = globalThis.fetch, now = Date.now, sleep = abortableSleep, log = console, timeoutMs = XPOST_TIMEOUT_MS, flag = () => false } = {}) {
    this.perMin = perMin; this.daily = daily; this.db = db; this.fetch = fetch; this.now = now; this.sleep = sleep; this.log = log; this.timeoutMs = timeoutMs; this.flag = flag;
    this.gapMs = Math.ceil(60_000 / perMin);
    // `queue`: the ids in line, in arrival order; `inFlight`: the one being fetched; `lastAt`: when the last request went out.
    this.queue = []; this.inFlight = null; this.running = false; this.lastAt = -Infinity; this.pausedUntil = 0; this.backoffMs = 0;
    this.lru = new Map();    // id → record, least recently used first
    this.failed = new Map(); // id → when its fetch last failed without a storable answer (ms)
    // The breaker: `bad` failed answers in a row, and what each "none" row written for one of them (a 200 that was not
    // the post) replaced (null = nothing), oldest first.
    this.bad = 0; this.badRows = [];
    let saved = null;
    try { saved = db?.kvGet("xpostCalls", null) ?? null; } catch { /* a fresh count */ }
    const day = this.#day();
    this.budget = saved && saved.day === day && Number.isFinite(saved.used) ? { day, used: saved.used } : { day, used: 0 };
    this.spentLogged = null;
    this.touches = new Map(); this.flushTimer = null; // post id → asked-for time not yet written (flushTouches)
    this.ac = new AbortController(); this.started = false; this.stopped = false; this.idleWaiters = [];
    this.stats = { calls: 0, ok: 0, notFound: 0, denied: 0, unparsed: 0, rateLimited: 0, errors: 0, timeouts: 0, tooLarge: 0, badJson: 0, flagged: 0, tripped: 0, pruned: 0, touched: 0, touchErrors: 0, pruneDeferred: 0, lastFlushMs: null, maxFlushMs: 0, lastError: null, lastMs: null };
    // Link reading: `linkQueue` the starting posts whose link waits to be resolved (behind `queue`), `linkInFlight` the
    // one being resolved, `links` post id → its link row (least recently used first), and the link reads' own pause.
    this.linkQueue = []; this.linkInFlight = null; this.links = new Map(); this.linkPausedUntil = 0; this.linkBackoffMs = 0; this.linkBad = 0;
    this.linkStats = { calls: 0, posts: 0, articles: 0, websites: 0, pictures: 0, unread: 0, rateLimited: 0, tripped: 0, lastError: null };
  }
  #day() { return Math.floor(this.now() / DAY_MS); }
  #nowS() { return Math.floor(this.now() / 1000); }
  #rollDay() { const day = this.#day(); if (day !== this.budget.day) this.budget = { day, used: 0 }; }
  #save() { try { this.db?.kvSet("xpostCalls", this.budget); } catch { /* kept in memory */ } }
  #paused() { return this.pausedUntil > this.now(); }
  /** The day's requests are used up (logged once a day). */
  spent() {
    this.#rollDay();
    const s = this.daily > 0 && this.budget.used >= this.daily;
    if (s && this.spentLogged !== this.budget.day) {
      this.spentLogged = this.budget.day; this.#save();
      this.log.info?.(`posts: the day's ${this.daily} post-text requests are spent; linked posts show what is stored until tomorrow (UTC)`);
    }
    return s;
  }
  snapshot() {
    this.#rollDay();
    let cached = this.lru.size;
    try { cached = this.db?.xpostCount() ?? cached; } catch { /* the in-memory count */ }
    return { callsToday: this.budget.used, daily: this.daily, perMin: this.perMin, waiting: this.queue.length, touchesWaiting: this.touches.size, pausedMs: Math.max(0, this.pausedUntil - this.now()), cached, ...this.stats, links: { waiting: this.linkQueue.length, pausedMs: Math.max(0, this.linkPausedUntil - this.now()), ...this.linkStats } };
  }
  /** Starts the hourly prune (the fetches need no start: a want() runs them). */
  start() {
    if (this.started || this.stopped) return this;
    this.started = true;
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), XPOST_PRUNE_MS); this.pruneTimer.unref?.();
    this.flushTimer = setInterval(() => this.flushTouches(XPOST_FLUSH_MAX), XPOST_FLUSH_MS); this.flushTimer.unref?.();
    return this;
  }
  /** Saves the day's count and ends every wait; no request goes out after this. */
  stop() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.pruneTimer); clearInterval(this.flushTimer); this.flushTouches(Infinity); this.queue.length = 0; this.linkQueue.length = 0;
    this.#save(); this.ac.abort(new Error("stopping")); this.#wake();
  }
  /**
   * Writes up to `max` waiting asked-for times (oldest first) in one transaction; returns how many it handled (a row gone
   * or already newer counts as handled; stats.touched counts the rows that moved). A failed write keeps them for the next
   * flush. The write's time is kept (lastFlushMs, maxFlushMs: it runs on a timer, outside the sliced jobs' gauge).
   */
  flushTouches(max = XPOST_FLUSH_MAX) {
    if (!this.touches.size || !this.db) return 0;
    const rows = [];
    for (const e of this.touches) { if (rows.length >= max) break; rows.push(e); }
    const t0 = performance.now();
    let moved = 0;
    try { moved = this.db.xpostTouchMany(rows); } catch (e) { this.stats.touchErrors++; return 0; }
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    this.stats.lastFlushMs = ms; if (ms > this.stats.maxFlushMs) this.stats.maxFlushMs = ms;
    for (const [id, at] of rows) if (this.touches.get(id) === at) this.touches.delete(id);
    this.stats.touched += moved;
    return rows.length;
  }
  #wake() { if (!this.running && !this.queue.length && !this.linkQueue.length) for (const r of this.idleWaiters.splice(0)) r(); }
  /** Resolves when no fetch runs and none waits (tests). */
  idle() { return !this.running && !this.queue.length && !this.linkQueue.length ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r)); }
  /** Drops rows not asked for XPOST_KEEP_S, then the least recently asked past XPOST_MAX_ROWS; returns how many went. */
  prune() {
    let n = 0;
    // the asked-for times first (the prune goes by them), one capped batch; while more wait (a backlog after a restart,
    // or a failed write) the prune waits for its next hour rather than delete a row that was just asked for
    this.flushTouches();
    if (this.touches.size && !this.stopped) { this.stats.pruneDeferred++; return 0; }
    try {
      n = this.db?.xpostPrune(this.#nowS() - XPOST_KEEP_S, XPOST_MAX_ROWS) ?? 0;
      // a link row goes with its starting post
      if (n) { this.stats.pruned += n; this.lru.clear(); this.links.clear(); this.db?.linkPrune?.(); }
    } catch (e) { this.log.warn?.(`posts: prune failed: ${String(e?.message ?? e).slice(0, 160)}`); }
    for (const [id, at] of this.failed) if (this.now() - at >= RETRY_MS) this.failed.delete(id);
    return n;
  }

  // ---------------------------------------------------------------- the store
  #remember(r) {
    this.lru.delete(r.id); this.lru.set(r.id, r);
    while (this.lru.size > XPOST_LRU) this.lru.delete(this.lru.keys().next().value);
  }
  /** The record of `id` from memory, else sqlite; null when nothing is stored. */
  #rec(id) {
    let r = this.lru.get(id);
    if (r) { this.lru.delete(id); this.lru.set(id, r); return r; }
    try { r = this.db?.xpostGet(id) ?? null; } catch { r = null; }
    if (!r) return null;
    r = { id, state: r.state === "ok" ? "ok" : "none", handle: r.handle ?? null, text: r.flagged ? "" : r.text ?? null, flagged: !!r.flagged, fetchedAt: r.fetchedAt, askedAt: r.askedAt, recheckAt: r.recheckAt };
    this.#remember(r);
    return r;
  }
  #put(r) {
    this.#remember(r);
    try { this.db?.xpostSet(r); } catch (e) { this.log.warn?.(`posts: ${r.id} not stored: ${String(e?.message ?? e).slice(0, 160)}`); }
  }
  #drop(id) {
    this.lru.delete(id);
    try { this.db?.xpostDel(id); } catch { /* gone from memory; the row is rechecked when due */ }
  }
  /** Writes the answer for `id` and returns the record it replaced (or null). It was asked for just now. */
  #store(id, state, recheckS, { handle = null, text = null, flagged = false } = {}) {
    const prev = this.#rec(id), nowS = this.#nowS();
    this.failed.delete(id);
    this.#put({ id, state, handle, text, flagged, fetchedAt: nowS, askedAt: nowS, recheckAt: nowS + recheckS });
    return prev;
  }
  /**
   * The stored record of post `id`, `{ id, state: "ok" | "none", handle, text, flagged, fetchedAt, askedAt, recheckAt }`
   * (unix s; `text` "" for a flagged post), or null. A record due a recheck is still given. Reading it marks the row
   * as asked for (what the prune goes by), at most once per XPOST_TOUCH_S, written by the next flushTouches.
   */
  peek(id) {
    if (!isId(id)) return null;
    const r = this.#rec(id);
    if (!r) return null;
    const nowS = this.#nowS();
    if (nowS - r.askedAt >= XPOST_TOUCH_S) { r.askedAt = nowS; if (this.db) this.touches.set(id, nowS); }
    return r;
  }
  /** "ok" | "none" from the record; else "wait" while the fetch is in flight or near the head of the line; else "idle" (not being fetched now). */
  state(id) {
    if (!isId(id)) return "idle";
    const r = this.#rec(id);
    if (r) return r.state;
    if (this.inFlight === id) return "wait";
    const i = this.queue.indexOf(id);
    return i >= 0 && i < WAIT_AHEAD && !this.#paused() ? "wait" : "idle";
  }

  // ---------------------------------------------------------------- the line
  /**
   * Whether a fetch of `id` would be queued now: "ok", or why not. "cached": stored and not due a recheck; "queued":
   * already in line or in flight; "busy": the line is full or a pause is on; "budget": the day's requests are spent;
   * "retry": its last fetch failed less than RETRY_MS ago; "stopped": stopping, or no post id. A `low` request (and
   * every recheck of a stored record) is also refused from half the line ("busy") and half the day ("budget") on, so
   * the posts a family shows first keep the other half.
   */
  canQueue(id, { low = false } = {}) {
    if (this.stopped || !isId(id)) return "stopped";
    const r = this.#rec(id);
    if (r && r.recheckAt > this.#nowS()) return "cached";
    if (this.inFlight === id || this.queue.includes(id)) return "queued";
    if (this.queue.length >= MAX_WAITING || this.#paused()) return "busy";
    if (this.spent()) return "budget";
    const failedAt = this.failed.get(id);
    if (failedAt !== undefined && this.now() - failedAt < RETRY_MS) return "retry";
    if (low || r) {
      if (this.queue.length >= MAX_WAITING / 2) return "busy";
      if (this.daily > 0 && this.budget.used >= this.daily / 2) return "budget";
    }
    return "ok";
  }
  /** canQueue, and on "ok" the id joins the line. */
  want(id, { low = false } = {}) {
    const r = this.canQueue(id, { low });
    if (r === "ok") { this.queue.push(id); this.#pump(); }
    return r;
  }
  async #pump() {
    if (this.running) return;
    this.running = true;
    try {
      // One line, one request at a time, `gapMs` apart: the posts first, a link only when no post waits.
      while ((this.queue.length || this.linkQueue.length) && !this.stopped) {
        if (this.spent()) { this.queue.length = 0; this.linkQueue.length = 0; break; }
        if (!this.queue.length && this.linkPausedUntil > this.now()) { this.linkQueue.length = 0; break; }
        const at = Math.max(this.lastAt + this.gapMs, this.pausedUntil);
        if (at > this.now()) { await this.sleep(at - this.now(), this.ac.signal); continue; }
        if (this.queue.length) {
          const id = this.queue.shift();
          this.inFlight = id; this.lastAt = this.now();
          try { await this.#fetchOne(id); }
          catch (e) { this.log.warn?.(`posts: ${id}: ${String(e?.message ?? e).slice(0, 160)}`); }
          finally { this.inFlight = null; }
        } else {
          const id = this.linkQueue.shift();
          this.linkInFlight = id; this.lastAt = this.now();
          try { await this.#fetchLink(id); }
          catch (e) { this.log.warn?.(`posts: link of ${id}: ${String(e?.code ?? e?.name ?? "error").slice(0, 40)}`); }
          finally { this.linkInFlight = null; }
        }
      }
    } finally { this.running = false; this.#wake(); }
  }
  /** Every fetch waits `wait` ms, or the next step of the doubling pause; the line is emptied. */
  #pause(wait = null) {
    if (wait == null) { this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, XPOST_PAUSE_MAX_MS) : XPOST_PAUSE_MS; wait = this.backoffMs; }
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.queue.length = 0; this.linkQueue.length = 0;
    return wait;
  }
  /** A parsed post or a 404: the endpoint is answering, the run of failed answers is over. */
  #good() { this.bad = 0; this.badRows = []; this.backoffMs = 0; }
  /** `id` is not queued again for RETRY_MS. */
  #fail(id) {
    this.failed.delete(id); this.failed.set(id, this.now());
    while (this.failed.size > FAILED_MAX) this.failed.delete(this.failed.keys().next().value);
  }
  /**
   * An answer that suggests the endpoint itself is failing. The BREAK_AFTER-th in a row trips the breaker: the "none"
   * rows written in the run are taken back, newest first, so an id answered twice ends as it was before the run (what
   * a row replaced is put back; a failing endpoint leaves nothing stored), their ids wait RECHECK_DENIED_S (so the same few cannot trip it again and again), and the fetches
   * pause (`paused`: this answer, a 429, set its own pause already). The run then starts again from zero, so after the
   * pause it takes BREAK_AFTER more to pause again; the pause keeps doubling until #good.
   */
  #badAnswer(paused = false) {
    if (++this.bad < BREAK_AFTER) return;
    for (const { id, prev } of this.badRows.reverse()) { if (prev) this.#put(prev); else this.#drop(id); this.#fail(id); this.failed.set(id, this.now() + RECHECK_DENIED_S * 1000 - RETRY_MS); }
    const n = this.bad;
    this.bad = 0; this.badRows = [];
    this.stats.tripped++;
    const wait = paused ? this.pausedUntil - this.now() : this.#pause();
    this.log.warn?.(`posts: ${n} answers in a row failed (${this.stats.lastError ?? "?"}); no post text is fetched for ${Math.round(wait / 1000)} s`);
  }
  #transient(id, stat, message) {
    this.stats[stat]++; this.stats.lastError = message;
    this.#fail(id);
    this.#badAnswer();
  }

  async #fetchOne(id) {
    this.#rollDay();
    this.budget.used++; this.stats.calls++;
    if (this.budget.used % SAVE_EVERY === 0) this.#save();
    const url = `${XPOST_URL}?url=${encodeURIComponent(postUrl(id))}&omit_script=1&dnt=1`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const t0 = this.now();
    let res, text = null;
    try {
      res = await this.fetch(url, { headers: { accept: "application/json", "user-agent": "spore-posts/1" }, redirect: "error", signal: AbortSignal.any([timeout, this.ac.signal]) });
      if (res.status === 200) text = await readText(res, XPOST_MAX_BYTES);
      else res.body?.cancel?.().catch(() => {});
    } catch (e) {
      this.stats.lastMs = this.now() - t0;
      if (this.stopped) return;
      if (e?.tooLarge) return this.#transient(id, "tooLarge", `answer over ${XPOST_MAX_BYTES} bytes`);
      if (timeout.aborted) return this.#transient(id, "timeouts", `no answer within ${this.timeoutMs} ms`);
      return this.#transient(id, "errors", `unreachable: ${String(e?.message ?? e).slice(0, 160)}`);
    } finally { this.spent(); }
    this.stats.lastMs = this.now() - t0;
    if (this.stopped) return;
    const { status } = res;
    if (status === 404) { this.stats.notFound++; this.#store(id, "none", RECHECK_GONE_S); return this.#good(); }
    if (status === 429) {
      this.stats.rateLimited++;
      const ra = Number(res.headers?.get?.("retry-after"));
      const wait = this.#pause(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, XPOST_PAUSE_MAX_MS) : null);
      this.stats.lastError = `429: every request waits ${Math.round(wait / 1000)} s`;
      return this.#badAnswer(true);
    }
    let post = null;
    if (status === 200) {
      let body;
      try { body = JSON.parse(text); } catch { return this.#transient(id, "badJson", "not JSON"); }
      post = parseOembed(body, id);
    } else if (status === 401 || status === 403) {
      // X refuses this one post (protected, withheld): nothing to show, asked again sooner than a 404. It says nothing
      // about the endpoint, so the breaker's run is left as it is and the row stays whatever comes next.
      this.stats.denied++; this.stats.lastError = `HTTP ${status}`;
      this.#store(id, "none", RECHECK_DENIED_S);
      return;
    } else return this.#transient(id, "errors", `HTTP ${status}`);
    if (!post) {
      // A 200 that is not this post: stored like a refusal, and taken back if the breaker trips in this run.
      this.stats.unparsed++; this.stats.lastError = "an answer that is not the post";
      this.badRows.push({ id, prev: this.#store(id, "none", RECHECK_DENIED_S) });
      return this.#badAnswer();
    }
    let flagged = false;
    try { flagged = !!this.flag(post.text); } catch { flagged = true; }
    if (flagged) this.stats.flagged++;
    const at = postTime(id, this.now());
    this.#store(id, "ok", at != null && this.#nowS() - at < RECHECK_YOUNG_S ? RECHECK_NEW_S : RECHECK_OLD_S, { handle: post.handle, text: flagged ? "" : post.text, flagged });
    this.stats.ok++;
    this.#good();
  }

  // ---------------------------------------------------------------- link reading
  /** The link row of starting post `id` from memory, else sqlite: `{ postId, kind, toId, host, tries, nextTryAt, at }`, or null when its link was never read. */
  #linkRec(id) {
    let r = this.links.get(id);
    if (r !== undefined) { this.links.delete(id); this.links.set(id, r); return r; }
    try { r = this.db?.linkGet?.(id) ?? null; } catch { r = null; }
    if (r && r.kind != null && (!LINK_KINDS.includes(r.kind) || (r.kind === "post" && !isId(r.toId)))) r = null; // a row this build cannot read: as never read
    this.#linkRemember(id, r);
    return r;
  }
  #linkRemember(id, r) {
    this.links.delete(id); this.links.set(id, r);
    while (this.links.size > LINK_LRU) this.links.delete(this.links.keys().next().value);
  }
  #linkPut(row) {
    this.#linkRemember(row.postId, row);
    try { this.db?.linkSet?.(row); } catch (e) { this.log.warn?.(`posts: link of ${row.postId} not stored (${e?.code ?? "error"})`); }
  }
  /**
   * What the stored text of post `id` links, from what is stored (never a request): `{ state, kind, toId, host }`.
   * state "none": no stored post, or its text has no link; "ok" with `kind` "post" (`toId`: the quoted post),
   * "article", "website" or "picture" (`host`: where it points; a text with attached media and no link is a "picture"
   * without any request); "wait": it has a t.co link that was never read; "unread": the link could not be read (it is
   * tried again after 10 min, 1 h and 6 h, then left; `retry`: another try is still scheduled).
   */
  linkOf(id) {
    const none = { state: "none", kind: null, toId: null, host: null };
    if (!isId(id)) return none;
    const rec = this.#rec(id);
    if (!rec || rec.state !== "ok") return none;
    if (!linkCodeOf(rec.text)) return hasPicture(rec.text) ? { state: "ok", kind: "picture", toId: null, host: null } : none;
    const l = this.#linkRec(id);
    if (!l) return { ...none, state: "wait" };
    if (l.kind) return { state: "ok", kind: l.kind, toId: l.toId ?? null, host: l.host ?? null };
    return { ...none, state: "unread", retry: l.nextTryAt > 0 };
  }
  /**
   * Whether a read of post `id`'s link would be queued now: "ok", or why not. "nolink": no stored post or no t.co link
   * in its text; "cached": read already, or given up; "queued"; "retry": its last read failed and its next try is not
   * due; "busy": the link line is full or a pause is on; "budget": half the day's requests are used (link reads never
   * take the other half: it is the posts'); "stopped".
   */
  canQueueLink(id) {
    if (this.stopped || !isId(id)) return "stopped";
    const rec = this.#rec(id);
    if (!rec || rec.state !== "ok" || !linkCodeOf(rec.text)) return "nolink";
    const l = this.#linkRec(id);
    if (l && (l.kind || !l.nextTryAt)) return "cached";
    if (this.linkInFlight === id || this.linkQueue.includes(id)) return "queued";
    if (l && l.nextTryAt > this.#nowS()) return "retry";
    if (this.linkQueue.length >= MAX_WAITING / 2 || this.#paused() || this.linkPausedUntil > this.now()) return "busy";
    if (this.spent() || (this.daily > 0 && this.budget.used >= this.daily / 2)) return "budget";
    return "ok";
  }
  /** canQueueLink, and on "ok" the post's link joins the line (behind the posts). */
  wantLink(id) {
    const r = this.canQueueLink(id);
    if (r === "ok") { this.linkQueue.push(id); this.#pump(); }
    return r;
  }
  /** The link reads (only they) wait `wait` ms, or the next step of their own doubling pause; their line is emptied. */
  #linkPause(wait = null) {
    if (wait == null) { this.linkBackoffMs = this.linkBackoffMs ? Math.min(this.linkBackoffMs * 2, XPOST_PAUSE_MAX_MS) : XPOST_PAUSE_MS; wait = this.linkBackoffMs; }
    this.linkPausedUntil = Math.max(this.linkPausedUntil, this.now() + wait);
    this.linkQueue.length = 0;
    return wait;
  }
  /** A link read that gave no usable redirect: the try is counted and the next one scheduled (LINK_RETRY_S), then none. */
  #linkFailed(id, why) {
    const prev = this.#linkRec(id), tries = (prev?.tries ?? 0) + 1, nowS = this.#nowS(), wait = LINK_RETRY_S[tries - 1];
    this.#linkPut({ postId: id, kind: null, toId: null, host: null, tries, nextTryAt: wait ? nowS + wait : 0, at: nowS });
    this.linkStats.unread++; this.linkStats.lastError = why;
    if (++this.linkBad >= LINK_BREAK_AFTER) {
      const n = this.linkBad, ms = this.#linkPause();
      this.linkBad = 0; this.linkStats.tripped++;
      this.log.warn?.(`posts: ${n} link reads in a row failed (${why}); no link is read for ${Math.round(ms / 1000)} s (post texts go on)`);
    }
  }
  /**
   * One request to https://t.co/<code> for the last link of post `id`'s stored text, redirects not followed: the status
   * and the Location header are all that is read (the body is let go unread). What the Location leads to is stored
   * (classifyTarget); a quoted post is then asked for through the embed line like any post. Counts toward the day.
   */
  async #fetchLink(id) {
    const rec = this.#rec(id), code = rec?.state === "ok" ? linkCodeOf(rec.text) : null;
    if (!code) return;
    this.#rollDay();
    this.budget.used++; this.stats.calls++; this.linkStats.calls++;
    if (this.budget.used % SAVE_EVERY === 0) this.#save();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res;
    try {
      res = await this.fetch(`${TCO_URL}${code}`, { headers: { "user-agent": "spore-posts/1" }, redirect: "manual", signal: AbortSignal.any([timeout, this.ac.signal]) });
      res.body?.cancel?.().catch(() => {});
    } catch {
      if (this.stopped) return;
      return this.#linkFailed(id, timeout.aborted ? "timeout" : "unreachable");
    } finally { this.spent(); }
    if (this.stopped) return;
    const status = Number(res?.status);
    if (status === 429) {
      // t.co asks us to slow down: the link reads wait (not a try of this link; it is asked again after the pause)
      this.linkStats.rateLimited++;
      const ra = Number(res.headers?.get?.("retry-after"));
      const ms = this.#linkPause(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, XPOST_PAUSE_MAX_MS) : null);
      this.linkStats.lastError = `429: link reads wait ${Math.round(ms / 1000)} s`;
      return;
    }
    let loc = null;
    try { loc = status >= 300 && status < 400 ? res.headers?.get?.("location") ?? null : null; } catch { loc = null; }
    const to = loc ? classifyTarget(loc, id) : null;
    if (!to) return this.#linkFailed(id, `HTTP ${Number.isInteger(status) ? status : "?"} without a usable redirect`);
    this.linkBad = 0; this.linkBackoffMs = 0;
    const prev = this.#linkRec(id);
    this.#linkPut({ postId: id, kind: to.kind, toId: to.kind === "post" ? to.id : null, host: to.kind === "post" ? null : to.host, tries: (prev?.tries ?? 0) + 1, nextTryAt: 0, at: this.#nowS() });
    this.linkStats[to.kind === "post" ? "posts" : to.kind === "article" ? "articles" : to.kind === "picture" ? "pictures" : "websites"]++;
    if (to.kind === "post") this.want(to.id, { low: true }); // the quoted post's text; nothing is sent when it is stored already
  }
  /**
   * The post that starting post `id` quotes, for the post lines: `{ state, kind, host, quoted, chain }`.
   * - state "none": the post has no link. "ok": the link was read; `kind` says what it leads to ("post", "article",
   *   "website", "picture"), and for a post that can be shown `quoted` is `{ id, handle, text, at }` (`at` from its id).
   * - "wait": the link, or the quoted post's text, is still to be read. "unread": it could not be read (for now);
   *   `retry` then says whether another try is scheduled (a link with tries left, a quoted post whose fetch failed
   *   a moment ago), so a caller may wait for it. A quoted post that is gone, withheld or flagged has none.
   * - `chain`: the post the quoted post itself quotes, `{ id, handle, text, at }`, ONLY when both its link row and its
   *   text are stored already (the quoted post is a starting post we hold too); nothing is ever fetched for it.
   * With `queue` (the default) a link not read yet, one whose retry is due, and a quoted post without stored text are
   * asked for (low priority, the shared line and day); without it nothing is queued. A flagged text is never given.
   */
  quoteOf(id, { queue = true } = {}) {
    const out = { state: "none", kind: null, host: null, quoted: null, chain: null, retry: false };
    if (!isId(id)) return out;
    const l = this.linkOf(id);
    out.state = l.state; out.kind = l.kind; out.host = l.host; out.retry = l.state === "unread" && l.retry === true;
    if (l.state === "wait" || l.state === "unread") { if (queue) this.wantLink(id); return out; }
    if (l.kind !== "post" || !isId(l.toId)) return out;
    const shown = (pid) => { const r = this.peek(pid); return r && r.state === "ok" && !r.flagged && r.handle && typeof r.text === "string" ? { id: pid, handle: r.handle, text: r.text, at: postTime(pid, this.now()) } : null; };
    if (!this.peek(l.toId)) {
      const w = queue ? this.want(l.toId, { low: true }) : this.canQueue(l.toId, { low: true });
      out.state = w === "retry" || w === "stopped" ? "unread" : "wait"; out.retry = w === "retry";
      return out;
    }
    if (queue) this.want(l.toId, { low: true }); // a recheck that is due
    out.quoted = shown(l.toId);
    if (!out.quoted) { out.state = "unread"; return out; }
    const l2 = this.#linkRec(l.toId);
    if (l2?.kind === "post" && isId(l2.toId) && l2.toId !== id && l2.toId !== l.toId) out.chain = shown(l2.toId);
    return out;
  }
}
