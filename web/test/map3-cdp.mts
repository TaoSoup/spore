// Shared Chrome DevTools-protocol harness for the map3 QA scripts (map3-qa, map3-perf, map3-shots): no
// puppeteer, the same raw-CDP pattern as map-ui.mts / map-perf.mts, packaged once.
//
//   const browser = await launchChrome({ gpu: "metal", width: 1440, height: 900 });
//   const page = await browser.newPage({ prelude: [MOCK_ES, RAF_PROBE] });
//   await page.navigate(url); await page.waitFor("…", 30_000, "what"); … ; await browser.close();
//
// GPU modes (measured on the M4, Chrome 155): "metal" = --use-angle=metal --ignore-gpu-blocklist → WebGL2 on
// "ANGLE Metal Renderer: Apple M4"; "none" = --disable-gpu → no WebGL at all (the classic fallback);
// "swiftshader" = --disable-gpu --enable-unsafe-swiftshader → WebGL2 in software.
//
// Errors: console.error, uncaught exceptions, non-network Log entries of level error and CSP violations
// (a `securitypolicyviolation` listener reporting through a CDP binding, so a violation counts even when
// Chrome logs nothing) go to page.errors; network failures (Log source "network", failed loads other
// than aborts) go to page.netErrors and are reported separately; console.warn to page.warnings; every
// console/Log text to page.logs (for message watches such as "Too many active WebGL contexts").
// page.requests is the network log (Network.requestWillBeSent).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export type GpuMode = "metal" | "swiftshader" | "none";
export const gpuFlags = (g: GpuMode): string[] =>
  g === "metal" ? ["--use-angle=metal", "--ignore-gpu-blocklist"] : g === "none" ? ["--disable-gpu"] : ["--disable-gpu", "--enable-unsafe-swiftshader"];

export type LaunchOpts = { gpu?: GpuMode; width?: number; height?: number; dpr?: number; mobile?: boolean; touch?: boolean; reducedMotion?: boolean; extraArgs?: string[]; tmp?: string; insecure?: boolean };
export type PageOpts = { width?: number; height?: number; dpr?: number; mobile?: boolean; touch?: boolean; prelude?: string[]; network?: boolean };
export type Req = { url: string; method: string; type: string; t: number };
type Msg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

/// Appends ?debug (production builds gate their hooks on it) before any #hash.
export function withDebug(path: string, on = true): string {
  if (!on) return path;
  const [p, h] = path.split("#", 2);
  if (/[?&]debug(=|&|$)/.test(p)) return path;
  return `${p}${p.includes("?") ? "&" : "?"}debug${h !== undefined ? `#${h}` : ""}`;
}

/// The map look under test (galaxy spec §0/§10): `--look galaxy|flat` on any script's command line, else the
/// MAP3_LOOK env; "" = leave the URLs alone (the app's default: flat since the 2026-10-21 flat fix; galaxy only via ?look=galaxy). Every /map URL a page
/// navigates to gets `look=<LOOK>` appended (page.navigate → withLook); SPA navigations inside the app do not
/// carry it, so scripts read `__sporeMap.look()` where the look matters.
export const LOOK: "galaxy" | "flat" | "" = (() => {
  const a = process.argv.slice(2), i = a.indexOf("--look");
  const v = (i >= 0 ? a[i + 1] : process.env.MAP3_LOOK) ?? "";
  return v === "galaxy" || v === "flat" ? v : "";
})();
/// Appends look=<look> to a /map URL (not /embed/*, not the coin page); keeps an explicit look= already there.
export function withLook(url: string, look: string = LOOK): string {
  if (!look) return url;
  const [p, h] = url.split("#", 2);
  const path = p.replace(/^[a-z]+:\/\/[^/]+/i, "");
  if (!/^\/map(\?|$)/.test(path) || /[?&]look=/.test(p)) return url;
  return `${p}${p.includes("?") ? "&" : "?"}look=${look}${h !== undefined ? `#${h}` : ""}`;
}

/// EventSource mock (same as map-interact / map-perf): every instance in window.__es, dispatch(type, json)
/// feeds the page's lib/events listeners. Never errors, so the page's one stream stays the only one.
export const MOCK_ES = `(() => {
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
  /// dispatches one SSE event on every open mock (the page holds exactly one)
  window.__sse = (type, obj) => { let n = 0; for (const e of list) if (e.readyState !== 2) { e.dispatch(type, typeof obj === "string" ? obj : JSON.stringify(obj)); n++; } return n; };
})();`;

