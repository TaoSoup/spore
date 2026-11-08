// Root agents: the designer's filters (lengths and format, people/brands, slurs via the hashed list,
// tickers already used by the root's children or the biggest coins, near-duplicates of the root's
// ticker), the rubric, the deterministic generator and the model path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIdea, normalizeIdea, nearDuplicate, rubric, design, designContext, fallbackIdeas, symbolFor, blend, rhyme, rng, lev, CANDIDATES } from "../lib/agents/designer.mjs";
import { namedEntity, hasSlur, slurIndex, digest, normalizeWord, wordsOf, SLURS, NSFW, PEOPLE, BRANDS } from "../lib/agents/blocklist.mjs";
import { fallbackProfile, profileInput } from "../lib/agents/profile.mjs";
import { agentTree, fakeLlm, K, quiet } from "./helpers/agents.mjs";

const ctx0 = { rootSymbol: "GTA", childSymbols: new Set(["CJ", "RICO"]), topSymbols: new Set(["BONK", "WIF"]), childNames: new Set([normalizeWord("Carl Johnson")]) };
const idea = (o = {}) => ({ name: "Street Crew", symbol: "SCREW", description: "A loud offshoot of the GTA memes tree.", ...o });

test("filters: lengths and format of name (≤ 32), ticker (2-10, A-Z0-9) and description (≤ 280), no links or markup", () => {
  assert.equal(checkIdea(idea(), ctx0), null);
  assert.equal(checkIdea(idea({ name: "N".repeat(32) }), ctx0), null);
  assert.match(checkIdea(idea({ name: "N".repeat(33) }), ctx0), /name over 32/);
  assert.match(checkIdea(idea({ name: "<b>Crew</b>" }), ctx0), /plain text/);
  assert.match(checkIdea(idea({ symbol: "ABCDEFGHIJK" }), ctx0), /ticker over 10/);
  assert.equal(checkIdea(idea({ symbol: "ABCDEFGHIJ" }), ctx0), null);
  assert.match(checkIdea(idea({ symbol: "A" }), ctx0), /ticker must be 2-10/);
  assert.match(checkIdea(idea({ symbol: "AB-C" }), ctx0), /ticker must be 2-10/);
  assert.match(checkIdea(idea({ description: "d".repeat(281) }), ctx0), /description over 280/);
  assert.equal(checkIdea(idea({ description: "d".repeat(280) }), ctx0), null);
  assert.match(checkIdea(idea({ description: "Visit https://scam.example now" }), ctx0), /links/);
  assert.match(checkIdea(idea({ description: "Join crew.fun today" }), ctx0), /links/);
  // normalizeIdea: trims, strips a leading $, uppercases the ticker; null when a field is missing.
  assert.deepEqual(normalizeIdea({ name: "  Street   Crew ", symbol: " $screw ", description: " x  y " }), { name: "Street Crew", symbol: "SCREW", description: "x y" });
  assert.equal(normalizeIdea({ name: "X", symbol: "" , description: "d" }), null);
  assert.equal(normalizeIdea(null), null);
});

test("filters: real people and brands (blocklist) in name, ticker or description", () => {
  assert.match(checkIdea(idea({ name: "Elon Crew" }), ctx0), /name names a person \(elon\)/);
  assert.match(checkIdea(idea({ symbol: "NIKEDOG" }), ctx0), /ticker names a brand \(nike\)/, "a ticker matches a term at its start");
  assert.match(checkIdea(idea({ symbol: "DOGTRUMP" }), ctx0), /ticker names a person/, "or at its end");
  assert.match(checkIdea(idea({ description: "Dedicated to Taylor Swift fans." }), ctx0), /description names a person \(taylor swift\)/);
  assert.match(checkIdea(idea({ name: "TaylorSwiftInu" }), ctx0), /person/, "multi-word terms match squashed");
  assert.match(checkIdea(idea({ name: "Coca-Cola Cat" }), ctx0), /brand/);
  assert.equal(checkIdea(idea({ name: "Trumpet Club", symbol: "TRMPT" }), ctx0), null, "a word containing a name is not that name");
  assert.ok(PEOPLE.length > 50 && BRANDS.length > 80);
  assert.deepEqual(namedEntity("Grand Theft Auto VI"), { kind: "brand", term: "grand theft auto" });
});

