import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../lib/db.mjs";

const coin = (over = {}) => ({ mint: "M1", curve: "C1", depth: 1, quoteMint: "ROOT", creator: "CR", tracked: true, virtualTokenReserves: "1", virtualQuoteReserves: "2", realTokenReserves: "3", realQuoteReserves: "18446744073709551615", tokenTotalSupply: "1000000000000000", initialVirtualQuoteReserves: "5", complete: false, migrated: false, mayhem: false, holderReward: false, creatorFeeBps: 0, ...over });

test("schema migration is idempotent and survives reopening", () => {
  const db = new Db(":memory:");
  db.migrate(); db.migrate();
  assert.equal(db.kvGet("schema_version"), 3);
  assert.ok(db.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "fee_paid"), "v2 column present on a fresh database");
  assert.ok(db.db.prepare("PRAGMA table_info(meta)").all().some((c) => c.name === "attempts"), "v3 column present on a fresh database");
  // A v1 database (no fee_paid column, version 1) is upgraded in place.
  db.db.exec("ALTER TABLE coins DROP COLUMN fee_paid");
  db.kvSet("schema_version", 1);
  db.migrate();
  assert.equal(db.kvGet("schema_version"), 3);
  assert.ok(db.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "fee_paid"), "ALTER TABLE added the column");
  db.close();
});

test("v3: updated_at moves from seconds to milliseconds once; meta.attempts is added and round-trips", () => {
  const db = new Db(":memory:");
  db.db.exec("ALTER TABLE meta DROP COLUMN attempts");
  db.upsertCoin({ ...coin(), updatedAt: 1_792_000_000 }); // a v2 row: seconds
  db.kvSet("schema_version", 2);
  db.migrate();
  assert.equal(db.allCoins()[0].updatedAt, 1_792_000_000_000, "seconds × 1000");
  db.migrate();
  assert.equal(db.allCoins()[0].updatedAt, 1_792_000_000_000, "a second migrate leaves ms alone");
  db.touchCoin("M1", 1_792_000_000_500);
  assert.equal(db.allCoins()[0].updatedAt, 1_792_000_000_500);
  db.touchCoin("M1", 1_792_000_000_100);
  assert.equal(db.allCoins()[0].updatedAt, 1_792_000_000_500, "touch never moves the stamp backwards");
  db.metaSet({ uri: "https://ipfs.io/ipfs/x", ok: false, error: "HTTP 403", fetchedAt: 5, attempts: 3 });
  assert.equal(db.metaGet("https://ipfs.io/ipfs/x").attempts, 3);
  assert.equal(db.allMeta()[0].attempts, 3);
  db.close();
});

test("fee_paid round-trips and is never erased by a later upsert without it; the upload ledger records, lists stale rows, counts image users", () => {
  const db = new Db(":memory:");
  db.upsertCoin({ ...coin(), feePaid: "20000000" });
  db.upsertCoin({ ...coin(), feePaid: null });
  assert.equal(db.allCoins()[0].feePaid, "20000000");
  db.uploadRecord({ name: "a".repeat(64) + ".png", kind: "image", ip: "1.2.3.4", bytes: 10, at: 100 });
  db.uploadRecord({ name: "b".repeat(64) + ".json", kind: "json", pair: "a".repeat(64) + ".png", ip: "1.2.3.4", bytes: 20, at: 100 });
  db.uploadRecord({ name: "c".repeat(64) + ".json", kind: "json", pair: "a".repeat(64) + ".png", ip: "1.2.3.4", bytes: 20, at: 500 });
  assert.equal(db.uploadCount(), 3);
  assert.deepEqual(db.uploadsStale(200).map((r) => r.name[0]), ["a", "b"]);
  assert.equal(db.uploadsUsingImage("a".repeat(64) + ".png"), 2);
  db.uploadForget("b".repeat(64) + ".json");
  assert.equal(db.uploadsUsingImage("a".repeat(64) + ".png"), 1);
  db.close();
});

