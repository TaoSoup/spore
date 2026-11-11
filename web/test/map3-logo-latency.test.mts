// The map engine's logo latency (src/components/map3/engine/bubbles.js + motion.js, 2026-11-11 "logos at once"), driven for
// real: ingest -> layout -> bubbles -> links -> dust -> motion run headless (a stub canvas and 2d context, a fake WebGL
// renderer whose texSubImage2D records what lands in the atlas, and a fake image loader with the contract of
// src/lib/map/images.ts), on ONE clock this test moves: performance.now(), the frame times motion's loop gets
// (requestAnimationFrame) and setTimeout (node:test mock timers) all advance together, frame by frame.
//   - a flight's destination pass asks for the destination's logos at the flight's start, before the camera moves, at the
//     destination's sizes (a planet top drawn >= 32 px there asks for its 256 px logo); a flight replaced on the way asks
//     for its new destination at once; a cancelled one gets the still pass where it stopped, STILL_MS later;
//   - hand motion: a drag gets a pass every MOVE_PASS_MS while it moves and one STILL_MS after it stops; a wheel gesture
//     asks for its target view once the target holds EASE_HOLD_MS, on the way of a zoom in or a pan every GOAL_GAP_MS,
//     not on the way out (a very slow one may take one pass at the start); a held +/- key's repeats continue a series (SERIES_MS): only the first is at once;
//   - the eviction never takes a cell whose owner is drawn on screen now or at the destination;
//   - a load notice is applied in the next frame, and an upload batch runs in the next frame, one per frame, within
//     UPLOAD_BUDGET_MS, with one generateMipmap per changed atlas;
//   - a drag's throw: the pass at the release is for where the camera will come to rest (motion.js goal(), kind inertia).
//   npx tsx --test test/map3-logo-latency.test.mts
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

// the engine is plain JS: its state object is untyped here
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Bmp = { width: number; height: number; tag: string };
type Want = { src: string; px: number; t: number; frame: number; cam: { x: number; y: number; k: number } };
type Row = { i: number; r: number; cell: number; code: number };

/// One texSubImage2D costs this much of the fake clock (the per-frame upload budget is measured on it).
const TEX_MS = 0.5;
const W = 1200, H = 800;
const url = (m: string) => `/api/img?u=${encodeURIComponent(`https://img.test/${m}.png`)}`;
const bitmap = (tag: string): Bmp => ({ width: 64, height: 64, tag });

/// families f = 0..nF-1 (the first `planets` are planets), each a top m{f} with kids(f) children m{f}k{j}. kidMcap(f, j) sets a
/// child's market cap (the layout's size; >= $10k keeps the seed-head rule out: every child is drawn at its layout radius).
type Fixture = { nF: number; kids: number | ((f: number) => number); planets?: number; kidMcap?: (f: number, j: number) => number };
function roots(o: Fixture) {
  return Array.from({ length: o.nF }, (_, f) => ({
    coin: { mint: `m${f}`, symbol: `S${f}`, mcapUsd: 2e6 / (f + 1), lockedUsd: 2e5 / (f + 1), image: url(`m${f}`) },
    children: Array.from({ length: typeof o.kids === "function" ? o.kids(f) : o.kids }, (_, j) => ({
      coin: { mint: `m${f}k${j}`, symbol: `K${j}`, mcapUsd: o.kidMcap ? o.kidMcap(f, j) : 2e4, lockedUsd: 2e3, image: url(`m${f}k${j}`) }, children: [],
    })),
  }));
}

/// A loader with the images.ts contract; every want is recorded with the clock, the frame and the camera it was made at.
function fakeLoader() {
  const bmp = new Map<string, Bmp>(), wants: Want[] = [];
  let listeners: (() => void)[] = [];
  let S: Any = null;
  return {
    bmp, wants,
    bind(s: Any) { S = s; },
    notify() { for (const f of listeners) f(); },
    api: {
      want: (src: string, px: number) => { wants.push({ src, px, t: performance.now(), frame: S ? S.frame : -1, cam: S ? { x: S.cam.x, y: S.cam.y, k: S.cam.k } : { x: NaN, y: NaN, k: NaN } }); return bmp.get(src) ?? null; },
      ready: (src: string) => bmp.has(src),
      failed: () => false,
      retryAt: () => 0,
      onLoaded: (f: () => void) => { listeners.push(f); return () => { listeners = listeners.filter((g) => g !== f); }; },
    },
  };
}

