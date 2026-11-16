// What a buy or a sell does between "this coin, this side, this amount" and a confirmed transaction, without any UI:
// read the wallet's balances, quote the route (pump's multi-hop swap or Jupiter's legs), read the priority fee of the
// route's venues, and build + simulate + sign + confirm the quoted trade. The trade ticket (components/TradeWidget.tsx)
// and the instant trade (lib/instant-trade.ts) both run these, so the two can never quote, price or send differently.
import { PublicKey, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { solscanTx } from "./api";
import { runJupSwap, runSwap, type SwapOpts } from "./flow";
import { quoteJup, type JupQuote } from "./jup";
import { priorityMicroLamports, quoteSwap, routeVenues, swapUnits, type Chain, type Side, type TxSender } from "./pump";
import { friendlyError, type Report } from "./steps";

/// The coin as the trade needs it: its mint and token program, and its symbol for the record of a sent trade.
export type TradeCoin = { mint: string; tokenProgram: string; symbol: string | null };

/// `unwrapped`: lamports of a wrapped-SOL account the user already had that the route closes into the wallet.
/// `jup`: the Jupiter route's quote (its build is what the transaction is compiled from).
export type TradeQuote = { amountOut: bigint; units: number; unwrapped: bigint; jup?: JupQuote };

/// The wallet's SOL (null: the read failed) and its balance of the coin, read from the chain now. A missing token
/// account is the normal "never held it" case, not an error: 0 with `hasAta` false.
export async function readTradeBalances(conn: Connection, user: PublicKey, coin: Pick<TradeCoin, "mint" | "tokenProgram">): Promise<{ sol: bigint | null; token: bigint; hasAta: boolean }> {
  const ata = getAssociatedTokenAddressSync(new PublicKey(coin.mint), user, false, new PublicKey(coin.tokenProgram));
  const [s, t] = await Promise.all([
    conn.getBalance(user, "confirmed").then((n) => BigInt(n)).catch(() => null),
    conn.getTokenAccountBalance(ata, "confirmed").then((r) => ({ amount: BigInt(r.value.amount), has: true })).catch(() => ({ amount: 0n, has: false })),
  ]);
  return { sol: s, token: t.amount, hasAta: t.has };
}

/// A simulated quote of buying with `amountIn` lamports or selling `amountIn` base units, for `payer`: Jupiter's build
/// (asked with `jupSlippageBps`, which is part of it) when the route is Jupiter's, else pump's swap over `chain`.
export function quoteTrade(conn: Connection, payer: PublicKey, coin: Pick<TradeCoin, "mint" | "tokenProgram">, chain: Chain, isJup: boolean, side: Side, amountIn: bigint, jupSlippageBps: number, signal?: AbortSignal): Promise<TradeQuote> {
  return isJup
    ? quoteJup(conn, payer, { mint: coin.mint, tokenProgram: coin.tokenProgram }, side, amountIn, jupSlippageBps, signal).then((q) => ({ amountOut: q.amountOut, units: q.unitsConsumed, unwrapped: q.unwrapped, jup: q }))
    : quoteSwap(conn, payer, chain, side, amountIn).then((q) => ({ amountOut: q.amountOut, units: q.unitsConsumed, unwrapped: q.unwrapped }));
}

/// The accounts fee markets key on for this route: the pools of Jupiter's last quote (`jupAmmKeys`, none before the
/// first one), or each hop's venue on pump's route. Throws on a key that is not one.
export function tradeVenues(chain: Chain, side: Side, isJup: boolean, jupAmmKeys: readonly string[]): PublicKey[] {
  return isJup ? jupAmmKeys.filter(Boolean).map((k) => new PublicKey(k)) : routeVenues(chain, side);
}
/// The priority fee (micro-lamports per CU) from the recent fees on those venues; the floor when the read fails.
export const tradePriority = (conn: Connection, venues: PublicKey[]): Promise<number> => priorityMicroLamports(conn, venues);

/// The compute limit the transaction of a quote is built with: Jupiter's route counts as one hop.
export const tradeUnits = (chain: Chain, q: Pick<TradeQuote, "units" | "jup">): number => swapUnits(q.jup ? 1 : chain.length, q.units);

/// Build the quoted trade, simulate the exact transaction (a fill that would miss the minimum stops there as
/// PriceMovedError, nothing signed), sign it with `sender` and confirm it. The minimum is Jupiter's own (inside its
/// build) or the quote less `slippageBps`. One send, never repeated here: a failure is the caller's to show.
export function sendTrade(conn: Connection, sender: TxSender, coin: TradeCoin, chain: Chain, q: TradeQuote & { side: Side; amountIn: bigint }, slippageBps: number, microLamports: number, report: Report, extra: Pick<SwapOpts, "mustMeasure" | "beforeSign"> = {}): Promise<{ sig: string; minOut: bigint }> {
  const opts = { ...extra, units: tradeUnits(chain, q), microLamports, mint: coin.mint, symbol: coin.symbol };
  return q.jup
    ? runJupSwap(conn, sender, q.jup, report, opts)
    : runSwap(conn, sender, chain, q.side, q.amountIn, q.amountOut, slippageBps, report, opts);
}

/// A failed send, in the user's words. A transaction that went out and whose result never came back is said as such,
/// with its link (it may still land: check before trading again); anything else is the plain cause.
export function tradeErrorText(e: unknown, label: string): { text: string; link?: { href: string; label: string } } {
  const sent = (e as { sentSig?: string } | null)?.sentSig;
  const name = (e as { name?: string } | null)?.name;
  const unsettled = !!sent && name !== "OnChainError" && name !== "ExpiredError";
  if (unsettled) return { text: `Sent, but Spore could not confirm it yet. Check the transaction before trading ${label} again.`, link: { href: solscanTx(sent), label: "view transaction" } };
  return { text: friendlyError(e) };
}
