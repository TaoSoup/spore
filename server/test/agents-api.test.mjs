// Root agents API (DESIGN §13, §13.2): /api/agents, /api/agents/:root, /api/agents/coin/:mint, the logo
// route, and the /v1 copies with absolute images; read-only, exact shapes, 400/404s, caching; wallets
// (bound column or vault), balances (live pass or RPC, 60 s cache), ledger activity and totals,
// launched coins, and the public rule (Spore roots and running agents; never a paused foreign one).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createAgentBalances } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { AgentRegistry, agentsBody, agentBody, agentCoinBody, isPublicAgent } from "../lib/agents/registry.mjs";
import { renderLogo } from "../lib/agents/logo.mjs";
import { Keypair } from "@solana/web3.js";
import { AgentVault, initVaultKey, readVaultKey } from "../lib/agents-live/vault.mjs";
import { V1_STREAM_TYPES, V1Stream } from "../lib/v1.mjs";
import { openApiDoc } from "../lib/openapi.mjs";
import { agentTree, K, PLATFORM, quiet } from "./helpers/agents.mjs";
import { base as coinBase, T22 } from "./helpers/tree.mjs";

const PUB = "https://sporepad.com";
const PROPOSAL_KEYS = ["createdAt", "description", "id", "image", "logoSource", "name", "reason", "rejectedReason", "runnersUp", "score", "sim", "source", "status", "symbol", "why"];
const AGENT_KEYS = ["activity", "brief", "latest", "launched", "model", "modelLabel", "owedUsd", "profile", "reason", "root", "sleeping", "stats", "status", "totals", "wallet"];
const WALLET_KEYS = ["address", "sol", "updatedAt", "usd", "usdc"];
const TOTALS_KEYS = ["aiCalls", "aiUsd", "claimsSol", "claimsUsd", "lastActivityAt", "launchSol", "launches", "payoutsSol", "payoutsUsdc"];
const LAUNCHED_KEYS = ["createdAt", "image", "logoSource", "mint", "name", "signature", "symbol", "why"];
const ACTIVITY_KEYS = ["amountSol", "amountUsdc", "at", "explorer", "kind", "mint", "signature", "status", "symbol", "title", "usd"];
const SUMMARY_KEYS = ["address", "model", "modelLabel", "status", "totals", "wallet"];
const SIG_LAUNCH = "2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ";
const SIG_SPLIT = "wVpMu7Dcvnvx8KpjzzNny4EvRdbJo6mY73vaA9GSrMnUzjkVPxKA8HsiyaoN5Nv4tc4MNKd3DopxoTprqmcysgy";
const SIG_CLAIM = "u9QVt9Ft3ydwgtrpKLUMJcr6wnjF8giQKUS2t8oDqervjwGCvNBVaGymDHCSvC2rWfqJtrKM5UAAKce7PPemEvo";
const SIG_PAY = "3wwWTtUv32NNFy1K4gdEtANZ6usRf6fSb6HYn1x6Tiuq817XvMyCCZW7Fm2DGmiNnNj8BRXnq4M1mxdivQsmuWkk";
const A_WALLET = Keypair.generate().publicKey.toBase58(); // an on-curve owner (a USDC token account can be derived for it)
const ID3 = (3).toString(16).padStart(16, "0");
let dir, srv, base, hub, db, registry, png, vault, rootWallet, clock, rpcCalls, theModel;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "spore-agents-api-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  ({ db, model: srv } = agentTree());
  const model = srv; theModel = model;
  // K.A is a Spore launch (the platform in its split); ROOT and B are foreign roots.
  model.upsertCoin({ mint: K.A, curve: "C_A", depth: 1, quoteMint: K.ROOT, ...coinBase, virtualQuoteReserves: "2000000000000000", realQuoteReserves: "50000000000000", createdAt: 2000, shares: [{ address: "CR", bps: 5000 }, { address: PLATFORM, bps: 5000 }], sharesAt: 1 });
  registry = new AgentRegistry(db);
  registry.enable(K.ROOT, { profile: { summary: "s", themes: ["a", "b", "c"], tone: "t", avoid: [], palette: ["#000000", "#ffffff"], source: "fallback", builtAt: 1 } });
  registry.enable(K.B); registry.pause(K.B);                       // paused AND foreign: never public
  registry.enable(K.A, { wallet: A_WALLET, model: "anthropic/claude-opus-5.5" }); registry.pause(K.A); // paused but ours: public
  // The ROOT agent's wallet lives only in the vault (bound before the column existed).
  const keyFile = join(dir, "vault.key"); initVaultKey(keyFile);
  vault = new AgentVault({ dir: join(dir, "agents", "wallets"), vaultKey: readVaultKey(keyFile) });
  rootWallet = vault.create(K.ROOT).address;
  png = await renderLogo({ symbol: "GLOW", palette: [], seed: "x" });
  // 55 proposals for ROOT, newest last; the API returns the newest 50, newest first.
  for (let i = 0; i < 55; i++) {
    const id = i.toString(16).padStart(16, "0");
    registry.addProposal({ id, root: K.ROOT, createdAt: 1_000 + i, name: `Idea ${i}`, symbol: `IDEA${i}`, description: `d${i}`, imageFile: `${id}.png`, score: 50, reason: "because",
      sim: i === 54 ? { ok: false, err: "boom" } : { ok: true, bytes: 884, unitsConsumed: 157_000, estCostSol: 0.0148, err: null, agent: "x", txs: 2 }, status: i === 54 ? "rejected" : "proposed", rejectedReason: i === 54 ? "simulation failed: boom" : null,
      source: i % 2 ? "model" : "fallback", runnersUp: [{ name: "R", symbol: "RR", extra: 1 }], ...(i === 3 ? { why: "because spores", logoSource: "model" } : {}) });
    writeFileSync(join(dir, "agents", `${id}.png`), png);
  }
  db.db.exec("UPDATE agents SET runs = 55, proposals = 55, last_run_at = 1054 WHERE root_mint = '" + K.ROOT + "'");
  writeFileSync(join(dir, "agents", "ffffffffffffffff.png"), png); // on disk but no proposal names it
  // The ROOT agent launched G (from proposal 3) and K.X (the index does not know it: proposal names apply).
  registry.markLaunched(K.ROOT, { mint: K.G, proposalId: ID3, signature: SIG_LAUNCH, splitDone: false, at: 1_050 });
  registry.markSplit(K.G, SIG_SPLIT);
  registry.markLaunched(K.ROOT, { mint: K.X, proposalId: (4).toString(16).padStart(16, "0"), signature: null, at: 1_060 });
  // Its ledger: a model call, a logo, the two-transaction launch of G, a SOL claim from ROOT, a payout.
  const L = (ts, e) => JSON.stringify({ ts, ...e }) + "\n";
  writeFileSync(join(dir, "agents", "ledger.jsonl"),
    L(1_040, { kind: "ai", rail: "keyed", root: K.ROOT, model: "anthropic/claude-sonnet-5.5", provider: "x", status: "done", promptTokens: 1400, completionTokens: 400, estUsd: 0.013 })
    + L(1_042, { kind: "ai", rail: "keyed", root: K.ROOT, provider: "img", status: "done", image: true, estUsd: 0.008 })
    + L(1_045, { kind: "launch", root: K.ROOT, address: rootWallet, mint: K.G, name: "Tiny Cap", symbol: "TCAP", uri: "u", estCostSol: 0.0148, txs: 2, status: "pending" })
    + L(1_046, { kind: "launch", root: K.ROOT, mint: K.G, step: 1, of: 2, signature: SIG_LAUNCH, status: "sent" })
    + L(1_050, { kind: "launch", root: K.ROOT, mint: K.G, step: 1, of: 2, signature: SIG_LAUNCH, slot: 1, status: "step_landed" })
    + L(1_055, { kind: "launch", root: K.ROOT, mint: K.G, step: 2, of: 2, signature: SIG_SPLIT, slot: 2, status: "landed" })
    + L(1_100, { kind: "claim", root: K.ROOT, address: rootWallet, mint: K.ROOT, total: "104900000", mine: "54900000", sol: true, signature: SIG_CLAIM, status: "pending" })
    + L(1_103, { kind: "claim", root: K.ROOT, mint: K.ROOT, signature: SIG_CLAIM, slot: 3, status: "landed" })
    + L(1_200, { kind: "payout", root: K.ROOT, address: rootWallet, to: "o", lamports: 120_000_000, usdcMicros: 0, signature: SIG_PAY, status: "pending" })
    + L(1_204, { kind: "payout", root: K.ROOT, address: rootWallet, to: "o", signature: SIG_PAY, slot: 4, status: "landed" })
    + "garbage\n");
  hub = new EventHub({ heartbeatMs: 60_000 });
  clock = 1_700_000_000_000; rpcCalls = [];
  const rpc = { proxy: async () => ({ status: 200, text: "{}" }), call: async (method, params) => { rpcCalls.push([method, params[0]]); if (method === "getBalance") return { value: 2_500_000_000 }; if (method === "getTokenAccountBalance") return { value: { amount: "1500000" } }; return null; } };
  const app = createApp({ model, indexer: { fetchCoin: async () => null, snapshot: () => ({}) }, rpc, hub, images: { handler: () => (_q, r) => r.status(404).end() }, meta: null,
    platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], distDir: null, log: quiet, trustProxy: true, publicUrl: PUB, v1Limits: { publicPerMin: 10_000 }, now: () => clock,
    agents: { registry, mode: "dry", cooldownMin: 60, dataDir: dir, vault, runner: { snapshot: () => ({ mode: "dry", runs: 3 }) } } });
  srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  srv.app = app;
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.app.locals.v1.close(); hub.close(); srv.closeAllConnections?.(); srv.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); const buf = Buffer.from(await r.arrayBuffer()); let body = null; try { body = JSON.parse(buf.toString()); } catch { body = buf; } return { status: r.status, headers: r.headers, body }; };

