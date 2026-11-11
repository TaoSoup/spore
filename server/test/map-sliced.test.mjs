// The whole-forest map without holding the event loop (Nov 11 2026: one /api/map rebuild was a 3.4 s block on the
// local index, 155k coins): the build, the delta and the JSON encoding run as generators in slices (sliced.mjs), and
// big bodies are compressed on the thread pool. Everything a client receives must stay byte for byte what the
// synchronous code gave. No network: a synthetic tree behind the express app, a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync, constants as Z } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { createApp, mapApiPrepared, preparedWithIndexed } from "../lib/api.mjs";
import { prepareJson, prepareJsonText, prepareJsonGen, preparedBytes, etagOf, ASYNC_ENCODE_BYTES, POOL_COMPRESSIONS, POOL_CAP_BYTES, compressionStats } from "../lib/http.mjs";
import { drain, runSliced, slicedStats, SLICE_MS } from "../lib/sliced.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";

const keyN = (n) => new PublicKey(createHash("sha256").update(`map-sliced-${n}`).digest()).toBase58();
const ASSET = keyN("asset");

/**
 * SOL roots with children (ties in locked value and in price, some grandchildren) and one listed asset whose family
 * is drawn capped: the shapes mapAll orders and counts. About 26 coins per root, plus `assetKids`.
 */
function buildModel({ clock, roots = 40, kids = 20, assetKids = 400, mode = "all", mapSinceNodes } = {}) {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode, now: () => clock.t, log: quiet, assetFamilyDraw: 60, ...(mapSinceNodes ? { mapSinceNodes } : {}) });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  model.setQuoteUsd(ASSET, 1);
  let seq = 0;
  const kidsOf = [];
  for (let r = 0; r < roots; r++) {
    const root = keyN(++seq);
    model.upsertCoin({ mint: root, curve: `C${seq}`, depth: 0, quoteMint: null, ...base, virtualQuoteReserves: String(100_000_000_000 + (r % 7) * 1_000_000_000), createdAt: 1000 + r });
    for (let k = 0; k < kids; k++) {
      const kid = keyN(++seq);
      // locked value repeats every 5 children and price every 3: ties at both keys
      model.upsertCoin({ mint: kid, curve: `C${seq}`, depth: 1, quoteMint: root, ...base, virtualQuoteReserves: String(1_000_000_000_000_000 + (k % 3) * 100_000_000_000_000), realQuoteReserves: String((k % 5) * 1_000_000_000_000), createdAt: 2000 + k });
      kidsOf.push(kid);
      if (k % 4 === 0) { const g = keyN(++seq); model.upsertCoin({ mint: g, curve: `C${seq}`, depth: 2, quoteMint: kid, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: String(k * 10_000_000_000), createdAt: 3000 }); }
    }
  }
  const nowS = Math.floor(clock.t / 1000);
  for (let a = 0; a < assetKids; a++) {
    const m = keyN(++seq);
    model.upsertCoin({ mint: m, curve: `C${seq}`, depth: 0, quoteMint: ASSET, ...base, virtualQuoteReserves: String(1_000_000_000 + (a % 37) * 10_000_000), realQuoteReserves: String((a % 11) * 1_000_000), createdAt: a % 9 === 0 ? nowS - 60 : 1000 });
  }
  model.setMint({ mint: keyN(1), decimals: 6, tokenProgram: T22, name: "Ünïcode — 🍄", symbol: "SP…RE", uri: "https://ipfs.io/ipfs/sliced", onchainAt: 1 });
  model.setMeta("https://ipfs.io/ipfs/sliced", { image: "https://ipfs.io/ipfs/sliced-img", description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true });
  clock.t += 10_000; // past the setup's stamps (strictly monotonic, +1 ms each while the fake clock stood still)
  model.computed();
  return { db, model, kidsOf };
}

function* work(steps, ms, tag = "done") { for (let i = 0; i < steps; i++) { const t = performance.now(); while (performance.now() - t < ms); yield; } return tag; }

