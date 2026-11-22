// The Discover page's story view (web/src/lib/discover.ts, GET /api/stories): the size pills, a card's numbers after
// the filter, the relative time, the story head words, the folded copies, the dust words, the
// held order, live prices over the view, and the read's URL. No DOM, no network (a fake fetch for the read).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stories, StoryCard, StoryCopy, StoryRow } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");
const { api } = await import("../src/lib/api.ts");

const NOW = 1_770_000_100;
const row = (mint: string, o: Partial<StoryRow> = {}): StoryRow => ({
  mint, name: "Dog", symbol: "DOG", image: "/api/img?u=a", createdAt: NOW - 3600, existing: true, mcapUsd: 41_000, priceUsd: 0.000041, sinceStart: null, buyers5m: 40,
  tf: { p0: 0.00003, chg: 38, volUsd: 900, buys: 52, sells: 9, buyers: 40, holding: 33 }, liqUsd: 5_200, parent: { mint: "ParentMint111", symbol: "PAR", image: null }, family: "live", ...o,
});
const copy = (mint: string, o: Partial<StoryCopy> = {}): StoryCopy => ({ mint, createdAt: NOW - 1100, firstSeenAt: null, liqUsd: 310, buyers5m: 9, ...o });
const POST = { id: "1895000000000000001", handle: "poster", text: "big news\n\nmore below", at: NOW - 6 * 60 - 10, url: "https://evil.example/x" };
const FAM = { mint: "ParentMint111", symbol: "PAR", image: "/api/img?u=p", startedAt: NOW - 12 * 60 };
const card = (o: Partial<StoryCard> = {}): StoryCard => ({ kind: "post", key: POST.id, post: POST, family: FAM, buyers5m: 69, coinsN: 4, coins: [row("A", { copies: [copy("A2")] }), row("B", { symbol: "CAT", buyers5m: 20 }), row("X", { symbol: "NEWS", buyers5m: 0, parent: null, family: null })], ...o });
const body = (o: Partial<Stories> = {}): Stories => ({
  asOf: NOW, tf: "5m", floor: 0, floor5m: 0, candidates: 10,
  cards: [card(), card({ kind: "family", key: "ParentMint222", post: null, family: { mint: "ParentMint222", symbol: "NVDAx", image: null, startedAt: NOW - 400 }, buyers5m: 50, coinsN: 3, coins: [row("E0", { mcapUsd: 9_000_000 }), row("E1", { mcapUsd: 200_000 }), row("E2", { mcapUsd: 2_000 })] })],
  loose: [row("L", { symbol: "LOOSE", buyers5m: 1, parent: null, family: null, mcapUsd: 150_000 })],
  dust: [{ ...row("T", { symbol: "TINY", mcapUsd: 3_000 }), reason: "tiny" }, { ...row("P", { symbol: "PAPER", mcapUsd: 8_000_000 }), reason: "paper" }],
  hidden: { dust: 44, cards: 2, loose: 95 }, ...o,
});

test("1. the size pills: small under $100K, mid $100K to $5M, large over $5M; an unknown market cap only under All", () => {
  assert.deepEqual(D.SIZES.map((s) => s.text), ["All", "Small", "Mid", "Large"]);
  assert.equal(D.sizeOf(0), "small");
  assert.equal(D.sizeOf(99_999.99), "small");
  assert.equal(D.sizeOf(100_000), "mid");
  assert.equal(D.sizeOf(5_000_000), "mid");
  assert.equal(D.sizeOf(5_000_000.01), "large");
  for (const none of [null, undefined, NaN, -1, Infinity]) assert.equal(D.sizeOf(none), null);
  assert.equal(D.inSize({ mcapUsd: null }, "all"), true);
  for (const k of ["small", "mid", "large"] as const) assert.equal(D.inSize({ mcapUsd: null }, k), false);
  assert.equal(D.inSize({ mcapUsd: 41_000 }, "small"), true);
  assert.equal(D.inSize({ mcapUsd: 41_000 }, "mid"), false);
});

test("2. the stored pill: a known key, else All; blocked storage reads as All and a write there does not throw", () => {
  for (const k of ["small", "mid", "large", "all"]) assert.equal(D.parseSize(k), k);
  for (const bad of [null, undefined, "", "huge", "Small", 3]) assert.equal(D.parseSize(bad), "all");
  const mem = new Map<string, string>();
  const ok = () => ({ getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } });
  D.writePref(ok, D.SIZE_KEY, "mid");
  assert.equal(D.readPref(ok, D.SIZE_KEY, D.parseSize), "mid");
  const blocked = () => { throw new Error("SecurityError"); };
  assert.equal(D.readPref(blocked, D.SIZE_KEY, D.parseSize), "all");
  assert.doesNotThrow(() => D.writePref(blocked, D.SIZE_KEY, "mid"));
});

