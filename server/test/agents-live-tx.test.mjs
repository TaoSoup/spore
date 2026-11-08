// Transaction helpers, the Jupiter top-up guards, the claim arithmetic and the model-drawn logo
// (lib/agents-live/tx|swap|claim|ailogo). Chain and HTTP are mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { confirm, send, recentBlockhash, TxError } from "../lib/agents-live/tx.mjs";
import { checkSwapTx, jupiterQuote, topUpUsdc, JUPITER_PROGRAM, SwapError } from "../lib/agents-live/swap.mjs";
import { perShare, shareOf, worthClaiming, CLAIM_MIN_SHARE_LAMPORTS } from "../lib/agents-live/claim.mjs";
import { sanitizeSvg, extractSvg, rasterize, drawLogo, LogoError } from "../lib/agents-live/ailogo.mjs";
import { snapshot } from "../lib/agents-live/budget.mjs";
import { pngSize } from "../lib/agents/logo.mjs";

const BH = "11111111111111111111111111111111";
const sigOk = (sig) => ({ value: [{ slot: 100, confirmationStatus: "confirmed", err: null }] });

test("tx: confirm reports landed, failed and expired; recentBlockhash validates its answer", async () => {
  let statuses = [{ value: [null] }, sigOk()];
  const rpc = { async call(m) { if (m === "getSignatureStatuses") return statuses.shift() ?? { value: [null] }; if (m === "getBlockHeight") return 10; throw new Error(m); } };
  assert.deepEqual(await confirm(rpc, "sig", { lastValidBlockHeight: 50, pollMs: 1 }), { status: "landed", slot: 100, err: null });
  statuses = [{ value: [{ slot: 101, confirmationStatus: "confirmed", err: { InstructionError: [2, "Custom"] } }] }];
  assert.equal((await confirm(rpc, "sig", { lastValidBlockHeight: 50, pollMs: 1 })).status, "failed");
  const late = { async call(m) { if (m === "getSignatureStatuses") return { value: [null] }; if (m === "getBlockHeight") return 999; throw new Error(m); } };
  assert.equal((await confirm(late, "sig", { lastValidBlockHeight: 50, pollMs: 1 })).status, "expired");
  await assert.rejects(recentBlockhash({ async call() { return { value: {} }; } }), TxError);
  assert.deepEqual(await recentBlockhash({ async call() { return { value: { blockhash: BH, lastValidBlockHeight: 7 } }; } }), { blockhash: BH, lastValidBlockHeight: 7 });
});

test("tx: send passes base64 wire with preflight on and refuses a non-signature answer", async () => {
  const kp = Keypair.generate();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: BH, instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })] }).compileToV0Message());
  tx.sign([kp]);
  let seen = null;
  const rpc = { async call(m, p) { seen = [m, p]; return "5".repeat(88); } };
  assert.equal(await send(rpc, tx), "5".repeat(88));
  assert.equal(seen[0], "sendTransaction"); assert.equal(seen[1][1].encoding, "base64"); assert.equal(seen[1][1].skipPreflight, false);
  await assert.rejects(send({ async call() { return { odd: true }; } }, tx), TxError);
});

function swapTxFor(payer, { signers = 1, program = JUPITER_PROGRAM, signed = false } = {}) {
  const extra = Keypair.generate();
  const ixs = [{ programId: new PublicKey(program), keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, ...(signers > 1 ? [{ pubkey: extra.publicKey, isSigner: true, isWritable: false }] : [])], data: Buffer.alloc(1) }];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: BH, instructions: ixs }).compileToV0Message());
  if (signed) tx.sign([payer, ...(signers > 1 ? [extra] : [])]);
  return tx;
}

test("swap: checkSwapTx accepts one agent-paid Jupiter call and refuses everything else", () => {
  const agent = Keypair.generate(), other = Keypair.generate();
  assert.ok(checkSwapTx(swapTxFor(agent), agent.publicKey.toBase58()).includes(JUPITER_PROGRAM));
  assert.throws(() => checkSwapTx(swapTxFor(other), agent.publicKey.toBase58()), /not paid by the agent/);
  assert.throws(() => checkSwapTx(swapTxFor(agent, { signers: 2 }), agent.publicKey.toBase58()), /more than one signer/);
  assert.throws(() => checkSwapTx(swapTxFor(agent, { signed: true }), agent.publicKey.toBase58()), /arrived signed/);
  assert.throws(() => checkSwapTx(swapTxFor(agent, { program: "11111111111111111111111111111111" }), agent.publicKey.toBase58()), /Jupiter program/);
});

