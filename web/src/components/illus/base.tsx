// The illustration kit (DESIGN-ELEVATE §6): one construction language for every drawing on Spore.
// Luminous hairline filaments, nodes with halos, orbit rings and motes on a 24-unit grid, in the
// depth colours (root lime, child teal, grandchild violet, agent orange). Every luminous element
// gets the shared glow filter; nothing has a drop shadow, a black stroke or an emoji.
//
// Two ways to use it:
//   <Illus viewBox="0 0 240 144" className="my-illus">…primitives…</Illus>   (ids and defs handled)
//   const id = useIllusId(); <svg><IllusDefs id={id} /><IllusScope id={id}>…</IllusScope></svg>
// Primitives read the defs id from the nearest <Illus>/<IllusScope>, or from an explicit `id` prop.
// Motion is CSS-only (illus.css), so the site's reduced-motion and pause rules stop it.
import { createContext, useContext, useId, useMemo, type ReactNode, type SVGProps } from "react";
import "./illus.css";

/** Stroke widths in viewBox units: hair .75 · thin 1.25 · mid 2. */
export const STROKE = { hair: 0.75, thin: 1.25, mid: 2 } as const;

/** A role colour of the kit. root = lime, child = teal, grandchild = violet, agent = orange, ink = SOL/neutral white. */
export type Tone = "lime" | "teal" | "violet" | "agent" | "ink";
/** Colour values per tone: `c` the light, `c2` a paler core, `rgb` an "r,g,b" triplet for rgba(). */
export const TONES: Record<Tone, { c: string; c2: string; rgb: string }> = {
  lime: { c: "#b6ff5c", c2: "#eaffc4", rgb: "182,255,92" },
  teal: { c: "#5ce0c8", c2: "#c9fff4", rgb: "92,224,200" },
  violet: { c: "#b08cff", c2: "#e6dcff", rgb: "176,140,255" },
  agent: { c: "#ff9a3c", c2: "#ffe0bd", rgb: "255,154,60" },
  ink: { c: "rgba(237,245,238,.7)", c2: "#ffffff", rgb: "237,245,238" },
};
const TONE_KEYS = Object.keys(TONES) as Tone[];

const Ctx = createContext<string | null>(null);
/** Provides the defs id to the primitives inside it (only needed when you render <IllusDefs> yourself). */
export const IllusScope = ({ id, children }: { id: string; children: ReactNode }) => <Ctx.Provider value={id}>{children}</Ctx.Provider>;
const useDefsId = (id?: string) => { const ctx = useContext(Ctx); return id ?? ctx ?? "illus"; };

/** A unique, url()-safe id prefix for one drawing (React's useId without the colons). */
export function useIllusId(): string {
  const raw = useId();
  return useMemo(() => `il${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`, [raw]);
}

/**
 * The shared <defs> of a drawing, ids prefixed with `id`:
 *   `${id}-<tone>`       radial halo (tone at 55 % → 0), for node halos and soft light pools
 *   `${id}-<tone>-core`  radial core (pale centre → tone), for node discs
 *   `${id}-<tone>-fade`  linear tone → transparent along x, for filaments that fade out
 *   `${id}-glow`         the glow filter (feGaussianBlur 2.5 merged under the source)
 */
