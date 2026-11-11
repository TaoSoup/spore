// Logo sheets in the map image loader (src/lib/map/images.ts): the first 64 px load of a registered /api/img source goes in
// one GET /api/logo-sheet?w=64&m=<mint>,... per batch (newest want first), every cell is cut from the ONE decoded sheet, dead
// cells fail, pending cells are asked again and then per request, a server without sheets (404 / 501, or a 200 without
// x-sheet) switches sheets off for the page, a failure of the sheet route itself cools them down for a while (the sources go
// per request; until 2026-11-10 two transient failures in a row switched them off for the page), and the per-request path is
// untouched for everything a sheet cannot carry. A sheet that cannot reach the server is the link's failure, not the
// route's: test/images-link.test.mts. The loader's state is module-global, so every test imports a fresh instance (a ?query
// on the module URL) after stubbing window, fetch and createImageBitmap.
//   npx tsx --test test/images-sheet.test.mts
import { mock, test } from "node:test";
import assert from "node:assert/strict";

type Loader = typeof import("../src/lib/map/images.ts");
type Bmp = { width: number; height: number; closed: boolean; close(): void };
type Cut = { from: Bmp; x: number; y: number; w: number; h: number; size: number | null };
type Harness = { m: Loader; calls: string[]; cuts: Cut[]; bitmaps: Bmp[]; sheetCalls: () => string[]; imgCalls: () => string[] };
type SheetFn = (mints: string[], url: URL) => Response | Promise<Response>;

let seq = 0;
const S = (i: number | string) => `/api/img?u=${encodeURIComponent(`https://img.test/${i}.png`)}`;
const M = (i: number) => `mint${i}`;
const nodes = (n: number, from = 0) => Array.from({ length: n }, (_, k) => ({ mint: M(from + k), image: S(from + k) }));
/// Hex bitmap of an n-cell sheet: byte j bit b = cell 8j + b.
const hexOf = (n: number, pred: (i: number) => boolean) => {
  const bytes = Array.from({ length: Math.ceil(n / 8) }, () => 0);
  for (let i = 0; i < n; i++) if (pred(i)) bytes[i >> 3] |= 1 << (i & 7);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
};
const ALL = (mints: string[]) => sheetResponse(mints.length, hexOf(mints.length, () => true));
/// A sheet answer per the contract; the body "SHEET:<n>" stands for the image (the createImageBitmap stub reads it).
function sheetResponse(n: number, present: string, dead = "", pending = 0, headers: Record<string, string> = {}) {
  return new Response(`SHEET:${n}`, { status: 200, headers: { "content-type": "image/webp", "x-sheet": present, "x-sheet-dead": dead, "x-sheet-n": String(n), "x-sheet-cols": "16", "x-sheet-cell": "64", "x-sheet-pending": String(pending), "cache-control": pending ? "no-store" : "private, max-age=600", ...headers } });
}
const imgResponse = () => new Response("IMG", { status: 200, headers: { "content-type": "image/png", "x-img-thumb": "64" } });
const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async (n = 16) => { for (let i = 0; i < n; i++) await tick(); };
/// Yields (setImmediate, never a timer: some tests mock setTimeout) until `pred` or `maxMs` of real time.
async function until(pred: () => boolean, maxMs = 5_000, state?: () => unknown) {
  const t0 = performance.now();
  while (!pred()) { if (performance.now() - t0 > maxMs) throw new Error(`until: timed out${state ? " " + JSON.stringify(state()) : ""}`); await tick(); }
}

