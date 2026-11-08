// Drawings and instruments of the Claim page, in the illustration kit's language: the tiny split arc
// that draws a payout's recipients in each row, the "connect" drawing (fee vaults joined to a wallet
// by pending filaments), and a USD figure that counts up to its value when it first shows.
import { useEffect, useRef } from "react";
import { Filament, Illus, Motes, Node, Ring, SplitArc, TONES, curve, type Tone } from "../illus/base";
import type { FeeRoleTone } from "../../lib/fee-roles";
import { countUp } from "../../lib/motion";

export const ROLE_TONE: Record<FeeRoleTone, Tone> = { you: "lime", creator: "lime", spore: "ink", agent: "agent", other: "violet" };

/// A 24-unit split ring: one arc per recipient in role colours (decorative; the row's words say it).
export function MiniArc({ parts, size = 28 }: { parts: { v: number; tone: Tone }[]; size?: number }) {
  const live = parts.filter((p) => p.v > 0);
  return (
    <svg className="mini-arc" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="2.5" />
      {/* One recipient takes the whole ring (an arc from a point back to itself would draw nothing). */}
      {live.length === 1 ? <circle cx="12" cy="12" r="8.5" fill="none" stroke={TONES[live[0].tone].c} strokeWidth="2.5" />
        : <SplitArc cx={12} cy={12} r={8.5} parts={live} gap={20} width={2.5} />}
    </svg>
  );
}

/// The connect state: three coins' fee vaults on the right, joined to the wallet on the left by pending filaments.
export function ConnectArt() {
  return (
    <Illus viewBox="0 0 264 96" className="claim-art">
      <Motes seed={41} n={14} box={[60, 6, 200, 84]} tone={["lime", "teal", "violet"]} rMax={1.1} />
      <Filament d={curve(206, 20, 52, 48, 0.1)} tone="lime" dashed mote dur={3} opacity={0.5} />
      <Filament d={curve(222, 52, 52, 48, -0.02)} tone="teal" dashed mote dur={3.4} delay={0.6} opacity={0.5} />
      <Filament d={curve(200, 82, 52, 48, -0.1)} tone="agent" dashed mote dur={3.8} delay={1.2} opacity={0.45} />
      <Node cx={206} cy={20} r={5} tone="lime" />
      <Node cx={224} cy={52} r={6} tone="teal" />
      <Node cx={200} cy={82} r={4.4} tone="agent" />
      <Ring cx={40} cy={48} r={20} tone="lime" dashed spin opacity={0.4} />
      <Node cx={40} cy={48} r={8} tone="lime" dim />
    </Illus>
  );
}

/// A number that counts up to `value` once it is known (honest: it lands exactly on the formatted value;
/// paused motion writes it at once). `format` turns a number into its text.
export function CountUp({ value, format, className = "" }: { value: number; format: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { const el = ref.current; if (!el) return; return countUp(el, value, format, 900); }, [value, format]);
  return <b ref={ref} className={className}>{format(value)}</b>;
}
