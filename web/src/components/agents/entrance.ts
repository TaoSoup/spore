// When an agent instrument plays its entrance (arcs sweeping in, numbers counting up, chart areas
// drawing): right after mount when it starts on screen, when it scrolls into view otherwise, and at
// once under reduced or paused motion and in automation (screenshots), so nothing waits on a scroll.
//
// The hook follows its element, not only the one present at first mount: an instrument that renders a
// skeleton or a hint first and its real markup later (the fee rule waits on the chain, the earned-vs-
// spent chart on its ledger) still plays, or still shows at once when motion is off. The returned ref
// is a plain ref object whose `current` setter records the element, so `ref={ref}`, `ref.current` and
// `ref.current = el` from a callback ref all keep working.
import { useLayoutEffect, useState, type RefObject } from "react";
import { motionPaused, useMotionPref } from "../../lib/motion";

export const instant = () => motionPaused() || (typeof navigator !== "undefined" && navigator.webdriver === true);

export function useEntrance<T extends Element>(): [RefObject<T | null>, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [ref] = useState<RefObject<T | null>>(() => {
    let cur: T | null = null;
    return {
      get current() { return cur; },
      set current(v: T | null) { if (v !== cur) { cur = v; setEl(v); } },
    };
  });
  const [on, setOn] = useState(false);
  const [paused] = useMotionPref();
  useLayoutEffect(() => {
    if (on || !el) return;
    if (paused || instant()) { setOn(true); return; }
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) {
      // On screen already: two frames so the "from" state paints before the transition starts.
      let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => setOn(true)); });
      return () => cancelAnimationFrame(id);
    }
    if (typeof IntersectionObserver === "undefined") { setOn(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); setOn(true); } }, { rootMargin: "0px 0px -8% 0px", threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [el, on, paused]);
  return [ref, on];
}
