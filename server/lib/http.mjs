// HTTP hardening shared by every route: security headers (CSP with a per-request nonce), CORS from
// an allowlist, per-IP rate limits with X-RateLimit headers, sampled request logging, gzip/brotli
// for text responses and ETag/Cache-Control helpers. No dependencies beyond Node: express is the
// only HTTP package in this server and helmet/compression/express-rate-limit would each pull a
// tree of their own for a few dozen lines of behaviour that is easier to test here.
import { createHash, randomBytes } from "node:crypto";
import { brotliCompressSync, gzipSync, brotliCompress, gzip, createBrotliCompress, createGzip, constants as Z } from "node:zlib";
import { promisify } from "node:util";

const brotliAsync = promisify(brotliCompress), gzipAsync = promisify(gzip);
/** Output chunk of the thread-pool compression (preparedBytes' encodedAsync). */
const ASYNC_CHUNK_BYTES = 1 << 20;
/**
 * Thread-pool compressions running at once. libuv's pool has 4 threads (UV_THREADPOOL_SIZE is not set) and also
 * serves fs (the logo sheets' reads) and DNS; a 35 MB brotli holds a thread ~100 ms per output chunk, so the rest wait.
 */
export const POOL_COMPRESSIONS = 2;
/**
 * Bodies under this size skip that cap and are compressed at once on the pool: they hold a thread for milliseconds
 * (the 613 KB heat sidecar: ~8 ms of brotli), and in the queue they waited behind whole 35 MB map compressions.
 */
export const POOL_CAP_BYTES = 4 * 2 ** 20;
/** Compressions running and waiting now, and the most that ever ran at once. */
export const compressionStats = { active: 0, waiting: 0, maxActive: 0, runs: 0 };
const poolWaiting = [];
function onPool(make) {
  return new Promise((resolve, reject) => {
    const run = () => {
      compressionStats.active++; compressionStats.runs++;
      if (compressionStats.active > compressionStats.maxActive) compressionStats.maxActive = compressionStats.active;
      make().then(resolve, reject).finally(() => {
        compressionStats.active--;
        const nextRun = poolWaiting.shift();
        compressionStats.waiting = poolWaiting.length;
        nextRun?.();
      });
    };
    if (compressionStats.active < POOL_COMPRESSIONS) run();
    else { poolWaiting.push(run); compressionStats.waiting = poolWaiting.length; }
  });
}

// ---------------------------------------------------------------- rate limiting
/**
 * Fixed-window counter per key (client IP). `check` reports the window so a route can answer with
 * X-RateLimit-* headers; `refund` gives a hit back when the request turned out not to count (an
 * upload rejected by validation should not burn one of the caller's five attempts).
 */
export class RateLimiter {
  constructor({ limit, windowMs, now = Date.now }) { this.limit = limit; this.windowMs = windowMs; this.now = now; this.hits = new Map(); }
  check(key) {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t - h.at >= this.windowMs) {
      h = { at: t, n: 0 }; this.hits.set(key, h);
      // Opportunistic sweep so a scan of many IPs cannot grow the map without bound.
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (t - v.at >= this.windowMs) this.hits.delete(k);
    }
    const resetAt = h.at + this.windowMs;
    if (h.n >= this.limit) return { ok: false, limit: this.limit, remaining: 0, resetAt };
    h.n++;
    return { ok: true, limit: this.limit, remaining: this.limit - h.n, resetAt };
  }
  allow(key) { return this.check(key).ok; }
  refund(key) { const h = this.hits.get(key); if (h && h.n > 0) h.n--; }
}

