// The Portfolio page's two lists (web/src/lib/portfolio.ts): HOLDINGS (coins the wallet bought) and SPORES (the pairs
// it launched, by parent coin), from /api/portfolio/:wallet and the claim rows of /api/claims/:wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaimCoin, Portfolio, PortfolioCoin, PortfolioHolding } from "../src/lib/api.ts";
const { buildPortfolio, claimableRows } = await import("../src/lib/portfolio.ts");

const ME = "Me11111111111111111111111111111111111111111";
const ref = (mint: string) => ({ mint, name: `${mint} coin`, symbol: mint, image: null });
const coin = (mint: string, parent: string | null, o: Partial<PortfolioCoin> = {}): PortfolioCoin => ({
  mint, name: `${mint} coin`, symbol: mint, image: null, depth: parent ? 1 : 0, parent: parent ? ref(parent) : null, creator: "someone",
  mcapUsd: null, priceUsd: null, vol24Usd: null, trades1h: null, lastTradeAt: null, graduated: false, createdAt: null, ...o,
});
const mine = (mint: string, parent: string | null, o: Partial<PortfolioCoin> = {}) => coin(mint, parent, { creator: ME, ...o });
const hold = (c: PortfolioCoin, valueUsd: number | null, uiAmount = 10): PortfolioHolding => ({ mint: c.mint, amount: String(uiAmount * 1e6), decimals: 6, uiAmount, valueUsd, coin: c });
const pf = (holdings: PortfolioHolding[], launched: PortfolioCoin[] = [], o: Partial<Portfolio> = {}): Portfolio => ({
  wallet: ME, at: 1_800_000_000, solLamports: "1000000000", holdingsOk: true, holdings, untracked: 0, launched, launchedTotal: launched.length, ...o,
});
const claim = (mint: string, yourAmount: string, yourUsd: number | null, o: Partial<ClaimCoin> = {}): ClaimCoin => ({
  mint, name: `${mint} coin`, symbol: mint, image: null, depth: 1, quoteMint: "P", quoteSymbol: "P", quoteDecimals: 6, quoteUsd: 1,
  shares: [{ address: ME, bps: 5000 }], bucket: "0", vault: "0", amm: "0", total: String(BigInt(yourAmount) * 2n), totalUsd: yourUsd === null ? null : yourUsd * 2,
  perShare: [{ address: ME, bps: 5000, amount: yourAmount }], migrated: false, claimable: true, reason: null, updatedAt: 1_800_000_000,
  yourBps: 5000, yourAmount, yourUsd, ...o,
});
const SOL = { depth: 0, quoteMint: null, quoteSymbol: "SOL", quoteDecimals: 9 };
const mints = (rows: { coin: PortfolioCoin }[]) => rows.map((r) => r.coin.mint);
const ZERO = { valueUsd: 0, unpriced: 0, held: 0, holdings: 0, spores: 0, sporeTotal: 0, launched: 0, groups: 0, claimUsd: 0, claimable: 0 };

test("nothing in, nothing out", () => {
  for (const v of [buildPortfolio(null), buildPortfolio(undefined), buildPortfolio(pf([]))]) {
    assert.deepEqual(v.holdings, []);
    assert.deepEqual(v.groups, []);
    assert.deepEqual(v.totals, ZERO);
    assert.deepEqual(claimableRows(v), []);
  }
});

test("a coin the wallet only bought is a holding and makes no spore card", () => {
  // $Poly under $POLYMARKET, bought and not launched
  const poly = coin("Poly", "POLYMARKET");
  const v = buildPortfolio(pf([hold(poly, 12)]));
  assert.deepEqual(mints(v.holdings), ["Poly"]);
  assert.deepEqual([v.holdings[0].spore, v.holdings[0].launched, v.holdings[0].feeShare], [false, false, false]);
  assert.deepEqual(v.holdings[0].held, { amount: "10000000", decimals: 6, uiAmount: 10, valueUsd: 12 });
  assert.deepEqual(v.holdings[0].coin.parent, ref("POLYMARKET"));
  assert.deepEqual(v.groups, []);
  assert.deepEqual(v.totals, { ...ZERO, valueUsd: 12, held: 1, holdings: 1 });
});

test("a held root coin the wallet did not launch is a holding too", () => {
  const v = buildPortfolio(pf([hold(coin("R", null), 3)]));
  assert.deepEqual([mints(v.holdings), v.groups.length], [["R"], 0]);
});

