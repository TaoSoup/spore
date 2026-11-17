// Candles (lib/candles.mjs): buildCandles where it always was, and the pure pieces of the chart history: GeckoTerminal
// timeframes, its OHLCV pages checked and normalised, two venues combined, the seam check, holes, the signatures picked
// for sampling, and the merge with our own candles. No I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCandles, buildCandlesKeyed, clipPage, pageNext, timeframeOf, parseOhlcv, combineVenues, seamCheck, holeOf, pickSamples, mergeHistory, HIST_HOLE_MIN } from "../lib/candles.mjs";
import { buildCandles as fromApi } from "../lib/api.mjs";

const R = 300;
const k = (t, o, h, l, c, v = 1) => ({ t, o, h, l, c, v });

test("1. buildCandles: api.mjs re-exports the very same function (the api and trade-fill tests import it from there)", () => {
  assert.equal(fromApi, buildCandles);
  const trades = [{ time: 610, priceQuote: 2, priceUsd: null, quoteAmount: "5" }, { time: 650, priceQuote: 3, priceUsd: null, quoteAmount: "7" }];
  assert.deepEqual(fromApi(trades, 300), { candles: [{ t: 600, o: 2, h: 3, l: 2, c: 3, v: 12 }], priceKey: "quote" });
});

test("2. timeframeOf: 60 → minute/1, 300 → minute/5, 900 → minute/15, 3600 → hour/1, anything else null", () => {
  assert.deepEqual(timeframeOf(60), { tf: "minute", agg: 1 });
  assert.deepEqual(timeframeOf(300), { tf: "minute", agg: 5 });
  assert.deepEqual(timeframeOf(900), { tf: "minute", agg: 15 });
  assert.deepEqual(timeframeOf(3600), { tf: "hour", agg: 1 });
  for (const r of [15, 120, 1800, 86_400]) assert.equal(timeframeOf(r), null);
});

test("3. parseOhlcv: oldest first, floored and counted, duplicates merged, bad rows dropped, h/l repaired, the window kept, >10 % bad rejected, scaleV applied", () => {
  // newest first, as GeckoTerminal sends it
  const list = [
    [1800, 9, 9, 9, 9, 1],          // > top: not final, dropped
    [1500, 5, 6, 4, 5.5, 2],
    [1203, 4, 4.5, 3.9, 4.2, 1],    // unaligned: floored to 1200, merged with the next (older) row
    [1200, 3.8, 4, 3.5, 4, 3],
    [900, 3, 2.5, 2.8, 3.2, 0.5],   // h below the close, l above the open: repaired
    [600, 2, 2, 2, 2, 1],
    [0, 1, 1, 1, 1, 1],             // < lo: dropped
  ];
  const p = parseOhlcv(list, { R, lo: 300, top: 1500, scaleV: 1 });
  assert.deepEqual(p.candles.map((c) => c.t), [600, 900, 1200, 1500], "oldest first, inside [lo, top]");
  assert.equal(p.unaligned, 1);
  assert.deepEqual(p.candles[2], { t: 1200, o: 3.8, h: 4.5, l: 3.5, c: 4.2, v: 4 }, "the earlier row's open, the later's close, h/l widest, v summed");
  assert.deepEqual(p.candles[1], { t: 900, o: 3, h: 3.2, l: 2.8, c: 3.2, v: 0.5 });
  assert.deepEqual([p.bad, p.total], [0, 7]);
  // bad rows: not six finite numbers, a price ≤ 0, a volume < 0
  const many = Array.from({ length: 20 }, (_, i) => [600 + i * 300, 1, 1, 1, 1, 1]).reverse();
  const bad = [[300, 1, 1, 1], [300, 0, 1, 1, 1, 1], [300, 1, 1, 1, 1, -1], [300, NaN, 1, 1, 1, 1], "x"];
  assert.equal(parseOhlcv([...many, ...bad.slice(0, 2)], { R, lo: 0, top: 1e9 }).bad, 2, "2 of 22: kept");
  assert.equal(parseOhlcv([...many, ...bad.slice(0, 2)], { R, lo: 0, top: 1e9 }).candles.length, 20);
  assert.equal(parseOhlcv([...many, ...bad], { R, lo: 0, top: 1e9 }), null, "5 of 25 bad: the page is rejected");
  assert.equal(parseOhlcv(null, { R, lo: 0, top: 1e9 }), null);
  // currency=token: v in whole quote tokens → atoms
  assert.equal(parseOhlcv([[600, 1, 1, 1, 1, 1.5]], { R, lo: 0, top: 600, scaleV: 1e9 }).candles[0].v, 1.5e9);
  assert.equal(parseOhlcv([[600, 1.234567891234, 1.3, 1, 1.2, 1]], { R, lo: 0, top: 600 }).candles[0].o, 1.2345679, "8 significant digits");
});

