// The tab's balance store (lib/balances.ts) and what tells it of a landed trade (lib/pump/send.ts): one read per owner
// for every key watched, a lagging answer never shown over a newer one, every read at least at the owner's floor slot,
// a node behind it (-32016) tried again, a failure that keeps the value and never reads as 0, a missing token account as
// a real 0, a rate limit shown at once (not asked again), a landing already covered costing no read, the live stream's
// trades (at most one read per owner per gap, the newest held trade read at its end), the landing listeners, and no
// timer left once nothing is watched. Fakes only: no RPC, no wallet, nothing signed or sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
const B = await import("../src/lib/balances.ts");
const { confirm, sendAndConfirm, setLandedHook, OnChainError } = await import("../src/lib/pump/send.ts");
const T = B.balancesTesting;

const SPL = TOKEN_PROGRAM_ID.toBase58();
const key = () => Keypair.generate().publicKey.toBase58();
const ataOf = (owner: string, mint: string) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, TOKEN_PROGRAM_ID).toBase58();
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
/// Let the microtask flush and the fake's answers run.
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const lagError = () => Object.assign(new Error("Minimum context slot has not been reached"), { code: -32016 });

type Acct = { lamports: number; amount?: bigint };
/// A fake RPC node at `slot`: answers getMultipleAccountsInfoAndContext from `accounts`, -32016 when asked for a newer
/// slot (unless `ignoreMin`, a node that answers older anyway), and `fail` makes every call throw. `advance`: slots
/// the node moves on per call. Every call is recorded with its keys and minContextSlot.
function node(over: { slot?: number; advance?: number; ignoreMin?: boolean } = {}) {
  const st = { slot: over.slot ?? 100, advance: over.advance ?? 0, ignoreMin: over.ignoreMin ?? false, fail: null as Error | null, accounts: new Map<string, Acct>() };
  const calls: { keys: string[]; min: number | undefined; slice: unknown; commitment: unknown }[] = [];
  const conn = {
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[], cfg: { minContextSlot?: number; dataSlice?: unknown; commitment?: unknown }) => {
      calls.push({ keys: keys.map((k) => k.toBase58()), min: cfg?.minContextSlot, slice: cfg?.dataSlice, commitment: cfg?.commitment });
      const at = st.slot;
      st.slot += st.advance;
      if (st.fail) throw st.fail;
      if (!st.ignoreMin && cfg?.minContextSlot && cfg.minContextSlot > at) throw lagError();
      return {
        context: { slot: at },
        value: keys.map((k) => {
          const a = st.accounts.get(k.toBase58());
          if (!a) return null;
          return { lamports: a.lamports, owner: PublicKey.default, executable: false, rentEpoch: 0, data: a.amount != null ? u64(a.amount) : Buffer.alloc(0) };
        }),
      };
    },
  } as unknown as Connection;
  return { st, calls, conn };
}
/// A wallet with `sol` lamports and, when `amount` is given, a token account of `mint` holding it.
function wallet(n: ReturnType<typeof node>, sol: number, mint: string, amount?: bigint) {
  const owner = key();
  n.st.accounts.set(owner, { lamports: sol });
  if (amount != null) n.st.accounts.set(ataOf(owner, mint), { lamports: 2_039_280, amount });
  return owner;
}

test("several subscribers of one owner: one call for its SOL and its token account, sliced, at confirmed", async () => {
  T.reset();
  const n = node(), mint = key();
  const owner = wallet(n, 5_000_000_000, mint, 42_000_000n);
  let pings = 0;
  const offs = [T.watch(n.conn, owner, null, null, () => pings++), T.watch(n.conn, owner, null, null, () => pings++), T.watch(n.conn, owner, mint, SPL, () => pings++)];
  await settle();
  assert.equal(n.calls.length, 1, "one read");
  assert.deepEqual(n.calls[0].keys.sort(), [owner, ataOf(owner, mint)].sort());
  assert.deepEqual(n.calls[0].slice, { offset: 64, length: 8 });
  assert.equal(n.calls[0].commitment, "confirmed");
  assert.equal(n.calls[0].min, undefined, "no floor yet");
  assert.equal(T.snap(owner).value, 5_000_000_000n);
  assert.equal(T.snap(owner, mint).value, 42_000_000n);
  assert.equal(T.snap(owner, mint).hasAta, true);
  assert.ok(pings >= 3);
  // the snapshot object is kept while nothing changes (useSyncExternalStore needs it stable)
  const before = T.snap(owner);
  B.refresh(owner);
  await settle();
  assert.equal(n.calls.length, 2);
  assert.equal(n.calls[1].min, 100, "every later read asks at least the floor");
  assert.equal(T.snap(owner), before);
  offs.forEach((f) => f());
  assert.deepEqual(T.timers(), { poll: false, retries: 0, trails: 0 });
});

