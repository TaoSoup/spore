// The Discover subject line (web/src/lib/discover.ts subjectLine and its helpers): "Subject: what happened" for a single
// coin's card and a story's header. The server's model-written line with its chips (where the sentence came from, the
// quoted post's age, a post that does not name the coin), the lines the server writes itself (a quote, a counted
// sentence, also over a post without words), no line at all for a single coin with nothing to say, the fallback while a line is
// pending, a story without a post, sentence case, the age chips, the tones, and the quote cut at 80 characters; a
// counted sentence against the coins shown (a size pill), one row as a single coin, and the markup itself
// (components/DiscoverLine.tsx rendered to a string: the chips, the opened body's two posts, the plain row's link).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoryCard, StoryRow } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");

const NOW = 1_770_000_000, DAY = 86_400;
const ID = "1895000000000000001", QID = "1795000000000000002";
const post = (o: Partial<NonNullable<StoryCard["post"]>> = {}) => ({ id: ID, handle: "TheKindDev", text: "X now lets users add employment history and job title to their profiles https://t.co/abc", at: NOW - 3600, url: "x", ...o });
const row = (o: Partial<StoryRow> = {}): StoryRow => ({ mint: "M1", name: "Job Title", symbol: "JOB", ...o } as StoryRow);
const card = (o: Partial<StoryCard> = {}): StoryCard => ({ kind: "post", key: ID, post: null, family: null, buyers5m: 0, coinsN: 1, coins: [row()], ...o });
const line = (o: Partial<NonNullable<StoryCard["line"]>> = {}) => ({ subject: "X profiles", happened: "Users can now add employment history and job title", kind: "event" as const, by: "model" as const, quote: false, chips: ["ai" as const], ...o });
const own = (o: Partial<NonNullable<StoryCard["line"]>> = {}) => ({ subject: "PVE", happened: "2 coins; 1 launched under $PUMP", kind: "thin" as const, by: "server" as const, quote: false, chips: [], ...o });
const quoted = (o: Partial<NonNullable<StoryCard["quoted"]>> = {}) => ({ id: QID, handle: "gwrldmedia", text: "IShowSpeed wants to team up with Elon Musk. pic.twitter.com/LOz", at: NOW - 400 * DAY, url: "x", ...o });
const texts = (L: { chips: { text: string }[] }) => L.chips.map((c) => c.text);

test("1. a model's line is shown as written, marked AI, with who, when, the post's link and the poster's own words", () => {
  const L = D.subjectLine(card({ post: post(), line: line() }), NOW)!;
  assert.deepEqual([L.subject, L.happened, L.auto, L.tone, L.quote], ["X profiles", "Users can now add employment history and job title", true, "normal", false]);
  assert.deepEqual(L.badge, { text: "AI", title: "Written by a model from the post. It can be wrong." });
  assert.deepEqual([L.chips, L.quoted], [[], null], "the AI mark is the badge; no other chip, no quoted post");
  assert.deepEqual([L.who, L.when, L.old], ["@TheKindDev", "1 h ago", null]);
  assert.ok(L.href?.startsWith("https://x.com/") && L.href.includes(ID), "the link is rebuilt from the id, not taken from the body");
  assert.ok(L.words?.startsWith("X now lets users add employment history"));
  assert.equal(D.LINE_NOTE, "Summary written by a model. It can be wrong.");
  // an older server's line (no `by`, no chips) is a model's line
  const O = D.subjectLine(card({ post: post(), line: { subject: "X profiles", happened: "Users add jobs", kind: "event" } }), NOW)!;
  assert.deepEqual([O.auto, O.badge?.text, O.chips], [true, "AI", []]);
  // the same on a narrative story's header: the line's subject stands in for the title
  const N = D.subjectLine(card({ kind: "narrative", key: "n:7", coinsN: 3, narrative: { id: 7, title: "x profile jobs", theme: "tech & products" }, post: post(), line: line() }), NOW)!;
  assert.deepEqual([N.subject, N.auto, N.badge?.text], ["X profiles", true, "AI"]);
  // a model's line is only ever about a post: without one it is not used
  assert.equal(D.subjectLine(card({ kind: "family", key: "F", coinsN: 2, family: { mint: "F", symbol: "FAM", image: null, startedAt: NOW - 600 }, line: line() }), NOW)!.subject, "FAM");
});

