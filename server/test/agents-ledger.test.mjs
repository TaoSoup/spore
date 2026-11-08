// The agents' ledger reader (lib/agents-live/ledger.mjs, DESIGN §13.2): incremental tailing by byte
// offset, tolerance of malformed and partial lines and of a truncated file, the folding of one
// action's lines into one item, the human titles with coin tickers, amounts and explorer links,
// base64 signatures never shown, and the per-agent totals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLedger, foldEntries, activityItem, activityOf, totalsOf, bs58Signature, fmtSol, fmtUsd, EXPLORER_TX, ACTIVITY_KINDS, ACTIVITY_STATUSES } from "../lib/agents-live/ledger.mjs";

const ROOT = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
const KID = "3jCxhydpkxUEuTwUNU1j1bpSNai9qaBP1mpSCG69Ctrp";
const ADDR = "FoUH2Pc9VAVpDLhTRNdrJCFHgnrs554SbRgiJCZepmV4";
const SIG1 = "2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ";
const SIG2 = "wVpMu7Dcvnvx8KpjzzNny4EvRdbJo6mY73vaA9GSrMnUzjkVPxKA8HsiyaoN5Nv4tc4MNKd3DopxoTprqmcysgy";
const SIG3 = "u9QVt9Ft3ydwgtrpKLUMJcr6wnjF8giQKUS2t8oDqervjwGCvNBVaGymDHCSvC2rWfqJtrKM5UAAKce7PPemEvo";
const SIG4 = "3wwWTtUv32NNFy1K4gdEtANZ6usRf6fSb6HYn1x6Tiuq817XvMyCCZW7Fm2DGmiNnNj8BRXnq4M1mxdivQsmuWkk";
const B64 = Buffer.alloc(64, 7).toString("base64"); // what pay.mjs wrote before 2026-10-19
const quiet = { warn() {}, info() {} };

/** A model double: names, SOL price, a child quoted in the root at 1e-5 USD per unit. */
const model = {
  solUsd: 100,
  nameOf: (m) => ({ [ROOT]: { name: "Spore", symbol: "SPORE" }, [KID]: { name: "Connect Puff", symbol: "CPUFF" } }[m] ?? { name: null, symbol: null }),
  get: (m) => (m === ROOT ? { mint: ROOT, quoteMint: null, depth: 0 } : m === KID ? { mint: KID, quoteMint: ROOT, depth: 1 } : null),
  decimalsOf: () => 6,
  quoteUsdOf: (m) => (m === ROOT ? 0.00002 : null),
};
const line = (ts, e) => JSON.stringify({ ts, ...e }) + "\n";
const launchLines = (ts, mint, { sig = SIG1, split = SIG2, twoTx = true } = {}) => [
  line(ts, { kind: "launch", root: ROOT, address: ADDR, mint, name: "Connect Puff", symbol: "CPUFF", uri: "https://x/y.json", estCostSol: 0.0148, txs: twoTx ? 2 : 1, status: "pending" }),
  line(ts + 1, { kind: "launch", root: ROOT, mint, step: 1, of: twoTx ? 2 : 1, signature: sig, status: "sent" }),
  line(ts + 5, { kind: "launch", root: ROOT, mint, step: 1, of: twoTx ? 2 : 1, signature: sig, slot: 1, status: twoTx ? "step_landed" : "landed" }),
  ...(twoTx ? [line(ts + 9, { kind: "launch", root: ROOT, mint, step: 2, of: 2, signature: split, slot: 2, status: "landed" })] : []),
].join("");

