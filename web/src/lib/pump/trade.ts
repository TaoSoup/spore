// Buying and selling any SOL-rooted coin of the tree with pump-amm's multi_hop_swap. Quotes come
// from a simulation rather than curve math: one call covers every venue mix (curve/pool) and the
// fee schedule pump applies that day, and the output is read from the balance the user's account
// ends the simulation with, which is exactly what min_amount_out is compared against.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPdaWithQuote, multiHopRouteEnds, pumpIdl } from "@pump-fun/pump-sdk";
import { hopsFor, type Chain, type Side } from "./route";
import { lookupTables } from "./alt";

/// The floor of the priority fee (0.05 lamports per CU: ~0.00002 SOL on a 400k-CU route): what a trade pays
/// when the network is quiet or the recent fees cannot be read.
export const CU_PRICE_MICRO = 50_000;
/// The ceiling (1 lamport per CU: 0.0003 SOL on a 300k-CU route), whatever the recent fees say.
export const CU_PRICE_MAX_MICRO = 1_000_000;
const BASE_FEE_LAMPORTS = 5_000;
/// The compute limit a quote simulates with: high enough for any route, so the simulation measures what it uses.
export const QUOTE_CU_LIMIT = 1_400_000;

/// The compute limit a swap is built with: the simulated use plus a margin (account creation differs between the
/// quote's payer and the signer, and curves move), or the per-hop estimate when there is no simulation.
export function swapUnits(hops: number, simulated?: number | null): number {
  const est = Math.min(QUOTE_CU_LIMIT, 150_000 + 80_000 * hops);
  if (!simulated || simulated <= 0) return est;
  return Math.min(QUOTE_CU_LIMIT, Math.max(Math.ceil(simulated * 1.3), simulated + 40_000));
}

/// The priority fee (micro-lamports per CU) from the network's recent fees on the accounts the route writes: the
/// 75th percentile of the last ~150 slots, clamped to [CU_PRICE_MICRO, CU_PRICE_MAX_MICRO]. A failed read is the floor.
export async function priorityMicroLamports(conn: Connection, writable: PublicKey[]): Promise<number> {
  try {
    const rows = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 128) });
    const fees = rows.map((r) => r.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
    if (!fees.length) return CU_PRICE_MICRO;
    const p75 = fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))];
    return Math.min(CU_PRICE_MAX_MICRO, Math.max(CU_PRICE_MICRO, Math.ceil(p75)));
  } catch { return CU_PRICE_MICRO; }
}

/// The network fee a swap pays: the base signature fee plus the priority fee on its whole compute limit.
export const swapFeeLamports = (units: number, microLamports: number) => BigInt(BASE_FEE_LAMPORTS + Math.ceil((units * microLamports) / 1_000_000));

/// Rent of a new associated token account: classic SPL Token accounts are 165 bytes, Token-2022 ones (every
/// pump.fun coin since create_v2) 170 bytes with the ImmutableOwner extension; (128 + size) × 6 960 lamports.
export const TOKEN_2022_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ataRentLamports = (tokenProgram: string) => (tokenProgram === TOKEN_2022_ID ? 2_074_080n : 2_039_280n);

export type Quote = {
  amountOut: bigint; logs: string[]; unitsConsumed: number;
  /// Lamports of a WSOL account the user already had that the route closes back into the wallet
  /// (its rent plus any wrapped SOL; 0 when there is none). Real money for the user, but not swap
  /// output; the UI may warn that the wrapped balance gets unwrapped as a side effect.
  unwrapped: bigint;
};

const cuIxs = (units: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO })];

export const MAX_TX_BYTES = 1232;

export function compileV0(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[] = []): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables));
}

/// Serialized size, or null when the message is too large to encode at all.
export function txBytes(tx: VersionedTransaction): number | null {
  try { return tx.serialize().length; } catch { return null; }
}

function assertSendable(tx: VersionedTransaction, what: string) {
  const n = txBytes(tx);
  if (n === null || n > MAX_TX_BYTES) throw new Error(`${what} is too large for one transaction (${n ?? ">1232"} bytes). This chain is deeper than the lookup table covers.`);
  return tx;
}

async function swapInstructions(user: PublicKey, chain: Chain, side: Side, amountIn: bigint, minAmountOut: bigint) {
  if (amountIn <= 0n) throw new Error("Enter an amount");
  const hops = hopsFor(chain, side);
  const ixs = await PUMP_SDK.multiHopSwapInstructions({ user, hops, side, amountIn: new BN(amountIn.toString()), minAmountOut: new BN(minAmountOut.toString()) });
  return { hops, ixs };
}

/// SPL Token and Token-2022 share the base account layout: the amount is the u64 at offset 64.
const tokenAmount = (data: Uint8Array | null | undefined) => (data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true) : 0n);
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const lamportsOf = (a: { lamports: number } | null | undefined) => BigInt(a?.lamports ?? 0);

