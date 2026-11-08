// Highlight chips for the map (DESIGN §11.5 "Map v2"): each key dims every coin that does not match
// (AND across keys), nothing moves. The keys live in `?hl=`; counts and the predicate are built from ONE
// context, so a chip's number is exactly how many bubbles light up for that key alone.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { count } from "../../../lib/format";
import type { HeatIndex } from "../../../lib/map/heat";
import { HL_KEYS, HL_LABEL, hlCounts, hlPredicate, hlTest, type HlCtx, type HlKey } from "../../../lib/map/highlight";
import type { BubbleNode } from "../../../lib/map/types";
import { useThrottled } from "./util";

const NEW_KEYS: HlKey[] = ["new1h", "new24h"];

/// One 12-unit glyph per key, drawn in the site's illustration language (nodes, rings, filaments): what the
/// key lights up, so the chips read at a glance. currentColor, hairline strokes; decorative (the label says it).
const GLYPH: Record<HlKey, ReactNode> = {
  ours: <><circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1" opacity=".55" /><circle cx="6" cy="6" r="2" fill="currentColor" /></>,
  new1h: <><circle cx="6" cy="9.4" r="1.7" fill="currentColor" /><path d="M6 7.6V4.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /><circle cx="6" cy="3.2" r="1.25" fill="none" stroke="currentColor" strokeWidth="1" /></>,
  new24h: <><circle cx="6" cy="9.6" r="1.6" fill="currentColor" /><path d="M6 8V3.4M6 6.2 3 3.6M6 5.2 9 2.6" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" /><circle cx="3" cy="3.4" r=".95" fill="currentColor" /><circle cx="9" cy="2.4" r=".95" fill="currentColor" /></>,
  grad: <><circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1" opacity=".45" /><circle cx="9.1" cy="2.9" r="1.5" fill="currentColor" /><circle cx="6" cy="6" r="1.6" fill="currentColor" opacity=".7" /></>,
  min1k: <><path d="M2.5 10V8M6 10V5.5M9.5 10V2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  active: <><path d="M1.5 6.5h2l1.4-3.5 2.2 6 1.4-2.5h2" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" /></>,
  since: <><circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.6" opacity=".7" /><path d="M6 3.6V6l1.7 1.1" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></>,
};

/// The predicate for BubbleMap and the per-key counts for the chips. The context's clock ticks once a
/// minute (only the "new" keys read it); `active` follows the heat index; `since` the previous visit.
/// Base counts recompute at most every 2 s as the nodes change; the `active` count walks only the heat rows.
export function useHighlight(nodes: BubbleNode[], byMint: Map<string, BubbleNode>, keys: HlKey[], seenAtMs: number | null, heat: HeatIndex | null) {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => { const t = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 15_000); return () => clearInterval(t); }, []);
  const seenAtS = seenAtMs != null ? Math.floor(seenAtMs / 1000) : null;
  const ctx = useMemo<HlCtx>(() => ({ nowS: minute * 60, seenAtS, heat }), [minute, seenAtS, heat]);
  // A key whose source is missing (no heat sidecar on an older server, no previous visit) is ignored
  // rather than dimming everything: its chip is hidden too.
  const live = keys.filter((k) => (k !== "active" || heat) && (k !== "since" || seenAtS != null));
  const keyStr = live.join(",");
  const wantsActive = live.includes("active");
  const wantsClock = live.some((k) => NEW_KEYS.includes(k));
  const predicate = useMemo(() => hlPredicate(live, ctx),
    // Rebuilt only when what it reads changes: the keys, the previous visit, heat (when "active" is on), the minute (when a "new" key is on).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keyStr, seenAtS, wantsActive ? heat?.version : -1, wantsClock ? minute : -1]);
  const counted = useThrottled(nodes, 2_000);
  const base = useMemo(() => hlCounts(counted, { nowS: minute * 60, seenAtS, heat: null }), [counted, minute, seenAtS]);
  const active = useMemo(() => {
    if (!heat) return 0;
    let k = 0;
    for (const mint of heat.rows.keys()) { const n = byMint.get(mint); if (n && hlTest("active", n, ctx)) k++; }
    return k;
  }, [heat, byMint, ctx]);
  const counts = useMemo(() => ({ ...base, active }), [base, active]);
  return { predicate, counts, ctx };
}

type Props = { keys: HlKey[]; onKeys: (keys: HlKey[]) => void; counts: Record<HlKey, number>; seenAt: number | null; heatOn: boolean; children?: ReactNode };

export default function Highlights({ keys, onKeys, counts, seenAt, heatOn, children }: Props) {
  const on = new Set(keys);
  const visible = HL_KEYS.filter((k) => (k === "since" ? seenAt != null : k === "active" ? heatOn : true));
  const toggle = (k: HlKey) => onKeys(on.has(k) ? keys.filter((x) => x !== k) : [...keys, k]);
  return (
    <div className="map-hl">
      <div className="map-hl-head"><span className="tools-label">highlight</span>{keys.length > 0 && <span className="map-hl-note">dims the rest · all must match</span>}</div>
      <div className="map-hl-chips" role="group" aria-label="Highlight coins">
        {visible.map((k) => (
          <button type="button" key={k} className="map-hl-chip" data-key={k} aria-pressed={on.has(k)} onClick={() => toggle(k)} title={`${on.has(k) ? "Stop highlighting" : "Highlight"}: ${HL_LABEL[k]}`}>
            <svg className="map-hl-glyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">{GLYPH[k]}</svg>{HL_LABEL[k]}<b>{count(counts[k])}</b>
          </button>
        ))}
        {keys.length > 0 && <button type="button" className="map-hl-chip clear" onClick={() => onKeys([])} aria-label="Clear highlights"><svg className="map-hl-glyph" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5 8.5 8.5M8.5 3.5 3.5 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>clear</button>}
      </div>
      {children}
    </div>
  );
}
