// The long-form pages' drawings (How it works, Fees & rules, API & embeds), built from the shared
// kit in components/illus/base. One per section: launch, agent, grow (the buy route and the tokens
// it locks), the fee split, depth, the trade route, the refusals, and the API's tree-to-JSON hero.
// No text inside the SVGs (captions are HTML, so they stay readable at every width); every motion
// is CSS (story.css + illus.css) and rests on a complete frame under reduced or paused motion.
import type { CSSProperties } from "react";
import { curve, Filament, Illus, Motes, Node, Ring, STROKE, TONES, type Tone } from "../../illus/base";

type P = { className?: string };

/** A launch: the wallet signs once, a root is born in SOL, its agent gets its starting gas, and
 *  the slots for its first children wait (dashed). */
export function LaunchIllus({ className = "" }: P) {
  return (
    <Illus viewBox="0 0 288 168" className={`story-illus ${className}`}>
      <Motes seed={11} n={26} box={[96, 12, 192, 144]} tone={["lime", "teal", "ink"]} />
      <Ring cx={48} cy={96} r={20} tone="ink" dashed opacity={0.35} />
      <Node cx={48} cy={96} r={8} tone="ink" />
      <Filament d={curve(58, 94, 150, 82, -0.14)} tone="lime" mote dur={2.8} />
      <Ring cx={168} cy={80} r={44} opacity={0.12} />
      <Ring cx={168} cy={80} r={30} dashed spin />
      <Node cx={168} cy={80} r={15} tone="lime" pulse />
      <Filament d={curve(178, 92, 214, 132, 0.18)} tone="agent" mote dur={3.4} delay={1.1} opacity={0.6} />
      <Node cx={218} cy={134} r={4.5} tone="agent" />
      <Filament d={curve(182, 72, 240, 36, -0.12)} tone="teal" dashed opacity={0.5} />
      <Filament d={curve(184, 82, 258, 84, 0.1)} tone="teal" dashed opacity={0.45} />
      <Node cx={242} cy={34} r={6} tone="teal" dim />
      <Node cx={262} cy={86} r={5} tone="teal" dim />
    </Illus>
  );
}

/** The agent: an orange light on its root's orbit, launching a child under it (dashed, pending)
 *  while the coins it already launched send their fees home. */
export function AgentIllus({ className = "" }: P) {
  return (
    <Illus viewBox="0 0 288 168" className={`story-illus ${className}`}>
      <Motes seed={23} n={22} box={[24, 8, 264, 152]} tone={["agent", "teal", "ink"]} />
      <Filament d={curve(130, 78, 220, 40, -0.1)} tone="teal" mote dur={3.6} opacity={0.55} />
      <Filament d={curve(132, 92, 236, 124, 0.12)} tone="teal" mote dur={4.2} delay={1.6} opacity={0.55} />
      <Filament d={curve(224, 44, 262, 26, 0.2)} tone="violet" width={STROKE.hair} opacity={0.5} />
      <Node cx={262} cy={26} r={2.5} tone="violet" />
      <Node cx={222} cy={42} r={6.5} tone="teal" />
      <Node cx={238} cy={126} r={7} tone="teal" />
      <Filament d={curve(150, 120, 196, 150, 0.2)} tone="agent" dashed opacity={0.55} />
      <Node cx={200} cy={150} r={4.5} tone="teal" dim />
      <Ring cx={120} cy={86} r={42} tone="agent" opacity={0.32} />
      <Ring cx={120} cy={86} r={62} tone="agent" dashed opacity={0.12} />
      <Node cx={120} cy={86} r={14} tone="lime" pulse />
      <g className="story-orbit" style={{ transformOrigin: "120px 86px" } as CSSProperties}>
        <Node cx={156} cy={65} r={5} tone="agent" />
      </g>
    </Illus>
  );
}

/** Why a child helps its parent: SOL buys the root, the root buys the child, and the root tokens
 *  stay parked in the child's curve, under a lock. */
