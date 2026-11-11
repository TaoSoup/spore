// layout.js: bubble sizes, every family's radial tree, and the planet packing.
// (map3 port) Copied from the prototype. Changed: d3 comes from the app's "d3" package; the phone portrait packing reads
// the fit rect (S.fitRect(), the page's chrome bands removed) at build time; sunflower seed heads only (the wedge A/B
// variant is not ported); the debug functions go to S.debugFns (overlapCheck, dbg, layoutStats).
// ROUND 2 (LANES.md section 15, layout lane): no detached pods, no long flights, seed heads with structure.
//   - every brood that cannot sit in a clean band next to its parent is a LOCAL UNIT: laid out around its parent and
//     carried with it (rosettes for <= 60 children, dandelions for seed heads), nested to any depth. gen-3+ broods are
//     always local. Wide trees ($PUMP, $CARDS, $USDC) become a root ringed by satellite units, one stalk each.
//   - seed heads (> 60 children, mostly leaves: $Kimchi, $CARDS' big brood, $PAIR, $TikTok ...): heat class = angle
//     (contiguous, gently twisted wedges), market cap = radius (biggest innermost, true radii), grown seed by seed at
//     the smallest free radius (organic rows, not a printed Vogel lattice); a hanging seed head keeps its stalk clear.
//   - the overview packing (greedy closest-tangent + relaxation, chip-floored hulls) is unchanged.
// FINAL POLISH (2026-10-21, LANES.md section 14): seed heads breathe (EGS 1.7 u between seeds); pullStrays (now only a
// safety net); planets packed greedily at the free tangent spot nearest the centroid instead of d3.packSiblings.
// OWNER: LAYOUT lane. Does NOT place the dust or add family offsets (dust.js does both right after this).
//
// EXPORTS
//   buildLayout(S, pause?) (async; final fix: yields between families)   reads S.N, S.fams, S.planets, S.kids, S.mc, S.gen, S.age, S.n24; fills on S:
//     R, X, Y, TH, NR: Float32Array(N)   radius (world u), FAMILY-LOCAL x/y (dust.js later adds f.cx/f.cy),
//                                        TH/NR = FINAL polar angle/radius about the family centre (after rotation)
//     notable: Uint8Array(N)             top-8 children of a family or mcap >= $10k (never vanish), tops
//     rad(m)                             (round 2) the size scale itself, market cap (USD) -> world radius
//     per family f:
//       f.bandIn[d], f.bandOut[d]        min(r - R) / max(r + R) of generation d (d = 0 is the top)
//       f.ring[d], f.count[d]            (bandIn + bandOut) / 2, members in generation d
//       f.arcR[d]                        generation-arc radius = bandIn[d] - 0.5*gapR (sits in the gutter
//                                        between generation d-1 and d; 0 for d = 0)
//       f.genSpan[d]                     merged occupied angle intervals [[a0, a1], ...] of generation d,
//                                        ABSOLUTE (after rotation), a0 in [0, 2pi), a1 > a0 (a1 may exceed 2pi
//                                        when the span crosses 0); [[0, 2pi]] = full circle (only when the
//                                        occupied span is >= 354 deg). Member extents padded 3 deg, gaps under
//                                        8 deg merged. [] for d = 0.
//       f.noArc[d]                       true when generation d is NOT a band (local units: gen 3+ always, gen 2+
//                                        in a units family) -> no arc, no gen tag
//       f.layoutMode                     (round 2) 'banded' | 'units'
//       f.Rc                             tight bound max(|member| + R) * 1.04
//       f.coreR                          R[top]
//       f.dbg                            per-band debug (see __dbg)
//       planets also get f.cx, f.cy (dust families get them in dust.js)
//     Rcl                                cluster radius about the origin of the packed (padded) planet hulls
//     planetHulls [{x, y, r}]            r = f.Rc (unpadded), x/y = f.cx/f.cy
//   Debug: S.debugFns.overlapCheck() -> {pairsOverlapping, worst, hullsOverlapping, families},
//          S.debugFns.dbg(ticker) -> band records; S.debugFns.layoutStats() -> link-length / brood-gap / seed-head numbers;
//          S.debug.map.{kimchi, pump, Rcl, layoutMs, strays, units}
//
// MODEL
//   BANDED families (the root's children fit a ring or a 2-row brick, gen 2 fits in one tier, no gen-2 seed head):
//   generation bands around the top. The root's children form a ring in d3 tidy-tree order; inside band 2 each brood
//   is ONE crown of hex-staggered concentric arc rows centred on its parent's angle (biggest child innermost and
//   centred, then alternating sides), separated by an exact 1-D circular least-squares solve (isotonic regression);
//   r_in grows by 8% while they do not fit in 0.94*2pi (at most 2 bumps). Deeper broods are local rosettes.
//   UNITS families (everything else): nested local units, see "local clusters" below. Their gen-1 band is the root's
//   unit; deeper generations are not bands (f.noArc).
import { hierarchy, tree, packEnclose } from "d3";
import { TAU, GOLDEN, clamp01, rnd } from "./util.js";
import { TOK, heatClass } from "./tokens.js";

const EG = 0.9;          // uniform edge gap between two bubbles (world u)
// (final polish) seed heads (broods over 60: Kimchi, CARDS, PAIR ...) breathe: 1.7 u between seeds instead of 0.9, so a
// thousand near-equal coins read as a fine stipple with air, not as bubble wrap
const EGS = 1.7;
// (round 2) the mean gap inside a grown seed head: the greedy growth packs ~10% looser than the old Vogel lattice, so
// 0.85 x EGS keeps the seed heads at their round-1 size while every gap still varies (+-25%, a slow density wave)
const SEED_GAP = 0.85 * EGS;
const GAPR = 2.4;        // generation gutter unit (world u); gapR = 0.6*GAPR for families under 40 members
const HEXF = 0.9;        // crown row pitch as a fraction of the slot (hex stagger lets rows nest)
const CROWN_MAX = 60;    // broods above this size become phyllotaxis
const DEG = Math.PI / 180;
const norm2pi = (a) => { a %= TAU; return a < 0 ? a + TAU : a; };
const wrapPi = (a) => { a = norm2pi(a + Math.PI); return a - Math.PI; };

// Exact circular "no overlap, stay near target" solve. items[k] = {t, hw}; returns theta[k].
// Minimises sum (theta - t)^2 subject to consecutive items (in target order) not overlapping.
// Requires sum(2*hw) < 2pi.
function solveCircle(items) {
  const n = items.length;
  if (n === 0) return [];
  if (n === 1) return [items[0].t];
  const idx = items.map((_, i) => i).sort((a, b) => norm2pi(items[a].t) - norm2pi(items[b].t) || a - b);
  const t = idx.map((i) => norm2pi(items[i].t));
  let seam = 0, best = -Infinity;
  for (let k = 0; k < n; k++) {
    const gap = (k + 1 < n ? t[k + 1] : t[0] + TAU) - t[k] - items[idx[k]].hw - items[idx[(k + 1) % n]].hw;
    if (gap > best) { best = gap; seam = (k + 1) % n; }
  }
  const ord = [], tt = [];
  for (let k = 0; k < n; k++) { const kk = (seam + k) % n; ord.push(idx[kk]); tt.push(t[kk] + (kk < seam ? TAU : 0)); }
  const c = [0];
  for (let k = 1; k < n; k++) c.push(c[k - 1] + items[ord[k - 1]].hw + items[ord[k]].hw);
  const bs = [], bn = [];
  for (let k = 0; k < n; k++) {
    bs.push(tt[k] - c[k]); bn.push(1);
    while (bs.length > 1 && bs[bs.length - 2] / bn[bn.length - 2] > bs[bs.length - 1] / bn[bn.length - 1]) {
      const s = bs.pop(), m = bn.pop(); bs[bs.length - 1] += s; bn[bn.length - 1] += m;
    }
  }
  const u = [];
  for (let b = 0; b < bs.length; b++) for (let q = 0; q < bn[b]; q++) u.push(bs[b] / bn[b]);
  const slack = TAU - c[n - 1] - items[ord[n - 1]].hw - items[ord[0]].hw;
  if (u[n - 1] - u[0] > slack) {   // the chain wrapped into its own start: compress the displacements
    const u0 = u[0], sc = Math.max(0, slack) / (u[n - 1] - u0);
    for (let k = 0; k < n; k++) u[k] = u0 + (u[k] - u0) * sc;
  }
  const th = new Array(n);
  ord.forEach((i, k) => { th[i] = u[k] + c[k]; });
  return th;
}

