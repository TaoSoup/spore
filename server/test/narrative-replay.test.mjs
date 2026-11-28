// scripts/narrative-replay.mjs: the owner's read-only measurement run. Which coins it picks (created in the window,
// with the buyers), that it goes through the server's own tagging path in creation order, the hard --max-usd stop, the
// dry run, what it writes and prints, and that the database file is never written. A fake client: no model provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReplay, parseArgs, alsoList, ALSO_MAX } from "../scripts/narrative-replay.mjs";
import { Db } from "../lib/db.mjs";
import { BATCH, userText } from "../lib/narrtags.mjs";

const NOW = 1_770_000_000, KEY = "sk-ant-replay-SECRET-42";
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** A database file as the server leaves one: `n` coins a minute apart (the newest at NOW), coin i with i distinct $5 buyers. */
function fixture(dir, n = 30) {
  const file = join(dir, "spore.sqlite"), db = new Db(file);
  const raw = db.db;
  const coin = raw.prepare("INSERT INTO coins (mint, curve, depth, quote_mint, creator, tracked, created_at) VALUES (?, ?, ?, ?, 'cr', ?, ?)");
  const mint = raw.prepare("INSERT INTO mints (mint, name, symbol, uri) VALUES (?, ?, ?, ?)");
  const meta = raw.prepare("INSERT INTO meta (uri, description, twitter, website, ok) VALUES (?, ?, ?, ?, 1)");
  const trade = raw.prepare("INSERT INTO trades (sig, mint, idx, slot, time, is_buy, user, base_amount, quote_amount, price_quote, price_usd, value_usd) VALUES (?, ?, 0, 1, ?, ?, ?, '1', '1', 1, 1, ?)");
  raw.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const m = `M${String(i).padStart(3, "0")}`, at = NOW - (n - 1 - i) * 60;
    coin.run(m, `C${i}`, i === 20 || i === 28 ? 1 : 0, i === 20 ? "M015" : i === 28 ? "M010" : null, i === 7 ? 0 : 1, at);
    mint.run(m, `Coin ${i}`, `T${i}`, `uri:${m}`);
    meta.run(`uri:${m}`, i % 2 ? "about the ai bubble" : "about a dog in a hat", i === 16 ? "https://x.com/who/status/1700000000000000009" : null, "https://site.example/story");
    for (let b = 0; b < i; b++) trade.run(`S${i}_${b}`, m, at + b, 1, `w${b}`, 5);
    trade.run(`S${i}_sell`, m, at, 0, "seller", 50); // a sale is not a buyer
    trade.run(`S${i}_cent`, m, at, 1, "tiny", 0.5);  // nor is a buy under $1
  }
  // a coin older than any window, with many buyers
  coin.run("OLD", "CO", 0, null, 1, NOW - 10 * 86_400); mint.run("OLD", "Old", "OLD", "uri:OLD");
  for (let b = 0; b < 40; b++) trade.run(`SO_${b}`, "OLD", NOW - 10 * 86_400, 1, `w${b}`, 5);
  db.xpostSet({ id: "1700000000000000009", state: "ok", handle: "who", text: "the post behind coin 16", flagged: false, fetchedAt: NOW, askedAt: NOW, recheckAt: NOW + 1 });
  raw.exec("COMMIT");
  db.checkpoint?.();
  db.close();
  return file;
}
const sentCoins = (req) => JSON.parse(userText(req.messages[0]).split("<coins>\n")[1].split("\n</coins>")[0]);