test("3. a card's numbers: buyers and coins over its rows and their folded copies; a row that left is not counted", () => {
  assert.deepEqual(D.cardTotals(card().coins), { buyers5m: 40 + 9 + 20 + 0, coinsN: 4 }, "as the server counts them");
  assert.deepEqual(D.cardTotals([]), { buyers5m: 0, coinsN: 0 });
  assert.deepEqual(D.cardTotals([{ ...row("A"), left: true }, row("B", { buyers5m: 7 })]), { buyers5m: 7, coinsN: 1 });
  // anything that is not a count reads as 0, and a broken copies field as none
  assert.deepEqual(D.cardTotals([row("A", { buyers5m: NaN, copies: "x" as never }), row("B", { buyers5m: 2.9, copies: [null as never, copy("B2", { buyers5m: -4 })] })]), { buyers5m: 2, coinsN: 3 });
});

test("4. the filter: a card without a coin of the size is gone, the others count what they still show, order kept", () => {
  const v = D.storiesView(body(), null);
  const all = D.filterStories(v, "all");
  assert.deepEqual(all.cards.map((c) => [c.key, c.buyers5m, c.coinsN]), [[POST.id, 69, 4], ["ParentMint222", 120, 3]]);
  assert.equal(all.loose.length, 1);
  assert.equal(all.dustN, 44, "under All: every dust coin the server counted");
  assert.equal(all.total, 3);

  const large = D.filterStories(v, "large");
  assert.deepEqual(large.cards.map((c) => [c.key, c.buyers5m, c.coinsN, c.coins.map((r) => r.mint)]), [["ParentMint222", 40, 1, ["E0"]]], "the post card has no large coin");
  assert.equal(large.loose.length, 0);
  assert.deepEqual(large.dust.map((r) => r.mint), ["P"]);
  assert.equal(large.dustN, 1, "under a size: the dust rows received of that size");
  assert.equal(large.total, 1);

  const small = D.filterStories(v, "small");
  assert.deepEqual(small.cards.map((c) => [c.key, c.buyers5m, c.coinsN]), [[POST.id, 69, 4], ["ParentMint222", 40, 1]], "a folded copy goes with the row it is under; the order is the one received");
  const mid = D.filterStories(v, "mid");
  assert.deepEqual(mid.cards.map((c) => c.key), ["ParentMint222"]);
  assert.deepEqual(mid.loose.map((r) => r.mint), ["L"]);
  // the view itself is not changed
  assert.equal(v.cards[0].coins.length, 3);
  // nothing of a size: an empty view, no throw
  assert.deepEqual(D.filterStories(D.storiesView(body({ cards: [], loose: [], dust: [], hidden: { dust: 0 } }), null), "mid"), { cards: [], loose: [], dust: [], dustN: 0, total: 0 });
});

test("5. relative time: minutes, hours, days, then the date; unknown is empty", () => {
  assert.equal(D.relTime(NOW - 20, NOW), "just now");
  assert.equal(D.relTime(NOW + 30, NOW), "just now", "a clock a little ahead");
  assert.equal(D.relTime(NOW - 6 * 60 - 10, NOW), "6 min ago");
  assert.equal(D.relTime(NOW - 59 * 60, NOW), "59 min ago");
  assert.equal(D.relTime(NOW - 3600, NOW), "1 h ago");
  assert.equal(D.relTime(NOW - 47 * 3600, NOW), "47 h ago");
  assert.equal(D.relTime(NOW - 48 * 3600, NOW), "2 d ago");
  assert.equal(D.relTime(NOW - 29 * 86400, NOW), "29 d ago");
  assert.match(D.relTime(NOW - 40 * 86400, NOW), /^[A-Z][a-z]{2} \d{1,2}$/);
  assert.match(D.relTime(NOW - 700 * 86400, NOW), /^[A-Z][a-z]{2} \d{4}$/);
  for (const none of [null, undefined, NaN]) assert.equal(D.relTime(none, NOW), "");
});

