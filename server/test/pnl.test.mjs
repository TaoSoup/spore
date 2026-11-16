// Wallet profit and loss (lib/pnl.mjs, lib/pnl-tracker.mjs): the average-cost maths, the live insert for
// tracked wallets only (one row whichever stream delivers), the one-time history scan against a fake
// chain (cap and cut flag, resume from the stored signature, unread transactions, the throttle on a fake
// clock), eviction and the per-wallet row cap, and the two routes (validation, rate limit, degrade).
// Then: events read from a transaction's inner instructions when its log is cut, unread transactions
// remembered and read again (and the one-time second scan of wallets from before that), and the series of
// realized profit over time (maths, tracker, route). An endpoint that does not answer burns no try of an unread
// transaction; a live log the node cut is read for its wallet on the wallet's next request.
// No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer, POOL_EVENT_PROGRAMS, LIVE_EVENT_PROGRAMS, bs58 } from "../lib/indexer.mjs";
import { EVENT_DISCRIMINATORS, EVENT_CPI_TAG, eventsInInner, eventsInLogs } from "../lib/decode.mjs";
import { createApp } from "../lib/api.mjs";
import { loadConfig, DEFAULT_RATES } from "../lib/config.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { Rpc } from "../lib/rpc.mjs";
import { pnlOfTrades, applyTrade, byTradeOrder, usdNow, realizedSeries, seriesStart, seriesApply, seriesEnd, SERIES_MAX_POINTS } from "../lib/pnl.mjs";
import { PnlTracker, tradesOfTx, PNL_CHUNK, PNL_TX_RETRIES, PNL_RETRY_FAILED_MS, PNL_RETRY_MAX_MS, PNL_TRIM_EVERY, PNL_CACHE_MS, PNL_CACHE_COINS, PNL_CACHE_SINCE_MAX, PNL_CACHE_SWEEP_MS, PNL_SLICE, PNL_EVICT_IDLE_S, PNL_OUTAGE_STREAK, PNL_OUTAGE_PAUSE_MS, PNL_GAP_MARGIN_S, ACTIVITY_MAX, PNL_UNREAD_RETRY_MS, PNL_UNREAD_RETRIES, PNL_UNREAD_MAX, PNL_UNREAD_ERRORS, PNL_CUTS_MAX, PNL_CUT_CHECK_MS } from "../lib/pnl-tracker.mjs";
import { BN, PublicKey, pumpIdl, pumpAmmIdl, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "../lib/sdk.mjs";
import { PLATFORM, quiet, T22 } from "./helpers/tree.mjs";

const key = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
const CURVE = PUMP_PROGRAM_ID.toBase58(), AMM = PUMP_AMM_PROGRAM_ID.toBase58();
const M = key(81), POOL = key(82), KID = key(85), NOPRICE = key(86), UNKNOWN_QUOTE = key(87), FOREIGN = key(88);
const W = key(60), W2 = key(61), W3 = key(62), OTHER = key(63);
const T0 = 1_700_000_000;

// ---------------------------------------------------------------- the maths
const tr = (mint, time, isBuy, baseAmount, quoteAmount, extra = {}) => ({ mint, time, isBuy, baseAmount: String(baseAmount), quoteAmount: String(quoteAmount), sig: `s${time}`, idx: 0, ...extra });
const one = (trades, opts) => pnlOfTrades(trades, opts).get("m");

test("maths: average cost over buys, sells realize proceeds less their share of the cost", () => {
  const e = one([tr("m", 1, true, 100, 1000), tr("m", 2, true, 100, 3000), tr("m", 3, false, 50, 1500)]);
  assert.equal(e.heldBase, 150n); assert.equal(e.costQuote, 3000n); assert.equal(e.realizedQuote, 500n);
  assert.deepEqual([e.boughtBase, e.boughtQuote, e.soldBase, e.soldQuote], [200n, 4000n, 50n, 1500n]);
  assert.deepEqual([e.buys, e.sells, e.firstAt, e.lastAt, e.partial], [2, 1, 1, 3, false]);
  // closing the position at a loss: the whole remaining cost leaves, nothing is left behind
  const closed = one([tr("m", 1, true, 100, 1000), tr("m", 2, true, 100, 3000), tr("m", 3, false, 50, 1500), tr("m", 4, false, 150, 1500)]);
  assert.equal(closed.realizedQuote, 500n - 1500n); assert.equal(closed.heldBase, 0n); assert.equal(closed.costQuote, 0n);
});

test("maths: integer rounding never loses quote units (realized over a closed position = sold − bought)", () => {
  const e = one([tr("m", 1, true, 3, 10), tr("m", 2, false, 1, 5), tr("m", 3, false, 2, 10)]);
  assert.equal(e.realizedQuote, 15n - 10n); assert.equal(e.costQuote, 0n);
  // amounts beyond 2^53 stay exact
  const big = one([tr("m", 1, true, "9007199254740993000", "18014398509481986001"), tr("m", 2, false, "9007199254740993000", "18014398509481986003")]);
  assert.equal(big.realizedQuote, 2n);
});

test("maths: a sell of more than the recorded buys realizes only the explained part and flags the coin partial", () => {
  const e = one([tr("m", 1, true, 100, 1000), tr("m", 2, false, 300, 6000)]);
  assert.equal(e.partial, true);
  assert.equal(e.realizedQuote, 2000n - 1000n, "a third of the proceeds against the whole known cost");
  assert.deepEqual([e.soldBase, e.soldQuote, e.heldBase, e.costQuote], [300n, 6000n, 0n, 0n]);
  // nothing bought at all (tokens transferred in): no profit is claimed
  const gift = one([tr("m", 1, false, 50, 999)]);
  assert.deepEqual([gift.partial, gift.realizedQuote, gift.soldQuote, gift.sells], [true, 0n, 999n, 1]);
  // and a later buy starts a clean position
  const again = one([tr("m", 1, false, 50, 999), tr("m", 2, true, 10, 100), tr("m", 3, false, 10, 150)]);
  assert.deepEqual([again.partial, again.realizedQuote], [true, 50n]);
});

test("maths: since windows the sums and the realized profit, the cost basis comes from the whole history", () => {
  const trades = [tr("m", 10, true, 100, 1000), tr("m", 20, false, 50, 800), tr("m", 30, false, 25, 200), tr("old", 5, true, 10, 10), tr("old", 6, false, 10, 30), tr("held", 7, true, 4, 40)];
  const all = pnlOfTrades(trades);
  assert.equal(all.get("m").realizedQuote, 300n - 50n); assert.equal(all.get("old").realizedQuote, 20n);
  const w = pnlOfTrades(trades, { since: 25 });
  const m = w.get("m");
  assert.equal(m.realizedQuote, 200n - 250n, "the sell at 30 against the average cost of the buy at 10");
  assert.deepEqual([m.buys, m.sells, m.boughtBase, m.boughtQuote, m.soldBase, m.soldQuote], [0, 1, 0n, 0n, 25n, 200n]);
  assert.deepEqual([m.heldBase, m.costQuote, m.firstAt, m.lastAt], [25n, 250n, 10, 30]);
  assert.equal(w.has("old"), false, "closed before the window: not listed");
  assert.deepEqual([w.get("held").heldBase, w.get("held").costQuote, w.get("held").buys], [4n, 40n, 0], "an open position stays listed with its cost");
  // a boundary trade is inside the window
  assert.equal(pnlOfTrades(trades, { since: 30 }).get("m").sells, 1);
});

test("maths: empty and zero input, malformed amounts, trade order, the USD helper", () => {
  assert.equal(pnlOfTrades([]).size, 0);
  const z = one([tr("m", 1, true, 0, 0), tr("m", 2, false, 0, 0), tr("m", 3, false, "x", "-5")]);
  assert.deepEqual([z.realizedQuote, z.heldBase, z.costQuote, z.partial, z.buys, z.sells], [0n, 0n, 0n, false, 1, 2]);
  const e = applyTrade({ boughtBase: 0n, boughtQuote: 0n, soldBase: 0n, soldQuote: 0n, realizedQuote: 0n, costQuote: 0n, heldBase: 0n, partial: false, buys: 0, sells: 0, firstAt: null, lastAt: null }, tr("m", 1, true, 5, 50));
  assert.equal(e.heldBase, 5n);
  const rows = [{ time: 2, slot: 9, sig: "b", idx: 0 }, { time: 1, slot: 9, sig: "z", idx: 0 }, { time: 2, slot: 9, sig: "a", idx: 1 }, { time: 2, slot: 9, sig: "a", idx: 0 }, { time: 2, slot: 8, sig: "q", idx: 0 }];
  assert.deepEqual(rows.sort(byTradeOrder).map((r) => `${r.sig}${r.idx}`), ["z0", "q0", "a0", "a1", "b0"]);
  // inside one slot the transactions' own order (ord) decides, not the signature: a buy and the sell after it realize the profit
  const sameSlot = [{ ...tr("m", 5, false, 100, 1500), sig: "2aa", slot: 300, ord: -1 }, { ...tr("m", 5, true, 100, 1000), sig: "5zz", slot: 300, ord: -2 }];
  const s = one(sameSlot.sort(byTradeOrder));
  assert.deepEqual([s.realizedQuote, s.heldBase, s.costQuote, s.partial], [500n, 0n, 0n, false]);
  assert.equal(usdNow(1_500_000_000n, 9, 100), 150); assert.equal(usdNow(-2_000_000n, 6, 0.5), -1); assert.equal(usdNow(5n, 6, null), null);
});

// ---------------------------------------------------------------- fixtures
/** An event's `Program data:` payload, every field a zero of its type unless `set` names it. */
function payload(idl, name, set) {
  const t = idl.types.find((x) => x.name === name);
  const v = {};
  for (const f of t.type.fields) v[f.name] = f.type === "pubkey" ? new PublicKey(Buffer.alloc(32, 9)) : f.type === "string" ? "x" : f.type === "bool" ? false : typeof f.type === "object" ? [] : new BN(0);
  return Buffer.concat([EVENT_DISCRIMINATORS[name], new anchor.BorshCoder(idl).types.encode(name, { ...v, ...set })]);
}
const poolEvent = (name, user, { pool = POOL, base = "1000000", quote = "425", at = T0, own = null } = {}) => payload(pumpAmmIdl, name, {
  timestamp: new BN(at), pool: new PublicKey(pool), user: new PublicKey(user), pool_base_token_reserves: new BN("200000000000000"), pool_quote_token_reserves: new BN("85000000000"),
  ...(name === "BuyEvent" ? { base_amount_out: new BN(base), quote_amount_in: new BN(quote), quote_amount_in_with_lp_fee: new BN(quote), user_quote_amount_in: new BN(own ?? 0) } : { base_amount_in: new BN(base), quote_amount_out: new BN(quote), quote_amount_out_without_lp_fee: new BN(quote), user_quote_amount_out: new BN(own ?? quote) }),
});
const curveTrade = (mint, user, { buy = true, base = "5000000", quote = "700", at = T0 } = {}, more = {}) => payload(pumpIdl, "TradeEvent", {
  ...more,
  mint: new PublicKey(mint), user: new PublicKey(user), timestamp: new BN(at), is_buy: buy, token_amount: new BN(base), quote_mint: new PublicKey(M), quote_amount: new BN(quote),
  virtual_quote_reserves: new BN("2000000000000000"), virtual_token_reserves: new BN("1000000000000000"), real_quote_reserves: new BN("700"), real_token_reserves: new BN("500000000000000"),
});
const payloadWith = (make, mint, user, opts, more) => make(mint, user, opts, more);
const frame = (program, ...events) => [`Program ${program} invoke [1]`, ...events.map((e) => `Program data: ${e.toString("base64")}`), `Program ${program} success`];
const txOf = (logs, { slot = 100, blockTime = T0, err = null } = {}) => ({ slot, blockTime, meta: { err, logMessages: logs } });

/** M: a SOL coin that graduated (its pool is tracked). KID: on its curve, quoted in M. NOPRICE: quoted in a mint nobody prices. */
function setup() {
  const db = new Db(":memory:");
  const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load();
  m.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  m.setSolUsd(100);
  const zeros = { virtualTokenReserves: "0", virtualQuoteReserves: "0", realTokenReserves: "0", realQuoteReserves: "0" };
  const curve = { virtualTokenReserves: "1000000000000000", virtualQuoteReserves: "2000000000000000", realTokenReserves: "500000000000000", realQuoteReserves: "0", tokenTotalSupply: "1000000000000000", initialVirtualQuoteReserves: "0", complete: false, migrated: false, creator: "CR" };
  m.upsertCoin({ mint: M, curve: "C_M", depth: 0, quoteMint: null, ...zeros, tokenTotalSupply: "1000000000000000", migrated: true, complete: true, pool: POOL, poolBaseVault: key(83), poolQuoteVault: key(84), poolBase: "200000000000000", poolQuote: "85000000000", poolVirtualQuote: "0", creator: "CR", tracked: true });
  m.upsertCoin({ mint: KID, curve: "C_K", depth: 1, quoteMint: M, ...curve, tracked: true });
  m.upsertCoin({ mint: NOPRICE, curve: "C_N", depth: 0, quoteMint: UNKNOWN_QUOTE, ...curve, tracked: true });
  m.upsertCoin({ mint: FOREIGN, curve: "C_F", depth: 0, quoteMint: null, ...curve, tracked: false });
  for (const [mint, symbol] of [[M, "MMM"], [KID, "KID"], [NOPRICE, "NOP"], [FOREIGN, "FOR"]]) m.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, onchainAt: 1 });
  const ix = new Indexer({ rpc: { snapshot: () => ({}) }, model: m, meta: null, hub: { emit() {} }, log: quiet, opts: { backfill: false } });
  return { db, m, ix };
}
/**
 * A fake chain: `sigs` newest first (`{ signature, blockTime, err }`), `txs` signature → transaction, a function of the
 * attempt number, or an Error to throw. Records every call.
 */
