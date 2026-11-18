// Linked posts (lib/narrative.mjs): the pure functions (post links in every form the metadata cleaner stores, post
// times, grouping, the events, X's embed answer, the word flag), Narrative.serve on a small family (subjects, the
// parent's timeline, an event's time staying put when its first coin stops being a member, a coin's own post with its
// siblings, `under`, unavailable posts dropping out, which events ask for their text first, the asker's allowance, the
// cache, 30 000-child walks in slices) and GET /api/narrative/:mint. Then Discover
// (lib/discover.mjs): the parents with launches in the last hour, and GET /api/discover. A fake fetch behind the
// post-text fetcher, a fake clock, sqlite in memory. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Narrative, parsePost, postTime, postUrl, groupPosts, eventsOf, parseOembed, flagText, postOf, NEW_S, FAMILY_TTL_MS, FAMILY_CACHE, EVENTS_MAX, EVENTS_KEEP, EVENTS_FIRST, TEXT_MAX } from "../lib/narrative.mjs";
import { Discover, DISCOVER_TTL_MS, PARENTS_MAX, WINDOW_S, BIN_S } from "../lib/discover.mjs";
import { XPosts, RECHECK_DENIED_S, WAIT_AHEAD } from "../lib/xposts.mjs";
import { createApp } from "../lib/api.mjs";
import { loadConfig, DEFAULT_RATES } from "../lib/config.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { SOL_MINT } from "../lib/jupiter.mjs";
import { Db } from "../lib/db.mjs";
import { Model, RECENT_S } from "../lib/model.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";
import { key, fakeClock, T0 } from "./helpers/chain.mjs";

const NOW_S = T0 + 63_400_000;
const HOUR = 3600, DAY = 86_400;
/** A post id made `agoS` before the test's start (snowflake: ms since X's epoch << 22); `n` tells ids of one moment apart. */
const idAt = (agoS = HOUR, n = 0) => String(((BigInt((NOW_S - agoS) * 1000) - 1288834974657n) << 22n) + BigInt(n));
const cp = (...n) => String.fromCodePoint(...n);
/** Mint number `i` of a made-up series (`fill` tells series apart). */
const mintN = (i, fill = 6) => { const b = Buffer.alloc(32, fill); b.writeUInt32BE(i, 28); return new PublicKey(b).toBase58(); };

// ---------------------------------------------------------------- pure functions
test("parsePost: every form a post link is stored in gives the id and nothing else", () => {
  const id = "2120644813917925721";
  for (const url of [
    `https://x.com/tradfi/status/${id}`, `https://twitter.com/tradfi/status/${id}`, `http://x.com/tradfi/status/${id}`,
    `https://www.x.com/tradfi/status/${id}`, `https://www.twitter.com/tradfi/status/${id}`, `https://mobile.twitter.com/tradfi/status/${id}`, `https://mobile.x.com/a/status/${id}`,
    `https://m.twitter.com/tradfi/status/${id}`, `https://m.x.com/tradfi/status/${id}`,
    `https://x.com/tradfi/statuses/${id}`, `https://x.com/i/status/${id}`, `https://x.com/i/web/status/${id}`,
    `https://x.com/tradfi/status/${id}?s=20&t=AbCdEf`, `https://x.com/tradfi/status/${id}/photo/1`, `https://x.com/tradfi/status/${id}/`, `https://x.com/tradfi/status/${id}#m`,
    `https://x.com//tradfi//status//${id}`, `HTTPS://X.COM/TradFi_99/status/${id}`, `https://x.com./tradfi/status/${id}`, `https://x.com:443/tradfi/status/${id}`,
    // what the metadata cleaner makes of a link given without its scheme: "https://x.com/" + the text
    `https://x.com/x.com/tradfi/status/${id}`, `https://x.com/www.x.com/tradfi/status/${id}`, `https://x.com/twitter.com/tradfi/status/${id}`, `https://x.com/mobile.twitter.com/tradfi/status/${id}`,
    `https://x.com/X.com/i/web/status/${id}`,
  ]) assert.deepEqual(parsePost(url), { id }, url);
  assert.deepEqual(parsePost("https://x.com/a/status/9223372036854775807"), { id: "9223372036854775807" }, "the largest id");
  assert.deepEqual(parsePost("https://x.com/a/status/1"), { id: "1" });
  assert.deepEqual(Object.keys(parsePost(`https://x.com/elonmusk/status/${id}`)), ["id"], "the handle in a link is never returned");
});

test("parsePost: everything else is null, hostile input included", () => {
  const id = "2120644813917925721";
  for (const url of [
    null, undefined, 123, 2120644813917925721n, {}, [], [`https://x.com/a/status/${id}`], { toString: () => `https://x.com/a/status/${id}` }, "", " ", "x", id,
    `x.com/a/status/${id}`, `//x.com/a/status/${id}`, `javascript:alert(1)//x.com/a/status/${id}`, `ftp://x.com/a/status/${id}`, `data:text/html,https://x.com/a/status/${id}`,
    `https://x.com.evil.example/a/status/${id}`, `https://evilx.com/a/status/${id}`, `https://notx.com/a/status/${id}`, `https://api.x.com/a/status/${id}`, `https://www.mobile.x.com/a/status/${id}`,
    `https://xn--x-7kc.com/a/status/${id}`, `https://x.co/a/status/${id}`, `https://t.co/abc`, `https://example.com/x.com/a/status/${id}`, `https://example.com/?u=https://x.com/a/status/${id}`,
    `https://user:pw@x.com/a/status/${id}`, `https://user@x.com/a/status/${id}`, `https://x.com@evil.example/a/status/${id}`, `https://x.com:8443/a/status/${id}`, `http://x.com:8080/a/status/${id}`,
    `https://x.com/a/status/0${id}`, `https://x.com/a/status/${id}a`, `https://x.com/a/status/-1`, `https://x.com/a/status/0`, `https://x.com/a/status/12345678901234567890`,
    "https://x.com/a/status/9223372036854775808", "https://x.com/a/status/1e3", "https://x.com/a/status/", "https://x.com/a/status", "https://x.com/a", "https://x.com/", "https://x.com",
    `https://x.com/sixteen_chars_xx/status/${id}`, `https://x.com/bad-handle/status/${id}`, `https://x.com/a%20b/status/${id}`, `https://x.com/a/Status/${id}`, `https://x.com/a/replies/${id}`,
    `https://x.com/i/communities/${id}`, `https://x.com/i/web/${id}`, `https://x.com/i/lists/status/${id}`, `https://x.com/hashtag/status`, `https://x.com/search?q=status/${id}`,
    `https://x.com/x.com/x.com/a/status/${id}`, `https://x.com/example.com/a/status/${id}`, `https://x.com/a/b/status/${id}`,
    `https://x.com/a/status/${id}`.padEnd(3000, "x"), "https://x.com/" + "a/".repeat(5000),
  ]) assert.equal(parsePost(url), null, String(url).slice(0, 80));
});

test("postTime, postUrl, postOf: the time in a snowflake id; ids without one, or from the future, give null; the URL is made from the digits", () => {
  const nowMs = NOW_S * 1000;
  assert.equal(postTime(idAt(0), nowMs), NOW_S);
  assert.equal(postTime(idAt(2 * HOUR, 4_194_303), nowMs), NOW_S - 2 * HOUR, "the low 22 bits are not time");
  assert.equal(postTime("1541815603606036480", nowMs), 1_656_432_460, "a real id: 28 June 2022");
  assert.equal(postTime("30000000000", nowMs), 1_288_834_981, "the first snowflakes");
  for (const bad of ["29999999999", "1", "20", "0", "", "012345678901234567", "1e18", "12345678901234567890", " 1541815603606036480", null, undefined, 1541815603606036480, 1541815603606036480n, {}, ["1541815603606036480"]]) assert.equal(postTime(bad, nowMs), null, String(bad));
  assert.equal(postTime(idAt(-DAY + 5), nowMs), NOW_S + DAY - 5, "a clock a little ahead is fine");
  assert.equal(postTime(idAt(-DAY - 5), nowMs), null, "more than a day after now: made up");
  assert.equal(postTime("9223372036854775807", nowMs), null, "the largest id says the year 2080");
  assert.equal(postUrl("123"), "https://x.com/i/status/123");
  assert.equal(postOf({ twitter: "https://x.com/a/status/5", website: "https://x.com/a/status/6" }), "5", "twitter first");
  assert.equal(postOf({ twitter: "https://x.com/somebody", website: "https://twitter.com/i/status/6" }), "6", "then the website");
  assert.equal(postOf({ twitter: "https://x.com/somebody", website: "https://example.com" }), null);
  assert.equal(postOf({ twitter: null, website: null }), null);
  assert.equal(postOf(null), null);
});

const mem = (mint, postId, over = {}) => ({ mint, key: mint, createdAt: NOW_S - 100, usd: 0, postId, ...over });

test("groupPosts: coins per post, distinct creators (unknown ones together as one), the volume, first and last launch", () => {
  const A = idAt(HOUR, 1), B = idAt(HOUR, 2);
  const g = groupPosts([
    mem("m1", A, { key: "w1", usd: 9000, createdAt: 50 }), mem("m2", A, { key: "w1", usd: 100.5, createdAt: 40 }), mem("m3", A, { key: "w2", usd: 1999, createdAt: 60 }),
    mem("m4", A, { key: null, usd: 1, createdAt: null }), mem("m5", A, { key: null }), mem("m6", A, { key: undefined, usd: NaN }),
    mem("m7", B, { key: "w1", usd: 7 }), mem("m8", null, { key: "w9", usd: 1e6 }), mem("m9", undefined),
  ]);
  assert.deepEqual([...g.keys()], [A, B]);
  assert.deepEqual(g.get(A), { id: A, coins: 6, creators: 3, usd: 11100.5, firstAt: 40, lastAt: NOW_S - 100, mints: ["m1", "m2", "m3", "m4", "m5", "m6"] });
  assert.deepEqual(g.get(B), { id: B, coins: 1, creators: 1, usd: 7, firstAt: NOW_S - 100, lastAt: NOW_S - 100, mints: ["m7"] });
  assert.deepEqual(groupPosts([mem("x", A, { createdAt: null }), mem("y", A, { createdAt: null })]).get(A).firstAt, null, "no coin with a creation time");
  assert.equal(groupPosts([]).size, 0);
  assert.deepEqual(groupPosts([mem("x", A, { key: null })]).get(A).creators, 1, "one coin without a known creator is one creator");
});