test("filters: slurs and vulgar words through the hashed lists (plain text never appears in the source)", () => {
  // The mechanism, with a list built here: whole words, substrings of the squashed text, leetspeak and accents folded.
  const idx = slurIndex({ whole: [digest("badword")], stems: [`${"longbadterm".length}:${digest("longbadterm")}`] });
  assert.equal(hasSlur("Badword Cat", idx), true);
  assert.equal(hasSlur("B4dw0rd Cat", idx), true, "leetspeak folded");
  assert.equal(hasSlur("BÁDWORD", idx), true, "accents folded");
  assert.equal(hasSlur("Badwordish", idx), false, "whole-word entries need a word boundary");
  assert.equal(hasSlur("TheLongBadTermInu", idx), true, "stem entries match inside words");
  assert.equal(hasSlur("Gentle Cat", idx), false);
  assert.match(checkIdea(idea({ name: "Badword Crew" }), { ...ctx0, slurs: idx }), /name contains a blocked word/);
  assert.match(checkIdea(idea({ description: "the longbadterm club" }), { ...ctx0, slurs: idx }), /description contains a blocked word/);
  // The shipped lists: digests only (16 hex), stems with their length.
  for (const list of [SLURS, NSFW]) {
    assert.ok(list.whole.length > 10 && list.stems.length >= 3);
    for (const h of list.whole) assert.match(h, /^[0-9a-f]{16}$/);
    for (const e of list.stems) assert.match(e, /^\d+:[0-9a-f]{16}$/);
  }
  assert.equal(hasSlur("Glowing Mushroom Grove"), false);
  assert.deepEqual(wordsOf("ElonDoge s3x"), ["elon", "doge", "sex"]);
});

test("filters: tickers of the root's children and of the 2 000 biggest coins, a child's exact name, near-duplicates of the root ticker", () => {
  assert.match(checkIdea(idea({ symbol: "RICO" }), ctx0), /already used by a child/);
  assert.match(checkIdea(idea({ symbol: "BONK" }), ctx0), /2000 biggest coins/);
  assert.match(checkIdea(idea({ name: "Carl Johnson", symbol: "CARLJ" }), ctx0), /already has this name/);
  for (const s of ["GTA", "GTA2", "GTAX", "XGTA", "GPA", "GT"]) assert.match(checkIdea(idea({ symbol: s }), ctx0) ?? "", /too close to the root/, s);
  for (const s of ["BABYGTA", "CREW", "GTAVICE"]) assert.equal(checkIdea(idea({ symbol: s }), ctx0), null, s);
  assert.equal(nearDuplicate("SPORES", "SPORE"), true); assert.equal(nearDuplicate("SPRE", "SPORE"), true); assert.equal(nearDuplicate("SPROUT", "SPORE"), false);
  assert.equal(lev("KITTEN", "SITTING"), 3);
});

test("designContext: every child's ticker and name, the top coins by market cap (the root's own included)", () => {
  const { model } = agentTree();
  const ctx = designContext(model, K.ROOT, { top: 2 });
  assert.equal(ctx.rootSymbol, "GROVE"); assert.equal(ctx.rootName, "Mushroom Grove");
  assert.deepEqual([...ctx.childSymbols].sort(), ["GLOWCAT", "SCAT"]);
  assert.ok(ctx.childNames.has("sporecat"));
  assert.equal(ctx.topSymbols.size, 2);
  assert.ok(designContext(model, K.ROOT).topSymbols.has("GROVE"));
});

test("rubric: theme fit, brevity and uniqueness; total 0-100", () => {
  const profile = { themes: ["mushroom", "forest", "glow"] };
  const ctx = { childSymbols: new Set(["GLOWCAT"]), topSymbols: new Set(["MOSS"]) };
  const good = rubric({ name: "Glow Cap", symbol: "GLOWCAP", description: "Mushroom glow in the forest." }, profile, ctx);
  const off = rubric({ name: "Completely Unrelated Long Name", symbol: "CULNAMEXYZ", description: "Nothing about it." }, profile, ctx);
  assert.ok(good.fit === 1 && off.fit === 0, `${good.fit} ${off.fit}`);
  assert.ok(good.brevity > off.brevity);
  assert.equal(rubric({ name: "Moss", symbol: "MOSX", description: "x" }, profile, ctx).uniqueness, 0.4, "one edit from MOSS");
  assert.ok(good.total > off.total && good.total <= 100 && off.total >= 0);
});

