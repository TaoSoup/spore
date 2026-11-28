// Stories (lib/stories.mjs): the bot-dust floor (paper cap, tiny buys), which card a coin goes to (its post, its waking
// family, loose; a family whose post may be shown joins that post's card), the fold of same-ticker same-image copies
// (lead by liquidity), the card totals, order and caps. Plain rows and look-ups: no index, no sqlite, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupStories, dustWhy, foldCopies, copyKey, totals, CARDS_MAX, LOOSE_MAX, DUST_MAX, NEW_S } from "../lib/stories.mjs";
import { PAPER_RATIO, TINY_USD } from "../lib/rowshared.mjs";

const NOW_MS = 1_770_000_000_000;
/** A snowflake id made at unix s `s`. */
const idAt = (s, n = 0) => String(((BigInt(s) * 1000n - 1288834974657n) << 22n) + BigInt(n));
/** A coin row with healthy numbers: $50K cap on $5K of liquidity, 10 buyers and $200 over the timeframe. */
const row = (mint, o = {}) => ({
  mint, name: `${mint} coin`, symbol: mint, image: `img-${mint}`, createdAt: 1000, firstSeenAt: null, mcapUsd: 50_000, priceUsd: 0.00005, buyers5m: 10,
  tf: { p0: 0.00004, chg: 25, volUsd: 200, buys: 12, sells: 3, buyers: 10, holding: 8 }, liqUsd: 5_000, spark: null, safety: null, graduated: false, thin: false, parent: null, family: null, ...o,
});
const under = (p) => ({ mint: p, symbol: p, image: `img-${p}` });
const group = (rows, { links = {}, posts = {}, wakes = [] } = {}) => groupStories({
  rows, postIdOf: (r) => links[r.mint] ?? null, postOf: (id) => posts[id] ?? null, wakes: new Map(wakes.map((w) => [w.mint, w])), nowMs: NOW_MS,
});
const mints = (rows) => rows.map((r) => r.mint);

test("the dust floor: a cap over 100x its real liquidity is paper, under $5 of volume per buyer is tiny; unknown numbers are not dust", () => {
  assert.deepEqual([PAPER_RATIO, TINY_USD], [100, 5]);
  assert.equal(dustWhy(row("a")), null);
  assert.equal(dustWhy(row("a", { mcapUsd: 500_000.01, liqUsd: 5_000 })), "paper");
  assert.equal(dustWhy(row("a", { mcapUsd: 500_000, liqUsd: 5_000 })), null, "exactly 100x is not over it");
  assert.equal(dustWhy(row("a", { mcapUsd: 9e9, liqUsd: 0 })), null, "no liquidity read is no verdict");
  assert.equal(dustWhy(row("a", { mcapUsd: 9e9, liqUsd: null })), null);
  assert.equal(dustWhy(row("a", { mcapUsd: null, liqUsd: 1 })), null);
  const tf = (volUsd, buyers) => row("a", { tf: { volUsd, buyers } });
  assert.equal(dustWhy(tf(49.99, 10)), "tiny");
  assert.equal(dustWhy(tf(50, 10)), null, "exactly $5 a buyer is not under it");
  assert.equal(dustWhy(tf(0, 0)), null, "no buyer: nothing to divide by");
  assert.equal(dustWhy(row("a", { mcapUsd: 1e9, liqUsd: 1, tf: { volUsd: 1, buyers: 9 } })), "paper", "paper is named first");
});

test("dust rows leave the cards and the loose list, come back apart with a reason, and are all counted", () => {
  const rows = [row("a"), row("p", { mcapUsd: 1e9, liqUsd: 10 }), row("t", { tf: { volUsd: 3, buyers: 4 } }), row("b")];
  // the paper coin links a post that may be shown: it still gets no card
  const g = group(rows, { links: { p: "9" }, posts: { 9: { handle: "who", text: "hi" } } });
  assert.deepEqual([g.cards, mints(g.loose), g.dust.map((r) => [r.mint, r.reason]), g.hidden.dust], [[], ["a", "b"], [["p", "paper"], ["t", "tiny"]], 2]);
  assert.equal(g.dust[0].symbol, "p", "a dust row is the coin row plus its reason");
  assert.equal(rows[1].reason, undefined, "the rows handed in are not changed");
  const many = group(Array.from({ length: DUST_MAX + 5 }, (_, i) => row(`d${i}`, { tf: { volUsd: 1, buyers: 1 } })));
  assert.deepEqual([many.dust.length, many.hidden.dust, many.loose.length], [DUST_MAX, DUST_MAX + 5, 0]);
});

test("a post card: coins that link a post whose handle and text are stored, across parents; its time read from the id", () => {
  const X = idAt(1_769_999_000, 7);
  const rows = [row("a", { parent: under("P1"), buyers5m: 30 }), row("b", { parent: under("P2"), buyers5m: 12 }), row("c"), row("d", { buyers5m: 1 })];
  const g = group(rows, { links: { a: X, b: X, d: X, c: "5" }, posts: { [X]: { handle: "poster", text: "the news" } } });
  assert.equal(g.cards.length, 1);
  const [card] = g.cards;
  assert.deepEqual({ ...card, coins: mints(card.coins) }, {
    kind: "post", key: X, post: { id: X, handle: "poster", text: "the news", at: 1_769_999_000, url: `https://x.com/i/status/${X}` }, family: null,
    buyers5m: 43, coinsN: 3, coins: ["a", "b", "d"],
  });
  assert.deepEqual(mints(g.loose), ["c"], "c links a post nothing is stored of: no story found");
  assert.equal(card.coins[0].tf.buyers, 10, "a card's coins are the coin rows");
  // an id from before snowflakes carries no time
  assert.equal(group([row("a")], { links: { a: "12345" }, posts: { 12345: { handle: "old", text: "" } } }).cards[0].post.at, null);
});

