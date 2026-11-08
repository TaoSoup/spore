// Claiming the creator fees of an agent's coins (DESIGN §13.1), the server-side twin of
// web/src/lib/pump/claim.ts. A coin's creator fee accrues in the bonding curve's bucket, the sharing
// config's creator vault and (after migration) the pump-amm pool bucket + AMM vault; distribution is
// permissionless and pays every shareholder of the sharing config in the coin's quote: the agent's
// 50 % and Spore's 50 % land in one transaction. The agent pays only the network fee, so it claims
// when its own share covers that fee several times over (`worthClaiming`).
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { PUMP_SDK, ammCreatorVaultPda, bondingCurvePda, canonicalPumpPoolPdaWithQuote, creatorVaultPda, feeSharingConfigPda, isBondingCurveMigrated, isLegacyQuoteMint, normalizeQuoteMint } from "../sdk.mjs";
import { Rpc } from "../rpc.mjs";
import { CU_PRICE_MICRO, MAX_TX_BYTES } from "../agents/simulate.mjs";
import { recentBlockhash, lookupTable, simulate, sendAndConfirm, TxError } from "./tx.mjs";

export class ClaimError extends Error { constructor(message, code = "claim") { super(message); this.name = "ClaimError"; this.code = code; } }

export const CLAIM_MIN_SHARE_LAMPORTS = 2_000_000n; // 0.002 SOL: ~10× the fee of a claim
const SOL_CREATOR_VAULT_FLOOR = 650_240n;            // the vault PDA's rent floor stays behind

const u64At = (data, off) => (data && data.length >= off + 8 ? data.readBigUInt64LE(off) : 0n);
const tokenAmount = (data) => u64At(data, 64);

async function accounts(rpc, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await rpc.call("getMultipleAccounts", [keys.slice(i, i + 100).map((k) => new PublicKey(k).toBase58()), { encoding: "base64", commitment: "confirmed" }]);
    out.push(...(r?.value ?? []).map((v) => { const a = Rpc.account(v); return a ? { ...a, owner: new PublicKey(a.owner) } : null; }));
  }
  return out;
}

/** Everything a claim needs, read live (three round trips), same fields as the web client's ClaimState. */
export async function readClaimState(rpc, mintLike) {
  const mint = new PublicKey(mintLike);
  const sharing = feeSharingConfigPda(mint);
  const [curveInfo, configInfo] = await accounts(rpc, [bondingCurvePda(mint), sharing]);
  if (!curveInfo) throw new ClaimError("this mint has no pump.fun bonding curve", "no_curve");
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  const sol = isLegacyQuoteMint(curve.quoteMint);
  const quoteMint = normalizeQuoteMint(curve.quoteMint);
  const quoteTokenProgram = sol ? TOKEN_PROGRAM_ID : (await accounts(rpc, [quoteMint]))[0]?.owner ?? TOKEN_PROGRAM_ID;
  const migrated = isBondingCurveMigrated(curve);
  const vaultPda = creatorVaultPda(sharing), ammPda = ammCreatorVaultPda(sharing);
  const vaultHolder = sol ? vaultPda : getAssociatedTokenAddressSync(quoteMint, vaultPda, true, quoteTokenProgram);
  const ammAta = getAssociatedTokenAddressSync(quoteMint, ammPda, true, quoteTokenProgram);
  const pool = canonicalPumpPoolPdaWithQuote(mint, quoteMint);
  const [vaultInfo, ammInfo, poolInfo] = await accounts(rpc, [vaultHolder, ammAta, pool]);
  const bucket = BigInt(curve.creatorFee.toString());
  const vaultRaw = sol ? BigInt(vaultInfo?.lamports ?? 0) : tokenAmount(vaultInfo?.data);
  const vault = sol ? (vaultRaw > SOL_CREATOR_VAULT_FLOOR ? vaultRaw - SOL_CREATOR_VAULT_FLOOR : 0n) : vaultRaw;
  const poolCoinCreator = poolInfo && poolInfo.data.length >= 243 ? new PublicKey(poolInfo.data.subarray(211, 243)) : null;
  const poolBucket = poolInfo ? u64At(poolInfo.data, 279) : 0n;
  const amm = migrated ? poolBucket + tokenAmount(ammInfo?.data) : 0n;
  return {
    mint, sharing, config: configInfo ? PUMP_SDK.decodeSharingConfig(configInfo) : null, quoteMint, quoteTokenProgram, sol,
    complete: curve.complete, migrated, holderReward: curve.isHolderReward, curveCreator: curve.creator, poolCoinCreator,
    bucket, vault, amm, total: bucket + vault + amm,
  };
}

/** Each shareholder's cut of `total` by its bps (the program's own integer split). */
export const perShare = (config, total) => config.shareholders.map((s) => ({ address: new PublicKey(s.address).toBase58(), bps: s.shareBps, amount: (total * BigInt(s.shareBps)) / 10_000n }));

/** The agent's own share of what a claim would pay now, in the coin's quote units. */
export function shareOf(state, address) {
  if (!state.config) return 0n;
  return perShare(state.config, state.total).find((s) => s.address === address)?.amount ?? 0n;
}

export const CLAIM_MIN_SHARE_USD = 0.05; // token-quoted coins: the agent's share must be worth this much (fee + shareholder account rent otherwise exceed it)

/**
 * Claim only when the agent's share covers the fee many times over: a SOL share of at least
 * `minLamports`; a token share (children are quoted in their root) worth at least `minUsd` at the
 * indexer's price of the quote mint — with no price known, a token claim is not worth a fee.
 */
