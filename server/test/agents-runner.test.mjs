// Root agents: the runner never sends (no signer anywhere, read-only RPC, off-curve placeholder keys,
// unsigned transactions), the launch it builds has the web builder's shape, and the loop's pipeline,
// gates, kill switch, one-at-a-time runs and event announcements behave as DESIGN §13 says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../lib/sdk.mjs";
import { AgentRegistry } from "../lib/agents/registry.mjs";
import { AgentRunner } from "../lib/agents/runner.mjs";
import { readOnlyRpc, agentPlaceholder, mintPlaceholder, buildLaunch, simulateLaunch, explainSimulation, SIM_FUND_LAMPORTS, PROBE_PAYER, MAX_TX_BYTES } from "../lib/agents/simulate.mjs";
import { splitShares } from "../lib/pricing.mjs";
import { pngSize } from "../lib/agents/logo.mjs";
import { EventHub } from "../lib/events.mjs";
import { Rpc } from "../lib/rpc.mjs";
import { agentTree, K, PLATFORM, quiet } from "./helpers/agents.mjs";

const { PublicKey, TransactionMessage, SystemProgram, AddressLookupTableAccount, TOKEN_2022_PROGRAM_ID } = sdk;
const here = dirname(fileURLToPath(import.meta.url));
const SPORE = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
const okSim = (over = {}) => async () => ({ ok: true, bytes: 900, unitsConsumed: 150_000, err: null, estCostSol: 0.0148, txs: 2, ...over });

