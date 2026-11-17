// Chart history: the time before a coin's first stored trade, on the coin page's chart.
//
// Why: the trades table starts when the server first saw a coin (and retention trims a busy coin to its last 24 h and
// newest 2 000 rows, lib/db.mjs insertTrade), so the chart of an older coin used to start in the middle of its life.
// Only the coin page's chart opts in (`/api/candles/:mint?history=1`, PriceChart's three fetches); the map's side panel,
// the sparklines, the daily change and Portfolio keep today's meaning, and without the flag the answer is byte for byte
// what it was.
//
// Sources, in order:
// 1. GeckoTerminal's public OHLCV (lib/gecko.mjs) for the coin's curve, and its pump-amm pool after a migration (pool
//    first, the curve for what the pool does not cover, the two venues combined). It is asked once per (coin, res,
//    unit) FROM THE TOP (now - HIST_SETTLE_S), not only up to our first stored trade `B`: retention moves `B` later many
//    times a day, and a row that reaches the top keeps covering it for about a day, so a re-fetch is a rare, silent
//    extension. The overlap with our own candles is the seam check: GeckoTerminal's closes against ours catch a wrong
//    unit, wrong decimals or a wrong pool before anything is shown. Only final candles are stored (their bucket ended
//    HIST_SETTLE_S before the fetch); a stored candle is never fetched again for the same bucket, a re-fetch is merged
//    in by time, and a failed one keeps the row.
// 2. Where GeckoTerminal has no candles for that time (it never indexed the pool, or stopped), a few of the coin's
//    transactions are read from the chain on the trade fill's lane (RPC_URL only, never RPC_USER_URL), only while the
//    gap fill is idle (TradeFiller.busy()): the stretch is listed down from the first stored trade's signature, and
//    read whole when it holds HIST_SAMPLES signatures or fewer (real candles), else sampled (one signature per slice of
//    equal count: a line through real prices, no highs, lows or volume). The prices are the events' own
//    (indexer.mjs tradeOfEvent, as the live path and the fill); USD from the SOL/USD hourly closes (one GeckoTerminal
//    call serves every SOL coin for an hour), 1 for USDC, a tracked parent's stored price or its own hourly row.
//
// What history does not do: it never becomes a `trades` row (no fill_coins, activity, SSE, retention, P&L), and other
// coins' events in a transaction read for it are dropped. Budgets: GECKO_PER_MIN and GECKO_DAILY for the whole server
// (lib/gecko.mjs), HIST_COIN_GT_DAILY GeckoTerminal calls per coin a day, CHART_SAMPLE_DAILY chain calls a day (its own
// count, apart from TRADE_FILL_DAILY), HIST_JOB_CALLS per sampling job, RATE_HISTNEW new jobs per IP an hour (the
// route's limiter: serving what is stored is never limited), at most HIST_MAX_QUEUE and HIST_MAX_CHAIN_QUEUE jobs
// waiting, the most recently asked first. Queues live in memory: the progress is in chart_history and chart_samples, and
// the chart's poll asks again after a restart.
//
// Older pages (the chart scrolled back, the route's `before=`, `page()`): the 500 buckets below the newest window, then
// below each page, in the key the client names, merged by the same mergeHistory over the same stored rows (so seams
// agree). A GeckoTerminal row grows backward on demand only (#fetchBack: one call of up to HIST_BACK_LIMIT candles,
// two pages, below `covFrom`, or from our first stored trade's bucket down when the row starts above it; a graduated
// coin's pool until its start, then its curve, their migration bucket combined and kept as `mig_at`), never past the
// coin's creation; an answer shorter than asked is GeckoTerminal's floor.
// A row whose top retention left behind (our first stored trade moved past `covTo` while the newest window no longer
// reaches there) is filled upward first (#fetchFwd), so a page never answers a stretch the row does not cover. Bounds: of the
// coin's HIST_COIN_GT_DAILY calls, HIST_BACK_RESERVE are never spent on older pages (its newest window keeps working);
// HIST_ROW_CANDLES per row (a top re-fetch keeps the older candles, dropping the oldest past the cap); deep rows (data
// over HIST_DEEP_BYTES) not asked for HIST_DEEP_KEEP_S, or past the HIST_DEEP_ROWS most recently asked, are trimmed to
// their newest HIST_DEEP_TRIM candles; the parsed-row cache is bounded by CACHE_MAX_CANDLES too. A page never queues
// chain sampling (it only reads stored points), queues at most one GeckoTerminal job (RATE_HISTNEW), and a refusal is
// "held" (the stored part served), never a 429.
//
// Left out on purpose: interior and head holes in GeckoTerminal's data; seek-by-time sampling (getBlock); a historical
// pool virtual quote (the current one, as the live path and the fill); USD for chain points of a coin quoted in a listed
// asset; finer GeckoTerminal series composing coarser ones; a persisted queue; resumable listing cursors.
import { READ_OPTS, SIG_MAX_BYTES, tick, abortableSleep, eventsOfTx, readTxWith } from "./tx-events.mjs";
import { tradeOfEvent } from "./indexer.mjs";
import { SOL_MINT } from "./jupiter.mjs";
import { USDC_MINT } from "./sdk.mjs";
import { GeckoError } from "./gecko.mjs";
import { FILL_PAGE, FILL_TX_CONCURRENCY, FILL_TX_RETRIES, FILL_OUTAGE_STREAK, FILL_OUTAGE_PAUSE_MS } from "./trade-fill.mjs";
import { buildCandles, parseOhlcv, combineVenues, seamCheck, seamStats, holeOf, pickSamples, mergeHistory, clipPage, pageNext, HIST_HOLE_MIN, HIST_BUCKETS } from "./candles.mjs";

/** HIST_BUCKETS: buckets in the chart's window (= the route's: tradesSince(now - res × 500)) and in every older page. */
export { HIST_HOLE_MIN, HIST_BUCKETS, USDC_MINT };
/** The resolutions history is served for (GeckoTerminal has these: lib/candles.mjs timeframeOf). */
export const HIST_RES = [60, 300, 900, 3600];
/** A GeckoTerminal candle is stored only when its bucket ended this long before the fetch (t + R <= fetchedAt − this): its trades are all indexed. */
export const HIST_SETTLE_S = 600;
/** An ok row is fetched again (silently) at most this often, and only when it no longer covers the seam bucket. */
export const HIST_EXTEND_S = 21_600;
/** 'none' rows (404, or no candle from any pool) are asked again after this. */
export const HIST_NONE_RETRY_S = 21_600;
/** 'mismatch' rows (meta, validation or the seam check failed) after this. */
export const HIST_MISMATCH_RETRY_S = 86_400;
/** A job that failed (a GeckoTerminal error, a timeout, busy, a reference fetch) is not queued again for this long. */
export const HIST_RETRY_MS = 600_000;
/** GeckoTerminal jobs waiting; past it the one asked for longest ago leaves. */
export const HIST_MAX_QUEUE = 50;
/** Chain jobs waiting. */
export const HIST_MAX_CHAIN_QUEUE = 20;
/** GeckoTerminal calls per coin per UTC day (in memory; the SOL/USD reference is shared and not counted). */
export const HIST_COIN_GT_DAILY = 16;
/** Reads per sampling job; a stretch with at most this many signatures (listed whole) is read whole: exact candles. */
export const HIST_SAMPLES = 120;
/** getSignaturesForAddress pages per job, all addresses together. */
export const HIST_LIST_PAGES = 20;
/** Chain calls per job. */
export const HIST_JOB_CALLS = 200;
/** Reads between fill.busy() checks (FILL_TX_CONCURRENCY in flight). */
export const HIST_CHUNK = 20;
export const HIST_OUTAGE_STREAK = FILL_OUTAGE_STREAK;
export const HIST_OUTAGE_PAUSE_MS = FILL_OUTAGE_PAUSE_MS;
/** A sampling job stopped by an outage is run again after this. */
export const HIST_PARTIAL_RETRY_S = 1_800;
/** A samples row is extended toward a later first stored trade at most once a day. */
export const HIST_SAMPLE_EXTEND_S = 86_400;
/** Rows not asked for this long are pruned. */
export const HIST_KEEP_S = 14 * 86_400;
/** chart_history rows kept (the least recently asked go first). */
export const HIST_MAX_ROWS = 5_000;
/** chart_samples rows kept. */
export const HIST_MAX_SAMPLE_ROWS = 2_000;
/** asked_at is written at most this often per row (a poll every 5 s would otherwise write every 5 s). */
export const HIST_TOUCH_S = 3_600;
export const HIST_PRUNE_MS = 3_600_000;
/** Raydium SOL/USDC: the SOL/USD hourly reference (verified 2026-11-17: meta SOL/USDC, close within 0.1 % of solUsd). */
export const HIST_SOL_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
/** A tracked parent's stored price counts as its USD at time t only when it is at most this old (else its hourly row). */
const PARENT_PRICE_MAX_AGE_S = 21_600;
/** Candles in one (mint, res, unit) row at most (~225 KB of JSON): 1m ≈ 3.5 d, 5m ≈ 17 d, 15m ≈ 52 d, 1h ≈ 208 d. */
export const HIST_ROW_CANDLES = 5_000;
/** Of a coin's HIST_COIN_GT_DAILY calls a day, this many are never spent on older pages (its newest window keeps working). */
export const HIST_BACK_RESERVE = 4;
/** GeckoTerminal `limit` of one older-page call (two pages of the chart). */
export const HIST_BACK_LIMIT = 1_000;
/**
 * A row whose data JSON is longer than this is "deep" (grown backward by older pages). Above any HIST_DEEP_TRIM-candle
 * row (a candle at 8 significant digits is at most ~95 B of JSON, a memecoin's ~80 B), so a trimmed row, or one a top
 * re-fetch grew to under HIST_DEEP_TRIM, is never selected (read and parsed) again at the next prune.
 */
