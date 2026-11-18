// The post-text fetcher (lib/xposts.mjs): the one URL it asks, the line and its pace, the daily cap kept in kv, the low
// class, what each answer stores (or does not), pauses and the breaker, rechecks, restarts, the asked_at touch, the
// prune, flagged texts and the caps on what is kept in memory. A fake fetch answers real Responses (so the capped body read streams); a fake clock; sqlite in
// memory. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { XPosts, XPOST_URL, XPOST_MAX_BYTES, MAX_WAITING, RETRY_MS, XPOST_PAUSE_MS, XPOST_PAUSE_MAX_MS, BREAK_AFTER, WAIT_AHEAD, XPOST_LRU, FAILED_MAX, XPOST_TOUCH_S, XPOST_KEEP_S, RECHECK_GONE_S, RECHECK_DENIED_S, RECHECK_NEW_S, RECHECK_OLD_S } from "../lib/xposts.mjs";
import { Db } from "../lib/db.mjs";
import { quiet } from "./helpers/tree.mjs";
import { fakeClock, T0 } from "./helpers/chain.mjs";

const NOW_S = T0 + 63_400_000; // a time X's ids can say (after 2010)
/** A post id made at `agoS` before the test's start (snowflake: ms since X's epoch << 22), `n` to tell ids of one moment apart. */
const idAt = (agoS = 3600, n = 0) => String(((BigInt((NOW_S - agoS) * 1000) - 1288834974657n) << 22n) + BigInt(n));
const idOf = (url) => new URL(url).searchParams.get("url").split("/").pop();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
/** X's oEmbed answer for a post. */
const embed = (id, { handle = "tradfi", text = "Hello <a href=\"https://t.co/x\">world</a>" } = {}) => ({
  url: `https://twitter.com/${handle}/status/${id}`, author_name: "Someone Else", author_url: `https://twitter.com/${handle}`,
  html: `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">${text}</p>&mdash; Someone Else (@${handle}) <a href="https://twitter.com/${handle}/status/${id}?ref_src=twsrc%5Etfw">November 17, 2026</a></blockquote>\n`,
  width: 550, height: null, type: "rich", cache_age: "3153600000", provider_name: "Twitter", provider_url: "https://twitter.com", version: "1.0",
});
/** A fake fetch: `answer(id, n, init)` → a Response (or a promise of one); records every call with the clock's time. */
function fakeFetch(clock, answer = (id) => json(embed(id))) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: new URL(url), id: idOf(url), init, at: clock.now() }); return answer(idOf(url), calls.length, init); };
  f.calls = calls;
  return f;
}
/** A fetch whose answers wait until `release()` (each call of it lets the oldest waiting request through). */
function heldFetch(clock, answer = (id) => json(embed(id))) {
  const gates = [];
  const f = fakeFetch(clock, (id, n, init) => new Promise((resolve) => gates.push(() => resolve(answer(id, n, init)))));
  f.release = () => gates.shift()?.();
  return f;
}
const hang = (id, n, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
const make = (over = {}) => {
  const clock = over.clock ?? fakeClock(NOW_S * 1000), fetch = over.fetch ?? fakeFetch(clock, over.answer);
  const x = new XPosts({ perMin: 600, fetch, now: clock.now, sleep: clock.sleep, log: quiet, timeoutMs: 20, ...over.opts });
  return { x, clock, fetch };
};
const nowS = (clock) => Math.floor(clock.now() / 1000);

test("1. one endpoint: the oEmbed URL carries only the id's digits, accept + a generic UA, redirects refused; something that is no post id is never fetched", async () => {
  const { x, fetch } = make();
  const id = idAt();
  assert.equal(x.want(id), "ok");
  await x.idle();
  const { url, init } = fetch.calls[0];
  assert.equal(`${url.origin}${url.pathname}`, XPOST_URL);
  assert.equal(XPOST_URL, "https://publish.x.com/oembed");
  assert.deepEqual(Object.fromEntries(url.searchParams), { url: `https://x.com/i/status/${id}`, omit_script: "1", dnt: "1" });
  assert.equal(url.search, `?url=${encodeURIComponent(`https://x.com/i/status/${id}`)}&omit_script=1&dnt=1`);
  assert.deepEqual(init.headers, { accept: "application/json", "user-agent": "spore-posts/1" });
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(x.peek(id), { id, state: "ok", handle: "tradfi", text: "Hello world", flagged: false, fetchedAt: NOW_S, askedAt: NOW_S, recheckAt: NOW_S + RECHECK_NEW_S });
  for (const bad of ["abc", "0123", "12345678901234567890", "1&url=https://evil.example", "", null, 123, undefined, {}]) {
    assert.equal(x.want(bad), "stopped", String(bad));
    assert.equal(x.canQueue(bad), "stopped");
    assert.equal(x.peek(bad), null);
    assert.equal(x.state(bad), "idle");
  }
  await x.idle();
  assert.equal(fetch.calls.length, 1, "nothing but the one post id was asked");
  x.stop();
});

test("2. pacing: 5 ids at 20/min go out one at a time, 3 000 ms apart, in arrival order; an id in line is not queued twice", async () => {
  const { x, fetch } = make({ opts: { perMin: 20 } });
  assert.equal(x.gapMs, 3_000);
  const ids = [1, 2, 3, 4, 5].map((n) => idAt(3600, n));
  assert.deepEqual(ids.map((id) => x.want(id)), ["ok", "ok", "ok", "ok", "ok"]);
  assert.deepEqual([x.want(ids[0]), x.want(ids[3]), x.canQueue(ids[4])], ["queued", "queued", "queued"], "in flight or in line");
  await x.idle();
  assert.deepEqual(fetch.calls.map((c) => c.id), ids, "in arrival order");
  const at = fetch.calls.map((c) => c.at);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 3_000, `${at[i] - at[i - 1]} ms`);
  assert.deepEqual(ids.map((id) => x.canQueue(id)), ["cached", "cached", "cached", "cached", "cached"]);
  assert.deepEqual([x.snapshot().callsToday, x.snapshot().ok, x.snapshot().waiting, x.snapshot().perMin], [5, 5, 0, 20]);
  x.stop();
});

test("3. the daily cap: every request sent counts, a spent day empties the line and refuses (\"budget\"), the next UTC day starts over; the count is kept in kv xpostCalls", async () => {
  const db = new Db(":memory:");
  const { x, fetch, clock } = make({ answer: (id, n) => (n === 2 ? json({}, 500) : json(embed(id))), opts: { db, daily: 4 } });
  const ids = Array.from({ length: 8 }, (_, n) => idAt(3600, n));
  // Under half the day everything is queued; the low half is tested in 4.
  assert.deepEqual(ids.slice(0, 6).map((id) => x.want(id)), ["ok", "ok", "ok", "ok", "ok", "ok"]);
  await x.idle();
  assert.equal(fetch.calls.length, 4, "the 5th and 6th were dropped unsent when the day was spent");
  assert.deepEqual([x.snapshot().callsToday, x.snapshot().daily, x.snapshot().waiting], [4, 4, 0]);
  assert.deepEqual([x.want(ids[6]), x.canQueue(ids[4]), x.state(ids[4])], ["budget", "budget", "idle"]);
  assert.equal(x.spent(), true);
  assert.deepEqual(db.kvGet("xpostCalls"), { day: Math.floor(clock.now() / 86_400_000), used: 4 }, "saved when the day became spent");
  clock.t += 86_400_000;
  assert.equal(x.spent(), false);
  assert.equal(x.want(ids[6]), "ok");
  await x.idle();
  assert.deepEqual([fetch.calls.length, x.snapshot().callsToday], [5, 1]);
  x.stop();
  assert.deepEqual(db.kvGet("xpostCalls"), { day: Math.floor(clock.now() / 86_400_000), used: 1 }, "saved at stop");
  // between those two the count is saved every 10 calls
  const db2 = new Db(":memory:");
  const tens = make({ opts: { db: db2 } });
  for (let n = 0; n < 9; n++) tens.x.want(idAt(3600, 100 + n));
  await tens.x.idle();
  assert.equal(db2.kvGet("xpostCalls", null), null, "9 calls: not written yet");
  tens.x.want(idAt(3600, 109)); await tens.x.idle();
  assert.deepEqual(db2.kvGet("xpostCalls", null), { day: Math.floor(tens.clock.now() / 86_400_000), used: 10 }, "written at the 10th, before any stop()");
  tens.x.stop(); db2.close();
  // daily = 0: no cap
  const free = make({ opts: { daily: 0 } });
  for (const id of ids) free.x.want(id);
  await free.x.idle();
  assert.deepEqual([free.fetch.calls.length, free.x.spent(), free.x.canQueue(idAt(60, 99), { low: true })], [8, false, "ok"]);
  free.x.stop(); db.close();
});

test("4. the low class: low requests stop at half the line (\"busy\") and at half the day (\"budget\"); the others keep the rest", async () => {
  const clock = fakeClock(NOW_S * 1000), fetch = heldFetch(clock);
  const { x } = make({ clock, fetch, opts: { daily: 100 } });
  const id = (n) => idAt(3600, n);
  assert.equal(x.want(id(0)), "ok"); // in flight, held: the line behind it only grows
  for (let n = 1; n <= MAX_WAITING / 2; n++) assert.equal(x.want(id(n), { low: true }), "ok", `low ${n}`);
  assert.equal(x.snapshot().waiting, MAX_WAITING / 2);
  assert.deepEqual([x.canQueue(id(500), { low: true }), x.want(id(500), { low: true })], ["busy", "busy"], "half the line is the low class's");
  for (let n = MAX_WAITING / 2 + 1; n <= MAX_WAITING; n++) assert.equal(x.want(id(n)), "ok", `normal ${n}`);
  assert.deepEqual([x.want(id(501)), x.snapshot().waiting], ["busy", MAX_WAITING], "the line is full");
  x.stop();
  // half the day
  const b = make({ opts: { daily: 6 } });
  for (let n = 0; n < 3; n++) b.x.want(id(n));
  await b.x.idle();
  assert.equal(b.x.snapshot().callsToday, 3);
  assert.deepEqual([b.x.canQueue(id(10), { low: true }), b.x.want(id(10), { low: true }), b.x.canQueue(id(10))], ["budget", "budget", "ok"]);
  assert.equal(b.fetch.calls.length, 3);
  b.x.stop();
});

test("5. state: \"wait\" in flight and for the first 10 in line, \"idle\" behind them and for an id nobody asked; then \"ok\" or \"none\" from the record", async () => {
  const clock = fakeClock(NOW_S * 1000), fetch = heldFetch(clock, (id, n) => (n === 2 ? json({}, 404) : json(embed(id))));
  const { x } = make({ clock, fetch });
  const ids = Array.from({ length: 14 }, (_, n) => idAt(3600, n));
  for (const id of ids) x.want(id);
  assert.equal(x.inFlight, ids[0]);
  assert.deepEqual(ids.map((id) => x.state(id)), ["wait", ...Array(WAIT_AHEAD).fill("wait"), "idle", "idle", "idle"]);
  assert.equal(x.state(idAt(3600, 99)), "idle");
  fetch.release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([x.state(ids[0]), x.state(ids[1]), x.state(ids[11]), x.state(ids[12])], ["ok", "wait", "wait", "idle"], "the line moved up one");
  for (let n = 0; n < 5_000 && x.running; n++) { fetch.release(); await new Promise((r) => setTimeout(r, 1)); }
  await x.idle();
  assert.deepEqual([x.state(ids[1]), x.state(ids[13])], ["none", "ok"]);
  x.stop();
  assert.equal(x.state(idAt(3600, 99)), "idle");
});

test("6. answers: a 404 is stored \"none\" for 7 days, a 401/403 or a 200 that is not the post for 6 hours; a 5xx, a redirect, bad JSON are not stored and wait RETRY_MS", async () => {
  const db = new Db(":memory:");
  const [gone, denied, locked, other, noAuthor, boom, moved, redirected, garbage, fine, fine2] = Array.from({ length: 11 }, (_, n) => idAt(3600, n));
  const answers = new Map([
    [gone, () => json({ error: "Not Found" }, 404)], [denied, () => json({}, 403)], [locked, () => json({}, 401)],
    [other, () => json(embed(idAt(3600, 77)))], // a 200 about another post
    [noAuthor, (id) => json({ ...embed(id), author_url: "https://evil.example/tradfi" })],
    [boom, () => json({}, 503)], [moved, () => new Response("", { status: 302, headers: { location: "https://example.com/" } })],
    [redirected, () => { throw new TypeError("fetch failed: redirect mode is set to error"); }],
    [garbage, () => new Response("<html>not json</html>", { status: 200 })],
  ]);
  const { x, fetch, clock } = make({ answer: (id) => (answers.get(id) ?? (() => json(embed(id))))(), opts: { db } });
  // `fine` and `fine2` in between: a parsed post ends the run of failed answers, so the breaker (8) stays out of this test.
  for (const id of [gone, denied, fine, locked, other]) { assert.equal(x.want(id), "ok"); await x.idle(); }
  x.lru.clear(); // read back from sqlite
  const rec = (id) => { const r = x.peek(id); return r && [r.state, r.handle, r.text, r.recheckAt - r.fetchedAt]; };
  assert.deepEqual(rec(gone), ["none", null, null, RECHECK_GONE_S]);
  assert.deepEqual(rec(denied), ["none", null, null, RECHECK_DENIED_S]);
  assert.deepEqual(rec(locked), ["none", null, null, RECHECK_DENIED_S]);
  assert.deepEqual(rec(other), ["none", null, null, RECHECK_DENIED_S], "a 200 whose url is another post's");
  assert.deepEqual(rec(fine), ["ok", "tradfi", "Hello world", RECHECK_NEW_S]);
  assert.deepEqual([x.state(gone), x.canQueue(gone), x.canQueue(denied)], ["none", "cached", "cached"]);
  for (const id of [noAuthor, fine2]) { assert.equal(x.want(id), "ok"); await x.idle(); }
  assert.deepEqual(rec(noAuthor), ["none", null, null, RECHECK_DENIED_S], "an author_url that is not on X");
  const before = db.xpostCount();
  for (const id of [boom, moved, redirected, garbage]) { assert.equal(x.want(id), "ok"); await x.idle(); }
  assert.equal(db.xpostCount(), before, "nothing stored for a transient failure");
  for (const id of [boom, moved, redirected, garbage]) assert.deepEqual([x.peek(id), x.state(id), x.canQueue(id)], [null, "idle", "retry"]);
  const s = x.snapshot();
  assert.deepEqual([s.notFound, s.denied, s.unparsed, s.errors, s.badJson, s.ok], [1, 2, 2, 3, 1, 2]);
  clock.t = x.failed.get(boom) + RETRY_MS - 1; // the later fetches moved the clock on
  assert.equal(x.canQueue(boom), "retry");
  clock.t += 1;
  assert.equal(x.want(boom), "ok");
  await x.idle();
  assert.equal(fetch.calls.filter((c) => c.id === boom).length, 2);
  x.stop(); db.close();
});

test("7. 429: Retry-After 5 pauses 5 s, without it 60 s, then 120 s; the line is emptied and nothing is queued (\"busy\") until the pause ends; a post resets the doubling; a 429 is not stored", async () => {
  const db = new Db(":memory:");
  const script = [() => json({}, 429, { "retry-after": "5" }), () => json({}, 429), () => json({}, 429), (id) => json(embed(id)), () => json({}, 429)];
  const { x, fetch, clock } = make({ answer: (id, n) => (script[n - 1] ?? ((i) => json(embed(i))))(id), opts: { db } });
  const ids = Array.from({ length: 9 }, (_, n) => idAt(3600, n));
  for (const id of ids.slice(0, 3)) x.want(id);
  await x.idle();
  assert.equal(fetch.calls.length, 1, "the two behind the 429 were dropped unsent");
  assert.deepEqual([x.snapshot().pausedMs, x.snapshot().waiting, x.snapshot().rateLimited], [5_000, 0, 1]);
  assert.deepEqual([x.canQueue(ids[0]), x.want(ids[1]), x.state(ids[1]), x.peek(ids[0])], ["busy", "busy", "idle", null]);
  clock.t += 5_000;
  assert.equal(x.want(ids[0]), "ok"); await x.idle();
  assert.equal(x.snapshot().pausedMs, XPOST_PAUSE_MS, "no Retry-After: 60 s");
  clock.t += XPOST_PAUSE_MS;
  x.want(ids[0]); await x.idle();
  assert.equal(x.snapshot().pausedMs, 2 * XPOST_PAUSE_MS, "then doubled");
  clock.t += 2 * XPOST_PAUSE_MS;
  x.want(ids[0]); await x.idle();
  assert.deepEqual([x.snapshot().pausedMs, x.state(ids[0])], [0, "ok"]);
  x.want(ids[1]); await x.idle();
  assert.equal(x.snapshot().pausedMs, XPOST_PAUSE_MS, "the post reset the doubling");
  assert.deepEqual([db.xpostCount(), x.snapshot().callsToday, x.snapshot().rateLimited], [1, 5, 4], "every attempt counted, only the post stored");
  x.stop(); db.close();
  // both pauses stop at 15 min
  const long = make({ answer: () => json({}, 429, { "retry-after": "99999" }) });
  long.x.want(ids[0]); await long.x.idle();
  assert.equal(long.x.snapshot().pausedMs, XPOST_PAUSE_MAX_MS, "a Retry-After of more than a day");
  long.x.stop();
  const dbl = make({ answer: () => json({}, 429) });
  const pauses = [];
  for (let n = 0; n < 7; n++) {
    assert.equal(dbl.x.want(ids[n]), "ok"); await dbl.x.idle();
    pauses.push(dbl.x.snapshot().pausedMs);
    dbl.clock.t += pauses[n];
  }
  assert.deepEqual(pauses, [60_000, 120_000, 240_000, 480_000, XPOST_PAUSE_MAX_MS, XPOST_PAUSE_MAX_MS, XPOST_PAUSE_MAX_MS], "doubling, up to the cap");
  assert.equal(XPOST_PAUSE_MAX_MS, 900_000);
  dbl.x.stop();
});

test("8. the breaker: ten 200s in a row that are no post send 5 requests and leave no stored row; a recheck's old row is put back; after the pause the run starts from zero and the undone ids wait; the pause doubles until a post", async () => {
  const db = new Db(":memory:");
  let blocked = false;
  const { x, fetch, clock } = make({ answer: (id) => (blocked ? json({ error: "nothing to see" }) : json(embed(id))), opts: { db } });
  const ids = Array.from({ length: 24 }, (_, n) => idAt(3600, n));
  const kept = idAt(3600, 50);
  x.want(kept); await x.idle();
  assert.equal(x.peek(kept).state, "ok");
  blocked = true;
  clock.t += (RECHECK_NEW_S + 1) * 1000; // `kept` is due: its recheck gets the useless answer inside the failing run
  assert.equal(x.want(kept), "ok");
  for (const id of ids.slice(0, 10)) x.want(id);
  await x.idle();
  assert.equal(fetch.calls.length - 1, BREAK_AFTER, "5 requests, then the breaker");
  assert.equal(db.xpostCount(), 1, "the four \"none\" rows of the run were deleted again");
  assert.deepEqual([x.peek(kept).state, x.peek(kept).handle, x.peek(kept).text], ["ok", "tradfi", "Hello world"], "the stored post was put back, not left \"none\"");
  for (const id of ids.slice(0, 10)) assert.deepEqual([x.peek(id), x.state(id)], [null, "idle"]);
  assert.deepEqual([x.snapshot().pausedMs, x.snapshot().waiting, x.snapshot().tripped, x.canQueue(ids[0])], [XPOST_PAUSE_MS, 0, 1, "busy"]);
  // the pause over: the ids whose rows were taken back wait RETRY_MS, so others get the first requests
  clock.t += XPOST_PAUSE_MS;
  assert.deepEqual([kept, ...ids.slice(0, 4)].map((id) => x.canQueue(id)), ["retry", "retry", "retry", "retry", "retry"]);
  assert.equal(x.canQueue(ids[4]), "ok", "the ones dropped unsent do not wait");
  // still failing: one such answer is a plain answer again (stored, no pause); it takes 5 more to pause, twice as long
  assert.equal(x.want(ids[5]), "ok"); await x.idle();
  assert.equal(fetch.calls.length - 1, BREAK_AFTER + 1);
  assert.deepEqual([x.snapshot().pausedMs, x.snapshot().tripped, x.peek(ids[5])?.state, db.xpostCount()], [0, 1, "none", 2]);
  for (const id of ids.slice(6, 12)) assert.equal(x.want(id), "ok");
  await x.idle();
  assert.equal(fetch.calls.length - 1, 2 * BREAK_AFTER, "ids[5] to ids[9]");
  assert.deepEqual([x.snapshot().pausedMs, x.snapshot().tripped, x.peek(ids[5]), db.xpostCount()], [2 * XPOST_PAUSE_MS, 2, null, 1]);
  // X answers again: the doubling starts over
  blocked = false;
  clock.t += 2 * XPOST_PAUSE_MS;
  x.want(ids[10]); await x.idle();
  assert.deepEqual([x.state(ids[10]), x.snapshot().pausedMs, db.xpostCount()], ["ok", 0, 2]);
  // fewer than 5 in a row are plain answers: stored "none", no pause
  blocked = true;
  for (const id of ids.slice(12, 16)) x.want(id);
  await x.idle();
  assert.deepEqual([x.snapshot().pausedMs, db.xpostCount(), x.state(ids[15]), x.snapshot().tripped], [0, 6, "none", 2]);
  x.want(ids[16]); await x.idle();
  assert.deepEqual([x.snapshot().pausedMs, db.xpostCount(), x.snapshot().tripped], [XPOST_PAUSE_MS, 2, 3], "the fifth: 60 s again, the four rows gone");
  x.stop(); db.close();
});

test("16. the breaker's run: a 5xx, an answer that is not JSON, a 200 that is not the post and a 429 count together; a 404 ends it", async () => {
  const db = new Db(":memory:");
  const ids = Array.from({ length: 12 }, (_, n) => idAt(3600, n));
  const script = [() => json({}, 503), () => new Response("<html>", { status: 200 }), () => json({ error: "nothing to see" }), () => json({}, 429, { "retry-after": "1" }), () => json({}, 502),
    () => json({}, 500), () => json({}, 500), () => json({}, 500), () => json({}, 500), () => json({}, 404), () => json({}, 500), () => json({}, 500)];
  const { x, clock } = make({ answer: (id, n) => script[n - 1](), opts: { db } });
  for (const id of ids.slice(0, 3)) { x.want(id); await x.idle(); }
  assert.deepEqual([x.peek(ids[2])?.state, x.snapshot().pausedMs, x.snapshot().tripped], ["none", 0, 0]);
  x.want(ids[3]); await x.idle();
  assert.deepEqual([x.snapshot().pausedMs, x.snapshot().tripped], [1_000, 0], "the 429 is the fourth and sets its own pause");
  clock.t += 1_000;
  x.want(ids[4]); await x.idle();
  assert.deepEqual([x.snapshot().pausedMs, x.snapshot().tripped, x.peek(ids[2]), db.xpostCount()], [XPOST_PAUSE_MS, 1, null, 0], "the fifth trips it; the run's row is taken back");
  clock.t += XPOST_PAUSE_MS;
  for (const id of ids.slice(5, 12)) { assert.equal(x.want(id), "ok"); await x.idle(); }
  assert.deepEqual([x.snapshot().pausedMs, x.snapshot().tripped, x.snapshot().notFound, x.bad], [0, 1, 1, 2], "4 failures, a 404, 2 failures: no run of 5");
  x.stop(); db.close();
});

test("17. a 401/403 is X's answer about one post, not a failing endpoint: ten in a row are stored \"none\" with no pause and the post behind them is fetched; they neither count toward the breaker's run, nor end it, nor are taken back when it trips", async () => {
  const db = new Db(":memory:");
  const ids = Array.from({ length: 10 }, (_, n) => idAt(3600, n));
  const first = idAt(3600, 50), honest = idAt(3600, 51);
  const refused = new Set(ids);
  const { x, fetch, clock } = make({ answer: (id, n) => (refused.has(id) ? json({ error: "Forbidden" }, n % 2 ? 403 : 401) : json(embed(id))), opts: { db } });
  for (const id of [first, ...ids, honest]) assert.equal(x.want(id), "ok");
  await x.idle();
  assert.equal(fetch.calls.length, 12, "every one was asked");
  assert.deepEqual([x.snapshot().pausedMs, x.snapshot().tripped, x.snapshot().denied, db.xpostCount()], [0, 0, 10, 12]);
  for (const id of ids) assert.deepEqual([x.peek(id).state, x.peek(id).recheckAt - x.peek(id).fetchedAt, x.canQueue(id)], ["none", RECHECK_DENIED_S, "cached"]);
  assert.deepEqual([x.state(first), x.state(honest)], ["ok", "ok"]);
  // due again and still refused: the same again, however often
  clock.t += RECHECK_DENIED_S * 1000;
  for (const id of ids) assert.equal(x.want(id), "ok");
  await x.idle();
  assert.deepEqual([fetch.calls.length, x.snapshot().pausedMs, x.snapshot().tripped, x.peek(ids[9]).state], [22, 0, 0, "none"]);
  x.stop(); db.close();
  // inside a run of failures: 2 failures, 2 refusals, 2 failures are 4 in a row; the next failure is the fifth
  const db2 = new Db(":memory:");
  const [f1, f2, d1, d2, f3, f4, f5] = ids;
  const b = make({ answer: (id) => (id === d1 || id === d2 ? json({}, 403) : json({}, 503)), opts: { db: db2 } });
  for (const id of [f1, f2, d1, d2, f3, f4]) { assert.equal(b.x.want(id), "ok"); await b.x.idle(); }
  assert.deepEqual([b.x.snapshot().pausedMs, b.x.snapshot().tripped, b.x.bad], [0, 0, 4], "the refusals did not count, and did not end the run");
  b.x.want(f5); await b.x.idle();
  assert.deepEqual([b.x.snapshot().pausedMs, b.x.snapshot().tripped], [XPOST_PAUSE_MS, 1]);
  assert.deepEqual([b.x.peek(d1)?.state, b.x.peek(d2)?.state, db2.xpostCount()], ["none", "none", 2], "the refused posts stay stored");
  b.clock.t += XPOST_PAUSE_MS;
  assert.deepEqual([b.x.canQueue(d1), b.x.canQueue(f1)], ["cached", "retry"]);
  b.x.stop(); db2.close();
});

test("18. the breaker takes rows back newest first: a stored post that got the useless answer twice in one run ends as it was before the run", async () => {
  const db = new Db(":memory:");
  let blocked = false;
  const { x, clock } = make({ answer: (id) => (blocked ? json({ error: "nothing to see" }) : json(embed(id))), opts: { db } });
  const kept = idAt(3600, 50), others = [1, 2, 3].map((n) => idAt(3600, n));
  x.want(kept); await x.idle();
  const stored = { ...x.peek(kept) };
  blocked = true;
  clock.t += RECHECK_NEW_S * 1000;
  assert.equal(x.want(kept), "ok"); await x.idle();
  assert.deepEqual([x.peek(kept).state, x.peek(kept).text, x.bad], ["none", null, 1]);
  clock.t += RECHECK_DENIED_S * 1000; // a quiet site: the run is still open when the "none" row is due
  assert.equal(x.want(kept), "ok"); await x.idle();
  assert.equal(x.bad, 2);
  for (const id of others) x.want(id);
  await x.idle();
  assert.equal(x.snapshot().tripped, 1);
  x.lru.clear(); // from sqlite
  const back = x.peek(kept);
  assert.deepEqual([back.state, back.handle, back.text, back.fetchedAt, back.recheckAt], ["ok", "tradfi", "Hello world", stored.fetchedAt, stored.recheckAt]);
  assert.deepEqual([db.xpostCount(), ...others.map((id) => x.peek(id))], [1, null, null, null]);
  x.stop(); db.close();
});

test("19. memory: the retry list holds FAILED_MAX ids and the record cache XPOST_LRU records, the oldest going first", async () => {
  const fails = make({ answer: () => json({}, 503), opts: { daily: 0 } });
  const fid = (n) => String(5_000_000 + n);
  for (let n = 0; n <= FAILED_MAX; n++) {
    fails.clock.t += fails.x.snapshot().pausedMs; // every fifth failure pauses
    assert.equal(fails.x.want(fid(n)), "ok"); await fails.x.idle();
  }
  assert.equal(fails.fetch.calls.length, FAILED_MAX + 1);
  assert.deepEqual([fails.x.failed.size, fails.x.failed.has(fid(0)), fails.x.failed.has(fid(1)), fails.x.failed.has(fid(FAILED_MAX))], [FAILED_MAX, false, true, true]);
  fails.x.stop();
  const mem = make({ opts: { daily: 0 } }); // no database: what leaves memory is gone
  const mid = (n) => String(6_000_000 + n);
  for (let n = 0; n <= XPOST_LRU;) {
    for (let k = 0; k < MAX_WAITING / 2 && n <= XPOST_LRU; k++, n++) assert.equal(mem.x.want(mid(n)), "ok");
    await mem.x.idle();
  }
  assert.equal(mem.fetch.calls.length, XPOST_LRU + 1);
  assert.deepEqual([mem.x.lru.size, mem.x.lru.has(mid(0)), mem.x.lru.has(mid(1)), mem.x.lru.has(mid(XPOST_LRU))], [XPOST_LRU, false, true, true]);
  assert.deepEqual([mem.x.peek(mid(0)), mem.x.peek(mid(1))?.state], [null, "ok"]);
  mem.x.stop();
});

test("20. stop() ends the wait between two requests: the one in line is never sent", { timeout: 5_000 }, async () => {
  const clock = fakeClock(NOW_S * 1000), fetch = fakeFetch(clock);
  const x = new XPosts({ perMin: 1, fetch, now: clock.now, log: quiet }); // the real sleep: 60 s until the second request
  const [a, b] = [idAt(3600, 1), idAt(3600, 2)];
  x.want(a); x.want(b);
  for (let n = 0; n < 500 && x.state(a) !== "ok"; n++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual([x.state(a), x.state(b), x.running], ["ok", "wait", true], "the second waits its turn");
  const done = x.idle();
  x.stop();
  await done;
  assert.deepEqual([fetch.calls.length, x.running, x.state(b), x.snapshot().waiting], [1, false, "idle", 0]);
});

test("9. a request that gets no answer within the timeout, and an answer over 64 KB: counted, not stored, asked again only after RETRY_MS", async () => {
  const db = new Db(":memory:");
  const [slow, big] = [idAt(3600, 1), idAt(3600, 2)];
  const { x, fetch, clock } = make({ answer: (id, n, init) => (id === slow ? hang(id, n, init) : new Response(`{"html":"${"x".repeat(XPOST_MAX_BYTES)}"}`, { status: 200 })), opts: { db } });
  x.want(slow); x.want(big);
  await x.idle();
  assert.deepEqual([fetch.calls.length, x.snapshot().timeouts, x.snapshot().tooLarge, x.snapshot().callsToday, db.xpostCount()], [2, 1, 1, 2, 0]);
  assert.deepEqual([x.canQueue(slow), x.canQueue(big), x.state(slow)], ["retry", "retry", "idle"]);
  clock.t = Math.max(...x.failed.values()) + RETRY_MS - 1;
  x.prune();
  assert.equal(x.failed.size, 1, "the hourly prune keeps an id that still waits");
  clock.t += 1;
  assert.deepEqual([x.canQueue(slow), x.canQueue(big)], ["ok", "ok"]);
  x.prune();
  assert.equal(x.failed.size, 0, "and drops the ones whose wait is over");
  x.stop(); db.close();
});

test("10. rechecks: a young post after 3 days, an old one after 14; a due record is still given and one refetch is queued, as low; a 404 or 403 then flips it to \"none\" without handle and text, a post overwrites it", async () => {
  const db = new Db(":memory:");
  const young = idAt(3600, 1), old = idAt(40 * 86_400, 2), edited = idAt(3600, 3);
  let phase = 0;
  const { x, fetch, clock } = make({ answer: (id) => (phase === 0 ? json(embed(id)) : id === young ? json({}, 404) : id === old ? json({}, 403) : json(embed(id, { handle: "renamed", text: "second text" }))), opts: { db, daily: 100 } });
  for (const id of [young, old, edited]) x.want(id);
  await x.idle();
  assert.deepEqual([x.peek(young).recheckAt - NOW_S, x.peek(old).recheckAt - NOW_S], [RECHECK_NEW_S, RECHECK_OLD_S]);
  clock.t += RECHECK_NEW_S * 1000 - 1000;
  assert.deepEqual([x.canQueue(young), x.want(young)], ["cached", "cached"], "not due yet");
  clock.t += 1000;
  phase = 1;
  assert.deepEqual([x.peek(young).state, x.peek(young).text, x.state(young)], ["ok", "Hello world", "ok"], "a due record is still served");
  assert.deepEqual([x.canQueue(young), x.canQueue(old)], ["ok", "cached"]);
  // a recheck is of the low class whoever asks: refused at half the day's budget
  const used = x.budget.used;
  x.budget.used = 50;
  assert.deepEqual([x.canQueue(young), x.canQueue(young, { low: false }), x.canQueue(idAt(60, 9))], ["budget", "budget", "ok"]);
  x.budget.used = used;
  assert.equal(x.want(young), "ok");
  assert.equal(x.want(edited), "ok");
  await x.idle();
  const t1 = nowS(clock);
  assert.deepEqual(x.peek(young), { id: young, state: "none", handle: null, text: null, flagged: false, fetchedAt: t1, askedAt: t1, recheckAt: t1 + RECHECK_GONE_S });
  assert.deepEqual([x.peek(edited).handle, x.peek(edited).text, x.peek(edited).recheckAt - t1], ["renamed", "second text", RECHECK_NEW_S]);
  clock.t += (RECHECK_OLD_S - RECHECK_NEW_S) * 1000;
  assert.equal(x.want(old), "ok");
  await x.idle();
  x.lru.clear();
  assert.deepEqual([x.peek(old).state, x.peek(old).handle, x.peek(old).text, x.peek(old).recheckAt - x.peek(old).fetchedAt], ["none", null, null, RECHECK_DENIED_S]);
  assert.equal(fetch.calls.length, 6);
  x.stop(); db.close();
});

test("11. a restart keeps the rows and the day's count; an id asked again is not fetched again", async () => {
  const db = new Db(":memory:");
  const ids = [idAt(3600, 1), idAt(3600, 2), idAt(3600, 3)];
  const a = make({ answer: (id, n) => (n === 2 ? json({}, 404) : json(embed(id))), opts: { db } });
  for (const id of ids) a.x.want(id);
  await a.x.idle();
  a.x.stop(); a.x.stop(); // idempotent
  assert.equal(a.x.want(idAt(3600, 4)), "stopped");
  const b = make({ clock: a.clock, opts: { db } });
  assert.deepEqual([b.x.snapshot().callsToday, b.x.snapshot().cached], [3, 3]);
  assert.deepEqual(ids.map((id) => [b.x.peek(id).state, b.x.canQueue(id), b.x.want(id)]), [["ok", "cached", "cached"], ["none", "cached", "cached"], ["ok", "cached", "cached"]]);
  assert.deepEqual([b.x.peek(ids[0]).handle, b.x.peek(ids[0]).text], ["tradfi", "Hello world"]);
  await b.x.idle();
  assert.equal(b.fetch.calls.length, 0);
  b.x.stop(); db.close();
});

test("12. asked_at: a read marks the row as asked for at most once an hour, also when the record comes from memory", async () => {
  const db = new Db(":memory:");
  const { x, clock } = make({ opts: { db } });
  const id = idAt();
  x.want(id); await x.idle();
  assert.equal(db.xpostGet(id).askedAt, NOW_S);
  clock.t += (XPOST_TOUCH_S - 1) * 1000;
  assert.ok(x.lru.has(id), "the record is in memory");
  x.peek(id);
  assert.equal(db.xpostGet(id).askedAt, NOW_S, "under an hour: not written");
  clock.t += 1000;
  x.peek(id);
  assert.equal(db.xpostGet(id).askedAt, NOW_S + XPOST_TOUCH_S, "an hour on: written, from a memory hit");
  x.state(id); x.canQueue(id);
  clock.t += 2 * XPOST_TOUCH_S * 1000;
  x.state(id); x.canQueue(id);
  assert.equal(db.xpostGet(id).askedAt, NOW_S + XPOST_TOUCH_S, "only peek counts as asking");
  x.stop(); db.close();
});

test("13. prune: rows not asked for 30 days go, and past the row cap the least recently asked; start() prunes and stop() ends its timer", async () => {
  const db = new Db(":memory:");
  const { x, clock } = make({ opts: { db } });
  const [stale, fresh] = [idAt(3600, 1), idAt(3600, 2)];
  x.want(stale); x.want(fresh); await x.idle();
  clock.t += (XPOST_KEEP_S - 10) * 1000;
  x.peek(fresh);
  clock.t += 20_000;
  assert.equal(x.prune(), 1);
  assert.deepEqual([x.peek(stale), x.peek(fresh)?.state, db.xpostCount(), x.snapshot().pruned], [null, "ok", 1, 1]);
  assert.equal(x.canQueue(stale), "ok", "a pruned post is simply fetched again when asked for");
  // the row cap, on the table itself
  const row = (id, askedAt) => db.xpostSet({ id, state: "ok", handle: "h", text: "t", flagged: false, fetchedAt: 1, askedAt, recheckAt: 2 });
  for (let n = 1; n <= 6; n++) row(String(1000 + n), nowS(clock) - 100 - n); // all asked before `fresh`
  assert.equal(db.xpostCount(), 7);
  assert.equal(db.xpostPrune(0, 4), 3);
  assert.deepEqual(["1004", "1005", "1006", "1003"].map((id) => !!db.xpostGet(id)), [false, false, false, true], "the least recently asked went");
  assert.equal(db.xpostDel("1003"), true);
  assert.equal(db.xpostGet("1003"), null);
  row("2001", nowS(clock) - XPOST_KEEP_S - 5);
  const before = [db.xpostCount(), x.snapshot().pruned];
  x.start();
  assert.deepEqual([db.xpostCount(), x.snapshot().pruned, db.xpostGet("2001")], [before[0] - 1, before[1] + 1, null], "start() pruned the row not asked for 30 days");
  const timer = x.pruneTimer;
  assert.ok(timer && timer._destroyed === false, "the hourly timer runs");
  x.start();
  assert.equal(x.pruneTimer, timer, "a second start() changes nothing");
  x.stop();
  assert.equal(timer._destroyed, true, "stop() ended it");
  db.close();
});

test("14. a flagged text is stored empty with its flag (the handle is kept), for good: a restart does not bring the text back", async () => {
  const db = new Db(":memory:");
  const [bad, good] = [idAt(3600, 1), idAt(3600, 2)];
  const seen = [];
  const flag = (text) => { seen.push(text); return /blocked/.test(text); };
  const a = make({ answer: (id) => json(embed(id, { text: id === bad ? "a blocked word" : "a fine text" })), opts: { db, flag } });
  a.x.want(bad); a.x.want(good); await a.x.idle();
  assert.deepEqual(seen, ["a blocked word", "a fine text"], "asked once per stored post");
  assert.deepEqual([a.x.peek(bad).state, a.x.peek(bad).handle, a.x.peek(bad).text, a.x.peek(bad).flagged], ["ok", "tradfi", "", true]);
  assert.deepEqual([a.x.peek(good).text, a.x.peek(good).flagged, a.x.snapshot().flagged], ["a fine text", false, 1]);
  a.x.stop();
  const row = db.db.prepare("SELECT text, flagged FROM x_posts WHERE id = ?").get(bad);
  assert.deepEqual([row.text, row.flagged], ["", 1]);
  const b = make({ clock: a.clock, opts: { db } });
  assert.deepEqual([b.x.peek(bad).text, b.x.peek(bad).flagged, b.x.peek(bad).handle], ["", true, "tradfi"]);
  // a flag that throws hides the text
  const c = make({ opts: { flag: () => { throw new Error("no list"); } } });
  c.x.want(good); await c.x.idle();
  assert.deepEqual([c.x.peek(good).text, c.x.peek(good).flagged], ["", true]);
  b.x.stop(); c.x.stop(); db.close();
});

test("15. without a database the answers live in memory only; stop() ends a wait and a request in flight", async () => {
  const clock = fakeClock(NOW_S * 1000), fetch = fakeFetch(clock, hang);
  const x = new XPosts({ perMin: 600, fetch, now: clock.now, sleep: clock.sleep, log: quiet, timeoutMs: 60_000 });
  const id = idAt();
  x.want(id); x.want(idAt(3600, 2));
  assert.equal(x.state(id), "wait");
  const done = x.idle();
  x.stop();
  await done;
  assert.deepEqual([fetch.calls.length, x.state(id), x.peek(id), x.snapshot().waiting], [1, "idle", null, 0]);
  assert.equal(fetch.calls[0].init.signal.aborted, true);
  const mem = make();
  mem.x.want(id); await mem.x.idle();
  assert.deepEqual([mem.x.peek(id).state, mem.x.snapshot().cached], ["ok", 1]);
  mem.x.stop();
});
