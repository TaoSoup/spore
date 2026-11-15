// The pool stream (owner 2026-11-15, "$DTC at 301k is not shown as the most traded"): graduated coins trade on
// pump-amm, and a pool trade does not mention the curve program, so the one log stream there was saw almost none of
// them (519 pool transactions in 24 h on chain, 1 trade stored). A second stream delivers pump-amm's logs; these tests
// pin how the two share a transaction, the in-place pool check, the reserves after a trade, and the frame filter.
// No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import anchor from "@coral-xyz/anchor";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer, peekPool, POOL_EVENT_POOL_OFFSET, POOL_EVENT_PROGRAMS } from "../lib/indexer.mjs";
import { LogsSubscriber } from "../lib/live.mjs";
import { EVENT_DISCRIMINATORS, decodeEvent, eventsInLogs } from "../lib/decode.mjs";
import { healthOf } from "../lib/api.mjs";
import { loadConfig } from "../lib/config.mjs";
import { BN, PublicKey, pumpIdl, pumpAmmIdl, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "../lib/sdk.mjs";
import { PLATFORM, quiet, T22 } from "./helpers/tree.mjs";

const key = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
const CURVE = PUMP_PROGRAM_ID.toBase58(), AMM = PUMP_AMM_PROGRAM_ID.toBase58();
const M = key(81), POOL = key(82), OTHER_POOL = key(90), KID = key(85);

/** An event's `Program data:` payload, every field a zero of its type unless `set` names it. */
function payload(idl, name, set) {
  const t = idl.types.find((x) => x.name === name);
  const v = {};
  for (const f of t.type.fields) v[f.name] = f.type === "pubkey" ? new PublicKey(Buffer.alloc(32, 9)) : f.type === "string" ? "x" : f.type === "bool" ? false : typeof f.type === "object" ? [] : new BN(0);
  return Buffer.concat([EVENT_DISCRIMINATORS[name], new anchor.BorshCoder(idl).types.encode(name, { ...v, ...set })]);
}
/** A pool trade: `quote` is what the user pays or gets, `net` what the quote vault gains or loses (the LP fee stays in it). */
const poolEvent = (name, pool, { base = "1000000", quote = "425", net = "420", fees = {} } = {}) => payload(pumpAmmIdl, name, {
  timestamp: new BN(Math.floor(Date.now() / 1000)), pool: new PublicKey(pool), pool_base_token_reserves: new BN("200000000000000"), pool_quote_token_reserves: new BN("85000000000"),
  ...(name === "BuyEvent" ? { base_amount_out: new BN(base), quote_amount_in: new BN(quote), quote_amount_in_with_lp_fee: new BN(net) } : { base_amount_in: new BN(base), quote_amount_out: new BN(quote), quote_amount_out_without_lp_fee: new BN(net), user_quote_amount_out: new BN(net) }),
  ...fees,
});
const curveTrade = (mint) => payload(pumpIdl, "TradeEvent", {
  mint: new PublicKey(mint), timestamp: new BN(Math.floor(Date.now() / 1000)), is_buy: true, token_amount: new BN("5000000"), quote_mint: new PublicKey(M), quote_amount: new BN("700"),
  virtual_quote_reserves: new BN("2000000000000000"), virtual_token_reserves: new BN("1000000000000000"), real_quote_reserves: new BN("700"), real_token_reserves: new BN("500000000000000"),
});
const frame = (program, ...events) => [`Program ${program} invoke [1]`, ...events.map((e) => `Program data: ${e.toString("base64")}`), `Program ${program} success`];

function setup() {
  const m = new Model(new Db(":memory:"), { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load();
  m.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  m.setSolUsd(100);
  const zeros = { virtualTokenReserves: "0", virtualQuoteReserves: "0", realTokenReserves: "0", realQuoteReserves: "0" };
  // M graduated (its pool is tracked); KID is on its curve, quoted in M
  m.upsertCoin({ mint: M, curve: "C_M", depth: 0, quoteMint: null, ...zeros, tokenTotalSupply: "1000000000000000", migrated: true, complete: true, pool: POOL, poolBaseVault: key(83), poolQuoteVault: key(84), poolBase: "1", poolQuote: "1", poolVirtualQuote: "0", creator: "CR" });
  m.upsertCoin({ mint: KID, curve: "C_K", depth: 1, quoteMint: M, virtualTokenReserves: "1000000000000000", virtualQuoteReserves: "2000000000000000", realTokenReserves: "500000000000000", realQuoteReserves: "0", tokenTotalSupply: "1000000000000000", initialVirtualQuoteReserves: "0", complete: false, migrated: false, creator: "CR" });
  for (const mint of [M, KID]) m.setMint({ mint, decimals: 6, tokenProgram: T22, name: "T", symbol: "T", onchainAt: 1 });
  const events = [];
  const ix = new Indexer({ rpc: { snapshot: () => ({}) }, model: m, meta: null, hub: { emit: (ev, data) => events.push([ev, data]) }, log: quiet, opts: { backfill: false } });
  return { m, ix, trades: () => events.filter(([ev]) => ev === "trade").map(([, t]) => t) };
}

test("peekPool reads the pool of a Buy and a Sell event in place: the same key the full decode gives", () => {
  for (const name of ["BuyEvent", "SellEvent"]) {
    const data = poolEvent(name, POOL);
    assert.equal(peekPool(data), POOL, name);
    assert.equal(decodeEvent(name, data).pool, POOL, name);
    // the offset is the IDL's: fourteen fixed 8-byte fields, then `pool`
    const fields = pumpAmmIdl.types.find((x) => x.name === name).type.fields;
    const at = fields.findIndex((f) => f.name === "pool");
    assert.ok(fields.slice(0, at).every((f) => f.type === "u64" || f.type === "i64"), `${name}: only 8-byte fields before pool`);
    assert.equal(8 + at * 8, POOL_EVENT_POOL_OFFSET, name);
  }
  assert.equal(peekPool(Buffer.alloc(40)), null, "a short payload has no pool");
});

test("a pool event's reserves are the pool AFTER the trade (the chain reports them before it)", () => {
  // buy: 1 token leaves the pool, 420 of the 425 paid stay in the quote vault
  const buy = decodeEvent("BuyEvent", poolEvent("BuyEvent", POOL));
  assert.equal(buy.poolBaseReserves, "199999999000000"); assert.equal(buy.poolQuoteReserves, "85000000420");
  assert.equal(buy.baseAmount, "1000000"); assert.equal(buy.quoteAmount, "425");
  // sell: 2 tokens enter, the vault pays out 790 (800 to the user's side less the LP fee that stays)
  const sell = decodeEvent("SellEvent", poolEvent("SellEvent", POOL, { base: "2000000", quote: "800", net: "790" }));
  assert.equal(sell.poolBaseReserves, "200000002000000"); assert.equal(sell.poolQuoteReserves, "84999999210");
  // an amount larger than the reserve cannot be: the reported reserve stands
  const odd = decodeEvent("SellEvent", poolEvent("SellEvent", POOL, { net: "99999999999999" }));
  assert.equal(odd.poolQuoteReserves, "85000000000");
});

test("where the fees went depends on the instruction: paid out at once (buy, buy_exact_quote_in, Sell) or kept in the vault less the buyback (v2, multi-hop)", () => {
  // measured 2026-11-15 on 69 mainnet transactions of eight instruction kinds, every one exact against the vaults
  const fees = { protocol_fee: new BN(50), coin_creator_fee: new BN(30), buyback_fee: new BN(25), lp_fee: new BN(5) };
  const q = (e) => BigInt(e.poolQuoteReserves) - 85000000000n;
  // a buy names its instruction itself: 420 = the amount swapped plus the LP fee
  for (const ix_name of ["buy", "buy_exact_quote_in"]) assert.equal(q(decodeEvent("BuyEvent", poolEvent("BuyEvent", POOL, { fees: { ...fees, ix_name } }))), 420n, ix_name);
  for (const ix_name of ["buy_v2", "buy_exact_quote_in_v2", "multi_hop_swap", "something_new"]) assert.equal(q(decodeEvent("BuyEvent", poolEvent("BuyEvent", POOL, { fees: { ...fees, ix_name } }))), 420n + 50n + 30n - 25n, ix_name);
  // a sell does not: the frame's Instruction line does. net 790 = out less the LP fee; the user gets 710 of it
  const sell = poolEvent("SellEvent", POOL, { quote: "800", net: "790", fees: { ...fees, user_quote_amount_out: new BN(710) } });
  assert.equal(q(decodeEvent("SellEvent", sell, "Sell")), -790n);
  for (const ix of ["SellV2", "MultiHopSwap", null]) assert.equal(q(decodeEvent("SellEvent", sell, ix)), -(710n + 25n), String(ix));
  // eventsInLogs hands each event the instruction its own frame logged
  const logs = [`Program ${AMM} invoke [1]`, "Program log: Instruction: SellV2", `Program ${key(70)} invoke [2]`, "Program log: Instruction: Transfer", `Program ${key(70)} success`,
    `Program data: ${sell.toString("base64")}`, `Program ${AMM} success`, `Program ${AMM} invoke [1]`, "Program log: Instruction: Sell", `Program data: ${sell.toString("base64")}`, `Program ${AMM} success`,
    `Program ${AMM} invoke [1]`, `Program data: ${sell.toString("base64")}`, `Program ${AMM} success`];
  assert.deepEqual(eventsInLogs(logs).map((e) => e.ix), ["SellV2", "Sell", null]);
  // and the indexer passes it on: the coin holds the Sell path's reserves after a Sell
  const { m, ix } = setup();
  ix.onLogs({ slot: 5, signature: "OLD", err: null, logs: logs.slice(7, 11) }, POOL_EVENT_PROGRAMS);
  assert.equal(m.get(M).poolQuote, String(85000000000n - 790n));
  ix.onLogs({ slot: 6, signature: "V2", err: null, logs: logs.slice(0, 7) }, POOL_EVENT_PROGRAMS);
  assert.equal(m.get(M).poolQuote, String(85000000000n - 735n));
});

test("the pool stream stores a tracked pool's trades and drops the others without decoding them", () => {
  const { m, ix, trades } = setup();
  ix.onLogs({ slot: 5, signature: "A", err: null, logs: frame(AMM, poolEvent("BuyEvent", OTHER_POOL)) }, POOL_EVENT_PROGRAMS);
  assert.equal(m.db.tradesFor(M).length, 0);
  assert.deepEqual(ix.poolStats, { events: 1, tracked: 0, trades: 0 });
  ix.onLogs({ slot: 6, signature: "B", err: null, logs: frame(AMM, poolEvent("BuyEvent", POOL), poolEvent("SellEvent", POOL, { base: "2000000", quote: "800", net: "790" })) }, POOL_EVENT_PROGRAMS);
  const rows = m.db.tradesFor(M);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.isBuy).sort(), [false, true]);
  assert.deepEqual(rows.map((r) => r.quoteAmount).sort(), ["425", "800"]);
  assert.deepEqual(ix.poolStats, { events: 3, tracked: 2, trades: 2 });
  assert.equal(trades().length, 2);
  assert.equal(m.get(M).poolQuote, "84999999210", "the coin holds the pool after the last event");
  assert.equal(m.get(M).poolBase, "200000002000000");
  assert.equal(m.activity.volumes().get(M).trades, 2, "the 24 h counters see them");
  // a failed transaction carries nothing
  ix.onLogs({ slot: 7, signature: "C", err: { InstructionError: [0, "Custom"] }, logs: frame(AMM, poolEvent("BuyEvent", POOL)) }, POOL_EVENT_PROGRAMS);
  assert.equal(m.db.tradesFor(M).length, 2);
});

test("a transaction both streams deliver is one trade each: one row, one announcement, the same event index", () => {
  const { m, ix, trades } = setup();
  // a multi-hop buy: M bought on its pool, then KID on its curve with it
  const tx = { slot: 9, signature: "HOP", err: null, logs: [...frame(AMM, poolEvent("BuyEvent", POOL)), ...frame(CURVE, curveTrade(KID))] };
  ix.onLogs(tx);                         // the curve stream: it acts on both programs' events, as it always did
  assert.equal(m.db.tradesFor(KID).length, 1); assert.equal(m.db.tradesFor(M).length, 1);
  assert.equal(trades().length, 2);
  ix.hot.clear();
  ix.onLogs(tx, POOL_EVENT_PROGRAMS);    // the pool stream delivers the same transaction
  ix.onLogs(tx); ix.onLogs(tx, POOL_EVENT_PROGRAMS);
  assert.equal(m.db.tradesFor(KID).length, 1); assert.equal(m.db.tradesFor(M).length, 1);
  assert.equal(trades().length, 2, "a trade already stored is not announced again");
  assert.equal(m.activity.volumes().get(M).trades, 1); assert.equal(m.activity.volumes().get(KID).trades, 1);
  assert.equal(ix.hot.size, 0, "a replay makes nothing hot");
  // health counts the pool stream's own deliveries; the trade was the curve stream's
  assert.deepEqual(ix.poolStats, { events: 2, tracked: 2, trades: 0 });
  // idx counts the transaction's events whichever stream delivers them: the pool event 0, the curve's 1
  const idx = (mint) => m.db.db.prepare("SELECT idx FROM trades WHERE mint = ?").all(mint).map((r) => r.idx);
  assert.deepEqual(idx(M), [0]); assert.deepEqual(idx(KID), [1]);
});

test("the pool stream first, then the curve stream: the same single row each, and the pool stream leaves the curve's event alone", () => {
  const { m, ix, trades } = setup();
  const tx = { slot: 9, signature: "HOP", err: null, logs: [...frame(AMM, poolEvent("BuyEvent", POOL)), ...frame(CURVE, curveTrade(KID))] };
  ix.onLogs(tx, POOL_EVENT_PROGRAMS);
  assert.equal(m.db.tradesFor(M).length, 1); assert.equal(m.db.tradesFor(KID).length, 0, "not the pool stream's event");
  assert.equal(ix.hot.has(KID), false);
  ix.onLogs(tx);
  assert.equal(m.db.tradesFor(M).length, 1); assert.equal(m.db.tradesFor(KID).length, 1);
  assert.equal(trades().length, 2);
  assert.deepEqual(ix.poolStats, { events: 1, tracked: 1, trades: 1 });
});

test("a pool trade does not make its coin hot (the event gives the reserves); a curve trade does", () => {
  const { ix } = setup();
  ix.onLogs({ slot: 5, signature: "B", err: null, logs: frame(AMM, poolEvent("BuyEvent", POOL)) }, POOL_EVENT_PROGRAMS);
  assert.equal(ix.hot.has(M), false);
  ix.onLogs({ slot: 6, signature: "T", err: null, logs: frame(CURVE, curveTrade(KID)) });
  assert.equal(ix.hot.has(KID), true);
});

test("an event a foreign program logs inside its own frame is not a pool trade", () => {
  const { m, ix } = setup();
  ix.onLogs({ slot: 5, signature: "F", err: null, logs: frame(key(77), poolEvent("BuyEvent", POOL)) }, POOL_EVENT_PROGRAMS);
  assert.equal(m.db.tradesFor(M).length, 0);
  assert.equal(ix.poolStats.events, 0);
});

/** A WebSocket the test drives: `sockets` holds every one opened. */
function fakeSockets() {
  const sockets = [];
  class Fake { constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); } send(s) { this.sent.push(JSON.parse(s)); } close() { this.readyState = 3; this.onclose?.(); } open() { this.readyState = 1; this.onopen?.(); } }
  return { Fake, sockets };
}
const note = (logs, err = null, signature = "S") => JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { result: { context: { slot: 3 }, value: { signature, err, logs } } } });
const dud = () => note([`Program ${AMM} invoke [1]`, `Program ${AMM} failed: custom program error: 0x1`], { InstructionError: [0, "Custom"] });

