// Bounded image loader for the map (DESIGN §11.5 "Metadata coverage"): at most MAX_INFLIGHT requests
// at a time, newest wants first (what is on screen now beats what scrolled away), a dead set so a 404
// is not retried every frame (only after DEAD_MS, below), and a `version` counter the draw loop reads to know a sprite may
// now be upgraded from letter to logo. Everything goes through the /api/img proxy (Coin.image already does).
//
// Logos arrive at any size (a 2000 px PNG for a 20 px bubble is common), so each one is downsampled on
// load to a square, centre-cropped thumbnail of nextPow2(the largest size asked for), 64..256 px. The
// decode and the downsample happen off the main thread: the logo is fetched as a blob and turned into
// an ImageBitmap (full decode in the browser's image threads), then cropped and resized into a second
// bitmap of the wanted size; the big one is closed at once. Drawing a decoded <img> scaled into a small
// canvas made Chrome re-decode a 1–2 k px PNG on the main thread (50–60 ms hitches while zooming into a
// cluster); when a browser cannot build bitmaps the old <img> + canvas path is used. A bubble that later
// wants a sharper logo re-queues its source once per size step (64 → 128 → 256); the object imageFor
// returns then changes, which is the renderer's signal to rebuild that bubble's sprite. Memory is
// bounded by a pixel budget with least-recently-used eviction; an evicted logo loads again when it is
// wanted again (the browser's HTTP cache usually answers).
//
// Every imageFor call is O(1): it stamps the source with a use counter (`clock`). The waiting queue is a
// Map of source → stamp of its latest want, and a free slot takes the highest stamp, so the bubbles of
// the last drawn frame load first (biggest first, since the frame draws small to big) without moving
// array entries for every bubble on every frame.
// (2026-10-21, map logos from far) every family top of the overview (~2.3k) wants its logo at once: 48 in flight, a
// 2400-start burst refilled at 40/s, a 5000-entry queue, a 48 Mpx budget (24 Mpx on a <= 700 px wide window), and the
// proxy is asked for a server-side thumbnail (&w=64|128|256; a server that ignores w sends the original, which still works).
// (2026-10-21, flat fix) 96 in flight on a desktop, 32 on a <= 700 px wide window (the h2 harness and the live site multiplex them;
// the token bucket below still caps the starts at 4,800 per 60 s). A source is first loaded at the SMALLEST size asked for it
// (a 64 never waits behind a 256 of the same logo); the larger size follows as an upgrade with the source's original stamp.
// (2026-10-21 21:31Z) 192 in flight was tried and measured WORSE on a fresh serve-prod against live (0.204 at 8 s, ~10 logos/s:
// the live /api/img thumbnailer is throughput-bound, 0.4-1.9 s per answer at 30 concurrent), so 96 stays.
// (2026-10-22, logo sheets) the FIRST 64 px load of a registered /api/img source goes in a logo sheet: up to SHEET_MAX sources
// per GET /api/logo-sheet?w=64&m=<mint>,<mint>,... (one request, one image of 16 x 64 px cells, one decode, one 64 x 64 bitmap
// cut per cell), SHEET_INFLIGHT sheets at a time, newest wants first (the frame's biggest bubbles). ThreeMap registers
// source -> mint (registerLogoMints); the server answers hex bitmaps of the PRESENT and the DEAD cells (x-sheet, x-sheet-dead:
// byte j bit b = cell 8j+b) and leaves a cell it could not thumbnail within its budget PENDING: that source is asked again
// after SHEET_RETRY_MS, and after SHEET_MISS_MAX misses it takes the per-request path (which waits for the thumbnail). A 404 /
// 501, or a 200 without x-sheet (an older server, a proxy that strips the header), switches sheets off for the page and
// everything loads one by one as before; SHEET_FAIL_MAX transient failures in a row (429 / 5xx / network) do the same. Sharper
// upgrades (128 / 256), sources without a mint, non-proxy URLs, sources with an explicit &w= and sources that already have a
// thumbnail never go in a sheet. A sheet takes one start token like a single load and does not count against MAX_INFLIGHT;
// while every sheet slot is busy the per-request loop leaves the sheet-able sources alone (they are the next sheet), and a
// want pumps on a microtask so a frame's burst of wants forms sheets instead of starting the first few one by one.
// (2026-11-10, logos that come later) no failure is final for the page any more: a logo the server could not fetch at the
// first ask (its host slow, rate limited or down for a while) used to stay a letter until a reload. A TEMPORARY failure
// (429, 408, 5xx: the server answers 503 + Retry-After when its upstream timed out or was limited; a network error; no
// answer within FETCH_MAX_MS, or a body not read within FETCH_TIMEOUT_MS of the answer) is retried after RETRY_STEPS_MS[n]
// (10 s, 30 s, 2 min, 10 min), never sooner than the
// server's Retry-After, plus 0..RETRY_JITTER of it so a burst of failures does not come back as a burst; while it waits
// (`held`) a want only refreshes its stamp, so a renderer that asks every frame cannot start it early. Past the last step,
// and at once for a 404, a dead sheet cell or an image the browser cannot decode, the source is DEAD for DEAD_MS (15 min,
// doubling per death up to DEAD_MAX_MS): imageFailed() is true and imageRetryAt() says until when; after that the next want
// asks it ONCE more (any failure sends it straight back to dead), and at the DEATH_MAX-th death it stays failed for the
// page. A source therefore costs at most RETRY_STEPS_MS.length + DEATH_MAX single loads per page session. A pending sheet
// cell is no failure (asked again, as above). A dead verdict tells the listeners (version++, once per burst) like a load
// does, so the renderer re-evaluates.
const PHONE = typeof window !== "undefined" && (window.innerWidth || 1024) <= 700;
export const MAX_INFLIGHT = PHONE ? 32 : 96;
export const PIXEL_BUDGET = PHONE ? 24e6 : 48e6; // ~192 MB of RGBA (96 MB on a phone)
const QUEUE_CAP = 5000;
/// Logo sheets: sources per sheet (128 mints = a 5.9 KB request line, safe behind any proxy; 64 on a phone), sheets in flight,
/// the smallest batch worth a sheet (fewer go per request), the re-ask delay for a pending cell and how many misses a source
/// may take before it goes per request, and how many transient sheet failures in a row switch sheets off.
export const SHEET_MAX = PHONE ? 64 : 128;
export const SHEET_INFLIGHT = PHONE ? 2 : 3;
export const SHEET_MIN = 4;
export const SHEET_RETRY_MS = 1500;
/// (repair 2026-10-22) a sheet with few pending cells (<= SHEET_RETRY_FAST_N) is asked again after SHEET_RETRY_FAST_MS: its
/// downloads started at the server's budget and most logos land within the second, so the 1.5 s wait left warm cells idle.
export const SHEET_RETRY_FAST_MS = 600;
export const SHEET_RETRY_FAST_N = 24;
export const SHEET_MISS_MAX = 2;
export const SHEET_FAIL_MAX = 2;
const SHEET_COLS = 16, SHEET_CELL = 64;
/// Load starts are paced by a token bucket: BURST starts may go at once (the whole overview of logos on
/// /map, ~2.3k, starts in about a minute of network time instead of trickling in at 12/s), refilled at one start per
/// MIN_START_MS (40/s). Any 60 s window therefore starts at most BURST + 60 000 / MIN_START_MS = 2400 + 2400 = 4800
/// loads, under the /api/img proxy's 6000/min per client (server/lib/config.mjs DEFAULT_RATES.img). A 429 / 503 / network
/// failure is retried after a backoff (RETRY_STEPS_MS below): a burst of wants at a warm reopen must not turn hundreds of
/// logos into permanent letters.
const MIN_START_MS = 25, BURST = 2400;
/// Temporary failures: the wait before retry n (the last step repeats no more: one step per retry, then dead), the jitter on
/// top (a share of the wait, upward only: never sooner than the server asked), the longest Retry-After honoured, and how
/// long a single request may take before it counts as a temporary failure (timedFetch): FETCH_TIMEOUT_MS to read the body
/// once the answer's headers are here, FETCH_MAX_MS for the whole request from the fetch() call.
export const RETRY_STEPS_MS = [10_000, 30_000, 120_000, 600_000];
export const RETRY_JITTER = 0.25;
export const RETRY_AFTER_MAX_MS = 30 * 60_000;
export const FETCH_TIMEOUT_MS = 60_000;   // the body, from the headers: a thumbnail of a few KB that stalls this long is stuck
/// (fix 2026-11-10) the whole request, from the fetch() call. The browser's own queue counts here: on HTTP/1.1 (6 sockets per
/// host) a burst of wants waits in it while the server holds slow answers up to its 30 s download budget, and a 60 s limit
/// armed at fetch() timed those requests out before they were even sent. Long: it only ends a request that never ends.
export const FETCH_MAX_MS = 5 * 60_000;
/// A dead source (404, dead sheet cell, decode failure, the backoff steps used up) refuses wants for deadMs(d) after its
/// d-th death: DEAD_MS, doubling up to DEAD_MAX_MS (15 min, 30 min, 1 h, 2 h, 2 h: past the server's own first re-download
/// of a vanished file, an hour after it failed); at the DEATH_MAX-th it refuses them for the rest of the page.
export const DEAD_MS = 15 * 60_000;
export const DEAD_MAX_MS = 2 * 3_600_000;
export const DEATH_MAX = 6;
export const deadMs = (d: number) => Math.min(DEAD_MAX_MS, DEAD_MS * 2 ** Math.max(0, Math.floor(d) - 1));
const MIN_PX = 64, MAX_PX = 256, DEFAULT_PX = 128;

