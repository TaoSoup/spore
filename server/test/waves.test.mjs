// Name waves, shadow step (lib/waves.mjs): the burst test against a synthetic baseline, the clone and one-stem guards,
// flagged anchors, the membership tiers, each kind of second evidence, the home rule, expiry, ends and reopens, the
// umbrella guard, restarts (a half-written buffer included), and tonight's Veto/Corleone names. Fixed clock, in-memory
// Db, a fake counter holding the baseline (lib/name-counts.mjs Baseline), no worker, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../lib/db.mjs";
import { Baseline } from "../lib/name-counts.mjs";
import { NameWaves, poissonTail, formTest, tierOf, tierFor, waveKey, WAVE_DEFAULTS, WAVE_RULES_V } from "../lib/waves.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const NOW = 1_795_000_000; // 2026-11-18 (UTC)
const DAY = "20261118";
const IDLE = { tickMs: 1e9, evidenceMs: 1e9, trimEveryMs: 1e9 };

/** A ready baseline of `launches` launches over 600 clean hours; `features`: { f: { C, W, known } }. */
const baseOf = (clock, features = {}, launches = 100_000, o = {}) => Baseline.of({ H: Math.floor(clock.s / 3600), hours: 600, launches, at: clock.s * 1000, features: { cat: { C: 3000, W: 3000, known: true }, ...features }, ...o });
function fakeCounts(base) {
  return { base, firstDone: true, added: [], gaps: [], dropped: [], add(x) { this.added.push(x); }, gap(a, b) { this.gaps.push([a, b]); }, markDropped(h) { this.dropped.push(h); }, start() {}, stop() { return Promise.resolve(); }, snapshot() { return { fake: true }; } };
}
function world({ features = {}, launches = 100_000, model = null, flag, cfg = {}, db = new Db(":memory:"), clock = { s: NOW } } = {}) {
  const counts = fakeCounts(baseOf(clock, features, launches));
  const w = new NameWaves({ db, model, counts, flag, now: () => clock.s * 1000, log: quiet, cfg: { ...IDLE, ...cfg } }).start();
  return { db, w, clock, counts };
}
let seq = 0;
const feed = (w, name, creator, { mint = `M${++seq}`, symbol = "", t } = {}) => { w.add({ mint, creator, name, symbol, timestamp: t ?? Math.floor(w.now() / 1000) }); return mint; };
/** `n` launches with names of their own (each its own feature), by `n` creators: the launches of the window. */
const fill = (w, n) => { for (let i = 0; i < n; i++) feed(w, `qz${i.toString(36)}x${seq}`, `F${seq}`); };
const flushAll = (w) => { let k = 0; while ((w.bufL.length || w.bufO.length || w.dirty.size) && k++ < 10_000) w.flush(); };
/** The queued sliced jobs (formation back-fills, companions, the hourly refresh) run to their end, then every row is written. */
const settle = async (w) => { await w.idle(); flushAll(w); };
const all = (db, sql, ...a) => db.db.prepare(sql).all(...a);
const coin = (db, mint) => db.waveCoinGet(mint);

test("poissonTail matches the check values; formTest and tierOf follow the rules", () => {
  const near = (a, b) => Math.abs(a - b) / b < 0.02;
  assert.ok(near(poissonTail(5, 0.5), 1.7e-4)); assert.ok(near(poissonTail(6, 0.5), 1.4e-5)); assert.ok(near(poissonTail(7, 1), 8.3e-5)); assert.ok(near(poissonTail(6, 1), 5.9e-4));
  assert.equal(poissonTail(0, 3), 1); assert.equal(poissonTail(3, 0), 0);
  assert.deepEqual([formTest({ n: 4, e: 0.01, ctx: 4 }).fail, formTest({ n: 5, e: 2, ctx: 4 }).fail, formTest({ n: 5, e: 0.5, ctx: 4 }).fail, formTest({ n: 6, e: 0.5, ctx: 2 }).fail, formTest({ n: 6, e: 0.5, ctx: 3 }).pass], ["count", "ratio", "tail", "ctx", true]);
  assert.deepEqual([tierOf(0.05), tierOf(0.1), tierOf(0.2), tierOf(1 / 3), tierOf(0.34), tierOf(null)], ["lexical", "lexical", "evidence", "evidence", null, "evidence"]);
  assert.equal(waveKey("seg", "mas", NOW), `w:seg-mas-${DAY}`);
});

test("no formation before the baseline is ready (24 clean hours, 20,000 launches, under 3 h old); launches are still counted", () => {
  const { w, counts, db } = world();
  counts.base = Baseline.of({ H: 1, hours: 20, launches: 100_000, at: NOW * 1000 });
  fill(w, 300);
  for (const n of ["Mr Veto", "Veto Cat", "Don Veto", "Veto Inu King", "Veto Moon", "Veto Sun"]) feed(w, n, n);
  assert.equal(w.open.size, 0);
  assert.ok(w.stats.notReady > 0);
  assert.equal(counts.added.length, 306, "every launch reaches the hourly counts");
  counts.base = Baseline.of({ H: 1, hours: 600, launches: 100_000, at: NOW * 1000 - 3 * 3600_000 - 1000 });
  feed(w, "Veto Star", "VS");
  assert.equal(w.open.size, 0, "a stale baseline is not ready either");
  db.close();
});

test("formation at 5 distinct creators with 3x and the tail; a creator counts once; the formation row holds every input; the back-fill is a sliced job", async () => {
  const { w, db } = world({ features: { veto: { C: 2, W: 2 } } });
  fill(w, 1000);
  feed(w, "Mr Veto", "A"); feed(w, "Veto Cat", "B"); feed(w, "Don Veto", "C"); feed(w, "Veto King", "D");
  feed(w, "Veto Queen", "D"); // same creator: still 4
  assert.equal(w.open.size, 0);
  feed(w, "Veto Moon", "E");
  assert.equal(w.open.size, 1);
  assert.equal(w.jobs.length, 1, "the back-fill and companions wait for the scheduler: the launch that formed the wave paid O(1)");
  assert.equal(w.pending.size + w.open.get("veto").members, 1, "only the launch that formed it is decided at once");
  await settle(w);
  const [row] = db.wavesOpen();
  assert.equal(row.key, `w:word-veto-${DAY}`);
  assert.deepEqual([row.n, row.ctx, row.win, row.cBase, row.cMissing, row.baseN, row.baseHours, row.v], [5, 6, 6 * 3600, 2, false, 100_000, 600, WAVE_RULES_V]);
  assert.ok(Math.abs(row.e - (2.5 / 100_000) * 1006) < 1e-6, "e = (C + 0.5) / N_base x N_W");
  assert.ok(row.tail < 1e-4 && row.r < 0.1);
  assert.deepEqual(row.why.carriers, { w: 6, p: 0, s: 0, y: 0 });
  assert.equal(row.why.first.length, 6);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_coins WHERE wave_key = ?", row.key)[0].n, 6, "all six carriers join by name");
  db.close();
});

