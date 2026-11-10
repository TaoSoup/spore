// Mint records (name, symbol, metadata uri) read soon after a coin is stored, not after the whole backfill
// drains: each resolved backfill batch reads its own unread mints, a failed read never stops resolveCurves,
// the periodic catch-up reads what is left (bounded, biggest families first), and the rolling refresh's
// cursor survives a restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer, REFRESH_CURSOR_KEY } from "../lib/indexer.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { K, PLATFORM, T22, base, quiet } from "./helpers/tree.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/accounts.json", import.meta.url), "utf8")).accounts;
const MINT_DATA = Buffer.from(fixture.mint.data, "base64"); // Token-2022 mint with its metadata extension (name "ponzi")
const MINT_URI = "https://m.rapidlaunch.io/m/uQhFx7h80";
const nowS = () => Math.floor(Date.now() / 1000);
/** A distinct, valid base58 key per (tag, i). */
const key = (tag, i) => new PublicKey(Buffer.from([tag, i & 255, i >> 8, ...Array(29).fill(9)])).toBase58();
/** The fixture curve, re-stamped as a depth-1 curve quoted in K.ROOT. */
const curveData = (() => { const raw = Buffer.from(fixture.curve.data, "base64"); raw[141] = 1; new PublicKey(K.ROOT).toBuffer().copy(raw, 83); return raw.toString("base64"); })();
const newModel = (db) => { const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet }); m.load(); return m; };
const coin = (mint, extra = {}) => ({ mint, curve: `c-${mint}`, depth: 0, quoteMint: null, tracked: true, virtualQuoteReserves: "1", realQuoteReserves: "0", ...base, ...extra });
const logger = () => { const lines = { info: [], warn: [] }; return { lines, log: { info: (s) => lines.info.push(s), warn: (s) => lines.warn.push(s), error: (s) => lines.warn.push(s) } }; };

/**
 * A backfill on a fake chain: `n` staged curves whose base token account holds mint i; every key the
 * fake knows as a mint answers with the fixture mint account. `events` records the call order.
 */
function setup(n, { failMints = () => false } = {}) {
  const db = new Db(":memory:");
  const model = newModel(db);
  model.upsertCoin(coin(K.ROOT, { curve: key(250, 1) }));
  model.setMint({ mint: K.ROOT, decimals: 6, tokenProgram: T22, name: "root", symbol: "ROOT", uri: "https://ipfs.io/ipfs/ROOT", onchainAt: 1 });
  const curves = Array.from({ length: n }, (_, i) => key(1, i)), mintOf = new Map(curves.map((c, i) => [c, key(2, i)]));
  for (const c of curves) db.backfillCurveUpsert({ curve: c, depth: 1, quoteMint: K.ROOT, data: curveData, graduated: false, rq: 0 });
  const mints = new Set([...mintOf.values(), K.ROOT]);
  const events = [], reads = [], requested = [];
  const rpc = {
    concurrency: 3, snapshot: () => ({}),
    getTokenAccountsByOwner: async (owner, programId) => { events.push(`tok:${owner}`); return mintOf.has(owner) ? [{ pubkey: "ta", mint: mintOf.get(owner), amount: "1", tokenProgram: programId }] : []; },
    getMultipleAccounts: async (keys) => {
      events.push("read"); reads.push(keys);
      if (keys.some((k) => mints.has(k)) && failMints()) throw new Error("429 Too Many Requests");
      return keys.map((k) => (mints.has(k) ? { owner: T22, lamports: 1, data: MINT_DATA, executable: false } : null));
    },
  };
  const meta = { request: (uri) => requested.push(uri) };
  const { lines, log } = logger();
  const indexer = new Indexer({ rpc, model, meta, hub: null, log, opts: { backfill: true, createdAtProbe: false } });
  return { db, model, indexer, curves, mintOf, events, reads, requested, lines };
}

