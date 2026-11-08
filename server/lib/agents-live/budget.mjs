// What an agent may spend (DESIGN §13.1). An agent's wallet holds SOL (launch rent, fees, the seed
// buy) and a little USDC (the keyless language-model rail is paid in USDC). The gates are pure
// functions over one balance snapshot so they can be unit-tested; `readBudget` is the only reader.
//
// Owner's rules (2026-10-19): an agent starts only once its wallet holds the starting budget (~$5);
// money comes from that seed and from the creator fees its coins earn, never from the platform
// wallet; launches stop when the wallet cannot pay a launch and still keep a reserve.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const LAMPORTS_PER_SOL = 1_000_000_000;

export const BUDGET_DEFAULTS = Object.freeze({
  startUsd: 5,            // the wallet must hold this much (SOL + USDC, in USD) before the agent runs at all
  reserveSol: 0.005,      // never spent: keeps the wallet rent-exempt and able to pay a fee-claim tx
  aiFloorUsd: 0.25,       // below this much USDC the agent asks for a top-up (SOL → USDC) before thinking
  aiTargetUsd: 1.0,       // a top-up brings the USDC pocket to this
  launchMarginSol: 0.003, // headroom over the simulated launch cost (fee spikes, rent rounding)
});

/** One snapshot: lamports, SOL, USDC (6 decimals as a number) and the USD total at `solUsd`. */
export async function readBudget(rpc, address, { solUsd = null } = {}) {
  const owner = new PublicKey(address);
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), owner, false).toBase58();
  const bal = await rpc.call("getBalance", [address, { commitment: "confirmed" }]);
  const lamports = Number(bal?.value ?? bal ?? 0);
  let usdcMicros = 0;
  try {
    const t = await rpc.call("getTokenAccountBalance", [ata, { commitment: "confirmed" }]);
    usdcMicros = Number(t?.value?.amount ?? 0);
  } catch (e) {
    // No token account yet = no USDC. Any other failure is a real error the caller should see.
    if (!/could not find account|Invalid param|not found/i.test(String(e?.message ?? e))) throw e;
  }
  return snapshot({ lamports, usdcMicros, solUsd, address, usdcAccount: ata });
}

export function snapshot({ lamports, usdcMicros, solUsd = null, address = null, usdcAccount = null }) {
  const sol = lamports / LAMPORTS_PER_SOL, usdc = usdcMicros / 1e6;
  const usd = solUsd > 0 ? sol * solUsd + usdc : null;
  return { address, usdcAccount, lamports, sol, usdcMicros, usdc, solUsd: solUsd > 0 ? solUsd : null, usd, readAt: Math.floor(Date.now() / 1000) };
}

/** May the agent run at all? Needs a SOL price to value the wallet; without one it stays asleep. */
export function canStart(b, { startUsd = BUDGET_DEFAULTS.startUsd } = {}) {
  if (b.usd == null) return { ok: false, reason: "SOL price unknown; cannot value the wallet" };
  if (b.usd < startUsd) return { ok: false, reason: `wallet holds $${b.usd.toFixed(2)}, needs $${startUsd.toFixed(2)} to start` };
  return { ok: true, reason: `wallet holds $${b.usd.toFixed(2)}` };
}

/** May the agent pay for one launch whose simulation cost `estCostSol` SOL, keeping the reserve? */
export function canLaunch(b, estCostSol, { reserveSol = BUDGET_DEFAULTS.reserveSol, launchMarginSol = BUDGET_DEFAULTS.launchMarginSol } = {}) {
  if (!(estCostSol > 0)) return { ok: false, reason: "launch cost unknown" };
  const need = estCostSol + launchMarginSol + reserveSol;
  if (b.sol < need) return { ok: false, reason: `launch needs ${need.toFixed(4)} SOL (cost ${estCostSol.toFixed(4)} + margin + reserve), wallet has ${b.sol.toFixed(4)}` };
  return { ok: true, reason: `launch costs ${estCostSol.toFixed(4)} SOL of ${b.sol.toFixed(4)}` };
}

/** May the agent pay one model call of at most `capUsd` from its USDC pocket? */
export function canThink(b, capUsd) {
  if (!(capUsd > 0)) return { ok: false, reason: "model price cap unknown" };
  if (b.usdc < capUsd) return { ok: false, reason: `model call may cost $${capUsd.toFixed(3)}, USDC pocket holds $${b.usdc.toFixed(3)}` };
  return { ok: true, reason: `USDC pocket $${b.usdc.toFixed(3)}` };
}

/** Does the USDC pocket need a top-up, and how much (in USD) would bring it to the target? */
export function topUpNeeded(b, { aiFloorUsd = BUDGET_DEFAULTS.aiFloorUsd, aiTargetUsd = BUDGET_DEFAULTS.aiTargetUsd } = {}) {
  if (b.usdc >= aiFloorUsd) return { needed: false, usd: 0 };
  return { needed: true, usd: Math.max(0, aiTargetUsd - b.usdc) };
}