async function fresh(o: { innerWidth?: number; sheet?: SheetFn; img?: (url: string) => Response | Promise<Response> } = {}): Promise<Harness> {
  const calls: string[] = [], cuts: Cut[] = [], bitmaps: Bmp[] = [];
  const bmp = (width: number, height: number): Bmp => { const b: Bmp = { width, height, closed: false, close() { b.closed = true; } }; bitmaps.push(b); return b; };
  const g = globalThis as Record<string, unknown>;
  g.window = { innerWidth: o.innerWidth ?? 1440 };
  g.fetch = async (url: string) => {
    calls.push(url);
    const u = new URL(url, "http://local.test");
    if (u.pathname === "/api/logo-sheet") return o.sheet ? o.sheet((u.searchParams.get("m") ?? "").split(","), u) : new Response("no", { status: 404 });
    // the probe of a link that is down: the server answers (JSON)
    if (u.pathname === "/api/health") return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    return o.img ? o.img(url) : imgResponse();
  };
  // createImageBitmap(blob): a "sheet" blob decodes to a 1024 x rows*64 bitmap, anything else to a 200 x 200 original;
  // createImageBitmap(bitmap, x, y, w, h[, { resizeWidth }]) records the cut and returns a bitmap of the asked size.
  g.createImageBitmap = async (src: Blob | Bmp, ...rest: unknown[]) => {
    if (src instanceof Blob) {
      const t = await src.text();
      if (t.startsWith("SHEET:")) { const n = Number(t.slice(6)); return bmp(1024, Math.ceil(n / 16) * 64); }
      return bmp(200, 200);
    }
    if (rest.length >= 4) {
      const opt = rest[4] as { resizeWidth?: number } | undefined, size = opt && typeof opt.resizeWidth === "number" ? opt.resizeWidth : null;
      cuts.push({ from: src, x: rest[0] as number, y: rest[1] as number, w: rest[2] as number, h: rest[3] as number, size });
      return bmp(size ?? (rest[2] as number), size ?? (rest[3] as number));
    }
    return bmp(src.width, src.height);
  };
  const m = (await import(`../src/lib/map/images.ts?sheet${++seq}`)) as Loader;
  return { m, calls, cuts, bitmaps, sheetCalls: () => calls.filter((u) => u.startsWith("/api/logo-sheet?")), imgCalls: () => calls.filter((u) => !u.startsWith("/api/logo-sheet?")) };
}

test("ten registered proxy sources wanted at 64 go in ONE sheet, mints newest-first; every cell is cut from the one decoded sheet at its x/y", async () => {
  const h = await fresh({ sheet: ALL });
  const { m } = h;
  m.registerLogoMints(nodes(10));
  for (let i = 0; i < 10; i++) assert.equal(m.imageFor(S(i), 40), null);
  assert.equal(h.calls.length, 0, "a want pumps on a microtask: nothing has started yet");
  await settle();
  assert.equal(h.calls.length, 1, "one request for the whole burst");
  const u = new URL(h.calls[0], "http://local.test");
  assert.equal(u.pathname, "/api/logo-sheet");
  assert.equal(u.searchParams.get("w"), "64");
  assert.deepEqual(u.searchParams.get("m")!.split(","), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(M), "newest want first");
  assert.equal(h.cuts.length, 10);
  const sheet = h.cuts[0].from;
  assert.deepEqual([sheet.width, sheet.height], [1024, 64]);
  assert.ok(sheet.closed, "the decoded sheet is closed after the cuts");
  for (let c = 0; c < 10; c++) {
    const cut = h.cuts[c];
    assert.equal(cut.from, sheet, "every cell comes from the ONE decoded sheet, never from the blob");
    assert.deepEqual([cut.x, cut.y, cut.w, cut.h, cut.size], [(c % 16) * 64, Math.floor(c / 16) * 64, 64, 64, null]);
    const src = S(9 - c);
    assert.ok(m.imageReady(src));
    assert.equal(m.imageFor(src, 40), h.bitmaps[1 + c], `cell ${c} is the thumbnail of ${src}`);
  }
  const st = m.imageStats();
  assert.equal(st.sheets, 1); assert.equal(st.sheetCells, 10); assert.equal(st.thumbs, 10); assert.equal(st.sheetPending, 0); assert.equal(st.sheetDead, 0);
  assert.equal(st.ready, 10); assert.equal(st.inflight, 0); assert.equal(st.queued, 0); assert.equal(st.sheetInflight, 0);
  assert.equal(st.pixels, 10 * 64 * 64);
  assert.equal(st.sheetsOff, false);
  assert.ok(st.sheetBytes > 0 && st.sheetMs >= 0);
});

