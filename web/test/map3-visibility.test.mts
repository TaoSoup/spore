// The Key's last-trade filter in the map engine (src/components/map3/engine/vis.js and its consumers), 2026-11-10.
//   1. vis.js, pure: SHOWN by class bit or pin, ANCHOR = a not-shown ancestor of a shown coin (up to and including the family
//      top), HIDDEN otherwise; famVis 0 = a family with nothing drawn; mask 15 = everything shown; virtual descendants (a
//      capped family's specks) anchor their top; any sequence of incremental reveals / hides / pins equals a full recompute.
//   2. The engine for real, headless (flat look; stub canvas / 2d context / WebGL renderer as in map3-logo-retry.test.mts):
//      ingest -> createVis (opts.last) -> layout -> bubbles -> links -> dust -> motion. Checks: the first frame's alphas follow
//      opts.last, setLastFilter / visibility / lastFilterStats, hidden coins are never picked (anchors are), hidden coins get
//      no logo-atlas cell, a trade reveals a hidden coin at once with its chain anchored (== a full recompute), a hidden
//      coin's trade is culled when its pulse comes due (a drawn one's runs), a hidden newborn gets no spark / ring / label
//      (a drawn one gets all three), mask 15 draws everything again; a hidden family never keeps or takes the focus; a
//      hovered coin or speck the filter, a heat poll, a pin that goes or a trade hides loses its hover (the pointer taking
//      over a page hover announces only its own); every fade starts at performance.now(), not at a stale uTime.
//   3. The class the filter files a coin under: vis.js visClassOf == lib/map/visibility.ts coinClass (a coin created within
//      30 min of heat.at is class 0), at build, on every heat payload (built coins and newborns), and in lastFilterStats.
//   npx tsx --test test/map3-visibility.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS engine module
import { VIS, MASK_ALL, VIS_ALPHA, NEWBORN_S, classShown, cleanMask, visClassOf, visLevels, visSet, visVirt, visGrow, visCounts } from "../src/components/map3/engine/vis.js";
// @ts-expect-error plain JS engine module
import { heatClass } from "../src/components/map3/engine/tokens.js";
import { coinClass, NEWBORN_S as PAGE_NEWBORN_S } from "../src/lib/map/visibility.ts";
import type { HeatIndex } from "../src/lib/map/heat.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";

type St = { n: number; level: Uint8Array; famVis: Int32Array; shown: Uint8Array; desc: Int32Array; cnt: Int32Array; virt: Int32Array | null };

// ---------- 1. the pure levels ----------

// a forest in pre-order (par[i] < i), families by top
function forest(parents: number[]) {
  const n = parents.length, par = Int32Array.from(parents), famOf = new Int32Array(n);
  let nFam = 0;
  for (let i = 0; i < n; i++) famOf[i] = par[i] < 0 ? nFam++ : famOf[par[i]];
  return { n, par, famOf, nFam };
}
const levels = (st: St) => Array.from(st.level.subarray(0, st.n));

test("anchors run up the parent chain to the family top; other branches stay hidden", () => {
  // family 0: 0 -> 1 -> 2 -> 3, 1 -> 4; family 1: 5 -> 6
  const F = forest([-1, 0, 1, 2, 1, -1, 5]);
  const cls = Uint8Array.from([3, 3, 3, 0, 3, 3, 3]);
  const st = visLevels(F.par, cls, 1, null, F.famOf, F.nFam) as St;
  assert.deepEqual(levels(st), [VIS.ANCHOR, VIS.ANCHOR, VIS.ANCHOR, VIS.SHOWN, VIS.HIDDEN, VIS.HIDDEN, VIS.HIDDEN]);
  assert.deepEqual(Array.from(st.famVis), [1, 0], "family 1 has nothing drawn");
  assert.deepEqual(visCounts(st), { shown: 1, anchors: 3, hidden: 3 });
});

test("pinned coins are shown whatever their class, their chain anchored", () => {
  const F = forest([-1, 0, 1, 2, 1, -1, 5]);
  const cls = Uint8Array.from([3, 3, 3, 3, 3, 3, 3]);
  const st = visLevels(F.par, cls, 1, [4, 6], F.famOf, F.nFam) as St;
  assert.deepEqual(levels(st), [VIS.ANCHOR, VIS.ANCHOR, VIS.HIDDEN, VIS.HIDDEN, VIS.SHOWN, VIS.ANCHOR, VIS.SHOWN]);
  assert.deepEqual(Array.from(st.famVis), [1, 1]);
});

test("a family with every member hidden has famVis 0 and a hidden top", () => {
  const F = forest([-1, 0, 0, -1, 3, 3]);
  const cls = Uint8Array.from([2, 3, 3, 0, 3, 1]);
  const st = visLevels(F.par, cls, 0b0011, null, F.famOf, F.nFam) as St;
  assert.equal(st.famVis[0], 0);
  assert.equal(st.level[0], VIS.HIDDEN, "top of a hidden family");
  assert.ok(st.famVis[1] > 0 && st.level[3] === VIS.SHOWN);
});

test("mask 15 is the identity: every coin shown, no anchors", () => {
  const F = forest([-1, 0, 1, 1, -1, 4, 5]);
  const cls = Uint8Array.from([0, 1, 2, 3, 3, 3, 0]);
  const st = visLevels(F.par, cls, MASK_ALL, null, F.famOf, F.nFam) as St;
  assert.ok(levels(st).every((l) => l === VIS.SHOWN));
  assert.deepEqual(visCounts(st), { shown: 7, anchors: 0, hidden: 0 });
  assert.equal(cleanMask(undefined), 15); assert.equal(cleanMask(NaN), 15); assert.equal(cleanMask(0), 0); assert.equal(cleanMask(31), 15);
  assert.equal(classShown(0b1000, 3), 1); assert.equal(classShown(0b1000, 0), 0); assert.equal(classShown(0b1000, 9), 1, "out of range = class 3");
  assert.deepEqual(Array.from(VIS_ALPHA).map((v) => +(v as number).toFixed(2)), [0, 0.28, 1]);
});