test("a halved stream gives the same verdict: shares, not counts", () => {
  const verdict = (scale) => {
    const { w, db } = world({ features: { veto: { C: 8, W: 8 } }, launches: 100_000 * scale });
    fill(w, 2000 * scale);
    for (const n of ["Mr Veto", "Veto Cat", "Don Veto", "Veto King", "Veto Moon", "Veto Sun"]) feed(w, n, n);
    const v = w.open.get("veto");
    const out = { formed: !!v, tier: v ? tierOf(v.r) : null, r: v?.r ?? null };
    db.close();
    return out;
  };
  const full = verdict(1), half = verdict(0.5);
  assert.deepEqual([full.formed, full.tier], [half.formed, half.tier]);
  assert.equal(full.formed, true);
  assert.ok(Math.abs(full.r - half.r) / full.r < 0.01, "the same r but for the six carriers' own weight in the window");
});

test("a clone set does not form (Vetocat, Vetocat 2, Vetocat AI, Vetocat Inu, Vetocat 2.0); Mr Veto, Veto Cat and Don Veto Corleone do", () => {
  const { w, db } = world();
  fill(w, 1000);
  ["Vetocat", "Vetocat 2", "Vetocat AI", "Vetocat Inu", "Vetocat 2.0", "Vetocat"].forEach((n, i) => feed(w, n, `K${i}`));
  assert.equal(w.open.size, 0, "six creators, one name");
  flushAll(w);
  const near = all(db, "SELECT feature, fail FROM wave_tests WHERE feature IN ('vetocat', 'veto') ORDER BY feature");
  assert.deepEqual(near.map((x) => [x.feature, x.fail]), [["veto", "ctx"], ["vetocat", "ctx"]], "recorded as near misses on the context rule (the whole word and its split part)");
  ["Mr Veto", "Veto Cat", "DON VETO CORLEONE", "MR. VETO", "Veto Corleone"].forEach((n, i) => feed(w, n, `V${i}`));
  assert.ok(w.open.has("veto"));
  db.close();
});

test("a one-stem residual does not form: X Corleone with leone known splits into cor + leone, whose only context is the other side", () => {
  const { w, db } = world({ features: { leone: { C: 30, W: 30, known: true } } });
  fill(w, 1000);
  ["Don Corleone", "Connie Corleone", "Sonny Corleone", "Michael Corleone", "Fredo Corleone", "Vito Corleone"].forEach((n, i) => feed(w, n, `C${i}`));
  assert.equal(w.feats.get("cor")?.cx[0].size, 1);
  assert.ok(!w.open.has("cor") && !w.open.has("leone"));
  assert.ok(w.open.has("corleone"), "the whole word, with six different first names, does");
  db.close();
});

test("a flagged anchor records nothing: no wave, no near miss; it is counted", () => {
  const { w, db } = world({ flag: (f) => f === "veto" });
  fill(w, 1000);
  ["Mr Veto", "Veto Cat", "Don Veto", "Veto King", "Veto Moon"].forEach((n, i) => feed(w, n, `V${i}`));
  flushAll(w);
  assert.equal(w.open.size, 0);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM waves")[0].n + all(db, "SELECT COUNT(*) AS n FROM wave_tests WHERE feature = 'veto'")[0].n, 0);
  assert.equal(w.snapshot().waves.flagged, 1);
  db.close();
});

/** "alpha" with C = 150 over 100,000 launches and ~1,000 launches in the window: e = 1.5, formation at 9 creators, r = 1/6. */
async function pendingWorld(o = {}) {
  const x = world({ features: { alpha: { C: 150, W: 150 } }, ...o });
  fill(x.w, 1000);
  const mints = [];
  for (let i = 1; i <= 9; i++) mints.push(feed(x.w, `Alpha ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][i - 1]}`, `A${i}`, { mint: `A${i}m` }));
  await x.w.idle();
  return { ...x, mints };
}

test("tiers: lexical at 10x, pending between 3x and 10x with every candidate kept, no row above 1/3 (counted on the wave)", async () => {
  const { w, db, counts, clock } = await pendingWorld();
  const wave = w.open.get("alpha");
  assert.ok(wave && wave.r > 0.1 && wave.r <= 1 / 3, `r ${wave?.r}`);
  flushAll(w);
  assert.deepEqual(all(db, "SELECT DISTINCT reason FROM wave_coins").map((r) => r.reason), ["pending"]);
  assert.equal(coin(db, "A1m").cands[0].key, wave.key);
  assert.equal(w.pending.size, 9);
  // the anchor's share today has risen far: a later carrier is not a candidate
  counts.base = baseOf(clock, { alpha: { C: 2000, W: 2000 } });
  feed(w, "Alpha ten", "A10", { mint: "A10m" });
  flushAll(w);
  assert.equal(coin(db, "A10m"), null);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_cands WHERE mint = 'A10m'")[0].n, 0);
  assert.equal(wave.over, 1);
  // a 10x word: lexical at once
  const lex = world({ features: { bravo: { C: 1, W: 1 } } });
  fill(lex.w, 1000);
  ["Bravo one", "Bravo two", "Bravo three", "Bravo four", "Bravo five"].forEach((n, i) => feed(lex.w, n, `B${i}`, { mint: `B${i}m` }));
  await settle(lex.w);
  assert.deepEqual(all(lex.db, "SELECT DISTINCT reason FROM wave_coins").map((r) => r.reason), ["lexical"]);
  db.close(); lex.db.close();
});

/** A model with tracked coins, their posts (meta.twitter) and creators, and held trades. */
function fakeModel({ posts = {}, trades = [], tracked = () => true } = {}) {
  const coins = new Map();
  return {
    coins,
    get(m) { return tracked(m) ? { mint: m, tracked: true, creator: `curve-${m}` } : null; },
    metaFor(c) { const id = posts[c.mint]; return id ? { twitter: `https://x.com/someone/status/${id}` } : null; },
    coinRows: { a: trades, h: 0 },
  };
}
const spy = (obj, seen) => new Proxy(obj, { get(t, k) { seen.add(String(k)); return t[k]; } });