test("4. combineVenues: a shared bucket takes o from the curve, c from the pool, h/l widest, v summed; the others pass through", () => {
  const pool = [k(600, 10, 12, 9, 11, 5), k(900, 11, 11, 10, 10, 2)];
  const curve = [k(300, 1, 2, 1, 2, 1), k(600, 8, 9, 7, 9, 3)];
  assert.deepEqual(combineVenues(pool, curve), [k(300, 1, 2, 1, 2, 1), k(600, 8, 12, 7, 11, 8), k(900, 11, 11, 10, 10, 2)]);
});

test("5. seamCheck: closes 1.05× → ok, 1.4× → warn, 1000× → mismatch; fewer than 3 shared buckets → null", () => {
  const own = [600, 900, 1200, 1500].map((t) => k(t, 1, 1, 1, 2));
  const gt = (r) => own.map((c) => ({ ...c, c: c.c * r }));
  assert.equal(seamCheck(gt(1.05), own), "ok");
  assert.equal(seamCheck(gt(1 / 1.05), own), "ok");
  assert.equal(seamCheck(gt(1.4), own), "warn");
  assert.equal(seamCheck(gt(1000), own), "mismatch");
  assert.equal(seamCheck(gt(1e-6), own), "mismatch");
  assert.equal(seamCheck(gt(1000).slice(0, 2), own), null);
  assert.equal(seamCheck(gt(1000), own.map((c) => ({ ...c, t: c.t + 1 }))), null, "no bucket in both");
});

test("6. holeOf: GT ending 17 days before b0 → { from: gtEnd }; a 20-minute tail at 5m → null; a none row → max(W3600, createdAt); GT past b0 → null; b0 = ∞ uses now", () => {
  const nowS = 3_000_000, W3600 = nowS - 500 * 3600, b0 = nowS - 3600, lo = nowS - 500 * R;
  const ok = (end) => ({ state: "ok", candles: [k(end - 2 * R, 1, 1, 1, 1), k(end - R, 1, 1, 1, 1)] });
  const gtEnd17 = b0 - 17 * 86_400;
  assert.deepEqual(holeOf(ok(gtEnd17), { lo: W3600, b0, R, W3600, createdAt: null, nowS }), { from: gtEnd17 });
  assert.equal(holeOf(ok(b0 - 1200), { lo, b0, R, W3600, createdAt: null, nowS }), null, "20 min < HIST_HOLE_MIN(300) = 30 min");
  assert.deepEqual(holeOf(ok(b0 - HIST_HOLE_MIN(R)), { lo, b0, R, W3600, createdAt: null, nowS }), { from: b0 - HIST_HOLE_MIN(R) });
  assert.deepEqual(holeOf({ state: "none", candles: [] }, { lo, b0, R, W3600, createdAt: null, nowS }), { from: W3600 });
  assert.deepEqual(holeOf({ state: "none", candles: [] }, { lo, b0, R, W3600, createdAt: nowS - 86_400, nowS }), { from: nowS - 86_400 });
  assert.deepEqual(holeOf({ state: "mismatch", candles: [k(lo, 1, 1, 1, 1)] }, { lo, b0, R, W3600, createdAt: null, nowS }), { from: W3600 }, "a mismatch row counts as nothing");
  assert.equal(holeOf(ok(b0 + 2 * R), { lo, b0, R, W3600, createdAt: null, nowS }), null, "GT candles after b0");
  assert.deepEqual(holeOf(ok(nowS - 86_400), { lo, b0: Infinity, R, W3600, createdAt: null, nowS }), { from: nowS - 86_400 }, "b0 = ∞: up to now");
  assert.equal(holeOf(ok(Math.floor(nowS / R) * R - 600), { lo, b0: Infinity, R, W3600, createdAt: null, nowS }), null);
});