test("virtual descendants (a capped family's specks) anchor the top", () => {
  const F = forest([-1, 0, 0]);
  const cls = Uint8Array.from([3, 3, 3]);
  const virt = new Int32Array(3); virt[0] = 1;
  const st = visLevels(F.par, cls, 1, null, F.famOf, F.nFam, { virt }) as St;
  assert.deepEqual(levels(st), [VIS.ANCHOR, VIS.HIDDEN, VIS.HIDDEN]);
  assert.equal(st.famVis[0], 1);
  const ch: number[] = [];
  visVirt(st, 0, -1, ch);
  assert.deepEqual(ch, [0]); assert.equal(st.level[0], VIS.HIDDEN); assert.equal(st.famVis[0], 0);
});

test("an index out of pre-order falls back to walking the chains", () => {
  // 3 is the parent of 1 (3 > 1): the reverse pass alone would miss it
  const par = Int32Array.from([-1, 3, 0, 0]), famOf = new Int32Array(4), cls = Uint8Array.from([3, 0, 3, 3]);
  const st = visLevels(par, cls, 1, null, famOf, 1) as St;
  assert.deepEqual(levels(st), [VIS.ANCHOR, VIS.SHOWN, VIS.HIDDEN, VIS.ANCHOR]);
});

// a seeded PRNG (mulberry32)
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test("incremental reveals, hides, pins and specks equal a full recompute (random forests)", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed), n = 40 + Math.floor(r() * 400), born = 30;
    const parents: number[] = [];
    for (let i = 0; i < n; i++) parents.push(i === 0 || r() < 0.06 ? -1 : Math.floor(r() * i));   // pre-order: parent < child
    const F = forest(parents), cap = n + born;
    const par = new Int32Array(cap).fill(-1); par.set(F.par);
    const famOf = new Int32Array(cap).fill(-1); famOf.set(F.famOf);
    const cls = new Uint8Array(cap).fill(3); for (let i = 0; i < n; i++) cls[i] = Math.floor(r() * 4);
    const virt = new Int32Array(cap);
    const mask = Math.floor(r() * 16), pins = new Set<number>();
    const st = visLevels(par, cls, mask, null, famOf, F.nFam, { n, cap, virt: virt.slice() }) as St;
    let m = n;
    const want = (i: number) => classShown(mask, cls[i]) === 1 || pins.has(i);
    for (let step = 0; step < 300; step++) {
      const op = r(), before = levels(st), changed: number[] = [];
      if (op < 0.35) { const i = Math.floor(r() * m); cls[i] = Math.floor(r() * 4); visSet(st, i, want(i), changed); }   // a trade / heat change
      else if (op < 0.6) { const i = Math.floor(r() * m); if (pins.has(i)) pins.delete(i); else pins.add(i); visSet(st, i, want(i), changed); }   // a pin
      else if (op < 0.75 && m < cap) {   // a newborn under a random coin
        const i = m++; par[i] = Math.floor(r() * n); famOf[i] = famOf[par[i]]; cls[i] = 0;
        visGrow(st, m); visSet(st, i, want(i), changed);
      } else {   // specks of a family appear / go (virtual descendants of its top)
        const tops = []; for (let i = 0; i < n; i++) if (par[i] < 0) tops.push(i);
        const t = tops[Math.floor(r() * tops.length)], d = st.virt![t] > 0 && r() < 0.5 ? -1 : 1;
        visVirt(st, t, d, changed);
      }
      const full = visLevels(par, cls, mask, [...pins], famOf, F.nFam, { n: m, cap, virt: Int32Array.from(st.virt!) }) as St;
      assert.deepEqual(levels(st), levels(full), `seed ${seed} step ${step}: levels`);
      assert.deepEqual(Array.from(st.famVis), Array.from(full.famVis), `seed ${seed} step ${step}: famVis`);
      assert.deepEqual(Array.from(st.cnt), Array.from(full.cnt), `seed ${seed} step ${step}: counts`);
      // the changed list holds exactly the coins whose level moved (a newborn counts from hidden)
      const after = levels(st), moved = new Set<number>();
      for (let i = 0; i < m; i++) if ((i < before.length ? before[i] : VIS.HIDDEN) !== after[i]) moved.add(i);
      assert.deepEqual(new Set(changed), moved, `seed ${seed} step ${step}: changed list`);
    }
  }
});

// ---------- 3 (pure). the class the filter files a coin under: the engine and the page agree ----------

test("visClassOf (engine) == coinClass (page): the newborn rule and the heat edges", () => {
  assert.equal(NEWBORN_S, PAGE_NEWBORN_S);
  const AT = 1_700_000_000;
  const nodeOf = (createdAt: number | null): BubbleNode => ({ mint: "c", parentMint: null, depth: 0, name: "c coin", symbol: "C", image: null, mcapUsd: 500, lockedUsd: null, children: 0, migrated: false, createdAt });
  const heatOf = (last: number | null, at = AT): HeatIndex => ({ at, version: 1, rows: new Map(last == null ? [] : [["c", { t1h: 0, n24: 1, v24: 0, last, buys1h: 0 }]]) });
  // [createdAt (null = unknown), last trade (s; null = no heat row), expected class, why]
  const cases: [number | null, number | null, number, string][] = [
    [AT - NEWBORN_S, null, 0, "created exactly 30 min before heat.at, no heat row"],
    [AT - NEWBORN_S - 1, null, 3, "created 1801 s before, no heat row"],
    [null, null, 3, "no createdAt, no heat row"],
    [0, null, 3, "createdAt 0 (unknown)"],
    [null, AT - 60, 0, "no createdAt, traded a minute ago"],
    [AT - 60, AT - 7200, 0, "a 2 h old trade, created a minute ago: born wins"],
    [AT - 60, AT - 100_000, 0, "an old trade, created a minute ago"],
    [AT - NEWBORN_S - 1, AT - 5000, 1, "created 1801 s before, traded 83 min ago: its heat class"],
    [AT + 500, null, 0, "created after heat.at (clock skew)"],
    [AT - 10, 0, 0, "a heat row with no trade on record, created just now"],
    [AT - 86_400, 0, 3, "a heat row with no trade on record"],
    [AT - 86_400, AT - 1800, 0, "traded exactly 30 min ago"],
    [AT - 86_400, AT - 1801, 1, "traded 1801 s ago"],
    [AT - 86_400, AT - 10_800, 1, "traded exactly 3 h ago"],
    [AT - 86_400, AT - 10_801, 2, "traded 3 h 1 s ago"],
    [AT - 86_400, AT - 86_400, 2, "traded exactly 24 h ago"],
    [AT - 86_400, AT - 86_401, 3, "traded 24 h 1 s ago"],
    [AT - 3 * 86_400, AT + 30, 0, "a stream trade after the poll (age 0)"],
  ];
  for (const [createdAt, last, want, why] of cases) {
    // the engine's inputs as data.js builds them: age = heat.at - last (Infinity without a row), crt = createdAt > 0 or 0
    const age = last == null ? Infinity : Math.max(0, AT - last), crt = createdAt != null && createdAt > 0 ? createdAt : 0;
    const page = coinClass(nodeOf(createdAt), heatOf(last));
    assert.equal(page, want, `page: ${why}`);
    assert.equal(visClassOf(age, crt, AT), page, `engine == page: ${why}`);
  }
  // no heat at all: the page files every coin under 'older'; an engine built without heat has no heat clock (nowS 0)
  assert.equal(coinClass(nodeOf(AT - 60), null), 3);
  assert.equal(visClassOf(Infinity, AT - 60, 0), 3);
  // only the filter's class: the look (heat colour, rim, boost) keeps the heat class
  assert.equal(heatClass(Infinity), 3);
});

