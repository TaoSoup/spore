// The Discover page's view logic added with the Nov 20 review (web/src/lib/discover.ts): the fold by current activity,
// the folded line, the chart's series on the ratio's basis, the breadth and flow lines, the older-post wording, the new
// wake-up notice while the list is held, and Trending's rank, sort, same-ticker fold, row identity and words.
// Every server field these read is optional: an older server's body must still render. No DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoinRow, TrendRow, WakeFamily, WakePost } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");

const NOW = 1_763_500_000;
const P1 = "Par1", P2 = "Par2", P3 = "Par3";
const coin = (mint: string, o: Partial<CoinRow> = {}): CoinRow => ({
  mint, name: "Fiona", symbol: "FIONA", image: null, createdAt: NOW - 86400, existing: true, mcapUsd: 100_000, priceUsd: 0.0001, sinceStart: null, buyers5m: 12,
  tf: { p0: 0.00008, chg: 25, volUsd: 5_000, buys: 40, sells: 10, buyers: 30 }, liqUsd: 20_000, ...o,
});
const fam = (mint: string, o: Partial<WakeFamily> = {}): WakeFamily => ({
  parent: { mint, name: "NVIDIA", symbol: "NVDAx", image: null, isCoin: false }, startedAt: NOW - 4 * 60, state: "live", ratio: 14.2, peakRatio: 14.2,
  buyers5m: 170, trades5m: 570, spark: [...new Array(22).fill(4), 60, 170], baseline: 12.3, coinsTrading: 12, post: null, coins: [coin("K1")], more: 8, hidden: 23, ...o,
});
const tr = (mint: string, o: Partial<TrendRow> = {}): TrendRow => ({ ...coin(mint), parent: { mint: "PAR", symbol: "TTWO", image: null }, family: null, ...o });
const post = (o: Partial<WakePost> = {}): WakePost => ({ id: "1990000000000000001", url: "https://x.example/x", at: NOW - 30 * 60, handle: "fiona", text: "hello", state: "ok", coins: 4, lead: 6 * 60, ...o });

test("1. a card folds only when cooling AND under 3x; the fold is kept as shown while the list is in use", () => {
  assert.equal(D.LIVE_RATIO, 3);
  assert.equal(D.foldable(fam(P1)), false, "live");
  assert.equal(D.foldable(fam(P1, { state: "cooling", ratio: 21.3 })), false, "cooling by age but still at 21x: the full card");
  assert.equal(D.foldable(fam(P1, { state: "cooling", ratio: 3 })), false);
  assert.equal(D.foldable(fam(P1, { state: "cooling", ratio: 2.9 })), true);
  assert.equal(D.foldable(fam(P1, { state: "cooling", ratio: 0 })), true);
  assert.equal(D.foldable({ state: "cooling" }), true, "no ratio: folds as before");
  assert.equal(D.isFolded(fam(P1, { state: "cooling", ratio: 1 }), true), false, "opened by the reader");
  // held: the ratio falls under 3x under the pointer, the card stays whole; idle again it folds
  const shown = D.familyRows({ families: [fam(P1, { state: "cooling", ratio: 8 })] }, []);
  assert.equal(D.isFolded(shown[0], false), false);
  const held = D.familyRows({ families: [fam(P1, { state: "cooling", ratio: 1.2 })] }, shown, true);
  assert.equal(held[0].ratio, 1.2, "the fresh number");
  assert.equal(D.isFolded(held[0], false), false, "not folded under a resting pointer");
  assert.equal(D.isFolded(D.familyRows({ families: [fam(P1, { state: "cooling", ratio: 0.4 })] }, held, true)[0], false), false, "still held");
  assert.equal(D.isFolded(D.familyRows({ families: [fam(P1, { state: "cooling", ratio: 1.2 })] }, held, false)[0], false), true);
  // and the other way: a folded line does not open by itself while held
  const line = D.familyRows({ families: [fam(P2, { state: "cooling", ratio: 1 })] }, []);
  assert.equal(D.isFolded(D.familyRows({ families: [fam(P2, { state: "cooling", ratio: 9 })] }, line, true)[0], false), true);
  // the coins of a cooling card at 3x or more are on screen, so their trades are followed
  const fams = [{ parent: { mint: P1 }, state: "cooling", ratio: 5, coins: [{ mint: "A" }] }, { parent: { mint: P2 }, state: "cooling", ratio: 1, coins: [{ mint: "B" }] }];
  assert.deepEqual([...D.screenMints(fams, null)], ["A"]);
});

test("2. the first load opens the first family only when every card would be a folded line", () => {
  const cold = (m: string) => fam(m, { state: "cooling", ratio: 0.8 });
  assert.equal(D.firstOpen([cold(P1), cold(P2)]), P1);
  assert.equal(D.firstOpen([cold(P1), fam(P2)]), null, "a card is already open");
  assert.equal(D.firstOpen([cold(P1), fam(P2, { state: "cooling", ratio: 4 })]), null);
  assert.equal(D.firstOpen([]), null);
});

