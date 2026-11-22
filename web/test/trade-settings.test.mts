// Trade settings and the instant trade. The pure rules (lib/trade-settings.ts): what the stored settings mean and
// their defaults, a sell's amount from a percentage of a balance, a buy preset in lamports, the cap, the price-impact
// and the cost decisions. Then the whole sequence of lib/instant-trade.ts on fakes: nothing here reads the chain,
// simulates or signs; the "sender" is a public key that never signs and `send` is a recorder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type Connection } from "@solana/web3.js";
import type { Coin } from "../src/lib/api.ts";
import type { InstantDeps, InstantInput } from "../src/lib/instant-trade.ts";
await import("./cjs-sdk-hook.mjs");
const S = await import("../src/lib/trade-settings.ts");
const { instantTrade, InstantCostError, QUOTE_RETRIES } = await import("../src/lib/instant-trade.ts");
const { routeOf } = await import("../src/lib/trade-route.ts");
const { PriceMovedError, UnmeasuredCostError } = await import("../src/lib/flow.ts");
const { ExpiredError } = await import("../src/lib/pump/send.ts");
const { TOKEN_2022_ID, CU_PRICE_MICRO, swapFeeLamports, swapUnits } = await import("../src/lib/pump/trade.ts");

test("settings: defaults when nothing is stored, and instant trades are on unless turned off", () => {
  const d = S.parseTradeSettings({});
  assert.deepEqual(d, { instant: true, buyPresets: [0.1, 0.25, 0.5, 1], sellPresets: [25, 50, 75, 100], slippageBps: 500, slippageStored: false });
  // a stored slippage is the ticket's and the instant trade's alike
  assert.equal(S.parseTradeSettings({ slippage: "300" }).slippageBps, 300);
  assert.equal(S.parseTradeSettings({ slippage: "300" }).slippageStored, true);
  assert.equal(S.parseInstantOn(null), true);
  assert.equal(S.parseInstantOn("on"), true);
  assert.equal(S.parseInstantOn("garbage"), true);
  assert.equal(S.parseInstantOn("off"), false);
  // the defaults are copies: a caller that edits its list does not edit them
  d.buyPresets[0] = 9;
  assert.deepEqual(S.parseBuyPresets(null), [0.1, 0.25, 0.5, 1]);
});

test("buy presets: more than 0, at most 100 SOL, at most 4 decimals", () => {
  assert.equal(S.parseBuyPreset("0.25"), 0.25);
  assert.equal(S.parseBuyPreset(" 1 "), 1);
  assert.equal(S.parseBuyPreset(".5"), 0.5);
  assert.equal(S.parseBuyPreset("100"), 100);
  assert.equal(S.parseBuyPreset("0.0001"), 0.0001);
  for (const bad of ["", "0", "0.0", "0.00001", "100.0001", "101", "-1", "1e2", "abc", "1,5", "1.2.3", "."]) assert.equal(S.parseBuyPreset(bad), null, bad);
  assert.deepEqual(S.parseBuyPresets("0.2,2,5"), [0.2, 2, 5]);
  assert.equal(S.formatPresets([0.2, 2, 5]), "0.2,2,5");
  assert.deepEqual(S.parseBuyPresets(S.formatPresets([0.05, 0.3, 12.5])), [0.05, 0.3, 12.5], "round trip");
  // a slot that is not valid takes its default; a list of another length is not the user's list
  assert.deepEqual(S.parseBuyPresets("0.2,500,5"), [0.2, 0.5, 5]);
  assert.deepEqual(S.parseBuyPresets("0.2,,x"), [0.2, 0.5, 1]);
  assert.deepEqual(S.parseBuyPresets("1,2"), [0.1, 0.25, 0.5, 1]);
  // a stored list of four is the user's four; one of five is not a list
  assert.deepEqual(S.parseBuyPresets("1,2,3,4"), [1, 2, 3, 4]);
  assert.deepEqual(S.parseBuyPresets("1,x,3,4"), [1, 0.25, 3, 4], "a bad slot of four takes the four-slot default");
  assert.deepEqual(S.parseBuyPresets("1,2,3,4,5"), [0.1, 0.25, 0.5, 1]);
  assert.deepEqual(S.parseBuyPresets(""), [0.1, 0.25, 0.5, 1]);
});

