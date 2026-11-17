// GeckoTerminal's public OHLCV (https://api.geckoterminal.com/api/v2, keyless): the candles the chart history
// (lib/chart-history.mjs) shows before a coin's first stored trade. One client for the whole server, because the keyless
// limit is per IP (10 requests a minute, errors counted too): calls go one at a time in arrival order, `gapMs` apart
// (GECKO_PER_MIN, no burst), after any pause a 429 set, at most GECKO_DAILY a UTC day (kv geckoCalls, every request sent
// counts, whatever the answer). Nothing is retried here: a job that failed is tried again by a later ask
// (HIST_RETRY_MS). The body is read with a byte cap (rpc.mjs readText), never whole into memory first.
import { readText } from "./rpc.mjs";
import { isMint } from "./api.mjs";
import { timeframeOf } from "./candles.mjs";
import { abortableSleep } from "./tx-events.mjs";

export const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
export const GECKO_TIMEOUT_MS = 10_000, GECKO_MAX_BYTES = 1_048_576, GECKO_MAX_WAITING = 20;
/** A 429 without a usable Retry-After pauses every call this long, doubling on each such 429 up to the max; a 200 resets it. */
export const GECKO_429_MS = 60_000, GECKO_429_MAX_MS = 900_000;
const DAY_MS = 86_400_000;
/** The budget is saved this often (calls), when the day becomes spent, and at stop(). */
const SAVE_EVERY = 10;

/** `kind`: "rate" | "budget" | "busy" | "http" | "timeout" | "large" | "json" | "stopped"; `sent`: the request went out (it counts against the day). */
export class GeckoError extends Error {
  constructor(kind, message, sent = false) { super(message); this.kind = kind; this.sent = sent; this.name = "GeckoError"; }
}

