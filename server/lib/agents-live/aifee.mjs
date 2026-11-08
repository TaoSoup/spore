// The agent pays for its own thinking (owner 2026-10-19: "why is the AI fee not paid"). On the keyed
// rail the model provider is paid from the owner's account, and every call is booked to the agent
// in the ledger (kind "ai", status "done", estUsd). That booking is a debt: each pass the agent
// settles what it owes — the unpaid USD converted to SOL at the indexer's price — to the owner's
// wallet, before it spends on new launches. Paid amounts are ledgered as kind "aifee" so the debt
// is always `Σ ai done − Σ aifee landed`, rebuilt from the ledger alone.
import { readFileSync } from "node:fs";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { LAMPORTS_PER_SOL } from "./budget.mjs";
import { recentBlockhash, simulate, sendAndConfirm, TxError } from "./tx.mjs";

export class AiFeeError extends Error { constructor(message, code = "aifee") { super(message); this.name = "AiFeeError"; this.code = code; } }

export const AIFEE_DEFAULTS = Object.freeze({ minUsd: 0.05 });
const FEE_LAMPORTS = 10_000;

/** `{ bookedUsd, paidUsd, owedUsd }` for `root` from the ledger file (missing file = nothing owed). */
export function aiDebtOf(ledgerFile, root) {
  let text = "";
  try { text = readFileSync(ledgerFile, "utf8"); } catch { return { bookedUsd: 0, paidUsd: 0, owedUsd: 0 }; }
  let booked = 0, paid = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.root !== root) continue;
    if (e.kind === "ai" && e.status === "done" && e.estUsd > 0) booked += e.estUsd;
    else if (e.kind === "aifee" && e.status === "landed" && e.usd > 0) paid += e.usd;
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return { bookedUsd: r6(booked), paidUsd: r6(paid), owedUsd: Math.max(0, r6(booked - paid)) };
}

/** Lamports for `usd` at `solUsd`, or null without a price. */
export function lamportsForUsd(usd, solUsd) {
  return solUsd > 0 ? Math.ceil((usd / solUsd) * LAMPORTS_PER_SOL) : null;
}

/**
 * Pays the agent's unpaid model cost to `to`. Keeps `reserveSol`; pays what the wallet can when it
 * cannot cover all of it (the rest stays owed). Returns null when nothing is due or affordable.
 */
export async function payAiFee({ rpc, signer, budget, to, owedUsd, solUsd, reserveSol = 0.005, minUsd = AIFEE_DEFAULTS.minUsd, ledger = null, root = null, log = console }) {
  if (!(owedUsd >= minUsd)) return null;
  let toKey; try { toKey = new PublicKey(to); } catch { throw new AiFeeError("AI fee address is not a Solana address", "config"); }
  if (toKey.toBase58() === signer.address) throw new AiFeeError("AI fee address is the agent itself", "config");
  const want = lamportsForUsd(owedUsd, solUsd);
  if (!want) return null;
  const spare = budget.lamports - Math.round(reserveSol * LAMPORTS_PER_SOL) - FEE_LAMPORTS;
  const lamports = Math.min(want, spare);
  if (lamports < lamportsForUsd(minUsd, solUsd)) return null;
  const usd = Math.round((lamports / LAMPORTS_PER_SOL) * solUsd * 1e6) / 1e6;
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: toKey, lamports })];
  const bh = await recentBlockhash(rpc);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message());
  const sim = await simulate(rpc, tx, { addresses: [signer.address] });
  if (!sim || sim.err != null) throw new AiFeeError(`AI fee simulation failed: ${JSON.stringify(sim?.err ?? "no result").slice(0, 160)}`, "sim");
  signer.signTransaction(tx);
  const signature = bs58.encode(tx.signatures[0]);
  ledger?.record({ kind: "aifee", root, address: signer.address, to: toKey.toBase58(), lamports, usd, owedUsd, solUsd, signature, status: "pending" });
  try {
    const r = await sendAndConfirm(rpc, tx, { lastValidBlockHeight: bh.lastValidBlockHeight });
    ledger?.record({ kind: "aifee", root, address: signer.address, to: toKey.toBase58(), lamports, usd, signature: r.signature, slot: r.slot, status: "landed" });
    log.info?.(`agents: ${root ?? signer.address} paid its AI fee: $${usd.toFixed(4)} = ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL to ${toKey.toBase58()} (${r.signature})${usd < owedUsd ? `, $${(owedUsd - usd).toFixed(4)} still owed` : ""}`);
    return { signature: r.signature, lamports, usd, owedUsd };
  } catch (e) {
    ledger?.record({ kind: "aifee", root, address: signer.address, to: toKey.toBase58(), lamports, usd, signature: e?.signature ?? signature, status: e instanceof TxError ? e.code : "uncertain", note: String(e.message).slice(0, 160) });
    throw e;
  }
}
