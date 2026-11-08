// map3 (2026-10-21): /map now renders the Three.js map by default; this script measures the classic
// Canvas renderer, so every /map URL it loads carries renderer=classic (Chrome keeps --disable-gpu, which
// would also force the classic fallback). The WebGL renderer has its own scripts: map3-qa/perf/shots.
// Headless measurement of the /map page (DESIGN §11.5 budgets) through Chrome's DevTools protocol, no
// puppeteer (same pattern as tools/shot.mjs). It loads the map on a dev server, waits for the first
// bubbles and for the layout to settle, samples frame times in both phases, injects one synthetic
// `pair` event through a mocked EventSource, checks labels were drawn, reopens the page (SPA navigation
// and a full reload) to time the warm cache, screenshots 1440 and 390 wide, and fails on any console or
// CSP error. `--prod <url>` instead loads a production build (no mock) and only checks errors + worker.
//
// Frame budget (2026-10-20): the page's own draw() timing sees only the rAF callback; under software
// raster the canvas is rasterised during the commit after it, which is where most of a frame goes. So
// every interactive phase also records the interval between consecutive animation frames (a rAF loop
// installed before the page) and the long tasks (PerformanceObserver): the budget is "no long task and
// no frame over 50 ms" during a gesture, a flight or a trade burst, with draw() ms kept as a secondary
// number. The static map must not draw at all (dirty-flag rendering): idle draws stay under 35/s, and
// nothing moves after the layout settles (a synthetic pair moves nobody but itself).
//
// Map v2 phases (renderer): cluster titles at fit (1440 and 390), Spore beacons at fit, retained heap
// growth over 10 s idle, a 40-notch wheel gesture into the largest cluster, a 300-trade burst through
// the EventSource mock (half of them routed child → parent buys), the 'min1k' and 'ours' highlights,
// and a camera flight to a far coin sampled every animation frame. Screenshots at k = 0.15/0.6/1.5/3.
//
// Live-simulation drag (owner 2026-10-20 "the map as it was when we first opened the site";
// test/map-drag.mts): at fit a family pressed on its hull (its root is grabbed), then a mid-size family's
// root zoomed in, and on the phone a root dragged by touch, each pulled 300 px: the grabbed bubble stays
// under the pointer, the worker ticks during the drag, ≥ 10 bubbles outside the family flow > 2 px, the
// zoomed root's children trail and it glides back ≥ 20 px after the release (part of the way home, as
// in the first launch: its own children trail and hold it), ending inside its family;
// the map rests ≤ 3 s after the release and nothing moves for 3 s afterwards; the frame budget holds
// during the drag (no long task, no frame over 50 ms). A 100 ms frame sequence of a drag + release is
// written to <shots>/drag-seq.
//
//   node --import tsx test/map-perf.mts [--url http://127.0.0.1:5231] [--stress 20000] [--roots all] [--shots DIR]
//   node --import tsx test/map-perf.mts --prod http://127.0.0.1:8793
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveDrag, type DragIO } from "./map-drag.mts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string | null = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const BASE = opt("--url", "http://127.0.0.1:5231")!;
const PROD = opt("--prod");
const STRESS = Number(opt("--stress", "0"));
const ROOTS = opt("--roots", "all")!;
const SHOTS = opt("--shots", process.env.SHOT_DIR ?? join(process.env.SPORE_TMP ?? tmpdir(), "spore-map-shots"))!;
const BUDGET = { settled: 16, settling: 33, firstPaintCold: 2000, firstPaintWarm: 500, gestureP95: 16, gestureMax: 33, flightMs: 1900, flightKRatio: 1.15, heapGrowthMB: 2, rafMax: 50, idleDrawsPerSec: 35 };
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1440, H = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.SPORE_TMP ?? tmpdir(), "spore-perf-"));
mkdirSync(SHOTS, { recursive: true });
// --disable-gpu = software rasterisation for the canvas, which is the budget's stated condition.
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--disable-extensions", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };
const errors: string[] = [];
const netErrors: string[] = [];
const result: Record<string, unknown> = { url: PROD ?? BASE, stress: STRESS, roots: ROOTS };
const fails: string[] = [];
const check = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };

const MOCK_ES = `(() => {
  const list = []; window.__es = list;
  class MockES {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; this.onopen = null; this.onerror = null; this.onmessage = null; list.push(this); setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; if (this.onopen) this.onopen(new Event("open")); }, 0); }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((g) => g !== f); }
    close() { this.readyState = 2; }
    dispatch(t, data) { for (const f of this.listeners[t] || []) f(new MessageEvent(t, { data })); }
  }
  MockES.CONNECTING = 0; MockES.OPEN = 1; MockES.CLOSED = 2;
  window.EventSource = MockES;
  // every animation frame's timestamp and every long task, read per phase by rafPhase()
  const R = window.__raf = { t: new Float64Array(200000), n: 0, lt: [] };
  const loop = () => { if (R.n < R.t.length) R.t[R.n++] = performance.now(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) R.lt.push({ s: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
})();`;