function fakeChain(sigs, txs, { onCall = null } = {}) {
  const calls = [], tries = new Map();
  return {
    calls,
    count: (method) => calls.filter((c) => c.method === method).length,
    call: async (method, params, opts) => {
      calls.push({ method, params, opts });
      if (onCall) await onCall(method, params, calls);
      if (opts?.signal?.aborted) throw Object.assign(new Error("aborted"), { aborted: true });
      if (method === "getSignaturesForAddress") {
        const { limit, before } = params[1];
        const from = before ? sigs.findIndex((s) => s.signature === before) + 1 : 0;
        return sigs.slice(from, from + limit);
      }
      if (method === "getTransaction") {
        const n = (tries.get(params[0]) ?? 0) + 1; tries.set(params[0], n);
        let v = txs.get(params[0]);
        if (typeof v === "function") v = v(n);
        if (v instanceof Error) throw v;
        return v ?? null;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}
/** A clock the throttle sleeps on: sleeping only moves it. */
function fakeClock(start = T0 * 1000) {
  const c = { t: start, slept: [], now: () => c.t, sleep: async (ms) => { c.slept.push(ms); c.t += ms; } };
  return c;
}
const walletRows = (db, wallet) => db.walletTradesPage(wallet).map((r) => `${r.sig}/${r.idx}/${r.isBuy ? "buy" : "sell"}/${r.baseAmount}/${r.quoteAmount}`);

// ---------------------------------------------------------------- live
test("live: a stored trade is also kept for its trader only when that wallet is tracked; both streams make one row", async () => {
  const { db, m, ix } = setup();
  const pnl = new PnlTracker({ model: m, log: quiet });
  assert.equal(m.walletTrades, pnl);
  // not tracked yet: the trade is stored for its coin, not for the wallet
  ix.onLogs({ slot: 5, signature: "EARLY", err: null, logs: frame(CURVE, curveTrade(KID, W)) });
  assert.equal(db.tradesFor(KID).length, 1); assert.deepEqual(walletRows(db, W), []);
  pnl.register(W);
  assert.equal(pnl.snapshot().wallets, 1);
  // one transaction with a curve trade of W, a pool buy of W and a pool sell of someone else, delivered by both streams
  const tx = { slot: 6, signature: "BOTH", err: null, logs: [...frame(CURVE, curveTrade(KID, W, { base: "7", quote: "70" })), ...frame(AMM, poolEvent("BuyEvent", W, { base: "9", quote: "90" }), poolEvent("SellEvent", OTHER))] };
  ix.onLogs(tx); ix.onLogs(tx, POOL_EVENT_PROGRAMS); ix.onLogs(tx);
  assert.deepEqual(walletRows(db, W).sort(), ["BOTH/0/buy/7/70", "BOTH/1/buy/9/90"]);
  assert.deepEqual(walletRows(db, OTHER), []);
  assert.equal(pnl.snapshot().rows, 2); assert.equal(pnl.wallets.get(W).rows, 2);
  assert.equal(db.pnlWallets()[0].rows, 2, "the count is stored with the wallet");
  // a trade stored before the wallet was tracked and handed in again by the other stream is kept now
  ix.onLogs({ slot: 5, signature: "EARLY", err: null, logs: frame(CURVE, curveTrade(KID, W)) });
  assert.equal(db.tradesFor(KID).length, 2, "no second row in the coin's own trades");
  assert.equal(walletRows(db, W).length, 3);
  // a coin the index only looked up (untracked) is not kept, and a failing store never reaches the live path
  assert.equal(pnl.onTrade({ sig: "F", mint: FOREIGN, idx: 0, slot: 1, time: T0, isBuy: true, user: W, baseAmount: "1", quoteAmount: "1" }), false);
  const broken = db.insertWalletTrade; db.insertWalletTrade = () => { throw new Error("disk full"); };
  assert.equal(m.recordTrade({ sig: "X", mint: KID, idx: 0, slot: 1, time: T0, isBuy: true, user: W, baseAmount: "1", quoteAmount: "1", priceQuote: 1 }), true);
  db.insertWalletTrade = broken;
  assert.equal(pnl.snapshot().liveErrors, 1);
  db.close();
});

test("live: a wallet over its row cap loses its oldest rows in batches and its history counts as cut", () => {
  const { db, m } = setup();
  const pnl = new PnlTracker({ model: m, cfg: { maxTrades: 5 }, log: quiet });
  pnl.register(W);
  for (let i = 0; i < 5 + PNL_TRIM_EVERY; i++) pnl.onTrade({ sig: `S${i}`, mint: KID, idx: 0, slot: i, time: T0 + i, isBuy: true, user: W, baseAmount: "1", quoteAmount: "1" });
  const w = pnl.wallets.get(W);
  assert.equal(w.rows, 5); assert.equal(w.cut, true); assert.equal(db.walletTradesCount(W), 5); assert.equal(pnl.snapshot().rows, 5);
  assert.deepEqual(db.walletTradesPage(W).map((r) => r.sig), [100, 101, 102, 103, 104].map((i) => `S${i}`), "the newest stay");
  assert.equal(db.pnlWallets()[0].cut, true);
  db.close();
});

// ---------------------------------------------------------------- history scan
test("tradesOfTx: the wallet's own trades of tracked coins, numbered like the live path; failed and truncated transactions", () => {
  const { db, m } = setup();
  const logs = [...frame(CURVE, curveTrade(KID, OTHER), curveTrade(KID, W, { buy: false, base: "3", quote: "33", at: T0 + 9 })), ...frame(AMM, poolEvent("SellEvent", W, { base: "4", quote: "44" }), poolEvent("BuyEvent", W, { pool: key(90) })), ...frame(CURVE, curveTrade(FOREIGN, W)), ...frame(key(77), curveTrade(KID, W))];
  const r = tradesOfTx(m, W, "SIG", txOf(logs, { slot: 77 }));
  assert.deepEqual(r.rows, [
    { sig: "SIG", mint: KID, idx: 1, slot: 77, time: T0 + 9, isBuy: false, baseAmount: "3", quoteAmount: "33" },
    { sig: "SIG", mint: M, idx: 2, slot: 77, time: T0, isBuy: false, baseAmount: "4", quoteAmount: "44" },
  ]);
  assert.equal(r.truncated, false); assert.equal(r.incomplete, false);
  assert.deepEqual(tradesOfTx(m, W, "SIG", txOf(logs, { err: { InstructionError: [0, "Custom"] } })).rows, []);
  const cut = tradesOfTx(m, W, "SIG", txOf([...logs, "Log truncated"]));
  assert.deepEqual([cut.truncated, cut.incomplete, cut.rows.length], [true, true, 2]);
  assert.deepEqual(tradesOfTx(m, W, "SIG", null), { rows: [], truncated: false, incomplete: false });
  // a transaction the node answers without its log (or without meta) may hold a trade: incomplete, so it counts as unread
  assert.deepEqual(tradesOfTx(m, W, "SIG", { meta: null }), { rows: [], truncated: false, incomplete: true });
  assert.deepEqual(tradesOfTx(m, W, "SIG", { slot: 1, meta: { err: null, logMessages: null } }), { rows: [], truncated: false, incomplete: true });
  // an event of a tracked coin that does not decode (an older, shorter layout): the other trades are kept, the transaction is incomplete
  const old = curveTrade(KID, W).subarray(0, 120);
  const o = tradesOfTx(m, W, "SIG", txOf([...frame(CURVE, old, curveTrade(KID, W, { base: "8", quote: "80" }))]));
  assert.deepEqual([o.rows.map((x) => x.baseAmount), o.truncated, o.incomplete], [["8"], false, true]);
  // an event of a coin outside the index that does not decode says nothing about this wallet's history
  assert.equal(tradesOfTx(m, W, "SIG", txOf(frame(CURVE, curveTrade(FOREIGN, W).subarray(0, 120)))).incomplete, false);
  // the amounts are the wallet's own: a curve buy pays its fees on top, a curve sell has them taken off, a pool trade names them
  const fee = { fee: new BN(7), creator_fee: new BN(3) };
  const feeLogs = [...frame(CURVE, payloadWith(curveTrade, KID, W, { buy: true, base: "5", quote: "1000" }, fee), payloadWith(curveTrade, KID, W, { buy: false, base: "5", quote: "1000" }, fee)),
    ...frame(AMM, poolEvent("BuyEvent", W, { base: "6", quote: "1000", own: "1012" }), poolEvent("SellEvent", W, { base: "6", quote: "1000", own: "988" }))];
  assert.deepEqual(tradesOfTx(m, W, "SIG", txOf(feeLogs)).rows.map((x) => `${x.isBuy ? "buy" : "sell"} ${x.quoteAmount}`), ["buy 1010", "sell 990", "buy 1012", "sell 988"]);
  db.close();
});

/** Seven transactions of W, newest first: what each is for is in the test below. */
function sevenTxs() {
  const sigs = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((signature, i) => ({ signature, blockTime: T0 - i * 10, slot: 100 - i, err: signature === "s3" ? { InstructionError: [0, "Custom"] } : null }));
  const txs = new Map([
    ["s1", txOf(frame(AMM, poolEvent("BuyEvent", W, { base: "1000000", quote: "500", at: T0 })), { blockTime: T0 })],
    ["s2", txOf(frame(CURVE, curveTrade(KID, OTHER), curveTrade(KID, W, { base: "600", quote: "60", at: T0 - 10 })), { blockTime: T0 - 10 })],
    ["s3", txOf(frame(CURVE, curveTrade(KID, W)))], // failed on chain: never fetched
    ["s4", new Error("node down")],                  // never readable
    ["s5", (n) => (n < 3 ? null : txOf(frame(CURVE, curveTrade(KID, W, { base: "400", quote: "20", at: T0 - 40 })), { blockTime: T0 - 40 }))], // there on the third try
    ["s6", txOf(frame(CURVE, curveTrade(FOREIGN, W)), { blockTime: T0 - 50 })], // a coin outside the index
    ["s7", txOf(frame(CURVE, curveTrade(KID, W, { buy: false, base: "500", quote: "100", at: T0 - 60 })), { blockTime: T0 - 60 })],
  ]);
  return { sigs, txs };
}

test("scan: capped at PNL_BACKFILL_TX with the cut flag, unread transactions counted, retries bounded, throttled on its own clock", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  const chain = fakeChain(sigs, txs), clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, cfg: { backfillTx: 5, backfillRps: 5 }, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  const first = await pnl.pnl(W); // registers and queues; the answer does not wait for the scan
  assert.deepEqual(first.coins, []); assert.ok(["queued", "running"].includes(first.history.state));
  await pnl.idle();
  const w = pnl.wallets.get(W);
  assert.deepEqual([w.state, w.scanned, w.total, w.cut, w.unread, w.beforeSig, w.oldestTime], ["done", 5, 5, true, 1, "s5", T0 - 40]);
  assert.deepEqual(walletRows(db, W).sort(), ["s1/0/buy/1000000/500", "s2/1/buy/600/60", "s5/0/buy/400/20"]);
  // calls: one listing (limit 5), one probe for older history, and per transaction: s1 1, s2 1, s3 none, s4 1 + retries, s5 3
  assert.deepEqual(chain.calls.filter((c) => c.method === "getSignaturesForAddress").map((c) => [c.params[1].limit, c.params[1].before ?? null]), [[5, null], [1, "s5"]]);
  assert.equal(chain.count("getTransaction"), 1 + 1 + (1 + PNL_TX_RETRIES) + 3);
  assert.ok(chain.calls.every((c) => c.opts.signal && c.opts.maxBytes > 0 && c.opts.retries === 1), "every read is bounded and cancellable");
  // the throttle: 5 a second means 200 ms between starts, on the clock handed in (the test did not wait for it)
  assert.equal(clock.t - T0 * 1000, (chain.calls.length - 1) * 200);
  assert.ok(clock.slept.every((ms) => ms > 0 && ms <= 200));
  const snap = pnl.snapshot();
  assert.deepEqual([snap.wallets, snap.queue, snap.running, snap.rows, snap.done, snap.txUnread, snap.calls], [1, 0, 0, 3, 1, 1, chain.calls.length]);
  // the body: s2 + s5 are KID buys (quoted in M's units), s1 an M buy (quoted in lamports); the sell at s7 is beyond the cap
  const body = await pnl.pnl(W);
  assert.deepEqual(body.history, { state: "done", scanned: 5, total: 5, cut: true, unread: 1, since: T0 - 40, trackedAt: T0, gap: null });
  const kid = body.coins.find((c) => c.mint === KID), root = body.coins.find((c) => c.mint === M);
  assert.deepEqual({ ...kid, realizedUsdNow: null, costUsdNow: null }, {
    mint: KID, coin: { name: "KID coin", symbol: "KID", image: null }, quoteMint: M, quoteSymbol: "MMM", quoteDecimals: 6, baseDecimals: 6,
    boughtBase: "1000", boughtQuote: "80", soldBase: "0", soldQuote: "0", realizedQuote: "0", costQuote: "80", heldBase: "1000", partial: false,
    buys: 2, sells: 0, firstAt: T0 - 40, lastAt: T0 - 10, realizedUsdNow: null, costUsdNow: null,
  });
  // USD at the quote's price NOW: 80 units of M (6 decimals) at M's current price; lamports at the SOL price
  const mUsd = m.quoteUsdOf(M);
  assert.ok(mUsd > 0); assert.ok(Math.abs(kid.costUsdNow - (80 / 1e6) * mUsd) < 1e-15); assert.equal(kid.realizedUsdNow, 0);
  assert.deepEqual([root.quoteMint, root.quoteSymbol, root.quoteDecimals, root.costQuote], [null, "SOL", 9, "500"]);
  assert.ok(Math.abs(root.costUsdNow - (500 / 1e9) * 100) < 1e-15);
  assert.ok(Math.abs(body.totals.costUsdNow - (kid.costUsdNow + root.costUsdNow)) < 1e-15); assert.equal(body.totals.realizedUsdNow, 0); assert.equal(body.totals.unpriced, 0);
  pnl.stop(); db.close();
});

test("scan: the whole history when it fits (not cut), a sell realized against the scanned buys, one row for a trade also seen live", async () => {
  const { db, m, ix } = setup();
  const { sigs, txs } = sevenTxs();
  const chain = fakeChain(sigs, txs), clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet });
  pnl.register(W);
  // the live stream delivers s1 before the scan reads it
  ix.onLogs({ slot: 100, signature: "s1", err: null, logs: txs.get("s1").meta.logMessages });
  assert.equal(walletRows(db, W).length, 1);
  pnl.start(); await pnl.idle();
  const w = pnl.wallets.get(W);
  assert.deepEqual([w.state, w.scanned, w.total, w.cut, w.unread], ["done", 7, 7, false, 1]);
  assert.deepEqual(walletRows(db, W).sort(), ["s1/0/buy/1000000/500", "s2/1/buy/600/60", "s5/0/buy/400/20", "s7/0/sell/500/100"]);
  assert.equal(w.rows, 4);
  assert.equal(chain.calls.filter((c) => c.method === "getSignaturesForAddress").length, 1, "a short page ends the listing: no probe");
  // in time order: sell 500 KID at T0-60 (nothing bought before it: unexplained), then buys of 400 and 600
  const kid = (await pnl.pnl(W)).coins.find((c) => c.mint === KID);
  assert.deepEqual([kid.partial, kid.realizedQuote, kid.soldBase, kid.soldQuote, kid.heldBase, kid.costQuote], [true, "0", "500", "100", "1000", "80"]);
  // a window: only the buy at T0-10 is inside, the cost basis is the whole history's
  const win = (await pnl.pnl(W, T0 - 20)).coins.find((c) => c.mint === KID);
  assert.deepEqual([win.buys, win.sells, win.boughtBase, win.costQuote, win.firstAt], [1, 0, "600", "80", T0 - 60]);
  pnl.stop(); db.close();
});

