// The Discover page (web/src/lib/discover.ts): the bars of a row, its words, the coins after "Leading", and the rows
// after a refresh (the open row stays). No DOM, no network (a fake fetch for the one request).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Discover, DiscoverParent } from "../src/lib/api.ts";
const { BARS, DISCOVER_POLL_MS, binsOf, barHeights, barsLabel, windowLabel, countWords, countLine, leading, discoverRows, creatorsNote, LEFT_SHORT, LEFT_NOTE } = await import("../src/lib/discover.ts");
const { api } = await import("../src/lib/api.ts");

const P1 = "Par1111111111111111111111111111111111111111", P2 = "Par2222222222222222222222222222222222222222", P3 = "Par3333333333333333333333333333333333333333";
const BINS = [0, 2, 5, 10, 40, 20, 10, 8, 0, 12, 24, 31];
const coin = (mint: string, symbol: string | null, usd24: number) => ({ mint, name: symbol, symbol, image: null, usd24 });
const parent = (mint: string, o: Partial<DiscoverParent> = {}): DiscoverParent =>
  ({ mint, name: "NVIDIA", symbol: "NVDAx", image: null, new1h: 250, creators1h: 90, bins: BINS, usd24: 108_000, top: [coin("K1", "JENSEN", 71_000), coin("K2", "HUANG", 37_000)], ...o });
const body = (parents: DiscoverParent[], o: Partial<Discover> = {}): Discover => ({ asOf: 1_763_400_000, windowS: 3600, binS: 300, parents, ...o });

test("1. binsOf: exactly twelve whole counts, oldest first; anything else reads as 0", () => {
  assert.equal(BARS, 12);
  assert.deepEqual(binsOf(BINS), BINS);
  assert.deepEqual(binsOf([3, 1]), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 1], "a short list is padded on the old side");
  assert.deepEqual(binsOf([9, 9, ...BINS]), BINS, "a long list keeps its newest bins");
  assert.deepEqual(binsOf([1.9, -4, NaN, "7", null, Infinity, 2]), [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2]);
  for (const bad of [null, undefined, "x", 5, {}]) assert.deepEqual(binsOf(bad), new Array(12).fill(0));
});

test("2. barHeights: the tallest bin is the full height, an empty bin 0, all 0 for a strip without launches", () => {
  const h = barHeights(BINS);
  assert.equal(h.length, 12);
  assert.equal(h[4], 1);
  assert.equal(h[5], 0.5);
  assert.equal(h[0], 0);
  assert.equal(h[11], 31 / 40);
  assert.ok(h.every((x) => x >= 0 && x <= 1));
  assert.deepEqual(barHeights([0, 0, 0]), new Array(12).fill(0));
  assert.deepEqual(barHeights(undefined), new Array(12).fill(0));
  assert.deepEqual(barHeights([7]).slice(-2), [0, 1], "one bin with launches: that bar is full");
});

test("3. the row's words: \"250 new coins · 1h\"", () => {
  assert.equal(countLine(parent(P1)), "250 new coins · 1h");
  assert.equal(countLine(parent(P1), 3600), "250 new coins · 1h");
  assert.equal(countLine(parent(P1, { new1h: 1 })), "1 new coin · 1h");
  assert.equal(countLine(parent(P1, { new1h: 2500 }), 1800), "2,500 new coins · 30m");
  assert.equal(countWords({ new1h: 1 }), "new coin");
  assert.equal(countWords({ new1h: 2 }), "new coins");
  assert.deepEqual([3600, 7200, 1800, 0, null, undefined].map(windowLabel), ["1h", "2h", "30m", "1h", "1h", "1h"]);
});

test("4. barsLabel: the strip in words", () => {
  assert.equal(barsLabel(parent(P1), 300, 3600), "250 new coins in the last hour, 31 in the last 5 minutes, at most 40 in 5 minutes");
  assert.equal(barsLabel(parent(P1)), "250 new coins in the last hour, 31 in the last 5 minutes, at most 40 in 5 minutes");
  assert.equal(barsLabel({ new1h: 2, bins: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }, 60, 720), "2 new coins in the last 12m, 1 in the last 1 minute, at most 1 in 1 minute");
  assert.equal(barsLabel({ new1h: 2, bins: null }), "2 new coins in the last hour, 0 in the last 5 minutes, at most 0 in 5 minutes");
});

