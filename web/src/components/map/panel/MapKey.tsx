// The /map key: what colours, rings, sizes and motion mean. Collapsed by default to one line (depth
// swatches + "Key"); the size section draws three nested reference circles at 1-2-5 values at their TRUE
// on-screen size for the current zoom (worldRadius(v) · k), so a bubble can be read against them. A
// tree's centre bubble (its top) is sized by the whole family's value, every other coin by its own market
// cap (lib/map/sizing.ts; SIZE_MODE_LINE says it in one line per mode).
// `renderer="three"` (the WebGL map, components/map3) explains that map instead: colour = last trade,
// a family's chip = its share of value (true chip sizes from the engine), coins = market cap at this
// zoom, the rim's bright arc = trades in 24 h, and the live motion. `look="galaxy"` (behind ?look=galaxy; the flat
// plate is the default) swaps the trade classes for the galaxy palette and the rim row for the ring; `look="flat"` is the key above.
import { useState, type CSSProperties } from "react";
import { usd } from "../../../lib/format";
import { sharePct } from "../../../lib/map/dominance";
import { SIZE_MODE_LINE } from "../../../lib/map/sizing";
import type { SizeMode } from "../../../lib/map/types";
import { COLORS } from "../store";
import { useCamK, type CamStore } from "./cam";

const MAX_PX = 34, MIN_PX = 2.5;
const NICE = [1, 2, 5];

/// The three largest 1-2-5 values whose circle still fits the key at this zoom, smallest first.
export function sizeRefs(screenR: (v: number) => number): { v: number; r: number }[] {
  const seq: { v: number; r: number }[] = [];
  for (let e = 0; e <= 10; e++) for (const m of NICE) { const v = m * 10 ** e; const r = screenR(v); if (Number.isFinite(r)) seq.push({ v, r }); }
  const fit = seq.filter((x) => x.r <= MAX_PX && x.r >= MIN_PX);
  const out: { v: number; r: number }[] = [];
  for (let i = fit.length - 1; i >= 0 && out.length < 3; i--) if (!out.length || out[out.length - 1].r - fit[i].r > 0.75) out.push(fit[i]);
  return out.reverse();
}