// ---------- 2. the engine, headless ----------

// the engine is plain JS: its state object is untyped here
type Any = any;
const T0 = Date.parse("2026-11-10T12:00:00Z") / 1000;

/// families f = 0..5 (0..2 planets): top m{f}, children m{f}k0..k2, grandchildren m{f}k0g0, m{f}k0g1 under k0. Heat:
/// fam 0: m0k0g0 live; fam 1: nothing; fam 2: m2 (top) live, m2k1 2 h ago; fam 3: m3k2 10 h ago; fams 4, 5: nothing.
/// o.crt: createdAt (s) by mint (none by default); o.swarm: m0 is a listed asset with 400 undrawn coins (swarm specks);
/// o.rows: more heat rows [mint, age s].
type DataOpts = { crt?: Record<string, number>; swarm?: boolean; rows?: [string, number][] };
function data(o: DataOpts = {}) {
  const coin = (mint: string, v: number) => ({ mint, symbol: mint.toUpperCase(), name: null, image: `/img/${mint}.png`, mcapUsd: v * 10, lockedUsd: v, ...(o.crt && mint in o.crt ? { createdAt: o.crt[mint] } : {}) });
  const roots = Array.from({ length: 6 }, (_, f) => ({
    coin: coin(`m${f}`, 1e6 / (f + 1)),
    children: [0, 1, 2].map((k) => ({ coin: coin(`m${f}k${k}`, 4e4 / (k + 1)), children: k === 0 ? [0, 1].map((g) => ({ coin: coin(`m${f}k0g${g}`, 2e4), children: [] })) : [] })),
  }));
  if (o.swarm) Object.assign(roots[0].coin, { asset: true, children: 403 });
  const rows: [string, number][] = [["m0k0g0", 60], ["m2", 120], ["m2k1", 7200], ["m3k2", 36000], ...(o.rows || [])];
  const heat = { at: T0, mint: rows.map((x) => x[0]), last: rows.map((x) => T0 - x[1]), n24: rows.map(() => 3), t1h: rows.map(() => 1), v24: rows.map(() => 100), buys1h: rows.map(() => 1) };
  return { roots, heat };
}

function fakeRenderer() {
  const gl = new Proxy({} as Record<string, unknown>, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : typeof k === "string" && /^[A-Z0-9_]+$/.test(k) ? 0 : () => {}) });
  const props = new WeakMap<object, { __webglTexture: object }>();
  return {
    getContext: () => gl,
    properties: { get: (t: object) => { let p = props.get(t); if (!p) props.set(t, (p = { __webglTexture: {} })); return p; } },
    state: { bindTexture() {}, unbindTexture() {} },
    getRenderTarget: () => null, setRenderTarget() {}, getClearColor() {}, getClearAlpha: () => 1, setClearColor() {}, clear() {},
  };
}