test("3. the folded line puts the current numbers first, the peak last", () => {
  const f = fam(P1, { parent: { mint: P1, name: "SQQQ", symbol: "SQQQ", image: null, isCoin: true }, state: "cooling", ratio: 1.8, buyers5m: 22, startedAt: NOW - 34 * 60, peakRatio: 6.3 });
  assert.equal(D.coolingLine(f, NOW), "$SQQQ · cooling · 1.8x now · 22 buyers / 5 min · started 34 min ago · peak 6.3x");
  assert.equal(D.coolingLine({ ...f, ratio: 0, buyers5m: 0 }, NOW), "$SQQQ · cooling · no buying in 5 min · started 34 min ago · peak 6.3x");
  assert.equal(D.coolingLine({ ...f, ratio: 0, buyers5m: 7 }, NOW), "$SQQQ · cooling · 7 buyers / 5 min · started 34 min ago · peak 6.3x", "buyers in new launches only: no ratio");
  assert.equal(D.coolingLine({ parent: f.parent, startedAt: f.startedAt, peakRatio: 0 }, NOW), "$SQQQ · cooling · started 34 min ago");
});

// What this can check is which series is drawn and what the words say. It does not check "last point / band equals
// the printed ratio": the last point is the last complete bucket and the ratio the 5 minutes to now, so the server
// delivers that only just after a bucket closes (fixtures P1-P3 are such a moment; `mid` is 100 s into a wake-up).
test("4. the chart draws one line, the existing-coin series when sent; its last point is not called \"now\"", () => {
  // a launch flurry: 536 buyers in all coins, 58 in existing ones on a normal of 63.6 (the USDC card: 8.4x drawn, 0.9x printed)
  const snapshot = [
    fam(P1, { ratio: 0.9, baseline: 63.6, buyers5m: 536, buyersEx5m: 58, spark: [...new Array(23).fill(80), 536], sparkEx: [...new Array(23).fill(60), 58] }),
    fam(P2, { ratio: 21.3, baseline: 2.4, buyers5m: 59, buyersEx5m: 51, spark: [...new Array(23).fill(2), 59], sparkEx: [...new Array(23).fill(2), 51] }),
    fam(P3, { ratio: 1.8, baseline: 10, buyers5m: 18, buyersEx5m: 18, spark: [...new Array(23).fill(9), 18], sparkEx: [...new Array(23).fill(9), 18] }),
  ];
  for (const f of snapshot) {
    const cs = D.chartSeries(f);
    assert.equal(cs.ex, true);
    assert.equal(cs.series, f.sparkEx, "the series of the band and the ratio, never the all-coin one");
    assert.equal(D.sparkGeom(cs.series, f.baseline, 600, 56).values[D.SPARK_POINTS - 1], f.sparkEx![23]);
  }
  // mid-bucket, as the server sends it: ratio 30 from the 5 minutes to now over a last closed bucket still at the
  // normal level. The line is drawn as sent and the words name the bucket, so neither claims to be the headline
  const mid = fam(P1, { ratio: 30, peakRatio: 30, baseline: 2, buyers5m: 64, buyersEx5m: 60, sparkEx: [...new Array(24).fill(2)] });
  assert.equal(D.sparkGeom(D.chartSeries(mid).series, mid.baseline, 600, 56).values[D.SPARK_POINTS - 1], 2);
  assert.match(D.sparkLabel(mid), /: 2 in the last complete 5 min, at most 2, /);
  assert.match(D.ratioLine(mid), /^Buying 30x its normal · 64 buyers in 5 min/);
  for (const f of [...snapshot, mid, fam(P1)]) assert.doesNotMatch(D.sparkLabel(f), /\bnow\b/);
  assert.equal(D.chartAxis(true), "buyers of existing coins per 5 min");
  assert.match(D.sparkLabel(snapshot[0]), /^Buyers of existing coins per 5 minutes over the last 2 hours: 58 in the last complete 5 min, at most 60, /);
  assert.match(D.familyChartLabel({ ...snapshot[0], sparkFrom: NOW - 24 * 300 }, 300, NOW), /^Buyers of existing coins per 5 minutes/);
  // an older server: no sparkEx, the all-coin series as before
  const old = fam(P1);
  assert.deepEqual(D.chartSeries(old), { series: old.spark, ex: false });
  assert.deepEqual(D.chartSeries({ ...old, sparkEx: [] }), { series: old.spark, ex: false });
  assert.equal(D.chartAxis(false), "buyers per 5 min");
  assert.match(D.sparkLabel(old), /^Buyers per 5 minutes over the last 2 hours: 170 in the last complete 5 min/);
});

test("5. the measured line keeps all-coin buyers and says how many were in existing coins when the two differ 1.5x", () => {
  assert.equal(D.ratioLine(fam(P1, { ratio: 5.2, buyers5m: 536, buyersEx5m: 58 })), "Buying 5.2x its normal · 536 buyers in 5 min (58 in existing coins) · 12 coins trading");
  assert.equal(D.ratioLine(fam(P1, { buyers5m: 170, buyersEx5m: 150 })), "Buying 14x its normal · 170 buyers in 5 min · 12 coins trading", "close: no split");
  assert.equal(D.ratioLine(fam(P1, { buyers5m: 150, buyersEx5m: 100 })), "Buying 14x its normal · 150 buyers in 5 min (100 in existing coins) · 12 coins trading", "exactly 1.5x");
  assert.equal(D.ratioLine(fam(P1)), "Buying 14x its normal · 170 buyers in 5 min · 12 coins trading", "an older server");
  assert.equal(D.ratioLine(fam(P1, { state: "cooling", ratio: 2.1, buyers5m: 500, buyersEx5m: 10 })), "Buying 2.1x its normal, down from 14x", "the cooling line is unchanged");
});

