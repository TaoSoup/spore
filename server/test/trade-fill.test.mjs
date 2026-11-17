// Trade gap fill (lib/trade-fill.mjs): the gaps the live streams report (margins, subtraction with immutable ids,
// pruning, the alive stamp), the trigger and queue (want), what is relevant to fill, the fill itself against a fake chain
// (live numbering, no side effects, rows of every tracked coin, a migrated coin, cut logs read from inner instructions,
// the listing walk with its jump and its cut), historical USD (edges, the parent filled whole), the caps, outages and
// restarts, the wallet hook, and the API fields. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradeFiller, FILL_MAX_GAPS, FILL_LOOKBACK_S, FILL_ALIVE_MS, FILL_SETTLE_S, FILL_MAX_QUEUE, FILL_RUN_CALLS, FILL_COIN_DAILY, FILL_WINDOW_SIGS, FILL_JUMP_TRADES, FILL_OUTAGE_PAUSE_MS, FILL_DAILY_MIN, FILL_RETRY_MS, FILL_CHUNK } from "../lib/trade-fill.mjs";
import { tradeOfEvent, bs58 } from "../lib/indexer.mjs";
import { EVENT_CPI_TAG, decodeEvent } from "../lib/decode.mjs";
import { createApp, buildCandles } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { PnlTracker } from "../lib/pnl-tracker.mjs";
import { units } from "../lib/pricing.mjs";
import { BN, PublicKey, pumpIdl } from "../lib/sdk.mjs";
import { PLATFORM, quiet } from "./helpers/tree.mjs";
import { key, CURVE, AMM, M, POOL, KID, NOPRICE, W, OTHER, T0, payload, poolEvent, curveTrade, frame, txOf, setup, fakeChain, fakeClock } from "./helpers/chain.mjs";

const NOW = T0 + 200_000;                              // s: the fake clock's start
const G = { from: NOW - 20_000, to: NOW - 19_000 };    // a stretch the streams missed (s), as reported
const GW = { from: G.from - 30, to: G.to + 30 };       // the same gap as stored (FILL_MARGIN_S on both sides)
const NOTRACK = key(99);                               // a coin outside the index
const DAY_MS = 86_400_000;

/** A tracked tree (helpers/chain.mjs setup), a fake chain listing per address (`sigsOf`), a fake clock, and a filler (not started). */
function world({ now = NOW, cfg = {}, sigsOf = new Map(), txs = new Map(), slotOf = null, onCall = null, streams = [] } = {}) {
  const { db, m, ix } = setup();
  const events = [];
  ix.hub = { emit: (ev, d) => events.push([ev, d]) };
  const chain = fakeChain([], txs, { sigsOf, slotOf, onCall });
  const clock = fakeClock(now * 1000);
  const make = (extra = {}) => new TradeFiller({ model: m, rpc: chain, cfg, streams: () => streams, now: clock.now, sleep: clock.sleep, log: quiet, ...extra });
  return { db, m, ix, chain, clock, fill: make(), make, events, sigsOf, txs };
}
const gap = (fill, from = G.from, to = G.to) => fill.addGap(from * 1000, to * 1000);
const sig = (signature, slot, blockTime, err = null) => ({ signature, slot, blockTime, err });
/** A row as the live path stored it earlier (a neighbour of a gap). */
const stored = (db, mint, s, time, { priceQuote = 1, priceUsd = 1, slot = 1, idx = 0 } = {}) => db.insertTrade({ sig: s, mint, idx, slot, time, isBuy: true, user: OTHER, baseAmount: "1", quoteAmount: "1", priceQuote, priceUsd, valueUsd: priceUsd });
const rowsOf = (db, mint) => db.db.prepare("SELECT sig, idx, slot, time, user, quote_amount AS quoteAmount, price_quote AS priceQuote, price_usd AS priceUsd, value_usd AS valueUsd FROM trades WHERE mint = ? ORDER BY time, rowid").all(mint);
const listings = (chain) => chain.calls.filter((c) => c.method === "getSignaturesForAddress");
const reads = (chain, s = null) => chain.calls.filter((c) => c.method === "getTransaction" && (s == null || c.params[0] === s)).length;
/** Asks for the coin's chart once and waits for its runs. */
async function fillOnce(fill, mint) { if (!fill.started) fill.start(); const r = fill.want(mint); await fill.idle(); return r; }
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-9, `${msg}: ${a} vs ${b}`);

// ---------------------------------------------------------------- gaps
test("gaps: margins applied; a gap overlapping existing ones keeps only its uncovered pieces under new ids (two streams after a boot → one gap plus the tail); ids never change", () => {
  const { db, m, fill } = world();
  // the curve stream's first notification after a boot: from the last alive stamp (ms) to it, widened 30 s each side
  fill.addGap((NOW - 5000) * 1000 + 400, (NOW - 4000) * 1000 + 1);
  assert.deepEqual(fill.gaps.gaps, [{ id: 1, from: NOW - 5030, to: NOW - 3969 }]);
  // the pool stream's, 9 s later: only the tail
  fill.addGap((NOW - 5000) * 1000, (NOW - 3990) * 1000);
  assert.deepEqual(fill.gaps.gaps, [{ id: 1, from: NOW - 5030, to: NOW - 3969 }, { id: 2, from: NOW - 3969, to: NOW - 3960 }]);
  // a third within a second of it: nothing over 1 s is left
  fill.addGap((NOW - 5000) * 1000, (NOW - 3989) * 1000 - 500);
  assert.equal(fill.gaps.gaps.length, 2);
  // a long one around both: its pieces before and after them, under new ids; the old gaps keep theirs
  fill.addGap((NOW - 6000) * 1000, (NOW - 3000) * 1000);
  assert.deepEqual(fill.gaps.gaps, [{ id: 1, from: NOW - 5030, to: NOW - 3969 }, { id: 2, from: NOW - 3969, to: NOW - 3960 }, { id: 3, from: NOW - 6030, to: NOW - 5030 }, { id: 4, from: NOW - 3960, to: NOW - 2970 }]);
  assert.deepEqual(db.kvGet("fillGaps"), { next: 5, gaps: fill.gaps.gaps }, "stored as it is");
  assert.deepEqual([fill.stats.gaps, fill.lastGap], [4, { from: NOW - 6030, to: NOW - 2970 }]);
  // older than the lookback: cut to it
  fill.addGap((NOW - 3 * 86_400) * 1000, (NOW - 100_000) * 1000);
  assert.deepEqual(fill.gaps.gaps[4], { id: 5, from: NOW - FILL_LOOKBACK_S, to: NOW - 99_970 });
  // nothing to start from, or a filler that is off: nothing recorded
  fill.addGap(0, NOW * 1000);
  const off = new TradeFiller({ model: m, rpc: null, now: () => NOW * 1000, log: quiet });
  off.addGap((NOW - 10) * 1000, NOW * 1000);
  assert.equal(off.gaps.gaps.length, 5); assert.equal(off.enabled, false);
  assert.equal(off.want(KID), null); assert.equal(db.kvGet("fillGaps").gaps.length, 5);
  db.close();
});

test("gaps: pruned past 48 h and past FILL_MAX_GAPS; a new TradeFiller reads them back; resumeAt from fillAlive, else pnlAlive×1000, else 0", () => {
  const w = world();
  assert.equal(w.fill.resumeAt, 0, "a first start knows of no earlier process");
  for (let i = 0; i <= FILL_MAX_GAPS; i++) w.fill.addGap((NOW - 100_000 + i * 100) * 1000, (NOW - 100_000 + i * 100 + 10) * 1000);
  assert.equal(w.fill.gaps.gaps.length, FILL_MAX_GAPS);
  assert.equal(Math.min(...w.fill.gaps.gaps.map((g) => g.id)), 2, "the oldest went");
  assert.deepEqual(w.make().gaps, w.fill.gaps, "read back by the next process");
  // later: the gaps that ended before the lookback go when a filler is made (and every hour after start)
  w.clock.t += 87_800 * 1000;
  const later = w.make(), cutoff = NOW + 87_800 - FILL_LOOKBACK_S;
  assert.equal(later.gaps.gaps.length, 151);
  assert.ok(later.gaps.gaps.every((g) => g.to >= cutoff));
  assert.equal(w.db.kvGet("fillGaps").gaps.length, 151);
  assert.equal(later.gaps.next, FILL_MAX_GAPS + 2, "ids are never reused");
  // the first gap of a start: the fill's own stamp, else the P&L tracker's (seconds), else none
  w.db.kvSet("pnlAlive", T0);
  assert.equal(w.make().resumeAt, T0 * 1000);
  w.db.kvSet("fillAlive", T0 * 1000 + 5);
  assert.equal(w.make().resumeAt, T0 * 1000 + 5);
  w.db.close();
});

test("alive: fillAlive = the oldest lastNotificationAt over the streams, not written until every stream delivered; stop() writes it", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const streams = [{ lastNotificationAt: 0 }, { lastNotificationAt: 0 }];
  const w = world({ streams });
  w.db.kvSet("fillAlive", 111);
  w.fill.start();
  assert.equal(w.db.kvGet("fillAlive"), 111, "no stream delivered yet: the old stamp stands");
  streams[1].lastNotificationAt = 5_000;
  t.mock.timers.tick(FILL_ALIVE_MS);
  assert.equal(w.db.kvGet("fillAlive"), 111, "one stream has not delivered in this process");
  streams[0].lastNotificationAt = 9_000;
  t.mock.timers.tick(FILL_ALIVE_MS);
  assert.equal(w.db.kvGet("fillAlive"), 5_000, "the stream that lags dates it");
  streams[1].lastNotificationAt = 12_000;
  w.fill.stop();
  assert.equal(w.db.kvGet("fillAlive"), 9_000);
  assert.equal(w.fill.snapshot().aliveAt, 9_000);
  assert.equal(w.make().resumeAt, 9_000, "where the next process's first gaps start");
  w.db.close();
});