/// rm: reduced motion; blit: the fake GL can blit between mip levels (complete framebuffers; "incomplete": it says they are
/// not); countImg: S.img counts its index reads (imgReads.n)
type MountOpts = { rm?: boolean; blit?: boolean | "incomplete"; countImg?: boolean; texMs?: number };
async function mount(fx: Fixture, o: MountOpts = {}) {
  const g = globalThis as Record<string, unknown>;
  // the one clock: performance.now(), motion's frame times and (mock) setTimeout move together in tick()
  const clock = { t: 10_000 };
  const realNow = performance.now;
  performance.now = () => clock.t;
  mock.timers.enable({ apis: ["setTimeout"] });
  const ctx2d = new Proxy({} as Record<string, unknown>, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : () => {}), set: (t, k, v) => { t[k as string] = v; return true; } });
  const el = () => ({ width: 0, height: 0, style: {} as Record<string, string>, getContext: () => ctx2d, addEventListener() {}, removeEventListener() {} });
  g.window = { innerWidth: 1440, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  g.document = { createElement: el };
  g.location = { href: "http://local.test/" };
  const rafQ: ((t: number) => void)[] = [];
  g.requestAnimationFrame = (fn: (t: number) => void) => { rafQ.push(fn); return rafQ.length; };
  g.cancelAnimationFrame = () => {};
  // @ts-expect-error plain JS engine module
  const { createState, createLife } = await import("../src/components/map3/engine/state.js");
  // @ts-expect-error plain JS engine module
  const { ingest } = await import("../src/components/map3/engine/data.js");
  // @ts-expect-error plain JS engine module
  const { createVis } = await import("../src/components/map3/engine/vis.js");
  // @ts-expect-error plain JS engine module
  const { buildLayout } = await import("../src/components/map3/engine/layout.js");
  // @ts-expect-error plain JS engine module
  const { placeDust, buildDust } = await import("../src/components/map3/engine/dust.js");
  // @ts-expect-error plain JS engine module
  const { buildBubbles } = await import("../src/components/map3/engine/bubbles.js");
  // @ts-expect-error plain JS engine module
  const { buildLinks } = await import("../src/components/map3/engine/links.js");
  // @ts-expect-error plain JS engine module
  const { buildMotion } = await import("../src/components/map3/engine/motion.js");
  const loader = fakeLoader();
  const life = createLife();
  // the canvas keeps its listeners: a test presses, cancels and turns the wheel on it
  const ls: Record<string, ((e: unknown) => void)[]> = {};
  const canvas = { ...el(), addEventListener: (type: string, fn: (e: unknown) => void) => { (ls[type] ||= []).push(fn); }, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }), setPointerCapture() {} };
  const S: Any = createState({ clientWidth: W, clientHeight: H }, { canvas }, { look: "flat", images: loader.api, nPlanets: fx.planets ?? 3, last: null, callbacks: {}, reducedMotion: !!o.rm }, life);
  loader.bind(S);
  ingest(S, { roots: roots(fx), heat: null, mode: "locked" });
  S.vis = createVis(S, null);
  await buildLayout(S);
  await placeDust(S);
  // the atlas uploads as the GPU sees them: texSubImage2D (with the frame it ran in, the bound texture and the offset; each
  // one costs TEX_MS of the clock), generateMipmap (per frame) and, with o.blit, the blits between mip levels (which texture
  // is attached at which level to the read and the draw framebuffer)
  const uploads: { src: unknown; frame: number; t: number; tex: unknown; x: number; y: number }[] = [], mips: number[] = [];
  const blits: { frame: number; tex: unknown; from: number; to: number; src: number[]; dst: number[] }[] = [];
  let boundTex: unknown = null;
  const att: Record<string, { tex: unknown; lvl: number }> = {};
  const glBase: Record<string, unknown> = {
    texSubImage2D: (...a: unknown[]) => { uploads.push({ src: a[a.length - 1], frame: S.frame, t: clock.t, tex: boundTex, x: a[2] as number, y: a[3] as number }); clock.t += o.texMs ?? TEX_MS; },
    generateMipmap: () => { mips.push(S.frame); },
  };
  if (o.blit) Object.assign(glBase, {
    READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9, FRAMEBUFFER_COMPLETE: 0x8cd5,
    createFramebuffer: () => ({}),
    framebufferTexture2D: (target: number, _a: number, _t: number, tex: unknown, lvl: number) => { att[target] = { tex, lvl }; },
    checkFramebufferStatus: () => (o.blit === "incomplete" ? 0x8cd6 : 0x8cd5),
    blitFramebuffer: (...a: number[]) => {
      const r = att[0x8ca8], d = att[0x8ca9];
      if (!r || !d || r.tex !== d.tex) throw new Error("blit without the atlas on both ends");
      blits.push({ frame: S.frame, tex: r.tex, from: r.lvl, to: d.lvl, src: a.slice(0, 4), dst: a.slice(4, 8) });
    },
  });
  const gl = new Proxy(glBase, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : typeof k === "string" && /^[A-Z0-9_]+$/.test(k) ? 0 : () => {}) });
  const props = new WeakMap<object, { __webglTexture: object }>();
  S.gfx.scene = new THREE.Scene();
  S.gfx.renderer = {
    getContext: () => gl,
    properties: { get: (t: object) => { let p = props.get(t); if (!p) props.set(t, (p = { __webglTexture: {} })); return p; } },
    state: { bindTexture: (_t: unknown, tex: unknown) => { boundTex = tex; }, unbindTexture: () => { boundTex = null; }, bindFramebuffer() {}, disable() {} },
    getRenderTarget: () => null, setRenderTarget() {}, getClearColor() {}, getClearAlpha: () => 1, setClearColor() {}, clear() {},
  };
  S.gfx.camera = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, -100, 100);
  S.overview.uRvis = { value: 1 };
  const imgReads = { n: 0 };
  if (o.countImg) S.img = new Proxy(S.img, { get: (t, k) => { if (typeof k === "string" && /^\d+$/.test(k)) imgReads.n++; return Reflect.get(t, k); } });
  buildBubbles(S);
  await buildLinks(S);
  buildDust(S);
  buildMotion(S);
  S.motion.start();
  /// one frame of motion's loop `ms` after the last (0: the same instant), the timers due by then first
  const tick = (ms = 16) => { if (ms > 0) { clock.t += ms; mock.timers.tick(ms); } for (const f of rafQ.splice(0)) f(clock.t); };
  const ticks = (ms: number, step = 16) => { for (let t = 0; t < ms; t += step) tick(step); };
  const fam = (f: number) => S.fams[S.famOf[S.mintIdx.get(`m${f}`)]];
  const idx = (m: string): number => S.mintIdx.get(m);
  const cov = () => S.debugFns.logoCoverage();
  /// the children drawn on screen at view {x, y, k} at >= minR px, with their cell (the camera is put back)
  const kidsAt = (v: { x: number; y: number; k: number }, minR = 4.5): Row[] => {
    const c0 = { ...S.cam };
    Object.assign(S.cam, v);
    try { return S.debugFns.kidLogos(minR, 1e9).rows as Row[]; } finally { Object.assign(S.cam, c0); }
  };
  /// a camera jump as the page's setCam makes it, then frames until the passes there are done (works on the old rules too)
  const visit = (v: { x: number; y: number; k: number }, ms = 1_200) => { S.motion.setCam(v.x, v.y, v.k, true); ticks(ms); };
  const pointer = (type: string, x: number, y: number) => { for (const fn of ls[type] || []) fn({ type, pointerType: "mouse", button: 0, pointerId: 1, clientX: x, clientY: y, timeStamp: clock.t, preventDefault() {} }); };
  /// a wheel event; ctrlKey: a trackpad pinch (the browser sends it as a wheel event with ctrlKey)
  const wheel = (x: number, y: number, deltaY: number, ctrlKey = false) => { for (const fn of ls.wheel || []) fn({ type: "wheel", clientX: x, clientY: y, deltaX: 0, deltaY, deltaMode: 0, ctrlKey, preventDefault() {} }); };
  const dispose = () => { try { life.disposeAll(); } finally { performance.now = realNow; mock.timers.reset(); } };
  return { S, loader, life, clock, tick, ticks, fam, idx, cov, kidsAt, visit, pointer, wheel, uploads, mips, blits, imgReads, props, dispose };
}
type Eng = Awaited<ReturnType<typeof mount>>;

/// the view centred on family f at zoom k
const famView = (e: Eng, f: number, k: number) => { const F = e.fam(f); return { x: F.cx, y: F.cy, k }; };
const wantedAfter = (e: Eng, n0: number) => e.loader.wants.slice(n0);
/// the cell pass counter (old and new rules alike) and the clock times at which it moved, frame by frame
function passLog(e: Eng) {
  const at: number[] = [];
  let last = e.cov().assign.passes;
  return {
    at,
    tick(ms = 16) { e.tick(ms); const p = e.cov().assign.passes; if (p !== last) { at.push(e.clock.t); last = p; } },
  };
}

test("a flight asks for its destination's logos at its start, before the camera moves, at the destination's sizes", async () => {
  const e = await mount({ nF: 8, kids: 40 });
  try {
    const { S } = e;
    e.visit({ x: 0, y: 0, k: 1 });   // the overview: no child is drawn at the logo size
    const dest = famView(e, 1, 7);    // family 1 (a planet) at 7x: its children ~18 px, its top ~36 px
    const kids = e.kidsAt(dest);
    assert.ok(kids.length >= 30, `${kids.length} children drawn >= 4.5 px at the destination`);
    const top = S.fams[1].top;
    assert.ok(S.bubbles.screenR(top) < 32, "the planet top is under the HI size now");
    const n0 = e.loader.wants.length, cam0 = { ...S.cam }, t0 = e.clock.t;
    void S.motion.flyTo(dest.x, dest.y, dest.k);
    e.tick(0);   // the first frame of the flight, at its start time: the camera has not moved yet
    assert.ok(Math.abs(S.cam.x - cam0.x) < 1e-6 && Math.abs(S.cam.y - cam0.y) < 1e-6 && Math.abs(S.cam.k / cam0.k - 1) < 1e-9, "the camera is still at the start");
    const asked = wantedAfter(e, n0);
    const kidUrls = new Set(kids.map((r) => S.img[r.i]));
    const kidAsks = asked.filter((w) => kidUrls.has(w.src));
    assert.equal(new Set(kidAsks.map((w) => w.src)).size, kidUrls.size, `every child drawn at the destination is asked at the start (${new Set(kidAsks.map((w) => w.src)).size} of ${kidUrls.size})`);
    for (const w of kidAsks) {
      assert.equal(w.t, t0, "asked at the flight's start");
      assert.ok(Math.abs(w.cam.k / cam0.k - 1) < 1e-9, "asked while the camera is still at the start");
      assert.equal(w.px, 64, "a child's LO size");
    }
    for (const r of e.kidsAt(dest)) assert.ok(r.cell >= 0, `child ${r.i} owns a cell`);
    assert.ok(asked.some((w) => w.src === S.img[top] && w.px === 256), "the planet top, drawn >= 32 px at the destination, asks for its 256 px logo");
    // one pass per destination: the frames of the flight ask for nothing more
    const n1 = e.loader.wants.length, p1 = e.cov().assign.passes;
    for (let i = 0; i < 20 && S.engineDebug.flying(); i++) e.tick(16);
    assert.ok(S.engineDebug.flying(), "still on the way");
    assert.equal(e.cov().assign.passes, p1, "no pass for the views on the way");
    assert.equal(e.loader.wants.length, n1);
    // landed exactly where that pass looked, and it did everything: no pass on arrival either
    for (let i = 0; i < 200 && S.engineDebug.flying(); i++) e.tick(16);
    assert.ok(!S.engineDebug.flying(), "landed");
    e.ticks(300);
    assert.equal(e.cov().assign.passes, p1, "no other pass once it landed");
    for (const r of e.kidsAt(dest)) assert.ok(r.cell >= 0, `child ${r.i} owns a cell`);
  } finally { e.dispose(); }
});

