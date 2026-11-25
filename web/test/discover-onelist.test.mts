// The Discover page's one list (web/src/lib/discover.ts oneList and friends): stories and single coins ranked together
// by buyers over the page's timeframe, a header only for two or more rows, the three rows shown and "+N more coins",
// paging by 20, the held order, the filters over the whole list, the header and single-coin lines. No DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Stories, StoryCard, StoryCopy, StoryRow } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");

const NOW = 1_770_000_100;
/// `b`: buyers over the read's timeframe (tf.buyers); `buyers5m` is set apart on purpose, so a test sees which is used.
const row = (mint: string, b: number, o: Partial<StoryRow> = {}): StoryRow => ({
  mint, name: mint, symbol: mint, image: null, createdAt: NOW - 7200, existing: true, mcapUsd: 41_000, priceUsd: 0.000041, sinceStart: null, buyers5m: 1000 - b,
  tf: { p0: 0.00003, chg: 3, volUsd: 900, buys: 52, sells: 9, buyers: b, holding: 1 }, liqUsd: 5_200, parent: { mint: "Par", symbol: "PAR", image: null }, family: null, ...o,
});
const copy = (mint: string, o: Partial<StoryCopy> = {}): StoryCopy => ({ mint, createdAt: NOW - 1100, firstSeenAt: null, liqUsd: 310, buyers5m: 900, buyers: 3, ...o });
const POST = { id: "1895000000000000001", handle: "poster", text: "big news\n\nmore below", at: NOW - 6 * 60 - 10, url: "https://evil.example/x" };
const N1 = { id: 7, title: "trump tariff panic", theme: "politics" };
const post = (key: string, coins: StoryRow[], o: Partial<StoryCard> = {}): StoryCard => ({ kind: "post", key, post: { ...POST, id: key }, family: null, buyers5m: 0, coinsN: coins.length, coins, ...o });
const fam = (key: string, coins: StoryRow[]): StoryCard => ({ kind: "family", key, post: null, family: { mint: key, symbol: "FAM", image: null, startedAt: NOW - 12 * 60 }, buyers5m: 0, coinsN: coins.length, coins });
const nar = (coins: StoryRow[], o: Partial<StoryCard> = {}): StoryCard => ({ kind: "narrative", key: "n:7", narrative: { ...N1, newCoins1h: 3 }, post: null, family: null, buyers5m: 0, coinsN: coins.length, newN: 0, olderN: 0, coins: coins.map((c) => ({ ...c, narrative: N1 })), ...o });
const body = (cards: StoryCard[], loose: StoryRow[], o: Partial<Stories> = {}): Stories => ({ asOf: NOW, tf: "1h", cards, loose, dust: [], hidden: { dust: 0, cards: 0, loose: 0 }, ...o });
const view = (b: Stories) => D.storiesView(b, null);
const list = (b: Stories, size: "all" | "small" | "mid" | "large" = "all", theme = "all") => D.oneList(D.filterStories(view(b), size, theme), NOW);
const keys = (r: { entries: { key: string }[] }) => r.entries.map((e) => e.key);

test("o1. a row's buyers are its timeframe's buyers, its copies' too; a story adds them up over the rows it shows", () => {
  assert.equal(D.rowBuyers(row("A", 40)), 40, "tf.buyers, never buyers5m");
  assert.equal(D.rowBuyers(row("A", 40, { copies: [copy("A2"), copy("A3", { buyers: 7 })] })), 50);
  assert.equal(D.rowBuyers(row("A", 40, { copies: [copy("A2", { buyers: undefined }), null as never] })), 40, "a copy without the figure counts 0");
  assert.equal(D.rowBuyers(row("A", 40, { tf: undefined })), 0);
  const rows = [row("A", 40, { copies: [copy("A2")] }), { ...row("B", 99), left: true }, row("C", 5, { isNew: true, copies: [copy("C2", { createdAt: NOW - 60 }), copy("C3", { createdAt: NOW - 4000 })] })];
  assert.deepEqual(D.tfTotals(rows, NOW), { buyers: 40 + 3 + 5 + 3 + 3, coinsN: 5, newN: 2, movedN: 0, goneN: 1 }, "a row that left is not counted (it is gone); a new row's copy launched within the hour is new");
  assert.deepEqual(D.tfTotals([], NOW), { buyers: 0, coinsN: 0, newN: 0, movedN: 0, goneN: 0 });
  assert.deepEqual(D.tfTotals([{ ...row("M", 4), left: true, moved: true }], NOW), { buyers: 0, coinsN: 0, newN: 0, movedN: 1, goneN: 0 });
});