test("sell presets: whole percentages from 1 to 100", () => {
  assert.equal(S.parseSellPreset("1"), 1);
  assert.equal(S.parseSellPreset("100"), 100);
  for (const bad of ["", "0", "101", "12.5", "-5", "50%", "abc", "1000"]) assert.equal(S.parseSellPreset(bad), null, bad);
  assert.deepEqual(S.parseSellPresets("10,33,75"), [10, 33, 75]);
  assert.deepEqual(S.parseSellPresets("10,150,75"), [10, 50, 75]);
  assert.deepEqual(S.parseSellPresets("10,33"), [25, 50, 75, 100]);
  assert.deepEqual(S.parseSellPresets("10,33,60,100"), [10, 33, 60, 100]);
  assert.deepEqual(S.parseSellPresets(undefined), [25, 50, 75, 100]);
});

test("slippage: the ticket's stored basis points, held to its range; percent text to basis points", () => {
  // nothing stored: the ticket's 1%, or the 5% an instant trade asks for
  assert.equal(S.DEFAULT_SLIPPAGE_BPS, 100);
  assert.equal(S.INSTANT_DEFAULT_SLIPPAGE_BPS, 500);
  assert.equal(S.parseSlippageBps(null, S.INSTANT_DEFAULT_SLIPPAGE_BPS), 500);
  assert.equal(S.parseSlippageBps("0", S.INSTANT_DEFAULT_SLIPPAGE_BPS), 500);
  assert.equal(S.parseSlippageBps("250", S.INSTANT_DEFAULT_SLIPPAGE_BPS), 250, "a stored value wins");
  assert.equal(S.slippageStored(null), false);
  assert.equal(S.slippageStored("abc"), false);
  assert.equal(S.slippageStored("12.5"), true);
  // a fractional value (an older custom entry) is a whole number of basis points for both
  assert.equal(S.parseSlippageBps("12.5"), 13);
  assert.equal(S.parseSlippageBps("6000"), S.MAX_SLIPPAGE_BPS, "a stored 60% is 50% everywhere");
  assert.equal(S.parseSlippageBps(null), S.DEFAULT_SLIPPAGE_BPS);
  assert.equal(S.parseSlippageBps(""), S.DEFAULT_SLIPPAGE_BPS);
  assert.equal(S.parseSlippageBps("300"), 300);
  assert.equal(S.parseSlippageBps("NaN"), S.DEFAULT_SLIPPAGE_BPS);
  assert.equal(S.parseSlippageBps("-5"), S.DEFAULT_SLIPPAGE_BPS);
  assert.equal(S.parseSlippageBps("0"), S.DEFAULT_SLIPPAGE_BPS);
  assert.equal(S.parseSlippageBps("999999"), S.MAX_SLIPPAGE_BPS);
  assert.equal(S.parseSlippageBps("0.4"), S.MIN_SLIPPAGE_BPS);
  assert.equal(S.slippagePctToBps("5"), 500);
  assert.equal(S.slippagePctToBps("2.5"), 250);
  assert.equal(S.slippagePctToBps("0.1"), 10, "the field's floor: 0.1%");
  assert.equal(S.slippagePctToBps("50"), 5_000);
  for (const bad of ["", "0", "0.001", "0.01", "0.09", "50.01", "51", "abc", "-1", "1.234"]) assert.equal(S.slippagePctToBps(bad), null, bad);
});

test("the sign-at-once field: 0 to 1,000 SOL; a slip that would switch the limit off is refused", () => {
  assert.equal(S.parseCapSol(""), 0);
  assert.equal(S.parseCapSol("0"), 0);
  assert.equal(S.parseCapSol("0.5"), 0.5);
  assert.equal(S.parseCapSol(".25"), 0.25);
  assert.equal(S.parseCapSol("1000"), 1000);
  for (const bad of ["1000.1", "999999999", "1e3", "-1", "abc", "1.2.3", "0.0000000001"]) assert.equal(S.parseCapSol(bad), null, bad);
});

