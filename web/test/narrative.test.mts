// Launch timeline (web/src/lib/narrative.ts): the link rebuilt from a post id, the words of one line, which lines show
// and what follows them, what a coin's block shows, how a later answer is laid over the lines on screen and when
// asking stops. No DOM, no network (a fake fetch for the one request).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Narrative, NarrativeCoin, NarrativeEvent, NarrativeOwn } from "../src/lib/api.ts";
const { safePostUrl, postHandle, postText, POST_LINK, postLinkAria, chipSym, chipVol, chipText, lineAge, lineParts, lineText, lineChip, shownLines, moreText, earlierNote,
  othersLine, narrativeView, CAPTION_TIMELINE, CAPTION_OWN, NARRATIVE_FOOT, anyWait, mergePoll, nextPollMs, settle, shownAnswer, heldLines } = await import("../src/lib/narrative.ts");
const { api } = await import("../src/lib/api.ts");

const MINT = "Par1111111111111111111111111111111111111111";
const KID = "Kid1111111111111111111111111111111111111111";
const ID1 = "2120644813917925721", ID2 = "1990000000000000001", ID3 = "1880000000000000002";
const chip = (mint: string, o: Partial<NarrativeCoin> = {}): NarrativeCoin => ({ mint, name: "Jensen", symbol: "JENSEN", image: null, usd24: 1200, ...o });
const event = (id: string, o: Partial<NarrativeEvent> = {}): NarrativeEvent =>
  ({ id, url: `https://x.com/i/status/${id}`, at: 1_762_850_000, lastAt: 1_762_850_600, postAt: 1_762_849_000, coins: 28, usd24: 12_345.6, state: "ok", handle: "tradfi", text: "hello", top: [chip("A1")], ...o });
const own = (id: string, o: Partial<NarrativeOwn> = {}): NarrativeOwn =>
  ({ id, url: `https://x.com/i/status/${id}`, at: 1_762_850_000, state: "ok", handle: "tradfi", text: "mine", siblings: 5, top: [chip("S1")], parent: { mint: MINT, name: "NVIDIA", symbol: "NVDAx" }, ...o });
const body = (o: Partial<Narrative> = {}): Narrative => ({ mint: MINT, asOf: 1_763_400_000, members: 334, linked: 279, events: [], earlier: 0, own: null, under: null, pending: false, ...o });
const waiting = { state: "wait", handle: null, text: null } as const;

test("1. safePostUrl: the link is built from the digits; anything that is not a post id gives null", () => {
  assert.equal(safePostUrl(ID1), `https://x.com/i/status/${ID1}`);
  assert.equal(safePostUrl("1"), "https://x.com/i/status/1");
  assert.equal(safePostUrl("9".repeat(19)), `https://x.com/i/status/${"9".repeat(19)}`);
  for (const bad of ["", "0", "0123", "1".repeat(20), "12a", " 12", "12 ", "12\n", "-12", "1.5", "1e5", "١٢٣", "12/../../intent/post", "12?x=1", "12#a", "javascript:alert(1)", "https://x.com/i/status/12", null, undefined, 12, 12n, {}, ["12"]]) {
    assert.equal(safePostUrl(bad), null, `not an id: ${String(bad)}`);
  }
});

test("2. postHandle: the author only with a known text and a handle-shaped handle", () => {
  assert.equal(postHandle(event(ID1)), "tradfi");
  assert.equal(postHandle(event(ID1, { handle: "a_B9" })), "a_B9");
  // a state other than "ok" never shows a handle, whatever the body carries
  for (const state of ["wait", "none", "idle"] as const) assert.equal(postHandle(event(ID1, { state })), null);
  for (const handle of [null, "", "has space", "sixteen_chars_xx", "<b>x</b>", "a/b", "@a", "é"]) assert.equal(postHandle(event(ID1, { handle })), null, `not a handle: ${handle}`);
  assert.equal(postHandle(event(ID1, { handle: 7 as unknown as string })), null);
});