test("6. breadth: how many coins carry the buying, on live cards only, as a count", () => {
  assert.equal(D.breadthLine(fam(P1, { coins5: 5, topShare: 0.31 })), "5 coins with 5+ buyers each");
  assert.equal(D.breadthLine(fam(P1, { coins5: 3, topShare: 0.8 })), "3 coins with 5+ buyers each");
  assert.equal(D.breadthLine(fam(P1, { coins5: 1, topShare: 0.82, topMint: "K1", coins: [coin("K0", { symbol: "OTHER" }), coin("K1", { symbol: "TOP" })] })), "Mostly one coin: $TOP (82% of buyers)");
  assert.equal(D.breadthLine(fam(P1, { coins5: 1, topShare: 0.82 })), "Mostly one coin (82% of buyers)", "the server does not say which coin: none is named");
  assert.equal(D.breadthLine(fam(P1, { coins5: 1, topShare: 0.82, topMint: "HIDDEN" })), "Mostly one coin (82% of buyers)", "the coin is not listed");
  assert.equal(D.breadthLine(fam(P1, { coins5: 1, topShare: 1.4, topMint: "HIDDEN", topSymbol: "DUSTY" })), "Mostly one coin: $DUSTY (100% of buyers)", "named by the server's symbol");
  assert.equal(D.breadthLine(fam(P1, { coins5: 2, topShare: 0.69 })), null, "in between: no line");
  assert.equal(D.breadthLine(fam(P1, { coins5: 2, topShare: null })), null);
  assert.equal(D.breadthLine(fam(P1)), null, "an older server");
  assert.equal(D.breadthLine(fam(P1, { state: "cooling", coins5: 6, topShare: 0.9 })), null, "not on a cooling card");
});

test("7. bought / sold over 5 min, and the card's facts line", () => {
  assert.equal(D.flowLine({ bought5mUsd: 4_500, sold5mUsd: 3_600 }), "$4.5K bought / $3.6K sold, 5 min");
  assert.equal(D.flowLine({ bought5mUsd: 0, sold5mUsd: 120 }), "$0 bought / $120.00 sold, 5 min");
  for (const none of [{}, { bought5mUsd: 5 }, { bought5mUsd: 0, sold5mUsd: 0 }, { bought5mUsd: -1, sold5mUsd: 2 }, { bought5mUsd: NaN, sold5mUsd: 2 }]) assert.equal(D.flowLine(none), null);
  assert.equal(D.factsLine(fam(P1, { coins5: 4, topShare: 0.3, bought5mUsd: 4_500, sold5mUsd: 5_100 })), "4 coins with 5+ buyers each · $4.5K bought / $5.1K sold, 5 min");
  assert.equal(D.factsLine(fam(P1, { state: "cooling", coins5: 4, bought5mUsd: 10, sold5mUsd: 20 })), "$10.00 bought / $20.00 sold, 5 min", "the flow shows on a cooling card, the breadth does not");
  assert.equal(D.factsLine(fam(P1)), null, "an older server: no line");
});

test("8. an older post reads as one, with its date; a post around the start keeps its lead", () => {
  assert.equal(D.OLD_POST_S, 6 * 3600);
  assert.equal(D.postLead(post({ lead: 6 * 3600 }), null, NOW), "Posted 6 h before buying jumped", "exactly 6 h is not older");
  assert.equal(D.postLead(post({ lead: 9 * 3600, at: NOW - 10 * 3600 }), NOW - 3600, NOW), "Older post, posted 9 h before buying jumped");
  // Nov 18 2025 21:06 UTC is NOW; 6 days earlier is Nov 12
  assert.equal(D.postLead(post({ lead: 6 * 86400, at: NOW - 6 * 86400 }), NOW, NOW), "Older post, posted Nov 12");
  assert.equal(D.postLead(post({ lead: 914 * 86400, at: NOW - 914 * 86400 }), NOW, NOW), "Older post, posted May 2023");
  assert.equal(D.postLead(post({ lead: 30 * 86400, at: NOW - 30 * 86400, newCoins: 5 }), NOW, NOW), "Older post, posted Oct 19 · linked by 5 new coins");
  assert.equal(D.postLead(post({ lead: 30 * 86400, at: NOW - 30 * 86400, newCoins: 1 }), NOW, NOW), "Older post, posted Oct 19 · linked by 1 new coin");
  assert.equal(D.postLead(post({ lead: undefined, at: NOW - 3 * 86400 - 600 }), NOW - 600, NOW), "Older post, posted Nov 15", "an older server without lead");
  assert.equal(D.postLead(post({ lead: 3 * 86400, at: null }), null, NOW), "Older post, posted 3 days before buying jumped", "no time to date it by");
  assert.equal(D.postLead(post({ lead: 3 * 86400, at: null }), NOW - 86400, NOW), "Older post, posted Nov 14", "dated from the start and the lead");
  assert.equal(D.postLead(post({ lead: -8 * 3600 }), null, NOW), "Posted 8 h after buying jumped", "a later post is not an older one");
  assert.equal(D.postLead(post({ newCoins: 3 }), null, NOW), "Posted 6 min before buying jumped", "newCoins is only said on an older post");
  assert.equal(D.postDate(NOW - 299 * 86400, NOW), "Jan 23");
  assert.equal(D.postDate(NOW - 300 * 86400, NOW), "Jan 2025");
  // an older post is never inside the chart's 2 h, so it gets no mark
  assert.equal(D.chartMarks({ sparkFrom: NOW - 24 * 300, startedAt: NOW - 600, post: { at: NOW - 600 - D.OLD_POST_S - 1 } }, 300).post, null);
  assert.equal(D.postBlock(post({ lead: 40 * 86400, at: NOW - 40 * 86400, newCoins: 2 }), NOW, NOW).lead, "Older post, posted Oct 9 · linked by 2 new coins");
});

