// Narrative tags on the Discover page (web/src/lib/discover.ts, GET /api/stories with tagging on): the title as shown,
// the theme pills and the stored theme, the theme filter with the size filter, a narrative card's two runs and head,
// the held order, live prices, and a body without tagging reading exactly as before. No DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stories, StoryCard, StoryRow } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");

const NOW = 1_770_000_100;
const row = (mint: string, o: Partial<StoryRow> = {}): StoryRow => ({
  mint, name: "Dog", symbol: mint, image: null, createdAt: NOW - 7200, existing: true, mcapUsd: 41_000, priceUsd: 0.000041, sinceStart: null, buyers5m: 10,
  tf: { p0: 0.00003, chg: 38, volUsd: 900, buys: 52, sells: 9, buyers: 40, holding: 33 }, liqUsd: 5_200, parent: null, family: null, ...o,
});
const N1 = { id: 7, title: "trump tariff panic", theme: "politics" }, N2 = { id: 9, title: "robot dogs", theme: "ai" };
const POST = { id: "1895000000000000001", handle: "poster", text: "big news", at: NOW - 6 * 60 - 10, url: "https://evil.example/x" };
const ncard = (o: Partial<StoryCard> = {}): StoryCard => ({
  kind: "narrative", key: "n:7", narrative: { ...N1, newCoins1h: 5 }, post: POST, family: null, buyers5m: 60, coinsN: 4, newN: 2, olderN: 2,
  coins: [row("A", { narrative: N1, isNew: true, buyers5m: 30, copies: [{ mint: "A2", createdAt: NOW - 60, firstSeenAt: null, liqUsd: 10, buyers5m: 5 }] }), row("B", { narrative: N1, isNew: false, buyers5m: 15, mcapUsd: 9_000_000 }), row("C", { narrative: N1, isNew: true, buyers5m: 10 })], ...o,
});
const body = (o: Partial<Stories> = {}): Stories => ({
  asOf: NOW, tf: "5m", hidden: { dust: 9, cards: 1, loose: 4 }, tagging: { on: true, tagged: 40, pending: 3, capped: false },
  themes: [{ theme: "politics", cards: 1 }, { theme: "ai", cards: 1 }],
  cards: [
    ncard(),
    ncard({ key: "n:9", narrative: { ...N2, newCoins1h: 1 }, post: null, buyers5m: 20, coinsN: 2, coins: [row("D", { narrative: N2, isNew: false }), row("E", { narrative: N2, isNew: false })] }),
    { kind: "post", key: POST.id, post: POST, family: null, narrative: N2, buyers5m: 10, coinsN: 1, coins: [row("F", { narrative: N2 })] },
    { kind: "family", key: "Par", post: null, family: { mint: "Par", symbol: "PAR", image: null, startedAt: NOW - 300 }, narrative: null, buyers5m: 10, coinsN: 1, coins: [row("G")] },
  ],
  loose: [row("L1", { narrative: N1 }), row("L2"), row("L3", { narrative: N2, mcapUsd: 200_000 })],
  dust: [{ ...row("T", { narrative: N1 }), reason: "tiny" }, { ...row("P"), reason: "paper" }],
  ...o,
});

test("n1. a title as shown: title-cased, capitals kept, joining words small, made plain, cut, never empty", () => {
  assert.equal(D.narrativeTitle("trump tariff panic"), "Trump Tariff Panic");
  assert.equal(D.narrativeTitle("the return of the AI iPhone"), "The Return of the AI iPhone");
  assert.equal(D.narrativeTitle("  cats\n\tvs   dogs "), "Cats vs Dogs");
  assert.equal(D.narrativeTitle("$doge to the moon"), "$Doge to the Moon");
  assert.equal(D.narrativeTitle("élan 2026"), "Élan 2026");
  // markup stays text (the page draws a text node); control and direction-override characters are dropped
  assert.equal(D.narrativeTitle("<img src=x onerror=alert(1)>"), "<Img Src=x Onerror=alert(1)>");
  assert.equal(D.narrativeTitle("safe‮evil\u0000​ name"), "Safe Evil Name");
  const long = D.narrativeTitle("word ".repeat(40));
  assert.ok(long.length <= D.TITLE_MAX && long.endsWith("…"), long);
  for (const none of [null, undefined, "", "   ", 7, {}, "\u0000​"]) assert.equal(D.narrativeTitle(none), "Untitled story");
});

