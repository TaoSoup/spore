// Off-chain metadata (the JSON behind a coin's `uri`) and the image proxy.
//
// Both talk to third-party hosts, so both are gated: metadata is fetched by a bounded, per-host
// paced queue that covers every tracked coin (DESIGN §11.5: a background sweep orders the work by
// locked value, then recency; failures retry with a growing backoff that survives restarts, shorter
// for a temporary failure, weekly for a host that keeps saying the file is gone);
// images are served only from an allowlist of hosts pump.fun coins actually use, capped at 4 MB and
// cached on disk for 24 h (an SVG logo, capped at 1 MB, is drawn into a PNG on the image worker and
// kept and served as that PNG: SVG bytes are never stored or served, they can script); their 64 px
// thumbnails are made the moment an image url is first seen and kept for good (only a disk budget evicts them, least recently served first; on a full budget a new
// coin's first-sight thumbnail evicts one unused for 30 days, the warm pass none). The browser never
// loads a creator-supplied URL directly. IPFS content is
// tried through a gateway rotation (pump.fun's own pinata gateway, then ipfs.filebase.io → 4everland.io →
// ipfs.io → dweb.link → gateway.pinata.cloud → w3s.link): one gateway's 403/404/429/timeout is not final, the
// next may hold the bytes, and the least-busy gateway is asked first so six workers spread over the rotation; a
// rotation in which no public gateway looked for the file (paused, rate-limited) is a deferral, asked again within
// the hour, not a failed attempt (isGatewayDeferral).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync, createReadStream, unlinkSync, readdirSync, renameSync, existsSync, utimesSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import zlib from "node:zlib";
import { META_NAME_RE, META_TYPES } from "./metahost.mjs";
import { HostGuard, guardedFetch, pinnedFetch } from "./net.mjs";
import { sniffImage } from "./validate.mjs";
import { drain, runSliced } from "./sliced.mjs";
import { IMAGE_THUMB_SIZES, THUMB_TYPES, SHEET_COLS, SHEET_MAX_CELLS, SVG_MAX_BYTES, SVG_DRAW_MAX_MS, SVG_RASTER_PX, WORKER_RECYCLE_BYTES, WORKER_JOB_MAX_BYTES, RESVG_MEMORY_MAX_BYTES, renderThumb, runOp, isSvgDocument } from "./img-worker.mjs";

export { IMAGE_THUMB_SIZES, THUMB_TYPES, SHEET_COLS, SHEET_MAX_CELLS, SVG_MAX_BYTES, SVG_DRAW_MAX_MS, SVG_RASTER_PX, WORKER_RECYCLE_BYTES, WORKER_JOB_MAX_BYTES, RESVG_MEMORY_MAX_BYTES, renderThumb };

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
// Version of the IPFS gateway rotation (IPFS_GATEWAYS). What failed under an older rotation may have failed only on
// the old gateways' rate limits, so it is tried once more at boot: metadata rows of IPFS content whose error is
// temporary become due at once (MetaFetcher.queueGatewayRecheck, kv "metaGatewayRule"), and the image proxy forgets
// its IPFS failures that were temporary or carry a per-gateway summary (ImageCache, kv "imgGatewayRule"). Rule 2
// (2026-11-10) added ipfs.filebase.io and 4everland.io, which served all 5 stuck CIDs probed while every old public
// gateway answered 429 on sight. Bump it whenever the rotation gains a gateway.
export const GATEWAY_RULE = 2;
// Version of what the image proxy can turn into a logo. Rule 2 (2026-11-11) draws an SVG into a PNG original (img-worker.mjs
// rasterizeSvg) where rule 1 refused it as "not an image: image/svg+xml", a permanent failure retried after a week: 124 logos
// of the local index, 80 of them the family tops of Backpack's stock tokens (backpack.exchange/api/stock-logo/<SYMBOL>
// answers image/svg+xml). Rule 1 also refused plain text and XML before the download, which rule 2 sniffs (raw file hosts
// serve .svg as text/plain). At boot the image proxy forgets, once (kv "imgTypeRule"), the failures an older rule recorded
// for those (TYPE_REFUSAL_RE) and queues their urls for first sight (ImageCache, #loadFails); no other failure is touched.
export const IMG_TYPE_RULE = 2;
const TYPE_REFUSAL_RE = /^not (?:an|a raster) image\b.*svg|^not an image: text\/(?:plain|xml)$/i;
export const IMAGE_TTL_MS = 24 * 3600 * 1000;
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const META_MAX_BYTES = 512 * 1024;
export const HOST_SPACING_MS = 200;  // minimum gap between two requests to the same host (≈ 5/s per gateway)
const HOST_PAUSE_MS = 10_000;        // first pause after a 429 from a host (doubles, caps at 2 min)
// ... or the host's own Retry-After when that is longer, up to this. Measured 2026-11-10: dweb.link answers 429 with
// Retry-After 900 (w3s.link now redirects there), which the 2-min cap asked again seven times over.
export const HOST_RETRY_AFTER_MAX_MS = 15 * 60_000;

/** Seconds to wait before retrying a uri that failed `attempts` times in a row (15 min, 30, 1 h, 2 h … 24 h). */
export const retryAfterS = (attempts) => Math.min(META_RETRY_MAX_S, META_RETRY_S * 2 ** Math.max(0, (attempts ?? 1) - 1));
// A temporary failure (429, 5xx, a timeout or network error, IPFS gateways that mixed a "no" with any of
// those, or a rotation whose gateways did not resolve: our DNS) waits at most META_RETRY_TRANSIENT_MAX_S while
// fewer than META_DEAD_AFTER fetches failed in a row (the file is probably there), then backs off like any
// other failure, up to a day (an unpinned CID would otherwise be asked 56 times a week, forever). A non-IPFS
// host that answered 404/410, or a name that does not resolve, META_DEAD_AFTER times IN A ROW (`deadStreak`:
// consecutive failures of that kind; any other failure or a success resets it, `attempts` counts every failure)
// is asked weekly (measured 2026-11-10: 11.5k such uris held the six workers every day for nothing). Before
// that it is retried on the usual backoff, so a local DNS outage costs a lone host a few retries, not a week.
export const META_RETRY_TRANSIENT_MAX_S = 3 * 3600;
export const META_RETRY_DEAD_S = 7 * 24 * 3600;
export const META_DEAD_AFTER = 5;
// A rotation in which no public gateway looked for the file (isGatewayDeferral: each one was paused, out of the budget,
// said 429 / 408 / 425 / a 5xx other than 504, or failed on the network, while pump's pinata at most said it did not pin
// it) is a deferral, not a failed attempt: a run of them counts up to META_DEFER_CAP on `attempts` and never takes back
// what real failures counted (bringing the count down to the cap would restart an unpinned CID's climb on
// timeouts), and it waits META_DEFER_S, doubling per deferral in a row (10, 20, then 40 min), plus up to half of that as
// a jitter fixed per uri, so never more than an hour (measured 2026-11-10: 4.9k IPFS rows waited 8-24 h after up to 8
// such "attempts", in which no public gateway ever looked: pump's 403, w3s.link failing on the network, the rest paused;
// those counts come down to the cap once, at boot: queueGatewayRecheck; at the cap, a backlog of 5k costs about 1.7 rows
// a second). A timeout or a
// 504 is not a deferral: both gateways added that day hang until our timeout on a CID nobody has, so an unpinned CID
// would be retried within the hour forever, holding a worker ~20 s each time; it keeps the temporary rule above.
export const META_DEFER_S = 10 * 60;
export const META_DEFER_CAP = 3;

/** Is an HTTP status a temporary condition (rate limit, timeout, server trouble) rather than an answer about the file? */
const softStatus = (s) => s === 408 || s === 425 || s === 429 || s >= 500;
// A rotation summary ("403 pump.mypinata.cloud; 429 ipfs.io; timeout dweb.link", HostPacer.fetchAny) is
// temporary when any gateway was rate-limited, paused, timed out, failed on the network, answered 5xx or
// was never asked because the budget ran out; a plain error message when it names such a condition.
const SOFT_TAG_RE = /(?:^|;\s*)(?:408|425|429|5\d\d|timeout|net|paused|budget)\s/;
const SOFT_MSG_RE = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_[A-Z_]+)\b|timeout|timed out|aborted|socket hang up|fetch failed|other side closed|rate limited/i;
/** Does a stored failure text (an "HTTP <status>", an error message or a rotation summary) name a temporary condition? */
export function isTransientError(text) {
  const t = String(text ?? "");
  const http = t.match(/^HTTP (\d{3})\b/);
  if (http) return softStatus(Number(http[1]));
  return SOFT_TAG_RE.test(t) || SOFT_MSG_RE.test(t) || dnsTrouble(t);
}
/**
 * Does a rotation summary say our resolver is in trouble rather than that hosts vanished? Yes when every
 * candidate (more than one) answered "ENOTFOUND", or when at least two of the rotation's own gateways did:
 * those exist, two gateways do not disappear together, a local DNS outage makes them all look gone at once.
 * One rotation gateway alone is not enough (repair 2026-11-10): a gateway that is retired for good would
 * otherwise make every definitive "no" from the others temporary forever. The rotation has seven gateways since
 * GATEWAY_RULE 2 (2026-11-10) and the two new ones count like the others; the threshold stays at two, not a share
 * of the seven: HostGuard keeps a vetted address for 10 min, so in a local outage the gateways asked lately still
 * answer while the rest fail together, and a rotation cut short by pauses or the budget names only a few.
 * (A lone host that does not resolve says nothing either way: its callers count how often it happens in a row.)
 */
function dnsTrouble(t) {
  const parts = t.split(/;\s*/);
  if (parts.length < 2) return false;
  const misses = parts.filter((p) => /^ENOTFOUND \S+$/.test(p));
  const rot = misses.filter((p) => ROTATION_HOSTS.has(p.slice("ENOTFOUND ".length))).length;
  return misses.length === parts.length || rot >= 2;
}
/** A lone host's "does not resolve" (an error message, not a rotation summary: that is judged by dnsTrouble). */
const isDnsMiss = (text) => { const t = String(text ?? ""); return /\bENOTFOUND\b/.test(t) && !t.includes(";"); };
// One note of a rotation summary: what one candidate did, then its host.
const NOTE_RE = /^(\d{3}|timeout|net|ENOTFOUND|paused|budget) ([a-z0-9.-]+)$/i;
/**
 * The notes of a rotation summary as [tag, host] pairs, or null when `text` is not one. A stored error is cut at 200
 * characters, so a last note cut short is left out rather than taken for a sign that this is no summary.
 */
function summaryNotes(text) {
  const parts = String(text ?? "").split(/;\s*/);
  if (parts.length < 2) return null;
  const notes = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(NOTE_RE);
    if (m) notes.push([m[1], m[2].toLowerCase()]);
    else if (i < parts.length - 1) return null;
  }
  return notes.length >= 2 ? notes : null;
}
// What a public gateway did when it did not look for the file: never asked (paused, budget), refused (408, 425, 429),
// failed on the way (net: a reset, TLS, a redirect loop) or failed itself (a 5xx other than 504). A timeout or a 504
// means it looked for a while and found nothing, which is weak evidence the file is not on the network.
const NO_LOOK_RE = /^(?:paused|budget|net|408|425|429|50[0-35-9]|5[1-9]\d)$/;
const deferMemo = new Map(); // summary text -> is it a deferral (a few dozen distinct texts cover thousands of rows)
function deferralSummary(t) {
  let v = deferMemo.get(t);
  if (v !== undefined) return v;
  v = false;
  const notes = summaryNotes(t);
  if (notes && !dnsTrouble(t)) {
    let noLook = 0;
    v = true;
    for (const [tag, host] of notes) {
      // pump's pinata serves only what pump.fun pinned, a creator's own gateway what it holds: their "no" is about them
      if (!PUBLIC_GATEWAY_HOSTS.has(host)) continue;
      if (NO_LOOK_RE.test(tag)) noLook++;
      else if (tag !== "ENOTFOUND") { v = false; break; } // an answer, or it looked (a lone retired gateway says nothing)
    }
    if (noLook === 0) v = false;
  }
  if (deferMemo.size >= 4096) deferMemo.clear();
  deferMemo.set(t, v);
  return v;
}
/**
 * Is the stored failure `text` of IPFS content `uri` a deferral rather than a failed attempt? Yes when it is a rotation
 * summary in which no public gateway (the rotation's own, but pump's pinata) gave an answer or looked for the file: each
 * one of them was paused, out of the budget, said 429 / 408 / 425 / a 5xx other than 504 or failed on the network (one
 * that does not resolve is passed over), at least one of them that way; and when it is "HTTP 429" or "rate limited",
 * what is stored when HostPacer.fetchAny answered null (every candidate paused or rate-limited) without a summary, for
 * IPFS content (a lone host's 429 keeps the temporary rule). Never for a resolver in trouble (dnsTrouble: the temporary
 * rule backs off). A summary needs no look at `uri`: only IPFS content has more than one candidate (gatewayCandidates),
 * and the sweep asks this of every failed row each minute.
 */
