// The coin view's scope (2026-10-21): the coin page, /api/tree, /api/search, the SSE "coin" event and
// /v1 count EVERY pump.fun child (children, descendants, locked value), like the map; `scope=ours`
// on /api/coin and /api/tree keeps the listing-mode view of an "ours" deployment exactly as before.
// Fixture = test/ours.test.mjs buildOursTree: ROOT → OURS (ours, 5e13 locked), FOREIGN (1e13) → DEEP (ours, 7e12).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer } from "../lib/indexer.mjs";
import { K, PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";

const OUR_SHARES = [{ address: "CR", bps: 5000 }, { address: PLATFORM, bps: 5000 }];
const FOREIGN_SHARES = [{ address: "CR", bps: 10000 }];
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

function buildOursTree() {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "ours", log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  model.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 1000 });
  model.upsertCoin({ mint: K.A, curve: "C_A", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "2000000000000000", realQuoteReserves: "50000000000000", createdAt: 2000, shares: OUR_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.B, curve: "C_B", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "10000000000000", createdAt: 3000, shares: FOREIGN_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.G, curve: "C_G", depth: 2, quoteMint: K.B, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "7000000000000", createdAt: 4000, shares: OUR_SHARES, sharesAt: 1 });
  for (const [mint, symbol] of [[K.ROOT, "ROOT"], [K.A, "OURS"], [K.B, "FOREIGN"], [K.G, "DEEP"]]) model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, onchainAt: 1 });
  return { db, model };
}

