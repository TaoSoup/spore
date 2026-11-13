// The map's quick trade: the coin page's trade widget in a dialog over the map (a centred card on desktop, a bottom
// sheet on phones), opened from the side panel's Buy / Sell or the B key. The coin is fixed when it opens, so a
// selection change behind it never swaps the coin under an amount the user typed; every safeguard of the widget holds
// (a fresh simulated quote, the confirm sheet, the last simulation of the exact transaction, the wallet's own review).
// Its numbers (spot, impact, the dollar figures, the curve's state) come from a light /api/coin read again while the
// dialog is open, not from the record the side panel loaded when the coin was selected.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Coin } from "../lib/api";
import { useDialog } from "../lib/dialog";
import { useScrollLock } from "../lib/hooks";
import type { Side } from "../lib/pump";
import TradeWidget from "./TradeWidget";
import "./coin.css";
import "./coin/terminal.css";

/// How often the open dialog reads the coin's record again (the coin page follows the SSE stream instead).
const LIVE_MS = 10_000;

export type QuickTradeProps = { coin: Coin; side: Side; solUsd: number | null; onClose: () => void };

export default function QuickTrade({ coin, side, solUsd, onClose }: QuickTradeProps) {
  const amountRef = useRef<HTMLInputElement>(null);
  // A trade in flight keeps the dialog open: closing it would hide the progress and let another trade start beside it.
  const busy = useRef(false);
  const onBusy = useCallback((b: boolean) => { busy.current = b; }, []);
  const close = useCallback(() => { if (!busy.current) onClose(); }, [onClose]);
  const ref = useDialog<HTMLDivElement>(true, close, { initialFocus: amountRef });
  const titleId = useId();
  useScrollLock(true);
  const [live, setLive] = useState<Coin | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => api.coin(coin.mint, { children: false, trades: false }).then((r) => { if (alive && r.coin.mint === coin.mint) setLive(r.coin); }).catch(() => { /* keep the last record */ });
    read();
    const t = setInterval(read, LIVE_MS);
    return () => { alive = false; clearInterval(t); };
  }, [coin.mint]);
  const liveRef = useRef<Coin | null>(null);
  liveRef.current = live;
  const current = useCallback(() => liveRef.current ?? coin, [coin]);
  // Closes on a click that started on the backdrop itself, not on a drag (a text selection) that ends there.
  const downOnBackdrop = useRef(false);
  return createPortal(
    <div className="quick-trade-backdrop" onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }} onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) close(); }}>
      <div ref={ref} className="quick-trade" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <TradeWidget key={coin.mint} coin={coin} solUsd={solUsd} initialSide={side} sheet onClose={close} amountRef={amountRef} titleId={titleId} current={current} onBusy={onBusy} />
      </div>
    </div>,
    document.body,
  );
}