test("replay arguments: the documented options and defaults; a missing database, output or key is said plainly", () => {
  assert.deepEqual(parseArgs(["--db", "d.sqlite", "--key-file", "k", "--out", "o"]), { model: "claude-haiku-5-5", hours: 24, maxCoins: 1500, maxUsd: 0.5, minBuyers: 10, perMin: 20, dryRun: false, db: "d.sqlite", keyFile: "k", out: "o" });
  assert.deepEqual(parseArgs(["--db=d", "--out=o", "--dry-run", "--hours", "6", "--max-coins=200", "--max-usd", "0.1", "--model", "m"]), { model: "m", hours: 6, maxCoins: 200, maxUsd: 0.1, minBuyers: 10, perMin: 20, dryRun: true, db: "d", out: "o" });
  assert.throws(() => parseArgs(["--out", "o", "--dry-run"]), /--db <path to the server's sqlite file> is required/);
  assert.throws(() => parseArgs(["--db", "d", "--out", "o"]), /--key-file <path> is required \(or --dry-run\)/);
  assert.throws(() => parseArgs(["--db", "d", "--dry-run"]), /--out <dir> is required/);
  assert.throws(() => parseArgs(["--db", "d", "--out", "o", "--dry-run", "--hours", "x"]), /--hours must be a number/);
  assert.throws(() => parseArgs(["--db", "d", "--out", "o", "--dry-run", "--key", KEY]), (e) => /unknown option --key/.test(e.message) && !e.message.includes(KEY));
});

test("a dry run reads the window's coins that met the buyers bar, sends nothing, writes replay.json and leaves the database file untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-replay-"));
  try {
    const file = fixture(dir), before = sha(file), lines = [];
    const r = await runReplay({ db: file, out: join(dir, "out"), dryRun: true, hours: 24, maxCoins: 1500, maxUsd: 0.5 }, { print: (l) => lines.push(l) });
    // coins 10..29 have 10+ buyers; coin 7 is untracked anyway; OLD is outside the window
    assert.deepEqual([r.dryRun, r.coinsCreated, r.coinsEligible, r.coinsPicked, r.coinsRead, r.tagged, r.none, r.narratives, r.stopped, r.requests], [true, 29, 20, 20, 20, 0, 20, 0, null, Math.ceil(20 / BATCH)]);
    assert.ok(r.inputTokens > 0 && r.usd > 0 && r.usd < 0.01 && r.usdPerDayAtThisRate > 0);
    assert.equal(sha(file), before, "the database file is byte for byte what it was");
    assert.ok(!existsSync(`${file}-journal`));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "out", "replay.json"), "utf8")).coinsRead, 20);
    const out = lines.join("\n");
    for (const needle of ["DRY RUN: nothing is sent to a model", "coins read: 20 of 20", "requests: 1 (0 failed, 0 unusable replies)", "rough estimates: nothing was sent", "projected a day at this rate: $", "tagged: 0 (0.0 %), none: 20 (100.0 %); narratives: 0", "It can be wrong"]) assert.ok(out.includes(needle), `${needle} in:\n${out}`);
    assert.doesNotMatch(out, /recommend|likely to rise|\bearly\b|\bsignal\b|\balpha\b/i);
    // the window and the cap on coins: the newest ones, in creation order
    const small = await runReplay({ db: file, out: join(dir, "out2"), dryRun: true, hours: 0.25, maxCoins: 5, maxUsd: 0.5 }, { print() {} });
    assert.deepEqual([small.coinsCreated, small.coinsEligible, small.coinsPicked, small.noneCoins.map((c) => c.mint)], [15, 15, 5, ["M025", "M026", "M027", "M028", "M029"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a replay goes through the server's tagging path in creation order: narratives build up, a parent's narrative and a stored post are passed on, the report lists the groups; the key is never printed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-replay-"));
  try {
    const file = fixture(dir), before = sha(file), lines = [], reqs = [];
    const clientFactory = async () => ({ messages: { create: async (req) => {
      reqs.push(req);
      const coins = sentCoins(req);
      const known = userText(req.messages[0]).split("<narratives>\n")[1].split("\n</narratives>")[0];
      return { stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 400 }, content: [{ type: "text", text: JSON.stringify({ coins: coins.map((c) => {
        if (c.symbol === "T29") return { n: c.n, kind: "none", id: 0, title: "", theme: "other" };
        const dog = c.description.includes("dog"), id = Number((known.match(dog ? /^(\d+) \| animals/m : /^(\d+) \| ai/m) ?? [])[1] ?? 0);
        return id ? { n: c.n, kind: "existing", id, title: "", theme: "other" } : { n: c.n, kind: "new", id: 0, title: dog ? "Dog in a Hat" : "AI Bubble Popping", theme: dog ? "animals" : "ai" };
      }) }) }] };
    } } });
    const r = await runReplay({ db: file, keyFile: join(dir, "never-read.key"), out: join(dir, "out"), hours: 24, maxCoins: 12, maxUsd: 0.5, perMin: 1e6 }, { clientFactory, print: (l) => lines.push(l) });
    assert.deepEqual([r.coinsEligible, r.coinsPicked, r.coinsRead, r.tagged, r.none, r.narratives, r.requests, r.stopped], [20, 12, 12, 11, 1, 2, 1, null]);
    assert.deepEqual(r.groups.map((g) => [g.title, g.theme, g.coins.length]), [["dog in a hat", "animals", 6], ["ai bubble popping", "ai", 5]]);
    assert.ok(Math.abs(r.usd - (3000 * 0.10 + 400 * 0.50) / 1e6) < 1e-12);
    assert.ok(Math.abs(r.usdPerDayAtThisRate - (r.usd / 12) * 20) < 1e-12, "every eligible coin of the window, at this run's cost per coin");
    const sent = sentCoins(reqs[0]);
    assert.deepEqual(sent.map((c) => c.symbol), Array.from({ length: 12 }, (_, i) => `T${18 + i}`), "creation order");
    assert.deepEqual([sent[2].paired_with, sent[0].site], ["Coin 15 (T15)", "site.example story"]);
    assert.equal(sha(file), before);
    const out = lines.join("\n");
    assert.ok(out.includes("the largest narratives:") && out.includes("[animals] dog in a hat: Coin 18 (T18)") && out.includes("tagged: 11 (91.7 %), none: 1 (8.3 %); narratives: 2"));
    assert.ok(!out.includes(KEY) && !JSON.stringify(r).includes(KEY));
    // batches of 20 over a longer run: a later request lists the narratives made by an earlier one, and a coin's stored post is sent
    reqs.length = 0;
    const all = await runReplay({ db: file, keyFile: join(dir, "never-read.key"), out: join(dir, "out3"), hours: 24, maxCoins: 1500, maxUsd: 0.5, minBuyers: 5, perMin: 1e6 }, { clientFactory, print() {} });
    assert.deepEqual([all.coinsPicked, all.requests, all.narratives, userText(reqs[1].messages[0]).split("<narratives>\n")[1].split("\n</narratives>")[0]], [24, 2, 2, "1 | ai | ai bubble popping\n2 | animals | dog in a hat"]);
    assert.deepEqual(sentCoins(reqs[0]).find((c) => c.symbol === "T16").post, { by: "who", text: "the post behind coin 16" });
    assert.equal(sentCoins(reqs[0]).find((c) => c.symbol === "T20").pair_narrative, undefined, "its parent (coin 15) is in the same request: not tagged yet");
    assert.equal(sentCoins(reqs[1]).find((c) => c.symbol === "T28").pair_narrative, "dog in a hat", "the parent (coin 10) was tagged in the request before");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--max-usd is a hard stop, a failing provider ends the run by class, and an unusable reply is retried in halves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-replay-"));
  try {
    const file = fixture(dir, 60);
    let n = 0;
    const paid = async () => ({ messages: { create: async (req) => { n++; return { stop_reason: "end_turn", usage: { input_tokens: 5000, output_tokens: 1000 }, content: [{ type: "text", text: JSON.stringify({ coins: sentCoins(req).map((c) => ({ n: c.n, kind: "none", id: 0, title: "", theme: "other" })) }) }] }; } } });
    // each request costs $0.001 for real and about $0.0016 as its worst case (the story line doubled the output
    // allowance, Nov 28): with $0.003 a second fits, a third does not
    const capped = await runReplay({ db: file, keyFile: "k", out: join(dir, "o1"), hours: 24, maxCoins: 1500, maxUsd: 0.003, perMin: 1e6 }, { clientFactory: paid, print() {} });
    assert.deepEqual([capped.stopped, capped.requests, n, capped.coinsRead, capped.coinsPicked], ["capped", 2, 2, 40, 50]);
    assert.ok(capped.usd <= 0.003);
    const lines = [];
    const refused = async () => ({ messages: { create: async () => { throw Object.assign(new Error(`invalid x-api-key ${KEY}`), { status: 401 }); } } });
    const auth = await runReplay({ db: file, keyFile: "k", out: join(dir, "o2"), hours: 24, maxCoins: 1500, maxUsd: 0.5, perMin: 1e6 }, { clientFactory: refused, print: (l) => lines.push(l) });
    assert.deepEqual([auth.stopped, auth.requests, auth.coinsRead, auth.usd], ["auth", 1, 0, 0]);
    assert.ok(!lines.join("\n").includes(KEY) && lines.join("\n").includes("stopped early: auth"));
    // one coin makes every batch it is in unusable: halves, until it is alone and left out
    let calls = 0;
    const poison = async () => ({ messages: { create: async (req) => { calls++; const cs = sentCoins(req); return { stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "text", text: cs.some((c) => c.symbol === "T55") ? "no" : JSON.stringify({ coins: cs.map((c) => ({ n: c.n, kind: "none", id: 0, title: "", theme: "other" })) }) }] }; } } });
    const p = await runReplay({ db: file, keyFile: "k", out: join(dir, "o3"), hours: 24, maxCoins: 20, maxUsd: 0.5, perMin: 1e6 }, { clientFactory: poison, print() {} });
    assert.deepEqual([p.coinsRead, p.coinsLeftOut, p.stopped, calls <= 12], [19, 1, null, true]);
    // a model without a known price is refused before anything is opened
    await assert.rejects(runReplay({ db: file, out: join(dir, "o4"), dryRun: true, model: "mystery-model" }, { print() {} }), /no price is known for model mystery-model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--max-usd holds for the whole run: across a UTC midnight, and with a request that got no answer counted at its worst case; replies that keep being unusable end the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-replay-"));
  try {
    const file = fixture(dir, 60);
    // the run starts 30 s before midnight (UTC) and every request takes a minute
    let t = Date.UTC(2026, 0, 1, 23, 59, 30), n = 0;
    const now = () => t, sleep = async (ms) => { t += ms; };
    const answer = (req) => ({ stop_reason: "end_turn", usage: { input_tokens: 5000, output_tokens: 1000 }, content: [{ type: "text", text: JSON.stringify({ coins: sentCoins(req).map((c) => ({ n: c.n, kind: "none", id: 0, title: "", theme: "other" })) }) }] });
    const slow = async () => ({ messages: { create: async (req) => { n++; t += 60_000; return answer(req); } } });
    // $0.001 a request (worst case about $0.0016): with $0.003 a second fits and a third does not, whatever the date says by then
    const r = await runReplay({ db: file, keyFile: "k", out: join(dir, "o1"), hours: 24, maxCoins: 1500, maxUsd: 0.003, perMin: 1e6 }, { clientFactory: slow, print() {}, now, sleep });
    assert.deepEqual([r.stopped, r.requests, n, new Date(t).toISOString().slice(0, 10)], ["capped", 2, 2, "2026-01-02"]);
    assert.ok(Math.abs(r.usd - 0.002) < 1e-12 && r.usd <= 0.003);
    // the first request times out (it may have been billed): its worst case stays in the run's cost and in the cap
    let m = 0;
    const lines = [];
    const flaky = async () => ({ messages: { create: async (req) => { if (++m === 1) throw Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" }); return answer(req); } } });
    const f = await runReplay({ db: file, keyFile: "k", out: join(dir, "o2"), hours: 24, maxCoins: 1500, maxUsd: 0.0048, perMin: 1e6 }, { clientFactory: flaky, print: (l) => lines.push(l), now, sleep });
    // the answered requests cost $0.001 each; the reserve of the one without an answer takes the room of a third
    assert.deepEqual([f.stopped, f.failedRequests, f.requests, f.coinsRead], ["capped", 1, 3, 40]);
    assert.ok(f.usd > 0.002 + 1e-4 && f.usd <= 0.0048, `the reserve is in the cost: ${f.usd}`);
    assert.ok(lines.join("\n").includes("a request without an answer is counted at its worst case"));
    // every reply refused: not a coin's doing, so the run ends by class instead of halving its way through the budget
    let k = 0;
    const refusing = async () => ({ messages: { create: async () => { k++; return { stop_reason: "refusal", content: [], usage: { input_tokens: 500, output_tokens: 0 } }; } } });
    const x = await runReplay({ db: file, keyFile: "k", out: join(dir, "o3"), hours: 24, maxCoins: 1500, maxUsd: 0.5, perMin: 1e6 }, { clientFactory: refusing, print() {}, now, sleep });
    assert.deepEqual([x.stopped, k, x.coinsRead, x.coinsLeftOut <= 2], ["refusal", 8, 0, true]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a replay runs the same guards as the server: boilerplate is stripped, a coin with no text is stored as none, a retitle is applied once, and the counters are reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-replay-"));
  try {
    const file = fixture(dir);
    // coin 9 (an "ai" coin) has launcher boilerplate for a description and no website
    const raw = new Db(file);
    raw.db.prepare("UPDATE meta SET description = 'Deployed using rapidlaunch.io', website = NULL WHERE uri = 'uri:M009'").run();
    // coin 11 (an "ai" coin) has no text either and is priced in USDC, which is not a coin of the index: no pairing, no way round the guard
    raw.db.prepare("UPDATE meta SET description = 'Launched on bags.fm/abc 🚀', website = NULL WHERE uri = 'uri:M011'").run();
    raw.db.prepare("UPDATE coins SET quote_mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' WHERE mint = 'M011'").run();
    raw.close();
    const lines = [], reqs = [];
    const clientFactory = async () => ({ messages: { create: async (req) => {
      reqs.push(req);
      const coins = sentCoins(req);
      const known = userText(req.messages[0]).split("<narratives>\n")[1].split("\n</narratives>")[0];
      return { stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 400 }, content: [{ type: "text", text: JSON.stringify({ coins: coins.map((c) => {
        const dog = !!c.description?.includes("dog"), id = Number((known.match(dog ? /^(\d+) \| animals/m : /^(\d+) \| ai/m) ?? [])[1] ?? 0);
        // every later answer suggests a title: a wider one for the dogs (words of the old title only), one about something else for the ai coins
        return id ? { n: c.n, kind: "existing", id, title: "", theme: "other", retitle: dog ? "Dog Hats" : "free hat parade" } : { n: c.n, kind: "new", id: 0, title: dog ? "Dog in a Hat" : "AI Bubble Popping", theme: dog ? "animals" : "ai", retitle: "" };
      }) }) }] };
    } } });
    const r = await runReplay({ db: file, keyFile: join(dir, "never-read.key"), out: join(dir, "out"), hours: 24, maxCoins: 1500, maxUsd: 0.5, minBuyers: 5, perMin: 1e6 }, { clientFactory, print: (l) => lines.push(l) });
    const nine = sentCoins(reqs[0]).find((c) => c.symbol === "T9");
    assert.deepEqual(nine, { n: nine.n, name: "Coin 9", symbol: "T9", no_text: true });
    const eleven = sentCoins(reqs[0]).find((c) => c.symbol === "T11");
    assert.deepEqual(eleven, { n: eleven.n, name: "Coin 11", symbol: "T11", no_text: true });
    assert.deepEqual([r.coinsPicked, r.requests, r.forcedNone, r.retitled, r.retitleRefused, r.none, r.noneCoins.map((c) => c.symbol)], [24, 2, 2, 1, 1, 2, ["T9", "T11"]]);
    assert.deepEqual(r.groups.map((g) => [g.title, g.theme]).sort(), [["ai bubble popping", "ai"], ["dog hats", "animals"]]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "out", "replay.json"), "utf8")).forcedNone, 2);
    const out = lines.join("\n");
    assert.ok(out.includes("guards: 2 coins with no text stored as none") && out.includes("wider titles: 1 applied, 1 refused"), out);
    assert.doesNotMatch(out, /recommend|likely to rise|\bearly\b|\bsignal\b|\balpha\b/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--until and --also on the command line: a time in unix seconds; up to 50 mints, comma-separated, each once; bad values are said plainly", () => {
  const base = ["--db", "d", "--out", "o", "--dry-run"];
  assert.deepEqual([parseArgs([...base, "--until", String(NOW)]).until, parseArgs([...base, `--until=${NOW}`]).until, parseArgs(base).until, parseArgs(base).also], [NOW, NOW, undefined, undefined]);
  assert.deepEqual(parseArgs([...base, "--also", "M003, OLD,,M003", "--also=M004"]).also, ["M003", "OLD", "M004"]);
  for (const bad of ["x", "0", "-5", "12.5", String(NOW * 1000)]) assert.throws(() => parseArgs([...base, "--until", bad]), /--until must be a time in unix seconds/, bad);
  assert.throws(() => parseArgs([...base, "--until"]), /--until needs a value/);
  assert.throws(() => parseArgs([...base, "--also", "M003,not a mint!"]), /--also takes mint addresses separated by commas/);
  assert.equal(ALSO_MAX, 50);
  assert.equal(alsoList(Array.from({ length: 50 }, (_, i) => `A${i}`)).length, 50);
  assert.throws(() => parseArgs([...base, "--also", Array.from({ length: 51 }, (_, i) => `A${i}`).join(",")]), /--also takes at most 50 coins/);
});

test("--until ends the window at that time instead of at the newest coin, so a later, larger file gives the same coins (dry run; the file is not written)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-replay-"));
  try {
    const file = fixture(dir), before = sha(file), lines = [];
    // 10 minutes before the newest coin: coins 0..19 are created by then, of which 10..19 have the buyers
    const r = await runReplay({ db: file, out: join(dir, "o1"), dryRun: true, hours: 24, until: NOW - 600 }, { print: (l) => lines.push(l) });
    assert.deepEqual([r.windowEnd, r.until, r.coinsCreated, r.coinsEligible, r.coinsPicked, r.coinsRead, r.noneCoins.map((c) => c.mint)], [NOW - 600, NOW - 600, 19, 10, 10, 10, Array.from({ length: 10 }, (_, i) => `M0${10 + i}`)]);
    assert.ok(lines[0].includes(`before ${new Date((NOW - 600) * 1000).toISOString()} (--until)`), lines[0]);
    // the window is --hours before --until: 5 minutes of it hold coins 15..19
    const short = await runReplay({ db: file, out: join(dir, "o2"), dryRun: true, hours: 5 / 60, until: NOW - 600 }, { print() {} });
    assert.deepEqual(short.noneCoins.map((c) => c.mint), ["M015", "M016", "M017", "M018", "M019"]);
    // without it the window ends at the newest coin, as before
    const plain = await runReplay({ db: file, out: join(dir, "o3"), dryRun: true, hours: 24 }, { print() {} });
    assert.deepEqual([plain.windowEnd, plain.until, plain.coinsPicked], [NOW, null, 20]);
    await assert.rejects(runReplay({ db: file, out: join(dir, "o4"), dryRun: true, until: 12.5 }, { print() {} }), /--until must be a time in unix seconds/);
    assert.equal(sha(file), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--also coins are read after the window's coins whatever their age or buyers, a missing one is reported and skipped, the report says where each landed, and they count toward --max-usd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-replay-"));
  try {
    const file = fixture(dir), before = sha(file), lines = [], reqs = [];
    let inTokens = 3000;
    const clientFactory = async () => ({ messages: { create: async (req) => {
      reqs.push(req);
      const known = userText(req.messages[0]).split("<narratives>\n")[1].split("\n</narratives>")[0];
      return { stop_reason: "end_turn", usage: { input_tokens: inTokens, output_tokens: 400 }, content: [{ type: "text", text: JSON.stringify({ coins: sentCoins(req).map((c) => {
        if (!c.description) return { n: c.n, kind: "none", id: 0, title: "", theme: "other", retitle: "" };
        const dog = c.description.includes("dog"), id = Number((known.match(dog ? /^(\d+) \| animals/m : /^(\d+) \| ai/m) ?? [])[1] ?? 0);
        return id ? { n: c.n, kind: "existing", id, title: "", theme: "other", retitle: "" } : { n: c.n, kind: "new", id: 0, title: dog ? "Dog in a Hat" : "AI Bubble Popping", theme: dog ? "animals" : "ai", retitle: "" };
      }) }) }] };
    } } });
    // OLD: ten days old (no metadata: "none"); M003: in the window but under the buyers bar; M007: untracked; M025: one of the window's own coins; NOPE: not in the file
    const r = await runReplay({ db: file, keyFile: join(dir, "never-read.key"), out: join(dir, "out"), hours: 24, maxCoins: 12, maxUsd: 0.5, perMin: 1e6, also: "OLD,M003,NOPE,M025,M007,M003" }, { clientFactory, print: (l) => lines.push(l) });
    assert.deepEqual([r.coinsEligible, r.coinsPicked, r.coinsRead, r.alsoRead, r.requests, r.stopped], [20, 12, 12, 3, 2, null]);
    assert.deepEqual(sentCoins(reqs[0]).map((c) => c.symbol), Array.from({ length: 12 }, (_, i) => `T${18 + i}`), "the window's coins first, alone");
    assert.deepEqual(sentCoins(reqs[1]).map((c) => c.symbol), ["OLD", "T3", "T7"], "then the --also coins, in the order given, each once");
    assert.equal(userText(reqs[1].messages[0]).split("<narratives>\n")[1].split("\n</narratives>")[0], "1 | animals | dog in a hat\n2 | ai | ai bubble popping", "they see the narratives the window made");
    assert.deepEqual(r.also, [
      { mint: "OLD", name: "Old", symbol: "OLD", found: true, inWindow: false, read: true, title: null, theme: null },
      { mint: "M003", name: "Coin 3", symbol: "T3", found: true, inWindow: false, read: true, title: "ai bubble popping", theme: "ai" },
      { mint: "NOPE", name: null, symbol: null, found: false, inWindow: false, read: false, title: null, theme: null },
      { mint: "M025", name: "Coin 25", symbol: "T25", found: true, inWindow: true, read: true, title: "ai bubble popping", theme: "ai" },
      { mint: "M007", name: "Coin 7", symbol: "T7", found: true, inWindow: false, read: true, title: "ai bubble popping", theme: "ai" },
    ]);
    // the window's own figures are what they are without --also; the groups show the extra coins, marked
    assert.deepEqual([r.tagged, r.none, r.taggedShare, r.noneCoins.length], [12, 0, 1, 0]);
    const ai = r.groups.find((g) => g.title === "ai bubble popping");
    assert.deepEqual(ai.coins.filter((c) => c.also).map((c) => c.mint), ["M003", "M007"]);
    assert.ok(Math.abs(r.usdPerCoin - r.usd / 15) < 1e-12, "the cost a coin counts every coin read");
    const out = lines.join("\n");
    for (const needle of ["reading the newest 12 and then 3 of the 5 --also coins", "coins read: 12 of 12 (and 3 --also coins after them)", "also: Old ($OLD) -> none", "also: Coin 3 ($T3) -> ai bubble popping", "also: NOPE is not in the file (skipped)", "also: Coin 25 ($T25) -> ai bubble popping (one of the window's coins: read in its place there)", "also: Coin 7 ($T7) -> ai bubble popping"]) assert.ok(out.includes(needle), `${needle} in:\n${out}`);
    assert.doesNotMatch(out, /recommend|likely to rise|\bearly\b|\bsignal\b|\balpha\b/i);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "out", "replay.json"), "utf8")).also.length, 5);
    assert.equal(sha(file), before, "the database file is byte for byte what it was");
    // toward --max-usd: a request now costs $0.001; with $0.0014 the window's request fits and the --also coins' does not
    inTokens = 8000;
    const capped = await runReplay({ db: file, keyFile: "k", out: join(dir, "o2"), hours: 24, maxCoins: 12, maxUsd: 0.0014, perMin: 1e6, also: ["OLD", "M003"] }, { clientFactory, print: (l) => lines.push(l) });
    assert.deepEqual([capped.stopped, capped.coinsRead, capped.alsoRead, capped.also.map((a) => a.read)], ["capped", 12, 0, [false, false]]);
    assert.ok(lines.join("\n").includes("also: Old ($OLD) -> not read"));
    // a dry run with --until and --also together: nothing sent, every coin "none"
    const dry = await runReplay({ db: file, out: join(dir, "o3"), dryRun: true, hours: 24, until: NOW - 600, also: "M029,OLD" }, { print() {} });
    assert.deepEqual([dry.coinsRead, dry.alsoRead, dry.also.map((a) => [a.mint, a.inWindow, a.read, a.title])], [10, 2, [["M029", false, true, null], ["OLD", false, true, null]]]);
    await assert.rejects(runReplay({ db: file, out: join(dir, "o4"), dryRun: true, also: Array.from({ length: 51 }, (_, i) => `A${i}`) }, { print() {} }), /--also takes at most 50 coins/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
