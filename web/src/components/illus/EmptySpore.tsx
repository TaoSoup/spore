// The default drawing of an empty state: a dormant spore at the end of a pending filament, nothing
// grown yet. Small (144 × 96) and quiet, so it sits above a one-line message.
import { Filament, Illus, Motes, Node, Ring } from "./base";

export default function EmptySpore({ className = "" }: { className?: string }) {
  return (
    <Illus viewBox="0 0 144 96" className={`empty-spore ${className}`}>
      <Motes seed={11} n={14} box={[8, 8, 128, 80]} tone={["lime", "teal", "violet"]} />
      <Filament d="M12 80C36 80 46 58 62 54" tone="lime" dashed opacity={0.55} />
      <Ring cx={72} cy={50} r={22} dashed opacity={0.28} />
      <Node cx={72} cy={50} r={8} tone="lime" dim />
      <Node cx={12} cy={80} r={3} tone="lime" />
    </Illus>
  );
}
