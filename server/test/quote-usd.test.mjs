// Size by mcap (owner 2026-10-21): listed quote mints CoinGecko does not cover (CARDS, tokenized stocks,
// WBTC, ...) get a USD price from Jupiter, batched; a root quoted in one of them, and every coin below
// it, is then priced in USD through the chain. mcapCapUsd caps a coin's map value at LIQ_X times its
// quote liquidity, present only when it bites. No network: Jupiter is a stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer, JUP_BATCH, JUP_MIN_LIQ_USD } from "../lib/indexer.mjs";
import { LIQ_X, mcapCapOf } from "../lib/pricing.mjs";
import { familyShares, valueOf } from "../lib/dominance.mjs";
import { PLATFORM, quiet, T22 } from "./helpers/tree.mjs";

const CARDS = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp";
const POKEMON = "D42TjMjz5H7toPu5md5KBXreZkCSdZMEfLQwmBhJXvb1";
const CHARIZARD = "D9rASpRWPyMYQGVLQLEN4S4Cy8fYE7fP8au9Gy7Upump";
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const key = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
const supply = "1000000000000000"; // 1e9 tokens at 6 decimals

function model() {
  const db = new Db(":memory:");
  const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load();
  m.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  m.setSolUsd(100);
  return m;
}
/** Pokémon (root, quoted in CARDS, price 0.0009793453 CARDS) and CHARIZARD (child, 0.0710214828 Pokémon), both on their curves. */
function cardsTree(m) {
  m.setMint({ mint: CARDS, decimals: 6, tokenProgram: T22, name: "Cards", symbol: "CARDS", supply: "1000000000000000", onchainAt: 1 });
  // price = (vq / 1e6) / (vt / 1e6): vt = 1e9 tokens, vq = price × 1e9 quote units
  m.upsertCoin({ mint: POKEMON, curve: "C_P", depth: 0, quoteMint: CARDS, virtualTokenReserves: supply, virtualQuoteReserves: String(Math.round(0.0009793453 * 1e15)), realTokenReserves: "1", realQuoteReserves: "0", tokenTotalSupply: supply, creator: "CR" });
  m.upsertCoin({ mint: CHARIZARD, curve: "C_C", depth: 1, quoteMint: POKEMON, virtualTokenReserves: supply, virtualQuoteReserves: String(Math.round(0.0710214828 * 1e15)), realTokenReserves: "1", realQuoteReserves: "5000000", tokenTotalSupply: supply, creator: "CR" });
  for (const [mint, symbol] of [[POKEMON, "Pokémon"], [CHARIZARD, "CHARIZARD"]]) m.setMint({ mint, decimals: 6, tokenProgram: T22, name: symbol, symbol, onchainAt: 1 });
}
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a / b - 1) <= tol, `${a} vs ${b}`);

