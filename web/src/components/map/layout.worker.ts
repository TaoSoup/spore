// d3-force off the main thread. The page sends typed arrays (positions, radii, cluster centres, links);
// the worker owns the simulation and posts positions back as transferred Float32Arrays. The page
// returns each buffer once drawn ("buf"), so after the first few frames nothing is allocated on either
// side. Once alpha falls under ALPHA_MIN the loop stops and nothing is posted until something heats
// the layout again: a cold open without cached positions, a relayout (a fresh "init"), or a drag.
//
// Forces (as the first launch had them): links to the parent, a short-range charge, collision with
// padding, and a pull toward the root's cluster centre (0.25 for a family top / depth-0 root, 0.06 for
// everything else). Family tops (a node with children and no parent link: worked out here from the
// links) also keep every member of their family outside their disc (keepOut: a hard limit at
// r_top + r + TOP_GAP on the positions the tick integrates), so the top sits in the middle of its
// family, never under it.
//
// Drag (the live simulation of the first launch; owner 2026-10-20 "the map as it was when we first
// opened the site"): one "drag" message with a phase. "start" reheats the layout (alphaTarget 0.25,
// alpha ≥ 0.3) so it keeps ticking while the pointer is down; "move" pins the grabbed node at the
// pointer (fx/fy), so its children trail behind it on their links and the neighbours flow out of the
// way; "end" drops the target (alphaTarget 0) and unpins the node, and the layout cools to rest over a
// second or two. A drag never moves a family centre (cx/cy): a dropped root glides back toward home.
//
// One tick of the whole 17 k-node forest costs ~60 ms (charge + collision), far too slow to follow a
// pointer, so a drag on a resting layout reheats a local simulation instead: the same forces on copies
// of the families around the grabbed bubble (its own family, and every family whose disc comes within
// LOCAL_R + that family's radius of it), with the families in a ring beyond that pinned as obstacles,
// one tick per display frame (~60 Hz, like d3's own timer). As the pointer carries the bubble further
// out, the families near its new spot join (velocities kept). Every tick writes the copies' positions
// back, and the page receives the whole map as usual. A drag while a cold settle or a relayout is
// running joins that full simulation instead (as the first launch did).
//
// "add" appends coins to the node list so indices stay aligned with the page's store; while the full
// simulation is running they join it at the current alpha (no reheat), asleep they are only recorded.
// "radius" updates collision radii the same way. "unpin" releases the nodes a partial settle held
// still (bulk arrivals settle among a pinned map), keeping only the page's fixed ones.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3";

type N = SimulationNodeDatum & { id: number; x: number; y: number; vx: number; vy: number; r: number; cx: number; cy: number; depth: number; fixed: boolean; top?: boolean };
type L = { source: N; target: N };
type Buf = { x: Float32Array; y: Float32Array };
type InitMsg = { t: "init"; n: number; x: Float32Array; y: Float32Array; r: Float32Array; cx: Float32Array; cy: Float32Array; depth: Uint8Array; fixed: Uint8Array; src: Int32Array; dst: Int32Array; alpha: number; focus: boolean; hPx: number; ancShift: number };
type AddMsg = { t: "add"; n: number; x: Float32Array; y: Float32Array; r: Float32Array; cx: Float32Array; cy: Float32Array; depth: Uint8Array; fixed: Uint8Array; src: Int32Array; dst: Int32Array; alpha: number };
type Msg = InitMsg | AddMsg
  | { t: "radius"; idx: Int32Array; r: Float32Array }
  | { t: "drag"; i: number; x: number; y: number; phase: "start" | "move" | "end" }
  | { t: "unpin"; fixed: Uint8Array }
  | { t: "buf"; x: Float32Array; y: Float32Array }
  | { t: "stop" };

const ALPHA_MIN = 0.01;
/// The simulation's velocity decay, and the share of a node's velocity a tick integrates (d3 keeps
/// 1 − decay of it: x += vx *= 1 − decay).
const VEL_DECAY = 0.45, VEL_KEEP = 1 - VEL_DECAY;
/// Pull of a family top (and of any other bubble at depth 0) toward its cluster centre, and of everything else.
const TOP_PULL = 0.25, MEMBER_PULL = 0.06;
/// Hard clearance between a family top's rim and a member's rim (world units; the soft collision keeps 12).
const TOP_GAP = 4;
const GOLDEN = 2.399963;
/// Local drag simulation: families whose disc comes within LOCAL_R + the grabbed family's radius (world
/// units) of the grabbed bubble move; the next OBSTACLE_R are pinned.
const LOCAL_R = 420, OBSTACLE_R = 260;
/// One local tick per this many ms (a display frame), and the alpha decay of one such frame (the first
/// launch's 0.04 per tick: ~1.3 s from a drag's 0.25 to rest).
const FRAME_MS = 16, LOCAL_DECAY = 0.04;