test("an earlier trade that never settled: held while it may still land or its state is not known", () => {
  assert.equal(S.unsettledDecision("confirmed", 1_000), "go");
  assert.equal(S.unsettledDecision("failed", 1_000), "go");
  assert.equal(S.unsettledDecision("unknown", 10_000), "hold", "may still land");
  assert.equal(S.unsettledDecision("unknown", S.UNSETTLED_HOLD_MS), "go", "its blockhash is long gone");
  assert.equal(S.unsettledDecision("unread", 10_000), "hold");
  assert.equal(S.unsettledDecision("unread", 10 * S.UNSETTLED_HOLD_MS), "hold", "never a guess when the chain could not be asked");
});

test("a buy preset in lamports is exact", () => {
  assert.equal(S.solToLamports(0.1), 100_000_000n);
  assert.equal(S.solToLamports(0.5), 500_000_000n);
  assert.equal(S.solToLamports(1), 1_000_000_000n);
  assert.equal(S.solToLamports(0.0001), 100_000n);
  assert.equal(S.solToLamports(0.3), 300_000_000n, "0.3 is not 299999999");
  assert.equal(S.solToLamports(12.3456), 12_345_600_000n);
  assert.equal(S.solToLamports(100), 100_000_000_000n);
  assert.equal(S.solToLamports(0), 0n);
  assert.equal(S.solToLamports(-1), 0n);
  assert.equal(S.solToLamports(NaN), 0n);
  for (const p of S.DEFAULT_BUY_PRESETS) assert.equal(S.solToLamports(S.parseBuyPreset(S.presetText(p))!), S.solToLamports(p));
});

test("a sell's amount: 100% is the whole balance, a smaller share is rounded down, nothing from nothing", () => {
  assert.equal(S.sellAmountOf(1_000_000n, 25), 250_000n);
  assert.equal(S.sellAmountOf(1_000_001n, 50), 500_000n, "rounded down to a base unit");
  assert.equal(S.sellAmountOf(999n, 33), 329n);
  assert.equal(S.sellAmountOf(1_000_001n, 100), 1_000_001n, "no dust left");
  // beyond 2^53: BigInt all the way, never through a float
  const big = 123_456_789_012_345_678_901n;
  assert.equal(S.sellAmountOf(big, 100), big);
  assert.equal(S.sellAmountOf(big, 50), 61_728_394_506_172_839_450n);
  assert.equal(S.sellAmountOf(big, 1), 1_234_567_890_123_456_789n);
  assert.equal(S.sellAmountOf(0n, 100), 0n);
  assert.equal(S.sellAmountOf(0n, 50), 0n);
  assert.equal(S.sellAmountOf(3n, 25), 0n, "a share under one base unit is nothing");
  assert.equal(S.sellAmountOf(-5n, 50), 0n);
  assert.equal(S.sellAmountOf(1_000n, 0), 0n);
  assert.equal(S.sellAmountOf(1_000n, -10), 0n);
  assert.equal(S.sellAmountOf(1_000n, 12.5), 0n, "not a whole percentage");
  assert.equal(S.sellAmountOf(1_000n, NaN), 0n);
});

test("the cap: the trading wallet signs at once only up to it; 0 holds everything back; a connected wallet has its own popup", () => {
  const sol = (n: number) => BigInt(Math.round(n * 1e9));
  assert.equal(S.overCap({ trader: "trading", lamports: sol(1), capSol: 1 }), false, "at the cap");
  assert.equal(S.overCap({ trader: "trading", lamports: sol(1) + 1n, capSol: 1 }), true);
  assert.equal(S.overCap({ trader: "trading", lamports: sol(0.1), capSol: 1 }), false);
  assert.equal(S.overCap({ trader: "trading", lamports: 1n, capSol: 0 }), true);
  assert.equal(S.overCap({ trader: "trading", lamports: 1n, capSol: NaN }), true);
  assert.equal(S.overCap({ trader: "wallet", lamports: sol(50), capSol: 1 }), false);
  assert.equal(S.overCap({ trader: "wallet", lamports: sol(50), capSol: 0 }), false);
});