export type MapImage = HTMLCanvasElement | ImageBitmap;
type Entry = { img: MapImage; size: number; lastUse: number };

const ready = new Map<string, Entry>();
/// Dead sources and until when (Date.now() ms) they refuse wants; Infinity = for the rest of the page. An expired entry is
/// dropped when it is next looked at (isDead), so the next want asks the source once more.
const dead = new Map<string, number>();
/// How often each source went dead this page session (DEATH_MAX); cleared when it loads.
const deaths = new Map<string, number>();
/// Sources waiting out a backoff after a temporary failure, with the stamp of their latest want: their timer puts them back
/// in the queue with it (an old stamp when nothing on screen wants them any more).
const held = new Map<string, number>();
const inflight = new Set<string>();
/// Waiting sources and the stamp of their latest want.
const queued = new Map<string, number>();
/// Largest thumbnail size asked for per source, while it waits or loads (and for an upgrade).
const wantOf = new Map<string, number>();
/// Smallest thumbnail size asked for per source while it has no thumbnail yet: the first load uses it.
const minOf = new Map<string, number>();
/// Sources whose sharper reload failed: they keep the thumbnail they have and are not asked again.
const noUpgrade = new Set<string>();
let version = 0;
let clock = 0;
let pixels = 0;
let listeners: (() => void)[] = [];
/// Start tokens left and when they were last refilled (see BURST).
let tokens = BURST, tokensAt = -1;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
/// 429 responses seen, and responses that were a server-side thumbnail (x-img-thumb header).
let e429 = 0, thumbs = 0;
/// Temporary failures put on hold, retries started after a hold, dead verdicts, and dead sources asked again after DEAD_MS.
let heldN = 0, retriedN = 0, deadN = 0, revivedN = 0;
/// The URL actually fetched: a /api/img proxy URL asks for a server-side thumbnail of the wanted size (64 / 128 / 256);
/// any other URL is fetched as is. The cache key stays `src`.
export const fetchUrl = (src: string, size: number) => {
  if (!/(^|\/)api\/img\?/.test(src) || /[?&]w=/.test(src)) return src;
  const w = size <= 64 ? 64 : size <= 128 ? 128 : 256;
  return `${src}&w=${w}`;
};
/// A /api/img proxy URL without an explicit size: the only kind a sheet can carry (the server keys cells by mint).
const isProxy = (src: string) => /(^|\/)api\/img\?/.test(src) && !/[?&]w=/.test(src);
/// The size of a source's first load: the smallest size asked for it (a 64 never waits behind a 256 of the same logo).
const firstSize = (src: string) => Math.min(thumbSize(wantOf.get(src)), thumbSize(minOf.get(src) ?? wantOf.get(src)));
/// Temporary failures in a row per source (the backoff step), cleared on success; a death sets it to the last step, so the
/// one ask after DEAD_MS goes straight back to dead when it fails.
const retries = new Map<string, number>();
/// Logo sheets: source -> mint (registerLogoMints), misses per source (pending cells), sources that go per request from now on.
const mintOf = new Map<string, string>();
const sheetMiss = new Map<string, number>();
const noSheet = new Set<string>();
/// Sources that are in a sheet right now: in `inflight` (a want does not re-queue them) but not single loads (MAX_INFLIGHT).
const inSheet = new Set<string>();
let sheetsOff = false, sheetInflight = 0, sheetFails = 0;
let sheets = 0, sheetCells = 0, sheetPending = 0, sheetDead = 0, sheetBytes = 0, sheetMs = 0;
/// A failed response, with what the server said about trying again (0 = nothing).
class HttpError extends Error {
  status: number; retryAfterMs: number;
  constructor(status: number, retryAfterMs: number) { super(String(status)); this.status = status; this.retryAfterMs = retryAfterMs; }
}

