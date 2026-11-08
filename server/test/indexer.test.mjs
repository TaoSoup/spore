// Indexer paths that need no chain: adopting a verified spawn from its CreateEvent (roots included),
// the fetchCoin verdict cache and the RPC lane a request-driven lookup runs on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer } from "../lib/indexer.mjs";
import { decodeEvent, eventsInLogs } from "../lib/decode.mjs";
import { createTxFor } from "./helpers/spawntx.mjs";
import { K, PLATFORM, quiet } from "./helpers/tree.mjs";

const createEventFor = (mint) => decodeEvent("CreateEvent", eventsInLogs(createTxFor({ mint }).meta.logMessages).find((e) => e.name === "CreateEvent").data);
/** An RPC that knows no accounts, counting calls per lane. */
const fakeRpc = () => {
  const calls = { main: 0, api: 0 };
  const rpc = { getMultipleAccounts: async (keys) => { calls.main++; return keys.map(() => null); }, snapshot: () => ({}) };
  rpc.lane = () => ({ getMultipleAccounts: async (keys) => { calls.api++; return keys.map(() => null); } });
  return { rpc, calls };
};

test("adopt inserts a verified spawn from its CreateEvent, tracked at any depth, with the fee it paid, and announces it once pending", async () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "ours", log: quiet });
  model.load();
  const events = [];
  const { rpc, calls } = fakeRpc();
  const indexer = new Indexer({ rpc, model, meta: null, hub: { emit: (ev, data) => events.push([ev, data]) }, log: quiet, opts: { backfill: false } });
  const create = createEventFor(K.X);
  // A root: the event says depth 2 here (real bytes), but the point is that adopt does not gate on depth.
  model.markPending(K.X, "sig", { feePaid: "20000000" });
  const c = await indexer.adopt(K.X, { create, slot: 123, feePaid: 20_000_000n });
  assert.ok(c); assert.equal(c.tracked, true); assert.equal(c.feePaid, "20000000"); assert.equal(c.createdSlot, 123); assert.equal(c.createdAt, create.timestamp);
  assert.equal(c.quoteMint, create.quoteMint); assert.equal(c.curve, create.bondingCurve); assert.equal(c.creator, create.creator);
  assert.equal(model.nameOf(K.X).symbol, "ponzi");
  assert.equal(model.mint(K.X).uri, create.uri);
  assert.equal(db.allCoins().find((x) => x.mint === K.X).feePaid, "20000000", "persisted (tracked)");
  assert.deepEqual(model.oursOf(c), { ours: false, oursPending: true });
  assert.equal(events.length, 1); assert.equal(events[0][0], "coin"); assert.equal(events[0][1].mint, K.X); assert.equal(events[0][1].feePaid, "20000000");
  assert.ok(indexer.hot.has(K.X));
  assert.ok(calls.main >= 1, "ancestors / mint info / shares were looked up on the main lane"); assert.equal(calls.api, 0);
  // Without an event and no curve on chain: nothing to adopt.
  assert.equal(await indexer.adopt(K.U), null);
  db.close();
});

test("fetchCoin remembers a negative verdict for a minute and runs on the lane it is given", async () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], log: quiet });
  model.load();
  const { rpc, calls } = fakeRpc();
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  assert.equal(await indexer.fetchCoin(K.U, { rpc: rpc.lane("api") }), null);
  assert.equal(await indexer.fetchCoin(K.U, { rpc: rpc.lane("api") }), null);
  assert.equal(await indexer.fetchCoin(K.U), null);
  assert.deepEqual(calls, { main: 0, api: 1 }, "one lookup, on the api lane, then the cache");
  indexer.fetchCache.clear();
  await indexer.fetchCoin(K.U);
  assert.deepEqual(calls, { main: 1, api: 1 });
  db.close();
});

// ---- coins quoted in a listed asset (USDC, PUMP, MON, …): depth 0 on chain, drawn under the asset's bubble
import { readFileSync } from "node:fs";
import { PublicKey } from "../lib/sdk.mjs";
import { base } from "./helpers/tree.mjs";
const fixtureAccounts = JSON.parse(readFileSync(new URL("./fixtures/accounts.json", import.meta.url), "utf8")).accounts;