test("o2. stories and single coins ranked together by buyers over the timeframe; then more coins; then the order received", () => {
  const b = body(
    [post("p1", [row("A", 10), row("B", 15)]), post("p2", [row("C", 30)]), fam("F", [row("D", 20), row("E", 5)]), post("p3", [row("G", 25)])],
    [row("L1", 40), row("L2", 25), row("L3", 1)],
  );
  const r = list(b);
  // 40, 30, then four at 25: the two stories of 2 coins in the order received, then the single coins (a card before a loose row)
  assert.deepEqual(keys(r), ["loose:L1", "post:p2", "post:p1", "family:F", "post:p3", "loose:L2", "loose:L3"]);
});

test("o2b. ties: more coins first, then cards before loose rows in the order received", () => {
  const b = body([post("p1", [row("A", 10), row("B", 15)]), post("p3", [row("G", 25)])], [row("L2", 25)]);
  assert.deepEqual(keys(list(b)), ["post:p1", "post:p3", "loose:L2"]);
  // the 5-minute buyers do not rank: they are reversed here and change nothing
  const r = list(body([], [row("X", 3), row("Y", 9)]));
  assert.deepEqual(keys(r), ["loose:Y", "loose:X"]);
  assert.ok(r.entries[0].rows[0].buyers5m < r.entries[1].rows[0].buyers5m);
});

test("o3. a header only for two or more rows: a one-coin post or family card is a single coin; a story's numbers", () => {
  const r = list(body([post("p1", [row("A", 10), row("B", 15, { copies: [copy("B2")] })]), fam("F", [row("D", 20)]), post("p2", [row("C", 3, { copies: [copy("C2")] })])], [row("L", 2)]));
  const by = new Map(r.entries.map((e) => [e.key, e] as const));
  assert.deepEqual([by.get("post:p1")?.head, by.get("family:F")?.head, by.get("post:p2")?.head, by.get("loose:L")?.head], [true, false, false, false], "a row with copies is still one row");
  assert.deepEqual([by.get("post:p1")?.buyers, by.get("post:p1")?.coinsN], [10 + 15 + 3, 3]);
  assert.equal(by.get("loose:L")?.card, null);
  assert.equal(by.get("family:F")?.card?.kind, "family");
  // a story's rows: most buyers over the timeframe first
  assert.deepEqual(by.get("post:p1")?.rows.map((x) => x.mint), ["B", "A"]);
});

test("o4. a narrative story: new coins first, then older, each by buyers; '· N new' counts the new ones shown", () => {
  const c = nar([row("O1", 50, { isNew: false }), row("N1", 5, { isNew: true }), row("O2", 60, { isNew: false }), row("N2", 9, { isNew: true })]);
  const r = list(body([c], [], { tagging: { on: true }, themes: [{ theme: "politics", cards: 1 }] }));
  const e = r.entries[0];
  assert.deepEqual(e.rows.map((x) => x.mint), ["N2", "N1", "O2", "O1"]);
  assert.deepEqual([e.head, e.coinsN, e.newN, e.buyers], [true, 4, 2, 124]);
  assert.deepEqual(D.storyRows([row("A", 1), row("B", 1), row("C", 2)]).map((x) => x.mint), ["C", "A", "B"], "ties keep the order received");
});

