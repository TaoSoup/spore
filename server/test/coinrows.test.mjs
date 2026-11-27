// Coin rows (lib/coinrows.mjs): the trailing timeframes (a trade at the cut is before it, $1+ distinct buyers), p0 and
// chg (the last trade at or before the start, else sqlite, else the first in it), the 2-minute line (steps, carry,
// nulls before the first trade, carry-in), the held hour (older seed rows ignored), the row filters of a family (no
// coin nobody bought in the trailing 5 min, dust, creator facts), /api/trending (order, limits, exclusions, parent and
// family tags), the sniper share from a recorded launch, holder facts in a row, GET /api/trending and ?tf=, the cost
// of one pass over 100 000 trades in slices, and the Nov 20 2026 review's rules: holding (bought and not sold since)
// and the rank by it, the 30m/1h enter-and-stay rule, the 1m floor of 5 buyers, firstSeenAt / graduated / thin; and
// the stories' post lines (lineWorld): one row as a single coin (`line: null`, or no field without a post), the
// server's own line for a post settled thin or refused, a mismatch line only on its own coin's card, `chain`, a
// "Quoted post" line only while that post can be shown, and the second ask once the quoted post can be read.
// A fake clock and sqlite in memory. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CoinRows, TF_S, SPARK_STEP, SPARK_N, HOLD_S, TREND_MAX, DUST_USD, FLOOR_1M, ENTER_5M, STAY_MS, parseTf, isDust } from "../lib/coinrows.mjs";
import { BUCKET_S, BASE_BUCKETS, GRACE_S, DEAD_SOLD_S, SNIPE_S } from "../lib/wakeups.mjs";
import { Holders } from "../lib/holders.mjs";
import { Narrative, postUrl } from "../lib/narrative.mjs";
import { NarrTags, userText } from "../lib/narrtags.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { createApp } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";
import { fakeClock } from "./helpers/chain.mjs";

const B = BUCKET_S, HOUR = 3600, DAY = 86_400;
/** A bucket edge and a 2-minute step edge: the line's first step starts at NOW - 29 x 120. */
const NOW = 1_770_000_000, K0 = NOW / B, FROM = NOW - (SPARK_N - 1) * SPARK_STEP;
const OLD = NOW - 2 * DAY;
const mintN = (i, fill = 6) => { const b = Buffer.alloc(32, fill); b.writeUInt32BE(i, 28); return new PublicKey(b).toBase58(); };
const PAR = mintN(1, 1);
const OPTS = { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet };

/** A model on a fake clock at NOW with PAR (a SOL coin worth $1e-5; its children $1e-5 too: $10 000 caps). */
function world({ at = NOW } = {}) {
  const clock = fakeClock(at * 1000), db = new Db(":memory:");
  const model = new Model(db, { ...OPTS, now: clock.now });
  model.load(); model.setSolUsd(100);
  model.wakeups.firstK = K0 - BASE_BUCKETS - 100; // well over 6 h of observed history: the rule may fire
  model.wakeups.attach({ hub: { emit() {} } });
  let seq = 0;
  const w = { clock, db, model, rows: model.coinRows, wk: model.wakeups };
  /** A coin; `parent` null makes a SOL root; `vq` its virtual quote reserves (raw): 1e9 under PAR is a $0.01 cap (dust); `extra` more coin fields. */
  w.coin = (mint, symbol, { parent = PAR, createdAt = OLD, launcher = null, vq = null, tracked = true, createdSlot = null, curve = null, extra = {} } = {}) => {
    model.upsertCoin({ mint, curve: curve ?? `C_${mint.slice(0, 8)}`, depth: parent ? 1 : 0, quoteMint: parent, ...base, virtualQuoteReserves: vq ?? (parent ? "1000000000000000" : "100000000000"), createdAt, createdSlot, launcher, tracked, ...extra });
    model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, uri: `https://ipfs.io/ipfs/${mint}`, onchainAt: 1 });
    model.setMeta(`https://ipfs.io/ipfs/${mint}`, { image: `https://ipfs.io/ipfs/img-${symbol}`, description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true });
    return mint;
  };
  w.trade = (mint, user, time, { usd = 5, isBuy = true, priceUsd = 1e-5, baseAmount = "1000", slot = null } = {}) =>
    model.recordTrade({ sig: `S${seq++}`, mint, idx: 0, slot: slot ?? seq, time, isBuy, user, baseAmount, quoteAmount: "1", priceQuote: 1, priceUsd, valueUsd: usd });
  /** A row stored in sqlite only (as a restart's older history; `keep` lifts the per-mint trim). */
  w.stored = (mint, time, priceUsd, { user = "s", isBuy = true, baseAmount = "1", slot = 1 } = {}) =>
    db.insertTrade({ sig: `D${seq++}`, mint, idx: 0, slot, time, isBuy, user, baseAmount, quoteAmount: "1", priceQuote: 1, priceUsd, valueUsd: 5 }, 1e9);
  w.snap = (s = NOW) => { clock.t = s * 1000; return w.rows.snapNow(); };
  w.row = (mint, tf = "5m", snap = w.snap()) => w.rows.row(model.get(mint), snap, tf);
  w.close = () => { w.wk.stop(); db.close(); };
  w.coin(PAR, "PAR", { parent: null, createdAt: OLD - DAY });
  return w;
}

test("parseTf: the four timeframes, 5m by default, null for anything else; isDust: a known cap under $1 000", () => {
  assert.deepEqual(["1m", "5m", "30m", "1h", undefined, ""].map(parseTf), ["1m", "5m", "30m", "1h", "5m", "5m"]);
  assert.deepEqual(["2m", "1H", "5", ["5m"], "__proto__", "toString"].map(parseTf), [null, null, null, null, null, null]);
  assert.deepEqual([isDust({ mcapUsd: null }), isDust({ mcapUsd: DUST_USD - 0.01 }), isDust({ mcapUsd: DUST_USD })], [false, true, false]);
  assert.deepEqual(TF_S, { "1m": 60, "5m": 300, "30m": 1800, "1h": 3600 });
});

test("timeframes: the trailing window (now - tf, now]; buys, sells, USD volume, distinct $1+ buyers; one pass serves all four", () => {
  const w = world();
  const A = w.coin(mintN(100), "A");
  w.trade(A, "u0", NOW - 3600, { usd: 7 });               // at the 1 h cut: before it
  w.trade(A, "u1", NOW - 3599, { usd: 2 });
  w.trade(A, "u5", NOW - 300, { usd: 2 });                // at the 5m cut
  w.trade(A, "u6", NOW - 299, { usd: 2 });
  w.trade(A, "u1", NOW - 60, { usd: 5 });                 // at the 1m cut
  w.trade(A, "u2", NOW - 59, { usd: 5 });
  w.trade(A, "u2", NOW - 30, { usd: 3 });                 // the same wallet again: one buyer
  w.trade(A, "u3", NOW - 20, { usd: 4, isBuy: false });   // a sell: no buyer
  w.trade(A, "u4", NOW - 10, { usd: 0.5 });               // under $1: a buy, not a buyer
  const snap = w.snap();
  const tf = (k) => w.rows.row(w.model.get(A), snap, k).tf;
  const pick = (k) => { const t = tf(k); return [t.buys, t.sells, t.volUsd, t.buyers]; };
  assert.deepEqual(pick("1m"), [3, 1, 12.5, 1], "u2 only: u3 sold, u4 bought $0.50, u1 is at the cut");
  assert.deepEqual(pick("5m"), [5, 1, 19.5, 3], "u6, u1, u2");
  assert.deepEqual(pick("30m"), [6, 1, 21.5, 4], "u5, at the 5m cut, is inside 30 min");
  assert.deepEqual(pick("1h"), [7, 1, 23.5, 4], "u1, u6, u5, u2; u0 is at the 1 h cut");
  assert.equal(w.rows.row(w.model.get(A), snap, "1m").buyers5m, 3, "buyers5m: the 5m timeframe's buyers on every timeframe");
  assert.equal(w.rows.stats.snaps, 0, "snapNow is not counted as a served snapshot");
  w.close();
});

test("p0 and chg: the last priced trade at or before the start, else the stored rows, else the first trade in it; chg vs the price now, 1 dp", () => {
  const w = world();
  const [A, Bc, C, D, E] = [0, 1, 2, 3, 4].map((i) => w.coin(mintN(110 + i), `P${i}`));
  // A: 2e-5 at the 5m cut (before the window), then 4e-5 in it: p0 2e-5, the model's price 1e-5: -50 %
  w.trade(A, "a", NOW - 300, { priceUsd: 2e-5 }); w.trade(A, "a", NOW - 100, { priceUsd: 4e-5 });
  // B: traded only inside the window: its first trade there
  w.trade(Bc, "b", NOW - 200, { priceUsd: 8e-6 }); w.trade(Bc, "b", NOW - 100, { priceUsd: 9e-6 });
  // C: a stored trade 2 h back (not held), then one in the window: the stored price
  w.stored(C, NOW - 2 * HOUR, 5e-6); w.trade(C, "c", NOW - 100, { priceUsd: 7e-6 });
  // D: nothing at all; E: an unpriced trade before the cut is passed over
  w.trade(E, "e", NOW - 400, { priceUsd: 4e-6 }); w.trade(E, "e", NOW - 350, { priceUsd: null });
  const snap = w.snap();
  const now = w.model.priceOf(A).priceUsd; // the model's price from reserves: 1e-5 (to a float's last digit)
  assert.ok(Math.abs(now - 1e-5) < 1e-15);
  const t = (m) => { const r = w.rows.row(w.model.get(m), snap, "5m"); return [r.priceUsd, r.tf.p0, r.tf.chg]; };
  assert.deepEqual(t(A), [now, 2e-5, -50]);
  assert.deepEqual(t(Bc), [now, 8e-6, 25]);
  assert.deepEqual(t(C), [now, 5e-6, 100]);
  assert.deepEqual(t(D), [now, null, null]);
  assert.deepEqual(t(E), [now, 4e-6, 150]);
  // the 1m timeframe of A: its 4e-5 at NOW - 100 is before it
  assert.deepEqual(w.rows.row(w.model.get(A), snap, "1m").tf.p0, 4e-5);
  w.close();
});

test("the line: 30 two-minute USD closes over the last hour, oldest first, carried forward, null before the first trade; carry-in from the held hour or sqlite", () => {
  const w = world();
  const [S, T, U, V, N] = [0, 1, 2, 3, 4].map((i) => w.coin(mintN(120 + i), `S${i}`));
  w.trade(S, "s", FROM + 5, { priceUsd: 1 }); w.trade(S, "s", FROM + 130, { priceUsd: 2 }); w.trade(S, "s", FROM + 200, { priceUsd: 3 }); w.trade(S, "s", FROM + 600, { priceUsd: 4 });
  w.trade(S, "s", FROM + 610, { priceUsd: null }); // unpriced: the close stays
  w.trade(T, "t", FROM + 2 * SPARK_STEP + 1, { priceUsd: 5 });
  w.stored(U, NOW - 2 * HOUR, 7);
  w.trade(V, "v", FROM - 20, { priceUsd: 8 }); // before the first step, inside the held hour
  w.trade(S, "s", NOW + 30, { priceUsd: 6 });  // in the current step (the last one)
  const snap = w.snap(NOW + 60);
  const sp = (m) => w.rows.row(w.model.get(m), snap, "5m").spark;
  const s = sp(S);
  assert.deepEqual([s.from, s.step, s.p.length], [FROM, SPARK_STEP, SPARK_N]);
  assert.deepEqual(s.p.slice(0, 7), [1, 3, 3, 3, 3, 4, 4]);
  assert.deepEqual(s.p.slice(-2), [4, 6], "the step now is in: its latest trade");
  assert.deepEqual(sp(T).p.slice(0, 4), [null, null, 5, 5], "null before its first trade");
  assert.ok(sp(U).p.every((x) => x === 7), "carried in from sqlite");
  assert.ok(sp(V).p.every((x) => x === 8), "carried in from the held hour");
  assert.ok(sp(N).p.every((x) => x === null), "never traded");
  w.close();
});

