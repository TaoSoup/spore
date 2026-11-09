// Owner briefs (DESIGN §13.3): the briefs file (validation, atomic mode-600 writes, re-read on
// change), the CLI (set / get / clear / list, --file -, refusals), the designer with a brief (the
// prompt carries it; people mode lets real names and big-coin tickers through but never a person
// already launched under the root, by ticker, name or person key; the fallback list skips them),
// the runner and live layer (people logo prompt, tribute line in the launch description) and the
// agent view's `brief`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBrief, setBrief, clearBrief, readBriefsFile, briefsFile, createBriefStore, validBriefs, BriefError, BRIEF_MAX } from "../lib/agents/brief.mjs";
import { checkIdea, design, designContext, fallbackPeople, ideaPrompt, rubric, CANDIDATES } from "../lib/agents/designer.mjs";
import { FAMOUS_PEOPLE, personKey, neverPerson } from "../lib/agents/people.mjs";
import { fallbackProfile, profileInput } from "../lib/agents/profile.mjs";
import { normalizeWord } from "../lib/agents/blocklist.mjs";
import { purposeDescription, tributeLine } from "../lib/agents/purpose.mjs";
import { AgentRegistry, agentView } from "../lib/agents/registry.mjs";
import { AgentRunner } from "../lib/agents/runner.mjs";
import { renderLogo } from "../lib/agents/logo.mjs";
import { IMAGE_PROMPT, PEOPLE_IMAGE_PROMPT } from "../lib/agents-live/imagegen.mjs";
import { drawLogo } from "../lib/agents-live/ailogo.mjs";
import { LiveAgents, routedLlm } from "../lib/agents-live/live.mjs";
import { AgentVault, initVaultKey, readVaultKey } from "../lib/agents-live/vault.mjs";
import { snapshot } from "../lib/agents-live/budget.mjs";
import { agentTree, fakeLlm, K, PLATFORM, quiet } from "./helpers/agents.mjs";
import { T22 } from "./helpers/tree.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "../scripts/agent-brief.mjs");
const HUMAN = "F1RUMAdxEwYkbUNF2Kz64yHC8iXmzsqGW7w9mUog75Br";
const BRIEF = "Launch one coin per famous real human: name = the person's full name (Elon Musk), ticker = the name they go by (ELON). Never the same person twice.";
const dirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "spore-brief-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const warnings = () => { const seen = []; return { seen, info() {}, warn: (m) => seen.push(m), error() {} }; };
// Windows has no POSIX permission bits (statSync reports 666 whatever mode a file was written with;
// lib/agents-live/vault.mjs skips its mode check there too), so the mode is checked elsewhere only.
const assertMode600 = (file) => { if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600); };
const peopleCtx = (o = {}) => ({ rootMint: HUMAN, rootSymbol: "HUMAN", rootName: "Human", brief: { text: BRIEF, mode: "people" }, childSymbols: new Set(), childNames: new Set(), childPersons: new Set(), topSymbols: new Set(["TRUMP", "ELON", "BONK"]), ...o });
const person = (name, symbol, description = `${name}: one of a kind.`) => ({ name, symbol, description });

// ---------------------------------------------------------------- the file
test("cleanBrief: plain text up to 1 200 characters, whitespace tidied, no links or markup, mode people | free", () => {
  assert.deepEqual(cleanBrief({ text: "  Famous   people,\r\n\r\n\r\n one per coin.  ", mode: "people" }), { text: "Famous people,\n\none per coin.", mode: "people" });
  assert.equal(cleanBrief({ text: "x" }).mode, "free", "free by default");
  assert.equal(cleanBrief({ text: "x", mode: "PEOPLE" }).mode, "people");
  assert.equal(cleanBrief({ text: "y".repeat(BRIEF_MAX) }).text.length, BRIEF_MAX);
  for (const [text, re] of [["", /empty/], ["   ", /empty/], ["y".repeat(BRIEF_MAX + 1), /at most 1200/], ["see https://evil.example", /links/], ["visit www.example", /links/], ["go to pump.fun now", /links/], ["[here](x)", /links/],
    ["<b>bold</b>", /plain text/], ["use `code`", /plain text/], ["bell\u0007", /control/]]) assert.throws(() => cleanBrief({ text }), (e) => e instanceof BriefError && re.test(e.message), text);
  assert.throws(() => cleanBrief({ text: 5 }), BriefError);
  assert.throws(() => cleanBrief({ text: "ok", mode: "celebs" }), /mode must be one of people, free/);
  assert.doesNotThrow(() => cleanBrief({ text: "Elon Musk, Donald J. Trump & Lionel Messi: e.g. 1.5 coins? No. A.I. founders too." }));
});