export function isGatewayDeferral(uri, text) {
  const t = String(text ?? "");
  if (t === "HTTP 429" || t === "rate limited") return !!ipfsPathOf(uri);
  return t.includes(";") && deferralSummary(t);
}
/**
 * A fraction in [0, 1) fixed per string, so a wait computed again at every sweep stays the same: FNV-1a, then murmur3's
 * finalizer (FNV alone spread uris that differ only in their last characters over a third of the range).
 */
function jitterOf(s) {
  let h = 0x811c9dc5;
  const t = String(s ?? "");
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
}
/** Seconds a deferred row of `uri` waits: META_DEFER_S doubling up to META_DEFER_CAP deferrals (10, 20, 40 min), plus up to half of it (jitterOf). */
export function metaDeferS(uri, attempts) {
  const a = Math.min(META_DEFER_CAP, Math.max(1, Math.floor(attempts ?? 1)));
  return Math.round(META_DEFER_S * 2 ** (a - 1) * (1 + jitterOf(uri) / 2));
}
/**
 * "deferred" (isGatewayDeferral), "transient" (isTransientError), "dead" (a non-IPFS uri whose host said 404/410 or does
 * not resolve) or "failed" (anything else).
 */
export function metaFailKind(uri, error) {
  if (isGatewayDeferral(uri, error)) return "deferred";
  if (isTransientError(error)) return "transient";
  const t = String(error ?? "");
  if (!ipfsPathOf(uri) && (/^HTTP (?:404|410)\b/.test(t) || /\bENOTFOUND\b/.test(t))) return "dead";
  return "failed";
}
/**
 * Seconds a failed metadata row `m` of `uri` waits before the next fetch: retryAfterS(attempts), capped at
 * META_RETRY_TRANSIENT_MAX_S for a transient failure while attempts < META_DEAD_AFTER, weekly for a dead host
 * once `deadStreak` (consecutive dead failures) reached META_DEAD_AFTER, and metaDeferS for a deferral (at most an
 * hour, whatever the count).
 */
export function metaRetryS(uri, m) {
  const attempts = m?.attempts ?? 1, kind = metaFailKind(uri, m?.error);
  if (kind === "deferred") return metaDeferS(uri, attempts);
  if (kind === "dead" && (m?.deadStreak ?? 0) >= META_DEAD_AFTER) return META_RETRY_DEAD_S;
  if (kind === "transient" && attempts < META_DEAD_AFTER) return Math.min(META_RETRY_TRANSIENT_MAX_S, retryAfterS(attempts));
  return retryAfterS(attempts);
}

// DESIGN §7: ipfs.io, *.pinata.cloud, *.pump.fun, arweave.net, *.arweave.net, cf-ipfs.com and the
// subdomain-style IPFS gateways (<cid>.ipfs.<gateway>). The gateway list is explicit: a substring
// rule such as ".ipfs." would also admit a.ipfs.attacker.example, i.e. any host a stranger controls.
// dweb.link and 4everland.io (path form) answer with a redirect to their subdomain form, which is the
// listed one (4everland.io turns a CIDv0 into its base32 CIDv1 on the way); w3s.link redirects to dweb.link's
// path form (2026-11-10). Every hop passes this allowlist and the SSRF guard (lib/net.mjs).
export const IPFS_SUBDOMAIN_GATEWAYS = ["dweb.link", "nftstorage.link", "w3s.link", "cf-ipfs.com", "4everland.io"];
// The rotation IPFS content is fetched through (DESIGN §11.5: pump.fun's own pinata gateway → ipfs.filebase.io →
// 4everland.io → ipfs.io → dweb.link → gateway.pinata.cloud → w3s.link, in that order). pump.fun's pinata comes first:
// measured on 2026-10-19 it answers in 0.2 s, 200 for everything pump.fun pinned (most coins) and a
// definitive 403 otherwise, while the three public gateways answer 429 within seconds of six
// workers and gateway.pinata.cloud takes ~7 s to resolve a CID. cf-ipfs.com is dead and never tried,
// whichever gateway a creator wrote into the metadata.
// GATEWAY_RULE 2, measured on 2026-11-10 (one request per gateway, 300 ms apart, CIDs whose metadata had failed for
// hours): ipfs.io, dweb.link, gateway.pinata.cloud, w3s.link and nftstorage.link answered 429 on sight (dweb.link with
// Retry-After 900), pump.mypinata.cloud 403, while ipfs.filebase.io answered 200 at once in 31-233 ms and 4everland.io
// with a 301 to <cidv1>.ipfs.4everland.io and then 200, 160-1150 ms in all, for each of the 6 CIDs probed (CIDv0 and
// CIDv1, the JSON with its image); through this rotation 10 more resolved, 10 of 10, all at filebase. So they come
// right after pump's pinata, filebase first (faster, no redirect); the old public gateways
// stay behind them (they may recover; a 429 pauses them, HostPacer). On a CID nobody has, both new ones hang until our
// timeout (FETCH_TIMEOUT_MS) rather than answer 404: see META_DEFER_S.
export const IPFS_GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/", "https://4everland.io/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://w3s.link/ipfs/"];
const ROTATION_HOSTS = new Set(IPFS_GATEWAYS.map((g) => new URL(g).hostname));
// The rotation's gateways that fetch any CID from the network: all but pump's pinata, which serves only what pump.fun pinned.
const PUBLIC_GATEWAY_HOSTS = new Set([...ROTATION_HOSTS].filter((h) => h !== "pump.mypinata.cloud"));
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
  (h) => h === "ipfs.filebase.io" || h === "4everland.io", // path-form entry points added 2026-11-10 (filebase answers there, 4everland redirects to <cid>.ipfs.4everland.io)
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
 * serves a raster type only (an SVG logo as a PNG drawn from it, never the SVG) and caps the size, and
 * only images the API handed out are proxied (api.mjs).
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
 * A metadata uri the fetcher asks for: an allowed https URL (isAllowedMetaUrl), or IPFS content named by the ipfs://
 * scheme, fetched through the gateway rotation (gatewayCandidates: every candidate is an https gateway URL, and each hop
 * passes isAllowedMetaUrl and the SSRF guard). (2026-11-11) Until then an ipfs:// uri was never fetched: 295 coins had
 * no metadata, so no logo, for that alone.
 */