test("calib: a table keyed story first is rebuilt time first once, rows and outcomes kept; the time index goes; a second migrate leaves it be", () => {
  const db = new Db(":memory:");
  db.db.exec(`DROP TABLE calib; CREATE TABLE calib (
    story_key TEXT NOT NULL, t INTEGER NOT NULL, phase TEXT NOT NULL, multiple REAL, buyers5m INTEGER NOT NULL, hour_buyers INTEGER NOT NULL,
    leader_mint TEXT, leader_price_usd REAL, story_buy_usd REAL NOT NULL, buyers_1h INTEGER, price_1h REAL, filled_1h INTEGER NOT NULL DEFAULT 0,
    buyers_6h INTEGER, price_6h REAL, filled_6h INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (story_key, t)) WITHOUT ROWID;
    CREATE INDEX calib_t ON calib(t);`); // as first shipped (no cov columns yet)
  db.db.exec("INSERT INTO calib (story_key, t, phase, multiple, buyers5m, hour_buyers, leader_mint, leader_price_usd, story_buy_usd, buyers_1h, price_1h, filled_1h) VALUES ('n:1', 600, 'steady', 1.5, 3, 20, 'M', 0.5, 12.5, 7, 0.6, 1), ('p:9', 300, 'new', NULL, 1, 4, NULL, NULL, 0, NULL, NULL, 0)");
  db.migrate();
  const pk = db.db.prepare("PRAGMA table_info(calib)").all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  assert.deepEqual(pk, ["t", "story_key"]);
  const idx = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'calib' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(idx, ["calib_due1", "calib_due6"]);
  const rows = db.db.prepare("SELECT story_key, t, phase, multiple, buyers_1h, filled_1h, cov_1h FROM calib ORDER BY t").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ story_key: "p:9", t: 300, phase: "new", multiple: null, buyers_1h: null, filled_1h: 0, cov_1h: null }, { story_key: "n:1", t: 600, phase: "steady", multiple: 1.5, buyers_1h: 7, filled_1h: 1, cov_1h: null }]);
  db.migrate();
  // the database's own statements work on the rebuilt table
  assert.deepEqual(db.calibDue(1, 600, 10), [{ key: "p:9", t: 300, leaderMint: null }]);
  db.calibPut([{ key: "n:1", t: 900, phase: "rising", multiple: 2, buyers5m: 4, hourBuyers: 30, leaderMint: "M", leaderPriceUsd: 1, storyBuyUsd: 9 }]);
  db.calibFill(1, [{ key: "p:9", t: 300, buyers: 5, priceUsd: 1.1, cov: 12 }]);
  assert.deepEqual(db.calibDue(1, 900, 10), [{ key: "n:1", t: 900, leaderMint: "M" }]);
  assert.equal(db.calibTrim(1000, 10), 3);
  db.close();
});

test("calib: a script's connection (rebuild: false) leaves a story-first table and its time index as they are", () => {
  const db = new Db(":memory:", { rebuild: false });
  db.db.exec(`DROP TABLE calib; CREATE TABLE calib (
    story_key TEXT NOT NULL, t INTEGER NOT NULL, phase TEXT NOT NULL, multiple REAL, buyers5m INTEGER NOT NULL, hour_buyers INTEGER NOT NULL,
    leader_mint TEXT, leader_price_usd REAL, story_buy_usd REAL NOT NULL, buyers_1h INTEGER, price_1h REAL, filled_1h INTEGER NOT NULL DEFAULT 0,
    buyers_6h INTEGER, price_6h REAL, filled_6h INTEGER NOT NULL DEFAULT 0, cov_1h INTEGER, cov_6h INTEGER, PRIMARY KEY (story_key, t)) WITHOUT ROWID;
    CREATE INDEX calib_t ON calib(t);`);
  db.migrate();
  const pk = db.db.prepare("PRAGMA table_info(calib)").all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  assert.deepEqual(pk, ["story_key", "t"]);
  assert.ok(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'calib_t'").get(), "its trim's index stays");
  db.close();
});

test("storyTrim: rows older than the cut go an hour window at a time from the oldest, story by story; 0 when none is left", () => {
  const db = new Db(":memory:");
  const rows = [];
  for (let h = 0; h < 3; h++) for (let b = 0; b < 12; b++) for (const key of ["n:1", "n:2", "p:3"]) rows.push({ key, t: h * 3600 + b * 300, buyers: 1, siteBuyers: 10, coins: 1 });
  rows.push({ key: "n:1", t: 4 * 3600, buyers: 1, siteBuyers: 10, coins: 1 }); // newer than the cut
  db.storyBucketsPut(rows);
  const cut = 3 * 3600;
  const steps = [];
  for (let got; (got = db.storyTrim(cut, 20)) > 0;) steps.push(got);
  assert.equal(steps.reduce((a, b) => a + b, 0), 108, "every expired row");
  assert.ok(steps.length >= 6, `in steps of at most 20 (${steps.join(",")})`);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM story_buckets").get().n, 1, "the newer row stays");
  assert.equal(db.storyTrim(cut, 20), 0);
  db.close();
});

test("launcher: the column is added to a database from before it, round-trips and is never erased by an upsert without it", () => {
  const db = new Db(":memory:");
  assert.ok(db.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "launcher"), "present on a fresh database");
  db.db.exec("ALTER TABLE coins DROP COLUMN launcher");
  db.db.exec("INSERT INTO coins (mint, curve, depth, creator) VALUES ('OLD', 'C0', 0, 'PDA')"); // a row from before
  db.migrate(); db.migrate();
  assert.equal(db.db.prepare("PRAGMA table_info(coins)").all().filter((c) => c.name === "launcher").length, 1);
  const fresh = new Db(":memory:"); // the statements are prepared against the migrated table
  fresh.db.exec("INSERT INTO coins (mint, curve, depth, creator) VALUES ('OLD', 'C0', 0, 'PDA')");
  assert.equal(fresh.allCoins()[0].launcher, null);
  fresh.upsertCoin({ ...coin(), launcher: "WALLET" });
  fresh.upsertCoin({ ...coin(), creator: "PDA" }); // a curve re-read: another creator, no launcher
  const c = fresh.allCoins().find((x) => x.mint === "M1");
  assert.equal(c.launcher, "WALLET"); assert.equal(c.creator, "PDA");
  db.close(); fresh.close();
});

