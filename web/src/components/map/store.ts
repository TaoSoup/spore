// Structure-of-arrays store for the bubbles: typed arrays the draw loop and the worker share by index,
// a parallel `data` array with the BubbleNode records, and derived structures (draw order, parent
// links, child adjacency, root clusters with their hulls and title anchors) rebuilt only when the node
// set changes. Positions come from the worker as `nx/ny`; `px/py` is the previous frame and `x/y` the
// interpolated position the frame draws, so a 50 ms worker tick still moves bubbles smoothly at 60 fps.
// A drag grabs one bubble (`beginDrag`): the page puts it under the pointer and the worker's live
// simulation moves everything else; `endDrag` lets it go.
// Family tops (a node with children and no parent on the map: a SOL root or a listed asset such as
// $PUMP) are flagged in `top`, and the draw order puts every top after every other bubble (from
// `topStart` on), so a family's top is never covered by its own children.
// Per-node render caches (last sprite, label bitmap, letter) live here too, so a store rebuild drops
// them together with the indices they belong to.
import { packSiblings } from "d3";
import { count as fmtCount } from "../../lib/format";
import { placeChild } from "../../lib/map/place";
import type { BubbleNode } from "../../lib/map/types";
export { valueOf } from "../../lib/map/sizing";

// Depth palette: root lime, d1 mint, d2 violet, d3+ amber. Same order as the DepthBadge so a colour
// means one thing everywhere on the site.
export const COLORS = ["#b6ff5c", "#5ce0c8", "#b08cff", "#ffcf5c"];
export const colorIdx = (depth: number) => Math.min(depth, COLORS.length - 1);
/// One neutral hull tint for every tree (the depth colours stay reserved for depth, and a single
/// tint passes colour-blind checks); the active tree is drawn lime instead.
export const HULL = "#a8c4b0";
/// F_MATCH is meaningful only while the draw state's `highlight` is on; F_MIG = graduated (PumpSwap).
export const F_OURS = 1, F_ANC = 2, F_FOCUS = 4, F_FIXED = 8, F_MATCH = 16, F_MIG = 32;
/// Hull glows only for this many clusters (the largest); the rest are drawn without a blob.
export const BIG_CLUSTERS = 60;
/// Clusters with fewer members than this get no title at overview zoom.
export const TITLE_MIN = 3;

export type Cluster = {
  id: string; cx: number; cy: number; R: number; hue: string; members: number[]; maxR: number; hull: Float32Array; hullN: number; big: boolean;
  /// Root node index, member count, title text (`$TICK · 716`), Σ mcap, title rank (count; ties by the root's locked value).
  root: number; title: string; count: number; mcapSum: number; score: number;
  /// Title / hit anchors in world units, refreshed on worker frames: centroid, enclosing radius, top edge.
  ccx: number; ccy: number; cr: number; minY: number;
  /// Anchors seeded once (the EMA smoothing starts from the first measurement, not from 0).
  anchored: boolean;
  /// Text after the title (the family's dominance on /map, "23%"; BubbleMap's titleTags), "" = none;
  /// `tagC` is the one compact (phone) titles use.
  tag?: string; tagC?: string;
  /// Title bitmaps (draw.ts), valid while tspText === title; the tag's (shared) bitmaps while tagText === the tag in use.
  tsp?: HTMLCanvasElement | null; tspA?: HTMLCanvasElement | null; tspText?: string; tspW?: number; tspC?: boolean;
  tagSp?: HTMLCanvasElement | null; tagSpA?: HTMLCanvasElement | null; tagText?: string; tagSpC?: boolean;
};
/// Per-node render cache rings: once this many logo sprites / label bitmaps exist, the oldest is dropped.
export const SPR_RING = 6000, LABEL_RING = 3000;
/// More changed radii than this re-sort the whole draw order instead of one memmove per node.
export const REORDER_MAX = 400;

export const letterOf = (symbol: string | null, name: string | null) => (symbol || name || "?").replace(/^\$/, "").slice(0, 1).toUpperCase();
/// Ticker when there is one, else the on-chain name (never a bare mint when the coin has a name).
export const labelOf = (symbol: string | null, name: string | null, mint: string) => symbol ? `$${symbol.replace(/^\$/, "")}` : name ? (name.length > 14 ? `${name.slice(0, 13)}…` : name) : `${mint.slice(0, 4)}…`;