test("n2. themes: keys, words, the stored pill, and which theme is in force", () => {
  assert.equal(D.themeLabel("ai"), "AI");
  assert.equal(D.themeLabel("market crash"), "Market crash");
  assert.equal(D.themeLabel(" Tech & Products "), "Tech & products");
  for (const none of [null, undefined, "", 3, "x".repeat(41)]) assert.equal(D.themeLabel(none), "");
  assert.equal(D.themeOf({ theme: "Politics " }), "politics");
  assert.equal(D.themeOf(null), null);
  assert.equal(D.themeOf({ theme: "all" }), null, "the filter's own key is never a theme");
  assert.equal(D.parseTheme("politics"), "politics");
  for (const bad of [null, undefined, "", 5, "all", "x".repeat(60)]) assert.equal(D.parseTheme(bad), D.ALL_THEMES);
  assert.equal(D.THEME_KEY, "spore:dsc-theme");
  const mem = new Map<string, string>();
  const ok = () => ({ getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } });
  D.writePref(ok, D.THEME_KEY, "ai");
  assert.equal(D.readPref(ok, D.THEME_KEY, D.parseTheme), "ai");
  const blocked = () => { throw new Error("SecurityError"); };
  assert.equal(D.readPref(blocked, D.THEME_KEY, D.parseTheme), "all");
  assert.doesNotThrow(() => D.writePref(blocked, D.THEME_KEY, "ai"));
  const pills = D.themePills(D.storiesView(body(), null));
  assert.equal(D.activeTheme("ai", pills), "ai");
  assert.equal(D.activeTheme("sports", pills), "all", "a stored theme without a pill filters nothing");
  assert.equal(D.activeTheme("all", pills), "all");
  assert.equal(D.activeTheme("ai", []), "all");
});

test("n3. the theme pills: All themes, then every theme with a card in a fixed order by name (other last), never by count; broken and repeated entries dropped; a kept theme keeps its pill; none without themes", () => {
  const v = D.storiesView(body(), null);
  assert.deepEqual(D.themePills(v).map((p) => [p.key, p.text]), [["all", "All themes"], ["ai", "AI"], ["politics", "Politics"]]);
  const many = ["h", "b", "c", "a", "e", "f", "g", "d"].map((t, i) => ({ theme: `t${t}`, cards: i + 1 }));
  const p = D.themePills({ ...v, themes: [{ theme: "other", cards: 7 }, ...many, { theme: "th", cards: 99 }, { theme: "", cards: 50 }, { theme: "zero", cards: 0 }, null as never] });
  assert.deepEqual(p.map((x) => x.key), ["all", "ta", "tb", "tc", "td", "te", "tf", "tg", "th", "other"], "a seventh theme has a pill too");
  assert.equal(p.find((x) => x.key === "th")?.title, "Only stories tagged Th: 1 now", "of two entries for one theme the first counts");
  // the counts change between reads; the pills do not change places
  const swapped = D.themePills({ ...v, themes: [{ theme: "politics", cards: 1 }, { theme: "ai", cards: 5 }] }).map((x) => x.key);
  assert.deepEqual(swapped, D.themePills({ ...v, themes: [{ theme: "ai", cards: 1 }, { theme: "politics", cards: 5 }] }).map((x) => x.key));
  // a pill shown before, or the reader's stored choice, stays when its last card drops out: the filter stays in force
  const kept = D.themePills({ ...v, themes: [{ theme: "ai", cards: 2 }] }, new Set(["sports", "ai", "all", ""]));
  assert.deepEqual(kept.map((x) => [x.key, x.title]), [["all", "Stories of every theme"], ["ai", "Only stories tagged AI: 2 now"], ["sports", "Only stories tagged Sports: none right now"]]);
  assert.equal(D.activeTheme("sports", kept), "sports");
  assert.equal(D.filterStories(v, "all", "sports").total, 0);
  assert.equal(D.emptyFiltered("all", "sports"), "No Sports story is being bought right now.");
  assert.deepEqual(D.themePills({ themes: [], cards: [] }, ["gaming"]).map((x) => x.key), ["all", "gaming"]);
  // no list from the server: counted from the narrative cards on screen
  assert.deepEqual(D.themePills({ ...v, themes: [] }).map((x) => x.key), ["all", "ai", "politics"]);
  assert.deepEqual(D.themePills({ themes: [], cards: [] }), []);
  for (const x of p) assert.doesNotMatch(`${x.text} ${x.title}`, /recommend|good|likely|early|signal|alpha/i);
});

