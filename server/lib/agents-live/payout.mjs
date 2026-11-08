// Automatic payout of an agent's surplus to the owner's wallet (owner 2026-10-19: "it will send
// automatically"). An agent keeps a working balance — enough SOL for its next launches
// (`keepSol`) plus the reserve — and everything above it, and all USDC on the keyed rail (where
// USDC is not needed), goes to `payoutAddress` in one transaction per pass. Simulated, written to
// the ledger with its signature, then sent; never more than the surplus, never below the reserve.
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import { USDC_MINT, LAMPORTS_PER_SOL } from "./budget.mjs";
import { recentBlockhash, simulate, sendAndConfirm, TxError } from "./tx.mjs";

export class PayoutError extends Error { constructor(message, code = "payout") { super(message); this.name = "PayoutError"; this.code = code; } }

export const PAYOUT_DEFAULTS = Object.freeze({ keepSol: 0.1, minPayoutSol: 0.01, minPayoutUsdc: 0.5 });
const FEE_LAMPORTS = 10_000, ATA_RENT_LAMPORTS = 2_039_280;

/** What a pass would move: `{ lamports, usdcMicros, needsAta }` (all zero when nothing is due). Pure. */
export function surplusOf(budget, { keepSol = PAYOUT_DEFAULTS.keepSol, reserveSol = 0.005, minPayoutSol = PAYOUT_DEFAULTS.minPayoutSol, minPayoutUsdc = PAYOUT_DEFAULTS.minPayoutUsdc, sweepUsdc = true } = {}) {
  const keep = Math.round(keepSol * LAMPORTS_PER_SOL) + Math.round(reserveSol * LAMPORTS_PER_SOL); // whole lamports, no float drift
  let lamports = Math.max(0, budget.lamports - keep - FEE_LAMPORTS);
  if (lamports < minPayoutSol * LAMPORTS_PER_SOL) lamports = 0;
  let usdcMicros = sweepUsdc && budget.usdcMicros >= minPayoutUsdc * 1e6 ? budget.usdcMicros : 0;
  // A USDC payout may have to create the owner's token account: that rent comes out of the SOL leg
  // (or is skipped when the SOL leg cannot carry it).
  return { lamports, usdcMicros };
}

/**
 * Sends the surplus of the agent's wallet to `to`. Returns null when nothing is due, else
 * `{ signature, lamports, usdcMicros }`.
 */
export async function payoutSurplus({ rpc, signer, budget, to, cfg = {}, ledger = null, root = null, log = console }) {
  let toKey; try { toKey = new PublicKey(to); } catch { throw new PayoutError("payout address is not a Solana address", "config"); }
  if (toKey.toBase58() === signer.address) throw new PayoutError("payout address is the agent itself", "config");
  const due = surplusOf(budget, cfg);
  if (!due.lamports && !due.usdcMicros) return null;
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 })];
  let lamports = due.lamports, usdcMicros = due.usdcMicros;
  if (usdcMicros) {
    const usdc = new PublicKey(USDC_MINT), fromAta = getAssociatedTokenAddressSync(usdc, signer.publicKey), toAta = getAssociatedTokenAddressSync(usdc, toKey, true);
    const exists = !!(await rpc.call("getAccountInfo", [toAta.toBase58(), { encoding: "base64", commitment: "confirmed" }]))?.value;
    if (!exists) {
      // The owner's USDC account costs rent once; it comes out of the SOL surplus or waits for one.
      if (lamports >= ATA_RENT_LAMPORTS + FEE_LAMPORTS) { lamports -= ATA_RENT_LAMPORTS; ixs.push(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, toAta, toKey, usdc)); }
      else usdcMicros = 0;
    }
    if (usdcMicros) ixs.push(createTransferCheckedInstruction(fromAta, usdc, toAta, signer.publicKey, BigInt(usdcMicros), 6));
  }
  if (lamports > 0) ixs.push(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: toKey, lamports }));
  if (!lamports && !usdcMicros) return null;
  const bh = await recentBlockhash(rpc);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message());
  const sim = await simulate(rpc, tx, { addresses: [signer.address] });
  if (!sim || sim.err != null) throw new PayoutError(`payout simulation failed: ${JSON.stringify(sim?.err ?? "no result").slice(0, 160)}`, "sim");
  const after = Number(sim.accounts?.[0]?.lamports ?? NaN);
  if (!Number.isFinite(after) || after < Math.round((cfg.reserveSol ?? 0.005) * LAMPORTS_PER_SOL)) throw new PayoutError("payout would leave the wallet under its reserve", "sim");
  signer.signTransaction(tx);
  const signature = bs58.encode(tx.signatures[0]);
  ledger?.record({ kind: "payout", root, address: signer.address, to: toKey.toBase58(), lamports, usdcMicros, signature, status: "pending" });
  try {
    const r = await sendAndConfirm(rpc, tx, { lastValidBlockHeight: bh.lastValidBlockHeight });
    ledger?.record({ kind: "payout", root, address: signer.address, to: toKey.toBase58(), signature: r.signature, slot: r.slot, status: "landed" });
    log.info?.(`agents: ${root ?? signer.address} paid out ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL${usdcMicros ? ` + $${(usdcMicros / 1e6).toFixed(2)} USDC` : ""} to ${toKey.toBase58()} (${r.signature})`);
    return { signature: r.signature, lamports, usdcMicros };
  } catch (e) {
    ledger?.record({ kind: "payout", root, address: signer.address, to: toKey.toBase58(), signature: e?.signature ?? signature, status: e instanceof TxError ? e.code : "uncertain", note: String(e.message).slice(0, 160) });
    throw e;
  }
}
