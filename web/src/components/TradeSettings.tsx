// Trade settings: whether Buy / Sell trade at once from presets, the three buy amounts and the three sell
// percentages, the slippage, and the largest trade the trading wallet signs with no ticket. One dialog, opened from the
// wallet menu, the Portfolio page and the trading wallet's panel (lib/trader.ts openTradeSettings). Everything is
// kept in this browser through lib/trader.ts (useTradeSettings, useInstantSol); lib/trade-settings.ts says what a
// valid value is. A field saves as soon as it holds a valid value and says why when it does not; what is stored is
// always valid. The "sign at once" limit is the exception: it saves on Enter or when the field is left, so a value
// passed on the way to another one (deleting the "." of "0.5" reads "05") is never the limit in force.
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "../lib/dialog";
import { useScrollLock } from "../lib/hooks";
import { SETTINGS_EVENT, useInstantSol, useTradeSettings, useTradingWallet } from "../lib/trader";
import { DEFAULT_SLIPPAGE_BPS, MAX_BUY_PRESET_SOL, MAX_CAP_SOL, MAX_INSTANT_IMPACT, MAX_SLIPPAGE_BPS, MIN_SETTINGS_SLIPPAGE_BPS, parseBuyPreset, parseCapSol, parseSellPreset, slippagePctToBps } from "../lib/trade-settings";
import "./coin.css";
import "./trade-settings.css";

/// Renders the dialog when anything asks for it. Mounted once, in the app shell.
export function TradeSettingsHost() {
  const [open, setOpen] = useState(false);
  // what had the focus when the dialog was asked for: it gets it back when the dialog closes
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const on = () => {
      const a = document.activeElement;
      opener.current = a instanceof HTMLElement && a !== document.body ? a : null;
      setOpen(true);
    };
    window.addEventListener(SETTINGS_EVENT, on);
    return () => window.removeEventListener(SETTINGS_EVENT, on);
  }, []);
  return open ? <TradeSettingsDialog onClose={() => setOpen(false)} returnFocus={opener} /> : null;
}

/// A number as a field shows it: no exponent (the field's filter would mangle one), no trailing zeros.
const plain = (n: number) => (n > 0 ? n.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") : "0");

/// One number of the settings. `value` is what is stored; the text is the user's until it parses, then it is saved.
/// Leaving the field puts the stored value back, so a half-typed or refused entry never stays on screen as if saved.
/// `onCommit`: save only on Enter or when the field is left (a valid entry), never while typing.
function NumField({ label, value, parse, onSave, unit, hint, onCommit = false }: { label: string; value: number; parse: (text: string) => number | null; onSave: (n: number) => void; unit: string; hint: string; onCommit?: boolean }) {
  const [text, setText] = useState(plain(value));
  const [focused, setFocused] = useState(false);
  // a value changed elsewhere (another tab, the reset) shows up unless the user is typing here
  useEffect(() => { if (!focused) setText(plain(value)); }, [value, focused]);
  const parsed = parse(text);
  const bad = text.trim() !== "" && parsed === null;
  const unsaved = onCommit && !bad && parsed !== null && parsed !== value;
  const errId = useId();
  const commit = () => { const n = parse(text); if (n !== null && n !== value) { onSave(n); return n; } return value; };
  return (
    <span className="ts-num">
      <span className="ts-in">
        <input className="input mono" inputMode="decimal" autoComplete="off" aria-label={label} aria-invalid={bad} aria-describedby={bad || unsaved ? errId : undefined} value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); setText(plain(onCommit ? commit() : value)); }}
          onKeyDown={(e) => { if (onCommit && e.key === "Enter") { e.preventDefault(); setText(plain(commit())); } }}
          onChange={(e) => { const t = e.target.value.replace(/[^\d.]/g, ""); setText(t); if (onCommit) return; const n = parse(t); if (n !== null && n !== value) onSave(n); }} />
        <em>{unit}</em>
      </span>
      {bad ? <small id={errId} className="ts-err" role="status">{hint}</small>
        : unsaved && <small id={errId} className="muted" role="status">Press Enter or leave the field to save</small>}
    </span>
  );
}

