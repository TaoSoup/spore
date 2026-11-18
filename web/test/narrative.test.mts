// Linked posts (web/src/lib/narrative.ts): the link rebuilt from a post id, what the panel and the coin page show first
// and behind "Show more", the words of every line, how a later answer is laid over the rows on screen and when asking
// stops. No DOM, no network (a fake fetch for the one request).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Narrative, NarrativeCoin, NarrativeOwn, NarrativePost } from "../src/lib/api.ts";
const { safePostUrl, postHandle, postLinkText, postLinkAria, postText, narrativeView, postStat, postStatTitle, siblingsLine, chipSym, chipVol, chipText,
  CAPTION_OWN, familyCaption, moreCaption, moreText, wordsLine, NARRATIVE_FOOT, anyWait, mergePoll, nextPollMs, settle, shownAnswer } = await import("../src/lib/narrative.ts");
const { api } = await import("../src/lib/api.ts");

const MINT = "Par1111111111111111111111111111111111111111";
const KID = "Kid1111111111111111111111111111111111111111";
const ID1 = "2120644813917925721", ID2 = "1990000000000000001", ID3 = "1880000000000000002";
const chip = (mint: string, o: Partial<NarrativeCoin> = {}): NarrativeCoin => ({ mint, name: "Jensen", symbol: "JENSEN", image: null, usd24: 1200, ...o });
const post = (id: string, o: Partial<NarrativePost> = {}): NarrativePost =>
  ({ id, url: `https://x.com/i/status/${id}`, at: 1_762_850_000, coins: 28, usd24: 12_345.6, state: "ok", handle: "tradfi", text: "hello", top: [chip("A1")], ...o });
const own = (id: string, o: Partial<NarrativeOwn> = {}): NarrativeOwn =>
  ({ id, url: `https://x.com/i/status/${id}`, at: 1_762_850_000, state: "ok", handle: "tradfi", text: "mine", siblings: 5, top: [chip("S1")], parent: { mint: MINT, name: "NVIDIA", symbol: "NVDAx" }, ...o });
const body = (o: Partial<Narrative> = {}): Narrative => ({ mint: MINT, asOf: 1_763_400_000, members: 334, linked: 279, posts: [], words: [], own: null, under: null, pending: false, ...o });

test("1. safePostUrl: the link is built from the digits; anything that is not a post id gives null", () => {
  assert.equal(safePostUrl(ID1), `https://x.com/i/status/${ID1}`);
  assert.equal(safePostUrl("1"), "https://x.com/i/status/1");
  assert.equal(safePostUrl("9".repeat(19)), `https://x.com/i/status/${"9".repeat(19)}`);
  for (const bad of ["", "0", "0123", "1".repeat(20), "12a", " 12", "12 ", "12\n", "-12", "1.5", "1e5", "١٢٣", "12/../../intent/post", "12?x=1", "12#a", "javascript:alert(1)", "https://x.com/i/status/12", null, undefined, 12, 12n, {}, ["12"]]) {
    assert.equal(safePostUrl(bad), null, `not an id: ${String(bad)}`);
  }
});

test("2. the post link's words: the author only with a known text and a handle-shaped handle, else \"View post\"", () => {
  assert.equal(postHandle(post(ID1)), "tradfi");
  assert.equal(postLinkText(post(ID1)), "@tradfi ↗");
  assert.equal(postLinkText(post(ID1, { handle: "a_B9" })), "@a_B9 ↗");
  // a state other than "ok" never shows a handle, whatever the body carries
  for (const state of ["wait", "none", "idle"] as const) {
    assert.equal(postHandle(post(ID1, { state })), null);
    assert.equal(postLinkText(post(ID1, { state })), "View post ↗");
  }
  for (const handle of [null, "", "has space", "sixteen_chars_xx", "<b>x</b>", "a/b", "@a", "é"]) {
    assert.equal(postHandle(post(ID1, { handle })), null, `not a handle: ${handle}`);
    assert.equal(postLinkText(post(ID1, { handle })), "View post ↗");
  }
  assert.equal(postHandle(post(ID1, { handle: 7 as unknown as string })), null);
});

