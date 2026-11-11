// The map engine's failed-logo bookkeeping (src/components/map3/engine/bubbles.js), driven for real: buildBubbles runs
// headless (a stub canvas and 2d context, a fake WebGL renderer whose texSubImage2D records what lands in the atlas, and a
// fake image loader with the contract of src/lib/map/images.ts: want / ready / failed / retryAt / onLoaded) on node:test's
// mock clock (setTimeout + Date).
//   - one failed-logo sweep timer at a time: a sweep a load notice runs early (recheckLogos) replaces the pending timer
//     instead of leaving it running (each such sweep used to start one more timer chain: ~100 live timers after 3 h of
//     notices), and sweeps run at most once per FAIL_SWEEP_MS;
//   - a coin whose cell still shows an older logo is asked for its patched URL again once that URL's dead time is over
//     (the cell pass asks an owner only while its cell is empty, so before it never was);
//   - at most FAIL_ASK_MAX cell owners are asked per sweep; the rest follow at the next sweeps, each asked once.
//   npx tsx --test test/map3-logo-retry.test.mts
import { mock, test } from "node:test";
import assert from "node:assert/strict";

type Bmp = { width: number; height: number; tag: string };
type Want = { src: string; px: number; at: number };
type Fn = (...a: unknown[]) => unknown;
type Life = { timeout: (fn: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void; disposeAll: () => void };
type Bubbles = {
  logoList: number[]; logoPx: (i: number) => number; screenR: (i: number) => number;
  patchImage: (i: number, url: string | null) => boolean;
};
type Engine = {
  N: number; planets: { top: number }[]; img: (string | null)[]; X: Float32Array; Y: Float32Array;
  cam: { x: number; y: number; k: number }; dustExpand: number; frame: number; bubbles: Bubbles;
  gfx: { scene: unknown; renderer: unknown }; runFrameHooks: (now: number, dt: number) => boolean;
  debugFns: { logoCoverage: () => { failed: number; failedRetry: number; failSweeps: number; failedBack: number } };
};

const T0 = Date.parse("2026-11-10T12:00:00Z");
const URL0 = (k: string) => `/api/img?u=${encodeURIComponent(`https://img.test/${k}.png`)}`;
const bitmap = (tag: string): Bmp => ({ width: 64, height: 64, tag });

/// A loader with the images.ts contract. deadUntil: source -> Date.now() ms it refuses wants until (or a function giving it).
function fakeLoader() {
  const bmp = new Map<string, Bmp>(), deadUntil = new Map<string, number | (() => number)>(), wants: Want[] = [];
  let listeners: (() => void)[] = [];
  const until = (src: string) => { const v = deadUntil.get(src); return typeof v === "function" ? v() : v ?? 0; };
  const isDead = (src: string) => until(src) > Date.now();
  return {
    bmp, deadUntil, wants,
    wantsOf: (src: string) => wants.filter((w) => w.src === src),
    notify() { for (const f of listeners) f(); },
    api: {
      want: (src: string, px: number) => { wants.push({ src, px, at: Date.now() }); return isDead(src) ? null : bmp.get(src) ?? null; },
      ready: (src: string) => bmp.has(src) && !isDead(src),
      failed: (src: string) => isDead(src),
      retryAt: (src: string) => (isDead(src) ? until(src) : 0),
      onLoaded: (f: () => void) => { listeners.push(f); return () => { listeners = listeners.filter((g) => g !== f); }; },
    },
  };
}
type Loader = ReturnType<typeof fakeLoader>;

/// three's WebGLRenderer as far as bubbles.js uses it: the atlas clears, texSubImage2D (recorded) and generateMipmap.
function fakeRenderer(uploads: unknown[]) {
  const base: Record<string, unknown> = { texSubImage2D: (...a: unknown[]) => { uploads.push(a[a.length - 1]); } };
  const gl = new Proxy(base, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : typeof k === "string" && /^[A-Z0-9_]+$/.test(k) ? 0 : () => {}) });
  const props = new WeakMap<object, { __webglTexture: object }>();
  return {
    getContext: () => gl,
    properties: { get: (t: object) => { let p = props.get(t); if (!p) props.set(t, (p = { __webglTexture: {} })); return p; } },
    state: { bindTexture() {}, unbindTexture() {} },
    getRenderTarget: () => null, setRenderTarget() {}, getClearColor() {}, getClearAlpha: () => 1, setClearColor() {}, clear() {},
  };
}

