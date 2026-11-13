// Passes over every coin that held the event loop on the local index (Nov 13 2026, 228k coins), now spread over the
// shared scheduler (sliced.mjs) or kept as counts: stats (0.4-0.5 s at each refresh round and each /api/stats), the
// metadata sweep (0.5-0.9 s once a minute), the backfill counts (a 0.25 s COUNT twice per resolve batch), family pages
// (0.12 s for PUMP's 31k coins) and share cards (1.8 s on a stale map). The answers stay what the synchronous code gave.
// No network: a synthetic tree, a fake clock. "Yields" is shown by a setImmediate queued mid-pass running before the
// pass ends, with each step made slow on purpose (a pass this small would otherwise end inside one SLICE_MS turn).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Db } from "../lib/db.mjs";
import { Model, MAP_CACHE_MS } from "../lib/model.mjs";
import { MetaFetcher } from "../lib/meta.mjs";
import { cardData, cardDataAsync, cardWalks, CARD_SHARES_MAX_AGE_MS, CARD_WALKS_MAX } from "../lib/card.mjs";
import { Indexer } from "../lib/indexer.mjs";
import { familyShares, familySharesGen } from "../lib/dominance.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";

const keyN = (n) => new PublicKey(createHash("sha256").update(`loop-passes-${n}`).digest()).toBase58();
const ASSET = keyN("asset");
const OUR_SHARES = [{ address: "CR", bps: 5000 }, { address: PLATFORM, bps: 5000 }];
const spin = (ms) => { const t = performance.now(); while (performance.now() - t < ms); };

/**
 * SOL roots with children (every third one ours, every fourth with a child of its own), an untracked root, a listed
 * asset's family, trades on some coins (24 h volume), one pending spawn, a metadata uri per coin.
 */
function buildModel({ clock, mode = "all", roots = 60, kids = 12, assetKids = 1500 } = {}) {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode, now: () => clock.t, log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  model.setQuoteUsd(ASSET, 1);
  let seq = 0;
  const coin = (o) => { const mint = keyN(++seq); model.upsertCoin({ mint, curve: `C${seq}`, ...base, ...o }); model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `coin ${seq}`, symbol: `C${seq}`, uri: `https://ipfs.io/ipfs/c${seq}`, onchainAt: 1 }); return mint; };
  const kidsOf = [], rootsOf = [];
  for (let r = 0; r < roots; r++) {
    const root = coin({ depth: 0, quoteMint: null, virtualQuoteReserves: String(100_000_000_000 + (r % 7) * 1_000_000_000), createdAt: 1000 + r });
    rootsOf.push(root);
    for (let k = 0; k < kids; k++) {
      const kid = coin({ depth: 1, quoteMint: root, virtualQuoteReserves: String(1_000_000_000_000_000 + (k % 3) * 100_000_000_000_000), realQuoteReserves: String((k % 5) * 1_000_000_000_000), createdAt: 2000 + k, ...(k % 3 === 0 ? { shares: OUR_SHARES, sharesAt: 1 } : {}) });
      kidsOf.push(kid);
      if (k % 4 === 0) coin({ depth: 2, quoteMint: kid, virtualQuoteReserves: "500000000000000", realQuoteReserves: String(k * 10_000_000_000), createdAt: 3000, ...(k % 8 === 0 ? { shares: OUR_SHARES, sharesAt: 1 } : {}) });
    }
  }
  coin({ depth: 0, quoteMint: null, virtualQuoteReserves: "100000000000", tracked: false });
  model.setMint({ mint: ASSET, decimals: 6, tokenProgram: T22, name: "Listed asset", symbol: "ASSET", uri: "https://ipfs.io/ipfs/asset", onchainAt: 1 }); // the sweep's asset branch
  const assetKidsOf = [];
  for (let a = 0; a < assetKids; a++) assetKidsOf.push(coin({ depth: 0, quoteMint: ASSET, virtualQuoteReserves: String(1_000_000_000 + (a % 37) * 10_000_000), realQuoteReserves: String((a % 11) * 1_000_000), createdAt: 1000 + (a % 13) }));
  const time = Math.floor(clock.t / 1000);
  for (let i = 0; i < 40; i++) model.recordTrade({ sig: `S${i}`, mint: i % 2 ? kidsOf[i * 3] : assetKidsOf[i * 7], idx: 0, slot: i, time, isBuy: i % 3 !== 0, user: "U", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd: 10 + i });
  model.markPending(kidsOf[1], null); // a foreign kid the UI reported as spawned here
  clock.t += 10_000;
  model.computed();
  return { db, model, kidsOf, rootsOf, assetKidsOf };
}