test("the held hour: the seed's older rows and anything past HOLD_S are let go; a restart's seed fills the numbers again", () => {
  const w = world();
  const A = w.coin(mintN(130), "A");
  w.stored(A, NOW - HOLD_S - 1, 1e-5, { user: "old" }); w.stored(A, NOW - 100, 1e-5, { user: "seed" });
  w.trade(A, "live", NOW - 50);
  const again = new Model(w.db, { ...OPTS, now: w.clock.now });
  again.load();
  assert.deepEqual([again.coinRows.snapshot().held, again.coinRows.snapshot().seedRows], [2, 2], "the seed's last hour: two rows");
  const r = again.coinRows.row(again.get(A), again.coinRows.snapNow(), "5m");
  assert.deepEqual([r.tf.buys, r.tf.buyers, r.buyers5m], [2, 2, 2]);
  // an hour later everything is let go
  w.clock.t = (NOW + HOLD_S) * 1000;
  w.trade(A, "next", NOW + HOLD_S - 1);
  assert.equal(w.rows.snapshot().held, 1);
  again.wakeups.stop(); w.close();
});

test("a family's coins: only coins bought ($1+) in the trailing 5 min, never dust (counted), never creator-fact coins (hidden); rows carry the timeframe asked", async () => {
  const w = world();
  const E = [0, 1, 2].map((i) => w.coin(mintN(140 + i), `E${i}`));
  const dust = w.coin(mintN(143), "DUST", { vq: "1000000000" });           // a $0.01 cap
  const sold = w.coin(mintN(144), "SOLD");                                  // bought in the burst only, then sold
  const L = mintN(9, 9);
  w.coin(mintN(145), "DUP", { launcher: L, createdAt: OLD - 100 });
  const relaunch = w.coin(mintN(146), "DUP", { launcher: L });              // a relaunch of its ticker under PAR
  for (let i = 0; i < 50; i++) w.trade([...E, dust, sold, relaunch][i % 6], `b${i}`, K0 * B + i);
  w.trade(sold, "x", K0 * B + 200, { isBuy: false });
  for (const m of [E[0], E[1], dust, relaunch]) w.trade(m, `late${m.slice(0, 4)}`, K0 * B + 250);
  w.clock.t = (K0 * B + 260) * 1000;
  const body = await w.wk.serve("1h");
  const [f] = body.families;
  assert.equal(body.tf, "1h");
  assert.deepEqual(f.coins.map((c) => c.symbol), ["E0", "E1", "SOLD", "E2"], "every one was bought in the trailing 5 min (the burst is inside it): 10, 10, 8 and 8 buyers, SOLD's sale adds to its volume");
  assert.deepEqual([f.hidden, f.dust, f.more], [1, 1, 0]);
  assert.ok(f.coins.every((c) => c.buyers5m >= 1));
  // 4 min later only E0, E1 (and the dust, still left out) were bought within 5 min
  w.wk.forget();
  w.clock.t = (K0 * B + 250 + 240) * 1000;
  const [g] = (await w.wk.serve("5m")).families;
  assert.deepEqual([g.coins.map((c) => c.symbol), g.dust, g.more, g.hidden], [["E0", "E1"], 1, 0, 1], "SOLD was only sold in the 5 min: not in more, which counts coins bought, as the headline does");
  assert.equal(g.coinsTrading, g.coins.length + g.more + g.hidden + g.dust);
  assert.deepEqual(g.coins[0].tf.buyers, 1);
  // once nothing of the family traded in the 5 minutes, the relaunch is no longer counted as hidden (it was counted
  // for as long as the wake-up lasted, beside two counts over 5 minutes)
  w.wk.forget();
  w.clock.t = (K0 * B + 250 + 300 + GRACE_S + 1) * 1000; // the trailing window is moved to 5 s ago: its buys leave up to 5 s after the rows'
  const [h] = (await w.wk.serve("5m")).families;
  assert.deepEqual([h.coins.length, h.hidden, h.more, h.coinsTrading], [0, 0, 0, 0]);
  w.close();
});

test("/api/trending: most buyers who have not sold over the timeframe, then volume, then the mint; at most 50; no coin nobody bought, no dust, no creator-fact coin; parent and family tags", async () => {
  const w = world();
  const E = [0, 1, 2].map((i) => w.coin(mintN(150 + i), `E${i}`));
  const root = w.coin(mintN(160, 2), "ROOT", { parent: null, createdAt: OLD });
  const dust = w.coin(mintN(161), "DUST", { vq: "1000000000" });
  const L = mintN(9, 9);
  w.coin(mintN(162), "DUP", { launcher: L, createdAt: OLD - 100 });
  const relaunch = w.coin(mintN(163), "DUP", { launcher: L });
  const seller = w.coin(mintN(164), "SELL");
  const untracked = w.coin(mintN(165), "UNT", { tracked: false });
  // PAR wakes: 50 buyers over E0-E2 in bucket K0
  for (let i = 0; i < 50; i++) w.trade(E[i % 3], `w${i}`, K0 * B + i);
  for (let i = 0; i < 60; i++) w.trade(root, `r${i}`, K0 * B + 60 + (i % 100)); // 60 buyers: first
  for (let i = 0; i < 80; i++) { w.trade(dust, `d${i}`, K0 * B + 100); w.trade(relaunch, `d${i}`, K0 * B + 100); }
  w.trade(seller, "s", K0 * B + 100, { isBuy: false, usd: 1000 });
  w.trade(untracked, "u", K0 * B + 100);
  w.clock.t = (K0 * B + 200) * 1000;
  const asked = [];
  w.rows.attach({ holders: { get: (c) => { asked.push(c.mint); return { devPct: null, top10Pct: null, state: "pending" }; } } });
  const body = await w.rows.trending("5m");
  assert.deepEqual(Object.keys(body), ["asOf", "tf", "floor", "floor5m", "candidates", "rows"]);
  assert.deepEqual([body.floor, body.floor5m, body.candidates], [0, 0, 6], "5m: no floor; ROOT, E0-E2, the dust coin and the relaunch were bought");
  assert.deepEqual(asked, body.rows.map((r) => r.mint), "holder reads are asked for the listed rows only, in list order (not the dust row)");
  assert.equal(body.rows[0].safety.state, "pending");
  assert.deepEqual(body.rows.map((r) => r.symbol), ["ROOT", "E0", "E1", "E2"], "E0 and E1 have 17 buyers, E2 16");
  const [r0, e0] = body.rows;
  assert.deepEqual([r0.parent, r0.family, r0.tf.buyers, r0.sinceStart], [null, null, 60, null], "a SOL root: no parent");
  assert.deepEqual(e0.parent, { mint: PAR, symbol: "PAR", image: `/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/img-PAR")}` });
  assert.deepEqual([e0.family, typeof e0.sinceStart], ["live", "number"], "its family is waking: tagged live, sinceStart measured");
  assert.deepEqual(Object.keys(e0), ["mint", "name", "symbol", "image", "createdAt", "existing", "mcapUsd", "priceUsd", "sinceStart", "buyers5m", "tf", "liqUsd", "spark", "safety", "firstSeenAt", "graduated", "thin", "parent", "family"]);
  assert.equal(e0.liqUsd, 0, "no real quote on its curve: its 1e9 PAR of virtual quote is not liquidity");
  // the 1h list is its own build; cached 5 s per timeframe
  assert.deepEqual((await w.rows.trending("1h")).tf, "1h");
  const built = w.rows.stats.trendBuilt;
  await w.rows.trending("5m");
  assert.equal(w.rows.stats.trendBuilt, built, "cached");
  // at most 50, ties by volume then the mint
  const many = Array.from({ length: 60 }, (_, i) => w.coin(mintN(200 + i), `M${i}`));
  many.forEach((m, i) => w.trade(m, `m${i}`, K0 * B + 210, { usd: 1 + i }));
  w.wk.forget();
  w.clock.t = (K0 * B + 220) * 1000;
  const big = await w.rows.trending("5m");
  assert.equal(big.rows.length, TREND_MAX);
  assert.deepEqual(big.rows.slice(0, 6).map((r) => r.symbol), ["ROOT", "E0", "E1", "E2", "M59", "M58"], "1 buyer each: the larger volume first");
  assert.equal(big.candidates, 66, "every coin somebody bought, the ones not listed too");
  w.close();
});

test("the sniper share: buys by others in the creation slot or its first 3 s, from the open launch window, its record, a restart, else the rows while they reach the launch", () => {
  const w = world();
  const L = mintN(7, 9), at = NOW - 100;
  const A = w.coin(mintN(170), "SNP", { launcher: L, createdAt: at, createdSlot: 500 });
  w.trade(A, L, at, { baseAmount: "100000000000000", slot: 500 });               // the creator: never a sniper
  w.trade(A, "bot1", at, { baseAmount: "50000000000000", slot: 500 });           // the launch slot: 5 %
  w.trade(A, "bot2", at + SNIPE_S, { baseAmount: "20000000000000", slot: 501 }); // 3 s: 2 %
  w.trade(A, "late", at + 4, { baseAmount: "90000000000000", slot: 509 });       // after: not counted
  w.trade(A, "slot", at + 6, { baseAmount: "10000000000000", slot: 500 });       // a late print of the launch slot: 1 %
  w.trade(A, "bot1", at + 2, { isBuy: false, baseAmount: "50000000000000", slot: 502 }); // a sale does not lower it
  assert.equal(w.wk.sniperOf(w.model.get(A)), 8, "8 % of the 1e15 supply, from the open window");
  w.wk.tick(at + DEAD_SOLD_S + GRACE_S);
  assert.equal(w.db.launchFlowGet(A).sniped, 80_000_000_000_000);
  w.db.db.exec("DELETE FROM trades");
  const again = new Model(w.db, { ...OPTS, now: () => (at + DAY) * 1000 });
  again.load();
  assert.equal(again.wakeups.sniperOf(again.get(A)), 8, "the record, after the rows are gone and a restart");
  // a coin without a record: its rows decide while they reach the launch, else unknown
  const R = w.coin(mintN(171), "ROWS", { launcher: L, createdAt: OLD, createdSlot: 7 });
  w.stored(R, OLD, 1e-5, { user: "b", baseAmount: "30000000000000", slot: 7 });
  const G = w.coin(mintN(172), "GONE", { launcher: L, createdAt: OLD });
  w.stored(G, OLD + 3600, 1e-5, { user: "b", baseAmount: "30000000000000" });
  const N = w.coin(mintN(173), "NOKEY", { createdAt: OLD });
  assert.deepEqual([w.wk.sniperOf(w.model.get(R)), w.wk.sniperOf(w.model.get(G)), w.wk.sniperOf(w.model.get(N))], [3, null, null]);
  // in a row
  const row = w.rows.row(w.model.get(R), w.snap(), "5m");
  assert.deepEqual(row.safety, { devPct: null, top10Pct: null, sniperPct: 3, state: "unknown" });
  again.wakeups.stop(); w.close();
});