test("eventsOf: two creators and a post time admit an event, volume never does; newest first launch first, whatever was traded or however many link it; ties by id; the same order whatever the input order", () => {
  const nowS = NOW_S;
  const g = (id, creators, firstAgo, lastAgo = firstAgo, over = {}) => ({ id, coins: creators, creators, usd: 0, firstAt: firstAgo == null ? null : nowS - firstAgo, lastAt: lastAgo == null ? null : nowS - lastAgo, mints: [], ...over });
  const oldPost = idAt(30 * DAY, 1), busy = idAt(HOUR, 2), long = idAt(3 * HOUR, 3), whale = idAt(HOUR, 5), noTime = "12345", future = idAt(-3 * DAY, 6);
  const tieA = idAt(5 * DAY, 7), tieB = idAt(5 * DAY, 8), noAt = idAt(4 * HOUR, 9);
  const groups = [
    g(long, 2, 2 * HOUR, 300), g(tieB, 3, 3 * HOUR), g(whale, 1, 60, 60, { usd: 9e9, coins: 500 }), g(noTime, 50, 30), g(future, 50, 30),
    g(tieA, 2, 3 * HOUR), g(busy, 9, 3000, 2000, { usd: 9e6, coins: 40 }), g(noAt, 2, null), g(oldPost, 2, 600),
  ];
  const events = eventsOf(new Map(groups.map((x) => [x.id, x])), { nowS });
  assert.deepEqual(events.map((x) => x.id), [oldPost, busy, long, tieA, tieB, noAt], "a month-old post two coins linked ten minutes ago leads; nine creators and millions traded do not move an event");
  assert.ok(!events.some((x) => x.id === whale), "one creator: not admitted, whatever its coins traded");
  assert.ok(!events.some((x) => x.id === noTime || x.id === future), "an id that gives no time is not admitted");
  const by = Object.fromEntries(events.map((x) => [x.id, x]));
  assert.deepEqual([by[long].at, by[long].lastAt, by[long].postAt], [NOW_S - 2 * HOUR, NOW_S - 300, NOW_S - 3 * HOUR]);
  assert.deepEqual([by[oldPost].at, by[oldPost].postAt], [NOW_S - 600, NOW_S - 30 * DAY]);
  assert.deepEqual([by[noAt].at, by[noAt].lastAt, by[noAt].postAt], [NOW_S - 4 * HOUR, NOW_S - 4 * HOUR, NOW_S - 4 * HOUR], "no coin with a creation time: the event stands at the post's time");
  assert.ok(events.every((x) => !("score" in x)), "no score");
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].at >= events[i].at, "times only go back");
  assert.deepEqual(eventsOf([...groups].reverse(), { nowS }).map((x) => x.id), events.map((x) => x.id), "an array, in any order");
  assert.deepEqual(eventsOf(new Map(), { nowS }), []);
});

/** X's oEmbed answer for a post, as publish.x.com sends it. */
const embed = (id, { handle = "tradfi", text = "Hello <a href=\"https://t.co/x\">world</a>" } = {}) => ({
  url: `https://twitter.com/${handle}/status/${id}`, author_name: "Someone Else", author_url: `https://twitter.com/${handle}`,
  html: `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">${text}</p>&mdash; Someone Else (@${handle}) <a href="https://twitter.com/${handle}/status/${id}?ref_src=twsrc%5Etfw">November 17, 2026</a></blockquote>\n`,
  width: 550, height: null, type: "rich", cache_age: "3153600000", provider_name: "Twitter", provider_url: "https://twitter.com", version: "1.0",
});

test("parseOembed: the handle from author_url and the first paragraph as plain text; the display name is not kept; anything that is not this post is null", () => {
  const id = idAt();
  assert.deepEqual(parseOembed(embed(id), id), { handle: "tradfi", text: "Hello world" });
  assert.deepEqual(parseOembed({ url: `https://x.com/i/status/${id}`, author_url: "https://x.com/Trad_Fi9/", html: "<p>ok</p>" }, id), { handle: "Trad_Fi9", text: "ok" });
  assert.deepEqual(parseOembed({ ...embed(id), author_name: "Elon Musk " + cp(0x2705) }, id), { handle: "tradfi", text: "Hello world" }, "no display name in the answer");
  assert.deepEqual(parseOembed(embed(id, { text: "" }), id), { handle: "tradfi", text: "" }, "an empty text is a post of media only");
  for (const [why, j] of [
    ["another post's url", { ...embed(id), url: `https://twitter.com/tradfi/status/${idAt(HOUR, 9)}` }], ["no url", { ...embed(id), url: undefined }], ["a url that is no post", { ...embed(id), url: "https://twitter.com/tradfi" }],
    ["author_url off X", { ...embed(id), author_url: "https://evil.example/tradfi" }], ["author_url with two segments", { ...embed(id), author_url: "https://twitter.com/tradfi/lists" }],
    ["author_url without a handle", { ...embed(id), author_url: "https://twitter.com/" }], ["a handle that is none", { ...embed(id), author_url: "https://twitter.com/not-a-handle" }],
    ["a handle too long", { ...embed(id), author_url: "https://twitter.com/sixteen_chars_xx" }], ["author_url with a login", { ...embed(id), author_url: "https://a:b@twitter.com/tradfi" }],
    ["author_url no string", { ...embed(id), author_url: 5 }], ["html no string", { ...embed(id), html: null }], ["html an object", { ...embed(id), html: { p: "x" } }],
    ["no paragraph", { ...embed(id), html: "<blockquote>text</blockquote>" }], ["a paragraph never closed", { ...embed(id), html: "<p>text" }],
  ]) assert.equal(parseOembed(j, id), null, why);
  for (const bad of [null, undefined, "x", 5, [], true]) assert.equal(parseOembed(bad, id), null);
  assert.equal(parseOembed(embed(id), 5), null);
  assert.equal(parseOembed(embed(id), null), null);
});

test("parseOembed: <br> is a newline, tags go, entities are decoded once, hidden characters are removed, white space is tidied, the text is cut at 600 code points", () => {
  const id = idAt();
  const text = (html) => parseOembed(embed(id, { text: html }), id).text;
  assert.equal(text("Line one<br>line two<br /><BR/><br><br>five"), "Line one\nline two\n\nfive");
  assert.equal(text("a <b>bold</b> <a href=\"https://t.co/abc\" onclick=\"x()\">https://t.co/abc</a> <img src=x onerror=alert(1)>z"), "a bold https://t.co/abc z");
  assert.equal(text("&amp;lt;b&amp;gt; &lt;i&gt; &quot;q&quot; &#39;s&#x27; &apos;"), "&lt;b&gt; <i> \"q\" 's' '", "one pass: &amp;lt; is the text &lt;");
  assert.equal(text("&lt;script&gt;alert(1)&lt;/script&gt;"), "<script>alert(1)</script>", "decoded after the tags went: it is text");
  assert.equal(text("&#128512;&#x1F600; &mdash;&ndash;&hellip; a&nbsp;&nbsp;b &AMP; &unknown; &#0;&#xD800;&#1114112;&#xFFFFFFFF;."), `${cp(0x1f600, 0x1f600)} ${cp(0x2014, 0x2013, 0x2026)} a b & &unknown; .`);
  assert.equal(text("  spaced   out\t\ttabs\nsource\r\nlines  <br>  next  "), "spaced out tabs source lines\nnext");
  const hidden = [0x202e, 0x202d, 0x200b, 0x200e, 0x200f, 0x2066, 0x2069, 0x2028, 0x2029, 0x2060, 0xfeff, 0x061c, 0x07, 0x1b, 0x7f, 0x85, 0x9f, 0xe0041, 0xe007f];
  assert.equal(text(`a${hidden.map((n) => cp(n)).join("b")}c`), `a${"b".repeat(hidden.length - 1)}c`, "bidi overrides, zero-width and tag characters, controls");
  assert.equal(text("&#x202E;evil&#8238;"), "evil", "also when they come as entities");
  const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  assert.equal(text(family), family, "the zero-width joiner stays: emoji need it");
  const long = text(cp(0x1f600).repeat(700));
  assert.deepEqual([Array.from(long).length, long.endsWith(cp(0x2026)), long.isWellFormed()], [TEXT_MAX + 1, true, true], "cut between code points, with an ellipsis");
  assert.equal(Array.from(text("x".repeat(TEXT_MAX))).length, TEXT_MAX, "exactly 600 is not cut");
  assert.equal(text("first</p><p>second"), "first", "the first paragraph only");
  // a hostile body costs a pass, not a rescan per character
  const t0 = performance.now();
  assert.equal(typeof parseOembed({ ...embed(id), html: `<p>${"<".repeat(60_000)}</p>` }, id).text, "string");
  assert.equal(parseOembed({ ...embed(id), html: "<p".repeat(30_000) }, id), null);
  assert.ok(performance.now() - t0 < 500, `${(performance.now() - t0).toFixed(0)} ms`);
});

test("flagText: any single word on the list flags the text, also in mixed case or with characters that draw nothing inside it; words are never joined", () => {
  const isSlur = (w) => w === "badword";
  assert.equal(flagText("this has a BADWORD in it", { isSlur }), true);
  assert.equal(flagText("bad word, bad-word, badwords? no", { isSlur: (w) => w === "badword" }), false, "two words are not one");
  const asked = [];
  flagText("one two one Two", { isSlur: (w) => { asked.push(w); return false; } });
  assert.deepEqual(asked, ["one", "two"], "each distinct word once");
  // The real word splitter cuts at a lower-to-upper border and at every non-ASCII character: the flattened copy keeps the word whole.
  for (const [why, text] of [["mocking case", "a BaDwOrD here"], ["an upper tail", "a badWORD here"], ["zero-width non-joiner", `a bad${cp(0x200c)}word`], ["zero-width joiner", `a ba${cp(0x200d)}dword`],
    ["soft hyphen", `bad${cp(0xad)}word.`], ["variation selector", `b${cp(0xfe0f)}adword`], ["Mongolian vowel separator", `badwor${cp(0x180e)}d`], ["both", `Ba${cp(0x200c)}dWo${cp(0xad)}Rd`]]) {
    assert.equal(flagText(text, { isSlur }), true, why);
  }
  assert.equal(flagText(`bad${cp(0x200c)} word, Bad${cp(0xad)}-Word, bad\nword`, { isSlur }), false, "still two words");
  assert.equal(flagText("BadWord", { isSlur: (w) => w === "bad" }), true, "the words of the text as written are still asked");
  const zwj = `family ${cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)} PumpFun`;
  assert.equal(flagText(zwj), false, "the default list, an emoji sequence");
  assert.equal(parseOembed({ url: `https://x.com/a/status/${idAt()}`, author_url: "https://x.com/a", html: `<p>${zwj}</p>` }, idAt()).text, zwj, "the stored text keeps its joiners");
  assert.equal(flagText("an ordinary post about a senate hearing"), false, "the default list");
  for (const none of ["", null, undefined, 5]) assert.equal(flagText(none, { isSlur: () => true }), false);
  assert.equal(flagText("x y", { isSlur: () => true, wordsOf: () => [] }), false);
});