/** Express middleware: one bucket per client IP; 429 JSON with Retry-After when it is empty. */
export function rateLimit({ limit, windowMs, name = "api", keyOf = (req) => req.ip, now = Date.now, limiter = null } = {}) {
  const rl = limiter ?? new RateLimiter({ limit, windowMs, now });
  const mw = (req, res, next) => {
    const r = rl.check(keyOf(req) ?? "?");
    res.setHeader("x-ratelimit-limit", String(r.limit));
    res.setHeader("x-ratelimit-remaining", String(r.remaining));
    res.setHeader("x-ratelimit-reset", String(Math.ceil(r.resetAt / 1000)));
    res.setHeader("x-ratelimit-policy", `${r.limit};w=${Math.round(rl.windowMs / 1000)};name=${name}`);
    if (r.ok) return next();
    const retryAfter = Math.max(1, Math.ceil((r.resetAt - now()) / 1000));
    res.setHeader("retry-after", String(retryAfter));
    res.status(429).json({ error: `rate limited (${name}: ${r.limit} per ${Math.round(rl.windowMs / 1000)} s), try again in ${retryAfter} s`, retryAfter });
  };
  mw.limiter = rl;
  return mw;
}

// ---------------------------------------------------------------- security headers
export const DEFAULT_CSP_HOSTS = { fonts: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"], frames: ["https://connect.solflare.com"] };

/**
 * Content-Security-Policy for the SPA. Scripts: our own bundles plus a nonce for the one inline
 * theme snippet index.html may carry (`<script nonce="__CSP_NONCE__">`); styles need
 * 'unsafe-inline' because React, d3 and lightweight-charts set style attributes; connect-src is
 * same-origin only (the RPC goes through /api/rpc, the SSE stream is /api/events), plus the
 * metadata host; images are our proxy, data: (wallet icons) and the metadata host; Solflare's
 * web wallet runs in an iframe, and frame-src 'self' lets /docs/api preview the /embed widgets
 * (every other path of ours refuses to be framed by its own frame-ancestors). Nothing else may
 * frame us.
 */
export function buildCsp({ nonce, pagesDomain = null, extraConnect = [], extraFrames = [], frameAncestors = "'none'" } = {}) {
  const pages = pagesDomain ? [`https://${pagesDomain}`] : [];
  const d = [
    "default-src 'self'",
    `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
    `style-src 'self' 'unsafe-inline' ${DEFAULT_CSP_HOSTS.fonts[0]}`,
    `font-src 'self' data: ${DEFAULT_CSP_HOSTS.fonts[1]}`,
    `img-src 'self' data: blob: ${pages.join(" ")}`.trim(),
    `connect-src 'self' ${[...pages, ...extraConnect].join(" ")}`.trim(),
    `frame-src 'self' ${[...DEFAULT_CSP_HOSTS.frames, ...extraFrames].join(" ")}`,
    "worker-src 'self' blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ];
  return d.join("; ");
}
/**
 * The embeddable widgets (DESIGN §12: `/embed/tree/:mint`, `/embed/map`) are the one part of the
 * site any page may frame; every other path keeps `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
 * They are read-only views (no wallet, no transaction), and their links open sporepad.com in a new
 * tab, so a framing page cannot drive an action through them.
 */
export const isEmbedPath = (p) => p === "/embed" || String(p).startsWith("/embed/");
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * Helmet-style headers on every response. HSTS only when the request arrived over TLS (behind a
 * TLS-terminating proxy that is trusted, `req.secure` reflects X-Forwarded-Proto) or when forced
 * by config, so a plain-http dev server never pins browsers to https. Each request gets a nonce
 * (`res.locals.cspNonce`) that the HTML sender puts into the CSP and the inline snippet.
 */
export function securityHeaders({ hsts = "auto" } = {}) {
  return (req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString("base64");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("x-dns-prefetch-control", "off");
    if (hsts === true || (hsts === "auto" && req.secure)) res.setHeader("strict-transport-security", "max-age=15552000; includeSubDomains");
    // API and file responses get the restrictive policy; the HTML sender overrides it with the SPA one.
    res.setHeader("content-security-policy", API_CSP);
    next();
  };
}

/** CORS for an explicit allowlist of origins (a separate dev host); production is same-origin. /v1 has its own (`v1Cors`). */
export function cors(origins = []) {
  const allowed = new Set(origins);
  return (req, res, next) => {
    if (isV1Path(req.path)) return next();
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      res.setHeader("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS" && req.path.startsWith("/api/")) return res.sendStatus(204);
    next();
  };
}

export const isV1Path = (p) => p === "/v1" || String(p).startsWith("/v1/");
export const V1_EXPOSED_HEADERS = "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Policy, X-Spore-Tier, Retry-After, ETag";
/**
 * CORS for the public read-only API (DESIGN §12): any origin, GET only, no credentials, so a
 * trading terminal can call it straight from the browser. Nothing under /v1 reads a cookie or
 * changes state, which is what makes `*` safe here while /api keeps its allowlist. A preflight is
 * answered here, before authentication and rate limiting (it carries no key).
 */
export function v1Cors({ maxAge = 86_400 } = {}) {
  return (req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "X-API-Key, Content-Type");
    res.setHeader("access-control-expose-headers", V1_EXPOSED_HEADERS);
    if (req.method === "OPTIONS") { res.setHeader("access-control-max-age", String(maxAge)); res.setHeader("cache-control", "public, max-age=86400"); return res.status(204).end(); }
    next();
  };
}

// ---------------------------------------------------------------- logging
/**
 * One line per request with status, latency and bytes. Every error and every slow request is
 * logged; the rest is sampled (`sample` = fraction) so a busy site does not write a line per
 * image. Query strings are dropped: the image proxy's `u=` is long and never needed to debug.
 */
export function requestLog({ log = console, sample = 0.1, slowMs = 1000, random = Math.random } = {}) {
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const errorish = res.statusCode >= 400, slow = ms >= slowMs;
      if (!errorish && !slow && random() >= sample) return;
      const bytes = res.getHeader("content-length") ?? "-";
      const line = `${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms ${bytes}B ${req.ip}${slow ? " SLOW" : ""}`;
      if (res.statusCode >= 500) log.error?.(`http: ${line}`); else if (errorish) log.warn?.(`http: ${line}`); else log.info?.(`http: ${line}`);
    });
    next();
  };
}