test("mustInclude: a frame without the mark is not parsed but still counts as traffic; one with it reaches onLogs", () => {
  const Real = globalThis.WebSocket;
  const { Fake, sockets } = fakeSockets();
  globalThis.WebSocket = Fake;
  try {
    const got = [];
    const sub = new LogsSubscriber({ wsUrl: "wss://x.example", programId: AMM, name: "live (pools)", mustInclude: "Program data: ", onLogs: (n) => got.push(n), log: quiet }).start();
    sockets[0].open();
    assert.deepEqual(sockets[0].sent[0].params[0], { mentions: [AMM] });
    sub.lastMessageAt = 0;
    sockets[0].onmessage({ data: dud() });
    assert.equal(got.length, 0); assert.equal(sub.stats.skipped, 1); assert.equal(sub.stats.notifications, 0);
    assert.ok(sub.lastMessageAt > 0, "a skipped frame is traffic: the watchdog does not reopen a busy socket");
    assert.equal(sub.snapshot().lastNotificationAgoMs, null);
    sockets[0].onmessage({ data: note(frame(AMM, poolEvent("BuyEvent", POOL))) });
    assert.equal(got.length, 1); assert.equal(got[0].signature, "S"); assert.equal(sub.stats.notifications, 1);
    assert.ok(sub.snapshot().lastNotificationAgoMs < 1000); assert.equal(sub.subscribed, true, "a notification proves the subscription");
    // without the option every frame is parsed, as before
    const all = new LogsSubscriber({ wsUrl: "wss://x.example", programId: CURVE, onLogs: (n) => got.push(n), log: quiet }).start();
    sockets[1].open();
    sockets[1].onmessage({ data: note([`Program ${CURVE} invoke [1]`, `Program ${CURVE} success`]) });
    assert.equal(got.length, 2); assert.equal(all.stats.skipped, 0);
    sub.stop(); all.stop();
  } finally { globalThis.WebSocket = Real; }
});