test("a lagging answer never replaces a newer one", async () => {
  T.reset();
  const n = node({ slot: 200, ignoreMin: true }), mint = key();
  const owner = wallet(n, 1_000, mint);
  const off = T.watch(n.conn, owner, null, null, () => {});
  await settle();
  assert.equal(T.snap(owner).value, 1_000n);
  // a node 10 slots behind answers an older balance
  n.st.slot = 190; n.st.accounts.set(owner, { lamports: 7 });
  B.refresh(owner);
  await settle();
  assert.equal(n.calls.length, 2);
  assert.equal(T.snap(owner).value, 1_000n, "the older answer is ignored");
  n.st.slot = 201;
  B.refresh(owner);
  await settle();
  assert.equal(T.snap(owner).value, 7n);
  off();
});

test("landed: the owner is read at the landing's slot, a node behind it is asked again until it caught up", async () => {
  T.reset();
  const n = node({ slot: 100, advance: 5 }), mint = key();
  const owner = wallet(n, 9_000, mint, 1n);
  const off = T.watch(n.conn, owner, mint, SPL, () => {});
  await settle();
  assert.equal(n.calls.length, 1);
  n.st.accounts.set(owner, { lamports: 4_000 });
  n.st.accounts.set(ataOf(owner, mint), { lamports: 1, amount: 500n });
  n.st.slot = 101; // the node lags: the landing is at 103
  B.landed([owner, key()], 103);
  await settle();
  assert.equal(n.calls.length, 2);
  assert.equal(n.calls[1].min, 103, "the landing's slot is the floor");
  assert.equal(T.snap(owner, mint).value, 1n, "-32016: nothing changed yet");
  assert.equal(T.snap(owner, mint).error, null, "a retry pending is no error yet");
  await settle(500);
  assert.equal(n.calls.length, 3, "tried again after about 0.4 s");
  assert.equal(n.calls[2].min, 103);
  assert.equal(T.snap(owner, mint).value, 500n);
  assert.equal(T.snap(owner, mint).error, null);
  assert.deepEqual(T.timers(), { poll: true, retries: 0, trails: 0 });
  // the same landing again (the live stream's echo), or an older one: covered, no read
  B.landed([owner], 103);
  B.landed([owner], 90);
  T.trade({ user: owner, slot: 103 });
  await settle();
  assert.equal(n.calls.length, 3);
  off();
  assert.deepEqual(T.timers(), { poll: false, retries: 0, trails: 0 });
});

test("a failed read keeps the value and never shows 0; a missing account is a real 0", async () => {
  T.reset();
  const n = node(), mint = key();
  const owner = wallet(n, 3_000, mint, 77n);
  const fresh = key(); // nothing read yet when the node starts failing
  const offs = [T.watch(n.conn, owner, mint, SPL, () => {}), T.watch(n.conn, owner, null, null, () => {})];
  await settle();
  assert.equal(T.snap(owner, mint).value, 77n);
  n.st.fail = new TypeError("fetch failed"); // the network: worth another try
  B.refresh(owner);
  const off2 = T.watch(n.conn, fresh, mint, SPL, () => {});
  // readBalancesNow gives up the same way, with nulls
  const now = B.readBalancesNow(n.conn, key(), mint, SPL);
  await settle(6_400);
  assert.equal(T.snap(owner, mint).value, 77n, "kept");
  assert.equal(T.snap(owner).value, 3_000n, "kept");
  assert.match(T.snap(owner, mint).error ?? "", /fetch failed/, "said after the tries ran out");
  assert.equal(T.snap(fresh, mint).value, null, "never read: unknown, not 0");
  assert.equal(T.snap(fresh).value, null);
  assert.deepEqual(await now, { sol: null, token: null, hasAta: false, slot: 0 });
  // 1 read + 4 tries, for each of the three
  assert.equal(n.calls.filter((c) => c.keys.includes(owner)).length, 6);
  assert.equal(n.calls.filter((c) => c.keys.includes(ataOf(fresh, mint))).length, 5);
  // a read that answers: a wallet with no token account (and an owner with no account at all) is 0
  n.st.fail = null;
  const empty = key();
  const r = await B.readBalancesNow(n.conn, empty, mint, SPL);
  assert.deepEqual(r, { sol: 0n, token: 0n, hasAta: false, slot: n.st.slot });
  const off3 = T.watch(n.conn, empty, mint, SPL, () => {});
  assert.equal(T.snap(empty, mint).value, 0n, "the fresh read fed the store");
  assert.equal(T.snap(empty, mint).hasAta, false);
  B.refresh(owner);
  await settle();
  assert.equal(T.snap(owner, mint).error, null, "a read that answers clears the error");
  offs.forEach((f) => f()); off2(); off3();
  assert.deepEqual(T.timers(), { poll: false, retries: 0, trails: 0 });
});