test("n4. the view: narrative cards are kept with their rows' narrative and isNew; one without a narrative is dropped", () => {
  const v = D.storiesView(body({ cards: [...body().cards, ncard({ key: "n:1", narrative: null, coins: [row("Z")] }), ncard({ key: "n:2", narrative: { id: "x", title: 3 } as never, coins: [row("Y")] })] }), null);
  assert.deepEqual(v.cards.map((c) => D.cardKey(c)), ["narrative:n:7", "narrative:n:9", `post:${POST.id}`, "family:Par"]);
  assert.equal(v.tagging, true);
  assert.deepEqual(v.themes, body().themes);
  assert.equal(v.cards[0].coins[0].isNew, true);
  assert.deepEqual(v.cards[0].coins[0].narrative, N1);
  assert.equal(D.narrativesOn(v), true);
  assert.deepEqual(D.narrativeOf(v.loose[0]), N1);
  assert.equal(D.narrativeOf(v.loose[1]), null);
  assert.equal(D.narrativeOf({ narrative: { id: NaN, title: "x" } }), null);
});

test("n5. tagging off, absent, or no narrative card: nothing of the narratives is shown and the view is as before", () => {
  const old = body({ tagging: undefined, themes: undefined, cards: body().cards.filter((c) => c.kind !== "narrative") });
  const v = D.storiesView(old, null);
  assert.equal(v.tagging, false);
  assert.deepEqual(v.themes, []);
  assert.equal(D.narrativesOn(v), false);
  assert.equal(D.narrativesOn(D.storiesView({ ...old, tagging: { on: false } }, null)), false);
  assert.equal(D.narrativesOn(D.storiesView({ ...old, tagging: { on: true, tagged: 3, pending: 0, capped: false }, themes: [] }, null)), false, "tagging on, no narrative card yet");
  assert.equal(D.narrativesOn(D.storiesView({ ...body(), tagging: { on: false } }, null)), false);
  assert.equal(D.narrativesOn(null), false);
  // the filter without a theme is the size filter alone
  assert.deepEqual(D.filterStories(v, "all"), D.filterStories(v, "all", "all"));
  assert.equal(D.filterStories(v, "all").dustN, 9);
});

test("n6. the theme filter: only cards and loose rows of the theme; it combines with the size", () => {
  const v = D.storiesView(body(), null);
  const pol = D.filterStories(v, "all", "politics");
  assert.deepEqual(pol.cards.map((c) => c.key), ["n:7"]);
  assert.deepEqual(pol.loose.map((r) => r.mint), ["L1"]);
  assert.deepEqual(pol.dust.map((r) => r.mint), ["T"]);
  assert.equal(pol.dustN, 1, "under a theme only the dust rows received can be told apart");
  assert.equal(pol.total, 2);
  const ai = D.filterStories(v, "all", "ai");
  assert.deepEqual(ai.cards.map((c) => D.cardKey(c)), ["narrative:n:9", `post:${POST.id}`], "a post card whose coins share a narrative is of its theme");
  assert.deepEqual(ai.loose.map((r) => r.mint), ["L3"]);
  // with a size: the card's numbers count the coins it still shows
  const big = D.filterStories(v, "large", "politics");
  assert.deepEqual(big.cards.map((c) => [c.key, c.buyers5m, c.coinsN, c.coins.map((r) => r.mint)]), [["n:7", 15, 1, ["B"]]]);
  assert.deepEqual(big.loose, []);
  assert.deepEqual(D.filterStories(v, "mid", "ai").loose.map((r) => r.mint), ["L3"]);
  assert.equal(D.filterStories(v, "large", "ai").total, 0);
  assert.equal(D.filterStories(v, "all", "sports").total, 0);
  // order kept
  assert.deepEqual(D.filterStories(v, "all").cards.map((c) => c.key), v.cards.map((c) => c.key));
  assert.equal(D.emptyFiltered("large", "ai"), "No AI story of this size is being bought right now.");
  assert.equal(D.emptyFiltered("all", "market crash"), "No Market crash story is being bought right now.");
  assert.equal(D.emptyFiltered("small"), "No coin of this size is being bought right now.");
});

