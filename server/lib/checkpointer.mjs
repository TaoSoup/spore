// The WAL checkpoint, off the event loop. node:sqlite is synchronous, and SQLite's automatic checkpoint runs inside the
// commit that grows the write-ahead log past 1000 pages: that commit copies the log into the 11 GB database file and
// syncs it, on the main thread, 45-81 ms (a live CPU profile, Nov 23 2026: one such commit in each 5-minute attention
// close; before that, 20-60 ms stalls inside the indexer's trade and coin writes, Nov 13). Here the main connection
// turns the automatic checkpoint off (wal_autocheckpoint = 0) and a worker thread with a connection of its own runs
// `PRAGMA wal_checkpoint(PASSIVE)` every CKPT_EVERY_MS. A passive checkpoint takes no writer lock and never waits for one:
// the main thread keeps writing into the log while the worker copies and syncs.
//
// The log starts over (and journal_size_limit cuts the file back to JOURNAL_LIMIT bytes) only at a write that finds
// every frame already copied. A pass reports the log as it was when the pass began, so a run makes passes one after the
// other (each small: the frames written during the pass before), up to PASSES_MAX, and is settled when a pass finds the
// log no longer than the pass before found it (nothing written meanwhile) or shorter (it started over). A scratch 1 GB
// test with a write every 10 ms: with one pass a second the log never started over (88 000 frames in a minute); with
// settled runs it stayed under 15 MB, the longest main-thread commit 6-10 ms (113-150 ms with the automatic checkpoint).
// Under writes that land during every pass (from about 150-300 commits a second in scratch tests), no run settles: then,
// when a run ends with every frame up to its last pass copied and the log at ASSIST_FRAMES or more, the main thread runs
// one passive checkpoint itself (at most every ASSIST_GAP_MS). It has only the frames of that last pass to copy, and no
// write can land during it, so the next write starts the log over; its time is kept (lastAssistMs, maxAssistMs). When
// a reader holds the log (a backup, a long read in another process), nothing can start it over and the main thread
// does not try; the worker copies the backlog once the reader is gone.
//
// Back to the main connection's own automatic checkpoint (state "fallback": the stalls return, nothing is lost) when
// the worker cannot start, fails, ends unasked, reports ERRORS_MAX failed runs in a row, or the log file passes
// WATCHDOG_BYTES (watchdog(), every WATCHDOG_MS). stop() turns it back on too and resolves once the
// worker has ended, so the shutdown's TRUNCATE checkpoint (Db.close) then runs alone.
//
// Loaded as a worker with `workerData.role === "checkpoint"`, this file runs the checkpoints and posts one message per
// run: `{ ms, log, last, done, settled, passes, busy, idle }` (the log at the first and at the last pass, the frames
// copied at the last pass, whether the run settled, whether another connection held the checkpoint, whether nothing
// changed since the run before), or `{ error }`.
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** How often the worker checkpoints (ms); the main connection's automatic checkpoint when the worker is not running (pages, SQLite's default); the log file's size kept after a reset (bytes). */
export const CKPT_EVERY_MS = 1_000, AUTO_PAGES = 1_000, JOURNAL_LIMIT = 64 * 1024 * 1024;
/** Passes a run makes at most; the log (frames) from which an unsettled run has the main thread assist, and how often at most (ms). */
export const PASSES_MAX = 10, ASSIST_FRAMES = 4_000, ASSIST_GAP_MS = 2_000;
/** Failed runs in a row, and a log file this large (bytes, looked at every WATCHDOG_MS), that end the worker (fallback); a log this long is logged (frames, once an hour at most). */
export const ERRORS_MAX = 5, WATCHDOG_BYTES = 4 * JOURNAL_LIMIT, LONG_FRAMES = 50_000, WATCHDOG_MS = 60_000;

if (!isMainThread && workerData?.role === "checkpoint") {
  const db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout = 0");
  const q = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  let prevLast = -1, prevDone = -1;
  const run = () => {
    const t0 = performance.now();
    let r = null, passes = 0, first = -1, prev = -1, settled = false, busy = false;
    try {
      while (passes < PASSES_MAX) {
        r = q.get(); passes++;
        if (r.busy || r.log < 0) { busy = true; break; } // another connection holds the checkpoint: not settled, next tick
        if (first < 0) first = r.log;
        if (r.log === 0 || (r.log <= prev && r.checkpointed >= r.log)) { settled = true; break; }
        prev = r.log;
      }
    } catch (e) { parentPort.postMessage({ error: String(e?.code ?? e?.message ?? e).slice(0, 160) }); return; }
    const last = busy ? prev : r.log, done = busy ? -1 : r.checkpointed;
    const idle = !busy && settled && last === prevLast && done === prevDone; // nothing written since the run before
    if (!busy) { prevLast = last; prevDone = done; }
    parentPort.postMessage({ ms: performance.now() - t0, log: Math.max(first, 0), last, done, settled, passes, busy, idle });
  };
  const timer = setInterval(run, workerData.everyMs ?? CKPT_EVERY_MS);
  parentPort.on("message", (m) => { if (m === "stop") { clearInterval(timer); try { db.close(); } catch { /* closing */ } parentPort.close(); } });
  run();
}