export async function quoteSwap(conn: Connection, user: PublicKey, chain: Chain, side: Side, amountIn: bigint): Promise<Quote> {
  const { hops, ixs } = await swapInstructions(user, chain, side, amountIn, 1n);
  const { input, output } = multiHopRouteEnds(hops, side);
  const solOut = output.mint.equals(NATIVE_MINT);
  // SOL proceeds land in the wallet itself (a WSOL account is closed back into it); tokens land in
  // the user's associated token account, created by the route when missing.
  const outAccount = solOut ? user : getAssociatedTokenAddressSync(output.mint, user, true, output.tokenProgram);
  // Whenever SOL is the route's input or output, the SDK creates the user's WSOL account
  // idempotently and closes it at the end. One that already existed (anyone who wrapped SOL or
  // used another DEX) then pours its rent and wrapped balance into the wallet inside the same
  // transaction. The program's min_amount_out never sees those lamports, so a quote that counted
  // them would demand a minimum the swap cannot reach (the 0.002 SOL rent alone is 4x the
  // tolerance of a 0.05 SOL sell at 1% slippage; a wrapped balance makes it absurd: a 7.3 SOL
  // "quote" for a 0.013 SOL sell was measured). Reading the account before and after cancels it.
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  const touchesWsol = solOut || input.mint.equals(NATIVE_MINT);
  const [[pre, wsolPre], { blockhash }, tables] = await Promise.all([conn.getMultipleAccountsInfo([outAccount, wsolAta], "confirmed"), conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  const tx = assertSendable(compileV0(user, blockhash, [...cuIxs(QUOTE_CU_LIMIT), ...ixs], tables), "The route");
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [outAccount.toBase58(), wsolAta.toBase58()] } });
  const logs = sim.value.logs ?? [];
  if (sim.value.err) throw new Error(explainSimulationError(sim.value.err, logs));
  const post = sim.value.accounts?.[0] ?? null;
  // Null after the route closed it; counted in case a route ever leaves it open holding output.
  const wsolPost = sim.value.accounts?.[1] ?? null;
  const before = solOut ? lamportsOf(pre) + lamportsOf(wsolPre) : tokenAmount(pre?.data);
  const after = solOut ? lamportsOf(post) + lamportsOf(wsolPost) : tokenAmount(post ? fromBase64(post.data[0]) : null);
  let amountOut = after - before;
  // The simulated bank charged the transaction fee to the wallet; the program's min_amount_out
  // check sees the hop output before that, so add it back for SOL proceeds.
  if (solOut) amountOut += BigInt(BASE_FEE_LAMPORTS + Math.ceil((QUOTE_CU_LIMIT * CU_PRICE_MICRO) / 1_000_000));
  if (amountOut <= 0n) throw new Error("The route returned nothing for that amount");
  return { amountOut, logs, unitsConsumed: sim.value.unitsConsumed ?? 0, unwrapped: touchesWsol ? lamportsOf(wsolPre) : 0n };
}

/// `units` / `microLamports`: the compute limit (swapUnits) and the priority fee (priorityMicroLamports) the
/// widget showed; without them the per-hop estimate and the fee floor.
export async function buildSwapTx(conn: Connection, user: PublicKey, chain: Chain, side: Side, amountIn: bigint, minAmountOut: bigint, opts: { units?: number; microLamports?: number } = {}): Promise<VersionedTransaction> {
  if (minAmountOut <= 0n) throw new Error("minAmountOut must be at least 1");
  const { hops, ixs } = await swapInstructions(user, chain, side, amountIn, minAmountOut);
  // ~30–50k CU per hop plus account creation; the unused part of the limit is not charged, but the priority fee is.
  const units = opts.units ?? swapUnits(hops.length);
  const [{ blockhash }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  return assertSendable(compileV0(user, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports ?? CU_PRICE_MICRO }), ...ixs], tables), "The route");
}

/// The accounts a route writes that fee markets key on: each hop's venue (curve or canonical pool).
export function routeVenues(chain: Chain, side: Side): PublicKey[] {
  return hopsFor(chain, side).map((h) => (h.venue === "pool" ? canonicalPumpPoolPdaWithQuote(h.baseMint, h.quoteMint) : bondingCurvePda(h.baseMint)));
}