test("sheetBits: byte j bit b = cell 8j + b; a 17-cell bitmap spans three bytes", async () => {
  const { m } = await fresh();
  assert.deepEqual([...m.sheetBits("01", 3)], [1, 0, 0]);
  assert.deepEqual([...m.sheetBits("02", 3)], [0, 1, 0]);
  assert.deepEqual([...m.sheetBits("04", 3)], [0, 0, 1]);
  assert.deepEqual([...m.sheetBits("ff03", 10)], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  const b17 = m.sheetBits("8100" + "01", 17);
  assert.equal(b17.length, 17);
  assert.deepEqual([...b17].map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [0, 7, 16]);
  assert.deepEqual([...m.sheetBits("", 4)], [0, 0, 0, 0], "a missing bitmap means no cell");
  assert.deepEqual([...m.sheetBits("zz", 2)], [0, 0], "garbage means no cell");
});

test("present cells are ready, a dead cell fails, pending cells are asked again after SHEET_RETRY_MS and go per request after SHEET_MISS_MAX misses", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const answers: string[][] = [];
    const h = await fresh({
      sheet: (mints) => {
        answers.push(mints);
        const n = mints.length;
        // first sheet: cells 0 and 1 present, cell 2 dead, the rest pending; later sheets: everything still pending
        return answers.length === 1 ? sheetResponse(n, hexOf(n, (i) => i < 2), hexOf(n, (i) => i === 2), n - 3) : sheetResponse(n, hexOf(n, () => false), "", n);
      },
    });
    const { m } = h;
    m.registerLogoMints(nodes(8));
    for (let i = 0; i < 8; i++) m.imageFor(S(i), 40);
    await settle();
    assert.deepEqual(answers, [[7, 6, 5, 4, 3, 2, 1, 0].map(M)]);
    assert.ok(m.imageReady(S(7)) && m.imageReady(S(6)), "present cells");
    assert.ok(m.imageFailed(S(5)), "the dead cell");
    for (const i of [4, 3, 2, 1, 0]) { assert.equal(m.imageReady(S(i)), false); assert.equal(m.imageFailed(S(i)), false); }
    let st = m.imageStats();
    assert.equal(st.sheetCells, 2); assert.equal(st.sheetDead, 1); assert.equal(st.sheetPending, 5); assert.equal(st.failed, 1);
    assert.equal(st.inflight, 0, "pending sources are not in flight while they wait");
    assert.equal(h.imgCalls().length, 0, "no per-request load yet");
    assert.equal(h.sheetCalls().length, 1);
    // few pending cells (<= SHEET_RETRY_FAST_N): the re-ask comes after SHEET_RETRY_FAST_MS, not the full SHEET_RETRY_MS
    assert.ok(m.SHEET_RETRY_FAST_MS < m.SHEET_RETRY_MS);
    mock.timers.tick(m.SHEET_RETRY_FAST_MS - 1);
    await settle();
    assert.equal(answers.length, 1, "not yet");
    assert.equal(m.imageFor(S(4), 40), null, "a want during the wait only re-queues it");
    mock.timers.tick(1);
    await settle();
    assert.equal(answers.length, 2, "the pending five are asked again in a sheet of their own (SHEET_MIN reached)");
    assert.deepEqual(new Set(answers[1]), new Set([4, 3, 2, 1, 0].map(M)));
    assert.equal(h.imgCalls().length, 0);
    mock.timers.tick(m.SHEET_RETRY_MS);
    await settle();
    assert.equal(answers.length, 3, "second miss: one more sheet");
    await settle();
    // third miss (> SHEET_MISS_MAX): the per-request path, which waits for the thumbnail
    const imgs = h.imgCalls();
    assert.equal(imgs.length, 5, `per request after the misses: ${imgs.join(" ")}`);
    for (const u of imgs) assert.ok(/^\/api\/img\?u=.*&w=64$/.test(u), u);
    assert.equal(answers.length, 3, "no fourth sheet for them");
    await until(() => m.imageStats().ready === 7);
    for (let i = 0; i < 8; i++) if (i !== 5) assert.ok(m.imageReady(S(i)), S(i));
    st = m.imageStats();
    assert.equal(st.sheets, 3); assert.equal(st.sheetPending, 15); assert.equal(st.inflight, 0); assert.equal(st.queued, 0);
  } finally { mock.timers.reset(); }
});