/** stats() as it was before Nov 13 2026: the walk over scope(), scoped() and visibleRoots(). */
function walkStats(model) {
  const sc = model.scope();
  const maxDepth = model.global?.maxCurveDepth ?? 0;
  const byDepth = new Array(Math.max(maxDepth + 1, 1)).fill(0);
  let coins = 0, lockedUsd = 0, otherChildren = 0;
  for (const mint of model.mode === "all" ? sc.inScope : sc.ours) {
    const c = model.coins.get(mint); if (!c) continue;
    coins++;
    if (c.depth < byDepth.length) byDepth[c.depth]++; else byDepth[c.depth] = (byDepth[c.depth] ?? 0) + 1;
  }
  for (const mint of sc.inScope) { const c = model.coins.get(mint); if (!c) continue; const s = model.scoped(c); lockedUsd += s.lockedUsd ?? 0; otherChildren += s.otherChildren; }
  const roots = model.visibleRoots().length;
  let volume24hUsd = 0; for (const [mint, v] of model.volumes()) if (sc.inScope.has(mint)) volume24hUsd += v.usd;
  return { coins, roots, byDepth, lockedUsd, volume24hUsd, solUsd: model.solUsd, maxDepth, backfill: { ...model.backfill }, updatedAt: model.updatedAt, mode: model.mode, ourCoins: sc.ours.size, otherChildren };
}

test("stats: the same numbers as the walk over scope(), in both modes, at once and in slices; a change shows at once", async () => {
  for (const mode of ["all", "ours"]) {
    const clock = { t: 1_800_000_000_000 };
    const { model, kidsOf } = buildModel({ clock, mode });
    const ref = walkStats(model);
    assert.ok(ref.ourCoins > 0 && ref.volume24hUsd > 0 && ref.lockedUsd > 0, `${mode}: the fixture has ours coins, volume and locked value`);
    assert.deepEqual(model.stats(), ref, `${mode}: stats()`);
    model.setSolUsd(123); // a new version: statsAsync makes a new pass
    assert.deepEqual(await model.statsAsync(), walkStats(model), `${mode}: statsAsync()`);
    // a spawn listed by the UI counts at once (POST /api/spawned, then GET /api/stats), and so does its expiry
    const before = (await model.statsAsync()).ourCoins;
    model.markPending(kidsOf[2], null);
    assert.equal((await model.statsAsync()).ourCoins, before + 1, `${mode}: a pending spawn counts at once`);
    clock.t += 11 * 60_000;
    assert.deepEqual(await model.statsAsync(), walkStats(model), `${mode}: expired pending spawns leave both`);
    assert.ok((await model.statsAsync()).ourCoins < before + 1);
  }
});


test("stats: what moves without a version bump is not served from the cache: trades leaving the 24 h window, a background computed() pass", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { model } = buildModel({ clock });
  clock.t += 11 * 60_000;
  await model.statsAsync(); // the pending spawn expired (a version bump); these counts are cached now
  const v = model.version, before = await model.statsAsync();
  assert.ok(before.volume24hUsd > 0);
  clock.t += 25 * 3_600_000; // every trade leaves the 24 h window; nothing bumps the version
  const after = await model.statsAsync();
  assert.equal(model.version, v, "no version bump");
  assert.equal(after.volume24hUsd, 0);
  assert.deepEqual(after, walkStats(model));
  assert.deepEqual(model.stats(), walkStats(model), "stats() too");
  // a large index: computed() serves its last table and refreshes it in the background; the new table moves no version
  model.computeSliceMinCoins = 0; model.derivedAt = 0;
  model.setSolUsd(200);
  const stale = await model.statsAsync(); // made from the table computed() served at its start: the old one
  for (let i = 0; i < 1000 && model.derivedVersion !== model.version; i++) await new Promise((r) => setImmediate(r));
  assert.equal(model.derivedVersion, model.version, "the background pass ended");
  const fresh = await model.statsAsync();
  assert.notEqual(fresh.lockedUsd, stale.lockedUsd, "the new table's locked value (SOL at $200, not $100)");
  assert.deepEqual(fresh, walkStats(model));
});