// Union of angle intervals [[a0, a1]] (any angles, a1 > a0) on the circle, with gaps < minGap closed.
// Returns sorted [[a0, a1]] with a0 in [0, 2pi) and a1 > a0 (a1 may exceed 2pi when a span crosses 0);
// [[0, 2pi]] when the union covers >= fullAt. Rasterised at 0.25 deg (robust to any wrap).
const SPAN_NB = 1440, SPAN_BW = TAU / SPAN_NB;
function mergeSpans(iv, minGap, fullAt) {
  if (!iv.length) return [];
  const cov = new Uint8Array(SPAN_NB);
  for (const [a0, a1] of iv) {
    if (a1 - a0 >= TAU) return [[0, TAU]];
    const b0 = Math.floor(norm2pi(a0) / SPAN_BW), n = Math.ceil((a1 - a0) / SPAN_BW) + 1;
    for (let q = 0; q < n; q++) cov[(b0 + q) % SPAN_NB] = 1;
  }
  const gapBins = Math.round(minGap / SPAN_BW), start = cov.indexOf(1);
  for (let q = 0; q < SPAN_NB;) {
    if (cov[(start + q) % SPAN_NB]) { q++; continue; }
    let len = 0; while (len < SPAN_NB && !cov[(start + q + len) % SPAN_NB]) len++;
    if (len < gapBins) for (let z = 0; z < len; z++) cov[(start + q + z) % SPAN_NB] = 1;
    q += len;
  }
  let tot = 0; for (let q = 0; q < SPAN_NB; q++) tot += cov[q];
  if (tot * SPAN_BW >= fullAt) return [[0, TAU]];
  const u = cov.indexOf(0), out = [];
  for (let z = 0; z < SPAN_NB;) {
    const bq = (u + z) % SPAN_NB; if (!cov[bq]) { z++; continue; }
    let len = 0; while (len < SPAN_NB && cov[(u + z + len) % SPAN_NB]) len++;
    out.push([bq * SPAN_BW, (bq + len) * SPAN_BW]); z += len;
  }
  return out.sort((x, y) => x[0] - y[0]);
}

