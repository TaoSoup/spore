// What a wallet bought and sold, per coin: GET /api/pnl/:wallet, GET /api/pnl/:wallet/series and GET /api/activity/:wallet.
//
// The `trades` table cannot answer that: it keeps the newest 2 000 rows per mint plus 24 h and has no
// index on the trader. So a wallet becomes TRACKED the first time its profit and loss is asked for, and
// from then on two things fill its own table (`wallet_trades`, never trimmed per mint):
//   - live: every trade the indexer stores whose trader is a tracked wallet is also written there
//     (model.recordTrade → onTrade: one Map lookup per live trade, an insert only for tracked wallets);
//   - history: once per wallet, in the background, its newest PNL_BACKFILL_TX transactions are read from
//     the chain (getSignaturesForAddress, then getTransaction each) and decoded with the live decoder,
//     with the same event numbering, so a trade both paths see is one row (wallet, sig, mint, idx).
// A row's quote amount is what the wallet paid or received, the venue's fees included (decode.mjs
// `userQuoteAmount`). Its `ord` is the place of its transaction among the wallet's transactions of one
// slot: a scan numbers them from the listing (newest first, so older = lower), the live path counts up
// in arrival order; a buy and a sell of one slot are then applied in the order the chain ran them.
//
// Bounds, all of them against one caller filling the feature for everyone:
//   - wallets: at most PNL_MAX_WALLETS. A new wallet takes the place of one that holds nothing yet (no
//     rows, history not read), else of one nobody asked for in PNL_EVICT_IDLE_S; when there is neither
//     it is refused (history.state "full") and nothing a visitor came back for is dropped. The route
//     also limits how many NEW wallets one IP may add an hour (limits.pnlnew, lib/api.mjs).
//   - rows: PNL_MAX_TRADES per wallet (the oldest go, `cut`), PNL_MAX_ROWS in all (scans stop, and a
//     wallet's new live trade pushes out its own oldest row; both set `cut`).
//   - scans: one wallet at a time, PNL_TX_CONCURRENCY transactions in flight, PNL_BACKFILL_RPS reads a
//     second on the lane handed in (index.mjs: "pnl", RPC_URL only, never the metered user endpoint),
//     at most PNL_BACKFILL_DAILY reads a UTC day (the scans wait for the next day), at most
//     PNL_MAX_QUEUE wallets in line, the most recently asked-for first: a wallet whose page is open
//     now is read before ones asked for once, and the stalest falls out of a full line (it is queued
//     again by its next request).
//   - failures: a transaction that cannot be read after PNL_TX_RETRIES more tries, or whose trades
//     neither its log nor its inner instructions give whole (tradesOfTx), counts in `unread`. PNL_OUTAGE_STREAK
//     transactions failing in a row is an outage, not a wallet's history: the scan stops where it had
//     stored (nothing is burnt as unread), every scan waits PNL_OUTAGE_PAUSE_MS, and the wallet is
//     "failed" until a later request queues it again (after PNL_RETRY_FAILED_MS, doubling per failure
//     up to PNL_RETRY_MAX_MS, never given up). Progress is stored per chunk; a restart continues at
//     the oldest signature reached.
//   - unread transactions are remembered (`pnl_unread`: at most PNL_UNREAD_MAX per wallet and
//     PNL_UNREAD_MAX_ROWS in all; past that they are only counted) and read again in the background
//     when no scan waits, through the same throttle and daily budget: PNL_UNREAD_RETRY_MS after they
//     were stored, then after 2, 4, 8... times that, PNL_UNREAD_RETRIES times (a try the endpoint did not
//     answer at all is not one of them: it waits longer each time, PNL_UNREAD_ERRORS in a row at most,
//     and the other unread ones wait PNL_OUTAGE_PAUSE_MS). One that is read gives
//     its trades (with the `ord` its place in the listing had) and the wallet's `unread` goes down;
//     one given up stays stored, so a later scan of the same transaction does not count it twice (and
//     takes it off the count if it can read it then). Wallets that counted unread transactions before
//     these were stored have nothing to try again: once, at the first start that finds them, their
//     history is queued to be read again from the newest transaction (rows already there are kept; a
//     second scan that a row cap stops gives the wallet its old count back).
//   - cut live logs: the live streams only have the log, and a node cuts a long one ("Log truncated"), so
//     a trade behind the cut is not delivered. The indexer hands every cut log's signature over
//     (onCutLog: at most PNL_CUTS_MAX are kept, in memory); whose transaction it is the log does not
//     say. So a request for a tracked wallet, at most every PNL_CUT_CHECK_MS and only when a log was cut
//     since its last check, lists the wallet's transactions since that check (one read) and reads those
//     that were cut, like a scan (inner instructions; unread ones are remembered). When signatures since
//     its last check were dropped from the full set, every transaction since then is read instead.
//   - downtime: while the server was down no live trade was kept. Every wallet tracked before a start
//     gets `gap_from` (the last minute the tracker was known alive) and its next request queues a
//     catch-up: its transactions since then are listed and read like a scan. `history.gap` is that
//     time until the catch-up is through.
//
// Not covered, by design: tokens received or sent by plain transfer are not trades; trades of coins the
// index does not track are ignored; trades older than the scan's cap are missing (`history.cut`), and
// so is a live trade the streams did not deliver while the server was up (a dropped socket); a live trade
// behind a cut log is missing until the wallet is next asked for.
import { eventsInLogs, eventsInInner, decodeEvent } from "./decode.mjs";
import { LIVE_EVENT_PROGRAMS, peekMint, peekPool } from "./indexer.mjs";
import { NATIVE_MINT } from "./sdk.mjs";
import { applyTrade, blankEntry, listed, usdNow, seriesStart, seriesApply, seriesEnd } from "./pnl.mjs";

