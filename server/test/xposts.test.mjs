// The post-text fetcher (lib/xposts.mjs): the one URL it asks, the line and its pace, the daily cap kept in kv, the low
// class, what each answer stores (or does not), pauses and the breaker, rechecks, restarts, the asked_at touch, the
// prune, flagged texts and the caps on what is kept in memory; and link reading (tests 21-28): the one t.co request with
// redirects not followed and only the Location read, what a Location may lead to, the quoted post through the same embed
// call and day, the chain from stored rows only, retries, the link reads' own pause, restarts and the prune.
// A fake fetch answers real Responses (so the capped body read streams); a fake clock; sqlite in memory. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkCodeOf, hasPicture, classifyTarget, TCO_URL, LINK_KINDS, LINK_RETRY_S, LINK_BREAK_AFTER } from "../lib/xposts.mjs";
import { postTime, parseOembed, TEXT_MAX } from "../lib/narrative.mjs";
import { XPosts, XPOST_URL, XPOST_MAX_BYTES, MAX_WAITING, RETRY_MS, XPOST_PAUSE_MS, XPOST_PAUSE_MAX_MS, BREAK_AFTER, WAIT_AHEAD, XPOST_LRU, FAILED_MAX, XPOST_TOUCH_S, XPOST_KEEP_S, XPOST_FLUSH_MAX, RECHECK_GONE_S, RECHECK_DENIED_S, RECHECK_NEW_S, RECHECK_OLD_S } from "../lib/xposts.mjs";
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

test("12. asked_at: a read marks the row as asked for at most once an hour, also when the record comes from memory; the write waits for flushTouches", async () => {
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
  assert.equal(db.xpostGet(id).askedAt, NOW_S, "an hour on: not written by the read itself");
  assert.equal(x.snapshot().touchesWaiting, 1);
  assert.equal(x.flushTouches(), 1);
  assert.equal(db.xpostGet(id).askedAt, NOW_S + XPOST_TOUCH_S, "an hour on: written by the flush, from a memory hit");
  assert.equal(x.flushTouches(), 0, "nothing left to write");
  x.state(id); x.canQueue(id);
  clock.t += 2 * XPOST_TOUCH_S * 1000;
  x.state(id); x.canQueue(id);
  assert.equal(db.xpostGet(id).askedAt, NOW_S + XPOST_TOUCH_S, "only peek counts as asking");
  x.stop(); db.close();
});

