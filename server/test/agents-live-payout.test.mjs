// Automatic payout of an agent's surplus to the owner (lib/agents-live/payout.mjs). Chain mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { surplusOf, payoutSurplus, PayoutError } from "../lib/agents-live/payout.mjs";
import { snapshot } from "../lib/agents-live/budget.mjs";
import { AgentVault, initVaultKey, readVaultKey } from "../lib/agents-live/vault.mjs";

const ROOT = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
const OWNER = "ZvtbhdER7JYi9atZ5sGH7UTG4dsGa4yRHw59DJcaKko";

test("surplusOf: keeps the working balance and the reserve, sweeps idle USDC, ignores dust", () => {
  const b = snapshot({ lamports: 200_000_000, usdcMicros: 1_010_000, solUsd: 100 }); // 0.2 SOL, $1.01
  assert.deepEqual(surplusOf(b, { keepSol: 0.1, reserveSol: 0.005 }), { lamports: 200_000_000 - 105_000_000 - 10_000, usdcMicros: 1_010_000 });
  assert.deepEqual(surplusOf(snapshot({ lamports: 108_000_000, usdcMicros: 0 }), { keepSol: 0.1, reserveSol: 0.005 }), { lamports: 0, usdcMicros: 0 }, "under the minimum payout");
  assert.deepEqual(surplusOf(snapshot({ lamports: 13_000_000, usdcMicros: 1_010_000 }), { keepSol: 0.1, reserveSol: 0.005, sweepUsdc: false }), { lamports: 0, usdcMicros: 0 }, "x402 rail keeps its USDC");
  assert.deepEqual(surplusOf(snapshot({ lamports: 13_000_000, usdcMicros: 200_000 }), { keepSol: 0.1 }), { lamports: 0, usdcMicros: 0 }, "USDC dust stays");
});

function rpcMock({ ataExists = true, postLamports = 110_000_000 } = {}) {
  const calls = [];
  return { calls, async call(m, p) {
    calls.push(m);
    if (m === "getAccountInfo") return { value: ataExists ? { lamports: 2_039_280, data: ["", "base64"], owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } : null };
    if (m === "getLatestBlockhash") return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 } };
    if (m === "simulateTransaction") { const tx = VersionedTransaction.deserialize(Buffer.from(p[0], "base64")); return { value: { err: null, unitsConsumed: 20_000, accounts: [{ lamports: postLamports }], logs: [], ixs: tx.message.compiledInstructions.length } }; }
    if (m === "sendTransaction") return "7".repeat(88);
    if (m === "getSignatureStatuses") return { value: [{ slot: 5, confirmationStatus: "confirmed", err: null }] };
    throw new Error(m);
  } };
}

function signerIn(dir) { const k = join(dir, "v.key"); initVaultKey(k); const v = new AgentVault({ dir: join(dir, "w"), vaultKey: readVaultKey(k) }); v.create(ROOT); return v.signer(ROOT); }

test("payoutSurplus: moves SOL above the working balance and all idle USDC to the owner, ledger pending → landed", async () => {
  const signer = signerIn(mkdtempSync(join(tmpdir(), "spore-payout-")));
  const rpc = rpcMock();
  const ledger = { entries: [], record(e) { this.entries.push(e); } };
  const budget = snapshot({ lamports: 200_000_000, usdcMicros: 1_010_000, solUsd: 100 });
  const r = await payoutSurplus({ rpc, signer, budget, to: OWNER, cfg: { keepSol: 0.1, reserveSol: 0.005, sweepUsdc: true }, ledger, root: ROOT, log: { info() {} } });
  assert.equal(r.signature, "7".repeat(88)); assert.equal(r.lamports, 200_000_000 - 105_000_000 - 10_000); assert.equal(r.usdcMicros, 1_010_000);
  assert.deepEqual(ledger.entries.map((e) => [e.kind, e.status]), [["payout", "pending"], ["payout", "landed"]]);
  assert.equal(ledger.entries[0].to, OWNER); assert.match(ledger.entries[0].signature, /^[1-9A-HJ-NP-Za-km-z]+$/, "bs58 signature");
  assert.ok(rpc.calls.indexOf("simulateTransaction") < rpc.calls.indexOf("sendTransaction"));
});

test("payoutSurplus: pays the owner's USDC account rent out of the SOL leg, skips USDC when SOL cannot carry it, returns null when nothing is due", async () => {
  const signer = signerIn(mkdtempSync(join(tmpdir(), "spore-payout-")));
  const big = await payoutSurplus({ rpc: rpcMock({ ataExists: false }), signer, budget: snapshot({ lamports: 200_000_000, usdcMicros: 1_010_000 }), to: OWNER, cfg: { keepSol: 0.1 }, log: { info() {} } });
  assert.equal(big.lamports, 200_000_000 - 105_000_000 - 10_000 - 2_039_280); assert.equal(big.usdcMicros, 1_010_000);
  const small = await payoutSurplus({ rpc: rpcMock({ ataExists: false }), signer, budget: snapshot({ lamports: 106_500_000, usdcMicros: 1_010_000 }), to: OWNER, cfg: { keepSol: 0.1, minPayoutSol: 0.001 }, log: { info() {} } });
  assert.equal(small.usdcMicros, 0, "no rent room: USDC waits"); assert.equal(small.lamports, 106_500_000 - 105_000_000 - 10_000);
  assert.equal(await payoutSurplus({ rpc: rpcMock(), signer, budget: snapshot({ lamports: 50_000_000, usdcMicros: 0 }), to: OWNER, cfg: { keepSol: 0.1 } }), null);
  await assert.rejects(payoutSurplus({ rpc: rpcMock(), signer, budget: snapshot({ lamports: 200_000_000, usdcMicros: 0 }), to: signer.address, cfg: {} }), (e) => e instanceof PayoutError && e.code === "config");
  await assert.rejects(payoutSurplus({ rpc: rpcMock(), signer, budget: snapshot({ lamports: 200_000_000, usdcMicros: 0 }), to: "nope", cfg: {} }), PayoutError);
  await assert.rejects(payoutSurplus({ rpc: rpcMock({ postLamports: 1 }), signer, budget: snapshot({ lamports: 200_000_000, usdcMicros: 0 }), to: OWNER, cfg: { keepSol: 0.1 } }), /under its reserve/);
  assert.ok(Keypair.generate().publicKey.toBase58() !== signer.address);
});