export const PNL_DEFAULTS = { maxWallets: 5000, backfill: true, backfillTx: 1000, backfillRps: 5, maxTrades: 10_000, maxRows: 2_000_000, maxQueue: 200, dailyCalls: 100_000 };
/** A wallet's computed body is kept this long (per `since`); while its history is still being read, PNL_CACHE_BUSY_MS. */
export const PNL_CACHE_MS = 10_000;
export const PNL_CACHE_BUSY_MS = 2_000;
/** Kept bodies: at most this many wallets and this many coin entries in all (a body weighs its coins + 1; about 1 kB each). */
export const PNL_CACHE_MAX = 500;
export const PNL_CACHE_COINS = 50_000;
/** Different `since` values kept per wallet (the page asks for 1d / 7d / 30d / all). */
export const PNL_CACHE_SINCE_MAX = 4;
/** Stale bodies are dropped this often (on a request). */
export const PNL_CACHE_SWEEP_MS = 30_000;
/** `since` is rounded down to a multiple of this (seconds), so a rolling "last 24 h" is one kept body for a minute. */
export const PNL_SINCE_STEP_S = 60;
export const PNL_TX_RETRIES = 2;
export const PNL_TX_CONCURRENCY = 2;
/** Transactions per stored step of a scan: what a restart or a stop repeats at most. */
export const PNL_CHUNK = 20;
/** A failed wallet is queued again by a request this long after its failure, doubling per failure in a row up to the max. */
export const PNL_RETRY_FAILED_MS = 10 * 60_000;
export const PNL_RETRY_MAX_MS = 6 * 3_600_000;
/** This many transactions failing in a row (each after its retries) is the endpoint, not the wallet: the scan stops. */
export const PNL_OUTAGE_STREAK = 5;
/** No scan reads the chain this long after a listing failed or an outage was seen. */
export const PNL_OUTAGE_PAUSE_MS = 30_000;
/** A wallet with rows or a read history is dropped for a new one only when nobody asked for it this long (seconds). */
export const PNL_EVICT_IDLE_S = 86_400;
/** The tracker writes that it is alive this often; a catch-up starts this many seconds before the last such time. */
export const PNL_ALIVE_MS = 60_000;
export const PNL_GAP_MARGIN_S = 30;
/** The least a daily cap on chain reads goes (a smaller PNL_BACKFILL_DAILY counts as this): a day must get through whole chunks with their retries. */
export const PNL_DAILY_MIN = 200;
/** `last_seen_at` is written at most this often per wallet (seconds). */
export const PNL_SEEN_WRITE_S = 60;
/** Rows of a dropped wallet deleted per event-loop turn. */
export const PNL_PURGE_SLICE = 500;
/** Rows read and applied per event-loop turn when a body is built. */
export const PNL_SLICE = 1000;
/** A wallet over PNL_MAX_TRADES is trimmed once it is this many rows over, not on every insert. */
export const PNL_TRIM_EVERY = 100;
export const ACTIVITY_MAX = 100;
/** Unread transactions remembered per wallet, and for every wallet together; past either they are only counted. */
export const PNL_UNREAD_MAX = 200;
export const PNL_UNREAD_MAX_ROWS = 100_000;
/** An unread transaction is read again this long after it was stored, then after twice the wait before, this many times in all. */
export const PNL_UNREAD_RETRY_MS = 2 * 60_000;
export const PNL_UNREAD_RETRIES = 5;
/** Tries in a row the endpoint did not answer at all before an unread transaction is given up (the wait doubles up to PNL_RETRY_MAX_MS: some days). */
export const PNL_UNREAD_ERRORS = 20;
/** Signatures of cut live logs kept (in memory, the oldest go first). */
export const PNL_CUTS_MAX = 20_000;
/** A tracked wallet's transactions are looked through for cut ones at most this often, on a request. */
export const PNL_CUT_CHECK_MS = 60_000;
/** Signatures listed per read of that check. */
export const PNL_CUT_PAGE = 200;
/** Wallets whose series bodies are kept (each at most PNL_CACHE_SINCE_MAX windows of at most 240 points). */
export const PNL_SERIES_CACHE_MAX = 100;
/** `running` while unread transactions are read again and no wallet is named yet. */
const RETRYING = "(unread)";
const READ_OPTS = { timeoutMs: 15_000, retries: 1 };
const SIG_MAX_BYTES = 2 * 1024 * 1024, TX_MAX_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;
const SOL_MINT = NATIVE_MINT.toBase58();
const tick = () => new Promise((r) => setImmediate(r));
/** Resolves after `ms`, or as soon as `signal` aborts. */
const abortableSleep = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) return void r();
  const done = () => { clearTimeout(t); signal?.removeEventListener("abort", done); r(); };
  const t = setTimeout(done, Math.min(ms, 2 ** 31 - 1));
  signal?.addEventListener("abort", done, { once: true });
});
/** The `since` a body is computed for: whole PNL_SINCE_STEP_S, 0 = everything. */
export const sinceOf = (since) => (since > 0 ? Math.floor(since / PNL_SINCE_STEP_S) * PNL_SINCE_STEP_S : 0);
const msg = (e) => String(e?.message ?? e).slice(0, 200);

/**
 * The trades of `wallet` in one transaction as getTransaction (encoding "json") answers it: pump curve
 * TradeEvents and pump-amm Buy/SellEvents of coins the index tracks, numbered like the live path does
 * (the event's position among every tracked event of the transaction), the quote amount being what the
 * wallet paid or received with the venue's fees. `truncated`: the node cut the log. A log that is cut,
 * missing, or holds an event of a tracked coin that does not decode is not the last word: both programs
 * also emit every event as an inner instruction to themselves (decode.mjs eventsInInner), and the events
 * are then read from there, numbered the same way, so a row the live stream stored from the part of the
 * log it did get is the same row (`inner: true` marks an answer read this way). `incomplete`: trades of
 * the wallet may still be missing (neither a whole log nor the inner instructions, or an event of a
 * tracked coin that does not decode on either path, such as an old layout), so the caller counts the
 * transaction as unread. A transaction that failed on chain has no trades and is complete.
 */
export function tradesOfTx(model, wallet, sig, tx) {
  if (!tx?.meta) return { rows: [], truncated: false, incomplete: !!tx };
  if (tx.meta.err) return { rows: [], truncated: false, incomplete: false };
  const logs = Array.isArray(tx.meta.logMessages) ? tx.meta.logMessages : null; // null: the node kept no log for it
  const logEvents = logs ? eventsInLogs(logs, LIVE_EVENT_PROGRAMS) : [];
  const fromLog = rowsOfEvents(model, wallet, sig, tx, logEvents);
  const truncated = !!logs && logs.some((l) => l === "Log truncated");
  if (logs && !truncated && !fromLog.undecoded) return { rows: fromLog.rows, truncated: false, incomplete: false };
  // The log does not tell everything: the same events are in the inner instructions, which the node does not cut. They
  // are trusted only when they hold at least every event the log showed (an event only ever logged would be missed).
  const innerEvents = eventsInInner(tx, LIVE_EVENT_PROGRAMS);
  if (innerEvents && innerEvents.length >= logEvents.length) {
    const fromInner = rowsOfEvents(model, wallet, sig, tx, innerEvents);
    return { rows: fromInner.rows, truncated, incomplete: fromInner.undecoded > 0, inner: true };
  }
  return { rows: fromLog.rows, truncated, incomplete: true };
}
/** The wallet's rows among a transaction's tracked events (eventsInLogs or eventsInInner: the event's place is its `idx`), and how many events of tracked coins did not decode. */
function rowsOfEvents(model, wallet, sig, tx, events) {
  const rows = [];
  let undecoded = 0;
  const at = (e) => e.timestamp || tx.blockTime || 0, slot = tx.slot ?? 0;
  events.forEach(({ name, data, ix }, idx) => {
    try {
      if (name === "TradeEvent") {
        const mint = peekMint(data);
        if (!model.get(mint)?.tracked) return;
        const e = decodeEvent(name, data);
        if (e.user === wallet) rows.push({ sig, mint, idx, slot, time: at(e), isBuy: !!e.isBuy, baseAmount: e.tokenAmount, quoteAmount: e.userQuoteAmount ?? e.quoteAmount });
      } else if (name === "BuyEvent" || name === "SellEvent") {
        const mint = model.pools.get(peekPool(data));
        if (!mint || !model.get(mint)?.tracked) return;
        const e = decodeEvent(name, data, ix);
        if (e.user === wallet) rows.push({ sig, mint, idx, slot, time: at(e), isBuy: !!e.isBuy, baseAmount: e.baseAmount, quoteAmount: e.userQuoteAmount ?? e.quoteAmount });
      }
    } catch { undecoded++; } // whose trade it was cannot be told: the transaction is the wallet's, so it counts as unread
  });
  return { rows, undecoded };
}

