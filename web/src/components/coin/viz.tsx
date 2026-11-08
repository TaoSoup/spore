// The coin page's small instruments (DESIGN-ELEVATE §8): the 24 h sparkline (line, gradient area,
// glowing last dot), the 24 h activity heat strip (one cell per hour from the trades tape), the
// creator-fee arc (270°, role colours, live amounts) and the trade route drawn as filaments with hops.
// Every figure comes from data the page already holds or from /api/candles; nothing is invented, and
// a missing series draws nothing rather than a flat line that would read as "no change".
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type Candle, type Trade } from "../../lib/api";
import { countUp, motionPaused } from "../../lib/motion";
import { age, signedPct } from "../../lib/format";
import { IllusDefs, IllusScope, Filament, TONES, type Tone } from "../illus/base";
import { Logo } from "../Bits";

/* ---------- sparkline */

export type SparkTone = "up" | "down" | "flat";
export const sparkTone = (change: number | null | undefined): SparkTone => (change == null ? "flat" : change > 0.0005 ? "up" : change < -0.0005 ? "down" : "flat");

/// Line + area + last dot in a w×h box. `points` are values in time order (at least two).
export function Sparkline({ points, tone, w = 100, h = 28, label, className = "" }: { points: number[]; tone: SparkTone; w?: number; h?: number; label?: string; className?: string }) {
  const raw = useId();
  const id = `cs${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const d = useMemo(() => {
    if (points.length < 2) return null;
    const lo = Math.min(...points), hi = Math.max(...points);
    const span = hi - lo || Math.abs(hi) || 1;
    const pad = 3;
    const xs = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
    const ys = (v: number) => pad + (1 - (v - lo) / span) * (h - pad * 2);
    const pts = points.map((v, i) => [xs(i), hi === lo ? h / 2 : ys(v)] as const);
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
    const area = `${line}L${pts[pts.length - 1][0].toFixed(1)} ${h}L${pts[0][0].toFixed(1)} ${h}Z`;
    return { line, area, last: pts[pts.length - 1] };
  }, [points, w, h]);
  if (!d) return null;
  return (
    <svg className={`cspark ${tone} ${className}`.trim()} viewBox={`0 0 ${w} ${h}`} width={w} height={h} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      <defs>
        <linearGradient id={`${id}-a`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".28" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient>
      </defs>
      <path className="cspark-area" d={d.area} fill={`url(#${id}-a)`} />
      <path className="cspark-line" d={d.line} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle className="cspark-halo" cx={d.last[0]} cy={d.last[1]} r="5" fill="currentColor" opacity=".18" />
      <circle className="cspark-dot" cx={d.last[0]} cy={d.last[1]} r="2.2" fill="currentColor" />
    </svg>
  );
}

/// The last 24 h of a candle series as spark points (everything the server has when the day holds
/// fewer than two), with the change over that basis. null when there is nothing to draw.
export type Spark = { points: number[]; change: number | null; basis: string };
export function sparkFrom(candles: Candle[] | null | undefined): Spark | null {
  if (!candles?.length) return null;
  const rows = [...candles].sort((a, b) => a.t - b.t);
  const now = Date.now() / 1000;
  const day = rows.filter((c) => c.t >= now - 86_400);
  const use = day.length >= 2 ? day : rows;
  if (use.length < 2) return null;
  const points = use.map((c) => c.c);
  const first = use[0].o || use[0].c;
  return { points, change: first > 0 ? points[points.length - 1] / first - 1 : null, basis: day.length >= 2 ? "24h" : age(use[0].t) };
}

/// Children's sparklines: one 15-minute series per mint, shared and kept for two minutes; only coins
/// that traded today are asked for (a quiet child has no candles, and a list must not fire requests
/// for nothing).
const sparkCache = new Map<string, { at: number; p: Promise<Spark | null> }>();
function loadSpark(mint: string): Promise<Spark | null> {
  const hit = sparkCache.get(mint);
  if (hit && Date.now() - hit.at < 120_000) return hit.p;
  const p = api.candles(mint, 900).then((r) => sparkFrom(r.candles)).catch(() => null);
  sparkCache.set(mint, { at: Date.now(), p });
  return p;
}
/// undefined while loading (or not asked), null for nothing to draw.
export function useSpark(mint: string, enabled: boolean): Spark | null | undefined {
  const [s, setS] = useState<{ mint: string; v: Spark | null } | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadSpark(mint).then((v) => { if (alive) setS({ mint, v }); });
    return () => { alive = false; };
  }, [mint, enabled]);
  return s && s.mint === mint ? s.v : undefined;
}
export const sparkLabel = (s: Spark, what = "Price") => `${what}, ${s.basis === "24h" ? "last 24 hours" : `since ${s.basis} ago`}${s.change != null ? `, ${signedPct(s.change)}` : ""}`;