for (const [name, sheet] of [
  ["a 404", () => new Response("no", { status: 404 })],
  ["a 501", () => new Response("no", { status: 501 })],
  ["a 200 without x-sheet", () => new Response("IMG", { status: 200, headers: { "content-type": "image/png" } })],
] as [string, SheetFn][]) {
  test(`${name} switches sheets off for the page: the same sources load per request, later wants never try a sheet`, async () => {
    const h = await fresh({ sheet });
    const { m } = h;
    m.registerLogoMints(nodes(12));
    for (let i = 0; i < 6; i++) m.imageFor(S(i), 40);
    await settle();
    assert.equal(h.sheetCalls().length, 1);
    assert.equal(m.imageStats().sheetsOff, true);
    await until(() => m.imageStats().ready === 6);
    const imgs = h.imgCalls();
    assert.equal(imgs.length, 6);
    for (let i = 0; i < 6; i++) assert.ok(imgs.includes(`${S(i)}&w=64`), S(i));
    for (let i = 0; i < 6; i++) assert.equal((m.imageFor(S(i), 40) as Bmp).width, 64);
    for (let i = 6; i < 12; i++) m.imageFor(S(i), 40);
    await until(() => m.imageStats().ready === 12);
    assert.equal(h.sheetCalls().length, 1, "no further sheet request");
    assert.equal(m.imageStats().sheets, 0);
  });
}

