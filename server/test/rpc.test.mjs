// The RPC budget: a 429 pauses the lane that hit it with growing backoff, a later 429 inside the
// pause does not double it, success resets it, and the browser proxy and API lookups run on their
// own lanes so their traffic (and the 429s it provokes) never stalls the indexer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rpc, CreditBudget, creditCost, deriveWsUrl, redact } from "../lib/rpc.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const json = (result, status = 200, headers = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status, headers: { "content-type": "application/json", ...headers } });

test("429 from the provider pauses the client, retries after the pause; the proxy lane pauses on its own", async () => {
  const calls = [];
  let script = [() => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }), () => json(123)];
  const rpc = new Rpc({ url: "https://rpc.example", rps: 1000, concurrency: 2, log: quiet, backoffMinMs: 40, backoffMaxMs: 200, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return (script.shift() ?? (() => json("ok")))(); } });
  const t0 = Date.now();
  assert.equal(await rpc.call("getSlot"), 123);
  assert.ok(Date.now() - t0 >= 35, "waited out the pause");
  assert.equal(rpc.stats.rateLimited, 1); assert.equal(rpc.backoffMs, 0, "success resets the backoff");
  assert.equal(calls.length, 2);
  // Rate limit answered through the proxy: only the proxy lane pauses; the indexer goes on at once.
  script = [() => new Response("{}", { status: 429 }), () => json(7)];
  const p = await rpc.proxy({ jsonrpc: "2.0", id: 9, method: "getSlot" });
  assert.equal(p.status, 429);
  const lanes = rpc.laneSnapshot();
  assert.ok(lanes.proxy.pausedMs > 0 && lanes.proxy.pausedMs <= 40, `proxy paused ${lanes.proxy.pausedMs} ms`);
  assert.equal(rpc.snapshot().pausedMs, 0, "the main lane is untouched");
  const t1 = Date.now();
  assert.equal(await rpc.call("getSlot"), 7);
  assert.ok(Date.now() - t1 < 25, "indexer call did not wait for the proxy's pause");
  // Backoff doubles across separate pauses, capped at backoffMaxMs.
  script = [() => new Response("", { status: 429 }), () => new Response("", { status: 429 }), () => json(1)];
  await rpc.call("getSlot");
  assert.ok(rpc.stats.rateLimited >= 3);
});

test("lanes: rpc.lane(\"api\") runs every helper through the api bucket; the proxy relays at most PROXY_MAX_BYTES", async () => {
  const seen = [];
  const rpc = new Rpc({ url: "https://rpc.example", rps: 1000, apiRps: 1000, log: quiet, fetchImpl: async (url, init) => { seen.push(JSON.parse(init.body).method); return json({ value: [null] }); } });
  const api = rpc.lane("api");
  assert.equal(api.laneName, "api");
  assert.deepEqual(await api.getMultipleAccounts(["k"]), [null]);
  assert.equal(seen[0], "getMultipleAccounts");
  assert.equal(rpc.lanes.api.inFlight, 0); assert.equal(rpc.stats.calls, 1);
  assert.throws(() => rpc.lane("nope"), /unknown rpc lane/);
  const big = new Rpc({ url: "https://rpc.example", rps: 1000, log: quiet, fetchImpl: async () => new Response("x".repeat(3000)) });
  await assert.rejects(big.proxy({ method: "getSlot" }, { maxBytes: 2000 }), /response over 2000 bytes/);
  assert.equal((await big.proxy({ method: "getSlot" }, { maxBytes: 4000 })).text.length, 3000);
});

test("JSON-envelope rate limits and -32005 are retried; other JSON-RPC errors throw RpcError", async () => {
  let n = 0;
  const bodies = [{ error: { code: 429, message: "Too many requests" } }, { error: { code: -32005, message: "Node is behind" } }, { result: "fine" }, { error: { code: -32602, message: "Invalid params" } }];
  const rpc = new Rpc({ url: "https://rpc.example", rps: 1000, log: quiet, backoffMinMs: 10, fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...bodies[n++] })) });
  assert.equal(await rpc.call("getSlot"), "fine");
  await assert.rejects(rpc.call("getSlot"), (e) => e.name === "RpcError" && e.code === -32602);
});