export const HIST_DEEP_BYTES = 120_000;
/** Deep rows kept whole; past them the least recently asked are trimmed. */
export const HIST_DEEP_ROWS = 300;
/** A deep row not asked for this long is trimmed. */
export const HIST_DEEP_KEEP_S = 3 * 86_400;
/** A trimmed row keeps its newest this many candles (covFrom = the oldest kept). */
export const HIST_DEEP_TRIM = 1_000;
/** Parsed rows kept in memory (a poll is one lookup, plus the route's indexed tradeAfter). */
const CACHE_MAX = 256;
/** The cache is bounded by candles (and samples' points) too: 256 deep rows would be ~1.3M candles (~40 MB per 400k). */
export const CACHE_MAX_CANDLES = 400_000;
const FAILED_MAX = 1_000;
const DAY_MS = 86_400_000;
const msg = (e) => String(e?.message ?? e).slice(0, 200);
const stopping = () => Object.assign(new Error("stopping"), { aborted: true });
const r8 = (x) => Number(x.toPrecision(8));
/** Sample states from best to worst; an extension keeps the worse of the two (quiet counts as exact). */
const RANK = { quiet: 0, exact: 0, sampled: 1, partial: 2 };
function worse(a, b) {
  if (RANK[a] !== RANK[b]) return RANK[a] > RANK[b] ? a : b;
  return RANK[a] === 0 && (a === "exact" || b === "exact") ? "exact" : a;
}

/**
 * Whether a graduated coin's row reaches down to its migration bucket (`migAt`, set once the curve was fetched): what
 * lies below is the curve's alone. Not from `pools`: a trim or a top re-fetch can drop the curve's candles while the
 * pools still name it.
 */
const onCurve = (row) => row?.migAt != null && row.covFrom <= row.migAt;

function parseRow(r) {
  const json = (v, d) => { try { const x = JSON.parse(v); return Array.isArray(x) ? x : d; } catch { return d; } };
  const candles = json(r.data, []).filter((x) => Array.isArray(x) && x.length === 6).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  return { mint: r.mint, res: r.res, unit: r.unit, state: r.state, pools: json(r.pools, []), covFrom: r.cov_from, covTo: r.cov_to, fetchedAt: r.fetched_at, askedAt: r.asked_at, migAt: r.mig_at ?? null, candles };
}
function parseSamples(r) {
  let pts = [];
  try { const x = JSON.parse(r.data); if (Array.isArray(x)) pts = x.filter((p) => Array.isArray(p) && p.length === 5); } catch { /* none */ }
  return { mint: r.mint, state: r.state, fromT: r.from_t, toT: r.to_t, calls: r.calls, at: r.at, askedAt: r.asked_at, retryAt: r.retry_at, retryExt: r.retry_ext ?? 0, pts };
}

