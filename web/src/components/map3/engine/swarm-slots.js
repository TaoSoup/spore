// swarm-slots.js (family-all, ENGINE lane; DESIGN-FAMILY-ALL.md §2 "Ghost dust", §5.1): the slot field of a capped asset
// family. Pure: no three, no DOM, no S. Everything is deterministic in (top mint, the drawn members, n), so two mounts of the
// same payload place every slot on the same spot (swarmCheck's hash).
//
// EXPORTS
//   fnv1a(str) -> uint32                    the seed of a family (FNV-1a over the UTF-16 code units of its top mint)
//   hash01(a, b) -> [0, 1)                  integer hash of (seed, index), for the jitter and the samples
//   thinRank(seed, j) -> [0, 1)             slot j's thinning rank: the shader shows slot j when its rank is under the zoom's
//                                           share (more dots as you zoom in, a hash so a thinned spiral never forms spokes)
//   strideOf(ghost, cap) -> int >= 1        ceil(ghost / cap): how many ghosts share one shown dot under a tier cap
//   rankCut(seed, n, cap) -> tau            the rank threshold that shows at most `cap` of slots 0..n-1 (1 when n <= cap)
//   createSlotBuilder(o) -> {step(deadline) -> done, result()}   the sliceable form (swarm.js runs it in <= 8 ms slices)
//   buildSlots(o) -> result                 the same, run to completion (unit tests, small families)
//     o = {cx, cy, r0, r1, n, seed, members: {x, y, r}[] (world, absolute; the top may be one of them), clear, ramp, fit}
//     result = {x, y: Float32Array(n) relative to (cx, cy), anchor: Int32Array(n) (index into o.members, -1 = none), n,
//               spacing (the densest slot spacing, world u), spacingMean, p (mean acceptance), candidates, pass2,
//               overlaps, ms, r0, r1 (the fitted outer radius), r95}
//   buildPointGrid(x, y, n, cell) -> grid    CSR grid over points (the pick grid of the real specks)
//   nearestInGrid(grid, x, y, maxD, accept) -> index | -1
//   slotsHash(x, y, n) -> uint32            positions quantised to 1/100 u
//   countInDiscs(x, y, n, discs: {x, y, r}[]) -> how many points sit inside any disc (swarmCheck's onDrawn)
//
// THE FIELD (fix round, critic-visual: the old field filled the whole 0.97 Rc disc evenly, a halo ring outside the drawn
// coins and a perfect circle for every family, with hard craters around each drawn coin). Now the slots follow the drawn
// silhouette:
//   - fit: r1 = min(o.r1, rMax + 2 s0), rMax = the outermost member extent |m - c| + R from the centre (r95, the 95th
//     percentile, sizes s0 = the mean slot spacing over the r95 disc; r95 + 2 s0 cut an uneven silhouette's lobes on a circle). Candidates fill the annulus r0 .. r1 (an area-true Vogel spiral, golden-angle steps, a
//     seeded angle offset, +-0.35 candidate-spacing radial / angular jitter seeded by (seed, candidate index)).
//   - acceptance per candidate = w x taper x ramp, drawn against a seeded hash (so the field thins, it never fades):
//       w      a coarse density map of the drawn members (counts on a grid of ~one member spacing, box-blurred twice, i.e.
//              smoothed over 2-3 member spacings), divided by 0.6 x the median of its positive cells inside r95 and clamped
//              to 1: uniform where the family has coins, thinning out where it has few, 0 well outside its silhouette;
//       taper  1 -> 0 over the last max(3 s0, 0.06 r1) before r1 (no hard circle even where w is still 1 at r1);
//       ramp   0 inside a member's disc + clear (hard, 0.3 u by default: such a candidate is never accepted), then 0 -> 1
//              (smoothstep) over min(`ramp` x s0, member spacing / 3) + R / 2 outside it: the grain thins out as it nears a
//              seed head, no crater edge (the cap keeps a family with more drawn coins than room from ramping its area away).
//     The mean acceptance p over the annulus comes from 4,096 seeded area-uniform samples; the spiral has ceil(1.05 n / p)
//     candidates, so the n slots keep the drawn silhouette's shape and only get denser inside it.
//   - when the candidates run out: a second pass on the half-offset spiral (index + 0.5) with the same acceptance; then the
//     candidates that lost the draw (positive acceptance first, then zero), then the hard-cleared ones, counted as overlaps.
//   - slot order = the spiral parameter (inner -> outer), so slot j is the j-th undrawn coin in server order (the biggest
//     innermost) and a ghost -> real hand-off never moves a speck.
//   - anchor: each slot's nearest drawn member by edge distance (|p - m| - R); swarm.js moves the slot with that member's
//     drag displacement, so the grain trails with its chain.
//   - spacing = the candidate spacing sqrt(pi (r1^2 - r0^2) / candidates): the slot spacing where the acceptance is 1, i.e.
//     the densest part of the field (the shader thins by it so the densest part never shows dots closer than its minimum).

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;
const SAMPLES = 4096;
const OVERSHOOT = 1.05;
const JITTER = 0.35;
const RANK_SALT = 0x5bd1e995, ACC_SALT = 0x27d4eb2f, ACC2_SALT = 0x165667b1;
const RANK_BINS = 4096;
const RAMP_MSP = 1 / 3, RAMP_R = 0.5;   // ramp width cap (x member spacing) and the share of a member's radius it adds
const DENS_REF = 0.6;   // w saturates at 0.6 x the median positive density: uniform over the family, thinner only where it is sparse

