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
import { Indexer, peekPool, POOL_EVENT_POOL_OFFSET, POOL_EVENT_PROGRAMS, GRADUATING_MAX, GRADUATING_MS } from "../lib/indexer.mjs";
import { LogsSubscriber } from "../lib/live.mjs";
import { BONDING_CURVE_DISCRIMINATOR, EVENT_DISCRIMINATORS, decodeEvent, eventsInLogs } from "../lib/decode.mjs";
import { healthOf } from "../lib/api.mjs";
import { loadConfig } from "../lib/config.mjs";
import { BN, PublicKey, pumpIdl, pumpAmmIdl, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, bondingCurvePda, canonicalPumpPoolPdaWithQuote, normalizeQuoteMint, pk } from "../lib/sdk.mjs";
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

// Graduation (Nov 19 2026): model.pools learned a graduated coin's pool only once a refresh read its curve as
// migrated, 0-20 min after the CompleteEvent, and every pool trade in between was dropped (70 of 73 graduated coins
// whose start was stored went silent right after ~$45K, median 11 min). The canonical pool is expected from the
// CompleteEvent on, and its first event adopts it.
const completeEvent = (mint) => payload(pumpIdl, "CompleteEvent", { mint: new PublicKey(mint), timestamp: new BN(Math.floor(Date.now() / 1000)) });
const kidPool = () => canonicalPumpPoolPdaWithQuote(pk(KID), normalizeQuoteMint(pk(M))).toBase58();
/** An RPC that knows no account (every read answers null), counting the keys asked. */
const emptyRpc = () => { const rpc = { asked: [], snapshot: () => ({}), async getMultipleAccounts(keys) { rpc.asked.push(...keys); return keys.map(() => null); } }; return rpc; };

test("a CompleteEvent expects the coin's canonical pool: its first pool event is stored, marks the coin migrated and indexes the pool", () => {
  const { m, ix, trades } = setup();
  const pool = kidPool();
  // before: a trade on a pool nobody knows is dropped, as it always was
  ix.onLogs({ slot: 4, signature: "EARLY", err: null, logs: frame(AMM, poolEvent("BuyEvent", pool)) }, POOL_EVENT_PROGRAMS);
  assert.equal(m.db.tradesFor(KID).length, 0);
  ix.onLogs({ slot: 5, signature: "DONE", err: null, logs: frame(CURVE, completeEvent(KID)) });
  assert.equal(m.get(KID).complete, true); assert.equal(m.get(KID).migrated, false);
  assert.equal(ix.graduating.get(KID).pool, pool); assert.equal(ix.poolsExpected.get(pool), KID);
  // a pool event of another pool adopts nothing
  ix.onLogs({ slot: 6, signature: "OTHER", err: null, logs: frame(AMM, poolEvent("BuyEvent", OTHER_POOL)) }, POOL_EVENT_PROGRAMS);
  assert.equal(ix.poolsExpected.size, 1); assert.equal(m.get(KID).migrated, false);
  ix.hot.clear();
  ix.onLogs({ slot: 7, signature: "FIRST", err: null, logs: frame(AMM, poolEvent("BuyEvent", pool), poolEvent("SellEvent", pool, { base: "2000000", quote: "800", net: "790" })) }, POOL_EVENT_PROGRAMS);
  const rows = m.db.tradesFor(KID);
  assert.equal(rows.length, 2, "both trades of the first pool transaction");
  assert.ok(rows.every((r) => r.priceQuote > 0), "priced from the event's reserves");
  assert.equal(trades().length, 2);
  const c = m.get(KID);
  assert.equal(c.migrated, true); assert.equal(c.pool, pool); assert.equal(m.pools.get(pool), KID);
  assert.equal(c.poolBase, "200000002000000", "the pool after the last event");
  assert.equal(ix.poolsExpected.size, 0, "adopted once");
  assert.equal(ix.graduating.has(KID), true, "still watched until its vaults are read");
  assert.equal(ix.hot.has(KID), true, "the next tick reads it");
  assert.deepEqual(ix.poolStats, { events: 4, tracked: 2, trades: 2 }, "the early and the foreign event were seen, not tracked");
  assert.equal(ix.state.poolsAdopted, 1);
  // later events take the usual path; a replay is one row
  ix.onLogs({ slot: 8, signature: "NEXT", err: null, logs: frame(AMM, poolEvent("BuyEvent", pool)) }, POOL_EVENT_PROGRAMS);
  ix.onLogs({ slot: 8, signature: "NEXT", err: null, logs: frame(AMM, poolEvent("BuyEvent", pool)) });
  assert.equal(m.db.tradesFor(KID).length, 3); assert.equal(ix.state.poolsAdopted, 1);
  // a curve trade of the coin after its migration is not stored (it cannot be one)
  ix.onLogs({ slot: 9, signature: "CURVE", err: null, logs: frame(CURVE, curveTrade(KID)) });
  assert.equal(m.db.tradesFor(KID).length, 3);
});