test("coins round-trip with u64 precision and merge on conflict", () => {
  const db = new Db(":memory:");
  db.upsertCoin(coin());
  db.upsertCoin({ ...coin(), createdAt: 1700000000, shares: [{ address: "A", bps: 10000 }], sharesAt: 5 });
  db.upsertCoin({ ...coin(), createdAt: null, shares: null, sharesAt: 0, tracked: false }); // nulls do not erase, tracked does not turn off
  const [c] = db.allCoins();
  assert.equal(c.realQuoteReserves, "18446744073709551615");
  assert.equal(c.createdAt, 1700000000);
  assert.deepEqual(c.shares, [{ address: "A", bps: 10000 }]);
  assert.equal(c.sharesAt, 5);
  assert.equal(c.tracked, true);
  db.close();
});

test("mints merge field by field", () => {
  const db = new Db(":memory:");
  db.upsertMint({ mint: "M1", decimals: 6, tokenProgram: "T" });
  db.upsertMint({ mint: "M1", name: "Spore", symbol: "SPORE", uri: "https://ipfs.io/x", onchainAt: 10 });
  const [m] = db.allMints();
  assert.deepEqual(m, { mint: "M1", decimals: 6, tokenProgram: "T", supply: null, name: "Spore", symbol: "SPORE", uri: "https://ipfs.io/x", onchainAt: 10 });
  db.close();
});

test("trades: dedupe on (sig, mint, idx), 24 h volume, trimming to the cap", () => {
  const db = new Db(":memory:");
  const now = Math.floor(Date.now() / 1000);
  const t = (i, over = {}) => ({ sig: `S${i}`, mint: "M1", idx: 0, slot: i, time: now - i, isBuy: i % 2 === 0, user: "U", baseAmount: "10", quoteAmount: "20", priceQuote: 2, priceUsd: 3, valueUsd: 1.5, ...over });
  db.insertTrade(t(1)); db.insertTrade(t(1));
  db.insertTrade(t(2, { time: now - 90_000 })); // older than 24 h
  assert.equal(db.tradesFor("M1", 50).length, 2);
  assert.deepEqual(db.volume24h("M1"), { trades: 1, usd: 1.5 });
  assert.equal(db.volume24hAll().get("M1").trades, 1);
  for (let i = 3; i < 2300; i++) db.insertTrade(t(i), 2000);
  assert.equal(db.tradesFor("M1", 5000).length, 2298, "the last 24 h are kept past the cap (the boot seed of the 24 h counters reads them)");
  assert.equal(db.tradesSince("M1", now - 10).length, 9); // S1, S3..S10 (S2 is the day-old one)
  // older than 24 h: only what fits in the newest `keep` rows stays; the trim runs once per 200 new rows
  const old = (i) => ({ ...t(i), sig: `O${i}`, mint: "M2", time: now - 100_000 - i });
  for (let i = 0; i < 2600; i++) db.insertTrade(old(i), 2000);
  const kept = db.tradesFor("M2", 5000);
  assert.ok(kept.length >= 2000 && kept.length < 2200, String(kept.length));
  assert.equal(kept[0].sig, "O0", "the newest stay");
  // a hard ceiling whatever the age
  for (let i = 0; i < 1000; i++) db.insertTrade({ ...t(i), sig: `H${i}`, mint: "M3" }, 100, { max: 300 });
  const hard = db.tradesFor("M3", 5000).length;
  assert.ok(hard >= 300 && hard < 500, String(hard));
  // the window read is an iterator in time order
  const win = db.tradesWindow(now - 86_400);
  assert.equal(typeof win.next, "function");
  let prev = 0, n = 0;
  for (const r of win) { assert.ok(r.time >= prev); prev = r.time; n++; }
  assert.equal(n, 2298 + hard);
  db.close();
});

