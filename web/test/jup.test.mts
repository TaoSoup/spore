// The quick trade's Jupiter route (lib/jup.ts): which coins take it, the checks every /build answer passes before
// anything is compiled (route_v2's arguments and fixed accounts, the wallet as the only signer, setup only on the wallet's
// own accounts, the wrap and the unwrap), the lookup tables read from the chain, the quote read from a simulation of the
// swap without its unwrap (output, rent of the accounts the route opens, wrapped SOL it returns) and what that simulation
// must not show (the wallet's SOL or other tokens moving), and a slippage refusal before the wallet opens. No network:
// fetch and the RPC are fakes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction, ComputeBudgetProgram, type Connection } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Coin, JupBuild, JupInstruction } from "../src/lib/api.ts";
await import("./cjs-sdk-hook.mjs");
const { checkJupBuild, compileJup, jupCreatedAccounts, jupInstructions, jupPath, jupTables, jupWrapLamports, quoteJup, JupRouteError, SOL_MINT } = await import("../src/lib/jup.ts");
const { routeOf, blockText, hardBlock } = await import("../src/lib/trade-route.ts");
const { explainCustomError, isSlippageFailure, swapFeeLamports, CU_PRICE_MICRO, QUOTE_CU_LIMIT, JUPITER_PROGRAM, TOKEN_2022_ID } = await import("../src/lib/pump/trade.ts");
const { runJupSwap, PriceMovedError } = await import("../src/lib/flow.ts");

const key = () => Keypair.generate().publicKey;
const JUP = new PublicKey(JUPITER_PROGRAM);
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const EVENT_AUTHORITY = new PublicKey("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const HYPE = key().toBase58();
const T22 = TOKEN_2022_PROGRAM_ID;
const SPL = TOKEN_PROGRAM_ID;

/// Jupiter v6 route_v2 data: discriminator, in_amount, quoted_out_amount, slippage_bps, platform_fee_bps, an empty plan.
function routeV2(inAmount: bigint, quoted: bigint, slip = 100, fee = 0, disc = "bb64facc31c4af14") {
  const d = Buffer.alloc(32); Buffer.from(disc, "hex").copy(d, 0);
  d.writeBigUInt64LE(inAmount, 8); d.writeBigUInt64LE(quoted, 16); d.writeUInt16LE(slip, 24); d.writeUInt16LE(fee, 26); d.writeUInt32LE(0, 28);
  return d;
}
const withData = (b: JupBuild, data: Buffer): JupBuild => ({ ...b, swapInstruction: { ...b.swapInstruction, data: data.toString("base64") } });
const withSwapAccount = (b: JupBuild, i: number, pubkey: string): JupBuild => ({ ...b, swapInstruction: { ...b.swapInstruction, accounts: b.swapInstruction.accounts.map((a, n) => (n === i ? { ...a, pubkey } : a)) } });
const toJ = (ix: TransactionInstruction): JupInstruction => ({ programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString("base64") });
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isSigner, isWritable });