test("3. the link out of an opened line: plain words, and a spoken name saying how many coins link the post", () => {
  assert.equal(POST_LINK, "View post ↗");
  assert.equal(postLinkAria(28), "View the post on X, linked by 28 coins");
  assert.equal(postLinkAria(1), "View the post on X, linked by 1 coin");
  for (const n of [null, undefined, 0, -1]) assert.equal(postLinkAria(n), "View the post on X");
});

test("4. postText: only a known text; markup stays text for the caller to render as text, line breaks read as one space", () => {
  assert.equal(postText(event(ID1, { text: "a <b>b</b> &amp;" })), "a <b>b</b> &amp;");
  assert.equal(postText(event(ID1, { text: "NVIDIA to announce X\n\nJensen said the new chips" })), "NVIDIA to announce X Jensen said the new chips");
  assert.equal(postText(event(ID1, { text: "one\ntwo" })), "one two");
  assert.equal(postText(event(ID1, { text: "one \n \n\t two\n\nthree" })), "one two three", "blanks around a break do not add up");
  assert.equal(postText(event(ID1, { text: "  padded \n" })), "padded");
  assert.equal(postText(event(ID1, { text: "" })), "", "a media-only post");
  assert.equal(postText(event(ID1, { text: null })), "");
  for (const state of ["wait", "none", "idle"] as const) assert.equal(postText(event(ID1, { state, text: "left over" })), "");
});

test("5. a coin chip: ticker and 24 h volume, the volume left out under $1", () => {
  assert.equal(chipSym(chip("A1")), "$JENSEN");
  assert.equal(chipVol(chip("A1")), "$1.2K");
  assert.equal(chipText(chip("A1")), "$JENSEN $1.2K");
  assert.equal(chipVol(chip("A1", { usd24: 0.4 })), null);
  assert.equal(chipText(chip("A1", { usd24: 0 })), "$JENSEN");
  assert.equal(chipSym(chip("Abcdefghijklmnop", { symbol: null })), "Abcd…mnop", "no ticker: the short mint");
});

test("6. lineAge: the app's short age (\"5m\"), nothing for an unknown time", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(lineAge(now - 5 * 60 - 3), "5m");
  assert.equal(lineAge(now - 2 * 3600 - 10), "2h");
  assert.equal(lineAge(now - 3 * 86400 - 10), "3d");
  assert.match(lineAge(now - 20), /^\d+s$/);
  for (const at of [null, undefined, NaN]) assert.equal(lineAge(at), "");
});

test("7. one line: the coin count always, the author and the text once known", () => {
  assert.deepEqual(lineParts(event(ID1, { coins: 3, text: "NVIDIA to announce\n\nmore" })), { lead: "3 coins", handle: "@tradfi", text: "NVIDIA to announce more" });
  assert.equal(lineText(event(ID1, { coins: 3, text: "NVIDIA to announce" })), "3 coins · @tradfi · NVIDIA to announce");
  assert.equal(lineText(event(ID1, { coins: 1 })), "1 coin · @tradfi · hello");
  // while the text is fetched, or when it is not there: the count alone, so the line reads the same height either way
  for (const state of ["wait", "idle", "none"] as const) {
    assert.deepEqual(lineParts(event(ID1, { coins: 3, state, handle: "leftover", text: "left over" })), { lead: "3 coins", handle: null, text: "" });
    assert.equal(lineText(event(ID1, { coins: 3, state })), "3 coins");
  }
  // a media-only post: the count and the author
  assert.equal(lineText(event(ID1, { coins: 2, text: "" })), "2 coins · @tradfi");
  assert.equal(lineText(event(ID1, { coins: 1234 })), "1,234 coins · @tradfi · hello");
});

test("8. a coin's own post as a line: no count; with nothing known it still says what it is", () => {
  assert.deepEqual(lineParts(own(ID1)), { lead: null, handle: "@tradfi", text: "mine" });
  assert.equal(lineText(own(ID1)), "@tradfi · mine");
  assert.equal(lineText(own(ID1, { text: "" })), "@tradfi");
  assert.equal(lineText(own(ID1, waiting)), "Linked post");
  assert.equal(lineText(own(ID1, { state: "ok", handle: "not a handle", text: "" })), "Linked post");
});

