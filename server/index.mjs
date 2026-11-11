// Spore server: pump.fun family-tree indexer + JSON API + static web app. Boots the sqlite-backed
// model, the RPC budget, the live subscription and the backfill, then serves /api/* (and web/dist in
// production). No keys live here; the browser builds and signs every transaction itself.
// Configuration is validated first (lib/config.mjs) so a bad deploy fails before it binds a port.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { Db } from "./lib/db.mjs";
import { Model } from "./lib/model.mjs";
import { Rpc, redact } from "./lib/rpc.mjs";
import { EventHub } from "./lib/events.mjs";
import { ImageCache, ImgWork, MetaFetcher, configureLocalMetaHost } from "./lib/meta.mjs";
import { Indexer } from "./lib/indexer.mjs";
import { createApp } from "./lib/api.mjs";
import { MetaHost, DailyQuota } from "./lib/metahost.mjs";
import { Treasury } from "./lib/treasury.mjs";
import { ApiKeys } from "./lib/apikeys.mjs";
import { AgentRegistry } from "./lib/agents/registry.mjs";
import { AgentRunner } from "./lib/agents/runner.mjs";
import { createLlm } from "./lib/agents/llm.mjs";
import { AgentVault, readVaultKey } from "./lib/agents-live/vault.mjs";
import { LiveAgents, routedLlm } from "./lib/agents-live/live.mjs";
import { startReconciler } from "./lib/agents-live/reconcile.mjs";
import { idStyleFor } from "./lib/agents-live/models.mjs";
import { createImageGen, imageUrlFor } from "./lib/agents-live/imagegen.mjs";
import { createBriefStore } from "./lib/agents/brief.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const log = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

let cfg;
try { cfg = loadConfig(process.env, { here, argv: process.argv.slice(2) }); }
catch (e) { console.error(`spore: ${e.message}`); process.exit(1); }

const db = new Db(join(cfg.dataDir, "spore.sqlite"));
const model = new Model(db, { platformWallet: cfg.platformWallet, splitBps: cfg.splitBps, platformMinBps: cfg.platformMinBps, mode: cfg.show, log });
model.load();
configureLocalMetaHost({ domain: cfg.pagesDomain, dir: join(cfg.metaDir, "m") });
const metahost = new MetaHost({ root: cfg.metaDir, domain: cfg.pagesDomain, project: cfg.pagesProject, log, ledger: db, quota: new DailyQuota(cfg.uploadQuota) });
const rpc = new Rpc({ url: cfg.rpcUrl, rps: cfg.rpcRps, concurrency: cfg.concurrency, apiRps: cfg.rpcApiRps, proxyRps: cfg.rpcProxyRps, log });
const hub = new EventHub({ maxClients: cfg.sseMaxClients, maxPerIp: cfg.ssePerIp });
const imgWork = new ImgWork({ log }); // thumbnails and logo sheets render on a worker thread, never on this loop
// 8 origin downloads at once (map logos from far), at most half of them for background work (first sight, warm
// pass) so a visitor's /api/img and /api/logo-sheet never queue behind it; failures and the warm cursor live in sqlite.
const images = new ImageCache(join(cfg.dataDir, "img"), { log, maxBytes: cfg.imgCacheBytes, thumbMaxBytes: cfg.imgThumbBytes, concurrency: 8, work: imgWork, store: db });
// First sight: every image url the model learns (a metadata image, an asset icon) gets its 64 px thumbnail queued at once.
model.onImage = (url) => images.enqueueThumb(url);
const meta = new MetaFetcher(model, { log, concurrency: 6 });
const indexer = new Indexer({ rpc, model, meta, hub, log, opts: { backfill: cfg.backfill, backfillLimit: cfg.backfillLimit, refreshMs: cfg.refreshMs, fullRefreshMs: cfg.fullRefreshMs, wsUrl: cfg.wsUrl, createdAtProbe: cfg.createdAtProbe } });
// Partner keys for /v1 (DESIGN §12): verified per request, usage counters written every 30 s.
const apiKeys = new ApiKeys(db, { log }).start();
const treasury = new Treasury({ model, rpc, platformWallet: cfg.platformWallet, ttlMs: cfg.treasuryTtlMs, log });
// Root agents (DESIGN §13), phase 0: AGENTS=dry proposes and simulates launches, never signs or sends;
// AGENTS=off (default) runs nothing and the read-only API still serves what is stored. They read and
// simulate on the api RPC lane, so they can never starve the indexer.
const agentRegistry = new AgentRegistry(db);
// The agent wallet vault (DESIGN §13.1) serves root launches in every mode: POST /api/agents/prepare
// makes the wallet whose address goes into the root's three-way split. Without a vault key, root
// launches are refused by the browser's policy check (it needs an agent address).
let agentVault = null;
if (cfg.agents.vaultKeyFile) {
  try { agentVault = new AgentVault({ dir: join(cfg.dataDir, "agents", "wallets"), vaultKey: readVaultKey(cfg.agents.vaultKeyFile) }); }
  catch (e) { console.error(`spore: agent vault: ${e.message}`); process.exit(1); }
}
// AGENTS=live: the dry runner stays the idea engine (its own loop off), every call paid by the agent
// that is running (routedLlm), and LiveAgents adds wallet, budget, launch, claim and top-up.
const live = cfg.agents.mode === "live";
// The owner's keyed provider (LLM_URL + LLM_KEY_FILE): the dry run's model, and under AGENTS=live with
// AGENT_AI_RAIL=keyed the model every agent thinks with, each call booked against its root.
const keyedLlm = createLlm({ url: cfg.llm.url, keyFile: cfg.llm.keyFile, model: cfg.llm.model || "claude-sonnet-5-5", log });
const imageGen = createImageGen({ url: cfg.llm.imageUrl ?? imageUrlFor(cfg.llm.url), keyFile: cfg.llm.keyFile, model: cfg.llm.imageModel, size: cfg.llm.imageSize, usdPerImage: cfg.llm.imageUsd, log });
const router = live ? routedLlm() : null;
const llm = live ? router : keyedLlm;
// Owner briefs (DESIGN §13.3): DATA_DIR/agents/briefs.json, set with scripts/agent-brief.mjs, re-read when it changes.
const agentBriefs = createBriefStore(cfg.dataDir, { log });
const agentRunner = new AgentRunner({ registry: agentRegistry, model, rpc: rpc.lane("api"), hub, llm, log, briefs: agentBriefs,
  cfg: { ...cfg.agents, platformWallet: cfg.platformWallet, splitBps: cfg.splitBps, launchFeeSol: cfg.launchFeeSol, pagesDomain: cfg.pagesDomain, dataDir: cfg.dataDir } });