test("indexer: start() passes resumeAt and onGap to both subscribers when model.tradeFill exists, and nothing when it does not", async () => {
  const Real = globalThis.WebSocket;
  globalThis.WebSocket = class { send() {} close() {} };
  const offline = (ix) => { for (const k of ["loadGlobal", "refreshSolUsd", "refreshQuoteUsd", "backfillPoolVq", "refreshPricingPools", "refresh", "catchUpMintInfo"]) ix[k] = async () => {}; return ix; };
  try {
    const w = world();
    w.db.kvSet("fillAlive", (NOW - 50) * 1000);
    const fill = w.make();
    assert.equal(w.m.tradeFill, fill);
    const ix = offline(w.ix);
    await ix.start();
    for (const sub of [ix.live, ix.livePools]) { assert.equal(sub.resumeAt, (NOW - 50) * 1000); assert.equal(typeof sub.onGap, "function"); }
    ix.livePools.onGap((NOW - 900) * 1000, (NOW - 800) * 1000);
    assert.deepEqual(fill.gaps.gaps, [{ id: 1, from: NOW - 930, to: NOW - 770 }]);
    ix.stop(); w.db.close();
    const bare = setup();
    assert.equal(bare.m.tradeFill, undefined);
    await offline(bare.ix).start();
    for (const sub of [bare.ix.live, bare.ix.livePools]) { assert.equal(sub.onGap, null); assert.equal(sub.resumeAt, 0); }
    bare.ix.stop(); bare.db.close();
  } finally { globalThis.WebSocket = Real; }
});

// ---------------------------------------------------------------- want() and relevance
test("want: no pending gap → null, no rpc call, nothing queued; a gap younger than FILL_SETTLE_S is not pending yet, answered 'waiting' (the chart keeps asking) and queued by the first ask after it settled", () => {
  const w = world();
  stored(w.db, KID, "OLD", NOW - 5000);
  assert.equal(w.fill.want(KID), null, "no gap at all");
  w.fill.addGap((NOW - 200) * 1000, (NOW - 40) * 1000); // stored up to NOW - 10
  const waiting = { state: "waiting", gaps: 1, from: NOW - 230, to: NOW - 10 };
  assert.deepEqual(w.fill.want(KID), waiting, "it just ended: live prints after the reconnect land first");
  w.clock.t += (FILL_SETTLE_S - 11) * 1000;
  assert.deepEqual(w.fill.want(KID), waiting);
  assert.deepEqual([w.fill.queue.size, w.db.fillCoin(KID)], [0, null], "nothing queued or marked");
  w.clock.t += 1000;
  assert.deepEqual(w.fill.want(KID), { state: "queued", gaps: 1, from: NOW - 230, to: NOW - 10 });
  // unknown, untracked, and a filler that is off: null
  assert.equal(w.fill.want(key(97)), null); assert.equal(w.fill.want(NOTRACK), null);
  assert.equal(w.chain.calls.length, 0, "nothing was read: the filler is not started");
  assert.equal(w.fill.queue.size, 1);
  assert.equal(w.fill.snapshot().stats.asked, 4);
  w.db.close();
});

test("want: gaps below the retention floor are marked done (not whole) with no rpc; gaps before the coin's first stored trade or its creation are left out unmarked; a coin created inside a gap is filled", async () => {
  const A = { from: NOW - 30 * 3600, to: NOW - 30 * 3600 + 600 }, B = { from: NOW - 10 * 3600, to: NOW - 10 * 3600 + 600 };
  const t = B.from + 100;
  const w = world({ sigsOf: new Map([["C_N", [sig("BORN", 700, t)]]]), txs: new Map([["BORN", txOf(frame(CURVE, curveTrade(NOPRICE, W, { at: t })), { slot: 700, blockTime: t })]]) });
  gap(w.fill, A.from, A.to); gap(w.fill, B.from, B.to);
  // KID: recorded long before A, and 2 000 newer rows: A lies below what its retention keeps
  stored(w.db, KID, "K0", A.from - 1000);
  w.db.transaction(() => { for (let i = 0; i < 2000; i++) stored(w.db, KID, `K${i + 1}`, NOW - 29 * 3600 + i); });
  // M: its first stored trade is after both gaps; NOPRICE: no trade, created inside B
  stored(w.db, M, "M0", B.to + 600);
  w.m.upsertCoin({ mint: NOPRICE, createdAt: t - 50 });
  assert.deepEqual(w.fill.want(KID), { state: "queued", gaps: 1, from: B.from - 30, to: B.to + 30 });
  assert.deepEqual([[...w.db.fillCoin(KID).done], [...w.db.fillCoin(KID).whole]], [[1], []], "A: below the retention floor");
  assert.equal(w.fill.want(M), null);
  assert.equal(w.db.fillCoin(M), null, "before M was recorded: left out, not marked (checked again on the next ask)");
  assert.deepEqual(w.fill.want(NOPRICE), { state: "queued", gaps: 1, from: B.from - 30, to: B.to + 30 });
  assert.equal(w.db.fillCoin(NOPRICE), null, "A is before NOPRICE was created");
  assert.equal(w.chain.calls.length, 0);
  assert.equal(w.fill.stats.windowsSkipped, 1);
  // the coin born inside B is filled, B done and whole
  w.fill.start(); await w.fill.idle();
  assert.deepEqual(rowsOf(w.db, NOPRICE).map((r) => r.sig), ["BORN"]);
  assert.deepEqual([[...w.db.fillCoin(NOPRICE).done], [...w.db.fillCoin(NOPRICE).whole]], [[2], [2]]);
  w.fill.stop(); w.db.close();
});

test("want: queued/running state with gaps/from/to; askedAt refreshed; the most recently asked runs first; the stalest drops from a full queue", async () => {
  let during = null;
  const w = world({ onCall: (method, params, calls) => { if (calls.length === 1) during = w.fill.want(coins[1]); } });
  const coins = Array.from({ length: FILL_MAX_QUEUE + 1 }, (_, i) => key(100 + i));
  const curve = { virtualTokenReserves: "1000000000000000", virtualQuoteReserves: "2000000000000000", realTokenReserves: "0", realQuoteReserves: "0", tokenTotalSupply: "1000000000000000", creator: "CR" };
  coins.forEach((mint, i) => { w.m.upsertCoin({ mint, curve: `CV${i}`, depth: 0, quoteMint: null, ...curve, tracked: true }); stored(w.db, mint, `o${i}`, G.from - 100); });
  gap(w.fill);
  for (const mint of coins) { w.clock.t += 1; assert.deepEqual(w.fill.want(mint), { state: "queued", gaps: 1, from: GW.from, to: GW.to }); }
  assert.equal(w.fill.queue.size, FILL_MAX_QUEUE);
  assert.equal(w.fill.queue.has(coins[0]), false, "the coin asked for longest ago left the full queue");
  assert.equal(w.fill.stats.displaced, 1);
  w.clock.t += 1;
  assert.deepEqual(w.fill.want(coins[1]), { state: "queued", gaps: 1, from: GW.from, to: GW.to });
  assert.equal(w.fill.queue.get(coins[1]).askedAt, w.clock.t, "asking again refreshes it");
  w.fill.start(); await w.fill.idle();
  assert.equal(listings(w.chain)[0].params[0], "CV1", "the most recently asked runs first");
  assert.deepEqual(during, { state: "running", gaps: 1, from: GW.from, to: GW.to });
  assert.equal(listings(w.chain)[1].params[0], `CV${FILL_MAX_QUEUE}`, "then the next most recent");
  assert.equal(w.fill.stats.runs, FILL_MAX_QUEUE);
  assert.equal(w.fill.want(coins[1]), null, "done: nothing pending");
  w.fill.stop(); w.db.close();
});

// ---------------------------------------------------------------- fill correctness
/** KID recorded before G, its curve's listing and transactions as given. */
function kidWorld(list, txs, opts = {}) {
  const w = world({ sigsOf: new Map([["C_K", list]]), txs: new Map(txs), ...opts });
  stored(w.db, KID, "B4", G.from - 100); stored(w.db, KID, "AF", G.to + 100);
  gap(w.fill);
  return w;
}

test("fill: a curve trade missed in a gap is stored with the live idx; replaying the same logs through ix.onLogs afterwards adds no row and emits no trade; and in the other order the fill reads nothing", async () => {
  const at = G.from + 10;
  const logs = frame(CURVE, curveTrade(NOTRACK, OTHER, { at }), curveTrade(KID, W, { at }));
  const make = () => kidWorld([sig("GAP", 500, at)], [["GAP", txOf(logs, { slot: 500, blockTime: at })]]);
  const w = make();
  await fillOnce(w.fill, KID);
  assert.deepEqual(rowsOf(w.db, KID).map((r) => [r.sig, r.idx, r.slot, r.time, r.user]), [["B4", 0, 1, G.from - 100, OTHER], ["GAP", 1, 500, at, W], ["AF", 0, 1, G.to + 100, OTHER]]);
  w.ix.onLogs({ slot: 500, signature: "GAP", err: null, logs });
  assert.equal(rowsOf(w.db, KID).length, 3, "the live delivery is the same row");
  assert.deepEqual(w.events.filter(([ev]) => ev === "trade"), []);
  assert.deepEqual([[...w.db.fillCoin(KID).done], [...w.db.fillCoin(KID).whole]], [[1], [1]]);
  w.fill.stop(); w.db.close();
  // live first: the fill lists the signature and reads nothing
  const v = make();
  v.ix.onLogs({ slot: 500, signature: "GAP", err: null, logs });
  await fillOnce(v.fill, KID);
  assert.equal(reads(v.chain), 0);
  assert.deepEqual(rowsOf(v.db, KID).map((r) => [r.sig, r.idx]), [["B4", 0], ["GAP", 1], ["AF", 0]]);
  assert.deepEqual([v.fill.stats.sigsStored, [...v.db.fillCoin(KID).whole]], [1, [1]]);
  v.fill.stop(); v.db.close();
});