test("backfill staging: priority order and resolution state", () => {
  const db = new Db(":memory:");
  db.backfillCurveUpsert({ curve: "small", depth: 1, quoteMint: "R", data: "AA==", graduated: false, rq: 10 });
  db.backfillCurveUpsert({ curve: "big", depth: 1, quoteMint: "R", data: "AA==", graduated: false, rq: 1e9 });
  db.backfillCurveUpsert({ curve: "deep", depth: 2, quoteMint: "P", data: "AA==", graduated: false, rq: 1e9 });
  db.backfillCurveUpsert({ curve: "grad", depth: 1, quoteMint: "R", data: "AA==", graduated: true, rq: 0 });
  assert.deepEqual(db.backfillPending(10).map((r) => r.curve), ["grad", "deep", "big", "small"]);
  db.backfillResolve("grad", "MINT");
  db.backfillFail("small", "no token account");
  assert.deepEqual(db.backfillStats(), { total: 4, resolved: 1, failed: 1 });
  assert.deepEqual(db.backfillPending(10).map((r) => r.curve), ["deep", "big"]);
  assert.equal(db.backfillCurve("grad").mint, "MINT");
  db.backfillSet("scanned:1", 123); assert.equal(db.backfillGet("scanned:1"), 123);
  db.close();
});

test("metadata cache round-trips", () => {
  const db = new Db(":memory:");
  db.metaSet({ uri: "https://ipfs.io/x", image: "https://ipfs.io/i", description: "d", fetchedAt: 1, ok: true });
  assert.equal(db.metaGet("https://ipfs.io/x").image, "https://ipfs.io/i");
  assert.equal(db.allMeta().length, 1);
  db.close();
});

