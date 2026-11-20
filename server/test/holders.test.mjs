// Holder facts (lib/holders.mjs): the measured shares (the curve's and the pool's vault accounts left out, a holder's
// accounts summed, the dev from the 20 largest or one more call), the states (pending until read, ok, unknown after a
// failure or without supply or RPC), the cache (no call inside 5 min, a stale answer served while it is read again),
// the per-minute cap, the age limit on a served answer, the ordered and bounded queue (first reads before refreshes, a
// wish nobody asked for again let go, the top rows never starved), and the "holders" RPC lane on RPC_URL only. A fake
// lane and clock. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Holders, HOLDERS_TTL_MS, HOLDERS_FAIL_MS, HOLDERS_QUEUE_MAX, HOLDERS_PER_MIN } from "../lib/holders.mjs";
import { Rpc } from "../lib/rpc.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { quiet } from "./helpers/tree.mjs";
import { fakeClock } from "./helpers/chain.mjs";

const key = (i, fill = 5) => { const b = Buffer.alloc(32, fill); b.writeUInt32BE(i, 28); return new PublicKey(b).toBase58(); };
const SUPPLY = "1000000000000000";
const CURVE = key(1), POOL = key(2), DEV = key(3), VAULT = key(4, 7);

/** A coin as the model holds it; `creatorKey` stands in for the launcher. */
function fakeModel(coins) {
  const m = new Map(coins.map((c) => [c.mint, c]));
  return { coins: m, creatorKey: (c) => c.launcher ?? null };
}
/**
 * A lane that answers from `book`: mint → [[account, owner, amount], ...] (largest first), and `devHeld`: wallet → amount
 * outside the 20 largest. `fail` makes every call throw; `hold` keeps calls pending until released.
 */
function fakeRpc(book, { devHeld = {}, fail = false } = {}) {
  const rpc = {
    calls: [], fail, pending: [],
    async call(method, params) {
      rpc.calls.push([method, params[0]]);
      if (rpc.fail) throw new Error("upstream down");
      if (method === "getTokenLargestAccounts") return { value: (book[params[0]] ?? []).map(([address, , amount]) => ({ address, amount, decimals: 6 })) };
      if (method === "getMultipleAccounts") {
        assert.deepEqual(params[1].dataSlice, { offset: 32, length: 32 }, "only the owner field is read");
        const owner = new Map(Object.values(book).flat().map(([a, o]) => [a, o]));
        return { value: params[0].map((a) => (owner.has(a) ? { data: [new PublicKey(owner.get(a)).toBuffer().toString("base64"), "base64"] } : null)) };
      }
      if (method === "getTokenAccountsByOwner") return { value: devHeld[params[0]] != null ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: devHeld[params[0]] } } } } } }] : [] };
      throw new Error(`unexpected ${method}`);
    },
  };
  return rpc;
}
const acct = (i) => key(100 + i, 9);

test("the shares: the curve's and the pool's vault accounts are left out, a holder's accounts are summed, the 10 largest; the dev among the 20 largest costs no third call", async () => {
  const A = { mint: key(10, 1), tokenTotalSupply: SUPPLY, curve: CURVE, pool: POOL, poolBaseVault: VAULT, launcher: DEV };
  const rows = [[acct(0), CURVE, "500000000000000"], [VAULT, POOL, "200000000000000"], [acct(1), DEV, "50000000000000"], [acct(2), key(20), "30000000000000"], [acct(3), key(20), "25000000000000"]];
  for (let i = 0; i < 12; i++) rows.push([acct(10 + i), key(30 + i), String(10_000_000_000_000 - i * 100_000_000_000)]); // 1 %, 0.99 %, ...
  const rpc = fakeRpc({ [A.mint]: rows });
  const clock = fakeClock(1_000_000);
  const h = new Holders({ model: fakeModel([A]), rpc, now: clock.now, log: quiet });
  assert.deepEqual(h.get(A), { devPct: null, top10Pct: null, state: "pending" });
  await h.settle();
  // the 10 largest holders: key(20) 5.5 %, DEV 5 %, then eight of 1 %..0.93 % (sum 7.72 %): 18.22 → 18.2
  assert.deepEqual(h.get(A), { devPct: 5, top10Pct: 18.2, state: "ok" });
  assert.deepEqual(rpc.calls.map((c) => c[0]), ["getTokenLargestAccounts", "getMultipleAccounts"]);
  h.stop();
});

