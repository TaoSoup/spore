// Name waves in the indexer: every live CreateEvent reaches NameWaves.add once (a dropped SOL launch, a depth 1 spawn),
// a trend-gate promotion and a failed transaction do not add one, the curve stream's gap report reaches the counts (the
// hour turns partial), and without opts.waves nothing changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BN, PublicKey, pumpIdl } from "../lib/sdk.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer } from "../lib/indexer.mjs";
import { NameWaves } from "../lib/waves.mjs";
import { NameCounts, PARTIAL } from "../lib/name-counts.mjs";
import { payload, frame, key, CURVE } from "./helpers/chain.mjs";
import { PLATFORM, quiet } from "./helpers/tree.mjs";

const ZERO = new PublicKey(Buffer.alloc(32)), T = Math.floor(Date.now() / 1000) - 120;
const ROOT = key(220), CREATOR = key(221);
const createEv = (mint = ROOT, { depth = 0, quote = ZERO, name = "Root Coin" } = {}) => payload(pumpIdl, "CreateEvent", {
  name, symbol: "ROOT", uri: "", mint: new PublicKey(mint), bonding_curve: new PublicKey(key(222)), user: new PublicKey(CREATOR), creator: new PublicKey(CREATOR),
  timestamp: new BN(T), virtual_token_reserves: new BN("1073000000000000"), virtual_sol_reserves: new BN("30000000000"), real_token_reserves: new BN("793100000000000"),
  token_total_supply: new BN("1000000000000000"), quote_mint: quote, virtual_quote_reserves: new BN(0), depth,
});
let vq = 30e9;
const buyEv = (user, sol, mint = ROOT) => { vq += sol * 1e9; return payload(pumpIdl, "TradeEvent", {
  mint: new PublicKey(mint), user: new PublicKey(user), timestamp: new BN(T + 30), is_buy: true, token_amount: new BN("1000000000"), sol_amount: new BN(Math.round(sol * 1e9)),
  quote_mint: ZERO, quote_amount: new BN(Math.round(sol * 1e9)), virtual_quote_reserves: new BN(vq), virtual_sol_reserves: new BN(vq), virtual_token_reserves: new BN("1000000000000000"),
  real_quote_reserves: new BN(vq - 30e9), real_sol_reserves: new BN(vq - 30e9), real_token_reserves: new BN("700000000000000"),
}); };

function world({ trendGate = null, waves = true } = {}) {
  const db = new Db(":memory:");
  const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load(); m.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] }); m.setSolUsd(100);
  const w = waves ? new NameWaves({ db, model: m, log: quiet, cfg: { tickMs: 1e9, evidenceMs: 1e9, trimEveryMs: 1e9 } }).start() : null;
  const ix = new Indexer({ rpc: { snapshot: () => ({}) }, model: m, meta: null, hub: { emit() {} }, log: quiet, opts: { backfill: false, trendGate, waves: w } });
  return { db, m, ix, w };
}
let s = 5000;
const feed = (ix, ev, err = null) => ix.onLogs({ slot: (s += 10), signature: `sig${s}`, err, logs: frame(CURVE, ev) });

test("waves in the indexer: a dropped SOL launch and a depth 1 spawn each reach the waves once, with their creator and name", () => {
  const w = world();
  feed(w.ix, createEv());
  assert.equal(w.m.coins.has(ROOT), false, "dropped from the tree");
  w.m.upsertCoin({ mint: ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, creator: CREATOR, virtualTokenReserves: "1000000000000000", virtualQuoteReserves: "30000000000", realTokenReserves: "1", realQuoteReserves: "1", tokenTotalSupply: "1000000000000000" });
  const KID = key(223);
  feed(w.ix, createEv(KID, { depth: 1, quote: new PublicKey(ROOT), name: "Kid Coin" }));
  assert.ok(w.m.coins.has(KID), "the spawn joined the tree");
  assert.equal(w.w.stats.launches, 2);
  assert.deepEqual(w.w.a.map((x) => [x.mint, x.creator, x.name]), [[ROOT, CREATOR, "Root Coin"], [KID, CREATOR, "Kid Coin"]]);
  feed(w.ix, createEv(KID, { depth: 1, quote: new PublicKey(ROOT), name: "Kid Coin" }));
  assert.equal(w.w.stats.dup, 1, "a repeated create is counted once");
  w.ix.stop(); w.db.close();
});

test("waves in the indexer: a trend-gate promotion is not a second launch; a failed transaction is none", () => {
  const w = world({ trendGate: { mode: "on", cfg: { minCounted: 3, minInflowSol: 1, uni: 1, conc: 1 } } });
  feed(w.ix, createEv());
  for (const u of [key(230), key(231), key(232)]) feed(w.ix, buyEv(u, 0.5));
  assert.equal(w.m.get(ROOT)?.tracked, true, "promoted");
  assert.equal(w.w.stats.launches, 1);
  feed(w.ix, createEv(key(233)), { InstructionError: [0, "Custom"] });
  assert.equal(w.w.stats.launches, 1, "the failed create is not counted");
  w.ix.stop(); w.db.close();
});

test("waves in the indexer: without opts.waves nothing changes", () => {
  const w = world({ waves: false });
  assert.equal(w.ix.waves, null);
  assert.deepEqual(w.ix.curveGaps(), {}, "no fill and no waves: the stream gets no gap report, as before");
  feed(w.ix, createEv());
  assert.equal(w.m.coins.has(ROOT), false);
  w.db.close();
});

test("waves in the indexer: the curve stream's gap report reaches the counts and the hour it covers is partial (bit 2); the trade fill still hears it", async () => {
  const db = new Db(":memory:");
  const H = 498_600, clock = { s: H * 3600 - 60 };
  const counts = new NameCounts({ db, now: () => clock.s * 1000, log: quiet, cfg: { writeStepMs: 1e9, tickMs: 1e9, everyMs: 1e9, trimEveryMs: 1e9, firstMs: 1e9 } });
  const waves = new NameWaves({ db, counts, now: () => clock.s * 1000, log: quiet, cfg: { tickMs: 1e9, evidenceMs: 1e9, trimEveryMs: 1e9 } }).start();
  const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load();
  const fillGaps = [];
  m.tradeFill = { resumeAt: 123, addGap: (a, b) => fillGaps.push([a, b]) };
  const ix = new Indexer({ rpc: { snapshot: () => ({}) }, model: m, meta: null, hub: null, log: quiet, opts: { backfill: false, waves } });
  for (let i = 0; i < 150; i++) counts.add({ t: H * 3600 + 5 + i * 23, creator: `c${i}`, feats: [{ f: "veto", how: "w" }], nonAscii: false });
  const g = ix.curveGaps();
  assert.equal(g.resumeAt, 123);
  g.onGap((H * 3600 + 600) * 1000, (H * 3600 + 900) * 1000);
  assert.deepEqual(fillGaps, [[(H * 3600 + 600) * 1000, (H * 3600 + 900) * 1000]]);
  clock.s = (H + 1) * 3600 + 120; counts.tick();
  while (counts.queue.length) counts.pump();
  const [hr] = db.nameHoursIn(H, H + 1);
  assert.equal(hr.partial & PARTIAL.GAP, PARTIAL.GAP);
  assert.equal(hr.gapS, 300);
  await waves.stop(); db.close();
});
