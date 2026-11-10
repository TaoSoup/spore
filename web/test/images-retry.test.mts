// Failures in the map image loader (src/lib/map/images.ts) are not final for the page: a temporary one (429 / 408 / 5xx, the
// server's 503 + Retry-After, a network error, a timeout) waits out RETRY_STEPS_MS (never sooner than Retry-After, plus
// jitter) and is asked again by the loader itself; wants during the wait start nothing. Past the last step, and at once for a
// 404 or a dead sheet cell, the source is dead for DEAD_MS, doubling per death (imageFailed / imageRetryAt say so, the
// listeners are told); after that ONE want asks it again, and at the DEATH_MAX-th death it stays failed for the page. Time is node:test's mock clock
// (setTimeout + Date); jitter is pinned with a Math.random stub where a test needs exact times.
// The request limits: FETCH_MAX_MS from the fetch() call (the browser's own queue counts only here), FETCH_TIMEOUT_MS for the
// body from the answer's headers; both timers end with the request, and an unread body (a non-ok answer, of a single load
// or a sheet) is dropped.
//   npx tsx --test test/images-retry.test.mts
import { mock, test } from "node:test";
import assert from "node:assert/strict";

type Loader = typeof import("../src/lib/map/images.ts");
type Bmp = { width: number; height: number; closed: boolean; close(): void };
type Harness = { m: Loader; calls: string[]; sheetCalls: () => string[]; imgCalls: () => string[] };
type Answer = Response | Promise<Response>;

let seq = 0;
const T0 = Date.parse("2026-11-10T12:00:00Z");
const S = (i: number | string) => `/api/img?u=${encodeURIComponent(`https://img.test/${i}.png`)}`;
const M = (i: number) => `mint${i}`;
const nodes = (n: number, from = 0) => Array.from({ length: n }, (_, k) => ({ mint: M(from + k), image: S(from + k) }));
/// Hex bitmap of an n-cell sheet: byte j bit b = cell 8j + b.
const hexOf = (n: number, pred: (i: number) => boolean) => {
  const bytes = Array.from({ length: Math.ceil(n / 8) }, () => 0);
  for (let i = 0; i < n; i++) if (pred(i)) bytes[i >> 3] |= 1 << (i & 7);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
};
/// A sheet answer per the contract; the body "SHEET:<n>" stands for the image (the createImageBitmap stub reads it).
function sheetResponse(n: number, present: string, dead = "", pending = 0) {
  return new Response(`SHEET:${n}`, { status: 200, headers: { "content-type": "image/webp", "x-sheet": present, "x-sheet-dead": dead, "x-sheet-n": String(n), "x-sheet-cols": "16", "x-sheet-cell": "64", "x-sheet-pending": String(pending) } });
}
const imgResponse = () => new Response("IMG", { status: 200, headers: { "content-type": "image/png", "x-img-thumb": "64" } });
const status = (code: number, headers: Record<string, string> = {}) => new Response("no", { status: code, headers });
const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async (n = 16) => { for (let i = 0; i < n; i++) await tick(); };
/// Yields (setImmediate, never a timer: the timers are mocked) until `pred` or `maxMs` of real time.
async function until(pred: () => boolean, maxMs = 5_000) {
  const t0 = performance.now();
  while (!pred()) { if (performance.now() - t0 > maxMs) throw new Error("until: timed out"); await tick(); }
}
/// The mock clock: setTimeout and Date from T0; `exact` pins the jitter at 0 (Math.random() = 0).
function clock(exact = true) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  if (exact) mock.method(Math, "random", () => 0);
  return () => { mock.timers.reset(); mock.restoreAll(); };
}
const advance = async (ms: number) => { mock.timers.tick(ms); await settle(); };

