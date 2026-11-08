// <SlidingPill>: the background pill of a segmented control that slides to the selected item
// (DESIGN-ELEVATE §5, chips and filters). Drop it as the first child of any `.seg` (or any
// position: relative row of buttons/links). It finds the selected child by [aria-pressed="true"],
// [aria-selected="true"], [aria-current="page"], .on or .active, follows selection and size changes
// on its own (MutationObserver + ResizeObserver), and with `hover` it also follows the pointer and
// returns to the selection when the pointer leaves. Transform + width only; no transition under
// reduced motion. When nothing is selected it fades out.
import { useLayoutEffect, useRef } from "react";
import "./ui.css";

const SELECTED = '[aria-pressed="true"], [aria-selected="true"], [aria-current="page"], .on, .active';

type Props = {
  /** Which children can carry the pill (default: buttons and links). */
  items?: string;
  /** Follow the pointer over the items (nav-style). */
  hover?: boolean;
  className?: string;
};

export default function SlidingPill({ items = "button, a", hover = false, className = "" }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const pill = ref.current, host = pill?.parentElement;
    if (!pill || !host) return;
    let hovered: HTMLElement | null = null, raf = 0;
    const candidates = () => Array.from(host.querySelectorAll<HTMLElement>(items)).filter((n) => n.offsetParent !== null);
    const place = () => {
      raf = 0;
      const list = candidates();
      const sel = hovered ?? list.find((n) => n.matches(SELECTED)) ?? null;
      if (!sel) { pill.dataset.on = "0"; return; }
      const hr = host.getBoundingClientRect(), r = sel.getBoundingClientRect();
      const x = r.left - hr.left - host.clientLeft + host.scrollLeft, y = r.top - hr.top - host.clientTop + host.scrollTop;
      pill.style.width = `${r.width}px`; pill.style.height = `${r.height}px`;
      pill.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      pill.dataset.on = "1";
      pill.dataset.hover = hovered && !hovered.matches(SELECTED) ? "1" : "0";
      // The first placement jumps; later ones slide.
      if (!pill.dataset.ready) requestAnimationFrame(() => { pill.dataset.ready = "1"; });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };
    place();
    const mo = new MutationObserver(schedule);
    mo.observe(host, { subtree: true, attributes: true, attributeFilter: ["aria-pressed", "aria-selected", "aria-current", "class"], childList: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    ro?.observe(host);
    const onOver = (e: PointerEvent) => { if (e.pointerType !== "mouse") return; const t = (e.target as HTMLElement).closest<HTMLElement>(items); if (t && host.contains(t) && t !== hovered) { hovered = t; schedule(); } };
    const onLeave = () => { if (hovered) { hovered = null; schedule(); } };
    if (hover) { host.addEventListener("pointerover", onOver); host.addEventListener("pointerleave", onLeave); }
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => { cancelAnimationFrame(raf); mo.disconnect(); ro?.disconnect(); host.removeEventListener("pointerover", onOver); host.removeEventListener("pointerleave", onLeave); };
  }, [items, hover]);
  return <span ref={ref} className={`seg-pill ${className}`.trim()} aria-hidden="true" data-on="0" />;
}