export class ChartHistory {
  /**
   * `gecko`: the lib/gecko.mjs client (without one nothing is served); `rpc`: the trade fill's lane, `{ call(method,
   * params, opts) }` (null: no chain sampling, CHART_SAMPLE=0); `fill`: the TradeFiller (its busy() holds the chain
   * reads back). `cfg`: config.mjs `history`. `now()` (ms) and `sleep(ms, signal)` are the clock; tests hand in their own.
   */
  constructor({ model, gecko, rpc = null, fill = null, cfg = {}, now = Date.now, sleep = abortableSleep, log = console }) {
    this.model = model; this.db = model.db; this.gecko = gecko; this.rpc = rpc; this.fill = fill; this.now = now; this.sleep = sleep; this.log = log;
    this.cfg = { enabled: true, sample: true, sampleDaily: 5_000, ...cfg };
    this.enabled = this.cfg.enabled !== false && !!gecko;
    this.sampleOn = this.enabled && this.cfg.sample !== false && !!rpc;
    this.cache = new Map();       // `${mint}:${res}:${unit}` | `samples:${mint}` → parsed row (null: none stored)
    this.cacheCandles = 0;        // candles + points held by the cache (CACHE_MAX_CANDLES)
    this.gtQueue = new Map();     // `${mint}:${res}:${unit}` (newest window) | `…:back` (an older page) → { askedAt, mint, R, unit, back? }
    this.gtRunning = null;        // the key whose GeckoTerminal job runs
    this.chainQueue = new Map();  // mint → { askedAt, a, extend, R, key }
    this.chainRunning = null;     // the mint whose sampling job runs
    this.chainEntry = null;       // its queue entry ({ a, extend, … }): page() reads where a first job starts
    this.chainJob = null;         // its counters (#call)
    this.pauseUntil = 0; this.waking = false; // no sampling job before this (an outage, the day spent)
    this.failed = new Map();      // job key (`chain:${mint}` for sampling) → when it failed (ms)
    this.coinCalls = new Map();   // mint → { day, n }: GeckoTerminal calls of the UTC day
    this.seamLogged = new Set();
    let spent = null;
    try { spent = this.db.kvGet("histChainCalls", null); } catch { /* a fresh count */ }
    const day = this.#day();
    this.chainBudget = spent && spent.day === day && Number.isFinite(spent.used) ? { day, used: spent.used } : { day, used: 0 };
    this.budgetLogged = null; this.pruned = 0;
    this.ac = new AbortController();
    this.started = false; this.stopped = false; this.idleWaiters = []; this.pruneTimer = null;
    this.stats = { asked: 0, queued: 0, displaced: 0, limited: 0, refusedBudget: 0, refusedCoinCap: 0, fetched: 0, extended: 0, ok: 0, none: 0, mismatch: 0, seamMismatch: 0, seamWarn: 0,
      badCandles: 0, unaligned: 0, holes: 0, quiet: 0, exact: 0, sampled: 0, partial: 0, skippedUsd: 0, unpriced: 0, failed: 0, touched: 0,
      backAsked: 0, backQueued: 0, backFetched: 0, backFilled: 0, backFloor: 0, backFull: 0, backHeld: 0, backTrimmed: 0, lastError: null };
    this.chainStats = { listed: 0, anchorMisses: 0, txRead: 0, txRetries: 0, txUnread: 0, points: 0, outages: 0, budgetStops: 0, jobCaps: 0, yielded: 0 };
  }
  #nowS() { return Math.floor(this.now() / 1000); }
  #day() { return Math.floor(this.now() / DAY_MS); }
  #chainSpent() {
    const day = this.#day();
    if (day !== this.chainBudget.day) this.chainBudget = { day, used: 0 };
    return this.cfg.sampleDaily > 0 && this.chainBudget.used >= this.cfg.sampleDaily;
  }
  #saveChain() { try { this.db.kvSet("histChainCalls", this.chainBudget); } catch { /* kept in memory */ } }

  // ---------------------------------------------------------------- cache
  #cacheSet(k, v) {
    const size = (x) => x?.candles?.length ?? x?.pts?.length ?? 0;
    if (!this.cache.size) this.cacheCandles = 0; // cleared from outside: the count starts again
    if (this.cache.has(k)) { this.cacheCandles -= size(this.cache.get(k)); this.cache.delete(k); }
    this.cache.set(k, v); this.cacheCandles += size(v);
    // The oldest go first, never the entry just set (it is the last one).
    while ((this.cache.size > CACHE_MAX || this.cacheCandles > CACHE_MAX_CANDLES) && this.cache.size > 1) {
      const old = this.cache.keys().next().value;
      this.cacheCandles -= size(this.cache.get(old)); this.cache.delete(old);
    }
  }
  #cacheClear() { this.cache.clear(); this.cacheCandles = 0; }
  #row(mint, R, unit) {
    const k = `${mint}:${R}:${unit}`;
    if (this.cache.has(k)) return this.cache.get(k);
    const r = this.db.histGet(mint, R, unit), v = r ? parseRow(r) : null;
    this.#cacheSet(k, v);
    return v;
  }
  #samples(mint) {
    const k = `samples:${mint}`;
    if (this.cache.has(k)) return this.cache.get(k);
    const r = this.db.samplesGet(mint), v = r ? parseSamples(r) : null;
    this.#cacheSet(k, v);
    return v;
  }
  /** asked_at at most hourly per row: what pruning goes by. */
  #touch(row, smp, nowS) {
    if (row && nowS - row.askedAt >= HIST_TOUCH_S) { this.db.histTouch(row.mint, row.res, row.unit, nowS); row.askedAt = nowS; this.stats.touched++; }
    if (smp && nowS - smp.askedAt >= HIST_TOUCH_S) { this.db.samplesTouch(smp.mint, nowS); smp.askedAt = nowS; this.stats.touched++; }
  }

  // ---------------------------------------------------------------- serve
  /**
   * The chart of coin `c` at resolution `R` with its history merged in before the first stored trade (`oldest`:
   * db.tradeAfter(mint, -1), `{ sig, time }` or null), given our own candles `own` (buildCandles of the route's window):
   * `{ candles, priceKey, history? }`, or null when history does not apply (off, another resolution, an untracked coin,
   * a coin recorded from about its birth, its first stored trade before the window) or anything throws (the answer is
   * then today's). Database reads only, synchronous: what is missing is queued, and `history.state` says so ("loading":
   * GeckoTerminal is asked and nothing is stored for this series yet; "sampling": the chain is read and no samples row
   * exists yet; "done"). `mayQueue()` is asked before a new job is queued (the route's per-IP limiter); a refusal serves
   * what is stored.
   */
  serve(c, R, own, oldest, { mayQueue = () => true } = {}) {
    if (!this.enabled || !HIST_RES.includes(R) || !c?.tracked) return null;
    try {
      const nowS = this.#nowS(), W = nowS - HIST_BUCKETS * R;
      const B = oldest?.time ?? null;
      const lo = Math.floor(Math.max(W, c.createdAt ?? W) / R) * R;
      const b0 = B == null ? Infinity : Math.floor(B / R) * R;
      if (B != null && b0 - lo < 2 * R) return null; // recorded from (about) birth, or B before the window: nothing to add
      const top = Math.floor((nowS - HIST_SETTLE_S) / R) * R - R; // the newest final bucket
      if (top < lo) return null;
      this.stats.asked++;
      // The series key: ours when we have candles (buildCandles: USD only if every windowed trade has it), else USD when
      // the quote has a USD price today. The other unit is another row, fetched when asked; nothing is converted.
      const key = own.candles.length ? own.priceKey : this.model.quoteUsdOf(c.quoteMint) != null ? "usd" : "quote";
      const k = `${c.mint}:${R}:${key}`;
      const row = this.#row(c.mint, R, key), smp = this.#samples(c.mint);
      this.#touch(row, smp, nowS);
      let gtState;
      if (this.gtRunning === k || this.gtQueue.has(k)) {
        const q = this.gtQueue.get(k);
        if (q) { q.askedAt = this.now(); q.fromPage = false; } // the newest window wants it too: its sampling follows
        gtState = row ? "silent" : "loading";
      } else if (!row) gtState = this.#enqueueGt(c.mint, R, key, mayQueue) ? "loading" : "done";
      else { if (this.#due(row, lo, b0, top, nowS)) this.#enqueueGt(c.mint, R, key, mayQueue); gtState = "done"; }
      const gtPending = this.gtRunning === k || this.gtQueue.has(k);
      const chainState = this.#chainFor(c, R, key, row, smp, { B, b0, lo, nowS, gtPending, mayQueue });
      const m = mergeHistory({ own: own.candles, gt: row?.state === "ok" ? row.candles : [], pts: smp?.pts ?? [], key, R, lo, b0, B, qd: this.model.quoteDecimals(c) });
      const state = gtState === "loading" ? "loading" : chainState === "sampling" ? "sampling" : "done";
      const history = { state, gecko: m.gtShown ? row?.pools?.[0] ?? null : null, chain: m.chain };
      const out = { candles: m.candles, priceKey: key };
      if (state !== "done" || history.gecko || history.chain) out.history = history;
      return out;
    } catch (e) { this.stats.lastError = `serve ${c.mint}: ${msg(e)}`; return null; }
  }
  /**
   * One older page of the coin page's chart (the route's `before=`): the buckets [lo, hi) of resolution `R` in the price
   * key `key` the client names (never converted), merged by the same mergeHistory over the same stored rows as the
   * newest window (serve), so a bucket two answers share is computed the same way. `own`: buildCandlesKeyed of our trades
   * in [lo, hi); `oldest`: db.tradeAfter(mint, -1). Answers `{ candles, priceKey, from, next, state, gecko, chain }`:
   * "loading" (a GeckoTerminal job for this stretch, or the coin's first sampling job, is queued or runs: nothing to apply,
   * ask the same page again),
   * "held" (older GeckoTerminal candles exist but cannot be fetched now: the day's budget, the coin's back calls, the
   * row full, a recent failure, the asker's limit; `from` = `next` = where the stored part starts) or "done"; null when
   * history does not apply (the route then serves our own trades only). Database reads only, synchronous. A page never
   * queues chain sampling; it queues at most one GeckoTerminal job, asked of `mayQueue()` (a refusal is "held").
   */
  page(c, R, key, { lo, hi, own, oldest }, { mayQueue = () => true } = {}) {
    if (!this.enabled || !HIST_RES.includes(R) || !c?.tracked) return null;
    try {
      const nowS = this.#nowS();
      const B = oldest?.time ?? null, b0 = B == null ? Infinity : Math.floor(B / R) * R;
      const cLo = c.createdAt != null ? Math.floor(c.createdAt / R) * R : null;
      // A coin recorded from (about) its birth has nothing before b0 worth a call (serve's rule).
      const needGt = lo < b0 && !(B != null && cLo != null && b0 - cLo < 2 * R);
      const k = `${c.mint}:${R}:${key}`, kb = `${k}:back`;
      const row = this.#row(c.mint, R, key), smp = this.#samples(c.mint);
      this.#touch(row, smp, nowS);
      this.stats.backAsked++;
      const pending = (x) => { if (this.gtRunning === x) return true; const q = this.gtQueue.get(x); if (q) q.askedAt = this.now(); return !!q; };
      const floored = row?.state === "ok" && row.covFrom <= (cLo ?? 0);
      let state = "done", gap = false;
      if (needGt) {
        // The newest window and its newest final bucket (serve's): before that bucket exists a newest job writes nothing.
        const W = nowS - HIST_BUCKETS * R, wlo = Math.floor(Math.max(W, c.createdAt ?? W) / R) * R;
        const top = Math.floor((nowS - HIST_SETTLE_S) / R) * R - R;
        if (pending(k)) state = "loading";
        else if (!row) state = top >= wlo && this.#enqueueGt(c.mint, R, key, mayQueue, { fromPage: true }) ? "loading" : "held";
        else if (row.state !== "ok") {
          // none or mismatch: GeckoTerminal adds nothing to this page; asked again silently after its wait (as serve).
          if (top >= wlo && this.#due(row, wlo, b0, top, nowS)) this.#enqueueGt(c.mint, R, key, mayQueue, { fromPage: true });
        } else if (row.covTo < Math.min(hi, b0, top + R)) {
          // The row stops below this page's stretch before our first stored trade (retention moved that trade past the
          // row's top, and the newest window no longer reaches there to fetch it again): filled upward first (#fetchFwd).
          gap = true;
          state = pending(`${k}:fwd`) || this.#enqueueBack(c.mint, R, key, mayQueue, { fwd: true }) ? "loading" : "held";
        } else if (row.covFrom > Math.max(lo, cLo ?? -Infinity) && !floored) state = pending(kb) || this.#enqueueBack(c.mint, R, key, mayQueue) ? "loading" : "held";
      }
      // The coin's first sampling job is queued or runs (serve's "sampling"): its points are written at the job's end, so a
      // page over the stretch it samples (from its start up to b0) waits for them ("loading") rather than answer without
      // them, maybe "done" with next null, which would end the client's paging for the visit.
      const cj = this.chainRunning === c.mint ? this.chainEntry : this.chainQueue.get(c.mint);
      if (state === "done" && this.sampleOn && !smp && cj && !cj.extend && cj.a < Math.min(hi, b0)) {
        if (this.chainQueue.has(c.mint)) cj.askedAt = this.now();
        state = "loading";
      }
      if (state === "loading") return { candles: [], priceKey: key, from: hi, next: hi, state };
      const gt = row?.state === "ok" ? row.candles : [], pts = smp?.pts ?? [];
      const m = mergeHistory({ own: own.candles, gt, pts, key, R, lo, b0, B, qd: this.model.quoteDecimals(c) });
      // Held: the page answers for the stored part only, and the next ask resumes there: our own trades from b0, and
      // GeckoTerminal's from where it was asked down to when the row reaches up to them (not across a gap at its top).
      const from = state !== "held" ? lo : Math.min(hi, Math.max(lo, row?.state === "ok" && !gap ? Math.min(row.covFrom, b0) : b0));
      const candles = clipPage(m.candles, from, hi);
      const next = state === "held" ? from
        : pageNext({ lo, cLo, ownOlderT: this.db.tradeTimeBefore(c.mint, lo), gt, gtFloor: floored || row?.state !== "ok", covFrom: row?.state === "ok" ? row.covFrom : null, pts, R });
      if (state === "held") this.stats.backHeld++;
      // Credits from the clipped rows (mergeHistory's flags cover the whole merge): below b0 a row is GeckoTerminal's
      // where it has a candle (points never are), else a chain point; at b0 the seam bucket carries GeckoTerminal's open.
      const gtAt = new Set(gt.map((x) => x.t));
      let gtIn = false, chainN = 0, sampled = false;
      for (const x of candles) {
        if (x.t <= b0 && gtAt.has(x.t)) gtIn = true;
        else if (x.t < b0) { chainN++; if (x.s) sampled = true; }
      }
      return { candles, priceKey: key, from, next, state, gecko: m.gtShown && gtIn ? row?.pools?.[0] ?? null : null, chain: sampled ? "sampled" : chainN ? "exact" : null };
    } catch (e) { this.stats.lastError = `page ${c.mint}: ${msg(e)}`; return null; }
  }
  /**
   * Whether a stored row is asked again (silently): an ok row that no longer covers the seam, or whose graduated coin's
   * curve call failed (covFrom past the window's start: after HIST_RETRY_MS), a none or mismatch row after its wait.
   */
  #due(row, lo, b0, top, nowS) {
    const age = nowS - row.fetchedAt, R = row.res;
    if (row.state === "ok") return (row.covTo < Math.min(b0 + R, top + R) && age >= HIST_EXTEND_S) || (row.covFrom > lo + R && age * 1000 >= HIST_RETRY_MS);
    if (row.state === "none") return age >= HIST_NONE_RETRY_S;
    return age >= HIST_MISMATCH_RETRY_S;
  }
  #coinCount(mint) { const e = this.coinCalls.get(mint); return e && e.day === this.#day() ? e.n : 0; }
  #countCall(mint) {
    const day = this.#day(), e = this.coinCalls.get(mint);
    if (e && e.day === day) e.n++;
    else { this.coinCalls.delete(mint); this.coinCalls.set(mint, { day, n: 1 }); if (this.coinCalls.size > 10_000) this.coinCalls.delete(this.coinCalls.keys().next().value); }
  }
  #failedRecently(k) { const at = this.failed.get(k); return at != null && this.now() - at < HIST_RETRY_MS; }
  #fail(k) {
    this.failed.delete(k); this.failed.set(k, this.now());
    if (this.failed.size > FAILED_MAX) this.failed.delete(this.failed.keys().next().value);
  }
  /** Puts out the entry asked for longest ago (not `keep`) when `q` is over `max`. */
  #bound(q, max, keep) {
    if (q.size <= max) return;
    let k = null;
    for (const [m, e] of q) if (m !== keep && (k == null || e.askedAt < q.get(k).askedAt)) k = m;
    q.delete(k); this.stats.displaced++;
  }
  /** Queues the GeckoTerminal job of one series; false when refused (the day spent, no room left in the coin's day for the job, failed lately, the asker's limit). */
  #enqueueGt(mint, R, unit, mayQueue, { fromPage = false } = {}) {
    const k = `${mint}:${R}:${unit}`;
    if (this.gtRunning === k || this.gtQueue.has(k)) return true;
    if (this.gecko.spent()) { this.stats.refusedBudget++; return false; }
    // Room for the whole job: a graduated coin's may take 2 calls (pool, curve).
    const c = this.model.get(mint), need = c?.migrated && c.pool ? 2 : 1;
    if (this.#coinCount(mint) + need > HIST_COIN_GT_DAILY) { this.stats.refusedCoinCap++; return false; }
    if (this.#failedRecently(k)) return false;
    if (!mayQueue()) { this.stats.limited++; return false; }
    this.gtQueue.set(k, { askedAt: this.now(), mint, R, unit, fromPage }); this.stats.queued++;
    this.#bound(this.gtQueue, HIST_MAX_QUEUE, k);
    this.#pumpGt();
    return true;
  }
  /**
   * Queues the GeckoTerminal job that grows an ok row backward (an older page, #fetchBack), or with `fwd` upward from
   * its top (#fetchFwd); refused as #enqueueGt, and also when the coin's day has no room left above HIST_BACK_RESERVE or
   * (backward) the row holds HIST_ROW_CANDLES. The single worker runs it apart from the row's other jobs, so the row's
   * read-modify-write never races.
   */
  #enqueueBack(mint, R, unit, mayQueue, { fwd = false } = {}) {
    const kb = `${mint}:${R}:${unit}:${fwd ? "fwd" : "back"}`;
    if (this.gtRunning === kb || this.gtQueue.has(kb)) return true;
    if (this.gecko.spent()) { this.stats.refusedBudget++; return false; }
    const c = this.model.get(mint), row = this.#row(mint, R, unit);
    const need = c?.migrated && c.pool && (fwd || !onCurve(row)) ? 2 : 1;
    if (this.#coinCount(mint) + need > HIST_COIN_GT_DAILY - HIST_BACK_RESERVE) { this.stats.refusedCoinCap++; return false; }
    if (!fwd && (row?.candles.length ?? 0) >= HIST_ROW_CANDLES) { this.stats.backFull++; return false; }
    if (this.#failedRecently(kb)) return false;
    if (!mayQueue()) { this.stats.limited++; return false; }
    this.gtQueue.set(kb, { askedAt: this.now(), mint, R, unit, back: !fwd, fwd }); this.stats.backQueued++;
    this.#bound(this.gtQueue, HIST_MAX_QUEUE, kb);
    this.#pumpGt();
    return true;
  }
  /**
   * The chain side of one ask: "sampling" (a first job for the coin is queued or runs), "silent" (a re-run or an
   * extension runs) or "none". A job is queued only once the series has a GeckoTerminal row and no GeckoTerminal job of it
   * is pending, and only for a hole (lib/candles.mjs holeOf): a first job; once `retry_at` passed, a re-run (a partial or
   * skipped row) or the stopped extension again (any other); an extension toward a first stored trade that moved
   * HIST_HOLE_MIN or more past `to_t`, at most once a day.
   */
  #chainFor(c, R, key, row, smp, { B, b0, lo, nowS, gtPending, mayQueue }) {
    if (!this.sampleOn) return "none";
    if (this.chainRunning === c.mint || this.chainQueue.has(c.mint)) {
      const q = this.chainQueue.get(c.mint);
      if (q) q.askedAt = this.now();
      return smp ? "silent" : "sampling";
    }
    if (!row || gtPending) return "none";
    const hole = holeOf(row, { lo, b0, R, W3600: nowS - HIST_BUCKETS * 3600, createdAt: c.createdAt, nowS });
    if (!hole) return "none";
    if (!smp) return this.#enqueueChain(c, hole.from, false, R, key, mayQueue) ? "sampling" : "none";
    if (smp.retryAt && nowS >= smp.retryAt) {
      // An extension an outage or the day's cap stopped (#endJob kept the stored state, a final partial one included, and
      // set retry_ext) is retried as that extension, from to_t, not a re-run that would read the covered stretch again
      // and could replace its points with a later cut. A partial or skipped row's own retry is a re-run; a row of another
      // state with a retry_at is an extension's (rows written before retry_ext).
      const ext = smp.retryExt === 1 || (smp.state !== "partial" && smp.state !== "skipped");
      this.#enqueueChain(c, ext ? smp.toT : hole.from, ext, R, key, mayQueue);
    } else if (smp.state !== "skipped" && B != null && b0 - smp.toT >= HIST_HOLE_MIN(R) && nowS - smp.at >= HIST_SAMPLE_EXTEND_S) this.#enqueueChain(c, smp.toT, true, R, key, mayQueue);
    return "none";
  }
  #enqueueChain(c, a, extend, R, key, mayQueue) {
    if (this.chainRunning === c.mint || this.chainQueue.has(c.mint)) return true;
    if (this.#chainSpent() || this.#failedRecently(`chain:${c.mint}`)) return false;
    if (!mayQueue()) { this.stats.limited++; return false; }
    this.chainQueue.set(c.mint, { askedAt: this.now(), a, extend, R, key });
    if (!extend) this.stats.holes++;
    this.#bound(this.chainQueue, HIST_MAX_CHAIN_QUEUE, c.mint);
    this.#pumpChain();
    return true;
  }

  // ---------------------------------------------------------------- workers
  start() {
    if (this.started || !this.enabled) return this;
    this.started = true;
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), HIST_PRUNE_MS); this.pruneTimer.unref?.();
    this.#pumpGt(); this.#pumpChain();
    return this;
  }
  /** Ends the jobs under way (what they stored stays) and every wait; saves both day counts. */
  stop() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.pruneTimer);
    this.#saveChain(); this.gecko?.stop();
    this.ac.abort(new Error("stopping")); for (const r of this.idleWaiters.splice(0)) r();
  }
  #isIdle() { return !this.started || this.stopped || (!this.gtRunning && !this.gtQueue.size && !this.chainRunning && !this.chainQueue.size); }
  #wake() { if (this.#isIdle()) for (const r of this.idleWaiters.splice(0)) r(); }
  /** Resolves when no job runs and none waits (tests). */
  idle() { return this.#isIdle() ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r)); }
  /** Drops rows not asked for HIST_KEEP_S, then past the row caps (the SOL/USD row stays while samples are recent); every HIST_PRUNE_MS. */
  prune() {
    try {
      const n = this.db.histPrune(this.#nowS() - HIST_KEEP_S, HIST_MAX_ROWS, HIST_MAX_SAMPLE_ROWS, { mint: SOL_MINT, res: 3600, unit: "usd" });
      if (n) { this.pruned += n; this.#cacheClear(); }
      this.#trimDeep();
      for (const [k, at] of this.failed) if (this.now() - at >= HIST_RETRY_MS) this.failed.delete(k);
      const day = this.#day();
      for (const [m, e] of this.coinCalls) if (e.day !== day) this.coinCalls.delete(m);
      return n;
    } catch (e) { this.stats.lastError = `prune: ${msg(e)}`; return 0; }
  }
  /**
   * Deep rows (grown backward by older pages, data over HIST_DEEP_BYTES) not asked for HIST_DEEP_KEEP_S, or past the
   * HIST_DEEP_ROWS most recently asked, keep their newest HIST_DEEP_TRIM candles (covFrom = the oldest kept; fetched_at
   * and asked_at unchanged): an older page asks GeckoTerminal again if someone scrolls back there. The SOL/USD reference
   * keeps its own window.
   */
  #trimDeep() {
    let n = 0;
    this.db.transaction(() => {
      for (const { mint, res, unit } of this.db.histDeep(HIST_DEEP_BYTES, HIST_DEEP_ROWS, this.#nowS() - HIST_DEEP_KEEP_S)) {
        if (mint === SOL_MINT) continue;
        const r = this.db.histGet(mint, res, unit);
        if (!r) continue;
        const row = parseRow(r);
        if (row.candles.length <= HIST_DEEP_TRIM) continue;
        const kept = row.candles.slice(row.candles.length - HIST_DEEP_TRIM);
        this.db.histSet({ ...row, covFrom: Math.max(row.covFrom, kept[0].t), data: kept.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]) });
        n++;
      }
    });
    if (n) { this.stats.backTrimmed += n; this.#cacheClear(); }
    return n;
  }
  #pumpGt() {
    if (!this.enabled || !this.started || this.stopped || this.gtRunning) return;
    if (!this.gtQueue.size) return this.#wake();
    let k = null;
    for (const [key, e] of this.gtQueue) if (k == null || e.askedAt > this.gtQueue.get(k).askedAt) k = key;
    const job = this.gtQueue.get(k);
    this.gtQueue.delete(k); this.gtRunning = k;
    this.#runGt(job).catch((e) => {
      if (this.stopped || e?.kind === "stopped" || e?.aborted) return;
      // The day is spent: nothing queued would get through (serve refuses new jobs until tomorrow).
      if (e?.kind === "budget") { this.gtQueue.clear(); return; }
      this.#fail(k); this.stats.failed++;
      this.stats.lastError = `${k}: ${msg(e)}`;
      if (!(e instanceof GeckoError) && !e?.cap) this.log.warn?.(`history: ${this.stats.lastError}`);
    }).finally(() => { this.gtRunning = null; if (!this.stopped) setImmediate(() => this.#pumpGt()); else this.#wake(); });
  }
  async #runGt(job) {
    if (job.back) return this.#fetchBack(job);
    if (job.fwd) return this.#fetchFwd(job);
    const { mint, R, unit } = job;
    const c = this.model.get(mint);
    if (!c?.tracked) return;
    const row = await this.#fetchRow(this.#coinSpec(c, R, unit));
    // A job an older page queued leaves the chain alone (a page never queues sampling; the newest window's ask does).
    if (!row || !this.sampleOn || job.fromPage) return;
    // The row may show a hole at once: its sampling job is queued from here (not limited: it was asked for already).
    const nowS = this.#nowS(), first = this.db.tradeAfter(mint, -1), W = nowS - HIST_BUCKETS * R;
    const B = first?.time ?? null, b0 = B == null ? Infinity : Math.floor(B / R) * R;
    this.#chainFor(c, R, unit, row, this.#samples(mint), { B, b0, lo: Math.floor(Math.max(W, c.createdAt ?? W) / R) * R, nowS, gtPending: false, mayQueue: () => true });
  }
  #pause(ms) { this.pauseUntil = Math.max(this.pauseUntil, this.now() + ms); }
  #pumpChain() {
    if (!this.sampleOn || !this.started || this.stopped || this.chainRunning) return;
    if (!this.chainQueue.size) return this.#wake();
    const ms = this.now();
    if (ms < this.pauseUntil) {
      if (!this.waking) { this.waking = true; this.sleep(this.pauseUntil - ms, this.ac.signal).then(() => { this.waking = false; this.#pumpChain(); }); }
      return;
    }
    let mint = null;
    for (const [m, e] of this.chainQueue) if (mint == null || e.askedAt > this.chainQueue.get(mint).askedAt) mint = m;
    const entry = this.chainQueue.get(mint);
    this.chainQueue.delete(mint); this.chainRunning = mint; this.chainEntry = entry;
    this.#sample(mint, entry).catch((e) => {
      if (this.stopped || e?.aborted) return;
      if (e?.budget) {
        // No sampling before the next UTC day: the line is emptied (serve refuses new jobs meanwhile).
        this.chainStats.budgetStops++; this.chainQueue.clear();
        this.#pause((this.chainBudget.day + 1) * DAY_MS - this.now() + 1000);
        if (this.budgetLogged !== this.chainBudget.day) { this.budgetLogged = this.chainBudget.day; this.log.info?.(`history: the day's ${this.cfg.sampleDaily} chain calls of the sampling are spent; it goes on tomorrow (UTC)`); }
        return;
      }
      if (e?.outage) {
        this.chainStats.outages++; this.#pause(HIST_OUTAGE_PAUSE_MS);
        this.stats.lastError = `${mint}: ${msg(e)}`; this.log.warn?.(`history: ${this.stats.lastError}; sampling waits ${HIST_OUTAGE_PAUSE_MS / 1000} s`);
        return;
      }
      if (e?.cap === "job") { this.chainStats.jobCaps++; return; }
      // A reference USD fetch or a write failed: not queued again for a while.
      this.#fail(`chain:${mint}`); this.stats.failed++;
      this.stats.lastError = `chain ${mint}: ${msg(e)}`;
      if (!(e instanceof GeckoError)) this.log.warn?.(`history: ${this.stats.lastError}`);
    }).finally(() => { this.chainRunning = null; this.chainEntry = null; if (!this.stopped) setImmediate(() => this.#pumpChain()); else this.#wake(); });
  }

  // ---------------------------------------------------------------- GeckoTerminal
  /** What to ask for a coin's row (also a parent's USD row for §10.4): its pools newest venue first, its quote, the window's start. */
  #coinSpec(c, R, unit) {
    return { mint: c.mint, R, unit, pools: c.migrated && c.pool ? [c.pool, c.curve] : [c.curve], token: c.mint, other: c.quoteMint ?? SOL_MINT, qd: this.model.quoteDecimals(c), coin: c,
      lo: (nowS) => { const W = nowS - HIST_BUCKETS * R; return Math.floor(Math.max(W, c.createdAt ?? W) / R) * R; } };
  }
  /** The SOL/USD reference: 1 000 hourly closes of the SOL/USDC pool, shared by every SOL coin's chain points. */
  #solSpec() {
    return { mint: SOL_MINT, R: 3600, unit: "usd", pools: [HIST_SOL_POOL], token: SOL_MINT, other: USDC_MINT, qd: 6, coin: null, lo: (nowS, top) => top - 999 * 3600 };
  }
  /** One GeckoTerminal call for subject `mint`, counted against its day when it was sent. */
  async #gt(mint, q) {
    if (mint !== SOL_MINT && this.#coinCount(mint) >= HIST_COIN_GT_DAILY) {
      this.stats.refusedCoinCap++;
      throw Object.assign(new Error("the coin's GeckoTerminal requests of the day are spent"), { cap: "coin" });
    }
    let r;
    try { r = await this.gecko.ohlcv({ ...q, signal: this.ac.signal }); } catch (e) { if (!(e instanceof GeckoError) || e.sent) this.#countCall(mint); throw e; }
    this.#countCall(mint);
    return r;
  }
  /**
   * Fetches one row from the top (§9.2): the first pool with `before = top`; a graduated coin's curve too when the pool
   * did not reach the window's start (`before` = the pool's oldest candle: their shared bucket is combined); at most 2 calls. Each answer's meta must
   * name the token and its quote (else the answer is a mismatch: the pool or the unit is not what was asked), its page
   * must pass parseOhlcv. A coin row goes through the seam check against our own candles. The row is written merged with
   * the stored one (new candles win on equal t, older than lo − R go; a `none` answer keeps an ok row's data: GeckoTerminal
   * does not un-index). Returns the row written, or null when the window has no final bucket.
   */
  async #fetchRow(s) {
    const nowS = this.#nowS(), R = s.R;
    const top = Math.floor((nowS - HIST_SETTLE_S) / R) * R - R;
    const lo = s.lo(nowS, top);
    if (top < lo) return null;
    const currency = s.unit === "usd" ? "usd" : "token", scaleV = s.unit === "quote" ? 10 ** s.qd : 1;
    let came = 0, dropped = 0;
    const ask = async (pool, before) => {
      const r = await this.#gt(s.coin?.mint ?? s.mint, { pool, res: R, currency, token: s.token, before, limit: Math.min(1000, (before - lo) / R + 1) });
      came++;
      if (r.status === 404) return [];
      const pair = new Set([r.meta?.base, r.meta?.quote]);
      if (pair.size !== 2 || !pair.has(s.token) || !pair.has(s.other)) { dropped++; this.stats.mismatch++; return []; }
      const p = parseOhlcv(r.list, { R, lo, top, scaleV });
      if (!p) { dropped++; this.stats.mismatch++; return []; }
      this.stats.badCandles += p.bad; this.stats.unaligned += p.unaligned;
      return p.candles;
    };
    const first = await ask(s.pools[0], top);
    let second = [], short = false, migAt = null;
    if (s.pools.length > 1 && (!first.length || first[0].t > lo + R)) {
      // Up to the pool's oldest bucket itself: the migration's bucket holds the curve's last trades and the pool's first,
      // and combineVenues merges the two candles of it (the curve's open, the pool's close, both volumes).
      const before = first.length ? first[0].t : top;
      // The curve's call failing (a 429, a timeout, the coin's or the server's day spent) keeps the pool's page, which was
      // paid for: the row covers from its oldest candle only (covFrom), and #due asks again for the rest after
      // HIST_RETRY_MS (with the server's day spent, the next job meets it before it sends anything and empties the queue).
      if (before >= lo) {
        try { second = await ask(s.pools[1], before); } catch (e) { if (!first.length || e?.kind === "stopped" || e?.aborted) throw e; short = true; }
        if (second.length) migAt = before;
      }
    }
    const candles = s.pools.length > 1 ? combineVenues(first, second) : first;
    const pools = [...(first.length ? [s.pools[0]] : []), ...(second.length ? [s.pools[1]] : [])];
    let state = came > 0 && dropped === came ? "mismatch" : candles.length ? "ok" : "none";
    if (state === "ok" && s.coin && this.#seam(s.coin, R, s.unit, candles, top) === "mismatch") state = "mismatch";
    const old = this.#row(s.mint, R, s.unit);
    let data = state === "ok" ? candles : [], covFrom = short ? first[0].t : lo, covTo = top + R, outPools = pools, outState = state;
    if (old?.state === "ok" && state === "ok") {
      // A coin row keeps what older pages fetched (#fetchBack) below lo while its coverage meets this fetch's (else the
      // stretch between would be claimed covered: today's rule then); the SOL/USD reference keeps today's rule.
      const keepOld = !!s.coin && old.covTo >= covFrom;
      const keepFrom = keepOld ? Math.min(lo - R, old.covFrom) : lo - R;
      const byT = new Map(old.candles.filter((x) => x.t >= keepFrom).map((x) => [x.t, x]));
      for (const x of candles) byT.set(x.t, x);
      data = [...byT.values()].sort((a, b) => a.t - b.t);
      outPools = [...new Set([...pools, ...old.pools])];
      // A short fetch (the curve's call failed) whose old row stopped below its oldest candle claims only from that candle
      // (the old row's candles below lo − R went, and the stretch between was never fetched): #due asks the curve again.
      if (keepOld) covFrom = Math.min(covFrom, old.covFrom);
      // Past the row cap the oldest go, and the row covers from the oldest kept.
      if (s.coin && data.length > HIST_ROW_CANDLES) { data = data.slice(data.length - HIST_ROW_CANDLES); covFrom = data[0].t; }
    } else if (old?.state === "ok" && state === "none") {
      outState = "ok"; data = old.candles; covFrom = old.covFrom; covTo = old.covTo; outPools = old.pools;
    }
    // The migration bucket stays known (onCurve compares it with covFrom, so a row whose curve candles went asks the pool).
    const row = { mint: s.mint, res: R, unit: s.unit, state: outState, pools: outPools, covFrom, covTo, fetchedAt: nowS, askedAt: Math.max(old?.askedAt ?? 0, nowS), migAt: migAt ?? old?.migAt ?? null, candles: data };
    this.db.histSet({ ...row, data: data.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]) });
    this.#cacheSet(`${s.mint}:${R}:${s.unit}`, row);
    this.stats.fetched++; if (old) this.stats.extended++;
    if (outState === "ok") this.stats.ok++; else if (outState === "none") this.stats.none++;
    return row;
  }
  /**
   * One older-page call (#fetchBack, #fetchFwd) for coin `c`: GeckoTerminal's `lim` rows at or before `b` of `pool`, the
   * pair checked, parsed for buckets `lo ≤ t ≤ b` and cut to the newest `lim`: `{ candles, total, oldest }` (`total`
   * rows as sent, `oldest` the oldest row's bucket, below `lo` or not; null without one). Refused per call when the
   * coin's day has no room left above HIST_BACK_RESERVE (other jobs of the coin may have spent it since this one was
   * queued).
   */
  async #askPage(c, R, unit, pool, b, lim, lo) {
    const mint = c.mint;
    if (this.#coinCount(mint) >= HIST_COIN_GT_DAILY - HIST_BACK_RESERVE) {
      this.stats.refusedCoinCap++;
      throw Object.assign(new Error("the coin's GeckoTerminal requests for older pages are spent today"), { cap: "coin" });
    }
    const currency = unit === "usd" ? "usd" : "token", scaleV = unit === "quote" ? 10 ** this.model.quoteDecimals(c) : 1, other = c.quoteMint ?? SOL_MINT;
    const r = await this.#gt(mint, { pool, res: R, currency, token: mint, before: b, limit: lim });
    if (r.status === 404) return { candles: [], total: 0, oldest: null };
    const pair = new Set([r.meta?.base, r.meta?.quote]);
    if (pair.size !== 2 || !pair.has(mint) || !pair.has(other)) { this.stats.mismatch++; throw new Error(`older page of ${pool}: the answer names another pair`); }
    const p = parseOhlcv(r.list, { R, lo, top: b, scaleV });
    if (!p) { this.stats.mismatch++; throw new Error(`older page of ${pool}: too many bad candles`); }
    this.stats.badCandles += p.bad; this.stats.unaligned += p.unaligned;
    let oldest = null;
    for (const x of r.list) if (Array.isArray(x) && Number.isFinite(x[0])) { const t = Math.floor(x[0] / R) * R; if (oldest == null || t < oldest) oldest = t; }
    return { candles: p.candles.length > lim ? p.candles.slice(p.candles.length - lim) : p.candles, total: p.total, oldest };
  }
  /**
   * Grows an ok row backward by one call (§2.5 of the scroll-back spec): GeckoTerminal's candles below `covFrom`, up to
   * HIST_BACK_LIMIT and the room left in the row, down to the coin's creation bucket. Every row of the answer from the
   * creation bucket on is kept (GeckoTerminal sends no row for a bucket without trades, so a sparse coin's rows reach
   * further back than `limit` buckets). A graduated coin whose row does not reach its migration (onCurve) asks its pool
   * first and, once the pool's start is reached, the curve up to the pool's oldest bucket, whose two candles are
   * combined (combineVenues, also when the pool's one was stored by an earlier fetch); its migration bucket is then
   * kept (mig_at). An answer with fewer rows than asked is GeckoTerminal's floor: covFrom drops to the creation bucket
   * (0 without createdAt) and no later page asks again. fetchedAt is left alone (#due measures the top fetch's age), but a rebase. No
   * seam check: the row passed it for the same pools and currency, and every answer's pair is checked.
   * A row whose coverage starts above the bucket after our first stored trade's (b0 + R: the newest window, or a trim,
   * left it there, our trades having been kept from before it) is asked from b0 down instead: GeckoTerminal's candles
   * above b0 are never shown (mergeHistory takes them below b0 and at the seam bucket only), so walking down to b0
   * would spend calls and row room on nothing. Its candles from b0 + R up go and it covers [covFrom, b0 + R) (covTo
   * = b0 + R): the stretch skipped is never claimed, and #fetchFwd fills upward if retention moves b0 past it. Its
   * fetchedAt goes to 0 (the window's candles went): if retention moves b0 into the newest window, the first serve()
   * then finds the row due at once (no HIST_EXTEND_S wait), and its newest job is queued before any chain sampling.
   */
  async #fetchBack({ mint, R, unit }) {
    const c = this.model.get(mint);
    let row = this.#row(mint, R, unit);
    if (!c?.tracked || row?.state !== "ok") return;
    const firstTrade = this.db.tradeAfter(mint, -1), b0 = firstTrade ? Math.floor(firstTrade.time / R) * R : Infinity;
    if (row.covFrom > b0 + R) row = { ...row, candles: row.candles.filter((x) => x.t < b0 + R), covFrom: b0 + R, covTo: b0 + R, fetchedAt: 0 };
    const nowS = this.#nowS(), cLo = c.createdAt != null ? Math.floor(c.createdAt / R) * R : null, floorAt = cLo ?? 0;
    const room = HIST_ROW_CANDLES - row.candles.length;
    if (room < 1) return;
    const limitAt = (b, rm) => Math.min(HIST_BACK_LIMIT, rm, cLo != null ? (b - cLo) / R + 1 : HIST_BACK_LIMIT);
    const write = (candles, covFrom, pools, floored, migAt) => {
      const next = { ...row, candles, covFrom: Math.min(covFrom, row.covFrom), pools, migAt, askedAt: Math.max(row.askedAt, nowS) };
      this.db.histSet({ ...next, data: candles.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]) });
      this.#cacheSet(`${mint}:${R}:${unit}`, next);
      this.stats.backFetched++; if (floored) this.stats.backFloor++;
    };
    const before = row.covFrom - R;
    const limit = limitAt(before, room);
    if (limit < 1) return write(row.candles, floorAt, row.pools, true, row.migAt); // nothing left above the coin's start
    const ask = (pool, b, lim) => this.#askPage(c, R, unit, pool, b, lim, floorAt);
    // A row written before mig_at existed whose pools name the curve: its stored oldest candle may be the curve's.
    const legacy = row.migAt == null && row.pools.includes(c.curve);
    const venues = c.migrated && c.pool ? (onCurve(row) ? [c.curve] : [c.pool, c.curve]) : [c.curve];
    const first = await ask(venues[0], before, limit);
    // How far down GeckoTerminal was asked: the oldest candle received, or the asked bottom when a full answer had none in
    // range (its rows were older); a short empty answer adds nothing.
    const reached = (a, b, lim) => a.candles[0]?.t ?? (a.total >= lim ? b - (lim - 1) * R : row.covFrom);
    let got = first.candles, floored = first.total < limit, low = reached(first, before, limit), migAt = row.migAt;
    const pools = new Set(row.pools);
    if (first.candles.length) pools.add(venues[0]);
    if (venues.length > 1 && first.total < limit) {
      // The pool's start (the migration) is reached: the curve up to the pool's oldest bucket, fetched now or stored.
      const pb = first.candles[0]?.t ?? row.candles[0]?.t ?? before;
      const lim2 = limitAt(pb, room - first.candles.length + 1);
      let second = null;
      if (lim2 >= 1) {
        try { second = await ask(venues[1], pb, lim2); } catch (e) { if (!first.candles.length || e?.kind === "stopped" || e?.aborted) throw e; }
      }
      if (second) {
        const poolAt = first.candles.find((x) => x.t === pb) ?? (legacy ? null : row.candles.find((x) => x.t === pb));
        got = [...first.candles.filter((x) => x.t !== pb), ...combineVenues(poolAt ? [poolAt] : [], second.candles)];
        floored = second.total < lim2;
        if (second.candles.length) pools.add(venues[1]);
        // The pool had no row at all at or before `before`: it starts above this stretch, which is the curve's alone, so
        // the row is onCurve after this write (covFrom ≤ row.covFrom) and later pages ask the curve only (a legacy row too).
        if (poolAt) migAt = pb; else if (first.oldest == null) migAt = row.covFrom;
        low = Math.min(low, reached(second, pb, lim2));
      } else floored = false; // the curve could not be asked (its call failed, or the row is full): the pool's page is kept, not floored
    }
    const byT = new Map(row.candles.map((x) => [x.t, x]));
    for (const x of got) byT.set(x.t, x);
    write([...byT.values()].sort((a, b) => a.t - b.t), floored ? floorAt : low, [...pools], floored, migAt);
  }
  /**
   * Fills an ok row upward from its top `covTo` (a page found the stretch below our first stored trade uncovered: the
   * trades table moved past the row's top, and the newest window no longer reaches there to fetch it again): one call of
   * up to HIST_BACK_LIMIT buckets from `covTo` up, toward our first stored trade's bucket (the seam) or the newest final
   * bucket, whichever is lower. GeckoTerminal answers the newest rows at or before `before`, so the stretch [covTo,
   * before] is known whatever came: covTo rises to before + R, and the page asks again for the rest. A graduated coin
   * asks its pool, and its curve too when the pool starts inside the stretch (up to the pool's oldest bucket, combined).
   * Past HIST_ROW_CANDLES the oldest candles go (covFrom rises to the oldest kept). fetchedAt is left alone.
   */
  async #fetchFwd({ mint, R, unit }) {
    const c = this.model.get(mint), row = this.#row(mint, R, unit);
    if (!c?.tracked || row?.state !== "ok") return;
    const nowS = this.#nowS(), top = Math.floor((nowS - HIST_SETTLE_S) / R) * R - R;
    const firstTrade = this.db.tradeAfter(mint, -1), b0 = firstTrade ? Math.floor(firstTrade.time / R) * R : Infinity;
    const lo = row.covTo, to = Math.min(b0 + R, top + R);
    if (lo >= to) return;
    const lim = Math.min(HIST_BACK_LIMIT, (to - lo) / R), before = lo + (lim - 1) * R;
    const venues = c.migrated && c.pool ? [c.pool, c.curve] : [c.curve];
    const first = await this.#askPage(c, R, unit, venues[0], before, lim, lo);
    let got = first.candles, migAt = row.migAt;
    const pools = new Set(row.pools);
    if (got.length) pools.add(venues[0]);
    if (venues.length > 1 && first.total < lim && (first.oldest == null || first.oldest > lo)) {
      // The pool starts inside the stretch: the curve below its oldest bucket, that bucket combined.
      const pb = got[0]?.t ?? before;
      const second = await this.#askPage(c, R, unit, venues[1], pb, (pb - lo) / R + 1, lo);
      const poolAt = got.find((x) => x.t === pb);
      got = [...got.filter((x) => x.t !== pb), ...combineVenues(poolAt ? [poolAt] : [], second.candles)];
      if (second.candles.length) pools.add(venues[1]);
      if (poolAt && second.candles.length) migAt = pb;
    }
    const byT = new Map(row.candles.map((x) => [x.t, x]));
    for (const x of got) byT.set(x.t, x);
    let data = [...byT.values()].sort((a, b) => a.t - b.t), covFrom = row.covFrom;
    if (data.length > HIST_ROW_CANDLES) { data = data.slice(data.length - HIST_ROW_CANDLES); covFrom = data[0].t; }
    const next = { ...row, candles: data, covFrom, covTo: before + R, pools: [...pools], migAt, askedAt: Math.max(row.askedAt, nowS) };
    this.db.histSet({ ...next, data: data.map((x) => [x.t, x.o, x.h, x.l, x.c, x.v]) });
    this.#cacheSet(`${mint}:${R}:${unit}`, next);
    this.stats.backFetched++; this.stats.backFilled++;
  }
  /**
   * GeckoTerminal's closes against ours where both are complete (ours from the bucket after our first stored trade's,
   * up to the fetch's top), in the row's unit only: "mismatch" empties the row (logged once per coin when the ratio is
   * a power of ten: decimals), "warn" is served and counted.
   */
  #seam(c, R, unit, gt, top) {
    const first = this.db.tradeAfter(c.mint, -1);
    if (!first) return null;
    const b0 = Math.floor(first.time / R) * R;
    const own = buildCandles(this.db.tradesSince(c.mint, b0 + R), R);
    if (own.priceKey !== unit) return null;
    const ours = own.candles.filter((x) => x.t >= b0 + R && x.t + R <= top + R);
    const v = seamCheck(gt, ours);
    if (v === "warn") this.stats.seamWarn++;
    if (v === "mismatch") {
      this.stats.seamMismatch++;
      const k = Math.abs(seamStats(gt, ours).ln) / Math.LN10, n = Math.round(k);
      if (n >= 3 && Math.abs(k - n) <= 0.3 && !this.seamLogged.has(c.mint)) {
        this.seamLogged.add(c.mint); if (this.seamLogged.size > 1_000) this.seamLogged.delete(this.seamLogged.values().next().value);
        this.log.warn?.(`history: ${c.mint} GeckoTerminal prices are 10^${n} off ours (decimals?)`);
      }
    }
    return v;
  }

  // ---------------------------------------------------------------- chain sampling
  /**
   * One sampling job (§11): the stretch [a, b) before the first stored trade (b; now for a coin with none), its USD
   * reference fetched first, the coin's addresses listed down from the first stored trade's signature, the picks read
   * (exact: all of them), the row written. A cap, an outage or the day spent writes what was read as `partial` and
   * throws on to the worker; a reference fetch or a write that failed writes nothing.
   */
  async #sample(mint, entry) {
    const c = this.model.get(mint);
    if (!c?.tracked) return;
    const nowS = this.#nowS();
    const old = this.#samples(mint);
    const first = this.db.tradeAfter(mint, -1); // re-read now: retention may have moved it since the ask
    const B = first?.time ?? null, b = B ?? nowS, anchor = first?.sig ?? null;
    const extend = !!(entry.extend && old);
    const a = extend ? old.toT : entry.a;
    const job = { calls: 0, pts: [], unread: 0 };
    this.chainJob = job;
    let k = null, a2 = a;
    const end = (state, retryAt = 0) => this.#endJob(c, entry.key, old, extend, job, { state, retryAt, fromT: Math.min(a2, b), toT: b, k, nowS: this.#nowS() });
    try {
      if (b - a < HIST_HOLE_MIN(entry.R)) return end("quiet");
      // Points are priced in USD whatever the key: one samples row serves both units, and a quote-keyed series turns USD
      // once its USD-less trades are gone. So a reference fetch that failed fails a quote-keyed job too (retried after
      // HIST_RETRY_MS): its points would be stored final without USD, and nothing prices stored points again.
      const kind = this.#rateKind(c);
      if (kind === "listed" && entry.key === "usd") { this.stats.skippedUsd++; return end("skipped", nowS + 86_400); }
      if (kind === "sol" || kind === "parent") await this.#ensureRate(c, kind, a, b);
      if (kind !== "listed") k = this.#rateFn(c, kind);
      // Listing: each address from the same anchor; the pool first after a migration, and one page kept for each address after it.
      const addrs = c.migrated && c.pool ? [c.pool, c.curve] : [c.curve];
      const lists = [], pages = { n: 0 };
      let reached = true, cutAt = -Infinity;
      for (let i = 0; i < addrs.length; i++) {
        const r = await this.#listAddr(addrs[i], anchor, a, b, pages, HIST_LIST_PAGES - (addrs.length - 1 - i));
        lists.push(r.sigs);
        if (!r.reached) { reached = false; cutAt = Math.max(cutAt, r.cutAt); }
      }
      a2 = Math.max(a, cutAt);
      // Oldest first by (blockTime, slot); in a slot the two share (the migration's) curve before pool, as on chain.
      const byS = new Map();
      for (const sigs of lists) for (const s of sigs) if (s.blockTime >= a2 && !byS.has(s.signature)) byS.set(s.signature, s);
      const S = [...byS.values()].sort((x, y) => y.blockTime - x.blockTime || (y.slot ?? 0) - (x.slot ?? 0)).reverse();
      if (!S.length && reached) return end("quiet");
      const exactMode = reached && S.length <= HIST_SAMPLES;
      const forced = [];
      if (addrs.length > 1) {
        const curve = lists[1].find((s) => byS.has(s.signature)), pool = [...lists[0]].reverse().find((s) => byS.has(s.signature));
        if (curve) forced.push(curve.signature);
        if (pool) forced.push(pool.signature);
      }
      const at = new Map(S.map((s, i) => [s.signature, i]));
      const picks = (exactMode ? S : pickSamples(S, HIST_SAMPLES, forced)).map((s) => at.get(s.signature));
      const missing = await this.#readPicks(c, S, picks, job);
      if (!exactMode) {
        // A pick without a point of the coin (a create, the migration, liquidity, unread): its slice's signature before it, once.
        const picked = new Set(picks), again = [];
        for (const i of missing) if (i > 0 && !picked.has(i - 1)) { picked.add(i - 1); again.push(i - 1); }
        if (again.length) await this.#readPicks(c, S, again, job);
      }
      return end(!reached ? "partial" : exactMode && !job.unread ? "exact" : "sampled");
    } catch (e) {
      if (e?.budget) end("partial", (this.chainBudget.day + 1) * 86_400);
      else if (e?.outage) end("partial", this.#nowS() + HIST_PARTIAL_RETRY_S);
      else if (e?.cap === "job") end("partial");
      throw e;
    } finally { this.chainJob = null; this.#saveChain(); }
  }
  /**
   * Writes the job's row (§11.5): a first job's as it is; an extension appended to the stored one (to_t moves to `b`,
   * the worse state stays; one stopped by an outage or the day spent keeps the stored row with its retry_at and
   * retry_ext, so #chainFor retries it as the extension whatever the stored state); a re-run
   * replaces the stored row only with at least as many points (else the stored points stay, with the re-run's retry_at,
   * so a re-run that does worse is not repeated on every ask). Points older than the 1 h chart's window are dropped.
   * Points are exact (e = 1) only in an `exact` row; USD from `k` (null: none).
   */
  #endJob(c, key, old, extend, job, { state, retryAt, fromT, toT, k, nowS }) {
    const pts = job.pts.sort((x, y) => x.time - y.time || x.slot - y.slot || x.pos - y.pos || x.idx - y.idx).map((p) => {
      const ku = k ? k(p.time) : null;
      return [p.time, r8(p.pq), ku != null && ku > 0 ? r8(p.pq * ku) : null, p.atoms, state === "exact" ? 1 : 0];
    });
    if (key === "usd") this.stats.unpriced += pts.filter((p) => p[2] == null).length;
    this.chainStats.points += pts.length;
    if (state in RANK) this.stats[state]++;
    // Points before the 1 h chart's window (its first bucket) are never shown again: they go, so a row extended every day stays bounded.
    const floor = Math.floor((nowS - HIST_BUCKETS * 3600) / 3600) * 3600, inWindow = (ps) => ps.filter((p) => p[0] >= floor);
    const kept = old ? inWindow(old.pts) : [], fresh = inWindow(pts);
    let row;
    // An extension stopped by an outage or the day spent read only part of [to_t, b): to_t stays and what it read goes
    // (the next job reads the stretch again), retried at retry_at as an extension (#chainFor).
    if (extend && retryAt) row = { state: old.state, fromT: old.fromT, toT: old.toT, pts: kept, retryAt, retryExt: 1 };
    else if (extend) row = { state: worse(old.state, state), fromT: old.fromT, toT, pts: [...kept, ...fresh].sort((x, y) => x[0] - y[0]), retryAt };
    else if (old && fresh.length < kept.length) row = { state: old.state, fromT: old.fromT, toT: old.toT, pts: kept, retryAt };
    else row = { state, fromT, toT, pts: fresh, retryAt };
    Object.assign(row, { retryExt: row.retryExt ?? 0, fromT: Math.min(Math.max(row.fromT, floor), row.toT), mint: c.mint, calls: (old?.calls ?? 0) + job.calls, at: nowS, askedAt: Math.max(old?.askedAt ?? 0, nowS) });
    this.db.samplesSet({ ...row, data: row.pts });
    this.#cacheSet(`samples:${c.mint}`, row);
  }
  /** How chain points of coin `c` get their USD: "sol" | "usdc" | "parent" (a tracked pump coin) | "listed" (none: a USD-keyed job is skipped, a quote-keyed one's points stay without USD). */
  #rateKind(c) {
    const q = c.quoteMint;
    if (q == null || q === SOL_MINT) return "sol";
    if (q === USDC_MINT) return "usdc";
    return this.model.get(q)?.tracked ? "parent" : "listed";
  }
  /**
   * The reference rows the points' USD needs, fetched before any chain read (a failure fails the job). A stored row is
   * fetched again (at most hourly) when it ends an hour or more before the points it must price, and the SOL/USD row
   * also when it is not ok: a job never writes final points priced from a reference that has no candles or ends well
   * before them (a 'none' answer keeps an ok row's old end with a fresh fetched_at); it fails and is retried after
   * HIST_RETRY_MS. A parent's row is needed only when its stored trades leave a point of [a, b) without a price
   * (#storedPrices), and an ok one is fetched again only for a part of the stretch they leave unpriced: past its end, or
   * before the start of a row whose curve call failed (covFrom past the window's start; after HIST_RETRY_MS, as #due).
   * Such a short row, fetched now or still under HIST_RETRY_MS old, fails the job (its points before covFrom would be
   * stored final without USD); the retry after HIST_RETRY_MS fetches it again. The call is counted against the parent's day, so a busy parent's stored trades spare its own chart's calls. A parent
   * row that is not ok is asked again after its wait (#due's), and those points are then unpriced: GeckoTerminal has
   * nothing for it.
   */
  async #ensureRate(c, kind, a, b) {
    const nowS = this.#nowS(), hourOld = (row) => row.fetchedAt <= nowS - 3600;
    if (kind === "sol") {
      let row = this.#row(SOL_MINT, 3600, "usd");
      if (!row || ((row.state !== "ok" || row.covTo < b - 3600) && hourOld(row))) {
        if (!(row = await this.#fetchRow(this.#solSpec()))) throw new Error("the SOL/USD reference has no final hour yet");
      }
      if (row.state !== "ok") throw new Error(`the SOL/USD reference is ${row.state}`);
      // A fresh row ends at most HIST_SETTLE_S + 1 h before now (and b <= now): 2 h of slack.
      if (row.covTo < b - 7200) throw new Error("the SOL/USD reference ends before the stretch");
      return;
    }
    const P = this.model.get(c.quoteMint);
    if (this.#storedPrices(P.mint, a, b)) return;
    const row = this.#row(P.mint, 3600, "usd"), spec = this.#coinSpec(P, 3600, "usd");
    let stale;
    if (!row) stale = true;
    else if (row.state === "ok") {
      const from = Math.max(a, spec.lo(nowS));
      stale = (row.covTo < b - 3600 && hourOld(row) && !this.#storedPrices(P.mint, Math.max(a, row.covTo), b))
        || (row.covFrom > from + 3600 && (nowS - row.fetchedAt) * 1000 >= HIST_RETRY_MS && !this.#storedPrices(P.mint, from, Math.min(row.covFrom, b)));
    } else stale = nowS - row.fetchedAt >= (row.state === "none" ? HIST_NONE_RETRY_S : HIST_MISMATCH_RETRY_S);
    if (stale && !(await this.#fetchRow(spec))) throw new Error(`the USD row of ${P.mint} has no final hour yet`);
    // A row whose curve call failed (fetched now, or under HIST_RETRY_MS ago) prices nothing before its covFrom: the job
    // fails rather than write those points final without USD, and its retry fetches the row again (stale above).
    const got = this.#row(P.mint, 3600, "usd"), from = Math.max(a, spec.lo(nowS));
    if (got?.state === "ok" && got.covFrom > from + 3600 && !this.#storedPrices(P.mint, from, Math.min(got.covFrom, b))) {
      throw new Error(`the USD row of ${P.mint} starts after the stretch (its curve call failed)`);
    }
  }
  /**
   * Whether the parent's stored trades price every t in [a, b) (#rateFn: its last trade at or before t that has a USD
   * price, at most PARENT_PRICE_MAX_AGE_S old; one stored without USD in between does not hide it): its hourly row is then not needed. A quiet parent's stored trades can start long
   * before `a` and still leave hours without one. Walks from trade to trade: a few indexed lookups per 6 h of the stretch.
   */
  #storedPrices(P, a, b) {
    for (let t = a; t < b;) {
      const r = this.db.usdPriceAt(P, t);
      if (r == null || r.time < t - PARENT_PRICE_MAX_AGE_S) return false;
      t = r.time + PARENT_PRICE_MAX_AGE_S + 1;
    }
    return true;
  }
  /** k(t), USD per quote unit at time t (§10.4); null where it is not known. */
  #rateFn(c, kind) {
    if (kind === "usdc") return () => 1;
    // An hourly row: the close of the newest candle starting at or before t, its first open before it, today's past its
    // end; nothing before its covFrom (a graduated parent whose curve call failed: its first open is the migration's).
    const fromRow = (row, today) => (t) => {
      if (!row || row.state !== "ok" || !row.candles.length || t < row.covFrom) return null;
      if (t >= row.covTo) return today ?? null;
      const cs = row.candles;
      let lo = 0, hi = cs.length - 1, f = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].t <= t) { f = m; lo = m + 1; } else hi = m - 1; }
      return f < 0 ? cs[0].o : cs[f].c;
    };
    if (kind === "sol") return fromRow(this.#row(SOL_MINT, 3600, "usd"), this.model.solUsd);
    // The parent's price today stands for t past its row's end only when t is recent: a pump coin's price moves too much.
    const P = c.quoteMint, row = this.#row(P, 3600, "usd"), ofRow = fromRow(row, this.model.quoteUsdOf(P)), recent = this.#nowS() - PARENT_PRICE_MAX_AGE_S;
    return (t) => {
      const r = this.db.usdPriceAt(P, t);
      if (r != null && r.time >= t - PARENT_PRICE_MAX_AGE_S) return r.priceUsd;
      return row && t >= row.covTo && t < recent ? null : ofRow(t);
    };
  }
  /** Waits while the gap fill runs or waits (it starts within one chunk of being queued). */
  async #yieldToFill() {
    if (!this.fill?.busy?.()) return;
    this.chainStats.yielded++;
    while (this.fill.busy()) { if (this.stopped) throw stopping(); await this.sleep(2_000, this.ac.signal); }
    if (this.stopped) throw stopping();
  }
  /**
   * The signatures of `addr` in [a, b), listed down from `anchor` (the first stored trade's signature; null: from the
   * top): `{ sigs, reached, cutAt }`. The node resolves a `before` that does not touch the address through its slot
   * (checked on api.mainnet-beta with an 18-day-old anchor: it lists the address's signatures at or below the anchor's
   * slot, those earlier in the same slot included, then lower slots). An anchored first page that is empty is the end of
   * the address's history when the node knows the anchor (getSignatureStatuses, as trade-fill #known), else the walk
   * starts again from the top, skipping what is at or after `b`. Reached: a page went below `a`, or the history ended.
   * Past `maxPages` pages of the job the address is cut at the oldest time it listed.
   */
  async #listAddr(addr, anchor, a, b, pages, maxPages) {
    const out = [];
    let before = anchor, first = true, oldest = null;
    const outage = (e) => (e?.aborted || e?.budget || e?.cap || this.ac.signal.aborted ? e : Object.assign(new Error(`listing ${addr}: ${msg(e)}`), { outage: true }));
    for (;;) {
      if (pages.n >= maxPages) return { sigs: out, reached: false, cutAt: Math.min(oldest ?? b, b) };
      await this.#yieldToFill();
      pages.n++;
      let page;
      try { page = await this.#list(addr, before); } catch (e) { throw outage(e); }
      if (first && before && !page.sigs.length) {
        first = false;
        let known;
        try { known = await this.#known(before); } catch (e) { throw outage(e); }
        if (known) return { sigs: out, reached: true, cutAt: null };
        this.chainStats.anchorMisses++; before = null;
        continue;
      }
      first = false;
      let pageOldest = null;
      for (const s of page.sigs) {
        const t = Number.isFinite(s.blockTime) ? s.blockTime : null;
        if (t != null) pageOldest = pageOldest == null ? t : Math.min(pageOldest, t);
        if (s.err == null && t != null && t >= a && t < b) out.push(s);
      }
      if (pageOldest != null) oldest = oldest == null ? pageOldest : Math.min(oldest, pageOldest);
      if (page.short || (pageOldest != null && pageOldest < a)) return { sigs: out, reached: true, cutAt: null };
      before = page.sigs[page.sigs.length - 1].signature;
    }
  }
  async #known(sig) {
    const r = await this.#call("getSignatureStatuses", [[sig], { searchTransactionHistory: true }], SIG_MAX_BYTES);
    return r?.value?.[0] != null;
  }
  async #list(addr, before) {
    this.chainStats.listed++;
    const page = await this.#call("getSignaturesForAddress", [addr, { limit: FILL_PAGE, commitment: "confirmed", ...(before ? { before } : {}) }], SIG_MAX_BYTES);
    if (!Array.isArray(page)) throw new Error("getSignaturesForAddress: not a list");
    const sigs = page.filter((s) => typeof s?.signature === "string");
    return { sigs, short: page.length < FILL_PAGE || !sigs.length };
  }
  /**
   * Reads the signatures `S[i]` for `idxs` HIST_CHUNK at a time, FILL_TX_CONCURRENCY in flight, waiting for the gap fill
   * before each chunk. Each read transaction's events of the coin become points (`job.pts`); other coins' events are
   * dropped. Returns the indexes that gave no point. HIST_OUTAGE_STREAK reads in a row the endpoint never answered
   * throw `{ outage }` (the points of that chunk are kept).
   */
  async #readPicks(c, S, idxs, job) {
    const missing = [];
    let streak = 0;
    for (let i = 0; i < idxs.length; i += HIST_CHUNK) {
      if (this.stopped) throw stopping();
      await this.#yieldToFill();
      const chunk = idxs.slice(i, i + HIST_CHUNK), results = new Array(chunk.length);
      let next = 0, outage = false, failure = null;
      const halted = () => this.ac.signal.aborted || failure != null;
      const call = (m, p, bytes) => { if (failure != null) throw stopping(); return this.#call(m, p, bytes); };
      await Promise.all(Array.from({ length: Math.min(FILL_TX_CONCURRENCY, chunk.length) }, async () => {
        try {
          while (next < chunk.length && !outage && failure == null) {
            const k = next++, r = (results[k] = await readTxWith(call, S[chunk[k]], { retries: FILL_TX_RETRIES, stats: this.chainStats, aborted: halted }));
            if (r.error) { if (++streak >= HIST_OUTAGE_STREAK) outage = true; } else if (r.answered) streak = 0;
          }
        } catch (e) { failure ??= e; }
      }));
      results.forEach((r, k) => {
        if (!r) return;
        const pos = chunk[k], s = S[pos];
        if (!r.tx) { job.unread++; if (!r.error) this.chainStats.txUnread++; missing.push(pos); return; }
        const d = eventsOfTx(this.model, r.tx);
        if (d.incomplete) { job.unread++; this.chainStats.txUnread++; }
        let got = false;
        for (const { name, mint, idx, e } of d.events) {
          if (mint !== c.mint) continue; // history never stores another coin's trade
          const t = tradeOfEvent(this.model, c, name, e, { sig: s.signature, slot: r.tx.slot ?? 0, idx, time: e.timestamp || r.tx.blockTime || 0 });
          if (!t) continue;
          job.pts.push({ time: t.time, slot: t.slot, pos, idx, pq: t.priceQuote, atoms: Number(BigInt(t.quoteAmount)) });
          got = true;
        }
        if (!got) missing.push(pos);
      });
      if (failure != null) throw failure;
      if (this.stopped) throw stopping();
      if (outage) throw Object.assign(new Error(`${streak} transactions in a row could not be read`), { outage: true });
      await tick();
    }
    return missing.sort((x, y) => x - y);
  }
  /** One chain call within the caps: the day's (CHART_SAMPLE_DAILY, kv histChainCalls) and the job's (HIST_JOB_CALLS). The lane holds the rate. */
  async #call(method, params, maxBytes) {
    const signal = this.ac.signal;
    if (signal.aborted) throw stopping();
    if (this.#chainSpent()) throw Object.assign(new Error("the day's sampling calls are spent"), { budget: true });
    const job = this.chainJob;
    if (job && job.calls >= HIST_JOB_CALLS) throw Object.assign(new Error("the job's calls are spent"), { cap: "job" });
    if (job) job.calls++;
    this.chainBudget.used++;
    if (this.chainBudget.used % 20 === 0) this.#saveChain();
    return this.rpc.call(method, params, { ...READ_OPTS, maxBytes, signal });
  }

  // ---------------------------------------------------------------- health
  snapshot() {
    this.#chainSpent();
    let rows = null;
    try { rows = this.db.histCounts(); } catch { /* closed */ }
    return { enabled: this.enabled, sample: this.sampleOn, queue: this.gtQueue.size, running: this.gtRunning, chainQueue: this.chainQueue.size, chainRunning: this.chainRunning,
      pausedMs: Math.max(0, this.pauseUntil - this.now()), gecko: this.gecko?.snapshot() ?? null,
      chain: { callsToday: this.chainBudget.used, daily: this.cfg.sampleDaily, ...this.chainStats }, stats: { ...this.stats }, rows, pruned: this.pruned };
  }
}
