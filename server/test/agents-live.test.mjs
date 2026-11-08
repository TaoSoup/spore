// Agent wallets, budget gates and the keyless paid model rail (lib/agents-live/*). Nothing here
// touches the network: the RPC and the provider are mocked with the shapes captured live on
// 2026-10-19.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { AgentVault, initVaultKey, readVaultKey, VaultError } from "../lib/agents-live/vault.mjs";
import { AGENT_MODELS, DEFAULT_MODEL, assertModel, modelInfo } from "../lib/agents-live/models.mjs";
import { snapshot, canStart, canLaunch, canThink, topUpNeeded, readBudget, USDC_MINT } from "../lib/agents-live/budget.mjs";
import { parseQuote, buildPayment, createPaidLlm, createPaymentLedger, PayError } from "../lib/agents-live/pay.mjs";

const ROOT = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
const ROOT2 = "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
const tmp = () => mkdtempSync(join(tmpdir(), "spore-agents-live-"));

function vaultIn(dir) {
  const keyFile = join(dir, "vault.key");
  initVaultKey(keyFile);
  return { keyFile, vault: new AgentVault({ dir: join(dir, "wallets"), vaultKey: readVaultKey(keyFile) }) };
}

test("vault: key file is created once, mode 600, and refuses loose permissions", () => {
  const dir = tmp(), keyFile = join(dir, "vault.key");
  initVaultKey(keyFile);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.throws(() => initVaultKey(keyFile), VaultError);
  assert.equal(readVaultKey(keyFile).length, 32);
  chmodSync(keyFile, 0o644);
  assert.throws(() => readVaultKey(keyFile), /mode 600/);
});

