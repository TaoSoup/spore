// Jupiter routing for the quick trade: the paced /build client (lib/jupiter.mjs), the relay rule that lets a Jupiter
// swap through the RPC proxy only when it passes a pump program (lib/api.mjs relayKind / jupiterTouchesPump), and the
// /api/jup routes. No network: Jupiter and the RPC are fakes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { Jupiter, JupiterError, JUPITER_PROGRAM, JUP_MAX_BYTES, SOL_MINT } from "../lib/jupiter.mjs";
import { createApp, relayKind, jupiterLookups, jupiterTouchesPump, rpcParamsError, JUP_MAX_LOOKUPS } from "../lib/api.mjs";
import { PUMP_PROGRAM_ID } from "../lib/sdk.mjs";
import { EventHub } from "../lib/events.mjs";
import { buildTree, K, PLATFORM, quiet } from "./helpers/tree.mjs";
import { loadConfig } from "../lib/config.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALT = "AddressLookupTab1e1111111111111111111111111";
const PUMP = PUMP_PROGRAM_ID.toBase58();
const JUP = new PublicKey(JUPITER_PROGRAM);
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// ---- the client

/// A fake fetch answering from `answers` in turn ({ status, body, headers }), recording each call.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), headers: init.headers, at: fn.now?.() });
    const a = answers.shift() ?? { status: 200, body: { swapInstruction: {} } };
    if (a.throws) throw a.throws;
    const h = new Headers(a.headers ?? {});
    return { status: a.status, headers: h, text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
  };
  fn.calls = calls;
  return fn;
}
/// A clock the client's sleeps move forward.
function clock(t0 = 1_000_000) {
  const c = { t: t0, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; };
  return c;
}
const Q = { inputMint: SOL_MINT, outputMint: K.ROOT, amount: "10000000", taker: PLATFORM, slippageBps: 100 };

test("Jupiter.build: asks /build with the swap, the byte budget and the key; answers the body", async () => {
  const f = fakeFetch([{ status: 200, body: { inAmount: "10000000", swapInstruction: { programId: JUPITER_PROGRAM } } }]);
  const c = clock();
  const j = new Jupiter({ url: "https://api.jup.ag/swap/v2/", apiKey: "k-secret", rps: 1, fetch: f, now: c.now, sleep: c.sleep, log: quiet });
  const body = await j.build(Q);
  assert.equal(body.inAmount, "10000000");
  const { url, headers } = f.calls[0];
  assert.equal(url.origin + url.pathname, "https://api.jup.ag/swap/v2/build");
  assert.deepEqual(Object.fromEntries(url.searchParams), { inputMint: SOL_MINT, outputMint: K.ROOT, amount: "10000000", taker: PLATFORM, slippageBps: "100", maxBytes: String(JUP_MAX_BYTES) });
  assert.equal(headers["x-api-key"], "k-secret");
  const snap = j.snapshot();
  assert.equal(snap.ok, 1); assert.equal(snap.keyed, true); assert.equal(snap.gapMs, 1_000);
  assert.ok(!JSON.stringify(snap).includes("k-secret"), "the key never shows in /api/health");
  const keyless = new Jupiter({ url: "https://x", fetch: fakeFetch([]), log: quiet });
  await keyless.build(Q);
  assert.equal(keyless.snapshot().gapMs, 2_000, "keyless: 0.5 requests a second");
});

test("Jupiter.build: calls are spaced by the rate, and a 429 pauses until Jupiter's reset", async () => {
  const c = clock(1_000_000);
  const f = fakeFetch([{ status: 200, body: { swapInstruction: {} } }, { status: 429, body: "Too many", headers: { "x-ratelimit-reset": String((1_000_000 + 9_000) / 1000) } }, { status: 200, body: { swapInstruction: {} } }]);
  const j = new Jupiter({ url: "https://x", rps: 0.5, fetch: f, now: c.now, sleep: c.sleep, log: quiet });
  await j.build(Q);
  assert.deepEqual(c.slept, [], "the first call goes at once");
  await assert.rejects(j.build(Q), (e) => e instanceof JupiterError && e.status === 429 && /rate-limiting/.test(e.message));
  assert.deepEqual(c.slept, [2_000], "the second waits one gap");
  await j.build(Q);
  assert.equal(c.t, 1_009_000, "the third waits for the reset Jupiter named");
  assert.equal(j.snapshot().rateLimited, 1);
});

