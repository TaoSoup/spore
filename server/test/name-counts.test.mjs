// Name counts (lib/name-counts.mjs): the hour accumulator and its clean/partial rule, chunked writes (feature rows before
// the hour row), trims, the baseline read (clean hours only, the last 24 h left out, known tokens on 2+ days), the worker
// hand-off in 2,000-entry messages, respawns and staleness, and the one-time bootstrap from a launch-log file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../lib/db.mjs";
import { NameCounts, Baseline, readBaseline, readBootstrap, bootOpts, PARTIAL } from "../lib/name-counts.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const H0 = 498_600; // an hour number (unix s / 3600), Nov 2026
const FAR = 1_000_000; // a write step that never fires by itself: the tests pump by hand
const launch = (t, creator, feats = [{ f: "veto", how: "w" }]) => ({ t, creator, feats, nonAscii: false });

/** A counter started `startOff` s before hour H0, its clock in `clock.s`. */
function counter(db, { startOff = -60, cfg = {}, ...o } = {}) {
  const clock = { s: H0 * 3600 + startOff };
  const c = new NameCounts({ db, now: () => clock.s * 1000, log: quiet, cfg: { writeStepMs: FAR, tickMs: FAR, everyMs: FAR, trimEveryMs: FAR, firstMs: FAR, ...cfg }, ...o }).start();
  return { c, clock };
}
/** A whole hour of `n` launches spread from second 10 to 3590, every one carrying veto and a feature of its own. */
function fillHour(c, h, n = 120, extra = () => []) {
  for (let i = 0; i < n; i++) c.add(launch(h * 3600 + 10 + Math.floor((i * 3580) / (n - 1)), `C${i % 50}`, [{ f: "veto", how: i % 3 ? "w" : "s" }, { f: `own${i}`, how: "w" }, ...extra(i)]));
}
const drain = (c) => { let k = 0; while (c.queue.length && k++ < 10_000) c.pump(); };

test("a clean hour writes its feature rows in chunks, then its hour row last; readers see the hour only once its rows are in", async () => {
  const db = new Db(":memory:");
  const { c, clock } = counter(db, { cfg: { writeChunk: 50 } });
  fillHour(c, H0);
  clock.s = (H0 + 1) * 3600 + 119; c.tick();
  assert.equal(c.queue.length, 0, "not closed before 120 s past the end");
  clock.s += 1; c.tick();
  assert.equal(c.queue.length, 1);
  c.pump();
  const n = () => db.db.prepare("SELECT COUNT(*) AS n FROM name_counts").get().n;
  assert.equal(n(), 50, "the first chunk");
  assert.equal(db.nameHoursIn(H0, H0 + 1).length, 0, "the hour row waits for its feature rows");
  drain(c);
  assert.equal(n(), 121, "veto and 120 own features");
  const [hr] = db.nameHoursIn(H0, H0 + 1);
  assert.deepEqual([hr.partial, hr.launches, hr.creators, hr.src], [0, 120, 50, 0]);
  const v = db.db.prepare("SELECT creators, launches, whole FROM name_counts WHERE h = ? AND feature = 'veto'").get(H0);
  assert.deepEqual([v.creators, v.launches, v.whole], [50, 120, 80], "whole counts w and p carriage only");
  assert.equal(c.snapshot().lastHour.partsPerLaunch, 0.33);
  await c.stop(); db.close();
});