test("runSliced: the generator runs in bounded turns with I/O between, returns its value; drain runs it at once; a throw rejects", async () => {
  let turns = 0;
  const tick = setInterval(() => { turns++; }, 0);
  const run = await runSliced(work(40, 2));
  clearInterval(tick);
  assert.equal(run.value, "done");
  assert.ok(run.slices >= 6, `${run.slices} turns`);
  assert.ok(run.maxSliceMs < 40, `longest turn share ${run.maxSliceMs.toFixed(1)} ms`);
  assert.ok(run.cpuMs >= 75, `${run.cpuMs.toFixed(1)} ms of work counted`);
  assert.ok(turns >= 2, `timers ran between the turns (${turns})`);
  assert.equal(drain(work(3, 0)), "done");
  await assert.rejects(runSliced((function* () { yield; throw new Error("boom"); })()), /boom/);
});

test("runSliced: one scheduler for every job: K jobs in flight still hold the loop one SLICE_MS per turn, and all of them progress", async () => {
  const K = 12;
  slicedStats.maxTurnMs = 0; slicedStats.maxJobs = 0;
  const finished = [];
  let worstGap = 0, last = performance.now();
  const probe = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 1);
  const runs = await Promise.all(Array.from({ length: K }, (_, i) => runSliced(work(20, 1, i)).then((r) => { finished.push(r.value); return r; })));
  clearInterval(probe);
  assert.deepEqual(runs.map((r) => r.value), Array.from({ length: K }, (_, i) => i));
  assert.equal(slicedStats.maxJobs, K, "all of them were in flight together");
  assert.ok(slicedStats.maxTurnMs < SLICE_MS + 6, `longest turn ${slicedStats.maxTurnMs.toFixed(1)} ms for ${K} jobs`);
  assert.ok(worstGap < 60, `a 1 ms timer waited at most ${worstGap.toFixed(1)} ms (K setImmediates would hold it ~${K * SLICE_MS} ms)`);
  // round-robin: the jobs share the turns, so none finishes long before the others
  assert.ok(Math.min(...runs.map((r) => r.slices)) >= 2, "each job ran over several turns");
});

test("prepareJsonGen gives JSON.stringify's bytes and etagOf's ETag: trees split child by child, flat lists, a tail, a transform, unicode, the fallback", async () => {
  const coin = (i) => ({ mint: `m${i}`, name: i % 7 ? `coin ${i}` : "Ünïcode — 🍄 \"q\" \\  ", image: i % 3 ? `/api/img?u=https%3A%2F%2Fx%2F${i}` : null, mcapUsd: i % 5 ? i * 1.25 : null, depth: i % 3, ours: false, nan: NaN, inf: -Infinity, missing: undefined });
  let n = 0;
  const tree = (depth) => ({ coin: coin(n++), children: depth > 0 ? Array.from({ length: n % 6 }, () => tree(depth - 1)) : [] });
  const roots = Array.from({ length: 900 }, () => tree(3)); // > 64 KB of text: many chunks
  roots.push({ coin: undefined, children: [tree(1), tree(1), tree(1), tree(1)] }, { coin: coin(1), children: [tree(1)], extra: 1 }, null, 7);
  const big = { roots, scope: "all", version: 12, generatedAt: 1_800_000_000_000, total: n };
  const flat = { nodes: Array.from({ length: 3000 }, (_, i) => ({ ...coin(i), parentMint: i % 2 ? `p${i}` : null })), removed: [], generatedAt: 1, total: 3000, version: 9 };
  const abs = (t) => t.replaceAll('"image":"/api/img?', '"image":"https://example.test/api/img?');
  const tail = ',"indexed":4242}';
  for (const [body, key] of [[big, "roots"], [flat, "nodes"]]) {
    for (const opts of [{}, { tail }, { transform: abs }, { tail, transform: abs }]) {
      let text = JSON.stringify(body);
      if (opts.tail) text = text.slice(0, -1) + opts.tail;
      if (opts.transform) text = opts.transform(text);
      const want = prepareJsonText(text);
      const run = await runSliced(prepareJsonGen(body, { key, ...opts }));
      assert.ok(run.value.bytes.equals(want.bytes), `${key} ${JSON.stringify(Object.keys(opts))}: same bytes`);
      assert.equal(run.value.etag, etagOf(text)); assert.equal(run.value.text, text, "text decodes from the bytes");
      assert.ok(drain(prepareJsonGen(body, { key, ...opts })).bytes.equals(want.bytes), "drained: the same");
      if (key === "roots" && !opts.tail && !opts.transform) assert.ok(run.slices > 1, `${run.slices} slices`);
    }
  }
  // a body whose big array is not its first key: encoded in one go, same bytes
  const odd = { scope: "all", roots: [{ coin: coin(1), children: [] }] };
  assert.ok(drain(prepareJsonGen(odd, { key: "roots", tail })).bytes.equals(Buffer.from(JSON.stringify(odd).slice(0, -1) + tail)));
});

