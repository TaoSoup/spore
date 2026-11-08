// Off-chain metadata (the JSON behind a coin's `uri`) and the image proxy.
//
// Both talk to third-party hosts, so both are gated: metadata is fetched by a bounded, per-host
// paced queue that covers every tracked coin (DESIGN §11.5: a background sweep orders the work by
// locked value, then recency; failures retry with a growing backoff that survives restarts);
// images are served only from an allowlist of hosts pump.fun coins actually use, capped at 4 MB and
// cached on disk for 24 h. The browser never loads a creator-supplied URL directly. IPFS content is
// tried through a gateway rotation (ipfs.io → dweb.link → gateway.pinata.cloud → w3s.link, plus
// pump.fun's own pinata gateway): one gateway's 403/404/429/timeout is not final, the next may hold
// the bytes, and the least-busy gateway is asked first so six workers spread over the rotation.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync, createReadStream, unlinkSync, readdirSync, renameSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { META_NAME_RE, META_TYPES } from "./metahost.mjs";
import { HostGuard, guardedFetch, pinnedFetch } from "./net.mjs";
import { sniffImage } from "./validate.mjs";
import { IMAGE_THUMB_SIZES, THUMB_TYPES, SHEET_COLS, SHEET_MAX_CELLS, renderThumb, runOp } from "./img-worker.mjs";

export { IMAGE_THUMB_SIZES, THUMB_TYPES, SHEET_COLS, SHEET_MAX_CELLS, renderThumb };

export const META_TTL_S = 7 * 24 * 3600;      // a resolved JSON with an image is re-read this often (IPFS content never changes)
export const META_NOIMAGE_TTL_S = 24 * 3600;  // resolved, but no usable image: looked at again daily
export const META_RETRY_S = 15 * 60;          // first retry after a failure; doubles per attempt up to META_RETRY_MAX_S
export const META_RETRY_MAX_S = 24 * 3600;
// Version of the rule that decides which image URLs are usable (`isAllowedImageUrl`). Rows resolved
// under an older rule with no image are fetched once more at boot whatever their age, instead of
// waiting out META_NOIMAGE_TTL_S: rule 1 kept a host allowlist, rule 2 (2026-10-19) admits any
// public https host, and 5.2k coins (several of the largest roots among them) had lost their logo
// to the old list. Bump it whenever the rule widens again.
export const META_IMAGE_RULE = 2;
export const IMAGE_TTL_MS = 24 * 3600 * 1000;
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const META_MAX_BYTES = 512 * 1024;
export const HOST_SPACING_MS = 200;  // minimum gap between two requests to the same host (≈ 5/s per gateway)
const HOST_PAUSE_MS = 10_000;        // first pause after a 429 from a host (doubles, caps at 2 min)
const NEGATIVE_TTL_MS = 60_000;      // how long a failed image stays a fast 404

/** Seconds to wait before retrying a uri that failed `attempts` times in a row (15 min, 30, 1 h, 2 h … 24 h). */
export const retryAfterS = (attempts) => Math.min(META_RETRY_MAX_S, META_RETRY_S * 2 ** Math.max(0, (attempts ?? 1) - 1));

// DESIGN §7: ipfs.io, *.pinata.cloud, *.pump.fun, arweave.net, *.arweave.net, cf-ipfs.com and the
// subdomain-style IPFS gateways (<cid>.ipfs.<gateway>). The gateway list is explicit: a substring
// rule such as ".ipfs." would also admit a.ipfs.attacker.example, i.e. any host a stranger controls.
// dweb.link and w3s.link (path form) answer with a redirect to their subdomain form, which is the
// listed one; both hops pass this allowlist.
export const IPFS_SUBDOMAIN_GATEWAYS = ["dweb.link", "nftstorage.link", "w3s.link", "cf-ipfs.com", "4everland.io"];
// The rotation IPFS content is fetched through (DESIGN §11.5: ipfs.io → dweb.link →
// gateway.pinata.cloud → w3s.link, in that order), with pump.fun's own pinata gateway in front:
// measured on 2026-10-19 it answers in 0.2 s, 200 for everything pump.fun pinned (most coins) and a
// definitive 403 otherwise, while the three public gateways answer 429 within seconds of six
// workers and gateway.pinata.cloud takes ~7 s to resolve a CID. cf-ipfs.com is dead and never tried,
// whichever gateway a creator wrote into the metadata.
export const IPFS_GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://w3s.link/ipfs/"];
const DEAD_GATEWAYS = new Set(["cf-ipfs.com"]);
export const FETCH_TIMEOUT_MS = 10_000;  // per gateway attempt
export const FETCH_BUDGET_MS = 25_000;   // per uri, across the whole rotation
const ALLOWED_HOSTS = [
  (h) => h === "ipfs.io",
  (h) => h.endsWith(".pinata.cloud") || h.endsWith(".mypinata.cloud"), // gateway.pinata.cloud and dedicated *.mypinata.cloud gateways (pump.mypinata.cloud)
  (h) => h === "pump.fun" || h.endsWith(".pump.fun"),
  (h) => h === "arweave.net" || h.endsWith(".arweave.net"),
  (h) => h === "cf-ipfs.com",
  (h) => h === "dweb.link" || h === "w3s.link", // path-form entry points of the rotation (they redirect to <cid>.ipfs.<gateway>)
  (h) => IPFS_SUBDOMAIN_GATEWAYS.some((g) => h.endsWith(`.ipfs.${g}`)),
];

// The metadata host Spore publishes to (DESIGN §11.3): its /m/<name> files are read from the local
// directory before any network, and its images are allowed through the proxy. Set once at boot.
let localHost = null; // { domain, dir }
export function configureLocalMetaHost({ domain, dir } = {}) { localHost = domain && dir ? { domain: String(domain).toLowerCase(), dir } : null; return localHost; }
/** `{ file, type }` for a URL on the configured metadata host whose file exists locally, else null. */
export function localMetaFile(u) {
  if (!localHost) return null;
  let url;
  try { url = new URL(String(u)); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== localHost.domain) return null;
  const m = url.pathname.match(/^\/m\/([^/]+)$/);
  if (!m || !META_NAME_RE.test(m[1])) return null;
  const file = join(localHost.dir, m[1]);
  return existsSync(file) ? { file, type: META_TYPES[m[1].split(".").pop()] } : null;
}

