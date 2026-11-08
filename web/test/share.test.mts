// Share texts (DESIGN §8 "Share cards"): the sentence a user posts on X from the map's side panel, the
// coin page and the launch success screen. The link unfurls as the coin's card, so the text has to say
// what the card cannot: where the coin sits in its family. Pure, no DOM.
//
//   node --import tsx --test test/share.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHARE_MAX, coinPageShareText, coinShareText, launchShareText, mapLink, shareText, tick } from "../src/lib/map/share.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";
import type { Coin, CoinRef } from "../src/lib/api.ts";

const NOW = 1_800_000_000; // unix s
const node = (mint: string, parentMint: string | null, depth: number, o: Partial<BubbleNode> = {}): BubbleNode => ({
  mint, parentMint, depth, name: `${mint} coin`, symbol: mint.toUpperCase(), image: null, mcapUsd: 500, lockedUsd: null, children: 0, descendants: 0, migrated: false, ours: false, createdAt: NOW - 30 * 86_400, ...o,
});
// pump (listed asset, the family top) ─ cat (depth 0, quoted in PUMP) ─ kid ─ grandkid ; cat ─ kid2
const pump = node("pump", null, 0, { asset: true, children: 1, descendants: 4, lockedUsd: 120_000, mcapUsd: null });
const cat = node("cat", "pump", 0, { children: 2, descendants: 3, lockedUsd: 40_000, mcapUsd: 90_000 });
const kid = node("kid", "cat", 1, { children: 1, descendants: 1, lockedUsd: 5_200, mcapUsd: 12_000, createdAt: NOW - 1_800 });
const kid2 = node("kid2", "cat", 1, { mcapUsd: 800 });
const grandkid = node("grandkid", "kid", 2, { mcapUsd: 1_500 });
const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const ref = (n: BubbleNode): CoinRef => ({ mint: n.mint, name: n.name, symbol: n.symbol, image: n.image, depth: n.depth });
/// A /api/coin record with the fields the share text reads; the rest is filler the builder never touches.
const coinOf = (n: BubbleNode, parent: BubbleNode | null, root: BubbleNode | null): Coin => ({
  mint: n.mint, name: n.name, symbol: n.symbol, image: null, description: null, twitter: null, telegram: null, website: null,
  creator: MINT, quoteMint: parent?.mint ?? null, quoteSymbol: parent?.symbol ?? "SOL",
  depth: n.depth, parent: parent ? ref(parent) : null, root: root ? ref(root) : null, ancestors: [parent, root].filter((x): x is BubbleNode => !!x).map(ref),
  complete: false, migrated: false, pool: null, createdAt: n.createdAt ?? null, createdSlot: null,
  tokenProgram: "", decimals: 6, totalSupply: "0", priceQuote: null, priceSol: null, priceUsd: null, mcapSol: null, mcapUsd: n.mcapUsd, progress: 0,
  children: n.children, descendants: n.descendants ?? 0, lockedQuote: "0", lockedUsd: n.lockedUsd, volume24hUsd: 0, trades24h: 0,
  holderReward: false, creatorFeeBps: 0, shares: null, updatedAt: NOW,
});