test("generator: six seeded ideas on the themes, reproducible per seed, all well-formed", () => {
  const { model } = agentTree();
  const profile = fallbackProfile(profileInput(model, K.ROOT));
  const root = { mint: K.ROOT, name: "Mushroom Grove", symbol: "GROVE" };
  const a = fallbackIdeas(profile, root, { seed: "1" }), b = fallbackIdeas(profile, root, { seed: "1" }), c = fallbackIdeas(profile, root, { seed: "2" });
  assert.equal(a.length, CANDIDATES); assert.deepEqual(a, b); assert.notDeepEqual(a, c);
  assert.equal(new Set(a.map((i) => i.symbol)).size, a.length, "distinct tickers");
  for (const i of [...a, ...c]) {
    assert.ok(i.name.length <= 32 && /^[A-Z0-9]{2,10}$/.test(i.symbol) && i.description.length <= 280, JSON.stringify(i));
    assert.equal(i.source, "fallback");
    assert.ok(!/(^|[^$])\bGROVE\b/.test(i.description), `the root ticker always carries its $: ${i.description}`);
  }
  assert.equal(symbolFor("Spoblin"), "SPOBLIN"); assert.equal(symbolFor("Glow Cap"), "GLOWCAP"); assert.equal(symbolFor("Pepe Goblin"), "PEPEGOBLIN");
  assert.equal(symbolFor("Truth Cipher"), "TCIPHER"); assert.equal(symbolFor("Encrypted Signal"), "ESIGNAL"); assert.equal(symbolFor("Extraordinarily Long Name"), "ELNAME"); assert.equal(symbolFor("Mega Ultra Extraordinarily"), "MEGULTEXTR");
  assert.equal(blend("spore", "goblin"), "Spoblin");
  assert.ok(["HOPE", "NOPE", "ROPE", "COPE", "POPE", "MOPE", "LOPE"].includes(rhyme("DOPE", rng("x"))), "rhymes land on common words");
  assert.equal(rhyme("GTA", rng("x")), null); assert.equal(rhyme("XQZV", rng("x")), null); assert.equal(rhyme("NTRNDM", rng("x")), null);
});

test("design: model ideas first (source model), filtered with reasons, best by rubric, runners-up kept", async () => {
  const { model } = agentTree();
  const profile = { ...fallbackProfile(profileInput(model, K.ROOT)), themes: ["mushroom", "glow", "forest"] };
  const ctx = designContext(model, K.ROOT);
  const llm = fakeLlm([{ ideas: [
    { name: "Elon Shroom", symbol: "ESHROOM", description: "A mushroom." },
    { name: "Glow Cat", symbol: "GLOWCAT", description: "Already a child." },
    { name: "Grove2", symbol: "GROVE2", description: "Too close to the root." },
    { name: "Forest Glow", symbol: "FGLOW", description: "Mushroom glow from the forest floor." },
    { name: "Unrelated Thing", symbol: "UNREL", description: "Nothing on theme." },
    { name: "Way Too Long A Name For Pump Fun Coins", symbol: "LONG", description: "x" },
    { name: "Seventh", symbol: "SEVENTH", description: "Only six are considered per batch." },
  ] }]);
  const d = await design(profile, { mint: K.ROOT, name: "Mushroom Grove", symbol: "GROVE" }, ctx, { llm, log: quiet, seed: "s" });
  assert.equal(d.best.symbol, "FGLOW"); assert.equal(d.source, "model"); assert.equal(d.best.source, "model");
  assert.deepEqual(d.runnersUp, [{ name: "Unrelated Thing", symbol: "UNREL" }]);
  assert.equal(d.considered, CANDIDATES, "one batch of six");
  const why = Object.fromEntries(d.filtered.map((f) => [f.symbol, f.why]));
  assert.match(why.ESHROOM, /person/); assert.match(why.GLOWCAT, /already used by a child/); assert.match(why.GROVE2, /too close/); assert.match(why.LONG, /name over 32/);
  assert.ok(!("SEVENTH" in why));
  const sent = JSON.parse(llm.calls[0].messages[1].content);
  assert.equal(sent.parent.ticker, "GROVE"); assert.deepEqual(sent.existingChildTickers.sort(), ["GLOWCAT", "SCAT"]);
});

test("design: without a model (or when it fails) the generator fills the batch; nothing valid in three rounds → no best", async () => {
  const { model } = agentTree();
  const profile = fallbackProfile(profileInput(model, K.ROOT));
  const ctx = designContext(model, K.ROOT);
  const root = { mint: K.ROOT, name: "Mushroom Grove", symbol: "GROVE" };
  const d = await design(profile, root, ctx, { llm: null, seed: "x" });
  assert.ok(d.best); assert.equal(d.source, "fallback"); assert.equal(d.rounds, 1);
  assert.ok(d.runnersUp.length >= 1 && d.runnersUp.every((r) => r.symbol !== d.best.symbol));
  const failing = await design(profile, root, ctx, { llm: fakeLlm([new Error("down")]), log: quiet, seed: "x" });
  assert.equal(failing.source, "fallback"); assert.deepEqual(failing.best, d.best, "same seed, same fallback");
  // Every ticker taken: three rounds, nothing proposed.
  const blocked = { ...ctx, topSymbols: { has: () => true, [Symbol.iterator]: function* () {} } };
  const none = await design(profile, root, blocked, { seed: "x" });
  assert.equal(none.best, null); assert.equal(none.rounds, 3); assert.equal(none.considered, 3 * CANDIDATES);
});