/**
 * Any public https host at its default port may serve a logo (owner decision 2026-10-19: 40 % of
 * resolved metadata kept its image on hosts outside the old allowlist — various launchpad CDNs,
 * solanatracker.io …). Safety does not rest on the host name: the SSRF guard (lib/net.mjs) refuses
 * private and special addresses at fetch time and on every redirect, the proxy sniffs the bytes,
 * refuses SVG and caps the size, and only images the API handed out are proxied (api.mjs).
 * `KNOWN_IMAGE_HOSTS` is kept for tests and documentation of what pump.fun coins mostly use.
 */
export function isAllowedImageUrl(u) {
  return isAllowedMetaUrl(u) || (!!localHost && sameHttpsHost(u, localHost.domain));
}
function sameHttpsHost(u, domain) { try { const url = new URL(String(u)); return url.protocol === "https:" && !url.port && url.hostname.toLowerCase() === domain; } catch { return false; } }
export const KNOWN_IMAGE_HOSTS = ALLOWED_HOSTS;

/** `ipfs://CID/...` → ipfs.io gateway URL; anything else is returned as-is (allowlist decides later). */
export function normalizeImageUrl(u) {
  if (typeof u !== "string" || !u) return null;
  const s = u.trim();
  const ipfs = s.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i);
  const url = ipfs ? `https://ipfs.io/ipfs/${ipfs[1]}` : s;
  return isAllowedImageUrl(url) ? url : null;
}

/**
 * Metadata JSON may live anywhere (launch tools host it on their own domains: m.rapidlaunch.io,
 * meta.notrandom.fun, …), so the fetcher accepts any public https host. What it must never do is
 * reach the local network from the server, so loopback, link-local, private and bare-IP hosts are
 * refused, and the body is size- and time-bounded and parsed as JSON only. Images stay on the strict
 * allowlist because the browser renders them.
 */
export function isAllowedMetaUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false; // IPv4 / IPv6 literals
  return true;
}

/**
 * The IPFS path (`<cid>[/path][?query]`) a URL names, or null when it is not IPFS content:
 * `ipfs://CID/...`, any `https://<host>/ipfs/<cid>...` path gateway, or a `<cid>.ipfs.<gateway>`
 * subdomain gateway. CIDv0 is case-sensitive base58, so the path is taken verbatim.
 */
