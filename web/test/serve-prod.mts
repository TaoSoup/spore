// Serves a production build of the web app the way server/lib/api.mjs does (index.html with the SPA CSP
// and a per-request nonce, hashed /assets immutable, SPA fallback, a dotted unknown path = 404) and
// proxies /api, /v1 and /m/ to a live API (default https://sporepad.com), so the map can be QA'd against
// real data without the real server's database, RPC or indexer. Nothing here writes upstream except the
// requests the page itself makes.
//   - /api/events: ONE upstream SSE connection fanned out to every local client as whole frames (the
//     live API caps event streams per IP; every QA reload would otherwise open a new one).
//   - short-TTL cache for GET /api/map (full form only, never since=), /api/map/heat and /api/img, so a
//     QA run stays far under the API's per-IP rate limits (api 300/min, img 900/min, sse 30/min).
//   - IMG_FALLBACK=1 (default): a dead logo upstream answers a 1x1 PNG (header x-proxy-error) instead of
//     a failed resource, like the prototype's proxy; IMG_FALLBACK=0 passes the failure through.
//
//   - --fixture <dir> (map3 QA, test/map3-shots.mts): GET /api/map with any query (since= included: an
//     older server answers the full tree to since=, and the client upserts it) answers <dir>/map.json and
//     GET /api/map/heat answers <dir>/heat.json, read from disk on every request; /api/events is an idle
//     stream (": ping" every 15 s) unless --fixture-sse live, which keeps the single fanned-out upstream
//     stream. Everything else (/api/img, /api/coin/…, /api/rpc, /v1, /m/) is still proxied upstream.
//
//   - --h2 (map3 logo gate): HTTPS with HTTP/2 (node:http2 createSecureServer, allowHTTP1) on a self-signed cert made
//     once by openssl into --cert-dir (default $SPORE_QA_CERT or <tmp>/spore-qa-cert); Chrome caps HTTP/1.1 at 6 sockets
//     per host, which starves the logo loader. Scripts given an https://127.0.0.1 URL launch Chrome with
//     --ignore-certificate-errors (test/map3-cdp.mts). /api/img forwards the upstream x-img-thumb and cache-control headers.
//
//   npx vite build --outDir <dir>/dist
//   node --import tsx test/serve-prod.mts --dist <dir>/dist [--port 5260] [--upstream https://sporepad.com]
//   node --import tsx test/serve-prod.mts --dist <dir>/dist --port 5261 --fixture <PROTO dir> [--fixture-sse idle|live]
//   node --import tsx test/serve-prod.mts --dist <dir>/dist --port 5262 --h2 [--cert-dir <dir>]   → https://127.0.0.1:5262/map?debug
//   then open http://127.0.0.1:5260/map?debug
import http from "node:http";
import http2 from "node:http2";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(opt("--dist", join(HERE, "../dist")));
const PORT = Number(opt("--port", process.env.PORT ?? "5260"));
const UP = opt("--upstream", process.env.UPSTREAM ?? "https://sporepad.com").replace(/\/$/, "");
const PAGES_DOMAIN = process.env.PAGES_DOMAIN ?? "spore-2x6.pages.dev";
const IMG_FALLBACK = process.env.IMG_FALLBACK !== "0";
const FIXTURE = (() => { const f = opt("--fixture", ""); return f ? resolve(f) : null; })();
const FIXTURE_SSE = opt("--fixture-sse", "idle");
const H2 = args.includes("--h2");
const CERT_DIR = resolve(opt("--cert-dir", process.env.SPORE_QA_CERT ?? join(process.env.SPORE_TMP ?? tmpdir(), "spore-qa-cert")));
if (FIXTURE_SSE !== "idle" && FIXTURE_SSE !== "live") throw new Error(`--fixture-sse must be idle or live, not ${FIXTURE_SSE}`);
if (FIXTURE) for (const f of ["map.json", "heat.json"]) await stat(join(FIXTURE, f)).catch(() => { throw new Error(`--fixture ${FIXTURE}: ${f} is missing`); });
// the production CSP builder itself (server/lib/http.mjs imports only node: built-ins)
const httpMjs = process.env.HTTP_MJS ?? join(HERE, "../../server/lib/http.mjs");
const { buildCsp, isEmbedPath } = (await import(httpMjs)) as { buildCsp: (o: Record<string, unknown>) => string; isEmbedPath: (p: string) => boolean };

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const BLANK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const UA = "spore-qa-serve";

