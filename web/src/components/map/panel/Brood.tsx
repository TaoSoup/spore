// The brood: a coin's direct children as an instrument in the side panel, drawn in the site's illustration
// language. The coin is the node at the left; every child is a node placed on a time axis by when its pair
// was opened (the coin's launch at the left edge, now at the right; a log time axis with +1h / +1d / +7d
// ticks, since most children arrive in the first hours), joined to the coin by a hairline
// filament. A child's size is its market cap (log scale); a child that locks value of its own (it has
// children too) carries the "lock" inner ring. Pointer over a node lights its bubble on the map and reads
// out its ticker, market cap and age; a click selects it. The list under it stays the keyboard path.
import { useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import type { BubbleNode } from "../../../lib/map/types";
import { age, count, usd } from "../../../lib/format";
import { sym } from "../../Bits";

const TONES = ["var(--accent)", "var(--teal)", "var(--violet)", "var(--warn)"];
const tone = (d: number) => TONES[Math.min(Math.max(0, d), TONES.length - 1)];
const MAX = 160, H = 62, PAD_L = 18, PAD_R = 10, AXIS_Y = 24, SPREAD = 13, UNIT_S = 600;
const TICKS: [number, string][] = [[3_600, "+1h"], [86_400, "+1d"], [604_800, "+7d"], [2_592_000, "+30d"]];
/// A stable jitter in [-1, 1] from a mint, so a child keeps its row between renders.
const jitter = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 2001) / 1000 - 1; };
const rOf = (mcap: number | null) => { const m = Math.max(1, mcap ?? 0); const t = (Math.log10(m) - 3) / 4; return 1.8 + Math.min(1, Math.max(0, t)) * 4.6; };

type Props = { node: BubbleNode; kids: BubbleNode[]; width: number; onPick: (mint: string) => void; onHover: (mint: string | null) => void };

