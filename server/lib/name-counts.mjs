// Name counts for the name waves (lib/waves.mjs, WAVES=shadow): per hour, every name feature (lib/name-features.mjs)
// with the distinct creators and launches that carried it, so a feature can be tested against its own normal share of
// all launches (critique fix L: shares, not counts, so a stream that delivers half of everything changes neither side).
//
// Write path. Launches are counted in memory per hour (the current and the previous one; a late print goes to its own
// hour while that is open). An hour closes 120 s after its end and is clean only when the process ran through all of it,
// streams reported under 120 s of gap in it, a launch arrived in its first and in its last 120 s (a socket open but
// silent, or a gap reported only after the reconnect), it has 100+ launches and no buffered row was dropped. A clean
// hour writes its feature rows 200 per step, 250 ms apart, and its name_hours row last; a partial hour writes only its
// name_hours row. Readers join on name_hours.partial = 0, so a crash mid-hour leaves orphan rows nobody reads. An hour
// open at shutdown is not written, and the hour of a restart is partial by rule: distinct creators never have to be
// rebuilt from sums.
//
// Baseline. A worker thread (this file, `workerData.role === "name-baseline"`, the lib/story-groups-live.mjs pattern) reads
// the clean hours H-720 <= h < H-24 on its own read-only connection, hourly and at boot (the last 24 h are left out, so
// a wave never raises its own baseline before it forms), and posts per feature C (sum of hourly distinct creators), W
// (sum of whole-word carriers) and whether it is a known token (carried whole by 5+ launches on 2+ days), most creators
// first, 2,000 per message; the hand-off is pulled: the worker posts one message and waits until the main thread, having
// filed its 2,000 into a new Map, asks for the next ({ kind: "more" }), so each message gets its own event-loop turn
// (Node delivers every queued port message in one callback: pushed back to back, 100 of them were filed in one block);
// the Map is swapped in at the end. A feature missing from the map counts as C = 1 (the +0.5 prior below
// makes an unseen word's expected share 1.5 / N_base): every row a wave or test writes records whether its C came from
// that prior. Note: C sums distinct creators per hour, so a creator active in k hours counts k times, while a window's n
// counts distinct creators over 6 or 24 h; this leans e upward for features farms repeat (the safe side), and is stated
// here rather than corrected.
//
// Bootstrap (WAVES_BOOTSTRAP, once, only when LAUNCH_LOG names a file and kv `waveBoot` is absent): the worker reads the
// launch log's complete hours not yet in name_hours, splits each hour with a vocabulary built only from log hours up to
// h-24 (the same exclusion as live, so a burst never judges its compounds against its own clones), flags thin hours, and
// posts rows 2,000 per message, the next only when the main thread asks for it, which it does while under 4,000 rows wait
// to be written (so the main heap holds a few thousand rows whatever the log's length); the main thread inserts them 200
// per 250 ms step (src = 1). At shutdown the bootstrap rows still queued are let go: kv `waveBoot` is not set yet, so the
// next start seeds only the hours still missing (their hour rows are written last, so a half-written hour is never
// read). The log is a one-time seed, never a dependency.
import { isMainThread, parentPort, workerData, Worker as NodeWorker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { nameFeatures, nonAscii as hasNonAscii } from "./name-features.mjs";

export const COUNT_DEFAULTS = Object.freeze({
  closeAfterS: 120, edgeS: 120, maxGapS: 120, minLaunches: 100,
  writeChunk: 200, writeStepMs: 250, tickMs: 5000,
  baseHours: 720, excludeHours: 24, maxFeatures: 200_000, chunk: 2000, knownLaunches: 5, knownDays: 2,
  needHours: 24, needLaunches: 20_000, staleMs: 3 * 3600_000, everyMs: 3600_000, firstMs: 5000, restarts: 5,
  trimEveryMs: 3600_000, trimChunk: 2000, trimPauseMs: 250, bootQueueMax: 4000,
});

/** Partial bits of name_hours. */
export const PARTIAL = Object.freeze({ START: 1, GAP: 2, THIN: 4, DROPPED: 16 });

const P22 = 2 ** 22, MAXC = 2 ** 21 - 1, MAXW = P22 - 1;
/** C, W and known packed in one number (a Map of 200k small arrays would cost ~20 MB). */
const pack = (c, w, k) => (Math.min(c, MAXC) * P22 + Math.min(w, MAXW)) * 2 + (k ? 1 : 0);
const unpack = (v) => { const k = v % 2, r = (v - k) / 2; return { C: Math.floor(r / P22), W: r % P22, known: k === 1 }; };

/**
 * The baseline of hour `H` from the clean hours of spore.sqlite `file` (read-only): `{ H, hours, launches, f, c, w, k,
 * known, capHit, ms }`, features with C >= 2 or W >= 2, most creators first then by feature (a cap cuts the same ones
 * every time, so a replay recomputes it exactly), at most `maxFeatures` (capHit says it was cut).
 */
export function readBaseline(file, H, { baseHours = 720, excludeHours = 24, maxFeatures = 200_000, knownLaunches = 5, knownDays = 2 } = {}) {
  const t0 = Date.now();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const from = H - baseHours, to = H - excludeHours;
    const hr = db.prepare("SELECT COUNT(*) AS hours, COALESCE(SUM(launches), 0) AS launches FROM name_hours WHERE h >= ? AND h < ? AND partial = 0").get(from, to);
    const rows = db.prepare(`SELECT c.feature AS f, SUM(c.creators) AS cr, SUM(c.whole) AS wh, COUNT(DISTINCT CASE WHEN c.whole > 0 THEN c.h / 24 END) AS days
      FROM name_counts c JOIN name_hours n ON n.h = c.h AND n.partial = 0
      WHERE c.h >= ? AND c.h < ? GROUP BY c.feature HAVING SUM(c.creators) >= 2 OR SUM(c.whole) >= 2 ORDER BY cr DESC, f LIMIT ?`).all(from, to, maxFeatures + 1);
    const capHit = rows.length > maxFeatures;
    const n = Math.min(rows.length, maxFeatures);
    const f = new Array(n), c = new Uint32Array(n), w = new Uint32Array(n), k = new Uint8Array(n);
    let known = 0;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      f[i] = r.f; c[i] = Number(r.cr); w[i] = Number(r.wh);
      if (w[i] >= knownLaunches && Number(r.days) >= knownDays) { k[i] = 1; known++; }
    }
    return { H, hours: Number(hr.hours), launches: Number(hr.launches), f, c, w, k, known, capHit, ms: Date.now() - t0 };
  } finally { db.close(); }
}

