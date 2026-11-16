// The Portfolio page's two lists (pages/Portfolio.tsx), built from /api/portfolio/:wallet and the claim rows of
// /api/claims/:wallet. A SPORE is a pair the wallet launched: a coin it created (a child is priced in its parent's
// token, so a coin's parent is `coin.parent`, null for a root), or a coin whose creator fees it shares. A HOLDING is a
// coin the wallet holds that is not one of its spores. Spores are grouped by parent coin, holdings are one flat list.
// Pure: no React, no DOM, no fetches, so it runs under node:test (test/portfolio.test.mts).
import type { ClaimCoin, Portfolio, PortfolioCoin, PortfolioParent } from "./api";

/// What the wallet holds of one coin: `amount` raw units, `uiAmount` whole tokens, `valueUsd` null without a price.
export type PfHeld = { amount: string; decimals: number; uiAmount: number; valueUsd: number | null };
/// The wallet's part of a coin's pending creator fees: `amount` raw units of the coin's quote (lamports for a root,
/// parent-token units for a child), `usd` null without a price. `row` is the claim row itself (what a payout needs).
export type PfClaim = { amount: string; usd: number | null; quoteSymbol: string; quoteDecimals: number; claimable: boolean; row: ClaimCoin };
/// One of the wallet's coins. `launched`: the answers say the wallet created it. `feeShare`: they do not, but the
/// coin's fee split names the wallet (a coin known only from its claim row carries no creator, so with a cut launched
/// list it may be one of the wallet's older launches). `spore`: either of the two (the coin is listed under "Your
/// spores"); false for a holding.
export type PfRow = { coin: PortfolioCoin; launched: boolean; feeShare: boolean; spore: boolean; held: PfHeld | null; claim: PfClaim | null };
/// One parent coin and the wallet's spores under it. `self` is the parent's own row only when the parent is itself a
/// spore of the wallet (then the card's header carries its tag, fees and Buy / Sell); null for a parent the wallet
/// merely holds or does not own at all. `valueUsd` is what the wallet holds of the card's spores (`self` + rows),
/// `claimUsd` everything claimable in it.
/// `tracked`: the parent is a coin of the index (it takes a child); false for a listed asset (USDC).
export type PfGroup = { mint: string; parent: PortfolioParent; self: PfRow | null; tracked: boolean; rows: PfRow[]; valueUsd: number; claimUsd: number };
/// `valueUsd`: every priced coin held, holdings and spores; `unpriced`: coins held without a USD price; `held`: coins
/// held. `holdings` / `spores`: the rows of the two lists (a coin counts once). `launched`: the server's total of
/// coins the wallet created, which may exceed the rows it sent. `sporeTotal`: the wallet's spores, listed or not:
/// `launched` plus the fee-share rows (each coin once; equal to `spores` when the server sent every launch).
/// `claimUsd` / `claimable`: the wallet's part of, and the number of, coins with a payout that can run now.
/// `groups`: parent cards.
export type PfTotals = { valueUsd: number; unpriced: number; held: number; holdings: number; spores: number; sporeTotal: number; launched: number; groups: number; claimUsd: number; claimable: number };
/// `holdings`: value held, largest first. `groups`: the spores by parent.
export type PfView = { holdings: PfRow[]; groups: PfGroup[]; totals: PfTotals };