test("an old launch_flow table gets the sniped column on open; its old rows read as unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-snipe-db-")), file = join(dir, "old.db");
  let d = new Db(file);
  d.db.exec("DROP TABLE launch_flow; CREATE TABLE launch_flow (mint TEXT PRIMARY KEY, bought REAL NOT NULL, sold REAL NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID; INSERT INTO launch_flow VALUES ('M', 1, 2, 3)");
  d.close();
  d = new Db(file);
  assert.deepEqual([d.launchFlowGet("M"), d.launchFlowPut("N", 1, 1, 1, 42), d.launchFlowGet("N").sniped], [{ bought: 1, sold: 2, createdAt: 3, sniped: null }, true, 42]);
  d.close(); rmSync(dir, { recursive: true, force: true });
});

test("liqUsd: the real quote side (the curve's real quote reserves, the pool's quote vault once migrated) in USD, never the curve's virtual reserves", () => {
  const w = world();
  // a SOL root 1 minute old: 0.25 SOL of real buys on a curve that started at 30 virtual SOL (SOL at $100)
  const young = w.coin(mintN(190, 2), "YOUNG", { parent: null, vq: "30250000000", extra: { realQuoteReserves: "250000000", initialVirtualQuoteReserves: "30000000000" } });
  const moved = w.coin(mintN(191, 2), "MOVED", { parent: null, extra: { migrated: true, poolQuote: "2000000000", realQuoteReserves: "0" } });
  const child = w.coin(mintN(192), "KID", { extra: { realQuoteReserves: "1000000000" } }); // 1 000 PAR at $1e-5
  const bare = w.coin(mintN(193), "BARE");
  assert.deepEqual([young, moved, child, bare].map((m) => w.row(m).liqUsd), [25, 200, 0.01, 0], "not the 3 025 dollars of virtual quote");
  w.close();
});

test("holder facts in a row: pending until read, then the measured shares (lib/holders.mjs on a fake lane)", async () => {
  const w = world();
  // the 20 largest accounts' owners: the bonding curve (its unsold supply), the dev, two wallets
  const owners = [mintN(31, 5), mintN(8, 9), mintN(32, 5), mintN(33, 5)];
  const A = w.coin(mintN(180), "HOLD", { launcher: owners[1], curve: owners[0] });
  const amounts = ["600000000000000", "40000000000000", "30000000000000", "20000000000000"];
  const rpc = {
    calls: [],
    async call(method, params) {
      this.calls.push(method);
      if (method === "getTokenLargestAccounts") return { value: amounts.map((a, i) => ({ address: mintN(90 + i, 7), amount: a })) };
      if (method === "getMultipleAccounts") return { value: params[0].map((_, i) => ({ data: [new PublicKey(owners[i]).toBuffer().toString("base64"), "base64"] })) };
      throw new Error(`unexpected ${method}`);
    },
  };
  const holders = new Holders({ model: w.model, rpc, now: w.clock.now, log: quiet });
  w.rows.attach({ holders });
  assert.deepEqual(w.row(A).safety, { devPct: null, top10Pct: null, sniperPct: null, state: "pending" });
  await holders.settle();
  assert.deepEqual(w.row(A).safety, { devPct: 4, top10Pct: 9, sniperPct: null, state: "ok" }, "the curve's 60 % left out; the dev is among the 20 largest: 2 calls");
  assert.deepEqual(rpc.calls, ["getTokenLargestAccounts", "getMultipleAccounts"]);
  holders.stop(); w.close();
});