test("ledger: reads a file incrementally by byte offset, keeps partial lines, skips malformed ones, restarts after a truncation", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-ledger-"));
  const file = join(dir, "ledger.jsonl");
  let t = 1_000_000;
  const led = new AgentLedger(file, { log: quiet, now: () => (t += 2_000), minRefreshMs: 1_000 });
  assert.equal(led.refresh().lines, 0, "a missing file is fine");
  writeFileSync(file, launchLines(100, KID) + "{not json\n" + line(200, { kind: "claim", root: ROOT, address: ADDR, mint: ROOT, total: "5000000", mine: "2500000", sol: true, signature: SIG3, status: "pending" }));
  led.refresh();
  assert.deepEqual([led.lines, led.bad, led.roots()], [5, 1, [ROOT]]);
  assert.equal(led.offset > 0, true);
  // A write in progress: half a line stays in the tail until its newline arrives.
  const whole = line(205, { kind: "claim", root: ROOT, mint: ROOT, signature: SIG3, slot: 3, status: "landed" });
  const fd = openSync(file, "a"); writeSync(fd, whole.slice(0, 20)); closeSync(fd);
  led.refresh();
  assert.equal(led.lines, 5, "no new line yet"); assert.equal(led.tail.length, 20);
  appendFileSync(file, whole.slice(20));
  led.refresh();
  assert.equal(led.lines, 6); assert.equal(led.tail.length, 0);
  const items = led.itemsOf(ROOT);
  assert.deepEqual(items.map((i) => [i.kind, i.status]), [["launch", "landed"], ["claim", "landed"]], "one item per action");
  // Not more often than once a second (two refreshes within the same second share one stat).
  const before = led.refreshedAt; led.now = () => before + 10; led.refresh(); assert.equal(led.refreshedAt, before);
  led.now = () => before + 5_000;
  // A truncated / replaced file is read again from the start.
  truncateSync(file, 0);
  appendFileSync(file, line(300, { kind: "payout", root: ROOT, address: ADDR, to: "x", lamports: 50_000_000, usdcMicros: 0, signature: SIG4, status: "pending" }));
  led.refresh();
  assert.deepEqual([led.lines, led.bad], [1, 0]);
  assert.deepEqual(led.itemsOf(ROOT).map((i) => i.kind), ["payout"]);
  assert.deepEqual(Object.keys(led.snapshot()).sort(), ["bad", "bytes", "lines", "roots"]);
  // Lines without a root or a kind, or that are not objects, count as bad; a ts that is missing gets the clock.
  appendFileSync(file, '{"kind":"claim"}\n[1,2]\n{"kind":"ai","rail":"keyed","root":"' + ROOT + '","status":"done","estUsd":0.01}\n');
  led.now = () => 7_777_000_000; led.refreshedAt = 0;
  led.refresh();
  assert.equal(led.bad, 2);
  assert.equal(led.linesOf(ROOT).at(-1).ts, 7_777_000, "ts defaults to now (seconds)");
  rmSync(dir, { recursive: true, force: true });
});

test("fold: a two-transaction launch is one item whose status follows the create and then the split; retries of a split are separate attempts", () => {
  const parse = (s) => s.trim().split("\n").map((l) => JSON.parse(l));
  const two = foldEntries(parse(launchLines(100, KID)));
  assert.equal(two.length, 1);
  assert.deepEqual([two[0].status, two[0].signature, two[0].splitSignature, two[0].at, two[0].updatedAt, two[0].estCostSol, two[0].symbol], ["landed", SIG1, SIG2, 100, 109, 0.0148, "CPUFF"]);
  // Create landed, split expired → step_landed; a later split attempt lands.
  const owed = foldEntries(parse(launchLines(100, KID).split("\n").slice(0, 3).join("\n") + "\n" + line(109, { kind: "launch", root: ROOT, mint: KID, step: 2, of: 2, signature: SIG2, status: "tx_expired", note: "split owed: expired" })
    + line(200, { kind: "split", root: ROOT, address: ADDR, mint: KID, status: "pending" }) + line(205, { kind: "split", root: ROOT, mint: KID, signature: SIG3, status: "tx_failed", note: "boom" })
    + line(300, { kind: "split", root: ROOT, address: ADDR, mint: KID, status: "pending" }) + line(305, { kind: "split", root: ROOT, mint: KID, signature: SIG4, slot: 9, status: "landed" })));
  assert.deepEqual(owed.map((i) => [i.kind, i.status, i.signature]), [["launch", "step_landed", SIG1], ["split", "failed", SIG3], ["split", "landed", SIG4]]);
  // One transaction: landed at step 1.
  const one = foldEntries(parse(launchLines(100, KID, { twoTx: false })));
  assert.deepEqual([one.length, one[0].status, one[0].txs], [1, "landed", 1]);
  // A create that failed.
  const failed = foldEntries(parse(launchLines(100, KID).split("\n").slice(0, 2).join("\n") + "\n" + line(103, { kind: "launch", root: ROOT, mint: KID, step: 1, signature: SIG1, status: "tx_failed", note: "InsufficientFunds" })));
  assert.deepEqual([failed[0].status, failed[0].note], ["failed", "InsufficientFunds"]);
  // Claims group by signature; keyed model calls are one item per line; x402 payments by paymentId.
  const mixed = foldEntries(parse(
    line(1, { kind: "claim", root: ROOT, address: ADDR, mint: ROOT, total: "4", mine: "2", sol: true, signature: SIG3, status: "pending" }) + line(2, { kind: "claim", root: ROOT, mint: ROOT, signature: SIG3, slot: 1, status: "landed" })
    + line(3, { kind: "ai", rail: "keyed", root: ROOT, model: "anthropic/claude-sonnet-5.5", status: "done", estUsd: 0.01 }) + line(4, { kind: "ai", rail: "keyed", root: ROOT, model: "anthropic/claude-sonnet-5.5", status: "done", estUsd: 0.02 })
    + line(5, { kind: "ai", root: ROOT, address: ADDR, model: "anthropic/claude-sonnet-5.5", paymentId: "p1", amountMicros: 13000, amountUsd: 0.013, signature: B64, status: "pending" }) + line(6, { kind: "ai", root: ROOT, paymentId: "p1", status: "settled", amountMicros: 13000 })));
  assert.deepEqual(mixed.map((i) => [i.kind, i.status]), [["claim", "landed"], ["ai", "done"], ["ai", "done"], ["ai", "done"]]);
  assert.equal(mixed[3].signature, null, "a base64 signature is never kept");
  assert.equal(mixed[3].amountUsd, 0.013);
});

