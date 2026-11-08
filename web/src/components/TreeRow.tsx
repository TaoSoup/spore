// One root of a family tree as a row: rank, the root's logo inside a mini orbit of its family, name, the
// numbers, a bar measured against the board's leader (with its value inside) and two actions (see it on
// the map, launch under it). Shared by Explore's Trees board and Home's "Biggest trees" so both read the
// same (owned by the lists lane). The name is a stretched link that covers the row; the quote pill, the
// agent chip and the two actions stay their own targets.
import { useMemo, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { Coin } from "../lib/api";
import { count, usdCard } from "../lib/format";
import { agentProvenance, useAgentIndex } from "../lib/agent-index";
import LaunchButton from "./LaunchButton";
import { AgentChip, Logo, nameOf, sym, useTint } from "./Bits";
import "./discover.css";

export type TreeMetric = "locked" | "children" | "volume" | "new";
/// The value the bar is scaled by, so the bar always matches the ranking.
export const treeMetricValue = (c: Coin, m: TreeMetric): number =>
  m === "children" ? c.descendants : m === "volume" ? c.volume24hUsd : m === "new" ? (c.createdAt ?? 0) : (c.lockedUsd ?? 0);

type Props = { coin: Coin; rank: number; maxDepth: number | undefined; metric?: TreeMetric; /** the largest metric value on the board */ top?: number };

const zero = (n: number | null | undefined) => !n;
const KIDS = 12, GRAND = 18;

/// The family as a mini orbit around the root's logo (drawn in the illustration language): one teal mote
/// per child on the inner ring, one violet mote per grandchild on the outer ring, capped at 12 and 18.
/// A root with nothing below it gets a dashed, pending ring. The group turns slowly while the row is hovered.
export function TreeOrbit({ kids, below }: { kids: number; below: number }) {
  const g = useMemo(() => {
    const n1 = Math.min(kids, KIDS), n2 = Math.min(Math.max(0, below - kids), GRAND);
    const at = (i: number, n: number, r: number, off: number) => {
      const a = (-90 + off + (360 / Math.max(1, n)) * i) * (Math.PI / 180);
      return [32 + r * Math.cos(a), 32 + r * Math.sin(a)] as const;
    };
    return {
      kids: Array.from({ length: n1 }, (_, i) => at(i, n1, 26.5, 0)),
      grand: Array.from({ length: n2 }, (_, i) => at(i, n2, 30.75, 180 / Math.max(1, n2))),
    };
  }, [kids, below]);
  const empty = g.kids.length === 0;
  return (
    <svg className="tree-orbit" viewBox="0 0 64 64" aria-hidden="true">
      <g className="tree-orbit-g">
        <circle className={`to-ring k ${empty ? "pending" : ""}`} cx="32" cy="32" r="26.5" />
        {g.grand.length > 0 && <circle className="to-ring g" cx="32" cy="32" r="30.75" />}
        {g.grand.map(([x, y], i) => <circle key={`g${i}`} className="to-mote g" cx={x} cy={y} r="1.3" />)}
        {g.kids.map(([x, y], i) => <circle key={`k${i}`} className="to-mote k" cx={x} cy={y} r="2.1" />)}
      </g>
    </svg>
  );
}

export default function TreeRow({ coin: c, rank, maxDepth, metric = "locked", top }: Props) {
  const [tint, onImg] = useTint(c.image, c.mint);
  const prov = agentProvenance(c, useAgentIndex());
  const value = treeMetricValue(c, metric);
  const share = metric === "new" || !top ? 0 : Math.min(1, value / Math.max(top, 1e-9));
  const w = share > 0 ? Math.max(2, share * 100) : 0;
  const below = `${count(c.descendants)} coin${c.descendants === 1 ? "" : "s"} below`;
  const lockedLive = (c.lockedUsd ?? 0) >= 0.01;
  // The ranking metric is drawn as the bar with its value inside, so the meta line leaves it out.
  const inBar = (m: TreeMetric) => metric === m && w > 0;
  const barLabel = metric === "children" ? <><b>{count(c.descendants)}</b> below</> : metric === "volume" ? <>vol <b>{usdCard(c.volume24hUsd)}</b></> : <>locked <b>{usdCard(c.lockedUsd)}</b></>;
  const barZero = metric === "children" ? zero(c.descendants) : metric === "volume" ? zero(c.volume24hUsd) : !lockedLive;
  return (
    <div className={`tree-row ${rank <= 3 ? "top" : ""} ${rank === 1 ? "first" : ""}`} style={{ "--tint": tint, "--rank": rank } as CSSProperties}>
      <span className="tree-rank" aria-label={`rank ${rank}`}><span aria-hidden="true">{String(rank).padStart(2, "0")}</span></span>
      <span className="tree-orb">
        <TreeOrbit kids={c.children} below={c.descendants} />
        <Logo src={c.image} label={c.symbol} size={40} className="ring" onLoad={onImg} />
      </span>
      <div className="tree-body">
        <div className="tree-name">
          <b><Link to={`/c/${c.mint}`} className="tree-row-link stretch-link" title={nameOf(c)}>{nameOf(c)}</Link></b>
          <span className="tree-sym">{sym(c)}</span>
          <span className="qpill" title={`${sym(c)} is priced in ${c.quoteSymbol}`}>{c.quoteSymbol}</span>
          <AgentChip prov={prov} />
        </div>
        <div className="tree-meta">
          {!inBar("children") && <span className={`tree-nums ${zero(c.descendants) ? "is-zero" : ""} ${metric === "children" ? "on" : ""}`}>{below}</span>}
          {!inBar("locked") && <span className={`tree-nums wide ${metric === "locked" ? "on" : ""}`}>locked <b className={lockedLive ? "accent" : "is-zero"}>{usdCard(c.lockedUsd)}</b></span>}
          {!inBar("volume") && <span className={`tree-nums ${metric === "volume" ? "on" : ""}`}>vol <b className={zero(c.volume24hUsd) ? "is-zero" : ""}>{usdCard(c.volume24hUsd)}</b></span>}
          <span className="tree-nums wide">mcap <b className={zero(c.mcapUsd) ? "is-zero" : ""}>{usdCard(c.mcapUsd)}</b></span>
        </div>
        {w > 0 && (
          <div className={`tree-bar ${barZero ? "is-zero" : ""}`} title={`${Math.round(share * 100)}% of the leader`}>
            <i aria-hidden="true" style={{ "--w": `${w}%` } as CSSProperties} />
            <span className="tree-bar-v">{barLabel}</span>
          </div>
        )}
      </div>
      <b className={`tree-mc ${zero(c.mcapUsd) ? "is-zero" : ""}`} title="Market cap">{usdCard(c.mcapUsd)}</b>
      <div className="tree-actions">
        <Link to={`/map?focus=${c.mint}`} className="btn sm ghost tree-map" title={`See ${sym(c)}'s tree on the map`}>Map</Link>
        <LaunchButton coin={c} maxDepth={maxDepth} size="sm" variant="soft" label="Launch under" className="tree-launch" />
        <LaunchButton coin={c} maxDepth={maxDepth} size="sm" variant="icon" className="tree-launch-icon" />
      </div>
    </div>
  );
}

/// The loading state of a TreeRow (same blocks, same height).
export function TreeRowSkeleton() {
  return (
    <div className="tree-row sk-row" aria-hidden="true">
      <span className="tree-rank"><span className="sk" style={{ width: 24, height: 20, borderRadius: 6 }} /></span>
      <span className="tree-orb"><span className="sk" style={{ width: 40, height: 40, borderRadius: 20 }} /></span>
      <div className="tree-body"><span className="sk" style={{ width: "38%", height: 15 }} /><span className="sk" style={{ width: "62%", height: 12 }} /></div>
      <span className="tree-mc"><span className="sk" style={{ width: 56, height: 14 }} /></span>
      <div className="tree-actions"><span className="sk" style={{ width: 150, height: 32, borderRadius: 16 }} /></div>
    </div>
  );
}