test("evidence: the same post or quoted post as another creator's carrier, a tag held by carriers of 2+ other creators, shared counted buyers; a tag held by one other creator does not; only linkOf and tagOf are called", async () => {
  const T = NOW - 60;
  const trades = [];
  const buy = (m, u) => trades.push({ m, t: T, b: true, u, v: 5, p: 1, s: trades.length });
  for (let i = 0; i < 10; i++) buy("A8m", `W${i}`);
  for (let i = 0; i < 4; i++) buy("A9m", `W${i}`);
  for (let i = 0; i < 6; i++) buy("A9m", `X${i}`);
  const model = fakeModel({ posts: { A1m: "111", A2m: "111", A7m: "333" }, trades });
  const { w, db } = await pendingWorld({ model });
  const seenP = new Set(), seenN = new Set();
  const tags = { A3m: 7, A4m: 7, A5m: 7, A6m: 8, A7m: 8 };
  w.attach({ posts: spy({ linkOf: (id) => (id === "333" ? { state: "ok", kind: "post", toId: "111" } : { state: "ok", kind: "website", toId: null }) }, seenP), narr: spy({ tagOf: (m) => (tags[m] ? { id: tags[m], title: "x" } : null) }, seenN) });
  await w.evidencePass();
  flushAll(w);
  const reasons = Object.fromEntries(all(db, "SELECT mint, reason FROM wave_coins").map((r) => [r.mint, r.reason]));
  assert.deepEqual([reasons.A1m, reasons.A2m, reasons.A7m], ["post", "post", "post"], "A7 by its quoted post");
  assert.deepEqual([reasons.A3m, reasons.A4m, reasons.A5m], ["tag", "tag", "tag"]);
  assert.equal(reasons.A6m, "pending", "tag 8 is held by one other creator only");
  assert.deepEqual([reasons.A8m, reasons.A9m], ["buyers", "buyers"]);
  const a8 = coin(db, "A8m");
  assert.equal(a8.wave_key, w.open.get("alpha").key);
  assert.deepEqual(a8.why.held[0].buyers, { n: 10, shared: 4 });
  assert.deepEqual([...seenP].filter((k) => k !== "then"), ["linkOf"]);
  assert.deepEqual([...seenN].filter((k) => k !== "then"), ["tagOf"]);
  db.close();
});

test("an untracked launch never joins by post or tag; with the trend gate's counted wallets it can join by buyers; with none it ends unconfirmed, counted as having no possible evidence", async () => {
  const gateW = (ids) => new Map(ids.map((u) => [u, { k: 0.1 }]));
  const gate = { watched: new Map([["A8m", { w: gateW(["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"]) }], ["A9m", { w: gateW(["G0", "G1", "G2", "G3", "Y4", "Y5", "Y6", "Y7", "Y8", "Y9"]) }]]) };
  const { w, db, clock } = await pendingWorld({ model: fakeModel({ tracked: () => false, posts: { A1m: "111", A2m: "111" } }) });
  w.attach({ narr: { tagOf: () => ({ id: 7 }) }, posts: { linkOf: () => ({ state: "ok", kind: "post", toId: "1" }) }, gate });
  await w.evidencePass();
  flushAll(w);
  assert.deepEqual([coin(db, "A1m").reason, coin(db, "A3m").reason, coin(db, "A8m").reason, coin(db, "A9m").reason], ["pending", "pending", "buyers", "buyers"]);
  clock.s += 6 * 3600 + 1;
  await w.evidencePass();
  flushAll(w);
  assert.equal(coin(db, "A1m").reason, "unconfirmed");
  assert.equal(coin(db, "A1m").wave_key, null);
  assert.equal(coin(db, "A1m").why.noEvidence, true);
  assert.equal(w.snapshot().coins.noEvidence, 7);
  assert.equal(w.snapshot().waves.members, 2);
  db.close();
});

test("the home rule: two lexical anchors go to the lowest r; a home never changes; a later wave over a decided coin is a candidacy only; a pending coin is decided once", async () => {
  const { w, db } = world({ features: { alpha: { C: 1, W: 1 }, bravo: { C: 20, W: 20 }, gamma: { C: 150, W: 150 } } });
  fill(w, 1000);
  ["Alpha one", "Alpha two", "Alpha three", "Alpha four", "Alpha five"].forEach((n, i) => feed(w, n, `A${i}`));
  ["Bravo one", "Bravo two", "Bravo three", "Bravo four", "Bravo five", "Bravo six"].forEach((n, i) => feed(w, n, `B${i}`));
  const both = feed(w, "Alpha Bravo Gamma", "AB", { mint: "ABm" });
  await settle(w);
  const ka = w.open.get("alpha").key, kb = w.open.get("bravo").key;
  assert.equal(coin(db, "ABm").wave_key, ka, "alpha's r is lower");
  assert.deepEqual(coin(db, "ABm").cands.map((c) => c.key).sort(), [ka, kb].sort());
  // gamma forms later; its back-fill offers the decided coin: a candidacy row, the home stays
  ["Gamma one", "Gamma two", "Gamma three", "Gamma four", "Gamma five", "Gamma six", "Gamma seven", "Gamma eight"].forEach((n, i) => feed(w, n, `G${i}`));
  await settle(w);
  const kg = w.open.get("gamma").key;
  assert.equal(coin(db, both).wave_key, ka);
  assert.deepEqual(all(db, "SELECT key FROM wave_cands WHERE mint = ? ORDER BY key", both).map((r) => r.key), [ka, kb, kg].sort());
  // the store's own guard: a decided row is never decided again
  const g0 = [...w.pending.values()][0];
  assert.ok(g0);
  assert.equal(db.waveCoinDecide({ mint: g0.mint, waveKey: kg, reason: "post" }), true);
  assert.equal(db.waveCoinDecide({ mint: g0.mint, waveKey: ka, reason: "lexical" }), false);
  db.close();
});

test("a pending coin decided by evidence, then offered lexically by a wave formed later, keeps its home; the candidacy is recorded; its first wave counts it once", async () => {
  const model = fakeModel({ posts: { A1m: "111", A2m: "111" } });
  const { w, db } = await pendingWorld({ model });
  const alpha = w.open.get("alpha");
  assert.equal(alpha.members, 0);
  await w.evidencePass();
  await settle(w);
  assert.deepEqual([coin(db, "A1m").reason, coin(db, "A1m").wave_key], ["post", alpha.key]);
  assert.equal(alpha.members, 2, "A1 and A2 by their shared post");
  // "one" (unseen: the prior) forms at its 5th creator, A1's "Alpha one" in its firing window: offered lexically
  ["Kilo one", "Lima one", "Mike one", "Nova one"].forEach((n, i) => feed(w, n, `O${i}`, { mint: `O${i}m` }));
  const one = w.open.get("one");
  assert.ok(one && tierOf(one.r) === "lexical", `r ${one?.r}`);
  await settle(w);
  const a1 = coin(db, "A1m");
  assert.deepEqual([a1.wave_key, a1.reason], [alpha.key, "post"], "the home and its reason stay");
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_cands WHERE mint = 'A1m' AND key = ?", one.key)[0].n, 1, "the later candidacy is recorded");
  assert.equal(alpha.members, 2, "counted once");
  assert.equal(one.members, 4, "the four new carriers only");
  assert.equal(db.wavesOpen().find((x) => x.key === alpha.key).members, 2);
  db.close();
});