test("the dev outside the 20 largest: one getTokenAccountsByOwner for this mint; no launcher known: devPct null", async () => {
  const A = { mint: key(11, 1), tokenTotalSupply: SUPPLY, curve: CURVE, launcher: DEV };
  const Bc = { mint: key(12, 1), tokenTotalSupply: SUPPLY, curve: CURVE };
  const book = { [A.mint]: [[acct(0), key(20), "100000000000000"]], [Bc.mint]: [[acct(1), key(21), "20000000000000"]] };
  const rpc = fakeRpc(book, { devHeld: { [DEV]: "1234000000000" } });
  const h = new Holders({ model: fakeModel([A, Bc]), rpc, log: quiet });
  h.get(A); h.get(Bc);
  await h.settle();
  assert.deepEqual([h.get(A), h.get(Bc)], [{ devPct: 0.1, top10Pct: 10, state: "ok" }, { devPct: null, top10Pct: 2, state: "ok" }]);
  assert.deepEqual(rpc.calls.filter((c) => c[0] === "getTokenAccountsByOwner"), [["getTokenAccountsByOwner", DEV]]);
  h.stop();
});

test("cache and states: no call inside 5 min; a stale answer is served while it is read again; a failed read is unknown and tried again after 2 min; no supply or no RPC is unknown at once", async () => {
  const A = { mint: key(13, 1), tokenTotalSupply: SUPPLY, curve: CURVE };
  const rpc = fakeRpc({ [A.mint]: [[acct(0), key(20), "100000000000000"]] });
  const clock = fakeClock(1_000_000);
  const h = new Holders({ model: fakeModel([A]), rpc, now: clock.now, log: quiet });
  h.get(A); await h.settle();
  const n = rpc.calls.length;
  clock.t += HOLDERS_TTL_MS - 1;
  assert.equal(h.get(A).state, "ok"); await h.settle();
  assert.equal(rpc.calls.length, n, "cached");
  clock.t += 1;
  rpc.fail = true;
  assert.deepEqual(h.get(A), { devPct: null, top10Pct: 10, state: "ok" }, "stale: served while read again");
  await h.settle();
  assert.deepEqual([h.get(A).state, h.snapshot().failed], ["ok", 1], "a failed refresh keeps the last read while it is under 10 min old");
  clock.t += HOLDERS_FAIL_MS;
  h.get(A); await h.settle();
  clock.t += HOLDERS_TTL_MS; // the last good read is now over 10 min old
  h.get(A); await h.settle();
  assert.deepEqual(h.get(A), { devPct: null, top10Pct: null, state: "unknown" });
  const calls = rpc.calls.length;
  clock.t += HOLDERS_FAIL_MS - 1;
  h.get(A); await h.settle();
  assert.equal(rpc.calls.length, calls, "not before 2 min");
  rpc.fail = false; clock.t += 1;
  h.get(A); await h.settle();
  assert.equal(h.get(A).state, "ok");
  const none = { mint: key(14, 1), tokenTotalSupply: "0" };
  assert.deepEqual([h.get(none).state, new Holders({ model: fakeModel([A]), rpc: null, log: quiet }).get(A).state], ["unknown", "unknown"]);
  h.stop();
});

test("the per-minute cap: a read starts only when its 3 calls fit in the last 60 s; then it waits for the oldest call to leave the minute", async () => {
  const coins = [0, 1, 2, 3].map((i) => ({ mint: key(40 + i, 1), tokenTotalSupply: SUPPLY, curve: CURVE, launcher: DEV }));
  const book = Object.fromEntries(coins.map((c, i) => [c.mint, [[acct(i), key(50 + i), "10000000000000"]]]));
  const rpc = fakeRpc(book, { devHeld: { [DEV]: "1" } }); // 3 calls a coin
  const clock = fakeClock(5_000_000), timers = [];
  const h = new Holders({ model: fakeModel(coins), rpc, now: clock.now, log: quiet, perMin: 7, setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimer() {} });
  for (const c of coins) h.get(c);
  await h.settle();
  assert.deepEqual([rpc.calls.length, queued(h), h.snapshot().capWaits, timers.length], [6, 2, 1, 1], "2 coins (6 calls); a third would make 9 > 7");
  assert.ok(timers[0].ms >= 60_000 - 10 && timers[0].ms <= 60_010, `waits ${timers[0].ms} ms`);
  clock.t += 60_000;
  timers.shift().fn(); await h.settle();
  assert.deepEqual([rpc.calls.length, queued(h)], [12, 0]);
  assert.deepEqual(coins.map((c) => h.get(c).state), ["ok", "ok", "ok", "ok"]);
  assert.equal(HOLDERS_PER_MIN, 30);
  h.stop();
});

