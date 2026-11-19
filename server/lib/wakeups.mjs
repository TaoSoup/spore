// Wake-ups (GET /api/discover, /api/discover/:mint, SSE `wake`): families whose EXISTING coins are suddenly being bought
// by many more wallets than usual. A backtest over Nov 8-19 2026 found that after a news post the buying lands within
// five minutes on a parent's older children (coins launched days before), not on new launches, and that most of the
// move is over by the time launch counts rise (the launch list this replaces fired 30 min after the move). So the
// signal is buyers of existing children per five minutes, the list is ordered by how recent a wake-up is, and a
// wake-up is pushed on the event stream the moment it starts. The body says what was measured ("buying 14x its
// normal"); it never says a coin will rise, and a linked post is what coincided, not the cause.
//
// The WAKE rule (the backtest's, unchanged): per parent and per 5-minute bucket, count the distinct wallets that bought
// (trade value >= $1) any existing child (launched more than 30 min before the bucket starts, or with no known
// creation time). A bucket fires when that count is >= 50, >= 3 distinct existing coins were bought, and the count is
// >= 5x the parent's trailing mean: over the buckets actually observed (the history starts at the first trade the
// wake-ups saw, any parent's), at most the previous 288 (24 h), empty ones included. No bucket fires before 6 h of
// history was observed: run over 27 h of real trades, a boot that compared the seed's first buckets with an empty ring
// listed the always-busiest family as "buying 1,273x its normal". A firing bucket keeps the parent's wake-up going; a
// parent without one starts one, with an alert only when its last alert is 3 h or more behind (else it is listed
// again, silently). SOL is no parent here (its children are every root coin).
//
// A wake-up is "live" while its latest complete bucket is >= 3x the CURRENT trailing mean, and for at most 2 h after
// its start; then "cooling". It is dropped 2 h after its last such bucket or 6 h after its start, whichever comes
// first. Judged against the mean frozen at the start, a family that grew stayed "live" for a day.
//
// Cost (the server has a history of event-loop freezes): record() is O(1) per trade: a few Map/Set operations on the
// trade's parent, no scan, and allocations only for a coin's first trade in a bucket (its stats) and a parent's first
// trade ever (its rings). A parent's bucket closes on its next trade in a later bucket or on the tick (every TICK_MS,
// over the parents with an open bucket only); closing it is O(1) amortized (the 24 h ring is zero-filled lazily, at
// most 288 slots). The bodies are built on request in slices (lib/sliced.mjs), cached WAKE_TTL_MS.
//
// Memory bound: distinct wallets are exact Sets of the trades' own `user` strings (no copies): per parent one Map for
// its open bucket (cleared on close), per coin one Set per bucket kept for the last QUIET_BUCKETS closed buckets (the
// 15-minute "moving now" view) and dropped after. So the wallet entries held are at most the $1+ buys of the open
// bucket plus the 3 before it, twice (parent and coin), and each Set stops at SET_MAX entries (counts saturate there;
// health `capped` says when). Each parent with a trade in the last 24 h holds 2 x 288 + 6 x 24 bytes of rings.
//
// Live trades only (model.recordTrade): rows read back from the chain (model.storeFilled) are old and must not start
// a wake-up. The boot seed (model.load) feeds the last 24 h of stored trades through the same path with events off,
// so the baselines and the 3 h rule hold across a restart and a wake-up found in history is listed without an alert.
// A gap in the stored trades (the server was down) reads as quiet buckets and lowers a baseline until it rolls out.
//
// The creator's 10-minute buy/sell flow (the "sold" fact) is recorded from the same trades while a coin is under
// 10 min old (O(1): one Map entry per young coin that traded, at most LAUNCH_MAX, its launcher's base amounts summed) and written to sqlite
// (`launch_flow`) once the window closed, because the per-mint trim of `trades` deletes a busy coin's launch rows
// within a day. Without a record, the stored rows decide only when they still reach back to the launch; otherwise
// the fact is unknown (asked again later, counted in health `factsUnknown`) and the coin is not left out.
import { SOL_MINT } from "./jupiter.mjs";
import { imageProxyUrl } from "./meta.mjs";
import { units } from "./pricing.mjs";
import { postOf, postTime, postUrl } from "./narrative.mjs";
import { runSliced } from "./sliced.mjs";

