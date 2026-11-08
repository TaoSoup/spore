// The /agents hero drawing (DESIGN-ELEVATE §6): a root with its agent in orbit and the coins the agent
// launched budding off it. The root is a locked lime node; the agent is an orange mote on a tilted
// orbit that dims as it passes behind the root; children are teal nodes on filaments, grandchildren
// violet; fees travel the filaments inward as lime motes and a new coin buds out along a dashed one.
// Motion is CSS (filaments, halos, motes) plus one SMIL path for the orbit, which is paused together
// with everything else under reduced or paused motion.
import { useEffect, useRef } from "react";
import { useMotionPref } from "../../lib/motion";
import { Filament, Illus, Motes, Node, Ring, curve } from "../illus/base";

const CX = 240, CY = 192;
/// The tilted orbit as a path (front half first), so the agent can travel it.
const ORBIT = (() => {
  const rx = 92, ry = 30, rot = (-16 * Math.PI) / 180, pts: string[] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2, x = rx * Math.cos(a), y = ry * Math.sin(a);
    pts.push(`${(CX + x * Math.cos(rot) - y * Math.sin(rot)).toFixed(2)} ${(CY + x * Math.sin(rot) + y * Math.cos(rot)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
})();
const KIDS: { x: number; y: number; r: number; mote?: boolean; fee?: boolean; dashed?: boolean; bend: number }[] = [
  { x: 96, y: 96, r: 13, mote: true, bend: 0.16 },
  { x: 384, y: 84, r: 11, fee: true, bend: -0.18 },
  { x: 420, y: 238, r: 15, mote: true, bend: 0.12 },
  { x: 330, y: 330, r: 10, fee: true, bend: -0.2 },
  { x: 126, y: 312, r: 12, bend: 0.2 },
  { x: 54, y: 214, r: 8, dashed: true, bend: -0.14 },
];
const GRAND: { from: number; x: number; y: number }[] = [
  { from: 0, x: 48, y: 48 }, { from: 0, x: 142, y: 40 }, { from: 2, x: 462, y: 300 }, { from: 2, x: 456, y: 180 }, { from: 4, x: 84, y: 360 },
];

export default function AgentsHeroArt() {
  const ref = useRef<SVGSVGElement | null>(null);
  const [paused] = useMotionPref();
  useEffect(() => {
    const svg = ref.current;
    if (!svg || typeof svg.pauseAnimations !== "function") return;
    if (paused) { svg.pauseAnimations(); svg.setCurrentTime(2.6); } else svg.unpauseAnimations();
  }, [paused]);
  return (
    <figure className="agents-art" aria-hidden="true">
      <div className="agents-art-stage">
        <Illus viewBox="0 0 480 384" className="agents-art-svg" ref={ref}>
          <Motes seed={7} n={38} box={[0, 0, 480, 384]} tone={["lime", "teal", "violet"]} rMax={1.4} />
          <Ring cx={CX} cy={CY} r={150} tone="teal" dashed spin opacity={0.18} />
          <Ring cx={CX} cy={CY} r={186} tone="violet" opacity={0.1} />
          {GRAND.map((g, i) => <Filament key={`g${i}`} d={curve(KIDS[g.from].x, KIDS[g.from].y, g.x, g.y, 0.2)} tone="violet" width={0.75} opacity={0.45} />)}
          {KIDS.map((k, i) => <Filament key={`k${i}`} d={k.fee ? curve(k.x, k.y, CX, CY, -k.bend) : curve(CX, CY, k.x, k.y, k.bend)} tone={k.fee ? "lime" : "teal"} dashed={k.dashed} mote={k.mote || k.fee} dur={k.fee ? 3.6 : 4.4} delay={i * 0.7} opacity={k.dashed ? 0.5 : 0.55} />)}
          {GRAND.map((g, i) => <Node key={`gn${i}`} cx={g.x} cy={g.y} r={3.5} tone="violet" />)}
          {KIDS.map((k, i) => <Node key={`kn${i}`} cx={k.x} cy={k.y} r={k.r} tone="teal" dim={k.dashed} />)}
          {/* the orbit: back half under the root, front half over it */}
          <path className="agents-art-orbit back" d={ORBIT} pathLength={100} strokeDasharray="50 50" strokeDashoffset={-50} />
          <Node cx={CX} cy={CY} r={30} tone="lime" lock pulse />
          <path className="agents-art-orbit front" d={ORBIT} pathLength={100} strokeDasharray="50 50" />
          <g className="agents-art-agent">
            <circle r={13} className="agents-art-agent-halo" />
            <circle r={5.5} className="agents-art-agent-core" />
            <animateMotion dur="11s" repeatCount="indefinite" rotate="0" begin="0s"><mpath href="#agents-art-orbit-path" /></animateMotion>
            <animate attributeName="opacity" dur="11s" repeatCount="indefinite" values="1;1;.28;.28;1" keyTimes="0;.46;.56;.94;1" />
          </g>
          <path id="agents-art-orbit-path" d={ORBIT} fill="none" stroke="none" />
        </Illus>
      </div>
      <figcaption className="agents-art-cap mono"><i aria-hidden="true" />the agent orbits its root · its coins bud off it</figcaption>
    </figure>
  );
}

/// The character sheet's backdrop: a faint spore cloud and two orbit rings around the sheet's upper
/// right, in the kit's language, behind the content. Static apart from the kit's twinkle.
export function SheetBackdrop() {
  return (
    <Illus viewBox="0 0 480 288" className="agent-sheet-art">
      <Ring cx={430} cy={40} r={150} tone="teal" opacity={0.14} />
      <Ring cx={430} cy={40} r={218} tone="violet" dashed opacity={0.12} />
      <Filament d={curve(250, 250, 470, 20, 0.22)} tone="teal" width={0.75} opacity={0.22} mote dur={7} delay={1.5} />
      <Motes seed={23} n={34} box={[180, 0, 300, 240]} tone={["lime", "teal", "violet"]} rMax={1.3} />
    </Illus>
  );
}
