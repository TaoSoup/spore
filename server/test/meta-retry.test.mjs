// Metadata retry policy (2026-11-10): a failure is classified from its stored text. Temporary (429, 5xx, timeouts,
// network errors, IPFS gateways that mixed a 403/404 with any of those, a rotation whose gateways did not resolve)
// waits at most 3 h while fewer than 5 fetches failed in a row, then backs off to a day; a non-IPFS host that answered
// 404/410 or does not resolve 5 times IN A ROW (deadStreak) is asked weekly; anything else keeps the 15 min -> 24 h
// backoff. A rotation that said no while other gateways were rate-limited is requeued like a rate-limited one and
// stored with its per-gateway summary; one in which no public gateway looked is a deferral (2026-11-10, its own rules
// in meta-gateways.test.mjs). Stub fetch only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MetaFetcher, HostPacer, isTransientError, metaFailKind, metaRetryS, retryAfterS, META_RETRY_TRANSIENT_MAX_S, META_RETRY_DEAD_S, META_DEAD_AFTER, META_RETRY_MAX_S } from "../lib/meta.mjs";
import { HostGuard } from "../lib/net.mjs";
import { Db } from "../lib/db.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const json = () => new Response(JSON.stringify({ image: "https://ipfs.io/ipfs/QmI" }), { headers: { "content-type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 20));
const fakeModel = () => { const stored = new Map(); return { stored, model: { meta: stored, setMeta: (uri, m) => stored.set(uri, { uri, ...m }) } }; };
const IPFS = "https://ipfs.io/ipfs/QmMeta";
const CDN = "https://m.rapidlaunch.io/m/x";

test("isTransientError / metaFailKind: rate limits, 5xx, timeouts, network errors and mixed gateway answers are temporary; a non-IPFS 404/410/ENOTFOUND is dead", () => {
  for (const t of ["HTTP 429", "HTTP 503", "HTTP 502", "The operation was aborted due to timeout", "read ECONNRESET", "socket hang up", "cannot resolve x.io: EAI_AGAIN",
    "403 pump.mypinata.cloud; 429 ipfs.io; timeout dweb.link", "403 pump.mypinata.cloud; paused ipfs.io; paused dweb.link", "404 pump.mypinata.cloud; 502 ipfs.io", "403 pump.mypinata.cloud; net ipfs.io", "404 pump.mypinata.cloud; budget ipfs.io"]) assert.equal(isTransientError(t), true, t);
  for (const t of ["HTTP 404", "HTTP 403", "HTTP 410", "cannot resolve www.earthpair.com: ENOTFOUND", "Unexpected token '<', \"<!doctype \"... is not valid JSON", "too many redirects from https://x",
    "403 pump.mypinata.cloud; 404 ipfs.io; 404 dweb.link", "404 pump.mypinata.cloud; ENOTFOUND own.gateway.io", null, ""]) assert.equal(isTransientError(t), false, String(t));
  assert.equal(metaFailKind(CDN, "HTTP 404"), "dead"); assert.equal(metaFailKind(CDN, "HTTP 410"), "dead");
  assert.equal(metaFailKind(CDN, "cannot resolve m.rapidlaunch.io: ENOTFOUND"), "dead");
  assert.equal(metaFailKind(IPFS, "HTTP 404"), "failed", "IPFS content may appear on a gateway later: never dead");
  assert.equal(metaFailKind(CDN, "HTTP 403"), "failed"); assert.equal(metaFailKind(CDN, "HTTP 503"), "transient");
  assert.equal(metaFailKind(IPFS, "403 pump.mypinata.cloud; 429 ipfs.io; timeout dweb.link"), "transient");
});

test("metaRetryS: temporary failures wait at most 3 h at first, a dead host weekly after 5 dead failures in a row, the rest 15 min -> 24 h", () => {
  assert.equal(META_DEAD_AFTER, 5);
  assert.equal(metaRetryS(CDN, { error: "HTTP 404", attempts: 4, deadStreak: 4 }), retryAfterS(4), "4 failures: the usual backoff");
  assert.equal(metaRetryS(CDN, { error: "HTTP 404", attempts: 5, deadStreak: 5 }), META_RETRY_DEAD_S); assert.equal(META_RETRY_DEAD_S, 7 * 24 * 3600);
  assert.equal(metaRetryS(CDN, { error: "cannot resolve m.rapidlaunch.io: ENOTFOUND", attempts: 9, deadStreak: 9 }), META_RETRY_DEAD_S);
  assert.equal(metaRetryS(IPFS, { error: "HTTP 404", attempts: 9, deadStreak: 0 }), 24 * 3600, "IPFS keeps the daily cap");
  assert.equal(metaRetryS(CDN, { error: "HTTP 403", attempts: 12 }), 24 * 3600);
  // (a 403 from pump's pinata and a 429 alone are a deferral since 2026-11-10: meta-gateways.test.mjs; a timeout is not)
  assert.equal(metaRetryS(IPFS, { error: "403 pump.mypinata.cloud; 429 ipfs.io; timeout dweb.link", attempts: 4 }), retryAfterS(4)); assert.equal(META_RETRY_TRANSIENT_MAX_S, 3 * 3600);
  assert.equal(metaRetryS(CDN, { error: "HTTP 503", attempts: 1 }), 15 * 60, "the first retry is as soon as ever");
});