const usdOf = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const positive = (raw: string | null | undefined) => { try { return BigInt(raw ?? "0") > 0n; } catch { return false; } };
const label = (p: { symbol: string | null; name: string | null }) => (p.symbol || p.name || "").toLowerCase();
/// A claim row worth showing: the wallet has a part waiting. A coin with nothing waiting carries no claim.
const claimOf = (c: ClaimCoin): PfClaim | null => (positive(c.yourAmount) ? { amount: c.yourAmount!, usd: c.yourUsd ?? null, quoteSymbol: c.quoteSymbol, quoteDecimals: c.quoteDecimals, claimable: c.claimable, row: c } : null);
const claimUsdOf = (c: PfClaim | null | undefined) => (c && c.claimable ? usdOf(c.usd) : 0);
const WSOL = "So11111111111111111111111111111111111111112";
const hasDetail = (p: PortfolioParent) => p.name !== null || p.image !== null;
/// A coin known only from its claim row (the fee split names the wallet, but it neither holds nor created the coin):
/// the row has no parent record, only the quote. Its parent is its quote mint, as in /api/portfolio (null for a root
/// quoted in SOL): the record `known` holds for that mint, else the bare quote (mint and symbol).
const coinOfClaim = (c: ClaimCoin, known: ReadonlyMap<string, PortfolioParent>): PortfolioCoin => ({
  mint: c.mint, name: c.name, symbol: c.symbol, image: c.image, depth: c.depth,
  parent: c.quoteMint && c.quoteMint !== WSOL ? known.get(c.quoteMint) ?? { mint: c.quoteMint, name: null, symbol: c.quoteSymbol || null, image: null } : null,
  creator: null, mcapUsd: null, priceUsd: null, vol24Usd: null, trades1h: null, lastTradeAt: null, graduated: c.migrated, createdAt: null,
});

/// Rows: value held, largest first (a held coin without a price before a coin not held), then 24 h volume, then mint.
function byRow(a: PfRow, b: PfRow): number {
  const v = (r: PfRow) => (r.held ? (r.held.valueUsd ?? 0) : -1);
  return v(b) - v(a) || usdOf(b.coin.vol24Usd) - usdOf(a.coin.vol24Usd) || (a.coin.mint < b.coin.mint ? -1 : 1);
}
/// Groups: value held, then claimable USD, then name (a nameless parent last), then mint.
function byGroup(a: PfGroup, b: PfGroup): number {
  const la = label(a.parent), lb = label(b.parent);
  return b.valueUsd - a.valueUsd || b.claimUsd - a.claimUsd || (la && lb ? la.localeCompare(lb) : la ? -1 : lb ? 1 : 0) || (a.mint < b.mint ? -1 : 1);
}