function checkProposal(p, imageBase) {
  assert.deepEqual(Object.keys(p).sort(), PROPOSAL_KEYS);
  assert.deepEqual(Object.keys(p.sim).sort(), ["bytes", "err", "estCostSol", "ok", "unitsConsumed"], "exactly the contract's sim fields");
  assert.equal(p.image, `${imageBase}/api/agents/img/${p.id}.png`);
  assert.ok(["model", "fallback"].includes(p.source));
  for (const r of p.runnersUp) assert.deepEqual(Object.keys(r).sort(), ["name", "symbol"]);
}
function checkAgent(a, imageBase) {
  assert.deepEqual(Object.keys(a).sort(), AGENT_KEYS);
  assert.deepEqual(Object.keys(a.stats).sort(), ["lastRunAt", "nextRunAt", "proposals", "runs", "score", "scoreReason"]);
  assert.deepEqual(Object.keys(a.totals).sort(), TOTALS_KEYS);
  if (a.wallet) assert.deepEqual(Object.keys(a.wallet).sort(), WALLET_KEYS);
  for (const l of a.launched) { assert.deepEqual(Object.keys(l).sort(), LAUNCHED_KEYS); if (l.image) assert.ok(l.image.startsWith(`${imageBase}/api/`), l.image); }
  for (const x of a.activity) { assert.deepEqual(Object.keys(x).sort(), ACTIVITY_KEYS); if (x.signature) assert.equal(x.explorer, `https://solscan.io/tx/${x.signature}`); }
  assert.ok(a.launched.length <= 12 && a.activity.length <= 8);
  assert.ok(typeof a.model === "string" && typeof a.modelLabel === "string");
}

