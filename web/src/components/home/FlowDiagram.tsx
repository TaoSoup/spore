// SOL → $ROOT → $CHILD, the product in one picture (shared by Home's "How Spore works" and /how).
// Lime arrows are the buy route, the teal bracket is the root tokens held in the child's curve,
// violet arcs are each coin's creator fee leaving for its shareholders (in SOL for the root, in
// $ROOT for the child). Two drawings of the same thing: a wide one, and a tall one under 760 px so
// the text never drops under 11 px and nothing scrolls sideways (CSS shows one of the two).
// Colours come from classes in home.css, so the SVG carries no hex values of its own.

import { useEffect, useRef, type CSSProperties } from "react";
import { ROOT_SPLIT, SPLIT_BPS } from "../../lib/policy";
import { IllusDefs, IllusScope, useIllusId } from "../illus/base";

const ARIA = "Diagram: SOL buys the root coin and the root coin buys the child, so the root tokens stay locked in the child's curve. Each coin's creator fee is split at launch: a root's between its creator, Spore and its agent, paid in SOL; a child's between its creator and Spore, paid in the root coin. Another coin can grow under the child, up to the depth cap.";

type Pt = { x: number; y: number };

/// The drawing scales with its box, its words should not: --fd-k is viewBox units per CSS pixel at the
/// drawn size, so home.css can set the labels at a constant 12–14 px (clamped to what the layout holds).
function useTextScale(vbW: number) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) el.style.setProperty("--fd-k", (vbW / w).toFixed(3));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [vbW]);
  return ref;
}

/// A buy route: a luminous filament with an arrowhead, and motes of light travelling it (CSS
/// stroke-dashoffset, so they stop with the site's motion rules and rest part-way).
function Buy({ id, g, a, b, label, vertical = false, delay = 0 }: { id: string; g: string; a: Pt; b: Pt; label: Pt; vertical?: boolean; delay?: number }) {
  const d = `M${a.x} ${a.y}${vertical ? `V${b.y}` : `H${b.x}`}`;
  return (
    <g>
      <path d={d} className="fd-buy-track" />
      <path d={d} className="fd-buy" markerEnd={`url(#fd-buy-${id})`} />
      {[0, 1.1].map((o) => <path key={o} d={d} pathLength={100} className="fd-mote illus-mote" filter={`url(#${g}-glow)`} style={{ animationDelay: `${delay + o}s` } as CSSProperties} />)}
      <text x={label.x} y={label.y} textAnchor={vertical ? "start" : "middle"} className="fd-t lime">buys</text>
    </g>
  );
}

/// A coin as a ringed node with its ticker inside, lit by the kit's halo of its depth colour.
function Node({ x, y, r, label, tone, g }: { x: number; y: number; r: number; label: string; tone: "sol" | "root" | "child"; g: string }) {
  const halo = tone === "root" ? "lime" : tone === "child" ? "teal" : "ink";
  return (
    <g className={`fd-node ${tone}`}>
      <circle cx={x} cy={y} r={r * 2.2} className="fd-halo" fill={`url(#${g}-${halo})`} />
      <circle cx={x} cy={y} r={r} className="fd-ring" filter={tone === "sol" ? undefined : `url(#${g}-glow)`} />
      <text x={x} y={y + 5} textAnchor="middle" className="fd-t fd-label">{label}</text>
    </g>
  );
}

