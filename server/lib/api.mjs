// HTTP API (DESIGN §7). Every response is JSON with every contract field present; errors are
// `{ error }` with a 4xx/5xx status. Reads come from the in-memory model, so a request never waits
// on the RPC except the explicitly live ones (eligibility, an unknown coin, the proxy, treasury, fees).
// Hardening (headers, CORS, rate limits, body caps, compression, caching) lives in http.mjs and is
// wired here per route: the upload may carry a 3 MB image, everything else is capped at 16 KB.
import express from "express";
import { existsSync, readFileSync, statSync } from "node:fs";
import { brotliCompressSync, gzipSync, constants as Z } from "node:zlib";
import { join } from "node:path";
import { checkEligibility } from "./eligibility.mjs";
import { PublicKey, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, VersionedTransaction } from "./sdk.mjs";
import { META_NAME_RE, META_TYPES, QuotaError } from "./metahost.mjs";
import { verifySpawnTx } from "./spawned.mjs";
import { shareOf, claimTotals } from "./treasury.mjs";
import { fromBase58 } from "./decode.mjs";
import { launchFeeOf, DEFAULT_LAUNCH_FEE_SOL, splitShares, rootShares, ROOT_SPLIT_BPS } from "./pricing.mjs";
import { AGENT_MODELS, DEFAULT_MODEL, modelInfo } from "./agents-live/models.mjs";
import { securityHeaders, cors, rateLimit, requestLog, compression, sendCachedJson, sendSpaHtml, prepareJson, prepareJsonText, sendPrepared, RateLimiter, isEmbedPath, etagOf } from "./http.mjs";
import { createV1, DEFAULT_PUBLIC_URL } from "./v1.mjs";
import { ApiKeys } from "./apikeys.mjs";
import { uploadFields, imageFromDataUrl, LIMITS } from "./validate.mjs";
import { DEFAULT_RATES } from "./config.mjs";
import { DOMINANCE_CACHE_MS, familyShares } from "./dominance.mjs";
import { FAMILY_PAGE, FAMILY_PAGE_MAX } from "./model.mjs";
import { AgentRegistry, agentsBody, agentBody, agentCoinBody, isPublicAgent, IMAGE_FILE_RE } from "./agents/registry.mjs";
import { AgentLedger } from "./agents-live/ledger.mjs";
import { createBriefStore } from "./agents/brief.mjs";
import { readBudget } from "./agents-live/budget.mjs";
import { ogTags, injectOg, cardMintFor } from "./og.mjs";

export { RateLimiter };

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Share cards: a minute at the edge, five more served stale while the renderer is asked again. */
export const CARD_CACHE = "public, max-age=60, stale-while-revalidate=300";
/** A card drawn with the lettered placeholder (logo not on disk yet): the renderer retries it after 5 s, so nothing may keep it longer. */
export const CARD_CACHE_PLACEHOLDER = "public, max-age=5";
const CARD_RETRY_MS = 30_000;
export const AGENT_BALANCE_TTL_MS = 60_000;

/**
 * Agent wallet balances for the site (DESIGN §13.2): the live orchestrator's last budget read when it
 * has one for the root, else `readBudget` on the api RPC lane, cached `ttlMs` per address (a failed
 * read keeps the last value and is not retried before the ttl). `prime(entries)` starts the reads a
 * request needs and waits at most `waitMs`, so a slow RPC never stalls a page: the numbers fill in
 * on the next request. `get(root, address)` answers `{ sol, usdc, usd, updatedAt }` or null.
 */
export function createAgentBalances({ rpc, model, live = null, ttlMs = AGENT_BALANCE_TTL_MS, waitMs = 1_500, now = Date.now, read = readBudget, log = console }) {
  const cache = new Map(); // address → { at, value, promise }
  const value = (b) => ({ sol: b.sol ?? null, usdc: b.usdc ?? null, usd: b.usd ?? null, updatedAt: b.readAt ?? Math.floor(now() / 1000) });
  const liveBudget = (root) => { const b = live?.state?.get?.(root)?.budget; return b && b.readAt ? b : null; };
  function start(address) {
    if (typeof rpc?.call !== "function") return null;
    let e = cache.get(address);
    if (!e) { e = { at: -Infinity, value: null, promise: null }; cache.set(address, e); } // never read: always stale
    if (e.promise) return e.promise;
    if (now() - e.at < ttlMs) return null;
    e.promise = Promise.resolve()
      .then(() => read(rpc, address, { solUsd: model.solUsd }))
      .then((b) => { e.value = value(b); }, (err) => { log.warn?.(`agents: balance of ${address}: ${String(err?.message || err?.name || err).slice(0, 120)}`); })
      .finally(() => { e.at = now(); e.promise = null; });
    return e.promise;
  }
  return {
    async prime(entries) {
      const waits = [];
      for (const { root, address } of entries) { if (!address || liveBudget(root)) continue; const p = start(address); if (p) waits.push(p); }
      if (!waits.length) return;
      await Promise.race([Promise.allSettled(waits), new Promise((r) => { const t = setTimeout(r, waitMs); t.unref?.(); })]);
    },
    get(root, address) { const lb = liveBudget(root); if (lb) return value(lb); return cache.get(address)?.value ?? null; },
    snapshot() { return { cached: cache.size, pending: [...cache.values()].filter((e) => e.promise).length }; },
  };
}
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/; // a base58 ed25519 signature is 87–88 chars; be lenient, the chain decides
const SPAWNED_CACHE_MS = 10 * 60_000;  // a verified (or refused) signature is not fetched again within this
const SPAWNED_NOTFOUND_MS = 2_000;     // a signature the RPC has not seen yet is retried after this
export const RPC_MAX_BATCH = 5;
export const RPC_MAX_KEYS = 32;
const nowS = () => Math.floor(Date.now() / 1000);
export const BODY_LIMIT = "16kb";
export const UPLOAD_BODY_LIMIT = "3mb";

export const RPC_ALLOW = new Set(["getLatestBlockhash", "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getBalance", "getAccountInfo", "getMultipleAccounts",
  "getTokenAccountBalance", "getTokenAccountsByOwner", "getTokenSupply", "getMinimumBalanceForRentExemption", "getTransaction", "getSlot", "getBlockHeight", "getBlockTime",
  "getEpochInfo", "isBlockhashValid", "getRecentPrioritizationFees", "getFeeForMessage", "getHealth", "getVersion", "getAddressLookupTable"]);

export function isMint(s) { if (typeof s !== "string" || !MINT_RE.test(s)) return false; try { new PublicKey(s); return true; } catch { return false; } }
/** If-None-Match against one ETag: a list of validators or `*`, as crawlers and the edge send it. */
export function etagMatches(header, etag) {
  if (typeof header !== "string" || !etag) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((v) => v.trim() === etag || v.trim() === `W/${etag}` || `W/${v.trim()}` === etag);
}
export function isSig(s) { return typeof s === "string" && SIG_RE.test(s); }

const PUMP_PROGRAMS = new Set([PUMP_PROGRAM_ID.toBase58(), PUMP_AMM_PROGRAM_ID.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58()]);
/**
 * Does a serialized transaction invoke a pump program? The proxy relays sendTransaction and
 * simulateTransaction only for those, so it cannot be used as a free relay for arbitrary
 * transactions through the server's (keyed) RPC. Program ids are always static keys, lookup
 * tables or not, so the check needs no table lookups.
 */
