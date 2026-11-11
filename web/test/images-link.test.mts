// The map image loader (src/lib/map/images.ts) through a server or site outage (2026-11-10, logos after an outage): a request to
// our API that ends like an unreachable server (a network error, or a 5xx that is not the API's own answer: no JSON, no
// Retry-After, as vite preview's 502 text/plain or Cloudflare's 52x HTML) is the LINK's failure, not the logo's: no retry
// step, no death, sheets stay on. Nothing starts but one probe at a time (GET /api/health past every cache, answered when its
// answer is JSON), LINK_PROBE_MS after the link went down, doubling up to LINK_PROBE_MAX_MS; only the probe puts the link up
// (a logo may come from the browser's cache), and then everything goes at once. (2026-11-11) The probe judges the failures
// before it: answered, they were their sources' own (the first forgiven, then retry steps, then dead) or the sheet route's
// (SHEET_FAIL_MAX in a row cool sheets down); not answered, the outage's, and nothing is charged: a second outage during the
// recovery, a flap, cache hits cost nothing, and one broken URL dies instead of holding the link down. The sheet route
// failing on its own (the API's 500, a sheet that does not decode or match) cools sheets down (the sources go per request).
// A 429 pauses every start (the probe's before the link goes up); the PAUSE_MS doubling starts over only PAUSE_MAX_MS after
// the last pause. A window "online" or a page shown again probes at once, a hidden page never. Time is node:test's mock clock
// (setTimeout + Date); jitter is pinned at 0 with a Math.random stub.
//   npx tsx --test test/images-link.test.mts
import { mock, test } from "node:test";
import assert from "node:assert/strict";

type Loader = typeof import("../src/lib/map/images.ts");
type Bmp = { width: number; height: number; closed: boolean; close(): void };
type Sig = AbortSignal | undefined;
type Answer = Response | Promise<Response>;
type Call = { url: string; cache: RequestCache | undefined; t: number };
type Harness = {
  m: Loader; calls: Call[]; urls: () => string[]; sheetCalls: () => Call[]; imgCalls: () => Call[]; healthCalls: () => Call[]; callsOf: (part: string) => Call[];
  fire: (type: string) => void; doc: { visibilityState: string };
};

let seq = 0;
const T0 = Date.parse("2026-11-10T12:00:00Z");
const S = (i: number | string) => `/api/img?u=${encodeURIComponent(`https://img.test/${i}.png`)}`;
const M = (i: number) => `mint${i}`;
const nodes = (n: number, from = 0) => Array.from({ length: n }, (_, k) => ({ mint: M(from + k), image: S(from + k) }));
const hexOf = (n: number, pred: (i: number) => boolean) => {
  const bytes = Array.from({ length: Math.ceil(n / 8) }, () => 0);
  for (let i = 0; i < n; i++) if (pred(i)) bytes[i >> 3] |= 1 << (i & 7);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
};
/// A sheet answer per the contract; the body "SHEET:<n>" stands for the image (the createImageBitmap stub reads it).
const sheetHeaders = (n: number, present: string) => ({ "content-type": "image/webp", "x-sheet": present, "x-sheet-dead": "", "x-sheet-n": String(n), "x-sheet-cols": "16", "x-sheet-cell": "64", "x-sheet-pending": "0" });
const ALL = (mints: string[]) => new Response(`SHEET:${mints.length}`, { status: 200, headers: sheetHeaders(mints.length, hexOf(mints.length, () => true)) });
const imgResponse = () => new Response("IMG", { status: 200, headers: { "content-type": "image/png", "x-img-thumb": "64" } });
/// The API server's own answers: JSON, a Retry-After where it sends one.
const api = (code: number, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: "no" }), { status: code, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
/// Its /api/health (the probe), JSON like every answer of our API.
const healthy = () => new Response(JSON.stringify({ ok: true, status: "ok" }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
/// What a browser gets when nobody answers: connection refused / reset / offline.
const refused = (): never => { throw new TypeError("Failed to fetch"); };
/// vite preview's /api proxy while the backend is down (empty body, text/plain, no Retry-After).
const vite502 = () => new Response("", { status: 502, headers: { "content-type": "text/plain" } });
/// Cloudflare's page for an origin it cannot reach.
const cf = (code: number) => new Response("<!DOCTYPE html><title>origin unreachable</title>", { status: code, headers: { "content-type": "text/html; charset=UTF-8" } });
const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async (n = 16) => { for (let i = 0; i < n; i++) await tick(); };
/// Yields (setImmediate, never a timer: the timers are mocked) until `pred` or `maxMs` of real time.
async function until(pred: () => boolean, maxMs = 5_000, state?: () => unknown) {
  const t0 = performance.now();
  while (!pred()) { if (performance.now() - t0 > maxMs) throw new Error(`until: timed out${state ? " " + JSON.stringify(state()) : ""}`); await tick(); }
}
/// The mock clock from T0; the jitter pinned at 0 (Math.random() = 0).
function clock() {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  mock.method(Math, "random", () => 0);
  return () => { mock.timers.reset(); mock.restoreAll(); };
}
const advance = async (ms: number) => { mock.timers.tick(ms); await settle(); };
/// No answer at all until the request is aborted.
const hang = (signal: Sig) => new Promise<Response>((_, rej) => { signal?.addEventListener("abort", () => rej(signal.reason), { once: true }); });
/// An answer `ms` into the mock clock (a read from the browser's disk cache, a logo the server must first download), or the
/// request's abort reason.
const later = (ms: number, signal: Sig, make: () => Response) => new Promise<Response>((res, rej) => {
  const id = setTimeout(() => res(make()), ms);
  signal?.addEventListener("abort", () => { clearTimeout(id); rej(signal.reason); }, { once: true });
});

async function fresh(o: { sheet?: (mints: string[], signal: Sig) => Answer; img?: (url: string, signal: Sig) => Answer; health?: (signal: Sig) => Answer } = {}): Promise<Harness> {
  const calls: Call[] = [];
  const handlers = new Map<string, (() => void)[]>();
  const on = (type: string, fn: () => void) => { const l = handlers.get(type) ?? []; l.push(fn); handlers.set(type, l); };
  const doc = { visibilityState: "visible", addEventListener: on };
  const bmp = (width: number, height: number): Bmp => { const b: Bmp = { width, height, closed: false, close() { b.closed = true; } }; return b; };
  const g = globalThis as Record<string, unknown>;
  g.window = { innerWidth: 1440, addEventListener: on };
  g.document = doc;
  g.fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, cache: init?.cache, t: Date.now() });
    const u = new URL(url, "http://local.test"), signal = init?.signal ?? undefined;
    if (u.pathname === "/api/logo-sheet") return o.sheet ? o.sheet((u.searchParams.get("m") ?? "").split(","), signal) : api(404);
    // the probe: unless a test says otherwise the server is as reachable as the logo route (a refusal, a proxy's page, a hang
    // alike), and answers its JSON where the logo route answers a logo
    if (u.pathname === "/api/health") {
      if (o.health) return o.health(signal);
      const r = await (o.img ? o.img(url, signal) : imgResponse());
      return r.ok ? healthy() : r;
    }
    return o.img ? o.img(url, signal) : imgResponse();
  };
  // createImageBitmap(blob): "SHEET:<n>" decodes to a 1024 x rows*64 sheet, "BROKEN" does not decode, anything else is a
  // 200 x 200 original; createImageBitmap(bitmap, x, y, w, h[, { resizeWidth }]) returns a bitmap of the asked size.
  g.createImageBitmap = async (src: Blob | Bmp, ...rest: unknown[]) => {
    if (src instanceof Blob) {
      const t = await src.text();
      if (t.startsWith("SHEET:")) { const n = Number(t.slice(6)); return bmp(1024, Math.ceil(n / 16) * 64); }
      if (t === "BROKEN") throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      return bmp(200, 200);
    }
    if (rest.length >= 4) {
      const opt = rest[4] as { resizeWidth?: number } | undefined, size = opt && typeof opt.resizeWidth === "number" ? opt.resizeWidth : null;
      return bmp(size ?? (rest[2] as number), size ?? (rest[3] as number));
    }
    return bmp(src.width, src.height);
  };
  const m = (await import(`../src/lib/map/images.ts?link${++seq}`)) as Loader;
  const isSheet = (c: Call) => c.url.startsWith("/api/logo-sheet?"), isHealth = (c: Call) => c.url === "/api/health";
  return {
    m, calls, doc,
    urls: () => calls.map((c) => c.url),
    sheetCalls: () => calls.filter(isSheet), imgCalls: () => calls.filter((c) => !isSheet(c) && !isHealth(c)), healthCalls: () => calls.filter(isHealth),
    callsOf: (part: string) => calls.filter((c) => c.url.includes(encodeURIComponent(part))),
    fire: (type: string) => { for (const f of handlers.get(type) ?? []) f(); },
  };
}