/// A Retry-After header in ms: delta seconds or an HTTP date; 0 when absent, unreadable or already past.
export function retryAfterMs(h: string | null | undefined, now = Date.now()): number {
  if (h == null || h.trim() === "") return 0;
  const s = Number(h);
  if (Number.isFinite(s)) return s > 0 ? s * 1000 : 0;
  const t = Date.parse(h);
  return Number.isFinite(t) && t > now ? t - now : 0;
}
/// The wait before retry n (0-based) of a temporary failure: RETRY_STEPS_MS[n], or the server's Retry-After when that is
/// longer (at most RETRY_AFTER_MAX_MS), plus 0..RETRY_JITTER of it (`rnd` in [0, 1)).
export function backoffMs(n: number, retryAfter = 0, rnd = Math.random()): number {
  const step = RETRY_STEPS_MS[Math.max(0, Math.min(RETRY_STEPS_MS.length - 1, Math.floor(n) || 0))];
  const base = Math.max(step, Math.min(RETRY_AFTER_MAX_MS, retryAfter > 0 ? retryAfter : 0));
  return Math.round(base * (1 + RETRY_JITTER * Math.min(1, Math.max(0, Number(rnd) || 0))));
}
/// Worth another try soon: a rate limit, a request timeout, a server error (503 + Retry-After for an upstream that was slow
/// or limited), a dropped connection, or FETCH_MAX_MS / FETCH_TIMEOUT_MS (a TimeoutError / AbortError from the request's
/// signal).
export function isTemporary(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 429 || e.status === 408 || e.status >= 500;
  if (e instanceof TypeError) return true;
  const name = e && typeof e === "object" ? (e as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError";
}
const timeoutError = (): Error =>
  typeof DOMException === "function" ? new DOMException("The operation timed out.", "TimeoutError") : Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
/// An answer whose body is still to be read: blob() reads it, close() drops it unread (frees the connection); either one
/// ends the request's timers.
type Timed = { res: Response; blob: () => Promise<Blob>; close: () => void };
/// One request with two limits (a request that never ended held its slot for the page's lifetime): FETCH_MAX_MS from the
/// fetch() call, then FETCH_TIMEOUT_MS from the answer's headers for the body. Either one aborts the request with a
/// TimeoutError (a temporary failure). No limit where the browser has no AbortController, as before.
async function timedFetch(url: string): Promise<Timed> {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  let whole: ReturnType<typeof setTimeout> | null = null, body: ReturnType<typeof setTimeout> | null = null, read = false;
  const stop = () => {
    if (whole !== null) clearTimeout(whole);
    if (body !== null) clearTimeout(body);
    whole = body = null;
  };
  const abort = () => { stop(); try { ac?.abort(timeoutError()); } catch { /* ignore */ } };
  if (ac) whole = setTimeout(abort, FETCH_MAX_MS);
  let res: Response;
  try { res = await fetch(url, { credentials: "same-origin", signal: ac?.signal }); } catch (e) { stop(); throw e; }
  if (whole !== null) body = setTimeout(abort, FETCH_TIMEOUT_MS);   // (null: FETCH_MAX_MS ended it as the answer came)
  return {
    res,
    blob: async () => { read = true; try { return await res.blob(); } finally { stop(); } },
    close: () => {
      stop();
      if (read) return;
      read = true;
      try { void res.body?.cancel().catch(() => {}); } catch { /* ignore */ }
    },
  };
}
/// True while a dead source refuses wants. An entry whose time is up is dropped here: the next want asks once more.
function isDead(src: string): boolean {
  const until = dead.get(src);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  dead.delete(src); revivedN++;
  return false;
}

/// 64, 128 or 256 for a wanted on-screen size in device pixels (128 when the caller does not say).
export const thumbSize = (wantPx?: number) => {
  if (wantPx == null || !Number.isFinite(wantPx) || wantPx <= 0) return DEFAULT_PX;
  const p = 2 ** Math.ceil(Math.log2(Math.max(1, wantPx)));
  return Math.max(MIN_PX, Math.min(MAX_PX, p));
};

/// Changes whenever an image finishes loading or a source goes dead: a cheap "something new to draw" signal.
export const imagesVersion = () => version;
export const onImageLoaded = (f: () => void) => { listeners.push(f); return () => { listeners = listeners.filter((g) => g !== f); }; };
/// Dead verdicts of single loads tell the listeners once per burst (a microtask), not once per source.
let notifyQueued = false;
function notifySoon() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; version++; for (const f of listeners) f(); });
}
export const imageStats = () => {
  const now = Date.now();
  let failedNow = 0, givenUp = 0;
  for (const t of dead.values()) { if (t > now) failedNow++; if (t === Infinity) givenUp++; }
  return {
    ready: ready.size, failed: failedNow, givenUp, held: held.size, heldN, retried: retriedN, dead: deadN, revived: revivedN,
    inflight: inflight.size, queued: queued.size, pixels, budget: PIXEL_BUDGET, e429, thumbs, maxInflight: MAX_INFLIGHT, tokens,
    sheets, sheetCells, sheetPending, sheetDead, sheetBytes, sheetMs: Math.round(sheetMs), sheetsOff, sheetInflight, sheetSrcs: inSheet.size, sheetMax: SHEET_MAX,
  };
};