function TradeSettingsDialog({ onClose, returnFocus }: { onClose: () => void; returnFocus: { current: HTMLElement | null } }) {
  const ref = useDialog<HTMLDivElement>(true, onClose, { returnFocus });
  const titleId = useId();
  useScrollLock(true);
  const s = useTradeSettings();
  const [capSol, setCapSol] = useInstantSol();
  const tw = useTradingWallet();
  const setAt = (list: number[], save: (l: number[]) => void, i: number) => (n: number) => save(list.map((x, j) => (j === i ? n : x)));
  const pctOf = (bps: number) => bps / 100;
  return createPortal(
    <div className="confirm-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="confirm ts-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="confirm-head"><b id={titleId}>Trade settings</b><button type="button" className="sheet-close" aria-label="Close" onClick={onClose}>×</button></div>

        <section className="ts-sec" aria-label="Instant trades">
          <div className="ts-row">
            <span className="ts-k">Instant trades</span>
            <span className="seg" role="group" aria-label="Instant trades">
              <button type="button" aria-pressed={s.instant} onClick={() => s.setInstant(true)}>On</button>
              <button type="button" aria-pressed={!s.instant} onClick={() => s.setInstant(false)}>Off</button>
            </span>
          </div>
          <small className="muted">{s.instant
            ? "Buy and Sell on your portfolio show the presets below, and pressing one trades at once. \"Custom…\" opens the ticket."
            : "Buy and Sell open the ticket, where you set the amount and confirm."}</small>
        </section>

        <section className="ts-sec" aria-label="Buy presets">
          <span className="ts-k">Buy presets</span>
          <div className="ts-three">
            {s.buyPresets.map((v, i) => <NumField key={i} label={`Buy preset ${i + 1}, in SOL`} value={v} unit="SOL" parse={parseBuyPreset} onSave={setAt(s.buyPresets, s.setBuyPresets, i)} hint={`More than 0, at most ${MAX_BUY_PRESET_SOL} SOL, up to 4 decimals`} />)}
          </div>
        </section>

        <section className="ts-sec" aria-label="Sell presets">
          <span className="ts-k">Sell presets</span>
          <div className="ts-three">
            {s.sellPresets.map((v, i) => <NumField key={i} label={`Sell preset ${i + 1}, in percent of what you hold`} value={v} unit="%" parse={parseSellPreset} onSave={setAt(s.sellPresets, s.setSellPresets, i)} hint="A whole number from 1 to 100" />)}
          </div>
          <small className="muted">A share of what the wallet holds when you press it; 100% sells all of it.</small>
        </section>

        <section className="ts-sec" aria-label="Slippage">
          <div className="ts-row">
            <span className="ts-k">Slippage</span>
            <NumField label="Slippage, in percent" value={pctOf(s.slippageBps)} unit="%" parse={(t) => { const b = slippagePctToBps(t); return b === null ? null : pctOf(b); }} onSave={(p) => s.setSlippageBps(Math.round(p * 100))} hint={`From ${MIN_SETTINGS_SLIPPAGE_BPS / 100} to ${MAX_SLIPPAGE_BPS / 100}, up to 2 decimals`} />
          </div>
          <small className="muted">A trade that would fill more than this below its quote is refused.{s.slippageStored
            ? " The ticket uses the same value."
            : ` This is the default for instant trades; the ticket keeps its own ${DEFAULT_SLIPPAGE_BPS / 100}% until you set a value here or in the ticket.`}</small>
          {s.slippageBps >= 1000 && <p className="notice warn compact">High slippage: a fill up to {s.slippageBps / 100}% below the quote is accepted.</p>}
        </section>

        <section className="ts-sec" aria-label="Sign at once limit">
          <div className="ts-row">
            <span className="ts-k">Sign at once up to</span>
            <NumField label="Sign at once up to, in SOL" value={capSol} unit="SOL" parse={parseCapSol} onSave={setCapSol} onCommit hint={`A number of SOL from 0 to ${MAX_CAP_SOL.toLocaleString("en-US")}`} />
          </div>
          <small className="muted">For your trading wallet, which signs with no popup: a trade worth more opens the ticket first, and 0 opens it every time.{tw.status === "none" && " A connected wallet asks for its own approval on every trade instead."}</small>
        </section>

        <p className="hint ts-foot">Every instant trade is quoted and simulated before it is signed. One that is over the limit, lands more than {Math.round(MAX_INSTANT_IMPACT * 100)}% from the spot price, or cannot be checked opens the ticket instead. These settings are kept in this browser.</p>
      </div>
    </div>,
    document.body,
  );
}
