// lib/checkpointer.mjs: the WAL checkpoint in a worker thread; the main connection's automatic checkpoint off while it
// runs and back on when it fails, ends unasked, is stopped, keeps failing or lets the log file grow past the watchdog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../lib/db.mjs";
import { Checkpointer, AUTO_PAGES, ASSIST_FRAMES, ASSIST_GAP_MS, ERRORS_MAX, WATCHDOG_BYTES } from "../lib/checkpointer.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const autoPages = (db) => db.db.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint;
const until = async (f, ms = 5_000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };
/** A main-connection passive checkpoint that the worker's lock did not refuse (a refused one says nothing about the log). */
const passive = async (db) => { for (let i = 0; i < 100; i++) { const r = db.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(); if (!r.busy && r.log >= 0) return r; await new Promise((res) => setTimeout(res, 5)); } throw new Error("always busy"); };
class FakeWorker extends EventEmitter { static made = []; constructor() { super(); FakeWorker.made.push(this); } postMessage() {} terminate() { this.ended = true; return Promise.resolve(); } unref() {} }
const run = (o = {}) => ({ ms: 10, log: 1200, last: 1200, done: 1200, settled: true, passes: 2, busy: false, idle: false, ...o });

test("the worker checkpoints the log the main connection writes, with the automatic checkpoint off; under steady writes the log keeps starting over; stop() turns it back on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-ckpt-"));
  const file = join(dir, "t.sqlite");
  const db = new Db(file);
  const c = new Checkpointer(db, file, { everyMs: 50, log: quiet }).start();
  try {
    assert.equal(c.state, "worker");
    assert.equal(autoPages(db), 0, "the main connection no longer checkpoints in its commits");
    db.db.exec("CREATE TABLE big (k INTEGER PRIMARY KEY, v BLOB)");
    const ins = db.db.prepare("INSERT INTO big (k, v) VALUES (?, randomblob(3000))");
    db.transaction(() => { for (let i = 0; i < 1500; i++) ins.run(i); }); // ~1500 pages: past the automatic threshold
    await until(() => c.stats.lastFrames >= 1000);
    assert.ok(statSync(file).size > 3_000_000, "the pages reached the database file");
    assert.ok(c.stats.runs >= 1 && c.stats.errors === 0, JSON.stringify(c.snapshot()));
    // the next write after a complete checkpoint starts the log over
    db.transaction(() => ins.run(5_000));
    assert.ok((await passive(db)).log < 100, "the log started over");
    // steady writes for 1.5 s while the worker checkpoints: the log keeps starting over instead of growing
    const stopAt = Date.now() + 1_500;
    let k = 10_000;
    await new Promise((resolve) => { const t = setInterval(() => { db.transaction(() => { for (let i = 0; i < 20; i++) ins.run(k++); }); if (Date.now() > stopAt) { clearInterval(t); resolve(); } }, 5); });
    const end = await passive(db);
    assert.ok(end.log < 3_000, `the log stays short under steady writes (${end.log} frames; ${JSON.stringify(c.snapshot())})`);
    assert.ok(c.snapshot().lastAgoMs < 2_000, "the worker reports");
  } finally {
    await c.stop(); // the worker's connection is closed before the folder goes (Windows keeps open files)
    assert.equal(c.state, "stopped");
    assert.equal(autoPages(db), AUTO_PAGES, "stop() hands the checkpoint back to the main connection");
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("runs: idle and busy runs are not counted as runs; an unsettled run is; a reader-held log is counted as pinned, never assisted", () => {
  const db = new Db(":memory:");
  FakeWorker.made.length = 0;
  let assists = 0;
  db.checkpointPassive = () => { assists++; return { busy: false, log: 10, done: 10 }; };
  const c = new Checkpointer(db, ":memory:", { log: quiet, Worker: FakeWorker }).start();
  const w = FakeWorker.made[0];
  w.emit("message", run({ ms: 12.345 }));
  assert.deepEqual([c.stats.runs, c.stats.lastMs, c.stats.maxFrames, c.stats.maxPasses, c.stats.unfinished], [1, 12.35, 1200, 2, 0]);
  w.emit("message", run({ idle: true }));
  w.emit("message", run({ log: 0, last: 0, done: 0 }));
  assert.equal(c.stats.runs, 1, "idle runs are not runs");
  w.emit("message", run({ busy: true, log: 0, last: -1, done: -1, settled: false }));
  assert.deepEqual([c.stats.runs, c.stats.busy, c.stats.unfinished], [1, 1, 0], "a busy run that saw nothing changes only busy");
  w.emit("message", run({ busy: true, log: 900, last: 900, done: -1, settled: false }));
  assert.deepEqual([c.stats.busy, c.stats.unfinished], [2, 1]);
  w.emit("message", run({ log: 60_000, last: 60_000, done: 100, settled: false, passes: 10 }));
  assert.deepEqual([c.stats.pinned, c.stats.unfinished, assists], [1, 2, 0], "a reader holds the log: nothing to do here");
  c.stop(); db.close();
});

test("assist: an unsettled run with every frame copied and a long log has the main thread checkpoint once, at most every ASSIST_GAP_MS; a refused one is counted apart", () => {
  const db = new Db(":memory:");
  FakeWorker.made.length = 0;
  const clock = { t: 1_000_000 };
  const answers = [];
  db.checkpointPassive = () => answers.shift() ?? { busy: false, log: 30, done: 30 };
  const c = new Checkpointer(db, ":memory:", { log: quiet, Worker: FakeWorker, now: () => clock.t }).start();
  const w = FakeWorker.made[0];
  const hot = run({ log: ASSIST_FRAMES, last: ASSIST_FRAMES + 50, done: ASSIST_FRAMES + 50, settled: false, passes: 10 });
  w.emit("message", run({ log: ASSIST_FRAMES - 100, last: ASSIST_FRAMES - 1, done: ASSIST_FRAMES - 1, settled: false }));
  assert.equal(c.stats.assists, 0, "under ASSIST_FRAMES: the worker keeps at it");
  w.emit("message", hot);
  assert.equal(c.stats.assists, 1);
  assert.ok(c.stats.lastAssistMs >= 0);
  clock.t += ASSIST_GAP_MS - 1;
  w.emit("message", hot);
  assert.equal(c.stats.assists, 1, "not twice within ASSIST_GAP_MS");
  clock.t += 1;
  answers.push({ busy: true, log: -1, done: -1 });
  w.emit("message", hot);
  assert.deepEqual([c.stats.assists, c.stats.assistBusy], [1, 1], "the worker held the lock: refused, not counted as done");
  c.stop(); db.close();
});

test("fallback: a worker that fails, ends unasked, cannot start or keeps failing leaves the main connection checkpointing itself, once; late events of an old worker change nothing", () => {
  const db = new Db(":memory:");
  const warns = [];
  const log = { ...quiet, warn: (m) => warns.push(m) };
  FakeWorker.made.length = 0;
  const c = new Checkpointer(db, ":memory:", { log, Worker: FakeWorker }).start();
  assert.equal(autoPages(db), 0);
  FakeWorker.made[0].emit("exit", 1);
  assert.equal(c.state, "fallback");
  assert.equal(autoPages(db), AUTO_PAGES);
  assert.equal(warns.length, 1);
  FakeWorker.made[0].emit("error", new Error("late")); // the same, gone worker: nothing more
  assert.equal(warns.length, 1);
  c.stop();

  const broken = new Checkpointer(db, ":memory:", { log, Worker: class { constructor() { throw new Error("no threads"); } } }).start();
  assert.equal(broken.state, "fallback");
  assert.match(broken.snapshot().lastError, /no threads/);

  FakeWorker.made.length = 0;
  const failing = new Checkpointer(db, ":memory:", { log, Worker: FakeWorker }).start();
  assert.equal(autoPages(db), 0);
  for (let i = 0; i < ERRORS_MAX - 1; i++) FakeWorker.made[0].emit("message", { error: "SQLITE_IOERR" });
  FakeWorker.made[0].emit("message", run());
  for (let i = 0; i < ERRORS_MAX - 1; i++) FakeWorker.made[0].emit("message", { error: "SQLITE_IOERR" });
  assert.equal(failing.state, "worker", "a good run in between resets the count");
  FakeWorker.made[0].emit("message", { error: "SQLITE_IOERR" });
  assert.equal(failing.state, "fallback");
  assert.equal(autoPages(db), AUTO_PAGES);
  failing.stop(); db.close();
});

test("watchdog: a log file past WATCHDOG_BYTES ends a worker that is alive but not keeping it in hand; a small or missing one does nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-dog-"));
  const file = join(dir, "d.sqlite");
  const db = new Db(file);
  FakeWorker.made.length = 0;
  const c = new Checkpointer(db, file, { log: quiet, Worker: FakeWorker }).start();
  try {
    c.watchdog();
    assert.equal(c.state, "worker", "a small log: nothing");
    c.file = join(dir, "missing.sqlite");
    c.watchdog();
    assert.equal(c.state, "worker", "no log file: nothing");
    c.file = join(dir, "large");
    writeFileSync(`${c.file}-wal`, "");
    truncateSync(`${c.file}-wal`, WATCHDOG_BYTES + 1); // extended, not written
    c.watchdog();
    assert.equal(c.state, "fallback");
    assert.equal(autoPages(db), AUTO_PAGES);
  } finally {
    c.stop(); db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