test("12b. the asked-for writes go in batches: at most XPOST_FLUSH_MAX a flush, oldest first; a newer row is never moved back; the prune and stop() write the rest", async () => {
  const db = new Db(":memory:");
  const { x, clock } = make({ opts: { db } });
  const ids = Array.from({ length: XPOST_FLUSH_MAX + 5 }, (_, i) => idAt(3600, i));
  for (const id of ids) db.xpostSet({ id, state: "ok", handle: "tradfi", text: "Hello world", flagged: false, fetchedAt: NOW_S, askedAt: NOW_S, recheckAt: NOW_S + RECHECK_OLD_S });
  clock.t += XPOST_TOUCH_S * 1000;
  const writes = [];
  const run = db.xpostTouchMany.bind(db);
  db.xpostTouchMany = (rows) => { writes.push(rows.length); return run(rows); };
  for (const id of ids) x.peek(id);
  assert.equal(x.flushTouches(XPOST_FLUSH_MAX), XPOST_FLUSH_MAX);
  assert.deepEqual(writes, [XPOST_FLUSH_MAX], "one transaction");
  assert.equal(db.xpostGet(ids[0]).askedAt, NOW_S + XPOST_TOUCH_S, "the oldest first");
  assert.equal(db.xpostGet(ids.at(-1)).askedAt, NOW_S, "the rest wait");
  // a row written newer meanwhile (a fetch's answer) is not moved back by a waiting touch
  db.xpostTouch(ids.at(-1), NOW_S + 2 * XPOST_TOUCH_S);
  x.prune();
  assert.equal(x.snapshot().touchesWaiting, 0, "the prune wrote them first");
  assert.equal(db.xpostGet(ids.at(-2)).askedAt, NOW_S + XPOST_TOUCH_S);
  assert.equal(db.xpostGet(ids.at(-1)).askedAt, NOW_S + 2 * XPOST_TOUCH_S, "never moved back");
  clock.t += XPOST_TOUCH_S * 1000;
  x.peek(ids[0]);
  x.stop();
  assert.equal(db.xpostGet(ids[0]).askedAt, NOW_S + 2 * XPOST_TOUCH_S, "stop() writes what waits");
  db.close();
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

// ---------------------------------------------------------------- link reading
/** A post's embed paragraph with a t.co link as X writes it (the link's own address is its visible text). */
const tco = (code) => `<a href="https://t.co/${code}">https://t.co/${code}</a>`;
/** A redirect answer whose body must never be read: reading it throws, letting go of it is counted. */
function redirect(location, status = 301, headers = {}) {
  const r = { status, headers: new Headers(location == null ? headers : { ...headers, location }), cancelled: 0, body: { cancel: async () => { r.cancelled++; } } };
  for (const k of ["text", "json", "arrayBuffer", "blob", "bytes", "formData"]) r[k] = async () => { throw new Error("the body of a link answer was read"); };
  return r;
}
/** A fake fetch for both hosts: `posts` id → { handle, text } (anything else is a 404), `links` t.co code → a Location, an answer object or a function of the call number. */
function linkWorld({ posts = {}, links = {}, opts = {}, clock = fakeClock(NOW_S * 1000) } = {}) {
  const calls = [], answers = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: String(url), host: u.hostname, id: u.hostname === "t.co" ? null : idOf(url), code: u.hostname === "t.co" ? u.pathname.slice(1) : null, init, at: clock.now() });
    if (u.hostname === "t.co") {
      let a = links[u.pathname.slice(1)];
      if (typeof a === "function") a = a(calls.length);
      const r = typeof a === "string" ? redirect(a) : a ?? redirect(null, 404);
      answers.push(r);
      return r;
    }
    const id = idOf(url), p = posts[id];
    return p ? json(embed(id, p)) : json({}, 404);
  };
  const x = new XPosts({ perMin: 600, fetch, now: clock.now, sleep: clock.sleep, log: quiet, timeoutMs: 20, ...opts });
  return { x, clock, calls, answers, kinds: () => calls.map((c) => (c.code ? `link:${c.code}` : `post:${c.id}`)) };
}