export class PnlTracker {
  /**
   * `rpc`: an object with `call(method, params, opts)` (the "pnl" lane); without one, or with
   * `cfg.backfill` false, wallets are tracked from now on and no history is read (state "off").
   * `sleep(ms, signal)` and `now()` (ms) are the throttle's clock; tests hand in their own.
   */
  constructor({ model, rpc = null, cfg = {}, now = Date.now, log = console, sleep = abortableSleep }) {
    this.model = model; this.db = model.db; this.rpc = rpc; this.now = now; this.log = log; this.sleep = sleep;
    this.cfg = { ...PNL_DEFAULTS, ...cfg };
    if (this.cfg.dailyCalls > 0 && this.cfg.dailyCalls < PNL_DAILY_MIN) this.cfg.dailyCalls = PNL_DAILY_MIN;
    this.enabled = !!rpc && this.cfg.backfill !== false;
    this.wallets = new Map();   // wallet → its pnl_wallets row (+ `seen`, ms, in memory), kept in step with the table
    this.queue = [];            // wallets waiting for a scan or a catch-up: at most cfg.maxQueue, the most recently asked-for goes first
    this.running = null;        // the wallet being read
    this.cache = new Map();     // wallet → Map<since, { at, ttl, body, promise, weight }>
    this.cacheCoins = 0;        // the weight of every kept body
    this.sweptAt = 0;
    this.purging = new Map();   // wallet → rows of a dropped wallet still being deleted in slices
    this.rows = 0;              // rows in wallet_trades (the sum of the wallets' counts)
    this.ord = 0;               // the last `ord` a live trade got
    this.nextAt = 0;            // the throttle: when the next chain read may start
    this.pauseUntil = 0;        // no scan before this (an outage, or the day's reads are spent)
    this.waking = false;
    this.ac = new AbortController();
    this.started = false; this.stopped = false; this.idleWaiters = []; this.aliveTimer = null;
    this.stats = { registered: 0, evicted: 0, refused: 0, displaced: 0, liveRows: 0, liveErrors: 0, backfillRows: 0, calls: 0, txRead: 0, txRetries: 0, txUnread: 0, txInner: 0, unreadTries: 0, unreadRead: 0, unreadGivenUp: 0, unreadErrors: 0, rescans: 0, cutLogs: 0, cutChecks: 0, cutTx: 0, done: 0, failed: 0, outages: 0, caughtUp: 0, builds: 0, seriesBuilds: 0, hits: 0, shared: 0, lastError: null };
    this.seriesCache = new Map(); // wallet → Map<since, { at, ttl, body, promise }>
    this.unreadRows = this.db.pnlUnreadCount(); // rows in pnl_unread
    this.retryAt = Infinity;    // when the next unread transaction is due (ms)
    this.retryTimer = null;
    this.bornS = this.#nowS();  // cut logs are known from here on (what came before is a downtime's gap)
    this.cuts = new Map();      // signature of a live log the node cut → when it came (s), oldest first, at most PNL_CUTS_MAX
    this.cutsFrom = 0;          // signatures that came at or before this time (s) may have been dropped from `cuts`
    this.cutLast = -Infinity;   // when the last cut log came (s)
    this.healing = new Map(Object.entries(this.db.kvGet("pnlUnreadWas", null) ?? {})); // wallet → its unread count before the one-time second scan
    for (const w of this.db.pnlWallets()) { w.seen = w.lastSeenAt * 1000; this.wallets.set(w.wallet, w); this.rows += w.rows; }
    // The chain reads of the UTC day so far (kept across restarts).
    const spent = this.db.kvGet("pnlCalls", null), day = Math.floor(this.now() / DAY_MS);
    this.budget = spent && spent.day === day && Number.isFinite(spent.used) ? { day, used: spent.used } : { day, used: 0 };
    // Trades made since the tracker was last known alive were not kept: each wallet tracked by then has a gap from there.
    const alive = this.db.kvGet("pnlAlive", null);
    if (Number.isFinite(alive) && this.wallets.size) {
      this.db.pnlWalletsGap(alive);
      for (const w of this.wallets.values()) if (w.addedAt <= alive) w.gapFrom = Math.min(w.gapFrom ?? alive, alive);
    }
    // Rows of wallets dropped just before the last stop: finished now (a list of at most a few wallets).
    for (const wallet of this.db.kvGet("pnlPurge", [])) if (!this.wallets.has(wallet)) this.purging.set(wallet, true);
    if (this.purging.size) this.#purge();
    if (this.enabled) {
      // Wallets that count unread transactions from before those were remembered: their history is read once more.
      if (!this.db.kvGet("pnlUnreadHealed", false)) {
        const names = this.db.pnlWalletsUnstored();
        this.db.transaction(() => {
          for (const name of names) {
            const w = this.wallets.get(name);
            // A wallet at its row cap would read nothing: its count stays as it is (its history is cut anyway).
            if (!w || w.rows >= this.cfg.maxTrades) continue;
            this.healing.set(name, w.unread); // given back if a row cap stops the second scan (#scan)
            w.unread = 0; w.scanned = 0; w.total = 0; w.beforeSig = null; w.state = "queued"; w.attempts = 0; w.error = null;
            this.#save(w); this.stats.rescans++;
          }
          this.db.kvSet("pnlUnreadWas", Object.fromEntries(this.healing));
          this.db.kvSet("pnlUnreadHealed", true);
        });
        if (this.stats.rescans) this.log.info?.(`pnl: ${this.stats.rescans} wallets with unread transactions are read again`);
      }
      this.retryAt = this.db.pnlUnreadNext() ?? Infinity;
      const waiting = [...this.wallets.values()].filter((w) => w.state === "running" || w.state === "queued").sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || b.seen - a.seen || a.addedAt - b.addedAt);
      for (const w of waiting.slice(0, this.cfg.maxQueue)) this.queue.push(w);
    }
    model.walletTrades = this; // the live hook (model.recordTrade)
  }
  #nowS() { return Math.floor(this.now() / 1000); }
  #save(w) { this.db.pnlWalletSave(w); }

  // ---------------------------------------------------------------- tracked wallets
  /** Whether the wallet is tracked already (the route limits how many new ones an IP may add). */
  tracks(wallet) { return this.wallets.has(wallet); }
  /**
   * The wallet's row, made (and its history scan queued) on first sight; `last_seen_at` moves forward.
   * Null when the set is full and no wallet may be dropped for it.
   */
  register(wallet) {
    const ms = this.now(), s = Math.floor(ms / 1000);
    let w = this.wallets.get(wallet);
    if (w) {
      w.seen = ms;
      if (s - w.lastSeenAt >= PNL_SEEN_WRITE_S) { w.lastSeenAt = s; this.db.pnlWalletSeen(wallet, s); }
      if (this.enabled) this.#requeue(w, ms);
      return w;
    }
    while (this.wallets.size >= this.cfg.maxWallets) {
      const old = this.#victim(ms);
      if (!old) { this.stats.refused++; return null; }
      this.#evict(old);
    }
    // The row table is full: a wallet nobody asked for in a day gives its rows back.
    if (this.rows >= this.cfg.maxRows) { const old = this.#victim(ms, true); if (old) this.#evict(old); }
    // A wallet dropped a moment ago whose rows are still being deleted: the rest goes now, so none of its new rows is taken for an old one.
    if (this.purging.has(wallet)) { this.db.pnlWalletDrop(wallet); this.purging.delete(wallet); this.db.kvSet("pnlPurge", [...this.purging.keys()]); }
    w = { wallet, addedAt: s, lastSeenAt: s, state: "queued", beforeSig: null, oldestTime: null, scanned: 0, total: 0, unread: 0, cut: false, rows: 0, attempts: 0, failedAt: 0, error: null, gapFrom: null, seen: ms };
    this.db.pnlWalletAdd(wallet, s, w.state);
    this.wallets.set(wallet, w);
    this.stats.registered++;
    if (this.enabled) this.#enqueue(w);
    return w;
  }
  /** A request for a tracked wallet puts it (back) in line when something of it is still to read. */
  #requeue(w, ms) {
    if (this.running === w.wallet) return;
    if (w.state === "failed") {
      if (ms - w.failedAt * 1000 < Math.min(PNL_RETRY_MAX_MS, PNL_RETRY_FAILED_MS * 2 ** Math.max(0, Math.min(10, w.attempts - 1)))) return;
      w.state = "queued"; this.#save(w); this.#uncache(w.wallet);
    } else if (w.state === "done") {
      if (w.gapFrom != null ? ms - (w.gapTried ?? -Infinity) < PNL_RETRY_FAILED_MS : !this.#cutDue(w, ms)) return;
    }
    this.#enqueue(w);
  }
  #enqueue(w) {
    if (!this.queue.includes(w)) {
      this.queue.push(w);
      if (this.queue.length > this.cfg.maxQueue) {
        // The line is full: the wallet asked for longest ago leaves it (still tracked; its next request queues it again).
        let k = -1;
        for (let i = 0; i < this.queue.length; i++) if (this.queue[i].state !== "running" && (k < 0 || this.queue[i].seen < this.queue[k].seen)) k = i;
        this.queue.splice(k < 0 ? 0 : k, 1); this.stats.displaced++;
      }
    }
    this.#pump();
  }
  /** The next wallet to read: one a stopped process was in the middle of, else the most recently asked-for. */
  #next() {
    let k = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i], b = this.queue[k];
      if ((a.state === "running") !== (b.state === "running") ? a.state === "running" : a.seen > b.seen) k = i;
    }
    return this.queue.splice(k, 1)[0];
  }
  /**
   * The wallet a new one may take the place of: the least recently asked-for one that holds nothing yet (no rows, history
   * not read), else the least recently asked-for one nobody came for in PNL_EVICT_IDLE_S. Null when there is none: wallets
   * with a history that someone looked at today are never dropped for a newcomer. `withRows`: only the second kind, and
   * only one that frees rows. The wallet being read is never taken.
   */
  #victim(ms, withRows = false) {
    let empty = null, idle = null;
    for (const w of this.wallets.values()) {
      if (w.wallet === this.running) continue;
      if (!w.rows && w.state !== "done") { if (!empty || w.seen < empty.seen || (w.seen === empty.seen && w.addedAt < empty.addedAt)) empty = w; }
      else if (ms - w.seen >= PNL_EVICT_IDLE_S * 1000 && (!withRows || w.rows > 0) && (!idle || w.seen < idle.seen || (w.seen === idle.seen && w.addedAt < idle.addedAt))) idle = w;
    }
    return withRows ? idle : empty ?? idle;
  }
  /** Drops a wallet; its trades are deleted in slices. */
  #evict(old) {
    this.wallets.delete(old.wallet); this.#uncache(old.wallet);
    const i = this.queue.indexOf(old); if (i >= 0) this.queue.splice(i, 1);
    this.rows -= old.rows; this.stats.evicted++;
    this.purging.set(old.wallet, true);
    const healed = this.healing.delete(old.wallet);
    this.db.transaction(() => { this.db.q.pnlWalletDelete.run(old.wallet); if (healed) this.db.kvSet("pnlUnreadWas", Object.fromEntries(this.healing)); this.unreadRows -= this.db.pnlUnreadDrop(old.wallet); this.db.kvSet("pnlPurge", [...this.purging.keys()]); });
    this.#purge();
  }
  /** Deletes the rows of dropped wallets, PNL_PURGE_SLICE per event-loop turn. */
  #purge() {
    if (this.purgeRun) return;
    this.purgeRun = (async () => {
      await tick(); // not in the turn of the request that dropped the wallet
      while (this.purging.size && !this.stopped) {
        const wallet = this.purging.keys().next().value;
        const n = this.db.walletTradesTrim(wallet, PNL_PURGE_SLICE);
        if (n < PNL_PURGE_SLICE && this.purging.has(wallet)) { this.purging.delete(wallet); this.db.kvSet("pnlPurge", [...this.purging.keys()]); }
        await tick();
      }
    })().catch((e) => { this.stats.lastError = `purge: ${e.message}`; }).finally(() => { this.purgeRun = null; });
  }

  // ---------------------------------------------------------------- live
  /**
   * A trade the indexer just stored (or was handed again by the other stream). Costs one Map lookup
   * when the trader is not tracked. Never throws: the live path does not depend on this table.
   */
  onTrade(t) {
    const w = this.wallets.get(t.user);
    if (!w) return false;
    try {
      if (!this.model.get(t.mint)?.tracked) return false;
      this.ord = Math.max(this.ord + 1, this.now() * 1000); // arrival order, above every scan's (negative) numbering
      if (!this.db.insertWalletTrade(w.wallet, { sig: t.sig, mint: t.mint, idx: t.idx, slot: t.slot, time: t.time, isBuy: t.isBuy, baseAmount: t.baseAmount, quoteAmount: t.userQuoteAmount ?? t.quoteAmount, ord: this.ord })) return false;
      w.rows++; this.rows++; this.stats.liveRows++;
      // Every wallet together is at the cap: this wallet's oldest row makes room for its newest.
      if (this.rows > this.cfg.maxRows) { const n = this.db.walletTradesTrim(w.wallet, this.rows - this.cfg.maxRows); w.rows -= n; this.rows -= n; w.cut = true; }
      this.#trim(w);
      this.db.pnlWalletRows(w.wallet, w.rows, w.cut);
      this.#uncache(w.wallet);
      return true;
    } catch (e) { this.stats.liveErrors++; this.stats.lastError = `live: ${e.message}`; return false; }
  }
  /**
   * A live log the node cut (indexer onLogs, either stream): a trade of a tracked wallet may sit behind the cut, and the
   * log does not say whose transaction it is. The signature is kept for the wallets' next check (#cutCheck). One Map
   * write; nothing is kept while no wallet is tracked or no history is read.
   */
  onCutLog(sig) {
    if (!this.enabled || !this.wallets.size || typeof sig !== "string" || this.cuts.has(sig)) return;
    const s = this.#nowS();
    this.cuts.set(sig, s); this.cutLast = s; this.stats.cutLogs++;
    if (this.cuts.size > PNL_CUTS_MAX) { const [old, at] = this.cuts.entries().next().value; this.cuts.delete(old); this.cutsFrom = at; }
  }
  /** The time (s) up to which the wallet's transactions were looked through for cut logs: its last check, else since it is tracked by this process. */
  #cutSince(w) { return w.cutChecked ?? Math.max(this.bornS, w.addedAt); }
  /** Whether a log was cut since the wallet's last check (less the margin a listing may lag) and that check is not too recent. */
  #cutDue(w, ms) { return this.cutLast >= this.#cutSince(w) - PNL_GAP_MARGIN_S && ms - (w.cutTried ?? -Infinity) >= PNL_CUT_CHECK_MS; }
  /** Over the per-wallet cap by a batch: the oldest rows go and the history counts as cut. */
  #trim(w) {
    if (w.rows < this.cfg.maxTrades + PNL_TRIM_EVERY) return;
    const n = this.db.walletTradesTrim(w.wallet, w.rows - this.cfg.maxTrades);
    w.rows -= n; this.rows -= n; w.cut = true;
  }

  // ---------------------------------------------------------------- history scan
  start() {
    this.started = true;
    // Known alive: what a later start measures the downtime from.
    const beat = () => { try { this.db.kvSet("pnlAlive", this.#nowS()); } catch { /* the next beat */ } };
    beat(); this.aliveTimer = setInterval(beat, PNL_ALIVE_MS); this.aliveTimer.unref?.();
    this.#pump(); return this;
  }
  /** Ends the scan under way (its stored progress stays) and every wait; nothing runs after this. */
  stop() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.aliveTimer); clearTimeout(this.retryTimer);
    if (this.started) try { this.db.kvSet("pnlAlive", this.#nowS()); this.db.kvSet("pnlCalls", this.budget); } catch { /* the database is closed already */ }
    this.ac.abort(new Error("stopping")); for (const r of this.idleWaiters.splice(0)) r();
  }
  /** Resolves when no scan runs and none waits (tests). */
  idle() { return !this.running && (!this.queue.length || !this.started || this.stopped) ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r)); }
  #pause(ms) { this.pauseUntil = Math.max(this.pauseUntil, this.now() + ms); }
  #pump() {
    if (!this.enabled || !this.started || this.stopped || this.running) return;
    const ms = this.now();
    // Unread transactions are read again only when no scan waits.
    const retry = !this.queue.length && this.retryAt <= ms;
    if (!this.queue.length && !retry) { for (const r of this.idleWaiters.splice(0)) r(); return void this.#arm(); }
    if (ms < this.pauseUntil) {
      if (!this.waking) { this.waking = true; this.sleep(this.pauseUntil - ms, this.ac.signal).then(() => { this.waking = false; this.#pump(); }); }
      return;
    }
    if (retry) {
      this.running = RETRYING;
      this.#retryDue().catch((e) => {
        if (this.stopped) return;
        this.stats.lastError = `unread: ${msg(e).slice(0, 160)}`; this.log.warn?.(`pnl: ${this.stats.lastError}`);
        this.#pause(PNL_OUTAGE_PAUSE_MS); // a write failed: not again at once
      }).finally(() => {
        this.running = null;
        if (this.stopped) return;
        try { this.retryAt = this.db.pnlUnreadNext() ?? Infinity; } catch { this.retryAt = this.now() + PNL_OUTAGE_PAUSE_MS; }
        setImmediate(() => this.#pump());
      });
      return;
    }
    const w = this.#next();
    if (this.wallets.get(w.wallet) !== w) return void this.#pump();
    this.running = w.wallet;
    this.#work(w).catch((e) => {
      // Not a chain read (those are handled inside): a write that failed. The wallet is left "failed" and asked again later.
      this.stats.lastError = `scan ${w.wallet}: ${msg(e).slice(0, 160)}`; this.log.warn?.(`pnl: ${this.stats.lastError}`);
      if (this.stopped || this.wallets.get(w.wallet) !== w) return;
      this.#fail(w, e);
    })
      .finally(() => { this.running = null; setImmediate(() => this.#pump()); });
  }
  /** Looks for work now (a scan in line, an unread transaction that is due) instead of at the next timer. */
  wake() { this.#pump(); }
  /** One timer for the next unread transaction that is due. */
  #arm() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    if (!Number.isFinite(this.retryAt) || this.stopped) return;
    this.retryTimer = setTimeout(() => this.#pump(), Math.max(0, Math.min(this.retryAt - this.now(), 2 ** 31 - 1)));
    this.retryTimer.unref?.();
  }
  /**
   * Reads the unread transactions that are due again, at most PNL_CHUNK of them, one at a time through the throttle and
   * the day's budget. A scan that gets in line goes first: the rest waits. One whose wallet is no longer tracked is
   * forgotten.
   */
  async #retryDue() {
    for (const u of this.db.pnlUnreadDue(this.now(), PNL_CHUNK)) {
      if (this.stopped || this.queue.length) return;
      const w = this.wallets.get(u.wallet);
      if (!w) { if (this.db.pnlUnreadDelete(u.wallet, u.sig)) this.unreadRows--; continue; }
      this.running = w.wallet;
      let r;
      try { this.stats.unreadTries++; r = await this.#readTx(w, { signature: u.sig }); }
      catch (e) {
        if (this.stopped || this.ac.signal.aborted) return;
        if (!e?.budget) throw e;
        // The day's reads are spent: the unread ones wait for the next UTC day like the scans.
        this.#pause((this.budget.day + 1) * DAY_MS - this.now() + 1000);
        try { this.db.kvSet("pnlCalls", this.budget); } catch { /* kept in memory */ }
        return;
      }
      if (this.stopped) return;
      if (this.wallets.get(u.wallet) !== w) continue; // dropped meanwhile, its unread rows with it
      this.#storeRetry(w, u, r);
      // The endpoint did not answer: the others that are due wait like the scans do in an outage.
      if (r.error) { this.stats.unreadErrors++; this.#pause(PNL_OUTAGE_PAUSE_MS); return; }
      await tick();
    }
  }
  /** What one more try of an unread transaction gave: its trades and one unread less, or the next (longer) wait. */
  #storeRetry(w, u, r) {
    const was = { ...w }, rows = this.rows, unreadRows = this.unreadRows, stats = { ...this.stats };
    try {
      this.db.transaction(() => {
        for (const t of r.rows) {
          if (this.rows >= this.cfg.maxRows) w.cut = true; // read, but there is no room for it: missing like history past a cap
          else if (this.db.insertWalletTrade(w.wallet, { ...t, ord: u.ord })) { w.rows++; this.rows++; this.stats.backfillRows++; }
        }
        if (r.error) {
          // Every try threw (the node is down or limits us): not a try of the transaction. It waits longer each time.
          const errors = u.errors + 1, given = errors >= PNL_UNREAD_ERRORS;
          this.db.pnlUnreadTried(u.wallet, u.sig, u.attempts, given ? null : this.now() + Math.min(PNL_RETRY_MAX_MS, PNL_UNREAD_RETRY_MS * 2 ** Math.min(20, u.attempts + errors)), errors);
          if (given) this.stats.unreadGivenUp++;
        } else if (!r.unread) {
          if (this.db.pnlUnreadDelete(u.wallet, u.sig)) this.unreadRows--;
          w.unread = Math.max(0, w.unread - 1); this.stats.unreadRead++;
        } else {
          const attempts = u.attempts + 1, given = attempts >= PNL_UNREAD_RETRIES;
          this.db.pnlUnreadTried(u.wallet, u.sig, attempts, given ? null : this.now() + PNL_UNREAD_RETRY_MS * 2 ** attempts);
          if (given) this.stats.unreadGivenUp++;
        }
        this.#trim(w);
        this.#save(w); this.db.kvSet("pnlCalls", this.budget);
      });
    } catch (e) { Object.assign(w, was); this.rows = rows; this.unreadRows = unreadRows; Object.assign(this.stats, stats); throw e; }
    this.#uncache(w.wallet);
  }
  /** The history first, then whatever a downtime left open. */
  async #work(w) {
    const fresh = w.state !== "done";
    if (fresh && !(await this.#scan(w))) return;
    if (this.stopped || this.wallets.get(w.wallet) !== w) return;
    if (w.gapFrom != null) await this.#catchUp(w);
    else if (!fresh && this.#cutDue(w, this.now())) await this.#cutCheck(w);
  }
  #fail(w, e) {
    w.state = "failed"; w.attempts++; w.failedAt = this.#nowS(); w.error = msg(e); this.stats.failed++;
    try { this.#save(w); } catch { /* the same failure again */ }
    this.#uncache(w.wallet);
  }
  /** The day's reads are spent: every scan waits for the next UTC day, and this wallet goes back in line. */
  #overBudget(w) {
    this.#pause((this.budget.day + 1) * DAY_MS - this.now() + 1000);
    if (w.state !== "done") { w.state = "queued"; this.#save(w); this.#uncache(w.wallet); }
    if (!this.queue.includes(w)) this.queue.push(w);
    try { this.db.kvSet("pnlCalls", this.budget); } catch { /* kept in memory */ }
    this.log.info?.(`pnl: the day's ${this.cfg.dailyCalls} chain reads are spent; the scans go on tomorrow (UTC)`);
  }
  /** One chain read, after its turn in the throttle (at most PNL_BACKFILL_RPS starts a second) and within the day's budget. */
  async #call(method, params, maxBytes) {
    const signal = this.ac.signal, t = this.now(), at = Math.max(t, this.nextAt);
    this.nextAt = at + 1000 / this.cfg.backfillRps;
    if (at > t) await this.sleep(at - t, signal);
    if (signal.aborted) throw Object.assign(new Error("stopping"), { aborted: true });
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.budget.day) this.budget = { day, used: 0 };
    if (this.cfg.dailyCalls > 0 && this.budget.used >= this.cfg.dailyCalls) throw Object.assign(new Error("the day's chain reads are spent"), { budget: true });
    this.budget.used++; this.stats.calls++;
    return this.rpc.call(method, params, { ...READ_OPTS, maxBytes, signal });
  }
  /** One page of the wallet's signatures, newest first: `{ sigs, short }` (short = the listing ends here). */
  async #list(wallet, limit, before) {
    const page = await this.#call("getSignaturesForAddress", [wallet, { limit, commitment: "confirmed", ...(before ? { before } : {}) }], SIG_MAX_BYTES);
    if (!Array.isArray(page)) throw new Error("getSignaturesForAddress: not a list");
    const sigs = page.filter((s) => typeof s?.signature === "string");
    return { sigs, short: page.length < limit || !sigs.length };
  }
  /** The one-time history scan; true when it is through (state "done"). */
  async #scan(w) {
    const gone = () => this.stopped || this.wallets.get(w.wallet) !== w;
    w.state = "running";
    if (!w.beforeSig) { w.gapFrom = null; w.cutChecked = this.#nowS(); } // read from the newest transaction on: nothing a downtime or a cut log could have left open
    this.#save(w);
    let sigs = [], more = false;
    try {
      // The signatures still to read, newest first, from where the last run stopped.
      const remaining = Math.max(0, this.cfg.backfillTx - w.scanned);
      let before = w.beforeSig, exhausted = false;
      while (sigs.length < remaining) {
        const page = await this.#list(w.wallet, Math.min(1000, remaining - sigs.length), before);
        sigs.push(...page.sigs);
        if (page.short) { exhausted = true; break; }
        before = page.sigs[page.sigs.length - 1].signature;
      }
      // The cap was reached: is there anything older? Not knowing counts as cut.
      if (!exhausted && before) {
        try { more = (await this.#list(w.wallet, 1, before)).sigs.length > 0; }
        catch (e) { if (this.ac.signal.aborted || e?.budget) throw e; more = true; }
      }
    } catch (e) {
      if (gone()) return false;
      if (e?.budget) { this.#overBudget(w); return false; }
      this.#fail(w, e); this.#pause(PNL_OUTAGE_PAUSE_MS);
      this.log.warn?.(`pnl: ${w.wallet}: history not listed (${w.error}); failure ${w.attempts}`);
      return false;
    }
    if (gone()) return false;
    w.total = w.scanned + sigs.length; this.#save(w);
    let end;
    try { end = await this.#readSigs(w, sigs, true); }
    catch (e) {
      if (gone()) return false;
      if (e?.budget) { this.#overBudget(w); return false; }
      if (!e?.outage) throw e;
      this.stats.outages++; this.#fail(w, e); this.#pause(PNL_OUTAGE_PAUSE_MS);
      this.log.warn?.(`pnl: ${w.wallet}: the endpoint does not answer; the scan stops at ${w.scanned} of ${w.total} and is asked again later`);
      return false;
    }
    if (end === "gone") return false;
    w.state = "done"; w.cut = w.cut || more || end === "full"; w.error = null; w.attempts = 0;
    // The one-time second scan of a wallet that counted unread transactions: when a row cap stopped it, what it did
    // not get to is still unread, so the count is not lower than it was.
    const was = this.healing.get(w.wallet);
    if (was != null) {
      if (end === "full") w.unread = Math.max(w.unread, was);
      this.healing.delete(w.wallet);
      this.db.transaction(() => { this.#save(w); this.db.kvSet("pnlUnreadWas", Object.fromEntries(this.healing)); });
    } else this.#save(w);
    this.#uncache(w.wallet); this.stats.done++;
    this.log.info?.(`pnl: ${w.wallet}: ${w.scanned} transactions read, ${w.rows} trades${w.cut ? ", older history cut" : ""}${w.unread ? `, ${w.unread} unread` : ""}`);
    return true;
  }
  /**
   * The wallet's transactions since the tracker was last known alive before a start (`gapFrom`), listed from the newest
   * down to that time and read like a scan. Capped like one (more than PNL_BACKFILL_TX of them leaves the history cut).
   * Nothing is stored about how far it got: a restart or a failure repeats it, and rows already there are left alone.
   */
  async #catchUp(w) {
    const gone = () => this.stopped || this.wallets.get(w.wallet) !== w;
    const from = w.gapFrom - PNL_GAP_MARGIN_S, cap = this.cfg.backfillTx, sigs = [], startS = this.#nowS();
    try {
      let before = null, reached = false;
      while (!reached && sigs.length < cap) {
        const page = await this.#list(w.wallet, Math.min(1000, cap - sigs.length), before);
        for (const s of page.sigs) { if (Number.isFinite(s.blockTime) && s.blockTime < from) { reached = true; break; } sigs.push(s); }
        if (page.short) reached = true; else before = page.sigs[page.sigs.length - 1].signature;
      }
      const end = await this.#readSigs(w, sigs, false);
      if (end === "gone") return;
      w.gapFrom = null; w.gapTried = undefined; if (!reached || end === "full") w.cut = true;
      if (reached) w.cutChecked = Math.max(this.#cutSince(w), startS); // every transaction up to its start was read, the cut ones with them
      this.#save(w); this.#uncache(w.wallet); this.stats.caughtUp++;
    } catch (e) {
      if (gone()) return;
      if (e?.budget) return void this.#overBudget(w);
      if (e?.outage) this.stats.outages++;
      w.gapTried = this.now(); this.#pause(PNL_OUTAGE_PAUSE_MS);
      this.stats.lastError = `catch-up ${w.wallet}: ${msg(e).slice(0, 160)}`; this.log.warn?.(`pnl: ${this.stats.lastError}`);
    }
  }
  /**
   * The wallet's transactions whose live log was cut since its last check: its signatures since then are listed (newest
   * first, PNL_CUT_PAGE a read, down to that time less a margin) and those the streams reported as cut (`cuts`) are read
   * like a scan, from their inner instructions. When signatures since the last check were dropped from the full set,
   * which ones were cut is not known and every transaction since then is read. Capped like a catch-up (more than
   * PNL_BACKFILL_TX listed leaves the history cut). A failure leaves the check where it was; it is tried again by a
   * request PNL_CUT_CHECK_MS later.
   */
  async #cutCheck(w) {
    const gone = () => this.stopped || this.wallets.get(w.wallet) !== w;
    const startS = this.#nowS(), from = this.#cutSince(w) - PNL_GAP_MARGIN_S, cap = this.cfg.backfillTx, listed = [];
    w.cutTried = this.now();
    try {
      let before = null, reached = false;
      while (!reached && listed.length < cap) {
        const page = await this.#list(w.wallet, Math.min(PNL_CUT_PAGE, cap - listed.length), before);
        for (const s of page.sigs) { if (Number.isFinite(s.blockTime) && s.blockTime < from) { reached = true; break; } listed.push(s); }
        if (page.short) reached = true; else before = page.sigs[page.sigs.length - 1].signature;
      }
      if (gone()) return;
      const all = this.cutsFrom >= from; // told now, after the listing: signatures may have been dropped meanwhile
      const sigs = listed.filter((s) => !s.err && (all || this.cuts.has(s.signature)));
      this.stats.cutTx += sigs.length;
      const end = await this.#readSigs(w, sigs, false);
      if (end === "gone") return;
      w.cutChecked = startS; this.stats.cutChecks++;
      if ((!reached || end === "full") && !w.cut) { w.cut = true; this.#save(w); this.#uncache(w.wallet); }
    } catch (e) {
      if (gone()) return;
      if (e?.budget) return void this.#overBudget(w);
      if (e?.outage) this.stats.outages++;
      this.#pause(PNL_OUTAGE_PAUSE_MS);
      this.stats.lastError = `cut logs ${w.wallet}: ${msg(e).slice(0, 160)}`; this.log.warn?.(`pnl: ${this.stats.lastError}`);
    }
  }
  /**
   * Reads `sigs` (newest first) PNL_CHUNK at a time and stores each chunk in one transaction: its rows, the unread
   * count and, for the history scan (`history`), the place the scan reached. "ok", "full" (a row cap was reached) or
   * "gone" (stopped, or the wallet was dropped). Throws `{ outage }` when PNL_OUTAGE_STREAK transactions in a row could
   * not be read (the chunk under way is not stored, so they are read again later), `{ budget }`, or a failed write.
   */
  async #readSigs(w, sigs, history) {
    const gone = () => this.stopped || this.wallets.get(w.wallet) !== w;
    let streak = 0;
    for (let i = 0; i < sigs.length; i += PNL_CHUNK) {
      if (gone()) return "gone";
      if (w.rows >= this.cfg.maxTrades || this.rows >= this.cfg.maxRows) return "full";
      const chunk = sigs.slice(i, i + PNL_CHUNK), results = new Array(chunk.length);
      let next = 0, outage = false;
      try {
        await Promise.all(Array.from({ length: Math.min(PNL_TX_CONCURRENCY, chunk.length) }, async () => {
          while (next < chunk.length && !outage) {
            const k = next++, r = (results[k] = await this.#readTx(w, chunk[k]));
            if (r.error) { if (++streak >= PNL_OUTAGE_STREAK) outage = true; } else if (r.answered) streak = 0;
          }
        }));
      } catch (e) { if (gone()) return "gone"; throw e; }
      if (gone()) return "gone";
      if (outage) throw Object.assign(new Error(`${streak} transactions in a row could not be read`), { outage: true });
      this.#store(w, chunk, results, history ? w.scanned : i, history);
      await tick();
    }
    return "ok";
  }
  /**
   * One chunk's rows and counts, stored together with the place the scan reached. `pos` is the chunk's place in the
   * listing (newest = 0): a row's `ord` is minus its transaction's place, so older transactions sort first. A write that
   * fails leaves the wallet's row in memory as it was, like the database.
   */
  #store(w, chunk, results, pos, history) {
    const was = { ...w }, rows = this.rows, stored = this.stats.backfillRows, unreadRows = this.unreadRows, ms = this.now();
    let kept = 0;
    try {
      this.db.transaction(() => {
        let held = -1; // the wallet's remembered unread transactions, counted when the first new one comes
        results.forEach((r, k) => {
          const sig = chunk[k].signature, ord = -(pos + k + 1);
          for (const t of r.rows) {
            if (this.rows >= this.cfg.maxRows) w.cut = true; // no room in the table: the trade is missing, and the history says so
            else if (this.db.insertWalletTrade(w.wallet, { ...t, ord })) { w.rows++; this.rows++; this.stats.backfillRows++; }
          }
          if (r.unread) {
            // Counted once: a transaction remembered already (a catch-up or a second scan meets it again) is not new.
            if (this.db.pnlUnreadHas(w.wallet, sig)) return;
            w.unread++;
            if (held < 0) held = this.db.pnlUnreadCount(w.wallet);
            if (held < PNL_UNREAD_MAX && this.unreadRows < PNL_UNREAD_MAX_ROWS && this.db.pnlUnreadAdd(w.wallet, sig, ord, ms, ms + PNL_UNREAD_RETRY_MS)) { held++; kept++; this.unreadRows++; }
          } else if (w.unread > 0 && !chunk[k].err && this.db.pnlUnreadDelete(w.wallet, sig)) { w.unread--; this.unreadRows--; } // read after all
        });
        if (history) {
          const last = chunk[chunk.length - 1];
          w.scanned += chunk.length; w.beforeSig = last.signature; w.attempts = 0;
          if (Number.isFinite(last.blockTime)) w.oldestTime = last.blockTime;
        }
        this.#save(w); this.db.kvSet("pnlCalls", this.budget);
      });
    } catch (e) { Object.assign(w, was); this.rows = rows; this.stats.backfillRows = stored; this.unreadRows = unreadRows; throw e; }
    if (kept) this.retryAt = Math.min(this.retryAt, ms + PNL_UNREAD_RETRY_MS);
    this.#uncache(w.wallet);
  }
  /**
   * One transaction's trades of the wallet: `{ rows, unread, error, answered }`. A failed one on chain is not fetched at
   * all. `error`: every try threw (the endpoint, not the transaction); `answered`: the endpoint did answer.
   */
  async #readTx(w, s) {
    if (s.err) return { rows: [], unread: 0, error: false, answered: false };
    let error = false, answered = false;
    for (let attempt = 0; attempt <= PNL_TX_RETRIES; attempt++) {
      if (attempt) this.stats.txRetries++;
      try {
        const tx = await this.#call("getTransaction", [s.signature, { maxSupportedTransactionVersion: 1, encoding: "json", commitment: "confirmed" }], TX_MAX_BYTES);
        answered = true; error = false;
        if (!tx) continue; // the node does not have it (yet)
        this.stats.txRead++;
        const r = tradesOfTx(this.model, w.wallet, s.signature, tx);
        if (r.incomplete) this.stats.txUnread++;
        if (r.inner) this.stats.txInner++;
        return { rows: r.rows, unread: r.incomplete ? 1 : 0, error: false, answered };
      } catch (e) {
        if (this.ac.signal.aborted || e?.budget) throw e;
        if (e?.tooLarge) { error = false; break; } // the same answer every time
        error = !answered;
      }
    }
    this.stats.txUnread++;
    return { rows: [], unread: 1, error, answered };
  }

  // ---------------------------------------------------------------- answers
  #history(w) {
    if (!w) return { state: "full", scanned: 0, total: 0, cut: false, unread: 0, since: null, trackedAt: null, gap: null };
    const state = !this.enabled && (w.state === "queued" || w.state === "running") ? "off" : w.state;
    return { state, scanned: w.scanned, total: w.total, cut: !!w.cut, unread: w.unread, since: w.oldestTime ?? null, trackedAt: w.addedAt, gap: w.gapFrom ?? null };
  }
  /** `{ name, symbol, image }` and the quote of a coin, null when the index no longer holds it. */
  #coinOf(mint, quoteUsd = null) {
    const c = this.model.get(mint);
    if (!c) return null;
    const r = this.model.ref(c), quoteMint = c.quoteMint == null || c.quoteMint === SOL_MINT ? null : c.quoteMint;
    let usd = null;
    if (quoteUsd) { usd = quoteUsd.get(quoteMint); if (usd === undefined) quoteUsd.set(quoteMint, (usd = this.model.quoteUsdOf(quoteMint) ?? null)); }
    return { coin: { name: r.name, symbol: r.symbol, image: r.image }, quoteMint, quoteSymbol: this.model.quoteSymbol(c), quoteDecimals: this.model.quoteDecimals(c), baseDecimals: this.model.decimalsOf(mint), usd };
  }
  /**
   * The wallet's per-coin entries over every stored trade, in trade order (the table's own: time, slot, ord, idx):
   * PNL_SLICE rows are read and applied per event-loop turn, each page one range of the index.
   */
  async #entries(wallet, since) {
    const all = new Map();
    let after = null, n = 0;
    for (;;) {
      const page = this.db.walletTradesPage(wallet, after, PNL_SLICE);
      for (const t of page) {
        let e = all.get(t.mint);
        if (!e) all.set(t.mint, (e = blankEntry()));
        applyTrade(e, t, since);
      }
      n += page.length;
      if (page.length < PNL_SLICE) break;
      after = page[page.length - 1];
      await tick();
    }
    return { per: listed(all), n };
  }
  async #build(w, wallet, since) {
    this.stats.builds++;
    const { per, n } = w ? await this.#entries(wallet, since) : { per: new Map(), n: 0 };
    await tick();
    const quoteUsd = new Map(), coins = [];
    let realized = 0, cost = 0, priced = 0, unpriced = 0;
    for (const [mint, e] of per) {
      const c = this.#coinOf(mint, quoteUsd);
      if (!c) continue;
      const realizedUsdNow = usdNow(e.realizedQuote, c.quoteDecimals, c.usd), costUsdNow = usdNow(e.costQuote, c.quoteDecimals, c.usd);
      if (c.usd != null) { priced++; realized += realizedUsdNow; cost += costUsdNow; } else unpriced++;
      coins.push({
        mint, coin: c.coin, quoteMint: c.quoteMint, quoteSymbol: c.quoteSymbol, quoteDecimals: c.quoteDecimals, baseDecimals: c.baseDecimals,
        boughtBase: e.boughtBase.toString(), boughtQuote: e.boughtQuote.toString(), soldBase: e.soldBase.toString(), soldQuote: e.soldQuote.toString(),
        realizedQuote: e.realizedQuote.toString(), costQuote: e.costQuote.toString(), heldBase: e.heldBase.toString(), partial: e.partial,
        buys: e.buys, sells: e.sells, firstAt: e.firstAt, lastAt: e.lastAt, realizedUsdNow, costUsdNow,
      });
    }
    coins.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || (a.mint < b.mint ? -1 : 1));
    const none = coins.length > 0 && priced === 0;
    return {
      ok: true, wallet, at: this.#nowS(), since: since || null, history: this.#history(w), trades: n, coins,
      totals: { realizedUsdNow: none ? null : realized, costUsdNow: none ? null : cost, unpriced },
    };
  }
  /** Forgets every kept body of the wallet. */
  #uncache(wallet) {
    this.seriesCache.delete(wallet);
    const per = this.cache.get(wallet);
    if (!per) return;
    for (const e of per.values()) { this.cacheCoins -= e.weight; e.weight = 0; e.dropped = true; }
    this.cache.delete(wallet);
  }
  /** Drops the bodies past their time (they would otherwise stay until pushed out by count). */
  #sweep(ms) {
    if (ms - this.sweptAt < PNL_CACHE_SWEEP_MS) return;
    this.sweptAt = ms;
    for (const [wallet, per] of this.cache) {
      for (const [since, e] of per) if (!e.promise && ms - e.at >= e.ttl) { this.cacheCoins -= e.weight; e.weight = 0; e.dropped = true; per.delete(since); }
      if (!per.size) this.cache.delete(wallet);
    }
    for (const [wallet, per] of this.seriesCache) {
      for (const [since, e] of per) if (!e.promise && ms - e.at >= e.ttl) per.delete(since);
      if (!per.size) this.seriesCache.delete(wallet);
    }
  }
  /**
   * The body of GET /api/pnl/:wallet. Registers the wallet (and queues its history scan). `since` counts in whole
   * PNL_SINCE_STEP_S. One body per wallet and `since` is kept a few seconds, requests that arrive while it is built
   * share the build, and a new trade of the wallet or a step of its scan drops what is kept. What is kept is bounded by
   * wallets (PNL_CACHE_MAX), by windows per wallet (PNL_CACHE_SINCE_MAX) and by size (PNL_CACHE_COINS coin entries).
   */
  pnl(wallet, since = 0) {
    since = sinceOf(since);
    const w = this.register(wallet), ms = this.now();
    if (!w) return this.#build(null, wallet, since); // the set is full: an empty body, history.state "full", nothing kept
    this.#sweep(ms);
    let per = this.cache.get(wallet);
    const hit = per?.get(since);
    if (hit?.promise) { this.stats.shared++; return hit.promise; }
    if (hit && ms - hit.at < hit.ttl) { this.stats.hits++; return Promise.resolve(hit.body); }
    if (!per) per = new Map();
    this.cache.delete(wallet); this.cache.set(wallet, per);
    const e = { at: 0, ttl: 0, body: null, promise: null, weight: 0, dropped: false };
    if (hit) { this.cacheCoins -= hit.weight; hit.weight = 0; hit.dropped = true; per.delete(since); }
    per.set(since, e);
    while (per.size > PNL_CACHE_SINCE_MAX) { const k = per.keys().next().value, old = per.get(k); this.cacheCoins -= old.weight; old.weight = 0; old.dropped = true; per.delete(k); }
    e.promise = this.#build(w, wallet, since).then((body) => {
      e.at = this.now(); e.ttl = body.history.state === "done" || body.history.state === "off" ? PNL_CACHE_MS : PNL_CACHE_BUSY_MS; e.body = body; e.promise = null;
      if (!e.dropped) {
        e.weight = body.coins.length + 1; this.cacheCoins += e.weight;
        while ((this.cache.size > PNL_CACHE_MAX || this.cacheCoins > PNL_CACHE_COINS) && this.cache.size > 1) this.#uncache(this.cache.keys().next().value);
      }
      return body;
    }, (err) => { if (per.get(since) === e) per.delete(since); if (!per.size && this.cache.get(wallet) === per) this.cache.delete(wallet); throw err; });
    return e.promise;
  }
  /**
   * The body of GET /api/pnl/:wallet/series: the wallet's cumulative realized profit over time inside the window, in USD
   * at today's quote prices (lib/pnl.mjs seriesEnd), at most 240 points. Does not register a wallet: one that is not
   * tracked has no points. Reads the wallet's own rows in slices like the P&L body; one body per wallet and `since` is
   * kept as long as a P&L body, shared by requests that arrive while it is built, and dropped with the wallet's P&L
   * bodies (a new trade, a step of its scan).
   */
  series(wallet, since = 0) {
    since = sinceOf(since);
    const w = this.wallets.get(wallet) ?? null, ms = this.now();
    if (!w) return Promise.resolve({ ok: true, wallet, at: this.#nowS(), since: since || null, solUsd: this.model.solUsd ?? null, points: [], unpriced: 0 });
    this.#sweep(ms);
    let per = this.seriesCache.get(wallet);
    const hit = per?.get(since);
    if (hit?.promise) { this.stats.shared++; return hit.promise; }
    if (hit && ms - hit.at < hit.ttl) { this.stats.hits++; return Promise.resolve(hit.body); }
    if (!per) per = new Map();
    this.seriesCache.delete(wallet); this.seriesCache.set(wallet, per);
    const e = { at: 0, ttl: 0, body: null, promise: null };
    per.delete(since); per.set(since, e);
    while (per.size > PNL_CACHE_SINCE_MAX) per.delete(per.keys().next().value);
    while (this.seriesCache.size > PNL_SERIES_CACHE_MAX) this.seriesCache.delete(this.seriesCache.keys().next().value);
    e.promise = this.#buildSeries(wallet, since).then((body) => {
      e.at = this.now(); e.ttl = w.state === "done" || !this.enabled ? PNL_CACHE_MS : PNL_CACHE_BUSY_MS; e.body = body; e.promise = null;
      return body;
    }, (err) => { if (per.get(since) === e) per.delete(since); if (!per.size && this.seriesCache.get(wallet) === per) this.seriesCache.delete(wallet); throw err; });
    return e.promise;
  }
  async #buildSeries(wallet, since) {
    this.stats.seriesBuilds++;
    const s = seriesStart(since);
    let after = null;
    for (;;) {
      const page = this.db.walletTradesPage(wallet, after, PNL_SLICE);
      for (const t of page) seriesApply(s, t);
      if (page.length < PNL_SLICE) break;
      after = page[page.length - 1];
      await tick();
    }
    await tick();
    const quoteUsd = new Map(), at = this.#nowS();
    const { points, unpriced } = seriesEnd(s, { at, priceOf: (mint) => { const c = this.#coinOf(mint, quoteUsd); return c && { decimals: c.quoteDecimals, usd: c.usd }; } });
    return { ok: true, wallet, at, since: since || null, solUsd: this.model.solUsd ?? null, points, unpriced };
  }
  /**
   * The body of GET /api/activity/:wallet: the wallet's newest stored trades in trade order, `limit` of them before
   * the cursor: `beforeId` names the last row of the page before (its place is looked up), `beforeTime` alone means
   * trades strictly older than that second, which is also what a cursor whose row is gone falls back to. Does not
   * register a wallet.
   */
  activity(wallet, { limit = 50, beforeTime = null, beforeId = null } = {}) {
    const w = this.wallets.get(wallet) ?? null;
    const n = Math.min(ACTIVITY_MAX, Math.max(1, limit)), m = Number.MIN_SAFE_INTEGER;
    const before = beforeTime == null ? null : (beforeId != null && w && this.db.walletTradeAt(wallet, beforeId)) || { time: beforeTime, slot: m, ord: m, idx: m, id: m };
    const rows = !w ? [] : this.db.walletTradesNewest(wallet, before, n);
    const seen = new Map();
    const trades = rows.map((r) => {
      let c = seen.get(r.mint);
      if (c === undefined) seen.set(r.mint, (c = this.#coinOf(r.mint)));
      return { sig: r.sig, mint: r.mint, coin: c?.coin ?? null, side: r.isBuy ? "buy" : "sell", baseAmount: r.baseAmount, quoteAmount: r.quoteAmount,
        baseDecimals: c?.baseDecimals ?? this.model.decimalsOf(r.mint), quoteMint: c?.quoteMint ?? null, quoteSymbol: c?.quoteSymbol ?? null, quoteDecimals: c?.quoteDecimals ?? null, time: r.time };
    });
    const last = rows[rows.length - 1];
    return { ok: true, wallet, at: this.#nowS(), tracked: !!w, history: w ? this.#history(w) : null, trades, next: rows.length === n && last ? `${last.time}:${last.id}` : null };
  }
  /** /api/health: wallets tracked, scans waiting and running, rows held, the day's chain reads, and the counters. */
  snapshot() {
    const day = Math.floor(this.now() / DAY_MS);
    return {
      enabled: this.enabled, wallets: this.wallets.size, maxWallets: this.cfg.maxWallets, queue: this.queue.length, running: this.running ? 1 : 0,
      rows: this.rows, maxRows: this.cfg.maxRows, callsToday: day === this.budget.day ? this.budget.used : 0, dailyCalls: this.cfg.dailyCalls,
      pausedMs: Math.max(0, this.pauseUntil - this.now()), purging: this.purging.size, cached: this.cache.size, cachedCoins: this.cacheCoins,
      cuts: this.cuts.size, unreadStored: this.unreadRows, unreadDueMs: Number.isFinite(this.retryAt) ? Math.max(0, this.retryAt - this.now()) : null, ...this.stats,
    };
  }
}