test("metaRetryS (repair 2026-11-10): the weekly wait needs 5 DEAD failures in a row, not 5 failures of any kind", () => {
  // four temporary failures, then the host answers 404: attempts is 5, but it said "gone" only once
  assert.equal(metaRetryS(CDN, { error: "HTTP 404", attempts: 5, deadStreak: 1 }), retryAfterS(5), "not weekly");
  assert.equal(metaRetryS(CDN, { error: "HTTP 404", attempts: 8, deadStreak: 4 }), retryAfterS(8));
  assert.equal(metaRetryS(CDN, { error: "HTTP 404", attempts: 9, deadStreak: 5 }), META_RETRY_DEAD_S);
  assert.equal(metaRetryS(CDN, { error: "HTTP 404", attempts: 9 }), retryAfterS(9), "a row without a streak (written before it existed) is not weekly");
});

test("metaRetryS (repair 2026-11-10): a temporary failure that keeps coming backs off past 3 h, up to a day", () => {
  const T = "403 pump.mypinata.cloud; 429 ipfs.io; timeout dweb.link";
  assert.deepEqual([1, 2, 3, 4].map((a) => metaRetryS(IPFS, { error: T, attempts: a })), [15 * 60, 30 * 60, 3600, 2 * 3600], "the first four: the usual backoff, within 3 h");
  assert.equal(metaRetryS(IPFS, { error: T, attempts: META_DEAD_AFTER }), retryAfterS(META_DEAD_AFTER)); assert.ok(retryAfterS(META_DEAD_AFTER) > META_RETRY_TRANSIENT_MAX_S);
  assert.equal(metaRetryS(IPFS, { error: T, attempts: 12 }), META_RETRY_MAX_S, "a day, not 3 h");
  assert.equal(metaRetryS(IPFS, { error: T, attempts: 500 }), 24 * 3600);
  // asked 13 times in its first week (then daily) instead of every 3 h (56 times a week, forever)
  let t = 0, n = 0;
  for (let a = 1; t < 7 * 24 * 3600; a++) { t += metaRetryS(IPFS, { error: T, attempts: a }); n++; }
  assert.equal(n, 13, `${n} retries in the first week`);
});

