// The trading wallet in the UI (lib/trading-wallet.ts): a panel (opened from the header's wallet menu and the trade widget) to set it up, back up its key,
// unlock it, move SOL in and out, and choose how trades sign. Trades themselves happen in the trade widget, which signs
// with this wallet once it is unlocked (lib/trader.ts).
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { solscanAccount, solscanTx } from "../lib/api";
import { useDialog } from "../lib/dialog";
import { useScrollLock, useSolBalance } from "../lib/hooks";
import { sendAndConfirm } from "../lib/pump";
import { friendlyError } from "../lib/steps";
import { lamportsToSol, parseAmount, short, sol } from "../lib/format";
import {
  AUTO_LOCK_MS, MIN_PASSWORD, buildTransfer, lockIfIdle, createTradingWallet, importTradingWallet, lockTradingWallet, markTradingWalletBackedUp,
  removeTradingWallet, revealTradingSecret, tradingSender, unlockTradingWallet, withdrawAllLamports, withdrawError, WrongPasswordError,
} from "../lib/trading-wallet";
import { OPEN_EVENT, useInstantSol, useTradeWith, useTradingWallet, type TradingWalletView } from "../lib/trader";
import { Ext } from "./Bits";
import { useToast } from "./Toast";
import "./coin.css";
import "./trading-wallet.css";

export const BoltGlyph = ({ size = 13 }: { size?: number }) => <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M13.2 2.5 4.8 13.4c-.3.4 0 .9.5.9H11l-1.1 7.2c-.1.6.6.9 1 .4l8.3-10.9c.3-.4 0-.9-.5-.9H13l1.2-7.1c.1-.6-.6-.9-1-.5Z" /></svg>;
export const LockGlyph = ({ size = 12 }: { size?: number }) => <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;

/// The "sign at once" limit as typed (no exponent, which the field's filter would mangle): 0.000001, not 1e-6.
const limitText = (n: number) => (n > 0 ? n.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") : "0");
/// A deposit smaller than this would not even keep the new account open (rent), and is not worth a trade.
const MIN_DEPOSIT_LAMPORTS = 10_000_000n;
const QUICK_DEPOSIT = ["0.1", "0.5", "1"];
/// The shown key is hidden again after this long.
const SECRET_SHOW_MS = 60_000;

/// Renders the panel when anything asks for it (the header's wallet menu, the trade widget). Mounted once, in the app shell.
export function TradingWalletHost() {
  const [view, setView] = useState<TradingWalletView | null>(null);
  // what had the focus when the panel was asked for: it gets it back when the panel closes
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const a = document.activeElement;
      opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
      setView(((e as CustomEvent).detail as TradingWalletView) ?? "default");
    };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  return view ? <TradingWalletPanel view={view} onClose={() => setView(null)} returnFocus={opener} /> : null;
}

function TradingWalletPanel({ view, onClose, returnFocus }: { view: TradingWalletView; onClose: () => void; returnFocus: { current: HTMLElement | null } }) {
  const tw = useTradingWallet();
  // a transfer in flight keeps the panel open (closing it would hide whether the money moved)
  const busy = useRef(false);
  const close = () => { if (!busy.current) onClose(); };
  const ref = useDialog<HTMLDivElement>(true, close, { returnFocus });
  const titleId = useId();
  useScrollLock(true);
  const title = tw.status === "none" ? "Set up a trading wallet" : tw.status === "locked" ? "Unlock your trading wallet" : !tw.backedUp ? "Save your private key" : "Trading wallet";
  return createPortal(
    <div className="confirm-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} className="confirm tw-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="confirm-head"><span className="tw-badge"><BoltGlyph size={16} /></span><b id={titleId}>{title}</b><button type="button" className="sheet-close" aria-label="Close" onClick={close}>×</button></div>
        {!tw.storage ? <p className="notice warn compact">This browser blocks local storage (a private window, or site data turned off), so it cannot keep a trading wallet.</p>
          : tw.status === "none" ? <Setup />
          : tw.status === "locked" ? <Unlock />
          : !tw.backedUp ? <Backup />
          : <Manage address={tw.address!} focusDeposit={view === "deposit"} busy={busy} />}
      </div>
    </div>,
    document.body,
  );
}