function SizeKey({ mode, cam, worldRadius }: { mode: SizeMode; cam: CamStore; worldRadius: (v: number) => number }) {
  const k = useCamK(cam);
  // worldRadius is 0 until the map has sized its bubbles: draw nothing rather than a wrong scale.
  const ready = worldRadius(1e9) > 0;
  const refs = ready ? sizeRefs((v) => worldRadius(v) * k) : [];
  if (!ready) return null;
  const W = 150, H = MAX_PX * 2 + 4, cx = MAX_PX + 2;
  // Largest circle first; each label sits level with its circle's top, pushed down to keep 11 px apart.
  const big = refs.slice().reverse();
  const labelY: number[] = [];
  for (const x of big) { const top = H - 1 - 2 * x.r; labelY.push(Math.max(labelY.length ? labelY[labelY.length - 1] + 11 : 8, top + 3)); }
  return (
    <section className="map-key-sec">
      <h4>Size <span>family centre = {mode === "locked" ? "locked value" : "market cap"}</span></h4>
      <p className="map-key-note">{SIZE_MODE_LINE[mode]}</p>
      {refs.length === 0
        ? <p className="map-key-note">Zoomed in past the key: every bubble here is larger than {MAX_PX * 2} px.</p>
        : (
          <svg className="map-key-size" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Reference sizes at this zoom: ${refs.map((x) => usd(x.v)).join(", ")}`}>
            {big.map((x) => <circle key={x.v} cx={cx} cy={H - 1 - x.r} r={x.r} />)}
            {big.map((x, i) => { const y = H - 1 - 2 * x.r; const ty = labelY[i]; return <g key={x.v}><path d={`M${cx} ${y}H${cx + MAX_PX + 8}L${cx + MAX_PX + 12} ${ty - 3}`} /><text x={cx + MAX_PX + 16} y={ty}>{usd(x.v)}</text></g>; })}
          </svg>
        )}
      <p className="map-key-note">a family centre at its true size for this zoom</p>
    </section>
  );
}

const Swatch = ({ d }: { d: number }) => <i className="map-key-sw" style={{ background: COLORS[d], boxShadow: `0 0 8px ${COLORS[d]}` }} />;

// ---- the WebGL map (renderer="three")

/// Last-trade classes as the map draws its small coins (flat discs, no glow).
const TRADE: { c: string; t: string }[] = [
  { c: "#aaef56", t: "within 30 min" },
  { c: "#4d98b9", t: "within 3 h" },
  { c: "#666c8b", t: "within 24 h" },
  { c: "#4a514e", t: "older" },
];
const Dot = ({ c }: { c: string }) => <i className="map-key-sw" style={{ background: c }} />;
/// The galaxy look's last-trade classes (the engine's GAL palette): lit spheres by recency; the live one glows.
const GAL_TRADE: { c: string; t: string; glow?: boolean }[] = [
  { c: "#b6ff5c", t: "traded < 30 min", glow: true },
  { c: "#5ce0c8", t: "cooling < 3 h" },
  { c: "#7f68c4", t: "quiet < 24 h" },
  { c: "#4a4466", t: "cold" },
];
/// The last-trade classes drawn as a recency filament: one hairline from the freshest colour to the coldest,
/// a node per class (the live one with its halo), the words under each node. Same colours as the engine.
function TradeScale({ items, label }: { items: { c: string; t: string; glow?: boolean }[]; label: string }) {
  const grad = `linear-gradient(90deg, ${items.map((x) => x.c).join(", ")})`;
  return (
    <ol className="map-key-scale" aria-label={label} style={{ "--scale": grad } as CSSProperties}>
      {items.map((x, i) => (
        <li key={x.c} className={i === 0 ? "hot" : ""} style={{ "--c": x.c } as CSSProperties}>
          <i className="map-key-node" aria-hidden="true" />
          <span>{x.t}</span>
        </li>
      ))}
    </ol>
  );
}
const CHIP_SHARES = [0.25, 0.05, 0.01];
/// Coin reference circles start here: below it the engine draws coins on a steeper scale than rad().
const COIN_MIN_V = 1e4;

/// Nested reference circles, largest first, labels level with their tops (SizeKey's drawing). The box is
/// as tall as its content: at the overview the WebGL map's coins are a few px, and a fixed 72 px box
/// left them at the bottom of an empty area with the 11 px label stack running past its bottom edge.
function RefCircles({ refs }: { refs: { v: number; r: number }[] }) {
  const big = refs.slice().reverse();
  const rMax = big.length ? big[0].r : 0;
  const W = 150, H = Math.ceil(Math.max(2 * rMax + 4, 11 * big.length + 6)), cx = Math.max(MAX_PX * 0.6, rMax) + 2;
  const labelY: number[] = [];
  for (const x of big) { const top = H - 1 - 2 * x.r; labelY.push(Math.max(labelY.length ? labelY[labelY.length - 1] + 11 : 11, top + 3)); }
  // keep the stack inside the box: the last baseline 4 px above the bottom, the ones above it 11 px apart
  for (let i = labelY.length - 1; i >= 0; i--) labelY[i] = Math.min(labelY[i], i === labelY.length - 1 ? H - 4 : labelY[i + 1] - 11);
  return (
    <svg className="map-key-size" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Coin sizes at this zoom: ${refs.map((x) => usd(x.v)).join(", ")}`}>
      {big.map((x) => <circle key={x.v} cx={cx} cy={H - 1 - x.r} r={x.r} />)}
      {big.map((x, i) => { const y = H - 1 - 2 * x.r; const ty = labelY[i], lx = cx + rMax + 8; return <g key={x.v}><path d={`M${cx} ${y}H${lx}L${lx + 4} ${ty - 3}`} /><text x={lx + 8} y={ty}>{usd(x.v)}</text></g>; })}
    </svg>
  );
}

/// Family chips at three shares (their true size: chips do not scale with zoom), then coins by market cap
/// at their true size for the current zoom.
function ThreeSizeKey({ mode, cam, worldRadius, chipRadius }: { mode: SizeMode; cam: CamStore; worldRadius: ((v: number) => number) | null; chipRadius: ((share: number) => number) | null }) {
  const k = useCamK(cam);
  const word = mode === "locked" ? "locked value" : "market cap";
  const chips = chipRadius && chipRadius(0.01) > 0 ? CHIP_SHARES.map((s) => ({ s, r: chipRadius(s) })) : [];
  // A coin circle only where the radius still grows with the value: below COIN_MIN_V the drawn size is
  // not rad(), and at the engine's cap every larger value would be labelled on the same circle.
  const coinR = (v: number) => {
    if (!worldRadius || v < COIN_MIN_V) return NaN;
    const r = worldRadius(v);
    return r > worldRadius(v / 2) + 1e-9 ? r * k : NaN;
  };
  const refs = worldRadius && worldRadius(1e9) > 0 ? sizeRefs(coinR) : [];
  const maxR = chips.reduce((m, c) => Math.max(m, c.r), 0);
  const chipH = Math.ceil(2 * maxR) + 16;
  let x = 2;
  const placed = chips.map((c) => { const slot = Math.max(c.r, 14); const cx = x + slot; x += 2 * slot + 10; return { ...c, cx }; });
  const chipW = Math.ceil(x);
  return (
    <section className="map-key-sec">
      <h4>Size <span>chip = share of {word}</span></h4>
      <p className="map-key-note">{SIZE_MODE_LINE[mode]}</p>
      {placed.length > 0 && (
        <svg className="map-key-size" width={chipW} height={chipH} viewBox={`0 0 ${chipW} ${chipH}`} role="img" aria-label={`Family chips at ${chips.map((c) => sharePct(c.s)).join(", ")} of ${word}`}>
          {placed.map((c) => <g key={c.s}><circle cx={c.cx} cy={1 + 2 * maxR - c.r} r={c.r} /><text x={c.cx} y={chipH - 2} textAnchor="middle">{sharePct(c.s)}</text></g>)}
        </svg>
      )}
      <p className="map-key-note">coin = market cap</p>
      {refs.length > 0 ? <RefCircles refs={refs} /> : <p className="map-key-note">zoom in to compare coin sizes</p>}
      <p className="map-key-note">chips keep their size at every zoom; coins grow as you zoom in</p>
    </section>
  );
}

/// `variant="dock"`: the collapsible card at the bottom left of a wide map. `variant="pop"`: the body only,
/// for the phone popover the page opens from its "Key" pill. `renderer` picks which map it explains;
/// `chipRadius` (the WebGL map's planet-chip radius for a share, CSS px) draws the chip sizes.
export default function MapKey({ mode, cam, worldRadius, variant = "dock", defaultOpen = false, renderer = "classic", chipRadius = null, look = "flat" }: { mode: SizeMode; cam: CamStore; worldRadius: ((v: number) => number) | null; variant?: "dock" | "pop"; defaultOpen?: boolean; renderer?: "classic" | "three"; chipRadius?: ((share: number) => number) | null; look?: "galaxy" | "flat" }) {
  const [open, setOpen] = useState(defaultOpen);
  const three = renderer === "three";
  const galaxy = three && look === "galaxy";
  const keys = (
    <section className="map-key-sec">
      <h4>Keys</h4>
      <dl className="map-key-keys">
        <dt>/</dt><dd>search</dd>
        <dt>← ↑ → ↓</dt><dd>walk the tree</dd>
        <dt>Enter</dt><dd>open coin</dd>
        <dt>L</dt><dd>launch under it</dd>
        <dt>F</dt><dd>frame its tree</dd>
        <dt>0 · + · −</dt><dd>whole map · zoom</dd>
        <dt>Esc</dt><dd>clear</dd>
      </dl>
    </section>
  );
  // the live-motion rows, shared by the flat and the galaxy keys
  const motion = (
    <>
      <section className="map-key-sec">
        <h4>Motion</h4>
        <ul className="map-key-list">
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17 17 3" stroke="#5ab0d6" strokeOpacity=".5" /><circle cx="11.5" cy="8.5" r="2.4" fill="#e9ffc9" /></svg> pulse along a link · a trade (hollow head = sell)</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="#b6ff5c" strokeOpacity=".55" /><circle cx="10" cy="10" r="3" fill="#171b1a" stroke="#b6ff5c" /></svg> ring · a new pair</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><text x="10" y="14" textAnchor="middle" fontSize="12" fill="#b6ff5c" style={{ fontFamily: "var(--mono)" }}>$</text></svg> $T +$12k · a trade of $10k or more</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#b6ff5c" fillOpacity=".12" /><circle cx="10" cy="10" r="6" fill="#171b1a" stroke="#b6ff5c" strokeOpacity=".9" /><circle cx="10" cy="10" r="2.6" fill="#c4ff74" /></svg> brighter coin · traded in the last minutes</li>
        </ul>
      </section>
      <section className="map-key-sec">
        <h4>Drag</h4>
        <ul className="map-key-list">
          <li>drag a coin (long-press on touch) · the map flows around it and settles back</li>
        </ul>
      </section>
    </>
  );
  const threeBody = (
    <div className="map-key-body" id="map-key-body">
      <section className="map-key-sec">
        <h4>Last trade <span>fresh → cold</span></h4>
        <TradeScale items={TRADE} label="Colour by last trade" />
      </section>
      <ThreeSizeKey mode={mode} cam={cam} worldRadius={worldRadius} chipRadius={chipRadius} />
      <section className="map-key-sec">
        <h4>Rim</h4>
        <ul className="map-key-list">
          <li><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="#223c47" stroke="#5ab0d6" strokeOpacity=".45" /><path d="M8 2.5A5.5 5.5 0 1 1 2.83 9.88" fill="none" stroke="#5ab0d6" strokeWidth="1.5" /></svg> bright arc = trades in 24 h</li>
        </ul>
      </section>
      {motion}
      {keys}
    </div>
  );
  // the galaxy look (?look=galaxy; the default flat look draws threeBody): lit spheres by last trade, a rim ring by 24 h trades
  const galaxyBody = (
    <div className="map-key-body" id="map-key-body">
      <section className="map-key-sec">
        <h4>Last trade <span>fresh → cold</span></h4>
        <TradeScale items={GAL_TRADE} label="Colour by last trade" />
      </section>
      <section className="map-key-sec">
        <h4>Rings</h4>
        <ul className="map-key-list">
          <li><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="#1f3a2a" stroke="#b6ff5c" strokeOpacity=".9" /><circle cx="8" cy="8" r="6.8" fill="none" stroke="#b6ff5c" strokeOpacity=".55" strokeWidth="1.4" /></svg> ring = 24 h trades · size = market cap (log)</li>
        </ul>
      </section>
      <ThreeSizeKey mode={mode} cam={cam} worldRadius={worldRadius} chipRadius={chipRadius} />
      {motion}
      {keys}
    </div>
  );
  const body = three ? (galaxy ? galaxyBody : threeBody) : (
    <div className="map-key-body" id="map-key-body">
      <section className="map-key-sec">
        <h4>Colour</h4>
        <ul className="map-key-list">
          <li><Swatch d={0} /> root coin · ringed at its tree's centre</li>
          <li><Swatch d={1} /> d1 · paired under a root</li>
          <li><Swatch d={2} /> d2 · paired under a d1</li>
        </ul>
      </section>
      <section className="map-key-sec">
        <h4>Rings</h4>
        <ul className="map-key-list">
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="var(--accent)" strokeOpacity=".35" /><circle cx="10" cy="10" r="6" fill="none" stroke="var(--accent)" strokeWidth="1.6" /><circle cx="10" cy="10" r="3.5" fill="#5ce0c8" /></svg> launched on Spore</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="#5ce0c8" fillOpacity=".5" stroke="#5ce0c8" /><circle cx="14.95" cy="5.05" r="2" fill="#eef6ef" /></svg> graduated (dot on the rim)</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeDasharray="3 2.5" /></svg> selected</li>
        </ul>
      </section>
      {worldRadius ? <SizeKey mode={mode} cam={cam} worldRadius={worldRadius} /> : null}
      <section className="map-key-sec">
        <h4>Motion</h4>
        <ul className="map-key-list">
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="#b6ff5c" /><circle cx="10" cy="10" r="6" fill="none" stroke="#b6ff5c" strokeOpacity=".7" /><circle cx="10" cy="10" r="9" fill="none" stroke="#b6ff5c" strokeOpacity=".3" /></svg> ring grows outward · buy</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="#ff5c8a" /><circle cx="10" cy="10" r="6" fill="none" stroke="#ff5c8a" strokeOpacity=".7" /><circle cx="10" cy="10" r="9" fill="none" stroke="#ff5c8a" strokeOpacity=".3" strokeDasharray="2 2" /></svg> ring shrinks inward · sell</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 16 14 6" stroke="#b6ff5c" strokeOpacity=".45" strokeWidth="1.6" strokeLinecap="round" /><circle cx="14.5" cy="5.5" r="2.4" fill="#b6ff5c" /></svg> comet · a buy routed through the parent</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10H18" stroke="var(--line-2)" /><circle cx="6" cy="10" r="1.6" fill="var(--accent)" /><circle cx="13" cy="10" r="1.6" fill="var(--accent)" /></svg> dots · pair traded in the last 30 min</li>
        </ul>
      </section>
      {keys}
    </div>
  );
  if (variant === "pop") return <div className="map-key pop">{body}</div>;
  return (
    <div className={`map-key dock ${open ? "open" : ""}`}>
      <button type="button" className="map-key-toggle" aria-expanded={open} aria-controls="map-key-body" onClick={() => setOpen((o) => !o)}>
        <span className="map-key-sws" aria-hidden="true">{three ? (galaxy ? GAL_TRADE : TRADE).map((x) => <Dot key={x.c} c={x.c} />) : <><Swatch d={0} /><Swatch d={1} /><Swatch d={2} /></>}</span>
        Key
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d={open ? "M2 3.5 5 6.5 8 3.5" : "M2 6.5 5 3.5 8 6.5"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      {open && body}
    </div>
  );
}