test("9. lineChip: the first of an event's top coins, none for an empty or missing list", () => {
  assert.equal(lineChip(event(ID1, { top: [chip("B2"), chip("A1")] }))?.mint, "B2");
  assert.equal(lineChip(event(ID1, { top: [] })), null);
  assert.equal(lineChip({ top: undefined as unknown as NarrativeCoin[] }), null);
});

test("10. shownLines: the first few collapsed, all once opened, and how many the button adds", () => {
  const ev = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(shownLines(ev, 3, false), { lines: [1, 2, 3], more: 4 });
  assert.deepEqual(shownLines(ev, 5, false), { lines: [1, 2, 3, 4, 5], more: 2 });
  assert.deepEqual(shownLines(ev, 3, true), { lines: ev, more: 0 });
  assert.deepEqual(shownLines([1, 2, 3], 3, false), { lines: [1, 2, 3], more: 0 }, "nothing behind a button");
  assert.deepEqual(shownLines([], 3, false), { lines: [], more: 0 });
  // the order is the server's (newest first): nothing is sorted or dropped here
  assert.deepEqual(shownLines([9, 1, 5], 2, false).lines, [9, 1]);
  // a nonsense count still shows one line
  assert.deepEqual(shownLines(ev, 0, false), { lines: [1], more: 6 });
  assert.notEqual(shownLines(ev, 3, true).lines, ev, "a copy: the input is not handed out");
});

test("11. the button and the notes after the list", () => {
  assert.equal(moreText(4), "Show 4 more");
  assert.equal(moreText(1), "Show 1 more");
  assert.equal(earlierNote(14), "14 earlier events");
  assert.equal(earlierNote(1), "1 earlier event");
  for (const n of [0, -2, null, undefined, NaN, 0.4]) assert.equal(earlierNote(n), null);
  assert.equal(othersLine(own(ID1, { siblings: 5 })), "5 other coins link this post");
  assert.equal(othersLine(own(ID1, { siblings: 1 })), "1 other coin links this post");
  assert.equal(othersLine(own(ID1, { siblings: 0 })), null);
  assert.equal(othersLine(own(ID1, { siblings: null, parent: null })), null);
  assert.equal(othersLine(null), null);
  assert.equal(CAPTION_TIMELINE, "Launch timeline");
  assert.equal(NARRATIVE_FOOT, "Posts are picked by coin creators and aren't checked.");
});

test("12. narrativeView: a parent's events as they came, with the count of those not listed", () => {
  const v = narrativeView(body({ events: [event(ID1), event(ID2), event(ID3)], earlier: 14 }));
  assert.deepEqual(v.events.map((e) => e.id), [ID1, ID2, ID3]);
  assert.deepEqual([v.earlier, v.own, v.under, v.empty], [14, null, null, false]);
  assert.equal(narrativeView(body({ events: [event(ID1)], earlier: -3 })).earlier, 0);
  assert.equal(narrativeView(body({ events: [event(ID1)], earlier: undefined as unknown as number })).earlier, 0);
});

test("13. narrativeView: a coin's own post; its parent's newest event only when it has neither a post nor events", () => {
  const under = { mint: MINT, name: "NVIDIA", symbol: "NVDAx", event: event(ID2) };
  const a = narrativeView(body({ mint: KID, own: own(ID1), under }));
  assert.equal(a.own?.id, ID1);
  assert.equal(a.under, null, "the own post is shown, not the parent's event as well");
  const b = narrativeView(body({ mint: KID, under }));
  assert.deepEqual([b.under?.event.id, b.under?.parent.symbol, b.under?.parent.mint, b.empty], [ID2, "NVDAx", MINT, false]);
  const c = narrativeView(body({ mint: KID, events: [event(ID3)], under }));
  assert.equal(c.under, null, "a coin with events of its own shows those");
  // a coin that is both: its own post and the timeline of the coins under it
  const d = narrativeView(body({ mint: KID, own: own(ID1), events: [event(ID2)] }));
  assert.deepEqual([d.own?.id, d.events.length, d.empty], [ID1, 1, false]);
});