// ---------------------------------------------------------------- Narrative.serve
const K = Object.fromEntries(["PAR", "K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "KOLD", "KOLDT", "SOLQ", "SOLQ2", "UNT", "AST", "Z1", "Z2", "LONE", "L1", "EMPTY", "E1", "Q", "Q1", "Q2", "NOTIME"].map((n, i) => [n, key(101 + i)]));
const W = Object.fromEntries(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"].map((n, i) => [n, key(201 + i)]));
const A = idAt(2 * HOUR, 1), B = idAt(30 * HOUR, 2), C = idAt(HOUR, 3), D = idAt(3 * HOUR, 4), S = idAt(5 * HOUR, 5), X = idAt(4 * HOUR, 6);

function world({ answer = (id) => json(embed(id, { handle: `h${id.slice(-4)}`, text: `text of ${id}` })), posts = true, opts = {} } = {}) {
  const clock = fakeClock(NOW_S * 1000), db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", now: clock.now, log: quiet });
  model.load(); model.setSolUsd(100);
  const calls = [];
  const fetch = async (url) => { const id = new URL(url).searchParams.get("url").split("/").pop(); calls.push(id); return w.answer(id, calls.length); };
  const xposts = posts ? new XPosts({ perMin: 600, db, fetch, now: clock.now, sleep: clock.sleep, log: quiet, timeoutMs: 50, ...opts }) : null;
  const narr = new Narrative({ model, posts: xposts, now: clock.now, log: quiet });
  let seq = 0;
  const w = { clock, db, model, xposts, narr, calls, answer };
  /** A coin with its mint and metadata; `post`: its metadata's twitter; `trades` trades of `usd` each, `ago` s back. */
  w.coin = (mint, symbol, { parent = null, name = `${symbol} coin`, post = null, website = null, launcher = null, shares = null, createdAgo = HOUR, tracked = true, trades = 0, usd = 10, ago = 600 } = {}) => {
    model.upsertCoin({ mint, curve: `C_${symbol}`, depth: parent ? 1 : 0, quoteMint: parent, ...base, virtualQuoteReserves: "100000000000", createdAt: NOW_S - createdAgo, launcher, shares, sharesAt: shares ? 1 : 0, tracked });
    model.setMint({ mint, decimals: 6, tokenProgram: T22, name, symbol, uri: `https://ipfs.io/ipfs/${symbol}`, onchainAt: 1 });
    model.setMeta(`https://ipfs.io/ipfs/${symbol}`, { image: `https://ipfs.io/ipfs/img-${symbol}`, description: null, twitter: post, telegram: null, website, fetchedAt: 1, ok: true });
    for (let i = 0; i < trades; i++) model.recordTrade({ sig: `S${seq++}`, mint, idx: 0, slot: seq, time: NOW_S - ago, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "2", priceQuote: 2, priceUsd: 2e-5, valueUsd: usd });
  };
  /** The coin ref a body carries: what the server's other bodies give (model.ref), with the 24 h volume. */
  w.ref = (mint, usd24) => { const r = model.ref(model.get(mint)); return { mint, name: r.name, symbol: r.symbol, image: r.image, usd24 }; };
  w.settle = async () => { await xposts?.idle(); };
  w.close = () => { narr.stop(); db.close(); };
  return w;
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const link = (id, handle = "anyone") => `https://x.com/${handle}/status/${id}`;

/**
 * PAR (a SOL coin) with children: K1-K4 link post A (three creators; launched 2 h to 1 h ago; KOLD linked it before
 * them, so the event stands at KOLD's launch), K5, K6 and KOLDT link B
 * (three creators; KOLDT 30 days ago, the others 1 h ago: the event stands at its first launch, so after A), K7
 * links C alone, K8 links nothing, K9 is untracked, KOLD is old and untraded (no member: it gives A its time and nothing else). AST is a listed asset (no
 * coin) with Z1 and Z2 linking D. SOLQ is a SOL coin with a post, SOLQ2 one quoted in SOL's mint, UNT an untracked coin.
 */
function family(w) {
  w.coin(K.PAR, "PAR", { createdAgo: 90 * DAY, post: "https://x.com/par_official" });
  w.coin(K.K1, "K1", { parent: K.PAR, name: "Jensen Huang", post: link(A, "alice"), launcher: W.w1, trades: 3, usd: 100 });
  w.coin(K.K2, "K2", { parent: K.PAR, name: "jensen cat", post: `https://twitter.com/bob/status/${A}?s=20`, launcher: W.w2, trades: 1, usd: 50, ago: 2 * HOUR });
  w.coin(K.K3, "K3", { parent: K.PAR, name: "JENSEN", post: "https://x.com/somebody", website: `https://x.com/i/status/${A}`, launcher: W.w3 });
  w.coin(K.K4, "K4", { parent: K.PAR, name: "Jensen again", post: `https://x.com/x.com/carol/status/${A}`, launcher: W.w1, trades: 1, usd: 20, createdAgo: 2 * HOUR });
  w.coin(K.K5, "K5", { parent: K.PAR, name: "Senate hearing", post: link(B), launcher: W.w4, trades: 1, usd: 500 });
  w.coin(K.K6, "K6", { parent: K.PAR, name: "senate", post: link(B), launcher: W.w5 });
  w.coin(K.K7, "K7", { parent: K.PAR, post: link(C), launcher: W.w6, trades: 2, usd: 40_000 });
  w.coin(K.K8, "K8", { parent: K.PAR, launcher: W.w7 });
  w.coin(K.K9, "K9", { parent: K.PAR, post: link(A), launcher: W.w8, tracked: false, trades: 5, usd: 999 });
  w.coin(K.KOLD, "KOLD", { parent: K.PAR, post: link(A), launcher: W.w8, createdAgo: NEW_S + 60 });
  w.coin(K.KOLDT, "KOLDT", { parent: K.PAR, name: "Senate cat", post: link(B), shares: [{ address: PLATFORM, bps: 5000 }, { address: W.w7, bps: 5000 }], createdAgo: 30 * DAY, trades: 1, usd: 10 });
  w.model.setMint({ mint: K.AST, decimals: 6, tokenProgram: T22, name: "Nvidia xStock", symbol: "NVDAx", onchainAt: 1 });
  w.coin(K.Z1, "Z1", { parent: K.AST, post: link(D), launcher: W.w1, trades: 1, usd: 7 });
  w.coin(K.Z2, "Z2", { parent: K.AST, post: link(D), launcher: W.w2 });
  w.coin(K.SOLQ, "SOLQ", { post: link(S), launcher: W.w1 });
  w.coin(K.SOLQ2, "SOLQ2", { parent: SOL_MINT, post: link(S), launcher: W.w2 });
  w.coin(K.UNT, "UNT", { post: link(A), tracked: false });
  return w;
}
/** When the first and the last coin linking a family post was created (s before the test's start). */
const LAUNCHED = { [A]: [NEW_S + 60, HOUR], [B]: [30 * DAY, HOUR], [D]: [HOUR, HOUR], [X]: [HOUR, HOUR] };
const item = (w, id, coins, usd24, top, s = { state: "ok", handle: `h${id.slice(-4)}`, text: `text of ${id}` }) => ({ id, url: `https://x.com/i/status/${id}`, at: NOW_S - LAUNCHED[id][0], lastAt: NOW_S - LAUNCHED[id][1], postAt: postTime(id, NOW_S * 1000), coins, usd24, ...s, top: top.map(([m, u]) => w.ref(m, u)) });
const WAIT = { state: "wait", handle: null, text: null }, IDLE = { state: "idle", handle: null, text: null };

test("serve: who is a subject: a tracked coin or a mint with children; never SOL, an untracked coin without children or an unknown mint", async () => {
  const w = family(world());
  assert.ok(w.model.children.has(SOL_MINT), "a coin is quoted in SOL's mint");
  for (const [why, mint] of [["SOL", SOL_MINT], ["untracked", K.UNT], ["untracked child", K.K9], ["unknown", key(250)], ["no string", null], ["no string", 5]]) assert.equal(await w.narr.serve(mint), null, why);
  const leaf = await w.narr.serve(K.K8, { mayQueue: () => false });
  assert.deepEqual([leaf.mint, leaf.asOf, leaf.members, leaf.linked, leaf.events, leaf.earlier, leaf.own], [K.K8, NOW_S, 0, 0, [], 0, null]);
  const asset = await w.narr.serve(K.AST, { mayQueue: () => false });
  assert.deepEqual([asset.mint, asset.members, asset.linked, asset.events.map((p) => p.id), asset.earlier, asset.own, asset.under], [K.AST, 2, 2, [D], 0, null, null], "a listed asset: no coin, but coins are quoted in it");
  assert.deepEqual(Object.keys(asset), ["mint", "asOf", "members", "linked", "events", "earlier", "own", "under", "pending"]);
  assert.deepEqual(Object.keys(asset.events[0]), ["id", "url", "at", "lastAt", "postAt", "coins", "usd24", "state", "handle", "text", "top"]);
  assert.equal(w.narr.snapshot().served, 2, "refusals are not counted");
  // A coin look-up caches the asset as an untracked coin (it is a pump.fun coin too): still a subject through its
  // children, and nothing of that record is read (its own post link, its parent).
  w.coin(K.AST, "NVDAx", { name: "Nvidia xStock", parent: K.PAR, post: link(A), tracked: false });
  assert.equal(w.model.get(K.AST).tracked, false);
  for (const late of [false, true]) {
    if (late) w.clock.t += FAMILY_TTL_MS;
    const again = await w.narr.serve(K.AST, { mayQueue: () => false });
    assert.deepEqual({ ...again, asOf: 0 }, { ...asset, asOf: 0 }, late ? "after a new walk" : "from the cached walk");
  }
  const child = await w.narr.serve(K.Z1, { mayQueue: () => false });
  assert.deepEqual([child.own.id, child.own.siblings, child.own.parent.mint], [D, 1, K.AST]);
  w.model.children.set(K.UNT, new Set());
  assert.equal(await w.narr.serve(K.UNT), null, "an untracked coin whose children set is empty");
  w.close();
});

test("serve: a parent lists the posts two or more creators link as events, newest first launch first, with their coins and volume; texts arrive (\"wait\", then \"ok\"); every link form counts; coin refs are the API's", async () => {
  const w = family(world());
  let asked = 0;
  const mayQueue = () => { asked++; return true; };
  const first = await w.narr.serve(K.PAR, { mayQueue });
  const topA = [[K.K1, 300], [K.K2, 50], [K.K4, 20]], topB = [[K.K5, 500], [K.KOLDT, 10], [K.K6, 0]];
  assert.deepEqual(first, {
    mint: K.PAR, asOf: NOW_S, members: 9, linked: 8,
    events: [item(w, A, 4, 370, topA, WAIT), item(w, B, 3, 510, topB, WAIT)],
    earlier: 0, own: null, under: null, pending: true,
  });
  assert.equal(asked, 2, "one ask per post about to be fetched");
  assert.deepEqual((await w.narr.serve(K.PAR, { mayQueue })).events.map((p) => p.state), ["wait", "wait"]);
  assert.equal(asked, 2, "already in line: the allowance is not asked again");
  await w.settle();
  const body = await w.narr.serve(K.PAR, { mayQueue });
  assert.deepEqual(body.events, [item(w, A, 4, 370, topA), item(w, B, 3, 510, topB)]);
  assert.deepEqual([body.pending, asked, w.calls], [false, 2, [A, B]]);
  assert.deepEqual([body.events[0].at, body.events[0].lastAt, body.events[0].postAt], [NOW_S - NEW_S - 60, NOW_S - HOUR, NOW_S - 2 * HOUR], "KOLD linked it first, 72 h ago: no member any more, but the event keeps its time; the last member an hour ago");
  assert.deepEqual([body.events[1].at, body.events[1].lastAt, body.events[1].postAt], [NOW_S - 30 * DAY, NOW_S - HOUR, NOW_S - 30 * HOUR], "the post's own time is kept beside the launches'");
  assert.ok(!("posts" in body) && !("words" in body));
  // the refs: name, symbol and the proxied logo exactly as /api/coin gives them
  const ref = body.events[0].top[0], view = w.model.view(w.model.get(K.K1));
  assert.deepEqual([ref.name, ref.symbol, ref.image], [view.name, view.symbol, view.image]);
  assert.equal(ref.image, `/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/img-K1")}`);
  assert.ok(!JSON.stringify(body).includes("alice") && !JSON.stringify(body).includes("carol") && !JSON.stringify(body).includes("par_official"), "no handle from a link reaches the body");
  assert.ok(!JSON.stringify(body).includes(W.w1), "no creator address either");
  assert.ok(!body.events.some((p) => p.id === C), "one creator's post is no event, whatever its coin traded");
  w.close();
});

test("serve: a coin's own post, the siblings under its parent that link the same one (without itself) and their best three; no parent, no siblings", async () => {
  const w = family(world());
  const k1 = await w.narr.serve(K.K1);
  assert.deepEqual(k1.own, { id: A, url: `https://x.com/i/status/${A}`, at: NOW_S - 2 * HOUR, ...WAIT, siblings: 3, top: [w.ref(K.K2, 50), w.ref(K.K4, 20), w.ref(K.K3, 0)], parent: { mint: K.PAR, name: "PAR coin", symbol: "PAR" } });
  assert.deepEqual([k1.events, k1.earlier, k1.under, k1.pending, k1.members], [[], 0, null, true, 0]);
  await w.settle();
  const again = (await w.narr.serve(K.K1)).own;
  assert.deepEqual([again.state, again.handle, again.text], ["ok", `h${A.slice(-4)}`, `text of ${A}`]);
  const k3 = (await w.narr.serve(K.K3)).own;
  assert.deepEqual([k3.id, k3.siblings, k3.top.map((t) => t.mint)], [A, 3, [K.K1, K.K2, K.K4]], "the post from the website field");
  const old = (await w.narr.serve(K.KOLD)).own;
  assert.deepEqual([old.id, old.siblings, old.top.map((t) => t.mint)], [A, 4, [K.K1, K.K2, K.K4]], "a coin that is no member itself still sees the members linking its post");
  const k7 = (await w.narr.serve(K.K7)).own;
  assert.deepEqual([k7.id, k7.siblings, k7.top, k7.parent.mint], [C, 0, [], K.PAR], "alone with its post");
  const z1 = (await w.narr.serve(K.Z1)).own;
  assert.deepEqual([z1.id, z1.siblings, z1.top, z1.parent], [D, 1, [w.ref(K.Z2, 0)], { mint: K.AST, name: "Nvidia xStock", symbol: "NVDAx" }], "under a listed asset");
  const builds = w.narr.snapshot().builds;
  for (const mint of [K.SOLQ, K.SOLQ2]) {
    const own = (await w.narr.serve(mint)).own;
    assert.deepEqual([own.id, own.siblings, own.top, own.parent], [S, null, [], null], "priced in SOL: no parent");
  }
  assert.equal(w.narr.snapshot().builds, builds, "and no walk over SOL's coins");
  const par = await w.narr.serve(K.PAR);
  assert.deepEqual([par.own, par.under], [null, null], "a profile link is no post");
  w.close();
});

test("serve: `under`: a coin without a post and without events of its own children points at its parent's newest listed event", async () => {
  const w = family(world());
  w.coin(K.LONE, "LONE"); w.coin(K.L1, "L1", { parent: K.LONE });
  const k8 = await w.narr.serve(K.K8);
  assert.deepEqual([k8.own, k8.events], [null, []]);
  assert.deepEqual(k8.under, { mint: K.PAR, name: "PAR coin", symbol: "PAR", event: item(w, A, 4, 370, [[K.K1, 300], [K.K2, 50], [K.K4, 20]], WAIT) });
  assert.ok(!("post" in k8.under));
  assert.equal(k8.pending, true);
  await w.settle();
  const settled = await w.narr.serve(K.K8);
  assert.deepEqual([settled.under.event.state, settled.under.event.text, settled.pending], ["ok", `text of ${A}`, false]);
  assert.deepEqual(w.calls, [A], "only the post shown was fetched");
  // the newest event whose post X shows: with A unavailable it is B
  const noA = new Narrative({ model: w.model, posts: stubPosts({ records: new Map([[A, { id: A, state: "none", handle: null, text: null }]]), canQueue: () => "cached" }), now: w.clock.now, log: quiet });
  assert.deepEqual([(await noA.serve(K.K8)).under.event.id, (await noA.serve(K.K8)).under.event.at], [B, NOW_S - 30 * DAY]);
  assert.equal((await w.narr.serve(K.L1)).under, null, "a parent without an event");
  assert.equal((await w.narr.serve(K.K1)).under, null, "a coin with its own post has no `under`");
  assert.equal((await w.narr.serve(K.SOLQ)).under, null);
  // a coin whose children link posts shows those, not its parent's
  w.coin(K.Q, "Q", { parent: K.PAR, launcher: W.w7 });
  w.coin(K.Q1, "Q1", { parent: K.Q, post: link(X), launcher: W.w1 }); w.coin(K.Q2, "Q2", { parent: K.Q, post: link(X), launcher: W.w2 });
  const q = await w.narr.serve(K.Q);
  assert.deepEqual([q.events.map((p) => p.id), q.own, q.under], [[X], null, null]);
  w.close();
});

test("serve: the events are a timeline: ordered by when their first coin was launched, never by volume, creators or the post's age; at most EVENTS_MAX listed, the rest counted in `earlier`", async () => {
  const w = world({ posts: false });
  w.coin(K.PAR, "PAR", { createdAgo: 90 * DAY });
  const oldPost = idAt(20 * DAY, 1), busy = idAt(HOUR, 2), wide = idAt(3 * HOUR, 3);
  let c = 0;
  const kid = (post, createdAgo, over = {}) => { w.coin(mintN(c, 5), `T${c}`, { parent: K.PAR, post: link(post), launcher: `L${c}`, createdAgo, ...over }); c++; };
  kid(wide, 2 * HOUR); kid(wide, 2 * HOUR - 60); kid(wide, 100); kid(wide, 90); kid(wide, 80); kid(wide, 70);   // six creators, first two hours ago
  kid(busy, 40 * 60, { trades: 5, usd: 90_000 }); kid(busy, 30 * 60, { trades: 9, usd: 1_000 }); kid(busy, 20 * 60); // heavily traded, first 40 min ago
  kid(oldPost, 5 * 60); kid(oldPost, 3 * 60);                                                                    // a 20-day-old post, first 5 min ago
  const body = await w.narr.serve(K.PAR);
  assert.deepEqual(body.events.map((e) => [e.id, NOW_S - e.at, NOW_S - e.lastAt, NOW_S - e.postAt, e.coins]), [
    [oldPost, 5 * 60, 3 * 60, 20 * DAY, 2], [busy, 40 * 60, 20 * 60, HOUR, 3], [wide, 2 * HOUR, 70, 3 * HOUR, 6],
  ]);
  assert.deepEqual([body.earlier, body.events[1].usd24], [0, 459_000]);
  w.close();
  // more events than a body lists, and more than an entry keeps
  const big = world({ posts: false });
  const n = EVENTS_KEEP + 3, ids = ladder(big, n);
  const all = await big.narr.serve(K.PAR);
  assert.deepEqual([all.events.map((e) => ids.indexOf(e.id)), all.earlier], [Array.from({ length: EVENTS_MAX }, (_, i) => i), n - EVENTS_MAX]);
  for (let i = 1; i < all.events.length; i++) assert.ok(all.events[i - 1].at > all.events[i].at, "newest first, no time out of place");
  assert.deepEqual([EVENTS_MAX, EVENTS_KEEP], [12, 30]);
  // X shows none of the newest 20: the list goes on with the next ones the entry kept; `earlier` is only what lies
  // behind the kept ones, never the 20 newer posts that were dropped
  const stub = stubPosts({ records: new Map(ids.slice(0, 20).map((id) => [id, { id, state: "none", handle: null, text: null }])), canQueue: () => "cached" });
  const rest = await new Narrative({ model: big.model, posts: stub, now: big.clock.now, log: quiet }).serve(K.PAR);
  assert.deepEqual([rest.events.map((e) => ids.indexOf(e.id)), rest.earlier], [Array.from({ length: EVENTS_KEEP - 20 }, (_, i) => 20 + i), n - EVENTS_KEEP]);
  assert.equal(stub.log.filter((l) => l.startsWith("peek")).length, EVENTS_KEEP, "only the kept events are looked at");
  big.close();
});

/** A parent with `n` events: post i is linked by two coins of two creators, launched 10 + i minutes ago (so event 0 is the newest). */
function ladder(w, n = EVENTS_MAX + 2) {
  w.coin(K.PAR, "PAR", { createdAgo: 90 * DAY });
  const ids = Array.from({ length: n }, (_, i) => idAt(2 * HOUR, 100 + i));
  ids.forEach((id, i) => { for (let k = 0; k < 2; k++) w.coin(mintN(2 * i + k), `C${2 * i + k}`, { parent: K.PAR, post: link(id), launcher: `L${2 * i + k}`, createdAgo: (10 + i) * 60 + k }); });
  return ids;
}

test("serve: a post X does not show (\"none\") drops out and the next event takes its place; it is asked again when its recheck is due", async () => {
  const w = world();
  const ids = ladder(w);
  const N = EVENTS_MAX, all = (from, state) => Array.from({ length: N }, (_, i) => [from + i, typeof state === "function" ? state(from + i) : state]);
  const gone = new Set([ids[0], ids[1]]);
  w.answer = (id) => (gone.has(id) ? json({}, id === ids[0] ? 404 : 403) : json(embed(id, { text: `text of ${id}` })));
  let asked = 0;
  const mayQueue = () => { asked++; return true; };
  const serve = () => w.narr.serve(K.PAR, { mayQueue });
  const statesOf = (body) => body.events.map((p) => [ids.indexOf(p.id), p.state]);
  const states = async () => statesOf(await serve());
  const first = await serve();
  // one in flight and WAIT_AHEAD in line read "wait"; the one behind them is queued too, and reads "idle" until it is near
  assert.deepEqual(statesOf(first), all(0, (i) => (i <= WAIT_AHEAD ? "wait" : "idle")), `the newest ${EVENTS_MAX}`);
  assert.equal(WAIT_AHEAD, 10);
  assert.equal(first.earlier, 2, "two events older than the last line");
  await w.settle();
  const second = await serve();
  assert.deepEqual(statesOf(second), all(2, (i) => (i < N ? "ok" : "wait")), "the two unavailable ones dropped out, the next two are fetched");
  assert.equal(second.earlier, 0, "the list now ends at the oldest event: the two dropped ones are newer than every line and are not called earlier");
  assert.equal(asked, N + 2);
  await w.settle();
  const body = await serve();
  assert.deepEqual([body.events.map((p) => ids.indexOf(p.id)), body.events.every((p) => p.state === "ok"), body.earlier, body.pending, asked, w.calls.length], [all(2, 0).map(([i]) => i), true, 0, false, N + 2, N + 2]);
  // six hours on the refused post is due again: it is asked for once more, and shown again when X shows it
  gone.delete(ids[1]);
  w.clock.t += (RECHECK_DENIED_S + 1) * 1000;
  assert.deepEqual((await states()).map(([i]) => i), all(2, 0).map(([i]) => i), "still dropped while its recheck runs");
  assert.equal(asked, N + 3);
  await w.settle();
  assert.deepEqual(w.calls.slice(N + 2), [ids[1]]);
  w.clock.t += FAMILY_TTL_MS;
  assert.deepEqual(await states(), all(1, "ok"), "back at its place");
  assert.deepEqual([asked, w.calls.length], [N + 3, N + 3], "the 404 is not due for 7 days");
  w.close();
});

/** A fetcher stand-in that records what Narrative asks of it, in order. */
function stubPosts({ records = new Map(), canQueue = () => "ok" } = {}) {
  const log = [];
  const queued = new Set();
  return {
    log, queued,
    peek: (id) => { log.push(`peek ${id}`); return records.get(id) ?? null; },
    canQueue: (id, { low = false } = {}) => { const r = queued.has(id) ? "queued" : canQueue(id, low); log.push(`can ${id} ${low ? "low" : "top"} ${r}`); return r; },
    want: (id, { low = false } = {}) => { log.push(`want ${id} ${low ? "low" : "top"}`); queued.add(id); return "ok"; },
    state: (id) => (queued.has(id) ? "wait" : "idle"),
    snapshot: () => ({ stub: true }), start() {}, stop() {},
  };
}

test("serve: an event's time is the first tracked coin that linked the post, also when that coin is no member any more: it does not move when the coin goes quiet or trades again", async () => {
  const P = idAt(5 * DAY, 1), ONE = idAt(6 * DAY, 2);
  const make = (oldTrades) => {
    const w = world({ posts: false });
    w.coin(K.PAR, "PAR", { createdAgo: 90 * DAY });
    w.coin(K.K1, "K1", { parent: K.PAR, post: link(P), launcher: W.w1, createdAgo: 4 * DAY, trades: oldTrades, usd: 7 }); // the first to link P
    w.coin(K.K2, "K2", { parent: K.PAR, post: link(P), launcher: W.w2, createdAgo: 100 });
    w.coin(K.K3, "K3", { parent: K.PAR, post: link(P), launcher: W.w3, createdAgo: 50 });
    w.coin(K.K4, "K4", { parent: K.PAR, post: link(P), launcher: W.w4, createdAgo: 9 * DAY, tracked: false }); // untracked: never read
    w.coin(K.K5, "K5", { parent: K.PAR, post: link(ONE), launcher: W.w5, createdAgo: 4 * DAY });                // quiet coins alone make no event
    w.coin(K.K6, "K6", { parent: K.PAR, post: link(ONE), launcher: W.w6, createdAgo: 5 * DAY });
    w.coin(K.K7, "K7", { parent: K.PAR, post: link(ONE), launcher: W.w7, createdAgo: 60 });
    return w;
  };
  const active = make(1), quietW = make(0);
  const a = await active.narr.serve(K.PAR), q = await quietW.narr.serve(K.PAR);
  assert.deepEqual([a.members, a.linked, a.events.map((e) => [e.id, NOW_S - e.at, NOW_S - e.lastAt, e.coins, e.usd24])], [4, 4, [[P, 4 * DAY, 50, 3, 7]]], "while its first coin trades");
  assert.deepEqual([q.members, q.linked, q.events.map((e) => [e.id, NOW_S - e.at, NOW_S - e.lastAt, e.coins, e.usd24])], [3, 3, [[P, 4 * DAY, 50, 2, 0]]], "the coin went quiet: the same time, and only the members are counted");
  assert.ok(!q.events.some((e) => e.id === ONE), "one member links it: no event, however many quiet coins did");
  // one small trade on the old coin: it is a member again, and the event has not moved
  quietW.model.recordTrade({ sig: "DUST", mint: K.K1, idx: 0, slot: 1, time: NOW_S - 5, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "2", priceQuote: 2, priceUsd: 2e-5, valueUsd: 0.01 });
  quietW.clock.t += FAMILY_TTL_MS;
  const again = await quietW.narr.serve(K.PAR);
  assert.deepEqual([again.members, again.events.map((e) => [e.id, e.at, e.coins])], [4, [[P, q.events[0].at, 3]]]);
  active.close(); quietW.close();
});

test("serve: only the first EVENTS_FIRST listed events ask for their text at full priority, the ones after them as low; a dropped post does not use up a first place", async () => {
  const w = world({ posts: false });
  const ids = ladder(w);
  const wants = (stub) => stub.log.filter((l) => l.startsWith("want")).map((l) => { const [, id, cls] = l.split(" "); return [ids.indexOf(id), cls]; });
  let stub = stubPosts(), asked = 0;
  const body = await new Narrative({ model: w.model, posts: stub, now: w.clock.now, log: quiet }).serve(K.PAR, { mayQueue: () => { asked++; return true; } });
  assert.equal(EVENTS_FIRST, 5);
  assert.deepEqual(wants(stub), Array.from({ length: EVENTS_MAX }, (_, i) => [i, i < EVENTS_FIRST ? "top" : "low"]));
  assert.deepEqual([body.events.length, asked], [EVENTS_MAX, EVENTS_MAX], "every id queued still costs the asker one of its allowance, whatever its class");
  // the fetcher refuses low requests (half its line is taken): the first five are fetched, the others are links
  stub = stubPosts({ canQueue: (id, low) => (low ? "busy" : "ok") }); asked = 0;
  const half = await new Narrative({ model: w.model, posts: stub, now: w.clock.now, log: quiet }).serve(K.PAR, { mayQueue: () => { asked++; return true; } });
  assert.deepEqual([half.events.map((p) => p.state), asked], [[...Array(EVENTS_FIRST).fill("wait"), ...Array(EVENTS_MAX - EVENTS_FIRST).fill("idle")], EVENTS_FIRST], "a refused low request spends no allowance");
  // the two newest are known to be unavailable: the five first lines are events 2 to 6
  stub = stubPosts({ records: new Map(ids.slice(0, 2).map((id) => [id, { id, state: "none", handle: null, text: null }])), canQueue: (id) => (ids.indexOf(id) < 2 ? "cached" : "ok") });
  await new Narrative({ model: w.model, posts: stub, now: w.clock.now, log: quiet }).serve(K.PAR);
  assert.deepEqual(wants(stub), Array.from({ length: EVENTS_MAX }, (_, i) => [i + 2, i < EVENTS_FIRST ? "top" : "low"]));
  // `under` asks for the parent's newest event: one line, full priority
  w.coin(K.K8, "K8", { parent: K.PAR, launcher: W.w7 });
  stub = stubPosts();
  const kid = await new Narrative({ model: w.model, posts: stub, now: w.clock.now, log: quiet }).serve(K.K8);
  assert.deepEqual([kid.under.event.id, wants(stub)], [ids[0], [[0, "top"]]]);
  w.close();
});

test("serve: the asker's allowance is asked once per id about to be queued, after the fetcher's own refusals, and not at all when the fetcher refuses", async () => {
  const w = world({ posts: false });
  const ids = ladder(w);
  // refused by the asker's allowance: nothing queued, the posts are listed without text
  let stub = stubPosts(), asked = 0;
  let narr = new Narrative({ model: w.model, posts: stub, now: w.clock.now, log: quiet });
  let body = await narr.serve(K.PAR, { mayQueue: () => { asked++; return false; } });
  assert.deepEqual([body.events.map((p) => p.state), body.pending, asked], [Array(EVENTS_MAX).fill("idle"), false, EVENTS_MAX]);
  assert.ok(!stub.log.some((l) => l.startsWith("want")));
  assert.deepEqual(stub.log.slice(0, 2), [`peek ${ids[0]}`, `can ${ids[0]} top ok`], "the record, then the fetcher's word");
  // allowed twice, then refused: two are fetched
  asked = 0; stub = stubPosts();
  narr = new Narrative({ model: w.model, posts: stub, now: w.clock.now, log: quiet });
  body = await narr.serve(K.PAR, { mayQueue: () => ++asked <= 2 });
  assert.deepEqual([body.events.map((p) => p.state), body.pending, asked], [["wait", "wait", ...Array(EVENTS_MAX - 2).fill("idle")], true, EVENTS_MAX]);
  assert.deepEqual(stub.log.filter((l) => l.startsWith("want")), [`want ${ids[0]} top`, `want ${ids[1]} top`]);
  // the fetcher refuses (a pause, the day's budget, a failed id, an id in line): the allowance is not spent
  for (const word of ["busy", "budget", "retry", "queued", "cached", "stopped"]) {
    asked = 0; stub = stubPosts({ canQueue: () => word });
    narr = new Narrative({ model: w.model, posts: stub, now: w.clock.now, log: quiet });
    body = await narr.serve(K.PAR, { mayQueue: () => { asked++; return true; } });
    assert.deepEqual([asked, body.events.length, body.events.every((p) => p.state === "idle"), stub.log.filter((l) => l.startsWith("peek")).length, stub.log.filter((l) => l.startsWith("want")).length], [0, EVENTS_MAX, true, EVENTS_MAX, 0], word);
  }
  w.close();
});

test("serve: a coin's own post is asked for as low when no sibling links it or its id gives no time; a post that is both own and listed is asked for once", async () => {
  const w = family(world({ posts: false }));
  w.coin(K.NOTIME, "NOTIME", { parent: K.PAR, post: link("12345"), launcher: W.w1 });
  w.coin(K.E1, "E1", { parent: K.PAR, post: link("12345"), launcher: W.w2 }); // a second creator: still never an event
  const run = async (mint) => { const stub = stubPosts(); const narr = new Narrative({ model: w.model, posts: stub, now: w.clock.now, log: quiet }); return { body: await narr.serve(mint), log: stub.log }; };
  const k1 = await run(K.K1);
  assert.deepEqual(k1.log, [`peek ${A}`, `can ${A} top ok`, `want ${A} top`], "siblings link it: the top class");
  const k7 = await run(K.K7);
  assert.deepEqual(k7.log, [`peek ${C}`, `can ${C} low ok`, `want ${C} low`], "nobody else links it: low");
  const solq = await run(K.SOLQ);
  assert.deepEqual(solq.log, [`peek ${S}`, `can ${S} low ok`, `want ${S} low`], "no parent: low");
  const nt = await run(K.NOTIME);
  assert.deepEqual([nt.body.own.id, nt.body.own.at, nt.body.own.siblings, nt.body.own.state], ["12345", null, 1, "wait"]);
  assert.deepEqual(nt.log, ["peek 12345", "can 12345 low ok", "want 12345 low"], "an id without a time: low, though a sibling links it");
  const par = await run(K.PAR);
  assert.ok(!par.log.some((l) => l.includes("12345")), "and never fetched for the parent's list: it is no event");
  assert.deepEqual([par.body.events.map((p) => p.id), par.body.earlier], [[A, B], 0]);
  // Q links X itself and so do two of its children: X is in `events` and is `own`
  w.coin(K.Q, "Q", { parent: K.PAR, post: link(X), launcher: W.w7 });
  w.coin(K.Q1, "Q1", { parent: K.Q, post: link(X), launcher: W.w1 }); w.coin(K.Q2, "Q2", { parent: K.Q, post: link(X), launcher: W.w2 });
  const q = await run(K.Q);
  assert.deepEqual([q.body.events.map((p) => p.id), q.body.own.id, q.body.own.state, q.body.events[0].state, q.body.pending], [[X], X, "wait", "wait", true]);
  assert.deepEqual(q.log, [`peek ${X}`, `can ${X} top ok`, `want ${X} top`], "one look, one ask");
  // stored records: text only with "ok"; a flagged post has its handle and an empty text; a fetcher that throws reads "idle"
  const records = new Map([[A, { id: A, state: "ok", handle: "real", text: "", flagged: true }], [B, { id: B, state: "none", handle: null, text: null }]]);
  const stub = stubPosts({ records, canQueue: () => "cached" });
  const body = await new Narrative({ model: w.model, posts: stub, now: w.clock.now, log: quiet }).serve(K.PAR);
  assert.deepEqual([body.events.map((p) => [p.id, p.state, p.handle, p.text]), body.earlier], [[[A, "ok", "real", ""]], 0], "a dropped post is not counted: nothing lies behind the events looked at");
  const broken = { peek: () => { throw new Error("database is closed"); }, canQueue: () => "ok", want: () => "ok", state: () => "wait" };
  const warned = [];
  const b2 = await new Narrative({ model: w.model, posts: broken, now: w.clock.now, log: { warn: (s) => warned.push(s) } }).serve(K.PAR);
  assert.deepEqual([b2.events.map((p) => p.state), b2.pending, warned.length], [["idle", "idle"], false, 2]);
  w.close();
});

test("serve: without a fetcher (NARRATIVE_POSTS=0) the posts are listed as links: \"idle\", no handle, no text, nothing pending", async () => {
  const w = family(world({ posts: false }));
  let asked = 0;
  const body = await w.narr.serve(K.PAR, { mayQueue: () => { asked++; return true; } });
  assert.deepEqual(body.events, [item(w, A, 4, 370, [[K.K1, 300], [K.K2, 50], [K.K4, 20]], IDLE), item(w, B, 3, 510, [[K.K5, 500], [K.KOLDT, 10], [K.K6, 0]], IDLE)]);
  assert.deepEqual([body.pending, asked, w.narr.snapshot().posts], [false, 0, null]);
  assert.deepEqual((await w.narr.serve(K.K1)).own.state, "idle");
  w.narr.start(); w.narr.stop(); w.narr.stop();
  w.close();
});

test("serve: one walk per family for FAMILY_TTL_MS, shared by askers that come together; a leaf costs none; at most FAMILY_CACHE entries", async () => {
  const w = family(world({ posts: false }));
  const snap = () => { const s = w.narr.snapshot(); return [s.builds, s.cached]; };
  const [a, b, c] = await Promise.all([w.narr.serve(K.PAR), w.narr.serve(K.PAR), w.narr.serve(K.K1)]);
  assert.deepEqual([a.members, b.members, c.own.siblings, snap()], [9, 9, 3, [1, 1]], "three askers, one walk over PAR's children");
  await w.narr.serve(K.K8); await w.narr.serve(K.K2);
  assert.deepEqual(snap(), [1, 1], "a leaf is not walked or cached; its parent's entry is reused");
  w.coin(key(240), "NEW", { parent: K.PAR, post: link(A), launcher: key(241) });
  w.clock.t += FAMILY_TTL_MS - 1;
  assert.deepEqual([(await w.narr.serve(K.PAR)).members, snap()], [9, [1, 1]], "within the 30 s the entry is served as it is");
  w.clock.t += 1;
  const fresh = await w.narr.serve(K.PAR);
  assert.deepEqual([fresh.members, fresh.events[0].coins, snap()], [10, 5, [2, 1]]);
  assert.ok(w.narr.snapshot().lastBuildMs >= 0 && w.narr.snapshot().maxSliceMs >= 0);
  // more subjects than the cache holds: the oldest entry goes
  const parents = Array.from({ length: FAMILY_CACHE + 1 }, (_, i) => { const b = Buffer.alloc(32, 9); b.writeUInt16BE(i, 30); return new PublicKey(b).toBase58(); });
  w.db.transaction(() => parents.forEach((p, i) => { const b = Buffer.alloc(32, 8); b.writeUInt16BE(i, 30); w.model.upsertCoin({ mint: new PublicKey(b).toBase58(), curve: `CC${i}`, depth: 0, quoteMint: p, ...base, virtualQuoteReserves: "1", createdAt: NOW_S }); }));
  const before = w.narr.snapshot().builds;
  for (const p of parents) assert.equal((await w.narr.serve(p)).members, 1);
  assert.deepEqual([w.narr.snapshot().cached, w.narr.snapshot().builds - before], [FAMILY_CACHE, FAMILY_CACHE + 1]);
  await w.narr.serve(parents[FAMILY_CACHE]);
  assert.equal(w.narr.snapshot().builds - before, FAMILY_CACHE + 1, "the newest is cached");
  await w.narr.serve(parents[0]);
  assert.equal(w.narr.snapshot().builds - before, FAMILY_CACHE + 2, "the oldest was evicted and is walked again");
  w.close();
});

/**
 * PAR with `n` children. `live` = n: all are members (created in the last 70 h, a third traded), 70 % link one of 4 000
 * posts. Fewer: only the first `live` are, the others are 30 days old and untraded (no members), and all link one of
 * 40 posts, so every post is linked by live and by dead coins.
 */
function crowd(w, N, live = N) {
  const mintOf = (i) => mintN(i, 7);
  const vocab = ["jensen", "senate", "cat", "doge", "moon", "nvidia", "huang", "leather", "jacket", "chip", "frog", "pepe", "eagle", "gold", "rocket"];
  w.coin(K.PAR, "PAR", { createdAgo: 90 * DAY });
  w.db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const m = mintOf(i);
      w.model.upsertCoin({ mint: m, curve: `C${i}`, depth: 1, quoteMint: K.PAR, ...base, virtualQuoteReserves: "100000000000", createdAt: i < live ? NOW_S - (i % 5000) * 50 : NOW_S - 30 * DAY - i, launcher: mintOf(1_000_000 + (i % 9000)) });
      w.model.setMint({ mint: m, decimals: 6, tokenProgram: T22, name: `${vocab[i % 15]} ${vocab[(i * 7) % 15]} ${i}`, symbol: `S${i % 977}`, uri: `https://ipfs.io/ipfs/u${i}`, onchainAt: 1 });
      w.model.setMeta(`https://ipfs.io/ipfs/u${i}`, { image: `https://ipfs.io/ipfs/i${i}`, description: null, twitter: i % 10 < 7 ? link(live < N ? idAt(40 * DAY, i % 40) : idAt(HOUR + (i % 4000), i % 4000), `u${i % 50}`) : `https://x.com/u${i}`, telegram: null, website: null, fetchedAt: 1, ok: true });
      if (i % 3 === 0 && i < live) w.model.recordTrade({ sig: `P${i}`, mint: m, idx: 0, slot: i, time: NOW_S - 100, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "2", priceQuote: 2, priceUsd: 2e-5, valueUsd: 10 + (i % 100) });
    }
  });
}
/** One serve of PAR with a 1 ms timer running through the build: the longest stretch it could not fire in is how long the loop was held. */
async function timed(w) {
  let last = performance.now(), maxGap = 0;
  const iv = setInterval(() => { const now = performance.now(); if (now - last > maxGap) maxGap = now - last; last = now; }, 1);
  const t0 = performance.now();
  const body = await w.narr.serve(K.PAR);
  const wall = performance.now() - t0;
  clearInterval(iv);
  const s = w.narr.snapshot();
  return { body, s, line: `build ${s.lastBuildMs} ms of CPU, longest slice ${s.maxSliceMs} ms, ${wall.toFixed(1)} ms wall, longest gap between timer ticks ${maxGap.toFixed(1)} ms` };
}

test("serve: a 30 000-child family is walked in slices: the event loop is never held long", async (t) => {
  const w = world({ posts: false });
  const N = 30_000;
  crowd(w, N);
  const { body, s, line } = await timed(w);
  t.diagnostic(`30 000 children, all members: ${line}`);
  assert.deepEqual([body.members, body.linked, body.events.length, body.earlier > 1_000], [N, 21_000, EVENTS_MAX, true]);
  for (let i = 1; i < body.events.length; i++) assert.ok(body.events[i - 1].at >= body.events[i].at);
  // Generous: an unsliced walk would be one slice of the whole build (80 ms and more here). The timer gap is printed only: other test files run beside this one.
  assert.ok(s.maxSliceMs < 50, `longest slice ${s.maxSliceMs} ms`);
  w.close();
});

test("serve: 30 000 children of which 100 are members: the dead ones are read for the events' times only, in slices as short", async (t) => {
  const w = world({ posts: false });
  const N = 30_000, LIVE = 100;
  crowd(w, N, LIVE);
  const { body, s, line } = await timed(w);
  t.diagnostic(`30 000 children, ${LIVE} members: ${line}`);
  assert.deepEqual([body.members, body.linked, body.events.length], [LIVE, 70, EVENTS_MAX]);
  assert.ok(s.maxSliceMs < 50, `longest slice ${s.maxSliceMs} ms`);
  w.close();
});

// ---------------------------------------------------------------- GET /api/narrative/:mint
async function serveApp(w, { narrative = w.narr, rates = null, log = quiet } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spore-narr-api-"));
  const hub = new EventHub({ heartbeatMs: 200 });
  const app = createApp({ model: w.model, indexer: { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }) }, rpc: { call: async () => { throw new Error("no chain in this test"); } }, hub, images: new ImageCache(dir), meta: null,
    platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log, narrative, rates, now: w.clock.now });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (p, headers = {}) => fetch(url + p, { headers }).then(async (r) => { const text = await r.text(); return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null }; }),
    close: async () => { await new Promise((r) => server.close(r)); hub.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("GET /api/narrative/:mint: 400 for no mint, 404 for no subject (and without the subsystem); never cached while pending, 30 s when every text is known, 5 s while one is listed unfetched", async () => {
  const w = family(world());
  const app = await serveApp(w);
  try {
    for (const bad of ["nope", "123", `${K.PAR}x`, "0OIl"]) {
      const r = await app.get(`/api/narrative/${bad}`);
      assert.deepEqual([r.status, r.body], [400, { error: "invalid mint" }], bad);
    }
    for (const mint of [key(250), K.UNT, SOL_MINT]) {
      const r = await app.get(`/api/narrative/${mint}`);
      assert.deepEqual([r.status, r.body], [404, { error: "unknown mint" }], mint);
    }
    const pending = await app.get(`/api/narrative/${K.PAR}`);
    assert.deepEqual([pending.status, pending.body.pending, pending.body.events.map((p) => p.state), pending.headers.get("cache-control")], [200, true, ["wait", "wait"], "no-store"]);
    await w.settle();
    const done = await app.get(`/api/narrative/${K.PAR}`);
    assert.deepEqual([done.status, done.body.pending, done.body.events.map((p) => p.state), done.headers.get("cache-control")], [200, false, ["ok", "ok"], "public, max-age=30, stale-while-revalidate=120"]);
    assert.deepEqual(done.body, JSON.parse(JSON.stringify(await w.narr.serve(K.PAR))), "the body is serve()'s");
    assert.equal(done.body.events[0].url, `https://x.com/i/status/${A}`);
    const etag = done.headers.get("etag");
    assert.equal((await app.get(`/api/narrative/${K.PAR}`, { "if-none-match": etag })).status, 304);
    const health = (await app.get("/api/health")).body;
    assert.deepEqual([health.narrative.served > 0, health.narrative.builds, health.narrative.cached, health.narrative.posts.callsToday, health.narrative.posts.cached], [true, 1, 1, 2, 2]);
  } finally { await app.close(); }
  // without the subsystem (NARRATIVE=0, or an app built without it): 404, and health says null
  const bare = await serveApp(w, { narrative: null });
  try {
    assert.deepEqual([(await bare.get(`/api/narrative/${K.PAR}`)).status, (await bare.get(`/api/narrative/${K.PAR}`)).body], [404, { error: "unknown mint" }]);
    assert.equal((await bare.get("/api/narrative/nope")).status, 400);
    assert.equal((await bare.get("/api/health")).body.narrative, null);
  } finally { await bare.close(); }
  // without the fetcher every post is "idle": cached 5 s
  const links = await serveApp(w, { narrative: new Narrative({ model: w.model, posts: null, now: w.clock.now, log: quiet }) });
  try {
    const r = await links.get(`/api/narrative/${K.PAR}`);
    assert.deepEqual([r.status, r.body.pending, r.body.events.map((p) => p.state), r.headers.get("cache-control")], [200, false, ["idle", "idle"], "public, max-age=5, stale-while-revalidate=5"]);
    const leaf = await links.get(`/api/narrative/${K.K8}`);
    assert.deepEqual([leaf.body.under.event.state, leaf.headers.get("cache-control")], ["idle", "public, max-age=5, stale-while-revalidate=5"], "an idle post under `under` counts too");
    const own = await links.get(`/api/narrative/${K.K7}`);
    assert.deepEqual([own.body.own.state, own.headers.get("cache-control")], ["idle", "public, max-age=5, stale-while-revalidate=5"]);
    const empty = await links.get(`/api/narrative/${K.UNT.slice(0, -1)}`);
    assert.ok(empty.status === 400 || empty.status === 404);
    w.coin(K.EMPTY, "EMPTY");
    const none = await links.get(`/api/narrative/${K.EMPTY}`);
    assert.deepEqual([none.status, none.body.events, none.body.own, none.body.under, none.headers.get("cache-control")], [200, [], null, null, "public, max-age=30, stale-while-revalidate=120"], "nothing to fetch: 30 s");
  } finally { await links.close(); }
  w.close();
});

test("GET /api/narrative/:mint: RATE_NARRNEW caps the fetches one IP starts and is never a 429; a failure answers an empty body and a warning", async () => {
  const w = family(world());
  const app = await serveApp(w, { rates: { narrnew: { limit: 1, windowMs: 3_600_000 } } });
  try {
    const first = await app.get(`/api/narrative/${K.PAR}`);
    assert.deepEqual([first.status, first.body.events.map((p) => p.state), first.headers.get("cache-control")], [200, ["wait", "idle"], "no-store"]);
    await w.settle();
    for (let i = 0; i < 3; i++) {
      const r = await app.get(`/api/narrative/${K.PAR}`);
      assert.deepEqual([r.status, r.body.events.map((p) => p.state), r.headers.get("cache-control")], [200, ["ok", "idle"], "public, max-age=5, stale-while-revalidate=5"]);
    }
    await w.settle();
    assert.deepEqual(w.calls, [A], "one fetch for this IP in the window");
    w.clock.t += 3_600_000;
    assert.deepEqual((await app.get(`/api/narrative/${K.PAR}`)).body.events.map((p) => p.state), ["ok", "wait"], "the next window");
    await w.settle();
  } finally { await app.close(); }
  const warned = [];
  const failing = await serveApp(w, { narrative: { serve: async () => { throw new Error("boom"); }, snapshot: () => ({}) }, log: { ...quiet, warn: (s) => warned.push(s) } });
  try {
    const r = await failing.get(`/api/narrative/${K.PAR}`);
    assert.deepEqual([r.status, r.body], [200, { mint: K.PAR, asOf: Math.floor(w.clock.now() / 1000), members: 0, linked: 0, events: [], earlier: 0, own: null, under: null, pending: false }]);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.ok(warned.some((s) => /narrative .*boom/.test(s)));
  } finally { await failing.close(); }
  w.close();
});

test("config: NARRATIVE, NARRATIVE_POSTS, XPOST_PER_MIN, XPOST_DAILY and RATE_NARRNEW: defaults, overrides, and what is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-narr-cfg-"));
  const load = (env = {}) => loadConfig({ DATA_DIR: join(dir, "data"), META_DIR: join(dir, "meta"), ...env }, { here: dir });
  try {
    const c = load();
    assert.deepEqual(c.narrative, { enabled: true, posts: true, perMin: 20, daily: 3000 });
    assert.deepEqual([DEFAULT_RATES.narrnew, c.rates.narrnew], [[120, 3_600_000], { limit: 120, windowMs: 3_600_000 }]);
    const o = load({ NARRATIVE: "0", NARRATIVE_POSTS: "no", XPOST_PER_MIN: "5", XPOST_DAILY: "0", RATE_NARRNEW: "7" });
    assert.deepEqual([o.narrative, o.rates.narrnew.limit], [{ enabled: false, posts: false, perMin: 5, daily: 0 }, 7]);
    for (const bad of [{ XPOST_PER_MIN: "0" }, { XPOST_PER_MIN: "121" }, { XPOST_DAILY: "-1" }, { XPOST_DAILY: "1.5" }, { NARRATIVE: "maybe" }, { NARRATIVE_POSTS: "2" }, { RATE_NARRNEW: "0" }]) {
      assert.throws(() => load(bad), new RegExp(Object.keys(bad)[0]), JSON.stringify(bad));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- Discover
const P = Object.fromEntries(["P1", "P2", "P3", "P4", "P5", "P6", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "D1", "D2", "E1", "E2", "F1", "F2", "S1", "S2", "R1", "R2"].map((n, i) => [n, key(30 + i)]));

/**
 * Parents with coins launched around the test's start. P1 (a coin): five tracked children of three addresses inside
 * the hour, placed on the bin edges, and three that do not count (exactly an hour old, untracked, three hours old).
 * P2 (a listed asset, no coin): two children of two addresses, one 30 s ahead of the clock, one two minutes ahead
 * (left out). P3: three children of one address. P4: two children without a known address. P5: one without, one with.
 * P6: like P5 in numbers. Two coins priced in SOL's mint and two roots.
 */
function launches(w) {
  for (const p of ["P1", "P3", "P4", "P5", "P6"]) w.coin(P[p], p, { createdAgo: 90 * DAY });
  w.model.setMint({ mint: P.P2, decimals: 6, tokenProgram: T22, name: "Nvidia xStock", symbol: "NVDAx", onchainAt: 1 });
  w.model.setAssetIcons({ [P.P2]: "https://static.example/nvdax.png" });
  w.coin(P.A1, "A1", { parent: P.P1, launcher: W.w1, createdAgo: 0, trades: 2, usd: 50 });
  w.coin(P.A2, "A2", { parent: P.P1, launcher: W.w2, createdAgo: BIN_S - 1 });
  w.coin(P.A3, "A3", { parent: P.P1, launcher: W.w1, createdAgo: BIN_S, trades: 1, usd: 0.004 });
  w.coin(P.A4, "A4", { parent: P.P1, launcher: W.w3, createdAgo: WINDOW_S - 1, trades: 1, usd: 250 });
  w.coin(P.A5, "A5", { parent: P.P1, launcher: W.w4, createdAgo: WINDOW_S, trades: 1, usd: 9_000 });
  w.coin(P.A6, "A6", { parent: P.P1, launcher: W.w5, createdAgo: 10, tracked: false, trades: 1, usd: 9_000 });
  w.coin(P.A7, "A7", { parent: P.P1, launcher: W.w6, createdAgo: 3 * HOUR, trades: 1, usd: 9_000 });
  w.coin(P.A8, "A8", { parent: P.P1, launcher: W.w3, createdAgo: 1800, trades: 1, usd: 7 });
  w.coin(P.B1, "B1", { parent: P.P2, launcher: W.w1, createdAgo: 60 });
  w.coin(P.B2, "B2", { parent: P.P2, launcher: W.w2, createdAgo: 2 * BIN_S + 1 });
  w.coin(P.B3, "B3", { parent: P.P2, launcher: W.w3, createdAgo: -30 });
  w.coin(P.B4, "B4", { parent: P.P2, launcher: W.w4, createdAgo: -120 });
  for (const c of ["C1", "C2", "C3"]) w.coin(P[c], c, { parent: P.P3, launcher: W.w1, createdAgo: 100, trades: 1, usd: 500 });
  w.coin(P.D1, "D1", { parent: P.P4, createdAgo: 100 }); w.coin(P.D2, "D2", { parent: P.P4, createdAgo: 200 });
  w.coin(P.E1, "E1", { parent: P.P5, createdAgo: 100 }); w.coin(P.E2, "E2", { parent: P.P5, launcher: W.w1, createdAgo: 200, trades: 1, usd: 5 });
  w.coin(P.F1, "F1", { parent: P.P6, launcher: W.w1, createdAgo: 100, trades: 1, usd: 5 }); w.coin(P.F2, "F2", { parent: P.P6, shares: [{ address: PLATFORM, bps: 5000 }, { address: W.w2, bps: 5000 }], createdAgo: 200 });
  w.coin(P.S1, "S1", { parent: SOL_MINT, launcher: W.w1, createdAgo: 100 }); w.coin(P.S2, "S2", { parent: SOL_MINT, launcher: W.w2, createdAgo: 100 });
  w.coin(P.R1, "R1", { launcher: W.w1, createdAgo: 100 }); w.coin(P.R2, "R2", { launcher: W.w2, createdAgo: 100 });
  w.disc = new Discover({ model: w.model, now: w.clock.now });
  return w;
}
const pref = (w, mint) => { const { name, symbol } = w.model.nameOf(mint); return { mint, name, symbol }; };

test("discover: the parents with two or more new coins of two or more addresses in the last hour; new1h, then volume, then the mint; bins oldest first; SOL never; refs are the API's", async () => {
  const w = launches(world({ posts: false }));
  assert.ok(w.model.children.get(SOL_MINT).size >= 2, "coins are quoted in SOL's mint");
  const body = await w.disc.serve();
  const tie = [P.P5, P.P6].sort();
  assert.deepEqual([body.asOf, body.windowS, body.binS], [NOW_S, 3600, 300]);
  assert.deepEqual(Object.keys(body), ["asOf", "windowS", "binS", "parents"]);
  assert.deepEqual(body.parents.map((p) => p.mint), [P.P1, P.P2, ...tie], "P3 (one address), P4 (no known address: one creator together), SOL and the roots are not listed");
  const [p1, p2] = body.parents, by = Object.fromEntries(body.parents.map((p) => [p.mint, p]));
  assert.deepEqual(p1, {
    ...pref(w, P.P1), image: `/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/img-P1")}`,
    new1h: 5, creators1h: 3, bins: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 2], usd24: 357,
    top: [w.ref(P.A4, 250), w.ref(P.A1, 100)],
  }, "A4 at 3 599 s is in the oldest bin, A3 at 300 s in the one before the last, A1 and A2 (0 and 299 s) in the last; A3's 0.004 is in no top");
  assert.deepEqual(Object.keys(p1), ["mint", "name", "symbol", "image", "new1h", "creators1h", "bins", "usd24", "top"]);
  assert.deepEqual(p2, { ...pref(w, P.P2), image: `/api/img?u=${encodeURIComponent("https://static.example/nvdax.png")}`, new1h: 3, creators1h: 3, bins: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2], usd24: 0, top: [] },
    "a listed asset: its stored icon; a coin 30 s ahead of our clock counts as now, one two minutes ahead is left out; 601 s is two bins back");
  assert.deepEqual([by[P.P5].new1h, by[P.P5].creators1h, by[P.P5].usd24, by[P.P5].top], [2, 2, 5, [w.ref(P.E2, 5)]], "an unknown address and a known one are two");
  assert.deepEqual([by[P.P6].creators1h, by[P.P6].top.map((t) => t.mint)], [2, [P.F1]], "the address from the fee shares counts like a launcher");
  for (const p of body.parents) {
    assert.deepEqual([p.bins.length, p.bins.reduce((a, b) => a + b, 0)], [12, p.new1h]);
    assert.ok(p.new1h >= 2 && p.creators1h >= 2 && p.top.length <= 2 && p.top.every((t) => t.usd24 > 0));
  }
  assert.ok(!JSON.stringify(body).includes(W.w1) && !JSON.stringify(body).includes(SOL_MINT), "no creator address, no SOL");
  const s = w.disc.snapshot();
  assert.deepEqual([s.builds, s.served, s.lastCoins, s.lastParents], [1, 1, 17, 4], "the pass counted the new non-SOL children only");
  // order: more launches first, then more volume, then the mint
  w.coin(key(90), "G1", { parent: P.P6, launcher: W.w3, createdAgo: 10 });
  w.model.upsertCoin({ mint: P.A6, tracked: true }); // tracked only now: it joins the hour
  w.clock.t += DISCOVER_TTL_MS;
  const next = await w.disc.serve();
  assert.deepEqual(next.parents.map((p) => [p.mint, p.new1h, p.usd24]), [[P.P1, 5, 9_107], [P.P6, 3, 5], [P.P2, 3, 0], [P.P5, 2, 5]], "ten seconds on A4 has left the hour and A6 joined; P6 and P2 both have three, the traded one first");
  assert.deepEqual([next.parents[0].creators1h, next.parents[0].top.map((t) => t.mint)], [4, [P.A6, P.A1]]);
  w.close();
});

