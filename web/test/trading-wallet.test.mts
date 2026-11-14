// The trading wallet (lib/trading-wallet.ts): base58 keys, the password seal (PBKDF2 → AES-GCM bound to the address),
// the formats a key is imported in, one browser's wallet through create / lock / unlock / reveal / remove, the signer
// that pays only for itself and stops when locked, and what a withdrawal may leave behind. WebCrypto is Node's own;
// the KDF runs with few rounds here to keep the tests fast.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
await import("./cjs-sdk-hook.mjs");
const { encodeBase58, decodeBase58 } = await import("../src/lib/base58.ts");
const tw = await import("../src/lib/trading-wallet.ts");
const { seal, unseal, parseSecretKey, WrongPasswordError, TRANSFER_FEE_LAMPORTS } = tw;
const { signsAtOnce, INSTANT_MAX_AGE_MS } = await import("../src/lib/trader.ts");

const FAST = { iterations: 1_000 };
const OPEN = { minIterations: 1_000 };

test("base58: what PublicKey says, leading zeros kept, round trips, refuses other characters", () => {
  for (let i = 0; i < 20; i++) {
    const k = Keypair.generate();
    assert.equal(encodeBase58(k.publicKey.toBytes()), k.publicKey.toBase58());
    assert.deepEqual(decodeBase58(encodeBase58(k.secretKey)), k.secretKey);
  }
  const zeros = Uint8Array.from([0, 0, 1, 2, 3]);
  assert.equal(encodeBase58(zeros).slice(0, 2), "11");
  assert.deepEqual(decodeBase58(encodeBase58(zeros)), zeros);
  assert.equal(encodeBase58(new Uint8Array(32)), "1".repeat(32));
  assert.throws(() => decodeBase58("0OIl"), /not base58/);
});

test("seal / unseal: the password opens it, nothing else does, and the seal is bound to the address", async () => {
  const kp = Keypair.generate();
  const s = await seal(kp, "correct horse", FAST);
  assert.equal(s.address, kp.publicKey.toBase58());
  assert.ok(!JSON.stringify(s).includes(encodeBase58(kp.secretKey)), "the secret is not in the record");
  assert.deepEqual((await unseal(s, "correct horse", OPEN)).secretKey, kp.secretKey);
  await assert.rejects(unseal(s, "wrong horse", OPEN), WrongPasswordError);
  const flipped = Buffer.from(s.cipher.data, "base64"); flipped[3] ^= 1;
  await assert.rejects(unseal({ ...s, cipher: { ...s.cipher, data: flipped.toString("base64") } }, "correct horse", OPEN), WrongPasswordError, "tampered ciphertext");
  await assert.rejects(unseal({ ...s, address: Keypair.generate().publicKey.toBase58() }, "correct horse", OPEN), WrongPasswordError, "the seal does not open under another address");
  await assert.rejects(unseal(s, "correct horse"), /not one Spore wrote/, "a record with few KDF rounds is refused by default");
  const two = await seal(kp, "correct horse", FAST);
  assert.notEqual(two.kdf.salt, s.kdf.salt); assert.notEqual(two.cipher.iv, s.cipher.iv);
  assert.equal((await seal(kp, "x".repeat(8))).kdf.iterations, tw.KDF_ITERATIONS, "the default is 600,000 rounds");
});

test("parseSecretKey: Phantom's base58, the CLI's JSON array (or a seed as one); a pasted address refused; anything else refused", () => {
  const kp = Keypair.generate();
  assert.equal(parseSecretKey(encodeBase58(kp.secretKey)).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(parseSecretKey(`  ${JSON.stringify(Array.from(kp.secretKey))}\n`).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(parseSecretKey(JSON.stringify(Array.from(kp.secretKey.slice(0, 32)))).publicKey.toBase58(), kp.publicKey.toBase58(), "a seed, as a JSON array");
  // an address is 32 bytes of base58 too: a "key" made from it is one anyone can rebuild
  assert.throws(() => parseSecretKey(kp.publicKey.toBase58()), /looks like a wallet address/);
  assert.throws(() => parseSecretKey(encodeBase58(kp.secretKey.slice(0, 32))), /looks like a wallet address/);
  const mismatched = Uint8Array.from([...kp.secretKey.slice(0, 32), ...Keypair.generate().publicKey.toBytes()]);
  for (const bad of ["", "hello", encodeBase58(mismatched), "[1,2,3]", "[999]", encodeBase58(new Uint8Array(40))]) assert.throws(() => parseSecretKey(bad), /not a private key/, bad);
});

// ---- one browser's wallet

function memoryStorage() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, map: m }; }
let store = memoryStorage();
beforeEach(() => { store = memoryStorage(); tw.setTradingWalletStorageForTests(store); });

/// A connection that records what is sent.
function fakeConn() {
  const sent: Uint8Array[] = [];
  return { sent, conn: { sendRawTransaction: async (raw: Uint8Array) => { sent.push(raw); return "SIG"; }, getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }) } as unknown as Connection };
}
const txFrom = (payer: PublicKey, extraSigner?: PublicKey) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: extraSigner ?? payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message());