test("3. postLinkAria: says how many coins link the post, when that is known", () => {
  assert.equal(postLinkAria(post(ID1, { coins: 28 })), "View the post on X, linked by 28 coins");
  assert.equal(postLinkAria(post(ID1, { coins: 1 })), "View the post on X, linked by 1 coin");
  // an own post: the coin itself and its siblings
  assert.equal(postLinkAria(own(ID1, { siblings: 5 })), "View the post on X, linked by 6 coins");
  assert.equal(postLinkAria(own(ID1, { siblings: 0 })), "View the post on X, linked by 1 coin");
  assert.equal(postLinkAria(own(ID1, { siblings: null, parent: null })), "View the post on X");
});

test("4. postText: only a known text; markup stays text for the caller to render as text, line breaks read as one space", () => {
  assert.equal(postText(post(ID1, { text: "a <b>b</b> &amp;" })), "a <b>b</b> &amp;");
  // a headline, an empty line, the body: the empty line does not use up a line of the row's clamp
  assert.equal(postText(post(ID1, { text: "NVIDIA to announce X\n\nJensen said the new chips" })), "NVIDIA to announce X Jensen said the new chips");
  assert.equal(postText(post(ID1, { text: "one\ntwo" })), "one two");
  assert.equal(postText(post(ID1, { text: "one \n \n\t two\n\nthree" })), "one two three", "blanks around a break do not add up");
  assert.equal(postText(post(ID1, { text: "\nlead and trail\n\n" })), "lead and trail");
  assert.equal(postText(post(ID1, { text: "two  spaces stay" })), "two  spaces stay", "only line breaks are touched");
  assert.equal(postText(post(ID1, { text: "\n\n" })), "");
  assert.equal(postText(post(ID1, { text: "" })), "", "a media-only post");
  assert.equal(postText(post(ID1, { text: null })), "");
  assert.equal(postText(post(ID1, { state: "wait", text: "early" })), "");
  assert.equal(postText(post(ID1, { state: "none", text: "gone" })), "");
  assert.equal(postText(post(ID1, { text: 5 as unknown as string })), "");
});

test("5. narrativeView: an own post leads; the rest is the family's posts without the one it already shows", () => {
  const v = narrativeView(body({ mint: KID, own: own(ID1), posts: [post(ID2), post(ID1), post(ID3)], words: [{ w: "jensen", n: 7 }, { w: "senate", n: 4 }] }));
  assert.equal(v.lead?.kind, "own");
  assert.equal(v.lead?.post.id, ID1);
  assert.deepEqual(v.rest.map((p) => p.id), [ID2, ID3], "the own post's id is shown once");
  assert.deepEqual(v.words.map((w) => w.w), ["jensen", "senate"]);
  assert.equal(v.empty, false);
});

test("6. narrativeView: without an own post the first family post leads and the others are the rest", () => {
  const v = narrativeView(body({ posts: [post(ID1), post(ID2), post(ID3)] }));
  assert.equal(v.lead?.kind, "family");
  assert.equal(v.lead?.post.id, ID1);
  assert.deepEqual(v.rest.map((p) => p.id), [ID2, ID3]);
  const one = narrativeView(body({ posts: [post(ID1)] }));
  assert.deepEqual(one.rest, []);
  assert.equal(one.empty, false);
});

test("7. narrativeView: a coin with neither shows its parent's post; family posts win over it", () => {
  const under = { mint: MINT, name: "NVIDIA", symbol: "NVDAx", post: post(ID2) };
  const v = narrativeView(body({ mint: KID, under }));
  assert.equal(v.lead?.kind, "under");
  assert.equal(v.lead?.post.id, ID2);
  assert.deepEqual(v.lead?.kind === "under" ? v.lead.parent : null, { mint: MINT, name: "NVIDIA", symbol: "NVDAx" });
  assert.deepEqual(v.rest, []);
  assert.equal(narrativeView(body({ mint: KID, under, posts: [post(ID1)] })).lead?.kind, "family");
  assert.equal(narrativeView(body({ mint: KID, under, own: own(ID3) })).lead?.kind, "own");
});