/// A /build answer as Jupiter gives it for `taker` (route_v2's fixed accounts as live answers carry them): wrap SOL into
/// its WSOL account on a buy, open the WSOL, coin and intermediate asset accounts, the swap through a pool and pump,
/// unwrap at the end. `pools`: more accounts for the swap (a test adds one of the wallet's own token accounts).
function build(taker: PublicKey, coinMint: PublicKey, side: "buy" | "sell", amount: bigint, over: Partial<JupBuild> = {}, pools: PublicKey[] = []): JupBuild {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, taker, true, SPL);
  const coinAta = getAssociatedTokenAddressSync(coinMint, taker, true, T22);
  const midAta = getAssociatedTokenAddressSync(new PublicKey(HYPE), taker, true, T22);
  const setup = [
    createAssociatedTokenAccountIdempotentInstruction(taker, wsol, taker, NATIVE_MINT, SPL),
    ...(side === "buy" ? [SystemProgram.transfer({ fromPubkey: taker, toPubkey: wsol, lamports: amount }), createSyncNativeInstruction(wsol), createAssociatedTokenAccountIdempotentInstruction(taker, coinAta, taker, coinMint, T22)] : []),
    createAssociatedTokenAccountIdempotentInstruction(taker, midAta, taker, new PublicKey(HYPE), T22),
  ];
  const [src, dst, srcMint, dstMint, srcProg, dstProg] = side === "buy" ? [wsol, coinAta, NATIVE_MINT, coinMint, SPL, T22] : [coinAta, wsol, coinMint, NATIVE_MINT, T22, SPL];
  const swap = new TransactionInstruction({ programId: JUP, data: routeV2(amount, 1000n), keys: [
    meta(taker, false, true), meta(src, true), meta(dst, true), meta(srcMint), meta(dstMint), meta(srcProg), meta(dstProg), meta(JUP), meta(EVENT_AUTHORITY), meta(JUP),
    meta(key(), true), meta(midAta, true), meta(PUMP), ...pools.map((p) => meta(p, true)),
  ] });
  const [inputMint, outputMint] = side === "buy" ? [SOL_MINT, coinMint.toBase58()] : [coinMint.toBase58(), SOL_MINT];
  return {
    inputMint, outputMint, inAmount: amount.toString(), outAmount: "1000", otherAmountThreshold: "990", swapMode: "ExactIn", slippageBps: 100, priceImpactPct: "0.012",
    routePlan: side === "buy"
      ? [{ percent: 100, swapInfo: { ammKey: key().toBase58(), label: "Meteora DLMM", inputMint: SOL_MINT, outputMint: HYPE } }, { percent: 100, swapInfo: { ammKey: key().toBase58(), label: "Pump.fun", inputMint: HYPE, outputMint: coinMint.toBase58() } }]
      : [{ percent: 100, swapInfo: { ammKey: key().toBase58(), label: "Pump.fun", inputMint: coinMint.toBase58(), outputMint: HYPE } }, { percent: 100, swapInfo: { ammKey: key().toBase58(), label: "Meteora DLMM", inputMint: HYPE, outputMint: SOL_MINT } }],
    computeBudgetInstructions: [toJ(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }))],
    setupInstructions: setup.map(toJ), swapInstruction: toJ(swap), cleanupInstruction: toJ(createCloseAccountInstruction(wsol, taker, taker)), otherInstructions: [],
    addressesByLookupTableAddress: {}, ...over,
  };
}
const expectOf = (b: JupBuild, taker: PublicKey) => ({ taker: taker.toBase58(), inputMint: b.inputMint, outputMint: b.outputMint, amount: BigInt(b.inAmount), slippageBps: 100 });

test("checkJupBuild: Jupiter's swap with the wallet's own setup passes", () => {
  const taker = key(), mint = key();
  for (const side of ["buy", "sell"] as const) { const b = build(taker, mint, side, 10_000_000n); assert.doesNotThrow(() => checkJupBuild(b, expectOf(b, taker))); }
});