test("a resolved backfill batch reads the mint records of exactly its unread mints and queues their metadata", async () => {
  const { db, model, indexer, curves, mintOf, reads, requested } = setup(4);
  // Row 3 is a coin the live stream already brought in with its record read; row 4 a coin known without one.
  const [, , c3, c4] = curves, m3 = mintOf.get(c3), m4 = mintOf.get(c4);
  model.upsertCoin(coin(m3, { curve: c3, depth: 1, quoteMint: K.ROOT }));
  model.setMint({ mint: m3, decimals: 6, tokenProgram: T22, name: "three", symbol: "THREE", uri: "https://ipfs.io/ipfs/THREE", onchainAt: 5 });
  model.upsertCoin(coin(m4, { curve: c4, depth: 1, quoteMint: K.ROOT }));
  await indexer.resolveCurves();
  assert.equal(db.backfillStats().resolved, 4);
  assert.equal(reads.length, 1, "one getMultipleAccounts for the batch (all Token-2022: no Metaplex round)");
  assert.deepEqual([...reads[0]].sort(), [mintOf.get(curves[0]), mintOf.get(curves[1]), m4].sort(), "the unread mints, not the read one, not the read parent");
  for (const m of [mintOf.get(curves[0]), mintOf.get(curves[1]), m4]) {
    const info = model.mint(m);
    assert.equal(info.name, "ponzi"); assert.equal(info.uri, MINT_URI); assert.equal(info.decimals, 6); assert.ok(info.onchainAt > 0);
  }
  assert.equal(model.mint(m3).name, "three", "the read record is untouched");
  assert.ok(requested.includes(MINT_URI), "the uri went to the metadata fetcher");
  assert.equal(indexer.state.mints.batchRead, 3);
  db.close();
});

test("each batch's mint read runs before the next batch is resolved", async () => {
  const { db, indexer, events, reads } = setup(55);
  await indexer.resolveCurves();
  assert.equal(db.backfillStats().resolved, 55);
  assert.deepEqual(reads.map((k) => k.length), [50, 5], "one read per batch of 50");
  const first = events.indexOf("read");
  assert.equal(events.slice(0, first).filter((e) => e.startsWith("tok:")).length, 50, "the first read follows the first batch");
  assert.equal(events.slice(first).filter((e) => e.startsWith("tok:")).length, 5, "and comes before the second batch");
  assert.equal(events.at(-1), "read");
  db.close();
});

test("a failing mint read is logged and does not stop resolveCurves; the catch-up reads those mints later", async () => {
  let failing = true;
  const { db, model, indexer, mintOf, lines } = setup(55, { failMints: () => failing });
  await indexer.resolveCurves();
  assert.equal(db.backfillStats().resolved, 55, "every curve resolved");
  for (const m of mintOf.values()) assert.ok(model.get(m)?.tracked, "every coin stored");
  assert.equal(lines.warn.filter((l) => l.includes("left to the catch-up")).length, 2, "one warning per failed batch read");
  assert.equal(indexer.state.mints.batchFailed, 55); assert.equal(indexer.state.mints.batchRead, 0);
  assert.ok([...mintOf.values()].every((m) => !model.mint(m)?.onchainAt), "nothing stamped as read");
  failing = false;
  const r = await indexer.catchUpMintInfo();
  assert.equal(r.unread, 55); assert.equal(r.read, 55); assert.equal(r.withUri, 55);
  assert.ok([...mintOf.values()].every((m) => model.mint(m).uri === MINT_URI));
  db.close();
});