async function mount(last: { mask: number; pinned?: string[] } | null, o: DataOpts & { focusFamily?: string } = {}) {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = new Proxy({} as Record<string, unknown>, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : () => {}), set: (t, k, v) => { t[k as string] = v; return true; } });
  const el = () => ({ width: 0, height: 0, style: {} as Record<string, string>, getContext: () => ctx2d, addEventListener() {}, removeEventListener() {} });
  g.window = { innerWidth: 1440, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  g.document = { createElement: el };
  g.location = { href: "http://local.test/" };
  // motion's frame loop runs only when a test pumps it (tick below)
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
  const THREE = await import("three");
  const { roots, heat } = data(o);
  const wants: string[] = [];
  const images = { want: (src: string) => { wants.push(src); return null; }, ready: () => false, failed: () => false, retryAt: () => 0, onLoaded: () => () => {} };
  const life = createLife();
  // the canvas keeps its listeners: a test can move the pointer over it
  const ls: Record<string, ((e: unknown) => void)[]> = {};
  const canvas = { ...el(), addEventListener: (type: string, fn: (e: unknown) => void) => { (ls[type] ||= []).push(fn); }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }), setPointerCapture() {} };
  const hovers: (string | null)[] = [];   // callbacks.onHover, in order
  const S: Any = createState({ clientWidth: 1200, clientHeight: 800 }, { canvas }, { look: "flat", images, nPlanets: 3, last, focusFamily: o.focusFamily, callbacks: { onHover: (m: string | null) => hovers.push(m) } }, life);
  ingest(S, { roots, heat, mode: "locked" });
  S.vis = createVis(S, last);
  await buildLayout(S);
  await placeDust(S);
  S.gfx.scene = new THREE.Scene();
  S.gfx.renderer = fakeRenderer();
  S.gfx.camera = new THREE.OrthographicCamera(-600, 600, 400, -400, -100, 100);
  S.overview.uRvis = { value: 1 };
  buildBubbles(S);
  await buildLinks(S);
  buildDust(S);
  if (o.swarm) {
    // @ts-expect-error plain JS engine module
    const { buildSwarm } = await import("../src/components/map3/engine/swarm.js");
    buildSwarm(S);
  }
  // spies on the live effects a hidden coin must not get
  const fx = { spark: 0, ring: 0, toast: 0 };
  const spawned: number[] = [];   // links.pulses.spawn(i): a pulse along coin i's link
  S.links.pulses.spark = () => { fx.spark++; return false; };
  S.links.pulses.flashCoin = () => { fx.ring++; return true; };
  S.links.pulses.spawn = (i: number) => { spawned.push(i); return true; };
  S.labels.toast = () => { fx.toast++; return true; };
  buildMotion(S);
  if (o.swarm) S.swarm.start();
  const idx = (m: string): number => S.mintIdx.get(m);
  let now = 1_000;
  const frame = () => { now += 300; S.frame++; return S.runFrameHooks(now, 300); };
  // motion's own frames (pulses fire, the pointer's hit test, every frame hook), on a clock ms ahead of the last one
  let started = false, vt = performance.now();
  const tick = (ms = 16) => { if (!started) { started = true; S.motion.start(); } vt = Math.max(vt + ms, performance.now()); for (const f of rafQ.splice(0)) f(vt); };
  const pointerAt = (x: number, y: number) => { for (const fn of ls.pointermove || []) fn({ clientX: x, clientY: y, pointerType: "mouse", pointerId: 1 }); };
  // timers (life.timeout: the birth ring, the swarm's slices) get to run
  const flush = (ms = 10) => new Promise((res) => setTimeout(res, ms));
  return { S, life, idx, wants, fx, spawned, hovers, heat, frame, tick, pointerAt, flush, api: S.api as Any, dbg: S.engineDebug as Any };
}

test("engine: opts.last is applied before the first frame (bubbles, links, dust read the levels at build)", async () => {
  const e = await mount({ mask: 1 });
  try {
    const { S, idx } = e, V = S.vis, B = S.bubbles;
    assert.equal(V.level[idx("m0k0g0")], VIS.SHOWN);
    assert.equal(V.level[idx("m0k0")], VIS.ANCHOR); assert.equal(V.level[idx("m0")], VIS.ANCHOR);
    assert.equal(V.level[idx("m0k1")], VIS.HIDDEN); assert.equal(V.level[idx("m1")], VIS.HIDDEN);
    // the instance alphas a first frame draws: 1 shown, TOK.dim anchor, 0 hidden (no setVis call needed)
    assert.equal(B.hlOf(idx("m0k0g0")), 1);
    assert.equal(B.hlOf(idx("m0k0")), Math.fround(VIS_ALPHA[1]));
    assert.equal(B.hlOf(idx("m0k1")), 0); assert.equal(B.hlOf(idx("m1")), 0);
    assert.ok(S.links.visStats().nonFull > 0 && S.links.visStats().on === 1, "the links read the levels from the build");
    assert.deepEqual(e.api.lastFilterStats().byClass, [2, 1, 1, 32]);
    assert.equal(e.api.lastFilterStats().mask, 1);
  } finally { e.life.disposeAll(); }
});

test("engine: setLastFilter / visibility / lastFilterStats, idempotent, and mask 15 draws everything again", async () => {
  const e = await mount(null);
  try {
    const { S, api, idx } = e;
    assert.equal(S.vis.on, false, "mask 15: nothing hidden, the gates are off");
    assert.deepEqual(api.setLastFilter(15), { shown: 36, anchors: 0, hidden: 0 });
    const r1 = api.setLastFilter(0b0011);
    assert.deepEqual(r1, { shown: 3, anchors: 2, hidden: 31 }, "m0k0g0, m2, m2k1 shown; m0k0, m0 anchors (m2 is shown itself)");
    assert.equal(api.visibility("m2k1"), "shown"); assert.equal(api.visibility("m0"), "anchor"); assert.equal(api.visibility("m3k2"), "hidden");
    assert.equal(api.visibility("nope"), null);
    assert.deepEqual(api.setLastFilter(0b0011), r1, "idempotent");
    // pins: the selected coin and its chain (the page sends both)
    assert.deepEqual(api.setLastFilter(0b0011, ["m1k0g1", "m1k0", "m1"]), { shown: 6, anchors: 2, hidden: 28 });
    assert.equal(api.visibility("m1k0g1"), "shown");
    assert.deepEqual(api.setLastFilter(0b0011), r1, "unpinned again");
    assert.equal(S.bubbles.hlOf(idx("m1k0g1")), 0);
    // the engine's own selection is drawn whatever the page pinned
    api.select("m4k2");
    assert.equal(api.visibility("m4k2"), "shown"); assert.equal(api.visibility("m4"), "anchor");
    api.select(null);
    assert.equal(api.visibility("m4k2"), "hidden"); assert.equal(api.visibility("m4"), "hidden");
    // back to 15: every alpha 1, the CPU gates off
    assert.deepEqual(api.setLastFilter(15), { shown: 36, anchors: 0, hidden: 0 });
    assert.equal(S.vis.on, false);
    for (let i = 0; i < S.N; i++) assert.equal(S.bubbles.hlOf(i), 1, `coin ${i} drawn at full alpha`);
    assert.equal(S.links.visStats().nonFull, 0, "every link full: the shaders stop reading the channel once the fade is over");
  } finally { e.life.disposeAll(); }
});

test("engine: hidden coins are never picked; anchors are", async () => {
  const e = await mount(null);
  try {
    const { S, api, dbg, idx } = e;
    const at = (m: string) => { dbg.zoomTo(idx(m), 30); return dbg.pick(S.W() / 2, S.H() / 2).i; };
    assert.equal(at("m0k1"), idx("m0k1"), "mask 15: picked");
    assert.equal(at("m0k0"), idx("m0k0"));
    api.setLastFilter(1);
    assert.notEqual(at("m0k1"), idx("m0k1"), "hidden: not picked");
    assert.equal(at("m0k0"), idx("m0k0"), "an anchor is clickable");
    assert.equal(at("m0k0g0"), idx("m0k0g0"));
    // a family with nothing drawn: no chip, no colony at the overview
    dbg.zoomTo(idx("m1"), 1);
    assert.notEqual(dbg.pick(S.W() / 2, S.H() / 2).i, idx("m1"));
  } finally { e.life.disposeAll(); }
});

