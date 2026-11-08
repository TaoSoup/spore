// Root agents: an agent never proposes the same coin twice. Its own recent proposals (the last 50)
// count as taken tickers in the designer, next to the root's children and the biggest coins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkIdea, design, designContext } from "../lib/agents/designer.mjs";
import { fallbackProfile, profileInput } from "../lib/agents/profile.mjs";
import { AgentRegistry } from "../lib/agents/registry.mjs";
import { AgentRunner } from "../lib/agents/runner.mjs";
import { agentTree, K, PLATFORM, quiet } from "./helpers/agents.mjs";

test("designer: a ticker the agent already proposed is refused with its own reason", async () => {
  const idea = { name: "Street Crew", symbol: "SCREW", description: "A loud offshoot of the tree." };
  assert.equal(checkIdea(idea, { rootSymbol: "GTA" }), null);
  assert.equal(checkIdea(idea, { rootSymbol: "GTA", proposedSymbols: new Set(["SCREW"]) }), "this agent already proposed $SCREW");
  const { model } = agentTree();
  const profile = fallbackProfile(profileInput(model, K.ROOT));
  const ctx = designContext(model, K.ROOT);
  const root = { mint: K.ROOT, name: "Mushroom Grove", symbol: "GROVE" };
  const first = await design(profile, root, ctx, { seed: "same" });
  assert.ok(first.best);
  const again = await design(profile, root, { ...ctx, proposedSymbols: new Set([first.best.symbol]) }, { seed: "same" });
  assert.ok(again.best, "another idea wins");
  assert.notEqual(again.best.symbol, first.best.symbol);
  assert.ok(again.filtered.some((f) => f.symbol === first.best.symbol && /already proposed/.test(f.why)));
});

test("runner: repeated runs of one agent never repeat a proposal's ticker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-agents-dedupe-"));
  const { db, model } = agentTree();
  const registry = new AgentRegistry(db);
  let n = 0;
  const runner = new AgentRunner({ registry, model, rpc: { call: async () => { throw new Error("no rpc in this test"); } }, log: quiet,
    simulate: async () => ({ ok: true, bytes: 900, unitsConsumed: 150_000, err: null, estCostSol: 0.0148, txs: 2 }), newId: () => (++n).toString(16).padStart(16, "0"),
    cfg: { mode: "dry", tickSec: 300, minScore: 0, cooldownMin: 60, maxPerHour: 100, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], launchFeeSol: 0, pagesDomain: "spore-2x6.pages.dev", dataDir: dir } });
  try {
    registry.enable(K.ROOT);
    for (let i = 0; i < 6; i++) assert.ok((await runner.runAgent(K.ROOT, { force: true })).proposal, `run ${i} proposes`);
    const symbols = registry.proposals(K.ROOT).map((p) => p.symbol);
    assert.equal(symbols.length, 6);
    assert.equal(new Set(symbols).size, 6, `distinct tickers: ${symbols.join(", ")}`);
  } finally { runner.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