test("5. leading: at most two coins that traded, as the server ordered them, each with its 24 h volume", () => {
  assert.deepEqual(leading(parent(P1)), [{ mint: "K1", sym: "$JENSEN", vol: "$71K" }, { mint: "K2", sym: "$HUANG", vol: "$37K" }]);
  assert.deepEqual(leading(parent(P1, { top: [coin("K1", "A", 5), coin("K2", "B", 4), coin("K3", "C", 3)] })).map((c) => c.sym), ["$A", "$B"]);
  assert.deepEqual(leading(parent(P1, { top: [coin("K1", "A", 0), coin("K2", "B", 12.5)] })), [{ mint: "K2", sym: "$B", vol: "$12.50" }], "a coin without volume is not a leader");
  assert.deepEqual(leading(parent(P1, { top: [coin("Abcdefghijklmnop", null, 9)] }))[0].sym, "Abcd…mnop");
  assert.deepEqual(leading(parent(P1, { top: [] })), []);
  assert.deepEqual(leading({ top: undefined as unknown as DiscoverParent["top"] }), []);
});

test("6. discoverRows: the fresh list in the server's order", () => {
  const rows = discoverRows(body([parent(P2), parent(P1), parent(P3)]), [parent(P1), parent(P2)], null);
  assert.deepEqual(rows.map((r) => r.mint), [P2, P1, P3]);
  assert.ok(rows.every((r) => !r.left));
  // a repeated or broken entry does not make two rows with one key
  assert.deepEqual(discoverRows(body([parent(P1), parent(P1), null as unknown as DiscoverParent, {} as DiscoverParent, parent(P2)]), [], null).map((r) => r.mint), [P1, P2]);
  for (const none of [null, undefined, body([]), { asOf: 1 } as unknown as Discover]) assert.deepEqual(discoverRows(none, [parent(P1)], null), []);
});

test("7. discoverRows: the open row stays open when its rank moves, and stays on screen when its parent leaves the list", () => {
  const shown = [parent(P1, { new1h: 250 }), parent(P2, { new1h: 90 })];
  // P1 open and overtaken: same rows by mint, fresh numbers, nothing marked
  const moved = discoverRows(body([parent(P2, { new1h: 300 }), parent(P1, { new1h: 260 })]), shown, P1);
  assert.deepEqual(moved.map((r) => [r.mint, r.new1h, !!r.left]), [[P2, 300, false], [P1, 260, false]]);
  // P1 open and no longer listed: kept at the end with its last numbers, marked
  const left = discoverRows(body([parent(P2), parent(P3)]), shown, P1);
  assert.deepEqual(left.map((r) => [r.mint, !!r.left]), [[P2, false], [P3, false], [P1, true]]);
  assert.equal(left[2].new1h, 250);
  assert.equal(shown[0].left, undefined, "the input is not changed");
  // still not listed on the next refresh: it stays; listed again: a normal row
  assert.deepEqual(discoverRows(body([parent(P2)]), left, P1).map((r) => [r.mint, !!r.left]), [[P2, false], [P1, true]]);
  assert.deepEqual(discoverRows(body([parent(P1), parent(P2)]), left, P1).map((r) => [r.mint, !!r.left]), [[P1, false], [P2, false]]);
  // an empty list keeps the open row alone; a row that is not open goes with the list
  assert.deepEqual(discoverRows(body([]), shown, P2).map((r) => r.mint), [P2]);
  assert.deepEqual(discoverRows(body([parent(P3)]), left, null).map((r) => r.mint), [P3]);
  assert.deepEqual(discoverRows(body([parent(P3)]), shown, "Unknown").map((r) => r.mint), [P3]);
});

test("8. the wording stays neutral: no line says why anything trades or what to do", () => {
  for (const l of [countLine(parent(P1)), barsLabel(parent(P1)), creatorsNote(parent(P1)) ?? "", LEFT_SHORT, LEFT_NOTE, ...leading(parent(P1)).map((c) => `${c.sym} ${c.vol}`)]) {
    assert.doesNotMatch(l, /because|why|reason|driv|caus|thanks to|due to|moon|buy|sell|should|predict|expect|will|hot|trend/i, l);
  }
});