test("2. the chips say where a model's line came from; they are facts about our data and stay out of the sentence", () => {
  // the sentence is the quoted post's
  const via = D.subjectLine(card({ post: post({ text: "Sending 10%https://t.co/abc" }), quoted: quoted({ handle: "dv3333333", at: NOW - 3600 }), line: line({ subject: "Rasmr and big trader", happened: "Quoted post says a big futures trader outdid Rasmr", kind: "claim", chips: ["ai", "via_quoted"] }) }), NOW)!;
  assert.deepEqual([via.subject, via.happened, via.auto, via.badge?.text], ["Rasmr and big trader", "Quoted post says a big futures trader outdid Rasmr", true, "AI"]);
  assert.deepEqual(via.chips, [{ text: "via quoted post @dv3333333", title: D.VIA_QUOTED_TITLE }], "a fresh quoted post has no age chip");
  assert.deepEqual(via.quoted, { who: "@dv3333333", when: "1 h ago", old: null, href: via.quoted!.href, words: "IShowSpeed wants to team up with Elon Musk. pic.twitter.com/LOz" });
  assert.ok(via.quoted!.href?.startsWith("https://x.com/") && via.quoted!.href.includes(QID), "the quoted post's link is rebuilt from its id");
  assert.equal(via.words, "Sending 10%https://t.co/abc", "the poster's own words stay one tap away");
  // today's poster says it; the full names come from a quoted post from another year: said by a chip, not in the sentence
  const names = D.subjectLine(card({ post: post({ handle: "ddddddd8a" }), quoted: quoted(), line: line({ subject: "IShowSpeed", happened: "Poster says he wanted to team up with Elon Musk for a stream from space", kind: "claim", chips: ["ai", "names_quoted"] }) }), NOW)!;
  const year = new Date((NOW - 400 * DAY) * 1000).getUTCFullYear();
  assert.deepEqual(texts(names), ["names from quoted post", `quoted post from ${year}`]);
  assert.equal(names.happened.includes(String(year)), false);
  assert.deepEqual([names.quoted?.who, names.quoted?.old, names.quoted?.when], ["@gwrldmedia", "13 mo old", ""]);
  // the quoted post's age: nothing within a week, days, months, then its year
  assert.equal(D.quotedChip(NOW - 7 * DAY, NOW), null);
  assert.equal(D.quotedChip(NOW - 3 * DAY, NOW), null);
  assert.equal(D.quotedChip(NOW - 18 * DAY, NOW), "quoted post 18 d old");
  assert.equal(D.quotedChip(NOW - 153 * DAY, NOW), "quoted post 5 mo old");
  assert.equal(D.quotedChip(NOW - 365 * DAY, NOW), "quoted post 11 mo old");
  assert.equal(D.quotedChip(NOW - 366 * DAY, NOW), `quoted post from ${new Date((NOW - 366 * DAY) * 1000).getUTCFullYear()}`);
  assert.equal(D.quotedChip(null, NOW), null);
  // a quoted post the line did not draw on has no age chip, but is still shown when the line is opened
  const plain = D.subjectLine(card({ post: post(), quoted: quoted(), line: line() }), NOW)!;
  assert.deepEqual([plain.chips, plain.quoted?.who], [[], "@gwrldmedia"]);
  // a name from the post two hops away
  const chain = D.subjectLine(card({ post: post(), quoted: quoted({ handle: "ddddddd8a", at: NOW - 600 }), chain: { id: "9", handle: "gwrldmedia", at: NOW - 400 * DAY }, line: line({ kind: "claim", happened: "Quoted post says he wanted to team up with Elon Musk", chips: ["ai", "via_quoted", "names_chain"] }) }), NOW)!;
  assert.deepEqual(texts(chain), ["via quoted post @ddddddd8a", `names from @gwrldmedia (2 hops, ${year})`]);
  assert.deepEqual(texts(D.subjectLine(card({ post: post(), line: line({ chips: ["ai", "names_chain"] }) }), NOW)!), ["names from an earlier post"]);
  // a post that does not name its coin: a chip, the sentence says nothing of the coin
  const mm = D.subjectLine(card({ post: post(), line: line({ subject: "Cented", happened: "Poster asks if Cented sent to the wrong person", kind: "mismatch", chips: ["ai", "mismatch"] }) }), NOW)!;
  assert.deepEqual([texts(mm), mm.tone, mm.happened.toLowerCase().includes("coin")], [["post does not name this coin"], "normal", false]);
  // a handle that is no handle is not drawn as one; an unknown chip code is dropped
  assert.deepEqual(texts(D.subjectLine(card({ post: post(), quoted: quoted({ handle: "<b>x</b>", at: NOW }), line: line({ chips: ["ai", "via_quoted", "shiny" as never] }) }), NOW)!), ["via quoted post"]);
});