// ---------------------------------------------------------------- compression
const COMPRESSIBLE = /json|text\/|javascript|xml|svg|wasm|font\/ttf|font\/otf/i;
const encodingOf = (req) => { const a = String(req.headers["accept-encoding"] ?? ""); return /\bbr\b/.test(a) ? "br" : /\bgzip\b/.test(a) ? "gzip" : null; };

/**
 * gzip/brotli from node:zlib. A response that ends in one call (`res.json`, `res.send`) is
 * compressed synchronously when it is at least `threshold` bytes; a streamed one (express.static
 * piping a file) goes through a zlib stream. Event streams and already-encoded bodies pass
 * untouched. Brotli quality 4 / gzip level 6 keep CPU per request in the sub-millisecond range for
 * API payloads while still cutting JSON by ~80%.
 */
export function compression({ threshold = 1024, brotliQuality = 4, gzipLevel = 6 } = {}) {
  const brOpts = { params: { [Z.BROTLI_PARAM_QUALITY]: brotliQuality } };
  return (req, res, next) => {
    const enc = encodingOf(req);
    if (!enc || req.method === "HEAD") return next();
    const write = res.write.bind(res), end = res.end.bind(res), writeHead = res.writeHead.bind(res);
    let mode = null; // null = undecided, "stream", "sync" or "none"
    let stream = null;
    const compressible = () => {
      if (res.headersSent || res.getHeader("content-encoding") || res.statusCode === 204 || res.statusCode === 304) return false;
      const ct = String(res.getHeader("content-type") ?? "");
      return COMPRESSIBLE.test(ct) && !/event-stream/i.test(ct);
    };
    const mark = () => {
      res.removeHeader("content-length");
      res.setHeader("content-encoding", enc);
      const vary = res.getHeader("vary");
      res.setHeader("vary", vary ? `${vary}, accept-encoding` : "accept-encoding");
    };
    const startStream = () => {
      stream = enc === "br" ? createBrotliCompress(brOpts) : createGzip({ level: gzipLevel });
      stream.on("data", (chunk) => write(chunk));
      stream.on("end", () => end());
      stream.on("error", () => res.destroy());
      mark();
    };
    const decideStream = () => {
      if (mode) return;
      const len = Number(res.getHeader("content-length"));
      if (compressible() && !(Number.isFinite(len) && len > 0 && len < threshold)) { mode = "stream"; startStream(); } else mode = "none";
    };
    res.writeHead = (status, a, b) => {
      // Headers handed to writeHead bypass getHeader, so they are folded into the header store first.
      const hdrs = a && typeof a === "object" ? a : b;
      if (hdrs && !Array.isArray(hdrs)) for (const [k, v] of Object.entries(hdrs)) if (v !== undefined) res.setHeader(k, v);
      if (!res.headersSent) res.statusCode = status;
      decideStream();
      return typeof a === "string" ? writeHead(status, a) : writeHead(status);
    };
    res.write = (chunk, encoding, cb) => {
      if (!mode) decideStream();
      if (mode !== "stream") return write(chunk, encoding, cb);
      if (chunk != null) stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8"));
      if (typeof encoding === "function") encoding(); else if (cb) cb();
      return true;
    };
    res.end = (chunk, encoding, cb) => {
      if (typeof chunk === "function") { cb = chunk; chunk = null; encoding = undefined; }
      if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
      if (!mode) {
        const buf = chunk == null ? null : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding ?? "utf8");
        if (buf && buf.length >= threshold && compressible()) {
          mode = "sync";
          const out = enc === "br" ? brotliCompressSync(buf, brOpts) : gzipSync(buf, { level: gzipLevel });
          mark(); res.setHeader("content-length", String(out.length));
          return end(out, cb);
        }
        mode = "none";
      }
      if (mode !== "stream") return end(chunk, encoding, cb);
      if (chunk != null) stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding ?? "utf8"));
      stream.end();
      if (cb) res.once("finish", cb);
      return res;
    };
    next();
  };
}

