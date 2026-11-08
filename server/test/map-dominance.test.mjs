// DESIGN §11.5 "Dominance": GET /api/map/dominance — each family's share of the whole map's value in
// both size modes, the same numbers the map draws (valueOf + per-family sums of web/src/lib/map/sizing.ts):
// the pure table, the route's shape, order, ?mint= filter, validation, 30 s cache and ETag/304, and that
// it covers the all-scope forest whatever SHOW. No network, no RPC; a fake clock for the caches.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { DOMINANCE_CACHE_MS, familyShares, familyValueOf, isThinFamily, THIN_LOCKED_USD, THIN_MAX_COINS, valueOf } from "../lib/dominance.mjs";
import { K, PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";

const node = (mint, o, children = []) => ({ coin: { mint, symbol: mint.toUpperCase(), mcapUsd: null, lockedUsd: null, ...o }, children });

test("familyShares: Σ familyValueOf per family (lockedUsd in locked mode, no market-cap slice), shares of the total, biggest first", () => {
  // r1: locks 1 000, its child a locks 200 and has a $10k-mcap leaf (locks nothing), b a $1M coin that locks 0
  // r2: locks 3 000, one leaf with nothing known; r3: a lone root with a $50 mcap and nothing locked
  const roots = [
    node("r1", { lockedUsd: 1_000, mcapUsd: 90_000 }, [node("a", { lockedUsd: 200, mcapUsd: 5_000 }, [node("a1", { mcapUsd: 10_000 })]), node("b", { lockedUsd: 0, mcapUsd: 1_000_000 })]),
    node("r2", { lockedUsd: 3_000, mcapUsd: 40_000 }, [node("c", {})]),
    node("r3", { mcapUsd: 50 }),
  ];
  const locked = familyShares(roots, "locked");
  assert.equal(locked.mode, "locked");
  assert.deepEqual(locked.families.map((f) => [f.mint, f.value, f.coins]), [["r2", 3_000, 2], ["r1", 1_200, 4], ["r3", 0, 1]]);
  assert.equal(locked.total, 4_200);
  assert.deepEqual(locked.families.map((f) => f.share), [3_000 / 4_200, 1_200 / 4_200, 0]);
  assert.ok(Math.abs(locked.families.reduce((s, f) => s + f.share, 0) - 1) < 1e-12, "shares add up to 100 %");
  const mcap = familyShares(roots, "mcap");
  // r3 is a thin family (1 coin, nothing locked): weighed by what it locks (nothing), not its $50 mcap
  assert.deepEqual(mcap.families.map((f) => [f.mint, f.value]), [["r1", 1_105_000], ["r2", 40_000], ["r3", 0]]);
  assert.equal(mcap.total, 1_145_000);
  // thin-family guard: a 2-coin family at $1.07B locking $0.000001 weighs what it locks (1e-6, 0 at cents; no market-cap slice)
  const junk = familyShares([node("xto", { mcapUsd: 1.07e9, lockedUsd: 1e-6 }, [node("x1", { mcapUsd: 4_000 })]), node("big", { mcapUsd: 2e6, lockedUsd: 150 }, [node("b1", { mcapUsd: 1e5 }), node("b2", { mcapUsd: 1e5 }), node("b3", { mcapUsd: 1e5, lockedUsd: 10 })])], "mcap");
  assert.deepEqual(junk.families.map((f) => [f.mint, f.value]), [["big", 2_300_000], ["xto", 0]]);
  assert.equal(isThinFamily(5, 99.99), true); assert.equal(isThinFamily(5, 100), false); assert.equal(isThinFamily(6, 0), false);
  assert.equal(THIN_MAX_COINS, 5); assert.equal(THIN_LOCKED_USD, 100);
  // the same rule as the map's sizing.ts familyValueOf (valueOf is the old name)
  assert.equal(valueOf, familyValueOf);
  assert.equal(valueOf({ lockedUsd: null, mcapUsd: 30_000 }, "locked"), null);
  assert.equal(valueOf({ lockedUsd: 0, mcapUsd: 1_000 }, "locked"), 0);
  assert.equal(valueOf({ lockedUsd: 12, mcapUsd: 1_000 }, "locked"), 12);
  assert.equal(valueOf({ lockedUsd: null, mcapUsd: null }, "locked"), null);
  assert.equal(valueOf({ lockedUsd: 7, mcapUsd: null }, "mcap"), null);
  // mcap mode: the liquidity cap wins when present; a listed asset top's own mcap never counts
  assert.equal(valueOf({ mcapUsd: 1e9, mcapCapUsd: 100 }, "mcap"), 100);
  assert.equal(valueOf({ mcapUsd: 7.69e9, asset: true }, "mcap"), 0);
  assert.equal(valueOf({ mcapUsd: 7.69e9, lockedUsd: 50, asset: true }, "locked"), 50, "locked mode is unchanged for an asset");
  const withAsset = familyShares([node("usdc", { mcapUsd: 7.69e9, lockedUsd: 500, asset: true }, [node("k1", { mcapUsd: 1_000 }), node("k2", { mcapUsd: 2e9, mcapCapUsd: 500 })])], "mcap");
  assert.equal(withAsset.families[0].value, 1_500, "family = Σ members (capped), the asset's own mcap excluded");
  // an empty map and an all-zero map: no division by zero
  assert.deepEqual(familyShares([], "locked"), { mode: "locked", total: 0, families: [] });
  assert.equal(familyShares([node("z", {})], "mcap").families[0].share, 0);
});

let clock, dir, hub;
const apps = [];

/** ROOT → A → G, ROOT → B (helpers/tree.mjs) plus a second family X → U, on a fake clock. */
function buildModel(mode) {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode, now: () => clock, log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  model.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 1000 });
  model.upsertCoin({ mint: K.A, curve: "C_A", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "2000000000000000", realQuoteReserves: "50000000000000", createdAt: 2000 });
  model.upsertCoin({ mint: K.B, curve: "C_B", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "10000000000000", createdAt: 3000 });
  model.upsertCoin({ mint: K.G, curve: "C_G", depth: 2, quoteMint: K.A, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "7000000000000", createdAt: 4000 });
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "300000000000", createdAt: 1500 });
  model.upsertCoin({ mint: K.U, curve: "C_U", depth: 1, quoteMint: K.X, ...base, virtualQuoteReserves: "4000000000000000", realQuoteReserves: "90000000000000", createdAt: 2500 });
  for (const [mint, symbol] of [[K.ROOT, "ROOT"], [K.A, "AAA"], [K.B, "BBB"], [K.G, "GGG"], [K.X, "XXX"], [K.U, "UUU"]]) model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, onchainAt: 1 });
  return { db, model };
}