/// EMA weight for title anchors while the layout settles (titles glide instead of jittering).
const ANCHOR_EMA = 0.35;
/// Formatted member counts, cached: 2 000 clusters share a few hundred distinct counts, and the Intl
/// formatter behind count() cost 12 ms per rebuild when every title was formatted again on each live pair.
const countText = new Map<number, string>();
const cnt = (n: number) => { let t = countText.get(n); if (t === undefined) { t = fmtCount(n); countText.set(n, t); } return t; };
const titleOf = (d: BubbleNode, members: number) => `${labelOf(d.symbol, d.name, d.mint)} · ${cnt(members)}`;
/// Gap between a newly placed child's rim and its parent's (world units; the cold layout's link length is 12–20).
export const PLACE_GAP = 8;

// Convex hull scratch (monotone chain over member indices sorted by x): grown once, then reused, so a
// hull refresh allocates nothing. The comparator reads positions through these module-level refs.
let HX: Float32Array = new Float32Array(0), HY: Float32Array = new Float32Array(0);
let hullOrd = new Int32Array(0), hullStack = new Int32Array(0);
const byX = (a: number, b: number) => HX[a] - HX[b] || HY[a] - HY[b];
const cross = (o: number, a: number, b: number) => (HX[a] - HX[o]) * (HY[b] - HY[o]) - (HY[a] - HY[o]) * (HX[b] - HX[o]);
/// Convex hull of the members' centres (members without a position are skipped) into out as x,y pairs;
/// returns the number of hull points. Fewer than three points are copied as they are.
function convexHull(mem: number[], xs: Float32Array, ys: Float32Array, out: Float32Array): number {
  if (hullOrd.length < mem.length) { hullOrd = new Int32Array(mem.length + 256); hullStack = new Int32Array(mem.length * 2 + 512); }
  let n = 0;
  for (let q = 0; q < mem.length; q++) { const i = mem[q], x = xs[i], y = ys[i]; if (x === x && y === y) hullOrd[n++] = i; }
  HX = xs; HY = ys;
  const ord = hullOrd.subarray(0, n);
  ord.sort(byX);
  const st = hullStack;
  let h = 0;
  if (n < 3) { for (let q = 0; q < n; q++) st[h++] = ord[q]; }
  else {
    for (let q = 0; q < n; q++) { const i = ord[q]; while (h >= 2 && cross(st[h - 2], st[h - 1], i) <= 0) h--; st[h++] = i; }
    const lo = h + 1;
    for (let q = n - 2; q >= 0; q--) { const i = ord[q]; while (h >= lo && cross(st[h - 2], st[h - 1], i) <= 0) h--; st[h++] = i; }
    h--; // the last point repeats the first
  }
  for (let q = 0; q < h; q++) { out[q * 2] = xs[st[q]]; out[q * 2 + 1] = ys[st[q]]; }
  return h;
}