test("statsAsync: the pass gives the event loop turns; callers at one version share it; however many versions callers come at, one pass runs and one follow-up waits, never older than the call", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { model, kidsOf } = buildModel({ clock, roots: 160, assetKids: 400 }); // ~2.8k coins: two steps of 2k
  const tracked = model.tracked().length;
  const ours0 = walkStats(model).ourCoins;
  const orig = model.isOurCoin;
  let calls = 0, ranMid = null, done = false;
  model.isOurCoin = function (c) { if (++calls === 50) setImmediate(() => { ranMid = !done; }); spin(0.01); return orig.call(this, c); };
  model.setSolUsd(101);
  const [a, b] = await Promise.all([model.statsAsync(), model.statsAsync()]);
  done = true;
  assert.equal(ranMid, true, "a setImmediate queued during the pass ran before it ended");
  assert.deepEqual(a, b);
  assert.equal(calls, tracked, "one pass for two callers at one version");
  assert.deepEqual(await model.statsAsync(), a, "nothing moved: the cached counts");
  assert.equal(calls, tracked);
  // trades move the version between callers (every trade does): the first caller's pass runs, every later caller shares one follow-up
  calls = 0;
  model.setSolUsd(102);
  const first = model.statsAsync();
  await new Promise((r) => setImmediate(r)); // the pass has read its version (its first step)
  const later = [];
  for (const k of [2, 4, 5, 7, 8]) { model.markPending(kidsOf[k], null); later.push(model.statsAsync()); } // foreign kids the UI reported: +1 ours each
  const [f, ...rest] = await Promise.all([first, ...later]);
  model.isOurCoin = orig;
  assert.equal(calls, 2 * tracked, "two passes for six callers at six versions");
  assert.equal(f.ourCoins, ours0, "the first pass: the state at its start");
  for (const s of rest) assert.equal(s.ourCoins, ours0 + 5, "every later caller: a pass that started after its call");
  assert.deepEqual(rest[4], walkStats(model));
  // and again: the follow-up was cleared, so a new round gets a new one (a caller chained on a pass's end included)
  calls = 0;
  model.isOurCoin = function (c) { ++calls; spin(0.01); return orig.call(this, c); };
  model.setSolUsd(103);
  const first2 = model.statsAsync();
  await new Promise((r) => setImmediate(r));
  model.markPending(kidsOf[10], null);
  const later2 = model.statsAsync();
  const chained = first2.then(() => model.statsAsync());
  const [f2, l2, c2] = await Promise.all([first2, later2, chained]);
  model.isOurCoin = orig;
  assert.equal(calls, 2 * tracked, "two passes in the second round as well");
  assert.equal(f2.ourCoins, ours0 + 5);
  assert.equal(l2.ourCoins, ours0 + 6, "the second round's follow-up saw the new spawn");
  assert.deepEqual(c2, l2, "a caller between the pass's end and the follow-up's start shares the follow-up");
});

test("statsAsync: a caller does not join a running pass whose computed() table was replaced meanwhile (no version bump)", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { model } = buildModel({ clock, roots: 160, assetKids: 400 });
  // a large index: computed() serves its last table while its background pass is throttled (COMPUTED_MIN_MS)
  model.computeSliceMinCoins = 0; model.derivedAt = Date.now();
  const orig = model.isOurCoin;
  let calls = 0, r1done = false, during = null;
  model.isOurCoin = function (c) {
    if (++calls === 50) setImmediate(() => {
      // between two of R1's steps, the background pass lands: a new table, no version bump (the model's own pass, run here at once)
      const v = model.version;
      model.derivedVersion = -1; model.computed();
      during = { r1done, bumped: model.version !== v, b: model.statsAsync() };
    });
    spin(0.01); return orig.call(this, c);
  };
  model.setSolUsd(200);
  const old = model.derived;
  const a = await model.statsAsync().then((s) => { r1done = true; return s; }); // R1: made from the old table (SOL at $100)
  assert.ok(during, "the swap happened during R1");
  assert.equal(during.r1done, false, "while R1 still ran");
  assert.equal(during.bumped, false, "no version bump");
  assert.notEqual(model.derived, old, "a new table");
  const bb = await during.b;
  model.isOurCoin = orig;
  const want = walkStats(model);
  assert.notEqual(a.lockedUsd, want.lockedUsd, "R1 made its numbers from the old table");
  assert.deepEqual(bb, want, "the later caller got the new table's numbers");
});

test("stats: the 24 h volume walks a copy: a mint whose trade leaves the window and that trades again during the pass is counted once", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { model, assetKidsOf } = buildModel({ clock, assetKids: 3000 });
  const nowS = Math.floor(clock.t / 1000), X = assetKidsOf[2999];
  const trade = (mint, i, time, valueUsd) => model.recordTrade({ sig: `V${i}`, mint, idx: 0, slot: 1e6 + i, time, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd });
  // X trades first, a second from leaving the 24 h window; then 2,500 other mints: the volume walk spans several steps
  const freshMints = [...assetKidsOf.slice(0, 2500)];
  model.activity = new model.activity.constructor({ now: () => Math.floor(clock.t / 1000) }); // only these trades
  trade(X, 0, nowS - 86_400 + 1, 1000);
  freshMints.forEach((m, i) => trade(m, i + 1, nowS, 1));
  const before = walkStats(model).volume24hUsd;
  assert.equal(before, 3500);
  model.setSolUsd(101); model.computed(); // the new version's table now, so only the volume walk reads coins.get below
  const get = model.coins.get;
  let armed = true;
  model.coins.get = function (m) {
    if (armed && m === X) { // the volume walk reached X (first in the Map): between two steps, X's old trade leaves and X trades again
      armed = false;
      setImmediate(() => { clock.t += 2_000; trade(X, 9999, Math.floor(clock.t / 1000), 1000); });
    }
    spin(0.005); return get.call(this, m);
  };
  const s = await model.statsAsync();
  model.coins.get = get;
  assert.equal(armed, false, "the hook ran");
  assert.ok(s.volume24hUsd <= 3500, `X counted once: ${s.volume24hUsd}`);
});