/// The engine up to buildBubbles (ingest, layout, placeDust), flat look, 4 planets, `nFams` families of `kids` children each.
/// `live` = the timers bubbles.js holds right now (S.life.timeout / clearTimeout, wrapped).
async function mount(loader: Loader, nFams = 8, kids = 2) {
  const g = globalThis as Record<string, unknown>;
  const ctx2d = new Proxy({} as Record<string, unknown>, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : () => {}), set: (t, k, v) => { t[k as string] = v; return true; } });
  g.window = { innerWidth: 1440, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  g.document = { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d, addEventListener() {}, removeEventListener() {} }) };
  g.location = { href: "http://local.test/" };
  // @ts-expect-error plain JS engine module
  const { createState, createLife } = await import("../src/components/map3/engine/state.js");
  // @ts-expect-error plain JS engine module
  const { ingest } = await import("../src/components/map3/engine/data.js");
  // @ts-expect-error plain JS engine module
  const { buildLayout } = await import("../src/components/map3/engine/layout.js");
  // @ts-expect-error plain JS engine module
  const { placeDust } = await import("../src/components/map3/engine/dust.js");
  // @ts-expect-error plain JS engine module
  const { buildBubbles, FAIL_SWEEP_MS, FAIL_ASK_MAX } = await import("../src/components/map3/engine/bubbles.js");
  const THREE = await import("three");
  const roots = Array.from({ length: nFams }, (_, f) => ({
    coin: { mint: `m${f}`, symbol: `S${f}`, mcapUsd: 1e6 / (f + 1), lockedUsd: 1e5 / (f + 1), image: URL0(`f${f}`) },
    children: Array.from({ length: kids }, (_, k) => ({ coin: { mint: `m${f}k${k}`, symbol: `K${k}`, mcapUsd: 1e4, lockedUsd: 1e3, image: URL0(`f${f}k${k}`) }, children: [] })),
  }));
  const life = createLife() as Life;
  const live = new Set<unknown>();
  let maxLive = 0;
  const t0 = life.timeout as Fn, c0 = life.clearTimeout as Fn;
  life.timeout = (fn, ms) => {
    const id = t0.call(life, () => { live.delete(id); fn(); }, ms);
    if (id) { live.add(id); maxLive = Math.max(maxLive, live.size); }
    return id;
  };
  life.clearTimeout = (id) => { live.delete(id); c0.call(life, id); };
  const S = createState({ clientWidth: 1200, clientHeight: 800 }, {}, { look: "flat", images: loader.api, nPlanets: 4 }, life) as Engine;
  ingest(S, { roots, heat: null, mode: "locked" });
  await buildLayout(S);
  await placeDust(S);
  const uploads: unknown[] = [];
  S.gfx.scene = new THREE.Scene();
  S.gfx.renderer = fakeRenderer(uploads);
  buildBubbles(S);
  let now = 1_000;
  /// One frame of the engine's frame hooks (load notices, the cell pass, atlas uploads), 300 ms after the last.
  /// (2026-11-11, logos at once) a load notice is applied in the next frame now, not by a 250 ms recheck timer
  const frame = () => { now += 300; S.frame++; return S.runFrameHooks(now, 300); };
  return {
    S, life, live, uploads, frame, FAIL_SWEEP_MS: FAIL_SWEEP_MS as number, FAIL_ASK_MAX: FAIL_ASK_MAX as number,
    maxLive: () => maxLive, resetMaxLive: () => { maxLive = live.size; },
    cov: () => S.debugFns.logoCoverage(),
    /// the family tops holding a pinned LO cell (not planets: those hold HI cells)
    loTops: () => S.bubbles.logoList.slice(S.planets.length),
  };
}

function clock() {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  return () => { mock.timers.reset(); };
}