test("price impact: the fill against spot, and the 15% limit of an instant trade", () => {
  // 1 SOL at 0.000001 SOL per token is 1,000,000 tokens at spot; the quote gives 900,000 (6 decimals)
  const buy = S.tradeImpact({ side: "buy", amountIn: 1_000_000_000n, amountOut: 900_000_000_000n, decimals: 6, spot: 0.000001 });
  assert.ok(Math.abs(buy! - 0.1) < 1e-9);
  // 1,000,000 tokens at spot are 1 SOL; the quote gives 0.8 SOL
  const sell = S.tradeImpact({ side: "sell", amountIn: 1_000_000_000_000n, amountOut: 800_000_000n, decimals: 6, spot: 0.000001 });
  assert.ok(Math.abs(sell! - 0.2) < 1e-9);
  assert.equal(S.tradeImpact({ side: "buy", amountIn: 1n, amountOut: 1n, decimals: 6, spot: null }), null);
  assert.equal(S.tradeImpact({ side: "buy", amountIn: 1n, amountOut: 1n, decimals: 6, spot: 0 }), null);
  assert.equal(S.tradeImpact({ side: "sell", amountIn: 0n, amountOut: 1n, decimals: 6, spot: 1 }), null);
  assert.equal(S.MAX_INSTANT_IMPACT, 0.15);
  assert.equal(S.impactDecision(0.1), "ok");
  assert.equal(S.impactDecision(0.15), "ok", "at the limit");
  assert.equal(S.impactDecision(0.1501), "high");
  assert.equal(S.impactDecision(-0.02), "ok", "a fill better than spot");
  assert.equal(S.impactDecision(-0.05), "ok", "at the limit");
  assert.equal(S.impactDecision(-0.0501), "stale", "far better than spot: the spot price is out of date");
  assert.equal(S.impactDecision(-0.25), "stale");
  assert.equal(S.impactDecision(null), "unknown");
  assert.equal(S.impactDecision(NaN), "unknown");
  assert.equal(S.impactDecision(sell), "high");
});

test("what a buy needs, and the simulated cost an instant trade accepts", () => {
  assert.equal(S.buyNeedLamports(100_000_000n, 25_000n, 2_074_080n), 100_000_000n + 25_000n + 2_074_080n + S.BUY_HEADROOM_LAMPORTS);
  const base = { amountIn: 100_000_000n, feeLamports: 25_000n, rentLamports: 2_074_080n };
  assert.equal(S.costWithin({ side: "buy", spent: 102_099_080n, ...base }), true, "the amount, the fee and the rent");
  assert.equal(S.costWithin({ side: "buy", spent: 100_000_000n + 25_000n + 2_074_080n + S.INSTANT_COST_SLACK_LAMPORTS, ...base }), true, "at the slack");
  assert.equal(S.costWithin({ side: "buy", spent: 100_000_000n + 25_000n + 2_074_080n + S.INSTANT_COST_SLACK_LAMPORTS + 1n, ...base }), false);
  assert.equal(S.costWithin({ side: "buy", spent: null, ...base }), false, "an unmeasured cost is never accepted");
  assert.equal(S.costWithin({ side: "sell", spent: -280_000_000n, ...base }), true, "a sell brings SOL in");
  assert.equal(S.costWithin({ side: "sell", spent: 100_000_000n, ...base }), false, "a sell that would spend the wallet's SOL");
  assert.equal(S.costWithin({ side: "sell", spent: null, ...base }), false);
});

// ---- the sequence, on fakes

const key = () => Keypair.generate().publicKey.toBase58();
function coin(over: Partial<Coin> = {}): Coin {
  return {
    mint: key(), name: null, symbol: "SYM", image: null, description: null, twitter: null, telegram: null, website: null,
    creator: key(), quoteMint: null, quoteSymbol: "SOL", depth: 0, parent: null, root: null, ancestors: [],
    complete: false, migrated: false, pool: null, createdAt: null, createdSlot: null, tokenProgram: TOKEN_2022_ID, decimals: 6, totalSupply: "1",
    priceQuote: null, priceSol: 0.000001, priceUsd: null, mcapSol: null, mcapUsd: null, progress: 0, children: 0, descendants: 0, lockedQuote: "0", lockedUsd: null,
    volume24hUsd: 0, trades24h: 0, holderReward: false, creatorFeeBps: 0, shares: null, updatedAt: 0, mayhem: false, ...over,
  } as Coin;
}
const conn = {} as Connection;
const SOL = 1_000_000_000n;
type World = { coin: Coin; sol: bigint | null; token: bigint | null; hasAta: boolean; out: bigint | Error; spent: bigint | null; sendError: Error | null; routeFails: boolean;
  /// an earlier unsettled trade of the coin (its age in ms) and what the chain says of it ("unread": the read throws)
  last: { ageMs: number; state: "confirmed" | "failed" | "unknown" | "unread" } | null };