test("set / clear: atomic JSON in DATA_DIR/agents/briefs.json, mode 600; the store re-reads only on change and ignores what does not validate", () => {
  const dir = scratch(), file = briefsFile(dir);
  assert.equal(file, join(dir, "agents", "briefs.json"));
  assert.deepEqual(readBriefsFile(file), {}, "missing file = no briefs");
  const log = warnings();
  const store = createBriefStore(dir, { log });
  assert.equal(store.get(HUMAN), null);
  const b = setBrief(file, HUMAN, { text: BRIEF, mode: "people", now: 1_792_500_000 });
  assert.deepEqual(b, { text: BRIEF, mode: "people", setAt: 1_792_500_000 });
  assertMode600(file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { [HUMAN]: b });
  assert.deepEqual(store.get(HUMAN), b, "picked up without a restart");
  assert.equal(store.get(K.ROOT), null);
  setBrief(file, K.ROOT, { text: "Only cat coins.", now: 5 });
  assert.equal(store.get(K.ROOT).mode, "free");
  assert.equal(Object.keys(store.all()).length, 2);
  assert.throws(() => setBrief(file, "not-a-mint", { text: "x" }), /mint/);
  assert.throws(() => setBrief(file, HUMAN, { text: "http://x.example" }), /links/);
  assert.equal(store.get(HUMAN).text, BRIEF, "a refused set leaves the file as it was");
  assert.equal(clearBrief(file, K.ROOT), true); assert.equal(clearBrief(file, K.ROOT), false);
  assert.equal(store.get(K.ROOT), null);
  assertMode600(file);
  // A hand-edited file: invalid entries are dropped (warned), a broken file means no briefs, never a crash.
  writeFileSync(file, JSON.stringify({ [HUMAN]: { text: "Famous people.", mode: "people", setAt: 9 }, bad: { text: "x" }, [K.A]: { text: "<script>", mode: "free" } }));
  assert.deepEqual(store.get(HUMAN), { text: "Famous people.", mode: "people", setAt: 9 });
  assert.equal(store.get(K.A), null);
  assert.match(log.seen.at(-1), /2 briefs ignored/);
  writeFileSync(file, "{ not json");
  assert.equal(store.get(HUMAN), null);
  assert.match(log.seen.at(-1), /briefs file ignored/);
  assert.deepEqual(validBriefs([1]).briefs, {});
});