export function IllusDefs({ id }: { id: string }) {
  return (
    <defs>
      {TONE_KEYS.map((t) => (
        <g key={t}>
          <radialGradient id={`${id}-${t}`}>
            <stop offset="0" stopColor={`rgb(${TONES[t].rgb})`} stopOpacity=".55" />
            <stop offset=".45" stopColor={`rgb(${TONES[t].rgb})`} stopOpacity=".14" />
            <stop offset="1" stopColor={`rgb(${TONES[t].rgb})`} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-${t}-core`} cx="38%" cy="34%" r="70%">
            <stop offset="0" stopColor={TONES[t].c2} />
            <stop offset=".55" stopColor={`rgb(${TONES[t].rgb})`} />
            <stop offset="1" stopColor={`rgb(${TONES[t].rgb})`} stopOpacity=".75" />
          </radialGradient>
          <linearGradient id={`${id}-${t}-fade`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={`rgb(${TONES[t].rgb})`} stopOpacity=".9" />
            <stop offset="1" stopColor={`rgb(${TONES[t].rgb})`} stopOpacity="0" />
          </linearGradient>
        </g>
      ))}
      <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation="2.5" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </defs>
  );
}

/**
 * An <svg> with the kit's defs and scope already set up. aria-hidden by default; pass `label` to make
 * it an image with that accessible name. Size it with CSS (width: 100%; height: auto).
 */
export function Illus({ viewBox, label, className = "", children, ...rest }: { viewBox: string; label?: string; className?: string; children: ReactNode } & Omit<SVGProps<SVGSVGElement>, "viewBox" | "children">) {
  const id = useIllusId();
  return (
    <svg viewBox={viewBox} className={`illus ${className}`} fill="none" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false" {...rest}>
      <IllusDefs id={id} />
      <IllusScope id={id}>{children}</IllusScope>
    </svg>
  );
}

/**
 * A node: a glowing disc with a 1 px rim and (by default) a soft radial halo three radii wide.
 * `lock` adds the 2 px inner ring of a locked node; `dim` draws it dormant (rim only, faint halo);
 * `pulse` breathes the halo (CSS, stops under reduced motion).
 */
export function Node({ cx, cy, r, tone = "lime", halo = true, lock = false, dim = false, pulse = false, id, className = "" }: { cx: number; cy: number; r: number; tone?: Tone; halo?: boolean; lock?: boolean; dim?: boolean; pulse?: boolean; id?: string; className?: string }) {
  const d = useDefsId(id);
  const T = TONES[tone];
  return (
    <g className={`illus-node ${pulse ? "is-pulse" : ""} ${className}`.trim()}>
      {halo && <circle className="illus-halo" cx={cx} cy={cy} r={r * 3.2} fill={`url(#${d}-${tone})`} opacity={dim ? 0.35 : 1} style={{ transformOrigin: `${cx}px ${cy}px` }} />}
      {dim
        ? <circle cx={cx} cy={cy} r={r} fill={`rgba(${T.rgb},.08)`} stroke={`rgba(${T.rgb},.55)`} strokeWidth={STROKE.thin} strokeDasharray="2 3" />
        : <circle cx={cx} cy={cy} r={r} fill={`url(#${d}-${tone}-core)`} filter={`url(#${d}-glow)`} />}
      {!dim && <circle cx={cx} cy={cy} r={r} stroke={`rgba(${T.rgb},.9)`} strokeWidth={STROKE.hair} vectorEffect="non-scaling-stroke" />}
      {lock && <circle cx={cx} cy={cy} r={Math.max(1, r * 0.55)} stroke={T.c2} strokeOpacity=".85" strokeWidth={STROKE.mid} />}
    </g>
  );
}

/**
 * A filament: a hairline path between two things. `dashed` = pending (2 6), solid = live.
 * `mote` sends a small light along it (CSS stroke-dashoffset over pathLength 100; `dur` seconds,
 * `delay` seconds); under reduced motion the mote rests part-way. `fade` fades the line toward its end
 * (left → right in user space). `width` defaults to STROKE.thin.
 */
export function Filament({ d, tone = "lime", dashed = false, mote = false, fade = false, width = STROKE.thin, opacity = 0.7, dur = 3.2, delay = 0, id, className = "" }: { d: string; tone?: Tone; dashed?: boolean; mote?: boolean; fade?: boolean; width?: number; opacity?: number; dur?: number; delay?: number; id?: string; className?: string }) {
  const ds = useDefsId(id);
  const T = TONES[tone];
  return (
    <g className={`illus-fil ${className}`.trim()}>
      <path d={d} stroke={fade ? `url(#${ds}-${tone}-fade)` : `rgb(${T.rgb})`} strokeOpacity={opacity} strokeWidth={width} strokeLinecap="round" strokeDasharray={dashed ? "2 6" : undefined} className={dashed ? "illus-pending" : undefined} />
      {mote && <path d={d} pathLength={100} stroke={T.c2} strokeWidth={width * 2.6} strokeLinecap="round" strokeDasharray="0.1 99.9" className="illus-mote" filter={`url(#${ds}-glow)`} style={{ animationDuration: `${dur}s`, animationDelay: `${delay}s` }} />}
    </g>
  );
}

/** An orbit ring: a 1 px circle at 30 % alpha (dashed when `dashed`); `spin` turns it slowly (CSS). */
export function Ring({ cx, cy, r, tone = "lime", dashed = false, spin = false, opacity = 0.3, className = "" }: { cx: number; cy: number; r: number; tone?: Tone; dashed?: boolean; spin?: boolean; opacity?: number; className?: string }) {
  return <circle className={`illus-ring ${spin ? "is-spin" : ""} ${className}`.trim()} cx={cx} cy={cy} r={r} stroke={`rgb(${TONES[tone].rgb})`} strokeOpacity={opacity} strokeWidth={STROKE.hair} strokeDasharray={dashed ? "1.5 4.5" : undefined} vectorEffect="non-scaling-stroke" style={{ transformOrigin: `${cx}px ${cy}px` }} />;
}

/** Deterministic PRNG (mulberry32) so a drawing is identical on every render and in every screenshot. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * A spore cloud: `n` motes (r 0.75–1.5, i.e. 1.5–3 units across) scattered in `box` [x, y, w, h] with
 * jittered alpha, from a fixed `seed`. `tone` may be one tone or a list to mix. About a third twinkle
 * (CSS) unless `still`.
 */
export function Motes({ seed, n, box, tone = "lime", still = false, rMax = 1.5, className = "" }: { seed: number; n: number; box: [number, number, number, number]; tone?: Tone | Tone[]; still?: boolean; rMax?: number; className?: string }) {
  const motes = useMemo(() => {
    const rnd = seeded(seed);
    const tones = Array.isArray(tone) ? tone : [tone];
    return Array.from({ length: n }, (_, i) => ({ x: box[0] + rnd() * box[2], y: box[1] + rnd() * box[3], r: 0.75 + rnd() * (rMax - 0.75), a: 0.25 + rnd() * 0.65, t: tones[i % tones.length], tw: !still && rnd() < 0.34, dl: rnd() * 4 }));
  }, [seed, n, box, tone, still, rMax]);
  return (
    <g className={`illus-motes ${className}`.trim()}>
      {motes.map((m, i) => <circle key={i} cx={m.x} cy={m.y} r={m.r} fill={`rgb(${TONES[m.t].rgb})`} opacity={m.a} className={m.tw ? "illus-twinkle" : undefined} style={m.tw ? { animationDelay: `${m.dl.toFixed(2)}s` } : undefined} />)}
    </g>
  );
}

/**
 * The split: arcs of one circle in role colours (creator lime, Spore ink, agent orange by default),
 * drawn clockwise from 12 o'clock over `sweep` degrees (360 = full circle, 270 = the fee arc), with a
 * small gap between parts. `parts` are weights; zero-weight parts are skipped.
 */
export function SplitArc({ cx, cy, r, parts, sweep = 360, gap = 4, width = STROKE.mid, start = -90 }: { cx: number; cy: number; r: number; parts: { v: number; tone: Tone }[]; sweep?: number; gap?: number; width?: number; start?: number }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.v), 0) || 1;
  const live = parts.filter((p) => p.v > 0);
  const gaps = live.length > 1 ? gap * (sweep >= 360 ? live.length : live.length - 1) : 0;
  let at = start;
  const pt = (deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  return (
    <g className="illus-split">
      {live.map((p, i) => {
        const span = ((sweep - gaps) * p.v) / total;
        const [x1, y1] = pt(at), [x2, y2] = pt(at + span);
        const d = `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
        at += span + gap;
        return <path key={i} d={d} stroke={TONES[p.tone].c} strokeWidth={width} strokeLinecap="round" />;
      })}
    </g>
  );
}

/** A cubic filament path from (x1,y1) to (x2,y2) that bows by `bend` (fraction of the length, signed). */
export function curve(x1: number, y1: number, x2: number, y2: number, bend = 0.18): string {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
  const nx = -dy * bend, ny = dx * bend;
  return `M${x1} ${y1}C${(x1 + mx) / 2 + nx} ${(y1 + my) / 2 + ny} ${(mx + x2) / 2 + nx} ${(my + y2) / 2 + ny} ${x2} ${y2}`;
}