test("engine: a hidden coin takes no logo-atlas cell and asks for no logo; revealed, it does", async () => {
  const e = await mount({ mask: 1 });
  try {
    const { S, dbg, idx, frame } = e;
    dbg.zoomTo(idx("m0"), 12);
    frame(); frame(); frame();   // the cell pass runs once the camera has been still for STILL_MS (2026-11-11; was two checks 250 ms apart)
    const rows = S.debugFns.kidLogos(4.5, 200).rows as { i: number; cell: number }[];
    const hidden = rows.filter((r) => S.vis.level[r.i] === VIS.HIDDEN), drawn = rows.filter((r) => S.vis.level[r.i] !== VIS.HIDDEN);
    assert.ok(hidden.length > 0 && drawn.length > 0, `on screen: ${hidden.length} hidden, ${drawn.length} drawn`);
    for (const r of hidden) assert.equal(r.cell, -1, `hidden coin ${r.i} owns no cell`);
    assert.ok(drawn.some((r) => r.cell >= 0), "a drawn child takes a cell");
    assert.ok(!e.wants.includes("/img/m0k1.png"), "no logo asked for a hidden coin");
    e.api.setLastFilter(15);
    frame(); frame();
    const after = S.debugFns.kidLogos(4.5, 200).rows as { i: number; cell: number }[];
    assert.ok(after.find((r) => r.i === idx("m0k1"))!.cell >= 0, "revealed: it takes a cell");
  } finally { e.life.disposeAll(); }
});

test("engine: a trade reveals a hidden coin at once, its chain anchored, equal to a full recompute", async () => {
  const e = await mount({ mask: 1 });
  try {
    const { S, api, dbg, idx } = e, V = S.vis;
    e.tick();   // motion's frames run (no coin is live enough for a load pulse)
    const c = idx("m1k0g1");
    assert.equal(api.visibility("m1k0g1"), "hidden"); assert.equal(api.visibility("m1"), "hidden");
    api.applyEvent({ name: "trade", data: { mint: "m1k0g1", time: T0 + 30, isBuy: true, valueUsd: 50 } });
    assert.equal(api.visibility("m1k0g1"), "shown");
    assert.equal(api.visibility("m1k0"), "anchor"); assert.equal(api.visibility("m1"), "anchor");
    assert.equal(api.visibility("m1k1"), "hidden", "siblings stay hidden");
    assert.equal(S.bubbles.hlOf(c), 1); assert.equal(S.bubbles.hlOf(idx("m1")), Math.fround(VIS_ALPHA[1]));
    const full = visLevels(V.par, V.cls, V.mask, [], V.fam, S.fams.length, { n: V.st.n, virt: Int32Array.from(V.virt) }) as St;
    assert.deepEqual(levels(V.st), levels(full)); assert.deepEqual(Array.from(V.famVis), Array.from(full.famVis));
    e.tick(200); e.tick();   // its pulse comes due (<= 120 ms) while it is drawn
    assert.equal(dbg.live().culled.hidden, 0);
    // a trade on a coin the Key keeps hidden (bit 0 off), zoomed in on its family (a drawn coin's trade would run a pulse
    // along its link): no live effect, whale ring and label included
    const g0 = idx("m0k0g0");
    api.setLastFilter(0b1000);
    dbg.zoomTo(g0, 30); e.tick();
    assert.equal(api.visibility("m0k0g0"), "hidden");
    const fx0 = { ...e.fx }, hid0 = dbg.live().culled.hidden;
    api.applyEvent({ name: "trade", data: { mint: "m0k0g0", time: T0 + 40, isBuy: false, valueUsd: 20000 } });
    assert.equal(api.visibility("m0k0g0"), "hidden", "live, but the Key shows only 'older'");
    assert.equal(dbg.live().queued, 1, "its pulse waits in the queue");
    e.tick(200); e.tick();   // past its due time
    assert.equal(dbg.live().queued, 0);
    assert.equal(dbg.live().culled.hidden, hid0 + 1, "culled when it came due");
    assert.ok(!e.spawned.includes(g0), "no pulse along its link");
    assert.deepEqual(e.fx, fx0, "no whale ring, no whale label");
    // the Key shows it: its next trade runs its pulse
    api.setLastFilter(0b1001);
    assert.equal(api.visibility("m0k0g0"), "shown");
    api.applyEvent({ name: "trade", data: { mint: "m0k0g0", time: T0 + 50, isBuy: true, valueUsd: 50 } });
    e.tick(200); e.tick();
    assert.ok(e.spawned.includes(g0), "a drawn coin's trade runs a pulse along its link");
    assert.equal(dbg.live().culled.hidden, hid0 + 1);
  } finally { e.life.disposeAll(); }
});

test("engine: a newborn the Key hides gets no spark, ring or label; shown, it anchors its parent", async () => {
  const e = await mount({ mask: 0b0100 });
  try {
    const { api, dbg, fx } = e;
    const nowS = Date.now() / 1000;
    const born = (mint: string, parent: string) => dbg.feed({ name: "pair", data: { coin: { mint, symbol: mint, name: null, image: null, mcapUsd: 5000, lockedUsd: 0, createdAt: nowS }, parent: { mint: parent } } });
    born("b1", "m4k1");
    assert.equal(api.visibility("b1"), "hidden");
    assert.equal(api.visibility("m4k1"), "hidden");
    await e.flush();   // the arrival ring is a timer (life.timeout): it would have fired by now
    assert.deepEqual(fx, { spark: 0, ring: 0, toast: 0 });
    assert.equal(dbg.live().births.hidden, 1);
    api.setLastFilter(0b0101);
    assert.equal(api.visibility("b1"), "shown", "the filter shows class 0: the newborn appears");
    assert.equal(api.visibility("m4k1"), "anchor"); assert.equal(api.visibility("m4"), "anchor");
    born("b2", "m5k2");
    assert.equal(api.visibility("b2"), "shown");
    await e.flush();
    assert.deepEqual(fx, { spark: 1, ring: 1, toast: 1 }, "a shown birth gets its spark, its arrival ring and its label");
    assert.equal(api.lastFilterStats().byClass[0], 4, "newborns are class 0");
  } finally { e.life.disposeAll(); }
});