test("o5. the three rows shown and '+N more coins', which opens in place and closes", () => {
  const rows = ["a", "b", "c", "d", "e"];
  assert.deepEqual(D.storySplit(rows, false), { shown: ["a", "b", "c"], more: 2 });
  assert.deepEqual(D.storySplit(rows, true), { shown: rows, more: 2 });
  assert.deepEqual(D.storySplit(["a", "b", "c"], false), { shown: ["a", "b", "c"], more: 0 });
  assert.deepEqual(D.storySplit(["a", "b"], true), { shown: ["a", "b"], more: 0 });
  assert.equal(D.STORY_ROWS_SHOWN, 3);
  assert.equal(D.moreCoins(2, false), "+2 more coins");
  assert.equal(D.moreCoins(1, false), "+1 more coin");
  assert.equal(D.moreCoins(2, true), "Hide 2 coins");
});

test("o6. paging: the first 20 entries, then 20 more a click, until all are shown", () => {
  const es = Array.from({ length: 50 }, (_, i) => i);
  assert.equal(D.PAGE_ENTRIES, 20);
  let p = D.pageEntries(es, 20);
  assert.deepEqual([p.shown.length, p.rest, D.showMore(p.rest)], [20, 30, "Show 20 more"]);
  p = D.pageEntries(es, 40);
  assert.deepEqual([p.shown.length, p.rest, D.showMore(p.rest)], [40, 10, "Show 10 more"]);
  p = D.pageEntries(es, 60);
  assert.deepEqual([p.shown.length, p.rest], [50, 0]);
  for (const bad of [0, -3, NaN]) assert.equal(D.pageEntries(es, bad).shown.length, 20, "never under one page");
  assert.deepEqual(D.pageEntries([], 20), { shown: [], rest: 0 });
  // up to 20 cards and 30 loose rows: one list of at most 50 entries
  const b = body(Array.from({ length: 20 }, (_, i) => post(`p${i}`, [row(`c${i}`, 100 + i)])), Array.from({ length: 30 }, (_, i) => row(`l${i}`, i)));
  const r = list(b);
  assert.equal(r.entries.length, 50);
  assert.deepEqual(D.pageEntries(r.entries, 20).shown.map((e) => e.key).slice(0, 2), ["post:p19", "post:p18"]);
});

test("o7. held: entries and their rows keep the order on screen with fresh numbers, a new one goes last; idle, ranked again", () => {
  const first = list(body([post("p1", [row("A", 10), row("B", 15)])], [row("L1", 40), row("L2", 1)]));
  assert.deepEqual(keys(first), ["loose:L1", "post:p1", "loose:L2"]);
  const next = D.filterStories(view(body([post("p1", [row("A", 90), row("B", 15), row("N", 1)])], [row("L1", 2), row("L2", 50), row("L3", 70)])), "all");
  const held = D.oneList(next, NOW, first.order, true);
  assert.deepEqual(keys(held), ["loose:L1", "post:p1", "loose:L2", "loose:L3"]);
  assert.deepEqual(held.entries[1].rows.map((r) => [r.mint, r.tf?.buyers]), [["B", 15], ["A", 90], ["N", 1]], "rows in place with fresh numbers, the new row last");
  assert.equal(held.entries[1].buyers, 106, "the numbers are fresh");
  const again = D.oneList(next, NOW, held.order, true);
  assert.deepEqual(keys(again), keys(held));
  const idle = D.oneList(next, NOW, held.order, false);
  assert.deepEqual(keys(idle), ["post:p1", "loose:L3", "loose:L2", "loose:L1"]);
  assert.deepEqual(idle.entries[0].rows.map((r) => r.mint), ["A", "B", "N"]);
  assert.deepEqual(keys(D.oneList(next, NOW, null, true)), keys(idle), "nothing on screen yet: ranked");
  // a held read that dropped a one-coin card: it stays, dimmed, its coin said to have moved when listed elsewhere
  const shown = view(body([post("p9", [row("Z", 5)])], []));
  const hv = D.storiesView(body([], [row("Z", 5)]), shown, true);
  const e = D.oneList(D.filterStories(hv, "all"), NOW, D.oneList(D.filterStories(shown, "all"), NOW).order, true).entries;
  assert.deepEqual(e.map((x) => [x.key, x.left, x.moved]), [["post:p9", true, true], ["loose:Z", false, false]]);
});

