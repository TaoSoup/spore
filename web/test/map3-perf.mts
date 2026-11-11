// map3 performance (map3 spec 13.5) on the M4's GPU (Chrome with --use-angle=metal), against a production
// build behind test/serve-prod.mts with the live upstream (real SSE, real heat). Gates, all on the M4:
//   - measure(3000, idle | pan | zoom | hover) (the engine forces a render every frame) at the overview
//     (1440×900), at $PUMP 4× (zoomTo(PUMP top, 4)) and on the phone (390×844, DPR 2, touch): p95 ≤ 17.5 ms;
//   - natural rAF intervals during a real 40-notch wheel zoom and a real drag-pan: p95 ≤ 17.5, max ≤ 50,
//     0 long tasks; during 60 s of live SSE idle at the overview: p95 ≤ 17.5, max ≤ 50 (long tasks reported);
//   - dragCoin at the overview and at $PUMP 4×: held p95 ≤ 17.5, coinsOffHome 0;
//   - first paint (firstPaintAt − mountedAt): cold reported; warm (SPA reopen and full reload) ≤ 1500 ms;
//     lastBuild().buildMs reported;
//   - idle renders over 10 s with no events (mocked stream), counted after the logo queue drains: while someone uses
//     the map the live coins breathe (the prototype's 15/s; reported, sanity bound ≤ 160); 30 s after the last input
//     the breathing sleeps (final fix, bubbles.js BREATH_SLEEP_MS) and the spec's gate applies: ≤ 25 per 10 s (the
//     motion loop's 2 Hz); 0 under --force-prefers-reduced-motion; the live-stream renders are reported;
//   - the quality governor (motion.js) never steps down on the M4 (motion().quality.steps empty everywhere);
//   - frame intervals come from rAF timestamps (test/map3-cdp.mts RAF_PROBE; the callback-time p95 is reported);
//   - heap growth over the 60 s live idle ≤ 5 MB after GC.
//
//   node --import tsx test/map3-perf.mts --url http://127.0.0.1:5260 --prod --out <dir> [--live-s 60]
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOK, MOCK_ES, RAF_PROBE, SETTLED_JS, cli, launchChrome, mapReadyJs, rafStatsJs, sleep, withDebug, withLast, type Browser, type GpuMode, type Page, type RafStats } from "./map3-cdp.mts";

const { opt, has } = cli();
const BASE = opt("--url", "http://127.0.0.1:5260")!.replace(/\/$/, "");
const PROD = has("--prod");
const OUT = opt("--out", join(process.env.SPORE_TMP ?? tmpdir(), "spore-map3-perf"))!;
const GPU = (opt("--chrome-gpu", "metal") ?? "metal") as GpuMode;
const LIVE_S = Number(opt("--live-s", "60"));
const W = 1440, H = 900;
// galaxy spec §8 G-C: measure() p95 ≤ 16.8 ms (both looks), drag-pan / dragCoin held p95 ≤ 17.5; idle renders awake
// ≤ 330 per 10 s under galaxy (its 30 Hz frame hook), ≤ 160 under flat; asleep ≤ 25; reduced motion 0; heap ≤ 5 MB.
const GALAXY = LOOK === "galaxy";   // no --look: the app default, which is flat since 2026-10-21 (galaxy only via --look galaxy)
const BUDGET = { p95: 17.5, measureP95: 16.8, max: 50, warmFirstPaintMs: 1500, idleRenders10s: 25, awakeRenders10s: GALAXY ? 330 : 160, heapGrowthMB: 5 };
const quality = (p: Page) => p.evalJs<{ dpr: number; dprCap: number; bloom: boolean; p80: number; steps: unknown[] } | null>("(__sporeMap.motion() || {}).quality || null");
const qualities: Record<string, unknown> = {};
const noStep = async (p: Page, where: string) => { const q = await quality(p); qualities[where] = q; check(!!q && q.steps.length === 0, `the quality governor stepped down on the M4 (${where}): ${J(q)}`); };
/// Waits until the app's image loader is idle (queue and in-flight 0); the engine uploads a logo within ~300 ms.
const logosDrained = (p: Page) => p.waitFor("(() => { const i = __sporeMap.images(); return !!i && i.queued === 0 && i.inflight === 0; })()", 45_000, "the logo queue to drain").then(() => true, () => false);
mkdirSync(OUT, { recursive: true });
const J = JSON.stringify;
const u = (path: string) => withDebug(path, PROD);
const result: Record<string, unknown> = { url: BASE, prod: PROD, gpu: GPU, look: LOOK || null, budget: BUDGET, startedAt: new Date().toISOString() };
const fails: string[] = [];
const check = (c: boolean, m: string) => { if (!c) fails.push(m); return c; };
const pages: Page[] = [];
const browsers: Browser[] = [];
type Measure = { mode: string; frames: number; renders: number; fps: number; p50: number; p95: number; max: number };