const liveAgents = live ? new LiveAgents({ runner: agentRunner, router, registry: agentRegistry, model, rpc: rpc.lane("api"), metaHost: metahost, hub, log, keyedLlm, imageGen,
  cfg: { dataDir: cfg.dataDir, vaultKeyFile: cfg.agents.vaultKeyFile, model: cfg.agents.model, aiRail: cfg.agents.aiRail, llmIdStyle: idStyleFor(cfg.llm.url), platformWallet: cfg.platformWallet, splitBps: cfg.splitBps, startUsd: cfg.agents.startUsd, reserveSol: cfg.agents.reserveSol, aiFloorUsd: cfg.agents.aiFloorUsd, aiTargetUsd: cfg.agents.aiTargetUsd, dailyUsdPerAgent: cfg.agents.dailyUsdPerAgent, dailyUsdTotal: cfg.agents.dailyUsdTotal, payoutAddress: cfg.agents.payoutAddress, keepSol: cfg.agents.keepSol, launchEveryTicks: cfg.agents.launchEveryTicks },
  deps: { vault: agentVault } }) : null;
if (live && cfg.agents.aiRail === "keyed" && !keyedLlm.available) log.warn("agents: live with the keyed rail but no model key (LLM_URL + LLM_KEY_FILE): agents will use template names and logos");
// Prepared wallets are bound from the chain in every mode (the browser's report is best effort).
const stopReconciler = agentVault ? startReconciler({ vault: agentVault, model, registry: agentRegistry, log }) : () => {};
const app = createApp({
  model, indexer, rpc, hub, images, meta, metahost, treasury, metaDir: cfg.metaDir, platformWallet: cfg.platformWallet, splitBps: cfg.splitBps, launchFeeSol: cfg.launchFeeSol,
  distDir: cfg.distDir, origins: cfg.origins, log, rates: cfg.rates, trustProxy: cfg.trustProxy, hsts: cfg.hsts, logSample: cfg.logSample, pagesDomain: cfg.pagesDomain, cspConnect: cfg.cspConnect,
  apiKeys, publicUrl: cfg.publicUrl, v1Limits: cfg.v1Limits,
  agents: { registry: agentRegistry, runner: agentRunner, mode: cfg.agents.mode, cooldownMin: cfg.agents.cooldownMin, dataDir: cfg.dataDir, vault: agentVault, live: liveAgents, briefs: agentBriefs },
});

const server = app.listen(cfg.port, () => log.info(`spore api on :${cfg.port} → ${redact(cfg.rpcUrl)} (ws ${redact(cfg.wsUrl)}) data ${cfg.dataDir}${cfg.backfill ? (Number.isFinite(cfg.backfillLimit) ? ` backfill limit ${cfg.backfillLimit}` : "") : " backfill off"} mode ${cfg.show} agents ${cfg.agents.mode} fee ${cfg.launchFeeSol} SOL meta ${cfg.pagesDomain} trust-proxy ${JSON.stringify(cfg.trustProxy)}`));
server.on("error", (e) => { log.error(`listen :${cfg.port} failed: ${e.message}`); process.exit(1); });
// Longer than a typical proxy's upstream keep-alive (nginx 60 s) so the proxy never reuses a socket we just closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 120_000; // the upload waits on a wrangler deploy; everything else answers in milliseconds