test("chart pages: tradesRange is [from, to) in (time, slot, rowid) order; tradeTimeBefore is strict; histDeep returns rows over the byte bound that are old or past the newest `keep`", () => {
  const db = new Db(":memory:");
  const t = (sig, time, slot, mint = "M1") => db.insertTrade({ sig, mint, idx: 0, slot, time, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd: 1 });
  t("c", 200, 5); t("a", 200, 3); t("b", 100, 9); t("d", 300, 1); t("e", 199, 1); t("x", 150, 1, "M2");
  assert.deepEqual(db.tradesRange("M1", 100, 300).map((r) => r.sig), ["b", "e", "a", "c"], "300 is out; one second ordered by slot");
  assert.deepEqual(db.tradesRange("M1", 101, 200).map((r) => r.sig), ["e"]);
  assert.equal(db.tradesRange("M1", 100, 300)[0].time, 100);
  assert.equal(db.tradeTimeBefore("M1", 200), 199);
  assert.equal(db.tradeTimeBefore("M1", 199), 100, "strictly before");
  assert.equal(db.tradeTimeBefore("M1", 100), null);
  const row = (mint, askedAt, n) => db.histSet({ mint, res: 300, unit: "usd", state: "ok", pools: [], covFrom: 0, covTo: 0, fetchedAt: askedAt, askedAt, data: Array.from({ length: n }, (_, i) => [i * 300, 1, 1, 1, 1, 1]) });
  row("OLD", 10, 50); row("A", 1000, 50); row("B", 2000, 50); row("C", 3000, 50); row("SHALLOW", 5, 2);
  const keys = (r) => r.map((x) => x.mint).sort();
  assert.deepEqual(keys(db.histDeep(100, 2, 500)), ["A", "OLD"], "OLD asked before 500; A past the newest 2 deep rows (C, B)");
  assert.deepEqual(keys(db.histDeep(100, 10, 0)), [], "all within keep and recent");
  assert.deepEqual(keys(db.histDeep(100, 10, 1500)), ["A", "OLD"]);
  assert.deepEqual(db.histDeep(100, 0, 0).length, 4, "keep 0: every deep row; the shallow one never");
  // the bound is in bytes, read from the record header (octet_length), never by loading each value (length() of TEXT)
  db.histSet({ mint: "WIDE", res: 300, unit: "usd", state: "ok", pools: [], covFrom: 0, covTo: 0, fetchedAt: 1, askedAt: 1, data: '["' + "é".repeat(60) + '"]' });
  assert.ok(keys(db.histDeep(100, 10, 500)).includes("WIDE"), "124 bytes, 64 characters: over 100 bytes");
  assert.doesNotMatch(db.q.histDeep.sourceSQL, /(^|[^_])length\(/);
  db.close();
});

test("name waves: the tables exist; counts, hours, launches, waves, coins, candidacies, hours and tests round-trip; trims go oldest first in chunks; a pending coin is decided once", () => {
  const db = new Db(":memory:");
  const tables = new Set(db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  for (const t of ["name_hours", "name_counts", "wave_launches", "waves", "wave_coins", "wave_cands", "wave_hours", "wave_tests"]) assert.ok(tables.has(t), t);
  assert.equal(db.nameCountsPut([[10, "veto", 3, 4, 4], [10, "veto", 9, 9, 9], [11, "cat", 1, 1, 0]]), 2, "insert-only");
  assert.equal(db.nameHourPut({ h: 10, launches: 150, creators: 90, partial: 0 }), true);
  assert.equal(db.nameHourPut({ h: 10, launches: 1, creators: 1, partial: 1 }), false, "an hour row is written once");
  assert.deepEqual(db.nameHoursIn(0, 20).map((r) => [r.h, r.partial, r.src]), [[10, 0, 0]]);
  db.waveLaunchesPut([[100, "M1", 100_000, "C1", "Mr Veto", "VETO", "veto:w", 5], [200, "M2", 200_000, "C2", "Veto Cat", "", "veto:w,cat:w", 5]]);
  assert.deepEqual(db.waveLaunchesSince(150).map((r) => [r.mint, r.feats, r.seen, r.bh]), [["M2", "veto:w,cat:w", 200_000, 5]]);
  assert.equal(db.wavePut({ key: "w:word-veto-20261118", feature: "veto", kind: "word", v: 1, formedT: 100, formedAt: 100, win: 21600, n: 5, ctx: 4, e: 0.01, r: 0.002, tail: 1e-9, share0: 1e-6, cMissing: false, cBase: 2, why: { a: 1 } }), true);
  db.waveUpdate({ key: "w:word-veto-20261118", lastT: 300, members: 7, why: { a: 2 } });
  assert.deepEqual(db.wavesOpen().map((w) => [w.key, w.members, w.lastT, w.cMissing, w.why.a]), [["w:word-veto-20261118", 7, 300, false, 2]]);
  db.waveUpdate({ key: "w:word-veto-20261118", lastT: 300, endedT: 400, members: 7, why: {} });
  assert.deepEqual([db.wavesOpen().length, db.wavesRecent(350).length, db.wavesRecent(500).length], [0, 1, 0]);
  assert.equal(db.waveCoinPut({ mint: "M1", t: 100, reason: "pending", cands: [{ key: "k", r: 0.2, how: "w" }] }), true);
  assert.equal(db.waveCoinPut({ mint: "M1", t: 100, reason: "lexical", waveKey: "other" }), false, "a coin's first row stands");
  assert.equal(db.waveCoinCands("M1", [{ key: "k" }, { key: "k2" }]), true);
  assert.equal(db.waveCoinsPending()[0].cands.length, 2);
  assert.equal(db.waveCoinDecide({ mint: "M1", waveKey: "k", reason: "tag", why: { held: 1 } }), true);
  assert.equal(db.waveCoinDecide({ mint: "M1", waveKey: "k2", reason: "post" }), false, "decided once");
  assert.deepEqual([db.waveCoinGet("M1").wave_key, db.waveCoinGet("M1").reason, db.waveCoinsPending().length], ["k", "tag", 0]);
  assert.equal(db.waveCandPut("M1", "k", 0.2, "w", 100), true); assert.equal(db.waveCandPut("M1", "k", 0.3, "w", 100), false);
  assert.equal(db.waveHourPut({ h: 10, key: "k", n6: 5, members: 3 }), true);
  assert.equal(db.waveTestPut({ h: 10, feature: "veto", v: 1, n: 5, fail: "ctx", cMissing: true }), true);
  for (let i = 0; i < 5; i++) db.waveCoinPut({ mint: `old${i}`, t: i, reason: "lexical", waveKey: "k" });
  const steps = [];
  for (let n; (n = db.waveCoinsTrim(50, 2)) > 0;) steps.push(n);
  assert.deepEqual(steps, [2, 2, 1]);
  assert.equal(db.nameCountsTrim(11, 10), 1); assert.equal(db.nameHoursTrim(11, 10), 1);
  assert.equal(db.waveLaunchesTrim(150, 10), 1); assert.equal(db.waveCandsTrim(150, 10), 1); assert.equal(db.waveHoursTrim(11, 10), 1); assert.equal(db.waveTestsTrim(11, 10), 1); assert.equal(db.wavesTrim(500, 10), 1);
  db.close();
});