test("a post that may not be shown makes no card: nothing stored, no handle, no text, or the look-up fails", () => {
  const rows = [row("a"), row("b")];
  for (const p of [null, undefined, { handle: null, text: "x" }, { handle: "", text: "x" }, { handle: "h", text: null }]) {
    const g = group(rows, { links: { a: "7", b: "7" }, posts: { 7: p } });
    assert.deepEqual([g.cards.length, mints(g.loose)], [0, ["a", "b"]], JSON.stringify(p));
  }
  const g = groupStories({ rows, postIdOf: () => "7", postOf: () => { throw new Error("store down"); }, nowMs: NOW_MS });
  assert.deepEqual([g.cards.length, g.loose.length], [0, 2]);
  // a post of media only has an empty text and a handle: it is shown
  assert.equal(group(rows, { links: { a: "7" }, posts: { 7: { handle: "h", text: "" } } }).cards[0].post.text, "");
  // the look-up is asked once per post
  let asked = 0;
  groupStories({ rows: [row("a"), row("b"), row("c")], postIdOf: () => "7", postOf: () => { asked++; return { handle: "h", text: "t" }; }, nowMs: NOW_MS });
  assert.equal(asked, 1);
});

// Changed with the linking step: before it, c (family P1, linking post 7) was split off into a card of its own; one
// family's coins are one story, so c now joins the family's card, which is led by the post (post > family).
test("a family card: coins under a waking family with no post of their own; a family coin that links a post joins the family under that post", () => {
  const wake = { mint: "P1", symbol: "PONE", image: "img-P1", startedAt: 1_769_999_400, postId: null };
  const rows = [row("a", { parent: under("P1"), buyers5m: 40 }), row("b", { parent: under("P1"), buyers5m: 20 }), row("c", { parent: under("P1"), buyers5m: 5 }), row("d", { parent: under("P2") }), row("root")];
  const g0 = group(rows.filter((r) => r.mint !== "c"), { wakes: [wake] });
  assert.deepEqual(g0.cards.map((c) => [c.kind, c.key, c.buyers5m, c.coinsN, mints(c.coins), c.post, "keys" in c]), [["family", "P1", 60, 2, ["a", "b"], null, false]]);
  assert.deepEqual(g0.cards[0].family, { mint: "P1", symbol: "PONE", image: "img-P1", startedAt: 1_769_999_400 });
  const g = group(rows, { links: { c: "7" }, posts: { 7: { handle: "h", text: "t" } }, wakes: [wake] });
  assert.deepEqual(g.cards.map((c) => [c.kind, c.key, c.buyers5m, c.coinsN, mints(c.coins), c.keys]), [["post", "7", 65, 3, ["a", "b", "c"], ["7", "P1"]]]);
  assert.deepEqual(g.cards[0].parts, [{ kind: "post", key: "7", title: "h", coinsN: 1, buyers5m: 5 }, { kind: "family", key: "P1", title: "PONE", coinsN: 3, buyers5m: 65 }]);
  assert.deepEqual([g.cards[0].post.id, g.cards[0].family.mint], ["7", "P1"]);
  assert.deepEqual(mints(g.loose), ["d", "root"], "a family that is not waking, and a coin with no parent");
  // every coin is in one place only
  const all = [...g.cards.flatMap((c) => mints(c.coins)), ...mints(g.loose)];
  assert.deepEqual([all.length, new Set(all).size], [5, 5]);
  // the parent coin of a waking family joins its family's card; alone (none of its coins listed) it stays loose
  const withRoot = group([row("P1", { buyers5m: 30 }), ...rows.slice(0, 2)], { wakes: [wake] });
  assert.deepEqual(withRoot.cards.map((c) => [c.kind, c.key, mints(c.coins)]), [["family", "P1", ["P1", "a", "b"]]]);
  const alone = group([row("P1"), row("q")], { wakes: [wake] });
  assert.deepEqual([alone.cards.length, mints(alone.loose)], [0, ["P1", "q"]]);
});

// Changed with the linking step: y (family P1, linking post 8) used to be split off into a post-8 card; it now joins its
// family's card, and post 8 is one of that card's stories.
test("merge: a waking family whose chosen post may be shown has no card of its own; the post's card carries the family", () => {
  const wake = { mint: "P1", symbol: "PONE", image: "img-P1", startedAt: 500, postId: "7" };
  const rows = [row("a", { parent: under("P1"), buyers5m: 40 }), row("b", { parent: under("P1"), buyers5m: 20 }), row("x", { parent: under("P9"), buyers5m: 9 }), row("y", { parent: under("P1"), buyers5m: 3 })];
  const links = { a: "7", x: "7", y: "8" };
  const posts = { 7: { handle: "h", text: "t" }, 8: { handle: "other", text: "t8" } };
  const g = group(rows, { links, posts, wakes: [wake] });
  // b links nothing: it comes with its family; x is under another parent; y links another post, a story of the same card.
  // The family's coins are post 7's story (the series files them there): P1 is no key of its own.
  assert.deepEqual(g.cards.map((c) => [c.kind, c.key, c.buyers5m, c.coinsN, mints(c.coins), c.family?.mint ?? null, c.post?.handle ?? null, c.keys]), [
    ["post", "7", 72, 4, ["a", "b", "x", "y"], "P1", "h", ["7", "8"]],
  ]);
  // a family and its shown post alone, the parent coin on the page too: one story, a card of one key as before
  const solo = group([row("a", { parent: under("P1"), buyers5m: 4 }), row("b", { parent: under("P1"), buyers5m: 2 }), row("P1", { buyers5m: 40 })], { posts, wakes: [wake] });
  assert.deepEqual(solo.cards.map((c) => [c.kind, c.key, mints(c.coins), c.family?.mint, "keys" in c, "parts" in c]), [["post", "7", ["a", "b", "P1"], "P1", false, false]]);
  // the family's post is not stored (or flagged): the coins linking it stay with the family, under y's post (post > family)
  const g2 = group(rows, { links, posts: { 8: posts[8] }, wakes: [wake] });
  assert.deepEqual(g2.cards.map((c) => [c.kind, c.key, mints(c.coins), c.post?.id ?? null, c.family?.mint ?? null, c.keys]), [["post", "8", ["a", "b", "y"], "8", "P1", ["8", "P1"]]]);
  assert.deepEqual(mints(g2.loose), ["x"]);
  // two families showing the same post: one card, named after the family that brought more buyers (then the mint)
  const g3 = group([row("a", { parent: under("P1"), buyers5m: 5 }), row("b", { parent: under("P2"), buyers5m: 6 })], { posts, wakes: [wake, { mint: "P2", symbol: "PTWO", image: null, startedAt: 600, postId: "7" }] });
  assert.deepEqual([g3.cards.length, g3.cards[0].key, g3.cards[0].family, g3.cards[0].coinsN], [1, "7", { mint: "P2", symbol: "PTWO", image: null, startedAt: 600 }, 2]);
});

