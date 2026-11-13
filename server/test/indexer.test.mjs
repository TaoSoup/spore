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

// ---- curves too short to carry `depth` (created after quote_mint, before depth): 115..141 bytes, depth 0
import { bondingCurvePda, canonicalPumpPoolPdaWithQuote, normalizeQuoteMint, pk } from "../lib/sdk.mjs";
const pkeyOf = (n) => new PublicKey(Buffer.alloc(32, n)).toBase58();
/** The fixture curve cut to `size` bytes and quoted in `quoteMint` (zero = SOL). */
const shortCurve = (size, quoteMint) => {
  const raw = Buffer.from(fixtureAccounts.curve.data, "base64");
  if (quoteMint) new PublicKey(quoteMint).toBuffer().copy(raw, 83); else raw.fill(0, 83, 115);
  return Buffer.from(raw.subarray(0, size));
};
const curveRpc = (accounts, extra = {}) => {
  const asks = { tokens: [], gpa: [], multiple: [] };
  const rpc = {
    concurrency: 1, snapshot: () => ({}),
    getProgramAccounts: async (program, filters) => { asks.gpa.push(filters); return []; },
    scanProgramAccounts: async (program, cfg, onAccount) => {
      for (const [k, raw] of accounts) onAccount(k, raw.subarray(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length));
      return { pages: 1, accounts: accounts.size };
    },
    getTokenAccountsByOwner: async (owner, programId) => { asks.tokens.push(owner); return extra.mints?.has(owner) ? [{ pubkey: "ta", mint: extra.mints.get(owner), amount: "1", tokenProgram: programId }] : []; },
    getMultipleAccounts: async (keys) => { asks.multiple.push(...keys); return keys.map((k) => (accounts.has(k) ? { owner: fixtureAccounts.curve.owner, lamports: 1, data: accounts.get(k), executable: false } : null)); },
    ...extra.rpc,
  };
  return { rpc, asks };
};