test("scan: a stop keeps the stored progress and the next start resumes at the oldest signature reached", async () => {
  const { db, m } = setup();
  const n = PNL_CHUNK * 2 + 5;
  const B = T0 - 5000; // long before the stop: what the downtime's catch-up lists again is none of these
  const sigs = Array.from({ length: n }, (_, i) => ({ signature: `r${i}`, blockTime: B - i, slot: 1000 - i, err: null }));
  const txs = new Map(sigs.map((s, i) => [s.signature, txOf(frame(CURVE, curveTrade(KID, W, { base: String(i + 1), quote: "1", at: B - i })), { blockTime: B - i })]));
  let pnl;
  // the server stops while the second chunk is being read
  const chain = fakeChain(sigs, txs, { onCall: (method, params, calls) => { if (calls.filter((c) => c.method === "getTransaction").length === PNL_CHUNK + 3) pnl.stop(); } });
  const clock = fakeClock();
  pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  pnl.register(W);
  await new Promise((r) => setTimeout(r, 50));
  const stored = db.pnlWallets()[0];
  assert.deepEqual([stored.state, stored.scanned, stored.total, stored.beforeSig, stored.rows], ["running", PNL_CHUNK, n, `r${PNL_CHUNK - 1}`, PNL_CHUNK]);
  assert.equal(db.walletTradesCount(W), PNL_CHUNK, "the chunk under way was not stored");
  const callsAtStop = chain.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(chain.calls.length <= callsAtStop + 1, "nothing is read after the stop");
  // a new process on the same database
  const chain2 = fakeChain(sigs, txs), clock2 = fakeClock();
  const pnl2 = new PnlTracker({ model: m, rpc: chain2, now: clock2.now, sleep: clock2.sleep, log: quiet });
  assert.deepEqual([pnl2.snapshot().wallets, pnl2.snapshot().queue, pnl2.snapshot().rows], [1, 1, PNL_CHUNK]);
  assert.ok(pnl2.wallets.get(W).gapFrom >= T0, "the wallet may have traded while the server was down");
  pnl2.start(); await pnl2.idle();
  const list = chain2.calls.find((c) => c.method === "getSignaturesForAddress");
  assert.deepEqual([list.params[1].before, list.params[1].limit], [`r${PNL_CHUNK - 1}`, 1000 - PNL_CHUNK]);
  assert.equal(chain2.count("getTransaction"), n - PNL_CHUNK, "nothing already stored is read again");
  const w = pnl2.wallets.get(W);
  assert.deepEqual([w.state, w.scanned, w.total, w.cut, w.rows, w.gapFrom], ["done", n, n, false, n, null]);
  assert.equal(db.walletTradesCount(W), n);
  assert.equal(chain2.count("getSignaturesForAddress"), 2, "the scan's listing, then the catch-up's (nothing newer than the stop)");
  pnl2.stop(); db.close();
});

test("scan: a listing that fails leaves the wallet failed (the request still answers) and a later request queues it again", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  let down = true;
  const chain = fakeChain(sigs, txs, { onCall: (method) => { if (down && method === "getSignaturesForAddress") throw new Error("rpc down"); } });
  const clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  await pnl.pnl(W); await pnl.idle();
  let body = await pnl.pnl(W);
  assert.deepEqual([body.ok, body.history.state, body.history.scanned, body.coins.length], [true, "failed", 0, 0]);
  assert.equal(pnl.snapshot().failed, 1);
  down = false;
  await pnl.pnl(W); await pnl.idle();
  assert.equal(pnl.wallets.get(W).state, "failed", "not asked again at once");
  clock.t += PNL_RETRY_FAILED_MS + 1000;
  await pnl.pnl(W); await pnl.idle();
  body = await pnl.pnl(W);
  assert.deepEqual([body.history.state, body.history.scanned, body.history.cut], ["done", 7, false]);
  pnl.stop(); db.close();
});

test("scan: off without an RPC or with PNL_BACKFILL=0 (trades are kept from now on); the scan stops at the row cap", async () => {
  const { db, m } = setup();
  const off = new PnlTracker({ model: m, log: quiet }).start();
  assert.equal((await off.pnl(W)).history.state, "off"); assert.equal(off.snapshot().enabled, false); assert.equal(off.snapshot().queue, 0);
  const { sigs, txs } = sevenTxs();
  const chain = fakeChain(sigs, txs);
  const off2 = new PnlTracker({ model: m, rpc: chain, cfg: { backfill: false }, log: quiet }).start();
  await off2.pnl(W2); await off2.idle();
  assert.equal(chain.calls.length, 0);
  db.close();
  // the row cap: the scan stops once the wallet holds PNL_MAX_TRADES rows, and says the history is cut
  const b = setup();
  const n = PNL_CHUNK * 3;
  const many = Array.from({ length: n }, (_, i) => ({ signature: `c${i}`, blockTime: T0 - i, slot: 1, err: null }));
  const manyTx = new Map(many.map((s, i) => [s.signature, txOf(frame(CURVE, curveTrade(KID, W, { at: T0 - i })))]));
  const chain3 = fakeChain(many, manyTx), clock = fakeClock();
  const capped = new PnlTracker({ model: b.m, rpc: chain3, cfg: { maxTrades: PNL_CHUNK }, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  capped.register(W); await capped.idle();
  const w = capped.wallets.get(W);
  assert.deepEqual([w.state, w.rows, w.scanned, w.total, w.cut], ["done", PNL_CHUNK, PNL_CHUNK, n, true]);
  assert.equal(chain3.count("getTransaction"), PNL_CHUNK);
  capped.stop(); b.db.close();
});

test("scan: through the real client on the pnl lane: RPC_URL only (never the metered endpoint), bounded per call", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  const seen = [];
  const rpc = new Rpc({ url: "https://free.example", rps: 1000, pnlRps: 1000, log: quiet, user: { url: "https://paid.example/?api-key=k", rps: 1000, dailyCredits: 1_000_000 },
    fetchImpl: async (url, init) => {
      const { method, params, id } = JSON.parse(init.body);
      seen.push([new URL(url).host, method]);
      const result = method === "getSignaturesForAddress" ? sigs.slice(0, params[1].limit) : (() => { const v = txs.get(params[0]); return v instanceof Error || typeof v === "function" ? null : v; })();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
    } });
  const clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: rpc.lane("pnl"), now: clock.now, sleep: clock.sleep, log: quiet }).start();
  pnl.register(W); await pnl.idle();
  assert.equal(pnl.wallets.get(W).state, "done");
  assert.ok(seen.length >= 7 && seen.every(([host]) => host === "free.example"), "the scan never reaches the metered endpoint");
  assert.equal(rpc.userSnapshot().credits.used, 0);
  assert.ok("pnl" in rpc.laneSnapshot());
  pnl.stop(); db.close();
});

// ---------------------------------------------------------------- eviction
test("eviction: past PNL_MAX_WALLETS the least recently asked-for wallet goes with its rows; it is no longer tracked", async () => {
  const { db, m } = setup();
  const clock = fakeClock();
  const pnl = new PnlTracker({ model: m, cfg: { maxWallets: 2 }, now: clock.now, log: quiet });
  const buy = (user, sig) => m.recordTrade({ sig, mint: KID, idx: 0, slot: 1, time: T0, isBuy: true, user, baseAmount: "1", quoteAmount: "1", priceQuote: 1 });
  pnl.register(W); buy(W, "a1"); buy(W, "a2");
  clock.t += 100_000; pnl.register(W2); buy(W2, "b1");
  clock.t += 100_000; pnl.register(W); // W was asked for again: W2 is now the least recent
  // both hold trades and were asked for today: a newcomer is refused, nothing is dropped for it
  clock.t += 100_000;
  assert.equal(pnl.register(W3), null); assert.equal(pnl.tracks(W3), false);
  const refused = await pnl.pnl(W3);
  assert.deepEqual([refused.ok, refused.history.state, refused.coins, pnl.snapshot().refused, pnl.snapshot().evicted], [true, "full", [], 2, 0]);
  // a day later W2 was not asked for again (W was): it makes room
  clock.t += PNL_EVICT_IDLE_S * 1000; pnl.register(W);
  clock.t += 1000; pnl.register(W3);
  await pnl.purgeRun;
  assert.deepEqual([...pnl.wallets.keys()].sort(), [W, W3].sort());
  assert.deepEqual(db.pnlWallets().map((w) => w.wallet).sort(), [W, W3].sort());
  assert.equal(db.walletTradesCount(W2), 0); assert.equal(db.walletTradesCount(W), 2);
  assert.deepEqual([pnl.snapshot().wallets, pnl.snapshot().rows, pnl.snapshot().evicted, pnl.snapshot().purging], [2, 2, 1, 0]);
  assert.deepEqual(db.kvGet("pnlPurge"), []);
  buy(W2, "b2");
  assert.equal(db.walletTradesCount(W2), 0, "an evicted wallet's trades are not kept any more");
  // asked for again, it starts over; W3 holds nothing yet (no rows, no history read), so it goes first whatever its age
  clock.t += 100_000;
  assert.equal(pnl.register(W2).rows, 0);
  await pnl.purgeRun;
  assert.deepEqual([...pnl.wallets.keys()].sort(), [W, W2].sort());
  assert.equal(db.walletTradesCount(W), 2);
  db.close();
});

// ---------------------------------------------------------------- the body and its cache
test("body: a coin whose quote has no price has null USD fields; one build per wallet and since while it is fresh; a new trade drops it", async () => {
  const { db, m } = setup();
  const clock = fakeClock();
  const pnl = new PnlTracker({ model: m, now: clock.now, log: quiet });
  pnl.register(W);
  const put = (sig, mint, isBuy, base, quote, time) => pnl.onTrade({ sig, mint, idx: 0, slot: 1, time, isBuy, user: W, baseAmount: String(base), quoteAmount: String(quote) });
  put("n1", NOPRICE, true, 100, 1000, T0 - 50); put("n2", NOPRICE, false, 40, 900, T0 - 40);
  const [a, b] = await Promise.all([pnl.pnl(W), pnl.pnl(W)]);
  assert.equal(a, b, "requests under way share one build");
  const c = a.coins[0];
  assert.deepEqual([c.mint, c.quoteMint, c.realizedQuote, c.costQuote, c.heldBase, c.realizedUsdNow, c.costUsdNow], [NOPRICE, UNKNOWN_QUOTE, "500", "600", "60", null, null]);
  assert.deepEqual(a.totals, { realizedUsdNow: null, costUsdNow: null, unpriced: 1 });
  assert.deepEqual([a.ok, a.wallet, a.at, a.since, a.trades], [true, W, T0, null, 2]);
  assert.equal(await pnl.pnl(W), a);
  assert.deepEqual([pnl.snapshot().builds, pnl.snapshot().shared, pnl.snapshot().hits], [1, 1, 1]);
  assert.notEqual(await pnl.pnl(W, T0 - 45), a, "another window is its own body");
  // a priced coin next to it: the totals count what has a price and say how many coins have none
  put("k1", KID, true, 10, 1_000_000, T0 - 30);
  const again = await pnl.pnl(W);
  assert.notEqual(again, a, "a new trade of the wallet drops the kept body");
  assert.deepEqual(again.coins.map((x) => x.mint), [KID, NOPRICE], "newest activity first");
  assert.equal(again.totals.unpriced, 1); assert.ok(again.totals.costUsdNow > 0); assert.equal(again.totals.realizedUsdNow, 0);
  clock.t += PNL_CACHE_MS + 1;
  assert.notEqual(await pnl.pnl(W), again, "rebuilt once it is stale");
  // a wallet without trades
  const empty = await pnl.pnl(W2);
  assert.deepEqual([empty.coins, empty.totals, empty.trades], [[], { realizedUsdNow: 0, costUsdNow: 0, unpriced: 0 }, 0]);
  db.close();
});

test("body: built in slices; trades of one second keep their order (slot, then the transactions' own order) across a slice's end", async () => {
  const { db, m } = setup();
  const pnl = new PnlTracker({ model: m, log: quiet });
  pnl.register(W);
  const put = (sig, isBuy, base, quote, time, slot) => pnl.onTrade({ sig, mint: KID, idx: 0, slot, time, isBuy, user: W, baseAmount: String(base), quoteAmount: String(quote) });
  for (let i = 0; i < PNL_SLICE - 1; i++) put(`f${i}`, true, 1, 1, T0 + i, i);
  for (let i = 0; i < PNL_SLICE - 1; i++) put(`g${i}`, false, 1, 2, T0 + PNL_SLICE + i, i); // every filler buy sold again: +1 each
  // stored sell-first (a scan reads newest first), in the same second, right where the first slice ends
  const at = T0 + PNL_SLICE - 1;
  db.q.walletTradesDrop.run(W); pnl.wallets.get(W).rows = 0;
  for (let i = 0; i < PNL_SLICE - 1; i++) put(`f${i}`, true, 1, 1, T0 + i, i);
  put("sell", false, 10, 500, at, 7001); put("buy", true, 10, 100, at, 7000);
  for (let i = 0; i < PNL_SLICE - 1; i++) put(`g${i}`, false, 1, 2, T0 + PNL_SLICE + i, i);
  const page = db.walletTradesPage(W, null, PNL_SLICE);
  assert.equal(page[page.length - 1].sig, "buy", "the table hands them out in trade order, and the slice ends between the two");
  assert.equal(db.walletTradesPage(W, page[page.length - 1], 1)[0].sig, "sell");
  const body = await pnl.pnl(W);
  const kid = body.coins[0];
  assert.equal(body.trades, 2 * PNL_SLICE);
  assert.deepEqual([kid.partial, kid.heldBase, kid.costQuote, kid.buys, kid.sells], [false, "0", "0", PNL_SLICE, PNL_SLICE]);
  assert.equal(kid.realizedQuote, String(500 + 2 * (PNL_SLICE - 1) - 100 - (PNL_SLICE - 1)), "sold − bought over a closed position");
  db.close();
});