/// Source -> mint for the logo sheets, from the page's node list (first registration wins when two mints share one image).
/// A node without an image, or one whose image is not a proxy URL, is never asked for in a sheet.
export function registerLogoMints(list: Iterable<{ mint: string; image: string | null | undefined }>) {
  for (const n of list) {
    const src = n.image;
    if (src && typeof n.mint === "string" && n.mint && !mintOf.has(src) && isProxy(src)) mintOf.set(src, n.mint);
  }
}

/// The x-sheet / x-sheet-dead bitmap of an n-cell sheet: hex bytes, byte j bit b (1 << b) = cell 8j + b.
export function sheetBits(hex: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = i >> 3, byte = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
    if (Number.isFinite(byte) && byte & (1 << (i & 7))) out[i] = 1;
  }
  return out;
}

/// Square, centre-cropped downsample of a decoded image (cover fit), or null when the browser cannot draw it.
function thumb(img: HTMLImageElement, size: number): HTMLCanvasElement | null {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!(nw > 0 && nh > 0)) return null;
  const side = Math.min(nw, nh);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (!g) return null;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  try { g.drawImage(img, (nw - side) / 2, (nh - side) / 2, side, side, 0, 0, size, size); } catch { return null; }
  return c;
}

const release = (img: MapImage) => { if ("close" in img) img.close(); else img.width = 0; };