/// A world to trade in and the deps that read it; `calls` is every step in the order it ran.
function world(over: Partial<World> = {}) {
  const w: World = { coin: coin(), sol: 5n * SOL, token: 2_600_000_000_001n, hasAta: true, out: 0n, spent: null, sendError: null, routeFails: false, last: null, ...over };
  const calls: string[] = [];
  const sent: { side: string; amountIn: bigint; amountOut: bigint; slippageBps: number; mustMeasure: boolean | undefined }[] = [];
  const deps: InstantDeps = {
    loadCoin: async () => { calls.push("coin"); return w.coin; },
    loadRoute: async (_c, c) => { calls.push("route"); if (w.routeFails) throw new Error("rpc down"); return routeOf([c], null); },
    balances: async () => { calls.push("balances"); return { sol: w.sol, token: w.token, hasAta: w.hasAta }; },
    venues: () => [],
    priority: async () => 50_000,
    quote: async (_c, _p, _coin, _chain, _jup, side, amountIn) => {
      calls.push(`quote:${side}:${amountIn}`);
      if (w.out instanceof Error) throw w.out;
      return { amountOut: w.out, units: 120_000, unwrapped: 0n };
    },
    send: async (_c, _s, _coin, _chain, q, slippageBps, _micro, _report, extra = {}) => {
      calls.push("send");
      sent.push({ side: q.side, amountIn: q.amountIn, amountOut: q.amountOut, slippageBps, mustMeasure: extra.mustMeasure });
      // what lib/flow.ts does between the simulation and the signature
      extra.beforeSign?.({ unitsConsumed: 120_000, bytes: 900, logs: [], spent: w.spent });
      if (w.sendError) throw w.sendError;
      return { sig: "SIG", minOut: 1n };
    },
    pendingOf: (mint) => (w.last ? { sig: "LAST", mint, symbol: "SYM", side: "buy", at: 1_000_000 - w.last.ageMs } : null),
    sigState: async () => { calls.push("last"); if (w.last?.state === "unread") throw new Error("rpc down"); return w.last!.state as "confirmed" | "failed" | "unknown"; },
    clearPending: (sig) => { calls.push(`clear:${sig}`); },
    now: () => 1_000_000,
  };
  return { w, deps, calls, sent };
}
const sender = { publicKey: Keypair.generate().publicKey, sendTransaction: async () => { throw new Error("the test never signs"); } };
const input = (over: Partial<InstantInput>): InstantInput => ({ mint: "x", spec: { side: "buy", sol: 0.1 }, sender, trader: "trading", slippageBps: 300, capSol: 1, ...over });

test("instant sell: the balance read fresh, the share of it quoted, sent once with the slippage setting", async () => {
  // 50% of 2.600000000001M tokens, quoted at 1.29 SOL against 1.3 at spot; the cap is 2 SOL
  const { deps, calls, sent, w } = world({ out: 1_290_000_000n, spent: -1_289_000_000n });
  const r = await instantTrade(conn, input({ spec: { side: "sell", pct: 50 }, capSol: 2 }), deps);
  assert.equal(r.kind, "done");
  assert.deepEqual(calls, ["coin", "route", "balances", "quote:sell:1300000000000", "send"]);
  assert.deepEqual(sent, [{ side: "sell", amountIn: 1_300_000_000_000n, amountOut: 1_290_000_000n, slippageBps: 300, mustMeasure: true }]);
  if (r.kind === "done") { assert.equal(r.sig, "SIG"); assert.equal(r.coin, w.coin); }
  // 100% sells exactly what the wallet holds
  const all = world({ out: 2_500_000_000n, spent: -2_499_000_000n });
  await instantTrade(conn, input({ spec: { side: "sell", pct: 100 }, capSol: 5 }), all.deps);
  assert.equal(all.sent[0].amountIn, 2_600_000_000_001n);
});