// (2026-11-10) this test switched sheets off after SHEET_FAIL_MAX transient failures in a row (a 503, a 429, a network error);
// no transient failure switches them off now: the route's own failure cools them down, a 429 pauses every start, a network
// error is the link's (a probe, then the next sheet). Mock clock (setTimeout + Date) for the cooldown, the pause, the probe.
const T0 = Date.parse("2026-11-10T12:00:00Z");
test("sheet failures are never final for the page: the API's 500 or 503, a bad x-sheet-n cool sheets down (the sources go per request) until SHEET_COOL_MS; a 429 pauses, a network error is the link's", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  try {
    const json = (code: number) => new Response(JSON.stringify({ error: "sheet failed" }), { status: code, headers: { "content-type": "application/json" } });
    for (const [name, bad] of [
      ["the API's 500", () => json(500)],
      ["the API's 503", () => json(503)],
      ["a bad x-sheet-n", (mints) => sheetResponse(mints.length + 1, hexOf(mints.length + 1, () => true))],
    ] as [string, SheetFn][]) {
      let n = 0;
      const h = await fresh({ sheet: (mints, u) => (++n === 1 ? bad(mints, u) : ALL(mints)) });
      h.m.registerLogoMints(nodes(12));
      for (let i = 0; i < 6; i++) h.m.imageFor(S(i), 40);
      await until(() => h.m.imageStats().ready === 6);
      assert.equal(h.sheetCalls().length, 1, name);
      assert.equal(h.imgCalls().length, 6, `${name}: per request while sheets cool down`);
      let st = h.m.imageStats();
      assert.equal(st.sheetsOff, false, name); assert.equal(st.sheetCools, 1, name); assert.equal(st.sheetsCoolUntil, T0 + h.m.SHEET_COOL_MS, name);
      mock.timers.tick(h.m.SHEET_COOL_MS);
      for (let i = 6; i < 12; i++) h.m.imageFor(S(i), 40);
      await until(() => h.m.imageStats().ready === 12);
      assert.equal(h.sheetCalls().length, 2, `${name}: a sheet again after the cooldown`);
      assert.equal(h.imgCalls().length, 6, name);
      st = h.m.imageStats();
      assert.equal(st.sheets, 1, name); assert.equal(st.sheetsOff, false, name); assert.equal(st.e429, 0, name);
      mock.timers.setTime(T0);
    }
    // a 429 is counted in e429 like a single load's and pauses every start (PAUSE_MS, + jitter, without a Retry-After); the
    // same sheet is asked again after it
    let n = 0;
    let h = await fresh({ sheet: (mints) => (++n === 1 ? new Response("slow down", { status: 429 }) : ALL(mints)) });
    h.m.registerLogoMints(nodes(6));
    for (let i = 0; i < 6; i++) h.m.imageFor(S(i), 40);
    await settle();
    assert.equal(h.m.imageStats().e429, 1);
    assert.ok(h.m.imageStats().pausedUntil >= T0 + h.m.PAUSE_MS);
    mock.timers.tick(h.m.PAUSE_MS * 1.25);
    await until(() => h.m.imageStats().ready === 6);
    assert.equal(h.sheetCalls().length, 2); assert.equal(h.imgCalls().length, 0);
    assert.equal(h.m.imageStats().sheetsOff, false);
    // a thrown fetch (network) is the link's: sheets stay on, the probe (GET /api/health) brings the link back, the next sheet
    // carries them all
    n = 0;
    mock.timers.setTime(T0);
    h = await fresh({ sheet: (mints) => { if (++n === 1) throw new TypeError("network"); return ALL(mints); } });
    h.m.registerLogoMints(nodes(6));
    for (let i = 0; i < 6; i++) h.m.imageFor(S(i), 40);
    await settle();
    assert.equal(h.m.imageStats().linkDown, true);
    assert.equal(h.m.imageStats().sheetsOff, false);
    mock.timers.tick(h.m.LINK_PROBE_MS * 1.25);
    await until(() => h.m.imageStats().ready === 6);
    assert.deepEqual(h.imgCalls(), ["/api/health"], "the probe; no logo one by one"); assert.equal(h.sheetCalls().length, 2);
    assert.equal(h.m.imageStats().sheetsOff, false); assert.equal(h.m.imageStats().linkDown, false);
  } finally { mock.timers.reset(); }
});

test("what never enters a sheet: unregistered sources, non-proxy URLs, sources with &w=, sharper first wants, upgrades, and batches under SHEET_MIN", async () => {
  const h = await fresh({ sheet: ALL });
  const { m } = h;
  m.registerLogoMints([...nodes(5), { mint: "m5", image: "https://cdn.test/5.png" }, { mint: "m6", image: "/api/img?u=x&w=64" }, { mint: "m7", image: null }]);
  for (let i = 0; i < 4; i++) m.imageFor(S(i), 40);   // a sheet of four
  m.imageFor(S(4), 200);                               // registered, but its first load is a 256: per request
  m.imageFor(S(9), 40);                                // not registered
  m.imageFor("https://cdn.test/5.png", 40);            // not a proxy URL (and never registered)
  m.imageFor("/api/img?u=x&w=64", 40);                 // an explicit size
  await until(() => m.imageStats().ready === 8, 5_000, () => ({ ...m.imageStats(), calls: h.calls }));
  const sheets = h.sheetCalls();
  assert.equal(sheets.length, 1);
  assert.deepEqual(new URL(sheets[0], "http://x").searchParams.get("m")!.split(","), [3, 2, 1, 0].map(M));
  const imgs = h.imgCalls();
  assert.deepEqual(new Set(imgs), new Set([`${S(4)}&w=256`, `${S(9)}&w=64`, "https://cdn.test/5.png", "/api/img?u=x&w=64"]));
  // an upgrade of a sheet cell (a bubble that grew) is a single request at the larger size
  assert.equal((m.imageFor(S(0), 40) as Bmp).width, 64);
  m.imageFor(S(0), 200);
  await until(() => h.imgCalls().length === 5);
  assert.equal(h.imgCalls()[4], `${S(0)}&w=256`);
  await until(() => (m.imageFor(S(0), 200) as Bmp).width === 256);
  assert.equal(h.sheetCalls().length, 1);
  // fewer than SHEET_MIN sheet-able wants go per request at once
  m.registerLogoMints(nodes(3, 20));
  for (let i = 20; i < 23; i++) m.imageFor(S(i), 40);
  await until(() => m.imageStats().ready === 11, 5_000, () => m.imageStats()); // 8 sources (the upgrade replaced one) + 3
  assert.equal(h.sheetCalls().length, 1);
  assert.ok(h.imgCalls().includes(`${S(21)}&w=64`));
});

