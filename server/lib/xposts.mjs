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
import { readText } from "./rpc.mjs";
import { abortableSleep } from "./tx-events.mjs";
import { parseOembed, postTime, postUrl } from "./narrative.mjs";

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
/** When a stored answer is asked for again (s after its fetch): a 404; a 401/403 or an answer that did not parse; a post younger than RECHECK_YOUNG_S; an older post. */
export const RECHECK_GONE_S = 7 * 86_400, RECHECK_DENIED_S = 6 * 3_600, RECHECK_NEW_S = 3 * 86_400, RECHECK_OLD_S = 14 * 86_400, RECHECK_YOUNG_S = 30 * 86_400;
const DAY_MS = 86_400_000;
/** The budget is saved this often (calls), when the day becomes spent, and at stop(). */
const SAVE_EVERY = 10;
/** Ids kept in the retry list at most (the oldest goes first). */
export const FAILED_MAX = 2_000;
const ID_RE = /^[1-9]\d{0,18}$/;
const isId = (id) => typeof id === "string" && ID_RE.test(id);

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
    this.ac = new AbortController(); this.started = false; this.stopped = false; this.idleWaiters = [];
    this.stats = { calls: 0, ok: 0, notFound: 0, denied: 0, unparsed: 0, rateLimited: 0, errors: 0, timeouts: 0, tooLarge: 0, badJson: 0, flagged: 0, tripped: 0, pruned: 0, lastError: null, lastMs: null };
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
    return { callsToday: this.budget.used, daily: this.daily, perMin: this.perMin, waiting: this.queue.length, pausedMs: Math.max(0, this.pausedUntil - this.now()), cached, ...this.stats };
  }
  /** Starts the hourly prune (the fetches need no start: a want() runs them). */
  start() {
    if (this.started || this.stopped) return this;
    this.started = true;
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), XPOST_PRUNE_MS); this.pruneTimer.unref?.();
    return this;
  }
  /** Saves the day's count and ends every wait; no request goes out after this. */
  stop() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.pruneTimer); this.queue.length = 0;
    this.#save(); this.ac.abort(new Error("stopping")); this.#wake();
  }
  #wake() { if (!this.running && !this.queue.length) for (const r of this.idleWaiters.splice(0)) r(); }
  /** Resolves when no fetch runs and none waits (tests). */
  idle() { return !this.running && !this.queue.length ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r)); }
  /** Drops rows not asked for XPOST_KEEP_S, then the least recently asked past XPOST_MAX_ROWS; returns how many went. */
  prune() {
    let n = 0;
    try {
      n = this.db?.xpostPrune(this.#nowS() - XPOST_KEEP_S, XPOST_MAX_ROWS) ?? 0;
      if (n) { this.stats.pruned += n; this.lru.clear(); }
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
   * as asked for (what the prune goes by), written at most once per XPOST_TOUCH_S.
   */
  peek(id) {
    if (!isId(id)) return null;
    const r = this.#rec(id);
    if (!r) return null;
    const nowS = this.#nowS();
    if (nowS - r.askedAt >= XPOST_TOUCH_S) { r.askedAt = nowS; try { this.db?.xpostTouch(id, nowS); } catch { /* the next read writes it */ } }
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
      while (this.queue.length && !this.stopped) {
        if (this.spent()) { this.queue.length = 0; break; }
        const at = Math.max(this.lastAt + this.gapMs, this.pausedUntil);
        if (at > this.now()) { await this.sleep(at - this.now(), this.ac.signal); continue; }
        const id = this.queue.shift();
        this.inFlight = id; this.lastAt = this.now();
        try { await this.#fetchOne(id); }
        catch (e) { this.log.warn?.(`posts: ${id}: ${String(e?.message ?? e).slice(0, 160)}`); }
        finally { this.inFlight = null; }
      }
    } finally { this.running = false; this.#wake(); }
  }
  /** Every fetch waits `wait` ms, or the next step of the doubling pause; the line is emptied. */
  #pause(wait = null) {
    if (wait == null) { this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, XPOST_PAUSE_MAX_MS) : XPOST_PAUSE_MS; wait = this.backoffMs; }
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    this.queue.length = 0;
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
}