test("mapAllAsync / mapSinceAsync give the entries and the /api bytes the synchronous build gives; concurrent callers share one build", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model } = buildModel({ clock });
  const sync = model.mapAll({ all: true });
  const syncBytes = preparedWithIndexed(prepareJson(sync.body), sync.indexed);
  model.mapCache = null;
  const builds = model.mapStats.builds;
  const a = model.mapAllAsync({ all: true }), b = model.mapAllAsync({ all: true });
  assert.equal(a, b, "one job for both callers");
  const entry = await a;
  assert.equal(model.mapStats.builds, builds + 1, "built once");
  assert.equal(JSON.stringify(entry.body), JSON.stringify(sync.body));
  assert.equal(entry.total, sync.total); assert.equal(entry.indexed, sync.indexed);
  assert.ok(entry.body.roots.some((r) => r.coin.asset && r.children.length === 60 && r.coin.children === 400), "the asset family is drawn capped");
  const p = await mapApiPrepared(entry);
  assert.ok(p.bytes.equals(syncBytes.bytes)); assert.equal(p.etag, syncBytes.etag);
  assert.equal(await mapApiPrepared(entry), p, "encoded once per entry");
  assert.equal(await model.mapAllAsync({ all: true }), entry, "cached like mapAll");
  assert.equal(model.mapAll({ all: true }), entry, "and the synchronous call sees the same entry");
  // the delta, for a cursor that leaves some nodes changed
  const since = entry.body.generatedAt - 10_000 - 500;
  const ds = model.mapSince({ all: true, since });
  model.mapSinceCache.clear();
  const da = await model.mapSinceAsync({ all: true, since });
  assert.equal(JSON.stringify(da.body), JSON.stringify(ds.body)); assert.equal(da.indexed, ds.indexed);
  assert.ok(da.body.nodes.length > 0, "a non-empty delta");
  assert.equal(da.body.total, entry.total, "the full map's count");
  db.close();
});

test("a sliced build lets the loop run and never misses a change made while it runs: since=<generatedAt> carries it", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model, kidsOf } = buildModel({ clock, roots: 160, kids: 20, assetKids: 300 }); // ~4.5k coins: several slices
  const target = kidsOf[123];
  // The 100th node the build draws schedules the change for the next turn: it lands between two turns of the build.
  let calls = 0, built = false, ranMidBuild = false;
  model.mapRef = function (...a) {
    if (++calls === 100) setImmediate(() => { ranMidBuild = !built; model.upsertCoin({ mint: target, realQuoteReserves: "987654321000" }); });
    return Model.prototype.mapRef.apply(this, a);
  };
  const entry = await model.mapAllAsync({ all: true }).then((e) => { built = true; return e; });
  delete model.mapRef;
  assert.ok(model.mapStats.lastSlices > 1, `${model.mapStats.lastSlices} slices`);
  assert.ok(ranMidBuild, "the change landed between two turns of the build");
  assert.ok(model.get(target).updatedAt > entry.body.generatedAt, "stamped after the build's generatedAt");
  const delta = await model.mapSinceAsync({ all: true, since: entry.body.generatedAt });
  assert.ok(delta.body.nodes.some((x) => x.mint === target), "the next delta carries it");
  db.close();
});

