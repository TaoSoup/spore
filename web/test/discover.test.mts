// The Discover page, the map panel's "Moving now" block and the wake-up alerts (web/src/lib/discover.ts): the words of
// a card, the sparkline, the order after a read (held while the list is in use), and the alert switch and de-dup.
// No DOM, no network (a fake fetch for the two requests).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Discover, DiscoverOne, WakeCoin, WakeEvent, WakeFamily, WakePost } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");
const { api } = await import("../src/lib/api.ts");

const NOW = 1_763_500_000;
const P1 = "Par1111111111111111111111111111111111111111", P2 = "Par2222222222222222222222222222222222222222", P3 = "Par3333333333333333333333333333333333333333";
const coin = (mint: string, o: Partial<WakeCoin> = {}): WakeCoin => ({ mint, name: "Jensen", symbol: "JENSEN", image: null, createdAt: NOW - 3 * 86400, existing: true, mcapUsd: 120_000, sinceStart: 1.61, buyers5m: 90, copyOf: null, ...o });
const post = (o: Partial<WakePost> = {}): WakePost => ({ id: "1990000000000000001", url: "https://evil.example/x", at: NOW - 6 * 60, handle: "nvidia", text: "Jensen on stage\nagain", state: "ok", coins: 4, ...o });
const fam = (mint: string, o: Partial<WakeFamily> = {}): WakeFamily => ({
  parent: { mint, name: "NVIDIA", symbol: "NVDAx", image: null, isCoin: false }, startedAt: NOW - 4 * 60, state: "live", ratio: 14.2, peakRatio: 14.2,
  buyers5m: 170, trades5m: 570, spark: [...new Array(22).fill(4), 60, 170], baseline: 12.3, coinsTrading: 12, post: post(), coins: [coin("K1")], more: 8, hidden: 23, ...o,
});
const body = (families: WakeFamily[]): Discover => ({ asOf: NOW, bucketS: 300, families });

test("1. minAgo and the pill: just now, minutes, hours; cooling says so", () => {
  assert.deepEqual([NOW, NOW - 59, NOW - 60, NOW - 4 * 60 - 30, NOW - 59 * 60, NOW - 80 * 60, NOW - 120 * 60, NOW - 200 * 60, NOW + 30].map((t) => D.minAgo(t, NOW)),
    ["just now", "just now", "1 min ago", "4 min ago", "59 min ago", "1 h 20 min ago", "2 h ago", "3 h ago", "just now"]);
  assert.equal(D.minAgo(null, NOW), "");
  assert.equal(D.startedText(fam(P1), NOW), "Started 4 min ago");
  assert.equal(D.startedText(fam(P1, { state: "cooling", startedAt: NOW - 50 * 60 }), NOW), "Started 50 min ago · cooling");
  assert.equal(D.AGO_TICK_MS, 15_000);
  assert.equal(D.DISCOVER_POLL_MS, 10_000);
});

test("2. ratioX and the measured line, live and cooling", () => {
  assert.deepEqual([14.2, 10, 9.96, 5, 5.2, 3.04, 1234.4, 0, -1, NaN, null].map((r) => D.ratioX(r as number)), ["14x", "10x", "10x", "5x", "5.2x", "3x", "1,234x", "—", "—", "—", "—"]);
  assert.equal(D.ratioLine(fam(P1)), "Buying 14x its normal · 170 buyers in 5 min · 12 coins trading");
  assert.equal(D.ratioLine(fam(P1, { ratio: 5.04, buyers5m: 1, coinsTrading: 1 })), "Buying 5x its normal · 1 buyer in 5 min · 1 coin trading");
  assert.equal(D.ratioLine(fam(P1, { state: "cooling", ratio: 2.1, peakRatio: 14.2 })), "Buying 2.1x its normal, down from 14x");
  // no trade in the latest bucket (ratio 0): never "Buying — its normal"
  assert.equal(D.ratioLine(fam(P1, { state: "cooling", ratio: 0, peakRatio: 14.2 })), "No buying in the last 5 min, down from 14x");
  assert.equal(D.ratioLine(fam(P1, { ratio: 0, peakRatio: 30 })), "No buying in the last 5 min, down from 30x");
});

