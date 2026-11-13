// The quick trade's rules: which coins a SOL wallet can trade in one multi_hop_swap (a SOL root, or a root priced in a
// listed pump coin with its PumpSwap SOL pool), why the others cannot, the hops of a pool-first route, the swap
// program's own error codes in words, the confirmation poll that never reads a failed status call as an answer, and
// the record of a sent trade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { RouteAsset } from "../src/lib/trade-route.ts";
import type { Coin } from "../src/lib/api.ts";
// The pump SDK's ESM build cannot load under Node (test/cjs-sdk-hook.mjs says why): the hook first, then the modules
// that import it.
await import("./cjs-sdk-hook.mjs");
const { assetLabel, assetPoolFrom, blockText, hardBlock, routeOf, MAX_ROUTE_LINKS } = await import("../src/lib/trade-route.ts");
const { hopsFor, withSolPool } = await import("../src/lib/pump/route.ts");
const { ataRentLamports, explainCustomError, explainSimulationError, failedProgram, isSlippageFailure, priorityMicroLamports, swapUnits, CU_PRICE_MAX_MICRO, CU_PRICE_MICRO, TOKEN_2022_ID } = await import("../src/lib/pump/trade.ts");
const { confirm, ExpiredError, OnChainError } = await import("../src/lib/pump/send.ts");
const { clearPendingTrade, pendingTradeOf, savePendingTrade, PENDING_TRADE_TTL_MS } = await import("../src/lib/trade-store.ts");

const key = () => Keypair.generate().publicKey.toBase58();
const SPL = TOKEN_PROGRAM_ID.toBase58();
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

/// A coin record with what the route reads; `quoteMint` null = SOL.
function coin(over: Partial<Coin> & { mint?: string } = {}): Coin {
  return {
    mint: over.mint ?? key(), name: null, symbol: "C", image: null, description: null, twitter: null, telegram: null, website: null,
    creator: key(), quoteMint: null, quoteSymbol: "SOL", depth: 0, parent: null, root: null, ancestors: [],
    complete: false, migrated: false, pool: null, createdAt: null, createdSlot: null, tokenProgram: TOKEN_2022_ID, decimals: 6, totalSupply: "1",
    priceQuote: null, priceSol: null, priceUsd: null, mcapSol: null, mcapUsd: null, progress: 0, children: 0, descendants: 0, lockedQuote: "0", lockedUsd: null,
    volume24hUsd: 0, trades24h: 0, holderReward: false, creatorFeeBps: 0, shares: null, updatedAt: 0, mayhem: false, ...over,
  } as Coin;
}

test("a chain that reaches SOL routes from SOL; one ending in a listed asset with no SOL pool is blocked with its name", () => {
  const root = coin({ symbol: "ROOT" });
  const kid = coin({ depth: 1, quoteMint: root.mint, quoteSymbol: "ROOT" });
  const r = routeOf([kid, root], null);
  assert.equal(r.block, null); assert.equal(r.via, "sol"); assert.equal(r.chain.length, 2);
  assert.equal(r.chain[0].quoteTokenProgram, root.tokenProgram, "a child's quote side is its parent's token program");
  assert.equal(r.chain[1].quoteTokenProgram, SPL, "SOL's side is classic SPL Token");

  const hype = key();
  const papercat = coin({ symbol: "papercat", quoteMint: hype, quoteSymbol: "HYPE" });
  const b = routeOf([papercat], null);
  assert.deepEqual(b.block, { kind: "listed", asset: hype, symbol: "HYPE" });
  assert.equal(hardBlock(b)?.kind, "listed");
  const t = blockText(b.block!, papercat);
  assert.equal(t.title, "Priced in $HYPE"); assert.match(t.body, /\$HYPE/); assert.equal(t.short, "priced in $HYPE");
  assert.equal(assetLabel("H74C…"), "H74C…", "a short mint is not a ticker");
  // a pool for another asset is no pool for this one
  assert.equal(routeOf([papercat], { mint: key(), tokenProgram: TOKEN_2022_ID, symbol: "X" }).block?.kind, "listed");
});