test("14. narrativeView: nothing to show is empty, whatever shape the body has", () => {
  for (const n of [null, undefined, body(), body({ events: undefined as unknown as NarrativeEvent[] }), { mint: MINT } as unknown as Narrative,
    // a body of the old shape (posts, under.post) has nothing this view shows
    { ...body(), posts: [event(ID1)], under: { mint: MINT, name: null, symbol: null, post: event(ID1) } } as unknown as Narrative]) {
    const v = narrativeView(n);
    assert.deepEqual([v.empty, v.events.length, v.own, v.under, v.earlier], [true, 0, null, null, 0]);
  }
});

test("15. the wording stays neutral: no line says why anything trades or what to do", () => {
  const lines = [CAPTION_TIMELINE, CAPTION_OWN, NARRATIVE_FOOT, POST_LINK, postLinkAria(2), lineText(event(ID1, waiting)), lineText(own(ID1, waiting)), moreText(3), earlierNote(3) ?? "",
    othersLine(own(ID1)) ?? "", chipText(chip("A1"))];
  for (const l of lines) assert.doesNotMatch(l, /because|why|reason|driv|caus|thanks to|due to|moon|buy|sell|should|predict|expect|will/i, l);
});

test("16. anyWait: a line of the timeline, the own post or the parent's event still waits", () => {
  assert.equal(anyWait(body({ events: [event(ID1), event(ID2, { state: "idle" })] })), false);
  assert.equal(anyWait(body({ events: [event(ID1), event(ID2, { state: "wait" })] })), true);
  assert.equal(anyWait(body({ own: own(ID1, { state: "wait" }) })), true);
  assert.equal(anyWait(body({ under: { mint: MINT, name: null, symbol: null, event: event(ID1, { state: "wait" }) } })), true);
  assert.equal(anyWait(body()), false);
});

test("17. mergePoll: the lines shown keep their order, count and numbers; only state, handle and text come from the fresh body", () => {
  const shown = body({ pending: true, earlier: 2, events: [event(ID1, { ...waiting, coins: 28, usd24: 100, top: [chip("A1")] }), event(ID2, { state: "ok", handle: "two", text: "second" })] });
  const fresh = body({
    asOf: 1_763_400_030, members: 999, linked: 998, earlier: 9,
    // a newer event on top, the others re-counted
    events: [event(ID3, { text: "a newcomer", at: 1_762_860_000 }), event(ID1, { state: "ok", handle: "one", text: "first", coins: 50, usd24: 9_999, at: 5, lastAt: 6, top: [chip("Z9")] }), event(ID2, { state: "ok", handle: "two", text: "second", coins: 77 })],
  });
  const out = mergePoll(shown, fresh);
  assert.deepEqual(out.events.map((p) => p.id), [ID1, ID2], "no line moved, none added");
  assert.deepEqual([out.events[0].state, out.events[0].handle, out.events[0].text], ["ok", "one", "first"]);
  assert.deepEqual([out.events[0].coins, out.events[0].usd24, out.events[0].at, out.events[0].lastAt, out.events[0].top[0].mint], [28, 100, 1_762_850_000, 1_762_850_600, "A1"], "the numbers on screen stay");
  assert.equal(out.events[1].coins, 28);
  assert.deepEqual([out.asOf, out.members, out.linked, out.earlier], [shown.asOf, shown.members, shown.linked, 2]);
  assert.equal(out.pending, false, "nothing shown waits any more");
  // the inputs are not changed
  assert.equal(shown.events[0].state, "wait");
  assert.equal(shown.pending, true);
});