// ---------------------------------------------------------------- the CLI
function cli(dir, args, input = null) {
  const env = { ...process.env }; delete env.DATA_DIR;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args, "--data", dir], { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

test("CLI: set (inline and --file -), get, list, clear; refusals exit 1, usage errors exit 2", async () => {
  const dir = scratch();
  const set = await cli(dir, ["set", HUMAN, "Famous", "people,", "one", "per", "coin.", "--mode", "people"]);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, new RegExp(`^brief set for ${HUMAN} \\(mode people, 28 characters\\)`));
  assertMode600(briefsFile(dir));
  const get = await cli(dir, ["get", HUMAN]);
  assert.equal(get.code, 0, get.stderr);
  const g = JSON.parse(get.stdout);
  assert.equal(g.root, HUMAN); assert.equal(g.text, "Famous people, one per coin."); assert.equal(g.mode, "people"); assert.ok(Number.isInteger(g.setAt)); assert.match(g.setAtIso, /^\d{4}-\d\d-\d\dT/);
  const stdin = await cli(dir, ["set", HUMAN, "--file", "-", "--mode", "people"], `${BRIEF}\n`);
  assert.equal(stdin.code, 0, stdin.stderr);
  assert.equal(JSON.parse((await cli(dir, ["get", HUMAN])).stdout).text, BRIEF);
  const fromFile = join(dir, "brief.txt"); writeFileSync(fromFile, "Only frogs.");
  assert.equal((await cli(dir, ["set", K.ROOT, "--file", fromFile])).code, 0);
  const list = await cli(dir, ["list"]);
  assert.equal(list.code, 0);
  assert.match(list.stdout, new RegExp(`${HUMAN}\\s+people\\s+\\d{4}-.*Launch one coin per famous real human`));
  assert.match(list.stdout, new RegExp(`${K.ROOT}\\s+free\\s+.*Only frogs\\.`));
  const refused = await cli(dir, ["set", HUMAN, "see https://x.example"]);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /refused: the brief must not contain links/);
  assert.equal((await cli(dir, ["set", HUMAN, "ok", "--mode", "celebs"])).code, 1);
  assert.equal(JSON.parse((await cli(dir, ["get", HUMAN])).stdout).text, BRIEF, "refusals change nothing");
  assert.match((await cli(dir, ["clear", K.ROOT])).stdout, /brief cleared/);
  assert.match((await cli(dir, ["clear", K.ROOT])).stdout, /no brief/);
  const none = await cli(dir, ["get", K.ROOT]);
  assert.equal(none.code, 1); assert.match(none.stderr, /no brief for/);
  for (const args of [[], ["nope"], ["set"], ["get"], ["set", HUMAN]]) assert.equal((await cli(dir, args)).code, 2, args.join(" "));
  assert.equal((await cli(dir, ["get", "bad-mint"])).code, 2);
});