/* ---------- 24 h activity heat strip */

/// 24 cells, one per hour, oldest left. A cell's light is its trade count against the busiest hour;
/// lime where buys outnumber sells, pink where sells do, ink when even. The tape holds the last 50
/// trades: hours older than the oldest trade it holds (when it is full) are drawn hatched and named
/// "not in the tape" so a quiet-looking cell is never a guess.
export function HeatStrip({ trades, full, now }: { trades: Trade[]; full: boolean; now: number }) {
  const hourNow = Math.floor(now / 3600);
  const cells = useMemo(() => {
    const out = Array.from({ length: 24 }, (_, i) => ({ hour: hourNow - 23 + i, buys: 0, sells: 0 }));
    for (const t of trades) {
      const k = Math.floor(t.time / 3600) - (hourNow - 23);
      if (k < 0 || k > 23) continue;
      if (t.isBuy) out[k].buys++; else out[k].sells++;
    }
    return out;
  }, [trades, hourNow]);
  const oldest = trades.length ? Math.min(...trades.map((t) => t.time)) : now;
  const coveredFrom = full ? Math.floor(oldest / 3600) : -Infinity;
  const max = Math.max(1, ...cells.map((c) => c.buys + c.sells));
  const total = cells.reduce((a, c) => a + c.buys + c.sells, 0);
  const buys = cells.reduce((a, c) => a + c.buys, 0);
  const label = `Trades per hour, last 24 hours: ${total} in the tape (${buys} buys, ${total - buys} sells)${full && coveredFrom > hourNow - 23 ? `; the tape reaches back ${hourNow - coveredFrom + 1} hours` : ""}`;
  return (
    <div className="heat" role="img" aria-label={label}>
      <div className="heat-cells">
        {cells.map((c, i) => {
          const n = c.buys + c.sells;
          const outside = c.hour < coveredFrom;
          const tone = n === 0 ? "none" : c.buys > c.sells ? "buy" : c.sells > c.buys ? "sell" : "even";
          const a = n === 0 ? 0 : 0.22 + 0.78 * Math.sqrt(n / max);
          const h = new Date(c.hour * 3600 * 1000);
          const hh = `${String(h.getHours()).padStart(2, "0")}:00`;
          return <i key={c.hour} className={`heat-cell ${tone} ${outside ? "out" : ""}`} style={{ "--a": a.toFixed(2), "--i": i } as CSSProperties} title={outside ? `${hh} · not in the tape` : `${hh} · ${n} trade${n === 1 ? "" : "s"}${n ? ` (${c.buys} buy${c.buys === 1 ? "" : "s"}, ${c.sells} sell${c.sells === 1 ? "" : "s"})` : ""}`} />;
        })}
      </div>
      <div className="heat-axis" aria-hidden="true"><span>24h ago</span><span>{total === 0 ? "no trades in the last 24 hours" : "12h"}</span><span>now</span></div>
    </div>
  );
}

/* ---------- creator-fee arc */