let sim: Simulation<N, L> | null = null;
let nodes: N[] = [];
let links: L[] = [];
/// topOf[i] = node index of i's family top (i itself for a top or a lone bubble), from the links.
let topOf = new Int32Array(0);
let focus = false, hPx = 600, ancShift = 0;
let free: Buf[] = [];
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticks = 0, tickMs = 0; // instrumentation: total ticks and an EMA of the cost of one tick
/// The local drag simulation (copies of the moving families + pinned obstacles), while one runs.
type Local = { sim: Simulation<N, L>; copies: N[]; of: Map<number, N>; state: Map<number, number>; ex: number; ey: number; R: number; grab: number; at: number };
let local: Local | null = null;
/// A drag joined the running full simulation (a cold settle or a relayout) instead of a local one.
let dragFull = false;

const take = (n: number): Buf => {
  while (free.length) { const b = free.pop()!; if (b.x.length >= n) return b; }
  const cap = n + (n >> 2) + 64;
  return { x: new Float32Array(cap), y: new Float32Array(cap) };
};

function post(settled: boolean) {
  const n = nodes.length;
  const b = take(n);
  for (let i = 0; i < n; i++) { const d = nodes[i]; b.x[i] = d.x; b.y[i] = d.y; }
  const alpha = (local ? local.sim.alpha() : sim?.alpha()) ?? 0;
  (self as unknown as Worker).postMessage({ t: "tick", x: b.x, y: b.y, n, alpha, settled, ticks, tickMs }, [b.x.buffer, b.y.buffer]);
}

/// The map's forces on simulation `s` over `ns` / `ls`; `tops` keeps members outside their top's disc.
function applyForces(s: Simulation<N, L>, ns: N[], ls: L[], tops: (() => void) | null) {
  s.force("link", forceLink<N, L>(ls).distance((l) => l.source.r + l.target.r + (focus ? 46 : l.target.depth <= 1 ? 20 : 12)).strength(0.7));
  s.force("charge", forceManyBody<N>().strength((d) => -Math.max(30, d.r * (focus ? 9 : 3.5))).distanceMax(focus ? 420 : 140).theta(1.1));
  s.force("collide", forceCollide<N>().radius((d) => d.r + 6).strength(0.9).iterations(ns.length > 8000 ? 1 : 2));
  const pull = (d: N) => ((d.top || d.depth === 0) && !focus ? TOP_PULL : MEMBER_PULL);
  s.force("x", forceX<N>((d) => d.cx).strength(pull));
  s.force("y", forceY<N>((d) => d.cy + (ancShift && !d.fixed ? hPx * 0.1 : 0)).strength(pull));
  // last, so it sees this tick's final velocities (d3 runs forces in the order they were added)
  s.force("tops", focus ? null : tops);
}
function forces() { if (sim) applyForces(sim, nodes, links, () => keepOut(nodes, topOf)); }

/// Family tops and topOf from the links (after every init/add). O(nodes + links), allocation per call only.
function retop() {
  const n = nodes.length;
  const par = new Int32Array(n).fill(-1), kids = new Uint8Array(n);
  for (const l of links) { par[l.target.id] = l.source.id; kids[l.source.id] = 1; }
  if (topOf.length < n) topOf = new Int32Array(n + (n >> 2) + 64);
  for (let i = 0; i < n; i++) { let cur = i, hops = 0; while (par[cur] >= 0 && hops++ < 16) cur = par[cur]; topOf[i] = cur; nodes[i].top = par[i] < 0 && kids[i] === 1; }
}
/// Keeps every family member's centre (and rim) outside its top's disc: a member nearer to its top than
/// r_top + r + TOP_GAP, on the positions this tick is about to integrate, is moved out along the line
/// between them to exactly that distance. A pinned member (a drag) is left alone; a pinned top still
/// pushes. `top[q]` is the index in `ns` of ns[q]'s top (q itself, or -1: none). O(nodes), no allocation.
function keepOut(ns: N[], top: Int32Array) {
  const n = ns.length;
  for (let i = 0; i < n; i++) {
    const t = top[i];
    if (t === i || t < 0 || t >= n) continue;
    const d = ns[i];
    if (d.fx != null) continue;
    const T = ns[t];
    const tx = T.fx != null ? T.fx : T.x + T.vx * VEL_KEEP, ty = T.fy != null ? T.fy : T.y + T.vy * VEL_KEEP;
    let dx = d.x + d.vx * VEL_KEEP - tx, dy = d.y + d.vy * VEL_KEEP - ty;
    const min = T.r + d.r + TOP_GAP, l2 = dx * dx + dy * dy;
    if (l2 >= min * min) continue;
    let l = Math.sqrt(l2);
    if (l < 1e-6) { dx = Math.cos(i * GOLDEN); dy = Math.sin(i * GOLDEN); l = 1; }
    const k = (min - l) / l;
    d.x += dx * k; d.y += dy * k;
  }
}

