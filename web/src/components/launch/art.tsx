// Drawings of the launch stage, in the illustration kit's language (components/illus/base.tsx): the
// progress rail's three step glyphs, the two "where it grows" tiles, and the launch button's inline
// progress arc. Every drawing is decorative (aria-hidden); the words around it carry the meaning.
// Motion is CSS-only (illus.css + launch.css), so reduced motion and the pause toggle stop it.
import { Filament, Illus, Motes, Node, Ring, curve } from "../illus/base";

export type GlyphState = "todo" | "active" | "done";

/// The rail's step glyphs on a 48-unit grid: 1 a root with two children (where it grows), 2 a coin
/// face in its orbit (the coin itself), 3 a spore leaving on a filament (the launch).
export function RailGlyph({ k, state }: { k: "tree" | "coin" | "launch"; state: GlyphState }) {
  const dim = state === "todo";
  const tone = dim ? "ink" : "lime";
  return (
    <Illus viewBox="0 0 48 48" className={`rail-glyph is-${state}`}>
      {k === "tree" && <>
        <Filament d={curve(24, 31, 13, 15, 0.12)} tone={dim ? "ink" : "teal"} dashed={dim} opacity={dim ? 0.45 : 0.75} />
        <Filament d={curve(24, 31, 35, 15, -0.12)} tone={dim ? "ink" : "teal"} dashed={dim} opacity={dim ? 0.45 : 0.75} />
        <Node cx={13} cy={14} r={2.6} tone={dim ? "ink" : "teal"} dim={dim} halo={!dim} />
        <Node cx={35} cy={14} r={2.6} tone={dim ? "ink" : "teal"} dim={dim} halo={!dim} />
        <Node cx={24} cy={32} r={5} tone={tone} dim={dim} pulse={state === "active"} />
      </>}
      {k === "coin" && <>
        <Ring cx={24} cy={24} r={14} tone={dim ? "ink" : "teal"} dashed={dim} spin={state === "active"} opacity={dim ? 0.35 : 0.5} />
        <Node cx={24} cy={24} r={6.5} tone={tone} dim={dim} pulse={state === "active"} />
        {!dim && <Node cx={36.1} cy={17} r={1.6} tone="violet" halo={false} />}
      </>}
      {k === "launch" && <>
        <Filament d="M24 40C24 32 25 27 24 20" tone={dim ? "ink" : "lime"} dashed={dim} mote={state === "active"} dur={2.2} opacity={dim ? 0.45 : 0.7} />
        <Node cx={24} cy={40} r={3} tone={dim ? "ink" : "teal"} dim={dim} halo={!dim} />
        {[0, 60, 120, 180, 240, 300].map((a, i) => {
          const r = i % 2 ? 9 : 7, x = 24 + r * Math.cos((a - 90) * Math.PI / 180), y = 14 + r * Math.sin((a - 90) * Math.PI / 180);
          return <circle key={a} cx={x} cy={y} r={i % 2 ? 1.1 : 1.5} fill={dim ? "rgba(237,245,238,.35)" : i % 3 === 0 ? "#b6ff5c" : i % 3 === 1 ? "#5ce0c8" : "#b08cff"} className="burst-mote" style={{ animationDelay: `${i * 0.12}s` }} />;
        })}
        <Node cx={24} cy={14} r={3.4} tone={tone} dim={dim} pulse={state === "active"} />
      </>}
    </Illus>
  );
}

/// The two tiles of step 1, 240 × 96. "root": SOL feeding a fresh root with its agent in orbit and
/// the children it has not grown yet (dormant, dashed). "child": an existing tree with a new coin
/// budding under the parent on a pending filament.
export function TileArt({ kind }: { kind: "root" | "child" }) {
  if (kind === "root") {
    return (
      <Illus viewBox="0 0 240 96" className="tile-art root">
        <Motes seed={11} n={14} box={[96, 6, 140, 84]} tone={["lime", "teal", "violet"]} rMax={1.2} />
        <Filament d={curve(18, 50, 56, 50, 0.1)} tone="ink" opacity={0.5} mote dur={2.6} />
        <Node cx={16} cy={50} r={3.4} tone="ink" halo={false} />
        <Ring cx={70} cy={48} r={22} tone="lime" dashed spin opacity={0.35} />
        <Filament d={curve(80, 44, 148, 22, 0.1)} tone="teal" dashed opacity={0.5} />
        <Filament d={curve(82, 50, 170, 54, -0.06)} tone="teal" dashed opacity={0.5} />
        <Filament d={curve(80, 54, 146, 80, -0.1)} tone="teal" dashed opacity={0.5} />
        <Filament d={curve(152, 20, 204, 12, 0.12)} tone="violet" dashed opacity={0.35} />
        <Filament d={curve(174, 54, 220, 44, -0.1)} tone="violet" dashed opacity={0.35} />
        <Node cx={150} cy={22} r={4} tone="teal" dim />
        <Node cx={172} cy={54} r={4.6} tone="teal" dim />
        <Node cx={148} cy={80} r={3.6} tone="teal" dim />
        <Node cx={206} cy={12} r={2.4} tone="violet" dim />
        <Node cx={222} cy={44} r={2.4} tone="violet" dim />
        <Node cx={70} cy={48} r={9} tone="lime" pulse lock />
        <g className="tile-orbit" style={{ transformOrigin: "70px 48px" }}><Node cx={92} cy={48} r={2.6} tone="agent" /></g>
      </Illus>
    );
  }
  return (
    <Illus viewBox="0 0 240 96" className="tile-art child">
      <Motes seed={29} n={12} box={[8, 6, 220, 84]} tone={["teal", "violet"]} rMax={1.1} />
      <Filament d={curve(52, 46, 112, 18, 0.12)} tone="teal" opacity={0.6} />
      <Filament d={curve(52, 52, 108, 82, -0.12)} tone="teal" opacity={0.6} />
      <Filament d={curve(118, 18, 150, 10, 0.1)} tone="violet" opacity={0.45} />
      <Filament d={curve(56, 48, 182, 50, -0.08)} tone="lime" dashed mote dur={2.4} opacity={0.55} />
      <Node cx={114} cy={18} r={4.6} tone="teal" />
      <Node cx={110} cy={82} r={4.2} tone="teal" />
      <Node cx={152} cy={10} r={2.4} tone="violet" />
      <Node cx={46} cy={48} r={9} tone="lime" lock />
      <Ring cx={192} cy={50} r={15} tone="teal" dashed spin opacity={0.45} />
      <Node cx={192} cy={50} r={6.5} tone="teal" pulse />
    </Illus>
  );
}

/// The launch button's inline progress: a ring whose lit arc is the share of steps done.
export function ProgressArc({ done, total }: { done: number; total: number }) {
  const f = total > 0 ? Math.max(0.06, Math.min(1, done / total)) : 0.06;
  return (
    <svg className="launch-arc" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="2" />
      <circle className="launch-arc-fill" cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" pathLength={100} strokeDasharray={`${(f * 100).toFixed(1)} 100`} transform="rotate(-90 10 10)" />
    </svg>
  );
}