// ---------------------------------------------------------------- the designer
test("people mode filters: real names and big-coin tickers pass; a person already under the root never does (ticker, name or person key)", () => {
  const plain = { rootSymbol: "HUMAN", childSymbols: new Set(), childNames: new Set(), topSymbols: new Set(["TRUMP"]) };
  assert.match(checkIdea(person("Donald Trump", "TRUMP"), plain), /person/, "without a brief real people stay refused");
  assert.match(checkIdea(person("Trump Cat", "TCAT"), { ...plain, brief: { text: "cats", mode: "free" } }), /person/, "a free brief keeps the people filter");
  assert.match(checkIdea(person("Big Coin", "BONKX"), { ...plain, topSymbols: new Set(["BONKX"]) }), /biggest coins/);
  assert.equal(checkIdea(person("Big Coin", "BONKX"), { ...plain, topSymbols: new Set(["BONKX"]), brief: { text: "x", mode: "free" } }), null, "a free brief skips the biggest-coins filter");
  const ctx = peopleCtx({ childSymbols: new Set(["ELON"]), childNames: new Set([normalizeWord("Elon Musk")]), childPersons: new Set([personKey("Elon Musk"), personKey("Lionel Messi")]) });
  assert.equal(checkIdea(person("Donald Trump", "TRUMP"), ctx), null, "TRUMP passes although one of the biggest coins uses it");
  assert.equal(checkIdea(person("Taylor Swift", "SWIFT", "Taylor Swift: the soundtrack of a billion lives, from Nashville to every stadium on Earth."), ctx), null);
  assert.equal(checkIdea(person("Humane Being", "HUMANE"), ctx), null, "near the root's ticker is fine for a briefed root");
  assert.match(checkIdea(person("Elon Musk", "MUSK"), ctx), /already has this name/, "same name, other ticker");
  assert.match(checkIdea(person("Elon R. Musk", "MUSK"), ctx), /this person already has a coin/, "same person, other spelling");
  assert.match(checkIdea(person("Leo Messi", "MESSI"), { ...ctx, childPersons: new Set([personKey("Leo Messi")]) }), /this person already has a coin/);
  assert.match(checkIdea(person("Space Guy", "ELON"), ctx), /already used by a child/, "same ticker, other name");
  assert.match(checkIdea(person("Lionel Messi", "MESSI10"), ctx), /this person already has a coin/);
  assert.match(checkIdea(person("Donald Trump", "TRUMP"), { ...ctx, proposedSymbols: new Set(["TRUMP"]) }), /already proposed \$TRUMP/);
  assert.match(checkIdea(person("Donald J. Trump", "DJT"), { ...ctx, proposedNames: new Set([personKey("Donald Trump")]) }), /already proposed this person/);
  assert.match(checkIdea(person("Nikola Tesla", "TESLA"), ctx), /brand \(tesla\)/, "brands stay out of the name and ticker");
  assert.equal(checkIdea(person("Jensen Huang", "JENSEN", "Jensen Huang: turned Nvidia chips into the engine of the AI age."), ctx), null, "a description may name the brand the person built");
  assert.match(checkIdea(person("Adolf Hitler", "ADOLF"), ctx), /never launch \(adolf hitler\)/);
  assert.match(checkIdea(person("Some Name", "HITLER"), ctx), /ticker names a person agents never launch/);
  assert.match(checkIdea(person("Jeffrey Epstein", "JEFF"), ctx), /never launch/);
  assert.equal(neverPerson("Ted Lasso"), null);
  assert.equal(personKey("Martin Luther King Jr."), "martin king"); assert.equal(personKey("Donald J. Trump"), personKey("Donald Trump")); assert.equal(personKey("Pelé"), "pele");
  // The rubric of a briefed root: uniqueness neutral, fit = the rank, brevity neutral in people mode.
  const r0 = rubric({ ...person("Cristiano Ronaldo", "RONALDO"), rank: 0 }, { themes: ["human"] }, ctx), r3 = rubric({ ...person("Bob", "BOB"), rank: 3 }, { themes: [] }, ctx);
  assert.equal(r0.uniqueness, 1); assert.equal(r0.brevity, 1); assert.equal(r0.fit, 1);
  assert.ok(r0.total > r3.total, "the first-ranked person wins whatever the name length");
});

