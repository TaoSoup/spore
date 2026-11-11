// The ancestor walk (Indexer.ensureAncestors) runs on the event loop each time a live spawn lands under a parent the
// model does not hold yet. On the local index (155k coins, 70k of them quoted in one of 224 QuoteControl assets) each
// round held the loop for ~20 s (Nov 11 2026): every coin's quote mint was compared with the QuoteControl list,
// base58-encoding one key per comparison, and the 13 asset mints that are no pump curve were asked about again in
// every round. No network: the RPC is a stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer, NOT_CURVE_TTL_MS } from "../lib/indexer.mjs";
import { PublicKey, bondingCurvePda } from "../lib/sdk.mjs";
import { PLATFORM, base, quiet } from "./helpers/tree.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/accounts.json", import.meta.url), "utf8")).accounts.curve;
/** A distinct real public key per number. */
const keyN = (n) => { const b = Buffer.alloc(32, 7); b.writeUInt32LE(n, 0); return new PublicKey(b).toBase58(); };
const pda = (mint) => bondingCurvePda(mint).toBase58();
/** The fixture BondingCurve re-stamped as a live, SOL-quoted depth-0 curve: what the chain answers for a pump parent. */
function liveCurve({ quoteMint = null } = {}) {
  const raw = Buffer.from(fixture.data, "base64");
  raw[141] = 0; raw[48] = 0; // depth 0, not complete
  raw.writeBigUInt64LE(1_000_000_000_000_000n, 8); raw.writeBigUInt64LE(30_000_000_000n, 16); // reserves: on its curve
  if (quoteMint) new PublicKey(quoteMint).toBuffer().copy(raw, 83); else raw.fill(0, 83, 115);
  return { owner: fixture.owner, lamports: 1, data: raw, executable: false };
}
function setup({ whitelisted = [] } = {}) {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: whitelisted });
  const accounts = new Map(), calls = [];
  const rpc = { snapshot: () => ({}), getMultipleAccounts: async (keys) => { calls.push(keys); return keys.map((k) => accounts.get(k) ?? null); } };
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  return { db, model, indexer, accounts, calls };
}
let seq = 1_000;
const coin = (model, quoteMint, extra = {}) => { const mint = keyN(seq++); model.upsertCoin({ mint, curve: `C${seq}`, depth: 0, quoteMint, ...base, ...extra }); return mint; };

test("ensureAncestors encodes the QuoteControl list once per Global read, not once per coin, and never asks about listed quotes", async () => {
  const W = keyN(1);
  const { db, model, indexer, accounts, calls } = setup({ whitelisted: [W] });
  // 60 QuoteControl assets with 50 coins each, 20 coins quoted in the whitelisted mint, one spawn under a parent the model lacks.
  const qc = Array.from({ length: 60 }, (_, i) => keyN(100 + i));
  let encodes = 0;
  const quoteControl = (list) => ({ mints: list.map((s) => ({ mint: { toBase58: () => { encodes++; return s; } } })) });
  indexer.quoteControlRaw = quoteControl(qc);
  for (const q of qc) for (let j = 0; j < 50; j++) coin(model, q);
  for (let j = 0; j < 20; j++) coin(model, W);
  const P = keyN(2);
  coin(model, P, { depth: 1 });
  accounts.set(pda(P), liveCurve());
  await indexer.ensureAncestors();
  assert.ok(model.get(P)?.tracked, "the parent joined the tree");
  assert.deepEqual(calls, [[pda(P)]], "one call, for the parent alone; round 1 found nothing missing and asked nothing");
  assert.equal(encodes, qc.length, "each QuoteControl key encoded once for 3,000 coins quoted in them");
  await indexer.ensureAncestors();
  assert.equal(calls.length, 1, "nothing missing: no call");
  assert.equal(encodes, qc.length, "the Set is reused while the lists are the same objects");
  // loadGlobal replaces both lists (every 10 min): the Set follows, once.
  indexer.quoteControlRaw = quoteControl(qc.slice(0, 59));
  const delisted = qc[59];
  await indexer.ensureAncestors();
  assert.equal(encodes, qc.length + 59);
  assert.deepEqual(calls.at(-1), [pda(delisted)], "a mint dropped from QuoteControl is missing now, and asked about");
  model.setGlobal({ ...model.global, whitelistedQuoteMints: [W, delisted] });
  indexer.notCurve.clear();
  const n = calls.length;
  await indexer.ensureAncestors();
  assert.equal(calls.length, n, "whitelisted by the new Global: not asked about");
  db.close();
});

