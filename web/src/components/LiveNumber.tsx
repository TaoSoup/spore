// A live number that never re-renders React to animate: the text is written through a ref inside
// requestAnimationFrame. kind="count" (launches, trees, agents): an increase gets a 1.2 s lime
// underline, at most once per 10 s. kind="continuous" (volume, locked, prices): a silent tween.
// With the OS reduced-motion setting or the footer's pause toggle, values swap instantly and a
// count increase shows a static "+n" chip for 4 s instead.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motionPaused } from "../lib/motion";
import "./primitives.css";

type Props = { value: number | null | undefined; format: (n: number | null | undefined) => string; kind?: "count" | "continuous"; className?: string };

const TWEEN_MS = 600, FLASH_MS = 1200, FLASH_EVERY_MS = 10_000, PLUS_MS = 4_000;

export default function LiveNumber({ value, format, kind = "continuous", className = "" }: Props) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null | undefined>(value);
  const raf = useRef(0);
  const lastFlash = useRef(0);
  const [plus, setPlus] = useState<number | null>(null);
  const fmt = useRef(format);
  fmt.current = format;

  const initial = useRef(value);
  useLayoutEffect(() => { if (el.current) el.current.textContent = fmt.current(initial.current); }, []);

  useEffect(() => {
    const node = el.current;
    const from = shown.current, to = value;
    shown.current = to;
    if (!node) return;
    cancelAnimationFrame(raf.current);
    if (to == null || from == null || from === to || !Number.isFinite(from) || !Number.isFinite(to)) { node.textContent = fmt.current(to); return; }
    const up = to > from;
    if (motionPaused()) {
      node.textContent = fmt.current(to);
      if (kind === "count" && up) { setPlus(Math.round(to - from)); const t = setTimeout(() => setPlus(null), PLUS_MS); return () => clearTimeout(t); }
      return;
    }
    if (kind === "count" && up && Date.now() - lastFlash.current > FLASH_EVERY_MS) {
      lastFlash.current = Date.now();
      node.classList.remove("ln-up"); void node.offsetWidth; node.classList.add("ln-up");
      setTimeout(() => node.classList.remove("ln-up"), FLASH_MS);
    }
    const t0 = performance.now();
    const step = (t: number) => {
      const u = Math.min(1, (t - t0) / TWEEN_MS), e = 1 - (1 - u) ** 3;
      node.textContent = fmt.current(from + (to - from) * e);
      if (u < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value, kind]);

  return (
    <>
      <span ref={el} className={`ln ${className}`} />
      {plus != null && plus > 0 && <span className="ln-plus" aria-hidden="true">+{plus}</span>}
    </>
  );
}