/// The fetch stubs get the request's signal: an answer they hold back (after / hang / a stalled body) ends with its abort.
type Sig = AbortSignal | undefined;
/// An answer `ms` into the mock clock (the browser's own queue + the server's wait), or the request's abort reason.
const after = (ms: number, signal: Sig, make: () => Response) => new Promise<Response>((res, rej) => {
  const id = setTimeout(() => res(make()), ms);
  signal?.addEventListener("abort", () => { clearTimeout(id); rej(signal.reason); }, { once: true });
});
/// No answer at all until the request is aborted.
const hang = (signal: Sig) => new Promise<Response>((_, rej) => { signal?.addEventListener("abort", () => rej(signal.reason), { once: true }); });
/// A body that never ends; aborting the request errors it (as a browser does). `onCancel` sees a reader drop it.
const stalledBody = (signal: Sig, onCancel?: () => void) => new ReadableStream<Uint8Array>({
  start(c) { signal?.addEventListener("abort", () => c.error(signal.reason), { once: true }); },
  cancel() { onCancel?.(); },
});

async function fresh(o: { sheet?: (mints: string[], signal: Sig) => Answer; img?: (url: string, signal: Sig) => Answer } = {}): Promise<Harness> {
  const calls: string[] = [];
  const bmp = (width: number, height: number): Bmp => { const b: Bmp = { width, height, closed: false, close() { b.closed = true; } }; return b; };
  const g = globalThis as Record<string, unknown>;
  g.window = { innerWidth: 1440 };
  g.fetch = async (url: string, init?: RequestInit) => {
    calls.push(url);
    const u = new URL(url, "http://local.test"), signal = init?.signal ?? undefined;
    if (u.pathname === "/api/logo-sheet") return o.sheet ? o.sheet((u.searchParams.get("m") ?? "").split(","), signal) : status(404);
    return o.img ? o.img(url, signal) : imgResponse();
  };
  // createImageBitmap(blob): a "sheet" blob decodes to a 1024 x rows*64 bitmap, anything else to a 200 x 200 original;
  // createImageBitmap(bitmap, x, y, w, h[, { resizeWidth }]) returns a bitmap of the asked size.
  g.createImageBitmap = async (src: Blob | Bmp, ...rest: unknown[]) => {
    if (src instanceof Blob) {
      const t = await src.text();
      if (t.startsWith("SHEET:")) { const n = Number(t.slice(6)); return bmp(1024, Math.ceil(n / 16) * 64); }
      return bmp(200, 200);
    }
    if (rest.length >= 4) {
      const opt = rest[4] as { resizeWidth?: number } | undefined, size = opt && typeof opt.resizeWidth === "number" ? opt.resizeWidth : null;
      return bmp(size ?? (rest[2] as number), size ?? (rest[3] as number));
    }
    return bmp(src.width, src.height);
  };
  const m = (await import(`../src/lib/map/images.ts?retry${++seq}`)) as Loader;
  return { m, calls, sheetCalls: () => calls.filter((u) => u.startsWith("/api/logo-sheet?")), imgCalls: () => calls.filter((u) => !u.startsWith("/api/logo-sheet?")) };
}