test("a launched child is a row of its parent's card and never a holding, also when the wallet holds it", () => {
  const a = mine("A", "P"), b = coin("B", "P", { creator: "someone" }), c = mine("C", "Q");
  // B: in the server's launched list although its creator field names someone else (the list decides)
  const v = buildPortfolio(pf([hold(a, 70)], [a, b, c]));
  assert.deepEqual(v.holdings, []);
  assert.deepEqual(v.groups.map((g) => g.mint), ["P", "Q"]);
  const p = v.groups[0];
  assert.equal(p.self, null);
  assert.deepEqual(p.parent, ref("P"));
  assert.deepEqual(mints(p.rows), ["A", "B"]);
  assert.deepEqual(p.rows.map((r) => [r.launched, r.feeShare, r.spore, r.held?.valueUsd ?? null]), [[true, false, true, 70], [true, false, true, null]]);
  assert.equal(p.valueUsd, 70);
  assert.deepEqual(mints(v.groups[1].rows), ["C"]);
  assert.deepEqual(v.totals, { ...ZERO, valueUsd: 70, held: 1, holdings: 0, spores: 3, sporeTotal: 3, launched: 3, groups: 2 });
});

test("a coin the wallet created counts as launched from its creator field alone", () => {
  const v = buildPortfolio(pf([hold(mine("A", "P"), 5)]));
  assert.deepEqual(v.holdings, []);
  assert.deepEqual(mints(v.groups[0].rows), ["A"]);
});

test("a held parent with a launched child under it: the parent is a holding, the card's header carries no holding", () => {
  const p = coin("P", null), a = mine("A", "P");
  const v = buildPortfolio(pf([hold(p, 40)], [a]));
  assert.deepEqual(mints(v.holdings), ["P"]);
  assert.equal(v.groups.length, 1);
  const g = v.groups[0];
  assert.deepEqual([g.mint, g.self, g.tracked, g.valueUsd], ["P", null, true, 0]);
  assert.deepEqual(mints(g.rows), ["A"]);
  assert.deepEqual(v.totals, { ...ZERO, valueUsd: 40, held: 1, holdings: 1, spores: 1, sporeTotal: 1, launched: 1, groups: 1 });
});

test("a launched root with launched children: the header is a spore with its claim and what is held of it", () => {
  const p = mine("P", null), a = mine("A", "P");
  const v = buildPortfolio(pf([hold(p, 40), hold(a, 5)], [p, a]), [claim("P", "2000000000", 300, SOL), claim("A", "500", 2)]);
  assert.deepEqual(v.holdings, []);
  assert.equal(v.groups.length, 1);
  const g = v.groups[0];
  assert.equal(g.self?.coin.mint, "P");
  assert.deepEqual([g.self?.launched, g.self?.spore, g.self?.held?.valueUsd], [true, true, 40]);
  assert.deepEqual([g.self?.claim?.amount, g.self?.claim?.quoteSymbol], ["2000000000", "SOL"]);
  assert.deepEqual(mints(g.rows), ["A"]);
  assert.deepEqual([g.valueUsd, g.claimUsd, g.tracked], [45, 302, true]);
  assert.deepEqual(claimableRows(v).map((r) => r.mint), ["P", "A"]);
});

test("a launched root with no spores under it is a header-only card", () => {
  const v = buildPortfolio(pf([], [mine("S", null)]));
  assert.deepEqual(v.groups.map((g) => [g.mint, g.self?.coin.mint, g.rows.length]), [["S", "S", 0]]);
});

test("a launched child that is the parent of other launches is a row under its parent and the header of its own card", () => {
  const mid = mine("M", "P"), leaf = mine("L", "M", { depth: 2 });
  const v = buildPortfolio(pf([hold(mid, 20), hold(leaf, 3)], [mid, leaf]));
  assert.deepEqual(v.holdings, []);
  assert.deepEqual(v.groups.map((g) => g.mint), ["M", "P"]);
  assert.equal(v.groups[0].self?.coin.mint, "M");
  assert.deepEqual(mints(v.groups[0].rows), ["L"]);
  assert.equal(v.groups[1].self, null);
  assert.deepEqual(mints(v.groups[1].rows), ["M"]);
  // each coin counts once
  assert.deepEqual([v.totals.valueUsd, v.totals.spores, v.totals.held], [23, 2, 2]);
});

test("a bought child under a bought child: two holdings, no card", () => {
  const v = buildPortfolio(pf([hold(coin("M", "P"), 20), hold(coin("L", "M", { depth: 2 }), 3)]));
  assert.deepEqual([mints(v.holdings), v.groups.length], [["M", "L"], 0]);
});