// ---------- 3 (engine). the newborn rule, as the page files coins ----------

type Heat = { at: number; mint: string[]; last: number[]; n24: number[]; t1h: number[]; v24: number[]; buys1h: number[] };
/// the page's class (lib/map/visibility.ts coinClass) of every built coin under this payload
function pageClasses(S: Any, heat: Heat, crt: Record<string, number>) {
  const hi: HeatIndex = { at: heat.at, version: 1, rows: new Map(heat.mint.map((m, r) => [m, { t1h: 0, n24: 1, v24: 0, last: heat.last[r], buys1h: 0 }])) };
  return Array.from({ length: S.N }, (_, i) => {
    const m = S.mint[i] as string;
    return coinClass({ mint: m, parentMint: null, depth: 0, name: m, symbol: m, image: null, mcapUsd: 1, lockedUsd: null, children: 0, migrated: false, createdAt: crt[m] ?? null }, hi);
  });
}

test("engine: a coin created within 30 min of heat.at is class 0 (the page's rule) until a payload's clock passes it", async () => {
  // no heat row for any of them: m5k1 created 10 min before heat.at, m4k2 28 min before, m3k1 2 h before
  const crt = { m5k1: T0 - 600, m4k2: T0 - 1680, m3k1: T0 - 7200 };
  const e = await mount({ mask: 1 }, { crt });
  try {
    const { S, api, idx, heat } = e;
    const same = (h: Heat, why: string) => assert.deepEqual(Array.from(S.vis.cls.subarray(0, S.N)), pageClasses(S, h, crt), `engine == page: ${why}`);
    same(heat, "at build");
    assert.equal(api.visibility("m5k1"), "shown", "no trade, created 10 min ago: the page shows it, so does the map");
    assert.equal(api.visibility("m5"), "anchor");
    assert.equal(api.visibility("m4k2"), "shown");
    assert.equal(api.visibility("m3k1"), "hidden");
    assert.deepEqual(api.lastFilterStats().byClass, [4, 1, 1, 30]);
    assert.equal(S.bubbles.cls[idx("m5k1")], 3, "its look keeps its heat class (cold)");
    // 20 min later: m4k2 is 48 min old (its heat class: 3), m5k1 exactly 30 min (still 0)
    const h1 = { ...heat, at: T0 + 1200 };
    api.setHeat(h1);
    same(h1, "20 min later");
    assert.equal(api.visibility("m4k2"), "hidden"); assert.equal(api.visibility("m4"), "hidden");
    assert.equal(api.visibility("m5k1"), "shown");
    const h2 = { ...heat, at: T0 + 1201 };
    api.setHeat(h2);
    same(h2, "a second later");
    assert.equal(api.visibility("m5k1"), "hidden"); assert.equal(api.visibility("m5"), "hidden");
    assert.deepEqual(api.lastFilterStats().byClass, [2, 1, 1, 32]);
  } finally { e.life.disposeAll(); }
});

test("engine: a newborn leaves class 0 once the heat clock is 30 min past its creation; its trades keep it live", async () => {
  const e = await mount({ mask: 1 });
  try {
    const { api, dbg, heat } = e;
    const nowS = Date.now() / 1000;
    dbg.feed({ name: "pair", data: { coin: { mint: "b1", symbol: "b1", name: null, image: null, mcapUsd: 5000, lockedUsd: 0, createdAt: nowS }, parent: { mint: "m4k1" } } });
    assert.equal(api.visibility("b1"), "shown");
    const at = Math.max(T0, nowS) + 1801;
    api.setHeat({ ...heat, at });
    assert.equal(api.visibility("b1"), "hidden", "31 min after its creation, no trade on record: 'older'");
    assert.equal(api.visibility("m4k1"), "hidden");
    api.applyEvent({ name: "trade", data: { mint: "b1", time: at + 5, isBuy: true, valueUsd: 50 } });
    assert.equal(api.visibility("b1"), "shown", "it traded: live");
    assert.equal(api.visibility("m4k1"), "anchor");
    api.setHeat({ ...heat, at: at + 60 });
    assert.equal(api.visibility("b1"), "shown", "its stream trade is 55 s old");
    api.setHeat({ ...heat, at: at + 5 + 1801 });
    assert.equal(api.visibility("b1"), "hidden", "its trade is 30 min 1 s old");
    // a payload's own row for it
    api.setHeat({ ...heat, at: at + 4000, mint: [...heat.mint, "b1"], last: [...heat.last, at + 3500], n24: [...heat.n24, 1], t1h: [...heat.t1h, 1], v24: [...heat.v24, 1], buys1h: [...heat.buys1h, 1] });
    assert.equal(api.visibility("b1"), "shown", "its heat row: traded 500 s before the poll");
  } finally { e.life.disposeAll(); }
});

// ---------- the focus, the hover, the fade clock ----------

test("engine: a family the filter hides entirely neither keeps nor takes the focus", async () => {
  const e = await mount(null);
  try {
    const { S, api, dbg } = e;
    const f1 = S.famOf[e.idx("m1")];
    S.motion.focus("m1");
    assert.equal(api.focusedFamily(), "m1", "mask 15: focused");
    api.setLastFilter(1);   // family 1 has no trade within 30 min: nothing of it is drawn
    assert.equal(api.visibility("m1"), "hidden");
    assert.notEqual(S.motion.focusedFam(), f1, "it lets the view go (the rest would recede around nothing)");
    assert.notEqual(api.focusedFamily(), "m1");
    S.motion.focus("m1");
    assert.notEqual(S.motion.focusedFam(), f1, "focus() onto a hidden family does not focus it");
    api.setReducedMotion(true);   // a flight lands at once
    await dbg.focusFamily("m1");
    assert.notEqual(S.motion.focusedFam(), f1, "nor does a flight onto it");
    // drawn again: it takes the focus as before
    api.setLastFilter(15);
    S.motion.focus("m1");
    assert.equal(api.focusedFamily(), "m1");
    await dbg.focusFamily("m0");
    assert.equal(api.focusedFamily(), "m0");
  } finally { e.life.disposeAll(); }
});