test("GET /api/agents: public agents only (Spore roots or running), running first; root CoinRef, profile, stats, latest, wallet, totals, launched, activity", async () => {
  const { status, body, headers } = await get("/api/agents");
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["agents", "mode"]); assert.equal(body.mode, "dry");
  assert.deepEqual(body.agents.map((a) => [a.root.mint, a.status]), [[K.ROOT, "dry"], [K.A, "paused"]], "the paused foreign agent (B) is not served");
  const a = body.agents[0];
  checkAgent(a, "");
  assert.deepEqual(a.root, { mint: K.ROOT, name: "Mushroom Grove", symbol: "GROVE", image: `/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/imgGrove")}`, depth: 0 });
  assert.equal(a.profile.themes.length, 3);
  assert.deepEqual([a.stats.runs, a.stats.proposals, a.stats.lastRunAt], [55, 55, 1054]);
  assert.ok(a.stats.score > 0 && a.stats.score <= 100); assert.match(a.stats.scoreReason, /^momentum \d+\/100: 2 children, 30 trades\/1h/);
  checkProposal(a.latest, "");
  assert.equal(a.latest.id, (54).toString(16).padStart(16, "0"));
  assert.deepEqual(a.latest.sim, { ok: false, bytes: null, unitsConsumed: null, estCostSol: null, err: "boom" });
  assert.deepEqual([a.latest.status, a.latest.rejectedReason], ["rejected", "simulation failed: boom"]);
  assert.deepEqual([a.model, a.modelLabel], ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"], "the server default when the creator picked none");
  // Wallet from the vault (no column), balances from the RPC double at the model's SOL price (readAt is the read's own clock).
  assert.deepEqual({ ...a.wallet, updatedAt: null }, { address: rootWallet, sol: 2.5, usdc: 1.5, usd: 251.5, updatedAt: null });
  assert.ok(Math.abs(a.wallet.updatedAt - Date.now() / 1000) < 60);
  // Totals from the ledger (+ the registry's launch count, which also knows the coin without ledger lines).
  assert.deepEqual(a.totals, { launches: 2, launchSol: 0.0148, claimsSol: 0.0549, claimsUsd: 5.49, aiUsd: 0.021, aiCalls: 2, payoutsSol: 0.12, payoutsUsdc: 0, lastActivityAt: 1_204 });
  // Launched coins newest first: X (unknown to the index → the proposal's name and logo), then G.
  assert.deepEqual(a.launched, [
    { mint: K.X, name: "Idea 4", symbol: "IDEA4", image: `/api/agents/img/${(4).toString(16).padStart(16, "0")}.png`, createdAt: 1_060, signature: null, why: null, logoSource: null },
    { mint: K.G, name: "Tiny Cap", symbol: "TCAP", image: `/api/agents/img/${ID3}.png`, createdAt: 1_050, signature: SIG_LAUNCH, why: "because spores", logoSource: "model" },
  ]);
  // Activity newest first, human titles with tickers, signatures and explorer links; the garbage line is ignored.
  assert.deepEqual(a.activity.map((x) => [x.at, x.kind, x.status, x.title, x.amountSol, x.usd, x.symbol, x.signature]), [
    [1_200, "payout", "landed", "Paid 0.12 SOL to the owner", 0.12, 12, null, SIG_PAY],
    [1_100, "claim", "landed", "Claimed 0.0549 SOL from $GROVE", 0.0549, 5.49, "GROVE", SIG_CLAIM],
    [1_045, "launch", "landed", "Launched $TCAP", 0.0148, 1.48, "TCAP", SIG_LAUNCH],
    [1_042, "ai", "done", "Drew a logo ($0.008)", null, 0.008, null, null],
    [1_040, "ai", "done", "Thought with Claude Sonnet 5.5 ($0.013)", null, 0.013, null, null],
  ]);
  assert.equal(a.activity[0].explorer, `https://solscan.io/tx/${SIG_PAY}`);
  const paused = body.agents[1];
  checkAgent(paused, "");
  assert.equal(paused.latest, null); assert.equal(paused.profile, null); assert.equal(paused.stats.nextRunAt, null, "a paused agent has no next run");
  assert.deepEqual([paused.model, paused.modelLabel], ["anthropic/claude-opus-5.5", "Claude Opus 5.5"]);
  assert.deepEqual({ ...paused.wallet, updatedAt: null }, { address: A_WALLET, sol: 2.5, usdc: 1.5, usd: 251.5, updatedAt: null }, "the bound column wins");
  assert.deepEqual([paused.totals.launches, paused.totals.lastActivityAt, paused.launched, paused.activity], [0, null, [], []]);
  assert.match(headers.get("cache-control"), /max-age=10/); assert.ok(headers.get("etag"));
  assert.equal((await get("/api/agents", { "if-none-match": headers.get("etag") })).status, 304);
});