test("vault: creates a wallet once, address round-trips, file is 600 and holds no plain secret", () => {
  const { vault } = vaultIn(tmp());
  const w = vault.create(ROOT);
  assert.match(w.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(vault.address(ROOT), w.address);
  assert.ok(vault.has(ROOT));
  assert.throws(() => vault.create(ROOT), /already has a wallet/);
  const file = join(vault.dir, `${ROOT}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), ["address", "createdAt", "ct", "iv", "root", "tag", "v"]);
  assert.equal(rec.address, w.address);
  assert.deepEqual(vault.list().map((x) => x.root), [ROOT]);
});

test("vault: the signer signs a transaction and never exposes the secret", () => {
  const { vault } = vaultIn(tmp());
  vault.create(ROOT);
  const s = vault.signer(ROOT);
  assert.equal(JSON.stringify(s), JSON.stringify({ address: s.address }));
  assert.equal(String(s), s.address);
  assert.ok(!("secretKey" in s));
  const msg = new TransactionMessage({ payerKey: s.publicKey, recentBlockhash: "11111111111111111111111111111111", instructions: [SystemProgram.transfer({ fromPubkey: s.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  s.signTransaction(tx);
  assert.ok(tx.signatures[0].some((b) => b !== 0));
});

test("vault: a file moved under another root or read with another key does not decrypt", () => {
  const dir = tmp();
  const { vault } = vaultIn(dir);
  vault.create(ROOT);
  copyFileSync(join(vault.dir, `${ROOT}.json`), join(vault.dir, `${ROOT2}.json`));
  assert.throws(() => vault.address(ROOT2), /malformed|does not decrypt/);
  const otherKey = join(dir, "other.key");
  initVaultKey(otherKey);
  const other = new AgentVault({ dir: vault.dir, vaultKey: readVaultKey(otherKey) });
  assert.throws(() => other.address(ROOT), /does not decrypt/);
  const rec = JSON.parse(readFileSync(join(vault.dir, `${ROOT}.json`), "utf8"));
  writeFileSync(join(vault.dir, `${ROOT}.json`), JSON.stringify({ ...rec, address: Keypair.generate().publicKey.toBase58() }));
  assert.throws(() => vault.address(ROOT), /does not match/);
});

test("vault: a wallet prepared before launch binds to the root once, keeps its address, and stale ones are swept", () => {
  const { vault } = vaultIn(tmp());
  const p = vault.prepare({ creator: ROOT2, model: "anthropic/claude-sonnet-5.5" });
  assert.match(p.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(vault.list(), [], "pending wallets are not agents yet");
  assert.equal(vault.pending(p.id).address, p.address);
  const b = vault.bind(p.id, ROOT);
  assert.deepEqual(b, { root: ROOT, address: p.address, model: "anthropic/claude-sonnet-5.5", creator: ROOT2 });
  assert.equal(vault.address(ROOT), p.address);
  assert.equal(vault.signer(ROOT).address, p.address);
  assert.throws(() => vault.pending(p.id), /no pending wallet/);
  assert.throws(() => vault.bind(vault.prepare().id, ROOT), /already has a wallet/);
  const old = vault.prepare();
  assert.equal(vault.sweepPending({ maxAgeS: 3600, now: Math.floor(Date.now() / 1000) + 4000 }), 2, "both unbound wallets moved aside");
  assert.equal(vault.pending(old.id).address, old.address, "a swept wallet is never deleted: its address may already be on-chain");
  assert.ok(vault.pendingList().some((w) => w.id === old.id));
  assert.equal(vault.sweepPending({ maxAgeS: 3600, now: Math.floor(Date.now() / 1000) + 4000 }), 0, "already aside");
  const late = vault.bind(old.id, ROOT2);
  assert.equal(late.address, old.address, "binds from the unbound folder too");
  assert.ok(!vault.pendingList().some((w) => w.id === old.id));
  assert.throws(() => vault.pending("zz"), /32 hex/);
});

test("models: only the Claude and GPT catalogue is allowed", () => {
  assert.ok(AGENT_MODELS.every((m) => m.family === "claude" || m.family === "gpt"));
  assert.equal(assertModel(DEFAULT_MODEL), "anthropic/claude-sonnet-5.5");
  assert.throws(() => assertModel("google/gemini-3.5-flash"), /not allowed/);
  assert.ok(modelInfo("anthropic/claude-opus-5.5").capUsd > modelInfo("anthropic/claude-opus-5.5").maxUsd);
  assert.equal(modelInfo("anthropic/claude-opus-5.5").keyed, "claude-opus-5-5");
});

test("budget: gates value the wallet in USD and keep the reserve", () => {
  const b = snapshot({ lamports: 20_000_000, usdcMicros: 1_000_000, solUsd: 100 }); // 0.02 SOL = $2 + $1 USDC
  assert.equal(b.usd, 3);
  assert.equal(canStart(b).ok, false);
  assert.equal(canStart(snapshot({ lamports: 50_000_000, usdcMicros: 0, solUsd: 100 })).ok, true);
  assert.equal(canStart(snapshot({ lamports: 50_000_000, usdcMicros: 0, solUsd: null })).ok, false);
  assert.equal(canLaunch(b, 0.0105).ok, true);          // 0.0105 + 0.003 + 0.005 = 0.0185 ≤ 0.02
  assert.equal(canLaunch(b, 0.0125).ok, false);         // 0.0205 > 0.02
  assert.equal(canLaunch(b, 0).ok, false);
  assert.equal(canThink(b, 0.03).ok, true);
  assert.equal(canThink(snapshot({ lamports: 0, usdcMicros: 10_000 }), 0.03).ok, false);
  assert.deepEqual(topUpNeeded(b), { needed: false, usd: 0 });
  assert.deepEqual(topUpNeeded(snapshot({ lamports: 0, usdcMicros: 100_000 })), { needed: true, usd: 0.9 });
});

test("budget: readBudget treats a missing USDC account as zero and surfaces other RPC errors", async () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const rpc = { async call(m, p) { if (m === "getBalance") return { value: 123_000_000 }; if (m === "getTokenAccountBalance") throw new Error("Invalid param: could not find account"); throw new Error(m); } };
  const b = await readBudget(rpc, owner, { solUsd: 10 });
  assert.equal(b.sol, 0.123); assert.equal(b.usdc, 0); assert.equal(b.usd, 1.23); assert.equal(b.address, owner);
  const bad = { async call(m) { if (m === "getBalance") return { value: 1 }; throw new Error("429 rate limited"); } };
  await assert.rejects(readBudget(bad, owner), /429/);
});

// The 402 body NanoGPT answered on 2026-10-19 (identifiers shortened, amounts real).
const PAY_TO = "P16imsNyUZfMGDJTDV623AVgAPz4Zp2oBgZ9F8EbHe4", FEE_PAYER = "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88";
const quote402 = (amount = "13218", extra = {}) => ({
  error: { message: "Insufficient balance. Multiple payment options available." },
  x402Version: 1,
  accepts: [
    { scheme: "exact", network: "base", maxAmountRequired: amount, payTo: "0x1", extra: { tokenAddress: "0x8335" } },
    { scheme: "exact", network: "solana", asset: USDC_MINT, amount, maxAmountRequired: amount, maxAmountRequiredUSD: Number(amount) / 1e6, payTo: PAY_TO, paymentId: "pay_test", expiresAt: Math.floor(Date.now() / 1000) + 600, extra: { feePayer: FEE_PAYER, tokenAddress: USDC_MINT, tokenSymbol: "USDC", tokenDecimals: 6 }, ...extra },
  ],
  payment: { accepted: [{ scheme: "x402-solana-usdc", network: "solana", amountUsd: String(Number(amount) / 1e6) }] },
});

test("pay: parseQuote accepts the live shape and refuses wrong asset, missing fee payer, over cap", () => {
  const q = parseQuote(quote402(), { capUsd: 0.03 });
  assert.deepEqual({ payTo: q.payTo, feePayer: q.feePayer, amountMicros: q.amountMicros, paymentId: q.paymentId }, { payTo: PAY_TO, feePayer: FEE_PAYER, amountMicros: 13218, paymentId: "pay_test" });
  assert.throws(() => parseQuote(quote402("13218", { asset: "So11111111111111111111111111111111111111112" }), { capUsd: 0.03 }), /not for USDC/);
  assert.throws(() => parseQuote(quote402("13218", { extra: { tokenAddress: USDC_MINT } }), { capUsd: 0.03 }), /fee payer/);
  assert.throws(() => parseQuote(quote402("40000"), { capUsd: 0.03 }), /over the model cap/);
  assert.throws(() => parseQuote({ accepts: [] }, { capUsd: 0.03 }), /no Solana/);
});

test("pay: the payment transaction is fee-paid by the facilitator and moves exactly the quote", () => {
  const { vault } = vaultIn(tmp());
  vault.create(ROOT);
  const signer = vault.signer(ROOT);
  const q = parseQuote(quote402(), { capUsd: 0.03 });
  const p = buildPayment({ signer, quote: q, blockhash: "11111111111111111111111111111111" });
  const tx = VersionedTransaction.deserialize(Buffer.from(p.wire, "base64"));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  assert.equal(keys[0], FEE_PAYER, "facilitator is the fee payer");
  assert.ok(keys.includes(signer.address));
  assert.equal(tx.message.compiledInstructions.length, 4);
  assert.ok(tx.signatures[keys.indexOf(signer.address)].some((b) => b !== 0), "agent signed");
  assert.ok(tx.signatures[0].every((b) => b === 0), "facilitator slot left for the facilitator");
  const transfer = tx.message.compiledInstructions[2];
  assert.equal(Number(Buffer.from(transfer.data).readBigUInt64LE(1)), 13218);
});

test("pay: createPaidLlm quotes, records, replays and parses; refuses before a quote when the pocket is low", async () => {
  const dir = tmp();
  const { vault } = vaultIn(dir);
  vault.create(ROOT);
  const signer = vault.signer(ROOT);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const h = init.headers; calls.push(h);
    if (h["x-x402"]) return { status: 402, text: async () => JSON.stringify(quote402()), headers: { get: () => null } };
    const payload = JSON.parse(Buffer.from(h["X-PAYMENT"], "base64").toString("utf8"));
    assert.equal(payload.scheme, "exact"); assert.equal(payload.network, "solana"); assert.ok(payload.payload.transaction.length > 100);
    return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "```json\n{\"name\":\"Mycelium\",\"symbol\":\"MYC\"}\n```" } }] }), headers: { get: (k) => (k === "x-payment-response" ? Buffer.from(JSON.stringify({ success: true })).toString("base64") : null) } };
  };
  const rpc = { async call(m) { if (m === "getLatestBlockhash") return { value: { blockhash: "11111111111111111111111111111111" } }; throw new Error(m); } };
  const ledger = createPaymentLedger(join(dir, "payments.jsonl"));
  let pocketUsd = 1;
  const llm = createPaidLlm({ signer, rpc, model: DEFAULT_MODEL, ledger, root: ROOT, pocket: async () => pocketUsd, fetchImpl, log: { warn() {} } });
  assert.equal(llm.available, true);
  const out = await llm.chatJson([{ role: "user", content: "x" }]);
  assert.deepEqual(out, { name: "Mycelium", symbol: "MYC" });
  const lines = readFileSync(join(dir, "payments.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.status), ["pending", "settled"]);
  assert.equal(lines[0].amountMicros, 13218); assert.equal(lines[0].address, signer.address); assert.ok(lines[0].signature);
  assert.ok(!JSON.stringify(lines).includes('"ct"'), "ledger holds no wallet material");
  assert.equal(llm.snapshot().paidUsd, 0.013218);
  pocketUsd = 0.01;
  await assert.rejects(llm.chatJson([{ role: "user", content: "x" }]), (e) => e instanceof PayError && e.code === "pocket_low");
  assert.equal(calls.length, 2, "no request was made with a low pocket");
});