/// Every timer the loader holds right now (a spy over the mock clock's setTimeout / clearTimeout: a timer leaves the set when
/// it fires or is cleared).
function liveTimers() {
  type G = { setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => unknown; clearTimeout: (id: unknown) => void };
  const g = globalThis as unknown as G, st = g.setTimeout, ct = g.clearTimeout, live = new Map<unknown, number>();
  g.setTimeout = (fn, ms = 0, ...a) => {
    const id: unknown = st((...b: unknown[]) => { live.delete(id); fn(...b); }, ms, ...a);
    live.set(id, ms);
    return id;
  };
  g.clearTimeout = (id) => { live.delete(id); ct(id); };
  return { n: () => live.size, delays: () => [...live.values()].sort((a, b) => a - b), restore: () => { g.setTimeout = st; g.clearTimeout = ct; } };
}

test("probeMs: LINK_PROBE_MS doubling up to LINK_PROBE_MAX_MS, + 0..25 % jitter; proxyError: a 5xx without JSON or Retry-After, never a 501", async () => {
  const { m } = await fresh();
  assert.equal(m.LINK_PROBE_MS, 1_000); assert.equal(m.LINK_PROBE_MAX_MS, 3_000); assert.equal(m.LINK_PROBE_TIMEOUT_MS, 10_000);
  assert.deepEqual([0, 1, 2, 3, 9, 1e9].map((n) => m.probeMs(n, 0)), [1_000, 2_000, 3_000, 3_000, 3_000, 3_000]);
  assert.equal(m.probeMs(-1, 0), 1_000);
  assert.equal(m.probeMs(2, 0.999999), 3_750);
  for (let k = 0; k < 200; k++) { const w = m.probeMs(5); assert.ok(w >= 3_000 && w <= 3_750, String(w)); }
  for (const r of [vite502(), cf(502), cf(520), cf(521), cf(522), cf(524), cf(530), new Response(null, { status: 504 })]) assert.equal(m.proxyError(r), true, `${r.status} ${r.headers.get("content-type")}`);
  for (const r of [api(500), api(503), api(503, { "retry-after": "5" }), new Response("busy", { status: 503, headers: { "retry-after": "20" } }), api(404), api(429, { "retry-after": "1" }), new Response("no", { status: 501 }), imgResponse(), new Response("nf", { status: 404, headers: { "content-type": "text/html" } })]) {
    assert.equal(m.proxyError(r), false, `${r.status} ${r.headers.get("content-type")}`);
  }
});

test("an outage is the link's: no retry step, no death, sheets stay on; one probe at a time (1 s, 2 s, then every 3 s, GET /api/health past every cache) for 30 min; the probe's answer resumes everything at once", async () => {
  const off = clock();
  try {
    let down = true;
    const h = await fresh({ img: () => (down ? refused() : imgResponse()), sheet: (mints) => (down ? refused() : ALL(mints)) });
    const { m } = h;
    m.registerLogoMints(nodes(40));
    for (let i = 0; i < 40; i++) m.imageFor(S(i), 40);           // sheet-able: one sheet
    for (let i = 0; i < 10; i++) m.imageFor(S(`solo${i}`), 40);  // not registered: one by one
    await settle();
    assert.equal(h.sheetCalls().length, 1); assert.equal(h.imgCalls().length, 10);
    let st = m.imageStats();
    assert.equal(st.linkDown, true); assert.equal(st.linkDowns, 1); assert.equal(st.linkDownSince, T0); assert.equal(st.linkFails, 11);
    assert.equal(st.held, 0); assert.equal(st.heldN, 0); assert.equal(st.failed, 0); assert.equal(st.dead, 0);
    assert.equal(st.sheetsOff, false, "a sheet that could not reach the server does not switch sheets off");
    assert.equal(st.sheetsCoolUntil, 0, "nor cool them down: it is the link");
    assert.equal(st.queued, 50, "every source back in the queue"); assert.equal(st.inflight, 0);
    // the renderer wants them every frame: nothing starts
    for (let k = 0; k < 100; k++) for (let i = 0; i < 40; i++) assert.equal(m.imageFor(S(i), 40), null);
    await settle();
    assert.equal(h.calls.length, 11);
    for (let i = 0; i < 40; i++) assert.equal(m.imageFailed(S(i)), false);
    const n0 = h.calls.length;
    await advance(m.LINK_PROBE_MS - 1); assert.equal(h.calls.length, n0, "no probe before LINK_PROBE_MS");
    await advance(1); assert.equal(h.calls.length, n0 + 1, "probe 1, 1 s after the link went down");
    const p1 = h.calls[n0];
    assert.equal(p1.url, "/api/health", "the probe asks the API's health, never a logo (no download behind it, no source its own probe)");
    assert.equal(p1.cache, "no-store", "past every cache: only the server can answer a probe");
    for (const c of h.calls.slice(0, n0)) assert.equal(c.cache, undefined, "logo loads use the cache as before");
    await advance(1_999); assert.equal(h.calls.length, n0 + 1);
    await advance(1); assert.equal(h.calls.length, n0 + 2, "probe 2, 2 s later");
    await advance(2_999); assert.equal(h.calls.length, n0 + 2);
    await advance(1); assert.equal(h.calls.length, n0 + 3, "probe 3, 3 s later: the cap");
    // 30 min more (past the whole old ladder, 10 s + 30 s + 2 min + 10 min, and DEAD_MS): one probe per 3 s, nothing else
    for (let t = 0; t < 30 * 60_000; t += 3_000) await advance(3_000);
    const probes = h.calls.length - n0;
    assert.equal(probes, 3 + 600);
    assert.ok(h.calls.slice(n0).every((c) => c.url === "/api/health" && c.cache === "no-store"), "only probes");
    st = m.imageStats();
    assert.equal(st.probes, probes); assert.equal(st.linkDown, true); assert.equal(st.linkDowns, 1);
    assert.equal(st.held, 0); assert.equal(st.heldN, 0); assert.equal(st.dead, 0); assert.equal(st.failed, 0); assert.equal(st.retried, 0);
    assert.equal(st.sheetsOff, false); assert.equal(st.queued, 50); assert.equal(st.ready, 0);
    // the server is back: the next probe answers, and everything goes in the same instant
    down = false;
    const n1 = h.calls.length;
    await advance(3_000);
    assert.equal(h.calls.length - n1, 12, "the probe, then at once one sheet for the 40 and the 10 singles");
    assert.equal(h.sheetCalls().length, 2);
    await until(() => m.imageStats().ready === 50);
    st = m.imageStats();
    assert.equal(st.linkDown, false); assert.equal(st.linkDownSince, 0); assert.equal(st.linkRecoveries, 1);
    assert.equal(st.heldN, 0); assert.equal(st.dead, 0); assert.equal(st.sheetsOff, false); assert.equal(st.sheets, 1);
    await advance(60_000);
    assert.equal(h.calls.length - n1, 12, "nothing more: no probe once the link is up");
  } finally { off(); }
});