test("o8. the filters over the whole list: a size drops a story with no coin left and its numbers count what it shows; a theme keeps its stories and tagged single coins", () => {
  const b = body(
    [post("p1", [row("A", 10, { mcapUsd: 9_000_000 }), row("B", 15), row("C", 20)]), post("p2", [row("D", 7, { mcapUsd: 9_000_000 })]), nar([row("N1", 4), row("N2", 6)])],
    [row("L1", 40, { narrative: N1 }), row("L2", 25), row("L3", 3, { mcapUsd: 9_000_000, narrative: { id: 9, title: "robots", theme: "ai" } })],
    { tagging: { on: true }, themes: [{ theme: "politics", cards: 1 }] },
  );
  const large = list(b, "large");
  assert.deepEqual(large.entries.map((e) => [e.key, e.head, e.buyers, e.coinsN]), [["post:p1", false, 10, 1], ["post:p2", false, 7, 1], ["loose:L3", false, 3, 1]], "p1 is down to one coin: a single coin, ranked by it");
  const small = list(b, "small");
  assert.deepEqual(small.entries.map((e) => [e.key, e.buyers]), [["loose:L1", 40], ["post:p1", 35], ["loose:L2", 25], ["narrative:n:7", 10]]);
  const pol = list(b, "all", "politics");
  assert.deepEqual(keys(pol), ["loose:L1", "narrative:n:7"], "untagged coins drop out under a theme");
  assert.deepEqual(keys(list(b, "all", "ai")), ["loose:L3"]);
  assert.deepEqual(keys(list(b, "small", "ai")), []);
});

test("o9. a story's header line: the narrative's title and theme (and its post), a post's who and words, a family as its card names it; '3 coins · 1 new'", () => {
  const b = body([nar([row("N1", 4, { isNew: true }), row("N2", 6)], { post: POST }), post(POST.id, [row("A", 1), row("B", 2)]), fam("F", [row("D", 3), row("E", 4)])], [], { tagging: { on: true }, themes: [{ theme: "politics", cards: 1 }] });
  const by = new Map(list(b).entries.map((e) => [e.key, e] as const));
  assert.deepEqual(D.storyLine(by.get("narrative:n:7")!, NOW), { kind: "narrative", title: "Trump Tariff Panic", theme: "Politics", post: "@poster · 6 min ago", text: "", href: "https://x.com/i/status/1895000000000000001", count: "2 coins · 1 new" });
  const p = D.storyLine(by.get(`post:${POST.id}`)!, NOW);
  assert.deepEqual(p, { kind: "post", title: "@poster · 6 min ago", theme: "", post: null, text: "big news more below", href: "https://x.com/i/status/1895000000000000001", count: "2 coins" });
  assert.ok(!p.href!.includes("evil"), "the link is rebuilt from the id, never the body's url");
  assert.equal(D.storyLine(by.get("family:F")!, NOW).title, "$FAM family · waking up · 12 min");
  // a post story whose coins share a narrative carries its theme pill while narratives are shown, and none when not
  const tagged = { card: { ...post("x", []), narrative: N1 } as never, coinsN: 2, newN: 0 };
  assert.equal(D.storyLine(tagged, NOW).theme, "Politics");
  assert.equal(D.storyLine(tagged, NOW, false).theme, "");
  assert.equal(D.countLine(1, 0), "1 coin");
  assert.equal(D.countLine(3, 1), "3 coins · 1 new");
  assert.equal(D.countLine(12, -1), "12 coins");
});