test("the reply to the subscribe request is read: an ack marks the stream subscribed, a refusal is an error with its reason", () => {
  const Real = globalThis.WebSocket;
  const { Fake, sockets } = fakeSockets();
  globalThis.WebSocket = Fake;
  try {
    const warns = [];
    const log = { info() {}, warn: (m) => warns.push(m) };
    const ok = new LogsSubscriber({ wsUrl: "wss://x.example", programId: AMM, name: "live (pools)", mustInclude: "Program data: ", onLogs() {}, log }).start();
    sockets[0].open();
    assert.equal(ok.subscribed, false);
    sockets[0].onmessage({ data: '{"jsonrpc":"2.0","result":4711,"id":1}' });
    assert.equal(ok.subscribed, true); assert.equal(ok.stats.skipped, 0); assert.equal(ok.stats.errors, 0); assert.equal(ok.snapshot().subscribed, true);
    const no = new LogsSubscriber({ wsUrl: "wss://x.example", programId: AMM, name: "live (pools)", mustInclude: "Program data: ", onLogs() {}, log }).start();
    sockets[1].open();
    sockets[1].onmessage({ data: '{"jsonrpc":"2.0","error":{"code":-32602,"message":"too many subscriptions"},"id":1}' });
    assert.equal(no.subscribed, false); assert.equal(no.stats.errors, 1);
    assert.match(no.stats.lastError, /logsSubscribe refused: too many subscriptions/);
    assert.ok(warns.some((w) => /live \(pools\): logsSubscribe refused/.test(w)));
    // a reconnect starts unsubscribed again
    sockets[0].close();
    assert.equal(ok.subscribed, true, "until the new socket exists");
    ok.stop(); no.stop();
  } finally { globalThis.WebSocket = Real; }
});