test("checkJupBuild: refuses anything beyond the swap asked for", () => {
  const taker = key(), mint = key(), other = key();
  const b = build(taker, mint, "buy", 10_000_000n);
  const e = expectOf(b, taker);
  const refuse = (x: JupBuild, msg: RegExp, ex = e) => assert.throws(() => checkJupBuild(x, ex), (err: Error) => err instanceof JupRouteError && msg.test(err.message));
  refuse(b, /another amount/, { ...e, amount: 1n });
  // the swap's own arguments, which the program enforces, against what was asked and what the page shows
  refuse(withData(b, routeV2(10_000_000n, 1000n, 100, 30)), /platform fee/);
  refuse(withData(b, routeV2(10_000_000n, 1000n, 5000)), /another slippage/);
  refuse(withData(b, routeV2(9_000_000n, 1000n)), /another amount/);
  refuse(withData(b, routeV2(10_000_000n, 999n)), /another output/);
  refuse({ ...b, otherAmountThreshold: "900" }, /minimum does not match/);
  refuse(withData(b, routeV2(10_000_000n, 1000n, 100, 0, "e517cb977ae3ad2a")), /does not read yet/);
  refuse(b, /another slippage/, { ...e, slippageBps: 50 });
  refuse(b, /other tokens/, { ...e, outputMint: other.toBase58() });
  refuse({ ...b, swapMode: "ExactOut" }, /exact-out/);
  refuse({ ...b, otherAmountThreshold: "0" }, /no minimum/);
  refuse({ ...b, swapInstruction: { ...b.swapInstruction, programId: other.toBase58() } }, /not Jupiter's program/);
  const signer = { ...b.swapInstruction, accounts: [...b.swapInstruction.accounts, { pubkey: other.toBase58(), isSigner: true, isWritable: false }] };
  refuse({ ...b, swapInstruction: signer }, /another signer/);
  // route_v2's fixed accounts: the wallet's own source and destination, the mints asked, no output redirect
  refuse(withSwapAccount(b, 1, getAssociatedTokenAddressSync(NATIVE_MINT, other, true).toBase58()), /other than your own/);
  refuse(withSwapAccount(b, 2, getAssociatedTokenAddressSync(mint, other, true, T22).toBase58()), /other than your own/);
  refuse(withSwapAccount(b, 4, other.toBase58()), /other tokens/);
  refuse(withSwapAccount(b, 6, other.toBase58()), /unknown token program/);
  refuse(withSwapAccount(b, 7, getAssociatedTokenAddressSync(mint, other, true, T22).toBase58()), /output to another account/);
  refuse(withSwapAccount(b, 0, other.toBase58()), /another signer|not signed by your wallet/);
  // setup and cleanup
  refuse({ ...b, setupInstructions: [...b.setupInstructions!, toJ(SystemProgram.transfer({ fromPubkey: taker, toPubkey: other, lamports: 5n }))] }, /SOL transfer to another account/);
  refuse({ ...b, setupInstructions: [toJ(createAssociatedTokenAccountIdempotentInstruction(taker, getAssociatedTokenAddressSync(mint, other, true, T22), other, mint, T22))] }, /another wallet/);
  refuse({ ...b, cleanupInstruction: toJ(createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, taker, true), other, taker)) }, /closing another account/);
  refuse({ ...b, otherInstructions: [toJ(new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("x") }))] }, /does not relay/);
  refuse({ ...b, setupInstructions: [toJ(SystemProgram.assign({ accountPubkey: taker, programId: other }))] }, /unexpected system instruction/);
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, taker, true);
  refuse({ ...b, setupInstructions: [...b.setupInstructions!, toJ(SystemProgram.transfer({ fromPubkey: taker, toPubkey: wsol, lamports: 1n }))] }, /wraps more SOL/);
  refuse({ ...b, cleanupInstruction: null }, /does not unwrap/);
  // an extra writable account on a setup step (ignored by its program, writable for the whole transaction)
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC), taker, true).toBase58();
  const sync = b.setupInstructions!.findIndex((i) => i.programId === SPL.toBase58());
  const smuggled = b.setupInstructions!.map((i, n) => (n === sync ? { ...i, accounts: [...i.accounts, { pubkey: usdcAta, isSigner: false, isWritable: true }] } : i));
  refuse({ ...b, setupInstructions: smuggled }, /a sync of another account/);
  const ata = b.setupInstructions![0];
  refuse({ ...b, setupInstructions: [{ ...ata, accounts: ata.accounts.map((a, n) => (n === 3 ? { ...a, isWritable: true } : a)) }, ...b.setupInstructions!.slice(1)] }, /unexpected token-account instruction/);
  // a SOL transfer after the unwrap (it would run unseen by the quote's simulation)
  refuse({ ...b, otherInstructions: [toJ(SystemProgram.transfer({ fromPubkey: taker, toPubkey: wsol, lamports: 1n }))] }, /adds steps after the swap/);
  const s = build(taker, mint, "sell", 1_000n);
  refuse({ ...s, setupInstructions: [...s.setupInstructions!, toJ(SystemProgram.transfer({ fromPubkey: taker, toPubkey: wsol, lamports: 1n }))] }, /wraps more SOL/, expectOf(s, taker));
  assert.equal(jupWrapLamports(b), 10_000_000n);
});

test("jupInstructions drop Jupiter's compute budget and tips (and the unwrap for the quote); created accounts are the setup's", () => {
  const taker = key(), mint = key();
  const b = build(taker, mint, "buy", 5n, { tipInstruction: toJ(SystemProgram.transfer({ fromPubkey: taker, toPubkey: key(), lamports: 1n })), otherInstructions: [toJ(ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }))] });
  const ixs = jupInstructions(b);
  assert.equal(ixs.length, b.setupInstructions!.length + 2, "setup, swap, cleanup");
  assert.equal(jupInstructions(b, { cleanup: false }).length, b.setupInstructions!.length + 1);
  assert.ok(ixs.every((i) => !i.programId.equals(ComputeBudgetProgram.programId)));
  assert.equal(jupCreatedAccounts(b).length, 3, "WSOL, the coin's, the intermediate asset's");
  const tx = compileJup(taker, key().toBase58(), b, [], 300_000, 50_000);
  assert.ok(tx.serialize().length <= 1232);
  assert.equal(tx.message.header.numRequiredSignatures, 1, "the wallet signs alone");
  const fat = { ...b, swapInstruction: { ...b.swapInstruction, accounts: [...b.swapInstruction.accounts, ...Array.from({ length: 40 }, () => ({ pubkey: key().toBase58(), isSigner: false, isWritable: false }))] } };
  assert.throws(() => compileJup(taker, key().toBase58(), fat, [], 300_000, 50_000), /too large/);
});

