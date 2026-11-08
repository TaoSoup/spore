// The coin's family as concentric orbits (DESIGN-ELEVATE §8): the family top in the centre, its
// children on the first ring, grandchildren on the second, each node sized by the value its own
// children lock (log scale), the larger ones carrying their logo. Hover or focus names a node and its
// value; a click or Enter opens its page. Built with d3.hierarchy + d3.tree into SVG; the entry is CSS
// (rings draw, filaments grow, nodes bloom outward ring by ring), so reduced motion shows it at rest.
import { useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { hierarchy, tree as d3tree, type HierarchyPointNode } from "d3";
import { api, type Coin, type TreeNode } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { count, usdCard } from "../../lib/format";
import { ErrorBox, Skeleton, nameOf, sym } from "../Bits";
import { IllusDefs, IllusScope, TONES, type Tone } from "../illus/base";

/// The ring holds at most this many children (largest first) and each child this many of its own;
/// the coin being viewed is always kept, and what is left out is counted on the ring.
const MAX_KIDS = 28, MAX_GRAND = 6;
const S = 560, R1 = 150, R2 = 248;
const toneOf = (depth: number): Tone => (depth <= 0 ? "lime" : depth === 1 ? "teal" : depth === 2 ? "violet" : "agent");
const weight = (c: Coin) => (c.lockedUsd ?? 0) || 0;

type Leaf = { coin: Coin; children: Leaf[]; more?: number };

/// Which coin sits in the middle: the root for depth 0–2 (so a child sees its siblings), the
/// grandparent deeper down, so the coin itself is always on one of the two rings.
export const familyTop = (c: Coin): string => (c.depth === 0 ? c.mint : c.depth <= 2 ? (c.root?.mint ?? c.ancestors[c.ancestors.length - 1]?.mint ?? c.mint) : (c.ancestors[1]?.mint ?? c.mint));

/// `limits[0]` caps this node's children, `limits[1]` theirs, and so on (none past the list).
function trim(node: TreeNode, self: string, limits: number[]): Leaf {
  const limit = limits[0] ?? 0;
  const kids = [...node.children].sort((a, b) => weight(b.coin) - weight(a.coin) || (b.coin.mcapUsd ?? 0) - (a.coin.mcapUsd ?? 0));
  let keep = kids.slice(0, limit);
  const holds = (n: TreeNode): boolean => n.coin.mint === self || n.children.some(holds);
  const mine = kids.find(holds);
  if (mine && !keep.includes(mine)) keep = [...keep.slice(0, limit - 1), mine];
  return { coin: node.coin, children: keep.map((k) => trim(k, self, limits.slice(1))), more: Math.max(0, node.children.length - keep.length) };
}

export default function RadialTree({ coin }: { coin: Coin }) {
  const top = familyTop(coin);
  const data = useAsync(() => api.tree(top, 2), [top]);
  const navigate = useNavigate();
  const [hot, setHot] = useState<string | null>(null);
  const id = `rt${coin.mint.slice(0, 6).replace(/[^a-zA-Z0-9]/g, "")}`;

  const laid = useMemo(() => {
    if (!data.data) return null;
    const leaf = trim(data.data, coin.mint, [MAX_KIDS, MAX_GRAND]);
    const root = hierarchy<Leaf>(leaf, (d) => d.children);
    const layout = d3tree<Leaf>().size([2 * Math.PI, 1]).separation((a, b) => (a.parent === b.parent ? 1 : 1.6) / Math.max(1, a.depth));
    const pts = layout(root).descendants();
    const maxW = Math.max(1, ...pts.slice(1).map((p) => weight(p.data.coin)));
    const radius = (p: HierarchyPointNode<Leaf>) => {
      if (p.depth === 0) return 30;
      const base = p.depth === 1 ? 9 : 3.5;
      const span = p.depth === 1 ? 12 : 6;
      return base + span * (Math.log10(1 + weight(p.data.coin)) / Math.log10(1 + maxW));
    };
    const xy = (p: HierarchyPointNode<Leaf>) => {
      const r = p.depth === 0 ? 0 : p.depth === 1 ? R1 : R2;
      const a = p.x - Math.PI / 2;
      return [r * Math.cos(a), r * Math.sin(a)] as const;
    };
    const nodes = pts.map((p, i) => { const [x, y] = xy(p); return { p, x, y, r: radius(p), i }; });
    const byNode = new Map(nodes.map((n) => [n.p, n]));
    const links = nodes.filter((n) => n.p.parent).map((n) => {
      const a = byNode.get(n.p.parent!)!;
      // a filament that leaves the parent radially and bows into the child
      const mx = (a.x + n.x) / 2, my = (a.y + n.y) / 2;
      const k = n.p.depth === 1 ? 0.12 : 0.3;
      const d = `M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${(mx - (n.y - a.y) * k).toFixed(1)} ${(my + (n.x - a.x) * k).toFixed(1)} ${n.x.toFixed(1)} ${n.y.toFixed(1)}`;
      return { d, depth: n.p.depth, key: n.p.data.coin.mint, tone: toneOf(n.p.data.coin.depth), i: n.i };
    });
    // Labels for the few largest children (and the coin itself), set radially outside the ring.
    const ranked = nodes.filter((n) => n.p.depth === 1).sort((a, b) => weight(b.p.data.coin) - weight(a.p.data.coin) || (b.p.data.coin.mcapUsd ?? 0) - (a.p.data.coin.mcapUsd ?? 0));
    const labelled = new Set(ranked.slice(0, ranked.length > 14 ? 5 : 8).map((n) => n.p.data.coin.mint));
    labelled.add(coin.mint);
    return { nodes, links, more: leaf.more ?? 0, shownKids: leaf.children.length, labelled };
  }, [data.data, coin.mint]);

  if (data.loading && !data.data) return <div className="rtree is-loading" aria-busy="true"><Skeleton h={420} r={16} /></div>;
  if (data.error && !data.data) return <ErrorBox compact error={data.error} retry={data.reload} />;
  if (!laid) return null;
  const hotNode = hot ? laid.nodes.find((n) => n.p.data.coin.mint === hot) ?? null : null;
  const topCoin = laid.nodes[0].p.data.coin;
  const kids = laid.nodes.filter((n) => n.p.depth === 1).length, grand = laid.nodes.filter((n) => n.p.depth === 2).length;
  const open = (m: string) => { if (m !== coin.mint) navigate(`/c/${m}`); };
  const onKey = (e: ReactKeyboardEvent, m: string) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(m); } };
  const label = `Family of ${sym(topCoin)}: ${count(kids)} ${kids === 1 ? "child" : "children"}${grand ? ` and ${count(grand)} grandchildren` : ""} shown${laid.more ? `, ${count(laid.more)} more children not drawn` : ""}`;

  return (
    <div className="rtree">
      <svg className="rtree-svg" viewBox={`${-S / 2} ${-S / 2} ${S} ${S}`} role="group" aria-label={label}>
        <IllusDefs id={id} />
        <IllusScope id={id}>
          <defs>
            <radialGradient id={`${id}-void`}><stop offset="0" stopColor="rgba(182,255,92,.07)" /><stop offset=".6" stopColor="rgba(92,224,200,.025)" /><stop offset="1" stopColor="rgba(0,0,0,0)" /></radialGradient>
            {laid.nodes.filter((n) => n.p.depth <= 1 && n.r >= 8 && n.p.data.coin.image).map((n) => <clipPath key={n.p.data.coin.mint} id={`${id}-c-${n.i}`}><circle cx={n.x} cy={n.y} r={n.r - 1.5} /></clipPath>)}
          </defs>
          <circle r={S / 2} fill={`url(#${id}-void)`} />
          <circle className="rt-orbit" r={R1} style={{ "--i": 0 } as CSSProperties} pathLength={100} />
          {grand > 0 && <circle className="rt-orbit outer" r={R2} style={{ "--i": 1 } as CSSProperties} pathLength={100} />}
          <g className="rt-links">
            {laid.links.map((l) => (
              <path key={l.key} d={l.d} pathLength={100} className={`rt-link d${l.depth} ${hot && hot === l.key ? "hot" : ""}`} stroke={`rgb(${TONES[l.tone].rgb})`} style={{ "--i": l.i } as CSSProperties} />
            ))}
          </g>
          <g className="rt-nodes">
            {laid.nodes.map((n) => {
              const c = n.p.data.coin;
              const tone = toneOf(c.depth);
              const self = c.mint === coin.mint;
              const logo = n.p.depth <= 1 && n.r >= 8 && c.image;
              const a = Math.atan2(n.y, n.x);
              const lr = Math.hypot(n.x, n.y) + n.r + 8;
              const lx = Math.cos(a) * lr, ly = Math.sin(a) * lr;
              const showLabel = n.p.depth > 0 && laid.labelled.has(c.mint);
              const value = c.lockedUsd ? `${usdCard(c.lockedUsd)} locked` : c.mcapUsd ? `MC ${usdCard(c.mcapUsd)}` : "nothing locked yet";
              return (
                <g key={c.mint} className={`rt-node d${n.p.depth} ${self ? "self" : ""}`} style={{ "--i": n.i, "--ox": `${n.x}px`, "--oy": `${n.y}px` } as CSSProperties}
                  role="link" tabIndex={self ? -1 : 0} aria-label={`${nameOf(c)} ${sym(c)}, ${value}${self ? ", this coin" : ""}`}
                  onMouseEnter={() => setHot(c.mint)} onMouseLeave={() => setHot((h) => (h === c.mint ? null : h))} onFocus={() => setHot(c.mint)} onBlur={() => setHot((h) => (h === c.mint ? null : h))}
                  onClick={() => open(c.mint)} onKeyDown={(e) => onKey(e, c.mint)}>
                  <circle className="rt-halo" cx={n.x} cy={n.y} r={n.r * 2.6} fill={`url(#${id}-${tone})`} />
                  <circle cx={n.x} cy={n.y} r={n.r} fill={`url(#${id}-${tone}-core)`} filter={n.p.depth === 2 ? undefined : `url(#${id}-glow)`} className="rt-disc" />
                  {logo && <image href={c.image!} x={n.x - n.r} y={n.y - n.r} width={n.r * 2} height={n.r * 2} clipPath={`url(#${id}-c-${n.i})`} preserveAspectRatio="xMidYMid slice" />}
                  <circle cx={n.x} cy={n.y} r={n.r} fill="none" stroke={`rgba(${TONES[tone].rgb},.9)`} strokeWidth={self ? 2 : 1} className="rt-rim" />
                  {self && <circle cx={n.x} cy={n.y} r={n.r + 6} fill="none" stroke={TONES[tone].c} strokeWidth="1" strokeDasharray="2 4" className="rt-self" />}
                  {n.p.depth === 0 && <text x={n.x} y={n.y + n.r + 16} textAnchor="middle" className="rt-label">{sym(c)}</text>}
                  {showLabel && (
                    <text x={lx} y={ly} dy=".35em" textAnchor={Math.abs(lx) < 12 ? "middle" : lx > 0 ? "start" : "end"} className={`rt-label ${self ? "self" : ""}`}>{sym(c)}</text>
                  )}
                </g>
              );
            })}
          </g>
          {laid.more > 0 && <text x={0} y={S / 2 - 12} textAnchor="middle" className="rt-more">+{count(laid.more)} more on this ring</text>}
        </IllusScope>
      </svg>
      {hotNode && (
        <div className="rt-tip" style={{ left: `${((hotNode.x + S / 2) / S) * 100}%`, top: `${((hotNode.y - hotNode.r + S / 2) / S) * 100}%` }} aria-hidden="true">
          <b>{nameOf(hotNode.p.data.coin)}</b> <span className="mono">{sym(hotNode.p.data.coin)}</span>
          <small className="mono">{hotNode.p.data.coin.lockedUsd ? `${usdCard(hotNode.p.data.coin.lockedUsd)} locked` : "nothing locked"} · MC {usdCard(hotNode.p.data.coin.mcapUsd)}</small>
        </div>
      )}
      <ul className="rt-key" aria-hidden="true">
        <li><i className="k-root" />{topCoin.depth === 0 ? "root" : `d${topCoin.depth}`} in the middle</li>
        <li><i className="k-kid" />children</li>
        {grand > 0 && <li><i className="k-grand" />grandchildren</li>}
        <li><i className="k-size" />size = value its children lock</li>
      </ul>
    </div>
  );
}