test("7. the card head: who and when first; a merged card names the family after; the link is rebuilt from the id", () => {
  const h = D.storyHead(card(), NOW);
  assert.equal(h.line, "@poster · 6 min ago · $PAR family waking");
  assert.deepEqual([h.kind, h.who, h.when, h.tail], ["post", "@poster", "6 min ago", "$PAR family waking"]);
  assert.equal(h.text, "big news more below", "one line");
  assert.equal(h.href, "https://x.com/i/status/1895000000000000001", "never the body's url");
  // a post card across parents, without a family
  assert.equal(D.storyHead(card({ family: null }), NOW).line, "@poster · 6 min ago");
  // a media-only post, a pre-snowflake id without a time, a handle that has not the shape of one, a bad id
  const odd = D.storyHead(card({ family: null, post: { id: "javascript:1", handle: "<b>", text: "", at: null, url: "" } }), NOW);
  assert.deepEqual([odd.who, odd.when, odd.text, odd.href, odd.line], ["Linked post", "", "", null, "Linked post"]);
  // a family card
  const f = D.storyHead(card({ kind: "family", key: FAM.mint, post: null }), NOW);
  assert.deepEqual([f.kind, f.line, f.href, f.text], ["family", "$PAR family · waking up · 12 min", null, ""]);
  assert.equal(D.storyHead({ kind: "family", post: null, family: { mint: "AbcdEFGHijklMNOPqrst", symbol: null, image: null, startedAt: null } }, NOW).line, "Abcd…qrst family · waking up");
  assert.equal(D.storyHead({ kind: "family", post: null, family: null }, NOW).line, "Family · waking up");
});

test("8. the copies mark", () => {
  assert.equal(D.copiesMark(row("A")), null);
  assert.equal(D.copiesMark(row("A", { copies: [] })), null);
  assert.equal(D.copiesMark(row("A", { copies: [copy("A2")] })), "×2 copies");
  assert.equal(D.copiesMark(row("A", { copies: [copy("A2"), copy("A3")] })), "×3 copies");
});

test("9. a folded copy's line: when it launched or was first seen, its liquidity, its buyers", () => {
  assert.equal(D.copyFacts(copy("A2", { createdAt: NOW - 3 * 3600 }), NOW), "launched 3 h ago · $310.00 liquidity · 9 buyers in 5 min");
  assert.equal(D.copyFacts(copy("A2", { createdAt: null, firstSeenAt: NOW - 600, liqUsd: 5_200, buyers5m: 1 }), NOW), "first seen 10 min ago · $5.2K liquidity · 1 buyer in 5 min");
  assert.equal(D.copyFacts(copy("A2", { createdAt: null, firstSeenAt: null, liqUsd: null, buyers5m: 0 }), NOW), "0 buyers in 5 min");
  // with the page's timeframe: the copy's buyers over it when the server sends them, else its 5-minute buyers said as such
  assert.equal(D.copyFacts(copy("A2", { createdAt: null, liqUsd: null, buyers: 31 }), NOW, "1h"), "31 buyers in the last hour");
  assert.equal(D.copyFacts(copy("A2", { createdAt: null, liqUsd: null, buyers: 1 }), NOW, "1m"), "1 buyer in the last minute");
  assert.equal(D.copyFacts(copy("A2", { createdAt: null, liqUsd: null }), NOW, "1h"), "9 buyers in 5 min");
  assert.deepEqual(D.copiesOf(row("A", { copies: [null as never, copy("A2"), { mint: 5 } as never] })).map((c) => c.mint), ["A2"]);
  assert.deepEqual(D.copiesOf(null), []);
});

test("10. the words around the list: counts and what was measured, never a verdict", () => {
  assert.equal(D.dustLine(1234), "1,234 hidden as bot dust");
  assert.deepEqual(D.dustChip("paper")?.text, "Paper cap");
  assert.deepEqual(D.dustChip("tiny")?.text, "Tiny buys");
  for (const none of [undefined, null, "", "other"]) assert.equal(D.dustChip(none), null);
  const words = [D.STORIES_SUB, D.DUST_NOTE, D.COPIES_TITLE, D.DUST_CHIP.paper.title, D.DUST_CHIP.tiny.title, D.storyHead(card(), NOW).line, D.FOOT_NOTE].join(" ");
  assert.doesNotMatch(words, /recommend|good|best|safe\b|will rise|likely|bullish|gem|real\b|original|official|scam|fake|because|caused/i);
  assert.match(D.FOOT_NOTE, /it is not a forecast/);
});