test("the refresh watches graduating coins: a complete coin it reads is expected, re-read each tick, dropped once its vaults are read or after GRADUATING_MS", async () => {
  const { m, ix } = setup();
  const rpc = emptyRpc(); ix.rpc = rpc;
  const pool = kidPool();
  // no CompleteEvent seen (a gap, a restart): the coin is complete in the model
  m.upsertCoin({ mint: KID, complete: true });
  await ix.refresh();
  assert.equal(ix.graduating.get(KID)?.pool, pool, "expected from the refresh");
  // the next tick reads it even when the rolling slice and the hot set do not hold it
  // (60 more coins and the cursor past KID: the 50-coin slice holds neither M nor KID)
  for (let i = 0; i < 60; i++) m.upsertCoin({ mint: `U${i}`, curve: `C_U${i}`, depth: 0, quoteMint: null, tracked: true, complete: false, migrated: false, creator: "CR" });
  ix.opts.fullRefreshMs = 1e12; ix.cursor = 2; ix.hot.clear(); rpc.asked.length = 0;
  await ix.refresh();
  assert.ok(!rpc.asked.includes("C_M"), "the slice does not hold M");
  assert.ok(rpc.asked.includes("C_K"), "its curve is read every tick");
  // adopted by its first pool event, then read: the vaults are unknown (the RPC answers nothing), so it stays watched
  ix.onLogs({ slot: 7, signature: "FIRST", err: null, logs: frame(AMM, poolEvent("BuyEvent", pool)) }, POOL_EVENT_PROGRAMS);
  assert.equal(m.get(KID).migrated, true);
  rpc.asked.length = 0;
  await ix.refresh();
  assert.ok(rpc.asked.includes(pool), "ensurePools reads the adopted pool");
  assert.equal(ix.graduating.has(KID), true);
  // vaults read: done
  m.upsertCoin({ mint: KID, poolBaseVault: key(91), poolQuoteVault: key(92) });
  await ix.refresh();
  assert.equal(ix.graduating.has(KID), false);
  // a coin that stays complete and never migrates is let go after GRADUATING_MS (the rolling pass finds it again)
  const { m: m2, ix: ix2 } = setup();
  ix2.rpc = emptyRpc();
  m2.upsertCoin({ mint: KID, complete: true });
  await ix2.refresh();
  assert.equal(ix2.poolsExpected.size, 1);
  ix2.graduating.get(KID).at = Date.now() - GRADUATING_MS - 1;
  ix2.opts.fullRefreshMs = 1e12; ix2.cursor = 0;
  m2.upsertCoin({ mint: "UNRELATED", curve: "C_U", depth: 0, quoteMint: null, tracked: true, complete: false, migrated: false, creator: "CR" });
  await ix2.refresh();
  assert.equal(ix2.graduating.has(KID), false); assert.equal(ix2.poolsExpected.size, 0);
});

test("at most GRADUATING_MAX coins are watched, the oldest let go first; a migrated coin is never expected", () => {
  const { m, ix } = setup();
  for (let i = 0; i < GRADUATING_MAX + 3; i++) {
    const mint = new PublicKey(Buffer.alloc(32, 0).fill(i % 256, 0, 1).fill(Math.floor(i / 256) + 1, 1, 2)).toBase58();
    m.upsertCoin({ mint, curve: `C${i}`, depth: 1, quoteMint: M, tracked: true, complete: false, migrated: false, creator: "CR" });
    ix.onLogs({ slot: i, signature: `D${i}`, err: null, logs: frame(CURVE, completeEvent(mint)) });
  }
  assert.equal(ix.graduating.size, GRADUATING_MAX); assert.equal(ix.poolsExpected.size, GRADUATING_MAX);
  ix.onLogs({ slot: 999, signature: "DM", err: null, logs: frame(CURVE, completeEvent(M)) });
  assert.equal(ix.graduating.has(M), false, "M is migrated: its pool is known already");
});

// A pump curve never un-migrates (review, Nov 19 2026): a curve read that went out before the migration and came back
// after the first pool event adopted the pool spread `migrated: false` and the frozen curve's reserves over the
// adoption, and the coin's pool trades were priced from that curve until the next tick (4700x off on the chart).
/** KID's curve account as the chain held it before the migration: complete, reserves not zeroed yet. */
function preMigrationCurve() {
  const v = {};
  for (const f of pumpIdl.types.find((x) => x.name === "BondingCurve").type.fields) v[f.name] = f.type === "pubkey" ? new PublicKey(f.name === "quote_mint" ? M : key(9)) : f.type === "bool" ? false : new BN(0);
  Object.assign(v, { virtual_token_reserves: new BN("1000000000000000"), virtual_quote_reserves: new BN("2000000000000000"), token_total_supply: new BN("1000000000000000"), complete: true, depth: 1 });
  return Buffer.concat([BONDING_CURVE_DISCRIMINATOR, new anchor.BorshCoder(pumpIdl).types.encode("BondingCurve", v)]);
}

