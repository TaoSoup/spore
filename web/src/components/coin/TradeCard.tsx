// The coin page's one trade card (desktop side column): Buy | Sell, the route and the balance that matters, four (or
// three) large preset buttons that trade on one click, a custom amount, and one status line (who signs, the slippage,
// the settings). It replaces the old preset strip and the inline ticket; the full ticket still opens as a dialog when
// an instant trade hands the trade back (over the cap, high impact, ...), prefilled, as on the map and the Portfolio.
// Every click goes to the page (`onTrade`), which runs it through the instant path (components/useInstantTrade.ts,
// lib/instant-trade.ts: every guard, a fresh quote) or, with a locked trading wallet, asks for the unlock and lets that
// one click go ahead after it (components/useUnlockContinuation.ts). Nothing here signs.
// Presses are guarded as the old strip's were: nothing counts for PRESET_GUARD_MS after the buttons became live or
// changed their amounts, a held key never presses one, and a press moves the focus off the button onto the card's
// preset row, so the unlock panel giving the focus back cannot turn a later Enter into a second trade.
import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { pumpUrl, type Coin } from "../../lib/api";
import { useBalances } from "../../lib/balances";
import { amount, exactAmount, lamportsToSol, sol, tokens } from "../../lib/format";
import type { InstantSpec } from "../../lib/instant-trade";
import { presetChoices, pressCounts } from "../../lib/instant-outcome";
import type { TradeSource } from "../../lib/pending-intent";
import type { Side } from "../../lib/pump";
import { routeLine } from "../../lib/route-line";
import { parseBuyPreset, parseSellPreset, presetText, sellAmountOf } from "../../lib/trade-settings";
import type { TradeRoute } from "../../lib/trade-route";
import { openTradeSettings, openTradingWallet, useTradingWallet } from "../../lib/trader";
import { Ext, sym } from "../Bits";
import { PRESET_GUARD_MS } from "../TradePresets";
import { BoltGlyph } from "../TradingWallet";
import SlidingPill from "../ui/SlidingPill";
import "../trade-presets.css";

/// Who signs a click now (lib/instant-outcome.ts instantSigner), or "off" when instant trades are turned off.
export type SignerState = "trading" | "unlock" | "wallet" | "none";
/// The card's side and custom text, read by the page when a remembered click is about to go ahead after an unlock.
export type TradeCardView = { side: Side; custom: string };

const GearGlyph = () => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>;

export type TradeCardProps = {
  coin: Coin;
  route: { data: TradeRoute | null; error: string | null };
  /// Why the coin cannot be traded here (the route's hard block, or what the last instant trade found): pump.fun instead.
  blocked: { short: string; body: string } | null;
  presets: { buy: readonly number[]; sell: readonly number[] };
  instantOn: boolean;
  signer: SignerState;
  slippageBps: number;
  /// A trade of the page is running (an instant one, or the ticket dialog's): every button is off.
  running: boolean;
  busySide: Side | null;
  /// An instant click: the page runs it (or remembers it across an unlock).
  onTrade: (spec: InstantSpec, source: TradeSource, view: TradeCardView) => void;
  /// Instant trades off: open the ticket with this amount (SOL on a buy, tokens on a sell).
  onTicket: (side: Side, amount: string) => void;
  /// The card's current side and custom text, for the page (see TradeCardView).
  viewRef: { current: TradeCardView | null };
  /// The custom amount field: the chart's empty-state Buy focuses it.
  inputRef: RefObject<HTMLInputElement | null>;
  /// A side the page asks for (the chart's Buy): `n` changes on each ask.
  sideAsk: { side: Side; n: number } | null;
};

