// What a page does with the answer of an instant trade (lib/instant-trade.ts), as data: the toast it shows and the step
// after it. Pure, so the mapping is tested without React (test/instant-outcome.test.mts); components/useInstantTrade.ts
// carries it out for the Portfolio page and the map's side panel alike.
import { solscanTx, type Coin } from "./api";
import { amount, lamportsToSol, short, sol, tokens } from "./format";
import type { InstantResult, InstantSpec } from "./instant-trade";
import type { TradeBlock } from "./trade-route";
import type { Side } from "./pump";

/// One step per answer:
/// - "done": a success toast with the transaction's link, then the page refreshes what it shows ("landed");
/// - "ticket": an info toast that says why (with the way to add SOL when `deposit`), then the ticket opens with
///   `amount` filled in;
/// - "blocked": the page shows the block's words where its buttons are (no toast here: the page says it);
/// - "failed": an error toast, with the transaction's link when one went out.
export type InstantStep =
  | { kind: "done"; text: string; link: { href: string; label: string } }
  | { kind: "ticket"; text: string; deposit: boolean; coin: Coin; side: Side; amount: string }
  | { kind: "blocked"; coin: Coin; block: TradeBlock }
  | { kind: "failed"; text: string; link?: { href: string; label: string } };

const tick = (c: { symbol: string | null; mint: string }) => (c.symbol ? `$${c.symbol}` : short(c.mint));

/// The toast shown while a trade runs: "Buying $SYM with 0.1 SOL…", "Selling 50% of $SYM…".
export const instantProgress = (spec: InstantSpec, label: string): string =>
  spec.side === "sell" ? `Selling ${spec.pct}% of ${label}…` : `Buying ${label} with ${spec.sol} SOL…`;

/// `viaTrading`: the trading wallet signed (its deposit view is the cure for a lack of SOL; a connected wallet has none).
export function instantStep(r: InstantResult, viaTrading: boolean): InstantStep {
  switch (r.kind) {
    case "done": {
      const what = tick(r.coin);
      return { kind: "done", link: { href: solscanTx(r.sig), label: "view transaction" }, text: r.side === "sell"
        ? `Sold ${amount(tokens(r.amountIn, r.coin.decimals))} ${what} for ≈ ${sol(lamportsToSol(r.amountOut))}`
        : `Bought ≈ ${amount(tokens(r.amountOut, r.coin.decimals))} ${what} for ${sol(lamportsToSol(r.amountIn))}` };
    }
    case "ticket":
      return { kind: "ticket", text: r.text, deposit: !!r.deposit && viaTrading, coin: r.coin, side: r.side, amount: r.amount };
    case "blocked":
      return { kind: "blocked", coin: r.coin, block: r.block };
    case "failed":
      return r.link ? { kind: "failed", text: r.text, link: r.link } : { kind: "failed", text: r.text };
  }
}

/// Which wallet signs an instant trade, decided before the presets open and again when one is pressed.
/// - "portfolio" (the Portfolio page, which shows the trading wallet's holdings): a trading wallet in this browser
///   trades, as the wallet shown; once unlocked it is also made the Trade-with choice (`setTrading`).
/// - "chosen" (the map, which shows no wallet): the user's Trade-with choice, by the same rule as useTrader (lib/trader.ts):
///   the trading wallet when it is chosen or no extension is connected, else the connected wallet. The choice is never
///   changed here, and a locked trading wallet is asked to unlock only when it is the one chosen.
/// "unlock": the trading wallet must be unlocked first (nothing is traded); "none": no wallet can sign.
export type InstantSigner = { use: "trading" | "wallet" | "unlock" | "none"; setTrading: boolean };
export function instantSigner(o: { mode: "portfolio" | "chosen"; trading: boolean; unlocked: boolean; tradeWith: "trading" | "wallet"; walletConnected: boolean }): InstantSigner {
  const tradingSigns = o.trading && (o.mode === "portfolio" || o.tradeWith === "trading" || !o.walletConnected);
  if (tradingSigns) {
    if (!o.unlocked) return { use: "unlock", setTrading: false };
    return { use: "trading", setTrading: o.mode === "portfolio" && o.tradeWith !== "trading" };
  }
  return { use: o.walletConnected ? "wallet" : "none", setTrading: false };
}