test("a coin known only from its claim row is a spore row tagged fee share", () => {
  const v = buildPortfolio(pf([]), [claim("X", "900", 4), claim("ROOT", "100", 1, SOL)]);
  assert.deepEqual(v.holdings, []);
  assert.deepEqual(v.groups.map((g) => g.mint), ["P", "ROOT"]);
  assert.deepEqual(v.groups[0].parent, { mint: "P", name: null, symbol: "P", image: null });
  assert.equal(v.groups[0].self, null);
  assert.deepEqual(mints(v.groups[0].rows), ["X"]);
  const x = v.groups[0].rows[0];
  assert.deepEqual([x.launched, x.feeShare, x.spore, x.held, x.claim?.amount], [false, true, true, null, "900"]);
  // a fee-share root heads its own card
  assert.deepEqual([v.groups[1].self?.coin.mint, v.groups[1].self?.feeShare, v.groups[1].rows.length], ["ROOT", true, 0]);
  assert.deepEqual([v.totals.spores, v.totals.sporeTotal, v.totals.launched, v.totals.claimUsd, v.totals.claimable], [2, 2, 0, 5, 2]);
  assert.deepEqual(claimableRows(v).map((r) => r.mint), ["X", "ROOT"]);
});

test("fee share: a held coin counts with any share, a coin not held only while a part is waiting", () => {
  const a = coin("A", "P"), b = coin("B", "P");
  const v = buildPortfolio(pf([hold(a, 8), hold(b, 2)]), [claim("A", "0", 0), claim("GONE", "0", 0), claim("B", "0", 0, { yourBps: 0 })]);
  // A: held, in the split, nothing waiting: it stays among the spores (it does not jump lists after a claim)
  assert.deepEqual(mints(v.groups[0].rows), ["A"]);
  assert.deepEqual([v.groups[0].rows[0].feeShare, v.groups[0].rows[0].claim, v.groups[0].valueUsd], [true, null, 8]);
  // B: held, not in the split: a holding. GONE: not held, nothing waiting: not listed
  assert.deepEqual(mints(v.holdings), ["B"]);
  assert.equal(v.totals.spores, 1);
});

test("claims join by mint: only a part above zero shows, only a claimable one counts", () => {
  const a = mine("A", "P"), b = mine("B", "P"), c = mine("C", "P");
  const v = buildPortfolio(pf([], [a, b, c]), [claim("A", "500", 2), claim("B", "0", 0), claim("C", "700", 9, { claimable: false, reason: "holder-reward coin" })]);
  const by = Object.fromEntries(v.groups[0].rows.map((r) => [r.coin.mint, r]));
  assert.deepEqual([by.A.claim?.amount, by.A.claim?.usd, by.A.claim?.claimable], ["500", 2, true]);
  assert.equal(by.B.claim, null);
  assert.equal(by.C.claim?.claimable, false);
  // launched coins are never tagged fee share
  assert.deepEqual([by.A.feeShare, by.B.feeShare, by.C.feeShare], [false, false, false]);
  assert.equal(v.groups[0].claimUsd, 2);
  assert.deepEqual([v.totals.claimUsd, v.totals.claimable], [2, 1]);
  assert.deepEqual(claimableRows(v).map((r) => r.mint), ["A"]);
});

test("claimableRows follow the page: card by card, the header's coin first, each coin once", () => {
  const p = mine("P", null), m = mine("M", "P"), l = mine("L", "M", { depth: 2 }), z = mine("Z", "Q");
  const v = buildPortfolio(pf([hold(z, 500), hold(coin("H", "P"), 900)], [p, m, l, z]), [
    claim("L", "10", 1, { quoteMint: "M", quoteSymbol: "M" }), claim("M", "10", 1), claim("P", "10", 1, SOL), claim("Z", "10", 1, { quoteMint: "Q", quoteSymbol: "Q" }),
  ]);
  assert.deepEqual(mints(v.holdings), ["H"]);
  assert.deepEqual(v.groups.map((g) => g.mint), ["Q", "M", "P"]);
  assert.deepEqual(claimableRows(v).map((r) => r.mint), ["Z", "M", "L", "P"]);
});

test("a parent the index does not track keeps its bare record", () => {
  // a depth-0 coin quoted in a listed asset: the asset is its parent and is not a coin of the index
  const a = mine("A", "USDC", { depth: 0, parent: { mint: "USDC", name: null, symbol: "USDC", image: null } });
  const g = buildPortfolio(pf([], [a])).groups[0];
  assert.deepEqual(g.parent, { mint: "USDC", name: null, symbol: "USDC", image: null });
  assert.deepEqual([g.self, g.tracked], [null, false]);
});