export function GrowIllus({ className = "" }: P) {
  return (
    <Illus viewBox="0 0 336 168" className={`story-illus ${className}`}>
      <Motes seed={5} n={20} box={[0, 8, 336, 60]} tone={["lime", "teal"]} />
      <Node cx={36} cy={72} r={8} tone="ink" />
      <Filament d={curve(46, 72, 128, 72, -0.1)} tone="lime" mote dur={2.6} />
      <Ring cx={144} cy={72} r={26} dashed opacity={0.22} />
      <Node cx={144} cy={72} r={14} tone="lime" pulse />
      <Filament d={curve(160, 72, 250, 72, -0.1)} tone="teal" mote dur={2.6} delay={1.3} />
      <Node cx={264} cy={72} r={11} tone="teal" />
      {/* the child's curve, holding the parent tokens it bought */}
      <path d="M216 118c10 30 86 30 96 0" stroke={`rgba(${TONES.teal.rgb},.55)`} strokeWidth={STROKE.thin} strokeLinecap="round" />
      <path d="M222 118h84" stroke={`rgba(${TONES.teal.rgb},.18)`} strokeWidth={STROKE.hair} strokeDasharray="2 4" />
      <Filament d={curve(264, 84, 264, 120, 0.0)} tone="lime" dashed opacity={0.5} />
      <Motes seed={41} n={16} box={[234, 122, 60, 14]} tone="lime" rMax={1.8} />
      <Node cx={316} cy={140} r={4.5} tone="lime" lock />
      <Filament d={curve(150, 86, 214, 132, 0.22)} tone="lime" fade opacity={0.35} width={STROKE.hair} />
    </Illus>
  );
}

const pt = (cx: number, cy: number, r: number, deg: number): [number, number] => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
const arcPath = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const [x1, y1] = pt(cx, cy, r, a0), [x2, y2] = pt(cx, cy, r, a1);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};

export type ArcPart = { v: number; tone: Tone; key: string };

/**
 * The fee arc: a 270° instrument dial (open at the bottom) with one arc per shareholder in its role
 * colour, drawn in when it scrolls into view, a hairline track and ticks every tenth. The reading
 * itself is HTML laid over the centre by the caller.
 */
export function FeeArc({ parts, className = "", size = 240 }: { parts: ArcPart[]; className?: string; size?: number }) {
  const c = size / 2, r = size * 0.38, w = Math.max(6, size * 0.034), gap = 3.2;
  const live = parts.filter((p) => p.v > 0);
  const total = live.reduce((a, p) => a + p.v, 0) || 1;
  const sweep = 270, start = 135;
  const free = sweep - gap * Math.max(0, live.length - 1);
  let at = start;
  const segs = live.map((p) => { const span = (free * p.v) / total; const s = { ...p, a0: at, a1: at + span }; at += span + gap; return s; });
  const ticks = Array.from({ length: 11 }, (_, i) => start + (sweep * i) / 10);
  return (
    <Illus viewBox={`0 0 ${size} ${size}`} className={`story-arc ${className}`}>
      <path d={arcPath(c, c, r, start, start + sweep)} stroke="rgba(237,245,238,.07)" strokeWidth={w + 6} strokeLinecap="round" />
      {ticks.map((a, i) => { const [x1, y1] = pt(c, c, r + w + 5, a), [x2, y2] = pt(c, c, r + w + (i % 5 === 0 ? 13 : 9), a); return <path key={i} d={`M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`} stroke="rgba(237,245,238,.22)" strokeWidth={i % 5 === 0 ? 1.1 : 0.75} strokeLinecap="round" />; })}
      <Ring cx={c} cy={c} r={r - w - 10} tone="ink" dashed opacity={0.14} />
      {segs.map((s, i) => (
        <g key={s.key} className={`story-arc-part ${s.key}`} style={{ "--k": i } as CSSProperties}>
          <path d={arcPath(c, c, r, s.a0, s.a1)} stroke={`rgba(${TONES[s.tone].rgb},.28)`} strokeWidth={w + 8} strokeLinecap="round" className="story-arc-halo" pathLength={100} />
          <path d={arcPath(c, c, r, s.a0, s.a1)} stroke={TONES[s.tone].c} strokeWidth={w} strokeLinecap="round" pathLength={100} />
        </g>
      ))}
      {segs.map((s) => { const [x, y] = pt(c, c, r, s.a1); return <circle key={`${s.key}-tip`} cx={x} cy={y} r={w * 0.34} fill={TONES[s.tone].c2} className="story-arc-tip" />; })}
    </Illus>
  );
}