test("the asset walk keeps curves too short for depth; a listed asset quoted in another one ($baton in PUMP) resolves by its mint and is drawn under that asset", async () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  model.load();
  const PUMPX = K.S, NEST = K.B, LEAF = K.X;
  const NEST_CURVE = bondingCurvePda(NEST).toBase58(), LEAF_CURVE = pkeyOf(8), OLD_CURVE = pkeyOf(9), WIDE_CURVE = pkeyOf(12), SOLQ_CURVE = pkeyOf(13);
  // Both are listed quote assets (ensureAncestors never asks for them); a coin quoted in NEST makes it a family top.
  model.setGlobal({ maxCurveDepth: 0, whitelistedQuoteMints: [PUMPX, NEST] });
  model.upsertCoin({ mint: K.A, curve: K.G, depth: 0, quoteMint: NEST, creator: "CR", tracked: true, virtualQuoteReserves: "1", realQuoteReserves: "0", ...base });
  // 125, 115 and 141 bytes quoted in PUMP; 82 bytes (before quote_mint) and a 125-byte one quoted in SOL (zero key).
  const accounts = new Map([[NEST_CURVE, shortCurve(125, PUMPX)], [LEAF_CURVE, shortCurve(115, PUMPX)], [WIDE_CURVE, shortCurve(141, PUMPX)], [OLD_CURVE, shortCurve(82, null)], [SOLQ_CURVE, shortCurve(125, null)]]);
  const { rpc, asks } = curveRpc(accounts, { mints: new Map([[LEAF_CURVE, LEAF], [WIDE_CURVE, K.U]]) });
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: true, createdAtProbe: false } });
  await indexer.runBackfill();
  assert.equal(asks.gpa.length, 0, "no short-curve scan before the first walk: the walk keeps them");
  assert.ok(db.backfillGet("scanned:assets-short", 0) > 0);
  const nest = model.get(NEST), leaf = model.get(LEAF), wide = model.get(K.U);
  assert.ok(nest && nest.tracked, "the 125-byte curve became a coin"); assert.equal(nest.depth, 0); assert.equal(nest.quoteMint, PUMPX); assert.equal(nest.curve, NEST_CURVE);
  assert.ok(!asks.tokens.includes(NEST_CURVE), "resolved by its mint: no token-account lookup");
  assert.ok(leaf && leaf.tracked, "the 115-byte curve became a coin"); assert.equal(leaf.depth, 0); assert.equal(leaf.quoteMint, PUMPX);
  assert.ok(wide && wide.tracked, "the 141-byte curve (a 109-byte slice: no depth byte) became a coin"); assert.equal(wide.depth, 0); assert.equal(wide.quoteMint, PUMPX);
  assert.equal(db.backfillCurve(OLD_CURVE), null, "a curve older than quote_mint is SOL-quoted: not staged");
  assert.equal(db.backfillCurve(SOLQ_CURVE), null, "a short curve quoted in SOL (zero key): not staged");
  assert.equal(Buffer.from(db.backfillCurve(NEST_CURVE).data, "base64").length, 125, "the slice was replaced by the whole (short) account");
  assert.equal(Buffer.from(db.backfillCurve(LEAF_CURVE).data, "base64").length, 115);
  assert.deepEqual((model.assetFamilies().get(PUMPX) ?? []).map((k) => k.mint).sort(), [NEST, LEAF, K.U].sort());
  const { body } = model.mapAll({ all: true });
  const top = body.roots.find((r) => r.coin.mint === PUMPX);
  const under = top?.children.find((k) => k.coin.mint === NEST);
  assert.ok(under, "NEST is drawn under PUMP"); assert.deepEqual(under.children.map((k) => k.coin.mint), [K.A], "with its own coins under it");
  // A whole account shorter than the slice's end is not fetched again by a later resolve batch.
  const before = asks.multiple.length;
  db.backfillCurveUpsert({ curve: pkeyOf(10), depth: 0, quoteMint: PUMPX, data: shortCurve(124, PUMPX).toString("base64"), graduated: false, rq: 0 });
  await indexer.resolveCurves();
  assert.ok(!asks.multiple.slice(before).includes(pkeyOf(10)), "a whole short account is no slice");
  db.close();
});

/** A model for the short-curve scan: PUMPX and NEST listed (plus an empty whitelist slot), a coin quoted in NEST and one in OTHER (an asset no longer listed). */
function shortScanModel() {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 0, whitelistedQuoteMints: [K.S, K.B, pkeyOf(0)] });
  model.upsertCoin({ mint: K.A, curve: K.G, depth: 0, quoteMint: K.B, creator: "CR", tracked: true, virtualQuoteReserves: "1", realQuoteReserves: "0", ...base });
  model.upsertCoin({ mint: K.U, curve: pkeyOf(11), depth: 0, quoteMint: K.ROOT, creator: "CR", tracked: true, virtualQuoteReserves: "1", realQuoteReserves: "0", ...base });
  db.backfillSet("scanned:assets", Math.floor(Date.now() / 1000) - 4 * DAY_S); // the walk ran (before it kept short curves)
  return { db, model };
}
const DAY_S = 86_400;
const filterOf = (filters) => ({ size: filters.find((f) => f.dataSize)?.dataSize, quote: filters.find((f) => f.memcmp?.offset === 83)?.memcmp.bytes });

