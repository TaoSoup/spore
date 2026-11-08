// Bounded image loader for the map (DESIGN §11.5 "Metadata coverage"): at most MAX_INFLIGHT requests
// at a time, newest wants first (what is on screen now beats what scrolled away), a failed set so a 404
// is never retried every frame, and a `version` counter the draw loop reads to know a sprite may now
// be upgraded from letter to logo. Everything goes through the /api/img proxy (Coin.image already does).
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
/// failure is retried up to RETRIES times after RETRY_MS (or the Retry-After header): a burst of wants at a warm reopen
/// must not turn hundreds of logos into permanent letters.
const MIN_START_MS = 25, BURST = 2400, RETRIES = 3, RETRY_MS = 5_000;
const MIN_PX = 64, MAX_PX = 256, DEFAULT_PX = 128;

export type MapImage = HTMLCanvasElement | ImageBitmap;
type Entry = { img: MapImage; size: number; lastUse: number };

const ready = new Map<string, Entry>();
const failed = new Set<string>();
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
/// Retries so far per source (429 / 503 / network), cleared on success or final failure.
const retries = new Map<string, number>();
/// Logo sheets: source -> mint (registerLogoMints), misses per source (pending cells), sources that go per request from now on.
const mintOf = new Map<string, string>();
const sheetMiss = new Map<string, number>();
const noSheet = new Set<string>();
/// Sources that are in a sheet right now: in `inflight` (a want does not re-queue them) but not single loads (MAX_INFLIGHT).
const inSheet = new Set<string>();
let sheetsOff = false, sheetInflight = 0, sheetFails = 0;
let sheets = 0, sheetCells = 0, sheetPending = 0, sheetDead = 0, sheetBytes = 0, sheetMs = 0;
/// A failed response, with what the server said about trying again.
class HttpError extends Error {
  status: number; retryAfterMs: number;
  constructor(status: number, retryAfterMs: number) { super(String(status)); this.status = status; this.retryAfterMs = retryAfterMs; }
}

/// 64, 128 or 256 for a wanted on-screen size in device pixels (128 when the caller does not say).
export const thumbSize = (wantPx?: number) => {
  if (wantPx == null || !Number.isFinite(wantPx) || wantPx <= 0) return DEFAULT_PX;
  const p = 2 ** Math.ceil(Math.log2(Math.max(1, wantPx)));
  return Math.max(MIN_PX, Math.min(MAX_PX, p));
};

/// Changes whenever an image finishes loading: a cheap "something new to draw" signal.
export const imagesVersion = () => version;
export const onImageLoaded = (f: () => void) => { listeners.push(f); return () => { listeners = listeners.filter((g) => g !== f); }; };
export const imageStats = () => ({
  ready: ready.size, failed: failed.size, inflight: inflight.size, queued: queued.size, pixels, budget: PIXEL_BUDGET, e429, thumbs, maxInflight: MAX_INFLIGHT, tokens,
  sheets, sheetCells, sheetPending, sheetDead, sheetBytes, sheetMs: Math.round(sheetMs), sheetsOff, sheetInflight, sheetSrcs: inSheet.size, sheetMax: SHEET_MAX,
});

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
  const res = await fetch(fetchUrl(src, sizeOf()), { credentials: "same-origin" });
  if (res.status === 429) e429++;
  if (res.ok && res.headers.get("x-img-thumb")) thumbs++;
  if (!res.ok) { const ra = Number(res.headers.get("retry-after")); throw new HttpError(res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : RETRY_MS); }
  const blob = await res.blob();
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

/// A source gives up (a 404, a decode failure, a dead sheet cell): no retry; a failed sharper reload keeps its thumbnail.
function failSrc(src: string) {
  inflight.delete(src); wantOf.delete(src); minOf.delete(src); retries.delete(src); sheetMiss.delete(src);
  if (ready.has(src)) noUpgrade.add(src); else failed.add(src);
}