test("fill: stored signatures and failed transactions are never fetched (getTransaction count)", async () => {
  const at = G.from + 10, tx = txOf(frame(CURVE, curveTrade(KID, W, { at })), { slot: 503, blockTime: at });
  const w = kidWorld([sig("NEW", 503, at), sig("FAILED", 502, at, { InstructionError: [0, "Custom"] }), sig("HAVE", 501, at)], [["NEW", tx], ["FAILED", tx], ["HAVE", tx]]);
  stored(w.db, KID, "HAVE", at);
  await fillOnce(w.fill, KID);
  assert.deepEqual(w.chain.calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0]), ["NEW"]);
  assert.deepEqual([w.fill.stats.sigsStored, w.fill.stats.sigsFailed, w.fill.stats.txRead, w.fill.stats.rows], [1, 1, 1, 1]);
  w.fill.stop(); w.db.close();
});

test("fill: no side effects — reserves, pool reserves, priceOf, updatedAt and indexer.hot unchanged, no hub event, activity.get unchanged, model.version unchanged", async () => {
  const at = G.from + 10;
  const logs = [...frame(CURVE, curveTrade(KID, W, { at, base: "9", quote: "99" })), ...frame(AMM, poolEvent("BuyEvent", W, { at, base: "7777", quote: "5555" }))];
  const w = kidWorld([sig("FX", 510, at)], [["FX", txOf(logs, { slot: 510, blockTime: at })]]);
  stored(w.db, M, "MB4", G.from - 100);
  const state = () => JSON.stringify({ kid: w.m.get(KID), m: w.m.get(M), pk: w.m.priceOf(KID), pm: w.m.priceOf(M), hot: [...w.ix.hot], v: w.m.version, act: [w.m.activity.get(KID), w.m.activity.get(M)], dirty: [...w.m.dirty] });
  const before = state();
  await fillOnce(w.fill, KID);
  assert.equal(rowsOf(w.db, KID).filter((r) => r.sig === "FX").length, 1); assert.equal(rowsOf(w.db, M).filter((r) => r.sig === "FX").length, 1);
  assert.equal(state(), before);
  assert.deepEqual(w.events, []);
  w.fill.stop(); w.db.close();
});

test("fill: multi-event tx (Create, a tracked curve trade, an untracked trade, a pool trade of another tracked coin) keeps live numbering and stores rows for every tracked mint (rowsOther)", async () => {
  const at = G.from + 10;
  const create = payload(pumpIdl, "CreateEvent", { mint: new PublicKey(key(98)), timestamp: new BN(at) });
  const logs = [...frame(CURVE, create, curveTrade(NOTRACK, OTHER, { at }), curveTrade(KID, W, { at })), ...frame(AMM, poolEvent("SellEvent", OTHER, { at }))];
  const w = kidWorld([sig("MULTI", 520, at)], [["MULTI", txOf(logs, { slot: 520, blockTime: at })]]);
  stored(w.db, M, "MB4", G.from - 100);
  await fillOnce(w.fill, KID);
  assert.deepEqual(rowsOf(w.db, KID).filter((r) => r.sig === "MULTI").map((r) => r.idx), [2]);
  assert.deepEqual(rowsOf(w.db, M).filter((r) => r.sig === "MULTI").map((r) => r.idx), [3]);
  assert.equal(w.fill.stats.rowsOther, 1);
  // both streams deliver the same transaction afterwards: the same rows
  w.ix.onLogs({ slot: 520, signature: "MULTI", err: null, logs }); w.ix.onLogs({ slot: 520, signature: "MULTI", err: null, logs }, new Set([AMM]));
  assert.equal(rowsOf(w.db, KID).length, 3); assert.equal(rowsOf(w.db, M).length, 2);
  w.fill.stop(); w.db.close();
});

test("fill: a coin that migrated inside the gap — curve and pool both listed, a shared signature read once, its pre-migration curve trade kept", async () => {
  const at = G.from + 10;
  const sigsOf = new Map([["C_M", [sig("S", 520, at + 20), sig("A", 510, at)]], [POOL, [sig("B", 530, at + 30), sig("S", 520, at + 20)]]]);
  const txs = new Map([
    ["A", txOf(frame(CURVE, curveTrade(M, W, { at })), { slot: 510, blockTime: at })],
    ["S", txOf(frame(AMM, poolEvent("BuyEvent", W, { at: at + 20 })), { slot: 520, blockTime: at + 20 })],
    ["B", txOf(frame(AMM, poolEvent("SellEvent", OTHER, { at: at + 30 })), { slot: 530, blockTime: at + 30 })],
  ]);
  const w = world({ sigsOf, txs });
  stored(w.db, M, "MB4", G.from - 100);
  gap(w.fill);
  assert.equal(w.m.get(M).migrated, true);
  await fillOnce(w.fill, M);
  assert.deepEqual(listings(w.chain).map((c) => c.params[0]), ["C_M", POOL]);
  assert.deepEqual(["A", "S", "B"].map((s) => reads(w.chain, s)), [1, 1, 1]);
  assert.deepEqual(rowsOf(w.db, M).map((r) => r.sig), ["MB4", "A", "S", "B"]);
  // the live path drops a migrated coin's curve trade: the fill keeps it (it happened before the migration)
  w.ix.onLogs({ slot: 510, signature: "A2", err: null, logs: frame(CURVE, curveTrade(M, W, { at })) });
  assert.equal(rowsOf(w.db, M).length, 4);
  w.fill.stop(); w.db.close();
});

test("fill: a truncated log in the chain answer is read from inner instructions, numbered like the stored live part", async () => {
  const at = G.from + 10;
  const buy = poolEvent("BuyEvent", OTHER, { at }), trade = curveTrade(KID, W, { at });
  const cut = [`Program ${AMM} invoke [1]`, `Program data: ${buy.toString("base64")}`, "Log truncated"];
  const keys = [W, CURVE, AMM];
  const inner = [[AMM, buy], [CURVE, trade]].map(([program, data], index) => ({ index, instructions: [{ programIdIndex: keys.indexOf(program), accounts: [], data: bs58(Buffer.concat([EVENT_CPI_TAG, data])), stackHeight: 2 }] }));
  const tx = { slot: 530, blockTime: at, transaction: { message: { accountKeys: keys } }, meta: { err: null, logMessages: cut, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: inner } };
  const w = kidWorld([sig("CUT", 530, at)], [["CUT", tx]]);
  stored(w.db, M, "MB4", G.from - 100);
  // the live stream got the cut log: the pool trade before the cut is stored, the curve trade behind it is not
  w.ix.onLogs({ slot: 530, signature: "CUT", err: null, logs: cut });
  assert.deepEqual(rowsOf(w.db, M).filter((r) => r.sig === "CUT").map((r) => r.idx), [0]);
  await fillOnce(w.fill, KID);
  assert.deepEqual(rowsOf(w.db, KID).filter((r) => r.sig === "CUT").map((r) => r.idx), [1]);
  assert.deepEqual(rowsOf(w.db, M).filter((r) => r.sig === "CUT").map((r) => r.idx), [0], "the live part is the same row");
  assert.deepEqual([w.fill.stats.txInner, w.fill.stats.txUnread, [...w.db.fillCoin(KID).whole]], [1, 0, [1]]);
  w.fill.stop(); w.db.close();
});

test("listing: the cursor covers several gaps with one page for a quiet coin; a busy coin jumps to the first stored trade after the gap; an empty anchored page falls back to an unanchored listing once (jumpMisses)", async () => {
  // quiet: three gaps, one short page lists them all
  const gaps = [[NOW - 30_000, NOW - 29_000], [NOW - 20_000, NOW - 19_000], [NOW - 10_000, NOW - 9_000]];
  const ins = gaps.map(([a], i) => sig(`in${i}`, 600 + i * 10, a + 100));
  const list = [sig("top", 700, NOW - 5_000), ins[2], sig("mid", 615, NOW - 15_000), ins[1], ins[0], sig("old", 590, NOW - 40_000)];
  const txs = ins.map((s) => [s.signature, txOf(frame(CURVE, curveTrade(KID, W, { at: s.blockTime })), { slot: s.slot, blockTime: s.blockTime })]);
  const w = world({ sigsOf: new Map([["C_K", list]]), txs: new Map(txs) });
  stored(w.db, KID, "B4", NOW - 50_000);
  for (const [a, b] of gaps) gap(w.fill, a, b);
  await fillOnce(w.fill, KID);
  assert.equal(listings(w.chain).length, 1);
  assert.deepEqual(rowsOf(w.db, KID).map((r) => r.sig), ["B4", "in0", "in1", "in2"]);
  assert.deepEqual([...w.db.fillCoin(KID).whole].sort(), [1, 2, 3]);
  w.fill.stop(); w.db.close();
  // busy: FILL_JUMP_TRADES stored trades after the gap; the listing starts below the first of them
  const busy = (slotOf) => {
    const at = G.from + 50;
    const v = kidWorld([sig("X1", 950, G.to + 500), sig("IN", 800, at), sig("OLD", 700, G.from - 500)], [["IN", txOf(frame(CURVE, curveTrade(KID, W, { at })), { slot: 800, blockTime: at })]], { slotOf });
    v.db.transaction(() => { stored(v.db, KID, "ANCHOR", G.to + 60); for (let i = 1; i < FILL_JUMP_TRADES; i++) stored(v.db, KID, `busy${i}`, G.to + 60 + i); });
    return v;
  };
  const j = busy(new Map([["ANCHOR", 900]])); // ANCHOR is no signature of this curve: the node lists below its slot
  await fillOnce(j.fill, KID);
  assert.deepEqual(listings(j.chain).map((c) => c.params[1].before ?? null), ["ANCHOR"]);
  assert.deepEqual([j.fill.stats.jumps, j.fill.stats.jumpMisses, reads(j.chain), reads(j.chain, "IN")], [1, 0, 1, 1]);
  assert.deepEqual([...j.db.fillCoin(KID).whole], [1]);
  j.fill.stop(); j.db.close();
  const miss = busy(new Map()); // a node that does not know the anchor answers []: listed once more from the top
  await fillOnce(miss.fill, KID);
  assert.deepEqual(listings(miss.chain).map((c) => c.params[1].before ?? null), ["ANCHOR", null]);
  assert.deepEqual([miss.fill.stats.jumps, miss.fill.stats.jumpMisses, reads(miss.chain, "IN")], [1, 1, 1]);
  assert.ok(rowsOf(miss.db, KID).some((r) => r.sig === "IN"));
  miss.fill.stop(); miss.db.close();
});