const WSOL = "So11111111111111111111111111111111111111112", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const quoteFor = (lamports, over = {}) => ({ inputMint: WSOL, outputMint: USDC, inAmount: String(lamports), outAmount: "1010000", otherAmountThreshold: "1004950", priceImpactPct: "0.0001", ...over });
const http = (q) => async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(q) });

test("swap: jupiterQuote validates mints, amounts and impact", async () => {
  const q = await jupiterQuote({ lamports: 10_000_000, fetchImpl: http(quoteFor(10_000_000)) });
  assert.equal(q.minOutMicros, 1_004_950); assert.equal(q.outMicros, 1_010_000);
  await assert.rejects(jupiterQuote({ lamports: 10_000_000, fetchImpl: http(quoteFor(9_000_000)) }), /does not match/);
  await assert.rejects(jupiterQuote({ lamports: 10_000_000, fetchImpl: http(quoteFor(10_000_000, { priceImpactPct: "0.05" })) }), /impact/);
  await assert.rejects(jupiterQuote({ lamports: 10_000_000, fetchImpl: http(quoteFor(10_000_000, { otherAmountThreshold: "0" })) }), /usable amounts/);
  await assert.rejects(jupiterQuote({ lamports: 1, fetchImpl: async () => ({ ok: false, status: 429, text: async () => "slow down" }) }), /Jupiter 429/);
});

test("swap: topUpUsdc stops at the gates in order and never signs before the simulation passes", async () => {
  const agent = Keypair.generate();
  let signed = 0;
  const signer = { address: agent.publicKey.toBase58(), publicKey: agent.publicKey, signTransaction(tx) { signed++; tx.sign([agent]); return tx; } };
  const budget = snapshot({ lamports: 50_000_000, usdcMicros: 0, solUsd: 100 }); // 0.05 SOL = $5
  await assert.rejects(topUpUsdc({ rpc: {}, signer, budget, usd: 10 }), (e) => e instanceof SwapError && e.code === "amount");
  await assert.rejects(topUpUsdc({ rpc: {}, signer, budget: snapshot({ lamports: 50_000_000, usdcMicros: 0 }), usd: 1 }), (e) => e.code === "price");
  await assert.rejects(topUpUsdc({ rpc: {}, signer, budget: snapshot({ lamports: 1_000_000, usdcMicros: 0, solUsd: 100 }), usd: 1 }), (e) => e.code === "funds");
  // A full path with the swap delivering too little SOL back in simulation: refused before signing.
  const lamportsIn = Math.ceil((1 * 1.01 / 100) * 1e9);
  const wire = Buffer.from(swapTxFor(agent).serialize()).toString("base64");
  const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.includes("/quote") ? quoteFor(lamportsIn) : { swapTransaction: wire, lastValidBlockHeight: 10 }) });
  const rpcBad = { async call(m) { if (m === "simulateTransaction") return { value: { err: null, accounts: [{ lamports: 1 }, null] } }; throw new Error(m); } };
  await assert.rejects(topUpUsdc({ rpc: rpcBad, signer, budget, usd: 1, fetchImpl }), (e) => e.code === "sim" && /more SOL/.test(e.message));
  assert.equal(signed, 0);
  // The honest path: SOL falls by the input, USDC rises by the minimum; signed, recorded, sent, confirmed.
  const usdcAccount = Buffer.alloc(165); usdcAccount.writeBigUInt64LE(1_004_950n, 64);
  const calls = [], ledger = { entries: [], record(e) { this.entries.push(e); } };
  const rpcOk = { async call(m, p) { calls.push(m); if (m === "simulateTransaction") return { value: { err: null, accounts: [{ lamports: 50_000_000 - lamportsIn - 5000 }, { data: [usdcAccount.toString("base64"), "base64"] }] } }; if (m === "sendTransaction") return "9".repeat(88); if (m === "getSignatureStatuses") return sigOk(); throw new Error(m); } };
  const r = await topUpUsdc({ rpc: rpcOk, signer, budget, usd: 1, fetchImpl, ledger, log: { info() {} } });
  assert.equal(signed, 1); assert.equal(r.signature, "9".repeat(88)); assert.equal(r.lamportsIn, lamportsIn);
  assert.deepEqual(ledger.entries.map((e) => e.status), ["pending", "landed"]);
  assert.ok(calls.indexOf("simulateTransaction") < calls.indexOf("sendTransaction"));
});

