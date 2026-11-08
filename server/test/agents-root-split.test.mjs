// The root coin's three-way creator fee split (DESIGN §13.1, pricing.mjs rootShares) and the live
// agent configuration (config.mjs AGENTS=live).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootShares, ROOT_SPLIT_BPS } from "../lib/pricing.mjs";
import { loadConfig } from "../lib/config.mjs";

const CREATOR = "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs";
const PLATFORM = "FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5";
const AGENT = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";

test("rootShares: 0.25 / 0.50 / 0.20 of a 0.95 % creator fee = 2632 / 5263 / 2105 bps", () => {
  assert.deepEqual(ROOT_SPLIT_BPS, { creator: 2632, platform: 5263, agent: 2105 });
  assert.equal(ROOT_SPLIT_BPS.creator + ROOT_SPLIT_BPS.platform + ROOT_SPLIT_BPS.agent, 10_000);
  assert.ok(Math.abs(ROOT_SPLIT_BPS.creator / 10_000 * 0.95 - 0.25) < 0.0005);
  assert.ok(Math.abs(ROOT_SPLIT_BPS.platform / 10_000 * 0.95 - 0.50) < 0.0005);
  assert.ok(Math.abs(ROOT_SPLIT_BPS.agent / 10_000 * 0.95 - 0.20) < 0.0005);
});

test("rootShares: the preview names creator and platform only; a prepared agent completes the split", () => {
  assert.deepEqual(rootShares({ creator: CREATOR, platform: PLATFORM }), [{ address: CREATOR, bps: 2632 }, { address: PLATFORM, bps: 5263 }]);
  const full = rootShares({ creator: CREATOR, platform: PLATFORM, agent: AGENT });
  assert.deepEqual(full, [{ address: CREATOR, bps: 2632 }, { address: PLATFORM, bps: 5263 }, { address: AGENT, bps: 2105 }]);
  assert.equal(full.reduce((a, s) => a + s.bps, 0), 10_000);
  assert.deepEqual(rootShares({ creator: PLATFORM, platform: PLATFORM }), [{ address: PLATFORM, bps: 7895 }], "the platform launching its own root merges");
  assert.throws(() => rootShares({ creator: CREATOR, platform: PLATFORM, agent: PLATFORM }), /three different wallets/);
  assert.throws(() => rootShares({ creator: CREATOR, platform: PLATFORM, agent: CREATOR }), /three different wallets/);
});

test("config: AGENTS=live needs the vault key, relaxes the gates to every tick and keeps the budget knobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-cfg-live-"));
  try {
    const base = { DATA_DIR: join(dir, "data"), META_DIR: join(dir, "meta") };
    const key = join(dir, "vault.key");
    writeFileSync(key, "00".repeat(32) + "\n"); chmodSync(key, 0o600);
    const c = loadConfig({ ...base, AGENTS: "live", AGENT_VAULT_KEY_FILE: key, AGENT_MODEL: "anthropic/claude-opus-5.5", AGENT_START_USD: "7" }, { here: dir });
    assert.deepEqual([c.agents.mode, c.agents.minScore, c.agents.cooldownMin, c.agents.maxPerHour, c.agents.vaultKeyFile, c.agents.model, c.agents.startUsd, c.agents.aiRail], ["live", 0, 0, 1000, key, "anthropic/claude-opus-5.5", 7, "keyed"]);
    assert.throws(() => loadConfig({ ...base, AGENT_AI_RAIL: "nano" }, { here: dir }), /AGENT_AI_RAIL/);
    const d = loadConfig({ ...base, AGENTS: "dry", AGENT_VAULT_KEY_FILE: key }, { here: dir });
    assert.deepEqual([d.agents.mode, d.agents.minScore, d.agents.cooldownMin, d.agents.vaultKeyFile], ["dry", 40, 60, key], "the vault alone does not change the dry gates");
    assert.throws(() => loadConfig({ ...base, AGENTS: "live" }, { here: dir }), /AGENTS=live needs AGENT_VAULT_KEY_FILE/);
    assert.throws(() => loadConfig({ ...base, AGENT_VAULT_KEY_FILE: join(dir, "missing.key") }, { here: dir }), /AGENT_VAULT_KEY_FILE.*not a readable file/);
    assert.throws(() => loadConfig({ ...base, AGENT_AI_FLOOR_USD: "2", AGENT_AI_TARGET_USD: "1" }, { here: dir }), /AGENT_AI_TARGET_USD/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