/**
 * The bootstrap from launch-log `logFile` (read-only): the complete hours before `H` not in `haveHours`, each split with
 * a vocabulary of the log hours up to h-24 only. Returns `{ hours: [{ row, rows }], thin, launches }`: `row` the
 * name_hours row (src 1), `rows` its name_counts rows `[h, feature, creators, launches, whole]` (none for a partial hour).
 * Thin: under half the median hourly launches, or under `minLaunches` (bit 4); an hour without a launch in its first or
 * last `edgeS` seconds is partial too (bit 2: the log started or stopped inside it).
 */
export function readBootstrap(logFile, haveHours, H, { minLaunches = 100, edgeS = 120, knownLaunches = 5, knownDays = 2, nowS = Math.floor(Date.now() / 1000) } = {}) {
  const have = haveHours instanceof Set ? haveHours : new Set(haveHours ?? []);
  const db = new DatabaseSync(logFile, { readOnly: true });
  let launches;
  try {
    db.exec("PRAGMA query_only = ON");
    launches = db.prepare("SELECT mint, t, seen, name, symbol, creator FROM creates WHERE t < ? AND t IS NOT NULL ORDER BY t, seen").all(H * 3600);
  } finally { db.close(); }
  // pass one: per hour its launches, edges and whole-word carriers (the vocabulary, no splits)
  const byH = new Map();
  for (const x of launches) {
    const h = Math.floor(Number(x.t) / 3600);
    let a = byH.get(h);
    if (!a) byH.set(h, a = { h, list: [], minOff: 3600, maxOff: -1, whole: new Map() });
    a.list.push(x);
    const off = Number(x.t) - h * 3600;
    if (off < a.minOff) a.minOff = off; if (off > a.maxOff) a.maxOff = off;
    for (const ft of nameFeatures(x.name, x.symbol, null)) a.whole.set(ft.f, (a.whole.get(ft.f) ?? 0) + 1);
  }
  const hs = [...byH.keys()].sort((a, b) => a - b);
  const sizes = hs.map((h) => byH.get(h).list.length).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  // pass two: split hour h with the vocabulary of hours < h - 24 (added as h moves on)
  const cumW = new Map(), cumDays = new Map();
  let cumN = 0, j = 0, thin = 0;
  const vocab = { whole: (f) => cumW.get(f) ?? 0, known: (f) => (cumW.get(f) ?? 0) >= knownLaunches && (cumDays.get(f)?.size ?? 0) >= knownDays, get n() { return cumN; } };
  const out = [];
  for (const h of hs) {
    while (j < hs.length && hs[j] < h - 24) {
      const b = byH.get(hs[j]), day = Math.floor(hs[j] / 24);
      cumN += b.list.length;
      for (const [f, n] of b.whole) { cumW.set(f, (cumW.get(f) ?? 0) + n); let d = cumDays.get(f); if (!d) cumDays.set(f, d = new Set()); d.add(day); }
      j++;
    }
    if (have.has(h)) continue;
    const a = byH.get(h);
    const creators = new Set(), feats = new Map();
    let nonAscii = 0;
    for (const x of a.list) {
      if (x.creator) creators.add(x.creator);
      if (hasNonAscii(x.name, x.symbol)) nonAscii++;
      for (const ft of nameFeatures(x.name, x.symbol, vocab)) {
        let s = feats.get(ft.f);
        if (!s) feats.set(ft.f, s = { n: 0, w: 0, cr: new Set() });
        s.n++; if (ft.how !== "s") s.w++; if (x.creator) s.cr.add(x.creator);
      }
    }
    let partial = 0;
    if (a.list.length < minLaunches || a.list.length * 2 < median) { partial |= PARTIAL.THIN; thin++; }
    if (a.minOff >= edgeS || a.maxOff < 3600 - edgeS) partial |= PARTIAL.GAP;
    const row = { h, launches: a.list.length, creators: creators.size, nonAscii, partial, gapS: 0, src: 1, feats: feats.size, at: nowS };
    out.push({ row, rows: partial ? [] : [...feats].map(([f, s]) => [h, f, s.cr.size, s.n, s.w]) });
  }
  return { hours: out, thin, launches: launches.length };
}

