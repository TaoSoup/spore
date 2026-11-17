// "Your position" on the coin page (web/src/lib/position.ts): which wallet, when the card shows, and its figures from
// the balance store, the live price and /api/pnl, joined exactly as the Portfolio joins them (lib/pnl.ts buildPnl).
// Fakes only: no network, no wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Pnl, PnlCoin, PnlHistory } from "../src/lib/api.ts";
const { positionOwner, positionMode, pnlForMint, pnlCaughtUp, settleStep, settleBehind, landingSettle, settleSaw, settleTrades, visitFor, visitMount, VISIT_HANDOFF_MS, LANDING_RELOADS_MS, BEHIND_RELOADS_MS, SETTLE_GIVE_UP_MS, positionView, walletLabel, closedNote, POSITION_FAILED, POSITION_UPDATING, POSITION_BEHIND } = await import("../src/lib/position.ts");
const { buildPnl, DUST_USD, PNL_NOTE, APPROX_NOTE } = await import("../src/lib/pnl.ts");
const { avgFig, unrealizedFig, realizedFig } = await import("../src/components/coin/positionFigs.tsx");

const ME = "Me11111111111111111111111111111111111111111";
const TW = "Tw11111111111111111111111111111111111111111";
const EXT = "Ex11111111111111111111111111111111111111111";
const MINT = "Foo1111111111111111111111111111111111111111";
const SOL_USD = 150;
const lamports = (sol: number) => String(Math.round(sol * 1e9));
const units = (n: number) => String(Math.round(n * 1e6)); // 6-decimal tokens
const raw = (n: number) => BigInt(units(n));
const HIST: PnlHistory = { state: "done", scanned: 40, total: 40, cut: false, unread: 0, since: 1_790_000_000, trackedAt: 1_800_000_000, gap: null };
/// A coin quoted in SOL (9 decimals) with 6 base decimals; the USD figures follow from SOL_USD unless given.
const coin = (mint: string, o: Partial<PnlCoin> = {}): PnlCoin => {
  const c: PnlCoin = {
    mint, coin: { name: "Foo", symbol: "FOO", image: null }, quoteMint: null, quoteSymbol: "SOL", quoteDecimals: 9, baseDecimals: 6,
    boughtBase: "0", boughtQuote: "0", soldBase: "0", soldQuote: "0", realizedQuote: "0", costQuote: "0", heldBase: "0",
    partial: false, buys: 0, sells: 0, firstAt: 1_799_000_000, lastAt: 1_799_500_000, realizedUsdNow: null, costUsdNow: null, ...o,
  };
  if (!("realizedUsdNow" in o)) c.realizedUsdNow = (Number(c.realizedQuote) / 10 ** c.quoteDecimals) * SOL_USD;
  if (!("costUsdNow" in o)) c.costUsdNow = (Number(c.costQuote) / 10 ** c.quoteDecimals) * SOL_USD;
  return c;
};
const pnl = (coins: PnlCoin[], o: Partial<Pnl> = {}): Pnl => ({ ok: true, wallet: ME, at: 1_800_000_100, since: null, history: HIST, trades: coins.length, coins, totals: { realizedUsdNow: null, costUsdNow: null, unpriced: 0 }, ...o });
/// 1 000 000 FOO bought for 1 SOL ($150 today), all still held by the trades.
const BOUGHT = coin(MINT, { boughtBase: units(1_000_000), boughtQuote: lamports(1), costQuote: lamports(1), heldBase: units(1_000_000), buys: 1 });
const OTHER = coin("Bar1111111111111111111111111111111111111111", { costQuote: lamports(2), heldBase: units(5), buys: 3 });
/// The coin page's live coin: FOO at $0.0002 (SOL at $150).
const LIVE = { mint: MINT, label: "$FOO", decimals: 6, priceUsd: 0.0002, priceSol: 0.0002 / SOL_USD, quoteMint: null, solUsd: SOL_USD, quoteUsd: null };
const view = (o: Partial<Parameters<typeof positionView>[0]> = {}) =>
  positionView({ ...LIVE, mode: "held", balanceRaw: raw(1_000_000), pnl: pnl([BOUGHT, OTHER]), pnlError: false, stale: false, ...o });