test("network failures retry with backoff then surface; budget stats are reported", async () => {
  let n = 0;
  const rpc = new Rpc({ url: "https://rpc.example", rps: 1000, log: quiet, fetchImpl: async () => { n++; throw new Error("ECONNRESET"); } });
  await assert.rejects(rpc.call("getSlot", [], { retries: 0 }), /ECONNRESET/);
  assert.equal(n, 1); assert.equal(rpc.stats.errors, 1); assert.match(rpc.stats.lastError, /ECONNRESET/);
  assert.deepEqual(Object.keys(rpc.snapshot()).sort(), ["calls", "errors", "inFlight", "lastError", "pausedMs", "queued", "rateLimited"]);
});

test("deriveWsUrl keeps the key in the query; redact hides it", () => {
  assert.equal(deriveWsUrl("https://mainnet.helius-rpc.com/?api-key=K"), "wss://mainnet.helius-rpc.com/?api-key=K");
  assert.equal(redact("wss://mainnet.helius-rpc.com/?api-key=K"), "wss://mainnet.helius-rpc.com/?api-key=…");
});

// ---- the metered endpoint (RPC_USER_URL): request-driven lanes only, within a daily credit budget, and never slower
// than without it (every refusal there is retried at once on RPC_URL)
const FREE = "https://free.example", PAID = "https://paid.example/?api-key=K";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const routed = (answer = () => json("ok")) => {
  const hits = [];
  const fetchImpl = async (url, init) => { const b = JSON.parse(init.body); hits.push({ url, method: Array.isArray(b) ? "batch" : b.method }); return answer(url, b); };
  return { hits, fetchImpl };
};
const recorder = () => { const lines = []; return { lines, log: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error() {} } }; };
const fast = { rps: 1000, sendRps: 1000 };