export class MapStore {
  n = 0; cap = 0;
  ids: string[] = []; data: BubbleNode[] = []; idx = new Map<string, number>();
  x = new Float32Array(0); y = new Float32Array(0); px = new Float32Array(0); py = new Float32Array(0); nx = new Float32Array(0); ny = new Float32Array(0);
  r = new Float32Array(0); rT = new Float32Array(0); r0 = new Float32Array(0); rt0 = new Float64Array(0);
  born = new Float64Array(0); pulse = new Float64Array(0);
  depth = new Uint8Array(0); color = new Uint8Array(0); flags = new Uint8Array(0); gen = new Uint16Array(0);
  parent = new Int32Array(0); cluster = new Int32Array(0); rel = new Uint8Array(0);
  /// Live activity: epoch ms of the node's last trade (0 = none) and trades in the last hour (saturating).
  lastTrade = new Float64Array(0); t1h = new Uint16Array(0);
  order = new Int32Array(0);
  /// Valid entries of `order` (= n once rebuilt or incrementally kept), and nodes whose radius changed
  /// since the last reorder (re-sorted when their tween ends, BubbleMap → draw.ts).
  orderN = 0; reorder: number[] = [];
  /// 1 = family top (children, no parent on the map); order[topStart, n) are the tops, smallest first.
  top = new Uint8Array(0); topStart = 0;
  m = 0; lsrc = new Int32Array(0); ldst = new Int32Array(0); lseed = new Float32Array(0);
  childStart = new Int32Array(1); childList = new Int32Array(0);
  clusters: Cluster[] = []; clusterOf = new Map<string, number>();
  /// Cluster indices with ≥ TITLE_MIN members, best title first.
  titleOrder = new Int32Array(0);
  // ---- render caches (draw.ts owns their meaning; reset with the store)
  /// The node's last logo sprite, its radius bucket, the image object and gen it was built from, and its flag bits.
  spr: (HTMLCanvasElement | null)[] = []; sprRi = new Uint16Array(0); sprImg: (CanvasImageSource | null)[] = []; sprGen = new Uint16Array(0); sprBits = new Uint8Array(0);
  /// Label bitmap per node, the record it was built for and its variant (0 normal, 1 big, 2 focus).
  labelSp: (HTMLCanvasElement | null)[] = []; labelOwner: (BubbleNode | null)[] = []; labelVariant = new Uint8Array(0);
  /// First letter (char code) for the letter avatar, valid while letterOwner[i] === data[i].
  letter = new Uint16Array(0); letterOwner: (BubbleNode | null)[] = [];
  /// Eviction rings for the two per-node bitmap caches above (node indices, -1 = empty).
  sprRing = new Int32Array(SPR_RING).fill(-1); sprRingW = 0; labelRing = new Int32Array(LABEL_RING).fill(-1); labelRingW = 0;
  // worker frame interpolation
  tickAt = 0; tickDt = 40; settled = true; alpha = 0; tweening = false; maxR = 1;
  // ---- drag (BubbleMap writes it, draw.ts reads it)
  /// A bubble is being dragged right now: the grabbed node and its tree (cluster index).
  dragging = false; dragRoot = -1; dragCluster = -1;

  grow(min: number) {
    if (min <= this.cap) return;
    const cap = Math.max(min, Math.ceil(this.cap * 1.5), 256);
    const f32 = (a: Float32Array) => { const b = new Float32Array(cap); b.set(a); return b; };
    const f64 = (a: Float64Array) => { const b = new Float64Array(cap); b.set(a); return b; };
    this.x = f32(this.x); this.y = f32(this.y); this.px = f32(this.px); this.py = f32(this.py); this.nx = f32(this.nx); this.ny = f32(this.ny);
    this.r = f32(this.r); this.rT = f32(this.rT); this.r0 = f32(this.r0); this.rt0 = f64(this.rt0); this.born = f64(this.born); this.pulse = f64(this.pulse);
    this.lastTrade = f64(this.lastTrade);
    const u8 = (a: Uint8Array) => { const b = new Uint8Array(cap); b.set(a); return b; };
    this.depth = u8(this.depth); this.color = u8(this.color); this.flags = u8(this.flags); this.rel = u8(this.rel); this.top = u8(this.top);
    this.sprBits = u8(this.sprBits); this.labelVariant = u8(this.labelVariant);
    const u16 = (a: Uint16Array) => { const b = new Uint16Array(cap); b.set(a); return b; };
    this.gen = u16(this.gen); this.t1h = u16(this.t1h); this.sprRi = u16(this.sprRi); this.sprGen = u16(this.sprGen); this.letter = u16(this.letter);
    const i32 = (a: Int32Array) => { const b = new Int32Array(cap); b.set(a); return b; };
    this.parent = i32(this.parent); this.cluster = i32(this.cluster);
    // object arrays stay packed (no holes): the draw loop reads them for every visible node
    for (let i = this.spr.length; i < cap; i++) { this.spr.push(null); this.sprImg.push(null); this.labelSp.push(null); this.labelOwner.push(null); this.letterOwner.push(null); }
    this.cap = cap;
  }