test("Jupiter.build: no route is 400, other failures 502 or their status, a dead Jupiter 502", async () => {
  const c = clock();
  const j = new Jupiter({ url: "https://x", rps: 1_000, now: c.now, sleep: c.sleep, log: quiet, fetch: fakeFetch([
    { status: 400, body: { error: "No routes found" } },
    { status: 500, body: "boom" },
    { status: 403, body: { error: "forbidden" } },
    { status: 200, body: { error: "no swap here" } },
    { throws: Object.assign(new Error("socket hang up"), { name: "TypeError" }) },
  ]) });
  await assert.rejects(j.build(Q), (e) => e.status === 400 && /no route/.test(e.message));
  await assert.rejects(j.build(Q), (e) => e.status === 502);
  await assert.rejects(j.build(Q), (e) => e.status === 403 && /forbidden/.test(e.message));
  await assert.rejects(j.build(Q), (e) => e.status === 502, "a 200 without a swap is no answer");
  await assert.rejects(j.build(Q), (e) => e.status === 502 && /did not answer/.test(e.message));
  const s = j.snapshot();
  assert.equal(s.noRoute, 1); assert.equal(s.errors, 4); assert.equal(s.calls, 5);
});

test("Jupiter.build: calls already waiting when a 429 arrives wait out its pause too", async () => {
  const c = clock(1_000_000);
  const reset = 1_000_000 + 2_000 + 15_000;
  const f = fakeFetch([{ status: 200, body: { swapInstruction: {} } }, { status: 429, body: "Too many", headers: { "x-ratelimit-reset": String(reset / 1000) } }, { status: 200, body: { swapInstruction: {} } }, { status: 200, body: { swapInstruction: {} } }]);
  f.now = c.now;
  const j = new Jupiter({ url: "https://x", rps: 0.5, fetch: f, now: c.now, sleep: c.sleep, log: quiet });
  const all = [j.build(Q), j.build(Q), j.build(Q), j.build(Q)]; // all four in line before any answer
  const out = await Promise.allSettled(all);
  assert.deepEqual(out.map((o) => o.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.deepEqual(f.calls.map((x) => x.at), [1_000_000, 1_002_000, reset, reset + 2_000], "nothing goes out during the pause, then the gap again");
});

test("Jupiter.build: a quote dropped while it waits never reaches Jupiter, and does not hold up the next", async () => {
  const c = clock(1_000_000);
  const f = fakeFetch([]); f.now = c.now;
  const j = new Jupiter({ url: "https://x", rps: 0.5, fetch: f, now: c.now, sleep: c.sleep, log: quiet });
  await j.build(Q);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(j.build(Q, { signal: ac.signal }), (e) => e.status === 499);
  await j.build(Q);
  assert.equal(f.calls.length, 2, "the dropped one was never sent");
  assert.deepEqual(f.calls.map((x) => x.at), [1_000_000, 1_002_000]);
  assert.equal(j.snapshot().dropped, 1); assert.equal(j.snapshot().waiting, 0);
});

test("Jupiter.build: a quote dropped while it waits in line is skipped when its turn comes", async () => {
  const c = clock(1_000_000);
  const f = fakeFetch([]); f.now = c.now;
  let wake;
  const j = new Jupiter({ url: "https://x", rps: 0.5, fetch: f, now: c.now, sleep: (ms) => new Promise((r) => { wake = () => { c.t += ms; r(); }; }), log: quiet });
  await j.build(Q);
  const ac = new AbortController();
  const waiting = j.build(Q, { signal: ac.signal });
  const next = j.build(Q);
  await new Promise((r) => setImmediate(r));
  assert.equal(j.snapshot().waiting, 2);
  ac.abort(); wake();
  await assert.rejects(waiting, (e) => e.status === 499);
  await new Promise((r) => setImmediate(r)); wake?.();
  await next;
  assert.equal(f.calls.length, 2, "the dropped quote never reached Jupiter");
  assert.equal(j.snapshot().dropped, 1); assert.equal(j.snapshot().waiting, 0);
});

test("Jupiter.build: a burst beyond the queue is refused at once, not queued for minutes", async () => {
  const c = { t: 0 };
  const j = new Jupiter({ url: "https://x", rps: 0.5, fetch: fakeFetch([]), now: () => c.t, sleep: () => new Promise(() => {}), log: quiet });
  await j.build(Q); // goes at once; the next ones wait for their slot (forever, here)
  const waiting = Array.from({ length: 8 }, () => j.build(Q));
  await assert.rejects(j.build(Q), (e) => e.status === 429 && /busy/.test(e.message));
  assert.equal(j.snapshot().waiting, 8); assert.equal(j.snapshot().refused, 1);
  void waiting;
});

test("config: on by default at Jupiter's keyless rate; a key lifts it to 1/s; JUPITER=0 turns it off", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-jup-cfg-"));
  try {
    const env = { DATA_DIR: join(dir, "data"), META_DIR: join(dir, "meta") };
    const c = loadConfig(env, { here: dir }).jupiter;
    assert.deepEqual(c, { enabled: true, url: "https://api.jup.ag/swap/v2", apiKey: "", rps: 0.5 });
    assert.equal(loadConfig({ ...env, JUP_API_KEY: "k" }, { here: dir }).jupiter.rps, 1);
    assert.equal(loadConfig({ ...env, JUPITER: "0" }, { here: dir }).jupiter.enabled, false);
    assert.throws(() => loadConfig({ ...env, JUP_URL: "ftp://x" }, { here: dir }), /JUP_URL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the relay rule

const tx = (ixs, tables = []) => {
  const m = new TransactionMessage({ payerKey: Keypair.generate().publicKey, recentBlockhash: "1".repeat(32), instructions: ixs }).compileToV0Message(tables);
  return Buffer.from(new VersionedTransaction(m).serialize()).toString("base64");
};
const table = (key, addrs) => new AddressLookupTableAccount({ key, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addrs.map((a) => new PublicKey(a)) } });
/// An address lookup table account's data, as the chain stores it (56-byte header, then the addresses).
const altData = (addrs) => {
  const b = Buffer.alloc(56 + 32 * addrs.length);
  b.writeUInt32LE(1, 0); b.writeBigUInt64LE(2n ** 64n - 1n, 4);
  addrs.forEach((a, i) => new PublicKey(a).toBuffer().copy(b, 56 + 32 * i));
  return b;
};
const jupIx = (extra = []) => new TransactionInstruction({ programId: JUP, keys: extra.map((k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: false })), data: Buffer.from([1]) });
const pumpIx = new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys: [], data: Buffer.from([1]) });
const someone = () => Keypair.generate().publicKey;
const cb = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
const wrap = SystemProgram.transfer({ fromPubkey: someone(), toPubkey: someone(), lamports: 1 });
const TABLE = Keypair.generate().publicKey;

test("relayKind: pump at the top, a Jupiter swap with only setup around it, or nothing", () => {
  assert.equal(relayKind(tx([cb, pumpIx])), "pump");
  assert.equal(relayKind(tx([cb, wrap, jupIx([PUMP])])), "jupiter");
  assert.equal(relayKind(tx([jupIx(), new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("hi") })])), null, "another program beside Jupiter");
  const assign = SystemProgram.assign({ accountPubkey: someone(), programId: someone() });
  assert.equal(relayKind(tx([cb, assign])), null, "no swap and no plain transfer");
  assert.equal(relayKind(tx([cb, wrap])), "transfer", "a plain transfer is its own kind (the trading wallet's)");
  assert.equal(relayKind("not a transaction"), null);
  // what a 1,232-byte transaction can be, no more: longer strings are refused undecoded, padding after a transaction too
  const t = tx([cb, jupIx([PUMP])]);
  const raw = Buffer.from(t, "base64");
  const padded = Buffer.concat([raw, Buffer.alloc(1_233 - raw.length)]).toString("base64");
  assert.ok(padded.length <= 1_644);
  assert.equal(relayKind(padded), null, "trailing bytes past 1,232");
  assert.equal(relayKind(Buffer.concat([raw, Buffer.alloc(1_232 - raw.length)]).toString("base64")), "jupiter", "up to 1,232 bytes is a transaction as before");
  assert.match(rpcParamsError("simulateTransaction", ["1".repeat(1_684), { encoding: "base58" }]), /too large/);
  assert.match(rpcParamsError("simulateTransaction", ["A".repeat(1_648), { encoding: "base64" }]), /too large/);
  assert.equal(rpcParamsError("simulateTransaction", [t, { encoding: "base64" }]), null);
  assert.equal(rpcParamsError("simulateTransaction", [tx([cb, jupIx()]), { encoding: "base64" }]), null, "the shape passes; the pump check is the route's");
  assert.match(rpcParamsError("sendTransaction", [tx([cb, assign]), { encoding: "base64" }]), /only pump\.fun/);
});

