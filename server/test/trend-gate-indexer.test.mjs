// The trending gate in the indexer: a plain SOL launch the indexer drops is watched; its curve trades are decoded and
// counted; a pass is recorded in trend_gate. In shadow mode nothing else changes; with mode "on" the launch is inserted
// into the tree with the trades the gate kept (priced, no SSE trade events for them), under an hourly cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BN, PublicKey, pumpIdl } from "../lib/sdk.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer } from "../lib/indexer.mjs";
import { payload, frame, key, CURVE } from "./helpers/chain.mjs";
import { PLATFORM, quiet } from "./helpers/tree.mjs";

const ZERO = new PublicKey(Buffer.alloc(32)), T = Math.floor(Date.now() / 1000) - 120;
const ROOT = key(120), CREATOR = key(121);
const createEv = (mint = ROOT) => payload(pumpIdl, "CreateEvent", {
  name: "Root Coin", symbol: "ROOT", uri: "", mint: new PublicKey(mint), bonding_curve: new PublicKey(key(122)), user: new PublicKey(CREATOR), creator: new PublicKey(CREATOR),
  timestamp: new BN(T), virtual_token_reserves: new BN("1073000000000000"), virtual_sol_reserves: new BN("30000000000"), real_token_reserves: new BN("793100000000000"),
  token_total_supply: new BN("1000000000000000"), quote_mint: ZERO, virtual_quote_reserves: new BN(0), depth: 0,
});
let vq = 30e9;
const buyEv = (user, sol, at = T + 30, mint = ROOT) => { vq += sol * 1e9; return payload(pumpIdl, "TradeEvent", {
  mint: new PublicKey(mint), user: new PublicKey(user), timestamp: new BN(at), is_buy: true, token_amount: new BN("1000000000"), sol_amount: new BN(Math.round(sol * 1e9)),
  quote_mint: ZERO, quote_amount: new BN(Math.round(sol * 1e9)), virtual_quote_reserves: new BN(vq), virtual_sol_reserves: new BN(vq), virtual_token_reserves: new BN("1000000000000000"),
  real_quote_reserves: new BN(vq - 30e9), real_sol_reserves: new BN(vq - 30e9), real_token_reserves: new BN("700000000000000"),
}); };

function world(trendGate) {
  const db = new Db(":memory:");
  const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load(); m.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] }); m.setSolUsd(100);
  const events = [];
  const ix = new Indexer({ rpc: { snapshot: () => ({}) }, model: m, meta: null, hub: { emit: (n, x) => events.push([n, x]) }, log: quiet, opts: { backfill: false, trendGate } });
  return { db, m, ix, events };
}
const CFG = { minCounted: 3, minInflowSol: 1, uni: 1, conc: 1 };
let s = 1000;
const feed = (ix, ev, slot = (s += 10)) => ix.onLogs({ slot, signature: `sig${slot}`, err: null, logs: frame(CURVE, ev) });

test("trend gate in the indexer, shadow: a dropped SOL launch is watched, passes on real buyers, is recorded, and the tree is unchanged", () => {
  const w = world({ mode: "shadow", cfg: CFG });
  feed(w.ix, createEv(), 1000);
  assert.equal(w.m.coins.has(ROOT), false, "still dropped from the tree");
  assert.equal(w.ix.gate.has(ROOT), true);
  for (const u of [key(130), key(131), key(132)]) feed(w.ix, buyEv(u, 0.5));
  const rec = w.db.trendGateRecent(0);
  assert.deepEqual(rec.map((r) => [r.mint, r.outcome, r.symbol, r.why.counted]), [[ROOT, "shadow", "ROOT", 3]]);
  assert.ok(rec[0].mcapUsd > 0);
  assert.equal(w.m.coins.has(ROOT), false, "shadow changes nothing");
  assert.equal(w.ix.snapshot().trendGate.passed, 1);
  w.db.close();
});

test("trend gate in the indexer, on: the passing launch is inserted with its kept trades, priced, without live trade events; the hourly cap holds", () => {
  const w = world({ mode: "on", cfg: CFG, perHour: 1 });
  feed(w.ix, createEv(), 1000);
  for (const u of [key(140), key(141), key(142)]) feed(w.ix, buyEv(u, 0.5));
  const c = w.m.get(ROOT);
  assert.ok(c && c.tracked, "inserted and tracked");
  assert.equal(c.depth, 0);
  const rows = w.db.db.prepare("SELECT sig, price_usd, value_usd FROM trades WHERE mint = ? ORDER BY slot").all(ROOT);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.price_usd > 0 && r.value_usd > 0));
  assert.equal(w.events.filter(([n]) => n === "trade").length, 0, "kept trades are not sent as live prints");
  feed(w.ix, buyEv(key(143), 0.2));
  assert.equal(w.db.db.prepare("SELECT count(*) n FROM trades WHERE mint = ?").get(ROOT).n, 4, "later trades take the normal path");
  assert.equal(w.events.filter(([n]) => n === "trade").length, 1);
  // a second launch passes inside the same hour: over the cap of 1, recorded as capped and not inserted
  const R2 = key(150);
  feed(w.ix, createEv(R2), (s += 10));
  for (const u of [key(151), key(152), key(153)]) feed(w.ix, buyEv(u, 0.5, T + 30, R2));
  assert.equal(w.db.trendGateRecent(0).find((r) => r.mint === R2)?.outcome, "capped");
  assert.equal(w.m.coins.has(R2), false);
  w.db.close();
});

test("trend gate off: nothing is watched and nothing is recorded", () => {
  const w = world(null);
  feed(w.ix, createEv(), 1000);
  assert.equal(w.ix.gate, null);
  for (const u of [key(160), key(161), key(162)]) feed(w.ix, buyEv(u, 0.5));
  assert.equal(w.db.trendGateRecent(0).length, 0);
  w.db.close();
});

test("trend gate in the indexer: a launch already cached by a look-up (untracked) is still watched and promoted", () => {
  const w = world({ mode: "on", cfg: CFG });
  const R3 = key(170);
  feed(w.ix, createEv(R3), (s += 10));
  w.m.upsertCoin({ mint: R3, depth: 0, quoteMint: null, tracked: false, virtualTokenReserves: "1", virtualQuoteReserves: "1", realTokenReserves: "0", realQuoteReserves: "0", tokenTotalSupply: "1000000000000000" });
  for (const u of [key(171), key(172), key(173)]) feed(w.ix, buyEv(u, 0.5, T + 30, R3));
  assert.equal(w.db.trendGateRecent(0).find((r) => r.mint === R3)?.outcome, "promoted");
  assert.equal(w.m.get(R3)?.tracked, true);
  w.db.close();
});