// (final fix) pause: optional async yield (index.js passes one macrotask that also checks the abort signal). The family loop
// yields every SLICE_MS of work, so a phone's build (an estimated ~1 s here) never becomes one long task, and the engine
// still on screen during a rebuild keeps animating. The computation and its order are unchanged.
const SLICE_MS = 40;
export async function buildLayout(S, pause = null) {
  const tStart = performance.now();
  const { N, fams, planets, kids, mc, age, n24 } = S;
  // (compact layout, 2026-11-10) the jitter and rotation seeds: a coin's pre-order index and its family's id in the FULL build
  // (data.js S.seed / f.seed, set only for a build made from the Key's filtered set), so a family looks the same in every
  // filtered build that keeps the same coins of it; a mask-15 build seeds by the index itself, exactly as before
  const SEED = S.seed || null;
  const sd = SEED ? (i) => SEED[i] : (i) => i, fs = (f) => (f.seed ?? f.id);

  // ---------- sizes: market cap on a log scale, floor + cap ($2k = 1 u, $10k ≈ 2.1 u, $40k ≈ 3 u, $400k ≈ 4.5 u, cap 7 u) ----------
  const rad = (m) => !(m > 0) ? 0.55 : m < 2000 ? 0.55 + 0.45 * clamp01(Math.log(m / 300) / Math.log(2000 / 300)) : Math.min(7, 1 + 1.54 * Math.log10(m / 2000));
  const R = new Float32Array(N), X = new Float32Array(N), Y = new Float32Array(N), TH = new Float32Array(N);
  const notable = new Uint8Array(N), NR = new Float32Array(N), DEP = new Uint8Array(N);
  for (let i = 0; i < N; i++) R[i] = rad(mc[i]);
  for (const f of fams) {
    const ch = f.members.filter((i) => i !== f.top).sort((a, b) => mc[b] - mc[a]);
    ch.forEach((i, r) => { if (r < 8 || mc[i] >= 1e4) notable[i] = 1; });
    let mx = 0; for (const i of ch) mx = Math.max(mx, R[i]);
    // top rule: the biggest in its family, but never a lit moon (at most ~2x its biggest child)
    R[f.top] = Math.min(Math.max(R[f.top], 1.25 * mx), Math.max(2.0 * mx, f.planet ? 2.2 : 1));
    notable[f.top] = 1;
  }
  const byMc = (a, b) => mc[b] - mc[a] || a - b;

  // d3 tidy tree: angular ORDER only (root's gen-1 ring)
  const tr = tree().size([TAU, 1]).separation((a, b) => (R[a.data] + R[b.data] + EG) * (a.parent === b.parent ? 1 : 2.2) / Math.max(1, a.depth));

  // crown: b.m concentric arc rows, capacity shrinking outward (hex-staggered; biggest innermost and centred,
  // then alternating sides). The shrink keeps the last row at ~1/3 of the first, so deep crowns stay teardrops.
  // (round 2) widths use the UNIT radius U[i], so a member that carries a local rosette gets the room for it.
  function buildCrown(b) {
    const n = b.ch.length, m = b.m, sh = Math.min(0.18, 0.62 / Math.max(1, m - 1));
    const capOf = (c0, j) => Math.max(1, Math.round(c0 * (1 - sh * j)));
    let c0 = 1;
    for (;; c0++) { let s = 0; for (let j = 0; j < m; j++) s += capOf(c0, j); if (s >= n) break; }
    b.rows = []; let k = 0;
    const flip = rnd(sd(b.p), 33) < 0.5, offSign = rnd(sd(b.p), 34) < 0.5 ? 1 : -1;
    for (let j = 0; j < m && k < n; j++) {
      const cap = capOf(c0, j), mem = b.ch.slice(k, k + cap); k += cap;
      const s = new Array(mem.length); let L = 0, Rr = 0;
      mem.forEach((i, q) => {
        const w = U[i] + EG / 2;
        if (q === 0) { s[q] = 0; L = -w; Rr = w; }
        else if ((q % 2 === 1) === flip) { s[q] = Rr + w; Rr = s[q] + w; }
        else { s[q] = L - w; L = s[q] - w; }
      });
      const c = -(L + Rr) / 2; for (let q = 0; q < s.length; q++) s[q] += c;
      const rmax = mem.reduce((mm, i) => Math.max(mm, U[i]), 0);
      const meanSlot = mem.reduce((a, i) => a + 2 * U[i] + EG, 0) / mem.length;
      b.rows.push({ mem, s, half: (Rr - L) / 2, rmax, off: j % 2 ? 0.5 * meanSlot * offSign : 0 });
    }
    let acc = 0;
    b.rows.forEach((row, j) => { if (j > 0) acc += (b.rows[j - 1].rmax + row.rmax + EG) * HEXF; row.dr = acc; });
  }

  // small broods (1-3 children) step out by up to ~1 slot, deterministic per parent: generations stay
  // banded but singletons no longer line up into a bead ring
  const stagger = (b, slotAvg) => b.ch.length <= 3 ? rnd(sd(b.p), 35) * 1.0 * slotAvg : b.ch.length <= 7 ? rnd(sd(b.p), 35) * 0.5 * slotAvg : 0;

  // pack circles {t (target angle), rad, w (priority), st (radial step-out)} outside the edge radius eIn with gutters;
  // each as close as possible to the point straight out at its target angle; returns centres. Biggest first, unless
  // keep = true (the caller's order). (round 2) a size-agnostic grid, so one huge cluster no longer makes every test O(n).
  function packTier(items, eIn, gutter, keep = false, gridIn = null) {
    const out = new Array(items.length);
    const order = items.map((_, k) => k);
    if (!keep) order.sort((p, q) => items[q].rad - items[p].rad || items[q].w - items[p].w || p - q);
    const rrs = items.map((it) => it.rad + gutter / 2).sort((x, y) => x - y);
    const grid = gridIn || circleGrid(Math.max(1.5, 2 * rrs[rrs.length >> 1]));
    for (const k of order) {
      const it = items[k], rr = it.rad + gutter / 2, rmin = eIn + it.rad, rid = rmin + (it.st || 0);
      const free = (x, y) => Math.hypot(x, y) >= rmin - 1e-6 && grid.free(x, y, rr);
      const ix = Math.cos(it.t) * rid, iy = Math.sin(it.t) * rid;
      let best = free(ix, iy) ? [ix, iy] : null;
      const step = Math.max(0.5, 0.18 * rr);
      for (let kk = 1; !best && kk < 4000; kk++) {
        const dist = kk * step, nd = Math.min(144, Math.max(12, Math.ceil(TAU * dist / step)));
        let bv = Infinity;
        for (let q = 0; q < nd; q++) {
          const a = it.t + q / nd * TAU, x = ix + Math.cos(a) * dist, y = iy + Math.sin(a) * dist;
          if (!free(x, y)) continue;
          const r = Math.hypot(x, y), v = Math.abs(r - rid) + 0.5 * Math.abs(wrapPi(Math.atan2(y, x) - it.t)) * r;
          if (v < bv) { bv = v; best = [x, y]; }
        }
      }
      if (!best) best = [Math.cos(it.t) * (rid + 4000 * step), Math.sin(it.t) * (rid + 4000 * step)];   // never reached in practice
      out[k] = best; grid.add(best[0], best[1], rr);
    }
    return out;
  }

  // ---------- local clusters ("units", round 2) ----------
  // A coin whose brood is laid out LOCALLY carries its descendants with it as one rigid unit: the brood sits around
  // the coin (a rosette fanning away from where its own link comes in, or a full dandelion for a seed head), so every
  // link inside a unit is a few u long and no brood is ever flown out to a far band.
  //   U[i]            bounding radius of i's unit (= R[i] for a coin without a local brood)
  //   UOX/UOY[i]      centre of that bounding circle in i's own frame (i at the origin, +x = outward)
  //   LX/LY/LA[c]     position and frame angle of child c in its parent's frame (only when LOC[parent])
  const U = new Float32Array(N), UOX = new Float32Array(N), UOY = new Float32Array(N);
  const LX = new Float32Array(N), LY = new Float32Array(N), LA = new Float32Array(N);
  const LOC = new Uint8Array(N), BD = new Uint8Array(N);
  for (let i = 0; i < N; i++) U[i] = R[i];
  const placeUnitAt = (i, x, y, ang) => {
    X[i] = x; Y[i] = y;
    if (!LOC[i]) return;
    const c = Math.cos(ang), s = Math.sin(ang);
    for (const k of kids[i]) placeUnitAt(k, x + c * LX[k] - s * LY[k], y + s * LX[k] + c * LY[k], ang + LA[k]);
  };
  // the unit of i with its bounding centre at (cx, cy) and its outward axis along ang
  const placeUnitCentre = (i, cx, cy, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    placeUnitAt(i, cx - (c * UOX[i] - s * UOY[i]), cy - (s * UOX[i] + c * UOY[i]), ang);
  };
  const moveUnit = (i, dx, dy) => { X[i] += dx; Y[i] += dy; if (LOC[i]) for (const k of kids[i]) moveUnit(k, dx, dy); };

  // circles in a uniform grid (a circle is filed in every cell its box touches, so sizes may differ freely)
  function circleGrid(cell) {
    const g = new Map(), key = (gx, gy) => (gx + 32768) * 65536 + (gy + 32768);
    let stamp = 0;
    return {
      add(x, y, r) {
        const e = [x, y, r, 0];
        for (let gx = Math.floor((x - r) / cell), gx1 = Math.floor((x + r) / cell); gx <= gx1; gx++)
          for (let gy = Math.floor((y - r) / cell), gy1 = Math.floor((y + r) / cell); gy <= gy1; gy++) { const k = key(gx, gy); let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(e); }
      },
      query(x0, y0, x1, y1, fn) {
        const st = ++stamp;
        for (let gx = Math.floor(x0 / cell), gx1 = Math.floor(x1 / cell); gx <= gx1; gx++)
          for (let gy = Math.floor(y0 / cell), gy1 = Math.floor(y1 / cell); gy <= gy1; gy++) {
            const a = g.get(key(gx, gy)); if (!a) continue;
            for (const e of a) if (e[3] !== st) { e[3] = st; fn(e); }
          }
      },
      free(x, y, r) {
        for (let gx = Math.floor((x - r) / cell), gx1 = Math.floor((x + r) / cell); gx <= gx1; gx++)
          for (let gy = Math.floor((y - r) / cell), gy1 = Math.floor((y + r) / cell); gy <= gy1; gy++) {
            const a = g.get(key(gx, gy)); if (!a) continue;
            for (const e of a) { const dx = x - e[0], dy = y - e[1], s = r + e[2]; if (dx * dx + dy * dy < s * s - 1e-6) return false; }
          }
        return true;
      },
    };
  }

  // SEED HEAD (brood > 60, mostly leaves): a dandelion around its parent with STRUCTURE.
  //   - angle = heat class: live / cooling / quiet / cold each own one contiguous wedge (width = the class's share of
  //     the seed area); the borders twist with radius (1.35 rad hub to rim) and wave slowly (a pinwheel, not a pie
  //     chart). A class too small for a wedge is a compact patch at the hub end of its neighbour's wedge;
  //   - radius = market cap: inside each wedge the biggest coin is innermost, area-true (r^2 grows with the area
  //     already placed in that wedge), so $40k coins sit at the heart and the $2k crowd at the rim, at TRUE radii;
  //   - organic: every seed keeps its angle and takes the smallest free radius (a growing sunflower, not a printed
  //     Vogel lattice), with a +-0.45-slot angular jitter and a slow +-25% density wave in the gaps;
  //   - the classes are read ONCE, at build time (S.age); a coin that cools later keeps its place, so the regions blur
  //     slowly over a session instead of reshuffling under the viewer;
  //   - a seed head that hangs off another coin keeps a narrow corridor clear toward that coin (its stalk), so the
  //     incoming hairline never crosses the seeds.
  // Returns the children's centres in the parent's frame (+x = outward, away from the stalk).
  const PHI = 0.6180339887498949, frac = (v) => v - Math.floor(v);
  const hexA = (rho) => 3.4641 * rho * rho;          // hexagonal cell of a circle of radius rho (2*sqrt(3)*rho^2)
  let seedHeads = 0, seedMs = 0;
  // (round 2 final) SEED HEAD, rebuilt after the critics: the heat wedges read as a pie chart (and went stale as coins
  // cooled). A seed head now GROWS like a sunflower, in creation order: the oldest seed sits at the hub, every later one
  // on the next golden-angle turn at the next area-true radius, so a new coin is born at the rim. Heat is colour only
  // (one meaning per channel); because recent coins trade most, a busy head shows a lime fringe of new growth all round
  // its rim, never a wedge on one side. Size stays market cap at true R. Coins with no creation time go first, by cap.
  // Organic: grow() takes the smallest free radius near each target angle, with a +-0.45-slot jitter and a slow +-25 %
  // density wave in the gaps; a head that hangs off another coin keeps its stalk corridor clear.
  const crt = S.crt || null;
  function placeSeeds(p, ch, corridor) {
    const t0 = performance.now(); seedHeads++;
    const ord = ch.slice().sort((a, b) => ((crt ? crt[a] : 0) - (crt ? crt[b] : 0)) || mc[b] - mc[a] || a - b);
    const g0 = SEED_GAP, r0 = R[p] + g0, rho0 = (c) => U[c] + g0 / 2;
    const totA = ord.reduce((s, c) => s + hexA(rho0(c)), 0), Rout = Math.sqrt(r0 * r0 + totA / Math.PI);
    const ph1 = rnd(sd(p), 65) * TAU, ph2 = rnd(sd(p), 66) * TAU, a0 = corridor ? 0 : rnd(sd(p), 61) * TAU;
    const items = []; let cum = 0;
    ord.forEach((c, j) => {
      const A0 = hexA(rho0(c)), rg = Math.sqrt(r0 * r0 + (cum + 0.5 * A0) / Math.PI); cum += A0;
      const u = clamp01((rg - r0) / Math.max(1e-6, Rout - r0));
      const a = a0 + j * GOLDEN + (rnd(sd(c), 63) - 0.5) * 0.9 * (2 * rho0(c)) / Math.max(rg, 1);
      const gm = 1 + 0.17 * Math.sin(2 * a + 6.5 * u + ph1) + 0.08 * Math.sin(5 * a - 10 * u + ph2);
      items.push({ c, a, rg, rho: U[c] + 0.5 * g0 * gm });
    });
    const out = grow(items, (it) => r0 + U[it.c], corridor);
    seedMs += performance.now() - t0;
    return ch.map((c) => out.get(c));
  }
  // (map3 port) the round-2 heat-wedge A/B variant is not ported: sunflower seed heads only

  // GROW: items [{c, a (target angle), rg (expected radius), rho (radius incl. half gap)}] placed one by one in order of
  // rg, each at the smallest free radius on one of nine rays around its target angle (exact: every nearby circle blocks
  // one interval of the ray). Shared by the seed heads and a root's core. Returns Map coin -> [x, y].
  function grow(items, rMinOf, corridor, gridIn = null) {
    items.sort((x, y) => x.rg - y.rg || x.c - y.c);
    const rhos = items.map((it) => it.rho).sort((x, y) => x - y), out = new Map(), cw = 0.9;
    const grid = gridIn || circleGrid(Math.max(1.2, 2 * rhos[rhos.length >> 1]));
    // exact smallest free radius along a ray: every nearby placed circle blocks one interval of the ray, the stalk
    // corridor blocks [0, (cw + rho) / |sin a|] on the back side; the answer is the start of the first gap after t0
    const near = [], iv = [];
    const gather = (a0, a1, rho, t0, t1) => {
      near.length = 0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const a of [a0, a1, 0.5 * (a0 + a1)]) for (const t of [t0, t1]) { const x = Math.cos(a) * t, y = Math.sin(a) * t; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      grid.query(x0 - rho, y0 - rho, x1 + rho, y1 + rho, (e) => near.push(e));
    };
    const rayFree = (a, rho, t0, t1) => {
      const ux = Math.cos(a), uy = Math.sin(a); iv.length = 0;
      if (corridor && ux < 0) { const sy = Math.abs(uy); if (sy < 1e-6) return Infinity; iv.push(0, (cw + rho) / sy); }
      for (const e of near) {
        const d = e[0] * ux + e[1] * uy, S2 = (rho + e[2]) ** 2, h2 = d * d - (e[0] * e[0] + e[1] * e[1]) + S2;
        if (h2 > 0) { const h = Math.sqrt(h2); if (d + h > t0) iv.push(d - h, d + h); }
      }
      const n = iv.length >> 1, ord = new Array(n); for (let q = 0; q < n; q++) ord[q] = q;
      ord.sort((p, q) => iv[2 * p] - iv[2 * q]);
      let t = t0;
      for (const q of ord) { if (iv[2 * q] > t + 1e-6) break; t = Math.max(t, iv[2 * q + 1] + 1e-6); }
      return t <= t1 - rho ? t : Infinity;   // beyond the gathered window: unknown
    };
    for (const it of items) {
      const rMin = rMinOf(it), t0 = Math.max(rMin, it.rg - 3 * it.rho);
      let a = it.a;
      if (corridor) {   // aim off the stalk corridor (|y| < cw + rho behind the hub) at the expected radius
        const hc = it.rg > cw + it.rho ? Math.asin((cw + it.rho) / it.rg) : 0.5 * Math.PI, dw = wrapPi(a - Math.PI);
        if (Math.abs(dw) < hc) a = Math.PI + Math.sign(dw || 1) * hc;
      }
      // nine rays around the target angle; the closest free spot wins (ties go to the target angle)
      const da = 0.3 * it.rho / Math.max(it.rg, 1);
      let bt = Infinity, ba = a, btt = Infinity;
      for (let L = 5 * it.rho + 2; bt === Infinity && L < 1e5; L *= 2) {
        gather(a - 4 * da, a + 4 * da, it.rho, t0, t0 + L);
        for (let j = 0; j <= 8; j++) {
          const aa = a + (j & 1 ? -1 : 1) * Math.ceil(j / 2) * da, t = rayFree(aa, it.rho, t0, t0 + L);
          if (t === Infinity) continue;
          const sc = t + 0.12 * it.rho * Math.ceil(j / 2);
          if (sc < bt) { bt = sc; ba = aa; btt = t; }
        }
      }
      const placed = [Math.cos(ba) * btt, Math.sin(ba) * btt];
      grid.add(placed[0], placed[1], it.rho); out.set(it.c, placed);
    }
    return out;
  }

  // ROSETTE (brood <= 60, or a root whose children are mostly clusters themselves): children packed as close to the
  // parent as they fit; the fan opens away from the stalk (at most +-150 deg), biggest child straight out.
  // A ROOT uses the full circle in two rings: first its CORE (children with at most SAT_MIN children of their own, by
  // market cap, so the notable coins sit next to the top), then its SATELLITES (bigger clusters, biggest first, spread by
  // the golden angle) just outside the core, each tied to the top by one stalk.
  const SAT_MIN = 12;
  function placeRosette(p, ch, isRoot) {
    const n = ch.length;
    if (isRoot) {
      const core = ch.filter((c) => kids[c].length <= SAT_MIN).sort((a, b) => mc[b] - mc[a] || U[b] - U[a] || a - b);
      const sat = ch.filter((c) => kids[c].length > SAT_MIN).sort((a, b) => U[b] - U[a] || mc[b] - mc[a] || a - b);
      const a0 = rnd(sd(p), 67) * TAU, GUT = 1.4, m = new Map();
      let med = 1; if (core.length) { const r = core.map((c) => U[c]).sort((x, y) => x - y); med = r[r.length >> 1]; }
      const grid = circleGrid(Math.max(1.5, 2 * (med + GUT / 2)));
      if (core.length) {   // the core grows like a seed head: by market cap, golden-angle targets, smallest free radius
        const r0 = R[p] + GUT; let cum = 0;
        const items = core.map((c, k) => { const rho = U[c] + GUT / 2, A = hexA(rho), rg = Math.sqrt(r0 * r0 + (cum + 0.5 * A) / Math.PI); cum += A; return { c, a: a0 + k * GOLDEN, rg, rho }; });
        for (const [c, xy] of grow(items, (it) => r0 + U[it.c], false, grid)) m.set(c, xy);
      }
      // satellites hug the core: each at the smallest free radius, at the free angle nearest its golden-angle target
      const SG = GUT + 1.2;
      sat.forEach((c, k) => {
        const rr = U[c] + SG / 2, t = a0 + 0.5 * GOLDEN + k * GOLDEN;
        let best = null;
        for (let r = R[p] + SG + U[c]; !best && r < 4000; r += Math.max(0.4, 0.12 * rr)) {
          const da = Math.max(0.004, 0.25 * rr / r), nA = Math.ceil(Math.PI / da);
          for (let j = 0; j <= 2 * nA && !best; j++) {
            const a = t + (j & 1 ? -1 : 1) * Math.ceil(j / 2) * da, x = Math.cos(a) * r, y = Math.sin(a) * r;
            if (grid.free(x, y, rr)) best = [x, y];
          }
        }
        grid.add(best[0], best[1], rr); m.set(c, best);
      });
      return ch.map((c) => m.get(c));
    }
    const ord = ch.slice().sort((a, b) => U[b] - U[a] || mc[b] - mc[a] || a - b);
    // centred fan: the biggest child straight out, then alternating sides; spacing = one row's need, capped at A
    const A = Math.min(150 * DEG, (40 + 10 * n) * DEG), r1 = R[p] + EG + U[ord[0]];
    let need = 0; for (const c of ord) need += (2 * U[c] + EG) / r1;
    const half = Math.min(A, 0.5 * need), step = n > 1 ? 2 * half / (n - 1) : 0;
    const slots = []; for (let q = 0; q < n; q++) slots.push(-half + q * step);
    slots.sort((x, y) => Math.abs(x) - Math.abs(y) || x - y);
    const flip = rnd(sd(p), 68) < 0.5 ? -1 : 1;
    const cen = packTier(ord.map((c, k) => ({ t: flip * slots[k], rad: U[c], w: mc[c] })), R[p] + EG, EG);
    const m = new Map(); ord.forEach((c, k) => m.set(c, cen[k]));
    return ch.map((c) => m.get(c));
  }

  // build the unit of p (its children's units must exist): place the children, store their frames, enclose
  let nRosette = 0;
  function buildUnit(p, isRoot) {
    const ch = kids[p], n = ch.length;
    let leaves = 0; for (const c of ch) if (!LOC[c]) leaves++;
    const seed = n > CROWN_MAX && leaves >= 0.75 * n;
    const pos = seed ? placeSeeds(p, ch, !isRoot) : placeRosette(p, ch, isRoot);
    if (!seed) nRosette++;
    const circles = [{ x: 0, y: 0, r: R[p] }];
    ch.forEach((c, k) => {
      const [ux, uy] = pos[k], ang = Math.atan2(uy, ux), cs = Math.cos(ang), sn = Math.sin(ang);
      LX[c] = ux - (cs * UOX[c] - sn * UOY[c]); LY[c] = uy - (sn * UOX[c] + cs * UOY[c]); LA[c] = ang;
      circles.push({ x: ux, y: uy, r: U[c] });
    });
    const e = packEnclose(circles);
    U[p] = e.r; UOX[p] = e.x; UOY[p] = e.y; LOC[p] = 1;
    return seed;
  }

  // ---------- one family ----------
  // Two modes (round 2):
  //   BANDED  the root's children fit a ring (or a 2-row brick), no gen-2 brood is a seed head and gen 2 fits in ONE
  //           tier next to the ring: generation bands as before (ring, crowns at their parent's angle, arcs), and every
  //           deeper brood (gen 3+) is a local rosette next to its parent.
  //   UNITS   everything else (seed-head roots like $Kimchi, wide trees like $PUMP / $CARDS / $USDC): every brood is a
  //           local unit, nested; the root's children are seeds of one dandelion (heat wedges, cap order) or, when they
  //           are clusters themselves, a ring of satellite units packed around the root, each tied by ONE stalk.
  let nUnitsFam = 0;
  function layoutFamily(f) {
    const top = f.top;
    const dbg = [];
    const small = f.members.length < 40, gapR = small ? 0.6 * GAPR : GAPR;
    for (const i of f.members) { LOC[i] = 0; U[i] = R[i]; UOX[i] = 0; UOY[i] = 0; }
    X[top] = 0; Y[top] = 0; NR[top] = 0; DEP[top] = 0;
    if (f.members.length === 1) {
      TH[top] = 0;
      Object.assign(f, { bandIn: [0], bandOut: [R[top]], ring: [0], count: [1], arcR: [0], genSpan: [[]], Rc: R[top] * 1.04, coreR: R[top], dbg, noArc: [] });
      return;
    }
    const root = hierarchy(top, (i) => kids[i].length ? kids[i].slice().sort(byMc) : null);
    tr(root);
    const byD = []; root.each((n) => { (byD[n.depth] ||= []).push(n.data); DEP[n.data] = n.depth; });
    const d3x = new Map(); root.each((n) => d3x.set(n.data, n.x));
    const D = byD.length;
    const noArc = [];
    const lo = new Float32Array(D), hi = new Float32Array(D);   // allowed edge interval per band (collision clamp)
    lo[0] = 0; hi[0] = R[top];
    const place = (i, th, r) => { TH[i] = th; NR[i] = r; X[i] = Math.cos(th) * r; Y[i] = Math.sin(th) * r; };

    // ---- BANDED attempt ----
    let banded = kids[top].length <= CROWN_MAX;
    if (banded && D > 2) for (const p of byD[1]) if (kids[p].length > CROWN_MAX) { banded = false; break; }
    const jit = [];        // crown / ring members: [i, slot, inner row, amplitude]
    if (banded) {
      // gen 3+ broods: local rosettes, deepest first
      for (let d = D - 2; d >= 2; d--) for (const p of byD[d]) if (kids[p].length) buildUnit(p, false);
      for (let d = 3; d < D; d++) noArc[d] = true;
      for (const i of f.members) BD[i] = Math.min(DEP[i], 2);
      // ---- band 1: the root's own children, ring in d3 order (2-row brick allowed, at most 2 bumps of 8%) ----
      const ch = kids[top].slice().sort(byMc), n = ch.length;
      let m1 = 0; for (const i of ch) m1 = Math.max(m1, R[i]);
      let rIn = R[top] + m1 + gapR * (small ? 1.0 : 1.5), bumps = 0, mode;
      const need = (rr, fct) => ch.reduce((s, i) => s + 2 * (R[i] + EG / 2) / rr * fct, 0);
      for (let r = rIn, b = 0; b <= 2; b++, r *= 1.08) {
        if (need(r, 1) <= 0.94 * TAU) { mode = "ring"; rIn = r; bumps = b; break; }
        if (n >= 6 && need(r, 0.55) <= 0.94 * TAU) { mode = "brick"; rIn = r; bumps = b; break; }
      }
      if (!mode) banded = false;
      else {
        const fct = mode === "brick" ? 0.55 : 1;
        const th = solveCircle(ch.map((i) => ({ t: d3x.get(i), hw: (R[i] + EG / 2) / rIn * fct })));
        const order = ch.map((i, k) => k).sort((a, b) => norm2pi(th[a]) - norm2pi(th[b]));
        const pitch = (2 * m1 + EG) * 0.87;
        order.forEach((k, q) => {
          const i = ch[k], row = mode === "brick" ? q % 2 : 0;
          place(i, th[k], rIn + row * pitch);
          jit.push([i, 2 * R[i] + EG, row === 0, small ? 0.15 : 0.35]);
        });
        let mxr = 0; for (const i of ch) mxr = Math.max(mxr, NR[i]);
        lo[1] = rIn - m1; hi[1] = mxr + m1;
        dbg.push({ d: 1, n, mode, rIn: +rIn.toFixed(1), bumps, out: +mxr.toFixed(1) });
      }
      // ---- band 2: one crown per brood at its parent's angle, ONE tier (else the family goes to UNITS) ----
      if (banded && D > 2) {
        let prevOuter = 0; for (const i of byD[1]) prevOuter = Math.max(prevOuter, NR[i]);
        let maxU2 = 0; for (const i of byD[2]) maxU2 = Math.max(maxU2, U[i]);
        let rIn2 = prevOuter + m1 + maxU2 + gapR * 1.1;
        const r0 = rIn2;
        const broods = [];
        for (const p of byD[1]) if (kids[p].length) broods.push({ p, ch: kids[p].slice().sort((a, b) => U[b] - U[a] || byMc(a, b)) });
        let slotSum = 0, slotN = 0;
        for (const b of broods) for (const i of b.ch) { slotSum += 2 * U[i] + EG; slotN++; }
        const slotAvg = slotSum / Math.max(1, slotN);
        for (const b of broods) { const nb = b.ch.length; b.m = nb <= 7 ? 1 : Math.ceil(Math.sqrt(nb / 3)); buildCrown(b); }
        const halfAt = (b, rr) => b.rows.reduce((m, row) => Math.max(m, (row.half + Math.abs(row.off)) / (rr + row.dr)), 0);
        let bumps2 = 0, total = 0, fits = false;
        for (;;) {
          const gut = 0.8 * slotAvg / rIn2;
          total = 0; for (const b of broods) { b.hw = halfAt(b, rIn2) + gut; total += 2 * b.hw; }
          if (total <= 0.94 * TAU) { fits = true; break; }
          if (bumps2 >= 2) break;
          rIn2 *= 1.08; bumps2++;
        }
        if (!fits) banded = false;
        else {
          const cen = solveCircle(broods.map((b) => ({ t: TH[b.p], hw: b.hw })));
          broods.forEach((b, k) => {
            const rRow0 = rIn2 + stagger(b, slotAvg);
            b.rows.forEach((row, j) => {
              const rr = rRow0 + row.dr;
              row.mem.forEach((i, q) => { const a = cen[k] + (row.s[q] + row.off) / rr; placeUnitCentre(i, Math.cos(a) * rr, Math.sin(a) * rr, a); jit.push([i, 2 * U[i] + EG, j === 0, 0.25]); });
            });
          });
          let mxr = 0, mxe = 0;
          for (const i of f.members) if (BD[i] === 2) { const r = Math.hypot(X[i], Y[i]); if (DEP[i] === 2) mxr = Math.max(mxr, r); mxe = Math.max(mxe, r + R[i]); }
          lo[2] = rIn2 - maxU2; hi[2] = mxe + 2;
          dbg.push({ d: 2, n: byD[2].length, mode: "tier1", rIn0: +r0.toFixed(1), rIn: +rIn2.toFixed(1), bumps: bumps2, broods: broods.length, fill1: +(total / TAU).toFixed(2), out: +mxr.toFixed(1) });
        }
      }
    }

    let passes = 0;
    if (banded) {
      // ---- deterministic jitter (crowns + root ring), whole units: radius +-a*slot (inner row outward only), angle +-0.2*step ----
      for (const [i, slot, inner, a] of jit) {
        const r0 = Math.hypot(X[i], Y[i]), t0 = Math.atan2(Y[i], X[i]);
        const jr = (rnd(sd(i), 31) - (inner ? 0 : 0.5)) * 2 * a * slot * (inner ? 0.5 : 1);
        const r = r0 + jr, th = t0 + (rnd(sd(i), 32) - 0.5) * 0.4 * slot / Math.max(1, r0);
        moveUnit(i, Math.cos(th) * r - X[i], Math.sin(th) * r - Y[i]);
      }
      // band limits for the collision pass: band 1 never reaches into the gutter before band 2
      const DB = Math.min(D, 3);
      for (let d = 1; d < DB; d++) {
        if (d + 1 < DB) hi[d] = lo[d + 1] - 0.5 * gapR - 0.5 * gapR / GAPR;
        else if (d === 1) { let m = 0; for (const i of byD[1]) m = Math.max(m, Math.hypot(X[i], Y[i]) + R[i]); hi[1] = m + 2; }
        for (const i of byD[d]) {
          const r0 = Math.hypot(X[i], Y[i]) || 1e-6, rr = Math.min(Math.max(r0, lo[d] + U[i]), Math.max(lo[d] + U[i], hi[d] - U[i]));
          if (rr !== r0) moveUnit(i, X[i] * (rr / r0 - 1), Y[i] * (rr / r0 - 1));
        }
      }
      passes = resolve(f, lo, hi);
    } else {
      // ---- UNITS: every brood local, nested; the root's unit is the whole family ----
      nUnitsFam++;
      for (const i of f.members) BD[i] = 1;
      for (let d = 1; d < D; d++) noArc[d] = true;
      for (let d = D - 2; d >= 0; d--) for (const p of byD[d]) if (kids[p].length) buildUnit(p, p === top);
      placeUnitAt(top, 0, 0, 0);
      let un = 0; for (const p of f.members) if (LOC[p] && p !== top) un++;
      passes = resolve(f, null, null);
      dbg.push({ d: 1, n: kids[top].length, mode: "units", units: un, seedRoot: kids[top].length > CROWN_MAX });
    }
    for (const i of f.members) { NR[i] = Math.hypot(X[i], Y[i]); TH[i] = Math.atan2(Y[i], X[i]); }
    // ---- strays (safety net): a small subtree left far from its parent is pulled in next to it ----
    const strayArc = pullStrays(f, byD);
    strayArc.forEach((v, d) => { if (v) noArc[d] = true; });

    // ---- rotation: the largest gen-1 child at 75 deg +- 15 deg (upper middle; leaves the E label slot free) ----
    const big = kids[top].slice().sort(byMc)[0];
    // (round 2 final) 100 deg +- 55 deg (was 75 +- 15): at the overview the biggest child sat tangent to nearly every chip at
    // 12 o'clock and read as a row of notification badges. Still clear of the E label slot.
    const rot = (100 + (rnd(fs(f), 5) - 0.5) * 110) * DEG - Math.atan2(Y[big], X[big]);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (const i of f.members) { const x = X[i], y = Y[i]; X[i] = x * cr - y * sr; Y[i] = x * sr + y * cr; NR[i] = Math.hypot(X[i], Y[i]); TH[i] = norm2pi(Math.atan2(Y[i], X[i])); }
    NR[top] = 0; TH[top] = norm2pi(rot);

    // ---- band records ----
    const bandIn = [0], bandOut = [R[top]], ring = [0], count = [1], arcR = [0], genSpan = [[]];
    let Rc = R[top];
    for (let d = 1; d < D; d++) {
      let a = Infinity, b = 0; const iv = [];
      for (const i of byD[d]) {
        const r = NR[i]; a = Math.min(a, r - R[i]); b = Math.max(b, r + R[i]); Rc = Math.max(Rc, r + R[i]);
        const w = Math.asin(Math.min(1, R[i] / Math.max(r, 1e-3))) + 3 * DEG;
        iv.push([TH[i] - w, TH[i] + w]);
      }
      bandIn[d] = a; bandOut[d] = b; ring[d] = (a + b) / 2; count[d] = byD[d].length;
      arcR[d] = a - Math.min(0.5 * gapR, 0.5 * Math.max(0, a - bandOut[d - 1]));
      genSpan[d] = mergeSpans(iv, 8 * DEG, 354 * DEG);
      if (!dbg[d - 1]) dbg[d - 1] = { d, mode: banded ? "local" : "units" };
      Object.assign(dbg[d - 1], { bandIn: +a.toFixed(1), bandOut: +b.toFixed(1), arcR: +arcR[d].toFixed(1), spans: genSpan[d].length, noArc: !!noArc[d] });
    }
    if (dbg.length) dbg[0].resolvePasses = passes;
    Object.assign(f, { bandIn, bandOut, ring, count, arcR, genSpan, Rc: Rc * 1.04, coreR: R[top], dbg, noArc, layoutMode: banded ? "banded" : "units" });
  }

  // subtree members of i (i included)
  const subtree = (i) => { const out = [i]; for (let q = 0; q < out.length; q++) for (const c of kids[out[q]]) out.push(c); return out; };
  let strayN = 0, strayGain = 0;
  function pullStrays(f, byD) {
    const noArc = [];
    if (f.members.length < 3) return noArc;
    let maxRr = 0; for (const i of f.members) maxRr = Math.max(maxRr, R[i]);
    const cell = 2 * maxRr + EG, grid = new Map(), key = (gx, gy) => (gx + 32768) * 65536 + (gy + 32768);
    const gAdd = (i) => { const k = key(Math.floor(X[i] / cell), Math.floor(Y[i] / cell)); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); };
    const gDel = (i) => { const k = key(Math.floor(X[i] / cell), Math.floor(Y[i] / cell)); const a = grid.get(k); if (a) { const q = a.indexOf(i); if (q >= 0) a.splice(q, 1); } };
    for (const i of f.members) gAdd(i);
    const freeAt = (i, x, y, skip) => {
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell), reach = Math.ceil((R[i] + maxRr + EG) / cell);
      for (let ox = -reach; ox <= reach; ox++) for (let oy = -reach; oy <= reach; oy++) {
        const a = grid.get(key(gx + ox, gy + oy)); if (!a) continue;
        for (const j of a) { if (skip.has(j)) continue; const dx = x - X[j], dy = y - Y[j], m = R[i] + R[j] + EG * 1.4; if (dx * dx + dy * dy < m * m) return false; }
      }
      return true;
    };
    for (let d = 2; d < byD.length; d++) for (const c of byD[d]) {
      const p = S.par[c]; if (p < 0 || kids[p].length > 3) continue;
      const sub = subtree(c); if (sub.length > 12) continue;
      const dx0 = X[c] - X[p], dy0 = Y[c] - Y[p], dist = Math.hypot(dx0, dy0), want = R[p] + R[c] + 1.6;
      if (dist - want < 6) continue;
      const skip = new Set(sub);
      const base = Math.atan2(dy0, dx0);
      let best = null;
      // nearest free spot around the parent: rings from the touching distance outward, angles fanning from the
      // current bearing (so the stray stays on its side of the parent)
      for (let r = want; r < dist - 3 && !best; r += 0.6) {
        for (let q = 0; q <= 16 && !best; q++) {
          const a = base + (q % 2 ? 1 : -1) * Math.ceil(q / 2) * 12 * DEG;
          const x = X[p] + Math.cos(a) * r, y = Y[p] + Math.sin(a) * r;
          const tx = x - X[c], ty = y - Y[c];
          let ok = true; for (const m of sub) if (!freeAt(m, X[m] + tx, Y[m] + ty, skip)) { ok = false; break; }
          if (ok) best = [tx, ty, r];
        }
      }
      if (!best) continue;
      for (const m of sub) { gDel(m); X[m] += best[0]; Y[m] += best[1]; NR[m] = Math.hypot(X[m], Y[m]); TH[m] = Math.atan2(Y[m], X[m]); gAdd(m); }
      for (const m of sub) noArc[DEP[m]] = true;
      strayN++; strayGain += dist - best[2];
    }
    return noArc;
  }

  // grid-based pairwise resolution inside one family (local coords, before rotation)
  function resolve(f, lo, hi) {
    // the top is never in the grid: band clamps keep every member outside its gutter
    const m = f.members.filter((i) => DEP[i] > 0);
    if (m.length < 2) return 0;
    const rs = m.map((i) => R[i]).sort((x, y) => x - y), q90 = rs[Math.floor(rs.length * 0.9)];
    const cell = Math.max(2, 2 * q90 + EG), grid = new Map();
    const key = (gx, gy) => (gx + 32768) * 65536 + (gy + 32768);
    const clampBand = (i) => {
      if (!lo) return;                     // (round 2) units families: no bands to clamp to
      const d = BD[i];                     // the band of the coin's unit (local descendants share their anchor's band)
      const r = Math.hypot(X[i], Y[i]) || 1e-6, rmin = lo[d] + R[i], rmax = Math.max(rmin, hi[d] - R[i]);
      const rr = Math.min(rmax, Math.max(rmin, r));
      if (rr !== r) { X[i] *= rr / r; Y[i] *= rr / r; }
    };
    let moved = 1, pass = 0;
    for (; pass < 14 && moved; pass++) {
      moved = 0; grid.clear();
      for (const i of m) { const k = key(Math.floor(X[i] / cell), Math.floor(Y[i] / cell)); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
      for (const i of m) {
        // each pair is handled once, from its larger member, which reaches far enough to see the smaller one
        const gx = Math.floor(X[i] / cell), gy = Math.floor(Y[i] / cell), reach = Math.ceil((2 * R[i] + EG) / cell);
        for (let ox = -reach; ox <= reach; ox++) for (let oy = -reach; oy <= reach; oy++) {
          const a = grid.get(key(gx + ox, gy + oy)); if (!a) continue;
          for (const j of a) {
            if (R[j] > R[i] || (R[j] === R[i] && j <= i)) continue;
            let dx = X[j] - X[i], dy = Y[j] - Y[i]; const need = R[i] + R[j] + EG; const d2 = dx * dx + dy * dy;
            if (d2 >= need * need - 1e-6) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-6) { const a2 = rnd(sd(i) + sd(j), 7) * TAU; dx = Math.cos(a2); dy = Math.sin(a2); d = 0; } else { dx /= d; dy /= d; }
            const ov = need - d + 1e-3;
            // mover: the deeper one, else the smaller one (j is never larger than i); equal size and depth: split
            if (DEP[i] !== DEP[j] || R[i] !== R[j]) {
              const mv = DEP[i] !== DEP[j] ? (DEP[j] > DEP[i] ? j : i) : j, sg = mv === j ? 1 : -1;
              X[mv] += sg * dx * ov; Y[mv] += sg * dy * ov; clampBand(mv);
            } else {
              X[i] -= dx * ov * 0.5; Y[i] -= dy * ov * 0.5; X[j] += dx * ov * 0.5; Y[j] += dy * ov * 0.5; clampBand(i); clampBand(j);
            }
            moved++;
          }
        }
      }
    }
    for (const i of m) { NR[i] = Math.hypot(X[i], Y[i]); TH[i] = Math.atan2(Y[i], X[i]); }
    return pass;
  }

  // ---------- GALAXY look (2026-10-21, layout+veins lane): every family = radial tidy tree with generation BANDS ----------
  // Ported from the reference monolith (mapThree/_legacy/app.monolith.js:79-122): d3 tidy tree for the angular order
  // (size-aware separation), one ring per generation; a crowded generation splits into S sub-rings (S = 1..4, only when
  // n > 3S, accepted when its outer radius is < 0.85 x the previous candidate's). Every generation IS a band (f.noArc all
  // false), so the veins lane draws a ring at f.ring[d] and the labels lane tags every generation. f.Rc is the TIGHT
  // bound (last bandOut + last maxR). Only when S.look === "galaxy"; the flat path above is untouched.
  const G = S.look === "galaxy", T = S.tok || TOK, GG = T.gen || {};
  const G_GAP = GG.GAP ?? 0.7, G_GAPR = GG.GAPR ?? 2.4, G_FIRST = GG.firstX ?? 1.6, G_STEPK = GG.stepK ?? 1.4, G_SUBMAX = GG.subMax ?? 4, G_ACC = GG.acceptK ?? 0.85;
  const trG = G ? tree().size([TAU, 1]).separation((a, b) => (R[a.data] + R[b.data] + G_GAP) * (a.parent === b.parent ? 1 : 1.35) / Math.max(1, a.depth)) : null;
  let galSubRings = 0, galMaxGens = 0;
  function layoutFamilyGalaxy(f) {
    const top = f.top, dbg = [];
    for (const i of f.members) { LOC[i] = 0; U[i] = R[i]; UOX[i] = 0; UOY[i] = 0; }
    X[top] = 0; Y[top] = 0; NR[top] = 0; DEP[top] = 0;
    const rot = rnd(fs(f), 5) * TAU;
    if (f.members.length === 1) {
      TH[top] = norm2pi(rot);
      Object.assign(f, { bandIn: [0], bandOut: [R[top]], ring: [0], count: [1], arcR: [0], genSpan: [[]], Rc: R[top], coreR: R[top], dbg, noArc: [], layoutMode: "galaxy" });
      return;
    }
    const root = hierarchy(top, (i) => kids[i].length ? kids[i].slice().sort(byMc) : null);
    trG(root);
    const byD = []; root.each((n) => { (byD[n.depth] ||= []).push(n); DEP[n.data] = n.depth; });
    const maxR = byD.map((a) => a.reduce((m, n) => Math.max(m, R[n.data]), 0));
    const ring = [0], bandIn = [0], bandOut = [R[top]], count = [1], arcR = [0], genSpan = [[]], noArc = [false];
    let prevOuter = 0;
    for (let d = 1; d < byD.length; d++) {
      const rmin = prevOuter + maxR[d - 1] + maxR[d] + G_GAPR * (d === 1 ? G_FIRST : 1), step = 2 * maxR[d] + G_GAP * G_STEPK;
      const arr = byD[d].sort((a, b) => a.x - b.x), n = arr.length;
      // d3's seam (last -> first) is one separation wide; with Sn sub-rings it must be ~Sn wide, so compress the angles a touch
      const x0a = n ? arr[0].x : 0, cS = (Sn) => Sn === 1 || n < 2 ? 1 : (n - Sn) / (n - 1);
      const req = (Sn) => {
        let r = rmin; const c = cS(Sn);
        for (let s0 = 0; s0 < Sn; s0++) {
          const sub = [], sr = [];
          for (let k = s0; k < n; k += Sn) { sub.push(x0a + (arr[k].x - x0a) * c); sr.push(R[arr[k].data]); }
          if (sub.length < 2) continue;
          for (let k = 0; k < sub.length; k++) {
            const dth = k + 1 < sub.length ? sub[k + 1] - sub[k] : TAU - (sub[k] - sub[0]);
            if (dth < Math.PI) r = Math.max(r, (sr[k] + sr[(k + 1) % sr.length] + G_GAP) / (2 * Math.sin(Math.max(1e-4, dth) / 2)));
          }
        }
        return r;
      };
      let Sn = 1, r = req(1), outer = r;
      for (let s2 = 2; s2 <= G_SUBMAX && n > s2 * 3; s2++) { const r2 = req(s2), o2 = r2 + (s2 - 1) * step; if (o2 < outer * G_ACC) { Sn = s2; r = r2; outer = o2; } }
      if (Sn > 1) galSubRings++;
      dbg.push({ d, n, S: Sn, step: +step.toFixed(2), rmin: +rmin.toFixed(1), r: +r.toFixed(1), outer: +outer.toFixed(1), maxR: +maxR[d].toFixed(2), mode: "galaxy" });
      { const c = cS(Sn); arr.forEach((nd, k) => { nd.x = x0a + (nd.x - x0a) * c; NR[nd.data] = r + (k % Sn) * step; }); }
      // band records: bandIn/bandOut = first/last sub-ring CENTRE radius (as the reference); ring = their mean; the arc
      // radius sits in the gutter below the band (flat-style consumers), the galaxy rings are drawn at f.ring[d]
      bandIn[d] = r; bandOut[d] = outer; ring[d] = (r + outer) / 2; count[d] = n; prevOuter = outer;
      arcR[d] = Math.max(0, r - maxR[d] - 0.5 * G_GAPR); genSpan[d] = [[0, TAU]]; noArc[d] = false;
    }
    galMaxGens = Math.max(galMaxGens, byD.length);
    NR[top] = 0;
    root.each((n) => { const i = n.data, th = norm2pi(n.x + rot), r = NR[i]; TH[i] = th; X[i] = Math.cos(th) * r; Y[i] = Math.sin(th) * r; });
    X[top] = 0; Y[top] = 0; TH[top] = norm2pi(rot);
    const lastD = byD.length - 1, Rc = lastD >= 1 ? bandOut[lastD] + maxR[lastD] : R[top];
    Object.assign(f, { bandIn, bandOut, ring, count, arcR, genSpan, Rc, coreR: R[top], dbg, noArc, layoutMode: "galaxy" });
  }

  let tSlice = performance.now();
  for (const f of fams) {
    if (G) layoutFamilyGalaxy(f); else layoutFamily(f);
    if (pause && performance.now() - tSlice > SLICE_MS) { await pause(); tSlice = performance.now(); }
  }
  if (G) S.debug.map.galaxyLayout = { subRingBands: galSubRings, maxGens: galMaxGens };
  const tFam = performance.now();
  S.debug.map.strays = { n: strayN, gain: Math.round(strayGain) };
  S.debug.map.units = { families: nUnitsFam, seedHeads, rosettes: nRosette, seedMs: Math.round(seedMs) };

  // ---------- planet packing: greedy closest-tangent (share desc) + relaxation toward the area-weighted centroid ----------
  // Hull = f.Rc + pad (spec). At the overview a planet is drawn as a chip of TOK.chipR CSS px, which for the
  // small planets is larger than the family itself, so the hull is also floored at the chip (+2 px) at the phone
  // overview zoom k = (390 - 32) / (2 * Rcl) (iterated; desktop zooms are larger, so chips never touch).
  const sortedRc = planets.map((f) => f.Rc).sort((a, b) => a - b);
  const medRc = sortedRc.length ? sortedRc[Math.floor(sortedRc.length / 2)] : 10;
  const maxShare = S.maxShare || 1;
  const chipPx = (f) => TOK.chipR(f.share, maxShare, true);
  const C = planets.slice().sort((a, b) => b.share - a.share || b.value - a.value).map((f) => ({ f, r0: f.Rc + 0.10 * medRc + 0.03 * f.Rc, r: 0, x: 0, y: 0 }));
  const centroid = () => { let sx = 0, sy = 0, sw = 0; for (const c of C) { const w = c.r * c.r; sx += c.x * w; sy += c.y * w; sw += w; } return [sx / sw, sy / sw]; };
  const separate = () => {
    let any = false;
    for (let a = 0; a < C.length; a++) for (let b = a + 1; b < C.length; b++) {
      const A = C[a], B = C[b]; let dx = B.x - A.x, dy = B.y - A.y; const d = Math.hypot(dx, dy), s = A.r + B.r;
      if (d >= s - 1e-9) continue;
      any = true;
      if (d < 1e-9) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
      const ov = s - d + 1e-6, wa = B.r * B.r / (A.r * A.r + B.r * B.r), wb = 1 - wa;
      A.x -= dx * ov * wa; A.y -= dy * ov * wa; B.x += dx * ov * wb; B.y += dy * ov * wb;
    }
    return any;
  };
  // (final polish) greedy closest-tangent packing instead of d3.packSiblings: each hull (share order, so $PUMP and $Kimchi
  // sit tangent at the centre) goes to the free tangent spot nearest the area-weighted centroid of those already placed.
  // packSiblings' front chain left the smallest planets on a spiral arm; this keeps the outline round, no stranded family.
  // (round 2 final) phone: the planets pack into a PORTRAIT ellipse of the viewport's aspect (ASP = usable height / width),
  // so the overview uses the height of the screen instead of a landscape ring letterboxed into it. The distance to the
  // centroid is measured with y / ASP, the second planet stacks vertically, and the relaxation pulls harder sideways.
  // Desktop: ASP = 1, i.e. exactly the round-1 packing.
  // (map3 port) the usable space is the fit rect (the container minus the page's chrome bands) at build time:
  // ASP = clamp((h' - 16) / (w' - 16), 1, 2.2). A rotation across the phone band rebuilds the engine (ThreeMap).
  const fitR = S.fitRect(), fitW = fitR.x1 - fitR.x0, fitH = fitR.y1 - fitR.y0;
  const ASP = S.phone() ? Math.max(1, Math.min(2.2, (fitH - 16) / Math.max(1, fitW - 16))) : 1, ASPM = Math.pow(ASP, 1.2);
  function greedyPack(list) {
    const placed = [];
    for (const c of list) {
      if (!placed.length) { c.x = 0; c.y = 0; placed.push(c); continue; }
      if (placed.length === 1) { const p = placed[0]; if (ASP > 1) { c.x = p.x; c.y = p.y - p.r - c.r; } else { c.x = p.x + p.r + c.r; c.y = p.y; } placed.push(c); continue; }
      let sx = 0, sy = 0, sw = 0; for (const p of placed) { const w = p.r * p.r; sx += p.x * w; sy += p.y * w; sw += w; }
      const gx = sx / sw, gy = sy / sw;
      let best = null, bd = Infinity;
      for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) {
        const A = placed[a], B = placed[b], dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy), ra = A.r + c.r, rb = B.r + c.r;
        if (d < 1e-9 || d > ra + rb || d < Math.abs(ra - rb)) continue;
        const xa = (ra * ra - rb * rb + d * d) / (2 * d), h2 = ra * ra - xa * xa; if (h2 < 0) continue;
        const h = Math.sqrt(h2), ux = dx / d, uy = dy / d;
        for (const sg of [1, -1]) {
          const px = A.x + ux * xa - uy * h * sg, py = A.y + uy * xa + ux * h * sg, dd = (px - gx) ** 2 + ((py - gy) / ASPM) ** 2;
          if (dd >= bd) continue;
          let ok = true;
          for (const p of placed) { if (p === A || p === B) continue; const q = p.r + c.r - 1e-6; if ((p.x - px) ** 2 + (p.y - py) ** 2 < q * q) { ok = false; break; } }
          if (ok) { bd = dd; best = [px, py]; }
        }
      }
      if (!best) { let m = 0; for (const p of placed) m = Math.max(m, Math.hypot(p.x - gx, p.y - gy) + p.r); best = [gx + m + c.r, gy]; }
      c.x = best[0]; c.y = best[1]; placed.push(c);
    }
  }
  let Rcl = 0, kChip = 0, RclX = 0, RclY = 0;
  const slice = async () => { if (pause && performance.now() - tSlice > SLICE_MS) { await pause(); tSlice = performance.now(); } };   // (final fix)
  for (let pass = 0; pass < 3 && C.length; pass++) {
    for (const c of C) c.r = Math.max(c.r0, kChip > 0 ? (chipPx(c.f) + 2) / kChip : 0);
    greedyPack(C);
    await slice();
    for (let it = 0; it < 80; it++) {
      const [cx, cy] = centroid();
      for (const c of C) { c.x += (cx - c.x) * 0.02; c.y += (cy - c.y) * 0.02 / (ASPM * ASPM); }
      for (let s2 = 0; s2 < 3 && separate(); s2++);
      if ((it & 15) === 15) await slice();
    }
    for (let s2 = 0; s2 < 400 && separate(); s2++) if ((s2 & 63) === 63) await slice();
    await slice();
    const [cx, cy] = centroid(); for (const c of C) { c.x -= cx; c.y -= cy; }
    Rcl = 0; for (const c of C) Rcl = Math.max(Rcl, Math.hypot(c.x, c.y) + c.r);
    RclX = 0; RclY = 0; for (const c of C) { RclX = Math.max(RclX, Math.abs(c.x) + c.r); RclY = Math.max(RclY, Math.abs(c.y) + c.r); }
    kChip = (390 - 32) / (2 * (ASP > 1 ? RclX : Rcl));
  }
  for (const c of C) { c.f.cx = c.x; c.f.cy = c.y; }
  const enc = C.length ? packEnclose(C) : { x: 0, y: 0, r: 0 };
  const chipFloored = C.filter((c) => c.r > c.r0 + 1e-6).length;

  Object.assign(S, { R, X, Y, TH, NR, notable, rad, Rcl, RclX, RclY, packAspect: ASP, planetHulls: planets.map((f) => ({ x: f.cx, y: f.cy, r: f.Rc })) });
  const layoutMs = performance.now() - tStart;

  // ---------- debug ----------
  const pump = S.famBy("PUMP"), kim = S.famBy("Kimchi");
  S.debugFns.dbg = (q) => { const f = S.famBy(q); return f && { Rc: +f.Rc.toFixed(1), coreR: +f.coreR.toFixed(2), mode: f.layoutMode, arcR: f.arcR.map((v) => +v.toFixed(1)), noArc: f.noArc.map((v) => !!v), bands: f.dbg }; };
  // round-2 numbers (world u; read S.X/S.Y at call time, so it also works after dust.js adds the family offsets):
  //   link = edge gap child -> parent; broodGap = per brood, the gap from the parent to its NEAREST child (a detached pod
  //   has a big one); seed heads: brood > 60, true-radius range, extent, nearest-neighbour heat mixing, cap-order rho
  S.debugFns.layoutStats = (tickers = ["PUMP", "CARDS", "Kimchi", "PAIR", "TikTok", "USDC"]) => {
    const { X: x, Y: y, par, age: ag } = S;
    const fam = (f) => {
      const L = []; let maxBrood = 0;
      for (const i of f.members) { const p = par[i]; if (p >= 0) L.push(Math.hypot(x[i] - x[p], y[i] - y[p]) - R[i] - R[p]); }
      for (const p of f.members) { if (!kids[p].length || p === f.top) continue; let mn = Infinity; for (const c of kids[p]) mn = Math.min(mn, Math.hypot(x[c] - x[p], y[c] - y[p]) - R[c] - R[p]); maxBrood = Math.max(maxBrood, mn); }
      L.sort((a, b) => a - b); const q = (t) => L.length ? +L[Math.min(L.length - 1, Math.floor(t * L.length))].toFixed(1) : 0;
      return { mode: f.layoutMode, members: f.members.length, Rc: +f.Rc.toFixed(1), maxLink: q(1), p95: q(0.95), p50: q(0.5), over20: L.filter((v) => v > 20).length, maxBroodGap: +maxBrood.toFixed(1), ink: Math.round(L.reduce((a, b) => a + Math.max(0, b), 0)) };
    };
    let gMax = 0, gF = "", over20 = 0, gBrood = 0, gBF = "";
    for (const f of fams) { const s = fam(f); if (s.maxLink > gMax) { gMax = s.maxLink; gF = S.sym[f.top]; } over20 += s.over20; if (s.maxBroodGap > gBrood) { gBrood = s.maxBroodGap; gBF = S.sym[f.top]; } }
    const seeds = [];
    for (const f of fams) for (const p of f.members) {
      const ch = kids[p]; if (ch.length <= 60) continue;
      let rmin = Infinity, rmax = 0, ext = 0; for (const c of ch) { rmin = Math.min(rmin, R[c]); rmax = Math.max(rmax, R[c]); ext = Math.max(ext, Math.hypot(x[c] - x[p], y[c] - y[p]) + R[c]); }
      let diff = 0, tot = 0; const cell = 6, g = new Map(), k2 = (a, b) => a * 1e6 + b;
      for (const c of ch) { const k = k2(Math.floor(x[c] / cell), Math.floor(y[c] / cell)); let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(c); }
      for (const c of ch) { let bd = Infinity, bj = -1; const gx = Math.floor(x[c] / cell), gy = Math.floor(y[c] / cell); for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (const d of g.get(k2(gx + ox, gy + oy)) || []) { if (d === c) continue; const dd = (x[c] - x[d]) ** 2 + (y[c] - y[d]) ** 2; if (dd < bd) { bd = dd; bj = d; } } if (bj >= 0) { tot++; if (heatClass(ag[c]) !== heatClass(ag[bj])) diff++; } }
      const ds = ch.map((c) => Math.hypot(x[c] - x[p], y[c] - y[p])), rank = (arr) => { const o = arr.map((v, k) => k).sort((a, b) => arr[a] - arr[b]); const r = new Array(arr.length); o.forEach((k, q) => { r[k] = q; }); return r; };
      const rd = rank(ds), rm = rank(ch.map((c) => -mc[c])), n = ch.length; let ss = 0; for (let k = 0; k < n; k++) ss += (rd[k] - rm[k]) ** 2;
      seeds.push({ fam: S.sym[f.top], parent: S.sym[p], n, ext: +ext.toFixed(1), Rmin: +rmin.toFixed(2), Rmax: +rmax.toFixed(2), heatMix: +(diff / Math.max(1, tot)).toFixed(3), capRho: +(1 - 6 * ss / (n * (n * n - 1))).toFixed(3) });
    }
    seeds.sort((a, b) => b.n - a.n);
    const by = {}; for (const t of tickers) { const f = S.famBy(t); if (f) by[t] = fam(f); }
    return { maxLink: +gMax.toFixed(1), maxLinkFam: gF, linksOver20: over20, maxBroodGap: +gBrood.toFixed(1), maxBroodFam: gBF, strays: S.debug.map.strays, units: S.debug.map.units, families: by, seeds };
  };
  Object.assign(S.debug.map, {
    kimchi: kim && { members: kim.members.length, gens: kim.count, bandIn: kim.bandIn.map(Math.round), bandOut: kim.bandOut.map(Math.round), Rc: Math.round(kim.Rc) },
    Rcl: Math.round(Rcl), RclEnclose: Math.round(enc.r), encOff: Math.round(Math.hypot(enc.x, enc.y)), chipFloored, kChip: +kChip.toFixed(3),
    pump: pump && { members: pump.members.length, gens: pump.count, rings: pump.ring.map((r) => Math.round(r)), Rc: Math.round(pump.Rc), share: +pump.share.toFixed(3) },
    layoutMs: Math.round(layoutMs), layoutFamMs: Math.round(tFam - tStart),
  });
  S.debugFns.overlapCheck = () => {
    const { X: x, Y: y } = S;
    let n = 0, worst = 0, fn = 0;
    for (const f of fams) {
      const m = f.members; if (m.length < 2) continue; fn++;
      let mr = 0; for (const i of m) mr = Math.max(mr, R[i]);
      const cell = 2 * mr + 0.01, g = new Map(), key = (a, b) => a * 1e6 + b;
      for (const i of m) { const k = key(Math.floor(x[i] / cell), Math.floor(y[i] / cell)); let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(i); }
      for (const i of m) {
        const gx = Math.floor(x[i] / cell), gy = Math.floor(y[i] / cell);
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
          const a = g.get(key(gx + ox, gy + oy)); if (!a) continue;
          for (const j of a) { if (j <= i) continue; const d = Math.hypot(x[i] - x[j], y[i] - y[j]), s = R[i] + R[j]; if (d < s - 1e-3) { n++; worst = Math.max(worst, s - d); } }
        }
      }
    }
    let hn = 0; const H = S.planetHulls;
    for (let a = 0; a < H.length; a++) for (let b = a + 1; b < H.length; b++) if (Math.hypot(H[a].x - H[b].x, H[a].y - H[b].y) < H[a].r + H[b].r - 1e-3) hn++;
    return { pairsOverlapping: n, worst: +worst.toFixed(3), hullsOverlapping: hn, families: fn };
  };
}