test("a curve read in flight when the pool is adopted does not undo the adoption: migrated stays on, the pool prices the coin", async () => {
  for (const path of ["refresh", "fetchCoin"]) {
    const { m, ix } = setup();
    const pool = kidPool(), data = preMigrationCurve();
    if (path === "fetchCoin") m.upsertCoin({ mint: KID, curve: bondingCurvePda(KID).toBase58() }); // the key fetchCoin reads
    ix.onLogs({ slot: 5, signature: "DONE", err: null, logs: frame(CURVE, completeEvent(KID)) });
    let adopted = null;
    ix.rpc = { snapshot: () => ({}), async getMultipleAccounts(keys) {
      await new Promise((r) => setTimeout(r, 1));
      const curve = keys.find((k) => k === m.get(KID).curve);
      // the migration lands and its first pool event arrives while the read is out
      if (curve && adopted == null) {
        ix.onLogs({ slot: 7, signature: "FIRST", err: null, logs: frame(AMM, poolEvent("BuyEvent", pool)) }, POOL_EVENT_PROGRAMS);
        adopted = m.priceOf(KID)?.priceQuote;
      }
      return keys.map((k) => k === curve ? { data, owner: CURVE } : null);
    } };
    if (path === "refresh") await ix.refresh();
    else await ix.fetchCoin(KID);
    assert.equal(m.get(KID).migrated, true, `${path}: still migrated`);
    assert.equal(m.get(KID).complete, true, path);
    assert.equal(m.get(KID).realTokenReserves, "500000000000000", `${path}: the stale curve's reserves are not taken`);
    assert.ok(adopted > 0); assert.equal(m.priceOf(KID)?.priceQuote, adopted, `${path}: priced from the pool, not the frozen curve`);
    ix.onLogs({ slot: 8, signature: "SECOND", err: null, logs: frame(AMM, poolEvent("BuyEvent", pool)) }, POOL_EVENT_PROGRAMS);
    const rows = m.db.tradesFor(KID);
    assert.equal(rows.length, 2, path);
    assert.ok(Math.abs(rows[1].priceUsd / rows[0].priceUsd - 1) < 0.01, `${path}: the next pool trade is priced like the first`);
  }
  // a read that says complete is still taken whole while the model says neither (the usual tick)
  const { m, ix } = setup();
  const data = preMigrationCurve();
  ix.rpc = { snapshot: () => ({}), async getMultipleAccounts(keys) { return keys.map((k) => k === "C_K" ? { data, owner: CURVE } : null); } };
  await ix.refresh();
  assert.equal(m.get(KID).complete, true); assert.equal(m.get(KID).migrated, false); assert.equal(m.get(KID).virtualQuoteReserves, "2000000000000000");
});

test("a restart or a stream (re)connect expects every complete, unmigrated coin once: the first tick after reads it, later ticks do not sweep", async () => {
  const { m, ix } = setup();
  const rpc = emptyRpc(); ix.rpc = rpc;
  // complete in the db, its CompleteEvent handled by the last process (or lost in a gap); nothing hot, not in the slice
  m.upsertCoin({ mint: KID, complete: true });
  for (let i = 0; i < 60; i++) m.upsertCoin({ mint: `U${i}`, curve: `C_U${i}`, depth: 0, quoteMint: null, tracked: true, complete: false, migrated: false, creator: "CR" });
  ix.opts.fullRefreshMs = 1e12; ix.cursor = 2;
  await ix.refresh();
  assert.equal(ix.graduating.get(KID)?.pool, kidPool(), "expected on the first tick");
  assert.equal(ix.poolsExpected.get(kidPool()), KID);
  assert.ok(rpc.asked.includes("C_K"), "and read on it");
  assert.equal(ix.expectSweep, false);
  // one completing between sweeps, outside the slice and the hot set, waits for the rolling pass or the next sweep
  // (a real key: the sweep derives its pool PDA)
  const LATE = key(95);
  m.upsertCoin({ mint: LATE, curve: "C_LATE", depth: 0, quoteMint: null, tracked: true, complete: true, migrated: false, creator: "CR" });
  ix.cursor = 2; rpc.asked.length = 0;
  await ix.refresh();
  assert.equal(ix.graduating.has(LATE), false); assert.ok(!rpc.asked.includes("C_LATE"));
  // a (re)connect of the curve stream sweeps again
  const Real = globalThis.WebSocket, realFetch = globalThis.fetch;
  const { Fake, sockets } = fakeSockets();
  globalThis.WebSocket = Fake; globalThis.fetch = async () => { throw new Error("offline"); };
  const realRefresh = ix.refresh.bind(ix), calls = [];
  try {
    ix.opts.wsUrl = "wss://x.example"; ix.opts.livePools = false;
    ix.loadGlobal = async () => {}; ix.backfillPoolVq = async () => {}; ix.refreshPricingPools = async () => {}; ix.catchUpMintInfo = async () => {};
    ix.refresh = (o) => { calls.push(o?.reason); return o?.reason === "reconnect" ? realRefresh(o) : Promise.resolve(); };
    await ix.start();
    ix.cursor = 2; rpc.asked.length = 0;
    sockets[0].open();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(calls.includes("reconnect"));
    assert.ok(ix.graduating.has(LATE), "swept on the reconnect's tick");
    assert.ok(rpc.asked.includes("C_LATE"));
  } finally { ix.stop(); globalThis.WebSocket = Real; globalThis.fetch = realFetch; }
});