test("8. narrativeView: nothing to show is empty; words show only when there are two or more", () => {
  for (const n of [null, undefined, body(), body({ words: [{ w: "a", n: 3 }, { w: "b", n: 3 }] })]) {
    const v = narrativeView(n);
    assert.equal(v.lead, null);
    assert.equal(v.empty, true);
    assert.deepEqual(v.rest, []);
  }
  assert.deepEqual(narrativeView(body({ posts: [post(ID1)], words: [{ w: "jensen", n: 7 }] })).words, [], "one word is not a pattern");
  assert.equal(narrativeView(body({ posts: [post(ID1)], words: [{ w: "a", n: 3 }, { w: "b", n: 3 }] })).words.length, 2);
  // a body with lists missing (an older or failing server) reads as empty, never throws
  const bare = narrativeView({ mint: MINT } as unknown as Narrative);
  assert.equal(bare.empty, true);
  assert.deepEqual(bare.words, []);
});

test("9. postStat: the coins linking the post and their 24 h volume; the volume is left out under $1", () => {
  assert.equal(postStat({ coins: 28, usd24: 12_345.6 }), "28 coins · $12.3K vol");
  assert.equal(postStat({ coins: 1, usd24: 12_345.6 }), "1 coin · $12.3K vol");
  assert.equal(postStat({ coins: 2, usd24: 1 }), "2 coins · $1.00 vol");
  assert.equal(postStat({ coins: 2, usd24: 0.99 }), "2 coins");
  assert.equal(postStat({ coins: 2, usd24: 0 }), "2 coins");
  assert.equal(postStat({ coins: 1, usd24: Number.NaN }), "1 coin");
  assert.equal(postStat({ coins: 1_284, usd24: 2_500_000 }), "1,284 coins · $2.5M vol");
});

test("10. postStatTitle: says what the numbers are, and that they do not measure the post", () => {
  assert.equal(postStatTitle({ coins: 28, usd24: 12_345.6 }), "28 coins link to this post. They traded $12.3K in the last 24 h. This is not a measure of the post.");
  assert.equal(postStatTitle({ coins: 1, usd24: 40 }), "1 coin links to this post. It traded $40.00 in the last 24 h. This is not a measure of the post.");
  assert.equal(postStatTitle({ coins: 3, usd24: 0 }), "3 coins link to this post. This is not a measure of the post.");
});

test("11. siblingsLine: the other coins under the parent linking the same post; null when there are none", () => {
  assert.equal(siblingsLine(own(ID1, { siblings: 5 })), "Also linked by 5 other coins under $NVDAx");
  assert.equal(siblingsLine(own(ID1, { siblings: 1 })), "Also linked by 1 other coin under $NVDAx");
  assert.equal(siblingsLine(own(ID1, { siblings: 0 })), null);
  assert.equal(siblingsLine(own(ID1, { siblings: null, parent: null })), null);
  assert.equal(siblingsLine(null), null);
  // a parent without a ticker is named by its short address
  assert.equal(siblingsLine(own(ID1, { siblings: 2, parent: { mint: MINT, name: null, symbol: null } })), "Also linked by 2 other coins under Par1…1111");
});

test("12. a coin chip: ticker and 24 h volume, the volume left out under $1", () => {
  assert.equal(chipText(chip("A", { symbol: "JENSEN", usd24: 1200 })), "$JENSEN $1.2K");
  assert.equal(chipSym(chip("A")), "$JENSEN");
  assert.equal(chipVol(chip("A", { usd24: 1200 })), "$1.2K");
  assert.equal(chipText(chip("A", { usd24: 0.4 })), "$JENSEN");
  assert.equal(chipVol(chip("A", { usd24: 0 })), null);
  assert.equal(chipText(chip(KID, { symbol: null, usd24: 15 })), "Kid1…1111 $15.00");
});

test("13. the captions, the Show more button and the words line", () => {
  assert.equal(CAPTION_OWN, "Linked by this coin's creator");
  assert.equal(familyCaption("$NVDAx"), "Linked by coins under $NVDAx");
  assert.equal(moreCaption("$NVDAx"), "More posts linked by coins under $NVDAx");
  assert.equal(moreText(4), "Show 4 more");
  assert.equal(moreText(1), "Show 1 more");
  assert.equal(moreText(0), "Show more", "only the words are behind it");
  assert.equal(wordsLine([{ w: "jensen" }, { w: "senate" }, { w: "cat" }]), "Common words in names: jensen · senate · cat");
  assert.equal(NARRATIVE_FOOT, "Posts are picked by coin creators, not checked, and their authors may have nothing to do with these coins.");
});