function setup({ cfg = {}, simulate = okSim(), now = () => Math.floor(Date.now() / 1000) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spore-agents-"));
  const { db, model } = agentTree();
  const registry = new AgentRegistry(db, { now });
  const events = [];
  const hub = { emit: (event, data) => events.push({ event, data }) };
  let n = 0;
  const runner = new AgentRunner({ registry, model, rpc: { call: async () => { throw new Error("no rpc in this test"); } }, hub, log: quiet, now, simulate, newId: () => (++n).toString(16).padStart(16, "0"),
    cfg: { mode: "dry", tickSec: 300, minScore: 0, cooldownMin: 60, maxPerHour: 12, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], launchFeeSol: 0, pagesDomain: "spore-2x6.pages.dev", dataDir: dir, ...cfg } });
  return { dir, db, model, registry, runner, events, cleanup: () => { runner.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------- never sends
test("no signer exists: no keypair, signing or sending call anywhere in lib/agents or the CLI; sdk.mjs exports no keypair type", () => {
  const files = readdirSync(join(here, "../lib/agents")).filter((f) => f.endsWith(".mjs")).map((f) => join(here, "../lib/agents", f)).concat(join(here, "../scripts/agents.mjs"));
  assert.ok(files.length >= 10, files.join());
  const forbidden = /\bKeypair\b|secretKey|fromSecretKey|fromSeed\(|signTransaction|signAllTransactions|\.sign\(|\bsign\(|sendTransaction|sendRawTransaction|sendAndConfirm|requestAirdrop|tweetnacl|\bnacl\b|PRIVATE KEY|id\.json/;
  for (const f of files) { const src = readFileSync(f, "utf8"); const m = src.match(forbidden); assert.equal(m, null, `${f}: ${m?.[0]}`); }
  assert.equal("Keypair" in sdk, false);
  assert.equal(typeof sdk.VersionedTransaction, "function");
});

test("read-only RPC: only five reads and simulateTransaction reach the client; anything else throws before a request", async () => {
  const seen = [];
  const ro = readOnlyRpc({ call: async (m, p) => { seen.push(m); return m === "getMultipleAccounts" ? { value: p[0].map(() => null) } : { value: null }; } });
  for (const m of ["sendTransaction", "requestAirdrop", "sendRawTransaction", "getProgramAccounts", "getSignaturesForAddress"]) assert.throws(() => ro.call(m, []), /not available to agents/, m);
  assert.deepEqual(seen, []);
  assert.equal(await ro.getAccountInfo(SPORE), null);
  assert.deepEqual(await ro.getMultipleAccounts([SPORE, PLATFORM]), [null, null]);
  assert.deepEqual(seen, ["getAccountInfo", "getMultipleAccounts"]);
  assert.ok(Object.isFrozen(ro));
  assert.equal(readOnlyRpc(ro), ro, "wrapping twice keeps the guard");
  assert.equal(ro.sendTransaction, undefined); assert.equal(ro.proxy, undefined);
});

test("placeholder agent wallet and mint are off-curve PDAs (no private key can exist), stable per root/seed", () => {
  for (const root of [SPORE, K.ROOT, K.A, PLATFORM]) {
    const a = agentPlaceholder(root), m = mintPlaceholder(root, "seed-1");
    assert.equal(PublicKey.isOnCurve(a.toBytes()), false); assert.equal(PublicKey.isOnCurve(m.toBytes()), false);
    assert.ok(agentPlaceholder(root).equals(a)); assert.ok(mintPlaceholder(root, "seed-1").equals(m)); assert.ok(!mintPlaceholder(root, "seed-2").equals(m));
  }
  assert.equal(agentPlaceholder(SPORE).toBase58(), "CaCwJofURSVcSRdUVinpLy5dqJrrsauJHkPmQECCsbp9");
});

// ---------------------------------------------------------------- the transaction it builds
async function built({ tables = [], launchFee = null } = {}) {
  const agent = agentPlaceholder(K.ROOT), mint = mintPlaceholder(K.ROOT, "x");
  const pk = (n) => new PublicKey(Buffer.alloc(32, n));
  const resolved = { quoteTokenProgram: TOKEN_2022_PROGRAM_ID, pumpQuote: { accounts: { pool: { pool: pk(41), baseVault: pk(42), quoteVault: pk(43) }, chain: [] } } };
  const shares = splitShares({ creator: agent.toBase58(), parentCreator: K.U, grandparentCreator: null, platform: PLATFORM, bps: [5000, 0, 0, 5000] });
  const b = await buildLaunch({ rootMint: K.ROOT, resolved, agent, mint, form: { name: "Glow Cap", symbol: "GLOWCAP", uri: `https://spore-2x6.pages.dev/m/${"a".repeat(64)}.json` }, shares, launchFee, tables });
  return { b, agent, mint, shares };
}
const signers = (tx) => tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());

test("launch transaction: the agent pays and signs with the mint, nothing is signed, the simulated variant only adds the probe's loan", async () => {
  // Without a lookup table the launch does not fit one transaction: create, then sweep + split (as spawn.ts does).
  const split = await built();
  assert.equal(split.b.txs.length, 2);
  const [tx1, tx2] = split.b.txs;
  assert.deepEqual(signers(tx1), [split.agent.toBase58(), split.mint.toBase58()]);
  assert.deepEqual(signers(tx2), [split.agent.toBase58()]);
  for (const tx of [tx1, tx2, split.b.simTx]) for (const s of tx.signatures) assert.ok(s.every((byte) => byte === 0), "unsigned");
  // A table holding every non-signer account (the real one holds the 56 static pump accounts) lets it fit one transaction.
  const keys = new Set();
  for (const tx of split.b.txs) tx.message.staticAccountKeys.forEach((k, i) => { if (i >= tx.message.header.numRequiredSignatures && !tx.message.compiledInstructions.some((ix) => ix.programIdIndex === i)) keys.add(k.toBase58()); });
  const table = new AddressLookupTableAccount({ key: new PublicKey(Buffer.alloc(32, 99)), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [...keys].map((k) => new PublicKey(k)) } });
  const one = await built({ tables: [table], launchFee: { to: PLATFORM, lamports: "20000000" } });
  assert.equal(one.b.txs.length, 1);
  assert.ok(one.b.bytes[0] <= MAX_TX_BYTES, String(one.b.bytes[0]));
  const real = one.b.txs[0];
  assert.equal(real.message.staticAccountKeys[0].toBase58(), one.agent.toBase58(), "the agent is the fee payer");
  assert.deepEqual(signers(real), [one.agent.toBase58(), one.mint.toBase58()]);
  const ixs = TransactionMessage.decompile(real.message, { addressLookupTableAccounts: [table] }).instructions;
  const programs = ixs.map((ix) => ix.programId.toBase58());
  assert.deepEqual(programs.slice(0, 2), ["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"]);
  assert.equal(programs[2], SystemProgram.programId.toBase58(), "launch fee to the platform");
  assert.equal(ixs[2].keys[0].pubkey.toBase58(), one.agent.toBase58()); assert.equal(ixs[2].keys[1].pubkey.toBase58(), PLATFORM);
  assert.equal(programs[3], sdk.PUMP_PROGRAM_ID.toBase58(), "create_v2");
  assert.equal(programs[4], "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "the sharing config vault's quote account");
  assert.deepEqual(programs.slice(5), [sdk.PUMP_FEE_PROGRAM_ID.toBase58(), sdk.PUMP_FEE_PROGRAM_ID.toBase58()], "create_fee_sharing_config + update_fee_shares_v2");
  // The simulated variant: the probe pays the fee and lends the placeholder 0.1 SOL first; the rest is identical.
  const sim = one.b.simTx;
  assert.equal(sim.message.staticAccountKeys[0].toBase58(), PROBE_PAYER);
  assert.deepEqual(signers(sim).sort(), [PROBE_PAYER, one.agent.toBase58(), one.mint.toBase58()].sort());
  const sixs = TransactionMessage.decompile(sim.message, { addressLookupTableAccounts: [table] }).instructions;
  assert.equal(sixs[2].programId.toBase58(), SystemProgram.programId.toBase58());
  assert.equal(sixs[2].keys[0].pubkey.toBase58(), PROBE_PAYER); assert.equal(sixs[2].keys[1].pubkey.toBase58(), one.agent.toBase58());
  assert.equal(sixs[2].data.readBigUInt64LE(4), SIM_FUND_LAMPORTS);
  assert.deepEqual(sixs.slice(3).map((ix) => ix.programId.toBase58()), programs.slice(2));
  assert.match(explainSimulation({ InstructionError: [3, { Custom: 6105 }] }, ["Program log: x", "Program 6EF8 failed: custom program error: 0x17d9"]), /\(custom 6105\): Program 6EF8 failed/);
});

test("simulateLaunch through the runner on a failing RPC: only reads were attempted, the proposal is stored as rejected", async () => {
  const methods = [];
  const s = setup({ simulate: simulateLaunch });
  try {
    s.runner.rpc = { call: async (m) => { methods.push(m); throw new Error("rpc unreachable"); } };
    s.registry.enable(K.ROOT);
    const r = await s.runner.runAgent(K.ROOT);
    assert.equal(r.proposal.status, "rejected");
    assert.match(r.proposal.rejectedReason, /^simulation failed: simulation unavailable: rpc unreachable/);
    assert.deepEqual(r.proposal.sim, { ok: false, bytes: null, unitsConsumed: null, estCostSol: null, err: "simulation unavailable: rpc unreachable" });
    assert.ok(methods.length > 0 && methods.every((m) => ["getAccountInfo", "getMultipleAccounts"].includes(m)), methods.join());
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------- the loop
test("run: profile → score → ideas → logo → simulation → stored proposal → `agent` event; counters move", async () => {
  const seen = [];
  const s = setup({ simulate: async (args) => { seen.push(args); return okSim()(); } });
  try {
    s.registry.enable(K.ROOT);
    const r = await s.runner.runAgent(K.ROOT);
    const p = r.proposal;
    assert.equal(p.id, "0000000000000001"); assert.equal(p.status, "proposed"); assert.equal(p.rejectedReason, null);
    assert.match(p.symbol, /^[A-Z0-9]{2,10}$/); assert.ok(p.name.length <= 32 && p.description.length <= 280);
    assert.equal(p.image, "/api/agents/img/0000000000000001.png");
    assert.deepEqual(pngSize(readFileSync(join(s.dir, "agents", "0000000000000001.png"))), { width: 512, height: 512 });
    assert.ok(p.score > 0 && p.score <= 100); assert.match(p.reason, /^momentum \d+\/100: 2 children, .*picked \$/);
    assert.deepEqual(p.sim, { ok: true, bytes: 900, unitsConsumed: 150_000, estCostSol: 0.0148, err: null });
    assert.equal(p.source, "fallback");
    // What the simulator was asked to build: the root, the proposal's name/ticker, our metadata host's content address, Spore's split for the placeholder agent.
    const a = seen[0];
    assert.equal(a.root.mint, K.ROOT); assert.deepEqual([a.form.name, a.form.symbol], [p.name, p.symbol]);
    assert.match(a.form.uri, /^https:\/\/spore-2x6\.pages\.dev\/m\/[0-9a-f]{64}\.json$/);
    assert.deepEqual(a.shares, [{ address: agentPlaceholder(K.ROOT).toBase58(), bps: 5000 }, { address: PLATFORM, bps: 5000 }]);
    assert.deepEqual(a.launchFee, { to: PLATFORM, lamports: "0", sol: 0 });
    assert.deepEqual(s.events, [{ event: "agent", data: { root: K.ROOT, proposal: p } }]);
    const row = s.registry.get(K.ROOT);
    assert.deepEqual([row.runs, row.proposals], [1, 1]);
    assert.ok(row.next_run_at > row.last_run_at);
    assert.equal(s.registry.profileOf(K.ROOT).source, "fallback", "profile built once and stored");
    assert.equal(s.registry.proposal(p.id).metadata_uri, a.form.uri);
  } finally { s.cleanup(); }
});

test("gates in the loop: cooldown per root, hourly cap across agents, minimum score; run-once (force) passes them and says so", async () => {
  const s = setup({ cfg: { maxPerHour: 2 } });
  try {
    s.registry.enable(K.ROOT);
    assert.ok((await s.runner.runAgent(K.ROOT)).proposal);
    const again = await s.runner.runAgent(K.ROOT);
    assert.match(again.skipped, /^cooldown/);
    assert.match(s.registry.get(K.ROOT).last_reason, /not proposing: cooldown/);
    const forced = await s.runner.runAgent(K.ROOT, { force: true });
    assert.match(forced.proposal.reason, /run by hand past the gate \(cooldown/);
    // Two proposals in the last hour across all agents: a third agent root is held back by the cap.
    s.model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: null, virtualTokenReserves: "1", virtualQuoteReserves: "1", realTokenReserves: "1", realQuoteReserves: "0", tokenTotalSupply: "1", creator: K.U });
    s.registry.enable(K.S);
    assert.match((await s.runner.runAgent(K.S)).skipped, /^hourly cap: 2 proposals/);
    s.runner.cfg.minScore = 101;
    assert.match((await s.runner.runAgent(K.S)).skipped, /below the minimum 101/);
    // A coin that cannot take children never proposes, forced or not.
    s.registry.enable(K.A);
    assert.match((await s.runner.runAgent(K.A, { force: true })).skipped, /cannot be launched/);
    assert.equal(s.registry.get(K.A).proposals, 0);
  } finally { s.cleanup(); }
});

test("kill switch: AGENTS=off starts no timer and a tick does nothing; dry ticks only due agents, one at a time", async () => {
  const off = setup({ cfg: { mode: "off" } });
  try {
    off.registry.enable(K.ROOT);
    off.runner.start();
    assert.equal(off.runner.timer, null);
    await off.runner.tick();
    assert.equal(off.registry.get(K.ROOT).runs, 0); assert.equal(off.runner.stats.ticks, 0);
  } finally { off.cleanup(); }
  let active = 0, peak = 0;
  const slow = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active--; return okSim()(); };
  const s = setup({ simulate: slow });
  try {
    s.model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: null, virtualTokenReserves: "1", virtualQuoteReserves: "1", realTokenReserves: "1", realQuoteReserves: "0", tokenTotalSupply: "1", creator: K.U });
    s.registry.enable(K.ROOT); s.registry.enable(K.S); s.registry.enable(K.B); s.registry.pause(K.B);
    const results = await Promise.all([s.runner.runAgent(K.ROOT), s.runner.runAgent(K.S)]);
    assert.ok(results.every((r) => r.proposal)); assert.equal(peak, 1, "never two runs at once");
    // tick(): both agents were scheduled a tick ahead by those runs, so nothing is due now; the paused one never is.
    await s.runner.tick();
    assert.equal(s.registry.get(K.ROOT).runs, 1);
    s.db.db.exec("UPDATE agents SET next_run_at = 0");
    const ticking = s.runner.tick(), overlapping = s.runner.tick();
    await Promise.all([ticking, overlapping]);
    assert.equal(s.runner.stats.skippedTicks, 1, "a tick never overlaps a running one");
    assert.deepEqual([s.registry.get(K.ROOT).runs, s.registry.get(K.S).runs, s.registry.get(K.B).runs], [2, 2, 0]);
    s.runner.start();
    assert.ok(s.runner.timer); s.runner.stop();
  } finally { s.cleanup(); }
});

test("race with another process: a gated run that sees a proposal stored meanwhile drops its own (logo removed); ideas are seeded per proposal", async () => {
  let other = null;
  const s = setup({ simulate: async () => { other?.(); return okSim()(); } });
  try {
    s.registry.enable(K.ROOT);
    other = () => { other = null; new AgentRegistry(s.db).addProposal({ id: "00000000000000cc", root: K.ROOT, createdAt: Math.floor(Date.now() / 1000), name: "From The CLI", symbol: "FROMCLI", description: "d", score: 50, reason: "r", sim: { ok: true }, source: "fallback" }); };
    const r = await s.runner.runAgent(K.ROOT);
    assert.equal(r.skipped, "another run proposed for this root meanwhile");
    assert.deepEqual(readdirSync(join(s.dir, "agents")).filter((f) => !f.startsWith(".")), [], "its logo is removed");
    assert.deepEqual(s.registry.proposals(K.ROOT).map((p) => p.symbol), ["FROMCLI"]);
    assert.match(s.registry.get(K.ROOT).last_reason, /another run proposed for this root meanwhile/);
    // Forced (the CLI itself) it still stores; two runs never pick the same idea from the same seed.
    const a = await s.runner.runAgent(K.ROOT, { force: true }), b = await s.runner.runAgent(K.ROOT, { force: true });
    assert.ok(a.proposal && b.proposal);
    assert.notEqual(a.proposal.id, b.proposal.id);
  } finally { s.cleanup(); }
});

test("announce: proposals another process stored (the CLI) are emitted once on the hub", async () => {
  const s = setup();
  try {
    s.registry.enable(K.ROOT);
    s.runner.start(); s.runner.stop(); // records the current high-water mark
    const other = new AgentRegistry(s.db);
    other.addProposal({ id: "00000000000000aa", root: K.ROOT, createdAt: 1, name: "Other", symbol: "OTHER", description: "d", score: 50, reason: "r", sim: { ok: true }, source: "fallback" });
    s.runner.announce(); s.runner.announce();
    assert.deepEqual(s.events.map((e) => [e.event, e.data.root, e.data.proposal.symbol]), [["agent", K.ROOT, "OTHER"]]);
    // The real hub frames it as `event: agent` for /api/events listeners.
    const hub = new EventHub({ heartbeatMs: 60_000 }); const got = [];
    hub.subscribe((e, d) => got.push([e, d.proposal.id]));
    s.runner.hub = hub; s.runner.lastSeq = 0; s.runner.announce(); hub.close();
    assert.deepEqual(got, [["agent", "00000000000000aa"]]);
  } finally { s.cleanup(); }
});

test("mainnet: a dry-run launch under $SPORE builds and simulates ok, with reads only (needs RPC_URL; skipped with SPORE_NET=0)", { skip: process.env.SPORE_NET === "0" || !process.env.RPC_URL }, async () => {
  const rpc = new Rpc({ url: process.env.RPC_URL, rps: 5, log: quiet }).lane("api");
  const methods = [];
  const spy = { call: (m, p) => { methods.push(m); return rpc.call(m, p); } };
  const agent = agentPlaceholder(SPORE).toBase58();
  const shares = splitShares({ creator: agent, parentCreator: "7fSCMhvjPj224aMjYX2AGdjCS7TnPJaZSdMgsb4D7pox", grandparentCreator: null, platform: PLATFORM, bps: [5000, 0, 0, 5000] });
  const r = await simulateLaunch({ rpc: spy, root: { mint: SPORE, depth: 0 }, form: { name: "Test Sprout", symbol: "TSPROUT", uri: `https://spore-2x6.pages.dev/m/${"b".repeat(64)}.json` }, shares, seed: "net-test" });
  assert.equal(r.ok, true, r.err ?? "");
  assert.ok(r.bytes > 500 && r.bytes <= MAX_TX_BYTES && r.unitsConsumed > 50_000 && r.estCostSol > 0.001 && r.estCostSol < 0.1, JSON.stringify(r));
  assert.ok(methods.every((m) => ["getAccountInfo", "getMultipleAccounts", "getMinimumBalanceForRentExemption", "simulateTransaction"].includes(m)), methods.join());
});
