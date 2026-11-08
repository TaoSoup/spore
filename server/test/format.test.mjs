// The number vocabulary the share card and its og:description share (lib/format.mjs): the web's
// figures (web/src/lib/format.ts, web/src/lib/map/dominance.ts sharePct), null for anything unusable
// so a caller leaves that part out instead of printing "—", "NaN" or "null".
import { test } from "node:test";
import assert from "node:assert/strict";
import { usd, count, plural, pctOf, ageOf, shortMint } from "../lib/format.mjs";

test("usd / count / plural: the web's compact figures, null for anything that is not a usable number", () => {
  assert.deepEqual([usd(1_234_567), usd(45_600), usd(12_400), usd(1000), usd(999), usd(11.91), usd(0.4218), usd(0.004), usd(0)], ["$1.23M", "$45.6K", "$12.4K", "$1K", "$999.00", "$11.91", "$0.4218", "< $0.01", "$0"]);
  assert.deepEqual([usd(null), usd(undefined), usd(NaN), usd(-5), usd("5")], [null, null, null, null, null]);
  assert.deepEqual([count(0), count(17), count(1284), count(99_999), count(128_000), count(1_352_000)], ["0", "17", "1,284", "99,999", "128K", "1.35M"]);
  assert.deepEqual([count(null), count(NaN), count(-1), count("3")], [null, null, null, null]);
  assert.deepEqual([plural(1, "child", "children"), plural(12, "child", "children"), plural(1352, "coin", "coins"), plural(null, "coin", "coins")], ["1 child", "12 children", "1,352 coins", null]);
});

test("pctOf: the map's dominance chips (<0.1%, one decimal under 10, whole above, never past 100), null for nothing", () => {
  assert.deepEqual([100, 41.2, 12.6, 9.96, 9.94, 4.26, 1, 0.32, 0.13, 0.057, 0.04].map(pctOf), ["100%", "41%", "13%", "10%", "9.9%", "4.3%", "1.0%", "0.3%", "0.1%", "0.1%", "<0.1%"]);
  assert.deepEqual([0, -1, null, NaN, "4", 2.3e-18].map(pctOf), [null, null, null, null, null, "<0.1%"]);
  assert.equal(pctOf(1e9), "100%");
});

test("ageOf and shortMint", () => {
  assert.deepEqual([ageOf(1000, 1_012_000), ageOf(1000, 1_000_000 + 59 * 60 * 1000), ageOf(1000, 1_000_000 + 3 * 3600 * 1000), ageOf(0, 2 * 86400 * 1000 + 5000), ageOf(9_999, 1_000_000), ageOf(null, 1), ageOf(5, null)], ["12s", "59m", "3h", "2d", "0s", null, null]);
  assert.deepEqual([shortMint("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), shortMint("short"), shortMint(null)], ["7xKX…gAsU", "short", ""]);
});
