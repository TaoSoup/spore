// The coin page's chart scrolled back (web/src/lib/chart-pages.ts): which rows a page or a re-read replaces, the first
// cursor, when the next page is asked, what each answer does, how the view keeps its candles, the foot's note, the "in
// view" span, the request's URL and what resets the pages. No DOM, no network (a fake fetch).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle, CandlePage } from "../src/lib/api.ts";
const { mergeRange, mergeFresh, firstCursor, wantOlder, applyPage, keepView, keyView, KEY_MARGIN_BARS, rangeMoved, pressAt, pressMove, pressMoved, PRESS_SLOP_PX, backHint, viewSpan, seriesKey, freshBack, takesAnswer, normalize,
  PAGE_POLL_MS, PAGE_POLLS, HELD_MS, ERROR_MS, MAX_ROWS, EDGE_MIN_BARS } = await import("../src/lib/chart-pages.ts");
const { api } = await import("../src/lib/api.ts");

const R = 300;
const k = (t: number, c = 1, extra: Partial<Candle> = {}): Candle => ({ t, o: c, h: c, l: c, c, v: 1, ...extra });
const series = (from: number, n: number, c = 1) => Array.from({ length: n }, (_, i) => k(from + i * R, c));
const ts = (rows: Candle[]) => rows.map((x) => x.t);
const page = (over: Partial<CandlePage>): CandlePage => ({ candles: [], priceKey: "usd", from: 0, next: null, state: "done", ...over });

test("23. mergeRange: rows in [lo, hi) replaced, the others kept, sorted, deduped, ms normalised; mergeFresh keeps rows older than the fresh window's first row, ones that fell out of the moving window included", () => {
  const T = 1_700_000_100 - (1_700_000_100 % R), at = (i: number) => T + i * R;
  const kept = series(at(0), 6); // at(0) … at(5)
  const m = mergeRange(kept, [k(at(2) * 1000, 9), k(at(1), 9), k(at(1), 8), k(at(6), 9)], at(1), at(3));
  assert.deepEqual(ts(m), ts(kept), "at(3) kept (outside the range), at(6) outside the range ignored");
  assert.deepEqual([m[1].c, m[2].c], [8, 9], "the answer's rows (the last of a repeated t; ms → s)");
  assert.deepEqual(ts(mergeRange(kept, [k(at(1))], at(1), at(4))), [at(0), at(1), at(4), at(5)], "rows of the range the answer did not have go");
  assert.deepEqual(mergeRange(kept, [], at(10), at(11)), kept, "an empty answer outside the rows changes nothing");
  assert.deepEqual(ts(mergeRange(kept, [], at(0), at(2))), [at(2), at(3), at(4), at(5)], "an empty answer clears its range");
  assert.deepEqual(ts(mergeRange([k(at(5)), k(at(4))], series(at(-3), 3), at(-3), at(0))), [at(-3), at(-2), at(-1), at(4), at(5)], "a page prepended, sorted");
  // the newest window moved on: at(0) and at(1) fell out of it, pages below stay
  const pages = [...series(at(-5), 5), ...kept];
  const fresh = [k(at(2), 7), k(at(3), 7), k(at(5), 7), k(at(6), 7)];
  const f = mergeFresh(pages, fresh);
  assert.deepEqual(ts(f), [...ts(series(at(-5), 7)), at(2), at(3), at(5), at(6)], "at(4) is gone from the fresh window: dropped");
  assert.ok(f.slice(7).every((x) => x.c === 7) && f[6].c === 1);
  assert.deepEqual(mergeFresh(pages, []), pages, "an empty re-read keeps everything");
  assert.deepEqual(normalize([k(2, 1), k(1, 1), { ...k(3), c: NaN }]).map((x) => x.t), [1, 2]);
});

test("24. firstCursor: the oldest row's t; null with no rows, one row, or the oldest in the creation bucket", () => {
  const rows = series(3000, 4);
  assert.equal(firstCursor(rows, R, null), 3000);
  assert.equal(firstCursor(rows, R, 2000), 3000);
  assert.equal(firstCursor(rows, R, 3000), null);
  assert.equal(firstCursor(rows, R, 3299), null, "createdAt inside the oldest row's bucket");
  assert.equal(firstCursor([], R, null), null);
  assert.equal(firstCursor([k(3000)], R, null), null);
});