test("a flight replaced on the way asks for its new destination at once; a cancelled one gets the still pass where it stopped, STILL_MS later", async () => {
  const e = await mount({ nF: 8, kids: 40 });
  try {
    const { S } = e;
    // @ts-expect-error plain JS engine module
    const { STILL_MS } = await import("../src/components/map3/engine/bubbles.js");
    const still = typeof STILL_MS === "number" ? STILL_MS : 100;
    e.visit({ x: 0, y: 0, k: 1 });
    const A = famView(e, 1, 7), B = famView(e, 2, 7);
    const kidsB = new Set(e.kidsAt(B).map((r) => S.img[r.i]));
    assert.ok(kidsB.size >= 30);
    void S.motion.flyTo(A.x, A.y, A.k);
    e.tick(0);
    e.ticks(200);
    assert.ok(S.engineDebug.flying());
    // replaced: the new destination's logos are asked in the next frame, while the camera is still far from it
    const n0 = e.loader.wants.length, tR = e.clock.t;
    void S.motion.flyTo(B.x, B.y, B.k);
    e.tick(16);
    const asked = new Set(wantedAfter(e, n0).filter((w) => w.t <= tR + 16).map((w) => w.src));
    const got = [...kidsB].filter((u) => asked.has(u)).length;
    assert.equal(got, kidsB.size, `the new destination's children asked in the next frame (${got} of ${kidsB.size})`);
    assert.ok(Math.hypot(S.cam.x - B.x, S.cam.y - B.y) * S.cam.k > 50, "the camera is still on its way");
    // cancelled (a press on the map): the camera stops where it is; the pass for that view runs STILL_MS later, not before
    e.ticks(150);
    assert.ok(S.engineDebug.flying());
    e.pointer("pointerdown", 40, 40);
    e.pointer("pointercancel", 40, 40);
    assert.ok(!S.engineDebug.flying(), "the press cancelled the flight");
    const log = passLog(e);
    const camStop = { ...S.cam };
    log.tick(16);   // the frame that may still move the camera once (none: a cancelled flight stops at once)
    const tStop = e.clock.t - 16;
    for (let i = 0; i < 20; i++) log.tick(16);
    assert.deepEqual({ ...S.cam }, camStop, "the camera stays where the flight stopped");
    assert.ok(log.at.length >= 1, "a pass ran where the camera stopped");
    const dt = log.at[0] - tStop;
    assert.ok(dt >= still && dt <= still + 16, `the still pass ran ${dt} ms after the camera stopped (want ${still}..${still + 16})`);
    const stopKids = e.kidsAt(camStop);
    assert.ok(stopKids.length > 0 && stopKids.every((r) => r.cell >= 0), "every child drawn there owns a cell");
  } finally { e.dispose(); }
});

test("hand motion: a drag gets a pass every MOVE_PASS_MS while it moves and one STILL_MS after it stops; a wheel step asks for its target view once the target has held EASE_HOLD_MS, while the zoom still eases toward it", async () => {
  const e = await mount({ nF: 8, kids: 40 });
  try {
    const { S } = e;
    // @ts-expect-error plain JS engine module
    const B = await import("../src/components/map3/engine/bubbles.js");
    const MOVE = typeof B.MOVE_PASS_MS === "number" ? B.MOVE_PASS_MS : 300, STILL = typeof B.STILL_MS === "number" ? B.STILL_MS : 100, HOLD = typeof B.EASE_HOLD_MS === "number" ? B.EASE_HOLD_MS : 80;
    e.visit(famView(e, 0, 5));
    // a 1 s drag, 6 px per 16 ms frame to the right (the pointer handler moves the camera 1:1: cam and tgt together)
    const log = passLog(e);
    const t0 = e.clock.t;
    for (let t = 0; t < 1_000; t += 16) {
      const dx = 6 / S.cam.k;
      S.cam.x -= dx; S.tgt.x -= dx; S.dirty = true;
      log.tick(16);
    }
    const tStop = e.clock.t;
    const during = log.at.filter((t) => t <= tStop).map((t) => t - t0);
    assert.ok(during.length >= 2 && during.length <= Math.ceil(1_000 / MOVE) + 1, `passes while dragging at ${during.join(", ")} ms`);
    for (let j = 1; j < during.length; j++) assert.ok(during[j] - during[j - 1] >= MOVE - 16, `passes ${during[j] - during[j - 1]} ms apart (>= ${MOVE} - one frame)`);
    assert.ok(during[0] <= MOVE + 32, `the first pass ${during[0]} ms into the drag`);
    for (let i = 0; i < 20; i++) log.tick(16);
    const after = log.at.filter((t) => t > tStop).map((t) => t - tStop);   // the camera last moved in the frame at tStop
    assert.ok(after.length >= 1, "a pass after the drag");
    assert.ok(after[0] >= STILL && after[0] <= STILL + 16, `the still pass ${after[0]} ms after the last move (want ${STILL}..${STILL + 16})`);
    // the wheel: one step in, at the centre; the children cross the logo size at the target zoom only
    e.visit({ x: e.fam(0).cx, y: e.fam(0).cy, k: 1.55 });
    const before = e.kidsAt({ ...S.cam }), k1 = S.cam.k * Math.exp(100 * 0.0022);
    assert.equal(before.length, 0, "no child at the logo size before the step");
    const target = e.kidsAt({ x: S.cam.x, y: S.cam.y, k: k1 });
    assert.ok(target.length >= 20, `${target.length} children at the logo size at the target zoom`);
    const n0 = e.loader.wants.length, tW = e.clock.t;
    e.wheel(W / 2, H / 2, -100);
    const urls = new Set(target.map((r) => S.img[r.i]));
    let tAsk = -1;
    for (let j = 0; j < 20 && tAsk < 0; j++) { e.tick(16); if (wantedAfter(e, n0).some((w) => urls.has(w.src))) tAsk = e.clock.t - tW; }
    assert.ok(tAsk >= HOLD && tAsk <= HOLD + 16, `the target view's children asked ${tAsk} ms after the step (want ${HOLD}..${HOLD + 16}: the target held EASE_HOLD_MS)`);
    const asked = new Set(wantedAfter(e, n0).map((w) => w.src));
    const got = target.filter((r) => asked.has(S.img[r.i])).length;
    assert.equal(got, target.length, `every child drawn in the target view asked (${got} of ${target.length})`);
    assert.ok(Math.abs(S.cam.k / k1 - 1) > 0.05, "while the zoom is still easing toward it");
  } finally { e.dispose(); }
});

