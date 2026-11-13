// Jupiter routing for the quick trade (Nov 13 2026). A coin priced in a listed asset that has no pump SOL pool (a
// tokenized stock, HYPE, PUMP, USDC…) cannot start pump's multi_hop_swap from SOL; Jupiter's Metis router can:
// SOL → that asset (through whichever pools hold it) → the coin's curve or pool, in one transaction.
//
// The server asks Jupiter's Swap API v2 /build (server/lib/jupiter.mjs: paced under Jupiter's rate limit, SOL ↔ a
// tracked coin only) and relays the answer. The browser does not take it on faith: `checkJupBuild` accepts Jupiter's
// swap plus only the setup a SOL swap needs on the taker's own accounts, the lookup tables are read from the chain
// (never the server's copy of their contents), and the quote is a simulation of the transaction compiled here, the
// same one the wallet is asked to sign (lib/flow.ts runJupSwap). /build adds no Jupiter fee. Powered by Jupiter.
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { api, type JupBuild, type JupInstruction } from "./api";
import { compileV0, explainSimulationError, isSlippageFailure, swapFeeLamports, txBytes, CU_PRICE_MICRO, JUPITER_PROGRAM, MAX_TX_BYTES, QUOTE_CU_LIMIT, type Side } from "./pump";

export const SOL_MINT = NATIVE_MINT.toBase58();
const ATA_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const SPL_TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();

/// Mints a route chip can name without a record (Jupiter's usual middle legs); others show as a short mint.
export const KNOWN_MINTS: Record<string, string> = {
  [SOL_MINT]: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

/// Jupiter's answer was refused before anything was compiled (it does more than this swap needs), or the route does not
/// fit one transaction.
export class JupRouteError extends Error { constructor(message: string) { super(message); this.name = "JupRouteError"; } }
/// The price moved past the slippage between Jupiter's quote and the simulation of its swap (a fast coin, or a few
/// seconds in Spore's queue): asking again usually passes, a higher slippage does on a coin moving that fast.
export class JupPriceMovedError extends Error { constructor(slippageBps: number) { super(`The price moved past your ${slippageBps / 100}% slippage while Jupiter's route was checked. Asking again; a higher slippage helps on a coin moving this fast.`); this.name = "JupPriceMovedError"; } }

export type JupLeg = { label: string; inputMint: string; outputMint: string; percent: number; ammKey: string };
export type JupQuote = {
  /// What the swap delivers: the coin's base units on a buy; lamports on a sell (the rent of accounts the route opens
  /// is not output: it is counted in `rent`).
  amountOut: bigint;
  /// Jupiter's minimum for this build (its quote less `slippageBps`), enforced on-chain by its program.
  minOut: bigint;
  unitsConsumed: number;
  /// Lamports of a wrapped-SOL account the taker already had that the route closes into the wallet (0: none).
  unwrapped: bigint;
  /// Lamports the route leaves in accounts it opens: the taker's token accounts (the coin's on a first buy, an
  /// intermediate asset's on a multi-leg route) and those a venue opens inside the swap for this wallet (pump's volume
  /// tracker of a first-time buyer, a fee recipient's token account). Paid by the wallet, kept in those accounts.
  rent: bigint;
  build: JupBuild; taker: string; side: Side; amountIn: bigint; slippageBps: number;
  legs: JupLeg[];
  /// The pools the route writes (each leg's AMM), for the priority fee read.
  ammKeys: string[];
  /// Jupiter's own price-impact estimate (a fraction), or null.
  priceImpact: number | null;
};

type Expect = { taker: string; inputMint: string; outputMint: string; amount: bigint; slippageBps: number };

/// Refuses a /build answer that is not exactly the swap asked for, or that does anything else with the wallet: the swap
/// must be Jupiter's, the taker the only signer, and every other instruction one a SOL swap needs on the taker's own
/// accounts (create its token accounts, move SOL into its own wrapped-SOL account and sync it, close that account back
/// into the wallet). Compute-budget instructions are dropped later (Spore sets its own), and tips are never included.
export function checkJupBuild(b: JupBuild, e: Expect): void {
  if (!b || typeof b !== "object" || !b.swapInstruction) throw new JupRouteError("Jupiter's answer has no swap");
  if (b.inputMint !== e.inputMint || b.outputMint !== e.outputMint) throw new JupRouteError("Jupiter answered for other tokens than asked");
  if (b.swapMode && b.swapMode !== "ExactIn") throw new JupRouteError("Jupiter answered an exact-out swap");
  let inAmount: bigint, threshold: bigint;
  try { inAmount = BigInt(b.inAmount); threshold = BigInt(b.otherAmountThreshold); } catch { throw new JupRouteError("Jupiter's amounts are unreadable"); }
  if (inAmount !== e.amount) throw new JupRouteError("Jupiter answered for another amount than asked");
  if (threshold <= 0n) throw new JupRouteError("Jupiter's route has no minimum output");
  if (b.swapInstruction.programId !== JUPITER_PROGRAM) throw new JupRouteError("Jupiter's swap is not Jupiter's program");
  checkRouteArgs(b, e, inAmount, threshold);
  checkSwapAccounts(b.swapInstruction, e);
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(e.taker), true, TOKEN_PROGRAM_ID).toBase58();
  for (const ix of jupParts(b)) {
    for (const a of ix.accounts) if (a.isSigner && a.pubkey !== e.taker) throw new JupRouteError("Jupiter's route asks another signer than your wallet");
    if (ix === b.swapInstruction || ix.programId === COMPUTE_BUDGET) continue;
    const why = setupRefusal(ix, e.taker, wsol);
    if (why) throw new JupRouteError(`Jupiter's route was refused: ${why}`);
  }
  // SOL is wrapped only to pay a buy, never more than its amount; whenever SOL is a side, the route ends by closing the
  // wrapped-SOL account back into the wallet (a buy's change, a sell's proceeds).
  const wrapped = jupWrapLamports(b);
  if (wrapped > (e.inputMint === SOL_MINT ? e.amount : 0n)) throw new JupRouteError("Jupiter's route wraps more SOL than the trade needs");
  const c = b.cleanupInstruction;
  const closes = !!c && c.programId === SPL_TOKEN && c.accounts[0]?.pubkey === wsol && c.accounts[1]?.pubkey === e.taker && setupRefusal(c, e.taker, wsol) === null;
  if ((e.inputMint === SOL_MINT || e.outputMint === SOL_MINT) && !closes) throw new JupRouteError("Jupiter's route does not unwrap your SOL at the end");
  // The unwrap is the transaction's last step: whatever came after it would run unseen by the quote's simulation, which
  // stops before it (live answers carry no other instructions).
  if ((b.otherInstructions ?? []).some((i) => i.programId !== COMPUTE_BUDGET)) throw new JupRouteError("Jupiter's route adds steps after the swap");
}