test("metadata sweep: sweepAsync queues what sweep() queues, in the same order, giving the loop turns; a uri asked for, fetched or in flight meanwhile is checked again; stop() ends it", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { model, kidsOf } = buildModel({ clock, roots: 160, assetKids: 400 });
  const make = () => new MetaFetcher(model, { concurrency: 0, pacer: { fetchAny: async () => null }, log: quiet, now: () => clock.t });
  const f1 = make(), n1 = f1.sweep(), q1 = f1.queue.slice(f1.head);
  assert.ok(n1 > 2000, `${n1} uris queued`);
  assert.equal(q1[0], "https://ipfs.io/ipfs/asset", "the listed asset's logo first");
  const real = model.mints;
  // three coins the first step passes (candidates by then): one asked for, one answered, one in flight before the sweep ends
  const [asked, answered, flying] = [kidsOf[0], kidsOf[2], kidsOf[4]].map((m) => real.get(m).uri);
  assert.ok([asked, answered, flying].every((u) => q1.includes(u)));
  let calls = 0, ranMid = null, done = false;
  const f2 = make();
  model.mints = { get: (k) => {
    if (++calls === 50) setImmediate(() => {
      ranMid = !done;
      f2.request(asked);
      model.setMeta(answered, { image: "https://ipfs.io/ipfs/answered.png", description: null, twitter: null, telegram: null, website: null, fetchedAt: Math.floor(clock.t / 1000), ok: true });
      f2.inFlight.add(flying);
    });
    spin(0.005); return real.get(k);
  } };
  const n2 = await f2.sweepAsync();
  done = true;
  model.mints = real;
  f2.inFlight.delete(flying);
  assert.equal(ranMid, true, "a setImmediate queued during the sweep ran before it ended");
  const q2 = f2.queue.slice(f2.head);
  assert.equal(q2[0], asked, "the uri asked for meanwhile went first (request)");
  assert.equal(q2.filter((u) => u === asked).length, 1, "and the sweep did not queue it again");
  assert.ok(!q2.includes(answered), "a uri answered meanwhile is not queued");
  assert.ok(!q2.includes(flying), "nor one in flight");
  assert.equal(n2, n1 - 3);
  assert.deepEqual(q2.slice(1), q1.filter((u) => u !== asked && u !== answered && u !== flying), "the sweep's order");
  assert.equal(f2.stats.sweeps, 1);
  // stop() during a sweep: it ends without queueing anything
  const f3 = make();
  model.mints = { get: (k) => { if (++calls % 100 === 0) setImmediate(() => f3.stop()); spin(0.005); return real.get(k); } };
  assert.equal(await f3.sweepAsync(), 0);
  model.mints = real;
  assert.equal(f3.queue.length, 0);
  // one sweep at a time, and the same count as a sweep at once
  const f4 = make();
  const s1 = f4.sweepAsync(), s2 = f4.sweepAsync();
  assert.equal(s1, s2);
  assert.equal(await s1, make().sweep());
});