test("listing: past FILL_WINDOW_SIGS the gap is done and cut, not whole", async () => {
  const list = Array.from({ length: FILL_WINDOW_SIGS + 500 }, (_, i) => sig(`f${i}`, 100_000 - i, GW.to - (i % 1000), { InstructionError: [0, "Custom"] }));
  const w = kidWorld(list, []);
  await fillOnce(w.fill, KID);
  assert.equal(listings(w.chain).length, FILL_WINDOW_SIGS / 1000);
  const row = w.db.fillCoin(KID);
  assert.deepEqual([[...row.done], [...row.whole], row.cut], [[1], [], 1]);
  assert.deepEqual([w.fill.stats.windowsCut, w.fill.stats.windowsDone, w.fill.stats.sigsFailed, reads(w.chain)], [1, 0, FILL_WINDOW_SIGS, 0]);
  w.fill.stop(); w.db.close();
});

// ---------------------------------------------------------------- pricing
test("price: priceQuote from the event (curve reserves; pool reserves + poolVirtualQuote) equals what the live path stores for the same event", async () => {
  const at = G.from + 10;
  const curveLogs = frame(CURVE, curveTrade(KID, W, { at, base: "123456", quote: "7890" })), poolLogs = frame(AMM, poolEvent("BuyEvent", W, { at, base: "3333", quote: "4444" }));
  const live = setup();
  live.m.upsertCoin({ mint: M, poolVirtualQuote: "5000000000" });
  live.ix.onLogs({ slot: 540, signature: "PC", err: null, logs: curveLogs }); live.ix.onLogs({ slot: 541, signature: "PP", err: null, logs: poolLogs }, new Set([AMM]));
  const want = { PC: rowsOf(live.db, KID)[0].priceQuote, PP: rowsOf(live.db, M)[0].priceQuote };
  const w = world({ sigsOf: new Map([["C_K", [sig("PC", 540, at)]], [POOL, [sig("PP", 541, at)]]]), txs: new Map([["PC", txOf(curveLogs, { slot: 540, blockTime: at })], ["PP", txOf(poolLogs, { slot: 541, blockTime: at })]]) });
  w.m.upsertCoin({ mint: M, poolVirtualQuote: "5000000000" });
  stored(w.db, KID, "B4", G.from - 100); stored(w.db, M, "MB4", G.from - 100);
  gap(w.fill);
  await fillOnce(w.fill, KID);
  assert.equal(rowsOf(w.db, KID).find((r) => r.sig === "PC").priceQuote, want.PC);
  assert.equal(rowsOf(w.db, M).find((r) => r.sig === "PP").priceQuote, want.PP);
  // and that is the event's own price: tradeOfEvent on the decoded event, whatever the coin's state now
  const e = decodeEvent("BuyEvent", poolEvent("BuyEvent", W, { at, base: "3333", quote: "4444" }));
  assert.equal(tradeOfEvent(w.m, w.m.get(M), "BuyEvent", e, { sig: "PP", slot: 541, idx: 0, time: at }).priceQuote, want.PP);
  assert.notEqual(tradeOfEvent(w.m, { ...w.m.get(M), poolVirtualQuote: "0" }, "BuyEvent", e, { sig: "PP", slot: 541, idx: 0, time: at }).priceQuote, want.PP, "the pool's virtual quote counts");
  live.db.close(); w.fill.stop(); w.db.close();
});

/** M (a SOL coin on its pool) with the given neighbour rows, one pool trade of it filled in G: that row. */
async function priceM({ rows = [], createdAt = null, solUsd = 100 } = {}) {
  const at = G.from + 400;
  const w = world({ sigsOf: new Map([[POOL, [sig("PM", 550, at)]]]), txs: new Map([["PM", txOf(frame(AMM, poolEvent("SellEvent", W, { at, quote: "2000000000" })), { slot: 550, blockTime: at })]]) });
  w.m.setSolUsd(solUsd);
  if (createdAt != null) w.m.upsertCoin({ mint: M, createdAt });
  for (const [s, time, priceQuote, priceUsd] of rows) stored(w.db, M, s, time, { priceQuote, priceUsd });
  gap(w.fill);
  await fillOnce(w.fill, M);
  const r = rowsOf(w.db, M).find((x) => x.sig === "PM");
  w.fill.stop();
  return { ...r, w };
}

test("price: SOL coin — k interpolated between the edge rows' priceUsd/priceQuote; one edge → that k; no neighbours → today's quoteUsdOf; neighbours without USD → null; buildCandles stays \"usd\"", async () => {
  const b = G.from - 100, a = G.to + 100, at = G.from + 400;
  const both = await priceM({ rows: [["MB", b, 2e-7, 2e-5], ["MA", a, 4e-7, 8e-5]] }); // k 100 before, 200 after
  const k = 100 + 100 * ((at - b) / (a - b));
  near(both.priceUsd, both.priceQuote * k, "interpolated");
  near(both.valueUsd, units("2000000000", 9) * k, "value at the same k");
  assert.equal(buildCandles(both.w.db.tradesSince(M, 0), 60).priceKey, "usd", "every row has USD: the chart stays in USD");
  assert.deepEqual(both.w.fill.stats.priced, { parent: 0, edges: 1, now: 0, none: 0 });
  both.w.db.close();
  const one = await priceM({ rows: [["MB", b, 2e-7, 3e-5]] });
  near(one.priceUsd, one.priceQuote * 150, "the one edge's k");
  one.w.db.close();
  const none = await priceM({ createdAt: at - 50, solUsd: 123 }); // born in the gap: no row of it anywhere
  near(none.priceUsd, none.priceQuote * 123, "today's SOL price");
  assert.equal(none.w.fill.stats.priced.now, 1);
  none.w.db.close();
  const quoteOnly = await priceM({ rows: [["MB", b, 2e-7, null], ["MA", a, 4e-7, null]] });
  assert.deepEqual([quoteOnly.priceUsd, quoteOnly.valueUsd], [null, null]);
  assert.equal(quoteOnly.w.fill.stats.priced.none, 1);
  assert.equal(buildCandles(quoteOnly.w.db.tradesSince(M, 0), 60).priceKey, "quote", "as the neighbours already were");
  quoteOnly.w.db.close();
});

test("price: child of a tracked parent — parent filled first in the same job; with the parent's gap whole the child's priceUsd = priceQuote × parent priceUsd at T; with the parent's gap cut → edge rule", async () => {
  const mAt = G.from + 10, kAt = G.from + 20;
  const make = (poolList) => {
    const w = world({
      sigsOf: new Map([[POOL, poolList], ["C_K", [sig("KT", 620, kAt)]]]),
      txs: new Map([["MT", txOf(frame(AMM, poolEvent("BuyEvent", W, { at: mAt })), { slot: 610, blockTime: mAt })], ["KT", txOf(frame(CURVE, curveTrade(KID, W, { at: kAt })), { slot: 620, blockTime: kAt })]]),
    });
    stored(w.db, M, "MB", G.from - 100, { priceQuote: 2e-7, priceUsd: 2e-5 }); stored(w.db, M, "MA", G.to + 100, { priceQuote: 2e-7, priceUsd: 2e-5 });
    stored(w.db, KID, "KB", G.from - 100, { priceQuote: 2, priceUsd: 6e-5 }); stored(w.db, KID, "KA", G.to + 100, { priceQuote: 2, priceUsd: 6e-5 }); // k 3e-5 at both edges
    gap(w.fill);
    return w;
  };
  const w = make([sig("MT", 610, mAt)]);
  await fillOnce(w.fill, KID);
  assert.deepEqual(listings(w.chain).map((c) => c.params[0]), ["C_M", POOL, "C_K"], "the parent first");
  const mt = rowsOf(w.db, M).find((r) => r.sig === "MT"), kt = rowsOf(w.db, KID).find((r) => r.sig === "KT");
  near(mt.priceUsd, mt.priceQuote * 100, "the parent by its own edges (k = 100)");
  assert.deepEqual([...w.db.fillCoin(M).whole], [1]);
  near(kt.priceUsd, kt.priceQuote * mt.priceUsd, "the child at the parent's price at its time");
  near(kt.valueUsd, units("700", 6) * mt.priceUsd, "its value too");
  assert.equal(w.fill.stats.priced.parent, 1);
  w.fill.stop(); w.db.close();
  // the parent's gap cut (more signatures than FILL_WINDOW_SIGS): the child by its own edges
  const cut = make(Array.from({ length: FILL_WINDOW_SIGS }, (_, i) => sig(`e${i}`, 100_000 - i, GW.to - (i % 1000), { InstructionError: [0, "Custom"] })));
  await fillOnce(cut.fill, KID);
  assert.deepEqual([[...cut.db.fillCoin(M).done], [...cut.db.fillCoin(M).whole]], [[1], []]);
  const kc = rowsOf(cut.db, KID).find((r) => r.sig === "KT");
  near(kc.priceUsd, kc.priceQuote * 3e-5, "the child's own edges");
  assert.equal(cut.fill.stats.priced.parent, 0);
  cut.fill.stop(); cut.db.close();
});

