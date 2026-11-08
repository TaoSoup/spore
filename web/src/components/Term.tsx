// <Term k="locked">locked</Term>: a word with a dashed underline that explains itself in plain
// language on hover (desktop), focus (keyboard) and tap (touch, where native titles never show).
// The explanation is always in the accessibility tree through an sr-only description; the visual
// popover is portalled to <body> with fixed positioning so a card's overflow or stacking context
// can never clip it, and it is clamped inside the 16 px gutters so a phone never scrolls sideways.
// Never put a Term inside an <a> or another <button> (nested interactive content).
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { termLabel, termText, type TermKey, type TermVars } from "../lib/glossary";
import "./primitives.css";

type Props = { k: TermKey; children?: ReactNode; vars?: TermVars; text?: string; className?: string; icon?: boolean };

const GUTTER = 16, GAP = 8, HOVER_OPEN_MS = 250, HOVER_CLOSE_MS = 120;

export default function Term({ k, children, vars, text, className = "", icon = false }: Props) {
  const id = useId();
  const body = text ?? termText(k, vars);
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // How the last press started: a mouse click keeps the tip open, a tap toggles it, and focus that
  // did not come from a pointer (keyboard) opens it.
  const lastPtr = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const later = (fn: () => void, ms: number) => { clear(); timer.current = setTimeout(fn, ms); };
  const close = useCallback(() => { clear(); setOpen(false); setPos(null); }, []);

  // Place above the word, flip below near the top edge, clamp horizontally inside the gutters.
  useLayoutEffect(() => {
    if (!open || !btn.current || !tip.current) return;
    const b = btn.current.getBoundingClientRect(), t = tip.current.getBoundingClientRect();
    // On touch the icon is a 44 px target drawn as a 24 px ring (a negative margin hides the slack): anchor to the ring.
    const inset = Math.max(0, -(parseFloat(getComputedStyle(btn.current).marginTop) || 0));
    const r = { top: b.top + inset, bottom: b.bottom - inset, left: b.left, width: b.width };
    const vw = document.documentElement.clientWidth;
    const below = r.top - t.height - GAP < GUTTER;
    const left = Math.max(GUTTER, Math.min(vw - GUTTER - t.width, r.left + r.width / 2 - t.width / 2));
    setPos({ left, top: below ? r.bottom + GAP : r.top - t.height - GAP, below });
  }, [open, body]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); btn.current?.focus(); } };
    const onDown = (e: PointerEvent) => { const n = e.target as Node; if (!btn.current?.contains(n) && !tip.current?.contains(n)) close(); };
    const onMove = () => close();
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onMove, { passive: true, capture: true });
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onMove, { capture: true });
      window.removeEventListener("resize", onMove);
    };
  }, [open, close]);
  useEffect(() => clear, []);

  return (
    <>
      <button ref={btn} type="button" className={`term ${icon ? "icon" : ""} ${className}`} aria-describedby={id} aria-expanded={open}
        onPointerEnter={(e) => { if (e.pointerType === "mouse") later(() => setOpen(true), HOVER_OPEN_MS); }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") later(close, HOVER_CLOSE_MS); }}
        onPointerDown={(e) => { lastPtr.current = e.pointerType; }}
        onFocus={() => { if (lastPtr.current === null) setOpen(true); }} onBlur={() => later(close, HOVER_CLOSE_MS)}
        // A term inside a clickable card must not also open the card.
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); clear(); const ptr = lastPtr.current; lastPtr.current = null; if (ptr === "mouse") setOpen(true); else setOpen((o) => !o); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}>
        {icon ? <span aria-hidden="true">i</span> : (children ?? termLabel(k))}
        {icon && <span className="sr-only">{children ?? `What is ${termLabel(k)}?`}</span>}
      </button>
      <span id={id} className="sr-only">{body}</span>
      {open && typeof document !== "undefined" && createPortal(
        <span ref={tip} className={`term-tip ${pos?.below ? "below" : ""}`} aria-hidden="true"
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: "hidden" }}
          onPointerEnter={clear} onPointerLeave={(e) => { if (e.pointerType === "mouse") later(close, HOVER_CLOSE_MS); }}>
          {body}
        </span>,
        document.body,
      )}
    </>
  );
}