// ---------------------------------------------------------------- routes
test("routes: /api/pnl and /api/activity: shapes, validation, paging, the rate limit, degrade, health", async () => {
  const { db, m } = setup();
  const hub = new EventHub({ heartbeatMs: 200 });
  const dir = mkdtempSync(join(tmpdir(), "spore-pnl-"));
  let t = T0 * 1000;
  const pnl = new PnlTracker({ model: m, now: () => t, log: quiet });
  const appOf = (extra = {}) => createApp({ model: m, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc: { call: async () => { throw new Error("no chain in this test"); } }, hub, images: new ImageCache(dir), meta: null, platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet, now: () => t, pnl, ...extra });
  const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const server = await listen(appOf());
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (p, u = url) => fetch(u + p).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));
  try {
    // activity does not register a wallet
    let r = await get(`/api/activity/${W}`);
    assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, wallet: W, at: T0, tracked: false, history: null, trades: [], next: null });
    assert.equal(pnl.snapshot().wallets, 0);
    r = await get(`/api/pnl/${W}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, wallet: W, at: T0, since: null, history: { state: "off", scanned: 0, total: 0, cut: false, unread: 0, since: null, trackedAt: T0, gap: null }, trades: 0, coins: [], totals: { realizedUsdNow: 0, costUsdNow: 0, unpriced: 0 } });
    assert.match(r.headers.get("cache-control"), /max-age=2/); assert.match(r.headers.get("x-ratelimit-policy"), /name=pnl/);
    assert.equal(pnl.snapshot().wallets, 1);
    // five trades of the wallet, two in the same second
    const put = (sig, mint, isBuy, base, quote, time) => m.recordTrade({ sig, mint, idx: 0, slot: 1, time, isBuy, user: W, baseAmount: String(base), quoteAmount: String(quote), priceQuote: 1 });
    put("t1", KID, true, 100, 1000, T0 - 500); put("t2", KID, false, 50, 800, T0 - 400); put("t3", M, true, 7, 70, T0 - 300); put("t4", M, true, 8, 80, T0 - 300); put("t5", KID, false, 50, 100, T0 - 200);
    r = await get(`/api/pnl/${W}`);
    const kid = r.body.coins.find((c) => c.mint === KID);
    assert.deepEqual([kid.realizedQuote, kid.costQuote, kid.heldBase, kid.buys, kid.sells, kid.partial], [String(300 - 400), "0", "0", 1, 2, false]);
    assert.equal(r.body.trades, 5);
    r = await get(`/api/pnl/${W}?since=${T0 - 250}`);
    assert.equal(r.body.since, T0 - 260, "since counts in whole minutes");
    assert.deepEqual(r.body.coins.map((c) => [c.mint, c.realizedQuote, c.sells, c.buys]), [[KID, "-400", 1, 0], [M, "0", 0, 0]], "M is still held: listed with its cost");
    // validation
    for (const bad of [`/api/pnl/nope`, `/api/pnl/${W}?since=abc`, `/api/pnl/${W}?since=-5`, `/api/pnl/${W}?since=1.5`, `/api/pnl/${W}?since=${T0 + 10 * 86_400}`, `/api/activity/nope`, `/api/activity/${W}?before=x`, `/api/activity/${W}?before=1:2:3`]) {
      const x = await get(bad);
      assert.equal(x.status, 400, bad); assert.ok(x.body.error, bad);
    }
    // activity: newest first, a coin ref, the quote; pages by the cursor without losing the pair in one second
    r = await get(`/api/activity/${W}?limit=3`);
    assert.deepEqual(r.body.trades.map((x) => x.sig), ["t5", "t4", "t3"]);
    assert.deepEqual(r.body.trades[0], { sig: "t5", mint: KID, coin: { name: "KID coin", symbol: "KID", image: null }, side: "sell", baseAmount: "50", quoteAmount: "100", baseDecimals: 6, quoteMint: M, quoteSymbol: "MMM", quoteDecimals: 6, time: T0 - 200 });
    assert.deepEqual([r.body.trades[1].side, r.body.trades[1].quoteMint, r.body.trades[1].quoteSymbol, r.body.trades[1].quoteDecimals], ["buy", null, "SOL", 9]);
    assert.equal(r.body.tracked, true); assert.equal(r.body.history.state, "off");
    r = await get(`/api/activity/${W}?limit=2`);
    assert.deepEqual(r.body.trades.map((x) => x.sig), ["t5", "t4"]); assert.match(r.body.next, /^\d+:\d+$/);
    r = await get(`/api/activity/${W}?limit=2&before=${r.body.next}`);
    assert.deepEqual(r.body.trades.map((x) => x.sig), ["t3", "t2"]);
    r = await get(`/api/activity/${W}?limit=2&before=${r.body.next}`);
    assert.deepEqual(r.body.trades.map((x) => x.sig), ["t1"]); assert.equal(r.body.next, null);
    r = await get(`/api/activity/${W}?before=${T0 - 300}`);
    assert.deepEqual(r.body.trades.map((x) => x.sig), ["t2", "t1"], "a plain time: strictly older");
    r = await get(`/api/activity/${W}?limit=100000`);
    assert.equal(r.body.trades.length, 5); assert.ok(ACTIVITY_MAX === 100);
    // new wallets per IP: one that is tracked already is served whatever the count, a new one past the limit is not registered
    const s3 = await listen(appOf({ rates: { pnlnew: { limit: 1, windowMs: 3_600_000 } } }));
    try {
      const u3 = `http://127.0.0.1:${s3.address().port}`;
      assert.equal((await get(`/api/pnl/${W}`, u3)).status, 200);
      assert.equal((await get(`/api/pnl/${W2}`, u3)).status, 200);
      r = await get(`/api/pnl/${W3}`, u3);
      assert.equal(r.status, 429); assert.ok(r.body.retryAfter >= 1); assert.match(r.body.error, /pnlnew/);
      assert.equal(pnl.tracks(W3), false);
      assert.equal((await get(`/api/pnl/${W2}`, u3)).status, 200); assert.equal((await get(`/api/pnl/${W}`, u3)).status, 200);
      assert.equal((await get(`/api/activity/${W3}`, u3)).status, 200, "the activity list registers nothing and is not counted");
      pnl.wallets.delete(W2); db.pnlWalletDrop(W2);
    } finally { s3.close(); }
    // health
    r = await get("/api/health");
    assert.deepEqual([r.body.pnl.wallets, r.body.pnl.queue, r.body.pnl.running, r.body.pnl.rows, r.body.pnl.enabled], [1, 0, 0, 5, false]);
    // the routes' own limit (both share it), and a store that cannot be read: 200 with ok false, never a 500
    const broken = { pnl: async () => { throw new Error("database is locked"); }, activity: () => { throw new Error("database is locked"); }, snapshot: () => ({}) };
    const s2 = await listen(appOf({ rates: { pnl: { limit: 3, windowMs: 60_000 } }, pnl: broken }));
    try {
      const u2 = `http://127.0.0.1:${s2.address().port}`;
      r = await get(`/api/pnl/${W}?since=125`, u2);
      assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: false, wallet: W, at: T0, since: 120, history: null, trades: 0, coins: [], totals: { realizedUsdNow: null, costUsdNow: null, unpriced: 0 } });
      r = await get(`/api/activity/${W}`, u2);
      assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: false, wallet: W, at: T0, tracked: false, history: null, trades: [], next: null });
      assert.equal((await get(`/api/pnl/nope`, u2)).status, 400);
      r = await get(`/api/activity/${W}`, u2);
      assert.equal(r.status, 429); assert.ok(r.body.retryAfter >= 1);
      assert.equal((await get("/api/stats", u2)).status, 200, "the rest of the API is not limited by it");
    } finally { s2.close(); }
    assert.deepEqual(DEFAULT_RATES.pnl, [60, 60_000]);
  } finally { hub.close(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- order, fees, bounds, failures
test("order: a buy and a sell of one slot are applied as the chain ran them, whatever their signatures; the activity list agrees", async () => {
  const { db, m, ix } = setup();
  // newest first: the sell ("2aa") ran after the buy ("5zz") in slot 300, and its signature sorts first
  const sigs = [{ signature: "2aa", blockTime: T0, slot: 300, err: null }, { signature: "5zz", blockTime: T0, slot: 300, err: null }];
  const txs = new Map([["2aa", txOf(frame(CURVE, curveTrade(KID, W, { buy: false, base: "100", quote: "1500" })), { slot: 300 })], ["5zz", txOf(frame(CURVE, curveTrade(KID, W, { buy: true, base: "100", quote: "1000" })), { slot: 300 })]]);
  const clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: fakeChain(sigs, txs), now: clock.now, sleep: clock.sleep, log: quiet }).start();
  pnl.register(W); await pnl.idle();
  let kid = (await pnl.pnl(W)).coins[0];
  assert.deepEqual([kid.realizedQuote, kid.heldBase, kid.costQuote, kid.partial], ["500", "0", "0", false]);
  assert.deepEqual(pnl.activity(W).trades.map((t) => t.sig), ["2aa", "5zz"], "newest first");
  const first = pnl.activity(W, { limit: 1 });
  const [time, id] = first.next.split(":").map(Number);
  assert.deepEqual(pnl.activity(W, { limit: 1, beforeTime: time, beforeId: id }).trades.map((t) => t.sig), ["5zz"], "the cursor pages through one second in the same order");
  assert.deepEqual(pnl.activity(W, { beforeTime: time, beforeId: 999_999 }).trades, [], "a cursor whose row is gone: strictly older");
  // live: the order the stream delivered them in; the amounts are the wallet's own, fees included
  pnl.register(W2); await pnl.idle();
  const fee = { fee: new BN(4), creator_fee: new BN(1) };
  ix.onLogs({ slot: 400, signature: "9buy", err: null, logs: frame(CURVE, curveTrade(KID, W2, { buy: true, base: "10", quote: "100" }, fee)) });
  ix.onLogs({ slot: 400, signature: "1sell", err: null, logs: frame(CURVE, curveTrade(KID, W2, { buy: false, base: "10", quote: "300" }, fee)) });
  assert.deepEqual(walletRows(db, W2), ["9buy/0/buy/10/105", "1sell/0/sell/10/295"]);
  assert.deepEqual(db.tradesFor(KID, 2).map((t) => t.quoteAmount).sort(), ["100", "300"], "the coin's own trades keep the swap amounts");
  kid = (await pnl.pnl(W2)).coins[0];
  assert.deepEqual([kid.realizedQuote, kid.heldBase, kid.partial, kid.boughtQuote, kid.soldQuote], ["190", "0", false, "105", "295"]);
  assert.deepEqual(pnl.activity(W2).trades.map((t) => t.sig), ["1sell", "9buy"]);
  pnl.stop(); db.close();
});

test("queue: the most recently asked-for wallet is read first and the line is bounded; the day's chain reads are capped", async () => {
  const { db, m } = setup();
  const order = [];
  const chain = fakeChain([], new Map(), { onCall: (method, params) => { if (method === "getSignaturesForAddress") order.push(params[0]); } });
  const clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, cfg: { maxQueue: 2 }, now: clock.now, sleep: clock.sleep, log: quiet });
  pnl.register(W); clock.t += 1000; pnl.register(W2); clock.t += 1000; pnl.register(W3);
  assert.deepEqual([pnl.snapshot().queue, pnl.snapshot().displaced, pnl.snapshot().wallets], [2, 1, 3], "W, asked for longest ago, left the line (it stays tracked)");
  clock.t += 1000; pnl.register(W2);
  pnl.start(); await pnl.idle();
  assert.deepEqual(order, [W2, W3]);
  assert.equal(pnl.wallets.get(W).state, "queued");
  clock.t += 1000; pnl.register(W); await pnl.idle();
  assert.deepEqual([order, pnl.wallets.get(W).state], [[W2, W3, W], "done"], "its next request puts it back in line");
  pnl.stop(); db.close();
  // 200 reads a day (the least the cap goes): 450 transactions take three days, and nothing is lost on the way
  const b = setup(), n = 450, DAY = 86_400_000;
  const sigs = Array.from({ length: n }, (_, i) => ({ signature: `d${i}`, blockTime: T0 - i, slot: 5000 - i, err: null }));
  const txs = new Map(sigs.map((x, i) => [x.signature, txOf(frame(CURVE, curveTrade(KID, W, { at: T0 - i })))]));
  const chainB = fakeChain(sigs, txs), clockB = fakeClock();
  const capped = new PnlTracker({ model: b.m, rpc: chainB, cfg: { dailyCalls: 3 }, now: clockB.now, sleep: clockB.sleep, log: quiet }).start();
  assert.equal(capped.snapshot().dailyCalls, 200);
  capped.register(W); await capped.idle();
  const w = capped.wallets.get(W);
  assert.deepEqual([w.state, w.scanned, w.rows, w.unread, w.cut], ["done", n, n, 0, false]);
  assert.equal(Math.floor(clockB.t / DAY) - Math.floor((T0 * 1000) / DAY), 2, "it went on the next day, twice");
  assert.ok(chainB.calls.length <= n + 3 + 2 * PNL_CHUNK, "a day's end repeats at most the chunk under way");
  assert.ok(capped.snapshot().callsToday <= 200);
  capped.stop(); b.db.close();
});

test("outage: transactions failing in a row stop the scan where it had stored, nothing is burnt as unread; a failed wallet is always asked again", async () => {
  const { db, m } = setup();
  const n = PNL_CHUNK * 3;
  const sigs = Array.from({ length: n }, (_, i) => ({ signature: `o${i}`, blockTime: T0 - i, slot: 5000 - i, err: null }));
  const txs = new Map(sigs.map((x, i) => [x.signature, txOf(frame(CURVE, curveTrade(KID, W, { at: T0 - i })))]));
  let down = false, listDown = false;
  const chain = fakeChain(sigs, txs, { onCall: (method, params, calls) => {
    if (method === "getTransaction" && calls.filter((c) => c.method === "getTransaction").length === PNL_CHUNK + 3) down = true;
    if ((down && method === "getTransaction") || (listDown && method === "getSignaturesForAddress")) throw new Error("HTTP 503");
  } });
  const clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  pnl.register(W); await pnl.idle();
  const w = pnl.wallets.get(W);
  assert.deepEqual([w.state, w.scanned, w.unread, w.rows, w.beforeSig, w.attempts], ["failed", PNL_CHUNK, 0, PNL_CHUNK, `o${PNL_CHUNK - 1}`, 1]);
  assert.equal(pnl.snapshot().outages, 1);
  assert.ok(chain.count("getTransaction") <= PNL_CHUNK + 2 + (PNL_OUTAGE_STREAK + 1) * (PNL_TX_RETRIES + 1), "the rest of the history was not asked for");
  assert.ok(pnl.snapshot().pausedMs > 0 && pnl.snapshot().pausedMs <= PNL_OUTAGE_PAUSE_MS, "every scan waits a moment");
  assert.equal((await pnl.pnl(W)).history.state, "failed");
  // the endpoint is back: a request after the wait continues where the scan had stored
  down = false; clock.t += PNL_RETRY_FAILED_MS + 1000;
  pnl.register(W); await pnl.idle();
  assert.deepEqual([w.state, w.scanned, w.unread, w.rows, w.attempts], ["done", n, 0, n, 0]);
  // a listing that keeps failing: the wait doubles, and however often it failed the wallet is tried again
  listDown = true;
  pnl.register(W2); await pnl.idle();
  const w2 = pnl.wallets.get(W2);
  for (let i = 0; i < 7; i++) { clock.t += PNL_RETRY_MAX_MS + 1000; pnl.register(W2); await pnl.idle(); }
  assert.deepEqual([w2.state, w2.attempts], ["failed", 8]);
  clock.t += PNL_RETRY_FAILED_MS * 4; pnl.register(W2); await pnl.idle();
  assert.equal(w2.attempts, 8, "not before its (longer) wait is over");
  listDown = false; clock.t += PNL_RETRY_MAX_MS; pnl.register(W2); await pnl.idle();
  assert.deepEqual([w2.state, w2.attempts], ["done", 0]);
  pnl.stop(); db.close();
});

test("scan: a chunk whose write fails leaves the wallet as the database has it, and the chunk is read again", async () => {
  const { db, m } = setup();
  const n = PNL_CHUNK * 2;
  const sigs = Array.from({ length: n }, (_, i) => ({ signature: `w${i}`, blockTime: T0 - i, slot: 5000 - i, err: null }));
  const txs = new Map(sigs.map((x, i) => [x.signature, txOf(frame(CURVE, curveTrade(KID, W, { at: T0 - i })))]));
  const insert = db.insertWalletTrade.bind(db);
  let k = 0;
  db.insertWalletTrade = (...a) => { if (++k === PNL_CHUNK + 2) throw new Error("disk full"); return insert(...a); };
  const clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: fakeChain(sigs, txs), now: clock.now, sleep: clock.sleep, log: quiet }).start();
  pnl.register(W); await pnl.idle();
  const w = pnl.wallets.get(W), stored = db.pnlWallets()[0];
  assert.deepEqual([w.state, w.scanned, w.rows, w.beforeSig, pnl.snapshot().rows, db.walletTradesCount(W)], ["failed", PNL_CHUNK, PNL_CHUNK, `w${PNL_CHUNK - 1}`, PNL_CHUNK, PNL_CHUNK]);
  assert.deepEqual([stored.state, stored.scanned, stored.rows, stored.beforeSig], ["failed", PNL_CHUNK, PNL_CHUNK, `w${PNL_CHUNK - 1}`]);
  clock.t += PNL_RETRY_FAILED_MS + 1000; pnl.register(W); await pnl.idle();
  assert.deepEqual([w.state, w.scanned, w.rows, db.walletTradesCount(W)], ["done", n, n, n]);
  pnl.stop(); db.close();
});

