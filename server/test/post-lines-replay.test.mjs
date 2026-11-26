// scripts/post-lines-replay.mjs: the owner's LOG-ONLY replay of the stored post lines under the new rules. What it
// reads from the database (the old lines, the posts' texts, the coins that link them), that the quoted posts are read
// through the X fetcher's own path (one t.co request that reads the redirect only, then the embed call), that the model
// path is the server's own PostLines (batches, checks, the re-ask), the hard --max-usd stop, the dry run, what it writes,
// that the key never shows, and that the database file is never written. A fake fetch and a fake client: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReplay, parseArgs, settingsOf } from "../scripts/post-lines-replay.mjs";
import { Db } from "../lib/db.mjs";
import { userText } from "../lib/narrtags.mjs";
import { BATCH, LINE_RULES_KEY, LINE_RULES_VERSION } from "../lib/post-lines.mjs";

const NOW = 1_770_000_000, KEY = "sk-ant-lines-SECRET-77";
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const idAt = (agoS, n = 0) => String(((BigInt((NOW - agoS) * 1000) - 1288834974657n) << 22n) + BigInt(n));
const [A, B, C, D, E, F, G, Q] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => idAt(3600 + n, n));
const LONG = "a wizard cat walks across a wide stage in a small town tonight";

/** A database file as the server leaves one under the old rules: seven stored lines, their posts and the coins that link them. */
function fixture(dir) {
  const file = join(dir, "spore.sqlite"), db = new Db(file), raw = db.db;
  const mint = raw.prepare("INSERT INTO mints (mint, name, symbol, uri) VALUES (?, ?, ?, ?)");
  const meta = raw.prepare("INSERT INTO meta (uri, description, twitter, website, ok) VALUES (?, ?, ?, ?, 1)");
  const coin = raw.prepare("INSERT INTO coins (mint, curve, depth, quote_mint, creator, tracked, created_at) VALUES (?, ?, 1, ?, 'cr', 1, ?)");
  const add = (m, name, symbol, postId, { parent = null, description = "Deployed using https://j7tracker.io", site = false } = {}) => {
    mint.run(m, name, symbol, `uri:${m}`);
    meta.run(`uri:${m}`, description, site ? null : `https://x.com/someone/status/${postId}`, site ? `https://twitter.com/i/status/${postId}` : null);
    coin.run(m, `C_${m}`, parent, NOW - 600);
  };
  mint.run("PARENT", "Space X", "SPCX", "uri:PARENT");
  add("MA", "ZeroSumEnjoyer", "Zero", A); add("MA2", "ZeroSumEnjoyer", "SOLACE", A, { site: true });
  add("MB", "Wizard Cat", "WIZ", B, { parent: "PARENT", description: "the wizard cat coin" });
  add("MC1", "PVE", "PVE", C); add("MC2", "safe inu", "SI", C);
  add("MD", "The White Bull", "Slingoor", D);
  add("ME", "Wizard Cat", "WIZ", E);
  add("MG", "Wizard Cat", "WIZ", G);
  mint.run("LOOSE", "Other", "OTH", "uri:LOOSE"); meta.run("uri:LOOSE", null, "https://x.com/someone", null);
  const post = (id, handle, text) => db.xpostSet({ id, state: "ok", handle, text, flagged: false, fetchedAt: NOW, askedAt: NOW, recheckAt: NOW + 1 });
  post(A, "comethankme12", "Sending 10%https://t.co/Ab12");
  post(B, "someone", `one: ${LONG}`);
  post(C, "a1lon9", "https://t.co/Art1");
  post(D, "HANYDEGEN", "SENDING 5%https://t.co/Dead");
  post(E, "someone", `bad: ${LONG}`);
  post(G, "someone", `thin: ${LONG}`);
  const line = (id, subject, happened, kind, coinMint, state = "ok") => db.lineSet({ postId: id, subject, happened, kind, state, asks: 1, model: "claude-sonnet-5-5", at: NOW - 100, coin: coinMint });
  line(A, "Sending 10%", "Poster says they are sending 10% in a short post with a link", "claim", "MA");
  line(B, "Wizard Cat", "A wizard cat walks across a stage", "event", "MB");
  line(C, "PVE", "Post only names the meme; no event stated", "none", "MC1");
  line(D, "Sending 5%", "Post only names the meme; no event stated", "none", "MD");
  line(E, null, null, null, "ME", "rejected");
  line(F, "Gone", "A post whose text is not stored", "event", null);
  line(G, "Wizard Cat", "Post only names the meme; no event stated", "none", "MG");
  db.kvSet(LINE_RULES_KEY, 2);
  raw.prepare("INSERT INTO narratives (id, title, theme, key, created_at, last_seen_at) VALUES (1, 'wizard cat on stage', 'animals', 'wizard cat on stage', ?, ?)").run(NOW, NOW);
  db.tagSet({ mint: "MB", narrativeId: 1, at: NOW, model: "m" });
  db.close();
  return file;
}
const sentPosts = (req) => JSON.parse(userText(req.messages[0]).split("<posts>\n")[1].split("\n</posts>")[0]);
/** X as the two hosts answer: the t.co redirects (only their Location is given) and the embed of the quoted post. */
function fakeX() {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: String(url), host: u.hostname, redirect: init?.redirect });
    if (u.hostname === "t.co") {
      const to = { "/Ab12": `https://twitter.com/dv3333333/status/${Q}`, "/Art1": "https://x.com/i/article/2125674407465246720" }[u.pathname];
      return { status: to ? 301 : 404, headers: new Headers(to ? { location: to } : {}), body: { cancel: async () => {} }, text: async () => { throw new Error("a link answer's body was read"); } };
    }
    const id = u.searchParams.get("url").split("/").pop();
    if (id !== Q) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ url: `https://twitter.com/dv3333333/status/${Q}`, author_url: "https://twitter.com/dv3333333", html: "<blockquote><p>New lore: a perp whale outdid Rasmr in the trenches</p>&mdash; trueadam (@dv3333333)</blockquote>" }), { status: 200 });
  };
  f.calls = calls;
  return f;
}
/** A model that answers per card: from the quoted post when there is one, a hype line for the "bad" post, thin for the "thin" one. */
function fakeModel(usage = { input_tokens: 2000, output_tokens: 300 }) {
  const calls = [];
  const f = async () => ({ messages: { create: async (req) => {
    calls.push(req);
    const posts = sentPosts(req).map((p) => {
      if (p.quoted) return { n: p.n, subject: "Rasmr and big trader", happened: "Quoted post says a big futures trader outdid Rasmr", kind: "claim" };
      if (p.post.text.startsWith("bad")) return { n: p.n, subject: "Wizard Cat", happened: "Poster says the wizard cat is a gem", kind: "claim" };
      if (p.post.text.startsWith("thin")) return { n: p.n, subject: "Wizard Cat", happened: "", kind: "thin" };
      return { n: p.n, subject: "Wizard Cat", happened: "Poster says a wizard cat walks across a stage in a small town", kind: "claim" };
    });
    return { stop_reason: "end_turn", usage, content: [{ type: "text", text: JSON.stringify({ posts }) }] };
  } } });
  f.calls = calls;
  return f;
}
const clockOf = () => { const c = { t: NOW * 1000, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; return c; };

test("replay arguments and settings: the documented options; the model settings are the server's own, read from the environment; no option takes a key", () => {
  assert.deepEqual(parseArgs(["--db", "d.sqlite", "--out", "o.json"]), { maxUsd: 1, perMin: 2, maxLinks: 300, linkGapMs: 4000, dryRun: false, db: "d.sqlite", out: "o.json" });
  assert.deepEqual(parseArgs(["--db=d", "--out=o.json", "--max-usd", "0.25", "--limit=10", "--dry-run", "--per-min", "4", "--max-links", "50", "--link-gap-ms=1000"]), { maxUsd: 0.25, perMin: 4, maxLinks: 50, linkGapMs: 1000, dryRun: true, db: "d", out: "o.json", limit: 10 });
  assert.throws(() => parseArgs(["--out", "o.json"]), /--db <path to the server's sqlite file> is required/);
  assert.throws(() => parseArgs(["--db", "d"]), /--out <file\.json> is required/);
  assert.throws(() => parseArgs(["--db", "d", "--out", "o", "--max-usd", "x"]), /--max-usd must be a number/);
  assert.throws(() => parseArgs(["--db", "d", "--out", "o", "--key", KEY]), (e) => /unknown option --key/.test(e.message) && !e.message.includes(KEY));
  assert.deepEqual(settingsOf({ NARRATIVE_KEY_FILE: "k.txt", NARRATIVE_MODEL: "claude-sonnet-5-5", NARRATIVE_IN_USD_PER_M: "3", NARRATIVE_OUT_USD_PER_M: "15", NARRATIVE_KEY: KEY }), { keyFile: "k.txt", model: "claude-sonnet-5-5", inUsdPerM: 3, outUsdPerM: 15 });
  assert.deepEqual(settingsOf({}), { keyFile: null, model: "claude-haiku-5-5", inUsdPerM: null, outUsdPerM: null });
});

test("a replay: old and new line per post, the quoted post read over the X fetcher's path, the server's own lines without a model, and the database file untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-lines-replay-"));
  try {
    const file = fixture(dir), before = sha(file), out = join(dir, "out", "replay.json"), printed = [];
    const keyFile = join(dir, "key.txt"); writeFileSync(keyFile, KEY);
    const x = fakeX(), model = fakeModel(), clock = clockOf();
    const r = await runReplay({ db: file, out, maxUsd: 1 }, { clientFactory: model, fetch: x, sleep: clock.sleep, now: clock.now, print: (l) => printed.push(String(l)), env: { NARRATIVE_KEY_FILE: keyFile, NARRATIVE_MODEL: "claude-haiku-5-5" } });
    // the database: the same bytes, the stored lines and the rules version as they were. (sqlite itself puts an EMPTY
    // write-ahead file and its index beside a database it reads when the server is not running; nothing is in them.)
    assert.equal(sha(file), before, "the database file is never written");
    assert.deepEqual([existsSync(`${file}-wal`) ? readFileSync(`${file}-wal`).length : 0, existsSync(`${file}-journal`)], [0, false], "nothing was written ahead either");
    const db = new Db(file);
    assert.deepEqual([db.lineGet(A).happened, db.kvGet(LINE_RULES_KEY), db.xpostGet(Q), db.linkCount(), db.spendGet(new Date(NOW * 1000).toISOString().slice(0, 10)).requests], ["Poster says they are sending 10% in a short post with a link", 2, null, 0, 0], "nothing new is stored: not a line, not the quoted post, not a link, not the spend");
    db.close();
    // X: only the two hosts, the link requests not following the redirect, the quoted post through the embed call
    assert.deepEqual(x.calls.map((c) => [c.host, c.redirect]).sort(), [["publish.x.com", "error"], ["t.co", "manual"], ["t.co", "manual"], ["t.co", "manual"]].sort());
    assert.deepEqual(x.calls.filter((c) => c.host === "t.co").map((c) => c.url).sort(), ["https://t.co/Ab12", "https://t.co/Art1", "https://t.co/Dead"]);
    assert.ok(x.calls.find((c) => c.host === "publish.x.com").url.includes(encodeURIComponent(`https://x.com/i/status/${Q}`)));
    // the model: the server's own path. One batch (four cards: A with its quoted post, B, E, G), then E alone with the reason
    assert.equal(BATCH, 6);
    assert.deepEqual(model.calls.map((q) => sentPosts(q).length), [4, 1]);
    const first = sentPosts(model.calls[0]), sentA = first.find((p) => p.post.text === "Sending 10%"), sentB = first.find((p) => p.post.text.startsWith("one"));
    assert.deepEqual(sentA, { n: sentA.n, post: { by: "comethankme12", text: "Sending 10%", age_days: 0 }, quoted: { by: "dv3333333", text: "New lore: a perp whale outdid Rasmr in the trenches", age_days: 0, year: new Date(NOW * 1000).getUTCFullYear() }, coins: [{ name: "ZeroSumEnjoyer", symbol: "Zero" }, { name: "ZeroSumEnjoyer", symbol: "SOLACE" }] }, "the stored lead coin first; a coin that names the post in `website` is found too; no launch tool's line");
    assert.deepEqual([sentB.coins, sentB.hint], [[{ name: "Wizard Cat", symbol: "WIZ", parent: "SPCX", text: "the wizard cat coin" }], "wizard cat on stage"], "the parent's ticker, the coin's own description, the stored story title as the hint");
    assert.match(sentPosts(model.calls[1])[0].fix, /praise or prediction word/);
    // the report, per post
    const by = Object.fromEntries(r.posts.map((p) => [p.id, p]));
    assert.deepEqual(r.posts.map((p) => p.id).sort(), [A, B, C, D, E, F, G].sort());
    assert.deepEqual(by[A].old, { subject: "Sending 10%", happened: "Poster says they are sending 10% in a short post with a link", kind: "claim", state: "ok" });
    assert.deepEqual([by[A].state, by[A].new, by[A].source, by[A].chips, by[A].rejectReasons], ["ok", { subject: "Rasmr and big trader", happened: "Quoted post says a big futures trader outdid Rasmr", kind: "claim", by: "model", quote: false }, "quoted", ["ai", "via_quoted"], []]);
    assert.deepEqual([by[A].link, by[A].quoted, by[A].words], [{ state: "ok", kind: "post", host: null }, { id: Q, handle: "dv3333333", text: "New lore: a perp whale outdid Rasmr in the trenches" }, 2]);
    assert.deepEqual([by[B].state, by[B].new.happened, by[B].source, by[B].quoted], ["ok", "Poster says a wizard cat walks across a stage in a small town", "post", null]);
    assert.deepEqual([by[C].state, by[C].new, by[C].link, by[C].chips], ["server", { subject: "$PVE", happened: "Post is only a link to an article on X", kind: "thin", by: "server", quote: false }, { state: "ok", kind: "article", host: "x.com" }, []], "two coins: the server's plain sentence, no model");
    assert.deepEqual([by[D].state, by[D].new, by[D].link.state, by[D].coins.length], ["server", null, "unread", 1], "a single coin, fee noise and a link that could not be read: no line");
    assert.deepEqual([by[E].state, by[E].new, by[E].rejectReasons, by[E].old.state], ["rejected", { subject: "$WIZ", happened: `bad: ${LONG}`, kind: "thin", by: "server", quote: true }, ["hype", "hype"], "rejected"], "refused twice: the model's line is never shown; a card shows the poster's own words");
    assert.deepEqual([by[F].state, by[F].text, by[F].new], ["no_text", null, null]);
    assert.deepEqual([by[G].state, by[G].new, by[G].rejectReasons], ["thin", { subject: "$WIZ", happened: `thin: ${LONG}`, kind: "thin", by: "server", quote: true }, []], "nothing stated: the poster's own words are what a card shows");
    // the totals
    const t = r.totals;
    assert.deepEqual([t.posts, t.withText, t.askedModel, t.requests, t.failedRequests, t.inputTokens, t.outputTokens, t.xRequests, t.noLine], [7, 6, 4, 2, 0, 4000, 600, 4, 1]);
    assert.deepEqual(t.byState, { ok: 2, server: 2, rejected: 1, no_text: 1, thin: 1 });
    assert.deepEqual(t.byKind, { claim: 2, server: 1, "server:quote": 2 });
    assert.deepEqual([t.bySource, t.byRejectReason, t.links], [{ quoted: 1, post: 1 }, { hype: 2 }, { read: 3, posts: 1, articles: 1, websites: 0, pictures: 0, unread: 1 }]);
    assert.ok(Math.abs(t.usd - 2 * (2000 * 0.10 + 300 * 0.50) / 1e6) < 1e-9, "the run's cost at the model's price");
    assert.deepEqual([r.stopped, r.dryRun, r.rulesVersion, r.model, r.maxUsd], [null, false, LINE_RULES_VERSION, "claude-haiku-5-5", 1]);
    // what is written and printed: the same report, and never the key
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), JSON.parse(JSON.stringify(r)));
    const everything = `${printed.join("\n")}\n${readFileSync(out, "utf8")}`;
    assert.equal(everything.includes(KEY), false, "the key is never printed or written");
    assert.match(printed.at(-1), /say nothing about any coin's price/);
    assert.ok(printed.some((l) => /posts: 7 \(6 with text\)/.test(l)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--max-usd is a hard stop: a request whose worst case does not fit is not sent, and the posts left are marked not run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-lines-replay-"));
  try {
    const file = fixture(dir), before = sha(file), out = join(dir, "replay.json");
    const x = fakeX(), model = fakeModel(), clock = clockOf();
    const r = await runReplay({ db: file, out, maxUsd: 0.0005 }, { clientFactory: model, fetch: x, sleep: clock.sleep, now: clock.now, print() {}, env: {} });
    assert.equal(model.calls.length, 0, "the first request's worst case is over the cap");
    assert.deepEqual([r.stopped, r.totals.requests, r.totals.usd], ["max_usd", 0, 0]);
    assert.deepEqual(r.totals.byState, { not_run: 4, server: 2, no_text: 1 });
    assert.equal(sha(file), before);
    // one request fits, the re-ask does not
    const m2 = fakeModel({ input_tokens: 20_000, output_tokens: 300 }), r2 = await runReplay({ db: file, out, maxUsd: 0.0025 }, { clientFactory: m2, fetch: fakeX(), sleep: clock.sleep, now: clock.now, print() {}, env: {} });
    assert.deepEqual([m2.calls.length, r2.stopped, r2.totals.byState.not_run], [1, "max_usd", 1]);
    assert.ok(r2.totals.usd <= 0.0025);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a dry run sends nothing to X or to a model and still says which posts would be asked; a model without a price, a missing key file and an --out that is the database are said plainly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-lines-replay-"));
  try {
    const file = fixture(dir), before = sha(file), out = join(dir, "dry.json");
    const boom = async () => { throw new Error("a dry run reached the network"); };
    const r = await runReplay({ db: file, out, dryRun: true, limit: 0 }, { fetch: boom, print() {}, env: { NARRATIVE_MODEL: "some-unpriced-model" }, now: () => NOW * 1000 });
    assert.deepEqual([r.dryRun, r.totals.requests, r.totals.xRequests, r.totals.usd], [true, 0, 0, 0]);
    assert.deepEqual(r.totals.byState, { server: 3, would_ask: 3, no_text: 1 }, "without its quoted post the short post is the server's too");
    assert.equal(sha(file), before);
    assert.equal((await runReplay({ db: file, out, dryRun: true, limit: 2 }, { fetch: boom, print() {}, env: {}, now: () => NOW * 1000 })).posts.length, 2);
    await assert.rejects(runReplay({ db: file, out }, { fetch: boom, print() {}, env: { NARRATIVE_MODEL: "some-unpriced-model" } }), /no price is known for model some-unpriced-model/);
    await assert.rejects(runReplay({ db: file, out }, { fetch: boom, print() {}, env: {} }), /NARRATIVE_KEY_FILE is not set/);
    await assert.rejects(runReplay({ db: file, out }, { fetch: boom, print() {}, env: { NARRATIVE_KEY_FILE: join(dir, "nope.txt") } }), /NARRATIVE_KEY_FILE is not a readable file \(ENOENT\)/);
    await assert.rejects(runReplay({ db: file, out }, { fetch: boom, print() {}, env: { NARRATIVE_KEY_FILE: file, ANTHROPIC_CUSTOM_HEADERS: "x: y" } }), /ANTHROPIC_CUSTOM_HEADERS is set/);
    await assert.rejects(runReplay({ db: file, out: file, dryRun: true }, { print() {} }), /--out must be a JSON file of its own, never the database/);
    await assert.rejects(runReplay({ db: file, out: join(dir, "x.sqlite"), dryRun: true }, { print() {} }), /never the database/);
    assert.equal(sha(file), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