// ---------------------------------------------------------------- budgets, failures, restarts
/** KID with `n` trades in G, one a transaction, newest first. */
const manyTrades = (n, { prefix = "c", at = (i) => GW.to - 1 - i } = {}) => {
  const list = Array.from({ length: n }, (_, i) => sig(`${prefix}${i}`, 10_000 - i, at(i)));
  return { list, txs: list.map((s) => [s.signature, txOf(frame(CURVE, curveTrade(KID, OTHER, { at: s.blockTime })), { slot: s.slot, blockTime: s.blockTime })]) };
};

test("caps: FILL_RUN_CALLS stops mid-gap with whole chunks stored, the gap pending; the next want/run lists again and reads only the missing signatures", async () => {
  const { list, txs } = manyTrades(320);
  const w = kidWorld(list, txs);
  await fillOnce(w.fill, KID);
  // 1 listing + 299 reads: 14 whole chunks stored, the 15th was under way when the run's calls ran out
  assert.equal(w.chain.calls.length, FILL_RUN_CALLS);
  assert.equal(rowsOf(w.db, KID).length - 2, 280);
  assert.equal(w.fill.stats.runCaps, 1);
  assert.deepEqual([...w.db.fillCoin(KID).done], [], "pending");
  assert.equal(w.db.fillCoin(KID).calls, FILL_RUN_CALLS, "the coin's calls are counted");
  assert.equal((await fillOnce(w.fill, KID)).state, "running");
  assert.equal(rowsOf(w.db, KID).length - 2, 320);
  assert.equal(listings(w.chain).length, 2);
  assert.ok(list.slice(-280).every((s) => reads(w.chain, s.signature) === 1), "a stored one (the oldest first) is not read again");
  assert.equal(reads(w.chain), 299 + 40);
  assert.deepEqual([[...w.db.fillCoin(KID).done], [...w.db.fillCoin(KID).whole]], [[1], [1]]);
  w.fill.stop(); w.db.close();
});

test("budget: the day's cap pauses until the next UTC day and fillCalls survives a new instance; FILL_COIN_DAILY stops one coin while another still runs", async () => {
  const { list, txs } = manyTrades(250);
  const w = kidWorld(list, txs, { cfg: { dailyCalls: 50 } });
  assert.equal(w.fill.cfg.dailyCalls, FILL_DAILY_MIN, "a smaller cap counts as the least");
  await fillOnce(w.fill, KID);
  const day = Math.floor(NOW * 1000 / DAY_MS);
  assert.equal(w.chain.calls.length, FILL_DAILY_MIN);
  assert.equal(rowsOf(w.db, KID).length - 2, 180, "9 whole chunks");
  assert.equal(w.fill.stats.budgetStops, 1);
  assert.equal(w.fill.pauseUntil, (day + 1) * DAY_MS + 1000, "until the next UTC day");
  assert.deepEqual(w.db.kvGet("fillCalls"), { day, used: FILL_DAILY_MIN });
  assert.equal(w.fill.want(KID), null, "spent: not queued");
  w.fill.stop();
  const next = w.make();
  assert.equal(next.snapshot().callsToday, FILL_DAILY_MIN, "kept across a restart");
  assert.equal(next.want(KID), null);
  w.clock.t = (day + 1) * DAY_MS + 5;
  assert.equal(next.want(KID)?.state, "queued", "a new UTC day");
  w.db.close();
  // the coin's own daily cap: that coin waits, another runs; a parent at its cap is left as it is and the child still fills
  const at = G.from + 10;
  const v = world({ sigsOf: new Map([["C_K", [sig("KT", 620, at)]], [POOL, [sig("MT", 610, at)]]]), txs: new Map([["KT", txOf(frame(CURVE, curveTrade(KID, W, { at })), { slot: 620, blockTime: at })], ["MT", txOf(frame(AMM, poolEvent("BuyEvent", W, { at })), { slot: 610, blockTime: at })]]) });
  stored(v.db, KID, "KB", G.from - 100); stored(v.db, M, "MB", G.from - 100);
  gap(v.fill);
  const capped = (mint) => v.db.fillCoinSave({ mint, done: new Set(), whole: new Set(), day, calls: FILL_COIN_DAILY, rows: 0, unread: 0, cut: 0, at: NOW });
  capped(KID);
  v.fill.start();
  assert.equal(v.fill.want(KID), null, "KID spent its calls today");
  await fillOnce(v.fill, M);
  assert.ok(rowsOf(v.db, M).some((r) => r.sig === "MT"), "M still runs");
  assert.equal(reads(v.chain, "KT"), 0);
  v.fill.stop(); v.db.close();
  const p = world({ sigsOf: new Map([["C_K", [sig("KT", 620, at)]], [POOL, [sig("MT", 610, at)]]]), txs: new Map([["KT", txOf(frame(CURVE, curveTrade(KID, W, { at })), { slot: 620, blockTime: at })], ["MT", txOf(frame(AMM, poolEvent("BuyEvent", W, { at })), { slot: 610, blockTime: at })]]) });
  stored(p.db, KID, "KB", G.from - 100); stored(p.db, M, "MB", G.from - 100);
  gap(p.fill);
  p.db.fillCoinSave({ mint: M, done: new Set(), whole: new Set(), day, calls: FILL_COIN_DAILY, rows: 0, unread: 0, cut: 0, at: NOW });
  await fillOnce(p.fill, KID);
  assert.deepEqual([reads(p.chain, "MT"), p.fill.stats.coinCaps], [0, 1], "the parent is skipped");
  assert.ok(rowsOf(p.db, KID).some((r) => r.sig === "KT"), "the child is filled");
  assert.deepEqual([...p.db.fillCoin(KID).whole], [1]);
  p.fill.stop(); p.db.close();
});

test("outage: 5 unanswered reads in a row stop the run, keep stored chunks, leave the gap pending, pause 30 s; a later run completes it; a gap with one unanswered read stays pending, one with an unread (answered null / incomplete) tx is done but not whole", async () => {
  let down = true;
  const { list, txs } = manyTrades(25);
  const flaky = txs.map(([s, tx], i) => [s, i < 5 ? () => (down ? new Error("node down") : tx) : tx]); // the newest 5: the second chunk (oldest first)
  const w = kidWorld(list, flaky);
  await fillOnce(w.fill, KID);
  assert.equal(rowsOf(w.db, KID).length - 2, 20, "the first chunk is kept");
  assert.equal(w.fill.stats.outages, 1);
  assert.deepEqual([...w.db.fillCoin(KID).done], []);
  assert.equal(w.fill.snapshot().pausedMs, FILL_OUTAGE_PAUSE_MS);
  down = false;
  const t0 = w.clock.t;
  await fillOnce(w.fill, KID);
  assert.ok(w.clock.t - t0 >= FILL_OUTAGE_PAUSE_MS, "the run waited out the pause");
  assert.equal(rowsOf(w.db, KID).length - 2, 25);
  assert.deepEqual([...w.db.fillCoin(KID).whole], [1]);
  w.fill.stop(); w.db.close();
  // three gaps: one transaction never answered, one answered null, one without its log or inner instructions
  const g = [[NOW - 30_000, NOW - 29_000], [NOW - 25_000, NOW - 24_000], [NOW - 10_000, NOW - 9_000]];
  const v = kidWorld([sig("INCOMPLETE", 900, g[2][0] + 10), sig("NULL", 800, g[1][0] + 10), sig("DOWN", 700, g[0][0] + 10)],
    [["INCOMPLETE", { slot: 900, blockTime: g[2][0] + 10, meta: { err: null, logMessages: null } }], ["NULL", null], ["DOWN", new Error("node down")]]);
  stored(v.db, KID, "B0", NOW - 40_000);
  for (const [a, b] of g) gap(v.fill, a, b);
  const ids = v.fill.gaps.gaps.map((x) => x.id); // 1 = G (from kidWorld), then g[0..2]
  await fillOnce(v.fill, KID);
  const row = v.db.fillCoin(KID);
  assert.deepEqual([[...row.done].sort(), [...row.whole].sort()], [[ids[0], ids[2], ids[3]].sort(), [ids[0]]]);
  assert.equal(row.unread, 2);
  assert.deepEqual([v.fill.stats.outages, reads(v.chain, "DOWN"), reads(v.chain, "NULL")], [0, 3, 3]);
  // the unanswered one is still pending; the run stored nothing past it, so the coin is put aside for FILL_RETRY_MS
  assert.deepEqual([v.fill.want(KID), v.fill.stats.stuck], [null, 1]);
  v.clock.t += FILL_RETRY_MS;
  assert.equal(v.fill.want(KID)?.state, "running", "then asked for again");
  await v.fill.idle();
  v.fill.stop(); v.db.close();
});

