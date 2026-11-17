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