async function serveApp(w, more = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spore-rows-api-"));
  const hub = new EventHub({ heartbeatMs: 60_000 });
  const app = createApp({ model: w.model, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc: { call: async () => { throw new Error("no chain in this test"); } }, hub, images: new ImageCache(dir), meta: null,
    platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet, now: w.clock.now, ...more });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (p, headers = {}) => fetch(url + p, { headers }).then(async (r) => { const text = await r.text(); return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null }; }),
    close: async () => { await new Promise((r) => server.close(r)); hub.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("GET /api/trending and ?tf= on /api/discover(/:mint): bodies, 5 s with no stale-while-revalidate, 400 for an unknown timeframe; health carries `coinRows`", async () => {
  const w = world();
  const E = [0, 1, 2].map((i) => w.coin(mintN(190 + i), `E${i}`));
  for (let i = 0; i < 50; i++) w.trade(E[i % 3], `w${i}`, K0 * B + i);
  w.clock.t = (K0 * B + 100) * 1000;
  const app = await serveApp(w);
  try {
    const t = await app.get("/api/trending?tf=30m");
    assert.deepEqual([t.status, t.headers.get("cache-control"), t.body.tf, t.body.rows.map((r) => r.symbol)], [200, "public, max-age=5", "30m", ["E0", "E1", "E2"]]);
    assert.equal((await app.get("/api/trending")).body.tf, "5m");
    for (const p of ["/api/trending?tf=2m", "/api/discover?tf=1d", `/api/discover/${PAR}?tf=x`]) assert.deepEqual([(await app.get(p)).status, (await app.get(p)).body], [400, { error: "tf must be 1m, 5m, 30m or 1h" }], p);
    const d = await app.get("/api/discover?tf=1m");
    assert.deepEqual([d.status, d.body.tf, d.body.families[0].coins[0].tf.buyers >= 0], [200, "1m", true]);
    const one = await app.get(`/api/discover/${PAR}?tf=1h`);
    assert.deepEqual([one.status, one.body.state, one.body.coins[0].tf.buyers], [200, "live", 17]);
    const health = (await app.get("/api/health")).body;
    assert.deepEqual([typeof health.coinRows.held, health.coinRows.holders], ["number", null]);
  } finally { await app.close(); }
  w.close();
});

test("cost: one pass over 100 000 trades of the last hour runs in slices, records are O(1), and the buyer sets are let go", async (t) => {
  const w = world();
  const N = 100_000, COINS = 2_000;
  const mints = Array.from({ length: COINS }, (_, i) => mintN(10_000 + i, 3));
  // straight into the feed (no sqlite): the cost under test is the pass
  const t0 = performance.now();
  for (let i = 0; i < N; i++) w.rows.record({ mint: mints[i % COINS], time: NOW - 3599 + Math.floor((i * 3599) / N), isBuy: i % 3 !== 0, user: `u${i % 7_000}`, valueUsd: 1 + (i % 50), priceUsd: 1e-5 * (1 + (i % 7)) });
  const recMs = performance.now() - t0;
  w.clock.t = NOW * 1000;
  const t1 = performance.now();
  const snap = await w.rows.snap();
  const wall = performance.now() - t1;
  const s = w.rows.snapshot();
  assert.equal(s.held, N);
  assert.equal(snap.per.size, COINS);
  assert.ok(recMs / N < 0.02, `record: ${(recMs / N * 1000).toFixed(2)} µs per trade`);
  assert.ok(s.lastSnapMs < 2_000, `one pass: ${s.lastSnapMs} ms of CPU (wall ${wall.toFixed(0)} ms)`);
  assert.ok(s.maxSliceMs < 60, `longest slice ${s.maxSliceMs} ms`);
  for (const A of snap.per.values()) for (const T of A.tf) { assert.equal(T.w, null); assert.ok(T.holding >= 0 && T.holding <= T.buyers); }
  t.diagnostic(`one pass over ${N} trades: ${s.lastSnapMs} ms CPU, longest slice ${s.maxSliceMs} ms, record ${(recMs / N * 1000).toFixed(2)} us/trade`);
  const T = snap.per.get(mints[1]).tf[3];
  assert.ok(T.buys > 0 && T.buyers > 0 && T.buyers <= T.buys);
  w.close();
});

// ---------------------------------------------------------------- the Nov 20 2026 review: its measured cases

test("holding: the wallets that bought ($1+) in the window and have not sold since their first buy in it; trending ranks by it, then volume, then the mint", async () => {
  const w = world();
  const flip = w.coin(mintN(500), "FLIP"), kept = w.coin(mintN(501), "KEPT"), tie = w.coin(mintN(502), "TIE");
  w.trade(flip, "early", NOW - 1000);                                              // bought before the 5 minutes...
  w.trade(flip, "s", NOW - 250, { isBuy: false });                                 // a sale before its first buy takes nothing away
  for (let i = 0; i < 10; i++) w.trade(flip, `a${i}`, NOW - 200 + i);
  for (let i = 0; i < 6; i++) w.trade(kept, `k${i}`, NOW - 200 + i);
  for (let i = 0; i < 4; i++) w.trade(tie, `t${i}`, NOW - 200 + i);
  for (let i = 0; i < 7; i++) w.trade(flip, `a${i}`, NOW - 100 + i, { isBuy: false, usd: 0.5 }); // any sale counts, a partial one under $1 too
  w.trade(flip, "early", NOW - 90, { isBuy: false });                              // ...and sold inside them: no buyer of the 5 minutes
  w.trade(flip, "a0", NOW - 50);                                                   // buying again after selling does not bring a wallet back
  w.trade(flip, "s", NOW - 40);
  const snap = w.snap();
  const of = (m, tf) => { const t = w.rows.row(w.model.get(m), snap, tf).tf; return [t.buyers, t.holding]; };
  assert.deepEqual([of(flip, "5m"), of(kept, "5m"), of(tie, "5m")], [[11, 4], [6, 6], [4, 4]], "FLIP: a7-a9 and s still hold");
  assert.deepEqual([of(flip, "1h"), of(flip, "1m")], [[12, 4], [2, 2]], "over 1 h `early` is a buyer that sold; over 1m a0 and s bought and did not sell in it");
  const body = await w.rows.trending("5m");
  assert.deepEqual(body.rows.map((r) => [r.symbol, r.tf.buyers, r.tf.holding]), [["KEPT", 6, 6], ["FLIP", 11, 4], ["TIE", 4, 4]], "6 holding before 4; FLIP's larger volume before TIE; most buyers is not first");
  w.close();
});

test("holding goes by the trades' own times: rows read back from the chain arrive late, and an older sale does not cancel a later buy (an older buy still counts a later sale)", () => {
  const w = world();
  const fill = (mint, user, time, isBuy) => w.model.storeFilled({ sig: `F${mint.slice(-4)}${user}${time}`, mint, idx: 0, slot: 1, time, isBuy, user, baseAmount: "1000", quoteAmount: "1", priceQuote: 1, priceUsd: 1e-5, valueUsd: 5 });
  const a = w.coin(mintN(520), "LATE"), b = w.coin(mintN(521), "GAP"), c = w.coin(mintN(522), "TIE");
  // LATE: six wallets bought (seen live); their sales of a minute BEFORE were missed and are filled in afterwards
  for (let i = 0; i < 6; i++) w.trade(a, `h${i}`, NOW - 100 + i);
  for (let i = 0; i < 6; i++) fill(a, `h${i}`, NOW - 160, false);
  // GAP: the sales were seen live, the buys before them were missed: filled in, they are buyers that sold
  for (let i = 0; i < 4; i++) w.trade(b, `g${i}`, NOW - 50, { isBuy: false });
  for (let i = 0; i < 4; i++) fill(b, `g${i}`, NOW - 120, true);
  fill(b, "g0", NOW - 200, true); fill(b, "keep", NOW - 30, true); // an even earlier buy changes nothing; a wallet that only bought holds
  // TIE: a sale in the same second as the first buy counts as sold, whichever arrived first
  w.trade(c, "t0", NOW - 20); w.trade(c, "t0", NOW - 20, { isBuy: false });
  w.trade(c, "t1", NOW - 20, { isBuy: false }); w.trade(c, "t1", NOW - 20);
  w.trade(c, "t2", NOW - 20);
  const snap = w.snap();
  const of = (m, tf = "5m") => { const t = w.rows.row(w.model.get(m), snap, tf).tf; return [t.buyers, t.holding, t.buys, t.sells]; };
  assert.deepEqual([of(a), of(b), of(c)], [[6, 6, 6, 6], [5, 1, 6, 4], [3, 1, 3, 2]]);
  assert.deepEqual(of(a, "1m"), [0, 0, 0, 0], "nothing in the last minute");
  for (const A of snap.per.values()) for (const T of A.tf) assert.equal(T.w, null, "the wallet maps are let go");
  w.close();
});

test("trending over 30m and 1h: a coin enters with 3+ buyers in the last 5 minutes and stays while it has 1+; 5m has no such rule", async () => {
  const w = world();
  const done = w.coin(mintN(510), "DONE"), on = w.coin(mintN(511), "ON"), two = w.coin(mintN(512), "TWO");
  for (const m of [done, on, two]) for (let i = 0; i < 10; i++) w.trade(m, `x${i}`, NOW - 1200 + i); // a burst 20 min ago
  for (const [u, s] of [["o1", -290], ["o2", -280], ["o3", -20]]) w.trade(on, u, NOW + s);
  w.trade(two, "t1", NOW - 30); w.trade(two, "t2", NOW - 25);
  const at = async (s, tf = "30m") => { w.clock.t = s * 1000; const b = await w.rows.trending(tf); return [b.rows.map((r) => r.symbol), b.candidates]; };
  assert.deepEqual(await at(NOW), [["ON"], 1], "DONE has 10 buyers in the 30 min and none now; TWO has 2 in the 5 min");
  const b = await w.rows.trending("30m");
  assert.deepEqual([b.floor, b.floor5m, b.rows[0].tf.buyers, b.rows[0].buyers5m], [0, ENTER_5M, 13, 3]);
  assert.deepEqual(await at(NOW, "1h"), [["ON"], 1]);
  assert.deepEqual((await at(NOW, "5m"))[0], ["ON", "TWO"], "the 5m list is every coin bought in it");
  assert.deepEqual(await at(NOW + 60), [["ON"], 1], "one buyer left in its 5 minutes: it stays (it was in the list a minute ago)");
  assert.deepEqual(await at(NOW + 110), [["ON"], 1]);
  assert.deepEqual(await at(NOW + 110 + STAY_MS / 1000 + 1), [[], 0], "the list was not asked for 2 minutes: nothing stays on a list nobody saw, and 1 buyer does not enter");
  // TWO gets its third buyer: it enters; ON's last buyer has left its 5 minutes
  w.trade(two, "t3", NOW + 240);
  assert.deepEqual(await at(NOW + 250), [["TWO"], 1], "t1, t2 and t3 are inside the 5 minutes");
  assert.deepEqual(await at(NOW + 300), [["TWO"], 1], "t3 alone: it stays");
  assert.deepEqual(await at(NOW + 541), [[], 0], "no buyer in the 5 minutes: gone");
  w.trade(two, "t4", NOW + 545);
  assert.deepEqual(await at(NOW + 550), [[], 0], "and one buyer does not bring it back");
  w.close();
});

test("trending over 1m: only coins with 5+ buyers in the last 60 s; the list may be short or empty", async () => {
  const w = world();
  const five = w.coin(mintN(520), "FIVE"), four = w.coin(mintN(521), "FOUR");
  for (let i = 0; i < 3; i++) w.trade(four, `p${i}`, NOW - 100);
  for (let i = 0; i < 5; i++) w.trade(five, `f${i}`, NOW - 30);
  for (let i = 0; i < 4; i++) w.trade(four, `g${i}`, NOW - 30);
  let b = await w.rows.trending("1m");
  assert.deepEqual([b.floor, b.floor5m, b.candidates, b.rows.map((r) => [r.symbol, r.tf.buyers])], [FLOOR_1M, 0, 1, [["FIVE", 5]]], "4 buyers in the minute is under the floor");
  b = await w.rows.trending("5m");
  assert.deepEqual([b.floor, b.candidates, b.rows.map((r) => [r.symbol, r.tf.buyers])], [0, 2, [["FOUR", 7], ["FIVE", 5]]], "no floor on 5m");
  w.clock.t = (NOW + 40) * 1000;
  b = await w.rows.trending("1m");
  assert.deepEqual([b.candidates, b.rows], [0, []], "nobody with 5 in the last minute: an empty list, not one padded with one-buyer rows");
  w.close();
});

test("row facts: firstSeenAt for an undated coin (its first stored trade, remembered), graduated, thin only for a $1M+ cap on under 1 % real liquidity", () => {
  const w = world();
  const undated = w.coin(mintN(530), "NODATE", { createdAt: null }), dated = w.coin(mintN(531), "DATED");
  w.stored(undated, NOW - 2400, 1e-5); w.trade(undated, "u", NOW - 10); w.trade(dated, "u", NOW - 10);
  let r = w.row(undated);
  assert.deepEqual([r.createdAt, r.firstSeenAt, r.existing, w.row(dated).firstSeenAt], [null, NOW - 2400, true, null], "seen for 40 min at least; a dated coin has its age");
  // the trim deletes its oldest rows: the time first read stays (a later one would make "seen 40m+" shrink)
  w.db.db.prepare("DELETE FROM trades WHERE mint = ? AND time < ?").run(undated, NOW - 100);
  assert.deepEqual([w.row(undated).firstSeenAt, w.rows.stats.firstReads], [NOW - 2400, 1]);
  const never = w.coin(mintN(532), "NOTRADE", { createdAt: null });
  assert.equal(w.row(never).firstSeenAt, null, "no stored trade: unknown");
  const grad = w.coin(mintN(533, 2), "GRAD", { parent: null, extra: { migrated: true, poolQuote: "2000000000", realQuoteReserves: "0" } });
  assert.deepEqual([w.row(grad).graduated, w.row(dated).graduated], [true, false]);
  // caps of $2M (virtual quote 2e17) and $10K (1e15); real quote of $0 / $19 999 / $20 000
  const big = (i, real) => w.coin(mintN(540 + i), `BIG${i}`, { vq: "200000000000000000", extra: { realQuoteReserves: real } });
  const rows = [big(0, "0"), big(1, "1999900000000000"), big(2, "2000000000000000"), dated].map((m) => w.row(m));
  assert.deepEqual(rows.map((x) => [x.mcapUsd, x.liqUsd, x.thin]), [[2_000_000, 0, true], [2_000_000, 19_999, true], [2_000_000, 20_000, false], [10_000, 0, false]],
    "over 100x: thin; exactly 100x is not; a $10K child sold back to its start has no real reserves either and is not flagged");
  w.close();
});

test("GET /api/stories: the trending rows as cards (a waking family, a post coins link across parents), the loose rows, bot dust apart; trending and discover unchanged beside it", async () => {
  const w = world();
  const idAt = (s, n = 0) => String(((BigInt(s * 1000) - 1288834974657n) << 22n) + BigInt(n));
  const links = (mint, id) => w.model.setMeta(`https://ipfs.io/ipfs/${mint}`, { image: `https://ipfs.io/ipfs/img-${mint.slice(0, 4)}`, description: null, twitter: `https://x.com/anyone/status/${id}`, telegram: null, website: null, fetchedAt: 1, ok: true });
  const T0 = K0 * B, X = idAt(T0 - 600, 1), BAD = idAt(T0 - 500, 2), UNSEEN = idAt(T0 - 400, 3);
  // PAR wakes: 50 wallets on its three old children
  const E = [0, 1, 2].map((i) => w.coin(mintN(190 + i), `E${i}`));
  for (let i = 0; i < 50; i++) w.trade(E[i % 3], `w${i}`, T0 + i);
  // two SOL roots and a coin under another parent link post X; one links a flagged post, one a post nothing is stored of
  const Q = w.coin(mintN(2, 1), "QPAR", { parent: null, createdAt: OLD - DAY });
  const R = [w.coin(mintN(200), "R0", { parent: null }), w.coin(mintN(201), "R1", { parent: null }), w.coin(mintN(202), "R2", { parent: Q })];
  for (const m of R) links(m, X);
  const F = w.coin(mintN(203), "FLAG", { parent: null }), U = w.coin(mintN(204), "UNSEEN", { parent: null });
  links(F, BAD); links(U, UNSEEN);
  const L = w.coin(mintN(205), "LOOSE", { parent: null }), TINY = w.coin(mintN(206), "TINY", { parent: null });
  for (let i = 0; i < 4; i++) w.trade(R[0], `r0${i}`, T0 + 60 + i, { usd: 20 });
  for (let i = 0; i < 2; i++) w.trade(R[1], `r1${i}`, T0 + 60 + i, { usd: 20 });
  w.trade(R[2], "r2", T0 + 61, { usd: 20 });
  w.trade(R[1], "r00", T0 + 65, { usd: 20 }); // a wallet of R0 buys R1 too: one buyer of the card, two of the rows
  w.trade(R[2], "cheap", T0 + 66, { usd: 0.5 }); // under $1: no buyer anywhere
  const UN = w.coin(mintN(207), "UNTRK", { parent: null, tracked: false });
  w.trade(UN, "un0", T0 + 64, { usd: 20 }); // a coin Spore does not track: its wallet is no tracked buyer
  for (const m of [F, U, L]) w.trade(m, `o${m.slice(0, 4)}`, T0 + 62, { usd: 30 });
  for (let i = 0; i < 3; i++) w.trade(TINY, `t${i}`, T0 + 63, { usd: 2 });
  const records = new Map([[X, { id: X, state: "ok", handle: "poster", text: "big news", flagged: false }], [BAD, { id: BAD, state: "ok", handle: "rude", text: "", flagged: true }]]);
  const asked = [];
  const posts = { peek: (id) => records.get(id) ?? null, canQueue: (id) => (records.has(id) ? "cached" : "ok"), want: (id, o) => { asked.push([id, o?.low]); return "ok"; }, state: () => "wait", snapshot: () => ({}), start() {}, stop() {} };
  w.wk.attach({ narrative: new Narrative({ model: w.model, posts, now: w.clock.now, log: quiet }) });
  w.clock.t = (T0 + 100) * 1000;
  const app = await serveApp(w);
  try {
    const s = await app.get("/api/stories");
    assert.deepEqual([s.status, s.headers.get("cache-control"), Object.keys(s.body)], [200, "public, max-age=5", ["asOf", "tf", "floor", "floor5m", "candidates", "cards", "loose", "dust", "hidden", "tagging", "themes", "siteBuyers"]]);
    const b = s.body;
    // no narrative tagger runs here: the body says so and nothing else changes
    assert.deepEqual([b.tagging, b.themes], [{ on: false, tagged: 0, pending: 0, capped: false }, []]);
    assert.ok(!JSON.stringify(b).includes('"narrative"') && !JSON.stringify(b).includes('"isNew"'));
    assert.deepEqual((await app.get("/api/health")).body.narrTags, { on: false });
    assert.deepEqual([b.asOf, b.tf, b.floor, b.floor5m, b.candidates, b.hidden], [T0 + 100, "5m", 0, 0, 10, { dust: 1, cards: 0, loose: 0 }]);
    assert.deepEqual(b.cards.map((c) => [c.kind, c.key, c.buyers5m, c.coinsN, c.coins.map((r) => r.symbol)]), [
      ["family", PAR, 50, 3, ["E0", "E1", "E2"]],
      ["post", X, 8, 3, ["R0", "R1", "R2"]],
    ]);
    assert.deepEqual(b.cards.map((c) => c.buyers), [50, 7], "each card counts its distinct $1+ wallets once (r00 bought two of its coins)");
    assert.equal(b.siteBuyers, 50 + 4 + 2 + 1 + 1 + 3, "the site: every distinct $1+ wallet of a tracked coin, counted once (r00 once; one wallet bought FLAG, UNSEEN and LOOSE; $0.5 not; the untracked coin's wallet not)");
    assert.ok(b.cards.every((c) => c.buyers <= b.siteBuyers));
    const [fam, post] = b.cards;
    assert.deepEqual([fam.post, fam.family.mint, fam.family.symbol, typeof fam.family.image, fam.family.startedAt >= T0 && fam.family.startedAt <= T0 + 100], [null, PAR, "PAR", "string", true]);
    assert.deepEqual([post.post, post.family], [{ id: X, handle: "poster", text: "big news", at: T0 - 600, url: postUrl(X) }, null]);
    assert.deepEqual(b.loose.map((r) => r.symbol).sort(), ["FLAG", "LOOSE", "UNSEEN"], "a flagged post and one nothing is stored of make no card");
    assert.deepEqual(b.dust.map((r) => [r.symbol, r.reason, r.safety.state]), [["TINY", "tiny", "unknown"]]);
    assert.ok(asked.some(([id, low]) => id === UNSEEN && low === true), "the unstored post's text is asked for at low priority");
    // every row is a trending row: the same fields, the safety facts filled
    const t = (await app.get("/api/trending")).body;
    const all = [...b.cards.flatMap((c) => c.coins), ...b.loose, ...b.dust];
    assert.deepEqual(all.map((r) => r.mint).sort(), t.rows.map((r) => r.mint).sort(), "under 50 candidates: the very coins trending lists, each once");
    const tr = t.rows.find((r) => r.mint === R[2]), sr = post.coins[2];
    assert.deepEqual(sr, tr);
    assert.deepEqual([sr.parent.mint, sr.safety.state, Object.keys(b.dust[0]).filter((k) => !(k in tr))], [Q, "unknown", ["reason"]]);
    // the other timeframes and the 400; discover still lists the family
    assert.deepEqual([(await app.get("/api/stories?tf=1h")).body.tf, (await app.get("/api/stories?tf=1h")).body.floor5m, (await app.get("/api/stories?tf=2m")).status], ["1h", ENTER_5M, 400]);
    assert.deepEqual((await app.get("/api/discover")).body.families.map((f) => f.parent.mint), [PAR]);
    assert.equal((await app.get("/api/health")).body.coinRows.storiesBuilt, 2);
  } finally { await app.close(); }
  w.close();
});

test("stories: a waking family whose chosen post may be shown joins that post's card; the 1 h list keeps its own stay set, apart from trending's", async () => {
  const w = world();
  const idAt = (s, n = 0) => String(((BigInt(s * 1000) - 1288834974657n) << 22n) + BigInt(n));
  const T0 = K0 * B, X = idAt(T0 - 600, 1);
  const E = [0, 1, 2].map((i) => w.coin(mintN(190 + i), `E${i}`));
  for (const m of E.slice(0, 2)) w.model.setMeta(`https://ipfs.io/ipfs/${m}`, { image: null, description: null, twitter: `https://x.com/a/status/${X}`, telegram: null, website: null, fetchedAt: 1, ok: true });
  for (let i = 0; i < 51; i++) w.trade(E[i % 3], `w${i}`, T0 + i);
  const records = new Map([[X, { id: X, state: "ok", handle: "poster", text: "big news", flagged: false }]]);
  const posts = { peek: (id) => records.get(id) ?? null, canQueue: () => "cached", want: () => "cached", state: () => "idle", snapshot: () => ({}), start() {}, stop() {} };
  w.wk.attach({ narrative: new Narrative({ model: w.model, posts, now: w.clock.now, log: quiet }) });
  w.clock.t = (T0 + 100) * 1000;
  let b = await w.rows.stories("1h");
  assert.deepEqual(b.cards.map((c) => [c.kind, c.key, c.post.handle, c.family.mint, c.buyers5m, c.coinsN]), [["post", X, "poster", PAR, 51, 3]], "E2 links nothing: it comes with its family");
  assert.deepEqual([[...w.rows.listed.keys()], w.rows.listed.get("story:1h").set.size], [["story:1h"], 3], "trending's own stay set is not written");
  assert.equal(await w.rows.stories("1h"), b, "served while the snapshot is current");
  // the post gets flagged: the family keeps a card, without the post
  records.get(X).flagged = true; records.get(X).text = "";
  w.wk.forget();
  b = await w.rows.stories("1h");
  assert.deepEqual(b.cards.map((c) => [c.kind, c.key, c.post, c.coinsN]), [["family", PAR, null, 3]]);
  w.close();
});

test("stories with post lines: a listed card that shows a post offers it with its coins (the one that links it first), and carries `line` from the next build; nothing else changes", async () => {
  const { PostLines } = await import("../lib/post-lines.mjs");
  const w = world();
  const idAt = (s, n = 0) => String(((BigInt(s * 1000) - 1288834974657n) << 22n) + BigInt(n));
  const T0 = K0 * B, X = idAt(T0 - 600, 1);
  const E = [0, 1, 2].map((i) => w.coin(mintN(190 + i), `E${i}`));
  for (const m of E.slice(0, 2)) w.model.setMeta(`https://ipfs.io/ipfs/${m}`, { image: null, description: "Deployed using https://j7tracker.io", twitter: `https://x.com/a/status/${X}`, telegram: null, website: null, fetchedAt: 1, ok: true });
  for (let i = 0; i < 51; i++) w.trade(E[i % 3], `w${i}`, T0 + i);
  const TEXT = "big news: a wizard cat walks across a wide stage tonight https://t.co/Ab12";
  const records = new Map([[X, { id: X, state: "ok", handle: "poster", text: TEXT, flagged: false }]]);
  const posts = { peek: (id) => records.get(id) ?? null, canQueue: () => "cached", want: () => "cached", state: () => "idle", snapshot: () => ({}), start() {}, stop() {} };
  w.wk.attach({ narrative: new Narrative({ model: w.model, posts, now: w.clock.now, log: quiet }) });
  w.clock.t = (T0 + 100) * 1000;
  const plain = await w.rows.stories("1h");
  assert.equal("line" in plain.cards[0], false, "without post lines a card has no such field");
  const calls = [];
  const client = async () => ({ messages: { create: async (req) => { calls.push(req); return { stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: "text", text: JSON.stringify({ posts: [{ n: 1, subject: "Big news", happened: "Poster says there is big news", kind: "claim", keys: ["big news", "not in it"] }] }) }] }; } } });
  const lines = new PostLines({ db: w.model.db, cfg: { on: true, model: "claude-haiku-5-5", dailyUsd: 1 }, on: true, clientFactory: client, now: w.clock.now, fillMs: 0, log: quiet });
  w.rows.attach({ lines });
  w.wk.forget(); w.rows.story.clear();
  let b = await w.rows.stories("1h");
  assert.deepEqual([b.cards.length, "line" in b.cards[0], "quoted" in b.cards[0], lines.pending()], [1, false, false, 1], "offered, not written yet: no field, the page shows the poster's words meanwhile");
  await lines.pump();
  const sent = JSON.parse(calls[0].messages[0].content.split("<posts>\n")[1].split("\n</posts>")[0]);
  assert.deepEqual(sent, [{ n: 1, post: { by: "poster", text: "big news: a wizard cat walks across a wide stage tonight", age_days: 0 }, coins: [{ name: "E0 coin", symbol: "E0", parent: "PAR" }, { name: "E1 coin", symbol: "E1", parent: "PAR" }, { name: "E2 coin", symbol: "E2", parent: "PAR" }] }], "the coin that links the post first; no link, no launch tool's line");
  w.wk.forget(); w.rows.story.clear();
  b = await w.rows.stories("1h");
  assert.deepEqual(b.cards[0].line, { subject: "Big news", happened: "Poster says there is big news", kind: "claim", by: "model", quote: false, chips: ["ai"], keys: ["big news"] }, "the key phrases the server kept ride on the line (a phrase not in the sentence is dropped)");
  const { line, ...rest } = b.cards[0];
  assert.deepEqual(rest, plain.cards[0], "every other field as without post lines");
  assert.equal(calls.length, 1);
  lines.stop();
  w.close();
});

