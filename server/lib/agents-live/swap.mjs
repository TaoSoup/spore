// Topping up an agent's USDC pocket from its own SOL through Jupiter (DESIGN §13.1). The model rail
// is paid in USDC while fees arrive in SOL, so the agent swaps a little SOL when the pocket falls
// under its floor (budget.mjs topUpNeeded). Ported from a working production path (2026-09).
//
// Guards, in order: the quote must be SOL → USDC for exactly the requested lamports with a sane
// minimum out and ≤ 1 % price impact; the swap transaction Jupiter returns must be paid by the agent,
// need exactly one signer, be unsigned and call the Jupiter program; it is simulated with the real
// blockhash and the agent's SOL may fall by at most input + allowance while its USDC must rise by at
// least the quote's minimum; only then is it signed, written to the ledger and sent. Fund-critical:
// changes here need a second review before they run with real money.
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { USDC_MINT, LAMPORTS_PER_SOL } from "./budget.mjs";
import { recentBlockhash, simulate, sendAndConfirm, TxError } from "./tx.mjs";

export const JUPITER_API = "https://api.jup.ag/swap/v1";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const SWAP_MAX_PRIORITY_LAMPORTS = 1_000_000;   // 0.001 SOL
export const SWAP_FEE_ALLOWANCE_LAMPORTS = 10_000_000; // 0.01 SOL: fee + rent of a fresh wSOL/USDC account
export const SWAP_MAX_PRICE_IMPACT = 0.01;
export const SWAP_MIN_USD = 0.2, SWAP_MAX_USD = 5;      // one top-up is small by design

export class SwapError extends Error { constructor(message, code = "swap_failed") { super(message); this.name = "SwapError"; this.code = code; } }

async function jfetch(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, { ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) }, signal: AbortSignal.timeout(20_000), redirect: "error" });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok || !json || typeof json !== "object") throw new SwapError(`Jupiter ${res.status}: ${String(json?.error || text).slice(0, 120)}`, "jupiter");
  return json;
}

export async function jupiterQuote({ lamports, slippageBps = 50, fetchImpl = fetch, api = JUPITER_API } = {}) {
  const q = await jfetch(fetchImpl, `${api}/quote?inputMint=${WSOL_MINT}&outputMint=${USDC_MINT}&amount=${lamports}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`);
  const out = Number(q.outAmount), min = Number(q.otherAmountThreshold), impact = Number(q.priceImpactPct || 0);
  if (String(q.inputMint) !== WSOL_MINT || String(q.outputMint) !== USDC_MINT || String(q.inAmount) !== String(lamports)) throw new SwapError("Jupiter quote does not match the request", "bad_quote");
  if (!Number.isSafeInteger(out) || out <= 0 || !Number.isSafeInteger(min) || min <= 0 || min > out) throw new SwapError("Jupiter quote carries no usable amounts", "bad_quote");
  if (!(impact >= 0) || impact > SWAP_MAX_PRICE_IMPACT) throw new SwapError(`Jupiter price impact ${impact} too high`, "impact");
  return { quote: q, outMicros: out, minOutMicros: min, priceImpact: impact };
}

export async function jupiterSwapTransaction({ quote, wallet, fetchImpl = fetch, api = JUPITER_API } = {}) {
  const r = await jfetch(fetchImpl, `${api}/swap`, { method: "POST", body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: SWAP_MAX_PRIORITY_LAMPORTS, priorityLevel: "medium" } } }) });
  const wire = String(r.swapTransaction || ""), lastValidBlockHeight = Number(r.lastValidBlockHeight);
  if (!wire || !Number.isSafeInteger(lastValidBlockHeight)) throw new SwapError("Jupiter swap response is incomplete", "jupiter");
  return { wire, lastValidBlockHeight };
}

/** Programs a swap transaction may call at the top level (program ids are always static keys). */
export const SWAP_PROGRAMS = new Set([
  JUPITER_PROGRAM,
  "11111111111111111111111111111111",              // System (wSOL account funding)
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // Associated token account
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);

/** Structural checks on the unsigned swap (payer, one signer, unsigned, every top-level instruction on an allowlisted program): exported for tests. */
export function checkSwapTx(tx, wallet) {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  if (keys[0] !== wallet) throw new SwapError("swap is not paid by the agent", "bad_tx");
  if (tx.message.header.numRequiredSignatures !== 1) throw new SwapError("swap needs more than one signer", "bad_tx");
  if (tx.signatures.some((s) => s.some((b) => b !== 0))) throw new SwapError("swap arrived signed", "bad_tx");
  if (!keys.includes(JUPITER_PROGRAM)) throw new SwapError("swap does not call the Jupiter program", "bad_tx");
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!SWAP_PROGRAMS.has(program)) throw new SwapError(`swap calls a program outside the allowlist (${program ?? "lookup-table index"})`, "bad_tx");
    // The System program may only fund/create the wallet's own temporary accounts; an Assign or
    // Allocate on the wallet itself would hand its account to another program.
    if (program === "11111111111111111111111111111111") {
      const kind = Buffer.from(ix.data).readUInt32LE(0); // 0 CreateAccount, 1 Assign, 2 Transfer, 8 Allocate, 10 AllocateWithSeed, 1 Assign…
      if (![0, 2, 3].includes(kind)) throw new SwapError(`swap carries a System instruction of kind ${kind}`, "bad_tx");
      if ([0, 3].includes(kind) && keys[ix.accountKeyIndexes[1]] === wallet) throw new SwapError("swap would re-create the agent's wallet account", "bad_tx");
    }
  }
  return keys;
}