test("the queue resumes at the probe's answer (its headers): the probe's body is dropped unread", async () => {
  const off = clock();
  try {
    let down = true, cancelled = 0;
    const slowHealth = () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { status: 200, headers: { "content-type": "application/json" } });
    const h = await fresh({ img: () => (down ? refused() : imgResponse()), health: () => (down ? refused() : slowHealth()) });
    const { m } = h;
    for (let i = 0; i < 10; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(m.imageStats().linkDown, true);
    down = false;
    await advance(1_000);
    assert.equal(m.imageStats().linkDown, false, "up at the probe's headers, its body never comes");
    assert.equal(cancelled, 1, "the probe's body is dropped (its connection freed)");
    assert.equal(h.imgCalls().length, 10 + 10, "all ten started again at once");
    await until(() => m.imageStats().ready === 10);
  } finally { off(); }
});

for (const [name, outage] of [
  ["vite preview's 502 text/plain", vite502],
  ["Cloudflare's 522 page", () => cf(522)],
  ["Cloudflare's 520 page", () => cf(520)],
] as [string, () => Response][]) {
  test(`${name} is the link's too: the sources go back in the queue, a probe answer brings them all`, async () => {
    const off = clock();
    try {
      let down = true;
      const h = await fresh({ img: () => (down ? outage() : imgResponse()), sheet: (mints) => (down ? outage() : ALL(mints)) });
      const { m } = h;
      m.registerLogoMints(nodes(12));
      for (let i = 0; i < 12; i++) m.imageFor(S(i), 40);
      m.imageFor(S("solo"), 40);
      await settle();
      let st = m.imageStats();
      assert.equal(st.linkDown, true); assert.equal(st.held, 0); assert.equal(st.queued, 13); assert.equal(st.sheetsOff, false);
      for (const ms of [1_000, 2_000, 3_000]) await advance(ms);   // (one probe per tick: the next is armed once it failed)
      assert.equal(m.imageStats().probes, 3);
      down = false;
      await advance(3_000);
      await until(() => m.imageStats().ready === 13);
      st = m.imageStats();
      assert.equal(st.heldN, 0); assert.equal(st.dead, 0); assert.equal(st.linkRecoveries, 1); assert.equal(st.sheets, 1);
    } finally { off(); }
  });
}

test("a source held (the API's 503) or dead (404) before the outage keeps its retry steps and its dead time: 20 min of link failures cost it nothing", async () => {
  const off = clock();
  try {
    let down = false, aN = 0;
    const h = await fresh({
      img: (url) => {
        if (down) return refused();
        if (url.includes("held")) { aN++; return aN <= 2 ? api(503) : imgResponse(); }
        if (url.includes("gone")) return api(404);
        return imgResponse();
      },
    });
    const { m } = h;
    const A = S("held"), B = S("gone");
    m.imageFor(A, 40); m.imageFor(B, 40);
    await settle();
    let st = m.imageStats();
    assert.equal(st.held, 1, "A: the API's 503 is held (step 0, 10 s)"); assert.equal(st.heldN, 1);
    assert.equal(m.imageFailed(B), true, "B: a 404 is dead"); assert.equal(m.imageRetryAt(B), T0 + m.DEAD_MS);
    down = true;
    await advance(m.RETRY_STEPS_MS[0]);   // A's retry meets the outage
    st = m.imageStats();
    assert.equal(st.linkDown, true); assert.equal(st.held, 0, "A is not held for the link"); assert.equal(st.queued, 1); assert.equal(st.heldN, 1);
    for (let t = 0; t < 20 * 60_000; t += 1_000) { await advance(1_000); if (t % 60_000 === 0) assert.equal(m.imageFailed(A), false); }
    st = m.imageStats();
    assert.equal(st.heldN, 1); assert.equal(st.dead, 1, "B's death only"); assert.equal(st.failed, 0, "B's dead time ran out meanwhile");
    assert.equal(h.callsOf("gone").length, 1, "B was never asked: nobody wanted it");
    assert.ok(st.probes >= 390, `one probe per step all along (${st.probes})`);
    down = false;
    await advance(3_000);   // the next probe is answered, A goes again: the API's 503, step 1 (30 s): its link failure took none
    st = m.imageStats();
    assert.equal(st.linkDown, false); assert.equal(st.held, 1); assert.equal(st.heldN, 2);
    const asked = h.callsOf("held").length, at = h.callsOf("held")[asked - 1].t;
    await advance(at + m.RETRY_STEPS_MS[1] - 1 - Date.now());
    assert.equal(h.callsOf("held").length, asked, "step 1 is 30 s");
    await advance(1);
    await until(() => m.imageReady(A));
    assert.equal(m.imageStats().dead, 1);
  } finally { off(); }
});

