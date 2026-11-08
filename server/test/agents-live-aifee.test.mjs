// The agent pays for its own thinking (lib/agents-live/aifee.mjs). Ledger on disk, chain mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiDebtOf, lamportsForUsd, payAiFee, AiFeeError } from "../lib/agents-live/aifee.mjs";
import { snapshot } from "../lib/agents-live/budget.mjs";
import { AgentVault, initVaultKey, readVaultKey } from "../lib/agents-live/vault.mjs";

const ROOT = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY", OTHER = "FTcrJuck7yqAgQQzv9uud7MH2Av8S3mP9iveiXsutNeX";
const OWNER = "ZvtbhdER7JYi9atZ5sGH7UTG4dsGa4yRHw59DJcaKko";

test("aiDebtOf: booked model calls minus landed fee payments, per root, tolerant of junk lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-aifee-"));
  const f = join(dir, "ledger.jsonl");
  writeFileSync(f, [
    JSON.stringify({ kind: "ai", rail: "keyed", root: ROOT, status: "done", estUsd: 0.013 }),
    JSON.stringify({ kind: "ai", rail: "keyed", root: ROOT, status: "done", estUsd: 0.008, image: true }),
    JSON.stringify({ kind: "ai", rail: "keyed", root: ROOT, status: "failed" }),
    JSON.stringify({ kind: "ai", rail: "keyed", root: OTHER, status: "done", estUsd: 1 }),
    JSON.stringify({ kind: "aifee", root: ROOT, status: "pending", usd: 0.01 }),
    JSON.stringify({ kind: "aifee", root: ROOT, status: "landed", usd: 0.01 }),
    "{not json",
  ].join("\n") + "\n");
  assert.deepEqual(aiDebtOf(f, ROOT), { bookedUsd: 0.021, paidUsd: 0.01, owedUsd: 0.011 });
  assert.deepEqual(aiDebtOf(join(dir, "missing.jsonl"), ROOT), { bookedUsd: 0, paidUsd: 0, owedUsd: 0 });
  assert.equal(lamportsForUsd(1, 100), 10_000_000); assert.equal(lamportsForUsd(1, 0), null);
});

function signerIn(dir) { const k = join(dir, "v.key"); initVaultKey(k); const v = new AgentVault({ dir: join(dir, "w"), vaultKey: readVaultKey(k) }); v.create(ROOT); return v.signer(ROOT); }
const rpcMock = (postLamports = 50_000_000) => ({ async call(m) {
  if (m === "getLatestBlockhash") return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 } };
  if (m === "simulateTransaction") return { value: { err: null, unitsConsumed: 1000, accounts: [{ lamports: postLamports }] } };
  if (m === "sendTransaction") return "8".repeat(88);
  if (m === "getSignatureStatuses") return { value: [{ slot: 5, confirmationStatus: "confirmed", err: null }] };
  throw new Error(m);
} });

test("payAiFee: pays the owed USD in SOL at the price, ledgers pending → landed, partial when the wallet is short", async () => {
  const signer = signerIn(mkdtempSync(join(tmpdir(), "spore-aifee-")));
  const ledger = { entries: [], record(e) { this.entries.push(e); } };
  const full = await payAiFee({ rpc: rpcMock(), signer, budget: snapshot({ lamports: 60_000_000, usdcMicros: 0 }), to: OWNER, owedUsd: 0.5, solUsd: 100, ledger, root: ROOT, log: { info() {} } });
  assert.equal(full.lamports, 5_000_000); assert.equal(full.usd, 0.5); assert.equal(full.signature, "8".repeat(88));
  assert.deepEqual(ledger.entries.map((e) => [e.kind, e.status]), [["aifee", "pending"], ["aifee", "landed"]]);
  assert.equal(ledger.entries[0].to, OWNER);
  // 0.0061 SOL in the wallet: reserve 0.005 + fee leaves 0.00109 SOL ≈ $0.109 of a $0.5 debt.
  const part = await payAiFee({ rpc: rpcMock(), signer, budget: snapshot({ lamports: 6_100_000, usdcMicros: 0 }), to: OWNER, owedUsd: 0.5, solUsd: 100, root: ROOT, log: { info() {} } });
  assert.equal(part.lamports, 6_100_000 - 5_000_000 - 10_000); assert.ok(part.usd < 0.5 && part.usd > 0.1);
  assert.equal(await payAiFee({ rpc: rpcMock(), signer, budget: snapshot({ lamports: 60_000_000, usdcMicros: 0 }), to: OWNER, owedUsd: 0.01, solUsd: 100, root: ROOT }), null, "under the minimum");
  assert.equal(await payAiFee({ rpc: rpcMock(), signer, budget: snapshot({ lamports: 5_050_000, usdcMicros: 0 }), to: OWNER, owedUsd: 1, solUsd: 100, root: ROOT }), null, "nothing spare above the reserve");
  assert.equal(await payAiFee({ rpc: rpcMock(), signer, budget: snapshot({ lamports: 60_000_000, usdcMicros: 0 }), to: OWNER, owedUsd: 1, solUsd: 0, root: ROOT }), null, "no price, no payment");
  await assert.rejects(payAiFee({ rpc: rpcMock(), signer, budget: snapshot({ lamports: 60_000_000, usdcMicros: 0 }), to: signer.address, owedUsd: 1, solUsd: 100 }), (e) => e instanceof AiFeeError && e.code === "config");
});