test("user route: the api and proxy lanes use RPC_USER_URL, the indexer stays on RPC_URL; batches stay on RPC_URL", async () => {
  const { hits, fetchImpl } = routed();
  const rpc = new Rpc({ url: FREE, rps: 1000, apiRps: 1000, proxyRps: 1000, log: quiet, fetchImpl, user: { url: PAID, ...fast } });
  await rpc.call("getSlot");
  await rpc.lane("api").call("getSlot");
  await rpc.proxy({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash" });
  await rpc.proxy([{ jsonrpc: "2.0", id: 1, method: "getSlot" }, { jsonrpc: "2.0", id: 2, method: "getSlot" }]);
  assert.deepEqual(hits.map((h) => h.url), [FREE, PAID, PAID, FREE]);
  const u = rpc.userSnapshot();
  assert.equal(u.host, "paid.example"); assert.equal(u.calls, 2); assert.equal(u.credits.used, 2);
  assert.ok(!JSON.stringify(u).includes("api-key"), "health never carries the URL (the key is in it)");
  assert.equal(new Rpc({ url: FREE, log: quiet, user: { url: FREE } }).user, null, "the same URL is no second endpoint");
  assert.equal(new Rpc({ url: FREE, log: quiet }).userSnapshot(), null);
});

test("user route: past the day's credits, requests go to RPC_URL until the next UTC day (said once); costs counted high", async () => {
  let now = Date.parse("2026-11-14T23:59:00Z");
  const { hits, fetchImpl } = routed();
  const { lines, log } = recorder();
  const rpc = new Rpc({ url: FREE, rps: 1000, apiRps: 1000, proxyRps: 1000, log, fetchImpl, user: { url: PAID, ...fast, dailyCredits: 12, now: () => now } });
  const api = rpc.lane("api");
  await api.call("getTransaction", ["sig"]); // 10
  await api.call("getSlot"); // 11
  await api.call("getSlot"); // 12: the limit
  await api.call("getSlot"); // over: free
  await rpc.proxy({ method: "getBalance" }); // over: free
  assert.deepEqual(hits.map((h) => h.url), [PAID, PAID, PAID, FREE, FREE]);
  assert.equal(lines.filter((l) => /used today's 12 credits/.test(l)).length, 1, "said once a day");
  assert.equal(creditCost("getProgramAccounts"), 10); assert.equal(creditCost("getSignaturesForAddress"), 10); assert.equal(creditCost("sendTransaction"), 1);
  now = Date.parse("2026-11-15T00:00:01Z");
  await api.call("getSlot");
  assert.equal(hits.at(-1).url, PAID, "a new UTC day, a new budget");
  assert.equal(rpc.userSnapshot().credits.day, "2026-11-15");
  const z = routed();
  await new Rpc({ url: FREE, rps: 1000, apiRps: 1000, log: quiet, fetchImpl: z.fetchImpl, user: { url: PAID, dailyCredits: 0 } }).lane("api").call("getSlot");
  assert.equal(z.hits[0].url, FREE, "a zero budget never uses it");
});

test("user route: a 429, a refused key, an error answer or a network failure there is retried at once on RPC_URL", async () => {
  let paid = [];
  const { fetchImpl } = routed((url) => url === PAID ? (paid.shift() ?? (() => json("paid")))() : json("free"));
  const { lines, log } = recorder();
  const rpc = new Rpc({ url: FREE, rps: 1000, apiRps: 1000, proxyRps: 1000, log, fetchImpl, backoffMinMs: 60, backoffMaxMs: 60, user: { url: PAID, ...fast } });
  const api = rpc.lane("api");
  // HTTP 429: this call goes to RPC_URL at once, and so do the next while the pause lasts; the indexer is untouched
  paid = [() => new Response("", { status: 429, headers: { "retry-after": "0" } })];
  const t0 = Date.now();
  assert.equal(await api.call("getSlot"), "free");
  assert.ok(Date.now() - t0 < 50, "no waiting out the paid endpoint's pause");
  assert.equal(await api.call("getSlot"), "free", "paused: straight to RPC_URL");
  assert.equal(rpc.laneSnapshot().main.pausedMs, 0);
  await wait(80);
  assert.equal(await api.call("getSlot"), "paid", "used again after the pause");
  // Helius' JSON envelope for a spent plan counts as a 429
  paid = [() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "max usage reached" } }))];
  assert.equal(await api.call("getSlot"), "free");
  await wait(80);
  // a refused key: off for 10 minutes, said once, by host
  paid = [() => new Response("unauthorized", { status: 401 })];
  assert.equal(JSON.parse((await rpc.proxy({ method: "getSlot" })).text).result, "free");
  assert.ok(rpc.userSnapshot().offMs > 9 * 60_000);
  assert.equal(await api.call("getSlot"), "free");
  assert.equal(lines.filter((l) => /HTTP 401/.test(l)).length, 1);
  assert.ok(lines.every((l) => !l.includes("api-key")), "logs name the host, never the URL");
  // a network failure, and a 5xx: that request on RPC_URL
  const n = routed((url) => { if (url === PAID) throw new Error("ECONNRESET"); return json("free"); });
  const r2 = new Rpc({ url: FREE, rps: 1000, apiRps: 1000, proxyRps: 1000, log: quiet, fetchImpl: n.fetchImpl, user: { url: PAID, ...fast } });
  assert.equal(await r2.lane("api").call("getSlot"), "free");
  assert.equal(JSON.parse((await r2.proxy({ method: "getSlot" })).text).result, "free");
  const e = routed((url) => url === PAID ? new Response("bad gateway", { status: 502 }) : json("free"));
  const r3 = new Rpc({ url: FREE, rps: 1000, apiRps: 1000, proxyRps: 1000, log: quiet, fetchImpl: e.fetchImpl, user: { url: PAID, ...fast } });
  assert.equal(await r3.lane("api").call("getSlot"), "free");
  assert.equal(JSON.parse((await r3.proxy({ method: "getSlot" })).text).result, "free");
  assert.equal(r3.userSnapshot().fallbacks, 2);
  assert.equal(r3.stats.errors, 0, "a fallback is not an error");
});

test("user route: sendTransaction is paced at the provider's per-second cap, with no burst; other calls are not", async () => {
  const { hits, fetchImpl } = routed();
  const rpc = new Rpc({ url: FREE, rps: 1000, proxyRps: 1000, log: quiet, fetchImpl, user: { url: PAID, rps: 1000, sendRps: 10 } });
  const t0 = Date.now();
  for (const tx of ["x", "y", "z"]) await rpc.proxy({ method: "sendTransaction", params: [tx] });
  const took = Date.now() - t0;
  assert.ok(took >= 180, `three sends at 10/s took ${took} ms (the first at once, then 100 ms apart)`);
  assert.ok(hits.every((h) => h.url === PAID));
  const t1 = Date.now();
  await rpc.proxy({ method: "getBalance" });
  assert.ok(Date.now() - t1 < 50, "other calls do not wait for the send cap");
});

