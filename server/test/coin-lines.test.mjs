// Coin story lines (lib/coin-lines.mjs) and how the tagger asks for, checks and stores them (lib/narrtags.mjs): the
// reply's `line`, the checks (the post lines' own: caps, hype, price, links, grounding; a picture lets a name or number
// through), the source rule, the server's own line for every coin the model has not written one for ("Name only" when
// there is nothing, a quote of the coin's own text when it passes the quote rules), the card header chosen from them
// (no counted sentence), storage beside the tag (coin_tags.line / line_v, migrated), the one re-read of listed coins
// tagged before lines, and health. A fake client and a fake clock: no network, no model provider, no paid call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COIN_LINE_VERSION, NAME_ONLY, NAME_ONLY_MANY, NAME_ONLY_UNREAD, NAME_ONLY_SOME, readCoinLine, checkCoinLine, lineSource, storedLine, coinServerLine, coinStoryLine, headerLine, nameOnly, lineOpener,
} from "../lib/coin-lines.mjs";
import {
  NarrTags, TagEngine, MemoryTagStore, DEFAULT_MODEL, REPLY_SCHEMA, SYSTEM_TEXT, SYSTEM_TEXT_PICTURES, OUT_BASE, OUT_PER_COIN, buildRequest, readReply, userText, RELINE_MAX, applyTagRules,
  LINE_SUBJECT_MAX, LINE_HAPPENED_MAX, LINE_WORDS_MAX, LINE_HAPPENED_TARGET, LINE_WORDS_TARGET,
} from "../lib/narrtags.mjs";
import { SUBJECT_MAX, HAPPENED_MAX, WORDS_MAX, HAPPENED_TARGET, WORDS_TARGET, CHIPS, quoteText, plainQuote } from "../lib/post-lines.mjs";
import { Db } from "../lib/db.mjs";
import { quiet } from "./helpers/tree.mjs";
import { fakeClock, T0 } from "./helpers/chain.mjs";

const flag = (t) => /badword/i.test(t);
const sentCoins = (req) => JSON.parse(userText(req.messages[0]).split("<coins>\n")[1].split("\n</coins>")[0]);
const reply = (coins) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ coins }) }], usage: { input_tokens: 1000, output_tokens: 300 } });
const L = (subject, happened, keys = []) => ({ subject, happened, keys });
const none = (n, line = L("", "")) => ({ n, kind: "none", id: 0, title: "", theme: "other", retitle: "", line });
const fresh = (n, title, line = L("", "")) => ({ n, kind: "new", id: 0, title, theme: "animals", retitle: "", line });
function fakeClient(answer) {
  const calls = [];
  const f = async () => ({ messages: { create: async (req) => { calls.push(req); return answer(req, calls.length); } } });
  f.calls = calls;
  return f;
}
const hippo = { mint: "hippo", name: "Moo Deng", symbol: "MOODENG", description: "the baby pygmy hippo at a zoo in Thailand", website: null, twitter: null, post: null, parent: null, asks: 0 };

test("the instructions and the schema carry the line; its caps are the post lines' caps; the output allowance is sized for it", () => {
  assert.deepEqual([LINE_SUBJECT_MAX, LINE_HAPPENED_MAX, LINE_WORDS_MAX, LINE_HAPPENED_TARGET, LINE_WORDS_TARGET], [SUBJECT_MAX, HAPPENED_MAX, WORDS_MAX, HAPPENED_TARGET, WORDS_TARGET]);
  for (const t of [SYSTEM_TEXT, SYSTEM_TEXT_PICTURES]) {
    assert.match(t, /THE LINE \(every coin, whatever its kind\)/);
    assert.match(t, /Write it ONLY from what this request shows of THAT coin/);
    assert.match(t, /happened is "" and keys is \[\]: do not guess/);
    assert.ok(t.indexOf("THE LINE") < t.indexOf("\nOUTPUT\n"));
    assert.doesNotMatch(t, /recommend|likely to rise|\bearly\b|\bsignal\b|\balpha\b|\binvest|\bbuy\b|\bprofit/i);
  }
  assert.ok(SYSTEM_TEXT_PICTURES.indexOf("THE LINE") < SYSTEM_TEXT_PICTURES.indexOf("PICTURES\n"), "the picture rules still sit right before the output");
  const item = REPLY_SCHEMA.properties.coins.items;
  assert.ok(item.required.includes("line"));
  assert.deepEqual(item.properties.line, { type: "object", properties: { subject: { type: "string" }, happened: { type: "string" }, keys: { type: "array", items: { type: "string" } } }, required: ["subject", "happened", "keys"], additionalProperties: false });
  assert.equal(OUT_PER_COIN, 112);
  assert.equal(buildRequest({ coins: [hippo, hippo, hippo, hippo, hippo, hippo, hippo] }).max_tokens, OUT_BASE + 7 * OUT_PER_COIN);
  assert.equal(COIN_LINE_VERSION, 2);
  assert.ok(CHIPS.includes("coin_line"));
});