test("21. links, pure: the last t.co code of a text; only an https x.com / twitter.com /status/<digits> address is a post, everything else is a kind", () => {
  assert.equal(linkCodeOf("Sending 10%https://t.co/Ig0v1Mdtkc"), "Ig0v1Mdtkc");
  assert.equal(linkCodeOf("a https://t.co/first b https://t.co/second pic.twitter.com/x"), "second", "the last one: X appends the quoted post's link");
  // a link our own text cap cut in half is no link: half a code is somebody else's short link
  assert.equal(linkCodeOf("https://t.co/Ab12… pic.twitter.com/9R"), null);
  assert.equal(linkCodeOf("a long reply https://t.co/AbCdEf…"), null);
  assert.equal(linkCodeOf("the text… https://t.co/Ab12"), "Ab12", "X's own shortening writes the mark before the link");
  assert.equal(linkCodeOf("see https://t.co/whole1 and then https://t.co/Ab…"), "whole1", "an earlier whole link of the same post still counts");
  // the very text the embed reader stores for a post over TEXT_MAX code points whose last link falls on the cut
  for (const pad of [580, 584, 589]) {
    const cut = parseOembed({ url: "https://twitter.com/p/status/1895000000000000001", author_url: "https://twitter.com/p", html: `<blockquote><p>${"@someone ".repeat(100).slice(0, pad)}https://t.co/AbCdEfGhIj and more words after it</p></blockquote>` }, "1895000000000000001");
    assert.deepEqual([[...cut.text].length, cut.text.endsWith("…"), linkCodeOf(cut.text)], [TEXT_MAX + 1, true, null], `cut at ${pad}`);
  }
  for (const none of ["no link here", "http://t.co/Ab12", "https://t.co.evil.example/Ab12", "https://t.co/", "https://evil.example/t.co/Ab12", "pic.twitter.com/Ab12", "", null, 5]) assert.equal(linkCodeOf(none), null, String(none));
  assert.equal(linkCodeOf("https://t.co/Ab12?x=1&url=https://evil.example"), "Ab12", "letters and digits only: nothing else of the text enters a URL");
  assert.deepEqual([hasPicture("look pic.twitter.com/NOfAoq90Wx"), hasPicture("epic.twitter.com/x"), hasPicture("no"), hasPicture(null)], [true, false, false, false]);
  assert.deepEqual(LINK_KINDS, ["post", "article", "website", "picture"]);
  const own = "2125166956370186626", q = "2125000000000000001";
  for (const url of [`https://x.com/someone/status/${q}`, `https://twitter.com/someone/status/${q}`, `https://www.twitter.com/someone/statuses/${q}`, `https://mobile.x.com/i/status/${q}`, `https://x.com/i/web/status/${q}?s=20`, `https://twitter.com/someone/status/${q}/`]) assert.deepEqual(classifyTarget(url, own), { kind: "post", id: q }, url);
  // not a post: http, another host, a look-alike host, userinfo, a port, an id that is no id, the post's own pictures
  assert.deepEqual(classifyTarget(`http://x.com/someone/status/${q}`, own), { kind: "website", host: "x.com" }, "only https is a post");
  assert.deepEqual(classifyTarget(`https://x.com.evil.example/someone/status/${q}`, own), { kind: "website", host: "x.com.evil.example" });
  assert.deepEqual(classifyTarget(`https://evil.example/x.com/someone/status/${q}`, own), { kind: "website", host: "evil.example" });
  assert.deepEqual(classifyTarget(`https://user:pw@x.com/someone/status/${q}`, own), { kind: "website", host: "x.com" });
  assert.deepEqual(classifyTarget(`https://x.com:8443/someone/status/${q}`, own), { kind: "website", host: "x.com" });
  assert.deepEqual(classifyTarget("https://x.com/someone/status/12abc", own), { kind: "website", host: "x.com" });
  assert.deepEqual(classifyTarget("https://x.com/someone", own), { kind: "website", host: "x.com" });
  assert.deepEqual(classifyTarget(`https://twitter.com/someone/status/${own}/photo/1`, own), { kind: "picture", host: "twitter.com" });
  assert.deepEqual(classifyTarget(`https://x.com/other/status/${q}/video/1`, own), { kind: "picture", host: "x.com" });
  assert.deepEqual(classifyTarget(`https://x.com/someone/status/${own}`, own), { kind: "picture", host: "x.com" }, "the post's own address is no quoted post");
  assert.deepEqual(classifyTarget("https://pic.twitter.com/NOfAoq90Wx", own), { kind: "picture", host: "pic.twitter.com" });
  assert.deepEqual(classifyTarget("https://x.com/i/article/2125674407465246720", own), { kind: "article", host: "x.com" });
  assert.deepEqual(classifyTarget("https://x.com/someone/article/2125674407465246720", own), { kind: "article", host: "x.com" });
  assert.deepEqual(classifyTarget("https://liquidponzi.fun/", own), { kind: "website", host: "liquidponzi.fun" });
  assert.deepEqual(classifyTarget("https://WWW.Reddit.com./r/dogelore/comments/x", own), { kind: "website", host: "www.reddit.com" });
  assert.equal(classifyTarget(`https://${"a".repeat(60)}.${"b".repeat(60)}.example/`, own).host.length, 80);
  for (const bad of ["/someone/status/1", "javascript:alert(1)", "file:///etc/passwd", "ftp://x.com/a", "data:text/html,x", "", null, undefined, 7, `https://x.com/${"a".repeat(3000)}`]) assert.equal(classifyTarget(bad, own), null, String(bad).slice(0, 30));
});