test("3. a line the server wrote itself: light, no AI badge; the poster's words in quote marks; \"AI group\" and \"no post\" as chips", () => {
  const L = D.subjectLine(card({ coinsN: 2, post: post({ handle: "a1lon9", text: "https://t.co/oAQHWDkJWU" }), line: own({ n: 2 }) }), NOW, true, { coinsN: 2 })!;
  assert.deepEqual([L.subject, L.happened, L.auto, L.badge, L.quote, L.tone, L.chips], ["PVE", "2 coins; 1 launched under $PUMP", false, null, false, "light", []]);
  assert.deepEqual([L.who, !!L.href, L.words], ["@a1lon9", true, null], "Open post stays one tap away; a bare link is no words of the poster");
  // a quote
  const Q = D.subjectLine(card({ post: post({ text: "the bears are done for this week" }), line: own({ subject: "The White Bull", happened: "the bears are done for this week", quote: true }) }), NOW)!;
  assert.deepEqual([Q.subject, Q.happened, Q.quote, Q.auto, Q.badge, Q.tone], ["The White Bull", "the bears are done for this week", true, false, null, "normal"]);
  // a counted sentence over a story with no post: the model's grouping is said by a chip
  const C = D.subjectLine(card({ kind: "narrative", key: "n:1144", coinsN: 4, narrative: { id: 1144, title: "ansem hacked black bull rug", theme: "crypto native" }, line: own({ subject: "Ansem", happened: "3 of 4 coins are named Ansem; 2 launched under $Slingoor", chips: ["ai_group", "no_post"] }) }), NOW, true, { coinsN: 4 })!;
  assert.deepEqual([C.subject, C.happened, C.auto, C.badge, C.tone], ["Ansem", "3 of 4 coins are named Ansem; 2 launched under $Slingoor", false, null, "light"]);
  assert.deepEqual(C.chips, [{ text: "AI group", title: "A model grouped these coins. It can be wrong" }, { text: "no post", title: D.NO_POST_TITLE }]);
  assert.deepEqual([C.who, C.when, C.old, C.href, C.words, C.quoted], [null, "", null, null, null, null], "nothing to open");
  assert.equal(/no starting post|grouped by a model|hacked|rug/i.test(`${C.subject} ${C.happened}`), false);
  // a server line's subject is put in sentence case (a model's lower-case title)
  assert.equal(D.subjectLine(card({ kind: "narrative", key: "n:8", coinsN: 3, narrative: { id: 8, title: "ai bubble popping", theme: "ai" }, line: own({ subject: "ai bubble popping", happened: "3 coins", chips: ["ai_group", "no_post"] }) }), NOW)!.subject, "AI bubble popping");
  // `quote` is only ever a server line's
  assert.equal(D.subjectLine(card({ post: post(), line: line({ quote: true }) }), NOW)!.quote, false);
});

test("4. a single coin with nothing to say has no header line: a plain row, with its post one link away", () => {
  // the server decided: `line: null`
  assert.equal(D.subjectLine(card({ post: post({ text: "SENDING 5%https://t.co/9IXTi6yoBB" }), line: null }), NOW), null);
  assert.ok(D.cardPostHref(card({ post: post() }))?.includes(ID), "the row keeps a link to the post");
  assert.equal(D.cardPostHref(card()), null);
  assert.equal(D.lineDecidedNone(card({ line: null })), true);
  assert.equal(D.lineDecidedNone(card()), false, "no field: not decided");
  // no post at all: a family's single coin, a narrative's single coin, a loose coin with a story tag
  assert.equal(D.subjectLine(card({ kind: "family", key: "F", family: { mint: "F", symbol: "Slingoor", image: null, startedAt: NOW - 720 } }), NOW), null);
  assert.equal(D.subjectLine(card({ kind: "narrative", key: "n:8", narrative: { id: 8, title: "turkey pardon", theme: "politics" } }), NOW), null);
  assert.equal(D.subjectLine(null, NOW, true, { row: row({ narrative: { id: 9, title: "ai bubble popping", theme: "ai" } }) }), null);
  assert.equal(D.subjectLine(null, NOW, true, { row: row() }), null);
  assert.equal(D.subjectLine(null, NOW), null);
  // a single coin's row of a larger card is still a single coin
  assert.equal(D.subjectLine(card({ kind: "family", key: "F", coinsN: 3, family: { mint: "F", symbol: "FAM", image: null, startedAt: null } }), NOW, true, { row: row(), coinsN: 1 }), null);
  // a story of several coins whose line the server could not write still gets a header: the poster's words
  const S = D.subjectLine(card({ post: post(), coinsN: 3, line: null }), NOW, true, { coinsN: 3 })!;
  assert.deepEqual([S.subject, S.quote, S.auto], ["Linked post", true, false]);
});

test("5. tones: a personal post's subject is drawn quieter; a server line is light unless it is a quote", () => {
  const tone = (kind: NonNullable<StoryCard["line"]>["kind"]) => D.subjectLine(card({ post: post(), line: line({ kind }) }), NOW)!.tone;
  assert.deepEqual((["event", "claim", "pitch", "mismatch", "personal"] as const).map(tone), ["normal", "normal", "normal", "normal", "personal"]);
  assert.deepEqual(D.LINE_KINDS, ["event", "claim", "pitch", "personal", "mismatch", "thin"]);
});