function Wide({ maxDepth }: { maxDepth: number }) {
  const g = useIllusId();
  const ref = useTextScale(760);
  const y = 150, r = 38;
  const sol = 86, root = 300, child = 514, next = 690;
  const mid = (root + child) / 2;
  return (
    <svg ref={ref} className="fd-wide" viewBox="0 0 760 272" role="img" aria-label={ARIA}>
      <Defs id="w" />
      <IllusDefs id={g} />
      <IllusScope id={g}>
      <Buy id="w" g={g} a={{ x: sol + r + 6, y }} b={{ x: root - r - 8, y }} label={{ x: (sol + root) / 2, y: y - 14 }} />
      <Buy id="w" g={g} delay={1.4} a={{ x: root + r + 6, y }} b={{ x: child - r - 8, y }} label={{ x: (root + child) / 2, y: y - 14 }} />
      {/* one coin deeper, dashed: the chain can continue up to the cap */}
      <path d={`M${child + r + 6} ${y}H${next - 26}`} className="fd-next-line" />
      <circle cx={next} cy={y} r={22} className="fd-next" />
      <text x={next} y={y + 5} textAnchor="middle" className="fd-t violet">d{Math.min(2, maxDepth)}</text>
      <text x={next} y={y + 46} textAnchor="middle" className="fd-t dim">and so on,</text>
      <text x={next} y={y + 64} textAnchor="middle" className="fd-t dim">up to depth {maxDepth}</text>
      {/* creator fees: one callout, two arcs */}
      <rect x={mid - 150} y={14} width={300} height={48} rx={24} className="fd-callout" />
      <text x={mid} y={35} textAnchor="middle" className="fd-t violet">creator fee · split at launch</text>
      <text x={mid} y={53} textAnchor="middle" className="fd-t dim">written on-chain, never changes</text>
      <path d={`M${root + 10} ${y - r - 4} Q${root + 40} 92 ${root + 78} 66`} className="fd-fee" markerEnd="url(#fd-fee-w)" />
      <path d={`M${root + 10} ${y - r - 4} Q${root + 40} 92 ${root + 78} 66`} pathLength={100} className="fd-mote fee illus-mote" filter={`url(#${g}-glow)`} style={{ animationDelay: "2s", animationDuration: "4.2s" }} />
      <text x={root - 6} y={100} textAnchor="end" className="fd-t violet">in SOL</text>
      <path d={`M${child - 10} ${y - r - 4} Q${child - 40} 92 ${child - 78} 66`} className="fd-fee" markerEnd="url(#fd-fee-w)" />
      <path d={`M${child - 10} ${y - r - 4} Q${child - 40} 92 ${child - 78} 66`} pathLength={100} className="fd-mote fee illus-mote" filter={`url(#${g}-glow)`} style={{ animationDelay: "3.4s", animationDuration: "4.2s" }} />
      <text x={child + 6} y={100} textAnchor="start" className="fd-t violet">in $ROOT</text>
      {/* root tokens held under the child */}
      <path d={`M${child - 40} ${y + r + 36} v8 h80 v-8`} className="fd-lock" />
      <text x={child} y={y + r + 66} textAnchor="middle" className="fd-t teal">$ROOT locked in the curve</text>
      <Node g={g} x={sol} y={y} r={r} label="SOL" tone="sol" />
      <Node g={g} x={root} y={y} r={r} label="$ROOT" tone="root" />
      <Node g={g} x={child} y={y} r={r} label="$CHILD" tone="child" />
      <text x={sol} y={y + r + 22} textAnchor="middle" className="fd-t dim">your wallet</text>
      <text x={root} y={y + r + 22} textAnchor="middle" className="fd-t dim">d0 · bought with SOL</text>
      <text x={child} y={y + r + 22} textAnchor="middle" className="fd-t dim">d1 · priced in $ROOT</text>
      </IllusScope>
    </svg>
  );
}

