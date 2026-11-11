// GET /api/map/family/:mint (DESIGN-FAMILY-ALL §4): one family's coins, biggest first, in pages, from a
// snapshot pinned by `v`; and `indexed` (drawn + undrawn coins) on both /api/map?limit=all bodies.
// No network, no RPC: an in-memory model behind the express app, a fake clock for the caches.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, withIndexed, preparedWithIndexed } from "../lib/api.mjs";
import { prepareJson, prepareJsonText } from "../lib/http.mjs";
import { EventHub } from "../lib/events.mjs";
import { Db } from "../lib/db.mjs";
import { Model, MAP_CACHE_MS, FAMILY_SNAPSHOT_MS, FAMILY_PAGE, FAMILY_PAGE_MAX, FAMILY_PAGES, FAMILY_PAGE_BYTES, FAMILY_PAGE_COPIES, FAMILY_SNAP_BYTES, FAMILY_ROW_BYTES, FAMILY_ASSET_BYTES, FAMILY_COIN_BYTES } from "../lib/model.mjs";
import { Indexer } from "../lib/indexer.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";

const key = (seed) => new PublicKey(createHash("sha256").update(`map-family-${seed}`).digest()).toBase58();
const ASSET = key("asset");          // a listed quote asset (priced, no coin of its own)
const BIG = key("big");              // a second asset with 40 coins: a page over the 1 KB compression threshold
const ROOT = key("root");            // a SOL root with three children, one of them with a child
const LEAF = key("root-kid-2");      // a tracked coin without children
const DRAW = 3;                      // the map draws 3 of the asset's coins (the keep set may beat it)
const SPLIT = [5000, 2500, 1000, 1500];
const DAY = 86_400;

/** A model with: ASSET → 10 depth-0 coins (two carry a child, two tie on everything but the mint), ROOT → 3 kids (+1 grandchild). */
function buildFamilies({ clock, mode = "all", draw = DRAW } = {}) {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: SPLIT, mode, now: () => clock.t, log: quiet, assetFamilyDraw: draw });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  model.setQuoteUsd(ASSET, 1);
  model.setMint({ mint: ASSET, decimals: 6, tokenProgram: T22, name: "Asset", symbol: "ASSET", uri: null, onchainAt: 1 });
  const old = Math.floor(clock.t / 1000) - 10 * DAY;
  const coin = (i, extra = {}) => model.upsertCoin({ mint: key(`a${i}`), curve: key(`a-curve${i}`), depth: 0, quoteMint: ASSET, ...base, virtualQuoteReserves: String(3_000_000_000 + i * 10_000_000), realQuoteReserves: "0", createdAt: old + i, ...extra });
  const kids = [];
  for (let i = 0; i < 10; i++) kids.push(coin(i));
  // a8 and a9 tie on locked value and price: the mint decides.
  model.upsertCoin({ mint: kids[9].mint, virtualQuoteReserves: kids[8].virtualQuoteReserves });
  // a2 and a5 carry a child each (locked value in them), a7 migrated.
  model.upsertCoin({ mint: key("a2-kid"), curve: key("a2-kid-curve"), depth: 1, quoteMint: kids[2].mint, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "5000000000000", createdAt: old });
  model.upsertCoin({ mint: key("a5-kid"), curve: key("a5-kid-curve"), depth: 1, quoteMint: kids[5].mint, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "9000000000000", createdAt: old });
  model.upsertCoin({ mint: kids[7].mint, migrated: true, poolQuote: "4000000000", poolBase: "1000000000000000" });
  for (let i = 0; i < 10; i++) if (i !== 4) model.setMint({ mint: kids[i].mint, decimals: 6, tokenProgram: T22, name: `Coin ${i}`, symbol: `C${i}`, uri: null, onchainAt: 1 }); // a4 has no ticker
  model.upsertCoin({ mint: ROOT, curve: key("root-curve"), depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: old });
  for (let i = 0; i < 3; i++) model.upsertCoin({ mint: key(`root-kid-${i}`), curve: key(`root-kid-curve-${i}`), depth: 1, quoteMint: ROOT, ...base, virtualQuoteReserves: String((3 - i) * 100_000_000_000_000), realQuoteReserves: "1000000000000", createdAt: old + i });
  model.upsertCoin({ mint: key("root-grandkid"), curve: key("root-grandkid-curve"), depth: 2, quoteMint: key("root-kid-0"), ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "1000000000000", createdAt: old });
  model.setQuoteUsd(BIG, 2);
  for (let i = 0; i < 40; i++) model.upsertCoin({ mint: key(`b${i}`), curve: key(`b-curve${i}`), depth: 0, quoteMint: BIG, ...base, virtualQuoteReserves: String(2_000_000_000 + i * 1_000_000), realQuoteReserves: "0", createdAt: old });
  return { db, model, kids };
}