test("copies: same ticker (any case) and same image fold into the row with the most liquidity; the others are listed, never ranked as real", () => {
  const rows = [
    row("a1", { symbol: "DOG", image: "i", liqUsd: 100, buyers5m: 9, createdAt: 10 }),
    row("z", { symbol: "CAT" }),
    row("a2", { symbol: " dog ", image: "i", liqUsd: 900, buyers5m: 4, createdAt: 30 }),
    row("a3", { symbol: "Dog", image: "i", liqUsd: null, buyers5m: 2, createdAt: null, firstSeenAt: 77 }),
    row("a4", { symbol: "DOG", image: "other", liqUsd: 5_000 }),
    row("n1", { symbol: "NOPIC", image: null }), row("n2", { symbol: "NOPIC", image: null }),
  ];
  const out = foldCopies(rows);
  assert.deepEqual(mints(out), ["a2", "z", "a4", "n1", "n2"], "the lead stands where the best-ranked of them stood; another image, or no image, does not fold");
  assert.deepEqual(out[0].copies, [{ mint: "a1", createdAt: 10, firstSeenAt: null, liqUsd: 100, buyers5m: 9, buyers: 10 }, { mint: "a3", createdAt: null, firstSeenAt: 77, liqUsd: null, buyers5m: 2, buyers: 10 }]);
  // a copy also carries its buyers over the timeframe of the read (its tf.buyers), so the page can add up any timeframe
  assert.deepEqual(foldCopies([row("c1", { symbol: "Q", image: "i", liqUsd: 9, tf: { buyers: 31 } }), row("c2", { symbol: "Q", image: "i", liqUsd: 1, tf: { buyers: 4 } }), row("c3", { symbol: "Q", image: "i", liqUsd: 0, tf: undefined })])[0].copies.map((c) => [c.mint, c.buyers]), [["c2", 4], ["c3", 0]]);
  assert.deepEqual([out[0].symbol, out[0].liqUsd, "copies" in out[1], rows[2].copies], [" dog ", 900, false, undefined]);
  assert.deepEqual(Object.keys(out[0]).filter((k) => /real|orig|official/i.test(k)), []);
  assert.deepEqual(totals(out), { buyers5m: 9 + 4 + 2 + 10 * 4, coinsN: 7 });
  assert.deepEqual([copyKey({ symbol: "A", image: "i" }), copyKey({ symbol: "", image: "i" }), copyKey({ symbol: "A", image: null }), copyKey({})], ["a\ni", null, null, null]);
  // equal liquidity: more 5-minute buyers leads, then the mint
  const tie = foldCopies([row("m2", { symbol: "T", image: "i", buyers5m: 3 }), row("m1", { symbol: "T", image: "i", buyers5m: 3 }), row("m3", { symbol: "T", image: "i", buyers5m: 8 })]);
  assert.deepEqual([tie[0].mint, mints(tie[0].copies)], ["m3", ["m1", "m2"]]);
});

test("copies fold inside a card and inside the loose list, never across them; a card's numbers count its copies", () => {
  const dog = (m, o) => row(m, { symbol: "DOG", image: "i", ...o });
  const rows = [dog("a", { liqUsd: 500, buyers5m: 7 }), dog("b", { liqUsd: 600, buyers5m: 2 }), dog("c", { liqUsd: 700, buyers5m: 1 }), dog("d", { liqUsd: 800, buyers5m: 1 })];
  const g = group(rows, { links: { a: "7", b: "7" }, posts: { 7: { handle: "h", text: "t" } } });
  assert.deepEqual([g.cards[0].coins.length, g.cards[0].coins[0].mint, mints(g.cards[0].coins[0].copies), g.cards[0].buyers5m, g.cards[0].coinsN], [1, "b", ["a"], 9, 2]);
  assert.deepEqual([g.loose.length, g.loose[0].mint, mints(g.loose[0].copies)], [1, "d", ["c"]]);
});

test("cards: most 5-minute buyers first, then most coins, then the key; at most 20 cards and 30 loose rows", () => {
  const posts = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(100 + i), { handle: `h${i}`, text: "t" }]));
  const rows = [row("a", { buyers5m: 5 }), row("b1", { buyers5m: 3 }), row("b2", { buyers5m: 2 }), row("c", { buyers5m: 5 }), row("d", { buyers5m: 50 })];
  const g = group(rows, { links: { a: "102", b1: "101", b2: "101", c: "100", d: "103" }, posts });
  assert.deepEqual(g.cards.map((c) => c.key), ["103", "101", "100", "102"], "50; then 5 buyers over 2 coins; then 5 over 1 coin, by key");
  const many = group(Array.from({ length: 25 }, (_, i) => row(`m${i}`, { buyers5m: 100 - i })), { links: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`m${i}`, String(100 + i)])), posts });
  assert.deepEqual([many.cards.length, many.hidden.cards, many.cards[0].key, many.cards[CARDS_MAX - 1].key], [CARDS_MAX, 5, "100", "119"]);
  const loose = group(Array.from({ length: LOOSE_MAX + 4 }, (_, i) => row(`l${i}`)));
  assert.deepEqual([loose.loose.length, loose.loose[0].mint, loose.hidden], [LOOSE_MAX, "l0", { dust: 0, cards: 0, loose: 4 }]);
  // the loose rows past the cap are counted as coins: a copy folded under a row that is sent is on the page, not hidden
  const folded = group([row("x1", { symbol: "X", image: "i" }), row("x2", { symbol: "x", image: "i" }), ...Array.from({ length: LOOSE_MAX + 1 }, (_, i) => row(`l${i}`))]);
  assert.deepEqual([folded.loose.length, folded.loose[0].copies.length, folded.hidden.loose], [LOOSE_MAX, 1, 2]);
  assert.deepEqual(groupStories(), { cards: [], loose: [], dust: [], themes: [], hidden: { dust: 0, cards: 0, loose: 0 } });
});