test("a root priced in a listed pump coin with a SOL pool routes SOL → that pool → root → coin, the root's quote side on the asset's token program", () => {
  const asset: RouteAsset = { mint: key(), tokenProgram: TOKEN_2022_ID, symbol: "LMAO!" };
  const root = coin({ symbol: "R", quoteMint: asset.mint, quoteSymbol: "LMAO!", tokenProgram: TOKEN_2022_ID, migrated: true });
  const kid = coin({ symbol: "K", depth: 1, quoteMint: root.mint, quoteSymbol: "R" });
  const r = routeOf([kid, root], asset);
  assert.equal(r.block, null); assert.equal(r.via, "pool"); assert.equal(r.asset, asset);
  assert.equal(r.chain.length, 3);
  assert.deepEqual(r.chain[2], { mint: asset.mint, quoteMint: null, tokenProgram: TOKEN_2022_ID, quoteTokenProgram: SPL, migrated: true, depth: 0 });
  assert.equal(r.chain[1].quoteTokenProgram, TOKEN_2022_ID, "not the SPL default");
  const buy = hopsFor(r.chain, "buy");
  assert.equal(buy[0].venue, "pool"); assert.ok(buy[0].baseMint.equals(new PublicKey(asset.mint))); assert.ok(buy[0].quoteMint.equals(NATIVE_MINT));
  assert.ok(buy[0].baseTokenProgram.equals(new PublicKey(TOKEN_2022_ID))); assert.ok(buy[0].quoteTokenProgram.equals(TOKEN_PROGRAM_ID));
  assert.equal(buy[1].venue, "pool", "the migrated root trades in its pool"); assert.ok(buy[1].quoteMint.equals(new PublicKey(asset.mint))); assert.ok(buy[1].quoteTokenProgram.equals(new PublicKey(TOKEN_2022_ID)));
  assert.equal(buy[2].venue, "curve"); assert.ok(buy[2].baseMint.equals(new PublicKey(kid.mint)));
  const sell = hopsFor(r.chain, "sell");
  assert.ok(sell[0].baseMint.equals(new PublicKey(kid.mint))); assert.ok(sell[2].quoteMint.equals(NATIVE_MINT), "a sell ends in SOL");
  assert.throws(() => withSolPool([kid], asset), /does not end in that asset/);
});

test("mayhem coins, a missing ancestor, a route too deep and a pending migration each have their own block", () => {
  const root = coin();
  assert.equal(routeOf([coin({ depth: 1, quoteMint: root.mint }), { ...root, mayhem: true }], null).block?.kind, "mayhem");
  const gap = routeOf([coin({ depth: 2, quoteMint: key() })], null);
  assert.equal(gap.block?.kind, "gap", "a chain cut short by a missing record is not called 'priced in a listed asset'");
  const chainOf = (links: number) => { const out: Coin[] = []; let parent = coin(); out.unshift(parent); for (let d = 1; d < links; d++) { const c = coin({ depth: d, quoteMint: parent.mint }); out.unshift(c); parent = c; } return out; };
  assert.equal(MAX_ROUTE_LINKS, 5, "a 6-hop transaction overflows 1,232 bytes even with Spore's lookup table");
  assert.equal(routeOf(chainOf(MAX_ROUTE_LINKS), null).block, null, "5 links fit");
  assert.deepEqual(routeOf(chainOf(MAX_ROUTE_LINKS + 1), null).block, { kind: "deep", links: MAX_ROUTE_LINKS + 1 });
  // the asset's SOL pool is a link too: a 5-coin chain under a pooled asset is 6
  const pooled: RouteAsset = { mint: key(), tokenProgram: SPL, symbol: "A" };
  const five = chainOf(MAX_ROUTE_LINKS); five[five.length - 1] = { ...five[five.length - 1], quoteMint: pooled.mint, quoteSymbol: "A" };
  assert.equal(routeOf(five, pooled).block?.kind, "deep");
  const self = coin({ depth: 1, quoteMint: root.mint, mayhem: true });
  assert.match(blockText(routeOf([self, root], null).block!, self).body, /is a mayhem-mode coin/, "the coin itself");
  const waiting = { ...root, complete: true, migrated: false };
  const p = routeOf([coin({ depth: 1, quoteMint: root.mint }), waiting], null);
  assert.equal(p.block?.kind, "pending"); assert.equal(hardBlock(p), null, "a pending migration passes by itself: buttons stay");
  assert.match(blockText(p.block!, waiting).body, /checks again/);
});