test("a quote mint the chain says is no pump curve is asked about once per NOT_CURVE_TTL_MS; new parents still join at once", async () => {
  const { db, model, indexer, accounts, calls } = setup();
  const STOCK = keyN(3), FOREIGN = keyN(4), JUNK = keyN(5), P = keyN(6), Q = keyN(7);
  coin(model, STOCK); coin(model, STOCK); // a tokenized stock outside QuoteControl: no curve account
  coin(model, FOREIGN); accounts.set(pda(FOREIGN), { ...liveCurve(), owner: "TokenkegQfeZyiNwAJbNbGYPyBuqQQ4dZz8dqFgzbW4" }); // another program owns the PDA
  coin(model, JUNK); accounts.set(pda(JUNK), { ...liveCurve(), data: Buffer.alloc(40) }); // pump-owned, but no BondingCurve
  coin(model, P, { depth: 1 }); accounts.set(pda(P), liveCurve());
  await indexer.ensureAncestors();
  assert.deepEqual(calls, [[pda(STOCK), pda(FOREIGN), pda(JUNK), pda(P)]], "round 0 asks for all four; round 1 has nothing left to ask");
  assert.ok(model.get(P)?.tracked);
  assert.deepEqual([...indexer.notCurve.keys()].sort(), [STOCK, FOREIGN, JUNK].sort());
  // The next spawn under another new parent asks for that parent only (it used to re-ask for every non-curve, twice).
  coin(model, Q, { depth: 1 }); accounts.set(pda(Q), liveCurve());
  await indexer.ensureAncestors();
  assert.deepEqual(calls.at(-1), [pda(Q)]);
  assert.equal(calls.length, 2);
  await indexer.ensureAncestors();
  assert.equal(calls.length, 2, "nothing new: no call");
  // Past the TTL a verdict is asked again (and dropped from memory), so a curve a lagging RPC missed is found later.
  indexer.notCurve.set(STOCK, Date.now() - NOT_CURVE_TTL_MS);
  await indexer.ensureAncestors();
  assert.deepEqual(calls.at(-1), [pda(STOCK)]);
  assert.equal(indexer.notCurve.size, 3, "asked and cached again");
  db.close();
});

test("every coin's quote mint counts, tracked or not, and a quote mint no coin uses any more is not asked about", async () => {
  const { db, model, indexer, accounts, calls } = setup();
  const R = keyN(8), U = keyN(9), GP = keyN(10);
  // An untracked coin (looked up on demand) under a parent the model lacks: the walk pulls the parent, then its own parent.
  model.upsertCoin({ mint: U, curve: "C_U", depth: 2, quoteMint: R, ...base, tracked: false });
  accounts.set(pda(R), liveCurve({ quoteMint: GP })); accounts.set(pda(GP), liveCurve());
  await indexer.ensureAncestors();
  assert.deepEqual(calls, [[pda(R)], [pda(GP)]], "round 0 the parent, round 1 the grandparent");
  assert.ok(model.get(R)?.tracked && model.get(GP)?.tracked);
  // Once an untracked coin is evicted, a quote mint only it used is no longer in use.
  const X = keyN(11);
  model.upsertCoin({ mint: keyN(12), curve: "C_X", depth: 1, quoteMint: X, ...base, tracked: false });
  assert.equal(model.evictUntracked({ idleMs: -60_000 }), 2, "both untracked coins (U and the one under X) go");
  await indexer.ensureAncestors();
  assert.equal(calls.length, 2, "an emptied child set is skipped");
  db.close();
});

test("fetchCoin runs the ancestor walk only for a quote mint that is neither held nor listed", async () => {
  const W = keyN(13), V = keyN(14), M1 = keyN(15), M2 = keyN(16);
  const { db, indexer, accounts } = setup({ whitelisted: [W] });
  let walks = 0;
  const walk = indexer.ensureAncestors.bind(indexer);
  indexer.ensureAncestors = (o) => { walks++; return walk(o); };
  accounts.set(pda(M1), liveCurve({ quoteMint: W }));
  accounts.set(pda(M2), liveCurve({ quoteMint: V }));
  assert.equal((await indexer.fetchCoin(M1))?.quoteMint, W);
  assert.equal(walks, 0, "a coin quoted in a listed asset: no walk");
  assert.equal((await indexer.fetchCoin(M2))?.quoteMint, V);
  assert.equal(walks, 1, "an unknown, unlisted quote mint: one walk");
  db.close();
});