test("the catch-up picks unread coins (a listed asset first, then the biggest families), never read ones before a uri-less retry, and is bounded", async () => {
  const db = new Db(":memory:");
  const model = newModel(db);
  const ASSET = K.S;
  const R1 = key(10, 0), kids1 = [1, 2, 3].map((i) => key(10, i)), R2 = key(11, 0), kid2 = key(11, 1);
  const Q = key(12, 0), READ = key(13, 0), UNTRACKED = key(14, 0), OLD = key(15, 0), RECENT = key(16, 0);
  model.upsertCoin(coin(R2)); model.upsertCoin(coin(kid2, { depth: 1, quoteMint: R2 }));
  model.upsertCoin(coin(Q, { quoteMint: ASSET })); // depth 0, quoted in a listed asset: ASSET tops a family
  model.upsertCoin(coin(R1)); for (const k of kids1) model.upsertCoin(coin(k, { depth: 1, quoteMint: R1 }));
  model.upsertCoin(coin(READ)); model.setMint({ mint: READ, decimals: 6, tokenProgram: T22, uri: "https://ipfs.io/ipfs/R", onchainAt: 9 });
  model.upsertCoin(coin(UNTRACKED, { tracked: false }));
  model.upsertCoin(coin(OLD)); model.setMint({ mint: OLD, decimals: 6, tokenProgram: T22, onchainAt: nowS() - 2 * 86_400 });
  model.upsertCoin(coin(RECENT)); model.setMint({ mint: RECENT, decimals: 6, tokenProgram: T22, onchainAt: nowS() - 60 });
  model.setMint({ mint: kids1[0], tokenProgram: T22 }); // what resolveOne leaves: a row, never read
  const reads = [];
  const rpc = { snapshot: () => ({}), getMultipleAccounts: async (keys) => { reads.push(keys); return keys.map(() => ({ owner: T22, lamports: 1, data: MINT_DATA, executable: false })); } };
  const { lines, log } = logger();
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log, opts: { backfill: false } });

  const a = await indexer.catchUpMintInfo({ max: 3 });
  assert.equal(a.unread, 8, "the asset, R1's family (4), R2's (2) and Q; not READ, UNTRACKED, OLD or RECENT"); assert.equal(a.noUri, 1, "OLD only: RECENT was read a minute ago");
  assert.equal(a.read, 3);
  assert.deepEqual(reads, [[ASSET, R1, kids1[0]]], "the asset's own mint, then the biggest family, top first");
  assert.equal(lines.info.length, 1); assert.match(lines.info[0], /^mints: catch-up: 3\/3 read \(8 never read, 1 without a uri\), 3 with a uri/);
  assert.equal(indexer.state.mints.unread, 5);

  reads.length = 0;
  const b = await indexer.catchUpMintInfo({ max: 100 });
  assert.equal(b.unread, 5); assert.equal(b.noUri, 1); assert.equal(b.read, 6);
  assert.deepEqual(reads, [[kids1[1], kids1[2], R2, kid2, Q, OLD]], "the rest of R1's family, then R2's, then the childless coin, then the uri-less retry");
  assert.equal(model.mint(OLD).uri, MINT_URI);
  for (const m of [UNTRACKED, READ, RECENT]) assert.ok(!reads.flat().includes(m));

  assert.equal(indexer.state.mints.unread, 0);

  reads.length = 0; lines.info.length = 0;
  const c = await indexer.catchUpMintInfo({ max: 100 });
  assert.equal(c.unread, 0); assert.equal(c.read, 0); assert.equal(reads.length, 0, "nothing left: no call");
  assert.deepEqual(lines.info, [], "silent: the last run already left nothing");
  // A fresh process says once that there is nothing to do, then stays quiet.
  const again = new Indexer({ rpc, model, meta: null, hub: null, log, opts: { backfill: false } });
  await again.catchUpMintInfo(); await again.catchUpMintInfo();
  assert.deepEqual(lines.info, ["mints: catch-up: every mint record read"]);
  assert.equal(reads.length, 0);
  db.close();
});

test("the catch-up reads at most mintCatchupMax mints per run, 100 per call, and one run at a time", async () => {
  const db = new Db(":memory:");
  const model = newModel(db);
  const all = Array.from({ length: 2_500 }, (_, i) => key(20, i));
  db.transaction(() => { for (const m of all) model.upsertCoin(coin(m)); });
  const reads = [];
  const rpc = { snapshot: () => ({}), getMultipleAccounts: async (keys) => { reads.push(keys.length); await new Promise((r) => setImmediate(r)); return keys.map(() => ({ owner: T22, lamports: 1, data: MINT_DATA, executable: false })); } };
  const { lines, log } = logger();
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log, opts: { backfill: false } });
  const [first, overlapping] = await Promise.all([indexer.catchUpMintInfo(), indexer.catchUpMintInfo()]);
  assert.equal(overlapping, null, "a second run while one is going does nothing");
  assert.equal(first.unread, 2_500); assert.equal(first.read, 2_000);
  assert.deepEqual(reads, Array(20).fill(100));
  reads.length = 0;
  const second = await indexer.catchUpMintInfo();
  assert.equal(second.unread, 500); assert.equal(second.read, 500); assert.deepEqual(reads, Array(5).fill(100));
  assert.equal(lines.info.filter((l) => l.startsWith("mints: catch-up:")).length, 2, "one line per run");
  assert.ok(all.every((m) => model.mint(m).uri === MINT_URI));
  db.close();
});