test("22. a link read: ONE request to https://t.co/<code>, redirects not followed, only the Location read; the quoted post then comes through the embed call, on the same line and day", async () => {
  const P = idAt(3600, 1), Q = idAt(86_400, 2);
  const w = linkWorld({ posts: { [P]: { handle: "poster", text: `Sending 10%${tco("Ig0v1Mdtkc")}` }, [Q]: { handle: "quoted", text: "A perp whale outdid Rasmr" } }, links: { Ig0v1Mdtkc: `https://twitter.com/quoted/status/${Q}` } });
  const { x } = w;
  assert.deepEqual([x.linkOf(P).state, x.canQueueLink(P), x.wantLink(P)], ["none", "nolink", "nolink"], "nothing is known of a post that is not stored: no link request");
  x.want(P); await x.idle();
  assert.equal(x.peek(P).text, "Sending 10%https://t.co/Ig0v1Mdtkc");
  assert.deepEqual(x.linkOf(P), { state: "wait", kind: null, toId: null, host: null });
  assert.deepEqual(x.quoteOf(P, { queue: false }), { state: "wait", kind: null, host: null, quoted: null, chain: null, retry: false });
  assert.equal(w.calls.length, 1, "reading what is stored sends nothing");
  assert.deepEqual(x.quoteOf(P), { state: "wait", kind: null, host: null, quoted: null, chain: null, retry: false });
  assert.equal(x.canQueueLink(P), "queued");
  await x.idle();
  assert.deepEqual(w.kinds(), [`post:${P}`, "link:Ig0v1Mdtkc", `post:${Q}`]);
  const link = w.calls[1];
  assert.equal(link.url, "https://t.co/Ig0v1Mdtkc");
  assert.equal(TCO_URL, "https://t.co/");
  assert.equal(link.init.redirect, "manual", "the redirect is not followed");
  assert.deepEqual(link.init.headers, { "user-agent": "spore-posts/1" });
  assert.ok(link.init.signal instanceof AbortSignal);
  assert.equal(w.answers[0].cancelled, 1, "the body is let go unread");
  // the quoted post went out as any post does: the embed URL with only its digits
  assert.equal(new URL(w.calls[2].url).searchParams.get("url"), `https://x.com/i/status/${Q}`);
  assert.equal(w.calls[2].init.redirect, "error");
  for (let i = 1; i < w.calls.length; i++) assert.ok(w.calls[i].at - w.calls[i - 1].at >= x.gapMs, "one line, gapMs apart");
  assert.deepEqual(x.linkOf(P), { state: "ok", kind: "post", toId: Q, host: null });
  assert.deepEqual(x.quoteOf(P), { state: "ok", kind: "post", host: null, quoted: { id: Q, handle: "quoted", text: "A perp whale outdid Rasmr", at: postTime(Q, w.clock.now()) }, chain: null, retry: false });
  await x.idle();
  assert.equal(w.calls.length, 3, "read once: asking again sends nothing");
  const s = x.snapshot();
  assert.deepEqual([s.callsToday, s.calls, s.links.calls, s.links.posts, s.links.waiting], [3, 3, 1, 1, 0], "the link request counts toward the same day");
  assert.deepEqual([x.canQueueLink(P), x.wantLink(P)], ["cached", "cached"]);
  x.stop();
});

test("23. everything that is not a post is a kind and is never fetched: an article on X, a website, a picture; a text with media and no link asks nothing at all", async () => {
  const [A, W, PH, PIC, PLAIN] = [1, 2, 3, 4, 5].map((n) => idAt(3600, n));
  const w = linkWorld({
    posts: { [A]: { handle: "a", text: tco("oAQHWDkJWU") }, [W]: { handle: "w", text: `Introducing Liquid Ponzi${tco("e7TuXeL9Yy")}` }, [PH]: { handle: "p", text: `look ${tco("Ph0t0")}` }, [PIC]: { handle: "c", text: "cented sent to wrong person? pic.twitter.com/NOfAoq90Wx" }, [PLAIN]: { handle: "n", text: "no link at all" } },
    links: { oAQHWDkJWU: "https://x.com/i/article/2125674407465246720", e7TuXeL9Yy: "https://liquidponzi.fun/", Ph0t0: `https://twitter.com/p/status/${PH}/photo/1` },
  });
  const { x } = w;
  for (const id of [A, W, PH, PIC, PLAIN]) x.want(id);
  await x.idle();
  for (const id of [A, W, PH, PIC, PLAIN]) x.quoteOf(id);
  await x.idle();
  assert.deepEqual(w.kinds().slice(5), ["link:oAQHWDkJWU", "link:e7TuXeL9Yy", "link:Ph0t0"], "three redirects read; the two posts without a t.co link asked nothing");
  assert.deepEqual(x.quoteOf(A), { state: "ok", kind: "article", host: "x.com", quoted: null, chain: null, retry: false });
  assert.deepEqual(x.quoteOf(W), { state: "ok", kind: "website", host: "liquidponzi.fun", quoted: null, chain: null, retry: false });
  assert.deepEqual(x.quoteOf(PH), { state: "ok", kind: "picture", host: "twitter.com", quoted: null, chain: null, retry: false });
  assert.deepEqual(x.quoteOf(PIC), { state: "ok", kind: "picture", host: null, quoted: null, chain: null, retry: false });
  assert.deepEqual(x.quoteOf(PLAIN), { state: "none", kind: null, host: null, quoted: null, chain: null, retry: false });
  await x.idle();
  assert.equal(w.calls.length, 8, "nothing else was ever requested: no article, no website, no picture");
  assert.ok(w.calls.every((c) => c.host === "t.co" || c.host === "publish.x.com"), "two hosts only");
  const s = x.snapshot().links;
  assert.deepEqual([s.articles, s.websites, s.pictures, s.posts], [1, 1, 1, 0]);
  x.stop();
});