const canBitmap = typeof createImageBitmap === "function" && typeof fetch === "function";
if (!canBitmap) sheetsOff = true;
/// Fetch + decode + centre-crop + resize off the main thread. Resolves null when the browser cannot
/// (no bitmaps, an SVG without a size, a decode error): the caller then takes the <img> path.
async function loadBitmap(src: string, sizeOf: () => number): Promise<MapImage | null> {
  const t = await timedFetch(fetchUrl(src, sizeOf()));
  const res = t.res;
  if (res.status === 429) e429++;
  if (res.ok && res.headers.get("x-img-thumb")) thumbs++;
  if (!res.ok) { t.close(); throw new HttpError(res.status, retryAfterMs(res.headers.get("retry-after"))); }
  const blob = await t.blob();   // a body cut off (network, FETCH_TIMEOUT_MS / FETCH_MAX_MS) rejects: a temporary failure
  let full: ImageBitmap;
  try { full = await createImageBitmap(blob); } catch { return null; }
  const nw = full.width, nh = full.height;
  if (!(nw > 0 && nh > 0)) { full.close(); return null; }
  const side = Math.min(nw, nh), size = sizeOf();
  let out: MapImage | null = null;
  try {
    const small = await createImageBitmap(full, (nw - side) / 2, (nh - side) / 2, side, side, { resizeWidth: size, resizeHeight: size, resizeQuality: "medium" });
    if (small.width === size && small.height === size) out = small;
    else {
      // resize options ignored (older engines): the crop is decoded already, so a canvas draw is cheap
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d");
      if (g) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(small, 0, 0, size, size); out = c; }
      small.close();
    }
  } catch { out = null; }
  full.close();
  return out;
}

/// Evicts the least recently used logos until the cache is back under 90 % of the budget.
function evict() {
  if (pixels <= PIXEL_BUDGET) return;
  const all = Array.from(ready.entries()).sort((a, b) => a[1].lastUse - b[1].lastUse);
  for (const [src, e] of all) {
    if (pixels <= PIXEL_BUDGET * 0.9) break;
    ready.delete(src);
    pixels -= e.size * e.size;
    release(e.img);
  }
}

/// The waiting source wanted most recently (O(queue), once per started load). With `hold` the sources that are waiting for
/// a sheet slot are skipped: they load in the next sheet, not one by one behind it.
function nextQueued(hold: boolean): string | null {
  let best: string | null = null, bestAt = -1;
  for (const [src, at] of queued) if (at > bestAt && !(hold && sheetable(src))) { bestAt = at; best = src; }
  return best;
}

/// Refills the start tokens; false (with the refill timer armed) when none is left for a start now.
function haveToken(): boolean {
  const now = performance.now();
  if (tokensAt >= 0) tokens = Math.min(BURST, tokens + (now - tokensAt) / MIN_START_MS);
  tokensAt = now;
  if (tokens >= 1) return true;
  if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, Math.ceil((1 - tokens) * MIN_START_MS));
  return false;
}

/// A source fails for now (a 404, a decode failure, a dead sheet cell, the backoff steps used up): dead for deadMs (for the
/// rest of the page at the DEATH_MAX-th time), then one more want may ask it once. A failed sharper reload keeps its
/// thumbnail and is not asked again (noUpgrade). The caller tells the listeners.
function failSrc(src: string) {
  inflight.delete(src); wantOf.delete(src); minOf.delete(src); sheetMiss.delete(src); held.delete(src);
  if (ready.has(src)) { noUpgrade.add(src); retries.delete(src); return; }
  const d = (deaths.get(src) ?? 0) + 1;
  deaths.set(src, d);
  dead.set(src, d >= DEATH_MAX ? Infinity : Date.now() + deadMs(d));
  retries.set(src, RETRY_STEPS_MS.length);
  deadN++;
}
/// A temporary failure: the source waits out backoffMs (wants meanwhile only refresh its stamp), then goes back in the queue
/// with the stamp of its latest want. False when the backoff steps are used up (the caller fails it).
function holdSrc(src: string, retryAfter: number, stamp0: number): boolean {
  const n = retries.get(src) ?? 0;
  if (n >= RETRY_STEPS_MS.length) return false;
  retries.set(src, n + 1);
  inflight.delete(src);
  held.set(src, stamp0);
  heldN++;
  setTimeout(() => {
    const at = held.get(src);
    if (at === undefined) return;   // failed or loaded meanwhile
    held.delete(src);
    if (inflight.has(src) || isDead(src)) return;
    retriedN++;
    queued.set(src, at);
    pump();
  }, backoffMs(n, retryAfter));
  return true;
}