// ---------------------------------------------------------------- caching helpers
export const etagOf = (body) => `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 20)}"`;

/**
 * JSON with a weak ETag and a short public max-age: feeds and leaderboards change every refresh
 * tick, so a few seconds of caching lets a CDN or a browser tab absorb repeat loads, and an
 * If-None-Match hit costs nothing but the hash.
 */
export function sendCachedJson(req, res, body, { maxAge = 5, swr = maxAge * 4, cacheControl = null } = {}) {
  const text = JSON.stringify(body);
  const tag = etagOf(text);
  res.setHeader("etag", tag);
  res.setHeader("cache-control", cacheControl ?? `public, max-age=${maxAge}, stale-while-revalidate=${swr}`);
  if (req.headers["if-none-match"] === tag) return res.status(304).end();
  res.type("application/json").send(text);
}

/**
 * A JSON body encoded once and served many times: the text, its ETag and, lazily, the gzip and
 * brotli bytes. The whole-forest map is ~5 MB of JSON for 15k coins; compressing it per request
 * would cost more than building it, so the cache entry holds the bytes for the 10 s it lives.
 */
export function prepareJson(body, opts = {}) { return prepareJsonText(JSON.stringify(body), opts); }
/** `prepareJson` for a body that is already JSON text (the /v1 map rewrites the /api bytes, DESIGN §12). */
export function prepareJsonText(text, opts = {}) { return preparedBytes(Buffer.from(text, "utf8"), etagOf(text), { ...opts, text }); }
/**
 * A prepared body from its bytes and ETag: `encoded(enc)` makes the gzip or brotli bytes once, on the event loop;
 * `encodedAsync(enc)` makes the same bytes once on libuv's thread pool (zlib's async API gives the sync API's
 * bytes; one job per encoding however many requests wait on it). `text` is the JSON text when one was given,
 * else decoded from the bytes on each read: a body encoded in slices (prepareJsonGen) keeps only its bytes.
 */
