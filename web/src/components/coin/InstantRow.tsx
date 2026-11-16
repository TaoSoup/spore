// The coin page's instant trades on desktop: one compact row above the trade widget with the user's presets as buttons,
// "Buy" with the SOL amounts and "Sell" with the percentages, each a trade at once (components/useInstantTrade.ts runs
// it, lib/instant-trade.ts checks it before it signs). The widget below stays the custom path.
// There is no popover between the press and the trade here, since the buttons are on screen and deliberately pressed,
// so the row guards the press itself as the popover does (TradePresets.tsx): nothing counts for PRESET_GUARD_MS after
// the buttons appeared, came back on or changed their amounts, and a held key never presses one (lib/instant-outcome.ts
// pressCounts). A coin an instant trade found not tradable here shows the reason and pump.fun where the buttons were.
import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { pumpUrl } from "../../lib/api";
import type { InstantSpec } from "../../lib/instant-trade";
import { presetChoices, pressCounts } from "../../lib/instant-outcome";
import type { Side } from "../../lib/pump";
import { openTradeSettings } from "../../lib/trader";
import { Ext } from "../Bits";
import { PRESET_GUARD_MS } from "../TradePresets";
import "../trade-presets.css";

export type InstantRowProps = {
  /// "$SYM": the coin the presets trade, in their accessible names.
  label: string;
  presets: { buy: readonly number[]; sell: readonly number[] };
  /// A trade of the page is running (an instant one, or the widget's own): every preset is off.
  running: boolean;
  /// The side of the instant trade under way on this coin, for its spinner.
  busySide: Side | null;
  /// Why the last instant trade found the coin not tradable here.
  blocked: { short: string; body: string } | null;
  mint: string;
  onRun: (spec: InstantSpec) => void;
};

export default function InstantRow({ label, presets, running, busySide, blocked, mint, onRun }: InstantRowProps) {
  const live = !running && !blocked;
  // when the buttons last became pressable (or changed their amounts under the pointer); null while they are off
  const armedAt = useRef<number | null>(null);
  const amounts = `${presets.buy.join(",")}|${presets.sell.join(",")}`;
  useLayoutEffect(() => { armedAt.current = live ? performance.now() : null; }, [live, amounts]);
  // which preset was pressed, for its spinner while its trade runs
  const [pressed, setPressed] = useState<string | null>(null);
  // A press moves the focus off the preset onto the row before anything runs: a panel the press opens (the trading
  // wallet's unlock) gives the focus back to what had it when it opened, and a later Enter or Space there must never be
  // a one-press trade; nor may a preset that kept the focus through its disabled time take the next key once it is back.
  const rowRef = useRef<HTMLDivElement>(null);
  const press = (key: string, spec: InstantSpec) => () => {
    if (!pressCounts({ armedAt: armedAt.current, now: performance.now(), guardMs: PRESET_GUARD_MS })) return;
    setPressed(key);
    rowRef.current?.focus({ preventScroll: true });
    onRun(spec);
  };
  // a held Enter or Space repeats: the repeats never press a preset
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => { if ((e.key === "Enter" || e.key === " ") && e.repeat) e.preventDefault(); };
  const group = (side: Side) => presetChoices(side, side === "buy" ? presets.buy : presets.sell).map((c, i) => {
    const key = `${side}:${i}`;
    const spin = running && busySide === side && pressed === key;
    const name = side === "buy" ? `Buy ${label} with ${c.text}` : `Sell ${c.text} of your ${label}`;
    return (
      <button key={`${key}:${c.short}`} type="button" className={`btn sm ghost tp-preset${spin ? " is-busy" : ""}`} disabled={!live} aria-busy={spin || undefined}
        aria-label={name} title={`${name}, at once`} onClick={press(key, c.spec)}>{c.short}</button>
    );
  });
  return (
    <div ref={rowRef} tabIndex={-1} className="coin-instant" role="group" aria-label={`Instant trades of ${label}`} aria-busy={running || undefined} onKeyDown={onKeyDown}>
      <div className="coin-instant-head">
        <span className="card-label">Instant</span>
        <button type="button" className="linkish coin-instant-settings" onClick={() => openTradeSettings()}>Trade settings</button>
      </div>
      {blocked ? (
        <p className="coin-instant-why">
          <Ext href={pumpUrl(mint)} className="btn sm ghost" title={blocked.body}>Trade on pump.fun ↗</Ext>
          <span title={blocked.body}>not tradable here · {blocked.short}</span>
        </p>
      ) : (
        <div className="coin-instant-sides">
          <div className="coin-instant-side buy"><span className="coin-instant-k">Buy</span>{group("buy")}<span className="coin-instant-unit">SOL</span></div>
          <div className="coin-instant-side sell"><span className="coin-instant-k">Sell</span>{group("sell")}</div>
        </div>
      )}
    </div>
  );
}