test("the reply: a line rides on its answer, cleaned; a missing or unusable line never drops the tag", () => {
  const r = readReply(JSON.stringify({ coins: [
    { ...fresh(1, "moo deng the hippo"), line: { subject: " Moo Deng ", happened: "Baby pygmy hippo at a zoo in Thailand.", keys: ["Moo Deng", "pygmy hippo", "not there"] } },
    { ...none(2), line: "nope" },
    { n: 3, kind: "none", id: 0, title: "", theme: "other", retitle: "" },
    { ...none(4), line: L("Bonk", "") },
  ] }), { count: 4, offered: new Set() });
  assert.deepEqual(r.answers, [
    { kind: "new", title: "moo deng the hippo", theme: "animals", line: { subject: "Moo Deng", happened: "Baby pygmy hippo at a zoo in Thailand", keys: ["pygmy hippo"] } },
    { kind: "none" }, { kind: "none" }, { kind: "none", line: { subject: "Bonk", happened: "", keys: [] } },
  ]);
  assert.equal(readCoinLine(null), null);
  assert.deepEqual(readCoinLine({ subject: "A", happened: "🚀 Moo Deng sleeps in a bucket 🚀", keys: ["bucket"] }), { subject: "A", happened: "Moo Deng sleeps in a bucket", keys: ["bucket"] });
});

test("the checks: the post lines' checks over the coin's own texts; a picture lets a name or number through, nothing else", () => {
  const ok = checkCoinLine(L("Moo Deng", "Baby pygmy hippo at a zoo in Thailand", ["pygmy hippo"]), hippo);
  assert.deepEqual(ok, { line: { subject: "Moo Deng", happened: "Baby pygmy hippo at a zoo in Thailand", keys: ["pygmy hippo"], source: "description" }, why: null });
  assert.deepEqual(checkCoinLine(L("Moo Deng", ""), hippo), { line: null, why: "empty" });
  assert.deepEqual(checkCoinLine(null, hippo), { line: null, why: "missing" });
  const bad = (subject, happened, d = hippo, o) => checkCoinLine(L(subject, happened), d, o).why;
  assert.equal(bad("Moo Deng", "Baby hippo coin is the next big gem on Solana"), "hype");
  assert.equal(bad("Moo Deng", "Baby hippo heads for a 2M market cap", { ...hippo, description: "a hippo coin, 2M strong" }), "price", "a figure the texts have is still no price");
  assert.equal(bad("Moo Deng", "Baby hippo at https://zoo.example"), "link");
  assert.equal(bad("Moo Deng", "Baby hippo was born yesterday at the zoo"), "day");
  assert.equal(bad("Moo Deng", "Baby hippo ".repeat(12)), "long");
  assert.equal(bad("Elon Musk", "Elon Musk posts about a baby hippo"), "ungrounded", "a name the coin's texts do not have");
  assert.equal(bad("Moo Deng", "Baby hippo born 3 times at a zoo"), "number");
  // with its picture sent the name or number may be the picture's; a price or hype word never is
  const bare = { ...hippo, description: null };
  assert.equal(bad("Moo Deng", "A baby hippo holding a sign that says 67", bare, { picture: true }), null);
  assert.equal(bad("Duck King", "Duck King in a golden crown", bare, { picture: true }), null);
  assert.equal(bad("Duck King", "Duck King in a golden crown", bare), "ungrounded");
  assert.equal(bad("Duck King", "A 10x gem with a crown", bare, { picture: true }), "hype");
});