test("stories with post lines: a post of a few words is not sent to a model (the server writes the card's line); with its quoted post read it is, and the card carries `quoted`; a card without a post gets a counted line", async () => {
  const { PostLines } = await import("../lib/post-lines.mjs");
  const w = world();
  const idAt = (s, n = 0) => String(((BigInt(s * 1000) - 1288834974657n) << 22n) + BigInt(n));
  const T0 = K0 * B, X = idAt(T0 - 600, 1), Q = idAt(T0 - 9000, 2);
  const E = [0, 1, 2].map((i) => w.coin(mintN(190 + i), `E${i}`));
  for (const m of E.slice(0, 2)) w.model.setMeta(`https://ipfs.io/ipfs/${m}`, { image: null, description: null, twitter: `https://x.com/a/status/${X}`, telegram: null, website: null, fetchedAt: 1, ok: true });
  for (let i = 0; i < 51; i++) w.trade(E[i % 3], `w${i}`, T0 + i);
  const records = new Map([[X, { id: X, state: "ok", handle: "poster", text: "Sending 10%https://t.co/Ab12", flagged: false }]]);
  let quote = { state: "wait", kind: null, host: null, quoted: null, chain: null };
  const asked = [];
  const posts = { peek: (id) => records.get(id) ?? null, canQueue: () => "cached", want: () => "cached", state: () => "idle", snapshot: () => ({}), start() {}, stop() {}, quoteOf: (id, o) => { asked.push([id, o ?? null]); return quote; } };
  w.wk.attach({ narrative: new Narrative({ model: w.model, posts, now: w.clock.now, log: quiet }) });
  w.clock.t = (T0 + 100) * 1000;
  const calls = [];
  const client = async () => ({ messages: { create: async (req) => { calls.push(req); return { stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: "text", text: JSON.stringify({ posts: [{ n: 1, subject: "Wizard cat", happened: "Quoted post says a wizard cat walked across a stage", kind: "claim" }] }) }] }; } } });
  const lines = new PostLines({ db: w.model.db, cfg: { on: true, model: "claude-haiku-5-5", dailyUsd: 1 }, on: true, clientFactory: client, now: w.clock.now, fillMs: 0, log: quiet });
  w.rows.attach({ lines });
  const build = async () => { w.wk.forget(); w.rows.story.clear(); return (await w.rows.stories("1h")).cards[0]; };
  // the link is not read yet: nothing is sent, and "Sending 10%" is never shown as a story meanwhile
  const OWN = { subject: "$PAR", happened: "3 coins launched under $PAR", kind: "thin", by: "server", quote: false, chips: [], n: 3 };
  let c = await build();
  assert.deepEqual([c.kind, c.coinsN, c.line, "quoted" in c, lines.pending()], ["post", 3, OWN, false, 0]);
  assert.deepEqual(asked.at(-1), [X, null], "the quoted post is asked for (lib/xposts.mjs queues the reads)");
  // the link leads to an article: nothing to read, the server's line stays, and no model is asked
  quote = { state: "ok", kind: "article", host: "x.com", quoted: null, chain: null };
  c = await build();
  await lines.pump();
  assert.deepEqual([c.line, lines.pending(), calls.length, lines.snapshot().served > 0], [OWN, 0, 0, true]);
  // the link leads to a post that could be read: it comes with the card, the model is asked with it
  quote = { state: "ok", kind: "post", host: null, quoted: { id: Q, handle: "quotedone", text: "a wizard cat walked across a stage https://t.co/zz", at: T0 - 9000 }, chain: null };
  c = await build();
  assert.deepEqual([c.line, lines.pending()], [OWN, 1], "the server's line while the model's is awaited");
  assert.deepEqual(c.quoted, { id: Q, handle: "quotedone", text: "a wizard cat walked across a stage https://t.co/zz", at: T0 - 9000, url: `https://x.com/i/status/${Q}` });
  await lines.pump();
  const sent = JSON.parse(calls[0].messages[0].content.split("<posts>\n")[1].split("\n</posts>")[0]);
  assert.deepEqual([sent[0].post.text, sent[0].quoted, "link_kind" in sent[0]], ["Sending 10%", { by: "quotedone", text: "a wizard cat walked across a stage", age_days: 0, year: new Date((T0 - 9000) * 1000).getUTCFullYear() }, false]);
  c = await build();
  assert.deepEqual(c.line, { subject: "Wizard cat", happened: "Quoted post says a wizard cat walked across a stage", kind: "claim", by: "model", quote: false, chips: ["ai", "via_quoted"] });
  assert.equal(c.quoted.id, Q);
  assert.equal(w.model.db.lineGet(X).quotedId, Q);
  assert.equal(calls.length, 1);
  // the post gets flagged: the family keeps a card without a post, and the server counts its coins
  records.get(X).flagged = true; records.get(X).text = "";
  c = await build();
  assert.deepEqual([c.kind, c.post, c.line, "quoted" in c], ["family", null, { subject: "$PAR", happened: "3 coins launched under $PAR", kind: "thin", by: "server", quote: false, chips: ["no_post"], n: 3 }, false]);
  const kept = c.line;
  assert.equal((await build()).line, kept, "kept while the card's coin count stays (an hour at most)");
  w.clock.t += 3_601_000;
  for (let i = 0; i < 51; i++) w.trade(E[i % 3], `v${i}`, Math.floor(w.clock.t / 1000) - 60 + (i % 50));
  c = await build();
  if (c?.kind === "family") assert.notEqual(c.line, kept, "rebuilt after an hour");
  assert.equal(calls.length, 1, "no model call for any of the server's lines");
  lines.stop();
  w.close();
});