async function openMap(p: Page, path = "/map", timeoutMs = 120_000) {
  await p.navigate(BASE + u(path), 60_000);
  await p.waitFor(mapReadyJs("three"), timeoutMs, `three map on ${path}`);
}
const settle = async (p: Page, ms = 30_000) => { await p.waitFor(SETTLED_JS, ms, "settle").catch(() => null); await sleep(400); };
/// (an SPA navigation does not go through page.navigate: it carries last=all itself, so the whole map is measured)
const spa = (p: Page, path: string) => p.evalJs(`(history.pushState({}, "", ${J(withLast(u(path)))}), dispatchEvent(new PopStateEvent("popstate")), true)`);
async function measureAll(p: Page, label: string) {
  const out: Record<string, Measure | null> = {};
  for (const mode of ["idle", "pan", "zoom", "hover"] as const) {
    const m = await p.evalJs<Measure | null>(`__sporeMap.measure(3000, ${J(mode)})`, 20_000);
    out[mode] = m;
    check(!!m && m.p95 <= BUDGET.measureP95, `${label} measure(${mode}): p95 ${m?.p95} ms (≤ ${BUDGET.measureP95})`);
    await sleep(300);
  }
  return out;
}
const pumpTop = (p: Page) => p.evalJs<string | null>(`(() => { const M = __sporeMap; for (const c of M.clusters(200)) { const n = M.node(c.root); if (n && n.symbol === "PUMP") return c.root; } return null; })()`);
const rafBegin = (p: Page) => p.evalJs<number>("performance.now()");
const rafEnd = (p: Page, t0: number) => p.evalJs<RafStats>(rafStatsJs(t0));
const fit = async (p: Page) => { await p.evalJs("__sporeMap.fit()"); await sleep(200); await settle(p); };