/** Depth: root (SOL) → child → grandchild, one hop deeper each time, then the cap: a ghost node on
 *  a cut, dashed filament. Draws one more real node when pump.fun's cap is 3. */
export function DepthIllus({ maxDepth = 2, className = "" }: { maxDepth?: number; className?: string }) {
  const tones: Tone[] = ["lime", "teal", "violet", "agent"];
  const n = Math.min(4, Math.max(1, maxDepth + 1));
  const step = 264 / n;
  const xs = Array.from({ length: n }, (_, i) => 36 + i * step);
  const ys = xs.map((_, i) => 64 + (i % 2 ? 22 : 0));
  const rs = [14, 11, 8, 6];
  const gx = 36 + n * step, gy = 64 + (n % 2 ? 22 : 0);
  return (
    <Illus viewBox="0 0 336 144" className={`story-illus ${className}`}>
      {xs.map((x, i) => <Ring key={`r${i}`} cx={x} cy={ys[i]} r={rs[i] * 2.2} tone={tones[i]} opacity={0.16} />)}
      {xs.slice(1).map((x, i) => <Filament key={`f${i}`} d={curve(xs[i] + rs[i], ys[i], x - rs[i + 1], ys[i + 1], i % 2 ? 0.16 : -0.16)} tone={tones[i + 1]} mote dur={3} delay={i * 0.9} />)}
      {xs.map((x, i) => <Node key={`n${i}`} cx={x} cy={ys[i]} r={rs[i]} tone={tones[i]} pulse={i === 0} />)}
      <Filament d={curve(xs[n - 1] + rs[n - 1], ys[n - 1], gx - 22, gy, -0.12)} tone="ink" dashed opacity={0.35} />
      <path d={`M${gx - 18} ${gy - 9}l8 18`} stroke="var(--bad)" strokeWidth={STROKE.thin} strokeLinecap="round" opacity=".85" />
      <Node cx={gx} cy={gy} r={5} tone="ink" halo={false} dim />
      <Motes seed={9} n={14} box={[12, 112, 312, 24]} tone={["lime", "teal", "violet"]} still />
    </Illus>
  );
}

/** The trade route: SOL → root → child, quoted by a simulation and fenced at the end by the
 *  on-chain minimum (the ring gate); selling runs the same hops back (violet, below). */
export function RouteIllus({ className = "" }: P) {
  return (
    <Illus viewBox="0 0 336 120" className={`story-illus ${className}`}>
      <Node cx={36} cy={48} r={8} tone="ink" />
      <Filament d={curve(46, 48, 132, 48, -0.12)} tone="lime" mote dur={2.4} />
      <Node cx={148} cy={48} r={12} tone="lime" />
      <Filament d={curve(162, 48, 246, 48, -0.12)} tone="lime" mote dur={2.4} delay={1.2} />
      <Ring cx={264} cy={48} r={20} tone="teal" opacity={0.5} />
      <path d="M264 22v-8M264 82v-8" stroke={`rgba(${TONES.teal.rgb},.6)`} strokeWidth={STROKE.thin} strokeLinecap="round" />
      <Node cx={264} cy={48} r={10} tone="teal" />
      <Filament d={curve(252, 92, 50, 92, 0.06)} tone="violet" dashed opacity={0.45} />
      <Node cx={300} cy={92} r={3} tone="violet" />
      <path d="M44 88l-6 4 6 4" stroke={`rgba(${TONES.violet.rgb},.6)`} strokeWidth={STROKE.thin} strokeLinecap="round" strokeLinejoin="round" />
    </Illus>
  );
}

/** A refusal: a node whose filament is cut before it reaches anything (a pink cut mark between). */
export function NeverGlyph({ tone = "lime", lock = false }: { tone?: Tone; lock?: boolean }) {
  return (
    <Illus viewBox="0 0 72 48" className="story-never-glyph">
      <Ring cx={16} cy={24} r={13} tone={tone} opacity={0.24} />
      <Node cx={16} cy={24} r={6} tone={tone} lock={lock} />
      <path d="M23 24c4 0 8-.6 11-1.4" stroke={`rgb(${TONES[tone].rgb})`} strokeOpacity=".75" strokeWidth={STROKE.thin} strokeLinecap="round" />
      <path d="M41 14l-4 20" stroke="var(--bad)" strokeWidth={STROKE.mid} strokeLinecap="round" />
      <path d="M45 24.6c4 .6 7 .4 10 0" stroke="rgba(237,245,238,.32)" strokeWidth={STROKE.thin} strokeLinecap="round" strokeDasharray="1.5 2.5" />
      <Node cx={61} cy={24} r={3.5} tone="ink" halo={false} dim />
    </Illus>
  );
}