async function serve(mode) {
  const { db, model } = buildModel(mode);
  const indexer = { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  const images = new ImageCache(join(dir, mode), { fetchImpl: async () => new Response("", { status: 404 }) });
  const app = createApp({ model, indexer, rpc: { proxy: async () => ({ status: 200, text: "{}" }) }, hub, images, meta: null, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], distDir: null, log: quiet, now: () => clock });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const entry = { server, url: `http://127.0.0.1:${server.address().port}`, model, db };
  apps.push(entry);
  return entry;
}
const get = async (url, headers = {}) => { const r = await fetch(url, { headers }); return { status: r.status, headers: r.headers, body: r.status === 304 ? null : await r.json() }; };
/** What the map computes from /api/map?scope=all&limit=all: per root, Σ valueOf over its tree. */
async function fromMap(url, mode) {
  const map = await get(`${url}/api/map?scope=all&limit=all`);
  const sum = (n) => { const v = valueOf(n.coin, mode); return (v != null && v > 0 ? v : 0) + n.children.reduce((s, k) => s + sum(k), 0); };
  return new Map(map.body.roots.map((r) => [r.coin.mint, sum(r)]));
}

let all, ours;
before(async () => {
  clock = Date.now();
  dir = mkdtempSync(join(tmpdir(), "spore-dom-"));
  hub = new EventHub({ heartbeatMs: 60_000 });
  all = await serve("all");
  ours = await serve("ours");
});
after(() => { hub?.close(); for (const a of apps) { a.server.close(); a.db.close(); } if (dir) rmSync(dir, { recursive: true, force: true }); });