test("6. a damaged or unknown line is not shown: the card falls back to the poster's words", () => {
  for (const bad of [{ subject: "", happened: "x", kind: "event" }, { subject: "A", happened: " ", kind: "event" }, { subject: "A", happened: "B", kind: "advice" }, { subject: "A", happened: "B", kind: "none" }, { subject: 1, happened: "B", kind: "event" }, "text"]) {
    assert.equal(D.lineOf({ line: bad }), null);
    const L = D.subjectLine(card({ post: post(), line: bad as never }), NOW)!;
    assert.deepEqual([L.auto, L.badge, L.quote], [false, null, true]);
  }
  assert.equal(D.lineOf({ line: null }), null);
  assert.deepEqual(D.lineOf({ line: { subject: " X​ profiles\n", happened: "Users add jobs", kind: "event", extra: 1 } }), { subject: "X profiles", happened: "Users add jobs", kind: "event", by: "model", quote: false, chips: [], n: null }, "made plain; nothing else is carried");
  assert.deepEqual(D.lineOf({ line: { subject: "A", happened: "B", kind: "thin", by: "server", quote: true, chips: ["no_post", "x", 5, "ai_group"] } }), { subject: "A", happened: "B", kind: "thin", by: "server", quote: true, chips: ["no_post", "ai_group"], n: null });
  assert.equal(D.lineOf({ line: { subject: "A", happened: "B", kind: "event", by: "admin", quote: true } })!.by, "model", "an unknown writer is a model: marked AI, never quoted");
});

test("7. a story with no post and no server line: the title or the parent's ticker, how many coins, and chips instead of sentences about our data", () => {
  const L = D.subjectLine(card({ kind: "narrative", key: "n:8", coinsN: 3, narrative: { id: 8, title: "turkey pardon", theme: "politics" } }), NOW)!;
  assert.deepEqual([L.subject, L.happened, L.auto, L.badge, L.tone, L.quote, texts(L)], ["Turkey pardon", "3 coins", false, null, "light", false, ["AI group", "no post"]]);
  assert.deepEqual([L.who, L.when, L.old, L.href, L.words], [null, "", null, null, null], "nothing to open");
  // the count is the entry's own when given (a size filter)
  assert.equal(D.subjectLine(card({ kind: "narrative", key: "n:8", coinsN: 5, narrative: { id: 8, title: "turkey pardon", theme: "politics" } }), NOW, true, { coinsN: 2 })!.happened, "2 coins");
  // a family card whose coins share a narrative: the title leads, when narratives are shown
  const fam = card({ kind: "family", key: "F", coinsN: 2, family: { mint: "F", symbol: "FAM", image: null, startedAt: NOW - 600 }, narrative: { id: 4, title: "moo deng the hippo", theme: "animals" } });
  assert.deepEqual([D.subjectLine(fam, NOW, true)!.subject, D.subjectLine(fam, NOW, true)!.happened], ["Moo deng the hippo", "2 coins launched under $FAM"]);
  const bare = D.subjectLine(fam, NOW, false)!;
  assert.deepEqual([bare.subject, bare.happened, bare.badge, texts(bare)], ["FAM", "2 coins launched under $FAM", null, ["no post"]]);
  const noSym = D.subjectLine(card({ kind: "family", key: "F", coinsN: 2, family: { mint: "FaMiLyMiNt1111111111111111111111111111111111", symbol: null, image: null, startedAt: null } }), NOW)!;
  assert.ok(noSym.subject.length > 0 && noSym.happened.startsWith("2 coins launched under "));
  // a subject block's title is the server's own table's: no "AI group"
  const subj = D.subjectLine(card({ kind: "narrative", key: "t:jensen", coinsN: 4, narrative: { id: 3, title: "Jensen Huang", theme: "tech & products" }, subject: { key: "t:jensen", title: "Jensen Huang", angles: [] } }), NOW)!;
  assert.deepEqual([subj.subject, texts(subj)], ["Jensen Huang", ["no post"]]);
  // none of the old sentences about our own data is left
  for (const c of [L, bare, subj]) assert.equal(/no starting post|grouped by a model|named by a model/i.test(c.happened), false);
});