test("9. the chart's legend names only the marks drawn; the foot's count links to the map", () => {
  assert.deepEqual(D.markLegend({ start: 80, post: 70 }), [{ kind: "start", text: "buying jumped" }, { kind: "post", text: "linked post" }]);
  assert.deepEqual(D.markLegend({ start: 80, post: null }), [{ kind: "start", text: "buying jumped" }]);
  assert.deepEqual(D.markLegend({ start: null, post: null }), []);
  assert.deepEqual(D.footParts(37, 24, 2).map((p) => [p.text, !!p.map]), [["37 more trading", true], ["24 hidden: creator sold out or repeat launch", false], ["2 dust", false]]);
  assert.deepEqual(D.footParts(0, 24).map((p) => !!p.map), [false]);
});

test("10. held: a family not on screen or a card that turned live is named; cleared by what the server stops listing", () => {
  const shown = D.familyRows({ families: [fam(P1), fam(P2, { state: "cooling", ratio: 1 })] }, []);
  const sq = fam(P3, { parent: { mint: P3, name: "SQQQ", symbol: "SQQQ", image: null, isCoin: true } });
  assert.deepEqual(D.heldNews({ families: [fam(P1), fam(P2, { state: "cooling", ratio: 1 })] }, shown), [], "nothing new");
  const n1 = D.heldNews({ families: [sq, fam(P1), fam(P2, { state: "cooling", ratio: 1 })] }, shown);
  assert.deepEqual(n1, [{ key: P3, label: "$SQQQ" }]);
  assert.equal(D.newsText(n1), "1 new wake-up: $SQQQ");
  // the held merge puts it last; the next read still names it (it is pending), and the click's idle merge puts it first
  const held = D.familyRows({ families: [sq, fam(P1), fam(P2)] }, shown, true);
  assert.deepEqual(held.map((r) => r.parent.mint), [P1, P2, P3]);
  assert.deepEqual(D.heldNews({ families: [sq, fam(P1)] }, held, n1), [{ key: P3, label: "$SQQQ" }]);
  assert.deepEqual(D.heldNews({ families: [sq, fam(P1)] }, held, []), [], "on screen and not pending: not new");
  assert.deepEqual(D.familyRows({ families: [sq, fam(P1), fam(P2)] }, held, false).map((r) => r.parent.mint), [P3, P1, P2]);
  // a card that turned live while it is shown as cooling
  assert.deepEqual(D.heldNews({ families: [fam(P1), fam(P2, { state: "live" })] }, shown).map((n) => n.key), [P2]);
  // one marked as gone that the server lists again
  const cold2 = fam(P2, { state: "cooling", ratio: 1 });
  const gone = D.familyRows({ families: [cold2] }, shown, true);
  assert.deepEqual(D.heldNews({ families: [fam(P1), cold2] }, gone).map((n) => n.key), [P1]);
  // pending but no longer listed: dropped
  assert.deepEqual(D.heldNews({ families: [fam(P1)] }, held, n1), []);
  assert.deepEqual(D.heldNews(null, shown, n1), []);
  assert.equal(D.newsText([]), null);
  assert.equal(D.newsText([{ key: "a", label: "$A" }, { key: "b", label: "$B" }, { key: "c", label: "$C" }, { key: "d", label: "$D" }]), "4 new wake-ups: $A, $B +2");
  // the bar's word
  assert.equal(D.listStatus({ error: null, hasRows: true, paused: true }), "Order paused while you're here");
  assert.equal(D.listStatus({ error: "HTTP 502", hasRows: true, paused: true }), "Reconnecting", "only when a poll failed");
  assert.equal(D.listStatus({ error: "HTTP 502", hasRows: true, paused: false, stale: true }), "", "a failed first read of a timeframe has its own line");
  assert.equal(D.listStatus({ error: "HTTP 502", hasRows: false, paused: false }), "", "no list yet: the error box says it");
  assert.equal(D.listStatus({ error: null, hasRows: true, paused: false }), "");
});

test("11. the view in the address: valid ?tab= and ?tf= only", () => {
  assert.deepEqual(D.urlPrefs("?tab=trending&tf=1h"), { tab: "trending", tf: "1h" });
  assert.deepEqual(D.urlPrefs("tab=waking"), { tab: "waking", tf: null });
  assert.deepEqual(D.urlPrefs("?tab=coins&tf=2h&x=1"), { tab: null, tf: null });
  for (const none of ["", null, undefined]) assert.deepEqual(D.urlPrefs(none), { tab: null, tf: null });
});

