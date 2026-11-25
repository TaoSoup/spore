// LAUNCH_LOG: every curve launch and trade the live stream delivers is recorded, tracked or not, with its slot; the tree
// itself is unchanged (an untracked coin's trade stores nothing in spore's db), and the pool stream records nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LaunchLog } from "../lib/launch-log.mjs";
import { POOL_EVENT_PROGRAMS } from "../lib/indexer.mjs";
import { setup, frame, curveTrade, key, CURVE, KID, W, OTHER, T0 } from "./helpers/chain.mjs";
const FOREIGN = key(99); // a coin the model has never heard of
import { FIXTURE, FIXTURE_EVENT } from "./helpers/spawntx.mjs";

test("launch log: tracked and untracked curve trades and launches land in the log with slots; pool-stream deliveries and repeats add nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "launchlog-")), file = join(dir, "l.sqlite");
  try {
    const { db, ix } = setup();
    const ll = new LaunchLog({ file, flushMs: 60_000 });
    ix.launchLog = ll;
    const logs = frame(CURVE, curveTrade(FOREIGN, OTHER, { at: T0 + 5 }), curveTrade(KID, W, { at: T0 + 5, buy: false }));
    ix.onLogs({ slot: 900, signature: "S1", err: null, logs });
    ix.onLogs({ slot: 900, signature: "S1", err: null, logs }, POOL_EVENT_PROGRAMS); // the pool stream's copy
    ix.onLogs({ slot: 900, signature: "S1", err: null, logs });                     // a repeat
    ix.onLogs({ slot: 901, signature: "F1", err: { x: 1 }, logs });                // failed: nothing
    ix.onLogs({ slot: 902, signature: "C1", err: null, logs: FIXTURE.tx.meta.logMessages });
    ll.close();
    const r = new DatabaseSync(file, { readOnly: true });
    const trades = r.prepare("SELECT sig, i, slot, mint, t, buy, user FROM trades ORDER BY i").all().map((x) => ({ ...x }));
    assert.deepEqual(trades, [{ sig: "S1", i: 0, slot: 900, mint: FOREIGN, t: T0 + 5, buy: 1, user: OTHER }, { sig: "S1", i: 1, slot: 900, mint: KID, t: T0 + 5, buy: 0, user: W }]);
    const creates = r.prepare("SELECT mint, slot, depth FROM creates").all().map((x) => ({ ...x }));
    assert.deepEqual(creates, [{ mint: FIXTURE_EVENT.mint, slot: 902, depth: FIXTURE_EVENT.depth }]);
    r.close();
    assert.deepEqual(ll.snapshot().errors, 0);
    // the tree is untouched by the log: the untracked coin got no trade row
    const rows = (mint) => db.db.prepare("SELECT count(*) n FROM trades WHERE mint=?").get(mint).n;
    assert.equal(rows(FOREIGN), 0);
    assert.equal(rows(KID), 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("launch log: trim drops rows older than the kept hours", () => {
  const dir = mkdtempSync(join(tmpdir(), "launchlog-")), file = join(dir, "l.sqlite");
  try {
    const ll = new LaunchLog({ file, keepHours: 1, flushMs: 60_000 });
    const now = Math.floor(Date.now() / 1000);
    ll.trade({ mint: "A", timestamp: now - 7200, isBuy: true, user: "U", quoteAmount: "1", virtualQuoteReserves: "1", virtualTokenReserves: "1", quoteMint: null }, "OLD", 1, 0);
    ll.trade({ mint: "A", timestamp: now, isBuy: true, user: "U", quoteAmount: "1", virtualQuoteReserves: "1", virtualTokenReserves: "1", quoteMint: null }, "NEW", 2, 0);
    ll.flush(); ll.trim(); ll.close();
    const r = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(r.prepare("SELECT sig FROM trades").all().map((x) => x.sig), ["NEW"]);
    r.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
