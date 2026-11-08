// Keyless language-model calls paid per request from the agent's own wallet (DESIGN §13.1).
//
// NanoGPT's accountless rail (x402, version 1): POST the chat request with `x-x402: true`, get a
// 402 whose `accepts` names an "exact" Solana USDC payment (amount, payTo, a facilitator that pays
// the network fee, a paymentId that expires in minutes); build ONE v0 transaction whose fee payer is
// that facilitator and whose only value movement is a TransferChecked of exactly the quoted USDC
// from the agent's token account to NanoGPT's; the agent partially signs; the signed bytes travel
// in the X-PAYMENT header of the replayed request. NanoGPT's facilitator simulates and submits the
// transaction itself and answers 200 with the completion and an X-PAYMENT-RESPONSE settlement; a 402
// without that header means nothing settled. No account, no API key, no key on any server but ours.
//
// Checked live 2026-10-19: quotes for Claude and GPT in Solana USDC;
// an unfunded signed payment is accepted by the facilitator and fails only at on-chain simulation.
//
// Guards: the quote must be exact / solana / USDC / a base58 payTo and feePayer; the amount is
// capped per model (models.mjs) and against the pocket (budget.mjs); the request is replayed at most
// once per quote; every payment is written to the ledger BEFORE the replay (paymentId, amount, our
// transaction signature) so a crash leaves a record to reconcile against the chain. The secret key
// never leaves the signer closure; errors carry status codes and sanitised provider text only.
//
// The returned object has the same shape as lib/agents/llm.mjs (`{ available, model, chatJson,
// snapshot }`) so the runner can use either provider.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction } from "@solana/spl-token";
import { parseJsonAnswer, LlmError } from "../agents/llm.mjs";
import { modelInfo } from "./models.mjs";
import { USDC_MINT } from "./budget.mjs";

export const NANO_URL = "https://nano-gpt.com/api/v1/chat/completions";
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const CU_LIMIT = 100_000, CU_PRICE_MICRO = 1_000;
const TIMEOUT_MS = 120_000;
const MAX_ANSWER_BYTES = 256 * 1024;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class PayError extends LlmError { constructor(message, code = "pay_failed", extra = {}) { super(message); this.name = "PayError"; this.code = code; Object.assign(this, extra); } }

/** Append-only JSONL ledger of payments (public identifiers only: never a key, never the wire bytes). */
export function createPaymentLedger(file) {
  mkdirSync(dirname(file), { recursive: true });
  return { file, record(entry) { appendFileSync(file, JSON.stringify({ ts: Math.floor(Date.now() / 1000), ...entry }) + "\n"); } };
}

/** Parses NanoGPT's 402 body into the Solana USDC requirement, or throws. Exported for tests. */
export function parseQuote(json, { capUsd }) {
  const req = (json?.accepts || []).find((a) => a.scheme === "exact" && a.network === "solana");
  if (!req) throw new PayError("provider offered no Solana USDC payment option", "no_solana_option");
  const asset = String(req.asset || req.extra?.tokenAddress || "");
  if (asset !== USDC_MINT) throw new PayError("quote is not for USDC", "bad_asset");
  if (!BASE58.test(String(req.payTo)) || !BASE58.test(String(req.extra?.feePayer))) throw new PayError("quote lacks a payTo or facilitator fee payer", "bad_quote");
  const amountMicros = Number(req.maxAmountRequired ?? req.amount);
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) throw new PayError("quote carries no usable amount", "bad_quote");
  // The cap is enforced on what the transaction moves (micros), never on a provider-stated USD figure.
  const amountUsd = amountMicros / 1e6;
  if (amountMicros > Math.round(capUsd * 1e6)) throw new PayError(`quote $${amountUsd.toFixed(4)} is over the model cap $${capUsd}`, "over_cap", { amountUsd });
  const exp = Number(req.expiresAt);
  const expiresAt = exp > 1e12 ? Math.floor(exp / 1000) : exp;
  if (!(expiresAt > Date.now() / 1000 + 20)) throw new PayError("quote expires too soon", "bad_quote");
  return { payTo: req.payTo, feePayer: req.extra.feePayer, amountMicros, amountUsd, expiresAt, paymentId: String(req.paymentId || "") };
}

/** The payment transaction: facilitator pays the fee, the agent moves exactly the quoted USDC. Exported for tests. */
export function buildPayment({ signer, quote, blockhash }) {
  const usdc = new PublicKey(USDC_MINT), owner = signer.publicKey, payTo = new PublicKey(quote.payTo);
  const from = getAssociatedTokenAddressSync(usdc, owner, false), to = getAssociatedTokenAddressSync(usdc, payTo, false);
  const nonce = randomBytes(12).toString("hex");
  const msg = new TransactionMessage({
    payerKey: new PublicKey(quote.feePayer), recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO }),
      createTransferCheckedInstruction(from, usdc, to, owner, BigInt(quote.amountMicros), 6),
      new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`x402:${nonce}`, "utf8") }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  signer.signTransaction(tx);
  const sigIndex = msg.staticAccountKeys.findIndex((k) => k.equals(owner));
  const signature = Buffer.from(tx.signatures[sigIndex]).toString("base64");
  return { wire: Buffer.from(tx.serialize()).toString("base64"), signature, nonce, from: from.toBase58(), to: to.toBase58() };
}