/** A small family tree on its depth rings, for the How hero: the root, its children on the first
 *  orbit, grandchildren on the second, motes everywhere. On first paint the seed appears and its
 *  children grow out of it one by one (story.css; skipped under reduced or paused motion). */
export function ColonyIllus({ className = "" }: P) {
  const c = [180, 168];
  const kids = [[-38, 64], [24, 70], [92, 60], [152, 72], [212, 64], [-98, 58]] as const;
  return (
    <Illus viewBox="0 0 360 336" className={`story-illus story-colony ${className}`}>
      <Motes seed={3} n={60} box={[0, 0, 360, 336]} tone={["lime", "teal", "violet", "ink"]} />
      <Ring cx={c[0]} cy={c[1]} r={70} dashed spin opacity={0.26} />
      <Ring cx={c[0]} cy={c[1]} r={126} tone="teal" opacity={0.12} />
      <Ring cx={c[0]} cy={c[1]} r={156} tone="violet" dashed opacity={0.1} />
      {kids.map(([a, d], i) => {
        const [x, y] = pt(c[0], c[1], d, a);
        const [gx, gy] = pt(c[0], c[1], d + 58 + (i % 3) * 10, a + (i % 2 ? 14 : -12));
        return (
          <g key={i} className="story-kid" style={{ "--d": i, transformOrigin: `${c[0]}px ${c[1]}px` } as CSSProperties}>
            <Filament d={curve(c[0], c[1], x, y, i % 2 ? 0.16 : -0.16)} tone="teal" mote={i % 2 === 0} dur={3.2 + i * 0.4} delay={i * 0.7} opacity={0.6} />
            {i % 3 !== 2 && <><Filament d={curve(x, y, gx, gy, 0.2)} tone="violet" width={STROKE.hair} opacity={0.5} /><Node cx={gx} cy={gy} r={2.6} tone="violet" /></>}
            <Node cx={x} cy={y} r={5 + (i % 3) * 1.6} tone="teal" />
          </g>
        );
      })}
      <g className="story-seed" style={{ transformOrigin: `${c[0]}px ${c[1]}px` } as CSSProperties}><Node cx={c[0]} cy={c[1]} r={22} tone="lime" pulse lock /></g>
    </Illus>
  );
}

/** The API hero: a family tree on the left whose filaments run into a pair of drawn braces (the JSON),
 *  and a dotted stream leaving them on the right. */
