// The coin's birth certificate: the launch preview (updating as the form is typed) and, after the
// launch, the same document issued with its mint. A drawn scene on top (the parent's node, or SOL for
// a new tree, joined to the coin's node by a filament; the fee split as a 270° arc around the coin;
// a root's agent in orbit), then the coin's name and a mono ledger of its facts. Every number comes
// from the page (the server's shares once loaded, the pinned policy before that).
import type { ReactNode } from "react";
import { Filament, Illus, Motes, Node, Ring, SplitArc, curve, type Tone } from "../illus/base";
import { Addr, DepthBadge, Logo } from "../Bits";
import SporeBurst from "./SporeBurst";

export type CertSegment = { key: string; bps: number; cls: string; label: string };
type Parent = { symbol: string | null; mint: string; image?: string | null };
type Props = {
  image: string | null; onImg?: (img: HTMLImageElement) => void;
  name: string; symbol: string;
  /// null: a new tree priced in SOL. `pending`: a child whose parent is not picked yet.
  parent: Parent | null; pending?: boolean;
  depth: number; segments: CertSegment[]; splitLine: string;
  /// A root's agent model label; null for a child.
  model: string | null;
  state: "preview" | "issued"; mint?: string | null; dry?: boolean; splitPending?: boolean;
  /// Source of the split figures ("from Spore" once the server answered, "policy" before).
  source?: string;
  burst?: boolean; children?: ReactNode;
};

const TONE: Record<string, Tone> = { "role-creator": "lime", "role-spore": "ink", "role-agent": "agent", "role-other": "violet" };
// Scene geometry (viewBox 312 × 168, a 24-unit grid wide): parent P, coin C, arc and orbit radii.
const P = { x: 52, y: 60, r: 20 }, C = { x: 214, y: 90, r: 34 }, ARC = 45, ORBIT = 58;
const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`;

export default function Certificate({ image, onImg, name, symbol, parent, pending = false, depth, segments, splitLine, model, state, mint = null, dry = false, splitPending = false, source, burst = false, children }: Props) {
  const tag = symbol ? `$${symbol.replace(/^\$/, "")}` : "$TICKER";
  const root = !parent && !pending;
  const ptag = parent ? (parent.symbol ? `$${parent.symbol.replace(/^\$/, "")}` : parent.mint.slice(0, 4)) : root ? "SOL" : "parent";
  const letter = (Array.from((symbol || name || "?").replace(/^\$/, ""))[0] ?? "?").toUpperCase();
  const issued = state === "issued";
  return (
    <div className={`cert ${issued ? "issued" : "preview"} ${root ? "is-root" : "is-child"} ${splitPending ? "split-pending" : ""}`}>
      <div className="cert-top">
        <span className="label">{issued ? "Birth certificate" : "Preview · birth certificate"}</span>
        <span className={`cert-stamp ${issued ? (dry ? "dry" : splitPending ? "warn" : "live") : ""}`}>{issued ? (dry ? "dry run" : splitPending ? "split pending" : "live") : "draft"}</span>
      </div>

      <div className="cert-scene" aria-hidden="true">
        <Illus viewBox="0 0 312 168" className="cert-art">
          <Motes seed={symbol.length * 7 + 3} n={18} box={[0, 4, 312, 160]} tone={["lime", "teal", "violet"]} rMax={1.25} />
          <Ring cx={P.x} cy={P.y} r={P.r + 7} tone={root ? "ink" : "lime"} opacity={0.22} />
          <Filament d={curve(P.x + P.r + 4, P.y + 4, C.x - ARC - 6, C.y - 6, -0.14)} tone={pending ? "ink" : "lime"} dashed={pending} mote={!pending} dur={2.8} opacity={pending ? 0.4 : 0.62} width={1.5} />
          {model && <Ring cx={C.x} cy={C.y} r={ORBIT} tone="agent" dashed opacity={0.32} />}
          <circle cx={C.x} cy={C.y} r={ARC} stroke="rgba(255,255,255,.07)" strokeWidth={3} />
          <SplitArc cx={C.x} cy={C.y} r={ARC} sweep={270} start={135} gap={5} width={3} parts={segments.map((s) => ({ v: s.bps, tone: TONE[s.cls] ?? "violet" }))} />
          <Node cx={C.x} cy={C.y} r={C.r - 2} tone={depth === 0 ? "lime" : depth === 1 ? "teal" : "violet"} halo />
          {model && <g className="cert-orbit" style={{ transformOrigin: `${C.x}px ${C.y}px` }}><Node cx={C.x + ORBIT * Math.cos(-0.5)} cy={C.y + ORBIT * Math.sin(-0.5)} r={3.2} tone="agent" /></g>}
        </Illus>
        <span className={`cert-node parent ${root ? "sol" : ""} ${pending ? "pending" : ""}`} style={{ left: pct(P.x, 312), top: pct(P.y, 168), width: pct(P.r * 2, 312) }}>
          {parent ? <Logo src={parent.image ?? null} label={parent.symbol} size={40} /> : <span>{root ? "SOL" : "?"}</span>}
        </span>
        <span className="cert-cap" style={{ left: pct(P.x, 312), top: pct(P.y + P.r + 14, 168) }}><em>{root ? "priced in" : "under"}</em><b className="mono">{ptag}</b></span>
        <span className="cert-node coin" style={{ left: pct(C.x, 312), top: pct(C.y, 168), width: pct(C.r * 2, 312) }}>
          {image ? <img src={image} alt="" onLoad={(ev) => onImg?.(ev.currentTarget)} /> : <span>{letter}</span>}
        </span>
        {/* The burst canvas overhangs the scene (left -20 %, top -30 %, 140 % × 160 %); its origin is the coin. */}
        {burst && <SporeBurst x={(C.x / 312 + 0.2) / 1.4} y={(C.y / 168 + 0.3) / 1.6} />}
      </div>

      <div className="cert-id">
        <b className="cert-name">{name.trim() || "Your coin"}</b>
        <span className="cert-tag mono">{tag}</span>
      </div>
      {children}

      <dl className="cert-ledger">
        <div><dt>Priced in</dt><dd className="mono">{pending ? "pick a parent" : ptag}</dd></div>
        <div><dt>Depth</dt><dd><DepthBadge depth={depth} title={root ? "a new tree: depth 0" : `depth ${depth}`} /></dd></div>
        <div><dt>Agent</dt><dd>{model ? <span className="chip agent">{model}</span> : <span className="muted">none for a coin under a parent</span>}</dd></div>
        <div><dt>Mint</dt><dd className="mono">{mint ? <Addr a={mint} n={6} /> : <span className="muted">assigned at launch</span>}</dd></div>
      </dl>

      <div className="cert-split">
        <div className="cert-split-head"><span className="label">Creator fee split</span>{source && <span className="label">{source}</span>}</div>
        <ul className="cert-legend">
          {segments.map((s) => (
            <li key={s.key} className={s.cls}><i aria-hidden="true" /><span>{s.label}</span><b className="mono">{(s.bps / 100).toFixed(s.bps % 100 === 0 ? 0 : 2)}%</b></li>
          ))}
        </ul>
        <p className="cert-split-line">{splitLine}</p>
      </div>
    </div>
  );
}
