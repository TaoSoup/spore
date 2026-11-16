// The instant trade of a page's Buy / Sell presets (TradePresets.tsx), shared by the Portfolio page and the map's side
// panel: the wallet step before a trade, one trade at a time, the toasts, and what follows each answer of
// lib/instant-trade.ts (lib/instant-outcome.ts says which). The page supplies what only it can do: open its ticket with
// the amount filled in, show a "not tradable here" reason where its buttons are, and refresh what it shows once a trade
// landed. Nothing here signs: instantTrade() runs every check and signs only after all of them passed.
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Coin } from "../lib/api";
import { instantTrade, type InstantSpec } from "../lib/instant-trade";
import { instantProgress, instantSigner, instantStep } from "../lib/instant-outcome";
import { friendlyError } from "../lib/steps";
import { lockIfIdle, tradingSender } from "../lib/trading-wallet";
import type { TradeBlock } from "../lib/trade-route";
import { openTradingWallet, useInstantSol, useTradeSettings, useTrader } from "../lib/trader";
import type { Side, TxSender } from "../lib/pump";
import { useToast } from "./Toast";

/// The trade under way (a ticket being opened, or an instant trade): its coin and side. One at a time per page.
export type Opening = { mint: string; side: Side } | null;
export type InstantCallbacks = {
  /// A check did not pass: open the ticket with this amount in its field (the toast saying why is already shown).
  onTicket: (t: { coin: Coin; side: Side; amount: string }) => void;
  /// The coin cannot be traded here: show why where the buttons are.
  onBlocked: (block: TradeBlock, coin: Coin) => void;
  /// The trade landed: refresh what the page shows.
  onLanded?: () => void;
};

/// `signer`: "portfolio" (default; the Portfolio page) or "chosen" (the map), see lib/instant-outcome.ts instantSigner.
export function useInstantTrade(cb: InstantCallbacks, opts?: { signer?: "portfolio" | "chosen" }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { tw, tradeWith, setTradeWith } = useTrader();
  const toast = useToast();
  const settings = useTradeSettings();
  const [instantSol] = useInstantSol();
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const [opening, setOpening] = useState<Opening>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const busyRef = useRef(false);
  // The wallet step before any trade (lib/instant-outcome.ts instantSigner says which wallet signs). On the Portfolio
  // page ("portfolio") the trading wallet trades: a locked one is asked to unlock (the panel closes by itself once it
  // is; the user then presses Buy / Sell again, nothing is traded by the unlock), an unlocked one is made the wallet that
  // trades. On the map ("chosen") the user's Trade-with choice signs and is never changed here: a locked trading wallet
  // is asked to unlock only when it is the chosen one.
  const mode = opts?.signer ?? "portfolio";
  const walletReady = wallet.connected && !!wallet.publicKey;
  // an hour without use counts as locked a moment before the timer says so
  const signer = useCallback(() => instantSigner({ mode, trading: !!tw.address, unlocked: tw.status === "unlocked" && !!tradingSender(), tradeWith, walletConnected: walletReady }),
    [mode, tw.address, tw.status, tradeWith, walletReady]);
  const ready = useCallback(() => {
    const s = signer();
    if (s.use === "unlock") { lockIfIdle(); openTradingWallet("unlock"); toast.info("Unlock your trading wallet to trade."); return false; }
    if (s.setTrading) setTradeWith("trading");
    return true;
  }, [toast, signer, setTradeWith]);
  // The one-at-a-time guard, for the page's own ticket opener too: `busy()` before anything, `begin` before the first
  // await, `end` in its finally.
  const busy = useCallback(() => busyRef.current, []);
  const begin = useCallback((mint: string, side: Side) => { busyRef.current = true; setOpening({ mint, side }); }, []);
  const end = useCallback(() => { busyRef.current = false; if (alive.current) setOpening(null); }, []);
  // A preset pressed: the trade itself, at once (lib/instant-trade.ts runs every check before it signs). One at a time:
  // `busyRef` is taken before anything is awaited, so a second press cannot start a second send. What does not pass a
  // check opens the ticket with the amount filled in; nothing is sent again by itself after a failure.
  const slippageBps = settings.slippageBps;
  const run = useCallback(async (mint: string, spec: InstantSpec, label: string) => {
    if (busyRef.current) return;
    if (!ready()) return;
    const use = signer().use;
    const viaTrading = use === "trading";
    const sender: TxSender | null = viaTrading ? tradingSender() : use === "wallet" ? wallet : null;
    if (!sender) { toast.error("No wallet is ready to trade. Nothing was sent."); return; }
    begin(mint, spec.side);
    toast.info(instantProgress(spec, label));
    try {
      const r = await instantTrade(connection, { mint, spec, sender, trader: viaTrading ? "trading" : "wallet", slippageBps, capSol: instantSol });
      const step = instantStep(r, viaTrading);
      if (step.kind === "done") {
        toast.success(step.text, step.link);
        cbRef.current.onLanded?.();
      } else if (step.kind === "ticket") {
        // not enough SOL in the trading wallet: the way to add some (the ticket's own hint covers only a buy)
        toast.info(step.text, step.deposit ? { label: "Move SOL into the trading wallet", onClick: () => openTradingWallet("deposit") } : undefined);
        if (alive.current) cbRef.current.onTicket({ coin: step.coin, side: step.side, amount: step.amount });
      } else if (step.kind === "blocked") {
        if (alive.current) cbRef.current.onBlocked(step.block, step.coin);
      } else toast.error(step.text, step.link);
    } catch (e) {
      toast.error(`The trade was not sent: ${friendlyError(e)}`);
    } finally {
      end();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, toast, ready, signer, begin, end, wallet.connected, wallet.publicKey, wallet.sendTransaction, slippageBps, instantSol]);
  // a wallet that could sign an instant trade: the trading wallet (it may need unlocking first) or a connected one
  const hasWallet = !!tw.address || (wallet.connected && !!wallet.publicKey);
  return { run, ready, opening, busy, begin, end, alive, settings, hasWallet };
}