test("create → backup → lock → unlock → reveal → remove", async () => {
  assert.equal(tw.tradingWalletState().status, "none");
  let seen = 0;
  const off = tw.subscribeTradingWallet(() => { seen++; });
  await assert.rejects(tw.createTradingWallet("short", FAST), /at least 8/);
  const address = await tw.createTradingWallet("password-123", FAST);
  assert.deepEqual(tw.tradingWalletState(), { status: "unlocked", address, backedUp: false, storage: true });
  assert.ok(seen > 0, "subscribers hear it");
  assert.ok(!store.map.get(tw.STORAGE_KEY)!.includes("password-123"));
  await assert.rejects(tw.createTradingWallet("password-123", FAST), /already has a trading wallet/, "never overwritten");
  tw.markTradingWalletBackedUp();
  assert.equal(tw.tradingWalletState().backedUp, true);
  tw.lockTradingWallet();
  assert.equal(tw.tradingWalletState().status, "locked");
  assert.equal(tw.tradingSender(), null, "nothing signs while locked");
  await assert.rejects(tw.unlockTradingWallet("password-124", OPEN), WrongPasswordError);
  await tw.unlockTradingWallet("password-123", OPEN);
  assert.equal(tw.tradingWalletState().status, "unlocked");
  const secret = await tw.revealTradingSecret("password-123", OPEN);
  assert.equal(parseSecretKey(secret).publicKey.toBase58(), address);
  await assert.rejects(tw.revealTradingSecret("nope-nope", OPEN), WrongPasswordError, "showing the key always asks the password");
  tw.removeTradingWallet();
  assert.equal(tw.tradingWalletState().status, "none");
  assert.equal(store.map.size, 0);
  off();
});

test("import: the saved key comes back as the same wallet, counted as backed up", async () => {
  const kp = Keypair.generate();
  await assert.rejects(tw.importTradingWallet("garbage", "password-123", FAST), /not a private key/);
  assert.equal(tw.tradingWalletState().status, "none", "a refused import keeps nothing");
  const address = await tw.importTradingWallet(encodeBase58(kp.secretKey), "password-123", FAST);
  assert.equal(address, kp.publicKey.toBase58());
  assert.deepEqual(tw.tradingWalletState(), { status: "unlocked", address, backedUp: true, storage: true });
});

test("the signer: signs only what the trading wallet pays for alone, sends it, and stops when locked or idle", async () => {
  const address = await tw.createTradingWallet("password-123", FAST);
  const me = new PublicKey(address);
  const sender = tw.tradingSender()!;
  assert.equal(sender.publicKey!.toBase58(), address);
  const { conn, sent } = fakeConn();
  const tx = txFrom(me);
  assert.equal(await sender.sendTransaction(tx, conn), "SIG");
  assert.equal(sent.length, 1);
  const back = VersionedTransaction.deserialize(sent[0]);
  assert.ok(back.signatures[0].some((b) => b !== 0), "signed");
  await assert.rejects(sender.sendTransaction(txFrom(Keypair.generate().publicKey), conn), /pays for alone/, "another payer");
  await assert.rejects(sender.sendTransaction(txFrom(me, Keypair.generate().publicKey), conn), /pays for alone/, "a second signer");
  tw.lockTradingWallet();
  await assert.rejects(sender.sendTransaction(txFrom(me), conn), /locked/, "a sender kept from before the lock");
  assert.equal(sent.length, 1);
  await tw.unlockTradingWallet("password-123", OPEN);
  assert.equal(tw.lockIfIdle(Date.now() + tw.AUTO_LOCK_MS - 60_000), false);
  assert.equal(tw.lockIfIdle(Date.now() + tw.AUTO_LOCK_MS + 1), true);
  assert.equal(tw.tradingWalletState().status, "locked");
});

test("another tab: the same record read again keeps the session; a replaced or removed one ends it", async () => {
  const address = await tw.createTradingWallet("password-123", FAST);
  const kept = tw.tradingSender()!;
  // what a "storage" event does: the record read again, the session untouched
  store.map.set(tw.STORAGE_KEY, JSON.stringify({ ...JSON.parse(store.map.get(tw.STORAGE_KEY)!), backedUp: true }));
  tw.refreshTradingWalletForTests();
  assert.deepEqual(tw.tradingWalletState(), { status: "unlocked", address, backedUp: true, storage: true }, "backed up in another tab: still unlocked here");
  const other = await seal(Keypair.generate(), "password-123", FAST);
  store.map.set(tw.STORAGE_KEY, JSON.stringify(other));
  tw.refreshTradingWalletForTests();
  assert.equal(tw.tradingWalletState().status, "locked");
  assert.equal(tw.tradingWalletState().address, other.address);
  assert.equal(tw.tradingSender(), null);
  const { conn } = fakeConn();
  await assert.rejects(kept.sendTransaction(txFrom(new PublicKey(address)), conn), /locked/, "a sender kept from before refuses");
  store.map.clear();
  tw.refreshTradingWalletForTests();
  assert.equal(tw.tradingWalletState().status, "none");
});