test("jupPath: each mint after every mint that feeds it, whatever order the split legs come in", () => {
  const coin = key().toBase58();
  assert.deepEqual(jupPath([{ inputMint: SOL_MINT, outputMint: HYPE }, { inputMint: HYPE, outputMint: coin }]), [SOL_MINT, HYPE, coin]);
  assert.deepEqual(jupPath([{ inputMint: SOL_MINT, outputMint: HYPE }, { inputMint: SOL_MINT, outputMint: USDC }, { inputMint: USDC, outputMint: HYPE }, { inputMint: HYPE, outputMint: coin }]), [SOL_MINT, USDC, HYPE, coin]);
  assert.deepEqual(jupPath([]), []);
});

// ---- a fake chain

type Acc = { lamports: number; data?: Uint8Array; owner?: PublicKey } | null;
/// A token account's bytes: mint, owner, amount (what the quote reads).
const tokenData = (amount: bigint, owner?: PublicKey, mint?: PublicKey) => { const d = new Uint8Array(170); if (mint) d.set(mint.toBytes(), 0); if (owner) d.set(owner.toBytes(), 32); new DataView(d.buffer).setBigUint64(64, amount, true); return d; };
const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");
/// A wrapped-SOL account's bytes: its amount and `is_native` = Some(rent reserve) at offset 109.
const nativeData = (amount: bigint, owner: PublicKey, reserve: bigint) => { const d = tokenData(amount, owner, NATIVE_MINT); const v = new DataView(d.buffer); v.setUint32(109, 1, true); v.setBigUint64(113, reserve, true); return d; };
const ALT_PROGRAM = new PublicKey("AddressLookupTab1e1111111111111111111111111");
const altData = (addrs: PublicKey[]) => { const b = Buffer.alloc(56 + 32 * addrs.length); b.writeUInt32LE(1, 0); b.writeBigUInt64LE(2n ** 64n - 1n, 4); addrs.forEach((a, i) => a.toBuffer().copy(b, 56 + 32 * i)); return b; };