test("instant buy: the preset in lamports, quoted and sent; a connected wallet is not held to the cap or the cost measure", async () => {
  const { deps, calls, sent } = world({ out: 98_000_000_000n, spent: 100_030_000n });
  const r = await instantTrade(conn, input({ spec: { side: "buy", sol: 0.1 } }), deps);
  assert.equal(r.kind, "done");
  assert.deepEqual(calls, ["coin", "route", "balances", "quote:buy:100000000", "send"]);
  assert.equal(sent[0].amountIn, 100_000_000n);
  const ext = world({ out: 4_900_000_000_000n, spent: null });
  const r2 = await instantTrade(conn, input({ spec: { side: "buy", sol: 5 }, trader: "wallet", capSol: 1 }), { ...ext.deps, balances: async () => ({ sol: 10n * SOL, token: 0n, hasAta: true }) });
  assert.equal(r2.kind, "done", "the extension's own popup is the confirmation");
  assert.equal(ext.sent[0].mustMeasure, false);
});

test("instant buy: a quote that fails is asked once more, and a good second quote is sent without the ticket", async () => {
  // Nov 17 2026: the relay refused one Jupiter route of five legs; the next build took another route
  const { deps, calls, sent } = world({ out: 98_000_000_000n, spent: 100_030_000n });
  let n = 0;
  const flaky: InstantDeps = { ...deps, quote: async (...a) => { if (n++ === 0) { calls.push("quote:refused"); throw new Error("403 Forbidden: simulateTransaction: only pump.fun transactions are relayed"); } return deps.quote(...a); } };
  const r = await instantTrade(conn, input({ spec: { side: "buy", sol: 0.1 } }), flaky);
  assert.equal(r.kind, "done");
  assert.deepEqual(calls, ["coin", "route", "balances", "quote:refused", "quote:buy:100000000", "send"]);
  assert.equal(sent.length, 1, "one send, never two");
  // a wallet short of SOL is not asked again
  const poor = world({ out: new Error("Not enough SOL in the wallet for this buy") });
  const p = await instantTrade(conn, input({ spec: { side: "buy", sol: 0.1 } }), poor.deps);
  assert.equal(p.kind, "ticket");
  if (p.kind === "ticket") assert.equal(p.reason, "sol");
  assert.equal(poor.calls.filter((c) => c.startsWith("quote")).length, 1);
});