test("engine: a mount focused on a family the filter hides does not focus it", async () => {
  const e = await mount({ mask: 1 }, { focusFamily: "m1" });
  try { assert.equal(e.api.focusedFamily(), null); } finally { e.life.disposeAll(); }
  const e2 = await mount({ mask: 1 }, { focusFamily: "m0" });
  try { assert.equal(e2.api.focusedFamily(), "m0", "a family with a drawn coin is focused"); } finally { e2.life.disposeAll(); }
});

test("engine: a hovered coin the filter, a heat poll or a pin hides loses its hover; a page hover is kept", async () => {
  const e = await mount(null);
  try {
    const { S, api, dbg, idx, heat, hovers } = e;
    // the pointer rests on a coin (the hit test runs once the camera is still)
    const hoverOn = (m: string) => { dbg.zoomTo(idx(m), 30); e.tick(); e.pointerAt(S.W() / 2, S.H() / 2); e.tick(200); return dbg.hovered(); };
    assert.equal(hoverOn("m3k1"), idx("m3k1"));
    assert.equal(hovers.at(-1), "m3k1");
    api.setLastFilter(0b0111);   // 'older' off: m3k1 (no trade) is hidden
    assert.equal(api.visibility("m3k1"), "hidden");
    assert.equal(dbg.hovered(), -1, "the filter hid it: the hover goes");
    assert.equal(hovers.at(-1), null, "the page hears the hover end (its card closes)");
    // a heat poll ages the hovered coin out of the Key's classes
    api.setLastFilter(1);
    assert.equal(hoverOn("m0k0g0"), idx("m0k0g0"));
    api.setHeat({ ...heat, at: T0 + 1800 });   // its trade is 31 min old now
    assert.equal(api.visibility("m0k0g0"), "hidden");
    assert.equal(dbg.hovered(), -1, "the heat poll hid it: the hover goes");
    // the selection pin goes: a hovered coin drawn only because it was selected
    api.select("m4k2");
    assert.equal(hoverOn("m4k2"), idx("m4k2"));
    api.select(null);
    assert.equal(api.visibility("m4k2"), "hidden");
    assert.equal(dbg.hovered(), -1, "unselected and hidden: the hover goes");
    // a page hover pins its coin: drawn, and kept
    api.hover("m3k1");
    assert.equal(dbg.hovered(), idx("m3k1")); assert.equal(api.visibility("m3k1"), "shown");
    api.setLastFilter(2);
    assert.equal(dbg.hovered(), idx("m3k1"), "a page hover stays");
    // mask 15: a hovered coin stays hovered
    api.hover(null); api.setLastFilter(15);
    assert.equal(hoverOn("m5k1"), idx("m5k1"));
    api.setLastFilter(15); api.setHeat({ ...heat, at: T0 + 9000 });
    assert.equal(dbg.hovered(), idx("m5k1"));
  } finally { e.life.disposeAll(); }
});

test("engine: a hovered speck the filter hides loses its hover (swarm.js asks once the specks' alphas moved)", async () => {
  // m0 is a listed asset with 400 undrawn coins; synth0x1pump traded a minute ago (its family keeps a drawn speck)
  const e = await mount(null, { swarm: true, rows: [["synth0x1pump", 60]] });
  try {
    const { S, api, dbg, hovers } = e;
    for (let t = 0; t < 400 && !S.swarm.ready(); t++) await e.flush(2);
    assert.ok(S.swarm.ready(), "the slots are built");
    assert.equal(S.debugFns.swarmSynth("m0", 40), 40);
    e.tick(); e.tick();   // the queued rows land
    const sp = S.swarm.indexOf("synth0x5pump"), live = S.swarm.indexOf("synth0x1pump");
    assert.ok(sp >= S.swarm.DUST0 && live >= S.swarm.DUST0, "both loaded");
    dbg.zoomTo(sp, 80); e.tick();
    e.pointerAt(S.W() / 2, S.H() / 2); e.tick(200);
    assert.equal(dbg.hovered(), sp, "the pointer rests on the speck");
    assert.equal(hovers.at(-1), "synth0x5pump");
    // a stale uTime (the last frame drew 3 s ago): the specks' crossfade still starts now
    const t0 = performance.now() / 1000; S.U.uTime.value = t0 - 3;
    api.setLastFilter(0b0111);   // 'older' off: the speck (no trade) goes; synth0x1pump (live) stays
    const t1 = performance.now() / 1000, hlT0 = S.debug.obj.swarm.material.uniforms.uSwHlT0.value;
    assert.ok(hlT0 >= t0 && hlT0 <= t1, `the swarm's crossfade starts now: ${hlT0} in [${t0}, ${t1}]`);
    e.tick(); e.tick();   // the swarm's alpha pass
    assert.equal(S.swarm.isShown(sp), false); assert.equal(S.swarm.isShown(live), true);
    assert.equal(S.vis.speck[S.famOf[e.idx("m0")]], 1, "the family still draws a speck: no visSpeck call (motion.js alone would not see it)");
    assert.equal(dbg.hovered(), -1, "the hidden speck lost its hover");
    assert.equal(hovers.at(-1), null);
  } finally { e.life.disposeAll(); }
});

