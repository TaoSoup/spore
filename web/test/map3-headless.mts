// The map engine for real, headless (flat look; stub canvas / 2d context / WebGL renderer, as in map3-visibility.test.mts):
// ingest -> createVis (opts.last) -> layout -> placeDust -> bubbles -> links -> dust -> (swarm) -> motion. Not a test file
// (no `.test`): the compact-layout tests import it. The engine state is untyped here (plain JS modules).
import * as THREE from "three";

// the engine is plain JS: its state object is untyped here
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export function fakeRenderer() {
  const gl = new Proxy({} as Record<string, unknown>, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : typeof k === "string" && /^[A-Z0-9_]+$/.test(k) ? 0 : () => {}) });
  const props = new WeakMap<object, { __webglTexture: object }>();
  return {
    getContext: () => gl,
    properties: { get: (t: object) => { let p = props.get(t); if (!p) props.set(t, (p = { __webglTexture: {} })); return p; } },
    state: { bindTexture() {}, unbindTexture() {} },
    getRenderTarget: () => null, setRenderTarget() {}, getClearColor() {}, getClearAlpha: () => 1, setClearColor() {}, clear() {},
  };
}

export type HeadlessOpts = {
  roots: unknown[]; heat: unknown;
  last?: { mask: number; pinned?: string[] } | null;
  compact?: unknown; select?: string | null; focusFamily?: string; swarm?: boolean; nPlanets?: number;
  values?: unknown; valueOf?: unknown; mode?: "locked" | "mcap";
};

export async function mountHeadless(o: HeadlessOpts) {
  const g = globalThis as Record<string, unknown>;
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
  const images = { want: () => null, ready: () => false, failed: () => false, retryAt: () => 0, onLoaded: () => () => {} };
  const life = createLife();
  const ls: Record<string, ((e: unknown) => void)[]> = {};
  const canvas = { ...el(), addEventListener: (type: string, fn: (e: unknown) => void) => { (ls[type] ||= []).push(fn); }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }), setPointerCapture() {} };
  const last = o.last ?? null;
  const S: Any = createState({ clientWidth: 1200, clientHeight: 800 }, { canvas }, { look: "flat", images, nPlanets: o.nPlanets ?? 3, last, compact: o.compact, select: o.select ?? null, focusFamily: o.focusFamily, callbacks: {} }, life);
  ingest(S, { roots: o.roots, heat: o.heat, mode: o.mode ?? "locked", compact: o.compact, values: o.values, valueOf: o.valueOf });
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
  // spies on the new-pair fanfare
  const fx = { spark: 0, ring: 0, toast: 0 };
  S.links.pulses.spark = () => { fx.spark++; return false; };
  S.links.pulses.flashCoin = () => { fx.ring++; return true; };
  S.labels.toast = () => { fx.toast++; return true; };
  buildMotion(S);
  if (o.swarm) S.swarm.start();
  const idx = (m: string): number => { const i = S.mintIdx.get(m); return i === undefined ? S.api.knows(m) ? S.engineDebug.indexOf(m) : -1 : i; };
  let started = false, vt = performance.now();
  const tick = (ms = 16) => { if (!started) { started = true; S.motion.start(); } vt = Math.max(vt + ms, performance.now()); for (const f of rafQ.splice(0)) f(vt); };
  const flush = (ms = 10) => new Promise((res) => setTimeout(res, ms));
  return { S, life, idx, fx, tick, flush, api: S.api as Any, dbg: S.engineDebug as Any, dispose: () => life.disposeAll() };
}
