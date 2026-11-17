// The instant trade: a buy of a preset SOL amount or a sell of a share of the wallet's balance, run from one click
// with no ticket. Headless (no React, no page): the caller hands it the coin's mint, what to do, who signs and the
// settings, and shows what comes back. It quotes, prices and sends through lib/trade-exec.ts, the same code the
// ticket runs, and it signs only after every check below passed; a check that does not pass hands the trade back to
// the ticket ("ticket", with the amount to prefill and the reason to say), where the user sees the numbers first.
//
// The order, from the call to the signature:
//   1. the coin's record, read fresh (lib/api)
//   1b. an earlier trade of this coin that this browser sent and never saw settle (lib/trade-store.ts): its signature is
//      asked of the chain; one that may still land, or whose state could not be read, goes to the ticket, which shows it
//   2. its route (lib/trade-route.ts) and the wallet's balances from the chain, together
//   3. a route that is hard-blocked ends here ("blocked"); one that could not be checked or waits for a migration
//      goes to the ticket
//   4. the amount: the preset in lamports, or the share of the balance just read (100% = all of it, else rounded down)
//   5. a buy over the "sign at once" cap goes to the ticket (trading wallet only)
//   6. the wallet's SOL covers the buy with fee, rent and headroom (a sell: the fee), else the ticket
//   7. a fresh simulated quote for this wallet, with the slippage setting; a quote that fails goes to the ticket
//   8. the SOL check again with the quote's own fee and rent
//   9. a sell whose quote is over the cap goes to the ticket (trading wallet only)
//  10. price impact against spot over MAX_INSTANT_IMPACT, more than MAX_INSTANT_GAIN better than spot (the spot price is
//      out of date, so the figure means nothing), or unknown, goes to the ticket
//  11. build the transaction and simulate exactly it with the minimum (lib/flow.ts): a fill under the minimum stops
//      there; with the trading wallet the simulated cost must be measured and within what the trade should cost
//  12. sign and send, once. Nothing here retries a send: a failure or an expiry is reported, the user decides.
import type { Connection } from "@solana/web3.js";
import { api, errorMessage, type Coin } from "./api";
import { PriceMovedError, UnmeasuredCostError } from "./flow";
import { exactAmount, short } from "./format";
import { ataRentLamports, signatureState, swapFeeLamports, swapUnits, CU_PRICE_MICRO, SimulationError, type Side, type TxSender } from "./pump";
import { friendlyError } from "./steps";
import { quoteTrade, readTradeBalances, sendTrade, tradeErrorText, tradePriority, tradeUnits, tradeVenues } from "./trade-exec";
import { hardBlock, loadTradeRoute, type TradeBlock, type TradeRoute } from "./trade-route";
import { clearPendingTrade, pendingTradeOf, type PendingTrade } from "./trade-store";
import { MAX_INSTANT_GAIN, MAX_INSTANT_IMPACT, buyNeedLamports, costWithin, impactDecision, overCap, presetText, sellAmountOf, solToLamports, tradeImpact, unsettledDecision } from "./trade-settings";

/// What to do: buy with this many SOL, or sell this percentage of what the wallet holds now.
export type InstantSpec = { side: "buy"; sol: number } | { side: "sell"; pct: number };
export type InstantInput = {
  mint: string; spec: InstantSpec;
  /// Who signs, and whether it is the trading wallet (no popup: the cap and the cost check apply) or a connected
  /// wallet (its own approval popup is the confirmation).
  sender: TxSender; trader: "trading" | "wallet";
  slippageBps: number;
  /// The "sign at once up to N SOL" cap (lib/trader.ts useInstantSol).
  capSol: number;
};
/// Why a trade went to the ticket instead of being signed.
/// "unsettled": an earlier trade of the coin may still be in flight (the ticket shows it); "pending": a migration.
export type TicketReason = "route" | "pending" | "unsettled" | "cap" | "sol" | "quote" | "impact" | "cost" | "moved";
export type InstantResult =
  /// Landed. `amountOut` is the quote the trade was sent with (the fill is at least the minimum under it).
  | { kind: "done"; coin: Coin; side: Side; sig: string; amountIn: bigint; amountOut: bigint }
  /// Not signed: open the ticket with `amount` in its field and say `text`. `deposit`: the cure is SOL in the wallet.
  | { kind: "ticket"; coin: Coin; side: Side; amount: string; reason: TicketReason; text: string; deposit?: boolean }
  /// Not tradable here: the caller shows the block's words where it shows them for the ticket.
  | { kind: "blocked"; coin: Coin; side: Side; block: TradeBlock }
  /// Not done, and no ticket would help (nothing to sell, the wallet refused, a send that failed or expired). `link`:
  /// a transaction that went out and may still land.
  | { kind: "failed"; coin: Coin | null; side: Side; text: string; link?: { href: string; label: string } };