async function serve(model, { rates = null } = {}) {
  const hub = new EventHub({ heartbeatMs: 60_000 });
  const rpc = { getMultipleAccounts: async (keys) => keys.map(() => null), snapshot: () => ({}), lane: () => rpc };
  const indexer = new Indexer({ rpc, model, meta: null, hub, log: quiet, opts: { backfill: false } });
  const dir = mkdtempSync(join(tmpdir(), "spore-family-"));
  const images = new ImageCache(dir, { fetchImpl: async () => new Response("", { status: 404 }) });
  const app = createApp({ model, indexer, rpc, hub, images, meta: null, platformWallet: PLATFORM, splitBps: SPLIT, distDir: null, log: quiet, rates });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, headers = {}) => {
    const r = await fetch(url + p, { headers });
    return { status: r.status, headers: r.headers, body: r.headers.get("content-type")?.includes("json") ? await r.json() : null };
  };
  return { url, get, close: () => { hub.close(); server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const clock = { t: 1_800_000_000_000 };
let fx, srv;
before(async () => { fx = buildFamilies({ clock }); clock.t += 1_000; srv = await serve(fx.model); });
after(() => { srv?.close(); fx?.db.close(); });
const later = (ms = MAP_CACHE_MS + 1) => { clock.t += ms; };
/** Is the snapshot `${mint}:${v}` held in either pool? */
const isHeld = (model, mint, v) => Object.values(model.familyPools).some((p) => p.snaps.has(`${mint}:${v}`));
/**
 * The client's count of a map body (web nodes.ts normalise + upsert, family.ts familyTotal): one node per mint,
 * a later copy merged over an earlier one keeping a known parentMint, `asset` only ever set; then the drawn
 * nodes + each asset top's ghosts (children − drawn kids), a top being an asset node whose parent is not held.
 */
function clientIndexed(body) {
  const set = new Map();
  const put = (n) => { const cur = set.get(n.mint); set.set(n.mint, cur ? { ...cur, ...n, parentMint: n.parentMint ?? cur.parentMint } : n); };
  const node = (c, parentMint) => ({ mint: c.mint, children: c.children ?? 0, parentMint, ...(c.asset === true ? { asset: true } : {}) });
  const walk = (n, parentMint) => { put(node(n.coin, parentMint)); for (const k of n.children ?? []) walk(k, n.coin.mint); };
  for (const r of body.roots ?? []) walk(r, null);
  for (const c of body.nodes ?? []) put(node(c, c.parentMint ?? null));
  const kids = new Map();
  for (const n of set.values()) if (n.parentMint) kids.set(n.parentMint, (kids.get(n.parentMint) ?? 0) + 1);
  let t = set.size;
  for (const n of set.values()) if (n.asset && (!n.parentMint || !set.has(n.parentMint))) t += Math.max(0, n.children - (kids.get(n.mint) ?? 0));
  return t;
}
const fam = (mint, q = "") => srv.get(`/api/map/family/${mint}${q}`);

test("shape and types: {mint, v, total, offset, next, nodes}, positional rows equal to mapRef rounded to 4 significant digits", async () => {
  const { status, headers, body } = await fam(ASSET);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ["mint", "v", "total", "offset", "next", "nodes"]);
  assert.equal(body.mint, ASSET); assert.equal(typeof body.v, "number"); assert.ok(Number.isInteger(body.v));
  assert.equal(body.total, 10, "every coin quoted in the asset, drawn or not"); assert.equal(body.offset, 0); assert.equal(body.next, null);
  assert.equal(body.nodes.length, 10);
  const p4 = (x) => (x == null ? null : Number(x.toPrecision(4)));
  for (const row of body.nodes) {
    assert.equal(row.length, 7);
    const [mint, symbol, mcapUsd, lockedUsd, createdAt, migrated, children] = row;
    assert.equal(typeof mint, "string");
    assert.ok(symbol === null || typeof symbol === "string");
    for (const x of [mcapUsd, lockedUsd, createdAt]) assert.ok(x === null || (typeof x === "number" && Number.isFinite(x)));
    assert.ok(migrated === 0 || migrated === 1);
    assert.ok(Number.isInteger(children) && children >= 0);
    const ref = fx.model.mapRef(fx.model.get(mint), true);
    assert.deepEqual(row, [ref.mint, ref.symbol ?? null, p4(ref.mcapUsd), p4(ref.lockedUsd), ref.createdAt ?? null, ref.migrated ? 1 : 0, ref.children]);
  }
  const byMint = new Map(body.nodes.map((r) => [r[0], r]));
  assert.equal(byMint.get(fx.kids[4].mint)[1], null, "no ticker → null");
  assert.equal(byMint.get(fx.kids[7].mint)[5], 1, "migrated → 1");
  assert.equal(byMint.get(fx.kids[2].mint)[6], 1, "children = tracked direct children");
  assert.ok(byMint.get(fx.kids[5].mint)[3] > 0, "locked value of a coin with a child");
  assert.match(headers.get("cache-control"), /public, max-age=10/);
  assert.match(headers.get("x-family-build-ms"), /^\d+$/);
  assert.ok(headers.get("etag"));
  assert.ok(headers.get("x-ratelimit-limit"), "the shared /api rate limiter counts it");
});

test("sort: locked value desc, then price desc, then mint asc (raw keys, the ones mapAll and assetDrawn use)", async () => {
  const { body } = await fam(ASSET);
  const d = fx.model.computed();
  const k = (x) => (x == null || !Number.isFinite(x) ? -1 : x);
  const mints = body.nodes.map((r) => r[0]);
  const expect = fx.model.assetFamilies().get(ASSET).map((c) => c.mint)
    .sort((a, b) => k(d.get(b).lockedUsd) - k(d.get(a).lockedUsd) || k(d.get(b).priceUsd) - k(d.get(a).priceUsd) || (a < b ? -1 : 1));
  assert.deepEqual(mints, expect);
  assert.deepEqual(mints.slice(0, 2), [fx.kids[5].mint, fx.kids[2].mint], "the two coins with locked value first, bigger first");
  const i8 = mints.indexOf(fx.kids[8].mint), i9 = mints.indexOf(fx.kids[9].mint);
  assert.equal(Math.abs(i8 - i9), 1, "the tie sits together");
  assert.ok((fx.kids[8].mint < fx.kids[9].mint) === (i8 < i9), "a full tie is ordered by mint");
  for (let i = 1; i < body.nodes.length; i++) assert.ok(k(body.nodes[i - 1][3]) >= k(body.nodes[i][3]), "rounded locked values never increase");
});

test("paging: limit 4 over 10 coins returns every mint once under one v; next is null at the end", async () => {
  later();
  const pages = [];
  let offset = 0, v = null;
  for (let guard = 0; offset != null && guard < 10; guard++) {
    const { body } = await fam(ASSET, `?offset=${offset}&limit=4${v != null ? `&v=${v}` : ""}`);
    pages.push(body); v ??= body.v; offset = body.next;
  }
  assert.deepEqual(pages.map((p) => [p.offset, p.next, p.nodes.length]), [[0, 4, 4], [4, 8, 4], [8, null, 2]]);
  assert.ok(pages.every((p) => p.v === v && p.total === 10));
  const mints = pages.flatMap((p) => p.nodes.map((r) => r[0]));
  assert.equal(new Set(mints).size, 10);
  assert.deepEqual(mints, (await fam(ASSET, `?v=${v}`)).body.nodes.map((r) => r[0]), "the pages concatenate to the whole list");
});

test("v: pinned across a rebuild while held; an unknown v gets the current snapshot; no rebuild without a version move or inside MAP_CACHE_MS", async () => {
  later();
  const old = (await fam(ASSET)).body.v;
  later();
  assert.equal((await fam(ASSET)).body.v, old, "no version move: same snapshot after the window");
  fx.model.setMint({ mint: ASSET, name: "Asset (renamed)" }); // the version moves; no row changes
  later();
  const v0 = (await fam(ASSET, "?limit=4")).body.v;
  assert.ok(v0 > old, "version moved and the window passed: rebuilt");
  // a6 takes a child: its row and the order move; the version moves.
  fx.model.upsertCoin({ mint: key("a6-kid"), curve: key("a6-kid-curve"), depth: 1, quoteMint: fx.kids[6].mint, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "20000000000000", createdAt: 1 });
  assert.equal((await fam(ASSET)).body.v, v0, "version moved but inside MAP_CACHE_MS: same snapshot");
  later();
  const pinned = (await fam(ASSET, `?offset=4&limit=4&v=${v0}`)).body;
  assert.equal(pinned.v, v0, "a held v is served after the rebuild window");
  assert.deepEqual(pinned.nodes, (await fam(ASSET, `?v=${v0}`)).body.nodes.slice(4, 8));
  const cur = (await fam(ASSET)).body;
  assert.ok(cur.v > v0, "without v: the rebuilt snapshot");
  assert.equal(cur.nodes[0][0], fx.kids[6].mint, "the rebuilt list has a6 first");
  assert.equal(cur.nodes.find((r) => r[0] === fx.kids[6].mint)[6], 1);
  assert.equal((await fam(ASSET, `?v=${v0}`)).body.nodes[0][0], fx.kids[5].mint, "the pinned snapshot still has the old order");
  assert.equal((await fam(ASSET, "?v=12345")).body.v, cur.v, "unknown v → current");
  assert.equal((await fam(ASSET, "?v=abc")).body.v, cur.v, "malformed v → current");
  // Held for FAMILY_SNAPSHOT_MS after its last read, then dropped: the client sees the new v and restarts.
  later(FAMILY_SNAPSHOT_MS - 1_000);
  assert.equal((await fam(ASSET, `?v=${v0}`)).body.v, v0, "read again just inside the hold");
  later(FAMILY_SNAPSHOT_MS);
  const after = (await fam(ASSET, `?v=${v0}`)).body;
  assert.notEqual(after.v, v0, "dropped after the hold");
  assert.ok(after.v > cur.v, "v grows per family");
});

test("SOL root → its tracked direct children; a leaf → total 0; unknown → 404; bad mint → 400", async () => {
  const root = (await fam(ROOT)).body;
  assert.equal(root.total, 3);
  assert.deepEqual(root.nodes.map((r) => r[0]), [0, 1, 2].map((i) => key(`root-kid-${i}`)), "the one with locked value (its child), then by price");
  assert.equal(root.nodes[0][6], 1, "the grandchild is counted, not listed");
  const leaf = await fam(LEAF);
  assert.equal(leaf.status, 200);
  assert.deepEqual([leaf.body.total, leaf.body.nodes, leaf.body.next, leaf.body.offset], [0, [], null, 0]);
  const unknown = await fam(key("nobody"));
  assert.equal(unknown.status, 404); assert.deepEqual(unknown.body, { error: "unknown family" });
  assert.equal((await fam("not-a-mint")).status, 400);
  assert.equal((await fam("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl")).status, 400, "not base58");
  // An untracked coin is not a family.
  fx.model.upsertCoin({ mint: key("ghost"), curve: key("ghost-curve"), depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "1", tracked: false });
  later();
  assert.equal((await fam(key("ghost"))).status, 404);
});

test("clamps: limit 1..10,000 (default 5,000), negative offset → 0, offset ≥ total → [] and next null", async () => {
  later();
  const one = (await fam(ASSET, "?limit=0")).body;
  assert.equal(one.nodes.length, 1); assert.equal(one.next, 1);
  assert.equal((await fam(ASSET, "?limit=-3")).body.nodes.length, 1);
  assert.equal((await fam(ASSET, "?limit=abc")).body.nodes.length, 10, "default page covers a small family");
  assert.equal((await fam(ASSET, "?limit=99999")).body.nodes.length, 10);
  const neg = (await fam(ASSET, "?offset=-5&limit=2")).body;
  assert.deepEqual([neg.offset, neg.next, neg.nodes.length], [0, 2, 2]);
  for (const o of [10, 11, 1_000_000]) {
    const b = (await fam(ASSET, `?offset=${o}`)).body;
    assert.deepEqual([b.offset, b.nodes, b.next, b.total], [o, [], null, 10]);
  }
  assert.equal(FAMILY_PAGE, 5_000); assert.equal(FAMILY_PAGE_MAX, 10_000);
});

test("gzip, ETag and 304; each (offset, limit) page is encoded once per snapshot and at most FAMILY_PAGES are kept", async () => {
  later();
  const plain = await fam(BIG);
  assert.equal(plain.body.total, 40);
  const etag = plain.headers.get("etag");
  const r304 = await fetch(`${srv.url}/api/map/family/${BIG}`, { headers: { "if-none-match": etag } });
  assert.equal(r304.status, 304);
  const gz = await fetch(`${srv.url}/api/map/family/${BIG}`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(gz.headers.get("content-encoding"), "gzip");
  assert.equal(gz.headers.get("etag"), etag);
  assert.deepEqual(await gz.json(), plain.body, "fetch decodes the pre-compressed body");
  const br = await fetch(`${srv.url}/api/map/family/${BIG}`, { headers: { "accept-encoding": "br" } });
  assert.equal(br.headers.get("content-encoding"), "br");
  const snap = fx.model.familyEntry(BIG, plain.body.v);
  const page = snap.pages.get(`0:${FAMILY_PAGE}`);
  assert.ok(page.gz && gunzipSync(page.gz).equals(page.bytes), "the gzip bytes are kept with the page");
  assert.equal(page.text, null, "the JSON text is dropped once encoded");
  assert.equal((await fam(BIG)).headers.get("etag"), etag, "same snapshot, same bytes");
  for (let o = 0; o < FAMILY_PAGES + 6; o++) await fam(BIG, `?offset=${o}&limit=1&v=${plain.body.v}`);
  assert.ok(snap.pages.size <= FAMILY_PAGES, `pages kept: ${snap.pages.size}`);
});

test("indexed: total + the asset coins the map leaves undrawn, on the full and the since= body; nothing else changes (≤ 32 B growth)", async () => {
  later();
  const full = await srv.get("/api/map?scope=all&limit=all");
  const body = full.body;
  let walked = 0; const walk = (n) => { walked++; n.children.forEach(walk); }; body.roots.forEach(walk);
  assert.equal(body.total, walked);
  const top = body.roots.find((r) => r.coin.mint === ASSET);
  assert.ok(top.coin.children === 10 && top.children.length < 10, "a capped family");
  let undrawn = 0;
  for (const r of body.roots) if (r.coin.asset) undrawn += r.coin.children - r.children.length; // the client's ghost rule
  assert.ok(undrawn >= 7 + 37);
  assert.equal(body.indexed, body.total + undrawn);
  assert.equal(body.indexed, clientIndexed(body), "the client's familyTotal");
  assert.equal(body.indexed, walked + (10 - fx.model.assetDrawn().get(ASSET).size) + (40 - fx.model.assetDrawn().get(BIG).size));
  // Same body as the model's apart from `indexed` (appended last), and the growth is that one field.
  const entry = fx.model.mapAll({ all: true });
  const { indexed, ...rest } = body;
  assert.deepEqual(rest, JSON.parse(JSON.stringify(entry.body)));
  assert.deepEqual(Object.keys(body).at(-1), "indexed");
  // The /api bytes are encoded straight from the body, in slices (mapApiPrepared): the same bytes and ETag as
  // splicing `indexed` into prepareJson(body), which the route did before (and no shared `prepared` slot is filled).
  const spliceOld = preparedWithIndexed(prepareJson(entry.body), entry.indexed);
  assert.ok(entry.apiPrepared.bytes.equals(spliceOld.bytes)); assert.equal(entry.apiPrepared.etag, spliceOld.etag);
  const growth = Buffer.byteLength(entry.apiPrepared.text) - Buffer.byteLength(prepareJson(entry.body).text);
  assert.equal(growth, `,"indexed":${indexed}`.length); assert.ok(growth <= 32, `growth ${growth} B`);
  assert.equal(withIndexed('{"a":1}', 7), JSON.stringify({ a: 1, indexed: 7 }));
  // The spliced bytes are exactly what encoding the text again would give: text, bytes, ETag, gzip.
  const sample = { roots: [{ coin: { name: "Ünïcode — 🍄", symbol: "SP…RE" } }], total: 3 };
  const spliced = preparedWithIndexed(prepareJson(sample), 81_999), again = prepareJsonText(JSON.stringify({ ...sample, indexed: 81_999 }));
  assert.equal(spliced.text, again.text); assert.ok(spliced.bytes.equals(again.bytes)); assert.equal(spliced.etag, again.etag);
  assert.equal(gunzipSync(spliced.encoded("gzip")).toString(), again.text); assert.equal(spliced.encoded("identity"), spliced.bytes);
  // since=: the same count, built at the same version.
  const delta = (await srv.get(`/api/map?scope=all&limit=all&since=${body.generatedAt}`)).body;
  assert.equal(delta.total, body.total); assert.equal(delta.indexed, body.indexed);
  assert.deepEqual(Object.keys(delta).sort(), ["generatedAt", "indexed", "nodes", "removed", "total", "version"]);
  const since0 = (await srv.get("/api/map?scope=all&limit=all&since=0")).body;
  assert.equal(since0.indexed, body.indexed);
  assert.ok(since0.nodes.some((n) => n.parentMint === ASSET));
  // A new undrawn coin moves it on the next build of both bodies.
  fx.model.upsertCoin({ mint: key("a-new"), curve: key("a-new-curve"), depth: 0, quoteMint: ASSET, ...base, virtualQuoteReserves: "1000000000", realQuoteReserves: "0", createdAt: Math.floor(clock.t / 1000) - 10 * DAY });
  later();
  const full2 = (await srv.get("/api/map?scope=all&limit=all")).body;
  assert.equal(full2.indexed, body.indexed + 1); assert.equal(full2.total, body.total, "drawn slice unchanged (cap)");
  assert.equal((await srv.get(`/api/map?scope=all&limit=all&since=${body.generatedAt}`)).body.indexed, full2.indexed);
  // /v1 keeps its body (no `indexed`).
  const v1 = await srv.get("/v1/map");
  assert.equal("indexed" in v1.body, false);
});

test("always the all-scope view: an ours-mode server lists every coin of the family", async () => {
  const c2 = { t: 1_800_000_000_000 };
  const f = buildFamilies({ clock: c2, mode: "ours" });
  c2.t += 1_000;
  const s = await serve(f.model);
  try {
    assert.equal(f.model.scope().ours.size, 0, "nothing is ours");
    const b = (await s.get(`/api/map/family/${ASSET}`)).body;
    assert.equal(b.total, 10);
    assert.equal((await s.get(`/api/map/family/${ROOT}`)).body.total, 3);
    // The listing-scope map draws no asset family: indexed = total.
    const scoped = (await s.get("/api/map?limit=all")).body;
    assert.equal(scoped.scope, "ours"); assert.equal(scoped.indexed, scoped.total);
  } finally { s.close(); f.db.close(); }
});

test("the shared /api rate limiter applies", async () => {
  const c3 = { t: 1_800_000_000_000 };
  const f = buildFamilies({ clock: c3 });
  const s = await serve(f.model, { rates: { api: { limit: 3, windowMs: 60_000 } } });
  try {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await s.get(`/api/map/family/${ASSET}`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429]);
  } finally { s.close(); f.db.close(); }
});

// Regression: a client pages an asset family under one v while other requests ask for
// many small families and leaves; the page after them still comes from the same snapshot, with no rebuild.
test("pools: requests for small families and leaves never push out an asset family a client is paging", async () => {
  const c = { t: 1_800_000_000_000 };
  const f = buildFamilies({ clock: c });
  const old = Math.floor(c.t / 1000) - 10 * DAY, small = [];
  for (let i = 0; i < 40; i++) {
    const r = key(`sol-${i}`), kid = key(`sol-${i}-kid`);
    f.model.upsertCoin({ mint: r, curve: key(`sol-curve-${i}`), depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: old });
    f.model.upsertCoin({ mint: kid, curve: key(`sol-kid-curve-${i}`), depth: 1, quoteMint: r, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "1000000000", createdAt: old });
    small.push(r, kid); // a one-child family, and a leaf
  }
  c.t += 1_000;
  const s = await serve(f.model);
  try {
    assert.equal(FAMILY_ASSET_BYTES, 128 * 2 ** 20); assert.equal(FAMILY_COIN_BYTES, 16 * 2 ** 20);
    const p0 = (await s.get(`/api/map/family/${ASSET}?offset=0&limit=4`)).body;
    const builds = f.model.familyStats.builds;
    f.model.familyPools.coin.budget = 8 * 1024; // a tiny pool for the small families: they push out one another
    for (const m of small) assert.equal((await s.get(`/api/map/family/${m}?limit=1`)).status, 200);
    assert.equal(f.model.familyStats.builds - builds, 40, "one build per small family; leaves are not held");
    assert.ok(f.model.familyStats.evicted >= 30, `the coin pool evicted within itself (${f.model.familyStats.evicted})`);
    assert.ok(f.model.familyPools.coin.bytes <= 8 * 1024);
    for (const p of Object.values(f.model.familyPools)) for (const snap of p.snaps.values()) assert.ok(snap.rows.length > 0, "no leaf is held");
    const leaf = await s.get(`/api/map/family/${small[1]}`);
    assert.deepEqual([leaf.body.total, leaf.body.nodes, leaf.body.next], [0, [], null]);
    // The version moves and the rebuild window passes: only a request without v would rebuild.
    f.model.upsertCoin({ mint: f.kids[0].mint, virtualQuoteReserves: "3500000000" });
    c.t += MAP_CACHE_MS + 1;
    const p1 = (await s.get(`/api/map/family/${ASSET}?offset=4&limit=4&v=${p0.v}`)).body;
    assert.equal(p1.v, p0.v, "page 1 comes from the snapshot page 0 did");
    assert.equal(f.model.familyStats.builds - builds, 40, "no rebuild of the asset family");
    assert.deepEqual([...f.model.familyPools.asset.snaps.values()].map((x) => x.mint), [ASSET]);
  } finally { s.close(); f.db.close(); }
});

test("budgets: each pool drops its least recently read snapshots past its estimated bytes; the one served stays", () => {
  const c = { t: 1_800_000_000_000 };
  const f = buildFamilies({ clock: c });
  try {
    const { asset, coin } = f.model.familyPools;
    const a = f.model.familyEntry(ASSET); c.t += 1;
    assert.equal(a.bytes, FAMILY_SNAP_BYTES + 10 * FAMILY_ROW_BYTES); assert.equal(asset.bytes, a.bytes);
    f.model.familyPagePut(a, `0:${FAMILY_PAGE}`, { bytes: Buffer.alloc(1_000) });
    assert.equal(a.bytes, FAMILY_SNAP_BYTES + 10 * FAMILY_ROW_BYTES + 1_000 * FAMILY_PAGE_COPIES, "a kept page counts");
    assert.equal(asset.bytes, a.bytes);
    asset.budget = a.bytes + FAMILY_SNAP_BYTES + 40 * FAMILY_ROW_BYTES - 1; // one byte short of holding both
    const b = f.model.familyEntry(BIG); c.t += 1;
    assert.deepEqual([...asset.snaps.values()], [b], "ASSET (least recently read) went, BIG (being served) stayed");
    assert.equal(asset.bytes, b.bytes); assert.equal(f.model.familyStats.evicted, 1);
    assert.notEqual(f.model.familyEntry(ASSET, a.v), a, "a dropped v gets a fresh snapshot");
    // A snapshot over the whole budget is still served, and held alone.
    asset.budget = 1;
    f.model.setMint({ mint: ASSET, name: "Asset (renamed)" }); c.t += MAP_CACHE_MS + 1; // the next request rebuilds
    const a2 = f.model.familyEntry(ASSET);
    assert.deepEqual([...asset.snaps.values()], [a2]); assert.equal(f.model.familyEntry(ASSET, a2.v), a2);
    // The other pool is separate: a tracked coin's family never touches the asset pool.
    const r = f.model.familyEntry(ROOT);
    assert.deepEqual([...asset.snaps.values()], [a2]); assert.deepEqual([...coin.snaps.values()], [r]);
    const h = f.model.familyHeld();
    assert.deepEqual([h.held, h.bytes, h.asset.held, h.coin.held, h.coin.budget], [2, a2.bytes + r.bytes, 1, 1, FAMILY_COIN_BYTES]);
    // A leaf is built per request, never held.
    const leaf = f.model.familyEntry(LEAF);
    assert.equal(leaf.rows.length, 0); assert.equal(leaf.pool, null); assert.equal(f.model.familyHeld().held, 2);
  } finally { f.db.close(); }
});

test("pages: at most FAMILY_PAGES and FAMILY_PAGE_BYTES (estimated) per snapshot, oldest out first", () => {
  const c = { t: 1_800_000_000_000 };
  const f = buildFamilies({ clock: c });
  try {
    const s = f.model.familyEntry(BIG), pool = f.model.familyPools.asset;
    const page = (n) => ({ bytes: { length: n } });
    const half = FAMILY_PAGE_BYTES / FAMILY_PAGE_COPIES / 2;
    f.model.familyPagePut(s, "a", page(half)); f.model.familyPagePut(s, "b", page(half));
    assert.deepEqual([...s.pages.keys()], ["a", "b"], "exactly at the cap");
    f.model.familyPagePut(s, "c", page(10));
    assert.deepEqual([...s.pages.keys()], ["b", "c"]); assert.equal(s.pageBytes, (half + 10) * FAMILY_PAGE_COPIES);
    f.model.familyPagePut(s, "d", page(FAMILY_PAGE_BYTES));
    assert.deepEqual([...s.pages.keys()], ["d"], "a page over the cap alone is kept: it is the one being sent");
    f.model.familyPagePut(s, "d", page(5));
    assert.equal(s.pageBytes, 5 * FAMILY_PAGE_COPIES, "a replaced page is not counted twice");
    for (let i = 0; i < FAMILY_PAGES + 3; i++) f.model.familyPagePut(s, `n${i}`, page(1));
    assert.equal(s.pages.size, FAMILY_PAGES); assert.equal(s.pages.has("n0"), false); assert.equal(s.pages.has(`n${FAMILY_PAGES + 2}`), true);
    assert.equal(s.bytes, FAMILY_SNAP_BYTES + 40 * FAMILY_ROW_BYTES + s.pageBytes); assert.equal(pool.bytes, s.bytes);
  } finally { f.db.close(); }
});

// $baton: a listed asset quoted in another listed asset is drawn twice (a child of that asset and the top of
// its own family). `indexed` counts each coin once and leaves out the undrawn coins of a family whose top is
// drawn inside another one (no ghost on the client): the client's familyTotal, on the full and since= bodies.
test("indexed: an asset drawn inside another asset counts once, equal to the client's familyTotal", async () => {
  const c = { t: 1_800_000_000_000 };
  const f = buildFamilies({ clock: c });
  const NEST = key("nest"), old = Math.floor(c.t / 1000) - 10 * DAY;
  f.model.upsertCoin({ mint: NEST, curve: key("nest-curve"), depth: 0, quoteMint: ASSET, ...base, virtualQuoteReserves: "5000000000", realQuoteReserves: "0", createdAt: old });
  for (let i = 0; i < 6; i++) f.model.upsertCoin({ mint: key(`nest-${i}`), curve: key(`nest-curve-${i}`), depth: 0, quoteMint: NEST, ...base, virtualQuoteReserves: String(3_000_000_000 + i * 1_000_000), realQuoteReserves: "0", createdAt: old });
  c.t += 1_000;
  const s = await serve(f.model);
  try {
    const body = (await s.get("/api/map?scope=all&limit=all")).body;
    const where = new Map();
    const walk = (n, root) => { where.set(n.coin.mint, [...(where.get(n.coin.mint) ?? []), root]); n.children.forEach((k) => walk(k, root)); };
    for (const r of body.roots) walk(r, r.coin.mint);
    assert.deepEqual(where.get(NEST).sort(), [ASSET, NEST].sort(), "NEST is drawn under ASSET and as its own top");
    const dup = [...where.values()].reduce((a, v) => a + v.length - 1, 0);
    assert.equal(dup, 1 + DRAW, "NEST and its drawn coins twice");
    const drawn = f.model.assetDrawn(), fam = f.model.assetFamilies();
    const undrawn = (a) => fam.get(a).length - drawn.get(a).size;
    assert.equal(undrawn(NEST), 6 - DRAW);
    assert.equal(body.total, where.size + dup, "total still counts nodes (the body is unchanged)");
    assert.equal(body.indexed, where.size + undrawn(ASSET) + undrawn(BIG), "distinct coins + the undrawn of the families drawn as tops");
    assert.equal(body.indexed, clientIndexed(body));
    const since0 = (await s.get("/api/map?scope=all&limit=all&since=0")).body;
    assert.equal(since0.indexed, body.indexed); assert.equal(since0.total, body.total);
    // Built cold, the since= body (no full build in that version) gives the same number.
    f.model.upsertCoin({ mint: key("nest-new"), curve: key("nest-new-curve"), depth: 0, quoteMint: NEST, ...base, virtualQuoteReserves: "3000000000", realQuoteReserves: "0", createdAt: old });
    c.t += MAP_CACHE_MS + 1;
    const cold = (await s.get(`/api/map?scope=all&limit=all&since=${body.generatedAt}`)).body;
    const full = (await s.get("/api/map?scope=all&limit=all")).body;
    assert.equal(cold.indexed, full.indexed); assert.equal(full.indexed, clientIndexed(full));
    assert.equal(full.indexed, body.indexed, "a new undrawn coin of a nested family has no ghost on the client: not counted");
  } finally { s.close(); f.db.close(); }
});

test("a rebuild never reuses a held v, even when the clock steps back", () => {
  const c6 = { t: 1_800_000_000_000 };
  const f = buildFamilies({ clock: c6 });
  try {
    const v1 = f.model.familyEntry(ASSET).v;
    f.model.setMint({ mint: ASSET, name: "Asset 2" });
    c6.t += MAP_CACHE_MS + 1;
    const v2 = f.model.familyEntry(ASSET).v;
    assert.ok(v2 > v1);
    assert.equal(f.model.familyEntry(ASSET, v1).v, v1, "a client still paging v1");
    c6.t = v2 + FAMILY_SNAPSHOT_MS - 5_000;
    assert.equal(f.model.familyEntry(ASSET, v1).v, v1, "v1 is read (pinned), v2 is not");
    c6.t = v2 + FAMILY_SNAPSHOT_MS;
    f.model.familyEntry(ROOT);
    assert.equal(isHeld(f.model, ASSET, v2), false, "the current one expired");
    assert.equal(isHeld(f.model, ASSET, v1), true, "the pinned one is held");
    c6.t = v1; // the clock steps back to v1's build time
    const v3 = f.model.familyEntry(ASSET).v;
    assert.ok(v3 !== v1 && v3 !== v2, `a fresh v (${v3})`);
    assert.equal(f.model.familyEntry(ASSET, v1).v, v1, "the pinned snapshot is still the one it was");
    assert.equal(f.model.familyEntry(ASSET, v1).rows.length, 10);
  } finally { f.db.close(); }
});

// 20k coins quoted in one asset, shaped like the real index (DESIGN-FAMILY-ALL §1: mcap at the curve floor,
// ~99 % never locked anything, tickers of 3-10 characters, a few migrated or with children).
test("perf: 20k coins — first build ≤ 250 ms, a cached page ≤ 5 ms, a 5k page ≤ 420 KB raw / 210 KB gzip; limit caps at 10,000", async () => {
  const c5 = { t: 1_800_000_000_000 };
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: SPLIT, mode: "all", now: () => c5.t, log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100); model.setQuoteUsd(ASSET, 1);
  let seed = 7; const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const N = 20_000, now = Math.floor(c5.t / 1000);
  for (let i = 0; i < N; i++) {
    const mint = key(`perf-${i}`);
    model.upsertCoin({ mint, curve: key(`perf-curve-${i}`), depth: 0, quoteMint: ASSET, ...base, virtualQuoteReserves: String(Math.round((2_400 + rnd() * 1_800) * 1e6)), realQuoteReserves: "0", createdAt: now - Math.floor(rnd() * 200 * DAY), migrated: i % 997 === 0, poolQuote: i % 997 === 0 ? "90000000000" : null, poolBase: i % 997 === 0 ? "200000000000000" : null });
    let sym = ""; const len = 3 + Math.floor(rnd() * 8); for (let j = 0; j < len; j++) sym += ABC[Math.floor(rnd() * ABC.length)];
    if (i % 50 !== 0) model.mints.set(mint, { mint, decimals: 6, tokenProgram: T22, supply: null, name: sym, symbol: sym, uri: null, onchainAt: 1 });
  }
  for (let i = 0; i < 200; i++) model.upsertCoin({ mint: key(`perf-kid-${i}`), curve: key(`perf-kid-curve-${i}`), depth: 1, quoteMint: key(`perf-${i * 97}`), ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: String(1_000_000_000 * (i + 1)), createdAt: now });
  c5.t += 1_000;
  const s = await serve(model);
  try {
    model.computed(); model.assetFamilies(); // the shared per-version passes every reader pays once (mapAll does too)
    const t0 = performance.now();
    const snap = model.familyEntry(ASSET);
    const buildMs = performance.now() - t0;
    assert.equal(snap.rows.length, N);
    assert.ok(buildMs <= 250, `first build ${buildMs.toFixed(1)} ms`);
    const first = await fetch(`${s.url}/api/map/family/${ASSET}`);
    const text = await first.text();
    const raw = Buffer.byteLength(text), gz = gzipSync(text).length;
    const page = JSON.parse(text);
    assert.equal(page.nodes.length, FAMILY_PAGE); assert.equal(page.next, FAMILY_PAGE); assert.equal(page.v, snap.v);
    assert.ok(raw <= 420_000, `5k page ${raw} B raw`); assert.ok(gz <= 210_000, `5k page ${gz} B gzip`);
    const times = [];
    for (let i = 0; i < 9; i++) { const t = performance.now(); const r = await fetch(`${s.url}/api/map/family/${ASSET}?v=${snap.v}`, { headers: { "accept-encoding": "gzip" } }); await r.arrayBuffer(); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    const inProc = []; for (let i = 0; i < 9; i++) { const t = performance.now(); const e = model.familyEntry(ASSET, snap.v); e.pages.get(`0:${FAMILY_PAGE}`).encoded("gzip"); inProc.push(performance.now() - t); }
    inProc.sort((a, b) => a - b);
    assert.ok(inProc[4] <= 5, `cached lookup ${inProc[4].toFixed(3)} ms`);
    assert.ok(times[0] <= 5, `cached page round trip (best of 9, gzip, over HTTP) ${times[0].toFixed(2)} ms`); // best-of: the scheduler noise of a parallel test run is not the server's
    const big = (await s.get(`/api/map/family/${ASSET}?limit=20000&v=${snap.v}`)).body;
    assert.equal(big.nodes.length, FAMILY_PAGE_MAX); assert.equal(big.next, FAMILY_PAGE_MAX);
    const mints = new Set();
    for (let o = 0; o != null;) { const b = (await s.get(`/api/map/family/${ASSET}?offset=${o}&v=${snap.v}`)).body; assert.equal(b.v, snap.v); for (const r of b.nodes) mints.add(r[0]); o = b.next; }
    assert.equal(mints.size, N, "four pages cover the family, each mint once");
    process.stdout.write(`# perf 20k: build ${buildMs.toFixed(1)} ms (snap.buildMs ${snap.buildMs}), 5k page ${raw} B raw / ${gz} B gzip, cached round trip best ${times[0].toFixed(2)} / median ${times[4].toFixed(2)} ms, in-process ${inProc[4].toFixed(3)} ms\n`);
  } finally { s.close(); db.close(); }
});
