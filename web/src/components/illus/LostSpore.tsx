// The 404 drawing: a small colony on the left whose filament breaks off mid-air, and one spore that
// drifted away from it, alone in its own orbit on the right. Built from the kit in ./base.
import { curve, Filament, Illus, Motes, Node, Ring } from "./base";

export default function LostSpore({ className = "" }: { className?: string }) {
  return (
    <Illus viewBox="0 0 480 288" className={`lost-spore ${className}`}>
      <Motes seed={404} n={46} box={[0, 0, 480, 288]} tone={["lime", "teal", "violet", "ink"]} />
      {/* the colony it came from */}
      <Filament d={curve(120, 156, 64, 100, 0.12)} tone="teal" mote dur={3.6} />
      <Filament d={curve(120, 156, 56, 208, -0.14)} tone="teal" opacity={0.55} />
      <Filament d={curve(120, 156, 168, 232, 0.16)} tone="teal" mote dur={4.2} delay={1.4} />
      <Filament d={curve(64, 100, 36, 60, 0.2)} tone="violet" width={0.75} opacity={0.5} />
      <Filament d={curve(56, 208, 24, 236, -0.2)} tone="violet" width={0.75} opacity={0.5} />
      <Node cx={36} cy={60} r={2.5} tone="violet" />
      <Node cx={24} cy={236} r={2.5} tone="violet" />
      <Node cx={64} cy={100} r={6} tone="teal" />
      <Node cx={56} cy={208} r={7} tone="teal" />
      <Node cx={168} cy={232} r={5} tone="teal" />
      <Ring cx={120} cy={156} r={34} dashed spin />
      <Node cx={120} cy={156} r={14} tone="lime" pulse lock />
      {/* the filament that broke */}
      <Filament d={curve(134, 150, 252, 126, -0.1)} tone="lime" fade mote dur={4.8} delay={0.6} />
      <Filament d="M262 124c10-2 18-3 26-4" tone="lime" dashed opacity={0.35} />
      {/* its trail and the lost spore, adrift */}
      <g className="lost-spore-adrift">
        <Motes seed={7} n={9} box={[300, 106, 52, 14]} tone="teal" still rMax={1.1} />
        <Ring cx={384} cy={108} r={48} tone="violet" opacity={0.16} />
        <Ring cx={384} cy={108} r={30} tone="teal" dashed spin opacity={0.4} />
        <Node cx={384} cy={108} r={10} tone="teal" pulse />
        <Node cx={406} cy={88} r={2.5} tone="violet" />
      </g>
    </Illus>
  );
}
