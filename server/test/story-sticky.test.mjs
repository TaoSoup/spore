// Sticky groups (lib/stories.mjs head 6, lib/story-memory.mjs): once placed, a coin stays in its card while it is listed;
// later information adds coins or merges cards (under the older key) but never pulls a coin out or renames a card; the
// post a card shows stays; stickiness ends after 60 min unlisted or 6 h without the card's label; memory is bounded;
// with no memory the grouping is exactly what it was. Plain rows and look-ups, a clock in seconds: no index, no sqlite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupStories } from "../lib/stories.mjs";
import { StoryMemory, UNLISTED_S, UNLABELLED_S } from "../lib/story-memory.mjs";

const NOW_S = 1_770_000_000;
const idAt = (s, n = 0) => String(((BigInt(s) * 1000n - 1288834974657n) << 22n) + BigInt(n));
const row = (mint, o = {}) => ({
  mint, name: `${mint} coin`, symbol: mint, image: `img-${mint}`, createdAt: 1000, firstSeenAt: null, mcapUsd: 50_000, priceUsd: 0.00005, buyers5m: 10,
  tf: { p0: 0.00004, chg: 25, volUsd: 200, buys: 12, sells: 3, buyers: 10, holding: 8 }, liqUsd: 5_000, spark: null, safety: null, graduated: false, thin: false, parent: null, family: null, ...o,
});
const mints = (rows) => rows.map((r) => r.mint);
const N1 = { id: 11, title: "frog king", theme: "animals" }, N2 = { id: 12, title: "frog queen", theme: "animals" }, N3 = { id: 13, title: "toad", theme: "animals" };
const X = idAt(NOW_S - 900, 1), Y = idAt(NOW_S - 800, 2);
const POSTS = { [X]: { handle: "x", text: "frogs are back" }, [Y]: { handle: "y", text: "toads too" } };

/** One build at `nowS` with memory `mem` (null: no memory at all). */
const build = (mem, nowS, rows, { links = {}, tags = {}, posts = POSTS } = {}) => {
  const g = groupStories({ rows, postIdOf: (r) => links[r.mint] ?? null, postOf: (id) => posts[id] ?? null, nowMs: nowS * 1000, tagOf: (r) => tags[r.mint] ?? null, ...(mem ? { sticky: mem.view(nowS) } : null) });
  if (mem) mem.record(g, nowS);
  return g;
};
const shape = (g) => g.cards.map((c) => [c.key, mints(c.coins).sort(), c.keys ?? null]).sort((a, b) => (a[0] < b[0] ? -1 : 1));

test("no memory, or an empty one: the grouping is exactly what it was (the memory's fields aside)", () => {
  const rows = [row("a", { buyers5m: 30 }), row("b"), row("c"), row("n1"), row("n2"), row("loose")];
  const o = { links: { a: X, b: X, c: X }, tags: { c: N1, n1: N1, n2: N1 } };
  const plain = build(null, NOW_S, rows, o);
  const { placed, kept, liveKeys, ...withMem } = build(new StoryMemory(), NOW_S, rows, o);
  assert.deepEqual(withMem, plain);
  assert.deepEqual([[...placed].sort(), [...kept.keys()].sort(), [...liveKeys].sort()], [[["a", X], ["b", X], ["c", X], ["n1", "n:11"], ["n2", "n:11"]], [X, "n:11"].sort(), [X, "n:11"].sort()]);
  assert.equal("placed" in plain, false);
});

test("a coin tagged later does not leave its card, and a card keeps its key when its own story drops away", () => {
  const mem = new StoryMemory();
  const rows = [row("a"), row("b"), row("c"), row("n1"), row("n2")];
  // first: a, b, c are frog king; n1, n2 untagged and loose
  let g = build(mem, NOW_S, rows, { tags: { a: N1, b: N1, c: N1 } });
  assert.deepEqual([shape(g), mints(g.loose)], [[["n:11", ["a", "b", "c"], null]], ["n1", "n2"]]);
  // then c is re-read as frog queen, with n1 and n2: without memory c would move to frog queen's card
  const later = { tags: { a: N1, b: N1, c: N2, n1: N2, n2: N2 } };
  assert.deepEqual(shape(build(null, NOW_S + 60, rows, later)), [["n:11", ["a", "b"], null], ["n:12", ["c", "n1", "n2"], null]]);
  g = build(mem, NOW_S + 60, rows, later);
  assert.deepEqual(shape(g), [["n:11", ["a", "b", "c"], null], ["n:12", ["n1", "n2"], null]], "c stays: one coin of frog queen does not pull it out");
  assert.deepEqual(g.cards.find((c) => c.key === "n:11").coins.find((r) => r.mint === "c").narrative, N2, "its row still says what it was tagged");
  // b is re-read too: frog king has one coin left, no label any more, and two of its coins are frog queen's (no lone
  // bridge): the two cards merge, under the older key and its title (remembered); frog queen is a part
  g = build(mem, NOW_S + 120, rows, { tags: { a: N1, b: N2, c: N2, n1: N2, n2: N2 } });
  const k = g.cards.find((c) => c.key === "n:11");
  assert.deepEqual([g.cards.length, k.kind, k.narrative.title, mints(k.coins).sort(), k.keys], [1, "narrative", "frog king", ["a", "b", "c", "n1", "n2"], ["n:11", "n:12"]]);
  assert.ok(!g.liveKeys.has("n:11"));
});