// ---------------------------------------------------------------- logo sheets
/// Can this waiting source go in a sheet: sheets on, a known mint, a proxy URL, not ready / dead / loading, first load at 64.
const sheetable = (src: string) =>
  !sheetsOff && mintOf.has(src) && !noSheet.has(src) && !ready.has(src) && !dead.has(src) && !inflight.has(src) && isProxy(src) && firstSize(src) === MIN_PX;
/// The waiting sources a sheet can carry, newest want first.
function sheetPool(): [string, number][] {
  const out: [string, number][] = [];
  for (const e of queued) if (sheetable(e[0])) out.push(e);
  return out.sort((a, b) => b[1] - a[1]);
}
/// "" for a same-origin proxy URL, the origin of an absolute one, null when it is no URL at all.
const originOf = (src: string): string | null => { if (src.startsWith("/")) return ""; try { return new URL(src).origin; } catch { return null; } };

/// A thumbnail cut from a sheet: the body of a single load's done() without its pump / version / listener calls.
function commit(src: string, img: MapImage, stamp0: number) {
  inflight.delete(src); retries.delete(src); sheetMiss.delete(src); deaths.delete(src);
  const old = ready.get(src);
  if (old) { pixels -= old.size * old.size; release(old.img); }
  ready.set(src, { img, size: SHEET_CELL, lastUse: ++clock });
  pixels += SHEET_CELL * SHEET_CELL;
  minOf.delete(src);
  // a larger size was asked too: queue the upgrade behind every newer want (its original stamp)
  if (thumbSize(wantOf.get(src)) > SHEET_CELL && !noUpgrade.has(src)) queued.set(src, stamp0);
  else wantOf.delete(src);
}
/// A cell the server has not rendered yet: true when it should be asked again in a later sheet (false after SHEET_MISS_MAX
/// misses: it is queued for the per-request path, which waits for the thumbnail).
function pendingCell(src: string, stamp0: number): boolean {
  inflight.delete(src);
  const m = (sheetMiss.get(src) ?? 0) + 1;
  sheetMiss.set(src, m);
  if (m <= SHEET_MISS_MAX) return true;
  noSheet.add(src); queued.set(src, stamp0);
  return false;
}
/// The pending cells of one sheet are asked again together after SHEET_RETRY_MS (one timer, one re-queue, one pump: asked
/// one by one they would never reach SHEET_MIN and would trickle through the per-request path instead).
function retryLater(list: [string, number][], pending = list.length) {
  setTimeout(() => {
    for (const [src, stamp0] of list) if (!ready.has(src) && !dead.has(src) && !inflight.has(src) && !held.has(src)) queued.set(src, stamp0);
    pump();
  }, pending <= SHEET_RETRY_FAST_N ? SHEET_RETRY_FAST_MS : SHEET_RETRY_MS);
}
/// Cell i of a decoded sheet as a 64 x 64 bitmap (one cut per cell from the ONE decoded sheet; cutting the blob per cell
/// would decode the sheet once per cell).
async function cellOf(sheet: ImageBitmap, i: number): Promise<MapImage | null> {
  const x = (i % SHEET_COLS) * SHEET_CELL, y = Math.floor(i / SHEET_COLS) * SHEET_CELL;
  const cell = await createImageBitmap(sheet, x, y, SHEET_CELL, SHEET_CELL);
  if (cell.width === SHEET_CELL && cell.height === SHEET_CELL) return cell;
  // the cut came back another size (an older engine): the pixels are decoded already, so a canvas draw is cheap
  const c = document.createElement("canvas");
  c.width = c.height = SHEET_CELL;
  const g = c.getContext("2d");
  let out: MapImage | null = null;
  if (g) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(cell, 0, 0, SHEET_CELL, SHEET_CELL); out = c; }
  cell.close();
  return out;
}
/// One sheet request for `batch` (newest want first; `stamps` are their queue stamps). Every source is in `inflight` until
/// it is committed, failed, re-queued (pending, or a sheet failure) or handed to the per-request path.
async function startSheet(batch: string[], stamps: number[], origin: string) {
  const t0 = performance.now();
  const url = `${origin}/api/logo-sheet?w=${SHEET_CELL}&m=${batch.map((s) => mintOf.get(s)).join(",")}`;
  // every source back in the queue with its stamp: the next sheet, or the per-request path once sheets are off
  const back = () => { for (let i = 0; i < batch.length; i++) { const s = batch[i]; inflight.delete(s); if (!ready.has(s) && !dead.has(s)) queued.set(s, stamps[i]); } };
  const off = () => { sheetsOff = true; back(); };
  const transient = () => { if (++sheetFails >= SHEET_FAIL_MAX) sheetsOff = true; back(); };
  let t: Timed | null = null;
  try {
    try { t = await timedFetch(url); } catch { transient(); return; }
    const res = t.res;
    if (res.status === 429) e429++;
    if (res.status === 404 || res.status === 501) { off(); return; }   // no sheets on this server
    if (!res.ok) { transient(); return; }
    const hex = res.headers.get("x-sheet"), n = Number(res.headers.get("x-sheet-n"));
    if (hex === null) { off(); return; }   // a 200 that is not a sheet (a proxy that strips the headers, an HTML page)
    if (n !== batch.length) { transient(); return; }
    const present = sheetBits(hex, n), deadBits = sheetBits(res.headers.get("x-sheet-dead") ?? "", n);
    // a body cut off (network, FETCH_TIMEOUT_MS / FETCH_MAX_MS) is a transient failure; before, its sources stayed in flight
    // for good
    let blob: Blob;
    try { blob = await t.blob(); } catch { transient(); return; }
    let sheet: ImageBitmap;
    try { sheet = await createImageBitmap(blob); } catch { transient(); return; }
    if (sheet.width < SHEET_COLS * SHEET_CELL || sheet.height < Math.ceil(n / SHEET_COLS) * SHEET_CELL) { sheet.close(); transient(); return; }
    sheetFails = 0;
    const cells = await Promise.all(batch.map((_, i) => (present[i] ? cellOf(sheet, i).catch(() => null) : Promise.resolve(null))));
    sheet.close();
    let got = 0, pend = 0, died = 0;
    const retry: [string, number][] = [];
    for (let i = 0; i < n; i++) {
      const src = batch[i], cell = cells[i];
      if (cell) { commit(src, cell, stamps[i]); got++; }
      else if (deadBits[i]) { failSrc(src); died++; }   // dead for DEAD_MS; this sheet's one notice below covers it
      else if (present[i]) { inflight.delete(src); noSheet.add(src); queued.set(src, stamps[i]); }   // the cut failed: per request
      else { if (pendingCell(src, stamps[i])) retry.push([src, stamps[i]]); pend++; }
    }
    if (retry.length) retryLater(retry, Number(res.headers.get("x-sheet-pending")) || pend);
    sheets++; sheetCells += got; sheetPending += pend; sheetDead += died; sheetBytes += blob.size; sheetMs += performance.now() - t0; thumbs += got;
    evict();
    version++;
    for (const f of listeners) f();
  } finally {
    t?.close();   // an early return left the body unread: drop it, end its timers
    for (const s of batch) inSheet.delete(s);   // every branch above took them out of `inflight` or re-queued them
    sheetInflight--;
    pump();
  }
}