test("backfill counts: kept in memory after one COUNT, equal to the table after every kind of write, restored by a rolled-back transaction (SQLite's own rollback too)", () => {
  const db = new Db(":memory:");
  const stmt = db.q.bfCurveStats, state = db.q.bfCurveState;
  let reads = 0, looks = 0;
  db.q.bfCurveStats = { get: (...a) => { reads++; return stmt.get(...a); } };
  db.q.bfCurveState = { get: (...a) => { looks++; return state.get(...a); } };
  const table = () => { const r = stmt.get(); return { total: r.total ?? 0, resolved: r.resolved ?? 0, failed: r.failed ?? 0 }; };
  const check = (what) => assert.deepEqual(db.backfillStats(), table(), what);
  const up = (curve) => db.backfillCurveUpsert({ curve, depth: 1, quoteMint: null, data: "AA==", graduated: false, rq: 1 });
  up("c0"); assert.equal(looks, 0, "nothing looked up before the first count");
  check("one row");
  for (const c of ["c1", "c2", "c3", "c4", "c5"]) up(c);
  check("five new rows");
  looks = 0; up("c1"); check("an upsert of a known row"); assert.equal(looks, 1, "an upsert looks its row up once");
  db.backfillResolve("c1", "M1"); check("pending → resolved");
  db.backfillResolve("c1", "M1"); check("resolved again");
  db.backfillFail("c2", "boom"); check("pending → failed");
  db.backfillResolve("c2", "M2"); check("failed → resolved");
  db.backfillFail("c1", ""); check("resolved → failed (an empty error is still an error)");
  db.backfillFail("c1", "again"); check("failed again");
  db.backfillResolve("nope", "MX"); db.backfillFail("nope", "x"); check("a curve that is not there");
  assert.throws(() => db.transaction(() => { up("c6"); up("c7"); db.backfillResolve("c3", "M3"); db.backfillFail("c4", "y"); throw new Error("rollback"); }), /rollback/);
  check("a rolled-back transaction");
  // SQLite rolled back on its own (a full disk, an I/O error): ROLLBACK then fails; the counts still come back, and the first error is the one thrown
  assert.throws(() => db.transaction(() => { up("c9"); db.backfillResolve("c3", "M3"); db.db.exec("ROLLBACK"); throw new Error("disk full"); }), /disk full/);
  check("a transaction SQLite rolled back itself");
  // a ROLLBACK that fails while the transaction is still open is not swallowed: that error is the one thrown
  const exec = db.db.exec;
  db.db.exec = function (sql) { if (sql === "ROLLBACK") { db.db.exec = exec; throw new Error("rollback failed"); } return exec.call(this, sql); };
  assert.throws(() => db.transaction(() => { up("c10"); throw new Error("first"); }), /rollback failed/);
  assert.equal(db.db.isTransaction, true);
  db.db.exec("ROLLBACK");
  check("after the failed ROLLBACK was rolled back");
  db.transaction(() => { up("c8"); db.backfillFail("c4", "z"); db.backfillResolve("c5", "M5"); });
  check("a committed transaction");
  assert.deepEqual(table(), { total: 7, resolved: 2, failed: 2 });
  assert.equal(reads, 1, "one COUNT, at the first read");
  db.db.exec("UPDATE backfill_curves SET error = NULL, resolved_at = 0 WHERE error IS NOT NULL"); // another process resets the failed rows
  assert.deepEqual(db.backfillRecount(), table(), "backfillRecount reads the table again");
  assert.equal(reads, 2);
  // a rollback before anything was counted leaves nothing counted
  const db2 = new Db(":memory:");
  assert.throws(() => db2.transaction(() => { db2.backfillCurveUpsert({ curve: "x", depth: 1, quoteMint: null, data: "AA==", graduated: false, rq: 1 }); db2.backfillStats(); throw new Error("rollback"); }));
  assert.deepEqual(db2.backfillStats(), { total: 0, resolved: 0, failed: 0 });
});

test("family pages: familyEntryAsync builds what familyEntry builds, giving the loop turns; concurrent asks share one build, and asks for many families one asset-family pass", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { model, rootsOf } = buildModel({ clock, assetKids: 3000 });
  const sync = model.familyEntry(ASSET);
  const builds = model.familyStats.builds;
  clock.t += MAP_CACHE_MS + 1;
  model.upsertCoin({ mint: rootsOf[0], realQuoteReserves: "123000000000" }); // a new version that leaves the asset's rows as they are
  const real = model.mints;
  let calls = 0, ranMid = null, done = false;
  model.mints = { get: (k) => { if (++calls === 50) setImmediate(() => { ranMid = !done; }); spin(0.005); return real.get(k); } };
  const [a, b] = await Promise.all([model.familyEntryAsync(ASSET), model.familyEntryAsync(ASSET)]);
  done = true;
  model.mints = real;
  assert.equal(ranMid, true, "a setImmediate queued during the build ran before it ended");
  assert.equal(a, b, "one snapshot for both");
  assert.equal(model.familyStats.builds, builds + 1, "one build");
  assert.notEqual(a.v, sync.v);
  assert.deepEqual(a.rows, sync.rows, "the same rows in the same order");
  assert.equal(a.rows.length, 3000);
  assert.equal(await model.familyEntryAsync(ASSET, sync.v), sync, "a held v is still served");
  assert.equal(await model.familyEntryAsync(ASSET), a, "the current snapshot");
  assert.equal(await model.familyEntryAsync(keyN("unknown")), null);
  const kid = model.childrenOf(rootsOf[1]);
  assert.deepEqual((await model.familyEntryAsync(rootsOf[1])).rows.map((r) => r[0]).sort(), kid.map((c) => c.mint).sort(), "a coin's children");
  // ten families asked for at once (unknown mints here: each answer needs the asset families first): one pass over the coins
  model.upsertCoin({ mint: rootsOf[0], realQuoteReserves: "124000000000" }); // the cached asset families are stale now
  const values = model.coins.values;
  let passes = 0;
  model.coins.values = function () { passes++; return values.call(this); };
  const res = await Promise.all(Array.from({ length: 10 }, (_, i) => model.familyEntryAsync(keyN(`nobody-${i}`))));
  delete model.coins.values;
  assert.deepEqual(res, new Array(10).fill(null));
  assert.equal(passes, 1, "one asset-family pass shared by ten builds");
  // the same while the version moves during the pass (a trade): builds that start after the move join the pass in flight
  // rather than making their own (each version would have one with the per-version cache alone), and a snapshot made
  // from it is stamped with the pass's older version, so it does not pass for the current version's
  model.upsertCoin({ mint: rootsOf[0], realQuoteReserves: "125000000000" });
  const v0 = model.version;
  passes = 0;
  let seen = 0, late = null, priced = 0; // priced: the new version's computed() pass walks the coins too; not an asset pass
  model.coins.values = function* () {
    passes++;
    for (const c of values.call(this)) {
      if (++seen === 100) setImmediate(() => { model.upsertCoin({ mint: rootsOf[0], realQuoteReserves: "126000000000" }); const p = passes; model.computed(); priced += passes - p; late = [model.familyEntryAsync(keyN("late-1")), model.familyEntryAsync(keyN("late-2")), model.familyEntryAsync(rootsOf[2])]; });
      spin(0.005); yield c;
    }
  };
  await Promise.all(Array.from({ length: 5 }, (_, i) => model.familyEntryAsync(keyN(`early-${i}`))));
  const lateRes = await Promise.all(late ?? []);
  delete model.coins.values;
  assert.ok(late, "the late asks went out while the pass ran");
  assert.ok(model.version > v0);
  assert.equal(passes - priced, 1, "one asset-family pass for the early and the late builds");
  assert.deepEqual(lateRes.slice(0, 2), [null, null]);
  assert.equal(lateRes[2].version, v0, "the late family's snapshot carries the pass's version");
  assert.equal(await model.familyEntryAsync(rootsOf[2]), lateRes[2], "and is served as before within MAP_CACHE_MS");
});

