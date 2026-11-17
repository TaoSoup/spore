// GeckoTerminal client (lib/gecko.mjs): the URL and headers, the strict FIFO pacing, 429 pauses, the daily cap kept in
// kv, and every way an answer can fail. A fake fetch answers real Responses (so the capped body read streams); a fake
// clock. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gecko, GeckoError, GECKO_BASE, GECKO_MAX_WAITING, GECKO_429_MS, GECKO_MAX_BYTES } from "../lib/gecko.mjs";
import { Db } from "../lib/db.mjs";
import { quiet } from "./helpers/tree.mjs";
import { key, fakeClock } from "./helpers/chain.mjs";

const POOL = key(31), TOKEN = key(32), QUOTE = key(33);
const page = (list = [[600, 1, 1, 1, 1, 1]]) => ({ data: { attributes: { ohlcv_list: list } }, meta: { base: { address: TOKEN }, quote: { address: QUOTE } } });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
/** A fake fetch: `answer(url, n)` → a Response (or a promise of one); records every call with the clock's time. */
function fakeFetch(clock, answer = () => json(page())) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: new URL(url), init, at: clock.now() }); return answer(new URL(url), calls.length, init); };
  f.calls = calls;
  return f;
}
const q = (over = {}) => ({ pool: POOL, res: 300, currency: "token", token: TOKEN, before: 6000, limit: 20, ...over });
const kindOf = (p) => p.then(() => "ok", (e) => (e instanceof GeckoError ? e.kind : `other: ${e.message}`));

test("9. the URL per res with token, currency, before_timestamp and limit, no include_empty_intervals; accept + a generic UA; a pool that is no address is refused unfetched", async () => {
  const clock = fakeClock(), fetch = fakeFetch(clock);
  const g = new Gecko({ perMin: 600, fetch, now: clock.now, sleep: clock.sleep, log: quiet });
  const r = await g.ohlcv(q());
  assert.deepEqual(r, { status: 200, list: [[600, 1, 1, 1, 1, 1]], meta: { base: TOKEN, quote: QUOTE } });
  for (const [res, tf, agg] of [[60, "minute", "1"], [900, "minute", "15"], [3600, "hour", "1"]]) await g.ohlcv(q({ res, currency: "usd" }));
  const [u0, u1, u2, u3] = fetch.calls.map((c) => c.url);
  assert.equal(`${u0.origin}${u0.pathname}`, `${GECKO_BASE}/networks/solana/pools/${POOL}/ohlcv/minute`);
  assert.deepEqual(Object.fromEntries(u0.searchParams), { aggregate: "5", before_timestamp: "6000", limit: "20", currency: "token", token: TOKEN });
  assert.deepEqual([u1.pathname.split("/").pop(), u1.searchParams.get("aggregate"), u1.searchParams.get("currency")], ["minute", "1", "usd"]);
  assert.deepEqual([u2.pathname.split("/").pop(), u2.searchParams.get("aggregate")], ["minute", "15"]);
  assert.deepEqual([u3.pathname.split("/").pop(), u3.searchParams.get("aggregate")], ["hour", "1"]);
  assert.ok(fetch.calls.every((c) => !c.url.searchParams.has("include_empty_intervals")));
  assert.deepEqual(fetch.calls[0].init.headers, { accept: "application/json", "user-agent": "spore-chart/1" });
  for (const bad of [{ pool: "not-a-pool" }, { token: "x" }, { res: 120 }, { currency: "sol" }, { limit: 1001 }]) assert.equal(await kindOf(g.ohlcv(q(bad))), "http");
  assert.equal(fetch.calls.length, 4, "refused before sending");
  assert.deepEqual([g.snapshot().callsToday, g.snapshot().refused], [4, 5]);
});

test("10. pacing: 5 calls at 8/min go out ≥ 7 500 ms apart in FIFO order; more than 20 waiting → busy; an aborted waiter is dropped uncounted", async () => {
  const clock = fakeClock(), fetch = fakeFetch(clock);
  const g = new Gecko({ perMin: 8, fetch, now: clock.now, sleep: clock.sleep, log: quiet });
  assert.equal(g.gapMs, 7_500);
  await Promise.all([1, 2, 3, 4, 5].map((n) => g.ohlcv(q({ before: n * 300 }))));
  const at = fetch.calls.map((c) => c.at);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 7_500, `${at[i] - at[i - 1]} ms`);
  assert.deepEqual(fetch.calls.map((c) => c.url.searchParams.get("before_timestamp")), ["300", "600", "900", "1200", "1500"], "in arrival order");
  // more than GECKO_MAX_WAITING in line
  const all = Array.from({ length: GECKO_MAX_WAITING + 2 }, () => kindOf(g.ohlcv(q())));
  const kinds = await Promise.all(all);
  assert.deepEqual([kinds.filter((k) => k === "ok").length, kinds.filter((k) => k === "busy").length], [GECKO_MAX_WAITING, 2]);
  // an aborted waiter: dropped at its turn, never sent, never counted
  const before = g.snapshot().callsToday;
  const ac = new AbortController();
  const p = [kindOf(g.ohlcv(q())), kindOf(g.ohlcv(q({ signal: ac.signal }))), kindOf(g.ohlcv(q()))];
  ac.abort();
  assert.deepEqual(await Promise.all(p), ["ok", "stopped", "ok"]);
  assert.deepEqual([g.snapshot().callsToday - before, g.stats.dropped], [2, 1]);
});

