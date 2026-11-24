// Coin rows (GET /api/discover, /api/discover/:mint, /api/trending): the one row shape every Discover list shows a
// coin in, with its live numbers over a chosen timeframe (1m/5m/30m/1h), a 60-minute price line and its safety facts.
// The owner compared Discover with three popular trading terminals and asked for these numbers per row; a backtest
// found that "people still buying right now" is the one fact that marked moves that kept going (most coins that jump
// give it back within hours), so `/api/trending` ranks by buyers over the timeframe, never by price change.
// The rows state what was measured; nothing here says a coin will rise or is safe.
//
// What trending ranks by (a review of Nov 15-20 2026, each rule replayed over the stored trades by a second reader):
// - `holding`: the wallets that bought ($1+) in the window and have not sold that coin since their first buy in it.
//   Ranked by every buyer, a quarter of the 5m top 20 was a launch burst of wallets already out again; ranked by
//   holding about 3.6 of 20 rows swap, and the rows that leave had under 3 buyers ten minutes later in 79-82 % of cases.
//   It is only "bought and not sold in this window": wallets that never sell (a bundle) lose nothing, and one partial
//   sell takes a wallet out. Judged by the trades' own times, not the order they arrived in: rows read back from the
//   chain (model.storeFilled) are older than trades already held, and an older sale must not cancel a later buy.
// - 30m and 1h: a coin is listed only with ENTER_5M+ buyers in the last 5 minutes, and stays while it has STAY_5M+
//   (about a third of those lists were coins nobody was buying any more; 87-90 % of the rows this removes were dead
//   ten minutes later). The stay margin is there because the hard gate alone doubled how often rows came and went.
//   A coin that collapsed and is still being bought stays listed: this is not a price filter.
// - 1m: only coins with FLOOR_1M+ buyers in the last 60 s, so the list may be shorter than 50 (the bottom 30 rows
//   were coins with one or two buyers). It does not make the 1m list steadier; a 60 s window reshuffles by nature.
//
// The feed: every live trade (model.recordTrade) and the boot seed's rows of the last hour are kept in memory, in
// arrival order, as one small object each, for HOLD_S (an hour and a minute): O(1) amortized per trade (pushed once,
// let go from the head once). At most HOLD_MAX are held; past that the oldest leaves early (health `capped`), which
// only shortens what the numbers can see (p0 and the line's start then come from sqlite, below).
// Why memory and not sqlite: a pass over an hour of rows through a better-sqlite3 iterator holds the connection for
// the whole pass, so it could not be sliced without blocking every other query in between.
//
// The numbers: ONE pass over the held trades (sliced, lib/sliced.mjs: a yield every 1 024 trades) builds, per coin
// that traded in the held hour, the four timeframes at once (volume, buys, sells, distinct $1+ buyers, the first price
// in it and the last price at or before its start) and the 2-minute closes of the price line. One pass for all four is
// no more work than the 1 h pass alone, and every list on every timeframe reads the same snapshot, held SNAP_TTL_MS and
// shared by the askers that come together. A body (trending here, the wake-up list in lib/wakeups.mjs) is built once
// per snapshot and served as long as that snapshot is the current one: there is one cache level, so a body is never
// older than SNAP_TTL_MS (a body cached 5 s over a snapshot cached 5 s could be 10 s old on a 60 s window). A timeframe is the trailing window (now - tf, now] (unix s, server clock),
// like the wake rule's trailing window. Prices a row needs from before the held hour (its p0 when it did not trade in
// the hour before the timeframe started, the line's carry-in) are one indexed sqlite read each, only for rows listed,
// memoized in the snapshot.
//
// Memory: the held trades (one object each, about 80 bytes, at most HOLD_MAX) and the latest snapshot (per coin traded
// in the hour: 4 small counters and two 30-slot Float64Arrays; the per-timeframe wallet Maps (one number per wallet that
// bought or sold the coin in the window) are dropped when the pass ends), the mints the last 30m and 1h lists showed (at most
// TREND_MAX each), and the first stored trade time of undated coins listed (at most FIRST_MAX numbers).
import { performance } from "node:perf_hooks";
import { runSliced, drain } from "./sliced.mjs";
import { MIN_USD, EXISTING_S, r1, r2, byMint } from "./rowshared.mjs";
import { units } from "./pricing.mjs";
import { SOL_MINT } from "./jupiter.mjs";
import { imageProxyUrl } from "./meta.mjs";
import { postOf } from "./narrative.mjs";
import { groupStories } from "./stories.mjs";
import { loadSubjects, TABLE_URL } from "./subjects.mjs";