/** Timers that run when the fake clock has passed them (\`run()\`): the queue's waits on the per-minute cap. */
function fakeTimers(clock) {
  const list = new Set();
  return {
    setTimer: (fn, ms) => { const x = { fn, at: clock.t + ms, unref() {} }; list.add(x); return x; },
    clearTimer: (x) => list.delete(x),
    run() { for (const x of [...list]) if (x.at <= clock.t) { list.delete(x); x.fn(); } },
  };
}
/** \`n\` coins whose dev is outside the 20 largest (3 calls each: the worst case for the cap). */
function costly(n, at = 2000) {
  const coins = Array.from({ length: n }, (_, i) => ({ mint: key(at + i, 3), tokenTotalSupply: SUPPLY, curve: CURVE, launcher: DEV }));
  return { coins, rpc: fakeRpc(Object.fromEntries(coins.map((c, i) => [c.mint, [[acct(i), key(9000 + i), "10000000000000"]]])), { devHeld: { [DEV]: "1" } }) };
}
const queued = (h) => h.snapshot().queue;
const reads = (rpc) => rpc.calls.filter((c) => c[0] === "getTokenLargestAccounts").map((c) => c[1]);

test("the queue is bounded: past HOLDERS_QUEUE_MAX a new wish is refused, never the oldest (the top rows) dropped; asked again it keeps its place", () => {
  const coins = Array.from({ length: HOLDERS_QUEUE_MAX + 10 }, (_, i) => ({ mint: key(1000 + i, 2), tokenTotalSupply: SUPPLY }));
  const h = new Holders({ model: fakeModel(coins), rpc: fakeRpc({}), log: quiet, perMin: 0, setTimer: () => ({ unref() {} }), clearTimer() {} });
  for (const c of coins) assert.equal(h.get(c).state, "pending");
  assert.deepEqual([queued(h), h.snapshot().refused, h.first.has(coins[0].mint), h.first.has(coins.at(-1).mint)], [HOLDERS_QUEUE_MAX, 10, true, false]);
  h.get(coins[5]);
  assert.deepEqual([queued(h), [...h.first.keys()][5]], [HOLDERS_QUEUE_MAX, coins[5].mint], "asked again: same place, nothing goes");
  assert.ok(HOLDERS_QUEUE_MAX <= 100, "about what the cap reads in one TTL");
  h.stop();
});

test("first reads go before refreshes; when full a refresh gives its place to a first read, and a refresh is refused", async () => {
  const { coins, rpc } = costly(HOLDERS_QUEUE_MAX + 6);
  const R = coins.slice(0, 5), N = coins[5], rest = coins.slice(6);
  const clock = fakeClock(1_000_000), tm = fakeTimers(clock);
  const h = new Holders({ model: fakeModel(coins), rpc, now: clock.now, log: quiet, perMin: 1000, ...tm });
  for (const c of R) h.get(c);
  await h.settle();
  assert.deepEqual(R.map((c) => h.get(c).state), ["ok", "ok", "ok", "ok", "ok"]);
  clock.t += HOLDERS_TTL_MS;
  h.perMin = 0; // hold the reads: everything waits
  for (const c of R) assert.equal(h.get(c).state, "ok", "stale: served while its refresh waits");
  h.get(N);
  assert.deepEqual([h.first.size, h.refresh.size], [1, 5]);
  // full: one more first read takes the oldest refresh's place; a refresh asked then is refused
  for (const c of rest.slice(0, HOLDERS_QUEUE_MAX - 7)) h.get(c);
  assert.equal(queued(h), HOLDERS_QUEUE_MAX - 1);
  h.get(rest.at(-2));
  h.get(rest.at(-1));
  assert.deepEqual([queued(h), h.refresh.size, h.refresh.has(R[0].mint), h.snapshot().dropped], [HOLDERS_QUEUE_MAX, 4, false, 1]);
  h.cache.get(R[0].mint).next = 0;
  assert.equal(h.get(R[0]).state, "ok");
  assert.deepEqual([h.refresh.has(R[0].mint), h.snapshot().refused], [false, 1]);
  const before = reads(rpc).length;
  h.perMin = 1000; clock.t += 60_000; tm.run(); await h.settle();
  const order = reads(rpc).slice(before);
  assert.deepEqual([order[0], order.slice(-4)], [N.mint, R.slice(1).map((c) => c.mint)], "the coins with no numbers first, the refreshes last");
  h.stop();
});