test("7. pickSamples: 5 000 signatures, K = 120 → 120 distinct, the oldest and every slice's last included, oldest first; forced ones added; n ≤ K → all", () => {
  const S = Array.from({ length: 5000 }, (_, i) => ({ signature: `s${i}` }));
  const p = pickSamples(S, 120);
  assert.equal(p.length, 120);
  assert.equal(new Set(p.map((s) => s.signature)).size, 120);
  const idx = p.map((s) => Number(s.signature.slice(1)));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "oldest first");
  assert.equal(idx[0], 0, "the oldest");
  for (let j = 0; j < 119; j++) assert.ok(idx.includes(Math.floor(((j + 1) * 5000) / 119) - 1), `slice ${j}'s last`);
  assert.equal(idx.at(-1), 4999, "the newest is the last slice's last");
  const f = pickSamples(S, 120, ["s1", "s2500"]);
  assert.equal(f.length, 122);
  assert.ok(f.some((s) => s.signature === "s1") && f.some((s) => s.signature === "s2500"));
  const few = S.slice(0, 80);
  assert.deepEqual(pickSamples(few, 120), few);
  assert.deepEqual(pickSamples(S.slice(0, 120), 120).length, 120);
});

test("8. mergeHistory: GT below b0, own from b0; the seam combined; nothing below lo; points past gtEnd and before B; exact → OHLCV, mixed → s:1; unpriced; B = null", () => {
  const lo = 3000, B = 6100, b0 = 6000;
  const own = [k(6000, 10, 12, 9, 11, 4), k(6300, 11, 13, 10, 12, 6)];
  const gt = [k(2700, 1, 1, 1, 1), k(3000, 2, 2, 2, 2), k(3300, 3, 3, 3, 3), k(6000, 8, 14, 8, 9, 20), k(6300, 50, 50, 50, 50)];
  const m = mergeHistory({ own, gt, pts: [], key: "quote", R, lo, b0, B, qd: 9 });
  assert.deepEqual(m.candles.map((c) => c.t), [3000, 3300, 6000, 6300], "below lo dropped; GT after b0 not shown");
  assert.deepEqual(m.candles[2], { t: 6000, o: 8, h: 14, l: 8, c: 11, v: 20 }, "the seam: GT's open, our close, widest h/l, the larger volume");
  assert.deepEqual(m.candles[3], own[1]);
  assert.equal(m.gtShown, true); assert.equal(m.chain, null);
  // no GT candle at the seam: ours as it is
  assert.deepEqual(mergeHistory({ own, gt: gt.slice(0, 3), pts: [], key: "quote", R, lo, b0, B, qd: 9 }).candles[2], own[0]);
  // points: only past GT's end (3600) and before B; exact buckets are real candles, mixed ones points
  const pts = [
    [3350, 9, null, 100, 1],   // inside GT's last candle: dropped
    [3700, 4, null, 100, 1], [3800, 5, null, 300, 1], [3750, 6, null, 50, 1], // bucket 3600, exact (out of order: sorted by time)
    [4500, 7, null, 10, 1], [4600, 8, null, 10, 0],   // bucket 4500: one sampled → s: 1
    [6050, 99, null, 1, 1],    // bucket b0, before B: not history (the seam bucket is ours)
    [6150, 99, null, 1, 1],    // after B: dropped
  ];
  const q = mergeHistory({ own, gt: gt.slice(0, 3), pts, key: "quote", R, lo, b0, B, qd: 9 });
  assert.deepEqual(q.candles.find((c) => c.t === 3600), { t: 3600, o: 4, h: 6, l: 4, c: 5, v: 450 });
  assert.deepEqual(q.candles.find((c) => c.t === 4500), { t: 4500, o: 8, h: 8, l: 8, c: 8, v: 0, s: 1 });
  assert.equal(q.candles.find((c) => c.t === 3300).c, 3);
  assert.equal(q.chain, "sampled");
  assert.equal(mergeHistory({ own, gt: [], pts: pts.slice(1, 4), key: "quote", R, lo, b0, B, qd: 9 }).chain, "exact");
  // usd: v = atoms / 10^qd × (priceUsd / priceQuote); a point without priceUsd drops its bucket
  const u = mergeHistory({ own: [], gt: [], pts: [[3700, 2, 200, 1e9, 1], [3800, 4, 400, 2e9, 1], [4000, 1, null, 5, 1]], key: "usd", R, lo, b0: Infinity, B: null, qd: 9 });
  assert.deepEqual(u.candles, [{ t: 3600, o: 200, h: 400, l: 200, c: 400, v: 100 + 200 }]);
  assert.equal(u.unpriced, 1);
  // B = null: everything is history
  const all = mergeHistory({ own: [], gt: [k(3000, 1, 1, 1, 1), k(9000, 2, 2, 2, 2)], pts: [[12_000, 3, null, 1, 0]], key: "quote", R, lo, b0: Infinity, B: null, qd: 9 });
  assert.deepEqual(all.candles.map((c) => c.t), [3000, 9000, 12_000]);
  assert.deepEqual([all.gtShown, all.chain], [true, "sampled"]);
});