test("retryAfterMs reads delta seconds and HTTP dates; backoffMs = the step or a longer Retry-After (capped) + 0..25 % jitter; isTemporary", async () => {
  const { m } = await fresh();
  assert.equal(m.retryAfterMs("3"), 3_000);
  assert.equal(m.retryAfterMs(" 120 "), 120_000);
  for (const h of ["0", "-5", "", "  ", "soon", null, undefined]) assert.equal(m.retryAfterMs(h), 0, String(h));
  assert.equal(m.retryAfterMs("Tue, 10 Nov 2026 12:01:30 GMT", T0), 90_000);
  assert.equal(m.retryAfterMs("Tue, 10 Nov 2026 11:59:00 GMT", T0), 0, "a date already past");
  assert.deepEqual(m.RETRY_STEPS_MS, [10_000, 30_000, 120_000, 600_000]);
  assert.equal(m.DEAD_MS, 15 * 60_000);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(m.deadMs), [15, 30, 60, 120, 120, 120].map((x) => x * 60_000), "dead time doubles per death, at most DEAD_MAX_MS");
  assert.equal(m.FETCH_TIMEOUT_MS, 60_000, "the body, from the headers");
  assert.equal(m.FETCH_MAX_MS, 5 * 60_000, "the whole request, from fetch(): longer than the server's own 30 s download budget plus a queue");
  for (let n = 0; n < 4; n++) assert.equal(m.backoffMs(n, 0, 0), m.RETRY_STEPS_MS[n]);
  assert.equal(m.backoffMs(9, 0, 0), 600_000, "past the last step: the last step");
  assert.equal(m.backoffMs(-1, 0, 0), 10_000);
  assert.equal(m.backoffMs(0, 3_000, 0), 10_000, "a shorter Retry-After never brings the retry forward");
  assert.equal(m.backoffMs(0, 45_000, 0), 45_000, "a longer one is honoured");
  assert.equal(m.backoffMs(0, 10 * 3_600_000, 0), m.RETRY_AFTER_MAX_MS, "an absurd one is capped");
  assert.equal(m.backoffMs(1, 0, 0.5), 33_750, "jitter: + RETRY_JITTER x rnd of the wait");
  for (let k = 0; k < 500; k++) { const w = m.backoffMs(2, 0); assert.ok(w >= 120_000 && w <= 150_000, String(w)); }
  assert.ok(new Set(Array.from({ length: 50 }, () => m.backoffMs(0))).size > 10, "jitter spreads a burst of failures");
  assert.equal(m.isTemporary(new TypeError("Failed to fetch")), true, "a network error");
  assert.equal(m.isTemporary(new DOMException("timed out", "TimeoutError")), true, "FETCH_TIMEOUT_MS");
  assert.equal(m.isTemporary(new DOMException("aborted", "AbortError")), true);
  assert.equal(m.isTemporary(new Error("decode")), false);
  assert.equal(m.isTemporary(null), false);
});

test("a 503 + Retry-After is held: not asked again before max(step, Retry-After) however often it is wanted, then once, and drawn", async () => {
  const off = clock();
  try {
    let n = 0;
    const h = await fresh({ img: () => (++n === 1 ? status(503, { "retry-after": "20" }) : imgResponse()) });
    const { m } = h;
    let fired = 0;
    m.onImageLoaded(() => { fired++; });
    const src = S(1);
    assert.equal(m.imageFor(src, 40), null);
    await settle();
    assert.deepEqual(h.calls, [`${src}&w=64`]);
    let st = m.imageStats();
    assert.equal(st.held, 1); assert.equal(st.inflight, 0); assert.equal(st.queued, 0); assert.equal(st.failed, 0);
    assert.equal(m.imageFailed(src), false, "a held source is not failed: the renderer keeps waiting for it");
    assert.equal(m.imageRetryAt(src), 0);
    assert.equal(fired, 0, "a temporary failure changes nothing the renderer could draw");
    // the renderer wants it every frame: nothing starts early
    for (let k = 0; k < 500; k++) assert.equal(m.imageFor(src, 40), null);
    await advance(19_999);
    assert.equal(h.calls.length, 1, "Retry-After 20 s, longer than the 10 s step, is honoured");
    await advance(1);
    assert.equal(h.calls.length, 2, "exactly one retry");
    await until(() => m.imageReady(src));
    st = m.imageStats();
    assert.equal(st.held, 0); assert.equal(st.heldN, 1); assert.equal(st.retried, 1); assert.equal(st.dead, 0);
    assert.equal(fired, 1, "the load tells the listeners");
    await advance(m.DEAD_MS);
    assert.equal(h.calls.length, 2, "nothing more");
  } finally { off(); }
});