try {
  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!version) throw new Error("chrome did not start");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });
  let id = 0; const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Msg;
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id)!; pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") { const p = m.params as { type: string; args: { value?: unknown; description?: string }[] }; if (p.type === "error") errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`); }
    if (m.method === "Runtime.exceptionThrown") { const p = m.params as { exceptionDetails: { text: string; exception?: { description?: string } } }; errors.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`); }
    if (m.method === "Log.entryAdded") { const p = m.params as { entry: { level: string; source: string; text: string; url?: string } }; if (p.entry.level === "error") { if (p.entry.source === "network") netErrors.push(`${p.entry.text} ${p.entry.url ?? ""}`); else errors.push(`${p.entry.source}: ${p.entry.text}`); } }
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<unknown>((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  const S = sessionId;
  await send("Page.enable", {}, S); await send("Runtime.enable", {}, S); await send("Log.enable", {}, S);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, S);
  if (!PROD) await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK_ES }, S);
  const evalJs = async <T,>(expression: string): Promise<T> => { const r = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, S)) as { result: { value: T }; exceptionDetails?: { text: string } }; if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} :: ${expression.slice(0, 80)}`); return r.result.value; };
  const waitFor = async (expression: string, timeoutMs: number, what: string) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { let v: unknown = null; try { v = await evalJs(expression); } catch { /* page still loading */ } if (v) return v; await sleep(100); } throw new Error(`timeout waiting for ${what}`); };
  const shot = async (name: string) => { const r = (await send("Page.captureScreenshot", { format: "png" }, S)) as { data: string }; const file = join(SHOTS, name); writeFileSync(file, Buffer.from(r.data, "base64")); return file; };
  type RafPhase = { t0: number; draws0: number };
  type RafStats = { durMs: number; frames: number; fps: number; p50: number; p95: number; max: number; over34: number; longTasks: number; longTaskMaxMs: number; draws: number; drawsPerSec: number };
  /// Marks the start of a measured phase (animation-frame intervals, long tasks, draws).
  const rafBegin = () => evalJs<RafPhase>("({ t0: performance.now(), draws0: __sporeMap.draws() })");
  const rafEnd = (ph: RafPhase) => evalJs<RafStats>(`(() => {
    const R = window.__raf, t0 = ${ph.t0}, t1 = performance.now();
    const iv = []; let last = -1; for (let i = 0; i < R.n; i++) { const t = R.t[i]; if (t < t0 || t > t1) continue; if (last >= 0) iv.push(t - last); last = t; }
    iv.sort((a, b) => a - b);
    const p = (q) => iv.length ? Math.round(iv[Math.min(iv.length - 1, Math.floor(iv.length * q))] * 10) / 10 : 0;
    const lt = R.lt.filter((e) => e.s >= t0 && e.s <= t1);
    const draws = __sporeMap.draws() - ${ph.draws0}, dur = t1 - t0;
    return { durMs: Math.round(dur), frames: iv.length, fps: iv.length ? Math.round(1000 / (iv.reduce((s, v) => s + v, 0) / iv.length)) : 0, p50: p(0.5), p95: p(0.95), max: p(1), over34: iv.filter((v) => v > 34).length, longTasks: lt.length, longTaskMaxMs: lt.length ? Math.round(Math.max(...lt.map((e) => e.d))) : 0, draws, drawsPerSec: Math.round(draws / (dur / 1000) * 10) / 10 };
  })()`);

  if (PROD) {
    await send("Page.navigate", { url: `${PROD.replace(/\/$/, "")}/map?renderer=classic` }, S);
    await sleep(8000);
    const info = await evalJs<{ title: string; worker: number; canvas: boolean; assets: number }>(`JSON.stringify({ title: document.title, worker: performance.getEntriesByType("resource").filter((e) => /layout\\.worker/.test(e.name)).length, canvas: !!document.querySelector(".bm-canvas"), assets: performance.getEntriesByType("resource").length })`).then((s) => JSON.parse(s as unknown as string));
    result.prod = info;
    check(info.canvas, "production map did not render a canvas");
    check(info.worker >= 1, "production build did not load the layout worker (CSP worker-src?)");
    result.shot = await shot("map-prod-1440.png");
  } else {
    const url = `${BASE}/map?roots=${ROOTS}&renderer=classic${STRESS ? `&stress=${STRESS}` : ""}`;
    // ---- cold open (fresh profile = empty IndexedDB)
    await send("Page.navigate", { url }, S);
    await waitFor("!!(window.__sporeMap && window.__sporeMap.firstPaintAt() > 0)", 120_000, "first paint");
    const cold = await evalJs<{ fp: number; data: number; nodes: number; mounted: number }>(`({ fp: __sporeMap.firstPaintAt(), data: __sporeMap.dataAt(), nodes: __sporeMap.nodes(), mounted: __sporeMapPage.mountedAt })`);
    result.nodesTested = cold.nodes;
    result.firstPaintColdMs = Math.round(cold.fp - cold.data);
    result.firstPaintColdFromNavMs = Math.round(cold.fp);
    check(cold.fp - cold.data <= BUDGET.firstPaintCold, `cold first paint ${Math.round(cold.fp - cold.data)} ms > ${BUDGET.firstPaintCold}`);
    await waitFor("__sporeMap.settled()", 180_000, "layout to settle");
    const settling = await evalJs<{ settling: { n: number; avg: number; p95: number; max: number } }>("__sporeMap.frameStats()");
    result.frameMsSettling = Math.round(settling.settling.avg * 100) / 100;
    result.settling = settling.settling;
    await evalJs("__sporeMap.resetFrames()");
    // idle: a static map draws nothing (ambient dots/beacons at most ~30/s), and nothing moves
    const idleSample = await evalJs<[string, number, number][]>("(() => { const out = []; for (const c of __sporeMap.clusters(60)) for (const m of __sporeMap.members(c.root).slice(0, 10)) { const n = __sporeMap.node(m); out.push([m, n.x, n.y]); } return out; })()");
    const idlePh = await rafBegin();
    await sleep(3000);
    const idle = await rafEnd(idlePh);
    const idleMoved = await evalJs<number>(`(${JSON.stringify(idleSample)}).filter(([m, x, y]) => { const n = __sporeMap.node(m); return n && Math.hypot(n.x - x, n.y - y) > 0.5; }).length`);
    result.idle = { ...idle, sampled: idleSample.length, moved: idleMoved };
    check(idle.drawsPerSec <= BUDGET.idleDrawsPerSec, `idle: ${idle.drawsPerSec} draws/s on a static map (budget ${BUDGET.idleDrawsPerSec})`);
    check(idleMoved === 0, `idle: ${idleMoved} of ${idleSample.length} sampled bubbles moved on a settled map`);
    const fs = await evalJs<{ settled: { n: number; avg: number; p95: number; max: number }; labels: number; drawn: number }>("__sporeMap.frameStats()");
    result.frameMsSettled = Math.round(fs.settled.avg * 100) / 100;
    result.settled = fs.settled;
    result.labels = fs.labels; result.drawn = fs.drawn;
    result.images = await evalJs("__sporeMap.images()");
    check(settling.settling.avg <= BUDGET.settling, `settling avg ${settling.settling.avg.toFixed(1)} ms > ${BUDGET.settling}`);
    check(fs.settled.n === 0 || fs.settled.avg <= BUDGET.settled, `settled avg ${fs.settled.avg.toFixed(1)} ms > ${BUDGET.settled}`);
    check(fs.settled.n === 0 || fs.settled.p95 <= BUDGET.settled * 1.5, `settled p95 ${fs.settled.p95.toFixed(1)} ms > ${BUDGET.settled * 1.5}`);
    result.shot1440 = await shot(`map-1440${STRESS ? `-stress${STRESS}` : ""}.png`);
    if (!STRESS) await v2Phases();
    // labels: every bubble ≥ 9 px gets one, so zoom into the biggest root and count them there; logos load lazily there too
    const bigRoot = await evalJs<string | null>("__sporeMap.anyRoot()");
    await evalJs(`__sporeMap.zoomTo(${JSON.stringify(bigRoot)}, 1.4)`);
    await sleep(2500);
    const zoomed = await evalJs<{ labels: number; drawn: number; k: number; images: { ready: number; failed: number; inflight: number; queued: number } }>("({ labels: __sporeMap.labels(), drawn: __sporeMap.drawn(), k: __sporeMap.zoom(), images: __sporeMap.images() })");
    result.zoomed = zoomed;
    check(zoomed.labels > 0, "no labels drawn when zoomed into a root");
    result.shot1440zoom = await shot(`map-1440-zoom${STRESS ? `-stress${STRESS}` : ""}.png`);
    await evalJs("__sporeMap.fit()");
    await sleep(900);
    // ---- one synthetic pair through the EventSource mock: the child must appear under an existing root
    const root = await evalJs<string | null>("__sporeMap.anyRoot()");
    check(!!root, "no root to hang a synthetic pair under");
    if (root) {
      const mint = "PERFTESTpair" + Date.now().toString(36).padEnd(32, "x");
      const before = await evalJs<number>("__sporeMap.nodes()");
      // positions just before the insert (the drag phase above moves bubbles on purpose)
      const pairSample = await evalJs<[string, number, number][]>(`(${JSON.stringify(idleSample.map((e) => e[0]))}).map((m) => { const n = __sporeMap.node(m); return [m, n ? n.x : NaN, n ? n.y : NaN]; })`);
      await evalJs(`(() => { const es = window.__es && window.__es[0]; if (!es) return false; es.dispatch("pair", JSON.stringify({ coin: { mint: ${JSON.stringify(mint)}, name: "Perf Test Pair", symbol: "PERF", image: null, depth: 1, mcapUsd: 1200, lockedUsd: null, children: 0, descendants: 0, migrated: false, createdAt: ${Math.floor(Date.now() / 1000)}, parentMint: ${JSON.stringify(root)} }, parent: { mint: ${JSON.stringify(root)}, name: "root", symbol: "ROOT", image: null, depth: 0, mcapUsd: null, lockedUsd: null, children: 1, descendants: 1, migrated: false, createdAt: null } })); return true; })()`);
      const seen = await waitFor(`__sporeMap.has(${JSON.stringify(mint)})`, 5000, "synthetic pair to appear").catch(() => false);
      const after = await evalJs<number>("__sporeMap.nodes()");
      await sleep(600);
      // placed next to its parent by the deterministic rule, with no settle and nothing else moving
      const placed = await evalJs<{ d: number; need: number; settled: boolean; dataMs: { last: number; max: number } } | null>(`(() => { const n = __sporeMap.node(${JSON.stringify(mint)}); if (!n) return null; const p = __sporeMap.node(n.parentMint); return { d: Math.hypot(n.x - p.x, n.y - p.y), need: n.r + p.r, settled: __sporeMap.settled(), dataMs: __sporeMap.dataMs() }; })()`);
      const pairMoved = await evalJs<number>(`(${JSON.stringify(pairSample)}).filter(([m, x, y]) => { const n = __sporeMap.node(m); return n && Math.hypot(n.x - x, n.y - y) > 0.5; }).length`);
      result.pair = { before, after, seen: !!seen, esInstances: await evalJs<number>("window.__es ? window.__es.length : 0"), placed, othersMoved: pairMoved };
      // under ?stress=N the replicator pins the total at N, so only the insert itself is asserted there
      check(!!seen && (STRESS ? true : after === before + 1), `synthetic pair not inserted (before ${before}, after ${after})`);
      check(!!placed && placed.settled, "the pair insert re-heated the layout");
      check(!!placed && placed.d >= placed.need - 0.01, `the pair overlaps its parent (${placed?.d.toFixed(1)} < ${placed?.need.toFixed(1)})`);
      check(pairMoved === 0, `the pair insert moved ${pairMoved} other sampled bubbles`);
    }
    // ---- warm reopen: SPA navigation away and back (positions come from IndexedDB, no settling)
    await evalJs(`history.pushState({}, "", "/"); dispatchEvent(new PopStateEvent("popstate"))`);
    await waitFor("!window.__sporeMap", 5000, "map to unmount");
    await sleep(1500); // let the position write land
    await evalJs(`window.__t0 = performance.now(); history.pushState({}, "", ${JSON.stringify(url.replace(BASE, ""))}); dispatchEvent(new PopStateEvent("popstate"))`);
    await waitFor("!!(window.__sporeMap && window.__sporeMap.firstPaintAt() > 0)", 60_000, "warm first paint (SPA)");
    const warm = await evalJs<{ fp: number; t0: number; src: string | null; nodes: number; settled: boolean; cache: unknown }>(`({ fp: __sporeMap.firstPaintAt(), t0: window.__t0, src: __sporeMapPage.source(), nodes: __sporeMap.nodes(), settled: __sporeMap.settled(), cache: __sporeMapPage.cacheInfo() })`);
    result.firstPaintWarmMs = Math.round(warm.fp - warm.t0);
    result.warm = { source: warm.src, nodes: warm.nodes, settledAtFirstPaint: warm.settled, cache: warm.cache };
    check(warm.src === "cache" || (warm.cache != null), "warm reopen did not render from the cache");
    check(warm.fp - warm.t0 <= BUDGET.firstPaintWarm, `warm first paint ${Math.round(warm.fp - warm.t0)} ms > ${BUDGET.firstPaintWarm}`);
    // ---- warm full reload (new document: includes module loading on the dev server)
    await send("Page.reload", {}, S);
    await waitFor("window.__t0 === undefined", 30_000, "the reloaded document"); // the old document still answers until the new one commits
    await waitFor("!!(window.__sporeMap && window.__sporeMapPage && window.__sporeMap.firstPaintAt() > 0)", 60_000, "warm first paint (reload)");
    const reload = await evalJs<{ fp: number; data: number; mounted: number; src: string | null }>(`({ fp: __sporeMap.firstPaintAt(), data: __sporeMap.dataAt(), mounted: __sporeMapPage.mountedAt, src: __sporeMapPage.source() })`);
    result.warmReload = { fromNavMs: Math.round(reload.fp), fromMountMs: Math.round(reload.fp - reload.mounted), fromDataMs: Math.round(reload.fp - reload.data), source: reload.src };
    await waitFor("__sporeMap.settled()", 60_000, "settle after reload").catch(() => fails.push("layout did not settle after the reload"));
    // ---- phone
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, S);
    await sleep(1500);
    result.shot390 = await shot(`map-390${STRESS ? `-stress${STRESS}` : ""}.png`);
    if (!STRESS) {
      // phone: titles at fit (the camera re-fits for the new viewport)
      await evalJs("__sporeMap.fit()");
      await waitFor("!__sporeMap.flying()", 5000, "phone fit flight").catch(() => {});
      await sleep(600);
      const top = await evalJs<{ root: string }[]>("__sporeMap.clusters(10)");
      const titled = await evalJs<string[]>("__sporeMap.titles()");
      const hits = top.filter((c) => titled.includes(c.root)).length;
      result.titles390 = { titled: titled.length, top10: hits };
      check(hits >= 4, `390 px fit: only ${hits} of the 10 largest clusters titled (need 4)`);
      result.shot390fit = await shot("map-390-fit.png");
      // phone: a mid-size family's root dragged 300 px by touch
      const famP = await evalJs<{ root: string; cr: number } | null>(`(() => { const c = __sporeMap.clusters(400).find((c) => c.count >= 30 && c.count <= 300); return c ? { root: c.root, cr: c.cr } : null; })()`);
      if (famP) {
        const F = JSON.stringify(famP.root);
        // d3-drag listens for touches only where the device had them when the map mounted: remount with touch on
        await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }, S);
        await evalJs(`history.pushState({}, "", "/"); dispatchEvent(new PopStateEvent("popstate"))`);
        await waitFor("!window.__sporeMap", 5000, "map to unmount (touch)");
        await evalJs(`history.pushState({}, "", ${JSON.stringify(url.replace(BASE, ""))}); dispatchEvent(new PopStateEvent("popstate"))`);
        await waitFor("!!(window.__sporeMap && __sporeMap.firstPaintAt() > 0 && __sporeMap.settled())", 60_000, "map with touch");
        await sleep(800);
        await evalJs(`__sporeMap.zoomTo(${F}, ${Math.min(3, 120 / famP.cr)})`);
        await sleep(2000);
        const p0 = (await evalJs<{ x: number; y: number }>(`__sporeMap.screenOf(${F})`))!;
        const touch = (type: string, x: number, y: number) => send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] }, S);
        const dir = p0.y + 320 < 844 - 20 ? 1 : -1;
        const d = await liveDrag({ evalJs, sleep, press: (x, y) => touch("touchStart", x, y), move: (x, y) => touch("touchMove", x, y), release: (x, y) => touch("touchEnd", x, y) }, { grab: famP.root, x0: p0.x, y0: p0.y, dx: 0, dy: dir * 300 });
        result.dragPhone = { family: famP.root, ...d };
        check(d.drag?.node === famP.root && d.underPx <= 2, `phone drag: the root is ${d.underPx} px off the finger (${JSON.stringify(d.drag)})`);
        check(d.ticksDuring > 0 && d.moved2Others >= 10, `phone drag: the map did not flow (${d.ticksDuring} ticks, ${d.moved2Others} others moved)`);
        check(d.restMs !== null && d.restMs <= 3000 && d.movedAfterRest === 0, `phone drag: rest ${d.restMs} ms, ${d.movedAfterRest} moved after it`);
        check(d.frames.longTasks === 0 && d.frames.max <= BUDGET.rafMax, `phone drag: ${d.frames.longTasks} long task(s), longest frame ${d.frames.max} ms`);
        result.shotDragPhone = await shot("map-390-drag.png");
        await send("Emulation.setTouchEmulationEnabled", { enabled: false }, S);
      }
    }
    result.phone = await evalJs(`JSON.stringify({ overflowX: document.documentElement.scrollWidth > window.innerWidth, tools: !!document.querySelector(".map-tools"), labels: __sporeMap.labels(), drawn: __sporeMap.drawn() })`).then((s) => JSON.parse(s as unknown as string));
  }
  ws.close();

  async function v2Phases() {
    const stats = () => evalJs<{ settling: { n: number; avg: number; p95: number; max: number }; settled: { n: number; avg: number; p95: number; max: number } }>("__sporeMap.frameStats()");
    const render = () => evalJs<{ titles: number; fx: number; built: number; beacons: number } | null>("(() => { const p = window.__sporeRender; return p ? { titles: p.titles, fx: p.fx, built: p.built, beacons: p.beacons } : null; })()");
    const toFit = async () => { await evalJs("__sporeMap.fit()"); await waitFor("!__sporeMap.flying()", 5000, "fit flight to land").catch(() => fails.push("fit flight did not land in 5 s")); await sleep(500); };
    const round = (v: number) => Math.round(v * 100) / 100;
    await toFit();
    // ---- titles at fit: the largest trees are named at overview zoom
    const top = await evalJs<{ root: string; count: number; title: string }[]>("__sporeMap.clusters(10)");
    const titled = await evalJs<string[]>("__sporeMap.titles()");
    const hits = top.filter((c) => titled.includes(c.root));
    result.titles1440 = { titled: titled.length, top10: hits.length, missing: top.filter((c) => !titled.includes(c.root)).map((c) => c.title) };
    check(hits.length >= 8, `fit 1440: only ${hits.length} of the 10 largest clusters titled (need 8): missing ${top.filter((c) => !titled.includes(c.root)).map((c) => c.title).join(", ")}`);
    // ---- Spore beacons: every launch on screen at fit is a ringed beacon
    const ours = await evalJs<number>("(() => { const m = __sporeMap.testHighlight('ours'); __sporeMap.testHighlight(null); return m; })()");
    await sleep(300);
    const r0 = await render();
    result.beacons = { onScreen: ours, drawn: r0?.beacons ?? null };
    check(r0 != null && r0.beacons === ours, `beacons at fit: drew ${r0?.beacons} for ${ours} Spore launches`);
    // ---- heap: retained growth over 10 s idle at fit (GC before both reads)
    await send("Performance.enable", {}, S); await send("HeapProfiler.enable", {}, S);
    const heap = async () => { await send("HeapProfiler.collectGarbage", {}, S); const m = (await send("Performance.getMetrics", {}, S)) as { metrics: { name: string; value: number }[] }; return (m.metrics.find((x) => x.name === "JSHeapUsedSize")?.value ?? 0) / 1e6; };
    const h0 = await heap(); await sleep(10_000); const h1 = await heap();
    await send("HeapProfiler.disable", {}, S); await send("Performance.disable", {}, S); // leave the page as fast as it was
    result.heapMB = { before: round(h0), after: round(h1), growth: round(h1 - h0) };
    check(h1 - h0 < BUDGET.heapGrowthMB, `heap grew ${(h1 - h0).toFixed(2)} MB over 10 s idle (budget ${BUDGET.heapGrowthMB})`);
    // ---- gesture: 40 wheel notches into the largest cluster's centre (frame intervals + long tasks are
    // the budget; draw() ms is the secondary number)
    const big = await evalJs<{ root: string; x: number; y: number }>(`(() => { const c = __sporeMap.clusters(1)[0]; const cam = __sporeMap.camera(); const b = document.querySelector(".bm-canvas").getBoundingClientRect(); return { root: c.root, x: Math.round(b.left + c.cx * cam.k + cam.x), y: Math.round(b.top + c.cy * cam.k + cam.y) }; })()`);
    const under = await evalJs<string | null>(`__sporeMap.clusterAt(${big.x}, ${big.y})`);
    await evalJs("__sporeMap.resetFrames()");
    const gPh = await rafBegin();
    for (let q = 0; q < 40; q++) { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: big.x, y: big.y, deltaX: 0, deltaY: -120 }, S); await sleep(30); }
    await sleep(400);
    const g = await stats();
    const gRaf = await rafEnd(gPh);
    const gMax = Math.max(g.settled.max, g.settling.max);
    result.gesture = { at: big, clusterAt: under, k: await evalJs<number>("__sporeMap.zoom()"), frames: gRaf, settled: g.settled, settling: g.settling };
    check(g.settled.p95 <= BUDGET.gestureP95, `gesture draw() p95 ${g.settled.p95.toFixed(1)} ms > ${BUDGET.gestureP95}`);
    check(gMax <= BUDGET.gestureMax, `gesture draw() max ${gMax.toFixed(1)} ms > ${BUDGET.gestureMax}`);
    check(gRaf.longTasks === 0, `gesture: ${gRaf.longTasks} long task(s), longest ${gRaf.longTaskMaxMs} ms`);
    check(gRaf.max <= BUDGET.rafMax, `gesture: longest frame interval ${gRaf.max} ms > ${BUDGET.rafMax} (p95 ${gRaf.p95})`);
    result.shotGesture = await shot("map-1440-gesture-k6.png");
    // ---- zoom ladder screenshots on the largest tree (hulls must be gone at k ≥ 1.6)
    for (const k of [0.15, 0.6, 1.5, 3]) {
      await evalJs(`__sporeMap.zoomTo(${JSON.stringify(big.root)}, ${k})`);
      await sleep(1400);
      await shot(`map-1440-k${k}.png`);
    }
    // ---- trade burst: 300 trades in 3 s, half of them same-signature child → parent buys
    await evalJs(`__sporeMap.zoomTo(${JSON.stringify(big.root)}, 0.6)`);
    await sleep(1200);
    await evalJs("__sporeMap.resetFrames()");
    const bPh = await rafBegin();
    await evalJs(`(() => {
      const pairs = __sporeMap.sample(150);
      const lu = () => Math.exp(Math.log(5) + Math.random() * (Math.log(2000) - Math.log(5)));
      const ev = [];
      for (let q = 0; q < 75; q++) { const p = pairs[q % pairs.length], sig = "burst" + q + Math.random().toString(36).slice(2), v = lu(), legs = [{ sig, mint: p.mint, isBuy: true, valueUsd: v }, { sig, mint: p.parent, isBuy: true, valueUsd: v }]; if (q % 2) legs.reverse(); ev.push(legs); }
      for (let q = 0; q < 150; q++) { const p = pairs[(q * 7 + 3) % pairs.length]; ev.push([{ sig: "single" + q + Math.random().toString(36).slice(2), mint: q % 2 ? p.mint : p.parent, isBuy: Math.random() < 0.55, valueUsd: lu() }]); }
      for (let q = ev.length - 1; q > 0; q--) { const j = Math.floor(Math.random() * (q + 1)); [ev[q], ev[j]] = [ev[j], ev[q]]; }
      const flat = ev.flat();
      const es = (window.__es || []).filter((e) => e.readyState !== 2);
      window.__burst = { fx: [], done: false, n: flat.length };
      let i = 0;
      const t0 = performance.now();
      const tick = () => {
        const due = Math.min(flat.length, Math.ceil((performance.now() - t0) / 10));
        for (; i < due; i++) { const t = flat[i]; const payload = JSON.stringify({ sig: t.sig, mint: t.mint, slot: 0, time: Math.floor(Date.now() / 1000), isBuy: t.isBuy, user: "burst", baseAmount: 1, quoteAmount: 1, priceQuote: 1, priceUsd: 1, valueUsd: t.valueUsd }); for (const e of es) e.dispatch("trade", payload); }
        window.__burst.fx.push(__sporeMap.fx());
        if (i < flat.length) setTimeout(tick, 10); else window.__burst.done = true;
      };
      tick();
      return true;
    })()`);
    await sleep(1500);
    result.shotBurst = await shot("map-1440-burst.png");
    await waitFor("window.__burst && window.__burst.done", 10_000, "trade burst");
    await sleep(300);
    const bs = await stats();
    const bRaf = await rafEnd(bPh);
    const burst = await evalJs<{ fx: number[]; n: number }>("window.__burst");
    const fxPeak = Math.max(0, ...burst.fx);
    result.burst = { trades: burst.n, fxPeak, frames: bRaf, settled: bs.settled, settling: bs.settling };
    check(fxPeak > 0, "trade burst: fx() stayed 0 (no ripples drawn)");
    check(bs.settled.p95 <= BUDGET.settled, `burst draw() p95 ${bs.settled.p95.toFixed(1)} ms > ${BUDGET.settled}`);
    check(Math.max(bs.settled.max, bs.settling.max) <= BUDGET.gestureMax, `burst draw() max ${Math.max(bs.settled.max, bs.settling.max).toFixed(1)} ms > ${BUDGET.gestureMax}`);
    check(bRaf.longTasks === 0, `burst: ${bRaf.longTasks} long task(s), longest ${bRaf.longTaskMaxMs} ms`);
    check(bRaf.max <= BUDGET.rafMax, `burst: longest frame interval ${bRaf.max} ms > ${BUDGET.rafMax} (p95 ${bRaf.p95})`);
    // ---- highlight filters dim, never remove
    await toFit();
    result.highlight = {};
    for (const kind of ["min1k", "ours"]) {
      const matches = await evalJs<number>(`__sporeMap.testHighlight(${JSON.stringify(kind)})`);
      await sleep(800);
      await evalJs("__sporeMap.resetFrames()");
      await sleep(2000);
      const hs = await stats();
      (result.highlight as Record<string, unknown>)[kind] = { matches, settled: hs.settled, drawn: await evalJs<number>("__sporeMap.drawn()") };
      check(hs.settled.avg <= BUDGET.settled, `highlight ${kind}: settled avg ${hs.settled.avg.toFixed(1)} ms > ${BUDGET.settled}`);
      await shot(`map-1440-hl-${kind}.png`);
    }
    await evalJs("__sporeMap.testHighlight(null)");
    // ---- flight: from fit to a coin far from the centre, sampled every animation frame
    await toFit();
    const far = await evalJs<{ mint: string; x: number; y: number } | null>(`(() => {
      const b = document.querySelector(".bm-canvas").getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      let best = null, bestD = -1;
      for (const c of __sporeMap.clusters(4000)) {
        if (c.count < 3) continue;
        const p = __sporeMap.screenOf(c.root);
        if (!p || p.x < Math.max(b.left, 380) || p.x > b.right - 40 || p.y < b.top + 60 || p.y > b.bottom - 40) continue;
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d > bestD) { bestD = d; best = { mint: c.root, x: Math.round(p.x), y: Math.round(p.y) }; }
      }
      return best;
    })()`);
    check(!!far, "flight: no on-screen target found");
    if (far) {
      await evalJs(`(() => {
        const mint = ${JSON.stringify(far.mint)};
        const rec = window.__flight = { samples: [], t0: performance.now() };
        const loop = () => {
          const p = __sporeMap.screenOf(mint);
          rec.samples.push({ t: performance.now() - rec.t0, k: __sporeMap.zoom(), x: p ? p.x : NaN, y: p ? p.y : NaN, flying: __sporeMap.flying() });
          if (performance.now() - rec.t0 < 2600) requestAnimationFrame(loop);
        };
        __sporeMap.fly(mint);
        requestAnimationFrame(loop);
        return true;
      })()`);
      await sleep(2900);
      const fl = await evalJs<{ samples: { t: number; k: number; x: number; y: number; flying: boolean }[]; t0: number }>("window.__flight");
      const fRaf = await rafEnd({ t0: fl.t0, draws0: 0 });
      const vw = await evalJs<{ w: number; h: number }>("({ w: innerWidth, h: innerHeight })");
      const s = fl.samples;
      const off = s.filter((p) => !(p.x >= 0 && p.x <= vw.w && p.y >= 0 && p.y <= vw.h)).length;
      let ratio = 1; for (let q = 1; q < s.length; q++) { const a = s[q - 1].k, b2 = s[q].k; ratio = Math.max(ratio, a / b2, b2 / a); }
      const landed = s.find((p) => !p.flying);
      result.flight = { target: far, frames: s.length, offscreenFrames: off, maxKRatio: round(ratio), landedMs: landed ? Math.round(landed.t) : null, k0: s[0]?.k, k1: s[s.length - 1]?.k, intervals: { p50: fRaf.p50, p95: fRaf.p95, max: fRaf.max, over34: fRaf.over34, longTasks: fRaf.longTasks } };
      check(fRaf.longTasks === 0, `flight: ${fRaf.longTasks} long task(s), longest ${fRaf.longTaskMaxMs} ms`);
      check(s.length > 10 && off === 0, `flight: target off screen in ${off} of ${s.length} frames`);
      check(ratio <= BUDGET.flightKRatio, `flight: zoom changed ×${ratio.toFixed(3)} in one frame (budget ${BUDGET.flightKRatio})`);
      check(!!landed && landed.t <= BUDGET.flightMs, `flight landed after ${landed ? Math.round(landed.t) : "never"} ms (budget ${BUDGET.flightMs})`);
      result.shotFlight = await shot("map-1440-flight-landed.png");
      // leave the selection (the page clears ?focus on Escape)
      await evalJs(`document.querySelector(".bm").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await sleep(300);
    }
    // ---- live-simulation drags (DESIGN §11.5 "Drag", test/map-drag.mts): at fit a family grabbed by its
    // hull (its root comes along), then a mid-size family's root zoomed in, each pulled 300 px
    await toFit();
    const mouseIO = (): DragIO => ({
      evalJs, sleep,
      press: async (x, y) => { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, S); await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, S); },
      move: (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }, S),
      release: (x, y) => send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, S),
    });
    // a point over a titled family's hull that no ≥ 3 px bubble covers (the press grabs the family's root)
    const hull = await evalJs<{ root: string; x: number; y: number } | null>(`(() => { const M = __sporeMap, cam = M.camera(), b = document.querySelector(".bm-canvas").getBoundingClientRect(), titled = new Set(M.titles());
      for (const c of M.clusters(60)) { if (!titled.has(c.root) || c.count < 20) continue; const sx = b.left + c.cx * cam.k + cam.x, sy = b.top + c.cy * cam.k + cam.y, sr = c.cr * cam.k;
        if (sx < 420 || sx > innerWidth - 360 || sy < 120 || sy > innerHeight - 120) continue;
        for (let q = 0; q < 48; q++) { const a = q * 2.399963, d = sr * (0.25 + 0.6 * ((q % 8) / 8)); const x = sx + Math.cos(a) * d, y = sy + Math.sin(a) * d; const p = M.pick(x, y); if (!p.node && p.cluster === c.root) return { root: c.root, x, y }; } }
      return null; })()`);
    check(!!hull, "drag at fit: no titled family hull to press");
    if (hull) {
      const d = await liveDrag(mouseIO(), { grab: hull.root, x0: hull.x, y0: hull.y, dx: 300, dy: 0 });
      result.dragFit = { family: hull.root, k: round(await evalJs<number>("__sporeMap.zoom()")), ...d };
      check(d.drag?.node === hull.root && d.drag.n === 1, `drag at fit: pressing the hull did not grab the family's root (${JSON.stringify(d.drag)})`);
      check(d.ticksDuring > 0 && d.moved2Others >= 10, `drag at fit: the map did not flow (${d.ticksDuring} ticks, ${d.moved2Others} others moved)`);
      check(d.restMs !== null && d.restMs <= 3000 && d.movedAfterRest === 0, `drag at fit: rest ${d.restMs} ms, ${d.movedAfterRest} moved after it`);
      check(d.frames.longTasks === 0 && d.frames.max <= BUDGET.rafMax, `drag at fit: ${d.frames.longTasks} long task(s), longest frame ${d.frames.max} ms`);
      result.shotDragFit = await shot("map-1440-drag-fit.png");
    }
    const famD = await evalJs<{ root: string; cr: number } | null>(`(() => { const c = __sporeMap.clusters(400).find((c) => c.count >= 30 && c.count <= 300); return c ? { root: c.root, cr: c.cr } : null; })()`);
    check(!!famD, "drag zoomed: no mid-size family");
    if (famD) {
      const F = JSON.stringify(famD.root);
      await evalJs(`__sporeMap.zoomTo(${F}, ${Math.min(3, (0.3 * H) / famD.cr)})`);
      await sleep(2000);
      const p0 = (await evalJs<{ x: number; y: number }>(`__sporeMap.screenOf(${F})`))!;
      const dir = p0.x + 320 < W - 20 ? 1 : -1;
      const d = await liveDrag(mouseIO(), { grab: famD.root, x0: p0.x, y0: p0.y, dx: dir * 300, dy: 0 });
      result.dragZoomed = { family: famD.root, k: round(await evalJs<number>("__sporeMap.zoom()")), ...d };
      check(d.drag?.node === famD.root && d.underPx <= 2, `drag zoomed: the root is ${d.underPx} px off the pointer (${JSON.stringify(d.drag)})`);
      check(d.ticksDuring > 0 && d.moved2Others >= 10 && (d.children === 0 || d.childMovePx >= 90), `drag zoomed: ${d.ticksDuring} ticks, ${d.moved2Others} others moved, children moved ${d.childMovePx} px`);
      check(d.slidePx >= 20 && d.homeDist <= d.familyR, `drag zoomed: the root slid back ${d.slidePx} px and ended ${d.homeDist} from its family's centroid (radius ${d.familyR})`);
      check(d.restMs !== null && d.restMs <= 3000 && d.movedAfterRest === 0, `drag zoomed: rest ${d.restMs} ms, ${d.movedAfterRest} moved after it`);
      check(d.frames.longTasks === 0 && d.frames.max <= BUDGET.rafMax, `drag zoomed: ${d.frames.longTasks} long task(s), longest frame ${d.frames.max} ms`);
      result.shotDragZoomed = await shot("map-1440-drag-zoomed.png");
      // a frame sequence of the same drag + release, one screenshot every ~100 ms (not measured: capturing perturbs frames)
      const seqDir = join(SHOTS, "drag-seq");
      mkdirSync(seqDir, { recursive: true });
      await evalJs(`__sporeMap.zoomTo(${F}, ${Math.min(3, (0.3 * H) / famD.cr)})`);
      await sleep(1500);
      const p1 = (await evalJs<{ x: number; y: number }>(`__sporeMap.screenOf(${F})`))!;
      let seqN = 0;
      const seqIO: DragIO = { ...mouseIO(), frame: async (t) => { const r = (await send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, S)) as { data: string }; writeFileSync(join(seqDir, `f${String(seqN++).padStart(3, "0")}-${String(Math.round(t)).padStart(5, "0")}ms.jpg`), Buffer.from(r.data, "base64")); } };
      await liveDrag(seqIO, { grab: famD.root, x0: p1.x, y0: p1.y, dx: dir * 300, dy: 0 });
      result.dragSequence = { dir: seqDir, frames: seqN };
    }
    await toFit();
  }
} catch (e) {
  fails.push(`crashed: ${(e as Error).message}`);
} finally {
  result.consoleErrors = errors;
  result.networkErrors = netErrors.length;
  check(errors.length === 0, `${errors.length} console/CSP error(s): ${errors.slice(0, 3).join(" | ")}`);
  result.failures = fails;
  result.ok = fails.length === 0;
  console.log(JSON.stringify(result, null, 2));
  // Chrome keeps writing to its profile for a moment after SIGKILL reaches it: wait for the exit, then retry the delete.
  const exited = new Promise<void>((r) => { chrome.once("exit", () => r()); setTimeout(r, 3000); });
  chrome.kill("SIGKILL");
  await exited;
  for (let i = 0; i < 10; i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await sleep(300); } }
}
process.exit(fails.length ? 1 : 0);
