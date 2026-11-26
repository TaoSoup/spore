// Name waves, shadow step (WAVES=shadow; the Discover grouping design's "wave", with the critique's fixes): a name
// feature (lib/name-features.mjs: a whole word, a camelCase part, or a known token + residual) launched by far more
// distinct creators in the last 6 or 24 h than its own 30-day share of all launches predicts forms a wave; every coin
// that carries that feature itself is a candidate (a star, never a chain: no coin joins through another coin). Nothing
// here reaches a card, the page or a model: it records, in its own tables, what such waves would have been, so a backtest
// can judge them. Zero model calls, zero network: posts, quoted posts and tags are read from what is already stored.
//
// The test (fix L: shares, not counts): with n distinct creators of the feature in the window, N_W all launches in it,
// e = (C + 0.5) / N_base x N_W the expected count from the baseline (lib/name-counts.mjs; a feature missing from it has
// C = 1, so an unseen word's prior is 1.5 / N_base, recorded on every row as c_missing), it forms when n >= 5,
// n >= 3 max(e, 1), the Poisson tail P(X >= n | e) <= 1e-4, its carriers have 3+ distinct contexts (fix F: the rest of the
// name once the feature, filler and digits are gone, all bare names counting as one; "~other" for a split), and the
// feature passes flagText (fix N). No formation before the baseline is ready (24+ clean hours, 20,000+ launches). The
// per-feature counts (creators and contexts per window) are kept incrementally as launches enter and leave the 6 h and
// 24 h windows, so a test is O(1) whatever the feature's size, and when a wave forms never depends on the wall clock.
//
// Membership (fixes A and K): r = min over windows with 5+ creators of e/n, e from max(share0, the current baseline
// share) so a lasting rise lifts its own baseline and stops taking members (the umbrella guard, critique C). r <= 0.1 joins
// by name (lexical); 0.1 < r <= 1/3 needs second evidence (the same post or quoted post as another carrier by another
// creator, a tag held by carriers of 2+ other creators, or 3+ and 10%+ of 10+ counted buyers shared with other carriers);
// above 1/3 it is not a candidate. A coin's home is decided once (lowest r, then the oldest wave, then the key) and never
// moves; every other candidacy is kept in wave_cands. A pending coin with no evidence by the later of launch + 6 h and
// formation + 15 min is "unconfirmed" (health tells apart those that could never have shown evidence: untracked, no
// trend-gate wallets).
//
// Associations recorded without a home (wave_cands): companions (a feature 2+ members of different creators also carry,
// e.g. "corleone" beside "veto") and the window's launches carrying one, and tracked coins that are not carriers but
// share a member's post or quoted post ("post-x"). Coins with no anchor can never be members; these rows measure them.
//
// Never stalls the loop: add() touches memory only (no database call); a formation records the wave and the launch that
// formed it, and queues the back-fill of the firing window and the companion pass as a job on the shared scheduler
// (lib/sliced.mjs), as is the hourly refresh; rows are buffered (launch rows and the others capped apart) and written
// every 5 s in one small transaction (500 launch rows, 200 others); the evidence pass runs once a minute on the same
// scheduler; the baseline is read in a worker; trims are chunked. A restart reloads 24 h of launches, the open waves,
// pending coins, and re-runs the back-fill of waves formed in the last 24 h (idempotent), so rows buffered at a crash
// are found again.
import { performance } from "node:perf_hooks";
import { nameFeatures, nameRest, nonAscii as hasNonAscii, featsText, parseFeats } from "./name-features.mjs";
import { runSliced } from "./sliced.mjs";
import { postOf } from "./narrative.mjs";

export const WAVE_RULES_V = 1;

/** Every threshold of the shadow step: hypotheses for the backtest, not settings. */
export const WAVE_DEFAULTS = Object.freeze({
  w6: 6 * 3600, w24: 24 * 3600, minN: 5, ratio: 3, nearRatio: 2, tailMax: 1e-4, minCtx: 3, lexR: 0.1, evR: 1 / 3,
  backfillMax: 2000, flushMs: 5000, flushLaunches: 500, flushOther: 200, launchBufMax: 20_000, otherBufMax: 15_000,
  ringMax: 100_000, listMax: 20_000, featuresMax: 200_000, pendingMax: 5000, openMax: 500, membersMax: 5000,
  endS: 24 * 3600, reuseS: 7 * 86_400, reopensMax: 20, testsPerHour: 300,
  pendingS: 6 * 3600, afterFormS: 900, evidenceMs: 60_000, watchMax: 5000, linkReads: 200, tagReads: 200, retryS: 600,
  evBuyers: 10, evShared: 3, evShare: 0.1, minUsd: 1, botCoins: 25, buyersMax: 200, walletsMax: 200_000,
  companionsMax: 200, holdMs: 60_000, holdMax: 2000, futureS: 60, pastS: 3600, tickMs: 5000,
  launchKeepS: 26 * 3600, keepS: 90 * 86_400, trimEveryMs: 3600_000, trimChunk: 2000, trimPauseMs: 250, restoreMax: 200_000,
});

const LN_TABLE = [0];
function lnFact(k) {
  if (k < 256) { for (let i = LN_TABLE.length; i <= k; i++) LN_TABLE[i] = LN_TABLE[i - 1] + Math.log(i); return LN_TABLE[k]; }
  return k * Math.log(k) - k + 0.5 * Math.log(2 * Math.PI * k) + 1 / (12 * k) - 1 / (360 * k ** 3);
}

/** P(X >= n) for X ~ Poisson(lambda): 60 terms from k = n, summed in log space. */
export function poissonTail(n, lambda, terms = 60) {
  if (n <= 0) return 1;
  if (!(lambda > 0)) return 0;
  const ll = Math.log(lambda), xs = [];
  let max = -Infinity;
  for (let k = n; k < n + terms; k++) { const x = -lambda + k * ll - lnFact(k); xs.push(x); if (x > max) max = x; }
  let s = 0;
  for (const x of xs) s += Math.exp(x - max);
  return Math.min(1, Math.exp(max) * s);
}

/** The formation test of one window: `{ pass, fail ("count" | "ratio" | "tail" | "ctx" | null), tail }`. */
export function formTest({ n, e, ctx }, cfg = WAVE_DEFAULTS) {
  if (n < cfg.minN) return { pass: false, fail: "count", tail: null };
  if (n < cfg.ratio * Math.max(e, 1)) return { pass: false, fail: "ratio", tail: null };
  const tail = poissonTail(n, e);
  if (tail > cfg.tailMax) return { pass: false, fail: "tail", tail };
  if (ctx < cfg.minCtx) return { pass: false, fail: "ctx", tail };
  return { pass: true, fail: null, tail };
}

/** "lexical" (r <= lexR), "evidence" (r <= evR, or no window with 5 creators: r null), or null (not a candidate). */
export function tierOf(r, cfg = WAVE_DEFAULTS) {
  if (r == null) return "evidence";
  if (r <= cfg.lexR) return "lexical";
  if (r <= cfg.evR) return "evidence";
  return null;
}

/** `w:<kind>-<feature>-<YYYYMMDD of t, UTC>`. */
export function waveKey(kind, feature, t) { return `w:${kind}-${feature}-${new Date(t * 1000).toISOString().slice(0, 10).replace(/-/g, "")}`; }