/// Lamports the setup moves from the taker into its wrapped-SOL account (setupRefusal admits no other transfer).
export const jupWrapLamports = (b: JupBuild): bigint => (b.setupInstructions ?? []).filter((i) => i.programId === SYSTEM_PROGRAM).reduce((s, i) => {
  const d = bytesOf(i.data);
  return d.length === 12 ? s + new DataView(d.buffer, d.byteOffset, 12).getBigUint64(4, true) : s;
}, 0n);

/// route_v2's fixed accounts (read off live answers, Nov 2026): 0 the user's authority (the taker, signing), 1 its source
/// token account, 2 its destination token account, 3 / 4 the source and destination mints, 5 / 6 their token programs,
/// 7 the optional destination override (absent: Jupiter's own id), then the event authority, the program and the pools.
/// Source and destination must be the taker's own associated accounts of the mints asked, and nothing may redirect the
/// output. (Signer and writable flags are the message's, not an instruction's: the simulation in quoteJup is what shows
/// that the pools touch nothing else of the wallet's.)
function checkSwapAccounts(ix: JupInstruction, e: Expect) {
  const a = ix.accounts, k = (i: number) => a[i]?.pubkey;
  if (a.length < 10) throw new JupRouteError("Jupiter's swap is missing accounts");
  if (k(0) !== e.taker || !a[0].isSigner) throw new JupRouteError("Jupiter's swap is not signed by your wallet");
  if (k(3) !== e.inputMint || k(4) !== e.outputMint) throw new JupRouteError("Jupiter's swap moves other tokens than asked");
  for (const [i, mint] of [[5, e.inputMint], [6, e.outputMint]] as const) {
    const p = k(i);
    if ((p !== SPL_TOKEN && p !== TOKEN_2022) || (mint === SOL_MINT && p !== SPL_TOKEN)) throw new JupRouteError("Jupiter's swap names an unknown token program");
  }
  const ata = (mint: string, prog: string) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(e.taker), true, new PublicKey(prog)).toBase58();
  if (k(1) !== ata(e.inputMint, k(5)!) || k(2) !== ata(e.outputMint, k(6)!)) throw new JupRouteError("Jupiter's swap uses token accounts other than your own for this trade");
  if (k(7) !== JUPITER_PROGRAM) throw new JupRouteError("Jupiter's swap sends the output to another account");
}