test("wallet balances are read once per minute per address (live pass first, then the RPC), never per request", async () => {
  rpcCalls.length = 0;
  await get("/api/agents");
  assert.equal(rpcCalls.length, 0, "within the ttl nothing is read");
  clock += 61_000;
  const { body } = await get("/api/agents");
  assert.deepEqual(rpcCalls.map((c) => c[0]).sort(), ["getBalance", "getBalance", "getTokenAccountBalance", "getTokenAccountBalance"], "both wallets re-read after 60 s");
  assert.equal(new Set(rpcCalls.filter((c) => c[0] === "getBalance").map((c) => c[1])).size, 2, "one read per wallet");
  assert.ok(body.agents[0].wallet.updatedAt > 0);
  // The cache itself: the live orchestrator's budget wins, a failed read keeps null and is not retried before the ttl, a slow read never blocks past waitMs.
  let t = 0; const reads = [];
  const live = { state: new Map([["R1", { budget: { sol: 9, usdc: 1, usd: 901, readAt: 123 } }]]) };
  const bal = createAgentBalances({ rpc: { call: async () => null }, model: { solUsd: 100 }, live, now: () => t, ttlMs: 60_000, waitMs: 20, log: quiet,
    read: async (_rpc, address) => { reads.push(address); if (address === "bad") throw new Error("rpc down"); if (address === "slow") await new Promise((r) => setTimeout(r, 200)); return { sol: 1, usdc: 2, usd: 102, readAt: 77 }; } });
  await bal.prime([{ root: "R1", address: "W1" }, { root: "R2", address: "ok" }, { root: "R3", address: "bad" }]);
  assert.deepEqual(reads.sort(), ["bad", "ok"], "a root the live pass knows is not read");
  assert.deepEqual(bal.get("R1", "W1"), { sol: 9, usdc: 1, usd: 901, updatedAt: 123 });
  assert.deepEqual(bal.get("R2", "ok"), { sol: 1, usdc: 2, usd: 102, updatedAt: 77 });
  assert.equal(bal.get("R3", "bad"), null);
  await bal.prime([{ root: "R3", address: "bad" }]);
  assert.equal(reads.length, 2, "the failure is cached for the ttl");
  t = 61_000; await bal.prime([{ root: "R3", address: "bad" }]); assert.equal(reads.length, 3);
  const t0 = Date.now(); await bal.prime([{ root: "R4", address: "slow" }]);
  assert.ok(Date.now() - t0 < 150, "waited at most waitMs"); assert.equal(bal.get("R4", "slow"), null, "fills in later");
  await new Promise((r) => setTimeout(r, 250)); assert.equal(bal.get("R4", "slow")?.sol, 1);
  assert.equal(bal.get("R5", null), null);
  assert.deepEqual(Object.keys(bal.snapshot()).sort(), ["cached", "pending"]);
});