export class Checkpointer {
  /**
   * `db`: the server's Db (its main connection); `file`: the database file the worker opens. `Worker` and `now` are
   * injectable (tests). Nothing starts before start().
   */
  constructor(db, file, { everyMs = CKPT_EVERY_MS, log = console, Worker: W = Worker, now = Date.now } = {}) {
    Object.assign(this, { db, file, everyMs, log, W, now });
    this.worker = null; this.dog = null; this.state = "off"; this.lastAt = null; this.errRun = 0; this.assistAt = -Infinity; this.longAt = -Infinity;
    this.stats = { runs: 0, lastMs: null, maxMs: 0, lastFrames: 0, maxFrames: 0, lastPasses: 0, maxPasses: 0, unfinished: 0, busy: 0, pinned: 0, assists: 0, assistBusy: 0, lastAssistMs: null, maxAssistMs: 0, errors: 0, lastError: null };
  }
  /** Turns the main connection's automatic checkpoint off and starts the worker; on any failure the automatic checkpoint stays on. */
  start() {
    if (this.worker || this.state === "stopped") return this;
    let w;
    try { w = new this.W(new URL(import.meta.url), { workerData: { role: "checkpoint", file: this.file, everyMs: this.everyMs } }); }
    catch (e) { this.#fallback(e); return this; }
    this.worker = w; this.lastAt = this.now();
    w.on("message", (m) => { if (w === this.worker) this.#onMessage(m); });
    w.on("error", (e) => this.#fallback(e, w));
    w.on("exit", (code) => { if (this.state !== "stopped") this.#fallback(new Error(`checkpoint worker exited (${code})`), w); });
    w.unref?.();
    try { this.db.autoCheckpoint(0); this.db.journalSizeLimit(JOURNAL_LIMIT); this.state = "worker"; }
    catch (e) { this.#fallback(e, w); return this; }
    this.dog = setInterval(() => this.watchdog(), WATCHDOG_MS); this.dog.unref?.();
    return this;
  }
  /** Ends the worker and turns the automatic checkpoint back on; resolves when the worker has ended (its connection closed), so Db.close's TRUNCATE then runs alone. */
  stop() {
    if (this.state === "stopped") return Promise.resolve();
    this.state = "stopped"; clearInterval(this.dog);
    const w = this.worker; this.worker = null;
    try { w?.postMessage("stop"); } catch { /* gone */ }
    let ended = Promise.resolve();
    try { ended = Promise.resolve(w?.terminate?.()).catch(() => {}); } catch { /* gone */ }
    try { this.db.autoCheckpoint(AUTO_PAGES); } catch { /* closing */ }
    return ended;
  }
  /** The backstop for a worker that is alive but does not keep the log in hand (hung, or failing quietly): a log file over WATCHDOG_BYTES ends it (fallback). */
  watchdog() {
    if (this.state !== "worker") return;
    let size = 0;
    try { size = statSync(`${this.file}-wal`).size; } catch { return; }
    if (size > WATCHDOG_BYTES) this.#fallback(new Error(`the log file is ${Math.round(size / 1e6)} MB`), this.worker);
  }
  #onMessage(m) {
    const s = this.stats;
    this.lastAt = this.now();
    if (m?.error) {
      s.errors++; s.lastError = m.error;
      if (++this.errRun >= ERRORS_MAX) this.#fallback(new Error(`checkpoint failing: ${m.error}`), this.worker);
      return;
    }
    this.errRun = 0;
    if (m.busy) { s.busy++; s.unfinished += m.log > 0 ? 1 : 0; return; }
    if (m.idle || !(m.log > 0)) return; // nothing new: not a run that did anything
    const ms = Math.round(m.ms * 100) / 100;
    s.runs++; s.lastMs = ms; if (ms > s.maxMs) s.maxMs = ms;
    s.lastFrames = m.log; if (m.log > s.maxFrames) s.maxFrames = m.log;
    s.lastPasses = m.passes; if (m.passes > s.maxPasses) s.maxPasses = m.passes;
    if (m.settled) return;
    s.unfinished++;
    if (m.last >= LONG_FRAMES && this.now() - this.longAt >= 3_600_000) {
      this.longAt = this.now();
      this.log.warn?.(`checkpoint: the write-ahead log is ${m.last} frames long (${m.done >= m.last ? "writes land during every pass" : "a reader holds it"})`);
    }
    if (m.done < m.last) { s.pinned++; return; } // a reader holds the log: a checkpoint here cannot start it over
    if (m.last < ASSIST_FRAMES || this.state !== "worker" || this.now() - this.assistAt < ASSIST_GAP_MS) return;
    // writes land during every pass: one passive checkpoint here, where none can (only the last pass's frames are left)
    this.assistAt = this.now();
    const t0 = performance.now();
    let r = null;
    try { r = this.db.checkpointPassive(); } catch (e) { s.errors++; s.lastError = String(e?.message ?? e).slice(0, 160); return; }
    const am = Math.round((performance.now() - t0) * 100) / 100;
    if (r.busy || r.log < 0) { s.assistBusy++; return; } // the worker was in its next pass: the next message tries again
    s.assists++; s.lastAssistMs = am; if (am > s.maxAssistMs) s.maxAssistMs = am;
  }
  /** The worker failed or ended: the main connection checkpoints itself again (the stalls return, the log stays bounded). */
  #fallback(e, w = null) {
    if (w && w !== this.worker) return; // an old worker ending late
    if (this.state === "stopped" || this.state === "fallback") return;
    this.worker = null; this.state = "fallback"; clearInterval(this.dog);
    this.stats.errors++; this.stats.lastError = String(e?.message ?? e).slice(0, 160);
    try { this.db.autoCheckpoint(AUTO_PAGES); } catch { /* closing */ }
    try { w?.postMessage?.("stop"); } catch { /* gone */ }
    try { w?.terminate?.(); } catch { /* gone */ }
    this.log.warn?.(`checkpoint: worker unavailable (${this.stats.lastError}); the main connection checkpoints itself again`);
  }
  /** Health: the state, the counters, and how long ago the worker last reported (about everyMs when it is alive). */
  snapshot() { return { state: this.state, everyMs: this.everyMs, lastAgoMs: this.lastAt == null ? null : this.now() - this.lastAt, ...this.stats }; }
}
