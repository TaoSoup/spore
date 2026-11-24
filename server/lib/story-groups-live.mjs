// Automatic story groups, live (step 1 of the automatic grouping: recorded, not shown). Once an hour a worker thread
// runs the replay's rule (scripts/story-groups.mjs: a shared distinctive title word whose narratives share buyers) over
// the last 24 hours on its own read-only connection, so the server's loop never waits on it, and posts back which
// group each narrative belongs to. lib/attention.mjs files each coin's trades under its group's key ("t:<words>") too,
// so a group gets the 5-minute history, phases and calibration snapshots every story has. Nothing here reaches a card.
//
// Loaded as a worker with `workerData.role === "story-groups"`, this file runs one pass per message and answers
// `{ ok, at, groups: [{ key, ids }] }` or `{ ok: false, error }`.
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";

export const GROUPS_EVERY_MS = 60 * 60_000, GROUPS_HOURS = 24, GROUPS_BASE_HOURS = 72;

if (!isMainThread && workerData?.role === "story-groups") {
  const { readWindow, autoGroup } = await import("../scripts/story-groups.mjs");
  parentPort.on("message", (m) => {
    try {
      const untilT = Math.floor(m.at / 1000);
      const w = readWindow(workerData.file, { untilT, hours: workerData.hours, baseHours: workerData.baseHours });
      let yieldWords = new Set();
      try { yieldWords = new Set(JSON.parse(readFileSync(workerData.table, "utf8")).subjects.filter((s) => s.quiet).flatMap((s) => s.anchors)); } catch { /* no table: no company words */ }
      const groups = autoGroup(w.narrs, w.launches, { hours: workerData.hours, baseHours: workerData.baseHours, yieldWords, bots: w.bots });
      parentPort.postMessage({ ok: true, at: m.at, groups: groups.map((g) => ({ key: g.key, ids: g.members.map((x) => x.id), buyers: g.buyers })) });
    } catch (e) { parentPort.postMessage({ ok: false, error: e?.message ?? String(e) }); }
  });
}

/** The main thread's side: the worker, its schedule, and narrative id → group key from its last answer. */
export class StoryGroups {
  constructor({ file, table, everyMs = GROUPS_EVERY_MS, hours = GROUPS_HOURS, baseHours = GROUPS_BASE_HOURS, log = console, now = Date.now, Worker: W = Worker } = {}) {
    Object.assign(this, { file, table, everyMs, hours, baseHours, log, now, W });
    this.worker = null; this.timer = null; this.busy = false; this.of = new Map(); this.prev = []; this.stopped = false;
    this.stats = { runs: 0, errors: 0, restarts: 0, lastAt: null, lastMs: null, groups: 0, narratives: 0, kept: 0, lastError: null, alive: false };
  }
  /** The group key ("g:<words>") of narrative `id`, or null; null for all while the last answer is over 3 passes old. */
  keyOf(id) { return this.stats.lastAt != null && this.now() - this.stats.lastAt <= 3 * this.everyMs ? this.of.get(id) ?? null : null; }
  start() {
    if (this.worker || this.stopped) return this;
    this.#spawn();
    this.timer = setInterval(() => { if (!this.worker && !this.stopped && this.stats.restarts < 5) { this.stats.restarts++; this.#spawn(); } this.run(); }, this.everyMs); this.timer.unref?.();
    setTimeout(() => this.run(), 60_000).unref?.(); // the first pass a minute after start, off the boot's busiest time
    return this;
  }
  #spawn() {
    try { this.worker = new this.W(new URL(import.meta.url), { workerData: { role: "story-groups", file: this.file, table: this.table, hours: this.hours, baseHours: this.baseHours } }); }
    catch (e) { this.worker = null; this.stats.errors++; this.stats.lastError = e?.message ?? String(e); this.log.warn?.(`story groups: worker not started (${this.stats.lastError})`); return; }
    const w = this.worker; this.stats.alive = true;
    w.on("message", (m) => { if (w === this.worker) this.#onMessage(m); });
    w.on("error", (e) => { this.stats.errors++; this.stats.lastError = e?.message ?? String(e); this.log.warn?.(`story groups: worker error (${this.stats.lastError})`); });
    // a worker that ended (a crash, out of memory) is let go; the next tick starts a new one (at most 5 times)
    w.on("exit", () => { if (w === this.worker) { this.worker = null; this.busy = false; this.stats.alive = false; } });
    w.unref?.();
  }
  run() {
    if (!this.worker || this.busy) return;
    this.busy = true; this.t0 = this.now();
    this.worker.postMessage({ at: this.t0 });
  }
  #onMessage(m) {
    this.busy = false; this.stats.runs++; this.stats.lastMs = this.now() - this.t0;
    if (!m?.ok) { this.stats.errors++; this.stats.lastError = m?.error ?? "error"; this.log.warn?.(`story groups: pass failed (${this.stats.lastError})`); return; }
    // keys "g:<words>" (never the table's t: space); a group mostly made of a previous group's narratives (half of the
    // smaller one) keeps that group's key, so its history does not start over when its word list shifts; the largest
    // group chooses first and each old key goes to one new group only
    const groups = [...(m.groups ?? [])].map((g) => ({ key: `g:${String(g.key).replace(/^t:/, "")}`, ids: new Set(g.ids ?? []) })).sort((a, b) => b.ids.size - a.ids.size);
    const used = new Set(); let kept = 0;
    for (const g of groups) {
      let best = null, bestK = 0;
      for (const p of this.prev) { if (used.has(p.key)) continue; let k = 0; for (const id of g.ids) if (p.ids.has(id)) k++; if (k > bestK) { best = p; bestK = k; } }
      if (best && bestK * 2 >= Math.min(g.ids.size, best.ids.size)) { if (best.key !== g.key) kept++; g.key = best.key; }
      used.add(g.key);
    }
    const of = new Map();
    for (const g of groups) for (const id of g.ids) of.set(id, g.key);
    this.prev = groups; this.of = of; this.stats.lastAt = m.at; this.stats.groups = groups.length; this.stats.narratives = of.size; this.stats.kept = kept;
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; const w = this.worker; this.worker = null; return w ? w.terminate().catch(() => {}) : Promise.resolve(); }
}