test("n7. a narrative card: two runs in the order received, totals with copies, and its head", () => {
  const c = D.storiesView(body(), null).cards[0];
  const { fresh, older } = D.splitNew(c.coins);
  assert.deepEqual(fresh.map((r) => r.mint), ["A", "C"]);
  assert.deepEqual(older.map((r) => r.mint), ["B"]);
  assert.deepEqual(D.splitNew([{ isNew: undefined }, { isNew: false }, {}]).fresh, [], "only a row the server marked is new");
  assert.deepEqual(D.splitNew([]), { fresh: [], older: [] });
  assert.deepEqual(D.cardTotals(c.coins), { buyers5m: 30 + 5 + 15 + 10, coinsN: 4 });
  const h = D.narrativeHead(c, NOW);
  assert.deepEqual(h, { title: "Trump Tariff Panic", theme: "Politics", newCoins: 5, post: { text: "@poster · 6 min ago", href: "https://x.com/i/status/1895000000000000001" } });
  assert.ok(!h.post!.href!.includes("evil"), "the link is rebuilt from the id, never the body's url");
  assert.equal(D.narrativeHead({ narrative: { ...N2, newCoins1h: -3 }, post: null }, NOW).post, null);
  assert.equal(D.narrativeHead({ narrative: { ...N2 }, post: null }, NOW).newCoins, 0);
  const bad = D.narrativeHead({ narrative: N1, post: { ...POST, id: "javascript:alert(1)", handle: null, at: null } }, NOW);
  assert.deepEqual(bad.post, { text: "Linked post", href: null });
  assert.equal(D.NEW_LABEL, "New this hour");
  assert.equal(D.OLDER_LABEL, "Older coins in this story");
  assert.equal(D.MODEL_NOTE, "Stories are grouped by a language model reading each coin's public text. It can be wrong.");
  for (const s of [D.MODEL_NOTE, D.TAG_NOTE, D.NEW_COINS_TITLE, D.NEW_LABEL, D.OLDER_LABEL]) assert.doesNotMatch(s, /recommend|good|likely|early|signal|alpha/i);
});

test("n8. held: a narrative card keeps its place, its rows their run and size; live trades move its coins; idle, the server's shape", () => {
  const v = D.storiesView(body(), null);
  const next = body({
    cards: [
      ncard({ key: "n:9", narrative: { ...N2, newCoins1h: 2 }, post: null, coins: [row("D", { narrative: N2, isNew: false }), row("E", { narrative: N2, isNew: false })] }),
      // A turned an hour old and crossed $100K; C left; a new coin N came
      ncard({ coins: [row("N", { narrative: N1, isNew: true }), row("A", { narrative: N1, isNew: false, mcapUsd: 150_000, buyers5m: 31 }), row("B", { narrative: N1, isNew: false, mcapUsd: 9_000_000 })] }),
    ],
    loose: [], dust: [],
  });
  const held = D.storiesView(next, v, true);
  assert.deepEqual(held.cards.map((c) => [c.key, !!c.left]), [["n:7", false], ["n:9", false], [POST.id, true], ["Par", true]]);
  const c = held.cards[0];
  assert.deepEqual(c.coins.map((r) => [r.mint, r.isNew, r.size, !!r.left]), [["A", true, "small", false], ["B", false, "large", false], ["C", true, "small", true], ["N", true, "small", false]]);
  assert.equal(c.coins[0].buyers5m, 31, "fresh numbers in place");
  assert.deepEqual(D.splitNew(c.coins).fresh.map((r) => r.mint), ["A", "C", "N"]);
  assert.equal(held.cards[1].narrative?.newCoins1h, 2);
  const idle = D.storiesView(next, held, false);
  assert.deepEqual(idle.cards.map((x) => x.key), ["n:9", "n:7"]);
  assert.deepEqual(idle.cards[1].coins.map((r) => [r.mint, r.isNew, r.size]), [["N", true, "small"], ["A", false, "mid"], ["B", false, "large"]]);
  // live: a trade of a narrative card's coin moves its price and nothing else
  assert.ok(D.storyMints(v).has("A") && D.storyMints(v).has("D"));
  const live = D.liveStories(v, D.tradesByMint([{ mint: "A", time: NOW + 1, priceUsd: 0.000082, at: 1 }]));
  assert.notEqual(live, v);
  assert.equal(live.cards[0].kind, "narrative");
  assert.equal(Math.round(live.cards[0].coins[0].mcapUsd as number), 82_000);
  assert.equal(live.cards[0].coins[0].size, "small");
  assert.equal(live.cards[0].coins[0].isNew, true);
  assert.equal(live.cards[1], v.cards[1]);
  assert.equal(live.tagging, true);
  const carried = D.carryLiveStories(D.storiesView(body(), live, false), live, 1000);
  assert.equal(carried.cards[0].coins[0].priceUsd, 0.000082);
  assert.equal(D.liveStories(v, D.tradesByMint([{ mint: "nope", time: NOW, priceUsd: 1 }])), v);
});