test("11. 429: Retry-After 5 → the next call waits 5 s; without it 60 s, then 120 s; a 200 resets it; every attempt (429, 500, timeout) counts in kv geckoCalls", async () => {
  const clock = fakeClock(), db = new Db(":memory:");
  const script = [
    () => json({}, 429, { "retry-after": "5" }), () => json({}, 429), () => json({}, 429), () => json(page()), () => json({}, 429), () => json(page()),
    () => json({}, 500), (u, n, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))),
  ];
  const fetch = fakeFetch(clock, (u, n, init) => script[n - 1](u, n, init));
  const g = new Gecko({ perMin: 600, db, fetch, now: clock.now, sleep: clock.sleep, log: quiet, timeoutMs: 20 });
  const kinds = [];
  for (let i = 0; i < script.length; i++) kinds.push(await kindOf(g.ohlcv(q())));
  assert.deepEqual(kinds, ["rate", "rate", "rate", "ok", "rate", "ok", "http", "timeout"]);
  const gaps = fetch.calls.slice(1).map((c, i) => c.at - fetch.calls[i].at);
  assert.equal(gaps[0], 5_000, "Retry-After");
  assert.equal(gaps[1], GECKO_429_MS, "no Retry-After: 60 s");
  assert.equal(gaps[2], 2 * GECKO_429_MS, "then doubled");
  assert.equal(gaps[3], g.gapMs, "after a 200: the plain gap");
  assert.equal(gaps[4], GECKO_429_MS, "the 200 reset the backoff");
  assert.deepEqual([g.stats.rateLimited, g.stats.ok, g.stats.errors, g.stats.timeouts], [4, 2, 1, 1]);
  g.stop();
  assert.deepEqual(db.kvGet("geckoCalls"), { day: Math.floor(clock.now() / 86_400_000), used: 8 }, "every attempt counted");
  db.close();
});

test("12. the daily cap: daily = 3 → the 4th throws budget unfetched, logged once; the count survives a new Gecko on the same db the same day and resets the next UTC day", async () => {
  const clock = fakeClock(), db = new Db(":memory:"), fetch = fakeFetch(clock), logs = [];
  const log = { info: (m) => logs.push(m), warn: () => {} };
  const make = () => new Gecko({ perMin: 600, daily: 3, db, fetch, now: clock.now, sleep: clock.sleep, log });
  const g = make();
  for (let i = 0; i < 3; i++) assert.equal((await g.ohlcv(q())).status, 200);
  assert.equal(await kindOf(g.ohlcv(q())), "budget");
  assert.equal(await kindOf(g.ohlcv(q())), "budget");
  assert.equal(fetch.calls.length, 3);
  assert.equal(g.spent(), true);
  assert.deepEqual(logs, ["history: the day's 3 GeckoTerminal requests are spent; charts show what is stored until tomorrow (UTC)"]);
  const again = make();
  assert.equal(again.spent(), true, "kept in kv (saved when it became spent)");
  assert.equal(await kindOf(again.ohlcv(q())), "budget");
  clock.t += 86_400_000;
  assert.equal(again.spent(), false);
  assert.equal((await again.ohlcv(q())).status, 200);
  assert.equal(again.snapshot().callsToday, 1);
  db.close();
});

test("13. a timeout → timeout; a body over 1 MB → large; bad JSON or no ohlcv_list → json; 404 → { status: 404 }", async () => {
  const clock = fakeClock();
  const answers = {
    timeout: (u, n, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason))),
    large: () => new Response("x".repeat(GECKO_MAX_BYTES + 1), { status: 200 }),
    json: () => new Response("<html>", { status: 200 }),
    shape: () => json({ data: {} }),
    nf: () => json({ errors: [] }, 404),
  };
  let pick = "timeout";
  const g = new Gecko({ perMin: 600, fetch: fakeFetch(clock, (u, n, init) => answers[pick](u, n, init)), now: clock.now, sleep: clock.sleep, log: quiet, timeoutMs: 20 });
  assert.equal(await kindOf(g.ohlcv(q())), "timeout");
  pick = "large"; assert.equal(await kindOf(g.ohlcv(q())), "large");
  pick = "json"; assert.equal(await kindOf(g.ohlcv(q())), "json");
  pick = "shape"; assert.equal(await kindOf(g.ohlcv(q())), "json");
  pick = "nf"; assert.deepEqual(await g.ohlcv(q()), { status: 404 });
  const s = g.snapshot();
  assert.deepEqual([s.timeouts, s.tooLarge, s.badJson, s.notFound, s.calls, s.callsToday], [1, 1, 2, 1, 5, 5]);
  for (const f of ["callsToday", "daily", "perMin", "waiting", "pausedMs", "calls", "ok", "notFound", "rateLimited", "errors", "timeouts", "tooLarge", "badJson", "refused", "dropped", "lastMs", "lastError"]) assert.ok(f in s, f);
});
