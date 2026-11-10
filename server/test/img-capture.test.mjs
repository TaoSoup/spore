// Logo capture (2026-11-10): a logo's 64 px thumbnail is made the first time its url is seen (Model.onImage ->
// ImageCache.enqueueThumb), kept for good (no age limit; only the disk budget evicts, least recently used first, never
// what was used within thumbKeepMs), and failures are classified (temporary: 429/5xx/timeouts, 503 + Retry-After and a
// pending sheet cell; permanent: 404 and kin, 404 and a dead cell; cannot be drawn) and kept in sqlite with their retry
// time. Background work (first sight, the warm pass) uses at most half the download slots; the warm pass resumes where
// it stopped, across a restart. Stub fetch, temp dirs, in-memory sqlite; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, utimesSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { ImageCache, HostPacer, ImgWork, IMG_TEMP_RETRY_MS, IMG_TEMP_RETRY_MAX_MS, IMG_GONE_RETRY_MS, IMG_NOTHUMB_RETRY_MS, IMG_RETRY_AFTER_MAX_S, THUMB_RULE, PRIO_WARM,
  IMG_TEMP_SHORT_TRIES, IMG_TEMP_LONG_MAX_MS, IMG_DNS_GONE_AFTER, IMG_DNS_RETRY_MS, imgTempWaitMs, THUMB_FRESH_IDLE_MS, THUMB_FULL_WARN_MS, THUMB_BG_FILL, THUMB_WARM_FILL } from "../lib/meta.mjs";
import { Db } from "../lib/db.mjs";
import { HostGuard } from "../lib/net.mjs";
import { renderLogo } from "../lib/agents/logo.mjs";
import { isMint } from "../lib/api.mjs";
import { PublicKey } from "../lib/sdk.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mint = (i) => { const b = Buffer.alloc(32, 7); b.writeUInt16BE(i, 30); return new PublicKey(b).toBase58(); };
// a launchpad CDN url: one candidate (no IPFS rotation), so one fetch per download
const cdn = (name) => `https://cdn.example-launchpad.io/${name}`;
const nameOf = (u) => u.split("/").pop();
let LOGO;
const logo = async () => (LOGO ??= await renderLogo({ symbol: "C", palette: ["#33aaff", "#221133", "#ffffff"], seed: "capture" }));
const png = async () => new Response(await logo(), { headers: { "content-type": "image/png" } });
// RIFF....WEBP with no decodable frame: downloads fine, cannot be drawn
const STUB = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(24, 1)]);

