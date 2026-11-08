// "Does it pay for itself?" as two gradient areas over the agent's ledger (DESIGN-ELEVATE §8):
// what it has earned (claims, green) against what it has spent (launches + model calls, violet),
// both cumulative, step by step as the ledger has them. Launches are marked as lime ticks on the
// spent line, claims as teal dots on the earned line. A crosshair follows the pointer (and the finger),
// arrow keys step through the ledger, and the latest values glow at the right edge. Every amount is
// the ledger line's own dollar value (at the time of the line); a line without one is read at
// today's SOL price, and one without any amount adds nothing. Plain SVG, measured in pixels.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import type { ActivityItem } from "../../lib/api";
import { usd } from "../../lib/format";
import { toneOf } from "./diary";
import { useEntrance } from "./entrance";

const H = 184, PT = 18, PB = 26, PL = 44, PR = 14;
type Pt = { at: number; earned: number; spent: number; kind: "claim" | "launch" | "ai" | "start"; title: string };

const usdAxis = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : n >= 10 ? `$${Math.round(n)}` : n > 0 ? `$${n.toFixed(n < 1 ? 2 : 1)}` : "$0");
const usd2 = (n: number) => (n >= 1 ? usd(n) : n > 0 ? `$${n.toFixed(2)}` : "$0");
const stamp = (t: number) => new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const span = (s: number) => (s >= 86_400 * 2 ? `${Math.round(s / 86_400)} days` : s >= 7200 ? `${Math.round(s / 3600)} hours` : s >= 120 ? `${Math.round(s / 60)} minutes` : "a moment");