test("a wish nobody asked for again within the TTL (its coin left every list) is let go unread", async () => {
  const { coins: [A, Bc], rpc } = costly(2);
  const clock = fakeClock(1_000_000), tm = fakeTimers(clock);
  const h = new Holders({ model: fakeModel([A, Bc]), rpc, now: clock.now, log: quiet, perMin: 0, ...tm });
  h.get(A); h.get(Bc);
  clock.t += HOLDERS_TTL_MS + 1;
  h.get(Bc); // still listed: asked again
  h.perMin = 1000; tm.run(); await h.settle();
  assert.deepEqual([reads(rpc), h.snapshot().unasked], [[Bc.mint], 1]);
  h.stop();
});

test("an answer is served as ok up to twice the TTL old; older it says pending (its refresh keeps its place)", async () => {
  const { coins: [A], rpc } = costly(1);
  const clock = fakeClock(1_000_000), tm = fakeTimers(clock);
  const h = new Holders({ model: fakeModel([A]), rpc, now: clock.now, log: quiet, perMin: 1000, ...tm });
  h.get(A); await h.settle();
  h.perMin = 0;
  clock.t += 2 * HOLDERS_TTL_MS;
  assert.deepEqual([h.get(A).state, h.refresh.has(A.mint)], ["ok", true], "10 min old: still served");
  clock.t += 1;
  assert.deepEqual([h.get(A), h.refresh.has(A.mint)], [{ devPct: null, top10Pct: null, state: "pending" }, true], "too old to state as now");
  h.perMin = 1000; clock.t += 60_000; tm.run(); await h.settle();
  assert.equal(h.get(A).state, "ok");
  h.stop();
});

test("under load the rows asked first are read first, and a coin new to a list is read next, not behind the refreshes (every row asked every 5 s, the real cap)", async () => {
  const step = async (h, clock, tm, list) => { clock.t += 5_000; tm.run(); for (const c of list) h.get(c); await h.settle(); };
  // 400 rows wanted (dropping the oldest wish read 61 of them in 30 min and never rows 1-49): the top 50 in 6 min, in order
  {
    const { coins, rpc } = costly(400);
    const clock = fakeClock(1_000_000), tm = fakeTimers(clock);
    const h = new Holders({ model: fakeModel(coins), rpc, now: clock.now, log: quiet, ...tm });
    for (let s = 0; s < 72; s++) await step(h, clock, tm, coins);
    assert.deepEqual(reads(rpc).slice(0, 50), coins.slice(0, 50).map((c) => c.mint), "rows 0-49 read, in list order");
    assert.ok(queued(h) <= HOLDERS_QUEUE_MAX);
    h.stop();
  }
  // 100 rows (more than ~10 a minute x 5 min can refresh): a new coin waits for one read slot, not for the refreshes
  {
    const { coins, rpc } = costly(101, 4000);
    const fresh = coins.pop();
    const clock = fakeClock(1_000_000), tm = fakeTimers(clock);
    const h = new Holders({ model: fakeModel([...coins, fresh]), rpc, now: clock.now, log: quiet, ...tm });
    for (let s = 0; s < 12 * 20; s++) await step(h, clock, tm, coins);
    assert.ok(h.refresh.size > 20, `refreshes waiting: ${h.refresh.size}`);
    const t0 = clock.t, list = [...coins, fresh];
    while (h.get(fresh).state !== "ok") { assert.ok(clock.t - t0 <= 60_000, "read within a minute"); await step(h, clock, tm, list); }
    assert.ok(reads(rpc).includes(fresh.mint));
    h.stop();
  }
});

test("the holders lane: its own budget on RPC_URL, never the metered user endpoint", async () => {
  const hosts = [];
  const rpc = new Rpc({ url: "https://free.example", rps: 1000, log: quiet, user: { url: "https://metered.example/?api-key=k", rps: 1000 },
    fetchImpl: async (url, init) => { hosts.push(new URL(url).host); return new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { value: [] } }), { headers: { "content-type": "application/json" } }); } });
  await rpc.lane("holders").call("getTokenLargestAccounts", ["x"]);
  await rpc.lane("api").call("getTokenLargestAccounts", ["x"]);
  assert.deepEqual(hosts, ["free.example", "metered.example"]);
  assert.ok("holders" in rpc.laneSnapshot());
  rpc.close();
});