test("a rate limit is shown at once, not asked again (web3 already did), and readBalancesNow gives up at once", async () => {
  T.reset();
  const n = node(), mint = key();
  const owner = wallet(n, 3_000, mint, 5n);
  const off = T.watch(n.conn, owner, mint, SPL, () => {});
  await settle();
  assert.equal(n.calls.length, 1);
  n.st.fail = new Error("429 Too Many Requests: {\"error\":\"rate limited\"}");
  B.refresh(owner);
  await settle();
  assert.equal(n.calls.length, 2);
  assert.match(T.snap(owner, mint).error ?? "", /429/);
  assert.equal(T.snap(owner, mint).value, 5n, "kept");
  assert.deepEqual(T.timers(), { poll: true, retries: 0, trails: 0 });
  const t0 = Date.now();
  assert.deepEqual(await B.readBalancesNow(n.conn, owner, mint, SPL), { sol: null, token: null, hasAta: false, slot: 0 });
  assert.ok(Date.now() - t0 < 300, "no wait");
  assert.equal(n.calls.length, 3);
  // another JSON-RPC refusal is not asked again either; a node behind (-32016) is
  n.st.fail = Object.assign(new Error("invalid param"), { code: -32602 });
  B.refresh(owner);
  await settle();
  assert.equal(n.calls.length, 4);
  assert.deepEqual(T.timers(), { poll: true, retries: 0, trails: 0 });
  n.st.fail = null;
  off();
});

test("readBalancesNow asks at the floor and returns what that read said", async () => {
  T.reset();
  const n = node({ slot: 400 }), mint = key();
  const owner = wallet(n, 2_000_000_000, mint, 3_000n);
  B.landed([owner], 350);
  const r = await B.readBalancesNow(n.conn, new PublicKey(owner), mint, SPL);
  assert.deepEqual(r, { sol: 2_000_000_000n, token: 3_000n, hasAta: true, slot: 400 });
  assert.equal(n.calls.length, 1);
  assert.equal(n.calls[0].min, 350);
  assert.equal(n.calls[0].keys.length, 2);
});

test("the live stream: a watched wallet's trade with no slot reads it; others cost nothing; a burst is one read", async () => {
  T.reset();
  T.streamGap(150);
  const heard: number[] = [];
  const offL = B.subscribeLanded((_o, s) => heard.push(s));
  const n = node(), mint = key();
  const owner = wallet(n, 1, mint);
  const off = T.watch(n.conn, owner, null, null, () => {});
  await settle();
  assert.equal(n.calls.length, 1);
  T.trade({ user: owner, slot: 0 });
  await settle();
  assert.equal(n.calls.length, 2, "slot unknown: read at the floor");
  assert.equal(n.calls[1].min, 100);
  T.trade({ user: key(), slot: 999 });
  await settle();
  assert.equal(n.calls.length, 2, "a wallet nobody watches");
  // a busy wallet: its trades inside the gap are held, the newest is read once at the end (and heard then)
  n.st.slot = 150;
  T.trade({ user: owner, slot: 140 });
  T.trade({ user: owner, slot: 145 });
  T.trade({ user: owner, slot: 143 });
  await settle();
  assert.equal(n.calls.length, 2, "held");
  assert.deepEqual(heard, []);
  assert.deepEqual(T.timers(), { poll: true, retries: 0, trails: 1 });
  await settle(200);
  assert.equal(n.calls.length, 3);
  assert.equal(n.calls[2].min, 145);
  assert.deepEqual(heard, [145]);
  // after the gap a trade reads at once again
  await settle(160);
  n.st.slot = 170;
  T.trade({ user: owner, slot: 160 });
  await settle();
  assert.equal(n.calls.length, 4);
  assert.equal(n.calls[3].min, 160);
  // a held trade's timer goes with the last subscriber
  T.trade({ user: owner, slot: 175 });
  assert.deepEqual(T.timers(), { poll: true, retries: 0, trails: 1 });
  off(); offL();
  assert.deepEqual(T.timers(), { poll: false, retries: 0, trails: 0 });
});