test("each partial cause writes only the hour row: a start inside the hour, a stream gap, a silent edge, a thin hour, dropped rows", async () => {
  const cases = [
    ["start", { startOff: 30 }, (c) => fillHour(c, H0), PARTIAL.START],
    ["gap", {}, (c) => { fillHour(c, H0); c.gap((H0 * 3600 + 1000) * 1000, (H0 * 3600 + 1130) * 1000); }, PARTIAL.GAP],
    ["silent start", {}, (c) => { for (let i = 0; i < 120; i++) c.add(launch(H0 * 3600 + 200 + i * 28, `C${i}`)); }, PARTIAL.GAP],
    ["thin", {}, (c) => fillHour(c, H0, 60), PARTIAL.THIN],
    ["dropped", {}, (c) => { fillHour(c, H0); c.markDropped(H0); }, PARTIAL.DROPPED],
  ];
  for (const [name, o, fill, bit] of cases) {
    const db = new Db(":memory:");
    const { c, clock } = counter(db, o);
    fill(c);
    clock.s = (H0 + 1) * 3600 + 120; c.tick(); drain(c);
    const [hr] = db.nameHoursIn(H0, H0 + 1);
    assert.equal(hr.partial, bit, name);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM name_counts").get().n, 0, `${name}: no feature rows`);
    await c.stop(); db.close();
  }
  // a short gap (under 120 s) leaves the hour clean
  const db = new Db(":memory:");
  const { c, clock } = counter(db);
  fillHour(c, H0); c.gap((H0 * 3600 + 1000) * 1000, (H0 * 3600 + 1100) * 1000);
  clock.s = (H0 + 1) * 3600 + 120; c.tick(); drain(c);
  assert.equal(db.nameHoursIn(H0, H0 + 1)[0].partial, 0);
  assert.equal(db.nameHoursIn(H0, H0 + 1)[0].gapS, 100);
  await c.stop(); db.close();
});

test("a late print goes to its own hour while that is open; an hour already closed or begun before the process counts it as late", async () => {
  const db = new Db(":memory:");
  const { c, clock } = counter(db);
  fillHour(c, H0);
  clock.s = (H0 + 1) * 3600 + 30;
  c.add(launch(H0 * 3600 + 3595, "LATE")); // printed late: still hour H0
  c.add(launch((H0 + 1) * 3600 + 20, "NEW"));
  clock.s = (H0 + 1) * 3600 + 120; c.tick(); drain(c);
  assert.equal(db.nameHoursIn(H0, H0 + 1)[0].launches, 121);
  c.add(launch(H0 * 3600 + 3599, "TOO LATE"));
  c.add(launch((H0 - 1) * 3600 + 5, "BEFORE START"));
  assert.equal(c.snapshot().late, 2);
  await c.stop(); db.close();
});

test("trims delete hours older than keepDays in chunks; newer rows stay", async () => {
  const db = new Db(":memory:");
  const { c } = counter(db, { keepDays: 7, cfg: { trimChunk: 3, trimPauseMs: 1 } });
  const rows = [];
  for (let h = H0 - 200; h < H0 - 190; h++) { rows.push([h, "a", 1, 1, 1], [h, "b", 1, 1, 1]); db.nameHourPut({ h, launches: 200, creators: 100, partial: 0 }); }
  rows.push([H0 - 2, "a", 1, 1, 1]); db.nameHourPut({ h: H0 - 2, launches: 200, creators: 100, partial: 0 });
  db.nameCountsPut(rows);
  const n = await c.trim();
  assert.equal(n, 30, "20 count rows and 10 hour rows");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM name_counts").get().n, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM name_hours").get().n, 1);
  await c.stop(); db.close();
});

/** A temp spore.sqlite with clean, partial and orphan hours. */
function baseFile(dir) {
  const file = join(dir, "spore.sqlite"), db = new Db(file);
  const put = (h, partial, feats) => { db.nameHourPut({ h, launches: 1000, creators: 500, partial }); db.nameCountsPut(feats.map(([f, cr, w]) => [h, f, cr, w, w])); };
  const H = H0 + 100;
  put(H - 50, 0, [["veto", 1, 1], ["cat", 40, 40], ["once", 1, 1]]);
  put(H - 49, 0, [["veto", 1, 1], ["cat", 40, 40]]);
  put(H - 26, 0, [["cat", 10, 10], ["day2", 3, 3]]);                      // a day later
  put(H - 47, 0, [["day2", 3, 3]]);                                      // same day as H-50: day2 is seen on 2 days in all
  put(H - 30, PARTIAL.GAP, [["veto", 99, 99]]);                          // partial: never read
  db.nameCountsPut([[H - 29, "veto", 77, 77, 77]]);                      // orphan: no hour row
  put(H - 10, 0, [["veto", 55, 55]]);                                    // inside the last 24 h: left out
  db.close();
  return { file, H };
}