const imageSweep = setInterval(() => { try { images.sweep(); } catch { /* best effort */ } }, 6 * 3600_000); imageSweep.unref();
// Map logos from far: the 64 px thumbnail of every family top (+ gen-1 of the 60 biggest) made ahead of the
// first visitor, 3 min after boot (the backfill's mints and metadata are loaded by then) and every 30 min.
// (repair 2026-10-22) every tracked coin's logo, tops and big families first; one pass at a time (a pass stops at
// WARM_MAX_MS and the next one, after a restart too, resumes where it stopped: kv imgWarmCursor; failed urls rest
// for their kind's retry time, kept in sqlite img_fail), so the dead upstreams never pile the passes up.
let warmRun = null;
const warmLogos = () => warmRun ?? (warmRun = images.warm(model.warmImageUrls(60, true), 64, 4, { resume: "imgWarmCursor" }).then((r) => log.info(`img warm: ${r.ok}/${r.n} thumbnails ready from #${r.from}, ${r.failed} failed (${r.skipped} skipped${r.full ? `, ${r.full} over the thumbnail budget` : ""}${r.stopped ? ", stopped at the time budget" : ""}), ${r.ms} ms`)).catch((e) => log.warn(`img warm: ${e.message}`)).finally(() => { warmRun = null; }));
const imageWarmFirst = setTimeout(warmLogos, 3 * 60_000); imageWarmFirst.unref();
const imageWarm = setInterval(warmLogos, 30 * 60_000); imageWarm.unref();
// Uploaded metadata nobody launched with is removed after META_GC_HOURS (0 keeps everything); the
// model decides what is referenced, so a file a coin points at is never touched.
const metaGc = cfg.metaGcHours > 0 ? setInterval(() => { metahost.gc({ referenced: (name) => model.referencesMetaFile(name), maxAgeMs: cfg.metaGcHours * 3600_000 }).catch((e) => log.warn(`metahost gc: ${e.message}`)); }, 3600_000) : null; metaGc?.unref();
// A periodic checkpoint keeps the WAL small so a crash loses little and a backup copies one file.
const checkpoint = setInterval(() => db.checkpoint(), 15 * 60_000); checkpoint.unref();

try { await indexer.start(); } catch (e) { log.error(`indexer failed to start: ${e.stack ?? e}`); process.exitCode = 1; shutdown("indexer"); }
// Off-chain metadata for every tracked coin (DESIGN §11.5): a background sweep every minute, by
// locked value then recency; HTTP to gateways only, so it never competes with the RPC lanes.
meta.start();
(await import("./lib/asset-icons.mjs")).startAssetIcons({ model, log }); // listed-asset logos (token list icons) at boot and every 6 h, unref'd
agentRunner.start();
// Live agents (DESIGN §13.1): one pass every tick, agents in turn; the first pass waits for the
// index to settle. AGENTS=off|dry never constructs this.
let liveTimer = null;
if (liveAgents) {
  const pass = () => liveAgents.tick().catch((e) => log.warn(`agents: live pass failed: ${e?.message ?? e}`));
  setTimeout(pass, 20_000).unref?.();
  liveTimer = setInterval(pass, cfg.agents.tickSec * 1000); liveTimer.unref?.();
  log.info(`agents: LIVE every ${cfg.agents.tickSec} s (model ${cfg.agents.model}, start $${cfg.agents.startUsd}, reserve ${cfg.agents.reserveSol} SOL, pocket $${cfg.agents.aiFloorUsd}→$${cfg.agents.aiTargetUsd}); wallets in ${join(cfg.dataDir, "agents", "wallets")}`);
}

/**
 * Graceful stop: stop accepting, end every SSE stream (clients reconnect to the new process), let
 * in-flight requests finish, then checkpoint and close sqlite. A hard exit after 8 s guards
 * against a stuck socket; PM2/systemd both wait that long (kill_timeout / TimeoutStopSec).
 */
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`shutting down (${signal})`);
  clearInterval(imageSweep); clearInterval(imageWarm); clearTimeout(imageWarmFirst); clearInterval(checkpoint); if (metaGc) clearInterval(metaGc); images.close();
  indexer.stop(); meta.stop(); agentRunner.stop(); clearInterval(liveTimer); liveAgents?.stop(); stopReconciler(); hub.close(); app.locals.v1?.close(); apiKeys.stop(); imgWork.close();
  server.close(() => { try { apiKeys.flush(); db.close(); } catch { /* already closed */ } log.info("bye"); process.exit(process.exitCode ?? 0); });
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 2_000).unref();
  setTimeout(() => { log.warn("forced exit"); try { apiKeys.flush(); db.close(); } catch { /* ignore */ } process.exit(process.exitCode ?? 0); }, 8_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => log.error(`unhandled rejection: ${e?.stack ?? e}`));
process.on("uncaughtException", (e) => { log.error(`uncaught exception: ${e?.stack ?? e}`); process.exitCode = 1; shutdown("uncaughtException"); });