export default function TradeCard({ coin, route, blocked, presets, instantOn, signer, slippageBps, running, busySide, onTrade, onTicket, viewRef, inputRef, sideAsk }: TradeCardProps) {
  const [side, setSide] = useState<Side>("buy");
  const [custom, setCustom] = useState("");
  const lastAsk = useRef(0);
  if (sideAsk && sideAsk.n !== lastAsk.current) { lastAsk.current = sideAsk.n; if (sideAsk.side !== side) { setSide(sideAsk.side); setCustom(""); } }
  viewRef.current = { side, custom };
  const { connection } = useConnection();
  const wallet = useWallet();
  const tw = useTradingWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  // the balances of the wallet that would sign a click now (the trading wallet's address is public while locked)
  const ownerKey = signer === "trading" || signer === "unlock" ? tw.address : signer === "wallet" ? wallet.publicKey?.toBase58() ?? null : null;
  let owner: PublicKey | null = null;
  try { owner = ownerKey ? new PublicKey(ownerKey) : null; } catch { owner = null; }
  const bal = useBalances(connection, owner, { mint: coin.mint, tokenProgram: coin.tokenProgram });
  const label = sym(coin);
  const list = side === "buy" ? presets.buy : presets.sell;
  const choices = presetChoices(side, list);
  const routeReady = !!route.data || !!route.error;
  const noTokens = side === "sell" && bal.token === 0n;
  const live = !running && !blocked && routeReady && !noTokens;
  // when the buttons last became pressable (or changed their amounts or side); null while they are off
  const armedAt = useRef<number | null>(null);
  const amounts = `${side}|${list.join(",")}`;
  useLayoutEffect(() => { armedAt.current = live ? performance.now() : null; }, [live, amounts]);
  const [pressed, setPressed] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const ticketAmount = (spec: InstantSpec): string => (spec.side === "buy" ? presetText(spec.sol)
    : bal.token != null && bal.token > 0n ? exactAmount(sellAmountOf(bal.token, spec.pct), coin.decimals) : "");
  const go = (spec: InstantSpec, source: TradeSource, key: string) => {
    setPressed(key);
    rowRef.current?.focus({ preventScroll: true });
    if (!instantOn) { onTicket(spec.side, ticketAmount(spec)); return; }
    onTrade(spec, source, { side, custom });
  };
  const press = (i: number, spec: InstantSpec) => () => {
    if (!pressCounts({ armedAt: armedAt.current, now: performance.now(), guardMs: PRESET_GUARD_MS })) return;
    go(spec, { kind: "preset", index: i }, `${side}:${i}`);
  };
  // a held Enter or Space repeats: the repeats never press a preset
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => { if ((e.key === "Enter" || e.key === " ") && e.repeat) e.preventDefault(); };

  const parsedCustom = side === "buy" ? parseBuyPreset(custom) : parseSellPreset(custom);
  const customBad = custom.trim() !== "" && parsedCustom === null;
  const onCustom = (e: FormEvent) => {
    e.preventDefault();
    if (!live || parsedCustom === null) return;
    const spec: InstantSpec = side === "buy" ? { side: "buy", sol: parsedCustom } : { side: "sell", pct: parsedCustom };
    go(spec, { kind: "custom" }, `${side}:custom`);
  };
  const switchSide = (s: Side) => { if (s === side || running) return; setSide(s); setCustom(""); };

  const line = routeLine(route.data, coin, side);
  const balText = !owner ? null : side === "buy" ? (bal.sol != null ? sol(lamportsToSol(bal.sol)) : "…") : (bal.token != null ? amount(tokens(bal.token, coin.decimals), label) : "…");
  const verb = side === "buy" ? "Buy" : "Sell";
  // what a click does now, said in each button's name and in the note: trades now, asks for the password and then
  // trades, opens the wallet setup (nothing trades), or opens the ticket (instant trades off)
  const mode: "now" | "unlock" | "setup" | "ticket" = !instantOn ? "ticket" : signer === "none" ? "setup" : signer === "unlock" ? "unlock" : "now";
  const tail = mode === "now" ? " now" : mode === "unlock" ? " after you unlock" : mode === "setup" ? ": opens wallet setup" : " in the ticket";
  // without a wallet the holding is not known: no "of your"
  const nameOf = (spec: InstantSpec) => (spec.side === "buy" ? `Buy ${spec.sol} SOL of ${label}` : `Sell ${spec.pct}% of ${owner ? "your " : ""}${label}`) + tail;
  const status = !instantOn ? { tone: "off", text: "Instant trades are off: a click opens the ticket" }
    : signer === "trading" ? { tone: "on", text: "Instant · trading wallet" }
    : signer === "unlock" ? { tone: "warn", text: "Locked: the first trade asks for your password" }
    : signer === "wallet" ? { tone: "warn", text: `${wallet.wallet?.adapter.name ?? "Your wallet"} signs: each trade opens its popup` }
    : { tone: "off", text: "No trading wallet" };
  const foot = "Every trade is quoted and simulated on-chain before it is signed; one over your limit, far from the spot price, or that cannot be checked opens the ticket instead.";

  return (
    <section className={`card trade compact coin-trade-card ${side}`} aria-label={`Buy or sell ${label}`}>
      <div className="trade-tabs" role="tablist" aria-label="Trade side">
        <SlidingPill items="[role=tab]" className="side-pill" />
        <button type="button" role="tab" aria-selected={side === "buy"} className={side === "buy" ? "on buy" : ""} disabled={running} onClick={() => switchSide("buy")}>Buy</button>
        <button type="button" role="tab" aria-selected={side === "sell"} className={side === "sell" ? "on sell" : ""} disabled={running} onClick={() => switchSide("sell")}>Sell</button>
      </div>
      <div className="ctc-line">
        <span className="ctc-route mono" title={line ? `${line.path} · ${line.hops}` : undefined}>{line ? <>{line.path} <span className="muted">· {line.hops}</span></> : route.error ? "Route not checked" : "Checking the route…"}</span>
        {balText && <span className="ctc-bal mono" title={side === "buy" ? "SOL in the wallet that trades" : `${label} in the wallet that trades`}>{balText}</span>}
      </div>
      {blocked ? (
        <p className="notice warn compact ctc-blocked">
          <span title={blocked.body}>Not tradable here · {blocked.short}</span>
          <Ext href={pumpUrl(coin.mint)} className="btn sm ghost" title={blocked.body}>Trade on pump.fun ↗</Ext>
        </p>
      ) : (
        <>
          <div ref={rowRef} tabIndex={-1} className={`ctc-presets n${choices.length}`} role="group" aria-label={`${verb} ${label}`} aria-busy={running || undefined} onKeyDown={onKeyDown}>
            {choices.map((c, i) => {
              const key = `${side}:${i}`;
              const spin = running && busySide === side && pressed === key;
              return (
                <button key={`${key}:${c.short}`} type="button" className={`btn ctc-preset ${side === "buy" ? "accent-soft" : "violet-soft"}${spin ? " is-busy" : ""}`} disabled={!live} aria-busy={spin || undefined}
                  aria-label={nameOf(c.spec)} title={nameOf(c.spec)} onClick={press(i, c.spec)}>
                  {side === "buy" ? <>{c.short}<small> SOL</small></> : c.short}
                </button>
              );
            })}
          </div>
          <p className="ctc-note muted">{noTokens ? `No ${label} in this wallet to sell.`
            : mode === "now" ? (side === "buy" ? "One click buys." : "One click sells.")
            : mode === "unlock" ? (side === "buy" ? "One click asks for your password, then buys." : "One click asks for your password, then sells.")
            : mode === "setup" ? "Set up a trading wallet or connect a wallet to trade. A click opens the setup."
            : "A click opens the ticket with that amount."}</p>
          <form className={`ctc-custom ${customBad ? "bad" : ""}`} onSubmit={onCustom}>
            <span className="amount">
              <input ref={inputRef} className="input mono" inputMode="decimal" autoComplete="off" placeholder={side === "buy" ? "0.0" : "1-100"} value={custom}
                aria-label={side === "buy" ? `Custom amount of SOL to buy ${label} with` : `Custom share of your ${label} to sell, in percent`} aria-invalid={customBad || undefined}
                onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ""))} />
              <em>{side === "buy" ? "SOL" : "%"}</em>
            </span>
            <button type="submit" className={`btn ${side === "buy" ? "accent" : "violet"}${running && busySide === side && pressed === `${side}:custom` ? " is-busy" : ""}`} disabled={!live || parsedCustom === null}
              aria-label={parsedCustom !== null ? nameOf(side === "buy" ? { side: "buy", sol: parsedCustom } : { side: "sell", pct: parsedCustom }) : verb}>{verb}</button>
          </form>
          {customBad && <small className="ctc-err" role="status">{side === "buy" ? "More than 0, at most 100 SOL, up to 4 decimals" : "A whole number from 1 to 100"}</small>}
        </>
      )}
      <div className="ctc-status">
        <span className={`ctc-dot ${status.tone}`} aria-hidden="true" />
        <span className="ctc-who">
          {status.text}
          {instantOn && signer === "none" && <> · <button type="button" className="linkish" onClick={() => openTradingWallet()}><BoltGlyph size={11} /> set one up</button> or <button type="button" className="linkish" onClick={() => openWalletModal(true)}>connect a wallet</button></>}
        </span>
        <span className="ctc-slip mono" title="Slippage of an instant trade (Trade settings)">{slippageBps / 100}% slip</span>
        <button type="button" className="ctc-gear" aria-label="Trade settings" title={`Trade settings. ${foot}`} onClick={() => openTradeSettings()}><GearGlyph /></button>
      </div>
    </section>
  );
}