/** The baseline pass as worker messages, one per step: start, 2,000-feature chunks, end. */
function* baseMessages(m, chunk) {
  const b = readBaseline(workerData.file, m.H, workerData.opts ?? {});
  yield [{ kind: "base-start", id: m.id, H: b.H, hours: b.hours, launches: b.launches, total: b.f.length, known: b.known, capHit: b.capHit, ms: b.ms }];
  for (let i = 0; i < b.f.length; i += chunk) {
    const c = b.c.slice(i, i + chunk), w = b.w.slice(i, i + chunk), k = b.k.slice(i, i + chunk);
    yield [{ kind: "base-chunk", id: m.id, f: b.f.slice(i, i + chunk), c, w, k }, [c.buffer, w.buffer, k.buffer]];
  }
  yield [{ kind: "base-end", id: m.id }];
}
/** The bootstrap as worker messages: per hour its rows by 2,000 then its hour row; the end. */
function* bootMessages(m, chunk) {
  const sdb = new DatabaseSync(workerData.file, { readOnly: true });
  let have;
  try { sdb.exec("PRAGMA query_only = ON"); have = new Set(sdb.prepare("SELECT h FROM name_hours").all().map((x) => x.h)); } finally { sdb.close(); }
  const r = readBootstrap(m.logFile, have, m.H, workerData.opts ?? {});
  let rows = 0;
  for (const hr of r.hours) {
    for (let i = 0; i < hr.rows.length; i += chunk) yield [{ kind: "boot-rows", id: m.id, rows: hr.rows.slice(i, i + chunk) }];
    yield [{ kind: "boot-hour", id: m.id, row: hr.row }];
    rows += hr.rows.length;
  }
  yield [{ kind: "boot-end", id: m.id, hours: r.hours.length, rows, thin: r.thin, launches: r.launches }];
}

