// Keyless model calls paid through NanoGPT's DIRECT Base USDC rail (DESIGN §13.1). NanoGPT's Solana
// x402 rail verifies our payment but its facilitator (Coinbase CDP) refuses to settle with
// "payment_method_required" — an account problem on NanoGPT's side, seen 2026-09-23 and again
// 2026-10-19. The direct rail needs no facilitator: the quote names a unique deposit address, we
// send the exact USDC there from a Base wallet (our own gas), then POST `completeUrl`, which replays
// the stored request once NanoGPT sees the transfer. Proven live on 2026-09-23.
//
// One shared "AI pocket" wallet on Base pays for every agent (the owner funds it once with USDC and
// a little ETH); every call is written to the ledger against the agent that asked, so each agent's
// debt to the pocket is known and can be repaid from its Solana wallet later. The pocket's key is
// kept like the agent keys (AES-256-GCM under the vault key, AAD "base-pocket").
//
// Guards: the quote must be the `base-usdc` scheme on Base for USDC, with deposit address, amount,
// status and completion URLs on NanoGPT's own origin; the amount is capped per model (models.mjs)
// and against the pocket; the USDC transfer is signed, written to the ledger with its hash, then
// broadcast; completion is polled for at most two minutes. Secrets never leave the signer closure.
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { parseJsonAnswer, LlmError } from "../agents/llm.mjs";
import { encryptSecret, decryptSecret, VaultError } from "./vault.mjs";
import { modelInfo } from "./models.mjs";
import { PayError, NANO_URL } from "./pay.mjs";

export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = ethers.getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
export const DEFAULT_BASE_RPC = "https://mainnet.base.org";
export const USDC_ABI = ["function transfer(address to, uint256 value) returns (bool)", "function balanceOf(address owner) view returns (uint256)"];
export const POCKET_MIN_ETH = 0.0002;    // gas for a few hundred USDC transfers on Base
const NANO_ORIGIN = new URL(NANO_URL).origin;
const TIMEOUT_MS = 120_000;
const MAX_ANSWER_BYTES = 256 * 1024;

// ── The pocket wallet ───────────────────────────────────────────────────────────────────────────
const AAD = "base-pocket";
const FILE_V = 1;

/** Creates the pocket once (`DATA_DIR/agents/base-pocket.json`); refuses to overwrite. Returns the address. */
export function createBasePocket({ dir, vaultKey }) {
  const file = join(dir, "base-pocket.json");
  if (existsSync(file)) throw new VaultError("base pocket already exists");
  const w = ethers.Wallet.createRandom();
  const rec = { v: FILE_V, kind: AAD, address: w.address, createdAt: Math.floor(Date.now() / 1000), ...encryptSecret(vaultKey, AAD, Buffer.from(w.privateKey.slice(2), "hex")) };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, file); chmodSync(file, 0o600);
  return { address: w.address, createdAt: rec.createdAt };
}

export function basePocketAddress({ dir }) {
  const file = join(dir, "base-pocket.json");
  if (!existsSync(file)) return null;
  const rec = JSON.parse(readFileSync(file, "utf8"));
  return rec?.kind === AAD && rec.address ? ethers.getAddress(rec.address) : null;
}

/** `{ address, signer(provider) }`: the key is decrypted per use inside the closure and never returned. */
export function openBasePocket({ dir, vaultKey }) {
  const file = join(dir, "base-pocket.json");
  let rec;
  try { rec = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new VaultError(e.code === "ENOENT" ? "no base pocket (run scripts/agent-vault.mjs base-pocket)" : "base pocket file unreadable"); }
  if (rec?.v !== FILE_V || rec.kind !== AAD || !rec.address) throw new VaultError("base pocket file is malformed");
  const key = () => "0x" + decryptSecret(vaultKey, AAD, rec).toString("hex");
  const check = new ethers.Wallet(key());
  if (check.address !== ethers.getAddress(rec.address)) throw new VaultError("base pocket address does not match its key");
  const address = check.address;
  return { address, wallet(provider) { return new ethers.Wallet(key(), provider); }, toJSON() { return { address }; }, toString() { return address; } };
}