test("relayKind: one or two plain SOL transfers (the trading wallet's deposits and withdrawals), nothing more", () => {
  const a = someone(), b = someone();
  const send = (lamports) => SystemProgram.transfer({ fromPubkey: a, toPubkey: b, lamports });
  assert.equal(relayKind(tx([send(1)])), "transfer");
  assert.equal(relayKind(tx([cb, send(1), send(2)])), "transfer", "with a compute budget, two transfers");
  assert.equal(relayKind(tx([send(1), send(2), send(3)])), null, "three is not a deposit or a withdrawal");
  assert.equal(relayKind(tx([SystemProgram.assign({ accountPubkey: a, programId: b })])), null, "another System instruction");
  assert.equal(relayKind(tx([SystemProgram.createAccount({ fromPubkey: a, newAccountPubkey: b, lamports: 1, space: 0, programId: b })])), null);
  assert.equal(relayKind(tx([send(1), new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("x") })])), null, "a transfer beside another program");
  assert.equal(relayKind(tx([cb])), null, "no transfer at all");
});

test("jupiterTouchesPump: a pump program among its static keys or in a lookup table it uses", async () => {
  const none = async (ks) => ks.map(() => null);
  assert.equal(await jupiterTouchesPump(tx([jupIx([PUMP])]), "base64", none), true, "static");
  const addrs = [someone().toBase58(), PUMP, someone().toBase58()];
  const viaTable = tx([jupIx([addrs[0], PUMP])], [table(TABLE, addrs)]);
  assert.equal(VersionedTransaction.deserialize(Buffer.from(viaTable, "base64")).message.addressTableLookups.length, 1, "compiled through the table");
  const seen = [];
  assert.equal(await jupiterTouchesPump(viaTable, "base64", async (ks) => { seen.push(...ks); return ks.map(() => addrs); }), true);
  assert.deepEqual(seen, [TABLE.toBase58()]);
  assert.equal(await jupiterTouchesPump(viaTable, "base64", none), false, "a table that cannot be read proves nothing");
  assert.equal(await jupiterTouchesPump(tx([jupIx([someone().toBase58()])]), "base64", none), false);
  assert.equal(await jupiterTouchesPump(viaTable, "base64", async () => { throw new Error("rpc down"); }), false);
  assert.deepEqual(AddressLookupTableAccount.deserialize(altData(addrs)).addresses.map((a) => a.toBase58()), addrs, "the test's table bytes are what the chain stores");
  // more tables than a Jupiter swap uses: refused before anything is read
  const five = Array.from({ length: JUP_MAX_LOOKUPS + 1 }, () => { const a = someone().toBase58(); return { t: table(someone(), [a]), a }; });
  const many = tx([jupIx(five.map((x) => x.a))], five.map((x) => x.t));
  assert.equal(VersionedTransaction.deserialize(Buffer.from(many, "base64")).message.addressTableLookups.length, JUP_MAX_LOOKUPS + 1);
  assert.equal(jupiterLookups(many), null);
  const reads = [];
  assert.equal(await jupiterTouchesPump(many, "base64", async (ks) => { reads.push(...ks); return ks.map(() => [PUMP]); }), false);
  assert.equal(reads.length, 0, "nothing read for a refused swap");
  assert.deepEqual(jupiterLookups(tx([jupIx([PUMP])])), { staticPump: true, tables: [] });
});