test("the formation r is the minimum over both windows: 6 h fires with r6 above 0.1 while r24 is under it, and every carrier, the one that formed it included, joins by name", async () => {
  const clock = { s: NOW - 12 * 3600 };
  // the clone path is off here: 20 creators of two names would form "delta", "one" and "two" as clone waves 12 h ago
  const { w, db, counts } = world({ clock, features: { delta: { C: 80, W: 80 } }, cfg: { cloneN: Infinity } });
  // 12 h ago: 20 creators of two Delta names (two contexts: no formation in either window), among 1,000 launches
  fill(w, 1000);
  for (let i = 0; i < 20; i++) feed(w, i % 2 ? "Delta one" : "Delta two", `O${i}`);
  assert.equal(w.open.size, 0);
  // now: 1,000 more launches, then seven creators in 6 h; the third context arrives with the seventh
  clock.s = NOW; counts.base = baseOf(clock, { delta: { C: 80, W: 80 } });
  fill(w, 1000);
  ["Delta one", "Delta two", "Delta one", "Delta two", "Delta one", "Delta two", "Delta three"].forEach((n, i) => feed(w, n, `N${i}`, { mint: `N${i}m` }));
  const wave = w.open.get("delta");
  assert.ok(wave, "formed");
  assert.equal(wave.win, 6 * 3600, "the 6 h window fired");
  const share = 80.5 / 100_000;
  assert.ok((share * wave.why.win6.NW) / 7 > 0.1, "r6 alone would be the evidence tier");
  assert.ok(wave.r <= 0.1 && Math.abs(wave.r - (share * wave.why.win24.NW) / 27) < 1e-6, `r ${wave.r} = r24`);
  await settle(w);
  feed(w, "Delta four", "N8", { mint: "N8m" });
  await settle(w);
  const reasons = all(db, "SELECT DISTINCT reason FROM wave_coins WHERE wave_key = ?", wave.key).map((r) => r.reason);
  assert.deepEqual(reasons, ["lexical"], "one tier for one wave's evidence");
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_coins WHERE wave_key = ?", wave.key)[0].n, 8);
  assert.equal(db.wavesOpen()[0].r, wave.r);
  db.close();
});

test("a wave ends after 24 h without a candidate; within 7 days the feature reopens the same key; after that a new dated key", () => {
  const { w, db, counts, clock } = world({ features: { veto: { C: 2, W: 2 } } });
  const five = (tag) => ["Mr Veto", "Veto Cat", "Don Veto", "Veto King", "Veto Moon"].forEach((n, i) => feed(w, `${n} ${tag}`, `${tag}${i}`));
  fill(w, 1000); five("a");
  const key = w.open.get("veto").key;
  clock.s += 24 * 3600 + 10; counts.base = baseOf(clock, { veto: { C: 2, W: 2 } }); w.tick();
  assert.equal(w.open.size, 0);
  flushAll(w);
  assert.ok(db.wavesRecent(0)[0].endedT > 0);
  clock.s += 2 * 86_400; counts.base = baseOf(clock, { veto: { C: 2, W: 2 } });
  fill(w, 1000); five("b");
  assert.equal(w.open.get("veto").key, key, "reopened");
  assert.equal(w.open.get("veto").reopens, 1);
  clock.s += 24 * 3600 + 10; counts.base = baseOf(clock, { veto: { C: 2, W: 2 } }); w.tick();
  clock.s += 8 * 86_400; counts.base = baseOf(clock, { veto: { C: 2, W: 2 } }); w.tick();
  fill(w, 1000); five("c");
  const k2 = w.open.get("veto").key;
  assert.notEqual(k2, key);
  assert.equal(k2, waveKey("word", "veto", clock.s));
  flushAll(w);
  assert.equal(db.wavesOpen().length, 1);
  db.close();
});

test("the umbrella guard: a lasting rise counted into today's baseline stops candidates, and the reopen test uses the higher share too", async () => {
  const { w, db, counts, clock } = await pendingWorld();
  const wave = w.open.get("alpha");
  // a day later the rise is partly in the baseline: still a candidate (evidence tier)
  counts.base = baseOf(clock, { alpha: { C: 250, W: 250 } });
  feed(w, "Alpha ten", "A10", { mint: "A10m" });
  assert.ok(w.pending.has("A10m"));
  // three days in: today's share is over a third of what the window shows: no more candidates
  counts.base = baseOf(clock, { alpha: { C: 450, W: 450 } });
  feed(w, "Alpha eleven", "A11", { mint: "A11m" });
  assert.equal(w.pending.has("A11m"), false);
  assert.equal(wave.over, 1);
  // 24 h without a candidate: it ends; then the same burst against the risen share does not reopen it
  clock.s += 24 * 3600 + 10; counts.base = baseOf(clock, { alpha: { C: 450, W: 450 } }); w.tick();
  assert.equal(w.open.size, 0);
  fill(w, 1000);
  for (let i = 1; i <= 10; i++) feed(w, `Alpha again ${"abcdefghij"[i - 1]}x`, `R${i}`);
  assert.equal(w.open.has("alpha"), false, "share0 alone would have let 10 creators reopen it");
  db.close();
});

test("a new instance on the same Db restores the ring, open waves and pending coins; rows still buffered at a stop are found again by the back-fill", async () => {
  const db = new Db(":memory:"), clock = { s: NOW };
  const a = world({ db, clock, features: { alpha: { C: 150, W: 150 } }, cfg: { flushOther: 3, flushLaunches: 100_000 } });
  fill(a.w, 1000);
  for (let i = 1; i <= 9; i++) feed(a.w, `Alpha ${"abcdefghi"[i - 1]}x`, `A${i}`, { mint: `A${i}m` });
  await a.w.idle();
  a.w.flush(); // every launch row, the wave row and two other rows: the process stops here
  assert.ok(all(db, "SELECT COUNT(*) AS n FROM wave_coins")[0].n < 9, "the coin rows are not all written");
  const b = world({ db, clock, features: { alpha: { C: 150, W: 150 } } });
  assert.equal(b.w.snapshot().ring, 1009);
  assert.ok(b.w.open.has("alpha"));
  flushAll(b.w);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_coins WHERE reason = 'pending'")[0].n, 9, "every member of the firing window has its row");
  assert.equal(b.w.pending.size, 9);
  assert.ok(b.w.stats.reBackfilled > 0);
  // the restored ring counts: one more carrier joins the open wave
  feed(b.w, "Alpha tenth", "A10", { mint: "A10m" });
  assert.ok(b.w.pending.has("A10m"));
  // a restart without lost rows changes nothing
  flushAll(b.w);
  const c = world({ db, clock, features: { alpha: { C: 150, W: 150 } } });
  assert.equal(c.w.stats.reBackfilled, 0);
  assert.equal(c.w.pending.size, 10);
  db.close();
});