export function baseProvider(url = DEFAULT_BASE_RPC) {
  return new ethers.JsonRpcProvider(url, BASE_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
}

/** `{ eth, usdc }` balances of the pocket (numbers; USDC in dollars). */
export async function pocketBalances(provider, address) {
  const [wei, raw] = await Promise.all([provider.getBalance(address), provider.call({ to: USDC_BASE, data: new ethers.Interface(USDC_ABI).encodeFunctionData("balanceOf", [address]) })]);
  return { eth: Number(ethers.formatEther(wei)), usdc: Number(BigInt(raw)) / 1e6, usdcMicros: Number(BigInt(raw)) };
}

// ── NanoGPT's direct rail ───────────────────────────────────────────────────────────────────────
const sameOrigin = (value, label, prefix) => {
  let u; try { u = new URL(String(value || "")); } catch { throw new PayError(`provider ${label} is not a URL`, "bad_quote"); }
  if (u.origin !== NANO_ORIGIN || u.protocol !== "https:") throw new PayError(`provider ${label} is not on the provider's origin`, "bad_quote");
  if (!u.pathname.startsWith(prefix) || u.search || u.hash) throw new PayError(`provider ${label} is not a payment route`, "bad_quote");
  return u.href;
};

/** Parses the 402 body into the direct Base USDC requirement. Exported for tests. */
export function parseDirectQuote(json, { capUsd }) {
  const acc = (json?.payment?.accepted || []).find((a) => a.scheme === "base-usdc" && a.network === "base");
  const req = (json?.accepts || []).find((a) => a.scheme === "usdc-base" && a.network === "base");
  if (!acc || !req) throw new PayError("provider offered no direct Base USDC option", "no_base_option");
  if (String(req.extra?.tokenAddress || req.asset || "").toLowerCase() !== USDC_BASE.toLowerCase() || (req.extra?.chainId != null && Number(req.extra.chainId) !== BASE_CHAIN_ID)) throw new PayError("direct quote is not for Base USDC", "bad_asset");
  let payTo; try { payTo = ethers.getAddress(acc.payTo); } catch { throw new PayError("direct quote has no deposit address", "bad_quote"); }
  if (req.payTo && ethers.getAddress(req.payTo) !== payTo) throw new PayError("direct quote deposit address disagrees", "bad_quote");
  const amountMicros = Number(req.maxAmountRequired ?? acc.amount);
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0 || (acc.amount != null && String(acc.amount) !== String(amountMicros))) throw new PayError("direct quote carries no usable amount", "bad_quote");
  const amountUsd = Number(acc.amountUsd ?? req.maxAmountRequiredUSD ?? amountMicros / 1e6);
  if (amountUsd > capUsd) throw new PayError(`quote $${amountUsd.toFixed(4)} is over the model cap $${capUsd}`, "over_cap", { amountUsd });
  const exp = Number(req.expiresAt), expiresAt = exp > 1e12 ? Math.floor(exp / 1000) : exp;
  if (!(expiresAt > Date.now() / 1000 + 60)) throw new PayError("direct quote expires too soon", "bad_quote");
  return { paymentId: String(acc.paymentId || req.paymentId || ""), payTo, amountMicros, amountUsd, expiresAt, statusUrl: sameOrigin(acc.statusUrl, "status URL", "/api/x402/status/"), completeUrl: sameOrigin(acc.completeUrl, "completion URL", "/api/x402/complete/") };
}

/** POST completeUrl until NanoGPT has seen the deposit (402 "not verified" meanwhile). */
export async function completeDirect(q, { fetchImpl = fetch, deadlineMs = 120_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const t0 = now();
  let last = null, waitMs = 3_000;
  while (now() - t0 < deadlineMs) {
    const res = await fetchImpl(q.completeUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}", signal: AbortSignal.timeout(180_000), redirect: "error" });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
    if (res.status === 200 && json?.choices) return json;
    last = { status: res.status, message: String(json?.message || json?.error?.message || json?.error || text).slice(0, 200), state: String(json?.status || "") };
    if (res.status !== 402 && res.status !== 409) throw new PayError(`direct completion failed (HTTP ${res.status}): ${last.message}`, "complete_failed");
    if (/expired/i.test(last.message) || last.state === "expired") throw new PayError(`direct payment expired before completion: ${last.message}`, "expired");
    try {
      const st = await fetchImpl(q.statusUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000), redirect: "error" });
      const sj = await st.json().catch(() => null);
      const hint = Number(sj?.pollAfterSeconds); if (Number.isFinite(hint) && hint > 0) waitMs = Math.min(10_000, Math.max(1_000, hint * 1000));
    } catch { /* keep the default wait */ }
    await sleep(waitMs);
  }
  throw new PayError(`direct completion not confirmed within ${Math.round(deadlineMs / 1000)} s: ${last?.message || "no answer"}`, "payment_unconfirmed", { settled: true });
}

/**
 * `createBasePaidLlm({ pocket, provider, model, ledger, root })` — same shape as pay.mjs / llm.mjs
 * (`{ available, model, chatText, chatJson, snapshot }`). `pocket` is openBasePocket's object;
 * every call is charged to `root` in the ledger (`kind: "ai"`, rail "base-direct").
 */