/** The timeframes a list can be asked over (s), in the order the snapshot keeps them. */
export const TF_S = Object.freeze({ "1m": 60, "5m": 300, "30m": 1800, "1h": 3600 });
export const TF_KEYS = Object.freeze(Object.keys(TF_S));
export const TF_DEFAULT = "5m";
/** The price line: 30 steps of 2 minutes, the last one the step now is in. */
export const SPARK_STEP = 120, SPARK_N = 30;
/** Trades held (s back from now; the hour plus a minute of block-time slack), and at most this many. */
export const HOLD_S = 3660, HOLD_MAX = 250_000;
/** A snapshot and a trending body are served this long. */
export const SNAP_TTL_MS = 5_000;
export { MIN_USD };
/** Below this market cap (USD) a coin is dust and left out of every list (an unknown cap is not dust). */
export const DUST_USD = 1_000;
/** Trending: rows at most, and candidates looked at most (most buyers first: a coin's first creator check may read sqlite). */
export const TREND_MAX = 50, TREND_SCAN = 400;
/** Stories (GET /api/stories): candidate rows grouped at most (the trending rules and rank, a wider cut: dust and copies fold away afterwards). */
export const STORY_ROWS = 150;
/** Trending over 1m lists only coins with this many distinct $1+ buyers in the last 60 s. */
export const FLOOR_1M = 5;
/** Trending over 30m and 1h: a coin enters with this many buyers in the last 5 minutes and stays while it has STAY_5M; "stays" means it was in the list built at most STAY_MS before. */
export const ENTER_5M = 3, STAY_5M = 1, STAY_MS = 120_000;
/** A row is `thin` when its market cap is at least THIN_MCAP_USD and over THIN_RATIO times its real liquidity. */
export const THIN_MCAP_USD = 1_000_000, THIN_RATIO = 100;
/** First stored trade times remembered for undated coins, at most. */
export const FIRST_MAX = 20_000;
/** A wallet's packed times (tfAgg): seconds past the window start, capped under OFF_N (the longest window is 3 600 s plus block-time slack). */
const OFF_N = 8192;
/** sqlite prices memoized per snapshot, at most. */
const MEMO_MAX = 4_096;
const NF = TF_KEYS.length;

const sig6 = (x) => Number(x.toPrecision(6));
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/**
 * One coin's counters over one timeframe while the pass runs: `bv` the USD of its buys (`v` is buys and sells), `w`
 * wallet -> its earliest $1+ buy and its latest sale in the window, as seconds past the window's start packed into one
 * number (buy x OFF_N + sale, 0: none), so no object per wallet. `buyers` the wallets with a buy, `holding` those with
 * no sale at or after it (a later buy does not bring a wallet back; a sale in the same second counts as after). Both
 * are kept as the trades come, in any order. The Map is dropped when the pass ends.
 */
function tfAgg() { return { v: 0, bv: 0, buys: 0, sells: 0, w: null, buyers: 0, holding: 0, ft: Infinity, fp: null, bt: -Infinity, bp: null }; }

/** Whether a row's coin is dust: a known market cap under DUST_USD. */
export const isDust = (row) => row.mcapUsd != null && row.mcapUsd < DUST_USD;

/** The `tf` query value as a timeframe key, the default when absent, null when it is no timeframe. */
export function parseTf(v) {
  if (v == null || v === "") return TF_DEFAULT;
  return typeof v === "string" && Object.hasOwn(TF_S, v) ? v : null;
}

export class CoinRows {
  /** `model`: the index (read only; its `wakeups` for creator facts, sniper shares and family states); `holders`: lib/holders.mjs (optional). */
  constructor({ model, holders = null, now = Date.now, log = console } = {}) {
    this.model = model; this.holders = holders; this.now = now; this.log = log; this.narr = null;
    this.a = []; this.h = 0; this.seq = 0; // held trades from `h` on, in arrival order: { m, t, b, u, v, p, s (arrival number) }
    this.hit = null; this.job = null;          // the latest snapshot and the build under way
    this.trend = new Map(); this.trendJobs = new Map(); // tf → { at, snap, body }, tf → its build
    this.story = new Map(); this.storyJobs = new Map(); // the same for the stories body
    this.listed = new Map();  // tf (30m, 1h), and "story:" + tf → { at, set }: the mints that list last showed (the stay rule)
    this.firstSeen = new Map(); // undated coin mint → its first stored trade's time (null when none), oldest first
    // lastTrendMs / trendMaxSliceMs: a trending build's CPU and its longest share of one event-loop turn; lastTrendWaitMs:
    // what the last uncached request waited for, wall clock ({ snap, build, total }). Health had no figure for trending.
    this.stats = { trades: 0, seedRows: 0, capped: 0, snaps: 0, lastSnapMs: null, maxSliceMs: 0, snapCoins: 0, trendBuilt: 0, lastTrendMs: null, trendMaxSliceMs: 0, lastTrendWaitMs: null, storiesBuilt: 0, lastStoriesMs: null, storiesMaxSliceMs: 0, served: 0, dbReads: 0, firstReads: 0 };
  }
  /** `narr`: the narrative tagger (lib/narrtags.mjs) or null: the stories body then has narrative cards and the snapshot offers it the coins with buyers. */
  attach({ holders, narr } = {}) { if (holders !== undefined) this.holders = holders; if (narr !== undefined) this.narr = narr; return this; }
  snapshot() { return { held: this.a.length - this.h, ...this.stats, holders: this.holders?.snapshot?.() ?? null }; }

