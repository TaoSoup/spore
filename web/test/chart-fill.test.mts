// The price chart while the server reads a coin's missed trades back or its earlier history (web/src/lib/chart-fill.ts):
// how often it asks again, which answers it applies, what an empty chart says meanwhile, and the GeckoTerminal credit.
import { test } from "node:test";
import assert from "node:assert/strict";
const { fillPollDelay, thinChartText, historyPending, pendingOf, geckoPoolUrl, sampledSummary, lastMarkOn, liveCandle, FILL_POLL_MS, FILL_POLLS, FILL_POLL_SLOW_MS } = await import("../src/lib/chart-fill.ts");

test("poll: every 5 s for the first 3 minutes, then every 30 s with no end of its own (the server ends it)", () => {
  assert.equal(FILL_POLLS * FILL_POLL_MS, 180_000);
  assert.equal(fillPollDelay(0), FILL_POLL_MS);
  assert.equal(fillPollDelay(FILL_POLLS - 1), FILL_POLL_MS);
  assert.equal(fillPollDelay(FILL_POLLS), FILL_POLL_SLOW_MS);
  assert.equal(fillPollDelay(10_000), FILL_POLL_SLOW_MS, "a job longer than 3 min is still followed");
});

test("empty chart: says missed trades are being read while `fill` is there, not 'no trades yet'", () => {
  assert.equal(thinChartText(0, true), "Reading missed trades from the chain…");
  assert.equal(thinChartText(1, true), "Reading missed trades from the chain…");
  assert.match(thinChartText(0, false), /^No trades yet/);
  assert.match(thinChartText(1, false), /^Not enough price points yet/);
});

test("37. historyPending: true for loading and sampling only", () => {
  assert.equal(historyPending({ state: "loading" }), true);
  assert.equal(historyPending({ state: "sampling" }), true);
  assert.equal(historyPending({ state: "done" }), false);
  assert.equal(historyPending(undefined), false);
  assert.equal(historyPending(null), false);
});

test("38. pendingOf: null with nothing pending; a distinct key for fill only, loading, sampling, and fill with sampling; the poll applies an answer only when its key moved", () => {
  const fill = { state: "queued", gaps: 1, from: 1, to: 2 };
  assert.equal(pendingOf({}), null);
  assert.equal(pendingOf({ history: { state: "done" } }), null);
  const keys = [pendingOf({ fill }), pendingOf({ history: { state: "loading" } }), pendingOf({ history: { state: "sampling" } }), pendingOf({ fill, history: { state: "sampling" } })];
  assert.ok(keys.every((k) => typeof k === "string"));
  assert.equal(new Set(keys).size, 4);
  // the chart's rule: apply when the key differs from the shown one
  const applies = (shown: string | null, d: Parameters<typeof pendingOf>[0]) => pendingOf(d) !== shown;
  const shown = pendingOf({ history: { state: "loading" } });
  assert.equal(applies(shown, { history: { state: "loading" } }), false, "the same key: dropped, no refit");
  assert.equal(applies(shown, { history: { state: "sampling" } }), true, "moved on");
  assert.equal(applies(shown, { history: { state: "done" } }), true, "nothing pending: applied, the poll ends");
  assert.equal(applies(pendingOf({ fill }), {}), true, "the fill cleared");
});

test("39. thinChartText: history says the earlier history is being read; the fill wording wins; otherwise unchanged", () => {
  assert.equal(thinChartText(0, false, true), "Reading this coin's earlier history…");
  assert.equal(thinChartText(1, false, true), "Reading this coin's earlier history…");
  assert.equal(thinChartText(0, true, true), "Reading missed trades from the chain…");
  assert.match(thinChartText(0, false, false), /^No trades yet/);
  assert.match(thinChartText(1, false), /^Not enough price points yet/);
});

test("40. geckoPoolUrl: GeckoTerminal's page of the pool", () => {
  assert.equal(geckoPoolUrl("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"), "https://www.geckoterminal.com/solana/pools/58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");
});

test("41. sampled rows: the summary names them without a position (they can sit between GeckoTerminal's candles and ours, or be the newest); the last-value label moves to the line when the newest row is sampled", () => {
  const gt = { t: 1 }, smp = { t: 2, s: 1 as const }, ours = { t: 3 };
  assert.equal(sampledSummary([gt, smp, ours]), ", some prices sampled from the chain");
  assert.equal(sampledSummary([gt, ours]), "");
  assert.doesNotMatch(sampledSummary([gt, smp]), /earliest/);
  assert.equal(lastMarkOn([gt, smp, ours]), "candles");
  assert.equal(lastMarkOn([smp, smp]), "area", "only sampled rows: the candle series has no bar");
  assert.equal(lastMarkOn([gt, smp]), "area", "a sampled tail after GeckoTerminal's candles");
  assert.equal(lastMarkOn([]), "candles");
});

test("liveCandle: a trade in the newest bucket extends it, a sampled one becomes a real candle (no s: legend, marks and summary see a trade); a later bucket opens at the last close; an older one is left to the re-read", () => {
  const sampled = { t: 600, o: 2, h: 2, l: 2, c: 2, v: 0, s: 1 as const };
  const c = liveCandle(sampled, 600, 3, 5)!;
  assert.deepEqual(c, { t: 600, o: 2, h: 3, l: 2, c: 3, v: 5 });
  assert.equal("s" in c, false);
  assert.equal(lastMarkOn([sampled, c].slice(1)), "candles");
  assert.deepEqual(liveCandle({ t: 600, o: 2, h: 4, l: 1, c: 3, v: 7 }, 600, 0.5, 1), { t: 600, o: 2, h: 4, l: 0.5, c: 0.5, v: 8 });
  assert.deepEqual(liveCandle(sampled, 900, 1, 4), { t: 900, o: 2, h: 2, l: 1, c: 1, v: 4 });
  assert.equal(liveCandle(sampled, 300, 1, 4), null);
});