test("a duplicate mint is counted once; add() swallows an error; events without a mint or creator are ignored", () => {
  const { w, counts, db } = world();
  feed(w, "Mr Veto", "A", { mint: "DUP" }); feed(w, "Mr Veto", "A", { mint: "DUP" });
  assert.deepEqual([w.stats.launches, w.stats.dup], [1, 1]);
  w.add({ name: "x" }); w.add({ mint: "Z" }); w.add(null);
  assert.equal(w.stats.ignored, 3);
  counts.add = () => { throw new Error("boom"); };
  assert.doesNotThrow(() => feed(w, "Veto", "B"));
  assert.deepEqual([w.stats.errors, w.stats.lastError], [1, "boom"]);
  db.close();
});

test("launches wait for the first baseline answer (seconds), then are split with its vocabulary, in arrival order", async () => {
  const db = new Db(":memory:"), clock = { s: NOW };
  const counts = fakeCounts(null); counts.firstDone = false;
  const w = new NameWaves({ db, counts, now: () => clock.s * 1000, log: quiet, cfg: IDLE }).start();
  feed(w, "vetocat", "A", { mint: "H1" }); feed(w, "Moon", "B", { mint: "H2" });
  assert.equal(w.stats.launches, 0);
  assert.equal(w.snapshot().holding, 2);
  counts.base = baseOf(clock); counts.firstDone = true;
  feed(w, "Sun", "C", { mint: "H3" });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.a.map((x) => x.mint), ["H1", "H2", "H3"]);
  assert.ok(w.a[0].feats.some((x) => x.f === "veto" && x.how === "s"), "split with the vocabulary that arrived");
  db.close();
});

test("nothing is written to story_coins, story_buckets or story_gate; launches are recorded with their features, arrival time and baseline hour", async () => {
  const { w, db } = await pendingWorld();
  flushAll(w);
  for (const t of ["story_coins", "story_buckets", "story_gate"]) assert.equal(all(db, `SELECT COUNT(*) AS n FROM ${t}`)[0].n, 0, t);
  const r = all(db, "SELECT feats, seen, bh FROM wave_launches WHERE mint = 'A1m'")[0];
  assert.deepEqual([r.feats, r.seen, r.bh], ["alpha:w,one:w", NOW * 1000, Math.floor(NOW / 3600)]);
  db.close();
});

test("tonight's names: veto forms with every carrier; corleone (4 carriers) does not; Cupcake and Connie Corleone are recorded as companions; Vittedo, Brando and Larry are unreachable", async () => {
  // a synthetic baseline: cat is a known token; veto and corleone are rare; 1,500 launches in the window
  const { w, db, clock } = world({ features: { veto: { C: 3, W: 3 }, corleone: { C: 2, W: 2 } }, launches: 900_000 });
  fill(w, 1500);
  const names = ["vetocat", "DON VETO CORLEONE", "Vittedo", "Mr Veto", "Veto Corleone", "The Vetocat", "MR. VETO", "Cupcake corleone", "Connie Corleone", "Veto Cat", "Brando", "Larry"];
  const mint = {};
  names.forEach((n, i) => { mint[n] = feed(w, n, `creator${i}`, { mint: `T${i}` }); });
  assert.deepEqual([...w.open.keys()], ["veto"]);
  const wave = w.open.get("veto");
  assert.equal(wave.key, `w:word-veto-${DAY}`);
  // an hour later the companions are refreshed over the members
  await w.idle();
  clock.s += 3600; w.tick();
  assert.equal(w.jobs.length, 1, "the hourly refresh is a sliced job, not part of the tick");
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_hours")[0].n, 0);
  await settle(w);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_hours")[0].n, 1);
  const members = all(db, "SELECT mint FROM wave_coins WHERE wave_key = ? AND reason = 'lexical' ORDER BY mint", wave.key).map((r) => r.mint);
  const carriers = ["vetocat", "DON VETO CORLEONE", "Mr Veto", "Veto Corleone", "The Vetocat", "MR. VETO", "Veto Cat"].map((n) => mint[n]).sort();
  assert.deepEqual(members, carriers, "7 of 12 join by name, the split ones (vetocat, The Vetocat) included");
  const unreachable = ["Vittedo", "Cupcake corleone", "Connie Corleone", "Brando", "Larry"].map((n) => mint[n]);
  for (const m of unreachable) assert.equal(coin(db, m), null, "no anchor: never a member");
  const comps = all(db, "SELECT mint, how FROM wave_cands WHERE key = ? AND how LIKE 'companion%' ORDER BY mint", wave.key);
  assert.deepEqual(comps.map((r) => [r.mint, r.how]), [[mint["Cupcake corleone"], "companion:corleone"], [mint["Connie Corleone"], "companion:corleone"]].sort());
  assert.ok(db.wavesOpen()[0].why.companions.some(([f, n]) => f === "corleone" && n === 2));
  for (const n of ["Vittedo", "Brando", "Larry"]) assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_cands WHERE mint = ?", mint[n])[0].n, 0, n);
  assert.equal(w.open.has("corleone"), false);
  db.close();
});

test("tonight's names on a thin, bootstrap-only baseline: r lands between 0.1 and 1/3, so the untracked carriers wait and end unconfirmed with no possible evidence", async () => {
  // N_base 20,000 (just ready), veto never seen (C = 1 by the prior), 10,000 launches in the window: e = 0.75, formation at 7
  const { w, db, clock } = world({ launches: 20_000 });
  fill(w, 10_000);
  ["vetocat", "DON VETO CORLEONE", "Vittedo", "Mr Veto", "Veto Corleone", "The Vetocat", "MR. VETO", "Cupcake corleone", "Connie Corleone", "Veto Cat", "Brando", "Larry"].forEach((n, i) => feed(w, n, `creator${i}`, { mint: `T${i}` }));
  const wave = w.open.get("veto");
  assert.ok(wave, "veto forms at its 7th creator");
  await w.idle();
  assert.equal(wave.cMissing, true);
  assert.ok(wave.r > 0.1 && wave.r <= 1 / 3, `r ${wave.r}`);
  assert.equal(w.pending.size, 7);
  clock.s += 6 * 3600 + 1;
  await w.evidencePass();
  flushAll(w);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_coins WHERE reason = 'unconfirmed'")[0].n, 7);
  assert.equal(w.snapshot().coins.noEvidence, 7);
  db.close();
});