// ---------------------------------------------------------------- narrative tags (lib/narrtags.mjs gives the tags; the grouping is pure)
const NOW_S = NOW_MS / 1000;
const AI = { id: 7, title: "ai bubble popping", theme: "ai" }, DOG = { id: 9, title: "dog in a hat", theme: "animals" }, CAT = { id: 4, title: "office cat", theme: "animals" };
const tagsOf = (map) => (r) => map[r.mint] ?? null;

test("without tags the result is what it was: no narrative field anywhere, themes empty", () => {
  const rows = [row("a", { parent: under("P") }), row("b"), row("c"), row("d", { mcapUsd: 600_000 })];
  const opts = { links: { b: idAt(1_769_999_000) }, posts: { [idAt(1_769_999_000)]: { handle: "h", text: "t" } }, wakes: [{ mint: "P", symbol: "P", image: "i", startedAt: 5, postId: null }] };
  const g = group(rows, opts);
  assert.deepEqual(g.themes, []);
  assert.deepEqual(g.cards.map((c) => [c.kind, Object.keys(c)]), [["post", ["kind", "key", "post", "family", "buyers5m", "coinsN", "coins"]], ["family", ["kind", "key", "post", "family", "buyers5m", "coinsN", "coins"]]].sort((x, y) => (x[0] === g.cards[0].kind ? -1 : 1)));
  assert.ok(!JSON.stringify(g).includes("narrative") && !JSON.stringify(g).includes("isNew"));
  assert.equal(g.loose[0], rows[2], "an untagged row is listed as it came");
  // a tagger that knows none of the coins changes one thing: post and family cards say `narrative: null`
  const off = groupStories({ rows, postIdOf: (r) => opts.links[r.mint] ?? null, postOf: (id) => opts.posts[id] ?? null, wakes: new Map(opts.wakes.map((w) => [w.mint, w])), nowMs: NOW_MS, tagOf: () => null });
  assert.deepEqual(off.cards.map((c) => c.narrative), [null, null]);
  assert.deepEqual({ ...off, cards: off.cards.map(({ narrative, ...c }) => c) }, g);
});

test("narrative cards: two or more coins of one narrative, new and older counted, the rows marked; one coin alone stays where it was", () => {
  const rows = [
    row("a", { buyers5m: 30, createdAt: NOW_S - 60 }),
    row("b", { buyers5m: 5, createdAt: NOW_S - NEW_S }),      // exactly an hour old: older
    row("c", { buyers5m: 8, createdAt: null, firstSeenAt: NOW_S - 30 }), // no creation time: older
    row("d", { buyers5m: 2 }),                                  // the only dog coin: loose
    row("e"),
  ];
  const g = groupStories({ rows, nowMs: NOW_MS, tagOf: tagsOf({ a: AI, b: AI, c: AI, d: DOG }), newCoins1hOf: (id) => (id === 7 ? 12 : 0) });
  assert.equal(g.cards.length, 1);
  const [card] = g.cards;
  assert.deepEqual(Object.keys(card), ["kind", "key", "narrative", "post", "family", "buyers5m", "coinsN", "newN", "olderN", "coins"]);
  assert.deepEqual([card.kind, card.key, card.narrative, card.post, card.family, card.buyers5m, card.coinsN, card.newN, card.olderN],
    ["narrative", "n:7", { id: 7, title: "ai bubble popping", theme: "ai", newCoins1h: 12 }, null, null, 43, 3, 1, 2]);
  assert.deepEqual(card.coins.map((r) => [r.mint, r.isNew, r.narrative]), [["a", true, AI], ["b", false, AI], ["c", false, AI]]);
  assert.deepEqual(g.loose.map((r) => [r.mint, r.narrative, "isNew" in r]), [["d", DOG, false], ["e", undefined, false]]);
  assert.ok(!("narrative" in g.loose[1]), "an untagged row gets no narrative field");
  assert.deepEqual(g.themes, [{ theme: "ai", cards: 1 }]);
  assert.equal(rows[0].narrative, undefined, "the rows handed in are not changed");
});

test("narrative cards: copies count once, so two copies of one coin make no card; dust rows never count but keep their tag", () => {
  const twin = { symbol: "TWIN", image: "same" };
  const copies = [row("a", { ...twin, liqUsd: 9_000 }), row("b", { ...twin, liqUsd: 1_000 })];
  let g = groupStories({ rows: copies, nowMs: NOW_MS, tagOf: tagsOf({ a: AI, b: AI }) });
  assert.deepEqual([g.cards.length, g.loose.map((r) => [r.mint, r.narrative.id, r.copies.map((c) => c.mint)]), g.themes], [0, [["a", 7, ["b"]]], []]);
  // a third, different coin makes it two: the card counts all three coins, the copy folded under its lead
  g = groupStories({ rows: [...copies, row("c", { buyers5m: 4 })], nowMs: NOW_MS, tagOf: tagsOf({ a: AI, b: AI, c: AI }) });
  assert.deepEqual([g.cards[0].coinsN, g.cards[0].buyers5m, g.cards[0].coins.map((r) => [r.mint, (r.copies ?? []).map((c) => c.mint)]), g.cards[0].olderN], [3, 24, [["a", ["b"]], ["c", []]], 3]);
  // dust: a paper cap is out before the count
  g = groupStories({ rows: [row("a"), row("p", { mcapUsd: 600_000 })], nowMs: NOW_MS, tagOf: tagsOf({ a: AI, p: AI }) });
  assert.deepEqual([g.cards.length, mints(g.loose), g.dust.map((r) => [r.mint, r.reason, r.narrative])], [0, ["a"], [["p", "paper", AI]]]);
});

