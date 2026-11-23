// A Discover story's relative chart (pages/Discover.tsx, opened by the story header's "Chart" control): the story's
// 5-minute series (GET /api/story-series/:key), read once when opened. x: time since the story's start (its post's
// time when it has one); y: times its normal with a dashed 1× line, or raw buyers per 5 min for a story too new to have
// a normal (labelled so). The linked post's time is marked. A pointer or finger over it reads the real buyers of the
// bucket under it (shown, not announced: the svg's label is the text alternative). One neutral colour whatever the
// direction. The box and the footer line keep their height while it reads, so the rows under it do not move. Plain SVG; the width follows the block (ResizeObserver). Geometry: lib/story-attention.ts.
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api, errorMessage, type StorySeries } from "../lib/api";
import { attGeo, attSeries, nearestAt, pointWords, afterWords, timesWords, CHART_NOTE_MULT, CHART_NOTE_RAW, NORMAL_TITLE } from "../lib/story-attention";

const H_WIDE = 120, H_PHONE = 100, PHONE_W = 520;

export default function StoryChart({ storyKey, postAt, label }: { storyKey: string; postAt: number | null; label: string }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [data, setData] = useState<StorySeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hot, setHot] = useState<number | null>(null);
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
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    api.storySeries(storyKey).then((d) => { if (alive) setData(d); }, (e) => { if (alive) setError(errorMessage(e)); });
    return () => { alive = false; };
  }, [storyKey]);
  const h = w < PHONE_W ? H_PHONE : H_WIDE;
  const a = useMemo(() => (data ? attSeries(data, postAt) : null), [data, postAt]);
  const geo = useMemo(() => (a ? attGeo(a, w, h) : null), [a, w, h]);
  const i = geo && a && hot !== null && hot >= 0 && hot < a.points.length ? hot : null;
  const track = (e: RPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (geo && r.width > 0) setHot(nearestAt(geo.xs, ((e.clientX - r.left) / r.width) * geo.w));
  };
  const note = a?.mode === "multiple" ? CHART_NOTE_MULT : CHART_NOTE_RAW;
  const last = a && a.points.length ? a.points[a.points.length - 1] : null;
  const read = a && (i !== null ? a.points[i] : last);
  return (
    <div className="dsc-sc" id={id}>
      <div className="dsc-sc-head">
        <span className="dsc-sc-note" title={a?.mode === "multiple" ? NORMAL_TITLE : undefined}>{a ? note : "Buyers per 5 min"}</span>
        {a && read && <span className="dsc-sc-read" aria-hidden="true">{i !== null ? pointWords(a, read) : `last 5 min: ${pointWords(a, read)}`}</span>}
      </div>
      <div ref={box} className={`dsc-sc-box${geo ? "" : " none"}`} style={{ height: h }} aria-busy={!data && !error}>
        {!geo ? (
          <p>{error ? `The chart could not be read just now (${error}).` : !data ? "Reading…" : "Not enough 5-minute buckets for a chart yet."}</p>
        ) : (
          <svg className="dsc-sc-svg" width="100%" height={h} viewBox={`0 0 ${geo.w} ${geo.h}`} preserveAspectRatio="none" role="img"
            aria-label={`${label}: ${note}, ${a!.points.length} buckets of 5 minutes${a!.mode === "multiple" && last ? `, last ${timesWords(last.y)} its normal` : last ? `, last ${last.buyers} buyers` : ""}.`}
            onPointerMove={track} onPointerDown={track} onPointerLeave={() => setHot(null)} onPointerCancel={() => setHot(null)}>
            {geo.oneY !== null && <line className="dsc-sc-one" x1="0" x2={geo.w} y1={geo.oneY} y2={geo.oneY} vectorEffect="non-scaling-stroke" />}
            {geo.postPx !== null && <line className="dsc-sc-post" x1={geo.postPx} x2={geo.postPx} y1="0" y2={geo.h} vectorEffect="non-scaling-stroke" />}
            <path d={geo.line} fill="none" className="dsc-sc-line" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {i !== null && (
              <g className="dsc-sc-cross" aria-hidden="true">
                <line x1={geo.xs[i]} x2={geo.xs[i]} y1="0" y2={geo.h} vectorEffect="non-scaling-stroke" />
                <circle cx={geo.xs[i]} cy={geo.ys[i]} r="3" />
              </g>
            )}
          </svg>
        )}
      </div>
      {/* always there (empty while reading), so the rows under the chart do not move when the series arrives */}
      <div className="dsc-sc-foot" aria-hidden="true">
        {geo && a && <>
          <span>{a.originKind === "start" ? (geo.x0 > 0 && afterWords(geo.x0) ? `${afterWords(geo.x0)} after the start` : "the start") : "first bucket"}</span>
          {geo.oneY !== null && <span className="dsc-sc-key"><i className="dsc-sc-dash" /> 1× normal</span>}
          {geo.postPx !== null && <span className="dsc-sc-key"><i className="dsc-sc-pmark" /> post</span>}
          <span>now</span>
        </>}
      </div>
    </div>
  );
}