test("11. the view after a read: broken and repeated entries dropped, a coin shown once, hidden counts kept", () => {
  const v = D.storiesView(body({
    cards: [card(), card(), null as never, { ...card({ key: "k2" }), coins: [row("A"), row("Z")] }, card({ key: "k3", coins: [] }), { ...card({ key: "k4" }), kind: "other" as never }, card({ key: 7 as never })],
    loose: [row("Z"), row("L"), null as never, { mint: 3 } as never], dust: "x" as never, hidden: undefined as never,
  }), null);
  assert.deepEqual(v.cards.map((c) => [c.key, c.coins.map((r) => r.mint)]), [[POST.id, ["A", "B", "X"]], ["k2", ["Z"]]]);
  assert.deepEqual(v.loose.map((r) => r.mint), ["L"]);
  assert.deepEqual([v.dust, v.hiddenDust, v.hiddenCards, v.hiddenLoose], [[], 0, 0, 0]);
  for (const none of [null, undefined, {}]) assert.deepEqual(D.storiesView(none, null), { cards: [], loose: [], dust: [], hiddenDust: 0, hiddenCards: 0, hiddenLoose: 0, tagging: false, themes: [] });
  const full = D.storiesView(body(), null);
  assert.deepEqual([full.hiddenDust, full.hiddenCards, full.hiddenLoose, full.dust.map((r) => r.reason)], [44, 2, 95, ["tiny", "paper"]]);
  assert.equal(D.cardKey(full.cards[0]), `post:${POST.id}`);
  assert.equal(D.cardKey(full.cards[1]), "family:ParentMint222");
});

test("12. held: cards and rows keep their places with fresh numbers, new ones go last, gone ones stay marked; idle, the server's order", () => {
  const shown = D.storiesView(body(), null);
  const fresh = body({
    cards: [
      card({ kind: "family", key: "ParentMint333", post: null, family: { mint: "ParentMint333", symbol: "NEW", image: null, startedAt: NOW }, coins: [row("N1")] }),
      card({ coins: [row("B", { symbol: "CAT", buyers5m: 99 }), row("C"), row("A", { buyers5m: 41 })] }),
    ],
    loose: [row("M"), row("L", { buyers5m: 5 })], dust: [],
  });
  const held = D.storiesView(fresh, shown, true);
  assert.deepEqual(held.cards.map((c) => [c.key, !!c.left]), [[POST.id, false], ["ParentMint222", true], ["ParentMint333", false]]);
  assert.deepEqual(held.cards[0].coins.map((r) => [r.mint, r.buyers5m, !!r.left]), [["A", 41, false], ["B", 99, false], ["X", 0, true], ["C", 40, false]]);
  assert.deepEqual(held.loose.map((r) => [r.mint, r.buyers5m]), [["L", 5], ["M", 40]]);
  assert.deepEqual(held.dust.map((r) => [r.mint, r.left]), [["T", true], ["P", true]]);
  // a card that left keeps its last numbers under the filter; a held card counts only the rows still listed
  const f = D.filterStories(held, "all");
  assert.deepEqual(f.cards.map((c) => [c.key, c.buyers5m, c.coinsN]), [[POST.id, 41 + 99 + 40, 3], ["ParentMint222", 50, 3], ["ParentMint333", 40, 1]]);
  // held again: what was marked stays marked once (the same object), nothing doubles
  const again = D.storiesView(fresh, held, true);
  assert.equal(again.cards[1], held.cards[1]);
  assert.deepEqual(again.cards[0].coins.map((r) => r.mint), ["A", "B", "X", "C"]);
  // idle: the server's order, nothing marked
  const idle = D.storiesView(fresh, held, false);
  assert.deepEqual(idle.cards.map((c) => c.key), ["ParentMint333", POST.id]);
  assert.deepEqual(idle.cards[1].coins.map((r) => [r.mint, !!r.left]), [["B", false], ["C", false], ["A", false]]);
  assert.deepEqual(idle.loose.map((r) => r.mint), ["M", "L"]);
  // a first read is never held
  assert.deepEqual(D.storiesView(fresh, null, true).cards.map((c) => c.key), ["ParentMint333", POST.id]);
});

