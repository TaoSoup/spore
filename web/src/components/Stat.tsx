import type { ReactNode } from "react";
import { Skeleton } from "./Bits";
import { signedPct } from "../lib/format";
import "./coin.css";

/// Abstract line glyphs for stat tiles (no brand marks). 24-unit grid, stroked in currentColor.
const GLYPHS = {
  tree: <><path d="M12 21v-9M12 12 7 7M12 12l5-5" /><circle cx="12" cy="12" r="1.6" /><circle cx="7" cy="7" r="2" /><circle cx="17" cy="7" r="2" /><circle cx="12" cy="21" r="1.4" /></>,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15.5" r="1.3" /></>,
  volume: <><path d="M4 19h16M6 15V9M11 15V5M16 15v-4M20 15V7" /></>,
  depth: <><path d="M4 7l8 4 8-4M4 12l8 4 8-4M4 17l8 4 8-4" /></>,
  price: <><path d="M4 16l5-5 4 4 7-8" /><path d="M16 7h4v4" /></>,
  spore: <><circle cx="10" cy="13" r="5" /><circle cx="17" cy="7" r="1.6" /><circle cx="19.5" cy="12" r="1.2" /><circle cx="15" cy="18.5" r="1.2" /></>,
} as const;
export type GlyphName = keyof typeof GLYPHS;
export const Glyph = ({ name }: { name: GlyphName }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPHS[name]}</svg>
);

/// A signed change pill: green up, red down, muted flat. `ratio` is new/old − 1; `label` names
/// the window ("24h", "since first trade") so the number is never read without its basis.
export function Delta({ ratio, label, title }: { ratio: number | null | undefined; label?: string; title?: string }) {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const tone = ratio > 0.0005 ? "up" : ratio < -0.0005 ? "down" : "flat";
  return <span className={`delta ${tone}`} title={title}>{signedPct(ratio)}{label && <small>{label}</small>}</span>;
}

/// A stat tile (bento-ready): label above, number below, optional footnote and corner glyph.
/// `hero` enlarges and tints the number for the one figure a strip is about (`xl` sets it at
/// --num-2xl, once per section); `spark` is a slot drawn behind the lower half of the tile (a
/// sparkline SVG or canvas sized 100 % × 100 %); `delta` adds a change pill next to the label (the
/// price tile's 24h move). `className` lets a bento place the tile (grid-area, span).
export function Stat({ label, value, sub, hero = false, xl = false, loading = false, tone = "", icon, delta, deltaLabel, deltaTitle, spark, className = "" }: { label: ReactNode; value: ReactNode; sub?: ReactNode; hero?: boolean; xl?: boolean; loading?: boolean; tone?: "" | "accent" | "violet"; icon?: GlyphName; delta?: number | null; deltaLabel?: string; deltaTitle?: string; spark?: ReactNode; className?: string }) {
  return (
    <div className={`stat ${hero ? "hero" : ""} ${xl ? "xl" : ""} ${tone} ${className}`.replace(/\s+/g, " ").trim()}>
      {spark && <span className="stat-spark" aria-hidden="true">{spark}</span>}
      {icon && <span className="stat-icon"><Glyph name={icon} /></span>}
      <span>{label}{delta != null && <Delta ratio={delta} label={deltaLabel} title={deltaTitle} />}</span>
      {loading ? <Skeleton w="60%" h={hero ? 30 : 24} /> : <b>{value}</b>}
      {sub && <small>{sub}</small>}
    </div>
  );
}
/// The row of stat tiles: one panel, tiles separated by hairlines (2-up on phones).
export const StatStrip = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`stats ${className}`}>{children}</div>;