export function txTouchesPump(encoded, encoding = "base64") {
  try {
    const bytes = encoding === "base58" ? fromBase58(encoded) : Buffer.from(encoded, "base64");
    const msg = VersionedTransaction.deserialize(bytes).message;
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    return msg.compiledInstructions.some((ix) => PUMP_PROGRAMS.has(keys[ix.programIdIndex]));
  } catch { return false; }
}
/** Per-method parameter rules for the proxy; returns an error message or null. */
export function rpcParamsError(method, params) {
  const p = Array.isArray(params) ? params : [];
  switch (method) {
    case "getMultipleAccounts":
      if (!Array.isArray(p[0]) || p[0].length > RPC_MAX_KEYS || !p[0].every((k) => typeof k === "string")) return `getMultipleAccounts takes at most ${RPC_MAX_KEYS} keys`;
      return null;
    case "getTokenAccountsByOwner":
      if (p[2]?.encoding === "jsonParsed") return "getTokenAccountsByOwner: jsonParsed is not relayed";
      return null;
    case "sendTransaction":
    case "simulateTransaction":
      if (typeof p[0] !== "string" || p[0].length > 4_000) return `${method}: transaction missing or too large`;
      if (!txTouchesPump(p[0], p[1]?.encoding === "base58" ? "base58" : "base64")) return `${method}: only pump.fun transactions are relayed`;
      return null;
    default:
      return null;
  }
}