export class Gecko {
  /**
   * `perMin`: requests a minute (GECKO_PER_MIN); `daily`: requests a UTC day (0 = no cap); `db`: where the day's count
   * is kept (kv geckoCalls), so a restart does not start the day over. `fetch`, `now` (ms), `sleep(ms, signal)` and
   * `timeoutMs` are injectable for tests.
   */
  constructor({ perMin = 8, daily = 5000, db = null, fetch = globalThis.fetch, now = Date.now, sleep = abortableSleep, log = console, timeoutMs = GECKO_TIMEOUT_MS } = {}) {
    this.perMin = perMin; this.daily = daily; this.db = db; this.fetch = fetch; this.now = now; this.sleep = sleep; this.log = log; this.timeoutMs = timeoutMs;
    this.gapMs = Math.ceil(60_000 / perMin);
    // `tail`: the turn of the last call in line (a strict FIFO, as lib/jupiter.mjs); `lastAt`: when the last call went out.
    this.tail = Promise.resolve(); this.lastAt = -Infinity; this.waiting = 0; this.pausedUntil = 0; this.backoffMs = 0;
    let saved = null;
    try { saved = db?.kvGet("geckoCalls", null) ?? null; } catch { /* a fresh count */ }
    const day = this.#day();
    this.budget = saved && saved.day === day && Number.isFinite(saved.used) ? { day, used: saved.used } : { day, used: 0 };
    this.spentLogged = null;
    this.ac = new AbortController(); this.stopped = false;
    this.stats = { calls: 0, ok: 0, notFound: 0, rateLimited: 0, errors: 0, timeouts: 0, tooLarge: 0, badJson: 0, refused: 0, dropped: 0, lastError: null, lastMs: null };
  }
  #day() { return Math.floor(this.now() / DAY_MS); }
  #rollDay() { const day = this.#day(); if (day !== this.budget.day) this.budget = { day, used: 0 }; }
  #save() { try { this.db?.kvSet("geckoCalls", this.budget); } catch { /* kept in memory */ } }
  /** The day's requests are used up (logged once a day). */
  spent() {
    this.#rollDay();
    const s = this.daily > 0 && this.budget.used >= this.daily;
    if (s && this.spentLogged !== this.budget.day) {
      this.spentLogged = this.budget.day; this.#save();
      this.log.info?.(`history: the day's ${this.daily} GeckoTerminal requests are spent; charts show what is stored until tomorrow (UTC)`);
    }
    return s;
  }
  snapshot() {
    this.#rollDay();
    return { callsToday: this.budget.used, daily: this.daily, perMin: this.perMin, waiting: this.waiting, pausedMs: Math.max(0, this.pausedUntil - this.now()), ...this.stats };
  }
  /** Saves the day's count and ends every wait; no request goes out after this. */
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.#save(); this.ac.abort(new Error("stopping"));
  }

  /**
   * One OHLCV page of `pool` at resolution `res` (s), `limit` candles up to `before` (unix s), priced in `currency`
   * ("usd" | "token") of `token` (the side the price is of). `{ status: 200, list, meta: { base, quote } }` (`list` as
   * sent, newest first; `meta` the pool's two token addresses) or `{ status: 404 }`; throws GeckoError otherwise. A
   * request that is not well formed (a pool or token that is no address, a resolution GeckoTerminal has no candles of)
   * is refused before it is sent. `signal`: the asker went away; a call whose turn comes after that is dropped unsent.
   */
  async ohlcv({ pool, res, currency, token, before, limit, signal } = {}) {
    const tf = timeframeOf(res);
    if (!tf || !isMint(pool) || !isMint(token) || (currency !== "usd" && currency !== "token") || !Number.isInteger(before) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      this.stats.refused++; throw new GeckoError("http", "not a GeckoTerminal OHLCV request");
    }
    if (this.stopped) throw new GeckoError("stopped", "stopping");
    if (this.spent()) throw new GeckoError("budget", "the day's GeckoTerminal requests are spent");
    if (this.waiting >= GECKO_MAX_WAITING) { this.stats.refused++; throw new GeckoError("busy", "too many GeckoTerminal requests waiting"); }
    this.waiting++;
    let queued = true, release;
    const prev = this.tail;
    this.tail = new Promise((r) => { release = r; });
    const leave = () => { if (queued) { queued = false; this.waiting--; } };
    try {
      await prev;
      for (;;) {
        if (this.stopped) throw new GeckoError("stopped", "stopping");
        if (signal?.aborted) { this.stats.dropped++; throw new GeckoError("stopped", "dropped before its turn"); }
        if (this.spent()) throw new GeckoError("budget", "the day's GeckoTerminal requests are spent");
        const at = Math.max(this.lastAt + this.gapMs, this.pausedUntil);
        if (at <= this.now()) break;
        await this.sleep(at - this.now(), this.ac.signal);
      }
      leave();
      this.lastAt = this.now();
      return await this.#send({ pool, tf, currency, token, before, limit, signal });
    } finally { leave(); release(); }
  }

  async #send({ pool, tf, currency, token, before, limit, signal }) {
    this.budget.used++; this.stats.calls++;
    if (this.budget.used % SAVE_EVERY === 0) this.#save();
    const url = `${GECKO_BASE}/networks/solana/pools/${pool}/ohlcv/${tf.tf}?aggregate=${tf.agg}&before_timestamp=${before}&limit=${limit}&currency=${currency}&token=${token}`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const t0 = this.now();
    const fail = (kind, stat, message) => { if (stat) this.stats[stat]++; this.stats.lastError = message; return new GeckoError(kind, message, true); };
    let res, text = null;
    try {
      res = await this.fetch(url, { headers: { accept: "application/json", "user-agent": "spore-chart/1" }, signal: AbortSignal.any([timeout, this.ac.signal, ...(signal ? [signal] : [])]) });
      if (res.status === 200) text = await readText(res, GECKO_MAX_BYTES);
      else res.body?.cancel?.().catch(() => {});
    } catch (e) {
      this.stats.lastMs = this.now() - t0;
      if (e?.tooLarge) throw fail("large", "tooLarge", `answer over ${GECKO_MAX_BYTES} bytes`);
      if (timeout.aborted) throw fail("timeout", "timeouts", `no answer within ${this.timeoutMs} ms`);
      if (this.stopped) throw new GeckoError("stopped", "stopping", true);
      if (signal?.aborted) { this.stats.dropped++; throw new GeckoError("stopped", "dropped", true); }
      throw fail("http", "errors", `unreachable: ${String(e?.message ?? e).slice(0, 160)}`);
    } finally { this.spent(); }
    this.stats.lastMs = this.now() - t0;
    if (res.status === 404) { this.stats.notFound++; return { status: 404 }; }
    if (res.status === 429) {
      this.stats.rateLimited++;
      const ra = Number(res.headers?.get?.("retry-after"));
      let wait;
      if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra * 1000, GECKO_429_MAX_MS);
      else { this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, GECKO_429_MAX_MS) : GECKO_429_MS; wait = this.backoffMs; }
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
      this.stats.lastError = `429: every request waits ${Math.round(wait / 1000)} s`;
      throw new GeckoError("rate", "GeckoTerminal is rate-limiting this server", true);
    }
    if (res.status !== 200) throw fail("http", "errors", `HTTP ${res.status}`);
    let body;
    try { body = JSON.parse(text); } catch { throw fail("json", "badJson", "not JSON"); }
    const list = body?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) throw fail("json", "badJson", "no ohlcv_list");
    this.stats.ok++; this.backoffMs = 0;
    return { status: 200, list, meta: { base: body?.meta?.base?.address ?? null, quote: body?.meta?.quote?.address ?? null } };
  }
}