/// Jupiter v6's `route_v2` (what /build answers with, Nov 2026): discriminator, then in_amount u64, quoted_out_amount
/// u64, slippage_bps u16, platform_fee_bps u16 (u16 since the V2 instructions, Oct 2025), then the route plan.
const ROUTE_V2 = "bb64facc31c4af14";
/// The swap's own arguments are what the program enforces, not the JSON beside them: the amount asked, no platform fee,
/// the slippage asked, and a quoted output whose minimum is the one the page shows. Another instruction kind is refused
/// (Spore reads only route_v2's arguments) rather than signed unread.
function checkRouteArgs(b: JupBuild, e: Expect, inAmount: bigint, threshold: bigint) {
  let d: Uint8Array;
  try { d = bytesOf(b.swapInstruction.data); } catch { throw new JupRouteError("Jupiter's swap data is unreadable"); }
  const hex = Array.from(d.subarray(0, 8), (x) => x.toString(16).padStart(2, "0")).join("");
  if (hex !== ROUTE_V2 || d.length < 32) throw new JupRouteError("Jupiter answered with a swap instruction Spore does not read yet");
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  const inArg = v.getBigUint64(8, true), quoted = v.getBigUint64(16, true), slip = v.getUint16(24, true), fee = v.getUint16(26, true);
  if (inArg !== e.amount || inArg !== inAmount) throw new JupRouteError("Jupiter's swap is for another amount than asked");
  if (fee !== 0) throw new JupRouteError("Jupiter's swap carries a platform fee");
  if (slip !== e.slippageBps) throw new JupRouteError("Jupiter's swap carries another slippage than asked");
  let out: bigint;
  try { out = BigInt(b.outAmount); } catch { throw new JupRouteError("Jupiter's amounts are unreadable"); }
  if (quoted !== out) throw new JupRouteError("Jupiter's swap quotes another output than its answer");
  const min = (quoted * BigInt(10_000 - slip)) / 10_000n;
  if (threshold < min || threshold > min + 1n) throw new JupRouteError("Jupiter's minimum does not match its swap");
}

/// Setup, swap, cleanup and other instructions, in the order the transaction runs them (tips left out).
function jupParts(b: JupBuild): JupInstruction[] {
  return [...(b.setupInstructions ?? []), b.swapInstruction, ...(b.cleanupInstruction ? [b.cleanupInstruction] : []), ...(b.otherInstructions ?? [])];
}

const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/// Why a non-swap instruction is not one a SOL swap needs on the taker's accounts, or null when it is.
/// Each instruction exactly as its program defines it: so many accounts, writable only where it writes. An extra
/// account (ignored by the program, but writable for the whole transaction) would hand the swap's pools something of
/// the wallet's that no check looked at.
function setupRefusal(ix: JupInstruction, taker: string, wsol: string): string | null {
  const k = (i: number) => ix.accounts[i]?.pubkey;
  const shaped = (n: number, writable: number[]) => ix.accounts.length === n && ix.accounts.every((a, i) => !a.isWritable || writable.includes(i));
  let d: Uint8Array;
  try { d = bytesOf(ix.data); } catch { return "unreadable instruction data"; }
  switch (ix.programId) {
    case ATA_PROGRAM:
      // Create (no data or 0) / CreateIdempotent (1): [payer (w), account (w), owner, mint, system, token program]
      if (d.length > 1 || (d.length === 1 && d[0] !== 0 && d[0] !== 1) || !shaped(6, [0, 1])) return "an unexpected token-account instruction";
      if (k(0) !== taker || k(2) !== taker) return "a token account for another wallet";
      if (k(4) !== SYSTEM_PROGRAM || (k(5) !== SPL_TOKEN && k(5) !== TOKEN_2022)) return "a token account of an unknown program";
      return null;
    case SYSTEM_PROGRAM:
      // Transfer (u32 2): [from (w), to (w)], only into the taker's own wrapped-SOL account
      if (d.length !== 12 || new DataView(d.buffer, d.byteOffset, 4).getUint32(0, true) !== 2 || !shaped(2, [0, 1])) return "an unexpected system instruction";
      return k(0) === taker && k(1) === wsol ? null : "a SOL transfer to another account";
    case SPL_TOKEN:
      if (d.length === 1 && d[0] === 17) return shaped(1, [0]) && k(0) === wsol ? null : "a sync of another account"; // SyncNative: [account (w)]
      // CloseAccount: [account (w), destination (w), owner]
      if (d.length === 1 && d[0] === 9) return shaped(3, [0, 1]) && k(0) === wsol && k(1) === taker && k(2) === taker ? null : "closing another account";
      return "an unexpected token instruction";
    default:
      return `a program Spore does not relay (${ix.programId.slice(0, 6)}…)`;
  }
}