test("the eviction never takes a cell whose owner is drawn on screen now (the flight's start) or at the destination", async () => {
  // B = family 1: its children alternate big (R ~5) and small (R ~2.1); C = family 2, never visited before the flight; the
  // destination D shows B and C at 2x: B's small children are drawn ~4.2 px there (not cell candidates, but their logos show:
  // the shader fades a logo in from 3.7 px), C's children ~5 px (candidates without a cell). A = the family farthest from D:
  // the view the flight starts from. The rest fill the atlas (4,096 LO cells; 6 dust tops pinned).
  const kids = (f: number) => (f === 0 ? 300 : f <= 2 ? 600 : 520);
  const e = await mount({ nF: 9, kids, kidMcap: (f, j) => (f === 1 ? (j % 2 === 0 ? 8e5 : 1e4) : 2e4) });
  try {
    const { S } = e;
    const cellsOf = (rows: Row[]) => new Map(rows.filter((r) => r.cell >= 0).map((r) => [r.i, r.cell] as const));
    const Bf = e.fam(1), Cf = e.fam(2);
    const D = { x: (Bf.cx + Cf.cx) / 2, y: (Bf.cy + Cf.cy) / 2, k: 2 };
    const others = [0, 3, 4, 5, 6, 7, 8].sort((a, b) => Math.hypot(e.fam(b).cx - D.x, e.fam(b).cy - D.y) - Math.hypot(e.fam(a).cx - D.x, e.fam(a).cy - D.y));
    const a = others[0], A = famView(e, a, 3);
    // 1. B deep (4x): its children take cells, the oldest stamps; 2. A
    e.visit(famView(e, 1, 4));
    e.visit(A);
    const free = () => 4096 - e.cov().usedLo;
    const needC = () => e.kidsAt(D, 3.7).filter((r) => S.famOf[r.i] === 2 && r.r >= 4.5 && r.cell < 0).length;
    // 3. fill the atlas with views of the other families (6x, a few dozen cells each), never past full: nothing is evicted
    // before the flight, and fewer cells are free than the destination pass takes (ASSIGN_MAX = 400 at most)
    const fillers: { x: number; y: number; k: number }[] = [];
    for (const f of others.slice(1)) { const F = e.fam(f); for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) fillers.push({ x: F.cx + dx * 40, y: F.cy + dy * 40, k: 6 }); }
    const ev0 = e.cov().assign.evicted;
    for (const v of fillers) {
      if (free() < Math.min(needC(), 400) - 80) break;
      if (e.kidsAt(v).filter((r) => r.cell < 0).length + 8 > free()) continue;
      e.visit(v, 400);
    }
    assert.equal(e.cov().assign.evicted, ev0, "nothing was evicted while filling");
    const atD = e.kidsAt(D, 3.7);
    const smallB = atD.filter((r) => S.famOf[r.i] === 1 && r.r < 4.5 && r.cell >= 0);
    const nowA = cellsOf(e.kidsAt(A, 3.7)), keptD = cellsOf(smallB), need = needC(), free0 = free();
    assert.ok(nowA.size >= 200, `A's children own cells (${nowA.size})`);
    assert.ok(smallB.length >= 100, `B's small children own cells and are drawn 3.7-4.5 px at the destination (${smallB.length})`);
    assert.ok(Math.min(need, 400) > free0 + 40, `the destination pass needs more cells (${need}) than are free (${free0})`);
    // 4. back at A by a jump, and in the same frame the flight to D: no pass runs at A in between, so A's cells keep their
    // old stamps (older than every filler's) and B's small children's are the oldest of all
    S.motion.setCam(A.x, A.y, A.k, true);
    void S.motion.flyTo(D.x, D.y, D.k);
    e.tick(0);
    const tookC = e.kidsAt(D, 3.7).filter((r) => S.famOf[r.i] === 2 && r.cell >= 0).length;
    assert.ok(e.cov().assign.evicted > ev0, "the destination pass evicted cells");
    assert.ok(tookC >= Math.min(need, 400) - 5, `C's children took cells at the flight's start (${tookC} of ${need})`);
    const rowsA = new Map(e.kidsAt(A, 3.7).map((r) => [r.i, r.cell] as const)), rowsD = new Map(e.kidsAt(D, 3.7).map((r) => [r.i, r.cell] as const));
    const lostA = [...nowA].filter(([i, c]) => rowsA.get(i) !== c).length, lostD = [...keptD].filter(([i, c]) => rowsD.get(i) !== c).length;
    assert.equal(lostA, 0, `no cell drawn on screen now (A) was evicted (${lostA} of ${nowA.size} lost)`);
    assert.equal(lostD, 0, `no cell drawn at the destination (B's small children) was evicted (${lostD} of ${keptD.size} lost)`);
  } finally { e.dispose(); }
});

test("a load notice is applied in the next frame (no 250 ms recheck timer)", async () => {
  const e = await mount({ nF: 8, kids: 40 });
  try {
    const { S } = e;
    const v = famView(e, 1, 7);
    e.visit(v);
    const kids = e.kidsAt(v).filter((r) => r.cell >= 0);
    assert.ok(kids.length >= 10);
    const [a, b] = kids;
    // logo a lands: notice, a few frames (the old rules: a recheck timer runs now, and the next is >= 250 ms away)
    e.loader.bmp.set(S.img[a.i], bitmap("a"));
    e.loader.notify();
    e.ticks(48);
    assert.equal(S.bubbles.logoPx(a.i), 64, "logo a drawn");
    // logo b lands 50 ms later: drawn in the very next frame
    e.ticks(50);
    e.loader.bmp.set(S.img[b.i], bitmap("b"));
    e.loader.notify();
    e.tick(16);
    assert.equal(S.bubbles.logoPx(b.i), 64, "logo b drawn in the frame after its notice");
  } finally { e.dispose(); }
});

test("an upload batch runs in the next frame when cells are dirty, one per frame, within UPLOAD_BUDGET_MS, one mipmap per frame", async () => {
  const e = await mount({ nF: 8, kids: 240 });
  try {
    const { S } = e;
    // @ts-expect-error plain JS engine module
    const B = await import("../src/components/map3/engine/bubbles.js");
    const BUDGET = typeof B.UPLOAD_BUDGET_MS === "number" ? B.UPLOAD_BUDGET_MS : 4;
    const v = famView(e, 1, 3.4);
    e.visit(v);
    const kids = e.kidsAt(v).filter((r) => r.cell >= 0);
    assert.ok(kids.length >= 200, `${kids.length} children own a cell`);
    // a burst: every one of their logos lands at once (one sheet's notice)
    for (const r of kids) e.loader.bmp.set(S.img[r.i], bitmap(`k${r.i}`));
    e.loader.notify();
    const u0 = e.uploads.length, f0 = S.frame;
    let frames = 0;
    while (kids.some((r) => S.bubbles.logoPx(r.i) === 0) && frames < 400) {
      e.tick(16); frames++;
      // the hooks again within the same frame (S.frame unchanged): no second batch
      const n = e.uploads.length;
      S.runFrameHooks(e.clock.t, 0);
      assert.equal(e.uploads.length, n, "no second batch in one frame");
    }
    const ups = e.uploads.slice(u0);
    assert.ok(kids.every((r) => S.bubbles.logoPx(r.i) === 64), "every logo drawn");
    const byFrame = new Map<number, number>();
    for (const u of ups) byFrame.set(u.frame, (byFrame.get(u.frame) ?? 0) + 1);
    const fr = [...byFrame.keys()].sort((x, y) => x - y);
    assert.equal(fr[0], f0 + 1, "the first batch runs in the frame after the notice");
    for (let j = 1; j < fr.length; j++) assert.equal(fr[j], fr[j - 1] + 1, `a batch in every frame while cells are dirty (frames ${fr[j - 1]} -> ${fr[j]})`);
    const maxN = Math.max(...byFrame.values());
    assert.ok(maxN * TEX_MS <= BUDGET + TEX_MS, `at most ${maxN} cells (${maxN * TEX_MS} ms) per batch: the budget is ${BUDGET} ms`);
    assert.ok(fr.length >= Math.ceil((kids.length * TEX_MS) / (BUDGET + TEX_MS)), "the burst is spread over frames");
    // mipmaps: one generateMipmap per changed atlas per batch (only the LO atlas changed)
    const mipFrames = e.mips.filter((f) => f > f0);
    assert.equal(mipFrames.length, fr.length, "one mipmap generation per batch");
    assert.deepEqual([...new Set(mipFrames)].sort((x, y) => x - y), fr);
  } finally { e.dispose(); }
});