test("two cards joined by a new link merge under the older key; keys still list every member story", () => {
  const mem = new StoryMemory();
  const A = [row("a1", { buyers5m: 30 }), row("a2")], B = [row("b1", { buyers5m: 50 }), row("b2", { buyers5m: 40 })];
  const links = { a1: X, a2: X, b1: Y, b2: Y };
  build(mem, NOW_S, A, { links });
  let g = build(mem, NOW_S + 60, [...A, ...B], { links });
  assert.deepEqual(shape(g), [[X, ["a1", "a2"], null], [Y, ["b1", "b2"], null]]);
  // all four coins are tagged toad: a story of its own on each side, so the link holds
  const tags = { a1: N3, a2: N3, b1: N3, b2: N3 };
  assert.deepEqual(shape(build(null, NOW_S + 120, [...A, ...B], { links, tags })), [["n:13", ["a1", "a2", "b1", "b2"], ["n:13", Y, X]]], "without memory the narrative leads");
  g = build(mem, NOW_S + 120, [...A, ...B], { links, tags });
  assert.deepEqual(shape(g), [[X, ["a1", "a2", "b1", "b2"], [X, "n:13", Y]]], "X was placed first: its key leads, toad and Y are parts");
  const c = g.cards[0];
  assert.deepEqual([c.kind, c.post.handle, c.parts.map((p) => [p.key, p.coinsN])], ["post", "x", [[X, 2], ["n:13", 4], [Y, 2]]]);
  // and it stays merged when the tags go away again
  g = build(mem, NOW_S + 180, [...A, ...B], { links });
  assert.deepEqual(shape(g), [[X, ["a1", "a2", "b1", "b2"], [X, Y]]]);
});

test("a lone new link does not glue a coin's prior card to another story (the bridge is cut, nobody moves)", () => {
  const mem = new StoryMemory();
  const rows = [row("a"), row("b"), row("c"), row("p1"), row("p2")];
  build(mem, NOW_S, rows, { tags: { a: N1, b: N1, c: N1 } });
  // c's post is read later; p1 and p2 link it too
  const g = build(mem, NOW_S + 60, rows, { tags: { a: N1, b: N1, c: N1 }, links: { c: X, p1: X, p2: X } });
  assert.deepEqual(shape(g), [[X, ["p1", "p2"], null], ["n:11", ["a", "b", "c"], null]]);
});

test("the post a narrative card shows stays while a coin still links it, whoever has the most buyers", () => {
  const mem = new StoryMemory();
  const tags = { a: N1, b: N1 }, links = { a: X, b: Y };
  let g = build(mem, NOW_S, [row("a", { buyers5m: 30 }), row("b", { buyers5m: 5 })], { tags, links });
  assert.equal(g.cards[0].post.id, X);
  const flipped = [row("a", { buyers5m: 5 }), row("b", { buyers5m: 30 })];
  assert.equal(build(null, NOW_S + 60, flipped, { tags, links }).cards[0].post.id, Y, "without memory: the most-bought coin's post");
  g = build(mem, NOW_S + 60, flipped, { tags, links });
  assert.equal(g.cards[0].post.id, X);
  // the coin that links X leaves the list: the next post takes over
  g = build(mem, NOW_S + 120, [row("b", { buyers5m: 30 }), row("c")], { tags: { b: N1, c: N1 }, links });
  assert.equal(g.cards[0].post.id, Y);
});