function pump() {
  // sheets first: a batch of the newest sheet-able wants per free sheet slot, one start token each
  let hold = false;
  if (!sheetsOff) {
    while (sheetInflight < SHEET_INFLIGHT) {
      const pool = sheetPool();
      if (pool.length < SHEET_MIN) break;
      const o0 = originOf(pool[0][0]);
      if (o0 === null) { noSheet.add(pool[0][0]); continue; }
      const batch = pool.filter((e) => originOf(e[0]) === o0).slice(0, SHEET_MAX);
      if (batch.length < SHEET_MIN) break;
      if (!haveToken()) return;
      tokens -= 1;
      sheetInflight++;
      for (const [src] of batch) { queued.delete(src); inflight.add(src); inSheet.add(src); }
      void startSheet(batch.map((e) => e[0]), batch.map((e) => e[1]), o0);
    }
    // every slot busy and another sheet's worth waiting: those sources wait for a slot instead of going one by one
    hold = sheetInflight >= SHEET_INFLIGHT && sheetPool().length >= SHEET_MIN;
  }
  while (inflight.size - inSheet.size < MAX_INFLIGHT && queued.size) {
    // pacing: a start takes a token; with none left the next start waits for the refill (one timer, re-armed as needed)
    if (!haveToken()) return;
    const src = nextQueued(hold);
    if (src === null) break;
    const stamp0 = queued.get(src) ?? clock;
    queued.delete(src);
    if (dead.has(src) || inflight.has(src) || held.has(src)) continue;
    const cur = ready.get(src);
    if (cur && thumbSize(wantOf.get(src)) <= cur.size) { wantOf.delete(src); continue; } // already as sharp as wanted
    inflight.add(src);
    tokens -= 1;
    // first load: the smallest size asked (the larger one follows as an upgrade); an upgrade: the largest size asked
    const size0 = cur ? thumbSize(wantOf.get(src)) : firstSize(src);
    const sizeOf = () => size0;
    const fail = () => { failSrc(src); notifySoon(); pump(); };
    // a rate limit, an outage, a timeout or a dropped connection: back in the queue after a backoff (holdSrc); dead once
    // the steps are used up; anything else (a 404, another 4xx) is dead at once
    const failLater = (e: unknown) => {
      if (!isTemporary(e) || !holdSrc(src, e instanceof HttpError ? e.retryAfterMs : 0, stamp0)) { fail(); return; }
      pump();
    };
    const done = (img: MapImage, size: number) => {
      inflight.delete(src);
      retries.delete(src); deaths.delete(src);
      const old = ready.get(src);
      if (old) { pixels -= old.size * old.size; release(old.img); }
      ready.set(src, { img, size, lastUse: ++clock });
      pixels += size * size;
      minOf.delete(src);
      // a larger size was asked too: queue the upgrade behind every newer want (its original stamp)
      if (thumbSize(wantOf.get(src)) > size && size < MAX_PX && !noUpgrade.has(src)) queued.set(src, stamp0);
      else wantOf.delete(src);
      evict();
      version++;
      for (const f of listeners) f();
      pump();
    };
    // the <img> path: decode (async where the browser can), then one scaled draw into a canvas
    const viaImage = () => {
      const img = new Image();
      img.decoding = "async";
      const imgFail = () => { img.onload = img.onerror = null; fail(); };
      img.onload = () => {
        const finish = () => {
          img.onload = img.onerror = null;
          const size = sizeOf();
          const c = thumb(img, size); // the decoded original is dropped with `img`
          if (!c) { fail(); return; }
          done(c, size);
        };
        if (typeof img.decode === "function") img.decode().then(finish, finish); else finish();
      };
      img.onerror = imgFail;
      img.src = fetchUrl(src, sizeOf());
    };
    if (canBitmap) loadBitmap(src, sizeOf).then((bmp) => { if (bmp) done(bmp, bmp.width); else viaImage(); }, failLater);
    else viaImage();
  }
}

