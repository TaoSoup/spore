// Drawings of the front page (DESIGN-ELEVATE §6), in the kit's language: the three steps of How Spore
// works (launch a root, coins grow under it, fees split) and the agent's orbit. Decorative: the text
// next to each says the same thing, so every drawing is aria-hidden. Motion is CSS (home.css) and stops
// under reduced or paused motion.
import { ROOT_SPLIT, SPLIT_BPS } from "../../../lib/policy";
import { Filament, Illus, Motes, Node, Ring, STROKE, SplitArc, TONES, curve } from "../../illus/base";

/** Step 1: SOL from a wallet becomes a root; its agent already circles it. */
export function IllusLaunch() {
  return (
    <Illus viewBox="0 0 240 144" className="hw-illus">
      <path d="M12 124H228" stroke={`rgb(${TONES.ink.rgb})`} strokeOpacity=".14" strokeWidth={STROKE.hair} strokeDasharray="1.5 4.5" />
      <Motes seed={11} n={16} box={[120, 4, 96, 36]} tone="lime" />
      <Filament d={curve(46, 112, 150, 62, -0.32)} tone="lime" mote width={STROKE.thin} opacity={0.55} dur={2.8} />
      <Node cx={46} cy={112} r={5} tone="ink" />
      <Ring cx={150} cy={62} r={32} tone="agent" dashed opacity={0.4} />
      <g className="hi-orbit" style={{ transformOrigin: "150px 62px" }}><Node cx={182} cy={62} r={3.5} tone="agent" /></g>
      <Node cx={150} cy={62} r={15} tone="lime" pulse />
    </Illus>
  );
}

/** Step 2: children grow under the root; buys travel up their filaments; grandchildren under them. */
export function IllusGrow() {
  const root = { x: 120, y: 30 };
  const kids = [{ x: 50, y: 92, r: 8 }, { x: 120, y: 102, r: 10 }, { x: 190, y: 88, r: 7 }];
  const grand = [{ x: 26, y: 128, p: 0 }, { x: 70, y: 130, p: 0 }, { x: 104, y: 136, p: 1 }, { x: 140, y: 134, p: 1 }, { x: 210, y: 124, p: 2 }];
  return (
    <Illus viewBox="0 0 240 144" className="hw-illus">
      {grand.map((g, i) => <Filament key={`gf${i}`} d={curve(g.x, g.y, kids[g.p].x, kids[g.p].y, 0.1)} tone="violet" width={STROKE.hair} opacity={0.45} />)}
      {kids.map((k, i) => <Filament key={`kf${i}`} d={curve(k.x, k.y, root.x, root.y, i === 1 ? 0 : i === 0 ? 0.14 : -0.14)} tone="teal" mote width={STROKE.thin} opacity={0.5} dur={2.6} delay={i * 0.8} />)}
      {grand.map((g, i) => <Node key={`g${i}`} cx={g.x} cy={g.y} r={2.6} tone="violet" />)}
      {kids.map((k, i) => <Node key={`k${i}`} cx={k.x} cy={k.y} r={k.r} tone="teal" />)}
      <Node cx={root.x} cy={root.y} r={13} tone="lime" lock />
    </Illus>
  );
}

/** Step 3: the two splits drawn to scale from the pinned policy (root: creator · Spore · agent; child: creator · Spore). */
export function IllusSplit() {
  return (
    <Illus viewBox="0 0 240 144" className="hw-illus">
      <Filament d={curve(84, 72, 186, 72, -0.22)} tone="teal" dashed width={STROKE.hair} opacity={0.5} />
      <Ring cx={84} cy={72} r={50} tone="lime" opacity={0.14} />
      <SplitArc cx={84} cy={72} r={40} width={3} gap={7} parts={[{ v: ROOT_SPLIT.creator, tone: "lime" }, { v: ROOT_SPLIT.platform, tone: "ink" }, { v: ROOT_SPLIT.agent, tone: "agent" }]} />
      <Node cx={84} cy={72} r={11} tone="lime" />
      <SplitArc cx={186} cy={72} r={26} width={3} gap={8} parts={[{ v: SPLIT_BPS[0], tone: "lime" }, { v: SPLIT_BPS[3], tone: "ink" }]} />
      <Node cx={186} cy={72} r={7} tone="teal" />
      <text x={84} y={136} textAnchor="middle" className="hi-t">root</text>
      <text x={186} y={136} textAnchor="middle" className="hi-t">child</text>
    </Illus>
  );
}

/** The agent: a root with its agent on an orbit, the coins it launched budding on the outer ring. */
export function AgentOrbit() {
  const c = 144;
  const buds = [{ a: -0.5, r: 6 }, { a: 1.35, r: 5 }, { a: 2.6, r: 7 }, { a: 4.1, r: 4.5 }];
  return (
    <Illus viewBox="0 0 288 288" className="ag-orbit">
      <Motes seed={23} n={34} box={[8, 8, 272, 272]} tone={["lime", "agent", "teal"]} />
      <Ring cx={c} cy={c} r={112} tone="teal" opacity={0.22} />
      <Ring cx={c} cy={c} r={74} tone="agent" dashed opacity={0.45} spin />
      {buds.map((b, i) => {
        const x = c + Math.cos(b.a) * 112, y = c + Math.sin(b.a) * 112;
        return (
          <g key={i}>
            <Filament d={curve(c, c, x, y, 0.16)} tone="teal" width={STROKE.hair} opacity={0.4} mote={i % 2 === 0} dur={3.4} delay={i} />
            <Node cx={x} cy={y} r={b.r} tone="teal" />
          </g>
        );
      })}
      <g className="hi-orbit slow" style={{ transformOrigin: `${c}px ${c}px` }}>
        <Filament d={`M${c + 74} ${c}A74 74 0 0 0 ${c + 74 * Math.cos(-0.9)} ${c + 74 * Math.sin(-0.9)}`} tone="agent" width={STROKE.mid} opacity={0.5} fade />
        <Node cx={c + 74} cy={c} r={7} tone="agent" />
      </g>
      <Node cx={c} cy={c} r={26} tone="lime" lock pulse />
    </Illus>
  );
}