const toIx = (i: JupInstruction) => new TransactionInstruction({
  programId: new PublicKey(i.programId),
  keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(bytesOf(i.data)),
});

/// The swap's instructions, Jupiter's compute-budget ones left out (Spore sets the limit and price itself). `cleanup:
/// false` leaves out the closing of the wrapped-SOL account too: the quote's simulation, which reads that account after
/// the swap (the signed transaction always closes it).
export const jupInstructions = (b: JupBuild, { cleanup = true } = {}): TransactionInstruction[] =>
  jupParts(b).filter((i) => i.programId !== COMPUTE_BUDGET && (cleanup || i !== b.cleanupInstruction)).map(toIx);

/// The token accounts the setup creates for the taker (the coin's, the wrapped-SOL one, an intermediate asset's).
export const jupCreatedAccounts = (b: JupBuild): string[] => [...new Set((b.setupInstructions ?? []).filter((i) => i.programId === ATA_PROGRAM).map((i) => i.accounts[1]?.pubkey).filter((k): k is string => !!k))];

/// The route's lookup tables as the chain holds them, cached (a table only ever grows, so entries read once stay
/// right); a table the cache holds fewer entries of than the answer lists is read again. The server's copy of their
/// contents is not used: a wrong one would compile the swap against accounts nobody checked.
const TABLES_MAX = 64;
const tableCache = new Map<string, AddressLookupTableAccount>();
export async function jupTables(conn: Connection, b: JupBuild): Promise<AddressLookupTableAccount[]> {
  const want = Object.entries(b.addressesByLookupTableAddress ?? {});
  // the cached ones this answer needs are held here before any await: another call may evict them meanwhile
  const have = new Map(want.map(([key]) => [key, tableCache.get(key)] as const));
  const miss = want.filter(([key, addrs]) => (have.get(key)?.state.addresses.length ?? -1) < addrs.length).map(([key]) => key);
  if (miss.length) {
    const infos = await conn.getMultipleAccountsInfo(miss.map((key) => new PublicKey(key)), "confirmed");
    infos.forEach((a, i) => {
      if (!a || !a.owner.equals(AddressLookupTableProgram.programId)) return;
      have.set(miss[i], new AddressLookupTableAccount({ key: new PublicKey(miss[i]), state: AddressLookupTableAccount.deserialize(a.data) }));
    });
  }
  // this answer's tables become the newest (least recently used go first), and are taken before anything is evicted
  const out = want.map(([key]) => have.get(key)).filter((t): t is AddressLookupTableAccount => !!t);
  for (const t of out) { const k = t.key.toBase58(); tableCache.delete(k); tableCache.set(k, t); }
  while (tableCache.size > TABLES_MAX) tableCache.delete(tableCache.keys().next().value!);
  return out.filter((t) => t.isActive());
}

/// The swap as one v0 transaction: Spore's compute limit and priority fee, then Jupiter's checked instructions
/// (`cleanup: false`: without the closing of the wrapped-SOL account, for the quote's simulation only).
export function compileJup(payer: PublicKey, blockhash: string, b: JupBuild, tables: AddressLookupTableAccount[], units: number, microLamports: number, { cleanup = true } = {}): VersionedTransaction {
  const tx = compileV0(payer, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...jupInstructions(b, { cleanup })], tables);
  const n = txBytes(tx);
  if (n === null || n > MAX_TX_BYTES) throw new JupRouteError(`Jupiter's route is too large for one transaction (${n ?? ">1232"} bytes)`);
  return tx;
}