test("a listed asset's SOL pool counts only when it is pump-amm's canonical pool of that asset against WSOL and not mayhem-mode", () => {
  const asset = Keypair.generate().publicKey;
  const data = new Uint8Array(301);
  data.set(asset.toBytes(), 43); data.set(NATIVE_MINT.toBytes(), 75);
  const pool = (over: Partial<{ owner: string; data: Uint8Array }> = {}) => ({ owner: new PublicKey(over.owner ?? AMM), data: over.data ?? data });
  const mint = { owner: new PublicKey(TOKEN_2022_ID), data: new Uint8Array(82) };
  assert.deepEqual(assetPoolFrom(asset.toBase58(), pool(), mint), { mint: asset.toBase58(), tokenProgram: TOKEN_2022_ID });
  assert.equal(assetPoolFrom(asset.toBase58(), null, mint), null, "no pool");
  assert.equal(assetPoolFrom(asset.toBase58(), pool(), null), null, "no mint");
  assert.equal(assetPoolFrom(asset.toBase58(), pool({ owner: PUMP }), mint), null, "another program's account");
  assert.equal(assetPoolFrom(key(), pool(), mint), null, "another base mint");
  const usdc = data.slice(); usdc.set(Keypair.generate().publicKey.toBytes(), 75);
  assert.equal(assetPoolFrom(asset.toBase58(), pool({ data: usdc }), mint), null, "quoted in something else than WSOL");
  const mayhem = data.slice(); mayhem[243] = 1;
  assert.equal(assetPoolFrom(asset.toBase58(), pool({ data: mayhem }), mint), null, "mayhem pool (pump-amm 6080)");
  const cashback = data.slice(); cashback[244] = 1;
  assert.ok(assetPoolFrom(asset.toBase58(), pool({ data: cashback }), mint), "a cashback asset is a middle hop: pump refuses cashback only on the coin bought");
  assert.equal(assetPoolFrom(asset.toBase58(), pool({ data: data.slice(0, 100) }), mint), null, "too short to hold the mints");
  assert.equal(assetPoolFrom(asset.toBase58(), pool(), { owner: TOKEN_PROGRAM_ID, data: new Uint8Array(82) })?.tokenProgram, SPL, "the mint's owner is its token program");
});

test("errors are read in the table of the program that raised them; slippage is recognised in both programs", () => {
  const ammLogs = [`Program ${AMM} invoke [1]`, "Program log: Instruction: MultiHopSwap", `Program ${AMM} consumed 90000 of 400000 compute units`, `Program ${AMM} failed: custom program error: 0x1774`];
  assert.deepEqual(failedProgram(ammLogs), { program: AMM, code: 6004 });
  assert.match(explainSimulationError({}, ammLogs), /^slippage: the output fell below your minimum \(6004\)$/, "pump-amm's 6004, not pump's 6004");
  assert.equal(isSlippageFailure(ammLogs), true);
  // pump fails first inside the CPI, then pump-amm unwinds with the same code: the innermost program wins
  const inner = [`Program ${AMM} invoke [1]`, `Program ${PUMP} invoke [2]`, `Program ${PUMP} failed: custom program error: 0x17db`, `Program ${AMM} failed: custom program error: 0x17db`];
  assert.equal(failedProgram(inner)?.program, PUMP);
  assert.match(explainSimulationError({}, inner), /migrat/i);
  assert.equal(isSlippageFailure(inner), false);
  assert.equal(isSlippageFailure([`Program ${PUMP} failed: custom program error: 0x179a`]), true, "pump's 6042 BuySlippageBelowMinTokensOut");
  assert.equal(isSlippageFailure([`Program ${PUMP} failed: custom program error: 0x1774`]), false, "pump's own 6004 is no slippage error");
  assert.equal(isSlippageFailure([], 6040), true, "an on-chain { Custom: 6040 } with no logs");
  assert.match(explainCustomError(6079) ?? "", /cashback/);
  assert.match(explainCustomError(6108, PUMP) ?? "", /mayhem/i);
  assert.match(explainSimulationError({}, ["Program log: exceeded CUs meter at BPF instruction"]), /compute units/);
});