export function isFetchableMetaUri(u) {
  return isAllowedMetaUrl(u) || (/^\s*ipfs:\/\//i.test(String(u ?? "")) && !!ipfsPathOf(u));
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
 * pause (doubling, or the host's Retry-After when longer, up to HOST_RETRY_AFTER_MAX_MS) after it answers
 * 429. `fetchAny` walks the gateway candidates of a URL, asking
 * the gateway whose next free slot comes soonest first (ties keep the rotation order; a slot is taken when it is
 * chosen, so rotations running side by side keep the spacing too), and returns
 * the first OK response. A 403/404/410/5xx or a network error from one gateway moves on to the
 * next; when no gateway served, the last answer is returned (the caller records its status);
 * when every gateway errored, the last error is thrown; null means every candidate is paused or
 * rate-limited (the caller retries later). The answer (or the thrown error) says how the rotation
 * went: `limited` (a gateway answered 429 or was paused), `transient` (that, or a 5xx, a timeout, a
 * network error, the spent budget, or names that did not resolve when all candidates or two of the
 * rotation's own gateways failed that way: a "no" from pump's pinata does not mean the public gateways
 * lack the file, and two gateways do not vanish together) and, with more than one candidate, `summary`
 * ("403 pump.mypinata.cloud; 429 ipfs.io; timeout dweb.link"), the text a caller stores as its error. A null
 * answer carries none of that, so a caller that passes `out` (an object) finds `limited`, `transient` and
 * `summary` there whenever the rotation did not serve.
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
  async fetchAny(url, init = {}, { allow = () => true, timeoutMs = FETCH_TIMEOUT_MS, budgetMs = FETCH_BUDGET_MS, out = null } = {}) {
    const pending = gatewayCandidates(url).map((candidate) => ({ candidate, host: new URL(candidate).hostname }));
    const deadline = Date.now() + budgetMs;
    const notes = []; // "<status|429|timeout|net|ENOTFOUND|paused|budget> <host>" per candidate, in the order they were asked
    let limited = false, soft = false, last = null, lastError = null;
    while (pending.length) {
      const now = Date.now();
      let best = -1, bestWait = Infinity;
      for (let i = 0; i < pending.length; i++) {
        const { host } = pending[i];
        if ((this.pausedUntil.get(host) ?? 0) > now) continue;
        const wait = Math.max(0, (this.lastAt.get(host) ?? 0) + this.spacingMs - now);
        if (wait < bestWait) { best = i; bestWait = wait; }
      }
      if (best < 0) { limited = true; for (const p of pending) notes.push(`paused ${p.host}`); break; } // every remaining gateway is pausing
      const [next] = pending.splice(best, 1), { candidate, host } = next;
      // The slot is taken before the wait (repair 2026-11-11): rotations running side by side (six workers, eight downloads)
      // that chose this host see it busy and queue behind it or ask another gateway, where they all slept the same wait and
      // fired together (10-20 requests a second to one gateway, not the 5 HOST_SPACING_MS allows).
      this.lastAt.set(host, now + bestWait);
      if (bestWait > 0) {
        await this.sleep(bestWait);
        // a rotation beside this one may have met a 429 from it meanwhile: back in line, asked only if its pause ends in time
        if ((this.pausedUntil.get(host) ?? 0) > Date.now()) { pending.splice(best, 0, next); continue; }
      }
      const left = deadline - Date.now();
      if (left <= 0) { lastError ??= new Error(`gateway budget of ${budgetMs} ms spent`); soft = true; for (const h of [host, ...pending.map((p) => p.host)]) notes.push(`budget ${h}`); break; }
      const timeout = AbortSignal.timeout(Math.min(timeoutMs, left));
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      this.lastAt.set(host, Math.max(this.lastAt.get(host) ?? 0, Date.now())); // a later slot another rotation took stays taken
      let hit;
      try { hit = await guardedFetch(candidate, { ...init, signal }, { allow, guard: this.guard, fetchImpl: this.fetch }); }
      catch (e) {
        lastError = e; const tag = errorTag(e); notes.push(`${tag} ${host}`); if (tag !== "ENOTFOUND") soft = true;
        if (pending.length) this.stats.rotated++;
        continue;
      }
      if (hit.res.status === 429) {
        const ms = Math.min(120_000, (this.backoff.get(host) ?? HOST_PAUSE_MS / 2) * 2);
        const asked = Math.min(HOST_RETRY_AFTER_MAX_MS, retryAfterMs(hit.res.headers?.get?.("retry-after")));
        this.backoff.set(host, ms); this.pausedUntil.set(host, Date.now() + Math.max(ms, asked));
        notes.push(`429 ${host}`); limited = true; continue;
      }
      this.backoff.delete(host);
      if (hit.res.ok) return hit;
      notes.push(`${hit.res.status} ${host}`); if (softStatus(hit.res.status)) soft = true;
      last = hit;
      if (!pending.length) break;
      // One gateway's 403/404/410/5xx is not final: the next may hold the content.
      try { hit.res.body?.cancel?.(); } catch { /* nothing to drain */ }
      this.stats.rotated++;
    }
    const summary = notes.length > 1 ? notes.join("; ") : null;
    // A name that does not resolve is not soft by itself (a lone dead host; its callers count the repeats), but every
    // candidate failing that way, or two of the rotation's own gateways, is our resolver: temporary (dnsTrouble).
    if (summary && dnsTrouble(summary)) soft = true;
    if (out) Object.assign(out, { limited, transient: limited || soft, summary });
    if (last) return Object.assign(last, { limited, transient: limited || soft, summary });
    if (limited) return null;
    if (lastError) { try { Object.assign(lastError, { transient: soft, summary }); } catch { /* a frozen reason: thrown as it is */ } throw lastError; }
    return undefined;
  }
}
/** A Retry-After header in ms (delta seconds or an HTTP date); 0 when absent, unreadable or past. */
function retryAfterMs(h, now = Date.now()) {
  const s = String(h ?? "").trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}
/** How a failed gateway attempt is named in a rotation summary: a timeout, an unresolvable host, or any other network error. */
function errorTag(e) {
  const m = String(e?.message ?? e);
  return /timeout|timed out|aborted/i.test(m) || e?.name === "TimeoutError" ? "timeout" : /\bENOTFOUND\b/.test(m) ? "ENOTFOUND" : "net";
}

/**
 * Metadata fetcher: `request(uri)` enqueues (deduplicated), `concurrency` workers fetch, results
 * land in the model (and sqlite through it). API-driven requests jump the queue (one already waiting
 * is lifted to its head) so a coin page fills within a second. `start()` adds the background sweep
 * (DESIGN §11.5): every tracked coin
 * whose JSON is missing, stale or due for a retry is queued, biggest locked value first, then
 * newest, so the map's labels and logos fill from the top. Failures are stored with an attempt
 * count and retried on a doubling backoff (15 min → 24 h; metaRetryS: at most 3 h for the first
 * temporary failures, weekly for a non-IPFS host that answered 404/410 or did not resolve
 * META_DEAD_AFTER times in a row, counted in `deadStreak`); a rotation
 * whose gateways said no while others were rate-limited, and in which no public gateway looked for the
 * file, is requeued like a rate-limited one, and stored with its per-gateway summary when that does not
 * help: a deferral (isGatewayDeferral: a run of them counts at most META_DEFER_CAP, asked again within the
 * hour); one in which a public gateway looked is stored at once, a temporary failure. A uri whose last
 * failure was a deferral is stored at once (each requeue would ask pump's
 * pinata again, thousands of times over for a backlog). A uri that once resolved keeps its
 * image when a later re-read fails. Everything here is HTTP to gateways, never the RPC.
 */
export class MetaFetcher {
  constructor(model, { concurrency = 6, log = console, fetchImpl = pinnedFetch, pacer, sweepMs = 60_000, now = Date.now } = {}) {
    this.model = model; this.log = log; this.now = now; this.sweepMs = sweepMs;
    this.pacer = pacer ?? new HostPacer({ fetchImpl });
    this.concurrency = concurrency; this.active = 0;
    this.queue = []; this.head = 0; this.queued = new Set(); this.inFlight = new Set(); this.attempts = new Map();
    this.recheck = new Set();       // uris due once more whatever their age (META_IMAGE_RULE, GATEWAY_RULE); each leaves when fetched
    this.stats = { fetched: 0, failed: 0, failedTransient: 0, deferred: 0, rateLimited: 0, sweeps: 0 };
    this.stopped = false; this.timer = null; this.coverageCache = null;
  }
  /** Uris waiting in the queue plus the ones being fetched right now. */
  get pendingCount() { return this.queue.length - this.head + this.inFlight.size; }
  needsFetch(uri, nowS = Math.floor(this.now() / 1000)) {
    const m = this.model.meta.get(uri);
    if (!m || this.recheck.has(uri)) return true;
    const age = nowS - m.fetchedAt;
    if (m.ok) return age > (m.image ? META_TTL_S : META_NOIMAGE_TTL_S);
    return age > metaRetryS(uri, m);
  }
  request(uri, { front = false } = {}) {
    if (typeof uri !== "string" || this.inFlight.has(uri)) return;
    if (this.queued.has(uri)) {
      // waiting already (a sweep or a plain request put it at the back): an urgent ask (a coin page, a young coin) lifts it
      // to the head (repair 2026-11-11: behind a restart's backlog of thousands of due retries it waited minutes)
      if (front) { const i = this.queue.indexOf(uri, this.head); if (i > this.head) { this.queue.splice(i, 1); this.queue.splice(this.head, 0, uri); } }
      return;
    }
    if (!isFetchableMetaUri(uri) || !this.needsFetch(uri)) return;
    this.queued.add(uri);
    if (front) this.queue.splice(this.head, 0, uri); else this.queue.push(uri);
    this.#pump();
  }
  /**
   * Queues every tracked coin's uri that needs a (re)fetch, ordered by locked value then recency;
   * returns how many were added. At once: the boot sweep and tests; the timer runs sweepAsync.
   */
  sweep({ max = 50_000 } = {}) { return drain(this.#sweepGen(max, false)); }
  /**
   * sweep() on the shared scheduler (sliced.mjs): the pass over every coin (a URL parse each) held the loop 0.5-0.9 s
   * once a minute on the local index (228k coins, Nov 13 2026). One at a time; resolves with how many were queued.
   */
  sweepAsync({ max = 50_000 } = {}) {
    this.sweepJob ??= runSliced(this.#sweepGen(max, true)).then((run) => run.value).finally(() => { this.sweepJob = null; });
    return this.sweepJob;
  }
  sweepJob = null;
  *#sweepGen(max, shared) {
    if (this.stopped || !this.model.coins) return 0;
    const nowS = Math.floor(this.now() / 1000);
    const d = typeof this.model.computed === "function" ? this.model.computed() : new Map();
    // a uri queued, fetched or answered while the pass was spread over turns is checked again before it is queued
    const due = (uri) => typeof uri === "string" && !this.queued.has(uri) && !this.inFlight.has(uri) && isFetchableMetaUri(uri) && this.needsFetch(uri, nowS);
    const cands = [];
    let i = 0;
    for (const c of this.model.coins.values()) {
      if ((++i & 1023) === 0) { yield; if (this.stopped) return 0; }
      if (!c.tracked) continue;
      const uri = this.model.mints?.get(c.mint)?.uri;
      if (due(uri)) cands.push({ uri, locked: d.get(c.mint)?.lockedUsd ?? -1, at: c.createdAt ?? 0 });
    }
    // The listed quote assets the map draws at the top of their families (PUMP, USDC, $baton…) need logos too.
    const fam = typeof this.model.assetFamiliesStep === "function" ? yield* this.model.assetFamiliesStep({ shared })
      : typeof this.model.assetFamilies === "function" ? this.model.assetFamilies() : new Map();
    if (this.stopped) return 0;
    for (const mint of fam.keys()) {
      const uri = this.model.mints?.get(mint)?.uri;
      if (due(uri)) cands.push({ uri, locked: Number.MAX_SAFE_INTEGER, at: 0 });
    }
    cands.sort((a, b) => b.locked - a.locked || b.at - a.at);
    let n = 0;
    for (const x of cands) { if (n >= max || this.queued.has(x.uri) || this.inFlight.has(x.uri) || !this.needsFetch(x.uri, nowS)) continue; this.queued.add(x.uri); this.queue.push(x.uri); n++; }
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
  /**
   * One-time re-check after the gateway rotation grew (GATEWAY_RULE): every failed row of IPFS content whose error is
   * temporary (isTransientError: a rate limit, a pause, a timeout ... under the old rotation, deferrals included) becomes
   * due at once, in the sweep's usual order, whatever its backoff; a definitive "no" from every gateway keeps its wait.
   * The old rule counted every rotation in which no public gateway looked as a failed attempt (up to 8 on 2026-11-10):
   * a row whose error is such a deferral keeps at most META_DEFER_CAP of that count (persisted), so the next real answer
   * climbs the backoff from there (2 h), not from a day; afterwards a deferral never lowers a count (MetaFetcher fail).
   * Gated by a kv record like queueImageRecheck. Returns how many uris were queued.
   */
  queueGatewayRecheck() {
    const db = this.model.db;
    if (typeof db?.kvGet !== "function" || typeof db?.kvSet !== "function") return 0;
    if (Number(db.kvGet("metaGatewayRule", 1)) >= GATEWAY_RULE) return 0;
    let n = 0;
    const inflated = [];
    for (const [uri, m] of this.model.meta ?? []) {
      if (!m || m.ok || !ipfsPathOf(uri) || !isTransientError(m.error)) continue;
      this.recheck.add(uri); n++;
      if ((m.attempts ?? 0) > META_DEFER_CAP && isGatewayDeferral(uri, m.error)) inflated.push(uri);
    }
    const cap = () => { for (const uri of inflated) this.model.setMeta(uri, { ...this.model.meta.get(uri), attempts: META_DEFER_CAP }); };
    if (inflated.length && typeof this.model.setMeta === "function") { if (typeof db.transaction === "function") db.transaction(cap); else cap(); }
    this.log.info?.(`meta: gateway recheck queued ${n}`);
    if (inflated.length) this.log.info?.(`meta: gateway rule ${GATEWAY_RULE}: ${inflated.length} retry counts of rotations no public gateway looked at brought down to ${META_DEFER_CAP}`);
    db.kvSet("metaGatewayRule", GATEWAY_RULE);
    return n;
  }
  /**
   * Starts the periodic sweep: the first one right away (after the one-time re-checks are queued), at once or, with
   * `slicedBoot` (the server: it is already answering requests), on the shared scheduler like the later ones (sweepAsync),
   * so the pass over every coin never holds the event loop (~0.8 s on the local index).
   */
  start({ sweepMs = this.sweepMs, slicedBoot = false } = {}) {
    try { this.queueImageRecheck(); } catch (e) { this.log.warn?.(`meta: image recheck failed: ${e.message}`); }
    try { this.queueGatewayRecheck(); } catch (e) { this.log.warn?.(`meta: gateway recheck failed: ${e.message}`); }
    if (slicedBoot) this.sweepAsync().catch((e) => this.log.warn?.(`meta: sweep failed: ${e.message}`));
    else try { this.sweep(); } catch (e) { this.log.warn?.(`meta: sweep failed: ${e.message}`); }
    this.timer = setInterval(() => { this.sweepAsync().catch((e) => this.log.warn?.(`meta: sweep failed: ${e.message}`)); }, sweepMs);
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
      const prev = this.model.meta.get(uri), kind = metaFailKind(uri, error), had = prev?.attempts ?? 0;
      // a deferral (no public gateway looked) is no failed attempt: a run of them counts up to META_DEFER_CAP, so it waits
      // minutes (metaDeferS), and it never takes back what real failures counted (bringing an unpinned CID's timeouts down
      // to the cap would restart its climb at 2 h); counts the old rule inflated are capped at boot
      const attempts = kind === "deferred" ? Math.max(had, Math.min(had + 1, META_DEFER_CAP)) : had + 1;
      // consecutive "dead" answers (404/410, does not resolve): the weekly wait needs META_DEAD_AFTER of them in a row
      const deadStreak = kind === "dead" ? (prev?.deadStreak ?? 0) + 1 : 0;
      // A uri that resolved before keeps what it had (the logo stays on the map); only a uri that
      // never resolved is stored empty. Either way the attempt count drives the next retry.
      if (prev?.ok) this.model.setMeta(uri, { ...prev, fetchedAt, error, attempts, deadStreak });
      else this.model.setMeta(uri, { image: null, description: null, twitter: null, telegram: null, website: null, fetchedAt, ok: false, error, attempts, deadStreak });
      this.stats.failed++; if (isTransientError(error)) this.stats.failedTransient++; if (kind === "deferred") this.stats.deferred++;
      this.attempts.delete(uri); this.recheck.delete(uri);
    };
    // Our own metadata host: the file is on disk, so no request (this machine may not even reach the domain).
    const local = localMetaFile(uri);
    if (local) {
      try {
        const meta = pickMeta(JSON.parse(readFileSync(local.file, "utf8")));
        this.model.setMeta(uri, { ...meta, fetchedAt, ok: true, error: null, attempts: 0, deadStreak: 0 });
        this.stats.fetched++; this.attempts.delete(uri); this.recheck.delete(uri);
        return;
      } catch { /* unreadable locally: fall through to the network */ }
    }
    try {
      const out = {};
      const hit = await this.pacer.fetchAny(uri, { headers: { accept: "application/json" } }, { allow: isAllowedMetaUrl, out });
      if (hit === null || (hit && !hit.res?.ok && hit.limited)) {
        // Every gateway is pausing, or the ones that answered said no while others were rate-limited (pump's
        // pinata answers 403 for whatever it did not pin; the public gateways may well hold it): retry later,
        // at the back of the queue, a few times, then store the rotation's summary: a deferral when no public
        // gateway looked, else a temporary failure. Only a rotation nobody looked in is requeued: a public gateway
        // that timed out or answered has looked, and asked again 10 s later on a CID nobody has it would hold a
        // worker ~20 s per rotation, four rotations per stored failure. A uri whose last failure was a
        // deferral is stored at once.
        this.stats.rateLimited++;
        const prev = this.model.meta.get(uri), summary = hit?.summary ?? out.summary;
        const n = (this.attempts.get(uri) ?? 0) + 1; this.attempts.set(uri, n);
        const unlooked = summary ? isGatewayDeferral(uri, summary) : hit === null;
        if (n <= 3 && unlooked && !(prev && !prev.ok && metaFailKind(uri, prev.error) === "deferred")) { setTimeout(() => { if (!this.stopped && !this.queued.has(uri) && !this.inFlight.has(uri)) { this.queued.add(uri); this.queue.push(uri); this.#pump(); } }, HOST_PAUSE_MS).unref(); return; }
        return fail(summary ? summary.slice(0, 200) : "HTTP 429");
      }
      if (!hit?.res?.ok) throw Object.assign(new Error(`HTTP ${hit?.res?.status ?? "?"}`), { summary: hit?.summary ?? null });
      const body = await readBounded(hit.res, META_MAX_BYTES);
      const meta = pickMeta(JSON.parse(body.toString("utf8")));
      this.model.setMeta(uri, { ...meta, fetchedAt, ok: true, error: null, attempts: 0, deadStreak: 0 });
      this.stats.fetched++; this.attempts.delete(uri); this.recheck.delete(uri);
    } catch (e) {
      // a rotation's per-gateway summary says more than its last answer ("403 pump.mypinata.cloud; timeout ipfs.io; …")
      fail(String(e?.summary || e?.message || e).slice(0, 200));
    }
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}

export const IMAGE_CACHE_MAX_BYTES = 512 * 1024 * 1024;
/**
 * Thumbnails have their own disk budget (IMG_THUMB_MB): ~9 KB each at 64 px (measured 2026-11-10 on the local
 * index: 44k logos in 378 MB), so 2 GB holds ~230k logos, every coin of a full index. A thumbnail is kept for
 * good once made, whatever its age (its url names the image: IPFS content never changes, and a coin with a new
 * logo has a new url); only this budget evicts, least recently served first.
 */
export const THUMB_CACHE_MAX_BYTES = 2048 * 1024 * 1024;
/** A thumbnail served (or made) within this long is never evicted: the budget overruns (with a warning) rather than drop what the map is showing. */
export const THUMB_KEEP_MS = 24 * 3600_000;
/** A served thumbnail's mtime is moved to the serving time at most this often: the mtime carries "last served" across restarts. */
export const THUMB_TOUCH_MS = 6 * 3600_000;
/**
 * First sight (a new coin's logo, the one the map has not got) makes thumbnails only below this share of the budget,
 * and may evict thumbnails nobody was served or made within THUMB_FRESH_IDLE_MS, least recently used first, down to
 * 90 % of the budget. The warm pass never evicts and stops lower, at THUMB_WARM_FILL: the 85-95 % band is first sight's
 * reserve, so the room an eviction frees goes to the next new coins instead of being refilled by the warm pass (which
 * drained ~11k idle thumbnails per new coin when both stopped at 95 %). What background work could not make is logged
 * (#bgFull).
 */
export const THUMB_BG_FILL = 0.95;
export const THUMB_WARM_FILL = 0.85;
export const THUMB_FRESH_IDLE_MS = 30 * 24 * 3600_000;
/** At most one "thumbnail budget full" warning per this long, with the counts of what was refused meanwhile. */
export const THUMB_FULL_WARN_MS = 10 * 60_000;
/** GET /api/logo-sheet answers within this many ms of the request start with whatever thumbnails landed. */
export const SHEET_BUDGET_MS = 400;
/** ... unless NOTHING landed by then (a cold family): then it waits up to this long for the first thumbnails. */
export const SHEET_WAIT_MS = 1500;
/** ImageCache.warm: a pass stops after this long; the next pass resumes where it stopped (`resume`). */
export const WARM_MAX_MS = 20 * 60_000;
export const SHEET_CELL = 64;
/**
 * The failure memory of the image proxy (sqlite `img_fail`, so a restart does not download the dead again).
 * A temporary failure (429 or every gateway pausing, 5xx, a timeout, a network error, gateways that mixed a "no"
 * with any of those, a rotation whose gateways did not resolve) waits IMG_TEMP_RETRY_MS, doubling per failure: the
 * first IMG_TEMP_SHORT_TRIES waits stay within IMG_TEMP_RETRY_MAX_MS, later ones grow on to IMG_TEMP_LONG_MAX_MS (a
 * day: an unpinned CID is not asked 170 times a week), and it answers 503 with a short Retry-After (a pending
 * sheet cell) all along. A permanent one (404/410 and the other definitive 4xx, not an image, too large, an SVG
 * that cannot be drawn: "svg: ...", ImageCache #rasterize) waits IMG_GONE_RETRY_MS by failure count (an hour, a day, then a week each time, so a file that appears late is not
 * lost for a week) and answers 404 (a dead cell). A lone host that does not resolve is temporary (our DNS may be
 * down) until it failed that way IMG_DNS_GONE_AFTER times in a row, then permanent; its temporary waits are at
 * least IMG_DNS_RETRY_MS, doubling (15 min, then 30), so the third miss comes at least 45 min after the first and a
 * short local DNS outage does not kill the logo. A logo that downloads but cannot be drawn ("nothumb") waits
 * IMG_NOTHUMB_RETRY_MS (its original is still served). `attempts` counts the failures in a row of one run: a kind,
 * with a lone host's "does not resolve" a temporary run of its own. A permanent failure counts apart
 * (`goneAttempts`, repair 2026-11-10): the permanent failures since the last success, which a temporary one in
 * between does not reset, so a url that alternates 404 and 502 still reaches the weekly wait (counted per run it
 * was asked ~330 times a week); three temporary failures and then a 404 are still a first 404 (an hour). A
 * temporary failure that is a deferral (isGatewayDeferral: no public gateway looked for the file, 2026-11-10)
 * counts up to IMG_DEFER_CAP in a run of them and never takes back what real failures counted (2026-11-11), and it
 * waits by the capped count: minutes (1, 2, 4, then 8, plus up to half of that as a jitter fixed per url), never the day.
 */
export const IMG_TEMP_RETRY_MS = 60_000;
export const IMG_TEMP_RETRY_MAX_MS = 3600_000;
export const IMG_TEMP_SHORT_TRIES = 6;
export const IMG_TEMP_LONG_MAX_MS = 24 * 3600_000;
export const IMG_DEFER_CAP = 4;
export const IMG_DNS_GONE_AFTER = 3;
export const IMG_DNS_RETRY_MS = 15 * 60_000;
export const IMG_GONE_RETRY_MS = [3600_000, 24 * 3600_000, 7 * 24 * 3600_000];
/** How long a temporary failure that came `attempts` times in a row waits (1, 2, 4 … 32 min, then 64 min … up to a day). */
export const imgTempWaitMs = (attempts) => Math.min(attempts <= IMG_TEMP_SHORT_TRIES ? IMG_TEMP_RETRY_MAX_MS : IMG_TEMP_LONG_MAX_MS, IMG_TEMP_RETRY_MS * 2 ** Math.min(Math.max(0, attempts - 1), 20));
export const IMG_NOTHUMB_RETRY_MS = 7 * 24 * 3600_000;
/** Retry-After of the 503 for a temporarily failed image: the wait left, at most this. */
export const IMG_RETRY_AFTER_MAX_S = 300;
/** Rows past their retry time by this much are forgotten (the attempt count that grows their wait goes with them). */
export const IMG_FAIL_FORGET_MS = 30 * 24 * 3600_000;
/** What the thumbnail renderer can draw; "nothumb" rows recorded under an older rule are retried at boot (2: an animated webp gives its first frame). */
export const THUMB_RULE = 2;
/** The image worker died this many times in a row rendering one logo: it is recorded as one that cannot be drawn ("nothumb"). */
export const THUMB_CRASHES_MAX = 2;
/** First sight (enqueueThumb): at most this many urls wait (the warm pass catches the rest), this many are worked at a time. */
export const FRESH_MAX = 20_000;
export const FRESH_CONCURRENCY = 2;
/** Who a download or a render is for, most urgent first: an on-demand request, a first-sight thumbnail, the warm pass. */
export const PRIO_FG = 0, PRIO_FRESH = 1, PRIO_WARM = 2;
const THUMB_NAME_RE = /\.w\d+\.png$/;

/** A download failure that knows its kind ("gone" | "temp"). */
const failure = (kind, message) => Object.assign(new Error(message), { kind });
const inflaters = { gzip: promisify(zlib.gunzip), deflate: promisify(zlib.inflate), deflateRaw: promisify(zlib.inflateRaw), br: promisify(zlib.brotliDecompress) };
/**
 * `body` decoded from its Content-Encoding (gzip, deflate or br: some hosts send a stored encoding whatever was asked,
 * and pinnedFetch hands the bytes over as they came) into at most `cap` bytes; past it a permanent failure (`tooLarge`).
 * A body not in that coding (a fetch layer that decoded it already, a wrong header) or in a coding not read here is
 * returned as it is: the sniff decides.
 */
async function decodedBody(body, coding, cap, tooLarge) {
  const tries = coding === "gzip" || coding === "x-gzip" ? (body[0] === 0x1f && body[1] === 0x8b ? [inflaters.gzip] : [])
    : coding === "deflate" ? [inflaters.deflate, inflaters.deflateRaw] // zlib-wrapped as the spec says, or raw as some servers send it
      : coding === "br" ? [inflaters.br] : [];
  for (const inflate of tries) {
    try { return await inflate(body, { maxOutputLength: cap }); }
    catch (e) { if (e?.code === "ERR_BUFFER_TOO_LARGE") throw failure("gone", tooLarge); }
  }
  return body;
}
/**
 * "temp", "gone" or "dns" for an error the rotation threw (every candidate failed on the network): a refused address,
 * a TLS or redirect fault are not going to heal by themselves; a lone host that does not resolve is "dns" (#fail makes
 * it temporary until it happened IMG_DNS_GONE_AFTER times in a row), several are our resolver (isTransientError).
 */
function thrownKind(e) {
  if (e?.summary) return isTransientError(e.summary) ? "temp" : "gone";
  const m = String(e?.message ?? e);
  if (isTransientError(m)) return "temp";
  if (isDnsMiss(m)) return "dns";
  if (/^refusing |^blocked url|too many redirects|certificate|altnames|https only|EPROTO|SSL/i.test(m)) return "gone";
  return "temp";
}
/** The run a failure belongs to (its attempts count within it): its kind, with a lone host's "does not resolve" a temporary run of its own. */
const failRun = (kind, error) => (kind === "temp" && isDnsMiss(error) ? "dns" : kind);

/** How often ImgWork samples the process's memory while a worker holds jobs (resvg grew by up to 3.5 GB/s: tens of MB between samples). */
export const WORKER_MEM_POLL_MS = 10;
/**
 * The thread image work runs on (lib/img-worker.mjs): one worker, jobs answered in order, buffers
 * handed over rather than copied, respawned when it dies (the jobs in flight fail once, as transient).
 * `{ inline: true }` runs the same functions on the calling thread, which tests use and the cache
 * falls back to when a worker cannot be spawned or keeps crashing. Without it every thumbnail render
 * (8-80 ms), sheet composition (50-120 ms) and share card (35-110 ms) would block the event loop,
 * i.e. SSE and the indexer. An SVG logo (`svg`) is never drawn inline: it has a deadline
 * (SVG_DRAW_MAX_MS from the moment the worker takes it up), and a drawing past it ends the worker,
 * the only way to stop resvg; the job fails for good, the jobs queued behind it fail once as transient,
 * and the next job starts a fresh worker. The verdict waits one turn of the loop, so an answer that
 * came in while the loop was held (and is only waiting to be read) wins over the timer. Every job, whatever
 * its op, is watched the same way for memory: while a worker holds jobs, the process's RSS is sampled every
 * WORKER_MEM_POLL_MS, and a rise past `jobMaxBytes` (WORKER_JOB_MAX_BYTES) since the job began ends the
 * worker; resvg's own memory in a worker is capped besides (RESVG_MEMORY_MAX_BYTES), which holds while the
 * loop is too busy to sample. A worker that trapped inside resvg or whose wasm memory grew past
 * WORKER_RECYCLE_BYTES is replaced as soon as it is idle (new jobs go to a fresh one meanwhile).
 * None of these counts as the worker dying, so none can push the work inline; each is logged and counted
 * (`stats`, in /api/health as images.work).
 */
export class ImgWork {
  constructor({ inline = false, log = console, svgMaxMs = SVG_DRAW_MAX_MS, recycleBytes = WORKER_RECYCLE_BYTES, jobMaxBytes = WORKER_JOB_MAX_BYTES, resvgMaxBytes = RESVG_MEMORY_MAX_BYTES } = {}) {
    this.inline = inline; this.log = log; this.svgMaxMs = svgMaxMs; this.recycleBytes = recycleBytes; this.jobMaxBytes = jobMaxBytes; this.resvgMaxBytes = resvgMaxBytes;
    this.worker = null; this.pending = new Map(); this.seq = 0; this.closed = false;
    this.retiring = new Set(); // workers being replaced: they finish what they hold, take nothing new and are ended (not a crash)
    this.memBase = new Map(); this.memTimer = null; // busy worker → the memory sample its current job began at (#watch)
    this.stats = { jobs: 0, failed: 0, restarts: 0, inline: inline ? 1 : 0, overtime: 0, overMemory: 0, recycled: 0 };
  }
  #spawn() {
    try {
      // a worker refuses most process-level node flags (the test runner alone passes a dozen), so only the warning switches carry over
      const execArgv = process.execArgv.filter((a) => /^(--disable-warning=|--no-warnings)/.test(a));
      const w = new Worker(new URL("./img-worker.mjs", import.meta.url), { workerData: { role: "img", recycleBytes: this.recycleBytes, resvgMaxBytes: this.resvgMaxBytes }, execArgv });
      // every event names its worker: an old one ending late must not touch the jobs of the one that replaced it
      w.on("message", (m) => this.#onMessage(w, m));
      w.on("error", (e) => this.#gone(w, e));
      w.on("exit", (code) => this.#gone(w, new Error(`image worker exited (${code})`)));
      w.unref(); // idle, it never keeps the process alive; ref'd while jobs wait
      this.worker = w;
      return w;
    } catch (e) {
      this.log.warn?.(`img work: cannot start a worker thread (${e.message}); rendering inline`);
      this.inline = true; this.stats.inline = 1;
      return null;
    }
  }
  #busy(w) { for (const p of this.pending.values()) if (p.w === w) return true; return false; }
  /** The id of the job worker `w` is running (they are answered in the order they were posted), or 0. */
  #current(w) { for (const [id, p] of this.pending) if (p.w === w) return id; return 0; }
  /** What the watchdog compares: the process's RSS, and this thread's own heap and buffers (a rise of those is not the worker's). */
  static #sample() { const m = process.memoryUsage(); return { rss: m.rss, own: m.heapTotal + m.external }; }
  /** Worker `w` starts a job (it was idle, or answered the one before): the memory it may grow by counts from here. */
  #watch(w) {
    if (!(this.jobMaxBytes > 0)) return;
    this.memBase.set(w, ImgWork.#sample());
    if (!this.memTimer) { this.memTimer = setInterval(() => this.#sampleMemory(), WORKER_MEM_POLL_MS); this.memTimer.unref?.(); }
  }
  #unwatch(w) {
    this.memBase.delete(w);
    if (!this.memBase.size && this.memTimer) { clearInterval(this.memTimer); this.memTimer = null; }
  }
  #sampleMemory() {
    const now = ImgWork.#sample();
    for (const [w, base] of this.memBase) {
      const rise = now.rss - base.rss - Math.max(0, now.own - base.own);
      // the verdict waits a turn of the loop: an answer already in (the loop was held) wins, as for a deadline
      if (rise > this.jobMaxBytes) { const id = this.#current(w); setImmediate(() => this.#overMemory(w, id)); }
    }
  }
  /**
   * Job `id` grew the process past `jobMaxBytes` while worker `w` ran it: the worker is ended at once and the job fails for
   * good (`memory`), the jobs queued behind it once, as transient. When another worker was busy too (one being replaced),
   * which of them grew cannot be told: all of them are ended and every job they held fails once, as transient.
   */
  #overMemory(w, id) {
    const p = this.pending.get(id);
    if (!p || p.w !== w) return; // answered meanwhile
    const mb = Math.round(this.jobMaxBytes / 2 ** 20), others = [...this.memBase.keys()].filter((x) => x !== w);
    this.stats.overMemory++;
    this.log.warn?.(`img work: a ${p.op} job grew the process past ${mb} MB; ${others.length ? "the busy workers are" : "its worker is"} ended and replaced`);
    if (!others.length) {
      this.pending.delete(id); clearTimeout(p.timer); this.stats.failed++;
      p.reject(Object.assign(new Error(p.op === "svg" ? `svg: drawing it took over ${mb} MB of memory` : `${p.op}: it took over ${mb} MB of memory`), { memory: true }));
    }
    for (const x of [w, ...others]) { this.#unwatch(x); this.#retire(x, true, `a job grew the process past ${mb} MB`); }
  }
  /** Worker `w` died or was ended: its jobs fail once, as transient; a death of its own (not a retirement, not close) counts as a restart. */
  #gone(w, err) {
    const retired = this.retiring.delete(w), current = this.worker === w;
    if (current) this.worker = null;
    this.#unwatch(w);
    const dropped = [];
    for (const [id, p] of this.pending) if (p.w === w) { dropped.push(p); this.pending.delete(id); }
    if (current && !retired && !this.closed) {
      this.stats.restarts++; this.log.warn?.(`img work: ${err.message}; ${dropped.length} jobs dropped, worker restarts on the next job`);
      if (this.stats.restarts > 5 && !this.inline) { this.inline = true; this.stats.inline = 1; this.log.warn?.("img work: worker keeps dying, rendering inline from now on"); }
    }
    for (const p of dropped) { clearTimeout(p.timer); const e = new Error(`image worker failed: ${err.message}`); e.transient = true; p.reject(e); }
  }
  /** Takes `w` out of service (`why`, logged): new jobs go to a fresh worker; `w` is ended at once (`now`), else once it holds no job. */
  #retire(w, now, why) {
    if (this.worker === w) this.worker = null;
    if (!this.retiring.has(w)) { this.retiring.add(w); this.stats.recycled++; this.log.info?.(`img work: worker replaced (${why}); ${this.stats.recycled} so far`); }
    if (now || !this.#busy(w)) w.terminate().catch(() => {});
  }
  /** A drawing ran past its deadline: it fails for good and its worker is ended (resvg cannot be interrupted otherwise). */
  #overtime(w, id) {
    const p = this.pending.get(id);
    if (!p || p.w !== w) return; // answered meanwhile
    this.pending.delete(id); this.stats.overtime++; this.stats.failed++;
    this.log.warn?.(`img work: a drawing ran past ${p.deadlineMs} ms; its worker is ended and replaced`);
    p.reject(Object.assign(new Error(`svg: drawing it took over ${p.deadlineMs} ms`), { overtime: true }));
    this.#unwatch(w);
    this.#retire(w, true, `a drawing ran past ${p.deadlineMs} ms`);
  }
  #onMessage(w, m) {
    const p = this.pending.get(m.id);
    if (!p || p.w !== w) return;
    // the verdict waits a turn of the loop (setImmediate): when the loop was held past the deadline, the timer fires before
    // the poll phase reads an answer that came in meanwhile, which is to win
    if (m.started) { if (p.deadlineMs > 0) { p.timer = setTimeout(() => setImmediate(() => this.#overtime(w, m.id)), p.deadlineMs); p.timer.unref?.(); } return; }
    this.pending.delete(m.id); clearTimeout(p.timer);
    if (this.#busy(w)) this.#watch(w); else this.#unwatch(w); // the worker takes up its next job at once
    if (m.recycle) this.#retire(w, false, m.recycle === "trap" ? "it trapped inside resvg" : `its wasm memory is over ${Math.round(this.recycleBytes / 2 ** 20)} MB`);
    else if (this.retiring.has(w) && !this.#busy(w)) w.terminate().catch(() => {});
    if (!this.#busy(w)) w.unref();
    if (m.ok) p.resolve({ bytes: m.bytes ? Buffer.from(m.bytes.buffer, m.bytes.byteOffset, m.bytes.byteLength) : null, type: m.type, failed: m.failed ?? [] });
    else { this.stats.failed++; p.reject(new Error(m.error)); }
  }
  async #run(msg, transfer, { deadlineMs = 0, inlineOk = true } = {}) {
    this.stats.jobs++;
    if (!this.inline && !this.closed) {
      const w = this.worker ?? this.#spawn();
      if (w) return new Promise((resolve, reject) => {
        const id = ++this.seq, idle = !this.#busy(w);
        this.pending.set(id, { resolve, reject, w, op: msg.op, deadlineMs, timer: null });
        if (idle) this.#watch(w);
        w.ref();
        try { w.postMessage({ id, ...msg, deadlineMs }, transfer); } catch (e) { this.pending.delete(id); if (!this.#busy(w)) { w.unref(); this.#unwatch(w); } reject(e); }
      });
    }
    if (!inlineOk) throw Object.assign(new Error("no image worker to draw it on"), { transient: true, noWorker: true });
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
  /**
   * PNG bytes of a downloaded SVG logo drawn into SVG_RASTER_PX (rasterizeSvg in img-worker.mjs), on the worker only and
   * within `svgMaxMs` (SVG_DRAW_MAX_MS) of the worker taking it up; throws why it cannot be drawn (`overtime` past the deadline,
   * `transient` when the worker died under it, `noWorker` when there is none: inline it could hold the loop for minutes).
   */
  async svg({ bytes }) {
    if (this.closed) throw Object.assign(new Error("no image worker to draw it on"), { transient: true, noWorker: true });
    const u8 = own(bytes);
    const r = await this.#run({ op: "svg", bytes: u8 }, [u8.buffer], { deadlineMs: this.svgMaxMs, inlineOk: false });
    return r.bytes;
  }
  /** Ends the worker; later jobs run inline (the shutdown path may still serve a request or two). */
  close() {
    this.closed = true;
    for (const w of [this.worker, ...this.retiring]) {
      if (!w) continue;
      this.#gone(w, new Error("closed"));
      w.terminate().catch(() => {});
    }
    clearInterval(this.memTimer); this.memTimer = null; this.memBase.clear();
  }
}
/** A Uint8Array over its own ArrayBuffer (a copy when `bytes` shares one, e.g. Node's buffer pool), so it can be transferred. */
function own(bytes) { const u8 = new Uint8Array(bytes.byteLength); u8.set(bytes); return u8; }

/**
 * Disk-backed image cache behind GET /api/img and GET /api/logo-sheet. Originals are keyed by the
 * sha256 of the URL and hold at most `maxBytes` (oldest files evicted first), so a flood of distinct
 * allowed URLs can fill the budget but never the disk; a stale original whose refresh fails is still
 * served. Thumbnails (<sha>.w<w>.png) live beside them under their own budget (`thumbMaxBytes`, least
 * recently served out first, never one served within `thumbKeepMs`) and no age limit: a thumbnail is
 * served without the original, which may be long evicted or dead upstream. The warm pass stops at
 * THUMB_WARM_FILL of that budget and never evicts; first sight stops at THUMB_BG_FILL and evicts what was
 * unused for `freshIdleMs` (THUMB_FRESH_IDLE_MS) so new coins keep getting logos; refusals are logged, rate-limited.
 *
 * Downloads share `concurrency` slots: an on-demand request may take any of them, background work (the
 * first-sight queue, enqueueThumb, and the warm pass) at most `bgConcurrency` (half by default), and a
 * slot that frees goes to the most urgent waiter (PRIO_FG, then PRIO_FRESH, then PRIO_WARM); renders queue
 * the same way. Failures are classified (temporary / permanent / cannot be drawn) and remembered with their
 * next retry in `store` (the Db: table img_fail, kv for the warm cursor), in memory without one.
 */
export class ImageCache {
  constructor(dir, { log = console, fetchImpl = pinnedFetch, concurrency = 3, bgConcurrency, pacer, maxBytes = IMAGE_CACHE_MAX_BYTES, thumbMaxBytes = THUMB_CACHE_MAX_BYTES, thumbKeepMs = THUMB_KEEP_MS, freshIdleMs = THUMB_FRESH_IDLE_MS, work = null, store = null, freshConcurrency = FRESH_CONCURRENCY, freshMax = FRESH_MAX, now = Date.now } = {}) {
    this.dir = dir; this.log = log; this.maxBytes = maxBytes; this.thumbMaxBytes = thumbMaxBytes; this.thumbKeepMs = thumbKeepMs; this.freshIdleMs = freshIdleMs; this.now = now;
    this.pacer = pacer ?? new HostPacer({ fetchImpl });
    this.work = work ?? new ImgWork({ log });
    this.store = typeof store?.imgFailAll === "function" ? store : null;
    mkdirSync(dir, { recursive: true });
    this.inFlight = new Map();      // url → { promise, ticket } of a download
    this.concurrency = concurrency; this.bgConcurrency = Math.max(1, Math.min(concurrency, bgConcurrency ?? Math.floor(concurrency / 2)));
    this.active = 0; this.bgActive = 0; this.waiting = [[], [], []]; // download tickets waiting for a slot, per priority
    this.renderQ = [[], [], []]; this.rendering = false;               // render jobs, per priority, one at a time
    this.fails = new Map();         // url → { url, kind: "gone" | "temp" | "nothumb", error, attempts, goneAttempts, at, retryAt } (ms)
    this.thumbIdx = new Map();      // thumbnail file name → { size, mtime, usedAt } (ms): usedAt = made or last served
    this.thumbEvictPause = 0; this.freshEvictPause = 0; this.cursors = new Map();
    this.fullWarnAt = -Infinity; this.fullRefused = { fresh: 0, warm: 0, since: 0 }; // #bgFull's rate-limited warning
    this.fresh = new Set(); this.freshBusy = new Set(); this.freshActive = 0; this.freshConcurrency = freshConcurrency; this.freshMax = freshMax; this.closed = false;
    this.stats = { hits: 0, misses: 0, failed: 0, failedTemp: 0, failedGone: 0, staleServed: 0, evicted: 0, bytes: 0, thumbs: 0, thumbHits: 0, thumbFailed: 0, noThumb: 0, thumbBytes: 0, thumbsEvicted: 0, sheets: 0, sheetCells: 0, sheetPending: 0, sheetDead: 0, sheetMs: 0, bgDownloads: 0, freshQueued: 0, freshDropped: 0, freshMade: 0, freshFull: 0, freshEvicted: 0, warmFull: 0, svgDrawn: 0, svgFailed: 0 };
    this.thumbInFlight = new Map(); // `${w}:${url}` → { promise, job } of a render
    this.renderCrashes = new Map(); // url → renders of it the image worker died under, in a row (THUMB_CRASHES_MAX)
    this.#measure();
    this.#loadFails();
  }
  #paths(url) { const key = createHash("sha256").update(url).digest("hex"); return { file: join(this.dir, key), sidecar: join(this.dir, `${key}.json`) }; }
  /** Where the w px thumbnail of `url` lives (whether or not it exists). */
  thumbPath(url, w) { return `${this.#paths(url).file}.w${w}.png`; }
  /** Sizes the originals and indexes the thumbnails from disk (at boot and on every sweep); what this process knows of a thumbnail's use is kept. */
  #measure() {
    let bytes = 0, thumbBytes = 0;
    const idx = new Map();
    for (const name of readdirSync(this.dir)) {
      let st; try { st = statSync(join(this.dir, name)); } catch { continue; } // vanished
      if (!THUMB_NAME_RE.test(name)) { bytes += st.size; continue; }
      const prev = this.thumbIdx.get(name);
      // the mtime is the creation or the last recorded serve (THUMB_TOUCH_MS), so it stands for the last use after a restart
      idx.set(name, { size: st.size, mtime: st.mtimeMs, usedAt: Math.max(st.mtimeMs, prev?.usedAt ?? 0) });
      thumbBytes += st.size;
    }
    this.thumbIdx = idx; this.stats.bytes = bytes; this.stats.thumbBytes = thumbBytes;
  }
  #loadFails() {
    if (!this.store) return;
    try {
      // a renderer that learned to draw more (THUMB_RULE) tries again the logos it could not draw before
      if (typeof this.store.kvGet === "function" && Number(this.store.kvGet("imgThumbRule", 1)) < THUMB_RULE) { this.store.imgFailDropKind?.("nothumb"); this.store.kvSet?.("imgThumbRule", THUMB_RULE); }
      // a rotation that gained gateways (GATEWAY_RULE) tries again, once, the IPFS images the old one failed temporarily
      // or with a per-gateway summary (the old gateways' "no" is not the new ones'): the next ask or the warm pass fetches
      // them; what is about the bytes (not an image, too large, cannot be drawn) stays
      if (typeof this.store.kvGet === "function" && Number(this.store.kvGet("imgGatewayRule", 1)) < GATEWAY_RULE) {
        const drop = this.store.imgFailAll().filter((f) => ipfsPathOf(f.url) && (f.kind === "temp" || (f.kind === "gone" && summaryNotes(f.error))));
        const forget = () => { for (const f of drop) this.store.imgFailDelete(f.url); };
        if (typeof this.store.transaction === "function") this.store.transaction(forget); else forget();
        this.store.kvSet?.("imgGatewayRule", GATEWAY_RULE);
        this.log.info?.(`img: gateway rule ${GATEWAY_RULE}: ${drop.length} IPFS failures of the old rotation forgotten`);
      }
      // a proxy that learned to draw SVG (IMG_TYPE_RULE) forgets, once, the SVG, plain-text and XML refusals an older rule
      // recorded (a week's wait each) and asks for those logos again at once, on the first-sight queue; every other failure
      // stays as it is
      let recheck = [];
      if (typeof this.store.kvGet === "function" && Number(this.store.kvGet("imgTypeRule", 1)) < IMG_TYPE_RULE) {
        const drop = this.store.imgFailAll().filter((f) => TYPE_REFUSAL_RE.test(String(f.error ?? "")));
        const forget = () => { for (const f of drop) this.store.imgFailDelete(f.url); };
        if (typeof this.store.transaction === "function") this.store.transaction(forget); else forget();
        this.store.kvSet?.("imgTypeRule", IMG_TYPE_RULE);
        recheck = drop.map((f) => f.url);
        this.log.info?.(`img: type rule ${IMG_TYPE_RULE}: ${drop.length} logos refused by the old rule (SVG, plain text, XML) forgotten and asked again`);
      }
      for (const f of this.store.imgFailAll()) this.fails.set(f.url, f);
      // after the constructor returns (the caller may still wire the cache up); a closed cache queues nothing
      if (recheck.length) setImmediate(() => { for (const u of recheck) this.enqueueThumb(u); }).unref?.();
    } catch (e) { this.log.warn?.(`img: cannot read the failure memory: ${e?.message ?? e}`); }
  }
  /** The failure that still holds `url` back (`{ kind, error, attempts, at, retryAt }`), or null when there is none or its retry time came. */
  failureOf(url) { const f = this.fails.get(url); return f && f.retryAt > this.now() ? f : null; }
  /** Records a failure of `url` and when it may be tried again (see IMG_TEMP_RETRY_MS); persisted when a store is attached. */
  #fail(url, kind, error) {
    const prev = this.fails.get(url), now = this.now();
    const text = String(error?.message ?? error ?? "").slice(0, 200) || null;
    if (kind === "dns") {
      // a lone host that does not resolve: temporary (our resolver may be down) until the IMG_DNS_GONE_AFTER-th time in a row
      const run = prev && isDnsMiss(prev.error) ? (prev.kind === "gone" ? IMG_DNS_GONE_AFTER : prev.kind === "temp" ? prev.attempts : 0) : 0;
      kind = run + 1 >= IMG_DNS_GONE_AFTER ? "gone" : "temp";
    }
    // a permanent failure counts the permanent failures since the last success (`goneAttempts` carries it across a temporary
    // failure or an undrawable logo in between), so a url that alternates 404 and 502 still climbs to the weekly wait
    const prevGone = prev ? (prev.kind === "gone" ? prev.attempts : (prev.goneAttempts ?? 0)) : 0;
    // the others count consecutive failures of one run (failRun): three temporary failures and then a 404 is a first 404 (an
    // hour), not a fourth failure (a week); "cannot be drawn" is about the bytes, not the download, so it counts apart too
    const run = failRun(kind, text), had = prev && failRun(prev.kind, prev.error) === run ? prev.attempts : 0;
    // a deferral (no public gateway looked: isGatewayDeferral) is no failed attempt: a run of them counts up to IMG_DEFER_CAP
    // and never takes back what real failures of its run counted; it waits by the capped count
    const deferred = kind === "temp" && isGatewayDeferral(url, text);
    const attempts = kind === "gone" ? prevGone + 1 : deferred ? Math.max(had, Math.min(had + 1, IMG_DEFER_CAP)) : had + 1;
    // a lone host's "does not resolve" waits at least IMG_DNS_RETRY_MS, doubling: a short local DNS outage is not three misses
    const wait = kind === "temp" ? (run === "dns" ? Math.max(imgTempWaitMs(attempts), IMG_DNS_RETRY_MS * 2 ** (attempts - 1)) : deferred ? Math.round(imgTempWaitMs(Math.min(attempts, IMG_DEFER_CAP)) * (1 + jitterOf(url) / 2)) : imgTempWaitMs(attempts))
      : kind === "nothumb" ? IMG_NOTHUMB_RETRY_MS : IMG_GONE_RETRY_MS[Math.min(attempts, IMG_GONE_RETRY_MS.length) - 1];
    const f = { url, kind, error: text, attempts, goneAttempts: kind === "gone" ? attempts : prevGone, at: now, retryAt: now + wait };
    this.fails.set(url, f);
    try { this.store?.imgFailSet(f); } catch { /* memory still holds it */ }
    if (kind === "temp") this.stats.failedTemp++; else if (kind === "gone") this.stats.failedGone++; else this.stats.noThumb++;
    return f;
  }
  #clearFail(url, kinds) {
    const f = this.fails.get(url);
    if (!f || !kinds.includes(f.kind)) return;
    this.fails.delete(url);
    try { this.store?.imgFailDelete(url); } catch { /* the next boot reads a stale row, which only delays one retry */ }
  }
  /** Forgets failures past their retry time by IMG_FAIL_FORGET_MS (memory and store). */
  #pruneFails() {
    const before = this.now() - IMG_FAIL_FORGET_MS;
    for (const [url, f] of this.fails) if (f.retryAt < before) this.fails.delete(url);
    try { this.store?.imgFailPrune?.(before); } catch { /* next sweep */ }
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
  /**
   * Least recently used thumbnails out (last served, or made when never served) until they are back under 90% of their
   * own budget; one served or made within `thumbKeepMs` is never evicted (it is what the map shows, or about to). When
   * only those are left the budget overruns, with a warning, and the next try waits 10 minutes (a sweep forces one)
   * instead of re-sorting after every new file.
   */
  #evictThumbs({ force = false } = {}) {
    if (this.stats.thumbBytes <= this.thumbMaxBytes) return 0;
    const now = Date.now();
    if (!force && now < this.thumbEvictPause) return 0;
    const n = this.#dropLru(now - this.thumbKeepMs, this.thumbMaxBytes * 0.9);
    if (this.stats.thumbBytes > this.thumbMaxBytes) {
      this.thumbEvictPause = now + 10 * 60_000;
      this.log.warn?.(`img: ${Math.round(this.stats.thumbBytes / 2 ** 20)} MB of thumbnails, over the ${Math.round(this.thumbMaxBytes / 2 ** 20)} MB budget (IMG_THUMB_MB): the rest was served or made within ${Math.round(this.thumbKeepMs / 3600_000)} h`);
    }
    return n;
  }
  /** Deletes thumbnails last used (served, or made) at or before `usedBefore` (ms), least recently used first, until they total `target` bytes; returns how many went. */
  #dropLru(usedBefore, target) {
    const cands = [];
    for (const [name, e] of this.thumbIdx) if (e.usedAt <= usedBefore) cands.push([name, e]);
    cands.sort((a, b) => a[1].usedAt - b[1].usedAt);
    let n = 0;
    for (const [name, e] of cands) {
      if (this.stats.thumbBytes <= target) break;
      try { unlinkSync(join(this.dir, name)); } catch (err) { if (err?.code !== "ENOENT") continue; } // open elsewhere (Windows): next time
      this.thumbIdx.delete(name); this.stats.thumbBytes -= e.size; this.stats.thumbsEvicted++; n++;
    }
    this.stats.thumbBytes = Math.max(0, this.stats.thumbBytes);
    return n;
  }
  /**
   * Room for a first-sight thumbnail (#bgRoom), made when needed by evicting thumbnails nobody was served or made within
   * THUMB_FRESH_IDLE_MS (and never within thumbKeepMs), least recently used first, down to 90 % of the budget: a new coin
   * keeps getting its logo on a full disk, at the cost of logos the map has not shown for a month. When that does not
   * reach the 90 % (too little is idle), the next try waits THUMB_FULL_WARN_MS rather than re-sort for every new logo.
   */
  #freshRoom() {
    if (this.#bgRoom()) return true;
    const now = Date.now();
    if (now < this.freshEvictPause) return false;
    // 90 % of the budget, or lower when that would not leave room for an average thumbnail below THUMB_BG_FILL (a tiny budget)
    const target = Math.min(this.thumbMaxBytes * 0.9, this.thumbMaxBytes * THUMB_BG_FILL - this.#avgThumb());
    this.stats.freshEvicted += this.#dropLru(now - Math.max(this.thumbKeepMs, this.freshIdleMs), target);
    if (this.stats.thumbBytes > target) this.freshEvictPause = now + THUMB_FULL_WARN_MS;
    return this.#bgRoom();
  }
  /** Background work refused for the budget (#background "full"): counted, and warned about at most every THUMB_FULL_WARN_MS with what was refused since. */
  #bgFull(prio) {
    const fresh = prio === PRIO_FRESH;
    if (fresh) this.stats.freshFull++; else this.stats.warmFull++;
    const r = this.fullRefused, now = this.now();
    if (!r.fresh && !r.warm) r.since = now;
    if (fresh) r.fresh++; else r.warm++;
    if (now - this.fullWarnAt < THUMB_FULL_WARN_MS) return;
    this.fullWarnAt = now;
    const mb = (b) => Math.round(b / 2 ** 20), idle = Math.max(this.thumbKeepMs, this.freshIdleMs);
    const idleText = idle >= 86_400_000 ? `${Math.round(idle / 86_400_000)} days` : `${Math.round(idle / 3600_000)} h`;
    this.log.warn?.(`img: thumbnail budget full (${mb(this.stats.thumbBytes)} of ${mb(this.thumbMaxBytes)} MB, IMG_THUMB_MB): ${r.fresh} first-sight and ${r.warm} background thumbnails not made in ${Math.max(1, Math.round((now - r.since) / 60_000))} min (the warm pass stops at ${Math.round(THUMB_WARM_FILL * 100)} % and never evicts, first sight evicts only thumbnails unused for ${idleText}); raise IMG_THUMB_MB`);
    this.fullRefused = { fresh: 0, warm: 0, since: now };
  }
  /** Records a thumbnail file this process just wrote (a rewrite replaces its size). */
  #indexThumb(file, size) {
    const name = basename(file), prev = this.thumbIdx.get(name), now = Date.now();
    if (prev) this.stats.thumbBytes -= prev.size;
    this.thumbIdx.set(name, { size, mtime: now, usedAt: now });
    this.stats.thumbBytes += size;
  }
  #forgetThumb(file) { const name = basename(file), e = this.thumbIdx.get(name); if (e) { this.thumbIdx.delete(name); this.stats.thumbBytes = Math.max(0, this.stats.thumbBytes - e.size); } }
  /** A thumbnail went out to a client (an /api/img answer, a sheet cell, a share card): most recently used; its mtime follows at most every THUMB_TOUCH_MS. */
  #served(file) {
    const e = this.thumbIdx.get(basename(file));
    if (!e) return;
    const now = Date.now();
    e.usedAt = now;
    if (now - e.mtime > THUMB_TOUCH_MS) { try { utimesSync(file, now / 1000, now / 1000); e.mtime = now; } catch { /* read-only or gone: memory still knows */ } }
  }
  /** Is there room for background work to make another thumbnail (an average one) within `fill` of the budget (THUMB_BG_FILL: first sight; the warm pass asks for THUMB_WARM_FILL)? */
  #bgRoom(fill = THUMB_BG_FILL) { return this.stats.thumbBytes + this.#avgThumb() <= this.thumbMaxBytes * fill; }
  #avgThumb() { return this.thumbIdx.size ? this.stats.thumbBytes / this.thumbIdx.size : 0; }

  /**
   * `{file, type}` for a cached-or-fetched image, or null (not allowed, too big, not an image, unreachable: failureOf
   * says which, and until when). A stale original whose refresh fails is served as it is. `prio` (PRIO_FG by default)
   * orders the download against the others; an on-demand ask for a url a background job is still waiting to fetch
   * lifts that job to its own priority.
   */
  async get(url, { prio = PRIO_FG } = {}) {
    const local = localMetaFile(url);
    if (local && local.type.startsWith("image/")) return local;
    if (!isAllowedImageUrl(url)) return null;
    const { file, sidecar } = this.#paths(url);
    let stale = null;
    try {
      const st = statSync(file), type = JSON.parse(readFileSync(sidecar, "utf8")).type;
      if (Date.now() - st.mtimeMs < IMAGE_TTL_MS) { this.stats.hits++; return { file, type }; }
      stale = { file, type };
    } catch { /* not cached */ }
    const f = this.failureOf(url);
    if (f && f.kind !== "nothumb") { if (stale) this.stats.staleServed++; return stale; }
    this.stats.misses++;
    const flight = this.inFlight.get(url);
    if (flight) { this.#promote(flight.ticket, prio); return flight.promise; }
    const ticket = { prio, waiting: false, bg: false, resolve: null, render: null }; // render: the drawing of its SVG (#rasterize)
    const promise = this.#download(url, file, sidecar, ticket)
      .then((hit) => { if (hit || !stale || !existsSync(stale.file)) return hit; this.stats.staleServed++; return stale; })
      .finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, { promise, ticket });
    return promise;
  }
  async #download(url, file, sidecar, ticket) {
    await this.#enter(ticket);
    try {
      if (ticket.bg) this.stats.bgDownloads++;
      let hit;
      const out = {};
      try { hit = await this.pacer.fetchAny(url, {}, { allow: isAllowedImageUrl, timeoutMs: 15_000, budgetMs: 30_000, out }); }
      catch (e) { throw failure(thrownKind(e), e?.summary || e?.message || String(e)); }
      if (hit === null) throw failure("temp", out.summary ?? "rate limited");
      if (!hit) throw failure("gone", "no candidate");
      const { res } = hit;
      // a 429 elsewhere in the rotation, a 5xx or a timeout make a "no" temporary; a definitive 4xx everywhere is not
      if (!res.ok) throw failure(hit.transient || softStatus(res.status) ? "temp" : "gone", hit.summary ?? `HTTP ${res.status}`);
      const declared = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      // Declared types are not trusted either way (gateways send octet-stream for images): the bytes decide below. A page
      // (text/html, text/css ...) is refused before the download; plain text and XML may be an SVG (raw file hosts).
      const svgDeclared = declared.includes("svg");
      if (!svgDeclared && declared.startsWith("text/") && declared !== "text/plain" && declared !== "text/xml") throw failure("gone", `not an image: ${declared}`);
      const cap = svgDeclared ? SVG_MAX_BYTES : IMAGE_MAX_BYTES, svgOver = `svg: over ${SVG_MAX_BYTES / 1024} KB`;
      if (Number(res.headers.get("content-length") || 0) > cap) throw failure("gone", svgDeclared ? svgOver : "too large");
      let body;
      try { body = await readBounded(res, cap); }
      catch (e) { const over = String(e?.message).startsWith("body over"); throw failure(over ? "gone" : "temp", over && svgDeclared ? svgOver : e?.message ?? String(e)); }
      // a stored Content-Encoding is undone within the same cap (an SVG beyond it is refused below, after the sniff)
      const coding = (res.headers.get("content-encoding") || "").trim().toLowerCase();
      if (coding && coding !== "identity") body = await decodedBody(body, coding, cap, svgDeclared ? svgOver : "too large");
      // The served type is what the bytes prove, never what the gateway claimed.
      let type = sniffImage(body);
      // SVG can script on our origin, so its bytes are never stored or served: it is drawn into a PNG on the image worker
      // (rasterizeSvg: no fonts, images or files from outside, at most SVG_DRAW_MAX_MS), which becomes the original
      if (!type && (svgDeclared || isSvgDocument(body))) {
        if (body.length > SVG_MAX_BYTES) throw failure("gone", svgOver);
        body = await this.#rasterize(url, body, ticket);
        type = sniffImage(body);
        if (type !== "image/png") throw failure("gone", "svg: not drawn");
      }
      if (!type) throw failure("gone", `not a raster image (${declared})`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      const meta = JSON.stringify({ url, type, size: body.length, at: Date.now() });
      writeFileSync(sidecar, meta);
      renameSync(tmp, file); // atomic on the same volume: a concurrent reader never sees a partial file
      this.stats.bytes += body.length + meta.length;
      this.#clearFail(url, ["gone", "temp"]);
      this.#evict();
      return { file, type };
    } catch (e) {
      this.stats.failed++;
      this.#fail(url, e?.kind ?? "temp", e); // an unclassified fault (the disk, say) is temporary
      return null;
    } finally { this.#leave(ticket); }
  }
  /**
   * The PNG original of the SVG logo `bytes` of `url`, drawn by the image worker (ImgWork.svg) through the render queue
   * like a thumbnail, at the download's priority (an on-demand ask that joins lifts it: #promote); throws a classified
   * failure. What the drawing refuses or cannot do (not an SVG, entities, a parse or render error, no size, nothing drawn,
   * past SVG_DRAW_MAX_MS) is permanent; the worker dying under it is temporary until it happened THUMB_CRASHES_MAX times
   * in a row on this url, as for a thumbnail; no worker at all (it cannot start, or keeps dying) is temporary.
   */
  async #rasterize(url, bytes, ticket) {
    const job = { prio: ticket.prio, started: false, resolve: null, run: async () => {
      try { return { png: await this.work.svg({ bytes }) }; } catch (error) { return { error }; }
    } };
    const done = new Promise((resolve) => { job.resolve = resolve; });
    ticket.render = job;
    this.renderQ[job.prio].push(job);
    this.#drainRenders();
    const r = await done;
    ticket.render = null;
    if (r?.png) { this.renderCrashes.delete(url); this.stats.svgDrawn++; return r.png; }
    this.stats.svgFailed++;
    const e = r?.error, msg = String(e?.message ?? e ?? "not drawn").slice(0, 160);
    if (e?.noWorker) throw failure("temp", `svg: ${msg}`);
    if (e?.transient) {
      const n = (this.renderCrashes.get(url) ?? 0) + 1;
      if (n < THUMB_CRASHES_MAX) { this.renderCrashes.set(url, n); throw failure("temp", `svg: ${msg}`); }
      this.renderCrashes.delete(url);
      throw failure("gone", `svg: the image worker died drawing it ${n} times in a row`);
    }
    throw failure("gone", msg.startsWith("svg: ") ? msg : `svg: ${msg}`);
  }
  /**
   * `{ file, type, thumb: w }` when the w px thumbnail of `url` is on disk (whatever its age), else null (no original
   * needed). The index answers without touching the disk; a file it does not know is looked for once and adopted.
   */
  thumbOnDisk(url, w) {
    if (!url || !IMAGE_THUMB_SIZES.has(w)) return null;
    const file = this.thumbPath(url, w), name = basename(file);
    if (this.thumbIdx.has(name)) return { file, type: "image/png", thumb: w };
    try {
      const st = statSync(file);
      this.thumbIdx.set(name, { size: st.size, mtime: st.mtimeMs, usedAt: st.mtimeMs }); this.stats.thumbBytes += st.size;
      return { file, type: "image/png", thumb: w };
    } catch { return null; } // not made
  }
  /** The bytes of the w px PNG thumbnail of `url` on disk (thumbOnDisk), else null; never fetches or renders (the social card reads logos this way; `warm` makes a missing one). */
  thumbBytes(url, w) {
    const hit = this.thumbOnDisk(url, w);
    if (!hit) return null;
    try { const bytes = readFileSync(hit.file); this.stats.thumbHits++; this.#served(hit.file); return bytes; } catch { this.#forgetThumb(hit.file); return null; }
  }
  /**
   * Known not to yield a w px thumbnail for a while: no url, one the proxy will not fetch, a permanent download failure,
   * or a logo that could not be drawn (failureOf). A temporary failure is not dead: it is pending; nor is a url with no
   * failure recorded.
   */
  isDead(url) {
    if (!url || !isAllowedImageUrl(url)) return true;
    const f = this.failureOf(url);
    return !!f && f.kind !== "temp";
  }
  /** A temporary download failure holds `url` back right now (a 503 / a pending sheet cell). */
  isPending(url) { return this.failureOf(url)?.kind === "temp"; }

  /**
   * `{file, type, thumb: w}` for a w x w PNG thumbnail of `hit` (an image get() returned), cached on disk as
   * <sha>.w<w>.png beside the original; a thumbnail already on disk is served whatever its age (thumbOnDisk);
   * null when it cannot be made (a decode failure: recorded as "nothumb" for IMG_NOTHUMB_RETRY_MS): serve the
   * original then. Renders run on the image worker one at a time (setImmediate between them), most urgent
   * `prio` first, so a burst of logos never stalls the loop and background renders never delay a visitor's.
   */
  async thumb(url, hit, w, { prio = PRIO_FG } = {}) {
    const warm = this.thumbOnDisk(url, w);
    if (warm) { this.stats.thumbHits++; return warm; }
    if (!hit || !IMAGE_THUMB_SIZES.has(w)) return null;
    if (this.failureOf(url)?.kind === "nothumb") return null;
    if (!THUMB_TYPES.has(hit.type)) { this.#fail(url, "nothumb", `cannot draw ${hit.type}`); return null; }
    const out = this.thumbPath(url, w), key = `${w}:${url}`;
    const flight = this.thumbInFlight.get(key);
    if (flight) { this.#promoteRender(flight.job, prio); return flight.promise; }
    const job = { prio, started: false, resolve: null, run: async () => {
      try {
        const png = await this.work.thumb({ bytes: readFileSync(hit.file), type: hit.type, w });
        if (!png) throw new Error("not drawable");
        const tmp = `${out}.${process.pid}.tmp`;
        writeFileSync(tmp, png); renameSync(tmp, out);
        this.#indexThumb(out, png.length); this.stats.thumbs++;
        this.#clearFail(url, ["nothumb"]);
        this.renderCrashes.delete(url);
        this.#evictThumbs();
        return { file: out, type: "image/png", thumb: w };
      } catch (e) {
        this.stats.thumbFailed++;
        // a worker crash is not the image's fault, nor an original evicted while the job waited: the next ask renders again
        // (a pending sheet cell). Renders run one at a time, so the worker dying THUMB_CRASHES_MAX times in a row on the
        // same logo is taken as the logo's doing: "cannot be drawn" (a dead cell); asked again within seconds now that the
        // cell is pending, it would otherwise take the worker down at every ask, and five restarts render inline for good
        if (e?.code === "ENOENT") return null;
        if (e?.transient) {
          const n = (this.renderCrashes.get(url) ?? 0) + 1;
          if (n < THUMB_CRASHES_MAX) { this.renderCrashes.set(url, n); return null; }
        }
        this.renderCrashes.delete(url);
        this.#fail(url, "nothumb", e);
        return null;
      }
    } };
    const promise = new Promise((resolve) => { job.resolve = resolve; }).finally(() => this.thumbInFlight.delete(key));
    this.thumbInFlight.set(key, { promise, job });
    this.renderQ[prio].push(job);
    this.#drainRenders();
    return promise;
  }
  async #drainRenders() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      for (;;) {
        const job = this.renderQ[PRIO_FG].shift() ?? this.renderQ[PRIO_FRESH].shift() ?? this.renderQ[PRIO_WARM].shift();
        if (!job) break;
        job.started = true;
        let value = null;
        try { value = await job.run(); } catch { /* run() answers null itself */ }
        job.resolve(value);
        await new Promise((r) => setImmediate(r));
      }
    } finally { this.rendering = false; }
  }
  #promoteRender(job, prio) {
    if (job.started || prio >= job.prio) return;
    const q = this.renderQ[job.prio], i = q.indexOf(job);
    if (i >= 0) q.splice(i, 1);
    job.prio = prio; this.renderQ[prio].push(job);
  }

  /**
   * The w px thumbnail of one url on behalf of background work (`prio` PRIO_FRESH or PRIO_WARM): "hit" (on disk),
   * "skip" (a failure holds it back), "full" (the thumbnails are at THUMB_WARM_FILL of their budget for the warm pass, or
   * at THUMB_BG_FILL with nothing idle enough to evict for first sight: #freshRoom; logged by #bgFull), "ok" (made) or
   * "fail" (failureOf says why).
   */
  async #background(url, w, prio) {
    if (this.thumbIdx.has(basename(this.thumbPath(url, w)))) return "hit";
    if (this.failureOf(url)) return "skip";
    if (this.thumbOnDisk(url, w)) return "hit";
    if (!(prio === PRIO_FRESH ? this.#freshRoom() : this.#bgRoom(THUMB_WARM_FILL))) { this.#bgFull(prio); return "full"; }
    const hit = await this.get(url, { prio });
    const t = hit ? await this.thumb(url, hit, w, { prio }) : null;
    return t ? "ok" : "fail";
  }

  /**
   * First sight (2026-11-10): the 64 px thumbnail of an image url the moment its metadata names it (Model.onImage),
   * so the logo is on disk before the map asks for it and before its host can die. Deduplicated, at most `freshMax` (FRESH_MAX)
   * waiting (the warm pass catches whatever is dropped), `freshConcurrency` at a time on the background slots,
   * behind every on-demand request and ahead of the warm pass. Returns whether the url was queued.
   */
  enqueueThumb(url) {
    if (typeof url !== "string" || !url || this.closed || this.fresh.has(url) || this.freshBusy.has(url)) return false;
    if (this.fresh.size >= this.freshMax) { this.stats.freshDropped++; return false; }
    this.fresh.add(url); this.stats.freshQueued++;
    this.#pumpFresh();
    return true;
  }
  /** Urls waiting in the first-sight queue plus the ones being worked. */
  get freshPending() { return this.fresh.size + this.freshBusy.size; }
  #pumpFresh() {
    while (!this.closed && this.freshActive < this.freshConcurrency && this.fresh.size) {
      const url = this.fresh.values().next().value;
      this.fresh.delete(url); this.freshBusy.add(url); this.freshActive++;
      this.#background(url, SHEET_CELL, PRIO_FRESH).then((r) => { if (r === "ok") this.stats.freshMade++; }, () => null)
        .finally(() => { this.freshActive--; this.freshBusy.delete(url); this.#pumpFresh(); });
    }
  }

  /**
   * Pre-warm (map logos from far, owner 2026-10-21): makes sure each url has its w-px thumbnail on disk (one on
   * disk costs a map lookup; otherwise the original is fetched through get() and drawn through thumb(), webp
   * included), at most `concurrency` urls at a time on the background download slots. A url a failure holds back
   * (failureOf: kept in sqlite, so a restart does not retry the dead) is skipped. With `resume` (a kv key) the pass
   * starts where the previous one stopped (the url it would have done next, else its position) and goes once round
   * the list from there; a pass that gets round starts the next one at the top. Returns { n, ok, failed, skipped,
   * full, stopped, from, ms }.
   */
  async warm(urls, w = SHEET_CELL, concurrency = 4, { maxMs = WARM_MAX_MS, resume = null, prio = PRIO_WARM } = {}) {
    // each url once, in first-seen order; the loop gets a turn every 8k (140k urls on the local index: ~56 ms at once)
    const list = [];
    { const seen = new Set(); let i = 0; for (const u of urls ?? []) { if ((++i & 8191) === 0) await new Promise((r) => setImmediate(r)); if (typeof u === "string" && u && !seen.has(u)) { seen.add(u); list.push(u); } } }
    const n = list.length, t0 = Date.now();
    let start = 0;
    if (resume && n) {
      const c = this.#cursorGet(resume);
      const j = typeof c?.url === "string" ? list.indexOf(c.url) : -1;
      start = j >= 0 ? j : Math.min(Math.max(0, Math.floor(Number(c?.i) || 0)), n - 1);
    }
    let taken = 0, ok = 0, failed = 0, skipped = 0, full = 0, stopped = false, savedAt = t0;
    const save = (round) => { if (resume && n) { const i = round ? 0 : (start + taken) % n; this.#cursorSet(resume, { i, url: round ? null : list[i], at: Date.now() }); } };
    const worker = async () => {
      while (taken < n) {
        if (Date.now() - t0 > maxMs || this.closed) { stopped = true; break; }
        const u = list[(start + taken++) % n];
        // a run of logos already on disk never awaits anything: let the loop breathe now and then
        if ((taken & 511) === 0) await new Promise((r) => setImmediate(r));
        try {
          const r = await this.#background(u, w, prio);
          if (r === "hit" || r === "ok") ok++; else if (r === "fail") failed++; else if (r === "full") { full++; skipped++; } else { skipped++; failed++; }
        } catch { failed++; }
        if (resume && Date.now() - savedAt > 60_000) { savedAt = Date.now(); save(false); } // a restart mid-pass resumes too
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), n) }, worker));
    save(!stopped);
    return { n, ok, failed, skipped, full, stopped, from: start, ms: Date.now() - t0 };
  }
  #cursorGet(key) {
    try { if (typeof this.store?.kvGet === "function") return this.store.kvGet(key, null); } catch { /* memory then */ }
    return this.cursors.get(key) ?? null;
  }
  #cursorSet(key, value) {
    this.cursors.set(key, value);
    try { this.store?.kvSet?.(key, value); } catch { /* memory holds it */ }
  }
  /** Stops the first-sight queue and ends a running warm pass at its next url. */
  close() { this.closed = true; this.fresh.clear(); }

  /**
   * One logo sheet (GET /api/logo-sheet) for `urls` (raw image URLs, null for a mint without one): cell i is
   * the w px thumbnail of urls[i], SHEET_COLS cells per row, as `{ bytes, type, present, dead, pending }`
   * with `present`/`dead` one byte per cell. A thumbnail on disk is read at once; a dead url (isDead: a
   * permanent failure or a logo that cannot be drawn, or one the proxy will not fetch) is marked dead; a url
   * a temporary failure holds back (isPending) is pending without a job; for the rest the usual get() -> thumb()
   * jobs start and the
   * sheet waits for them at most `budgetMs` from the call (`waitMs` when nothing at all landed by then): whatever landed is present, the others are
   * pending (neither bit) and keep running, so the client's next ask finds them on disk; a job that failed
   * temporarily stays pending too, and so does one that ended with no failure recorded. Composition runs
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
      if (this.isDead(url)) { dead[i] = 1; continue; }
      if (this.isPending(url)) continue; // a temporary failure: pending, asked again after its wait
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
        // (repair 2026-11-10) no thumbnail is dead only when a failure says so (isDead): a job that ended with nothing
        // recorded (the image worker crashed, the original was evicted under the render: both transient) is pending like
        // a temporary failure, where it was dead and the browser refused the logo for 15 min and more
        if (job.value) { files[i] = job.value.file; present[i] = 1; } else if (this.isDead(urls[i])) dead[i] = 1;
      }
    }
    const cells = await Promise.all(files.map(async (f, i) => { if (!f) return null; try { return await readFile(f); } catch { present[i] = 0; this.#forgetThumb(f); return null; } }));
    const r = await this.work.sheet({ cells, cols: SHEET_COLS, cell: w, format });
    for (const i of r.failed) { present[i] = 0; try { unlinkSync(files[i]); } catch { /* already gone */ } this.#forgetThumb(files[i]); }
    for (let i = 0; i < n; i++) if (present[i]) this.#served(files[i]);
    let pending = 0, deadN = 0;
    for (let i = 0; i < n; i++) { if (dead[i]) deadN++; else if (!present[i]) pending++; }
    this.stats.sheets++; this.stats.sheetCells += n; this.stats.sheetPending += pending; this.stats.sheetDead += deadN; this.stats.sheetMs += Date.now() - t0;
    return { bytes: r.bytes, type: r.type, present, dead, pending };
  }

  // Download slots: an on-demand ticket (PRIO_FG) may take any of the `concurrency` slots, a background one only
  // while fewer than `bgConcurrency` background downloads run; a freed slot goes to the most urgent waiter.
  #enter(t) {
    if (this.#fits(t)) { this.#take(t); return Promise.resolve(); }
    return new Promise((resolve) => { t.resolve = resolve; t.waiting = true; this.waiting[t.prio].push(t); });
  }
  #fits(t) { return this.active < this.concurrency && (t.prio === PRIO_FG || this.bgActive < this.bgConcurrency); }
  #take(t) { this.active++; t.waiting = false; t.bg = t.prio !== PRIO_FG; if (t.bg) this.bgActive++; }
  #leave(t) { this.active--; if (t.bg) this.bgActive--; this.#dispatch(); }
  #dispatch() {
    for (const q of this.waiting) while (q.length && this.#fits(q[0])) { const t = q.shift(); this.#take(t); t.resolve(); }
  }
  /** An on-demand ask joined a download still waiting for a background slot: it waits as an on-demand one now (and so does the drawing of its SVG, #rasterize). */
  #promote(t, prio) {
    if (prio >= t.prio) return;
    if (t.waiting) { const q = this.waiting[t.prio], i = q.indexOf(t); if (i >= 0) q.splice(i, 1); t.prio = prio; this.waiting[prio].push(t); this.#dispatch(); }
    else t.prio = prio; // running already: it keeps the slot it has
    if (t.render) this.#promoteRender(t.render, prio);
  }
  /** Download slots in use and waiting, per kind (health). */
  slots() { return { active: this.active, bgActive: this.bgActive, concurrency: this.concurrency, bgConcurrency: this.bgConcurrency, waiting: this.waiting.map((q) => q.length) }; }
  /** `stats` plus the queues, the failure memory and the image worker's counters (`work`: ImgWork.stats), for /api/health. */
  snapshot() {
    let gone = 0, temp = 0, nothumb = 0;
    const now = this.now();
    for (const f of this.fails.values()) if (f.retryAt > now) { if (f.kind === "temp") temp++; else if (f.kind === "gone") gone++; else nothumb++; }
    return { ...this.stats, thumbFiles: this.thumbIdx.size, thumbMaxBytes: this.thumbMaxBytes, slots: this.slots(), fresh: this.freshPending, failing: { gone, temp, nothumb }, work: { ...this.work?.stats } };
  }

  /** The answer for an image the proxy cannot serve: 503 with a short Retry-After while a temporary failure holds it back, else 404. */
  #unavailable(res, url) {
    res.setHeader("cache-control", "no-store");
    const f = this.failureOf(url);
    if (f?.kind !== "temp") return res.status(404).json({ error: "image not available" });
    res.setHeader("retry-after", String(Math.min(IMG_RETRY_AFTER_MAX_S, Math.max(1, Math.ceil((f.retryAt - this.now()) / 1000)))));
    return res.status(503).json({ error: "image temporarily unavailable" });
  }

  /**
   * Express handler: `GET /api/img?u=<https url>[&w=64|128|256]`; 404 for anything the proxy will not serve, 503 with
   * a short Retry-After while a temporary failure (rate limit, 5xx, timeout) holds the image back. With a
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
        if (!hit) return this.#unavailable(res, url);
        if (IMAGE_THUMB_SIZES.has(w)) { const t = await this.thumb(url, hit, w).catch(() => null); if (t) hit = t; }
      }
      if (hit.thumb) { res.setHeader("x-img-thumb", String(w)); this.#served(hit.file); }
      res.setHeader("content-type", hit.type);
      // a thumbnail is cached 7 days by the browser; the original keeps its day
      res.setHeader("cache-control", hit.thumb ? "public, max-age=604800, immutable" : "public, max-age=86400, immutable");
      res.setHeader("x-content-type-options", "nosniff");
      const thumbFile = hit.thumb ? hit.file : null;
      createReadStream(hit.file).on("error", () => { if (thumbFile) this.#forgetThumb(thumbFile); res.destroy(); }).pipe(res);
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
      // a pending cell is asked again soon: not stored. A sheet of logos only is kept 10 min. A dead cell is the part of an
      // answer that can turn on the server within those 10 min (a mint whose image url is still on its way with its
      // metadata; a permanent failure whose first wait is an hour; failures a new gateway rule forgot), while the browser
      // keeps its own dead timer (15 min and more) within a page, so such a sheet is kept a minute: a reload sees the
      // fresh verdict, a burst of reloads is still absorbed.
      res.setHeader("cache-control", r.pending ? "no-store" : r.dead.includes(1) ? "private, max-age=60" : "private, max-age=600");
      res.setHeader("access-control-expose-headers", "x-sheet, x-sheet-dead, x-sheet-n, x-sheet-pending");
      res.setHeader("content-length", String(r.bytes.length));
      res.end(r.bytes);
    };
  }

  /**
   * Drops originals (and stray temp files) older than twice their TTL, re-measures and evicts, forgets old failures;
   * a few times a day. A thumbnail is never dropped for its age: only the budget evicts one (#evictThumbs).
   */
  sweep() {
    let removed = 0;
    const now = Date.now();
    for (const name of readdirSync(this.dir)) {
      if (THUMB_NAME_RE.test(name)) continue;
      const p = join(this.dir, name);
      try { if (now - statSync(p).mtimeMs > IMAGE_TTL_MS * 2) { unlinkSync(p); removed++; } } catch { /* vanished */ }
    }
    this.#measure();
    this.#evict();
    this.#evictThumbs({ force: true });
    this.#pruneFails();
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