test("fallback people: ~350 famous people, valid and distinct; launched or proposed ones skipped; fame order with seeded variety", () => {
  assert.ok(FAMOUS_PEOPLE.length >= 300, `${FAMOUS_PEOPLE.length}`);
  assert.equal(new Set(FAMOUS_PEOPLE.map((p) => p.symbol)).size, FAMOUS_PEOPLE.length, "distinct tickers");
  assert.equal(new Set(FAMOUS_PEOPLE.map((p) => personKey(p.name))).size, FAMOUS_PEOPLE.length, "distinct people");
  for (const want of [["Elon Musk", "ELON"], ["Donald Trump", "TRUMP"], ["Lionel Messi", "MESSI"], ["Cristiano Ronaldo", "RONALDO"], ["Taylor Swift", "SWIFT"], ["Jeff Bezos", "BEZOS"], ["Vitalik Buterin", "VITALIK"], ["Satoshi Nakamoto", "SATOSHI"], ["Albert Einstein", "EINSTEIN"]])
    assert.ok(FAMOUS_PEOPLE.some((p) => p.name === want[0] && p.symbol === want[1]), want.join("/"));
  const ctx = peopleCtx();
  const all = fallbackPeople(ctx, { seed: "x", count: 1_000 });
  assert.equal(all.length, FAMOUS_PEOPLE.length);
  for (const i of all) {
    assert.equal(checkIdea(i, ctx), null, `${i.name}: ${checkIdea(i, ctx)}`);
    assert.ok(i.why.length <= 140 && i.why.includes(`$${i.symbol}`), i.why);
    assert.equal(i.source, "fallback");
  }
  const a = fallbackPeople(ctx, { seed: "1" }), b = fallbackPeople(ctx, { seed: "1" });
  assert.deepEqual(a, b, "seeded");
  assert.equal(a.length, CANDIDATES);
  const top = new Set(FAMOUS_PEOPLE.slice(0, 12).map((p) => p.symbol));
  for (const s of ["1", "2", "3", "4"]) for (const i of fallbackPeople(ctx, { seed: s, count: 3 })) assert.ok(top.has(i.symbol), `${i.symbol} comes from the most famous few`);
  assert.ok(new Set(["1", "2", "3", "4", "5", "6"].map((s) => fallbackPeople(ctx, { seed: s, count: 1 })[0].symbol)).size > 1, "variety between runs");
  const launched = peopleCtx({ childSymbols: new Set(["ELON", "RONALDO"]), childNames: new Set([normalizeWord("Donald Trump")]), childPersons: new Set([personKey("Lionel Messi")]), proposedSymbols: new Set(["SWIFT"]), proposedNames: new Set([personKey("Jeff Bezos")]) });
  const left = fallbackPeople(launched, { seed: "z", count: 1_000 });
  assert.equal(left.length, FAMOUS_PEOPLE.length - 6);
  for (const s of ["ELON", "TRUMP", "MESSI", "RONALDO", "SWIFT", "BEZOS"]) assert.ok(!left.some((i) => i.symbol === s), s);
});