// ---- the routes

let model, db, hub;
const servers = [];
const built = [];
let nextBuild = null;
let hold = null;
const signals = [];
const fakeJupiter = { build: async (q, opts = {}) => { built.push(q); signals.push(opts.signal); if (hold) await hold; if (nextBuild) { const n = nextBuild; nextBuild = null; if (n instanceof Error) throw n; return n; } return { inAmount: q.amount, swapInstruction: { programId: JUPITER_PROGRAM } }; }, snapshot: () => ({ calls: built.length }) };
const proxied = [];
const tableReads = [];
const rpc = {
  proxy: async (body) => { proxied.push(body); return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }) }; },
  lane: () => ({ getMultipleAccounts: async (ks) => { tableReads.push(ks); return ks.map((k) => (k === TABLE.toBase58() ? { owner: ALT, lamports: 1, data: altData([someone().toBase58(), PUMP]) } : null)); } }),
};
async function serve(jupiter) {
  const indexer = { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  const app = createApp({ model, indexer, rpc, hub, images: { handler: () => (_q, r) => r.status(404).end() }, meta: null, jupiter, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], distDir: null, log: quiet });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  servers.push({ server, app });
  return `http://127.0.0.1:${server.address().port}`;
}
let on, off;
before(async () => {
  ({ db, model } = buildTree());
  hub = new EventHub({ heartbeatMs: 60_000 });
  on = await serve(fakeJupiter);
  off = await serve(null);
});
after(() => { for (const { server, app } of servers) { app.locals.v1?.close(); server.closeAllConnections?.(); server.close(); } hub.close(); db.close(); });