test("share cards: cardDataAsync says what cardData says on an independent model; a stale map is rebuilt in slices, never at once; the card waits only for a table older than CARD_SHARES_MAX_AGE_MS", async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const ca = { t: 1_800_000_000_000 }, cb = { t: 1_800_000_000_000 };
  const A = buildModel({ clock: ca, assetKids: 2000 }), B = buildModel({ clock: cb, assetKids: 2000 }); // A answers at once, B in slices
  const both = (f) => { f(A, ca); f(B, cb); };
  const mints = [A.assetKidsOf[5], A.rootsOf[3], A.kidsOf[7], A.model.childrenOf(A.kidsOf[0])[0].mint];
  for (const m of mints) assert.deepEqual(await cardDataAsync(B.model, m), cardData(A.model, m), m); // the first one waited for B's map
  const first = await cardDataAsync(B.model, mints[0]);
  assert.ok(first.family.sharePct > 0 && first.bubbles.total > 2000, "the asset family's share and its 2k members");
  assert.equal(await cardDataAsync(B.model, keyN("unknown")), null);
  // the walk over the asset's 2k members gives the loop turns (the table is made by now: this is the walk alone)
  {
    const childrenOf = B.model.childrenOf;
    let calls = 0, atProbe = null;
    B.model.childrenOf = function (m) { if (++calls === 50) setImmediate(() => { atProbe = calls; }); spin(0.02); return childrenOf.call(this, m); };
    const walked = await cardDataAsync(B.model, A.assetKidsOf[6]);
    B.model.childrenOf = childrenOf;
    assert.ok(atProbe !== null && atProbe < calls, `a setImmediate queued during the walk ran before it ended (${atProbe} of ${calls})`);
    assert.deepEqual(walked, cardData(A.model, A.assetKidsOf[6]));
  }
  // callers for one mint while its data is being made share it; at most CARD_WALKS_MAX walks run at once
  {
    const childrenOf = B.model.childrenOf;
    let most = 0;
    B.model.childrenOf = function (m) { most = Math.max(most, cardWalks().running); spin(0.002); return childrenOf.call(this, m); };
    const same = [cardDataAsync(B.model, A.assetKidsOf[7]), cardDataAsync(B.model, A.assetKidsOf[7])];
    assert.equal(same[0], same[1], "one job for one mint");
    const many = A.assetKidsOf.slice(10, 16).map((m) => cardDataAsync(B.model, m));
    assert.ok(cardWalks().running + cardWalks().waiting <= 7);
    const got = await Promise.all([...same, ...many]);
    B.model.childrenOf = childrenOf;
    assert.ok(most >= 1 && most <= CARD_WALKS_MAX, `at most ${CARD_WALKS_MAX} walks at once (saw ${most})`);
    assert.deepEqual(cardWalks(), { running: 0, waiting: 0 });
    assert.ok(got.every((d) => d && d.bubbles.total > 2000));
  }
  const root = A.rootsOf[3], before = (await cardDataAsync(B.model, root)).family.sharePct;
  // the map goes stale and the family grows: B's next card neither builds the map at once nor waits for the sliced build
  both(({ model }, c) => { c.t += MAP_CACHE_MS + 1; model.upsertCoin({ mint: root, virtualQuoteReserves: "900000000000" }); });
  const want = cardData(A.model, root).family.sharePct;
  assert.ok(want > before, "the share moved");
  const syncBuild = B.model.mapAll, asyncBuild = B.model.mapAllAsync;
  let syncBuilds = 0, release, gate = null;
  B.model.mapAll = function (...a) { syncBuilds++; return syncBuild.apply(this, a); };
  B.model.mapAllAsync = function (...a) { gate ??= new Promise((r) => { release = r; }).then(() => asyncBuild.apply(this, a)); return gate; };
  assert.equal((await cardDataAsync(B.model, root)).family.sharePct, before, "served from the last table at once");
  assert.equal(syncBuilds, 0, "no synchronous map build");
  release(); await gate;
  let now = before;
  for (let i = 0; i < 500 && now !== want; i++) { await tick(); now = (await cardDataAsync(B.model, root)).family.sharePct; }
  assert.equal(now, want, "the table made from the new build reaches the next card");
  // a failed rebuild: the card is still served from the last table, and the failure goes nowhere
  const unhandled = []; const onUnhandled = (e) => unhandled.push(e); process.on("unhandledRejection", onUnhandled);
  both(({ model }, c) => { c.t += MAP_CACHE_MS + 1; model.upsertCoin({ mint: root, realQuoteReserves: "5000000000" }); });
  B.model.mapAllAsync = () => Promise.reject(new Error("map build failed"));
  assert.equal((await cardDataAsync(B.model, root)).family.sharePct, want);
  for (let i = 0; i < 20; i++) await tick();
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
  // a quiet spell: the newest table is older than CARD_SHARES_MAX_AGE_MS, so the card waits for a fresh one
  both(({ model }, c) => { c.t += CARD_SHARES_MAX_AGE_MS + 1; model.upsertCoin({ mint: root, virtualQuoteReserves: "300000000000" }); });
  gate = null;
  B.model.mapAllAsync = function (...a) { gate ??= new Promise((r) => { release = r; }).then(() => asyncBuild.apply(this, a)); return gate; };
  let settled = false;
  const waiting = cardDataAsync(B.model, root).then((d) => { settled = true; return d; });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(settled, false, "the card waits for the fresh table");
  release();
  assert.deepEqual(await waiting, cardData(A.model, root));
  B.model.mapAll = syncBuild; B.model.mapAllAsync = asyncBuild;
});
test("familySharesGen: the same table as familyShares, in steps", () => {
  const leaf = (i) => ({ coin: { mint: `m${i}`, symbol: null, mcapUsd: i, lockedUsd: i % 5 }, children: [] });
  const roots = Array.from({ length: 30 }, (_, r) => ({ coin: { mint: `r${r}`, symbol: `R${r}`, mcapUsd: r * 10, lockedUsd: 500 }, children: Array.from({ length: 200 }, (_, k) => leaf(r * 1000 + k)) }));
  for (const mode of ["mcap", "locked"]) {
    const gen = familySharesGen(roots, mode);
    let steps = 0, r;
    while (!(r = gen.next()).done) steps++;
    assert.ok(steps >= 2, `${steps} yields over ${30 * 201} nodes`);
    assert.deepEqual(r.value, familyShares(roots, mode), mode);
  }
});