test("a drag's throw: at the release the pass runs for where the camera will come to rest (the throw's estimate), not after it stops", async () => {
  const e = await mount({ nF: 8, kids: 40 });
  try {
    const { S } = e;
    e.visit(famView(e, 0, 5));
    // a point on empty map to press on (a press on a coin would drag the coin)
    let p0: { x: number; y: number } | null = null;
    for (let y = 60; y < H - 60 && !p0; y += 20) for (let x = 60; x < W - 60 && !p0; x += 20) if (S.engineDebug.pick(x, y).i < 0) p0 = { x, y };
    assert.ok(p0, "an empty point");
    // a real pointer drag: 12 moves of 24 px, 16 ms apart, released while moving (the engine throws the view)
    e.pointer("pointerdown", p0!.x, p0!.y);
    let x = p0!.x;
    for (let j = 0; j < 12; j++) { e.tick(16); x -= 24; e.pointer("pointermove", x, p0!.y); }
    e.tick(16);
    const n0 = e.loader.wants.length, a0 = e.cov().assign;
    e.pointer("pointerup", x, p0!.y);
    const goal = S.motion.goal();
    assert.ok(goal && goal.kind === "inertia", "the release throws the view: the camera knows where it will rest");
    e.tick(16);
    const a1 = e.cov().assign;
    assert.equal(a1.goal, a0.goal + 1, "a destination pass in the frame after the release");
    assert.equal(a1.lastKind, "goal:inertia");
    const asked = new Set(wantedAfter(e, n0).map((w) => w.src));
    const atRest = e.kidsAt(goal);
    assert.ok(atRest.length > 0 && atRest.every((r) => asked.has(S.img[r.i]) || r.cell >= 0), "the children drawn where it will rest are asked (or own a cell already)");
    // the throw's estimate: where the camera comes to rest, within a few px of it
    for (let j = 0; j < 150 && S.engineDebug.motion().inertia; j++) e.tick(16);
    assert.ok(!S.engineDebug.motion().inertia, "the throw ended");
    const off = Math.hypot(S.cam.x - goal.x, S.cam.y - goal.y) * S.cam.k;
    assert.ok(off < 8, `rests ${off.toFixed(1)} px from the estimate`);
  } finally { e.dispose(); }
});

// ---- review fixes (2026-11-11) ----

test("a wheel gesture: a flick takes one pass, for the view it ends on, EASE_HOLD_MS after its last step; a long zoom in passes every GOAL_GAP_MS on the way; a long zoom out none on the way", async () => {
  const e = await mount({ nF: 8, kids: 40 });
  try {
    const { S } = e;
    // @ts-expect-error plain JS engine module
    const B = await import("../src/components/map3/engine/bubbles.js");
    const HOLD = typeof B.EASE_HOLD_MS === "number" ? B.EASE_HOLD_MS : 80, GAP = typeof B.GOAL_GAP_MS === "number" ? B.GOAL_GAP_MS : 300;
    const goals = () => e.cov().assign.goal;
    const at: number[] = [];
    const step = (ms: number) => { const g = goals(); e.tick(ms); if (goals() !== g) at.push(e.clock.t); };
    // 1. a flick: 6 steps 40 ms apart (a mouse wheel spun once). Before, the first step's target took a pass at once (a wider
    // view than the one the flick ends on) and the next one GOAL_GAP_MS later
    e.visit({ x: e.fam(0).cx, y: e.fam(0).cy, k: 1.55 });
    let g0 = goals();
    const n0 = e.loader.wants.length, t0 = e.clock.t;
    for (let j = 0; j < 6; j++) { e.wheel(W / 2, H / 2, -100); step(16); step(16); step(8); }
    const tLast = e.clock.t - 40;
    assert.equal(at.length, 0, `no pass during the flick (passes at ${at.map((t) => t - t0).join(", ")} ms)`);
    for (let j = 0; j < 60; j++) step(16);
    assert.equal(goals() - g0, 1, `one destination pass for the flick (${goals() - g0})`);
    assert.ok(at[0] - tLast >= HOLD && at[0] - tLast <= HOLD + 32, `the pass ${at[0] - tLast} ms after the last step (want ${HOLD}..${HOLD + 32}: the frame that sees the step, then EASE_HOLD_MS)`);
    const endKids = e.kidsAt({ ...S.cam });
    assert.ok(endKids.length >= 20, `${endKids.length} children at the logo size where the flick ends`);
    const asked = new Set(wantedAfter(e, n0).map((w) => w.src));
    assert.ok(endKids.every((r) => asked.has(S.img[r.i])), "the view it ends on is asked");
    const isKid = (i: number) => S.fams[S.famOf[i]].top !== i;
    const askedKids = [...asked].filter((u) => { const i = S.img.indexOf(u); return i >= 0 && isKid(i); }).length;
    assert.ok(askedKids <= endKids.length + 8, `only the view it ends on: ${askedKids} children asked, ${endKids.length} drawn there`);
    // 2. a long zoom in (a trackpad: a small step every 30 ms for 1.2 s): passes on the way, GOAL_GAP_MS apart, the first
    // GOAL_GAP_MS into the gesture; then one for the view it ends on, once the target holds
    e.visit({ x: e.fam(1).cx, y: e.fam(1).cy, k: 1.2 });
    at.length = 0;
    const tA = e.clock.t;
    for (let t = 0; t < 1_200; t += 30) { e.wheel(W / 2, H / 2, -12); step(16); step(14); }
    const tEnd = e.clock.t - 30, during = at.filter((t) => t <= tEnd + 30).map((t) => t - tA);
    assert.ok(during.length >= 2 && during.length <= Math.ceil(1_200 / GAP), `passes on the way in at ${during.join(", ")} ms`);
    assert.ok(during[0] >= GAP - 16, `the first ${during[0]} ms into the gesture (>= ${GAP} - one frame)`);
    for (let j = 1; j < during.length; j++) assert.ok(during[j] - during[j - 1] >= GAP - 16, `${during[j] - during[j - 1]} ms apart (>= ${GAP} - one frame)`);
    for (let j = 0; j < 60; j++) step(16);
    // the target's last value is asked by EASE_HOLD_MS after the last step (or sooner, by the pass on the way that came after it)
    assert.ok(at.some((t) => t > tEnd && t - tEnd <= HOLD + 32), `and one for the view it ends on (passes at ${at.map((t) => t - tEnd).join(", ")} ms from the last step)`);
    assert.equal(at.filter((t) => t > tEnd).length, 1, "only one");
    // 3. a long zoom out (children from ~20 px to below the logo size): no pass while the target zooms out; the view it ends
    // on gets one once the target holds
    e.visit({ x: e.fam(2).cx, y: e.fam(2).cy, k: 8 });
    g0 = goals(); at.length = 0;
    const tO = e.clock.t;
    for (let t = 0; t < 1_200; t += 30) { e.wheel(W / 2, H / 2, 16); step(16); step(14); }
    const tOEnd = e.clock.t - 30;
    assert.equal(at.filter((t) => t <= tOEnd + 30).length, 0, `no pass on the way out (at ${at.map((t) => t - tO).join(", ")} ms)`);
    for (let j = 0; j < 60; j++) step(16);
    assert.equal(goals() - g0, 1, "one pass, for the view it ends on");
    assert.ok(at[0] - tOEnd >= HOLD, `${at[0] - tOEnd} ms after the last step (>= ${HOLD})`);
  } finally { e.dispose(); }
});