test("GET /api/map: the same bytes and headers as before, a burst shares one build, big bodies compressed on the thread pool to the sync API's bytes", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model } = buildModel({ clock, roots: 120, kids: 20 });
  const dir = mkdtempSync(join(tmpdir(), "spore-sliced-"));
  const hub = new EventHub({ heartbeatMs: 60_000 });
  const images = new ImageCache(dir, { fetchImpl: async () => new Response("", { status: 404 }) });
  const indexer = { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  const app = createApp({ model, indexer, rpc: { getMultipleAccounts: async (k) => k.map(() => null), snapshot: () => ({}) }, hub, images, meta: null, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], distDir: null, log: quiet, now: () => clock.t });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/map?scope=all&limit=all`;
  // raw bytes as sent (node:http, so nothing is decoded on the way)
  const { request } = await import("node:http");
  const raw = (enc) => new Promise((resolve, reject) => {
    request(url, { headers: enc ? { "accept-encoding": enc } : {} }, (res) => { const parts = []; res.on("data", (c) => parts.push(c)); res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(parts) })); }).on("error", reject).end();
  });
  try {
    const builds = model.mapStats.builds;
    const burst = await Promise.all([raw(null), raw("br"), raw("gzip"), raw("br")]);
    assert.equal(model.mapStats.builds, builds + 1, "four requests, one build");
    const entry = model.mapAll({ all: true });
    const want = preparedWithIndexed(prepareJson(entry.body), entry.indexed);
    assert.ok(want.bytes.length >= ASYNC_ENCODE_BYTES, `a body past the thread-pool threshold (${want.bytes.length} B)`);
    const [plain, br, gz, br2] = burst;
    assert.ok(plain.body.equals(want.bytes), "identity: the bytes");
    assert.ok(br.body.equals(brotliCompressSync(want.bytes, { params: { [Z.BROTLI_PARAM_QUALITY]: 4 } })), "brotli: the sync API's bytes");
    assert.ok(br2.body.equals(br.body));
    assert.ok(gz.body.equals(gzipSync(want.bytes, { level: 6 })), "gzip: the sync API's bytes");
    assert.ok(brotliDecompressSync(br.body).equals(want.bytes) && gunzipSync(gz.body).equals(want.bytes));
    for (const r of burst) {
      assert.equal(r.headers.etag, want.etag); assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(Number(r.headers["content-length"]), r.body.length); assert.match(r.headers["cache-control"], /max-age=10/);
      assert.ok(r.headers["x-map-build-ms"] != null && r.headers["x-map-encode-ms"] != null);
    }
    assert.equal(br.headers["content-encoding"], "br"); assert.equal(gz.headers["content-encoding"], "gzip"); assert.equal(plain.headers["content-encoding"], undefined);
    assert.match(br.headers.vary ?? "", /accept-encoding/);
    // since=: the delta's bytes are preparedWithIndexed(prepareJson(body)) too, without a build header
    const d = await new Promise((resolve, reject) => { request(`${url}&since=${entry.body.generatedAt - 10_500}`, (res) => { const parts = []; res.on("data", (c) => parts.push(c)); res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(parts) })); }).on("error", reject).end(); });
    const de = model.mapSince({ all: true, since: entry.body.generatedAt - 10_500 });
    assert.ok(d.body.equals(preparedWithIndexed(prepareJson(de.body), de.indexed).bytes));
    assert.equal(d.headers["x-map-build-ms"], undefined); assert.ok(d.headers["x-map-encode-ms"] != null);
  } finally { server.close(); hub.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ourCount (health's ourCoins) is scope().ours.size without building the scope", () => {
  const clock = { t: 1_800_000_000_000 };
  for (const mode of ["all", "ours"]) {
    const { db, model, kidsOf } = buildModel({ clock, roots: 4, kids: 6, assetKids: 5, mode });
    model.upsertCoin({ mint: kidsOf[0], shares: [{ address: PLATFORM, bps: 5000 }, { address: keyN("x"), bps: 5000 }] });
    model.upsertCoin({ mint: kidsOf[1], shares: [{ address: PLATFORM, bps: 10 }] }); // too small a share: not ours
    model.markPending(kidsOf[2], "sig");
    assert.equal(model.ourCount(), 2, mode);
    assert.equal(model.ourCount(), model.scope().ours.size, mode);
    clock.t += 11 * 60_000; // the pending spawn expires
    assert.equal(model.ourCount(), 1, `${mode}: expired pending`);
    assert.equal(model.ourCount(), model.scope().ours.size);
    db.close();
  }
});

test("without scope=all the listing scope is taken once per job, however often trades move the version between turns", async () => {
  for (const mode of ["ours", "all"]) {
    const clock = { t: 1_800_000_000_000 };
    const { db, model, kidsOf } = buildModel({ clock, roots: 120, kids: 20, assetKids: 200, mode });
    for (let i = 0; i < kidsOf.length; i += 4) model.upsertCoin({ mint: kidsOf[i], shares: [{ address: PLATFORM, bps: 5000 }] }); // a quarter are ours
    // a scope build asks isOurCoin once per coin: count the builds through it
    let asked = 0;
    model.isOurCoin = function (c) { asked++; return Model.prototype.isOurCoin.call(this, c); };
    // each node a little slower, so a job spans many turns; a trade (version bump) between every two turns
    model.mapRef = function (...a) { const t = performance.now(); while (performance.now() - t < 0.05); return Model.prototype.mapRef.apply(this, a); };
    let running = true;
    const trade = () => { model.setSolUsd(model.solUsd * 1.0001); if (running) setImmediate(trade); };
    const before = model.version;
    setImmediate(trade);
    const [since, full] = await Promise.all([model.mapSinceAsync({ all: false, since: 0 }), model.mapAllAsync({ all: false })]);
    running = false;
    assert.ok(model.version - before >= 3, `${mode}: trades landed during the jobs (${model.version - before})`);
    const builds = asked / model.coins.size;
    if (mode === "all") assert.equal(asked, 0, "mode all: the listing scope is every tracked coin, nothing builds it");
    else assert.ok(builds <= 2, `mode ours: ${builds.toFixed(1)} scope builds for two jobs`);
    assert.ok(full.body.roots.length > 0 && since.body.nodes.length > 0);
    delete model.isOurCoin; delete model.mapRef;
    // the same bodies as building at once, once nothing moves
    model.mapCache = null; model.mapSinceCache.clear();
    const [s2, f2] = await Promise.all([model.mapSinceAsync({ all: false, since: 0 }), model.mapAllAsync({ all: false })]);
    model.mapSinceCache.clear(); const s1 = model.mapSince({ all: false, since: 0 });
    model.mapCache = null; const f1 = model.mapAll({ all: false });
    assert.equal(JSON.stringify(s2.body), JSON.stringify(s1.body)); assert.equal(JSON.stringify(f2.body), JSON.stringify(f1.body));
    db.close();
  }
});

test("mode ours without scope=all: the version is read after the expired pending spawns are swept, at once and sliced alike", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model, kidsOf } = buildModel({ clock, roots: 6, kids: 6, assetKids: 5, mode: "ours" });
  model.upsertCoin({ mint: kidsOf[1], shares: [{ address: PLATFORM, bps: 5000 }] });
  const runs = { mapAll: (m) => m.mapAll({ all: false }), mapAllAsync: (m) => m.mapAllAsync({ all: false }), mapSince: (m) => m.mapSince({ all: false, since: 0 }), mapSinceAsync: (m) => m.mapSinceAsync({ all: false, since: 0 }) };
  for (const [name, run] of Object.entries(runs)) {
    model.markPending(kidsOf[4], "sig");
    clock.t += 11 * 60_000; // its window ran out, and nothing swept it yet
    model.mapCache = null; model.mapSinceCache.clear();
    const e = await run(model);
    assert.equal(model.pending.size, 0, `${name}: swept`);
    assert.equal(e.body.version, model.version, `${name}: the swept state's version`); assert.equal(e.version, model.version);
    assert.ok(model.get(kidsOf[4]).updatedAt > e.body.generatedAt, `${name}: the swept coin is stamped after generatedAt`);
  }
  db.close();
});

