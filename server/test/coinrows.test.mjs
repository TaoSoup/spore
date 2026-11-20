// Coin rows (lib/coinrows.mjs): the trailing timeframes (a trade at the cut is before it, $1+ distinct buyers), p0 and
// chg (the last trade at or before the start, else sqlite, else the first in it), the 2-minute line (steps, carry,
// nulls before the first trade, carry-in), the held hour (older seed rows ignored), the row filters of a family (no
// coin nobody bought in the trailing 5 min, dust, creator facts), /api/trending (order, limits, exclusions, parent and
// family tags), the sniper share from a recorded launch, holder facts in a row, GET /api/trending and ?tf=, and the cost
// of one pass over 100 000 trades in slices. A fake clock and sqlite in memory. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CoinRows, TF_S, SPARK_STEP, SPARK_N, HOLD_S, TREND_MAX, DUST_USD, parseTf, isDust } from "../lib/coinrows.mjs";
import { BUCKET_S, BASE_BUCKETS, GRACE_S, DEAD_SOLD_S, SNIPE_S } from "../lib/wakeups.mjs";
import { Holders } from "../lib/holders.mjs";
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
  assert.deepEqual([g.coins.map((c) => c.symbol), g.dust, g.more, g.hidden], [["E0", "E1"], 1, 1, 1], "SOLD's sale is a trade in the 5 min: counted in more");
  assert.deepEqual(g.coins[0].tf.buyers, 1);
  w.close();
});

test("/api/trending: most distinct buyers over the timeframe, then volume, then the mint; at most 50; no coin nobody bought, no dust, no creator-fact coin; parent and family tags", async () => {
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
  assert.deepEqual(Object.keys(body), ["asOf", "tf", "rows"]);
  assert.deepEqual(asked, body.rows.map((r) => r.mint), "holder reads are asked for the listed rows only, in list order (not the dust row)");
  assert.equal(body.rows[0].safety.state, "pending");
  assert.deepEqual(body.rows.map((r) => r.symbol), ["ROOT", "E0", "E1", "E2"], "E0 and E1 have 17 buyers, E2 16");
  const [r0, e0] = body.rows;
  assert.deepEqual([r0.parent, r0.family, r0.tf.buyers, r0.sinceStart], [null, null, 60, null], "a SOL root: no parent");
  assert.deepEqual(e0.parent, { mint: PAR, symbol: "PAR", image: `/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/img-PAR")}` });
  assert.deepEqual([e0.family, typeof e0.sinceStart], ["live", "number"], "its family is waking: tagged live, sinceStart measured");
  assert.deepEqual(Object.keys(e0), ["mint", "name", "symbol", "image", "createdAt", "existing", "mcapUsd", "priceUsd", "sinceStart", "buyers5m", "tf", "liqUsd", "spark", "safety", "parent", "family"]);
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
  const big = await w.rows.trending("1m");
  assert.equal(big.rows.length, TREND_MAX);
  assert.deepEqual(big.rows.slice(0, 2).map((r) => r.symbol), ["M59", "M58"], "1 buyer each: the larger volume first");
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

async function serveApp(w) {
  const dir = mkdtempSync(join(tmpdir(), "spore-rows-api-"));
  const hub = new EventHub({ heartbeatMs: 60_000 });
  const app = createApp({ model: w.model, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc: { call: async () => { throw new Error("no chain in this test"); } }, hub, images: new ImageCache(dir), meta: null,
    platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet, now: w.clock.now });
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
  for (const A of snap.per.values()) for (const T of A.tf) assert.equal(T.set, null);
  t.diagnostic(`one pass over ${N} trades: ${s.lastSnapMs} ms CPU, longest slice ${s.maxSliceMs} ms, record ${(recMs / N * 1000).toFixed(2)} us/trade`);
  const T = snap.per.get(mints[1]).tf[3];
  assert.ok(T.buys > 0 && T.buyers > 0 && T.buyers <= T.buys);
  w.close();
});