  /// Appends a node at (x, y) with radius r. Links/adjacency/order are rebuilt by the caller afterwards.
  add(d: BubbleNode, x: number, y: number, r: number, now: number, flags = 0): number {
    const i = this.n;
    this.grow(i + 1);
    this.ids[i] = d.mint; this.data[i] = d; this.idx.set(d.mint, i);
    this.x[i] = this.px[i] = this.nx[i] = x; this.y[i] = this.py[i] = this.ny[i] = y;
    this.r[i] = this.rT[i] = this.r0[i] = r; this.rt0[i] = 0;
    this.born[i] = now; this.pulse[i] = 0;
    this.depth[i] = Math.min(255, d.depth); this.color[i] = colorIdx(d.depth); this.flags[i] = flags | (d.ours ? F_OURS : 0) | (d.migrated ? F_MIG : 0); this.gen[i] = 0;
    this.parent[i] = -1; this.cluster[i] = -1; this.rel[i] = 0; this.top[i] = 0;
    this.lastTrade[i] = 0; this.t1h[i] = 0;
    this.spr[i] = null; this.sprImg[i] = null; this.sprRi[i] = 0; this.sprGen[i] = 0; this.sprBits[i] = 0;
    this.labelSp[i] = null; this.labelOwner[i] = null; this.labelVariant[i] = 0; this.letter[i] = 0; this.letterOwner[i] = null;
    this.n = i + 1;
    return i;
  }

  /// Letter avatar char code for node i (cached per record; the data effect swaps records on change).
  letterCode(i: number): number {
    const d = this.data[i];
    if (this.letterOwner[i] !== d) { this.letterOwner[i] = d; this.letter[i] = letterOf(d.symbol, d.name).charCodeAt(0) || 63; }
    return this.letter[i];
  }

  /// The map draws and lays out by generation inside the drawn family (hops to its top), not by
  /// pump.fun's depth: a coin quoted in a listed asset (PUMP, USDC, $baton…) is depth 0 on-chain but
  /// sits one level under that asset here, so it is coloured and pulled like a child, not a root.
  applyGenerations() {
    for (let i = 0; i < this.n; i++) {
      if (this.parent[i] < 0) continue;
      let g = 0, cur = i;
      while (this.parent[cur] >= 0 && g < 16) { cur = this.parent[cur]; g++; }
      const real = this.data[i].depth;
      if (g > real) { this.depth[i] = Math.min(255, g); this.color[i] = colorIdx(g); }
    }
  }
  /// Parent indices and the link arrays, from the records' parentMint.
  rebuildLinks() {
    const n = this.n;
    let m = 0;
    for (let i = 0; i < n; i++) { const p = this.data[i].parentMint; const pi = p ? this.idx.get(p) : undefined; this.parent[i] = pi === undefined || pi === i ? -1 : pi; if (this.parent[i] >= 0) m++; }
    if (this.lsrc.length < m) { this.lsrc = new Int32Array(m + (m >> 2) + 64); this.ldst = new Int32Array(this.lsrc.length); const s = new Float32Array(this.lsrc.length); for (let i = 0; i < s.length; i++) s[i] = Math.random(); this.lseed = s; }
    let k = 0;
    for (let i = 0; i < n; i++) if (this.parent[i] >= 0) { this.lsrc[k] = this.parent[i]; this.ldst[k] = i; k++; }
    this.m = k;
    this.applyGenerations();
    // CSR child lists (hover highlighting, side panel chips)
    const start = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) if (this.parent[i] >= 0) start[this.parent[i] + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const list = new Int32Array(Math.max(1, start[n]));
    const fill = start.slice();
    for (let i = 0; i < n; i++) if (this.parent[i] >= 0) list[fill[this.parent[i]]++] = i;
    this.childStart = start; this.childList = list;
    for (let i = 0; i < n; i++) this.top[i] = this.parent[i] < 0 && start[i + 1] > start[i] ? 1 : 0;
  }

  /// Draw order: every other bubble first, then the family tops; inside each part small first so big
  /// bubbles and their labels sit on top, and among equal radii the higher generation first. A top is
  /// thus drawn over (and hit before) anything that touches it. Rebuilt when radii settle.
  rebuildOrder() {
    const n = this.n;
    if (this.order.length < n) this.order = new Int32Array(Math.max(n, this.cap));
    const o = this.order.subarray(0, n);
    for (let i = 0; i < n; i++) o[i] = i;
    const rT = this.rT, depth = this.depth, top = this.top;
    // a typed array sort with a comparator is fine at 20k (~6 ms) and happens on data changes only
    o.sort((a, b) => top[a] - top[b] || rT[a] - rT[b] || depth[b] - depth[a]);
    let mx = 1, tops = 0;
    for (let i = 0; i < n; i++) { if (rT[i] > mx) mx = rT[i]; tops += top[i]; }
    this.maxR = mx;
    this.topStart = n - tops;
    this.orderN = n;
    this.reorder.length = 0;
  }

