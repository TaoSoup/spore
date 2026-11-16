// The Portfolio page's money formatter (web/src/lib/money.ts): one USD figure read in dollars or in SOL at the current
// SOL price, with a fallback to dollars while that price is not known.
import { test } from "node:test";
import assert from "node:assert/strict";
const { formatMoney, makeMoney, moneyUnit, solPrice, MONEY_UNITS } = await import("../src/lib/money.ts");

const SOL_USD = 200;

test("dollars read as the page's own helpers do", () => {
  assert.equal(formatMoney(1234.5, "usd", SOL_USD), "$1.23K");
  assert.equal(formatMoney(11.906, "usd", SOL_USD), "$11.91");
  assert.equal(formatMoney(0, "usd", SOL_USD), "$0");
  assert.equal(formatMoney(0.004, "usd", SOL_USD, { card: true }), "< $0.01");
  assert.equal(formatMoney(12.4, "usd", SOL_USD, { signed: true }), "+$12.40");
  assert.equal(formatMoney(-3.1, "usd", SOL_USD, { signed: true }), "−$3.10");
  assert.equal(formatMoney(0, "usd", SOL_USD, { signed: true }), "$0");
  assert.equal(formatMoney(-0.004, "usd", SOL_USD, { signed: true }), "≈ $0");
});

test("SOL converts at the SOL price, with the SOL suffix", () => {
  assert.equal(formatMoney(200, "sol", SOL_USD), "1.00 SOL");
  assert.equal(formatMoney(50, "sol", SOL_USD), "0.2500 SOL");
  assert.equal(formatMoney(30_000, "sol", SOL_USD), "150.0 SOL");
  assert.equal(formatMoney(2_480_000, "sol", SOL_USD), "12.4K SOL");
  assert.equal(formatMoney(-200, "sol", SOL_USD), "-1.00 SOL");
});

test("SOL: zero has no sign, a profit and a loss carry theirs", () => {
  assert.equal(formatMoney(0, "sol", SOL_USD), "0 SOL");
  assert.equal(formatMoney(0, "sol", SOL_USD, { signed: true }), "0 SOL");
  assert.equal(formatMoney(-0, "sol", SOL_USD, { signed: true }), "0 SOL");
  assert.equal(formatMoney(100, "sol", SOL_USD, { signed: true }), "+0.5000 SOL");
  assert.equal(formatMoney(-420, "sol", SOL_USD, { signed: true }), "−2.10 SOL");
});

test("SOL: tiny values never read as a bare zero", () => {
  // under a cent a profit is "about nothing", in SOL as in dollars
  assert.equal(formatMoney(0.004, "sol", SOL_USD, { signed: true }), "≈ 0 SOL");
  assert.equal(formatMoney(-0.004, "sol", SOL_USD, { signed: true }), "≈ 0 SOL");
  // a cent and more keeps its digits, however small in SOL
  assert.equal(formatMoney(0.012, "sol", SOL_USD, { signed: true }), "+0.0₄600 SOL");
  assert.equal(formatMoney(0.004, "sol", SOL_USD, { card: true }), "< 0.0001 SOL");
  assert.equal(formatMoney(0.004, "sol", SOL_USD), "0.0₄200 SOL");
  assert.equal(formatMoney(0.02, "sol", SOL_USD, { card: true }), "0.0001 SOL");
});

test("a figure that is not a number reads as a dash in both units", () => {
  for (const unit of MONEY_UNITS) for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(formatMoney(v, unit, SOL_USD), "—");
    assert.equal(formatMoney(v, unit, SOL_USD, { signed: true }), "—");
    assert.equal(formatMoney(v, unit, SOL_USD, { card: true }), "—");
  }
});

test("without a SOL price the page stays in dollars", () => {
  for (const price of [null, undefined, 0, -5, NaN, Infinity]) {
    assert.equal(solPrice(price), null);
    assert.equal(moneyUnit("sol", price), "usd");
    assert.equal(formatMoney(12.4, "sol", price, { signed: true }), "+$12.40");
    const m = makeMoney("sol", price);
    assert.equal(m.unit, "usd");
    assert.equal(m.can, false);
    assert.equal(m.solUsd, null);
    assert.equal(m.money(50), "$50.00");
    assert.equal(m.other(50), null);
    assert.equal(m.toUnit(50), 50);
  }
});

test("makeMoney: the unit in use, the other unit, and the bare number", () => {
  const s = makeMoney("sol", SOL_USD);
  assert.equal(s.unit, "sol");
  assert.equal(s.can, true);
  assert.equal(s.money(200), "1.00 SOL");
  assert.equal(s.money(-100, { signed: true }), "−0.5000 SOL");
  assert.equal(s.other(200), "$200.00");
  assert.equal(s.toUnit(50), 0.25);
  assert.equal(s.toUnit(null), null);
  const d = makeMoney("usd", SOL_USD);
  assert.equal(d.unit, "usd");
  assert.equal(d.can, true);
  assert.equal(d.money(200, { card: true }), "$200.00");
  assert.equal(d.other(200), "1.00 SOL");
  assert.equal(d.toUnit(200), 200);
});

test("no text ever holds NaN, Infinity or undefined", () => {
  const values = [0, -0, 1e-12, -1e-12, 0.0099, 0.01, 1, -1, 999.999, 1e3, 1e9, -1e9, 1e15, Number.MAX_VALUE, Number.MIN_VALUE];
  for (const unit of MONEY_UNITS) for (const price of [SOL_USD, 1e-9, 1e9, null]) for (const v of values) for (const opts of [{}, { signed: true }, { card: true }]) {
    const t = formatMoney(v, unit, price, opts);
    assert.ok(typeof t === "string" && t.length > 0 && !/NaN|Infinity|undefined/.test(t), `${v} ${unit} ${price} ${JSON.stringify(opts)} -> ${t}`);
  }
});