test("the whole-index mint read (backfill:mints, the asset walk) and the catch-up never read the same mints twice (repair 2026-11-10)", async () => {
  const fresh = () => {
    const db = new Db(":memory:");
    const model = newModel(db);
    const all = Array.from({ length: 2_500 }, (_, i) => key(40, i));
    db.transaction(() => { for (const m of all) model.upsertCoin(coin(m)); });
    const known = new Set(all), reads = new Map(), hooks = { onRead: null };
    const rpc = {
      snapshot: () => ({}),
      getMultipleAccounts: async (keys) => {
        if (keys.some((k) => known.has(k))) { for (const k of keys) reads.set(k, (reads.get(k) ?? 0) + 1); const h = hooks.onRead; hooks.onRead = null; await h?.(); }
        await new Promise((r) => setImmediate(r));
        return keys.map((k) => (known.has(k) ? { owner: T22, lamports: 1, data: MINT_DATA, executable: false } : null));
      },
    };
    const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: true, createdAtProbe: false } });
    return { db, model, all, reads, hooks, indexer };
  };
  const once = (reads, n) => { assert.equal(reads.size, n); assert.ok([...reads.values()].every((x) => x === 1), "no mint read twice"); };

  // the backfill's "backfill:mints" phase: a catch-up timer that fires meanwhile does nothing
  {
    const { db, all, reads, hooks, indexer } = fresh();
    let during = "not called", phase = null;
    hooks.onRead = async () => { phase = indexer.state.phase; during = await indexer.catchUpMintInfo(); };
    await indexer.runBackfill();
    assert.equal(phase, "backfill:mints"); assert.equal(during, null, "the catch-up skipped while the whole-index read ran");
    once(reads, all.length);
    assert.equal(indexer.mintCatchingUp, false, "the lane is free again");
    const after = await indexer.catchUpMintInfo();
    assert.equal(after.unread, 0); assert.equal(reads.size, all.length);
    db.close();
  }
  // a catch-up already running when the whole-index read starts: the read waits for it and reads only what is left
  {
    const { db, model, all, reads, indexer } = fresh();
    const order = [];
    const cu = indexer.catchUpMintInfo().then((r) => { order.push("catch-up"); return r; });
    assert.equal(indexer.mintCatchingUp, true);
    const whole = indexer.ensureAllMintInfo().then(() => order.push("whole"));
    assert.equal(await indexer.catchUpMintInfo(), null, "one run at a time");
    const [r] = await Promise.all([cu, whole]);
    assert.equal(r.read, 2_000); assert.deepEqual(order, ["catch-up", "whole"]);
    once(reads, all.length);
    assert.ok(all.every((m) => model.mint(m).uri === MINT_URI));
    assert.equal(indexer.mintCatchingUp, false); assert.equal(indexer.mintRun, null);
    db.close();
  }
  // a failing whole-index read frees the lane too
  {
    const { db, indexer, hooks } = fresh();
    hooks.onRead = async () => { throw new Error("429 Too Many Requests"); };
    await assert.rejects(() => indexer.ensureAllMintInfo(), /429/);
    assert.equal(indexer.mintCatchingUp, false);
    assert.equal((await indexer.catchUpMintInfo()).read, 2_000, "the catch-up takes over");
    db.close();
  }
});

test("the refresh cursor survives a re-created Indexer and a reloaded model, and starts a new pass when the list got shorter", async () => {
  const db = new Db(":memory:");
  const model = newModel(db);
  const mints = Array.from({ length: 120 }, (_, i) => key(30, i));
  const curveOf = (i) => `curve-${i}`;
  db.transaction(() => { mints.forEach((m, i) => model.upsertCoin(coin(m, { curve: curveOf(i) }))); });
  const starts = [];
  const rpc = { snapshot: () => ({}), getMultipleAccounts: async (keys) => { if (String(keys[0]).startsWith("curve-")) starts.push(Number(keys[0].slice(6))); return keys.map(() => null); } };
  const make = (m) => new Indexer({ rpc, model: m, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  const one = make(model);
  await one.refresh(); await one.refresh();
  assert.deepEqual(starts, [0, 50], "50 coins per tick");
  assert.deepEqual(db.backfillGet(REFRESH_CURSOR_KEY), { i: 100, mint: mints[100] });

  // A restart: a new model loaded from the same db, a new Indexer.
  const two = make(newModel(db));
  await two.refresh();
  assert.deepEqual(starts, [0, 50, 100], "picks up where the last run stopped");
  assert.deepEqual(db.backfillGet(REFRESH_CURSOR_KEY), { i: 30, mint: mints[30] }, "wrapped past the end");

  // The saved mint wins over the saved index (coins evicted before it shift indexes) ...
  db.backfillSet(REFRESH_CURSOR_KEY, { i: 5, mint: mints[80] });
  await make(model).refresh();
  assert.equal(starts.at(-1), 80);
  // ... the index is the fallback while it is inside the list ...
  db.backfillSet(REFRESH_CURSOR_KEY, { i: 70, mint: "gone" });
  await make(model).refresh();
  assert.equal(starts.at(-1), 70);
  // ... and a list shorter than the saved index starts a new pass.
  db.backfillSet(REFRESH_CURSOR_KEY, { i: 500, mint: "gone" });
  await make(model).refresh();
  assert.equal(starts.at(-1), 0);
  db.backfillSet(REFRESH_CURSOR_KEY, "junk");
  await make(model).refresh();
  assert.equal(starts.at(-1), 0, "an unreadable cursor is a new pass");
  db.close();
});