  /// Position of node i in the draw order, or -1. Linear (an Int32 scan of 17 k is ~15 µs).
  private orderPos(i: number): number { const o = this.order, n = this.orderN; for (let q = 0; q < n; q++) if (o[q] === i) return q; return -1; }
  /// Takes node i out of the draw order (no-op when it is not in it).
  private orderRemove(i: number) {
    const pos = this.orderPos(i);
    if (pos < 0) return;
    this.order.copyWithin(pos, pos + 1, this.orderN);
    this.orderN--;
    if (pos < this.topStart) this.topStart--;
  }
  /// Puts node i into the draw order at its sorted place (same key as rebuildOrder: tops last, then
  /// radius ascending, then generation descending) with one memmove, no sort.
  insertOrder(i: number) {
    if (this.order.length <= this.orderN) { const o = new Int32Array(Math.max(this.orderN + 1, this.cap)); o.set(this.order.subarray(0, this.orderN)); this.order = o; }
    const o = this.order, rT = this.rT, depth = this.depth, isTop = this.top[i] === 1;
    const r = rT[i], d = depth[i];
    let lo = isTop ? this.topStart : 0, hi = isTop ? this.orderN : this.topStart;
    // first position whose key is greater than i's
    while (lo < hi) { const mid = (lo + hi) >> 1, j = o[mid]; const less = rT[j] < r || (rT[j] === r && depth[j] > d); if (less) lo = mid + 1; else hi = mid; }
    o.copyWithin(lo + 1, lo, this.orderN);
    o[lo] = i;
    this.orderN++;
    if (!isTop) this.topStart++;
    if (r > this.maxR) this.maxR = r;
  }
  /// Re-sorts only the given nodes (their radius or top flag changed): all of them are taken out in one
  /// pass (the rest is still sorted under their unchanged keys), then each is put back by binary search.
  /// Past REORDER_MAX of them a full rebuild is cheaper.
  reorderSome(list: ArrayLike<number>) {
    if (list.length > REORDER_MAX || this.orderN !== this.n) { this.rebuildOrder(); return; }
    if (list.length === 1) { const i = list[0]; if (i >= 0 && i < this.n) { this.orderRemove(i); this.insertOrder(i); } return; }
    const out = new Uint8Array(this.n);
    let k = 0;
    for (let q = 0; q < list.length; q++) { const i = list[q]; if (i >= 0 && i < this.n && !out[i]) { out[i] = 1; k++; } }
    if (!k) return;
    const o = this.order, n = this.orderN;
    let w = 0, topStart = this.topStart;
    for (let q = 0; q < n; q++) { const i = o[q]; if (out[i]) { if (q < this.topStart) topStart--; continue; } o[w++] = i; }
    this.orderN = w; this.topStart = topStart;
    for (let q = 0; q < list.length; q++) { const i = list[q]; if (i >= 0 && i < this.n && out[i]) { out[i] = 0; this.insertOrder(i); } }
  }
  /// Applies the reorders queued by the data effect (radius tweens) once their tween has ended.
  flushReorder() {
    if (!this.reorder.length) return;
    const list = this.reorder.slice();
    this.reorder.length = 0;
    this.reorderSome(list);
  }

  rootOf(i: number): number { let cur = i, hops = 0; while (this.parent[cur] >= 0 && hops++ < 16) cur = this.parent[cur]; return cur; }