  // ---------------------------------------------------------------- the feed
  /** One trade `{ mint, time, isBuy, valueUsd, user, priceUsd }` (live or the boot seed's): O(1) amortized. `seed`: counted apart. */
  record(t, { seed = false } = {}) {
    const time = Math.floor(Number(t?.time));
    if (!Number.isFinite(time) || typeof t.mint !== "string") return;
    const cut = Math.floor(this.now() / 1000) - HOLD_S;
    if (time <= cut) return; // the boot seed's 24 h: only its last hour is held
    this.#expire(cut); // may swap the array: read it after
    const a = this.a;
    if (a.length - this.h >= HOLD_MAX) { a[this.h++] = null; this.stats.capped++; }
    const p = num(t.priceUsd);
    a.push({ m: t.mint, t: time, b: !!t.isBuy, u: typeof t.user === "string" ? t.user : null, v: num(t.valueUsd) ?? 0, p: p > 0 ? p : null, s: ++this.seq });
    if (seed) this.stats.seedRows++; else this.stats.trades++;
  }
  /** Lets go of the held trades at the head that are past the hour; the array's dead head is dropped once it is most of it. */
  #expire(cut) {
    const a = this.a;
    while (this.h < a.length && a[this.h].t <= cut) a[this.h++] = null;
    if (this.h === a.length) { this.a = []; this.h = 0; }
    else if (this.h >= 1024 && this.h * 2 > a.length) { this.a = a.slice(this.h); this.h = 0; }
  }

  // ---------------------------------------------------------------- the snapshot
  /** The latest snapshot (built when older than SNAP_TTL_MS; one build shared by the askers that come together). */
  async snap() {
    const hit = this.hit;
    if (hit && this.now() - hit.at < SNAP_TTL_MS) return hit;
    if (!this.job) {
      this.job = runSliced(this.#snapGen()).then((run) => {
        this.stats.snaps++; this.stats.lastSnapMs = r2(run.cpuMs);
        if (run.maxSliceMs > this.stats.maxSliceMs) this.stats.maxSliceMs = r2(run.maxSliceMs);
        this.hit = run.value;
        return run.value;
      }).finally(() => { this.job = null; });
    }
    return this.job;
  }
  /** The snapshot a body may still be served from (younger than SNAP_TTL_MS), else null. */
  current() { const hit = this.hit; return hit && this.now() - hit.at < SNAP_TTL_MS ? hit : null; }
  /** The same build at once (tests, scripts). */
  snapNow() { this.hit = drain(this.#snapGen()); return this.hit; }

  /**
   * The pass, in steps: per coin, per timeframe k (window (cuts[k], now]): volume, buy volume, buys, sells, distinct $1+
   * buyers and how many of them have no sale at or after their first buy in it (by trade time, any sale counts), the
   * first priced trade in it (`ft`/`fp`) and the last priced trade at or before cuts[k] (`bt`/`bp`); the 2-minute closes
   * from `from` on (`st`/`sp`: the time and price of the latest priced trade in each step) and the latest priced trade
   * before `from` (`pt`/`pp`). Ties in time go to the trade that came later (a later print of the same second).
   */
  *#snapGen() {
    const at = this.now(), nowS = Math.floor(at / 1000);
    this.#expire(nowS - HOLD_S);
    const cuts = TF_KEYS.map((k) => nowS - TF_S[k]);
    const from = (Math.floor(nowS / SPARK_STEP) - (SPARK_N - 1)) * SPARK_STEP;
    const per = new Map();
    const a = this.a, end = a.length, seq = this.seq; // the trades this pass reads: arrival numbers up to `seq`
    for (let i = this.h, n = 0; i < end; i++) {
      if ((++n & 1023) === 0) yield;
      const e = a[i];
      if (!e) continue;
      let A = per.get(e.m);
      if (!A) per.set(e.m, A = { tf: [tfAgg(), tfAgg(), tfAgg(), tfAgg()], st: null, sp: null, pt: -Infinity, pp: null });
      const t = e.t, p = e.p;
      for (let k = 0; k < NF; k++) {
        const T = A.tf[k];
        if (t <= cuts[k]) { if (p != null && t >= T.bt) { T.bt = t; T.bp = p; } continue; }
        T.v += e.v;
        if (e.b) { T.buys++; T.bv += e.v; } else T.sells++;
        // A sale is kept for a wallet with no buy yet too: its buy may be a filled row still to come, or one under $1 so far.
        if (e.u && (!e.b || e.v >= MIN_USD)) {
          const W = (T.w ??= new Map()), v = W.get(e.u) ?? 0, off = Math.min(t - cuts[k], OFF_N - 1);
          let fb = Math.floor(v / OFF_N), ls = v % OFF_N;
          const held = fb > 0 && ls < fb;
          if (e.b) { if (fb === 0) T.buyers++; if (fb === 0 || off < fb) fb = off; } else if (off > ls) ls = off;
          const nv = fb * OFF_N + ls;
          if (nv !== v) { W.set(e.u, nv); T.holding += (fb > 0 && ls < fb) - held; }
        }
        if (p != null && t < T.ft) { T.ft = t; T.fp = p; }
      }
      if (p == null) continue;
      if (t < from) { if (t >= A.pt) { A.pt = t; A.pp = p; } continue; }
      if (!A.st) { A.st = new Float64Array(SPARK_N).fill(-Infinity); A.sp = new Float64Array(SPARK_N); }
      const j = Math.min(SPARK_N - 1, Math.floor((t - from) / SPARK_STEP));
      if (t >= A.st[j]) { A.st[j] = t; A.sp[j] = p; }
    }
    // The narrative tagger hears of every tracked coin with enough distinct buyers in the held hour (a check in memory
    // per coin, O(1) each: lib/narrtags.mjs offer). No stored trade is read for it.
    const nt = this.narr?.on ? this.narr : null, need = nt?.minBuyers ?? Infinity, coins = this.model.coins;
    let n = 0;
    for (const [m, A] of per) {
      if ((++n & 1023) === 0) yield;
      for (const T of A.tf) T.w = null;
      if (A.tf[NF - 1].buyers >= need && coins.get(m)?.tracked) nt.offer(m, A.tf[NF - 1].buyers);
    }
    this.stats.snapCoins = per.size;
    return { at, nowS, cuts, from, per, seq, memo: new Map() };
  }

  /** A price from sqlite (the last priced trade at or before `t`), memoized in the snapshot. */
  #dbPrice(snap, mint, t) {
    const key = `${mint}@${t}`;
    if (snap.memo.has(key)) return snap.memo.get(key);
    this.stats.dbReads++;
    let v = null;
    try { const r = this.model.db.usdPriceAt(mint, t); v = r && r.priceUsd > 0 ? r.priceUsd : null; } catch { v = null; }
    if (snap.memo.size < MEMO_MAX) snap.memo.set(key, v);
    return v;
  }

  // ---------------------------------------------------------------- one row
  /** USD price now: the model's (from reserves), else the newest stored trade's (a coin under a stock/asset or newer coin parent); `px` a build's memo. */
  priceUsdOf(c, px) {
    const pr = this.model.priceOf(c.mint);
    const usd = num(pr?.priceUsd);
    if (usd != null) return usd;
    return this.lastUsd(c.mint, px);
  }
  /** The newest stored trade's USD price, once per build (`px`). */
  lastUsd(mint, px) {
    if (px.has(mint)) return px.get(mint);
    let v = null;
    try { v = num(this.model.db.lastPriceUsd(mint)); } catch { v = null; }
    px.set(mint, v);
    return v;
  }
  /**
   * Liquidity in USD: the real quote side (the curve's real quote reserves, the pool's quote vault once migrated, as
   * the model reads locked value) times the quote's USD price. Not pricing.mjs liqQuoteOf: on the curve that is the
   * virtual reserves, which include the curve's starting virtual quote (about 30 SOL on pump.fun), so a coin with $40
   * of real buys read as thousands of dollars of liquidity and dropped by that much when it migrated. The map's mcap
   * cap keeps its own virtual reading on purpose.
   */
  liqUsdOf(c, px) {
    let q = null;
    try {
      const raw = c.migrated ? c.poolQuote : c.realQuoteReserves, d = this.model.quoteDecimals(c);
      q = raw == null || d == null ? null : units(raw, d);
    } catch { q = null; }
    if (q == null || !Number.isFinite(q)) return null;
    const qm = c.quoteMint ?? SOL_MINT;
    let qu = num(this.model.quoteUsdOf(qm));
    if (qu == null && this.model.coins.has(qm)) qu = this.lastUsd(qm, px);
    return qu == null ? null : r2(q * qu);
  }

  /** The 2-minute line of a coin: USD closes, carried forward, null before its first priced trade. */
  #spark(snap, A, mint) {
    let cur = A?.pp ?? null;
    if (cur == null) cur = this.#dbPrice(snap, mint, snap.from - 1);
    const p = new Array(SPARK_N);
    for (let j = 0; j < SPARK_N; j++) {
      if (A?.st && A.st[j] > -Infinity) cur = A.sp[j];
      p[j] = cur == null ? null : sig6(cur);
    }
    return { from: snap.from, step: SPARK_STEP, p };
  }

  /**
   * The shared COIN ROW (README §API) of coin `c` over timeframe `tf`: `at` the time `existing` is measured from (a
   * wake-up's start, else now), `sinceStart` the family's measure (null outside a wake-up), `px` the build's memo of
   * stored prices. `safety` false leaves `safety` null for the caller to fill once it knows the row is listed: asking
   * lib/holders.mjs queues chain reads (never awaited), and a dust row that is then dropped must not cost any.
   */
  row(c, snap, tf, { at = snap.nowS, sinceStart = null, px = new Map(), safety = true } = {}) {
    const model = this.model, m = c.mint, k = TF_KEYS.indexOf(tf), A = snap.per.get(m);
    const r = model.ref(c);
    const priceUsd = this.priceUsdOf(c, px);
    let mcapUsd = null;
    try { const v = priceUsd == null ? null : r2(priceUsd * units(c.tokenTotalSupply ?? 0, model.decimalsOf(m))); mcapUsd = Number.isFinite(v) ? v : null; } catch { mcapUsd = null; }
    const T = A?.tf[k];
    let p0 = T?.bp ?? null;
    if (p0 == null) p0 = this.#dbPrice(snap, m, snap.cuts[k]);
    if (p0 == null) p0 = T?.fp ?? null;
    const chg = p0 > 0 && priceUsd != null ? r1((priceUsd / p0 - 1) * 100) : null;
    const T5 = A?.tf[1], liqUsd = this.liqUsdOf(c, px);
    return {
      mint: m, name: r.name, symbol: r.symbol, image: r.image, createdAt: c.createdAt ?? null,
      existing: c.createdAt == null || c.createdAt < at - EXISTING_S, mcapUsd, priceUsd, sinceStart,
      buyers5m: T5 ? T5.buyers : 0,
      tf: { p0, chg: Number.isFinite(chg) ? chg : null, volUsd: r2(T?.v ?? 0), buys: T?.buys ?? 0, sells: T?.sells ?? 0, buyers: T?.buyers ?? 0, holding: T?.holding ?? 0 },
      liqUsd,
      spark: this.#spark(snap, A, m),
      safety: safety ? this.safetyOf(c) : null,
      // An undated coin (the creation probe gave up on a busy curve) is not an old coin: a third of the undated rows
      // in the 5m top 20 had their first stored trade under 2 h earlier. So the page gets a lower bound, never "old".
      firstSeenAt: c.createdAt == null ? this.#firstSeenOf(m) : null,
      graduated: !!c.migrated,
      // A large nominal cap on almost no real liquidity (the cap is price x supply; under about 1 % of it is in the
      // pool). Only from $1M: a curve coin sold back to its starting price has near-zero real reserves at a $3K cap,
      // and that is an ordinary child, not this. Unknown cap or liquidity: not flagged.
      thin: mcapUsd != null && liqUsd != null && mcapUsd >= THIN_MCAP_USD && mcapUsd > THIN_RATIO * liqUsd,
    };
  }

  /**
   * An undated coin's first stored trade (unix s; null when it has none), one indexed read per coin, then remembered.
   * Remembered for the process's life on purpose: the per-mint trim deletes a busy coin's oldest rows, so a fresh read
   * would move the time forward and "seen 40m+" would shrink; the first value read stays a true lower bound.
   */
  #firstSeenOf(mint) {
    const F = this.firstSeen;
    if (F.has(mint)) return F.get(mint);
    let v = null;
    this.stats.firstReads++;
    try { v = num(this.model.db.tradeFirstTime(mint)); } catch { v = null; }
    F.set(mint, v);
    if (F.size > FIRST_MAX) F.delete(F.keys().next().value);
    return v;
  }

  /** `{ devPct, top10Pct, sniperPct, state }`: holder facts from lib/holders.mjs (state theirs; "unknown" without one), the sniper share from the recorded launch (lib/wakeups.mjs). `holders` false asks for no holder facts (no chain read is queued): the sniper share only. */
  safetyOf(c, { holders = true } = {}) {
    let h = null;
    try { h = holders ? this.holders?.get(c) ?? null : null; } catch (e) { this.log.warn?.(`coinrows: holders ${c.mint}: ${e?.message ?? e}`); }
    let sniperPct = null;
    try { sniperPct = this.model.wakeups?.sniperOf?.(c) ?? null; } catch (e) { this.log.warn?.(`coinrows: sniper ${c.mint}: ${e?.message ?? e}`); }
    return { devPct: h?.devPct ?? null, top10Pct: h?.top10Pct ?? null, sniperPct, state: h?.state ?? "unknown" };
  }

  // ---------------------------------------------------------------- trending
  /**
   * The body of GET /api/trending?tf= (README §API): coins ranked by `holding` (wallets that bought $1+ in the timeframe
   * and have not sold since), then its USD volume, then the mint; without creator-fact coins (lib/wakeups.mjs), coins
   * nobody bought and dust; over 1m only coins with FLOOR_1M+ buyers, over 30m and 1h only coins still being bought
   * (the head of the file). Each row names its parent (null for a coin priced in SOL) and whether that family is
   * waking up. Built once per snapshot and served while that snapshot is current.
   */
  async trending(tf) {
    this.stats.served++;
    const hit = this.trend.get(tf);
    if (hit && hit.snap === this.current()) return hit.body;
    let job = this.trendJobs.get(tf);
    if (!job) {
      const t0 = performance.now();
      let t1 = t0;
      job = this.snap().then((snap) => { t1 = performance.now(); return runSliced(this.#trendGen(snap, tf)); }).then((run) => {
        const t2 = performance.now();
        this.stats.trendBuilt++; this.stats.lastTrendMs = r2(run.cpuMs);
        if (run.maxSliceMs > this.stats.trendMaxSliceMs) this.stats.trendMaxSliceMs = r2(run.maxSliceMs);
        this.stats.lastTrendWaitMs = { snap: r2(t1 - t0), build: r2(t2 - t1), total: r2(t2 - t0) };
        this.trend.set(tf, run.value);
        return run.value.body;
      }).finally(() => this.trendJobs.delete(tf));
      this.trendJobs.set(tf, job);
    }
    return job;
  }

  /**
   * In steps: one over the snapshot's coins (a yield every 1 024) to pick the candidates, a sort, then a yield after
   * every candidate looked at: its first creator check, sniper share and stored prices may each read sqlite, and the
   * shared scheduler keeps stepping one job until its 8 ms are spent, so the extra yields cost nothing.
   */
  *#trendGen(snap, tf) {
    const p = yield* this.#pickGen(snap, tf, { max: TREND_MAX, listKey: tf, safety: true });
    // `floor`: the buyers a coin needs over this timeframe to be listed (0: none); `floor5m`: the buyers in the last 5
    // minutes it needs to enter (0: none); `candidates`: the tracked coins that met them, before creator facts, dust and the cap.
    return { at: p.at, snap, body: { asOf: snap.nowS, tf, floor: p.floor, floor5m: p.floor5m, candidates: p.candidates, rows: p.rows } };
  }

  /**
   * The rows of a list over `tf` by the trending rules, at most `max`, in rank order: `{ at, floor, floor5m,
   * candidates, rows }`. `listKey`: where this list keeps the mints it showed for the stay rule (each list its own, so
   * one never keeps a coin in the other); `safety` false leaves every row's `safety` null for the caller to fill.
   */
  *#pickGen(snap, tf, { max, listKey, safety }) {
    const model = this.model, wk = model.wakeups, k = TF_KEYS.indexOf(tf), at = this.now();
    const floor = tf === "1m" ? FLOOR_1M : 0, gate = TF_S[tf] > TF_S[TF_DEFAULT];
    const last = gate ? this.listed.get(listKey) : null, stay = last && at - last.at <= STAY_MS ? last.set : null;
    const cands = [];
    let n = 0;
    for (const [m, A] of snap.per) {
      if ((++n & 1023) === 0) yield;
      const T = A.tf[k];
      if (T.buyers < 1 || T.buyers < floor) continue;
      if (!model.coins.get(m)?.tracked) continue; // never listed: not counted in `candidates` either
      if (gate) { const b5 = A.tf[1].buyers; if (b5 < ENTER_5M && !(b5 >= STAY_5M && stay?.has(m))) continue; }
      cands.push({ m, h: T.holding, v: T.v });
    }
    yield;
    cands.sort((x, y) => y.h - x.h || y.v - x.v || byMint(x.m, y.m));
    const rows = [], px = new Map();
    let seen = 0;
    for (const x of cands) {
      if (rows.length >= max || seen >= TREND_SCAN) break;
      seen++;
      yield;
      const c = model.coins.get(x.m);
      if (!c || !c.tracked || wk?.deadWhy(c, at)) continue;
      const row = this.row(c, snap, tf, { sinceStart: wk?.sinceStartOf?.(c) ?? null, px, safety: false });
      if (isDust(row)) continue;
      if (safety) row.safety = this.safetyOf(c);
      const q = c.quoteMint;
      row.parent = q && q !== SOL_MINT ? this.#parentRef(q) : null;
      row.family = q && q !== SOL_MINT ? wk?.familyState?.(q) ?? null : null;
      rows.push(row);
    }
    if (gate) this.listed.set(listKey, { at, set: new Set(rows.map((r) => r.mint)) });
    return { at, floor, floor5m: gate ? ENTER_5M : 0, candidates: cands.length, rows };
  }
  // Not the cards' parent ref (lib/wakeups.mjs: name and isCoin too): a trending row only draws the parent's ticker and logo.
  #parentRef(mint) { return { mint, symbol: this.model.nameOf(mint).symbol, image: imageProxyUrl(this.model.imageOfMint(mint)) }; }

  // ---------------------------------------------------------------- stories
  /**
   * The body of GET /api/stories?tf= (README §API): the trending rows (same rules and rank, up to STORY_ROWS) grouped
   * by lib/stories.mjs into cards (an X post coins link, a family waking up), the loose rows of no card, and the bot
   * dust apart. Built once per snapshot and served while that snapshot is current, like trending. The waking families
   * come from the wake-up list's own build over the same timeframe (lib/wakeups.mjs storyWakes).
   */
  async stories(tf) {
    this.stats.served++;
    const hit = this.story.get(tf);
    if (hit && hit.snap === this.current()) return hit.body;
    let job = this.storyJobs.get(tf);
    if (!job) {
      const wk = this.model.wakeups;
      const wakes = wk?.storyWakes ? wk.storyWakes(tf).catch((e) => { this.log.warn?.(`coinrows: story wake-ups: ${e?.message ?? e}`); return new Map(); }) : new Map();
      job = Promise.all([this.snap(), wakes]).then(([snap, w]) => runSliced(this.#storyGen(snap, tf, w))).then((run) => {
        this.stats.storiesBuilt++; this.stats.lastStoriesMs = r2(run.cpuMs);
        if (run.maxSliceMs > this.stats.storiesMaxSliceMs) this.stats.storiesMaxSliceMs = r2(run.maxSliceMs);
        this.story.set(tf, run.value);
        return run.value.body;
      }).finally(() => this.storyJobs.delete(tf));
      this.storyJobs.set(tf, job);
    }
    return job;
  }

  /**
   * `{ handle, text }` of post `id` when both are stored and may be shown, else null (not fetched yet, gone, refused,
   * flagged). Asking queues the text's fetch at low priority (lib/xposts.mjs: such asks stop at half its line and half
   * its day), so a post nobody opened a coin page for still gets its card a little later.
   */
  #storyPost(id) {
    const n = this.model.wakeups?.narrative;
    if (!n?.postState) return null;
    try {
      const s = n.postState(id, { low: true });
      if (s.state !== "ok" || !s.handle || n.posts?.peek?.(id)?.flagged) return null;
      return { handle: s.handle, text: s.text ?? "" };
    } catch (e) { this.log.warn?.(`coinrows: post ${id}: ${e?.message ?? e}`); return null; }
  }

  /**
   * Sets `card.buyers` on each card: the distinct wallets with a $1+ buy (MIN_USD, as the rows' `tf.buyers`) in the
   * timeframe's window, over every coin of the card, copies included: the very trades the snapshot read (arrival
   * numbers up to `snap.seq`, trade time after cuts[k] with no upper bound, as the rows), so it never exceeds the sum of
   * the rows. A held trade let go since the snapshot (past the hour, or the cap) is missed: a few wallets low at most.
   */
  *#cardBuyersGen(snap, tf, cards) {
    const k = TF_KEYS.indexOf(tf), cut = snap.cuts?.[k], seq = snap.seq;
    const of = new Map(), sets = cards.map(() => new Set());
    cards.forEach((c, i) => { for (const r of c.coins ?? []) { of.set(r.mint, i); for (const cp of r.copies ?? []) of.set(cp.mint, i); } });
    if (k < 0 || !Number.isFinite(cut) || !Number.isFinite(seq) || !of.size) { for (const c of cards) c.buyers = null; return; }
    const a = this.a, end = a.length; // a swap during a yield leaves this array as it was: read on
    for (let i = this.h, n = 0; i < end; i++) {
      if ((++n & 1023) === 0) yield;
      const e = a[i];
      if (!e) continue;
      if (e.s > seq) break; // arrived after the snapshot: so did every later one
      if (!e.b || !e.u || e.v < MIN_USD || e.t <= cut) continue;
      const ci = of.get(e.m);
      if (ci !== undefined) sets[ci].add(e.u);
    }
    cards.forEach((c, i) => { c.buyers = sets[i].size; });
  }

  /** In steps: the rows (#pickGen), each row's post link (a yield every 32: a metadata read each), the grouping, then the safety facts of the rows listed. */
  *#storyGen(snap, tf, wakes) {
    const model = this.model;
    const p = yield* this.#pickGen(snap, tf, { max: STORY_ROWS, listKey: `story:${tf}`, safety: false });
    const ids = new Map();
    let n = 0;
    for (const r of p.rows) {
      if ((++n & 31) === 0) yield;
      const c = model.coins.get(r.mint);
      let id = null;
      try { id = c ? postOf(model.metaFor(c)) : null; } catch { id = null; }
      if (id) ids.set(r.mint, id);
    }
    yield;
    // Narrative tags (lib/narrtags.mjs), when the server runs them: the page's coins go to the head of the tagger's
    // line, and each row's stored tag is read (memory, else one indexed read the first time: a yield every 32).
    const nt = this.narr?.on ? this.narr : null, tags = new Map();
    if (nt) {
      n = 0;
      for (const r of p.rows) {
        if ((++n & 31) === 0) yield;
        try {
          nt.offer(r.mint, snap.per.get(r.mint)?.tf[NF - 1].buyers ?? 0, { hot: true });
          const t = nt.tagOf(r.mint);
          if (t) tags.set(r.mint, t);
        } catch (e) { this.log.warn?.(`coinrows: narrative tag ${r.mint}: ${e?.code ?? e?.name ?? "error"}`); }
      }
      yield;
    }
    const g = groupStories({ rows: p.rows, postIdOf: (r) => ids.get(r.mint) ?? null, postOf: (id) => this.#storyPost(id), wakes, nowMs: p.at,
      tagOf: nt ? (r) => tags.get(r.mint) ?? null : null, newCoins1hOf: nt ? (id) => nt.newCoins1h(id, snap.nowS) : undefined,
      subjectOf: nt ? (this.subjects ??= loadSubjects(TABLE_URL, this.log) ?? (() => null)) : null });
    // Each card's buyers counted once: the distinct wallets with a $1+ buy in the timeframe (the snapshot's window) over
    // all its coins, copies included. A wallet in three Jensen coins is one buyer of the Jensen block, not three. One
    // pass over the held trades (a yield every 1024); the summed per-coin figures stay on the rows.
    yield* this.#cardBuyersGen(snap, tf, g.cards);
    let tagging = { on: false, tagged: 0, pending: 0, capped: false };
    try { if (nt) tagging = nt.pageStats(); } catch { /* reads as off */ }
    yield;
    // Only rows the body lists may queue holder reads, the cards' first; a dust row asks for none.
    const fill = (r, holders) => { const c = model.coins.get(r.mint); r.safety = c ? this.safetyOf(c, { holders }) : { devPct: null, top10Pct: null, sniperPct: null, state: "unknown" }; };
    for (const card of g.cards) { yield; for (const r of card.coins) fill(r, true); }
    // Story attention (lib/attention.mjs): read from memory, one card a step (a card's open-bucket buyers are merged).
    const att = model.attention;
    if (att) for (const card of g.cards) { yield; try { card.attention = att.cardAttention(card, snap.nowS); } catch (e) { card.attention = null; this.log.warn?.(`coinrows: attention ${card.key}: ${e?.message ?? e}`); } }
    yield;
    for (const r of g.loose) fill(r, true);
    yield;
    for (const r of g.dust) fill(r, false);
    return { at: p.at, snap, body: { asOf: snap.nowS, tf, floor: p.floor, floor5m: p.floor5m, candidates: p.candidates, cards: g.cards, loose: g.loose, dust: g.dust, hidden: g.hidden, tagging, themes: g.themes } };
  }
}