test("8. a post whose line is not decided yet: the title or the coin's name as the subject, the poster's first 80 characters in quote marks, no AI badge (a model's title carries \"AI group\")", () => {
  const L = D.subjectLine(card({ post: post() }), NOW)!;
  assert.deepEqual([L.subject, L.auto, L.badge, L.quote, L.tone, L.chips], ["Job Title", false, null, true, "normal", []]);
  assert.equal(L.happened, "X now lets users add employment history and job title to their profiles", "links are cut (cleanSay)");
  assert.deepEqual([L.who, L.when], ["@TheKindDev", "1 h ago"]);
  // with a narrative, its title in sentence case; a name falls back to the ticker, then to "Linked post"
  assert.equal(D.subjectLine(card({ post: post(), narrative: { id: 7, title: "x profile jobs", theme: "tech & products" } }), NOW)!.subject, "X profile jobs");
  assert.equal(D.subjectLine(card({ post: post(), narrative: { id: 7, title: "x profile jobs", theme: "tech & products" } }), NOW, false)!.subject, "Job Title", "narratives not shown: the coin's name");
  assert.equal(D.subjectLine(card({ post: post(), coins: [row({ name: null, symbol: "JOB" })] }), NOW)!.subject, "$JOB");
  assert.equal(D.subjectLine(card({ post: post(), coins: [] }), NOW)!.subject, "Linked post");
  // a subject that is a model's title says so, though the sentence is the poster's: "AI group", and no summary note
  const T = D.subjectLine(card({ post: post(), narrative: { id: 7, title: "x profile jobs", theme: "tech & products" } }), NOW)!;
  assert.deepEqual([T.subject, T.badge, T.chips, T.auto, T.quote], ["X profile jobs", null, [{ text: "AI group", title: D.AI_GROUP_TITLE }], false, true]);
  assert.deepEqual(D.subjectLine(card({ post: post(), narrative: { id: 7, title: "x profile jobs", theme: "tech & products" } }), NOW, false)!.chips, [], "narratives not shown: the coin's name, no chip");
  const tbl = D.subjectLine(card({ kind: "narrative", key: "t:jensen", coinsN: 4, post: post(), narrative: { id: 3, title: "Jensen Huang", theme: "tech & products" }, subject: { key: "t:jensen", title: "Jensen Huang", angles: [] } }), NOW)!;
  assert.deepEqual([tbl.subject, tbl.chips], ["Jensen Huang", []], "a subject block's title is the server's own table's");
  // a story's header over several coins, no title: no one coin stands for the story (the server's first coin is not
  // the first row drawn and changes between reads); a single coin's card names its own row
  const three = [row({ mint: "M2", name: "Wizard Kitty", symbol: "KITTY" }), row({ mint: "M1", name: "Wizard Cat", symbol: "WIZ" }), row({ mint: "M3", name: "WIZCAT", symbol: "WIZCAT" })];
  assert.equal(D.subjectLine(card({ post: post(), coinsN: 3, coins: three }), NOW, true, { coinsN: 3 })!.subject, "Linked post");
  assert.equal(D.subjectLine(card({ post: post(), coinsN: 3, coins: [...three].reverse() }), NOW, true, { coinsN: 3 })!.subject, "Linked post", "the same whatever the order");
  assert.equal(D.subjectLine(card({ post: post(), coinsN: 3, coins: three }), NOW, true, { row: three[1], coinsN: 1 })!.subject, "Wizard Cat");
  assert.equal(D.subjectLine(card({ post: post(), coinsN: 3, coins: three, line: line() }), NOW, true, { coinsN: 3 })!.subject, "X profiles", "a written line names the subject itself");
  // the cut: 80 characters at most, the last an ellipsis; a shorter text is whole
  const long = "word ".repeat(40).trim();
  const cut = D.subjectLine(card({ post: post({ text: long }) }), NOW)!.happened;
  assert.equal([...cut].length <= 80 && cut.endsWith("…") && long.startsWith(cut.slice(0, -1)), true, cut);
  assert.equal(D.quoteCut("a".repeat(80)), "a".repeat(80));
  assert.equal(D.quoteCut("a".repeat(81)), `${"a".repeat(79)}…`);
  assert.equal(D.quoteCut("  https://x.com/a  "), null);
  assert.equal(D.LINE_QUOTE_MAX, 80);
  // a media-only post: said plainly, not quoted
  const bare = D.subjectLine(card({ post: post({ text: "https://t.co/onlyalink" }) }), NOW)!;
  assert.deepEqual([bare.happened, bare.quote, bare.tone], ["Linked post has no text", false, "light"]);
});