test("18. mergePoll: a line the fresh body lacks stays in place and stops waiting; a known text it had stays", () => {
  const shown = body({ pending: true, events: [event(ID1, waiting), event(ID2, waiting), event(ID3, { text: "third" })] });
  // the server dropped ID2 (its post turned out not to exist) and ID3 (out of the list), filled ID1 and lists a newcomer
  const out = mergePoll(shown, body({ events: [event("1770000000000000003"), event(ID1, { text: "first" })] }));
  assert.deepEqual(out.events.map((p) => [p.id, p.state]), [[ID1, "ok"], [ID2, "idle"], [ID3, "ok"]]);
  assert.deepEqual([out.events[1].handle, out.events[1].text, out.events[1].coins], [null, null, 28]);
  assert.equal(out.events[2].text, "third");
  assert.equal(out.pending, false, "nothing listed waits, so the asking ends");
  assert.equal(shown.events[1].state, "wait", "the input is not changed");
  // a fresh body that still waits keeps waiting
  assert.equal(mergePoll(shown, body({ pending: true, events: shown.events })).pending, true);
  // a dropped line next to one that still waits: only the listed one keeps the poll going
  const half = mergePoll(shown, body({ pending: true, events: [event(ID1, waiting)] }));
  assert.deepEqual(half.events.map((p) => p.state), ["wait", "idle", "ok"]);
  assert.equal(half.pending, true);
  // the parent's event, dropped the same way
  const under = body({ mint: KID, pending: true, under: { mint: MINT, name: "NVIDIA", symbol: "NVDAx", event: event(ID2, waiting) } });
  const u = mergePoll(under, body({ mint: KID }));
  assert.deepEqual([u.under?.event.id, u.under?.event.state, u.under?.symbol, u.pending], [ID2, "idle", "NVDAx", false]);
});

test("19. mergePoll: the own post and the parent's event are filled the same way; their other fields stay", () => {
  const shownOwn = body({ mint: KID, pending: true, own: own(ID1, { ...waiting, siblings: 5 }), events: [event(ID2)] });
  const a = mergePoll(shownOwn, body({ mint: KID, own: own(ID1, { text: "mine now", siblings: 9, top: [] }), events: [event(ID2)] }));
  assert.deepEqual([a.own?.state, a.own?.handle, a.own?.text], ["ok", "tradfi", "mine now"]);
  assert.equal(a.own?.siblings, 5);
  assert.equal(a.own?.top.length, 1);
  assert.equal(a.pending, false);
  const under = (p: NarrativeEvent) => ({ mint: MINT, name: "NVIDIA", symbol: "NVDAx", event: p });
  const shownUnder = body({ mint: KID, pending: true, under: under(event(ID2, waiting)) });
  const b = mergePoll(shownUnder, body({ mint: KID, under: under(event(ID2, { state: "none", handle: null, text: null, coins: 1 })) }));
  assert.deepEqual([b.under?.event.state, b.under?.event.coins, b.under?.symbol], ["none", 28, "NVDAx"]);
  // an own post that the fresh body lists among the events instead is still found by id
  const c = mergePoll(shownOwn, body({ mint: KID, events: [event(ID1, { handle: "viaevents", text: "from the list" })] }));
  assert.deepEqual([c.own?.state, c.own?.handle, c.own?.text], ["ok", "viaevents", "from the list"]);
});

test("20. mergePoll: no fresh body keeps what is shown; a body for another coin replaces it", () => {
  const shown = body({ pending: true, events: [event(ID1, { state: "wait" })] });
  assert.equal(mergePoll(shown, null), shown);
  assert.equal(mergePoll(shown, undefined), shown);
  const other = body({ mint: KID, events: [event(ID3)] });
  assert.equal(mergePoll(shown, other), other);
});

test("22. nextPollMs: 2.5 s, 5 s, 10 s, 20 s, then no more", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map((n) => nextPollMs(n)), [2_500, 5_000, 10_000, 20_000, null, null, null]);
  assert.equal(nextPollMs(-1), null);
});

test("23. settle: when the asking has ended every line still waiting reads as not fetched", () => {
  const n = body({ mint: KID, pending: true, events: [event(ID1, waiting), event(ID2)], own: own(ID3, waiting),
    under: { mint: MINT, name: null, symbol: null, event: event(ID2, { state: "wait" }) } });
  const s = settle(n);
  assert.deepEqual(s.events.map((p) => p.state), ["idle", "ok"]);
  assert.equal(s.own?.state, "idle");
  assert.equal(s.under?.event.state, "idle");
  assert.equal(s.pending, false);
  assert.equal(anyWait(s), false);
  assert.equal(s.events[1].text, "hello", "a known text stays");
  assert.equal(n.events[0].state, "wait", "the input is not changed");
  assert.equal(lineText(s.events[0]), "28 coins");
});