test("12. Trending rows carry the server's rank; a column sorts the rows received and the choice holds over reads", () => {
  const body = { rows: [tr("A", { symbol: "AA", mcapUsd: 5_000, liqUsd: 900 }), tr("B", { symbol: "BB", mcapUsd: 90_000, liqUsd: null }), tr("C", { symbol: "CC", mcapUsd: null, liqUsd: 4_000, tf: { p0: 1, chg: 0, volUsd: 1, buys: 1, sells: 0, buyers: 99 } })] };
  const rows = D.trendRows(body, []);
  assert.deepEqual(rows.map((r) => [r.mint, r.rank]), [["A", 1], ["B", 2], ["C", 3]]);
  assert.deepEqual(D.sortTrend(rows, "mcap").map((r) => r.mint), ["B", "A", "C"], "unknown last");
  assert.deepEqual(D.sortTrend(rows, "liq").map((r) => r.mint), ["C", "A", "B"]);
  assert.deepEqual(D.sortTrend(rows, "buyers").map((r) => r.mint), ["C", "A", "B"], "ties by rank");
  assert.deepEqual(D.sortTrend(D.sortTrend(rows, "mcap"), "rank").map((r) => r.mint), ["A", "B", "C"], "back to the list's own order");
  assert.deepEqual(rows.map((r) => r.mint), ["A", "B", "C"], "the input is not changed");
  // an idle read comes back in the chosen sort, with each row's rank from the server's order
  const next = D.trendRows({ rows: [body.rows[2], body.rows[0], body.rows[1]] }, rows, false, "mcap");
  assert.deepEqual(next.map((r) => [r.mint, r.rank]), [["B", 3], ["A", 2], ["C", 1]]);
  // held: places stay whatever the sort, ranks are fresh
  assert.deepEqual(D.trendRows({ rows: [body.rows[2], body.rows[0], body.rows[1]] }, rows, true, "mcap").map((r) => [r.mint, r.rank]), [["A", 2], ["B", 3], ["C", 1]]);
});

test("13. copies of a ticker under one parent fold under the first; another parent keeps its row; a far larger copy is never hidden", () => {
  const rows = D.trendRows({ rows: [
    tr("A1", { symbol: "BIGFOOT", mcapUsd: 40_000 }), tr("X", { symbol: "OTHER" }), tr("A2", { symbol: " bigfoot ", mcapUsd: 90_000 }),
    tr("S1", { symbol: "BIGFOOT", parent: null, mcapUsd: 7_000_000 }), tr("A3", { symbol: "Bigfoot", mcapUsd: null }),
  ] }, []);
  assert.deepEqual(rows.map((r) => [r.mint, r.under ?? null]), [["A1", null], ["X", null], ["A2", "A1"], ["S1", null], ["A3", "A1"]]);
  const key = D.groupKey(rows[0])!;
  assert.equal(key, "bigfoot|PAR");
  assert.equal(D.groupKey(rows[3]), null, "a row without a parent has no group");
  assert.equal(D.groupKey({ symbol: " ", parent: null }), null);
  const closed = D.trendItems(rows, new Set());
  assert.deepEqual(closed.map((i) => i.row.mint), ["A1", "X", "S1"]);
  assert.deepEqual(closed[0].group, { key, n: 2, largest: 90_000, open: false });
  assert.equal(D.groupChip(closed[0].group!), "+2 same ticker · largest $90K");
  assert.equal(closed[1].group, null);
  // opened: the copies in place after their leader, and it stays open over a read (the key is ticker + parent)
  const open = D.trendItems(rows, new Set([key]));
  assert.deepEqual(open.map((i) => [i.row.mint, i.copy]), [["A1", false], ["A2", true], ["A3", true], ["X", false], ["S1", false]]);
  assert.equal(D.groupChip(open[0].group!), "Hide 2 same ticker");
  const again = D.trendRows({ rows: [tr("A1", { symbol: "BIGFOOT", mcapUsd: 41_000 }), tr("A2", { symbol: "bigfoot", mcapUsd: 80_000 })] }, rows, false);
  assert.deepEqual(D.trendItems(again, new Set([key])).map((i) => i.row.mint), ["A1", "A2"]);
  // no copy above the leader: the chip gives the count alone
  const small = D.trendItems(D.trendRows({ rows: [tr("A1", { symbol: "T", mcapUsd: 9_000 }), tr("A2", { symbol: "T", mcapUsd: 2_000 })] }, []), new Set());
  assert.equal(D.groupChip(small[0].group!), "+1 same ticker");
  // a copy 10x or more above the shown row (or a shown row of unknown size): the group is not folded
  for (const lead of [700_000, null]) {
    const big = D.trendRows({ rows: [tr("A1", { symbol: "T", mcapUsd: lead }), tr("A2", { symbol: "T", mcapUsd: 7_000_000 })] }, []);
    assert.deepEqual(big.map((r) => r.under ?? null), [null, null]);
    assert.deepEqual(D.trendItems(big, new Set()).map((i) => i.row.mint), ["A1", "A2"]);
  }
  assert.deepEqual(D.trendRows({ rows: [tr("A1", { symbol: "T", mcapUsd: 700_001 }), tr("A2", { symbol: "T", mcapUsd: 7_000_000 })] }, []).map((r) => r.under ?? null), [null, "A1"], "just under 10x folds");
  // the leader is the first in the chosen order
  assert.deepEqual(D.trendRows({ rows: [tr("A1", { symbol: "T", mcapUsd: 9_000 }), tr("A2", { symbol: "T", mcapUsd: 20_000 })] }, [], false, "mcap").map((r) => [r.mint, r.under ?? null]), [["A2", null], ["A1", "A2"]]);
});