/// The wallet's coins as holdings and spores; every coin is in exactly one of the two.
/// A spore is a coin the wallet created, or one whose fee split names it: a coin it holds counts with any share, a
/// coin it does not hold only while a part is waiting (so every payout has a row and nothing else is listed).
/// A spore whose parent is P is a row of P's group. P heads that group with `self` only when P is a spore too; a
/// spore root with no spores under it is a group with a header and no rows. A spore that is both a child and the
/// parent of other spores is a row under its parent and the header of its own group.
export function buildPortfolio(pf: Portfolio | null | undefined, claims: readonly ClaimCoin[] = []): PfView {
  const holdings = pf?.holdings ?? [], launched = pf?.launched ?? [];
  const wallet = pf?.wallet ?? null;
  const claimBy = new Map<string, PfClaim>(), shared = new Set<string>();
  for (const c of claims) {
    const k = claimOf(c);
    if (k && !claimBy.has(c.mint)) claimBy.set(c.mint, k);
    if (k || (c.yourBps ?? 0) > 0) shared.add(c.mint);
  }

  const rows = new Map<string, PfRow>();
  const row = (coin: PortfolioCoin): PfRow => {
    let r = rows.get(coin.mint);
    if (!r) { r = { coin, launched: !!wallet && coin.creator === wallet, feeShare: false, spore: false, held: null, claim: claimBy.get(coin.mint) ?? null }; rows.set(coin.mint, r); }
    return r;
  };
  for (const h of holdings) { const r = row(h.coin); if (!r.held) r.held = { amount: h.amount, decimals: h.decimals, uiAmount: h.uiAmount, valueUsd: h.valueUsd }; }
  for (const c of launched) row(c).launched = true;
  // What the two answers say about a coin that may be a parent, best first: the coin itself among the wallet's rows,
  // a parent record of one of those rows, the coin's own claim row (listed even with nothing waiting).
  const known = new Map<string, PortfolioParent>();
  const learn = (p: PortfolioParent | null) => { if (p && hasDetail(p) && !known.has(p.mint)) known.set(p.mint, { mint: p.mint, name: p.name, symbol: p.symbol, image: p.image }); };
  for (const r of rows.values()) learn(r.coin);
  for (const r of rows.values()) learn(r.coin.parent);
  for (const c of claims) learn(c);
  const claimOnly = new Set<string>();
  for (const c of claims) if (claimBy.has(c.mint) && !rows.has(c.mint)) { row(coinOfClaim(c, known)); claimOnly.add(c.mint); }
  for (const r of rows.values()) { r.feeShare = !r.launched && shared.has(r.coin.mint); r.spore = r.launched || r.feeShare; }
  const spores = [...rows.values()].filter((r) => r.spore);

  const groups = new Map<string, PfGroup>();
  const group = (parent: PortfolioParent): PfGroup => {
    let g = groups.get(parent.mint);
    // a child's parent record may be bare (a claim row's quote): the fullest record the answers hold is used
    if (!g) { g = { mint: parent.mint, parent: known.get(parent.mint) ?? parent, self: null, tracked: false, rows: [], valueUsd: 0, claimUsd: 0 }; groups.set(parent.mint, g); }
    return g;
  };
  // children first, so a spore that is also the parent of other spores finds its group and becomes the header
  for (const r of spores) if (r.coin.parent) group(r.coin.parent).rows.push(r);
  for (const r of spores) {
    const c = r.coin;
    // a spore under a parent is that parent's row; it heads a card of its own only when the wallet has spores under it
    if (c.parent && !groups.has(c.mint)) continue;
    const g = group({ mint: c.mint, name: c.name, symbol: c.symbol, image: c.image });
    g.parent = { mint: c.mint, name: c.name, symbol: c.symbol, image: c.image };
    g.self = r;
  }
  const list = [...groups.values()];
  for (const g of list) {
    // A parent among the wallet's coins, or one the answers name, is a coin of the index. So is the parent of a
    // spawn (depth 1 or more: its quote is a pump coin), also while the server has not read that coin's name yet. A
    // nameless parent of depth-0 coins only is a listed asset (USDC).
    g.tracked = rows.has(g.mint) || g.parent.name !== null || g.rows.some((r) => r.coin.depth > 0);
    g.rows.sort(byRow);
    g.valueUsd = usdOf(g.self?.held?.valueUsd) + g.rows.reduce((t, r) => t + usdOf(r.held?.valueUsd), 0);
    g.claimUsd = claimUsdOf(g.self?.claim) + g.rows.reduce((t, r) => t + claimUsdOf(r.claim), 0);
  }
  list.sort(byGroup);
  const held = [...rows.values()].filter((r) => r.held && !r.spore).sort(byRow);

  // The spores in all: every coin the wallet created (the server's total; the rows hold a part of them when its list
  // is cut) plus the fee-share rows. A held coin carries its creator, so a held fee-share row is not a launch; a
  // claim-only row carries none, so with a cut list it is taken for one of the launches not sent while those last.
  const launchedRows = spores.filter((r) => r.launched).length;
  const launchedAll = Math.max(pf?.launchedTotal ?? 0, launchedRows);
  const unsent = launchedAll - launchedRows;
  const unsure = unsent > 0 ? spores.filter((r) => r.feeShare && claimOnly.has(r.coin.mint)).length : 0;
  const sporeTotal = launchedAll + (spores.length - launchedRows - unsure) + Math.max(0, unsure - unsent);

  let claimUsd = 0, claimable = 0;
  for (const k of claimBy.values()) if (k.claimable) { claimUsd += usdOf(k.usd); claimable++; }
  return {
    holdings: held, groups: list,
    totals: {
      valueUsd: holdings.reduce((t, h) => t + usdOf(h.valueUsd), 0), unpriced: holdings.filter((h) => h.valueUsd === null).length,
      held: holdings.length, holdings: held.length, spores: spores.length, sporeTotal,
      launched: launchedAll, groups: list.length, claimUsd, claimable,
    },
  };
}

/// The claim rows a "Claim all" runs, in the order of the page: card by card, the header's coin first (a holding has
/// no fees waiting, so only the spores count).
export function claimableRows(view: PfView): ClaimCoin[] {
  const seen = new Set<string>(), out: ClaimCoin[] = [];
  const add = (k: PfClaim | null | undefined) => { if (k && k.claimable && !seen.has(k.row.mint)) { seen.add(k.row.mint); out.push(k.row); } };
  for (const g of view.groups) { add(g.self?.claim); for (const r of g.rows) add(r.claim); }
  return out;
}