test("Lock in one tab locks the others (a BroadcastChannel); an idle lock stays in its own tab", async () => {
  const mine = new BroadcastChannel("spore-trading-wallet-test"), theirs = new BroadcastChannel("spore-trading-wallet-test");
  const heard: unknown[] = [];
  theirs.onmessage = (e) => heard.push(e.data);
  tw.setLockChannelForTests(mine);
  try {
    await tw.createTradingWallet("password-123", FAST);
    theirs.postMessage("lock");
    for (let i = 0; i < 50 && tw.tradingWalletState().status !== "locked"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(tw.tradingWalletState().status, "locked", "another tab's Lock reaches this one");
    await tw.unlockTradingWallet("password-123", OPEN);
    tw.lockTradingWallet();
    for (let i = 0; i < 50 && !heard.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(heard, ["lock"], "this tab's Lock is told to the others");
    await tw.unlockTradingWallet("password-123", OPEN);
    assert.equal(tw.lockIfIdle(), false);
    assert.equal(tw.lockIfIdle(Date.now() + tw.AUTO_LOCK_MS + 1), true, "idle: locks this tab");
    assert.equal(tw.tradingWalletState().status, "locked");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(heard.length, 1, "unlocking and an idle lock say nothing to the others");
  } finally { tw.setLockChannelForTests(null); mine.close(); theirs.close(); tw.lockTradingWallet(); }
});

test("the idle limit holds at signing time, even when no timer ran (a sleeping machine, a frozen tab)", async () => {
  const address = await tw.createTradingWallet("password-123", FAST);
  const sender = tw.tradingSender()!;
  const { conn, sent } = fakeConn();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    mock.timers.tick(tw.AUTO_LOCK_MS + 1);
    assert.equal(tw.tradingSender(), null, "read during a render: counts as locked");
    await assert.rejects(sender.sendTransaction(txFrom(new PublicKey(address)), conn), /locked/);
    assert.equal(sent.length, 0);
    assert.equal(tw.tradingWalletState().status, "locked");
  } finally { mock.timers.reset(); }
});

test("signsAtOnce: only the trading wallet, the quote on screen while recent, within the limit, never right after a move", () => {
  const now = 1_000_000;
  const base = { trader: "trading" as const, moved: false, side: "buy" as const, amountIn: 500_000_000n, amountOut: 123n, at: now - 5_000, instantSol: 1, now };
  assert.equal(signsAtOnce(base), true);
  assert.equal(signsAtOnce({ ...base, trader: "wallet" }), false, "the extension always shows the sheet");
  assert.equal(signsAtOnce({ ...base, trader: null }), false);
  assert.equal(signsAtOnce({ ...base, moved: true }), false, "right after the price moved past the minimum");
  assert.equal(signsAtOnce({ ...base, instantSol: 0 }), false, "0 asks every time");
  assert.equal(signsAtOnce({ ...base, instantSol: Number.NaN }), false);
  assert.equal(signsAtOnce({ ...base, amountIn: 1_000_000_000n }), true, "at the limit");
  assert.equal(signsAtOnce({ ...base, amountIn: 1_000_000_001n }), false, "over it");
  assert.equal(signsAtOnce({ ...base, at: now - INSTANT_MAX_AGE_MS - 1 }), false, "a quote too old to sign from unseen");
  assert.equal(signsAtOnce({ ...base, at: now + 1 }), false, "a quote from the future is not trusted");
  assert.equal(signsAtOnce({ ...base, side: "sell", amountIn: 10n ** 15n, amountOut: 900_000_000n }), true, "a sell counts the SOL it gives");
  assert.equal(signsAtOnce({ ...base, side: "sell", amountIn: 1n, amountOut: 1_500_000_000n }), false);
});

test("withdrawals: everything (the account closes) or leave at least an account's rent; the fee comes off too", async () => {
  const floor = 650_240n;
  assert.equal(tw.withdrawAllLamports(1_000_000n), 1_000_000n - TRANSFER_FEE_LAMPORTS);
  assert.equal(tw.withdrawAllLamports(1_000n), 0n);
  assert.equal(tw.withdrawError(1_000_000n, tw.withdrawAllLamports(1_000_000n), floor), null, "all of it");
  assert.match(tw.withdrawError(1_000_000n, 1_000_000n, floor)!, /More than/);
  assert.match(tw.withdrawError(1_000_000n, 500_000n, floor)!, /less than an account can keep/);
  assert.equal(tw.withdrawError(2_000_000n, 1_000_000n, floor), null);
  assert.match(tw.withdrawError(1_000_000n, 0n, floor)!, /Enter an amount/);
  const { conn } = fakeConn();
  const a = Keypair.generate().publicKey;
  await assert.rejects(tw.buildTransfer(conn, a, a, 1n), /same wallet/);
  await assert.rejects(tw.buildTransfer(conn, a, Keypair.generate().publicKey, 0n), /Enter an amount/);
  const t = await tw.buildTransfer(conn, a, Keypair.generate().publicKey, 5n);
  assert.equal(t.message.header.numRequiredSignatures, 1);
  assert.equal(t.message.compiledInstructions.length, 1);
});