test("3. sinceStart: +61% up, a fall down, about 0 flat; a new coin \"new\" whatever is sent, an existing one without a start price \"—\"", () => {
  assert.deepEqual(D.sinceStart(1.61), { text: "+61%", tone: "up" });
  assert.deepEqual(D.sinceStart(1.042), { text: "+4.2%", tone: "up" });
  assert.deepEqual(D.sinceStart(0.62), { text: "−38%", tone: "down" });
  assert.deepEqual(D.sinceStart(0.95), { text: "−5%", tone: "down" });
  assert.deepEqual(D.sinceStart(1.003), { text: "0%", tone: "flat" });
  assert.deepEqual(D.sinceStart(12.5), { text: "+1,150%", tone: "up" });
  for (const x of [null, undefined, NaN, 0, -2]) assert.deepEqual(D.sinceStart(x as number), { text: "—", tone: "flat" });
  // a new coin measured from its first trade would count its own launch buy (+1,046%): always "new"
  for (const x of [null, 11.46, 0.5]) assert.deepEqual(D.sinceStart(x, false), { text: "new", tone: "new" });
  assert.deepEqual(D.sinceStart(1.61, true), { text: "+61%", tone: "up" });
});

test("4. ordinal, the copy line under a new coin, and the tag", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(D.ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th", "112th"]);
  assert.equal(D.copyLine({ existing: false, copyOf: 5 }), "6th copy of this post");
  assert.equal(D.copyLine({ existing: false, copyOf: 1 }), "2nd copy of this post");
  assert.equal(D.copyLine({ existing: false, copyOf: 0 }), null, "the first coin linking a post is no copy");
  assert.equal(D.copyLine({ existing: false, copyOf: null }), null);
  assert.equal(D.copyLine({ existing: true, copyOf: 5 }), null, "an existing coin is never called a copy");
  assert.equal(D.coinTag({ existing: true }), "existing");
  assert.equal(D.coinTag({ existing: false }), "new");
});

test("5. footLine: each part only when not 0", () => {
  assert.equal(D.footLine(8, 23), "8 more trading · 23 hidden: creator sold out or repeat launch");
  assert.equal(D.footLine(8, 0), "8 more trading");
  assert.equal(D.footLine(0, 1), "1 hidden: creator sold out or repeat launch");
  assert.equal(D.footLine(0, 0), null);
  assert.equal(D.footLine(null, undefined), null);
  assert.equal(D.footLine(2.7, -1), "2 more trading");
});

test("6. postLine: the link is rebuilt from the id, the text is one line, a post without text says how many coins link it", () => {
  const l = D.postLine(post(), NOW);
  assert.deepEqual(l, { href: "https://x.com/i/status/1990000000000000001", handle: "@nvidia", ago: "6 min ago", text: "Jensen on stage again", fallback: "Post linked by 4 coins",
    body: "Linked post · @nvidia · 6 min ago · Jensen on stage again" });
  const waiting = D.postLine(post({ state: "wait", handle: null, text: null, coins: 2 }), NOW);
  assert.deepEqual([waiting.handle, waiting.text, waiting.fallback, waiting.body], [null, "", "Post linked by 2 coins", "Post linked by 2 coins"]);
  // the line on screen always says the coins link it (a phone has no hover for the note)
  assert.equal(D.postLine(post({ handle: null }), NOW).body, "Linked post · 6 min ago · Jensen on stage again");
  assert.equal(D.postLine(post({ id: "javascript:alert(1)" }), NOW).href, null, "a bad id gets no link");
  assert.equal(D.postLine(post({ handle: "not a handle!" }), NOW).handle, null);
});

test("7. sparkGeom and its words: 24 points oldest first, the band at the normal level", () => {
  const g = D.sparkGeom([3, 170], 10, 240, 40);
  assert.equal(g.values.length, 24);
  assert.deepEqual(g.values.slice(-3), [0, 3, 170], "padded on the old side");
  assert.equal(g.points.split(" ").length, 24);
  assert.equal(g.last.y, 2, "the peak touches the top padding");
  assert.ok(g.bandY > 30 && g.bandY < 38, `the band is low: ${g.bandY}`);
  // a quiet family: the line does not fill the box (top = 1.25 x baseline)
  const q = D.sparkGeom(new Array(24).fill(10), 10, 240, 40);
  assert.ok(q.last.y > 8, `${q.last.y}`);
  assert.equal(q.last.y, q.bandY);
  assert.deepEqual(D.sparkGeom(null, null, 100, 20).values, new Array(24).fill(0));
  assert.deepEqual(D.sparkGeom([1.9, -4, "7", NaN], 0, 100, 20).values.slice(-4), [1, 0, 0, 0]);
  assert.equal(D.sparkLabel(fam(P1)), "Buyers per 5 minutes over the last 2 hours: 170 in the last complete 5 min, at most 170, 4 two hours ago; normal is about 12");
  assert.match(D.sparkLabel(fam(P1, { baseline: 3.46 })), /normal is about 3.5$/);
});