/// The local drag simulation around node `g` (at x, y): families near it move, a ring beyond is pinned.
/// `prev` (a local simulation still running) is extended: its moving families keep moving, with their
/// velocities, and its alpha carries over.
function buildLocal(g: number, x: number, y: number, prev: Local | null): Local {
  const n = nodes.length;
  // each family's centroid and extent (by its top), from the current positions
  const sx = new Float64Array(n), sy = new Float64Array(n), cnt = new Int32Array(n), ext = new Float64Array(n);
  for (let i = 0; i < n; i++) { const t = topOf[i]; sx[t] += nodes[i].x; sy[t] += nodes[i].y; cnt[t]++; }
  for (let i = 0; i < n; i++) { const t = topOf[i]; const d = nodes[i]; const e = Math.hypot(d.x - sx[t] / cnt[t], d.y - sy[t] / cnt[t]) + d.r; if (e > ext[t]) ext[t] = e; }
  const gt = topOf[g];
  const R = LOCAL_R + ext[gt];
  const state = new Map<number, number>(prev ? prev.state : []); // top → 1 moving, 2 obstacle
  for (let t = 0; t < n; t++) {
    if (!cnt[t] || state.get(t) === 1) continue;
    const gap = Math.hypot(sx[t] / cnt[t] - x, sy[t] / cnt[t] - y) - ext[t];
    if (t === gt || gap < R) state.set(t, 1);
    else if (gap < R + OBSTACLE_R) state.set(t, 2);
  }
  const of = new Map<number, N>(), copies: N[] = [];
  for (let i = 0; i < n; i++) {
    const st = state.get(topOf[i]);
    if (!st) continue;
    const d = nodes[i], old = prev?.of.get(i);
    const moving = st === 1 && !d.fixed;
    const c: N = { id: i, x: d.x, y: d.y, vx: old && moving ? old.vx : 0, vy: old && moving ? old.vy : 0, fx: moving ? null : d.x, fy: moving ? null : d.y, r: d.r, cx: d.cx, cy: d.cy, depth: d.depth, fixed: d.fixed, top: d.top };
    if (old && old.fx != null && i === prev?.grab) { c.fx = old.fx; c.fy = old.fy; }
    of.set(i, c); copies.push(c);
  }
  const ls: L[] = [];
  for (const l of links) { const a = of.get(l.source.id), b = of.get(l.target.id); if (a && b) ls.push({ source: a, target: b }); }
  const top = new Int32Array(copies.length);
  const pos = new Map<number, number>(); copies.forEach((c, q) => pos.set(c.id, q));
  for (let q = 0; q < copies.length; q++) top[q] = pos.get(topOf[copies[q].id]) ?? -1;
  const s = forceSimulation<N, L>(copies).stop().alphaDecay(LOCAL_DECAY).velocityDecay(VEL_DECAY).alphaMin(ALPHA_MIN).alpha(prev ? prev.sim.alpha() : 0).alphaTarget(prev ? prev.sim.alphaTarget() : 0);
  applyForces(s, copies, ls, () => keepOut(copies, top));
  return { sim: s, copies, of, state, ex: x, ey: y, R, grab: g, at: prev ? prev.at : 0 };
}

function loop() {
  timer = null;
  if (!running) return;
  if (local) {
    const L = local, t0 = performance.now();
    // alpha decays per display frame of wall time, not per tick: a large region whose tick takes longer
    // than a frame still cools in the same ~1.3 s
    const dt = L.at ? Math.min(100, Math.max(FRAME_MS, t0 - L.at)) : FRAME_MS;
    L.at = t0;
    L.sim.alphaDecay(1 - Math.pow(1 - LOCAL_DECAY, dt / FRAME_MS));
    L.sim.tick(); ticks++;
    for (const c of L.copies) if (c.fx == null || c.id === L.grab) { const d = nodes[c.id]; if (d) { d.x = c.x; d.y = c.y; } }
    const spent = performance.now() - t0;
    tickMs = tickMs ? tickMs * 0.8 + spent * 0.2 : spent;
    const settled = L.sim.alpha() < ALPHA_MIN;
    if (settled) { local = null; running = false; post(true); return; }
    post(false);
    timer = setTimeout(loop, Math.max(0, FRAME_MS - (performance.now() - t0)));
    return;
  }
  if (!sim) { running = false; return; }
  const t0 = performance.now();
  let settled = false;
  do { const a = performance.now(); sim.tick(); ticks++; tickMs = tickMs ? tickMs * 0.8 + (performance.now() - a) * 0.2 : performance.now() - a; if (sim.alpha() < ALPHA_MIN) { settled = true; break; } } while (performance.now() - t0 < 12);
  post(settled);
  if (settled) { running = false; dragFull = false; return; }
  const spent = performance.now() - t0;
  timer = setTimeout(loop, Math.max(0, 16 - spent));
}
function schedule() { if (!running) { running = true; if (!timer) timer = setTimeout(loop, 0); } }
/// Heats the full layout to at least `alpha` and runs it to rest (a cold settle, a relayout).
function start(alpha: number) {
  if (!sim) return;
  sim.alpha(Math.max(sim.alpha(), alpha));
  if (sim.alpha() < ALPHA_MIN) { if (!running) post(true); return; }
  schedule();
}