test("rows: every wallet together is capped; at the cap a new live trade pushes out the wallet's oldest and a scan stops", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  const chain = fakeChain(sigs, txs), clock = fakeClock();
  const pnl = new PnlTracker({ model: m, cfg: { maxRows: 3 }, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet });
  pnl.register(W);
  for (let i = 0; i < 5; i++) pnl.onTrade({ sig: `L${i}`, mint: KID, idx: 0, slot: i, time: T0 + i, isBuy: true, user: W, baseAmount: "1", quoteAmount: "1" });
  const w = pnl.wallets.get(W);
  assert.deepEqual([w.rows, w.cut, pnl.snapshot().rows, pnl.snapshot().maxRows, db.walletTradesCount(W)], [3, true, 3, 3, 3]);
  assert.deepEqual(db.walletTradesPage(W).map((r) => r.sig), ["L2", "L3", "L4"]);
  assert.equal(db.pnlWallets()[0].cut, true);
  pnl.start(); await pnl.idle();
  assert.deepEqual([w.state, w.scanned, w.cut, chain.count("getTransaction")], ["done", 0, true, 0], "no room: the scan reads nothing and says the history is cut");
  pnl.stop(); db.close();
});

test("cache: kept bodies are bounded per wallet and by size, counted, and dropped once stale", async () => {
  const { db, m } = setup();
  const clock = fakeClock();
  const pnl = new PnlTracker({ model: m, now: clock.now, log: quiet });
  pnl.register(W); pnl.register(W2);
  pnl.onTrade({ sig: "c1", mint: KID, idx: 0, slot: 1, time: T0 - 500, isBuy: true, user: W, baseAmount: "1", quoteAmount: "1" });
  pnl.onTrade({ sig: "c2", mint: M, idx: 0, slot: 1, time: T0 - 400, isBuy: true, user: W, baseAmount: "1", quoteAmount: "1" });
  // six windows of one wallet: the four newest are kept; two requests inside one minute are one window
  for (let i = 0; i < 6; i++) await pnl.pnl(W, T0 - 20 - i * 60);
  assert.equal(pnl.cache.get(W).size, PNL_CACHE_SINCE_MAX);
  assert.equal(await pnl.pnl(W, T0 - 20), await pnl.pnl(W, T0 - 1), "since counts in whole minutes");
  await pnl.pnl(W2);
  const weight = () => [...pnl.cache.values()].reduce((a, per) => a + [...per.values()].reduce((x, e) => x + e.weight, 0), 0);
  assert.equal(pnl.snapshot().cachedCoins, weight()); assert.equal(weight(), PNL_CACHE_SINCE_MAX * 3 + 1, "a body weighs its coins + 1");
  assert.ok(PNL_CACHE_COINS <= 100_000);
  // over the size bound the wallets asked for longest ago go
  pnl.cacheCoins += PNL_CACHE_COINS;
  await pnl.pnl(W2, T0 - 80);
  assert.deepEqual([...pnl.cache.keys()], [W2]);
  pnl.cacheCoins -= PNL_CACHE_COINS;
  assert.equal(pnl.snapshot().cachedCoins, weight());
  // a new trade drops the wallet's bodies and their weight; stale bodies go on a later request, whoever it is for
  await pnl.pnl(W);
  pnl.onTrade({ sig: "c3", mint: KID, idx: 0, slot: 2, time: T0 - 300, isBuy: true, user: W, baseAmount: "1", quoteAmount: "1" });
  assert.equal(pnl.cache.has(W), false); assert.equal(pnl.snapshot().cachedCoins, weight());
  clock.t += PNL_CACHE_SWEEP_MS + PNL_CACHE_MS + 1;
  await pnl.pnl(W);
  assert.deepEqual([...pnl.cache.keys()], [W], "W2's stale bodies were dropped");
  assert.equal(pnl.snapshot().cachedCoins, 3);
  db.close();
});

test("downtime: a wallet tracked before a restart has a gap from the last time the tracker was alive; its next request reads what it traded since", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  txs.set("s4", txOf([])); // readable here: an unread transaction would be read again at the second start (its own test below)
  const clock = fakeClock();
  const p1 = new PnlTracker({ model: m, rpc: fakeChain(sigs, txs), now: clock.now, sleep: clock.sleep, log: quiet }).start();
  p1.register(W); await p1.idle();
  assert.equal(p1.wallets.get(W).gapFrom, null);
  clock.t += 600_000; p1.stop();
  const stopAt = Math.floor(clock.t / 1000);
  assert.equal(db.kvGet("pnlAlive"), stopAt);
  // while the server is down the wallet buys (d1) and trades a coin outside the index (d2)
  const newer = [{ signature: "d2", blockTime: stopAt + 200, slot: 901, err: null }, { signature: "d1", blockTime: stopAt + 100, slot: 900, err: null }];
  txs.set("d1", txOf(frame(CURVE, curveTrade(KID, W, { base: "50", quote: "500", at: stopAt + 100 })), { slot: 900, blockTime: stopAt + 100 }));
  txs.set("d2", txOf(frame(CURVE, curveTrade(FOREIGN, W)), { slot: 901, blockTime: stopAt + 200 }));
  let down = true;
  const chain2 = fakeChain([...newer, ...sigs], txs, { onCall: (method) => { if (down && method === "getSignaturesForAddress") throw new Error("rpc down"); } });
  const clock2 = fakeClock((stopAt + 300) * 1000);
  const p2 = new PnlTracker({ model: m, rpc: chain2, now: clock2.now, sleep: clock2.sleep, log: quiet }).start();
  assert.deepEqual([p2.wallets.get(W).gapFrom, db.pnlWallets()[0].gapFrom, p2.snapshot().queue, chain2.calls.length], [stopAt, stopAt, 0, 0], "nothing is read until someone asks");
  // the first try fails: the gap stays, the history is still "done", and it is tried again after a while
  let body = await p2.pnl(W);
  assert.deepEqual([body.history.state, body.history.gap], ["done", stopAt]);
  await p2.idle();
  assert.equal(p2.wallets.get(W).gapFrom, stopAt);
  down = false; p2.register(W); await p2.idle();
  assert.equal(chain2.count("getTransaction"), 0, "not at once");
  clock2.t += PNL_RETRY_FAILED_MS + 1000; p2.register(W); await p2.idle();
  assert.deepEqual(chain2.calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0]).sort(), ["d1", "d2"], `only what is newer than the stop less ${PNL_GAP_MARGIN_S} s`);
  const w = p2.wallets.get(W);
  assert.deepEqual([w.gapFrom, w.state, w.scanned, w.rows, w.cut, db.pnlWallets()[0].gapFrom, p2.snapshot().caughtUp], [null, "done", 7, 5, false, null, 1]);
  body = await p2.pnl(W);
  assert.equal(body.history.gap, null);
  assert.equal(body.coins.find((c) => c.mint === KID).heldBase, "1050", "the buy made while the server was down counts");
  // a wallet first asked for after the start has no gap
  p2.register(W2); await p2.idle();
  assert.equal(p2.wallets.get(W2).gapFrom, null);
  p2.stop(); db.close();
});