test("the defaults are frozen and the cost bounds hold: add() stays far under 1 ms on a busy window", () => {
  assert.ok(Object.isFrozen(WAVE_DEFAULTS));
  const { w, db } = world({ features: { veto: { C: 2, W: 2 } } });
  fill(w, 5000);
  for (let i = 0; i < 300; i++) feed(w, `Veto ${i.toString(36)}zz Moon`, `V${i}`);
  assert.ok(w.stats.add.over1ms < 10, `${w.stats.add.over1ms} adds over 1 ms`);
  db.close();
});

test("tracked is decided from the launch by the indexer's rule (the model has no row yet): a dropped SOL root is untracked, a spawn or an asset-quoted root is tracked", async () => {
  const { w, db } = world({ features: { bravo: { C: 1, W: 1 } } });
  fill(w, 1000);
  const ev = (name, creator, mint, o) => w.add({ mint, creator, name, symbol: "", timestamp: NOW, ...o });
  ev("Bravo one", "B0", "S0", { depth: 0, quoteMint: "So11111111111111111111111111111111111111112" });
  ev("Bravo two", "B1", "S1", { depth: 1, quoteMint: "PARENT" });
  ev("Bravo three", "B2", "S2", { depth: 0, quoteMint: "USDCmint" });
  ev("Bravo four", "B3", "S3", { depth: 0, quoteMint: "So11111111111111111111111111111111111111112" });
  ev("Bravo five", "B4", "S4", { depth: 2, quoteMint: "PARENT" });
  await settle(w);
  const tr = Object.fromEntries(all(db, "SELECT mint, tracked, reason FROM wave_coins").map((r) => [r.mint, [r.tracked, r.reason]]));
  assert.deepEqual(tr, { S0: [0, "lexical"], S1: [1, "lexical"], S2: [1, "lexical"], S3: [0, "lexical"], S4: [1, "lexical"] });
  assert.equal(w.snapshot().untracked, 2);
  db.close();
});

test("the two write buffers are capped apart: a burst of other rows drops its own oldest, never a launch row, and no hour turns partial", () => {
  const { w, db, counts } = world({ cfg: { otherBufMax: 50, launchBufMax: 30 } });
  for (let i = 0; i < 20; i++) feed(w, `qq${i}`, `C${i}`);
  // a burst of 200 other rows (a restart's back-fill, the hourly companions)
  const before = w.bufL.length;
  for (let i = 0; i < 200; i++) w.bufO.push(["waveTestPut", {}]);
  feed(w, "one more", "X"); // the next buffered row runs the cap
  assert.equal(w.bufL.length, before + 1, "no launch row dropped");
  assert.ok(w.bufO.length <= 50);
  assert.deepEqual(counts.dropped, []);
  assert.equal(w.snapshot().write.dropped, 0);
  assert.ok(w.snapshot().write.droppedOther > 0);
  // the launch buffer has its own cap; only then is an hour marked partial
  for (let i = 0; i < 20; i++) feed(w, `zz${i}`, `D${i}`);
  assert.equal(w.bufL.length, 30);
  assert.ok(counts.dropped.length > 0 && w.snapshot().write.dropped > 0);
  w.bufO.length = 0;
  db.close();
});

test("a trim's step timers are let go as they fire", async () => {
  const { w, db } = world({ cfg: { trimPauseMs: 1 } });
  await w.trim();
  assert.equal(w.trimTimers.size, 0);
  db.close();
});

test("rules v2, the clone path: one exact name from many creators forms when only the contexts fail; a near miss keeps fail ctx", () => {
  const z = formTest({ n: 48, e: 1.34, ctx: 1 });
  assert.deepEqual([z.pass, z.fail, z.via], [true, null, "clone"], "Zerocoin: 48 creators, e 1.34, one context");
  assert.ok(z.tail < 1e-8);
  assert.deepEqual([formTest({ n: 9, e: 0.01, ctx: 1 }).fail, formTest({ n: 9, e: 0.01, ctx: 1 }).via], ["ctx", null], "under cloneN");
  assert.equal(formTest({ n: 12, e: 2, ctx: 1 }).fail, "ctx", "12 < 10 x 2");
  assert.equal(formTest({ n: 10, e: 1, ctx: 2 }).fail, "ctx", "the tail at e 1 is 1.1e-7, over cloneTail");
  assert.equal(formTest({ n: 6, e: 0.5, ctx: 3 }).via, "ctx");
  assert.equal(formTest({ n: 48, e: 20, ctx: 1 }).fail, "ratio", "the ratio and tail checks still come first");
  assert.deepEqual([WAVE_DEFAULTS.cloneN, WAVE_DEFAULTS.cloneRatio, WAVE_DEFAULTS.cloneTail], [10, 10, 1e-8]);
  assert.deepEqual([tierFor(0.05, "w"), tierFor(0.05, "y"), tierFor(0.2, "y"), tierFor(0.5, "y"), tierFor(null, "y")], ["lexical", "evidence", "evidence", null, "evidence"]);
});

test("rules v2: a Zerocoin burst forms a clone wave through the Waves class and its carriers join by name; six Vetocat clones still do not", async () => {
  const { w, db } = world();
  fill(w, 1000);
  for (let i = 0; i < 9; i++) feed(w, "Zerocoin", `Z${i}`, { mint: `Z${i}m` });
  assert.equal(w.open.size, 0, "nine creators: under cloneN");
  feed(w, "Zerocoin", "Z9", { mint: "Z9m" });
  const wave = w.open.get("zerocoin");
  assert.ok(wave, "the tenth forms it");
  assert.deepEqual([wave.kind, wave.key, wave.ctx, wave.why.via], ["clone", `w:clone-zerocoin-${DAY}`, 1, "clone"]);
  for (let i = 10; i < 48; i++) feed(w, "Zerocoin", `Z${i}`, { mint: `Z${i}m` });
  await settle(w);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_coins WHERE wave_key = ? AND reason = 'lexical'", wave.key)[0].n, 48);
  assert.deepEqual(all(db, "SELECT kind FROM waves").map((r) => r.kind), ["clone"]);
  assert.deepEqual(all(db, "SELECT fail FROM wave_tests WHERE feature = 'zerocoin'").map((r) => r.fail), ["ctx"], "the near miss before the tenth");
  ["Vetocat", "Vetocat 2", "Vetocat AI", "Vetocat Inu", "Vetocat 2.0", "Vetocat"].forEach((n, i) => feed(w, n, `K${i}`));
  assert.equal(w.open.has("vetocat"), false);
  db.close();
});