test("a post card whose post may no longer be shown holds nothing: its coins are placed afresh", () => {
  const mem = new StoryMemory();
  const rows = [row("a"), row("b"), row("c")];
  build(mem, NOW_S, rows, { links: { a: X, b: X, c: X } });
  const g = build(mem, NOW_S + 60, rows, { links: { a: X, b: X, c: X }, posts: {} });
  assert.deepEqual([g.cards.length, mints(g.loose)], [0, ["a", "b", "c"]]);
});

test("stickiness ends: a coin unlisted for 60 min is placed afresh; a card whose key had no label for 6 h lets its coins go", () => {
  const mem = new StoryMemory();
  const rows = [row("a"), row("b"), row("c")];
  build(mem, NOW_S, rows, { tags: { a: N1, b: N1, c: N1 } });
  // c is off the list for over an hour, then comes back tagged frog queen with two others: it goes there
  build(mem, NOW_S + 60, rows.slice(0, 2), { tags: { a: N1, b: N1 } });
  let t = NOW_S + 60 + UNLISTED_S - 30;
  build(mem, t, rows.slice(0, 2), { tags: { a: N1, b: N1 } });
  t += 60;
  assert.equal(mem.coins.has("c"), false);
  const back = [...rows, row("n1"), row("n2")], tags = { a: N1, b: N1, c: N2, n1: N2, n2: N2 };
  assert.deepEqual(shape(build(mem, t, back, { tags })), [["n:11", ["a", "b"], null], ["n:12", ["c", "n1", "n2"], null]]);
  // frog king loses its label (a and b re-read as nothing) but they stay listed: held together for 6 h, then let go
  const t2 = t + 60;
  let g = build(mem, t2, back, { tags: { c: N2, n1: N2, n2: N2 } });
  assert.deepEqual(shape(g), [["n:11", ["a", "b"], null], ["n:12", ["c", "n1", "n2"], null]]);
  for (let s = t2 + 1800; s < t + UNLABELLED_S; s += 1800) build(mem, s, back, { tags: { c: N2, n1: N2, n2: N2 } });
  g = build(mem, t + UNLABELLED_S + 60, back, { tags: { c: N2, n1: N2, n2: N2 } });
  assert.deepEqual([shape(g), mints(g.loose)], [[["n:12", ["c", "n1", "n2"], null]], ["a", "b"]]);
});

test("memory is bounded: least recently refreshed coins and cards go first; the header coin is kept per card", () => {
  const mem = new StoryMemory({ coinsMax: 4, cardsMax: 2 });
  build(mem, NOW_S, [row("a"), row("b")], { tags: { a: N1, b: N1 } });
  build(mem, NOW_S + 10, [row("c"), row("d")], { tags: { c: N2, d: N2 } });
  mem.setLead("n:12", "d");
  build(mem, NOW_S + 20, [row("e"), row("f")], { tags: { e: N3, f: N3 } });
  assert.deepEqual([[...mem.cards.keys()], [...mem.coins.keys()]], [["n:12", "n:13"], ["c", "d", "e", "f"]]);
  assert.deepEqual([mem.leadOf("n:12"), mem.leadOf("n:11"), mem.leadOf("n:13")], ["d", null, null]);
  mem.setLead("gone", "x");
  assert.equal(mem.cards.has("gone"), false);
});

test("one key, one card: a prior card whose coins moved on and new coins under its key's live label come out as one card", () => {
  const mem = new StoryMemory();
  const rows = [row("a"), row("b"), row("c"), row("d"), row("e")];
  let g = build(mem, NOW_S, rows, { tags: { a: N1, b: N1, c: N1 } });
  assert.deepEqual(shape(g), [["n:11", ["a", "b", "c"], null]]);
  // a, b, c re-read as frog queen; d, e new under frog king: the held card and frog king's live label share key n:11
  g = build(mem, NOW_S + 60, rows, { tags: { a: N2, b: N2, c: N2, d: N1, e: N1 } });
  const keys = g.cards.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, `no key twice: ${JSON.stringify(shape(g))}`);
  assert.deepEqual(shape(g), [["n:11", ["a", "b", "c", "d", "e"], ["n:11", "n:12"]]]);
  assert.deepEqual([...g.placed.values()].sort(), ["n:11", "n:11", "n:11", "n:11", "n:11"]);
  // and the next build agrees
  assert.deepEqual(shape(build(mem, NOW_S + 120, rows, { tags: { a: N2, b: N2, c: N2, d: N1, e: N1 } })), [["n:11", ["a", "b", "c", "d", "e"], ["n:11", "n:12"]]]);
});