test("stories with post lines: over the real post fetcher the post's link is read (one redirect, not followed), the quoted post comes through the embed call, and the model is asked with it", async () => {
  const { PostLines } = await import("../lib/post-lines.mjs");
  const { XPosts } = await import("../lib/xposts.mjs");
  const w = world();
  const idAt = (s, n = 0) => String(((BigInt(s * 1000) - 1288834974657n) << 22n) + BigInt(n));
  const T0 = K0 * B, X = idAt(T0 - 600, 1), Q = idAt(T0 - 9000, 2);
  const E = [0, 1, 2].map((i) => w.coin(mintN(190 + i), `E${i}`));
  for (const m of E.slice(0, 2)) w.model.setMeta(`https://ipfs.io/ipfs/${m}`, { image: null, description: null, twitter: `https://x.com/a/status/${X}`, telegram: null, website: null, fetchedAt: 1, ok: true });
  for (let i = 0; i < 51; i++) w.trade(E[i % 3], `w${i}`, T0 + i);
  w.clock.t = (T0 + 100) * 1000;
  const embed = (id, handle, p) => new Response(JSON.stringify({ url: `https://twitter.com/${handle}/status/${id}`, author_url: `https://twitter.com/${handle}`, html: `<blockquote><p>${p}</p>&mdash; x (@${handle})</blockquote>` }), { status: 200 });
  const seen = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    seen.push(`${u.hostname}${u.hostname === "t.co" ? u.pathname : ""}:${init.redirect}`);
    if (u.hostname === "t.co") return { status: 301, headers: new Headers({ location: `https://x.com/quotedone/status/${Q}` }), body: { cancel: async () => {} } };
    const id = u.searchParams.get("url").split("/").pop();
    return id === X ? embed(X, "poster", "Sending 10%<a href=\"https://t.co/Ab12\">https://t.co/Ab12</a>") : embed(Q, "quotedone", "a wizard cat walked across a stage");
  };
  const posts = new XPosts({ perMin: 6000, db: w.model.db, fetch, now: w.clock.now, sleep: async (ms) => { w.clock.t += ms; }, log: quiet });
  w.wk.attach({ narrative: new Narrative({ model: w.model, posts, now: w.clock.now, log: quiet }) });
  const calls = [];
  const client = async () => ({ messages: { create: async (req) => { calls.push(req); return { stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: "text", text: JSON.stringify({ posts: [{ n: 1, subject: "Wizard cat", happened: "Quoted post says a wizard cat walked across a stage", kind: "claim" }] }) }] }; } } });
  const lines = new PostLines({ db: w.model.db, cfg: { on: true, model: "claude-haiku-5-5", dailyUsd: 1 }, on: true, clientFactory: client, now: w.clock.now, fillMs: 0, log: quiet });
  w.rows.attach({ lines });
  const build = async () => { w.wk.forget(); w.rows.story.clear(); const b = await w.rows.stories("1h"); await posts.idle(); return b.cards[0]; };
  // Build after build, as a page polls: the post's text is read, then its link's redirect, then the quoted post; the
  // model is asked once that is there. Until then a card that shows the post carries the server's own line, and the
  // poster's fee line is never the story.
  let c = null, own = 0;
  for (let i = 0; i < 8 && c?.line?.by !== "model"; i++) {
    c = await build();
    if (c?.post && c.line?.by === "server") { own++; assert.deepEqual([c.line.subject, c.line.happened, c.line.chips], ["$PAR", "3 coins launched under $PAR", []]); }
    await lines.pump();
  }
  assert.ok(own >= 1, "the server's own line while the link and the quoted post were read");
  assert.deepEqual(seen, ["publish.x.com:error", "t.co/Ab12:manual", "publish.x.com:error"]);
  assert.deepEqual([c.kind, c.post.text, c.quoted.id, c.quoted.handle, c.quoted.text, c.quoted.url], ["post", "Sending 10%https://t.co/Ab12", Q, "quotedone", "a wizard cat walked across a stage", `https://x.com/i/status/${Q}`]);
  assert.deepEqual(c.line, { subject: "Wizard cat", happened: "Quoted post says a wizard cat walked across a stage", kind: "claim", by: "model", quote: false, chips: ["ai", "via_quoted"] });
  const sent = JSON.parse(calls[0].messages[0].content.split("<posts>\n")[1].split("\n</posts>")[0]);
  assert.deepEqual([sent[0].post.text, sent[0].quoted.by, sent[0].quoted.text], ["Sending 10%", "quotedone", "a wizard cat walked across a stage"]);
  assert.deepEqual([calls.length, seen.length, w.model.db.linkGet(X).toId, w.model.db.lineGet(X).quotedId], [1, 3, Q, Q], "one model request, three requests to X in all, and both are stored");
  lines.stop(); posts.stop();
  w.close();
});

/**
 * A world for the post-line cards: SOL-root coins that link posts, a fake post reader whose `quoteOf` answers from
 * `quotes` (post id → what lib/xposts.mjs quoteOf would say; "none" otherwise), and the post lines over a fake model
 * (`answer(card)`: the entry for one sent card). `card(tag, text, { one, copy })` makes the coins of one card: two rows
 * (`<TAG>A` with 5 buyers, which leads, and `<TAG>B` with 3), with `one` a single coin `<TAG>`, with `copy` ONE row
 * with a copy folded under it (the same ticker and image); it returns the post's id. `build()` is one stories build: card key → card.
 */
async function lineWorld(answer = () => null) {
  const { PostLines } = await import("../lib/post-lines.mjs");
  const w = world();
  const idAt = (s, n = 0) => String(((BigInt(s * 1000) - 1288834974657n) << 22n) + BigInt(n));
  const T0 = K0 * B, records = new Map(), quotes = new Map(), mints = new Map(), calls = [];
  const NONE = { state: "none", kind: null, host: null, quoted: null, chain: null, retry: false };
  let seq = 0;
  const posts = { peek: (id) => records.get(id) ?? null, canQueue: () => "cached", want: () => "cached", state: () => "idle", snapshot: () => ({}), start() {}, stop() {}, quoteOf: (id) => quotes.get(id) ?? NONE };
  w.wk.attach({ narrative: new Narrative({ model: w.model, posts, now: w.clock.now, log: quiet }) });
  const coin = (sym, id, buyers, parent = null) => {
    const m = w.coin(mintN(300 + seq++), sym, { parent });
    if (id) w.model.setMeta(`https://ipfs.io/ipfs/${m}`, { image: `https://ipfs.io/ipfs/img-${sym}`, description: null, twitter: `https://x.com/a/status/${id}`, telegram: null, website: null, fetchedAt: 1, ok: true });
    for (let k = 0; k < buyers; k++) w.trade(m, `b${seq}_${k}`, T0 + 60 + k, { usd: 20 });
    return m;
  };
  const card = (tag, text, { one = false, copy = false } = {}) => {
    const id = idAt(T0 - 600, seq + 1), T = tag.toUpperCase();
    records.set(id, { id, state: "ok", handle: "poster", text, flagged: false });
    mints.set(tag, one ? [coin(T, id, 5)] : copy ? [coin(T, id, 5), coin(T, id, 3)] : [coin(`${T}A`, id, 5), coin(`${T}B`, id, 3)]);
    return id;
  };
  const client = async () => ({ messages: { create: async (req) => {
    const sent = JSON.parse(req.messages[0].content.split("<posts>\n")[1].split("\n</posts>")[0]);
    calls.push(sent);
    return { stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: "text", text: JSON.stringify({ posts: sent.map((p) => ({ n: p.n, ...answer(p) })).filter((e) => e.kind) }) }] };
  } } });
  const lines = new PostLines({ db: w.model.db, cfg: { on: true, model: "claude-haiku-5-5", dailyUsd: 1 }, on: true, clientFactory: client, now: w.clock.now, perMin: 600, fillMs: 0, log: quiet });
  w.rows.attach({ lines });
  w.clock.t = (T0 + 100) * 1000;
  const build = async () => { w.wk.forget(); w.rows.story.clear(); return new Map((await w.rows.stories("1h")).cards.map((c) => [c.key, c])); };
  /** The model's turn: every waiting request, the fake clock a step on between them. */
  const pump = async (times = 6) => { for (let i = 0; i < times; i++) { await lines.pump(); w.clock.t += 100; } };
  const quoted = (n, text = "a wizard cat walked across a wide stage") => ({ id: idAt(T0 - 9000, 500 + n), handle: `quoted${n}`, text, at: T0 - 9000 });
  return { w, T0, idAt, lines, records, quotes, mints, calls, coin, card, build, pump, quoted, close: () => { lines.stop(); w.close(); } };
}
const tagOfCard = (p) => p.post.text.split(":")[0];
/** A post of more than 8 words that starts with `tag`. */
const LONG = (tag) => `${tag}: a cat in a wizard hat walks across a wide stage`;