test("a depth-0 CreateEvent quoted in a listed asset joins the tree under the asset and goes out as a pair; a SOL-quoted root is ignored", async () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  model.load();
  const events = [];
  const { rpc } = fakeRpc();
  const indexer = new Indexer({ rpc, model, meta: null, hub: { emit: (ev, data) => events.push([ev, data]) }, log: quiet, opts: { backfill: false } });
  const ASSET = K.S;
  indexer.onCreate({ ...createEventFor(K.X), depth: 0, quoteMint: ASSET }, 7);
  await new Promise((r) => setTimeout(r, 30)); // the enrich step (mint info, shares) settles on the fake rpc
  const c = model.get(K.X);
  assert.ok(c && c.tracked, "tracked"); assert.equal(c.depth, 0); assert.equal(c.quoteMint, ASSET); assert.equal(c.createdSlot, 7);
  assert.deepEqual((model.assetFamilies().get(ASSET) ?? []).map((k) => k.mint), [K.X], "the asset is a family top with this coin under it");
  const pair = events.find(([ev]) => ev === "pair");
  assert.ok(pair, "a pair event went out");
  assert.equal(pair[1].coin.mint, K.X); assert.equal(pair[1].coin.parentMint, ASSET);
  assert.equal(pair[1].parent.mint, ASSET); assert.equal(pair[1].parent.asset, true); assert.equal(pair[1].parent.parentMint, null);
  indexer.onCreate({ ...createEventFor(K.U), depth: 0, quoteMint: null }, 8);
  assert.ok(!model.get(K.U), "a SOL-quoted root is only ever a parent");
  db.close();
});

test("the backfill walks the program once a month for every curve quoted in a listed asset (depth 0 with a quote mint) and resolves them into the asset's family", async () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  model.load();
  const ASSET = K.S, CURVE_B = fixtureAccounts.curve.pubkey;
  // One coin quoted in the asset is already in the tree (its child's ancestor walk found it): the asset is a family top.
  model.upsertCoin({ mint: K.A, curve: K.G, depth: 0, quoteMint: ASSET, creator: "CR", tracked: true, virtualQuoteReserves: "1", realQuoteReserves: "0", ...base });
  // The fixture curve, re-stamped as a depth-0 curve quoted in the asset.
  const raw = Buffer.from(fixtureAccounts.curve.data, "base64"); raw[141] = 0; new PublicKey(ASSET).toBuffer().copy(raw, 83);
  const scans = [];
  const rpc = {
    concurrency: 1, snapshot: () => ({}),
    scanProgramAccounts: async (program, cfg, onAccount) => { scans.push(cfg); onAccount(CURVE_B, raw.subarray(32, 142)); return { pages: 1, accounts: 1 }; },
    getTokenAccountsByOwner: async (owner, programId) => (owner === CURVE_B ? [{ pubkey: "ta", mint: K.B, amount: "1", tokenProgram: programId }] : []),
    getMultipleAccounts: async (keys) => keys.map((k) => (k === CURVE_B ? { owner: fixtureAccounts.curve.owner, lamports: 1, data: raw, executable: false } : null)),
  };
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: true, createdAtProbe: false } });
  await indexer.runBackfill();
  assert.equal(scans.length, 1, "one walk of the program");
  assert.deepEqual(scans[0].dataSlice, { offset: 32, length: 110 }); assert.equal(scans[0].filters[0].memcmp.offset, 0);
  const b = model.get(K.B);
  assert.ok(b && b.tracked, "the staged curve became a coin"); assert.equal(b.depth, 0); assert.equal(b.quoteMint, ASSET); assert.equal(b.curve, CURVE_B);
  assert.deepEqual((model.assetFamilies().get(ASSET) ?? []).map((k) => k.mint).sort(), [K.A, K.B].sort());
  assert.ok(db.backfillGet("scanned:assets", 0) > 0, "walk time recorded");
  assert.ok(Buffer.from(db.backfillCurve(CURVE_B).data, "base64").length >= 142, "the staged slice was replaced by the full account");
  await indexer.runBackfill();
  assert.equal(scans.length, 1, "walked within the month: not again");
  assert.equal(await indexer.scanAssetQuotes(), 0, "deduped by the same key");
  db.close();
});
