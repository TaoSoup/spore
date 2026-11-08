// The map side panel's price line (sparkline v2): close prices of the candle window as a 1.25 px line over a
// gradient area, lime when the window ends higher than it opened, pink when lower, a dashed hairline at the
// opening price and a glowing dot on the latest close. Pointer (or finger) over it shows a crosshair with a
// mono readout pill (price and how long ago). No axes, no library: one path, sized by `w` × `h`.
import { useId, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Candle } from "../../../lib/api";
import { ago, amount, usd } from "../../../lib/format";

/// The window's change as last close over first open, and its real span in seconds (first candle to last).
export function candleChange(candles: Candle[] | null | undefined): { ratio: number; spanS: number } | null {
  if (!candles || candles.length < 2) return null;
  const first = candles[0], last = candles[candles.length - 1];
  if (!(first.o > 0) || !Number.isFinite(last.c)) return null;
  return { ratio: last.c / first.o - 1, spanS: Math.max(0, last.t - first.t) };
}

/// "8h", "45m", "3d": how much time the candles cover, for the change label.
export function spanLabel(s: number): string {
  if (s < 3_600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.round(s / 3_600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

const UP = "var(--accent)", DOWN = "var(--sell)";

/// `unit` is the candles' price key: "usd" reads out in dollars, "quote" as a plain amount of the quote token.
export default function Sparkline({ candles, w = 120, h = 32, title, unit = "usd" }: { candles: Candle[]; w?: number; h?: number; title?: string; unit?: "usd" | "quote" }) {
  const id = `spark${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const svg = useRef<SVGSVGElement>(null);
  const [hot, setHot] = useState<number | null>(null);
  const geo = useMemo(() => {
    if (candles.length < 2) return null;
    let lo = Infinity, hi = -Infinity;
    for (const c of candles) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; if (c.c < lo) lo = c.c; if (c.c > hi) hi = c.c; }
    const span = hi - lo || Math.abs(hi) || 1;
    const t0 = candles[0].t, dt = candles[candles.length - 1].t - t0 || 1;
    const padX = 4, padY = 5;
    const px = (t: number) => padX + ((t - t0) / dt) * (w - 2 * padX);
    const py = (v: number) => padY + (1 - (v - lo) / span) * (h - 2 * padY);
    let d = "";
    for (let i = 0; i < candles.length; i++) d += `${i ? "L" : "M"}${px(candles[i].t).toFixed(1)} ${py(candles[i].c).toFixed(1)}`;
    const last = candles[candles.length - 1];
    const area = `${d}L${px(last.t).toFixed(1)} ${h}L${px(t0).toFixed(1)} ${h}Z`;
    const up = last.c >= candles[0].o;
    return { d, area, up, px, py, open: py(Math.min(hi, Math.max(lo, candles[0].o))), lx: px(last.t), ly: py(last.c) };
  }, [candles, w, h]);
  if (!geo) return null;
  const tone = geo.up ? UP : DOWN;

  const track = (e: RPointerEvent<SVGSVGElement>) => {
    const el = svg.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * w;
    let best = 0, bd = Infinity;
    for (let i = 0; i < candles.length; i++) { const dd = Math.abs(geo.px(candles[i].t) - x); if (dd < bd) { bd = dd; best = i; } }
    setHot(best);
  };
  const hc = hot != null ? candles[hot] : null;
  const hx = hc ? geo.px(hc.t) : 0, hy = hc ? geo.py(hc.c) : 0;
  // the readout pill follows the crosshair along x (kept inside the line's box) and sits on the side of the line
  // away from the point: below it when the point is in the upper half, above it otherwise
  const pillLeft = hc ? Math.min(Math.max(0, hx / w), 1) : 0;

  return (
    <div className={`map-spark-wrap ${hc ? "is-reading" : ""}`} style={{ width: w, height: h }}>
      <svg ref={svg} className="map-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title ?? "price over the candle window"}
        onPointerMove={track} onPointerDown={track} onPointerLeave={() => setHot(null)} onPointerCancel={() => setHot(null)}>
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={tone} stopOpacity=".28" /><stop offset="1" stopColor={tone} stopOpacity="0" /></linearGradient>
          <filter id={`${id}-g`} x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.2" /></filter>
        </defs>
        <line className="map-spark-open" x1="0" x2={w} y1={geo.open} y2={geo.open} />
        <path d={geo.area} fill={`url(#${id})`} />
        <path className="map-spark-line" d={geo.d} fill="none" stroke={tone} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <circle cx={geo.lx} cy={geo.ly} r="4" fill={tone} opacity=".55" filter={`url(#${id}-g)`} />
        <circle className="map-spark-last" cx={geo.lx} cy={geo.ly} r="2" fill={tone} />
        {hc && (
          <g className="map-spark-cross" aria-hidden="true">
            <line x1={hx} x2={hx} y1="0" y2={h} />
            <circle cx={hx} cy={hy} r="2.6" fill="var(--bg-0)" stroke={tone} strokeWidth="1.25" />
          </g>
        )}
      </svg>
      {hc && (
        <span className="map-spark-read" aria-hidden="true" style={{ left: `${(pillLeft * 100).toFixed(1)}%`, top: hy < h / 2 ? `${h - 12}px` : "-8px", transform: `translateX(${(-pillLeft * 100).toFixed(1)}%)` }}>
          <b>{unit === "usd" ? usd(hc.c) : amount(hc.c)}</b> {ago(hc.t)}
        </span>
      )}
    </div>
  );
}