const get = async (base, p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json(), headers: r.headers }; };
const qs = (o) => new URLSearchParams(o).toString();

test("GET /api/jup/status says whether Jupiter routing is on", async () => {
  assert.deepEqual((await get(on, "/api/jup/status")).body, { enabled: true });
  assert.deepEqual((await get(off, "/api/jup/status")).body, { enabled: false });
});

test("GET /api/jup/build: SOL ↔ a tracked coin only, validated before Jupiter is asked", async () => {
  const ok = { inputMint: SOL_MINT, outputMint: K.ROOT, amount: "10000000", taker: PLATFORM, slippageBps: "100" };
  built.length = 0;
  const r = await get(on, `/api/jup/build?${qs(ok)}`);
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(built, [{ inputMint: SOL_MINT, outputMint: K.ROOT, amount: "10000000", taker: PLATFORM, slippageBps: 100 }]);
  const sell = await get(on, `/api/jup/build?${qs({ ...ok, inputMint: K.ROOT, outputMint: SOL_MINT })}`);
  assert.equal(sell.status, 200, "a sell too");
  const bad = [
    [{ ...ok, outputMint: SOL_MINT }, 400, /one side must be SOL/],
    [{ ...ok, inputMint: K.A }, 400, /one side must be SOL/],
    [{ ...ok, taker: SOL_MINT }, 400, /invalid/],
    [{ ...ok, taker: "nope" }, 400, /invalid/],
    [{ ...ok, outputMint: K.X }, 404, /not a coin this index tracks/],
    [{ ...ok, amount: "0" }, 400, /amount/],
    [{ ...ok, amount: "01" }, 400, /amount/],
    [{ ...ok, amount: "1.5" }, 400, /amount/],
    [{ ...ok, amount: "1".repeat(21) }, 400, /amount/],
    [{ ...ok, slippageBps: "0" }, 400, /slippageBps/],
    [{ ...ok, slippageBps: "5001" }, 400, /slippageBps/],
  ];
  built.length = 0;
  for (const [q, status, msg] of bad) {
    const b = await get(on, `/api/jup/build?${qs(q)}`);
    assert.equal(b.status, status, JSON.stringify(q)); assert.match(b.body.error, msg);
  }
  assert.equal(built.length, 0, "Jupiter was never asked for a refused query");
  assert.equal((await get(off, `/api/jup/build?${qs(ok)}`)).status, 503);
});

test("GET /api/jup/build: Jupiter's refusals keep their status and words", async () => {
  const ok = qs({ inputMint: SOL_MINT, outputMint: K.ROOT, amount: "5", taker: PLATFORM, slippageBps: "50" });
  nextBuild = new JupiterError(400, "Jupiter found no route for this trade");
  let r = await get(on, `/api/jup/build?${ok}`);
  assert.equal(r.status, 400); assert.match(r.body.error, /no route/);
  nextBuild = new JupiterError(429, "Jupiter is rate-limiting quotes; try again in a few seconds");
  r = await get(on, `/api/jup/build?${ok}`);
  assert.equal(r.status, 429);
});