test("mode all: scope=all and the listing scope are different bodies and never share a cache entry or a job", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model } = buildModel({ clock, roots: 10, kids: 4, assetKids: 30 });
  const [scoped, all] = await Promise.all([model.mapAllAsync({ all: false }), model.mapAllAsync({ all: true })]);
  assert.notEqual(scoped, all);
  assert.ok(all.body.roots.some((r) => r.coin.asset), "scope=all draws the asset top");
  assert.ok(!scoped.body.roots.some((r) => r.coin.asset), "the listing scope does not");
  const [s1, s2] = await Promise.all([model.mapSinceAsync({ all: false, since: 0 }), model.mapSinceAsync({ all: true, since: 0 })]);
  assert.notEqual(s1, s2); assert.notEqual(JSON.stringify(s1.body), JSON.stringify(s2.body));
  assert.equal(model.mapSince({ all: true, since: 0 }), s2, "each from its own cache entry");
  assert.equal(model.mapSince({ all: false, since: 0 }), s1);
  db.close();
});

test("a shallower build does not set the map's node count: since= keeps the default-depth total", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model } = buildModel({ clock, roots: 10, kids: 6, assetKids: 30 });
  const full = model.mapAll({ all: true });
  const shallow = model.mapAll({ all: true, depth: 0 });
  assert.ok(shallow.total < full.total);
  assert.equal(model.mapSince({ all: true, since: clock.t }).body.total, full.total);
  assert.equal((await model.mapSinceAsync({ all: true, since: clock.t + 1 })).body.total, full.total);
  assert.equal(model.mapTotal(true), full.total);
  db.close();
});