test("indexer refresh: the SSE stats event comes from the sliced pass, after refresh() returned (the next tick is not held up by it)", async () => {
  const clock = { t: Date.now() };
  const { model } = buildModel({ clock, roots: 160, assetKids: 400 });
  const events = [];
  const hub = { emit: (type, data) => events.push([type, data]) };
  const rpc = { snapshot: () => ({}), getMultipleAccounts: async (keys) => keys.map(() => null) };
  const indexer = new Indexer({ rpc, model, meta: null, hub, log: quiet, opts: { backfill: false } });
  const orig = model.isOurCoin;
  model.isOurCoin = function (c) { spin(0.01); return orig.call(this, c); }; // a pass of ~30 ms over several turns
  await indexer.refresh();
  assert.equal(indexer.refreshing, false, "refresh() is over");
  assert.equal(events.filter(([t]) => t === "stats").length, 0, "while the stats pass still runs");
  for (let i = 0; i < 2000 && !events.some(([t]) => t === "stats"); i++) await new Promise((r) => setImmediate(r));
  model.isOurCoin = orig;
  const sent = events.filter(([t]) => t === "stats");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1], model.stats());
  indexer.stop();
});

test("share cards: a table made by the synchronous cardData is the async cards' newest too: a stale map then serves it at once", async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const clock = { t: 1_800_000_000_000 };
  const { model, rootsOf } = buildModel({ clock });
  cardData(model, rootsOf[1]);              // makes the build's table (tools, tests)
  await cardDataAsync(model, rootsOf[1]);   // the same build: its table, now remembered for the async cards
  clock.t += MAP_CACHE_MS + 1;
  model.upsertCoin({ mint: rootsOf[0], realQuoteReserves: "777000000000" });
  const asyncBuild = model.mapAllAsync;
  let release, gate = null;
  model.mapAllAsync = function (...a) { gate ??= new Promise((r) => { release = r; }).then(() => asyncBuild.apply(this, a)); return gate; };
  let settled = false;
  const card = cardDataAsync(model, rootsOf[2]).then((d) => { settled = true; return d; });
  for (let i = 0; i < 20 && !settled; i++) await tick();
  assert.equal(settled, true, "served from the remembered table without waiting for the map");
  release(); await gate; await card;
  model.mapAllAsync = asyncBuild;
});