function fakeConn(pre: Map<string, Acc>, post: Map<string, Acc>, sim: { err?: unknown; logs?: string[] } = {}) {
  const calls = { simulated: [] as VersionedTransaction[], reads: [] as string[][], configs: [] as unknown[] };
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[], cfg: unknown) => {
      calls.reads.push(keys.map((k) => k.toBase58())); calls.configs.push(cfg);
      return keys.map((k) => { const a = pre.get(k.toBase58()); return a ? { lamports: a.lamports, data: Buffer.from(a.data ?? new Uint8Array()), owner: a.owner ?? SPL, executable: false } : null; });
    },
    getLatestBlockhash: async () => ({ blockhash: key().toBase58(), lastValidBlockHeight: 100 }),
    getBalance: async (k: PublicKey) => pre.get(k.toBase58())?.lamports ?? 0,
    simulateTransaction: async (tx: VersionedTransaction, opts: { accounts: { addresses: string[] } }) => {
      calls.simulated.push(tx);
      return { value: { err: sim.err ?? null, logs: sim.logs ?? [], unitsConsumed: 210_000, accounts: opts.accounts.addresses.map((a) => { const p = post.get(a); return p ? { lamports: p.lamports, data: [b64(p.data ?? new Uint8Array()), "base64"], owner: SPL.toBase58(), executable: false, rentEpoch: 0 } : null; }) } };
    },
  };
  return { conn: conn as unknown as Connection, calls };
}
let fetched: string[] = [];
let answer: unknown = null;
beforeEach(() => {
  fetched = [];
  globalThis.fetch = (async (url: string) => { fetched.push(url); return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
});

const RENT = 1_513_840; // a Token-2022 account at 5,080 lamports a byte (mainnet, Nov 2026)
const WSOL_RENT = 1_488_440;
const FEE = Number(swapFeeLamports(QUOTE_CU_LIMIT, CU_PRICE_MICRO));
const COIN = { tokenProgram: TOKEN_2022_ID };

/// A buy of 0.01 SOL as the chain would simulate it without the unwrap: the wallet pays the wrap, the fee and three new
/// accounts; the WSOL account is drained by the swap; the coin's account gets 123,456. `tweak` changes the post-state.
function buyWorld(taker: PublicKey, mint: PublicKey, tweak: (post: Map<string, Acc>, k: Record<string, string>) => void = () => {}) {
  const k = { me: taker.toBase58(), wsol: getAssociatedTokenAddressSync(NATIVE_MINT, taker, true).toBase58(), coin: getAssociatedTokenAddressSync(mint, taker, true, T22).toBase58(), mid: getAssociatedTokenAddressSync(new PublicKey(HYPE), taker, true, T22).toBase58() };
  const pre = new Map<string, Acc>([[k.me, { lamports: 1_000_000_000 }]]);
  const post = new Map<string, Acc>([
    [k.me, { lamports: 1_000_000_000 - 10_000_000 - FEE - 2 * RENT - WSOL_RENT }],
    [k.wsol, { lamports: WSOL_RENT, data: nativeData(0n, taker, BigInt(WSOL_RENT)) }],
    [k.coin, { lamports: RENT, data: tokenData(123_456n, taker, mint) }],
    [k.mid, { lamports: RENT, data: tokenData(0n, taker) }],
  ]);
  tweak(post, k);
  return { pre, post, k };
}

test("quoteJup (buy): the coin the account gains, the rent of the accounts the route keeps open, simulated without the unwrap", async () => {
  const taker = key(), mint = key();
  answer = build(taker, mint, "buy", 10_000_000n);
  const { pre, post, k } = buyWorld(taker, mint);
  const { conn, calls } = fakeConn(pre, post);
  const q = await quoteJup(conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100);
  assert.equal(q.amountOut, 123_456n); assert.equal(q.minOut, 990n); assert.equal(q.rent, BigInt(2 * RENT), "the WSOL account's rent comes back when it closes"); assert.equal(q.unwrapped, 0n);
  assert.equal(q.unitsConsumed, 210_000); assert.equal(q.priceImpact, 0.012); assert.equal(q.taker, k.me);
  assert.deepEqual(q.legs.map((l) => l.label), ["Meteora DLMM", "Pump.fun"]); assert.equal(q.ammKeys.length, 2);
  const url = new URL(fetched[0], "http://x");
  assert.equal(url.pathname, "/api/jup/build");
  assert.deepEqual(Object.fromEntries(url.searchParams), { inputMint: SOL_MINT, outputMint: mint.toBase58(), amount: "10000000", taker: k.me, slippageBps: "100" });
  const tx = calls.simulated[0];
  const keys = tx.message.staticAccountKeys.map((x) => x.toBase58());
  assert.equal(keys[tx.message.compiledInstructions[0].programIdIndex], ComputeBudgetProgram.programId.toBase58(), "Spore's compute budget first");
  const last = tx.message.compiledInstructions[tx.message.compiledInstructions.length - 1];
  assert.equal(keys[last.programIdIndex], JUPITER_PROGRAM, "the quote simulates up to the swap, not the unwrap");
  assert.ok([k.wsol, k.coin, k.mid].every((x) => calls.reads.flat().includes(x)));
  assert.deepEqual(calls.configs[0], { commitment: "confirmed", dataSlice: { offset: 0, length: 72 } }, "only the heads of the accounts are read");
});

test("quoteJup (sell): the swap's SOL as the WSOL account holds it, a balance it had before returned on close, rent apart", async () => {
  const taker = key(), mint = key();
  answer = build(taker, mint, "sell", 1_000_000n);
  const me = taker.toBase58();
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, taker, true).toBase58();
  const coinAta = getAssociatedTokenAddressSync(mint, taker, true, T22).toBase58();
  const mid = getAssociatedTokenAddressSync(new PublicKey(HYPE), taker, true, T22).toBase58();
  const pre = new Map<string, Acc>([[me, { lamports: 1_000_000_000 }], [wsol, { lamports: WSOL_RENT + 5_000, data: tokenData(5_000n, taker, NATIVE_MINT) }], [coinAta, { lamports: RENT, data: tokenData(3_000_000n, taker, mint), owner: T22 }]]);
  const post = new Map<string, Acc>([[me, { lamports: 1_000_000_000 - FEE - RENT }], [wsol, { lamports: WSOL_RENT + 5_000 + 50_000_000, data: tokenData(5_000n + 50_000_000n, taker, NATIVE_MINT) }], [coinAta, { lamports: RENT, data: tokenData(2_000_000n, taker, mint) }], [mid, { lamports: RENT, data: tokenData(0n, taker) }]]);
  const { conn } = fakeConn(pre, post);
  const q = await quoteJup(conn, taker, { mint: mint.toBase58(), ...COIN }, "sell", 1_000_000n, 100);
  assert.equal(q.amountOut, 50_000_000n, "exactly the swap's SOL");
  assert.equal(q.rent, BigInt(RENT)); assert.equal(q.unwrapped, BigInt(WSOL_RENT + 5_000));
});

test("quoteJup: what the simulation must not show refuses the quote", async () => {
  const taker = key(), mint = key();
  const go = (b: JupBuild, w: ReturnType<typeof buyWorld>) => { answer = b; return quoteJup(fakeConn(w.pre, w.post).conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100); };
  const refused = (msg: RegExp) => (e: Error) => e instanceof JupRouteError && msg.test(e.message);
  // the wallet's SOL pays more than the wrap, the fee and the rent (a pool step drawing on the signer)
  await assert.rejects(go(build(taker, mint, "buy", 10_000_000n), buyWorld(taker, mint, (p, k) => { p.set(k.me, { lamports: p.get(k.me)!.lamports - 1 }); })), refused(/spends more of your SOL/));
  // the swap draws on a wrapped balance the wallet already had
  const w = buyWorld(taker, mint, (p, k) => { p.set(k.wsol, { lamports: WSOL_RENT, data: tokenData(0n, taker, NATIVE_MINT) }); });
  w.pre.set(w.k.wsol, { lamports: WSOL_RENT + 7_000, data: tokenData(7_000n, taker, NATIVE_MINT) });
  w.post.set(w.k.me, { lamports: 1_000_000_000 - 10_000_000 - FEE - 2 * RENT });
  await assert.rejects(go(build(taker, mint, "buy", 10_000_000n), w), refused(/more SOL than the amount/));
  // an intermediate account of the wallet's goes down
  const w2 = buyWorld(taker, mint, (p, k) => { p.set(k.mid, { lamports: RENT, data: tokenData(1n, taker) }); });
  w2.pre.set(w2.k.mid, { lamports: RENT, data: tokenData(9n, taker), owner: T22 });
  w2.post.set(w2.k.me, { lamports: 1_000_000_000 - 10_000_000 - FEE - RENT - WSOL_RENT });
  await assert.rejects(go(build(taker, mint, "buy", 10_000_000n), w2), refused(/takes from one of your token accounts/));
  // a writable account of the swap is one of the wallet's own token accounts the setup does not name (an asset it holds):
  // watched, it may stay as it is, but not go down or close
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC), taker, true);
  const usdc = (amount: bigint) => ({ lamports: WSOL_RENT, data: tokenData(amount, taker, new PublicKey(USDC)), owner: SPL });
  const w3 = buyWorld(taker, mint, (p) => { p.set(usdcAta.toBase58(), usdc(1_000_000n)); });
  w3.pre.set(usdcAta.toBase58(), usdc(1_000_000n));
  answer = build(taker, mint, "buy", 10_000_000n, {}, [usdcAta]);
  const f3 = fakeConn(w3.pre, w3.post);
  assert.equal((await quoteJup(f3.conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100)).amountOut, 123_456n, "untouched: fine");
  w3.post.set(usdcAta.toBase58(), usdc(999_999n));
  await assert.rejects(quoteJup(fakeConn(w3.pre, w3.post).conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100), refused(/takes from one of your token accounts/));
  w3.post.delete(usdcAta.toBase58());
  await assert.rejects(quoteJup(fakeConn(w3.pre, w3.post).conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100), refused(/takes from one of your token accounts/), "closed");
  // someone sent plain SOL to the wallet's (usually empty) wrapped-SOL address: opening it costs the wallet only the rest
  const gift = 650_240;
  const w4 = buyWorld(taker, mint, (p, k) => { p.set(k.me, { lamports: p.get(k.me)!.lamports + gift }); });
  w4.pre.set(w4.k.wsol, { lamports: gift, owner: SystemProgram.programId });
  answer = build(taker, mint, "buy", 10_000_000n);
  const q4 = await quoteJup(fakeConn(w4.pre, w4.post).conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100);
  assert.equal(q4.rent, BigInt(2 * RENT)); assert.equal(q4.unwrapped, BigInt(gift), "the gift comes back with the unwrap");
  // a pool inside the route fails with its own code: its own log line, not pump's words for that number
  const whirl = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
  const failing = fakeConn(w3.pre, buyWorld(taker, mint).post, { err: { InstructionError: [4, { Custom: 6005 }] }, logs: [`Program ${whirl} invoke [2]`, "Program log: AnchorError occurred. Error Code: TickArraySequenceInvalidIndex. Error Number: 6005. Error Message: Invalid tick array sequence provided for instruction.", `Program ${whirl} failed: custom program error: 0x1775`] });
  answer = build(taker, mint, "buy", 10_000_000n);
  await assert.rejects(quoteJup(failing.conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100), (e: Error) => /Invalid tick array/.test(e.message) && !/bonding curve/i.test(e.message));
  assert.equal(explainCustomError(6005, whirl), null);
  // the coin's account Spore expects is not the swap's (a record with another token program)
  answer = build(taker, mint, "buy", 10_000_000n);
  await assert.rejects(quoteJup(fakeConn(w3.pre, w3.post).conn, taker, { mint: mint.toBase58(), tokenProgram: SPL.toBase58() }, "buy", 10_000_000n, 100), refused(/another account for this coin/));
  // less than Jupiter's own minimum reaches the wallet
  await assert.rejects(go(withData(build(taker, mint, "buy", 10_000_000n, { outAmount: "200000", otherAmountThreshold: "198000" }), routeV2(10_000_000n, 200_000n)), buyWorld(taker, mint)), refused(/less than its own minimum/));
  // a venue opens an account for the wallet inside the swap (pump's volume tracker of a first-time buyer): its rent is
  // allowed up to what its size needs, and shown; more SOL parked there is not
  const tracker = key();
  const venue = (lamports: number) => buyWorld(taker, mint, (p, k) => { p.set(tracker.toBase58(), { lamports, data: new Uint8Array(100) }); p.set(k.me, { lamports: p.get(k.me)!.lamports - lamports }); });
  answer = build(taker, mint, "buy", 10_000_000n, {}, [tracker]);
  const vr = venue((128 + 100) * 5_080);
  const okq = await quoteJup(fakeConn(vr.pre, vr.post).conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100);
  assert.equal(okq.rent, BigInt(2 * RENT + (128 + 100) * 5_080), "the venue's rent is shown with the route's");
  const vx = venue((128 + 100) * 5_080 + 1);
  await assert.rejects(quoteJup(fakeConn(vx.pre, vx.post).conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100), refused(/spends more of your SOL/));
  // and the same world, honest, passes
  assert.equal((await go(build(taker, mint, "buy", 10_000_000n), buyWorld(taker, mint))).amountOut, 123_456n);
});

