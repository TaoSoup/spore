// Boot configuration: defaults, every validation message, and the fail-fast aggregate error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_PLATFORM_WALLET, DEFAULT_RATES } from "../lib/config.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "spore-cfg-"));

test("defaults: public RPC at 4 rps, ours mode, no launch fee, loopback trust, rate table", () => {
  const dir = tmp();
  try {
    const c = loadConfig({ DATA_DIR: join(dir, "data"), META_DIR: join(dir, "meta") }, { here: dir });
    assert.equal(c.port, 8793); assert.equal(c.rpcRps, 4); assert.equal(c.wsUrl, "wss://api.mainnet-beta.solana.com");
    assert.equal(c.show, "ours"); assert.equal(c.launchFeeSol, 0); assert.equal(c.platformWallet, DEFAULT_PLATFORM_WALLET);
    assert.deepEqual(c.splitBps, [5000, 0, 0, 5000]); assert.equal(c.trustProxy, "loopback"); assert.equal(c.hsts, "auto");
    assert.equal(c.backfillLimit, Infinity); assert.deepEqual(c.origins, []);
    for (const k of Object.keys(DEFAULT_RATES)) assert.deepEqual(c.rates[k], { limit: DEFAULT_RATES[k][0], windowMs: DEFAULT_RATES[k][1] });
    assert.equal(c.rates.sse.limit, 30);
    assert.equal(c.platformMinBps, 5000); assert.equal(c.rpcApiRps, 1); assert.equal(c.rpcProxyRps, 1);
    assert.equal(c.sseMaxClients, 20000); assert.equal(c.ssePerIp, 16);
    assert.deepEqual(c.uploadQuota, { ipPerDay: 500, bytesPerDay: 256 * 1024 * 1024, deploysPerDay: 200 });
    assert.equal(c.metaGcHours, 24); assert.equal(c.imgCacheBytes, 512 * 1024 * 1024); assert.equal(c.imgThumbBytes, 2048 * 1024 * 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("overrides: Helius-style URLs derive the socket, ORIGINS parsed, trust proxy forms, rate overrides", () => {
  const dir = tmp();
  try {
    const c = loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), RPC_URL: "https://mainnet.helius-rpc.com/?api-key=abc", ORIGINS: "http://localhost:5174, https://spore.fun", TRUST_PROXY: "1", RATE_API: "50", SHOW: "all", HSTS: "1", BACKFILL_LIMIT: "150", BACKFILL: "0", LOG_SAMPLE: "0" }, { here: dir });
    assert.equal(c.wsUrl, "wss://mainnet.helius-rpc.com/?api-key=abc"); assert.equal(c.rpcRps, 40);
    assert.deepEqual(c.origins, ["http://localhost:5174", "https://spore.fun"]);
    assert.equal(c.trustProxy, 1); assert.equal(c.rates.api.limit, 50); assert.equal(c.show, "all"); assert.equal(c.hsts, true);
    assert.equal(c.backfillLimit, 150); assert.equal(c.backfill, false); assert.equal(c.logSample, 0);
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), TRUST_PROXY: "false" }, { here: dir }).trustProxy, false);
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" }, { here: dir }).trustProxy, "10.0.0.0/8, 127.0.0.1");
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), ORIGIN: "https://old.example" }, { here: dir }).origins[0], "https://old.example", "legacy ORIGIN still read");
    const h = loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), RPC_URL: "https://mainnet.helius-rpc.com/?api-key=abc", PLATFORM_MIN_BPS: "1500", RPC_API_RPS: "3", RPC_PROXY_RPS: "2.5", RATE_SSE: "5", SSE_PER_IP: "2", UPLOAD_DAILY_IP: "3", UPLOAD_DAILY_MB: "1", UPLOAD_DAILY_DEPLOYS: "4", META_GC_HOURS: "0", IMG_CACHE_MB: "64", IMG_THUMB_MB: "256", SPLIT_BPS: "8500,0,0,1500" }, { here: dir });
    assert.equal(h.platformMinBps, 1500); assert.equal(h.rpcApiRps, 3); assert.equal(h.rpcProxyRps, 2.5); assert.equal(h.rates.sse.limit, 5); assert.equal(h.ssePerIp, 2);
    assert.deepEqual(h.uploadQuota, { ipPerDay: 3, bytesPerDay: 1024 * 1024, deploysPerDay: 4 }); assert.equal(h.metaGcHours, 0); assert.equal(h.imgCacheBytes, 64 * 1024 * 1024); assert.equal(h.imgThumbBytes, 256 * 1024 * 1024);
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), RPC_URL: "https://mainnet.helius-rpc.com/?api-key=abc", SPLIT_BPS: "8500,0,0,1500" }, { here: dir }).platformMinBps, 1500, "the floor follows the platform slice");
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), RPC_URL: "https://mainnet.helius-rpc.com/?api-key=abc" }, { here: dir }).rpcApiRps, 10, "a quarter of RPC_RPS");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("command-line flags: --backfill-limit=N (npm run dev) sets BACKFILL_LIMIT over the environment; other arguments ignored", () => {
  const dir = tmp();
  try {
    const base = { DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m") };
    assert.equal(loadConfig(base, { here: dir, argv: ["--backfill-limit=150"] }).backfillLimit, 150);
    assert.equal(loadConfig({ ...base, BACKFILL_LIMIT: "9" }, { here: dir, argv: ["--backfill-limit=150"] }).backfillLimit, 150, "the flag wins, as the VAR=value prefix did");
    assert.equal(loadConfig({ ...base, BACKFILL_LIMIT: "9" }, { here: dir, argv: ["extra", "--other=1"] }).backfillLimit, 9);
    assert.equal(loadConfig(base, { here: dir, argv: ["--backfill-limit="] }).backfillLimit, Infinity, "empty = unset");
    const env = { ...base }; loadConfig(env, { here: dir, argv: ["--backfill-limit=150"] });
    assert.equal(env.BACKFILL_LIMIT, undefined, "the caller's env is not modified");
    assert.throws(() => loadConfig(base, { here: dir, argv: ["--backfill-limit"] }), /--backfill-limit needs a value/);
    assert.throws(() => loadConfig(base, { here: dir, argv: ["--backfill-limit=-1"] }), /BACKFILL_LIMIT="-1" must be an integer ≥ 0/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every bad value is reported at once, by name, with the fix", () => {
  const dir = tmp();
  try {
    const bad = { DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), PORT: "99999", RPC_URL: "ftp://x", WS_URL: "https://not-ws", PLATFORM_WALLET: "nope", SPLIT_BPS: "1,2,3", LAUNCH_FEE_SOL: "99", SHOW: "mine", ORIGINS: "spore.fun", REFRESH_MS: "10", CONCURRENCY: "0", TRUST_PROXY: "loopback", HSTS: "maybe", LOG_SAMPLE: "2", RATE_RPC: "0", PAGES_DOMAIN: "not a host", PLATFORM_MIN_BPS: "0", SSE_PER_IP: "x", UPLOAD_DAILY_MB: "0" };
    assert.throws(() => loadConfig(bad, { here: dir }), (e) => {
      const m = e.message;
      for (const needle of ["invalid configuration", "PORT=\"99999\"", "RPC_URL must be a http/https URL", "WS_URL must be a ws/wss URL", "PLATFORM_WALLET=\"nope\" is not a Solana public key", "SPLIT_BPS", "LAUNCH_FEE_SOL", "SHOW=\"mine\"", "ORIGINS entry \"spore.fun\"", "REFRESH_MS", "CONCURRENCY", "HSTS", "LOG_SAMPLE", "RATE_RPC", "PAGES_DOMAIN", "PLATFORM_MIN_BPS", "SSE_PER_IP", "UPLOAD_DAILY_MB", "deploy/env.example"]) assert.ok(m.includes(needle), `${needle} in:\n${m}`);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("partner API (DESIGN §12): PUBLIC_URL must be an origin; tier limits default to 60/1200 per minute and 2/20 streams", () => {
  const dir = tmp();
  try {
    const env = { DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m") };
    const c = loadConfig(env, { here: dir });
    assert.equal(c.publicUrl, "https://sporepad.com");
    assert.deepEqual(c.v1Limits, { publicPerMin: 60, partnerPerMin: 1200, publicStreams: 2, partnerStreams: 20, maxStreams: 2000 });
    const o = loadConfig({ ...env, PUBLIC_URL: "http://localhost:8796/", V1_RATE_PUBLIC: "5", V1_RATE_PARTNER: "50", V1_STREAMS_PUBLIC: "1", V1_STREAMS_PARTNER: "3", V1_STREAMS_MAX: "10" }, { here: dir });
    assert.equal(o.publicUrl, "http://localhost:8796");
    assert.deepEqual(o.v1Limits, { publicPerMin: 5, partnerPerMin: 50, publicStreams: 1, partnerStreams: 3, maxStreams: 10 });
    assert.throws(() => loadConfig({ ...env, PUBLIC_URL: "https://sporepad.com/app" }, { here: dir }), /PUBLIC_URL="https:\/\/sporepad.com\/app" must be an origin/);
    assert.throws(() => loadConfig({ ...env, PUBLIC_URL: "ftp://x.example" }, { here: dir }), /PUBLIC_URL must be a http\/https URL/);
    assert.throws(() => loadConfig({ ...env, V1_RATE_PUBLIC: "0" }, { here: dir }), /V1_RATE_PUBLIC="0" must be an integer ≥ 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("root agents config (DESIGN §13): off by default, gates and tick validated, the model key only from a file and never echoed", () => {
  const dir = tmp();
  try {
    const base = { DATA_DIR: join(dir, "data"), META_DIR: join(dir, "meta") };
    const c = loadConfig(base, { here: dir });
    assert.deepEqual(c.agents, { mode: "off", tickSec: 300, minScore: 40, cooldownMin: 60, maxPerHour: 12, probe: "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs", vaultKeyFile: null, aiRail: "keyed", model: "anthropic/claude-sonnet-5.5", startUsd: 5, reserveSol: 0.005, aiFloorUsd: 0.25, aiTargetUsd: 1, dailyUsdPerAgent: 2, dailyUsdTotal: 10, payoutAddress: null, keepSol: 0.1, launchEveryTicks: 3 });
    assert.deepEqual(c.llm, { url: null, keyFile: null, model: null, imageUrl: null, imageModel: "blackforestlabs/flux-3/klein/text-to-image", imageSize: "768x768", imageUsd: 0.008 });
    writeFileSync(join(dir, "llm.key"), "secret-key-value");
    const d = loadConfig({ ...base, AGENTS: "dry", AGENT_TICK_SEC: "30", AGENT_MIN_SCORE: "55", AGENT_COOLDOWN_MIN: "15", AGENT_MAX_PER_HOUR: "3", LLM_URL: "https://llm.example/v1/chat/completions", LLM_KEY_FILE: join(dir, "llm.key"), LLM_MODEL: "m" }, { here: dir });
    assert.deepEqual([d.agents.mode, d.agents.tickSec, d.agents.minScore, d.agents.cooldownMin, d.agents.maxPerHour], ["dry", 30, 55, 15, 3]);
    assert.deepEqual(d.llm, { url: "https://llm.example/v1/chat/completions", keyFile: join(dir, "llm.key"), model: "m", imageUrl: null, imageModel: "blackforestlabs/flux-3/klein/text-to-image", imageSize: "768x768", imageUsd: 0.008 });
    assert.ok(!JSON.stringify(d).includes("secret-key-value"), "the config holds the path, never the key");
    assert.throws(() => loadConfig({ ...base, AGENTS: "live", AGENT_TICK_SEC: "1", AGENT_MIN_SCORE: "101", LLM_URL: "ftp://x", LLM_KEY_FILE: join(dir, "missing.key"), LLM_KEY: "sk-in-env-1234" }, { here: dir }), (e) => {
      for (const needle of ["AGENTS=live needs AGENT_VAULT_KEY_FILE", "AGENT_TICK_SEC", "AGENT_MIN_SCORE", "LLM_URL must be a http/https URL", "LLM_KEY_FILE", "is not a readable file", "LLM_KEY is not read from the environment"]) assert.ok(e.message.includes(needle), `${needle} in:\n${e.message}`);
      assert.ok(!e.message.includes("sk-in-env-1234"), "a key in the environment is never echoed");
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