test("25. wantOlder: false before moved, while busy, with no cursor, before heldUntil, at MAX_ROWS, under 2 rows; true near the left edge (max(20, half the visible bars)), a negative from included", () => {
  const b = { ...freshBack("M|300|usd", 3000), moved: true };
  const near = { from: 5, to: 105 }, far = { from: 300, to: 400 };
  assert.equal(wantOlder(b, near, 500, 0), true);
  assert.equal(wantOlder({ ...b, moved: false }, near, 500, 0), false);
  assert.equal(wantOlder({ ...b, busy: true }, near, 500, 0), false);
  assert.equal(wantOlder({ ...b, cursor: null }, near, 500, 0), false);
  assert.equal(wantOlder({ ...b, heldUntil: 1000 }, near, 500, 999), false);
  assert.equal(wantOlder({ ...b, heldUntil: 1000 }, near, 500, 1000), true);
  assert.equal(wantOlder(b, near, MAX_ROWS, 0), false);
  assert.equal(wantOlder(b, near, 1, 0), false);
  assert.equal(wantOlder(b, null, 500, 0), false);
  assert.equal(wantOlder(b, far, 500, 0), false);
  assert.equal(wantOlder(b, { from: -40, to: 60 }, 500, 0), true, "space left of the first candle");
  assert.equal(wantOlder(b, { from: EDGE_MIN_BARS - 0.5, to: EDGE_MIN_BARS + 10 }, 500, 0), true, "within 20 bars");
  assert.equal(wantOlder(b, { from: EDGE_MIN_BARS, to: EDGE_MIN_BARS + 10 }, 500, 0), false);
  assert.equal(wantOlder(b, { from: 140, to: 440 }, 500, 0), true, "zoomed out: within half the visible bars");
  assert.equal(wantOlder(b, { from: 160, to: 440 }, 500, 0), false);
});

test("26. applyPage: loading applies nothing, keeps the cursor, retries in 4 s, held after 45 polls; done applies [from, hi), cursor = next, end on null; held applies, cursor = next, waits 60 s; credits are sticky", () => {
  let b = { ...freshBack("M|300|usd", 30_000), moved: true, busy: true };
  for (let i = 1; i < PAGE_POLLS; i++) {
    const r = applyPage(b, page({ state: "loading", from: 30_000, next: 30_000 }), 30_000, 0);
    assert.deepEqual([r.apply, r.retryInMs, r.back.cursor, r.back.state, r.back.polls], [null, PAGE_POLL_MS, 30_000, "loading", i]);
    b = r.back;
  }
  const last = applyPage(b, page({ state: "loading", from: 30_000, next: 30_000 }), 30_000, 1000);
  assert.deepEqual([last.apply, last.retryInMs, last.back.state, last.back.heldUntil, last.back.cursor], [null, null, "held", 1000 + HELD_MS, 30_000], "3 minutes of loading: wait");
  assert.equal(PAGE_POLLS * PAGE_POLL_MS, 180_000);
  const rows = series(15_000, 50);
  const d = applyPage(freshBack("x", 30_000), page({ candles: rows, from: 15_000, next: 15_000, gecko: "POOL", chain: "exact" }), 30_000, 0);
  assert.deepEqual([d.apply, d.back.cursor, d.back.state, d.back.pages, d.retryInMs, d.back.gecko, d.back.chain], [{ rows, lo: 15_000, hi: 30_000 }, 15_000, "idle", 1, null, "POOL", "exact"]);
  const e = applyPage(d.back, page({ candles: [k(14_700)], from: 0, next: null, gecko: "OTHER", chain: null }), 15_000, 0);
  assert.deepEqual([e.back.cursor, e.back.state, e.back.gecko, e.back.chain, e.back.pages], [null, "end", "POOL", "exact", 2], "end; the credits stay");
  assert.equal(applyPage(d.back, page({ from: 0, next: null, chain: "sampled" }), 15_000, 0).back.chain, "sampled", "sampled is noted once seen");
  assert.equal(applyPage(d.back, page({ from: 0, next: 15_000 }), 15_000, 0).back.cursor, null, "a next that does not move down ends it");
  const h = applyPage(d.back, page({ state: "held", candles: [k(12_000)], from: 12_000, next: 12_000 }), 15_000, 500);
  assert.deepEqual([h.apply, h.back.cursor, h.back.state, h.back.heldUntil, h.retryInMs], [{ rows: [k(12_000)], lo: 12_000, hi: 15_000 }, 12_000, "held", 500 + HELD_MS, null]);
  const h0 = applyPage(d.back, page({ state: "held", from: 15_000, next: 15_000 }), 15_000, 500);
  assert.deepEqual([h0.apply, h0.back.cursor, h0.back.pages], [null, 15_000, 1], "nothing stored below: nothing applied, the same page later");
  assert.equal(ERROR_MS, 30_000);
});