test("14. the wording stays neutral: no line says why anything trades or what to do", () => {
  const lines = [CAPTION_OWN, familyCaption("$X"), moreCaption("$X"), NARRATIVE_FOOT, postStat({ coins: 2, usd24: 50 }), postStatTitle({ coins: 2, usd24: 50 }),
    siblingsLine(own(ID1)) ?? "", wordsLine([{ w: "a" }, { w: "b" }]), postLinkAria(post(ID1)), postLinkText(post(ID1, { state: "idle" }))];
  for (const l of lines) assert.doesNotMatch(l, /because|why|reason|driv|caus|thanks to|due to|moon|buy|sell|should|predict|expect/i, l);
});

test("15. anyWait: a row of the family, the own post or the parent's post still waits", () => {
  assert.equal(anyWait(body({ posts: [post(ID1), post(ID2, { state: "idle" })] })), false);
  assert.equal(anyWait(body({ posts: [post(ID1), post(ID2, { state: "wait" })] })), true);
  assert.equal(anyWait(body({ own: own(ID1, { state: "wait" }) })), true);
  assert.equal(anyWait(body({ under: { mint: MINT, name: null, symbol: null, post: post(ID1, { state: "wait" }) } })), true);
  assert.equal(anyWait(body()), false);
});

test("16. mergePoll: the rows shown keep their order, count and numbers; only state, handle and text come from the fresh body", () => {
  const shown = body({ pending: true, posts: [post(ID1, { state: "wait", handle: null, text: null, coins: 28, usd24: 100, top: [chip("A1")] }), post(ID2, { state: "ok", handle: "two", text: "second" })] });
  const fresh = body({
    asOf: 1_763_400_030, members: 999, linked: 998, words: [{ w: "new", n: 9 }, { w: "words", n: 9 }],
    // re-ranked, re-counted, one row more
    posts: [post(ID3, { text: "a newcomer" }), post(ID2, { state: "ok", handle: "two", text: "second", coins: 77 }), post(ID1, { state: "ok", handle: "one", text: "first", coins: 50, usd24: 9_999, at: 5, top: [chip("Z9")] })],
  });
  const out = mergePoll(shown, fresh);
  assert.deepEqual(out.posts.map((p) => p.id), [ID1, ID2], "no row moved, none added");
  assert.deepEqual([out.posts[0].state, out.posts[0].handle, out.posts[0].text], ["ok", "one", "first"]);
  assert.deepEqual([out.posts[0].coins, out.posts[0].usd24, out.posts[0].at, out.posts[0].top[0].mint], [28, 100, 1_762_850_000, "A1"], "the numbers on screen stay");
  assert.equal(out.posts[1].coins, 28);
  assert.deepEqual([out.asOf, out.members, out.linked, out.words], [shown.asOf, shown.members, shown.linked, shown.words]);
  assert.equal(out.pending, false, "nothing shown waits any more");
  // the inputs are not changed
  assert.equal(shown.posts[0].state, "wait");
  assert.equal(shown.pending, true);
});

test("17. mergePoll: a row the fresh body lacks stays in place and stops waiting; a known text it had stays", () => {
  const shown = body({ pending: true, posts: [post(ID1, { state: "wait", handle: null, text: null }), post(ID2, { state: "wait", handle: null, text: null }), post(ID3, { text: "third" })] });
  // the server dropped ID2 (its post turned out not to exist) and ID3 (out of the list), filled ID1 and lists a newcomer
  const out = mergePoll(shown, body({ posts: [post(ID1, { text: "first" }), post("1770000000000000003")] }));
  assert.deepEqual(out.posts.map((p) => [p.id, p.state]), [[ID1, "ok"], [ID2, "idle"], [ID3, "ok"]]);
  assert.deepEqual([out.posts[1].handle, out.posts[1].text, out.posts[1].coins], [null, null, 28]);
  assert.equal(out.posts[2].text, "third");
  assert.equal(out.pending, false, "nothing listed waits, so the asking ends");
  assert.equal(shown.posts[1].state, "wait", "the input is not changed");
  // a fresh body that still waits keeps waiting
  assert.equal(mergePoll(shown, body({ pending: true, posts: shown.posts })).pending, true);
  // a dropped row next to one that still waits: only the listed one keeps the poll going
  const half = mergePoll(shown, body({ pending: true, posts: [post(ID1, { state: "wait", handle: null, text: null })] }));
  assert.deepEqual(half.posts.map((p) => p.state), ["wait", "idle", "ok"]);
  assert.equal(half.pending, true);
  // the parent's post, dropped the same way
  const under = body({ mint: KID, pending: true, under: { mint: MINT, name: "NVIDIA", symbol: "NVDAx", post: post(ID2, { state: "wait", handle: null, text: null }) } });
  const u = mergePoll(under, body({ mint: KID }));
  assert.deepEqual([u.under?.post.id, u.under?.post.state, u.under?.symbol, u.pending], [ID2, "idle", "NVDAx", false]);
});