test("a zoom tween (the +/- buttons, a double-click) lands exactly on the view its destination pass looked at: no second pass", async () => {
  const e = await mount({ nF: 8, kids: 40 });
  try {
    const { S } = e;
    const F = e.fam(0), off: string[] = [];
    for (const [k, f] of [[1.3, 0.5], [2.1, 0.5], [3.7, 0.7], [1.1, 2], [2.9, 1.37], [5.3, 0.45], [1.7, 1.9], [4.4, 0.81], [2.6, 1.23], [6.1, 0.6], [1.9, 2.4], [3.3, 0.33]]) {
      e.visit({ x: F.cx, y: F.cy, k });
      const a0 = { ...e.cov().assign };
      S.api.zoomBy(f);
      e.tick(16);
      const g = S.motion.goal();
      assert.ok(g && g.kind === "tween", "a tween");
      for (let j = 0; j < 60; j++) e.tick(16);
      const a1 = e.cov().assign;
      assert.ok(!S.motion.goal(), "the tween ended");
      assert.equal(a1.goal - a0.goal, 1, "one destination pass");
      if (S.cam.k !== g.k || S.cam.x !== g.x || S.cam.y !== g.y || a1.still !== a0.still) off.push(`k ${k} x${f}: dk ${(S.cam.k / g.k - 1).toExponential(2)}, still passes ${a1.still - a0.still}`);
    }
    assert.deepEqual(off, [], "every tween lands on its destination exactly, with no still pass after it");
  } finally { e.dispose(); }
});

test("reduced motion: an instant flight, focus, fly to a family and fit ask for the view they jump to in the next frame (a jump, not hand motion waiting STILL_MS), and no other pass follows", async () => {
  const e = await mount({ nF: 8, kids: 40 }, { rm: true });
  try {
    const { S } = e;
    assert.equal(S.motion.reduced, true);
    const cases: [string, () => void][] = [
      ["flyTo", () => { const v = famView(e, 1, 7); void S.motion.flyTo(v.x, v.y, v.k); }],
      ["focus", () => { S.motion.focus("m2", true); }],
      ["api.flyToFamily", () => { S.api.flyToFamily("m3"); }],
      ["fitAll", () => { S.motion.fitAll(true); }],
    ];
    for (const [name, go] of cases) {
      e.visit({ x: e.fam(5).cx, y: e.fam(5).cy, k: 9 });
      const n0 = e.loader.wants.length, a0 = { ...e.cov().assign }, t0 = e.clock.t;
      go();
      assert.ok(!S.engineDebug.flying(), `${name}: an instant jump`);
      const kids = e.kidsAt({ ...S.cam });
      e.tick(16);
      const a1 = { ...e.cov().assign };
      assert.equal(a1.goal - a0.goal, 1, `${name}: a destination pass in the next frame`);
      assert.equal(a1.lastKind, "goal:jump", name);
      const asked = new Set(wantedAfter(e, n0).filter((w) => w.t <= t0 + 16).map((w) => w.src));
      assert.ok(kids.every((r) => asked.has(S.img[r.i]) || r.cell >= 0), `${name}: the children drawn there are asked in that frame (${kids.filter((r) => asked.has(S.img[r.i])).length} of ${kids.length})`);
      e.ticks(400);
      const a2 = e.cov().assign;
      assert.equal(a2.passes - a1.passes, 0, `${name}: no other pass (still ${a2.still - a1.still}, moving ${a2.moving - a1.moving})`);
    }
  } finally { e.dispose(); }
});

test("the cell pass reads a coin's data (img, the failed-logo map, the filter) only for the coins near the view", async () => {
  const e = await mount({ nF: 40, planets: 6, kids: 150 }, { countImg: true });
  try {
    const { S } = e;
    e.visit({ x: 0, y: 0, k: 1 });
    const orig = S.runFrameHooks;
    let reads = -1;
    S.runFrameHooks = (now: number, dt: number) => { const r0 = e.imgReads.n; const r = orig(now, dt); reads = e.imgReads.n - r0; return r; };
    const v = famView(e, 7, 8);
    const kids = e.kidsAt(v);
    assert.ok(kids.length >= 20, `${kids.length} children at the destination`);
    const p0 = e.cov().assign.passes;
    void S.motion.flyTo(v.x, v.y, v.k);
    e.tick(0);
    assert.equal(e.cov().assign.passes, p0 + 1, "the destination pass ran in this frame");
    const n = S.bubbles.count();
    assert.ok(reads > 0 && reads < n / 5, `img read ${reads} times in the pass for ${n} coins (want < ${Math.round(n / 5)}: the coins near the view)`);
    S.runFrameHooks = orig;
  } finally { e.dispose(); }
});

test("mip levels: a small batch blits its cells' own levels (no generateMipmap of the whole atlas), a big one regenerates the chain once; an incomplete framebuffer falls back to generateMipmap", async () => {
  const LOD_LO = Math.log2(64) - 3;   // the shader's lod clamp for 64 px cells: levels 1..3
  {
    const e = await mount({ nF: 8, kids: 240 }, { blit: true, texMs: 0.004 });
    try {
      const { S } = e;
      const v = famView(e, 1, 3.4);
      e.visit(v);
      const kids = e.kidsAt(v).filter((r) => r.cell >= 0);
      assert.ok(kids.length >= 200, `${kids.length} children own a cell`);
      const lo = e.props.get(S.bubbles.atlasLo)!.__webglTexture;
      // a trickle: one logo a frame for 10 frames
      const m0 = e.mips.length, b0 = e.blits.length, u0 = e.uploads.length;
      for (let j = 0; j < 10; j++) {
        const r = kids[j];
        e.loader.bmp.set(S.img[r.i], bitmap(`t${j}`)); e.loader.notify();
        e.tick(16);
        assert.equal(S.bubbles.logoPx(r.i), 64, `logo ${j} drawn in the frame after its notice`);
      }
      assert.equal(e.mips.length - m0, 0, "no generateMipmap for single logos");
      const ups = e.uploads.slice(u0).filter((u) => u.tex === lo), bl = e.blits.slice(b0);
      assert.equal(ups.length, 10);
      assert.equal(bl.length, 10 * LOD_LO, `levels 1..${LOD_LO} of each cell (${bl.length} blits)`);
      for (const u of ups) for (let l = 1; l <= LOD_LO; l++) {
        const s = 64 >> (l - 1), sx = u.x >> (l - 1), sy = u.y >> (l - 1);
        const b = bl.find((x) => x.frame === u.frame && x.from === l - 1 && x.to === l && x.src[0] === sx && x.src[1] === sy);
        assert.ok(b, `cell (${u.x}, ${u.y}) level ${l} blitted in the frame of its upload`);
        assert.equal(b!.tex, lo, "within the LO atlas");
        assert.deepEqual(b!.src, [sx, sy, sx + s, sy + s]);
        assert.deepEqual(b!.dst, [sx >> 1, sy >> 1, (sx >> 1) + (s >> 1), (sy >> 1) + (s >> 1)], "2:1 into the same cell one level down");
      }
      // a burst: every other child's logo at once (one batch of > 64 cells): one generateMipmap, no blits
      const rest = kids.slice(10);
      for (const r of rest) e.loader.bmp.set(S.img[r.i], bitmap(`k${r.i}`));
      e.loader.notify();
      const m1 = e.mips.length, b1 = e.blits.length;
      e.tick(16);
      assert.ok(rest.every((r) => S.bubbles.logoPx(r.i) === 64), "the burst drawn in one batch");
      assert.equal(e.mips.length - m1, 1, "one generateMipmap for the burst");
      assert.equal(e.blits.length - b1, 0, "no blits for it");
    } finally { e.dispose(); }
  }
  {
    const e = await mount({ nF: 8, kids: 40 }, { blit: "incomplete" });
    try {
      const { S } = e;
      const v = famView(e, 1, 7);
      e.visit(v);
      const [a, b] = e.kidsAt(v).filter((r) => r.cell >= 0);
      for (const r of [a, b]) {
        const m0 = e.mips.length;
        e.loader.bmp.set(S.img[r.i], bitmap(`x${r.i}`)); e.loader.notify();
        e.tick(16);
        assert.equal(S.bubbles.logoPx(r.i), 64, "drawn");
        assert.equal(e.mips.length - m0, 1, "the chain regenerated (the blit path is off)");
      }
      assert.equal(e.blits.length, 0);
    } finally { e.dispose(); }
  }
});