// ---------------------------------------------------------------- upstream cache
type Hit = { t: number; status: number; type: string; body: Buffer; thumb?: string | null; cc?: string | null; xs?: [string, string][] };
const cache = new Map<string, Hit>(), inflight = new Map<string, Promise<Hit>>();
/// The logo-sheet headers (x-sheet, x-sheet-dead, x-sheet-n, ...): forwarded as they are, the client reads them.
const sheetHeaders = (r: Response): [string, string][] => [...r.headers].filter(([k]) => k.startsWith("x-sheet"));
const ttlOf = (path: string, search: string): number => {
  if (path === "/api/map" && !/[?&]since=/.test(search)) return 60_000;
  if (path === "/api/map/heat") return 15_000;
  if (path === "/api/img") return 6 * 3_600_000;
  return 0;
};
async function upstreamGet(pathSearch: string, ttl: number): Promise<Hit> {
  const hit = cache.get(pathSearch);
  if (hit && Date.now() - hit.t < ttl) return hit;
  const running = inflight.get(pathSearch);
  if (running) return running;
  const p = (async () => {
    const r = await fetch(UP + pathSearch, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
    const v: Hit = { t: Date.now(), status: r.status, type: r.headers.get("content-type") ?? "application/octet-stream", body: Buffer.from(await r.arrayBuffer()), thumb: r.headers.get("x-img-thumb"), cc: r.headers.get("cache-control"), xs: sheetHeaders(r) };
    if (r.ok && ttl > 0) cache.set(pathSearch, v);
    return v;
  })().catch((e: Error): Hit => hit ?? { t: 0, status: 502, type: "text/plain", body: Buffer.from(`upstream: ${e.message}`) }).finally(() => inflight.delete(pathSearch));
  inflight.set(pathSearch, p);
  return p;
}

// ---------------------------------------------------------------- SSE fan-out
const sseClients = new Set<http.ServerResponse>();
let sseUp: { ac: AbortController } | null = null;
const sseWrite = (res: http.ServerResponse, s: string) => { try { res.write(s); } catch { sseClients.delete(res); } };
function sseUpstream() {
  if (sseUp || !sseClients.size) return;
  const up = (sseUp = { ac: new AbortController() });
  void (async () => {
    try {
      const r = await fetch(UP + "/api/events", { headers: { accept: "text/event-stream", "user-agent": UA }, signal: up.ac.signal });
      if (!r.ok || !r.body) { console.log(`sse upstream ${r.status}`); await new Promise((ok) => setTimeout(ok, 5_000)); return; }
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let k: number;
        while ((k = buf.indexOf("\n\n")) >= 0) { const frame = buf.slice(0, k + 2); buf = buf.slice(k + 2); for (const c of sseClients) sseWrite(c, frame); }
        if (!sseClients.size) break;
      }
    } catch (e) { if (!up.ac.signal.aborted) console.log(`sse upstream error ${String(e).slice(0, 120)}`); }
    finally { if (sseUp === up) sseUp = null; if (sseClients.size) setTimeout(sseUpstream, 1_000); }
  })();
}
/// SSE response headers; HTTP/2 forbids connection-specific headers (the compat API throws on them).
const sseHead = (req: http.IncomingMessage): Record<string, string> => ({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", ...(req.httpVersionMajor >= 2 ? {} : { connection: "keep-alive" }), "x-accel-buffering": "no" });
function sse(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, sseHead(req));
  res.write(": connected\n\n");
  sseClients.add(res);
  const hb = setInterval(() => sseWrite(res, `: hb ${Date.now()}\n\n`), 15_000);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); if (!sseClients.size && sseUp) { sseUp.ac.abort(); sseUp = null; } });
  sseUpstream();
}

