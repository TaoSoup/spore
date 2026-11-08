// Where a live pair lands (DESIGN §11.5; owner 2026-10-20 "clean, like Bubblemaps"): positions are
// data, not a simulation, so a new coin is put next to its parent by one deterministic rule and never
// relaxed. Candidate spots lie on rings around the parent, the first at r_parent + r_child + gap; on
// each ring the angles start on the far side of the parent from the family's top (a tree grows
// outward) and alternate left and right of it. A spot is taken when its disc overlaps none of the
// family's other bubbles and stays outside the top's disc; past the last ring the least-crowded
// candidate wins. Pure over typed arrays, no allocation beyond the result.
const GOLDEN = 2.399963, PAD = 2, TOP_GAP = 4, RINGS = 8, MAX_ANGLES = 64;

/// (x, y) for node i next to parent p. `top` is the family's top (p itself for a depth-1 coin),
/// `members` the family's node indices (i and p may be among them; they are skipped).
export function placeChild(x: ArrayLike<number>, y: ArrayLike<number>, r: ArrayLike<number>, i: number, p: number, top: number, members: ArrayLike<number>, gap: number): [number, number] {
  const px = x[p], py = y[p], rp = r[p], ri = r[i];
  // outward: from the top to the parent; a child of the top itself fans out by its index (golden angle)
  let ox = 0, oy = 0;
  if (top !== p && top >= 0 && Number.isFinite(x[top]) && Number.isFinite(y[top])) { ox = px - x[top]; oy = py - y[top]; }
  const base = ox || oy ? Math.atan2(oy, ox) : (i * GOLDEN) % (Math.PI * 2);
  const tx = top >= 0 ? x[top] : NaN, ty = top >= 0 ? y[top] : NaN, tr = top >= 0 ? r[top] : 0;
  let bestX = px + Math.cos(base) * (rp + ri + gap), bestY = py + Math.sin(base) * (rp + ri + gap), bestHits = Infinity;
  for (let ring = 0; ring < RINGS; ring++) {
    const dist = rp + ri + gap + ring * (2 * ri + gap);
    const n = Math.min(MAX_ANGLES, Math.max(12, Math.round((Math.PI * 2 * dist) / (2 * ri + gap))));
    const step = (Math.PI * 2) / n;
    for (let q = 0; q < n; q++) {
      // 0, +1, -1, +2, -2 … steps away from the outward direction
      const k = (q + 1) >> 1, a = base + (q & 1 ? -k : k) * step;
      const cx = px + Math.cos(a) * dist, cy = py + Math.sin(a) * dist;
      let hits = 0;
      if (top !== p && top >= 0 && tx === tx) { const dx = cx - tx, dy = cy - ty, min = tr + ri + TOP_GAP; if (dx * dx + dy * dy < min * min) hits++; }
      for (let m = 0; m < members.length && hits <= bestHits; m++) {
        const j = members[m];
        if (j === i || j === p) continue;
        const jx = x[j], jy = y[j];
        if (jx !== jx || jy !== jy) continue;
        const dx = cx - jx, dy = cy - jy, min = ri + r[j] + PAD;
        if (dx * dx + dy * dy < min * min) hits++;
      }
      if (hits === 0) return [cx, cy];
      if (hits < bestHits) { bestHits = hits; bestX = cx; bestY = cy; }
    }
  }
  return [bestX, bestY];
}