// ---- second review (2026-11-11): a slow zoom out, a held +/- key ----

test("a slow wheel zoom out (a trackpad or a pinch the eased camera keeps up with) takes no pass on the way, one for the view it ends on; a zoom in and a pan still pass on the way", async () => {
  // The rule before: a pass on the way when the target was not more than GOAL_MOVE_LK below the CAMERA's zoom. The eased
  // camera trails its target by about rate x 0.09 s, so a zoom out slower than ~0.6/s in log k passed that test and took a
  // pass every GOAL_GAP_MS for views it only crossed. The rule now compares the target with the gesture's start (or the last
  // pass): a zoom out never takes one, whatever its speed.
  const e = await mount({ nF: 8, kids: 40 });
  try {
    const { S } = e;
    // @ts-expect-error plain JS engine module
    const B = await import("../src/components/map3/engine/bubbles.js");
    const HOLD = typeof B.EASE_HOLD_MS === "number" ? B.EASE_HOLD_MS : 80, GAP = typeof B.GOAL_GAP_MS === "number" ? B.GOAL_GAP_MS : 300;
    const goals = () => e.cov().assign.goal;
    const at: number[] = [];
    const step = (ms: number) => { const g = goals(); e.tick(ms); if (goals() !== g) at.push(e.clock.t); };
    /// n wheel events `every` ms apart (frames every 16 ms in between), deltaY dy each; returns the time of the last event
    const gesture = (n: number, every: number, dy: number, ctrl = false) => {
      for (let j = 0; j < n; j++) { e.wheel(W / 2, H / 2, dy, ctrl); for (let t = 0; t < every; t += 16) step(Math.min(16, every - t)); }
      return e.clock.t - every;
    };
    // [name, events, ms apart, deltaY, a pinch (ctrlKey: 0.01 per px in log k, else 0.0022)]
    const outs: [string, number, number, number, boolean][] = [
      ["a trackpad, 2x over 2 s (0.35/s in log k)", 125, 16, Math.log(2) / 0.0022 / 125, false],
      ["a pinch, 2x over 2 s", 125, 16, Math.log(2) / 0.01 / 125, true],
      ["45 steps of +20 px 64 ms apart (0.69/s; the performance review's probe)", 45, 64, 20, false],
    ];
    for (const [name, n, every, dy, ctrl] of outs) {
      e.visit({ x: e.fam(2).cx, y: e.fam(2).cy, k: 8 });
      const g0 = goals(), n0 = e.loader.wants.length, k0 = S.cam.k, t0 = e.clock.t;
      at.length = 0;
      const tLast = gesture(n, every, dy, ctrl);
      assert.ok(S.tgt.k < k0 / 1.9, `${name}: zoomed out (k ${k0} -> ${S.tgt.k.toFixed(2)})`);
      assert.deepEqual(at.filter((t) => t <= tLast + 16).map((t) => t - t0), [], `${name}: no pass on the way out (ms into the gesture)`);
      for (let j = 0; j < 60; j++) step(16);
      assert.equal(goals() - g0, 1, `${name}: one pass, for the view it ends on`);
      assert.ok(at[0] - tLast >= HOLD && at[0] - tLast <= HOLD + 32, `${name}: ${at[0] - tLast} ms after the last step (want ${HOLD}..${HOLD + 32})`);
      const end = e.kidsAt({ ...S.cam });
      if (n === 125) assert.ok(end.length >= 10, `${name}: ${end.length} children at the logo size where it ends`);
      const asked = new Set(wantedAfter(e, n0).map((w) => w.src));
      assert.ok(end.every((r) => r.cell >= 0 || asked.has(S.img[r.i])), `${name}: the view it ends on is asked`);
    }
    // out and back in within one gesture (no pause): none on the way out, passes on the way in, GOAL_GAP_MS apart
    e.visit({ x: e.fam(1).cx, y: e.fam(1).cy, k: 3 });
    at.length = 0;
    const tA = e.clock.t;
    const tOut = gesture(60, 16, Math.log(1.5) / 0.0022 / 60);   // 1.5x out over ~1 s (0.42/s)
    const tIn = gesture(120, 16, -Math.log(4) / 0.0022 / 120);   // then 4x in over ~2 s
    const outPart = at.filter((t) => t <= tOut + 16).map((t) => t - tA), inPart = at.filter((t) => t > tOut + 16 && t <= tIn + 16).map((t) => t - tA);
    assert.deepEqual(outPart, [], "no pass on the way out");
    assert.ok(inPart.length >= 2, `passes on the way back in at ${inPart.join(", ")} ms`);
    for (let j = 1; j < inPart.length; j++) assert.ok(inPart[j] - inPart[j - 1] >= GAP - 16, `${inPart[j] - inPart[j - 1]} ms apart (>= ${GAP} - one frame)`);
    // a pan (the arrow keys: S.api.panBy every 32 ms for 1.2 s; the camera eases after the target): passes on the way
    e.visit(famView(e, 0, 5));
    at.length = 0;
    const tP = e.clock.t;
    for (let t = 0; t < 1_200; t += 32) { S.api.panBy(20, 0); step(16); step(16); }
    const tPEnd = e.clock.t - 32, pans = at.filter((t) => t <= tPEnd + 16).map((t) => t - tP);
    assert.ok(pans.length >= 2 && pans.length <= Math.ceil(1_200 / GAP), `passes on the way of a pan at ${pans.join(", ")} ms`);
    for (let j = 1; j < pans.length; j++) assert.ok(pans[j] - pans[j - 1] >= GAP - 16, `${pans[j] - pans[j - 1]} ms apart (>= ${GAP} - one frame)`);
  } finally { e.dispose(); }
});

