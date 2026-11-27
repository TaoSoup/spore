// Boot configuration: every variable read once, validated together, and reported as one readable
// error so a bad deploy fails before it binds a port or touches the chain. The table in
// deploy/env.example and server/README.md mirrors this file.
import { mkdirSync, accessSync, constants as FS } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "./sdk.mjs";
import { parseSplitBps, DEFAULT_SPLIT_BPS, DEFAULT_LAUNCH_FEE_SOL, launchFeeOf } from "./pricing.mjs";
import { deriveWsUrl } from "./rpc.mjs";
import { DEFAULT_PAGES_DOMAIN, DEFAULT_PAGES_PROJECT, DEFAULT_META_DIR, DEFAULT_QUOTA } from "./metahost.mjs";

export const DEFAULT_PLATFORM_WALLET = "FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5";
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
// Per-IP rate limits (requests per window) — DEPLOY.md documents each.
export const DEFAULT_RATES = { api: [300, 60_000], img: [6000, 60_000], rpc: [60, 60_000], upload: [120, 10 * 60_000], spawned: [200, 10 * 60_000], sse: [30, 60_000], jup: [20, 60_000], portfolio: [20, 60_000], pnl: [60, 60_000], pnlnew: [20, 60 * 60_000], histnew: [120, 60 * 60_000], narrnew: [120, 60 * 60_000], postfill: [10, 60 * 60_000] };
// Command-line flags that stand in for a variable, so a package.json script needs no POSIX
// `VAR=value node …` prefix (cmd.exe cannot run one): `npm run dev` passes --backfill-limit=150.
// A flag wins over the environment, as that prefix did; other arguments are ignored, as before.
export const FLAG_VARS = { "--backfill-limit": "BACKFILL_LIMIT" };