/// The mints a route passes, input first, each placed after every mint that feeds it (a split route's legs can come in
/// any order): SOL → USDC → HYPE → coin.
export function jupPath(legs: Pick<JupLeg, "inputMint" | "outputMint">[]): string[] {
  if (!legs.length) return [];
  const depth = new Map<string, number>([[legs[0].inputMint, 0]]);
  for (let round = 0; round < legs.length; round++) {
    for (const l of legs) {
      const d = depth.get(l.inputMint);
      if (d != null && (depth.get(l.outputMint) ?? -1) < d + 1) depth.set(l.outputMint, d + 1);
    }
  }
  return [...depth.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
}

export const jupLegs = (b: JupBuild): JupLeg[] => (b.routePlan ?? []).map((l) => ({
  label: l.swapInfo.label || "AMM", inputMint: l.swapInfo.inputMint, outputMint: l.swapInfo.outputMint, ammKey: l.swapInfo.ammKey,
  percent: l.percent ?? (l.bps != null ? l.bps / 100 : 100),
}));

type SimAccount = { lamports: number; data: string[] } | null;
type PreAccount = { lamports: number; data: Uint8Array; owner: PublicKey } | null;
const lamportsOf = (a: { lamports: number } | null | undefined) => BigInt(a?.lamports ?? 0);
const tokenAmount = (d: Uint8Array | null | undefined) => (d && d.length >= 72 ? new DataView(d.buffer, d.byteOffset + 64, 8).getBigUint64(0, true) : 0n);
/// The token account's owner (offset 32), or null for anything that is not an SPL / Token-2022 account.
const tokenOwner = (a: PreAccount) => (a && (a.owner.toBase58() === SPL_TOKEN || a.owner.toBase58() === TOKEN_2022) && a.data.length >= 64 ? new PublicKey(a.data.subarray(32, 64)).toBase58() : null);
/// A native (wrapped-SOL) token account's rent reserve: `is_native`, a COption<u64> at offset 109; null for any other.
const nativeReserve = (a: SimAccount | undefined) => {
  if (!a) return null;
  const d = bytesOf(a.data[0]);
  if (d.length < 121) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  return v.getUint32(109, true) === 1 ? v.getBigUint64(113, true) : null;
};
/// Not opened yet: no account, or one holding only plain SOL someone sent to the address (the System program's, no data).
const blank = (a: PreAccount | undefined) => !a || (a.owner.toBase58() === SYSTEM_PROGRAM && a.data.length === 0);
/// The server's RPC proxy reads at most 32 accounts per call.
const READ_CHUNK = 32;
/// Accounts as the chain holds them, only their first 72 bytes (a token account's mint, owner and amount).
async function readHeads(conn: Connection, keys: string[]): Promise<PreAccount[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += READ_CHUNK) chunks.push(keys.slice(i, i + READ_CHUNK));
  const got = await Promise.all(chunks.map((c) => conn.getMultipleAccountsInfo(c.map((k) => new PublicKey(k)), { commitment: "confirmed", dataSlice: { offset: 0, length: 72 } })));
  return got.flat().map((a) => (a ? { lamports: a.lamports, data: new Uint8Array(a.data), owner: a.owner } : null));
}