test("CARDS chain: a root quoted in a listed token and its child get USD once the token's price is known", () => {
  const m = model();
  cardsTree(m);
  assert.equal(m.view(m.get(POKEMON)).mcapUsd, null, "unpriced quote: no USD (the bug the owner saw)");
  const v0 = m.version;
  assert.equal(m.setQuoteUsdMany({ [CARDS]: 0.36422 }), 1);
  assert.equal(m.version, v0 + 1, "one bump");
  assert.equal(m.setQuoteUsdMany({ [CARDS]: 0.36422 }), 0, "an unchanged price does not bump");
  assert.equal(m.version, v0 + 1);
  const p = m.view(m.get(POKEMON)), c = m.view(m.get(CHARIZARD));
  near(p.priceUsd, 3.567e-4); near(p.mcapUsd, 356_700);
  near(c.priceUsd, 2.533e-5); near(c.mcapUsd, 25_330);
  // priceOf (the live trade path) and computed() (the forest pass) agree
  near(m.priceOf(CHARIZARD).priceUsd, c.priceUsd, 1e-9);
  // the map node and the asset top follow
  const tree = m.mapAll({ all: true }).body.roots;
  const top = tree.find((r) => r.coin.mint === CARDS);
  assert.ok(top, "CARDS is an asset top");
  assert.equal(top.coin.asset, true);
  near(top.children[0].coin.mcapUsd, 356_700);
  near(top.coin.mcapUsd, 0.36422 * 1e9);
  // sizing by mcap: the asset's own mcap never counts, its family is Pokémon + CHARIZARD
  // (members' own mcap values: Pokémon + CHARIZARD). This 3-coin test family locks nothing, so the thin-family guard
  // (dominance.mjs isThinFamily, 2026-10-21) weighs it in locked terms: Σ members' lockedUsd (SPEC §3.1, no leaf slice)
  const own = [], lockedParts = []; { const st = [tree.find((r) => r.coin.mint === CARDS)]; while (st.length) { const n = st.pop(); own.push(valueOf(n.coin, "mcap") ?? 0); if (n.coin.lockedUsd > 0) lockedParts.push(n.coin.lockedUsd); st.push(...n.children); } }
  near(own.reduce((s, v) => s + v, 0), 356_700 + 25_330);
  const fam = familyShares(tree, "mcap").families.find((f) => f.mint === CARDS);
  assert.equal(fam.coins, 3); assert.equal(fam.value, Math.round(lockedParts.reduce((s, v) => s + v, 0) * 100) / 100);
  // a persisted price survives a reload
  assert.equal(m.db.kvGet("quoteUsd", {})[CARDS], 0.36422);
});

test("a cycle in the quote chain has no USD price (guard), never a loop", () => {
  const m = model();
  const a = key(41), b = key(42);
  m.upsertCoin({ mint: a, curve: "C_a", depth: 0, quoteMint: b, virtualTokenReserves: supply, virtualQuoteReserves: supply, tokenTotalSupply: supply, creator: "CR" });
  m.upsertCoin({ mint: b, curve: "C_b", depth: 0, quoteMint: a, virtualTokenReserves: supply, virtualQuoteReserves: supply, tokenTotalSupply: supply, creator: "CR" });
  m.setQuoteUsdMany({ [a]: 5, [b]: 5 });
  assert.equal(m.view(m.get(a)).priceUsd, null);
  assert.equal(m.priceOf(b).priceUsd, null);
});