const parsedLamports = (acc) => (acc && Number.isSafeInteger(acc.lamports) ? acc.lamports : null);
const tokenMicros = (acc) => {
  if (acc === null) return 0;
  const data = acc?.data?.[0];
  if (typeof data !== "string") return null;
  const buf = Buffer.from(data, "base64");
  return buf.length >= 72 ? Number(buf.readBigUInt64LE(64)) : null;
};

/**
 * Swaps `usd` worth of the agent's SOL into USDC. `budget` is a fresh budget.mjs snapshot with a
 * SOL price. Returns `{ signature, lamportsIn, minOutMicros }`. Throws before signing on any guard.
 */
export async function topUpUsdc({ rpc, signer, budget, usd, reserveSol = 0.005, ledger = null, root = null, fetchImpl = fetch, api = JUPITER_API, log = console }) {
  if (!(usd >= SWAP_MIN_USD && usd <= SWAP_MAX_USD)) throw new SwapError(`top-up must be between $${SWAP_MIN_USD} and $${SWAP_MAX_USD}`, "amount");
  if (!(budget?.solUsd > 0)) throw new SwapError("SOL price unknown", "price");
  const wallet = signer.address;
  const lamportsIn = Math.ceil((usd * 1.01 / budget.solUsd) * LAMPORTS_PER_SOL);
  const needLamports = lamportsIn + SWAP_FEE_ALLOWANCE_LAMPORTS + Math.ceil(reserveSol * LAMPORTS_PER_SOL);
  if (budget.lamports < needLamports) throw new SwapError(`wallet holds ${(budget.lamports / 1e9).toFixed(4)} SOL; the top-up needs ${(needLamports / 1e9).toFixed(4)} with reserve`, "funds");
  const { quote, minOutMicros, outMicros } = await jupiterQuote({ lamports: lamportsIn, fetchImpl, api });
  if (minOutMicros < Math.floor(usd * 1e6 * 0.97)) throw new SwapError(`Jupiter would deliver $${(minOutMicros / 1e6).toFixed(2)} for a $${usd.toFixed(2)} top-up`, "bad_quote");
  const { wire, lastValidBlockHeight } = await jupiterSwapTransaction({ quote, wallet, fetchImpl, api });
  const tx = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
  checkSwapTx(tx, wallet);
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), signer.publicKey, false).toBase58();
  const sim = await simulate(rpc, tx, { addresses: [wallet, ata] });
  if (!sim || sim.err != null) throw new SwapError(`swap simulation failed: ${JSON.stringify(sim?.err ?? "no result").slice(0, 120)}`, "sim");
  const [postWallet, postAta] = sim.accounts || [];
  const postLamports = parsedLamports(postWallet), postUsdc = tokenMicros(postAta);
  if (postLamports == null || postUsdc == null) throw new SwapError("swap simulation returned no balances", "sim");
  if (postLamports < budget.lamports - lamportsIn - SWAP_FEE_ALLOWANCE_LAMPORTS) throw new SwapError("swap would take more SOL than quoted", "sim");
  if (postUsdc < budget.usdcMicros + minOutMicros) throw new SwapError("swap would deliver less USDC than its own minimum", "sim");
  signer.signTransaction(tx);
  const signature = bs58.encode(tx.signatures[0]);
  ledger?.record({ kind: "swap", root, address: wallet, lamportsIn, minOutMicros, outMicros, signature, status: "pending" });
  try {
    const r = await sendAndConfirm(rpc, tx, { lastValidBlockHeight });
    ledger?.record({ kind: "swap", root, address: wallet, signature: r.signature, slot: r.slot, status: "landed" });
    log.info?.(`agents: ${root ?? wallet} topped up USDC: ${(lamportsIn / 1e9).toFixed(4)} SOL → ≥ $${(minOutMicros / 1e6).toFixed(2)} (${r.signature})`);
    return { signature: r.signature, lamportsIn, minOutMicros };
  } catch (e) {
    ledger?.record({ kind: "swap", root, address: wallet, signature: e?.signature ?? signature, status: e instanceof TxError ? e.code : "uncertain", note: String(e.message).slice(0, 160) });
    throw e;
  }
}