// ---------------------------------------------------------------- older pages of the coin page's chart (scroll back)
test("back 1. buildCandlesKeyed: usd leaves out and counts trades without a USD price; quote keeps every trade with atom volume; all priced → buildCandles' candles", () => {
  const tr = (time, pq, pu, quote = "5", vu = pu) => ({ time, priceQuote: pq, priceUsd: pu, valueUsd: vu, quoteAmount: quote });
  const mixed = [tr(610, 2, 200), tr(650, 3, null, "7"), tr(920, 4, 400, "1", null)];
  assert.deepEqual(buildCandlesKeyed(mixed, R, "usd"), { candles: [k(600, 200, 200, 200, 200, 200), k(900, 400, 400, 400, 400, 0)], priceKey: "usd", unpriced: 1 });
  assert.deepEqual(buildCandlesKeyed(mixed, R, "quote"), { candles: [k(600, 2, 3, 2, 3, 12), k(900, 4, 4, 4, 4, 1)], priceKey: "quote", unpriced: 0 });
  const priced = [tr(610, 2, 200), tr(650, 3, 300), tr(1300, 1, 100)];
  const b = buildCandles(priced, R);
  assert.equal(b.priceKey, "usd");
  assert.deepEqual(buildCandlesKeyed(priced, R, "usd").candles, b.candles);
  assert.deepEqual(buildCandlesKeyed(mixed, R, "quote").candles, buildCandles(mixed, R).candles, "unpriced: buildCandles is quote-keyed too");
  assert.deepEqual(buildCandlesKeyed([], R, "usd"), { candles: [], priceKey: "usd", unpriced: 0 });
});

test("back 2. clipPage keeps [from, hi) only; pageNext takes the largest candidate, never above lo, null at or below cLo, honours gtFloor", () => {
  const cs = [k(300, 1, 1, 1, 1), k(600, 1, 1, 1, 1), k(900, 1, 1, 1, 1), k(1200, 1, 1, 1, 1)];
  assert.deepEqual(clipPage(cs, 600, 1200).map((c) => c.t), [600, 900]);
  assert.deepEqual(clipPage(cs, 1200, 1200), []);
  const lo = 30_000;
  assert.equal(pageNext({ lo, R }), null, "nothing older");
  assert.equal(pageNext({ lo, ownOlderT: 20_150, R }), 20_400, "our newest trade below lo: its bucket + R");
  const gt = [k(9000, 1, 1, 1, 1), k(24_000, 1, 1, 1, 1), k(30_000, 1, 1, 1, 1)];
  assert.equal(pageNext({ lo, ownOlderT: 20_150, gt, R }), 24_300, "GeckoTerminal's newest candle below lo");
  assert.equal(pageNext({ lo, gt, gtFloor: false, covFrom: 27_000, R }), 27_000, "an unknown stretch below covFrom");
  assert.equal(pageNext({ lo, gt, gtFloor: true, covFrom: 27_000, R }), 24_300, "floored: covFrom says nothing");
  assert.equal(pageNext({ lo, gtFloor: false, covFrom: 27_000, cLo: 27_000, R }), null, "covFrom at the coin's start");
  assert.equal(pageNext({ lo, pts: [[10_000, 1, 1, 1, 0], [25_610, 1, 1, 1, 0], [31_000, 1, 1, 1, 0]], R }), 25_800, "the newest point below lo");
  assert.equal(pageNext({ lo, gtFloor: false, covFrom: 45_000, R }), lo, "never above lo");
  assert.equal(pageNext({ lo, ownOlderT: 20_150, cLo: 20_400, R }), null, "at the creation bucket");
  assert.equal(pageNext({ lo, ownOlderT: 20_150, cLo: 20_100, R }), 20_400, "above it");
  assert.equal(pageNext({ lo, gtFloor: false, covFrom: 300, R }), 300, "no createdAt: anything above 0");
});