function Setup() {
  const [mode, setMode] = useState<"create" | "import">("create");
  const [pw, setPw] = useState(""), [pw2, setPw2] = useState(""), [secret, setSecret] = useState(""), [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (pw.length < MIN_PASSWORD) return setErr(`Use a password of at least ${MIN_PASSWORD} characters`);
    if (pw !== pw2) return setErr("The two passwords differ");
    if (!ack) return setErr("Tick the box to confirm you understand how this wallet is kept");
    setBusy(true);
    try { if (mode === "create") await createTradingWallet(pw); else await importTradingWallet(secret, pw); }
    catch (x) { setErr(friendlyError(x)); }
    finally { setBusy(false); setPw(""); setPw2(""); setSecret(""); }
  };
  return (
    <form className="tw-body" onSubmit={submit}>
      <ul className="tw-points">
        <li><b>Trades sign at once</b>, with no wallet popup for each buy and sell.</li>
        <li><b>The key stays in this browser</b>, encrypted with your password. Spore's server never sees it.</li>
        <li><b>It is a hot wallet:</b> move in only what you trade with, and save its key. Anyone with the key, or this browser while it is unlocked, can spend it.</li>
      </ul>
      <div className="seg tw-mode" role="group" aria-label="New or existing wallet">
        <button type="button" aria-pressed={mode === "create"} onClick={() => setMode("create")}>New wallet</button>
        <button type="button" aria-pressed={mode === "import"} onClick={() => setMode("import")}>Import a key</button>
      </div>
      {mode === "import" && (
        <label className="field"><span>Private key <small className="muted">(base58, as Phantom or Solflare export it, or a JSON array)</small></span>
          <textarea className="input mono tw-secret-in" rows={3} autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
      )}
      <label className="field"><span>Password <small className="muted">(at least {MIN_PASSWORD} characters; it cannot be recovered)</small></span>
        <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      <label className="field"><span>Password again</span>
        <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
      <label className="tw-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand that this wallet lives only in this browser: if this browser's data is cleared, only its saved private key brings the funds back (the password alone cannot), and if I lose that key, they are gone.</label>
      {err && <p className="notice warn compact" role="alert">{err}</p>}
      <button type="submit" className="btn accent block" disabled={busy || (mode === "import" && !secret.trim())}>{busy ? "Encrypting…" : mode === "create" ? "Create trading wallet" : "Import trading wallet"}</button>
    </form>
  );
}

/// Asks the password, then shows the key until hidden again or `SECRET_SHOW_MS` passes; the key never enters state for
/// longer than it is on screen.
function RevealKey({ children, onShown }: { children?: (secret: string) => ReactNode; onShown?: () => void }) {
  const [pw, setPw] = useState(""), [secret, setSecret] = useState<string | null>(null), [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!secret) return; const t = setTimeout(() => setSecret(null), SECRET_SHOW_MS); return () => clearTimeout(t); }, [secret]);
  const reveal = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { setSecret(await revealTradingSecret(pw)); onShown?.(); }
    catch (x) { setErr(x instanceof WrongPasswordError ? "Wrong password" : friendlyError(x)); }
    finally { setBusy(false); setPw(""); }
  };
  if (!secret) return (
    <form className="tw-row" onSubmit={reveal}>
      <input className="input" type="password" autoComplete="current-password" placeholder="Password" aria-label="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button type="submit" className="btn" disabled={busy || !pw}>{busy ? "Opening…" : "Show key"}</button>
      {err && <p className="notice warn compact tw-full" role="alert">{err}</p>}
    </form>
  );
  return (
    <div className="tw-key">
      <code className="mono" aria-label="Private key">{secret}</code>
      <div className="tw-row">
        <button type="button" className="btn sm" onClick={() => { navigator.clipboard?.writeText(secret).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="btn sm ghost" onClick={() => setSecret(null)}>Hide</button>
        <small className="muted">Hidden again in a minute. Anyone who sees it can spend this wallet.</small>
      </div>
      {children?.(secret)}
    </div>
  );
}

function Backup() {
  const [saved, setSaved] = useState(false), [shown, setShown] = useState(false), [removing, setRemoving] = useState(false);
  if (removing) return <Remove balance={0n} onCancel={() => setRemoving(false)} />;
  return (
    <div className="tw-body">
      <p className="hint">Before you move SOL in, save this wallet's private key somewhere safe: a password manager, or on paper. It is the only way back to its funds if this browser's data is cleared or you forget the password. Wallets like Phantom and Solflare can import it.</p>
      <RevealKey onShown={() => setShown(true)} />
      <label className={`tw-check ${shown ? "" : "muted"}`}><input type="checkbox" checked={saved} disabled={!shown} onChange={(e) => setSaved(e.target.checked)} /> I saved the private key somewhere safe.</label>
      <button type="button" className="btn accent block" disabled={!shown || !saved} onClick={() => markTradingWalletBackedUp()}>{shown ? "Done" : "Show the key first"}</button>
      <div className="tw-row tw-small"><button type="button" className="linkish" onClick={() => lockTradingWallet()}>Lock</button><span className="muted">·</span><button type="button" className="linkish" onClick={() => setRemoving(true)}>Start over with another wallet</button></div>
    </div>
  );
}

function Unlock() {
  const [pw, setPw] = useState(""), [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false), [forgot, setForgot] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await unlockTradingWallet(pw); }
    catch (x) { setErr(x instanceof WrongPasswordError ? "Wrong password" : friendlyError(x)); }
    finally { setBusy(false); setPw(""); }
  };
  if (forgot) return <Remove onCancel={() => setForgot(false)} />;
  return (
    <form className="tw-body" onSubmit={submit}>
      <p className="hint">Unlocked, it signs your trades at once until you lock it, close this tab, or leave it unused for {Math.round(AUTO_LOCK_MS / 60_000)} minutes.</p>
      <input className="input" type="password" autoComplete="current-password" placeholder="Password" aria-label="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      {err && <p className="notice warn compact" role="alert">{err}</p>}
      <button type="submit" className="btn accent block" disabled={busy || !pw}>{busy ? "Unlocking…" : "Unlock"}</button>
      <button type="button" className="linkish tw-small" onClick={() => setForgot(true)}>Forgot the password?</button>
    </form>
  );
}