test("18. mergePoll: the own post and the parent's post are filled the same way; their other fields stay", () => {
  const shownOwn = body({ mint: KID, pending: true, own: own(ID1, { state: "wait", handle: null, text: null, siblings: 5 }), posts: [post(ID2)] });
  const a = mergePoll(shownOwn, body({ mint: KID, own: own(ID1, { text: "mine now", siblings: 9, top: [] }), posts: [post(ID2)] }));
  assert.deepEqual([a.own?.state, a.own?.handle, a.own?.text], ["ok", "tradfi", "mine now"]);
  assert.equal(a.own?.siblings, 5);
  assert.equal(a.own?.top.length, 1);
  assert.equal(a.pending, false);
  const under = (p: NarrativePost) => ({ mint: MINT, name: "NVIDIA", symbol: "NVDAx", post: p });
  const shownUnder = body({ mint: KID, pending: true, under: under(post(ID2, { state: "wait", handle: null, text: null })) });
  const b = mergePoll(shownUnder, body({ mint: KID, under: under(post(ID2, { state: "none", handle: null, text: null, coins: 1 })) }));
  assert.deepEqual([b.under?.post.state, b.under?.post.coins, b.under?.symbol], ["none", 28, "NVDAx"]);
  // an own post that the fresh body lists among the family posts instead is still found by id
  const c = mergePoll(shownOwn, body({ mint: KID, posts: [post(ID1, { handle: "viaposts", text: "from the list" })] }));
  assert.deepEqual([c.own?.state, c.own?.handle, c.own?.text], ["ok", "viaposts", "from the list"]);
});

test("19. mergePoll: no fresh body keeps what is shown; a body for another coin replaces it", () => {
  const shown = body({ pending: true, posts: [post(ID1, { state: "wait" })] });
  assert.equal(mergePoll(shown, null), shown);
  assert.equal(mergePoll(shown, undefined), shown);
  const other = body({ mint: KID, posts: [post(ID3)] });
  assert.equal(mergePoll(shown, other), other);
});

test("20. nextPollMs: 2.5 s, 5 s, 10 s, 20 s, then no more", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map((n) => nextPollMs(n)), [2_500, 5_000, 10_000, 20_000, null, null, null]);
  assert.equal(nextPollMs(-1), null);
});

test("21. settle: when the asking has ended every row still waiting reads as not fetched", () => {
  const n = body({ mint: KID, pending: true, posts: [post(ID1, { state: "wait", handle: null, text: null }), post(ID2)], own: own(ID3, { state: "wait", handle: null, text: null }),
    under: { mint: MINT, name: null, symbol: null, post: post(ID2, { state: "wait" }) } });
  const s = settle(n);
  assert.deepEqual(s.posts.map((p) => p.state), ["idle", "ok"]);
  assert.equal(s.own?.state, "idle");
  assert.equal(s.under?.post.state, "idle");
  assert.equal(s.pending, false);
  assert.equal(anyWait(s), false);
  assert.equal(s.posts[1].text, "hello", "a known text stays");
  assert.equal(n.posts[0].state, "wait", "the input is not changed");
  assert.equal(postLinkText(s.posts[0]), "View post ↗");
});