test("every check that fails hands the trade to the ticket, prefilled, and nothing is sent", async () => {
  const ticket = async (o: Partial<World>, i: Partial<InstantInput>, reason: string, amount: string) => {
    const { deps, calls } = world(o);
    const r = await instantTrade(conn, input(i), deps);
    assert.equal(r.kind, "ticket", reason);
    if (r.kind !== "ticket") return;
    assert.equal(r.reason, reason);
    assert.equal(r.amount, amount);
    assert.ok(r.text.length > 20, "it says why");
    return { r, calls };
  };
  // a buy over the cap: stopped before any quote
  const cap = await ticket({}, { spec: { side: "buy", sol: 1 }, capSol: 0.5 }, "cap", "1");
  assert.ok(!cap!.calls.some((c) => c.startsWith("quote")));
  // a cap of 0 asks every time
  await ticket({}, { spec: { side: "buy", sol: 0.1 }, capSol: 0 }, "cap", "0.1");
  // a sell whose quote is over the cap: stopped after the quote, before the send
  const capSell = await ticket({ out: 3n * SOL }, { spec: { side: "sell", pct: 100 }, capSol: 1 }, "cap", "2600000.000001");
  assert.ok(!capSell!.calls.includes("send"));
  // not enough SOL for the buy with fee and headroom
  const poor = await ticket({ sol: 100_000_000n }, { spec: { side: "buy", sol: 0.1 } }, "sol", "0.1");
  assert.equal(poor!.r.deposit, true);
  assert.ok(!poor!.calls.some((c) => c.startsWith("quote")));
  // not enough SOL for a sell's fee
  await ticket({ sol: 10n }, { spec: { side: "sell", pct: 25 } }, "sol", "650000");
  // the quote could not be simulated, asked again once, still not: the ticket
  const noQuote = await ticket({ out: new Error("Simulation failed") }, { spec: { side: "buy", sol: 0.1 } }, "quote", "0.1");
  assert.ok(!noQuote!.calls.includes("send"));
  assert.equal(noQuote!.calls.filter((c) => c.startsWith("quote")).length, 1 + QUOTE_RETRIES);
  await ticket({ out: 0n }, { spec: { side: "buy", sol: 0.1 } }, "quote", "0.1");
  // price impact over 15% (0.1 SOL is 100,000 tokens at spot; the quote gives 80,000), or no spot price to measure it
  await ticket({ out: 80_000_000_000n }, { spec: { side: "buy", sol: 0.1 } }, "impact", "0.1");
  // a quote 25% better than spot: the index's price is out of date and would hide the real impact
  const stale = await ticket({ out: 125_000_000_000n, spent: 100_030_000n }, { spec: { side: "buy", sol: 0.1 } }, "impact", "0.1");
  assert.ok(!stale!.calls.includes("send"));
  assert.match(stale!.r.text, /out of date/);
  // the mirror: a sell after a pump the index has not seen (1.3M tokens at spot are 1.3 SOL; the quote gives 1.6)
  await ticket({ out: 1_600_000_000n, spent: -1_599_000_000n }, { spec: { side: "sell", pct: 50 }, capSol: 5 }, "impact", "1300000");
  // an earlier trade of the coin still unsettled, or whose state could not be read: held before the route is even read
  const held = await ticket({ last: { ageMs: 20_000, state: "unknown" }, out: 98_000_000_000n, spent: 100_030_000n }, { spec: { side: "buy", sol: 0.1 } }, "unsettled", "0.1");
  assert.deepEqual(held!.calls, ["coin", "last"]);
  await ticket({ last: { ageMs: 20 * 60_000, state: "unread" }, out: 98_000_000_000n }, { spec: { side: "buy", sol: 0.1 } }, "unsettled", "0.1");
  await ticket({ last: { ageMs: 20_000, state: "unknown" } }, { spec: { side: "sell", pct: 50 } }, "unsettled", "");
  await ticket({ out: 98_000_000_000n, coin: coin({ priceSol: null }) }, { spec: { side: "buy", sol: 0.1 } }, "impact", "0.1");
  // the cost of the exact transaction: not measured, or more than the trade should cost
  await ticket({ out: 98_000_000_000n, spent: null }, { spec: { side: "buy", sol: 0.1 } }, "cost", "0.1");
  await ticket({ out: 98_000_000_000n, spent: 500_000_000n }, { spec: { side: "buy", sol: 0.1 } }, "cost", "0.1");
  await ticket({ out: 98_000_000_000n, sendError: new UnmeasuredCostError() }, { spec: { side: "buy", sol: 0.1 } }, "cost", "0.1");
  // the price moved past the minimum at the last simulation: nothing signed, not sent again
  const moved = await ticket({ out: 98_000_000_000n, spent: 100_030_000n, sendError: new PriceMovedError() }, { spec: { side: "buy", sol: 0.1 } }, "moved", "0.1");
  assert.equal(moved!.calls.filter((c) => c === "send").length, 1);
  // a route that could not be checked
  await ticket({ routeFails: true }, { spec: { side: "buy", sol: 0.1 } }, "route", "0.1");
  // a coin on the route waiting for its migration
  await ticket({ coin: coin({ complete: true, migrated: false }) }, { spec: { side: "buy", sol: 0.1 } }, "pending", "0.1");
  assert.ok(new InstantCostError().message.includes("not signed"));
});

test("an earlier trade that settled, or can no longer land, is dropped and the trade goes on", async () => {
  for (const last of [{ ageMs: 20_000, state: "confirmed" as const }, { ageMs: 20_000, state: "failed" as const }, { ageMs: 10 * 60_000, state: "unknown" as const }]) {
    const { deps, calls } = world({ last, out: 98_000_000_000n, spent: 100_030_000n });
    const r = await instantTrade(conn, input({ spec: { side: "buy", sol: 0.1 } }), deps);
    assert.equal(r.kind, "done", last.state);
    assert.deepEqual(calls, ["coin", "last", "clear:LAST", "route", "balances", "quote:buy:100000000", "send"]);
  }
});

