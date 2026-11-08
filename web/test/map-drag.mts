// Shared by map-interact.mts and map-perf.mts: one live-simulation drag of the /map page (DESIGN §11.5
// "Drag"), measured. A bubble is pressed at (x0, y0) and moved by (dx, dy) screen px over `ms`, then
// released; the page is sampled every animation frame (rAF intervals, long tasks, the grabbed bubble and
// its children) and the whole map is compared before the press, at the release and after the rest.
// Not a test file of its own (npm test runs *.test.mts only).

export type DragIO = {
  evalJs: <T>(expression: string) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  press: (x: number, y: number) => Promise<unknown>;
  move: (x: number, y: number) => Promise<unknown>;
  release: (x: number, y: number) => Promise<unknown>;
  /// optional: called every ~100 ms from the press until the rest (a frame sequence)
  frame?: (tMs: number) => Promise<unknown>;
};
export type DragResult = {
  drag: { node: string; root: string | null; n: number } | null;
  /// screen distance between the grabbed bubble and the pointer at the last move
  underPx: number;
  /// worker ticks posted between the press and the release
  ticksDuring: number;
  /// bubbles that moved > 2 screen px between the press and the release (all / outside the grabbed family)
  moved2: number; moved2Others: number;
  /// grabbed bubble → its children, mean screen distance before the press and at the release; mean
  /// screen displacement of the children during the drag
  children: number; childDistBefore: number; childDistAtRelease: number; childMovePx: number;
  /// after the release: how far the grabbed bubble slid (screen px) and how long until the layout rested
  slidePx: number; restMs: number | null;
  /// at rest: distance from the grabbed bubble to its family's centroid / the family's enclosing radius (world)
  homeDist: number; familyR: number;
  /// bubbles that moved in the 3 s after the rest
  movedAfterRest: number;
  /// rAF intervals between the press and the release, and the long tasks in that window
  frames: { n: number; p95: number; max: number; longTasks: number; longTaskMaxMs: number };
  /// worker's EMA of one tick (ms) at the release
  tickMs: number;
};

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export async function liveDrag(io: DragIO, o: { grab: string; x0: number; y0: number; dx: number; dy: number; ms?: number; steps?: number }): Promise<DragResult> {
  const { evalJs, sleep } = io;
  const G = JSON.stringify(o.grab);
  const ms = o.ms ?? 1000, steps = o.steps ?? 60;
  // page side: per-frame recorder + the map before the press
  await evalJs(`(() => { const M = __sporeMap, kids = M.children(${G}).slice(0, 40);
    const R = window.__dragRec = { on: true, kids, t: [], g: [], lt: [], before: M.allXY(), k0: M.zoom(), ticks0: (M.worker() || { ticks: 0 }).ticks, tPress: 0, tRel: 0, xy0: M.xy([${G}, ...kids]) };
    try { R.obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) R.lt.push({ s: e.startTime, d: e.duration }); }); R.obs.observe({ type: "longtask" }); } catch {}
    const loop = () => { if (!R.on) return; R.t.push(performance.now()); requestAnimationFrame(loop); }; requestAnimationFrame(loop); return true; })()`);
  const t0 = Date.now();
  let nextFrame = 0;
  const maybeFrame = async () => { if (io.frame && Date.now() - t0 >= nextFrame) { nextFrame += 100; await io.frame(Date.now() - t0); } };
  await io.press(o.x0, o.y0);
  await evalJs("window.__dragRec.tPress = performance.now()");
  let last: { drag: DragResult["drag"]; s: { x: number; y: number } | null } = { drag: null, s: null };
  for (let q = 1; q <= steps; q++) {
    const px = o.x0 + (o.dx * q) / steps, py = o.y0 + (o.dy * q) / steps;
    await io.move(px, py);
    if (q === steps) last = await evalJs(`({ drag: __sporeMap.drag(), s: __sporeMap.screenOf(${G}) })`);
    await maybeFrame();
    const due = t0 + (ms * q) / steps - Date.now();
    if (due > 0) await sleep(due);
  }
  const x1 = o.x0 + o.dx, y1 = o.y0 + o.dy;
  const atRel = await evalJs<{ xy: number[]; all: { n: number; x: number[]; y: number[] }; ticks: number; tickMs: number; k: number }>(`(() => { const M = __sporeMap, R = window.__dragRec, w = M.worker() || { ticks: 0, tickMs: 0 }; return { xy: M.xy([${G}, ...R.kids]), all: M.allXY(), ticks: w.ticks - R.ticks0, tickMs: w.tickMs, k: M.zoom() }; })()`);
  await io.release(x1, y1);
  await evalJs("window.__dragRec.tRel = performance.now()");
  const tRel = Date.now();
  let restMs: number | null = null;
  while (Date.now() - tRel < 6000) {
    await maybeFrame();
    if (await evalJs<boolean>("__sporeMap.settled()")) { restMs = Date.now() - tRel; break; }
    await sleep(40);
  }
  await sleep(150);
  const rest = await evalJs<{ xy: number[]; all: { n: number; x: number[]; y: number[] }; home: number; famR: number; fam: string[] }>(`(() => { const M = __sporeMap, R = window.__dragRec; R.on = false; try { R.obs && R.obs.disconnect(); } catch {}
    const d = M.drag(), root = (M.clusters(100000).find((c) => M.members(c.root).includes(${G})) || {}).root ?? ${G};
    const mem = M.members(root).filter((m) => m !== ${G}); const xy = M.xy(mem); let sx = 0, sy = 0, k = 0; for (let q = 0; q < mem.length; q++) { if (xy[q * 2] === xy[q * 2]) { sx += xy[q * 2]; sy += xy[q * 2 + 1]; k++; } }
    const g = M.xy([${G}]); const cx = k ? sx / k : g[0], cy = k ? sy / k : g[1]; let famR = 0; for (let q = 0; q < mem.length; q++) { const n = M.node(mem[q]); famR = Math.max(famR, Math.hypot(xy[q * 2] - cx, xy[q * 2 + 1] - cy) + (n ? n.r : 0)); }
    return { xy: M.xy([${G}, ...R.kids]), all: M.allXY(), home: Math.hypot(g[0] - cx, g[1] - cy), famR, fam: M.members(root), d }; })()`);
  await sleep(3000);
  const after = await evalJs<{ n: number; x: number[]; y: number[] }>("__sporeMap.allXY()");
  const rec = await evalJs<{ kids: string[]; t: number[]; lt: { s: number; d: number }[]; before: { n: number; x: number[]; y: number[] }; k0: number; tPress: number; tRel: number; xy0: number[] }>("(() => { const R = window.__dragRec; return { kids: R.kids, t: R.t, lt: R.lt, before: R.before, k0: R.k0, tPress: R.tPress, tRel: R.tRel, xy0: R.xy0 }; })()");
  // numbers
  const k = atRel.k;
  const famIdx = new Set(await evalJs<number[]>(`__sporeMap.idx(${JSON.stringify(rest.fam)})`));
  let moved2 = 0, moved2Others = 0;
  const b = rec.before, a = atRel.all;
  for (let i = 0; i < Math.min(a.n, b.n); i++) { if (Math.hypot(a.x[i] - b.x[i], a.y[i] - b.y[i]) * k > 2) { moved2++; if (!famIdx.has(i)) moved2Others++; } }
  const nk = rec.kids.length;
  const dist = (xy: number[], q: number) => Math.hypot(xy[q * 2] - xy[0], xy[q * 2 + 1] - xy[1]);
  let dB = 0, dR = 0, mv = 0;
  for (let q = 1; q <= nk; q++) { dB += dist(rec.xy0, q); dR += dist(atRel.xy, q); mv += Math.hypot(atRel.xy[q * 2] - rec.xy0[q * 2], atRel.xy[q * 2 + 1] - rec.xy0[q * 2 + 1]); }
  let still = 0;
  for (let i = 0; i < Math.min(after.n, rest.all.n); i++) if (after.x[i] !== rest.all.x[i] || after.y[i] !== rest.all.y[i]) still++;
  const iv: number[] = [];
  for (let q = 1; q < rec.t.length; q++) if (rec.t[q] >= rec.tPress && rec.t[q] <= rec.tRel) iv.push(rec.t[q] - rec.t[q - 1]);
  iv.sort((x, y) => x - y);
  const lts = rec.lt.filter((e) => e.s + e.d >= rec.tPress && e.s <= rec.tRel);
  return {
    drag: last.drag,
    underPx: last.s ? round(Math.hypot(last.s.x - x1, last.s.y - y1)) : Infinity,
    ticksDuring: atRel.ticks,
    moved2, moved2Others,
    children: nk, childDistBefore: nk ? round((dB / nk) * k) : 0, childDistAtRelease: nk ? round((dR / nk) * k) : 0, childMovePx: nk ? round((mv / nk) * k) : 0,
    slidePx: round(Math.hypot(rest.xy[0] - atRel.xy[0], rest.xy[1] - atRel.xy[1]) * k),
    restMs,
    homeDist: round(rest.home), familyR: round(rest.famR),
    movedAfterRest: still,
    frames: { n: iv.length, p95: round(iv[Math.min(iv.length - 1, Math.floor(iv.length * 0.95))] ?? 0), max: round(iv[iv.length - 1] ?? 0), longTasks: lts.length, longTaskMaxMs: round(Math.max(0, ...lts.map((e) => e.d))) },
    tickMs: round(atRel.tickMs, 2),
  };
}