test("GET /api/agents/:root: the agent, its 50 newest proposals, up to 200 activity items and every launch; 400 malformed, 404 without a public agent", async () => {
  const { status, body } = await get(`/api/agents/${K.ROOT}`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["activity", "agent", "launched", "proposals"]);
  checkAgent(body.agent, "");
  assert.equal(body.proposals.length, 50);
  assert.deepEqual(body.proposals.slice(0, 2).map((p) => p.symbol), ["IDEA54", "IDEA53"]);
  assert.equal(body.proposals.at(-1).symbol, "IDEA5");
  for (const p of body.proposals) checkProposal(p, "");
  assert.deepEqual(body.proposals[1].sim, { ok: true, bytes: 884, unitsConsumed: 157_000, estCostSol: 0.0148, err: null });
  assert.deepEqual(body.proposals[1].runnersUp, [{ name: "R", symbol: "RR" }]);
  assert.equal(body.proposals.some((p) => p.id === ID3), false, "the oldest five are off the page (their why still reaches `launched`)");
  assert.deepEqual(body.activity, body.agent.activity, "five actions fit both lists");
  assert.deepEqual(body.launched, body.agent.launched);
  assert.equal((await get("/api/agents/not-a-mint")).status, 400);
  const ours = await get(`/api/agents/${K.A}`);
  assert.equal(ours.status, 200); assert.equal(ours.body.agent.status, "paused");
  for (const m of [K.B, K.G]) { const none = await get(`/api/agents/${m}`); assert.equal(none.status, 404, m); assert.deepEqual(none.body, { error: "no agent for this coin" }); }
});

