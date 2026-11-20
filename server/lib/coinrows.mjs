// Coin rows (GET /api/discover, /api/discover/:mint, /api/trending): the one row shape every Discover list shows a
// coin in, with its live numbers over a chosen timeframe (1m/5m/30m/1h), a 60-minute price line and its safety facts.
// The owner compared Discover with three popular trading terminals and asked for these numbers per row; a backtest
// found that "people still buying right now" is the one fact that marked moves that kept going (most coins that jump
// give it back within hours), so `/api/trending` ranks by distinct buyers over the timeframe, never by price change.
// The rows state what was measured; nothing here says a coin will rise or is safe.
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
// shared by the askers that come together. A timeframe is the trailing window (now - tf, now] (unix s, server clock),
// like the wake rule's trailing window. Prices a row needs from before the held hour (its p0 when it did not trade in
// the hour before the timeframe started, the line's carry-in) are one indexed sqlite read each, only for rows listed,
// memoized in the snapshot.
//
// Memory: the held trades (one object each, about 80 bytes, at most HOLD_MAX) and the latest snapshot (per coin traded
// in the hour: 4 small counters and two 30-slot Float64Arrays; the buyer Sets are dropped once counted).
import { runSliced, drain } from "./sliced.mjs";
import { units } from "./pricing.mjs";
import { SOL_MINT } from "./jupiter.mjs";
import { imageProxyUrl } from "./meta.mjs";

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
/** A buy counts as a buyer from this value (USD), as the wake rule does. */
export const MIN_USD = 1;
/** Below this market cap (USD) a coin is dust and left out of every list (an unknown cap is not dust). */
export const DUST_USD = 1_000;
/** Trending: rows at most, and candidates looked at most (most buyers first: a coin's first creator check may read sqlite). */
export const TREND_MAX = 50, TREND_SCAN = 400;
/** sqlite prices memoized per snapshot, at most. */
const MEMO_MAX = 4_096;
const NF = TF_KEYS.length;

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const sig6 = (x) => Number(x.toPrecision(6));
const byMint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** One coin's counters over one timeframe while the pass runs (the Set becomes a count when it ends). */
function tfAgg() { return { v: 0, buys: 0, sells: 0, set: null, buyers: 0, ft: Infinity, fp: null, bt: -Infinity, bp: null }; }

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
    this.model = model; this.holders = holders; this.now = now; this.log = log;
    this.a = []; this.h = 0; // held trades from `h` on, in arrival order: { m, t, b, u, v, p }
    this.hit = null; this.job = null;          // the latest snapshot and the build under way
    this.trend = new Map(); this.trendJobs = new Map(); // tf → { at, body }, tf → its build
    this.stats = { trades: 0, seedRows: 0, capped: 0, snaps: 0, lastSnapMs: null, maxSliceMs: 0, snapCoins: 0, trendBuilt: 0, served: 0, dbReads: 0 };
  }
  attach({ holders } = {}) { if (holders !== undefined) this.holders = holders; return this; }
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
    a.push({ m: t.mint, t: time, b: !!t.isBuy, u: typeof t.user === "string" ? t.user : null, v: num(t.valueUsd) ?? 0, p: p > 0 ? p : null });
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
  /** The same build at once (tests, scripts). */
  snapNow() { this.hit = drain(this.#snapGen()); return this.hit; }

  /**
   * The pass, in steps: per coin, per timeframe k (window (cuts[k], now]): volume, buys, sells, distinct $1+ buyers, the
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
    const a = this.a, end = a.length;
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
        if (e.b) { T.buys++; if (e.v >= MIN_USD && e.u) (T.set ??= new Set()).add(e.u); } else T.sells++;
        if (p != null && t < T.ft) { T.ft = t; T.fp = p; }
      }
      if (p == null) continue;
      if (t < from) { if (t >= A.pt) { A.pt = t; A.pp = p; } continue; }
      if (!A.st) { A.st = new Float64Array(SPARK_N).fill(-Infinity); A.sp = new Float64Array(SPARK_N); }
      const j = Math.min(SPARK_N - 1, Math.floor((t - from) / SPARK_STEP));
      if (t >= A.st[j]) { A.st[j] = t; A.sp[j] = p; }
    }
    let n = 0;
    for (const A of per.values()) {
      if ((++n & 1023) === 0) yield;
      for (const T of A.tf) { T.buyers = T.set ? T.set.size : 0; T.set = null; }
    }
    this.stats.snapCoins = per.size;
    return { at, nowS, cuts, from, per, memo: new Map() };
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
    const T5 = A?.tf[1];
    return {
      mint: m, name: r.name, symbol: r.symbol, image: r.image, createdAt: c.createdAt ?? null,
      existing: c.createdAt == null || c.createdAt < at - 1800, mcapUsd, priceUsd, sinceStart,
      buyers5m: T5 ? T5.buyers : 0,
      tf: { p0, chg: Number.isFinite(chg) ? chg : null, volUsd: r2(T?.v ?? 0), buys: T?.buys ?? 0, sells: T?.sells ?? 0, buyers: T?.buyers ?? 0 },
      liqUsd: this.liqUsdOf(c, px),
      spark: this.#spark(snap, A, m),
      safety: safety ? this.safetyOf(c) : null,
    };
  }

  /** `{ devPct, top10Pct, sniperPct, state }`: holder facts from lib/holders.mjs (state theirs; "unknown" without one), the sniper share from the recorded launch (lib/wakeups.mjs). */
  safetyOf(c) {
    let h = null;
    try { h = this.holders?.get(c) ?? null; } catch (e) { this.log.warn?.(`coinrows: holders ${c.mint}: ${e?.message ?? e}`); }
    let sniperPct = null;
    try { sniperPct = this.model.wakeups?.sniperOf?.(c) ?? null; } catch (e) { this.log.warn?.(`coinrows: sniper ${c.mint}: ${e?.message ?? e}`); }
    return { devPct: h?.devPct ?? null, top10Pct: h?.top10Pct ?? null, sniperPct, state: h?.state ?? "unknown" };
  }

  // ---------------------------------------------------------------- trending
  /**
   * The body of GET /api/trending?tf= (README §API): coins ranked by distinct $1+ buyers over the timeframe, then its
   * USD volume, then the mint; without creator-fact coins (lib/wakeups.mjs), coins nobody bought and dust. Each row
   * names its parent (null for a coin priced in SOL) and whether that family is waking up. Cached SNAP_TTL_MS per tf.
   */
  async trending(tf) {
    this.stats.served++;
    const hit = this.trend.get(tf);
    if (hit && this.now() - hit.at < SNAP_TTL_MS) return hit.body;
    let job = this.trendJobs.get(tf);
    if (!job) {
      job = this.snap().then((snap) => runSliced(this.#trendGen(snap, tf))).then((run) => {
        this.stats.trendBuilt++;
        this.trend.set(tf, run.value);
        return run.value.body;
      }).finally(() => this.trendJobs.delete(tf));
      this.trendJobs.set(tf, job);
    }
    return job;
  }

  *#trendGen(snap, tf) {
    const model = this.model, wk = model.wakeups, k = TF_KEYS.indexOf(tf), at = this.now();
    const cands = [];
    let n = 0;
    for (const [m, A] of snap.per) {
      if ((++n & 1023) === 0) yield;
      const T = A.tf[k];
      if (T.buyers >= 1) cands.push({ m, b: T.buyers, v: T.v });
    }
    yield;
    cands.sort((x, y) => y.b - x.b || y.v - x.v || byMint(x.m, y.m));
    const rows = [], px = new Map();
    let seen = 0;
    for (const x of cands) {
      if (rows.length >= TREND_MAX || seen >= TREND_SCAN) break;
      if ((++seen & 7) === 0) yield;
      const c = model.coins.get(x.m);
      if (!c || !c.tracked || wk?.deadWhy(c, at)) continue;
      const row = this.row(c, snap, tf, { sinceStart: wk?.sinceStartOf?.(c) ?? null, px, safety: false });
      if (isDust(row)) continue;
      row.safety = this.safetyOf(c);
      const q = c.quoteMint;
      row.parent = q && q !== SOL_MINT ? this.#parentRef(q) : null;
      row.family = q && q !== SOL_MINT ? wk?.familyState?.(q) ?? null : null;
      rows.push(row);
    }
    return { at, body: { asOf: snap.nowS, tf, rows } };
  }
  #parentRef(mint) { return { mint, symbol: this.model.nameOf(mint).symbol, image: imageProxyUrl(this.model.imageOfMint(mint)) }; }
}