test("credit budget: kept on disk across restarts for the same UTC day, started over on the next", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-credits-"));
  try {
    const file = join(dir, "c.json");
    let now = Date.parse("2026-11-14T10:00:00Z");
    const a = new CreditBudget({ limit: 100, file, now: () => now, log: quiet, saveDelayMs: 60_000 });
    assert.equal(a.take(40), true); assert.equal(a.take(61), false, "nothing booked when it does not fit"); assert.equal(a.used, 40);
    a.flush();
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { day: "2026-11-14", used: 40 });
    assert.equal(new CreditBudget({ limit: 100, file, now: () => now, log: quiet }).used, 40, "a restart keeps the day's count");
    now = Date.parse("2026-11-15T00:00:00Z");
    assert.equal(new CreditBudget({ limit: 100, file, now: () => now, log: quiet }).used, 0, "yesterday's count is not today's");
    writeFileSync(file, "not json");
    assert.equal(new CreditBudget({ limit: 100, file, now: () => now, log: quiet }).used, 0, "an unreadable file starts at 0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("call: maxBytes stops an oversized answer at once; signal ends the request under way and every wait", async () => {
  // maxBytes: thrown without a retry, counted as an error, the lane left; a smaller answer is unaffected.
  let n = 0;
  const big = new Rpc({ url: "https://rpc.example", rps: 1000, log: quiet, fetchImpl: async () => { n++; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(3000) })); } });
  await assert.rejects(big.call("getTokenAccountsByOwner", [], { maxBytes: 2000 }), (e) => e.tooLarge === true && /getTokenAccountsByOwner: response over 2000 bytes/.test(e.message));
  assert.equal(n, 1); assert.equal(big.inFlight, 0); assert.equal(big.stats.errors, 1);
  assert.equal((await big.call("getTokenAccountsByOwner", [], { maxBytes: 4000 })).length, 3000);
  assert.equal((await big.call("getTokenAccountsByOwner")).length, 3000);
  // The metered endpoint's oversized answer is not asked again on RPC_URL.
  const seen = [];
  const two = new Rpc({ url: "https://free.example", rps: 1000, apiRps: 1000, log: quiet, user: { url: "https://user.example/?api-key=k", rps: 1000 }, fetchImpl: async (url) => { seen.push(new URL(url).host); return new Response("y".repeat(3000)); } });
  await assert.rejects(two.lane("api").call("getTokenAccountsByOwner", [], { maxBytes: 2000 }), /response over 2000 bytes/);
  assert.deepEqual(seen, ["user.example"]); assert.equal(two.userSnapshot().fallbacks, 0);

  // signal, request under way: the fetch is cut and the call throws without a retry.
  const hang = new Rpc({ url: "https://rpc.example", rps: 1000, concurrency: 1, log: quiet, fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })) });
  const ac = new AbortController();
  const first = hang.call("getSlot", [], { signal: ac.signal }), queued = hang.call("getSlot", [], { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hang.inFlight, 1); assert.equal(hang.waiters.length, 1);
  const t0 = Date.now();
  ac.abort(new Error("no answer within 20 ms"));
  await assert.rejects(first, (e) => e.aborted === true && /getSlot: no answer within 20 ms/.test(e.message));
  await assert.rejects(queued, (e) => e.aborted === true); // it left the concurrency queue without a request
  assert.ok(Date.now() - t0 < 500);
  assert.equal(hang.inFlight, 0); assert.equal(hang.waiters.length, 0); assert.equal(hang.stats.calls, 1); assert.equal(hang.stats.errors, 0);
  await assert.rejects(hang.call("getSlot", [], { signal: ac.signal }), (e) => e.aborted === true); // already aborted: no request at all
  assert.equal(hang.stats.calls, 1);

  // signal, a 429 pause: the call does not sleep through it, and no token is taken for it.
  let m = 0;
  const limited = new Rpc({ url: "https://rpc.example", rps: 1000, log: quiet, backoffMinMs: 30_000, fetchImpl: async () => { m++; return new Response("", { status: 429 }); } });
  const t1 = Date.now();
  await assert.rejects(limited.call("getBalance", [], { signal: AbortSignal.timeout(60) }), (e) => e.aborted === true);
  assert.ok(Date.now() - t1 < 1_000, `gave up after ${Date.now() - t1} ms`);
  assert.equal(m, 1); assert.equal(limited.inFlight, 0);
  assert.ok(limited.snapshot().pausedMs > 20_000, "the lane's pause itself stands");
});