test("stories with post lines: a card of ONE row is a single coin, with or without copies folded under it: nothing to say is `line: null`, no post is no field, a quotable post keeps its quote", async () => {
  const L = await lineWorld();
  const { card, coin, build, quotes, lines, calls } = L;
  // single coins: a fee line whose link came back empty, a bare link to a website, a short post that says something
  const noise = card("noise", "SENDING 5%https://t.co/9IXTi6yoBB", { one: true }), link = card("link", "https://t.co/oAQHWDkJWU", { one: true }), says = card("says", "the bears are done for this week", { one: true });
  // the same three with a copy folded under the row (same ticker and image, both link the post)
  const cNoise = card("cnoise", "Sending 10%https://t.co/Ig0v1Mdtkc", { copy: true }), cLink = card("clink", "https://t.co/oAQHWDkJWV", { copy: true }), cSays = card("csays", "a hippo was born at the zoo", { copy: true });
  quotes.set(noise, { state: "unread", kind: null, host: null, quoted: null, chain: null, retry: false });
  quotes.set(cNoise, { state: "unread", kind: null, host: null, quoted: null, chain: null, retry: true });
  for (const id of [link, cLink]) quotes.set(id, { state: "ok", kind: "website", host: "example.org", quoted: null, chain: null, retry: false });
  // a waking family whose ONE row has two copies, and no post (three WHITED under PAR: a family wakes with three coins)
  const fam = [coin("WHITED", null, 20, PAR), coin("WHITED", null, 18, PAR), coin("WHITED", null, 17, PAR)];
  const cards = await build();
  const shape = (c) => [c.kind, c.coins.length, c.coins[0].copies?.length ?? 0, c.coinsN];
  assert.deepEqual([noise, link, says].map((id) => shape(cards.get(id))), [["post", 1, 0, 1], ["post", 1, 0, 1], ["post", 1, 0, 1]]);
  assert.deepEqual([cNoise, cLink, cSays].map((id) => shape(cards.get(id))), [["post", 1, 1, 2], ["post", 1, 1, 2], ["post", 1, 1, 2]], "one row with a copy under it: two coins");
  // nothing to say: decided, and null (the page draws the plain row with its Open post link)
  for (const id of [noise, link, cNoise, cLink]) assert.deepEqual(["line" in cards.get(id), cards.get(id).line], [true, null], L.records.get(id).text);
  // a quotable post keeps its quote under the coin's own name, also on a row with a copy (never "Both coins are named ...")
  assert.deepEqual(cards.get(says).line, { subject: "$SAYS", happened: "the bears are done for this week", kind: "thin", by: "server", quote: true, chips: [] });
  assert.deepEqual(cards.get(cSays).line, { subject: "$CSAYS", happened: "a hippo was born at the zoo", kind: "thin", by: "server", quote: true, chips: [] });
  // no post: a family of one row (with its copies) has no field at all, like a single coin: not "All 3 coins are named Whited"
  const f = cards.get(PAR);
  assert.deepEqual([f.kind, f.post, f.coins.length, f.coins[0].copies.length, f.coinsN, "line" in f], ["family", null, 1, 2, 3, false]);
  assert.ok(fam.includes(f.coins[0].mint));
  assert.equal(JSON.stringify([...cards.values()].map((c) => c.line ?? null)).includes("coins are named"), false, "no counted sentence anywhere on this page");
  await L.pump();
  assert.deepEqual([calls.length, lines.pending()], [0, 0], "no model is asked for any of them");
  L.close();
});

test("stories with post lines: a post settled thin or refused gets the server's own line; a mismatch line is carried only by the coin it was written for", async () => {
  // the model: nothing stated in "thin"; a name no text has for "bad", both times
  const L = await lineWorld((p) => (tagOfCard(p) === "thin" ? { subject: "THINA coin", happened: "", kind: "thin" } : tagOfCard(p) === "bad" ? { subject: "Elon Musk", happened: "Elon Musk walks across a wide stage", kind: "event" } : { subject: "Wizard cat", happened: "A cat in a wizard hat walks across a wide stage", kind: "event" }));
  const { w, T0, card, build, lines, calls, mints } = L;
  const thin = card("thin", LONG("thin")), bad = card("bad", LONG("bad")), mine = card("mine", LONG("mine")), other = card("other", LONG("other"));
  // a mismatch line says the post does not name THE COIN IT WAS WRITTEN FOR: stored for the card's lead coin, and for another coin
  const mis = { subject: "Cented", happened: "Poster asks if Cented sent to the wrong person", kind: "mismatch", state: "ok", asks: 1, model: "claude-haiku-5-5", at: T0, source: "post", quotedId: null, chainId: null, chips: ["ai", "mismatch"] };
  w.model.db.lineSet({ postId: mine, ...mis, coin: mints.get("mine")[0] });
  w.model.db.lineSet({ postId: other, ...mis, coin: "SomeOtherCoinsMint" });
  let cards = await build();
  assert.deepEqual([thin, bad].map((id) => "line" in cards.get(id)), [false, false], "a longer post waits for the model with no field");
  assert.equal(lines.pending(), 2);
  await L.pump(12);
  assert.deepEqual([lines.stateOf(thin), lines.stateOf(bad), calls.length, calls.flat().filter((p) => p.fix).length], ["thin", "rejected", 2, 1], "the batch, then the refused line once more alone with the reason");
  cards = await build();
  // settled without a line: the server's own (here the poster's words in quote marks), no AI chip, and no second request
  assert.deepEqual(cards.get(thin).line, { subject: "$THINA", happened: LONG("thin"), kind: "thin", by: "server", quote: true, chips: [] });
  assert.deepEqual(cards.get(bad).line, { subject: "$BADA", happened: LONG("bad"), kind: "thin", by: "server", quote: true, chips: [] });
  assert.equal(JSON.stringify(cards.get(bad)).includes("Elon"), false, "nothing of the refused line reaches the card");
  // the mismatch line: on its own coin's card as written; on another coin's card the server's line
  assert.deepEqual(cards.get(mine).line, { subject: "Cented", happened: "Poster asks if Cented sent to the wrong person", kind: "mismatch", by: "model", quote: false, chips: ["ai", "mismatch"] });
  assert.deepEqual(cards.get(other).line, { subject: "$OTHERA", happened: LONG("other"), kind: "thin", by: "server", quote: true, chips: [] });
  await L.pump();
  assert.deepEqual([calls.length, lines.pending()], [2, 0], "none of them is asked again");
  L.close();
});

test("stories with post lines: `chain` only for a line that took a name from it and was written with it; a \"Quoted post\" line is carried only while that quoted post can be shown", async () => {
  const L = await lineWorld();
  const { w, T0, card, build, lines, calls, quotes, quoted, idAt } = L;
  const A = card("chain", "no moon in theos imghttps://t.co/a"), Bc = card("other", "no moon in theos imghttps://t.co/b"), C = card("plain", "no moon in theos imghttps://t.co/c"), G = card("gone", "Sending 10%https://t.co/g");
  const qa = quoted(1, "Speed says he wanted to team up with ELON for the space stream"), ch = { id: idAt(T0 - 90_000, 700), handle: "gwrldmedia", text: "IShowSpeed wants to team up with Elon Musk", at: T0 - 90_000 };
  const row = (o) => ({ subject: "IShowSpeed", happened: "Quoted post says he wanted to team up with Elon Musk for a stream from space", kind: "claim", state: "ok", asks: 1, model: "claude-haiku-5-5", at: T0, coin: null, source: "quoted", ...o });
  w.model.db.lineSet({ postId: A, ...row({ quotedId: qa.id, chainId: ch.id, chips: ["ai", "via_quoted", "names_chain"] }) });
  w.model.db.lineSet({ postId: Bc, ...row({ quotedId: qa.id, chainId: "1111111111111111111", chips: ["ai", "via_quoted", "names_chain"] }) }); // written with another chain post
  w.model.db.lineSet({ postId: C, ...row({ quotedId: qa.id, chainId: ch.id, chips: ["ai", "via_quoted"] }) }); // took no name from it
  for (const id of [A, Bc, C]) quotes.set(id, { state: "ok", kind: "post", host: null, quoted: qa, chain: ch, retry: false });
  const qg = quoted(2);
  w.model.db.lineSet({ postId: G, subject: "Wizard cat", happened: "Quoted post says a wizard cat walked across a wide stage", kind: "claim", state: "ok", asks: 1, model: "claude-haiku-5-5", at: T0, coin: null, source: "quoted", quotedId: qg.id, chainId: null, chips: ["ai", "via_quoted"] });
  quotes.set(G, { state: "ok", kind: "post", host: null, quoted: qg, chain: null, retry: false });
  let cards = await build();
  assert.deepEqual(cards.get(A).chain, { id: ch.id, handle: "gwrldmedia", at: T0 - 90_000, url: `https://x.com/i/status/${ch.id}` }, "who and when, never its text");
  assert.deepEqual([cards.get(A).line.chips, "chain" in cards.get(Bc), "chain" in cards.get(C)], [["ai", "via_quoted", "names_chain"], false, false]);
  assert.deepEqual([A, Bc, C].map((id) => cards.get(id).quoted.id), [qa.id, qa.id, qa.id]);
  const VIA = { subject: "Wizard cat", happened: "Quoted post says a wizard cat walked across a wide stage", kind: "claim", by: "model", quote: false, chips: ["ai", "via_quoted"] };
  assert.deepEqual([cards.get(G).line, cards.get(G).quoted.id], [VIA, qg.id]);
  // the quoted post turns 404 (or is withheld, or flagged): the read is settled without it, so the summary of a post
  // nobody can open is not shown; the server's own line takes its place (here the counted sentence: "Sending 10%" is noise)
  const OWN = { subject: "$GONEA", happened: "2 coins", kind: "thin", by: "server", quote: false, chips: [], n: 2 };
  quotes.set(G, { state: "unread", kind: "post", host: null, quoted: null, chain: null, retry: false });
  cards = await build();
  assert.deepEqual([cards.get(G).line, "quoted" in cards.get(G)], [OWN, false]);
  assert.equal(JSON.stringify(cards.get(G)).includes("Quoted post"), false);
  // still being read (its row was pruned and is asked for again): nothing is decided, the line stays
  quotes.set(G, { state: "wait", kind: "post", host: null, quoted: null, chain: null, retry: false });
  assert.deepEqual((await build()).get(G).line, VIA);
  // the link now leads to another post than the one the line was written with: not that line
  quotes.set(G, { state: "ok", kind: "post", host: null, quoted: quoted(3), chain: null, retry: false });
  cards = await build();
  assert.deepEqual([cards.get(G).line, cards.get(G).quoted.id], [OWN, quoted(3).id]);
  // and back: the stored line was never touched
  quotes.set(G, { state: "ok", kind: "post", host: null, quoted: qg, chain: null, retry: false });
  assert.deepEqual((await build()).get(G).line, VIA);
  await L.pump();
  assert.deepEqual([calls.length, lines.pending(), w.model.db.lineGet(G).state], [0, 0, "ok"], "no model request in any of this");
  L.close();
});