export function createBasePaidLlm({ pocket, provider, model, ledger = null, root = null, fetchImpl = fetch, url = NANO_URL, timeoutMs = TIMEOUT_MS, log = console, send = null, now = Date.now } = {}) {
  const info = modelInfo(model);
  const available = !!(pocket && provider && info);
  const state = { calls: 0, failures: 0, paidMicros: 0, lastError: null, lastPaymentId: null };

  async function post(body, headers) {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    const text = await res.text();
    if (text.length > MAX_ANSWER_BYTES) throw new PayError(`answer over ${MAX_ANSWER_BYTES} bytes`);
    let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, json, text };
  }

  // Signed first (hash known and journaled), then broadcast; one confirmation.
  const defaultSend = async (to, micros) => {
    const w = pocket.wallet(provider);
    const data = new ethers.Interface(USDC_ABI).encodeFunctionData("transfer", [to, BigInt(micros)]);
    const populated = await w.populateTransaction({ to: USDC_BASE, data });
    const raw = await w.signTransaction(populated);
    const hash = ethers.keccak256(raw);
    ledger?.record({ kind: "ai", rail: "base-direct", root, address: pocket.address, hash, status: "signed", amountMicros: micros });
    const sent = await provider.broadcastTransaction(raw);
    const rc = await sent.wait(1);
    if (!rc || rc.status !== 1) throw new PayError("USDC transfer reverted", "transfer_reverted", { hash });
    return hash;
  };

  async function chatText(messages, { maxTokens = 1200, temperature = 0.8 } = {}) {
    if (!available) throw new PayError("paid language model not configured", "unavailable");
    state.calls++;
    const body = { model: info.id, messages, temperature, max_tokens: maxTokens, stream: false };
    try {
      const bal = await pocketBalances(provider, pocket.address);
      if (bal.eth < POCKET_MIN_ETH) throw new PayError(`Base pocket has ${bal.eth.toFixed(5)} ETH for gas; needs ${POCKET_MIN_ETH}`, "pocket_gas");
      if (bal.usdc < info.capUsd) throw new PayError(`Base pocket holds $${bal.usdc.toFixed(3)} USDC, under the model cap $${info.capUsd}`, "pocket_low");
      const q = await post(body, { "x-x402": "true" });
      if (q.status !== 402 || !q.json?.payment) throw new PayError(`provider did not quote (HTTP ${q.status})`, "no_quote");
      const quote = parseDirectQuote(q.json, { capUsd: info.capUsd });
      state.lastPaymentId = quote.paymentId;
      ledger?.record({ kind: "ai", rail: "base-direct", root, address: pocket.address, model: info.id, paymentId: quote.paymentId, payTo: quote.payTo, amountMicros: quote.amountMicros, amountUsd: quote.amountUsd, status: "pending" });
      const hash = await (send ?? defaultSend)(quote.payTo, quote.amountMicros);
      ledger?.record({ kind: "ai", rail: "base-direct", root, paymentId: quote.paymentId, hash, status: "paid" });
      const json = await completeDirect(quote, { fetchImpl, now });
      state.paidMicros += quote.amountMicros;
      ledger?.record({ kind: "ai", rail: "base-direct", root, paymentId: quote.paymentId, status: "settled", amountMicros: quote.amountMicros });
      const content = json?.choices?.[0]?.message?.content;
      return typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
    } catch (e) {
      state.failures++;
      const msg = e instanceof LlmError ? e.message : e?.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : `request failed (${e?.code ?? e?.name ?? "error"})`;
      state.lastError = msg;
      if (state.lastPaymentId && !(e instanceof PayError && ["pocket_gas", "pocket_low", "no_quote", "bad_quote", "over_cap", "no_base_option", "bad_asset"].includes(e.code))) ledger?.record({ kind: "ai", rail: "base-direct", root, paymentId: state.lastPaymentId, status: e?.settled ? "uncertain" : "failed", note: msg.slice(0, 160) });
      log.warn?.(`agents: paid model call (base) failed for ${root ?? "?"}: ${msg}`);
      throw e instanceof LlmError ? e : new PayError(msg);
    }
  }
  const chatJson = async (messages, opts) => parseJsonAnswer(await chatText(messages, opts));

  return {
    available, model: available ? info.id : null, rail: "nanogpt-base-direct",
    chatText, chatJson,
    snapshot: () => ({ available, model: available ? info.id : null, rail: "nanogpt-base-direct", calls: state.calls, failures: state.failures, paidUsd: state.paidMicros / 1e6, lastError: state.lastError, lastPaymentId: state.lastPaymentId }),
  };
}