// m0 is a listed asset with 400 undrawn coins; synth0x1pump traded a minute ago, the other synthetic specks never
const SPECKS: DataOpts = { swarm: true, rows: [["synth0x1pump", 60]] };
/// 40 synthetic specks loaded under the Key's mask: the index of synth0x5pump (no trade: class 3)
async function specks(e: Awaited<ReturnType<typeof mount>>, mask: number) {
  const { S } = e;
  for (let t = 0; t < 400 && !S.swarm.ready(); t++) await e.flush(2);
  assert.equal(S.debugFns.swarmSynth("m0", 40), 40);
  e.tick(); e.tick();   // the queued rows land
  e.api.setLastFilter(mask); e.tick(); e.tick();   // the swarm's alpha pass
  const sp = S.swarm.indexOf("synth0x5pump");
  assert.ok(sp >= S.swarm.DUST0, "loaded");
  return sp as number;
}
/// the pointer comes to rest on coin or speck i (the hit test runs once the camera is still): the hovered index
const pointAt = (e: Awaited<ReturnType<typeof mount>>, i: number, k = 80) => { e.dbg.zoomTo(i, k); e.tick(); e.pointerAt(e.S.W() / 2, e.S.H() / 2); e.tick(200); return e.dbg.hovered() as number; };

test("engine: a hovered speck drawn only because it was selected loses its hover when the selection goes (swarm.js setPins asks)", async () => {
  const e = await mount(null, SPECKS);
  try {
    const { S, api, dbg, hovers } = e;
    const sp = await specks(e, 0b0111);   // 'older' off: synth0x5pump hidden, synth0x1pump (live) drawn
    assert.equal(S.swarm.isShown(sp), false, "the Key hides it");
    api.select("synth0x5pump");
    assert.equal(S.swarm.isShown(sp), true, "the selection pins it");
    assert.equal(pointAt(e, sp), sp, "the pointer rests on it");
    assert.equal(hovers.at(-1), "synth0x5pump");
    api.select(null);
    assert.equal(S.swarm.isShown(sp), false, "unpinned: hidden again");
    assert.equal(S.vis.speck[S.famOf[e.idx("m0")]], 1, "its family still draws a speck: no visSpeck / visPush runs, only the swarm sees it");
    assert.equal(dbg.hovered(), -1, "unselected and hidden: the hover goes");
    assert.equal(hovers.at(-1), null, "the page hears the hover end");
  } finally { e.life.disposeAll(); }
});

test("engine: a trade that makes a hovered speck live while the Key shows only 'older' drops its hover (swarm.js trade asks)", async () => {
  const e = await mount(null, SPECKS);
  try {
    const { S, api, dbg, hovers } = e;
    const sp = await specks(e, 0b1000);   // 'older' only: synth0x5pump drawn, synth0x1pump (live) hidden
    assert.equal(S.swarm.isShown(sp), true, "the Key shows it");
    assert.equal(pointAt(e, sp), sp, "the pointer rests on it");
    assert.equal(hovers.at(-1), "synth0x5pump");
    api.applyEvent({ name: "trade", data: { mint: "synth0x5pump", time: T0 + 30, isBuy: true, valueUsd: 50 } });
    assert.equal(S.swarm.isShown(sp), false, "live now: the Key hides it");
    assert.equal(S.vis.speck[S.famOf[e.idx("m0")]], 1, "its family still draws a speck: only the swarm sees it");
    assert.equal(dbg.hovered(), -1, "the trade hid it: the hover goes");
    assert.equal(hovers.at(-1), null, "the page hears the hover end");
  } finally { e.life.disposeAll(); }
});

test("engine: the pointer taking over a page hover on a coin the filter hides announces only its own hover (setHover's hovSwap)", async () => {
  const e = await mount({ mask: 7 });
  try {
    const { S, api, dbg, idx, hovers } = e;
    dbg.zoomTo(idx("m2k1"), 30); e.tick();
    api.hover("m3k1");   // no trade: hidden by class, drawn only through the page hover's pin
    assert.equal(dbg.hovered(), idx("m3k1")); assert.equal(api.visibility("m3k1"), "shown");
    e.tick(200); e.tick(200); e.tick(200);   // the camera settles first (onSettle re-pins a page hover through hoverMint)
    assert.equal(dbg.hovered(), idx("m3k1"), "still the page hover");
    const n0 = hovers.length;
    e.pointerAt(S.W() / 2, S.H() / 2); e.tick(200);
    assert.equal(dbg.hovered(), idx("m2k1"), "the pointer's coin (traded 2 h ago: drawn)");
    assert.equal(api.visibility("m3k1"), "hidden", "the page hover's pin went with it");
    assert.deepEqual(hovers.slice(n0), ["m2k1"], "no onHover(null) in between (the page's card would close for a beat)");
  } finally { e.life.disposeAll(); }
});

test("engine: on an idle map a Key toggle, a pin or a heat poll crossfades: every fade starts now, not at the last frame's uTime", async () => {
  const e = await mount(null);
  try {
    const { S, api, idx, heat } = e;
    const aHl = S.bubbles.mesh.geometry.getAttribute("aHl").array as Float32Array;
    const startOf = (m: string) => aHl[S.bubbles.invIdx[idx(m)] * 3 + 2];
    const dHl = S.debug.obj.dustPts.geometry.getAttribute("aHl").array as Float32Array;
    const within = (v: number, t0: number, t1: number, why: string) => assert.ok(v >= Math.fround(t0) - 1e-3 && v <= t1 + 1e-3, `${why}: ${v} in [${t0}, ${t1}]`);
    const stale = () => { const t = performance.now() / 1000; S.U.uTime.value = t - 3; return t; };
    let t0 = stale();
    api.setLastFilter(1);
    let t1 = performance.now() / 1000;
    within(startOf("m0k1"), t0, t1, "a coin the toggle hides");
    within(S.links.flatMesh.material.uniforms.uHlT0.value, t0, t1, "the links' shared clock");
    let dn = 0;
    for (let k = 0; k < dHl.length / 3; k++) if (dHl[k * 3 + 1] === 0) { within(dHl[k * 3 + 2], t0, t1, `dust speck ${k}`); dn++; }
    assert.ok(dn > 0, "dust families went too");
    // a pin (the selection: visOne's default start)
    t0 = stale(); api.select("m4k2"); t1 = performance.now() / 1000;
    within(startOf("m4k2"), t0, t1, "a selected hidden coin");
    // a heat poll that moves a coin across the Key's line
    api.select(null);
    t0 = stale(); api.setHeat({ ...heat, at: T0 + 1800 }); t1 = performance.now() / 1000;
    within(startOf("m0k0g0"), t0, t1, "a coin a heat poll hides");
  } finally { e.life.disposeAll(); }
});