/// 3 h of another logo landing every 100 ms while the planets' sources fail and the loader always says "ask again in
/// `retryMs`": the sweep timer (armed >= FAIL_SWEEP_MS) fires after failNext, so a load notice in between runs the due
/// sweep first (recheckLogos, in the frame after the notice).
async function threeHoursOfNotices(retryMs: number) {
  const off = clock();
  const loader = fakeLoader();
  try {
    for (let f = 0; f < 4; f++) loader.deadUntil.set(URL0(`f${f}`), () => Date.now() + retryMs);
    const e = await mount(loader);
    assert.equal(e.cov().failed, 4, "the planets' logos failed at build");
    assert.equal(e.live.size, 1, "one sweep timer");
    e.resetMaxLive();
    // 3 h of another logo landing every 100 ms, a frame after each notice
    const H3 = 3 * 3_600_000, STEP = 100;
    for (let t = 0; t < H3; t += STEP) { loader.notify(); e.frame(); mock.timers.tick(STEP); }
    const st = e.cov();
    // (2026-11-11, logos at once) was <= 2: the sweep timer + the 250 ms recheck timer; a notice is now applied in the next
    // frame, so the sweep timer is the only one
    assert.ok(e.maxLive() <= 1, `at most the sweep timer lives at any time (max ${e.maxLive()})`);
    assert.ok(st.failSweeps <= H3 / e.FAIL_SWEEP_MS + 1, `sweeps ${st.failSweeps} <= one per ${e.FAIL_SWEEP_MS} ms`);
    assert.ok(st.failSweeps >= H3 / 2_000, `the sweep keeps running (${st.failSweeps})`);
    mock.timers.tick(1_000);
    assert.equal(e.live.size, 1, "quiet again: exactly one timer (the sweep's)");
    // the loader's verdict expires: the next sweep hands them back and asks the planets (HI cells) again
    for (let f = 0; f < 4; f++) { loader.deadUntil.delete(URL0(`f${f}`)); loader.bmp.set(URL0(`f${f}`), bitmap(`f${f}`)); }
    mock.timers.tick(2_000);
    assert.equal(e.cov().failed, 0);
    for (let f = 0; f < 4; f++) assert.ok(loader.wantsOf(URL0(`f${f}`)).some((w) => w.at > T0 + H3), `planet ${f} asked again`);
    assert.equal(e.live.size, 0, "nothing failed: no timer");
    e.life.disposeAll();
  } finally { off(); }
}

test("one sweep timer at a time: load notices that run due sweeps early never leave a second timer chain; sweeps <= 1 per FAIL_SWEEP_MS", () => threeHoursOfNotices(700));

// "ask again in 300 ms" puts failNext 700 ms before the sweep timer: a notice lands in between at every sweep and its
// recheck (the next frame; ~250 ms later before 2026-11-11) finds the failed logos due, so only the FAIL_SWEEP_MS rule in
// sweepDue keeps the sweeps to one per FAIL_SWEEP_MS (without it: one per 300 ms, 35,999 in the 3 h). With 700 ms a notice almost never comes
// before the timer, so that case alone stays green without the rule.
test("sweeps <= 1 per FAIL_SWEEP_MS also when every sweep's failNext comes well before its timer (ask again in 300 ms)", () => threeHoursOfNotices(300));