test("24. the whole ladder: four asks that never bring the text end in a settled body", () => {
  let cur = body({ pending: true, events: [event(ID1, waiting)] });
  let tries = 0, waited = 0;
  for (;;) {
    const ms = nextPollMs(tries);
    if (ms === null) { cur = settle(cur); break; }
    waited += ms; tries++;
    cur = mergePoll(cur, body({ pending: true, events: [event(ID1, waiting)] }));
    assert.equal(cur.pending, true);
  }
  assert.equal(tries, 4);
  assert.equal(waited, 37_500);
  assert.equal(cur.pending, false);
  assert.equal(cur.events[0].state, "idle");
});

test("25. a post the server drops between asks ends the ladder early instead of waiting it out", () => {
  let cur = body({ pending: true, events: [event(ID1, waiting), event(ID2)] });
  let tries = 0, waited = 0;
  while (cur.pending) {
    const ms = nextPollMs(tries);
    if (ms === null) { cur = settle(cur); break; }
    waited += ms; tries++;
    // from the first ask on the server lists ID2 and the next event, not ID1
    cur = mergePoll(cur, body({ events: [event(ID3), event(ID2)] }));
  }
  assert.deepEqual([tries, waited], [1, 2_500]);
  assert.deepEqual(cur.events.map((p) => [p.id, p.state]), [[ID1, "idle"], [ID2, "ok"]]);
});

test("26. shownAnswer: only the selected coin's answer is shown; one for a coin left behind changes nothing", () => {
  type Got = { mint: string | null; data: Narrative | null };
  const A: Got = { mint: MINT, data: body({ events: [event(ID1)] }) }, B: Got = { mint: KID, data: body({ mint: KID, events: [event(ID2)] }) };
  const C = "Ccc1111111111111111111111111111111111111111", none: Got = { mint: null, data: null };
  // the first answer for the selected coin
  assert.equal(shownAnswer(none, A, MINT), A);
  // B selected, its answer not in yet: A stays (the caller dims it, its mint is not the selected one)
  assert.equal(shownAnswer(A, A, KID), A);
  assert.equal(shownAnswer(A, B, KID), B);
  // a walk A -> B -> C: B's answer lands while C is selected and is not shown, whether it has events or is a 404
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
  const A2: Got = { mint: MINT, data: body({ events: [event(ID1, { text: "filled" })] }) };
  assert.equal(shownAnswer(A, A2, MINT), A2);
});

test("27. api.narrative: one GET of /api/narrative/<mint>; a 404 rejects, so the hook's catch shows nothing", async () => {
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

test("28. heldLines: a list in use takes no new line; the lines on screen keep their places and take the new read", () => {
  const a = event(ID1), b = event(ID2), c = event(ID3), NEW = "1990000000000000004";
  const shown = [a, b, c];
  // not held: the new read as it is, a copy
  const fresh = [event(NEW), { ...a, coins: 9 }, b, c];
  assert.deepEqual(heldLines(fresh, null).map((e) => e.id), [NEW, ID1, ID2, ID3]);
  assert.notEqual(heldLines(fresh, null), fresh);
  // held: the new event on top is kept back, so the line under the pointer stays where it is; the numbers are fresh
  const held = heldLines(fresh, shown);
  assert.deepEqual(held.map((e) => [e.id, e.coins]), [[ID1, 9], [ID2, b.coins], [ID3, c.coins]]);
  // a line the new read lacks keeps what it showed (the open line does not close under its reader)
  assert.deepEqual(heldLines([event(NEW), a, b], shown), [a, b, c]);
  // a text that came in meanwhile fills in
  const txt = heldLines([{ ...a, state: "ok" as const, handle: "tradfi", text: "NVIDIA to announce" }], [{ ...a, state: "wait" as const, text: null }, b]);
  assert.deepEqual([txt[0].state, txt[0].text, txt[1]], ["ok", "NVIDIA to announce", b]);
  // the hold over: every new line is there
  assert.deepEqual(heldLines(fresh, undefined).map((e) => e.id), [NEW, ID1, ID2, ID3]);
  assert.deepEqual(heldLines([], shown), shown, "an empty read in use removes nothing");
  assert.deepEqual(heldLines(fresh, []), [], "held before anything was drawn: nothing to keep");
});