function build(m: InitMsg | AddMsg, base: number) {
  for (let i = 0; i < m.n; i++) nodes.push({ id: base + i, index: base + i, x: m.x[i], y: m.y[i], vx: 0, vy: 0, fx: m.fixed[i] ? m.x[i] : null, fy: m.fixed[i] ? m.y[i] : null, r: m.r[i], cx: m.cx[i], cy: m.cy[i], depth: m.depth[i], fixed: !!m.fixed[i] });
  for (let i = 0; i < m.src.length; i++) { const a = nodes[m.src[i]], b = nodes[m.dst[i]]; if (a && b) links.push({ source: a, target: b }); }
}
function reset() {
  if (timer) { clearTimeout(timer); timer = null; }
  running = false; nodes = []; links = []; free = []; local = null; dragFull = false;
}

self.onmessage = (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  switch (m.t) {
    case "init": {
      reset();
      focus = m.focus; hPx = m.hPx; ancShift = m.ancShift;
      build(m, 0);
      retop();
      sim = forceSimulation<N, L>(nodes).stop().alphaDecay(nodes.length > 8000 ? 0.05 : 0.04).velocityDecay(VEL_DECAY).alphaMin(ALPHA_MIN).alpha(0);
      forces();
      if (m.alpha >= ALPHA_MIN) start(m.alpha); else post(true);
      break;
    }
    case "add": {
      if (!sim) return;
      // appended so indices stay aligned with the page; a running full settle takes them along at its
      // own alpha, otherwise they are only recorded (the page placed them; a later drag moves them)
      build(m, nodes.length);
      retop();
      sim.nodes(nodes);
      forces();
      break;
    }
    case "radius": {
      if (!sim) return;
      for (let i = 0; i < m.idx.length; i++) { const d = nodes[m.idx[i]]; if (d) d.r = m.r[i]; const c = local?.of.get(m.idx[i]); if (c) c.r = m.r[i]; }
      if (running && !local) forces(); // collision radii of the settle in progress; asleep, they wait for the next init
      break;
    }
    case "drag": {
      if (!sim) return;
      const d = nodes[m.i]; if (!d) return;
      if (m.phase === "start") {
        // a full settle in progress: the drag joins it; otherwise a local simulation around the bubble
        dragFull = running && !local;
        if (dragFull) { d.fx = m.x; d.fy = m.y; sim.alphaTarget(0.25); start(0.3); break; }
        local = buildLocal(m.i, m.x, m.y, local);
        const c = local.of.get(m.i)!;
        c.fx = m.x; c.fy = m.y;
        local.sim.alphaTarget(0.25).alpha(Math.max(local.sim.alpha(), 0.3));
        schedule();
        break;
      }
      if (dragFull) {
        d.fx = m.x; d.fy = m.y;
        if (m.phase === "end") { sim.alphaTarget(0); if (!d.fixed) { d.fx = null; d.fy = null; } start(ALPHA_MIN); }
        else if (!running) start(0.1);
        break;
      }
      if (!local) return;
      // the bubble went far from where the local simulation was centred: the families there join it
      if (m.phase === "move" && Math.hypot(m.x - local.ex, m.y - local.ey) > local.R / 3) local = buildLocal(m.i, m.x, m.y, local);
      const c = local.of.get(m.i);
      if (!c) return;
      c.fx = m.x; c.fy = m.y; d.x = m.x; d.y = m.y;
      if (m.phase === "end") { local.sim.alphaTarget(0); if (!c.fixed) { c.fx = null; c.fy = null; } local.grab = -1; }
      schedule();
      break;
    }
    case "unpin": {
      for (let i = 0; i < nodes.length; i++) { const d = nodes[i]; d.fixed = !!m.fixed[i]; if (!d.fixed) { d.fx = null; d.fy = null; } }
      break;
    }
    case "buf": { free.push({ x: m.x, y: m.y }); break; }
    case "stop": { reset(); sim?.stop(); sim = null; break; }
  }
};