test("9. a counted sentence never disagrees with the coins shown beside it: under a size pill the page counts what it shows; one row is a plain row", () => {
  const SENT = "3 of 4 coins are named Ansem; 2 launched under $Slingoor";
  const ansem = card({ kind: "narrative", key: "n:1144", coinsN: 4, narrative: { id: 1144, title: "ansem hacked black bull rug", theme: "crypto native" }, line: own({ subject: "Ansem", happened: SENT, chips: ["ai_group", "no_post"], n: 4 }) });
  assert.equal(D.lineOf(ansem)!.n, 4);
  // drawn whole: the server's sentence
  assert.equal(D.subjectLine(ansem, NOW, true, { coinsN: 4 })!.happened, SENT);
  // cut to two coins: the same subject, the page's own count, the same chips; never "3 of 4" beside "2 coins"
  const two = D.subjectLine(ansem, NOW, true, { coinsN: 2 })!;
  assert.deepEqual([two.subject, two.happened, two.tone, two.quote, two.auto, texts(two)], ["Ansem", "2 coins", "light", false, false, ["AI group", "no post"]]);
  // cut to one row: a single coin, a plain row
  assert.equal(D.subjectLine(ansem, NOW, true, { row: row(), coinsN: 1 }), null);
  // a family's counted sentence, cut: still said of the family
  const fam = card({ kind: "family", key: "F", coinsN: 3, family: { mint: "F", symbol: "PAR", image: null, startedAt: NOW - 600 }, line: own({ subject: "$PAR", happened: "3 coins launched under $PAR", chips: ["no_post"], n: 3 }) });
  assert.equal(D.subjectLine(fam, NOW, true, { coinsN: 3 })!.happened, "3 coins launched under $PAR");
  assert.deepEqual([D.subjectLine(fam, NOW, true, { coinsN: 2 })!.subject, D.subjectLine(fam, NOW, true, { coinsN: 2 })!.happened], ["$PAR", "2 coins launched under $PAR"]);
  // with a post the server chose not to quote (a fee line): the count, never the poster's words in quote marks
  const fee = card({ coinsN: 3, post: post({ text: "Sending 10%https://t.co/Ig0v1Mdtkc" }), line: own({ subject: "ZeroSumEnjoyer", happened: "All 3 coins are named ZeroSumEnjoyer", chips: ["ai_group"], n: 3 }) });
  const cut = D.subjectLine(fee, NOW, true, { coinsN: 2 })!;
  assert.deepEqual([cut.subject, cut.happened, cut.quote, cut.tone, !!cut.href], ["ZeroSumEnjoyer", "2 coins", false, "light", true], "the post stays one tap away");
  assert.equal(D.subjectLine(fee, NOW, true, { row: row(), coinsN: 1 }), null);
  assert.ok(D.cardPostHref(fee)?.includes(ID), "and its plain row keeps the link to the post");
  // a post that is only a link gets the counted sentence: its own count when the card shows 2, "3 coins" over 3, one row is a plain row
  const pve = card({ coinsN: 3, post: post({ text: "https://t.co/oAQHWDkJWU" }), line: own({ n: 2 }) });
  assert.equal(D.subjectLine(pve, NOW, true, { coinsN: 2 })!.happened, "2 coins; 1 launched under $PUMP");
  assert.equal(D.subjectLine(pve, NOW, true, { coinsN: 3 })!.happened, "3 coins");
  assert.equal(D.subjectLine(pve, NOW, true, { row: row(), coinsN: 1 }), null);
  // the poster's words in quote marks are no header sentence: a single row keeps them
  const q = card({ coinsN: 2, post: post({ text: "the bears are done for this week" }), line: own({ subject: "The White Bull", happened: "the bears are done for this week", quote: true }) });
  assert.deepEqual([D.subjectLine(q, NOW, true, { row: row(), coinsN: 2 })!.happened, D.subjectLine(q, NOW, true, { row: row(), coinsN: 2 })!.quote], ["the bears are done for this week", true]);
  // `n` is only a counted server line's, and only a whole positive number
  assert.deepEqual([D.lineOf({ line: line({ n: 4 }) })!.n, D.lineOf({ line: own({ n: 2.5 }) })!.n, D.lineOf({ line: own({ n: 0 }) })!.n, D.lineOf({ line: own({ n: "4" as never }) })!.n, D.lineOf({ line: own() })!.n], [null, null, null, null, null]);
  // the whole way: the size pill (filterStories) cuts the 4-coin card to 2 rows, then to 1 (oneList makes the entries)
  const rows = [row({ mint: "A1", symbol: "ANSEM", mcapUsd: 50_000 }), row({ mint: "A2", symbol: "ANSEM2", mcapUsd: 60_000 }), row({ mint: "A3", symbol: "HACKED", mcapUsd: 900_000 }), row({ mint: "A4", symbol: "ANSEM4", mcapUsd: 9_000_000 })];
  const view = { cards: [{ ...ansem, coins: rows }], loose: [], dust: [], hiddenDust: 0, hiddenCards: 0, hiddenLoose: 0, tagging: true, themes: [], siteBuyers: null } as never;
  const shown = (size: "all" | "small" | "mid") => { const [e] = D.oneList(D.filterStories(view, size), NOW).entries; const L = D.subjectLine(e.card, NOW, true, e.head ? { coinsN: e.coinsN } : { row: e.rows[0], coinsN: e.coinsN }); return [e.coinsN, e.head, L ? L.happened : null]; };
  assert.deepEqual([shown("all"), shown("small"), shown("mid")], [[4, true, SENT], [2, true, "2 coins"], [1, false, null]]);
});

test("10. one row is a single coin, with or without copies folded under it: no header from the page either", () => {
  // a family's one row with a copy under it and no post (an older server, or the lines off): a plain row, not "2 coins launched under $FAM"
  const fam = card({ kind: "family", key: "F", coinsN: 2, family: { mint: "F", symbol: "Slingoor", image: null, startedAt: NOW - 720 } });
  assert.equal(D.subjectLine(fam, NOW, true, { row: row(), coinsN: 2 }), null);
  assert.equal(D.subjectLine(card({ kind: "narrative", key: "n:8", coinsN: 2, narrative: { id: 8, title: "turkey pardon", theme: "politics" } }), NOW, true, { row: row(), coinsN: 2 }), null);
  // drawn under a header (two rows or more: no `row`), the same cards are counted as before
  assert.equal(D.subjectLine(fam, NOW, true, { coinsN: 2 })!.happened, "2 coins launched under $Slingoor");
  // a server that still sent a counted sentence for one row with a copy: not shown over one row
  assert.equal(D.subjectLine(card({ kind: "family", key: "F", coinsN: 2, family: { mint: "F", symbol: "Slingoor", image: null, startedAt: null }, line: own({ subject: "Whited", happened: "Both coins are named Whited; all launched under $Slingoor", chips: ["no_post"], n: 2 }) }), NOW, true, { row: row(), coinsN: 2 }), null);
});

