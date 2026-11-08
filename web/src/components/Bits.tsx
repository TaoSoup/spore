import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { solscanAccount, type CoinRef } from "../lib/api";
import { pct, short } from "../lib/format";
import Term from "./Term";
import EmptySpore from "./illus/EmptySpore";
import type { AgentProvenance } from "../lib/agent-index";

/// The letter as an SVG data URI (mono, lime on --bg-3): an <img> paints it as its background while the
/// coin image loads, so a slow image proxy shows the letter instead of an empty disc. Cached per letter.
const letterBg = new Map<string, string>();
const esc = (ch: string) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[ch] ?? ch;
function letterImage(letter: string): string {
  let v = letterBg.get(letter);
  if (!v) {
    let enc = "%3F";
    try { enc = encodeURIComponent(esc(letter)); } catch { /* a lone surrogate: show "?" */ }
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' fill='%2314301f'/><text x='20' y='26.5' text-anchor='middle' font-family='Geist Mono,ui-monospace,Menlo,monospace' font-weight='600' font-size='17' fill='%23b6ff5c'>${enc}</text></svg>`;
    v = `url("data:image/svg+xml,${svg.replace(/</g, "%3C").replace(/>/g, "%3E")}")`;
    letterBg.set(letter, v);
  }
  return v;
}

/// Coin image with a letter fallback (a 1 px inner edge; with className "ring" a tint ring whose halo
/// brightens when the link or card around it is hovered); a broken image proxy swaps to the letter instead of a
/// browser placeholder icon, and the letter shows behind the image while it loads. `onLoad` receives
/// the element so a card can sample its colour; the ref callback covers images that were already
/// cached when the element mounted.
export function Logo({ src, label, size = 36, className = "", style, onLoad }: { src: string | null | undefined; label: string | null | undefined; size?: number; className?: string; style?: CSSProperties; onLoad?: (img: HTMLImageElement) => void }) {
  const [broken, setBroken] = useState(false);
  // First code point, not first UTF-16 unit, so an emoji name never yields half a character.
  const letter = (Array.from((label || "?").replace(/^\$/, ""))[0] ?? "?").toUpperCase();
  const s = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)), ...style };
  // Once the image is in, the letter must not show through a transparent logo.
  const loaded = (el: HTMLImageElement) => { el.style.backgroundImage = "none"; };
  return src && !broken
    ? <img className={`logo ${className}`} src={src} alt="" width={size} height={size} style={{ backgroundImage: letterImage(letter), ...s }} loading="lazy" decoding="async" onError={() => setBroken(true)}
        onLoad={(e) => { loaded(e.currentTarget); onLoad?.(e.currentTarget); }} ref={(el) => { if (el && el.complete && el.naturalWidth) { loaded(el); onLoad?.(el); } }} />
    : <div className={`logo letter ${className}`} style={s} aria-hidden="true">{letter}</div>;
}

/* ---------- dominant colour of a coin image, as an "r,g,b" triplet for the --tint variable */
const tintCache = new Map<string, string>();
const hslToRgb = (h: number, s: number, l: number) => {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)).join(",");
};
const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};
/// Deterministic fallback hue from the mint, so a card without an image still gets its own tint.
export function hashTint(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return hslToRgb(h % 360, 0.8, 0.62);
}
/// Average of the image's vivid pixels (saturation-weighted, ignoring black/white backgrounds),
/// then lifted so it reads on a dark surface. Null when the canvas is tainted (cross-origin).
export function sampleTint(img: HTMLImageElement): string | null {
  try {
    const n = 14;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    let r = 0, gg = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 120) continue;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const max = Math.max(R, G, B), min = Math.min(R, G, B);
      const lum = (max + min) / 510;
      if (lum < 0.08 || lum > 0.94) continue;
      const sat = max === 0 ? 0 : (max - min) / max;
      const wt = 0.05 + sat * sat;
      r += R * wt; gg += G * wt; b += B * wt; w += wt;
    }
    if (w < 0.5) return null;
    const [h, s, l] = rgbToHsl(r / w, gg / w, b / w);
    return hslToRgb(h, Math.max(0.55, Math.min(0.95, s * 1.25)), Math.max(0.56, Math.min(0.7, l)));
  } catch { return null; }
}
/// [tint, onImageLoad]: starts from the cached or hash tint and upgrades once the image is sampled.
export function useTint(src: string | null | undefined, seed: string): [string, (img: HTMLImageElement) => void] {
  const key = src ?? "";
  const [sampled, setSampled] = useState<{ key: string; tint: string } | null>(null);
  const onLoad = useCallback((img: HTMLImageElement) => {
    if (!key) return;
    let t = tintCache.get(key);
    if (!t) { t = sampleTint(img) ?? hashTint(seed); tintCache.set(key, t); }
    const tint = t;
    setSampled((cur) => (cur && cur.key === key && cur.tint === tint ? cur : { key, tint }));
  }, [key, seed]);
  const tint = sampled && sampled.key === key ? sampled.tint : (tintCache.get(key) ?? hashTint(seed));
  return [tint, onLoad];
}