test("a parent whose name the server has not read yet is still a coin of the index", () => {
  // a spawn (depth 1) under P: P is a pump coin whatever its record holds, so the card offers a child under it
  const nameless = { mint: "P", name: null, symbol: null, image: null };
  let g = buildPortfolio(pf([], [mine("A", "P", { parent: nameless })])).groups[0];
  assert.deepEqual(g.parent, nameless);
  assert.deepEqual([g.self, g.tracked, mints(g.rows)], [null, true, ["A"]]);
  // the same answer beside unrelated rows: a held child of P, and P itself as a fee-share root
  g = buildPortfolio(pf([hold(coin("H", "P", { parent: nameless }), 1)], [mine("A", "P", { parent: nameless })])).groups[0];
  assert.equal(g.tracked, true);
  g = buildPortfolio(pf([], [mine("A", "P", { parent: nameless })]), [claim("P", "5", 1, SOL)]).groups[0];
  assert.deepEqual([g.self?.coin.mint, g.tracked], ["P", true]);
});

test("a card's parent takes the fullest record the answers hold for it", () => {
  // the parent's own claim row, with nothing waiting: its name and logo, no row of its own
  const own = { ...claim("P", "0", 0, { ...SOL, yourBps: 0 }), image: "p.png" };
  let g = buildPortfolio(pf([]), [claim("C", "900", 4), own]).groups;
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].parent, { mint: "P", name: "P coin", symbol: "P", image: "p.png" });
  assert.deepEqual([g[0].self, g[0].tracked, mints(g[0].rows)], [null, true, ["C"]]);
  // a holding's parent record
  g = buildPortfolio(pf([hold(coin("A", "P"), 3)]), [claim("C", "900", 4)]).groups;
  assert.deepEqual(g[0].parent, ref("P"));
  assert.deepEqual([g[0].tracked, mints(g[0].rows)], [true, ["C"]]);
  // the parent among the wallet's own coins as a holding: its record heads the card, without a holding
  g = buildPortfolio(pf([hold(coin("P", null, { image: "held.png" }), 3)]), [claim("C", "900", 4)]).groups;
  assert.deepEqual([g[0].parent.image, g[0].self, g[0].tracked], ["held.png", null, true]);
  // the parent launched by the wallet: it is the header
  g = buildPortfolio(pf([], [mine("P", null)]), [claim("C", "900", 4)]).groups;
  assert.deepEqual([g.length, g[0].self?.coin.mint, g[0].tracked, mints(g[0].rows)], [1, "P", true, ["C"]]);
  assert.deepEqual(g[0].rows[0].coin.parent, ref("P"));
});

test("a claim-only coin without a record of its parent: a spawn's parent is a coin, a listed quote is not", () => {
  const spawn = buildPortfolio(pf([]), [claim("C", "900", 4)]).groups[0];
  assert.deepEqual([spawn.mint, spawn.parent.name, spawn.tracked], ["P", null, true]);
  // a depth-0 coin quoted in a listed asset is a row under that asset, as in /api/portfolio
  const listed = buildPortfolio(pf([]), [claim("U", "900", 4, { depth: 0, quoteMint: "USDC", quoteSymbol: "USDC" })]).groups;
  assert.deepEqual(listed.map((x) => [x.mint, x.self, x.tracked, mints(x.rows)]), [["USDC", null, false, ["U"]]]);
  // a bare record for a held coin's parent (its name is not read yet) does not undo that
  const a = coin("A", "P", { parent: { mint: "P", name: null, symbol: "P", image: null } });
  assert.equal(buildPortfolio(pf([hold(a, 1)]), [claim("C", "900", 4)]).groups[0].tracked, true);
  // a root quoted in wrapped SOL has no parent
  const w = buildPortfolio(pf([]), [claim("R", "5", 1, { depth: 0, quoteMint: "So11111111111111111111111111111111111111112", quoteSymbol: "SOL", quoteDecimals: 9 })]).groups;
  assert.deepEqual([w.length, w[0].self?.coin.mint, w[0].tracked], [1, "R", true]);
});

test("holdings: value held, largest first, then 24 h volume; a coin without a price counts as nothing held in USD", () => {
  const v = buildPortfolio(pf([
    hold(coin("LOW", "P"), 1), hold(coin("HIGH", "Q"), 9), hold(coin("NOPRICE", "P", { vol24Usd: 3 }), null), hold(coin("NOPRICE2", null, { vol24Usd: 80 }), null),
  ]));
  assert.deepEqual(mints(v.holdings), ["HIGH", "LOW", "NOPRICE2", "NOPRICE"]);
  assert.deepEqual([v.totals.unpriced, v.totals.valueUsd, v.totals.holdings], [2, 10, 4]);
});