// Changed with the linking step: c links the same post as a and b and used to be left alone on a post card beside their
// narrative card; it now shares their card. f1 is a lone bridge from the AI narrative into family P (the guard): it
// stays with its family, which it used to leave.
test("narrative cards: a narrative and the post its coins link are one card; a lone tagged coin of a family stays with the family", () => {
  const X = idAt(1_769_999_000), Y = idAt(1_769_999_500);
  const posts = { [X]: { handle: "poster", text: "big news" }, [Y]: { handle: "other", text: "second" } };
  const wakes = new Map([["P", { mint: "P", symbol: "P", image: "i", startedAt: 5, postId: null }]]);
  const rows = [
    row("a", { buyers5m: 3 }), row("b", { buyers5m: 9 }),    // link X, tagged AI
    row("c", { buyers5m: 20 }),                              // links X, tagged CAT alone
    row("f1", { parent: under("P"), buyers5m: 7 }),          // family P, tagged AI, links Y
    row("f2", { parent: under("P") }), row("f3", { parent: under("P") }), // family P: DOG and untagged
    row("z"),
  ];
  const links = { a: X, b: X, c: X, f1: Y };
  const g = groupStories({ rows, postIdOf: (r) => links[r.mint] ?? null, postOf: (id) => posts[id] ?? null, wakes, nowMs: NOW_MS, tagOf: tagsOf({ a: AI, b: AI, f1: AI, c: CAT, f2: DOG }) });
  assert.deepEqual(g.cards.map((c) => [c.kind, c.key, c.coins.map((r) => r.mint), c.narrative?.id ?? null, c.keys]), [
    ["narrative", "n:7", ["a", "b", "c"], 7, ["n:7", X]], // 32 buyers: the narrative leads (narrative > post)
    ["post", Y, ["f1", "f2", "f3"], null, [Y, "P"]],      // 27 buyers: f1's own post leads its family (post > family)
  ]);
  const card = g.cards[0];
  // the post shown is the one linked by its most-bought coin that links a usable one: c (20 buyers) links X
  assert.deepEqual([card.buyers5m, card.post, card.family], [32, { id: X, handle: "poster", text: "big news", at: 1_769_999_000, url: `https://x.com/i/status/${X}` }, null]);
  assert.deepEqual(card.coins.map((r) => [r.mint, r.narrative?.id ?? null, r.isNew]), [["a", 7, false], ["b", 7, false], ["c", 4, false]], "each row keeps its own tag");
  assert.deepEqual([g.cards[1].family.mint, g.cards[1].coins[0].narrative, mints(g.loose)], ["P", AI, ["z"]]);
  // without a usable post on any coin the narrative card has none, and the family keeps its own card
  const bare = groupStories({ rows, postIdOf: (r) => links[r.mint] ?? null, postOf: () => null, wakes, nowMs: NOW_MS, tagOf: tagsOf({ a: AI, b: AI }) });
  assert.equal(bare.cards.find((c) => c.kind === "narrative").post, null);
  assert.deepEqual(bare.cards.map((c) => [c.kind, c.key, "keys" in c]), [["family", "P", false], ["narrative", "n:7", false]]);
});

test("narrative cards sort and cap with the others; themes count the narrative cards listed; a broken tag look-up tags nothing", () => {
  const rows = [], tags = {};
  for (let i = 0; i < CARDS_MAX + 2; i++) {
    for (const s of ["x", "y"]) { const m = `${s}${String(i).padStart(2, "0")}`; rows.push(row(m, { buyers5m: 100 - i })); tags[m] = { id: i + 1, title: `story ${i}`, theme: i % 3 === 0 ? "ai" : i % 3 === 1 ? "animals" : "politics" }; }
  }
  const g = groupStories({ rows, nowMs: NOW_MS, tagOf: tagsOf(tags) });
  assert.deepEqual([g.cards.length, g.hidden.cards, g.cards[0].key, g.cards[0].buyers5m, g.cards[CARDS_MAX - 1].key], [CARDS_MAX, 2, "n:1", 200, `n:${CARDS_MAX}`]);
  assert.deepEqual(g.themes, [{ theme: "ai", cards: 7 }, { theme: "animals", cards: 7 }, { theme: "politics", cards: 6 }]);
  const broken = groupStories({ rows: rows.slice(0, 4), nowMs: NOW_MS, tagOf: () => { throw new Error("store down"); } });
  assert.deepEqual([broken.cards.length, broken.loose.length, broken.themes], [0, 4, []]);
  const odd = groupStories({ rows: rows.slice(0, 2), nowMs: NOW_MS, tagOf: () => ({ id: "7", title: 5 }) });
  assert.deepEqual([odd.cards.length, "narrative" in odd.loose[0]], [0, false], "a tag that is not { id, title, theme } is no tag");
});