test("restart: stop() during chunk 2; done/whole persist in fill_coins; a done gap is never listed again; fill_coins rows older than 48 h are pruned", async () => {
  const { list, txs } = manyTrades(30);
  let stopAt = 25, w;
  w = kidWorld(list, txs, { onCall: (method, params, calls) => { if (method === "getTransaction" && calls.filter((c) => c.method === "getTransaction").length === stopAt) w.fill.stop(); } });
  await fillOnce(w.fill, KID);
  assert.equal(rowsOf(w.db, KID).length - 2, 20, "chunk 1 stored, chunk 2 not");
  assert.deepEqual([...w.db.fillCoin(KID).done], []);
  stopAt = -1;
  const next = w.make();
  await fillOnce(next, KID);
  assert.equal(rowsOf(w.db, KID).length - 2, 30);
  assert.deepEqual([[...w.db.fillCoin(KID).done], [...w.db.fillCoin(KID).whole]], [[1], [1]]);
  next.stop();
  const n = listings(w.chain).length;
  const third = w.make();
  assert.equal(await fillOnce(third, KID), null);
  assert.equal(listings(w.chain).length, n, "a done gap is never listed again");
  third.stop();
  w.clock.t += (FILL_LOOKBACK_S + 3600) * 1000;
  w.make().start().stop();
  assert.equal(w.db.fillCoin(KID), null, "pruned");
  assert.equal(w.db.kvGet("fillGaps").gaps.length, 0);
  w.db.close();
});

// ---------------------------------------------------------------- review fixes
test("want: a gap left out as 'not recorded' is checked again — a creation time found later, or an older gap the coin was born in once that one is filled", async () => {
  const A = { from: NOW - 30_000, to: NOW - 29_000 }, B = { from: NOW - 20_000, to: NOW - 19_000 };
  const w = world({
    sigsOf: new Map([["C_N", [sig("TB", 720, B.from + 10), sig("TA", 700, A.from + 100)]]]),
    txs: new Map([["TB", txOf(frame(CURVE, curveTrade(NOPRICE, W, { at: B.from + 10 })), { slot: 720, blockTime: B.from + 10 })], ["TA", txOf(frame(CURVE, curveTrade(NOPRICE, W, { at: A.from + 100 })), { slot: 700, blockTime: A.from + 100 })]]),
  });
  gap(w.fill, A.from, A.to); gap(w.fill, B.from, B.to);
  stored(w.db, NOPRICE, "LIVE", B.to + 600); // its first live row: after both gaps
  // no creation time yet (the boot probe has not reached it): nothing pending, nothing marked
  assert.equal(w.fill.want(NOPRICE), null);
  assert.equal(w.db.fillCoin(NOPRICE), null);
  // the probe finds it was created inside A: A is pending now; B is not yet (no row before it)
  w.m.upsertCoin({ mint: NOPRICE, createdAt: A.from + 50 });
  assert.deepEqual(w.fill.want(NOPRICE), { state: "queued", gaps: 1, from: A.from - 30, to: A.to + 30 });
  w.fill.start(); await w.fill.idle();
  assert.deepEqual(rowsOf(w.db, NOPRICE).map((r) => r.sig), ["TA", "LIVE"]);
  // A's rows make B recorded: the next ask fills it
  assert.deepEqual(w.fill.want(NOPRICE), { state: "running", gaps: 1, from: B.from - 30, to: B.to + 30 });
  await w.fill.idle();
  assert.deepEqual(rowsOf(w.db, NOPRICE).map((r) => r.sig), ["TA", "TB", "LIVE"]);
  assert.deepEqual([...w.db.fillCoin(NOPRICE).whole].sort(), [1, 2]);
  w.fill.stop(); w.db.close();
});

test("want: a busy coin whose rows before a gap were removed by retention still fills the gap's part inside the retained day", async () => {
  const A = { from: NOW - 28 * 3600, to: NOW - 20 * 3600 }, at = NOW - 21 * 3600;
  const w = world({ sigsOf: new Map([["C_K", [sig("IN", 800, at)]]]), txs: new Map([["IN", txOf(frame(CURVE, curveTrade(KID, W, { at })), { slot: 800, blockTime: at })]]), slotOf: new Map([["K0", 900]]) });
  gap(w.fill, A.from, A.to);
  // 2 000 rows since the gap (the retention cap), none before it: the older ones were trimmed
  w.db.transaction(() => { for (let i = 0; i < 2000; i++) stored(w.db, KID, `K${i}`, A.to + 100 + i * 30); });
  assert.deepEqual(w.fill.want(KID), { state: "queued", gaps: 1, from: A.from - 30, to: A.to + 30 });
  w.fill.start(); await w.fill.idle();
  assert.ok(rowsOf(w.db, KID).some((r) => r.sig === "IN"));
  assert.deepEqual([...w.db.fillCoin(KID).done], [1]);
  w.fill.stop(); w.db.close();
});

test("listing: an empty anchored page for an address with no history that old (a pool made after the gap) ends its walk; an anchor the node does not know falls back unanchored and is cut after FILL_WINDOW_SIGS above the gap", async () => {
  const at = G.from + 50;
  const make = (anchorKnown) => {
    const curve = [...(anchorKnown ? [sig("ANCHOR", 900, G.to + 60)] : []), sig("IN", 800, at), sig("OLD", 700, G.from - 500)];
    const pool = Array.from({ length: 6000 }, (_, i) => sig(`p${i}`, 100_000 - i, NOW - i, { InstructionError: [0, "Custom"] })); // all after the gap
    const w = world({ sigsOf: new Map([["C_M", curve], [POOL, pool]]), txs: new Map([["IN", txOf(frame(CURVE, curveTrade(M, W, { at })), { slot: 800, blockTime: at })]]), slotOf: anchorKnown ? new Map([["ANCHOR", 900]]) : null });
    stored(w.db, M, "MB4", G.from - 100);
    w.db.transaction(() => { stored(w.db, M, "ANCHOR", G.to + 60); for (let i = 1; i < FILL_JUMP_TRADES; i++) stored(w.db, M, `busy${i}`, G.to + 60 + i); });
    gap(w.fill);
    return w;
  };
  const poolListings = (w) => listings(w.chain).filter((c) => c.params[0] === POOL).map((c) => c.params[1].before ?? null);
  const k = make(true);
  await fillOnce(k.fill, M);
  assert.deepEqual(poolListings(k), ["ANCHOR"], "the pool is not walked from the top");
  assert.deepEqual([k.fill.stats.jumps, k.fill.stats.jumpMisses, k.chain.count("getSignatureStatuses")], [2, 0, 1]);
  assert.ok(rowsOf(k.db, M).some((r) => r.sig === "IN"));
  assert.deepEqual([[...k.db.fillCoin(M).done], [...k.db.fillCoin(M).whole]], [[1], [1]]);
  k.fill.stop(); k.db.close();
  const u = make(false);
  await fillOnce(u.fill, M);
  assert.equal(poolListings(u).length, 1 + FILL_WINDOW_SIGS / 1000, "unanchored, cut after FILL_WINDOW_SIGS above the gap");
  assert.equal(u.fill.stats.jumpMisses, 2);
  assert.ok(rowsOf(u.db, M).some((r) => r.sig === "IN"), "the curve's trade is still read");
  assert.deepEqual([[...u.db.fillCoin(M).done], [...u.db.fillCoin(M).whole]], [[1], []]);
  u.fill.stop(); u.db.close();
});

test("caps: a worker still reading when the other hits a cap makes no further call (nothing is charged to the next member)", async () => {
  const at = G.from + 10;
  const pool = Array.from({ length: 20 }, (_, i) => sig(`mp${i}`, 900 - i, at + 20 - i));
  const txs = new Map([...pool.map((s) => [s.signature, txOf(frame(AMM, poolEvent("BuyEvent", OTHER, { at: s.blockTime })), { slot: s.slot, blockTime: s.blockTime })]), ["KT", txOf(frame(CURVE, curveTrade(KID, W, { at })), { slot: 620, blockTime: at })]]);
  const w = world({ sigsOf: new Map([[POOL, pool], ["C_K", [sig("KT", 620, at)]]]), txs, onCall: () => new Promise((r) => setTimeout(r, 5)) });
  stored(w.db, M, "MB", G.from - 100); stored(w.db, KID, "KB", G.from - 100);
  gap(w.fill);
  const day = Math.floor(NOW * 1000 / DAY_MS);
  w.db.fillCoinSave({ mint: M, done: new Set(), whole: new Set(), day, calls: FILL_COIN_DAILY - 3, rows: 0, unread: 0, cut: 0, at: NOW });
  await fillOnce(w.fill, KID);
  assert.equal(w.chain.calls.filter((c) => c.method === "getTransaction" && c.params[0].startsWith("mp")).length, 1, "the parent's one read in flight, no more");
  assert.equal(w.db.fillCoin(KID).calls, 2, "the child: its listing and its read");
  assert.ok(rowsOf(w.db, KID).some((r) => r.sig === "KT"));
  w.fill.stop(); w.db.close();
});

