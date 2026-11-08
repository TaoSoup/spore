// One family's dominance (DESIGN §11.5 "Dominance"): its share of all locked value and of all market cap
// on the map, both numbers always, with a thin bar for the one the reader is looking at (the map's size
// mode; locked value elsewhere). The map's side panel and the coin page use it; the numbers come from
// lib/map/dominance.ts (the page's map data) or GET /api/map/dominance (the coin page), which agree.
import type { ReactNode } from "react";
import { DOM_WORDS, sharePct } from "../lib/map/dominance";
import type { SizeMode } from "../lib/map/types";
import Term from "./Term";
import "./dominance.css";

/// The term's explanation when only the market-cap share is shown (the map page; the glossary text speaks of locked value).
const DOM_MCAP_ONLY = "A family's share of the whole map's market cap: its root and every pair under it, over the same sum for every family on the map.";

type Props = {
  locked: number | null; mcap: number | null;
  /// Which share the bar draws and the accent marks.
  mode?: SizeMode;
  /// Show only this share (the map's panel shows market cap alone); the bar follows it.
  only?: SizeMode;
  /// A small caption above the line (the family, its size and rank).
  label?: ReactNode;
  /// "block": caption, line, then a full-width bar (side panel). "inline": the line with a short bar after it (coin page).
  variant?: "block" | "inline";
  /// Anything after the line (a link to the map).
  children?: ReactNode;
  className?: string;
};

export default function DominanceLine({ locked, mcap, mode = "locked", only, label, variant = "block", children, className = "" }: Props) {
  const m = only ?? mode;
  const cur = m === "mcap" ? mcap : locked;
  const width = cur != null && cur > 0 ? Math.min(100, cur * 100) : 0;
  const pct = (v: number | null) => (v == null ? "—" : sharePct(v));
  return (
    <div className={`dom ${variant} ${className}`}>
      {label && <div className="dom-label">{label}</div>}
      <p className="dom-line">
        <span className="dom-k"><Term k="dominance" text={only === "mcap" ? DOM_MCAP_ONLY : undefined}>Dominance</Term>:</span>{" "}
        {only !== "mcap" && <span className="dom-part"><b className={m === "locked" ? "cur" : ""}>{pct(locked)}</b> {DOM_WORDS.locked}</span>}
        {!only && <span className="dom-sep" aria-hidden="true"> · </span>}
        {only !== "locked" && <span className="dom-part"><b className={m === "mcap" ? "cur" : ""}>{pct(mcap)}</b> {DOM_WORDS.mcap}</span>}
      </p>
      <div className="dom-bar" role="img" aria-label={`${pct(cur)} ${DOM_WORDS[m]}`} title={`${pct(cur)} ${DOM_WORDS[m]}`}>{width > 0 && <i style={{ width: `${width}%` }} />}</div>
      {children}
    </div>
  );
}
