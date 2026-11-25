// The trending gate (lib/trend-gate.mjs): counted buyers by the spec's rules, the capped inflow, the demote checks, the
// window, and what a passing launch hands over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TrendGate } from "../lib/trend-gate.mjs";

const T0 = 1_795_000_000, SOL = 1e9;
const create = (mint = "M", creator = "CR", t = T0) => ({ mint, creator, timestamp: t, symbol: "SYM", name: "Sym" });
const tr = (user, sol, { buy = true, t = T0 + 30, mint = "M" } = {}) => ({ mint, user, isBuy: buy, quoteAmount: String(Math.round(sol * SOL)), timestamp: t });
const gate = (cfg = {}) => { const passed = []; const g = new TrendGate({ cfg: { minCounted: 3, minInflowSol: 1, uni: 1, conc: 1, ...cfg }, onPass: (c, why) => passed.push({ c, why }), now: () => (T0 + 60) * 1000 }); return { g, passed }; };
let slot = 100;
const feed = (g, e, s = (slot += 10)) => g.trade(e, `sig${slot}`, s, 0);

test("trend gate: distinct real buyers with enough inflow pass; the passing launch carries its create and every trade seen", () => {
  const { g, passed } = gate();
  g.create(create(), 100);
  feed(g, tr("A", 0.5)); feed(g, tr("B", 0.4));
  assert.equal(passed.length, 0);
  feed(g, tr("C", 0.3, { t: T0 + 45 }));
  assert.equal(passed.length, 1);
  const { c, why } = passed[0];
  assert.equal(c.create.mint, "M");
  assert.equal(c.trades.length, 3);
  assert.deepEqual([why.counted, why.inflowSol, why.secs], [3, 1.2, 45]);
  assert.equal(g.has("M"), false, "a passed launch is no longer watched");
  feed(g, tr("D", 1));
  assert.equal(passed.length, 1, "nothing more after the pass");
});

test("trend gate: the creator, early-slot and early-second buyers, dust, flippers, heavy traders and spray wallets are not counted", () => {
  const { g, passed } = gate({ earlyAfterS: 20, sprayCoins: 2, maxTradesPerWallet: 3 });
  // spray wallet S first-buys two other watched coins in the hour before
  for (const m of ["X1", "X2"]) { g.create(create(m), 50); g.trade(tr("S", 0.2, { mint: m, t: T0 - 100 }), "s", 60, 0); }
  g.create(create("M", "CR"), 100);
  feed(g, tr("CR", 2));                         // creator
  feed(g, tr("E1", 2), 102);                    // within create slot + 3
  feed(g, tr("E2", 2, { t: T0 + 10 }));         // within the first 20 s
  feed(g, tr("DUST", 0.01));                    // under 0.05 SOL net
  feed(g, tr("F", 1)); feed(g, tr("F", 0.9, { buy: false, t: T0 + 60 })); // sold 90% within 120 s
  for (let i = 0; i < 4; i++) feed(g, tr("H", 0.2));                  // 4 trades > 3
  feed(g, tr("S", 1));                          // spray
  assert.equal(passed.length, 0);
  const c = g.watched.get("M");
  assert.equal(c.counted, 0);
  feed(g, tr("A", 0.6)); feed(g, tr("B", 0.6)); feed(g, tr("C", 0.6));
  assert.equal(passed.length, 1);
});

test("trend gate: inflow is capped per wallet; a demote check blocks the pass; the window ends counting; sweep drops expired launches", () => {
  const { g, passed } = gate({ minInflowSol: 4, capSol: 1 });
  g.create(create(), 100);
  feed(g, tr("A", 10)); feed(g, tr("B", 10)); feed(g, tr("C", 1.5));
  assert.equal(passed.length, 0, "3 wallets capped at 1 SOL each: 3 < 4");
  assert.equal(Math.round(g.watched.get("M").inflow * 10) / 10, 3);

  const u = gate({ uni: 0.3 });
  u.g.create(create("U"), 100);
  for (const w of ["A", "B", "C", "D"]) feed(u.g, tr(w, 0.5, { mint: "U" })); // every buy the same size: uniformity 100%
  assert.equal(u.passed.length, 0);
  assert.deepEqual(u.g.demoteOf(u.g.watched.get("U")).fails, ["size uniformity"]);

  const w = gate({ windowS: 60 });
  w.g.create(create("W"), 100);
  feed(w.g, tr("A", 0.5, { mint: "W", t: T0 + 30 })); feed(w.g, tr("B", 0.6, { mint: "W", t: T0 + 90 })); feed(w.g, tr("C", 0.7, { mint: "W", t: T0 + 95 }));
  assert.equal(w.passed.length, 0, "trades after the window do not count");
  w.g.sweep(T0 + 200);
  assert.equal(w.g.has("W"), false);
  assert.equal(w.g.snapshot().expired, 1);
});

test("trend gate: at most maxWatched launches are kept, oldest dropped first", () => {
  const { g } = gate({ maxWatched: 2 });
  g.create(create("A"), 1); g.create(create("B"), 2); g.create(create("C"), 3);
  assert.deepEqual([...g.watched.keys()], ["B", "C"]);
  assert.equal(g.snapshot().dropped, 1);
});

test("trend gate: a flip stays a flip after the wallet buys again; past maxTrades a launch stops counting and keeps its last event", () => {
  const { g, passed } = gate();
  g.create(create(), 100);
  feed(g, tr("F", 1, { t: T0 + 20 })); feed(g, tr("F", 0.9, { buy: false, t: T0 + 40 })); feed(g, tr("F", 5, { t: T0 + 300 }));
  assert.equal(g.watched.get("M").w.get("F").k, -1, "bought again after flipping: still not counted");
  feed(g, tr("A", 0.6)); feed(g, tr("B", 0.6));
  assert.equal(passed.length, 0);

  const f = gate({ maxTrades: 2 });
  f.g.create(create("Q"), 100);
  feed(f.g, tr("A", 0.6, { mint: "Q" })); feed(f.g, tr("B", 0.6, { mint: "Q" })); feed(f.g, tr("C", 0.6, { mint: "Q" }));
  assert.equal(f.passed.length, 0, "the third buyer came past the cap: not counted");
  const c = f.g.watched.get("Q");
  assert.deepEqual([c.trades.length, c.full, c.last.user], [2, true, "C"]);
});
