// Live subscription: reconnect backoff with jitter, the stale-socket watchdog, and no duplicate timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LogsSubscriber, jitter } from "../lib/live.mjs";

test("jitter: uniform in [base/2, base]", () => {
  assert.equal(jitter(1000, () => 0), 500);
  assert.equal(jitter(1000, () => 0.999999), 1000);
  for (let i = 0; i < 50; i++) { const j = jitter(30_000); assert.ok(j >= 15_000 && j <= 30_000, String(j)); }
});

test("a socket that fails to open backs off (1 s → 30 s, jittered), one timer at a time; stop clears it", async () => {
  const Real = globalThis.WebSocket;
  let opened = 0;
  globalThis.WebSocket = class { constructor() { opened++; throw new Error("ECONNREFUSED"); } };
  try {
    const warns = [];
    const sub = new LogsSubscriber({ wsUrl: "wss://x.example", programId: "P", onLogs() {}, log: { info() {}, warn: (m) => warns.push(m) }, staleMs: 60_000 }).start();
    assert.equal(opened, 1);
    assert.equal(sub.stats.errors, 1);
    assert.ok(sub.reconnectTimer, "a reconnect is scheduled");
    assert.equal(sub.backoffMs, 1000);
    assert.match(warns[0], /reconnecting in ([5-9]\d\d|1000) ms/);
    const snap = sub.snapshot();
    assert.equal(snap.connected, false); assert.equal(snap.reconnecting, true); assert.equal(snap.backoffMs, 1000);
    sub.stop();
    assert.equal(sub.reconnectTimer, null);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(opened, 1, "stopped: no further attempt");
  } finally { globalThis.WebSocket = Real; }
});

/** A WebSocket the test drives: `sockets` holds every one opened. */
function fakeSockets() {
  const sockets = [];
  class Fake { constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); } send() {} close() { this.readyState = 3; this.onclose?.(); } open() { this.readyState = 1; this.onopen?.(); } }
  return { Fake, sockets };
}
const note = (signature = "S") => JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { result: { context: { slot: 3 }, value: { signature, err: null, logs: ["Program data: x"] } } } });

test("live: onGap fires once at the first notification of each new socket with [previous notification, now]; resumeAt gives the first socket's gap; none without either; steady traffic fires nothing", (t) => {
  const Real = globalThis.WebSocket;
  const { Fake, sockets } = fakeSockets();
  globalThis.WebSocket = Fake;
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const gaps = [], quietLog = { info() {}, warn() {} };
    const sub = new LogsSubscriber({ wsUrl: "wss://x.example", programId: "P", onLogs() {}, log: quietLog, onGap: (a, b) => gaps.push([a, b]), resumeAt: 400_000 }).start();
    sockets[0].open();
    t.mock.timers.tick(5_000);
    sockets[0].onmessage({ data: '{"jsonrpc":"2.0","result":7,"id":1}' }); // the subscribe ack is no delivery
    assert.deepEqual(gaps, []);
    sockets[0].onmessage({ data: note() });
    assert.deepEqual(gaps, [[400_000, 1_005_000]], "the first socket: from when the last process was alive to its first notification");
    for (let i = 0; i < 5; i++) { t.mock.timers.tick(100); sockets[0].onmessage({ data: note() }); }
    assert.equal(gaps.length, 1, "steady traffic fires nothing");
    const last = sub.lastNotificationAt;
    assert.equal(last, 1_005_500);
    // the socket drops; a new one opens a while later and delivers later still: the gap ends at that first notification, not at onopen
    sockets[0].close(); clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null; sub.start();
    t.mock.timers.tick(2_000); sockets[1].open();
    t.mock.timers.tick(3_000); sockets[1].onmessage({ data: note() });
    assert.deepEqual(gaps[1], [last, 1_010_500]);
    sockets[1].onmessage({ data: note() });
    assert.equal(gaps.length, 2, "once per socket");
    sub.stop();
    // neither a previous notification nor resumeAt: nothing to report for the first socket; a failing hook never reaches the stream
    const warns = [];
    const bare = new LogsSubscriber({ wsUrl: "wss://x.example", programId: "P", onLogs() {}, log: { info() {}, warn: (m) => warns.push(m) }, onGap: () => { throw new Error("boom"); } }).start();
    sockets[2].open(); sockets[2].onmessage({ data: note() });
    assert.equal(bare.stats.notifications, 1); assert.deepEqual(warns, []);
    sockets[2].close(); clearTimeout(bare.reconnectTimer); bare.reconnectTimer = null; bare.start();
    sockets[3].open(); sockets[3].onmessage({ data: note() });
    assert.equal(bare.stats.notifications, 2, "the notification is still delivered");
    assert.ok(warns.some((w) => /onGap failed: boom/.test(w)), warns.join("; "));
    bare.stop();
    // no hook: as before
    const plain = new LogsSubscriber({ wsUrl: "wss://x.example", programId: "P", onLogs() {}, log: quietLog, resumeAt: 1 }).start();
    sockets[4].open(); sockets[4].onmessage({ data: note() });
    assert.equal(plain.stats.notifications, 1);
    plain.stop();
  } finally { globalThis.WebSocket = Real; }
});

test("live: a metered socket counts the bytes it receives and moves to the fallback socket for good past its budget", () => {
  const Real = globalThis.WebSocket;
  const { Fake, sockets } = fakeSockets();
  globalThis.WebSocket = Fake;
  try {
    const warns = [];
    const sub = new LogsSubscriber({ wsUrl: "wss://metered.example/?api-key=SECRET", fallbackUrl: "wss://free.example", budgetBytes: 1000, meteredBytes: 0, programId: "P", onLogs() {}, log: { info() {}, warn: (m) => warns.push(m) } }).start();
    assert.equal(sockets[0].url, "wss://metered.example/?api-key=SECRET");
    sockets[0].open();
    const n = note();
    sockets[0].onmessage({ data: n });
    assert.equal(sub.meteredBytes, n.length);
    assert.equal(sub.snapshot().metered, true);
    while (!sub.overBudget) sockets[0].onmessage({ data: n });
    assert.ok(sub.meteredBytes >= 1000);
    assert.match(warns.join("\n"), /budget used/);
    assert.ok(!warns.join("\n").includes("SECRET"), "the key is never logged");
    clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null; sub.start();
    assert.equal(sockets.at(-1).url, "wss://free.example");
    const before = sub.meteredBytes;
    sockets.at(-1).open(); sockets.at(-1).onmessage({ data: n });
    assert.equal(sub.meteredBytes, before, "the fallback socket is not metered");
    assert.equal(sub.snapshot().overBudget, true);
    // a restart that starts over budget opens the fallback at once
    const sub2 = new LogsSubscriber({ wsUrl: "wss://metered.example", fallbackUrl: "wss://free.example", budgetBytes: 1000, meteredBytes: 5000, programId: "P", onLogs() {}, log: { info() {}, warn() {} } }).start();
    assert.equal(sockets.at(-1).url, "wss://free.example");
    sub.stop(); sub2.stop();
  } finally { globalThis.WebSocket = Real; }
});
