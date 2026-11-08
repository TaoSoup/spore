// The illustrative family tree (a root, three children, grandchildren) used by the empty launchpad on
// the front page. The live hero tree that lived here became the colony (components/hero, elevation
// 2026-10-24), which loads the same data and adds the 3D scene and its drawn fallback.

/// Illustrative tree for the empty and error states: a root, three children, a few grandchildren.
/// Static shapes with placeholder tickers; nothing here is live data.
export function TreePreview() {
  const root = { x: 220, y: 64, r: 34 };
  const kids = [{ x: 100, y: 172, r: 24 }, { x: 220, y: 184, r: 28 }, { x: 342, y: 168, r: 20 }];
  const grand = [{ x: 58, y: 258, r: 11, p: 0 }, { x: 128, y: 262, r: 9, p: 0 }, { x: 196, y: 268, r: 12, p: 1 }, { x: 262, y: 270, r: 9, p: 1 }, { x: 318, y: 252, r: 10, p: 2 }, { x: 380, y: 246, r: 8, p: 2 }];
  const bubble = (n: { x: number; y: number; r: number }, tone: string, key: string, label?: string) => (
    <g key={key} className={`tp-node ${tone}`}>
      <circle className="tp-pulse" cx={n.x} cy={n.y} r={n.r * 1.9} />
      <circle className="tp-ring" cx={n.x} cy={n.y} r={n.r} />
      {label && <text x={n.x} y={n.y + n.r + 17} textAnchor="middle">{label}</text>}
    </g>
  );
  return (
    <figure className="tree-preview">
      <svg viewBox="0 0 440 300" role="img" aria-label="Illustration of a coin family tree: a root coin, children priced in it, grandchildren under those; every buy flows up to the root">
        {kids.map((k, i) => <line key={`l${i}`} className="tp-edge kid" x1={k.x} y1={k.y} x2={root.x} y2={root.y} />)}
        {grand.map((g, i) => <line key={`g${i}`} className="tp-edge grand" x1={g.x} y1={g.y} x2={kids[g.p].x} y2={kids[g.p].y} />)}
        {grand.map((g, i) => bubble(g, "grand", `gb${i}`))}
        {kids.map((k, i) => bubble(k, "kid", `kb${i}`, "$CHILD"))}
        {bubble(root, "root", "root", "$ROOT")}
      </svg>
      <figcaption>Illustration · buys flow up, parent coins lock in the child's curve</figcaption>
    </figure>
  );
}