test("desktop: 400 wants = three sheets of 128 in flight and 16 held for the next slot (none per request); a non-sheet want still goes per request at once", async () => {
  const pending: ((r: Response) => void)[] = [];
  const h = await fresh({ sheet: (mints) => new Promise<Response>((resolve) => pending.push(() => resolve(ALL(mints)))) });
  const { m } = h;
  assert.equal(m.SHEET_MAX, 128); assert.equal(m.SHEET_INFLIGHT, 3); assert.equal(m.MAX_INFLIGHT, 96);
  m.registerLogoMints(nodes(400));
  for (let i = 0; i < 400; i++) m.imageFor(S(i), 40);
  m.imageFor("https://cdn.test/solo.png", 40);
  await settle();
  assert.equal(h.sheetCalls().length, 3);
  for (const u of h.sheetCalls()) assert.equal(new URL(u, "http://x").searchParams.get("m")!.split(",").length, 128);
  assert.deepEqual(h.imgCalls(), ["https://cdn.test/solo.png"], "the held sheet sources do not leak into the per-request loop");
  let st = m.imageStats();
  assert.equal(st.sheetInflight, 3); assert.equal(st.queued, 16); assert.equal(st.sheetSrcs, 384); assert.equal(st.inflight, 384, "the solo load is done; the 384 sheet sources are in flight");
  assert.ok(m.imageReady("https://cdn.test/solo.png"), "the solo load went through while the sheets were in flight");
  for (const r of pending.splice(0)) r();
  await until(() => m.imageStats().ready === 401 || h.sheetCalls().length === 4);
  await settle();
  assert.equal(h.sheetCalls().length, 4, "the held 16 form the fourth sheet once a slot is free");
  assert.equal(new URL(h.sheetCalls()[3], "http://x").searchParams.get("m")!.split(",").length, 16);
  for (const r of pending.splice(0)) r();
  await until(() => m.imageStats().ready === 401);
  st = m.imageStats();
  assert.equal(st.sheets, 4); assert.equal(st.sheetCells, 400); assert.equal(st.inflight, 0); assert.equal(st.queued, 0);
  assert.equal(h.imgCalls().length, 1);
});