test("the short-curve scan asks once per quote mint and short size (115, 124, 125, 141), never SOL nor an empty whitelist slot, stages whole accounts, and a later start asks only for the quote mints that failed", async () => {
  const { db, model } = shortScanModel();
  const PUMPX = K.S, NEST = K.B, OTHER = K.ROOT;
  const NEST_CURVE = bondingCurvePda(NEST).toBase58(), LEAF_CURVE = pkeyOf(8);
  const nestRaw = shortCurve(125, PUMPX), leafRaw = shortCurve(141, PUMPX);
  let failOnce = true;
  const { rpc, asks } = curveRpc(new Map([[NEST_CURVE, nestRaw], [LEAF_CURVE, leafRaw]]), { rpc: {
    getProgramAccounts: async (program, filters) => {
      asks.gpa.push(filters);
      const { size, quote } = filterOf(filters);
      if (quote === OTHER && size === 124 && failOnce) { failOnce = false; throw new Error("429"); }
      if (quote !== PUMPX) return [];
      if (size === 125) return [{ pubkey: NEST_CURVE, account: { data: nestRaw } }];
      if (size === 141) return [{ pubkey: LEAF_CURVE, account: { data: leafRaw } }];
      return [];
    },
  } });
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  assert.equal(await indexer.scanShortAssetCurves(), 2);
  const quotes = new Set(asks.gpa.map((f) => filterOf(f).quote));
  assert.deepEqual([...quotes].sort(), [PUMPX, NEST, OTHER].sort(), "the listed mints and the assets coins are quoted in; never SOL nor the zero key");
  assert.equal(asks.gpa.length, 3 * 4, "one call per quote mint and short size");
  assert.deepEqual([...new Set(asks.gpa.map((f) => filterOf(f).size))].sort((a, b) => a - b), [115, 124, 125, 141]);
  assert.ok(asks.gpa.every((f) => f[0].memcmp?.offset === 0), "the BondingCurve discriminator first");
  assert.equal(Buffer.from(db.backfillCurve(NEST_CURVE).data, "base64").length, 125, "staged whole");
  const leaf = db.backfillCurve(LEAF_CURVE);
  assert.equal(leaf.quoteMint, PUMPX); assert.equal(leaf.depth, 0);
  assert.equal(db.backfillGet("scanned:assets-short", 0), 0, "a call failed: not done");
  assert.deepEqual(db.backfillGet("scanned:assets-short:quotes", []).sort(), [PUMPX, NEST].sort(), "the quote mints that answered are kept");
  assert.deepEqual(await indexer.resolveStagedAssets(), [NEST], "the listed asset resolves by its mint");
  assert.equal(model.get(NEST).quoteMint, PUMPX);
  assert.equal(asks.tokens.length, 0, "no token-account lookup");
  assert.equal(await indexer.scanShortAssetCurves(), 0, "the next start asks only for OTHER");
  assert.deepEqual(asks.gpa.slice(12).map((f) => filterOf(f).quote), [OTHER, OTHER, OTHER, OTHER]);
  assert.ok(db.backfillGet("scanned:assets-short", 0) > 0, "done");
  assert.deepEqual(db.backfillGet("scanned:assets-short:quotes", null), [], "its progress is cleared");
  assert.equal(await indexer.scanShortAssetCurves(), 0);
  assert.equal(asks.gpa.length, 16, "once");
  db.close();
});