// ---- the markup (components/DiscoverLine.tsx): what the page draws for a line, rendered to a string
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router-dom");
const { SubjectLineBlock, RowTags, plainRowSub, OPEN_POST } = await import("../src/components/DiscoverLine.tsx");
const draw = (L: NonNullable<ReturnType<typeof D.subjectLine>>) => renderToStaticMarkup(createElement(SubjectLineBlock, { L }));
const chipsIn = (html: string) => [...html.matchAll(/<span class="dsc-ln-chip"[^>]*>([^<]*)</g)].map((m) => m[1]);
const count = (html: string, part: string) => html.split(part).length - 1;

test("11. the line as drawn: the AI badge and the chips, the opened body with both posts (each with its own Open post link), the model note only on a model's line", () => {
  assert.equal(OPEN_POST, "Open post");
  // a model's line written from the quoted post
  const via = D.subjectLine(card({ post: post({ text: "Sending 10%https://t.co/abc" }), quoted: quoted({ handle: "dv3333333", at: NOW - 30 * DAY }), line: line({ subject: "Rasmr and big trader", happened: "Quoted post says a big futures trader outdid Rasmr", kind: "claim", chips: ["ai", "via_quoted"] }) }), NOW)!;
  let html = draw(via);
  assert.ok(html.startsWith("<details class=\"dsc-ln\">"), "a line with a post opens");
  assert.ok(html.includes("<b class=\"dsc-ln-s\">Rasmr and big trader:</b>") && html.includes("<span class=\"dsc-ln-h\">Quoted post says a big futures trader outdid Rasmr</span>"));
  assert.deepEqual(chipsIn(html), ["via quoted post @dv3333333", "quoted post 30 d old"]);
  assert.equal(count(html, "class=\"dsc-ln-ai\""), 1, "the AI badge");
  assert.equal(count(html, `</svg>${OPEN_POST}</a>`), 2, "each post has its own link");
  assert.ok(html.includes(`href="https://x.com/i/status/${ID}"`) && html.includes(`href="https://x.com/i/status/${QID}"`), "to the two posts, rebuilt from their ids");
  assert.ok(html.includes("Starting post · @TheKindDev · 1 h ago") && html.includes("Quoted post · @dv3333333 · 30 d old"));
  assert.ok(html.includes("<p class=\"dsc-ln-words\">Sending 10%https://t.co/abc</p>") && html.includes("IShowSpeed wants to team up with Elon Musk."), "both posts' own words");
  assert.equal(count(html, D.LINE_NOTE), 1, "a model wrote the summary: said once");
  assert.equal(count(html, "rel=\"noopener noreferrer\""), 2);
  // a model's line with no quoted post: one post, one link, the note
  html = draw(D.subjectLine(card({ post: post(), line: line() }), NOW)!);
  assert.deepEqual([chipsIn(html), count(html, `</svg>${OPEN_POST}</a>`), count(html, D.LINE_NOTE), count(html, "class=\"dsc-ln-ai\""), html.includes("Quoted post")], [[], 1, 1, 1, false]);
  // the server's own quote, with a quoted post on the card: quote marks, both posts, NO badge and NO model note
  const own2 = D.subjectLine(card({ post: post({ text: "the bears are done for this week" }), quoted: quoted({ at: NOW - 600 }), line: own({ subject: "The White Bull", happened: "the bears are done for this week", quote: true }) }), NOW)!;
  html = draw(own2);
  assert.ok(html.startsWith("<details class=\"dsc-ln dsc-ln-quote\">") && html.includes("<span class=\"dsc-ln-h\">“the bears are done for this week”</span>"));
  assert.deepEqual([count(html, `</svg>${OPEN_POST}</a>`), count(html, D.LINE_NOTE), count(html, "class=\"dsc-ln-ai\""), chipsIn(html)], [2, 0, 0, []]);
  // a counted sentence over a story with no post: plain text, nothing to open, its chips
  const counted = D.subjectLine(card({ kind: "narrative", key: "n:1144", coinsN: 4, narrative: { id: 1144, title: "ansem hacked black bull rug", theme: "crypto native" }, line: own({ subject: "Ansem", happened: "3 of 4 coins are named Ansem; 2 launched under $Slingoor", chips: ["ai_group", "no_post"], n: 4 }) }), NOW, true, { coinsN: 4 })!;
  html = draw(counted);
  assert.ok(html.startsWith("<div class=\"dsc-ln dsc-ln-light\">") && !html.includes("<details") && !html.includes("<a "));
  assert.deepEqual([chipsIn(html), count(html, OPEN_POST), count(html, D.LINE_NOTE), count(html, "class=\"dsc-ln-ai\"")], [["AI group", "no post"], 0, 0, 0]);
  // a personal post is drawn quieter; a mismatch says so by a chip
  assert.ok(draw(D.subjectLine(card({ post: post(), line: line({ kind: "personal" }) }), NOW)!).startsWith("<details class=\"dsc-ln dsc-ln-personal\">"));
  assert.deepEqual(chipsIn(draw(D.subjectLine(card({ post: post(), line: line({ kind: "mismatch", chips: ["ai", "mismatch"] }) }), NOW)!)), ["post does not name this coin"]);
  // a stranger's text is text, never markup
  html = draw(D.subjectLine(card({ post: post({ text: "<img src=x onerror=alert(1)> hello" }), line: line({ subject: "<b>X</b>", happened: "A <script>x</script> thing" }) }), NOW)!);
  assert.equal(/<img|<script|<b>X/.test(html), false);
});

