// Trade gap fill: the trades the live streams missed are read back from the chain when a coin's chart is opened, and
// stored as ordinary `trades` rows, so the candles have no holes.
//
// Why there are gaps: the trades table is fed by two logsSubscribe streams (lib/live.mjs, lib/indexer.mjs onLogs). While
// the server is down, and while a stream is reconnecting (measured: 50-70 reconnects a day on the public endpoint), the
// streams deliver nothing, and nothing else ever stores those trades. Each LogsSubscriber reports such a stretch
// (`onGap`): from its last notification before (for the first socket of a process, `resumeAt`, the last time the
// previous process was known alive: kv fillAlive, written every FILL_ALIVE_MS from the streams' last notification) to
// the FIRST NOTIFICATION of the new socket. Not to `onopen`: an open socket proves no delivery (a subscription answered
// late, refused, or a provider that starts sending a while later), and all of that is still the gap.
//
// Gaps are global, not per stream: with LIVE_POOLS=0 the pool trades come from the curve stream, so which stream missed
// what cannot be told from the stream. A global gap costs only listings: a signature the other stream did store is
// skipped without reading it. Gaps are kept in kv fillGaps (unix s, FILL_MARGIN_S added on both sides, the last
// FILL_LOOKBACK_S, at most FILL_MAX_GAPS), disjoint: a new gap keeps only the parts no existing gap covers, each under
// a new id, and an id never changes, so the per-coin sets of finished gap ids (`fill_coins`) stay valid.
//
// What a fill does, per coin, when its chart is asked for (/api/candles → want()): for each gap of the coin that is
// relevant (above the coin's retention floor, and the server had recorded the coin before the gap or the coin was born
// in it) and settled (FILL_SETTLE_S after its end), the coin's curve and pool are listed (getSignaturesForAddress) down
// through the gap; signatures that failed on chain or that already have a row of the coin are skipped (the stored-
// signature diff: most of a reconnect gap's neighbourhood was stored live); the rest are read (getTransaction) and
// decoded with the live decoder and numbering (lib/tx-events.mjs eventsOfTx, indexer tradeOfEvent), so a row read back
// and a live row of the same trade are one row (sig, mint, idx), in either order. Rows of every tracked coin in a
// transaction that was read are kept (they are exact and free): a child's once the gap is marked (so a parent filled
// whole prices it exactly), none of a job member filled later (it stores its own after its parent), and none but the
// coin's own from a transaction that decoded incomplete (each coin's fill reads it and marks its own gap). The coin's
// tracked ancestors are filled first for the same gaps, in the same job. A gap that is not relevant yet (the coin not
// recorded before it) is checked again on the next ask, and filled once it is. A relevant gap that has not settled yet
// answers `waiting` (nothing queued), so a chart opened right after a restart or a reconnect keeps asking until it has.
//
// USD: the price in quote units comes from the event itself (its reserves), never from the coin's current state. The
// USD value of one quote unit at the trade's time is, in order: the parent's stored priceUsd at that time when the
// quote is a tracked parent whose same gap was filled whole (exact: live, a child's priceUsd is its priceQuote times the
// parent's price, and the parent's rows of the gap are complete); else interpolated between the coin's own stored rows
// on either side of the gap (priceUsd / priceQuote); else, with no neighbours, today's quote price.
//
// What a filled row does not do (model.storeFilled): no SSE "trade" event (the print is not fresh), no reserves update
// (the event's reserves are old), no hot set, no activity counters (their ring is time-ordered; the next boot's seed
// counts filled rows), no version bump. A tracked wallet does get the row (model.walletTrades.onTrade).
//
// Bounds: its own RPC lane on RPC_URL (rpc.mjs "fill", never the metered endpoint; TRADE_FILL_RPS), a daily cap on calls
// (TRADE_FILL_DAILY, kv fillCalls), FILL_COIN_DAILY calls per coin a UTC day (fill_coins), FILL_RUN_CALLS per chain
// member per run, FILL_WINDOW_SIGS signatures per gap per address (past that the gap is "cut": done, not whole), at most
// FILL_MAX_QUEUE coins waiting, the most recently asked-for first, the stalest dropped from a full queue. An outage
// (FILL_OUTAGE_STREAK unanswered reads in a row, or a failed listing) stops the run and every run waits
// FILL_OUTAGE_PAUSE_MS; stored chunks stay, unfinished gaps stay pending, and the next run reads only what is still
// missing (what has no row of the coin yet and was not read for the gap before in this process: `noRow`). The queue is not persisted: the progress is in fill_coins and in the stored rows, and the chart's poll asks
// again.
//
// Left out, on purpose: history from before the server recorded a coin, and gaps older than FILL_LOOKBACK_S; socket
// silence that recovers without a reconnect, and a provider that drops some notifications while delivering others;
// activity, heat and 24 h volume of filled rows until the next restart; SSE for filled rows (the coin page's tape and the
// map's sparkline pick them up on their next load); a historical pool virtual quote (the current one is used, as on the
// live path) and USD history from outside sources; retrying unread transactions (a gap with one is done but not whole),
// a per-IP enqueue limit, a `trades.src` column and a persisted queue. Not covered here either: repairing live logs the
// node cut ("Log truncated") outside a gap; a trade behind such a cut stays missing (a tracked wallet's own trades are
// read again by lib/pnl-tracker.mjs onCutLog).
import { READ_OPTS, SIG_MAX_BYTES, tick, abortableSleep, eventsOfTx, readTxWith } from "./tx-events.mjs";
import { tradeOfEvent } from "./indexer.mjs";
import { TRADE_KEEP, TRADE_DAY_S } from "./db.mjs";
import { units } from "./pricing.mjs";