function Remove({ onCancel, balance = null }: { onCancel: () => void; balance?: bigint | null }) {
  const [ack, setAck] = useState(false);
  const funded = balance == null || balance > 0n;
  return (
    <div className="tw-body">
      <p className="notice warn compact">Removing forgets this wallet in this browser. Its SOL{funded && balance != null ? ` (${sol(lamportsToSol(balance))})` : ""} and any coins it holds stay on chain, reachable only with its private key: import the saved key to use them again, here or in another wallet.</p>
      <label className="tw-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have this wallet's private key saved, or I accept losing everything it holds.</label>
      <div className="tw-row">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn" disabled={!ack} onClick={() => removeTradingWallet()}>Remove from this browser</button>
      </div>
    </div>
  );
}

function Manage({ address, focusDeposit, busy }: { address: string; focusDeposit: boolean; busy: { current: boolean } }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const owner = new PublicKey(address);
  const bal = useSolBalance(connection, owner, 15_000);
  const [tradeWith, setTradeWith] = useTradeWith();
  const [instantSol, setInstantSol] = useInstantSol();
  const [instantText, setInstantText] = useState(limitText(instantSol));
  const [section, setSection] = useState<"main" | "key" | "remove">("main");
  const [dep, setDep] = useState(""), [wd, setWd] = useState(""), [wdTo, setWdTo] = useState(""), [wdAsk, setWdAsk] = useState<{ to: string; lamports: bigint } | null>(null);
  const [work, setWork] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  const depRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusDeposit) depRef.current?.focus(); }, [focusDeposit]);
  const [rentFloor, setRentFloor] = useState<bigint | null>(null);
  useEffect(() => { connection.getMinimumBalanceForRentExemption(0).then((n) => setRentFloor(BigInt(n))).catch(() => setRentFloor(null)); }, [connection]);

  const dest = wdTo.trim() || wallet.publicKey?.toBase58() || "";
  const destKey = (() => { try { return dest ? new PublicKey(dest) : null; } catch { return null; } })();
  const wdLamports = wd.trim().toLowerCase() === "all" ? (bal.lamports != null ? withdrawAllLamports(bal.lamports) : null) : parseAmount(wd.trim(), 9);
  const wdErr = !wd.trim() ? null : wdLamports == null ? "Enter an amount" : bal.lamports == null || rentFloor == null ? null : withdrawError(bal.lamports, wdLamports, rentFloor);
  const depLamports = parseAmount(dep.trim(), 9);
  // SOL sent to an account a program owns, or to an address no key can sign for, is usually stuck there
  const [destWarn, setDestWarn] = useState<string | null>(null), [destAck, setDestAck] = useState(false), [destChecking, setDestChecking] = useState(false);
  const destStr = destKey?.toBase58() ?? "";
  useEffect(() => {
    setDestWarn(null); setDestAck(false); setDestChecking(false);
    if (!destStr) return;
    let alive = true;
    const k = new PublicKey(destStr);
    if (!PublicKey.isOnCurve(k.toBytes())) { setDestWarn("That address belongs to a program (no key can sign for it): SOL sent there may be lost."); return; }
    setDestChecking(true);
    connection.getAccountInfo(k, "confirmed").then((a) => {
      if (!alive) return;
      if (a && !a.owner.equals(SystemProgram.programId)) setDestWarn("That address is a program's account (a token account, a mint…), not a wallet: SOL sent there may be lost.");
    }).catch(() => { if (alive) setDestWarn("Spore could not check this address: make sure it is a wallet, not a token account or a program's."); })
      .finally(() => { if (alive) setDestChecking(false); });
    return () => { alive = false; };
  }, [destStr, connection]);
  // an open confirmation closes when what it confirms changed (another address, another amount, the wallet gone)
  useEffect(() => { if (wdAsk && (wdAsk.to !== destStr || wdAsk.lamports !== wdLamports)) setWdAsk(null); }, [wdAsk, destStr, wdLamports]);

  const run = async (label: string, fn: () => Promise<string>, done: string) => {
    setErr(null); setWork(label); busy.current = true;
    try {
      const sig = await fn();
      toast.success(done, { href: solscanTx(sig), label: "view transaction" });
      bal.refresh();
      return true;
    } catch (x) { setErr(friendlyError(x)); return false; }
    finally { setWork(null); busy.current = false; }
  };
  const deposit = async () => {
    if (work || !wallet.publicKey || depLamports == null) return;
    if (depLamports < MIN_DEPOSIT_LAMPORTS) { setErr("Move in at least 0.01 SOL"); return; }
    if (await run("Approve the deposit in your wallet…", async () => sendAndConfirm(connection, wallet, await buildTransfer(connection, wallet.publicKey!, owner, depLamports)), `Moved ${sol(lamportsToSol(depLamports))} into the trading wallet`)) setDep("");
  };
  const withdraw = async () => {
    const ask = wdAsk;
    if (work || !ask || destChecking || (destWarn && !destAck)) return;
    const sender = tradingSender();
    // the hour without use ran out (the timer has not ticked yet): lock now, and say so
    if (!sender) { lockIfIdle(); setWdAsk(null); setErr("The trading wallet locked after an hour without use: unlock it to withdraw"); return; }
    const left = bal.lamports != null && rentFloor != null ? withdrawError(bal.lamports, ask.lamports, rentFloor) : null;
    if (left) { setWdAsk(null); setErr(left); return; }
    setWdAsk(null);
    if (await run("Sending…", async () => sendAndConfirm(connection, sender, await buildTransfer(connection, owner, new PublicKey(ask.to), ask.lamports)), `Sent ${sol(lamportsToSol(ask.lamports))} to ${short(ask.to)}`)) { setWd(""); setWdTo(""); }
  };
  // what the field holds is the limit in force: empty (or not a number yet) asks every time
  const saveInstant = (v: string) => { setInstantText(v); const n = Number(v); setInstantSol(v.trim() !== "" && Number.isFinite(n) && n >= 1e-9 ? n : 0); };

  if (section === "key") return (
    <div className="tw-body">
      <p className="hint">The private key of this trading wallet, for a backup or to import it into Phantom, Solflare or Backpack.</p>
      <RevealKey />
      <button type="button" className="btn ghost" onClick={() => setSection("main")}>Back</button>
    </div>
  );
  if (section === "remove") return <Remove balance={bal.lamports} onCancel={() => setSection("main")} />;

  return (
    <div className="tw-body">
      <div className="tw-head-row">
        <div>
          <span className="card-label">Balance</span>
          <b className="tw-balance mono">{bal.lamports != null ? sol(lamportsToSol(bal.lamports)) : "…"}</b>
        </div>
        <div className="tw-addr">
          <code className="mono">{short(address, 5)}</code>
          <button type="button" className="linkish" onClick={() => navigator.clipboard?.writeText(address)}>copy</button>
          <Ext href={solscanAccount(address)}>solscan ↗</Ext>
        </div>
      </div>

      <section className="tw-section" aria-label="Deposit">
        <span className="card-label">Move SOL in</span>
        {wallet.connected ? (
          <>
            <div className="tw-row">
              <input ref={depRef} className="input mono" inputMode="decimal" placeholder="0.0" aria-label="SOL to move in" value={dep} disabled={!!work} onChange={(e) => setDep(e.target.value.replace(/[^\d.]/g, ""))} />
              <button type="button" className="btn accent" disabled={!!work || depLamports == null} onClick={deposit}>Deposit</button>
            </div>
            <div className="quick">{QUICK_DEPOSIT.map((q) => <button key={q} type="button" disabled={!!work} onClick={() => setDep(q)}>{q} SOL</button>)}</div>
            <small className="muted">From {wallet.wallet?.adapter.name ?? "your wallet"} ({short(wallet.publicKey?.toBase58())}): one approval there, then trades sign here.</small>
          </>
        ) : (
          <>
            <WalletMultiButton>Connect a wallet to deposit</WalletMultiButton>
            <small className="muted">Or send SOL to <code className="mono">{short(address, 6)}</code> from any wallet or exchange.</small>
          </>
        )}
      </section>

      <section className="tw-section" aria-label="Withdraw">
        <span className="card-label">Withdraw SOL</span>
        <div className="tw-row">
          <input className="input mono" inputMode="decimal" placeholder="0.0 or all" aria-label="SOL to withdraw" value={wd} disabled={!!work} onChange={(e) => { const v = e.target.value.trim(); setWd(wd === "all" && v.length < 3 && "all".startsWith(v.toLowerCase()) ? "" : /^a/i.test(v) ? "all" : v.replace(/[^\d.]/g, "")); setWdAsk(null); }} />
          <button type="button" className="btn sm ghost" disabled={!!work || bal.lamports == null} onClick={() => { setWd("all"); setWdAsk(null); }}>All</button>
        </div>
        <input className="input mono" placeholder={wallet.publicKey ? `To ${short(wallet.publicKey.toBase58(), 6)} (your wallet)` : "To address"} aria-label="Withdraw to address" value={wdTo} disabled={!!work} onChange={(e) => { setWdTo(e.target.value.trim()); setWdAsk(null); }} />
        {wdErr ? <small className="bad">{wdErr}</small> : dest && !destKey ? <small className="bad">That is not a Solana address</small> : null}
        {!wdAsk
          ? <button type="button" className="btn" disabled={!!work || !destKey || wdLamports == null || !!wdErr || destKey.equals(owner)} onClick={() => { if (destKey && wdLamports != null) setWdAsk({ to: destKey.toBase58(), lamports: wdLamports }); }}>Withdraw</button>
          : (
            <div className="tw-confirm" role="group" aria-label="Confirm the withdrawal">
              <span>Send <b className="mono">{sol(lamportsToSol(wdAsk.lamports))}</b> to <b className="mono">{short(wdAsk.to, 6)}</b>{wallet.publicKey?.toBase58() === wdAsk.to ? " (your wallet)" : ""}?</span>
              {destChecking && <small className="muted">Checking the address…</small>}
              {destWarn && <label className="tw-check bad"><input type="checkbox" checked={destAck} onChange={(e) => setDestAck(e.target.checked)} /> {destWarn} Send anyway.</label>}
              <div className="tw-row"><button type="button" className="btn ghost sm" disabled={!!work} onClick={() => setWdAsk(null)}>Cancel</button><button type="button" className="btn accent sm" disabled={!!work || destChecking || (!!destWarn && !destAck)} onClick={withdraw}>Send</button></div>
            </div>
          )}
      </section>

      {work && <p className="tw-work muted" role="status"><i className="spin" aria-hidden="true" /> {work}</p>}
      {err && <p className="notice warn compact" role="alert">{err}</p>}

      <section className="tw-section" aria-label="Settings">
        <span className="card-label">Trading</span>
        {wallet.connected && (
          <div className="tw-row tw-setting">
            <span>Trade with</span>
            <span className="seg" role="group" aria-label="Trade with">
              <button type="button" aria-pressed={tradeWith === "trading"} onClick={() => setTradeWith("trading")}>Trading wallet</button>
              <button type="button" aria-pressed={tradeWith === "wallet"} onClick={() => setTradeWith("wallet")}>{wallet.wallet?.adapter.name ?? "Wallet"}</button>
            </span>
          </div>
        )}
        <label className="tw-row tw-setting">
          <span>Sign at once up to</span>
          <span className="tw-instant"><input className="input mono" inputMode="decimal" aria-label="Sign at once up to (SOL)" value={instantText} onChange={(e) => saveInstant(e.target.value.replace(/[^\d.]/g, ""))} onBlur={() => setInstantText(limitText(instantSol))} /><em>SOL</em></span>
        </label>
        <small className="muted">Bigger trades show the confirm sheet first; 0 asks every time. Every trade is still simulated before it is signed.</small>
      </section>

      <div className="tw-actions">
        <button type="button" className="btn sm ghost" disabled={!!work} onClick={() => setSection("key")}>Show private key</button>
        <button type="button" className="btn sm ghost" disabled={!!work} title="Locks it in every tab of this site" onClick={() => lockTradingWallet()}><LockGlyph /> Lock</button>
        <button type="button" className="btn sm ghost" disabled={!!work} onClick={() => setSection("remove")}>Remove…</button>
      </div>
    </div>
  );
}
