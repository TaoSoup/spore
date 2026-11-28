// A coin's own story line on Discover (web/src/lib/discover.ts rowLine, rowLineIn and the "coin_line" header in
// subjectLine): every row of a newer server carries `storyLine`; a model's line is marked AI with what it read, its
// keys checked again; a quote of the coin's own text is in quote marks; "Name only: ..." is light; a row's line inside
// a story shows only when it says something the header does not; a card headed by a coin's own line (chip
// "coin_line", with or without a post) says whose line it is. The markup is rendered to a string: text nodes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoinStoryLine, StoryCard, StoryRow } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SubjectLineBlock } = await import("../src/components/DiscoverLine.tsx");

const NOW = 1_770_000_000, ID = "1895000000000000001";
const sl = (o: Partial<CoinStoryLine> = {}): CoinStoryLine => ({ subject: "Moo Deng", happened: "Baby pygmy hippo at a zoo in Thailand", keys: ["pygmy hippo"], by: "model", source: "description", ...o });
const row = (o: Partial<StoryRow> = {}): StoryRow => ({ mint: "M1", name: "Moo Deng", symbol: "MOODENG", storyLine: sl(), ...o } as StoryRow);
const card = (o: Partial<StoryCard> = {}): StoryCard => ({ kind: "family", key: "F", post: null, family: { mint: "F", symbol: "FAM", image: null, startedAt: NOW - 600 }, buyers5m: 0, coinsN: 2, coins: [row(), row({ mint: "M2" })], ...o });
const draw = (L: NonNullable<ReturnType<typeof D.rowLine>>) => renderToStaticMarkup(createElement(SubjectLineBlock, { L }));

test("1. a row's story line: a model's line is AI with what it read and its key phrases; a quote in quote marks; Name only light; nothing for an older server", () => {
  const L = D.rowLine(row())!;
  assert.deepEqual([L.subject, L.happened, L.auto, L.quote, L.tone, L.keys, L.chips, L.href], ["Moo Deng", "Baby pygmy hippo at a zoo in Thailand", true, false, "normal", ["pygmy hippo"], [], null]);
  assert.deepEqual(L.badge, { text: "AI", title: D.COIN_AI_TITLE.description });
  assert.equal(D.rowLine(row({ storyLine: sl({ source: "picture" }) }))!.badge!.title, "Read from this coin's picture by a model. It can be wrong.");
  assert.deepEqual(D.rowLine(row({ storyLine: sl({ keys: ["not in it", "Thailand"] }) }))!.keys, ["Thailand"], "keys are checked again");
  const Q = D.rowLine(row({ storyLine: { subject: "Moo Deng", happened: "the hippo that bites", by: "server", source: "description", quote: true } }))!;
  assert.deepEqual([Q.auto, Q.badge, Q.quote, Q.keys, Q.tone], [false, null, true, [], "normal"]);
  const N = D.rowLine(row({ storyLine: { subject: "Bonk Cat", happened: "Name only: no description, picture or post", keys: [], by: "server", source: "name" } }))!;
  assert.deepEqual([N.auto, N.badge, N.quote, N.tone, N.happened], [false, null, false, "light", "Name only: no description, picture or post"]);
  assert.equal(D.rowLineNameOnly(row({ storyLine: { subject: "B", happened: "Name only: x", by: "server", source: "name" } })), true);
  for (const bad of [undefined, null, { subject: "A" }, { subject: "", happened: "x" }, { subject: "A", happened: "  " }, "text"]) assert.equal(D.rowLine({ storyLine: bad }), null, JSON.stringify(bad));
  // drawn as the subject line: the subject, the sentence with its key marked, the AI badge; plain text, no link
  const html = draw(L);
  assert.ok(html.startsWith("<div class=\"dsc-ln\">"), "nothing to open");
  assert.ok(html.includes("<b class=\"dsc-ln-s\">Moo Deng:</b>") && html.includes("<mark class=\"dsc-key\">pygmy hippo</mark>") && html.includes("class=\"dsc-ln-ai\""));
  assert.ok(draw(Q).includes("“the hippo that bites”"));
  assert.ok(draw(N).includes("dsc-ln-light") && !draw(N).includes("dsc-ln-ai"));
  const evil = draw(D.rowLine(row({ storyLine: sl({ subject: "<img src=x>", happened: "<script>alert(1)</script> hippo" }) }))!);
  assert.ok(!evil.includes("<script>") && !evil.includes("<img"), "text nodes only");
});