test("n12. held: a coin that joins a story card is marked moved where it was, not dropped; the themes and the filter hold; idle, the server's shape", () => {
  const X = row("X"), Y = row("Y"), Z = row("Z");
  const before = D.storiesView(body({ cards: [ncard()], themes: [{ theme: "politics", cards: 1 }], loose: [X, Y, Z], dust: [] }), null);
  // tags arrived: X and Y share a story now and get a card; the politics card fell off the page
  const N5 = { id: 5, title: "robot uprising", theme: "ai" };
  const read2 = body({ cards: [ncard({ key: "n:5", narrative: { ...N5, newCoins1h: 0 }, post: null, coins: [row("X", { narrative: N5 }), row("Y", { narrative: N5 })] })], themes: [{ theme: "ai", cards: 1 }], loose: [Z], dust: [] });
  const held = D.storiesView(read2, before, true);
  assert.deepEqual(held.loose.map((r) => [r.mint, !!r.left, !!r.moved]), [["X", true, true], ["Y", true, true], ["Z", false, false]]);
  assert.deepEqual(held.cards.map((c) => [c.key, !!c.left, !!c.moved, c.coins.map((r) => !!r.left)]), [["n:7", true, false, [false, false, false]], ["n:5", false, false, [false, false]]]);
  assert.deepEqual([D.MOVED_PILL, D.REGROUPED_PILL, D.LEFT_PILL], ["Moved to another card", "Regrouped", "No longer listed"]);
  assert.equal(D.cardTotals(held.loose).coinsN, 1, "a moved row is counted once, on its card");
  // the themes hold too: the shown one stays first with its last count, the new one goes last; the chosen theme still filters
  assert.deepEqual(held.themes, [{ theme: "politics", cards: 1 }, { theme: "ai", cards: 1 }]);
  const pills = D.themePills(held);
  assert.equal(D.activeTheme("politics", pills), "politics");
  assert.deepEqual(D.filterStories(held, "all", "politics").cards.map((c) => c.key), ["n:7"]);
  // the next read under hold: X dropped out altogether (plain left again), Y went back to the loose list (listed, in place)
  const read3 = body({ cards: [], themes: [], loose: [Z, row("Y", { narrative: N5 })], dust: [] });
  const held3 = D.storiesView(read3, held, true);
  assert.deepEqual(held3.loose.map((r) => [r.mint, !!r.left, !!r.moved]), [["X", true, false], ["Y", false, false], ["Z", false, false]]);
  // the story card dissolved: its coin Y is listed elsewhere, X is not, so the card is not called regrouped
  assert.deepEqual(held3.cards.map((c) => [c.key, !!c.left, !!c.moved]), [["n:7", true, false], ["n:5", true, false]]);
  assert.deepEqual(held3.themes.map((t) => t.theme), ["politics", "ai"], "no pill vanishes under the pointer");
  // a whole card whose coins were all regrouped onto other cards
  const two = D.storiesView(body({ cards: [{ kind: "post", key: POST.id, post: POST, family: null, narrative: null, buyers5m: 10, coinsN: 2, coins: [row("X"), row("Y")] }], themes: [], loose: [], dust: [] }), null);
  const regrouped = D.storiesView(read2, two, true);
  assert.deepEqual(regrouped.cards.map((c) => [c.key, !!c.left, !!c.moved]), [[POST.id, true, true], ["n:5", false, false]]);
  // idle: exactly what the server sent
  const idle = D.storiesView(read2, held, false);
  assert.deepEqual([idle.cards.map((c) => c.key), idle.loose.map((r) => [r.mint, r.left, r.moved]), idle.themes], [["n:5"], [["Z", undefined, undefined]], [{ theme: "ai", cards: 1 }]]);
  for (const w of [D.MOVED_PILL, D.MOVED_TITLE, D.REGROUPED_PILL, D.REGROUPED_TITLE, D.LOOSE_TITLE_NAR, D.looseTitle(3, 0, true)]) assert.doesNotMatch(w, /recommend|good|likely|early|signal|alpha/i);
});