test("ENOTFOUND (repair 2026-11-10): a rotation whose gateways all failed to resolve is our DNS (temporary), a lone host is weekly only after 5 in a row", async () => {
  const all = "ENOTFOUND pump.mypinata.cloud; ENOTFOUND ipfs.filebase.io; ENOTFOUND 4everland.io; ENOTFOUND ipfs.io; ENOTFOUND dweb.link; ENOTFOUND gateway.pinata.cloud; ENOTFOUND w3s.link";
  assert.equal(isTransientError(all), true); assert.equal(metaFailKind(IPFS, all), "transient");
  assert.equal(isTransientError("ENOTFOUND own.gateway.io; ENOTFOUND other.gateway.io"), true, "every candidate");
  assert.equal(isTransientError("403 pump.mypinata.cloud; ENOTFOUND ipfs.io; ENOTFOUND dweb.link"), true, "two rotation gateways exist: not resolving them is our resolver");
  assert.equal(isTransientError("404 pump.mypinata.cloud; ENOTFOUND own.gateway.io"), false, "a creator's own dead gateway among answers stays final");
  assert.equal(isTransientError("cannot resolve m.rapidlaunch.io: ENOTFOUND"), false, "a lone host: counted, not excused");
  // the pacer with a resolver that is down: every gateway throws ENOTFOUND
  const down = new HostGuard({ resolve: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); } });
  const pacer = new HostPacer({ fetchImpl: async () => { throw new Error("never reached"); }, guard: down, sleep: async () => {} });
  await assert.rejects(() => pacer.fetchAny(IPFS), (e) => e.transient === true && e.summary === all);
  await assert.rejects(() => pacer.fetchAny(CDN), (e) => e.transient === false && e.summary === null && /ENOTFOUND/.test(e.message));
  // pump's pinata still answers (a cached address) while the rest do not resolve: temporary, not "gone everywhere"
  const partial = new HostGuard({ resolve: async (h) => { if (h === "pump.mypinata.cloud") return [{ address: "93.184.216.34", family: 4 }]; throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } });
  const p2 = new HostPacer({ fetchImpl: async () => new Response("", { status: 403 }), guard: partial, sleep: async () => {} });
  const hit = await p2.fetchAny(IPFS);
  assert.equal(hit.res.status, 403); assert.equal(hit.transient, true); assert.match(hit.summary, /^403 pump\.mypinata\.cloud; ENOTFOUND ipfs\.filebase\.io; ENOTFOUND 4everland\.io; ENOTFOUND ipfs\.io/);
  // MetaFetcher: the IPFS uri is a transient failure; the lone host is dead, retried on the usual backoff until 5 in a row
  const { stored, model } = fakeModel();
  const f = new MetaFetcher(model, { pacer, concurrency: 1 });
  try {
    f.request(IPFS); await tick();
    assert.equal(stored.get(IPFS).error, all); assert.equal(metaFailKind(IPFS, stored.get(IPFS).error), "transient"); assert.equal(f.stats.failedTransient, 1);
    for (let i = 1; i <= META_DEAD_AFTER; i++) {
      if (i > 1) stored.set(CDN, { ...stored.get(CDN), fetchedAt: 0 });
      f.request(CDN); await tick();
      const row = stored.get(CDN);
      assert.equal(row.deadStreak, i); assert.equal(metaFailKind(CDN, row.error), "dead");
      assert.equal(f.needsFetch(CDN, row.fetchedAt + retryAfterS(i) + 1), i < META_DEAD_AFTER, `failure ${i}`);
    }
    assert.equal(f.needsFetch(CDN, stored.get(CDN).fetchedAt + META_RETRY_DEAD_S + 1), true, "weekly after the fifth");
  } finally { f.stop(); }
});

test("ENOTFOUND (repair 2026-11-10): ONE rotation gateway that does not resolve is not our DNS (it may be retired for good); two are", () => {
  const one = "403 pump.mypinata.cloud; 404 ipfs.io; 404 dweb.link; 404 gateway.pinata.cloud; ENOTFOUND w3s.link";
  assert.equal(isTransientError(one), false, "the others' 403 and 404s stay definitive"); assert.equal(metaFailKind(IPFS, one), "failed");
  assert.equal(isTransientError("403 pump.mypinata.cloud; ENOTFOUND w3s.link"), false);
  const two = "403 pump.mypinata.cloud; 404 ipfs.io; 404 dweb.link; ENOTFOUND gateway.pinata.cloud; ENOTFOUND w3s.link";
  assert.equal(isTransientError(two), true); assert.equal(metaFailKind(IPFS, two), "transient");
  assert.equal(isTransientError("ENOTFOUND own.gateway.io; ENOTFOUND w3s.link"), true, "every candidate, still");
  assert.equal(isTransientError("404 own.gateway.io; ENOTFOUND own2.gateway.io; ENOTFOUND w3s.link"), false, "a creator's gateway does not count as one of the rotation's");
});

test("HostPacer.fetchAny says how the rotation went: limited / transient / a per-gateway summary", async () => {
  const mixed = new HostPacer({ fetchImpl: async (u) => new Response("", { status: u.startsWith("https://pump.mypinata.cloud/") ? 403 : 429 }), sleep: async () => {} });
  const m = await mixed.fetchAny(IPFS);
  assert.equal(m.res.status, 403, "the answer that came is returned, as before");
  assert.equal(m.limited, true); assert.equal(m.transient, true);
  assert.equal(m.summary, "403 pump.mypinata.cloud; 429 ipfs.filebase.io; 429 4everland.io; 429 ipfs.io; 429 dweb.link; 429 gateway.pinata.cloud; 429 w3s.link");
  const gone = await new HostPacer({ fetchImpl: async () => new Response("", { status: 404 }), sleep: async () => {} }).fetchAny(IPFS);
  assert.equal(gone.limited, false); assert.equal(gone.transient, false); assert.equal(gone.summary.split("; ").length, 7);
  const one = await new HostPacer({ fetchImpl: async () => new Response("", { status: 404 }), sleep: async () => {} }).fetchAny(CDN);
  assert.equal(one.summary, null, "one candidate: the status says it all"); assert.equal(one.transient, false);
  const slow = new HostPacer({ fetchImpl: async () => { throw new Error("The operation was aborted due to timeout"); }, sleep: async () => {} });
  await assert.rejects(() => slow.fetchAny(IPFS), (e) => e.transient === true && e.summary.startsWith("timeout pump.mypinata.cloud; timeout ipfs.filebase.io"));
});

