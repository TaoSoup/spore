// The phone launch bar (≤ 980 px): while the Launch card is off screen, a 64 px glass bar keeps
// the coin, the total and the launch button in reach. The button is a mirror (class
// `launch-bar-btn`, never `launch-btn`, which stays the one real submit): same label, same
// disabled state, same handler. Hidden while a launch runs, after it, and when the on-screen
// keyboard leaves less than 500 px of viewport.
import { useEffect, useState, type RefObject } from "react";
import { lamportsToSol, sol } from "../../lib/format";

type Props = { target: RefObject<HTMLElement | null>; image: string | null; symbol: string; total: bigint; label: string; disabled: boolean; hidden: boolean; onPress: () => void };

export default function LaunchBar({ target, image, symbol, total, label, disabled, hidden, onPress }: Props) {
  const [offscreen, setOffscreen] = useState(false);
  const [roomy, setRoomy] = useState(true);
  useEffect(() => {
    const el = target.current;
    if (hidden || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setOffscreen(!entry.isIntersecting), { threshold: 0, rootMargin: "0px 0px -40px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [target, hidden]);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const on = () => setRoomy(vv.height >= 500);
    on();
    vv.addEventListener("resize", on);
    return () => vv.removeEventListener("resize", on);
  }, []);
  if (hidden || !offscreen || !roomy) return null;
  const tag = symbol ? `$${symbol}` : "$TICKER";
  return (
    <div className="launch-bar" role="region" aria-label="Launch summary">
      <span className="launch-bar-coin">
        {image ? <img src={image} alt="" width={32} height={32} /> : <span className="launch-bar-letter" aria-hidden="true">{(symbol || "?").slice(0, 1)}</span>}
        <span className="launch-bar-text"><b className="mono">{tag}</b><span className="mono">≈ {sol(lamportsToSol(total))}</span></span>
      </span>
      <button type="button" className="btn accent launch-bar-btn" disabled={disabled} onClick={onPress}>{label}</button>
    </div>
  );
}