/// Every animation frame and every long task, read per phase with rafStatsJs(). R.t holds the rAF timestamp (the
/// frame's vsync-aligned begin time: a dropped frame shows as a 33 ms gap); R.c holds performance.now() inside the
/// callback, which also carries the compositor's scheduling jitter. Measured on the M4, headless Chrome 155, metal:
/// on "/" (no map at all) the callback-time p95 is 18.4 ms while the timestamp p95 is 16.7 ms. The gates therefore
/// use the timestamp; the callback time is reported as cbP95/cbMax for information.
export const RAF_PROBE = `(() => {
  const R = window.__raf = { t: new Float64Array(400000), c: new Float64Array(400000), n: 0, lt: [] };
  const loop = (ts) => { if (R.n < R.t.length) { R.c[R.n] = performance.now(); R.t[R.n++] = ts; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) R.lt.push({ s: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
})();`;

/// Reports CSP violations through the __qaCsp binding (installed by newPage).
const CSP_PROBE = `(() => { document.addEventListener("securitypolicyviolation", (e) => { try { window.__qaCsp(JSON.stringify({ d: e.violatedDirective, b: e.blockedURI, s: e.sourceFile, l: e.lineNumber })); } catch {} }, true); })();`;

export type RafStats = { durMs: number; frames: number; fps: number; p50: number; p95: number; max: number; over34: number; longTasks: number; longTaskMaxMs: number; cbP95: number; cbMax: number };
/// Frame-interval statistics between two performance.now() stamps (needs RAF_PROBE in the page). p50/p95/max/over34/fps
/// come from the rAF timestamps; cbP95/cbMax from performance.now() inside the callback (information only, see RAF_PROBE).
export const rafStatsJs = (t0: number, t1: string = "performance.now()") => `(() => {
  const R = window.__raf; if (!R) return null; const t0 = ${t0}, t1 = ${t1};
  const iv = [], cb = []; let last = -1, lastC = -1;
  for (let i = 0; i < R.n; i++) { const t = R.t[i], c = R.c[i]; if (c < t0 || c > t1) continue; if (last >= 0) { iv.push(t - last); cb.push(c - lastC); } last = t; lastC = c; }
  iv.sort((a, b) => a - b); cb.sort((a, b) => a - b);
  const q = (a, x) => a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * x))] * 100) / 100 : 0;
  const p = (x) => q(iv, x);
  const lt = R.lt.filter((e) => e.s >= t0 && e.s <= t1);
  return { durMs: Math.round(t1 - t0), frames: iv.length, fps: iv.length ? Math.round(1000 / (iv.reduce((s, v) => s + v, 0) / iv.length)) : 0, p50: p(0.5), p95: p(0.95), max: p(1), over34: iv.filter((v) => v > 34).length, longTasks: lt.length, longTaskMaxMs: lt.length ? Math.round(Math.max(...lt.map((e) => e.d))) : 0, cbP95: q(cb, 0.95), cbMax: q(cb, 1) };
})()`;

export type Page = {
  sid: string;
  errors: string[]; netErrors: string[]; warnings: string[]; logs: string[]; requests: Req[];
  /// HTTP responses with status ≥ 400 (Network.responseReceived; needs the Network domain, i.e. PageOpts.network !== false)
  responses: { url: string; status: number; t: number }[];
  /// extra CDP event handlers for this page's session (e.g. "Page.screencastFrame"); returns an unsubscribe
  on(method: string, fn: (params: Record<string, unknown>) => void): () => void;
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  evalJs<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
  waitFor<T = unknown>(expression: string, timeoutMs: number, what: string, everyMs?: number): Promise<T>;
  navigate(url: string, timeoutMs?: number): Promise<void>;
  reload(timeoutMs?: number): Promise<void>;
  viewport(w: number, h: number, dpr?: number, mobile?: boolean): Promise<void>;
  setTouch(on: boolean): Promise<void>;
  shot(file: string, opts?: { format?: "png" | "jpeg"; quality?: number }): Promise<string>;
  mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, extra?: Record<string, unknown>): Promise<unknown>;
  hover(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
  wheel(x: number, y: number, deltaY: number, deltaX?: number): Promise<unknown>;
  touch(type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]): Promise<unknown>;
  tap(x: number, y: number, holdMs?: number): Promise<void>;
  key(k: string): Promise<void>;
  insertText(text: string): Promise<unknown>;
  intercept(patterns: string[], handler: (p: { requestId: string; request: { url: string; method: string } }) => Promise<void>): Promise<void>;
  unintercept(): Promise<void>;
  fulfill(requestId: string, status: number, body: string, type?: string): Promise<unknown>;
  pass(requestId: string): Promise<unknown>;
  heapMB(): Promise<number>;
  domCounters(): Promise<{ documents: number; nodes: number; jsEventListeners: number }>;
  close(): Promise<void>;
};