test("since= jobs started at one version share one context and one whole-tree count", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model } = buildModel({ clock, roots: 120, kids: 20 });
  let lists = 0;
  model.childrenOf = function (m) { lists++; return Model.prototype.childrenOf.call(this, m); };
  await model.mapSinceAsync({ all: true, since: clock.t - 1 });
  const alone = lists;
  model.setSolUsd(model.solUsd * 1.01); // a new version: no per-version cache answers
  lists = 0;
  const burst = await Promise.all([1, 2, 3, 4].map((i) => model.mapSinceAsync({ all: true, since: clock.t - 1 - i })));
  assert.ok(alone > 1000 && lists < alone * 1.5, `four jobs listed children ${lists} times, one job alone ${alone}`);
  assert.equal(new Set(burst.map((e) => `${e.body.total}:${e.indexed}`)).size, 1);
  delete model.childrenOf;
  db.close();
});

test("full builds of different keys run one after another, each as the synchronous build gives it", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model } = buildModel({ clock, roots: 60, kids: 20 });
  slicedStats.maxJobs = 0;
  const [d1, d2, scoped] = await Promise.all([model.mapAllAsync({ all: true, depth: 1 }), model.mapAllAsync({ all: true, depth: 2 }), model.mapAllAsync({ all: false })]);
  assert.equal(slicedStats.maxJobs, 1, "one build in flight at a time");
  for (const [e, opts] of [[d1, { all: true, depth: 1 }], [d2, { all: true, depth: 2 }], [scoped, { all: false }]]) {
    model.mapCache = null;
    assert.equal(JSON.stringify(e.body), JSON.stringify(model.mapAll(opts).body));
  }
  db.close();
});

test("thread-pool compressions of map-sized bodies run two at a time, in the sync API's bytes", async () => {
  const bodies = Array.from({ length: 4 }, (_, i) => Buffer.from(JSON.stringify(Array.from({ length: 160_000 }, (_, j) => ({ i, j, s: `x${(j * 7919 + i) % 997}` })))));
  assert.ok(bodies[0].length >= POOL_CAP_BYTES, `map-sized (${bodies[0].length} B): smaller bodies skip the cap`);
  compressionStats.maxActive = 0;
  const prepared = bodies.map((b, i) => preparedBytes(b, `W/"${i}"`));
  const out = await Promise.all(prepared.flatMap((p) => [p.encodedAsync("br"), p.encodedAsync("gzip")]));
  assert.equal(compressionStats.maxActive, POOL_COMPRESSIONS, `at most ${POOL_COMPRESSIONS} at once`);
  assert.equal(compressionStats.active, 0); assert.equal(compressionStats.waiting, 0);
  bodies.forEach((b, i) => {
    assert.ok(out[2 * i].equals(brotliCompressSync(b, { params: { [Z.BROTLI_PARAM_QUALITY]: 4 } })));
    assert.ok(out[2 * i + 1].equals(gzipSync(b, { level: 6 })));
  });
});

test("the since= cache drops its oldest deltas past the node budget, never the one it serves", () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model } = buildModel({ clock, roots: 20, kids: 6, assetKids: 20 });
  const one = model.mapSince({ all: true, since: 0 }).body.nodes.length;
  const small = buildModel({ clock: { t: 1_800_000_000_000 }, roots: 20, kids: 6, assetKids: 20, mapSinceNodes: Math.floor(one * 2.5) });
  for (let s = 0; s < 6; s++) small.model.mapSince({ all: true, since: s });
  assert.equal(small.model.mapSinceCache.size, 2, "two whole-forest deltas fit the budget");
  assert.ok(small.model.mapSinceCache.has("all:5"), "the newest stays");
  const tiny = buildModel({ clock: { t: 1_800_000_000_000 }, roots: 20, kids: 6, assetKids: 20, mapSinceNodes: 10 });
  tiny.model.mapSince({ all: true, since: 0 });
  assert.equal(tiny.model.mapSinceCache.size, 1, "past the budget on its own, the delta being served is still kept");
  db.close(); small.db.close(); tiny.db.close();
});