test("subject blocks (rule 2c): narratives of one story subject fold into one card keyed t:..., even one-coin narratives; quiet subjects and lone narratives stay as they were", async () => {
  const { subjectMatcher } = await import("../lib/subjects.mjs");
  const J1 = { id: 925, title: "jensen the white leather jacket", theme: "tech" }, J2 = { id: 1021, title: "nvidia reinstates jensen huang ceo", theme: "tech" };
  const J3 = { id: 513, title: "nvidia ceo gooner exposed", theme: "tech" }, NV = { id: 1037, title: "2006 nvidia frog mascot", theme: "tech" }, NV2 = { id: 1028, title: "ninja nvidia office dog", theme: "tech" };
  const G1 = { id: 23, title: "gta 6", theme: "games" };
  const subjectOf = subjectMatcher({ subjects: [
    { key: "t:huang-jensen", title: "Jensen Huang", anchors: ["jensen", "huang"], include: [513] },
    { key: "t:nvidia", title: "Nvidia", anchors: ["nvidia"], quiet: true },
    { key: "t:gta", title: "GTA 6", anchors: ["gta"] },
  ] });
  assert.deepEqual(subjectOf(J2), { key: "t:huang-jensen", title: "Jensen Huang", quiet: false }, "a story row beats a quiet row");
  assert.deepEqual(subjectOf(J3)?.key, "t:huang-jensen", "an include needs none of the words");
  assert.deepEqual(subjectOf(NV), { key: "t:nvidia", title: "Nvidia", quiet: true });
  assert.equal(subjectOf({ id: 1, title: "xiaohuang friends" }), null);
  const rows = [
    row("a", { buyers5m: 30 }), row("b", { buyers5m: 10 }), row("c", { buyers5m: 6 }), row("d", { buyers5m: 2 }),
    row("n1", { buyers5m: 9 }), row("n2", { buyers5m: 4 }), row("n3", { buyers5m: 3 }), row("g1", { buyers5m: 5 }), row("g2", { buyers5m: 1 }),
  ];
  const tags = { a: J1, b: J1, c: J2, d: J3, n1: NV, n2: NV, n3: NV2, g1: G1, g2: G1 };
  const g = groupStories({ rows, nowMs: NOW_MS, tagOf: tagsOf(tags), newCoins1hOf: (id) => ({ 925: 4, 1021: 2 })[id] ?? 0, subjectOf });
  const j = g.cards.find((c) => c.key === "t:huang-jensen");
  assert.ok(j, "one Jensen block");
  assert.deepEqual([j.kind, j.narrative, j.buyers5m, j.coinsN], ["narrative", { id: 925, title: "Jensen Huang", theme: "tech", newCoins1h: 6 }, 48, 4]);
  assert.deepEqual(j.subject.angles.map((x) => [x.id, x.buyers5m, x.coinsN]), [[925, 40, 2], [1021, 6, 1], [513, 2, 1]], "one-coin narratives join the block");
  assert.deepEqual(j.coins.map((r) => [r.mint, r.narrative.id]), [["a", 925], ["b", 925], ["c", 1021], ["d", 513]]);
  assert.ok(g.cards.some((c) => c.key === "n:1037") && !g.cards.some((c) => c.key === "t:nvidia"), "a quiet subject: its narratives keep their own cards");
  assert.ok(g.loose.some((r) => r.mint === "n3"), "and a one-coin quiet narrative stays loose");
  assert.ok(g.cards.some((c) => c.key === "n:23") && !g.cards.some((c) => c.key === "t:gta"), "a subject reached by one narrative: the narrative card, as before");
  assert.ok(!g.cards.some((c) => c.key === "n:925" || c.key === "n:1021"), "no Jensen narrative card beside the block");
  const off = groupStories({ rows, nowMs: NOW_MS, tagOf: tagsOf(tags) });
  assert.deepEqual(groupStories({ rows, nowMs: NOW_MS, tagOf: tagsOf(tags), subjectOf: () => { throw new Error("x"); } }), off, "a failing subjectOf changes nothing");
});

test("by name (rule 2d): an untagged loose coin named by exactly one narrative card's title joins it, marked byName; a tagged coin, two fits or no tagging keep it loose", () => {
  const JS = { id: 31, title: "jensen spy affair", theme: "tech" }, CT = { id: 32, title: "turkey pardon", theme: "news" }, OT = { id: 33, title: "other thing", theme: "news" };
  const rows = [
    row("j1", { name: "Jensen Spy", symbol: "JSPY", buyers5m: 50 }), row("j2", { name: "Jensen Affair", symbol: "JAFF", buyers5m: 40 }),
    row("t1", { name: "Free Turkey", symbol: "TURK", buyers5m: 30 }), row("t2", { name: "Turkey Pardon", symbol: "PARDON", buyers5m: 20 }),
    row("new", { name: "Jensen Spy Wife", symbol: "WIFE", buyers5m: 15, createdAt: Math.floor(NOW_MS / 1000) - 60 }), // untagged, named by the Jensen story
    row("both", { name: "Jensen Turkey", symbol: "JT", buyers5m: 12 }), // names both stories: stays loose
    row("tagd", { name: "Jensen Spy", symbol: "JS2", buyers5m: 11 }), // tagged with another narrative: its tag wins
    row("plain", { name: "Moon Dog", symbol: "MDOG", buyers5m: 9 }),
  ];
  const tags = { j1: JS, j2: JS, t1: CT, t2: CT, tagd: OT };
  const g = groupStories({ rows, nowMs: NOW_MS, tagOf: tagsOf(tags) });
  const js = g.cards.find((c) => c.key === "n:31");
  assert.deepEqual(js.coins.map((c) => [c.mint, c.byName === true]), [["j1", false], ["j2", false], ["new", true]]);
  assert.deepEqual([js.coinsN, js.buyers5m, js.newN], [3, 105, 1]);
  assert.equal(js.coins[2].narrative.id, 31);
  assert.deepEqual(g.loose.map((r) => r.mint).sort(), ["both", "plain", "tagd"]);
  const off = groupStories({ rows, nowMs: NOW_MS });
  assert.equal(off.cards.length, 0, "no tagging: no narrative cards, nothing placed by name");
  const none = groupStories({ rows, nowMs: NOW_MS, tagOf: tagsOf(tags), answeredOf: (r) => r.mint === "new" });
  assert.ok(none.loose.some((r) => r.mint === "new"), "a coin the tagger answered 'none' for stays loose");
  // a by-name coin with the same ticker and image as a card coin folds under it as a copy
  const cp = groupStories({ rows: [...rows, row("j1b", { name: "Jensen Spy", symbol: "JSPY", image: "img-j1", buyers5m: 1 })].map((r) => (r.mint === "j1" ? { ...r, image: "img-j1" } : r)), nowMs: NOW_MS, tagOf: tagsOf(tags) });
  const jc = cp.cards.find((c) => c.key === "n:31");
  assert.deepEqual(jc.coins.map((c) => [c.mint, (c.copies ?? []).map((x) => x.mint)]), [["j1", ["j1b"]], ["j2", []], ["new", []]]);
});