// ---------------------------------------------------------------- proxy (anything not cached: POST /api/rpc, /api/coin/…, since=, /v1, /m/)
async function proxy(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const ttl = req.method === "GET" ? ttlOf(url.pathname, url.search) : 0;
  if (ttl > 0) {
    let v = await upstreamGet(url.pathname + url.search, ttl);
    if (url.pathname === "/api/img" && v.status >= 400 && IMG_FALLBACK) { res.setHeader("x-proxy-error", String(v.status)); v = { ...v, status: 200, type: "image/png", body: BLANK_PNG }; }
    const img = url.pathname === "/api/img";
    const h: Record<string, string> = { "content-type": v.type, "cache-control": img && v.cc && v.status < 400 ? v.cc : "no-store" };
    if (v.thumb) h["x-img-thumb"] = v.thumb;
    for (const [k, val] of v.xs ?? []) h[k] = val;
    res.writeHead(v.status, h);
    return res.end(v.body);
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers: Record<string, string> = { "user-agent": UA };
  for (const h of ["content-type", "accept", "x-api-key"]) { const v = req.headers[h]; if (typeof v === "string") headers[h] = v; }
  try {
    const r = await fetch(UP + url.pathname + url.search, { method: req.method, headers, body: chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(30_000) });
    const body = Buffer.from(await r.arrayBuffer()); // fetch already decoded any content-encoding
    // a logo sheet keeps the upstream cache-control (private, max-age=600 once nothing is pending; no-store while it is), like /api/img
    const cc = url.pathname === "/api/logo-sheet" && r.ok ? r.headers.get("cache-control") : null;
    const h: Record<string, string> = { "content-type": r.headers.get("content-type") ?? "application/octet-stream", "cache-control": cc || "no-store" };
    const thumb = r.headers.get("x-img-thumb"); if (thumb) h["x-img-thumb"] = thumb;
    for (const [k, v] of sheetHeaders(r)) h[k] = v;
    res.writeHead(r.status, h);
    res.end(body);
  } catch (e) { res.writeHead(502, { "content-type": "text/plain" }); res.end(`upstream: ${(e as Error).message}`); }
}

// ---------------------------------------------------------------- fixture (--fixture <dir>)
async function fixtureFile(res: http.ServerResponse, name: string) {
  const body = await readFile(join(FIXTURE!, name));
  res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length), "cache-control": "no-store", "x-fixture": name });
  res.end(body);
}
/// The idle stream of a fixture run: the connection opens and stays quiet (a comment every 15 s), so the
/// page's stream status is live and nothing moves the reference shots.
function sseIdle(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, sseHead(req));
  res.write(": connected (fixture, idle)\n\n");
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 15_000);
  req.on("close", () => clearInterval(hb));
}

// ---------------------------------------------------------------- static + SPA (mirrors server/lib/api.mjs:615-628)
let indexCache: { text: string; mtimeMs: number } | null = null;
async function indexHtml(): Promise<string> {
  const f = join(DIST, "index.html"), st = await stat(f);
  if (!indexCache || indexCache.mtimeMs !== st.mtimeMs) indexCache = { text: await readFile(f, "utf8"), mtimeMs: st.mtimeMs };
  return indexCache.text;
}
async function sendIndex(res: http.ServerResponse, path: string) {
  const nonce = randomBytes(16).toString("base64");
  const embed = isEmbedPath(path);
  res.setHeader("content-security-policy", buildCsp({ nonce, pagesDomain: PAGES_DOMAIN, frameAncestors: embed ? "*" : "'none'" }));
  if (!embed) res.setHeader("x-frame-options", "DENY");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end((await indexHtml()).replaceAll("__CSP_NONCE__", nonce));
}
async function sendStatic(res: http.ServerResponse, path: string): Promise<boolean> {
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(DIST, rel);
  if (!file.startsWith(DIST)) return false;
  try {
    const st = await stat(file);
    if (!st.isFile()) return false;
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "content-length": String(st.size), "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600" });
    res.end(await readFile(file));
    return true;
  } catch { return false; }
}

const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  try {
    if (FIXTURE && req.method === "GET") {
      if (p === "/api/map") return await fixtureFile(res, "map.json");
      if (p === "/api/map/heat") return await fixtureFile(res, "heat.json");
      if (p === "/api/events" && FIXTURE_SSE === "idle") return sseIdle(req, res);
    }
    if (p === "/api/events") return sse(req, res);
    if (p.startsWith("/api/") || p === "/api" || p.startsWith("/v1/") || p === "/v1" || p.startsWith("/m/")) return await proxy(req, res, url);
    if (p === "/") return await sendIndex(res, p);
    if (await sendStatic(res, p)) return;
    if (p.includes(".")) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    return await sendIndex(res, p);
  } catch (e) { try { res.writeHead(500, { "content-type": "text/plain" }); res.end(String(e)); } catch { /* headers already sent */ } }
};

/// The self-signed cert for --h2 (made once; IP SAN 127.0.0.1 + DNS localhost).
function cert(): { key: Buffer; cert: Buffer } {
  const k = join(CERT_DIR, "key.pem"), c = join(CERT_DIR, "cert.pem");
  if (!existsSync(k) || !existsSync(c)) {
    mkdirSync(CERT_DIR, { recursive: true });
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", k, "-out", c, "-days", "30", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  }
  return { key: readFileSync(k), cert: readFileSync(c) };
}
const server = H2
  ? http2.createSecureServer({ ...cert(), allowHTTP1: true }, handler as unknown as (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void)
  : http.createServer(handler);
server.listen(PORT, "127.0.0.1", () => console.log(`serving ${DIST} on ${H2 ? "https" : "http"}://127.0.0.1:${PORT}/${H2 ? " (h2 + h1, self-signed)" : ""} (api → ${UP}${FIXTURE ? `; /api/map + /api/map/heat from ${FIXTURE}, events ${FIXTURE_SSE}` : ""})`));