test("activity items: human titles with tickers, amounts, USD at today's prices, explorer links, the contract's keys", () => {
  const keys = ["amountSol", "amountUsdc", "at", "explorer", "kind", "mint", "signature", "status", "symbol", "title", "usd"];
  const of = (entries) => activityItem(foldEntries(entries)[0], { model });
  const launch = of(launchLines(100, KID).trim().split("\n").map((l) => JSON.parse(l)));
  assert.deepEqual(Object.keys(launch).sort(), keys);
  assert.deepEqual(launch, { at: 100, kind: "launch", status: "landed", title: "Launched $CPUFF", amountSol: 0.0148, amountUsdc: null, usd: 1.48, mint: KID, symbol: "CPUFF", signature: SIG1, explorer: `${EXPLORER_TX}${SIG1}` });
  const owed = of([{ ts: 1, kind: "launch", root: ROOT, mint: KID, symbol: "CPUFF", txs: 2, status: "pending" }, { ts: 2, kind: "launch", root: ROOT, mint: KID, step: 1, of: 2, signature: SIG1, status: "step_landed" }]);
  assert.deepEqual([owed.status, owed.title], ["step_landed", "Launched $CPUFF (fee split owed)"]);
  assert.equal(of([{ ts: 1, kind: "launch", root: ROOT, mint: "UnknownMint111111111111111111111111111111111", symbol: "NEWONE", status: "pending" }]).title, "Launching $NEWONE", "the ledger's own ticker when the index does not know the coin");
  assert.equal(of([{ ts: 1, kind: "launch", root: ROOT, mint: KID, step: 1, signature: SIG1, status: "tx_expired" }]).title, "Launch of $CPUFF expired");
  // A SOL claim from the root; a token claim from a child (quoted in the root) priced through the model.
  const sol = of([{ ts: 1, kind: "claim", root: ROOT, address: ADDR, mint: ROOT, total: "104900000", mine: "54900000", sol: true, signature: SIG3, status: "pending" }, { ts: 2, kind: "claim", root: ROOT, mint: ROOT, signature: SIG3, slot: 1, status: "landed" }]);
  assert.deepEqual([sol.title, sol.amountSol, sol.usd, sol.symbol, sol.explorer], ["Claimed 0.0549 SOL from $SPORE", 0.0549, 5.49, "SPORE", `${EXPLORER_TX}${SIG3}`]);
  const tok = of([{ ts: 1, kind: "claim", root: ROOT, address: ADDR, mint: KID, total: "48000000000", mine: "24000000000", sol: false, signature: SIG4, status: "pending" }, { ts: 2, kind: "claim", root: ROOT, mint: KID, signature: SIG4, status: "landed" }]);
  assert.deepEqual([tok.title, tok.amountSol, tok.amountUsdc, tok.usd], ["Claimed 24,000 $SPORE from $CPUFF", null, null, 0.48]);
  assert.equal(of([{ ts: 1, kind: "claim", root: ROOT, mint: KID, mine: "1", sol: false, signature: SIG4, status: "pending" }, { ts: 2, kind: "claim", root: ROOT, mint: KID, signature: SIG4, status: "tx_failed" }]).title, "Claim from $CPUFF failed");
  // Payouts.
  const pay = of([{ ts: 1, kind: "payout", root: ROOT, address: ADDR, to: "o", lamports: 120_000_000, usdcMicros: 1_200_000, signature: SIG2, status: "pending" }, { ts: 2, kind: "payout", root: ROOT, address: ADDR, to: "o", signature: SIG2, slot: 1, status: "landed" }]);
  assert.deepEqual([pay.title, pay.amountSol, pay.amountUsdc, pay.usd], ["Paid 0.12 SOL + 1.20 USDC to the owner", 0.12, 1.2, 13.2]);
  assert.equal(of([{ ts: 1, kind: "payout", root: ROOT, lamports: 120_000_000, usdcMicros: 0, signature: SIG2, status: "pending" }]).title, "Paying 0.12 SOL to the owner");
  assert.equal(of([{ ts: 1, kind: "payout", root: ROOT, lamports: 0, usdcMicros: 500_000, signature: SIG2, status: "landed" }]).title, "Paid 0.50 USDC to the owner");
  // Model calls on the keyed rail (booked) and on x402 (paid in USDC from the wallet).
  assert.deepEqual(of([{ ts: 1, kind: "ai", rail: "keyed", root: ROOT, model: "anthropic/claude-sonnet-5.5", provider: "x", status: "done", promptTokens: 1400, completionTokens: 400, estUsd: 0.013 }]), { at: 1, kind: "ai", status: "done", title: "Thought with Claude Sonnet 5.5 ($0.013)", amountSol: null, amountUsdc: null, usd: 0.013, mint: null, symbol: null, signature: null, explorer: null });
  assert.equal(of([{ ts: 1, kind: "ai", rail: "keyed", root: ROOT, provider: "gpt-image-1", status: "done", image: true, estUsd: 0.008 }]).title, "Drew a logo ($0.008)");
  assert.equal(of([{ ts: 1, kind: "ai", rail: "keyed", root: ROOT, model: "anthropic/claude-opus-5.5", status: "failed", note: "HTTP 500" }]).title, "Claude Opus 5.5 call failed");
  assert.equal(of([{ ts: 1, kind: "ai", rail: "keyed", root: ROOT, model: "anthropic/claude-sonnet-5.5", status: "refused", note: "daily model budget for this agent reached ($2.00 of $2)" }]).title, "Skipped thinking: daily model budget for this agent reached ($2.00 of $2)");
  const x402 = of([{ ts: 1, kind: "ai", root: ROOT, address: ADDR, model: "anthropic/claude-sonnet-5.5", paymentId: "p1", amountMicros: 13000, amountUsd: 0.013, signature: B64, status: "pending" }, { ts: 2, kind: "ai", root: ROOT, paymentId: "p1", status: "settled", amountMicros: 13000 }]);
  assert.deepEqual([x402.title, x402.amountUsdc, x402.usd, x402.signature, x402.explorer], ["Thought with Claude Sonnet 5.5 ($0.013)", 0.013, 0.013, null, null]);
  // Swaps and fee splits.
  const swap = of([{ ts: 1, kind: "swap", root: ROOT, address: ADDR, lamportsIn: 20_000_000, minOutMicros: 990_000, outMicros: 1_001_000, signature: SIG1, status: "pending" }, { ts: 2, kind: "swap", root: ROOT, address: ADDR, signature: SIG1, slot: 1, status: "landed" }]);
  assert.deepEqual([swap.title, swap.amountSol, swap.amountUsdc], ["Swapped 0.02 SOL for ≈ 1.00 USDC", 0.02, 1.001]);
  assert.equal(of([{ ts: 1, kind: "split", root: ROOT, address: ADDR, mint: KID, status: "pending" }, { ts: 2, kind: "split", root: ROOT, mint: KID, signature: SIG2, status: "landed" }]).title, "Finished the fee split of $CPUFF");
  // Without a model: tickers from the ledger, no USD.
  const bare = activityItem(foldEntries([{ ts: 1, kind: "claim", root: ROOT, mint: ROOT, mine: "54900000", sol: true, signature: SIG3, status: "landed" }])[0], {});
  assert.deepEqual([bare.title, bare.usd], [`Claimed 0.0549 SOL from ${ROOT.slice(0, 4)}…${ROOT.slice(-4)}`, null]);
  for (const k of ACTIVITY_KINDS) assert.ok(["launch", "claim", "payout", "aifee", "ai", "swap", "split"].includes(k));
  assert.ok(ACTIVITY_STATUSES.includes("step_landed"));
  assert.deepEqual([bs58Signature(SIG1), bs58Signature(B64), bs58Signature(""), bs58Signature(null)], [SIG1, null, null, null]);
  assert.deepEqual([fmtSol(0.12), fmtSol(0.0549), fmtSol(1), fmtUsd(0.013), fmtUsd(0.008), fmtUsd(0.1), fmtUsd(1.5), fmtUsd(0)], ["0.12", "0.0549", "1", "0.013", "0.008", "0.10", "1.50", "0.00"]);
});