/** Bucket width (s), buckets in the 24 h baseline, buckets in the 2 h spark. */
export const BUCKET_S = 300, BASE_BUCKETS = 288, SPARK_BUCKETS = 24;
/** The WAKE rule: existing-child buyers, distinct existing coins, times the baseline; the quiet gap before a new wake-up (s); a child is existing when launched this long before the bucket (s); a buy counts from this value (USD). */
export const WAKE_BUYERS = 50, WAKE_COINS = 3, WAKE_RATIO = 5, REFIRE_S = 3 * 3600, EXISTING_S = 1800, MIN_USD = 1;
/** Buckets of history (since the first trade seen) a bucket needs before it may fire: 6 h. */
export const MIN_SEEN = 72;
/** "live" while the latest complete bucket is this many times the current baseline and the wake-up is under LIVE_MAX_S old; dropped DROP_S after its last such bucket or WAKE_MAX_S after its start, whichever comes first. */
export const LIVE_RATIO = 3, LIVE_MAX_S = 2 * 3600, DROP_S = 2 * 3600, WAKE_MAX_S = 6 * 3600;
/** A baseline under this many buyers per bucket reads as this many in a ratio (a family nobody bought yesterday would read thousands of times its normal). */
export const BASE_FLOOR = 1;
/** Families listed, coins per family, coins in a quiet answer and the buckets they are ranked over (15 min). */
export const LIST_MAX = 12, COINS_MAX = 6, QUIET_COINS = 3, QUIET_BUCKETS = 3;
/** A body is served this long. */
export const WAKE_TTL_MS = 5_000;
/** Distinct wallets one parent or coin bucket holds at most. */
export const SET_MAX = 20_000;
/** A bucket that ended this recently is closed by the tick only after this grace (s): block times trail our clock by a few seconds. */
export const GRACE_S = 5;
/** The three creator facts that marked dead coins in the backtest: the creator sold >= DEAD_SOLD of its own buy within DEAD_SOLD_S of launch; launched DEAD_LAUNCHES+ coins in the DEAD_LAUNCH_S before; relaunched the same ticker under the same parent. */
export const DEAD_SOLD = 0.9, DEAD_SOLD_S = 600, DEAD_LAUNCHES = 10, DEAD_LAUNCH_S = 3600;
/** Creator facts kept (a coin's are final once it is DEAD_SOLD_S old; a younger one's are asked again after FACT_YOUNG_MS, an unknown one after FACT_UNKNOWN_MS); creator indexes kept. */
export const FACTS_MAX = 50_000, FACT_YOUNG_MS = 30_000, FACT_UNKNOWN_MS = 10 * 60_000, CREATORS_MAX = 2_000;
/** A launch window whose first trade was seen this soon (s) after creation is whole (the dev buy is in the create transaction); launch windows held at most. */
export const LAUNCH_SEEN_S = 30, LAUNCH_MAX = 20_000;
/** Children one quiet answer looks at, at most (ranked by buyers). */
export const QUIET_SCAN = 256;
const TICK_MS = 2_000, WAKES_MAX = 50, QUIET_CACHE = 500, PRUNE_EVERY_S = 600;
const U16 = 0xffff;

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const byMint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const normSym = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

function parentState(mint) {
  return {
    mint,
    // the open bucket: its number (-1 when none), wallet → bits (1: bought a child, 2: bought an existing child), counts, coins
    k: -1, buyers: new Map(), exN: 0, allN: 0, trades: 0, exCoins: new Set(), coins: new Map(), // coins: mint → { buyers: Set, trades, usd }
    // closed buckets: existing-child buyers by k % 288 (holds the buckets up to `upTo`), all-child buyers of the last 24 with their numbers
    ex: new Uint16Array(BASE_BUCKETS), exSum: 0, upTo: -1, spark: new Uint16Array(SPARK_BUCKETS), sparkK: new Int32Array(SPARK_BUCKETS).fill(-1),
    lastK: -1, lastEx: 0, lastAll: 0, lastTrades: 0,
    hist: [], // the coin maps of the last QUIET_BUCKETS closed buckets, newest first: { k, coins }
    lastBase: 0, // the trailing mean the last closed bucket was judged against
    lastAlert: -Infinity, wake: null, // the start of the last wake-up that alerted (or would have, in the seed)
  };
}