test("13. live prices: a trade moves its coin wherever it is; a read keeps a newer live price; the mints followed", () => {
  const v = D.storiesView(body(), null);
  assert.deepEqual([...D.storyMints(v)].sort(), ["A", "B", "E0", "E1", "E2", "L", "X"]);
  assert.deepEqual([...D.storyMints(v, true)].sort(), ["A", "B", "E0", "E1", "E2", "L", "P", "T", "X"]);
  assert.equal(D.storyMints(null).size, 0);
  const none = D.liveStories(v, D.tradesByMint([{ mint: "nope", time: NOW, priceUsd: 1 }]));
  assert.equal(none, v, "no trade applied: the same object, nothing renders again");
  const at = Date.now();
  const live = D.liveStories(v, D.tradesByMint([{ mint: "A", time: NOW + 1, priceUsd: 0.000082, at }, { mint: "L", time: NOW + 1, priceUsd: 0.000082, at }, { mint: "T", time: NOW + 1, priceUsd: 0.000082, at }]));
  assert.notEqual(live, v);
  assert.equal(live.cards[0].coins[0].mcapUsd, 82_000);
  assert.equal(live.cards[0].coins[0].flash?.dir, "up");
  assert.equal(live.cards[1], v.cards[1], "an untouched card is the same object");
  assert.equal(live.loose[0].mcapUsd, 300_000);
  assert.equal(live.dust[0].mcapUsd, 6_000);
  // the next read was built before that trade: the live price is carried, to wherever the read put the coin
  const moved = D.storiesView(body({ cards: [card({ coins: [row("B")] })], loose: [row("A"), row("L", { mcapUsd: 150_000 })] }), live, false);
  const carried = D.carryLiveStories(moved, live, at + 1000);
  assert.equal(carried.loose[0].mint, "A");
  assert.equal(carried.loose[0].mcapUsd, 82_000);
  assert.equal(carried.cards[0].coins[0].mcapUsd, 41_000);
  // a trade that arrived long before the read is in it: the read's price stands
  assert.equal(D.carryLiveStories(moved, live, at + 60_000).loose[0].mcapUsd, 41_000);
  assert.equal(D.carryLiveStories(moved, null, at), moved);
  assert.equal(D.carryLiveStories(moved, v, at), moved, "nothing live on screen: the read as it is");
});

test("13b. the size pill under live trades and held reads: a row stays under the pill of its read, so no row or card comes or goes under the pointer", () => {
  const near = body({
    cards: [card({ coins: [row("A", { mcapUsd: 99_000, priceUsd: 0.000099 }), row("B", { symbol: "CAT", buyers5m: 20 })] }), card({ kind: "family", key: "ParentMint222", post: null, coins: [row("E", { mcapUsd: 99_500, priceUsd: 0.0000995 })] })],
    loose: [row("L", { mcapUsd: 99_000, priceUsd: 0.000099 }), row("M", { mcapUsd: 101_000, priceUsd: 0.000101 })], dust: [],
  });
  const v = D.storiesView(near, null);
  const shape = (s: ReturnType<typeof D.filterStories>) => [s.cards.map((c) => [c.key, c.buyers5m, c.coinsN, c.coins.map((r) => r.mint)]), s.loose.map((r) => r.mint)];
  const before = shape(D.filterStories(v, "small"));
  assert.deepEqual(before, [[[POST.id, 60, 2, ["A", "B"]], ["ParentMint222", 40, 1, ["E"]]], ["L"]]);
  // trades lift A, E and L over $100K and drop M under it
  const at = Date.now();
  const live = D.liveStories(v, D.tradesByMint([{ mint: "A", time: NOW + 1, priceUsd: 0.000101, at }, { mint: "E", time: NOW + 1, priceUsd: 0.000102, at }, { mint: "L", time: NOW + 1, priceUsd: 0.000101, at }, { mint: "M", time: NOW + 1, priceUsd: 0.000099, at }]));
  assert.equal(Math.round(live.cards[0].coins[0].mcapUsd as number), 101_000, "the number shown moves");
  assert.deepEqual(shape(D.filterStories(live, "small")), before, "the rows and cards do not");
  assert.deepEqual(D.filterStories(live, "mid").loose.map((r) => r.mint), ["M"]);
  // a held read with the new market caps: still the same rows, with the fresh numbers
  const over = body({ ...near, cards: [card({ coins: [row("A", { mcapUsd: 101_000, buyers5m: 41 }), row("B", { symbol: "CAT", buyers5m: 20 })] }), near.cards[1]], loose: [row("L", { mcapUsd: 101_000 }), row("M", { mcapUsd: 99_000 })] });
  const held = D.filterStories(D.storiesView(over, live, true), "small");
  assert.deepEqual(shape(held), [[[POST.id, 61, 2, ["A", "B"]], ["ParentMint222", 40, 1, ["E"]]], ["L"]]);
  assert.equal(held.cards[0].coins[0].mcapUsd, 101_000);
  // idle: each row goes under the pill of the read's market cap
  assert.deepEqual(shape(D.filterStories(D.storiesView(over, live, false), "small")), [[[POST.id, 20, 1, ["B"]], ["ParentMint222", 40, 1, ["E"]]], ["M"]]);
});

test("14. api.stories: tf in the URL only when given", async () => {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { urls.push(String(u)); return new Response(JSON.stringify(body()), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const d = await api.stories("1h");
    assert.equal(d.cards.length, 2);
    await api.stories();
  } finally { globalThis.fetch = real; }
  assert.match(urls[0], /\/stories\?tf=1h$/);
  assert.match(urls[1], /\/stories$/);
});