export function preparedBytes(bytes, etag, { brotliQuality = 4, gzipLevel = 6, text } = {}) {
  const brOpts = { params: { [Z.BROTLI_PARAM_QUALITY]: brotliQuality } }, gzOpts = { level: gzipLevel };
  // The async API hands every output chunk back to the event loop: with the default 16 KB, brotli of the 35 MB map
  // took 4.6 s while map builds held the loop in 8 ms slices (~500 hops), 0.8 s with 1 MB chunks. Same bytes either way.
  const brAsync = { ...brOpts, chunkSize: ASYNC_CHUNK_BYTES }, gzAsync = { ...gzOpts, chunkSize: ASYNC_CHUNK_BYTES };
  let txt = text;
  const p = { bytes, etag, br: null, gz: null };
  Object.defineProperty(p, "text", { enumerable: true, configurable: true, get: () => (txt === undefined ? bytes.toString("utf8") : txt), set: (v) => { txt = v; } });
  p.encoded = (enc) => {
    if (enc === "br") return (p.br ??= brotliCompressSync(bytes, brOpts));
    if (enc === "gzip") return (p.gz ??= gzipSync(bytes, gzOpts));
    return bytes;
  };
  const jobs = { br: null, gzip: null };
  const pool = bytes.length >= POOL_CAP_BYTES ? onPool : (make) => make();
  p.encodedAsync = (enc) => {
    if (enc === "br") return p.br ? Promise.resolve(p.br) : (jobs.br ??= pool(() => brotliAsync(bytes, brAsync)).then((b) => (p.br ??= b)).finally(() => { jobs.br = null; }));
    if (enc === "gzip") return p.gz ? Promise.resolve(p.gz) : (jobs.gzip ??= pool(() => gzipAsync(bytes, gzAsync)).then((b) => (p.gz ??= b)).finally(() => { jobs.gzip = null; }));
    return Promise.resolve(bytes);
  };
  return p;
}
/** A map tree node (`{ coin, children }`) with at least this many children is encoded one child at a time: its text is the same. */
const SPLIT_CHILDREN = 4;
/** JSON text gathered before it is turned into bytes and hashed (prepareJsonGen). */
const CHUNK_CHARS = 64 * 1024;
const isTreeNode = (o) => { const k = Object.keys(o); return k.length === 2 && k[0] === "coin" && k[1] === "children" && o.coin !== undefined; };
/**
 * prepareJson as a generator for runSliced (sliced.mjs), for a body whose first key `key` holds a big array (the
 * map's `roots` or `nodes`: 35 MB of JSON on the local index, 0.6 s of stringify and hashing in one block). The
 * array is encoded one element at a time (a tree node with many children one child at a time) into ~64 KB chunks,
 * hashed as they come, and the bytes are joined once. The bytes are exactly JSON.stringify(body)'s, with the closing
 * "}" replaced by `tail` when given (the /api map bodies append `,"indexed":n}`) and each chunk mapped by `transform`
 * (the /v1 bodies' absolute image URLs; a chunk ends between two JSON values, so no image field is split). Returns
 * preparedBytes(bytes, etag): the ETag is sha1 over those bytes, as etagOf gives; no text is kept.
 */
