// Spore's trading wallet: a Solana keypair made (or imported) in this browser, so a trade signs at once instead of
// opening the wallet extension for every buy and sell.
//
// The key never leaves the browser and Spore's server never sees it. It is stored only encrypted, with a password the
// user chooses (PBKDF2-SHA-256, 600,000 iterations, into an AES-GCM-256 key bound to the wallet's address, all WebCrypto),
// and decrypted only into this module's memory when the user unlocks it. It is dropped again on Lock, after an hour
// without use, and when the page goes away. Its owner can show the key (password again) to back it up or import it
// into Phantom, Solflare or Backpack.
//
// It signs only through `tradingSender()`, and only transactions it pays for itself: the quick trade's swaps
// (lib/flow.ts) and the SOL it withdraws. Nothing is exposed on `window`. Still, it is a hot wallet: whoever gets its
// key, or this browser while it is unlocked, can spend it. Keep only trading money in it.
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { decodeBase58, encodeBase58 } from "./base58";
import type { TxSender } from "./pump/send";

export const STORAGE_KEY = "spore:trading-wallet:v1";
export const KDF_ITERATIONS = 600_000;
/// A record that asks for fewer rounds than this is not one Spore wrote: refused rather than unlocked cheaply.
const KDF_MIN_ITERATIONS = 100_000;
export const MIN_PASSWORD = 8;
/// Locked again after this long without a trade, a withdrawal or an unlock.
export const AUTO_LOCK_MS = 60 * 60_000;

/// What localStorage holds: the address in clear (to show balances while locked), the secret only sealed.
export type SealedWallet = {
  v: 1; address: string; createdAt: number; backedUp: boolean;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string; data: string };
};
export type TradingWalletState = { status: "none" | "locked" | "unlocked"; address: string | null; backedUp: boolean; storage: boolean };

export class WrongPasswordError extends Error { constructor() { super("Wrong password"); this.name = "WrongPasswordError"; } }

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => { let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/// Additional data of the AES-GCM seal: the ciphertext opens only under the address it was made for.
const aad = (address: string) => enc.encode(`spore-trading-wallet:v1:${address}`);

async function deriveKey(password: string, salt: BufferSource, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function seal(kp: Keypair, password: string, { iterations = KDF_ITERATIONS, backedUp = false, now = Date.now() } = {}): Promise<SealedWallet> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const address = kp.publicKey.toBase58();
  const key = await deriveKey(password, salt, iterations);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(address) }, key, new Uint8Array(kp.secretKey)));
  return { v: 1, address, createdAt: now, backedUp, kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: b64(salt) }, cipher: { name: "AES-GCM", iv: b64(iv), data: b64(data) } };
}

function isSealed(v: unknown): v is SealedWallet {
  const s = v as SealedWallet;
  return !!s && s.v === 1 && typeof s.address === "string" && typeof s.backedUp === "boolean"
    && s.kdf?.name === "PBKDF2" && s.kdf.hash === "SHA-256" && Number.isInteger(s.kdf.iterations) && typeof s.kdf.salt === "string"
    && s.cipher?.name === "AES-GCM" && typeof s.cipher.iv === "string" && typeof s.cipher.data === "string";
}

/// The keypair inside a sealed record: WrongPasswordError when the password (or the record) does not open it.
export async function unseal(s: SealedWallet, password: string, { minIterations = KDF_MIN_ITERATIONS } = {}): Promise<Keypair> {
  if (!isSealed(s) || s.kdf.iterations < minIterations) throw new Error("The stored trading wallet is not one Spore wrote");
  const key = await deriveKey(password, unb64(s.kdf.salt), s.kdf.iterations);
  let secret: Uint8Array;
  try { secret = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.cipher.iv), additionalData: aad(s.address) }, key, unb64(s.cipher.data))); }
  catch { throw new WrongPasswordError(); }
  let kp: Keypair;
  try { kp = Keypair.fromSecretKey(secret); } catch { throw new Error("The stored trading wallet is damaged"); }
  if (kp.publicKey.toBase58() !== s.address) throw new Error("The stored trading wallet is damaged");
  return kp;
}