test("design with a people brief: the prompt carries the brief and the taken people; refused ideas fall back to famous people nobody has yet", async () => {
  const { model } = agentTree();
  model.setMint({ mint: K.B, decimals: 6, tokenProgram: T22, name: "Elon Musk", symbol: "ELON", uri: "https://ipfs.io/ipfs/ELON", onchainAt: 2 });
  const profile = fallbackProfile(profileInput(model, K.ROOT));
  const ctx = { ...designContext(model, K.ROOT), brief: { text: BRIEF, mode: "people" }, topSymbols: new Set(["TRUMP"]) };
  assert.ok(ctx.childPersons.has("elon musk"));
  assert.deepEqual(ctx.childLabels.find((l) => l.symbol === "ELON"), { name: "Elon Musk", symbol: "ELON" });
  const llm = fakeLlm([{ ideas: [
    { name: "Elon Musk", symbol: "ELON", description: "Already here.", why: "x" },
    { name: "Elon R. Musk", symbol: "MUSK", description: "Same man.", why: "x" },
    { name: "Donald Trump", symbol: "TRUMP", description: "Donald Trump: made every newsroom on Earth print the name.", why: "The most talked-about human alive gets $TRUMP." },
    { name: "Donald J. Trump", symbol: "DJT", description: "Same man again.", why: "x" },
    { name: "Lionel Messi", symbol: "MESSI", description: "Lionel Messi: the left foot that ended the debate.", why: "Eight World Cup dreams in one ticker." },
  ] }]);
  const d = await design(profile, { mint: K.ROOT, name: "Mushroom Grove", symbol: "GROVE" }, ctx, { llm, log: quiet, seed: "s" });
  assert.equal(d.best.symbol, "TRUMP", "the model's first valid person (rank order), although $TRUMP is a big coin");
  assert.equal(d.best.why, "The most talked-about human alive gets $TRUMP.");
  const why = Object.fromEntries(d.filtered.map((f) => [f.symbol, f.why]));
  assert.match(why.ELON, /already used by a child/); assert.match(why.MUSK, /this person already has a coin/); assert.match(why.DJT, /duplicate person in this batch/);
  assert.ok(d.runnersUp.some((r) => r.symbol === "MESSI"));
  assert.ok(!d.runnersUp.some((r) => r.symbol === "ELON" || r.symbol === "TRUMP"), "the top-up never repeats a person");
  const [system, user] = llm.calls[0].messages;
  assert.match(system.content, /owner has given you a brief: it governs every idea — follow it exactly; it overrides the parent's themes/);
  const sent = JSON.parse(user.content);
  assert.equal(sent.ownerBrief.instruction, "THE OWNER'S BRIEF — follow it exactly; it overrides the themes.");
  assert.equal(sent.ownerBrief.text, BRIEF); assert.equal(sent.ownerBrief.mode, "people");
  assert.ok(sent.takenPeople.includes("Elon Musk ($ELON)"), JSON.stringify(sent.takenPeople));
  assert.ok(sent.rules.some((r) => /full real name/.test(r)) && sent.rules.some((r) => /known by \(ELON, TRUMP, MESSI\)/.test(r)) && sent.rules.some((r) => /endorses/.test(r)));
  assert.ok(!sent.parent.avoid.some((a) => /real people/.test(a)), "the profile's avoid-real-people line is dropped");
  assert.equal(sent.parent.themes, undefined, "the brief replaces the themes");
  // No model: famous people from the list, never one already under the root.
  const fb = await design(profile, { mint: K.ROOT, name: "Mushroom Grove", symbol: "GROVE" }, ctx, { llm: null, log: quiet, seed: "t" });
  assert.equal(fb.best.source, "fallback");
  assert.ok(FAMOUS_PEOPLE.some((p) => p.symbol === fb.best.symbol) && fb.best.symbol !== "ELON");
  assert.equal(fb.filtered.length, 0, "the fallback pre-skips launched people");
  // Without a brief the prompt is the theme prompt as before.
  const plain = JSON.parse(ideaPrompt(profile, { ...ctx, brief: null }));
  assert.equal(plain.ownerBrief, undefined); assert.ok(plain.parent.themes.length >= 3);
  // A free brief: the text governs, the themes stay as context.
  const free = JSON.parse(ideaPrompt(profile, { ...ctx, brief: { text: "Only frog coins.", mode: "free" } }));
  assert.equal(free.ownerBrief.text, "Only frog coins."); assert.ok(Array.isArray(free.parent.themes));
});

// ---------------------------------------------------------------- runner, logo, purpose, live, view
test("runner: the brief is read from DATA_DIR on each run; a people brief proposes a person, the logo gets mode people, the run says so", async () => {
  const dir = scratch();
  const { db, model } = agentTree();
  model.setMint({ mint: K.B, decimals: 6, tokenProgram: T22, name: "Elon Musk", symbol: "ELON", uri: "https://ipfs.io/ipfs/ELON", onchainAt: 2 });
  model.setMint({ mint: K.G, decimals: 6, tokenProgram: T22, name: "Donald Trump", symbol: "TRUMP", uri: "https://ipfs.io/ipfs/TRUMP", onchainAt: 2 }); // a grandchild: $TRUMP is a top coin, not a child
  const registry = new AgentRegistry(db);
  registry.enable(K.ROOT);
  const renders = [];
  let n = 0;
  const llm = fakeLlm([{ ideas: [{ name: "Elon Musk", symbol: "ELON", description: "Taken.", why: "x" }, { name: "Donald Trump", symbol: "TRUMP", description: "Donald Trump: the name every newsroom prints.", why: "The most talked-about human gets $TRUMP." }] }]);
  const runner = new AgentRunner({ registry, model, rpc: { call: async () => { throw new Error("no rpc"); } }, llm, log: quiet, simulate: async () => ({ ok: true, bytes: 900, unitsConsumed: 150_000, err: null, estCostSol: 0.0148, txs: 2 }),
    render: async (opts) => { renders.push(opts); return renderLogo({ symbol: opts.symbol, palette: opts.palette, seed: opts.seed }); }, newId: () => (++n).toString(16).padStart(16, "0"),
    cfg: { mode: "dry", tickSec: 300, minScore: 0, cooldownMin: 60, maxPerHour: 12, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], launchFeeSol: 0, pagesDomain: "spore-2x6.pages.dev", dataDir: dir } });
  // No brief yet: theme ideas (real people refused).
  const before = await runner.runAgent(K.ROOT, { force: true });
  assert.equal(before.brief, null);
  assert.notEqual(before.proposal.symbol, "TRUMP");
  assert.equal(renders[0].mode, undefined);
  setBrief(briefsFile(dir), K.ROOT, { text: BRIEF, mode: "people" });
  const r = await runner.runAgent(K.ROOT, { force: true });
  assert.deepEqual(r.brief, { mode: "people" });
  assert.equal(r.proposal.symbol, "TRUMP"); assert.equal(r.proposal.name, "Donald Trump"); assert.equal(r.proposal.why, "The most talked-about human gets $TRUMP.");
  assert.match(r.proposal.reason, /picked \$TRUMP \(owner's brief \(people\), rank fit 0\.96, brevity 1, uniqueness 1\)/, "ranked second: the model's first idea was a child");
  assert.equal(renders[1].mode, "people"); assert.equal(renders[1].name, "Donald Trump");
  assert.match(JSON.parse(llm.calls.at(-1).messages[1].content).ownerBrief.text, /famous real human/);
  // Next run, model gone: a famous person from the list, neither Elon (a child) nor Trump (already proposed).
  runner.llm = { available: false };
  const r2 = await runner.runAgent(K.ROOT, { force: true });
  assert.ok(FAMOUS_PEOPLE.some((p) => p.symbol === r2.proposal.symbol), r2.proposal.symbol);
  assert.ok(!["ELON", "TRUMP"].includes(r2.proposal.symbol));
  assert.equal(r2.proposal.source, "fallback");
  // The agent view says the agent has a brief (mode and time, not the text).
  const view = agentView(registry.get(K.ROOT), { model, registry, briefs: createBriefStore(dir, { log: quiet }) });
  assert.equal(view.brief.mode, "people"); assert.ok(Number.isInteger(view.brief.setAt)); assert.equal(view.brief.text, undefined);
  assert.equal(agentView(registry.get(K.ROOT), { model, registry }).brief, null);
  runner.stop(); db.close();
});

test("logo: people mode asks the image model for a caricature; a refusal falls back to the SVG/template path; the tribute line in the description", async () => {
  assert.equal(PEOPLE_IMAGE_PROMPT("Elon Musk"), "a bold meme-style caricature portrait of Elon Musk, head and shoulders, flat vivid colours, no text, no logo");
  assert.equal(IMAGE_PROMPT({ name: "Elon Musk", symbol: "ELON", description: "d", mode: "people" }, { palette: ["#0f0"] }), PEOPLE_IMAGE_PROMPT("Elon Musk"));
  assert.match(IMAGE_PROMPT({ name: "Frog Pilot", symbol: "FPILOT", description: "d" }, { palette: ["#0f0"] }), /no real people/, "other coins keep the mascot prompt");
  const prompts = [];
  const refusing = { available: true, generate: async (p) => { prompts.push(p); throw new Error("content policy: real person"); } };
  const r = await drawLogo({ name: "Elon Musk", symbol: "ELON", description: "d", mode: "people" }, { palette: ["#123456"] }, { image: refusing, llm: null, seed: "s", log: quiet });
  assert.deepEqual(prompts, [PEOPLE_IMAGE_PROMPT("Elon Musk")]);
  assert.equal(r.source, "template"); assert.match(r.error, /content policy/); assert.ok(r.png.length > 100);
  // Description: person line, hype line about the person, the purpose, then the tribute line; ≤ 400.
  const d = purposeDescription({ description: "Elon Musk: built the future while the rest of us were still loading.", why: "Eight billion people know Elon Musk. Now they can trade $ELON." }, "HUMAN", { tribute: "Elon Musk" });
  assert.equal(d, "Elon Musk: built the future while the rest of us were still loading. — Eight billion people know Elon Musk. Now they can trade $ELON. · By the $HUMAN agent, built to pump $HUMAN: every trade of this coin buys $HUMAN. Unofficial fan tribute, not affiliated with or endorsed by Elon Musk.");
  const long = purposeDescription({ description: "x ".repeat(140), why: "w".repeat(140) }, "HUMAN", { tribute: "Alexandria Ocasio-Cortez" });
  assert.ok(long.length <= 400 && long.endsWith(tributeLine("Alexandria Ocasio-Cortez")) && long.includes("By the $HUMAN agent"));
  assert.match(purposeDescription({ description: "d", why: "w" }, "HUMAN"), / — Why now: w · /, "other coins unchanged");
});

test("live: a people run passes mode people to the logo and launches with the tribute line", async () => {
  const dir = scratch();
  const keyFile = join(dir, "vault.key"); initVaultKey(keyFile);
  const vault = new AgentVault({ dir: join(dir, "wallets"), vaultKey: readVaultKey(keyFile) });
  const imgDir = join(dir, "agents"); mkdirSync(imgDir, { recursive: true });
  const calls = [];
  const PNG = await renderLogo({ symbol: "E", palette: [], seed: "e" });
  const runner = {
    imgDir, render: null,
    async runAgent() {
      const png = await this.render({ symbol: "ELON", name: "Elon Musk", description: "Elon Musk: rockets.", palette: ["#111"], seed: "p1", mode: "people" });
      writeFileSync(join(imgDir, "p1.png"), png);
      return { proposal: { id: "p1", name: "Elon Musk", symbol: "ELON", description: "Elon Musk: rockets.", why: "Eight billion people know Elon Musk.", sim: { ok: true, estCostSol: 0.02 } }, score: 70, brief: { mode: "people" } };
    },
  };
  const registry = { rows: [{ root_mint: HUMAN, status: "dry" }], list() { return this.rows; }, profileOf() { return { themes: ["human"], palette: ["#111"] }; }, recordRun() {}, markLaunched() {} };
  const model = { solUsd: 100, get(m) { return { mint: m, symbol: "HUMAN", creator: "Creator111111111111111111111111111111111111" }; }, nameOf() { return { symbol: "HUMAN" }; } };
  const deps = {
    vault, ledger: { record() {} },
    readBudget: async () => snapshot({ lamports: 60_000_000, usdcMicros: 0, solUsd: 100 }),
    drawLogo: async (idea) => { calls.push(["drawLogo", idea.name, idea.mode]); return { png: PNG, svg: null, source: "template", error: null }; },
    launchLive: async ({ form }) => { calls.push(["launchLive", form.symbol, form.description]); return { mint: "Mint1111111111111111111111111111111111111111", signatures: ["sig1"], estCostSol: 0.02, metadataUri: "u" }; },
    claimCoin: async () => null,
  };
  const live = new LiveAgents({ runner, router: routedLlm(), registry, model, rpc: {}, metaHost: {}, cfg: { dataDir: dir, vaultKeyFile: keyFile, aiRail: "keyed", claimEveryTicks: 6, launchEveryTicks: 1, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000] }, log: quiet, deps: { ...deps, lock: false } });
  live.ticks = 1;
  const r = await live.runOne(HUMAN);
  assert.ok(r.launched, JSON.stringify(r));
  assert.deepEqual(calls[0], ["drawLogo", "Elon Musk", "people"]);
  assert.equal(calls[1][0], "launchLive"); assert.equal(calls[1][1], "ELON");
  assert.match(calls[1][2], /^Elon Musk: rockets\. — Eight billion people know Elon Musk\. · By the \$HUMAN agent, built to pump \$HUMAN: every trade of this coin buys \$HUMAN\. Unofficial fan tribute, not affiliated with or endorsed by Elon Musk\.$/);
  live.stop();
  assert.ok(existsSync(join(imgDir, "p1.png")));
});