/// No leaked placeholder ("—" is format()'s null, so "— locked" / "(— mcap)" must never appear; the dash
/// between the head and the facts is the sentence's own), within SHARE_MAX, no hashtag, no emoji.
const clean = (s: string) => {
  assert.ok(!/undefined|null|NaN|— (locked|mcap|child|coin)|\(— /.test(s), s);
  assert.ok(s.length <= SHARE_MAX, `${s.length} chars`);
  assert.ok(!/#|[\u{1F300}-\u{1FAFF}]/u.test(s), s);
};

test("a child: first child, parent, family, children and locked value", () => {
  const t = shareText(kid, cat, { root: pump, firstborn: true });
  assert.equal(t, "$KID, first child under $CAT in the $PUMP family — 1 child, $5.2K locked. Live family tree:");
  clean(t);
  // Not the firstborn: no claim. A parent that is the top itself: no family clause.
  assert.equal(shareText(kid, cat, { root: pump }), "$KID under $CAT in the $PUMP family — 1 child, $5.2K locked. Live family tree:");
  assert.equal(shareText(cat, pump, { root: pump, firstborn: true }), "$CAT, first child under $PUMP — 2 children, $40K locked. Live family tree:");
  // The root option equal to the parent or to self is ignored.
  assert.equal(shareText(cat, pump, { root: cat }), "$CAT under $PUMP — 2 children, $40K locked. Live family tree:");
});

test("a leaf without children or locked value shows its market cap; nothing known → no dash", () => {
  assert.equal(shareText(grandkid, kid, { root: pump }), "$GRANDKID under $KID in the $PUMP family — $1.5K mcap. Live family tree:");
  assert.equal(shareText({ ...kid2, mcapUsd: null }, cat, { root: pump }), "$KID2 under $CAT in the $PUMP family. Live family tree:");
  assert.equal(shareText({ ...kid2, mcapUsd: 0, lockedUsd: 0, children: 0 }, cat), "$KID2 under $CAT. Live family tree:");
});

test("a family top: coins under it, locked value and its dominance in the map's size mode", () => {
  assert.equal(shareText(pump, null, { root: pump, dominance: { share: 0.41, mode: "locked" } }), "$PUMP family on Spore — 4 coins under it, $120K locked, 41% of all locked value on the map. Live family tree:");
  assert.equal(shareText(pump, null, { dominance: { share: 0.0123, mode: "mcap" } }), "$PUMP family on Spore — 4 coins under it, $120K locked, 1.2% of market cap on the map. Live family tree:");
  // An unpriced family (share 0 / null) keeps no number; a top with one coin under it reads singular.
  assert.equal(shareText(pump, null, { dominance: { share: 0, mode: "locked" } }), "$PUMP family on Spore — 4 coins under it, $120K locked. Live family tree:");
  assert.equal(shareText(node("solo", null, 0, { children: 1, descendants: 1, lockedUsd: 2_000 }), null), "$SOLO family on Spore — 1 coin under it, $2K locked. Live family tree:");
});

test("a root with nothing under it says what it is for; an orphan child says only where it is", () => {
  assert.equal(shareText(node("new", null, 0, { mcapUsd: 12_000 }), null), "$NEW on Spore ($12K mcap) — a root new coins can launch under. Live family tree:");
  assert.equal(shareText(node("new", null, 0, { mcapUsd: null }), null), "$NEW on Spore — a root new coins can launch under. Live family tree:");
  assert.equal(shareText(node("orph", "gone", 2, { mcapUsd: 700 }), null), "$ORPH on Spore ($700.00 mcap). Live family tree:");
});

test("names: $TICKER, else a clipped name, else a short mint; a leading $ in the symbol is not doubled", () => {
  assert.equal(tick({ mint: MINT, symbol: "$PUMP" }), "$PUMP");
  assert.equal(tick({ mint: MINT, symbol: null, name: "A very long cat name that goes on and on" }), "A very long cat name th…");
  assert.equal(tick({ mint: MINT, symbol: null, name: "  " }), "7xKX…gAsU");
  const t = shareText({ ...kid, mint: MINT, symbol: null, name: null }, { ...cat, symbol: null, name: "A very long cat name that goes on and on" }, { root: { ...pump, symbol: "$PUMP" }, firstborn: true });
  assert.equal(t, "7xKX…gAsU, first child under A very long cat name th… in the $PUMP family — 1 child, $5.2K locked. Live family tree:");
  clean(t);
});

test("every text stays within SHARE_MAX, even with the longest names and counts", () => {
  const long = "X".repeat(60);
  const big = (mint: string, parentMint: string | null, depth: number) => node(mint, parentMint, depth, { symbol: long, name: long, children: 99_999, descendants: 999_999, lockedUsd: 987_654_321, mcapUsd: 123_456_789 });
  const texts = [
    shareText(big("a", "b", 2), big("b", "c", 1), { root: big("c", null, 0), firstborn: true, dominance: { share: 0.999, mode: "locked" } }),
    shareText(big("c", null, 0), null, { dominance: { share: 0.999, mode: "locked" } }),
    shareText(big("d", null, 0), null),
    launchShareText(long, { mint: "p", symbol: long }),
    launchShareText(long, null),
  ];
  for (const t of texts) { clean(t); assert.ok(/(Live family tree|Family tree):$/.test(t), t); }
  // Variants are dropped in order (family clause, then facts) before anything is cut.
  const f = { self: { mint: "a", symbol: long, depth: 2 }, parent: { mint: "b", symbol: long }, root: { mint: "c", symbol: long }, children: 99_999, lockedUsd: 987_654_321 };
  assert.ok(coinShareText(f).length <= SHARE_MAX);
  assert.ok(coinShareText(f).includes("locked"));
});

test("the coin page says the same thing as the map for the same coin", () => {
  assert.equal(coinPageShareText(coinOf(kid, cat, pump)), shareText(kid, cat, { root: pump }));
  assert.equal(coinPageShareText(coinOf(grandkid, kid, pump)), shareText(grandkid, kid, { root: pump }));
  // A depth-0 coin: the server view has no parent and no root; it reads as a top.
  assert.equal(coinPageShareText(coinOf(cat, null, null)), "$CAT family on Spore — 3 coins under it, $40K locked. Live family tree:");
  assert.equal(coinPageShareText(coinOf(node("new", null, 0, { mcapUsd: 3_000 }), null, null)), "$NEW on Spore ($3K mcap) — a root new coins can launch under. Live family tree:");
});

test("launch success: the creator's post names the parent every buy routes through", () => {
  assert.equal(launchShareText("KID", { mint: "cat", symbol: "CAT" }), "I just launched $KID under $CAT on Spore — every buy routes through $CAT. Family tree:");
  assert.equal(launchShareText("KID", { mint: MINT, symbol: null }), "I just launched $KID under 7xKX…gAsU on Spore — every buy routes through 7xKX…gAsU. Family tree:");
  assert.equal(launchShareText("ROOT", null), "I just launched $ROOT on Spore — a pump.fun root new coins can grow under. Family tree:");
  clean(launchShareText("KID", { mint: "cat", symbol: "CAT" }));
});

test("mapLink anchors a shared view by mint", () => {
  assert.equal(mapLink("Mint111", "https://sporepad.com/"), "https://sporepad.com/map?focus=Mint111");
  assert.equal(mapLink("Mint111", "http://127.0.0.1:5252"), "http://127.0.0.1:5252/map?focus=Mint111");
});