test("GET /api/agents/coin/:mint: root / child / null roles, the agent in short, the launch; never a 404 for a coin", async () => {
  const root = await get(`/api/agents/coin/${K.ROOT}`);
  assert.equal(root.status, 200);
  assert.deepEqual(Object.keys(root.body).sort(), ["agent", "launch", "root"].concat(["role"]).sort());
  assert.equal(root.body.role, "root");
  assert.deepEqual(root.body.root, { mint: K.ROOT, name: "Mushroom Grove", symbol: "GROVE", image: `/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/imgGrove")}`, depth: 0 });
  assert.deepEqual(Object.keys(root.body.agent).sort(), SUMMARY_KEYS);
  assert.deepEqual([root.body.agent.address, root.body.agent.status, root.body.agent.model, root.body.agent.modelLabel, root.body.agent.wallet.address, root.body.agent.totals.launches], [rootWallet, "dry", "anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", rootWallet, 2]);
  assert.equal(root.body.launch, null);
  const child = await get(`/api/agents/coin/${K.G}`);
  assert.equal(child.body.role, "child");
  assert.equal(child.body.root.mint, K.ROOT);
  assert.equal(child.body.agent.address, rootWallet);
  assert.deepEqual(child.body.launch, { signature: SIG_LAUNCH, at: 1_050, why: "because spores", logoSource: "model", proposalId: ID3 });
  const paused = await get(`/api/agents/coin/${K.A}`);
  assert.deepEqual([paused.body.role, paused.body.agent.status, paused.body.agent.wallet.address], ["root", "paused", A_WALLET]);
  for (const m of [K.B, K.U]) assert.deepEqual((await get(`/api/agents/coin/${m}`)).body, { role: null, root: null, agent: null, launch: null }, m);
  assert.equal((await get("/api/agents/coin/nope")).status, 400);
  assert.match(root.headers.get("cache-control"), /max-age=10/);
});

test("views: a running row shows `live` under AGENTS=live (the row stays dry), `dry` otherwise; the public rule; no ledger / vault / wallets is fine", () => {
  const m = theModel;
  const live = agentsBody({ model: m, registry, mode: "live" });
  assert.deepEqual(live.agents.map((a) => [a.root.mint, a.status]), [[K.ROOT, "live"], [K.A, "paused"]]);
  assert.deepEqual(live.agents[0].wallet, null, "no vault, no column: no wallet, never a placeholder");
  assert.deepEqual([live.agents[0].totals.launches, live.agents[0].activity, live.agents[0].launched.length], [2, [], 2]);
  assert.equal(agentsBody({ model: m, registry, mode: "dry" }).agents[0].status, "dry");
  assert.equal(agentBody(K.ROOT, { model: m, registry, mode: "live" }).agent.status, "live");
  assert.equal(agentCoinBody(K.G, { model: m, registry, mode: "live" }).agent.status, "live");
  assert.equal(agentCoinBody(K.ROOT, { model: m, registry, mode: "off" }).agent.status, "dry");
  assert.deepEqual([isPublicAgent(registry.get(K.ROOT), m), isPublicAgent(registry.get(K.B), m), isPublicAgent(null, m)], [true, false, false]);
});