test("caps: a parent at its run cap is left as it is and the coin asked for is still filled in the same job", async () => {
  const at = G.from + 10;
  const pool = Array.from({ length: 320 }, (_, i) => sig(`mp${i}`, 10_000 - i, GW.to - 1 - i));
  const txs = new Map([...pool.map((s) => [s.signature, txOf(frame(AMM, poolEvent("BuyEvent", OTHER, { at: s.blockTime })), { slot: s.slot, blockTime: s.blockTime })]), ["KT", txOf(frame(CURVE, curveTrade(KID, W, { at })), { slot: 620, blockTime: at })]]);
  const w = world({ sigsOf: new Map([[POOL, pool], ["C_K", [sig("KT", 620, at)]]]), txs });
  stored(w.db, M, "MB", G.from - 100); stored(w.db, KID, "KB", G.from - 100);
  gap(w.fill);
  await fillOnce(w.fill, KID);
  assert.equal(w.fill.stats.runCaps, 1);
  assert.deepEqual([...w.db.fillCoin(M).done], [], "the parent's gap stays pending");
  assert.ok(rowsOf(w.db, KID).some((r) => r.sig === "KT"), "the child is filled");
  assert.deepEqual([...w.db.fillCoin(KID).done], [1]);
  w.fill.stop(); w.db.close();
});

test("fill: a gap with a transaction that never answers puts the coin aside once a run stores nothing past it", async () => {
  const { list, txs } = manyTrades(30);
  const w = kidWorld(list, txs.map(([s, tx]) => [s, s === "c7" ? new Error("history not available") : tx]));
  await fillOnce(w.fill, KID);
  assert.equal(rowsOf(w.db, KID).length - 2, 29);
  assert.deepEqual([[...w.db.fillCoin(KID).done], w.fill.stats.stuck], [[], 0], "rows were stored: not stuck yet");
  assert.equal(w.fill.want(KID)?.state, "running");
  await w.fill.idle();
  assert.deepEqual([w.fill.stats.stuck, reads(w.chain, "c7"), listings(w.chain).length], [1, 6, 2]);
  assert.equal(w.fill.want(KID), null, "put aside: the chart's polls read nothing");
  assert.equal(listings(w.chain).length, 2);
  w.clock.t += FILL_RETRY_MS;
  assert.equal(w.fill.want(KID)?.state, "running", "and asked for again later");
  await w.fill.idle();
  w.fill.stop(); w.db.close();
});

test("fill: a gap where a transaction decoded incomplete in an earlier run is never marked whole (partial)", async () => {
  const at = G.from + 10;
  const cut = [`Program ${CURVE} invoke [1]`, `Program data: ${curveTrade(KID, W, { at }).toString("base64")}`, "Log truncated"];
  const y = txOf(frame(CURVE, curveTrade(KID, OTHER, { at: at + 5 })), { slot: 510, blockTime: at + 5 });
  const w = kidWorld([sig("Y", 510, at + 5), sig("X", 500, at)], [["X", { slot: 500, blockTime: at, meta: { err: null, logMessages: cut } }], ["Y", (n) => (n <= 3 ? new Error("node down") : y)]]);
  await fillOnce(w.fill, KID);
  assert.ok(rowsOf(w.db, KID).some((r) => r.sig === "X"), "X's own trade is stored");
  assert.deepEqual([...w.db.fillCoin(KID).done], [], "Y was not answered: pending");
  assert.equal(w.fill.want(KID)?.state, "running");
  await w.fill.idle();
  assert.equal(reads(w.chain, "X"), 1, "X has a row now: not read again");
  const row = w.db.fillCoin(KID);
  assert.deepEqual([[...row.done], [...row.whole], [...row.partial]], [[1], [], [1]]);
  w.fill.stop(); w.db.close();
});

test("price: a child's trade in the same transaction as its parent's (a route through the parent) is priced at the parent's price, whether the job is the child's or the parent's", async () => {
  const at = G.from + 10;
  const route = txOf([...frame(AMM, poolEvent("BuyEvent", W, { at })), ...frame(CURVE, curveTrade(KID, W, { at }))], { slot: 610, blockTime: at });
  const make = () => {
    const w = world({ sigsOf: new Map([[POOL, [sig("RT", 610, at)]], ["C_K", [sig("RT", 610, at)]]]), txs: new Map([["RT", route]]) });
    stored(w.db, M, "MB", G.from - 100, { priceQuote: 2e-7, priceUsd: 2e-5 }); stored(w.db, M, "MA", G.to + 100, { priceQuote: 2e-7, priceUsd: 2e-5 });
    stored(w.db, KID, "KB", G.from - 100, { priceQuote: 2, priceUsd: 6e-5 }); stored(w.db, KID, "KA", G.to + 100, { priceQuote: 2, priceUsd: 6e-5 }); // k 3e-5
    gap(w.fill);
    return w;
  };
  for (const job of [KID, M]) {
    const w = make();
    await fillOnce(w.fill, job);
    const mt = rowsOf(w.db, M).find((r) => r.sig === "RT"), kt = rowsOf(w.db, KID).find((r) => r.sig === "RT");
    assert.deepEqual([...w.db.fillCoin(M).whole], [1]);
    near(kt.priceUsd, kt.priceQuote * mt.priceUsd, `the child at the parent's price (job ${job === KID ? "KID" : "M"})`);
    assert.equal(reads(w.chain, "RT"), 1, "read once");
    assert.equal(w.fill.stats.priced.parent, 1);
    w.fill.stop(); w.db.close();
  }
});

test("fill: trades are stored in chain order across chunks (rowid order inside one second follows the slots)", async () => {
  const { list, txs } = manyTrades(45, { at: () => G.from + 10 });
  const w = kidWorld(list, txs);
  await fillOnce(w.fill, KID);
  const slots = rowsOf(w.db, KID).filter((r) => r.sig.startsWith("c")).map((r) => r.slot);
  assert.equal(slots.length, 45);
  assert.deepEqual(slots, [...slots].sort((a, b) => a - b));
  w.fill.stop(); w.db.close();
});

// ---------------------------------------------------------------- review fixes, round 2
test("budget: once the day's calls are spent, a coin still in line answers null and leaves it (its chart stops asking)", async () => {
  const { list, txs } = manyTrades(250);
  const w = kidWorld(list, txs, { cfg: { dailyCalls: FILL_DAILY_MIN } });
  stored(w.db, NOPRICE, "NB", G.from - 100); // a second coin with the same gap (its curve lists nothing)
  const fill = w.make({ sleep: (ms, signal) => new Promise((r) => signal.addEventListener("abort", r)) }); // a pause lasts
  assert.equal(fill.want(NOPRICE)?.state, "queued");
  w.clock.t += 1;
  assert.equal(fill.want(KID)?.state, "queued");
  fill.start(); // KID (asked last) runs first and spends the day
  while (fill.running || fill.stats.budgetStops === 0) await new Promise((r) => setImmediate(r));
  assert.equal(fill.want(NOPRICE), null, "no 'queued' for the rest of the day");
  assert.equal(fill.queue.size, 0);
  assert.equal(listings(w.chain).filter((c) => c.params[0] === "C_N").length, 0);
  fill.stop(); w.db.close();
});

test("price: a child's row in a parent's gap left pending (a transaction not answered) is not stored then; the child's own fill prices it at the parent's price once that gap is whole", async () => {
  const at = G.from + 10;
  const route = txOf([...frame(AMM, poolEvent("BuyEvent", W, { at })), ...frame(CURVE, curveTrade(KID, W, { at }))], { slot: 610, blockTime: at });
  const late = txOf(frame(AMM, poolEvent("BuyEvent", OTHER, { at: at + 5 })), { slot: 615, blockTime: at + 5 });
  const w = world({ sigsOf: new Map([[POOL, [sig("E", 615, at + 5), sig("RT", 610, at)]], ["C_K", [sig("RT", 610, at)]]]), txs: new Map([["RT", route], ["E", (n) => (n <= 3 ? new Error("node down") : late)]]) });
  stored(w.db, M, "MB", G.from - 100, { priceQuote: 2e-7, priceUsd: 2e-5 }); stored(w.db, M, "MA", G.to + 100, { priceQuote: 2e-7, priceUsd: 2e-5 });
  stored(w.db, KID, "KB", G.from - 100, { priceQuote: 2, priceUsd: 6e-5 }); stored(w.db, KID, "KA", G.to + 100, { priceQuote: 2, priceUsd: 6e-5 }); // k 3e-5
  gap(w.fill);
  await fillOnce(w.fill, M); // the parent's own chart: E is not answered, M's gap stays pending
  assert.deepEqual([...w.db.fillCoin(M).done], []);
  assert.equal(rowsOf(w.db, KID).some((r) => r.sig === "RT"), false, "the child's row waits for its own fill");
  assert.equal(w.fill.want(M)?.state, "running");
  await w.fill.idle();
  assert.deepEqual([...w.db.fillCoin(M).whole], [1]);
  await fillOnce(w.fill, KID);
  const mt = rowsOf(w.db, M).find((r) => r.sig === "RT"), kt = rowsOf(w.db, KID).find((r) => r.sig === "RT");
  near(kt.priceUsd, kt.priceQuote * mt.priceUsd, "the child at the parent's price");
  w.fill.stop(); w.db.close();
});

test("want: a busy coin first recorded hours after a gap that straddles its 24 h floor does not count as recorded (no island, nothing marked)", () => {
  const A = { from: NOW - 26 * 3600, to: NOW - 23 * 3600 };
  const w = world();
  gap(w.fill, A.from, A.to);
  // 2 000 rows in the last 3 h: the floor is the 24 h line, but nothing of the coin was stored before them
  w.db.transaction(() => { for (let i = 0; i < 2000; i++) stored(w.db, KID, `K${i}`, NOW - 3 * 3600 + i * 5); });
  assert.equal(w.fill.want(KID), null);
  assert.equal(w.db.fillCoin(KID), null, "left out, not marked");
  assert.equal(w.fill.queue.size, 0);
  w.db.close();
});

