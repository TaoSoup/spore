// The Portfolio page's profit and loss (web/src/lib/pnl.ts): the per-coin answer of /api/pnl/:wallet joined with the
// wallet's holdings. Amounts are strings in smallest units; USD figures are at today's price of the coin's quote.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pnl, PnlCoin, PnlHistory } from "../src/lib/api.ts";
import type { PnlHolding, PnlRow, PnlView } from "../src/lib/pnl.ts";
const { buildPnl, quotePrices, historyLine, historyRunning, pnlAvailable, signedUsd, pnlTone, pnlPct, mergeFirstPage, appendPage } = await import("../src/lib/pnl.ts");

const ME = "Me11111111111111111111111111111111111111111";
const SOL_USD = 200;
const lamports = (sol: number) => String(Math.round(sol * 1e9));
const units = (n: number) => String(Math.round(n * 1e6)); // 6-decimal tokens
const HIST: PnlHistory = { state: "done", scanned: 40, total: 40, cut: false, unread: 0, since: 1_790_000_000, trackedAt: 1_800_000_000, gap: null };
/// A coin quoted in SOL (9 decimals) with 6 base decimals; the USD figures follow from SOL_USD unless given.
const coin = (mint: string, o: Partial<PnlCoin> = {}): PnlCoin => {
  const c: PnlCoin = {
    mint, coin: { name: `${mint} coin`, symbol: mint, image: null }, quoteMint: null, quoteSymbol: "SOL", quoteDecimals: 9, baseDecimals: 6,
    boughtBase: "0", boughtQuote: "0", soldBase: "0", soldQuote: "0", realizedQuote: "0", costQuote: "0", heldBase: "0",
    partial: false, buys: 0, sells: 0, firstAt: 1_799_000_000, lastAt: 1_799_500_000, realizedUsdNow: null, costUsdNow: null, ...o,
  };
  if (!("realizedUsdNow" in o)) c.realizedUsdNow = (Number(c.realizedQuote) / 10 ** c.quoteDecimals) * SOL_USD;
  if (!("costUsdNow" in o)) c.costUsdNow = (Number(c.costQuote) / 10 ** c.quoteDecimals) * SOL_USD;
  return c;
};
const pnl = (coins: PnlCoin[], o: Partial<Pnl> = {}): Pnl => ({ ok: true, wallet: ME, at: 1_800_000_100, since: null, history: HIST, trades: coins.length, coins, totals: { realizedUsdNow: null, costUsdNow: null, unpriced: 0 }, ...o });
const hold = (mint: string, tokens: number, valueUsd: number | null): PnlHolding => ({ mint, amount: units(tokens), valueUsd });
const row = (v: PnlView, mint: string): PnlRow => { const r = v.byMint.get(mint); assert.ok(r, `row ${mint}`); return r; };
const near = (a: number | null, b: number, what = "") => { assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${what} ${a} is not ${b}`); };
/// Every number of a view is finite (or null): nothing may reach the screen as NaN or Infinity.
function assertFinite(v: unknown, path = "view"): void {
  if (typeof v === "number") assert.ok(Number.isFinite(v), `${path} = ${v}`);
  else if (v instanceof Map) for (const [k, x] of v) assertFinite(x, `${path}.${String(k)}`);
  else if (Array.isArray(v)) v.forEach((x, i) => assertFinite(x, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) assertFinite(x, `${path}.${k}`);
}

test("nothing in, nothing out", () => {
  for (const v of [buildPnl(null), buildPnl(undefined, [hold("A", 5, 3)]), buildPnl(pnl([]))]) {
    assert.equal(v.byMint.size, 0);
    assert.deepEqual(v.closed, []);
    assert.equal(v.totals.unrealizedUsd, null);
    assert.equal(v.totals.realizedUsd, 0);
    assertFinite(v);
  }
  // a held coin the answer does not list has no recorded buy: it is counted as left out
  assert.equal(buildPnl(pnl([]), [hold("A", 5, 3)]).totals.noCost, 1);
});

test("the balance matches the trades: cost, average cost and unrealized profit in USD and percent", () => {
  // bought 1 000 tokens for 0.5 SOL ($100 today); they are worth $150
  const c = coin("A", { boughtBase: units(1000), boughtQuote: lamports(0.5), costQuote: lamports(0.5), heldBase: units(1000), buys: 2 });
  const v = buildPnl(pnl([c]), [hold("A", 1000, 150)]);
  const r = row(v, "A");
  assert.deepEqual([r.held, r.dust, r.partial, r.gap], [true, false, false, null]);
  assert.deepEqual([r.balance, r.matched], [1000, 1000]);
  near(r.costUsd, 100); near(r.avgCostUsd, 0.1); near(r.valueUsd, 150); near(r.unrealizedUsd, 50); near(r.unrealizedPct, 0.5);
  assert.deepEqual(r.bought, { quote: 0.5, usd: 100 });
  assert.deepEqual(r.sold, { quote: 0, usd: 0 });
  assert.equal(r.realizedUsd, null, "nothing was sold");
  assert.deepEqual(v.closed, []);
  near(v.totals.unrealizedUsd, 50); near(v.totals.unrealizedPct, 0.5);
  assert.deepEqual([v.totals.counted, v.totals.partial, v.totals.noCost, v.totals.unpriced, v.totals.costUsd], [1, 0, 0, 0, 100]);
});

test("the wallet holds less than the trades say: the cost is scaled to what is held, and the row is not partial", () => {
  // the trades leave 1 000 tokens that cost $100; 400 were sent away, the 600 left are worth $90
  const c = coin("A", { costQuote: lamports(0.5), heldBase: units(1000), buys: 1 });
  const r = row(buildPnl(pnl([c]), [hold("A", 600, 90)]), "A");
  assert.equal(r.partial, false);
  assert.equal(r.matched, 600);
  near(r.costUsd, 60); near(r.avgCostUsd, 0.1); near(r.valueUsd, 90); near(r.unrealizedUsd, 30); near(r.unrealizedPct, 0.5);
});

test("the wallet holds more than the trades say: only the bought part counts, and the row is partial", () => {
  // 1 000 bought for $100; 1 000 more were received. The 2 000 held are worth $300, the bought half $150
  const c = coin("A", { costQuote: lamports(0.5), heldBase: units(1000), buys: 1 });
  const v = buildPnl(pnl([c]), [hold("A", 2000, 300)]);
  const r = row(v, "A");
  assert.equal(r.partial, true);
  assert.deepEqual([r.balance, r.matched], [2000, 1000]);
  near(r.costUsd, 100); near(r.valueUsd, 150); near(r.unrealizedUsd, 50); near(r.avgCostUsd, 0.1);
  assert.deepEqual([v.totals.counted, v.totals.partial], [1, 1]);
  // the server's own flag marks the row too, with a matching balance
  assert.equal(row(buildPnl(pnl([{ ...c, partial: true }]), [hold("A", 1000, 150)]), "A").partial, true);
});

test("no buy recorded: no figure, never a zero", () => {
  // sold tokens it never bought here and still holds some: no cost is known
  const sent = coin("A", { soldBase: units(50), soldQuote: lamports(0.01), heldBase: "0", partial: true, sells: 1 });
  // listed with a held amount but a zero cost
  const free = coin("B", { heldBase: units(10), costQuote: "0" });
  const v = buildPnl(pnl([sent, free]), [hold("A", 100, 20), hold("B", 10, 5), hold("C", 1, 2)]);
  for (const m of ["A", "B"]) {
    const r = row(v, m);
    assert.equal(r.gap, "no-cost");
    assert.deepEqual([r.costUsd, r.avgCostUsd, r.valueUsd, r.unrealizedUsd, r.unrealizedPct], [null, null, null, null, null]);
  }
  assert.equal(row(v, "A").partial, true);
  assert.equal(row(v, "A").realizedUsd, null, "a sell without a buy realizes nothing that can be counted");
  // A, B and C (held, not in the answer) are left out of the total, which has nothing to show
  assert.deepEqual([v.totals.noCost, v.totals.counted, v.totals.unrealizedUsd, v.totals.unrealizedPct], [3, 0, null, null]);
  assert.deepEqual([v.totals.realizedUsd, v.totals.realizedCoins, v.totals.realizedLeftOut], [null, 0, 1], "sold, but nothing that can be counted: unknown, not zero");
  // nothing sold at all is a plain zero; one counted sell beside an uncounted one gives its figure
  assert.deepEqual([buildPnl(pnl([free])).totals.realizedUsd, buildPnl(pnl([free])).totals.realizedLeftOut], [0, 0]);
  const sold = coin("D", { boughtQuote: lamports(1), soldQuote: lamports(1.5), realizedQuote: lamports(0.5), buys: 1, sells: 1 });
  const mixed = buildPnl(pnl([sent, sold])).totals;
  near(mixed.realizedUsd, 100);
  assert.deepEqual([mixed.realizedCoins, mixed.realizedLeftOut, mixed.realizedPartial], [1, 1, 0]);
  assertFinite(v);
});

test("a child coin quoted in its parent's token without a price: amounts in the quote, no USD", () => {
  const P = "Parent1111111111111111111111111111111111111";
  const c = coin("K", {
    quoteMint: P, quoteSymbol: "PAR", quoteDecimals: 6, boughtBase: units(500), boughtQuote: units(2000), soldBase: units(100), soldQuote: units(600),
    realizedQuote: units(200), costQuote: units(1600), heldBase: units(400), buys: 1, sells: 1, realizedUsdNow: null, costUsdNow: null,
  });
  const v = buildPnl(pnl([c]), [hold("K", 400, 80)]);
  const r = row(v, "K");
  assert.deepEqual([r.quoteSymbol, r.quoteUsd, r.gap], ["PAR", null, "no-price"]);
  assert.deepEqual([r.costUsd, r.unrealizedUsd, r.unrealizedPct, r.realizedUsd], [null, null, null, null]);
  assert.deepEqual(r.bought, { quote: 2000, usd: null });
  assert.deepEqual(r.sold, { quote: 600, usd: null });
  // the percent needs no price: 200 made on tokens that cost 600 - 200 = 400
  near(r.realizedPct, 0.5);
  assert.deepEqual([v.totals.unpriced, v.totals.counted, v.totals.unrealizedUsd, v.totals.realizedLeftOut, v.totals.realizedUsd], [1, 0, null, 1, null]);
  assertFinite(v);

  // the same coin once the page knows the parent's price ($0.05): every figure appears
  const w = row(buildPnl(pnl([c]), [hold("K", 400, 100)], { quoteUsd: [[P, 0.05]] }), "K");
  near(w.quoteUsd, 0.05); near(w.costUsd, 80); near(w.unrealizedUsd, 20); near(w.unrealizedPct, 0.25); near(w.realizedUsd, 10);
  assert.deepEqual(w.bought, { quote: 2000, usd: 100 });
  // a held coin without a value of its own has no figure either
  assert.equal(row(buildPnl(pnl([c]), [hold("K", 400, null)], { quoteUsd: [[P, 0.05]] }), "K").gap, "no-price");
});

test("quote prices: what the answer implies first, then what the page knows", () => {
  const P = "Parent1111111111111111111111111111111111111";
  const a = coin("A", { costQuote: lamports(1), heldBase: units(1) }); // implies SOL = $200
  const b = coin("B", { quoteMint: P, quoteSymbol: "PAR", quoteDecimals: 6, realizedQuote: units(-10), realizedUsdNow: -5, costUsdNow: 0 }); // implies PAR = $0.5
  const m = quotePrices(pnl([a, b]), [[null, 150], [P, 9], ["Other", 3], ["Bad", NaN], ["Zero", 0], ["Null", null]]);
  near(m.get("SOL") ?? null, 200); near(m.get(P) ?? null, 0.5);
  assert.equal(m.get("Other"), 3);
  assert.deepEqual([m.has("Bad"), m.has("Zero"), m.has("Null")], [false, false, false]);
  assert.equal(quotePrices(null, [[null, 150]]).get("SOL"), 150);
});

test("closed positions: sold out or dust, for the period, latest trade first", () => {
  const gone = coin("Gone", { boughtBase: units(100), boughtQuote: lamports(1), soldBase: units(100), soldQuote: lamports(1.5), realizedQuote: lamports(0.5), buys: 1, sells: 2, lastAt: 1_799_000_100 });
  const loss = coin("Loss", { boughtBase: units(100), boughtQuote: lamports(1), soldBase: units(100), soldQuote: lamports(0.25), realizedQuote: lamports(-0.75), buys: 1, sells: 1, lastAt: 1_799_000_300 });
  const dust = coin("Dust", { boughtQuote: lamports(1), soldQuote: lamports(1.2), realizedQuote: lamports(0.2), costQuote: lamports(0.001), heldBase: units(1), buys: 1, sells: 1, lastAt: 1_799_000_200 });
  const open = coin("Open", { boughtQuote: lamports(1), costQuote: lamports(1), heldBase: units(10), buys: 1, lastAt: 1_799_000_400 });
  const quiet = coin("Quiet", { lastAt: 1_799_000_500 }); // traded before the period only: no buys or sells in it
  const v = buildPnl(pnl([gone, loss, dust, open, quiet]), [hold("Dust", 1, 0.4), hold("Open", 10, 260)]);
  assert.deepEqual(v.closed.map((r) => r.mint), ["Loss", "Dust", "Gone"]);
  const g = row(v, "Gone"), l = row(v, "Loss"), d = row(v, "Dust");
  assert.deepEqual([g.held, g.dust, g.unrealizedUsd], [false, false, null]);
  assert.deepEqual([g.bought, g.sold], [{ quote: 1, usd: 200 }, { quote: 1.5, usd: 300 }]);
  near(g.realizedUsd, 100); near(g.realizedPct, 0.5);
  near(l.realizedUsd, -150); near(l.realizedPct, -0.75);
  assert.deepEqual([d.held, d.dust], [true, true]);
  near(d.realizedUsd, 40);
  // totals: realized over the three sold coins; unrealized over the two held ones with a cost
  near(v.totals.realizedUsd, -10);
  assert.deepEqual([v.totals.realizedCoins, v.totals.realizedLeftOut, v.totals.counted], [3, 0, 2]);
  near(v.totals.unrealizedUsd, 60 + 0.2); near(v.totals.costUsd, 200.2);
  // a higher dust limit closes the open coin too; zero closes nothing that is held
  assert.deepEqual(buildPnl(pnl([open]), [hold("Open", 10, 260)], { dustUsd: 1000 }).closed.map((r) => r.mint), ["Open"]);
  assert.deepEqual(buildPnl(pnl([dust]), [hold("Dust", 1, 0.4)], { dustUsd: 0 }).closed, []);
  // a holding of zero tokens is not held
  assert.deepEqual(buildPnl(pnl([gone]), [hold("Gone", 0, 0)]).closed.map((r) => r.mint), ["Gone"]);
  assert.equal(buildPnl(pnl([gone], { since: 1_799_000_000 })).since, 1_799_000_000);
});

test("percent of a zero cost, and partial sells, give no percent", () => {
  // a cost that rounds to nothing in USD: the profit shows, the percent does not
  const free = coin("A", { costQuote: "1", heldBase: units(10), costUsdNow: 0 });
  const r = row(buildPnl(pnl([free]), [hold("A", 10, 5)]), "A");
  near(r.unrealizedUsd, 5);
  assert.deepEqual([r.unrealizedPct, r.gap], [null, null]);
  const v = buildPnl(pnl([free]), [hold("A", 10, 5)]);
  assert.equal(v.totals.unrealizedPct, null);
  near(v.totals.unrealizedUsd, 5);
  // sold for exactly what it made (cost of the sold tokens = 0): no percent
  const gift = coin("B", { soldQuote: lamports(1), realizedQuote: lamports(1), buys: 1, sells: 1 });
  assert.equal(row(buildPnl(pnl([gift])), "B").realizedPct, null);
  // part of the sold tokens has no buy: the profit of the rest shows as approximate, without a percent
  const part = coin("C", { boughtQuote: lamports(0.1), soldQuote: lamports(5), realizedQuote: lamports(-0.02), partial: true, buys: 1, sells: 3 });
  const p = buildPnl(pnl([part]));
  near(row(p, "C").realizedUsd, -4);
  assert.deepEqual([row(p, "C").realizedPct, row(p, "C").partial, p.totals.realizedPartial], [null, true, 1]);
});

test("odd input never reaches the screen as NaN or Infinity", () => {
  const huge = "123456789012345678901234567890"; // far above 2^53
  const odd = [
    coin("Huge", { boughtBase: huge, boughtQuote: huge, soldQuote: huge, realizedQuote: `-${huge}`, costQuote: huge, heldBase: huge, buys: 1, sells: 1 }),
    coin("Junk", { boughtQuote: "abc", soldQuote: "", realizedQuote: "1.5", costQuote: "x", heldBase: "-", buys: 1, sells: 1, realizedUsdNow: NaN, costUsdNow: Infinity }),
    coin("Dec", { quoteDecimals: 0, baseDecimals: 0, costQuote: "7", heldBase: "3", costUsdNow: 21, buys: 1 }),
    coin("BadDec", { quoteDecimals: -4, baseDecimals: 400, costQuote: "7", heldBase: "3", buys: 1 }),
    coin("Zero", { costQuote: "0", heldBase: "0" }),
  ];
  const holds: PnlHolding[] = [
    { mint: "Huge", amount: huge, valueUsd: 1e30 }, { mint: "Junk", amount: "nope", valueUsd: NaN }, { mint: "Dec", amount: "3", valueUsd: 30 },
    { mint: "BadDec", amount: "3", valueUsd: Infinity }, { mint: "Zero", amount: "0", valueUsd: null },
  ];
  const v = buildPnl(pnl(odd), holds, { quoteUsd: [[null, Infinity]] });
  assertFinite(v);
  near(row(v, "Dec").unrealizedUsd, 9); near(row(v, "Dec").avgCostUsd, 7);
  assert.equal(row(v, "Junk").held, false);
  for (const r of v.byMint.values()) for (const s of [signedUsd(r.unrealizedUsd), signedUsd(r.realizedUsd)]) assert.ok(!/NaN|Infinity/.test(s), s);
});

test("the history line", () => {
  const h = (o: Partial<PnlHistory>) => pnl([], { history: { ...HIST, ...o } });
  assert.equal(historyLine(null), null);
  assert.equal(historyLine(h({})), null, "a complete history says nothing");
  assert.equal(historyLine(h({ state: "running", scanned: 240, total: 1000 })), "Reading your trade history: 240 of 1,000 transactions.");
  assert.equal(historyLine(h({ state: "queued", scanned: 0, total: 0 })), "Reading your trade history…");
  assert.equal(historyLine(h({ state: "running", scanned: 5, total: 9 }), false), "Reading this wallet's trade history: 5 of 9 transactions.");
  assert.match(historyLine(h({ cut: true, since: 1_790_000_000 })) ?? "", /^Trades before .*2026.* are not included\.$/);
  assert.equal(historyLine(h({ unread: 2 })), "Some trades may be missing.");
  assert.equal(historyLine(h({ gap: 1_799_999_000 })), "Some trades may be missing.");
  assert.match(historyLine(h({ cut: true, unread: 1 })) ?? "", /not included\. Some trades may be missing\.$/);
  assert.equal(historyLine(h({ state: "failed" })), "Trade history could not be read just now; it is retried.");
  for (const state of ["full", "off"] as const) {
    assert.equal(historyLine(h({ state })), "P&L is not available right now.");
    assert.equal(pnlAvailable(h({ state })), false);
  }
  assert.equal(historyLine(pnl([], { ok: false, history: null })), "P&L is not available right now.");
  assert.deepEqual([pnlAvailable(null), pnlAvailable(pnl([], { ok: false, history: null })), pnlAvailable(h({})), pnlAvailable(h({ state: "failed" }))], [false, false, true, true]);
  assert.deepEqual([historyRunning(h({ state: "queued" })), historyRunning(h({ state: "running" })), historyRunning(h({})), historyRunning(null)], [true, true, false, false]);
});

test("signed dollars and their colour", () => {
  assert.deepEqual([signedUsd(12.4), signedUsd(-3.1), signedUsd(0), signedUsd(0.004), signedUsd(-0.004), signedUsd(null), signedUsd(NaN), signedUsd(Infinity)],
    ["+$12.40", "−$3.10", "$0", "≈ $0", "≈ $0", "—", "—", "—"]);
  assert.equal(signedUsd(-12_345), "−$12.3K");
  assert.deepEqual([pnlPct(0.124), pnlPct(-0.032), pnlPct(-0.00004), pnlPct(0.00004), pnlPct(0), pnlPct(0.0001), pnlPct(null), pnlPct(NaN)],
    ["+12.4%", "−3.20%", "0.00%", "0.00%", "0.00%", "+0.01%", "—", "—"]);
  assert.deepEqual([pnlTone(1), pnlTone(-1), pnlTone(0), pnlTone(0.004), pnlTone(null), pnlTone(NaN)], ["up", "down", "none", "none", "none", "none"]);
});

test("tokens received on top of the trades make the unrealized figure approximate, not the realized one", () => {
  // bought and sold out with complete trades, then a few tokens were sent in: closed as dust, realized exact
  const done = coin("A", { boughtQuote: lamports(1), soldQuote: lamports(1.5), realizedQuote: lamports(0.5), heldBase: "0", buys: 1, sells: 1 });
  // an open holding with received tokens and an exact sell
  const open = coin("B", { boughtQuote: lamports(2), soldQuote: lamports(1.2), realizedQuote: lamports(0.2), costQuote: lamports(1), heldBase: units(10), buys: 1, sells: 1 });
  const v = buildPnl(pnl([done, open]), [hold("A", 3, 0.2), hold("B", 15, 300)]);
  const a = row(v, "A"), b = row(v, "B");
  assert.deepEqual([a.dust, a.partial, a.realizedPartial], [true, true, false]);
  assert.deepEqual([b.partial, b.realizedPartial], [true, false]);
  near(a.realizedUsd, 100); near(a.realizedPct, 0.5);
  assert.deepEqual([v.totals.realizedCoins, v.totals.realizedPartial, v.totals.partial], [2, 0, 1]);
  // the server's own flag does make it approximate
  assert.equal(row(buildPnl(pnl([coin("C", { soldQuote: lamports(1), realizedQuote: lamports(0.1), partial: true, sells: 1 })])), "C").realizedPartial, true);
});

test("the activity list: a fresh first page merged into a list extended with Load more", () => {
  type T = { id: string; time: number };
  const key = (t: T) => t.id;
  const t = (id: string, time: number): T => ({ id, time });
  const ids = (l: { trades: T[] }) => l.trades.map((x) => x.id).join(" ");
  // the reader holds two pages; three newer trades push the tail of the old first page out of the new one
  const cur = { trades: [t("e", 50), t("d", 40), t("c", 30), t("b", 20), t("a", 10)], next: "10:1", tracked: true };
  const page = { trades: [t("h", 80), t("g", 70), t("f", 60)], next: "60:9", tracked: true };
  const m = mergeFirstPage(cur, page, key, 8);
  assert.equal(ids(m), "h g f e d c b a", "nothing loaded is dropped, the new ones go on top");
  assert.equal(m.next, "10:1", "the reader's own cursor stays");
  // the same page again changes nothing
  assert.equal(mergeFirstPage(m, page, key, 8).trades, m.trades);
  // a trade stored later inside the range lands in its place by time
  assert.equal(ids(mergeFirstPage(cur, { ...page, trades: [t("h", 80), t("x", 35)] }, key)), "h e d x c b a");
  // the list had reached its end, and the server now stores more than it holds: a cursor comes back (the last
  // row's second plus one, since `before` is strict), and not when the count is unknown or already met
  const end = { ...cur, next: null };
  assert.equal(mergeFirstPage(end, page, key, 200).next, "11");
  assert.equal(mergeFirstPage(end, page, key, 8).next, null);
  assert.equal(mergeFirstPage(end, page, key).next, null);
  assert.equal(mergeFirstPage({ trades: [], next: null, tracked: false }, { trades: [], next: null, tracked: true }, key, 5).next, null);
  // the server's word on tracking is the newest one
  assert.equal(mergeFirstPage({ ...end, tracked: false }, page, key).tracked, true);
  // Load more: the page goes after the list, rows held already are skipped, the cursor is the page's
  const more = appendPage(end, { trades: [t("a", 10), t("z", 5)], next: null }, key);
  assert.deepEqual([ids(more), more.next, more.tracked], ["e d c b a z", null, true]);
  assert.equal(appendPage(cur, { trades: [t("z", 5)], next: "5:3" }, key).next, "5:3");
});