test("24. the chain: the post a quoted post itself quotes is given only when its link row and its text are stored already; nothing is fetched for it", async () => {
  const P = idAt(600, 1), Q = idAt(3600, 2), R = idAt(86_400 * 300, 3);
  const w = linkWorld({
    posts: { [P]: { handle: "p", text: `no moon in theos img${tco("vGyWI8E7Q8")}` }, [Q]: { handle: "q", text: `Speed says he wanted to team up with ELON${tco("OTXjvQD0SH")}` }, [R]: { handle: "gwrldmedia", text: "IShowSpeed wants to team up with Elon Musk. pic.twitter.com/LOzOKEyntq" } },
    links: { vGyWI8E7Q8: `https://x.com/q/status/${Q}`, OTXjvQD0SH: `https://x.com/gwrldmedia/status/${R}` },
  });
  const { x } = w;
  x.want(P); await x.idle();
  x.quoteOf(P); await x.idle();
  const one = x.quoteOf(P);
  await x.idle();
  assert.deepEqual([one.state, one.quoted.id, one.chain], ["ok", Q, null]);
  assert.deepEqual(w.kinds(), [`post:${P}`, "link:vGyWI8E7Q8", `post:${Q}`], "the quoted post's own link is NOT read for the chain");
  // the quoted post is a starting post of another card: its link is read for that card
  x.quoteOf(Q); await x.idle();
  assert.deepEqual(w.kinds().slice(3), ["link:OTXjvQD0SH", `post:${R}`]);
  const two = x.quoteOf(P);
  assert.deepEqual(two.chain, { id: R, handle: "gwrldmedia", text: "IShowSpeed wants to team up with Elon Musk. pic.twitter.com/LOzOKEyntq", at: postTime(R, w.clock.now()) });
  assert.deepEqual(x.quoteOf(Q).chain, null, "one hop further is never followed");
  await x.idle();
  assert.equal(w.calls.length, 5);
  x.stop();
});