/// A quote for buying `coin` with `amountIn` lamports, or selling `amountIn` of its base units for SOL, through Jupiter:
/// /build for `taker` (the wallet, or the public probe before one connects), the checks above, then a simulation of the
/// compiled swap without its final unwrap, so every balance after it is exact. The simulation must show the swap and
/// nothing else of the wallet's moving:
/// - the wallet's own SOL pays the fee, the rent of the accounts the route opens and the wrap (at most the amount), no more;
/// - the wrap and the wrapped-SOL balance together give the swap at most the amount (a buy);
/// - no other token account of the wallet's goes down (the coin's by at most the amount on a sell), and none the swap
///   could write to is refused unread: a writable one of the wallet's that the route did not set up is refused;
/// - the output reaches the wallet's own account and is at least Jupiter's minimum.
/// It gives the output, the rent the route leaves in accounts it opens and any wrapped SOL the signed transaction's
/// closing returns. `signal` drops a quote the widget no longer wants (the server then skips it if it has not asked yet).
export async function quoteJup(conn: Connection, taker: PublicKey, coin: { mint: string; tokenProgram: string }, side: Side, amountIn: bigint, slippageBps: number, signal?: AbortSignal): Promise<JupQuote> {
  if (amountIn <= 0n) throw new Error("Enter an amount");
  const who = taker.toBase58();
  const inputMint = side === "buy" ? SOL_MINT : coin.mint, outputMint = side === "buy" ? coin.mint : SOL_MINT;
  const build = await api.jupBuild({ inputMint, outputMint, amount: amountIn.toString(), taker: who, slippageBps }, signal);
  checkJupBuild(build, { taker: who, inputMint, outputMint, amount: amountIn, slippageBps });
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, taker, true, TOKEN_PROGRAM_ID).toBase58();
  const coinAta = getAssociatedTokenAddressSync(new PublicKey(coin.mint), taker, true, new PublicKey(coin.tokenProgram)).toBase58();
  const swapAccounts = build.swapInstruction.accounts;
  if (swapAccounts[side === "buy" ? 2 : 1]?.pubkey !== coinAta) throw new JupRouteError("Jupiter's swap uses another account for this coin than your wallet's");
  // the wallet's token accounts the route may change: the coin's and those its setup opens (intermediate assets)
  const mine = [...new Set([coinAta, ...jupCreatedAccounts(build).filter((k) => k !== wsol)])];
  const watch = [...new Set([who, wsol, ...mine])];
  // every other account the transaction can write to (writability is the whole message's: any instruction marking an
  // account writable makes it writable for the swap's pools too), read for its owner. One of the wallet's own token
  // accounts the setup does not name (an asset it already holds) is watched like the others: it may not go down or
  // close. One not opened yet is an account a venue opens inside the swap (pump's volume tracker of a first-time buyer, a
  // fee recipient's token account): its rent is the wallet's, counted below.
  const writable = new Set(jupParts(build).flatMap((i) => i.accounts.filter((a) => a.isWritable).map((a) => a.pubkey)));
  const others = [...writable].filter((k) => !watch.includes(k));
  const [heads, { blockhash }, tables] = await Promise.all([readHeads(conn, [...watch, ...others]), conn.getLatestBlockhash("confirmed"), jupTables(conn, build)]);
  const pre = new Map([...watch, ...others].map((k, i) => [k, heads[i]] as const));
  const owned = others.filter((k) => tokenOwner(pre.get(k) ?? null) === who);
  const fresh = others.filter((k) => blank(pre.get(k)));
  const simulated = [...watch, ...owned, ...fresh];
  const tx = compileJup(taker, blockhash, build, tables, QUOTE_CU_LIMIT, CU_PRICE_MICRO, { cleanup: false });
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: simulated } });
  const logs = sim.value.logs ?? [];
  if (sim.value.err) throw isSlippageFailure(logs) ? new JupPriceMovedError(slippageBps) : new Error(explainSimulationError(sim.value.err, logs));
  const postList = (sim.value.accounts ?? []) as SimAccount[];
  const post = new Map(simulated.map((k, i) => [k, postList[i] ?? null] as const));
  const preTok = (k: string) => tokenAmount(pre.get(k)?.data);
  const postTok = (k: string) => { const p = post.get(k); return p ? tokenAmount(bytesOf(p.data[0])) : 0n; };
  for (const k of mine) {
    const drop = preTok(k) - postTok(k);
    if (side === "sell" && k === coinAta) { if (drop > amountIn) throw new JupRouteError("Jupiter's route sells more of the coin than the amount"); }
    else if (drop > 0n) throw new JupRouteError("Jupiter's route takes from one of your token accounts");
  }
  for (const k of owned) {
    const p = post.get(k);
    if (!p || lamportsOf(p) < lamportsOf(pre.get(k)) || postTok(k) < preTok(k)) throw new JupRouteError("Jupiter's route takes from one of your token accounts");
  }
  // Rent: what accounts opened by the route hold after it. A wrapped-SOL account's is its own rent reserve (the SOL above
  // it is wrapped SOL, even unsynced); an account a venue opened counts at most the rent its size needs, at the rate the
  // wrapped-SOL account's reserve shows (165 bytes + 128 of overhead), so no SOL parks there unseen.
  const wsolReserve = nativeReserve(post.get(wsol));
  const perByte = wsolReserve != null ? wsolReserve / 293n : 6_960n;
  // (An address that already held plain SOL is opened all the same: the wallet pays only the rest of the rent.)
  const gained = (k: string, held: bigint) => { const g = held - lamportsOf(pre.get(k)); return g > 0n ? g : 0n; };
  const opened = (k: string) => {
    const p = post.get(k);
    if (!blank(pre.get(k)) || !p) return 0n;
    return gained(k, k === wsol ? wsolReserve ?? lamportsOf(p) - postTok(k) : lamportsOf(p));
  };
  const venueRent = fresh.reduce((s, k) => {
    const p = post.get(k);
    if (!p) return s;
    const cap = (128n + BigInt(bytesOf(p.data[0]).length)) * perByte;
    return s + gained(k, lamportsOf(p) < cap ? lamportsOf(p) : cap);
  }, 0n);
  const rentAll = [wsol, ...mine].reduce((s, k) => s + opened(k), 0n);
  const wrap = jupWrapLamports(build);
  const spent = lamportsOf(pre.get(who)) - lamportsOf(post.get(who));
  if (spent > swapFeeLamports(QUOTE_CU_LIMIT, CU_PRICE_MICRO) + rentAll + venueRent + wrap) throw new JupRouteError("Jupiter's route spends more of your SOL than the amount, the fee and the rent");
  const wsolDelta = postTok(wsol) - preTok(wsol);
  let amountOut: bigint;
  if (side === "buy") {
    if (wrap - wsolDelta > amountIn) throw new JupRouteError("Jupiter's route spends more SOL than the amount");
    amountOut = postTok(coinAta) - preTok(coinAta);
  } else amountOut = wsolDelta;
  const minOut = BigInt(build.otherAmountThreshold);
  if (amountOut <= 0n) throw new Error("The route returned nothing for that amount");
  if (amountOut < minOut) throw new JupRouteError("Jupiter's route delivers less than its own minimum to your wallet");
  // The signed transaction closes the wrapped-SOL account into the wallet: a balance it held before comes back as SOL.
  const unwrapped = pre.get(wsol) ? lamportsOf(pre.get(wsol)) : 0n;
  const legs = jupLegs(build);
  const impact = Number(build.priceImpactPct);
  return {
    amountOut, minOut, unitsConsumed: sim.value.unitsConsumed ?? 0, unwrapped, rent: rentAll - opened(wsol) + venueRent,
    build, taker: who, side, amountIn, slippageBps, legs, ammKeys: [...new Set(legs.map((l) => l.ammKey).filter(Boolean))],
    priceImpact: Number.isFinite(impact) ? impact : null,
  };
}