try {
  const browser = await launchChrome({ gpu: GPU, width: W, height: H });
  browsers.push(browser);
  // live page: the real stream through serve-prod (no mock), frame probe installed before the app
  const page = await browser.newPage({ prelude: [RAF_PROBE] });
  pages.push(page);

  // ---- cold open (fresh profile: no cache, no chunk in the HTTP cache)
  await openMap(page, "/map");
  const cold = await page.evalJs<{ fp: number; mounted: number; data: number; build: Record<string, unknown> | null; engine: Record<string, unknown> | null }>("({ fp: __sporeMap.firstPaintAt(), mounted: __sporeMap.mountedAt(), data: __sporeMap.dataAt(), build: __sporeMap.lastBuild(), engine: __sporeMap.engine() })");
  result.cold = { firstPaintFromMountMs: Math.round(cold.fp - cold.mounted), firstPaintFromDataMs: Math.round(cold.fp - cold.data), firstPaintFromNavMs: Math.round(cold.fp), lastBuild: cold.build };
  result.engine = cold.engine;
  await settle(page);

  // ---- measure() at the overview
  await fit(page);
  result.overview = await measureAll(page, "overview");

  // ---- $PUMP 4×
  const pump = await pumpTop(page);
  result.pumpTop = pump;
  if (check(!!pump, "no $PUMP family on the map")) {
    await page.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
    await sleep(500); await settle(page);
    result.pump4x = { k: await page.evalJs<number>("__sporeMap.zoom()"), ...(await measureAll(page, "$PUMP 4×")) };
  }

  // ---- a real 40-notch wheel zoom into the biggest family, then a real drag-pan
  await fit(page);
  const at = await page.evalJs<{ x: number; y: number } | null>(`(() => { const c = __sporeMap.clusters(1)[0]; return c ? __sporeMap.familyScreen(c.root) : null; })()`);
  if (check(!!at, "no family to wheel into")) {
    const t0 = await rafBegin(page);
    for (let q = 0; q < 40; q++) { await page.wheel(at!.x, at!.y, -120); await sleep(30); }
    await sleep(400);
    const g = await rafEnd(page, t0);
    result.wheel = { at, k: await page.evalJs<number>("__sporeMap.zoom()"), frames: g };
    check(g.p95 <= BUDGET.p95 && g.max <= BUDGET.max && g.longTasks === 0, `wheel zoom: p95 ${g.p95}, max ${g.max} ms, ${g.longTasks} long task(s) (≤ ${BUDGET.p95} / ≤ ${BUDGET.max} / 0)`);
  }
  await fit(page);
  const empty = await page.evalJs<{ x: number; y: number } | null>(`(() => { const M = __sporeMap; const root = document.querySelector(".bm.m3").getBoundingClientRect(); for (let y = root.top + 200; y < root.bottom - 120; y += 17) for (let x = root.left + 420; x < root.right - 420; x += 17) { const el = document.elementFromPoint(x, y); if (el && el.classList.contains("m3-canvas") && M.pick(x, y).via === "none") return { x, y }; } return null; })()`);
  if (check(!!empty, "no empty point to pan from")) {
    const t0 = await rafBegin(page);
    await page.mouse("mouseMoved", empty!.x, empty!.y);
    await page.mouse("mousePressed", empty!.x, empty!.y);
    for (let i = 1; i <= 30; i++) { await page.mouse("mouseMoved", empty!.x - 10 * i, empty!.y - 4 * i, { button: "left", buttons: 1 }); await sleep(16); }
    await page.mouse("mouseReleased", empty!.x - 300, empty!.y - 120);
    await sleep(900); // inertia
    const g = await rafEnd(page, t0);
    result.dragPan = { from: empty, frames: g };
    check(g.p95 <= BUDGET.p95 && g.max <= BUDGET.max && g.longTasks === 0, `drag-pan: p95 ${g.p95}, max ${g.max} ms, ${g.longTasks} long task(s)`);
    await page.mouse("mouseMoved", 3, 3);
  }

  // ---- dragCoin at the overview and at $PUMP 4×
  await fit(page);
  if (pump) {
    const d0 = await page.evalJs<Record<string, any> | null>(`__sporeMap.dragCoin(${J(pump)})`, 30_000); // eslint-disable-line @typescript-eslint/no-explicit-any
    result.dragOverview = d0;
    // galaxy: the rope keeps the drop (owner list item 6), so the gate is neighbours untouched, not coinsOffHome 0
    check(!!d0 && d0.held?.p95 <= BUDGET.p95 && (GALAXY ? d0.neighbourMaxPx === 0 : d0.coinsOffHome === 0), `dragCoin($PUMP) at the overview: held p95 ${d0?.held?.p95}, coinsOffHome ${d0?.coinsOffHome}, neighbourMaxPx ${d0?.neighbourMaxPx}`);
    await settle(page);
    await page.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
    await sleep(500); await settle(page);
    const child = await page.evalJs<string | null>(`(() => { const M = __sporeMap; const kids = M.children(${J(pump)}).map((m) => ({ m, s: M.screenOf(m) })).filter((k) => k.s && k.s.r >= 4 && k.s.x > 200 && k.s.x < innerWidth - 400 && k.s.y > 150 && k.s.y < innerHeight - 150).sort((a, b) => b.s.r - a.s.r); return kids[0] ? kids[0].m : null; })()`);
    if (check(!!child, "no $PUMP child on screen at 4×")) {
      const d1 = await page.evalJs<Record<string, any> | null>(`__sporeMap.dragCoin(${J(child)})`, 30_000); // eslint-disable-line @typescript-eslint/no-explicit-any
      result.dragPump4x = d1;
      check(!!d1 && d1.held?.p95 <= BUDGET.p95 && (GALAXY ? d1.neighbourMaxPx === 0 : d1.coinsOffHome === 0), `dragCoin(child) at $PUMP 4×: held p95 ${d1?.held?.p95}, coinsOffHome ${d1?.coinsOffHome}, neighbourMaxPx ${d1?.neighbourMaxPx}`);
    }
  }

  // ---- 60 s of the live stream at the overview: frame intervals, renders, heap
  await fit(page);
  const ev0 = await page.evalJs<Record<string, number> | null>("__sporeMap.live()");
  const h0 = await page.heapMB();
  const r0 = await page.evalJs<number>("__sporeMap.motion().renders");
  const t0 = await rafBegin(page);
  await sleep(10_000);
  const r10 = await page.evalJs<number>("__sporeMap.motion().renders");
  await sleep(Math.max(0, LIVE_S * 1000 - 20_000));
  const r50 = await page.evalJs<number>("__sporeMap.motion().renders");
  await sleep(10_000);
  const r60 = await page.evalJs<number>("__sporeMap.motion().renders");
  const live = await rafEnd(page, t0);
  const h1 = await page.heapMB();
  const ev1 = await page.evalJs<Record<string, number> | null>("__sporeMap.live()");
  result.liveIdle = { seconds: LIVE_S, frames: live, rendersFirst10s: r10 - r0, rendersLast10s: r60 - r50, breathingAtEnd: await page.evalJs("__sporeMap.motion().breathing"), events: (ev1?.events ?? 0) - (ev0?.events ?? 0), trades: (ev1?.trades ?? 0) - (ev0?.trades ?? 0), feed: ev1?.feed, heapMB: { before: h0, after: h1, growth: Math.round((h1 - h0) * 100) / 100 } };
  check(live.p95 <= BUDGET.p95 && live.max <= BUDGET.max, `live idle ${LIVE_S} s: p95 ${live.p95}, max ${live.max} ms (≤ ${BUDGET.p95} / ≤ ${BUDGET.max})`);
  check(h1 - h0 <= BUDGET.heapGrowthMB, `heap grew ${(h1 - h0).toFixed(2)} MB over ${LIVE_S} s live (≤ ${BUDGET.heapGrowthMB})`);
  if ((ev1?.events ?? 0) - (ev0?.events ?? 0) === 0) result.liveNote = "no SSE event reached the engine during the live window (check serve-prod's upstream stream)";
  await page.shot(join(OUT, "perf-live-overview.png"));

  // ---- warm first paint: SPA away and back, then a full reload
  await spa(page, "/");
  await page.waitFor("!window.__sporeMap", 6000, "unmount").catch(() => null);
  await sleep(1500);
  await spa(page, "/map");
  await page.waitFor(mapReadyJs("three"), 60_000, "warm SPA first paint");
  const warmSpa = await page.evalJs<{ fp: number; mounted: number; data: number; source: string | null }>("({ fp: __sporeMap.firstPaintAt(), mounted: __sporeMap.mountedAt(), data: __sporeMap.dataAt(), source: __sporeMapPage.source() })");
  await settle(page);
  await page.reload();
  await page.waitFor(mapReadyJs("three"), 60_000, "warm reload first paint");
  const warmReload = await page.evalJs<{ fp: number; mounted: number; data: number; source: string | null }>("({ fp: __sporeMap.firstPaintAt(), mounted: __sporeMap.mountedAt(), data: __sporeMap.dataAt(), source: __sporeMapPage.source() })");
  result.warm = {
    spa: { firstPaintFromMountMs: Math.round(warmSpa.fp - warmSpa.mounted), firstPaintFromDataMs: Math.round(warmSpa.fp - warmSpa.data), source: warmSpa.source },
    reload: { firstPaintFromMountMs: Math.round(warmReload.fp - warmReload.mounted), firstPaintFromDataMs: Math.round(warmReload.fp - warmReload.data), firstPaintFromNavMs: Math.round(warmReload.fp), source: warmReload.source },
    lastBuild: await page.evalJs("__sporeMap.lastBuild()"),
  };
  check(warmSpa.fp - warmSpa.mounted <= BUDGET.warmFirstPaintMs, `warm (SPA) first paint ${Math.round(warmSpa.fp - warmSpa.mounted)} ms after mount (≤ ${BUDGET.warmFirstPaintMs})`);
  check(warmReload.fp - warmReload.mounted <= BUDGET.warmFirstPaintMs, `warm (reload) first paint ${Math.round(warmReload.fp - warmReload.mounted)} ms after mount (≤ ${BUDGET.warmFirstPaintMs})`);

  await noStep(page, "desktop after the gestures and 60 s live");
  // ---- idle renders with no events (mocked stream), counted once the logos have arrived (each logo is one upload
  // render). Awake (someone just used the map): the live coins breathe, the prototype's 15/s (reported, ≤ 160).
  // Asleep (30 s after the last input, bubbles.js BREATH_SLEEP_MS): the spec's gate, ≤ 25 per 10 s.
  const quiet = await browser.newPage({ prelude: [MOCK_ES, RAF_PROBE] });
  pages.push(quiet);
  await openMap(quiet, "/map");
  await settle(quiet); await logosDrained(quiet); await sleep(1500);
  // the start-up pulses (every coin that traded in the minute before the load pulses once within ~8 s of the first
  // frame, the prototype's "load" pulses) are events, not idle: wait them out
  const loadPulses = await quiet.waitFor("(() => { const l = __sporeMap.live(); return !!l && l.queued === 0 && l.inFlight === 0 && performance.now() - __sporeMap.firstPaintAt() > 9000; })()", 30_000, "the load pulses").then(() => true, () => false);
  await quiet.evalJs("__sporeMap.fit()");   // a camera call is input: the breathing is awake for the next 30 s
  await sleep(800);
  result.pageLook = await quiet.evalJs("typeof __sporeMap.look === 'function' ? __sporeMap.look() : null").catch(() => null);
  if (GALAXY) check(result.pageLook === "galaxy", `--look galaxy but __sporeMap.look() is ${J(result.pageLook)}`);
  const q0 = await quiet.evalJs<{ r: number; why: unknown; breathing: unknown }>("({ r: __sporeMap.motion().renders, why: __sporeMap.motion().why, breathing: __sporeMap.motion().breathing })");
  await sleep(10_000);
  const q1 = await quiet.evalJs<{ r: number; why: unknown }>("({ r: __sporeMap.motion().renders, why: __sporeMap.motion().why })");
  const slept = await quiet.waitFor("(() => { const b = __sporeMap.motion().breathing; return !!b && b.asleep && b.on === 0; })()", 45_000, "the breathing to sleep").then(() => true, () => false);
  await sleep(1000);
  // a heat poll that lands in the window crossfades the classes it changed (events): such a window is measured again
  type Snap = { r: number; why: unknown; breathing: unknown; heatAt: number };
  const snapJs = "({ r: __sporeMap.motion().renders, why: __sporeMap.motion().why, breathing: __sporeMap.motion().breathing, heatAt: (__sporeMap.sync() || {}).heatAt || 0 })";
  let s0 = await quiet.evalJs<Snap>(snapJs), s1 = s0, heatPolls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    s0 = await quiet.evalJs<Snap>(snapJs);
    await sleep(10_000);
    s1 = await quiet.evalJs<Snap>(snapJs);
    if (s1.heatAt === s0.heatAt || s1.r - s0.r <= BUDGET.idleRenders10s) break;
    heatPolls++;
  }
  // and the next input wakes it
  await quiet.mouse("mouseMoved", 700, 500); await sleep(50); await quiet.mouse("mouseMoved", 702, 503);
  const woke = await quiet.waitFor("(() => { const b = __sporeMap.motion().breathing; return !!b && !b.asleep && b.on > 0; })()", 3000, "the breathing to wake").then(() => true, () => false);
  result.idleRenders10s = { galHz: await quiet.evalJs("(() => { const m = __sporeMap.motion(); return m && m.galHz !== undefined ? m.galHz : null; })()").catch(() => null), awake: { renders: q1.r - q0.r, breathing: q0.breathing, whyBefore: q0.why, whyAfter: q1.why }, asleep: { slept, renders: s1.r - s0.r, heatPollsRetried: heatPolls, breathing: s0.breathing, whyBefore: s0.why, whyAfter: s1.why }, loadPulsesDone: loadPulses, wokeOnPointer: woke };
  check(q1.r - q0.r <= BUDGET.awakeRenders10s, `idle renders over 10 s with no events, awake: ${q1.r - q0.r} (≤ ${BUDGET.awakeRenders10s})`);
  check(slept, "the breathing did not fall asleep within 45 s of the last input");
  check(s1.r - s0.r <= BUDGET.idleRenders10s, `idle renders over 10 s with no events, asleep: ${s1.r - s0.r} (≤ ${BUDGET.idleRenders10s})`);
  check(woke, "a pointer move did not wake the breathing");
  await quiet.close();

  // ---- phone 390×844 DPR 2
  const phone = await browser.newPage({ width: 390, height: 844, dpr: 2, mobile: true, touch: true, prelude: [RAF_PROBE] });
  pages.push(phone);
  await openMap(phone, "/map");
  await settle(phone);
  result.phone = { engine: await phone.evalJs("__sporeMap.engine()"), ...(await measureAll(phone, "phone 390×844")) };
  await noStep(phone, "phone 390×844 DPR 2");
  await phone.shot(join(OUT, "perf-phone.png"));
  await phone.close();

  // ---- reduced motion: 0 renders over 10 s idle
  const b2 = await launchChrome({ gpu: GPU, width: W, height: H, reducedMotion: true });
  browsers.push(b2);
  const rm = await b2.newPage({ prelude: [MOCK_ES] });
  pages.push(rm);
  await openMap(rm, "/map");
  await settle(rm); await logosDrained(rm); await sleep(1500);
  const m0 = await rm.evalJs<{ r: number; reduced: boolean; heatAt: number }>("({ r: __sporeMap.motion().renders, reduced: __sporeMap.motion().reduced, heatAt: (__sporeMap.sync() || {}).heatAt || 0 })");
  await sleep(10_000);
  const m1 = await rm.evalJs<{ r: number; reduced: boolean; heatAt: number }>("({ r: __sporeMap.motion().renders, reduced: __sporeMap.motion().reduced, heatAt: (__sporeMap.sync() || {}).heatAt || 0 })");
  result.reducedMotion = { reduced: m1.reduced, renders10s: m1.r - m0.r, heatPollInWindow: m1.heatAt !== m0.heatAt };
  check(m1.reduced && (m1.r - m0.r === 0 || m1.heatAt !== m0.heatAt), `reduced motion: ${m1.r - m0.r} renders over 10 s idle (reduced ${m1.reduced})`);
} catch (e) {
  fails.push(`crashed: ${(e as Error).message}`);
} finally {
  result.quality = qualities;
  result.consoleErrors = pages.flatMap((p) => p.errors);
  result.networkErrors = pages.flatMap((p) => p.netErrors).slice(0, 30);
  if ((result.consoleErrors as string[]).length) fails.push(`${(result.consoleErrors as string[]).length} console error(s): ${(result.consoleErrors as string[]).slice(0, 3).join(" | ")}`);
  result.failures = fails;
  result.ok = fails.length === 0;
  const text = JSON.stringify(result, null, 2);
  try { writeFileSync(join(OUT, "map3-perf.json"), text); } catch { /* optional */ }
  console.log(text);
  for (const b of browsers) await b.close();
}
process.exit(fails.length ? 1 : 0);