test("rules v2: a symbol-only carrier is listed but not counted; it never joins by name, only with evidence; the windows stay symmetric", async () => {
  const model = fakeModel({ posts: { V0m: "555", Y0m: "555" } });
  const { w, db, clock, counts } = world({ features: { veto: { C: 2, W: 2 } }, model });
  fill(w, 1000);
  for (let i = 0; i < 6; i++) feed(w, `qy${i.toString(36)}x`, `Y${i}`, { mint: `Y${i}m`, symbol: "VETO" });
  ["Mr Veto", "Veto Cat", "Don Veto", "Veto King"].forEach((n, i) => feed(w, n, `V${i}`, { mint: `V${i}m` }));
  const F = w.feats.get("veto");
  assert.deepEqual([F.cr[0].size, F.cr[1].size, F.n[0], F.list.length - F.lh], [4, 4, 4, 10], "ten listed, four counted");
  assert.equal(w.open.size, 0, "six ticker-only carriers do not make four name carriers a wave");
  feed(w, "Veto Moon", "V4", { mint: "V4m" });
  const wave = w.open.get("veto");
  assert.ok(wave && wave.r <= 0.1);
  feed(w, "qyafterx", "Y9", { mint: "Y9m", symbol: "VETO" });
  await settle(w);
  assert.deepEqual(wave.why.carriers, { w: 5, p: 0, s: 0, y: 6 });
  const reasons = Object.fromEntries(all(db, "SELECT mint, reason, how FROM wave_coins").map((r) => [r.mint, `${r.reason}:${r.how}`]));
  for (let i = 0; i < 5; i++) assert.equal(reasons[`V${i}m`], "lexical:w");
  for (const m of ["Y0m", "Y1m", "Y5m", "Y9m"]) assert.equal(reasons[m], "pending:y", m);
  await w.evidencePass(); flushAll(w);
  assert.equal(coin(db, "Y0m").reason, "post", "the same post as a name carrier of another creator");
  assert.equal(coin(db, "Y1m").reason, "pending");
  // every launch leaves both windows: the counts return to exactly zero (the open wave keeps the entry)
  clock.s += 6 * 3600 + 10; w.tick();
  assert.deepEqual([F.cr[0].size, F.n[0], F.cr[1].size, F.n[1]], [0, 0, 5, 5], "the 6 h window is empty, the 24 h one holds the five name carriers");
  clock.s += 18 * 3600; counts.base = baseOf(clock, { veto: { C: 2, W: 2 } }); w.tick();
  const G = w.feats.get("veto");
  assert.equal(G, F, "the wave was still open when its launches left");
  assert.deepEqual([G.cr[0].size, G.cr[1].size, G.cx[1].size, G.n[0], G.n[1], G.s[1]], [0, 0, 0, 0, 0, 0]);
  db.close();
});

/** A v1 wave row as the live database holds it. */
const v1Wave = (key, feature, o = {}) => ({ key, feature, kind: "seg", v: 1, formedT: NOW - 3600, formedAt: NOW - 3600, win: 6 * 3600, n: 102, ctx: 40, e: 3, r: 0.03, tail: 1e-30, share0: 1e-4, cBase: 5, cMissing: false, baseN: 100_000, baseHours: 600, baseH: 1, nWin: 10_000, lastT: NOW - 60, endedT: null, reopens: 0, members: 102, pending: 0, unconfirmed: 0, why: { v: 1 }, ...o });

test("rules v2, the version reset: v1 rows go once (waves, coins, candidacies, hours), near misses and launches stay, kv is set; a second start does nothing; a stray v1 row is never loaded", () => {
  const db = new Db(":memory:"), clock = { s: NOW };
  db.transaction(() => {
    db.wavePut(v1Wave("w:seg-ing-20261118", "ing"));
    db.waveCoinPut({ mint: "Q1", t: NOW - 600, reason: "lexical", waveKey: "w:seg-ing-20261118", how: "s" });
    db.waveCandPut("Q1", "w:seg-ing-20261118", 0.03, "s", NOW - 600);
    db.waveHourPut({ h: Math.floor(NOW / 3600) - 1, key: "w:seg-ing-20261118" });
    db.waveTestPut({ h: Math.floor(NOW / 3600) - 1, feature: "zerocoin", v: 1, fail: "ctx" });
    db.waveLaunchPut([NOW - 60, "Q2", NOW * 1000 - 60_000, "C2", "Big Dog", "BDOG", "big:w,dog:w,bdog:w", 1]);
  });
  assert.equal(db.kvGet("waveRulesV"), null);
  const a = world({ db, clock });
  const reset = a.w.snapshot().rules.reset;
  assert.deepEqual([reset.from, reset.to, reset.waves, reset.coins, reset.cands, reset.hours], [null, WAVE_RULES_V, 1, 1, 1, 1]);
  assert.equal(db.kvGet("waveRulesV"), WAVE_RULES_V);
  for (const t of ["waves", "wave_coins", "wave_cands", "wave_hours"]) assert.equal(all(db, `SELECT COUNT(*) AS n FROM ${t}`)[0].n, 0, t);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_tests")[0].n, 1, "near misses keep their v");
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_launches")[0].n, 1);
  // the restored v1 launch reads as v2: its ticker word is symbol-only and counted nowhere
  assert.deepEqual(a.w.byMint.get("Q2").feats.map((x) => `${x.f}:${x.how}`), ["big:w", "dog:w", "bdog:y"]);
  assert.equal(a.w.feats.get("bdog").cr[1].size, 0);
  // rows written under v2, plus a stray v1 row: a second start deletes nothing and loads only its own version
  db.wavePut(v1Wave("w:seg-ers-20261118", "ers"));
  db.wavePut(v1Wave(`w:word-veto-${DAY}`, "veto", { kind: "word", v: WAVE_RULES_V }));
  db.waveCoinPut({ mint: "Q3", t: NOW - 60, reason: "lexical", waveKey: `w:word-veto-${DAY}`, how: "w" });
  const b = world({ db, clock });
  assert.equal(b.w.snapshot().rules.reset, null);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM waves")[0].n, 2);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM wave_coins")[0].n, 1);
  assert.deepEqual([b.w.open.has("veto"), b.w.open.has("ers"), b.w.snapshot().rules.skipped], [true, false, 1]);
  // a clean database: kv set, nothing reset
  const c = world();
  assert.deepEqual([c.db.kvGet("waveRulesV"), c.w.snapshot().rules.reset], [WAVE_RULES_V, null]);
  db.close(); c.db.close();
});

