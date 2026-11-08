import { useEffect, useState, type RefObject } from "react";

/// Highlights the section being read. The line sits a third of the way down the viewport, so a
/// short section still lights up before the next one takes over.
export function useActiveSection(ids: readonly string[]) {
  const [active, setActive] = useState(ids[0]);
  const key = ids.join("|");
  useEffect(() => {
    const els = key.split("|").map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: "-30% 0px -65% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [key]);
  return active;
}

/// Reading progress through `target` (the article column), written straight onto `bar` as a
/// scaleY transform: 0 before the article reaches the reading line, 1 once its end has passed it.
/// One passive scroll listener, at most one write per frame; no React state, no re-render.
export function useReadProgress(bar: RefObject<HTMLElement | null>, target: string) {
  useEffect(() => {
    const el = bar.current;
    const main = el ? document.querySelector<HTMLElement>(target) : null;
    if (!el || !main) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = main.getBoundingClientRect(), line = window.innerHeight * 0.35;
      const p = Math.min(1, Math.max(0, (line - r.top) / Math.max(1, r.height - line * 0.5)));
      el.style.transform = `scaleY(${p.toFixed(4)})`;
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [bar, target]);
}