if (!isMainThread && workerData?.role === "name-baseline") {
  const CHUNK = workerData.chunk ?? 2000;
  let job = null; // { id, it }: the job whose next message waits for the main thread's "more"
  const step = () => {
    const j = job;
    if (!j) return;
    let r;
    try { r = j.it.next(); } catch (e) { job = null; parentPort.postMessage({ kind: "error", id: j.id, error: e?.message ?? String(e) }); return; }
    if (r.done) { job = null; return; }
    const [msg, transfer] = r.value;
    if (msg.kind === "base-end" || msg.kind === "boot-end") job = null;
    parentPort.postMessage(msg, transfer ?? []);
  };
  parentPort.on("message", (m) => {
    if (m?.kind === "more") { if (job && job.id === m.id) step(); return; }
    if (m?.kind === "base") { job = { id: m.id, it: baseMessages(m, CHUNK) }; step(); }
    else if (m?.kind === "boot") { job = { id: m.id, it: bootMessages(m, CHUNK) }; step(); }
  });
}

/** The current baseline: share and vocabulary look-ups; a feature missing from it counts as C = 1, W = 0. */
export class Baseline {
  constructor({ H, hours, launches, map, at, features = map?.size ?? 0, known = 0, capHit = false, ms = 0, needHours = COUNT_DEFAULTS.needHours, needLaunches = COUNT_DEFAULTS.needLaunches, staleMs = COUNT_DEFAULTS.staleMs }) {
    Object.assign(this, { H, hours, launches, map: map ?? new Map(), at, features, known, capHit, ms, needHours, needLaunches, staleMs });
    const self = this;
    this.v = { whole: (f) => self.get(f).W, known: (f) => self.get(f).known, n: launches };
  }
  /** `{ C, W, known, missing }` of feature `f`. */
  get(f) { const v = this.map.get(f); return v === undefined ? { C: 1, W: 0, known: false, missing: true } : { ...unpack(v), missing: false }; }
  /** Its share of all launches with the +0.5 prior: (C + 0.5) / N_base. */
  share(f) { return this.launches > 0 ? (this.get(f).C + 0.5) / this.launches : null; }
  ready(nowMs = Date.now()) { return this.hours >= this.needHours && this.launches >= this.needLaunches && nowMs - this.at <= this.staleMs; }
  /** The vocabulary for lib/name-features.mjs nameFeatures. */
  vocab() { return this.v; }
  /** Builds one from plain `{ feature: { C, W, known } }` (tests, replays). */
  static of({ H = 0, hours = 0, launches = 0, at = Date.now(), features = {}, ...rest } = {}) {
    const map = new Map();
    let known = 0;
    for (const [f, x] of Object.entries(features)) { map.set(f, pack(x.C ?? 0, x.W ?? 0, !!x.known)); if (x.known) known++; }
    return new Baseline({ H, hours, launches, at, map, known, ...rest });
  }
}

/** Runs `steps` (functions returning rows deleted) one chunk at a time, `pauseMs` apart, each until it deletes under `chunk`. */
export function trimSteps(steps, { chunk, pauseMs, onError = () => {}, timers = null } = {}) {
  let i = 0, total = 0;
  return new Promise((resolve) => {
    const next = () => {
      if (i >= steps.length) return resolve(total);
      let n = 0;
      try { n = steps[i](); } catch (e) { onError(e); n = 0; }
      total += n;
      if (n < chunk) i++;
      const t = setTimeout(() => { timers?.delete(t); next(); }, pauseMs); t.unref?.();
      if (timers) timers.add(t);
    };
    next();
  });
}