export function ApiIllus({ className = "" }: P) {
  const ink = "rgba(237,245,238,.55)";
  return (
    <Illus viewBox="0 0 360 192" className={`story-illus ${className}`}>
      <Motes seed={17} n={30} box={[0, 0, 360, 192]} tone={["lime", "teal", "violet", "ink"]} />
      <Filament d={curve(64, 96, 120, 48, -0.16)} tone="teal" opacity={0.6} />
      <Filament d={curve(64, 96, 124, 144, 0.16)} tone="teal" opacity={0.6} />
      <Filament d={curve(124, 48, 150, 24, 0.2)} tone="violet" width={STROKE.hair} opacity={0.5} />
      <Node cx={152} cy={22} r={2.6} tone="violet" />
      <Node cx={120} cy={48} r={7} tone="teal" />
      <Node cx={124} cy={144} r={6} tone="teal" />
      <Ring cx={64} cy={96} r={30} dashed spin opacity={0.25} />
      <Node cx={64} cy={96} r={14} tone="lime" pulse />
      <Filament d={curve(128, 50, 196, 80, 0.1)} tone="lime" fade mote dur={3} />
      <Filament d={curve(78, 98, 196, 98, -0.04)} tone="lime" fade mote dur={3} delay={1} />
      <Filament d={curve(132, 142, 196, 116, -0.1)} tone="lime" fade mote dur={3} delay={2} />
      {/* the braces and three rows of JSON */}
      <path d="M214 46c-10 0-12 6-12 14v20c0 8-4 12-10 16 6 4 10 8 10 16v20c0 8 2 14 12 14" stroke={ink} strokeWidth={STROKE.thin} strokeLinecap="round" />
      <path d="M298 46c10 0 12 6 12 14v20c0 8 4 12 10 16-6 4-10 8-10 16v20c0 8-2 14-12 14" stroke={ink} strokeWidth={STROKE.thin} strokeLinecap="round" />
      <path d="M222 72h22M250 72h30" stroke={`rgba(${TONES.teal.rgb},.75)`} strokeWidth={STROKE.mid} strokeLinecap="round" />
      <path d="M222 96h14M242 96h44" stroke={`rgba(${TONES.lime.rgb},.8)`} strokeWidth={STROKE.mid} strokeLinecap="round" />
      <path d="M222 120h26M254 120h18" stroke={`rgba(${TONES.violet.rgb},.75)`} strokeWidth={STROKE.mid} strokeLinecap="round" />
      <Filament d="M322 96c10 0 18 0 34 0" tone="lime" dashed opacity={0.5} />
    </Illus>
  );
}

/** The Fees hero: trades stream into a root and its creator fee leaves on three filaments whose
 *  widths are the on-chain shares (creator lime, Spore ink into a lock, the agent orange on its orbit). */
export function FeeFlowIllus({ shares, className = "" }: { shares: { creator: number; spore: number; agent: number }; className?: string }) {
  const total = shares.creator + shares.spore + shares.agent || 1;
  const w = (v: number) => 1 + (v / total) * 9;
  const root = [132, 150] as const;
  const to = { creator: [300, 64], spore: [318, 156], agent: [290, 240] } as const;
  return (
    <Illus viewBox="0 0 360 288" className={`story-illus story-feeflow ${className}`}>
      <Motes seed={29} n={36} box={[0, 0, 360, 288]} tone={["lime", "teal", "ink"]} />
      {/* trades arriving */}
      <Filament d={curve(8, 96, 116, 144, 0.1)} tone="ink" mote dur={2.2} opacity={0.35} width={STROKE.hair} />
      <Filament d={curve(4, 168, 114, 152, -0.06)} tone="ink" mote dur={2.6} delay={0.8} opacity={0.35} width={STROKE.hair} />
      <Filament d={curve(16, 236, 118, 160, -0.12)} tone="ink" mote dur={2.4} delay={1.5} opacity={0.35} width={STROKE.hair} />
      {/* the three shares, drawn to scale; a thin twin of each path carries its mote */}
      {([["creator", "lime", -0.12, 0, [14, -8, 10]], ["spore", "ink", 0.04, 0.9, [16, 0, 14]], ["agent", "agent", 0.12, 1.8, [14, 8, 8]]] as const).map(([k, tone, bend, delay, [dx, dy, ex]]) => {
        const d = curve(root[0] + dx, root[1] + dy, to[k][0] - ex, to[k][1], bend);
        return (
          <g key={k}>
            <Filament d={d} tone={tone} width={w(shares[k])} opacity={tone === "ink" ? 0.32 : 0.42} />
            <Filament d={d} tone={tone} mote dur={3} delay={delay} opacity={0.9} width={STROKE.hair} />
          </g>
        );
      })}
      <Ring cx={root[0]} cy={root[1]} r={34} dashed spin opacity={0.24} />
      <Node cx={root[0]} cy={root[1]} r={17} tone="lime" pulse />
      <Node cx={to.creator[0]} cy={to.creator[1]} r={9} tone="lime" />
      <Ring cx={to.spore[0]} cy={to.spore[1]} r={20} tone="ink" opacity={0.3} />
      <Node cx={to.spore[0]} cy={to.spore[1]} r={10} tone="ink" lock />
      <Ring cx={to.agent[0]} cy={to.agent[1]} r={22} tone="agent" dashed spin opacity={0.4} />
      <Node cx={to.agent[0]} cy={to.agent[1]} r={7} tone="agent" />
    </Illus>
  );
}