test("a since= delta that a change overtook between two turns is served only for MAP_CACHE_MS, not for as long as the model stays quiet", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model, kidsOf } = buildModel({ clock, roots: 160, kids: 20, assetKids: 300 });
  const X = kidsOf[0]; // among the first coins the scan draws
  model.setMint({ mint: X, decimals: 6, tokenProgram: T22, name: "old name", symbol: "OLD", uri: null, onchainAt: 1 });
  clock.t += 1_000;
  let calls = 0;
  model.mapRef = function (...a) { if (++calls === 300) setImmediate(() => model.setMint({ mint: X, name: "NEW NAME" })); return Model.prototype.mapRef.apply(this, a); };
  const first = await model.mapSinceAsync({ all: true, since: 0 });
  delete model.mapRef;
  assert.equal(first.body.nodes.find((x) => x.mint === X)?.name, "old name", "the job drew X before the rename");
  assert.equal(model.mint(X).name, "NEW NAME", "the rename landed while the job ran");
  assert.equal(first.body.version, model.version, "the body's version is still read last (deceb84's bytes)");
  assert.equal(await model.mapSinceAsync({ all: true, since: 0 }), first, "within MAP_CACHE_MS the entry is served, as every entry is");
  clock.t += 60_000; // nothing else changes
  const later = await model.mapSinceAsync({ all: true, since: 0 });
  assert.notEqual(later, first, "past MAP_CACHE_MS the overtaken entry is not served again");
  assert.equal(later.body.nodes.find((x) => x.mint === X)?.name, "NEW NAME");
  clock.t += 60_000;
  assert.equal(await model.mapSinceAsync({ all: true, since: 0 }), later, "a delta nothing overtook is served while the version holds");
  db.close();
});

test("a small body's thread-pool compression does not queue behind map-sized ones", async () => {
  const big = (i) => Buffer.from(JSON.stringify(Array.from({ length: 160_000 }, (_, j) => ({ i, j, s: `v${(j * 7919 + i * 31) % 100_003}` }))));
  const bigs = [1, 2, 3].map((i) => preparedBytes(big(i), `W/"big${i}"`));
  assert.ok(bigs[0].bytes.length >= POOL_CAP_BYTES, `map-sized bodies (${bigs[0].bytes.length} B)`);
  const small = preparedBytes(Buffer.from(JSON.stringify(Array.from({ length: 12_000 }, (_, j) => ({ j, s: `w${j}` })))), 'W/"small"');
  assert.ok(small.bytes.length >= ASYNC_ENCODE_BYTES && small.bytes.length < POOL_CAP_BYTES, `a heat-sized body (${small.bytes.length} B)`);
  const done = [];
  const jobs = bigs.map((p, i) => p.encodedAsync("br").then(() => done.push(`big${i}`)));
  assert.equal(compressionStats.active, POOL_COMPRESSIONS); assert.equal(compressionStats.waiting, 1, "two big ones run, the third waits");
  const out = await small.encodedAsync("br").then((b) => { done.push("small"); return b; });
  assert.equal(done[0], "small", `the small body went first (${done.join(", ")})`);
  assert.ok(out.equals(brotliCompressSync(small.bytes, { params: { [Z.BROTLI_PARAM_QUALITY]: 4 } })));
  await Promise.all(jobs);
  assert.equal(compressionStats.maxActive <= POOL_COMPRESSIONS, true);
});

test("a since= scan of an old cursor yields every few dozen nodes it draws, so a turn stays near SLICE_MS", async () => {
  const clock = { t: 1_800_000_000_000 };
  const { db, model } = buildModel({ clock, roots: 60, kids: 20, assetKids: 100 });
  model.mapRef = function (...a) { const t = performance.now(); while (performance.now() - t < 0.1); return Model.prototype.mapRef.apply(this, a); }; // 0.1 ms a node
  slicedStats.maxTurnMs = 0;
  const delta = await model.mapSinceAsync({ all: true, since: 0 });
  delete model.mapRef;
  assert.ok(delta.body.nodes.length > 1000, `${delta.body.nodes.length} nodes drawn`);
  assert.ok(slicedStats.maxTurnMs < SLICE_MS + 25, `longest turn ${slicedStats.maxTurnMs.toFixed(1)} ms (1,024 drawn coins a step: ~100 ms)`);
  db.close();
});