test("config: the PNL_* variables, their defaults (a slower scan on the public RPC) and their bounds", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-pnl-cfg-"));
  try {
    const env = { DATA_DIR: dir, META_DIR: dir };
    assert.deepEqual(loadConfig(env, { here: dir }).pnl, { maxWallets: 5000, backfill: true, backfillTx: 1000, backfillRps: 2, maxTrades: 10_000, maxRows: 2_000_000, maxQueue: 200, dailyCalls: 100_000 });
    assert.equal(loadConfig({ ...env, RPC_URL: "https://rpc.example.com" }, { here: dir }).pnl.backfillRps, 5);
    assert.deepEqual(loadConfig({ ...env, PNL_MAX_WALLETS: "10", PNL_BACKFILL: "0", PNL_BACKFILL_TX: "250", PNL_BACKFILL_RPS: "0.5", PNL_MAX_TRADES: "500", PNL_MAX_ROWS: "5000", PNL_MAX_QUEUE: "9", PNL_BACKFILL_DAILY: "0", RATE_PNL: "7" }, { here: dir }).pnl, { maxWallets: 10, backfill: false, backfillTx: 250, backfillRps: 0.5, maxTrades: 500, maxRows: 5000, maxQueue: 9, dailyCalls: 0 });
  assert.deepEqual([loadConfig(env, { here: dir }).rates.pnlnew, loadConfig({ ...env, RATE_PNLNEW: "3" }, { here: dir }).rates.pnlnew.limit], [{ limit: 20, windowMs: 3_600_000 }, 3]);
    assert.equal(loadConfig({ ...env, RATE_PNL: "7" }, { here: dir }).rates.pnl.limit, 7);
    assert.throws(() => loadConfig({ ...env, PNL_BACKFILL_TX: "0", PNL_BACKFILL_RPS: "0", PNL_MAX_WALLETS: "x" }, { here: dir }), (e) => /PNL_BACKFILL_TX/.test(e.message) && /PNL_BACKFILL_RPS/.test(e.message) && /PNL_MAX_WALLETS/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- events from inner instructions
/**
 * A transaction as getTransaction (encoding "json") answers it, with its events as inner instructions: `groups` is one
 * list per outer instruction of `{ program, data, tag }` (tag false = an ordinary instruction, not an event). `alt`: a
 * versioned transaction whose programs are address-table keys (resolved after the static ones).
 */
function innerTx(groups, { logs = null, slot = 100, blockTime = T0, alt = false, order = null } = {}) {
  const programs = [...new Set(groups.flat().map((e) => e.program))];
  const stat = [W, key(1), ...(alt ? [] : programs)], writable = alt ? [key(2), key(3)] : [], readonly = alt ? programs : [];
  const keys = [...stat, ...writable, ...readonly];
  const inner = groups.map((g, index) => ({ index, instructions: g.map((e) => ({ programIdIndex: keys.indexOf(e.program), accounts: [], data: e.raw ?? bs58(e.tag === false ? e.data : Buffer.concat([EVENT_CPI_TAG, e.data])), stackHeight: 2 })) }));
  return { slot, blockTime, version: alt ? 0 : "legacy", transaction: { message: { accountKeys: stat } }, meta: { err: null, logMessages: logs, loadedAddresses: { writable, readonly }, innerInstructions: order ? order.map((i) => inner[i]) : inner } };
}
const ev = (program, data, tag = true) => ({ program, data, tag });
const cutLog = (program, ...events) => [`Program ${program} invoke [1]`, ...events.map((e) => `Program data: ${e.toString("base64")}`), "Log truncated"];

test("inner instructions: a program's events emitted to itself are the log's events, in the log's order, through static and address-table keys", () => {
  const a = curveTrade(KID, OTHER), b = curveTrade(KID, W, { buy: false, base: "3", quote: "33", at: T0 + 9 }), c = poolEvent("SellEvent", W, { base: "4", quote: "44" }), d = poolEvent("BuyEvent", W, { base: "6", quote: "1000", own: "1012" });
  const logs = [...frame(CURVE, a, b), ...frame(AMM, c, d)];
  const shape = (events) => events.map((e) => [e.name, e.program, e.data.toString("hex")]);
  const want = shape(eventsInLogs(logs, LIVE_EVENT_PROGRAMS));
  assert.deepEqual(want.map((x) => x[0]), ["TradeEvent", "TradeEvent", "SellEvent", "BuyEvent"]);
  // between the events: another program using the tag, an ordinary instruction of the curve program, a tagged payload that is no tracked event, data that is not base58
  const groups = [
    [ev(CURVE, a), ev(key(77), b), ev(CURVE, Buffer.from("an ordinary instruction, not an event"), false), ev(CURVE, Buffer.alloc(40, 7)), ev(CURVE, b)],
    [{ program: AMM, raw: "0OIl-not-base58-at-all" }, { program: AMM, raw: 12345 }, ev(AMM, c), ev(AMM, Buffer.alloc(4, 1), false), ev(AMM, d)],
  ];
  for (const alt of [false, true]) {
    const tx = innerTx(groups, { alt });
    assert.equal(tx.transaction.message.accountKeys.includes(CURVE), !alt, "the programs are address-table keys in the versioned one");
    assert.deepEqual(shape(eventsInInner(tx, LIVE_EVENT_PROGRAMS)), want, alt ? "address-table keys" : "static keys");
  }
  // the outer instructions' order decides, not the order the node lists the groups in
  assert.deepEqual(shape(eventsInInner(innerTx(groups, { order: [1, 0] }), LIVE_EVENT_PROGRAMS)), want);
  // only the programs asked for; every program without a filter
  assert.deepEqual(eventsInInner(innerTx(groups), new Set([AMM])).map((e) => e.name), ["SellEvent", "BuyEvent"]);
  assert.equal(eventsInInner(innerTx(groups), null).length, 5);
  // `ix` is not known on this path
  assert.ok(eventsInInner(innerTx(groups), LIVE_EVENT_PROGRAMS).every((e) => e.ix === null));
  // what the transaction does not carry cannot be read: null, not "no events"
  assert.equal(eventsInInner(null, LIVE_EVENT_PROGRAMS), null);
  assert.equal(eventsInInner({ meta: { innerInstructions: [] } }, LIVE_EVENT_PROGRAMS), null);
  assert.equal(eventsInInner({ transaction: { message: { accountKeys: [W] } }, meta: { innerInstructions: null } }, LIVE_EVENT_PROGRAMS), null);
  assert.deepEqual(eventsInInner({ transaction: { message: { accountKeys: [W] } }, meta: { innerInstructions: [] } }, LIVE_EVENT_PROGRAMS), []);
  assert.equal(EVENT_CPI_TAG.toString("hex"), "e445a52e51cb9a1d");
});

test("tradesOfTx: a cut or missing log falls back to the inner instructions and gives the very rows of the whole log", () => {
  const { db, m } = setup();
  const a = curveTrade(KID, OTHER), b = curveTrade(KID, W, { buy: false, base: "3", quote: "33", at: T0 + 9 }), c = poolEvent("SellEvent", W, { base: "4", quote: "44" }), d = poolEvent("BuyEvent", W, { base: "6", quote: "1000", own: "1012" });
  const logs = [...frame(CURVE, a, b), ...frame(AMM, c, d)], groups = [[ev(CURVE, a), ev(CURVE, b)], [ev(AMM, c), ev(AMM, d)]];
  const whole = tradesOfTx(m, W, "SIG", innerTx(groups, { logs, slot: 77 }));
  assert.deepEqual(whole, { rows: [
    { sig: "SIG", mint: KID, idx: 1, slot: 77, time: T0 + 9, isBuy: false, baseAmount: "3", quoteAmount: "33" },
    { sig: "SIG", mint: M, idx: 2, slot: 77, time: T0, isBuy: false, baseAmount: "4", quoteAmount: "44" },
    { sig: "SIG", mint: M, idx: 3, slot: 77, time: T0, isBuy: true, baseAmount: "6", quoteAmount: "1012" },
  ], truncated: false, incomplete: false }, "a whole log is the answer: the inner instructions are not consulted");
  for (const alt of [false, true]) {
    // the log ends after the first event: the three trades of the wallet are all behind the cut
    const cut = tradesOfTx(m, W, "SIG", innerTx(groups, { logs: cutLog(CURVE, a), slot: 77, alt }));
    assert.deepEqual(cut, { rows: whole.rows, truncated: true, incomplete: false, inner: true });
    // no log at all
    assert.deepEqual(tradesOfTx(m, W, "SIG", innerTx(groups, { logs: null, slot: 77, alt })), { rows: whole.rows, truncated: false, incomplete: false, inner: true });
  }
  // a cut log of a transaction with no event of the two programs: nothing to read, and complete
  assert.deepEqual(tradesOfTx(m, W, "SIG", innerTx([[ev(key(77), b)]], { logs: [`Program ${key(77)} invoke [1]`, "Log truncated"] })), { rows: [], truncated: true, incomplete: false, inner: true });
  // inner instructions that hold fewer events than the log showed are not trusted: the log's rows, unread
  const fewer = tradesOfTx(m, W, "SIG", innerTx([[ev(CURVE, a)]], { logs: cutLog(CURVE, a, b), slot: 77 }));
  assert.deepEqual(fewer, { rows: [whole.rows[0]], truncated: true, incomplete: true });
  // a cut log and no inner-instruction list (an old transaction): unread, as before
  assert.deepEqual(tradesOfTx(m, W, "SIG", txOf(cutLog(CURVE, a, b), { slot: 77 })), { rows: [whole.rows[0]], truncated: true, incomplete: true });
  // an event that decodes on neither path (an older layout) leaves the transaction unread on both
  const old = curveTrade(KID, W).subarray(0, 120), later = curveTrade(KID, W, { base: "8", quote: "80" });
  const o = tradesOfTx(m, W, "SIG", innerTx([[ev(CURVE, old), ev(CURVE, later)]], { logs: frame(CURVE, old, later) }));
  assert.deepEqual([o.rows.map((x) => `${x.idx}/${x.baseAmount}`), o.truncated, o.incomplete, o.inner], [["1/8"], false, true, true]);
  // a transaction that failed on chain has no trades whatever it carries
  const failed = innerTx(groups, { logs: cutLog(CURVE, a) }); failed.meta.err = { InstructionError: [0, "Custom"] };
  assert.deepEqual(tradesOfTx(m, W, "SIG", failed), { rows: [], truncated: false, incomplete: false });
  db.close();
});

test("scan: a transaction with a cut log is read from its inner instructions, not counted unread, and the part the live stream stored is not stored twice", async () => {
  const { db, m, ix } = setup();
  const a = curveTrade(KID, OTHER), b = curveTrade(KID, W, { buy: false, base: "3", quote: "33", at: T0 }), c = poolEvent("SellEvent", W, { base: "4", quote: "44" }), d = poolEvent("BuyEvent", W, { base: "6", quote: "1000", own: "1012" });
  const groups = [[ev(CURVE, a), ev(CURVE, b)], [ev(AMM, c), ev(AMM, d)]];
  const sigs = [{ signature: "x1", blockTime: T0, slot: 100, err: null }];
  const chain = fakeChain(sigs, new Map([["x1", innerTx(groups, { logs: cutLog(CURVE, a, b), alt: true })]])), clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet });
  pnl.register(W);
  // the live stream gets the same cut log: the one trade of the wallet before the cut is stored by it
  ix.onLogs({ slot: 100, signature: "x1", err: null, logs: cutLog(CURVE, a, b) });
  assert.deepEqual(walletRows(db, W), ["x1/1/sell/3/33"]);
  pnl.start(); await pnl.idle();
  const w = pnl.wallets.get(W);
  assert.deepEqual([w.state, w.scanned, w.unread, w.rows], ["done", 1, 0, 3]);
  assert.deepEqual(walletRows(db, W).sort(), ["x1/1/sell/3/33", "x1/2/sell/4/44", "x1/3/buy/6/1012"], "the same numbering on both paths: one row per trade");
  assert.deepEqual([pnl.snapshot().txInner, pnl.snapshot().txUnread, pnl.snapshot().unreadStored], [1, 0, 0]);
  assert.deepEqual(db.pnlUnreadOf(W), []);
  pnl.stop(); db.close();
});

// ---------------------------------------------------------------- unread transactions are read again
test("unread: remembered with its place, read again after a doubling wait through the throttle and the day's budget; once read its trades count and unread goes down", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  let up = false;
  txs.set("s4", () => (up ? innerTx([[ev(CURVE, curveTrade(KID, W, { base: "70", quote: "7", at: T0 - 30 }))]], { logs: cutLog(CURVE), blockTime: T0 - 30, slot: 97 }) : new Error("node down")));
  const chain = fakeChain(sigs, txs), clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  pnl.register(W); await pnl.idle();
  const w = pnl.wallets.get(W);
  assert.deepEqual([w.state, w.unread, w.rows], ["done", 1, 4]);
  let [u] = db.pnlUnreadOf(W);
  assert.deepEqual(u, { wallet: W, sig: "s4", ord: -4, attempts: 0, nextAt: clock.t + PNL_UNREAD_RETRY_MS, errors: 0 }, "s4 is the fourth newest: its trades will sort where the scan would have put them");
  assert.deepEqual([pnl.snapshot().unreadStored, pnl.snapshot().unreadDueMs], [1, PNL_UNREAD_RETRY_MS]);
  // not due yet: nothing is read
  let reads = chain.count("getTransaction");
  clock.t += PNL_UNREAD_RETRY_MS - 1; pnl.wake(); await pnl.idle();
  assert.equal(chain.count("getTransaction"), reads);
  // due: tried again (with the scan's own retries, 200 ms apart on the throttle), still down: the wait doubles, but a
  // try the endpoint did not answer is not one of the transaction's tries
  clock.t += 1;
  let t0 = clock.t; pnl.wake(); await pnl.idle();
  assert.equal(chain.count("getTransaction"), reads + 1 + PNL_TX_RETRIES);
  assert.equal(clock.t - t0, PNL_TX_RETRIES * 200, "one read per throttle slot");
  [u] = db.pnlUnreadOf(W);
  assert.deepEqual([u.attempts, u.errors, u.nextAt, w.unread, db.pnlWallets()[0].unread], [0, 1, clock.t + 2 * PNL_UNREAD_RETRY_MS, 1, 1]);
  assert.equal(pnl.snapshot().unreadTries, 1);
  // the day's chain reads are spent when it is due again: it waits for the next UTC day like a scan, and is read then
  up = true; reads = chain.count("getTransaction");
  clock.t = u.nextAt; pnl.budget.used = pnl.cfg.dailyCalls;
  const nextDay = (Math.floor(clock.t / 86_400_000) + 1) * 86_400_000;
  pnl.wake(); await pnl.idle();
  assert.ok(clock.t >= nextDay, "nothing was read on the spent day");
  assert.equal(chain.count("getTransaction"), reads + 1);
  assert.deepEqual([w.unread, w.rows, db.pnlWallets()[0].unread, db.pnlUnreadOf(W).length], [0, 5, 0, 0]);
  assert.deepEqual(db.walletTradesPage(W).filter((r) => r.sig === "s4").map((r) => [r.idx, r.ord, r.isBuy, r.baseAmount, r.quoteAmount, r.time]), [[0, -4, true, "70", "7", T0 - 30]]);
  const snap = pnl.snapshot();
  assert.deepEqual([snap.unreadStored, snap.unreadDueMs, snap.unreadRead, snap.unreadGivenUp, snap.txInner], [0, null, 1, 0, 1]);
  // the body follows: the wallet's P&L counts the buy and says nothing is unread
  const body = await pnl.pnl(W);
  assert.equal(body.history.unread, 0);
  assert.equal(body.coins.find((c) => c.mint === KID).heldBase, "1070");
  // nothing is left to try
  reads = chain.count("getTransaction"); clock.t += 10 * 86_400_000; pnl.wake(); await pnl.idle();
  assert.equal(chain.count("getTransaction"), reads);
  pnl.stop(); db.close();
});

test("unread: given up after PNL_UNREAD_RETRIES tries but kept, so a later read of the same transaction neither counts it twice nor leaves it counted once it reads", async () => {
  const { db, m } = setup();
  let up = false;
  const sigs = [{ signature: "g1", blockTime: T0 + 400 * 86_400, slot: 500, err: null }, { signature: "g2", blockTime: T0 - 10, slot: 90, err: null }];
  const txs = new Map([
    // answered, but its log is cut and it carries no inner instructions: the transaction itself does not read
    ["g1", () => (up ? txOf(frame(CURVE, curveTrade(KID, W, { base: "9", quote: "90", at: T0 + 400 * 86_400 })), { blockTime: T0 + 400 * 86_400, slot: 500 }) : txOf(cutLog(CURVE), { blockTime: T0 + 400 * 86_400, slot: 500 }))],
    ["g2", txOf(frame(CURVE, curveTrade(KID, W, { base: "400", quote: "20", at: T0 - 10 })), { blockTime: T0 - 10 })],
  ]);
  const chain = fakeChain(sigs, txs), clock = fakeClock();
  const p1 = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  p1.register(W); await p1.idle();
  assert.deepEqual([p1.wallets.get(W).unread, db.pnlUnreadOf(W).map((u) => [u.sig, u.ord, u.attempts])], [1, [["g1", -1, 0]]]);
  const waits = [];
  for (let i = 1; i <= PNL_UNREAD_RETRIES; i++) {
    const [u] = db.pnlUnreadOf(W);
    waits.push(u.nextAt - clock.t);
    clock.t = u.nextAt; p1.wake(); await p1.idle();
    assert.equal(db.pnlUnreadOf(W)[0].attempts, i);
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 16].map((k) => k * PNL_UNREAD_RETRY_MS), "the wait doubles");
  assert.deepEqual(db.pnlUnreadOf(W), [{ wallet: W, sig: "g1", ord: -1, attempts: PNL_UNREAD_RETRIES, nextAt: null, errors: 0 }]);
  assert.deepEqual([p1.wallets.get(W).unread, p1.snapshot().unreadGivenUp, p1.snapshot().unreadStored, p1.snapshot().unreadDueMs], [1, 1, 1, null]);
  let reads = chain.count("getTransaction");
  clock.t += 30 * 86_400_000; p1.wake(); await p1.idle();
  assert.equal(chain.count("getTransaction"), reads, "never again on its own");
  assert.equal(reads, 2 + PNL_UNREAD_RETRIES, "bounded: the scan's reads and five more");
  p1.stop();
  // a restart: the wallet's unread transaction is stored, so its history is not read a second time
  const chain2 = fakeChain(sigs, txs), clock2 = fakeClock(clock.t + 300_000);
  const p2 = new PnlTracker({ model: m, rpc: chain2, now: clock2.now, sleep: clock2.sleep, log: quiet }).start();
  assert.deepEqual([p2.snapshot().rescans, p2.snapshot().queue, chain2.calls.length, p2.wallets.get(W).state], [0, 0, 0, "done"]);
  // the catch-up after the downtime lists g1 again (it is newer than the stop) and still cannot read it: counted once
  p2.register(W); await p2.idle();
  assert.ok(chain2.count("getTransaction") >= 1);
  assert.deepEqual([p2.wallets.get(W).unread, p2.wallets.get(W).gapFrom, p2.snapshot().unreadStored, db.pnlUnreadOf(W)[0].attempts], [1, null, 1, PNL_UNREAD_RETRIES]);
  clock2.t += 600_000; p2.stop();
  // and once a later catch-up does read it, its trade is stored and it is no longer unread
  up = true;
  const chain3 = fakeChain(sigs, txs), clock3 = fakeClock(clock2.t + 300_000);
  const p3 = new PnlTracker({ model: m, rpc: chain3, now: clock3.now, sleep: clock3.sleep, log: quiet }).start();
  p3.register(W); await p3.idle();
  assert.deepEqual([p3.wallets.get(W).unread, p3.snapshot().unreadStored, db.pnlUnreadOf(W), db.pnlWallets()[0].unread], [0, 0, [], 0]);
  assert.deepEqual(walletRows(db, W).sort(), ["g1/0/buy/9/90", "g2/0/buy/400/20"]);
  p3.stop(); db.close();
});

test("unread: at most PNL_UNREAD_MAX are remembered per wallet (the rest are only counted), and they go with an evicted wallet", async () => {
  const { db, m } = setup();
  const n = PNL_UNREAD_MAX + 7;
  // transactions whose log is cut and that carry no inner instructions: answered, but unreadable
  const sigs = Array.from({ length: n }, (_, i) => ({ signature: `u${i}`, blockTime: T0 - i, slot: 1000 - i, err: null }));
  const txs = new Map(sigs.map((s) => [s.signature, txOf(cutLog(CURVE), { blockTime: s.blockTime })]));
  let t = T0 * 1000;
  const pnl = new PnlTracker({ model: m, rpc: fakeChain(sigs, txs), cfg: { maxWallets: 1, backfillRps: 1e6 }, now: () => t, sleep: async () => {}, log: quiet }).start();
  pnl.register(W); await pnl.idle();
  assert.deepEqual([pnl.wallets.get(W).unread, db.pnlUnreadCount(W), db.pnlUnreadCount(), pnl.snapshot().unreadStored], [n, PNL_UNREAD_MAX, PNL_UNREAD_MAX, PNL_UNREAD_MAX]);
  // the wallet is dropped for another one: nothing of it is left to try
  t += (PNL_EVICT_IDLE_S + 1) * 1000;
  pnl.stop();
  const p2 = new PnlTracker({ model: m, cfg: { maxWallets: 1 }, now: () => t, log: quiet });
  p2.register(W2);
  assert.deepEqual([p2.tracks(W), db.pnlUnreadCount(), p2.snapshot().unreadStored], [false, 0, 0]);
  p2.stop(); db.close();
});