export class NameCounts {
  constructor({ db, file = null, launchLogFile = null, keepDays = 30, Worker = NodeWorker, now = Date.now, log = console, cfg = {} } = {}) {
    Object.assign(this, { db, file, launchLogFile, keepDays, W: Worker, now, log });
    this.cfg = { ...COUNT_DEFAULTS, ...cfg };
    this.acc = new Map();       // h → { launches, creators: Set, nonAscii, minOff, maxOff, sFeats, feats: Map(f → { n, w, cr: Set }) }
    this.gapS = new Map();      // h → seconds of reported stream gap in it
    this.dropped = new Set();   // hours whose buffered rows were dropped (bit 16)
    this.queue = [];            // writes: { rows, i, hour, after, boot }
    this.bootWait = false;      // the bootstrap's next message is not asked for until the queue is under bootQueueMax rows
    this.minH = null;           // launches of earlier hours are late (their hour closed, or began before the process)
    this.base = null; this.building = null; this.worker = null; this.busy = null; this.jobId = 0; this.want = false;
    this.firstDone = false;     // the first baseline pass answered (or could not run): lib/waves.mjs holds launches until then
    this.timers = []; this.pumpTimer = null; this.trimTimers = new Set(); this.started = false; this.stopped = false;
    this.stats = { launches: 0, late: 0, hoursClean: 0, hoursPartial: 0, rowsWritten: 0, writeErrors: 0, lastError: null, lastHour: null,
      passes: 0, fails: 0, restarts: 0, swaps: 0, trimmed: 0 };
    this.boot = { state: launchLogFile ? "waiting" : "off", hours: 0, rows: 0, thin: 0 };
  }