/// The transaction the wallet signs: the quoted build compiled again for that wallet with a fresh blockhash and the
/// compute limit and priority fee the widget showed. The build is checked again (it may have been held a while).
export async function buildJupTx(conn: Connection, user: PublicKey, q: JupQuote, opts: { units: number; microLamports: number }): Promise<VersionedTransaction> {
  const who = user.toBase58();
  if (q.taker !== who) throw new Error("This quote was made for another wallet; refresh it");
  checkJupBuild(q.build, { taker: who, inputMint: q.build.inputMint, outputMint: q.build.outputMint, amount: q.amountIn, slippageBps: q.slippageBps });
  const [{ blockhash }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), jupTables(conn, q.build)]);
  return compileJup(user, blockhash, q.build, tables, opts.units, opts.microLamports);
}

// ---- server status, shared by every route check on the page

let status: { until: number; p: Promise<boolean> } | null = null;
/// Whether the server routes through Jupiter: cached 10 min; an unanswered check counts as off for a minute.
export function jupiterEnabled(): Promise<boolean> {
  if (status && Date.now() < status.until) return status.p;
  const mine: { until: number; p: Promise<boolean> } = { until: Date.now() + 10 * 60_000, p: Promise.resolve(false) };
  mine.p = api.jupStatus().then((r) => !!r?.enabled).catch(() => { mine.until = Date.now() + 60_000; return false; });
  status = mine;
  return mine.p;
}