/**
 * `createPaidLlm({ signer, rpc, model, ledger, root, pocket })`: `rpc` is lib/rpc.mjs (call(method, params));
 * `pocket()` returns the agent's current USDC balance in USD (budget.mjs snapshot) so a call is refused
 * before any quote when the pocket cannot cover the model's cap.
 */
export function createPaidLlm({ signer, rpc, model, ledger = null, root = null, pocket = null, fetchImpl = fetch, url = NANO_URL, timeoutMs = TIMEOUT_MS, log = console, now = Date.now } = {}) {
  const info = modelInfo(model);
  const available = !!(signer && rpc && info);
  const state = { calls: 0, failures: 0, paidMicros: 0, lastError: null, lastPaymentId: null };

  async function post(body, headers) {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    const text = await res.text();
    if (text.length > MAX_ANSWER_BYTES) throw new PayError(`answer over ${MAX_ANSWER_BYTES} bytes`);
    let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, json, text, settled: res.headers?.get?.("x-payment-response") ?? null };
  }

  /** The model's answer as text (one paid request). `chatJson` parses the first JSON object out of it. */
  async function chatText(messages, { maxTokens = 1200, temperature = 0.8 } = {}) {
    if (!available) throw new PayError("paid language model not configured", "unavailable");
    state.calls++;
    const body = { model: info.id, messages, temperature, max_tokens: maxTokens, stream: false };
    try {
      if (pocket) { const usd = await pocket(); if (usd < info.capUsd) throw new PayError(`USDC pocket $${usd.toFixed(3)} is under the model cap $${info.capUsd}`, "pocket_low"); }
      const q = await post(body, { "x-x402": "true" });
      if (q.status !== 402 || !q.json?.accepts) throw new PayError(`provider did not quote (HTTP ${q.status})`, "no_quote");
      const quote = parseQuote(q.json, { capUsd: info.capUsd });
      // The facilitator pays the network fee; a quote naming the agent (or anyone we hold) as fee payer would turn our partial signature into a full one.
      if (quote.feePayer === signer.address || quote.payTo === signer.address) throw new PayError("quote names the agent as fee payer or recipient", "bad_quote");
      const bh = await rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const blockhash = bh?.value?.blockhash ?? bh?.blockhash;
      if (!blockhash) throw new PayError("no recent blockhash", "rpc");
      const p = buildPayment({ signer, quote, blockhash });
      state.lastPaymentId = quote.paymentId;
      ledger?.record({ kind: "ai", root, address: signer.address, model: info.id, paymentId: quote.paymentId, payTo: quote.payTo, amountMicros: quote.amountMicros, amountUsd: quote.amountUsd, signature: p.signature, nonce: p.nonce, status: "pending" });
      const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: p.wire } })).toString("base64");
      const r = await post(body, { "X-PAYMENT": header });
      if (r.status !== 200) {
        const refused = r.status === 402 && !r.settled;
        ledger?.record({ kind: "ai", root, paymentId: quote.paymentId, status: refused ? "refused" : "uncertain", http: r.status, note: String(r.json?.error?.message || r.text).slice(0, 160) });
        throw new PayError(`payment ${refused ? "refused" : "uncertain"} (HTTP ${r.status}): ${String(r.json?.error?.message || r.text).replace(/[^\x20-\x7e]/g, "").slice(0, 160)}`, refused ? "payment_refused" : "payment_uncertain", { settled: !refused });
      }
      state.paidMicros += quote.amountMicros;
      ledger?.record({ kind: "ai", root, paymentId: quote.paymentId, status: "settled", amountMicros: quote.amountMicros, settlement: r.settled ? r.settled.slice(0, 200) : null });
      const content = r.json?.choices?.[0]?.message?.content;
      return typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
    } catch (e) {
      state.failures++;
      const msg = e instanceof LlmError ? e.message : e?.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : `request failed (${e?.code ?? e?.name ?? "error"})`;
      state.lastError = msg;
      log.warn?.(`agents: paid model call failed for ${root ?? "?"}: ${msg}`);
      throw e instanceof LlmError ? e : new PayError(msg);
    }
  }

  const chatJson = async (messages, opts) => parseJsonAnswer(await chatText(messages, opts));

  return {
    available, model: available ? info.id : null, rail: "nanogpt-x402-solana",
    chatText, chatJson,
    snapshot: () => ({ available, model: available ? info.id : null, rail: "nanogpt-x402-solana", calls: state.calls, failures: state.failures, paidUsd: state.paidMicros / 1e6, lastError: state.lastError, lastPaymentId: state.lastPaymentId }),
  };
}