test("22. the whole ladder: four asks that never bring the text end in a settled body", () => {
  let cur = body({ pending: true, posts: [post(ID1, { state: "wait", handle: null, text: null })] });
  let tries = 0, waited = 0;
  for (;;) {
    const ms = nextPollMs(tries);
    if (ms === null) { cur = settle(cur); break; }
    waited += ms; tries++;
    cur = mergePoll(cur, body({ pending: true, posts: [post(ID1, { state: "wait", handle: null, text: null })] }));
    assert.equal(cur.pending, true);
  }
  assert.equal(tries, 4);
  assert.equal(waited, 37_500);
  assert.equal(cur.pending, false);
  assert.equal(cur.posts[0].state, "idle");
});

test("23. a post the server drops between asks ends the ladder early instead of waiting it out", () => {
  let cur = body({ pending: true, posts: [post(ID1, { state: "wait", handle: null, text: null }), post(ID2)] });
  let tries = 0, waited = 0;
  while (cur.pending) {
    const ms = nextPollMs(tries);
    if (ms === null) { cur = settle(cur); break; }
    waited += ms; tries++;
    // from the first ask on the server lists ID2 and the next post, not ID1
    cur = mergePoll(cur, body({ posts: [post(ID2), post(ID3)] }));
  }
  assert.deepEqual([tries, waited], [1, 2_500]);
  assert.deepEqual(cur.posts.map((p) => [p.id, p.state]), [[ID1, "idle"], [ID2, "ok"]]);
  assert.equal(postLinkText(cur.posts[0]), "View post ↗");
});

test("24. shownAnswer: only the selected coin's answer is shown; one for a coin left behind changes nothing", () => {
  type Got = { mint: string | null; data: Narrative | null };
  const A: Got = { mint: MINT, data: body({ posts: [post(ID1)] }) }, B: Got = { mint: KID, data: body({ mint: KID, posts: [post(ID2)] }) };
  const C = "Ccc1111111111111111111111111111111111111111", none: Got = { mint: null, data: null };
  // the first answer for the selected coin
  assert.equal(shownAnswer(none, A, MINT), A);
  // B selected, its answer not in yet: A stays (the caller dims it, its mint is not the selected one)
  assert.equal(shownAnswer(A, A, KID), A);
  assert.equal(shownAnswer(A, B, KID), B);
  // a walk A -> B -> C: B's answer lands while C is selected and is not shown, whether it has posts or is a 404
  assert.equal(shownAnswer(A, B, C), A);
  assert.equal(shownAnswer(A, { mint: KID, data: null }, C), A, "the block is not removed by another coin's 404");
  // A -> B -> back to A before B answers: A's block stays as it is
  assert.equal(shownAnswer(A, B, MINT), A);
  // back on B with its answer already in: shown at once
  assert.equal(shownAnswer(A, B, KID), B);
  // the selected coin's own 404 removes the block; so does no selection once that is what was last asked
  const gone: Got = { mint: KID, data: null };
  assert.equal(shownAnswer(A, gone, KID), gone);
  assert.equal(shownAnswer(A, none, null), none);
  // a later answer for the same coin (a poll) replaces the earlier one
  const A2: Got = { mint: MINT, data: body({ posts: [post(ID1, { text: "filled" })] }) };
  assert.equal(shownAnswer(A, A2, MINT), A2);
});

test("25. api.narrative: one GET of /api/narrative/<mint>; a 404 rejects, so the hook's catch shows nothing", async () => {
  const urls: string[] = [], was = globalThis.fetch;
  let status = 200;
  globalThis.fetch = (async (url: string) => { urls.push(url); return new Response(JSON.stringify(status === 200 ? body() : { error: "unknown mint" }), { status, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const n = await api.narrative(MINT);
    assert.equal(n.mint, MINT);
    assert.deepEqual(urls, [`/api/narrative/${MINT}`]);
    await api.narrative("a/b?c");
    assert.equal(urls[1], "/api/narrative/a%2Fb%3Fc");
    status = 404;
    await assert.rejects(api.narrative(MINT), /unknown mint/);
    assert.equal(await api.narrative(MINT).catch(() => null), null);
    assert.equal(urls.length, 4, "a 404 is not retried");
  } finally { globalThis.fetch = was; }
});