test("GET /api/agents/img/<id>.png: stored logos only, immutable cache, PNG type; everything else 404", async () => {
  const ok = await get("/api/agents/img/0000000000000003.png");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal(ok.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(ok.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.deepEqual(ok.body, png);
  for (const p of ["/api/agents/img/ffffffffffffffff.png", "/api/agents/img/0000000000000003.PNG", "/api/agents/img/..%2Fspore.sqlite", "/api/agents/img/0000000000000003.png.bak", "/api/agents/img/zzzz.png"]) assert.equal((await get(p)).status, 404, p);
});

test("/v1/agents, /v1/agents/:root, /v1/agents/coin/:mint: the same shapes with absolute images, partner CORS and cache", async () => {
  const list = await get("/v1/agents");
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("access-control-allow-origin"), "*");
  assert.equal(list.headers.get("cache-control"), "public, max-age=5, s-maxage=10");
  const local = (await get("/api/agents")).body;
  assert.deepEqual(Object.keys(list.body).sort(), Object.keys(local).sort());
  const a = list.body.agents[0];
  checkAgent(a, PUB);
  assert.equal(a.root.image, `${PUB}/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/imgGrove")}`);
  assert.equal(a.launched[1].image, `${PUB}/api/agents/img/${ID3}.png`);
  checkProposal(a.latest, PUB);
  assert.deepEqual(a.activity, local.agents[0].activity);
  const one = await get(`/v1/agents/${K.ROOT}`);
  assert.equal(one.status, 200); assert.equal(one.body.proposals.length, 50);
  assert.deepEqual(Object.keys(one.body).sort(), ["activity", "agent", "launched", "proposals"]);
  for (const p of one.body.proposals) checkProposal(p, PUB);
  assert.equal((await get(`/v1/agents/${K.B}`)).status, 404);
  assert.equal((await get("/v1/agents/bad")).status, 400);
  const coin = await get(`/v1/agents/coin/${K.G}`);
  assert.equal(coin.status, 200); assert.equal(coin.body.role, "child"); assert.equal(coin.body.root.image, `${PUB}/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/imgGrove")}`);
  assert.deepEqual((await get(`/v1/agents/coin/${K.U}`)).body, { role: null, root: null, agent: null, launch: null });
  assert.equal((await get("/v1/agents/coin/bad")).status, 400);
  const post = await fetch(`${base}/v1/agents`, { method: "POST" });
  assert.equal(post.status, 405, "read-only");
  assert.ok(V1_STREAM_TYPES.includes("agent"));
  assert.deepEqual([...V1Stream.parse({ types: "agent" }, () => true).types], ["agent"]);
});

test("OpenAPI: the agents examples have the live shapes", async () => {
  const doc = openApiDoc();
  const ex = doc.paths["/v1/agents"].get.responses["200"].content["application/json"].example;
  const live = (await get("/v1/agents")).body;
  assert.deepEqual(Object.keys(ex).sort(), Object.keys(live).sort());
  assert.deepEqual(Object.keys(ex.agents[0]).sort(), AGENT_KEYS);
  assert.deepEqual(Object.keys(ex.agents[0].latest).sort(), PROPOSAL_KEYS);
  assert.deepEqual(Object.keys(ex.agents[0].latest.sim).sort(), Object.keys(live.agents[0].latest.sim).sort());
  assert.deepEqual(Object.keys(ex.agents[0].stats).sort(), Object.keys(live.agents[0].stats).sort());
  assert.deepEqual(Object.keys(ex.agents[0].wallet).sort(), WALLET_KEYS);
  assert.deepEqual(Object.keys(ex.agents[0].totals).sort(), TOTALS_KEYS);
  assert.deepEqual(Object.keys(ex.agents[0].launched[0]).sort(), LAUNCHED_KEYS);
  assert.deepEqual(Object.keys(ex.agents[0].activity[0]).sort(), ACTIVITY_KEYS);
  const one = doc.paths["/v1/agents/{root}"].get.responses["200"].content["application/json"].example;
  assert.deepEqual(Object.keys(one).sort(), ["activity", "agent", "launched", "proposals"]);
  const coin = doc.paths["/v1/agents/coin/{mint}"].get.responses["200"].content["application/json"].example;
  assert.deepEqual(Object.keys(coin).sort(), ["agent", "launch", "role", "root"]);
  assert.equal(coin.role, "child");
  assert.deepEqual(Object.keys(coin.agent).sort(), SUMMARY_KEYS);
  assert.deepEqual(Object.keys(coin.launch).sort(), ["at", "logoSource", "proposalId", "signature", "why"]);
  assert.match(ex.agents[0].latest.image, /^https:\/\/sporepad\.com\/api\/agents\/img\/[0-9a-f]{16}\.png$/);
  assert.match(ex.agents[0].launched[0].image, /^https:\/\/sporepad\.com\/api\//);
  for (const x of ex.agents[0].activity) if (x.signature) assert.equal(x.explorer, `https://solscan.io/tx/${x.signature}`);
  for (const name of ["AgentWallet", "AgentTotals", "LaunchedCoin", "ActivityItem", "AgentSummary", "AgentLaunch", "AgentCoin"]) assert.ok(doc.components.schemas[name], name);
});

test("health reports the agents runner, the vault and the ledger; /api/events carries `agent` events", async () => {
  const h = (await get("/api/health")).body;
  assert.deepEqual(h.agents, { mode: "dry", runs: 3, live: null, vault: true, ledger: { bytes: h.agents.ledger.bytes, lines: 10, bad: 1, roots: 1 } });
  assert.ok(h.agents.ledger.bytes > 1000);
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read(); // ": connected"
  hub.emit("agent", { root: K.ROOT, proposal: { id: "x" } });
  const { value } = await reader.read();
  assert.match(Buffer.from(value).toString(), /^event: agent\ndata: \{"root":"[1-9A-HJ-NP-Za-km-z]+","proposal":\{"id":"x"\}\}\n\n/);
  ctrl.abort();
});
