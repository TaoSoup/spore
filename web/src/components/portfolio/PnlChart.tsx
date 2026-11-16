// The Portfolio page's realized P&L card: the wallet's cumulative realized profit over the period chosen, as one
// step line (lib/pnl-chart.ts) over a soft fill, lime when the period ends above zero and red when below, with a
// faint zero line and a dot on the last point. Pointer or finger over it shows a crosshair; the figure in the head
// then reads the point under it (date and value) instead of the period's end. No axes: the low and the high, and the
// first and last date, sit under the line. Plain SVG, no chart library; the width follows the card (ResizeObserver).
// Values arrive in USD and are written through the page's `money` formatter, so the card follows the USD / SOL switch.
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Money } from "../../lib/money";
import { chartGeo, hasSeries, pointAt, type SeriesPoint } from "../../lib/pnl-chart";
import { when } from "../../lib/format";

const H_WIDE = 140, H_PHONE = 110, PHONE_W = 520;
const TONE = { up: "var(--accent)", down: "var(--sell)", none: "var(--muted)" } as const;
const day = (t: number, withTime: boolean) => new Date(t * 1000).toLocaleString("en-US", withTime ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { year: "numeric", month: "short", day: "numeric" });

/// `points`: the series, time ascending, in USD. `state`: "loading" before the first answer, "failed" when it could
/// not be read, "ok" otherwise. `unpriced`: coins left out for want of a price.
export default function PnlChart({ points, periodName, money, state, unpriced = 0, note }: { points: readonly SeriesPoint[]; periodName: string; money: Money; state: "loading" | "failed" | "ok"; unpriced?: number; note?: string }) {
  const id = `pfc${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => { const n = Math.round(el.clientWidth); if (n > 0) setW(n); };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const h = w < PHONE_W ? H_PHONE : H_WIDE;
  const draw = hasSeries(points);
  const geo = useMemo(() => (draw ? chartGeo(points, w, h) : null), [draw, points, w, h]);
  const [hot, setHot] = useState<number | null>(null);
  // A background refresh hands over a new array of the same series: the crosshair stays where it is. It is dropped
  // only when the series changes shape (another period, a new sell), since the index would then point elsewhere.
  const count = points.length;
  useEffect(() => { setHot(null); }, [count]);
  const signed = (v: number) => money.money(v, { signed: true });

  const tone = TONE[geo?.tone ?? "none"];
  const withTime = !!geo && geo.last.t - geo.first.t < 2 * 86_400;
  const i = geo && hot !== null && hot >= 0 && hot < points.length ? hot : null;
  const track = (e: RPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (geo && r.width > 0) setHot(pointAt(geo.xs, ((e.clientX - r.left) / r.width) * geo.w));
  };
  const p = geo ? (i !== null ? points[i] : geo.last) : null;

  return (
    <section className="card pf-chart" aria-labelledby={`${id}-h`}>
      <header className="pf-chart-head">
        <h2 id={`${id}-h`} title={note}>Realized P&amp;L <span className="pf-chart-period">{periodName}</span></h2>
        {p && (
          <p className="pf-chart-read" aria-hidden="true">
            <span className="pf-chart-when">{i !== null ? when(p.t) : "now"}</span>{" "}
            <b className="pf-num" style={{ color: i === null ? tone : undefined }}>{signed(p.usd)}</b>
          </p>
        )}
      </header>
      {/* one box in every state, so the width observer keeps its element */}
      <div ref={box} className={geo ? "pf-chart-box" : state === "loading" ? "pf-chart-box pf-chart-none pf-chart-wait" : "pf-chart-box pf-chart-none"} style={geo ? { height: h } : undefined} aria-busy={!geo && state === "loading"}>
        {!geo ? (
          <p>{state === "loading" ? "Reading…" : state === "failed" ? "The chart could not be read just now." : "No realized profit or loss in this period yet"}</p>
        ) : (
          <svg className="pf-chart-svg" width="100%" height={h} viewBox={`0 0 ${geo.w} ${geo.h}`} preserveAspectRatio="none" role="img"
            aria-label={`Realized profit and loss, ${periodName}: ${signed(geo.last.usd)} from ${day(geo.first.t, withTime)} to ${day(geo.last.t, withTime)}. Lowest ${signed(geo.lo)}, highest ${signed(geo.hi)}.`}
            onPointerMove={track} onPointerDown={track} onPointerLeave={() => setHot(null)} onPointerCancel={() => setHot(null)}>
            <defs>
              <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="0" y2={geo.h}>
                <stop offset="0" stopColor={tone} stopOpacity=".2" />
                <stop offset={(geo.zeroY / geo.h).toFixed(3)} stopColor={tone} stopOpacity=".02" />
                <stop offset="1" stopColor={tone} stopOpacity=".2" />
              </linearGradient>
            </defs>
            <line className="pf-chart-zero" x1="0" x2={geo.w} y1={geo.zeroY} y2={geo.zeroY} vectorEffect="non-scaling-stroke" />
            <path d={geo.area} fill={`url(#${id})`} />
            <path d={geo.line} fill="none" stroke={tone} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <circle cx={geo.xs[geo.xs.length - 1]} cy={geo.ys[geo.ys.length - 1]} r="3" fill={tone} />
            {i !== null && (
              <g className="pf-chart-cross" aria-hidden="true">
                <line x1={geo.xs[i]} x2={geo.xs[i]} y1="0" y2={geo.h} vectorEffect="non-scaling-stroke" />
                <circle cx={geo.xs[i]} cy={geo.ys[i]} r="3.5" fill="var(--bg-0)" stroke={tone} strokeWidth="1.5" />
              </g>
            )}
          </svg>
        )}
      </div>
      {geo && (
        <footer className="pf-chart-foot">
          <span>{day(geo.first.t, withTime)}</span>
          <span className="pf-chart-range">Low <span className="pf-num">{signed(geo.lo)}</span> · High <span className="pf-num">{signed(geo.hi)}</span></span>
          <span>{day(geo.last.t, withTime)}</span>
        </footer>
      )}
      {geo && unpriced > 0 && <p className="pf-chart-note">{unpriced === 1 ? "1 coin" : `${unpriced} coins`} without a price left out.</p>}
    </section>
  );
}