test("the source rule: post, then description, then picture; name when the line adds nothing to the name", () => {
  const d = { ...hippo, post: { handle: "zoo", text: "Our hippo learned to swim in the big pool" } };
  assert.equal(lineSource(L("Moo Deng", "Zoo hippo learned to swim in the big pool"), d), "post");
  assert.equal(lineSource(L("Moo Deng", "Pygmy calf from Thailand"), d), "description");
  assert.equal(lineSource(L("Moo Deng", "Cartoon hippo with a crown"), { ...hippo, description: null }, { picture: true }), "picture");
  assert.equal(lineSource(L("Moo Deng", "Coin named Moo Deng"), hippo), "name");
});

test("the server's own line: never blank; a quote of the coin's own text while the model has not read it; Name only otherwise, saying what was and was not read", () => {
  const f = (o) => coinServerLine({ name: "Bonk Cat", symbol: "BCAT", ...o }, { flag });
  assert.deepEqual(f({}), { subject: "Bonk Cat", happened: NAME_ONLY, keys: [], by: "server", source: "name" });
  assert.equal(NAME_ONLY, "Name only: no description, picture or post");
  assert.deepEqual(f({ description: "a cat that bonks people on the head" }), { subject: "Bonk Cat", happened: "a cat that bonks people on the head", keys: [], by: "server", source: "description", quote: true });
  assert.deepEqual(f({ post: "the cat bonked a dog on stream https://t.co/x" }), { subject: "Bonk Cat", happened: "the cat bonked a dog on stream", keys: [], by: "server", source: "post", quote: true });
  // a description that may not be quoted: hype, a call to buy, noise, launcher text
  assert.equal(f({ description: "Deployed using https://j7tracker.io" }).happened, NAME_ONLY, "launcher text is no description");
  for (const description of ["next 100x gem, send it", "buy now before it is too late", "lol"]) assert.equal(f({ description }).happened, "Name only: description not read yet", description);
  assert.equal(f({ image: true }).happened, "Name only: picture not read yet");
  assert.equal(f({ image: true, description: "lol", post: "Sending 10%" }).happened, "Name only: description, picture and post not read yet");
  // read by the model, nothing stated: no quote (the model judged it), what it read named
  assert.equal(f({ read: true, description: "a cat that bonks people", image: true, hadImg: true }).happened, "Name only: its description and picture name no clear subject");
  assert.equal(f({ read: true, description: "a cat that bonks people", image: true }).happened, "Name only: its description names no clear subject; picture not read yet");
  assert.equal(f({ read: true, image: true }).happened, "Name only: picture not read yet");
  assert.equal(f({ read: true }).happened, NAME_ONLY);
  // read, but its line failed the checks: the coin's own words may still be quoted
  assert.equal(f({ read: true, dropped: true, description: "a cat that bonks people on the head" }).quote, true);
  // a name the block list refuses is never the subject
  assert.equal(coinServerLine({ name: "badword", symbol: "OKAY" }, { flag }).subject, "OKAY");
  assert.equal(coinServerLine({ name: "badword", symbol: "badword" }, { flag }).subject, "This coin");
});

test("a coin's story line: the model's stored line when it wrote one under this version, else the server's", () => {
  const m = { read: true, line: { subject: "Moo Deng", happened: "Baby pygmy hippo at a zoo in Thailand", keys: ["pygmy hippo", "nope"], source: "description" }, hadImg: false };
  assert.deepEqual(coinStoryLine(m, { name: "Moo Deng" }), { subject: "Moo Deng", happened: "Baby pygmy hippo at a zoo in Thailand", keys: ["pygmy hippo"], by: "model", source: "description" }, "keys are checked again on the way out");
  assert.deepEqual(coinStoryLine({ ...m, read: false }, { name: "Moo Deng" }).by, "server", "a line made under an older version is not shown");
  assert.equal(coinStoryLine(null, { name: "X" }).happened, NAME_ONLY);
  assert.equal(storedLine('{"dropped":true}'), null);
  assert.equal(storedLine("not json"), null);
  assert.equal(nameOnly({ source: "name" }), true);
});