test("MetaFetcher: a 403 from pump's pinata while the public gateways are rate-limited is requeued, then stored with the gateways' summary as a deferral (2026-11-10: no public gateway looked, so no failed attempt)", async () => {
  const { stored, model } = fakeModel();
  const fetchImpl = async (u) => new Response("", { status: u.startsWith("https://pump.mypinata.cloud/") ? 403 : 429 });
  const f = new MetaFetcher(model, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), concurrency: 1 });
  try {
    f.request(IPFS); await tick();
    assert.equal(stored.size, 0, "not stored as a failure: requeued like a rate-limited fetch");
    assert.equal(f.stats.rateLimited, 1); assert.equal(f.attempts.get(IPFS), 1);
    // the requeues ran out (three of them): stored with the summary, as a deferral (a temporary failure, but no failed attempt)
    f.attempts.set(IPFS, 3); f.request(IPFS); await tick();
    const row = stored.get(IPFS);
    assert.equal(row.ok, false); assert.equal(row.attempts, 1);
    assert.match(row.error, /^403 pump\.mypinata\.cloud; (?:429|paused) ipfs\.filebase\.io/);
    assert.equal(metaFailKind(IPFS, row.error), "deferred"); assert.equal(isTransientError(row.error), true);
    assert.equal(f.stats.failedTransient, 1); assert.equal(f.stats.deferred, 1);
    assert.equal(f.needsFetch(IPFS, row.fetchedAt + 16 * 60), true, "the next try within 15 min");
    stored.set(IPFS, { ...row, attempts: 4 });
    assert.equal(f.needsFetch(IPFS, row.fetchedAt + 3600 + 1), true, "and within the hour, whatever the count");
    stored.set(IPFS, { ...row, attempts: 12 });
    assert.equal(f.needsFetch(IPFS, row.fetchedAt + 3600 + 1), true, "a dozen deferrals do not back off towards a day (they did before 2026-11-10)");
  } finally { f.stop(); }
});

test("MetaFetcher: 403 plus timeouts is stored at once (nothing was rate-limited) with the summary, as temporary; 404 everywhere keeps the usual backoff", async () => {
  const { stored, model } = fakeModel();
  const fetchImpl = async (u) => {
    if (u.includes("QmGone")) return new Response("", { status: 404 });
    if (u.startsWith("https://pump.mypinata.cloud/")) return new Response("", { status: 403 });
    throw new Error("The operation was aborted due to timeout");
  };
  const f = new MetaFetcher(model, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), concurrency: 1 });
  try {
    f.request(IPFS); await tick();
    const row = stored.get(IPFS);
    assert.equal(row.ok, false); assert.equal(f.stats.rateLimited, 0);
    assert.equal(row.error, "403 pump.mypinata.cloud; timeout ipfs.filebase.io; timeout 4everland.io; timeout ipfs.io; timeout dweb.link; timeout gateway.pinata.cloud; timeout w3s.link");
    assert.equal(metaFailKind(IPFS, row.error), "transient", "the public gateways looked (timeouts): no deferral");
    stored.set(IPFS, { ...row, attempts: 3 });
    assert.equal(f.needsFetch(IPFS, row.fetchedAt + META_RETRY_TRANSIENT_MAX_S + 1), true);
    const gone = "https://ipfs.io/ipfs/QmGone";
    f.request(gone); await tick();
    assert.ok(stored.get(gone).error.split("; ").every((s) => s.startsWith("404 ")));
    assert.equal(metaFailKind(gone, stored.get(gone).error), "failed");
    assert.equal(f.needsFetch(gone, stored.get(gone).fetchedAt + 14 * 60), false); assert.equal(f.needsFetch(gone, stored.get(gone).fetchedAt + 16 * 60), true);
  } finally { f.stop(); }
});