test("the compute limit follows the simulation with a margin, and the rent of a new token account follows its program", () => {
  assert.equal(swapUnits(1), 230_000); assert.equal(swapUnits(3), 390_000);
  assert.equal(swapUnits(3, 196_000), Math.ceil(196_000 * 1.3));
  assert.equal(swapUnits(1, 60_000), 100_000, "at least 40k over a small simulation");
  assert.equal(swapUnits(6, 1_300_000), 1_400_000, "never over the transaction cap");
  assert.equal(ataRentLamports(TOKEN_2022_ID), 2_074_080n); assert.equal(ataRentLamports(SPL), 2_039_280n);
});

test("the priority fee is the 75th percentile of recent fees on the route, clamped; a failed read is the floor", async () => {
  const conn = (fees: number[] | Error) => ({ getRecentPrioritizationFees: async () => { if (fees instanceof Error) throw fees; return fees.map((f, slot) => ({ slot, prioritizationFee: f })); } });
  assert.equal(await priorityMicroLamports(conn([0, 0, 0]) as never, []), CU_PRICE_MICRO, "a quiet network");
  assert.equal(await priorityMicroLamports(conn([60_000, 70_000, 80_000, 90_000, 0]) as never, []), 90_000);
  assert.equal(await priorityMicroLamports(conn([5_000_000, 9_000_000]) as never, []), CU_PRICE_MAX_MICRO);
  assert.equal(await priorityMicroLamports(conn(new Error("429")) as never, []), CU_PRICE_MICRO);
});

test("the confirmation poll keeps going through failed status calls and never reads them as expired; an on-chain failure is explained", async () => {
  let calls = 0;
  const flaky = {
    getSignatureStatuses: async () => { calls++; if (calls <= 2) throw new Error("429 Too Many Requests"); return { value: [{ confirmationStatus: "confirmed", err: null }] }; },
    getBlockHeight: async () => 1_000,
  };
  await confirm(flaky as never, "sig", 10); // the height is long past lastValidBlockHeight: only an answer may say "expired"
  assert.equal(calls, 3);
  const gone = { getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 1_000 };
  await assert.rejects(confirm(gone as never, "sig", 10), ExpiredError);
  const failed = { getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 6004 }] } }] }), getBlockHeight: async () => 0 };
  await assert.rejects(confirm(failed as never, "sig", 10, (c) => explainCustomError(c)), (e: unknown) => e instanceof OnChainError && e.code === 6004 && /slippage/.test(e.message));
});