test("POST /api/rpc: a Jupiter swap is relayed only with Jupiter on and a pump program inside it", async () => {
  const post = (base, t) => fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [t, { encoding: "base64" }] }) });
  const addrs = [someone().toBase58(), PUMP];
  const viaTable = tx([cb, jupIx(addrs)], [table(TABLE, addrs)]);
  proxied.length = 0;
  assert.equal((await post(on, tx([cb, jupIx([PUMP])]))).status, 200, "pump among the static keys");
  assert.equal((await post(on, viaTable)).status, 200, "pump in the table, read from the chain");
  assert.equal((await post(on, viaTable)).status, 200);
  assert.equal(tableReads.flat().filter((k) => k === TABLE.toBase58()).length, 1, "the table is read once, then cached");
  assert.equal((await post(on, tx([cb, jupIx([someone().toBase58()])]))).status, 403, "a Jupiter swap that never touches pump");
  const other = Keypair.generate().publicKey;
  assert.equal((await post(on, tx([cb, jupIx([addrs[0], PUMP])], [table(other, addrs)]))).status, 403, "a table the chain does not hold");
  assert.equal((await post(off, tx([cb, jupIx([PUMP])]))).status, 403, "Jupiter routing off");
  assert.equal(proxied.length, 3);
  assert.equal((await post(off, tx([cb, pumpIx]))).status, 200, "pump transactions as before");
});

test("POST /api/rpc: a batch's unknown tables cost one read; made-up tables are not kept; /build's tables need none", async () => {
  const post = (base, body) => fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const sim = (t, id = 1) => ({ jsonrpc: "2.0", id, method: "simulateTransaction", params: [t, { encoding: "base64" }] });
  const fake = () => { const k = someone(), a = [someone().toBase58(), PUMP]; return { k, t: tx([cb, jupIx(a)], [table(k, a)]) }; };
  tableReads.length = 0;
  const batch = [fake(), fake(), fake()];
  assert.equal((await post(on, batch.map((b, i) => sim(b.t, i)))).status, 403, "tables the chain does not hold");
  assert.equal(tableReads.length, 1, "one read for the whole batch"); assert.equal(tableReads[0].length, 3);
  assert.equal((await post(on, sim(batch[0].t))).status, 403);
  assert.equal(tableReads.length, 2, "a missing table is not remembered as one");
  // a table Jupiter named in a /build answer is known without a read
  const k = someone(), a = [someone().toBase58(), PUMP];
  nextBuild = { inAmount: "5", swapInstruction: { programId: JUPITER_PROGRAM }, addressesByLookupTableAddress: { [k.toBase58()]: a } };
  const q = new URLSearchParams({ inputMint: SOL_MINT, outputMint: K.ROOT, amount: "5", taker: PLATFORM, slippageBps: "50" });
  assert.equal((await get(on, `/api/jup/build?${q}`)).status, 200);
  tableReads.length = 0;
  assert.equal((await post(on, sim(tx([cb, jupIx(a)], [table(k, a)])))).status, 200);
  assert.equal(tableReads.length, 0);
});

test("GET /api/jup/build: its own per-IP limit, and a quote whose browser left is dropped", async () => {
  const q = new URLSearchParams({ inputMint: SOL_MINT, outputMint: K.ROOT, amount: "7", taker: PLATFORM, slippageBps: "50" });
  const r = await fetch(`${on}/api/jup/build?${q}`);
  assert.match(r.headers.get("x-ratelimit-policy"), /name=jup/);
  let open; hold = new Promise((x) => { open = x; });
  signals.length = 0;
  const ac = new AbortController();
  const p = fetch(`${on}/api/jup/build?${q}`, { signal: ac.signal }).catch(() => null);
  for (let i = 0; i < 100 && !signals.length; i++) await new Promise((x) => setTimeout(x, 10));
  assert.equal(signals.length, 1); assert.equal(signals[0].aborted, false);
  ac.abort();
  for (let i = 0; i < 100 && !signals[0].aborted; i++) await new Promise((x) => setTimeout(x, 10));
  assert.equal(signals[0].aborted, true, "the server tells the queue the asker is gone");
  hold = null; open(); await p;
});