test("discover: among parents with as many launches the more traded comes first, then the mint; at most PARENTS_MAX", async () => {
  const w = world({ posts: false });
  const N = PARENTS_MAX + 5, parents = Array.from({ length: N }, (_, i) => mintN(i, 3));
  w.db.transaction(() => parents.forEach((p, i) => {
    for (let k = 0; k < 2; k++) w.coin(mintN(2 * i + k, 4), `N${2 * i + k}`, { parent: p, launcher: `L${k}`, createdAgo: 60, trades: i === 7 && k === 0 ? 1 : 0, usd: 3 });
  }));
  const body = await new Discover({ model: w.model, now: w.clock.now }).serve();
  assert.equal(body.parents.length, PARENTS_MAX);
  assert.deepEqual(body.parents.map((p) => p.mint), [parents[7], ...parents.filter((_, i) => i !== 7).sort().slice(0, PARENTS_MAX - 1)]);
  assert.deepEqual([body.parents[0].name, body.parents[0].image], [null, null], "a parent we know only as a mint coins are priced in");
  w.close();
});

test("discover: one pass shared by askers that come together and served for 10 s; the hour moves on; the by-time index is kept as coins are indexed and forgets old ones", async () => {
  const w = launches(world({ posts: false }));
  const [a, b, c] = await Promise.all([w.disc.serve(), w.disc.serve(), w.disc.serve()]);
  assert.ok(a === b && b === c, "one body");
  assert.deepEqual([w.disc.snapshot().builds, w.disc.snapshot().served], [1, 3]);
  w.coin(key(91), "G2", { parent: P.P3, launcher: W.w2, createdAgo: 5 });
  w.clock.t += DISCOVER_TTL_MS - 1;
  assert.ok(await w.disc.serve() === a, "within the 10 s the body is served as it is");
  assert.equal(w.disc.snapshot().builds, 1);
  w.clock.t += 1;
  const fresh = await w.disc.serve();
  assert.deepEqual([w.disc.snapshot().builds, fresh.asOf, fresh.parents[0].mint, fresh.parents[0].new1h, fresh.parents[0].creators1h, fresh.parents[0].usd24], [2, NOW_S + 10, P.P3, 4, 2, 1500], "a second address made P3 a listed parent");
  assert.equal(DISCOVER_TTL_MS, 10_000);
  // The index: what a restart reads back from the database is the same set; a coin whose creation time turns out old leaves it.
  const again = new Model(w.db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", now: w.clock.now, log: quiet });
  again.load();
  assert.deepEqual([...again.recent.keys()].sort(), [...w.model.recent.keys()].sort());
  assert.ok(w.model.recent.has(P.A5) && !w.model.recent.has(P.A7) && !w.model.recent.has(P.P1) && !w.model.recent.has(P.A6), "a coin an hour old is held (RECENT_S is two); one three hours old, a 90-day-old one and an untracked one never join");
  w.model.upsertCoin({ mint: P.B1, createdAt: NOW_S - 30 * DAY });
  assert.ok(!w.model.recent.has(P.B1));
  // 20 minutes on: the coins still in the hour stand four bins further back
  w.clock.t += 20 * 60_000 - 10_000;
  const later = await w.disc.serve();
  const p1 = later.parents.find((p) => p.mint === P.P1);
  assert.deepEqual([p1.new1h, p1.bins], [4, [0, 1, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0]], "A4 left the hour; A8, A3, and A1 with A2 moved four bins back");
  // past the hour nothing is listed; past RECENT_S the index is empty again
  w.clock.t += WINDOW_S * 1000;
  assert.deepEqual((await w.disc.serve()).parents, []);
  w.clock.t += RECENT_S * 1000;
  await w.disc.serve();
  assert.equal(w.model.recent.size, 0);
  w.close();
});

test("discover: 20 000 coins launched in the hour are counted in slices: the event loop is never held long, and old coins are not walked", async (t) => {
  const w = world({ posts: false });
  const N = 20_000, OLD = 5_000, PARENTS = 400;
  w.db.transaction(() => {
    for (let i = 0; i < N + OLD; i++) {
      const m = mintN(i, 7), old = i >= N;
      w.model.upsertCoin({ mint: m, curve: `C${i}`, depth: 1, quoteMint: mintN(i % PARENTS, 2), ...base, virtualQuoteReserves: "100000000000", createdAt: old ? NOW_S - 5 * DAY - i : NOW_S - (i % 3600), launcher: mintN(1_000_000 + (i % 9000), 1) });
      if (i % 4 === 0) w.model.recordTrade({ sig: `P${i}`, mint: m, idx: 0, slot: i, time: NOW_S - 100, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "2", priceQuote: 2, priceUsd: 2e-5, valueUsd: 10 + (i % 100) });
    }
  });
  assert.equal(w.model.recent.size, N, "the index holds the new coins only");
  const disc = new Discover({ model: w.model, now: w.clock.now });
  let last = performance.now(), maxGap = 0;
  const iv = setInterval(() => { const now = performance.now(); if (now - last > maxGap) maxGap = now - last; last = now; }, 1);
  const t0 = performance.now();
  const body = await disc.serve();
  const wall = performance.now() - t0;
  clearInterval(iv);
  const s = disc.snapshot();
  t.diagnostic(`20 000 new coins under 400 parents (+ 5 000 old): build ${s.lastBuildMs} ms of CPU, longest slice ${s.maxSliceMs} ms, ${wall.toFixed(1)} ms wall, longest gap between timer ticks ${maxGap.toFixed(1)} ms`);
  assert.deepEqual([s.lastCoins, s.lastParents, body.parents.length], [N, PARENTS, PARENTS_MAX]);
  assert.ok(body.parents.every((p) => p.new1h === N / PARENTS && p.bins.reduce((a, b) => a + b, 0) === p.new1h && p.top.length === 2));
  for (let i = 1; i < body.parents.length; i++) assert.ok(body.parents[i - 1].usd24 >= body.parents[i].usd24, "as many launches each: the more traded first");
  // One turn of the scheduler is 8 ms (SLICE_MS) plus the step that crosses it; an unsliced pass would be one slice of
  // the whole build. Generous for a loaded machine: other test files run beside this one.
  assert.ok(s.maxSliceMs < 30, `longest slice ${s.maxSliceMs} ms`);
  w.close();
});

test("GET /api/discover: the body is Discover's, cached 10 s, with an ETag; it needs no linked posts; health carries its counters", async () => {
  const w = launches(world({ posts: false }));
  const app = await serveApp(w, { narrative: null });
  try {
    const r = await app.get("/api/discover");
    // max-age alone: a stale-while-revalidate window would let a browser answer every 15 s poll with the body of the poll before
    assert.deepEqual([r.status, r.headers.get("cache-control")], [200, "public, max-age=10"]);
    assert.ok(!/stale/.test(r.headers.get("cache-control")));
    assert.deepEqual(r.body, JSON.parse(JSON.stringify(await w.disc.serve())));
    assert.deepEqual(r.body.parents.map((p) => p.mint), [P.P1, P.P2, ...[P.P5, P.P6].sort()]);
    assert.equal((await app.get("/api/discover", { "if-none-match": r.headers.get("etag") })).status, 304);
    const [x, y] = await Promise.all([app.get("/api/discover"), app.get("/api/discover")]);
    assert.deepEqual(x.body, y.body);
    const health = (await app.get("/api/health")).body;
    assert.deepEqual([health.discover.builds, health.discover.served, health.discover.lastCoins, health.discover.lastParents, health.discover.maxSliceMs >= 0, health.narrative], [1, 4, 17, 4, true, null]);
  } finally { await app.close(); }
  w.close();
});