/// The cumulative series, oldest first, one point per counted ledger line.
export function earnedSpentSeries(activity: ActivityItem[], solUsd: number | null | undefined): Pt[] {
  const asc = [...activity].filter((a) => toneOf(a.status) === "ok").sort((a, b) => a.at - b.at);
  const val = (a: ActivityItem) => a.usd ?? (a.amountSol != null && solUsd != null ? a.amountSol * solUsd : null);
  let earned = 0, spent = 0;
  const out: Pt[] = [];
  for (const a of asc) {
    const v = val(a);
    if (v == null || v <= 0) continue;
    if (a.kind === "claim") earned += v;
    else if (a.kind === "launch" || a.kind === "ai") spent += v;
    else continue;
    out.push({ at: a.at, earned, spent, kind: a.kind, title: a.title });
  }
  if (out.length) out.unshift({ at: out[0].at - Math.max(60, (out[out.length - 1].at - out[0].at) * 0.02), earned: 0, spent: 0, kind: "start", title: "" });
  return out;
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export default function EarnedSpent({ activity, solUsd }: { activity: ActivityItem[]; solUsd: number | null | undefined }) {
  const pts = useMemo(() => earnedSpentSeries(activity, solUsd), [activity, solUsd]);
  const [box, w] = useWidth<HTMLDivElement>();
  const [ent, on] = useEntrance<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  // Both branches (the empty line and the chart) carry the same two refs: the width box and the entrance.
  // Stable, so React does not detach and re-attach it on every render.
  const attach = useCallback((el: HTMLDivElement | null) => { box.current = el; ent.current = el; }, [box, ent]);
  const n = pts.length;
  const geo = useMemo(() => {
    if (n < 2 || w < 40) return null;
    const t0 = pts[0].at, t1 = pts[n - 1].at;
    const top = Math.max(...pts.map((p) => Math.max(p.earned, p.spent)), 0.01);
    // A round ceiling: 1, 2 or 5 times a power of ten, with three gridlines.
    const mag = 10 ** Math.floor(Math.log10(top));
    const ceil = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= top) ?? top;
    const x = (t: number) => PL + ((t - t0) / Math.max(1, t1 - t0)) * (w - PL - PR);
    const y = (v: number) => PT + (1 - v / ceil) * (H - PT - PB);
    const step = (key: "earned" | "spent") => pts.map((p, i) => (i === 0 ? `M${x(p.at).toFixed(1)} ${y(p[key]).toFixed(1)}` : `H${x(p.at).toFixed(1)}V${y(p[key]).toFixed(1)}`)).join("");
    const area = (key: "earned" | "spent") => `${step(key)}V${y(0).toFixed(1)}H${x(pts[0].at).toFixed(1)}Z`;
    return { x, y, ceil, t0, t1, earned: step("earned"), spent: step("spent"), earnedA: area("earned"), spentA: area("spent"), grid: [0, ceil / 2, ceil] };
  }, [pts, n, w]);

  if (n < 2) return <div className="agent-es empty-line" ref={attach}><p className="muted">Nothing earned or spent in its ledger yet: the chart draws itself from its first claim or launch.</p></div>;
  const last = pts[n - 1];
  const h = hover != null ? pts[hover] : null;
  const summary = `Earned ${usd2(last.earned)} against ${usd2(last.spent)} spent over ${span(last.at - pts[1].at)} of its ledger: ${pts.filter((p) => p.kind === "launch").length} launches, ${pts.filter((p) => p.kind === "claim").length} claims.`;
  const nearest = (px: number) => {
    if (!geo) return null;
    let best = 0, d = Infinity;
    for (let i = 1; i < n; i++) { const dd = Math.abs(geo.x(pts[i].at) - px); if (dd < d) { d = dd; best = i; } }
    return best;
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); setHover(nearest(e.clientX - r.left)); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); setHover((i) => { const c = i ?? (e.key === "ArrowRight" ? 0 : n); return Math.max(1, Math.min(n - 1, c + (e.key === "ArrowRight" ? 1 : -1))); }); }
    else if (e.key === "Escape" || e.key === "Home") setHover(null);
  };
  const tipX = h && geo ? geo.x(h.at) : 0;
  return (
    <div className={`agent-es ${on ? "in" : ""}`} ref={attach}>
      <div className="agent-es-legend mono" aria-hidden="true">
        <span><i className="k-earned" />earned</span>
        <span><i className="k-spent" />spent</span>
        <span className="agent-es-keys"><i className="k-launch" />launch<i className="k-claim" />claim</span>
      </div>
      <div className="agent-es-plot" tabIndex={0} role="group" aria-label={`${summary} Arrow keys step through the ledger.`} onKeyDown={onKey} onBlur={() => setHover(null)}>
        {geo && (
          <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={summary} onPointerMove={onMove} onPointerLeave={() => setHover(null)} onPointerDown={onMove}>
            <defs>
              <linearGradient id="agent-es-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--good)" stopOpacity=".28" /><stop offset="1" stopColor="var(--good)" stopOpacity="0" /></linearGradient>
              <linearGradient id="agent-es-v" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--violet)" stopOpacity=".28" /><stop offset="1" stopColor="var(--violet)" stopOpacity="0" /></linearGradient>
            </defs>
            {geo.grid.map((v, i) => <g key={i} className="agent-es-grid"><line x1={PL} x2={w - PR} y1={geo.y(v)} y2={geo.y(v)} /><text x={PL - 8} y={geo.y(v) + 3.5} textAnchor="end">{usdAxis(v)}</text></g>)}
            <g className="agent-es-draw">
              <path className="agent-es-area spent" d={geo.spentA} fill="url(#agent-es-v)" />
              <path className="agent-es-area earned" d={geo.earnedA} fill="url(#agent-es-g)" />
              <path className="agent-es-line spent" d={geo.spent} />
              <path className="agent-es-line earned" d={geo.earned} />
              {pts.map((p, i) => p.kind === "launch" ? <path key={i} className="agent-es-mark launch" d={`M${geo.x(p.at).toFixed(1)} ${(geo.y(p.spent) - 5).toFixed(1)}l3.5 5-3.5 5-3.5-5z`} /> : p.kind === "claim" ? <circle key={i} className="agent-es-mark claim" cx={geo.x(p.at)} cy={geo.y(p.earned)} r={2.4} /> : null)}
              <circle className="agent-es-last earned" cx={geo.x(last.at)} cy={geo.y(last.earned)} r={3.5} />
              <circle className="agent-es-last spent" cx={geo.x(last.at)} cy={geo.y(last.spent)} r={3.5} />
              {(() => {
                // The latest values float at the right edge: the higher line's label above it, the other's below.
                const up = last.earned >= last.spent, ey = geo.y(last.earned), sy = geo.y(last.spent);
                const top = Math.min(ey, sy) - 9, bottom = Math.min(H - PB - 4, Math.max(ey, sy) + 17);
                return (
                  <g className="agent-es-now" textAnchor="end">
                    <text className="earned" x={geo.x(last.at) - 8} y={up ? top : bottom}>{usd2(last.earned)}</text>
                    <text className="spent" x={geo.x(last.at) - 8} y={up ? bottom : top}>{usd2(last.spent)}</text>
                  </g>
                );
              })()}
            </g>
            <text className="agent-es-axis" x={PL} y={H - 8}>{stamp(geo.t0 + (pts[1].at - pts[0].at))}</text>
            <text className="agent-es-axis" x={w - PR} y={H - 8} textAnchor="end">{stamp(geo.t1)}</text>
            {h && (
              <g className="agent-es-cross">
                <line x1={tipX} x2={tipX} y1={PT - 6} y2={H - PB} />
                <circle className="earned" cx={tipX} cy={geo.y(h.earned)} r={4} />
                <circle className="spent" cx={tipX} cy={geo.y(h.spent)} r={4} />
              </g>
            )}
          </svg>
        )}
        {h && geo && (
          <div className={`agent-es-tip mono ${tipX > w * 0.6 ? "left" : ""}`} style={{ transform: `translateX(${Math.round(tipX)}px)` }} aria-live="polite">
            <span className="t">{stamp(h.at)}</span>
            <span className="v"><i className="k-earned" />{usd2(h.earned)}</span>
            <span className="v"><i className="k-spent" />{usd2(h.spent)}</span>
            <span className={`w k-${h.kind}`}>{h.title}</span>
          </div>
        )}
      </div>
      <p className="agent-es-foot mono">from its ledger · each line in dollars at the time it happened · the totals above read today's SOL price</p>
    </div>
  );
}