test("spore rows: value held, then 24 h volume; cards: value held, then claimable USD, then name", () => {
  const rows = buildPortfolio(pf(
    [hold(mine("LOW", "P"), 1), hold(mine("HIGH", "P"), 9)],
    [mine("QUIET", "P", { vol24Usd: 2 }), mine("BUSY", "P", { vol24Usd: 80 })],
  ));
  assert.deepEqual(mints(rows.groups[0].rows), ["HIGH", "LOW", "BUSY", "QUIET"]);
  const v = buildPortfolio(
    pf([hold(mine("A", "Small"), 5), hold(mine("B", "Big"), 50)], [mine("C", "zeta"), mine("D", "Alpha"), mine("E", "Fees")]),
    [claim("E", "100", 7, { quoteMint: "Fees", quoteSymbol: "Fees" })],
  );
  assert.deepEqual(v.groups.map((g) => g.mint), ["Big", "Small", "Fees", "Alpha", "zeta"]);
});

test("totals: every coin held is in the value, holdings and spores count their rows, launched is the server's total", () => {
  const v = buildPortfolio(
    pf([hold(coin("H1", "P"), 30), hold(coin("H2", null), null), hold(mine("S1", "P"), 70)], [mine("S1", "P"), mine("S2", "Q")], { launchedTotal: 312 }),
    [claim("S1", "500", 2), claim("S2", "700", 9, { claimable: false, quoteMint: "Q", quoteSymbol: "Q" }), claim("F", "40", 1.5)],
  );
  // 312 launched, 2 of them sent; F is known only from its claim row, so it is taken for one of the 310 not sent
  assert.deepEqual(v.totals, { valueUsd: 100, unpriced: 1, held: 3, holdings: 2, spores: 3, sporeTotal: 312, launched: 312, groups: 2, claimUsd: 3.5, claimable: 2 });
  assert.deepEqual(claimableRows(v).map((r) => r.mint), ["S1", "F"]);
});

test("sporeTotal counts each spore once when the server's launched list is cut", () => {
  // 250 launched, the newest 200 sent; 3 older ones are held (the server names the wallet as their creator) and 2
  // more older ones have fees waiting (claim rows only); the wallet also holds a coin it only shares the fees of
  const sent = Array.from({ length: 200 }, (_, i) => mine(`N${i}`, "P"));
  const old = [mine("O1", "P"), mine("O2", "P"), mine("O3", "Q")];
  const share = coin("FS", "Q");
  const v = buildPortfolio(
    pf([...old.map((c) => hold(c, 1)), hold(share, 2)], sent, { launchedTotal: 250 }),
    [claim("C1", "10", 1), claim("C2", "10", 1), claim("FS", "0", 0, { quoteMint: "Q", quoteSymbol: "Q" })],
  );
  assert.deepEqual([v.totals.spores, v.totals.launched, v.totals.sporeTotal, v.totals.holdings], [206, 250, 251, 0]);
  const by = Object.fromEntries(v.groups.flatMap((g) => g.rows).map((r) => [r.coin.mint, r]));
  assert.deepEqual([by.O1.launched, by.O1.feeShare, by.FS.launched, by.FS.feeShare, by.C1.launched, by.C1.feeShare], [true, false, false, true, false, true]);
  // more claim-only coins than launches not sent: the rest are fee shares on top
  const few = buildPortfolio(pf([], [mine("A", "P")], { launchedTotal: 2 }), [claim("C1", "10", 1), claim("C2", "10", 1), claim("C3", "10", 1)]);
  assert.deepEqual([few.totals.spores, few.totals.launched, few.totals.sporeTotal], [4, 2, 4]);
  // the whole list sent: every row counts, a claim-only coin is a fee share of another wallet's coin
  const all = buildPortfolio(pf([], [mine("A", "P")]), [claim("C1", "10", 1)]);
  assert.deepEqual([all.totals.spores, all.totals.launched, all.totals.sporeTotal], [2, 1, 2]);
});

test("a failed holdings read still lists the launched coins", () => {
  const v = buildPortfolio(pf([], [mine("A", "P")], { holdingsOk: false, solLamports: null }));
  assert.deepEqual(v.holdings, []);
  assert.deepEqual(mints(v.groups[0].rows), ["A"]);
  assert.deepEqual([v.totals.held, v.totals.spores], [0, 1]);
});