test("the card header: the most-bought coin whose line says more than its name, a model's line first; kept while it holds; never a counted sentence", () => {
  const row = (mint, buyers, storyLine, o = {}) => ({ mint, symbol: mint.toUpperCase(), name: `${mint} coin`, tf: { buyers }, buyers5m: buyers, storyLine, ...o });
  const model = (s, h) => ({ subject: s, happened: h, keys: [], by: "model", source: "description" });
  const quote = (h) => ({ subject: "Q", happened: h, keys: [], by: "server", source: "description", quote: true });
  const nameOnlyL = (n, h = NAME_ONLY) => ({ subject: n, happened: h, keys: [], by: "server", source: "name" });
  const rows = [row("a", 9, nameOnlyL("a coin")), row("b", 5, quote("the hippo sleeps")), row("c", 3, model("Moo Deng", "Baby hippo at a zoo")), row("d", 4, { ...model("Moo Deng", "Hippo learns to swim"), keys: ["swim"] })];
  const h = headerLine(rows);
  assert.deepEqual(h, { mint: "d", line: { subject: "Moo Deng", happened: "Hippo learns to swim", kind: "event", by: "model", quote: false, chips: ["ai", "coin_line"], keys: ["swim"], of: { mint: "d", symbol: "D" } } });
  assert.equal(headerLine(rows, { keep: "c" }).mint, "c", "the coin chosen before stays while it has a model's line");
  assert.equal(headerLine(rows, { keep: "b" }).mint, "d", "a quote does not hold the header against a model's line");
  assert.deepEqual(headerLine(rows.slice(0, 2), { grouped: true }).line, { subject: "Q", happened: "the hippo sleeps", kind: "thin", by: "server", quote: true, chips: ["coin_line", "ai_group"], of: { mint: "b", symbol: "B" } });
  // nothing but names: one row keeps its own line; several their shared name and what they lack
  assert.deepEqual(headerLine([row("a", 1, nameOnlyL("Whited"))]).line, { subject: "Whited", happened: NAME_ONLY, kind: "thin", by: "server", quote: false, chips: [] });
  const many = (lines) => headerLine(lines.map((l, i) => row(`w${i}`, 1, l, { name: `Whited ${i}`, symbol: `W${i}` })), { familySymbol: "PAR" }).line;
  assert.deepEqual(many([nameOnlyL("x"), nameOnlyL("y")]), { subject: "Whited", happened: NAME_ONLY_MANY, kind: "thin", by: "server", quote: false, chips: [] });
  assert.equal(many([nameOnlyL("x"), nameOnlyL("y", "Name only: picture not read yet")]).happened, NAME_ONLY_UNREAD);
  assert.equal(many([nameOnlyL("x", "Name only: its picture names no clear subject"), nameOnlyL("y")]).happened, NAME_ONLY_SOME);
  assert.equal(headerLine([row("a", 1, nameOnlyL("a")), row("b", 1, nameOnlyL("b"))], { familySymbol: "PAR" }).line.subject, "$PAR", "no shared word: the family's ticker");
  assert.equal(headerLine([row("a", 1, nameOnlyL("a")), row("b", 1, nameOnlyL("b"))], { title: "turkey pardon" }).line.subject, "Turkey pardon");
  assert.deepEqual(headerLine([]), { mint: null, line: null });
  for (const l of [h.line, many([nameOnlyL("x"), nameOnlyL("y")])]) assert.doesNotMatch(l.happened, /\d+ coins|are named|launched under/);
});

