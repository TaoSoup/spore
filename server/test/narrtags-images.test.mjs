// Narrative tags with pictures (lib/narrtags.mjs, NARRATIVE_IMAGES=on): the coin JSON's picture flag, the image blocks
// of a request (labelled by n, in coin order, none and the request of before byte for byte when off), the spend
// estimate of a picture, reading thumbnails from the image cache with one wait per batch, the empty-coin guard left out
// for a coin sent with its picture, `had_img` stored and migrated, the one re-ask of a page coin answered "none"
// without its picture, and a credit-balance 400 named "billing". Fakes only: no network, no model provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NarrTags, TagEngine, MemoryTagStore, DEFAULT_MODEL, RECHECK_MS, SYSTEM_TEXT, SYSTEM_TEXT_PICTURES, IMAGE_PX, IMG_WAIT_MS,
  coinBlock, buildRequest, estimateInputTokens, imageTokens, classifyError, userText, hasPicture,
} from "../lib/narrtags.mjs";
import { Db } from "../lib/db.mjs";
import { quiet } from "./helpers/tree.mjs";
import { fakeClock, T0 } from "./helpers/chain.mjs";

/** A PNG header of `w` x `h` with a few bytes after it: enough for isPng and imageTokens (never decoded here). */
function png(w = 256, h = w, fill = 7) {
  const b = Buffer.alloc(8 + 25 + 12, fill);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
const keeper = () => { const lines = []; const push = (m) => lines.push(String(m)); return { lines, info: push, warn: push, error: push }; };
const sentCoins = (req) => JSON.parse(userText(req.messages[0]).split("<coins>\n")[1].split("\n</coins>")[0]);
const reply = (coins) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ coins }) }], usage: { input_tokens: 1000, output_tokens: 200 } });
const none = (n) => ({ n, kind: "none", id: 0, title: "", theme: "other" });
const fresh = (n, title, theme = "culture & memes") => ({ n, kind: "new", id: 0, title, theme });
function fakeClient(answer = (req) => reply(sentCoins(req).map((c) => none(c.n)))) {
  const calls = [];
  const f = async () => ({ messages: { create: async (req) => { calls.push({ req }); return answer(req, calls.length); } } });
  f.calls = calls;
  return f;
}
const coin = (mint, o = {}) => ({ mint, name: `${mint} coin`, symbol: mint.toUpperCase(), description: "says what it is about", website: null, twitter: null, post: null, parent: null, asks: 0, ...o });
/** The image blocks of a request's user turn, with the label before each: [[label, base64]]. */
const pictureBlocks = (req) => {
  const c = req.messages[0].content, out = [];
  if (!Array.isArray(c)) return out;
  c.forEach((b, i) => { if (b.type === "image") out.push([c[i - 1].text, b.source.data, b.source.media_type, b.source.type]); });
  return out;
};

/**
 * An image cache in memory: thumbnails by `${w}|${url}`; `make` (url → PNG | null) says what get + thumb would make,
 * `delayMs` how long get takes (Infinity: never answers). Counts gets and thumbs.
 */
function fakeImages({ make = () => null, delayMs = 0 } = {}) {
  const disk = new Map(), calls = { get: [], thumb: [], bytes: 0 };
  return {
    disk, calls,
    put(url, w = IMAGE_PX, b = png(w)) { disk.set(`${w}|${url}`, b); },
    thumbBytes(url, w) { calls.bytes++; return disk.get(`${w}|${url}`) ?? null; },
    async get(url) {
      calls.get.push(url);
      if (delayMs === Infinity) return new Promise(() => {});
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return make(url) ? { file: "x", type: "image/png" } : null;
    },
    async thumb(url, hit, w) { calls.thumb.push([url, w]); const b = make(url); if (b) disk.set(`${w}|${url}`, b); return b ? { file: "x", type: "image/png", thumb: w } : null; },
  };
}
function fakeModel() {
  const m = { coins: new Map(), mints: new Map(), meta: new Map(), images: new Map(), nameOf: (mint) => ({ name: m.mints.get(mint)?.name ?? null, symbol: m.mints.get(mint)?.symbol ?? null }), metaFor: (c) => m.meta.get(c.mint) ?? null, imageOfMint: (mint) => m.images.get(mint) ?? null };
  m.add = (mint, o = {}) => {
    m.coins.set(mint, { mint, quoteMint: null, createdAt: null, tracked: true });
    m.mints.set(mint, { name: o.name ?? `${mint} coin`, symbol: o.symbol ?? mint.toUpperCase(), uri: `uri:${mint}` });
    m.meta.set(mint, { description: "description" in o ? o.description : "says what it is about", twitter: null, website: null });
    if (o.image !== null) m.images.set(mint, o.image ?? `https://img.example/${mint}.png`);
    return mint;
  };
  return m;
}
function tagger(o = {}) {
  const clock = o.clock ?? fakeClock(T0 * 1000), db = o.db ?? new Db(":memory:"), model = o.model ?? fakeModel(), log = o.log ?? keeper();
  const client = o.client ?? fakeClient(), images = o.images === undefined ? fakeImages() : o.images;
  const t = new NarrTags({ model, db, cfg: { on: true, model: DEFAULT_MODEL, dailyUsd: 1, minBuyers: 10, keyFile: null, images: true, imagePx: 256, ...o.cfg }, posts: null, images, clientFactory: client, now: clock.now, perMin: 600, hotFillMs: 0, imgWaitMs: o.imgWaitMs ?? 200, log });
  return { t, clock, db, model, client, images, log };
}