export const sym = (c: { symbol: string | null; mint: string } | null | undefined) => (c ? (c.symbol ? `$${c.symbol}` : short(c.mint)) : "—");
export const nameOf = (c: { name: string | null; symbol: string | null; mint: string }) => c.name || c.symbol || short(c.mint, 6);

/// d0 lime (roots) · d1 teal · d2 violet · d3+ amber: the depth is the first thing to read on a card.
/// `long` adds the word ("d1 · child"); `term` makes the badge a <Term> that explains depth on hover/tap
/// (only where the badge is not inside a link or button). The map's side panel uses the default form.
const DEPTH_WORD = ["root", "child", "grandchild"];
export const DepthBadge = ({ depth, title, long = false, term = false, maxDepth }: { depth: number; title?: string; long?: boolean; term?: boolean; maxDepth?: number | null }) => {
  const text = long ? `d${depth} · ${DEPTH_WORD[depth] ?? `depth ${depth}`}` : `d${depth}`;
  const cls = `depth d${Math.min(depth, 3)}`;
  if (term) return <span className={cls}><Term k="depth" vars={{ maxDepth }}>{text}</Term></span>;
  return <span className={cls} title={title ?? `depth ${depth}: ${depth === 0 ? "root, quoted in a listed mint" : `${depth} hop${depth === 1 ? "" : "s"} from a root`}`}>{text}</span>;
};

/// Lineage pill: "↳ under $PARENT" (the parent's symbol in lime, links to its page) or "root".
export const ParentPill = ({ parent }: { parent: CoinRef | null }) => parent
  ? <Link to={`/c/${parent.mint}`} className="pill parent" title={`Launched under ${parent.name || sym(parent)}`} onClick={(e) => e.stopPropagation()}><span aria-hidden="true">↳</span> under <b>{sym(parent)}</b></Link>
  : <span className="pill root">root</span>;

/// "1st" chip: the first child launched under its parent (lib/map/firstborn). A small lime outline with
/// a slow pulse (none under prefers-reduced-motion); the title names the parent when it is known.
export const Firstborn = ({ parent, className = "" }: { parent?: { symbol: string | null; mint: string } | null; className?: string }) =>
  <i className={`firstborn ${className}`.trim()} title={parent ? `First child launched under ${sym(parent)}` : "First child launched under its parent"} aria-label="first child">1st</i>;

/// Agent provenance (lib/agent-index agentProvenance): a child an agent launched reads "✦ by $SPREAD's agent",
/// a root with an agent reads "agent live | asleep | paused". Links to the agent page unless `link={false}`
/// (inside rows that are themselves clickable). Renders nothing for null.
export function AgentChip({ prov, link = true }: { prov: AgentProvenance; link?: boolean }) {
  if (!prov) return null;
  const root = sym(prov.agent.root);
  const state = prov.agent.state;
  const title = prov.role === "child" ? `Named, drawn and launched by ${root}'s AI agent from its own wallet` : `${root} has an AI agent with its own wallet`;
  const body = prov.role === "child"
    ? <><span aria-hidden="true">✦</span>by {root}'s agent</>
    : <><i className={`agent-dot ${state}`} aria-hidden="true" />agent {state}</>;
  return link
    ? <Link to={`/agents/${prov.agent.root.mint}`} className="chip agent agent-chip" title={title} onClick={(e) => e.stopPropagation()}>{body}</Link>
    : <span className="chip agent agent-chip" title={title}>{body}</span>;
}

