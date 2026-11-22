// Who signs a trade: Spore's trading wallet (lib/trading-wallet.ts) when it is unlocked, or the connected wallet
// extension. The trade widget, the trading-wallet panel and the nav read the same answer and the same two settings.
// Who the user IS for everything else (launching, claiming, locking a fee split): the account wallet, `useAccount`
// at the end of this file. A trading wallet, once it exists, is the account; the extension is how the user arrived.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { subscribeTradingWallet, tradingSender, tradingWalletState, type TradingWalletState } from "./trading-wallet";
import type { TxSender } from "./pump/send";
import { formatPresets, parseSlippageBps, parseTradeSettings, type TradeSettings } from "./trade-settings";

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

/// The trade settings of this browser (lib/trade-settings.ts says what each stored value means): whether Buy / Sell
/// trade at once from presets, the presets, and the slippage, which is the ticket's own setting (TradeWidget reads the
/// same key when it opens). The cap of a trade signed at once stays `useInstantSol`.
export function useTradeSettings(): TradeSettings & { setInstant: (on: boolean) => void; setBuyPresets: (l: readonly number[]) => void; setSellPresets: (l: readonly number[]) => void; setSlippageBps: (bps: number) => void } {
  const [instant, setI] = usePref("instant-trades");
  const [buy, setB] = usePref("buy-presets");
  const [sell, setS] = usePref("sell-presets");
  const [slippage, setSl] = usePref("slippage");
  const v = useMemo(() => parseTradeSettings({ instant, buy, sell, slippage }), [instant, buy, sell, slippage]);
  const setInstant = useCallback((on: boolean) => setI(on ? "on" : "off"), [setI]);
  const setBuyPresets = useCallback((l: readonly number[]) => setB(formatPresets(l)), [setB]);
  const setSellPresets = useCallback((l: readonly number[]) => setS(formatPresets(l)), [setS]);
  const setSlippageBps = useCallback((bps: number) => setSl(String(bps)), [setSl]);
  return { ...v, setInstant, setBuyPresets, setSellPresets, setSlippageBps };
}
/// The slippage in basis points, for the ticket (TradeWidget): the same stored value the trade settings edit, read
/// through the same rule (lib/trade-settings.ts parseSlippageBps) and followed while it changes, so a ticket that is
/// already on screen trades with the setting just made and the two never apply different values.
export function useSlippageBps(): [number, (bps: number) => void] {
  const [raw, set] = usePref("slippage");
  return [useMemo(() => parseSlippageBps(raw), [raw]), useCallback((bps: number) => set(String(bps)), [set])];
}
/// Opens the trade settings dialog (components/TradeSettings.tsx listens).
export const SETTINGS_EVENT = "spore:trade-settings-open";
export const openTradeSettings = () => window.dispatchEvent(new Event(SETTINGS_EVENT));

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
/// "default" and "deposit": the user asked for the panel itself (the wallet menu, the ticket's "Manage", a deposit
/// link); it stays open after an unlock. "unlock": something needs the wallet unlocked (a trade, a launch, a claim, an
/// Unlock button): the panel asks the password and closes by itself once the wallet is unlocked. Nothing is signed by
/// the unlock itself: the user presses their button again, except on the coin page's trade and launch cards, where the
/// one click that asked for the unlock goes ahead once, within 60 s and unchanged (lib/pending-intent.ts). Asked while the wallet is already unlocked, "unlock" opens nothing.
export type TradingWalletView = "default" | "deposit" | "unlock";
export const OPEN_EVENT = "spore:trading-wallet-open";
/// The panel closed; `detail.unlocked`: whether the wallet is unlocked as it closes (components/TradingWallet.tsx).
export const CLOSED_EVENT = "spore:trading-wallet-closed";
export const openTradingWallet = (view: TradingWalletView = "default") => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: view }));

// ---- the account wallet: one wallet per user, for launches, claims and fee splits

export type AccountKind = "trading" | "wallet" | null;
/// `address` is "me". `locked`: the account is a trading wallet that cannot sign until its owner unlocks it.
/// `unsaved`: the account is a trading wallet whose private key was never saved outside this browser (the panel's
/// "Save your private key" step was not finished). Whatever would pay that wallet for good (a launch: creator and fee
/// shareholder, written once) waits for the save.
export type AccountChoice = { kind: AccountKind; address: string | null; locked: boolean; unsaved: boolean };
/// The user's account wallet. A trading wallet in this browser is the account, locked or not (its address is public
/// while locked; `ready` = it can sign now). Without one, the connected extension wallet is, exactly as before the
/// trading wallet existed. The extension never takes over from a locked trading wallet: the user unlocks instead.
export function chooseAccount(o: { trading: { address: string | null; ready: boolean; backedUp?: boolean }; ext: string | null }): AccountChoice {
  if (o.trading.address) return { kind: "trading", address: o.trading.address, locked: !o.trading.ready, unsaved: o.trading.backedUp === false };
  if (o.ext) return { kind: "wallet", address: o.ext, locked: false, unsaved: false };
  return { kind: null, address: null, locked: false, unsaved: false };
}
/// Which of the user's wallets an address is: the trading wallet, the connected extension, or neither. Two uses: a
/// fee share's "you" (a coin launched with the extension pays the extension, whoever signs the payout), and who must
/// sign what the chain accepts from one wallet only (a fee split: the coin's creator).
export function walletOf(address: string | null | undefined, o: { trading: string | null; ext: string | null }): "trading" | "wallet" | null {
  if (!address) return null;
  if (o.trading && address === o.trading) return "trading";
  if (o.ext && address === o.ext) return "wallet";
  return null;
}