test("a held +/- key (zoomBy on every auto-repeat, 33 ms apart): the first press asks its view in the next frame, the repeats take no pass each, the view it ends on is asked; reduced and normal motion", async () => {
  // Before: under reduced motion every zoomBy was a one-frame "jump" with a pass at once, and with normal motion every one
  // a "tween" with a pass at once: a pass per repeat, each for a view shown for one repeat. A jump or a tween that comes
  // within SERIES_MS of the last goal change now continues a series: a tween takes the eased wheel's rules (once it holds
  // EASE_HOLD_MS; GOAL_GAP_MS apart on the way of a zoom in), a jump the hand-motion ones (MOVE_PASS_MS, then STILL_MS).
  // @ts-expect-error plain JS engine module
  const B = await import("../src/components/map3/engine/bubbles.js");
  const HOLD = typeof B.EASE_HOLD_MS === "number" ? B.EASE_HOLD_MS : 80, STILL = typeof B.STILL_MS === "number" ? B.STILL_MS : 100;
  const SERIES = typeof B.SERIES_MS === "number" ? B.SERIES_MS : 150;
  for (const rm of [true, false]) {
    const e = await mount({ nF: 8, kids: 40 }, { rm });
    try {
      const { S } = e;
      for (const [key, f, k0] of [["+", 1.5, 1.2], ["-", 1 / 1.5, 40]] as const) {
        const name = `${rm ? "reduced" : "normal"} motion, ${key} held`;
        e.visit({ x: e.fam(0).cx, y: e.fam(0).cy, k: k0 });
        const a0 = { ...e.cov().assign }, n0 = e.loader.wants.length, t0 = e.clock.t;
        const log: string[] = [];
        let last = a0.passes;
        const step = (ms: number) => { e.tick(ms); const a = e.cov().assign; if (a.passes !== last) { log.push(`${e.clock.t - t0}:${a.lastKind}`); last = a.passes; } };
        // 8 presses 33 ms apart (the key held ~0.25 s at a 30 Hz auto-repeat)
        for (let j = 0; j < 8; j++) {
          S.api.zoomBy(f);
          step(16);
          if (j === 0) assert.equal(e.cov().assign.goal - a0.goal, 1, `${name}: the first press, a destination pass in the next frame (${log.join(" ")})`);
          step(17);
        }
        const tLast = e.clock.t - 33, aKeys = { ...e.cov().assign }, kEnd = (S.motion.goal() || S.cam).k;
        assert.ok(f > 1 ? kEnd > k0 * 4 : kEnd < k0 / 4, `${name}: zoomed (k ${k0} -> ${kEnd.toFixed(2)})`);
        assert.equal(aKeys.goal - a0.goal, 1, `${name}: no destination pass for the repeats (passes ${log.join(" ")})`);
        for (let j = 0; j < 60; j++) step(16);
        const a1 = e.cov().assign;
        assert.ok(a1.passes - a0.passes <= 3, `${name}: ${a1.passes - a0.passes} passes in all (${log.join(" ")})`);
        // the view it ends on: asked by EASE_HOLD_MS (a tween) / STILL_MS (a jump) after the last press, + a frame or two
        const end = e.kidsAt({ ...S.cam });
        const asked = new Set(wantedAfter(e, n0).map((w) => w.src));
        assert.ok(end.every((r) => r.cell >= 0 || asked.has(S.img[r.i])), `${name}: the view it ends on is asked`);
        const lastAt = Number(log[log.length - 1].split(":")[0]) + t0;
        assert.ok(lastAt - tLast <= (rm ? STILL : HOLD) + 48, `${name}: the last pass ${lastAt - tLast} ms after the last press (${log.join(" ")})`);
      }
      // a press SERIES_MS or more after the last goal change starts a new series: a pass in the next frame, each time
      e.visit({ x: e.fam(1).cx, y: e.fam(1).cy, k: 2 });
      for (let j = 0; j < 3; j++) {
        const g0 = e.cov().assign.goal;
        S.api.zoomBy(1.5);
        e.tick(16);
        assert.equal(e.cov().assign.goal - g0, 1, `${rm ? "reduced" : "normal"} motion: press ${j + 1}, ${SERIES + 50} ms after the last, asked in the next frame`);
        e.ticks(SERIES + 34);
      }
    } finally { e.dispose(); }
  }
});


// (2026-11-11, third review) residual paths of the slow zoom-out rule: a wheel during a flight, a cursor far off centre, a pinch
// that turns back in. Each fails on the engine before that review's fix.
const goalsOf = (e: Eng) => e.cov().assign.goal;
function rig(e: Eng) {
  const at: number[] = [];
  const step = (ms: number) => { const g = goalsOf(e); e.tick(ms); if (goalsOf(e) !== g) at.push(e.clock.t); };
  /// n wheel events `every` ms apart from the clock's now, deltaY dy each, at (x, y)
  const gesture = (n: number, every: number, dy: number, x = W / 2, y = H / 2) => { for (let j = 0; j < n; j++) { e.wheel(x, y, dy); for (let t = 0; t < every; t += 16) step(Math.min(16, every - t)); } return e.clock.t - every; };
  return { at, step, gesture };
}
const BIG = { nF: 4, planets: 4, kids: (f: number) => (f === 0 ? 3000 : 200), kidMcap: (_f: number, j: number) => 2e4 + (j % 7) * 3e4 };

test("a wheel zoom out that interrupts a flight zooming out takes no pass on the way (the gesture starts at the camera, not at the flight's destination)", async () => {
  for (const delay of [16, 144]) {
    const e = await mount(BIG);
    try {
      const { S } = e, F = e.fam(0), kidR = S.R[e.idx("m0k0")];
      e.visit({ x: F.cx + 30, y: F.cy, k: 30 / kidR });
      const { at, step, gesture } = rig(e);
      S.api.flyToFamily("m0");            // frames the family: a flight zooming OUT (children 30 px -> ~3 px)
      for (let t = 0; t < delay; t += 16) step(16);
      const t0 = e.clock.t, n0 = e.loader.wants.length;
      at.length = 0;
      const tLast = gesture(125, 16, 1.2 / 0.0022 / 125);   // 0.6/s in log k, 2 s (above the min zoom)
      const kids = wantedAfter(e, n0).filter((w) => /k\d+\.png/.test(decodeURIComponent(w.src))).length;
      assert.deepEqual(at.filter((t) => t <= tLast + 16).map((t) => t - t0), [], `wheel ${delay} ms into the flight: no pass on the way out (${kids} children asked)`);
    } finally { e.dispose(); }
  }
});

test("a slow zoom out at a cursor far from the centre (the target pans > 32 px before it is 5 % out) takes no pass every GOAL_GAP_MS", async () => {
  const e = await mount(BIG);
  try {
    const { S } = e, F = e.fam(0), kidR = S.R[e.idx("m0k0")];
    e.visit({ x: F.cx + 30, y: F.cy, k: 12 / kidR });
    const { at, gesture } = rig(e);
    const t0 = e.clock.t, n = 500;
    const tLast = gesture(n, 16, 1.2 / 0.0022 / n, 0, 0);   // 0.15/s in log k for 8 s, cursor at (0, 0)
    const during = at.filter((t) => t <= tLast + 16).map((t) => t - t0);
    assert.ok(during.length <= 1, `passes on the way out at ${during.join(", ")} ms`);
  } finally { e.dispose(); }
});

test("out then back in within one gesture, the way in short of the start: the way in still takes passes", async () => {
  const e = await mount(BIG);
  try {
    const { S } = e, F = e.fam(0), kidR = S.R[e.idx("m0k0")];
    e.visit({ x: F.cx + 30, y: F.cy, k: 12 / kidR });
    const { at, gesture } = rig(e);
    const tOut = gesture(94, 16, Math.log(4) / 0.0022 / 94);     // 4x out over 1.5 s
    const tIn = gesture(94, 16, -Math.log(2) / 0.0022 / 94);     // 2x back in over 1.5 s (ends 2x out of the start)
    const inPart = at.filter((t) => t > tOut + 16 && t <= tIn + 16);
    assert.ok(inPart.length >= 2, `passes on the way in: ${inPart.length}`);
  } finally { e.dispose(); }
});