test("9. api.discover: one GET of /api/discover; the page reads it every 15 s", async () => {
  assert.equal(DISCOVER_POLL_MS, 15_000);
  const urls: string[] = [], was = globalThis.fetch;
  let status = 200;
  globalThis.fetch = (async (url: string) => { urls.push(url); return new Response(JSON.stringify(status === 200 ? body([parent(P1)]) : { error: "not found" }), { status, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const d = await api.discover();
    assert.deepEqual([d.parents.length, d.windowS, d.binS], [1, 3600, 300]);
    assert.deepEqual(urls, ["/api/discover"]);
    // a server without the route: the page shows its error box with Retry
    status = 404;
    await assert.rejects(api.discover(), /not found/);
    assert.equal(urls.length, 2, "a 404 is not retried");
  } finally { globalThis.fetch = was; }
});

test("10. discoverRows in use: no row moves; numbers change in place, a new parent goes to the end, one that left stays, marked", () => {
  const shown = [parent(P1, { new1h: 41 }), parent(P2, { new1h: 40 }), parent(P3, { new1h: 12 })];
  // P2 overtakes P1: idle the rows swap, in use they keep their places and take the new numbers
  const fresh = body([parent(P2, { new1h: 44 }), parent(P1, { new1h: 42 }), parent(P3, { new1h: 12 })]);
  assert.deepEqual(discoverRows(fresh, shown, null).map((r) => [r.mint, r.new1h]), [[P2, 44], [P1, 42], [P3, 12]]);
  assert.deepEqual(discoverRows(fresh, shown, null, true).map((r) => [r.mint, r.new1h, !!r.left]), [[P1, 42, false], [P2, 44, false], [P3, 12, false]]);
  // a parent new to the list, even at rank 1, is appended; new ones keep the server's order among themselves
  const N1 = "New1111111111111111111111111111111111111111", N2 = "New2222222222222222222222222222222222222222";
  const grown = discoverRows(body([parent(N1, { new1h: 99 }), parent(P3), parent(N2), parent(P1), parent(P2)]), shown, P2, true);
  assert.deepEqual(grown.map((r) => r.mint), [P1, P2, P3, N1, N2]);
  // a parent that left keeps its place and its last numbers, marked, whether or not it is the open row
  const gone = discoverRows(body([parent(P3, { new1h: 13 }), parent(P1, { new1h: 43 })]), shown, null, true);
  assert.deepEqual(gone.map((r) => [r.mint, r.new1h, !!r.left]), [[P1, 43, false], [P2, 40, true], [P3, 13, false]]);
  assert.equal(shown[1].left, undefined, "the input is not changed");
  // still gone on the next read: it stays; listed again: a normal row in the same place
  assert.deepEqual(discoverRows(body([parent(P3), parent(P1)]), gone, null, true).map((r) => [r.mint, !!r.left]), [[P1, false], [P2, true], [P3, false]]);
  assert.deepEqual(discoverRows(body([parent(P2, { new1h: 50 }), parent(P3), parent(P1)]), gone, null, true).map((r) => [r.mint, r.new1h, !!r.left]), [[P1, 250, false], [P2, 50, false], [P3, 250, false]]);
  // a failed or empty read in use keeps every row (marked); a repeated entry makes one row
  assert.deepEqual(discoverRows(body([]), shown, null, true).map((r) => [r.mint, !!r.left]), [[P1, true], [P2, true], [P3, true]]);
  assert.deepEqual(discoverRows(body([parent(P1), parent(P1), parent(N1), parent(N1)]), [parent(P1)], null, true).map((r) => r.mint), [P1, N1]);
});

test("11. discoverRows, idle again: the server's order is applied and the rows that left go (the open one stays last)", () => {
  const N1 = "New1111111111111111111111111111111111111111";
  const held = [parent(P1), { ...parent(P2), left: true }, parent(P3), parent(N1)];
  const last = body([parent(N1), parent(P3), parent(P1)]);
  assert.deepEqual(discoverRows(last, held, null).map((r) => [r.mint, !!r.left]), [[N1, false], [P3, false], [P1, false]]);
  assert.deepEqual(discoverRows(last, held, P2).map((r) => [r.mint, !!r.left]), [[N1, false], [P3, false], [P1, false], [P2, true]]);
});

test("12. creatorsNote and the words of a row that left the list", () => {
  assert.equal(creatorsNote(parent(P1, { creators1h: 90 })), "Launched by 90 creators");
  assert.equal(creatorsNote(parent(P1, { creators1h: 1 })), "Launched by 1 creator");
  assert.equal(creatorsNote(parent(P1, { creators1h: 1234.7 })), "Launched by 1,234 creators");
  for (const n of [0, -1, NaN, null, undefined, "9"]) assert.equal(creatorsNote({ creators1h: n as unknown as number }), null);
  assert.equal(LEFT_SHORT, "no longer listed");
  assert.match(LEFT_NOTE, /^No longer in the list\./);
});
