// The header's one wallet control. Spore has two wallets a user can trade with: the trading wallet kept in this browser
// (lib/trading-wallet.ts, signs at once) and the connected extension (Phantom, Solflare…, which asks for each
// transaction). The button shows the one that trades now; its menu holds both, and which one trades.
// `inline`: the same content without the button, for the phone menu (already a sheet of its own).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useLocation } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { solscanAccount } from "../lib/api";
import { lamportsToSol, short, sol } from "../lib/format";
import { copyText, useSolBalance } from "../lib/hooks";
import { lockTradingWallet } from "../lib/trading-wallet";
import { openTradingWallet, useTrader } from "../lib/trader";
import { Ext } from "./Bits";
import { BoltGlyph, LockGlyph } from "./TradingWallet";
import { useToast } from "./Toast";
import "./wallet-menu.css";

/// `onOpen`: told when the popover opens (the bar closes its ☰ sheet, so the two never stack).
export default function WalletMenu({ inline = false, onAction, onOpen }: { inline?: boolean; onAction?: () => void; onOpen?: () => void }) {
  const { trader, tw, walletConnected, walletName, tradeWith, setTradeWith } = useTrader();
  const wallet = useWallet();
  const { setVisible, visible: modalVisible } = useWalletModal();
  const { connection } = useConnection();
  const twKey = useMemo(() => (tw.address ? new PublicKey(tw.address) : null), [tw.address]);
  // the trading wallet's balance is public: shown while locked too (only signing needs the password)
  const twBal = useSolBalance(connection, twKey, 30_000);
  const balText = twBal.lamports != null ? sol(lamportsToSol(twBal.lamports)) : "…";
  const ext = wallet.publicKey?.toBase58() ?? null;
  const icon = wallet.wallet?.adapter.icon;
  const toast = useToast();
  // the adapter's own states the old button showed: a connect under way, and a wallet chosen but not connected
  const connecting = wallet.connecting;
  const chosen = !walletConnected && !connecting && !!wallet.wallet;
  // a remembered wallet that this browser does not have (uninstalled, another browser): connecting would only open its
  // download page
  const installed = !!wallet.wallet && (wallet.wallet.readyState === WalletReadyState.Installed || wallet.wallet.readyState === WalletReadyState.Loadable);
  // The adapter's wallet picker does not take the keyboard focus by itself: give it to its first button, and back to
  // whatever opened it when it closes.
  const modalOpener = useRef<HTMLElement | null>(null);
  const openModal = () => {
    const a = document.activeElement;
    modalOpener.current = a instanceof HTMLElement && a !== document.body ? a : null;
    setVisible(true);
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(".wallet-adapter-modal-list button, .wallet-adapter-modal-button-close")?.focus()));
  };
  useEffect(() => {
    if (modalVisible || !modalOpener.current) return;
    const el = modalOpener.current;
    modalOpener.current = null;
    if (el.isConnected) el.focus({ preventScroll: true });
  }, [modalVisible]);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null), btnRef = useRef<HTMLButtonElement>(null), popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  // a new page closes it
  const { pathname } = useLocation();
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>("button, a[href]")?.focus({ preventScroll: true });
    // Escape is the popover's only while the focus is in it
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && rootRef.current?.contains(document.activeElement)) { setOpen(false); btnRef.current?.focus(); } };
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open]);
  /// Every action leaves the menu (a dialog or the wallet picker takes over). Focus moves to the wallet button first (the
  /// popover is about to go), so a dialog that opens returns it there when it closes.
  const act = (fn: () => void) => () => { if (!inline) btnRef.current?.focus({ preventScroll: true }); setOpen(false); onAction?.(); fn(); };
  const copy = (text: string) => () => { void copyText(text).then((ok) => (ok ? toast.success("Address copied") : toast.error("Could not copy the address"))); };

  const body = (
    <>
      <section className="wm-sec" aria-label="Trading wallet">
        <div className="wm-head">
          <span className="wm-title"><BoltGlyph size={12} /> Trading wallet</span>
          <span className={`wm-state ${tw.status}`}>{tw.status === "unlocked" ? (trader.kind === "trading" ? "trading" : "unlocked") : tw.status === "locked" ? "locked" : "not set up"}</span>
        </div>
        {tw.status === "none" ? (
          <>
            <p className="wm-note">A wallet kept in this browser: trades sign at once, with no popup for each buy and sell.</p>
            <button type="button" className="btn sm accent block" onClick={act(() => openTradingWallet())}>Set up a trading wallet</button>
          </>
        ) : (
          <>
            <div className="wm-row">
              <b className="mono wm-bal">{balText}</b>
              <span className="wm-addr"><code className="mono">{short(tw.address, 4)}</code> <button type="button" className="linkish" aria-label="Copy the trading wallet's address" onClick={copy(tw.address!)}>copy</button></span>
            </div>
            {tw.status === "locked"
              ? <button type="button" className="btn sm accent block" onClick={act(() => openTradingWallet())}><LockGlyph /> Unlock</button>
              : (
                <div className="wm-actions">
                  <button type="button" className="btn sm" onClick={act(() => openTradingWallet("deposit"))}>Deposit</button>
                  <button type="button" className="btn sm ghost" onClick={act(() => openTradingWallet())}>Withdraw · settings</button>
                  <button type="button" className="btn sm ghost" title="Locks it in every tab of this site" onClick={act(() => lockTradingWallet())}><LockGlyph /> Lock</button>
                </div>
              )}
          </>
        )}
      </section>

      <section className="wm-sec" aria-label="Connected wallet">
        <div className="wm-head">
          <span className="wm-title">{icon && <img src={icon} alt="" width={14} height={14} />} {walletConnected || connecting || chosen ? walletName ?? "Wallet" : "Your wallet"}</span>
          <span className={`wm-state ${walletConnected ? "on" : "none"}`}>{walletConnected ? (trader.kind === "wallet" ? "trading" : "connected") : connecting ? "connecting…" : "not connected"}</span>
        </div>
        {walletConnected && ext ? (
          <>
            <div className="wm-row">
              <span className="wm-addr"><code className="mono">{short(ext, 4)}</code> <button type="button" className="linkish" aria-label={`Copy ${walletName ?? "the wallet"}'s address`} onClick={copy(ext)}>copy</button> <Ext href={solscanAccount(ext)}>solscan ↗</Ext></span>
            </div>
            <div className="wm-actions">
              <button type="button" className="btn sm ghost" onClick={act(() => openModal())}>Change wallet</button>
              <button type="button" className="btn sm ghost" onClick={act(() => { wallet.disconnect().catch(() => toast.error("The wallet did not disconnect; try again from the wallet itself")); })}>Disconnect</button>
            </div>
          </>
        ) : connecting ? (
          <p className="wm-note">Approve the connection in {walletName ?? "your wallet"}…</p>
        ) : chosen && installed ? (
          <div className="wm-actions">
            <button type="button" className="btn sm" onClick={act(() => { wallet.connect().catch(() => toast.error(`${walletName ?? "The wallet"} did not connect`)); })}>Connect {walletName}</button>
            <button type="button" className="btn sm ghost" onClick={act(() => openModal())}>Change wallet</button>
          </div>
        ) : chosen ? (
          <>
            <p className="wm-note">{walletName} is not installed in this browser.</p>
            <button type="button" className="btn sm block" onClick={act(() => openModal())}>Choose a wallet</button>
          </>
        ) : (
          <>
            <p className="wm-note">Phantom, Solflare or Backpack: it approves each transaction, and funds the trading wallet.</p>
            <button type="button" className="btn sm block" onClick={act(() => openModal())}>Connect a wallet</button>
          </>
        )}
      </section>

      {tw.status === "unlocked" && walletConnected && (
        <section className="wm-sec wm-with" aria-label="Trade with">
          <span className="wm-title">Trade with</span>
          <span className="seg" role="group" aria-label="Trade with">
            <button type="button" aria-pressed={tradeWith === "trading"} onClick={() => setTradeWith("trading")}><BoltGlyph size={11} /> Trading wallet</button>
            <button type="button" aria-pressed={tradeWith === "wallet"} onClick={() => setTradeWith("wallet")}>{walletName ?? "Wallet"}</button>
          </span>
        </section>
      )}
    </>
  );

  if (inline) return <div className="wm-inline">{body}</div>;

  // The button: the wallet that trades now. The trading wallet with its balance (a lock while locked), else the
  // connected wallet's address, else an invitation.
  const label = trader.kind === "trading" ? <><BoltGlyph /><span className="mono">{balText}</span></>
    : trader.kind === "wallet" ? <>{icon ? <img src={icon} alt="" width={16} height={16} /> : <i className="wm-dot" aria-hidden="true" />}<span className="mono">{short(ext, 4)}</span></>
    : tw.status === "locked" ? <><LockGlyph /><span className="mono">{balText}</span></>
    : <span>{connecting ? "Connecting…" : "Connect"}</span>;
  const title = trader.kind === "trading" ? "Trading wallet: trades sign at once" : trader.kind === "wallet" ? `${walletName ?? "Wallet"}: approves each trade` : tw.status === "locked" ? "Trading wallet locked" : "Connect a wallet or set up a trading wallet";
  // what a screen reader announces: which wallet, not only "0.42 SOL" or an address
  const ariaLabel = trader.kind === "trading" ? `Wallets: trading wallet, ${balText}` : trader.kind === "wallet" ? `Wallets: ${walletName ?? "wallet"} ${short(ext, 4)}` : tw.status === "locked" ? `Wallets: trading wallet locked, ${balText}` : connecting ? "Wallets: connecting" : "Wallets: connect";
  return (
    <div className="wm" ref={rootRef} onBlur={(e) => { const to = e.relatedTarget as Node | null; if (open && to && !rootRef.current?.contains(to)) setOpen(false); }}>
      <button ref={btnRef} type="button" className={`wm-btn ${trader.kind ?? (tw.status === "locked" ? "locked" : "none")}`} title={title} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popId : undefined} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }}>
        {label}<svg className="wm-caret" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && <div ref={popRef} id={popId} className="wm-pop" role="dialog" aria-label="Wallets">{body}</div>}
    </div>
  );
}