test("unread: a wallet that counted unread transactions before they were remembered is read once more at the start, without double rows", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  txs.set("s4", txOf(cutLog(CURVE), { blockTime: T0 - 30 })); // as the node answered then: a cut log, nothing else
  const clock = fakeClock();
  const p1 = new PnlTracker({ model: m, rpc: fakeChain(sigs, txs), now: clock.now, sleep: clock.sleep, log: quiet }).start();
  p1.register(W); await p1.idle();
  assert.deepEqual([p1.wallets.get(W).unread, p1.wallets.get(W).rows], [1, 4]);
  p1.stop();
  // the state an older build left: the count, no remembered signature, no mark that wallets were looked at
  db.pnlUnreadDrop(W); db.kvSet("pnlUnreadHealed", false);
  assert.deepEqual(db.pnlWalletsUnstored(), [W]);
  const before = walletRows(db, W).sort();
  // today the same transaction is readable: the buy sits behind the cut, in the inner instructions
  txs.set("s4", innerTx([[ev(CURVE, curveTrade(KID, W, { base: "70", quote: "7", at: T0 - 30 }))]], { logs: cutLog(CURVE), blockTime: T0 - 30, slot: 97 }));
  const chain2 = fakeChain(sigs, txs), clock2 = fakeClock(clock.t + 60_000);
  const p2 = new PnlTracker({ model: m, rpc: chain2, now: clock2.now, sleep: clock2.sleep, log: quiet });
  let w = p2.wallets.get(W);
  assert.deepEqual([w.state, w.unread, w.scanned, w.beforeSig, w.rows, p2.snapshot().rescans, p2.snapshot().queue, db.kvGet("pnlUnreadHealed")], ["queued", 0, 0, null, 4, 1, 1, true]);
  assert.deepEqual([db.pnlWallets()[0].state, db.pnlWallets()[0].unread, db.pnlWallets()[0].scanned], ["queued", 0, 0], "stored: a stop before the scan loses nothing");
  p2.start(); await p2.idle(); // nobody asked: the wallet heals on its own
  w = p2.wallets.get(W);
  assert.deepEqual([w.state, w.unread, w.scanned, w.total, w.rows, w.cut], ["done", 0, 7, 7, 5, false]);
  assert.deepEqual(walletRows(db, W).sort(), [...before, "s4/0/buy/70/7"].sort(), "the rows that were there are kept as they were, the missing one is added");
  assert.equal(db.walletTradesCount(W), 5);
  p2.stop();
  // only once: the next start leaves the wallet alone
  const chain3 = fakeChain(sigs, txs);
  const p3 = new PnlTracker({ model: m, rpc: chain3, now: clock2.now, sleep: clock2.sleep, log: quiet }).start();
  await p3.idle();
  assert.deepEqual([p3.snapshot().rescans, p3.snapshot().queue, p3.wallets.get(W).state, chain3.calls.length], [0, 0, "done", 0]);
  // a tracker that reads no history (no RPC) does not mark anything
  db.kvSet("pnlUnreadHealed", false);
  new PnlTracker({ model: m, now: clock2.now, log: quiet });
  assert.equal(db.kvGet("pnlUnreadHealed"), false);
  p3.stop(); db.close();
});

test("unread: a try the endpoint did not answer burns none of the transaction's tries: an outage of hours leaves it readable", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  let phase = "down";
  txs.set("s4", () => (phase === "up" ? innerTx([[ev(CURVE, curveTrade(KID, W, { base: "70", quote: "7", at: T0 - 30 }))]], { logs: cutLog(CURVE), blockTime: T0 - 30, slot: 97 }) : phase === "cut" ? txOf(cutLog(CURVE), { blockTime: T0 - 30 }) : new Error("429 Too Many Requests")));
  const chain = fakeChain(sigs, txs), clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  pnl.register(W); await pnl.idle();
  const w = pnl.wallets.get(W), t0 = clock.t;
  assert.deepEqual([w.unread, db.pnlUnreadOf(W).length], [1, 1]);
  const round = async () => { clock.t = db.pnlUnreadOf(W)[0].nextAt; pnl.wake(); await pnl.idle(); return db.pnlUnreadOf(W)[0]; };
  // the endpoint is down for hours: tried again and again, ever more rarely, and never counted as a try
  for (let i = 1; i <= 8; i++) {
    const u = await round();
    assert.deepEqual([u.attempts, u.errors, u.nextAt - clock.t], [0, i, Math.min(PNL_RETRY_MAX_MS, PNL_UNREAD_RETRY_MS * 2 ** i)]);
    assert.equal(pnl.snapshot().pausedMs, PNL_OUTAGE_PAUSE_MS, "the other unread ones wait like the scans in an outage");
  }
  assert.ok(clock.t - t0 > 6 * 3_600_000, "well past the hour that used to spend all five tries");
  assert.deepEqual([pnl.snapshot().unreadErrors, pnl.snapshot().unreadGivenUp, w.unread], [8, 0, 1]);
  // the endpoint answers again, the transaction still does not read: that is a try, and the error count starts over
  phase = "cut";
  let u = await round();
  assert.deepEqual([u.attempts, u.errors, u.nextAt - clock.t], [1, 0, 2 * PNL_UNREAD_RETRY_MS]);
  phase = "down"; u = await round();
  assert.deepEqual([u.attempts, u.errors, u.nextAt - clock.t], [1, 1, 4 * PNL_UNREAD_RETRY_MS]);
  // and once it reads, the buy is there
  phase = "up"; clock.t = u.nextAt; pnl.wake(); await pnl.idle();
  assert.deepEqual([w.unread, w.rows, db.pnlUnreadOf(W), pnl.snapshot().unreadRead], [0, 5, [], 1]);
  assert.ok(walletRows(db, W).includes("s4/0/buy/70/7"));
  pnl.stop(); db.close();
});

test("unread: an endpoint that never answers for it is given up after PNL_UNREAD_ERRORS tries in a row, days later", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs(); // s4 throws every time
  const chain = fakeChain(sigs, txs), clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  pnl.register(W); await pnl.idle();
  const t0 = clock.t, reads = chain.count("getTransaction");
  for (let i = 1; i <= PNL_UNREAD_ERRORS; i++) { clock.t = db.pnlUnreadOf(W)[0].nextAt; pnl.wake(); await pnl.idle(); assert.equal(db.pnlUnreadOf(W)[0].errors, i); }
  assert.deepEqual(db.pnlUnreadOf(W), [{ wallet: W, sig: "s4", ord: -4, attempts: 0, nextAt: null, errors: PNL_UNREAD_ERRORS }]);
  assert.ok(clock.t - t0 > 3 * 86_400_000, "over three days");
  assert.equal(chain.count("getTransaction"), reads + PNL_UNREAD_ERRORS * (1 + PNL_TX_RETRIES), "bounded");
  assert.deepEqual([pnl.snapshot().unreadGivenUp, pnl.snapshot().unreadDueMs, pnl.wallets.get(W).unread], [1, null, 1]);
  pnl.stop(); db.close();
});

test("unread: one that is read when the table has no room for its trade is not unread any more, and the history says it is cut", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  let up = false;
  txs.set("s4", () => (up ? innerTx([[ev(CURVE, curveTrade(KID, W, { base: "70", quote: "7", at: T0 - 30 }))]], { logs: cutLog(CURVE), blockTime: T0 - 30, slot: 97 }) : txOf(cutLog(CURVE), { blockTime: T0 - 30 })));
  const chain = fakeChain(sigs, txs), clock = fakeClock();
  const pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  pnl.register(W); await pnl.idle();
  const w = pnl.wallets.get(W);
  assert.deepEqual([w.unread, w.rows, w.cut], [1, 4, false]);
  pnl.cfg.maxRows = 4; up = true; // every wallet together is at the cap when the transaction finally reads
  clock.t = db.pnlUnreadOf(W)[0].nextAt; pnl.wake(); await pnl.idle();
  assert.deepEqual([w.unread, w.rows, w.cut, db.pnlUnreadOf(W), db.pnlWallets()[0].cut], [0, 4, true, [], true], "not stored, so the wallet does not claim a whole history");
  assert.equal((await pnl.pnl(W)).history.cut, true);
  pnl.stop(); db.close();
});

test("unread: the one-time second scan leaves a wallet at its row cap alone and gives the count back when a cap stops it", async () => {
  const { db, m } = setup();
  const { sigs, txs } = sevenTxs();
  txs.set("s4", txOf(cutLog(CURVE), { blockTime: T0 - 30 }));
  const clock = fakeClock();
  const p1 = new PnlTracker({ model: m, rpc: fakeChain(sigs, txs), now: clock.now, sleep: clock.sleep, log: quiet }).start();
  p1.register(W); await p1.idle();
  assert.deepEqual([p1.wallets.get(W).unread, p1.wallets.get(W).rows], [1, 4]);
  p1.stop();
  db.pnlUnreadDrop(W); db.kvSet("pnlUnreadHealed", false); // the state an older build left
  // the wallet holds as many rows as a wallet may: a second scan would read nothing, so it is not started and the count stays
  const chain2 = fakeChain(sigs, txs), clock2 = fakeClock(clock.t + 60_000);
  const p2 = new PnlTracker({ model: m, rpc: chain2, cfg: { maxTrades: 4 }, now: clock2.now, sleep: clock2.sleep, log: quiet }).start();
  await p2.idle();
  assert.deepEqual([p2.wallets.get(W).state, p2.wallets.get(W).unread, p2.snapshot().rescans, chain2.calls.length, db.kvGet("pnlUnreadHealed")], ["done", 1, 0, 0, true]);
  p2.stop();
  // the table of every wallet is full: the second scan is queued, a row cap stops it before it reads, and the count it
  // had is given back (stored, so a stop in between loses nothing) with the cut flag
  db.kvSet("pnlUnreadHealed", false);
  const chain3 = fakeChain(sigs, txs), clock3 = fakeClock(clock2.t + 60_000);
  const p3 = new PnlTracker({ model: m, rpc: chain3, cfg: { maxRows: 4 }, now: clock3.now, sleep: clock3.sleep, log: quiet });
  assert.deepEqual([p3.wallets.get(W).state, p3.wallets.get(W).unread, p3.snapshot().rescans, db.kvGet("pnlUnreadWas")], ["queued", 0, 1, { [W]: 1 }]);
  p3.stop();
  const p4 = new PnlTracker({ model: m, rpc: chain3, cfg: { maxRows: 4 }, now: clock3.now, sleep: clock3.sleep, log: quiet }).start();
  await p4.idle();
  const w = p4.wallets.get(W);
  assert.deepEqual([w.state, w.unread, w.cut, w.rows, chain3.count("getTransaction"), db.kvGet("pnlUnreadWas"), db.pnlWallets()[0].unread], ["done", 1, true, 4, 0, {}, 1]);
  assert.equal((await p4.pnl(W)).history.unread, 1, "the body still says a transaction is unread");
  p4.stop(); db.close();
});

// ---------------------------------------------------------------- live logs the node cut
test("live: a trade behind a cut log is read for its wallet on the wallet's next request, only the cut transactions being fetched", async () => {
  const { db, m, ix } = setup();
  const sigs = [{ signature: "h1", blockTime: T0 - 100, slot: 50, err: null }];
  const txs = new Map([["h1", txOf(frame(CURVE, curveTrade(KID, W, { base: "400", quote: "20", at: T0 - 100 })), { blockTime: T0 - 100, slot: 50 })]]);
  const chain = fakeChain(sigs, txs), clock = fakeClock();
  // nothing is kept while no wallet is tracked, or by a tracker that reads no history
  const off = new PnlTracker({ model: m, log: quiet }); off.register(W2); off.onCutLog("q"); assert.equal(off.snapshot().cuts, 0); off.stop();
  db.pnlWalletDrop(W2);
  const pnl = new PnlTracker({ model: m, rpc: chain, now: clock.now, sleep: clock.sleep, log: quiet }).start();
  ix.onLogs({ slot: 1, signature: "early", err: null, logs: cutLog(CURVE) });
  assert.equal(pnl.snapshot().cuts, 0);
  pnl.register(W); await pnl.idle();
  const w = pnl.wallets.get(W);
  assert.deepEqual([w.state, w.rows], ["done", 1]);
  // two minutes on the wallet makes a routed swap whose log the node cuts before the buy (c1), then an ordinary sell
  // (n1); someone else's cut transaction (zz) comes by as well
  clock.t += 120_000;
  const t1 = Math.floor(clock.t / 1000);
  sigs.unshift({ signature: "n1", blockTime: t1, slot: 201, err: null }, { signature: "c1", blockTime: t1, slot: 200, err: null });
  txs.set("c1", innerTx([[ev(CURVE, curveTrade(KID, W, { base: "70", quote: "7", at: t1 }))]], { logs: cutLog(CURVE), blockTime: t1, slot: 200 }));
  const n1 = frame(CURVE, curveTrade(KID, W, { buy: false, base: "30", quote: "9", at: t1 }));
  txs.set("n1", txOf(n1, { blockTime: t1, slot: 201 }));
  ix.onLogs({ slot: 200, signature: "c1", err: null, logs: cutLog(CURVE) });
  ix.onLogs({ slot: 200, signature: "c1", err: null, logs: cutLog(CURVE) }, POOL_EVENT_PROGRAMS); // the other stream
  ix.onLogs({ slot: 200, signature: "zz", err: null, logs: cutLog(AMM) });
  ix.onLogs({ slot: 201, signature: "n1", err: null, logs: n1 });
  assert.deepEqual(walletRows(db, W).sort(), ["h1/0/buy/400/20", "n1/0/sell/30/9"], "the buy behind the cut was not delivered");
  assert.deepEqual([pnl.snapshot().cuts, pnl.snapshot().cutLogs], [2, 2]);
  // the wallet's next request: one listing, and only the cut transaction is read
  let lists = chain.count("getSignaturesForAddress"), reads = chain.count("getTransaction");
  await pnl.pnl(W); await pnl.idle();
  assert.deepEqual([chain.count("getSignaturesForAddress") - lists, chain.count("getTransaction") - reads], [1, 1]);
  assert.equal(chain.calls[chain.calls.length - 1].params[0], "c1");
  assert.deepEqual(walletRows(db, W).sort(), ["c1/0/buy/70/7", "h1/0/buy/400/20", "n1/0/sell/30/9"]);
  assert.deepEqual([w.rows, w.unread, w.cut, pnl.snapshot().cutChecks, pnl.snapshot().cutTx, pnl.snapshot().txInner], [3, 0, false, 1, 1, 1]);
  assert.equal((await pnl.pnl(W)).coins.find((c) => c.mint === KID).heldBase, "440", "the body follows");
  // not again within PNL_CUT_CHECK_MS, and not at all once no log was cut since the last check
  lists = chain.count("getSignaturesForAddress");
  pnl.register(W); await pnl.idle();
  assert.equal(chain.count("getSignaturesForAddress"), lists);
  clock.t += 2 * PNL_CUT_CHECK_MS; pnl.register(W); await pnl.idle(); // one more look: the listing may have lagged the stream
  clock.t += 2 * PNL_CUT_CHECK_MS; pnl.register(W); await pnl.idle();
  clock.t += 2 * PNL_CUT_CHECK_MS; pnl.register(W); await pnl.idle();
  assert.equal(chain.count("getSignaturesForAddress"), lists + 1);
  assert.equal(w.rows, 3);
  // a cut transaction that does not read from its inner instructions either is unread, and remembered to be tried again
  const t2 = Math.floor(clock.t / 1000);
  sigs.unshift({ signature: "c2", blockTime: t2, slot: 300, err: null });
  txs.set("c2", txOf(cutLog(CURVE), { blockTime: t2, slot: 300 }));
  ix.onLogs({ slot: 300, signature: "c2", err: null, logs: cutLog(CURVE) });
  pnl.register(W); await pnl.idle();
  assert.deepEqual([w.unread, db.pnlUnreadOf(W).map((u) => u.sig)], [1, ["c2"]]);
  // so many logs were cut since the wallet's last check that its own signature fell out of the set: which of its
  // transactions were cut is not known any more, so every one since that check is read
  clock.t += 10 * 60_000;
  const t3 = Math.floor(clock.t / 1000);
  sigs.unshift({ signature: "n2", blockTime: t3, slot: 401, err: null }, { signature: "c3", blockTime: t3, slot: 400, err: null });
  txs.set("c3", innerTx([[ev(CURVE, curveTrade(KID, W, { base: "5", quote: "1", at: t3 }))]], { logs: cutLog(CURVE), blockTime: t3, slot: 400 }));
  txs.set("n2", txOf(frame(CURVE, curveTrade(KID, OTHER)), { blockTime: t3, slot: 401 }));
  ix.onLogs({ slot: 400, signature: "c3", err: null, logs: cutLog(CURVE) });
  for (let i = 0; i < PNL_CUTS_MAX; i++) pnl.onCutLog(`flood${i}`);
  assert.deepEqual([pnl.snapshot().cuts, pnl.cuts.has("c3")], [PNL_CUTS_MAX, false]);
  reads = chain.count("getTransaction");
  pnl.register(W); await pnl.idle();
  const read = chain.calls.filter((c) => c.method === "getTransaction").slice(reads).map((c) => c.params[0]);
  assert.deepEqual([...new Set(read)].sort(), ["c2", "c3", "n2"], "all three since the last check (c2 was listed in its margin), not only the cut ones");
  assert.ok(walletRows(db, W).includes("c3/0/buy/5/1"));
  assert.deepEqual([w.rows, w.unread], [4, 1]);
  pnl.stop(); db.close();
});