  /// Links for nodes just appended (a live pair): their parent index, their link, the CSR child lists
  /// rebuilt from `parent` alone (O(n) typed-array work, no Map lookups), the generation of the newcomers
  /// and the top flag of their parents. Returns the parents that just became family tops (a lone root
  /// with its first child), which the draw order must move into its top run. Everything else keeps its
  /// parent, generation and flags: the full rebuildLinks stays for removals and parent changes.
  addLinks(added: ArrayLike<number>): number[] {
    const n = this.n;
    let m = this.m;
    const need = m + added.length;
    if (this.lsrc.length < need) {
      const cap = need + (need >> 2) + 64;
      const src = new Int32Array(cap), dst = new Int32Array(cap), seed = new Float32Array(cap);
      src.set(this.lsrc.subarray(0, m)); dst.set(this.ldst.subarray(0, m)); seed.set(this.lseed.subarray(0, Math.min(m, this.lseed.length)));
      for (let q = m; q < cap; q++) seed[q] = Math.random();
      this.lsrc = src; this.ldst = dst; this.lseed = seed;
    }
    const newTops: number[] = [];
    for (let q = 0; q < added.length; q++) {
      const i = added[q];
      const p = this.data[i].parentMint, pi = p ? this.idx.get(p) : undefined;
      this.parent[i] = pi === undefined || pi === i ? -1 : pi;
      if (this.parent[i] < 0) continue;
      this.lsrc[m] = this.parent[i]; this.ldst[m] = i; m++;
      const par = this.parent[i];
      if (this.parent[par] < 0 && !this.top[par]) { this.top[par] = 1; newTops.push(par); }
      // generation inside the drawn family (applyGenerations, for this node only)
      let g = 0, cur = i;
      while (this.parent[cur] >= 0 && g < 16) { cur = this.parent[cur]; g++; }
      if (g > this.data[i].depth) { this.depth[i] = Math.min(255, g); this.color[i] = colorIdx(g); }
    }
    this.m = m;
    const start = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) if (this.parent[i] >= 0) start[this.parent[i] + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const list = new Int32Array(Math.max(1, start[n]));
    const fill = start.slice();
    for (let i = 0; i < n; i++) if (this.parent[i] >= 0) list[fill[this.parent[i]]++] = i;
    this.childStart = start; this.childList = list;
    return newTops;
  }

  /// Puts nodes just appended into their clusters (a live pair under a known root joins that root's
  /// cluster; a new root gets a cluster on the periphery), keeping every cluster index stable: the
  /// renderer, the hovered/dragged cluster and the per-cluster scratch of draw.ts are keyed by index.
  /// Titles, counts, sums and radii are kept per cluster; the title ranking is re-sorted (2 k entries).
  /// Returns the indices of the clusters touched (the caller re-measures those).
  addToClusters(added: ArrayLike<number>): number[] {
    const touched: number[] = [];
    const mark = (ci: number) => { if (touched.indexOf(ci) < 0) touched.push(ci); };
    let ext = -1;
    for (let q = 0; q < added.length; q++) {
      const i = added[q];
      const root = this.rootOf(i), id = this.ids[root];
      let ci = this.clusterOf.get(id);
      const r = this.rT[i], mc = this.data[i].mcapUsd, mcap = mc != null && Number.isFinite(mc) ? mc : 0;
      if (ci === undefined) {
        // a brand-new root: on the periphery of the current extent, like rebuildClusters' spiral
        if (ext < 0) { ext = 0; for (const c of this.clusters) if (Number.isFinite(c.cx)) ext = Math.max(ext, Math.hypot(c.cx, c.cy) + c.R); }
        const R = (r + 6) * 1.15 + 10;
        const k = this.clusters.length, a = k * 2.399963, dd = ext + R + 20 + (k % 97) * 2;
        const c: Cluster = { id, cx: Math.cos(a) * dd, cy: Math.sin(a) * dd, R, hue: HULL, members: [i], maxR: r, hull: new Float32Array(64), hullN: 0, big: false, root, title: titleOf(this.data[root], 1), count: 1, mcapSum: mcap, score: 1, ccx: 0, ccy: 0, cr: 0, minY: 0, anchored: false };
        ci = this.clusters.length;
        this.clusters.push(c);
        this.clusterOf.set(id, ci);
        this.cluster[i] = ci;
        mark(ci);
        continue;
      }
      const c = this.clusters[ci];
      if (c.members.indexOf(i) < 0) c.members.push(i);
      c.count = c.members.length; c.score = c.count;
      c.title = titleOf(this.data[root], c.count);
      c.mcapSum += mcap;
      if (r > c.maxR) c.maxR = r;
      const sum = ((c.R - 10) / 1.15) ** 2 + (r + 6) ** 2;
      c.R = Math.sqrt(sum) * 1.15 + 10;
      if (c.hull.length < c.members.length * 2 + 2) { const h = new Float32Array(c.members.length * 2 + 64); h.set(c.hull); c.hull = h; }
      this.cluster[i] = ci;
      mark(ci);
    }
    const next = this.clusters;
    const ranked: number[] = [];
    for (let ci = 0; ci < next.length; ci++) if (next[ci].count >= TITLE_MIN) ranked.push(ci);
    const lockedOf = (ci: number) => this.data[next[ci].root].lockedUsd ?? 0;
    ranked.sort((a, b) => next[b].score - next[a].score || lockedOf(b) - lockedOf(a));
    this.titleOrder = Int32Array.from(ranked);
    return touched;
  }

