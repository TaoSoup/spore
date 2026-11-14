// Who signs a trade: Spore's trading wallet (lib/trading-wallet.ts) when it is unlocked, or the connected wallet
// extension. The trade widget, the trading-wallet panel and the nav read the same answer and the same two settings.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { subscribeTradingWallet, tradingSender, tradingWalletState, type TradingWalletState } from "./trading-wallet";
import type { TxSender } from "./pump/send";

export function useTradingWallet(): TradingWalletState {
  return useSyncExternalStore(subscribeTradingWallet, tradingWalletState, tradingWalletState);
}

// ---- settings shared by every component on the page (and other tabs): localStorage plus an in-page event

const PREF_EVENT = "spore:trader-pref";
const prefKey = (k: string) => `spore:${k}`;
function readPref(key: string): string | null { try { return localStorage.getItem(prefKey(key)); } catch { return null; } }
function subscribePrefs(l: () => void) {
  const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith("spore:")) l(); };
  window.addEventListener(PREF_EVENT, l);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(PREF_EVENT, l); window.removeEventListener("storage", onStorage); };
}
function usePref(key: string): [string | null, (v: string) => void] {
  const v = useSyncExternalStore(subscribePrefs, () => readPref(key), () => null);
  const set = useCallback((n: string) => { try { localStorage.setItem(prefKey(key), n); } catch { /* blocked storage */ } window.dispatchEvent(new Event(PREF_EVENT)); }, [key]);
  return [v, set];
}

export type TradeWith = "trading" | "wallet";
/// Which one trades when both are ready (the trading wallet unless the user picked the extension).
export function useTradeWith(): [TradeWith, (v: TradeWith) => void] {
  const [v, set] = usePref("trade-with");
  return [v === "wallet" ? "wallet" : "trading", set as (v: TradeWith) => void];
}
/// Trading-wallet trades up to this many SOL (paid, or received on a sell) sign as soon as the button is pressed; larger
/// ones show the confirm sheet first. 0 asks every time.
export const DEFAULT_INSTANT_SOL = 1;
export function useInstantSol(): [number, (v: number) => void] {
  const [v, set] = usePref("instant-sol");
  const n = v === null ? DEFAULT_INSTANT_SOL : Number(v);
  return [Number.isFinite(n) && n >= 0 ? n : DEFAULT_INSTANT_SOL, useCallback((x: number) => set(String(x)), [set])];
}

/// How old the quote on screen may be for a trade to sign from it at once (the widget refreshes it every 20 s).
export const INSTANT_MAX_AGE_MS = 30_000;
/// Whether pressing the trade button signs at once, with no confirm sheet: only with the trading wallet, only the quote
/// the user is looking at (a quote refreshed after the click always goes through the sheet), only while it is recent,
/// never right after the price moved past the minimum, and only up to the user's limit: the SOL paid, or on a sell the
/// SOL that quote gives (0 asks every time). The exact transaction is simulated before it is signed either way, with
/// the minimum shown.
export function signsAtOnce(o: { trader: Trader["kind"]; moved: boolean; side: "buy" | "sell"; amountIn: bigint; amountOut: bigint; at: number; instantSol: number; now: number }): boolean {
  if (o.trader !== "trading" || o.moved || !(o.instantSol > 0)) return false;
  if (o.now - o.at > INSTANT_MAX_AGE_MS || o.now < o.at) return false;
  return Number(o.side === "buy" ? o.amountIn : o.amountOut) / 1e9 <= o.instantSol;
}

export type Trader = { kind: "trading" | "wallet" | null; publicKey: PublicKey | null; sender: TxSender | null };
/// The signer of the next trade: the unlocked trading wallet when it is preferred (or no wallet is connected), else the
/// connected wallet, else nobody.
export function useTrader() {
  const wallet = useWallet();
  const tw = useTradingWallet();
  const [tradeWith, setTradeWith] = useTradeWith();
  const trader: Trader = useMemo(() => {
    if (tw.status === "unlocked" && (tradeWith === "trading" || !wallet.connected)) {
      const s = tradingSender();
      if (s) return { kind: "trading", publicKey: s.publicKey, sender: s };
    }
    if (wallet.connected && wallet.publicKey) return { kind: "wallet", publicKey: wallet.publicKey, sender: wallet };
    return { kind: null, publicKey: null, sender: null };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tw.status, tw.address, tradeWith, wallet.connected, wallet.publicKey, wallet.sendTransaction]);
  return { trader, tw, walletConnected: wallet.connected, walletName: wallet.wallet?.adapter.name ?? null, tradeWith, setTradeWith };
}

/// Opens the trading-wallet panel (components/TradingWallet.tsx listens), on a given view.
export type TradingWalletView = "default" | "deposit";
export const OPEN_EVENT = "spore:trading-wallet-open";
export const openTradingWallet = (view: TradingWalletView = "default") => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: view }));