test("quoteJup: a refused build is never simulated; lookup tables come from the chain, not the answer", async () => {
  const taker = key(), mint = key(), thief = key();
  const b = build(taker, mint, "buy", 10_000_000n);
  answer = { ...b, setupInstructions: [...b.setupInstructions!, toJ(SystemProgram.transfer({ fromPubkey: taker, toPubkey: thief, lamports: 1n }))] };
  const { conn, calls } = fakeConn(new Map(), new Map());
  await assert.rejects(quoteJup(conn, taker, { mint: mint.toBase58(), ...COIN }, "buy", 10_000_000n, 100), JupRouteError);
  assert.equal(calls.simulated.length, 0);

  // The answer claims the table holds the taker's own accounts; the chain says otherwise: the chain wins.
  const table = key(), real = [key(), key()];
  const lying = { ...b, addressesByLookupTableAddress: { [table.toBase58()]: [getAssociatedTokenAddressSync(NATIVE_MINT, taker, true).toBase58(), PUMP.toBase58()] } };
  const chain = new Map<string, Acc>([[table.toBase58(), { lamports: 1, data: altData(real), owner: ALT_PROGRAM }]]);
  const t = await jupTables(fakeConn(chain, new Map()).conn, lying);
  assert.deepEqual(t[0].state.addresses.map((a) => a.toBase58()), real.map((a) => a.toBase58()));
  const missing = await jupTables(fakeConn(new Map(), new Map()).conn, { ...b, addressesByLookupTableAddress: { [key().toBase58()]: [] } });
  assert.equal(missing.length, 0, "a table the chain does not hold is left out");
});