/// Tones follow the colour roles at the top of styles.css: accent (lime) · violet · teal · warn · bad ·
/// good · agent (anything an AI agent did) · neutral.
export type ChipTone = "" | "good" | "warn" | "bad" | "accent" | "violet" | "teal" | "agent" | "neutral";
export const Chip = ({ children, tone = "", title }: { children: ReactNode; tone?: ChipTone; title?: string }) => <span className={`chip ${tone}`} title={title}>{children}</span>;

export const Addr = ({ a, n = 4, className = "" }: { a: string; n?: number; className?: string }) => <a className={`mono addr ${className}`} href={solscanAccount(a)} target="_blank" rel="noreferrer" title={a}>{short(a, n)}</a>;
export const Ext = ({ href, children, className = "", title }: { href: string; children: ReactNode; className?: string; title?: string }) => <a className={className} href={href} target="_blank" rel="noreferrer" title={title}>{children}</a>;

/// A gradient bar (teal → lime) with a glowing leading edge; `value` is 0..1.
export const ProgressBar = ({ value, label }: { value: number; label?: string }) => (
  <div className="progress" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} title={label ?? `${pct(value)} of the curve filled`}>
    <i style={{ width: `${Math.max(1, Math.min(100, value * 100))}%` }} />
  </div>
);

/// A loading placeholder in the final layout's shape; its sweep runs four times and stops.
export const Skeleton = ({ w, h = 14, r, className = "", style }: { w?: number | string; h?: number; r?: number; className?: string; style?: CSSProperties }) => <span className={`sk ${className}`} style={{ width: w ?? "100%", height: h, borderRadius: r, ...style }} aria-hidden="true" />;
export const SkeletonRows = ({ n = 6, h = 44 }: { n?: number; h?: number }) => <div className="stack-2" aria-hidden="true">{Array.from({ length: n }, (_, i) => <Skeleton key={i} h={h} r={8} />)}</div>;

/// An empty state: a small drawn illustration, one plain sentence (title), an optional hint and action.
/// `illus` replaces the default drawing (a dormant spore, components/illus/EmptySpore); pass null for none.
export const Empty = ({ title, hint, action, illus }: { title: string; hint?: ReactNode; action?: ReactNode; illus?: ReactNode | null }) => (
  <div className="empty">
    {illus === undefined ? <EmptySpore className="empty-illus" /> : illus}
    <b>{title}</b>{hint && <p>{hint}</p>}{action && <div className="empty-action">{action}</div>}
  </div>
);
/// The launchpad's empty state (DESIGN §11.1): Spore lists only coins launched here, so before
/// the first launch every listing is empty by design, and the page must say so instead of looking
/// broken. `compact` fits inside a section; the default is a full-width card.
export const NoSpawnsYet = ({ compact = false, hint }: { compact?: boolean; hint?: ReactNode }) => (
  <div className={`empty launch-empty ${compact ? "compact" : ""}`}>
    <span className="launch-empty-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="13" r="5" /><circle cx="17" cy="7" r="1.6" /><circle cx="19.5" cy="12" r="1.2" /><circle cx="15" cy="18.5" r="1.2" /></svg></span>
    <b>Nothing launched yet — launch the first coin</b>
    <p>{hint ?? "Spore lists coins launched here; the map shows every pump.fun pair. The first coin of a tree is launched with SOL; every coin after that can grow under it."}</p>
    <div className="empty-action"><Link to="/launch" className="btn accent">Launch a coin</Link><Link to="/how" className="btn ghost">How it works</Link></div>
  </div>
);
/// A failed load in plain words with Retry. `details` is the raw server or network text, kept behind a
/// "details" toggle so a reader never meets JSON or a URL unasked.
export const ErrorBox = ({ error, retry, compact = false, details }: { error: string; retry?: () => void; compact?: boolean; details?: string | null }) => (
  <div className={`notice bad error-box ${compact ? "compact" : ""}`} role="alert">
    <span className="error-box-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="8.5" strokeDasharray="2 3" /><circle cx="12" cy="12" r="2.6" /><path d="M12 3.5V6M12 18v2.5" /></svg></span>
    <span className="error-box-text"><b>Could not load.</b> {error}
      {details && <details className="error-details"><summary>details</summary><code>{details}</code></details>}
    </span>
    {retry && <button type="button" className="btn sm ghost" onClick={retry}>Retry</button>}
  </div>
);