test("fill: a transaction that decoded incomplete gives only the filled coin's rows; the other coin reads it itself and its gap is not whole either (partial)", async () => {
  const at = G.from + 10;
  const cut = [`Program ${AMM} invoke [1]`, `Program data: ${poolEvent("BuyEvent", W, { at }).toString("base64")}`, `Program ${AMM} success`,
    `Program ${CURVE} invoke [1]`, `Program data: ${curveTrade(KID, W, { at }).toString("base64")}`, "Log truncated"];
  const w = world({ sigsOf: new Map([[POOL, [sig("RT", 610, at)]], ["C_K", [sig("RT", 610, at)]]]), txs: new Map([["RT", { slot: 610, blockTime: at, meta: { err: null, logMessages: cut } }]]) });
  stored(w.db, M, "MB", G.from - 100); stored(w.db, KID, "KB", G.from - 100);
  gap(w.fill);
  await fillOnce(w.fill, KID);
  assert.equal(reads(w.chain, "RT"), 2, "read by the parent's fill and again by the child's");
  assert.ok(rowsOf(w.db, KID).some((r) => r.sig === "RT") && rowsOf(w.db, M).some((r) => r.sig === "RT"), "the rows it did give are kept");
  for (const mint of [M, KID]) {
    const row = w.db.fillCoin(mint);
    assert.deepEqual([[...row.done], [...row.whole], [...row.partial]], [[1], [], [1]], mint === M ? "M" : "KID");
  }
  w.fill.stop(); w.db.close();
});

test("fill: in the slot a coin migrates in, its last curve trade is stored before its first pool trade (chain order)", async () => {
  const at = G.from + 10;
  const w = world({
    sigsOf: new Map([["C_M", [sig("LASTCURVE", 520, at)]], [POOL, [sig("FIRSTPOOL", 520, at)]]]),
    txs: new Map([["LASTCURVE", txOf(frame(CURVE, curveTrade(M, W, { at })), { slot: 520, blockTime: at })], ["FIRSTPOOL", txOf(frame(AMM, poolEvent("SellEvent", W, { at })), { slot: 520, blockTime: at })]]),
  });
  stored(w.db, M, "MB4", G.from - 100);
  gap(w.fill);
  await fillOnce(w.fill, M);
  assert.deepEqual(rowsOf(w.db, M).map((r) => r.sig), ["MB4", "LASTCURVE", "FIRSTPOOL"]);
  w.fill.stop(); w.db.close();
});

// ---------------------------------------------------------------- integration
test("wallet: a tracked wallet's filled trade lands once in wallet_trades with userQuoteAmount; the wallet's own catch-up of the same tx adds no row", async () => {
  const at = G.from + 10;
  const tx = txOf(frame(CURVE, curveTrade(KID, W, { buy: true, base: "5", quote: "1000", at }, { fee: new BN(7), creator_fee: new BN(3) })), { slot: 640, blockTime: at });
  const w = kidWorld([sig("SIGW", 640, at)], [["SIGW", tx]]);
  const pnl = new PnlTracker({ model: w.m, rpc: fakeChain([sig("SIGW", 640, at)], new Map([["SIGW", tx]])), now: w.clock.now, sleep: w.clock.sleep, log: quiet });
  pnl.register(W);
  await fillOnce(w.fill, KID);
  const walletRows = () => w.db.walletTradesPage(W).map((r) => `${r.sig}/${r.idx}/${r.isBuy ? "buy" : "sell"}/${r.baseAmount}/${r.quoteAmount}`);
  assert.deepEqual(walletRows(), ["SIGW/0/buy/5/1010"], "what the wallet paid, fees included");
  assert.equal(rowsOf(w.db, KID).find((r) => r.sig === "SIGW").quoteAmount, "1000", "the coin's own row keeps the swap amount");
  pnl.start(); await pnl.idle();
  assert.equal(pnl.wallets.get(W).state, "done");
  assert.deepEqual(walletRows(), ["SIGW/0/buy/5/1010"]);
  assert.equal(pnl.snapshot().backfillRows, 0);
  pnl.stop(); w.fill.stop(); w.db.close();
});

test("api: /api/candles carries fill only while the coin is queued or running; /api/health.fill is present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-fill-api-"));
  const at = G.from + 10;
  const w = kidWorld([sig("GAP", 500, at)], [["GAP", txOf(frame(CURVE, curveTrade(KID, W, { at })), { slot: 500, blockTime: at })]]);
  const hub = new EventHub({ heartbeatMs: 200 });
  const app = createApp({ model: w.m, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc: { call: async () => { throw new Error("no chain in this test"); } }, hub, images: new ImageCache(dir), meta: null, platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet, tradeFill: w.fill });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const first = await get(`/api/candles/${KID}?scope=all&res=300`);
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body), ["candles", "priceKey", "fill"]);
    assert.deepEqual(first.body.fill, { state: "queued", gaps: 1, from: GW.from, to: GW.to });
    assert.deepEqual(Object.keys((await get(`/api/candles/${M}?scope=all`)).body), ["candles", "priceKey"], "nothing pending for M (never recorded before the gap)");
    w.fill.start(); await w.fill.idle();
    assert.deepEqual(Object.keys((await get(`/api/candles/${KID}?scope=all&res=300`)).body), ["candles", "priceKey"], "filled: the key is gone");
    const h = await get("/api/health");
    assert.equal(h.body.fill.enabled, true);
    assert.deepEqual([h.body.fill.gaps, h.body.fill.queue, h.body.fill.running, h.body.fill.stats.rows, h.body.fill.stats.windowsDone], [1, 0, null, 1, 1]);
    assert.ok(["asked", "jumps", "sigsStored", "priced", "outages", "budgetStops"].every((k) => k in h.body.fill.stats));
  } finally {
    await new Promise((r) => server.close(r)); hub.close(); w.fill.stop(); w.db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- review fixes, round 3
test("caps: a gap that takes several runs does not read its transactions without a row of the coin again (no event of it, answered null), so a later run gets past them", async () => {
  const { list, txs } = manyTrades(20);
  // older than the coin's trades: 300 transactions on its curve with no event of it (the oldest answered null)
  const noise = Array.from({ length: 300 }, (_, i) => sig(`n${i}`, 5_000 - i, GW.from + 100));
  const w = kidWorld([...list, ...noise], [...txs, ...noise.map((s, i) => [s.signature, i === 299 ? null : txOf(frame(CURVE), { slot: s.slot, blockTime: s.blockTime })])]);
  await fillOnce(w.fill, KID);
  assert.equal(w.fill.stats.runCaps, 1);
  assert.equal(rowsOf(w.db, KID).length - 2, 0, "the run's calls went to the transactions without a row");
  assert.equal((await fillOnce(w.fill, KID)).state, "running");
  assert.equal(rowsOf(w.db, KID).length - 2, 20, "the next run gets past them");
  assert.equal(w.fill.stats.runCaps, 1);
  // each read once (the null one with its retries), but for the chunk under way when the first run's calls ran out
  assert.equal(reads(w.chain, "n299"), 3);
  const twice = noise.filter((s) => reads(w.chain, s.signature) !== 1).map((s) => s.signature);
  assert.ok(twice.length <= FILL_CHUNK && noise.every((s) => reads(w.chain, s.signature) <= (s.signature === "n299" ? 3 : 2)), twice.join());
  const row = w.db.fillCoin(KID);
  assert.deepEqual([[...row.done], [...row.whole], [...row.partial]], [[1], [], [1]], "done; not whole: one was answered null");
  assert.equal(w.fill.noRow.size, 0, "forgotten once the gap is marked");
  w.fill.stop(); w.db.close();
});

test("order: a child's trade routed through its parent (stored with the parent's gap) and its own earlier trade in the same second read back in chain order (tape, candles, priceAt)", async () => {
  const at = G.from + 10;
  const route = txOf([...frame(AMM, poolEvent("BuyEvent", W, { at })), ...frame(CURVE, curveTrade(KID, W, { at }))], { slot: 610, blockTime: at });
  const ownEvent = payload(pumpIdl, "TradeEvent", { mint: new PublicKey(KID), user: new PublicKey(OTHER), timestamp: new BN(at), is_buy: false, token_amount: new BN("5000000"), quote_mint: new PublicKey(M), quote_amount: new BN("700"),
    virtual_quote_reserves: new BN("3000000000000000"), virtual_token_reserves: new BN("1000000000000000"), real_quote_reserves: new BN("700"), real_token_reserves: new BN("500000000000000") }); // another price than RT's
  const own = txOf(frame(CURVE, ownEvent), { slot: 600, blockTime: at });
  const w = world({ sigsOf: new Map([[POOL, [sig("RT", 610, at)]], ["C_K", [sig("RT", 610, at), sig("KO", 600, at)]]]), txs: new Map([["RT", route], ["KO", own]]) });
  stored(w.db, M, "MB", G.from - 100, { priceQuote: 2e-7, priceUsd: 2e-5 });
  stored(w.db, KID, "KB", G.from - 100, { priceQuote: 2, priceUsd: 6e-5 });
  gap(w.fill);
  await fillOnce(w.fill, KID);
  assert.deepEqual(rowsOf(w.db, KID).map((r) => r.sig), ["KB", "RT", "KO"], "RT went in with M's gap, before KID's own fill stored KO");
  assert.deepEqual(w.db.tradesSince(KID, 0).map((r) => r.sig), ["KB", "KO", "RT"]);
  assert.deepEqual(w.db.tradesFor(KID, 2).map((r) => r.sig), ["RT", "KO"]);
  const rt = w.db.tradesFor(KID, 1)[0];
  assert.equal(w.db.priceAt(KID, at).priceQuote, rt.priceQuote, "the price at that second is the later trade's");
  assert.notEqual(w.db.tradesSince(KID, 0)[1].priceQuote, rt.priceQuote);
  w.fill.stop(); w.db.close();
});