export type Browser = { port: number; profile: string; proc: ChildProcess; newPage(opts?: PageOpts): Promise<Page>; close(): Promise<void> };

const KEYS: Record<string, { code: string; vk: number; text?: string; shift?: boolean }> = {
  ArrowUp: { code: "ArrowUp", vk: 38 }, ArrowDown: { code: "ArrowDown", vk: 40 }, ArrowLeft: { code: "ArrowLeft", vk: 37 }, ArrowRight: { code: "ArrowRight", vk: 39 },
  Escape: { code: "Escape", vk: 27 }, Enter: { code: "Enter", vk: 13, text: "\r" },
  "0": { code: "Digit0", vk: 48, text: "0" }, "+": { code: "Equal", vk: 187, text: "+", shift: true }, "=": { code: "Equal", vk: 187, text: "=" }, "-": { code: "Minus", vk: 189, text: "-" }, "/": { code: "Slash", vk: 191, text: "/" },
};

export async function launchChrome(o: LaunchOpts = {}): Promise<Browser> {
  const w = o.width ?? 1440, h = o.height ?? 900;
  const profile = mkdtempSync(join(o.tmp ?? process.env.SPORE_TMP ?? tmpdir(), "spore-map3-"));
  const args = ["--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-extensions",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${w},${h}`, ...gpuFlags(o.gpu ?? "metal")];
  if (o.reducedMotion) args.push("--force-prefers-reduced-motion");
  if (o.extraArgs) args.push(...o.extraArgs);
  // an https base (serve-prod --h2 serves a self-signed cert): accept it, so the page talks h2 (Chrome caps h1 at 6 sockets per host)
  if (o.insecure ?? process.argv.slice(2).some((a) => /^https:\/\/(127\.0\.0\.1|localhost)[:/]/.test(a))) args.push("--ignore-certificate-errors");
  const proc = spawn(CHROME, [...args, "about:blank"], { stdio: "ignore" });
  // the port Chrome picked is written to <profile>/DevToolsActivePort (no collisions with other runs)
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    const f = join(profile, "DevToolsActivePort");
    if (existsSync(f)) { const n = Number(readFileSync(f, "utf8").split("\n")[0]); if (n > 0) port = n; }
  }
  if (!port) { proc.kill("SIGKILL"); throw new Error("chrome did not start (no DevToolsActivePort)"); }
  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !version; i++) { version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>).catch(() => null); if (!version) await sleep(100); }
  if (!version) { proc.kill("SIGKILL"); throw new Error("chrome did not answer /json/version"); }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("devtools websocket")); });
  let id = 0;
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  const listeners = new Map<string, (m: Msg) => void>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Msg;
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id)!; pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); return; }
    if (m.sessionId) listeners.get(m.sessionId)?.(m);
  };
  const raw = <T,>(method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<T>((res, rej) => { const i = ++id; pending.set(i, { res: res as (v: unknown) => void, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const pages: Page[] = [];

  async function newPage(po: PageOpts = {}): Promise<Page> {
    const { targetId } = await raw<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId: sid } = await raw<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const errors: string[] = [], netErrors: string[] = [], warnings: string[] = [], logs: string[] = [], requests: Req[] = [];
    const responses: { url: string; status: number; t: number }[] = [];
    const extra = new Map<string, Set<(p: Record<string, unknown>) => void>>();
    let onPaused: ((p: { requestId: string; request: { url: string; method: string } }) => Promise<void>) | null = null;
    const send = <T,>(method: string, params: Record<string, unknown> = {}) => raw<T>(method, params, sid);
    listeners.set(sid, (m) => {
      const p = m.params as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (m.method) {
        case "Runtime.consoleAPICalled": {
          const text = (p.args as { value?: unknown; description?: string }[]).map((a) => (typeof a.value === "string" ? a.value : a.value !== undefined ? JSON.stringify(a.value) : a.description ?? "")).join(" ");
          logs.push(`${p.type}: ${text}`);
          if (p.type === "error" || p.type === "assert") errors.push(`console.error: ${text}`);
          else if (p.type === "warning") warnings.push(text);
          break;
        }
        case "Runtime.exceptionThrown": errors.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`); break;
        case "Runtime.bindingCalled": if (p.name === "__qaCsp") errors.push(`csp: ${p.payload}`); break;
        case "Log.entryAdded": {
          const e = p.entry as { level: string; source: string; text: string; url?: string };
          logs.push(`log.${e.level}.${e.source}: ${e.text}`);
          if (e.level === "error") { if (e.source === "network") netErrors.push(`${e.text} ${e.url ?? ""}`.trim()); else errors.push(`${e.source}: ${e.text}`); }
          else if (e.level === "warning") warnings.push(`${e.source}: ${e.text}`);
          break;
        }
        case "Network.responseReceived": if (p.response && p.response.status >= 400) responses.push({ url: String(p.response.url).slice(0, 300), status: p.response.status, t: Date.now() }); break;
        case "Network.requestWillBeSent": requests.push({ url: p.request.url, method: p.request.method, type: p.type ?? "", t: Date.now() }); break;
        case "Network.loadingFailed": if (!/ERR_ABORTED/.test(p.errorText) && !p.canceled) netErrors.push(`loading failed: ${p.errorText} (${p.type ?? ""})`); break;
        case "Fetch.requestPaused": if (onPaused) void onPaused(p as { requestId: string; request: { url: string; method: string } }).catch((e: Error) => { if (!/not enabled|Invalid InterceptionId/.test(e.message)) errors.push(`fetch intercept: ${e.message}`); }); break;
      }
      const hs = m.method ? extra.get(m.method) : undefined;
      if (hs) for (const f of hs) { try { f(p); } catch { /* a test handler */ } }
    });
    await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
    if (po.network !== false) await send("Network.enable", { maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 200_000 });
    await send("Runtime.addBinding", { name: "__qaCsp" });
    await send("Page.addScriptToEvaluateOnNewDocument", { source: CSP_PROBE });
    for (const src of po.prelude ?? []) await send("Page.addScriptToEvaluateOnNewDocument", { source: src });
    const evalJs = async <T,>(expression: string, timeoutMs = 120_000): Promise<T> => {
      const r = await Promise.race([
        send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
        sleep(timeoutMs).then(() => { throw new Error(`eval timed out after ${timeoutMs} ms :: ${expression.slice(0, 100)}`); }),
      ]);
      if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text} :: ${expression.slice(0, 120)}`);
      return r.result.value;
    };
    const waitFor = async <T,>(expression: string, timeoutMs: number, what: string, everyMs = 100): Promise<T> => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        let v: unknown = null;
        try { v = await evalJs(expression, 10_000); } catch { /* the document is loading */ }
        if (v) return v as T;
        await sleep(everyMs);
      }
      throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
    };
    const viewport = async (w: number, h: number, dpr = 1, mobile = w < 700) => { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile }); };
    const setTouch = async (on: boolean) => { await send("Emulation.setTouchEmulationEnabled", { enabled: on, maxTouchPoints: on ? 5 : 1 }); };
    await viewport(po.width ?? w, po.height ?? h, po.dpr ?? o.dpr ?? 1, po.mobile ?? o.mobile ?? (po.width ?? w) < 700);
    if (po.touch ?? o.touch) await setTouch(true);
    /// navigates and waits until the old document is gone (a marker on window disappears)
    const fresh = async (go: () => Promise<unknown>, timeoutMs: number) => {
      await evalJs("window.__qaOld = 1", 5_000).catch(() => null);
      await go();
      await waitFor("!window.__qaOld && document.readyState !== 'loading'", timeoutMs, "the new document");
    };
    const mouse = (type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, extra: Record<string, unknown> = {}) =>
      send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1, ...extra });
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) =>
      send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : points.map((q, i) => ({ x: q.x, y: q.y, id: i + 1, radiusX: 2, radiusY: 2, force: 1 })) });
    const page: Page = {
      sid, errors, netErrors, warnings, logs, requests, responses, send,
      on: (method, fn) => { let set = extra.get(method); if (!set) extra.set(method, (set = new Set())); set.add(fn); return () => { set!.delete(fn); }; }, evalJs, waitFor, viewport, setTouch, mouse, touch,
      navigate: (url, timeoutMs = 60_000) => fresh(() => send("Page.navigate", { url: withLook(url) }), timeoutMs),
      reload: (timeoutMs = 60_000) => fresh(() => send("Page.reload", {}), timeoutMs),
      shot: async (file, so = {}) => { const r = await send<{ data: string }>("Page.captureScreenshot", { format: so.format ?? "png", quality: so.quality }); writeFileSync(file, Buffer.from(r.data, "base64")); return file; },
      hover: async (x, y) => { await mouse("mouseMoved", x - 12, y + 9); await sleep(40); await mouse("mouseMoved", x, y); },
      click: async (x, y) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); },
      wheel: (x, y, deltaY, deltaX = 0) => send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY }),
      tap: async (x, y, holdMs = 40) => { await touch("touchStart", [{ x, y }]); await sleep(holdMs); await touch("touchEnd", []); },
      key: async (k) => {
        const d = KEYS[k] ?? { code: k.length === 1 ? `Key${k.toUpperCase()}` : k, vk: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0, text: k.length === 1 ? k : undefined };
        const modifiers = d.shift ? 8 : 0;
        await send("Input.dispatchKeyEvent", { type: d.text ? "keyDown" : "rawKeyDown", key: k, code: d.code, windowsVirtualKeyCode: d.vk, text: d.text, unmodifiedText: d.text, modifiers });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: d.code, windowsVirtualKeyCode: d.vk, modifiers });
      },
      insertText: (text) => send("Input.insertText", { text }),
      intercept: async (patterns, handler) => { onPaused = handler; await send("Fetch.enable", { patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: "Request" })) }); },
      unintercept: async () => { onPaused = null; await send("Fetch.disable").catch(() => null); },
      fulfill: (requestId, status, body, type = "application/json") => send("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [{ name: "content-type", value: type }, { name: "cache-control", value: "no-store" }], body: Buffer.from(body).toString("base64") }),
      pass: (requestId) => send("Fetch.continueRequest", { requestId }),
      heapMB: async () => {
        await send("HeapProfiler.enable");
        await send("HeapProfiler.collectGarbage"); await sleep(100); await send("HeapProfiler.collectGarbage");
        const h = await send<{ usedSize: number }>("Runtime.getHeapUsage");
        await send("HeapProfiler.disable");
        return Math.round((h.usedSize / 1e6) * 100) / 100;
      },
      domCounters: () => send<{ documents: number; nodes: number; jsEventListeners: number }>("Memory.getDOMCounters"),
      close: async () => { listeners.delete(sid); await raw("Target.closeTarget", { targetId }).catch(() => null); },
    };
    pages.push(page);
    return page;
  }

  async function close() {
    try { ws.close(); } catch { /* already closed */ }
    const exited = new Promise<void>((r) => { if (proc.exitCode !== null) r(); else { proc.once("exit", () => r()); setTimeout(r, 3000); } });
    proc.kill("SIGKILL");
    await exited;
    // Chrome keeps writing to its profile for a moment after SIGKILL: retry the delete
    for (let i = 0; i < 10; i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await sleep(300); } }
  }
  return { port, profile, proc, newPage, close };
}

// ---------------------------------------------------------------- shared page-side snippets
/// Waits for the map of `renderer` ("three" | "classic") to have painted once.
export const mapReadyJs = (renderer: "three" | "classic") =>
  `(() => { const P = window.__sporeMapPage, M = window.__sporeMap; if (!P || !M || !M.firstPaintAt || !(M.firstPaintAt() > 0)) return false; const r = typeof P.renderer === "function" ? P.renderer() : "classic"; return r === ${JSON.stringify(renderer)}; })()`;
/// Whether nothing moves (map3 and classic both expose settled() and flying()).
export const SETTLED_JS = "!!(window.__sporeMap && __sporeMap.settled() && !__sporeMap.flying())";
/// Map3 root rect shrunk by the page's inset (viewport px).
export const INSET_RECT_JS = `(() => { const root = document.querySelector(".bm.m3") || document.querySelector(".bm"); if (!root) return null; const r = root.getBoundingClientRect(), i = (window.__sporeMapPage && __sporeMapPage.inset && __sporeMapPage.inset()) || {}; return { x0: r.left + (i.left || 0), y0: r.top + (i.top || 0), x1: r.right - (i.right || 0), y1: r.bottom - (i.bottom || 0) }; })()`;
/// Resources that belong to the lazily loaded map3 code: the production chunk (/assets/ThreeMap-*.js/.css, or
/// three split out), or on a dev server the modules themselves (/src/components/map3/… except probe.ts and types.ts,
/// which Map.tsx imports eagerly by design, and the pre-bundled three).
export const MAP3_ASSET_RE = /\/assets\/[^?#]*(ThreeMap|three\.module|three\.core|three-)[^/?#]*\.(js|css)|\/src\/components\/map3\/(?!probe\.ts|types\.ts)|\/\.vite\/deps\/three[._]/i;
export const map3AssetsJs = `performance.getEntriesByType("resource").map((e) => e.name).filter((n) => ${MAP3_ASSET_RE}.test(n))`;

/// Minimal CLI option reader shared by the scripts.
export function cli(argv = process.argv.slice(2)) {
  return {
    opt: (name: string, dflt: string | null = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt; },
    has: (name: string) => argv.includes(name),
  };
}