export function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// a 32-bit integer mix (lowbias32) of (a, b) -> [0, 1)
export function hash01(a, b) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function thinRank(seed, j) { return hash01((seed ^ RANK_SALT) | 0, j); }

export function strideOf(ghost, cap) {
  if (!(ghost > 0)) return 1;
  if (!(cap > 0)) return Math.max(1, Math.ceil(ghost));
  return Math.max(1, Math.ceil(ghost / cap));
}

// the rank threshold tau such that #{j < n : thinRank(seed, j) < tau} <= cap (a 4,096-bin histogram: the count lands within
// one bin, ~n / 4096, under the cap); 1 when everything fits
export function rankCut(seed, n, cap) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  if (!(cap >= 0) || n <= cap) return 1;
  if (cap <= 0) return 0;
  const h = new Int32Array(RANK_BINS);
  for (let j = 0; j < n; j++) h[Math.min(RANK_BINS - 1, Math.floor(thinRank(seed, j) * RANK_BINS))]++;
  let c = 0;
  for (let b = 0; b < RANK_BINS; b++) { if (c + h[b] > cap) return b / RANK_BINS; c += h[b]; }
  return 1;
}

// ---------- the occupancy grid (member discs inflated by `pad`, CSR) ----------
function buildDiscGrid(mx, my, mr, m, cell, x0, y0, x1, y1, pad = 0) {
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), ny = Math.max(1, Math.ceil((y1 - y0) / cell));
  const count = new Int32Array(nx * ny + 1);
  const span = (q, cb) => {
    const r = mr[q] + pad;
    const gx0 = Math.max(0, Math.floor((mx[q] - r - x0) / cell)), gx1 = Math.min(nx - 1, Math.floor((mx[q] + r - x0) / cell));
    const gy0 = Math.max(0, Math.floor((my[q] - r - y0) / cell)), gy1 = Math.min(ny - 1, Math.floor((my[q] + r - y0) / cell));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) cb(gy * nx + gx);
  };
  for (let q = 0; q < m; q++) span(q, (c) => { count[c + 1]++; });
  for (let c = 0; c < nx * ny; c++) count[c + 1] += count[c];
  const fill = count.slice(0, nx * ny), items = new Int32Array(count[nx * ny]);
  for (let q = 0; q < m; q++) span(q, (c) => { items[fill[c]++] = q; });
  return { cell, x0, y0, nx, ny, start: count, items, mx, my, mr };
}
function discHit(g, x, y) {
  const gx = Math.floor((x - g.x0) / g.cell), gy = Math.floor((y - g.y0) / g.cell);
  if (gx < 0 || gy < 0 || gx >= g.nx || gy >= g.ny) return false;
  const c = gy * g.nx + gx;
  for (let e = g.start[c], end = g.start[c + 1]; e < end; e++) {
    const q = g.items[e], dx = x - g.mx[q], dy = y - g.my[q], r = g.mr[q];
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}
// the ramp factor at p over the members listed in p's cell (the grid spans each member's disc + clear + its ramp width, so
// every member whose zone covers p is listed): -1 inside a disc + clear, else min over members of smoothstep((e - clear) / w)
// with e = |p - m| - R; 1 when none is in reach
function rampAt(g, x, y, clear) {
  const gx = Math.floor((x - g.x0) / g.cell), gy = Math.floor((y - g.y0) / g.cell);
  if (gx < 0 || gy < 0 || gx >= g.nx || gy >= g.ny) return 1;
  const c = gy * g.nx + gx;
  let a = 1;
  for (let k = g.start[c], end = g.start[c + 1]; k < end; k++) {
    const q = g.items[k], dx = x - g.mx[q], dy = y - g.my[q], d2 = dx * dx + dy * dy, rz = g.mr[q];
    if (d2 >= rz * rz) continue;                       // outside the member's zone (disc + clear + ramp)
    const e = Math.sqrt(d2) - g.rt[q] - clear;
    if (e < 0) return -1;
    const w = g.rw[q];
    if (e < w) { const t = e / w, s = t * t * (3 - 2 * t); if (s < a) a = s; }
  }
  return a;
}

// ---------- the anchor search: nearest member by edge distance ----------
// small members (R <= cell) on a CSR centre grid searched in growing square rings; the few big ones checked one by one
function buildAnchorGrid(mx, my, mr, m, cell, ext) {
  const small = [], big = [];
  for (let q = 0; q < m; q++) (mr[q] > cell ? big : small).push(q);
  const x0 = -ext - cell, y0 = -ext - cell;
  const nx = Math.max(1, Math.min(1024, Math.ceil((2 * ext + 2 * cell) / cell))), ny = nx;
  const cw = (2 * ext + 2 * cell) / nx;
  const cellOf = (q) => {
    const gx = Math.max(0, Math.min(nx - 1, Math.floor((mx[q] - x0) / cw))), gy = Math.max(0, Math.min(ny - 1, Math.floor((my[q] - y0) / cw)));
    return gy * nx + gx;
  };
  const start = new Int32Array(nx * ny + 1);
  let rMaxS = 0;
  for (const q of small) { start[cellOf(q) + 1]++; if (mr[q] > rMaxS) rMaxS = mr[q]; }
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * ny), items = new Int32Array(small.length);
  for (const q of small) items[fill[cellOf(q)]++] = q;
  return { x0, y0, cw, nx, ny, start, items, big: Int32Array.from(big), rMaxS, nSmall: small.length, mx, my, mr };
}
// the member of cell c closer (by edge) than bd, or -1; the new best distance is left in g.bd
function scanCell(g, c, x, y, bd) {
  let best = -1;
  for (let e = g.start[c], end = g.start[c + 1]; e < end; e++) {
    // only a member whose centre is within bd + R can beat bd: squared test first (no sqrt for the rest)
    const q = g.items[e], dx = x - g.mx[q], dy = y - g.my[q], d2 = dx * dx + dy * dy, lim = bd + g.mr[q];
    if (lim <= 0 || d2 >= lim * lim) continue;
    const d = Math.sqrt(d2) - g.mr[q];
    if (d < bd) { bd = d; best = q; }
  }
  g.bd = bd;
  return best;
}
function nearestEdge(g, x, y) {
  let best = -1, bd = Infinity;
  for (let k = 0; k < g.big.length; k++) {
    const q = g.big[k], dx = x - g.mx[q], dy = y - g.my[q], d = Math.sqrt(dx * dx + dy * dy) - g.mr[q];
    if (d < bd) { bd = d; best = q; }
  }
  if (!g.nSmall) return best;
  const gx = Math.max(0, Math.min(g.nx - 1, Math.floor((x - g.x0) / g.cw))), gy = Math.max(0, Math.min(g.ny - 1, Math.floor((y - g.y0) / g.cw)));
  const maxRing = Math.max(g.nx, g.ny);
  for (let ring = 0; ring <= maxRing; ring++) {
    // every point of a ring-`ring` cell is >= (ring - 1) cells away (centre distance), so its edge distance is >= that - rMax
    if (best >= 0 && (ring - 1) * g.cw - g.rMaxS > bd) break;
    const ya = gy - ring, yb = gy + ring, xa = gx - ring, xb = gx + ring;
    for (let cy = Math.max(0, ya); cy <= Math.min(g.ny - 1, yb); cy++) {
      if (cy === ya || cy === yb) { for (let cx = Math.max(0, xa); cx <= Math.min(g.nx - 1, xb); cx++) { const r = scanCell(g, cy * g.nx + cx, x, y, bd); if (r >= 0) { best = r; bd = g.bd; } } }
      else {
        if (xa >= 0) { const r = scanCell(g, cy * g.nx + xa, x, y, bd); if (r >= 0) { best = r; bd = g.bd; } }
        if (ring > 0 && xb < g.nx) { const r = scanCell(g, cy * g.nx + xb, x, y, bd); if (r >= 0) { best = r; bd = g.bd; } }
      }
    }
  }
  return best;
}