test("jupTables: a table the answer needs is never evicted by the same call, however full the cache", async () => {
  const b = build(key(), key(), "buy", 1n);
  const chain = new Map<string, Acc>();
  const tableOf = () => { const k = key(); chain.set(k.toBase58(), { lamports: 1, data: altData([key()]), owner: ALT_PROGRAM }); return k.toBase58(); };
  const { conn } = fakeConn(chain, new Map());
  const one = (k: string) => jupTables(conn, { ...b, addressesByLookupTableAddress: { [k]: [""] } });
  for (let i = 0; i < 100; i++) await one(tableOf()); // the cache (64) holds only this test's tables
  const old = tableOf();
  await one(old);
  for (let i = 0; i < 63; i++) await one(tableOf()); // `old` is now the oldest of a full cache
  const again = [old, tableOf()]; // a hit that is the oldest entry, and a miss that fills the cache past its cap
  const got = await jupTables(conn, { ...b, addressesByLookupTableAddress: Object.fromEntries(again.map((k) => [k, [""]])) });
  assert.deepEqual(got.map((t) => t.key.toBase58()), again);
});

test("runJupSwap: a slippage refusal in Jupiter's program stops before the wallet opens", async () => {
  const taker = key(), mint = key();
  const b = build(taker, mint, "buy", 10_000_000n);
  const quote = { amountOut: 1_000n, minOut: 990n, unitsConsumed: 200_000, unwrapped: 0n, rent: 0n, build: b, taker: taker.toBase58(), side: "buy" as const, amountIn: 10_000_000n, slippageBps: 100, legs: [], ammKeys: [], priceImpact: null };
  const logs = [`Program ${JUPITER_PROGRAM} invoke [1]`, `Program ${JUPITER_PROGRAM} failed: custom program error: 0x1771`];
  const { conn, calls } = fakeConn(new Map([[taker.toBase58(), { lamports: 1_000_000_000 }]]), new Map(), { err: { InstructionError: [2, { Custom: 6001 }] }, logs });
  let opened = 0;
  const wallet = { publicKey: taker, sendTransaction: async () => { opened++; return "sig"; } } as never;
  await assert.rejects(runJupSwap(conn, wallet, quote, () => {}, { units: 260_000, microLamports: 50_000 }), PriceMovedError);
  assert.equal(opened, 0);
  const signed = calls.simulated[0];
  const keys = signed.message.staticAccountKeys.map((x) => x.toBase58());
  const lastIx = signed.message.compiledInstructions[signed.message.compiledInstructions.length - 1];
  assert.equal(keys[lastIx.programIdIndex], TOKEN_PROGRAM_ID.toBase58(), "the transaction the wallet gets ends with the unwrap");
  const other = { publicKey: key(), sendTransaction: async () => { opened++; return "sig"; } } as never;
  await assert.rejects(runJupSwap(conn, other, quote, () => {}, { units: 260_000, microLamports: 50_000 }), /another wallet/);
  assert.equal(isSlippageFailure(logs), true);
  assert.equal(explainCustomError(6001, JUPITER_PROGRAM), "slippage: the output fell below your minimum");
});