test("2. a row's line under a header: only when it says something the header does not", () => {
  const head = D.rowLine(row())!;
  assert.equal(D.rowLineIn(row(), head, card()), null, "the header's own line");
  assert.equal(D.rowLineIn(row({ storyLine: sl({ subject: "Other" }) }), head, card()), null, "the same sentence under another subject");
  assert.ok(D.rowLineIn(row({ storyLine: sl({ subject: "Pesto", happened: "Baby penguin at a zoo in Australia", keys: [] }) }), head, card()), "another coin's own line");
  assert.ok(D.rowLineIn(row(), null, card()), "no header: its own line");
  // a quote of the very post the card shows: its words are one tap away in the header
  const postQuote = row({ storyLine: { subject: "Moo Deng", happened: "the zoo posted a new video", by: "server", source: "post", quote: true } });
  assert.equal(D.rowLineIn(postQuote, head, card({ post: { id: ID, handle: "zoo", text: "the zoo posted a new video", at: NOW - 60, url: "x" } })), null);
  assert.ok(D.rowLineIn(postQuote, head, card()), "without a post on the card it is the coin's own");
  // "Name only" under a "Name only" header says nothing more; under a real header it says this coin is not read yet
  const nameRow = row({ storyLine: { subject: "Bonk", happened: "Name only: picture not read yet", by: "server", source: "name" } });
  const nameHead = D.subjectLine(card({ line: { subject: "FAM", happened: "Name only: these coins are not read yet", kind: "thin", by: "server", quote: false, chips: [] } }), NOW)!;
  assert.equal(D.rowLineIn(nameRow, nameHead, card()), null);
  assert.equal(D.rowLineIn(nameRow, head, card())!.happened, "Name only: picture not read yet");
  // in a story of several rows no "Name only" line under any header: not a model's, a coin's, a quote's
  const bare = row({ storyLine: { subject: "Copy", happened: "Name only: no description, picture or post", by: "server", source: "name" } });
  const quoteHead = D.rowLine(row({ storyLine: { subject: "Moo Deng", happened: "the hippo that bites", by: "server", source: "description", quote: true } }))!;
  for (const h of [head, nameHead, quoteHead]) for (const r of [bare, nameRow]) assert.equal(D.rowLineIn(r, h, card(), { many: true }), null, `${h.happened} / ${r.storyLine?.happened}`);
  assert.ok(D.rowLineIn(row({ storyLine: sl({ subject: "Pesto", happened: "Baby penguin at a zoo in Australia", keys: [] }) }), head, card(), { many: true }), "a line that says something stays");
  assert.ok(D.rowLineIn(bare, null, card(), { many: true }), "no header: its own line, even name only");
});

test("3. a card headed by a coin's own line: a model's line with or without a post, AI with its own badge title, the chip saying whose line it is; a quote of a coin's text the same, no AI", () => {
  const coinHead = { subject: "Moo Deng", happened: "Baby pygmy hippo at a zoo in Thailand", kind: "event" as const, by: "model" as const, quote: false, chips: ["ai" as const, "coin_line" as const], keys: ["pygmy hippo"], of: { mint: "M1", symbol: "MOODENG" } };
  const L = D.subjectLine(card({ line: coinHead }), NOW)!;
  assert.deepEqual([L.subject, L.happened, L.auto, L.keys, L.href], ["Moo Deng", "Baby pygmy hippo at a zoo in Thailand", true, ["pygmy hippo"], null]);
  assert.deepEqual(L.badge, { text: "AI", title: D.COIN_HEAD_AI_TITLE });
  assert.deepEqual(L.chips, [{ text: "from $MOODENG", title: D.COIN_LINE_TITLE }]);
  // the same over a post without words: the post stays one tap away (who, when, its link)
  const P = D.subjectLine(card({ kind: "post", key: ID, family: null, post: { id: ID, handle: "zoo", text: "https://t.co/abc", at: NOW - 3600, url: "x" }, line: { ...coinHead, chips: ["ai", "coin_line", "ai_group"] } }), NOW)!;
  assert.deepEqual([P.auto, P.who, P.chips.map((c) => c.text)], [true, "@zoo", ["from $MOODENG", "AI group"]]);
  assert.ok(P.href?.includes(ID));
  // a damaged `of` is no ticker
  assert.equal(D.subjectLine(card({ line: { ...coinHead, of: { mint: "M1", symbol: 7 as unknown as string } } }), NOW)!.chips[0].text, "from one coin");
  // a coin's quote heading a story
  const Q = D.subjectLine(card({ line: { subject: "Moo Deng", happened: "the hippo that bites", kind: "thin", by: "server", quote: true, chips: ["coin_line"], of: { mint: "M1", symbol: "MOODENG" } } }), NOW)!;
  assert.deepEqual([Q.auto, Q.quote, Q.chips.map((c) => c.text)], [false, true, ["from $MOODENG"]]);
  // a model's line without a post and without coin_line is still not used (a post line needs its post)
  assert.equal(D.subjectLine(card({ line: { ...coinHead, chips: ["ai"] } }), NOW)!.subject, "FAM");
  // a "Name only" header over several coins: light, as written; over ONE row the page shows the row's own line instead
  const N = D.subjectLine(card({ line: { subject: "FAM", happened: "Name only: these coins are not read yet", kind: "thin", by: "server", quote: false, chips: [] } }), NOW)!;
  assert.deepEqual([N.happened, N.tone, N.auto], ["Name only: these coins are not read yet", "light", false]);
  assert.equal(D.subjectLine(card({ coinsN: 1, line: { subject: "Bonk", happened: "Name only: picture not read yet", kind: "thin", by: "server", quote: false, chips: [] } }), NOW, true, { row: row() }), null);
  assert.ok(D.LINE_CHIPS.includes("coin_line"));
});