export function ipfsPathOf(u) {
  const s = String(u ?? "").trim();
  const scheme = s.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i);
  if (scheme) return scheme[1];
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const path = url.pathname.match(/^\/ipfs\/(.+)$/);
  if (path) return path[1] + url.search;
  const host = url.hostname.toLowerCase();
  const sub = host.match(/^([a-z0-9]+)\.ipfs\.(.+)$/);
  if (sub && IPFS_SUBDOMAIN_GATEWAYS.includes(sub[2])) return `${sub[1]}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  return null;
}

/**
 * Alternative URLs for the same content, in the order they are tried: the rotation for the URL's
 * IPFS path, preceded by the creator's own URL when it names a gateway outside the rotation (the
 * content may be pinned only there). A dead gateway is skipped. Anything that is not IPFS content
 * has exactly one candidate.
 */
export function gatewayCandidates(url) {
  const s = String(url);
  const path = ipfsPathOf(s);
  if (!path) return [s];
  const out = []; const seen = new Set();
  const add = (u) => {
    let host; try { const x = new URL(u); if (x.protocol !== "https:") return; host = x.hostname.toLowerCase(); } catch { return; }
    if (DEAD_GATEWAYS.has(host) || seen.has(host)) return;
    seen.add(host); out.push(u);
  };
  const rotation = IPFS_GATEWAYS.map((g) => g + path);
  const known = new Set(IPFS_GATEWAYS.map((g) => new URL(g).hostname));
  let own = null; try { own = new URL(s).hostname.toLowerCase(); } catch { /* ipfs:// or malformed: no own host */ }
  if (own && !known.has(own) && !(own.includes(".ipfs.") && IPFS_SUBDOMAIN_GATEWAYS.some((g) => own.endsWith(`.ipfs.${g}`) && known.has(g)))) add(s);
  for (const u of rotation) add(u);
  return out;
}

const clean = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const cleanUrl = (v) => { const s = clean(v, 200); if (!s) return null; try { const u = new URL(s.includes("://") ? s : `https://${s}`); return /^https?:$/.test(u.protocol) ? u.toString() : null; } catch { return null; } };
const cleanHandle = (v, base) => { const s = clean(v, 200); if (!s) return null; if (/^https?:\/\//i.test(s)) return cleanUrl(s); const h = s.replace(/^@/, ""); return /^[A-Za-z0-9_./+-]{1,80}$/.test(h) ? `${base}${h}` : null; };

/** Normalizes a pump.fun-style metadata JSON to the five fields the API exposes. */
export function pickMeta(json) {
  if (!json || typeof json !== "object") return { image: null, description: null, twitter: null, telegram: null, website: null };
  return {
    image: normalizeImageUrl(json.image ?? json.image_url ?? null),
    description: clean(json.description, 1000),
    twitter: cleanHandle(json.twitter, "https://x.com/"),
    telegram: cleanHandle(json.telegram, "https://t.me/"),
    website: cleanUrl(json.website),
  };
}

/** Reads a response body up to `max` bytes; throws when the body is larger. */
export async function readBounded(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { reader.cancel().catch(() => {}); throw new Error(`body over ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Per-host politeness shared by both fetchers: a minimum spacing between requests to one host and a
 * pause (doubling) after it answers 429. `fetchAny` walks the gateway candidates of a URL, asking
 * the gateway whose next free slot comes soonest first (ties keep the rotation order), and returns
 * the first OK response. A 403/404/410/5xx or a network error from one gateway moves on to the
 * next; when every gateway answered, the last answer is returned (the caller records its status);
 * when every gateway errored, the last error is thrown; null means every candidate is paused or
 * rate-limited (the caller retries later).
 */
export class HostPacer {
  /**
   * `guard` resolves each host and refuses private addresses; it defaults to a real DNS guard
   * with the real fetch and to none when a fake fetch is injected (tests never touch DNS).
   */
  constructor({ fetchImpl = pinnedFetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), guard, spacingMs = HOST_SPACING_MS } = {}) {
    this.fetch = fetchImpl; this.sleep = sleep; this.spacingMs = spacingMs; this.lastAt = new Map(); this.pausedUntil = new Map(); this.backoff = new Map();
    this.guard = guard !== undefined ? guard : fetchImpl === pinnedFetch ? new HostGuard() : null;
    this.stats = { rotated: 0 };
  }
  /**
   * `allow(url)` is re-checked on every redirect hop, so a gateway cannot bounce us to a private
   * host. Each gateway attempt gets its own `timeoutMs`, the whole rotation shares `budgetMs`, so a
   * slow first gateway does not eat the time of the next one and a worker is never held for long.
   */
  async fetchAny(url, init = {}, { allow = () => true, timeoutMs = FETCH_TIMEOUT_MS, budgetMs = FETCH_BUDGET_MS } = {}) {
    const pending = gatewayCandidates(url).map((candidate) => ({ candidate, host: new URL(candidate).hostname }));
    const deadline = Date.now() + budgetMs;
    let limited = false, last = null, lastError = null;
    while (pending.length) {
      const now = Date.now();
      let best = -1, bestWait = Infinity;
      for (let i = 0; i < pending.length; i++) {
        const { host } = pending[i];
        if ((this.pausedUntil.get(host) ?? 0) > now) continue;
        const wait = Math.max(0, (this.lastAt.get(host) ?? 0) + this.spacingMs - now);
        if (wait < bestWait) { best = i; bestWait = wait; }
      }
      if (best < 0) { limited = true; break; } // every remaining gateway is pausing
      const { candidate, host } = pending.splice(best, 1)[0];
      if (bestWait > 0) await this.sleep(bestWait);
      const left = deadline - Date.now();
      if (left <= 0) { lastError ??= new Error(`gateway budget of ${budgetMs} ms spent`); break; }
      const timeout = AbortSignal.timeout(Math.min(timeoutMs, left));
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      this.lastAt.set(host, Date.now());
      let hit;
      try { hit = await guardedFetch(candidate, { ...init, signal }, { allow, guard: this.guard, fetchImpl: this.fetch }); }
      catch (e) { lastError = e; if (pending.length) this.stats.rotated++; continue; }
      if (hit.res.status === 429) {
        const ms = Math.min(120_000, (this.backoff.get(host) ?? HOST_PAUSE_MS / 2) * 2);
        this.backoff.set(host, ms); this.pausedUntil.set(host, Date.now() + ms);
        limited = true; continue;
      }
      this.backoff.delete(host);
      if (hit.res.ok || !pending.length) return hit;
      // One gateway's 403/404/410/5xx is not final: the next may hold the content.
      try { hit.res.body?.cancel?.(); } catch { /* nothing to drain */ }
      last = hit; this.stats.rotated++;
    }
    if (last) return last;
    if (limited) return null;
    if (lastError) throw lastError;
    return undefined;
  }
}

/**
 * Metadata fetcher: `request(uri)` enqueues (deduplicated), `concurrency` workers fetch, results
 * land in the model (and sqlite through it). API-driven requests jump the queue so a coin page
 * fills within a second. `start()` adds the background sweep (DESIGN §11.5): every tracked coin
 * whose JSON is missing, stale or due for a retry is queued, biggest locked value first, then
 * newest, so the map's labels and logos fill from the top. Failures are stored with an attempt
 * count and retried on a doubling backoff (15 min → 24 h); a uri that once resolved keeps its
 * image when a later re-read fails. Everything here is HTTP to gateways, never the RPC.
 */
export class MetaFetcher {
  constructor(model, { concurrency = 6, log = console, fetchImpl = pinnedFetch, pacer, sweepMs = 60_000, now = Date.now } = {}) {
    this.model = model; this.log = log; this.now = now; this.sweepMs = sweepMs;
    this.pacer = pacer ?? new HostPacer({ fetchImpl });
    this.concurrency = concurrency; this.active = 0;
    this.queue = []; this.head = 0; this.queued = new Set(); this.inFlight = new Set(); this.attempts = new Map();
    this.recheck = new Set();       // uris due once more whatever their age (META_IMAGE_RULE); each leaves when fetched
    this.stats = { fetched: 0, failed: 0, rateLimited: 0, sweeps: 0 };
    this.stopped = false; this.timer = null; this.coverageCache = null;
  }
  /** Uris waiting in the queue plus the ones being fetched right now. */
  get pendingCount() { return this.queue.length - this.head + this.inFlight.size; }
  needsFetch(uri, nowS = Math.floor(this.now() / 1000)) {
    const m = this.model.meta.get(uri);
    if (!m || this.recheck.has(uri)) return true;
    const age = nowS - m.fetchedAt;
    if (m.ok) return age > (m.image ? META_TTL_S : META_NOIMAGE_TTL_S);
    return age > retryAfterS(m.attempts ?? 1);
  }
  request(uri, { front = false } = {}) {
    if (typeof uri !== "string" || !isAllowedMetaUrl(uri) || this.queued.has(uri) || this.inFlight.has(uri) || !this.needsFetch(uri)) return;
    this.queued.add(uri);
    if (front) this.queue.splice(this.head, 0, uri); else this.queue.push(uri);
    this.#pump();
  }
  /**
   * Queues every tracked coin's uri that needs a (re)fetch, ordered by locked value then recency;
   * returns how many were added. Cheap enough to run every minute at 15k coins (one sort).
   */
  sweep({ max = 50_000 } = {}) {
    if (this.stopped || !this.model.coins) return 0;
    const nowS = Math.floor(this.now() / 1000);
    const d = typeof this.model.computed === "function" ? this.model.computed() : new Map();
    const cands = [];
    for (const c of this.model.coins.values()) {
      if (!c.tracked) continue;
      const uri = this.model.mints?.get(c.mint)?.uri;
      if (typeof uri !== "string" || this.queued.has(uri) || this.inFlight.has(uri) || !isAllowedMetaUrl(uri) || !this.needsFetch(uri, nowS)) continue;
      cands.push({ uri, locked: d.get(c.mint)?.lockedUsd ?? -1, at: c.createdAt ?? 0 });
    }
    // The listed quote assets the map draws at the top of their families (PUMP, USDC, $baton…) need logos too.
    for (const mint of typeof this.model.assetFamilies === "function" ? this.model.assetFamilies().keys() : []) {
      const uri = this.model.mints?.get(mint)?.uri;
      if (typeof uri !== "string" || this.queued.has(uri) || this.inFlight.has(uri) || !isAllowedMetaUrl(uri) || !this.needsFetch(uri, nowS)) continue;
      cands.push({ uri, locked: Number.MAX_SAFE_INTEGER, at: 0 });
    }
    cands.sort((a, b) => b.locked - a.locked || b.at - a.at);
    let n = 0;
    for (const x of cands) { if (n >= max || this.queued.has(x.uri)) continue; this.queued.add(x.uri); this.queue.push(x.uri); n++; }
    this.stats.sweeps++;
    if (n) this.log.info?.(`meta: sweep queued ${n} uris (${this.pendingCount} pending)`);
    this.#pump();
    return n;
  }
  /**
   * One-time re-check after the image rule widened (META_IMAGE_RULE): every resolved row without an
   * image becomes due at once, so the next sweep fetches them in its usual order (locked value, then
   * recency: the largest roots first). Gated by a kv record, so it happens once per rule change, not
   * once per boot; rows that have an image are never touched. Returns how many uris were queued.
   */
  queueImageRecheck() {
    const db = this.model.db;
    if (typeof db?.kvGet !== "function" || typeof db?.kvSet !== "function") return 0;
    if (Number(db.kvGet("metaImageRule", 1)) >= META_IMAGE_RULE) return 0;
    let n = 0;
    for (const [uri, m] of this.model.meta ?? []) if (m?.ok && !m.image) { this.recheck.add(uri); n++; }
    this.log.info?.(`meta: image recheck queued ${n}`);
    db.kvSet("metaImageRule", META_IMAGE_RULE);
    return n;
  }
  /** Starts the periodic sweep (the first one runs at once, after the one-time image re-check is queued). */
  start({ sweepMs = this.sweepMs } = {}) {
    try { this.queueImageRecheck(); } catch (e) { this.log.warn?.(`meta: image recheck failed: ${e.message}`); }
    try { this.sweep(); } catch (e) { this.log.warn?.(`meta: sweep failed: ${e.message}`); }
    this.timer = setInterval(() => { try { this.sweep(); } catch (e) { this.log.warn?.(`meta: sweep failed: ${e.message}`); } }, sweepMs);
    this.timer.unref?.();
    return this;
  }
  /** Coverage over tracked coins (`/api/health.meta`), memoized for 5 s. */
  coverage() {
    if (this.coverageCache && this.now() - this.coverageCache.at < 5_000) return this.coverageCache.value;
    let total = 0, withMeta = 0, withImage = 0, failed = 0, noUri = 0;
    for (const c of this.model.coins?.values?.() ?? []) {
      if (!c.tracked) continue;
      total++;
      const uri = this.model.mints?.get(c.mint)?.uri;
      if (!uri) { noUri++; continue; }
      const m = this.model.meta.get(uri);
      if (!m) continue;
      if (m.ok) withMeta++; else failed++;
      if (m.image) withImage++;
    }
    const value = { total, withMeta, withImage, noUri, failed, queued: this.pendingCount };
    this.coverageCache = { at: this.now(), value };
    return value;
  }
  /** Coverage over tracked coins plus this process's counters under `run` (so `failed` is always the coverage count). */
  snapshot() { return { ...this.coverage(), run: { ...this.stats, rotated: this.pacer?.stats?.rotated ?? 0, recheck: this.recheck.size } }; }
  #next() {
    if (this.head >= this.queue.length) return undefined;
    const uri = this.queue[this.head++];
    if (this.head >= 1024 && this.head * 2 >= this.queue.length) { this.queue = this.queue.slice(this.head); this.head = 0; }
    return uri;
  }
  #pump() {
    while (!this.stopped && this.active < this.concurrency && this.head < this.queue.length) {
      const uri = this.#next(); this.queued.delete(uri);
      this.active++; this.inFlight.add(uri);
      this.#fetchOne(uri).finally(() => { this.active--; this.inFlight.delete(uri); this.#pump(); });
    }
  }
  async #fetchOne(uri) {
    const fetchedAt = Math.floor(this.now() / 1000);
    const fail = (error) => {
      const prev = this.model.meta.get(uri);
      const attempts = (prev?.attempts ?? 0) + 1;
      // A uri that resolved before keeps what it had (the logo stays on the map); only a uri that
      // never resolved is stored empty. Either way the attempt count drives the next retry.
      if (prev?.ok) this.model.setMeta(uri, { ...prev, fetchedAt, error, attempts });
      else this.model.setMeta(uri, { image: null, description: null, twitter: null, telegram: null, website: null, fetchedAt, ok: false, error, attempts });
      this.stats.failed++; this.attempts.delete(uri); this.recheck.delete(uri);
    };
    // Our own metadata host: the file is on disk, so no request (this machine may not even reach the domain).
    const local = localMetaFile(uri);
    if (local) {
      try {
        const meta = pickMeta(JSON.parse(readFileSync(local.file, "utf8")));
        this.model.setMeta(uri, { ...meta, fetchedAt, ok: true, error: null, attempts: 0 });
        this.stats.fetched++; this.attempts.delete(uri); this.recheck.delete(uri);
        return;
      } catch { /* unreadable locally: fall through to the network */ }
    }
    try {
      const hit = await this.pacer.fetchAny(uri, { headers: { accept: "application/json" } }, { allow: isAllowedMetaUrl });
      if (hit === null) {
        // Every gateway is pausing: retry later, at the back of the queue, a few times.
        this.stats.rateLimited++;
        const n = (this.attempts.get(uri) ?? 0) + 1; this.attempts.set(uri, n);
        if (n <= 3) { setTimeout(() => { if (!this.stopped && !this.queued.has(uri) && !this.inFlight.has(uri)) { this.queued.add(uri); this.queue.push(uri); this.#pump(); } }, HOST_PAUSE_MS).unref(); return; }
        return fail("HTTP 429");
      }
      if (!hit?.res?.ok) throw new Error(`HTTP ${hit?.res?.status ?? "?"}`);
      const body = await readBounded(hit.res, META_MAX_BYTES);
      const meta = pickMeta(JSON.parse(body.toString("utf8")));
      this.model.setMeta(uri, { ...meta, fetchedAt, ok: true, error: null, attempts: 0 });
      this.stats.fetched++; this.attempts.delete(uri); this.recheck.delete(uri);
    } catch (e) {
      fail(String(e.message ?? e).slice(0, 120));
    }
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}

export const IMAGE_CACHE_MAX_BYTES = 512 * 1024 * 1024;
/** Thumbnails have their own budget: ~8 KB each, so 128 MB holds every logo the map can ask for from far. */
export const THUMB_CACHE_MAX_BYTES = 128 * 1024 * 1024;
/** A thumbnail is served by its own age: the original may be evicted (or dead upstream) meanwhile. */
export const THUMB_TTL_MS = 7 * 24 * 3600 * 1000;
/** GET /api/logo-sheet answers within this many ms of the request start with whatever thumbnails landed. */
export const SHEET_BUDGET_MS = 400;
/** ... unless NOTHING landed by then (a cold family): then it waits up to this long for the first thumbnails. */
export const SHEET_WAIT_MS = 1500;
/** ImageCache.warm: a pass stops after this long (the next scheduled pass continues), and a url that failed is not fetched again before WARM_RETRY_MS. */
export const WARM_MAX_MS = 20 * 60_000;
export const WARM_RETRY_MS = 6 * 3600_000;
export const SHEET_CELL = 64;
const THUMB_NAME_RE = /\.w\d+\.png$/;

/**
 * The thread image work runs on (lib/img-worker.mjs): one worker, jobs answered in order, buffers
 * handed over rather than copied, respawned when it dies (the jobs in flight fail once, as transient).
 * `{ inline: true }` runs the same functions on the calling thread, which tests use and the cache
 * falls back to when a worker cannot be spawned or keeps crashing. Without it every thumbnail render
 * (8-80 ms), sheet composition (50-120 ms) and share card (35-110 ms) would block the event loop,
 * i.e. SSE and the indexer.
 */
export class ImgWork {
  constructor({ inline = false, log = console } = {}) {
    this.inline = inline; this.log = log; this.worker = null; this.pending = new Map(); this.seq = 0; this.closed = false;
    this.stats = { jobs: 0, failed: 0, restarts: 0, inline: inline ? 1 : 0 };
  }
  #spawn() {
    try {
      // a worker refuses most process-level node flags (the test runner alone passes a dozen), so only the warning switches carry over
      const execArgv = process.execArgv.filter((a) => /^(--disable-warning=|--no-warnings)/.test(a));
      const w = new Worker(new URL("./img-worker.mjs", import.meta.url), { workerData: { role: "img" }, execArgv });
      w.on("message", (m) => this.#onMessage(m));
      w.on("error", (e) => this.#gone(e));
      w.on("exit", (code) => this.#gone(new Error(`image worker exited (${code})`)));
      w.unref(); // idle, it never keeps the process alive; ref'd while jobs wait
      this.worker = w;
      return w;
    } catch (e) {
      this.log.warn?.(`img work: cannot start a worker thread (${e.message}); rendering inline`);
      this.inline = true; this.stats.inline = 1;
      return null;
    }
  }
  #gone(err) {
    const w = this.worker;
    if (!w) return;
    this.worker = null;
    if (!this.closed) { this.stats.restarts++; this.log.warn?.(`img work: ${err.message}; ${this.pending.size} jobs dropped, worker restarts on the next job`); }
    if (this.stats.restarts > 5 && !this.inline) { this.inline = true; this.stats.inline = 1; this.log.warn?.("img work: worker keeps dying, rendering inline from now on"); }
    for (const p of this.pending.values()) { const e = new Error(`image worker failed: ${err.message}`); e.transient = true; p.reject(e); }
    this.pending.clear();
  }
  #onMessage(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (!this.pending.size) this.worker?.unref();
    if (m.ok) p.resolve({ bytes: m.bytes ? Buffer.from(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength) : null, type: m.type, failed: m.failed ?? [] });
    else { this.stats.failed++; p.reject(new Error(m.error)); }
  }
  async #run(msg, transfer) {
    this.stats.jobs++;
    if (!this.inline && !this.closed) {
      const w = this.worker ?? this.#spawn();
      if (w) return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.pending.set(id, { resolve, reject });
        w.ref();
        try { w.postMessage({ id, ...msg }, transfer); } catch (e) { this.pending.delete(id); if (!this.pending.size) w.unref(); reject(e); }
      });
    }
    try { const r = await runOp(msg); return { bytes: r.bytes ?? null, type: r.type, failed: r.failed ?? [] }; }
    catch (e) { this.stats.failed++; throw e; }
  }
  /** PNG bytes of the w x w thumbnail of `bytes` (sniffed `type`), or null when it cannot be drawn. */
  async thumb({ bytes, type, w }) {
    const u8 = own(bytes);
    const r = await this.#run({ op: "thumb", bytes: u8, type, w }, [u8.buffer]);
    return r.bytes;
  }
  /** `{ bytes, type, failed }`: the sheet of `cells` (PNG thumbnails or null), see composeSheet in img-worker.mjs. */
  async sheet({ cells, cols = SHEET_COLS, cell = SHEET_CELL, format = "webp" }) {
    const owned = cells.map((c) => (c ? own(c) : null));
    return this.#run({ op: "sheet", cells: owned, cols, cell, format }, owned.filter(Boolean).map((u) => u.buffer));
  }
  /** PNG bytes of a share card's svg (lib/card.mjs), rasterized off the loop like a thumbnail (renderCardSvg in img-worker.mjs). */
  async card({ svg }) {
    const r = await this.#run({ op: "card", svg: String(svg) }, []);
    return r.bytes;
  }
  /** Ends the worker; later jobs run inline (the shutdown path may still serve a request or two). */
  close() {
    this.closed = true;
    const w = this.worker;
    this.#gone(new Error("closed"));
    w?.terminate().catch(() => {});
  }
}
/** A Uint8Array over its own ArrayBuffer (a copy when `bytes` shares one, e.g. Node's buffer pool), so it can be transferred. */
function own(bytes) { const u8 = new Uint8Array(bytes.byteLength); u8.set(bytes); return u8; }

/**
 * Disk-backed image cache behind GET /api/img and GET /api/logo-sheet. Originals are keyed by the
 * sha256 of the URL and hold at most `maxBytes` (oldest files evicted first), so a flood of distinct
 * allowed URLs can fill the budget but never the disk. Thumbnails (<sha>.w<w>.png) live beside them
 * under their own budget and TTL: a warm thumbnail is served without the original, which may be
 * long evicted or dead upstream.
 */
export class ImageCache {
  constructor(dir, { log = console, fetchImpl = pinnedFetch, concurrency = 3, pacer, maxBytes = IMAGE_CACHE_MAX_BYTES, thumbMaxBytes = THUMB_CACHE_MAX_BYTES, work = null } = {}) {
    this.dir = dir; this.log = log; this.maxBytes = maxBytes; this.thumbMaxBytes = thumbMaxBytes;
    this.pacer = pacer ?? new HostPacer({ fetchImpl });
    this.work = work ?? new ImgWork({ log });
    mkdirSync(dir, { recursive: true });
    this.inFlight = new Map(); this.negative = new Map(); this.warmFailed = new Map();
    this.concurrency = concurrency; this.active = 0; this.waiters = [];
    this.stats = { hits: 0, misses: 0, failed: 0, evicted: 0, bytes: 0, thumbs: 0, thumbHits: 0, thumbFailed: 0, thumbBytes: 0, thumbsEvicted: 0, sheets: 0, sheetCells: 0, sheetPending: 0, sheetDead: 0, sheetMs: 0 };
    this.thumbInFlight = new Map(); this.thumbChain = Promise.resolve(); this.thumbNo = new Map();
    this.#measure();
  }
  #paths(url) { const key = createHash("sha256").update(url).digest("hex"); return { file: join(this.dir, key), sidecar: join(this.dir, `${key}.json`) }; }
  /** Where the w px thumbnail of `url` lives (whether or not it exists). */
  thumbPath(url, w) { return `${this.#paths(url).file}.w${w}.png`; }
  #measure() {
    let bytes = 0, thumbBytes = 0;
    for (const name of readdirSync(this.dir)) { try { const size = statSync(join(this.dir, name)).size; if (THUMB_NAME_RE.test(name)) thumbBytes += size; else bytes += size; } catch { /* vanished */ } }
    this.stats.bytes = bytes; this.stats.thumbBytes = thumbBytes;
  }
  /** Oldest originals out until the cache is back under 90% of its budget; the sidecar goes with its image, the thumbnails stay. */
  #evict() {
    if (this.stats.bytes <= this.maxBytes) return;
    const files = [];
    for (const name of readdirSync(this.dir)) {
      if (name.endsWith(".json") || name.includes(".tmp") || THUMB_NAME_RE.test(name)) continue;
      try { const st = statSync(join(this.dir, name)); files.push({ name, size: st.size, mtimeMs: st.mtimeMs }); } catch { /* vanished */ }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const target = this.maxBytes * 0.9;
    for (const f of files) {
      if (this.stats.bytes <= target) break;
      for (const p of [join(this.dir, f.name), join(this.dir, `${f.name}.json`)]) { try { const size = statSync(p).size; unlinkSync(p); this.stats.bytes -= size; } catch { /* already gone */ } }
      this.stats.evicted++;
    }
    this.stats.bytes = Math.max(0, this.stats.bytes);
  }
  /** Oldest thumbnails out until they are back under 90% of their own budget. */
  #evictThumbs() {
    if (this.stats.thumbBytes <= this.thumbMaxBytes) return;
    const files = [];
    for (const name of readdirSync(this.dir)) {
      if (!THUMB_NAME_RE.test(name)) continue;
      try { const st = statSync(join(this.dir, name)); files.push({ name, size: st.size, mtimeMs: st.mtimeMs }); } catch { /* vanished */ }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const target = this.thumbMaxBytes * 0.9;
    for (const f of files) {
      if (this.stats.thumbBytes <= target) break;
      try { unlinkSync(join(this.dir, f.name)); this.stats.thumbBytes -= f.size; this.stats.thumbsEvicted++; } catch { /* already gone */ }
    }
    this.stats.thumbBytes = Math.max(0, this.stats.thumbBytes);
  }

  /** `{file, type}` for a cached-or-fetched image, or null (not allowed, too big, not an image, unreachable). */
  async get(url) {
    const local = localMetaFile(url);
    if (local && local.type.startsWith("image/")) return local;
    if (!isAllowedImageUrl(url)) return null;
    const { file, sidecar } = this.#paths(url);
    try {
      const st = statSync(file);
      if (Date.now() - st.mtimeMs < IMAGE_TTL_MS) { this.stats.hits++; return { file, type: JSON.parse(readFileSync(sidecar, "utf8")).type }; }
    } catch { /* not cached */ }
    if ((this.negative.get(url) ?? 0) > Date.now()) return null;
    this.stats.misses++;
    if (this.inFlight.has(url)) return this.inFlight.get(url);
    const p = this.#download(url, file, sidecar).finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, p);
    return p;
  }
  async #download(url, file, sidecar) {
    await this.#enter();
    try {
      const hit = await this.pacer.fetchAny(url, {}, { allow: isAllowedImageUrl, timeoutMs: 15_000, budgetMs: 30_000 });
      if (!hit) throw new Error(hit === null ? "rate limited" : "no candidate");
      const { res } = hit;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      // SVG can script: refused by name before the download and, like everything else, by the sniff
      // below. Other declared types are not trusted either way (gateways send octet-stream for images).
      if (declared.includes("svg") || declared.startsWith("text/")) throw new Error(`not an image: ${declared}`);
      if (Number(res.headers.get("content-length") || 0) > IMAGE_MAX_BYTES) throw new Error("too large");
      const body = await readBounded(res, IMAGE_MAX_BYTES);
      // The served type is what the bytes prove, never what the gateway claimed.
      const type = sniffImage(body);
      if (!type) throw new Error(`not a raster image (${declared})`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      const meta = JSON.stringify({ url, type, size: body.length, at: Date.now() });
      writeFileSync(sidecar, meta);
      renameSync(tmp, file); // atomic on the same volume: a concurrent reader never sees a partial file
      this.stats.bytes += body.length + meta.length;
      this.#evict();
      return { file, type };
    } catch {
      this.stats.failed++;
      this.negative.set(url, Date.now() + NEGATIVE_TTL_MS);
      if (this.negative.size > 5_000) for (const [k, t] of this.negative) if (t < Date.now()) this.negative.delete(k);
      return null;
    } finally { this.#leave(); }
  }
  /** `{ file, type, thumb: w }` when the w px thumbnail of `url` is on disk and younger than THUMB_TTL_MS, else null (no original needed). */
  thumbOnDisk(url, w) {
    if (!url || !IMAGE_THUMB_SIZES.has(w)) return null;
    const file = this.thumbPath(url, w);
    try { if (Date.now() - statSync(file).mtimeMs < THUMB_TTL_MS) return { file, type: "image/png", thumb: w }; } catch { /* not made */ }
    return null;
  }
  /** The bytes of the fresh w px PNG thumbnail of `url` on disk (thumbOnDisk), else null; never fetches or renders (the social card reads logos this way; `warm` makes a missing one). */
  thumbBytes(url, w) {
    const hit = this.thumbOnDisk(url, w);
    if (!hit) return null;
    try { const bytes = readFileSync(hit.file); this.stats.thumbHits++; return bytes; } catch { return null; }
  }
  /** Known not to yield a w px thumbnail right now: no url, a download that failed within NEGATIVE_TTL_MS, or a render that failed within the day. */
  isDead(url, w = SHEET_CELL) {
    if (!url) return true;
    const now = Date.now();
    return (this.negative.get(url) ?? 0) > now || (this.thumbNo.get(`${w}:${url}`) ?? 0) > now;
  }

  /**
   * `{file, type, thumb: w}` for a w x w PNG thumbnail of `hit` (an image get() returned), cached on disk as
   * <sha>.w<w>.png beside the original; a thumbnail already on disk is served by its own age (thumbOnDisk);
   * null when it cannot be made (a decode failure, an animated webp): serve the original then. Renders run on
   * the image worker one at a time (setImmediate between them), so a burst of logos never stalls the loop.
   */
  async thumb(url, hit, w) {
    const warm = this.thumbOnDisk(url, w);
    if (warm) { this.stats.thumbHits++; return warm; }
    if (!hit || !IMAGE_THUMB_SIZES.has(w) || !THUMB_TYPES.has(hit.type)) return null;
    const out = this.thumbPath(url, w), key = `${w}:${url}`;
    if ((this.thumbNo.get(key) ?? 0) > Date.now()) return null;
    if (this.thumbInFlight.has(key)) return this.thumbInFlight.get(key);
    const job = this.thumbChain.then(async () => {
      try {
        const png = await this.work.thumb({ bytes: readFileSync(hit.file), type: hit.type, w });
        if (!png) throw new Error("not drawable");
        const tmp = `${out}.${process.pid}.tmp`;
        writeFileSync(tmp, png); renameSync(tmp, out);
        this.stats.thumbBytes += png.length; this.stats.thumbs++;
        this.#evictThumbs();
        return { file: out, type: "image/png", thumb: w };
      } catch (e) {
        this.stats.thumbFailed++;
        // a worker crash is not the image's fault: the next request renders again
        if (!e?.transient) this.thumbNo.set(key, Date.now() + IMAGE_TTL_MS);
        if (this.thumbNo.size > 5_000) for (const [k, t] of this.thumbNo) if (t < Date.now()) this.thumbNo.delete(k);
        return null;
      } finally { await new Promise((r) => setImmediate(r)); }
    });
    this.thumbChain = job.catch(() => null);
    const p = job.finally(() => this.thumbInFlight.delete(key));
    this.thumbInFlight.set(key, p);
    return p;
  }

  /**
   * Pre-warm (map logos from far, owner 2026-10-21): makes sure each url has its w-px thumbnail on disk (a
   * fresh one costs a stat; otherwise the original is fetched through get() and drawn through thumb(), webp
   * included), at most concurrency urls at a time. Returns { n, ok, failed }.
   */
  async warm(urls, w = 64, concurrency = 4, { maxMs = WARM_MAX_MS } = {}) {
    const list = [...new Set(urls ?? [])].filter((u) => typeof u === "string" && u);
    const t0 = Date.now(), now = () => Date.now();
    let next = 0, ok = 0, failed = 0, skipped = 0, stopped = false;
    const worker = async () => {
      while (next < list.length) {
        if (now() - t0 > maxMs) { stopped = true; break; }
        const u = list[next++];
        try {
          if (this.thumbOnDisk(u, w)) { this.stats.thumbHits++; ok++; continue; }
          // (repair 2026-10-22) a url that failed in an earlier pass (or is dead right now) is not fetched again before
          // WARM_RETRY_MS: a pass over every image (model.warmImageUrls all) would otherwise spend its time on the
          // ~3,600 dead upstreams every 30 minutes
          if ((this.warmFailed.get(u) ?? 0) > now() || this.isDead(u, w)) { skipped++; failed++; continue; }
          const hit = await this.get(u); const t = hit ? await this.thumb(u, hit, w) : null;
          if (t) ok++; else { failed++; this.warmFailed.set(u, now() + WARM_RETRY_MS); }
        } catch { failed++; this.warmFailed.set(u, now() + WARM_RETRY_MS); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), list.length) }, worker));
    if (this.warmFailed.size > 20_000) for (const [k, t] of this.warmFailed) if (t < now()) this.warmFailed.delete(k);
    return { n: list.length, ok, failed, skipped, stopped, ms: now() - t0 };
  }

  /**
   * One logo sheet (GET /api/logo-sheet) for `urls` (raw image URLs, null for a mint without one): cell i is
   * the w px thumbnail of urls[i], SHEET_COLS cells per row, as `{ bytes, type, present, dead, pending }`
   * with `present`/`dead` one byte per cell. A thumbnail on disk is read at once; a dead url (isDead, or
   * one the proxy will not fetch) is marked dead; for the rest the usual get() -> thumb() jobs start and the
   * sheet waits for them at most `budgetMs` from the call (`waitMs` when nothing at all landed by then): whatever landed is present, the others are
   * pending (neither bit) and keep running, so the client's next ask finds them on disk. Composition runs
   * on the image worker; a thumbnail file that will not decode is dropped and re-made next time.
   */
  async sheet(urls, w = SHEET_CELL, { budgetMs = SHEET_BUDGET_MS, waitMs = SHEET_WAIT_MS, format = "webp" } = {}) {
    const t0 = Date.now(), n = urls.length;
    if (n < 1 || n > SHEET_MAX_CELLS) throw new Error(`sheet: 1 to ${SHEET_MAX_CELLS} cells`);
    const present = new Uint8Array(n), dead = new Uint8Array(n), files = new Array(n).fill(null);
    const started = [], jobs = new Map(); // url -> { settled, value }
    for (let i = 0; i < n; i++) {
      const url = typeof urls[i] === "string" && urls[i] ? urls[i] : null;
      if (!url) { dead[i] = 1; continue; }
      const warm = this.thumbOnDisk(url, w);
      if (warm) { files[i] = warm.file; present[i] = 1; this.stats.thumbHits++; continue; }
      if (this.isDead(url, w)) { dead[i] = 1; continue; }
      let job = jobs.get(url);
      if (!job) {
        job = { settled: false, value: null };
        job.promise = this.get(url).then((hit) => (hit ? this.thumb(url, hit, w) : null)).catch(() => null).then((v) => { job.settled = true; job.value = v; });
        jobs.set(url, job);
      }
      started.push({ i, job });
    }
    if (started.length) {
      const all = Promise.all([...jobs.values()].map((j) => j.promise));
      const waitUntil = async (ms) => {
        let timer = null;
        const budget = new Promise((r) => { timer = setTimeout(r, Math.max(0, ms - (Date.now() - t0))); timer.unref?.(); });
        await Promise.race([all, budget]);
        clearTimeout(timer);
      };
      await waitUntil(budgetMs);
      // (repair 2026-10-22) a sheet with NOTHING to show at the budget (no warm cell, no download landed: the first zoom
      // into a cold family) keeps waiting up to waitMs for the first thumbnails instead of answering all-pending at the
      // budget, which only cost the client a round trip and its re-ask delay
      const landed = () => present.some((v) => v) || started.some(({ job }) => job.settled && job.value);
      if (waitMs > budgetMs && !landed() && started.some(({ job }) => !job.settled)) await waitUntil(waitMs);
      for (const { i, job } of started) {
        if (!job.settled) continue;
        if (job.value) { files[i] = job.value.file; present[i] = 1; } else dead[i] = 1;
      }
    }
    const cells = await Promise.all(files.map(async (f, i) => { if (!f) return null; try { return await readFile(f); } catch { present[i] = 0; return null; } }));
    const r = await this.work.sheet({ cells, cols: SHEET_COLS, cell: w, format });
    for (const i of r.failed) { present[i] = 0; try { const size = statSync(files[i]).size; unlinkSync(files[i]); this.stats.thumbBytes -= size; } catch { /* already gone */ } }
    let pending = 0, deadN = 0;
    for (let i = 0; i < n; i++) { if (dead[i]) deadN++; else if (!present[i]) pending++; }
    this.stats.sheets++; this.stats.sheetCells += n; this.stats.sheetPending += pending; this.stats.sheetDead += deadN; this.stats.sheetMs += Date.now() - t0;
    return { bytes: r.bytes, type: r.type, present, dead, pending };
  }

  async #enter() { if (this.active < this.concurrency) { this.active++; return; } await new Promise((r) => this.waiters.push(r)); this.active++; }
  #leave() { this.active--; const n = this.waiters.shift(); if (n) n(); }

  /**
   * Express handler: `GET /api/img?u=<https url>[&w=64|128|256]`; 404 for anything the proxy will not serve. With a
   * known `w` the answer is a w x w PNG thumbnail (header x-img-thumb: w) when one can be made, else the original;
   * any other `w` is ignored (the original). A thumbnail on disk is served before the original is even looked at
   * (no download for a warm logo whose original was evicted or died upstream).
   * With `known(url)` the proxy fetches only URLs the API itself handed out (the `image` of an
   * indexed coin, or a file on our own metadata host): the allowlist says which hosts may be
   * contacted, `known` says on whose behalf, so a stranger cannot use the cache as a mirror.
   */
  handler({ known = null } = {}) {
    return async (req, res) => {
      const url = typeof req.query.u === "string" ? req.query.u : "";
      if (known && url && !known(url) && !localMetaFile(url)) { res.setHeader("cache-control", "no-store"); return res.status(404).json({ error: "image not available" }); }
      const w = Number(typeof req.query.w === "string" ? req.query.w : NaN);
      let hit = IMAGE_THUMB_SIZES.has(w) ? this.thumbOnDisk(url, w) : null;
      if (hit) this.stats.thumbHits++;
      else {
        hit = await this.get(url);
        if (!hit) { res.setHeader("cache-control", "no-store"); return res.status(404).json({ error: "image not available" }); }
        if (IMAGE_THUMB_SIZES.has(w)) { const t = await this.thumb(url, hit, w).catch(() => null); if (t) hit = t; }
      }
      if (hit.thumb) res.setHeader("x-img-thumb", String(w));
      res.setHeader("content-type", hit.type);
      // a thumbnail is cached 7 days by the browser; the original keeps its day
      res.setHeader("cache-control", hit.thumb ? "public, max-age=604800, immutable" : "public, max-age=86400, immutable");
      res.setHeader("x-content-type-options", "nosniff");
      createReadStream(hit.file).on("error", () => res.destroy()).pipe(res);
    };
  }

  /**
   * Express handler: `GET /api/logo-sheet?w=64&m=<mint>,<mint>,...[&f=webp|png]`, one image of the 64 px
   * thumbnails of up to 256 mints' logos, 16 per row, with bitmaps of which cells are present / dead in
   * the headers (x-sheet, x-sheet-dead: hex, byte j bit b = cell 8j+b; a cell in neither is pending).
   * `imageOf(mint)` maps a mint to its raw image URL (null when it has none), `isMint` validates each.
   */
  sheetHandler({ imageOf, isMint = () => true } = {}) {
    const bad = (res, error) => { res.setHeader("cache-control", "no-store"); return res.status(400).json({ error }); };
    return async (req, res) => {
      const w = Number(typeof req.query.w === "string" ? req.query.w : NaN);
      if (w !== SHEET_CELL) return bad(res, `w must be ${SHEET_CELL}`);
      if (typeof req.query.m !== "string" || !req.query.m) return bad(res, "m is required");
      const mints = req.query.m.split(",");
      if (mints.length > SHEET_MAX_CELLS) return bad(res, `m takes 1 to ${SHEET_MAX_CELLS} mints`);
      for (const m of mints) if (!isMint(m)) return bad(res, "invalid mint");
      const f = req.query.f == null ? "webp" : req.query.f;
      if (f !== "webp" && f !== "png") return bad(res, "f must be webp or png");
      const urls = mints.map((m) => { try { return imageOf(m) ?? null; } catch { return null; } });
      let r;
      try { r = await this.sheet(urls, w, { format: f }); }
      catch (e) { this.log.warn?.(`logo sheet failed: ${e?.message ?? e}`); res.setHeader("cache-control", "no-store"); return res.status(500).json({ error: "sheet failed" }); }
      res.setHeader("content-type", r.type);
      res.setHeader("x-sheet", hexBits(r.present));
      res.setHeader("x-sheet-dead", hexBits(r.dead));
      res.setHeader("x-sheet-n", String(mints.length));
      res.setHeader("x-sheet-cols", String(SHEET_COLS));
      res.setHeader("x-sheet-cell", String(w));
      res.setHeader("x-sheet-pending", String(r.pending));
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", r.pending ? "no-store" : "private, max-age=600");
      res.setHeader("access-control-expose-headers", "x-sheet, x-sheet-dead, x-sheet-n, x-sheet-pending");
      res.setHeader("content-length", String(r.bytes.length));
      res.end(r.bytes);
    };
  }

  /** Drops originals older than twice their TTL and thumbnails older than twice theirs, re-measures and evicts; a few times a day. */
  sweep() {
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      const p = join(this.dir, name);
      try { if (Date.now() - statSync(p).mtimeMs > (THUMB_NAME_RE.test(name) ? THUMB_TTL_MS : IMAGE_TTL_MS) * 2) { unlinkSync(p); removed++; } } catch { /* vanished */ }
    }
    this.#measure();
    this.#evict();
    this.#evictThumbs();
    return removed;
  }
}

/** Hex bitmap of a 0/1 byte-per-cell array: ceil(n/8) bytes, byte j bit b (1 << b) = cell 8j+b. */
export function hexBits(cells) {
  const out = Buffer.alloc(Math.ceil(cells.length / 8));
  for (let i = 0; i < cells.length; i++) if (cells[i]) out[i >> 3] |= 1 << (i & 7);
  return out.toString("hex");
}

export const imageProxyUrl = (image) => (image ? `/api/img?u=${encodeURIComponent(image)}` : null);