/** Gaps older than this are neither recorded nor filled: the default 5 m chart (500 candles, about 41.7 h) and the 24 h retention. */
export const FILL_LOOKBACK_S = 172_800;
/** Gaps kept (about 2 days at the measured 50-70 reconnects a day); the oldest go first. */
export const FILL_MAX_GAPS = 300;
/** Added on both sides of a gap: a listing's blockTime and the server's clock differ by a few seconds (= PNL_GAP_MARGIN_S). */
export const FILL_MARGIN_S = 30;
/** A gap is not filled until this long after its end: live prints after the reconnect land first, and the listing has caught up. */
export const FILL_SETTLE_S = 60;
/**
 * A coin at its retention cap by time (2 000 rows inside the last 24 h) counts as recorded before a gap that straddles
 * the 24 h floor only when its oldest kept row lies at most this long after the gap: a coin recorded through the gap has
 * its rows go on from right after it; a coin first tracked hours later does not.
 */
export const FILL_RETAIN_SLACK_S = 3_600;
/** The alive stamp (kv fillAlive) is written this often. */
export const FILL_ALIVE_MS = 60_000;
/** Coins waiting for a run; past it the one asked for longest ago leaves the queue. */
export const FILL_MAX_QUEUE = 100;
/** Chain calls per chain member per run (about 5 min at 1 rps): one busy coin cannot hold the lane for long. A parent at it is left for the coin's sake. */
export const FILL_RUN_CALLS = 300;
/** Chain calls per coin per UTC day. */
export const FILL_COIN_DAILY = 3_000;
/** Signatures listed per gap per address; past that the gap is cut (done, not whole). */
export const FILL_WINDOW_SIGS = 5_000;
/** Stored trades between the listing's place and a gap from which the listing jumps to the first stored trade after the gap. */
export const FILL_JUMP_TRADES = 1_000;
/** Signatures per listing call. */
export const FILL_PAGE = 1_000;
/** Transactions read and stored together (one sqlite transaction): what a stop or a cap repeats at most. */
export const FILL_CHUNK = 20;
export const FILL_TX_CONCURRENCY = 2;
export const FILL_TX_RETRIES = 2;
/** This many reads in a row the endpoint did not answer is an outage, not the coin: the run stops. */
export const FILL_OUTAGE_STREAK = 5;
/** No run reads the chain this long after an outage or a failed run. */
export const FILL_OUTAGE_PAUSE_MS = 30_000;
/** A coin whose run failed for a reason that was not an outage, or stored nothing past a transaction the endpoint would not answer, is not queued again for this long. */
export const FILL_RETRY_MS = 600_000;
/** The least the daily cap goes (a smaller TRADE_FILL_DAILY counts as this). */
export const FILL_DAILY_MIN = 200;
/** A coin and at most this many of its tracked ancestors (the nearest) are filled in one job. */
export const FILL_CHAIN_MAX = 8;
/** Gaps and fill_coins rows past FILL_LOOKBACK_S are pruned this often. */
export const FILL_PRUNE_MS = 3_600_000;
/** Coins whose last run failed, remembered at most (the oldest go). */
const FAILED_MAX = 1_000;
/** Gaps (of a coin) whose read signatures without a row of the coin are remembered at most (the oldest go). */
const NO_ROW_MAX = 200;
const DAY_MS = 86_400_000;
const msg = (e) => String(e?.message ?? e).slice(0, 200);
const stopping = () => Object.assign(new Error("stopping"), { aborted: true });
/** A listed signature's blockTime; null (unknown) counts as inside the gap. */
const timeOf = (s) => (Number.isFinite(s?.blockTime) ? s.blockTime : null);
/** The gaps FILL_SETTLE_S past their end at `nowS` (unix s). */
const settled = (gaps, nowS) => gaps.filter((g) => g.to + FILL_SETTLE_S <= nowS);