test("narrative cards: a post that is only a link or a picture never leads the card; the next post with words does, else none", () => {
  const rows = [row("a", { buyers5m: 30 }), row("b", { buyers5m: 20 }), row("c", { buyers5m: 5 })];
  const posts = { 1: { handle: "empty", text: "https://t.co/XuCyuPCzYc pic.twitter.com/IGobK4KxZN" }, 2: { handle: "said", text: "Merry Dogemas, tag a business https://t.co/x" } };
  const card = (links) => groupStories({ rows, postIdOf: (r) => links[r.mint] ?? null, postOf: (id) => posts[id] ?? null, nowMs: NOW_MS, tagOf: tagsOf({ a: AI, b: AI, c: AI }) }).cards[0];
  const p = card({ a: "1", c: "2" }).post;
  assert.deepEqual([p.id, p.handle], ["2", "said"], "the most-bought coin's post has no words: the next one that has words");
  assert.equal(card({ a: "1", b: "1" }).post, null, "only wordless posts: the card has no post (its counted line says more)");
  posts[3] = { handle: "quoter", text: "https://t.co/Ab12", quotes: true };
  assert.equal(card({ a: "3", c: "2" }).post.id, "3", "a wordless post that quotes a post with words may lead (the card gets the quoted line)");
});

// ---------------------------------------------------------------- the linking step (one card per connected story)
const MINT = (c) => c.repeat(44);
test("linking: the Enu case — a narrative, its coins' waking family and the family's parent coin are one card led by the narrative", () => {
  const ENU = MINT("E"), GOLD = MINT("G"), ENUN = { id: 501, title: "enu", theme: "memes" };
  const wake = { mint: ENU, symbol: "enu", image: "img-enu", startedAt: 1_769_990_000, postId: null };
  const rows = [
    row("AENU", { parent: under(ENU), buyers5m: 30 }),
    row(ENU, { symbol: "enu", buyers5m: 25 }),
    row("Denu", { parent: under(GOLD), buyers5m: 12 }),   // its own parent is not waking
    row(GOLD, { symbol: "Goldenu", parent: under(ENU), buyers5m: 9 }),
    row("Enuf", { parent: under(ENU), buyers5m: 4 }),
    row("other", { buyers5m: 50 }),
  ];
  const g = groupStories({ rows, nowMs: NOW_MS, wakes: new Map([[ENU, wake]]), tagOf: tagsOf({ AENU: ENUN, [ENU]: ENUN, Denu: ENUN }) });
  assert.equal(g.cards.length, 1, "one card, not a narrative card beside a family card");
  const [c] = g.cards;
  assert.deepEqual([c.kind, c.key, c.keys, mints(c.coins), c.coinsN, c.buyers5m, c.family], ["narrative", "n:501", ["n:501", ENU], ["AENU", ENU, "Denu", GOLD, "Enuf"], 5, 80, { mint: ENU, symbol: "enu", image: "img-enu", startedAt: 1_769_990_000 }]);
  assert.deepEqual(c.parts, [{ kind: "narrative", key: "n:501", title: "enu", coinsN: 3, buyers5m: 67 }, { kind: "family", key: ENU, title: "enu", coinsN: 4, buyers5m: 68 }]);
  assert.deepEqual([c.narrative.id, c.newN, c.olderN, c.coins.every((r) => "isNew" in r)], [501, 0, 5, true]);
  assert.deepEqual(mints(g.loose), ["other"], "a coin with no label stays loose");
});

test("linking: the Zerocoin case — a post card and the narrative its tagged coin belongs to are one card", () => {
  const P = idAt(1_769_999_000), ZRC = { id: 77, title: "zerocoin", theme: "crypto" };
  const rows = [row("ZERO", { buyers5m: 40 }), row("ZRC1", { buyers5m: 20 }), row("ZRC2", { buyers5m: 8 }), row("ZRC3", { buyers5m: 6 })];
  const links = { ZERO: P, ZRC1: P };
  const posts = { [P]: { handle: "chamath", text: "https://t.co/abc" } }; // a link-only post
  const g = groupStories({ rows, postIdOf: (r) => links[r.mint] ?? null, postOf: (id) => posts[id] ?? null, nowMs: NOW_MS, tagOf: tagsOf({ ZRC1: ZRC, ZRC2: ZRC, ZRC3: ZRC }) });
  assert.equal(g.cards.length, 1);
  const [c] = g.cards;
  assert.deepEqual([c.kind, c.key, c.keys, mints(c.coins), c.coinsN, c.buyers5m], ["narrative", "n:77", ["n:77", P], ["ZERO", "ZRC1", "ZRC2", "ZRC3"], 4, 74]);
  assert.equal(c.post, null, "a link-only post never leads a grouped card (as before)");
  // without the tags it is the post card it was, with no keys or parts
  const off = groupStories({ rows, postIdOf: (r) => links[r.mint] ?? null, postOf: (id) => posts[id] ?? null, nowMs: NOW_MS });
  assert.deepEqual(off.cards.map((x) => [x.kind, x.key, mints(x.coins), "keys" in x, "parts" in x]), [["post", P, ["ZERO", "ZRC1"], false, false]]);
});

