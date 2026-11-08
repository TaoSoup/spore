// Sending and confirming an agent's transaction (DESIGN §13.1). The only place in the server that
// sends anything to the chain. Every send is bounded: the transaction carries a real blockhash,
// `confirm` polls getSignatureStatuses until the signature lands or `lastValidBlockHeight` passes,
// and the result is one of landed / failed / expired, never silence. Callers record the signature
// in their ledger BEFORE calling `send`, so a crash between send and confirm is reconciled from
// the chain by the signature.
import { PublicKey, AddressLookupTableAccount } from "@solana/web3.js";
import { LOOKUP_TABLE } from "../agents/simulate.mjs";

export class TxError extends Error { constructor(message, code = "tx_failed", extra = {}) { super(message); this.name = "TxError"; this.code = code; Object.assign(this, extra); } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `{ blockhash, lastValidBlockHeight }` at confirmed commitment. */
export async function recentBlockhash(rpc) {
  const r = await rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const v = r?.value ?? r;
  if (!v?.blockhash || !Number.isFinite(Number(v.lastValidBlockHeight))) throw new TxError("no recent blockhash", "rpc");
  return { blockhash: v.blockhash, lastValidBlockHeight: Number(v.lastValidBlockHeight) };
}

let tableCache = null;
/** Spore's frozen lookup table, fetched once per process. */
export async function lookupTable(rpc) {
  if (!tableCache) {
    tableCache = rpc.call("getAccountInfo", [LOOKUP_TABLE, { encoding: "base64", commitment: "confirmed" }]).then((r) => {
      const a = r?.value;
      if (!a) throw new TxError(`lookup table ${LOOKUP_TABLE} not found`, "rpc");
      return new AddressLookupTableAccount({ key: new PublicKey(LOOKUP_TABLE), state: AddressLookupTableAccount.deserialize(Buffer.from(a.data[0], "base64")) });
    });
    tableCache.catch(() => { tableCache = null; });
  }
  return tableCache;
}

/**
 * Simulates a fully built (signed or unsigned) transaction with sigVerify off; returns the node's
 * value. The blockhash is replaced by default: a pre-send check must not fail with BlockhashNotFound
 * on a node that has not seen a hash fetched seconds ago (seen live 2026-10-19 on a claim).
 */
export async function simulate(rpc, tx, { addresses = [], replaceRecentBlockhash = true } = {}) {
  const r = await rpc.call("simulateTransaction", [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash, commitment: "confirmed", accounts: { encoding: "base64", addresses } }]);
  return r?.value ?? r;
}

/** Sends a signed transaction (preflight on). Returns the signature. */
export async function send(rpc, tx) {
  const wire = Buffer.from(tx.serialize()).toString("base64");
  const sig = await rpc.call("sendTransaction", [wire, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
  if (typeof sig !== "string" || sig.length < 60) throw new TxError("sendTransaction returned no signature", "rpc");
  return sig;
}

/**
 * Waits for `signature` to land: `{ status: "landed", slot, err: null }` once confirmed, `failed` with
 * the chain's error, or `expired` once the current block height passes `lastValidBlockHeight` without
 * it (the transaction can then never land; the caller may rebuild and retry).
 */
export async function confirm(rpc, signature, { lastValidBlockHeight, pollMs = 1500, maxMs = 90_000, now = Date.now } = {}) {
  const t0 = now();
  while (now() - t0 < maxMs) {
    const st = (await rpc.call("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]))?.value?.[0];
    if (st) {
      const level = st.confirmationStatus;
      if (st.err) return { status: "failed", slot: st.slot, err: st.err };
      if (level === "confirmed" || level === "finalized") return { status: "landed", slot: st.slot, err: null };
    }
    if (lastValidBlockHeight != null) {
      const h = await rpc.call("getBlockHeight", [{ commitment: "confirmed" }]);
      if (Number(h) > lastValidBlockHeight) {
        // One last look: the status can appear after the height passes.
        const last = (await rpc.call("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]))?.value?.[0];
        if (last) return last.err ? { status: "failed", slot: last.slot, err: last.err } : { status: "landed", slot: last.slot, err: null };
        return { status: "expired", slot: null, err: null };
      }
    }
    await sleep(pollMs);
  }
  return { status: "unknown", slot: null, err: null };
}

/** send + confirm in one call; throws TxError on failed/expired/unknown with the signature attached. */
export async function sendAndConfirm(rpc, tx, { lastValidBlockHeight, ...opts } = {}) {
  const signature = await send(rpc, tx);
  const r = await confirm(rpc, signature, { lastValidBlockHeight, ...opts });
  if (r.status !== "landed") throw new TxError(`transaction ${r.status}${r.err ? `: ${JSON.stringify(r.err).slice(0, 160)}` : ""}`, `tx_${r.status}`, { signature, slot: r.slot });
  return { signature, slot: r.slot };
}