test("25. a link that cannot be read is tried again after 10 min, 1 h and 6 h, then left; a quoted post that is gone or flagged gives no text", async () => {
  assert.deepEqual(LINK_RETRY_S, [600, 3_600, 21_600]);
  const P = idAt(3600, 1), G = idAt(3600, 2), GONE = idAt(7200, 3), F = idAt(3600, 4), BAD = idAt(7200, 5);
  const w = linkWorld({
    posts: { [P]: { handle: "p", text: `SENDING 5%${tco("9IXTi6yoBB")}` }, [G]: { handle: "g", text: `look${tco("Gone1")}` }, [F]: { handle: "f", text: `look${tco("Flag1")}` }, [BAD]: { handle: "b", text: "a blockedword here" } },
    links: { Gone1: `https://x.com/a/status/${GONE}`, Flag1: `https://x.com/b/status/${BAD}` },
    opts: { flag: (t) => t.includes("blockedword") },
  });
  const { x, clock } = w;
  x.want(P); await x.idle();
  const tries = () => w.calls.filter((c) => c.code === "9IXTi6yoBB").length;
  x.quoteOf(P); await x.idle();
  assert.deepEqual([tries(), x.quoteOf(P).state, x.canQueueLink(P)], [1, "unread", "retry"], "a 404 without a Location");
  assert.deepEqual([x.linkOf(P), x.quoteOf(P).retry], [{ state: "unread", kind: null, toId: null, host: null, retry: true }, true], "another try is scheduled: a caller may wait for it");
  for (const [i, wait] of LINK_RETRY_S.entries()) {
    clock.t += (wait - 5) * 1000;
    x.quoteOf(P); await x.idle();
    assert.equal(tries(), i + 1, `not before ${wait} s`);
    clock.t += 10_000;
    x.quoteOf(P); await x.idle();
    assert.equal(tries(), i + 2, `again after ${wait} s`);
  }
  clock.t += 86_400_000;
  assert.deepEqual([x.canQueueLink(P), x.quoteOf(P).state, tries()], ["cached", "unread", 4], "after the fourth read it is left");
  assert.deepEqual([x.linkOf(P).retry, x.quoteOf(P).retry], [false, false], "no try is left: nothing to wait for");
  await x.idle();
  assert.equal(tries(), 4);
  assert.equal(x.snapshot().links.unread, 4);
  // other answers that are no usable redirect: a 200, a redirect without Location, one to no http(s) address, a network error
  for (const [n, answer] of [[11, redirect(null, 200)], [12, redirect(null, 302)], [13, redirect("javascript:alert(1)")], [14, () => { throw new Error("boom"); }]]) {
    const id = idAt(3600, n), ww = linkWorld({ posts: { [id]: { handle: "p", text: tco("Zz9") } }, links: { Zz9: answer } });
    ww.x.want(id); await ww.x.idle(); ww.x.quoteOf(id); await ww.x.idle();
    assert.deepEqual([ww.x.quoteOf(id).state, ww.calls.length], ["unread", 2], String(n));
    ww.x.stop();
  }
  // the quoted post is gone (a 404 from the embed call), or its text is flagged: the link is read, there is no text
  x.want(G); x.want(F); await x.idle();
  x.quoteOf(G); x.quoteOf(F); await x.idle();
  assert.deepEqual([x.linkOf(G).kind, x.quoteOf(G).state, x.quoteOf(G).quoted, x.quoteOf(G).retry, x.quoteOf(F).retry], ["post", "unread", null, false, false], "a quoted post that is gone or flagged is not waited for");
  assert.deepEqual([x.linkOf(F).kind, x.peek(BAD).flagged, x.quoteOf(F).state, x.quoteOf(F).quoted], ["post", true, "unread", null], "a flagged text is never given");
  x.stop();
});

test("26. a failing t.co pauses the link reads only: a 429 or 5 failed reads in a row; the posts' own reads go on", async () => {
  assert.equal(LINK_BREAK_AFTER, 5);
  const ids = Array.from({ length: 8 }, (_, i) => idAt(3600, i + 1)), other = idAt(3600, 50);
  const posts = Object.fromEntries(ids.map((id, i) => [id, { handle: "p", text: tco(`L${i}`) }]));
  posts[other] = { handle: "o", text: "just a post" };
  // a 429 with Retry-After 120
  const w = linkWorld({ posts, links: { L0: redirect(null, 429, { "retry-after": "120" }) } });
  const { x, clock } = w;
  x.want(ids[0]); x.want(ids[1]); await x.idle();
  x.quoteOf(ids[0]); x.quoteOf(ids[1]); await x.idle();
  assert.deepEqual(w.kinds().slice(2), ["link:L0"], "the line of links is emptied");
  assert.deepEqual([x.snapshot().links.rateLimited, x.snapshot().links.pausedMs > 0, x.snapshot().pausedMs, x.canQueueLink(ids[1]), x.linkOf(ids[0]).state], [1, true, 0, "busy", "wait"], "not a try of that link, and no pause of the posts");
  assert.equal(x.want(other), "ok");
  await x.idle();
  assert.equal(x.peek(other).state, "ok", "a post is read while the links wait");
  clock.t += 121_000;
  assert.equal(x.canQueueLink(ids[1]), "ok");
  x.stop();
  // five reads in a row without a redirect
  const b = linkWorld({ posts });
  for (const id of ids) b.x.want(id);
  await b.x.idle();
  for (const id of ids) b.x.quoteOf(id);
  await b.x.idle();
  assert.deepEqual([b.calls.filter((c) => c.code).length, b.x.snapshot().links.tripped, b.x.snapshot().links.pausedMs, b.x.snapshot().pausedMs, b.x.snapshot().tripped], [5, 1, XPOST_PAUSE_MS, 0, 0], "5 link reads, then the link reads pause; the posts' breaker is untouched");
  assert.equal(b.x.want(other), "ok");
  await b.x.idle();
  assert.equal(b.x.peek(other).state, "ok");
  b.x.stop();
});