test("the short-curve scan stops after 5 failed calls in a row, and on a provider that pages getProgramAccounts it makes the asset walk due instead", async () => {
  const { db, model } = shortScanModel();
  const failing = curveRpc(new Map(), { rpc: { getProgramAccounts: async (program, filters) => { failing.asks.gpa.push(filters); throw new Error("503"); } } });
  const a = new Indexer({ rpc: failing.rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  assert.equal(await a.scanShortAssetCurves(), 0);
  assert.equal(failing.asks.gpa.length, 5, "it gives up for this start");
  assert.equal(db.backfillGet("scanned:assets-short", 0), 0); assert.deepEqual(db.backfillGet("scanned:assets-short:quotes", []), []);

  // Helius refuses plain getProgramAccounts: rpc.mjs switches to getProgramAccountsV2 pages, a walk of the whole key
  // space per call. One call is made, then the walk (which keeps short curves now) is made due.
  const paging = curveRpc(new Map(), { rpc: { getProgramAccounts: async (program, filters) => { paging.asks.gpa.push(filters); paging.rpc.gpaV2 = true; return []; } } });
  const b = new Indexer({ rpc: paging.rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  assert.equal(await b.scanShortAssetCurves(), 0);
  assert.equal(paging.asks.gpa.length, 1);
  assert.equal(db.backfillGet("scanned:assets", -1), 0, "the walk is due");
  assert.ok(db.backfillGet("scanned:assets-short", 0) > 0, "and the scan is done");
  db.close();
});

test("a listed asset fetchCoin cached untracked (one click on it on the map) is still staged, resolved and tracked, by mint or through the queue", async () => {
  const PUMPX = K.S, NEST = K.B;
  const NEST_CURVE = bondingCurvePda(NEST).toBase58();
  const nestRaw = shortCurve(125, PUMPX);
  const scanRpc = () => {
    const r = curveRpc(new Map([[NEST_CURVE, nestRaw]]), { mints: new Map([[NEST_CURVE, NEST]]), rpc: {
      getProgramAccounts: async (program, filters) => { const { size, quote } = filterOf(filters); return quote === PUMPX && size === 125 ? [{ pubkey: NEST_CURVE, account: { data: nestRaw } }] : []; },
    } });
    return r;
  };
  // By mint: the short scan stages its curve although the coin is held (untracked), and resolveStagedAssets tracks it.
  {
    const { db, model } = shortScanModel();
    const { rpc } = scanRpc();
    const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
    assert.ok(await indexer.fetchCoin(NEST), "fetchCoin found it on chain");
    assert.equal(model.get(NEST).tracked, false, "cached untracked");
    await indexer.scanShortAssetCurves();
    assert.ok(db.backfillCurve(NEST_CURVE), "its curve was staged all the same");
    assert.deepEqual(await indexer.resolveStagedAssets(), [NEST]);
    assert.equal(model.get(NEST).tracked, true);
    assert.deepEqual((model.assetFamilies().get(PUMPX) ?? []).map((k) => k.mint), [NEST], "in PUMP's family");
    db.close();
  }
  // Through the queue (resolveOne finds the cached coin by its curve): tracked too, not only marked resolved.
  {
    const { db, model } = shortScanModel();
    const { rpc } = scanRpc();
    const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
    db.backfillCurveUpsert({ curve: NEST_CURVE, depth: 0, quoteMint: PUMPX, data: nestRaw.toString("base64"), graduated: true, rq: 0 });
    await indexer.fetchCoin(NEST);
    assert.equal(model.get(NEST).tracked, false);
    await indexer.resolveCurves();
    assert.equal(db.backfillCurve(NEST_CURVE).mint, NEST);
    assert.equal(model.get(NEST).tracked, true, "the resolved row's coin joined the tree");
    assert.ok(db.allCoins().some((c) => c.mint === NEST), "and is stored");
    db.close();
  }
});

test("the restart that fixes $baton: the short scan stages it, it resolves by mint with its pool read, all before the queue's first token lookup", async () => {
  const { db, model } = shortScanModel();
  const PUMPX = K.S, NEST = K.B, DECOY = K.X;
  const NEST_CURVE = bondingCurvePda(NEST).toBase58(), DECOY_CURVE = pkeyOf(8);
  const nestRaw = shortCurve(125, PUMPX), decoyRaw = shortCurve(166, PUMPX); decoyRaw[141] = 0;
  db.backfillCurveUpsert({ curve: DECOY_CURVE, depth: 0, quoteMint: PUMPX, data: decoyRaw.subarray(32, 142).toString("base64"), graduated: true, rq: 9e18 }); // first in the queue
  const pool = canonicalPumpPoolPdaWithQuote(pk(NEST), normalizeQuoteMint(pk(PUMPX))).toBase58();
  const timeline = [];
  const { rpc } = curveRpc(new Map([[NEST_CURVE, nestRaw], [DECOY_CURVE, decoyRaw]]), { mints: new Map([[DECOY_CURVE, DECOY]]), rpc: {
    getProgramAccounts: async (program, filters) => { const { size, quote } = filterOf(filters); return quote === PUMPX && size === 125 ? [{ pubkey: NEST_CURVE, account: { data: nestRaw } }] : []; },
  } });
  const getTokens = rpc.getTokenAccountsByOwner, getMany = rpc.getMultipleAccounts;
  rpc.getTokenAccountsByOwner = async (owner, programId) => { timeline.push(["tokens", owner, !!model.get(NEST)?.tracked]); return getTokens(owner, programId); };
  rpc.getMultipleAccounts = async (keys) => { timeline.push(["accounts", keys]); return getMany(keys); };
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: true, createdAtProbe: false } });
  await indexer.runBackfill();
  assert.equal(model.get(NEST)?.quoteMint, PUMPX); assert.equal(model.get(NEST).tracked, true);
  assert.ok(model.get(DECOY), "the queue went on");
  const firstToken = timeline.findIndex((e) => e[0] === "tokens");
  assert.ok(firstToken > 0 && timeline[firstToken][2], "no token lookup before $baton was a coin");
  assert.ok(!timeline.some((e) => e[0] === "tokens" && e[1] === NEST_CURVE), "and none for its curve");
  const poolRead = timeline.findIndex((e) => e[0] === "accounts" && e[1].includes(pool));
  assert.ok(poolRead >= 0 && poolRead < firstToken, "its pool was asked for before the queue started");
  db.close();
});

test("the walk stages thousands of curves in transactions that hand the event loop back between them", async () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 0, whitelistedQuoteMints: [K.S] });
  const raw = shortCurve(166, K.S); raw[141] = 0;
  const keyN = (i) => { const b = Buffer.alloc(32, 7); b.writeUInt32LE(i + 1, 0); return new PublicKey(b).toBase58(); };
  const N = 2_100;
  const { rpc } = curveRpc(new Map(), { rpc: { scanProgramAccounts: async (program, cfg, onAccount) => { for (let i = 0; i < N; i++) onAccount(keyN(i), raw.subarray(32, 142)); return { pages: 1, accounts: N }; } } });
  let txs = 0, turns = 0, turnsAtLastTx = -1;
  const tx = db.transaction.bind(db);
  db.transaction = (fn) => { txs++; if (turns === turnsAtLastTx) throw new Error("two transactions in one turn of the event loop"); turnsAtLastTx = turns; return tx(fn); };
  const tick = () => { turns++; pending = setImmediate(tick); };
  let pending = setImmediate(tick);
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false, backfillLimit: 0, stageSliceMs: 0 } });
  try { assert.equal(await indexer.scanAssetQuotes(), N); } finally { clearImmediate(pending); db.transaction = tx; }
  assert.equal(db.backfillStats().total, N, "every row staged once");
  assert.ok(txs >= N, `at a 0 ms budget a row per transaction (${txs})`);
  db.close();
});