const near = (a: number | null | undefined, b: number, what = "") => { assert.ok(a != null && Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${what} ${a} is not ${b}`); };
/// Every number of a view is finite (or null): nothing may reach the screen as NaN or Infinity.
function assertFinite(v: unknown, path = "view"): void {
  if (typeof v === "number") assert.ok(Number.isFinite(v), `${path} = ${v}`);
  else if (Array.isArray(v)) v.forEach((x, i) => assertFinite(x, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) assertFinite(x, `${path}.${k}`);
}

test("the owner: an unlocked trading wallet that trades is the card's wallet", () => {
  assert.deepEqual(positionOwner({ traderKind: "trading", traderAddress: TW, twStatus: "unlocked", twAddress: TW }), { address: TW, kind: "trading", locked: false });
  assert.equal(walletLabel({ address: TW, kind: "trading", locked: false }, "Phantom"), "Trading wallet");
});

test("the owner: the extension that trades wins over a locked trading wallet, as in the header pill", () => {
  const o = positionOwner({ traderKind: "wallet", traderAddress: EXT, twStatus: "locked", twAddress: TW });
  assert.deepEqual(o, { address: EXT, kind: "wallet", locked: false });
  assert.equal(walletLabel(o, "Phantom"), "Phantom");
  assert.equal(walletLabel(o, null), "Connected wallet");
});

test("the owner: no trader and a locked trading wallet shows that wallet; nothing at all is no card", () => {
  const o = positionOwner({ traderKind: null, traderAddress: null, twStatus: "locked", twAddress: TW });
  assert.deepEqual(o, { address: TW, kind: "trading", locked: true });
  assert.equal(walletLabel(o, "Phantom"), "Trading wallet · locked");
  assert.equal(positionOwner({ traderKind: null, traderAddress: null, twStatus: "none", twAddress: null }), null);
  assert.equal(walletLabel(null, "Phantom"), "");
});

test("the mode: a balance not read yet is never a 0", () => {
  assert.equal(positionMode({ balance: null, valueUsd: null, priced: true, wasHeld: false }), "none");
  assert.equal(positionMode({ balance: null, valueUsd: null, priced: true, wasHeld: true }), "none");
});

test("the mode: dust is no card, a dollar is, and an unpriced coin held is shown", () => {
  assert.equal(positionMode({ balance: 5n, valueUsd: 0.4, priced: true, wasHeld: false }), "none");
  assert.equal(positionMode({ balance: 5n, valueUsd: 1, priced: true, wasHeld: false }), "held");
  assert.equal(positionMode({ balance: 5n, valueUsd: null, priced: false, wasHeld: false }), "held");
  assert.equal(DUST_USD, 1);
});

test("the mode: once held it stays held under the dust limit, turns closed at 0, and 0 without a visit is nothing", () => {
  assert.equal(positionMode({ balance: 5n, valueUsd: 0.3, priced: true, wasHeld: true }), "held");
  assert.equal(positionMode({ balance: 0n, valueUsd: 0, priced: true, wasHeld: true }), "closed");
  assert.equal(positionMode({ balance: 0n, valueUsd: 0, priced: true, wasHeld: false }), "none");
});

test("pnlForMint keeps only the coin's entry and everything else of the answer", () => {
  const a = pnl([OTHER, BOUGHT]);
  const one = pnlForMint(a, MINT);
  assert.ok(one);
  assert.deepEqual(one.coins, [BOUGHT]);
  assert.equal(one.history, a.history); assert.equal(one.ok, true); assert.equal(one.wallet, ME); assert.equal(one.at, a.at);
  assert.equal(a.coins.length, 2, "the answer itself is not changed");
  assert.equal(pnlForMint(null, MINT), null);
  assert.deepEqual(pnlForMint(pnl([OTHER]), MINT)?.coins, []);
});

test("the view: holding, value, cost and unrealized P&L, the same maths as the Portfolio", () => {
  const v = view();
  assert.equal(v.pnl, "ok");
  assert.equal(v.balance, 1_000_000);
  near(v.valueUsd, 200, "value");
  near(v.valueSol, 1_000_000 * (0.0002 / SOL_USD), "value in SOL");
  const r = v.row;
  assert.ok(r);
  near(r.avgCostUsd, 0.00015, "avg"); near(r.costUsd, 150, "cost"); near(r.unrealizedUsd, 50, "unrealized"); near(r.unrealizedPct, 1 / 3, "pct");
  assert.equal(r.partial, false);
  const same = buildPnl(pnl([BOUGHT, OTHER]), [{ mint: MINT, amount: units(1_000_000), valueUsd: 200 }], { quoteUsd: [[null, SOL_USD], [null, null]], dustUsd: DUST_USD }).byMint.get(MINT);
  assert.deepEqual(r, same);
  assert.equal(v.status, null);
});

test("the view: a wallet holding more than its trades explain is partial, and the P&L is of the bought part only", () => {
  const v = view({ balanceRaw: raw(1_500_000) });
  const r = v.row;
  assert.ok(r);
  assert.equal(r.partial, true);
  assert.equal(r.matched, 1_000_000);
  near(v.valueUsd, 300, "value of everything held");
  near(r.valueUsd, 200, "value of the bought part"); near(r.costUsd, 150); near(r.unrealizedUsd, 50);
});

test("the view: no recorded buy is no figure, never a zero", () => {
  const absent = view({ pnl: pnl([OTHER]) });
  assert.equal(absent.pnl, "ok");
  assert.equal(absent.row, null);
  const noCost = view({ pnl: pnl([coin(MINT, { sells: 1, soldBase: units(10), soldQuote: lamports(0.1) })]) });
  assert.ok(noCost.row);
  assert.equal(noCost.row.gap, "no-cost");
  assert.equal(noCost.row.unrealizedUsd, null);
  assert.equal(noCost.row.avgCostUsd, null);
});

test("the view: loading, failed, off, and the history line while it is read", () => {
  const loading = view({ pnl: null });
  assert.deepEqual([loading.pnl, loading.row, loading.status], ["loading", null, null]);
  const failed = view({ pnl: null, pnlError: true });
  assert.deepEqual([failed.pnl, failed.row, failed.status], ["failed", null, POSITION_FAILED]);
  assert.equal(POSITION_FAILED, "P&L could not be read just now.");
  const full = view({ pnl: pnl([], { history: { ...HIST, state: "full" } }) });
  assert.deepEqual([full.pnl, full.row, full.status], ["off", null, "P&L is not available right now."]);
  const down = view({ pnl: pnl([], { ok: false, history: null }) });
  assert.deepEqual([down.pnl, down.status], ["off", "P&L is not available right now."]);
  const running = view({ pnl: pnl([BOUGHT], { history: { ...HIST, state: "running", scanned: 120, total: 800 } }) });
  assert.equal(running.pnl, "ok");
  assert.equal(running.status, "Reading your trade history: 120 of 800 transactions.");
  assert.ok(running.row);
  near(running.row.unrealizedUsd, 50);
  // an answer that is there wins over a failed reload
  assert.equal(view({ pnlError: true }).pnl, "ok");
});

test("the view: after a trade the cost figures wait for the answer, the holding stays live", () => {
  const v = view({ stale: true, balanceRaw: raw(2_000_000) });
  assert.deepEqual([v.pnl, v.row, v.status], ["updating", null, POSITION_UPDATING]);
  assert.equal(POSITION_UPDATING, "Updating after your trade…");
  assert.equal(v.balance, 2_000_000);
  near(v.valueUsd, 400); near(v.valueSol, 2_000_000 * (0.0002 / SOL_USD));
  // loading still comes first (no answer to be stale against)
  assert.equal(view({ stale: true, pnl: null }).pnl, "loading");
});

test("pnlCaughtUp: a new trade of the coin, or another held amount, is caught up; the same answer is not", () => {
  const before = pnl([BOUGHT]);
  assert.equal(pnlCaughtUp(before, pnl([{ ...BOUGHT }]), MINT), false);
  assert.equal(pnlCaughtUp(before, pnl([{ ...BOUGHT, buys: 2 }]), MINT), true);
  assert.equal(pnlCaughtUp(before, pnl([{ ...BOUGHT, heldBase: units(900_000) }]), MINT), true);
  assert.equal(pnlCaughtUp(pnl([OTHER]), pnl([OTHER, BOUGHT]), MINT), true);
  assert.equal(pnlCaughtUp(null, pnl([BOUGHT]), MINT), false, "no answer before: the coin's presence may be its older trades");
  assert.equal(pnlCaughtUp(null, null, MINT), false);
  assert.equal(pnlCaughtUp(before, null, MINT), false);
  assert.equal(pnlCaughtUp(before, pnl([OTHER]), MINT), false, "the coin left the answer: nothing to catch up with");
  // another coin's trade does not count
  assert.equal(pnlCaughtUp(pnl([BOUGHT, OTHER]), pnl([BOUGHT, { ...OTHER, buys: 9 }]), MINT), false);
});

test("settleStep: an answer asked before the landing's first reload never ends the settle; with no answer before the landing it becomes the one compared with", () => {
  // the wallet traded FOO before and sold out (or kept dust); no answer existed when the landing was heard
  const old = pnl([{ ...BOUGHT, heldBase: "0", sells: 1 }]), now = pnl([{ ...BOUGHT, heldBase: units(2_000_000), buys: 2, sells: 1 }]);
  const s = { before: null, base: 0n, fired: 0, from: Infinity, multi: false, pre: false, lag: 0, landings: 1, moves: 0, seen: 0n };
  assert.equal(settleStep(s, old, 1, MINT), "baseline", "asked as the balance landed: from before the trade");
  const t = { ...s, before: old, fired: 1, from: 2 };
  assert.equal(settleStep(t, old, 2, MINT), "wait", "the first reload, the indexer not there yet");
  assert.equal(settleStep(t, now, 3, MINT), "end");
  assert.equal(settleStep({ ...t, before: null }, now, 3, MINT), "baseline", "nothing to compare with: the next reload decides");
  assert.equal(settleStep({ ...t, before: null, fired: LANDING_RELOADS_MS.length }, now, 3, MINT), "end", "after the last reload the answer is taken");
  assert.equal(settleStep({ ...t, fired: LANDING_RELOADS_MS.length }, now, 1, MINT), "baseline", "but not one asked before the first reload");
});

test("settleStep: two landings close together end only with the last reload, not with an answer that holds the first trade", () => {
  const a = pnl([BOUGHT]), first = pnl([{ ...BOUGHT, buys: 2, heldBase: units(2_000_000) }]);
  const s = { before: a, base: raw(1_000_000), fired: 1, from: 5, multi: true, pre: true, lag: 0, landings: 2, moves: 0, seen: raw(1_000_000) };
  assert.equal(settleStep(s, first, 6, MINT), "wait");
  assert.equal(settleStep({ ...s, fired: 2 }, first, 7, MINT), "wait");
  assert.equal(settleStep({ ...s, fired: LANDING_RELOADS_MS.length }, first, 8, MINT), "end");
  assert.equal(settleStep({ ...s, multi: false }, first, 6, MINT), "end", "one landing: an answer that moved has caught up");
});

test("the view: a position closed during the visit keeps its realized result", () => {
  const sold = coin(MINT, { boughtBase: units(1_000_000), boughtQuote: lamports(1), soldBase: units(1_000_000), soldQuote: lamports(1.2), realizedQuote: lamports(0.2), costQuote: "0", heldBase: "0", buys: 1, sells: 2 });
  const v = view({ mode: "closed", balanceRaw: 0n, pnl: pnl([sold]) });
  assert.equal(v.mode, "closed");
  assert.ok(v.row);
  assert.equal(v.row.held, false);
  near(v.row.realizedUsd, 30); near(v.row.realizedPct, 0.2);
  assert.ok((v.row.realizedUsd ?? 0) > 0);
  assert.equal(v.status, "You no longer hold $FOO.");
  assert.equal(closedNote("$FOO"), "You no longer hold $FOO.");
  // the history line comes before the closed note
  assert.equal(view({ mode: "closed", balanceRaw: 0n, pnl: pnl([sold], { history: { ...HIST, unread: 2 } }) }).status, "Some trades may be missing.");
});

test("numbers: without any price nothing is NaN or Infinity", () => {
  for (const o of [
    { priceUsd: null, priceSol: null },
    { priceUsd: null, priceSol: null, solUsd: null, pnl: pnl([coin(MINT, { costQuote: lamports(1), heldBase: units(1_000_000), costUsdNow: null, buys: 1 })]) },
    { priceUsd: Number.NaN, priceSol: Number.POSITIVE_INFINITY },
    { balanceRaw: null, priceUsd: null, priceSol: null },
    { decimals: Number.NaN },
  ]) {
    const v = view(o);
    if (o.priceUsd === null) { assert.equal(v.valueUsd, null); assert.equal(v.valueSol, null); }
    assertFinite(v);
    for (const x of [v.balance, v.valueUsd, v.valueSol]) assert.ok(x === null || Number.isFinite(x));
  }
});

test("Portfolio's notes moved to lib/pnl.ts unchanged", () => {
  assert.equal(PNL_NOTE, "P&L is valued at today's price of SOL or the parent coin. Network fees and tips are not included.");
  assert.equal(APPROX_NOTE, "Approximate: some tokens were received without a recorded buy, so they are left out");
  assert.equal(DUST_USD, 1);
});

test("the card's figures: a partial Avg buy (a price per token far below a cent) carries the ~ mark; a dollar figure that rounds to nothing does not", () => {
  // the wallet holds 1.5M FOO, its trades explain 1M: partial, avg buy $0.00015
  const v = view({ balanceRaw: raw(1_500_000) });
  assert.ok(v.row && v.row.partial);
  near(v.row.avgCostUsd, 0.00015);
  const html = (f: { text: unknown }) => renderToStaticMarkup(createElement(Fragment, null, f.text as never));
  const avg = html(avgFig("ok", v.row));
  assert.match(avg, /pos-approx/);
  assert.match(avg, /approximately /);
  assert.doesNotMatch(html(avgFig("ok", view().row)), /pos-approx/, "a whole row: no mark");
  assert.doesNotMatch(html(unrealizedFig("ok", { ...v.row, unrealizedUsd: 0.001 })), /pos-approx/, "a dollar figure under half a cent");
});

test("the card's figures: while updating after a trade every cost cell keeps its small line (the card keeps its height)", () => {
  const ok = view({ pnl: pnl([{ ...BOUGHT, soldBase: units(1), soldQuote: lamports(0.000002), sells: 1 }]) });
  for (const f of [avgFig, unrealizedFig, realizedFig]) {
    assert.ok(f("ok", ok.row).sub, `${f.name} has a small line when ok`);
    const u = f("updating", null);
    assert.deepEqual([u.text, u.busy, !!u.sub], ["…", true, true], f.name);
  }
});

test("a settle that ends with the answer not caught up with a sell of this coin leaves the figures behind: marked, never 'nothing sold', and asked again past the server's minute", () => {
  // the wallet bought FOO before and sold all of it here; every reload's answer is still the one from before the sell
  const before = pnl([BOUGHT]), s = { before, base: raw(1_000_000), fired: LANDING_RELOADS_MS.length, from: 2, multi: false, pre: true, lag: 0, landings: 1, moves: 0, seen: raw(1_000_000) };
  assert.equal(settleStep(s, before, 4, MINT), "end", "the last reload's answer ends the settle as it is");
  assert.deepEqual(settleBehind(s, before, 0n, MINT), { ans: before, n: 1 }, "the balance moved, the answer did not");
  assert.equal(settleBehind(s, pnl([{ ...BOUGHT, heldBase: "0", soldBase: units(1_000_000), soldQuote: lamports(1.2), realizedQuote: lamports(0.2), sells: 1 }]), 0n, MINT), null, "caught up");
  assert.equal(settleBehind(s, before, raw(1_000_000), MINT), null, "another coin's trade: this balance did not move");
  assert.equal(settleBehind({ ...s, before: null }, before, 0n, MINT), null, "nothing to compare with");
  assert.equal(settleBehind(s, before, null, MINT), null, "the balance not known");
  assert.equal(settleBehind({ ...s, pre: false }, before, 0n, MINT), null, "an answer taken after the landing is not known to be from before the trade");
  // the card: closed, Realized says the trade is not counted yet rather than "nothing sold"
  const closed = view({ mode: "closed", balanceRaw: 0n, pnl: before, behind: true });
  assert.deepEqual([closed.pnl, closed.behind, closed.status], ["ok", true, POSITION_BEHIND]);
  const html = (f: { text: unknown }) => renderToStaticMarkup(createElement(Fragment, null, f.text as never));
  const r = realizedFig(closed.pnl, closed.row, closed.behind);
  assert.deepEqual([r.text, r.sub], ["—", "not counted yet"]);
  assert.equal(realizedFig("ok", closed.row).sub, "nothing sold", "without behind: unchanged");
  // a partial sell: Avg buy, Unrealized and Realized all carry the mark
  const sold = coin(MINT, { boughtBase: units(1_000_000), boughtQuote: lamports(1), soldBase: units(500_000), soldQuote: lamports(0.6), realizedQuote: lamports(0.1), costQuote: lamports(0.5), heldBase: units(500_000), buys: 1, sells: 1 });
  const held = view({ balanceRaw: raw(250_000), pnl: pnl([sold]), behind: true });
  assert.ok(held.row && !held.row.partial, "the balance below heldBase is not flagged partial by the join");
  for (const f of [avgFig, unrealizedFig, realizedFig]) assert.match(html(f(held.pnl, held.row, held.behind)), /pos-approx/, f.name);
  assert.doesNotMatch(html(avgFig(held.pnl, held.row)), /pos-approx/, "without behind: no mark");
  // updating comes first; behind only shows with an ok answer
  assert.deepEqual([view({ stale: true, behind: true }).behind, view({ stale: true, behind: true }).status], [false, POSITION_UPDATING]);
  // the follow-ups come after the settle has ended and past the server's once-a-minute cut-log check
  assert.ok(BEHIND_RELOADS_MS[0] > LANDING_RELOADS_MS.at(-1)! + SETTLE_GIVE_UP_MS && BEHIND_RELOADS_MS[0] > 60_000);
});

test("a first buy with no answer before it: an answer that already counts it ends the settle and never marks the figures behind", () => {
  // the wallet held none of FOO, so nothing was asked before the buy; the first answer (asked once the balance
  // landed, or the +4 s one after a failed ask) already counts the buy of 1M FOO
  const s = landingSettle(null, null, null, 0n);
  assert.deepEqual([s.pre, s.multi, s.lag, s.before], [false, false, 0, null]);
  const ans = pnl([BOUGHT]), X = raw(1_000_000);
  assert.equal(settleStep(s, ans, 1, MINT, X), "end", "its holding is the balance now: counted, no 20 s of updating");
  assert.equal(settleStep({ ...s, fired: 1, from: 1 }, ans, 1, MINT, X), "end", "the same for the +4 s answer");
  // a holding that does not match (tokens received outside a trade): the baseline is taken, the last reload ends it
  const t = { ...s, before: ans, fired: LANDING_RELOADS_MS.length, from: 2 };
  assert.equal(settleStep(s, ans, 1, MINT, raw(1_500_000)), "baseline");
  assert.equal(settleStep(t, ans, 4, MINT, raw(1_500_000)), "end");
  assert.equal(settleBehind(t, ans, raw(1_500_000), MINT), null, "never marked: the baseline may already count the trade");
  assert.equal(settleBehind(t, ans, X, MINT), null);
  // an answer held before the landing is still compared with as before
  const p = landingSettle(null, null, pnl([OTHER]), 0n);
  assert.deepEqual([p.pre, p.multi], [true, false]);
  assert.equal(settleStep({ ...p, fired: 1, from: 2 }, pnl([OTHER]), 2, MINT, X), "wait");
  assert.deepEqual(settleBehind({ ...p, fired: 3, from: 2 }, pnl([OTHER]), X, MINT), { ans: pnl([OTHER]), n: 1 });
});

test("a trade while the figures are behind: an answer that catches up with the earlier trade only neither ends the settle nor clears the mark", () => {
  // trade 1 (a buy of 1M FOO) ended behind B0; trade 2 sells 400k; answer A counts trade 1 only, C counts both
  const B0 = pnl([OTHER]), A = pnl([OTHER, BOUGHT]);
  const C = pnl([OTHER, { ...BOUGHT, soldBase: units(400_000), soldQuote: lamports(0.5), realizedQuote: lamports(0.1), costQuote: lamports(0.6), heldBase: units(600_000), sells: 1 }]);
  const b1 = raw(1_000_000), b2 = raw(600_000);
  const s0 = landingSettle(null, { ans: B0, n: 1 }, pnl([OTHER]), b1);
  assert.deepEqual([s0.before, s0.multi, s0.pre, s0.lag, s0.base], [B0, true, true, 1, b1]);
  const s = { ...s0, fired: 1, from: 5 };
  assert.equal(settleStep(s, A, 5, MINT, b2), "wait", "A caught up with trade 1 only");
  const last = { ...s, fired: LANDING_RELOADS_MS.length };
  assert.equal(settleStep(last, A, 7, MINT, b2), "end");
  assert.deepEqual(settleBehind(last, A, b2, MINT), { ans: B0, n: 2 }, "still marked: trade 2 is not counted");
  assert.equal(pnlCaughtUp(B0, A, MINT, 2), false);
  assert.equal(pnlCaughtUp(B0, C, MINT, 2), true, "both counted: the mark clears");
  assert.equal(settleBehind(last, C, b2, MINT), null);
  // trade 2 of another coin: the earlier trade alone is what is behind
  assert.deepEqual(settleBehind(last, B0, b1, MINT), { ans: B0, n: 1 });
  assert.equal(settleBehind(last, A, b1, MINT), null);
  // a landing during a settle keeps that settle's answer, balance and flags
  const m = landingSettle({ before: B0, base: b1, fired: 2, from: 3, multi: false, pre: false, lag: 0, landings: 1, moves: 0, seen: b1 }, null, A, b2);
  assert.deepEqual([m.before, m.base, m.fired, m.from, m.multi, m.pre], [B0, b1, 0, Infinity, true, false]);
});

test("a buy then a sell of this coin in one settle are two trades: an answer counting the buy only leaves the figures behind, also when the sell brought the balance back", () => {
  const B0 = pnl([OTHER]), A = pnl([OTHER, BOUGHT]);
  const C = pnl([OTHER, { ...BOUGHT, soldBase: units(400_000), soldQuote: lamports(0.5), realizedQuote: lamports(0.1), costQuote: lamports(0.6), heldBase: units(600_000), sells: 1 }]);
  // the buy lands (0 → 1M), then the sell (→ 600k) while it settles
  const s1 = landingSettle(null, null, B0, 0n);
  settleSaw(s1, raw(1_000_000));
  const s = { ...landingSettle(s1, null, B0, raw(1_000_000)), fired: LANDING_RELOADS_MS.length, from: 2 };
  settleSaw(s, raw(600_000));
  assert.deepEqual([s.landings, s.moves, s.multi, s.pre, settleTrades(s, raw(600_000))], [2, 2, true, true, 2]);
  assert.equal(settleStep(s, A, 4, MINT, raw(600_000)), "end", "the last reload");
  assert.deepEqual(settleBehind(s, A, raw(600_000), MINT), { ans: B0, n: 2 }, "A counts the buy only: still behind");
  assert.equal(settleBehind(s, C, raw(600_000), MINT), null, "both counted");
  // the sell before the store read the buy: one move seen, the second one pending, still two
  const r = landingSettle(landingSettle(null, null, B0, 0n), null, B0, 0n);
  assert.equal(settleTrades(r, raw(600_000)), 1, "one read change over two landings: one move known");
  // a buy and a sell of all of it: the balance is back where it began, both trades are missing
  const z = { ...landingSettle(s1, null, B0, raw(1_000_000)), fired: LANDING_RELOADS_MS.length, from: 2 };
  settleSaw(z, 0n);
  assert.deepEqual(settleBehind(z, B0, 0n, MINT), { ans: B0, n: 2 }, "nothing counted: marked, not passed over");
  // another coin's landing moves nothing; a read that changed twice in one landing is one trade
  const o = landingSettle(null, null, B0, raw(5));
  assert.equal(settleBehind({ ...o, fired: LANDING_RELOADS_MS.length }, B0, raw(5), MINT), null);
  settleSaw(o, raw(7)); settleSaw(o, raw(9));
  assert.equal(settleTrades(o, raw(9)), 1);
});

test("a landing's settle starts from the balance as it is heard: a change before it (a transfer, a read that came late) is not its trade and never marks the figures", () => {
  // trade 1 was counted (A), the balance read caught up only later (1M); then another coin's trade lands
  const A = pnl([OTHER, BOUGHT]), now = raw(1_000_000);
  const s = { ...landingSettle(null, null, A, now), fired: LANDING_RELOADS_MS.length, from: 2 };
  assert.equal(settleTrades(s, now), 0, "nothing moved: not updating");
  assert.equal(settleBehind(s, A, now, MINT), null, "not marked behind");
  // from a balance kept from before that read, the same landing would read as a trade of this coin never counted
  const old = { ...landingSettle(null, null, A, 0n), fired: LANDING_RELOADS_MS.length, from: 2 };
  assert.deepEqual(settleBehind(old, A, now, MINT), { ans: A, n: 1 });
});

test("the card's figures: every cost cell has its small line in every state (loading, failed, off, no row, no cost, no percent, unknown realized), so the card keeps its height", () => {
  const ok = view({ pnl: pnl([{ ...BOUGHT, soldBase: units(1), soldQuote: lamports(0.000002), sells: 1 }]) });
  const rows = [null, ok.row, ok.row && { ...ok.row, gap: "no-cost" as const }, ok.row && { ...ok.row, unrealizedPct: null }, ok.row && { ...ok.row, realizedUsd: null }];
  for (const f of [avgFig, unrealizedFig, realizedFig]) {
    for (const st of ["loading", "failed", "off", "updating"] as const) assert.ok(f(st, null).sub, `${f.name} ${st}`);
    for (const [i, r] of rows.entries()) for (const behind of [false, true]) assert.ok(f("ok", r, behind).sub, `${f.name} row ${i} behind ${behind}`);
  }
});

test("a card mounted again as the page crosses the phone breakpoint takes the visit over (held, settle, behind, answer); a new wallet or coin, or a page visited again, starts over", () => {
  const K = `${ME}:${MINT}`, T = 1_800_000_000_000;
  const v = visitFor(K, T), leave = visitMount(v);
  v.held.current = true; v.settle.current = landingSettle(null, null, pnl([BOUGHT]), raw(1)); v.behind.current = { ans: pnl([]), n: 1 }; v.latest.current = pnl([BOUGHT]);
  // the desktop card renders while the phone one is still mounted, then the phone one leaves in the same commit
  const w = visitFor(K, T + 5_000);
  assert.equal(w, v, "the same visit");
  leave(T + 5_001);
  const leave2 = visitMount(w);
  assert.deepEqual([w.held.current, !!w.settle.current, w.behind.current?.n, w.latest.current?.coins.length], [true, true, 1, 1]);
  leave2(T + 6_000);
  assert.equal(visitFor(K, T + 6_000 + VISIT_HANDOFF_MS - 1), v, "a remount right after it left");
  const later = visitFor(K, T + 6_000 + VISIT_HANDOFF_MS + 1);
  assert.notEqual(later, v, "the page left and came back: a new visit");
  assert.deepEqual([later.held.current, later.settle.current, later.behind.current, later.latest.current, later.answeredAt.current], [false, null, null, null, 0]);
  // another wallet while one is mounted, then back: starts over
  visitMount(later);
  const other = visitFor(`${TW}:${MINT}`, T + 10_000);
  assert.notEqual(other, later);
  assert.notEqual(visitFor(K, T + 10_001), later, "A → B → A starts over");
});