  start() {
    if (this.started || this.stopped) return this;
    this.started = true;
    this.startedAtS = Math.floor(this.now() / 1000);
    this.minH = Math.floor(this.startedAtS / 3600);
    if (this.file) this.#spawn();
    else this.firstDone = true;
    const tick = setInterval(() => this.tick(), this.cfg.tickMs); tick.unref?.(); this.timers.push(tick);
    const hourly = setInterval(() => { if (!this.worker && !this.stopped && this.file && this.stats.restarts < this.cfg.restarts) { this.stats.restarts++; this.#spawn(); } this.runBase(); }, this.cfg.everyMs); hourly.unref?.(); this.timers.push(hourly);
    const trim = setInterval(() => this.trim(), this.cfg.trimEveryMs); trim.unref?.(); this.timers.push(trim);
    let bootDone = true;
    try { bootDone = !this.launchLogFile || this.db.kvGet("waveBoot", null) != null; } catch { /* no kv: no bootstrap */ }
    if (!bootDone) this.boot.state = "queued"; else if (this.launchLogFile) this.boot.state = "done";
    const first = setTimeout(() => { if (!bootDone) this.runBoot(); else this.runBase(); }, this.cfg.firstMs); first.unref?.(); this.timers.push(first);
    return this;
  }

  #spawn() {
    try { this.worker = new this.W(new URL(import.meta.url), { workerData: { role: "name-baseline", file: this.file, chunk: this.cfg.chunk, opts: { baseHours: this.cfg.baseHours, excludeHours: this.cfg.excludeHours, maxFeatures: this.cfg.maxFeatures, knownLaunches: this.cfg.knownLaunches, knownDays: this.cfg.knownDays, minLaunches: this.cfg.minLaunches, edgeS: this.cfg.edgeS } } }); }
    catch (e) { this.worker = null; this.stats.fails++; this.stats.lastError = e?.message ?? String(e); this.firstDone = true; this.log.warn?.(`name counts: worker not started (${this.stats.lastError})`); return; }
    const w = this.worker;
    w.on("message", (m) => { if (w === this.worker) this.#onMessage(m); });
    w.on("error", (e) => { this.stats.fails++; this.stats.lastError = e?.message ?? String(e); this.log.warn?.(`name counts: worker error (${this.stats.lastError})`); });
    // a worker that ended is let go; the hourly tick starts a new one, at most `restarts` times
    w.on("exit", () => { if (w === this.worker) { this.worker = null; this.busy = null; this.building = null; this.firstDone = true; if (this.boot.state === "running") this.boot.state = "failed"; } });
    w.unref?.();
  }

  /** Asks the worker for a baseline pass (one job at a time; asked again after the running one). */
  runBase() {
    if (!this.worker) return false;
    if (this.busy) { this.want = true; return false; }
    this.busy = "base"; this.want = false; this.t0 = this.now();
    this.worker.postMessage({ kind: "base", id: ++this.jobId, H: Math.floor(this.now() / 3600_000) });
    return true;
  }
  runBoot() {
    if (!this.worker || !this.launchLogFile) { this.runBase(); return false; }
    if (this.busy) return false;
    this.busy = "boot"; this.boot.state = "running"; this.t0 = this.now();
    this.worker.postMessage({ kind: "boot", id: ++this.jobId, H: Math.floor(this.now() / 3600_000), logFile: this.launchLogFile });
    return true;
  }

  /** Asks the worker for the next message of job `id` (the hand-off is pulled, one message per event-loop turn). */
  #more(id) { try { this.worker?.postMessage({ kind: "more", id }); } catch (e) { this.stats.lastError = e?.message ?? String(e); } }
  #queuedRows() { let n = 0; for (const x of this.queue) n += x.rows.length - x.i; return n; }
  /** The bootstrap's next message, once fewer than bootQueueMax rows wait to be written (else when the pump gets there). */
  #bootMore() {
    if (this.busy !== "boot" || this.stopped) { this.bootWait = false; return; }
    if (this.#queuedRows() < this.cfg.bootQueueMax) { this.bootWait = false; this.#more(this.jobId); } else this.bootWait = true;
  }

  #onMessage(m) {
    if (!m || m.id !== this.jobId) return;
    if (m.kind === "base-start") { this.building = { H: m.H, hours: m.hours, launches: m.launches, known: m.known, capHit: !!m.capHit, ms: m.ms, map: new Map() }; this.#more(m.id); return; }
    if (m.kind === "base-chunk") {
      const b = this.building;
      if (!b) return;
      // one message's 2,000 entries, then the next is asked for: it arrives on a later turn, never in the same block
      for (let i = 0; i < m.f.length; i++) b.map.set(m.f[i], pack(m.c[i], m.w[i], m.k[i]));
      this.#more(m.id);
      return;
    }
    if (m.kind === "base-end") {
      const b = this.building;
      this.building = null; this.busy = null;
      if (b) {
        this.base = new Baseline({ ...b, at: this.now(), features: b.map.size, needHours: this.cfg.needHours, needLaunches: this.cfg.needLaunches, staleMs: this.cfg.staleMs });
        this.stats.passes++; this.stats.swaps++; this.stats.lastPassMs = this.now() - this.t0;
      }
      this.firstDone = true;
      if (this.want) this.runBase();
      return;
    }
    if (m.kind === "boot-rows") { this.#enqueue({ rows: m.rows, hour: null, boot: true }); this.#bootMore(); return; }
    if (m.kind === "boot-hour") { this.#enqueue({ rows: [], hour: m.row, boot: true }); this.boot.hours++; this.#bootMore(); return; }
    if (m.kind === "boot-end") {
      this.busy = null; this.bootWait = false;
      const info = { at: Math.floor(this.now() / 1000), hours: m.hours, rows: m.rows, thin: m.thin, launches: m.launches };
      this.boot.rows = m.rows; this.boot.thin = m.thin; this.boot.state = "writing";
      this.#enqueue({ rows: [], hour: null, boot: true, after: () => { try { this.db.kvSet("waveBoot", info); } catch (e) { this.stats.lastError = e.message; } this.boot.state = "done"; this.runBase(); } });
      return;
    }
    if (m.kind === "error") {
      this.stats.fails++; this.stats.lastError = m.error ?? "error"; this.log.warn?.(`name counts: ${this.busy ?? "pass"} failed (${this.stats.lastError})`);
      if (this.busy === "boot") { this.boot.state = "failed"; this.busy = null; this.bootWait = false; this.runBase(); return; }
      this.busy = null; this.building = null; this.firstDone = true;
      if (this.want) this.runBase();
    }
  }

  /** One launch: `{ t (s), creator, feats: [{ f, how }], nonAscii }`. Memory only. */
  add(x) {
    if (this.minH == null) this.minH = Math.floor(Math.floor(this.now() / 1000) / 3600);
    const h = Math.floor(x.t / 3600);
    if (h < this.minH) { this.stats.late++; return; }
    let a = this.acc.get(h);
    if (!a) {
      if (this.acc.size >= 4) { this.stats.late++; return; }
      this.acc.set(h, a = { h, launches: 0, creators: new Set(), nonAscii: 0, minOff: 3600, maxOff: -1, sFeats: 0, feats: new Map() });
    }
    this.stats.launches++;
    a.launches++;
    if (x.creator) a.creators.add(x.creator);
    if (x.nonAscii) a.nonAscii++;
    const off = x.t - h * 3600;
    if (off < a.minOff) a.minOff = off; if (off > a.maxOff) a.maxOff = off;
    for (const ft of x.feats) {
      let s = a.feats.get(ft.f);
      if (!s) a.feats.set(ft.f, s = { n: 0, w: 0, cr: new Set() });
      s.n++; if (ft.how !== "s") s.w++; else a.sFeats++;
      if (x.creator) s.cr.add(x.creator);
    }
  }

  /** A stretch (ms) in which a stream delivered nothing (LogsSubscriber onGap): its seconds count against each hour it covers. */
  gap(fromMs, toMs) {
    const a = Math.floor(fromMs / 1000), b = Math.floor(toMs / 1000);
    if (!(b > a)) return;
    for (let h = Math.floor(a / 3600); h <= Math.floor((b - 1) / 3600); h++) {
      const s = Math.min(b, (h + 1) * 3600) - Math.max(a, h * 3600);
      if (s > 0) this.gapS.set(h, (this.gapS.get(h) ?? 0) + s);
    }
  }
  /** Rows of hour `h` were dropped before they were written (lib/waves.mjs buffer cap): the hour is partial. */
  markDropped(h) { this.dropped.add(h); }

  /** Closes hours 120 s past their end. */
  tick() {
    const nowS = Math.floor(this.now() / 1000);
    for (const h of [...this.acc.keys()].sort((a, b) => a - b)) if (nowS >= (h + 1) * 3600 + this.cfg.closeAfterS) this.#close(h, nowS);
    const keep = Math.floor(nowS / 3600) - 3;
    for (const h of this.gapS.keys()) if (h < keep) this.gapS.delete(h);
    for (const h of this.dropped) if (h < keep) this.dropped.delete(h);
  }

  #close(h, nowS) {
    const a = this.acc.get(h);
    this.acc.delete(h);
    if (this.minH == null || this.minH <= h) this.minH = h + 1;
    let partial = 0;
    if (this.startedAtS == null || this.startedAtS > h * 3600) partial |= PARTIAL.START;
    const gap = this.gapS.get(h) ?? 0;
    if (gap >= this.cfg.maxGapS || a.minOff >= this.cfg.edgeS || a.maxOff < 3600 - this.cfg.edgeS) partial |= PARTIAL.GAP;
    if (a.launches < this.cfg.minLaunches) partial |= PARTIAL.THIN;
    if (this.dropped.has(h)) partial |= PARTIAL.DROPPED;
    const hour = { h, launches: a.launches, creators: a.creators.size, nonAscii: a.nonAscii, partial, gapS: Math.round(gap), src: 0, feats: a.feats.size, at: nowS };
    const rows = partial ? [] : [...a.feats].map(([f, s]) => [h, f, s.cr.size, s.n, s.w]);
    if (partial) this.stats.hoursPartial++; else this.stats.hoursClean++;
    this.stats.lastHour = { h, launches: a.launches, partial, rows: rows.length, features: a.feats.size, partsPerLaunch: a.launches ? Math.round((a.sFeats / a.launches) * 100) / 100 : 0 };
    this.#enqueue({ rows, hour });
  }

  #enqueue(item) { this.queue.push({ i: 0, ...item }); this.#schedulePump(); }
  #schedulePump() {
    if (this.pumpTimer || !this.queue.length || this.stopped) return;
    this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); this.#schedulePump(); }, this.cfg.writeStepMs);
    this.pumpTimer.unref?.();
  }
  /** One write step: up to `writeChunk` feature rows of the oldest queued hour, or its hour row once they are in. */
  pump() {
    const it = this.queue[0];
    if (!it) return false;
    try {
      if (it.i < it.rows.length) {
        const part = it.rows.slice(it.i, it.i + this.cfg.writeChunk);
        this.db.nameCountsPut(part);
        it.i += part.length; this.stats.rowsWritten += part.length;
        if (it.i < it.rows.length) return true;
      }
      if (it.hour) this.db.nameHourPut(it.hour);
      this.queue.shift();
      it.after?.();
    } catch (e) { this.queue.shift(); this.stats.writeErrors++; this.stats.lastError = e.message; this.log.warn?.(`name counts: write failed (${e.message})`); }
    finally { if (this.bootWait) this.#bootMore(); }
    return true;
  }

  /** Retention: rows of hours older than `keepDays`, 2,000 per step, 250 ms apart. */
  trim() {
    if (this.trimming) return this.trimming;
    const cutH = Math.floor(this.now() / 3600_000) - this.keepDays * 24, o = { chunk: this.cfg.trimChunk, pauseMs: this.cfg.trimPauseMs, timers: this.trimTimers, onError: (e) => { this.stats.writeErrors++; this.stats.lastError = e.message; } };
    this.trimming = trimSteps([() => this.db.nameCountsTrim(cutH, o.chunk), () => this.db.nameHoursTrim(cutH, o.chunk)], o).then((n) => { this.stats.trimmed += n; this.trimming = null; return n; });
    return this.trimming;
  }

  /** The vocabulary of the current baseline (null before the first one). */
  vocab() { return this.base ? this.base.vocab() : null; }

  snapshot() {
    const nowMs = this.now(), b = this.base, cur = [...this.acc.values()].sort((x, y) => y.h - x.h)[0] ?? null;
    return {
      hour: cur ? { h: cur.h, launches: cur.launches, gapS: this.gapS.get(cur.h) ?? 0, startPartial: this.startedAtS > cur.h * 3600 } : null,
      launches: this.stats.launches, late: this.stats.late, hoursClean: this.stats.hoursClean, hoursPartial: this.stats.hoursPartial, rowsWritten: this.stats.rowsWritten,
      queued: this.queue.reduce((n, x) => n + x.rows.length - x.i + (x.hour ? 1 : 0), 0), writeErrors: this.stats.writeErrors, lastError: this.stats.lastError, lastHour: this.stats.lastHour,
      baseline: { ready: b ? b.ready(nowMs) : false, H: b?.H ?? null, hours: b?.hours ?? 0, needHours: this.cfg.needHours, launches: b?.launches ?? 0, needLaunches: this.cfg.needLaunches, features: b?.features ?? 0, known: b?.known ?? 0, capHit: b?.capHit ?? false, ms: b?.ms ?? null,
        ageS: b ? Math.round((nowMs - b.at) / 1000) : null, worker: this.worker ? (this.busy ?? "idle") : "stopped", passes: this.stats.passes, fails: this.stats.fails, restarts: this.stats.restarts, lastPassMs: this.stats.lastPassMs ?? null },
      boot: { ...this.boot }, trimmed: this.stats.trimmed,
    };
  }

  /**
   * Clears timers, writes every closed live hour still queued (an open hour is not written), lets the queued bootstrap
   * rows go (kv waveBoot is not set yet: the next start seeds the hours still missing), ends the worker.
   */
  stop() {
    this.stopped = true; this.bootWait = false;
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    for (const t of this.trimTimers) clearTimeout(t);
    this.trimTimers.clear();
    clearTimeout(this.pumpTimer); this.pumpTimer = null;
    this.queue = this.queue.filter((it) => !it.boot);
    let guard = 10_000;
    while (this.queue.length && guard-- > 0) this.pump();
    const w = this.worker; this.worker = null;
    return w ? w.terminate().catch(() => {}) : Promise.resolve();
  }
}
