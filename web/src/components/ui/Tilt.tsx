// <Tilt>: a card that leans toward the pointer (at most `max` degrees) and moves its light with it.
// It writes transform and the --mx/--my custom properties (percent, for a light sweep or a radial
// highlight in your CSS: background: radial-gradient(… at var(--mx) var(--my), …)). One rAF per element,
// only while hovered or settling. Off on touch screens and under reduced or paused motion.
import { createElement, useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from "react";
import { coarsePointer, motionPaused, spring } from "../../lib/motion";
import "./ui.css";

type Props = {
  as?: ElementType;
  /** Maximum lean in degrees (default 4). */
  max?: number;
  /** Lift in px while hovered (default 0: leave lifting to the card's own :hover). */
  lift?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  [k: string]: unknown;
};

export default function Tilt({ as = "div", max = 4, lift = 0, className = "", style, children, ...rest }: Props) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || coarsePointer()) return;
    let raf = 0, last = 0, hovering = false;
    const s = { rx: 0, ry: 0, vrx: 0, vry: 0, mx: 50, my: 50, l: 0, vl: 0 };
    const t = { rx: 0, ry: 0, mx: 50, my: 50, l: 0 };
    const write = () => {
      el.style.transform = s.rx || s.ry || s.l ? `perspective(900px) rotateX(${s.rx.toFixed(2)}deg) rotateY(${s.ry.toFixed(2)}deg) translateY(${(-s.l).toFixed(2)}px)` : "";
      el.style.setProperty("--mx", `${s.mx.toFixed(1)}%`);
      el.style.setProperty("--my", `${s.my.toFixed(1)}%`);
    };
    const tick = (now: number) => {
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      [s.rx, s.vrx] = spring(s.rx, s.vrx, t.rx, dt, 220, 24);
      [s.ry, s.vry] = spring(s.ry, s.vry, t.ry, dt, 220, 24);
      [s.l, s.vl] = spring(s.l, s.vl, t.l, dt, 260, 28);
      s.mx += (t.mx - s.mx) * Math.min(1, dt * 14); s.my += (t.my - s.my) * Math.min(1, dt * 14);
      write();
      const settled = !hovering && Math.abs(s.rx) + Math.abs(s.ry) + Math.abs(s.l) < 0.01 && Math.abs(s.vrx) + Math.abs(s.vry) < 0.01;
      if (settled) { s.rx = s.ry = s.l = 0; write(); el.classList.remove("is-tilting"); raf = 0; last = 0; return; }
      raf = requestAnimationFrame(tick);
    };
    const kick = () => { if (!raf) { el.classList.add("is-tilting"); raf = requestAnimationFrame(tick); } };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || motionPaused()) return;
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / Math.max(1, r.width), py = (e.clientY - r.top) / Math.max(1, r.height);
      hovering = true;
      t.ry = (px - 0.5) * 2 * max; t.rx = -(py - 0.5) * 2 * max; t.mx = px * 100; t.my = py * 100; t.l = lift;
      kick();
    };
    const onLeave = () => { hovering = false; t.rx = t.ry = t.l = 0; t.mx = t.my = 50; if (!motionPaused()) kick(); };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => { cancelAnimationFrame(raf); el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerleave", onLeave); el.style.transform = ""; };
  }, [max, lift]);
  return createElement(as, { ref, className: `tilt ${className}`.trim(), style, ...rest }, children);
}
