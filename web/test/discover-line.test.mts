// The Discover subject line (web/src/lib/discover.ts subjectLine and its helpers): "Subject: what happened" for a single
// coin's card and a story's header. Every fallback (the server's model-written line; a narrative's title with no post;
// a family; a post with no line yet, quoted), sentence case, the age chip of an old post, the personal and none tones,
// and the quote cut at 80 characters.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoryCard, StoryRow } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");

const NOW = 1_770_000_000, DAY = 86_400;
const ID = "1895000000000000001";
const post = (o: Partial<NonNullable<StoryCard["post"]>> = {}) => ({ id: ID, handle: "TheKindDev", text: "X now lets users add employment history and job title to their profiles https://t.co/abc", at: NOW - 3600, url: "x", ...o });
const row = (o: Partial<StoryRow> = {}): StoryRow => ({ mint: "M1", name: "Job Title", symbol: "JOB", ...o } as StoryRow);
const card = (o: Partial<StoryCard> = {}): StoryCard => ({ kind: "post", key: ID, post: null, family: null, buyers5m: 0, coinsN: 1, coins: [row()], ...o });
const line = (o: Partial<NonNullable<StoryCard["line"]>> = {}) => ({ subject: "X profiles", happened: "Users can now add employment history and job title", kind: "event" as const, ...o });

test("fallback 1: the server's line is shown as written, marked AI, with who, when, the post's link and the poster's own words", () => {
  const L = D.subjectLine(card({ post: post(), line: line() }), NOW)!;
  assert.deepEqual([L.subject, L.happened, L.auto, L.tone, L.quote], ["X profiles", "Users can now add employment history and job title", true, "normal", false]);
  assert.deepEqual(L.badge, { text: "AI", title: "Written by a model from the post. It can be wrong." });
  assert.deepEqual([L.who, L.when, L.old], ["@TheKindDev", "1 h ago", null]);
  assert.ok(L.href?.startsWith("https://x.com/") && L.href.includes(ID), "the link is rebuilt from the id, not taken from the body");
  assert.ok(L.words?.startsWith("X now lets users add employment history"));
  assert.equal(D.LINE_NOTE, "Summary written by a model. It can be wrong.");
  // the same on a narrative story's header: the line's subject stands in for the title
  const N = D.subjectLine(card({ kind: "narrative", key: "n:7", coinsN: 3, narrative: { id: 7, title: "x profile jobs", theme: "tech & products" }, post: post(), line: line() }), NOW)!;
  assert.deepEqual([N.subject, N.auto, N.badge?.text], ["X profiles", true, "AI"]);
  // a line is only ever about a post: without one it is not used
  assert.notEqual(D.subjectLine(card({ kind: "family", key: "F", family: { mint: "F", symbol: "FAM", image: null, startedAt: NOW - 600 }, line: line() }), NOW)!.subject, "X profiles");
});

test("tones: a personal post's subject is drawn quieter, a post that names no event is light; other kinds are normal", () => {
  const tone = (kind: NonNullable<StoryCard["line"]>["kind"]) => D.subjectLine(card({ post: post(), line: line({ kind }) }), NOW)!.tone;
  assert.deepEqual((["event", "claim", "pitch", "mismatch", "personal", "none"] as const).map(tone), ["normal", "normal", "normal", "normal", "personal", "light"]);
  const none = D.subjectLine(card({ post: post({ text: "pepe" }), line: line({ subject: "Pepe", happened: "Post only names the meme; no event stated", kind: "none" }) }), NOW)!;
  assert.deepEqual([none.subject, none.happened, none.tone, none.auto], ["Pepe", "Post only names the meme; no event stated", "light", true]);
});

test("a damaged or unknown line is not shown: the card falls back to the poster's words", () => {
  for (const bad of [{ subject: "", happened: "x", kind: "event" }, { subject: "A", happened: " ", kind: "event" }, { subject: "A", happened: "B", kind: "advice" }, { subject: 1, happened: "B", kind: "event" }, "text", null]) {
    assert.equal(D.lineOf({ line: bad }), null);
    const L = D.subjectLine(card({ post: post(), line: bad as never }), NOW)!;
    assert.deepEqual([L.auto, L.badge, L.quote], [false, null, true]);
  }
  assert.deepEqual(D.lineOf({ line: { subject: " X​ profiles\n", happened: "Users add jobs", kind: "event", extra: 1 } }), { subject: "X profiles", happened: "Users add jobs", kind: "event" }, "made plain; nothing else is carried");
});