test("landing listeners hear every owner at once, watched or not", () => {
  T.reset();
  const heard: [string, number][] = [];
  const off = B.subscribeLanded((o, s) => heard.push([o, s]));
  const a = key(), b = key();
  B.landed([a, b], 300);
  assert.deepEqual(heard, [[a, 300], [b, 300]], "synchronously, before any await");
  B.landed([a], 300);
  assert.equal(heard.length, 2, "the same landing twice is heard once");
  B.landed([a], 301);
  assert.equal(heard.length, 3);
  off();
  B.landed([a], 302);
  assert.equal(heard.length, 3);
});

test("confirm resolves with the landing slot; sendAndConfirm returns the signature and tells the hook", async () => {
  const st = { slot: 777, err: null as unknown, confirmationStatus: "confirmed" };
  const conn = {
    getSignatureStatuses: async () => ({ value: [st] }),
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1_000 }),
    getBlockHeight: async () => 0,
  } as unknown as Connection;
  assert.equal(await confirm(conn, "SIG", 1_000), 777);

  const payer = Keypair.generate().publicKey, to = Keypair.generate().publicKey;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports: 1 })] }).compileToV0Message());
  // a fake sender: it returns a signature and signs nothing
  const sender = { publicKey: payer, sendTransaction: async () => "SIG" };
  const told: [string[], number][] = [];
  setLandedHook((o, s) => told.push([o, s]));
  try {
    assert.equal(await sendAndConfirm(conn, sender, tx), "SIG");
    assert.deepEqual(told, [[[payer.toBase58(), to.toBase58(), SystemProgram.programId.toBase58()], 777]]);
    assert.equal(told[0][0][0], tx.message.staticAccountKeys[0].toBase58(), "the payer first");
    // failed on-chain: the fee was charged at that slot, so the hook hears of it too, and the error carries the slot
    st.err = { InstructionError: [0, { Custom: 6001 }] }; st.slot = 778;
    const e = await sendAndConfirm(conn, sender, tx).catch((x) => x);
    assert.ok(e instanceof OnChainError);
    assert.equal((e as InstanceType<typeof OnChainError>).slot, 778);
    assert.equal(told.length, 2);
    assert.equal(told[1][1], 778);
  } finally { setLandedHook(B.landed); }
});

test("a trade sent here: the store reads the payer at the slot it landed in", async () => {
  T.reset();
  const n = node({ slot: 900 }), mint = key();
  const payerKp = Keypair.generate(), payer = payerKp.publicKey.toBase58();
  n.st.accounts.set(payer, { lamports: 10 });
  const off = T.watch(n.conn, payer, null, null, () => {});
  await settle();
  n.st.accounts.set(payer, { lamports: 4 });
  n.st.slot = 905;
  const conn = Object.assign(Object.create(null), n.conn as object, {
    getSignatureStatuses: async () => ({ value: [{ slot: 905, err: null, confirmationStatus: "confirmed" }] }),
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1_000 }),
  }) as Connection;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payerKp.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: new PublicKey(mint), lamports: 1 })] }).compileToV0Message());
  assert.equal(await sendAndConfirm(conn, { publicKey: payerKp.publicKey, sendTransaction: async () => "SIG" }, tx), "SIG");
  await settle();
  assert.equal(n.calls.length, 2);
  assert.equal(n.calls[1].min, 905);
  assert.equal(T.snap(payer).value, 4n);
  off();
  assert.deepEqual(T.timers(), { poll: false, retries: 0, trails: 0 });
});
