// The preset popover of an instant trade: a small card anchored to a Buy or Sell button with one button per preset
// ("0.1 SOL", "50%") and a quiet "Custom…" that opens the ticket. Pressing a preset is the trade (lib/instant-trade.ts
// runs it), so the popover guards against a press the user did not mean:
// - the focus goes to the card itself, not to a preset, so a key still held from the Buy / Sell button reaches nothing;
// - nothing in it activates for PRESET_GUARD_MS after it opens, and a repeating (held) key never activates a preset;
// - it names the coin it trades, and it stays hung from its own button: the page under it may move without a scroll
//   (a refresh re-sorts the rows, a card above finishes loading), so it is placed again on every frame, closes when its
//   button leaves the page or scrolls out of the panel that holds it (the map's side panel, the phone's bottom sheet:
//   lib/clip.ts), and ignores a press for PRESET_GUARD_MS after it moved (the user aimed at what was there).
// It is portalled to the body and fixed to the viewport, so a panel's own scrolling, transform or backdrop filter (each
// would make a fixed box inside it relative to the panel) never misplaces it.
// Escape and a press outside close it and the focus goes back to the button; Tab stays inside while it is open. While
// it is open the page's own keyboard shortcuts stand down (lib/dialog.ts holdPageKeys: the map's arrows, B, Escape),
// and its Escape is taken before the page sees it, so one press closes the popover and nothing else.
// It knows nothing of the page it sits on: the page gives it the labels and takes the index that was picked.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { clipAncestorsOf, clippedOut } from "../lib/clip";
import { holdPageKeys } from "../lib/dialog";
import "./trade-presets.css";

/// A press within this long of the popover opening is ignored: the click or key that opened it is still under way.
export const PRESET_GUARD_MS = 300;
const GAP = 6, EDGE = 8;

export type TradePresetsProps = {
  side: "buy" | "sell";
  /// What the popover does, shown as its title and its accessible name: "Sell $SYM".
  label: string;
  /// The button it hangs from (and gives the focus back to).
  anchor: HTMLElement | null;
  /// The presets' texts, in order: "0.1 SOL" or "25%".
  presets: readonly string[];
  onPick: (index: number) => void;
  onCustom: () => void;
  onClose: () => void;
};

export default function TradePresets({ side, label, anchor, presets, onPick, onCustom, onClose }: TradePresetsProps) {
  const ref = useRef<HTMLDivElement>(null);
  // the last time it opened or moved: a press within PRESET_GUARD_MS of either is ignored
  const openedAt = useRef(0);
  const titleId = useId();
  const [pos, setPos] = useState<CSSProperties>({ left: 0, top: 0, opacity: 0 });
  const close = useRef(onClose);
  close.current = onClose;

  // Under the button, right edges aligned; above it when there is no room below; always inside the viewport. Placed on
  // every frame while open (the button's rect and those of the few boxes that clip it, a state change only when it
  // moved), so it follows its button wherever the page puts it; a button that left the page (its row is gone) or that
  // scrolled out of the box that clips it closes it.
  useLayoutEffect(() => {
    let last = "", frame = 0;
    const clips = anchor ? clipAncestorsOf(anchor) : [];
    const place = (first: boolean) => {
      const el = ref.current;
      if (!el || !anchor) return;
      if (!anchor.isConnected) { close.current(); return; }
      const a = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
      if (clips.length && clippedOut(a, clips.map((c) => ({ box: c.el.getBoundingClientRect(), x: c.x, y: c.y })))) { close.current(); return; }
      const vw = document.documentElement.clientWidth, vh = window.innerHeight;
      const left = Math.round(Math.max(EDGE, Math.min(a.right - w, vw - w - EDGE)));
      const below = a.bottom + GAP, above = a.top - GAP - h;
      const top = Math.round(below + h <= vh - EDGE || above < EDGE ? below : above);
      const at = `${left},${top}`;
      if (at === last) return;
      if (!first) openedAt.current = performance.now();
      last = at;
      setPos({ left, top });
    };
    place(true);
    const loop = () => { place(false); frame = requestAnimationFrame(loop); };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [anchor, presets.length]);

  // the page's keyboard shortcuts stand down while it is open
  useEffect(() => holdPageKeys(), []);
  useEffect(() => {
    openedAt.current = performance.now();
    ref.current?.focus({ preventScroll: true });
    const back = () => { if (anchor?.isConnected) anchor.focus({ preventScroll: true }); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); back(); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      // a press on the button that opened it is the button's own (it closes the popover itself)
      if (t && (ref.current?.contains(t) || anchor?.contains(t))) return;
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown, true); };
  }, [anchor]);

  const armed = () => performance.now() - openedAt.current >= PRESET_GUARD_MS;
  const act = (fn: () => void) => () => { if (!armed()) return; close.current(); if (anchor?.isConnected) anchor.focus({ preventScroll: true }); fn(); };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // a held key (Enter or Space repeating) never presses a preset; neither does any key inside the guard
    if ((e.key === "Enter" || e.key === " ") && (e.repeat || !armed())) { e.preventDefault(); return; }
    if (e.key !== "Tab" && e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey);
    items[i < 0 ? (back ? items.length - 1 : 0) : (i + (back ? -1 : 1) + items.length) % items.length].focus();
  };

  return createPortal(
    <div ref={ref} className={`tp-pop ${side}`} role="dialog" aria-labelledby={titleId} tabIndex={-1} style={pos} onKeyDown={onKeyDown}>
      <b id={titleId} className="tp-title">{label}</b>
      <div className="tp-presets" role="group" aria-label={side === "buy" ? "Buy with" : "Sell"}>
        {presets.map((p, i) => <button key={`${i}:${p}`} type="button" className="btn sm ghost tp-preset" onClick={act(() => onPick(i))}>{p}</button>)}
      </div>
      <button type="button" className="linkish tp-custom" onClick={act(onCustom)}>Custom…</button>
    </div>,
    document.body,
  );
}