// ---------------------------------------------------------------- storage and the tagger
function fakeModel() {
  const m = { coins: new Map(), mints: new Map(), meta: new Map(), nameOf: (mint) => ({ name: m.mints.get(mint)?.name ?? null, symbol: m.mints.get(mint)?.symbol ?? null }), metaFor: (c) => m.meta.get(c.mint) ?? null };
  m.add = (mint, o = {}) => { m.coins.set(mint, { mint, quoteMint: null, createdAt: null, tracked: true }); m.mints.set(mint, { name: o.name ?? `${mint} coin`, symbol: o.symbol ?? mint.toUpperCase(), uri: `uri:${mint}` }); m.meta.set(mint, { description: "description" in o ? o.description : "says what it is about", twitter: null, website: null }); return mint; };
  return m;
}
function tagger(o = {}) {
  const clock = fakeClock(T0 * 1000), db = o.db ?? new Db(":memory:"), model = o.model ?? fakeModel();
  const t = new NarrTags({ model, db, cfg: { on: true, model: DEFAULT_MODEL, dailyUsd: 1, minBuyers: 10, keyFile: null }, clientFactory: o.client, now: clock.now, perMin: 600, hotFillMs: 0, log: quiet });
  return { t, clock, db, model };
}

test("the engine stores each coin's checked line beside its tag; a line that fails is stored as dropped and the tag stands; stats count them", async () => {
  const store = new MemoryTagStore(), clock = fakeClock(T0 * 1000);
  const client = fakeClient((req) => reply(sentCoins(req).map((c) => (c.symbol === "MOODENG" ? fresh(c.n, "moo deng the hippo", L("Moo Deng", "Baby pygmy hippo at a zoo in Thailand", ["pygmy hippo", "Moo Deng"])) : c.symbol === "HYPE" ? fresh(c.n, "moo deng the hippo", L("Moo Deng", "Baby hippo is the next big gem")) : none(c.n)))));
  const e = new TagEngine({ store, clientFactory: client, now: clock.now, log: quiet });
  const r = await e.tag([hippo, { ...hippo, mint: "hype", symbol: "HYPE" }, { ...hippo, mint: "bare", symbol: "BARE" }]);
  assert.equal(r.ok, true);
  assert.deepEqual(store.tagGet("hippo").line, { subject: "Moo Deng", happened: "Baby pygmy hippo at a zoo in Thailand", keys: ["pygmy hippo"], source: "description" }, "a key phrase not in the sentence is dropped");
  assert.deepEqual([store.tagGet("hippo").lineV, store.tagGet("hype").narrativeId, store.tagGet("hype").line, store.tagGet("bare").line, store.tagGet("bare").lineV], [2, 1, { dropped: true }, null, 2]);
  assert.deepEqual([e.stats.linesKept, e.stats.linesDropped, e.stats.linesEmpty, e.stats.lastLineDrop], [1, 1, 1, "hype"]);
  assert.deepEqual([...r.lines.keys()], ["hippo", "hype", "bare"]);
});