test("phone (innerWidth 390): SHEET_MAX 64, SHEET_INFLIGHT 2, MAX_INFLIGHT 32; 200 wants = two sheets of 64, then 64 + 8", async () => {
  const pending: (() => void)[] = [];
  const h = await fresh({ innerWidth: 390, sheet: (mints) => new Promise<Response>((resolve) => pending.push(() => resolve(ALL(mints)))) });
  const { m } = h;
  assert.equal(m.SHEET_MAX, 64); assert.equal(m.SHEET_INFLIGHT, 2); assert.equal(m.MAX_INFLIGHT, 32); assert.equal(m.PIXEL_BUDGET, 24e6);
  m.registerLogoMints(nodes(200));
  for (let i = 0; i < 200; i++) m.imageFor(S(i), 40);
  await settle(2);
  assert.equal(h.sheetCalls().length, 2);
  assert.equal(m.imageStats().queued, 72, "the rest wait for a sheet slot");
  for (const r of pending.splice(0)) r();
  await until(() => h.sheetCalls().length === 4);
  for (const r of pending.splice(0)) r();
  await until(() => m.imageStats().ready === 200);
  const sizes = h.sheetCalls().map((u) => new URL(u, "http://x").searchParams.get("m")!.split(",").length);
  assert.deepEqual(sizes, [64, 64, 64, 8]);
  assert.equal(h.imgCalls().length, 0);
});

// (mock clock: the sheet that never answers keeps its FETCH_MAX_MS timer, which on the real clock held this file's process
// open for 5 min after its last test)
test("a sheet costs one start token, like a single load", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = await fresh({ sheet: () => new Promise<Response>(() => { /* never answers: the sheet stays in flight */ }) });
    const { m } = h;
    const before = m.imageStats().tokens;
    m.registerLogoMints(nodes(10));
    for (let i = 0; i < 10; i++) m.imageFor(S(i), 40);
    await settle(2);
    assert.equal(h.sheetCalls().length, 1);
    assert.equal(m.imageStats().tokens, before - 1);
    assert.equal(m.imageStats().sheetInflight, 1);
  } finally { mock.timers.reset(); }
});

test("imagesVersion() increments once per sheet and onImageLoaded fires once per sheet", async () => {
  const h = await fresh({ sheet: ALL });
  const { m } = h;
  let fired = 0;
  const off = m.onImageLoaded(() => { fired++; });
  const v0 = m.imagesVersion();
  m.registerLogoMints(nodes(20));
  for (let i = 0; i < 12; i++) m.imageFor(S(i), 40);
  await until(() => m.imageStats().ready === 12);
  assert.equal(m.imagesVersion(), v0 + 1);
  assert.equal(fired, 1);
  for (let i = 12; i < 20; i++) m.imageFor(S(i), 40);
  await until(() => m.imageStats().ready === 20);
  assert.equal(m.imagesVersion(), v0 + 2);
  assert.equal(fired, 2);
  off();
});

test("pixels: a cell counts 64 x 64; cells are evicted least recently used (and closed) when the budget is exceeded", async () => {
  const h = await fresh({ innerWidth: 390, sheet: ALL }); // a 24 Mpx budget
  const { m } = h;
  m.registerLogoMints(nodes(8));
  for (let i = 0; i < 8; i++) m.imageFor(S(i), 40);
  await until(() => m.imageStats().ready === 8);
  const cells = Array.from({ length: 8 }, (_, i) => m.imageFor(S(i), 40) as Bmp);
  assert.equal(m.imageStats().pixels, 8 * 4096);
  // 370 single loads at 256 (65 536 px each) push the cache past 24 Mpx: the eight cells are the least recently used
  const N = 370;
  for (let i = 0; i < N; i++) m.imageFor(S(`big${i}`), 256);
  await until(() => m.imageStats().inflight === 0 && m.imageStats().queued === 0, 20_000);
  const st = m.imageStats();
  for (let i = 0; i < 8; i++) { assert.equal(m.imageReady(S(i)), false, `cell ${i} evicted`); assert.ok(cells[i].closed, `cell ${i} closed`); }
  assert.ok(st.pixels <= st.budget, `pixels ${st.pixels} within the budget`);
  assert.equal(st.pixels, st.ready * 256 * 256, "exact accounting after the cells went");
  assert.ok(st.ready >= Math.floor((st.budget * 0.9) / 65536) && st.ready < N, `${st.ready} sharp logos kept`);
});