/// The simulation of the exact transaction showed the wallet spending more than the trade should cost.
export class InstantCostError extends Error { constructor() { super("The simulation showed this trade costing more than expected, so it was not signed."); this.name = "InstantCostError"; } }

/// Everything the trade reads or sends, so a test can run the whole sequence on fakes.
export type InstantDeps = {
  loadCoin: (mint: string) => Promise<Coin>;
  loadRoute: (conn: Connection, coin: Coin) => Promise<TradeRoute>;
  balances: typeof readTradeBalances;
  quote: typeof quoteTrade;
  venues: typeof tradeVenues;
  priority: typeof tradePriority;
  send: typeof sendTrade;
  /// The unsettled-trade record of this browser (lib/trade-store.ts) and the chain's word on a signature.
  pendingOf: (mint: string) => PendingTrade | null;
  sigState: (conn: Connection, sig: string) => Promise<"confirmed" | "failed" | "unknown">;
  clearPending: (sig: string) => void;
  now: () => number;
};
const REAL: InstantDeps = {
  loadCoin: (mint) => api.coin(mint, { children: false, trades: false }).then((r) => r.coin),
  loadRoute: loadTradeRoute, balances: readTradeBalances, quote: quoteTrade, venues: tradeVenues, priority: tradePriority, send: sendTrade,
  pendingOf: (mint) => pendingTradeOf(mint), sigState: signatureState, clearPending: (sig) => clearPendingTrade(sig), now: () => Date.now(),
};

const tick = (c: { symbol: string | null; mint: string }) => (c.symbol ? `$${c.symbol}` : short(c.mint));
const pctText = (x: number) => `${Math.round(x * 100)}%`;

