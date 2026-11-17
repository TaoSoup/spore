// Sends a transaction through the wallet and confirms it by polling over HTTP: the API's RPC
// proxy has no websocket, so web3's subscription-based confirm would hang.
import { Connection, Keypair, VersionedTransaction, type Commitment, type PublicKey } from "@solana/web3.js";

/// Told of every transaction that landed (confirmed, or executed and failed: its fee was charged either way): its static
/// account keys as base58 and the slot it landed in. lib/balances.ts sets it at load, so every balance on the site reads
/// the chain again at that slot; this file never imports that store (flows and Node tests run without it).
let landedHook: ((owners: string[], slot: number) => void) | null = null;
export const setLandedHook = (f: ((owners: string[], slot: number) => void) | null) => { landedHook = f; };
const notifyLanded = (tx: VersionedTransaction, slot: number | null) => {
  if (!landedHook || !slot) return;
  try { landedHook(tx.message.staticAccountKeys.map((k) => k.toBase58()), slot); } catch { /* a listener's failure never fails the send */ }
};

/// What sends a transaction for the flows: the connected wallet (wallet-adapter's context, which opens the extension) or
/// Spore's trading wallet (lib/trading-wallet.ts, which signs at once).
export type TxSender = { publicKey: PublicKey | null; sendTransaction: (tx: VersionedTransaction, conn: Connection, opts?: { preflightCommitment?: Commitment; maxRetries?: number }) => Promise<string> };

/// `onSent` fires with the signature as soon as the wallet returned it, before confirmation, so a
/// progress line can link the explorer while the network works.
/// `explain` turns an on-chain custom error code into words (the swap passes pump-amm's and pump's tables).
export async function sendAndConfirm(conn: Connection, wallet: TxSender, tx: VersionedTransaction, extraSigners: Keypair[] = [], onSent?: (sig: string) => void, explain?: (code: number) => string | null): Promise<string> {
  if (!wallet.publicKey || !wallet.sendTransaction) throw new Error("Connect a wallet first");
  // The message was compiled with a fresh blockhash by the builder; refresh it here so a slow
  // review in the wallet does not expire it, then compute the expiry height from that hash.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  if (extraSigners.length) tx.sign(extraSigners);
  const sig = await wallet.sendTransaction(tx, conn, { preflightCommitment: "confirmed", maxRetries: 3 });
  onSent?.(sig);
  // Landed, or failed on-chain (the fee was charged): the balances hear the slot before the caller hears of the result.
  let slot: number;
  try { slot = await confirm(conn, sig, lastValidBlockHeight, explain); }
  catch (e) { if (e instanceof OnChainError) notifyLanded(tx, e.slot); throw e; }
  notifyLanded(tx, slot);
  return sig;
}

export class ExpiredError extends Error { constructor() { super("The transaction expired before it landed. Nothing was charged; please try again."); this.name = "ExpiredError"; } }
export class UnconfirmedError extends Error { sig: string; constructor(sig: string) { super(`Still not confirmed after two minutes. Check ${sig} in an explorer before retrying.`); this.name = "UnconfirmedError"; this.sig = sig; } }
/// The transaction executed and failed on-chain: `code` is the program's custom error code when there is one; `slot` the
/// slot it landed in, when the status said (its fee was charged there).
export class OnChainError extends Error {
  sig: string; code: number | null; raw: unknown; slot: number | null;
  constructor(sig: string, raw: unknown, explain?: (code: number) => string | null, slot: number | null = null) {
    const code = customCode(raw);
    const text = code != null ? explain?.(code) : null;
    super(text ? `Transaction failed on-chain: ${text} (${code}) (${sig})` : `Transaction failed on-chain: ${JSON.stringify(raw)} (${sig})`);
    this.name = "OnChainError"; this.sig = sig; this.code = code; this.raw = raw; this.slot = slot;
  }
}
/// `{ InstructionError: [i, { Custom: n }] }` → n.
const customCode = (err: unknown): number | null => {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const c = ie?.[1] as { Custom?: number } | undefined;
  return typeof c?.Custom === "number" ? c.Custom : null;
};

/// How long the status poll may keep failing (rate limits, a proxy hiccup) before it gives up: a failed status call
/// is no answer, so it never ends the wait early or reads as "expired".
const STATUS_GIVE_UP_MS = 120_000;

/// Resolves with the slot the transaction landed in (0 when the status left it out).
export async function confirm(conn: Connection, sig: string, lastValidBlockHeight: number, explain?: (code: number) => string | null): Promise<number> {
  const started = Date.now();
  for (;;) {
    let st: Awaited<ReturnType<Connection["getSignatureStatuses"]>>["value"][number] | undefined;
    let answered = false;
    try { st = (await conn.getSignatureStatuses([sig])).value[0]; answered = true; } catch { /* no answer: poll again */ }
    if (st?.err) throw new OnChainError(sig, st.err, explain, st.slot || null);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return st.slot ?? 0;
    if (answered && !st) {
      // only a status call that answered "never seen" past the blockhash's last valid height means expired
      const height = await conn.getBlockHeight("confirmed").catch(() => 0);
      if (height > lastValidBlockHeight) throw new ExpiredError();
    }
    if (Date.now() - started > STATUS_GIVE_UP_MS) throw new UnconfirmedError(sig);
    await new Promise((r) => setTimeout(r, 1_200));
  }
}

/// Has a signature landed? Used when a tab was closed or reloaded mid-flight: "confirmed" means
/// the launch is on-chain, "failed" means it executed and errored, "unknown" means not seen (yet).
export async function signatureState(conn: Connection, sig: string): Promise<"confirmed" | "failed" | "unknown"> {
  const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
  if (!st) return "unknown";
  if (st.err) return "failed";
  return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" ? "confirmed" : "unknown";
}