test("8. familyRows idle: the server's order; broken or repeated entries make no card", () => {
  const rows = D.familyRows(body([fam(P2), fam(P1), fam(P3)]), [fam(P1), fam(P2)]);
  assert.deepEqual(rows.map((r) => r.parent.mint), [P2, P1, P3]);
  assert.ok(rows.every((r) => !r.left));
  assert.deepEqual(D.familyRows(body([fam(P1), fam(P1), null as unknown as WakeFamily, {} as WakeFamily, fam(P2)]), []).map((r) => r.parent.mint), [P1, P2]);
  for (const none of [null, undefined, body([]), { asOf: 1 }]) assert.deepEqual(D.familyRows(none, [fam(P1)]), []);
});

test("9. familyRows in use: no card moves; numbers change in place, a new family goes last, one that left stays, marked", () => {
  const shown = [fam(P1, { ratio: 20 }), fam(P2, { ratio: 9 })];
  const fresh = body([fam(P3), fam(P2, { ratio: 30 }), fam(P1, { ratio: 21 })]);
  const held = D.familyRows(fresh, shown, true);
  assert.deepEqual(held.map((r) => [r.parent.mint, r.ratio, !!r.left]), [[P1, 21, false], [P2, 30, false], [P3, 14.2, false]]);
  const gone = D.familyRows(body([fam(P2)]), shown, true);
  assert.deepEqual(gone.map((r) => [r.parent.mint, r.ratio, !!r.left]), [[P1, 20, true], [P2, 14.2, false]]);
  assert.equal(shown[0].left, undefined, "the input is not changed");
  // still gone: stays marked; listed again: a normal card in the same place; idle again: the server's order, the gone ones go
  assert.deepEqual(D.familyRows(body([fam(P2)]), gone, true).map((r) => [r.parent.mint, !!r.left]), [[P1, true], [P2, false]]);
  assert.deepEqual(D.familyRows(body([fam(P2), fam(P1)]), gone, true).map((r) => [r.parent.mint, !!r.left]), [[P1, false], [P2, false]]);
  assert.deepEqual(D.familyRows(body([fam(P2)]), gone, false).map((r) => r.parent.mint), [P2]);
  // a failed or empty read in use keeps every card, marked
  assert.deepEqual(D.familyRows(body([]), shown, true).map((r) => !!r.left), [true, true]);
});

test("9b. familyRows in use: a card's coins keep their rows, no coin is added, the card does not fold or grow", () => {
  const shown = [fam(P1, { coins: [coin("A", { buyers5m: 9 }), coin("B", { buyers5m: 8 }), coin("C", { buyers5m: 7 })], post: null, more: 0, hidden: 0 }), fam(P2, { state: "cooling" })];
  // the server re-ranked P1's coins (C first), dropped B, added D, turned P1 cooling, found a post and hidden coins; P2 went live
  const fresh = body([fam(P1, { state: "cooling", coins: [coin("C", { buyers5m: 40 }), coin("D", { buyers5m: 30 }), coin("A", { buyers5m: 20 })], more: 3, hidden: 2 }), fam(P2, { state: "live", ratio: 33 })]);
  const held = D.familyRows(fresh, shown, true);
  assert.deepEqual(held[0].coins.map((c) => [c.mint, c.buyers5m]), [["A", 20], ["B", 8], ["C", 40]], "same rows, fresh numbers, a dropped coin keeps its last ones, none added");
  assert.deepEqual([held[0].state, held[0].post, held[0].more, held[0].hidden], ["live", null, 0, 0], "no fold, no new post or foot line");
  assert.deepEqual([held[1].state, held[1].ratio], ["cooling", 33], "a folded card stays folded; its numbers change");
  // numbers in a foot line that was already there change in place
  assert.deepEqual([D.familyRows(body([fam(P1, { more: 9, hidden: 1 })]), [fam(P1)], true)[0].more], [9]);
  // held twice over gives the same cards; idle again, the server's card comes back whole
  assert.deepEqual(D.familyRows(fresh, held, true), held);
  const idle = D.familyRows(fresh, held, false);
  assert.deepEqual([idle[0].state, idle[0].coins.map((c) => c.mint), idle[0].more], ["cooling", ["C", "D", "A"], 3]);
  assert.equal(D.TOUCH_HOLD_MS, 5_000);
});