  /// Deterministic spot for node i next to its parent p (lib/map/place.ts), clear of its family's
  /// other bubbles, written into nx/ny (x/y/px/py too). The family's top is kept clear as well.
  placeNear(i: number, p: number) {
    const ci = this.cluster[i], c = ci >= 0 ? this.clusters[ci] : undefined;
    const top = this.rootOf(i);
    const [x, y] = placeChild(this.nx, this.ny, this.rT, i, p, top, c ? c.members : [p, top], PLACE_GAP);
    this.nx[i] = this.x[i] = this.px[i] = x; this.ny[i] = this.y[i] = this.py[i] = y;
  }

  /// Clusters = root subtrees. Existing clusters keep their centre; new roots get a centre on the
  /// periphery of the packed arrangement (a fresh root is one bubble and must not shove the rest).
  rebuildClusters(pack: boolean, aspect: number) {
    const n = this.n;
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) { const r = this.rootOf(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); }
    const prev = new Map(this.clusters.map((c) => [c.id, c]));
    const next: Cluster[] = [];
    for (const [root, members] of groups) {
      const id = this.ids[root];
      const old = prev.get(id);
      let sum = 0, maxR = 0, mcapSum = 0;
      for (const i of members) { const r = this.rT[i]; sum += (r + 6) ** 2; if (r > maxR) maxR = r; const mc = this.data[i].mcapUsd; if (mc != null && Number.isFinite(mc)) mcapSum += mc; }
      const R = Math.sqrt(sum) * 1.15 + 10;
      const d = this.data[root];
      const title = titleOf(d, members.length);
      const c: Cluster = old
        ? Object.assign(old, { R, members, maxR, hullN: 0, root, title, count: members.length, mcapSum, score: members.length })
        : { id, cx: NaN, cy: NaN, R, hue: HULL, members, maxR, hull: new Float32Array(0), hullN: 0, big: false, root, title, count: members.length, mcapSum, score: members.length, ccx: 0, ccy: 0, cr: 0, minY: 0, anchored: false };
      if (c.hull.length < members.length * 2 + 2) c.hull = new Float32Array(members.length * 2 + 64);
      next.push(c);
    }
    next.sort((a, b) => b.members.length - a.members.length || b.R - a.R);
    next.forEach((c, i) => { c.big = i < BIG_CLUSTERS; });
    if (pack) {
      const circles = next.map((c) => ({ c, r: c.R, x: 0, y: 0 }));
      packSiblings(circles);
      const stretch = Math.min(1.6, aspect >= 1 ? aspect : 1 / aspect);
      for (const o of circles) { o.c.cx = aspect >= 1 ? o.x * stretch : o.x; o.c.cy = aspect >= 1 ? o.y : o.y * stretch; }
    } else {
      // periphery placement for clusters without a centre: golden-angle spiral outside the current extent
      let ext = 0; for (const c of next) if (Number.isFinite(c.cx)) ext = Math.max(ext, Math.hypot(c.cx, c.cy) + c.R);
      let k = 0;
      for (const c of next) if (!Number.isFinite(c.cx)) { const a = k * 2.399963; const d = ext + c.R + 20 + k * 2; c.cx = Math.cos(a) * d; c.cy = Math.sin(a) * d; k++; }
    }
    this.clusters = next;
    this.clusterOf = new Map(next.map((c, i) => [c.id, i]));
    for (const c of next) { const ci = this.clusterOf.get(c.id)!; for (const i of c.members) this.cluster[i] = ci; }
    // clusters were re-sorted: a drag in progress follows its tree to its new index
    if (this.dragging) this.dragCluster = this.dragRoot >= 0 && this.dragRoot < n ? this.cluster[this.dragRoot] : -1;
    // title ranking: member count, ties by the root's locked value
    const ranked: number[] = [];
    for (let ci = 0; ci < next.length; ci++) if (next[ci].count >= TITLE_MIN) ranked.push(ci);
    const lockedOf = (ci: number) => this.data[next[ci].root].lockedUsd ?? 0;
    ranked.sort((a, b) => next[b].score - next[a].score || lockedOf(b) - lockedOf(a));
    this.titleOrder = Int32Array.from(ranked);
  }

  /// Hull polygons of the big clusters and the title anchors of every cluster, in world units, into
  /// preallocated arrays. Called on worker frames (every few while settling, once when settled), never
  /// per drawn frame. While the layout settles the anchors are smoothed so titles glide.
  refreshHulls() {
    const ema = !this.settled;
    for (const c of this.clusters) this.measure(c, this.nx, this.ny, ema);
  }

  /// One tree's anchors (centroid, enclosing radius, top edge; EMA-smoothed when `ema`) and, for the
  /// big ones, its hull, from positions xs/ys. O(members), no allocation once the scratch has grown.
  measure(c: Cluster, xs: Float32Array, ys: Float32Array, ema: boolean) {
    const rT = this.rT, mem = c.members, mn = mem.length;
    let sx = 0, sy = 0, k = 0;
    for (let q = 0; q < mn; q++) { const i = mem[q], x = xs[i], y = ys[i]; if (x === x && y === y) { sx += x; sy += y; k++; } }
    if (k) {
      const cx = sx / k, cy = sy / k;
      let cr = 0, minY = Infinity;
      for (let q = 0; q < mn; q++) { const i = mem[q], x = xs[i], y = ys[i]; if (x !== x || y !== y) continue; const dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy) + rT[i]; if (d > cr) cr = d; const top = y - rT[i]; if (top < minY) minY = top; }
      if (ema && c.anchored) { c.ccx += (cx - c.ccx) * ANCHOR_EMA; c.ccy += (cy - c.ccy) * ANCHOR_EMA; c.cr += (cr - c.cr) * ANCHOR_EMA; c.minY += (minY - c.minY) * ANCHOR_EMA; }
      else { c.ccx = cx; c.ccy = cy; c.cr = cr; c.minY = minY; c.anchored = true; }
    }
    if (!c.big) { c.hullN = 0; return; }
    let maxR = 0;
    for (let q = 0; q < mn; q++) if (rT[mem[q]] > maxR) maxR = rT[mem[q]];
    c.maxR = maxR;
    if (c.hull.length < mn * 2 + 2) c.hull = new Float32Array(mn * 2 + 64);
    c.hullN = convexHull(mem, xs, ys, c.hull);
  }

  /// Starts a drag of node i (the page keeps it under the pointer; the simulation moves the rest).
  beginDrag(i: number) {
    this.dragging = true; this.dragRoot = i;
    this.dragCluster = i >= 0 && i < this.n ? this.cluster[i] : -1;
  }

  /// Ends the drag.
  endDrag() { this.dragging = false; this.dragRoot = -1; this.dragCluster = -1; }

  /// Marks the hovered node and its parent/children for the highlight pass; clears the previous mark.
  setRelated(prev: number, cur: number) {
    const mark = (i: number, v: number) => { if (i < 0) return; this.rel[i] = v; const p = this.parent[i]; if (p >= 0) this.rel[p] = v; for (let k = this.childStart[i]; k < this.childStart[i + 1]; k++) this.rel[this.childList[k]] = v; };
    mark(prev, 0); mark(cur, 1);
  }

  /// Settled positions for the cache. Allocates (one object per node): called when the layout settles, not per frame.
  positions(): { mint: string; x: number; y: number }[] {
    return Array.from({ length: this.n }, (_, i) => ({ mint: this.ids[i], x: Math.round(this.nx[i] * 10) / 10, y: Math.round(this.ny[i] * 10) / 10 }));
  }
}