export type ArcPart = { key: string; v: number; tone: Tone; label: ReactNode };
/// A 270° arc (opening at the bottom) split by share in role colours, with the centre reading the
/// pending total. Parts are basis points; a zero total still draws the split (who would receive).
export function FeeArc({ parts, center, sub, label, dense = false }: { parts: ArcPart[]; center: ReactNode; sub?: ReactNode; label: string; dense?: boolean }) {
  const id = `fa${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const R = 62, C = 80, SW = 7, SWEEP = 270, START = 135, GAP = parts.length > 1 ? 5 : 0;
  const total = parts.reduce((a, p) => a + Math.max(0, p.v), 0) || 1;
  const live = parts.filter((p) => p.v > 0);
  const avail = SWEEP - GAP * Math.max(0, live.length - 1);
  const pt = (deg: number, r = R) => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)] as const;
  const arc = (a0: number, a1: number, r = R) => { const [x1, y1] = pt(a0, r), [x2, y2] = pt(a1, r); return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`; };
  let at = START;
  const segs = live.map((p) => { const span = (avail * p.v) / total; const s = { ...p, a0: at, a1: at + span, len: span }; at += span + GAP; return s; });
  // tick marks every 10 % of the sweep, on the inside of the track
  const ticks = Array.from({ length: 11 }, (_, i) => START + (SWEEP * i) / 10);
  return (
    <figure className="fee-arc" role="img" aria-label={label}>
      <svg viewBox="0 0 160 148" fill="none" focusable="false" aria-hidden="true">
        <IllusDefs id={id} />
        <IllusScope id={id}>
          <path d={arc(START, START + SWEEP)} stroke="rgba(255,255,255,.07)" strokeWidth={SW + 6} strokeLinecap="round" fill="none" />
          {ticks.map((d, i) => { const [x1, y1] = pt(d, R - 11), [x2, y2] = pt(d, R - (i % 5 === 0 ? 16 : 13.5)); return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,.16)" strokeWidth=".75" />; })}
          {segs.map((s, i) => (
            <g key={s.key} className="fee-arc-seg" style={{ "--i": i } as CSSProperties}>
              <path d={arc(s.a0, s.a1)} stroke={TONES[s.tone].c} strokeOpacity=".22" strokeWidth={SW + 8} strokeLinecap="round" fill="none" filter={`url(#${id}-glow)`} />
              <path d={arc(s.a0, s.a1)} pathLength={100} className="fee-arc-draw" stroke={TONES[s.tone].c} strokeWidth={SW} strokeLinecap="round" fill="none" />
            </g>
          ))}
        </IllusScope>
      </svg>
      <figcaption className={`fee-arc-c ${dense ? "dense" : ""}`}>
        <span className="fee-arc-v">{center}</span>
        {sub && <span className="fee-arc-s">{sub}</span>}
      </figcaption>
    </figure>
  );
}

/* ---------- the route as filaments */

export type Hop = { key: string; label: string; image: string | null; symbol: string | null; self: boolean; quote: boolean };
/// SOL → $ROOT → … → $COIN drawn as nodes on a filament; motes travel the way the money goes (lime on
/// a buy, violet on a sell). The labels are real text under the nodes; the drawing is decoration and
/// the list keeps its aria-label.
export function RouteFilament({ hops, side }: { hops: Hop[]; side: "buy" | "sell" }) {
  const id = `rf${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const n = hops.length;
  const W = 288, H = 36, pad = 18;
  const xs = (i: number) => (n <= 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1));
  const tone: Tone = side === "buy" ? "lime" : "violet";
  return (
    <div className={`route-fil ${side}`} style={{ "--n": n } as CSSProperties}>
      <svg className="route-fil-svg" viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden="true" focusable="false">
        <IllusDefs id={id} />
        <IllusScope id={id}>
          {hops.slice(1).map((_, i) => {
            const x1 = xs(i) + 13, x2 = xs(i + 1) - 13, y = H / 2;
            const d = `M${x1} ${y}C${x1 + (x2 - x1) * 0.35} ${y - 7} ${x1 + (x2 - x1) * 0.65} ${y + 7} ${x2} ${y}`;
            return <Filament key={i} d={d} tone={tone} mote opacity={0.55} dur={2.4} delay={i * 0.5} />;
          })}
        </IllusScope>
      </svg>
      <ol className="route-fil-hops" aria-hidden="true">
        {hops.map((h, i) => (
          <li key={h.key} className={`${h.self ? "self" : ""} ${h.quote ? "is-quote" : ""}`.trim() || undefined} style={{ left: `${(xs(i) / W) * 100}%` }}>
            <span className="route-node">
              {h.quote ? (h.label === "SOL" ? <i className="crumb-sol" /> : <b>{h.label.slice(0, 1)}</b>) : <Logo src={h.image} label={h.symbol} size={22} />}
            </span>
            <span className="route-lbl mono">{h.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------- a number that tweens */

/// Counts to `value` with countUp (motion.ts): from zero over `first` ms the first time, then from the
/// previous figure over `ms` when the value moves (a live trade). Paused motion writes the value at once.
/// The text is written by countUp, so React never renders a figure that the tween would fight.
export function Tween({ value, format, ms = 320, first = 900, className = "" }: { value: number; format: (n: number) => string; ms?: number; first?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const fmt = useRef(format);
  fmt.current = format;
  const seen = useRef(false);
  // A layout effect, so the first paint already carries a figure (no empty frame, no width jump).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.textContent) el.textContent = fmt.current(motionPaused() ? value : 0);
    const d = seen.current ? ms : first;
    seen.current = true;
    return countUp(el, value, (n) => fmt.current(n), d);
  }, [value, ms, first]);
  return <span ref={ref} className={className} />;
}