test("coinBlock: picture: true for a coin with a PNG picture, which is then never no_text; the bytes never go into the JSON", () => {
  const p = png();
  const bare = coin("a", { description: null });
  assert.deepEqual(coinBlock(bare, 1), { n: 1, name: "a coin", symbol: "A", no_text: true });
  assert.deepEqual(coinBlock({ ...bare, picture: p }, 1), { n: 1, name: "a coin", symbol: "A", picture: true });
  assert.deepEqual(coinBlock({ ...coin("b"), picture: p }, 2), { n: 2, name: "b coin", symbol: "B", description: "says what it is about", picture: true });
  // not a PNG: no picture
  assert.deepEqual(coinBlock({ ...bare, picture: Buffer.from("GIF89a-not-a-png-at-all-really") }, 1), { n: 1, name: "a coin", symbol: "A", no_text: true });
  assert.deepEqual([hasPicture({ picture: p }), hasPicture({ picture: "x" }), hasPicture(null)], [true, false, false]);
  assert.ok(!JSON.stringify(coinBlock({ ...bare, picture: p }, 1)).includes(p.toString("base64").slice(0, 12)));
});

test("buildRequest: off is the request of before byte for byte; on, each picture follows the coins as a labelled image block, in coin order, before the closing line", () => {
  const narr = [{ id: 1, title: "moo deng the hippo", theme: "animals" }];
  const plain = [coin("a"), coin("b", { description: null }), coin("c")];
  const withPics = [{ ...plain[0], picture: png(256, 256, 1) }, plain[1], { ...plain[2], picture: png(256, 256, 3) }];
  for (const shape of [{ narratives: narr }, { narratives: narr, fresh: [{ id: 2, title: "gta 6", theme: "gaming" }] }, { narratives: [] }]) {
    const before = buildRequest({ coins: plain, ...shape });
    assert.equal(JSON.stringify(buildRequest({ coins: withPics, ...shape })), JSON.stringify(before), "pictures off: nothing of them is sent");
    assert.equal(before.system[0].text, SYSTEM_TEXT);
    // on, but no coin has a picture: the same user turn, the picture instructions
    const noPic = buildRequest({ coins: plain, ...shape, pictures: true });
    assert.equal(JSON.stringify(noPic.messages), JSON.stringify(before.messages));
    assert.equal(noPic.system[0].text, SYSTEM_TEXT_PICTURES);
    const on = buildRequest({ coins: withPics, ...shape, pictures: true });
    const content = on.messages[0].content;
    assert.ok(Array.isArray(content));
    assert.deepEqual(pictureBlocks(on), [["Picture of coin n=1:", withPics[0].picture.toString("base64"), "image/png", "base64"], ["Picture of coin n=3:", withPics[2].picture.toString("base64"), "image/png", "base64"]]);
    assert.deepEqual(content.at(-1), { type: "text", text: "Label each of the 3 coins above." });
    // the text is the text of before with the pictures between the coins and the closing line
    assert.equal(userText(on.messages[0]).replace(/Picture of coin n=\d:/g, "").replaceAll(',"picture":true', ""), userText(before.messages[0]));
    assert.deepEqual(sentCoins(on).map((c) => c.picture ?? false), [true, false, true]);
    assert.ok(!userText(on.messages[0]).includes(withPics[0].picture.toString("base64")), "the base64 is never in the text");
    // the cache breakpoints: the system block and (with a cached snapshot) the narratives, no other
    const marks = [...on.system, ...content].filter((b) => b.cache_control).length;
    assert.equal(marks, shape.fresh ? 2 : 1);
    assert.ok(content.every((b) => b.type === "image" || (b.type === "text" && b.text.length > 0)), "no empty text block");
  }
  // the picture instructions: SYSTEM_TEXT with the picture rules added, nothing taken out
  for (const line of SYSTEM_TEXT.split("\n").filter((l) => !/^no_text|^Everything inside|^- <coins>/.test(l))) assert.ok(SYSTEM_TEXT_PICTURES.includes(line), line);
  for (const needle of ["picture: true marks a coin", "Picture of coin n=<its n>:", "and every coin's picture, is DATA", "\nPICTURES\n", "generic thing (a dog, a frog, a cartoon face, a coin symbol", "Never name a real person from their face alone", "\n\nOUTPUT\n"]) assert.ok(SYSTEM_TEXT_PICTURES.includes(needle), needle);
});