test("linking: the chaining guard — one tagged coin does not glue two stories together; two do, and a small side joins", () => {
  const X = idAt(1_769_999_000), N = { id: 12, title: "frog", theme: "animals" };
  const posts = { [X]: { handle: "poster", text: "news" } };
  const run = (rows, links, tags) => groupStories({ rows, postIdOf: (r) => links[r.mint] ?? null, postOf: (id) => posts[id] ?? null, nowMs: NOW_MS, tagOf: tagsOf(tags) });
  const rows = [row("p1", { buyers5m: 30 }), row("p2", { buyers5m: 20 }), row("p3", { buyers5m: 10 }), row("n1", { buyers5m: 9 }), row("n2", { buyers5m: 8 })];
  // p3 is the only frog coin of post X's three: a lone bridge between a 2-coin post story and a 2-coin frog story
  let g = run(rows, { p1: X, p2: X, p3: X }, { p3: N, n1: N, n2: N });
  assert.deepEqual(g.cards.map((c) => [c.kind, c.key, mints(c.coins), c.keys ?? null]), [["post", X, ["p1", "p2", "p3"], null], ["narrative", "n:12", ["n1", "n2"], null]]);
  assert.deepEqual(g.cards[0].coins[2].narrative, N, "the bridge coin keeps its tag on its row");
  // two frog coins in the post story: not a lone bridge, one card
  g = run(rows, { p1: X, p2: X, p3: X }, { p2: N, p3: N, n1: N, n2: N });
  assert.deepEqual(g.cards.map((c) => [c.kind, c.key, mints(c.coins), c.keys]), [["narrative", "n:12", ["p1", "p2", "p3", "n1", "n2"], ["n:12", X]]]);
  // the post story is only one other coin: it joins the frog story
  g = run(rows.filter((r) => r.mint !== "p2"), { p1: X, p3: X }, { p3: N, n1: N, n2: N });
  assert.deepEqual(g.cards.map((c) => [c.key, mints(c.coins)]), [["n:12", ["p1", "p3", "n1", "n2"]]]);
  // the frog story has only one coin outside: it joins the post story
  g = run(rows.filter((r) => r.mint !== "n2"), { p1: X, p2: X, p3: X }, { p3: N, n1: N });
  assert.deepEqual(g.cards.map((c) => [c.key, mints(c.coins)]), [["n:12", ["p1", "p2", "p3", "n1"]]]);
  // a copy of the bridge coin is still one coin: the bridge is cut
  const twin = { symbol: "TW", image: "tw" };
  g = run([...rows, row("p3b", { ...twin, buyers5m: 1 })].map((r) => (r.mint === "p3" ? { ...r, ...twin } : r)), { p1: X, p2: X, p3: X, p3b: X }, { p3: N, p3b: N, n1: N, n2: N });
  assert.deepEqual(g.cards.map((c) => [c.key, mints(c.coins)]), [[X, ["p1", "p2", "p3"]], ["n:12", ["n1", "n2"]]]);
  // a narrative cut from two big stories with one coin left over has no card: that coin is loose
  const Y = idAt(1_769_999_100);
  posts[Y] = { handle: "y", text: "y" };
  const two = [...rows.slice(0, 3), row("q1"), row("q2"), row("q3"), row("lone", { buyers5m: 1 })];
  g = run(two, { p1: X, p2: X, p3: X, q1: Y, q2: Y, q3: Y }, { p3: N, q3: N, lone: N });
  assert.deepEqual([g.cards.map((c) => [c.key, mints(c.coins), c.keys ?? null]), mints(g.loose)], [[[X, ["p1", "p2", "p3"], null], [Y, ["q1", "q2", "q3"], null]], ["lone"]]);
  // a 2-coin narrative whose coins sit in two big post stories joins neither: two post cards, the frog label dropped
  g = run(two.filter((r) => r.mint !== "lone"), { p1: X, p2: X, p3: X, q1: Y, q2: Y, q3: Y }, { p3: N, q3: N });
  assert.deepEqual([g.cards.map((c) => [c.kind, c.key, mints(c.coins), c.keys ?? null]), mints(g.loose)], [[["post", X, ["p1", "p2", "p3"], null], ["post", Y, ["q1", "q2", "q3"], null]], []]);
  // a small post holding one coin of each of two big narratives glues neither: each narrative its own card, the post its own
  const N2 = { id: 13, title: "toad", theme: "animals" };
  const ab = ["a1", "a2", "a3", "a4", "b1", "b2", "b3", "b4"].map((m) => row(m));
  g = run(ab, { a1: X, b1: X }, { a1: N, a2: N, a3: N, a4: N, b1: N2, b2: N2, b3: N2, b4: N2 });
  assert.deepEqual(g.cards.map((c) => [c.kind, c.key, mints(c.coins), c.keys ?? null]).sort((x, y) => (x[1] < y[1] ? -1 : 1)),
    [["post", X, ["a1", "b1"], null], ["narrative", "n:12", ["a2", "a3", "a4"], null], ["narrative", "n:13", ["b2", "b3", "b4"], null]].sort((x, y) => (x[1] < y[1] ? -1 : 1)));
  // the same with the post holding a second coin of one narrative: that narrative and the post are one story, the other stays apart
  g = run(ab, { a1: X, a2: X, b1: X }, { a1: N, a2: N, a3: N, a4: N, b1: N2, b2: N2, b3: N2, b4: N2 });
  assert.deepEqual(g.cards.map((c) => [c.key, mints(c.coins)]).sort(), [["n:12", ["a1", "a2", "a3", "a4", "b1"]], ["n:13", ["b2", "b3", "b4"]]].sort());
});

test("linking: a card of one story is what it was (no keys, no parts); dust never links; the caps hold", () => {
  const X = idAt(1_769_999_000);
  const posts = { [X]: { handle: "h", text: "t" } };
  const g = group([row("a"), row("b"), row("d", { mcapUsd: 1e9, liqUsd: 10, parent: under("P") })], { links: { a: X, d: X }, posts, wakes: [{ mint: "P", symbol: "P", image: null, startedAt: 1, postId: null }] });
  assert.deepEqual(g.cards.map((c) => [c.kind, Object.keys(c), mints(c.coins)]), [["post", ["kind", "key", "post", "family", "buyers5m", "coinsN", "coins"], ["a"]]], "the dust coin brings no family label");
  assert.deepEqual([mints(g.loose), mints(g.dust)], [["b"], ["d"]]);
  assert.deepEqual([CARDS_MAX, LOOSE_MAX, DUST_MAX], [20, 30, 30]);
});