test("o9b. a story block's header: the total buyers ranked by, 'buyers · 2 coins · 1 new', and the author line under the title", () => {
  const b = body([nar([row("N1", 4, { isNew: true }), row("N2", 6)], { post: POST }), post(POST.id, [row("A", 1), row("B", 2)]), fam("F", [row("D", 3), row("E", 1_200)])], [], { tagging: { on: true }, themes: [{ theme: "politics", cards: 1 }] });
  const by = new Map(list(b).entries.map((e) => [e.key, e] as const));
  assert.deepEqual(D.storyHeader(by.get("narrative:n:7")!, NOW), { kind: "narrative", title: "Trump Tariff Panic", theme: "Politics", sub: "@poster · 6 min ago", text: "", href: "https://x.com/i/status/1895000000000000001", total: "10", words: "buyers · 2 coins · 1 new", unit: "buyers", count: "2 coins · 1 new" });
  assert.deepEqual(D.storyHeader(by.get(`post:${POST.id}`)!, NOW), { kind: "post", title: "Linked post", theme: "", sub: "@poster · 6 min ago", text: "big news more below", href: "https://x.com/i/status/1895000000000000001", total: "3", words: "buyers · 2 coins", unit: "buyers", count: "2 coins" });
  const f = D.storyHeader(by.get("family:F")!, NOW);
  assert.deepEqual([f.title, f.sub, f.total, f.words, f.href], ["$FAM family", "waking up · 12 min", "1,203", "buyers · 2 coins", null]);
  // the total is the sum the list ranks the story by; held dimmed rows add nothing and keep their words
  assert.equal(D.storyHeader({ card: null, coinsN: 0, newN: 0, buyers: 1, movedN: 2 }, NOW).words, "buyer · 2 moved");
  // a post with no usable handle: the title says "Linked post" once, the line under it is only the age
  const anon = post("1895000000000000002", [row("G", 1), row("H", 2)], { post: { id: "1895000000000000002", handle: null, text: "", at: NOW - 360, url: "" } });
  const ah = D.storyHeader(list(body([anon], [])).entries.find((e) => e.key === "post:1895000000000000002")!, NOW);
  assert.deepEqual([ah.title, ah.sub], ["Linked post", "6 min ago"]);
});

test("o10. a single coin's line: its post with when and its words (a link), its family, or none", () => {
  const p = D.coinStory(post(POST.id, [row("A", 1)]), NOW);
  assert.deepEqual(p, { text: "@poster · 6 min ago · big news more below", href: "https://x.com/i/status/1895000000000000001" });
  assert.deepEqual(D.coinStory(fam("F", [row("D", 3)]), NOW), { text: "$FAM family · waking up · 12 min", href: null });
  assert.equal(D.coinStory(null, NOW), null, "a loose coin");
  assert.equal(D.coinStory(nar([row("N1", 1)]), NOW), null, "a narrative story cut to one row names its story with the title tag");
  const bad = D.coinStory(post("javascript:alert(1)", [row("A", 1)], { post: { id: "javascript:alert(1)", handle: null, text: "", at: null, url: "" } }), NOW);
  assert.deepEqual(bad, { text: "Linked post", href: null });
});

test("o11. the words: what was measured, never a verdict", () => {
  const words = [D.moreCoins(3, false), D.moreCoins(3, true), D.showMore(20), D.countLine(3, 1), D.NEW_ROW_PILL, D.NEW_ROW_TITLE, D.MOVED_PILL, D.MOVED_TITLE, D.REGROUPED_TITLE, D.DUST_NOTE].join(" ");
  assert.doesNotMatch(words, /recommend|good|likely|early|signal|alpha|best|will rise|gem/i);
  assert.equal(D.MOVED_PILL, "Moved to another story");
});