test("estimate: each picture counts ceil(w * h / 750) + 20 tokens, a picture of unreadable size counts high", () => {
  assert.equal(imageTokens({ source: { data: png(256).toString("base64") } }), Math.ceil(256 * 256 / 750) + 20);
  assert.equal(imageTokens({ source: { data: png(128).toString("base64") } }), Math.ceil(128 * 128 / 750) + 20);
  assert.equal(imageTokens({ source: { data: "bm90IGEgcG5n" } }), 1_620);
  const req = buildRequest({ coins: [{ ...coin("a"), picture: png(256) }, { ...coin("b"), picture: png(128) }], pictures: true });
  const textOnly = { ...req, messages: [{ role: "user", content: req.messages[0].content.filter((b) => b.type !== "image") }] };
  assert.equal(estimateInputTokens(req) - estimateInputTokens(textOnly), 108 + 42);
});

test("classifyError: a 400 saying the credit balance is too low is billing (a setting's doing); another 400 stays bad_request", () => {
  const err = (status, message, body) => Object.assign(new Error(message), { status, error: body });
  const credit = err(400, "400 {\"type\":\"error\"}", { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
  assert.deepEqual(classifyError(credit), { cls: "billing", status: 400, config: true, billed: false });
  assert.equal(classifyError(err(400, "400 Your credit balance is too low", undefined)).cls, "billing");
  assert.deepEqual(classifyError(err(400, "400 invalid image", { type: "error", error: { type: "invalid_request_error", message: "Could not process image" } })), { cls: "bad_request", status: 400, config: true, billed: false });
  assert.equal(classifyError(err(500, "credit balance", undefined)).cls, "server_error", "only a 400");
});

test("the empty-coin guard is left out only for a coin sent with its picture; had_img is stored with the answer", async () => {
  const client = fakeClient((req) => reply(sentCoins(req).map((c) => fresh(c.n, "giant golden duck"))));
  const store = new MemoryTagStore();
  const e = new TagEngine({ store, clientFactory: client, now: fakeClock().now, log: quiet, pictures: true });
  const bare = (m, o = {}) => coin(m, { description: null, name: "Quack", symbol: "QQ", ...o });
  const r = await e.tag([bare("pic", { picture: png() }), bare("nopic")]);
  assert.ok(r.ok);
  assert.deepEqual([r.done.get("pic"), r.done.get("nopic"), e.stats.forcedNone, e.stats.imagesSent], [1, null, 1, 1]);
  assert.deepEqual([store.tagGet("pic").hadImg, store.tagGet("nopic").hadImg], [true, false]);
  // an engine with pictures off ignores a picture: guarded, nothing of it sent
  const off = new TagEngine({ store: new MemoryTagStore(), clientFactory: fakeClient((req) => reply(sentCoins(req).map((c) => fresh(c.n, "giant golden duck")))), now: fakeClock().now, log: quiet });
  const r2 = await off.tag([bare("pic", { picture: png() })]);
  assert.deepEqual([r2.done.get("pic"), off.stats.imagesSent, off.store.tagGet("pic").hadImg], [null, 0, false]);
});

test("had_img: on a fresh database, added to one from before it (0 in older rows), round-trips", () => {
  const db = new Db(":memory:");
  assert.ok(db.db.prepare("PRAGMA table_info(coin_tags)").all().some((c) => c.name === "had_img"));
  db.db.exec("ALTER TABLE coin_tags DROP COLUMN had_img");
  db.db.exec("INSERT INTO coin_tags (mint, narrative_id, tagged_at, model, asks, had_post, bare) VALUES ('OLD', NULL, 1, 'm', 1, 0, 1)");
  db.migrate(); db.migrate();
  assert.equal(db.db.prepare("PRAGMA table_info(coin_tags)").all().filter((c) => c.name === "had_img").length, 1);
  assert.deepEqual(db.tagGet("OLD"), { mint: "OLD", narrativeId: null, at: 1, model: "m", asks: 1, hadPost: false, bare: true, hadImg: false });
  db.tagSet({ mint: "NEW", narrativeId: null, at: 2, model: "m", hadImg: true });
  assert.equal(db.tagGet("NEW").hadImg, true);
  db.close();
});

test("a batch reads its pictures from disk, starts the missing ones, waits for them once and sends a coin still without one without it", async () => {
  const model = fakeModel();
  for (const m of ["a", "b", "c", "d"]) model.add(m);
  model.add("e", { image: null }); // no picture at all
  // b's thumbnail is made in time; c's upstream never answers; d's cannot be made
  const images = fakeImages({ make: (url) => (url.endsWith("/b.png") ? png(256, 256, 2) : null), delayMs: 0 });
  const slowGet = images.get.bind(images);
  images.get = (url) => { if (!url.endsWith("/c.png")) return slowGet(url); images.calls.get.push(url); return new Promise(() => {}); };
  images.put("https://img.example/a.png");
  const { t, client, db } = tagger({ model, images, imgWaitMs: 150 });
  for (const m of ["a", "b", "c", "d", "e"]) t.offer(m, 15, { hot: true });
  const t0 = Date.now();
  await t.pump();
  const took = Date.now() - t0;
  assert.equal(client.calls.length, 1);
  const req = client.calls[0].req;
  assert.deepEqual(sentCoins(req).map((c) => [c.symbol, c.picture ?? false]), [["A", true], ["B", true], ["C", false], ["D", false], ["E", false]]);
  assert.deepEqual(pictureBlocks(req).map((p) => p[0]), ["Picture of coin n=1:", "Picture of coin n=2:"]);
  assert.equal(req.system[0].text, SYSTEM_TEXT_PICTURES);
  assert.deepEqual(images.calls.get.sort(), ["https://img.example/b.png", "https://img.example/c.png", "https://img.example/d.png"], "only the missing ones are started; none for a coin without a url");
  assert.ok(took >= 140 && took < 1_000, `one wait for the batch, not one per coin (${took} ms)`);
  assert.deepEqual([db.tagGet("a").hadImg, db.tagGet("b").hadImg, db.tagGet("c").hadImg], [true, true, false]);
  const s = t.snapshot().images;
  assert.deepEqual([s.on, s.px, s.sent, s.missing, s.reasked], [true, 256, 2, 2, 0]);
  assert.ok(s.waitedMs >= 140 && s.waitedMs < 1_000);
  t.stop(); db.close();
});

test("all pictures on disk: no wait; 128 px read when set; pictures off or no image cache: the request of before and nothing read", async () => {
  const model = fakeModel();
  model.add("a"); model.add("b");
  const images = fakeImages();
  images.put("https://img.example/a.png", 128); images.put("https://img.example/b.png", 128);
  const { t, client, db } = tagger({ model, images, cfg: { imagePx: 128 } });
  t.offer("a", 15, { hot: true }); t.offer("b", 15, { hot: true });
  await t.pump();
  assert.deepEqual([pictureBlocks(client.calls[0].req).length, images.calls.get.length, t.snapshot().images.waitedMs, t.snapshot().images.px], [2, 0, 0, 128]);
  t.stop(); db.close();
  for (const o of [{ cfg: { images: false } }, { images: null }]) {
    const m2 = fakeModel(); m2.add("a"); m2.add("b");
    const im = fakeImages(); im.put("https://img.example/a.png");
    const x = tagger({ model: m2, images: o.images === null ? null : im, ...o });
    x.t.offer("a", 15, { hot: true }); x.t.offer("b", 15, { hot: true });
    await x.t.pump();
    const req = x.client.calls[0].req;
    assert.equal(JSON.stringify(req), JSON.stringify(buildRequest({ coins: [coin("a", { name: "a coin" }), coin("b", { name: "b coin" })], narratives: [], fresh: [] })), "byte for byte the request without pictures");
    assert.deepEqual([req.system[0].text === SYSTEM_TEXT, im.calls.bytes, x.t.snapshot().images.on], [true, 0, false]);
    x.t.stop(); x.db.close();
  }
});

test("one re-ask with the picture: a page coin answered none without its picture is asked once more with it; never off the page, never after an ask with it", async () => {
  const model = fakeModel();
  for (const m of ["hot", "cold", "done"]) model.add(m);
  const db = new Db(":memory:");
  const images = fakeImages({ make: () => null });
  const client = fakeClient((req) => reply(sentCoins(req).map((c) => (c.symbol === "HOT" ? fresh(c.n, "giant golden duck") : none(c.n)))));
  const { t, clock } = tagger({ model, db, images, client }); // (made first: it stamps the rules version on the empty database)
  db.tagSet({ mint: "hot", narrativeId: null, at: T0 - 4000, model: DEFAULT_MODEL, asks: 2 });            // settled "none", no picture
  db.tagSet({ mint: "cold", narrativeId: null, at: T0 - 4000, model: DEFAULT_MODEL, asks: 2 });           // the same, off the page
  db.tagSet({ mint: "done", narrativeId: null, at: T0 - 4000, model: DEFAULT_MODEL, asks: 2, hadImg: true }); // asked with its picture
  // the picture is not on disk yet: not asked, its thumbnail started, looked at again only after RECHECK_MS
  t.offer("hot", 15, { hot: true }); t.offer("cold", 15); t.offer("done", 15, { hot: true });
  await t.pump();
  assert.deepEqual([client.calls.length, images.calls.get, t.pending()], [0, ["https://img.example/hot.png"], 0]);
  assert.equal(t.answered("hot"), true, "the page still places it as read");
  images.put("https://img.example/hot.png");
  clock.t += RECHECK_MS - 1;
  t.offer("hot", 15, { hot: true });
  assert.equal(t.pending(), 0, "within RECHECK_MS it is not looked at");
  clock.t += 1;
  t.offer("hot", 15, { hot: true }); t.offer("cold", 15); t.offer("done", 15, { hot: true });
  clock.t += 200_000; // let a batch of the off-page coins go if any were waiting
  await t.pump();
  assert.equal(client.calls.length, 1);
  assert.deepEqual(sentCoins(client.calls[0].req).map((c) => [c.symbol, c.picture ?? false]), [["HOT", true]]);
  assert.deepEqual([db.tagGet("hot").hadImg, db.tagGet("hot").asks, t.tagOf("hot")?.title, t.snapshot().images.reasked], [true, 3, "giant golden duck", 1]);
  // asked with its picture: settled for good (a "none" answer too)
  clock.t += RECHECK_MS;
  t.offer("hot", 15, { hot: true }); t.offer("done", 15, { hot: true });
  await t.pump();
  assert.equal(client.calls.length, 1);
  t.stop(); db.close();
  // pictures off: a stored "none" without a picture is settled as before
  const db2 = new Db(":memory:");
  const im2 = fakeImages(); im2.put("https://img.example/hot.png");
  const off = tagger({ model, db: db2, images: im2, cfg: { images: false } });
  db2.tagSet({ mint: "hot", narrativeId: null, at: T0 - 4000, model: DEFAULT_MODEL, asks: 2 });
  off.t.offer("hot", 15, { hot: true });
  await off.t.pump();
  assert.deepEqual([off.client.calls.length, im2.calls.bytes], [0, 0]);
  off.t.stop(); db2.close();
});

test("IMG_WAIT_MS and IMAGE_PX: one 3 s wait per batch at most, 256 px by default", () => {
  assert.deepEqual([IMG_WAIT_MS, IMAGE_PX], [3_000, 256]);
});

test("a request carrying pictures that is refused (HTTP 400) is not a setting's 30-min pause: its coins go again without their pictures; refused again without them, it is", async () => {
  const model = fakeModel();
  model.add("a"); model.add("b", { image: null });
  const images = fakeImages(); images.put("https://img.example/a.png");
  const refuse = () => { throw Object.assign(new Error("400 {}"), { status: 400, error: { type: "error", error: { type: "invalid_request_error", message: "Could not process image" } } }); };
  let n = 0;
  const client = fakeClient((req) => { n++; if (n === 1) refuse(); return reply(sentCoins(req).map((c) => none(c.n))); });
  const { t, clock, db, log } = tagger({ model, images, client });
  t.offer("a", 15, { hot: true }); t.offer("b", 15, { hot: true });
  await t.pump();
  assert.equal(client.calls.length, 1);
  assert.equal(pictureBlocks(client.calls[0].req).length, 1);
  const paused = t.engine.pausedMs();
  assert.ok(paused > 0 && paused < 1_800_000, `the short pause, not the setting's (${paused} ms)`);
  assert.equal(t.engine.stats.lastError, "bad_request");
  assert.ok(log.lines.every((l) => !/process image/.test(l)), "the provider's words are never logged");
  assert.equal(t.snapshot().images.refused, 1);
  clock.t += paused;
  await t.pump();
  assert.equal(client.calls.length, 2);
  assert.deepEqual([sentCoins(client.calls[1].req).map((c) => c.picture ?? false), pictureBlocks(client.calls[1].req).length], [[false, false], 0]);
  assert.deepEqual([db.tagGet("a").hadImg, t.snapshot().images.reasked], [false, 0]);
  t.stop(); db.close();
  // refused again without a picture: a setting's fault, the 30-min pause as before
  const m2 = fakeModel(); m2.add("a", { image: null });
  const x = tagger({ model: m2, client: fakeClient(refuse) });
  x.t.offer("a", 15, { hot: true });
  await x.t.pump();
  assert.ok(x.t.engine.pausedMs() >= 1_800_000 - 1);
  x.t.stop(); x.db.close();
});

test("a picture re-ask is counted once, when it is answered, not each time its batch is taken", async () => {
  const model = fakeModel(); model.add("hot");
  const db = new Db(":memory:");
  const images = fakeImages(); images.put("https://img.example/hot.png");
  let n = 0;
  const client = fakeClient((req) => { n++; if (n === 1) throw Object.assign(new Error("overloaded"), { status: 529 }); return reply(sentCoins(req).map((c) => none(c.n))); });
  const { t, clock } = tagger({ model, db, images, client });
  db.tagSet({ mint: "hot", narrativeId: null, at: T0 - 4000, model: DEFAULT_MODEL, asks: 2 });
  t.offer("hot", 15, { hot: true });
  await t.pump();
  assert.deepEqual([client.calls.length, t.snapshot().images.reasked], [1, 0]);
  clock.t += t.engine.pausedMs();
  await t.pump();
  assert.deepEqual([client.calls.length, t.snapshot().images.reasked, db.tagGet("hot").hadImg], [2, 1, true]);
  t.stop(); db.close();
});

test("a line-only re-read sent with the picture stores had_img with the line, so the page never says the picture was not read", async () => {
  const { coinStoryLine } = await import("../lib/coin-lines.mjs");
  const model = fakeModel();
  model.add("a", { description: null });
  const db = new Db(":memory:");
  const images = fakeImages(); images.put("https://img.example/a.png");
  const client = fakeClient((req) => reply(sentCoins(req).map((c) => ({ ...fresh(c.n, "another story"), line: { subject: c.name, happened: "", keys: [] } }))));
  const { t } = tagger({ model, db, images, client }); // (made first: it stamps the rules version on the empty database)
  const id = db.narrAdd({ title: "frog story", theme: "animals", key: "frog story", at: T0 - 500 });
  db.tagSet({ mint: "a", narrativeId: id, at: T0 - 400, model: DEFAULT_MODEL, asks: 2 }); // tagged before lines and pictures
  t.tagOf("a"); t.reline("a", 4);
  await t.pump();
  assert.equal(client.calls.length, 1);
  assert.deepEqual(sentCoins(client.calls[0].req).map((c) => [c.symbol, c.picture ?? false]), [["A", true]]);
  assert.deepEqual([db.tagGet("a").narrativeId, db.tagGet("a").lineV, db.tagGet("a").line, db.tagGet("a").hadImg], [id, 2, null, true], "the tag stands; had_img is now set");
  const m = t.storyLineOf("a");
  assert.equal(m.hadImg, true, "the cached answer knows the picture was read");
  const l = coinStoryLine(m, { name: "a coin", symbol: "A", description: null, post: null, image: true });
  assert.equal(l.happened, "Name only: its picture names no clear subject");
  t.stop(); db.close();
});
