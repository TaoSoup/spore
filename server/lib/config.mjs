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
export const DEFAULT_RATES = { api: [300, 60_000], img: [6000, 60_000], rpc: [60, 60_000], upload: [120, 10 * 60_000], spawned: [200, 10 * 60_000], sse: [30, 60_000] };

export function loadConfig(env = process.env, { here = process.cwd() } = {}) {
  const errors = [];
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
  const createdAtProbe = bool("CREATED_AT_PROBE", true);
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
  // map logo thumbnails (64/128/256 px, ~7 KB each at 64): the full pump.fun index (~58k coins) needs ~400 MB at 64 px alone
  const imgThumbBytes = num("IMG_THUMB_MB", 128, { min: 1 }) * 1024 * 1024;
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
  return { agents, llm, port, rpcUrl, wsUrl, dataDir, platformWallet, splitBps, platformMinBps, launchFeeSol, refreshMs, fullRefreshMs, backfill, backfillLimit, concurrency, rpcRps, rpcApiRps, rpcProxyRps, createdAtProbe, origins, show, pagesDomain, pagesProject, metaDir, trustProxy, hsts, logSample, rates, cspConnect, treasuryTtlMs, sseMaxClients, ssePerIp, uploadQuota, metaGcHours, imgCacheBytes, imgThumbBytes, distDir, publicUrl, v1Limits };
}