test("13b. two roots with one ticker share no parent and are never folded; a kept mint stays in sight", () => {
  // both priced in SOL (parent: null from the server), each its own root
  const rows = D.trendRows({ rows: [tr("ROOT1", { symbol: "TRUMP", parent: null, mcapUsd: 40_000 }), tr("ROOT2", { symbol: "trump", parent: null, mcapUsd: 9_000 }), tr("C1", { symbol: "TRUMP" }), tr("C2", { symbol: "TRUMP", mcapUsd: 5_000 })] }, []);
  assert.deepEqual(rows.map((r) => [r.mint, r.under ?? null]), [["ROOT1", null], ["ROOT2", null], ["C1", null], ["C2", "C1"]]);
  const items = D.trendItems(rows, new Set());
  assert.deepEqual(items.map((i) => [i.row.mint, i.group?.n ?? 0]), [["ROOT1", 0], ["ROOT2", 0], ["C1", 1]]);
  for (const p of [null, undefined, {}, { mint: "" }, { mint: 7 }]) assert.equal(D.groupKey({ symbol: "TRUMP", parent: p as never }), null);
  // all four still carry the mint's start: the ticker repeats on screen
  assert.equal(D.repeatedSyms(rows).has("trump"), true);
  // a row showing why it cannot be bought (keep) is not folded under a new, higher copy; the other copy still is
  const body = { rows: [tr("NEW", { symbol: "dog" }), tr("A", { symbol: "DOG" }), tr("B", { symbol: "Dog" })] };
  assert.deepEqual(D.trendRows(body, [], false).map((r) => [r.mint, r.under ?? null]), [["NEW", null], ["A", "NEW"], ["B", "NEW"]]);
  const kept = D.trendRows(body, [], false, "rank", new Set(["A"]));
  assert.deepEqual(kept.map((r) => [r.mint, r.under ?? null]), [["NEW", null], ["A", null], ["B", "NEW"]]);
  assert.deepEqual(D.trendItems(kept, new Set()).map((i) => i.row.mint), ["NEW", "A"]);
  assert.deepEqual(D.foldTickers(D.sortTrend(kept, "mcap"), new Set(["A", "B"])).map((r) => r.under ?? null), [null, null, null], "the header's sort keeps them too");
  // a kept leader still leads its group
  assert.deepEqual(D.trendRows(body, [], false, "rank", new Set(["NEW"])).map((r) => r.under ?? null), [null, "NEW", "NEW"]);
});

test("14. held: the fold on screen stays; a new copy goes last as its own row; a copy whose leader left the list is shown", () => {
  const shown = D.trendRows({ rows: [tr("A1", { symbol: "T", mcapUsd: 9_000 }), tr("B", { symbol: "U" }), tr("A2", { symbol: "T", mcapUsd: 8_000 })] }, []);
  // under the pointer the copy grows past 10x: the group does not open by itself
  const held = D.trendRows({ rows: [tr("A1", { symbol: "T", mcapUsd: 9_000 }), tr("A2", { symbol: "T", mcapUsd: 900_000 }), tr("A9", { symbol: "T", mcapUsd: 1 }), tr("B", { symbol: "U" })] }, shown, true);
  assert.deepEqual(held.map((r) => [r.mint, r.under ?? null]), [["A1", null], ["B", null], ["A2", "A1"], ["A9", null]]);
  assert.deepEqual(D.trendItems(held, new Set()).map((i) => i.row.mint), ["A1", "B", "A9"]);
  // idle again: grouped afresh (the 10x rule now leaves this group open)
  assert.deepEqual(D.trendItems(D.trendRows({ rows: [tr("A1", { symbol: "T", mcapUsd: 9_000 }), tr("A2", { symbol: "T", mcapUsd: 900_000 })] }, held, false), new Set()).map((i) => i.row.mint), ["A1", "A2"]);
  // a row whose leader is not in the list is never lost
  assert.deepEqual(D.trendItems([{ ...tr("A2"), under: "GONE" }], new Set()).map((i) => [i.row.mint, i.copy]), [["A2", false]]);
  // the header's sort re-folds what is on screen
  assert.deepEqual(D.foldTickers(D.sortTrend(shown, "mcap")).map((r) => [r.mint, r.under ?? null]), [["B", null], ["A1", null], ["A2", "A1"]]);
});