test("the backoff ladder: 10 s, 30 s, 2 min, 10 min, then dead for DEAD_MS (listeners told); after it one want asks ONCE and a failure is dead again at once", async () => {
  const off = clock();
  try {
    const h = await fresh({ img: () => status(503) });
    const { m } = h;
    let fired = 0;
    m.onImageLoaded(() => { fired++; });
    const v0 = m.imagesVersion(), src = S(2);
    m.imageFor(src, 40);
    await settle();
    assert.equal(h.calls.length, 1);
    for (let k = 0; k < m.RETRY_STEPS_MS.length; k++) {
      await advance(m.RETRY_STEPS_MS[k] - 1);
      m.imageFor(src, 40);
      await settle();
      assert.equal(h.calls.length, k + 1, `not before step ${k} (${m.RETRY_STEPS_MS[k]} ms)`);
      assert.equal(m.imageFailed(src), false);
      await advance(1);
      assert.equal(h.calls.length, k + 2, `retry ${k + 1}`);
    }
    // the fifth answer was a 503 too: the steps are used up, the source is dead
    const tDead = Date.now();
    assert.equal(m.imageFailed(src), true);
    assert.equal(m.imageRetryAt(src), tDead + m.DEAD_MS);
    assert.equal(m.imagesVersion(), v0 + 1, "a dead verdict bumps the version");
    assert.equal(fired, 1, "and tells the listeners, so the renderer re-evaluates");
    let st = m.imageStats();
    assert.equal(st.failed, 1); assert.equal(st.held, 0); assert.equal(st.dead, 1); assert.equal(st.retried, 4);
    for (let k = 0; k < 100; k++) assert.equal(m.imageFor(src, 40), null);
    await advance(m.DEAD_MS - 1);
    assert.equal(h.calls.length, 5, "a dead source is never asked while it is dead");
    assert.equal(m.imageFailed(src), true);
    await advance(1);
    assert.equal(m.imageFailed(src), false, "its dead time is over");
    assert.equal(m.imageRetryAt(src), 0);
    assert.equal(h.calls.length, 5, "the loader does not ask it by itself: a want does");
    m.imageFor(src, 40);
    await settle();
    assert.equal(h.calls.length, 6, "one ask");
    assert.equal(m.imageFailed(src), true, "a 503 at that ask is dead again at once, no new ladder");
    assert.equal(m.imageRetryAt(src), Date.now() + m.deadMs(2), "the second death waits twice as long");
    await advance(m.RETRY_STEPS_MS[0]);
    m.imageFor(src, 40);
    await settle();
    assert.equal(h.calls.length, 6);
    st = m.imageStats();
    assert.equal(st.dead, 2); assert.equal(st.revived, 1);
  } finally { off(); }
});

test("a 404 is dead at once (no ladder); after DEAD_MS a want asks once and a logo that exists now is drawn", async () => {
  const off = clock();
  try {
    let live = false;
    const h = await fresh({ img: () => (live ? imgResponse() : status(404)) });
    const { m } = h;
    let fired = 0;
    m.onImageLoaded(() => { fired++; });
    const src = S(3);
    m.imageFor(src, 40);
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(m.imageFailed(src), true);
    assert.equal(m.imageRetryAt(src), T0 + m.DEAD_MS);
    assert.equal(fired, 1);
    assert.equal(m.imageStats().held, 0, "a 404 is not temporary");
    await advance(m.RETRY_STEPS_MS[3]);
    m.imageFor(src, 40);
    await settle();
    assert.equal(h.calls.length, 1);
    live = true;   // the server has the logo now (its metadata or its host came back)
    await advance(m.DEAD_MS - m.RETRY_STEPS_MS[3]);
    assert.equal(m.imageFor(src, 40), null);
    await until(() => m.imageReady(src));
    assert.equal(h.calls.length, 2);
    assert.equal(m.imageFailed(src), false);
    assert.equal(fired, 2);
  } finally { off(); }
});