test("a hard-blocked route is said in the row; nothing to sell and a failed send are errors; a send is never repeated", async () => {
  const blocked = world({ coin: coin({ mayhem: true }) });
  const b = await instantTrade(conn, input({}), blocked.deps);
  assert.equal(b.kind, "blocked");
  if (b.kind === "blocked") assert.equal(b.block.kind, "mayhem");
  assert.ok(!blocked.calls.some((c) => c.startsWith("quote")));

  const empty = world({ token: 0n, hasAta: false });
  const e = await instantTrade(conn, input({ spec: { side: "sell", pct: 100 } }), empty.deps);
  assert.equal(e.kind, "failed");
  assert.deepEqual(empty.calls, ["coin", "route", "balances"]);
  const dust = world({ token: 3n });
  assert.equal((await instantTrade(conn, input({ spec: { side: "sell", pct: 25 } }), dust.deps)).kind, "failed");

  // expired after it was sent: reported, with no second send
  const exp = Object.assign(new ExpiredError(), { sentSig: "SENT" });
  const expired = world({ out: 98_000_000_000n, spent: 100_030_000n, sendError: exp });
  const x = await instantTrade(conn, input({}), expired.deps);
  assert.equal(x.kind, "failed");
  assert.equal(expired.calls.filter((c) => c === "send").length, 1);
  // sent, result unknown: the link to check it
  const lost = world({ out: 98_000_000_000n, spent: 100_030_000n, sendError: Object.assign(new Error("timeout"), { sentSig: "SENT" }) });
  const l = await instantTrade(conn, input({}), lost.deps);
  assert.equal(l.kind, "failed");
  if (l.kind === "failed") { assert.ok(l.link?.href.includes("SENT")); assert.match(l.text, /could not confirm/); }
  assert.equal(lost.calls.filter((c) => c === "send").length, 1);
  // the wallet refused: an error, no ticket
  const no = world({ out: 98_000_000_000n, spent: 100_030_000n, sendError: new Error("User rejected the request") });
  assert.equal((await instantTrade(conn, input({ trader: "wallet" }), no.deps)).kind, "failed");

  // no wallet, or a coin that cannot be read: nothing runs
  const none = world();
  assert.equal((await instantTrade(conn, input({ sender: { publicKey: null, sendTransaction: sender.sendTransaction } }), none.deps)).kind, "failed");
  assert.deepEqual(none.calls, []);
});

test("a token balance that could not be read: no sell is sized from it, and a buy counts the account's rent", async () => {
  // a sell: the could-not-be-read outcome, nothing quoted, nothing signed
  const sell = world({ token: null, hasAta: true });
  const r = await instantTrade(conn, input({ spec: { side: "sell", pct: 100 } }), sell.deps);
  assert.equal(r.kind, "failed");
  if (r.kind === "failed") assert.match(r.text, /could not be read/);
  assert.deepEqual(sell.calls, ["coin", "route", "balances"]);
  // a buy with exactly the SOL it needs when the token account exists (no rent): past the early check when the
  // balance was read, stopped there when it was not (the account may be missing: its rent is counted)
  const exact = S.buyNeedLamports(100_000_000n, swapFeeLamports(swapUnits(1, null), CU_PRICE_MICRO), 0n);
  const known = world({ sol: exact, hasAta: true, out: 98_000_000_000n, spent: 100_030_000n });
  await instantTrade(conn, input({ spec: { side: "buy", sol: 0.1 } }), known.deps);
  assert.ok(known.calls.some((c) => c.startsWith("quote")), "the account exists: no rent");
  const unread = world({ sol: exact, token: null, hasAta: true, out: 98_000_000_000n, spent: 100_030_000n });
  const u = await instantTrade(conn, input({ spec: { side: "buy", sol: 0.1 } }), unread.deps);
  assert.equal(u.kind, "ticket");
  if (u.kind === "ticket") assert.equal(u.reason, "sol");
  assert.ok(!unread.calls.some((c) => c.startsWith("quote")));
});
