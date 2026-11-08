// The last 24 hours of an agent at a glance (redesign 2026-10-20, A10): one bar per clock hour,
// stacked by kind (launch lime, claim teal, model calls violet, anything else faint). Drawn as
// inline SVG that stretches to its column (the character sheet runs it full width as a heat strip);
// the caption counts the actions and the label names the busiest hour. A quiet hour is a 2 px tick
// on the baseline, so a quiet day reads as a flat line, not as 24 empty cells waiting to load.
import { useMemo } from "react";
import type { ActivityItem } from "../../lib/api";
import { plural } from "../../lib/format";
import { clockHM, hourBuckets } from "./diary";

const W = 4, GAP = 2, H = 36, QUIET_H = 4;
const ORDER = ["launch", "claim", "ai", "other"] as const;

export default function ActivityBars({ activity, now }: { activity: ActivityItem[]; now: number }) {
  // Re-bucket once a minute at most: the bars move by the hour.
  const minute = Math.floor(now / 60);
  const { buckets, total, busiest } = useMemo(() => hourBuckets(activity, minute * 60), [activity, minute]);
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const label = total && busiest
    ? `Last 24 hours: ${plural(total, "action")}; busiest hour ${clockHM(busiest.start)}–${clockHM(busiest.start + 3600)} with ${busiest.total}`
    : "Last 24 hours: no actions";
  // A day without actions draws only its baseline: a short strip, no tall empty band above it.
  const svgH = total ? H : QUIET_H;
  return (
    <figure className={`agent-bars ${total ? "" : "quiet"}`}>
      <svg width={24 * (W + GAP) - GAP} height={svgH} viewBox={`0 0 ${24 * (W + GAP) - GAP} ${svgH}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {buckets.map((b, i) => {
          let y = H;
          return (
            <g key={b.start}>
              {b.total > 0
                ? <rect className="agent-bars-bg" x={i * (W + GAP)} y={0} width={W} height={H} rx={1.5} />
                : <rect className="agent-bars-tick" x={i * (W + GAP)} y={svgH - 2} width={W} height={2} rx={1}><title>{`${clockHM(b.start)} · no actions`}</title></rect>}
              {ORDER.map((k) => {
                const n = b[k];
                if (!n) return null;
                const h = Math.max(2, (n / max) * H);
                y -= h;
                return <rect key={k} className={`agent-bars-${k}`} x={i * (W + GAP)} y={y} width={W} height={h} rx={1.5}><title>{`${clockHM(b.start)} · ${b.total} action${b.total === 1 ? "" : "s"}`}</title></rect>;
              })}
            </g>
          );
        })}
      </svg>
      <figcaption className="mono">24 h · {plural(total, "action")}</figcaption>
    </figure>
  );
}