test("fallback 2: no post but a narrative title: the title in sentence case, the coin count, the AI title badge, light", () => {
  const L = D.subjectLine(card({ kind: "narrative", key: "n:8", coinsN: 3, narrative: { id: 8, title: "turkey pardon", theme: "politics" } }), NOW)!;
  assert.deepEqual([L.subject, L.happened, L.auto, L.badge?.text, L.tone, L.quote], ["Turkey pardon", "No starting post. 3 coins grouped by a model", false, "AI title", "light", false]);
  assert.deepEqual([L.who, L.when, L.old, L.href, L.words], [null, "", null, null, null], "nothing to open");
  // the count is the entry's own when given (a size filter)
  assert.equal(D.subjectLine(card({ kind: "narrative", key: "n:8", coinsN: 5, narrative: { id: 8, title: "turkey pardon", theme: "politics" } }), NOW, true, { coinsN: 2 })!.happened, "No starting post. 2 coins grouped by a model");
  // a loose coin with its own story tag, while narratives are shown: the same card, and only then
  const loose = row({ narrative: { id: 9, title: "ai bubble popping", theme: "ai" } });
  const S = D.subjectLine(null, NOW, true, { row: loose })!;
  assert.deepEqual([S.subject, S.happened, S.badge?.text, S.tone], ["AI bubble popping", "No starting post. Story named by a model", "AI title", "light"]);
  assert.equal(D.subjectLine(null, NOW, false, { row: loose }), null);
  assert.equal(D.subjectLine(null, NOW, true, { row: row() }), null, "a loose coin with no story has no line: a plain row");
  assert.equal(D.subjectLine(null, NOW), null);
  // a family card whose coins share a narrative: the title leads, when narratives are shown
  const fam = card({ kind: "family", key: "F", coinsN: 2, family: { mint: "F", symbol: "FAM", image: null, startedAt: NOW - 600 }, narrative: { id: 4, title: "moo deng the hippo", theme: "animals" } });
  assert.equal(D.subjectLine(fam, NOW, true)!.subject, "Moo deng the hippo");
  assert.equal(D.subjectLine(fam, NOW, false)!.subject, "FAM");
  // a subject block's title is the server's own table's: no AI badge
  const subj = D.subjectLine(card({ kind: "narrative", key: "t:jensen", coinsN: 4, narrative: { id: 3, title: "Jensen Huang", theme: "tech & products" }, subject: { key: "t:jensen", title: "Jensen Huang", angles: [] } }), NOW)!;
  assert.deepEqual([subj.subject, subj.badge], ["Jensen Huang", null]);
});

test("fallback 3: a family with no post and no title: the parent's ticker and where it launched; no badge", () => {
  const L = D.subjectLine(card({ kind: "family", key: "F", family: { mint: "F", symbol: "FAM", image: null, startedAt: NOW - 720 } }), NOW)!;
  assert.deepEqual([L.subject, L.happened, L.auto, L.badge, L.quote, L.href], ["FAM", "Launched under $FAM. No starting post", false, null, false, null]);
  const noSym = D.subjectLine(card({ kind: "family", key: "F", family: { mint: "FaMiLyMiNt1111111111111111111111111111111111", symbol: null, image: null, startedAt: null } }), NOW)!;
  assert.ok(noSym.subject.length > 0 && noSym.happened.startsWith("Launched under ") && noSym.happened.endsWith(". No starting post"));
});

test("fallback 4: a post but no line: the title or the coin's name as the subject, the poster's first 80 characters in quote marks, no AI badge (a model's title is marked \"AI title\")", () => {
  const L = D.subjectLine(card({ post: post() }), NOW)!;
  assert.deepEqual([L.subject, L.auto, L.badge, L.quote, L.tone], ["Job Title", false, null, true, "normal"]);
  assert.equal(L.happened, "X now lets users add employment history and job title to their profiles", "links are cut (cleanSay)");
  assert.deepEqual([L.who, L.when], ["@TheKindDev", "1 h ago"]);
  // with a narrative, its title in sentence case; a name falls back to the ticker, then to "Linked post"
  assert.equal(D.subjectLine(card({ post: post(), narrative: { id: 7, title: "x profile jobs", theme: "tech & products" } }), NOW)!.subject, "X profile jobs");
  assert.equal(D.subjectLine(card({ post: post(), narrative: { id: 7, title: "x profile jobs", theme: "tech & products" } }), NOW, false)!.subject, "Job Title", "narratives not shown: the coin's name");
  assert.equal(D.subjectLine(card({ post: post(), coins: [row({ name: null, symbol: "JOB" })] }), NOW)!.subject, "$JOB");
  assert.equal(D.subjectLine(card({ post: post(), coins: [] }), NOW)!.subject, "Linked post");
  // a subject that is a model's title says so, though the sentence is the poster's: "AI title", and no summary note
  const T = D.subjectLine(card({ post: post(), narrative: { id: 7, title: "x profile jobs", theme: "tech & products" } }), NOW)!;
  assert.deepEqual([T.subject, T.badge, T.auto, T.quote], ["X profile jobs", { text: "AI title", title: D.AI_TITLE_BADGE_TITLE }, false, true]);
  assert.equal(D.subjectLine(card({ post: post(), narrative: { id: 7, title: "x profile jobs", theme: "tech & products" } }), NOW, false)!.badge, null, "narratives not shown: the coin's name, no badge");
  const tbl = D.subjectLine(card({ kind: "narrative", key: "t:jensen", coinsN: 4, post: post(), narrative: { id: 3, title: "Jensen Huang", theme: "tech & products" }, subject: { key: "t:jensen", title: "Jensen Huang", angles: [] } }), NOW)!;
  assert.deepEqual([tbl.subject, tbl.badge], ["Jensen Huang", null], "a subject block's title is the server's own table's");
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