test("readBaseline: clean hours only, orphans and the last 24 h left out, most creators first; known needs 10+ whole carriers (and 3 in 10,000 launches) on 2+ days; a cap is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-names-"));
  try {
    const { file, H } = baseFile(dir);
    const b = readBaseline(file, H);
    assert.deepEqual([b.hours, b.launches], [4, 4000]);
    const of = Object.fromEntries(b.f.map((f, i) => [f, { C: b.c[i], W: b.w[i], known: !!b.k[i] }]));
    assert.deepEqual(b.f, ["cat", "day2", "veto"], "C >= 2 or W >= 2; a singleton (once) is left to the prior");
    assert.deepEqual(of.veto, { C: 2, W: 2, known: false });
    assert.deepEqual(of.cat, { C: 90, W: 90, known: true });
    assert.equal(of.day2.known, false, "rules v3: 6 whole carriers on 2 days is a scrap, not a known token");
    const low = readBaseline(file, H, { knownLaunches: 5 });
    assert.equal(!!low.k[low.f.indexOf("day2")], true, "6 on 2 days is known at the v2 floor of 5");
    const share = readBaseline(file, H, { knownShare: 0.05 });
    assert.equal(!!share.k[share.f.indexOf("cat")], false, "90 whole carriers in 4,000 launches is under a 5% share");
    const capped = readBaseline(file, H, { maxFeatures: 1 });
    assert.deepEqual([capped.f, capped.capHit], [["cat"], true]);
    const base = new Baseline({ H, hours: b.hours, launches: b.launches, at: 0, map: new Map() });
    assert.deepEqual(base.get("nothing"), { C: 1, W: 0, known: false, missing: true }, "a missing feature counts as C = 1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

class FakeWorker extends EventEmitter {
  static all = [];
  constructor(url, opts) { super(); this.opts = opts; this.sent = []; FakeWorker.all.push(this); }
  postMessage(m) { this.sent.push(m); }
  unref() {}
  terminate() { return Promise.resolve(); }
}

test("the worker's answer arrives in 2,000-entry messages, pulled one at a time (each filed, then the next asked for), and is swapped in at the end; a stale baseline is not ready", async () => {
  FakeWorker.all = [];
  const db = new Db(":memory:");
  const { c, clock } = counter(db, { file: "x.sqlite", Worker: FakeWorker });
  const w = FakeWorker.all[0];
  assert.equal(w.opts.workerData.role, "name-baseline");
  assert.equal(c.firstDone, false);
  c.runBase();
  const m = w.sent[0];
  assert.deepEqual([m.kind, m.H], ["base", H0 - 1], "the hour of the clock");
  w.emit("message", { kind: "base-start", id: m.id, H: m.H, hours: 30, launches: 40_000, total: 3, known: 1, capHit: false, ms: 12 });
  assert.deepEqual(w.sent.at(-1), { kind: "more", id: m.id }, "the start filed, the first chunk asked for");
  w.emit("message", { kind: "base-chunk", id: m.id, f: ["cat", "veto"], c: Uint32Array.from([90, 2]), w: Uint32Array.from([90, 2]), k: Uint8Array.from([1, 0]) });
  assert.equal(c.base, null, "not swapped before the end");
  assert.equal(w.sent.filter((x) => x.kind === "more").length, 2, "one ask per message filed");
  w.emit("message", { kind: "base-chunk", id: m.id, f: ["harry"], c: Uint32Array.from([7]), w: Uint32Array.from([5]), k: Uint8Array.from([1]) });
  w.emit("message", { kind: "base-end", id: m.id });
  assert.ok(c.base && c.firstDone);
  assert.deepEqual([c.base.get("cat").C, c.base.get("harry").known, c.base.get("veto").known, c.base.features], [90, true, false, 3]);
  assert.equal(c.base.vocab().known("cat"), true); assert.equal(c.base.vocab().n, 40_000);
  assert.equal(c.base.share("veto"), 2.5 / 40_000);
  assert.equal(c.base.ready(clock.s * 1000), true);
  assert.equal(c.base.ready(clock.s * 1000 + 3 * 3600_000 + 1), false, "older than 3 h");
  // an answer to an older job is ignored
  w.emit("message", { kind: "base-start", id: m.id - 1, H: 1, hours: 1, launches: 1 });
  assert.equal(c.building, null);
  await c.stop(); db.close();
});

test("a dead worker is started again by the hourly tick at most 5 times; a failed pass keeps the last baseline", async () => {
  FakeWorker.all = [];
  const db = new Db(":memory:");
  const { c } = counter(db, { file: "x.sqlite", Worker: FakeWorker, cfg: { everyMs: 5 } });
  const w0 = FakeWorker.all[0];
  c.runBase();
  let id = w0.sent.at(-1).id;
  w0.emit("message", { kind: "base-start", id, H: H0, hours: 30, launches: 40_000 }); w0.emit("message", { kind: "base-end", id });
  const kept = c.base;
  c.runBase(); id = w0.sent.at(-1).id;
  w0.emit("message", { kind: "error", id, error: "database is locked" });
  assert.equal(c.base, kept, "a failed pass keeps the last baseline");
  assert.equal(c.snapshot().baseline.fails, 1);
  for (let i = 0; i < 8; i++) { FakeWorker.all.at(-1).emit("exit", 1); await new Promise((r) => setTimeout(r, 12)); }
  assert.equal(FakeWorker.all.length, 6, "the first and 5 restarts");
  assert.equal(c.snapshot().baseline.restarts, 5);
  assert.equal(c.firstDone, true, "a dead worker releases the waves' hold");
  await c.stop(); db.close();
});

/** A launch-log file with `hours` whole hours of creates (thin ones where `thin(h)`), names cycling through `names`. */
function logFile(dir, firstH, hours, namesOf, thin = () => false) {
  const file = join(dir, "launches.sqlite"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE creates (mint TEXT PRIMARY KEY, slot INTEGER, t INTEGER, seen INTEGER, name TEXT, symbol TEXT, uri TEXT, creator TEXT, depth INTEGER, quote TEXT, mayhem INTEGER)");
  const ins = db.prepare("INSERT INTO creates VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  let k = 0;
  db.exec("BEGIN");
  for (let h = firstH; h < firstH + hours; h++) {
    const n = thin(h) ? 40 : 150;
    const names = namesOf(h);
    for (let i = 0; i < n; i++) { const t = h * 3600 + 5 + Math.floor((i * 3590) / (n - 1)); ins.run(`m${k++}`, 0, t, t * 1000, names[i % names.length], "", "", `c${i % 70}`, 0, null, 0); }
  }
  db.exec("COMMIT"); db.close();
  return file;
}

test("readBootstrap: complete hours not stored yet, thin hours flagged, each hour split with a vocabulary of hours at least 24 h older", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-boot-"));
  try {
    const first = H0 - 60;
    // Vetocat appears in hour first+20 and from first+40 on; cat in every hour
    const file = logFile(dir, first, 50, (h) => ["Cat King", "Cat Lord", "Doge", ...(h === first + 20 || h >= first + 40 ? ["Vetocat"] : ["Moon"])], (h) => h === first + 10);
    const r = readBootstrap(file, new Set([first + 3]), first + 49, { nowS: 1 });
    assert.equal(r.hours.length, 48, "49 complete hours before H, one already stored");
    const thin = r.hours.find((x) => x.row.h === first + 10);
    assert.deepEqual([thin.row.partial, thin.rows.length], [PARTIAL.THIN, 0]);
    const early = r.hours.find((x) => x.row.h === first + 20), late = r.hours.find((x) => x.row.h === first + 44);
    assert.equal(early.row.src, 1);
    const fsOf = (hr) => hr.rows.map((x) => x[1]);
    assert.ok(!fsOf(early).includes("veto"), "within the first 24 h of the log cat is not known yet: vetocat stays whole");
    assert.ok(fsOf(late).includes("veto"), "cat known from hours 24+ h older (on two days), vetocat new in them: vetocat splits");
    assert.equal(r.thin, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the bootstrap runs once: its rows go in by chunks, each hour row after its rows; kv waveBoot is set and a baseline pass follows; a second start does not ask again", async () => {
  FakeWorker.all = [];
  const db = new Db(":memory:");
  const { c } = counter(db, { file: "x.sqlite", launchLogFile: "log.sqlite", Worker: FakeWorker, cfg: { firstMs: 1, writeChunk: 2 } });
  await new Promise((r) => setTimeout(r, 10));
  const w = FakeWorker.all[0], m = w.sent[0];
  assert.deepEqual([m.kind, m.logFile], ["boot", "log.sqlite"]);
  w.emit("message", { kind: "boot-rows", id: m.id, rows: [[H0 - 30, "a", 1, 1, 1], [H0 - 30, "b", 1, 1, 1], [H0 - 30, "c", 1, 1, 1]] });
  w.emit("message", { kind: "boot-hour", id: m.id, row: { h: H0 - 30, launches: 150, creators: 70, partial: 0, src: 1 } });
  w.emit("message", { kind: "boot-end", id: m.id, hours: 1, rows: 3, thin: 0, launches: 150 });
  c.pump();
  assert.equal(db.nameHoursIn(H0 - 30, H0 - 29).length, 0, "two rows written, the hour row waits");
  drain(c);
  assert.equal(db.nameHoursIn(H0 - 30, H0 - 29)[0].src, 1);
  assert.equal(db.kvGet("waveBoot").rows, 3);
  assert.equal(w.sent.at(-1).kind, "base", "a baseline pass is asked for once the rows are in");
  assert.equal(c.snapshot().boot.state, "done");
  await c.stop();
  FakeWorker.all = [];
  const again = counter(db, { file: "x.sqlite", launchLogFile: "log.sqlite", Worker: FakeWorker, cfg: { firstMs: 1 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(FakeWorker.all[0].sent.map((x) => x.kind), ["base"]);
  await again.c.stop(); db.close();
});

test("the bootstrap is pulled while under bootQueueMax rows wait to be written; at shutdown its queued rows are let go and waveBoot stays unset", async () => {
  FakeWorker.all = [];
  const db = new Db(":memory:");
  const { c } = counter(db, { file: "x.sqlite", launchLogFile: "log.sqlite", Worker: FakeWorker, cfg: { firstMs: 1, writeChunk: 2, bootQueueMax: 4 } });
  await new Promise((r) => setTimeout(r, 10));
  const w = FakeWorker.all[0], m = w.sent[0];
  const asks = () => w.sent.filter((x) => x.kind === "more").length;
  const rows = (h, n) => Array.from({ length: n }, (_, i) => [h, `f${i}`, 1, 1, 1]);
  w.emit("message", { kind: "boot-rows", id: m.id, rows: rows(H0 - 40, 3) });
  assert.equal(asks(), 1, "3 rows queued, under 4: the next is asked for");
  w.emit("message", { kind: "boot-rows", id: m.id, rows: rows(H0 - 40, 3).map((r) => [r[0], `g${r[1]}`, 1, 1, 1]) });
  assert.equal(asks(), 1, "6 rows queued: no ask until the writes catch up");
  c.pump();
  assert.equal(asks(), 1, "4 rows still wait");
  c.pump();
  assert.equal(asks(), 2, "3 wait: under the cap, the next is asked for");
  // a live hour closed while the bootstrap is queued
  c.queue.push({ i: 0, rows: [[H0 - 2, "live", 1, 1, 1]], hour: { h: H0 - 2, launches: 150, creators: 70, partial: 0, src: 0 } });
  await c.stop();
  assert.equal(db.nameHoursIn(H0 - 2, H0 - 1).length, 1, "the closed live hour is written");
  assert.equal(db.nameHoursIn(H0 - 40, H0 - 39).length, 0, "the bootstrap hour is not");
  assert.equal(db.kvGet("waveBoot", null), null, "the next start seeds again");
  db.close();
});

test("the bootstrap keeps its own known threshold (5+): the worker gets bootKnownLaunches and bootOpts never hands it the live baseline's 10", async () => {
  FakeWorker.all = [];
  const db = new Db(":memory:");
  const { c } = counter(db, { file: "x.sqlite", Worker: FakeWorker });
  const o = FakeWorker.all[0].opts.workerData.opts;
  assert.deepEqual([o.knownLaunches, o.bootKnownLaunches], [10, 5]);
  const b = bootOpts(o);
  assert.equal(b.knownLaunches, 5);
  assert.equal(b.knownShare, undefined);
  assert.equal(b.knownDays, 2);
  assert.equal(bootOpts({ knownLaunches: 10, bootKnownLaunches: 7 }).knownLaunches, 7);
  await c.stop(); db.close();
});
