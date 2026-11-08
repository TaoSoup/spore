// The colony drawn in SVG (DESIGN-ELEVATE §6–7): what renders before the 3D chunk arrives, and instead of
// it without WebGL2, under reduced or paused motion, or after a GPU failure. The same data as the scene:
// the root (with its logo) at the centre, its children as teal nodes on a tilted orbit, grandchildren as
// violet motes beyond them, and a spore cloud. Still; only the kit's CSS motes move, and they stop with
// the site's motion rules.
import { useMemo } from "react";
import { Filament, Illus, Motes, Node, Ring, STROKE, TONES, curve, useIllusId } from "../illus/base";
import type { ColonyData } from "./colony";

const W = 720, H = 600, CX = 360, CY = 300, RX = 226, RY = 82;

/// Angles at equal steps of the orbit's drawn length (the 3D scene spaces its children the same way), so
/// neighbours never crowd where the tilted ring turns at its sides.
const ARC = (() => {
  const N = 360, cum = [0];
  for (let i = 1; i <= N; i++) { const a0 = ((i - 1) / N) * Math.PI * 2, a1 = (i / N) * Math.PI * 2; cum.push(cum[i - 1] + Math.hypot(RX * (Math.cos(a1) - Math.cos(a0)), RY * (Math.sin(a1) - Math.sin(a0)))); }
  return (u: number) => { const want = (u - Math.floor(u)) * cum[N]; let j = 0; while (j < N - 1 && cum[j + 1] < want) j++; return ((j + (want - cum[j]) / (cum[j + 1] - cum[j] || 1)) / N) * Math.PI * 2; };
})();

type Placed = { mint: string; label: string; image: string | null; x: number; y: number; r: number; front: boolean; grand: { x: number; y: number }[] };

function place(d: ColonyData | null): Placed[] {
  const list: ColonyData["kids"] = d ? d.kids.slice(0, 12) : Array.from({ length: 8 }, (_, i) => ({ mint: `p${i}`, label: "", weight: 1, grand: [] as string[] }));
  const ws = list.map((k) => Math.log1p(Math.max(0, k.weight)));
  const lo = Math.min(...ws), hi = Math.max(...ws);
  return list.map((k, i) => {
    const a = ARC(i / list.length + 0.06);
    const depth = Math.sin(a); // > 0: in front of the root
    const x = CX + Math.cos(a) * RX, y = CY + depth * RY - 6;
    const r = (hi > lo ? 8 + ((ws[i] - lo) / (hi - lo)) * 10 : 12.5) * (0.82 + 0.18 * (depth + 1) / 2);
    const ux = Math.cos(a), uy = depth * 0.45, ul = Math.hypot(ux, uy) || 1;
    const grand = k.grand.slice(0, 3).map((_, j) => {
      const t = [0, -0.55, 0.55][j], c = Math.cos(t), s = Math.sin(t), dd = r + 16;
      return { x: x + ((ux * c - uy * s) / ul) * dd, y: y + ((ux * s + uy * c) / ul) * dd };
    });
    return { mint: k.mint, label: k.label, image: k.image ?? null, x, y, r, front: depth > 0.05, grand };
  });
}

export default function ColonyFallback({ data, className = "" }: { data: ColonyData | null; className?: string }) {
  const kids = useMemo(() => place(data), [data]);
  const cid = useIllusId();
  // a few tickers, on the larger children in front and away from the headline's side
  const labelled = useMemo(() => new Set([...kids].filter((k) => k.label && k.front && k.x > CX - RX * 0.7).sort((a, b) => b.r - a.r).slice(0, 4).map((k) => k.mint)), [kids]);
  const back = kids.filter((k) => !k.front), front = kids.filter((k) => k.front);
  const kid = (k: Placed) => (
    <g key={k.mint} className="cf-kid">
      {k.grand.map((g, j) => <Filament key={`f${j}`} d={curve(k.x, k.y, g.x, g.y, 0.12)} tone="violet" width={STROKE.hair} opacity={0.5} />)}
      {k.grand.map((g, j) => <Node key={`g${j}`} cx={g.x} cy={g.y} r={3} tone="violet" />)}
      {/* a glass bead: dark body, luminous rim, a soft light inside (the 3D children, drawn) */}
      <circle cx={k.x} cy={k.y} r={k.r * 1.8} fill={`rgba(${TONES.teal.rgb},.045)`} />
      <circle cx={k.x} cy={k.y} r={k.r} fill="rgba(4,17,10,.88)" stroke={`rgba(${TONES.teal.rgb},${data ? 0.85 : 0.4})`} strokeWidth={STROKE.thin} strokeDasharray={data ? undefined : "2 3"} />
      {data && k.image
        ? <><clipPath id={`${cid}-${k.mint}`}><circle cx={k.x} cy={k.y} r={k.r - 1.5} /></clipPath><image href={k.image} x={k.x - k.r} y={k.y - k.r} width={k.r * 2} height={k.r * 2} clipPath={`url(#${cid}-${k.mint})`} preserveAspectRatio="xMidYMid slice" opacity=".8" /></>
        : data && <Node cx={k.x - k.r * 0.25} cy={k.y - k.r * 0.25} r={k.r * 0.28} tone="teal" halo={false} />}
      {labelled.has(k.mint) && <text x={k.x} y={k.y + k.r + 20} textAnchor="middle" className="cf-label">{k.label}</text>}
    </g>
  );
  return (
    <Illus viewBox={`0 0 ${W} ${H}`} className={`colony-fallback ${className}`} preserveAspectRatio="xMidYMid meet">
      <Motes seed={7} n={40} box={[0, 0, W, H]} tone={["lime", "teal", "violet"]} rMax={1.6} />
      <ellipse cx={CX} cy={CY - 6} rx={RX} ry={RY} stroke={`rgb(${TONES.teal.rgb})`} strokeOpacity=".22" strokeWidth={STROKE.hair} strokeDasharray="1.5 5" />
      <Ring cx={CX} cy={CY} r={118} tone="lime" opacity={0.12} />
      {back.map((k, i) => <Filament key={`b${k.mint}`} d={curve(CX, CY, k.x, k.y, 0.1)} tone="teal" fade={false} opacity={0.32} width={STROKE.thin} mote={!!data && i % 2 === 0} dur={3.6} delay={i * 0.7} />)}
      {back.map(kid)}
      <Node cx={CX} cy={CY} r={44} tone="lime" lock={!data} />
      {data?.root.image && (
        <>
          <clipPath id={`${cid}-root`}><circle cx={CX} cy={CY} r={37} /></clipPath>
          <circle cx={CX} cy={CY} r={38} fill="#04110a" />
          <image href={data.root.image} x={CX - 37} y={CY - 37} width={74} height={74} clipPath={`url(#${cid}-root)`} preserveAspectRatio="xMidYMid slice" opacity=".9" />
          <circle cx={CX} cy={CY} r={38} stroke={`rgb(${TONES.lime.rgb})`} strokeOpacity=".9" strokeWidth={STROKE.mid} />
        </>
      )}
      {front.map((k, i) => <Filament key={`f${k.mint}`} d={curve(CX, CY, k.x, k.y, -0.1)} tone="lime" opacity={0.55} width={STROKE.thin} mote={!!data && i % 2 === 1} dur={3.2} delay={i * 0.6} />)}
      {front.map(kid)}
    </Illus>
  );
}