const clampInt = (v, def, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const byLocked = (a, b) => (b.lockedUsd ?? -1) - (a.lockedUsd ?? -1) || (b.mcapUsd ?? -1) - (a.mcapUsd ?? -1);
const off = (v) => v === "0" || v === "false"; // an opt-out query flag (`?children=0`)
/** A JSON object's text with `"indexed": n` appended as its last key: the same bytes JSON.stringify({ ...body, indexed }) gives. */
export const withIndexed = (text, indexed) => `${text.slice(0, -1)},"indexed":${JSON.stringify(indexed ?? null)}}`;
/**
 * A prepareJson result for a JSON object, with `"indexed": n` appended as its last key, without encoding the
 * 13 MB map text again: the bytes are spliced (one copy, ≈ 1 ms), the ETag is prepareJsonText's sha1 over
 * the new bytes (≈ 4 ms; hashing the text again cost 16 ms and re-encoding it 20 ms), gzip and brotli are
 * made lazily with prepareJsonText's settings. Same fields and bytes as prepareJsonText(withIndexed(text, n)).
 */
export function preparedWithIndexed(prepared, indexed) {
  const end = prepared.bytes.length - 1;
  if (end < 1 || prepared.bytes[end] !== 0x7d) return prepareJsonText(withIndexed(prepared.text, indexed)); // not an object: never for the map bodies
  const tail = `,"indexed":${JSON.stringify(indexed ?? null)}}`;
  const bytes = Buffer.concat([prepared.bytes.subarray(0, end), Buffer.from(tail, "utf8")]);
  const p = { text: prepared.text.slice(0, -1) + tail, bytes, etag: etagOf(bytes), br: null, gz: null };
  p.encoded = (enc) => {
    if (enc === "br") return (p.br ??= brotliCompressSync(bytes, { params: { [Z.BROTLI_PARAM_QUALITY]: 4 } }));
    if (enc === "gzip") return (p.gz ??= gzipSync(bytes, { level: 6 }));
    return bytes;
  };
  return p;
}

/** Trades → OHLC candles of `res` seconds; USD when every trade has a USD price, else quote units. */
export function buildCandles(trades, res) {
  const usd = trades.length > 0 && trades.every((t) => t.priceUsd != null);
  const key = usd ? "priceUsd" : "priceQuote";
  const buckets = new Map();
  for (const t of trades) {
    const bucket = Math.floor(t.time / res) * res;
    const price = t[key];
    const vol = usd ? (t.valueUsd ?? 0) : Number(BigInt(t.quoteAmount));
    const c = buckets.get(bucket);
    if (!c) buckets.set(bucket, { t: bucket, o: price, h: price, l: price, c: price, v: vol });
    else { c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.v += vol; }
  }
  return { candles: [...buckets.values()].sort((a, b) => a.t - b.t), priceKey: usd ? "usd" : "quote" };
}

/**
 * Health: what a load balancer and an operator need in one read. `ok` turns false when the live
 * socket has been down for a while or the refresh loop stalled; `?strict=1` makes that a 503 so a
 * probe can act on it, while the default stays 200 so a glance always gets the numbers.
 */
export function healthOf({ model, indexer, hub, images, meta, metahost, treasury, rpc, startedAt, v1 = null, agents = null }) {
  const snap = indexer?.snapshot?.() ?? {};
  const now = nowS(), uptimeS = now - startedAt;
  const ws = snap.live ?? null;
  const lagS = snap.lastRefreshAt ? now - snap.lastRefreshAt : null;
  const wsDown = ws ? !ws.connected && (ws.lastMessageAgoMs == null ? uptimeS > 120 : ws.lastMessageAgoMs > 120_000) : false;
  const stalled = lagS != null ? lagS > 300 : uptimeS > 300;
  const ok = !wsDown && !stalled;
  const mem = process.memoryUsage();
  return {
    ok, status: ok ? "ok" : "degraded", now, uptimeS, mode: model.mode, coins: model.coins.size, ourCoins: model.scope().ours.size,
    indexer: { phase: snap.phase ?? null, lagS, lastRefreshAt: snap.lastRefreshAt ?? null, lastVaultsAt: snap.lastVaultsAt ?? null, pricingPoolsAt: snap.pricingPoolsAt ?? null, lastError: snap.lastError ?? null, backfill: { ...model.backfill }, created: snap.created ?? null, map: snap.map ?? null },
    map: { ...(model.mapStats ?? {}), total: model.mapCache?.total ?? null, cachedVersion: model.mapCache?.version ?? null, dirty: model.dirty?.size ?? 0, family: model.familyStats ? { ...model.familyStats, ...model.familyHeld() } : null },
    ws: ws ? { connected: ws.connected, lastMessageAgoMs: ws.lastMessageAgoMs, connects: ws.connects, errors: ws.errors, backoffMs: ws.backoffMs ?? null, reconnecting: !!ws.reconnecting } : null,
    activity: model.activity ? { ...model.activity.size(), seededMs: model.activity.seededMs ?? null } : null,
    rpc: rpc?.snapshot?.() ?? snap.rpc ?? null, rpcLanes: rpc?.laneSnapshot?.() ?? null, meta: meta?.snapshot?.() ?? meta?.stats ?? snap.meta ?? null, images: images?.stats ?? null,
    metahost: metahost ? { ...metahost.stats, quota: metahost.quota?.snapshot?.() ?? null } : null, treasury: treasury?.stats ?? null,
    sse: hub?.clients?.size ?? 0, sseStats: hub?.stats ?? null, v1: v1?.snapshot?.() ?? null, agents: agents ? { ...(agents.runner?.snapshot?.() ?? { mode: agents.mode }), live: agents.live?.snapshot?.() ?? null, vault: !!agents.vault, ledger: agents.ledger?.snapshot?.() ?? null } : null, solUsd: model.solUsd, memoryMb: { rss: Math.round(mem.rss / 1e6), heap: Math.round(mem.heapUsed / 1e6) },
  };
}

export function createApp({ model, indexer, rpc, hub, images, meta, metahost = null, treasury = null, metaDir = null, platformWallet, splitBps, launchFeeSol = DEFAULT_LAUNCH_FEE_SOL, distDir, origins = [], log = console,
  rates = null, trustProxy = "loopback", hsts = "auto", logSample = 0.1, pagesDomain = null, cspConnect = [], apiKeys = null, publicUrl = DEFAULT_PUBLIC_URL, v1Limits = {}, agents = null, card = null, now = Date.now }) {
  const app = express();
  const startedAt = nowS();
  const launchFee = launchFeeOf(launchFeeSol, platformWallet);
  // Request-driven chain reads run on the RPC's "api" lane so they can never starve the indexer.
  const apiRpc = typeof rpc?.lane === "function" ? rpc.lane("api") : rpc;
  const limitOf = (name) => ({ limit: rates?.[name]?.limit ?? DEFAULT_RATES[name][0], windowMs: rates?.[name]?.windowMs ?? DEFAULT_RATES[name][1], name, now });
  const limits = { api: rateLimit(limitOf("api")), img: rateLimit(limitOf("img")), rpc: rateLimit(limitOf("rpc")), upload: rateLimit(limitOf("upload")), spawned: rateLimit(limitOf("spawned")), sse: rateLimit(limitOf("sse")) };
  // Share cards (lib/card.mjs: `cardData`, `renderCard`) load on first use: the renderer carries fonts
  // and a wasm rasterizer no other route needs, and a test injects its own `card`. A failed load is
  // retried after CARD_RETRY_MS; meanwhile the card route answers 503 and pages keep the static tags.
  let cardMod = card, cardFailAt = -Infinity;
  const cardLib = async () => {
    if (cardMod) return cardMod;
    if (now() - cardFailAt < CARD_RETRY_MS) return null;
    try { cardMod = await import("./card.mjs"); } catch (e) { cardFailAt = now(); log.warn?.(`card: renderer unavailable: ${String(e?.message ?? e).slice(0, 200)}`); return null; }
    return cardMod;
  };
  const spawnedCache = new Map(); // sig → { at, result }
  // Root agents (DESIGN §13): read-only views of what the runner stored; the runner itself lives in index.mjs.
  const ag = { registry: agents?.registry ?? new AgentRegistry(model.db), mode: agents?.mode ?? "off", cooldownMin: agents?.cooldownMin ?? 60, dataDir: agents?.dataDir ?? null, runner: agents?.runner ?? null, vault: agents?.vault ?? null, live: agents?.live ?? null };
  // The site's view of the agents (DESIGN §13.2): the ledger tailed per request, wallet balances
  // from the live pass or the RPC (60 s cache), only public agents (Spore roots, or running ones).
  ag.ledger = agents?.ledger ?? (ag.dataDir ? new AgentLedger(join(ag.dataDir, "agents", "ledger.jsonl"), { log, now }) : null);
  ag.balances = agents?.balances ?? createAgentBalances({ rpc: apiRpc, model, live: ag.live, now, log });
  // Owner briefs (DESIGN §13.3): only their presence and mode reach the views.
  ag.briefs = agents?.briefs ?? (ag.dataDir ? createBriefStore(ag.dataDir, { log }) : null);
  /** View options once the ledger caught up and the balances of `roots` (default: every public agent) were read. */
  ag.viewOpts = async ({ base = "", abs } = {}, roots = null) => {
    ag.ledger?.refresh();
    const rows = (roots ?? ag.registry.list().map((r) => r.root_mint)).map((m) => ag.registry.get(m)).filter((r) => r && isPublicAgent(r, model));
    await ag.balances.prime(rows.map((r) => ({ root: r.root_mint, address: ag.registry.walletAddress(r.root_mint, ag.vault) })));
    return { model, registry: ag.registry, mode: ag.mode, cooldownMin: ag.cooldownMin, now: Math.floor(now() / 1000), base, abs, ledger: ag.ledger, vault: ag.vault, wallets: (root, address) => ag.balances.get(root, address), liveState: ag.live?.state ?? null, briefs: ag.briefs };
  };
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("trust proxy", trustProxy);
  app.use(securityHeaders({ hsts }));
  app.use(requestLog({ log, sample: logSample }));
  app.use(compression());
  app.use(cors(origins));
  // Body caps per route: the upload carries a data-URL image, nothing else needs more than a few KB.
  const smallJson = express.json({ limit: BODY_LIMIT }), uploadJson = express.json({ limit: UPLOAD_BODY_LIMIT });
  app.use((req, res, next) => (req.path === "/api/upload" ? next() : smallJson(req, res, next)));
  // Default no-store for the API; the cached readers below override it per response.
  app.use("/api", (req, res, next) => {
    res.setHeader("cache-control", "no-store");
    if (req.method === "GET" && req.path !== "/img" && req.path !== "/logo-sheet" && req.path !== "/events" && !req.path.startsWith("/agents/img/") && !req.path.startsWith("/card/")) return limits.api(req, res, next);
    next();
  });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const view = (c) => model.view(c);
  const spawns = () => model.visibleSpawns();
  // Partner API (DESIGN §12): read-only, CORS *, keyed tiers, its own rate limits and stream.
  const v1 = createV1({ model, indexer, apiRpc, hub, meta, apiKeys: apiKeys ?? new ApiKeys(model.db, { log }), isMint, publicUrl, limits: v1Limits, log, now, agents: ag });
  app.locals.v1 = v1;

  app.get("/api/stats", (req, res) => sendCachedJson(req, res, model.stats(), { maxAge: 3 }));
  app.get("/api/health", (req, res) => {
    const h = healthOf({ model, indexer, hub, images, meta, metahost, treasury, rpc, startedAt, v1, agents: ag });
    res.status(!h.ok && req.query.strict != null ? 503 : 200).json(h);
  });

  app.get("/api/feed", (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const before = req.query.before != null ? Number(req.query.before) : null;
    let coins = spawns();
    if (Number.isFinite(before)) coins = coins.filter((c) => c.createdAt != null && c.createdAt < before);
    coins.sort((a, b) => (b.createdAt ?? -1) - (a.createdAt ?? -1) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    sendCachedJson(req, res, { coins: coins.slice(0, limit).map(view) }, { maxAge: 5 });
  });

  app.get("/api/roots", (req, res) => {
    const sort = ["locked", "children", "new", "volume"].includes(req.query.sort) ? req.query.sort : "locked";
    const limit = clampInt(req.query.limit, 50, 1, 200), offset = clampInt(req.query.offset, 0, 0, 100_000);
    const roots = model.visibleRoots().map(view);
    const lastSpawn = (r) => Math.max(0, ...model.visibleChildren(r.mint).map((c) => c.createdAt ?? 0));
    const cmp = { locked: byLocked, children: (a, b) => b.descendants - a.descendants || byLocked(a, b), new: (a, b) => lastSpawn(b) - lastSpawn(a) || byLocked(a, b), volume: (a, b) => b.volume24hUsd - a.volume24hUsd || byLocked(a, b) }[sort];
    roots.sort(cmp);
    sendCachedJson(req, res, { roots: roots.slice(offset, offset + limit), total: roots.length }, { maxAge: 5 });
  });

  app.get("/api/coin/:mint", wrap(async (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    let c = model.get(mint);
    if (!c) { try { c = await indexer.fetchCoin(mint, { rpc: apiRpc }); } catch (e) { log.warn(`coin ${mint}: live lookup failed: ${e.message}`); } }
    if (!c) return res.status(404).json({ error: "unknown mint" });
    model.touch(mint);
    const uri = model.mint(mint)?.uri; if (uri) meta?.request(uri, { front: true });
    // Children: every pump.fun pair under the coin by default (the coin page and partners see the whole
    // tree, like the map); `scope=ours` keeps the listing-mode view (only our children, `otherChildren`
    // says how many pump.fun leaves out). `children=0` / `trades=0` keep the shape but leave those
    // lists empty: the map's side panel needs only the coin, and a big root's children cost a view() each.
    // Counts and locked value follow the same scope: every pump.fun child (scopedAll, as the map) by
    // default, so scopedAll.children == childrenOf().length and otherChildren is 0 (coin-scope.test.mjs).
    const oursOnly = req.query.scope === "ours";
    const vw = (x) => model.view(x, { all: !oursOnly });
    const coin = vw(c);
    const kids = oursOnly ? model.visibleChildren(mint) : model.childrenOf(mint);
    const children = off(req.query.children) ? [] : kids.map(vw).sort(byLocked);
    const trades = off(req.query.trades) ? [] : model.db.tradesFor(mint, 50);
    sendCachedJson(req, res, { coin, children, otherChildren: coin.otherChildren, trades }, { maxAge: 3 });
  }));

  app.get("/api/tree/:mint", (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    const root = model.get(mint);
    if (!root) return res.status(404).json({ error: "unknown mint" });
    const depth = clampInt(req.query.depth, 3, 0, 6), limit = clampInt(req.query.limit, 100, 1, 500);
    const oursOnly = req.query.scope === "ours";   // default: the whole pump.fun tree under the coin (as the map); scope=ours = listing-mode children only
    const vw = (x) => model.view(x, { all: !oursOnly });
    let nodes = 0;
    const node = (c, left) => {
      nodes++;
      const all = oursOnly ? model.visibleChildren(c.mint) : model.childrenOf(c.mint);
      const kids = left > 0 && nodes < 5_000 ? all.map(vw).sort(byLocked).slice(0, limit) : [];
      const coin = vw(c);
      return { coin, children: kids.map((k) => node(model.get(k.mint), left - 1)) };
    };
    sendCachedJson(req, res, node(root, depth), { maxAge: 5 });
  });

  // The indexed forest for the bubble map. `limit=all` (DESIGN §11.5) is the whole thing: every
  // root and every descendant, no fan-out cap, built from mapRef only and cached per model version
  // for 10 s with its encoded bytes; `since=<ms>` returns just the nodes whose `updatedAt` moved
  // after that instant (flat, with `parentMint`), so a client with a cache asks for the new ones.
  // `limit=<n>` keeps the top-n behaviour: top roots by locked value, each with its children and
  // grandchildren, per-node fan-out capped so one root with hundreds of children cannot make the
  // payload (or the client's simulation) explode.
  // `scope=all` draws every pump.fun pair the indexer knows, whatever the listing mode: the map is
  // the one place that shows the whole ecosystem, with our launches flagged by `ours` on each node.
  app.get("/api/map", (req, res) => {
    const all = req.query.scope === "all";
    if (req.query.limit === "all") {
      const since = req.query.since != null && req.query.since !== "" ? Number(req.query.since) : null;
      if (since != null && !Number.isFinite(since)) return res.status(400).json({ error: "since must be a millisecond timestamp" });
      const depth = req.query.depth != null && req.query.depth !== "" ? clampInt(req.query.depth, model.mapDepth(), 0, 6) : model.mapDepth();
      const entry = since != null ? model.mapSince({ all, since }) : model.mapAll({ all, depth });
      // These bodies carry `indexed` (the map's nodes + the asset-family coins it leaves undrawn, stored on
      // the entry at build time). /v1 shares `entry.prepared` without it, so the /api bytes are their own
      // slot, spliced from the same encoded JSON (DESIGN-FAMILY-ALL §4.5).
      if (!entry.apiPrepared) {
        const t0 = performance.now();
        entry.prepared ??= prepareJson(entry.body);
        entry.apiPrepared = preparedWithIndexed(entry.prepared, entry.indexed);
        entry.encodeMs = Math.round(performance.now() - t0);
      }
      if (entry.buildMs != null) res.setHeader("x-map-build-ms", String(entry.buildMs)); // tree walk + mapRef; the JSON encode is x-map-encode-ms
      if (entry.encodeMs != null) res.setHeader("x-map-encode-ms", String(entry.encodeMs));
      return sendPrepared(req, res, entry.apiPrepared, { maxAge: 10 });
    }
    const limit = clampInt(req.query.limit, 60, 1, 200), depth = clampInt(req.query.depth, 2, 0, 4), fanout = clampInt(req.query.fanout, 40, 1, 200);
    const d = model.computed();
    const stat = (c) => (all ? model.scopedAll(c) : model.scoped(c));
    const locked = (c) => stat(c).lockedUsd ?? -1, mcap = (c) => d.get(c.mint)?.priceUsd ?? -1; // same 1B supply everywhere: price orders like mcap
    const cmp = (a, b) => locked(b) - locked(a) || mcap(b) - mcap(a) || stat(b).descendants - stat(a).descendants;
    const roots = (all ? model.allRoots() : model.visibleRoots()).sort(cmp).slice(0, limit);
    const kids = (mint) => (all ? model.childrenOf(mint) : model.visibleChildren(mint));
    const node = (c, left) => ({ coin: model.mapRef(c, all), children: left > 0 ? kids(c.mint).sort(cmp).slice(0, fanout).map((k) => node(k, left - 1)) : [] });
    sendCachedJson(req, res, { roots: roots.map((r) => node(r, depth)), scope: all ? "all" : model.mode }, { maxAge: 10 });
  });

  // Per-mint trade activity for the map (DESIGN §11.5 "Activity (heat)"): trades in the last hour and
  // day, 24 h USD volume, buys in the last hour and the last trade's time, as parallel arrays over
  // every tracked coin with a trade in 24 h, whatever SHOW (the map is the all-scope surface). A
  // sidecar rather than part of /api/map: it decays with the clock without any row changing, so it
  // cannot ride on `since=`. Built from the in-memory counters at most every 15 s.
  app.get("/api/map/heat", (req, res) => {
    const entry = model.heatEntry();
    if (!entry.prepared) { const t0 = performance.now(); entry.prepared = prepareJson(entry.body); entry.encodeMs = Math.round(performance.now() - t0); }
    res.setHeader("x-heat-build-ms", String(entry.buildMs ?? 0));
    if (entry.encodeMs != null) res.setHeader("x-heat-encode-ms", String(entry.encodeMs));
    return sendPrepared(req, res, entry.prepared, { maxAge: 15 });
  });

  // One family's coins, biggest first, in pages (DESIGN-FAMILY-ALL §4): every coin quoted in a listed
  // asset (the full map draws a capped slice of those, ASSET_FAMILY_DRAW; the page fills the rest in from
  // here), or the tracked direct children of any tracked coin ([] for a leaf). Always the all-scope view,
  // whatever SHOW. Rows are positional `[mint, symbol, mcapUsd, lockedUsd, createdAt, migrated, children]`
  // (model.familyEntry); `v` pins the snapshot a client pages through (held 120 s after its last read, an
  // unknown or dropped `v` gets the current one), and each (offset, limit) page is encoded once per snapshot
  // and kept with it (model.familyPagePut); its JSON text is dropped once encoded, only the bytes are sent.
  app.get("/api/map/family/:mint", (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    const rawV = typeof req.query.v === "string" && req.query.v !== "" ? Number(req.query.v) : NaN;
    const snap = model.familyEntry(mint, Number.isFinite(rawV) ? rawV : null);
    if (!snap) return res.status(404).json({ error: "unknown family" });
    const limit = clampInt(req.query.limit, FAMILY_PAGE, 1, FAMILY_PAGE_MAX), offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const key = `${offset}:${limit}`;
    let page = snap.pages.get(key);
    if (!page) {
      const total = snap.rows.length, nodes = offset < total ? snap.rows.slice(offset, offset + limit) : [];
      const end = offset + nodes.length;
      page = prepareJson({ mint, v: snap.v, total, offset, next: nodes.length > 0 && end < total ? end : null, nodes });
      page.text = null;
      model.familyPagePut(snap, key, page);
    }
    res.setHeader("x-family-build-ms", String(snap.buildMs));
    return sendPrepared(req, res, page, { maxAge: 10 });
  });

  // Each family's share of the whole map's value (DESIGN §11.5 "Dominance"), for pages that do not load
  // the map (the coin page): `mode=mcap|locked` (mcap by default, owner 2026-10-21) sizes it as the map's bubbles do,
  // `mint=<top>` answers just that family's row (`families` is then [] or one row; `total` is always
  // the whole map's). Built from the cached all-scope forest, kept 30 s per mode with its encoded bytes.
  const dominance = new Map(); // mode → { at, body, prepared }
  app.get("/api/map/dominance", (req, res) => {
    const m = req.query.mode;
    const mode = m == null || m === "" || m === "mcap" ? "mcap" : m === "locked" ? "locked" : null;
    if (!mode) return res.status(400).json({ error: "mode must be locked or mcap" });
    const mint = req.query.mint != null && req.query.mint !== "" ? String(req.query.mint) : null;
    if (mint != null && !isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    let entry = dominance.get(mode);
    if (!entry || now() - entry.at >= DOMINANCE_CACHE_MS) {
      entry = { at: now(), body: familyShares(model.mapAll({ all: true }).body.roots, mode), prepared: null };
      dominance.set(mode, entry);
    }
    if (mint == null) { entry.prepared ??= prepareJson(entry.body); return sendPrepared(req, res, entry.prepared, { maxAge: 30 }); }
    const row = entry.body.families.find((f) => f.mint === mint);
    sendCachedJson(req, res, { mode, total: entry.body.total, families: row ? [row] : [] }, { maxAge: 30 });
  });

  // `scope=all` opens the chart of any tracked coin to the map's side panel (the map shows every
  // pump.fun pair, DESIGN §11.5); without it, ours mode keeps charts to our coins and their ancestors.
  app.get("/api/candles/:mint", (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    const c = model.get(mint);
    if (!c) return res.status(404).json({ error: "unknown mint" });
    if (req.query.scope === "all") { if (!c.tracked) return res.status(404).json({ error: "not tracked" }); }
    else if (!model.inScope(mint)) return res.status(404).json({ error: "not a Spore coin" }); // ours mode: charts only for our coins and their ancestors
    const resSec = clampInt(req.query.res, 60, 15, 86_400);
    const trades = model.db.tradesSince(mint, nowS() - resSec * 500);
    sendCachedJson(req, res, buildCandles(trades, resSec), { maxAge: 5 });
  });

  // An exact mint that the index does not know (any pump.fun coin: the parent picker and the search
  // box accept all of pump.fun, DESIGN §11.1) is looked up live, like /api/coin/:mint does; the
  // verdict is cached per mint there, so a repeated paste costs no RPC.
  app.get("/api/search", wrap(async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 64);
    if (!q) return res.json({ coins: [] });
    if (isMint(q)) {
      let c = model.get(q);
      if (!c) { try { c = await indexer.fetchCoin(q, { rpc: apiRpc }); } catch (e) { log.warn(`search ${q}: live lookup failed: ${e.message}`); } }
      return res.json({ coins: c ? [model.view(c, { all: true })] : [] });
    }
    const needle = q.toLowerCase().replace(/^\$/, "");
    const d = model.computed();
    const scored = [];
    for (const c of model.tracked()) {
      const { name, symbol } = model.nameOf(c.mint);
      const sym = (symbol ?? "").toLowerCase(), nm = (name ?? "").toLowerCase();
      const score = sym === needle ? 3 : sym.startsWith(needle) ? 2 : nm.startsWith(needle) ? 1 : 0;
      if (score) scored.push({ c, score, locked: d.get(c.mint)?.lockedUsd ?? -1, children: d.get(c.mint)?.children ?? 0 });
    }
    scored.sort((a, b) => b.score - a.score || b.locked - a.locked || b.children - a.children);
    res.json({ coins: scored.slice(0, 20).map((s) => model.view(s.c, { all: true })) }); // all-scope numbers, like the coin page
  }));

  app.get("/api/eligibility/:mint", wrap(async (req, res) => {
    const { mint } = req.params;
    const creator = typeof req.query.creator === "string" && isMint(req.query.creator) ? req.query.creator : null;
    // "sol" = a root coin quoted in SOL: the launch tab's default pool. Always admissible; same split.
    // A root's split is three-way (DESIGN §13.1): creator / Spore / the root's agent wallet. The
    // wallet does not exist until POST /api/agents/prepare, so the preview states the agent's bps
    // with no address; the browser pins the same numbers and fills the address in at launch.
    if (mint.toLowerCase() === "sol") {
      const shares = rootShares({ creator, platform: platformWallet });
      return res.json({ ok: true, reason: null, depth: 0, chain: [], parentCreator: null, grandparentCreator: null, shares, platform: platformWallet, launchFee, pool: "sol",
        agent: { bps: ROOT_SPLIT_BPS.agent, address: null, models: AGENT_MODELS.map((m) => m.id), defaultModel: DEFAULT_MODEL, ready: !!ag.vault, seedLamports: 10_000_000 } });
    }
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    res.json({ ...await checkEligibility({ mint, creator, model, indexer, rpc: apiRpc, platformWallet, splitBps }), launchFee, pool: mint });
  }));

  // Read-only treasury (DESIGN §11.4): the platform's pending creator-fee share by quote mint.
  app.get("/api/treasury", wrap(async (req, res) => {
    if (!treasury) return res.json({ platform: platformWallet, ourCoins: 0, pendingByQuote: [], coins: [], updatedAt: nowS() });
    try { sendCachedJson(req, res, await treasury.get(), { maxAge: 30 }); }
    catch (e) { res.status(503).json({ error: `treasury unavailable: ${String(e.message ?? e).slice(0, 200)}` }); }
  }));

  // Pending creator fees of one coin for the coin page's "Creator fees" card (DESIGN §11.6): the fee
  // accounts read live on the api lane and cached 15 s per mint, so the page can show the split and
  // the browser can decide whether the permissionless claim is worth a transaction. A coin the index
  // does not know is looked up live like /api/coin does. Nothing is signed here.
  app.get("/api/fees/:mint", wrap(async (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    let c = model.get(mint);
    if (!c) { try { c = await indexer.fetchCoin(mint, { rpc: apiRpc }); } catch (e) { log.warn(`fees ${mint}: live lookup failed: ${e.message}`); } }
    if (!c) return res.status(404).json({ error: "unknown mint" });
    if (!treasury) return res.status(503).json({ error: "fees unavailable" });
    try { sendCachedJson(req, res, await treasury.fees(c, { rpc: apiRpc }), { maxAge: 5 }); }
    catch (e) { res.status(503).json({ error: `fees unavailable: ${String(e.message ?? e).slice(0, 200)}` }); }
  }));

  // The Claim page (DESIGN §11.7). /api/claims/:wallet lists every indexed coin whose fee-sharing
  // config names the wallet, with its pending fees and the wallet's part; /api/claims lists the Spore
  // launches with the most fees waiting (a payout is permissionless, anyone may trigger it). Both
  // read the fee accounts in batches through the per-mint cache /api/fees uses. Nothing is signed.
  const CLAIMS_MAX = 100, claimsPublic = { at: 0, value: null, inFlight: null }, CLAIMS_PUBLIC_MS = 30_000;
  const claimRow = (c, v) => ({ ...model.ref(c), ...v, migrated: v.migrated });
  app.get("/api/claims/:wallet", wrap(async (req, res) => {
    const { wallet } = req.params;
    if (!isMint(wallet)) return res.status(400).json({ error: "invalid wallet" });
    if (!treasury) return res.status(503).json({ error: "claims unavailable" });
    const coins = model.tracked().filter((c) => c.shares?.some((s) => s.address === wallet)).slice(0, CLAIMS_MAX);
    try {
      const views = await treasury.feesMany(coins, { rpc: apiRpc });
      const byMint = new Map(coins.map((c) => [c.mint, c]));
      const rows = views.map((v) => ({ ...claimRow(byMint.get(v.mint), v), ...shareOf(v, wallet) }))
        .sort((a, b) => (b.yourUsd ?? -1) - (a.yourUsd ?? -1) || Number(BigInt(b.yourAmount) - BigInt(a.yourAmount)));
      sendCachedJson(req, res, { wallet, coins: rows, totals: claimTotals(rows, "yourAmount"), updatedAt: nowS() }, { maxAge: 5 });
    } catch (e) { res.status(503).json({ error: `claims unavailable: ${String(e.message ?? e).slice(0, 200)}` }); }
  }));
  app.get("/api/claims", wrap(async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, CLAIMS_MAX);
    if (!treasury) return res.status(503).json({ error: "claims unavailable" });
    const fresh = claimsPublic.value && now() - claimsPublic.at < CLAIMS_PUBLIC_MS;
    if (!fresh) {
      claimsPublic.inFlight ??= (async () => {
        const coins = model.tracked().filter((c) => model.isOurCoin(c) && c.shares?.length);
        const views = await treasury.feesMany(coins, { rpc: apiRpc });
        const byMint = new Map(coins.map((c) => [c.mint, c]));
        const rows = views.map((v) => claimRow(byMint.get(v.mint), v)).filter((r) => BigInt(r.total) > 0n)
          .sort((a, b) => (b.totalUsd ?? -1) - (a.totalUsd ?? -1));
        claimsPublic.value = { coins: rows, totals: claimTotals(rows, "total") }; claimsPublic.at = now();
      })().finally(() => { claimsPublic.inFlight = null; });
      try { await claimsPublic.inFlight; } catch (e) { if (!claimsPublic.value) return res.status(503).json({ error: `claims unavailable: ${String(e.message ?? e).slice(0, 200)}` }); }
    }
    const v = claimsPublic.value;
    sendCachedJson(req, res, { coins: v.coins.slice(0, limit), totals: v.totals, updatedAt: Math.floor(claimsPublic.at / 1000) }, { maxAge: 10 });
  }));

  // The Spawn page reports a signed spawn so the coin shows as ours at once. Nothing is taken on
  // trust: the transaction is read back from the chain and must carry a pump CreateEvent for the
  // mint, a wallet creator and the launch fee paid to the platform (lib/spawned.mjs) before the
  // coin is flagged pending; the indexer then confirms it from the fee-sharing config (DESIGN
  // §11.1) and the pending flag expires after a few minutes otherwise. Verified signatures are
  // remembered so a retry (the UI sends one) costs no RPC; refused ones too.
  app.post("/api/spawned", limits.spawned, wrap(async (req, res) => {
    const { mint, sig } = req.body || {};
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    if (!isSig(sig)) return res.status(400).json({ error: "the launch transaction signature is required" });
    const known = model.get(mint);
    if (known && model.isOurs(known)) return res.json({ ok: true, mint, ...model.oursOf(known), verified: true, coin: view(known) });
    const pend = model.pending.get(mint);
    if (pend && pend.sig === sig && model.oursOf(known ?? { mint }).oursPending) return res.json({ ok: true, mint, ours: false, oursPending: true, verified: true, coin: known ? view(known) : null });
    let hit = spawnedCache.get(sig);
    if (!hit || now() - hit.at > (hit.result.notFound ? SPAWNED_NOTFOUND_MS : SPAWNED_CACHE_MS)) {
      let tx = null;
      try { tx = await apiRpc.getTransaction(sig); } catch (e) { log.warn(`spawned: ${sig.slice(0, 12)}…: getTransaction failed: ${e.message}`); return res.status(502).json({ error: "could not read the transaction, retry in a few seconds", retryAfter: 3 }); }
      hit = { at: now(), result: verifySpawnTx(tx, { mint, platformWallet, feeLamports: BigInt(launchFee.lamports) }) };
      spawnedCache.set(sig, hit);
      if (spawnedCache.size > 1_000) spawnedCache.delete(spawnedCache.keys().next().value);
    }
    const v = hit.result;
    if (!v.ok) {
      log.info?.(`spawned: ${mint} refused (${sig.slice(0, 12)}…): ${v.reason}`);
      if (v.notFound) { res.setHeader("retry-after", "3"); return res.status(404).json({ error: "transaction not found yet, retry in a few seconds", retryAfter: 3 }); }
      return res.status(400).json({ error: v.reason });
    }
    if (v.create.mint !== mint) return res.status(400).json({ error: "signature belongs to another mint" }); // the cache is per signature; the mint must match it
    // The pending window is anchored to the block time; a transaction the RPC returns without one
    // is still adopted, but not flagged pending (a report-time anchor could be renewed forever).
    if (v.blockTime) model.markPending(mint, sig, { feePaid: v.feePaid.toString(), at: v.blockTime * 1000 });
    const c = indexer.adopt ? await indexer.adopt(mint, { create: v.create, slot: v.slot, feePaid: v.feePaid }) : known;
    const flags = c ? model.oursOf(c) : { ours: false, oursPending: true };
    log.info?.(`spawned: ${mint} verified (${sig.slice(0, 12)}…, fee ${v.feePaid} lamports) → ours=${flags.ours} pending=${flags.oursPending}`);
    // A root launch reports the agent wallet it was prepared with (DESIGN §13.1): the pending wallet
    // is bound to this mint and the agent enabled with the model the creator picked. The id is a
    // 128-bit secret only the launching browser received; a wrong or reused id binds nothing.
    // The report alone never binds: the pending wallet must have been prepared by this launch's
    // creator AND the mint's indexed fee split must name its address at the agent's share. When the
    // split is not indexed yet (it can be the launch's second transaction), the chain reconciler
    // (lib/agents-live/reconcile.mjs) binds it as soon as the config appears.
    let agent = null;
    const a = req.body?.agent;
    if (a && typeof a === "object" && ag.vault && v.create.quoteMint == null) {
      try {
        const pend = ag.vault.pending(String(a.id ?? ""));
        if (pend.creator && pend.creator !== v.create.creator) throw new Error("prepared by another wallet");
        const named = (c ?? known)?.shares?.some((s) => s.address === pend.address && s.bps === ROOT_SPLIT_BPS.agent);
        if (!named) { agent = { root: mint, address: pend.address, model: null, bound: false, note: "split not indexed yet; bound once it is" }; }
        else {
          const mdl = modelInfo(a.model) ? a.model : modelInfo(pend.model) ? pend.model : DEFAULT_MODEL;
          const b = ag.vault.bind(pend.pending, mint);
          ag.registry.enable(mint, { model: mdl, wallet: b.address });
          agent = { root: mint, address: b.address, model: mdl, bound: true };
          log.info?.(`agents: ${mint} agent wallet ${b.address} bound (model ${mdl})`);
        }
      } catch (e) { log.warn?.(`agents: ${mint}: agent not bound: ${String(e.message ?? e).slice(0, 160)}`); }
    }
    res.json({ ok: true, mint, ...flags, verified: true, feePaid: v.feePaid.toString(), coin: c ? view(c) : null, agent });
  }));

  // Root agents (DESIGN §13, §13.2): every public agent with its profile, live momentum, latest
  // proposal, wallet, totals, launched coins and recent activity; one agent with its proposals and
  // its activity page; what the coin page shows; the proposals' logos. Read-only: nothing here starts a run.

  // A root about to launch asks for its agent wallet (DESIGN §13.1): the vault makes a keypair,
  // keeps the key, and only the public address leaves here, to be written into the fee split the
  // creator signs. Bound to the mint by POST /api/spawned; unbound wallets are swept after an hour
  // (they never held funds). Rate-limited like uploads: a wallet per request is cheap but not free.
  app.post("/api/agents/prepare", limits.upload, wrap(async (req, res) => {
    if (!ag.vault) return res.status(503).json({ error: "agent wallets are not configured on this server" });
    const { creator, model: mdl } = req.body || {};
    if (!isMint(creator)) return res.status(400).json({ error: "creator must be the launching wallet" });
    if (!modelInfo(mdl)) return res.status(400).json({ error: `model must be one of ${AGENT_MODELS.map((m) => m.id).join(", ")}` });
    ag.vault.sweepPending();
    // Always a fresh wallet: one address must never sit in two roots' splits (review finding A5). An unused
    // wallet costs a 600-byte file and is never deleted, so a retried launch simply gets another.
    const p = ag.vault.prepare({ creator, model: mdl });
    res.json({ id: p.id, address: p.address, model: mdl, bps: ROOT_SPLIT_BPS.agent, expiresAt: p.createdAt + 3600 });
  }));
  app.get("/api/agents", wrap(async (req, res) => sendCachedJson(req, res, agentsBody(await ag.viewOpts()), { maxAge: 10 })));
  // The coin page's question: is this mint an agent's root, a coin an agent launched, or neither (null role, never 404).
  app.get("/api/agents/coin/:mint", wrap(async (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    const o = await ag.viewOpts({}, [mint, ag.registry.launchOf(mint)?.root_mint].filter(Boolean));
    sendCachedJson(req, res, agentCoinBody(mint, o), { maxAge: 10 });
  }));
  app.get("/api/agents/img/:file", limits.img, (req, res) => {
    const { file } = req.params;
    const path = ag.dataDir && IMAGE_FILE_RE.test(file) && ag.registry.knowsImage(file) ? join(ag.dataDir, "agents", file) : null;
    if (!path || !existsSync(path)) return res.status(404).json({ error: "not found" });
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", "public, max-age=31536000, immutable"); // the name is random per proposal and the file never changes
    res.setHeader("cross-origin-resource-policy", "cross-origin"); // /v1 hands these URLs to partner pages
    res.sendFile(path);
  });
  app.get("/api/agents/:root", wrap(async (req, res) => {
    const { root } = req.params;
    if (!isMint(root)) return res.status(400).json({ error: "invalid mint" });
    const body = agentBody(root, await ag.viewOpts({}, [root]));
    if (!body) return res.status(404).json({ error: "no agent for this coin" });
    sendCachedJson(req, res, body, { maxAge: 10 });
  }));

  app.get("/api/events", limits.sse, (req, res) => hub.attach(req, res));
  // The proxy serves only images the API handed out (a known coin's image or our own host).
  app.get("/api/img", limits.img, images.handler({ known: (u) => model.knownImage(u) }));
  // One image of up to 256 mints' 64 px logos for the map (same files as /api/img?w=64, one request instead of 256).
  // Without a sheet-capable cache the route is absent (404), which the map reads as "no sheets here".
  if (typeof images?.sheetHandler === "function") app.get("/api/logo-sheet", limits.img, images.sheetHandler({ imageOf: (m) => model.imageOfMint(m), isMint }));
  // The share card: a 1200×630 PNG of one coin, the og:image of /c/<mint> and /map?focus=<mint>
  // (lib/og.mjs). Crawlers fetch it from their own hosts, hence CORS * and the cross-origin resource
  // policy; the renderer keeps a per-mint cache and its ETag lets a re-check cost nothing. Counted
  // against the image limit. A coin the index has not seen is looked up live once, like /api/coin,
  // and that lookup draws on the API bucket too (it is a chain read, the picture is not), so a scan
  // of made-up mints cannot buy more RPC calls here than it could there. A cold card is drawn on the
  // image worker thread, and only CARD_MAX_INFLIGHT of them wait at once: past that the answer is the
  // site's generic card (302, uncacheable), so a scan of fresh mints costs no drawing at all while a
  // real crawler still gets a picture. A card drawn with the placeholder is cached as briefly as the
  // renderer keeps it (CARD_CACHE_PLACEHOLDER), so the edge never pins a lettered disc for a minute.
  // Served at /card/<mint>.png as well: robots.txt keeps crawlers out of /api/, and X only shows a card whose image
  // its crawler may fetch (it also caches robots.txt for hours), so the og:image lives outside /api/.
  app.get(["/card/:mint.png", "/api/card/:mint.png"], limits.img, wrap(async (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    const lib = await cardLib();
    if (!lib) return res.status(503).json({ error: "share cards unavailable" });
    if (!model.get(mint)) {
      let allowed = false;
      limits.api(req, res, () => { allowed = true; });
      if (!allowed) return; // the API limiter answered 429 itself
      try { await indexer.fetchCoin(mint, { rpc: apiRpc }); } catch (e) { log.warn(`card ${mint}: live lookup failed: ${e.message}`); }
    }
    if (model.get(mint)) {
      // viewed, like a coin page: an untracked coin stays in memory for a while, and a logo the metadata
      // fetcher has not reached yet is asked for first, so the placeholder card's early retry gets it
      model.touch(mint);
      const uri = model.mint(mint)?.uri; if (uri && !model.imageOfMint(mint)) meta?.request(uri, { front: true });
    }
    const t0 = performance.now();
    const out = await lib.renderCard({ model, images, mint, publicUrl, now: now() });
    if (!out) return res.status(404).json({ error: "unknown mint" });
    if (out.busy) {
      res.setHeader("cache-control", "no-store");
      res.setHeader("retry-after", "2");
      return res.redirect(302, `${String(publicUrl).replace(/\/+$/, "")}/og.png`);
    }
    res.setHeader("x-card-ms", String(Math.round(performance.now() - t0)));
    res.setHeader("etag", out.etag);
    res.setHeader("cache-control", out.placeholder ? CARD_CACHE_PLACEHOLDER : CARD_CACHE);
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("cross-origin-resource-policy", "cross-origin");
    if (etagMatches(req.headers["if-none-match"], out.etag)) return res.status(304).end();
    res.setHeader("content-type", "image/png");
    res.setHeader("content-length", String(out.png.length));
    res.end(out.png);
  }));

  // Our published metadata files, same bytes as the Pages host (immutable: names are content hashes).
  if (metaDir) {
    app.get("/m/:name", (req, res) => {
      const { name } = req.params;
      if (!META_NAME_RE.test(name)) return res.status(404).json({ error: "not found" });
      const file = join(metaDir, "m", name);
      if (!existsSync(file)) return res.status(404).json({ error: "not found" });
      res.setHeader("content-type", META_TYPES[name.split(".").pop()]);
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("cross-origin-resource-policy", "cross-origin"); // wallets and explorers embed these
      res.sendFile(file);
    });
  }

  // Metadata upload → self-hosted files + Pages deploy (DESIGN §11.3). Image arrives as a data URL
  // (≤ 2 MB, magic bytes checked, EXIF stripped); text fields are plain text with hard caps. The
  // rate limit is taken before the body is parsed (cheapest point to stop a flood) and refunded
  // when validation rejects the request, so a typo never costs one of the five attempts.
  app.post("/api/upload", limits.upload, uploadJson, wrap(async (req, res) => {
    const ip = req.ip;
    let fields, image;
    try { fields = uploadFields(req.body); image = imageFromDataUrl(req.body?.image, { maxBytes: LIMITS.imageBytes }); }
    catch (e) { limits.upload.limiter.refund(ip); return res.status(400).json({ error: e.message }); }
    if (!metahost) { limits.upload.limiter.refund(ip); return res.status(503).json({ error: "metadata host not configured" }); }
    let r;
    try {
      r = await metahost.publish({ ...fields, imageBytes: image.bytes, imageType: image.type }, { ip });
    } catch (e) {
      if (e instanceof QuotaError) { limits.upload.limiter.refund(ip); res.setHeader("retry-after", String(e.retryAfter)); return res.status(429).json({ error: e.message, retryAfter: e.retryAfter }); }
      // The files are on disk and ride along with the next successful deploy, so a retry is cheap.
      res.setHeader("retry-after", "30");
      return res.status(502).json({ error: `metadata publish failed: ${String(e.message ?? e).slice(0, 300)}`, retryAfter: 30, hint: "your files are saved; retry in about 30 s and they will be published with the next deploy" });
    }
    res.json({ metadataUri: r.metadataUri, imageUri: r.imageUri, metadata: r.meta });
  }));

  // JSON-RPC proxy: only what the browser needs to build, simulate, send and confirm its own
  // transactions, on the RPC's own "proxy" lane, with per-method parameter rules (key counts,
  // no parsed token scans, only pump transactions relayed) and a bounded relayed answer.
  app.post("/api/rpc", limits.rpc, wrap(async (req, res) => {
    const body = req.body;
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > RPC_MAX_BATCH) return res.status(400).json({ error: `bad batch (at most ${RPC_MAX_BATCH} calls)` });
    const denied = calls.find((c) => !c || typeof c.method !== "string" || !RPC_ALLOW.has(c.method));
    if (denied) return res.status(403).json({ error: `method not allowed: ${denied?.method ?? "?"}` });
    for (const c of calls) { const err = rpcParamsError(c.method, c.params); if (err) return res.status(403).json({ error: err }); }
    try {
      const r = await rpc.proxy(body);
      res.status(r.status === 429 ? 429 : 200).type("application/json").send(r.text);
    } catch (e) { res.status(502).json({ error: `rpc unreachable: ${e.message}` }); }
  }));

  app.use("/v1", v1.router);
  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

  // Production: the built web app from the same origin. Hashed assets are immutable; index.html is
  // revalidated every time and sent with the SPA CSP (and the nonce for its inline theme snippet);
  // /embed/* is the same page with a CSP any site may frame (DESIGN §12), every other path is unframeable.
  const indexFile = distDir ? join(distDir, "index.html") : null;
  if (indexFile && existsSync(indexFile)) {
    let html = { text: null, mtimeMs: 0 };
    const indexHtml = () => { const st = statSync(indexFile); if (st.mtimeMs !== html.mtimeMs) html = { text: readFileSync(indexFile, "utf8"), mtimeMs: st.mtimeMs }; return html.text; };
    // Link previews: a coin link (/c/<mint>, /map?focus=<mint>) carries that coin's own og:/twitter:
    // tags (lib/og.mjs), since crawlers read only this HTML. An unknown mint, a renderer that is not
    // there or a build without the markers keeps the static block. sendSpaHtml's `no-cache` already
    // keeps the edge from storing one coin's page for another.
    const sendIndex = async (req, res) => {
      let html = indexHtml();
      const mint = cardMintFor(req);
      if (mint) {
        try {
          const lib = await cardLib();
          const data = lib ? await lib.cardData(model, mint, { now: now() }) : null;
          if (data) html = injectOg(html, ogTags(data, { publicUrl, path: req.originalUrl, now: now() }));
        } catch (e) { log.warn?.(`og ${mint}: ${String(e?.message ?? e).slice(0, 200)}`); }
      }
      sendSpaHtml(res, html, { pagesDomain, extraConnect: cspConnect, embed: isEmbedPath(req.path) });
    };
    app.get("/", wrap(sendIndex));
    app.use(express.static(distDir, { index: false, fallthrough: true, setHeaders: (res, p) => {
      if (p.includes(`${join(distDir, "assets")}/`)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
      else res.setHeader("cache-control", "public, max-age=3600");
    } }));
    app.get(/^(?!\/(api|v1)(\/|$)).*/, wrap((req, res) => (req.path.includes(".") ? res.status(404).type("text").send("not found") : sendIndex(req, res))));
    log.info?.(`serving ${distDir}`);
  }

  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON body" });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: `body too large (limit ${err.limit ? `${Math.round(err.limit / 1024)} KB` : BODY_LIMIT})` });
    if (err?.type === "charset.unsupported" || err?.type === "encoding.unsupported") return res.status(415).json({ error: "unsupported body encoding" });
    log.error?.(`api: ${err?.stack ?? err}`);
    res.status(500).json({ error: String(err?.message ?? err).slice(0, 200) });
  });
  return app;
}
