// GET /api/logo-sheet?w=64&m=<mint>,...: one webp (or png) of up to 256 mints' 64 px logo thumbnails, 16
// per row, with present / dead bitmaps in the headers and a 400 ms budget (what did not land in time is
// pending and keeps rendering for the next ask). Also the thumbnail-first serving and the split budgets
// the sheet relies on. Temp cache dirs, stub fetch, the worker thread and the inline mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { ImageCache, HostPacer, ImgWork, renderThumb, hexBits, SHEET_BUDGET_MS, SHEET_WAIT_MS } from "../lib/meta.mjs";
import { decodePng } from "../lib/png.mjs";
import { decodeWebp } from "../lib/webp.mjs";
import { sniffImage } from "../lib/validate.mjs";
import { renderLogo, pngSize } from "../lib/agents/logo.mjs";
import { isMint } from "../lib/api.mjs";
import { PublicKey } from "../lib/sdk.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const mint = (i) => { const b = Buffer.alloc(32, 9); b.writeUInt16BE(i, 30); return new PublicKey(b).toBase58(); };
const url = (name) => `https://ipfs.io/ipfs/Qm/${name}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let LOGO;
const logo = async () => (LOGO ??= await renderLogo({ symbol: "S", palette: ["#ff3366", "#113322", "#ffffff"], seed: "sheet" }));

function makeCache({ fetchImpl, inline = false, ...opts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spore-sheet-"));
  const work = new ImgWork({ inline, log: quiet });
  const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl: fetchImpl ?? (async () => new Response(await logo(), { headers: { "content-type": "image/png" } })), sleep: async () => {} }), concurrency: 8, log: quiet, work, ...opts });
  return { dir, cache, done: () => { work.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function serve(cache, imageOf) {
  const app = express();
  app.get("/api/img", cache.handler());
  app.get("/api/logo-sheet", cache.sheetHandler({ imageOf, isMint }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const sheet = async (q) => {
    const r = await fetch(`${base}/api/logo-sheet?${q}`);
    const body = Buffer.from(await r.arrayBuffer());
    const h = (k) => r.headers.get(k);
    return { status: r.status, body, type: h("content-type"), bits: h("x-sheet"), dead: h("x-sheet-dead"), n: h("x-sheet-n"), cols: h("x-sheet-cols"), cell: h("x-sheet-cell"), pending: h("x-sheet-pending"), cc: h("cache-control"), expose: h("access-control-expose-headers"), len: h("content-length"), json: r.headers.get("content-type")?.includes("json") ? JSON.parse(body.toString()) : null };
  };
  return { base, sheet, close: () => new Promise((r) => srv.close(r)) };
}
/** The RGBA of cell i of a decoded (png) sheet, 64 x 64. */
function cellOf(d, i, cols = 16, cell = 64) {
  const x0 = (i % cols) * cell, y0 = Math.floor(i / cols) * cell, out = Buffer.alloc(cell * cell * 4);
  for (let y = 0; y < cell; y++) d.rgba.copy(out, y * cell * 4, ((y0 + y) * d.w + x0) * 4, ((y0 + y) * d.w + x0 + cell) * 4);
  return out;
}

test("hexBits: byte j bit b (1 << b) = cell 8j+b, ceil(n/8) bytes", () => {
  assert.equal(hexBits([1, 0, 0]), "01"); assert.equal(hexBits([0, 1, 0]), "02"); assert.equal(hexBits([1, 0, 1]), "05");
  const bits = new Uint8Array(17); bits[0] = 1; bits[7] = 1; bits[8] = 1; bits[16] = 1;
  assert.equal(hexBits(bits), "810101");
  assert.equal(hexBits(new Uint8Array(0)), "");
});

test("3 mints present / dead / pending: webp 1024 x 64, bitmaps, pending count, no-store; f=png cells pixel-exact; the pending cell lands for the next ask", async () => {
  const A = mint(1), B = mint(2), C = mint(3);
  const fetchImpl = async (u) => { if (u.endsWith("c.png")) await sleep(900); return new Response(await logo(), { headers: { "content-type": "image/png" } }); };
  const { cache, done } = makeCache({ fetchImpl });
  const imageOf = (m) => ({ [A]: url("a.png"), [C]: url("c.png") })[m] ?? null;
  const { sheet, close } = await serve(cache, imageOf);
  try {
    await cache.warm([url("a.png")]); // A is on disk; B has no image; C's download takes longer than the budget
    const t0 = Date.now();
    const r = await sheet(`w=64&m=${A},${B},${C}`);
    const took = Date.now() - t0;
    assert.equal(r.status, 200); assert.equal(r.type, "image/webp"); assert.equal(sniffImage(r.body), "image/webp");
    assert.ok(took < SHEET_BUDGET_MS + 400, `answered within the budget (${took} ms)`);
    const im = await decodeWebp(r.body); assert.equal(im.width, 1024); assert.equal(im.height, 64);
    assert.equal(r.bits, "01"); assert.equal(r.dead, "02"); assert.equal(r.n, "3"); assert.equal(r.pending, "1");
    assert.equal(r.cols, "16"); assert.equal(r.cell, "64"); assert.equal(r.cc, "no-store");
    assert.equal(r.expose, "x-sheet, x-sheet-dead, x-sheet-n, x-sheet-pending"); assert.equal(Number(r.len), r.body.length);
    const p = await sheet(`w=64&m=${A},${B},${C}&f=png`);
    assert.equal(p.type, "image/png"); assert.deepEqual(pngSize(p.body), { width: 1024, height: 64 });
    const d = decodePng(p.body), thumb = decodePng(readFileSync(cache.thumbPath(url("a.png"), 64)));
    assert.equal(Buffer.compare(cellOf(d, 0), thumb.rgba), 0, "cell 0 is the thumbnail, byte for byte");
    assert.ok(cellOf(d, 1).every((v) => v === 0) && cellOf(d, 2).every((v) => v === 0), "dead and pending cells are fully transparent");
    await sleep(1200); // C's download and render finish meanwhile
    const again = await sheet(`w=64&m=${A},${B},${C}`);
    assert.equal(again.bits, "05"); assert.equal(again.dead, "02"); assert.equal(again.pending, "0"); assert.equal(again.cc, "private, max-age=600");
    assert.equal(cache.stats.sheets, 3); assert.equal(cache.stats.sheetCells, 9); assert.ok(cache.stats.sheetMs >= 0);
  } finally { await close(); done(); }
});

test("order is preserved and duplicates repeat the cell; a url the proxy will not fetch is dead", async () => {
  const A = mint(4), B = mint(5), X = mint(6);
  const { cache, done } = makeCache();
  const imageOf = (m) => ({ [A]: url("a.png"), [B]: url("b.png"), [X]: "http://ipfs.io/ipfs/plain" })[m] ?? null;
  const { sheet, close } = await serve(cache, imageOf);
  try {
    await cache.warm([url("a.png"), url("b.png")]);
    const r = await sheet(`w=64&m=${A},${B},${A},${X}&f=png`);
    assert.equal(r.status, 200); assert.equal(r.bits, "07"); assert.equal(r.dead, "08"); assert.equal(r.pending, "0");
    const d = decodePng(r.body);
    assert.equal(Buffer.compare(cellOf(d, 0), cellOf(d, 2)), 0, "cells 0 and 2 are the same mint");
    assert.ok(cellOf(d, 0).some((v, i) => i % 4 === 3 && v > 0), "and not empty");
    assert.ok(cellOf(d, 3).every((v) => v === 0));
  } finally { await close(); done(); }
});

test("fast path: a thumbnail on disk without its original is served, nothing is fetched", async () => {
  let fetches = 0;
  const { cache, done } = makeCache({ fetchImpl: async () => { fetches++; return new Response(await logo(), { headers: { "content-type": "image/png" } }); } });
  const A = mint(7), u = url("warm.png");
  writeFileSync(cache.thumbPath(u, 64), await renderThumb(await logo(), "image/png", 64));
  const { sheet, base, close } = await serve(cache, (m) => (m === A ? u : null));
  try {
    const r = await sheet(`w=64&m=${A}`);
    assert.equal(r.status, 200); assert.equal(r.bits, "01"); assert.equal(r.pending, "0"); assert.equal(r.cc, "private, max-age=600");
    assert.equal(fetches, 0, "no download for a warm thumbnail");
    // and GET /api/img?w=64 serves the same file the same way
    const img = await fetch(`${base}/api/img?u=${encodeURIComponent(u)}&w=64`);
    assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/png"); assert.equal(img.headers.get("x-img-thumb"), "64");
    assert.deepEqual(pngSize(Buffer.from(await img.arrayBuffer())), { width: 64, height: 64 });
    assert.equal(fetches, 0);
    assert.equal(cache.thumbOnDisk(u, 64)?.file, cache.thumbPath(u, 64)); assert.equal(cache.thumbOnDisk(url("nope.png"), 64), null); assert.equal(cache.thumbOnDisk(u, 100), null);
  } finally { await close(); done(); }
});

test("budget: a sheet with NOTHING landed at the budget waits up to SHEET_WAIT_MS; a slower download leaves the cell pending; the job keeps running and the next ask finds it", async () => {
  const { cache, done } = makeCache({ fetchImpl: async () => { await sleep(2600); return new Response(await logo(), { headers: { "content-type": "image/png" } }); } });
  const A = mint(8);
  const { sheet, close } = await serve(cache, () => url("slow.png"));
  try {
    const t0 = Date.now();
    const r = await sheet(`w=64&m=${A}`);
    const took = Date.now() - t0;
    assert.equal(r.status, 200); assert.equal(r.bits, "00"); assert.equal(r.dead, "00"); assert.equal(r.pending, "1"); assert.equal(r.cc, "no-store");
    assert.ok(took >= SHEET_WAIT_MS - 50 && took < SHEET_WAIT_MS + 600, `answered at the long wait (nothing landed at the budget), not after the download (${took} ms)`);
    assert.ok(cache.isDead(url("slow.png"), 64) === false);
    await sleep(1900);
    const again = await sheet(`w=64&m=${A}`);
    assert.equal(again.bits, "01"); assert.equal(again.pending, "0");
    assert.equal(cache.stats.sheetPending, 1);
  } finally { await close(); done(); }
});

test("budget: a cold sheet whose downloads land within SHEET_WAIT_MS answers with them (one round trip, no pending re-ask)", async () => {
  const { cache, done } = makeCache({ fetchImpl: async () => { await sleep(700); return new Response(await logo(), { headers: { "content-type": "image/png" } }); } });
  const A = mint(9), B = mint(10);
  const { sheet, close } = await serve(cache, (m) => url(`${m}.png`));
  try {
    const t0 = Date.now();
    const r = await sheet(`w=64&m=${A},${B}`);
    const took = Date.now() - t0;
    assert.equal(r.status, 200); assert.equal(r.bits, "03"); assert.equal(r.pending, "0"); assert.equal(r.cc, "private, max-age=600");
    assert.ok(took >= 650 && took < SHEET_WAIT_MS + 300, `answered once the downloads landed, past the 400 ms budget (${took} ms)`);
    // a sheet with one WARM cell answers at the budget as before, the slow one pending
    const C = mint(11), D = mint(12);
    const t1 = Date.now();
    const r2 = await sheet(`w=64&m=${A},${C}`);
    const took2 = Date.now() - t1;
    assert.equal(r2.bits, "01"); assert.equal(r2.pending, "1");
    assert.ok(took2 >= SHEET_BUDGET_MS - 50 && took2 < 900, `one warm cell: answered at the budget (${took2} ms)`);
    void D;
  } finally { await close(); done(); }
});

test("sizes and refusals: 17 mints -> 1024 x 128, 256 ok, 257 / bad mint / w != 64 / bad f / no m -> 400", async () => {
  const { cache, done } = makeCache();
  const { sheet, close } = await serve(cache, () => null);
  try {
    const m17 = Array.from({ length: 17 }, (_, i) => mint(100 + i)).join(",");
    const r = await sheet(`w=64&m=${m17}&f=png`);
    assert.equal(r.status, 200); assert.deepEqual(pngSize(r.body), { width: 1024, height: 128 }); assert.equal(r.n, "17"); assert.equal(r.dead, "ffff01");
    const m256 = Array.from({ length: 256 }, (_, i) => mint(200 + i)).join(",");
    const ok = await sheet(`w=64&m=${m256}`);
    assert.equal(ok.status, 200); assert.equal(ok.n, "256"); const im = await decodeWebp(ok.body); assert.equal(im.height, 1024);
    const m257 = `${m256},${mint(999)}`;
    assert.equal((await sheet(`w=64&m=${m257}`)).status, 400);
    for (const q of [`w=64&m=${mint(1)},notamint`, `w=128&m=${mint(1)}`, `m=${mint(1)}`, `w=64&m=${mint(1)}&f=gif`, "w=64", "w=64&m=", `w=64&m=${mint(1)}&m=${mint(2)}`]) {
      const bad = await sheet(q);
      assert.equal(bad.status, 400, q); assert.ok(bad.json?.error, q); assert.equal(bad.cc, "no-store", q);
    }
  } finally { await close(); done(); }
});

test("unknown mint (no image url) is dead at once; the model's imageOfMint feeds the sheet", async () => {
  const { Db } = await import("../lib/db.mjs");
  const { Model } = await import("../lib/model.mjs");
  const { K, PLATFORM, T22, base } = await import("./helpers/tree.mjs");
  const m = new Model(new Db(":memory:"), { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load();
  m.upsertCoin({ mint: K.ROOT, curve: "C1", depth: 0, quoteMint: null, ...base });
  m.setMint({ mint: K.ROOT, decimals: 6, tokenProgram: T22, name: "r", symbol: "r", uri: url("r.json"), onchainAt: 1 });
  m.setMeta(url("r.json"), { image: url("r.png") });
  m.setAssetIcons({ [K.X]: "https://ipfs.io/ipfs/Qm/icon.png" });
  assert.equal(m.imageOfMint(K.ROOT), url("r.png"), "the metadata image");
  assert.equal(m.imageOfMint(K.X), "https://ipfs.io/ipfs/Qm/icon.png", "a listed asset's icon");
  assert.equal(m.imageOfMint(K.U), null, "unknown mint");
  const { cache, done } = makeCache();
  const { sheet, close } = await serve(cache, (x) => m.imageOfMint(x));
  try {
    await cache.warm([url("r.png")]);
    const r = await sheet(`w=64&m=${K.U},${K.ROOT}`);
    assert.equal(r.bits, "02"); assert.equal(r.dead, "01"); assert.equal(r.pending, "0");
    assert.equal(cache.stats.sheetDead, 1);
  } finally { await close(); done(); }
});

test("ImgWork: the worker thread and the inline mode produce identical sheets and thumbnails", async () => {
  const worker = new ImgWork({ log: quiet }), inline = new ImgWork({ inline: true, log: quiet });
  try {
    const png = await logo();
    const webp = readFileSync(new URL("./fixtures/logo.webp", import.meta.url));
    const [tw, ti] = await Promise.all([worker.thumb({ bytes: png, type: "image/png", w: 64 }), inline.thumb({ bytes: png, type: "image/png", w: 64 })]);
    assert.equal(Buffer.compare(tw, ti), 0, "png thumbnail");
    const [ww, wi] = await Promise.all([worker.thumb({ bytes: webp, type: "image/webp", w: 64 }), inline.thumb({ bytes: webp, type: "image/webp", w: 64 })]);
    assert.equal(Buffer.compare(ww, wi), 0, "webp thumbnail");
    for (const format of ["png", "webp"]) {
      const [a, b] = await Promise.all([worker.sheet({ cells: [tw, null, ww, tw], format }), inline.sheet({ cells: [ti, null, wi, ti], format })]);
      assert.equal(a.type, b.type); assert.equal(Buffer.compare(a.bytes, b.bytes), 0, format); assert.deepEqual(a.failed, []);
    }
    const bad = await worker.sheet({ cells: [Buffer.from("not a png"), tw], format: "png" });
    assert.deepEqual(bad.failed, [0], "an undecodable cell is reported, the sheet still comes");
    assert.equal(worker.stats.inline, 0); assert.equal(inline.stats.inline, 1); assert.ok(worker.stats.jobs >= 5);
    assert.equal(await worker.thumb({ bytes: Buffer.from("RIFF....WEBPVP8 ........................"), type: "image/webp", w: 64 }), null);
  } finally { worker.close(); inline.close(); }
  const late = await worker.thumb({ bytes: await logo(), type: "image/png", w: 64 });
  assert.deepEqual(pngSize(late), { width: 64, height: 64 }, "after close() jobs run inline");
});

test("eviction: a thumbnail survives the eviction of its original; the thumbnail budget evicts the oldest thumbnails first", async () => {
  const png = await logo();
  const thumb = await renderThumb(png, "image/png", 64);
  // thumbKeepMs 0: every thumbnail here is minutes old at most, and the default keeps whatever was made or served within a day
  const { cache, done } = makeCache({ maxBytes: 3 * png.length, thumbMaxBytes: Math.floor(2.5 * thumb.length), thumbKeepMs: 0 });
  try {
    const u0 = url("0.png"), hit = await cache.get(u0);
    const t0 = await cache.thumb(u0, hit, 64);
    assert.ok(t0 && existsSync(t0.file));
    assert.ok(cache.stats.bytes < 2 * png.length && cache.stats.thumbBytes >= thumb.length, "two budgets");
    for (let i = 1; i < 6; i++) { await sleep(5); await cache.get(url(`${i}.png`)); }
    assert.ok(!existsSync(hit.file), "oldest original evicted");
    assert.ok(existsSync(t0.file), "its thumbnail stays");
    assert.ok(cache.stats.bytes <= 3 * png.length);
    assert.ok(await cache.thumb(u0, null, 64), "and is still served without the original");
    const t1 = await cache.thumb(url("1.png"), await cache.get(url("1.png")), 64); await sleep(5);
    const t2 = await cache.thumb(url("2.png"), await cache.get(url("2.png")), 64); await sleep(5);
    const t3 = await cache.thumb(url("3.png"), await cache.get(url("3.png")), 64);
    assert.ok(!existsSync(t0.file) && !existsSync(t1.file), "the two oldest thumbnails went");
    assert.ok(existsSync(t2.file) && existsSync(t3.file), "the newest stay");
    assert.ok(cache.stats.thumbBytes <= 2.5 * thumb.length); assert.ok(cache.stats.thumbsEvicted >= 2);
    assert.equal(cache.sweep(), 0, "nothing is older than twice a TTL");
  } finally { done(); }
});

test("in the app: /api/logo-sheet counts against the img limiter, not the api one, and resolves mints through the model", async () => {
  const { createApp } = await import("../lib/api.mjs");
  const { EventHub } = await import("../lib/events.mjs");
  const { buildTree, K, PLATFORM } = await import("./helpers/tree.mjs");
  const { db, model } = buildTree();
  const hub = new EventHub({ heartbeatMs: 200 });
  const { cache, done } = makeCache();
  const indexer = { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  const app = createApp({ model, indexer, rpc: { proxy: async () => ({ status: 200, text: "{}" }) }, hub, images: cache, meta: null, platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, origins: [], log: quiet });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = Number((await fetch(`${base}/api/stats`)).headers.get("x-ratelimit-remaining"));
    let r, tries = 0;
    do { r = await fetch(`${base}/api/logo-sheet?w=64&m=${K.A},${K.B}`); await r.arrayBuffer(); if (r.headers.get("x-sheet") !== "01") await sleep(150); } while (r.headers.get("x-sheet") !== "01" && ++tries < 20);
    assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/webp");
    assert.equal(r.headers.get("x-sheet"), "01", "A has an image in the tree"); assert.equal(r.headers.get("x-sheet-dead"), "02", "B has none");
    assert.match(r.headers.get("x-ratelimit-policy"), /name=img/);
    const after = Number((await fetch(`${base}/api/stats`)).headers.get("x-ratelimit-remaining"));
    assert.equal(after, before - 1, "only the two /api/stats calls touched the api limiter");
    const bad = await fetch(`${base}/api/logo-sheet?w=64&m=nope`);
    assert.equal(bad.status, 400); assert.equal((await bad.json()).error, "invalid mint");
  } finally { hub.close(); await new Promise((r) => server.close(r)); db.close(); done(); }
});
