// The live orchestrator (lib/agents-live/live.mjs) over stubs: wallet from a scratch vault, the dry
// runner, registry, model, RPC and every fund-moving dependency mocked. Checks the pass order
// (budget → top-up → claim → think → launch), the sleep gate, per-agent paid model routing, the
// model-drawn logo seam and that nothing fund-moving is called while asleep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveAgents, routedLlm } from "../lib/agents-live/live.mjs";
import { AgentVault, initVaultKey, readVaultKey } from "../lib/agents-live/vault.mjs";
import { snapshot } from "../lib/agents-live/budget.mjs";

const ROOT = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 0, 0, 0, 2, 0]);

function harness({ lamports = 60_000_000, usdcMicros = 1_000_000, solUsd = 100, simOk = true, aiRail = "solana-x402", keyedLlm = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spore-live-"));
  const keyFile = join(dir, "vault.key"); initVaultKey(keyFile);
  const vault = new AgentVault({ dir: join(dir, "wallets"), vaultKey: readVaultKey(keyFile) });
  const calls = [];
  const ledger = { entries: [], record(e) { this.entries.push(e); } };
  const imgDir = join(dir, "agents"); mkdirSync(imgDir, { recursive: true });
  const router = routedLlm();
  const runner = {
    imgDir, render: null,
    async runAgent(root) {
      calls.push(["runAgent", root, router.available]);
      const png = await this.render({ symbol: "MYC", palette: ["#111"], seed: "p1" });
      writeFileSync(join(imgDir, "p1.png"), png);
      return { proposal: { id: "p1", name: "Mycelium", symbol: "MYC", description: "d", sim: { ok: simOk, estCostSol: 0.02 } }, score: 70 };
    },
  };
  const registry = { rows: [{ root_mint: ROOT, status: "dry" }], list() { return this.rows; }, profileOf() { return { themes: ["fungi"], palette: ["#111"] }; }, recordRun(...a) { calls.push(["recordRun", a[1].reason]); }, markLaunched(...a) { calls.push(["markLaunched", ...a]); } };
  const model = { solUsd, get(m) { return { mint: m, symbol: "SPORE", creator: "Creator111111111111111111111111111111111111" }; } };
  const events = [], hub = { emit(n, p) { events.push([n, p]); } };
  let budgetLamports = lamports;
  const deps = {
    vault, ledger,
    readBudget: async (rpc, address) => { calls.push(["readBudget", address]); return snapshot({ lamports: budgetLamports, usdcMicros, solUsd }); },
    createPaidLlm: ({ root, signer }) => { calls.push(["paidLlm", root, signer.address]); return { available: true, model: "anthropic/claude-sonnet-5.5", chatText: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#123"/></svg>', chatJson: async () => ({}), snapshot: () => ({ paidUsd: 0.013 }) }; },
    drawLogo: async (idea, profile, { llm }) => { calls.push(["drawLogo", idea.symbol, llm.available]); return { png: PNG, svg: "<svg/>", source: "model", error: null }; },
    launchLive: async ({ root, form, budget, signer }) => { calls.push(["launchLive", root.mint, form.symbol, budget.sol, signer.address]); return { mint: "Mint1111111111111111111111111111111111111111", signatures: ["sig1"], estCostSol: 0.02, metadataUri: "u" }; },
    claimCoin: async ({ mint }) => { calls.push(["claimCoin", mint]); return { signature: "csig", mine: 3_000_000n, total: 6_000_000n, sol: true }; },
    topUpUsdc: async ({ usd }) => { calls.push(["topUpUsdc", usd]); return { signature: "tsig", lamportsIn: 1, minOutMicros: 1 }; },
  };
  const live = new LiveAgents({ runner, router, registry, model, rpc: {}, metaHost: {}, hub, keyedLlm, cfg: { dataDir: dir, vaultKeyFile: keyFile, aiRail, claimEveryTicks: 6, launchEveryTicks: 1, platformWallet: "Fcb111111111111111111111111111111111111111", splitBps: [5000, 0, 0, 5000] }, log: { info() {}, warn() {} }, deps });
  live.ticks = 1; // as after the first tick(); claim passes happen on multiples of claimEveryTicks
  return { live, calls, ledger, vault, events, registry, setLamports: (v) => { budgetLamports = v; } };
}

test("live: an unfunded agent gets a wallet, sleeps, and nothing fund-moving runs", async () => {
  const h = harness({ lamports: 0, usdcMicros: 0 });
  const r = await h.live.runOne(ROOT);
  assert.match(r.asleep, /needs \$5\.00/);
  assert.ok(h.vault.has(ROOT), "wallet created so the owner can fund it");
  assert.deepEqual(h.calls.map((c) => c[0]), ["readBudget", "recordRun"]);
  assert.equal(h.live.snapshot().agents[0].sleeping, true);
});

test("live: a funded agent thinks with its own paid model, draws its logo and launches", async () => {
  const h = harness();
  const r = await h.live.runOne(ROOT);
  const names = h.calls.map((c) => c[0]);
  assert.deepEqual(names, ["readBudget", "paidLlm", "runAgent", "drawLogo", "readBudget", "launchLive"]);
  assert.equal(h.calls[1][1], ROOT, "paid model bound to this root");
  assert.equal(h.calls[1][2], h.vault.address(ROOT), "paid from the agent's wallet");
  assert.equal(h.calls[2][2], true, "router available during the run");
  assert.equal(h.calls[3][2], true, "logo drawn through the routed model");
  assert.equal(h.live.router.available, false, "router released after the run");
  assert.equal(r.launched.mint, "Mint1111111111111111111111111111111111111111");
  assert.equal(h.live.stats.launches, 1); assert.equal(h.live.stats.spentUsd, 0.013);
  assert.equal(h.events.at(-1)[1].proposal.launched.mint, r.launched.mint);
  assert.ok(existsSync(join(h.live.runner.imgDir, "p1.png")));
});

test("live: a low USDC pocket is topped up first and nothing else happens that pass", async () => {
  const h = harness({ usdcMicros: 100_000 });
  const r = await h.live.runOne(ROOT);
  assert.equal(r.topUp.signature, "tsig");
  assert.deepEqual(h.calls.map((c) => c[0]), ["readBudget", "topUpUsdc"]);
  assert.equal(h.calls[1][1], 0.9);
});

test("live: claims come before thinking on the claim tick, one per pass", async () => {
  const h = harness();
  await h.live.runOne(ROOT); // launches
  h.live.ticks = 6; h.calls.length = 0;
  const r = await h.live.runOne(ROOT);
  assert.equal(h.live.stats.claims, 1);
  assert.deepEqual(h.calls.slice(0, 3).map((c) => c[0]), ["readBudget", "claimCoin", "readBudget"], "claim first, then the budget is re-read and the pass goes on");
  assert.ok(h.calls.some((c) => c[0] === "launchLive"), "a claim does not starve the launch");
  assert.ok(r.launched, "the pass ends with the launch");
});

test("live: a proposal whose simulation failed is not launched", async () => {
  const h = harness({ simOk: false });
  const r = await h.live.runOne(ROOT);
  assert.equal(r.skipped, "simulation failed");
  assert.ok(!h.calls.some((c) => c[0] === "launchLive"));
});

test("live: tick visits every agent and survives one failing", async () => {
  const h = harness();
  h.registry.rows.push({ root_mint: "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump", status: "paused" }, { root_mint: "NTRNDMqQSiwEC2jJs3wJiZS6bpGYQJtMNQJgiX3WyV6", status: "live" });
  const origin = h.live.deps.readBudget;
  h.live.deps.readBudget = async (rpc, address) => { if (h.live.state.size === 2 && !h.live.state.get("NTRNDMqQSiwEC2jJs3wJiZS6bpGYQJtMNQJgiX3WyV6")?.budget) throw new Error("rpc down"); return origin(rpc, address); };
  await h.live.tick();
  assert.equal(h.live.stats.ticks, 1);
  assert.equal(h.live.stats.failures, 1);
  assert.match(h.live.stats.lastError, /rpc down/);
  assert.equal(h.live.stats.launches, 1, "the first agent still launched");
  assert.ok(!h.vault.has("BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump"), "paused agents are skipped: no wallet, no budget read");
});

test("live: on the keyed rail a funded agent needs no USDC, thinks through the owner's key booked to its root, and launches", async () => {
  const keyedLlm = { available: true, model: "claude-sonnet-5-5", chatText: async () => "<svg/>", chatJson: async () => ({}), lastUsage: () => ({ prompt_tokens: 10, completion_tokens: 5 }) };
  const h = harness({ usdcMicros: 0, aiRail: "keyed", keyedLlm });
  const r = await h.live.runOne(ROOT);
  assert.deepEqual(h.calls.map((c) => c[0]), ["readBudget", "runAgent", "drawLogo", "readBudget", "launchLive"], "no top-up, no per-agent paid provider");
  assert.equal(h.calls[1][2], true, "router available during the run");
  assert.equal(r.launched.mint, "Mint1111111111111111111111111111111111111111");
  assert.equal(h.live.modelFor(ROOT), "anthropic/claude-sonnet-5.5");
});

test("live: the surplus goes to the root's creator, or to the owner's address for the owner's own roots and seeded agents", () => {
  const h = harness();
  h.live.cfg.payoutAddress = "ZvtbhdER7JYi9atZ5sGH7UTG4dsGa4yRHw59DJcaKko";
  assert.equal(h.live.payoutTargetOf(ROOT), "ZvtbhdER7JYi9atZ5sGH7UTG4dsGa4yRHw59DJcaKko", "seeded agent: no creator on file → owner");
  const third = "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs", rootB = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump", rootC = "NTRNDMqQSiwEC2jJs3wJiZS6bpGYQJtMNQJgiX3WyV6";
  h.vault.bind(h.vault.prepare({ creator: third, model: "anthropic/claude-sonnet-5.5" }).id, rootB);
  assert.equal(h.live.payoutTargetOf(rootB), third, "a third party's root pays its creator");
  h.vault.bind(h.vault.prepare({ creator: h.live.cfg.platformWallet, model: "anthropic/claude-sonnet-5.5" }).id, rootC);
  assert.equal(h.live.payoutTargetOf(rootC), "ZvtbhdER7JYi9atZ5sGH7UTG4dsGa4yRHw59DJcaKko", "the owner's own root (platform wallet) pays the owner's address");
});

test("live: the model must be Claude or GPT", () => {
  assert.throws(() => new LiveAgents({ runner: { render: null }, router: routedLlm(), registry: {}, model: {}, rpc: {}, metaHost: {}, cfg: { dataDir: mkdtempSync(join(tmpdir(), "x-")), model: "google/gemini-3.5-flash" }, deps: { vault: {}, ledger: {} } }), /not allowed/);
});