test("a coin quoted in a listed asset that is a tracked coin itself goes out as a pair with that coin as its parent, hung under its own asset", () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  model.load();
  const PUMPX = K.S, NEST = K.B;
  const row = (mint, quoteMint, tracked = true) => model.upsertCoin({ mint, curve: `C_${mint}`, depth: 0, quoteMint, creator: "CR", tracked, virtualQuoteReserves: "1", realQuoteReserves: "0", ...base });
  row(NEST, PUMPX); row(K.X, NEST); row(K.A, PUMPX); row(K.G, K.ROOT); row(K.ROOT, PUMPX, false);
  const events = [];
  const indexer = new Indexer({ rpc: fakeRpc().rpc, model, meta: null, hub: { emit: (ev, data) => events.push(data) }, log: quiet, opts: { backfill: false } });
  assert.equal(indexer.announcePair(K.X), true, "under $baton");
  assert.equal(events[0].coin.parentMint, NEST); assert.equal(events[0].parent.mint, NEST); assert.equal(events[0].parent.parentMint, PUMPX); assert.ok(!events[0].parent.asset);
  assert.equal(indexer.announcePair(K.A), true, "under PUMP");
  assert.equal(events[1].parent.mint, PUMPX); assert.equal(events[1].parent.asset, true); assert.equal(events[1].parent.parentMint, null);
  assert.equal(indexer.announcePair(K.G), true, "under an asset held only as an untracked coin: the asset's bubble");
  assert.equal(events[2].parent.mint, K.ROOT); assert.equal(events[2].parent.asset, true);
  db.close();
});