// ---------- the density map (counts per ~member-spacing cell, box-blurred twice) ----------
function buildDensity(mx, my, m, ext, cell) {
  const span0 = 2 * ext + 4 * cell;
  let nx = Math.ceil(span0 / cell);
  if (nx > 256) { cell = span0 / 256; nx = 256; }
  nx = Math.max(4, nx);
  const x0 = -0.5 * nx * cell, ny = nx;
  let a = new Float32Array(nx * ny), b = new Float32Array(nx * ny);
  for (let q = 0; q < m; q++) {
    const gx = Math.floor((mx[q] - x0) / cell), gy = Math.floor((my[q] - x0) / cell);
    if (gx >= 0 && gy >= 0 && gx < nx && gy < ny) a[gy * nx + gx] += 1;
  }
  // separable 3-tap box, twice: a [1 2 3 2 1] / 9 kernel per axis (smoothed over 2-3 member spacings)
  for (let it = 0; it < 2; it++) {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      b[i] = (a[i] + (x > 0 ? a[i - 1] : 0) + (x < nx - 1 ? a[i + 1] : 0)) / 3;
    }
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      a[i] = (b[i] + (y > 0 ? b[i - nx] : 0) + (y < ny - 1 ? b[i + nx] : 0)) / 3;
    }
  }
  b = null;
  return { x0, cell, nx, ny, v: a, ref: 1 };
}
function densityAt(D, x, y) {
  const fx = (x - D.x0) / D.cell - 0.5, fy = (y - D.x0) / D.cell - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
  const at = (gx, gy) => (gx < 0 || gy < 0 || gx >= D.nx || gy >= D.ny ? 0 : D.v[gy * D.nx + gx]);
  const v = (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
  return Math.min(1, v / D.ref);
}

const smoothstep01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ---------- the builder ----------
export function createSlotBuilder(o) {
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const t0 = now();
  let spent = 0;
  const n = Math.max(0, Math.floor(Number(o.n) || 0));
  const cx = Number(o.cx) || 0, cy = Number(o.cy) || 0;
  const r0 = Math.max(0, Number(o.r0) || 0);
  let r1max = Math.max(0, Number(o.r1) || 0);
  if (!(r1max > r0)) r1max = r0 + 1e-3;
  const seed = (o.seed >>> 0) || 1;
  const clear = Math.max(0, Number.isFinite(Number(o.clear)) ? Number(o.clear) : 0.3);
  const rampK = Math.max(0, Number.isFinite(Number(o.ramp)) ? Number(o.ramp) : 2);
  const fit = o.fit !== false;
  const x = new Float32Array(n), y = new Float32Array(n), anchor = new Int32Array(n).fill(-1);
  const res = { x, y, anchor, n, spacing: 0, spacingMean: 0, p: 1, candidates: 0, pass2: 0, overlaps: 0, ms: 0, r0, r1: r1max, r95: 0, ramp: 0, densityCells: 0 };
  if (n === 0) return { step: () => true, result: () => res, done: () => true, setupMs: () => 0 };

  // every member (anchors need them all), relative to the centre
  const list = Array.isArray(o.members) ? o.members : [];
  let m = 0;
  const mx = new Float32Array(list.length), my = new Float32Array(list.length), mr = new Float32Array(list.length), mi = new Int32Array(list.length);
  for (let q = 0; q < list.length; q++) {
    const p = list[q]; if (!p) continue;
    const px = Number(p.x) - cx, py = Number(p.y) - cy;
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    mx[m] = px; my[m] = py; mr[m] = Math.max(0, Number(p.r) || 0); mi[m] = q; m++;
  }

  // state filled by the setup phases
  let r1 = r1max, A = 0, s0 = 0, D = 0, msp = 0, taperW = 0, dens = null, grid = null, agrid = null, M = 0, sc = 0, th0 = 0;
  // acceptance at a point (relative) = pre x ramp: pre = taper x w (cheap), ramp = -1 inside a member's disc + clear (hard)
  const pre = (px, py, r) => {
    let a = r > r1 - taperW ? 1 - smoothstep01((r - (r1 - taperW)) / taperW) : 1;
    if (dens && a > 0) a *= densityAt(dens, px, py);
    return a;
  };
  const ramp = (px, py) => (grid ? rampAt(grid, px, py, clear) : 1);
  // the draw of candidate k against u: 1 accepted, 0 lost (positive acceptance), 2 lost (zero acceptance), 3 hard; the ramp
  // (the grid scan) only runs when u < pre, i.e. when the candidate can still pass
  const draw = (px, py, r, u) => {
    const a = pre(px, py, r);
    if (!(a > 0)) return 2;
    if (u >= a) return 0;
    const b = ramp(px, py);
    return b < 0 ? 3 : u < a * b ? 1 : 0;
  };
  // candidate k of pass `half` (0 or 0.5): base parameter t, jittered position
  const cand = (k, half, out) => {
    const kk = k + half, t = (kk + 0.5) / M;
    const jr = (hash01(seed, 4 * k + (half ? 2 : 0) + 101) - 0.5) * 2 * JITTER * sc;
    const ja = (hash01(seed, 4 * k + (half ? 3 : 1) + 101) - 0.5) * 2 * JITTER * sc;
    let r = Math.sqrt(r0 * r0 + A * Math.min(1, t)) + jr;
    r = Math.min(r1, Math.max(r0, r));
    const th = th0 + kk * GOLDEN + ja / Math.max(r, 1e-3);
    out[0] = r * Math.cos(th); out[1] = r * Math.sin(th); out[2] = t; out[3] = r;
    return out;
  };

  function setupA() {
    // the drawn silhouette's extent and the fitted outer radius
    let ext = 0;
    if (m) {
      const ds = new Float32Array(m);
      for (let q = 0; q < m; q++) ds[q] = Math.hypot(mx[q], my[q]) + mr[q];
      ds.sort();
      res.r95 = ds[Math.min(m - 1, Math.floor(0.95 * m))];
      ext = ds[m - 1];
    }
    const useFit = fit && m >= 4 && res.r95 > r0 + 1;
    const rr = useFit ? res.r95 : r1max;
    s0 = Math.sqrt((Math.PI * Math.max(1e-6, rr * rr - r0 * r0)) / n);
    // the outermost drawn extent + 2 s0 (r95 + 2 s0 cut the lobes of an uneven silhouette on a circle; the density map
    // already thins the grain where the outer 5 % are sparse)
    if (useFit) r1 = Math.min(r1max, Math.max(r0 + 1, ext + 2 * s0));
    if (!(r1 > r0)) r1 = r0 + 1e-3;
    res.r1 = r1;
    A = r1 * r1 - r0 * r0;
    // the ramp: `ramp` slot spacings, but never more than a third of the member spacing (a family with more drawn coins
    // than room would otherwise ramp its whole area away); each member adds half its radius (a seed head's big top fades
    // the grain over a wider ring than one of its 0.3 u dust coins)
    msp = m ? Math.sqrt((Math.PI * Math.max(1, res.r95) ** 2) / m) : r1;
    D = Math.min(rampK * s0, RAMP_MSP * msp); res.ramp = D;
    taperW = Math.min(0.5 * (r1 - r0), Math.max(3 * s0, 0.06 * r1));
    // the density map: ~one member spacing per cell over the members' disc
    if (useFit) {
      const cell = Math.max(msp, 2 * s0, r1 / 120, 0.5);
      dens = buildDensity(mx, my, m, Math.max(r1, Math.min(ext, r1 + 4 * cell)), cell);
      // normalise by the median positive cell inside r95: uniform where the family has coins
      const vals = [];
      for (let gy = 0; gy < dens.ny; gy++) for (let gx = 0; gx < dens.nx; gx++) {
        const v = dens.v[gy * dens.nx + gx]; if (!(v > 1e-6)) continue;
        const px = dens.x0 + (gx + 0.5) * dens.cell, py = dens.x0 + (gy + 0.5) * dens.cell;
        if (px * px + py * py <= res.r95 * res.r95) vals.push(v);
      }
      if (vals.length) { const fv = Float32Array.from(vals).sort(); dens.ref = Math.max(1e-6, DENS_REF * fv[fv.length >> 1]); }
      res.densityCells = dens.nx * dens.ny;
    }
  }
  function setupB() {
    // the clearance / ramp grid: member discs inflated by clear + their ramp width (only members whose zone reaches the annulus)
    const gm = new Int32Array(m); let gn = 0, rs = 0;
    const rwOf = (q) => D + RAMP_R * mr[q];
    for (let q = 0; q < m; q++) {
      const d = Math.hypot(mx[q], my[q]), rz = mr[q] + clear + rwOf(q);
      if (d - rz > r1 || d + rz < r0) continue;
      gm[gn++] = q; rs += rz;
    }
    if (gn) {
      const gx = new Float32Array(gn), gy = new Float32Array(gn), gz = new Float32Array(gn), rt = new Float32Array(gn), rw = new Float32Array(gn);
      for (let k = 0; k < gn; k++) { const q = gm[k]; gx[k] = mx[q]; gy[k] = my[q]; rt[k] = mr[q]; rw[k] = Math.max(1e-6, rwOf(q)); gz[k] = mr[q] + clear + rwOf(q); }
      const cell = Math.max(0.75, Math.min(Math.max(1, r1 / 6), 1.2 * (rs / gn), (2 * r1) / 256));
      grid = buildDiscGrid(gx, gy, gz, gn, cell, -r1 - cell, -r1 - cell, r1 + cell, r1 + cell);
      grid.rt = rt; grid.rw = rw;
    }
    // the mean acceptance over the annulus (area-uniform seeded samples)
    let sum = 0;
    for (let q = 0; q < SAMPLES; q++) {
      const u = hash01(seed, 2 * q + 11), v = hash01(seed, 2 * q + 12);
      const r = Math.sqrt(r0 * r0 + A * u), th = TAU * v;
      const px = r * Math.cos(th), py = r * Math.sin(th), a = pre(px, py, r);
      if (a > 0) { const b = ramp(px, py); if (b > 0) sum += a * b; }
    }
    const p = Math.max(0.02, sum / SAMPLES);
    res.p = p;
    M = Math.max(n, Math.ceil((OVERSHOOT * n) / p));
    res.candidates = M;
    sc = Math.sqrt((Math.PI * A) / M);          // candidate spacing = the slot spacing where the acceptance is 1
    th0 = TAU * hash01(seed, 7);
    res.spacing = sc;
    res.spacingMean = Math.sqrt((Math.PI * A * p) / n);
    // the anchor grid: every member (by edge distance)
    if (m) {
      let ext = r1; for (let q = 0; q < m; q++) ext = Math.max(ext, Math.abs(mx[q]), Math.abs(my[q]));
      agrid = buildAnchorGrid(mx, my, mr, m, Math.max(0.5, Math.min(msp, r1 / 4)), ext);
    }
  }

  // accepted entries: (t, x, y) per pass, appended in t order
  const p1 = { t: new Float32Array(n), x: new Float32Array(n), y: new Float32Array(n), n: 0 };
  const rejPos = [], rejZero = [], rejHard = [];   // pass-1 losers (the fallback), only kept while they may be needed
  let p2 = null, ov = null;
  let phase = 0, k = 0;
  const tmp = [0, 0, 0, 0];
  const merge = () => {
    // three t-sorted lists -> one, inner to outer
    const L = [p1, p2, ov].filter((a) => a && a.n > 0);
    const at = L.map(() => 0);
    for (let j = 0; j < n; j++) {
      let best = -1, bt = Infinity;
      for (let q = 0; q < L.length; q++) { if (at[q] < L[q].n && L[q].t[at[q]] < bt) { bt = L[q].t[at[q]]; best = q; } }
      if (best < 0) { x[j] = 0; y[j] = r0; continue; }
      x[j] = L[best].x[at[best]]; y[j] = L[best].y[at[best]]; at[best]++;
    }
  };
  const step = (deadline = Infinity) => {
    const ts = now();
    let c = 0;
    const out = () => (++c & 63) === 0 && now() > deadline;
    const pause = () => { spent += now() - ts; return false; };
    if (phase === 0) { setupA(); phase = 0.5; if (now() > deadline) return pause(); }
    if (phase === 0.5) { setupB(); phase = 1; if (now() > deadline) return pause(); }
    if (phase === 1) {
      for (; k < M && p1.n < n; k++) {
        cand(k, 0, tmp);
        const d = draw(tmp[0], tmp[1], tmp[3], hash01(seed ^ ACC_SALT, k));
        if (d === 1) { p1.t[p1.n] = tmp[2]; p1.x[p1.n] = tmp[0]; p1.y[p1.n] = tmp[1]; p1.n++; }
        else { const L = d === 3 ? rejHard : d === 0 ? rejPos : rejZero; if (L.length < n) L.push(k); }
        if (out()) { k++; return pause(); }
      }
      phase = p1.n >= n ? 4 : 2; k = 0;
      if (phase === 2) p2 = { t: new Float32Array(n - p1.n), x: new Float32Array(n - p1.n), y: new Float32Array(n - p1.n), n: 0 };
    }
    if (phase === 2) {
      const need = n - p1.n;
      for (; k < M && p2.n < need; k++) {
        cand(k, 0.5, tmp);
        if (draw(tmp[0], tmp[1], tmp[3], hash01(seed ^ ACC2_SALT, k)) === 1) { p2.t[p2.n] = tmp[2]; p2.x[p2.n] = tmp[0]; p2.y[p2.n] = tmp[1]; p2.n++; }
        if (out()) { k++; return pause(); }
      }
      res.pass2 = p2.n;
      phase = p1.n + p2.n >= n ? 4 : 3;
    }
    if (phase === 3) {
      const need = n - p1.n - (p2 ? p2.n : 0);
      ov = { t: new Float32Array(need), x: new Float32Array(need), y: new Float32Array(need), n: 0 };
      const take = (kk, half) => { cand(kk, half, tmp); ov.t[ov.n] = tmp[2]; ov.x[ov.n] = tmp[0]; ov.y[ov.n] = tmp[1]; ov.n++; };
      // the draw's losers off every drawn disc are legal spots: the positive ones first, then the zero ones (a loser that
      // never reached the ramp is checked now; one on a drawn coin joins the hard ones)
      for (const L of [rejPos, rejZero]) for (let q = 0; q < L.length && ov.n < need; q++) {
        cand(L[q], 0, tmp);
        if (ramp(tmp[0], tmp[1]) < 0) { if (rejHard.length < n) rejHard.push(L[q]); continue; }
        take(L[q], 0);
      }
      const legal = ov.n;
      for (let q = 0; q < rejHard.length && ov.n < need; q++) take(rejHard[q], 0);
      // still short (n larger than every candidate): the half-offset spiral again, overlaps allowed
      for (let q = 0; ov.n < need; q++) take(q % M, 0.5);
      res.overlaps = ov.n - legal;
      phase = 4;
    }
    if (phase === 4) { merge(); phase = 5; k = 0; rejPos.length = 0; rejZero.length = 0; rejHard.length = 0; if (now() > deadline) return pause(); }
    if (phase === 5) {
      if (agrid) {
        for (; k < n; k++) {
          const q = nearestEdge(agrid, x[k], y[k]);
          anchor[k] = q >= 0 ? mi[q] : -1;
          if (out()) { k++; return pause(); }
        }
      }
      phase = 6;
    }
    spent += now() - ts;
    res.ms = +spent.toFixed(2);
    return true;
  };
  return { step, result: () => res, done: () => phase === 6, setupMs: () => +(now() - t0 - spent).toFixed(2) };
}

export function buildSlots(o) {
  const b = createSlotBuilder(o);
  while (!b.step(Infinity)) { /* run to completion */ }
  return b.result();
}

// ---------- the pick grid (CSR over points) ----------
export function buildPointGrid(x, y, n, cell) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j < n; j++) { if (x[j] < x0) x0 = x[j]; if (x[j] > x1) x1 = x[j]; if (y[j] < y0) y0 = y[j]; if (y[j] > y1) y1 = y[j]; }
  if (!(n > 0)) { x0 = y0 = 0; x1 = y1 = 1; }
  cell = Math.max(1e-3, cell);
  const nx = Math.max(1, Math.min(4096, Math.ceil((x1 - x0) / cell) + 1)), ny = Math.max(1, Math.min(4096, Math.ceil((y1 - y0) / cell) + 1));
  const cw = Math.max(cell, (x1 - x0) / (nx - 0.5 || 1)), ch = Math.max(cell, (y1 - y0) / (ny - 0.5 || 1));
  const cellOf = (j) => Math.min(ny - 1, Math.floor((y[j] - y0) / ch)) * nx + Math.min(nx - 1, Math.floor((x[j] - x0) / cw));
  const start = new Int32Array(nx * ny + 1);
  for (let j = 0; j < n; j++) start[cellOf(j) + 1]++;
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * ny), items = new Int32Array(n);
  for (let j = 0; j < n; j++) items[fill[cellOf(j)]++] = j;
  return { x0, y0, cw, ch, nx, ny, start, items, x, y };
}
export function nearestInGrid(g, px, py, maxD, accept) {
  if (!g) return -1;
  const gx0 = Math.max(0, Math.floor((px - maxD - g.x0) / g.cw)), gx1 = Math.min(g.nx - 1, Math.floor((px + maxD - g.x0) / g.cw));
  const gy0 = Math.max(0, Math.floor((py - maxD - g.y0) / g.ch)), gy1 = Math.min(g.ny - 1, Math.floor((py + maxD - g.y0) / g.ch));
  let best = -1, bd = maxD * maxD;
  for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
    const c = gy * g.nx + gx;
    for (let e = g.start[c], end = g.start[c + 1]; e < end; e++) {
      const j = g.items[e], dx = g.x[j] - px, dy = g.y[j] - py, d2 = dx * dx + dy * dy;
      if (d2 <= bd && (!accept || accept(j))) { bd = d2; best = j; }
    }
  }
  return best;
}