function Tall({ maxDepth }: { maxDepth: number }) {
  const g = useIllusId();
  const ref = useTextScale(340);
  const x = 96, r = 34;
  const sol = 52, root = 214, child = 380;
  const box = { x: 198, y: 266, w: 136, h: 78 };
  return (
    <svg ref={ref} className="fd-tall" viewBox="0 0 340 520" role="img" aria-label={ARIA}>
      <Defs id="t" />
      <IllusDefs id={g} />
      <IllusScope id={g}>
      <Buy id="t" g={g} vertical a={{ x, y: sol + 30 + 6 }} b={{ x, y: root - r - 8 }} label={{ x: x + 12, y: (sol + root) / 2 + 4 }} />
      <Buy id="t" g={g} vertical delay={1.4} a={{ x, y: root + r + 30 }} b={{ x, y: child - r - 8 }} label={{ x: x + 12, y: (root + child) / 2 + 18 }} />
      {/* creator fees on the right */}
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={16} className="fd-callout" />
      <text x={box.x + box.w / 2} y={box.y + 24} textAnchor="middle" className="fd-t violet">creator fee</text>
      <text x={box.x + box.w / 2} y={box.y + 43} textAnchor="middle" className="fd-t violet">split at launch</text>
      <text x={box.x + box.w / 2} y={box.y + 62} textAnchor="middle" className="fd-t dim">never changes</text>
      <path d={`M${x + r + 4} ${root - 8} Q${box.x + 40} ${root - 4} ${box.x + box.w / 2} ${box.y - 6}`} className="fd-fee" markerEnd="url(#fd-fee-t)" />
      <text x={box.x + box.w / 2 + 8} y={root - 16} textAnchor="middle" className="fd-t violet">in SOL</text>
      <path d={`M${x + r + 4} ${child + 8} Q${box.x + 40} ${child + 6} ${box.x + box.w / 2} ${box.y + box.h + 6}`} className="fd-fee" markerEnd="url(#fd-fee-t)" />
      <text x={box.x + box.w / 2 + 8} y={child + 34} textAnchor="middle" className="fd-t violet">in $ROOT</text>
      <Node g={g} x={x} y={sol} r={30} label="SOL" tone="sol" />
      <Node g={g} x={x} y={root} r={r} label="$ROOT" tone="root" />
      <Node g={g} x={x} y={child} r={r} label="$CHILD" tone="child" />
      <text x={x + 44} y={sol + 5} textAnchor="start" className="fd-t dim">your wallet</text>
      <text x={x} y={root + r + 20} textAnchor="middle" className="fd-t dim">d0 · bought with SOL</text>
      <text x={x} y={child + r + 20} textAnchor="middle" className="fd-t dim">d1 · priced in $ROOT</text>
      <path d={`M${x - 46} ${child + r + 32} v8 h92 v-8`} className="fd-lock" />
      <text x={16} y={child + r + 62} className="fd-t teal">$ROOT locked in the curve</text>
      <path d={`M${x} ${child + r + 72}V${child + r + 92}`} className="fd-next-line" />
      <text x={x + 12} y={child + r + 92} className="fd-t dim">and so on, up to depth {maxDepth}</text>
      </IllusScope>
    </svg>
  );
}

/// Marker ids are per drawing: both drawings are in the DOM (one hidden), and ids must stay unique.
const Defs = ({ id }: { id: string }) => (
  <defs>
    <marker id={`fd-buy-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" className="fd-head-buy" /></marker>
    <marker id={`fd-fee-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" className="fd-head-fee" /></marker>
  </defs>
);

/// `lead`: an optional sentence above the drawing (Home uses it; /how has its own lead paragraph).
export default function FlowDiagram({ maxDepth, className = "", lead }: { maxDepth: number; className?: string; lead?: string }) {
  return (
    <figure className={`card flow-diagram fd ${lead ? "has-lead" : ""} ${className}`}>
      {lead && <p className="fd-lead">{lead}</p>}
      <Wide maxDepth={maxDepth} />
      <Tall maxDepth={maxDepth} />
      <figcaption className="flow-legend"><span><i />buy route (SOL in)</span><span><i className="lock" />parent tokens locked</span><span><i className="fee" />creator fee, split at launch</span></figcaption>
    </figure>
  );
}

/// The root split (creator · Spore · agent) and the child split (creator · Spore), drawn to scale
/// from the pinned policy, in the role colours the fees page uses.
export function SplitBars() {
  const slice = (cls: string, bps: number) => <i className={cls} style={{ flexGrow: bps } as CSSProperties} />;
  return (
    <div className="hw-split" aria-hidden="true">
      <span>root</span><span className="split-bar">{slice("creator", ROOT_SPLIT.creator)}{slice("spore", ROOT_SPLIT.platform)}{slice("agent", ROOT_SPLIT.agent)}</span>
      <span>child</span><span className="split-bar">{slice("creator", SPLIT_BPS[0])}{slice("spore", SPLIT_BPS[3])}</span>
      <span className="hw-split-key"><i className="creator" />you<i className="spore" />Spore<i className="agent" />agent</span>
    </div>
  );
}