export function* prepareJsonGen(body, { key, tail = null, transform = null, ...opts } = {}) {
  const arr = body?.[key], head = `{${JSON.stringify(key)}:[`, shell = JSON.stringify({ ...body, [key]: [] });
  if (!Array.isArray(arr) || !shell.startsWith(`${head}]`)) { // not the shape this splits: in one go
    let text = JSON.stringify(body);
    if (tail != null) text = text.slice(0, -1) + tail;
    return prepareJsonText(transform ? transform(text) : text, opts);
  }
  const hash = createHash("sha1"), bufs = [];
  let len = 0, chunk = head, n = 0;
  const flush = () => {
    const b = Buffer.from(transform ? transform(chunk) : chunk, "utf8");
    hash.update(b); bufs.push(b); len += b.length; chunk = "";
  };
  function* add(node) {
    const kids = node?.children;
    if (Array.isArray(kids) && kids.length >= SPLIT_CHILDREN && isTreeNode(node)) {
      chunk += `{"coin":${JSON.stringify(node.coin)},"children":[`;
      for (let j = 0; j < kids.length; j++) { if (j) chunk += ","; yield* add(kids[j]); }
      chunk += "]}";
    } else chunk += JSON.stringify(node) ?? "null";
    if (chunk.length >= CHUNK_CHARS) { flush(); yield; } else if ((++n & 63) === 0) yield;
  }
  for (let i = 0; i < arr.length; i++) { if (i) chunk += ","; yield* add(arr[i]); }
  const rest = shell.slice(head.length); // "]" + the body's other keys + "}"
  chunk += tail != null ? rest.slice(0, -1) + tail : rest;
  flush();
  yield;
  // The chunks joined into one buffer (what zlib and res.end take) ~8 MB per step: the 35 MB copy was one 17-23 ms step.
  let bytes = bufs[0];
  if (bufs.length > 1) {
    bytes = Buffer.allocUnsafe(len);
    let at = 0, since = 0;
    for (const b of bufs) { b.copy(bytes, at); at += b.length; since += b.length; if (since >= 8 * 2 ** 20) { since = 0; yield; } }
    yield;
  }
  return preparedBytes(bytes, `W/"${hash.digest("base64url").slice(0, 20)}"`, opts);
}
/** Bodies at least this big are compressed on the thread pool (encodedAsync) when their bytes are not made yet: brotli of the 35 MB map took 1.2 s of the event loop. */
export const ASYNC_ENCODE_BYTES = 256 * 1024;
/** Sends a `prepareJson` result with the cache headers of `sendCachedJson`, pre-encoded for the client's accept-encoding. */
export function sendPrepared(req, res, prepared, { maxAge = 5, swr = maxAge * 4, cacheControl = null } = {}) {
  res.setHeader("etag", prepared.etag);
  res.setHeader("cache-control", cacheControl ?? `public, max-age=${maxAge}, stale-while-revalidate=${swr}`);
  if (req.headers["if-none-match"] === prepared.etag) return res.status(304).end();
  const enc = req.method === "HEAD" ? null : encodingOf(req);
  const send = (out) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (out !== prepared.bytes) { res.setHeader("content-encoding", enc); const vary = res.getHeader("vary"); res.setHeader("vary", vary ? `${vary}, accept-encoding` : "accept-encoding"); }
    res.setHeader("content-length", String(out.length));
    res.end(out);
  };
  if (!enc || prepared.bytes.length < 1024) return send(prepared.bytes);
  const made = enc === "br" ? prepared.br : enc === "gzip" ? prepared.gz : null;
  if (!made && prepared.encodedAsync && prepared.bytes.length >= ASYNC_ENCODE_BYTES) {
    return prepared.encodedAsync(enc).then(send, () => send(prepared.bytes)).catch(() => res.destroy());
  }
  return send(prepared.encoded(enc));
}

/**
 * Serves index.html with the SPA CSP and the per-request nonce substituted into `__CSP_NONCE__`.
 * `embed` (an /embed/* path) lets any page frame it: `frame-ancestors *` and no X-Frame-Options.
 */
export function sendSpaHtml(res, html, { pagesDomain, extraConnect = [], extraFrames = [], embed = false } = {}) {
  const nonce = res.locals.cspNonce;
  res.setHeader("content-security-policy", buildCsp({ nonce, pagesDomain, extraConnect, extraFrames, frameAncestors: embed ? "*" : "'none'" }));
  if (embed) res.removeHeader("x-frame-options");
  res.setHeader("cache-control", "no-cache");
  res.type("html").send(html.includes("__CSP_NONCE__") ? html.replaceAll("__CSP_NONCE__", nonce) : html);
}