test("DEATH_MAX deaths, each dead time twice the last (at most DEAD_MAX_MS): then failed for the rest of the page (imageRetryAt = Infinity); at most DEATH_MAX asks of a 404", async () => {
  const off = clock();
  try {
    const h = await fresh({ img: () => status(404) });
    const { m } = h;
    const src = S(4);
    m.imageFor(src, 40);
    await settle();
    for (let d = 2; d <= m.DEATH_MAX; d++) {
      assert.equal(m.imageRetryAt(src), Date.now() + m.deadMs(d - 1));
      await advance(m.deadMs(d - 1) - 1);
      m.imageFor(src, 40);
      await settle();
      assert.equal(h.calls.length, d - 1, `not before death ${d - 1}'s time is up`);
      await advance(1);
      m.imageFor(src, 40);
      await settle();
      assert.equal(h.calls.length, d);
    }
    assert.equal(m.imageRetryAt(src), Infinity);
    assert.equal(m.imageStats().givenUp, 1);
    await advance(24 * 3_600_000);
    for (let k = 0; k < 10; k++) m.imageFor(src, 40);
    await settle();
    assert.equal(h.calls.length, m.DEATH_MAX);
    assert.equal(m.imageFailed(src), true);
  } finally { off(); }
});

test("a network error and a timeout are temporary: held 10 s, then 30 s, then drawn", async () => {
  const off = clock();
  try {
    let n = 0;
    const h = await fresh({
      img: () => {
        n++;
        if (n === 1) throw new TypeError("Failed to fetch");
        if (n === 2) return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
        return imgResponse();
      },
    });
    const { m } = h;
    const src = S(5);
    m.imageFor(src, 40);
    await settle();
    assert.equal(m.imageStats().held, 1);
    await advance(m.RETRY_STEPS_MS[0]);
    assert.equal(h.calls.length, 2);
    assert.equal(m.imageStats().held, 1, "the timeout is held too");
    assert.equal(m.imageFailed(src), false);
    await advance(m.RETRY_STEPS_MS[1] - 1);
    assert.equal(h.calls.length, 2, "the second step");
    await advance(1);
    await until(() => m.imageReady(src));
    assert.equal(h.calls.length, 3);
  } finally { off(); }
});