export function worthClaiming(state, address, { minLamports = CLAIM_MIN_SHARE_LAMPORTS, minUsd = CLAIM_MIN_SHARE_USD, quoteUsd = null } = {}) {
  const mine = shareOf(state, address);
  if (mine <= 0n) return { ok: false, reason: "nothing to claim", mine };
  if (state.sol) {
    if (mine < minLamports) return { ok: false, reason: `share ${Number(mine) / 1e9} SOL under the ${Number(minLamports) / 1e9} SOL claim floor`, mine };
    return { ok: true, reason: `share ${Number(mine) / 1e9} SOL`, mine };
  }
  if (!(quoteUsd > 0)) return { ok: false, reason: "quote price unknown; a token claim is not worth its fee", mine };
  const usd = (Number(mine) / 1e6) * quoteUsd;
  if (usd < minUsd) return { ok: false, reason: `share worth $${usd.toFixed(4)} under the $${minUsd} claim floor`, mine, usd };
  return { ok: true, reason: `share ${mine} units ≈ $${usd.toFixed(3)}`, mine, usd };
}

/** The indexer's USD price of a mint, when it knows one (several model shapes tolerated). */
export function quotePriceUsd(model, mint) {
  if (!model || !mint) return null;
  const m = new PublicKey(mint).toBase58();
  try {
    const p = model.priceOf?.(m)?.priceUsd ?? model.get?.(m)?.priceUsd ?? null; // lib/model.mjs priceOf(mint) → { priceQuote, priceSol, priceUsd }
    return p > 0 ? p : null;
  } catch { return null; }
}

export async function claimInstructions(payer, s) {
  if (s.holderReward) throw new ClaimError("creator fees of this coin go to its holders; no sharing config to claim through", "holder_reward");
  if (!s.config) throw new ClaimError("this coin has no fee-sharing config", "no_config");
  if (!s.curveCreator.equals(s.sharing)) throw new ClaimError("this coin's fees are not routed through its sharing config", "not_routed");
  const { mint, quoteMint, quoteTokenProgram } = s;
  const ixs = [];
  if (s.bucket > 0n || !s.migrated) ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer, mint, creator: s.sharing, quoteMint, quoteTokenProgram }));
  if (s.migrated) {
    ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer, mint, coinCreator: s.poolCoinCreator ?? s.sharing, quoteMint, quoteTokenProgram }));
    ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer, mint, quoteMint, quoteTokenProgram }));
  }
  ixs.push(await PUMP_SDK.distributeCreatorFeesV2({ mint, sharingConfig: s.config, sharingConfigAddress: s.sharing, quoteMint, payer, shouldInitializeAta: true, quoteTokenProgram }));
  return ixs;
}

const cu = (units) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO })];

/** The claim as the agent signs it: v0 with Spore's lookup table and a real blockhash. */
export async function buildClaimTx(rpc, payer, state) {
  const ixs = await claimInstructions(payer, state);
  const [{ blockhash, lastValidBlockHeight }, table] = await Promise.all([recentBlockhash(rpc), lookupTable(rpc)]);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...cu(state.migrated ? 250_000 : 200_000), ...ixs] }).compileToV0Message([table]));
  const n = tx.serialize().length;
  if (n > MAX_TX_BYTES) throw new ClaimError(`claim too large for one transaction (${n} bytes)`, "too_large");
  return { tx, lastValidBlockHeight };
}

/**
 * Claims one coin's fees for every shareholder, paid by the agent. Returns null when not worth it.
 * Simulated first; the ledger gets the signature before the send.
 */
export async function claimCoin({ rpc, signer, mint, ledger = null, root = null, model = null, log = console, minLamports = CLAIM_MIN_SHARE_LAMPORTS, minUsd = CLAIM_MIN_SHARE_USD }) {
  const state = await readClaimState(rpc, mint);
  const w = worthClaiming(state, signer.address, { minLamports, minUsd, quoteUsd: state.sol ? null : quotePriceUsd(model, state.quoteMint) });
  if (!w.ok) return null;
  const { tx, lastValidBlockHeight } = await buildClaimTx(rpc, signer.publicKey, state);
  const sim = await simulate(rpc, tx);
  if (!sim || sim.err != null) throw new ClaimError(`claim simulation failed: ${JSON.stringify(sim?.err ?? "no result").slice(0, 160)}`, "sim");
  signer.signTransaction(tx);
  const signature = bs58.encode(tx.signatures[0]);
  ledger?.record({ kind: "claim", root, address: signer.address, mint: new PublicKey(mint).toBase58(), total: state.total.toString(), mine: w.mine.toString(), sol: state.sol, signature, status: "pending" });
  try {
    const r = await sendAndConfirm(rpc, tx, { lastValidBlockHeight });
    ledger?.record({ kind: "claim", root, mint: new PublicKey(mint).toBase58(), signature: r.signature, slot: r.slot, status: "landed" });
    log.info?.(`agents: ${root ?? signer.address} claimed ${new PublicKey(mint).toBase58()}: share ${w.mine} (${r.signature})`);
    return { signature: r.signature, mine: w.mine, total: state.total, sol: state.sol };
  } catch (e) {
    ledger?.record({ kind: "claim", root, mint: new PublicKey(mint).toBase58(), signature: e?.signature ?? signature, status: e instanceof TxError ? e.code : "uncertain", note: String(e.message).slice(0, 160) });
    throw e;
  }
}