export function loadConfig(env = process.env, { here = process.cwd(), argv = [] } = {}) {
  const errors = [];
  for (const arg of argv) {
    const eq = arg.indexOf("="), flag = eq < 0 ? arg : arg.slice(0, eq);
    if (!Object.hasOwn(FLAG_VARS, flag)) continue;
    if (eq < 0) errors.push(`${flag} needs a value (${flag}=…)`);
    else env = { ...env, [FLAG_VARS[flag]]: arg.slice(eq + 1) };
  }
  const get = (k, d) => (env[k] === undefined || env[k] === "" ? d : String(env[k]));
  const num = (k, d, { min = -Infinity, max = Infinity, integer = false } = {}) => {
    const raw = get(k, d);
    const v = Number(raw);
    if (!Number.isFinite(v) || (integer && !Number.isInteger(v)) || v < min || v > max) { errors.push(`${k}=${JSON.stringify(raw)} must be ${integer ? "an integer" : "a number"}${min > -Infinity ? ` ≥ ${min}` : ""}${max < Infinity ? ` ≤ ${max}` : ""}`); return d; }
    return v;
  };
  const bool = (k, d) => { const v = get(k, d ? "1" : "0").toLowerCase(); if (!["0", "1", "true", "false", "yes", "no"].includes(v)) { errors.push(`${k} must be 0 or 1`); return d; } return ["1", "true", "yes"].includes(v); };
  const oneOf = (k, d, list) => { const v = get(k, d); if (!list.includes(v)) { errors.push(`${k}=${JSON.stringify(v)} must be one of ${list.join(", ")}`); return d; } return v; };
  const url = (k, d, protocols) => { const v = get(k, d); try { const u = new URL(v); if (!protocols.includes(u.protocol)) throw new Error(); return v; } catch { errors.push(`${k} must be a ${protocols.map((p) => p.replace(":", "")).join("/")} URL`); return d; } };
  const pubkey = (k, d) => { const v = get(k, d); try { new PublicKey(v); if (v.length < 32) throw new Error(); return v; } catch { errors.push(`${k}=${JSON.stringify(v)} is not a Solana public key`); return d; } };
  const dir = (k, d) => { const v = get(k, d); try { mkdirSync(v, { recursive: true }); accessSync(v, FS.W_OK); return v; } catch (e) { errors.push(`${k}=${JSON.stringify(v)} is not a writable directory (${e.code ?? e.message})`); return v; } };

  const port = num("PORT", 8793, { min: 1, max: 65535, integer: true });
  const rpcUrl = url("RPC_URL", DEFAULT_RPC_URL, ["http:", "https:"]);
  const wsUrl = url("WS_URL", deriveWsUrl(rpcUrl), ["ws:", "wss:"]);
  const dataDir = dir("DATA_DIR", join(here, "data"));
  const platformWallet = pubkey("PLATFORM_WALLET", DEFAULT_PLATFORM_WALLET);
  let splitBps = DEFAULT_SPLIT_BPS;
  try { splitBps = parseSplitBps(get("SPLIT_BPS", DEFAULT_SPLIT_BPS.join(","))); } catch (e) { errors.push(e.message); }
  let launchFeeSol = DEFAULT_LAUNCH_FEE_SOL;
  try { launchFeeSol = launchFeeOf(get("LAUNCH_FEE_SOL", String(DEFAULT_LAUNCH_FEE_SOL)), platformWallet).sol; } catch (e) { errors.push(e.message); }
  // A sharing config counts as ours only when the platform's share is at least this (default: its SPLIT_BPS slice).
  const platformMinBps = num("PLATFORM_MIN_BPS", Math.max(1, splitBps[3]), { min: 1, max: 10_000, integer: true });
  const refreshMs = num("REFRESH_MS", 30_000, { min: 1_000, integer: true });
  const fullRefreshMs = num("FULL_REFRESH_MS", 20 * 60_000, { min: refreshMs, integer: true });
  const backfill = bool("BACKFILL", true);
  const backfillLimit = get("BACKFILL_LIMIT", "") ? num("BACKFILL_LIMIT", 0, { min: 0, integer: true }) : Infinity;
  const concurrency = num("CONCURRENCY", 4, { min: 1, max: 64, integer: true });
  // The public RPC caps each method at ~40 requests per 10 s per IP; 4/s keeps the backfill's
  // getTokenAccountsByOwner stream under it without leaning on 429 backoff.
  const rpcRps = num("RPC_RPS", rpcUrl.includes("api.mainnet-beta.solana.com") ? 4 : 40, { min: 0.1, max: 10_000 });
  // Request-driven lanes (unknown-coin lookups, eligibility, the browser proxy) get their own small budgets.
  const rpcApiRps = num("RPC_API_RPS", Math.max(1, rpcRps / 4), { min: 0.1, max: 10_000 });
  const rpcProxyRps = num("RPC_PROXY_RPS", Math.max(1, rpcRps / 4), { min: 0.1, max: 10_000 });
  // An optional metered RPC (a Helius key) for those request-driven lanes only, while the indexer stays on RPC_URL:
  // at most RPC_USER_RPS requests/s (sends at RPC_USER_SEND_RPS) and RPC_USER_DAILY_CREDITS credits a day (UTC), then
  // RPC_URL again. The defaults fit Helius' free plan (10 requests/s, 1 send/s, 1M credits a month): 15 000 a day is
  // under half of it. The URL itself (it holds the key) is never logged or reported; errors name the variable only.
  const rpcUserUrl = get("RPC_USER_URL", "") ? url("RPC_USER_URL", "", ["http:", "https:"]) : "";
  const rpcUser = rpcUserUrl && rpcUserUrl !== rpcUrl ? {
    url: rpcUserUrl,
    rps: num("RPC_USER_RPS", 5, { min: 0.1, max: 10_000 }),
    sendRps: num("RPC_USER_SEND_RPS", 1, { min: 0.1, max: 10_000 }),
    dailyCredits: num("RPC_USER_DAILY_CREDITS", 15_000, { min: 0, integer: true }),
  } : null;
  // Wallet profit and loss (lib/pnl-tracker.mjs): the wallets whose P&L was asked for keep their trades from then on, and
  // each one's older history is read from the chain once, in the background, on RPC_URL (never the metered endpoint).
  // The public RPC allows about 40 calls of one method per 10 s per IP and the indexer already uses RPC_RPS of it, so
  // the scan defaults to 2 reads a second there and 5 on any other endpoint.
  const pnl = {
    maxWallets: num("PNL_MAX_WALLETS", 5000, { min: 1, max: 1_000_000, integer: true }),
    backfill: bool("PNL_BACKFILL", true),
    backfillTx: num("PNL_BACKFILL_TX", 1000, { min: 1, max: 20_000, integer: true }),
    backfillRps: num("PNL_BACKFILL_RPS", rpcUrl.includes("api.mainnet-beta.solana.com") ? 2 : 5, { min: 0.1, max: 1_000 }),
    maxTrades: num("PNL_MAX_TRADES", 10_000, { min: 100, max: 1_000_000, integer: true }),
    // All wallets together: rows kept (a full table stops the scans and makes a wallet's new trade push out its oldest),
    // scans waiting (the most recently asked-for wallets stay in line), and chain reads a UTC day (0 = no cap).
    maxRows: num("PNL_MAX_ROWS", 2_000_000, { min: 1000, max: 1_000_000_000, integer: true }),
    maxQueue: num("PNL_MAX_QUEUE", 200, { min: 1, max: 100_000, integer: true }),
    dailyCalls: num("PNL_BACKFILL_DAILY", 100_000, { min: 0, integer: true }),
  };
  // Trade gap fill (lib/trade-fill.mjs): the trades the live streams missed (a restart, a reconnect) are read back from the
  // chain when a coin's chart is opened, on their own RPC_URL lane (never the metered endpoint). 1 read/s on the public
  // RPC keeps this IP's getTransaction rate at or under 3/s with the P&L scans.
  const fill = {
    enabled: bool("TRADE_FILL", true),
    rps: num("TRADE_FILL_RPS", rpcUrl.includes("api.mainnet-beta.solana.com") ? 1 : 3, { min: 0.1, max: 1_000 }),
    dailyCalls: num("TRADE_FILL_DAILY", 20_000, { min: 0, integer: true }), // 0 = no cap; under 200 counts as 200
  };
  // Chart history (lib/chart-history.mjs): the coin page's chart also shows the time before the server's first stored
  // trade of a coin, from GeckoTerminal's public candles (keyless: 10 requests a minute per IP, errors included), and
  // where it has none, from a few of the coin's transactions read on the trade fill's RPC_URL lane while the gap fill
  // is idle (CHART_SAMPLE). Both day caps: 0 = no cap.
  const history = {
    enabled: bool("CHART_HISTORY", true),
    sample: bool("CHART_SAMPLE", true),
    geckoPerMin: num("GECKO_PER_MIN", 8, { min: 1, max: 600 }),
    geckoDaily: num("GECKO_DAILY", 5_000, { min: 0, integer: true }),
    sampleDaily: num("CHART_SAMPLE_DAILY", 5_000, { min: 0, integer: true }),
  };
  // Linked posts (lib/narrative.mjs): the X posts a family's coins link in their metadata, grouped per parent. The posts'
  // texts come from X's public embed API (lib/xposts.mjs, keyless), paced and capped per UTC day (0 = no cap);
  // NARRATIVE_POSTS=0 keeps the links and fetches no text.
  const narrative = {
    enabled: bool("NARRATIVE", true),
    posts: bool("NARRATIVE_POSTS", true),
    perMin: num("XPOST_PER_MIN", 20, { min: 1, max: 120 }),
    daily: num("XPOST_DAILY", 3_000, { min: 0, integer: true }),
  };
  // Holder facts of the Discover rows (dev and top-10 shares, lib/holders.mjs): off by default. On the free RPC its
  // getTokenLargestAccounts calls were rate limited for minutes (Nov 20) and compete with the indexer for the same
  // endpoint, so rows show the sniper share (from our own trades) only. HOLDERS=1 turns the reads on.
  const holders = bool("HOLDERS", false);
  // Narrative tags (lib/narrtags.mjs): a language model files coins under short story titles for the Discover story
  // cards. Off by default. It runs only with NARRATIVES=on, a readable NARRATIVE_KEY_FILE and a model whose price is
  // known (its own table, or both NARRATIVE_*_USD_PER_M); otherwise the server behaves as without it. The key itself
  // is read only by lib/narrtags.mjs when it makes its client; here the file is checked, and no message carries it.
  const narrKeyFile = get("NARRATIVE_KEY_FILE", "") || null;
  if (narrKeyFile) { try { accessSync(narrKeyFile, FS.R_OK); } catch (e) { errors.push(`NARRATIVE_KEY_FILE=${JSON.stringify(narrKeyFile)} is not a readable file (${e.code ?? "error"})`); } }
  if (env.NARRATIVE_KEY !== undefined && env.NARRATIVE_KEY !== "") errors.push("NARRATIVE_KEY is not read from the environment: put the key in a file and set NARRATIVE_KEY_FILE to its path");
  const narrTags = {
    on: oneOf("NARRATIVES", "off", ["off", "on"]) === "on",
    keyFile: narrKeyFile,
    model: get("NARRATIVE_MODEL", "claude-haiku-5-5"),
    dailyUsd: num("NARRATIVE_DAILY_USD", 1, { min: 0, max: 1_000 }),
    minBuyers: num("NARRATIVE_MIN_BUYERS", 10, { min: 1, max: 100_000, integer: true }),
    // The price of a model lib/narrtags.mjs has no price for (USD per million tokens; both or neither).
    inUsdPerM: get("NARRATIVE_IN_USD_PER_M", "") ? num("NARRATIVE_IN_USD_PER_M", 0, { min: 0, max: 10_000 }) : null,
    outUsdPerM: get("NARRATIVE_OUT_USD_PER_M", "") ? num("NARRATIVE_OUT_USD_PER_M", 0, { min: 0, max: 10_000 }) : null,
    // NARRATIVE_IMAGES=on sends each coin's picture (its logo, the PNG thumbnail of NARRATIVE_IMAGE_PX: 128 or 256) with
    // its text; a 256 px picture is about 90 input tokens (pixels / 750). Off: the requests are those without pictures.
    images: oneOf("NARRATIVE_IMAGES", "off", ["off", "on"]) === "on",
    imagePx: Number(oneOf("NARRATIVE_IMAGE_PX", "256", ["128", "256"])),
  };
  if ((narrTags.inUsdPerM == null) !== (narrTags.outUsdPerM == null)) errors.push("NARRATIVE_IN_USD_PER_M and NARRATIVE_OUT_USD_PER_M must be set together");
  // The Anthropic SDK adds the headers of ANTHROPIC_CUSTOM_HEADERS to every request and no option turns that off, so
  // the tagger does not run beside it. (ANTHROPIC_BASE_URL and ANTHROPIC_LOG need no check: lib/narrtags.mjs fixes the
  // host and the logging in code.) The value is never echoed.
  if (narrTags.on && env.ANTHROPIC_CUSTOM_HEADERS) errors.push("ANTHROPIC_CUSTOM_HEADERS is set in the environment: unset it to run with NARRATIVES=on (its headers would go out with every narrative request)");
  // POST_LINES=off|on (lib/post-lines.mjs, default off): one model-written "subject: what happened" line per starting
  // post on Discover. It runs only when the narrative tags run too (NARRATIVES=on, the key file, a priced model): the
  // same model, the same key file and the same day's spend (NARRATIVE_DAILY_USD covers both together).
  const postLines = { on: oneOf("POST_LINES", "off", ["off", "on"]) === "on" };
  const createdAtProbe = bool("CREATED_AT_PROBE", true);
  const livePools = bool("LIVE_POOLS", true);
  // WS_HELIUS=1: the curve stream (new launches and curve trades, about 0.3 MB/s) uses RPC_USER_URL's WebSocket instead of
  // WS_URL, because the public socket drops for long stretches. Helius meters sockets by data (2 credits per 0.1 MB), so
  // the stream counts what it receives and goes back to WS_URL for good once WS_HELIUS_MB have arrived (kept across
  // restarts in kv "wsMetered"; delete that row to start a new budget). The pool stream (about 1 MB/s) stays on WS_URL.
  const wsHelius = bool("WS_HELIUS", false) && rpcUser ? { url: deriveWsUrl(rpcUser.url), budgetBytes: num("WS_HELIUS_MB", 20_000, { min: 1 }) * 1e6 } : null;
  // LAUNCH_LOG=<file>: record every curve launch and trade the live stream delivers, tracked or not, in that sqlite file
  // (lib/launch-log.mjs), kept LAUNCH_LOG_HOURS; measurement for the Discover trending gate. Off when empty.
  const launchLog = get("LAUNCH_LOG", "") ? { file: get("LAUNCH_LOG", ""), keepHours: num("LAUNCH_LOG_HOURS", 72, { min: 1 }) } : null;
  // TREND_GATE=off|shadow|on (lib/trend-gate.mjs, default off): watch the plain SOL launches the indexer drops and pass
  // those whose first minutes drew real buyers. "shadow" records each pass (table trend_gate) and changes nothing; "on"
  // also inserts the launch into the tree (Discover and trending show it; the map does not until it has a child), at most
  // TREND_GATE_PER_HOUR an hour. The thresholds: TREND_GATE_BUYERS counted buyers and TREND_GATE_SOL capped SOL inflow
  // within TREND_GATE_WINDOW_S of the create; buyers whose first buy is in the create slot or the next TREND_GATE_EARLY_SLOTS
  // slots, or in the first TREND_GATE_EARLY_S seconds, are not counted.
  const trendGate = { mode: oneOf("TREND_GATE", "off", ["off", "shadow", "on"]), perHour: num("TREND_GATE_PER_HOUR", 60, { min: 1, max: 10_000, integer: true }),
    cfg: { minCounted: num("TREND_GATE_BUYERS", 12, { min: 1, max: 1000, integer: true }), minInflowSol: num("TREND_GATE_SOL", 3, { min: 0, max: 10_000 }), windowS: num("TREND_GATE_WINDOW_S", 600, { min: 30, max: 3600, integer: true }), earlyAfterS: num("TREND_GATE_EARLY_S", 0, { min: 0, max: 600, integer: true }), earlySlots: num("TREND_GATE_EARLY_SLOTS", 3, { min: 0, max: 150, integer: true }) } };
  // STORY_GATE=off|shadow|on (lib/story-gate.mjs, default off): which Discover stories are drawing real buyers now, over 30
  // min: STORY_GATE_BUYERS counted buyers, STORY_GATE_LIFT times their normal (the median 30-min window of the prior 24 h,
  // never below 3), STORY_GATE_SOL capped net inflow, and 2+ coins with 5+ buyers or STORY_GATE_WORD_CREATORS creators
  // launching with one of its words in the hour. "shadow" records passes (table story_gate); "on" also lists passing
  // stories first on Discover. Every launch's words are counted for it (lib/word-bursts.mjs).
  const storyGate = { mode: oneOf("STORY_GATE", "off", ["off", "shadow", "on"]),
    cfg: { minBuyers: num("STORY_GATE_BUYERS", 15, { min: 1, max: 10_000, integer: true }), minLift: num("STORY_GATE_LIFT", 3, { min: 0, max: 1000 }), minInflowSol: num("STORY_GATE_SOL", 10, { min: 0, max: 100_000 }), minWordCreators: num("STORY_GATE_WORD_CREATORS", 5, { min: 2, max: 1000, integer: true }) } };
  // WAVES=off|shadow (lib/waves.mjs, lib/name-counts.mjs; default off): count every launch's name features per hour and
  // record "name waves" (a feature launched by far more creators than its own 30-day share predicts) with their member
  // coins in their own tables. Shadow only: nothing reaches a card, the page or a model; "on" is refused until cards
  // exist. WAVES_KEEP_DAYS (7-90, default 30): how long the hourly feature counts are kept (the baseline reads 30 days).
  // WAVES_BOOTSTRAP (default 1): once, seed the counts from the LAUNCH_LOG file's complete hours, if one is set.
  const wavesRaw = get("WAVES", "off");
  if (wavesRaw === "on") errors.push('WAVES="on" is not available yet: name waves are recorded in shadow only (WAVES=shadow) until their cards exist');
  const waves = { mode: wavesRaw === "on" ? "off" : oneOf("WAVES", "off", ["off", "shadow"]), keepDays: num("WAVES_KEEP_DAYS", 30, { min: 7, max: 90, integer: true }), bootstrap: bool("WAVES_BOOTSTRAP", true) };
  // Jupiter /build for coins priced in a listed asset with no pump SOL pool (lib/jupiter.mjs). JUP_API_KEY is optional
  // (a free key from developers.jup.ag lifts 0.5 to 1 request/s); it is never logged or sent to the browser.
  const jupApiKey = get("JUP_API_KEY", "");
  const jupiter = { enabled: bool("JUPITER", true), url: url("JUP_URL", "https://api.jup.ag/swap/v2", ["https:", "http:"]), apiKey: jupApiKey, rps: num("JUP_RPS", jupApiKey ? 1 : 0.5, { min: 0.05, max: 1_000 }) };
  // `ORIGINS` is the documented name; `ORIGIN` stays accepted from the first version.
  const origins = get("ORIGINS", get("ORIGIN", "")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const o of origins) { try { if (new URL(o).origin !== o) throw new Error(); } catch { errors.push(`ORIGINS entry ${JSON.stringify(o)} is not an origin (scheme://host[:port], no path)`); } }
  const show = oneOf("SHOW", "ours", ["ours", "all"]);
  const pagesDomain = get("PAGES_DOMAIN", DEFAULT_PAGES_DOMAIN).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(pagesDomain)) errors.push(`PAGES_DOMAIN=${JSON.stringify(pagesDomain)} must be a hostname`);
  const pagesProject = get("PAGES_PROJECT", DEFAULT_PAGES_PROJECT);
  const metaDir = dir("META_DIR", DEFAULT_META_DIR);
  // express "trust proxy": false (direct), true (any proxy), a hop count, or a list of addresses/subnets.
  const trustRaw = get("TRUST_PROXY", "loopback");
  const trustProxy = /^(true|false)$/i.test(trustRaw) ? trustRaw.toLowerCase() === "true" : /^\d+$/.test(trustRaw) ? Number(trustRaw) : trustRaw;
  const hstsRaw = oneOf("HSTS", "auto", ["auto", "0", "1"]);
  const hsts = hstsRaw === "auto" ? "auto" : hstsRaw === "1";
  const logSample = num("LOG_SAMPLE", 0.1, { min: 0, max: 1 });
  const rates = {};
  for (const [name, [limit, windowMs]] of Object.entries(DEFAULT_RATES)) rates[name] = { limit: num(`RATE_${name.toUpperCase()}`, limit, { min: 1, integer: true }), windowMs };
  const cspConnect = get("CSP_CONNECT", "").split(",").map((s) => s.trim()).filter(Boolean);
  const treasuryTtlMs = num("TREASURY_TTL_MS", 60_000, { min: 5_000, integer: true });
  const sseMaxClients = num("SSE_MAX_CLIENTS", 20_000, { min: 1, integer: true });
  const ssePerIp = num("SSE_PER_IP", 16, { min: 1, integer: true });
  const uploadQuota = { ipPerDay: num("UPLOAD_DAILY_IP", DEFAULT_QUOTA.ipPerDay, { min: 1, integer: true }), bytesPerDay: num("UPLOAD_DAILY_MB", DEFAULT_QUOTA.bytesPerDay / 1024 / 1024, { min: 1 }) * 1024 * 1024, deploysPerDay: num("UPLOAD_DAILY_DEPLOYS", DEFAULT_QUOTA.deploysPerDay, { min: 1, integer: true }) };
  const metaGcHours = num("META_GC_HOURS", 24, { min: 0 }); // 0 = never delete uploaded files
  const imgCacheBytes = num("IMG_CACHE_MB", 512, { min: 1 }) * 1024 * 1024;
  // Disk budget of the map logo thumbnails (64/128/256 px, ~9 KB each at 64: 44k logos took 378 MB on 2026-11-10), kept
  // for good and evicted only past this, least recently served first: 2 GB holds ~230k logos, a full index at 64 px.
  const imgThumbBytes = num("IMG_THUMB_MB", 2048, { min: 1 }) * 1024 * 1024;
  const distDir = get("DIST_DIR", join(here, "../web/dist"));
  // Partner API (DESIGN §12): absolute links and image URLs are built on PUBLIC_URL; tiers per minute.
  const publicUrl = url("PUBLIC_URL", "https://sporepad.com", ["http:", "https:"]).replace(/\/+$/, "");
  try { if (new URL(publicUrl).origin !== publicUrl) errors.push(`PUBLIC_URL=${JSON.stringify(publicUrl)} must be an origin (scheme://host[:port], no path)`); } catch { /* reported by url() */ }
  const v1Limits = {
    publicPerMin: num("V1_RATE_PUBLIC", 60, { min: 1, integer: true }),
    partnerPerMin: num("V1_RATE_PARTNER", 1200, { min: 1, integer: true }),
    publicStreams: num("V1_STREAMS_PUBLIC", 2, { min: 1, integer: true }),
    partnerStreams: num("V1_STREAMS_PARTNER", 20, { min: 1, integer: true }),
    maxStreams: num("V1_STREAMS_MAX", 2_000, { min: 1, integer: true }),
  };

  // Root agents (DESIGN §13). Phase 0 knows only "off" (default, nothing runs) and "dry" (proposals
  // and simulations, never a signature). The language model is optional: without LLM_URL, LLM_MODEL
  // and a readable LLM_KEY_FILE the agents use their deterministic fallback. The key itself is read
  // only by lib/agents/llm.mjs; here the file is checked for existence, and no message carries it.
  // "live" (DESIGN §13.1) adds real wallets: every root launch prepares an agent wallet in the vault
  // (AGENT_VAULT_KEY_FILE, a 32-byte key in a mode-600 file made by scripts/agent-vault.mjs init), so
  // the vault is required for root launches in every mode; launching, paying and claiming only run
  // under AGENTS=live. Live agents launch every tick while their wallet can pay (no momentum gate).
  const mode = oneOf("AGENTS", "off", ["off", "dry", "live"]);
  const vaultKeyFile = get("AGENT_VAULT_KEY_FILE", "") || null;
  if (vaultKeyFile) { try { accessSync(vaultKeyFile, FS.R_OK); } catch (e) { errors.push(`AGENT_VAULT_KEY_FILE=${JSON.stringify(vaultKeyFile)} is not a readable file (${e.code ?? "error"})`); } }
  if (mode === "live" && !vaultKeyFile) errors.push("AGENTS=live needs AGENT_VAULT_KEY_FILE");
  const agents = {
    mode,
    tickSec: num("AGENT_TICK_SEC", 300, { min: 10, max: 86_400, integer: true }),
    minScore: num("AGENT_MIN_SCORE", mode === "live" ? 0 : 40, { min: 0, max: 100 }),
    cooldownMin: num("AGENT_COOLDOWN_MIN", mode === "live" ? 0 : 60, { min: 0, max: 10_080 }),
    // Live cadence (owner 2026-10-19): a launch every N ticks (claims run every tick).
    launchEveryTicks: num("AGENT_LAUNCH_EVERY_TICKS", 3, { min: 1, max: 1_000, integer: true }),
    maxPerHour: num("AGENT_MAX_PER_HOUR", mode === "live" ? 1_000 : 12, { min: 0, max: 1_000, integer: true }),
    probe: pubkey("AGENT_PROBE", "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs"),
    vaultKeyFile,
    // "keyed": the server calls the model provider with the owner's key (LLM_URL + LLM_KEY_FILE),
    // costs booked per agent; "solana-x402": each agent pays per request from its own USDC.
    aiRail: oneOf("AGENT_AI_RAIL", "keyed", ["keyed", "solana-x402"]),
    model: get("AGENT_MODEL", "anthropic/claude-sonnet-5.5"),
    startUsd: num("AGENT_START_USD", 5, { min: 0, max: 1_000 }),
    reserveSol: num("AGENT_RESERVE_SOL", 0.005, { min: 0, max: 1 }),
    aiFloorUsd: num("AGENT_AI_FLOOR_USD", 0.25, { min: 0, max: 100 }),
    aiTargetUsd: num("AGENT_AI_TARGET_USD", 1, { min: 0, max: 100 }),
    // Keyed rail: daily USD ceilings on the owner's provider spend, per agent and for all agents.
    dailyUsdPerAgent: num("AGENT_AI_DAILY_USD", 2, { min: 0, max: 1_000 }),
    dailyUsdTotal: num("AGENT_AI_DAILY_TOTAL_USD", 10, { min: 0, max: 10_000 }),
    // Automatic payout (DESIGN §13.1): every agent keeps AGENT_KEEP_SOL (+ reserve) for its next
    // launches and sends the rest, plus idle USDC, to the owner's wallet each pass. Unset = keep all.
    payoutAddress: get("AGENT_PAYOUT_ADDRESS", "") ? pubkey("AGENT_PAYOUT_ADDRESS", "") : null,
    keepSol: num("AGENT_KEEP_SOL", 0.1, { min: 0, max: 100 }),
  };
  if (agents.aiTargetUsd < agents.aiFloorUsd) errors.push("AGENT_AI_TARGET_USD must be at least AGENT_AI_FLOOR_USD");
  const llmUrl = get("LLM_URL", "") ? url("LLM_URL", "", ["http:", "https:"]) : null;
  const llmKeyFile = get("LLM_KEY_FILE", "") || null;
  if (llmKeyFile) { try { accessSync(llmKeyFile, FS.R_OK); } catch (e) { errors.push(`LLM_KEY_FILE=${JSON.stringify(llmKeyFile)} is not a readable file (${e.code ?? "error"})`); } }
  if (env.LLM_KEY !== undefined && env.LLM_KEY !== "") errors.push("LLM_KEY is not read from the environment: put the key in a file and set LLM_KEY_FILE to its path");
  // Image logos for agent coins (DESIGN §13.1): the same key, the provider's image endpoint (derived
  // from LLM_URL's host when IMAGE_URL is unset), a model and a size with a known price per image.
  const llm = {
    url: llmUrl, keyFile: llmKeyFile, model: get("LLM_MODEL", "") || null,
    imageUrl: get("IMAGE_URL", "") ? url("IMAGE_URL", "", ["https:"]) : null,
    imageModel: get("IMAGE_MODEL", "blackforestlabs/flux-3/klein/text-to-image"),
    imageSize: get("IMAGE_SIZE", "768x768"),
    imageUsd: num("IMAGE_USD", 0.008, { min: 0, max: 5 }),
  };

  if (errors.length) throw new Error(`invalid configuration:\n  - ${errors.join("\n  - ")}\nSee deploy/env.example for every variable.`);
  return { agents, llm, port, rpcUrl, wsUrl, dataDir, platformWallet, splitBps, platformMinBps, launchFeeSol, refreshMs, fullRefreshMs, backfill, backfillLimit, concurrency, rpcRps, rpcApiRps, rpcProxyRps, rpcUser, wsHelius, launchLog, trendGate, storyGate, waves, createdAtProbe, livePools, origins, show, pagesDomain, pagesProject, metaDir, trustProxy, hsts, logSample, rates, cspConnect, treasuryTtlMs, sseMaxClients, ssePerIp, uploadQuota, metaGcHours, imgCacheBytes, imgThumbBytes, distDir, publicUrl, v1Limits, jupiter, pnl, fill, history, narrative, holders, narrTags, postLines };
}