test("a dead sheet cell is dead for DEAD_MS only: wanted after it, the source is asked once more (per request when alone) and drawn", async () => {
  const off = clock();
  try {
    const h = await fresh({ sheet: (mints) => { const n = mints.length; return sheetResponse(n, hexOf(n, (i) => mints[i] !== M(2)), hexOf(n, (i) => mints[i] === M(2))); } });
    const { m } = h;
    let fired = 0;
    m.onImageLoaded(() => { fired++; });
    m.registerLogoMints(nodes(4));
    for (let i = 0; i < 4; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(h.sheetCalls().length, 1);
    for (const i of [0, 1, 3]) assert.ok(m.imageReady(S(i)));
    assert.equal(m.imageFailed(S(2)), true, "the dead cell");
    assert.equal(m.imageRetryAt(S(2)), T0 + m.DEAD_MS);
    assert.equal(fired, 1, "one notice for the sheet, dead cell included");
    m.imageFor(S(2), 40);
    await advance(m.DEAD_MS - 1);
    assert.equal(h.calls.length, 1);
    await advance(1);
    m.imageFor(S(2), 40);
    await until(() => m.imageReady(S(2)));
    assert.deepEqual(h.imgCalls(), [`${S(2)}&w=64`], "alone (fewer than SHEET_MIN): per request");
    assert.equal(h.sheetCalls().length, 1);
  } finally { off(); }
});

test("pending sheet cells are asked again, then per request, where a 503 + Retry-After is waited out", async () => {
  const off = clock();
  try {
    let imgN = 0;
    const h = await fresh({
      sheet: (mints) => sheetResponse(mints.length, hexOf(mints.length, () => false), "", mints.length),
      img: () => (++imgN <= 4 ? status(503, { "retry-after": "15" }) : imgResponse()),
    });
    const { m } = h;
    m.registerLogoMints(nodes(4, 10));
    for (let i = 10; i < 14; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(h.sheetCalls().length, 1);
    await advance(m.SHEET_RETRY_FAST_MS);
    assert.equal(h.sheetCalls().length, 2, "pending cells: a second sheet");
    await advance(m.SHEET_RETRY_FAST_MS);
    assert.equal(h.sheetCalls().length, 3);
    await settle();
    assert.equal(h.imgCalls().length, 4, "past SHEET_MISS_MAX: per request");
    assert.equal(m.imageStats().held, 4, "the server's 503s are held, not failed");
    for (let i = 10; i < 14; i++) assert.equal(m.imageFailed(S(i)), false);
    await advance(14_999);
    assert.equal(h.imgCalls().length, 4, "Retry-After 15 s");
    await advance(1);
    await until(() => m.imageStats().ready === 4);
    assert.equal(h.imgCalls().length, 8);
    assert.equal(h.sheetCalls().length, 3, "no further sheet for them");
  } finally { off(); }
});

test("no retry storm: 200 sources failing at once come back spread by the jitter, and never more than MAX_INFLIGHT at a time", async () => {
  const off = clock(false);   // real jitter
  try {
    const seen = new Set<string>();
    const h = await fresh({
      img: (url) => {
        if (!seen.has(url)) { seen.add(url); return status(503); }
        return new Promise<Response>(() => { /* the retries hang: they stay in flight */ });
      },
    });
    const { m } = h;
    for (let i = 0; i < 200; i++) m.imageFor(S(`storm${i}`), 40);
    await until(() => h.calls.length === 200 && m.imageStats().held === 200);
    await advance(m.RETRY_STEPS_MS[0] - 1);
    assert.equal(h.calls.length, 200, "nothing before the first step");
    await advance(500);
    const early = h.calls.length - 200;
    assert.ok(early > 0 && early < m.MAX_INFLIGHT, `spread: ${early} of 200 back within the first 0.5 s of the 2.5 s jitter window`);
    await advance(m.RETRY_STEPS_MS[0] * m.RETRY_JITTER);
    const st = m.imageStats();
    assert.equal(h.calls.length - 200, m.MAX_INFLIGHT, "the in-flight limit holds for retries");
    assert.equal(st.inflight, m.MAX_INFLIGHT);
    assert.equal(st.held, 0);
    assert.equal(st.queued, 200 - m.MAX_INFLIGHT);
  } finally { off(); }
});

const MAX = 5 * 60_000, BODY = 60_000;

test("queue time is not a timeout: an answer 4 min 59 s after fetch() (HTTP/1.1 queue + the server's wait) is read and drawn; no timer outlives it", async () => {
  const off = clock();
  try {
    const sigs: Sig[] = [];
    const h = await fresh({ img: (_url, signal) => { sigs.push(signal); return after(MAX - 1_000, signal, imgResponse); } });
    const { m } = h;
    const src = S("queued");
    m.imageFor(src, 40);
    await settle();
    assert.equal(h.calls.length, 1);
    await advance(BODY + 1_000);
    assert.equal(sigs[0]?.aborted, false, "past FETCH_TIMEOUT_MS from fetch(): the old limit cut it here, unsent");
    assert.equal(m.imageStats().inflight, 1);
    await advance(MAX - 1_000 - BODY - 1_001);
    assert.equal(m.imageStats().held, 0);
    await advance(1);
    await until(() => m.imageReady(src));
    assert.equal(h.calls.length, 1);
    await advance(MAX);
    assert.equal(sigs[0]?.aborted, false, "both timers ended with the request");
    const st = m.imageStats();
    assert.equal(st.held, 0); assert.equal(st.heldN, 0); assert.equal(st.failed, 0);
  } finally { off(); }
});

test("a request that never answers is cut at FETCH_MAX_MS: a temporary failure, held, retried after the first step and drawn", async () => {
  const off = clock();
  try {
    let n = 0;
    const h = await fresh({ img: (_url, signal) => (++n === 1 ? hang(signal) : imgResponse()) });
    const { m } = h;
    const src = S("silent");
    m.imageFor(src, 40);
    await settle();
    await advance(MAX - 1);
    let st = m.imageStats();
    assert.equal(st.inflight, 1); assert.equal(st.held, 0);
    await advance(1);
    st = m.imageStats();
    assert.equal(st.inflight, 0); assert.equal(st.held, 1, "a TimeoutError is temporary");
    assert.equal(m.imageFailed(src), false);
    await advance(m.RETRY_STEPS_MS[0]);
    await until(() => m.imageReady(src));
    assert.equal(h.calls.length, 2);
  } finally { off(); }
});

test("a body that stalls is cut FETCH_TIMEOUT_MS after its headers, however long the request queued, and never past FETCH_MAX_MS", async () => {
  const off = clock();
  try {
    const stall = (signal: Sig) => new Response(stalledBody(signal), { status: 200, headers: { "content-type": "image/png" } });
    const sig = new Map<string, Sig>();
    const h = await fresh({
      img: (url, signal) => {
        const early = url.includes("early");
        if (!sig.has(early ? "a" : "b")) sig.set(early ? "a" : "b", signal);
        return after(early ? 3 * 60_000 : 4.5 * 60_000, signal, () => stall(signal));
      },
    });
    const { m } = h;
    const a = S("early"), b = S("late");
    m.imageFor(a, 40); m.imageFor(b, 40);
    await settle();
    assert.equal(h.calls.length, 2);
    await advance(3 * 60_000);   // a's headers
    await advance(BODY - 1);
    assert.equal(sig.get("a")?.aborted, false, "a: 60 s - 1 ms into its body");
    assert.equal(m.imageStats().held, 0);
    await advance(1);
    assert.equal(sig.get("a")?.aborted, true, "a: cut 60 s after its headers");
    assert.equal(m.imageStats().held, 1, "a TimeoutError is temporary");
    await advance(MAX - 4 * 60_000 - 1);   // b's headers came at 4.5 min: FETCH_MAX_MS comes before its 60 s
    assert.equal(sig.get("b")?.aborted, false, "b: still reading at 5 min - 1 ms");
    await advance(1);
    assert.equal(sig.get("b")?.aborted, true, "b: cut at FETCH_MAX_MS, before its own 60 s were up");
    assert.equal(m.imageFailed(a), false); assert.equal(m.imageFailed(b), false);
    assert.ok(m.imageStats().heldN >= 2);
  } finally { off(); }
});

test("a non-ok answer ends the request's timers and drops its unread body", async () => {
  const off = clock();
  try {
    const sigs: Sig[] = [];
    let cancelled = 0, n = 0;
    const h = await fresh({
      img: (_url, signal) => {
        sigs.push(signal);
        if (++n === 1) return new Response(stalledBody(signal, () => { cancelled++; }), { status: 503, headers: { "retry-after": "5" } });
        return status(404);
      },
    });
    const { m } = h;
    const src = S("nope");
    m.imageFor(src, 40);
    await settle();
    assert.equal(m.imageStats().held, 1);
    assert.equal(cancelled, 1, "the 503's body is dropped, not left open");
    await advance(m.RETRY_STEPS_MS[0]);
    assert.equal(h.calls.length, 2);
    assert.equal(m.imageFailed(src), true, "the 404");
    await advance(MAX);
    assert.deepEqual(sigs.map((s) => s?.aborted), [false, false], "no timer fired after the answers");
  } finally { off(); }
});

/// The request timers timedFetch arms (FETCH_MAX_MS at fetch(), FETCH_TIMEOUT_MS at the headers) that are still pending: a
/// spy over the mock clock's setTimeout / clearTimeout (a timer leaves the set when it fires or is cleared).
function requestTimers(m: Loader) {
  type G = { setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => unknown; clearTimeout: (id: unknown) => void };
  const g = globalThis as unknown as G, st = g.setTimeout, ct = g.clearTimeout, live = new Set<unknown>();
  let armed = 0;
  g.setTimeout = (fn, ms = 0, ...a) => {
    const id: unknown = st((...b: unknown[]) => { live.delete(id); fn(...b); }, ms, ...a);
    if (ms === m.FETCH_MAX_MS || ms === m.FETCH_TIMEOUT_MS) { live.add(id); armed++; }
    return id;
  };
  g.clearTimeout = (id) => { live.delete(id); ct(id); };
  return { pending: () => live.size, armed: () => armed, restore: () => { g.setTimeout = st; g.clearTimeout = ct; } };
}

// startSheet reads no body for a non-ok answer: its `finally` drops it (t.close()), which also ends the request's timers.
// A 503 is a transient sheet failure (the next sheet carries the sources), a 404 turns sheets off (per request).
for (const code of [503, 404]) {
  test(`a non-ok sheet answer (${code}) ends the request's timers and drops its unread body`, async () => {
    const off = clock();
    let spy: ReturnType<typeof requestTimers> | null = null;
    try {
      const sigs: Sig[] = [];
      let cancelled = 0;
      const h = await fresh({
        sheet: (mints, signal) => {
          sigs.push(signal);
          if (sigs.length === 1) return new Response(stalledBody(signal, () => { cancelled++; }), { status: code });
          return sheetResponse(mints.length, hexOf(mints.length, () => true));
        },
      });
      const { m } = h;
      spy = requestTimers(m);
      m.registerLogoMints(nodes(4, 30));
      for (let i = 30; i < 34; i++) m.imageFor(S(i), 40);
      await until(() => m.imageStats().ready === 4);
      if (code === 503) {
        assert.equal(h.sheetCalls().length, 2, "a transient failure: the next sheet carries them");
        assert.equal(h.imgCalls().length, 0);
      } else {
        assert.equal(h.sheetCalls().length, 1, "no sheets on this server");
        assert.equal(h.imgCalls().length, 4, "per request");
      }
      assert.equal(cancelled, 1, `the ${code}'s body is dropped, not left open`);
      assert.ok(spy.armed() >= 4, `the spy saw the requests' timers (${spy.armed()})`);
      assert.equal(spy.pending(), 0, "no request timer is still pending");
      await advance(m.FETCH_TIMEOUT_MS + 1);
      assert.equal(sigs[0]?.aborted, false, `past FETCH_TIMEOUT_MS: the ${code}'s request was ended, not cut`);
      await advance(MAX);
      assert.deepEqual(sigs.map((s) => s?.aborted), sigs.map(() => false), "no timer fired after the answers");
      assert.equal(cancelled, 1, "dropped once");
      assert.equal(spy.pending(), 0);
    } finally { spy?.restore(); off(); }
  });
}

test("sheets: an answer 4 min after fetch() is read; a sheet body that stalls is cut FETCH_TIMEOUT_MS after its headers and its sources go back to the queue", async () => {
  const off = clock();
  try {
    let n = 0;
    const sigs: Sig[] = [];
    const h = await fresh({
      sheet: (mints, signal) => {
        sigs.push(signal);
        const k = mints.length, all = hexOf(k, () => true);
        n++;
        if (n === 1) return after(4 * 60_000, signal, () => sheetResponse(k, all));
        if (n === 2) return new Response(stalledBody(signal), { status: 200, headers: { "x-sheet": all, "x-sheet-dead": "", "x-sheet-n": String(k), "x-sheet-pending": "0" } });
        return sheetResponse(k, all);
      },
    });
    const { m } = h;
    m.registerLogoMints(nodes(8, 20));
    for (let i = 20; i < 24; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(h.sheetCalls().length, 1);
    await advance(4 * 60_000 - 1);
    assert.equal(sigs[0]?.aborted, false, "queued past 60 s: not cut");
    await advance(1);
    await until(() => m.imageStats().ready === 4);
    for (let i = 24; i < 28; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(h.sheetCalls().length, 2);
    await advance(BODY - 1);
    assert.equal(h.sheetCalls().length, 2, "still reading the body");
    await advance(1);
    await until(() => m.imageStats().ready === 8);
    assert.equal(h.sheetCalls().length, 3, "cut: the sources went back to the queue and the next sheet carried them");
    assert.equal(sigs[1]?.aborted, true);
    await advance(MAX);
    assert.equal(sigs[0]?.aborted, false); assert.equal(sigs[2]?.aborted, false);
    assert.equal(h.imgCalls().length, 0);
  } finally { off(); }
});