test("o12. held: a one-coin card the read gave a second coin stays a plain row (no header grows above it) until the page is idle", () => {
  const shown = view(body([post("p1", [row("A", 10)])], [row("L", 2)]));
  const first = D.oneList(D.filterStories(shown, "all"), NOW);
  assert.equal(first.order.heads.get("post:p1"), false);
  const hv = D.storiesView(body([post("p1", [row("A", 10), row("B", 90)])], [row("L", 2)]), shown, true);
  const held = D.oneList(D.filterStories(hv, "all"), NOW, first.order, true);
  const e = held.entries.find((x) => x.key === "post:p1")!;
  assert.deepEqual([e.head, e.rows.map((r) => r.mint), e.buyers, e.coinsN], [false, ["A"], 10, 1], "it ranks and counts by the row it draws");
  assert.equal(held.order.heads.get("post:p1"), false);
  const again = D.oneList(D.filterStories(hv, "all"), NOW, held.order, true).entries.find((x) => x.key === "post:p1")!;
  assert.deepEqual([again.head, again.rows.length], [false, 1], "held over several reads");
  // the row it drew left the card: kept as the one row, dimmed in place
  const hv2 = D.storiesView(body([post("p1", [row("B", 90)])], [row("A", 10)]), hv, true);
  const gone = D.oneList(D.filterStories(hv2, "all"), NOW, held.order, true).entries.find((x) => x.key === "post:p1")!;
  assert.deepEqual([gone.head, gone.rows.map((r) => [r.mint, r.left, r.moved])], [false, [["A", true, true]]]);
  // idle: the story with its header and both rows
  const idle = D.oneList(D.filterStories(hv, "all"), NOW, held.order, false).entries.find((x) => x.key === "post:p1")!;
  assert.deepEqual([idle.head, idle.rows.map((r) => r.mint)], [true, ["B", "A"]]);
  // a story drawn with a header keeps it; a card new to the list is shaped by its rows
  const two = D.oneList(D.filterStories(view(body([post("p2", [row("C", 1), row("D", 2)])], [])), "all"), NOW);
  const hv3 = D.storiesView(body([post("p2", [row("C", 1), row("D", 2), row("E", 3)]), post("p3", [row("F", 1), row("G", 1)])], []), view(body([post("p2", [row("C", 1), row("D", 2)])], [])), true);
  const h3 = D.oneList(D.filterStories(hv3, "all"), NOW, two.order, true);
  assert.deepEqual(h3.entries.map((x) => [x.key, x.head, x.rows.length]), [["post:p2", true, 3], ["post:p3", true, 2]]);
});

test("o13. a held story's header counts the dimmed rows it still draws: moved or gone, never '0 coins'", () => {
  const shown = view(body([post("p1", [row("A", 10), row("B", 5)])], []));
  const first = D.oneList(D.filterStories(shown, "all"), NOW);
  // B joined another card
  const hv = D.storiesView(body([post("p1", [row("A", 10)]), post("p2", [row("B", 5)])], []), shown, true);
  const e = D.oneList(D.filterStories(hv, "all"), NOW, first.order, true).entries.find((x) => x.key === "post:p1")!;
  assert.deepEqual([e.head, e.rows.length, e.coinsN, e.movedN, e.goneN], [true, 2, 1, 1, 0]);
  assert.equal(D.storyLine(e, NOW).count, "1 coin · 1 moved");
  // both rows dropped out of the read altogether
  const hv2 = D.storiesView(body([post("p1", [row("Z", 1, { mcapUsd: 9_000_000 })])], []), shown, true);
  const e2 = D.oneList(D.filterStories(hv2, "small"), NOW, first.order, true).entries.find((x) => x.key === "post:p1")!;
  assert.deepEqual([e2.coinsN, e2.goneN, D.storyLine(e2, NOW).count], [0, 2, "2 gone"], "a size filter leaves only the dimmed rows");
  assert.equal(D.countLine(2, 1, 1, 1), "2 coins · 1 new · 1 moved · 1 gone");
  assert.equal(D.countLine(0, 0, 2), "2 moved");
  assert.equal(D.countLine(0, 0), "0 coins");
});

test("o14. a narrative row carries 'this hour' only when its own tag says 'existing': never 'new' twice, never 'existing' beside 'new'", () => {
  assert.equal(D.newRowPill({ isNew: true, existing: false }, true), false, "under 30 min: the row's 'new' tag says it");
  assert.equal(D.newRowPill({ isNew: true, existing: true }, true), true, "30-60 min");
  assert.equal(D.newRowPill({ isNew: false, existing: true }, true), false);
  assert.equal(D.newRowPill({ isNew: true, existing: true }, false), false, "only in a narrative story");
});

test("o15. an opened story cut to the rows always shown is closed again; one off the list stays open", () => {
  const e = (key: string, n: number) => ({ key, rows: Array.from({ length: n }) as never[] });
  const s = new Set(["a", "b", "c"]);
  const out = D.closeShrunk(s, [e("a", 3), e("b", 5)]);
  assert.deepEqual([...out].sort(), ["b", "c"]);
  assert.equal(D.closeShrunk(s, [e("a", 4), e("b", 7)]), s, "nothing changed: the same set");
});