// (2026-11-11) in a draft of this change the probe was a queued logo, and a probe's failure never counted against its source: one URL that always failed
// like this was the probe every time and held the link down for good (1,201 requests an hour, every new view waiting ~3 s)
test("a source that fails like an unreachable server on its own does not hold the link down: the probe (never that source) is answered, so its first failure is forgiven, then it takes its retry steps (the link in doubt one probe step each) and dies; a new view meanwhile loads at once", async () => {
  const off = clock();
  try {
    const h = await fresh({ img: (url) => (url.includes("bad") ? refused() : imgResponse()) });
    const { m } = h;
    for (let i = 0; i < 3; i++) m.imageFor(S(`good${i}`), 40);
    await until(() => m.imageStats().ready === 3);
    const BAD = S("bad");
    m.imageFor(BAD, 40);
    await settle();
    let st = m.imageStats();
    assert.equal(st.linkDown, true, "first: the link is in doubt"); assert.equal(st.linkDowns, 1);
    await advance(m.LINK_PROBE_MS);   // the probe is answered: BAD's first failure is forgiven, it goes again at once, and fails
    st = m.imageStats();
    assert.equal(st.heldN, 0, "forgiven (a connection reset while the server answers)"); assert.equal(h.callsOf("bad").length, 2);
    assert.equal(st.linkDown, true); assert.equal(st.linkDowns, 2); assert.equal(st.linkRecoveries, 1);
    await advance(m.LINK_PROBE_MS);   // answered again: BAD's own failure, step 0
    st = m.imageStats();
    assert.equal(st.linkDown, false); assert.equal(st.held, 1); assert.equal(st.heldN, 1);
    m.imageFor(S("view"), 40);   // a new view while BAD waits out its step: at once
    await settle();
    assert.equal(h.callsOf("view").length, 1); assert.ok(m.imageReady(S("view")));
    for (let k = 1; k < m.RETRY_STEPS_MS.length; k++) {
      await advance(m.RETRY_STEPS_MS[k - 1]);   // the retry fails: the link in doubt until the next probe
      assert.equal(m.imageStats().linkDown, true, `retry ${k}`);
      await advance(m.LINK_PROBE_MS);
      st = m.imageStats();
      assert.equal(st.linkDown, false, `retry ${k}: the probe brings the link back`); assert.equal(st.held, 1); assert.equal(st.heldN, k + 1);
    }
    await advance(m.RETRY_STEPS_MS[m.RETRY_STEPS_MS.length - 1]);
    await advance(m.LINK_PROBE_MS);
    assert.equal(m.imageFailed(BAD), true, "past the last step: dead, as any temporary failure of its own");
    st = m.imageStats();
    assert.equal(st.linkDown, false); assert.equal(st.ready, 4); assert.equal(st.heldN, m.RETRY_STEPS_MS.length);
    assert.equal(h.callsOf("bad").length, 2 + m.RETRY_STEPS_MS.length);
    assert.equal(h.healthCalls().length, st.probes); assert.equal(st.probes, 2 + m.RETRY_STEPS_MS.length);
  } finally { off(); }
});

for (const [name, bad] of [
  ["a blocked or reset request", refused],
  ["a proxy's 502 page for that one URL", () => cf(502)],
] as [string, () => Response][]) {
  test(`one URL that always fails like an unreachable server (${name}) while the server answers: at most 8 requests an hour, the link in doubt about a probe step per failure`, async () => {
    const off = clock();
    try {
      const h = await fresh({ img: (url) => (url.includes("bad") ? bad() : imgResponse()) });
      const { m } = h;
      for (let i = 0; i < 10; i++) m.imageFor(S(`good${i}`), 40);
      await until(() => m.imageStats().ready === 10);
      const BAD = S("bad");
      let downMs = 0;
      for (let t = 0; t < 3_600_000; t += 1_000) {
        m.imageFor(BAD, 40);   // the renderer asks every frame while it is pending
        await advance(1_000);
        if (m.imageStats().linkDown) downMs += 1_000;
      }
      const st = m.imageStats(), n = h.callsOf("bad").length;
      assert.ok(n <= 8, `${n} requests for one broken logo in an hour (the loader before this change: 7; a draft of this change: 1,201)`);
      assert.equal(m.imageFailed(BAD), true);
      assert.ok(downMs <= n * 1_000, `the link in doubt ${downMs} ms of the hour`);
      assert.equal(st.probes, h.healthCalls().length); assert.ok(st.probes <= n);
      assert.equal(st.linkDown, false); assert.equal(st.ready, 10);
    } finally { off(); }
  });
}