test("a coin whose cell shows an older logo is asked for its patched URL again after that URL's dead time, and the new logo lands", async () => {
  const off = clock();
  const loader = fakeLoader();
  try {
    const e = await mount(loader);
    const { S } = e;
    const i = e.loTops()[0];
    assert.ok(i >= 0 && S.planets.every((f) => f.top !== i), "a dust-family top with a pinned LO cell");
    // put it on screen, drawn well above the logo size, with the dust field handed off: a cell-pass candidate
    S.dustExpand = 1; S.cam.x = S.X[i]; S.cam.y = S.Y[i];
    for (let k = 1; S.bubbles.screenR(i) < 12 && k < 1e6; k *= 1.25) S.cam.k = k;
    assert.ok(S.bubbles.screenR(i) >= 12, `drawn at ${S.bubbles.screenR(i)} px`);
    // logo 1 lands
    const u1 = URL0("one"), u2 = URL0("two"), b1 = bitmap("one"), b2 = bitmap("two");
    loader.bmp.set(u1, b1);
    assert.equal(S.bubbles.patchImage(i, u1), true);
    for (let n = 0; n < 4; n++) e.frame();
    assert.equal(S.bubbles.logoPx(i), 64);
    assert.equal(e.uploads.at(-1), b1);
    // the URL changes again and the new one is dead for 15 min: the cell keeps showing logo 1
    const DEAD = 15 * 60_000, tDead = Date.now() + DEAD;
    loader.deadUntil.set(u2, tDead);
    assert.equal(S.bubbles.patchImage(i, u2), true);
    assert.equal(e.cov().failed, 1);
    assert.equal(S.bubbles.logoPx(i), 64, "the old logo stays up meanwhile");
    loader.bmp.set(u2, b2);   // the server has it by the time the dead time is over
    for (let t = 0; t < DEAD - 5_000; t += 1_000) { mock.timers.tick(1_000); e.frame(); loader.notify(); }
    assert.equal(loader.wantsOf(u2).length, 0, "not asked while dead (the loader's failed() answers first)");
    for (let t = 0; t < 10_000; t += 1_000) { mock.timers.tick(1_000); e.frame(); loader.notify(); }
    for (let n = 0; n < 4; n++) e.frame();
    const later = loader.wantsOf(u2).filter((w) => w.at >= tDead);
    assert.equal(later.length, 1, "asked once more after its dead time (the cell pass alone never asks an owner showing a logo)");
    assert.equal(e.cov().failed, 0);
    assert.equal(e.uploads.at(-1), b2, "logo 2 lands in the cell");
    assert.equal(S.bubbles.logoPx(i), 64);
    e.life.disposeAll();
  } finally { off(); }
});

test("at most FAIL_ASK_MAX cell owners are asked per sweep; the rest follow at the next sweeps, each asked exactly once", async () => {
  const off = clock();
  const loader = fakeLoader();
  try {
    const e = await mount(loader, 300, 0);
    const tops = e.loTops();
    assert.ok(tops.length > 2 * e.FAIL_ASK_MAX, `${tops.length} LO tops`);
    // every top's URL changes to one that is dead until the same moment (a sheet of dead cells)
    const DEAD = 15 * 60_000, tDead = Date.now() + DEAD, url = (i: number) => URL0(`p${i}`);
    for (const i of tops) { loader.deadUntil.set(url(i), tDead); loader.bmp.set(url(i), bitmap(`p${i}`)); e.S.bubbles.patchImage(i, url(i)); }
    assert.equal(e.cov().failed, tops.length);
    const askedAt = () => tops.filter((i) => loader.wantsOf(url(i)).some((w) => w.at >= tDead)).length;
    mock.timers.tick(DEAD - 1);
    assert.equal(askedAt(), 0);
    mock.timers.tick(1);
    let prev = askedAt(), sweeps = 1;
    assert.equal(prev, e.FAIL_ASK_MAX, "the sweep at the dead time asks FAIL_ASK_MAX of them");
    while (prev < tops.length && sweeps < 10) {
      mock.timers.tick(e.FAIL_SWEEP_MS - 1);
      assert.equal(askedAt(), prev, "the next sweep waits FAIL_SWEEP_MS");
      mock.timers.tick(1);
      const n = askedAt();
      assert.ok(n > prev && n - prev <= e.FAIL_ASK_MAX, `sweep ${sweeps}: ${n - prev} asked`);
      prev = n; sweeps++;
    }
    assert.equal(askedAt(), tops.length, "every owner asked");
    assert.equal(sweeps, Math.ceil(tops.length / e.FAIL_ASK_MAX), "in ceil(n / FAIL_ASK_MAX) sweeps, one per FAIL_SWEEP_MS");
    for (const i of tops) assert.equal(loader.wantsOf(url(i)).filter((w) => w.at >= tDead).length, 1, `top ${i} asked once`);
    assert.equal(e.cov().failed, 0);
    e.life.disposeAll();
  } finally { off(); }
});