/// Where the user's part of a payout goes, from the owner of each fee share (`walletOf`): the trading wallet, the
/// connected wallet, both (a split that names the two), or nobody (the user only triggers the payout).
export type PaidTo = "trading" | "wallet" | "both" | null;
export function paidToOf(owners: readonly ("trading" | "wallet" | null)[]): PaidTo {
  const t = owners.includes("trading"), w = owners.includes("wallet");
  return t && w ? "both" : t ? "trading" : w ? "wallet" : null;
}

/// A payout's failure, in the payer's words. The trading wallet pays the network fee of every payout it signs, also
/// for coins whose part goes to the connected wallet, so "the wallet has no SOL" must name it: a user who arrived with
/// a funded extension would otherwise look at the wrong wallet. `fund`: the cure is SOL in the trading wallet.
export function payerProblem(friendly: string, silent: boolean): { text: string; fund: boolean } {
  if (!silent || !/^(Not enough SOL|The wallet has no SOL yet)/.test(friendly)) return { text: friendly, fund: false };
  const short = friendly.match(/short by ([\d.,]+ SOL)/);
  return {
    text: /no SOL yet/.test(friendly) ? "Your trading wallet pays the network fee of a payout and holds no SOL yet. Add SOL to it, then claim again. Nothing was signed."
      : `Your trading wallet pays the network fee of a payout and does not hold enough SOL${short ? ` (short by ${short[1]})` : ""}. Add SOL to it, then claim again. Nothing was signed.`,
    fund: true,
  };
}

/// "Claim all" with the trading wallet: the list shows each coin's simulated cost before Start, and a payout is signed
/// only when the simulation of the transaction about to be signed costs no more than that (plus this slack, lamports).
/// A cost that could not be measured, then or now, is never signed blind.
export const CLAIM_COST_SLACK = 10_000n;
export function withinQuotedCost(quoted: bigint | null, now: bigint | null): boolean {
  return quoted !== null && now !== null && now <= quoted + CLAIM_COST_SLACK;
}

/// The words of a payout's confirm dialog, the same on the coin page and in the claim flow. A payout pays the wallets
/// of the coin's fee split whoever signs it, so the hint names where the user's part goes when that is not the wallet
/// that signs. `silent`: the trading wallet signs (no extension popup follows the button). `paidTo`: which of the
/// user's wallets holds a share (null: none; the user only triggers the payout). `extLabel`: the extension's address,
/// shortened, for the one case that needs it.
export function claimWords(o: { dry: boolean; silent: boolean; paidTo: PaidTo; extLabel?: string | null }): { button: string; hint: string } {
  if (o.dry) return { button: "Simulate", hint: "Dry run: the transaction is simulated again instead of signed." };
  const mine = !!o.paidTo;
  if (!o.silent) {
    return {
      button: mine ? "Claim in wallet" : "Pay out in wallet",
      hint: mine ? "Simulated on-chain just now. Your part arrives in this wallet together with every other shareholder's."
        : "Simulated on-chain just now. You pay only the network fee; the money goes to the shareholders above, none of it to you.",
    };
  }
  const signs = "Your trading wallet signs when you press the button; no wallet popup follows.";
  return {
    button: mine ? "Claim now" : "Pay out now",
    hint: o.paidTo === "both" ? `Simulated on-chain just now. This coin's fee split names both of your wallets: one part arrives in your trading wallet, the other goes to your connected wallet${o.extLabel ? ` ${o.extLabel}` : ""}, as the rows above show. ${signs}`
      : o.paidTo === "trading" ? `Simulated on-chain just now. Your part arrives in your trading wallet together with every other shareholder's. ${signs}`
      : o.paidTo === "wallet" ? `Simulated on-chain just now. Your part goes to your connected wallet${o.extLabel ? ` ${o.extLabel}` : ""}, the one this coin's fee split names, not to the trading wallet, which only pays the network fee. ${signs}`
      : `Simulated on-chain just now. Your trading wallet pays only the network fee; the money goes to the shareholders above, none of it to you. ${signs}`,
  };
}

export type Account = AccountChoice & {
  publicKey: PublicKey | null;
  /// What signs for the account now; null while there is no account or it is locked.
  sender: TxSender | null;
  /// The connected extension wallet, whether or not it is the account.
  ext: { address: string | null; sender: TxSender | null; name: string | null };
  walletOf: (address: string | null | undefined) => "trading" | "wallet" | null;
};
/// The account wallet for the flows that are not trades (launch, claim, fee split): see `chooseAccount`.
export function useAccount(): Account {
  const wallet = useWallet();
  const tw = useTradingWallet();
  const extAddr = wallet.connected && wallet.publicKey ? wallet.publicKey.toBase58() : null;
  return useMemo(() => {
    // an idle session counts as locked (tradingSender is null), a moment before the timer locks it
    const ts = tw.status === "unlocked" ? tradingSender() : null;
    const choice = chooseAccount({ trading: { address: tw.address, ready: !!ts, backedUp: tw.backedUp }, ext: extAddr });
    const extSender: TxSender | null = extAddr ? wallet : null;
    let publicKey: PublicKey | null = null;
    try { publicKey = choice.address ? new PublicKey(choice.address) : null; } catch { publicKey = null; }
    return {
      ...choice, publicKey,
      sender: choice.kind === "trading" ? ts : choice.kind === "wallet" ? extSender : null,
      ext: { address: extAddr, sender: extSender, name: wallet.wallet?.adapter.name ?? null },
      walletOf: (a) => walletOf(a, { trading: tw.address, ext: extAddr }),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tw.status, tw.address, tw.backedUp, extAddr, wallet.sendTransaction, wallet.wallet]);
}