export default function Brood({ node, kids, width, onPick, onHover }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const halo = `brood${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [hot, setHot] = useState<number>(-1);
  const W = Math.max(160, width);
  const geo = useMemo(() => {
    const nowS = Math.floor(Date.now() / 1000);
    const shown = kids.slice(0, MAX);
    let t0 = node.createdAt ?? Infinity;
    for (const k of shown) if (k.createdAt && k.createdAt < t0) t0 = k.createdAt;
    if (!Number.isFinite(t0)) t0 = nowS - 86_400;
    const span = Math.max(60, nowS - t0);
    const x0 = PAD_L + 14, x1 = W - PAD_R - 6;
    const f = (dt: number) => Math.log1p(Math.max(0, dt) / UNIT_S) / Math.log1p(span / UNIT_S);
    const x = (t: number | null | undefined) => x0 + f(Math.min(nowS, t ?? t0) - t0) * (x1 - x0);
    // ticks that land well inside the axis (clear of "launch" and "now")
    const ticks = TICKS.map(([dt, l]) => ({ x: x0 + f(dt) * (x1 - x0), l, dt })).filter((t) => t.dt < span && t.x > x0 + 44 && t.x < x1 - 40);
    const dots = shown.map((k) => {
      const r = rOf(k.mcapUsd);
      const cy = AXIS_Y + jitter(k.mint) * SPREAD;
      const cx = x(k.createdAt);
      // the filament: from the coin's node, bowing toward the child's row
      const mx = (PAD_L + cx) / 2;
      const d = `M${PAD_L} ${AXIS_Y}C${mx.toFixed(1)} ${AXIS_Y} ${(cx - 18).toFixed(1)} ${cy.toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)}`;
      return { k, cx, cy, r, d, lock: (k.lockedUsd ?? 0) > 0 || k.children > 0 };
    });
    return { dots, t0, nowS, ticks, locks: dots.reduce((n, d) => n + (d.lock ? 1 : 0), 0) };
  }, [kids, node.createdAt, W]);
  const childTone = tone(node.depth + 1);

  const pick = (e: { clientX: number; clientY: number }) => {
    const el = svg.current;
    if (!el) return -1;
    const r = el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
    let best = -1, bd = 14 * 14;
    for (let i = 0; i < geo.dots.length; i++) { const d = geo.dots[i]; const dd = (d.cx - px) ** 2 + (d.cy - py) ** 2 - d.r * d.r; if (dd < bd) { bd = dd; best = i; } }
    return best;
  };
  const move = (e: RPointerEvent<SVGSVGElement>) => {
    const i = pick(e);
    if (i !== hot) { setHot(i); onHover(i >= 0 ? geo.dots[i].k.mint : null); }
  };
  const leave = () => { if (hot !== -1) { setHot(-1); onHover(null); } };
  const h = hot >= 0 ? geo.dots[hot] : null;
  const label = `${count(kids.length)} ${kids.length === 1 ? "child" : "children"} of ${sym(node)} over ${age(geo.t0)}${geo.locks ? `, ${count(geo.locks)} with children of their own` : ""}${kids.length > MAX ? ` (the ${MAX} largest drawn)` : ""}`;

  return (
    <div className={`map-brood ${h ? "is-reading" : ""}`} style={{ "--brood": childTone } as CSSProperties}>
      <svg ref={svg} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}
        onPointerMove={move} onPointerLeave={leave} onPointerCancel={leave}
        onClick={(e) => { const i = pick(e); if (i >= 0) onPick(geo.dots[i].k.mint); }}>
        <defs>
          <radialGradient id={halo}><stop offset="0" stopColor="currentColor" stopOpacity=".45" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient>
        </defs>
        <line className="map-brood-axis" x1={PAD_L} x2={W - PAD_R} y1={AXIS_Y} y2={AXIS_Y} />
        <g className="map-brood-ticks" aria-hidden="true">
          {geo.ticks.map((t) => <g key={t.l}><line x1={t.x} x2={t.x} y1={AXIS_Y + SPREAD + 6} y2={AXIS_Y + SPREAD + 10} /><text x={t.x} y={H - 2} textAnchor="middle">{t.l}</text></g>)}
          <text x={PAD_L - 6} y={H - 2}>{age(geo.t0)} ago</text>
          <text x={W - PAD_R} y={H - 2} textAnchor="end">now</text>
        </g>
        <g className="map-brood-fils">{geo.dots.map((d, i) => <path key={d.k.mint} d={d.d} className={i === hot ? "on" : ""} />)}</g>
        <g className="map-brood-kids" style={{ color: childTone }}>
          {geo.dots.map((d, i) => (
            <g key={d.k.mint} className={`map-brood-kid ${i === hot ? "on" : ""}`} style={{ "--i": Math.min(i, 30) } as CSSProperties}>
              {i === hot && <circle cx={d.cx} cy={d.cy} r={d.r + 7} fill={`url(#${halo})`} />}
              <circle cx={d.cx} cy={d.cy} r={d.r} fill="currentColor" fillOpacity={d.lock ? 0.9 : 0.55} stroke="currentColor" strokeOpacity=".9" strokeWidth=".75" />
              {d.lock && d.r > 2.6 && <circle cx={d.cx} cy={d.cy} r={Math.max(1, d.r - 2)} fill="none" stroke="var(--bg-0)" strokeWidth="1" />}
            </g>
          ))}
        </g>
        <g className="map-brood-root" style={{ color: tone(node.depth) }}>
          <circle cx={PAD_L} cy={AXIS_Y} r="13" fill={`url(#${halo})`} />
          <circle cx={PAD_L} cy={AXIS_Y} r="5.5" fill="currentColor" />
          <circle cx={PAD_L} cy={AXIS_Y} r="8.5" fill="none" stroke="currentColor" strokeOpacity=".35" />
        </g>
      </svg>
      {h && (
        <span className="map-brood-read" aria-hidden="true" style={{ left: `${((h.cx / W) * 100).toFixed(1)}%`, top: `${Math.max(0, h.cy - h.r - 26)}px`, transform: `translateX(${(-(h.cx / W) * 100).toFixed(1)}%)` }}>
          <b>{sym(h.k)}</b> {usd(h.k.mcapUsd)} · {h.k.createdAt ? age(h.k.createdAt) : "—"}
        </span>
      )}
    </div>
  );
}