type IdlError = { code: number; name: string; msg?: string };
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_ERRORS = new Map<number, string>((pumpIdl as { errors?: IdlError[] }).errors?.map((e) => [e.code, e.msg || e.name]) ?? []);
/// pump-amm's errors a swap can raise (its IDL is not exported by the SDK; codes from pump_amm.json in pump-sdk 4.1.0).
/// multi_hop_swap is a pump-amm instruction, so its own refusals carry these codes, not pump's.
const AMM_ERRORS = new Map<number, string>([
  [6003, "the pool has too little liquidity for this trade"],
  [6004, "slippage: the output fell below your minimum"],
  [6016, "the buy asks for more tokens than the pool holds"],
  [6040, "slippage: the buy would get fewer tokens than your minimum"],
  [6042, "mayhem-mode pools only take pump's mayhem trades"],
  [6063, "the pool's real reserves cannot pay this sell"],
  [6078, "only canonical pump pools can be routed"],
  [6079, "this is a cashback coin, which pump's multi-hop swap cannot route"],
  [6080, "this is a mayhem-mode pool, which pump's multi-hop swap cannot route"],
  [6084, "the route's hops do not connect (a coin is not quoted in the previous one)"],
  [6085, "the curve hops' balances did not match what pump reported"],
  [6086, "the route mixes buy and sell directions"],
]);
/// Jupiter's aggregator (the quick trade's route for coins priced in a listed asset with no pump SOL pool: lib/jup.ts).
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/// Jupiter v6's errors a /build swap can raise (its IDL's error list).
const JUP_ERRORS = new Map<number, string>([
  [6000, "Jupiter's route came back empty"],
  [6001, "slippage: the output fell below your minimum"],
  [6017, "the route's output did not match the exact amount asked"],
]);
/// Slippage refusals in each program: the fill fell below (or the cost rose above) the bound the transaction carries.
const SLIPPAGE = { [PUMP_PROGRAM]: new Set([6002, 6003, 6042]), [PUMP_AMM_PROGRAM]: new Set([6004, 6040]), [JUPITER_PROGRAM]: new Set([6001]) } as Record<string, Set<number>>;
const BOTH_SLIPPAGE = new Set([6002, 6003, 6042, 6004, 6040]);
const OTHER: Record<number, string> = { 1: "insufficient funds in the wallet for this trade" };

/// The innermost failing program and its custom error code from simulation logs ("Program X failed: custom program
/// error: 0x…" is printed by the failing program first, then by each caller it unwinds through), or null.
export function failedProgram(logs: string[]): { program: string; code: number } | null {
  for (const l of logs) {
    const m = l.match(/^Program (\w+) failed: custom program error: 0x([0-9a-f]+)/i);
    if (m) return { program: m[1], code: parseInt(m[2], 16) };
  }
  const any = logs.join("\n").match(/custom program error: 0x([0-9a-f]+)/i);
  return any ? { program: "", code: parseInt(any[1], 16) } : null;
}

/// A custom error code in words: the table of the program that raised it; with no program (an on-chain result has
/// only `{ Custom: n }`), pump-amm's (the program of multi_hop_swap) and then pump's. A Jupiter swap's on-chain
/// result passes JUPITER_PROGRAM: its top-level instruction is Jupiter's.
export function explainCustomError(code: number, program = ""): string | null {
  // Another program's code (a pool inside a Jupiter route: Whirlpool, Meteora…) means something else in each table; the
  // caller then shows that program's own log line.
  const text = program === PUMP_PROGRAM ? PUMP_ERRORS.get(code)
    : program === PUMP_AMM_PROGRAM ? AMM_ERRORS.get(code)
    : program === JUPITER_PROGRAM ? JUP_ERRORS.get(code)
    : program === "" ? AMM_ERRORS.get(code) ?? PUMP_ERRORS.get(code)
    : undefined;
  return text ?? OTHER[code] ?? null;
}

/// Whether a failure (simulation logs, or an on-chain `{ Custom: n }` code) is a slippage refusal: the price moved.
export function isSlippageFailure(logs: string[], code?: number | null): boolean {
  const f = failedProgram(logs);
  if (f) return f.program ? !!SLIPPAGE[f.program]?.has(f.code) : BOTH_SLIPPAGE.has(f.code);
  return code != null && BOTH_SLIPPAGE.has(code);
}

/// Turns a simulation failure into one readable sentence: the failing program's own error message when the code
/// is one of its, otherwise the last program log line.
export function explainSimulationError(err: unknown, logs: string[]): string {
  const f = failedProgram(logs);
  if (f) {
    const text = explainCustomError(f.code, f.program);
    if (text) return `${text} (${f.code})`;
  }
  if (logs.some((l) => /insufficient lamports|insufficient funds/i.test(l))) return "Insufficient SOL in the wallet for this trade";
  if (logs.some((l) => /exceeded CUs meter|computational budget exceeded/i.test(l))) return "The route ran out of compute units";
  const last = [...logs].reverse().find((l) => l.startsWith("Program log:") && !/^Program log: Instruction:/.test(l));
  return last ? last.replace(/^Program log:\s*/, "") : `Simulation failed: ${JSON.stringify(err)}`;
}
