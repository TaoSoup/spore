// The price chart while the server reads a coin's missed trades back (web/src/lib/chart-fill.ts): how often it asks
// again, and what an empty chart says meanwhile.
import { test } from "node:test";
import assert from "node:assert/strict";
const { fillPollDelay, thinChartText, FILL_POLL_MS, FILL_POLLS, FILL_POLL_SLOW_MS } = await import("../src/lib/chart-fill.ts");

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