test("10. the map panel's caption and coins", () => {
  assert.equal(D.movingCaption(fam(P1), NOW), "Waking up · started 4 min ago · 14x its normal");
  assert.equal(D.movingCaption(fam(P1, { state: "cooling", ratio: 2.6 }), NOW), "Cooling · started 4 min ago · 2.6x its normal");
  assert.equal(D.movingCaption(fam(P1, { state: "cooling", ratio: 0, startedAt: NOW - 100 * 60 }), NOW), "Cooling · started 1 h 40 min ago");
  const quiet: DiscoverOne = { parent: fam(P1).parent, state: "quiet", startedAt: null, ratio: null, peakRatio: null, buyers5m: 0, trades5m: 0, spark: null, baseline: null, coinsTrading: 0, post: null, coins: [coin("A"), coin("B"), coin("C"), coin("D")], more: 0, hidden: 0 };
  assert.equal(D.movingCaption(quiet, NOW), "Moving now");
  assert.deepEqual(D.movingCoins(quiet).map((c) => c.mint), ["A", "B", "C"]);
  assert.deepEqual(D.movingCoins({ ...quiet, coins: [] }), []);
  assert.deepEqual(D.movingCoins({ ...quiet, coins: null as unknown as WakeCoin[] }), []);
  assert.deepEqual(D.movingCoins(null), []);
  // a coin nobody bought (only sold, or under $1) is not moving: rows with no buyers are left out, and none at all is no block
  const sold = { ...quiet, coins: [coin("E0", { buyers5m: 0, buyers15m: 0 }), coin("E1", { buyers5m: 0, buyers15m: 2 }), coin("E2", { buyers5m: 0 })] };
  assert.deepEqual(D.movingCoins(sold).map((c) => c.mint), ["E1"]);
  assert.deepEqual(D.movingCoins({ ...quiet, coins: [coin("E0", { buyers5m: 0, buyers15m: 0 })] }), []);
  // a quiet answer counts the last 15 min, a waking family the latest 5
  assert.deepEqual(D.movingBuyers(quiet, { buyers5m: 0, buyers15m: 2 }), { n: 2, title: "Wallets that bought in the last 15 minutes" });
  assert.deepEqual(D.movingBuyers(quiet, { buyers5m: 3 }), { n: 3, title: "Wallets that bought in the last 5 minutes" });
  assert.deepEqual(D.movingBuyers(fam(P1), { buyers5m: 7, buyers15m: 20 }), { n: 7, title: "Wallets that bought in the last 5 minutes" });
  assert.doesNotMatch(Object.values(D.TAG_TITLE_QUIET).join(" "), /woke/);
});

test("11. the alert button: off, on, blocked, unsupported", () => {
  assert.equal(D.alertUi("default", false), "off");
  assert.equal(D.alertUi("default", true), "off", "on in storage but never granted: off");
  assert.equal(D.alertUi("granted", false), "off");
  assert.equal(D.alertUi("granted", true), "on");
  assert.equal(D.alertUi("denied", true), "denied");
  assert.equal(D.alertUi(null, true), "unsupported");
  assert.equal(D.ALERT_LABEL.off, "Alert me when a family wakes up");
  assert.equal(D.ALERT_LABEL.on, "Alerts on");
  assert.match(D.ALERT_LABEL.denied, /blocked/);
  assert.equal(D.ALERT_LABEL.unsupported, "This browser can't show notifications");
});