export function slotsHash(x, y, n) {
  let h = 0x811c9dc5;
  for (let j = 0; j < n; j++) {
    const a = Math.round(x[j] * 100) | 0, b = Math.round(y[j] * 100) | 0;
    h ^= a & 0xffff; h = Math.imul(h, 0x01000193); h ^= (a >>> 16) & 0xffff; h = Math.imul(h, 0x01000193);
    h ^= b & 0xffff; h = Math.imul(h, 0x01000193); h ^= (b >>> 16) & 0xffff; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function countInDiscs(x, y, n, discs) {
  const m = Array.isArray(discs) ? discs.length : 0;
  if (!m || !(n > 0)) return 0;
  const mx = new Float32Array(m), my = new Float32Array(m), mr = new Float32Array(m);
  let ext = 1, rs = 0;
  for (let q = 0; q < m; q++) { mx[q] = discs[q].x; my[q] = discs[q].y; mr[q] = Math.max(0, discs[q].r); ext = Math.max(ext, Math.abs(mx[q]) + mr[q], Math.abs(my[q]) + mr[q]); rs += mr[q]; }
  for (let j = 0; j < n; j++) ext = Math.max(ext, Math.abs(x[j]) + 1, Math.abs(y[j]) + 1);
  const cell = Math.max(0.75, Math.min(ext / 6, 2.2 * (rs / m || 1)));
  const g = buildDiscGrid(mx, my, mr, m, cell, -ext - cell, -ext - cell, ext + cell, ext + cell);
  let c = 0;
  for (let j = 0; j < n; j++) if (discHit(g, x[j], y[j])) c++;
  return c;
}