test("at every start a staged listed asset resolves by its mint before the queue, and a child never fails on a parent still held as a slice", async () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  model.load();
  const PUMPX = K.S, NEST = K.B, KID = K.X;
  const NEST_CURVE = bondingCurvePda(NEST).toBase58(), KID_CURVE = pkeyOf(8);
  model.setGlobal({ maxCurveDepth: 0, whitelistedQuoteMints: [PUMPX, NEST] });
  model.upsertCoin({ mint: K.A, curve: K.G, depth: 0, quoteMint: NEST, creator: "CR", tracked: true, virtualQuoteReserves: "1", realQuoteReserves: "0", ...base });
  const nestRaw = shortCurve(125, PUMPX);
  // Staged by an earlier run (whole account), behind the queue (not graduated); this run's walks are done.
  db.backfillCurveUpsert({ curve: NEST_CURVE, depth: 0, quoteMint: PUMPX, data: nestRaw.toString("base64"), graduated: false, rq: 0 });
  db.backfillSet("scanned:assets", Math.floor(Date.now() / 1000)); db.backfillSet("scanned:assets-short", Math.floor(Date.now() / 1000));
  const { rpc, asks } = curveRpc(new Map([[NEST_CURVE, nestRaw]]));
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: true, createdAtProbe: false } });
  await indexer.runBackfill();
  assert.equal(model.get(NEST)?.quoteMint, PUMPX, "resolved at start");
  assert.ok(!asks.tokens.includes(NEST_CURVE), "by its mint, not by a token-account lookup");

  // A coin quoted in an asset whose staged row is still the walk's slice (its fill failed): the coin resolves,
  // the asset waits for its fill (no "not a BondingCurve account" thrown at the coin).
  const db2 = new Db(":memory:");
  const m2 = new Model(db2, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m2.load();
  m2.setGlobal({ maxCurveDepth: 0, whitelistedQuoteMints: [PUMPX, NEST] });
  db2.backfillCurveUpsert({ curve: NEST_CURVE, depth: 0, quoteMint: PUMPX, data: nestRaw.subarray(32, 142).toString("base64"), graduated: false, rq: 0 });
  const kidRaw = shortCurve(166, NEST); kidRaw[141] = 0; // a whole current-size curve, depth 0
  db2.backfillCurveUpsert({ curve: KID_CURVE, depth: 0, quoteMint: NEST, data: kidRaw.toString("base64"), graduated: true, rq: 1 });
  const r2 = curveRpc(new Map(), { mints: new Map([[KID_CURVE, KID]]) });
  const ix2 = new Indexer({ rpc: r2.rpc, model: m2, meta: null, hub: null, log: quiet, opts: { backfill: false, backfillLimit: 1 } });
  await ix2.resolveCurves();
  assert.equal(m2.get(KID)?.quoteMint, NEST, "the coin resolved");
  assert.equal(db2.backfillCurve(KID_CURVE).mint, KID); assert.equal(db2.backfillStats().failed, 0, "and is not marked failed");
  assert.ok(!m2.get(NEST), "the asset waits for its fill");
  db.close(); db2.close();
});