test("refreshQuoteUsd: 79 asset quotes = 2 sequential Jupiter calls and 1 bump; thin liquidity and CoinGecko mints are skipped", async () => {
  const m = model();
  const quotes = Array.from({ length: 79 }, (_, i) => key(100 + i));
  quotes.forEach((q, i) => m.upsertCoin({ mint: key(200 + i), curve: `C${i}`, depth: 0, quoteMint: q, virtualTokenReserves: supply, virtualQuoteReserves: supply, tokenTotalSupply: supply, creator: "CR" }));
  m.upsertCoin({ mint: key(30), curve: "Cpump", depth: 0, quoteMint: PUMP, virtualTokenReserves: supply, virtualQuoteReserves: supply, tokenTotalSupply: supply, creator: "CR" });
  m.setQuoteUsd(PUMP, 0.004);
  const calls = []; let inflight = 0, maxInflight = 0;
  const fetchImpl = async (url) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    const ids = new URL(url).searchParams.get("ids").split(",");
    calls.push(ids);
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    const body = {};
    for (const id of ids) body[id] = { usdPrice: 2, liquidity: id === quotes[3] ? JUP_MIN_LIQ_USD - 1 : id === quotes[4] ? undefined : 1e6 };
    // a Token-2022 ScaledUiAmount mint (a tokenized stock after a split): the prescaled price wins; a 0 one is ignored
    body[quotes[5]] = { ...body[quotes[5]], scaledUiConfig: { multiplier: 1, newMultiplier: 1.5, usdPricePrescaled: 3 } };
    body[quotes[6]] = { ...body[quotes[6]], scaledUiConfig: { usdPricePrescaled: 0 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const ix = new Indexer({ rpc: {}, model: m, meta: null, hub: null, log: quiet, opts: { fetch: fetchImpl } });
  const v0 = m.version;
  const got = await ix.refreshQuoteUsd();
  assert.equal(calls.length, 2); assert.equal(maxInflight, 1, "sequential");
  assert.equal(calls[0].length, JUP_BATCH); assert.equal(calls[1].length, 29);
  assert.ok(!calls.flat().includes(PUMP), "CoinGecko's mint is not asked for");
  assert.equal(m.version, v0 + 1, "one bump for the whole refresh");
  assert.equal(Object.keys(got).length, 78, "the < $5k liquidity price is rejected, an absent liquidity accepted");
  assert.equal(m.quoteUsd.get(quotes[3]), undefined);
  assert.equal(m.quoteUsd.get(quotes[4]), 2);
  assert.equal(m.quoteUsd.get(quotes[5]), 3, "usdPricePrescaled: the price per raw amount / 10^decimals");
  assert.equal(m.quoteUsd.get(quotes[6]), 2, "no usable prescaled price: usdPrice");
  assert.equal(m.quoteUsd.get(PUMP), 0.004, "never overwritten");
  // a failing Jupiter keeps the last values and does not bump
  const v1 = m.version;
  await ix.refreshQuoteUsd({ fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(m.version, v1); assert.equal(m.quoteUsd.get(quotes[0]), 2);
});

test("mcapCapUsd: emitted on the map node, /api/coin view and mapdelta only when mcap > LIQ_X x liquidity", () => {
  assert.equal(LIQ_X, 50, "lowered from 100: a junk family (XTO, locked $0.02, 2 children) stayed #1 at 100");
  assert.equal(mcapCapOf(1_000_000, 100), 100 * LIQ_X);
  assert.equal(mcapCapOf(1_000, 100), null);
  assert.equal(mcapCapOf(1_000, null), null);
  const m = model();
  // junk: 1e9 supply on a pool with 1e9 base and 0.001 SOL: price 1e-12 SOL... make the mcap big with a tiny pool instead
  const junk = key(60), fine = key(61);
  m.upsertCoin({ mint: junk, curve: "Cj", depth: 0, quoteMint: null, migrated: true, poolBase: "1000000", poolQuote: "10000000", tokenTotalSupply: supply, virtualTokenReserves: "0", creator: "CR" });
  // junk: 1 token in the pool against 0.01 SOL → price 0.01 SOL → mcap 1e9 × 0.01 × $100 = $1e9 on $1 of liquidity
  m.upsertCoin({ mint: fine, curve: "Cf", depth: 0, quoteMint: null, virtualTokenReserves: supply, virtualQuoteReserves: "30000000000", tokenTotalSupply: supply, creator: "CR" });
  for (const [mint, s] of [[junk, "XTO"], [fine, "FINE"]]) m.setMint({ mint, decimals: 6, tokenProgram: T22, name: s, symbol: s, onchainAt: 1 });
  const j = m.mapRef(m.get(junk), true), f = m.mapRef(m.get(fine), true);
  near(j.mcapUsd, 1e9);
  assert.equal(j.mcapCapUsd, LIQ_X, "LIQ_X × $1 of pool quote");
  assert.equal(m.view(m.get(junk)).mcapCapUsd, LIQ_X);
  near(f.mcapUsd, 3_000, 0.001); // 30 SOL virtual / 1e9 tokens × 1e9 × $100
  assert.ok(!("mcapCapUsd" in f), "uncapped: the field is absent");
  assert.ok(!("mcapCapUsd" in m.view(m.get(fine))));
  assert.equal(valueOf(j, "mcap"), LIQ_X);
  assert.equal(valueOf(f, "mcap"), f.mcapUsd);
  const ix = new Indexer({ rpc: {}, model: m, meta: null, hub: { emit() {} }, log: quiet });
  const d = ix.flushMapDelta();
  const dj = d.updated.find((e) => e.mint === junk), df = d.updated.find((e) => e.mint === fine);
  assert.equal(dj.mcapCapUsd, LIQ_X); assert.equal(df.mcapCapUsd, null, "a delta clears a cap with null");
});