test("12. alert de-dup: one notification per parent per 3 h; the memo stays small and survives bad storage", () => {
  assert.equal(D.ALERT_GAP_S, 3 * 3600);
  let memo = D.parseAlertMemo(null);
  assert.ok(D.alertDue(memo, P1, NOW));
  memo = D.noteAlert(memo, P1, NOW);
  assert.equal(D.alertDue(memo, P1, NOW + 60), false);
  assert.equal(D.alertDue(memo, P1, NOW + 3 * 3600 - 1), false);
  assert.equal(D.alertDue(memo, P1, NOW + 3 * 3600), true);
  assert.equal(D.alertDue(memo, P2, NOW + 60), true, "another parent is its own");
  // round trip through storage; old entries are dropped on the next note
  memo = D.parseAlertMemo(JSON.stringify(D.noteAlert(memo, P2, NOW + 60)));
  assert.deepEqual(Object.keys(memo).sort(), [P1, P2]);
  assert.deepEqual(Object.keys(D.noteAlert(memo, P3, NOW + 4 * 3600)), [P3]);
  for (const bad of ["{", "[1,2]", "null", "7", '{"a":"x","b":null}']) assert.deepEqual(D.parseAlertMemo(bad), {});
  assert.deepEqual(D.parseAlertMemo('{"a":5,"b":"x"}'), { a: 5 });
  // a clock set back: a time ahead of now does not block
  assert.equal(D.alertDue({ [P1]: NOW + 600 }, P1, NOW), true);
});

test("13. the notification's words, and only a fresh wake-up is notified", () => {
  const e: WakeEvent = { parent: { mint: P1, symbol: "NVDAx", name: "NVIDIA" }, startedAt: NOW - 60, ratio: 14.2, buyers5m: 170 };
  assert.deepEqual(D.alertText(e), { title: "$NVDAx is waking up · buying 14x its normal", body: "170 buyers in 5 min across its coins" });
  assert.equal(D.alertText({ ...e, parent: { mint: P1, symbol: null, name: "NVIDIA" } }).title, "NVIDIA is waking up · buying 14x its normal");
  assert.equal(D.alertText({ ...e, parent: { mint: P1, symbol: null, name: null } }).title, "Par1…1111 is waking up · buying 14x its normal");
  assert.equal(D.wakeFresh(e, NOW), true);
  assert.equal(D.wakeFresh({ startedAt: NOW - 1800 }, NOW), false);
  assert.equal(D.wakeFresh({ startedAt: null as unknown as number }, NOW), false);
});

test("14. the wording stays neutral: what is measured, never why or what to do", () => {
  const f = fam(P1);
  const lines = [D.ratioLine(f), D.ratioLine({ ...f, state: "cooling" }), D.startedText(f, NOW), D.sparkLabel(f), D.footLine(3, 4) ?? "", D.HIDDEN_TITLE, D.POST_NOTE,
    D.movingCaption(f, NOW), D.movingCaption({ ...f, state: "cooling", ratio: 0 }), D.ratioLine({ ...f, ratio: 0 }), D.FOOT_NOTE, D.POST_LEAD, D.postLine(post({ text: null }), NOW).body,
    ...Object.values(D.ALERT_LABEL), ...Object.values(D.ALERT_TITLE), ...Object.values(D.TAG_TITLE), ...Object.values(D.TAG_TITLE_QUIET), D.movingBuyers({ state: "quiet" }, { buyers5m: 0, buyers15m: 1 }).title,
    D.alertText({ parent: f.parent, startedAt: NOW, ratio: 9, buyers5m: 60 }).title, D.LEFT_PILL];
  for (const l of lines) assert.doesNotMatch(l, /because|reason|driv|caus|thanks to|due to|moon|should|predict|expect|will |hot|trend|opportunit|recommend|good|likely|rise|pump/i, l);
});

test("15. api.discover and api.discoverOf: one GET each; a 404 is not retried", async () => {
  const urls: string[] = [], was = globalThis.fetch;
  let status = 200;
  globalThis.fetch = (async (url: string) => { urls.push(url); return new Response(JSON.stringify(status === 200 ? body([fam(P1)]) : { error: "not found" }), { status, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const d = await api.discover();
    assert.deepEqual([d.families.length, d.bucketS], [1, 300]);
    await api.discoverOf(P1);
    assert.deepEqual(urls, ["/api/discover", `/api/discover/${P1}`]);
    status = 404;
    await assert.rejects(api.discoverOf("nope"), /not found/);
    assert.equal(urls.length, 3);
  } finally { globalThis.fetch = was; }
});