test("27. keepView: k rows prepended → the range shifted by k; one row appended while scrolled back → the same first candle; at the right edge → null", () => {
  const old = series(30_000, 100);
  const more = [...series(30_000 - 500 * R, 500), ...old];
  assert.deepEqual(keepView({ from: 3.2, to: 60 }, old, more), { from: 503.2, to: 560 });
  assert.deepEqual(keepView({ from: -12, to: 40 }, old, more), { from: 488, to: 540 }, "space left of the first candle keeps its width");
  const appended = [...old, k(30_000 + 100 * R)];
  assert.deepEqual(keepView({ from: 10, to: 50 }, old, appended), { from: 10, to: 50 });
  assert.deepEqual(keepView({ from: 10, to: 50 }, old.slice(5), old), { from: 15, to: 55 }, "a re-read that brought older rows back");
  assert.equal(keepView({ from: 40, to: 99 }, old, appended), null, "at the right edge: follow the newest candle");
  assert.equal(keepView({ from: 40, to: 103 }, old, appended), null);
  assert.equal(keepView(null, old, more), null);
  assert.equal(keepView({ from: 0, to: 10 }, [], more), null);
});

test("28. viewSpan: the visible rows' indices clamped to [0, n−1]; null for no rows or a range off the data", () => {
  assert.deepEqual(viewSpan({ from: 10.2, to: 49.7 }, 100), [10, 50]);
  assert.deepEqual(viewSpan({ from: -30, to: 140 }, 100), [0, 99]);
  assert.deepEqual(viewSpan({ from: -0.4, to: 103.5 }, 100), [0, 99], "fitContent's margins");
  assert.equal(viewSpan({ from: 0, to: 10 }, 0), null);
  assert.equal(viewSpan(null, 10), null);
  assert.equal(viewSpan({ from: -20, to: -3 }, 10), null);
  assert.equal(viewSpan({ from: 12, to: 20 }, 10), null);
});

test("29. backHint: the exact foot text for loading, held and full; empty when idle or at the end", () => {
  const b = { ...freshBack("x", 3000), moved: true };
  assert.equal(backHint({ ...b, busy: true }, 500), " · loading earlier candles…");
  assert.equal(backHint({ ...b, state: "loading" }, 500), " · loading earlier candles…");
  assert.equal(backHint({ ...b, state: "held" }, 500), " · earlier candles unavailable for now");
  assert.equal(backHint(b, MAX_ROWS), " · older candles: pick a larger candle size");
  assert.equal(backHint({ ...b, state: "full" }, 9_000), " · older candles: pick a larger candle size");
  assert.equal(backHint(b, 500), "");
  assert.equal(backHint({ ...b, cursor: null, state: "end" }, MAX_ROWS), "", "nothing older anyway");
});