/** The home tie rule (fix K): lowest r (a null r is weakest), then the oldest wave, then the key. */
const tie = (a, b) => (a.r ?? Infinity) - (b.r ?? Infinity) || (a.formedT ?? 0) - (b.formedT ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const strip = (c) => ({ key: c.key, r: c.r == null ? null : Math.round(c.r * 1e5) / 1e5, how: c.how });
const inc = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const dec = (m, k) => { const v = (m.get(k) ?? 0) - 1; if (v > 0) m.set(k, v); else m.delete(k); };
const MULTI = "\u0000*";
const round = (x, d = 4) => (x == null ? null : Number(x.toPrecision(d)));
const SOL_MINT = "So11111111111111111111111111111111111111112";
/** Whether the indexer tracks a launch (its onCreate rule): a depth 0 coin is dropped unless a listed asset quotes it. */
const trackedAtLaunch = (e) => !(e.depth < 1 && !(e.quoteMint && e.quoteMint !== SOL_MINT));
/** The `k` largest entries of a count Map, most first then by key (linear, no sort of the whole Map). */
function topK(map, k) {
  const out = [];
  const before = (a, b) => a[1] > b[1] || (a[1] === b[1] && a[0] < b[0]);
  for (const e of map) {
    if (out.length === k && !before(e, out[k - 1])) continue;
    let i = out.length < k ? out.length : k - 1;
    while (i > 0 && before(e, out[i - 1])) { out[i] = out[i - 1]; i--; }
    out[i] = e;
  }
  return out.map(([a, b]) => [a, b]);
}

export class NameWaves {
  /**
   * `db` (lib/db.mjs), `model` (read only: tracked flag, metadata, held trades), `counts` (lib/name-counts.mjs NameCounts:
   * the baseline and the hourly counts), `flag(text)` (flagText), `now()` ms.
   */
  constructor({ db, model = null, counts = null, flag = () => false, now = Date.now, log = console, cfg = {} } = {}) {
    Object.assign(this, { db, model, counts, flag, now, log });
    this.cfg = { ...WAVE_DEFAULTS, ...cfg };
    this.posts = null; this.narr = null; this.gate = null;
    this.a = []; this.c6 = 0; this.c24 = 0; this.seq = 0;   // the ring of launches (24 h), arrival order, and the two window cursors
    this.byMint = new Map();                                 // mint → launch in the ring
    this.feats = new Map();                                  // feature → { f, list, lh, cr: [6 h, 24 h], cx, n, s, wave }
    this.open = new Map();                                   // feature → open wave
    this.waves = new Map();                                  // key → wave (open, or ended within the reuse period)
    this.ended = new Map();                                  // feature → its latest ended wave (reopen within reuseS)
    this.pending = new Map();                                // mint → pending coin, oldest first
    this.memo = new Map();                                   // mint → { post, quoted, tag, buyers, ... } (evidence, looked up once)
    this.walletsHeld = 0;
    this.bufL = []; this.bufO = []; this.dirty = new Set();
    this.hold = []; this.held = new Set(); this.holding = true; this.releasing = false;
    this.flagCache = new Map(); this.testsH = null; this.testsSet = new Set(); this.flaggedSet = new Set();
    this.timers = []; this.trimTimers = new Set(); this.evBusy = false; this.started = false; this.stopped = false;
    this.jobs = []; this.jobRun = null;                      // sliced jobs: formation back-fills, companion passes, the hourly refresh
    this.hourMark = null;
    this.stats = {
      launches: 0, dup: 0, ignored: 0, errors: 0, lastError: null, nonAscii: 0, untracked: 0, parts: 0, notReady: 0, loadMs: null, restored: 0, reBackfilled: 0,
      caps: { ring: 0, features: 0, list: 0, pending: 0, buffer: 0, bufferOther: 0, openWaves: 0, backfill: 0, watch: 0, wallets: 0, tests: 0, hold: 0 },
      rowsWritten: 0, dropped: 0, droppedOther: 0, writeErrors: 0, flushMs: 0, flushMaxMs: 0,
      waves: { formed: 0, reopened: 0, ended: 0, flagged: 0, tests: 0 },
      coins: { lexical: 0, post: 0, tag: 0, buyers: 0, pending: 0, unconfirmed: 0, noEvidence: 0, overBase: 0, companion: 0, postX: 0 },
      evidence: { passes: 0, cpuMs: 0, maxSliceMs: 0, watched: 0, linkReads: 0, tagReads: 0, trades: 0, coverage: 0, gateCoins: 0, cachedUntracked: 0 },
      add: { maxMs: 0, over1ms: 0 },
      jobs: { runs: 0, cpuMs: 0, maxSliceMs: 0, errors: 0 },
    };
  }

  /** The stored-data readers for evidence: `posts` (lib/xposts.mjs: linkOf only), `narr` (lib/narrtags.mjs: tagOf only), `gate` (the trend gate's watched launches). */
  attach({ posts, narr, gate } = {}) { if (posts !== undefined) this.posts = posts; if (narr !== undefined) this.narr = narr; if (gate !== undefined) this.gate = gate; return this; }

  // ---------------------------------------------------------------- lifecycle
  start() {
    if (this.started || this.stopped) return this;
    this.started = true; this.startedAt = this.now();
    this.counts?.start?.();
    try { this.#restore(); } catch (e) { this.stats.errors++; this.stats.lastError = `restore: ${e.message}`; this.log.warn?.(`waves: restore failed (${e.message})`); }
    this.hourMark = Math.floor(this.now() / 3600_000);
    const every = (ms, fn) => { const t = setInterval(() => { try { fn(); } catch (e) { this.stats.errors++; this.stats.lastError = e.message; } }, ms); t.unref?.(); this.timers.push(t); };
    every(this.cfg.tickMs, () => this.tick());
    every(this.cfg.evidenceMs, () => { this.evidencePass().catch(() => {}); });
    every(this.cfg.trimEveryMs, () => { this.trim(); });
    return this;
  }

  /**
   * Clears timers, writes what is buffered, stops the counts (their closed hours, their worker). Queued jobs are let go:
   * a restart runs the back-fill of every wave formed in the last 24 h again, and the hourly refresh runs next hour.
   */
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const t of this.trimTimers) clearTimeout(t);
    this.trimTimers.clear(); this.jobs = [];
    let guard = 1000;
    while ((this.bufL.length || this.bufO.length || this.dirty.size) && guard-- > 0) this.flush();
    return this.counts?.stop?.() ?? Promise.resolve();
  }

  // ---------------------------------------------------------------- the hot path
  /** One launch (a decoded CreateEvent) and its slot. Memory only; never throws. */
  add(e, slot = null) { // eslint-disable-line no-unused-vars
    const t0 = performance.now();
    try {
      if (!e?.mint || !e?.creator) { this.stats.ignored++; return; }
      if (this.byMint.has(e.mint) || this.held.has(e.mint)) { this.stats.dup++; return; }
      const nowMs = this.now(), nowS = Math.floor(nowMs / 1000);
      let t = Number(e.timestamp);
      if (!Number.isFinite(t) || t <= 0 || t > nowS + this.cfg.futureS || t < nowS - this.cfg.pastS) t = nowS;
      if (this.holding && !this.#release(nowMs)) {
        // until the first baseline has answered, splits would use no vocabulary: launches wait (seconds), then are split alike
        if (this.hold.length >= this.cfg.holdMax) { this.stats.caps.hold++; this.#releaseNow(); }
        else { this.hold.push({ e, t, seen: nowMs }); this.held.add(e.mint); return; }
      }
      this.#ingest(e, t, nowMs);
    } catch (x) { this.stats.errors++; this.stats.lastError = x?.message ?? String(x); }
    finally { const ms = performance.now() - t0; if (ms > this.stats.add.maxMs) this.stats.add.maxMs = Math.round(ms * 1000) / 1000; if (ms > 1) this.stats.add.over1ms++; }
  }

  /** A stretch (ms) the curve stream delivered nothing: the hours it covers are partial in the counts. */
  gap(fromMs, toMs) { try { this.counts?.gap?.(fromMs, toMs); } catch (e) { this.stats.errors++; this.stats.lastError = e.message; } }

  /** Whether held launches may go now; starts releasing them (in slices) when they may. */
  #release(nowMs) {
    if (!this.holding) return true;
    const ok = this.counts == null || this.counts.firstDone !== false || nowMs - (this.startedAt ?? nowMs) >= this.cfg.holdMs;
    if (!ok) return false;
    if (!this.hold.length) { this.holding = false; return true; }
    if (!this.releasing) {
      this.releasing = true;
      runSliced(this.#releaseGen()).catch((e) => { this.stats.errors++; this.stats.lastError = e.message; }).finally(() => { this.releasing = false; });
    }
    return false; // new launches queue behind the held ones, so arrival order is kept
  }
  *#releaseGen() {
    let n = 0;
    while (this.hold.length) {
      const x = this.hold.shift(); this.held.delete(x.e.mint);
      try { this.#ingest(x.e, x.t, x.seen); } catch (e) { this.stats.errors++; this.stats.lastError = e.message; }
      if ((++n & 31) === 0) yield;
    }
    this.holding = false;
  }
  #releaseNow() { while (this.hold.length) { const x = this.hold.shift(); this.held.delete(x.e.mint); this.#ingest(x.e, x.t, x.seen); } this.holding = false; }

  #ingest(e, t, seenMs) {
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000);
    this.#advance(nowS);
    const base = this.counts?.base ?? null;
    const fs = nameFeatures(e.name, e.symbol, base ? base.vocab() : null);
    const L = { mint: e.mint, t, seen: seenMs, creator: e.creator, name: e.name ?? "", symbol: e.symbol ?? "", bh: base?.H ?? null, home: null, pend: null, final: false, gone: false, i: 0, tracked: trackedAtLaunch(e),
      feats: fs.map((x) => ({ ...x, ctx: nameRest(e.name, x.f, x.how, x.other) })) };
    const na = hasNonAscii(e.name, e.symbol);
    this.stats.launches++; if (na) this.stats.nonAscii++;
    for (const x of fs) if (x.how === "s") this.stats.parts++;
    this.#push(L);
    this.counts?.add?.({ t, creator: e.creator, feats: fs, nonAscii: na });
    this.#bufLaunch(L);
    const cands = [];
    for (const x of L.feats) {
      if (x.skip) continue;
      const F = this.feats.get(x.f);
      if (!F) continue;
      if (F.wave) { const c = this.#candidate(F, F.wave, x, nowS); if (c) cands.push(c); continue; }
      const got = this.#tryForm(F, nowMs, L);
      if (got) cands.push({ key: got.wave.key, r: got.r, how: x.how, tier: tierOf(got.r, this.cfg), formedT: got.wave.formedT });
    }
    if (cands.length) { for (const c of cands) this.#bufCand(L, c); this.#decideNew(L, cands, nowS); }
  }

  // ---------------------------------------------------------------- ring and per-feature windows
  #push(L) {
    while (this.a.length - this.c24 >= this.cfg.ringMax) { this.stats.caps.ring++; this.#evict(); }
    L.i = ++this.seq;
    this.a.push(L); this.byMint.set(L.mint, L);
    for (const x of L.feats) {
      let F = this.feats.get(x.f);
      if (!F) {
        if (this.feats.size >= this.cfg.featuresMax) { this.stats.caps.features++; x.skip = true; continue; }
        this.feats.set(x.f, F = this.#newF(x.f));
      }
      if (F.list.length - F.lh >= this.cfg.listMax) { F.lh++; this.stats.caps.list++; }
      F.list.push(L);
      for (const w of [0, 1]) { inc(F.cr[w], L.creator); inc(F.cx[w], x.ctx); F.n[w]++; if (x.how === "s") F.s[w]++; }
    }
  }
  #newF(f) { return { f, list: [], lh: 0, cr: [new Map(), new Map()], cx: [new Map(), new Map()], n: [0, 0], s: [0, 0], wave: null }; }
  #leave(L, w) {
    for (const x of L.feats) {
      if (x.skip) continue;
      const F = this.feats.get(x.f);
      if (!F) continue;
      dec(F.cr[w], L.creator); dec(F.cx[w], x.ctx); F.n[w]--; if (x.how === "s") F.s[w]--;
    }
  }
  #evict() {
    const L = this.a[this.c24];
    if (this.c6 === this.c24) { this.#leave(L, 0); this.c6++; }
    this.#leave(L, 1); this.c24++;
    L.gone = true;
    if (this.byMint.get(L.mint) === L) this.byMint.delete(L.mint);
    for (const x of L.feats) {
      if (x.skip) continue;
      const F = this.feats.get(x.f);
      if (!F) continue;
      while (F.lh < F.list.length && F.list[F.lh].gone) F.lh++;
      if (F.lh >= F.list.length && F.n[1] <= 0 && !F.wave) { this.feats.delete(x.f); continue; } // an empty entry goes (list, counts)
      if (F.lh > 64 && F.lh * 2 > F.list.length) { F.list = F.list.slice(F.lh); F.lh = 0; }
    }
    if (this.c24 > 4096 && this.c24 * 2 > this.a.length) { this.a = this.a.slice(this.c24); this.c6 -= this.c24; this.c24 = 0; }
  }
  /** Moves the 6 h and 24 h cursors to `nowS` (launches leave in arrival order). */
  #advance(nowS) {
    const cut6 = nowS - this.cfg.w6, cut24 = nowS - this.cfg.w24;
    while (this.c6 < this.a.length && this.a[this.c6].t <= cut6) { this.#leave(this.a[this.c6], 0); this.c6++; }
    while (this.c24 < this.a.length && this.a[this.c24].t <= cut24) this.#evict();
  }
  #NW(w) { return this.a.length - (w === 0 ? this.c6 : this.c24); }
  /** The first ring sequence number inside window `w` (Infinity when it is empty). */
  #windowSeq(w) { const L = this.a[w === 0 ? this.c6 : this.c24]; return L ? L.i : Infinity; }

  // ---------------------------------------------------------------- formation
  #flagged(f) {
    let v = this.flagCache.get(f);
    if (v === undefined) { try { v = !!this.flag(f); } catch { v = false; } if (this.flagCache.size < 50_000) this.flagCache.set(f, v); }
    return v;
  }
  /** The current baseline share of `f` and its prior: `{ share, C, missing }`, or null without a baseline. */
  #shareNow(f) {
    const b = this.counts?.base;
    if (!b || !(b.launches > 0)) return null;
    const g = b.get(f);
    return { share: (g.C + 0.5) / b.launches, C: g.C, missing: g.missing };
  }

  #tryForm(F, nowMs, L) {
    const base = this.counts?.base;
    if (!base || !base.ready(nowMs)) { this.stats.notReady++; return null; }
    const nowS = Math.floor(nowMs / 1000);
    const sn = this.#shareNow(F.f);
    let prev = this.ended.get(F.f) ?? null;
    if (prev && !(prev.endedT >= nowS - this.cfg.reuseS)) prev = null;
    // within the reuse period the feature is tested against the higher of the ended wave's frozen share and today's
    const share = prev ? Math.max(prev.share0, sn.share) : sn.share;
    let best = null, near = null;
    for (const w of [0, 1]) {
      const n = F.cr[w].size;
      if (n < this.cfg.minN) continue;
      const NW = this.#NW(w), e = share * NW, ctx = F.cx[w].size;
      const t = formTest({ n, e, ctx }, this.cfg);
      if (t.pass) { best = { w, n, e, NW, ctx, tail: t.tail }; break; }
      if (!near && n >= this.cfg.nearRatio * Math.max(e, 1)) near = { w, n, e, NW, ctx, tail: t.tail ?? poissonTail(n, e), fail: t.fail };
    }
    if (best && this.#flagged(F.f)) {
      // fix N: a flagged anchor is counted and writes nothing
      const k = `${Math.floor(nowS / 3600)}:${F.f}`;
      if (!this.flaggedSet.has(k)) { this.flaggedSet.add(k); this.stats.waves.flagged++; }
      return null;
    }
    if (!best) { if (near && !this.#flagged(F.f)) this.#nearMiss(F, near, sn, nowS); return null; }
    if (!prev && this.open.size >= this.cfg.openMax) { this.stats.caps.openWaves++; return null; }
    return prev ? this.#reopen(prev, F, best, share, nowS, L) : this.#form(F, best, sn, share, base, nowS, L);
  }

  #nearMiss(F, near, sn, nowS) {
    const h = Math.floor(nowS / 3600);
    if (this.testsH !== h) { this.testsH = h; this.testsSet.clear(); }
    if (this.testsSet.has(F.f)) return;
    if (this.testsSet.size >= this.cfg.testsPerHour) { this.stats.caps.tests++; return; }
    this.testsSet.add(F.f); this.stats.waves.tests++;
    this.#bufOther(["waveTestPut", { h, feature: F.f, v: WAVE_RULES_V, win: near.w === 0 ? this.cfg.w6 : this.cfg.w24, n: near.n, ctx: near.ctx, e: round(near.e, 6), cBase: sn.C, cMissing: sn.missing, tail: round(near.tail, 4), fail: near.fail ?? "ratio" }]);
  }

  #winStats(F, w, share) {
    const n = F.cr[w].size, NW = this.#NW(w), e = share * NW;
    return { n, ctx: F.cx[w].size, launches: F.n[w], s: F.s[w], NW, e: round(e, 6), tail: n ? round(poissonTail(n, e), 4) : null };
  }
  /** r at `share` now: the minimum over the windows with minN+ creators of e/n (null when neither has them). */
  #rMin(F, share) {
    let r = null;
    for (const w of [0, 1]) {
      const n = F.cr[w].size;
      if (n < this.cfg.minN) continue;
      const x = (share * this.#NW(w)) / n;
      if (r == null || x < r) r = x;
    }
    return r;
  }

  /**
   * Records the wave and returns the formation r (the minimum over both windows, as rOf gives the next carrier) for the
   * launch that formed it; the back-fill of the firing window and the companion pass run as a sliced job (#fireJob).
   */
  #form(F, best, sn, share, base, nowS, L) {
    const win = best.w === 0 ? this.cfg.w6 : this.cfg.w24;
    const kind = F.s[best.w] * 2 > F.n[best.w] ? "seg" : "word";
    let key = waveKey(kind, F.f, nowS);
    for (let i = 2; this.waves.has(key); i++) key = `${waveKey(kind, F.f, nowS)}-${i}`;
    const r = this.#rMin(F, share);
    const wave = {
      key, feature: F.f, kind, v: WAVE_RULES_V, formedT: nowS, formedAt: nowS, win, n: best.n, ctx: best.ctx, e: round(best.e, 6), r: round(r, 6), tail: round(best.tail, 4), share0: share,
      cBase: sn.C, cMissing: sn.missing, baseN: base.launches, baseHours: base.hours, baseH: base.H, nWin: best.NW, lastT: nowS, endedT: null, reopens: 0, members: 0, pending: 0, unconfirmed: 0,
      over: 0, mem: [], compDone: new Set(),
      why: { v: WAVE_RULES_V, win6: this.#winStats(F, 0, share), win24: this.#winStats(F, 1, share), carriers: null, contexts: topK(F.cx[best.w], 5), first: [],
        elsewhere: null, prior: { C: sn.C, missing: sn.missing, share: round(share, 6), N: base.launches, hours: base.hours, H: base.H }, companions: [], reopens: [] },
    };
    F.wave = wave; this.open.set(F.f, wave); this.waves.set(key, wave);
    this.stats.waves.formed++;
    this.#bufOther(["wavePut", wave]);
    this.#job(this.#fireJob(wave, F, best.w, this.#windowSeq(best.w), L.i, r, nowS, L, true));
    return { wave, r };
  }

  #reopen(wave, F, best, share, nowS, L) {
    const r = this.#rMin(F, share);
    wave.endedT = null; wave.reopens++; wave.lastT = nowS;
    if (!wave.mem) wave.mem = [];
    if (!wave.compDone) wave.compDone = new Set();
    wave.why.reopens = [...(wave.why.reopens ?? []), { t: nowS, win: best.w === 0 ? this.cfg.w6 : this.cfg.w24, n: best.n, e: round(best.e, 6), ctx: best.ctx, tail: round(best.tail, 4), r: round(r, 6) }].slice(-this.cfg.reopensMax);
    F.wave = wave; this.open.set(F.f, wave); this.ended.delete(F.f); this.waves.set(wave.key, wave);
    this.dirty.add(wave.key); this.stats.waves.reopened++;
    this.#job(this.#fireJob(wave, F, best.w, this.#windowSeq(best.w), L.i, r, nowS, L, false));
    return { wave, r };
  }

  /**
   * The firing window's carriers (ring sequence numbers `fromSeq` to `toSeq`, oldest first) each become a candidate at
   * the formation r (at most backfillMax; `skip`, the launch that formed the wave, was decided by its caller); at a
   * formation the carriage, the first ten, those already housed elsewhere and the companions go into why. Idempotent:
   * candidacy rows are INSERT OR IGNORE and only pending coins are decided. Yields every 1,024 list entries.
   */
  *#fireJob(wave, F, w, fromSeq, toSeq, r, nowS, skip, formed) {
    const tier = tierOf(r, this.cfg);
    const carriage = { w: 0, p: 0, s: 0 }, first = [], per = formed ? new Map() : null;
    let k = 0, seen = 0, elsewhere = 0;
    const list = F.list, j0 = F.lh; // an eviction may swap F.list between steps: this array still holds the window
    for (let j = j0; j < list.length; j++) {
      if ((++seen & 1023) === 0) yield "fire";
      const x = list[j];
      if (x.i < fromSeq || x.gone) continue;
      if (x.i > toSeq) break;
      const ft = x.feats.find((y) => y.f === F.f);
      if (formed) {
        if (ft) carriage[ft.how]++;
        if (first.length < 10) first.push(x.mint);
        if (x !== skip && x.home) elsewhere++;
        for (const y of x.feats) { if (y.f === F.f) continue; let s = per.get(y.f); if (!s) per.set(y.f, s = new Set()); s.add(x.creator); }
      }
      if (x === skip) continue;
      if (k >= this.cfg.backfillMax) { if (k++ === this.cfg.backfillMax) this.stats.caps.backfill++; if (!formed) break; continue; }
      k++;
      this.#offer(x, { key: wave.key, r, how: ft?.how ?? "w", tier, formedT: wave.formedT }, nowS);
    }
    if (formed) {
      Object.assign(wave.why, { carriers: carriage, first, elsewhere });
      yield* this.#companionsGen(wave, per, w);
    }
    this.dirty.add(wave.key);
  }

  /**
   * Companions: features carried by 2+ carriers of different creators beside the anchor ("corleone" next to "veto"),
   * from `per` (feature → creators), recorded in why; the window's launches that carry one and not the anchor get a
   * 'companion' row in wave_cands, at most companionsMax per pass. Each companion's list is walked from its newest
   * launch back to the window's start, in place, yielding every 1,024 entries.
   */
  *#companionsGen(wave, per, w) {
    const counts = new Map();
    for (const [f, s] of per) if (s.size >= 2) counts.set(f, s.size);
    const comps = topK(counts, 10);
    wave.why.companions = comps;
    const ws = this.#windowSeq(w);
    let written = 0, seen = 0;
    outer: for (const [f] of comps) {
      if (written >= this.cfg.companionsMax) break;
      const G = this.feats.get(f);
      if (!G) continue;
      const list = G.list;
      for (let j = list.length - 1; j >= 0; j--) {
        if ((++seen & 1023) === 0) yield "companions";
        const x = list[j];
        if (x.i < ws) break;
        if (x.gone || wave.compDone.has(x.mint) || x.feats.some((y) => y.f === wave.feature)) continue;
        if (written >= this.cfg.companionsMax) break outer;
        wave.compDone.add(x.mint); written++;
        this.stats.coins.companion++;
        this.#bufOther(["waveCandPut", x.mint, wave.key, null, `companion:${f}`, x.t]);
      }
    }
    wave.why.companionLaunches = wave.compDone.size;
    this.dirty.add(wave.key);
  }

  // ---------------------------------------------------------------- sliced jobs
  /** Queues a generator on the waves' job runner: one runSliced job at a time, the queued generators in order. */
  #job(gen) { if (this.stopped) return; this.jobs.push(gen); this.#kick(); }
  #kick() {
    if (this.jobRun || this.stopped || !this.jobs.length) return;
    this.jobRun = runSliced(this.#jobsGen()).then((r) => {
      const s = this.stats.jobs;
      s.cpuMs = Math.round((s.cpuMs + r.cpuMs) * 10) / 10; if (r.maxSliceMs > s.maxSliceMs) s.maxSliceMs = Math.round(r.maxSliceMs * 10) / 10;
    }, (e) => { this.stats.errors++; this.stats.lastError = `job: ${e?.message ?? e}`; }).finally(() => { this.jobRun = null; this.#kick(); });
  }
  *#jobsGen() {
    while (this.jobs.length && !this.stopped) {
      const g = this.jobs.shift();
      this.stats.jobs.runs++;
      try { yield* g; } catch (e) { this.stats.jobs.errors++; this.stats.errors++; this.stats.lastError = `job: ${e?.message ?? e}`; }
      yield "job";
    }
  }
  /** Resolves once no job is queued or running (tests, replays). */
  async idle() { while (!this.stopped && (this.jobRun || this.jobs.length)) { this.#kick(); await this.jobRun; } }

  // ---------------------------------------------------------------- membership
  /** r of a carrier of an open wave now (this launch counted): min over windows with 5+ creators of e/n, e from max(share0, today's share). */
  rOf(F, wave) {
    const sn = this.#shareNow(F.f);
    return this.#rMin(F, Math.max(wave.share0, sn?.share ?? 0));
  }
  #candidate(F, wave, x, nowS) {
    const r = this.rOf(F, wave), tier = tierOf(r, this.cfg);
    if (!tier) { wave.over++; this.stats.coins.overBase++; return null; } // counted on the wave, no row
    wave.lastT = nowS; this.dirty.add(wave.key);
    return { key: wave.key, r, how: x.how, tier, formedT: wave.formedT };
  }
  #tracked(mint) { try { return this.model?.get?.(mint)?.tracked === true; } catch { return false; } }

  /** A later candidacy of a launch: recorded; joins a pending coin's candidates, decides it if lexical; a decided coin stays. */
  #offer(L, cand, nowS) {
    this.#bufCand(L, cand);
    if (L.home || L.final) return;
    if (L.pend) {
      const P = L.pend;
      if (!P.cands.some((c) => c.key === cand.key)) {
        P.cands.push(strip(cand));
        const w = this.waves.get(cand.key); if (w) { w.pending++; this.dirty.add(w.key); }
        P.until = Math.max(P.until, cand.formedT + this.cfg.afterFormS);
      }
      if (cand.tier === "lexical") this.#decide(P, cand, "lexical", { tier: "lexical", r: round(cand.r, 6) }, nowS);
      else this.#bufOther(["waveCoinCands", P.mint, P.cands]);
      return;
    }
    this.#decideNew(L, [cand], nowS);
  }

  #decideNew(L, cands, nowS) {
    const lex = cands.filter((c) => c.tier === "lexical").sort(tie);
    // tracked by the indexer's own rule at launch (the model has no row yet for a launch decided as it arrives)
    const tracked = L.tracked ?? this.#tracked(L.mint);
    if (!tracked) this.stats.untracked++;
    const row = { mint: L.mint, t: L.t, at: nowS, tracked, name: L.name, symbol: L.symbol, creator: L.creator, bh: L.bh, cands: cands.map(strip) };
    if (lex.length) {
      const home = lex[0], w = this.waves.get(home.key);
      L.home = home.key;
      if (w) { w.members++; if (w.mem.length < this.cfg.membersMax) w.mem.push(L); this.dirty.add(w.key); }
      this.stats.coins.lexical++;
      this.#bufOther(["waveCoinPut", { ...row, waveKey: home.key, reason: "lexical", r: home.r, decidedAt: nowS, how: home.how, why: { tier: "lexical", r: round(home.r, 6), of: lex.length } }]);
      return;
    }
    const P = { mint: L.mint, t: L.t, L, creator: L.creator, name: L.name, symbol: L.symbol, how: cands[0].how, bh: L.bh, cands: cands.map(strip), since: nowS, tracked,
      until: Math.max(L.t + this.cfg.pendingS, ...cands.map((c) => (c.formedT ?? nowS) + this.cfg.afterFormS)) };
    L.pend = P; this.pending.set(L.mint, P); this.stats.coins.pending++;
    for (const c of cands) { const w = this.waves.get(c.key); if (w) { w.pending++; this.dirty.add(w.key); } }
    this.#bufOther(["waveCoinPut", { ...row, waveKey: null, reason: "pending", r: cands[0].r, how: cands[0].how, why: { tier: "evidence" } }]);
    while (this.pending.size > this.cfg.pendingMax) { this.stats.caps.pending++; const old = this.pending.values().next().value; this.#expire(old, nowS, { over: true }); }
  }

  #decide(P, cand, reason, why, nowS) {
    if (this.pending.get(P.mint) !== P) return false;
    this.pending.delete(P.mint);
    for (const c of P.cands) { const w = this.waves.get(c.key); if (w) { w.pending = Math.max(0, w.pending - 1); this.dirty.add(w.key); } }
    const w = this.waves.get(cand.key);
    if (w) { w.members++; if (P.L && w.mem.length < this.cfg.membersMax) w.mem.push(P.L); this.dirty.add(w.key); }
    if (P.L) { P.L.home = cand.key; P.L.pend = null; }
    this.stats.coins[reason] = (this.stats.coins[reason] ?? 0) + 1;
    this.#bufOther(["waveCoinDecide", { mint: P.mint, waveKey: cand.key, reason, r: cand.r ?? null, decidedAt: nowS, how: cand.how ?? null, tracked: this.#tracked(P.mint), cands: P.cands, why }]);
    return true;
  }

  #expire(P, nowS, why = {}) {
    if (this.pending.get(P.mint) !== P) return;
    this.pending.delete(P.mint);
    for (const c of P.cands) { const w = this.waves.get(c.key); if (w) { w.pending = Math.max(0, w.pending - 1); w.unconfirmed++; this.dirty.add(w.key); } }
    if (P.L) { P.L.pend = null; P.L.final = true; }
    this.stats.coins.unconfirmed++;
    if (why.noEvidence) this.stats.coins.noEvidence++;
    this.#bufOther(["waveCoinDecide", { mint: P.mint, waveKey: null, reason: "unconfirmed", decidedAt: nowS, tracked: this.#tracked(P.mint), why }]);
  }

  // ---------------------------------------------------------------- evidence (once a minute, sliced)
  #memo(mint) { let m = this.memo.get(mint); if (!m) this.memo.set(mint, m = { post: null, quoted: undefined, tag: null, postAt: 0, linkAt: 0, tagAt: 0, buyers: null, everTracked: false, gateSeen: false, px: null }); return m; }
  #addBuyer(m, u) {
    if (!m.buyers) m.buyers = new Set();
    if (m.buyers.has(u) || m.buyers.size >= this.cfg.buyersMax) return;
    if (this.walletsHeld >= this.cfg.walletsMax) { this.stats.caps.wallets++; return; }
    m.buyers.add(u); this.walletsHeld++;
  }

  /** One evidence pass on the shared scheduler; resolves with its sliced result (or null when one is already running). */
  evidencePass() {
    if (this.evBusy || this.stopped) return Promise.resolve(null);
    this.evBusy = true;
    const nowS = Math.floor(this.now() / 1000);
    return runSliced(this.#evidenceGen(nowS)).then((r) => {
      const ev = this.stats.evidence;
      ev.passes++; ev.cpuMs = Math.round(r.cpuMs * 10) / 10; if (r.maxSliceMs > ev.maxSliceMs) ev.maxSliceMs = Math.round(r.maxSliceMs * 10) / 10;
      return r;
    }).catch((e) => { this.stats.errors++; this.stats.lastError = `evidence: ${e.message}`; return null; }).finally(() => { this.evBusy = false; });
  }

  *#evidenceGen(nowS) {
    const cfg = this.cfg, model = this.model, posts = this.posts, narr = this.narr, ev = this.stats.evidence;
    const st = { linkReads: 0, tagReads: 0, trades: 0, coverage: 0, gateCoins: 0, cached: 0 };
    // what is watched: pending coins, then members of open waves launched in the last 6 h, newest first
    const watch = new Map();
    for (const P of this.pending.values()) {
      if (watch.size >= cfg.watchMax) { this.stats.caps.watch++; break; }
      watch.set(P.mint, { mint: P.mint, creator: P.creator, t: P.t, P, keys: P.cands.map((c) => c.key) });
    }
    for (const w of this.open.values()) {
      for (let i = w.mem.length - 1; i >= 0 && watch.size < cfg.watchMax; i--) {
        const L = w.mem[i];
        if (L.gone || L.t < nowS - cfg.pendingS || watch.has(L.mint)) continue;
        watch.set(L.mint, { mint: L.mint, creator: L.creator, t: L.t, P: null, keys: [L.home] });
      }
    }
    yield "watch";
    // stored facts per coin: tracked, post, quoted post, tag (each looked up once it is known; nulls retried every 10 min)
    let n = 0, anyTracked = false;
    for (const x of watch.values()) {
      if ((++n & 127) === 0) yield "facts";
      const c = model?.get?.(x.mint) ?? null;
      x.tracked = c?.tracked === true; x.curveCreator = c?.creator ?? null;
      if (c && !x.tracked) st.cached++;
      const m = x.m = this.#memo(x.mint);
      if (!x.tracked) continue;
      anyTracked = true; m.everTracked = true;
      if (m.post == null && model?.metaFor) m.post = postOf(model.metaFor({ mint: x.mint })) ?? null;
      if (m.post && m.quoted === undefined && posts?.linkOf && st.linkReads < cfg.linkReads && m.linkAt <= nowS - cfg.retryS) {
        st.linkReads++; m.linkAt = nowS;
        const l = posts.linkOf(m.post);
        if (l?.state === "ok") m.quoted = l.kind === "post" ? l.toId ?? null : null;
      }
      if (m.tag == null && narr?.tagOf && st.tagReads < cfg.tagReads && m.tagAt <= nowS - cfg.retryS) { st.tagReads++; m.tagAt = nowS; m.tag = narr.tagOf(x.mint)?.id ?? null; }
    }
    yield "facts";
    // counted buyers of the held hour (the story gate's definition), kept per coin across passes (at most buyersMax)
    const rows = model?.coinRows;
    if (anyTracked && rows && Array.isArray(rows.a)) {
      const a = rows.a, end = a.length, held = nowS - 3600;
      const spray = new Map(), per = new Map();
      for (let i = rows.h ?? 0, k = 0; i < end; i++) {
        if ((++k & 1023) === 0) yield "trades";
        const e = a[i];
        if (!e || !e.u || e.t <= held) continue;
        st.trades++;
        if (e.b && e.v >= cfg.minUsd) { let s = spray.get(e.u); if (!s) spray.set(e.u, s = new Set()); if (s.size < cfg.botCoins) s.add(e.m); }
        const x = watch.get(e.m);
        if (!x || e.u === x.creator || e.u === x.curveCreator) continue;
        let pm = per.get(e.m); if (!pm) per.set(e.m, pm = new Map());
        let y = pm.get(e.u); if (!y) pm.set(e.u, y = { buy: 0, sell: 0, big: false });
        if (e.b) { y.buy += e.v; if (e.v >= cfg.minUsd) y.big = true; } else y.sell += e.v;
      }
      yield "trades";
      let j = 0;
      for (const [mint, pm] of per) {
        if ((++j & 127) === 0) yield "buyers";
        const x = watch.get(mint); st.coverage++; x.covered = true;
        for (const [u, y] of pm) if (y.big && y.buy > y.sell && (spray.get(u)?.size ?? 0) < cfg.botCoins) this.#addBuyer(x.m, u);
      }
    }
    // untracked launches: the trend gate's counted wallets while it watches them (about 10 min after the create)
    if (this.gate?.watched) for (const x of watch.values()) {
      if (x.tracked) continue;
      const g = this.gate.watched.get(x.mint);
      if (!g?.w) continue;
      st.gateCoins++; x.m.gateSeen = true;
      for (const [u, y] of g.w) if (y?.k >= 0 && u !== x.creator) this.#addBuyer(x.m, u);
    }
    yield "buyers";
    // per wave: who carries which post, tag and wallet
    const byWave = new Map();
    const of = (k) => { let g = byWave.get(k); if (!g) byWave.set(k, g = { posts: new Map(), tags: new Map(), wallets: new Map() }); return g; };
    const addTo = (map, id, cr) => { let s = map.get(id); if (!s) map.set(id, s = new Set()); s.add(cr); };
    n = 0;
    for (const x of watch.values()) {
      if ((++n & 127) === 0) yield "index";
      for (const k of x.keys) {
        if (!k) continue;
        const g = of(k), m = x.m;
        if (m.post) addTo(g.posts, m.post, x.creator);
        if (m.quoted) addTo(g.posts, m.quoted, x.creator);
        if (m.tag != null) addTo(g.tags, m.tag, x.creator);
        if (m.buyers) for (const u of m.buyers) { const o = g.wallets.get(u); if (o === undefined) g.wallets.set(u, x.creator); else if (o !== x.creator) g.wallets.set(u, MULTI); }
      }
    }
    yield "index";
    // decide the pending coins that have evidence
    n = 0;
    for (const x of watch.values()) {
      const P = x.P;
      if (!P || this.pending.get(P.mint) !== P) continue;
      if ((++n & 127) === 0) yield "decide";
      const m = x.m, held = [];
      for (const c of P.cands) {
        const g = byWave.get(c.key);
        if (!g) continue;
        const e = {};
        for (const id of [m.post, m.quoted]) { if (!id) continue; const s = g.posts.get(id); if (s && [...s].some((cr) => cr !== P.creator)) { e.post = id; break; } }
        if (m.tag != null) { const s = g.tags.get(m.tag); const others = s ? [...s].filter((cr) => cr !== P.creator).length : 0; if (others >= 2) e.tag = { id: m.tag, others }; }
        const b = m.buyers;
        if (b && b.size >= cfg.evBuyers) {
          let shared = 0;
          for (const u of b) { const o = g.wallets.get(u); if (o !== undefined && (o === MULTI || o !== P.creator)) shared++; }
          if (shared >= cfg.evShared && shared >= cfg.evShare * b.size) e.buyers = { n: b.size, shared };
        }
        if (e.post || e.tag || e.buyers) held.push({ c: { ...c, formedT: this.waves.get(c.key)?.formedT ?? 0 }, e, reason: e.post ? "post" : e.tag ? "tag" : "buyers" });
      }
      if (!held.length) continue;
      held.sort((p, q) => tie(p.c, q.c));
      const h = held[0];
      this.#decide(P, h.c, h.reason, { tier: "evidence", held: held.map((y) => ({ key: y.c.key, reason: y.reason, ...y.e })), buyers: m.buyers?.size ?? 0, covered: !!x.covered, gate: !!m.gateSeen }, nowS);
    }
    yield "decide";
    // tracked launches that do not carry a wave's anchor but share a member's post or quoted post ("post-x")
    const postIdx = new Map();
    for (const x of watch.values()) {
      if (x.P || !x.keys[0]) continue;
      for (const id of [x.m.post, x.m.quoted]) if (id) { let s = postIdx.get(id); if (!s) postIdx.set(id, s = new Set()); s.add(x.keys[0]); }
    }
    if (postIdx.size && model?.metaFor) {
      for (let i = this.c24, k = 0; i < this.a.length; i++) {
        if ((++k & 1023) === 0) yield "post-x";
        const L = this.a[i];
        if (!L || L.gone || !this.#tracked(L.mint)) continue;
        const m = this.#memo(L.mint);
        if (m.post == null) m.post = postOf(model.metaFor({ mint: L.mint })) ?? null;
        if (!m.post) continue;
        if (m.quoted === undefined && posts?.linkOf && st.linkReads < cfg.linkReads && m.linkAt <= nowS - cfg.retryS) { st.linkReads++; m.linkAt = nowS; const l = posts.linkOf(m.post); if (l?.state === "ok") m.quoted = l.kind === "post" ? l.toId ?? null : null; }
        for (const id of [m.post, m.quoted]) {
          const keys = id ? postIdx.get(id) : null;
          if (!keys) continue;
          for (const key of keys) {
            const w = this.waves.get(key);
            if (!w || L.feats.some((y) => y.f === w.feature)) continue;
            if (!m.px) m.px = new Set();
            if (m.px.has(key)) continue;
            m.px.add(key); this.stats.coins.postX++;
            this.#bufOther(["waveCandPut", L.mint, key, null, "post-x", L.t]);
          }
        }
      }
    }
    // expiry: the later of launch + 6 h and formation + 15 min
    n = 0;
    for (const P of [...this.pending.values()]) {
      if ((++n & 1023) === 0) yield "expire";
      if (nowS < P.until) continue;
      const m = this.memo.get(P.mint);
      const noEvidence = !(m?.everTracked) && !(m?.buyers?.size);
      this.#expire(P, nowS, { tier: "evidence", noEvidence, tracked: !!m?.everTracked, gate: !!m?.gateSeen, buyers: m?.buyers?.size ?? 0, post: m?.post ?? null, tag: m?.tag ?? null });
    }
    // memo entries of coins that left the ring and are not pending go
    n = 0;
    for (const [mint, m] of [...this.memo]) {
      if ((++n & 4095) === 0) yield "memo";
      if (!this.byMint.has(mint) && !this.pending.has(mint)) { this.walletsHeld -= m.buyers?.size ?? 0; this.memo.delete(mint); }
    }
    Object.assign(ev, { watched: watch.size, linkReads: st.linkReads, tagReads: st.tagReads, trades: st.trades, coverage: st.coverage, gateCoins: st.gateCoins, cachedUntracked: st.cached });
    return st;
  }

  // ---------------------------------------------------------------- timers
  /** Every 5 s: the windows move, held launches go once they may, rows are written; hourly: wave_hours and companions (a sliced job), ends. */
  tick() {
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000);
    if (this.holding) this.#release(nowMs);
    this.#advance(nowS);
    const h = Math.floor(nowS / 3600);
    if (this.hourMark == null) this.hourMark = h;
    if (h > this.hourMark) { this.#job(this.#hourlyGen(this.hourMark)); this.flagCache.clear(); this.flaggedSet.clear(); this.hourMark = h; }
    this.#ends(nowS);
    this.flush();
  }

  #ends(nowS) {
    for (const [f, w] of [...this.open]) {
      if (nowS - w.lastT < this.cfg.endS) continue;
      w.endedT = nowS; this.open.delete(f); this.ended.set(f, w);
      const F = this.feats.get(f); if (F && F.wave === w) F.wave = null;
      this.dirty.add(w.key); this.stats.waves.ended++;
    }
    for (const [k, w] of this.waves) if (w.endedT != null && w.endedT < nowS - this.cfg.reuseS) { this.waves.delete(k); if (this.ended.get(w.feature) === w) this.ended.delete(w.feature); }
  }

  /**
   * The hour `h` closed: one wave_hours row per open wave and its companions refreshed over its members and pending
   * coins (at most membersMax of them, newest first); a sliced job that yields per wave and every 1,024 list entries.
   */
  *#hourlyGen(h) {
    for (const w of [...this.open.values()]) {
      if (this.open.get(w.feature) !== w) continue; // ended since the hour closed
      const F = this.feats.get(w.feature);
      const share = Math.max(w.share0, this.#shareNow(w.feature)?.share ?? 0);
      const all6 = this.#NW(0), all24 = this.#NW(1);
      this.#bufOther(["waveHourPut", { h, key: w.key, n6: F?.cr[0].size ?? 0, n24: F?.cr[1].size ?? 0, all6, all24, e6: round(share * all6, 6), e24: round(share * all24, 6), members: w.members, pending: w.pending, unconfirmed: w.unconfirmed }]);
      if (F) {
        const per = new Map(), list = F.list, lh = F.lh;
        let carriers = 0, seen = 0;
        for (let j = list.length - 1; j >= lh && carriers < this.cfg.membersMax; j--) {
          if ((++seen & 1023) === 0) yield "hour-carriers";
          const x = list[j];
          if (x.gone || !(x.home === w.key || x.pend?.cands.some((c) => c.key === w.key))) continue;
          carriers++;
          for (const y of x.feats) { if (y.f === w.feature) continue; let s = per.get(y.f); if (!s) per.set(y.f, s = new Set()); s.add(x.creator); }
        }
        yield* this.#companionsGen(w, per, w.win === this.cfg.w6 ? 0 : 1);
      }
      for (let i = 0; i < w.mem.length;) { if (w.mem[i].gone) w.mem.splice(i, 1); else i++; }
      yield "hour";
    }
  }

  // ---------------------------------------------------------------- writes
  #bufLaunch(L) { this.bufL.push([L.t, L.mint, L.seen, L.creator, L.name, L.symbol, featsText(L.feats), L.bh]); this.#cap(); }
  #bufOther(op) { this.bufO.push(op); this.#cap(); }
  #bufCand(L, c) { this.#bufOther(["waveCandPut", L.mint, c.key, c.r == null ? null : round(c.r, 6), c.how, L.t]); }
  /**
   * The two buffers are capped apart: a burst of other rows (a restart's back-fill, the hourly companions) drops its own
   * oldest rows and never a launch row; only a launch row dropped makes its hour partial in the counts.
   */
  #cap() {
    while (this.bufL.length > this.cfg.launchBufMax) {
      this.stats.caps.buffer++;
      const r = this.bufL.shift(); this.stats.dropped++; this.counts?.markDropped?.(Math.floor(r[0] / 3600));
    }
    while (this.bufO.length > this.cfg.otherBufMax) { this.stats.caps.bufferOther++; this.bufO.shift(); this.stats.droppedOther++; }
  }

  /** One small transaction: at most flushLaunches launch rows and flushOther other rows (wave updates included). */
  flush() {
    if (!this.bufL.length && !this.bufO.length && !this.dirty.size) return 0;
    const t0 = performance.now();
    const L = this.bufL.splice(0, this.cfg.flushLaunches), O = this.bufO.splice(0, this.cfg.flushOther), D = [];
    let room = this.cfg.flushOther - O.length;
    for (const k of this.dirty) { if (room-- <= 0) break; D.push(k); }
    for (const k of D) this.dirty.delete(k);
    let n = 0;
    try {
      this.db.transaction(() => {
        for (const r of L) { this.db.waveLaunchPut(r); n++; }
        for (const [op, ...args] of O) { this.db[op](...args); n++; }
        for (const k of D) { const w = this.waves.get(k); if (w) { this.db.waveUpdate(w); n++; } }
      });
      this.stats.rowsWritten += n;
    } catch (e) { this.stats.writeErrors++; this.stats.lastError = `write: ${e.message}`; this.log.warn?.(`waves: write failed (${e.message})`); }
    const ms = performance.now() - t0;
    this.stats.flushMs = Math.round(ms * 100) / 100; if (ms > this.stats.flushMaxMs) this.stats.flushMaxMs = Math.round(ms * 100) / 100;
    return n;
  }

  /** Retention, 2,000 rows a step, 250 ms apart: launches 26 h (the spec's size), the rest 90 days. */
  trim() {
    if (this.trimming) return this.trimming;
    const nowS = Math.floor(this.now() / 1000), c = this.cfg, cutL = nowS - c.launchKeepS, cut = nowS - c.keepS, cutH = Math.floor(cut / 3600), k = c.trimChunk;
    const run = () => {
      const steps = [() => this.db.waveLaunchesTrim(cutL, k), () => this.db.waveCoinsTrim(cut, k), () => this.db.waveCandsTrim(cut, k), () => this.db.waveHoursTrim(cutH, k), () => this.db.waveTestsTrim(cutH, k), () => this.db.wavesTrim(cut, k)];
      let i = 0;
      return new Promise((resolve) => {
        const next = () => {
          if (i >= steps.length || this.stopped) return resolve();
          let n = 0;
          try { n = steps[i](); } catch (e) { this.stats.writeErrors++; this.stats.lastError = `trim: ${e.message}`; }
          if (n < k) i++;
          const t = setTimeout(() => { this.trimTimers.delete(t); next(); }, c.trimPauseMs); t.unref?.(); this.trimTimers.add(t);
        };
        next();
      });
    };
    this.trimming = run().finally(() => { this.trimming = null; });
    return this.trimming;
  }

  // ---------------------------------------------------------------- restart
  #restore() {
    const t0 = performance.now(), nowS = Math.floor(this.now() / 1000);
    const rows = this.db.waveLaunchesSince(nowS - this.cfg.w24, this.cfg.restoreMax);
    rows.sort((x, y) => (x.seen - y.seen) || (x.t - y.t));
    for (const r of rows) {
      if (this.byMint.has(r.mint)) continue;
      const feats = parseFeats(r.feats).map((x) => ({ ...x, ctx: nameRest(r.name, x.f, x.how, x.other) }));
      this.#push({ mint: r.mint, t: r.t, seen: r.seen, creator: r.creator, name: r.name ?? "", symbol: r.symbol ?? "", bh: r.bh, home: null, pend: null, final: false, gone: false, i: 0, feats });
    }
    this.#advance(nowS);
    this.stats.restored = rows.length;
    for (const w of this.db.wavesOpen()) {
      const wave = { ...w, over: 0, mem: [], compDone: new Set() };
      this.waves.set(wave.key, wave); this.open.set(wave.feature, wave);
      let F = this.feats.get(wave.feature);
      if (!F) this.feats.set(wave.feature, F = this.#newF(wave.feature));
      F.wave = wave;
    }
    for (const w of this.db.wavesRecent(nowS - this.cfg.reuseS)) {
      if (this.open.has(w.feature)) continue;
      const wave = { ...w, over: 0, mem: [], compDone: new Set() };
      this.waves.set(wave.key, wave);
      const prev = this.ended.get(wave.feature);
      if (!prev || prev.endedT < wave.endedT) this.ended.set(wave.feature, wave);
    }
    for (const c of this.db.waveCoinsSince(nowS - this.cfg.w24)) {
      const L = this.byMint.get(c.mint);
      if (!L || c.reason === "pending") continue;
      if (c.waveKey) { L.home = c.waveKey; const w = this.waves.get(c.waveKey); if (w && w.mem.length < this.cfg.membersMax) w.mem.push(L); }
      else L.final = true;
    }
    for (const p of this.db.waveCoinsPending(this.cfg.pendingMax)) {
      const L = this.byMint.get(p.mint) ?? null;
      const formed = p.cands.map((c) => (this.waves.get(c.key)?.formedT ?? 0) + this.cfg.afterFormS);
      const P = { mint: p.mint, t: p.t, L, creator: p.creator, name: p.name, symbol: p.symbol, how: p.how, bh: p.bh, cands: p.cands, since: p.at, tracked: !!p.tracked, until: Math.max(p.t + this.cfg.pendingS, ...formed) };
      this.pending.set(p.mint, P);
      if (L) L.pend = P;
    }
    // the back-fill of waves formed in the last 24 h runs again over the restored ring: rows still buffered when the
    // last process stopped are found again (INSERT OR IGNORE, and only pending rows are decided, so it is idempotent)
    let re = 0;
    for (const w of this.open.values()) {
      if (w.formedT < nowS - this.cfg.w24) continue;
      const F = this.feats.get(w.feature);
      if (!F) continue;
      const tier = tierOf(w.r, this.cfg);
      let k = 0;
      for (let j = F.lh; j < F.list.length; j++) {
        const L = F.list[j];
        if (L.gone || L.t <= w.formedT - w.win || L.t > w.formedT + 60) continue;
        if (k++ >= this.cfg.backfillMax) break;
        if (!L.home && !L.final && !L.pend) re++;
        const ft = L.feats.find((y) => y.f === w.feature);
        this.#offer(L, { key: w.key, r: w.r, how: ft?.how ?? "w", tier, formedT: w.formedT }, nowS);
      }
    }
    this.stats.reBackfilled = re;
    this.stats.loadMs = Math.round(performance.now() - t0);
  }

  // ---------------------------------------------------------------- health
  snapshot() {
    const s = this.stats;
    let members = 0, pend = 0;
    for (const w of this.open.values()) { members += w.members; pend += w.pending; }
    return {
      mode: "shadow", launches: s.launches, dup: s.dup, ignored: s.ignored, errors: s.errors, lastError: s.lastError, nonAscii: s.nonAscii, untracked: s.untracked,
      ring: this.a.length - this.c24, features: this.feats.size, partsPerLaunch: s.launches ? Math.round((s.parts / s.launches) * 100) / 100 : 0, loadMs: s.loadMs, restored: s.restored, reBackfilled: s.reBackfilled,
      holding: this.holding ? this.hold.length : 0, notReady: s.notReady, caps: { ...s.caps },
      write: { rowsWritten: s.rowsWritten, buffered: this.bufL.length + this.bufO.length, dirty: this.dirty.size, dropped: s.dropped, droppedOther: s.droppedOther, errors: s.writeErrors, flushMs: s.flushMs, flushMaxMs: s.flushMaxMs },
      counts: this.counts?.snapshot?.() ?? null,
      waves: { open: this.open.size, held: this.waves.size, members, pending: pend, ...s.waves },
      coins: { ...s.coins, pendingNow: this.pending.size },
      evidence: { ...s.evidence, wallets: this.walletsHeld, memo: this.memo.size, attached: { posts: !!this.posts, narr: !!this.narr, gate: !!this.gate } },
      add: { ...s.add }, jobs: { ...s.jobs, queued: this.jobs.length, running: !!this.jobRun },
    };
  }
}