test("activity order and totals: newest first with a limit; totals count landed launches, claims, payouts and finished model calls", () => {
  const entries = [
    ...launchLines(100, KID).trim().split("\n").map((l) => JSON.parse(l)),
    { ts: 200, kind: "claim", root: ROOT, address: ADDR, mint: ROOT, total: "4", mine: "54900000", sol: true, signature: SIG3, status: "pending" }, { ts: 203, kind: "claim", root: ROOT, mint: ROOT, signature: SIG3, status: "landed" },
    { ts: 210, kind: "claim", root: ROOT, address: ADDR, mint: KID, total: "4", mine: "24000000000", sol: false, signature: SIG4, status: "pending" }, { ts: 213, kind: "claim", root: ROOT, mint: KID, signature: SIG4, status: "landed" },
    { ts: 220, kind: "claim", root: ROOT, address: ADDR, mint: KID, mine: "1000000", sol: false, signature: SIG2, status: "pending" }, { ts: 250, kind: "claim", root: ROOT, mint: KID, signature: SIG2, status: "tx_expired" },
    { ts: 300, kind: "payout", root: ROOT, address: ADDR, to: "o", lamports: 120_000_000, usdcMicros: 1_200_000, signature: SIG1, status: "pending" }, { ts: 304, kind: "payout", root: ROOT, to: "o", signature: SIG1, status: "landed" },
    { ts: 400, kind: "ai", rail: "keyed", root: ROOT, model: "anthropic/claude-sonnet-5.5", status: "done", estUsd: 0.01 }, { ts: 401, kind: "ai", rail: "keyed", root: ROOT, provider: "img", status: "done", image: true, estUsd: 0.008 },
    { ts: 402, kind: "ai", rail: "keyed", root: ROOT, model: "anthropic/claude-sonnet-5.5", status: "refused", note: "budget" },
    { ts: 500, kind: "launch", root: ROOT, mint: "UnknownMint111111111111111111111111111111111", symbol: "FAIL", estCostSol: 0.02, txs: 1, status: "pending" }, { ts: 501, kind: "launch", root: ROOT, mint: "UnknownMint111111111111111111111111111111111", step: 1, signature: SIG2, status: "tx_failed" },
  ];
  const items = foldEntries(entries);
  const all = activityOf(items, { model, limit: 50 });
  assert.deepEqual(all.map((a) => [a.at, a.kind, a.status]), [[500, "launch", "failed"], [402, "ai", "refused"], [401, "ai", "done"], [400, "ai", "done"], [300, "payout", "landed"], [220, "claim", "expired"], [210, "claim", "landed"], [200, "claim", "landed"], [100, "launch", "landed"]]);
  assert.equal(activityOf(items, { model, limit: 3 }).length, 3);
  assert.equal(activityOf(items, { model, limit: 0 }).length, 0);
  assert.deepEqual(totalsOf(items, { model }), { launches: 1, launchSol: 0.0148, claimsSol: 0.0549, claimsUsd: 5.97, aiUsd: 0.018, aiCalls: 2, payoutsSol: 0.12, payoutsUsdc: 1.2, lastActivityAt: 501 });
  assert.deepEqual(totalsOf([], { model }), { launches: 0, launchSol: 0, claimsSol: 0, claimsUsd: 0, aiUsd: 0, aiCalls: 0, payoutsSol: 0, payoutsUsdc: 0, lastActivityAt: null });
});