test("o-distinct. a whole card shows the server's distinct buyers; a size-cut card, a held one or one without the figure adds up its rows", () => {
  const e = (b: Stories, size: "all" | "small" | "mid" | "large" = "all") => list(b, size).entries.find((x) => x.key === "post:p1")!;
  const coins = [row("A", 40, { mcapUsd: 9_000_000 }), row("B", 30, { mcapUsd: 8_000_000 }), row("S1", 3, { mcapUsd: 20_000 }), row("S2", 2, { mcapUsd: 30_000 })];
  const whole = e(body([post("p1", coins, { buyers: 60 })], []));
  assert.deepEqual([whole.buyers, whole.distinct], [60, true], "75 summed, 60 wallets: each counted once");
  const cut = e(body([post("p1", coins, { buyers: 60 })], []), "small");
  assert.deepEqual([cut.buyers, cut.distinct, cut.coinsN], [5, undefined, 2], "under a size pill the card draws part of its coins: their sum");
  const none = e(body([post("p1", coins)], []));
  assert.deepEqual([none.buyers, none.distinct], [75, undefined], "an older server: the sum, as before");
  const one = e(body([post("p1", [row("A", 40)], { buyers: 39 })], []));
  assert.deepEqual([one.buyers, one.distinct], [40, undefined], "a one-row entry counts its row");
});

test("o-share. a story's share of all tracked buyers: rounded, '<1%' for a sliver, none on a small or unknown site count", () => {
  assert.equal(D.shareOf(2518, 4400, "the last 5 min")?.text, "57%");
  assert.equal(D.shareOf(10, 1169, "the last 5 min")?.text, "<1%");
  assert.equal(D.shareOf(0, 1169, "the last 5 min")?.text, "0%");
  assert.equal(D.shareOf(60, 50, "x")?.text, "100%", "never above all of them");
  assert.equal(D.shareOf(10, D.SHARE_MIN_SITE - 1, "x"), null, "too few tracked buyers to mean anything");
  assert.equal(D.shareOf(10, null, "x"), null);
  assert.equal(D.shareOf(undefined, 500, "x"), null);
  assert.match(D.shareOf(10, 1169, "the last 5 min")!.title, /10 of the 1,169 wallets that bought a tracked coin over the last 5 min.*on-chain, from any app, each counted once/);
  assert.equal(view(body([], [], { siteBuyers: 1169 })).siteBuyers, 1169);
  assert.equal(view(body([], [])).siteBuyers, null, "an older server: no share anywhere");
  assert.equal(view(body([], [], { siteBuyers: -3 })).siteBuyers, null);
});

test("o-left. a card the server dropped, held on screen, keeps no distinct count and so no share", () => {
  const first = view(body([post("p1", [row("A", 40), row("B", 30)], { buyers: 60 })], [], { siteBuyers: 4000 }));
  const held = D.storiesView(body([], [row("Z", 2)], { siteBuyers: 600 }), first, true);
  const e = D.oneList(D.filterStories(held, "all", "all"), NOW).entries.find((x) => x.key === "post:p1")!;
  assert.deepEqual([e.left, e.distinct, e.buyers], [true, undefined, 70], "its rows' sum, not 60 over the new site count");
});

test("o-gate. a server with the story gate on: passing stories come first by their score, the rest rank by buyers as before", () => {
  const g = (score: number, pass = true) => ({ pass, buyers30m: 20, lift: 4, inflowSol: 12, coins5: 2, word: null, score });
  const b = body(
    [post("p1", [row("A", 90), row("B", 80)]), post("p2", [row("C", 5), row("D", 5)], { gate: g(3) }), post("p3", [row("E", 4), row("F", 4)], { gate: g(9) }), post("p4", [row("G", 70), row("H", 1)], { gate: g(50, false) })],
    [row("L1", 100)],
  );
  assert.deepEqual(keys(list(b)), ["post:p3", "post:p2", "post:p1", "loose:L1", "post:p4"], "p3 and p2 pass (score 9, then 3); then 170, 100 and 71 buyers; p4's failing gate counts for nothing");
});