export class Wakeups {
  /** `model`: the index (read only); `hub`: the SSE hub `wake` events go to; `narrative`: lib/narrative.mjs for post texts and copies (optional); `now` in ms. */
  constructor({ model, hub = null, narrative = null, now = Date.now, log = console } = {}) {
    this.model = model; this.hub = hub; this.narrative = narrative; this.now = now; this.log = log;
    this.parents = new Map(); // parent mint → state
    this.open = new Set();    // parents with an open bucket
    this.waking = new Set();  // parents with a wake-up listed (live or cooling)
    this.holding = new Set(); // parents whose `hist` holds coin buckets (the tick trims them to the 15-minute view)
    this.seeding = false; this.prunedAt = 0;
    this.firstK = null;       // the bucket of the first trade seen (any coin): where the observed history starts
    this.launch = new Map();  // coin mint → { at, first, key, bought, sold }: launch windows still open, about in creation order
    this.facts = new Map();   // coin mint → { why, unknown, until (ms) }, oldest first
    this.creatorIdx = new Map(); // creator key → { size, times, firsts }, oldest first
    this.hit = null; this.job = null; this.built = new Map(); // the last list body, the build under way, every family it built by parent
    this.quiet = new Map(); this.quietJobs = new Map();
    this.timer = null;
    this.stats = { trades: 0, seedRows: 0, seedMs: null, closes: 0, started: 0, seededWakes: 0, events: 0, capped: 0, builds: 0, lastBuildMs: null, maxSliceMs: 0, served: 0, quietBuilt: 0, factQueries: 0, factsUnknown: 0, launchSaved: 0, launchSkipped: 0, launchDropped: 0, relisted: 0, live: 0, cooling: 0 };
  }
  attach({ hub, narrative } = {}) { if (hub !== undefined) this.hub = hub; if (narrative !== undefined) this.narrative = narrative; return this; }
  /** Closes due buckets every TICK_MS, so a wake-up starts on time when the parent's next trade is late. */
  start() { if (!this.timer) { this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.log.warn?.(`wakeups: ${e?.message ?? e}`); } }, TICK_MS); this.timer.unref?.(); } return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
  snapshot() {
    let held = 0;
    for (const P of this.open) held += P.buyers.size;
    return { parents: this.parents.size, open: this.open.size, waking: this.waking.size, walletsOpen: held, facts: this.facts.size, launching: this.launch.size, seenBuckets: this.firstK == null ? 0 : Math.max(0, Math.floor(this.#nowS() / BUCKET_S) - this.firstK), ...this.stats };
  }

  #nowS() { return Math.floor(this.now() / 1000); }
  /** The latest bucket every parent has closed by now (the grace applied). */
  #complete(nowS) { return Math.floor((nowS - GRACE_S) / BUCKET_S) - 1; }

  // ---------------------------------------------------------------- the feed
  /** The boot seed: stored trades in time order, through record() with no event published. */
  beginSeed() { this.seeding = true; this.seedT0 = performance.now(); }
  endSeed() { this.tick(); this.seeding = false; this.stats.seedMs = Math.round(performance.now() - this.seedT0); }

  /**
   * Counts one trade `{ mint, time, isBuy, valueUsd, user }` of a tracked child. O(1): see the head of the file.
   * A trade older than its parent's open bucket (a late print) counts in the open one; one older than the last closed
   * bucket counts in the bucket after it.
   */
  record(t) {
    const time = Math.floor(Number(t?.time));
    if (!Number.isFinite(time)) return;
    let k = Math.floor(time / BUCKET_S);
    // The observed history starts at the first trade of any coin: a bucket before it was not watched, not quiet.
    if (this.firstK == null) this.firstK = k;
    const c = this.model.coins.get(t.mint);
    if (!c || !c.tracked) return;
    const p = c.quoteMint;
    if (!p || p === SOL_MINT) return;
    if (this.seeding) this.stats.seedRows++; else this.stats.trades++;
    if (c.createdAt != null && time >= c.createdAt && time < c.createdAt + DEAD_SOLD_S) this.#launchTrade(c, t, time);
    let P = this.parents.get(p);
    if (!P) this.parents.set(p, P = parentState(p));
    if (P.k >= 0) { if (k > P.k) this.#close(P); else k = P.k; }
    if (P.k < 0) { if (k <= P.lastK) k = P.lastK + 1; P.k = k; this.open.add(P); }
    const x = typeof t.valueUsd === "number" && Number.isFinite(t.valueUsd) ? t.valueUsd : 0;
    P.trades++;
    let s = P.coins.get(c.mint);
    if (!s) P.coins.set(c.mint, s = { buyers: new Set(), trades: 0, usd: 0 });
    s.trades++; s.usd += x;
    if (t.isBuy && x >= MIN_USD && typeof t.user === "string") {
      const existing = c.createdAt == null || c.createdAt < k * BUCKET_S - EXISTING_S;
      const had = P.buyers.get(t.user) ?? 0, bits = had | 1 | (existing ? 2 : 0);
      if (bits !== had) {
        if (!had && P.buyers.size >= SET_MAX) this.stats.capped++;
        else { P.buyers.set(t.user, bits); if (!had) P.allN++; if (existing && !(had & 2)) P.exN++; }
      }
      if (existing) P.exCoins.add(c.mint);
      if (s.buyers.size < SET_MAX) s.buyers.add(t.user); else if (!s.buyers.has(t.user)) this.stats.capped++;
    }
    const w = P.wake;
    if (w) { let e = w.coins.get(c.mint); if (!e) w.coins.set(c.mint, e = { trades: 0, usd: 0 }); e.trades++; e.usd += x; }
  }

  /** A trade inside a coin's first DEAD_SOLD_S: its launcher's base amount is summed (O(1)). */
  #launchTrade(c, t, time) {
    let e = this.launch.get(c.mint);
    if (!e) {
      const key = this.model.creatorKey(c);
      if (!key) return; // nobody to attribute the trades to: the stored rows decide later, while they last
      this.launch.set(c.mint, e = { at: c.createdAt, first: time, key, bought: 0, sold: 0 });
      if (this.launch.size > LAUNCH_MAX) { this.launch.delete(this.launch.keys().next().value); this.stats.launchDropped++; }
    }
    if (t.user !== e.key) return;
    const a = Number(t.baseAmount);
    if (!(a > 0)) return;
    if (t.isBuy) e.bought += a; else e.sold += a;
  }

  /**
   * Writes the launch windows that closed (GRACE_S ago) to sqlite. Only one seen from the launch on: a window first seen
   * later (the boot seed's 24 h cutting through it, a restart) may lack the dev buy, and a partial buy against later
   * sales would read "sold".
   */
  #saveLaunches(nowS) {
    const due = [];
    for (const [m, e] of this.launch) {
      if (nowS - GRACE_S < e.at + DEAD_SOLD_S) break; // opened about in creation order: the rest closes later (one out of order waits)
      this.launch.delete(m);
      if (e.first > e.at + LAUNCH_SEEN_S) { this.stats.launchSkipped++; continue; }
      due.push([m, e]);
    }
    if (!due.length) return;
    const db = this.model.db;
    const put = () => { for (const [m, e] of due) if (db.launchFlowPut(m, e.bought, e.sold, e.at)) this.stats.launchSaved++; };
    try { if (due.length > 1 && !db.db?.isTransaction) db.transaction(put); else put(); }
    catch (e) { this.log.warn?.(`wakeups: launch flows: ${e?.message ?? e}`); }
  }

  /** Writes zeros for the buckets after `upTo` up to `k` (the buckets the parent had no trade in). */
  #fillTo(P, k) {
    if (P.upTo < 0 || k - P.upTo >= BASE_BUCKETS) { if (P.upTo >= 0) { P.ex.fill(0); P.exSum = 0; } P.upTo = k; return; }
    for (let j = P.upTo + 1; j <= k; j++) { const s = j % BASE_BUCKETS; P.exSum -= P.ex[s]; P.ex[s] = 0; }
    if (k > P.upTo) P.upTo = k;
  }

  /** Closes the parent's open bucket: the WAKE rule, the rings, the wake-up's numbers. */
  #close(P) {
    const k = P.k, T = (k + 1) * BUCKET_S;
    this.stats.closes++;
    this.#fillTo(P, k - 1);
    // The mean over the buckets observed before this one (a parent's buckets before its first trade are zeros in its ring).
    const seen = this.firstK == null ? 0 : k - this.firstK, cover = Math.min(BASE_BUCKETS, seen);
    const base = cover > 0 ? P.exSum / cover : 0, exN = P.exN, allN = P.allN;
    const slot = k % BASE_BUCKETS, v = Math.min(exN, U16);
    P.exSum += v - P.ex[slot]; P.ex[slot] = v; P.upTo = k;
    P.spark[k % SPARK_BUCKETS] = Math.min(allN, U16); P.sparkK[k % SPARK_BUCKETS] = k;
    P.lastK = k; P.lastEx = exN; P.lastAll = allN; P.lastTrades = P.trades; P.lastBase = base;
    P.hist.unshift({ k, coins: P.coins });
    if (P.hist.length > QUIET_BUCKETS) P.hist.length = QUIET_BUCKETS;
    this.holding.add(P);
    // A wake-up past its time (2 h after its last hot bucket, 6 h after its start) is over even when no tick dropped it yet.
    if (P.wake && this.#over(P.wake, k * BUCKET_S)) { P.wake = null; this.waking.delete(P); }
    if (seen >= MIN_SEEN && exN >= WAKE_BUYERS && P.exCoins.size >= WAKE_COINS && exN >= WAKE_RATIO * base) {
      // A firing bucket keeps the current wake-up going. Without one it starts one, which alerts only 3 h after the last alert:
      // a family bursting every 2-3 h is listed after each burst (it used to be swallowed while the 3 h lock moved on).
      if (P.wake) P.wake.hotAt = T;
      else { const alert = T - P.lastAlert >= REFIRE_S; if (alert) P.lastAlert = T; else this.stats.relisted++; this.#start(P, T, base, allN, alert); }
    }
    const w = P.wake;
    if (w) {
      const b = Math.max(base, BASE_FLOOR), ratio = exN / b;
      w.ratio = ratio; if (ratio > w.peak) w.peak = ratio;
      if (exN >= LIVE_RATIO * b) w.hotAt = T;
    }
    P.k = -1; P.buyers.clear(); P.exN = 0; P.allN = 0; P.trades = 0; P.exCoins.clear(); P.coins = new Map();
    this.open.delete(P);
  }

  /** Whether a wake-up is over at unix s `s`: 2 h after its last hot bucket or 6 h after its start. */
  #over(w, s) { return s - w.hotAt >= DROP_S || s - w.startedAt >= WAKE_MAX_S; }
  /** Live: hot in the latest complete bucket `L` and under 2 h old at its end. */
  #live(w, L) { const end = (L + 1) * BUCKET_S; return w.hotAt >= end && end - w.startedAt < LIVE_MAX_S; }

  /** A wake-up starts at T (the end of its first firing bucket); the coins of that bucket are its first "since start". `alert`: send `wake`. */
  #start(P, T, base, allN, alert) {
    const coins = new Map();
    for (const [m, s] of P.coins) coins.set(m, { trades: s.trades, usd: s.usd });
    const ratio = P.exN / Math.max(base, BASE_FLOOR);
    P.wake = { startedAt: T, ratio, peak: ratio, hotAt: T, coins, prices: new Map() };
    this.waking.add(P);
    if (this.seeding) { if (alert) this.stats.seededWakes++; return; }
    if (!alert) return;
    this.stats.started++;
    if (!this.hub) return;
    const { name, symbol } = this.model.nameOf(P.mint);
    try { this.hub.emit("wake", { parent: { mint: P.mint, symbol, name }, startedAt: T, ratio: r1(ratio), buyers5m: allN }); this.stats.events++; }
    catch (e) { this.log.warn?.(`wakeups: event: ${e?.message ?? e}`); }
  }

  /** Closes every bucket that ended (GRACE_S ago), lets go of coin buckets past the 15 minutes, drops wake-ups past their time, writes the launch windows that closed, and now and then forgets parents quiet for 24 h. */
  tick(nowS = this.#nowS()) {
    const cur = Math.floor((nowS - GRACE_S) / BUCKET_S);
    for (const P of this.open) if (P.k < cur) this.#close(P);
    // A parent that went quiet lets go of its coin buckets once they are older than the 15-minute view.
    for (const P of this.holding) { while (P.hist.length && P.hist[P.hist.length - 1].k < cur - QUIET_BUCKETS) P.hist.pop(); if (!P.hist.length) this.holding.delete(P); }
    for (const P of this.waking) if (this.#over(P.wake, nowS)) { P.wake = null; this.waking.delete(P); }
    this.#saveLaunches(nowS);
    if (!this.seeding && nowS - this.prunedAt >= PRUNE_EVERY_S) {
      this.prunedAt = nowS;
      for (const [m, P] of this.parents) if (P.k < 0 && !P.wake && P.lastK < cur - BASE_BUCKETS && nowS - P.lastAlert >= REFIRE_S) this.parents.delete(m);
    }
  }

  // ---------------------------------------------------------------- creator facts
  /** One creator's launches: sorted creation times, and per `parent\nticker` the first coin. Rebuilt when the creator's set changed size. */
  #creatorIndex(key) {
    const set = this.model.creators?.get(key);
    if (!set) return null;
    let e = this.creatorIdx.get(key);
    if (e && e.size === set.size) { this.creatorIdx.delete(key); this.creatorIdx.set(key, e); return e; }
    const times = [], firsts = new Map();
    for (const m of set) {
      const x = this.model.coins.get(m);
      if (!x || x.createdAt == null) continue;
      times.push(x.createdAt);
      const sym = normSym(this.model.nameOf(m).symbol);
      if (!sym || !x.quoteMint) continue;
      const fk = `${x.quoteMint}\n${sym}`, f = firsts.get(fk);
      if (!f || x.createdAt < f.at || (x.createdAt === f.at && m < f.mint)) firsts.set(fk, { at: x.createdAt, mint: m });
    }
    times.sort((a, b) => a - b);
    e = { size: set.size, times: Float64Array.from(times), firsts };
    this.creatorIdx.delete(key); this.creatorIdx.set(key, e);
    while (this.creatorIdx.size > CREATORS_MAX) this.creatorIdx.delete(this.creatorIdx.keys().next().value);
    return e;
  }

  /**
   * Why a coin is left out ("sold" | "spree" | "relaunch"), or null. Cached: final once the coin is DEAD_SOLD_S old,
   * except an unknown "sold" fact (its launch rows are gone and nothing recorded it) and a coin with no known creator
   * (one may come with its fee shares), both asked again after FACT_UNKNOWN_MS.
   */
  deadWhy(c, nowMs = this.now()) {
    const hit = this.facts.get(c.mint);
    if (hit && nowMs < hit.until) return hit.why;
    const key = this.model.creatorKey(c), nowS = Math.floor(nowMs / 1000);
    let why = null, unknown = false;
    if (key && c.createdAt != null) {
      const idx = this.#creatorIndex(key);
      if (idx) {
        const t = idx.times, lo = c.createdAt - DEAD_LAUNCH_S;
        let a = 0, b = t.length;
        while (a < b) { const mid = (a + b) >> 1; if (t[mid] < lo) a = mid + 1; else b = mid; }
        let n = 0;
        for (let i = a; i < t.length && t[i] < c.createdAt && n < DEAD_LAUNCHES; i++) n++;
        if (n >= DEAD_LAUNCHES) why = "spree";
        const sym = normSym(this.model.nameOf(c.mint).symbol);
        const f = sym && c.quoteMint ? idx.firsts.get(`${c.quoteMint}\n${sym}`) : null;
        if (!why && f && f.mint !== c.mint) why = "relaunch";
      }
      if (!why) { const f = this.#launchFlow(c, key, nowS); if (!f) unknown = true; else if (f.bought > 0 && f.sold >= DEAD_SOLD * f.bought) why = "sold"; }
    }
    const young = c.createdAt != null && nowS - c.createdAt < DEAD_SOLD_S;
    const until = young ? nowMs + FACT_YOUNG_MS : unknown || !key ? nowMs + FACT_UNKNOWN_MS : Infinity;
    const old = this.facts.get(c.mint);
    if (old) { this.facts.delete(c.mint); if (old.unknown) this.stats.factsUnknown--; }
    this.facts.set(c.mint, { why, unknown, until });
    if (unknown) this.stats.factsUnknown++;
    while (this.facts.size > FACTS_MAX) { const [m, f] = this.facts.entries().next().value; this.facts.delete(m); if (f.unknown) this.stats.factsUnknown--; }
    return why;
  }

  /**
   * The launcher's `{ bought, sold }` in the coin's first DEAD_SOLD_S, or null when unknown. A young coin's rows are all
   * stored; an older one's come from its record (sqlite, else the window still open in memory), else from the rows when
   * they still reach back to the launch (the trim deletes a coin's oldest rows first), which are then recorded.
   */
  #launchFlow(c, key, nowS) {
    const db = this.model.db, end = c.createdAt + DEAD_SOLD_S;
    if (nowS < end) { this.stats.factQueries++; return db.creatorFlow(c.mint, c.createdAt, end, key); }
    const rec = db.launchFlowGet(c.mint);
    if (rec) return rec;
    const e = this.launch.get(c.mint);
    if (e && e.key === key && e.first <= c.createdAt + LAUNCH_SEEN_S) return e;
    this.stats.factQueries++;
    const first = db.tradeFirstTime(c.mint);
    if (first == null || first > c.createdAt + LAUNCH_SEEN_S) return null;
    const f = db.creatorFlow(c.mint, c.createdAt, end, key);
    if (db.launchFlowPut(c.mint, f.bought, f.sold, c.createdAt)) this.stats.launchSaved++;
    return f;
  }

  // ---------------------------------------------------------------- bodies
  #parentRef(mint) {
    const { name, symbol } = this.model.nameOf(mint);
    return { mint, name, symbol, image: imageProxyUrl(this.model.imageOfMint(mint)), isCoin: !!this.model.get(mint)?.tracked };
  }
  #postState(id) {
    const n = this.narrative;
    if (!n?.postState) return { state: "idle", handle: null, text: null };
    try { return n.postState(id); } catch (e) { this.log.warn?.(`wakeups: post ${id}: ${e?.message ?? e}`); return { state: "idle", handle: null, text: null }; }
  }
  /**
   * The coin a body lists (README §API): `w` the wake-up (null in a quiet answer, `at` then stands for its start); `px`
   * the build's cache of stored USD prices (mint → price or null).
   */
  #coin(c, { buyers5m, w, at, groups, postId, px }) {
    const model = this.model, r = model.ref(c), m = c.mint;
    const existing = c.createdAt == null || c.createdAt < at - EXISTING_S;
    const pr = model.priceOf(m);
    let usd = pr?.priceUsd != null && Number.isFinite(pr.priceUsd) ? pr.priceUsd : null;
    // A coin under a stock/asset parent or a newer coin parent has no USD price in the model: its newest stored trade's.
    if (usd == null) { if (px.has(m)) usd = px.get(m); else { usd = model.db.lastPriceUsd(m); px.set(m, usd); } }
    let mcapUsd = null;
    try { const v = usd == null ? null : r2(usd * units(c.tokenTotalSupply ?? 0, model.decimalsOf(m))); mcapUsd = Number.isFinite(v) ? v : null; } catch { mcapUsd = null; }
    let sinceStart = null, copyOf = null;
    if (w && existing) {
      // A new coin has none: measured from its first trade it counts its own launch buy (the web shows "new").
      let p0 = w.prices.get(m);
      if (!p0) { p0 = model.db.priceRef(m, w.startedAt); if (p0) w.prices.set(m, p0); }
      // In USD when both prices have one (what a holder sees), else in the parent.
      if (p0 && pr) {
        if (p0.priceUsd > 0 && pr.priceUsd != null && Number.isFinite(pr.priceUsd)) sinceStart = r2(pr.priceUsd / p0.priceUsd);
        else if (p0.priceQuote > 0 && Number.isFinite(pr.priceQuote)) sinceStart = r2(pr.priceQuote / p0.priceQuote);
      }
    } else if (w) {
      if (postId && groups) {
        const g = groups.get(postId);
        copyOf = 0;
        if (g) for (const x of g.mints) { if (x === m) continue; const o = model.coins.get(x); if (o?.createdAt != null && o.createdAt < c.createdAt) copyOf++; }
      }
    }
    return { mint: m, name: r.name, symbol: r.symbol, image: r.image, createdAt: c.createdAt ?? null, existing, mcapUsd, sinceStart, buyers5m, copyOf };
  }

  /** One family of the list, in steps (a yield every 32 coins: a coin's first creator check may read sqlite). */
  *#familyGen(P, L, nowMs, groups, px) {
    const model = this.model, w = P.wake, fresh = P.lastK === L, last = fresh ? P.hist[0]?.coins ?? null : null;
    const cands = [], posts = new Map();
    let hidden = 0, n = 0;
    for (const [m, e] of w.coins) {
      if ((++n & 31) === 0) yield;
      const c = model.coins.get(m);
      if (!c || !c.tracked) continue;
      const postId = postOf(model.metaFor(c));
      if (postId) posts.set(postId, (posts.get(postId) ?? 0) + 1);
      if (this.deadWhy(c, nowMs)) { hidden++; continue; }
      const s = last?.get(m);
      cands.push({ c, buyers: s ? s.buyers.size : 0, usd: e.usd, traded: !!s, postId });
    }
    cands.sort((x, y) => y.buyers - x.buyers || y.usd - x.usd || byMint(x.c.mint, y.c.mint));
    let more = 0;
    for (let i = COINS_MAX; i < cands.length; i++) if (cands[i].traded) more++;
    yield;
    // The post most children traded since the start link (two or more); one X does not show is passed over.
    const ranked = [...posts].filter(([, k]) => k >= 2).sort((x, y) => y[1] - x[1] || (postTime(y[0], nowMs) ?? 0) - (postTime(x[0], nowMs) ?? 0) || byMint(x[0], y[0]));
    let post = null;
    for (const [id, k] of ranked.slice(0, 3)) {
      const s = this.#postState(id);
      if (s.state === "none") continue;
      post = { id, url: postUrl(id), at: postTime(id, nowMs), handle: s.state === "ok" ? s.handle : null, text: s.state === "ok" ? s.text : null, state: s.state, coins: k };
      break;
    }
    const coins = [];
    for (const x of cands.slice(0, COINS_MAX)) { coins.push(this.#coin(x.c, { buyers5m: x.buyers, w, at: w.startedAt, groups, postId: x.postId, px })); yield; }
    const spark = new Array(SPARK_BUCKETS);
    for (let i = 0; i < SPARK_BUCKETS; i++) { const j = L - SPARK_BUCKETS + 1 + i, s = ((j % SPARK_BUCKETS) + SPARK_BUCKETS) % SPARK_BUCKETS; spark[i] = P.sparkK[s] === j ? P.spark[s] : 0; }
    return {
      parent: this.#parentRef(P.mint), startedAt: w.startedAt, state: this.#live(w, L) ? "live" : "cooling",
      ratio: r1(fresh ? w.ratio : 0), peakRatio: r1(w.peak), buyers5m: fresh ? P.lastAll : 0, trades5m: fresh ? P.lastTrades : 0, spark, baseline: r1(P.lastBase),
      coinsTrading: last ? last.size : 0, post, coins, more, hidden,
    };
  }

  /** The list, in steps: live wake-ups first, newest start first, then cooling ones. */
  *#buildGen(groupsBy) {
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000);
    this.tick(nowS);
    const Lg = this.#complete(nowS);
    const act = [];
    for (const P of this.waking) { const L = Math.max(Lg, P.lastK); act.push({ P, L, live: this.#live(P.wake, L) }); }
    act.sort((a, b) => (b.live - a.live) || b.P.wake.startedAt - a.P.wake.startedAt || byMint(a.P.mint, b.P.mint));
    const built = new Map(), families = [], px = new Map();
    let live = 0;
    for (const a of act.slice(0, WAKES_MAX)) {
      yield;
      const f = yield* this.#familyGen(a.P, a.L, nowMs, groupsBy.get(a.P.mint) ?? null, px);
      built.set(a.P.mint, f); families.push(f);
      if (f.state === "live") live++;
    }
    this.stats.live = live; this.stats.cooling = families.length - live;
    return { at: nowMs, built, body: { asOf: nowS, bucketS: BUCKET_S, families: families.slice(0, LIST_MAX) } };
  }

  /**
   * The narrative's post groups (for copyOf) of each waking parent with a new coin traded since the start: each is a
   * walk over the parent's children (sliced, cached 30 s there), so a family of old coins only does not ask for one.
   */
  async #groups() {
    const out = new Map(), n = this.narrative;
    if (!n?.groupsOf) return out;
    const want = [];
    for (const P of this.waking) {
      if (want.length >= WAKES_MAX) break;
      const cut = P.wake.startedAt - EXISTING_S;
      for (const m of P.wake.coins.keys()) { const at = this.model.coins.get(m)?.createdAt; if (at != null && at >= cut) { want.push(P); break; } }
    }
    await Promise.all(want.map(async (P) => {
      try { out.set(P.mint, await n.groupsOf(P.mint)); } catch (e) { this.log.warn?.(`wakeups: groups ${P.mint}: ${e?.message ?? e}`); }
    }));
    return out;
  }

  /** The body of GET /api/discover (README §API): cached WAKE_TTL_MS, one build shared by the askers that come together. */
  async serve() {
    this.stats.served++;
    const hit = this.hit;
    if (hit && this.now() - hit.at < WAKE_TTL_MS) return hit.body;
    if (!this.job) {
      this.job = this.#groups().then((g) => runSliced(this.#buildGen(g))).then((run) => {
        this.stats.builds++; this.stats.lastBuildMs = r2(run.cpuMs);
        if (run.maxSliceMs > this.stats.maxSliceMs) this.stats.maxSliceMs = r2(run.maxSliceMs);
        this.hit = run.value; this.built = run.value.built;
        return run.value.body;
      }).finally(() => { this.job = null; });
    }
    return this.job;
  }

  /**
   * The body of GET /api/discover/:mint: the family object when `mint` is waking, else the quiet shape (README §API);
   * null for SOL and for a mint that is neither a tracked coin nor a parent.
   */
  async serveOne(mint) {
    const model = this.model;
    if (typeof mint !== "string" || mint === SOL_MINT) return null;
    if (!model.get(mint)?.tracked && !model.children?.get(mint)?.size) return null;
    await this.serve();
    const f = this.built.get(mint);
    if (f) return f;
    const hit = this.quiet.get(mint);
    if (hit && this.now() - hit.at < WAKE_TTL_MS) return hit.body;
    let job = this.quietJobs.get(mint);
    if (!job) {
      job = runSliced(this.#quietGen(mint)).then((run) => {
        this.stats.quietBuilt++;
        this.quiet.delete(mint); this.quiet.set(mint, run.value);
        while (this.quiet.size > QUIET_CACHE) this.quiet.delete(this.quiet.keys().next().value);
        return run.value.body;
      }).finally(() => this.quietJobs.delete(mint));
      this.quietJobs.set(mint, job);
    }
    return job;
  }

  /**
   * The quiet answer, in steps: the 3 children most wallets bought ($1+) in the last 3 complete buckets, never one with
   * no such buyer (a coin only sold is not moving). A yield every 256 entries merged and every 16 coins examined, at
   * most QUIET_SCAN examined: a coin's first creator check may read sqlite, and many left out would be one long step.
   */
  *#quietGen(mint) {
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000);
    this.tick(nowS);
    const P = this.parents.get(mint), L = Math.max(this.#complete(nowS), P?.lastK ?? -1), fresh = !!P && P.lastK === L;
    const last = fresh ? P.hist[0].coins : null;
    const per = new Map(); // coin mint → { set, own, trades }
    let n = 0;
    for (const h of P?.hist ?? []) {
      if (h.k < L - QUIET_BUCKETS + 1 || h.k > L) continue;
      for (const [m, s] of h.coins) {
        if ((++n & 255) === 0) yield;
        const u = per.get(m);
        if (!u) { per.set(m, { set: s.buyers, own: false, trades: s.trades }); continue; }
        if (!u.own) { u.set = new Set(u.set); u.own = true; }
        for (const x of s.buyers) u.set.add(x);
        u.trades += s.trades;
      }
    }
    yield;
    const ranked = [...per].sort((a, b) => b[1].set.size - a[1].set.size || b[1].trades - a[1].trades || byMint(a[0], b[0]));
    const coins = [], px = new Map();
    let seen = 0;
    for (const [m, u] of ranked) {
      if (coins.length >= QUIET_COINS || u.set.size === 0 || seen >= QUIET_SCAN) break; // ranked by buyers: the rest have none
      if ((++seen & 15) === 0) yield;
      const c = this.model.coins.get(m);
      if (!c || !c.tracked || this.deadWhy(c, nowMs)) continue;
      coins.push({ ...this.#coin(c, { buyers5m: last?.get(m)?.buyers.size ?? 0, w: null, at: nowS, px }), buyers15m: u.set.size });
      yield;
    }
    return {
      at: nowMs,
      body: {
        parent: this.#parentRef(mint), startedAt: null, state: "quiet", ratio: null, peakRatio: null,
        buyers5m: fresh ? P.lastAll : 0, trades5m: fresh ? P.lastTrades : 0, spark: null, baseline: null,
        coinsTrading: last ? last.size : 0, post: null, coins, more: 0, hidden: 0,
      },
    };
  }
}