// ---- which coins take the route

const coin = (over: Partial<Coin> = {}): Coin => ({
  mint: key().toBase58(), name: null, symbol: "C", image: null, description: null, twitter: null, telegram: null, website: null,
  creator: key().toBase58(), quoteMint: null, quoteSymbol: "SOL", depth: 0, parent: null, root: null, ancestors: [],
  complete: false, migrated: false, pool: null, createdAt: null, createdSlot: null, tokenProgram: TOKEN_2022_ID, decimals: 6, totalSupply: "1",
  priceQuote: null, priceSol: null, priceUsd: null, mcapSol: null, mcapUsd: null, progress: 0, children: 0, descendants: 0, lockedQuote: "0", lockedUsd: null,
  volume24hUsd: 0, trades24h: 0, holderReward: false, creatorFeeBps: 0, shares: null, updatedAt: 0, mayhem: false, ...over,
} as Coin);

test("routeOf: a depth-0 coin priced in a listed asset with no SOL pool takes Jupiter when the server routes through it", () => {
  const stockCoin = coin({ quoteMint: HYPE, quoteSymbol: "HYPE" });
  assert.equal(routeOf([stockCoin], null).block?.kind, "listed", "Jupiter off: blocked as before");
  const r = routeOf([stockCoin], null, true);
  assert.equal(r.via, "jupiter"); assert.equal(r.block, null); assert.equal(hardBlock(r), null); assert.equal(r.chain.length, 1);
  const pooled = { mint: HYPE, tokenProgram: TOKEN_2022_ID, symbol: "HYPE" };
  assert.equal(routeOf([stockCoin], pooled, true).via, "pool", "pump's own SOL pool wins");
  assert.equal(routeOf([coin({ quoteMint: HYPE, quoteSymbol: "HYPE", mayhem: true })], null, true).via, "jupiter", "Jupiter's answer decides for a mayhem coin");
  assert.equal(routeOf([coin({ quoteMint: HYPE, quoteSymbol: "HYPE", complete: true })], null, true).block?.kind, "pending", "a migrating coin still waits");
  assert.equal(routeOf([coin()], null, true).via, "sol", "a SOL root is unchanged");
});

test("routeOf: a coin launched under such a root stays blocked, and says Jupiter reaches only the root's level", () => {
  const root = coin({ quoteMint: HYPE, quoteSymbol: "HYPE", symbol: "ROOT" });
  const kid = coin({ depth: 1, quoteMint: root.mint, quoteSymbol: "ROOT" });
  const r = routeOf([kid, root], null, true);
  assert.deepEqual(r.block, { kind: "listed", asset: HYPE, symbol: "HYPE", jupiter: true });
  assert.match(blockText(r.block!, kid).body, /through Jupiter, but not the coins launched under them/);
  assert.doesNotMatch(blockText(routeOf([kid, root], null).block!, kid).body, /Jupiter/);
});