/// Stamps a want; a new source joins the queue (the stalest tenth is dropped when it is full).
function want(src: string) {
  const isNew = !queued.has(src);
  queued.set(src, ++clock);
  if (!isNew) return;
  if (queued.size > QUEUE_CAP) {
    const old = Array.from(queued.entries()).sort((a, b) => a[1] - b[1]).slice(0, Math.ceil(QUEUE_CAP / 10));
    for (const [s] of old) { queued.delete(s); if (!inflight.has(s)) { wantOf.delete(s); minOf.delete(s); } }
  }
  schedulePump();
}
/// One pump per burst of wants: a frame asks hundreds in one go, and a sheet must see the whole burst (not its first few).
let pumpSoon = false;
function schedulePump() { if (pumpSoon) return; pumpSoon = true; queueMicrotask(() => { pumpSoon = false; pump(); }); }

/// The logo thumbnail when it is here; otherwise null now, and the source joins the queue (once).
/// `wantPx` is the on-screen diameter in device pixels: it picks the thumbnail size, and a later call
/// that wants more than 1.25× the current size (below 256) re-queues the source at the larger size.
export function imageFor(src: string | null | undefined, wantPx?: number): MapImage | null {
  if (!src) return null;
  const e = ready.get(src);
  if (e) {
    e.lastUse = ++clock;
    if (wantPx != null && e.size < MAX_PX && wantPx > e.size * 1.25 && !noUpgrade.has(src) && !inflight.has(src)) {
      const size = thumbSize(wantPx);
      if (size > e.size) {
        if ((wantOf.get(src) ?? 0) < size) wantOf.set(src, size);
        if (held.has(src)) held.set(src, ++clock);   // an upgrade waiting out a backoff: its timer re-queues it
        else want(src); // keeps a pending upgrade at the front while the bubble stays on screen
      }
    }
    return e.img;
  }
  if (isDead(src)) return null;
  const size = thumbSize(wantPx);
  if ((wantOf.get(src) ?? 0) < size) wantOf.set(src, size);
  if ((minOf.get(src) ?? Infinity) > size) minOf.set(src, size);
  if (inflight.has(src)) return null;
  if (held.has(src)) { held.set(src, ++clock); return null; }   // backing off: the want only refreshes the stamp it returns with
  want(src);
  return null;
}
export const imageReady = (src: string | null | undefined) => !!src && ready.has(src);
/// The source failed and refuses wants for now (dead, see DEAD_MS); false again once its dead time is over. A source
/// waiting out a backoff is not failed: the loader retries it by itself.
export const imageFailed = (src: string | null | undefined) => !!src && isDead(src);
/// When a failed source takes a want again, in Date.now() ms: 0 when it is not failed (or its time is over), Infinity when
/// it is failed for the rest of the page.
export const imageRetryAt = (src: string | null | undefined): number => {
  if (!src) return 0;
  const until = dead.get(src);
  return until === undefined || until <= Date.now() ? 0 : until;
};