/// A secret key as wallets export it: base58 of the 64-byte key (Phantom, Solflare, Backpack), or the Solana CLI's JSON
/// array of 64 numbers (or of a 32-byte seed). A base58 string of 32 bytes is refused: that is what a wallet ADDRESS
/// looks like, and a "key" made from a public address is a key anyone can rebuild.
export function parseSecretKey(text: string): Keypair {
  const t = text.trim();
  if (t.startsWith("[")) {
    let arr: unknown;
    try { arr = JSON.parse(t); } catch { throw new Error("That is not a private key"); }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("That is not a private key");
    const bytes = Uint8Array.from(arr as number[]);
    try {
      if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
      if (bytes.length === 32) return Keypair.fromSeed(bytes);
    } catch { /* a 64-byte key whose halves do not match */ }
    throw new Error("That is not a private key");
  }
  let bytes: Uint8Array;
  try { bytes = decodeBase58(t); } catch { throw new Error("That is not a private key"); }
  if (bytes.length === 32) throw new Error("That looks like a wallet address, not a private key. A private key is about 88 characters long.");
  if (bytes.length === 64) { try { return Keypair.fromSecretKey(bytes); } catch { /* halves do not match */ } }
  throw new Error("That is not a private key");
}

// ---- the wallet of this browser: storage, the unlocked session, subscribers

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStore = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
let storage: Store | null = browserStore();
let session: { kp: Keypair; lastUsed: number } | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function readSealed(): SealedWallet | null {
  try { const raw = storage?.getItem(STORAGE_KEY); if (!raw) return null; const v = JSON.parse(raw); return isSealed(v) ? v : null; } catch { return null; }
}
function writeSealed(s: SealedWallet) {
  if (!storage) throw new Error("This browser blocks local storage, so it cannot keep a trading wallet");
  storage.setItem(STORAGE_KEY, JSON.stringify(s));
}
function compute(): TradingWalletState {
  const s = readSealed();
  if (!s) { session = null; return { status: "none", address: null, backedUp: false, storage: !!storage }; }
  if (session && session.kp.publicKey.toBase58() !== s.address) session = null; // replaced or removed in another tab
  return { status: session ? "unlocked" : "locked", address: s.address, backedUp: s.backedUp, storage: !!storage };
}
let snapshot: TradingWalletState = compute();
function emit() {
  snapshot = compute();
  if (!session && idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  for (const l of listeners) l();
}
export const subscribeTradingWallet = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const tradingWalletState = () => snapshot;

/// Tells the other tabs of this site that the user locked the wallet: each tab keeps its own unlocked copy in memory.
const LOCK_CHANNEL = "spore-trading-wallet";
let lockChannel: BroadcastChannel | null = null;
if (typeof window !== "undefined") {
  // created, removed or backed up in another tab
  window.addEventListener("storage", (e) => { if (e.key === STORAGE_KEY || e.key === null) emit(); });
  // a page put in the back-forward cache keeps its memory: lock rather than come back unlocked
  window.addEventListener("pagehide", () => { if (session) lockHere(); });
  // timers do not run while the machine sleeps or the tab is frozen: check the idle limit as soon as it is back
  window.addEventListener("pageshow", () => { lockIfIdle(); });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") lockIfIdle(); });
  try { attachLockChannel(typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(LOCK_CHANNEL)); } catch { lockChannel = null; }
}
function attachLockChannel(ch: BroadcastChannel | null) {
  lockChannel = ch;
  ch?.addEventListener("message", (e) => { if ((e as MessageEvent).data === "lock" && session) lockHere(); });
}

function startSession(kp: Keypair, now = Date.now()) {
  session = { kp, lastUsed: now };
  if (!idleTimer && typeof setInterval !== "undefined") {
    idleTimer = setInterval(() => lockIfIdle(), 30_000);
    (idleTimer as { unref?: () => void }).unref?.(); // Node (the tests): never what keeps the process alive
  }
  emit();
}
/// Locks this tab after AUTO_LOCK_MS without use. Returns whether it locked.
export function lockIfIdle(now = Date.now()): boolean {
  if (session && now - session.lastUsed >= AUTO_LOCK_MS) { lockHere(); return true; }
  return false;
}
function lockHere() { session = null; emit(); }
const checkPassword = (p: string) => { if (p.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters`); };

/// A new wallet for this browser, unlocked. Refused while one exists (removing it is a separate, deliberate step).
export async function createTradingWallet(password: string, opts: { iterations?: number } = {}): Promise<string> {
  if (readSealed()) throw new Error("This browser already has a trading wallet");
  checkPassword(password);
  const kp = Keypair.generate();
  writeSealed(await seal(kp, password, { iterations: opts.iterations }));
  startSession(kp);
  return kp.publicKey.toBase58();
}
/// A wallet the user already has (its exported key), unlocked; counted as backed up.
export async function importTradingWallet(secret: string, password: string, opts: { iterations?: number } = {}): Promise<string> {
  if (readSealed()) throw new Error("This browser already has a trading wallet");
  checkPassword(password);
  const kp = parseSecretKey(secret);
  writeSealed(await seal(kp, password, { iterations: opts.iterations, backedUp: true }));
  startSession(kp);
  return kp.publicKey.toBase58();
}
export async function unlockTradingWallet(password: string, opts: { minIterations?: number } = {}): Promise<void> {
  const s = readSealed();
  if (!s) throw new Error("There is no trading wallet in this browser");
  startSession(await unseal(s, password, opts));
}
/// The user's Lock: this tab and every other tab of the site that has it unlocked.
export function lockTradingWallet() {
  lockHere();
  try { lockChannel?.postMessage("lock"); } catch { /* a closed channel: this tab is locked all the same */ }
}
/// The secret key in base58 (what wallets import), after the password is entered again, unlocked or not.
export async function revealTradingSecret(password: string, opts: { minIterations?: number } = {}): Promise<string> {
  const s = readSealed();
  if (!s) throw new Error("There is no trading wallet in this browser");
  return encodeBase58((await unseal(s, password, opts)).secretKey);
}
export function markTradingWalletBackedUp() {
  const s = readSealed();
  if (!s || s.backedUp) return;
  writeSealed({ ...s, backedUp: true });
  emit();
}
/// Forgets the wallet in this browser (its funds stay on chain, reachable only with its key).
export function removeTradingWallet() {
  session = null;
  try { storage?.removeItem(STORAGE_KEY); } catch { /* blocked storage: nothing was kept */ }
  emit();
}

/// The unlocked wallet as a sender for lib/pump/send.ts sendAndConfirm (the flows' `wallet`), or null while locked.
/// It signs only transactions it pays for itself, refuses once the wallet locked, and sends them through the page's
/// connection (the server's RPC proxy).
export function tradingSender(): TxSender | null {
  // read during a render (lib/trader.ts): an idle session counts as locked here, and is locked by the timer, by the page
  // coming back, or by the send below
  if (!session || Date.now() - session.lastUsed >= AUTO_LOCK_MS) return null;
  const kp = session.kp;
  return {
    publicKey: kp.publicKey,
    sendTransaction: async (tx, conn, opts = {}) => {
      if (lockIfIdle() || !session || session.kp !== kp) throw new Error("The trading wallet is locked: unlock it to trade");
      if (!(tx instanceof VersionedTransaction)) throw new Error("The trading wallet signs only this app's own transactions");
      if (!tx.message.staticAccountKeys[0]?.equals(kp.publicKey) || tx.message.header.numRequiredSignatures !== 1) throw new Error("The trading wallet signs only transactions it pays for alone");
      tx.sign([kp]);
      session.lastUsed = Date.now();
      return conn.sendRawTransaction(tx.serialize(), { preflightCommitment: opts.preflightCommitment ?? "confirmed", maxRetries: opts.maxRetries ?? 3 });
    },
  };
}

// ---- moving SOL in and out

/// The base fee of a one-signature transfer (no priority fee: a transfer does not compete for a pool).
export const TRANSFER_FEE_LAMPORTS = 5_000n;
/// A plain SOL transfer from `from` (the only signer) to `to`.
export async function buildTransfer(conn: Connection, from: PublicKey, to: PublicKey, lamports: bigint): Promise<VersionedTransaction> {
  if (lamports <= 0n) throw new Error("Enter an amount");
  if (from.equals(to)) throw new Error("That is the same wallet");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  return new VersionedTransaction(new TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })] }).compileToV0Message());
}
/// What a withdrawal of `lamports` from a wallet holding `balance` leaves behind must be nothing (the account closes) or
/// at least the rent-exempt minimum of an empty account (`rentFloor`); the fee comes out of the balance too.
export function withdrawError(balance: bigint, lamports: bigint, rentFloor: bigint): string | null {
  if (lamports <= 0n) return "Enter an amount";
  const left = balance - lamports - TRANSFER_FEE_LAMPORTS;
  if (left < 0n) return "More than the trading wallet holds (with the 0.000005 SOL fee)";
  if (left > 0n && left < rentFloor) return "That would leave less than an account can keep: withdraw everything instead, or less";
  return null;
}
/// Everything but the fee: the wallet's account closes at zero.
export const withdrawAllLamports = (balance: bigint) => (balance > TRANSFER_FEE_LAMPORTS ? balance - TRANSFER_FEE_LAMPORTS : 0n);

/// Tests only: what a "storage" event from another tab does (the record read again, the session kept if it still matches).
export function refreshTradingWalletForTests() { emit(); }
/// Tests only: the channel a Lock is told to the other tabs on.
export function setLockChannelForTests(ch: BroadcastChannel | null) { attachLockChannel(ch); }
/// Tests only: another storage (and a fresh, locked session).
export function setTradingWalletStorageForTests(s: Store | null) { storage = s; session = null; emit(); }