test("rules v2, restart: a v1 grammar-suffix cut restored from wave_launches is not counted, so a later ING ticker forms no 'ing' wave", () => {
  const db = new Db(":memory:"), clock = { s: NOW };
  const stems = ["buy", "farm", "pump", "jump", "talk", "walk", "cook", "read", "kick", "mark", "park", "bark", "dunk", "fish", "hunt", "lift", "melt", "pick", "rock", "surf"];
  db.transaction(() => {
    stems.forEach((st, i) => db.waveLaunchPut([NOW - 600 + i, `G${i}m`, (NOW - 600 + i) * 1000, `G${i}`, `${st}ing Dog`, "", `${st}ing:w,dog:w,${st}:s:ing,ing:s:${st}`, 1]));
  });
  const { w } = world({ db, clock });
  assert.equal(w.byMint.get("G0m").feats.map((x) => `${x.f}:${x.how}`).join(","), "buying:w,dog:w");
  assert.equal(w.feats.get("ing")?.cr[1].size ?? 0, 0, "no restored launch carries ing");
  fill(w, 1000);
  feed(w, "Totally Other", "T1", { mint: "T1m", symbol: "ING" });
  assert.equal(w.open.size, 0);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM waves")[0].n, 0);
  db.close();
});

test("rules v2: a failed version check keeps waves off in this process (no counts, no restore, launches dropped) and shows it in health", () => {
  const db = new Db(":memory:"), clock = { s: NOW };
  db.wavePut(v1Wave("w:seg-ing-20261118", "ing"));
  db.waveLaunchPut([NOW - 60, "Q2", NOW * 1000 - 60_000, "C2", "Big Dog", "BDOG", "big:w,dog:w,bdog:w", 1]);
  let calls = 0;
  db.wavesRulesReset = () => { calls++; throw new Error("SQLITE_BUSY"); };
  const counts = fakeCounts(baseOf(clock));
  let started = 0; counts.start = () => { started++; };
  const w = new NameWaves({ db, counts, now: () => clock.s * 1000, log: quiet, cfg: IDLE }).start();
  assert.equal(calls, 2, "tried twice");
  assert.equal(started, 0, "the counts are not started");
  assert.equal(db.kvGet("waveRulesV"), null);
  assert.equal(w.byMint.size, 0, "nothing restored");
  assert.equal(w.timers.length, 0);
  feed(w, "Zerocoin", "Z1");
  assert.deepEqual([w.byMint.size, counts.added.length], [0, 0]);
  const s = w.snapshot();
  assert.match(s.rules.off, /SQLITE_BUSY/);
  assert.equal(s.rules.offDropped, 1);
  assert.equal(all(db, "SELECT COUNT(*) AS n FROM waves")[0].n, 1, "the v1 row is left for the next start");
  db.close();
});

test("rules v3: a burst carried only as a split piece never forms through the clone path (Terrier -> ter + rier); the whole name still forms its clone wave", async () => {
  const { w, db } = world({ features: { ter: { C: 8, W: 8, known: true } } });
  fill(w, 1000);
  for (let i = 0; i < 12; i++) feed(w, "Terrier", `R${i}`, { mint: `R${i}m` });
  const F = w.feats.get("rier");
  assert.deepEqual([F.cr[0].size, F.cx[0].size, F.s[0], F.n[0]], [12, 1, 12, 12], "twelve creators, one context, every carriage a split");
  assert.equal(formTest({ n: 12, e: 0.02, ctx: 1 }).via, "clone", "the counts alone would pass the clone path");
  assert.ok(!w.open.has("rier") && !w.open.has("ter"), "no wave from the split pieces");
  const wave = w.open.get("terrier");
  assert.ok(wave, "the whole name is a clone burst");
  assert.deepEqual([wave.kind, wave.why.via], ["clone", "clone"]);
  await settle(w);
  assert.deepEqual(all(db, "SELECT kind, feature FROM waves").map((r) => `${r.kind}:${r.feature}`), ["clone:terrier"]);
  assert.deepEqual(all(db, "SELECT DISTINCT fail FROM wave_tests WHERE feature IN ('rier', 'ter')").map((r) => r.fail), ["ctx"], "recorded as near misses on the context rule");
  db.close();
});

test("rules v3, restart: launches stored before kv waveRulesAt lose their splits, later ones keep them; waveRulesAt is set on a version change, not on a normal restart", () => {
  const db = new Db(":memory:"), clock = { s: NOW };
  db.kvSet("waveRulesV", 2);
  db.transaction(() => {
    for (let i = 0; i < 5; i++) db.waveLaunchPut([NOW - 600 + i, `O${i}m`, (NOW - 600 + i) * 1000, `O${i}`, "Catmas", "", "catmas:w,cat:s:mas,mas:s:cat", 1]);
  });
  const a = world({ db, clock });
  assert.equal(db.kvGet("waveRulesAt"), NOW, "set when the version changes");
  assert.equal(db.kvGet("waveRulesV"), WAVE_RULES_V);
  assert.deepEqual(a.w.byMint.get("O0m").feats.map((x) => `${x.f}:${x.how}`), ["catmas:w"]);
  assert.equal(a.w.feats.get("mas")?.cr[1].size ?? 0, 0, "the old splits count no creator");
  db.transaction(() => {
    for (let i = 0; i < 3; i++) db.waveLaunchPut([NOW + 60 + i, `N${i}m`, (NOW + 60 + i) * 1000, `N${i}`, "Dogmas", "", "dogmas:w,dog:s:mas,mas:s:dog", 1]);
  });
  clock.s = NOW + 120;
  const b = world({ db, clock });
  assert.equal(db.kvGet("waveRulesAt"), NOW, "a normal restart leaves it");
  assert.equal(b.w.snapshot().rules.reset, null);
  assert.deepEqual(b.w.byMint.get("O1m").feats.map((x) => `${x.f}:${x.how}`), ["catmas:w"]);
  assert.deepEqual(b.w.byMint.get("N0m").feats.map((x) => `${x.f}:${x.how}`), ["dogmas:w", "dog:s", "mas:s"]);
  assert.deepEqual([b.w.feats.get("mas").cr[1].size, b.w.feats.get("mas").s[1], b.w.feats.get("cat")?.cr[1].size ?? 0], [3, 3, 0], "only the launches after waveRulesAt carry mas");
  const c = world();
  assert.equal(c.db.kvGet("waveRulesAt"), NOW, "a clean database records it too");
  db.close(); c.db.close();
});