test("metadata sweep: start({ slicedBoot }) runs the first sweep on the scheduler too (the server is answering by then); the default stays at once", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { model } = buildModel({ clock });
  const make = () => new MetaFetcher(model, { concurrency: 0, pacer: { fetchAny: async () => null }, log: quiet, now: () => clock.t });
  const ref = make(); ref.start({ sweepMs: 3_600_000 }); ref.stop();
  const want = ref.queue.slice(ref.head);
  assert.ok(want.length > 500, "the default: queued by the time start() returns");
  const f = make();
  f.start({ sweepMs: 3_600_000, slicedBoot: true });
  assert.equal(f.queue.length, 0, "nothing queued at once");
  assert.ok(f.sweepJob, "the sweep is on the scheduler");
  assert.equal(await f.sweepJob, want.length);
  f.stop();
  assert.deepEqual(f.queue.slice(f.head), want);
});

test("mint catch-up: the pass over every coin gives the loop turns, and picks what it picked at once", async () => {
  const clock = { t: Date.now() };
  const { model, kidsOf } = buildModel({ clock, roots: 160, assetKids: 400 });
  for (const m of kidsOf.slice(0, 40)) model.setMint({ mint: m, onchainAt: 0 }); // never read on chain: what the catch-up reads first
  const reads = [];
  const rpc = { snapshot: () => ({}), getMultipleAccounts: async (keys) => { reads.push(...keys); return keys.map(() => null); } };
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  const mint = model.mint;
  let calls = 0, ranMid = null, done = false;
  model.mint = function (m) { if (++calls === 50) setImmediate(() => { ranMid = !done; }); spin(0.005); return mint.call(this, m); };
  const out = await indexer.catchUpMintInfo();
  done = true;
  model.mint = mint;
  assert.equal(ranMid, true, "a setImmediate queued during the scan ran before it ended");
  assert.ok(out.unread >= 40, `${out.unread} unread`);
  for (const m of kidsOf.slice(0, 40)) assert.ok(reads.includes(m), "each never-read mint was read");
  indexer.stop();
});

test("logo warm list: warmImageUrlsAsync lists what warmImageUrls lists, in the same order, giving the loop turns", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { model, assetKidsOf } = buildModel({ clock, roots: 160, assetKids: 400 });
  let i = 0;
  for (const c of model.coins.values()) {
    const uri = model.mint(c.mint)?.uri;
    if (uri && i++ % 3 !== 2) model.setMeta(uri, { image: `https://ipfs.io/ipfs/img-${i % 1000}`, description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true }); // shared images too
  }
  model.setMeta("https://ipfs.io/ipfs/asset", { image: "https://ipfs.io/ipfs/asset.png", description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true });
  for (const [big, all] of [[60, true], [60, false], [0, true], [3, false]]) {
    const want = model.warmImageUrls(big, all);
    model.setSolUsd(model.solUsd + 1); // a new version: no cached asset families or drawn sets to lean on
    assert.deepEqual(await model.warmImageUrlsAsync(big, all), want, `(${big}, ${all})`);
  }
  assert.ok(model.warmImageUrls(60, true).includes("https://ipfs.io/ipfs/asset.png"), "the asset top's logo");
  const imageOfMint = model.imageOfMint;
  let calls = 0, ranMid = null, done = false;
  model.imageOfMint = function (m) { if (++calls === 50) setImmediate(() => { ranMid = !done; }); spin(0.005); return imageOfMint.call(this, m); };
  model.setSolUsd(model.solUsd + 1);
  const urls = await model.warmImageUrlsAsync(60, true);
  done = true;
  model.imageOfMint = imageOfMint;
  assert.equal(ranMid, true, "a setImmediate queued during the list ran before it ended");
  assert.deepEqual(urls, model.warmImageUrls(60, true));
  assert.ok(assetKidsOf.length > 0);
});