let server, app, url, model, db, hub;
before(async () => {
  ({ db, model } = buildOursTree());
  hub = new EventHub({ heartbeatMs: 60_000 });
  const indexer = { fetchCoin: async () => null, adopt: async (mint) => model.get(mint), snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  app = createApp({ model, indexer, rpc: { proxy: async () => ({ status: 200, text: "{}" }) }, hub, images: { handler: () => (_q, r) => r.status(404).end() }, meta: null,
    platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], launchFeeSol: 0.02, distDir: null, log: quiet });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { app.locals.v1?.close(); hub.close(); server.closeAllConnections?.(); server.close(); db.close(); });
const get = async (p) => { const r = await fetch(url + p); return { status: r.status, body: await r.json() }; };

test("model.view: the default stays the listing scope, { all: true } is scopedAll", () => {
  const root = model.get(K.ROOT);
  const s = model.view(root), a = model.view(root, { all: true });
  assert.deepEqual([s.children, s.descendants, s.lockedQuote], [2, 2, "50000000000000"]);
  near(s.lockedUsd, 500, "scoped lockedUsd");
  assert.deepEqual([a.children, a.descendants, a.lockedQuote, a.otherChildren], [2, 3, "60000000000000", 0]);
  near(a.lockedUsd, 600, "all lockedUsd");
  // The /api/coin override (children = childrenOf().length, otherChildren = 0) is what scopedAll already says, for every coin.
  for (const c of model.tracked()) {
    const x = model.scopedAll(c);
    assert.equal(x.children, model.childrenOf(c.mint).length, `children of ${c.mint}`);
    assert.equal(x.otherChildren, 0);
  }
});

test("GET /api/coin: all-scope numbers by default, on the coin and every child row; scope=ours keeps the listing view", async () => {
  const all = await get(`/api/coin/${K.ROOT}`);
  assert.equal(all.status, 200);
  assert.equal(all.body.coin.descendants, 3); assert.equal(all.body.coin.lockedQuote, "60000000000000"); near(all.body.coin.lockedUsd, 600, "ROOT lockedUsd");
  assert.equal(all.body.coin.children, 2); assert.equal(all.body.children.length, 2); assert.equal(all.body.coin.otherChildren, 0); assert.equal(all.body.otherChildren, 0);
  const b = all.body.children.find((c) => c.mint === K.B), a = all.body.children.find((c) => c.mint === K.A);
  assert.deepEqual([b.children, b.descendants, b.lockedQuote], [1, 1, "7000000000000"]);
  assert.deepEqual([a.children, a.descendants, a.lockedQuote], [0, 0, "0"]);
  assert.deepEqual(all.body.children.map((c) => c.mint), [K.B, K.A], "child rows by their own (all-scope) locked value: FOREIGN holds DEEP's 7e12");
  const ours = await get(`/api/coin/${K.ROOT}?scope=ours`);
  assert.equal(ours.body.coin.descendants, 2); assert.equal(ours.body.coin.lockedQuote, "50000000000000"); near(ours.body.coin.lockedUsd, 500, "ROOT lockedUsd (ours)");
  assert.equal(ours.body.coin.children, 2); assert.equal(ours.body.otherChildren, 0);
  // light call of the map side panel: same numbers, empty lists
  const light = await get(`/api/coin/${K.ROOT}?children=0&trades=0`);
  assert.equal(light.body.coin.descendants, 3); assert.deepEqual(light.body.children, []);
});

test("GET /api/coin of a foreign coin: its pump.fun children count, not 0", async () => {
  const b = await get(`/api/coin/${K.B}`);
  assert.equal(b.body.coin.ours, false);
  assert.equal(b.body.coin.descendants, 1); assert.equal(b.body.coin.lockedQuote, "7000000000000"); assert.ok(b.body.coin.lockedUsd > 0);
  assert.deepEqual(b.body.children.map((c) => c.mint), [K.G]);
});

test("GET /api/tree: the same root numbers in both scopes", async () => {
  const all = await get(`/api/tree/${K.ROOT}?depth=3`);
  assert.equal(all.body.coin.descendants, 3); assert.equal(all.body.coin.lockedQuote, "60000000000000"); near(all.body.coin.lockedUsd, 600, "tree ROOT");
  assert.equal(all.body.coin.children, 2); assert.equal(all.body.coin.otherChildren, 0);
  const fb = all.body.children.find((n) => n.coin.mint === K.B);
  assert.equal(fb.coin.descendants, 1); assert.deepEqual(fb.children.map((n) => n.coin.mint), [K.G]);
  const ours = await get(`/api/tree/${K.ROOT}?depth=3&scope=ours`);
  assert.equal(ours.body.coin.descendants, 2); assert.equal(ours.body.coin.lockedQuote, "50000000000000"); near(ours.body.coin.lockedUsd, 500, "tree ROOT (ours)");
});

test("GET /api/search returns all-scope numbers (by name and by exact mint)", async () => {
  const byName = await get("/api/search?q=ROOT");
  const r = byName.body.coins.find((c) => c.mint === K.ROOT);
  assert.equal(r.descendants, 3); assert.equal(r.lockedQuote, "60000000000000");
  const byMint = await get(`/api/search?q=${K.ROOT}`);
  assert.equal(byMint.body.coins[0].descendants, 3); assert.equal(byMint.body.coins[0].lockedQuote, "60000000000000");
});

test("listing consumers stay scoped: /api/roots counts our descendants only", async () => {
  const { body } = await get("/api/roots");
  assert.equal(body.roots[0].mint, K.ROOT); assert.equal(body.roots[0].descendants, 2); assert.equal(body.roots[0].lockedQuote, "50000000000000");
});

test("/v1 family and tree are all-scope in ours mode (mapRef(c, true))", async () => {
  const fam = await get(`/v1/coin/${K.ROOT}/family`);
  assert.equal(fam.status, 200);
  assert.equal(fam.body.descendants, 3); near(fam.body.lockedUsd, 600, "v1 family lockedUsd (6e13 ROOT)"); assert.equal(fam.body.children.count, 2);
  const tree = await get(`/v1/tree/${K.ROOT}`);
  const n = tree.body.nodes.find((x) => x.mint === K.ROOT);
  assert.equal(n.descendants, 3); near(n.lockedUsd, 600, "v1 tree lockedUsd");
  assert.equal(tree.body.total, 4, "every pump.fun coin of the tree");
});

test("the SSE coin event carries all-scope numbers", async () => {
  // OURS gets a foreign child: in the listing scope OURS shows nothing below it, in all-scope 1 child / 3e12 locked.
  const { db: db2, model: m2 } = buildOursTree();
  m2.upsertCoin({ mint: K.X, curve: "C_X", depth: 2, quoteMint: K.A, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "3000000000000", createdAt: 5000, shares: FOREIGN_SHARES, sharesAt: 1 });
  m2.setMint({ mint: K.X, decimals: 6, tokenProgram: T22, name: "X coin", symbol: "XX", onchainAt: 1 });
  // OURS is a pending spawn (no sharing config read yet): it stays "ours" whatever the empty fake chain says.
  m2.upsertCoin({ mint: K.A, shares: null });
  m2.markPending(K.A, "sig");
  assert.equal(m2.view(m2.get(K.A)).descendants, 0, "listing scope: the foreign child is not counted");
  const events = [];
  const rpc = { getMultipleAccounts: async (keys) => keys.map(() => null), snapshot: () => ({}) };
  rpc.lane = () => rpc;
  const ix = new Indexer({ rpc, model: m2, meta: null, hub: { emit: (ev, data) => events.push([ev, data]) }, log: quiet, opts: { backfill: false } });
  await ix.adopt(K.A);
  const ev = events.find(([name, d]) => name === "coin" && d.mint === K.A);
  assert.ok(ev, "a coin event for OURS");
  assert.equal(ev[1].children, 1); assert.equal(ev[1].descendants, 1); assert.equal(ev[1].lockedQuote, "3000000000000");
  db2.close();
});