test("sheets survive the link: a sheet that cannot reach the server neither switches sheets off nor cools them down, and the next sheet carries its sources", async () => {
  const off = clock();
  try {
    let down = true;
    const h = await fresh({ img: () => (down ? refused() : imgResponse()), sheet: (mints) => (down ? refused() : ALL(mints)) });
    const { m } = h;
    m.registerLogoMints(nodes(400));
    for (let i = 0; i < 400; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(h.sheetCalls().length, 3, "three sheets in flight, all refused");
    let st = m.imageStats();
    assert.equal(st.sheetsOff, false); assert.equal(st.sheetsCoolUntil, 0); assert.equal(st.linkDowns, 1); assert.equal(st.queued, 400);
    await advance(1_000);   // the first probe gets no answer: the sheets' failures were the outage's
    down = false;
    await advance(2_000);
    await until(() => m.imageStats().ready === 400);
    st = m.imageStats();
    assert.equal(st.sheets, 4, "the 400 in sheets again (128 + 128 + 128 + 16)"); assert.equal(h.healthCalls().length, 2, "two probes");
    assert.equal(h.imgCalls().length, 0, "no logo went one by one");
    assert.equal(st.sheetsOff, false); assert.equal(st.sheetCools, 0); assert.equal(st.heldN, 0);
  } finally { off(); }
});

for (const [name, bad] of [
  ["the API's 500 (sheet failed)", () => api(500)],
  ["a sheet that does not decode", (mints: string[]) => new Response("BROKEN", { status: 200, headers: sheetHeaders(mints.length, hexOf(mints.length, () => true)) })],
  ["a sheet whose x-sheet-n does not match the batch", (mints: string[]) => new Response(`SHEET:${mints.length + 1}`, { status: 200, headers: sheetHeaders(mints.length + 1, hexOf(mints.length + 1, () => true)) })],
] as [string, (mints: string[]) => Response][]) {
  test(`${name} cools sheets down (no switch-off, the link stays up): the sources go per request, sheets come back after SHEET_COOL_MS`, async () => {
    const off = clock();
    try {
      let n = 0;
      const h = await fresh({ sheet: (mints) => (++n === 1 ? bad(mints) : ALL(mints)) });
      const { m } = h;
      m.registerLogoMints(nodes(24));
      for (let i = 0; i < 8; i++) m.imageFor(S(i), 40);
      await until(() => m.imageStats().ready === 8);
      assert.equal(h.sheetCalls().length, 1); assert.equal(h.imgCalls().length, 8, "per request at once");
      let st = m.imageStats();
      assert.equal(st.sheetsOff, false); assert.equal(st.sheetCools, 1); assert.equal(st.sheetsCoolUntil, T0 + m.SHEET_COOL_MS);
      assert.equal(st.linkDown, false); assert.equal(st.linkDowns, 0); assert.equal(st.heldN, 0); assert.equal(st.dead, 0);
      await advance(m.SHEET_COOL_MS - 1);
      for (let i = 8; i < 16; i++) m.imageFor(S(i), 40);
      await until(() => m.imageStats().ready === 16);
      assert.equal(h.sheetCalls().length, 1, "still cooling: per request"); assert.equal(h.imgCalls().length, 16);
      await advance(1);
      for (let i = 16; i < 24; i++) m.imageFor(S(i), 40);
      await until(() => m.imageStats().ready === 24);
      assert.equal(h.sheetCalls().length, 2, "the cooldown is over: a sheet again"); assert.equal(h.imgCalls().length, 16);
      st = m.imageStats();
      assert.equal(st.sheetsCoolUntil, 0); assert.equal(st.sheets, 1);
    } finally { off(); }
  });
}

test("cooldowns in a row double (15 s, 30 s, ... at most SHEET_COOL_MAX_MS); a good sheet starts them over; a longer Retry-After is honoured", async () => {
  const off = clock();
  try {
    const plan: ("bad" | "ok" | "ra")[] = ["bad", "bad", "bad", "ok", "bad", "ra"];
    let n = 0;
    const h = await fresh({ sheet: (mints) => { const p = plan[n++] ?? "ok"; return p === "ok" ? ALL(mints) : p === "ra" ? api(503, { "retry-after": "120" }) : api(500); } });
    const { m } = h;
    m.registerLogoMints(nodes(200));
    let k = 0;
    const batch = async () => { const from = k; for (; k < from + 4; k++) m.imageFor(S(k), 40); await until(() => m.imageStats().ready === k); };
    const waits: number[] = [];
    for (let r = 0; r < plan.length; r++) {
      await batch();
      const until0 = m.imageStats().sheetsCoolUntil;
      waits.push(until0 ? until0 - Date.now() : 0);
      if (until0) await advance(until0 - Date.now());
    }
    assert.deepEqual(waits, [15_000, 30_000, 60_000, 0, 15_000, 120_000], "doubling, reset by a good sheet; Retry-After 120 s > 30 s");
    assert.equal(h.sheetCalls().length, plan.length);
    assert.equal(m.imageStats().sheetsOff, false);
    assert.equal(m.SHEET_COOL_MAX_MS, 5 * 60_000);
  } finally { off(); }
});

// (2026-11-11) until then the route was blamed at its SHEET_FAIL_MAX-th such failure with the link back in between, which an
// outage an hour later, or a flap right after a probe answered, also was (a cooldown for a server that was down)
test("the sheet route failing like an unreachable server while the server answers: each failure is judged by the next probe (answered: the route's own), the SHEET_FAIL_MAX-th in a row cools sheets down, never sheets off", async () => {
  const off = clock();
  try {
    const h = await fresh({ sheet: () => vite502() });
    const { m } = h;
    m.registerLogoMints(nodes(16));
    for (let i = 0; i < 8; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(m.imageStats().linkDown, true, "the first 502: the link is in doubt");
    await advance(m.LINK_PROBE_MS);   // the probe is answered: the route's failure, 1 of SHEET_FAIL_MAX; the next sheet fails the same way
    let st = m.imageStats();
    assert.equal(h.sheetCalls().length, 2); assert.equal(st.linkDown, true); assert.equal(st.linkDowns, 2); assert.equal(st.sheetCools, 0);
    await advance(m.LINK_PROBE_MS);   // answered again: the second in a row, sheets cool down, the 8 go per request
    await until(() => m.imageStats().ready === 8);
    st = m.imageStats();
    assert.equal(h.sheetCalls().length, 2); assert.equal(h.imgCalls().length, 8, "per request"); assert.equal(h.healthCalls().length, 2);
    assert.equal(st.linkDown, false); assert.equal(st.sheetCools, 1); assert.equal(st.sheetsOff, false); assert.equal(st.heldN, 0);
    assert.equal(st.sheetsCoolUntil, Date.now() + m.SHEET_COOL_MS);
    await advance(m.SHEET_COOL_MS);
    for (let i = 8; i < 16; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(h.sheetCalls().length, 3, "tried again after the cooldown");
    await advance(m.LINK_PROBE_MS);   // still failing, and no good sheet in between: cooled again at once
    await until(() => m.imageStats().ready === 16);
    st = m.imageStats();
    assert.equal(st.sheetCools, 2); assert.equal(st.sheetsCoolUntil, Date.now() + 2 * m.SHEET_COOL_MS, "doubled");
    assert.equal(st.linkDowns, 3, "the link in doubt one probe step per failed sheet"); assert.equal(st.sheetsOff, false);
  } finally { off(); }
});

test("a sheet that cannot reach a server that is down never cools sheets down, however the outages follow each other (a flap right after a probe was answered, another outage an hour later): only a failure an answered probe proves the route's own counts", async () => {
  const off = clock();
  try {
    let down = true, flap = 1;
    // the server answers one request after the outage (the probe), then drops again before the burst's sheet is answered
    const serve = (ok: () => Response): Response => { if (down) refused(); if (flap > 0) { flap--; down = true; } return ok(); };
    const h = await fresh({ img: () => serve(imgResponse), sheet: (mints) => (down ? refused() : ALL(mints)), health: () => serve(healthy) });
    const { m } = h;
    m.registerLogoMints(nodes(60));
    for (let i = 0; i < 40; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(m.imageStats().linkDown, true);
    await advance(1_000);   // probe 1: no answer
    down = false;
    await advance(2_000);   // probe 2 is answered, the server drops at once, the burst's sheet fails: the link down again
    let st = m.imageStats();
    assert.equal(h.sheetCalls().length, 2); assert.equal(st.linkDown, true); assert.equal(st.linkDowns, 2); assert.equal(st.sheetCools, 0);
    await advance(1_000);   // probe 3: no answer, the sheet's failure was the outage's
    down = false;
    await advance(2_000);
    await until(() => m.imageStats().ready === 40);
    st = m.imageStats();
    assert.equal(st.sheetCools, 0, "a flap is no failure of the sheet route"); assert.equal(h.sheetCalls().length, 3); assert.equal(h.imgCalls().length, 0);
    await advance(3_600_000);   // an hour later another outage hits a sheet first
    down = true;
    for (let i = 40; i < 60; i++) m.imageFor(S(i), 40);
    await settle();
    await advance(1_000);
    down = false;
    await advance(2_000);
    await until(() => m.imageStats().ready === 60);
    st = m.imageStats();
    assert.equal(st.sheetCools, 0); assert.equal(st.sheetsCoolUntil, 0); assert.equal(h.imgCalls().length, 0, "every recovery in sheets");
    assert.equal(st.heldN, 0); assert.equal(st.dead, 0); assert.equal(st.linkDowns, 3);
  } finally { off(); }
});

test("a 429 pauses every start until its Retry-After (singles, sheets and the source itself), costs no retry step and is no death", async () => {
  const off = clock();
  try {
    let n = 0;
    const h = await fresh({ img: () => (++n === 1 ? api(429, { "retry-after": "5" }) : imgResponse()), sheet: (mints) => ALL(mints) });
    const { m } = h;
    m.imageFor(S("first"), 40);
    await settle();
    let st = m.imageStats();
    assert.equal(st.pausedUntil, T0 + 5_000); assert.equal(st.pauses, 1); assert.equal(st.e429, 1);
    assert.equal(st.held, 0); assert.equal(st.queued, 1, "back in the queue"); assert.equal(st.linkDown, false);
    m.registerLogoMints(nodes(8));
    for (let i = 0; i < 8; i++) m.imageFor(S(i), 40);
    for (let i = 0; i < 5; i++) m.imageFor(S(`solo${i}`), 40);
    await advance(4_999);
    assert.equal(h.calls.length, 1, "nothing starts during the pause");
    await advance(1);
    assert.equal(h.sheetCalls().length, 1); assert.equal(h.imgCalls().length, 1 + 6, "after it: the sheet and every single at once");
    await until(() => m.imageStats().ready === 14);
    st = m.imageStats();
    assert.equal(st.heldN, 0); assert.equal(st.dead, 0); assert.equal(st.pausedUntil, 0);
  } finally { off(); }
});

test("429s without Retry-After: PAUSE_MS doubling per pause in a row up to PAUSE_MAX_MS, never a death; a sheet's 429 pauses the singles too", async () => {
  const off = clock();
  try {
    const N429 = 9;
    let n = 0, s429 = 0;
    const h = await fresh({ img: (url) => (url.includes("hot") && ++n <= N429 ? api(429) : imgResponse()), sheet: (mints) => (mints.includes(M(100)) && ++s429 === 1 ? api(429, { "retry-after": "3" }) : ALL(mints)) });
    const { m } = h;
    const HOT = S("hot");
    m.imageFor(HOT, 40);
    await settle();
    const waits: number[] = [];
    while (!m.imageReady(HOT)) {
      const p = m.imageStats().pausedUntil;
      assert.ok(p > 0);
      waits.push(p - Date.now());
      assert.equal(m.imageFailed(HOT), false);
      await advance(p - Date.now());
    }
    assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
    let st = m.imageStats();
    assert.equal(st.pauses, N429); assert.equal(st.e429, N429); assert.equal(st.heldN, 0); assert.equal(st.dead, 0);
    // now a sheet's 429 (Retry-After 3 s: honoured whatever the run) holds back a single wanted after it
    m.registerLogoMints(nodes(4, 100));
    for (let i = 100; i < 104; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(m.imageStats().pausedUntil, Date.now() + 3_000);
    m.imageFor(S("later"), 40);
    await advance(2_999);
    assert.equal(h.callsOf("later").length, 0, "paused");
    await advance(1);
    assert.equal(h.callsOf("later").length, 1);
    st = m.imageStats();
    assert.equal(st.pauses, N429 + 1);
  } finally { off(); }
});

// (2026-11-11) any load started the doubling over, and a logo from the browser's cache is a load: with half the wants cached
// the pause never grew past 4 s (16,866 requests into such a limiter in 10 min instead of 1,232)
test("the PAUSE_MS doubling is not started over by a load between the 429s (it may come from the browser's cache, which says nothing about the limiter); PAUSE_MAX_MS without a 429 starts it over", async () => {
  const off = clock();
  try {
    let limited = true;
    // a CDN's limiter: 429 HTML without Retry-After for whatever reaches it; a cached logo never reaches it
    const cdn429 = () => new Response("<html>slow down</html>", { status: 429, headers: { "content-type": "text/html" } });
    const h = await fresh({ img: (url) => (url.includes("cached") ? imgResponse() : limited ? cdn429() : imgResponse()) });
    const { m } = h;
    m.imageFor(S("net"), 40);
    await settle();
    const waits: number[] = [];
    for (let r = 0; r < 7; r++) {
      const p = m.imageStats().pausedUntil;
      waits.push(p - Date.now());
      m.imageFor(S(`cached${r}`), 40);   // loads (from the cache) the moment the pause ends, beside the next 429
      await advance(p - Date.now());
      assert.ok(m.imageReady(S(`cached${r}`)), `cached${r}`);
    }
    assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000], "doubling, cached loads or not");
    limited = false;
    await advance(m.PAUSE_MAX_MS);   // the 8th pause ends, "net" loads
    await until(() => m.imageReady(S("net")));
    await advance(m.PAUSE_MAX_MS + 1);
    limited = true;
    m.imageFor(S("net2"), 40);
    await settle();
    assert.equal(m.imageStats().pausedUntil - Date.now(), m.PAUSE_MS, "PAUSE_MAX_MS without a 429: back to PAUSE_MS");
    const st = m.imageStats();
    assert.equal(st.pauses, 9); assert.equal(st.heldN, 0); assert.equal(st.dead, 0);
  } finally { off(); }
});

// (2026-11-11) in a draft of this change the probe was a logo: its 429 put the link up and pumped the queue before failLater set the pause (99 requests
// into a limiter that had just said "30 s")
test("a probe answered with a 429 + Retry-After pauses every start before the link goes up: only the probe went out, everything follows the Retry-After", async () => {
  const off = clock();
  try {
    let phase: "down" | "limited" | "up" = "down";
    const limit = () => api(429, { "retry-after": "30" });
    const h = await fresh({
      img: () => (phase === "down" ? refused() : phase === "limited" ? limit() : imgResponse()),
      sheet: (mints) => (phase === "down" ? refused() : phase === "limited" ? limit() : ALL(mints)),
      health: () => (phase === "down" ? refused() : phase === "limited" ? limit() : healthy()),
    });
    const { m } = h;
    m.registerLogoMints(nodes(300));
    for (let i = 0; i < 300; i++) m.imageFor(S(i), 40);
    for (let i = 0; i < 150; i++) m.imageFor(S(`solo${i}`), 40);
    await settle();
    assert.equal(m.imageStats().linkDown, true);
    phase = "limited";
    const n0 = h.calls.length;
    await advance(m.LINK_PROBE_MS);
    let st = m.imageStats();
    assert.equal(h.calls.length - n0, 1, "only the probe");
    assert.equal(st.linkDown, false, "the server answered"); assert.equal(st.pausedUntil, Date.now() + 30_000); assert.equal(st.e429, 1);
    phase = "up";
    await advance(29_999);
    assert.equal(h.calls.length - n0, 1, "nothing before the Retry-After");
    await advance(1);
    await until(() => m.imageStats().ready === 450);
    st = m.imageStats();
    assert.equal(st.heldN, 0); assert.equal(st.dead, 0); assert.equal(st.sheets, 3, "128 + 128 + 44");
  } finally { off(); }
});

test("a window that is online again, or a page shown again, probes a link that is down at once (and its steps start over); a link that is up is left alone", async () => {
  const off = clock();
  try {
    let down = true;
    const h = await fresh({ img: () => (down ? refused() : imgResponse()) });
    const { m } = h;
    m.imageFor(S("a"), 40);
    await settle();
    for (const ms of [1_000, 2_000, 3_000]) await advance(ms);
    assert.equal(m.imageStats().probes, 3, "at the cap: the next probe would come 3 s on");
    down = false;
    h.fire("online");
    await settle();
    assert.equal(m.imageStats().probes, 4, "online: at once");
    await until(() => m.imageReady(S("a")));
    const n = h.calls.length;
    h.fire("online"); h.fire("visibilitychange");
    await settle();
    assert.equal(h.calls.length, n, "the link is up: nothing to probe");
    // down again, and the page is hidden meanwhile
    down = true;
    m.imageFor(S("b"), 40);
    await settle();
    assert.equal(m.imageStats().linkDown, true);
    await advance(1_000);
    assert.equal(m.imageStats().probes, 5);
    down = false;
    h.doc.visibilityState = "hidden";
    h.fire("visibilitychange");
    await settle();
    assert.equal(m.imageStats().probes, 5, "hidden: no probe");
    h.doc.visibilityState = "visible";
    h.fire("visibilitychange");
    await settle();
    assert.equal(m.imageStats().probes, 6, "shown again: at once");
    await until(() => m.imageReady(S("b")));
    assert.equal(m.imageStats().linkRecoveries, 2);
  } finally { off(); }
});

test("one probe at a time: a probe that hangs is cut at LINK_PROBE_TIMEOUT_MS (the next one waits its step); timers: one at most while down, none once nothing waits", async () => {
  const off = clock();
  const spy = liveTimers();
  try {
    let phase: "refuse" | "hang" | "up" = "refuse";
    const h = await fresh({ img: (_url, signal) => (phase === "refuse" ? refused() : phase === "hang" ? hang(signal) : imgResponse()) });
    const { m } = h;
    assert.equal(spy.n(), 0);
    m.imageFor(S("x"), 40);
    await settle();
    assert.equal(m.imageStats().linkDown, true);
    assert.deepEqual(spy.delays(), [1_000], "the probe timer only");
    phase = "hang";
    await advance(1_000);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(spy.delays(), [m.LINK_PROBE_TIMEOUT_MS], "a probe in flight: its time limit, no probe timer");
    await advance(m.LINK_PROBE_TIMEOUT_MS - 1);
    assert.equal(h.calls.length, 2, "one probe at a time");
    await advance(1);
    assert.deepEqual(spy.delays(), [2_000], "cut: the next probe one step later");
    let st = m.imageStats();
    assert.equal(st.heldN, 0, "a probe that got no answer costs the source nothing"); assert.equal(st.linkDown, true); assert.equal(st.queued, 1);
    phase = "up";
    await advance(2_000);
    await until(() => m.imageReady(S("x")));
    st = m.imageStats();
    assert.equal(st.linkDown, false); assert.equal(st.probes, 2); assert.deepEqual(h.urls(), [`${S("x")}&w=64`, "/api/health", "/api/health", `${S("x")}&w=64`]);
    assert.equal(spy.n(), 0, "nothing waits: no timer left");
    await advance(10 * 60_000);
    assert.equal(h.calls.length, 4);
  } finally { spy.restore(); off(); }
});

// (2026-11-11) with a draft of this change a hidden tab probed every 3 s for as long as the outage lasted (9,600 probes in 8 h) and sent its whole queue the
// moment the server was back, for logos nobody saw
test("a hidden page does not probe: an hour of outage while hidden costs no request, nor does the server coming back; shown again it probes at once and everything goes", async () => {
  const off = clock();
  const spy = liveTimers();
  try {
    let down = true;
    const h = await fresh({ img: () => (down ? refused() : imgResponse()) });
    const { m } = h;
    for (let i = 0; i < 10; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(m.imageStats().linkDown, true);
    h.doc.visibilityState = "hidden"; h.fire("visibilitychange");
    const n0 = h.calls.length;
    for (let t = 0; t < 3_600_000; t += 60_000) await advance(60_000);
    assert.equal(h.calls.length, n0, "hidden: no probe");
    assert.equal(spy.n(), 0, "and no timer");
    m.imageFor(S("more"), 40);   // a want while hidden (a frame drawn before the tab went away): it waits, no probe timer
    await settle();
    assert.equal(spy.n(), 0, "no probe timer is armed while hidden"); assert.equal(h.calls.length, n0);
    down = false;
    for (let t = 0; t < 60_000; t += 1_000) await advance(1_000);
    assert.equal(h.calls.length, n0, "the server back while hidden: nothing either");
    h.doc.visibilityState = "visible"; h.fire("visibilitychange");
    await until(() => m.imageStats().ready === 11);
    const st = m.imageStats();
    assert.equal(st.probes, 1); assert.equal(st.linkRecoveries, 1); assert.equal(st.heldN, 0); assert.equal(st.linkDown, false);
  } finally { spy.restore(); off(); }
});

test("only our API answers the probe (JSON): a page in its place (a captive portal's 200, a CDN's 403 or 429 HTML) keeps the link down and charges nothing", async () => {
  const off = clock();
  try {
    let phase: "page" | "up" = "page", k = 0;
    const page = () => new Response("<html>sign in to continue</html>", { status: [200, 403, 429][k++ % 3], headers: { "content-type": "text/html" } });
    const h = await fresh({ img: () => (phase === "page" ? refused() : imgResponse()), health: () => (phase === "page" ? page() : healthy()) });
    const { m } = h;
    for (let i = 0; i < 6; i++) m.imageFor(S(i), 40);
    await settle();
    for (let t = 0; t < 10 * 60_000; t += 1_000) await advance(1_000);
    let st = m.imageStats();
    assert.equal(st.linkDown, true); assert.equal(st.linkRecoveries, 0); assert.ok(st.probes >= 190, String(st.probes));
    assert.equal(st.heldN, 0); assert.equal(st.dead, 0); assert.equal(st.pausedUntil, 0, "a page's 429 is no answer of our limiter either");
    assert.equal(h.imgCalls().length, 6, "no logo was asked again");
    phase = "up";
    await advance(m.LINK_PROBE_MAX_MS);
    await until(() => m.imageStats().ready === 6);
    st = m.imageStats();
    assert.equal(st.linkRecoveries, 1); assert.equal(st.heldN, 0);
  } finally { off(); }
});

// (2026-11-11) in a draft of this change the probe was a queued logo: one the server first had to download held the recovery 7-16 s
test("the probe waits for no logo download: back from a 30 s outage, the first logo asked is one the server must first fetch (12 s); the nine others are drawn within a probe step, that one when it is fetched", async () => {
  const off = clock();
  try {
    let down = true, pick = "";
    const h = await fresh({
      img: (url, signal) => {
        if (down) return refused();
        if (!pick) pick = url;   // the first logo asked once the server is back (a draft's probe): a cold one
        return url === pick ? later(12_000, signal, imgResponse) : imgResponse();
      },
      health: () => (down ? refused() : healthy()),
    });
    const { m } = h;
    for (let i = 0; i < 10; i++) m.imageFor(S(i), 40);
    await settle();
    for (let t = 0; t < 30_000; t += 1_000) await advance(1_000);   // a 30 s outage
    down = false;
    const t0 = Date.now();
    await advance(m.LINK_PROBE_MAX_MS);
    await until(() => m.imageStats().ready === 9);
    assert.ok(Date.now() - t0 <= m.LINK_PROBE_MAX_MS, `${Date.now() - t0} ms`);
    assert.equal(m.imageReady(pick.replace(/&w=\d+$/, "")), false, "the cold one is still being fetched");
    await advance(12_000);
    await until(() => m.imageStats().ready === 10);
    assert.equal(m.imageStats().heldN, 0); assert.equal(m.imageStats().probes, h.healthCalls().length);
  } finally { off(); }
});

// (2026-11-11) a draft of this change blamed a failure on its source when that source had failed like this before the link last
// came back: a second outage during the recovery burst left the link "up" and walked every source of the burst to DEAD
test("an outage that starts again while the recovery is in flight (a crash loop, two restarts in a row) is the link's too: down again at once, no step, no death, no cooldown; back for good, everything is drawn within a probe step", async () => {
  const off = clock();
  try {
    let mode: "down" | "slow" | "up" = "down";
    const pend: ((e: unknown) => void)[] = [];
    // "slow": the server is back but has not answered the burst yet (cold logos, a sheet being drawn) when it dies again
    const slow = () => new Promise<Response>((_, rej) => { pend.push(rej); });
    const h = await fresh({
      img: () => (mode === "down" ? refused() : mode === "slow" ? slow() : imgResponse()),
      sheet: (mints) => (mode === "down" ? refused() : mode === "slow" ? slow() : ALL(mints)),
      health: () => (mode === "down" ? refused() : healthy()),
    });
    const { m } = h;
    m.registerLogoMints(nodes(12));
    for (let i = 0; i < 12; i++) m.imageFor(S(i), 40);
    for (let i = 0; i < 4; i++) m.imageFor(S(`solo${i}`), 40);
    await settle();
    for (let t = 0; t < 2 * 60_000; t += 1_000) await advance(1_000);   // outage 1: 2 min
    mode = "slow";
    await advance(m.LINK_PROBE_MAX_MS);   // the probe is answered: the burst goes, and is still in flight ...
    let st = m.imageStats();
    assert.equal(st.linkDown, false); assert.equal(st.linkRecoveries, 1); assert.equal(st.inflight, 16); assert.equal(pend.length, 5, "one sheet, four singles");
    mode = "down";   // ... when the server dies again: its connections are reset
    for (const rej of pend.splice(0)) rej(new TypeError("Failed to fetch"));
    await settle();
    st = m.imageStats();
    assert.equal(st.linkDown, true, "down again at once: the next probe judges these failures"); assert.equal(st.linkDowns, 2);
    assert.equal(st.held, 0); assert.equal(st.queued, 16); assert.equal(st.sheetCools, 0);
    for (let t = 0; t < 20 * 60_000; t += 1_000) await advance(1_000);   // outage 2: 20 min, past the whole ladder and DEAD_MS
    st = m.imageStats();
    assert.equal(st.heldN, 0, "no retry step for an outage"); assert.equal(st.dead, 0, "no death"); assert.equal(st.failed, 0);
    assert.equal(st.sheetCools, 0, "no cooldown: the sheet could not reach a server that was down"); assert.equal(st.sheetsOff, false);
    mode = "up";
    const t0 = Date.now();
    await advance(m.LINK_PROBE_MAX_MS);
    await until(() => m.imageStats().ready === 16);
    assert.ok(Date.now() - t0 <= m.LINK_PROBE_MAX_MS);
    st = m.imageStats();
    assert.equal(st.sheets, 1); assert.equal(st.linkRecoveries, 2); assert.equal(st.heldN, 0); assert.equal(st.dead, 0);
  } finally { off(); }
});

// (2026-11-11) a draft of this change let any answer put the link up: a logo from the browser's cache did, between two failures of
// the same sources, and their second failure was blamed on them (a retry step each, then dead; the sheet route cooled down)
test("during an outage a logo from the browser's HTTP cache does not put the link up (only the probe does): it is drawn and sends the first probe at once, and the failures around it cost nothing (no step, no death, no cooldown)", async () => {
  const off = clock();
  try {
    let down = true;
    const h = await fresh({
      // the browser's cache answers a few ms later (a disk read), whatever the server does; the probe goes past it
      img: (url, signal) => (url.includes("cached") ? later(5, signal, imgResponse) : down ? refused() : imgResponse()),
      sheet: (mints) => (down ? refused() : ALL(mints)),
      health: () => (down ? refused() : healthy()),
    });
    const { m } = h;
    m.registerLogoMints(nodes(48));
    for (let i = 0; i < 48; i++) m.imageFor(S(i), 40);   // a family: one sheet
    for (let i = 0; i < 30; i++) m.imageFor(S(i % 3 === 2 ? `cached${i}` : `net${i}`), 40);   // singles, a third of them cached
    await settle();
    let st = m.imageStats();
    assert.equal(st.linkDown, true); assert.equal(st.probes, 0);
    await advance(5);   // the cache answers
    st = m.imageStats();
    assert.equal(st.ready, 10, "the cached logos are drawn"); assert.equal(st.linkDown, true, "the link stays down");
    assert.equal(st.linkRecoveries, 0); assert.equal(st.probes, 1, "an answer while the link has just gone down probes at once");
    for (let t = 0; t < 20 * 60_000; t += 1_000) await advance(1_000);
    st = m.imageStats();
    assert.equal(st.heldN, 0); assert.equal(st.dead, 0); assert.equal(st.failed, 0); assert.equal(st.sheetCools, 0);
    assert.equal(st.linkDowns, 1); assert.equal(st.linkRecoveries, 0);
    down = false;
    await advance(m.LINK_PROBE_MAX_MS);
    await until(() => m.imageStats().ready === 78);
    st = m.imageStats();
    assert.equal(st.sheets, 1); assert.equal(st.heldN, 0); assert.equal(st.linkRecoveries, 1);
  } finally { off(); }
});

// (2026-11-11) in a draft of this change the answer's headers cleared the source's record, so a body cut every time was always "the link": it never took
// a step and took the whole loader down at every attempt (901 times in 30 min)
test("a logo whose body is cut every time (its headers answered) is judged by the probe like any failure of its own: the first forgiven, then its retry steps, then dead; the link is in doubt a probe step each time", async () => {
  const off = clock();
  try {
    const cut = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.error(new TypeError("network error")); } }), { status: 200, headers: { "content-type": "image/png" } });
    const h = await fresh({ img: (url) => (url.includes("bad") ? cut() : imgResponse()) });
    const { m } = h;
    const BAD = S("bad");
    m.imageFor(BAD, 40);
    await settle();
    assert.equal(m.imageStats().linkDown, true);
    let downMs = 0;
    for (let t = 0; t < 30 * 60_000; t += 1_000) {
      m.imageFor(BAD, 40);
      if (t === 60_000) { m.imageFor(S("view"), 40); await settle(); assert.ok(m.imageReady(S("view")), "a new view loads at once meanwhile"); }
      await advance(1_000);
      if (m.imageStats().linkDown) downMs += 1_000;
    }
    const st = m.imageStats(), n = h.callsOf("bad").length;
    assert.equal(m.imageFailed(BAD), true, "dead, as any temporary failure of its own past the ladder");
    assert.equal(st.heldN, m.RETRY_STEPS_MS.length, "every step taken");
    assert.ok(n <= 8, `${n} requests in 30 min`);
    assert.ok(downMs <= n * 1_000, `the link in doubt ${downMs} ms of 30 min`);
    assert.equal(st.linkDown, false);
  } finally { off(); }
});

test("a network error of a URL that is not our API stays that source's own temporary failure (held), the link stays up", async () => {
  const off = clock();
  try {
    let n = 0;
    const h = await fresh({ img: (url) => (url.startsWith("https://cdn.test/") && ++n === 1 ? refused() : imgResponse()) });
    const { m } = h;
    m.imageFor("https://cdn.test/x.png", 40);
    m.imageFor(S("y"), 40);
    await settle();
    const st = m.imageStats();
    assert.equal(st.linkDown, false); assert.equal(st.held, 1); assert.equal(st.ready, 1);
    await advance(m.RETRY_STEPS_MS[0]);
    await until(() => m.imageReady("https://cdn.test/x.png"));
  } finally { off(); }
});