async function waitFor(cond, ms = 3_000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(5); }
}
function makeCache({ fetchImpl, dir = mkdtempSync(join(tmpdir(), "spore-capture-")), ...opts } = {}) {
  const work = new ImgWork({ inline: true, log: quiet });
  const mk = (more = {}) => new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), log: quiet, work, ...opts, ...more });
  const cache = mk();
  return { dir, cache, mk, done: () => { cache.close(); work.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function serve(cache, imageOf = () => null) {
  const app = express();
  app.get("/api/img", cache.handler());
  app.get("/api/logo-sheet", cache.sheetHandler({ imageOf, isMint }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const img = async (u, w = 64) => { const r = await fetch(`${base}/api/img?u=${encodeURIComponent(u)}${w ? `&w=${w}` : ""}`); return { status: r.status, h: (k) => r.headers.get(k), body: Buffer.from(await r.arrayBuffer()) }; };
  const sheet = async (mints) => { const r = await fetch(`${base}/api/logo-sheet?w=64&m=${mints.join(",")}`); await r.arrayBuffer(); return { status: r.status, bits: r.headers.get("x-sheet"), dead: r.headers.get("x-sheet-dead"), pending: r.headers.get("x-sheet-pending"), cc: r.headers.get("cache-control") }; };
  return { img, sheet, close: () => new Promise((r) => srv.close(r)) };
}

test("first sight: an image url the model learns (metadata image, asset icon) gets its 64 px thumbnail at once; a known image is not queued again", async () => {
  const fetched = [];
  const { cache, done } = makeCache({ fetchImpl: async (u) => { fetched.push(nameOf(u)); return png(); }, concurrency: 8 });
  const { buildTree, K } = await import("./helpers/tree.mjs");
  const { db, model } = buildTree(); // AAA's image was set before the hook: the warm pass covers what existed before
  const seen = [];
  model.onImage = (u) => { seen.push(u); return cache.enqueueThumb(u); };
  try {
    const row = { description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true };
    model.setMeta("https://ipfs.io/ipfs/BBB", { ...row, image: cdn("b.png") });
    model.setMeta("https://ipfs.io/ipfs/BBB", { ...row, image: cdn("b.png"), fetchedAt: 2 }); // a re-read with the same image
    model.setMeta("https://ipfs.io/ipfs/GGG", { ...row, image: null });                        // no image: nothing to queue
    model.setAssetIcons({ [K.X]: cdn("icon.png") });
    assert.deepEqual(seen, [cdn("b.png"), cdn("icon.png")], "each new image url once");
    await waitFor(() => cache.freshPending === 0 && existsSync(cache.thumbPath(cdn("b.png"), 64)) && existsSync(cache.thumbPath(cdn("icon.png"), 64)));
    assert.deepEqual(fetched.sort(), ["b.png", "icon.png"]);
    assert.equal(cache.stats.freshQueued, 2); assert.equal(cache.stats.freshMade, 2); assert.equal(cache.stats.bgDownloads, 2, "on the background slots");
    // a url whose thumbnail is on disk costs a lookup, no download
    assert.equal(cache.enqueueThumb(cdn("b.png")), true);
    await waitFor(() => cache.freshPending === 0);
    assert.equal(fetched.length, 2); assert.equal(cache.stats.freshMade, 2);
    // a throwing hook never breaks the model
    model.onImage = () => { throw new Error("boom"); };
    model.setMeta("https://ipfs.io/ipfs/GGG", { ...row, image: cdn("g.png") });
    assert.equal(model.meta.get("https://ipfs.io/ipfs/GGG").image, cdn("g.png"));
  } finally { db.close(); done(); }
});

test("first sight is deduplicated and bounded: a url waiting or in work is not queued twice, past freshMax the url is dropped", async () => {
  const gate = new Map(), fetched = [];
  const fetchImpl = (u) => new Promise((resolve) => { fetched.push(nameOf(u)); gate.set(nameOf(u), async () => resolve(await png())); });
  const { cache, done } = makeCache({ fetchImpl, concurrency: 8, freshConcurrency: 1, freshMax: 2 });
  try {
    assert.equal(cache.enqueueThumb(cdn("f1.png")), true);
    await waitFor(() => gate.has("f1.png"));
    assert.equal(cache.enqueueThumb(cdn("f1.png")), false, "in work");
    assert.equal(cache.enqueueThumb(cdn("f2.png")), true); assert.equal(cache.enqueueThumb(cdn("f2.png")), false, "waiting");
    assert.equal(cache.enqueueThumb(cdn("f3.png")), true);
    assert.equal(cache.enqueueThumb(cdn("f4.png")), false, "two waiting already (freshMax)"); assert.equal(cache.stats.freshDropped, 1);
    assert.equal(cache.enqueueThumb(""), false); assert.equal(cache.enqueueThumb(null), false);
    assert.equal(cache.freshPending, 3);
    await gate.get("f1.png")();
    await waitFor(() => gate.has("f2.png")); await gate.get("f2.png")();
    await waitFor(() => gate.has("f3.png")); await gate.get("f3.png")();
    await waitFor(() => cache.freshPending === 0);
    assert.deepEqual(fetched, ["f1.png", "f2.png", "f3.png"], "one at a time, in order");
    cache.close();
    assert.equal(cache.enqueueThumb(cdn("f5.png")), false, "closed");
  } finally { done(); }
});

test("download slots: background work takes at most half of them; an on-demand ask starts at once and lifts a background download still waiting", async () => {
  const started = [], gate = new Map();
  const fetchImpl = (u) => new Promise((resolve) => { started.push(nameOf(u)); gate.set(nameOf(u), async () => resolve(await png())); });
  const { cache, done } = makeCache({ fetchImpl, concurrency: 4 });
  try {
    assert.equal(cache.bgConcurrency, 2);
    const pass = cache.warm(["w1", "w2", "w3", "w4"].map((n) => cdn(`${n}.png`)), 64, 4);
    await waitFor(() => started.length >= 2); await sleep(20);
    assert.deepEqual(started, ["w1.png", "w2.png"], "two background downloads run, the other two wait");
    const a = cache.get(cdn("a.png"));   // a visitor's logo: a free slot at once
    const w4 = cache.get(cdn("w4.png")); // a visitor asks for one the warm pass queued: it stops waiting behind the pass
    await waitFor(() => started.length >= 4); await sleep(20);
    assert.deepEqual(started.slice(0, 2), ["w1.png", "w2.png"]); assert.deepEqual(started.slice(2).sort(), ["a.png", "w4.png"]);
    assert.deepEqual(cache.slots(), { active: 4, bgActive: 2, concurrency: 4, bgConcurrency: 2, waiting: [0, 0, 1] });
    for (const n of ["a.png", "w4.png"]) await gate.get(n)();
    assert.ok(await a); assert.ok(await w4);
    await sleep(20);
    assert.ok(!started.includes("w3.png"), "the visitors' slots freed, but two background downloads already run");
    await gate.get("w1.png")();
    await waitFor(() => gate.has("w3.png"));
    await gate.get("w2.png")(); await gate.get("w3.png")();
    const r = await pass;
    assert.equal(r.ok, 4); assert.equal(r.failed, 0);
    assert.deepEqual(cache.slots().waiting, [0, 0, 0]); assert.equal(cache.slots().active, 0);
  } finally { done(); }
});

test("warm pass: resumes where the previous one stopped, after a restart too (kv), following the url when the list moved; a full round starts the next one at the top", async () => {
  const db = new Db(":memory:");
  const fetched = [];
  let first = null;
  const fetchImpl = async (u) => { fetched.push(nameOf(u)); if (first) { const c = first; first = null; c.close(); } return png(); }; // the first download "shuts the server down"
  const list = ["l0", "l1", "l2", "l3", "l4"].map((n) => cdn(`${n}.png`));
  const { cache: c1, mk, done } = makeCache({ fetchImpl, concurrency: 2, store: db });
  try {
    first = c1;
    const r1 = await c1.warm(list, 64, 1, { resume: "imgWarmCursor" });
    assert.equal(r1.stopped, true); assert.equal(r1.from, 0); assert.deepEqual(fetched, ["l0.png"]);
    const cur = db.kvGet("imgWarmCursor");
    assert.equal(cur.i, 1); assert.equal(cur.url, list[1], "the next url is remembered in sqlite");
    // a restart: a new cache on the same database; a new logo joined the top of the list meanwhile
    const c2 = mk();
    const r2 = await c2.warm([cdn("new.png"), ...list], 64, 1, { resume: "imgWarmCursor" });
    assert.equal(r2.from, 2, "found by its url, not its old position"); assert.equal(r2.stopped, false); assert.equal(r2.ok, 6);
    assert.deepEqual(fetched, ["l0.png", "l1.png", "l2.png", "l3.png", "l4.png", "new.png"], "from l1 round to the top; l0 is on disk already");
    assert.equal(db.kvGet("imgWarmCursor").i, 0); assert.equal(db.kvGet("imgWarmCursor").url, null, "a full round: the next pass starts at the top");
    const r3 = await c2.warm(list, 64, 1, { resume: "imgWarmCursor" });
    assert.equal(r3.from, 0); assert.equal(r3.ok, 5); assert.equal(fetched.length, 6, "all on disk: nothing fetched");
    // without `resume` a pass starts at the top and keeps no cursor (the card's small asks)
    const r4 = await c2.warm(list.slice(2), 64, 1);
    assert.equal(r4.from, 0);
    c2.close();
  } finally { db.close(); done(); }
});

test("failures are classified and kept in sqlite: 404 / not an image permanent (an hour, a day, then a week), 5xx / 429 temporary (a minute, doubling); a restart fetches none of them before its time; a success clears the row", async () => {
  const db = new Db(":memory:");
  let clock = Date.now(), busy = 503;
  const calls = [];
  const fetchImpl = async (u) => {
    const n = nameOf(u); calls.push(n);
    if (n === "gone.png") return new Response("", { status: 404 });
    if (n === "busy.png") return busy === 200 ? png() : new Response("", { status: busy });
    if (n === "limit.png") return new Response("", { status: 429 });
    if (n === "html.png") return new Response("<html>", { headers: { "content-type": "text/html" } });
    return png();
  };
  const { cache: c1, mk, done } = makeCache({ fetchImpl, concurrency: 4, store: db, now: () => clock });
  // limit.png on a host of its own: a 429 pauses its host in the pacer, which would hold the others back too
  const urls = ["gone", "busy", "limit", "html", "ok"].map((n) => (n === "limit" ? "https://limited.example-cdn.io/limit.png" : cdn(`${n}.png`)));
  const row = (n) => db.imgFailAll().find((f) => nameOf(f.url) === n);
  try {
    for (const u of urls) await c1.get(u);
    assert.deepEqual(Object.fromEntries(db.imgFailAll().map((f) => [nameOf(f.url), f.kind])), { "gone.png": "gone", "busy.png": "temp", "limit.png": "temp", "html.png": "gone" });
    assert.equal(row("gone.png").retryAt - row("gone.png").at, IMG_GONE_RETRY_MS[0]); assert.equal(row("gone.png").error, "HTTP 404");
    assert.equal(row("busy.png").retryAt - row("busy.png").at, IMG_TEMP_RETRY_MS); assert.equal(row("limit.png").error, "rate limited");
    assert.equal(c1.isDead(cdn("gone.png")), true); assert.equal(c1.isDead(cdn("busy.png")), false, "temporary is not dead"); assert.equal(c1.isPending(cdn("busy.png")), true);
    // a restart: the failure memory comes back from sqlite and nothing failed is fetched again before its time
    const c2 = mk(); calls.length = 0;
    const r = await c2.warm(urls);
    assert.deepEqual(calls, [], "ok.png's original is on disk; the four failures wait");
    assert.equal(r.ok, 1); assert.equal(r.skipped, 4);
    assert.equal(await c2.get(cdn("gone.png")), null); assert.deepEqual(calls, [], "an on-demand ask does not hammer a failed url either");
    // temporary: a minute, then two (doubling, capped at IMG_TEMP_RETRY_MAX_MS)
    clock += IMG_TEMP_RETRY_MS + 1;
    assert.equal(await c2.get(cdn("busy.png")), null); assert.deepEqual(calls, ["busy.png"]);
    assert.equal(row("busy.png").attempts, 2); assert.equal(row("busy.png").retryAt - clock, 2 * IMG_TEMP_RETRY_MS);
    // permanent: the next waits a day, then a week, and a week from then on
    for (const [i, wait] of [[1, IMG_GONE_RETRY_MS[1]], [2, IMG_GONE_RETRY_MS[2]], [3, IMG_GONE_RETRY_MS[2]]]) {
      clock = row("gone.png").retryAt + 1;
      assert.equal(await c2.get(cdn("gone.png")), null);
      assert.equal(row("gone.png").attempts, i + 1); assert.equal(row("gone.png").retryAt - clock, wait, `failure ${i + 1}`);
    }
    // a success clears the row
    busy = 200; clock = row("busy.png").retryAt + 1;
    assert.ok(await c2.get(cdn("busy.png")));
    assert.equal(row("busy.png"), undefined); assert.equal(c2.failureOf(cdn("busy.png")), null);
    assert.ok(IMG_TEMP_RETRY_MAX_MS <= 3600_000, "temporary waits stay short");
    c2.close();
  } finally { db.close(); done(); }
});

test("IPFS: gateways that say 403 while others answer 429 or 5xx make a temporary failure; 404 everywhere a permanent one, with a per-gateway summary", async () => {
  const fetchImpl = async (u) => {
    if (u.includes("/mixed")) return new Response("", { status: u.startsWith("https://pump.mypinata.cloud/") ? 403 : u.startsWith("https://ipfs.io/") ? 429 : 502 });
    return new Response("", { status: 404 });
  };
  const { cache, done } = makeCache({ fetchImpl, concurrency: 4 });
  try {
    // the definitive one first: the 429 below pauses ipfs.io, and a paused gateway is itself a temporary answer
    assert.equal(await cache.get("https://ipfs.io/ipfs/QmGone/x.png"), null);
    const gone = cache.failureOf("https://ipfs.io/ipfs/QmGone/x.png");
    assert.equal(gone.kind, "gone"); assert.equal(gone.error.split("; ").length, 5); assert.ok(gone.error.split("; ").every((s) => s.startsWith("404 ")));
    assert.equal(await cache.get("https://ipfs.io/ipfs/QmMixed/mixed.png"), null);
    const mixed = cache.failureOf("https://ipfs.io/ipfs/QmMixed/mixed.png");
    assert.equal(mixed.kind, "temp");
    assert.match(mixed.error, /^403 pump\.mypinata\.cloud; 429 ipfs\.io; 502 dweb\.link/);
  } finally { done(); }
});

test("/api/img: 503 with a short Retry-After for a temporary failure, 404 for a permanent one; /api/logo-sheet keeps the first pending, the second dead; an undrawable logo is a dead cell but /api/img serves its original", async () => {
  const fetchImpl = async (u) => {
    const n = nameOf(u);
    if (n === "busy.png") return new Response("", { status: 503 });
    if (n === "gone.png") return new Response("", { status: 410 });
    if (n === "stub.webp") return new Response(STUB, { headers: { "content-type": "image/webp" } });
    return png();
  };
  const { cache, done } = makeCache({ fetchImpl, concurrency: 4 });
  const A = mint(1), B = mint(2), C = mint(3), D = mint(4);
  const images = { [A]: cdn("busy.png"), [B]: cdn("gone.png"), [C]: cdn("ok.png"), [D]: cdn("stub.webp") };
  const { img, sheet, close } = await serve(cache, (m) => images[m] ?? null);
  try {
    const busy = await img(cdn("busy.png"));
    assert.equal(busy.status, 503); assert.equal(busy.h("cache-control"), "no-store");
    const ra = Number(busy.h("retry-after"));
    assert.ok(ra >= 1 && ra <= Math.min(IMG_RETRY_AFTER_MAX_S, IMG_TEMP_RETRY_MS / 1000), `Retry-After ${ra}`);
    const gone = await img(cdn("gone.png"));
    assert.equal(gone.status, 404); assert.equal(gone.h("retry-after"), null);
    const s = await sheet([A, B, C]);
    assert.equal(s.status, 200); assert.equal(s.bits, "04", "C present"); assert.equal(s.dead, "02", "B dead, A not"); assert.equal(s.pending, "1"); assert.equal(s.cc, "no-store");
    const again = await sheet([A, B, C]);
    assert.equal(again.dead, "02"); assert.equal(again.pending, "1", "still pending while its wait runs, without a new download");
    // cannot be drawn: the sheet cell is dead, /api/img?w=64 answers the original
    const stub = await img(cdn("stub.webp"));
    assert.equal(stub.status, 200); assert.equal(stub.h("content-type"), "image/webp"); assert.equal(stub.h("x-img-thumb"), null);
    const f = cache.failureOf(cdn("stub.webp"));
    assert.equal(f.kind, "nothumb"); assert.equal(f.retryAt - f.at, IMG_NOTHUMB_RETRY_MS);
    assert.equal((await sheet([D])).dead, "01");
    assert.equal((await img(cdn("stub.webp"))).status, 200, "the original keeps being served");
  } finally { await close(); done(); }
});

test("a renderer that learned more (THUMB_RULE) retries the logos it could not draw; other failures stay", async () => {
  const db = new Db(":memory:");
  const now = Date.now();
  db.imgFailSet({ url: cdn("anim.webp"), kind: "nothumb", error: "not drawable", attempts: 1, at: now, retryAt: now + IMG_NOTHUMB_RETRY_MS });
  db.imgFailSet({ url: cdn("gone.png"), kind: "gone", error: "HTTP 404", attempts: 1, at: now, retryAt: now + 3600_000 });
  db.kvSet("imgThumbRule", THUMB_RULE - 1);
  const { cache, mk, done } = makeCache({ fetchImpl: png, store: db });
  try {
    assert.equal(cache.failureOf(cdn("anim.webp")), null, "dropped at boot");
    assert.equal(cache.failureOf(cdn("gone.png")).kind, "gone");
    assert.equal(db.kvGet("imgThumbRule"), THUMB_RULE);
    db.imgFailSet({ url: cdn("anim2.webp"), kind: "nothumb", error: "not drawable", attempts: 1, at: now, retryAt: now + IMG_NOTHUMB_RETRY_MS });
    const again = mk();
    assert.equal(again.failureOf(cdn("anim2.webp")).kind, "nothumb", "once per rule, not once per boot");
    again.close();
  } finally { db.close(); done(); }
});

test("thumbnails are kept whatever their age: an old one is served without a download and a sweep leaves it", async () => {
  let fetches = 0;
  const { cache, mk, done } = makeCache({ fetchImpl: async () => { fetches++; return png(); }, concurrency: 4 });
  const A = mint(9), u = cdn("old.png");
  try {
    await cache.warm([u]);
    assert.equal(fetches, 1);
    const file = cache.thumbPath(u, 64), old = (Date.now() - 60 * 24 * 3600_000) / 1000;
    utimesSync(file, old, old); // made 60 days ago (the old rule expired it at 7 and deleted it at 14)
    for (const f of readdirSync(cache.dir)) if (!f.endsWith(".w64.png")) rmSync(join(cache.dir, f)); // and its original is long gone
    const later = mk();
    const { img, sheet, close } = await serve(later, () => u);
    try {
      const r = await img(u);
      assert.equal(r.status, 200); assert.equal(r.h("x-img-thumb"), "64");
      assert.equal((await sheet([A])).bits, "01");
      assert.equal((await later.warm([u])).ok, 1);
      assert.equal(fetches, 1, "no download for an old thumbnail");
      later.sweep();
      assert.ok(existsSync(file), "a sweep never drops a thumbnail for its age");
    } finally { await close(); later.close(); }
  } finally { done(); }
});

test("the thumbnail budget evicts the least recently used first; what was used within thumbKeepMs stays (over budget, with a warning); the warm pass never evicts", async () => {
  const { renderThumb } = await import("../lib/meta.mjs");
  const T = (await renderThumb(await logo(), "image/png", 64)).length;
  const fetchImpl = async () => png();
  // least recently used: t1 goes, the served t0 stays
  {
    const { cache, done } = makeCache({ fetchImpl, concurrency: 4, thumbMaxBytes: Math.floor(2.5 * T), thumbKeepMs: 0 });
    const { img, close } = await serve(cache);
    try {
      const make = async (n) => { const u = cdn(n); await cache.thumb(u, await cache.get(u), 64); await sleep(5); return cache.thumbPath(u, 64); };
      const t0 = await make("t0.png"), t1 = await make("t1.png");
      assert.equal((await img(cdn("t0.png"))).h("x-img-thumb"), "64"); await sleep(5); // t0 is served: most recently used
      const t2 = await make("t2.png");
      assert.ok(!existsSync(t1), "t1 (made, never served) went first");
      assert.ok(existsSync(t0) && existsSync(t2));
      assert.equal(cache.stats.thumbsEvicted, 1);
    } finally { await close(); done(); }
  }
  // within the keep window nothing is evicted; once it passed (mtime = last use, after a restart) the oldest goes
  {
    const warns = [];
    const { cache, mk, done } = makeCache({ fetchImpl, concurrency: 4, thumbMaxBytes: Math.floor(2.5 * T), thumbKeepMs: 3600_000, log: { ...quiet, warn: (m) => warns.push(m) } });
    try {
      const files = [];
      for (const n of ["k0.png", "k1.png", "k2.png"]) { const u = cdn(n); await cache.thumb(u, await cache.get(u), 64); files.push(cache.thumbPath(u, 64)); }
      assert.ok(files.every((f) => existsSync(f)), "all made within the hour: kept");
      assert.ok(cache.stats.thumbBytes > cache.thumbMaxBytes); assert.ok(warns.some((m) => /over the .* budget/.test(m)), warns.join("\n"));
      const ago = (h) => (Date.now() - h * 3600_000) / 1000;
      utimesSync(files[0], ago(3), ago(3)); utimesSync(files[1], ago(2), ago(2));
      const later = mk();
      later.sweep();
      assert.ok(!existsSync(files[0]), "the least recently used beyond the window went");
      assert.ok(existsSync(files[1]) && existsSync(files[2]));
      later.close();
    } finally { done(); }
  }
  // the warm pass stops short of the budget (THUMB_WARM_FILL) instead of evicting (first sight: see "a full thumbnail budget")
  {
    const { cache, done } = makeCache({ fetchImpl, concurrency: 4, thumbMaxBytes: Math.floor(2.5 * T), thumbKeepMs: 0 });
    try {
      const r = await cache.warm(["b0", "b1", "b2", "b3"].map((n) => cdn(`${n}.png`)), 64, 1);
      assert.equal(r.ok, 2); assert.equal(r.full, 2); assert.equal(cache.stats.thumbsEvicted, 0);
      assert.ok(cache.stats.thumbBytes <= cache.thumbMaxBytes);
    } finally { done(); }
  }
});

test("attempts count within one kind (repair 2026-11-10): three temporary failures then a 404 is a first 404 (an hour), not a fourth failure (a week); a 503 after 404s starts at a minute", async () => {
  const db = new Db(":memory:");
  let clock = Date.now(), status = 503;
  const { cache, done } = makeCache({ fetchImpl: async () => new Response("", { status }), store: db, now: () => clock });
  const u = cdn("flaky.png");
  const again = async () => { clock = cache.fails.get(u).retryAt + 1; assert.equal(await cache.get(u), null); return cache.fails.get(u); };
  try {
    assert.equal(await cache.get(u), null);
    await again(); let f = await again();
    assert.equal(f.kind, "temp"); assert.equal(f.attempts, 3);
    status = 404; f = await again();
    assert.equal(f.kind, "gone"); assert.equal(f.attempts, 1, "a first 404"); assert.equal(f.retryAt - f.at, IMG_GONE_RETRY_MS[0], "an hour, not a week");
    f = await again();
    assert.equal(f.attempts, 2); assert.equal(f.retryAt - f.at, IMG_GONE_RETRY_MS[1]);
    status = 503; f = await again();
    assert.equal(f.kind, "temp"); assert.equal(f.attempts, 1); assert.equal(f.retryAt - f.at, IMG_TEMP_RETRY_MS);
    assert.deepEqual(db.imgFailAll().map((r) => [r.kind, r.attempts]), [["temp", 1]], "persisted with the count of its own kind");
  } finally { db.close(); done(); }
});

test("a temporary failure that keeps coming (repair 2026-11-10) backs off past an hour after IMG_TEMP_SHORT_TRIES, up to a day, and stays temporary: 503 with a short Retry-After, a pending sheet cell", async () => {
  assert.equal(IMG_TEMP_SHORT_TRIES, 6); assert.equal(IMG_TEMP_LONG_MAX_MS, 24 * 3600_000);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(imgTempWaitMs), [1, 2, 4, 8, 16, 32].map((m) => m * 60_000), "the short waits, all within IMG_TEMP_RETRY_MAX_MS");
  assert.ok(imgTempWaitMs(7) > IMG_TEMP_RETRY_MAX_MS); assert.equal(imgTempWaitMs(12), IMG_TEMP_LONG_MAX_MS); assert.equal(imgTempWaitMs(500), IMG_TEMP_LONG_MAX_MS);
  // an unpinned CID: 17 tries in its first week (then daily) instead of one an hour (~170)
  let t = 0, n = 0;
  for (let a = 1; t < 7 * 24 * 3600_000; a++) { t += imgTempWaitMs(a); n++; }
  assert.equal(n, 17);
  let clock = Date.now();
  const A = mint(40), u = cdn("unpinned.png");
  let fetches = 0;
  const { cache, done } = makeCache({ fetchImpl: async () => { fetches++; return new Response("", { status: 504 }); }, now: () => clock });
  const { img, sheet, close } = await serve(cache, () => u);
  try {
    assert.equal(await cache.get(u), null);
    for (let i = 2; i <= 9; i++) { clock = cache.fails.get(u).retryAt + 1; await cache.get(u); }
    const f = cache.fails.get(u);
    assert.equal(f.kind, "temp"); assert.equal(f.attempts, 9); assert.equal(f.retryAt - f.at, imgTempWaitMs(9)); assert.ok(f.retryAt - f.at > 4 * 3600_000);
    assert.equal(fetches, 9);
    const r = await img(u);
    assert.equal(r.status, 503, "still temporary"); assert.equal(Number(r.h("retry-after")), IMG_RETRY_AFTER_MAX_S, "the browser asks again in minutes, the server stays quiet");
    const s = await sheet([A]);
    assert.equal(s.dead, "00"); assert.equal(s.pending, "1");
    assert.equal(fetches, 9, "no download while it waits");
  } finally { await close(); done(); }
});

test("a name that does not resolve (repair 2026-11-10): a rotation where every gateway fails so is our DNS (temporary, pending); a lone host is temporary until the third time in a row, then permanent", async () => {
  assert.equal(IMG_DNS_GONE_AFTER, 3);
  let clock = Date.now(), dnsDown = true, timeouts = false;
  const notFound = () => Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  const guard = new HostGuard({ resolve: async () => { if (dnsDown) throw notFound(); return [{ address: "93.184.216.34", family: 4 }]; }, ttlMs: 0 });
  const fetchImpl = async () => { if (timeouts) throw new Error("The operation was aborted due to timeout"); return png(); };
  const { cache, done } = makeCache({ fetchImpl, pacer: new HostPacer({ fetchImpl, guard, sleep: async () => {} }), now: () => clock });
  const ipfs = "https://ipfs.io/ipfs/QmDnsDown/logo.png", lone = cdn("lone.png"), flaky = "https://flaky.example-cdn.io/x.png";
  const step = async (u, mode) => {
    dnsDown = mode === "dns"; timeouts = mode === "timeout";
    const prev = cache.fails.get(u); if (prev) clock = prev.retryAt + 1;
    assert.equal(await cache.get(u), null);
    return cache.fails.get(u);
  };
  try {
    let f = await step(ipfs, "dns");
    assert.equal(f.kind, "temp", "five gateways do not vanish together"); assert.equal(f.error.split("; ").length, 5);
    assert.ok(f.error.split("; ").every((p) => p.startsWith("ENOTFOUND ")));
    assert.equal(cache.isPending(ipfs), true); assert.equal(cache.isDead(ipfs), false);
    f = await step(ipfs, "dns"); assert.equal(f.kind, "temp"); f = await step(ipfs, "dns"); assert.equal(f.kind, "temp", "however often");
    // a lone host: temporary, temporary, then permanent (an hour, a day, ...)
    f = await step(lone, "dns"); assert.equal(f.kind, "temp"); assert.match(f.error, /ENOTFOUND/); assert.equal(f.retryAt - f.at, IMG_DNS_RETRY_MS);
    f = await step(lone, "dns"); assert.equal(f.kind, "temp"); assert.equal(f.attempts, 2);
    f = await step(lone, "dns"); assert.equal(f.kind, "gone", "the third in a row"); assert.equal(f.retryAt - f.at, IMG_GONE_RETRY_MS[0]);
    assert.equal(cache.isDead(lone), true);
    f = await step(lone, "dns"); assert.equal(f.kind, "gone"); assert.equal(f.attempts, 2, "and stays so");
    // "in a row": another kind of failure in between starts the count over
    assert.equal((await step(flaky, "dns")).kind, "temp"); assert.equal((await step(flaky, "dns")).kind, "temp");
    f = await step(flaky, "timeout"); assert.equal(f.kind, "temp"); assert.equal(f.attempts, 1, "a temporary run of its own");
    assert.equal((await step(flaky, "dns")).kind, "temp", "the DNS count starts over"); assert.equal((await step(flaky, "dns")).kind, "temp");
    assert.equal((await step(flaky, "dns")).kind, "gone");
    // DNS back: the IPFS logo downloads at its next try
    dnsDown = false; clock = cache.fails.get(ipfs).retryAt + 1;
    assert.ok(await cache.get(ipfs)); assert.equal(cache.failureOf(ipfs), null);
  } finally { done(); }
});

test("a full thumbnail budget (repair 2026-11-10): first sight evicts thumbnails unused for 30 days so new coins keep getting logos, the warm pass never evicts; refusals are warned about at most every 10 min, with counts", async () => {
  const { renderThumb } = await import("../lib/meta.mjs");
  const T = (await renderThumb(await logo(), "image/png", 64)).length;
  assert.equal(THUMB_FRESH_IDLE_MS, 30 * 86_400_000); assert.equal(THUMB_FULL_WARN_MS, 10 * 60_000);
  const warns = [];
  let clock = Date.now();
  const log = { ...quiet, warn: (m) => warns.push(m) };
  const { cache, mk, done } = makeCache({ fetchImpl: async () => png(), concurrency: 4, thumbMaxBytes: Math.floor(2.5 * T), log, now: () => clock });
  const [old, recent, n1, n2] = ["old.png", "recent.png", "new1.png", "new2.png"].map(cdn);
  try {
    assert.equal((await cache.warm([old, recent])).ok, 2, "two thumbnails: the warm pass is at its 85 %");
    const ago = (d) => (Date.now() - d * 86_400_000) / 1000;
    utimesSync(cache.thumbPath(old, 64), ago(31), ago(31)); utimesSync(cache.thumbPath(recent, 64), ago(2), ago(2));
    const later = mk(); // a restart: a thumbnail's mtime is its last use
    try {
      const w = await later.warm([cdn("w1.png")]);
      assert.equal(w.full, 1); assert.ok(existsSync(later.thumbPath(old, 64)), "the warm pass evicts nothing"); assert.equal(later.stats.thumbsEvicted, 0);
      assert.equal(warns.length, 1); assert.match(warns[0], /thumbnail budget full .*: 0 first-sight and 1 background thumbnails not made/);
      // first sight: the thumbnail unused for 31 days goes (not the one used 2 days ago), the new coin gets its logo
      assert.equal(later.enqueueThumb(n1), true);
      await waitFor(() => later.freshPending === 0);
      assert.ok(existsSync(later.thumbPath(n1, 64)), "made"); assert.equal(later.stats.freshMade, 1);
      assert.ok(!existsSync(later.thumbPath(old, 64)), "the idle one went"); assert.ok(existsSync(later.thumbPath(recent, 64)));
      assert.equal(later.stats.freshEvicted, 1);
      // nothing unused for 30 days is left: refused and counted, but not warned about again within 10 min
      assert.equal(later.enqueueThumb(n2), true);
      await waitFor(() => later.freshPending === 0);
      assert.ok(!existsSync(later.thumbPath(n2, 64))); assert.equal(later.stats.freshFull, 1);
      assert.ok(existsSync(later.thumbPath(recent, 64)), "used 2 days ago: kept");
      assert.equal(warns.length, 1, "rate-limited");
      clock += THUMB_FULL_WARN_MS;
      await later.warm([cdn("w2.png")]);
      assert.equal(warns.length, 2); assert.match(warns[1], /1 first-sight and 1 background thumbnails not made in 10 min/);
      assert.equal(later.stats.warmFull, 2); assert.ok(later.stats.thumbBytes <= later.thumbMaxBytes);
    } finally { later.close(); }
  } finally { done(); }
});

test("thumbnail reserve for first sight (repair 2026-11-10): the warm pass stops at THUMB_WARM_FILL, so it does not refill what first sight evicted; N first-sight captures on a full budget evict about N thumbnails, not 5 % of the budget each", async () => {
  assert.equal(THUMB_BG_FILL, 0.95); assert.equal(THUMB_WARM_FILL, 0.85);
  const { renderThumb } = await import("../lib/meta.mjs");
  const bytes = await renderThumb(await logo(), "image/png", 64), T = bytes.length;
  // 100 thumbnails' worth plus a quarter of one, so 95 / 90 / 85 % fall between whole thumbnails whatever the float rounding
  const thumbMaxBytes = 100 * T + Math.floor(T / 4);
  const fetchImpl = async () => png();
  {
    const { cache: c0, mk, done } = makeCache({ fetchImpl, concurrency: 4, thumbMaxBytes });
    c0.close();
    // a full budget (95 %): thumbnails nobody was served for more than 30 days
    const idle = Date.now() / 1000 - 31 * 86_400;
    for (let i = 0; i < 95; i++) { const f = c0.thumbPath(cdn(`idle${i}.png`), 64); writeFileSync(f, bytes); utimesSync(f, idle - 95 + i, idle - 95 + i); }
    const cache = mk(); // a restart indexes them (the mtime is the last use)
    const files = () => cache.snapshot().thumbFiles;
    let w = 0;
    const warmPass = () => cache.warm(Array.from({ length: 8 }, () => cdn(`warm${w++}.png`)), 64, 2);
    try {
      assert.equal(files(), 95);
      let r = await warmPass();
      assert.equal(r.ok, 0); assert.equal(r.full, 8);
      const N = 10;
      for (let i = 0; i < N; i++) {
        assert.equal(cache.enqueueThumb(cdn(`new${i}.png`)), true);
        await waitFor(() => cache.freshPending === 0);
        assert.ok(existsSync(cache.thumbPath(cdn(`new${i}.png`), 64)), `new coin ${i} got its logo`);
        r = await warmPass();
        assert.equal(r.ok, 0, `after new coin ${i}: ${files()} thumbnails, above 85 %: the warm pass refills nothing`);
      }
      assert.equal(cache.stats.freshMade, N);
      // the first capture evicted down to 90 % (5 thumbnails), the next ones used that room, and so on: one thumbnail per new
      // coin, where a warm pass that refilled to 95 % made every capture evict 5 % of the budget again (50 here, ~11k live)
      assert.ok(cache.stats.freshEvicted <= N + 5, `${cache.stats.freshEvicted} evicted for ${N} new coins`);
      assert.equal(cache.stats.thumbsEvicted, cache.stats.freshEvicted);
      assert.ok(files() >= 90 && files() <= 95, `${files()} thumbnails`);
    } finally { cache.close(); done(); }
  }
  // below THUMB_WARM_FILL the warm pass makes thumbnails up to it: 80 on disk, room for 5 more
  {
    const { cache: c0, mk, done } = makeCache({ fetchImpl, concurrency: 4, thumbMaxBytes });
    c0.close();
    for (let i = 0; i < 80; i++) writeFileSync(c0.thumbPath(cdn(`kept${i}.png`), 64), bytes);
    const cache = mk();
    try {
      const r = await cache.warm(Array.from({ length: 8 }, (_, i) => cdn(`fill${i}.png`)), 64, 1);
      assert.equal(r.ok, 5); assert.equal(r.full, 3); assert.equal(cache.snapshot().thumbFiles, 85);
      assert.equal(cache.stats.thumbsEvicted, 0);
    } finally { cache.close(); done(); }
  }
});

test("one rotation gateway that does not resolve is not our DNS (repair 2026-11-10): the others' 403 and 404s stay a permanent failure; two that do not resolve are our resolver (temporary)", async () => {
  let unresolved = new Set(["w3s.link"]);
  const guard = new HostGuard({ resolve: async (h) => { if (unresolved.has(h)) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); return [{ address: "93.184.216.34", family: 4 }]; }, ttlMs: 0 });
  const fetchImpl = async (u) => new Response("", { status: u.startsWith("https://pump.mypinata.cloud/") ? 403 : 404 });
  const { cache, done } = makeCache({ fetchImpl, pacer: new HostPacer({ fetchImpl, guard, sleep: async () => {} }) });
  try {
    const one = "https://ipfs.io/ipfs/QmRetiredGateway/logo.png";
    assert.equal(await cache.get(one), null);
    let f = cache.failureOf(one);
    assert.equal(f.error, "403 pump.mypinata.cloud; 404 ipfs.io; 404 dweb.link; 404 gateway.pinata.cloud; ENOTFOUND w3s.link");
    assert.equal(f.kind, "gone", "a gateway retired for good does not make the others' answers temporary forever");
    assert.equal(f.retryAt - f.at, IMG_GONE_RETRY_MS[0]); assert.equal(cache.isDead(one), true);
    unresolved = new Set(["gateway.pinata.cloud", "w3s.link"]);
    const two = "https://ipfs.io/ipfs/QmResolverTrouble/logo.png";
    assert.equal(await cache.get(two), null);
    f = cache.failureOf(two);
    assert.equal(f.error, "403 pump.mypinata.cloud; 404 ipfs.io; 404 dweb.link; ENOTFOUND gateway.pinata.cloud; ENOTFOUND w3s.link");
    assert.equal(f.kind, "temp", "two of the rotation's own gateways do not vanish together"); assert.equal(cache.isPending(two), true);
  } finally { done(); }
});

test("a permanent failure counts across temporary ones (repair 2026-11-10): a url alternating 404 and 502 climbs to the day and then the week waits, across a restart (img_fail.gone_attempts); temporary x3 then a 404 is still a first 404; a success forgets the count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-gone-db-")), file = join(dir, "spore.db");
  let db = new Db(file), clock = Date.now(), mode = 404;
  const fetchImpl = async (u) => {
    if (mode === "ok") return png();
    if (mode === "dns") throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${new URL(u).hostname}`), { code: "ENOTFOUND" });
    return new Response("", { status: mode });
  };
  const { cache, mk, done } = makeCache({ fetchImpl, store: db, now: () => clock });
  const step = async (c, u, m) => {
    mode = m; const prev = c.fails.get(u); if (prev) clock = prev.retryAt + 1;
    assert.equal(await c.get(u), null);
    const f = c.fails.get(u); return [f.kind, f.attempts, f.retryAt - f.at];
  };
  const H = IMG_GONE_RETRY_MS, alt = cdn("alternating.png");
  let later = null;
  try {
    assert.deepEqual(await step(cache, alt, 404), ["gone", 1, H[0]]);
    assert.deepEqual(await step(cache, alt, 502), ["temp", 1, IMG_TEMP_RETRY_MS], "a temporary failure waits like one");
    assert.equal(cache.fails.get(alt).goneAttempts, 1, "and remembers the 404 before it");
    assert.deepEqual(await step(cache, alt, 404), ["gone", 2, H[1]], "the second 404: a day, not an hour again");
    assert.deepEqual(await step(cache, alt, 502), ["temp", 1, IMG_TEMP_RETRY_MS]);
    // a restart between the 502 and the next 404: the count comes back from sqlite
    cache.close(); db.close(); db = new Db(file);
    assert.deepEqual(db.imgFailAll().map((r) => [r.kind, r.attempts, r.goneAttempts]), [["temp", 1, 2]], "persisted");
    later = mk({ store: db });
    assert.deepEqual(await step(later, alt, 404), ["gone", 3, H[2]], "the third: a week");
    assert.deepEqual(await step(later, alt, 503), ["temp", 1, IMG_TEMP_RETRY_MS]);
    assert.deepEqual(await step(later, alt, 404), ["gone", 4, H[2]], "and weekly from then on");
    // a week of alternating answers costs a handful of fetches (counted per run it was ~330: an hour, a minute, an hour ...)
    const wk = cdn("week.png"), start = clock;
    let fetches = 0;
    for (let i = 0; !(later.fails.get(wk)?.retryAt >= start + 7 * 86_400_000); i++) { await step(later, wk, i % 2 ? 502 : 404); fetches++; }
    assert.ok(fetches <= 6, `${fetches} fetches in a week`);
    // kept: three temporary failures and then a 404 are a first 404 (an hour)
    const flaky = cdn("flaky3.png");
    for (let i = 0; i < 3; i++) await step(later, flaky, 503);
    assert.deepEqual(await step(later, flaky, 404), ["gone", 1, H[0]], "a first 404");
    // a lone host's DNS run that turns permanent continues the count of the 404 before it
    const moved = cdn("moved.png");
    assert.deepEqual(await step(later, moved, 404), ["gone", 1, H[0]]);
    await step(later, moved, "dns"); await step(later, moved, "dns");
    assert.deepEqual(await step(later, moved, "dns"), ["gone", 2, H[1]], "the second permanent failure in a row");
    // a success forgets it
    mode = "ok"; clock = later.fails.get(alt).retryAt + 1;
    assert.ok(await later.get(alt));
    assert.equal(later.fails.get(alt), undefined); assert.equal(db.imgFailAll().find((r) => r.url === alt), undefined);
  } finally { later?.close(); db.close(); done(); rmSync(dir, { recursive: true, force: true }); }
});

test("db: an img_fail table from before gone_attempts gets the column; its rows read 0, the value survives a reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-imgfail-mig-")), file = join(dir, "spore.db");
  const url = "https://a.example/x.png";
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE img_fail (url TEXT PRIMARY KEY, kind TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 1,
        failed_at INTEGER NOT NULL, retry_at INTEGER NOT NULL);
      INSERT INTO img_fail (url, kind, error, attempts, failed_at, retry_at) VALUES ('${url}', 'temp', 'HTTP 502', 2, 10, 20);`);
    old.close();
    const db = new Db(file);
    try {
      assert.deepEqual(db.imgFailAll(), [{ url, kind: "temp", error: "HTTP 502", attempts: 2, goneAttempts: 0, at: 10, retryAt: 20 }]);
      db.imgFailSet({ url, kind: "temp", error: "HTTP 502", attempts: 3, goneAttempts: 2, at: 30, retryAt: 40 });
    } finally { db.close(); }
    const again = new Db(file); // idempotent
    try { assert.deepEqual(again.imgFailAll().map((r) => [r.attempts, r.goneAttempts]), [[3, 2]]); } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a lone host's DNS misses are spaced (repair 2026-11-10): a 10-minute local DNS outage leaves the logo temporary; three misses spaced by their waits (15 min, then 30) make it permanent, at least 45 min after the first", async () => {
  assert.equal(IMG_DNS_RETRY_MS, 15 * 60_000);
  let clock = Date.now(), dnsDown = true, fetches = 0;
  const fetchImpl = async (u) => { fetches++; if (dnsDown) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${new URL(u).hostname}`), { code: "ENOTFOUND" }); return png(); };
  const { cache, done } = makeCache({ fetchImpl, now: () => clock });
  const u = cdn("outage.png"), t0 = clock;
  try {
    // the outage: the logo is asked for every minute for 10 min (visitors, the warm pass); the proxy downloads whenever its wait allows
    for (; clock <= t0 + 10 * 60_000; clock += 60_000) {
      assert.equal(await cache.get(u), null);
      assert.equal(cache.fails.get(u).kind, "temp", `${(clock - t0) / 60_000} min into the outage`); assert.equal(cache.isDead(u), false);
    }
    assert.equal(fetches, 1, "one miss in 10 min"); assert.equal(cache.fails.get(u).retryAt - t0, IMG_DNS_RETRY_MS);
    dnsDown = false; clock = cache.fails.get(u).retryAt + 1;
    assert.ok(await cache.get(u), "DNS back: the logo downloads at its next try"); assert.equal(cache.failureOf(u), null);
    // a host that is gone for good: three misses, each as soon as its wait allows
    dnsDown = true;
    const v = cdn("vanished.png"), at = [], seen = [];
    for (let i = 0; i < IMG_DNS_GONE_AFTER; i++) {
      const prev = cache.fails.get(v); if (prev) clock = prev.retryAt + 1;
      assert.equal(await cache.get(v), null);
      const f = cache.fails.get(v); at.push(f.at); seen.push([f.kind, f.retryAt - f.at]);
    }
    assert.deepEqual(seen, [["temp", IMG_DNS_RETRY_MS], ["temp", 2 * IMG_DNS_RETRY_MS], ["gone", IMG_GONE_RETRY_MS[0]]]);
    assert.ok(at[2] - at[0] >= 45 * 60_000, "the third miss at least 45 min after the first"); assert.equal(cache.isDead(v), true);
    // other temporary failures keep their short first wait
    assert.equal(imgTempWaitMs(1), IMG_TEMP_RETRY_MS);
  } finally { done(); }
});

test("db: img_fail rows round-trip, prune by retry time, drop by kind", () => {
  const db = new Db(":memory:");
  try {
    db.imgFailSet({ url: "https://a.example/1.png", kind: "temp", error: "x".repeat(300), attempts: 2, at: 10, retryAt: 20 });
    db.imgFailSet({ url: "https://a.example/2.png", kind: "nothumb", error: null, attempts: 1, at: 10, retryAt: 5_000 });
    const rows = db.imgFailAll();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((r) => r.url.endsWith("1.png")), { url: "https://a.example/1.png", kind: "temp", error: "x".repeat(200), attempts: 2, goneAttempts: 0, at: 10, retryAt: 20 });
    assert.equal(db.imgFailPrune(100), 1); assert.equal(db.imgFailAll().length, 1);
    assert.equal(db.imgFailDropKind("nothumb"), 1); assert.equal(db.imgFailAll().length, 0);
    db.imgFailSet({ url: "https://a.example/3.png", kind: "gone", error: "HTTP 404", attempts: 1, at: 1, retryAt: 2 });
    db.imgFailDelete("https://a.example/3.png"); assert.equal(db.imgFailAll().length, 0);
  } finally { db.close(); }
});

test("renders: a visitor's thumbnail is drawn before the background ones already queued", async () => {
  const { renderThumb } = await import("../lib/meta.mjs");
  const out = await renderThumb(await logo(), "image/png", 64);
  const calls = [];
  const work = { thumb: () => new Promise((resolve) => calls.push(() => resolve(out))), sheet: async () => ({ bytes: Buffer.alloc(0), type: "image/png", failed: [] }), close() {} };
  const { cache, done } = makeCache({ fetchImpl: png, concurrency: 4, work });
  try {
    const [u1, u2, u3, u4] = ["r1", "r2", "r3", "r4"].map((n) => cdn(`${n}.png`));
    const hits = await Promise.all([u1, u2, u3, u4].map((u) => cache.get(u)));
    const bg = [u1, u2, u3].map((u, i) => cache.thumb(u, hits[i], 64, { prio: PRIO_WARM }));
    await waitFor(() => calls.length === 1); // r1 is drawing, r2 and r3 wait
    const fg = cache.thumb(u4, hits[3], 64);  // a visitor's
    calls[0](); await bg[0];
    await waitFor(() => calls.length === 2); calls[1]();
    assert.ok(await fg, "r4 drawn second");
    assert.ok(!existsSync(cache.thumbPath(u2, 64)) && !existsSync(cache.thumbPath(u3, 64)), "ahead of r2 and r3");
    for (const i of [2, 3]) { await waitFor(() => calls.length === i + 1); calls[i](); }
    assert.ok((await Promise.all(bg)).every(Boolean));
  } finally { done(); }
});