// ---------------------------------------------------------------- logo sheets
/// Can this waiting source go in a sheet: sheets on, a known mint, a proxy URL, not ready / failed / loading, first load at 64.
const sheetable = (src: string) =>
  !sheetsOff && mintOf.has(src) && !noSheet.has(src) && !ready.has(src) && !failed.has(src) && !inflight.has(src) && isProxy(src) && firstSize(src) === MIN_PX;
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
  inflight.delete(src); retries.delete(src); sheetMiss.delete(src);
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
    for (const [src, stamp0] of list) if (!ready.has(src) && !failed.has(src) && !inflight.has(src)) queued.set(src, stamp0);
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
  const back = () => { for (let i = 0; i < batch.length; i++) { const s = batch[i]; inflight.delete(s); if (!ready.has(s) && !failed.has(s)) queued.set(s, stamps[i]); } };
  const off = () => { sheetsOff = true; back(); };
  const transient = () => { if (++sheetFails >= SHEET_FAIL_MAX) sheetsOff = true; back(); };
  try {
    let res: Response;
    try { res = await fetch(url, { credentials: "same-origin" }); } catch { transient(); return; }
    if (res.status === 429) e429++;
    if (res.status === 404 || res.status === 501) { off(); return; }   // no sheets on this server
    if (!res.ok) { transient(); return; }
    const hex = res.headers.get("x-sheet"), n = Number(res.headers.get("x-sheet-n"));
    if (hex === null) { off(); return; }   // a 200 that is not a sheet (a proxy that strips the headers, an HTML page)
    if (n !== batch.length) { transient(); return; }
    const present = sheetBits(hex, n), dead = sheetBits(res.headers.get("x-sheet-dead") ?? "", n);
    const blob = await res.blob();
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
      else if (dead[i]) { failSrc(src); died++; }
      else if (present[i]) { inflight.delete(src); noSheet.add(src); queued.set(src, stamps[i]); }   // the cut failed: per request
      else { if (pendingCell(src, stamps[i])) retry.push([src, stamps[i]]); pend++; }
    }
    if (retry.length) retryLater(retry, Number(res.headers.get("x-sheet-pending")) || pend);
    sheets++; sheetCells += got; sheetPending += pend; sheetDead += died; sheetBytes += blob.size; sheetMs += performance.now() - t0; thumbs += got;
    evict();
    version++;
    for (const f of listeners) f();
  } finally {
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
    if (failed.has(src) || inflight.has(src)) continue;
    const cur = ready.get(src);
    if (cur && thumbSize(wantOf.get(src)) <= cur.size) { wantOf.delete(src); continue; } // already as sharp as wanted
    inflight.add(src);
    tokens -= 1;
    // first load: the smallest size asked (the larger one follows as an upgrade); an upgrade: the largest size asked
    const size0 = cur ? thumbSize(wantOf.get(src)) : firstSize(src);
    const sizeOf = () => size0;
    const fail = () => { failSrc(src); pump(); };
    // a rate limit, an outage or a dropped connection: back in the queue after a pause, a few times
    const failLater = (e: unknown) => {
      const transient = e instanceof HttpError ? e.status === 429 || e.status >= 500 : e instanceof TypeError;
      const n = retries.get(src) ?? 0;
      if (!transient || n >= RETRIES) { fail(); return; }
      retries.set(src, n + 1);
      inflight.delete(src);
      const delay = e instanceof HttpError ? e.retryAfterMs : RETRY_MS;
      setTimeout(() => { if (!ready.has(src) && !failed.has(src) && !inflight.has(src)) { queued.set(src, ++clock); pump(); } }, delay * (n + 1));
      pump();
    };
    const done = (img: MapImage, size: number) => {
      inflight.delete(src);
      retries.delete(src);
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
        want(src); // keeps a pending upgrade at the front while the bubble stays on screen
      }
    }
    return e.img;
  }
  if (failed.has(src)) return null;
  const size = thumbSize(wantPx);
  if ((wantOf.get(src) ?? 0) < size) wantOf.set(src, size);
  if ((minOf.get(src) ?? Infinity) > size) minOf.set(src, size);
  if (inflight.has(src)) return null;
  want(src);
  return null;
}
export const imageReady = (src: string | null | undefined) => !!src && ready.has(src);
export const imageFailed = (src: string | null | undefined) => !!src && failed.has(src);