test("sqlite: line and line_v are added to an older coin_tags, an older row reads without them, a line-only write keeps the tag, counts skip dropped lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-coinline-"));
  try {
    const file = join(dir, "t.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE coin_tags (mint TEXT PRIMARY KEY, narrative_id INTEGER, tagged_at INTEGER NOT NULL, model TEXT, asks INTEGER NOT NULL DEFAULT 1, had_post INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID");
    raw.prepare("INSERT INTO coin_tags (mint, narrative_id, tagged_at, model) VALUES ('old', 3, 1, 'm')").run();
    raw.close();
    const db = new Db(file);
    try {
      assert.deepEqual(db.tagGet("old"), { mint: "old", narrativeId: 3, at: 1, model: "m", asks: 1, hadPost: false, bare: false, hadImg: false }, "an older row: no line fields");
      assert.equal(db.tagLineSet({ mint: "old", line: { subject: "A", happened: "B c d", keys: [], source: "name" }, lineV: 1 }), true);
      assert.deepEqual(db.tagGet("old"), { mint: "old", narrativeId: 3, at: 1, model: "m", asks: 1, hadPost: false, bare: false, hadImg: false, line: { subject: "A", happened: "B c d", keys: [], source: "name" }, lineV: 1 });
      assert.equal(db.tagLineSet({ mint: "nope", line: null, lineV: 1 }), false);
      db.tagSet({ mint: "dropped", narrativeId: null, at: 2, model: "m", line: { dropped: true }, lineV: 1 });
      db.tagSet({ mint: "empty", narrativeId: null, at: 2, model: "m", line: null, lineV: 1 });
      assert.deepEqual([db.tagLineCount(), db.tagCounts(), db.tagGet("empty").line, db.tagGet("dropped").line], [1, { tagged: 1, none: 2 }, null, { dropped: true }]);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("re-read for the line alone: a listed coin answered before lines waits once, most 5-minute buyers first, in the same queue; its tag is kept; health counts it", async () => {
  const db = new Db(":memory:"), model = fakeModel();
  applyTagRules(db, quiet); // a database on the current tag rules: what is stored stays
  for (const m of ["a", "b", "c", "gone", "fresh"]) model.add(m, { description: `${m} is a hippo at a zoo` });
  const id = db.narrAdd({ title: "hippo story", theme: "animals", key: "hippo story", at: T0 - 500 });
  for (const m of ["a", "b", "c"]) db.tagSet({ mint: m, narrativeId: m === "c" ? null : id, at: T0 - 400, model: DEFAULT_MODEL, asks: 2 });
  db.tagSet({ mint: "gone", narrativeId: null, at: T0 - 10, model: "gave-up", asks: 2 });
  db.tagSet({ mint: "fresh", narrativeId: id, at: T0 - 400, model: DEFAULT_MODEL, line: { subject: "Fresh", happened: "fresh is a hippo at a zoo", keys: [], source: "description" }, lineV: COIN_LINE_VERSION });
  const client = fakeClient((req) => reply(sentCoins(req).map((c) => fresh(c.n, "some other story", L(c.name, `${c.symbol.toLowerCase()} is a hippo at a zoo`)))));
  const { t } = tagger({ db, model, client });
  for (const m of ["a", "b", "c", "gone", "fresh", "never"]) t.tagOf(m); // the stories build reads each row's answer first
  t.reline("a", 2); t.reline("b", 9); t.reline("c", 5); t.reline("gone", 50); t.reline("fresh", 50); t.reline("never", 50);
  t.reline("a", 3); // offered again: its buyers are updated, it waits once
  assert.equal(t.pending(), 3, "only coins with an answer made before lines; not a given-up coin, one with its line, or one never answered");
  assert.equal(t.snapshot().lines.rereadWaiting, 3);
  await t.pump();
  assert.deepEqual(sentCoins(client.calls[0]).map((c) => c.symbol), ["B", "C", "A"], "most buyers of the last 5 minutes first");
  // the tags stand (no narrative made for "some other story"); only the lines were written
  assert.deepEqual(["a", "b", "c"].map((m) => db.tagGet(m).narrativeId), [id, id, null]);
  assert.equal(db.narrByKey("some other story"), null);
  assert.deepEqual(db.tagGet("b").line, { subject: "b coin", happened: "b is a hippo at a zoo", keys: [], source: "description" });
  assert.deepEqual(t.storyLineOf("b"), { read: true, line: { subject: "b coin", happened: "b is a hippo at a zoo", keys: [], source: "description" }, hadImg: false, dropped: false });
  assert.equal(t.tagOf("a").title, "hippo story");
  // once: offered again, nothing waits
  for (const m of ["a", "b", "c"]) t.reline(m, 99);
  assert.equal(t.pending(), 0);
  const h = t.snapshot();
  assert.deepEqual([h.lines.version, h.lines.reread, h.lines.rereadWaiting, h.lines.kept, h.lines.stored, h.tagged, h.none], [2, 3, 0, 3, 4, 3, 2]);
  assert.equal(client.calls.length, 1);
  assert.ok(RELINE_MAX >= 100);
  t.stop(); db.close();
});

test("a re-read that keeps failing is given up for its line only: the tag stays and the coin is not read again for it", async () => {
  const db = new Db(":memory:"), model = fakeModel();
  applyTagRules(db, quiet);
  model.add("a");
  db.tagSet({ mint: "a", narrativeId: null, at: T0 - 400, model: DEFAULT_MODEL, asks: 2 });
  const client = fakeClient(() => reply([])); // a usable reply with no answer for the coin
  const { t } = tagger({ db, model, client });
  t.tagOf("a"); t.reline("a", 4);
  for (let i = 0; i < 4 && t.pending(); i++) await t.pump();
  assert.deepEqual([db.tagGet("a").model, db.tagGet("a").asks, db.tagGet("a").line, db.tagGet("a").lineV, t.snapshot().lines.rereadGaveUp], [DEFAULT_MODEL, 2, { dropped: true }, 2, 1]);
  t.reline("a", 4);
  assert.equal(t.pending(), 0);
  t.stop(); db.close();
});

test("the checks: a coin line never carries a prediction, a promise of gain or a call to act, attributed or not, picture or not", () => {
  const d = { name: "Pepe King", symbol: "PK", description: "Pepe King will make every holder rich. Buy now before it pumps, guaranteed gains", website: null, twitter: null, post: null };
  for (const [happened, picture] of [
    ["Pepe King will make every holder rich", false],
    ["Holders should buy now before it pumps", false],
    ["Buy now before it pumps, guaranteed gains, per its description", false],
    ["A frog that will go up a lot", true],
    ["A frog; buy before it's gone", true],
    ["A frog; before it’s gone", true],
    ["A frog that is going to double", true],
    ["A frog; don't miss it", true],
  ]) assert.equal(checkCoinLine(L("Pepe King", happened), d, { picture }).why, "promise", happened);
  assert.equal(checkCoinLine(L("Rich Frog", "A frog in a crown"), d, { picture: true }).why, "promise", "the subject is checked too");
  assert.equal(checkCoinLine(L("Pepe King", "A green frog wearing a crown"), d, { picture: true }).why, null);
  assert.equal(checkCoinLine(L("Pepe King", "A frog that can run fast and grow a beard, per its description"), { ...d, description: "the frog can run fast and grow a beard" }).why, null, "ordinary words stay");
  // the server's own line refuses to quote the same description: the coin falls back to Name only
  assert.match(coinServerLine({ name: "Pepe King", symbol: "PK", description: d.description, post: null, image: false, read: true, dropped: true }).happened, /^Name only/);
});

test("a headline, not a report: a line that opens with its source is refused (\"opener\"); a light attribution at the end stays", () => {
  const d = { name: "Fries Cat", symbol: "TATO", description: "a cat inside a McDonald's fries bag labeled tato; one small step for MoonBoy", website: "people.com/viral-pygmy-hippo-moo-deng", twitter: null, post: { handle: "zoo", text: "Elon Musk posted a frog" } };
  for (const happened of [
    "Description says it is a cat inside a fries bag",
    "Picture shows a cat inside a McDonald's fries bag labeled tato",
    "Site points to a People article about a viral pygmy hippo",
    "Linked post says Elon Musk posted a frog",
    "Post says Elon Musk posted a frog",
    "The description says a cat in a fries bag",
    "Its picture: a cat in a fries bag",
    "This coin is a cat in a fries bag",
    "The coin refers to a cat in a fries bag",
    "Token shows a cat in a fries bag",
    "Per its description, a cat in a fries bag",
    "According to its post, Elon Musk posted a frog",
    "“Description says a cat in a fries bag”",
    "X post says a cat in a fries bag",
    "Linked X post says a cat in a fries bag",
    "Their post says a cat in a fries bag",
    "Ticker refers to a cat in a fries bag",
    "Name refers to a cat in a fries bag",
    "Name means a cat in a fries bag",
    "Dev says a cat in a fries bag",
    "The dev's post says a cat in a fries bag",
    "Symbol: a cat in a fries bag",
  ]) {
    assert.equal(lineOpener(happened), true, happened);
    assert.deepEqual(checkCoinLine(L("Fries cat", happened), d, { picture: true }), { line: null, why: "opener" }, happened);
  }
  // the owner's examples of the new style pass, and so does a rare attribution at the end
  for (const [subject, happened] of [
    ["Fries cat", "A cat peeking out of a McDonald's fries bag"],
    ["Moo Deng", "People article on viral pygmy hippo Moo Deng"],
    ["Elon Musk", "Elon Musk posted a frog, per its post"],
    ["MoonBoy", "One small step for MoonBoy"],
  ]) {
    assert.equal(lineOpener(happened), false, happened);
    assert.equal(checkCoinLine(L(subject, happened), d, { picture: true }).why, null, happened);
  }
  // words that only look like a source stay: a name, a kind of thing, a source word later in the line
  for (const happened of ["Post Malone fan art", "Page Six story on a hippo", "Token of love from a frog", "Pictures of cats in hats", "Text message meme from a dog", "Launchpad linking Hyperliquid perps to coins", "Name tag on a frog", "Dev team meme from a cat", "Ticker tape parade for a dog", "X marks the spot treasure map"]) assert.equal(lineOpener(happened), false, happened);
  assert.equal(lineOpener(""), false);
  assert.equal(lineOpener(null), false);
  // the instructions ask for the headline and name the openers to avoid; the old "Description says ..." example is gone
  for (const t of [SYSTEM_TEXT, SYSTEM_TEXT_PICTURES]) {
    assert.match(t, /Aim for 6 to 12 words/);
    assert.match(t, /Never open with the source \("Description says", "Picture shows", "Site points to", "Linked post says", "This coin is"\)/);
    assert.match(t, /"A cat peeking out of a McDonald's fries bag"/);
    assert.match(t, /per its post/);
    assert.doesNotMatch(t, /An opinion, a claim or a plan is attributed: "Description says/);
  }
});

test("quotes in full-width or styled letters are shown and checked in their plain form", () => {
  assert.equal(plainQuote("Ｂｉｌｌｉｏｎｓ Ｍｕｓｔ Ｍｉｄｃｕｒｖｅ"), "Billions Must Midcurve");
  assert.equal(plainQuote("𝐁𝐢𝐥𝐥𝐢𝐨𝐧𝐬  must\n\u00a0 𝘮𝘪𝘥𝘤𝘶𝘳𝘷𝘦"), "Billions must midcurve");
  assert.equal(plainQuote(null), "");
  assert.equal(quoteText("Ｂｉｌｌｉｏｎｓ Ｍｕｓｔ Ｍｉｄｃｕｒｖｅ", [], { flag }), "Billions Must Midcurve");
  // the checks read the plain form: a call to buy in full-width letters is refused like the plain one
  assert.equal(quoteText("ｂｕｙ ｎｏｗ ｂｅｆｏｒｅ ｉｔ ｉｓ ｔｏｏ ｌａｔｅ", [], { flag }), null);
  assert.equal(quoteText("ａ ｃａｔ ｔｈａｔ ｉｓ ａ ｂａｄｗｏｒｄ", [], { flag }), null, "the block list reads the plain form");
  // the server's coin line quotes the plain form
  const l = coinServerLine({ name: "Billions", symbol: "BMM", description: "Ｂｉｌｌｉｏｎｓ Ｍｕｓｔ Ｍｉｄｃｕｒｖｅ" }, { flag });
  assert.deepEqual([l.happened, l.quote, l.source], ["Billions Must Midcurve", true, "description"]);
});

test("version 2: a coin whose line was written under version 1 (\"Description says ...\") is not shown and is read once more for its line", async () => {
  const db = new Db(":memory:"), model = fakeModel();
  applyTagRules(db, quiet);
  model.add("old", { name: "Fries Cat", symbol: "TATO", description: "a cat inside a McDonald's fries bag" });
  db.tagSet({ mint: "old", narrativeId: null, at: T0 - 400, model: DEFAULT_MODEL, asks: 1, line: { subject: "Fries Cat", happened: "Description says it is a cat inside a McDonald's fries bag", keys: [], source: "description" }, lineV: 1 });
  const client = fakeClient((req) => reply(sentCoins(req).map((c) => none(c.n, L("Fries cat", "A cat inside a McDonald's fries bag", ["fries bag"])))));
  const { t } = tagger({ db, model, client });
  t.tagOf("old");
  assert.equal(t.storyLineOf("old").read, false, "a version 1 line is not shown as read");
  t.reline("old", 3);
  assert.equal(t.pending(), 1);
  await t.pump();
  assert.deepEqual([db.tagGet("old").lineV, db.tagGet("old").line.happened], [COIN_LINE_VERSION, "A cat inside a McDonald's fries bag"]);
  assert.equal(t.storyLineOf("old").read, true);
  t.reline("old", 3);
  assert.equal(t.pending(), 0, "once");
  t.stop(); db.close();
});