test("30. api.candlesBefore asks /candles/M?res=300&history=1&before=…&key=usd", async () => {
  const urls: string[] = [], was = globalThis.fetch;
  const body: CandlePage = { candles: [k(1_699_999_700)], priceKey: "usd", from: 1_699_850_000, next: null, state: "done" };
  globalThis.fetch = (async (url: string) => { urls.push(url); return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    assert.deepEqual(await api.candlesBefore("M", 300, "usd", 1_700_000_000), body);
    await api.candlesBefore("M", 60, "quote", 1_700_000_040);
    assert.deepEqual(urls, ["/api/candles/M?res=300&history=1&before=1700000000&key=usd", "/api/candles/M?res=60&history=1&before=1700000040&key=quote"]);
  } finally { globalThis.fetch = was; }
});

test("31. reset rules: the coin, the resolution and the price key make another series (pages reset); the display unit does not enter it; an answer of an older generation is dropped", () => {
  const key = seriesKey("M", 300, "usd");
  assert.notEqual(seriesKey("N", 300, "usd"), key);
  assert.notEqual(seriesKey("M", 60, "usd"), key);
  assert.notEqual(seriesKey("M", 300, "quote"), key, "quote → usd when the newest window's USD-less trades leave it");
  assert.equal(seriesKey("M", 300, "usd"), key, "MC, Price and the quote unit are factors over the same rows");
  const b = freshBack(key, 3000);
  assert.deepEqual([b.cursor, b.moved, b.pages, b.busy, b.state, b.gecko, b.chain], [3000, false, 0, false, "idle", null, null]);
  assert.equal(takesAnswer(4, 4), true);
  assert.equal(takesAnswer(3, 4), false);
});

test("32. keyView: keys page on. A page landed right-anchored leaves its rows left of the view; Home (row 0) brings them in at the left edge, where wantOlder asks for the next page; a candle in view moves nothing", () => {
  const T = 1_700_000_100 - (1_700_000_100 % R);
  const old = series(T, 500), rows = [...series(T - 500 * R, 500), ...old];
  // the fitted view of 500 rows (rightOffset 4), then the page prepended: keepView leaves it at the right edge
  const fitted = { from: 0, to: 503 };
  assert.equal(keepView(fitted, old, rows), null);
  const after = { from: 500, to: 1003 };
  const b = { ...freshBack("k", T - 500 * R), moved: true };
  assert.equal(wantOlder(b, after, rows.length, 0), false, "the new rows are off-screen: nothing asked");
  const v = keyView(after, 0);
  assert.deepEqual(v, { from: -KEY_MARGIN_BARS, to: 503 - KEY_MARGIN_BARS });
  assert.equal(wantOlder(b, v, rows.length, 0), true, "at the left edge: the next page");
  assert.deepEqual(keyView(after, 499), { from: 499 - KEY_MARGIN_BARS, to: 1002 - KEY_MARGIN_BARS }, "the left arrow one step past the view");
  assert.deepEqual(keyView({ from: -2, to: 501 }, 1003), { from: 1003 + KEY_MARGIN_BARS - 503, to: 1003 + KEY_MARGIN_BARS }, "End");
  assert.equal(keyView(after, 700), null);
  assert.equal(keyView(null, 0), null);
});

test("33. rangeMoved: a tap, a click or a page scroll that began on the chart leaves the view and is not a move; a drag or a pinch is, so only that lets an older page load or stops the refit", () => {
  const fitted = { from: -0.3, to: 63.7 };
  assert.equal(rangeMoved(fitted, { ...fitted }), false, "a tap: the same range");
  assert.equal(rangeMoved(fitted, { from: -0.305, to: 63.695 }), false, "rounding noise");
  assert.equal(rangeMoved(fitted, { from: -3.3, to: 60.7 }), true, "a drag to the left of the chart");
  assert.equal(rangeMoved(fitted, { from: -0.3, to: 40 }), true, "a pinch");
  assert.equal(rangeMoved(null, fitted), false, "no pointer down: a live bar or a redraw moved it");
  assert.equal(rangeMoved(fitted, null), false);
  // the fitted view's first candle is at the edge: a tap that set `moved` would ask for a page on the next redraw
  const b = freshBack("k", 1_700_000_000);
  assert.equal(wantOlder({ ...b, moved: rangeMoved(fitted, fitted) }, fitted, 64, 0), false);
  assert.equal(wantOlder({ ...b, moved: rangeMoved(fitted, { from: -1.3, to: 62.7 }) }, { from: -1.3, to: 62.7 }, 64, 0), true);
});

test("33b. pressMoved: a finger held still (reading the crosshair) while the chart shifts by a new live bar or refits is not a move; a drag past the slop or a pinch is", () => {
  const fitted = { from: -0.3, to: 63.7 }, shifted = { from: 0.7, to: 64.7 }, refit = { from: -0.5, to: 80.5 };
  const held = pressAt(fitted, 100, 50);
  assert.equal(pressMoved(held, shifted), false, "a live trade's new bucket shifted the view by a bar");
  assert.equal(pressMoved(held, refit), false, "a re-read refitted it");
  const jitter = pressMove(held, 100 + PRESS_SLOP_PX - 1, 50);
  assert.equal(pressMoved(jitter, shifted), false, "a finger's jitter under the slop");
  const dragged = pressMove(held, 100 - PRESS_SLOP_PX - 3, 50);
  assert.deepEqual([pressMoved(dragged, shifted), pressMoved(dragged, fitted)], [true, false], "a drag that changed the view; one that did not");
  assert.equal(pressMoved(pressMove(held, 100, 50, true), refit), true, "a pinch (a second finger)");
  assert.equal(pressMove(null, 0, 0), null);
  assert.equal(pressMoved(null, shifted), false);
  // the fitted view's first candle is at the edge: the held finger must not let a page load
  const b = freshBack("k", 1_700_000_000);
  assert.equal(wantOlder({ ...b, moved: pressMoved(held, shifted) }, shifted, 65, 0), false);
});
