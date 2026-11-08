// <Reveal>: content that rises into place the first time it scrolls into view (DESIGN-ELEVATE §5).
// It only hides what starts below the fold, so nothing above it ever blinks; reduced or paused motion,
// automation (screenshots, crawlers) and printing show everything at once.
import { createElement, useLayoutEffect, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { motionPaused, useInView } from "../../lib/motion";
import "./ui.css";

type Props = {
  /** Element to render (default "div"). */
  as?: ElementType;
  /** Extra delay in ms before this element rises (added to the stagger). */
  delay?: number;
  /** Rise distance in px (default 18, the --reveal-y token). */
  y?: number;
  /** Stagger index: sets --i, so the element waits i × --reveal-stagger (60 ms). */
  i?: number;
  /** Latch once revealed (default true). */
  once?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
};

const instant = () => motionPaused() || (typeof navigator !== "undefined" && navigator.webdriver === true);

/**
 * Wraps content in an element carrying data-reveal ("" hidden, "in" shown); the rules live in
 * styles.css. Children may set style={{ "--i": n }} themselves to stagger inside one Reveal.
 */
export default function Reveal({ as = "div", delay = 0, y, i, once = true, className, style, children, ...rest }: Props) {
  const [ref, seen] = useInView<HTMLElement>({ once, rootMargin: "0px 0px -6% 0px", threshold: 0.08 });
  // "pending" until mounted: then hidden only if the element starts below the visible area.
  const [armed, setArmed] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || instant()) { setArmed(false); return; }
    const r = el.getBoundingClientRect();
    setArmed(r.top > window.innerHeight * 0.94);
    const show = () => setArmed(false);
    window.addEventListener("beforeprint", show);
    return () => window.removeEventListener("beforeprint", show);
  }, [ref]);
  const state = armed === false || seen ? "in" : armed ? "" : "in";
  const s: CSSProperties = { ...style };
  if (i !== undefined) (s as Record<string, unknown>)["--i"] = i;
  if (y !== undefined) (s as Record<string, unknown>)["--reveal-y"] = `${y}px`;
  if (delay) s.transitionDelay = `calc(${delay}ms + var(--i, 0) * var(--reveal-stagger))`;
  return createElement(as, { ref, className, style: s, "data-reveal": state, ...rest }, children);
}