test("a sent trade is remembered until it settles, per coin, and forgotten after its TTL", () => {
  const mem = new Map<string, string>();
  const s = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  const t0 = 1_800_000_000_000;
  savePendingTrade({ sig: "a", mint: "M", symbol: "X", side: "buy", at: t0 }, s, t0);
  savePendingTrade({ sig: "b", mint: "M", symbol: "X", side: "sell", at: t0 + 1_000 }, s, t0 + 1_000);
  savePendingTrade({ sig: "c", mint: "N", symbol: null, side: "buy", at: t0 + 2_000 }, s, t0 + 2_000);
  assert.equal(pendingTradeOf("M", s, t0 + 3_000)?.sig, "b", "the newest of that coin");
  clearPendingTrade("b", s, t0 + 3_000);
  assert.equal(pendingTradeOf("M", s, t0 + 3_000)?.sig, "a");
  assert.equal(pendingTradeOf("M", s, t0 + PENDING_TRADE_TTL_MS + 1), null, "too old to ask about");
  assert.equal(pendingTradeOf("N", s, t0 + 3_000)?.sig, "c");
  mem.set("spore:trades-pending", "not json");
  assert.equal(pendingTradeOf("N", s, t0), null, "a broken record reads as none");
});

const { friendlyError } = await import("../src/lib/steps.ts");
const { SimulationError } = await import("../src/lib/pump/simulate.ts");
const { resolveAssetPool } = await import("../src/lib/trade-route.ts");
const { canonicalPumpPoolPdaWithQuote } = await import("@pump-fun/pump-sdk");

test("the step text reads codes only where they are codes, and in the words of the program that raised them", () => {
  // pump-amm 6084 (not slippage) in a run whose Token-2022 CPI consumed 46023 units: once read as "slippage 6023"
  const logs = [`Program ${AMM} invoke [1]`, "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb consumed 46023 of 300000 compute units", `Program ${AMM} failed: custom program error: 0x17c4`];
  const hop = new SimulationError(explainSimulationError({}, logs), logs, {});
  assert.doesNotMatch(friendlyError(hop), /price moved/i);
  assert.match(friendlyError(hop), /do not connect/);
  const thin = [`Program ${AMM} failed: custom program error: 0x1773`]; // pump-amm 6003: liquidity, not pump's 6003 slippage
  assert.doesNotMatch(friendlyError(new SimulationError(explainSimulationError({}, thin), thin, {})), /price moved/i);
  const slip = [`Program ${AMM} failed: custom program error: 0x1774`];
  assert.match(friendlyError(new SimulationError(explainSimulationError({}, slip), slip, {})), /price moved/i);
  assert.match(friendlyError(new Error('Transaction failed on-chain: {"InstructionError":[2,{"Custom":6003}]} (sig)')), /price moved/i, "a bare pump code from a launch");
  assert.match(friendlyError(new Error("Transaction failed on-chain: A quote-chain coin's curve is complete but not yet migrated (6107) (sig)")), /not migrated yet/);
});

test("a listed asset's SOL pool is looked up at its canonical pool PDA against WSOL, once per 10 minutes", async () => {
  const asset = Keypair.generate().publicKey;
  const data = new Uint8Array(301); data.set(asset.toBytes(), 43); data.set(NATIVE_MINT.toBytes(), 75);
  const asked: string[][] = [];
  const conn = { getMultipleAccountsInfo: async (keys: PublicKey[]) => { asked.push(keys.map((k) => k.toBase58())); return [{ owner: new PublicKey(AMM), data }, { owner: TOKEN_PROGRAM_ID, data: new Uint8Array(82) }]; } };
  const got = await resolveAssetPool(conn as never, asset.toBase58());
  assert.deepEqual(got, { mint: asset.toBase58(), tokenProgram: SPL });
  assert.deepEqual(asked[0], [canonicalPumpPoolPdaWithQuote(asset, NATIVE_MINT).toBase58(), asset.toBase58()], "the pool PDA (asset as base, WSOL as quote), then the mint");
  await resolveAssetPool(conn as never, asset.toBase58());
  assert.equal(asked.length, 1, "cached");
  const failing = { getMultipleAccountsInfo: async () => { throw new Error("429"); } };
  const other = Keypair.generate().publicKey.toBase58();
  await assert.rejects(resolveAssetPool(failing as never, other));
  assert.deepEqual(await resolveAssetPool(conn as never, other).catch(() => "again"), null, "a failed lookup is not cached: the next one asks again (and this answer's base is another mint)");
});