test("claim: shares follow the config's bps and the SOL floor stops dust claims", () => {
  const a = Keypair.generate().publicKey, p = Keypair.generate().publicKey;
  const config = { shareholders: [{ address: a, shareBps: 5000 }, { address: p, shareBps: 5000 }] };
  const state = { config, total: 10_000_001n, sol: true };
  assert.deepEqual(perShare(config, 10_000_001n).map((s) => s.amount), [5_000_000n, 5_000_000n]);
  assert.equal(shareOf(state, a.toBase58()), 5_000_000n);
  assert.equal(shareOf(state, Keypair.generate().publicKey.toBase58()), 0n);
  assert.equal(worthClaiming(state, a.toBase58()).ok, true);
  assert.equal(worthClaiming({ ...state, total: CLAIM_MIN_SHARE_LAMPORTS }, a.toBase58()).ok, false);
  assert.equal(worthClaiming({ ...state, total: 2n, sol: false }, a.toBase58()).ok, false, "token-quoted: no price, not worth a fee");
  assert.equal(worthClaiming({ ...state, total: 2n, sol: false }, a.toBase58(), { quoteUsd: 1 }).ok, false, "token-quoted: dust under the $0.05 floor");
  assert.equal(worthClaiming({ ...state, total: 200_000n, sol: false }, a.toBase58(), { quoteUsd: 1 }).ok, true, "token-quoted: $0.10 share is worth it");
  assert.equal(worthClaiming({ config: null, total: 1n, sol: true }, a.toBase58()).ok, false);
});

const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g"><stop offset="0" stop-color="#111"/><stop offset="1" stop-color="#d7ff4a"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="256" r="120" fill="#fff"/><text x="256" y="280" font-size="64" text-anchor="middle" fill="#111">MYC</text></svg>';

test("ailogo: sanitiser keeps the vector subset and refuses scripts, links, images, external refs", () => {
  assert.equal(sanitizeSvg(GOOD_SVG), GOOD_SVG);
  assert.equal(extractSvg("Here you go:\n```svg\n" + GOOD_SVG + "\n```"), GOOD_SVG);
  assert.equal(extractSvg({ svg: GOOD_SVG }), GOOD_SVG);
  for (const bad of [
    GOOD_SVG.replace("<circle", "<script>alert(1)</script><circle"),
    GOOD_SVG.replace("<circle", '<image href="https://x/y.png"/><circle'),
    GOOD_SVG.replace("<circle", '<a href="https://x"><circle'),
    GOOD_SVG.replace('fill="url(#g)"', 'fill="url(https://x/g)"'),
    GOOD_SVG.replace("<circle", '<circle onclick="x()"'),
    GOOD_SVG.replace("<svg", "<!DOCTYPE svg [<!ENTITY x 'y'>]><svg"),
    GOOD_SVG.replace("<circle", "<foreignObject></foreignObject><circle"),
    "<div>no</div>",
  ]) assert.throws(() => sanitizeSvg(bad), LogoError, bad.slice(0, 60));
  assert.throws(() => sanitizeSvg("<svg>" + "x".repeat(30_000) + "</svg>"), /bytes/);
});

test("ailogo: a model SVG rasterises to 512×512 and a bad answer falls back to the template", async () => {
  const png = await rasterize(GOOD_SVG);
  assert.deepEqual(pngSize(png), { width: 512, height: 512 });
  const idea = { name: "Mycelium", symbol: "MYC" }, profile = { themes: ["fungi"], tone: "playful", palette: ["#111111", "#d7ff4a"], avoid: [] };
  const good = await drawLogo(idea, profile, { llm: { available: true, chatText: async () => "sure:\n" + GOOD_SVG } });
  assert.equal(good.source, "model"); assert.deepEqual(pngSize(good.png), { width: 512, height: 512 });
  const bad = await drawLogo(idea, profile, { llm: { available: true, chatText: async () => "<svg><script>x</script></svg>" }, log: { warn() {} } });
  assert.equal(bad.source, "template"); assert.match(bad.error, /banned|not one|allowed/); assert.deepEqual(pngSize(bad.png), { width: 512, height: 512 });
  const none = await drawLogo(idea, profile, { llm: null });
  assert.equal(none.source, "template"); assert.equal(none.error, null);
});