test("pay: a 402 without a settlement header is a refusal, recorded and not counted as spent", async () => {
  const dir = tmp();
  const { vault } = vaultIn(dir);
  vault.create(ROOT);
  const fetchImpl = async (url, init) => init.headers["x-x402"]
    ? { status: 402, text: async () => JSON.stringify(quote402()), headers: { get: () => null } }
    : { status: 402, text: async () => JSON.stringify({ error: { message: "simulation failed: transaction would fail on-chain" } }), headers: { get: () => null } };
  const rpc = { async call() { return { value: { blockhash: "11111111111111111111111111111111" } }; } };
  const ledger = createPaymentLedger(join(dir, "payments.jsonl"));
  const llm = createPaidLlm({ signer: vault.signer(ROOT), rpc, model: "anthropic/claude-opus-5.5", ledger, root: ROOT, fetchImpl, log: { warn() {} } });
  await assert.rejects(llm.chatJson([{ role: "user", content: "x" }]), (e) => e.code === "payment_refused" && e.settled === false);
  const lines = readFileSync(join(dir, "payments.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.status), ["pending", "refused"]);
  assert.equal(llm.snapshot().paidUsd, 0);
});

test("pay: a model outside the catalogue is never available", () => {
  const llm = createPaidLlm({ signer: {}, rpc: {}, model: "google/gemini-3.5-flash" });
  assert.equal(llm.available, false);
  assert.equal(llm.model, null);
});