export async function instantTrade(conn: Connection, input: InstantInput, deps: InstantDeps = REAL): Promise<InstantResult> {
  const { spec, sender, trader, slippageBps, capSol } = input;
  const side: Side = spec.side;
  const user = sender.publicKey;
  if (!user) return { kind: "failed", coin: null, side, text: "No wallet is ready to trade. Nothing was sent." };

  // 1. the coin, fresh: its price is what the impact is measured against
  let coin: Coin;
  try { coin = await deps.loadCoin(input.mint); }
  catch (e) { return { kind: "failed", coin: null, side, text: `The coin could not be read (${errorMessage(e)}). Nothing was sent.` }; }
  const name = tick(coin);

  // 1b. a trade of this coin sent earlier from this browser that was never seen to settle (a reload mid-flight, a status
  // that never came back): no second one is signed beside it while it may still land. The ticket shows its state.
  const last = deps.pendingOf(coin.mint);
  if (last) {
    const state = await deps.sigState(conn, last.sig).catch(() => "unread" as const);
    if (unsettledDecision(state, deps.now() - last.at) === "hold") {
      const amt = spec.side === "buy" ? presetText(spec.sol) : "";
      return { kind: "ticket", coin, side, amount: amt, reason: "unsettled",
        text: `Your last ${last.side} of ${name} has not confirmed yet, so nothing was signed. Check it in the ticket before trading again.` };
    }
    deps.clearPending(last.sig);
  }

  // 2. the route and the wallet's balances, read now from the chain (never the page's cached figures)
  const [route, bal] = await Promise.all([
    deps.loadRoute(conn, coin).catch(() => null),
    deps.balances(conn, user, coin),
  ]);

  // 4 (early, for the ticket's field). 100% is the whole balance; a smaller share is rounded down to a base unit. A
  // balance that could not be read (null) sizes no sell: it ends below as "could not be read", nothing signed.
  const amountIn = spec.side === "buy" ? solToLamports(spec.sol) : bal.token === null ? 0n : sellAmountOf(bal.token, spec.pct);
  const field = spec.side === "buy" ? presetText(spec.sol) : amountIn > 0n ? exactAmount(amountIn, coin.decimals) : "";
  const ticket = (reason: TicketReason, text: string, deposit = false): InstantResult => ({ kind: "ticket", coin, side, amount: field, reason, text, ...(deposit ? { deposit } : {}) });

  // 3. the route
  const block = hardBlock(route);
  if (block) return { kind: "blocked", coin, side, block };
  if (!route) return ticket("route", `The route of ${name} could not be checked just now, so nothing was signed. The ticket checks it again.`);
  if (route.block) return ticket("pending", `${name} waits for a migration on its route, so nothing was signed.`);
  const chain = route.chain, isJup = route.via === "jupiter";

  if (amountIn <= 0n) {
    return { kind: "failed", coin, side, text: spec.side === "buy" ? "That buy amount is not one Spore can send. Check the presets in Trade settings."
      : bal.token !== null && bal.token > 0n ? `${spec.pct}% of what this wallet holds of ${name} is less than its smallest unit. Nothing was sent.`
      : `This wallet holds no ${name} to sell, or its balance could not be read just now. Nothing was sent.` };
  }

  // 5. a buy's SOL value is known before any quote
  const capText = `over your "sign at once" limit of ${capSol > 0 ? `${capSol} SOL` : "0 SOL"}`;
  if (side === "buy" && overCap({ trader, lamports: amountIn, capSol })) return ticket("cap", `This buy is ${capText}, so it was not signed. Review it in the ticket.`);

  // 6. the SOL it takes, with the estimate the ticket shows before a quote. A token balance that could not be read
  // counts the account as missing: its rent is in the check (the safe side).
  const hasAta = bal.token !== null && bal.hasAta;
  const ownRent = side === "buy" && !hasAta ? ataRentLamports(coin.tokenProgram) : 0n;
  const lacksSol = (fee: bigint, rent: bigint): InstantResult | null => {
    if (bal.sol === null) return null; // the read failed: the simulation of the exact transaction decides
    if (side === "buy" ? bal.sol >= buyNeedLamports(amountIn, fee, rent) : bal.sol >= fee) return null;
    return ticket("sol", side === "buy"
      ? `Not enough SOL in the wallet for this buy with its network fee${rent > 0n ? " and account rent" : ""}. Nothing was signed.`
      : "Not enough SOL in the wallet for the network fee of this sell. Nothing was signed.", true);
  };
  const early = lacksSol(swapFeeLamports(swapUnits(isJup ? 1 : chain.length, null), CU_PRICE_MICRO), ownRent);
  if (early) return early;

  // 7. the quote: a simulation for this wallet, of this amount, now. Jupiter's minimum is part of its build.
  let q: Awaited<ReturnType<typeof quoteTrade>>;
  let micro = CU_PRICE_MICRO;
  try {
    const pumpFee = isJup ? null : Promise.resolve().then(() => deps.priority(conn, deps.venues(chain, side, false, []))).catch(() => CU_PRICE_MICRO);
    q = await deps.quote(conn, user, coin, chain, isJup, side, amountIn, isJup ? slippageBps : 0);
    micro = pumpFee ? await pumpFee : await Promise.resolve().then(() => deps.priority(conn, deps.venues(chain, side, true, q.jup?.ammKeys ?? []))).catch(() => CU_PRICE_MICRO);
  } catch (e) {
    const why = friendlyError(e);
    if (/not enough SOL|no SOL yet/i.test(why)) return ticket("sol", `${why} Nothing was signed.`, true);
    return ticket("quote", `The quote could not be simulated, so nothing was signed: ${why}`);
  }
  if (q.amountOut <= 0n) return ticket("quote", "The quote came back empty, so nothing was signed.");

  // 8. the same SOL check with the fee and the rent of this quote
  const fee = swapFeeLamports(tradeUnits(chain, q), micro);
  const rent = q.jup ? q.jup.rent : ownRent;
  const late = lacksSol(fee, rent);
  if (late) return late;

  // 9. a sell's SOL value is what its quote gives
  if (side === "sell" && overCap({ trader, lamports: q.amountOut, capSol })) return ticket("cap", `This sell is ${capText}, so it was not signed. Review it in the ticket.`);

  // 10. price impact against the spot price of the record read in step 1
  const impact = tradeImpact({ side, amountIn, amountOut: q.amountOut, decimals: coin.decimals, spot: coin.priceSol });
  const verdict = impactDecision(impact);
  if (verdict === "high") return ticket("impact", `The quote lands ${pctText(impact!)} from the spot price, more than the ${pctText(MAX_INSTANT_IMPACT)} an instant trade accepts. Nothing was signed.`);
  if (verdict === "stale") return ticket("impact", `The quote lands ${pctText(-impact!)} better than the spot price Spore has for ${name}, more than the ${pctText(MAX_INSTANT_GAIN)} it accepts: that price looks out of date, so the real price impact is not known. Nothing was signed.`);
  if (verdict === "unknown") return ticket("impact", `${name} has no spot price to measure the quote against, so nothing was signed.`);

  // 11 and 12. build, simulate the exact transaction, then one signature and one send
  const silent = trader === "trading";
  try {
    const { sig } = await deps.send(conn, sender, coin, chain, { ...q, side, amountIn }, slippageBps, micro, () => {}, {
      mustMeasure: silent,
      beforeSign: (pf) => { if (silent && !costWithin({ side, spent: pf.spent, amountIn, feeLamports: fee, rentLamports: rent })) throw new InstantCostError(); },
    });
    return { kind: "done", coin, side, sig, amountIn, amountOut: q.amountOut };
  } catch (e) {
    const sent = !!(e as { sentSig?: string } | null)?.sentSig;
    if (!sent) {
      if (e instanceof PriceMovedError) return ticket("moved", `The price moved past your ${slippageBps / 100}% slippage before it was signed, so nothing was sent.`);
      if (e instanceof UnmeasuredCostError || e instanceof InstantCostError) return ticket("cost", e.message);
      if (e instanceof SimulationError) return ticket("quote", `The transaction did not pass its simulation, so nothing was signed: ${friendlyError(e)}`);
    }
    return { kind: "failed", coin, side, ...tradeErrorText(e, name) };
  }
}