test("MetaFetcher: a non-IPFS host that answered 404 five times in a row is asked weekly, not daily; a success resets it", async () => {
  const { stored, model } = fakeModel();
  let status = 404;
  const f = new MetaFetcher(model, { pacer: new HostPacer({ fetchImpl: async () => (status === 200 ? json() : new Response("", { status })), sleep: async () => {} }), concurrency: 1 });
  try {
    f.request(CDN); await tick();
    assert.equal(stored.get(CDN).error, "HTTP 404"); assert.equal(stored.get(CDN).attempts, 1); assert.equal(stored.get(CDN).deadStreak, 1);
    stored.set(CDN, { ...stored.get(CDN), attempts: 4, deadStreak: 4, fetchedAt: 0 });
    f.request(CDN); await tick();
    const row = stored.get(CDN);
    assert.equal(row.attempts, 5); assert.equal(row.deadStreak, 5);
    assert.equal(f.needsFetch(CDN, row.fetchedAt + 25 * 3600), false, "not after a day");
    assert.equal(f.needsFetch(CDN, row.fetchedAt + 7 * 24 * 3600 + 1), true, "after a week");
    stored.set(CDN, { ...row, fetchedAt: 0 }); status = 200;
    f.request(CDN); await tick();
    assert.equal(stored.get(CDN).ok, true); assert.equal(stored.get(CDN).attempts, 0); assert.equal(stored.get(CDN).deadStreak, 0);
  } finally { f.stop(); }
});

test("MetaFetcher (repair 2026-11-10): temporary failures then 404s need 5 404s in a row for the weekly wait; another failure in between starts the streak over; it survives a restart (meta.dead_streak)", async () => {
  const db = new Db(":memory:");
  const stored = new Map();
  const model = { meta: stored, setMeta: (uri, m) => { const row = { uri, ...m }; stored.set(uri, row); db.metaSet(row); } };
  let status = 503;
  const f = new MetaFetcher(model, { pacer: new HostPacer({ fetchImpl: async () => new Response("", { status }), sleep: async () => {} }), concurrency: 1 });
  const again = async () => { stored.set(CDN, { ...stored.get(CDN), fetchedAt: 0 }); f.request(CDN); await tick(); return stored.get(CDN); };
  try {
    f.request(CDN); await tick();
    for (let i = 0; i < 3; i++) await again(); // four temporary failures
    assert.equal(stored.get(CDN).attempts, 4); assert.equal(stored.get(CDN).deadStreak, 0);
    status = 404;
    let row = await again();
    assert.equal(row.attempts, 5); assert.equal(row.deadStreak, 1);
    assert.equal(f.needsFetch(CDN, row.fetchedAt + retryAfterS(5) + 1), true, "a first 404 after temporary failures is not weekly");
    for (let i = 0; i < 3; i++) row = await again();
    assert.equal(row.deadStreak, 4);
    status = 503; row = await again();
    assert.equal(row.deadStreak, 0, "a temporary failure breaks the streak");
    status = 404;
    for (let i = 0; i < 4; i++) row = await again();
    assert.equal(row.deadStreak, 4); assert.equal(f.needsFetch(CDN, row.fetchedAt + 24 * 3600 + 1), true);
    row = await again();
    assert.equal(row.deadStreak, 5); assert.equal(f.needsFetch(CDN, row.fetchedAt + 24 * 3600 + 1), false, "five 404s in a row: weekly");
    assert.equal(db.metaGet(CDN).deadStreak, 5, "persisted"); assert.equal(db.allMeta()[0].deadStreak, 5);
    assert.equal(metaRetryS(CDN, db.metaGet(CDN)), META_RETRY_DEAD_S, "after a restart too");
  } finally { f.stop(); db.close(); }
});

test("db: a meta table from before dead_streak gets the column; its old rows start at 0 (none goes weekly before 5 dead failures in a row)", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-meta-mig-")), file = join(dir, "spore.db");
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv (key, value) VALUES ('schema_version', '3');
      CREATE TABLE meta (uri TEXT PRIMARY KEY, image TEXT, description TEXT, twitter TEXT, telegram TEXT, website TEXT,
        fetched_at INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, error TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      INSERT INTO meta (uri, fetched_at, ok, error, attempts) VALUES ('${CDN}', 100, 0, 'HTTP 404', 9);`);
    old.close();
    const db = new Db(file);
    try {
      const row = db.metaGet(CDN);
      assert.equal(row.attempts, 9); assert.equal(row.deadStreak, 0);
      assert.equal(metaRetryS(CDN, row), retryAfterS(9), "the daily backoff, not weekly, until it earns the streak");
      db.metaSet({ ...row, deadStreak: 5 });
      assert.equal(db.metaGet(CDN).deadStreak, 5);
    } finally { db.close(); }
    const again = new Db(file); // idempotent
    try { assert.equal(again.metaGet(CDN).deadStreak, 5); } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