test("a socket that never opens keeps backing off (1, 2, 4 … 30 s); one that lived a minute starts again at 1 s", () => {
  const Real = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { throw new Error("ECONNREFUSED"); } };
  try {
    const sub = new LogsSubscriber({ wsUrl: "wss://x.example", programId: AMM, onLogs() {}, log: quiet });
    const seen = [];
    for (let i = 0; i < 7; i++) { clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null; sub.start(); seen.push(sub.backoffMs); }
    assert.deepEqual(seen, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    // it opened 61 s ago and dropped: back to 1 s; a second drop right after doubles again
    clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null;
    sub.openedAt = Date.now() - 61_000; sub.start();
    assert.equal(sub.backoffMs, 1000);
    clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null; sub.start();
    assert.equal(sub.backoffMs, 2000);
    sub.stop();
  } finally { globalThis.WebSocket = Real; }
});

test("start() opens a stream per program, both filtered; the curve stream keeps the pool events it sees whatever the pool socket's state", async () => {
  const Real = globalThis.WebSocket, realFetch = globalThis.fetch;
  const { Fake, sockets } = fakeSockets();
  globalThis.WebSocket = Fake; globalThis.fetch = async () => { throw new Error("offline"); };
  const starts = [];
  try {
    for (const livePools of [true, false]) {
      const { m, ix, trades } = setup();
      ix.opts.wsUrl = "wss://x.example"; ix.opts.livePools = livePools;
      ix.loadGlobal = async () => {}; ix.refresh = async () => {}; ix.backfillPoolVq = async () => {}; ix.refreshPricingPools = async () => {}; ix.catchUpMintInfo = async () => {};
      const from = sockets.length;
      await ix.start();
      starts.push(ix);
      const mine = sockets.slice(from);
      assert.equal(mine.length, livePools ? 2 : 1);
      mine.forEach((s) => s.open());
      assert.deepEqual(mine.map((s) => s.sent[0].params[0].mentions[0]), livePools ? [CURVE, AMM] : [CURVE]);
      // both streams drop an event-less frame before parsing it
      mine.forEach((s) => s.onmessage({ data: dud() }));
      for (const sub of [ix.live, ix.livePools].filter(Boolean)) { assert.equal(sub.stats.skipped, 1); assert.equal(sub.stats.notifications, 0); }
      const hop = (sig) => note([...frame(AMM, poolEvent("BuyEvent", POOL)), ...frame(CURVE, curveTrade(KID))], null, sig);
      mine[0].onmessage({ data: hop("S") });   // the curve stream: both events, the pool socket open or absent
      assert.equal(m.db.tradesFor(KID).length, 1); assert.equal(m.db.tradesFor(M).length, 1);
      if (livePools) {
        mine[1].onmessage({ data: hop("S") });  // the pool stream delivers it too: nothing new
        assert.equal(m.db.tradesFor(M).length, 1); assert.equal(trades().length, 2);
        // a transaction only the pool stream delivers: the pool's event, never the curve's
        ix.hot.delete(KID);
        mine[1].onmessage({ data: hop("S3") });
        assert.equal(m.db.tradesFor(M).length, 2);
        assert.equal(m.db.tradesFor(KID).length, 1, "the pool stream leaves curve events to the curve stream");
        assert.equal(ix.hot.has(KID), false);
        const h = healthOf({ model: m, indexer: ix, hub: null, startedAt: Math.floor(Date.now() / 1000) });
        assert.equal(h.wsPools.connected, true); assert.equal(h.wsPools.subscribed, true); assert.ok(h.wsPools.lastNotificationAgoMs < 1000);
        assert.equal(h.wsPools.events, 2); assert.equal(h.wsPools.tracked, 2); assert.equal(h.wsPools.trades, 1);
      } else assert.equal(healthOf({ model: m, indexer: ix, hub: null, startedAt: Math.floor(Date.now() / 1000) }).wsPools, null);
      ix.stop();
      assert.ok(mine.every((s) => s.readyState === 3), "stop() closes every stream");
    }
  } finally { for (const ix of starts) ix.stop(); globalThis.WebSocket = Real; globalThis.fetch = realFetch; }
});

test("LIVE_POOLS: on by default, 0 turns the pool stream off", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-pools-"));
  try {
    const env = { DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m") };
    assert.equal(loadConfig(env, { here: dir }).livePools, true);
    assert.equal(loadConfig({ ...env, LIVE_POOLS: "0" }, { here: dir }).livePools, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