test("GET /api/map/dominance: every map family with the map's numbers, biggest first, shares add up to 1, in both modes and whatever SHOW", async () => {
  for (const { url } of [all, ours]) {
    for (const mode of ["locked", "mcap"]) {
      const { status, headers, body } = await get(`${url}/api/map/dominance${mode === "locked" ? "?mode=locked" : ""}`);
      assert.equal(status, 200);
      assert.deepEqual(Object.keys(body), ["mode", "total", "families"]);
      assert.equal(body.mode, mode);
      assert.deepEqual(body.families.map((f) => f.mint).sort(), [K.ROOT, K.X].sort(), "the two all-scope roots (ours mode has no ours coin: the forest is still drawn)");
      for (const f of body.families) assert.deepEqual(Object.keys(f), ["mint", "symbol", "value", "share", "coins"]);
      const expect = await fromMap(url, mode);
      let total = 0;
      for (const f of body.families) { assert.ok(Math.abs(f.value - expect.get(f.mint)) < 0.01, `${mode} ${f.symbol}: ${f.value} vs the map's ${expect.get(f.mint)}`); total += expect.get(f.mint); }
      assert.ok(Math.abs(body.total - total) < 0.01);
      assert.ok(body.total > 0);
      assert.ok(Math.abs(body.families.reduce((s, f) => s + f.share, 0) - 1) < 1e-12);
      assert.ok(body.families[0].value >= body.families[1].value);
      assert.deepEqual(body.families.find((f) => f.mint === K.ROOT).coins, 4);
      assert.deepEqual(body.families.find((f) => f.mint === K.X).symbol, "XXX");
      assert.match(headers.get("cache-control"), /max-age=30/);
      const etag = headers.get("etag");
      assert.ok(etag);
      assert.equal((await get(`${url}/api/map/dominance${mode === "locked" ? "?mode=locked" : ""}`, { "if-none-match": etag })).status, 304);
    }
  }
});

test("GET /api/map/dominance?mint=: one family's row (the whole map's total), [] for a coin that is not a family top; 400 on bad input", async () => {
  const { url } = all;
  const full = await get(`${url}/api/map/dominance?mode=mcap`);
  const one = await get(`${url}/api/map/dominance?mode=mcap&mint=${K.ROOT}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, { mode: "mcap", total: full.body.total, families: [full.body.families.find((f) => f.mint === K.ROOT)] });
  const child = await get(`${url}/api/map/dominance?mint=${K.A}`);
  assert.deepEqual(child.body.families, [], "A is a member of ROOT's family, not a top");
  assert.equal(child.body.mode, "mcap", "no mode = mcap (owner 2026-10-21)");
  assert.equal((await get(`${url}/api/map/dominance?mode=volume`)).status, 400);
  assert.deepEqual((await get(`${url}/api/map/dominance?mint=not-a-mint`)).body, { error: "invalid mint" });
});

test("the table is cached 30 s per mode, then rebuilt from the forest", async () => {
  const { url, model } = all;
  const first = await get(`${url}/api/map/dominance`);
  // a new pair under X with a lot locked moves X's value; inside the window the bytes stay
  model.upsertCoin({ mint: K.S, curve: "C_S2", depth: 1, quoteMint: K.X, ...base, virtualQuoteReserves: "9000000000000000", realQuoteReserves: "800000000000000", createdAt: 5000 });
  model.setMint({ mint: K.S, decimals: 6, tokenProgram: T22, name: "SSS coin", symbol: "SSS", onchainAt: 1 });
  clock += DOMINANCE_CACHE_MS - 1_000;
  const cached = await get(`${url}/api/map/dominance`);
  assert.equal(cached.headers.get("etag"), first.headers.get("etag"));
  clock += 2_000;
  const fresh = await get(`${url}/api/map/dominance`);
  assert.notEqual(fresh.headers.get("etag"), first.headers.get("etag"));
  const x0 = first.body.families.find((f) => f.mint === K.X), x1 = fresh.body.families.find((f) => f.mint === K.X);
  assert.equal(x1.coins, x0.coins + 1);
  assert.ok(x1.value > x0.value);
  const expect = await fromMap(url, "mcap");
  assert.ok(Math.abs(x1.value - expect.get(K.X)) < 0.01, "the rebuilt numbers are the map's again");
});