test("27. the day and the line: link reads stop at half the day's requests, wait behind the posts, and a spent day sends none", async () => {
  const ids = Array.from({ length: 6 }, (_, i) => idAt(3600, i + 1));
  const posts = Object.fromEntries(ids.map((id, i) => [id, { handle: "p", text: tco(`L${i}`) }]));
  const links = Object.fromEntries(ids.map((_, i) => [`L${i}`, "https://example.org/"]));
  const w = linkWorld({ posts, links, opts: { daily: 10 } });
  const { x } = w;
  for (const id of ids.slice(0, 4)) x.want(id);
  await x.idle();
  assert.equal(x.snapshot().callsToday, 4);
  assert.deepEqual([x.wantLink(ids[0]), x.wantLink(ids[1])], ["ok", "ok"]);
  // a post asked for while links wait goes first
  assert.equal(x.want(ids[4]), "ok");
  await x.idle();
  assert.deepEqual(w.kinds().slice(4), [`post:${ids[4]}`, "link:L0", "link:L1"], "the post before the links");
  assert.deepEqual([x.snapshot().callsToday, x.canQueueLink(ids[2]), x.wantLink(ids[2]), x.quoteOf(ids[2]).state], [7, "budget", "budget", "wait"], "from half the day on no link is read");
  assert.equal(x.want(ids[5]), "ok", "the other half of the day is the posts'");
  await x.idle();
  assert.equal(w.kinds().at(-1), `post:${ids[5]}`);
  x.stop();
});

test("28. a restart keeps what the links led to; the prune drops a link row with its post; a row this build cannot read is as never read", async () => {
  const db = new Db(":memory:");
  const P = idAt(3600, 1), Q = idAt(7200, 2), S = idAt(3600, 3);
  const world = () => linkWorld({ posts: { [P]: { handle: "p", text: `Sending 10%${tco("Ab12")}` }, [Q]: { handle: "q", text: "the quoted words" }, [S]: { handle: "s", text: tco("Cd34") } }, links: { Ab12: `https://x.com/q/status/${Q}`, Cd34: "https://example.org/a" }, opts: { db } });
  const a = world();
  a.x.want(P); a.x.want(S); await a.x.idle();
  a.x.quoteOf(P); a.x.quoteOf(S); await a.x.idle();
  assert.equal(a.calls.length, 5);
  assert.deepEqual(db.linkGet(P), { postId: P, kind: "post", toId: Q, host: null, tries: 1, nextTryAt: 0, at: db.linkGet(P).at });
  assert.deepEqual([db.linkGet(S).kind, db.linkGet(S).host, db.linkCount()], ["website", "example.org", 2]);
  a.x.stop();
  const b = world();
  assert.deepEqual(b.x.quoteOf(P).quoted, { id: Q, handle: "q", text: "the quoted words", at: postTime(Q, b.clock.now()) });
  assert.deepEqual(b.x.quoteOf(S), { state: "ok", kind: "website", host: "example.org", quoted: null, chain: null, retry: false });
  await b.x.idle();
  assert.equal(b.calls.length, 0, "nothing is asked again");
  // a row with a kind this build does not know, or a post row without a post id: read as never read
  const keep = [db.linkGet(P), db.linkGet(S)];
  db.linkSet({ postId: S, kind: "video", host: "example.org", tries: 1, at: 1 });
  db.linkSet({ postId: P, kind: "post", toId: "not-an-id", tries: 1, at: 1 });
  const c = world();
  assert.deepEqual([c.x.linkOf(S).state, c.x.linkOf(P).state], ["wait", "wait"]);
  c.x.stop();
  for (const r of keep) db.linkSet(r);
  // the prune: the starting post S is not asked for 30 days and goes; its link row goes with it
  b.clock.t += (XPOST_KEEP_S - 10) * 1000;
  b.x.peek(P); b.x.peek(Q);
  b.clock.t += 20_000;
  assert.equal(b.x.prune(), 1);
  assert.deepEqual([db.xpostGet(S), db.linkGet(S), !!db.linkGet(P)], [null, null, true]);
  b.x.stop(); db.close();
});