// ---------------------------------------------------------------- the series
const PRICES = { m: { decimals: 0, usd: 2 }, k: { decimals: 0, usd: 0.5 }, gift: { decimals: 0, usd: 1 }, np: { decimals: 0, usd: null } };
const priceOf = (mint) => PRICES[mint] ?? null;
/** What /api/pnl gives as totals.realizedUsdNow for the same trades: the coins' realized profit at today's price, summed in the body's order. */
const totalOf = (trades, since = 0) => { let s = 0; for (const [mint, e] of pnlOfTrades(trades, { since })) { const p = priceOf(mint); if (p?.usd != null) s += usdNow(e.realizedQuote, p.decimals, p.usd); } return s; };
const SERIES = [
  tr("m", 10, true, 100, 1000), tr("m", 20, false, 50, 800),      // +300 of m's quote = 600 USD
  tr("k", 25, true, 10, 100), tr("m", 30, false, 25, 200),         // −50 → m at 250 = 500 USD
  tr("k", 40, false, 10, 160),                                      // +60 at 0.5 = 30 USD → 530
  tr("gift", 45, false, 5, 99),                                     // nothing bought: its cost is unknown, it adds nothing
  tr("np", 50, true, 5, 50), tr("np", 55, false, 5, 80),            // a quote without a price: skipped, counted
  tr("gone", 56, true, 1, 1), tr("gone", 57, false, 1, 9),          // a coin the index no longer holds: left out
];

test("series: cumulative realized profit per sell at today's prices, from 0 at the start to the total now", () => {
  const all = realizedSeries(SERIES, { at: 100, priceOf });
  assert.deepEqual(all, { points: [{ t: 10, usd: 0 }, { t: 20, usd: 600 }, { t: 30, usd: 500 }, { t: 40, usd: 530 }, { t: 100, usd: 530 }], unpriced: 1 });
  assert.equal(all.points.at(-1).usd, totalOf(SERIES), "the last value is the P&L body's total");
  // a window: the sells inside it, each against the cost basis of the whole history; it starts at 0 at the window's start
  const win = realizedSeries(SERIES, { since: 25, at: 100, priceOf });
  assert.deepEqual(win, { points: [{ t: 25, usd: 0 }, { t: 30, usd: -100 }, { t: 40, usd: -70 }, { t: 100, usd: -70 }], unpriced: 1 });
  assert.equal(win.points.at(-1).usd, totalOf(SERIES, 25));
  assert.equal(pnlOfTrades(SERIES, { since: 25 }).get("m").realizedQuote, -50n, "the sell at 30 is measured against the buy at 10");
  // a window with no sell in it is flat; the coin without a price still counts as unpriced only while it is listed
  assert.deepEqual(realizedSeries(SERIES, { since: 60, at: 100, priceOf }), { points: [{ t: 60, usd: 0 }, { t: 100, usd: 0 }], unpriced: 0 });
  // no trade at all: no points
  assert.deepEqual(realizedSeries([], { since: 5, at: 100, priceOf }), { points: [], unpriced: 0 });
  // sells of one second are one point; a sell at `at` is the last point; a sell in the first second keeps the 0 before it
  const same = [tr("m", 10, true, 100, 1000), tr("m", 20, false, 10, 150), tr("m", 20, false, 10, 250), tr("m", 100, false, 10, 110)];
  assert.deepEqual(realizedSeries(same, { at: 100, priceOf }).points, [{ t: 10, usd: 0 }, { t: 20, usd: 400 }, { t: 100, usd: 420 }]);
  assert.deepEqual(realizedSeries(same, { since: 20, at: 100, priceOf }).points, [{ t: 20, usd: 0 }, { t: 20, usd: 400 }, { t: 100, usd: 420 }]);
  // a partial sell realizes only its explained part (a third of the proceeds against the whole known cost), as in the body
  const part = [tr("m", 1, true, 100, 1000), tr("m", 2, false, 300, 6000)];
  assert.deepEqual(realizedSeries(part, { at: 9, priceOf }).points, [{ t: 1, usd: 0 }, { t: 2, usd: 2000 }, { t: 9, usd: 2000 }]);
  // fed in slices (what the tracker does) it is the same series
  const s = seriesStart(25);
  for (const t of SERIES) seriesApply(s, t);
  assert.deepEqual(seriesEnd(s, { at: 100, priceOf }), win);
  // a window that starts after now (the route allows a day ahead) cannot run backwards
  assert.deepEqual(realizedSeries(SERIES, { since: 500, at: 100, priceOf }).points, [{ t: 100, usd: 0 }, { t: 100, usd: 0 }]);
});

test("series: more than 240 points are cut into equal time slices that keep their last value; the ends stay", () => {
  // one buy, then a sell a second for 999 seconds, each realizing 1 unit at 2 USD
  const trades = [tr("m", 0, true, 1000, 1000)];
  for (let i = 1; i <= 999; i++) trades.push(tr("m", i, false, 1, 2));
  const { points } = realizedSeries(trades, { since: 0, at: 1000, priceOf });
  assert.equal(SERIES_MAX_POINTS, 240); assert.equal(points.length, 240);
  assert.deepEqual([points[0], points.at(-1)], [{ t: 0, usd: 0 }, { t: 1000, usd: 1998 }]);
  assert.equal(points.at(-1).usd, totalOf(trades));
  const mid = points.slice(1, -1), slice = (t) => Math.floor((t * 238) / 1000);
  assert.ok(mid.every((p, i) => p.usd === 2 * p.t && slice(p.t) === i && slice(p.t + 1) > i), "each slice's last point, with the running total at that time");
  assert.ok(points.every((p, i) => i === 0 || p.t > points[i - 1].t), "time ascending");
  // fewer points than the cap are left as they are; the cap can be set
  assert.equal(realizedSeries(trades.slice(0, 201), { at: 1000, priceOf }).points.length, 202);
  const few = realizedSeries(trades, { at: 1000, priceOf, max: 10 }).points;
  assert.equal(few.length, 10); assert.deepEqual([few[0].usd, few.at(-1).usd], [0, 1998]);
});

test("routes: /api/pnl/:wallet/series: the tracked wallet's series, equal to the body's total, without registering anyone; validation, keep, limit, degrade", async () => {
  const { db, m } = setup();
  const hub = new EventHub({ heartbeatMs: 200 });
  const dir = mkdtempSync(join(tmpdir(), "spore-pnl-"));
  let t = T0 * 1000;
  const pnl = new PnlTracker({ model: m, now: () => t, log: quiet });
  const appOf = (extra = {}) => createApp({ model: m, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc: { call: async () => { throw new Error("no chain in this test"); } }, hub, images: new ImageCache(dir), meta: null, platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet, now: () => t, pnl, ...extra });
  const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const server = await listen(appOf());
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (p, u = url) => fetch(u + p).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));
  try {
    // a wallet nobody asked the P&L of: no points, and it is not made tracked
    let r = await get(`/api/pnl/${W}/series`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, wallet: W, at: T0, since: null, solUsd: 100, points: [], unpriced: 0 });
    assert.match(r.headers.get("cache-control"), /max-age=2/); assert.match(r.headers.get("x-ratelimit-policy"), /name=pnl/);
    assert.deepEqual([pnl.tracks(W), pnl.snapshot().wallets, pnl.snapshot().seriesBuilds], [false, 0, 0]);
    // tracked (by its P&L request) but without a trade yet: still no points
    await get(`/api/pnl/${W}`);
    assert.deepEqual((await get(`/api/pnl/${W}/series`)).body.points, []);
    const put = (sig, mint, isBuy, base, quote, time) => m.recordTrade({ sig, mint, idx: 0, slot: 1, time, isBuy, user: W, baseAmount: String(base), quoteAmount: String(quote), priceQuote: 1 });
    put("t1", KID, true, 100, 1000, T0 - 500); put("t2", KID, false, 50, 800, T0 - 400); put("t3", M, true, 7, 70, T0 - 300); put("t5", KID, false, 50, 100, T0 - 200);
    put("n1", NOPRICE, true, 5, 50, T0 - 150); put("n2", NOPRICE, false, 5, 80, T0 - 140);
    const mUsd = m.quoteUsdOf(M), near = (a, b) => Math.abs(a - b) < 1e-15;
    assert.ok(mUsd > 0);
    r = await get(`/api/pnl/${W}/series`);
    let body = (await get(`/api/pnl/${W}`)).body;
    assert.deepEqual([r.body.ok, r.body.wallet, r.body.at, r.body.since, r.body.solUsd, r.body.unpriced], [true, W, T0, null, 100, 1]);
    assert.deepEqual(r.body.points.map((p) => p.t), [T0 - 500, T0 - 400, T0 - 200, T0]);
    assert.equal(r.body.points[0].usd, 0);
    assert.ok(near(r.body.points[1].usd, usdNow(300n, 6, mUsd)) && near(r.body.points[2].usd, usdNow(-100n, 6, mUsd)), "KID's profit in M's units at M's price now");
    assert.equal(r.body.points[3].usd, body.totals.realizedUsdNow, "the last value is the P&L body's total, to the bit");
    assert.equal(body.totals.unpriced, 1);
    // a window: since counts in whole minutes, the sell inside it is measured against the earlier buy
    r = await get(`/api/pnl/${W}/series?since=${T0 - 250}`);
    body = (await get(`/api/pnl/${W}?since=${T0 - 250}`)).body;
    assert.equal(r.body.since, T0 - 260);
    assert.deepEqual(r.body.points.map((p) => p.t), [T0 - 260, T0 - 200, T0]);
    assert.ok(near(r.body.points[1].usd, usdNow(-400n, 6, mUsd)));
    assert.equal(r.body.points[2].usd, body.totals.realizedUsdNow);
    // one build per wallet and window while it is fresh; a new trade of the wallet drops it
    const builds = pnl.snapshot().seriesBuilds;
    await get(`/api/pnl/${W}/series`); await get(`/api/pnl/${W}/series?since=${T0 - 250}`); await get(`/api/pnl/${W}/series?since=${T0 - 255}`);
    assert.equal(pnl.snapshot().seriesBuilds, builds);
    put("t6", M, false, 7, 100, T0 - 100);
    r = await get(`/api/pnl/${W}/series`);
    assert.equal(pnl.snapshot().seriesBuilds, builds + 1);
    assert.deepEqual(r.body.points.map((p) => p.t), [T0 - 500, T0 - 400, T0 - 200, T0 - 100, T0]);
    assert.equal(r.body.points.at(-1).usd, (await get(`/api/pnl/${W}`)).body.totals.realizedUsdNow);
    t += PNL_CACHE_MS + 1; await get(`/api/pnl/${W}/series`);
    assert.equal(pnl.snapshot().seriesBuilds, builds + 2, "stale after as long as a P&L body");
    // asking for another wallet's series registers nothing
    assert.deepEqual((await get(`/api/pnl/${W2}/series?since=${T0 - 250}`)).body, { ok: true, wallet: W2, at: Math.floor(t / 1000), since: T0 - 260, solUsd: 100, points: [], unpriced: 0 });
    assert.deepEqual([pnl.tracks(W2), pnl.snapshot().wallets], [false, 1]);
    // validation, as /api/pnl
    for (const bad of [`/api/pnl/nope/series`, `/api/pnl/${W}/series?since=abc`, `/api/pnl/${W}/series?since=-5`, `/api/pnl/${W}/series?since=1.5`, `/api/pnl/${W}/series?since=${T0 + 10 * 86_400}`]) {
      const x = await get(bad);
      assert.equal(x.status, 400, bad); assert.ok(x.body.error, bad);
    }
    // a store that cannot be read (or a tracker without the method): 200 with ok false, never a 500; the routes' shared limit
    const at = Math.floor(t / 1000);
    for (const broken of [{ series: async () => { throw new Error("database is locked"); }, snapshot: () => ({}) }, { snapshot: () => ({}) }]) {
      const s2 = await listen(appOf({ rates: { pnl: { limit: 2, windowMs: 60_000 } }, pnl: broken }));
      try {
        const u2 = `http://127.0.0.1:${s2.address().port}`;
        r = await get(`/api/pnl/${W}/series?since=125`, u2);
        assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: false, wallet: W, at, since: 120, solUsd: null, points: [], unpriced: 0 });
        assert.equal((await get(`/api/pnl/nope/series`, u2)).status, 400);
        r = await get(`/api/pnl/${W}/series`, u2);
        assert.equal(r.status, 429); assert.ok(r.body.retryAfter >= 1);
      } finally { s2.close(); }
    }
  } finally { hub.close(); server.close(); pnl.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("series: the tracker reads a long history in slices and keeps at most 240 points", async () => {
  const { db, m } = setup();
  let t = T0 * 1000;
  const pnl = new PnlTracker({ model: m, now: () => t, log: quiet });
  pnl.register(W);
  const n = PNL_SLICE + 300, B = T0 - 5 * (n + 1); // a sell every 5 s from the buy to just before now
  db.transaction(() => {
    db.insertWalletTrade(W, { sig: "b0", mint: M, idx: 0, slot: 1, time: B, isBuy: true, baseAmount: String(n), quoteAmount: String(n * 1000), ord: 0 });
    for (let i = 1; i <= n; i++) db.insertWalletTrade(W, { sig: `s${i}`, mint: M, idx: 0, slot: 1 + i, time: B + i * 5, isBuy: false, baseAmount: "1", quoteAmount: "3000", ord: 0 });
  });
  pnl.wallets.get(W).rows = n + 1;
  const [series, body] = await Promise.all([pnl.series(W), pnl.pnl(W)]);
  assert.equal(body.trades, n + 1);
  assert.equal(series.points.length, 240);
  assert.deepEqual(series.points[0], { t: B, usd: 0 });
  assert.deepEqual(series.points.at(-1), { t: T0, usd: body.totals.realizedUsdNow });
  assert.ok(Math.abs(body.totals.realizedUsdNow - ((n * 2000) / 1e9) * 100) < 1e-12);
  assert.ok(series.points.every((p, i) => i === 0 || (p.t > series.points[i - 1].t && p.usd >= series.points[i - 1].usd)));
  // requests that arrive while it is built share the build
  t += PNL_CACHE_MS + 1;
  const builds = pnl.snapshot().seriesBuilds;
  const [a, b] = await Promise.all([pnl.series(W), pnl.series(W)]);
  assert.equal(a, b); assert.equal(pnl.snapshot().seriesBuilds, builds + 1);
  pnl.stop(); db.close();
});