test("stories with post lines: a post settled before its link could be read is asked once more when the quoted post is there, and the card then carries the line written with it", async () => {
  const L = await lineWorld((p) => (p.quoted ? { subject: "Wizard cat", happened: "Quoted post says a wizard cat walked across a wide stage", kind: "claim" } : tagOfCard(p) === "late" ? { subject: "LATEA coin", happened: "", kind: "thin" } : { subject: "Wizard cat", happened: "A cat in a wizard hat walks across a wide stage", kind: "event" }));
  const { w, card, build, lines, calls, quotes, quoted } = L;
  const late = card("late", LONG("late")), had = card("had", LONG("had")), held = card("held", LONG("held"));
  // the links could not be read and no try is left for two of them; the third has its retry scheduled
  const unread = (retry) => ({ state: "unread", kind: null, host: null, quoted: null, chain: null, retry });
  quotes.set(late, unread(false)); quotes.set(had, unread(false)); quotes.set(held, unread(true));
  let cards = await build();
  assert.deepEqual([lines.pending(), lines.snapshot().waitedLink, "line" in cards.get(held)], [2, 1, false], "a link whose retry is scheduled is waited for: that post is not sent yet");
  await L.pump();
  assert.deepEqual([calls.length, calls[0].map((p) => "quoted" in p), lines.stateOf(late), lines.stateOf(had), lines.stateOf(held)], [1, [false, false], "thin", "ok", null]);
  cards = await build();
  const OLD_LINE = { subject: "Wizard cat", happened: "A cat in a wizard hat walks across a wide stage", kind: "event", by: "model", quote: false, chips: ["ai"] };
  assert.deepEqual([cards.get(late).line.by, cards.get(late).line.quote, cards.get(had).line], ["server", true, OLD_LINE]);
  assert.equal(lines.pending(), 0, "nothing to ask again while no quoted post can be read");
  // the later retries read the links: every card now has its quoted post
  for (const [i, id] of [late, had, held].entries()) quotes.set(id, { state: "ok", kind: "post", host: null, quoted: quoted(10 + i), chain: null, retry: false });
  cards = await build();
  assert.deepEqual([lines.pending(), lines.snapshot().reasked], [3, 2], "the two settled ones are asked once more, the held one for the first time");
  assert.deepEqual([cards.get(late).line.by, cards.get(had).line, "line" in cards.get(held), cards.get(late).quoted.id], ["server", OLD_LINE, false, quoted(10).id], "what each card had stays until the new answer is stored");
  await L.pump();
  assert.deepEqual([calls.length, calls[1].map((p) => p.quoted?.by).sort()], [2, ["quoted10", "quoted11", "quoted12"]]);
  cards = await build();
  const VIA = { subject: "Wizard cat", happened: "Quoted post says a wizard cat walked across a wide stage", kind: "claim", by: "model", quote: false, chips: ["ai", "via_quoted"] };
  assert.deepEqual([late, had, held].map((id) => cards.get(id).line), [VIA, VIA, VIA]);
  assert.deepEqual([late, had, held].map((id) => w.model.db.lineGet(id).quotedId), [quoted(10).id, quoted(11).id, quoted(12).id]);
  // never a third time
  for (let i = 0; i < 2; i++) { await build(); await L.pump(); }
  assert.deepEqual([calls.length, lines.pending()], [2, 0]);
  L.close();
});

test("stories with narrative tags: the snapshot offers coins with 10+ buyers, the page's coins go first, a new tag shows in the next build, and the body carries tagging, themes and narrative cards", async () => {
  const w = world();
  const T0 = K0 * B;
  // three SOL roots with 12, 11 and 10 buyers, one with 3 (under the floor), one untracked with 20
  const A = w.coin(mintN(300), "NEEDLE", { parent: null, createdAt: T0 - 600 }), C = w.coin(mintN(301), "SWAN", { parent: null }), D = w.coin(mintN(302), "OTHER", { parent: null });
  const FEW = w.coin(mintN(303), "FEW", { parent: null }), UN = w.coin(mintN(304), "UNTRK", { parent: null, tracked: false });
  // the two coins the fake model files have text of their own: a coin with a name only would be stored as "none" (the empty-coin guard)
  for (const m of [A, C]) w.model.setMeta(`https://ipfs.io/ipfs/${m}`, { image: null, description: "the ai bubble is about to pop", twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true });
  for (const [m, n] of [[A, 12], [C, 11], [D, 10], [FEW, 3], [UN, 20]]) for (let i = 0; i < n; i++) w.trade(m, `${m.slice(0, 4)}w${i}`, T0 + i, { usd: 20 });
  const calls = [];
  const client = async () => ({ messages: { create: async (req) => {
    const coins = JSON.parse(userText(req.messages[0]).split("<coins>\n")[1].split("\n</coins>")[0]);
    calls.push(coins.map((c) => c.symbol));
    return { stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 90 }, content: [{ type: "text", text: JSON.stringify({ coins: coins.map((c) => (c.symbol === "OTHER" || c.symbol === "FEW" ? { n: c.n, kind: "none", id: 0, title: "", theme: "other" } : { n: c.n, kind: "new", id: 0, title: "AI Bubble Popping", theme: "ai" })) }) }] };
  } } });
  const narr = new NarrTags({ model: w.model, db: w.db, cfg: { on: true, model: "claude-haiku-5-5", dailyUsd: 1, minBuyers: 10 }, clientFactory: client, now: w.clock.now, perMin: 600, hotFillMs: 0, log: quiet });
  w.rows.attach({ narr });
  w.clock.t = (T0 + 100) * 1000;
  let b = await w.rows.stories("5m");
  // nothing is tagged yet: the body is the untagged one, and says the tagger is on with the page's three coins waiting (FEW, on the page with 3 buyers, is under PAGE_MIN_BUYERS)
  assert.deepEqual([b.tagging, b.themes, b.cards.length, b.loose.map((r) => r.symbol).sort()], [{ on: true, tagged: 0, pending: 3, capped: false }, [], 0, ["FEW", "NEEDLE", "OTHER", "SWAN"]]);
  assert.equal(await w.rows.stories("5m"), b, "served while the snapshot is current: a request does not rebuild");
  await narr.pump();
  assert.deepEqual(calls.map((c) => [...c].sort()), [["NEEDLE", "OTHER", "SWAN"]], "one request; the page coin under PAGE_MIN_BUYERS and the untracked one were never offered");
  // the next refresh (a new snapshot) shows the tags
  w.clock.t += 5_000;
  b = await w.rows.stories("5m");
  assert.deepEqual(b.tagging, { on: true, tagged: 2, pending: 0, capped: false });
  assert.deepEqual(b.themes, [{ theme: "ai", cards: 1 }]);
  assert.deepEqual(b.cards.map((c) => [c.kind, c.key, c.narrative, c.post, c.family, c.buyers5m, c.coinsN, c.newN, c.olderN, c.coins.map((r) => [r.symbol, r.isNew, r.narrative.id, r.safety.state])]), [
    ["narrative", "n:1", { id: 1, title: "ai bubble popping", theme: "ai", newCoins1h: 1 }, null, null, 23, 2, 1, 1, [["NEEDLE", true, 1, "unknown"], ["SWAN", false, 1, "unknown"]]],
  ]);
  assert.deepEqual(b.loose.map((r) => [r.symbol, "narrative" in r]).sort(), [["FEW", false], ["OTHER", false]]);
  // trending is untouched by tags
  assert.ok(!JSON.stringify(await w.rows.trending("5m")).includes("narrative"));
  // health names the tagger where the other subsystems report, without anything secret
  const app = await serveApp(w, { narrTags: narr });
  try {
    const h = (await app.get("/api/health")).body.narrTags;
    assert.deepEqual([h.on, h.tagged, h.none, h.narratives, h.pending, h.requestsToday, h.capped, h.lastError], [true, 2, 1, 1, 0, 1, false, null]);
  } finally { await app.close(); }
  narr.stop(); w.close();
});

test("story gate: shadow records a passing story and leaves the body unchanged; on ranks passing stories first and the card carries gate", async () => {
  const idAt = (s, n = 0) => String(((BigInt(s * 1000) - 1288834974657n) << 22n) + BigInt(n));
  const T0 = K0 * B;
  for (const mode of ["shadow", "on"]) {
    const w = world();
    const X = idAt(T0 - 600, 1);
    const E = [0, 1, 2].map((i) => w.coin(mintN(290 + i), `G${i}`));
    for (const m of E) w.model.setMeta(`https://ipfs.io/ipfs/${m}`, { image: null, description: null, twitter: `https://x.com/a/status/${X}`, telegram: null, website: null, fetchedAt: 1, ok: true });
    for (let i = 0; i < 51; i++) w.trade(E[i % 3], `w${i}`, T0 + i, { usd: 20 });
    const records = new Map([[X, { id: X, state: "ok", handle: "poster", text: "big news", flagged: false }]]);
    const posts = { peek: (id) => records.get(id) ?? null, canQueue: () => "cached", want: () => "cached", state: () => "idle", snapshot: () => ({}), start() {}, stop() {} };
    w.wk.attach({ narrative: new Narrative({ model: w.model, posts, now: w.clock.now, log: quiet }) });
    w.rows.attachStoryGate({ mode, cfg: { minBuyers: 10, minInflowSol: 1 } });
    w.model.attention.liftOf = (k) => (k === X ? { last30: 51, base30: null, old: false } : null); // a young story: the floor
    w.clock.t = (T0 + 100) * 1000;
    const b = await w.rows.stories("5m");
    const rec = w.db.storyGateRecent(0);
    assert.deepEqual(rec.map((r) => [r.key, r.mode, r.buyers, r.coins5, r.why.pass]), [[X, mode, 51, 3, true]], `${mode}: one record`);
    assert.equal(rec[0].title, "@poster: big news");
    const gate = b.cards[0].gate;
    if (mode === "shadow") assert.equal(gate, undefined, "shadow: the body is unchanged");
    else {
      assert.deepEqual([gate.pass, gate.buyers30m, gate.lift, gate.coins5], [true, 51, 17, 3], "on: a young story, 51 against the floor of 3");
      const h = await w.rows.stories("1h");
      assert.deepEqual(h.cards[0].gate, gate, "another timeframe reuses the 5-minute verdict");
      assert.equal(w.db.storyGateRecent(0).length, 1, "and records nothing of its own");
    }
    assert.equal(w.rows.snapshot().storyGate.passing, 1);
    w.rows.stopStoryGate(); w.close();
  }
});