test("12. a single coin with nothing to say (`line: null`) is a plain row: its Open post link and its \"under $PARENT\" mark, no line", () => {
  const r = row({ mint: "W1", name: "The White Bull", symbol: "Slingoor", parent: { mint: "ParentMint1111111111111111111111111111111111", symbol: "Slingoor" } as never });
  const c = card({ post: post({ text: "SENDING 5%https://t.co/9IXTi6yoBB" }), line: null, coins: [r] });
  assert.equal(D.subjectLine(c, NOW, true, { row: r, coinsN: 1 }), null, "no subject line: the page draws the row alone");
  const tags = (sub: ReturnType<typeof plainRowSub>) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RowTags, { r: r as never, parent: true, sub })));
  let html = tags(plainRowSub(c));
  assert.deepEqual(plainRowSub(c), { text: "Open post", href: `https://x.com/i/status/${ID}` });
  assert.ok(html.includes(`<span class="dsc-csub"><a href="https://x.com/i/status/${ID}" target="_blank" rel="noopener noreferrer"`) && html.includes("<span>Open post</span></a>"), html);
  assert.ok(html.includes("class=\"dsc-ptag\"") && html.includes(">under $Slingoor</a>") && html.includes("href=\"/map?focus=ParentMint1111111111111111111111111111111111\""), "the parent's mark, a link to it on the map");
  assert.equal(/dsc-ln|SENDING/.test(html), false, "no line, and the fee line is not shown");
  // without a post (a family's single coin): only the parent's mark
  const bare = card({ kind: "family", key: "F", family: { mint: "F", symbol: "Slingoor", image: null, startedAt: NOW - 720 }, coins: [r] });
  assert.equal(plainRowSub(bare), undefined);
  html = tags(plainRowSub(bare));
  assert.deepEqual([html.includes("Open post"), html.includes(">under $Slingoor</a>")], [false, true]);
  // a row with a copy folded under it says so on the row
  assert.ok(renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RowTags, { r: { ...r, copies: [{ mint: "W2", createdAt: null, firstSeenAt: null, liqUsd: null, buyers5m: 1, buyers: 1 }] } as never, parent: true, sub: plainRowSub(c) }))).includes("class=\"dsc-chip\""));
});

test("sentence case: the first letter a capital, the rest as written; a few short words always in capitals", () => {
  assert.equal(D.sentenceCase("trump tariff panic"), "Trump tariff panic");
  assert.equal(D.sentenceCase("ai bubble popping"), "AI bubble popping");
  assert.equal(D.sentenceCase("the ai bubble"), "The AI bubble");
  assert.equal(D.sentenceCase("gta 6"), "GTA 6");
  assert.equal(D.sentenceCase("iPhone fold"), "iPhone fold");
  assert.equal(D.sentenceCase("Jensen Huang"), "Jensen Huang");
  assert.equal(D.sentenceCase("  moo\n deng​ the hippo "), "Moo deng the hippo");
  assert.equal(D.sentenceCase(""), "");
  assert.equal(D.sentenceCase(null), "");
  assert.ok(D.sentenceCase("x".repeat(200)).length <= D.TITLE_MAX);
});

test("the age: a post older than 7 days gets an outlined chip (\"18 d old\", \"5 mo old\") instead of \"1 h ago\"", () => {
  assert.equal(D.oldChip(NOW - 7 * DAY, NOW), null, "exactly 7 days is not old yet");
  assert.equal(D.oldChip(NOW - 7 * DAY - 1, NOW), "7 d old");
  assert.equal(D.oldChip(NOW - 18 * DAY, NOW), "18 d old");
  assert.equal(D.oldChip(NOW - 59 * DAY, NOW), "59 d old");
  assert.equal(D.oldChip(NOW - 153 * DAY, NOW), "5 mo old");
  assert.equal(D.oldChip(NOW - 3 * 366 * DAY, NOW), "3 y old");
  assert.equal(D.oldChip(null, NOW), null);
  assert.equal(D.oldChip(NOW - 3600, NOW), null);
  const old = D.subjectLine(card({ post: post({ at: NOW - 153 * DAY }), line: line({ happened: "Users could add employment history and job title" }) }), NOW)!;
  assert.deepEqual([old.old, old.when], ["5 mo old", ""]);
  const fresh = D.subjectLine(card({ post: post({ at: NOW - 3 * DAY }), line: line() }), NOW)!;
  assert.deepEqual([fresh.old, fresh.when], [null, "3 d ago"]);
  const unknown = D.subjectLine(card({ post: post({ at: null }), line: line() }), NOW)!;
  assert.deepEqual([unknown.old, unknown.when], [null, ""]);
});