test("15. row identity: the mint's start on a repeated ticker, the name only when it differs, an age for every row", () => {
  const dups = D.repeatedSyms([{ symbol: "PEPE" }, { symbol: " pepe" }, { symbol: "DOGE" }, { symbol: null }, { symbol: "" }, null]);
  assert.deepEqual([...dups], ["pepe"]);
  assert.equal(dups.has(D.normSym("Pepe ")), true);
  assert.equal(D.repeatedSyms(null).size, 0);
  assert.equal(D.mintPrefix("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), "7xKX");
  assert.equal(D.nameIfDiffers({ name: "Fiona the cat", symbol: "FIONA" }), "Fiona the cat");
  for (const same of [{ name: "fiona", symbol: "FIONA" }, { name: " $FIONA ", symbol: "fiona" }, { name: null, symbol: "X" }, { name: "  ", symbol: "X" }]) assert.equal(D.nameIfDiffers(same), null);
  assert.deepEqual(D.rowAge({ createdAt: NOW - 45 }, NOW), { text: "45s", title: "Age" });
  assert.equal(D.rowAge({ createdAt: NOW - 3 * 3600 - 5 }, NOW).text, "3h");
  assert.equal(D.rowAge({ createdAt: NOW - 2 * 86400 }, NOW).text, "2d");
  assert.deepEqual(D.rowAge({ createdAt: null, firstSeenAt: NOW - 40 * 60 - 20 }, NOW), { text: "seen 40m+", title: "Launch not seen; counted from the first trade we stored" });
  assert.deepEqual(D.rowAge({ createdAt: null }, NOW), { text: "—", title: "Age unknown: the launch was not seen" }, "an older server");
  assert.equal(D.rowAge({ createdAt: NOW - 60, firstSeenAt: NOW - 9000 }, NOW).text, "1m", "a known launch wins");
});

test("16. Buyers shows who has not sold; Trending says what it is ranked by and the 1m floor", () => {
  const t = { p0: 1, chg: 0, volUsd: 1, buys: 200, sells: 90, buyers: 151 };
  assert.deepEqual(D.buyersCell({ ...t, holding: 96 }, "5m"), { n: "151", sub: "96 not sold", title: "Wallets that bought $1 or more over 5m; 96 of them have not sold it since their first buy in that time" });
  assert.deepEqual(D.buyersCell({ ...t, holding: 0 }, "1h").sub, "0 not sold");
  assert.deepEqual(D.buyersCell(t, "5m"), { n: "151", sub: null, title: "Wallets that bought $1 or more over 5m" }, "an older server");
  assert.deepEqual(D.buyersCell(undefined, "5m").n, "—");
  assert.equal(D.trendingSub("5m", true), "Coins by wallets that bought in the last 5 min and have not sold since");
  assert.equal(D.trendingSub("5m"), "Coins by how many wallets bought them in the last 5 min");
  // a column sort: the line (and the list's label) says that order, not the server's rank
  assert.equal(D.trendingSub("5m", true, "rank"), D.trendingSub("5m", true));
  assert.equal(D.trendingSub("5m", true, "mcap"), "Coins bought in the last 5 min, sorted by market cap, largest first");
  assert.equal(D.trendingSub("1h", false, "liq"), "Coins bought in the last hour, sorted by liquidity, largest first");
  assert.equal(D.trendingSub("1m", true, "buyers"), "Coins bought in the last minute, sorted by buyers in that time, largest first");
  for (const s of ["buyers", "mcap", "liq"] as const) assert.doesNotMatch(D.trendingSub("5m", true, s), /not sold/);
  assert.equal(D.floorLine({ floor: 5, candidates: 14 }, "1m"), "14 coins with 5+ buyers in the last minute");
  assert.equal(D.floorLine({ floor: 5, candidates: 1 }, "1m"), "1 coin with 5+ buyers in the last minute");
  assert.equal(D.floorLine({ floor: 5, candidates: 0 }, "1m"), "0 coins with 5+ buyers in the last minute");
  for (const none of [null, {}, { floor: 0, candidates: 50 }, { floor: 5 }]) assert.equal(D.floorLine(none, "1m"), null);
  assert.equal(D.floorLine({ floor: 3, candidates: 50 }, "1h"), null, "the 30m / 1h rule is the server's own and is not worded here");
  assert.equal(D.emptyTrending("1m", 5), "No coin had 5 or more buyers in the last minute.");
  assert.equal(D.emptyTrending("1m"), "Nothing is being bought in the last minute.", "an older server");
  assert.equal(D.emptyTrending("1h", 3), "Nothing is being bought in the last hour.");
});

test("16b. the 1m count and the rows listed are both said when they differ; an empty list never contradicts the count", () => {
  // the server counts candidates before the creator checks, dust and the cap of 50
  assert.equal(D.floorLine({ floor: 5, candidates: 14 }, "1m", 9), "14 coins with 5+ buyers in the last minute · 9 listed");
  assert.equal(D.floorLine({ floor: 5, candidates: 14 }, "1m", 14), "14 coins with 5+ buyers in the last minute", "equal: one number");
  assert.equal(D.floorLine({ floor: 5, candidates: 60 }, "1m", 50), "60 coins with 5+ buyers in the last minute · 50 listed");
  assert.equal(D.floorLine({ floor: 5, candidates: 3 }, "1m", 7), "3 coins with 5+ buyers in the last minute", "rows of another read: nothing added");
  for (const none of [null, undefined, NaN, -1]) assert.equal(D.floorLine({ floor: 5, candidates: 14 }, "1m", none), "14 coins with 5+ buyers in the last minute");
  // a relaunch and a dust coin with 8 buyers each: { floor: 5, candidates: 2, rows: [] }
  const b = { floor: 5, candidates: 2, rows: [] as unknown[] };
  const head = D.floorLine(b, "1m", b.rows.length), empty = D.emptyTrending("1m", b.floor, b.candidates);
  assert.equal(head, "2 coins with 5+ buyers in the last minute · none listed");
  assert.equal(empty, "2 coins had 5 or more buyers in the last minute; none is listed (left out by the creator checks or under a $1,000 market cap).");
  assert.doesNotMatch(empty, /^No coin/);
  assert.equal(D.emptyTrending("1m", 5, 1), "1 coin had 5 or more buyers in the last minute; none is listed (left out by the creator checks or under a $1,000 market cap).");
  assert.equal(D.emptyTrending("1m", 5, 0), "No coin had 5 or more buyers in the last minute.");
  // 30m / 1h: empty because of the entry rule (3+ buyers in the last 5 min), not because nothing was bought in the hour
  assert.equal(D.emptyTrending("1h", 0, 0, 3), "No coin had 3 or more buyers in the last 5 min.");
  assert.equal(D.emptyTrending("30m", 0, 4, 3), "4 coins met the list's buyer count for the last 30 min; none is listed (left out by the creator checks or under a $1,000 market cap).");
  assert.equal(D.emptyTrending("5m", 0, 0, 0), "Nothing is being bought in the last 5 min.");
});

test("16c. a cooling card at its own peak does not say \"down from\"; the pill's text; the address keeps its other keys", () => {
  // the server raises the peak to the rolling ratio
  assert.equal(D.ratioLine(fam(P1, { state: "cooling", ratio: 6.2, peakRatio: 6.2 })), "Buying 6.2x its normal");
  assert.equal(D.ratioLine(fam(P1, { state: "cooling", ratio: 6.24, peakRatio: 6.21 })), "Buying 6.2x its normal");
  assert.equal(D.ratioLine(fam(P1, { state: "cooling", ratio: 6.18, peakRatio: 6.22 })), "Buying 6.2x its normal", "the same printed figure");
  assert.equal(D.ratioLine(fam(P1, { state: "cooling", ratio: 2.1, peakRatio: 14.2 })), "Buying 2.1x its normal, down from 14x");
  assert.equal(D.ratioLine(fam(P1, { state: "cooling", ratio: 0, peakRatio: 14.2 })), "No buying in the last 5 min, down from 14x");
  // the names part alone is what the page cuts; "· Show" is drawn beside it and is not in this text
  const three = D.newsText([{ key: "a", label: "$ASHTONKUTCHER" }, { key: "b", label: "$BIGFOOTISREAL" }, { key: "c", label: "$C" }])!;
  assert.equal(three, "3 new wake-ups: $ASHTONKUTCHER, $BIGFOOTISREAL +1");
  assert.doesNotMatch(three, /Show/);
  // the tab and timeframe are written to the address without a router navigation (the page uses history.replaceState)
  assert.equal(D.prefsUrl({ pathname: "/discover", search: "", hash: "" }, "tab", "trending"), "/discover?tab=trending");
  assert.equal(D.prefsUrl({ pathname: "/discover", search: "?tab=trending&x=1", hash: "#a" }, "tf", "1h"), "/discover?tab=trending&x=1&tf=1h#a");
  assert.equal(D.prefsUrl({ pathname: "/discover", search: "?tf=1m&tab=waking" }, "tf", "30m"), "/discover?tf=30m&tab=waking");
  assert.deepEqual(D.urlPrefs(new URL(D.prefsUrl({ pathname: "/discover", search: "?tf=1m" }, "tab", "trending"), "http://x.test").search), { tab: "trending", tf: "1m" });
});

test("18. a late alert of a family that started without one is still fresh; an older server's event goes by its start", () => {
  assert.equal(D.wakeFresh({ startedAt: NOW - 7200, alertedAt: NOW - 5 }, NOW), true);
  assert.equal(D.wakeFresh({ startedAt: NOW - 7200 }, NOW), false);
  assert.equal(D.wakeFresh({ startedAt: NOW - 60 }, NOW), true);
  assert.equal(D.wakeFresh({ startedAt: NOW - 7200, alertedAt: NOW - 1800 }, NOW), false);
});
test("17. the new words stay neutral: counts and dates, never advice, a post never as the cause", () => {
  const f = fam(P1, { coins5: 4, topShare: 0.9, topMint: "K1", bought5mUsd: 10, sold5mUsd: 900, buyersEx5m: 3, state: "cooling", ratio: 1 });
  const lines = [
    D.breadthLine({ ...f, state: "live" }) ?? "", D.breadthLine({ ...f, state: "live", coins5: 1 }) ?? "", D.flowLine(f) ?? "", D.FLOW_TITLE, D.SILENT_TITLE, D.ratioLine({ ...f, state: "live", buyers5m: 99 }),
    D.coolingLine(f, NOW), D.coolingLine({ ...f, ratio: 0, buyers5m: 0 }, NOW), D.chartAxis(true), D.chartAxis(false), D.sparkLabel({ ...f, sparkEx: [1, 2] }), ...D.markLegend({ start: 1, post: 1 }).map((l) => l.text),
    D.postLead(post({ lead: 9 * 3600 }), null, NOW), D.postLead(post({ lead: 90 * 86400, at: NOW - 90 * 86400, newCoins: 3 }), NOW, NOW), D.newsText([{ key: "a", label: "$A" }]) ?? "", D.PAUSED_TEXT,
    D.listStatus({ error: "x", hasRows: true, paused: false }), D.buyersCell({ p0: 1, chg: 0, volUsd: 1, buys: 1, sells: 1, buyers: 9, holding: 4 }, "5m").sub ?? "", D.buyersCell({ p0: 1, chg: 0, volUsd: 1, buys: 1, sells: 1, buyers: 9, holding: 4 }, "5m").title,
    D.rowAge({ createdAt: null, firstSeenAt: NOW - 99 }, NOW).text, D.rowAge({ createdAt: null, firstSeenAt: NOW - 99 }, NOW).title, D.rowAge({ createdAt: null }, NOW).title, D.GRAD_TITLE, D.LIQ_TITLE, D.THIN_TEXT, D.THIN_TITLE,
    D.MINT_PREFIX_TITLE, D.GROUP_TITLE, D.groupChip({ key: "k", n: 2, largest: 5e6, open: false }), D.groupChip({ key: "k", n: 2, largest: null, open: true }), D.floorLine({ floor: 5, candidates: 3 }, "1m") ?? "",
    D.emptyTrending("1m", 5), D.trendingSub("1h", true),
  ];
  for (const l of lines) assert.doesNotMatch(l, /because|reason|driv|caus|thanks to|due to|moon|should|predict|expect|will |\bhot\b|trending|opportunit|recommend|good|likely|rise|pump|safe|risk|danger|scam|rug|strong|weak|healthy|warning|bullish|bearish|holding/i, l);
  assert.equal(lines.filter((l) => !l).length, 0, "every case above makes a line");
});