export class TradeFiller {
  /**
   * `rpc`: an object with `call(method, params, opts)` (index.mjs: the "fill" lane); without one, or with
   * `cfg.enabled` false, nothing is recorded or read and every method answers null. `streams()` gives the live
   * LogsSubscribers (their `lastNotificationAt` dates the alive stamp). `now()` (ms) and `sleep(ms, signal)` are the
   * clock; tests hand in their own.
   */
  constructor({ model, rpc = null, cfg = {}, streams = () => [], now = Date.now, log = console, sleep = abortableSleep }) {
    this.model = model; this.db = model.db; this.rpc = rpc; this.streams = streams; this.now = now; this.log = log; this.sleep = sleep;
    this.cfg = { enabled: true, dailyCalls: 20_000, ...cfg };
    if (this.cfg.dailyCalls > 0 && this.cfg.dailyCalls < FILL_DAILY_MIN) this.cfg.dailyCalls = FILL_DAILY_MIN;
    this.enabled = !!rpc && this.cfg.enabled !== false;
    model.tradeFill = this; // the indexer's streams report their gaps here (indexer start())
    const g = this.db.kvGet("fillGaps", null);
    const gaps = Array.isArray(g?.gaps) ? g.gaps.filter((x) => Number.isInteger(x?.id) && Number.isFinite(x.from) && Number.isFinite(x.to)) : [];
    this.gaps = { next: Math.max(Number.isInteger(g?.next) ? g.next : 1, ...gaps.map((x) => x.id + 1)), gaps };
    this.lastGap = null;
    // When the last process was known alive (ms): the start of the first socket's gap. pnlAlive (s) seeds only the first
    // start with this feature; without either there is no first gap.
    const alive = this.db.kvGet("fillAlive", null), pnlAlive = this.db.kvGet("pnlAlive", null);
    this.resumeAt = Number.isFinite(alive) ? alive : Number.isFinite(pnlAlive) ? pnlAlive * 1000 : 0;
    this.aliveAt = this.resumeAt || null;
    // The chain calls of the UTC day so far (kept across restarts).
    const spent = this.db.kvGet("fillCalls", null), day = this.#day();
    this.budget = spent && spent.day === day && Number.isFinite(spent.used) ? { day, used: spent.used } : { day, used: 0 };
    this.queue = new Map();     // mint → { askedAt, gaps, from, to }: at most FILL_MAX_QUEUE, the most recently asked-for runs first
    this.running = null;        // the mint whose job runs
    this.runEntry = null;       // its queue entry (what want() answers while it runs)
    this.pauseUntil = 0;        // no run before this (an outage, a failure, or the day's calls are spent)
    this.waking = false;
    this.failed = new Map();    // mint → when its last run failed (ms), at most FAILED_MAX
    this.row = null;            // the fill_coins row of the chain member being filled (#call counts its calls)
    this.runCalls = 0;          // chain calls of that member in this run
    this.jobRows = null;        // mint → fill_coins row, for the job under way (a parent's `whole` read once)
    this.jobEdges = null;       // `${mint}:${gap id}` → the coin's stored rows on either side of the gap
    this.jobLater = null;       // while a parent is filled: the job's members filled after it (they store their own rows)
    this.stuck = false;         // the job left a gap with an unanswered transaction and stored nothing new for it
    this.noRow = new Map();     // `${mint}:${gap id}` → { id, sigs }: signatures of a pending gap that were read (or answered without the transaction) and gave the coin no row
    this.budgetLogged = null;
    this.ac = new AbortController();
    this.started = false; this.stopped = false; this.idleWaiters = []; this.aliveTimer = null; this.pruneTimer = null;
    this.stats = { gaps: 0, asked: 0, queued: 0, displaced: 0, runs: 0, windowsDone: 0, windowsCut: 0, windowsSkipped: 0, listed: 0, jumps: 0, jumpMisses: 0,
      sigsStored: 0, sigsFailed: 0, sigsNoRow: 0, txRead: 0, txRetries: 0, txUnread: 0, txInner: 0, rows: 0, rowsOther: 0, priced: { parent: 0, edges: 0, now: 0, none: 0 },
      outages: 0, budgetStops: 0, runCaps: 0, coinCaps: 0, stuck: 0, lastError: null };
    if (this.#pruneGaps(this.#nowS())) this.#saveGaps();
  }
  #nowS() { return Math.floor(this.now() / 1000); }
  #day() { return Math.floor(this.now() / DAY_MS); }
  #rollDay() { const day = this.#day(); if (day !== this.budget.day) this.budget = { day, used: 0 }; }
  #spent() { this.#rollDay(); return this.cfg.dailyCalls > 0 && this.budget.used >= this.cfg.dailyCalls; }

  // ---------------------------------------------------------------- gaps
  /**
   * A stretch in which a live stream delivered nothing (ms; LogsSubscriber onGap). Widened by FILL_MARGIN_S on both
   * sides, clipped to FILL_LOOKBACK_S, and cut down to the parts no stored gap covers: each part longer than 1 s is a
   * new gap with a new id (two streams reporting the same boot give one gap plus the tail between their first
   * notifications).
   */
  addGap(fromMs, toMs) {
    if (!this.enabled || !(fromMs > 0) || !Number.isFinite(toMs)) return;
    const nowS = this.#nowS();
    const from = Math.max(Math.floor(fromMs / 1000) - FILL_MARGIN_S, nowS - FILL_LOOKBACK_S), to = Math.ceil(toMs / 1000) + FILL_MARGIN_S;
    if (!(to > from)) return;
    let parts = [[from, to]];
    for (const g of this.gaps.gaps) {
      parts = parts.flatMap(([a, b]) => (g.to <= a || g.from >= b ? [[a, b]] : [...(g.from > a ? [[a, g.from]] : []), ...(g.to < b ? [[g.to, b]] : [])]));
    }
    for (const [a, b] of parts) if (b - a > 1) this.gaps.gaps.push({ id: this.gaps.next++, from: a, to: b });
    this.#pruneGaps(nowS);
    this.#saveGaps();
    this.stats.gaps++; this.lastGap = { from, to };
  }
  /** Drops gaps that ended past FILL_LOOKBACK_S, then the oldest (by end) over FILL_MAX_GAPS; true when any went. */
  #pruneGaps(nowS) {
    const n = this.gaps.gaps.length;
    const keep = this.gaps.gaps.filter((g) => g.to >= nowS - FILL_LOOKBACK_S);
    if (keep.length > FILL_MAX_GAPS) { keep.sort((a, b) => a.to - b.to || a.id - b.id); keep.splice(0, keep.length - FILL_MAX_GAPS); }
    this.gaps.gaps = keep;
    return keep.length !== n;
  }
  #saveGaps() { try { this.db.kvSet("fillGaps", this.gaps); } catch (e) { this.stats.lastError = `gaps: ${msg(e)}`; } }
  /** The coin's fill_coins row (the job's copy while one runs), its daily calls reset on a new UTC day. */
  #rowOf(mint) {
    let row = this.jobRows?.get(mint);
    if (!row) {
      row = this.db.fillCoin(mint) ?? { mint, done: new Set(), whole: new Set(), partial: new Set(), day: 0, calls: 0, rows: 0, unread: 0, cut: 0, at: 0 };
      this.jobRows?.set(mint, row);
    }
    const day = this.#day();
    if (row.day !== day) { row.day = day; row.calls = 0; }
    return row;
  }
  /** Saves a row; its gap id sets only hold gaps still kept (so at most FILL_MAX_GAPS ids each). */
  #saveRow(row) {
    const live = new Set(this.gaps.gaps.map((g) => g.id));
    for (const set of [row.done, row.whole, row.partial]) for (const id of set) if (!live.has(id)) set.delete(id);
    row.at = this.#nowS();
    this.db.fillCoinSave(row);
  }
  /**
   * The gaps of coin `c` still to fill, newest first (by end): not done for it, inside FILL_LOOKBACK_S, in `onlyIds`
   * when given, and relevant; settled or not (the callers keep the settled ones: `settled`). A gap below the coin's
   * retention floor (insertTrade would trim its rows again at once) is marked done (not whole) with no chain call. A gap
   * from before the server recorded the coin (no stored trade before it, not created in it, and not explained by
   * retention: a partial fill would draw misleading islands) is left out but not marked: what makes it relevant can
   * still come (its creation time from the boot probe, or the rows of an older gap it was born in, once that one is
   * filled), so every ask checks it again (database reads only). A coin at its retention cap with a gap that starts at or
   * below the floor counts as recorded when retention explains the rows missing before it: always when the floor is its
   * 2 000th newest row (its oldest kept row is then at or before the gap's end), and when the floor is the 24 h line only
   * if its oldest kept row lies within FILL_RETAIN_SLACK_S after the gap (rows of the last 24 h are never trimmed, so a
   * coin whose rows start hours later was not recorded then).
   */
  #pending(c, onlyIds = null) {
    const nowS = this.#nowS(), oldest = nowS - FILL_LOOKBACK_S;
    const timely = this.gaps.gaps.filter((g) => g.to > oldest && (!onlyIds || onlyIds.has(g.id)));
    if (!timely.length) return [];
    const row = this.#rowOf(c.mint);
    const open = timely.filter((g) => !row.done.has(g.id));
    if (!open.length) return [];
    const nth = this.db.tradeNthTime(c.mint, TRADE_KEEP);
    const floor = Math.min(nowS - TRADE_DAY_S, nth ?? -Infinity);
    const first = this.db.tradeOldestTime(c.mint);
    const out = [];
    let skipped = 0;
    for (const w of open) {
      if (w.to < floor) { row.done.add(w.id); skipped++; continue; }
      const recorded = (first != null && first <= w.from + FILL_MARGIN_S) || (c.createdAt != null && c.createdAt >= w.from - FILL_MARGIN_S && c.createdAt <= w.to)
        || (nth != null && w.from + FILL_MARGIN_S <= floor && first != null && first <= w.to + FILL_RETAIN_SLACK_S);
      if (recorded) out.push(w);
    }
    if (skipped) { this.stats.windowsSkipped += skipped; this.#saveRow(row); }
    return out.sort((a, b) => b.to - a.to);
  }

  // ---------------------------------------------------------------- trigger
  /**
   * Called by every /api/candles request: null when nothing of the coin is pending (or it cannot be filled now), else
   * `{ state: "queued" | "running" | "waiting", gaps, from, to }`: queued or running, the coin is in line (asking again
   * keeps it in front); waiting, its gaps have not settled yet (nothing is queued; an ask after they settle queues it,
   * so the chart keeps asking). The day's calls spent: null for every coin, and the coin leaves the line.
   */
  want(mint) {
    if (!this.enabled) return null;
    try {
      const c = this.model.get(mint);
      if (!c?.tracked) return null;
      this.stats.asked++;
      const span = (gaps) => ({ gaps: gaps.length, from: Math.min(...gaps.map((g) => g.from)), to: Math.max(...gaps.map((g) => g.to)) });
      const view = (state, e) => ({ state, gaps: e.gaps, from: e.from, to: e.to });
      if (this.running === mint && this.runEntry) return view("running", this.runEntry);
      if (this.#spent()) { this.queue.delete(mint); return null; }
      const q = this.queue.get(mint);
      if (q) { q.askedAt = this.now(); return view("queued", q); }
      const ms = this.now(), failedAt = this.failed.get(mint);
      if (failedAt != null && ms - failedAt < FILL_RETRY_MS) return null;
      const all = this.#pending(c);
      if (!all.length || this.#rowOf(mint).calls >= FILL_COIN_DAILY) return null;
      const pend = settled(all, this.#nowS());
      if (!pend.length) return view("waiting", span(all));
      const entry = { askedAt: ms, ...span(pend) };
      this.queue.set(mint, entry); this.stats.queued++;
      if (this.queue.size > FILL_MAX_QUEUE) {
        // The line is full: the coin asked for longest ago leaves it (its chart's next poll queues it again).
        let k = null;
        for (const [m, e] of this.queue) if (m !== mint && (k == null || e.askedAt < this.queue.get(k).askedAt)) k = m;
        this.queue.delete(k); this.stats.displaced++;
      }
      this.#pump();
      return view(this.running === mint ? "running" : "queued", entry);
    } catch (e) { this.stats.lastError = `want ${mint}: ${msg(e)}`; return null; }
  }

  // ---------------------------------------------------------------- runs
  start() {
    if (this.started) return this;
    this.started = true;
    this.#prune(); this.#beat();
    this.aliveTimer = setInterval(() => this.#beat(), FILL_ALIVE_MS); this.aliveTimer.unref?.();
    this.pruneTimer = setInterval(() => this.#prune(), FILL_PRUNE_MS); this.pruneTimer.unref?.();
    this.#pump(); return this;
  }
  /** Ends the run under way (its stored chunks stay) and every wait; nothing runs after this. */
  stop() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.aliveTimer); clearInterval(this.pruneTimer);
    if (this.started) try { this.#beat(); this.db.kvSet("fillCalls", this.budget); } catch { /* the database is closed already */ }
    this.ac.abort(new Error("stopping")); for (const r of this.idleWaiters.splice(0)) r();
  }
  /** Whether a fill runs or waits: the chart history's chain reads (lib/chart-history.mjs) share this lane and wait meanwhile. */
  busy() { return this.enabled && (this.running != null || this.queue.size > 0); }
  /** Resolves when no run is under way and none waits (tests). */
  idle() { return !this.running && (!this.queue.size || !this.started || this.stopped || !this.enabled) ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r)); }
  /**
   * The alive stamp: the oldest last notification over the streams (ms), so a stream that lags leaves the next boot's
   * gap open from its own last delivery. Not written until every stream delivered in this process: until then the old
   * stamp stands. It runs whether or not the fill is enabled, so turning it on later does not start from a stale stamp.
   */
  #beat() {
    try {
      const s = this.streams();
      if (!s.length || !s.every((x) => x?.lastNotificationAt > 0)) return;
      const at = Math.min(...s.map((x) => x.lastNotificationAt));
      this.db.kvSet("fillAlive", at); this.aliveAt = at;
    } catch { /* the next beat */ }
  }
  #prune() {
    try {
      const nowS = this.#nowS();
      if (this.#pruneGaps(nowS)) this.#saveGaps();
      this.db.fillCoinsPrune(nowS - FILL_LOOKBACK_S);
      const live = new Set(this.gaps.gaps.map((g) => g.id));
      for (const [k, v] of this.noRow) if (!live.has(v.id)) this.noRow.delete(k);
      for (const [m, at] of this.failed) if (this.now() - at >= FILL_RETRY_MS) this.failed.delete(m);
    } catch (e) { this.stats.lastError = `prune: ${msg(e)}`; }
  }
  #pause(ms) { this.pauseUntil = Math.max(this.pauseUntil, this.now() + ms); }
  #pump() {
    if (!this.enabled || !this.started || this.stopped || this.running) return;
    if (!this.queue.size) { for (const r of this.idleWaiters.splice(0)) r(); return; }
    const ms = this.now();
    if (ms < this.pauseUntil) {
      if (!this.waking) { this.waking = true; this.sleep(this.pauseUntil - ms, this.ac.signal).then(() => { this.waking = false; this.#pump(); }); }
      return;
    }
    let mint = null;
    for (const [m, e] of this.queue) if (mint == null || e.askedAt > this.queue.get(mint).askedAt) mint = m;
    this.runEntry = this.queue.get(mint); this.queue.delete(mint);
    this.running = mint; this.stats.runs++;
    this.#run(mint).catch((e) => {
      if (this.stopped || e?.aborted) return;
      if (e?.budget) {
        // Nothing runs before the next UTC day: the line is emptied (want() answers null meanwhile, so the charts stop
        // asking; a chart opened on the next day queues its coin again).
        this.stats.budgetStops++; this.queue.clear();
        this.#pause((this.budget.day + 1) * DAY_MS - this.now() + 1000);
        if (this.budgetLogged !== this.budget.day) { this.budgetLogged = this.budget.day; this.log.info?.(`fill: the day's ${this.cfg.dailyCalls} chain calls are spent; gaps are filled again tomorrow (UTC)`); }
        return;
      }
      if (e?.outage) {
        this.stats.outages++; this.#pause(FILL_OUTAGE_PAUSE_MS);
        this.stats.lastError = `${mint}: ${msg(e)}`; this.log.warn?.(`fill: ${this.stats.lastError}; runs wait ${FILL_OUTAGE_PAUSE_MS / 1000} s`);
        return;
      }
      if (e?.cap) { if (e.cap === "run") this.stats.runCaps++; else this.stats.coinCaps++; return; } // the next poll queues it again
      // Not a chain read (those are handled above): a write that failed. Not queued again for a while.
      this.#fail(mint);
      this.stats.lastError = `${mint}: ${msg(e)}`; this.log.warn?.(`fill: ${this.stats.lastError}`);
      this.#pause(FILL_OUTAGE_PAUSE_MS);
    }).finally(() => { this.running = null; this.runEntry = null; if (!this.stopped) setImmediate(() => this.#pump()); });
  }
  /**
   * One job: the coin's tracked ancestors (root first, the nearest FILL_CHAIN_MAX - 1) for exactly the gaps the coin
   * needs, then the coin. A parent filled whole prices its child exactly (#price). A cap or an outage ends the job,
   * except a parent's cap (its run's or its day's): that parent is left as it is (its gaps stay not whole, so the child
   * is priced by its own edges; the parent's own chart goes on with it) and the coin itself is still filled. A job that
   * ends with a transaction the endpoint did not answer and nothing new stored (`stuck`) puts the coin aside for
   * FILL_RETRY_MS, so a transaction the node keeps refusing is not read again on every poll.
   */
  async #run(mint) {
    const c = this.model.get(mint);
    if (!c?.tracked) return;
    this.jobRows = new Map(); this.jobEdges = new Map(); this.stuck = false;
    try {
      const own = settled(this.#pending(c), this.#nowS());
      if (!own.length) return;
      const need = new Set(own.map((g) => g.id));
      const parents = [...this.model.ancestors(mint)].reverse().filter((p) => p.tracked).slice(-(FILL_CHAIN_MAX - 1));
      for (let i = 0; i < parents.length; i++) {
        const p = parents[i], gaps = this.#pending(p, need);
        if (!gaps.length) continue;
        // The members filled after this one read their own rows of a shared transaction themselves (after their parent).
        this.jobLater = new Set([...parents.slice(i + 1), c].map((x) => x.mint));
        try { await this.#fillCoin(p, gaps); }
        catch (e) { if (e?.cap !== "coin" && e?.cap !== "run") throw e; if (e.cap === "run") this.stats.runCaps++; else this.stats.coinCaps++; }
        if (this.stopped) throw stopping();
      }
      this.jobLater = null;
      await this.#fillCoin(c, own);
      if (this.stuck) { this.stats.stuck++; this.#fail(mint); }
    } finally {
      this.jobRows = null; this.jobEdges = null; this.jobLater = null; this.row = null;
      try { this.db.kvSet("fillCalls", this.budget); } catch { /* kept in memory */ }
    }
  }
  /** The coin is not queued again for FILL_RETRY_MS. */
  #fail(mint) {
    this.failed.delete(mint); this.failed.set(mint, this.now());
    if (this.failed.size > FAILED_MAX) this.failed.delete(this.failed.keys().next().value);
  }
  /**
   * Fills `gaps` (newest first) of one coin: lists its curve and pool down through each gap (the curve too after a
   * migration: its trades from before a migration inside the gap are found that way), reads the signatures that failed
   * nowhere and have no row of the coin, and marks the gap done: whole when the listing reached the gap's start and
   * nothing was left unread (in this run or an earlier one: `partial`), cut when the listing stopped at FILL_WINDOW_SIGS.
   * A gap with a transaction the endpoint never answered stays pending (the next run lists it again and reads only what
   * is still missing; when it stored nothing new, the job is `stuck`). A child's rows held while the gap was read are
   * stored once it is marked; a run that ends inside the gap, or leaves it pending, drops them (the child's own fill
   * reads them again). The listings are merged pool first, so the oldest-first order puts a shared slot's curve
   * signatures first. A signature a run of the gap read without getting a row of the coin (no event of it, answered
   * without the transaction, too large) is not read again by a later run of the same gap (`noRow`, in memory until the
   * gap is marked): a gap that takes several runs (FILL_RUN_CALLS) moves on instead of paying for them again on every
   * run, which past about FILL_RUN_CALLS of them would store nothing new, ever.
   */
  async #fillCoin(c, gaps) {
    const row = this.#rowOf(c.mint);
    this.row = row; this.runCalls = 0;
    const states = [...new Set([c.curve, c.pool].filter((a) => typeof a === "string" && a))].map((addr) => ({ addr, cursor: null, carry: [] }));
    try {
      for (const w of gaps) {
        if (this.stopped) throw stopping();
        const lists = [];
        let reached = true;
        for (const st of states) {
          let r;
          try { r = await this.#listGap(c, st, w); }
          catch (e) { if (e?.aborted || e?.budget || e?.cap || this.ac.signal.aborted) throw e; throw Object.assign(new Error(`listing ${st.addr}: ${msg(e)}`), { outage: true }); }
          lists.push(r.sigs);
          reached &&= r.reached;
        }
        // The pool's signatures before the curve's: after the reverse below, a slot the two share (the migration's: the
        // last curve trades, the migration, the first pool trades) then reads curve first, as on chain.
        const listed = new Map();
        for (const sigs of lists.reverse()) for (const s of sigs) if (!listed.has(s.signature)) listed.set(s.signature, s);
        const cand = [], seen = this.noRow.get(`${c.mint}:${w.id}`)?.sigs;
        for (const s of listed.values()) {
          if (s.err) this.stats.sigsFailed++;
          else if (this.db.tradeHas(s.signature, c.mint)) this.stats.sigsStored++;
          else if (seen?.has(s.signature)) this.stats.sigsNoRow++;
          else cand.push(s);
        }
        // Oldest first (the listing is newest first; reversed after a stable sort, so within a slot too): the chunks are
        // stored in chain order.
        cand.sort((a, b) => (b.slot ?? 0) - (a.slot ?? 0)).reverse();
        const r = await this.#readAndStore(c, w, cand);
        if (r.errors === 0) {
          row.done.add(w.id); this.noRow.delete(`${c.mint}:${w.id}`);
          if (reached && r.unread === 0 && !row.partial.has(w.id)) row.whole.add(w.id);
          if (!reached) { row.cut++; this.stats.windowsCut++; } else this.stats.windowsDone++;
        }
        // The children's rows only once the gap is marked; with a transaction left unanswered they are dropped (the
        // child's own fill reads them, priced at this coin's price once this gap is whole).
        if (r.errors === 0) this.#storeHeld(w, r.held);
        else if (r.rows === 0) this.stuck = true;
        this.#saveRow(row);
      }
    } catch (e) {
      try { this.#saveRow(row); } catch { /* the calls counted stay in memory */ }
      throw e;
    }
  }
  /**
   * The signatures of `st.addr` inside gap `w`, continuing the descending walk `st` left at the previous (newer) gap:
   * `{ sigs, reached }`, `reached` false when FILL_WINDOW_SIGS were listed before the gap's start (cut). `st.cursor` is
   * `{ sig, time }`, the last signature of the walk and the last finite blockTime it saw (-Infinity: the address has no
   * older history); `st.carry` holds listed signatures older than the gap they were listed for (at most one page).
   *
   * A busy coin jumps: with FILL_JUMP_TRADES or more stored trades between the walk's place and the gap, the listing
   * starts right below the first stored trade after the gap (`before` = its signature), which need not touch this
   * address: the node resolves `before` through the signature's slot. Checked on mainnet on 2026-11-17
   * (api.mainnet-beta.solana.com): getSignaturesForAddress(addr, { before: <a signature of a transaction that does not
   * touch addr> }) listed addr's signatures at or below that signature's slot (those earlier in the anchor's own slot
   * included, then the lower slots), for a recent anchor, an 18 h old one, a 4-day-old one (long-term storage) and an
   * 18-day-old one. Signatures of the anchor's own slot lie past the gap's end anyway (after its margin), and the time
   * filter below keeps only those inside the gap. An anchored first page that comes back empty is either the end of the
   * address's history (a pool made after the gap: none of its signatures is that old) or a node that does not know the
   * anchor; getSignatureStatuses (searchTransactionHistory) tells them apart. Known: the address has no older history. Unknown:
   * the walk lists once more without the anchor, and stops (cut) after FILL_WINDOW_SIGS signatures above the gap, so a
   * busy address is not walked from the top on every run.
   */
  async #listGap(c, st, w) {
    const out = [], keep = [];
    for (const s of st.carry) { const t = timeOf(s); if (t == null || (t >= w.from && t <= w.to)) out.push(s); else if (t < w.from) keep.push(s); }
    st.carry = keep;
    if (st.cursor && st.cursor.time < w.from) return { sigs: out, reached: true }; // the walk went below this gap already
    let before = st.cursor?.sig ?? null, jumped = false;
    if (!st.cursor || st.cursor.time > w.to) {
      const top = Number.isFinite(st.cursor?.time) ? st.cursor.time : this.#nowS();
      if (top > w.to && this.db.tradesBetween(c.mint, w.to, top, FILL_JUMP_TRADES) >= FILL_JUMP_TRADES) {
        const a = this.db.tradeAfter(c.mint, w.to);
        if (a) { before = a.sig; jumped = true; this.stats.jumps++; }
      }
    }
    let n = out.length, above = 0, unanchored = false;
    for (let first = true; ; first = false) {
      let page = await this.#list(st.addr, before);
      if (first && jumped && !page.sigs.length && !(await this.#known(before))) {
        this.stats.jumpMisses++; before = st.cursor?.sig ?? null; unanchored = true;
        page = await this.#list(st.addr, before);
      }
      for (const s of page.sigs) {
        const t = timeOf(s);
        if (t != null && t > w.to) { above++; continue; }
        if (t == null || t >= w.from) { out.push(s); n++; } else st.carry.push(s);
      }
      const last = page.sigs[page.sigs.length - 1];
      if (last) {
        let t = null;
        for (let i = page.sigs.length - 1; i >= 0 && t == null; i--) t = timeOf(page.sigs[i]);
        st.cursor = { sig: last.signature, time: t ?? st.cursor?.time ?? Infinity };
      }
      if (page.short) { st.cursor = { sig: st.cursor?.sig ?? null, time: -Infinity }; return { sigs: out, reached: true }; }
      if (st.cursor.time < w.from) return { sigs: out, reached: true };
      if (n >= FILL_WINDOW_SIGS || (unanchored && above >= FILL_WINDOW_SIGS)) return { sigs: out, reached: false };
      before = last.signature;
    }
  }
  /** Whether the node knows signature `sig` (getSignatureStatuses over its whole history). */
  async #known(sig) {
    const r = await this.#call("getSignatureStatuses", [[sig], { searchTransactionHistory: true }], SIG_MAX_BYTES);
    return r?.value?.[0] != null;
  }
  /** One page of the address's signatures, newest first: `{ sigs, short }` (short = the listing ends here). */
  async #list(addr, before) {
    this.stats.listed++;
    const page = await this.#call("getSignaturesForAddress", [addr, { limit: FILL_PAGE, commitment: "confirmed", ...(before ? { before } : {}) }], SIG_MAX_BYTES);
    if (!Array.isArray(page)) throw new Error("getSignaturesForAddress: not a list");
    const sigs = page.filter((s) => typeof s?.signature === "string");
    return { sigs, short: page.length < FILL_PAGE || !sigs.length };
  }
  /** One chain call within the caps: the day's (`budget`), the run's (FILL_RUN_CALLS) and the coin's (FILL_COIN_DAILY). The lane holds the rate. */
  async #call(method, params, maxBytes) {
    const signal = this.ac.signal;
    if (signal.aborted) throw stopping();
    if (this.#spent()) throw Object.assign(new Error("the day's chain calls are spent"), { budget: true });
    if (this.runCalls >= FILL_RUN_CALLS) throw Object.assign(new Error("the run's calls are spent"), { cap: "run" });
    const row = this.row;
    if (row) {
      const day = this.#day();
      if (row.day !== day) { row.day = day; row.calls = 0; }
      if (row.calls >= FILL_COIN_DAILY) throw Object.assign(new Error("the coin's calls of the day are spent"), { cap: "coin" });
      row.calls++;
    }
    this.budget.used++; this.runCalls++;
    return this.rpc.call(method, params, { ...READ_OPTS, maxBytes, signal });
  }
  /**
   * Reads `cand` (oldest first) FILL_CHUNK at a time, FILL_TX_CONCURRENCY in flight, and stores each chunk in one sqlite
   * transaction: its rows (every tracked coin's, oldest first, so rowids and a wallet's arrival order follow the chain),
   * the day's calls and the coin's counters. `{ rows, unread, errors, held }`: unread = answered without the transaction
   * (or too large to fetch), or decoded incomplete (such a gap is remembered in `partial`: the rows it did give are
   * stored, so a later run skips the transaction and could not tell; other coins' rows of such a transaction are not
   * kept at all; an unread one is not read again by a later run of the gap either: `noRow`, so every unread gap is
   * `partial`); errors = never answered. Rows of the coin's children are not priced or stored here but `held`
   * (#storeHeld after the gap is marked: whole, it prices them exactly), and rows of a job member filled later are left
   * to that member's own fill. Throws `{ outage }` when
   * FILL_OUTAGE_STREAK reads in a row were not answered (that chunk is not stored), `{ budget }`, `{ cap }`, a stop, or a
   * failed write; the other read in flight then finishes, and no further call is made for the chunk.
   */
  async #readAndStore(c, w, cand) {
    const signal = this.ac.signal, row = this.row, later = this.jobLater;
    let rows = 0, unread = 0, errors = 0, streak = 0;
    const held = [];
    for (let i = 0; i < cand.length; i += FILL_CHUNK) {
      if (this.stopped) throw stopping();
      const chunk = cand.slice(i, i + FILL_CHUNK), results = new Array(chunk.length);
      let next = 0, outage = false, failure = null;
      const halted = () => signal.aborted || failure != null;
      const call = (m, p, b) => { if (failure != null) throw stopping(); return this.#call(m, p, b); };
      await Promise.all(Array.from({ length: Math.min(FILL_TX_CONCURRENCY, chunk.length) }, async () => {
        try {
          while (next < chunk.length && !outage && failure == null) {
            const k = next++, r = (results[k] = await readTxWith(call, chunk[k], { retries: FILL_TX_RETRIES, stats: this.stats, aborted: halted }));
            if (r.error) { if (++streak >= FILL_OUTAGE_STREAK) outage = true; } else if (r.answered) streak = 0;
          }
        } catch (e) { failure ??= e; }
      }));
      if (failure != null) throw failure;
      if (this.stopped) throw stopping();
      if (outage) throw Object.assign(new Error(`${streak} transactions in a row could not be read`), { outage: true });
      const found = [], noRow = [];
      let chunkUnread = 0, chunkErrors = 0;
      results.forEach((r, k) => {
        if (!r.tx) { if (r.error) chunkErrors++; else { chunkUnread++; noRow.push(chunk[k].signature); } return; }
        const d = eventsOfTx(this.model, r.tx);
        if (d.incomplete) { chunkUnread++; this.stats.txUnread++; }
        let own = false;
        if (d.inner) this.stats.txInner++;
        for (const { name, mint, idx, e } of d.events) {
          // Incomplete: only the coin's own rows (its gap is marked `partial`). Another coin's stored row would make its
          // own fill skip the transaction and mark its gap whole; left out, that fill reads it and marks its own.
          if (d.incomplete && mint !== c.mint) continue;
          const m = this.model.get(mint);
          if (!m?.tracked) continue;
          const t = tradeOfEvent(this.model, m, name, e, { sig: chunk[k].signature, slot: r.tx.slot ?? 0, idx, time: e.timestamp || r.tx.blockTime || 0 });
          if (!t) continue;
          if (mint !== c.mint && m.quoteMint === c.mint) { held.push({ t, m, pos: i + k }); continue; }
          if (mint !== c.mint && later?.has(mint)) continue;
          this.#price(t, m, w);
          found.push({ t, pos: i + k, other: mint !== c.mint });
          if (mint === c.mint) own = true;
        }
        if (!own) noRow.push(chunk[k].signature);
      });
      const { fresh } = this.#store(found, () => {
        if (row) { row.unread += chunkUnread; if (chunkUnread) row.partial.add(w.id); }
      });
      if (noRow.length) this.#noRowAdd(c.mint, w.id, noRow);
      rows += fresh; unread += chunkUnread; errors += chunkErrors;
      await tick();
    }
    return { rows, unread, errors, held };
  }
  /**
   * Stores rows read back in one sqlite transaction, oldest first as the live path would have stored them (time, slot,
   * the transaction's place among the oldest-first candidates, the event's), with the day's calls and the member's row;
   * `more` runs inside it.
   */
  #store(found, more = null) {
    const row = this.row;
    found.sort((a, b) => a.t.time - b.t.time || a.t.slot - b.t.slot || a.pos - b.pos || a.t.idx - b.t.idx);
    let fresh = 0, freshOther = 0;
    this.db.transaction(() => {
      for (const { t, other } of found) if (this.model.storeFilled(t)) { fresh++; if (other) freshOther++; }
      if (row) row.rows += fresh;
      more?.();
      this.db.kvSet("fillCalls", this.budget);
      if (row) this.db.fillCoinSave(row);
    });
    this.stats.rows += fresh; this.stats.rowsOther += freshOther;
    return { fresh, freshOther };
  }
  /** Remembers signatures of gap `id` that gave coin `mint` no row (#fillCoin skips them); at most NO_ROW_MAX gaps, the oldest go. */
  #noRowAdd(mint, id, sigs) {
    const k = `${mint}:${id}`;
    let v = this.noRow.get(k);
    if (!v) {
      v = { id, sigs: new Set() }; this.noRow.set(k, v);
      if (this.noRow.size > NO_ROW_MAX) this.noRow.delete(this.noRow.keys().next().value);
    }
    for (const s of sigs) v.sigs.add(s);
  }
  /** The held rows of the coin's children in gap `w`, priced now that the coin's gap is marked (whole: at its stored price). */
  #storeHeld(w, held) {
    if (!held.length) return 0;
    for (const { t, m } of held) this.#price(t, m, w);
    return this.#store(held.map(({ t, pos }) => ({ t, pos, other: true }))).fresh;
  }
  /**
   * The USD of a row read back: `t.priceUsd` and `t.valueUsd` from `k`, the USD of one quote unit at the trade's time,
   * with the live formulas (indexer #recordTrade). `k` is the tracked parent's stored priceUsd at that time when the
   * parent's same gap was filled whole (exact); else interpolated between the coin's own stored rows on either side of
   * the gap (rows outside the gap, so the order of a fill or a restart halfway does not matter); else, with no
   * neighbours at all, today's price of the quote; null when the neighbours carry no USD (such a coin's chart is in quote
   * units already).
   */
  #price(t, m, w) {
    let k;
    const P = m.quoteMint ? this.model.get(m.quoteMint) : null;
    if (P?.tracked && (w == null || this.#rowOf(P.mint).whole.has(w.id))) {
      const r = this.db.priceAt(P.mint, t.time);
      if (r?.priceUsd != null) { k = r.priceUsd; this.stats.priced.parent++; }
    }
    if (k === undefined) {
      const key = `${m.mint}:${w?.id ?? t.time}`;
      let edge = this.jobEdges?.get(key);
      if (!edge) {
        edge = { b: this.db.priceAt(m.mint, w ? w.from - 1 : t.time), a: this.db.priceAfterT(m.mint, w ? w.to : t.time) };
        this.jobEdges?.set(key, edge);
      }
      const { b, a } = edge;
      const kb = b && b.priceUsd != null && b.priceQuote > 0 ? b.priceUsd / b.priceQuote : null;
      const ka = a && a.priceUsd != null && a.priceQuote > 0 ? a.priceUsd / a.priceQuote : null;
      if (kb != null && ka != null) k = kb + (ka - kb) * Math.min(1, Math.max(0, (t.time - b.time) / Math.max(1, a.time - b.time)));
      else if (kb != null) k = kb;
      else if (ka != null) k = ka;
      else if (b || a) k = null;
      else { k = this.model.quoteUsdOf(m.quoteMint); this.stats.priced.now++; }
      if (kb != null || ka != null) this.stats.priced.edges++;
      else if (b || a) this.stats.priced.none++;
    }
    t.priceUsd = k != null ? t.priceQuote * k : null;
    t.valueUsd = k != null ? units(t.quoteAmount, this.model.quoteDecimals(m)) * k : null;
  }

  // ---------------------------------------------------------------- health
  snapshot() {
    this.#rollDay();
    return { enabled: this.enabled, gaps: this.gaps.gaps.length, lastGap: this.lastGap, aliveAt: this.aliveAt, queue: this.queue.size, running: this.running,
      pausedMs: Math.max(0, this.pauseUntil - this.now()), callsToday: this.budget.used, dailyCalls: this.cfg.dailyCalls,
      stats: { ...this.stats, priced: { ...this.stats.priced } } };
  }
}
