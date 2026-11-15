// The bands the page chrome covers on the map (lib/map/insets.ts): docked on desktop, under the overlay on an upright
// phone, beside it on a phone held sideways.
//
//   node --import tsx --test test/map-insets.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { besideOverlay, mapInsets } from "../src/lib/map/insets.ts";

const base = { sideW: 340, peekH: 170, hasSel: false };

test("desktop: the left column, and the side panel once a coin is selected", () => {
  const a = mapInsets({ ...base, wide: true, ovRight: 336, ovBottom: 600, pageW: 1900, pageH: 877 });
  assert.deepEqual(a.inset, { left: 348, top: 16, bottom: 16, right: 16 });
  assert.deepEqual(a.fitInset, a.inset);
  const b = mapInsets({ ...base, wide: true, hasSel: true, ovRight: 336, ovBottom: 600, pageW: 1900, pageH: 877 });
  assert.equal(b.inset.right, 368);
  assert.deepEqual(b.fitInset, a.fitInset, "the overview fit ignores the selection");
});

test("an upright phone keeps the band under the overlay", () => {
  for (const [pageW, pageH] of [[390, 781], [360, 577], [320, 505], [768, 961]]) {
    const i = { ...base, wide: false, ovRight: Math.min(pageW - 12, 532), ovBottom: 153, pageW, pageH };
    assert.equal(besideOverlay(i), false, `${pageW}x${pageH}`);
    assert.deepEqual(mapInsets(i).inset, { top: 161, bottom: 56 });
    assert.deepEqual(mapInsets({ ...i, hasSel: true }).inset, { top: 161, bottom: 178 });
    assert.deepEqual(mapInsets({ ...i, hasSel: true }).fitInset, { top: 161, bottom: 56 });
  }
});

test("a phone held sideways frames the map beside the overlay", () => {
  const i = { ...base, wide: false, ovRight: 532, ovBottom: 153, pageW: 844, pageH: 327 };
  assert.equal(besideOverlay(i), true);
  const { inset, fitInset } = mapInsets(i);
  assert.deepEqual(fitInset, { left: 544, top: 16, bottom: 56, right: 70 });
  assert.deepEqual(inset, fitInset);
  // the free area is far larger than the 110 px band under the overlay
  assert.ok(Math.min(844 - 544 - 70, 327 - 16 - 56) >= 200);
  // a sheet replaces the bottom band and hides the zoom column; the side does not flip
  const s = mapInsets({ ...i, hasSel: true, peekH: 139 });
  assert.deepEqual(s.inset, { left: 544, top: 16, bottom: 147, right: 16 });
  assert.deepEqual(s.fitInset, fitInset);
});

test("a wide-enough short tablet stays under the overlay; nothing is decided before the page is measured", () => {
  assert.equal(besideOverlay({ ovRight: 532, ovBottom: 153, pageW: 800, pageH: 537 }), false);
  assert.equal(besideOverlay({ ovRight: 532, ovBottom: 153, pageW: 0, pageH: 0 }), false);
  // a strip beside the overlay too thin to hold a map is never chosen, however short the page
  assert.equal(besideOverlay({ ovRight: 532, ovBottom: 153, pageW: 700, pageH: 280 }), false);
});

test("the side holds through a small change: the other must win by 24 px", () => {
  // 900 px wide: beside = min(286, pageH - 72), below = pageH - 217; they meet at pageH 503
  const at = (pageH: number, ovBottom = 153) => ({ ovRight: 532, ovBottom, pageW: 900, pageH });
  assert.equal(besideOverlay(at(510)), false);
  assert.equal(besideOverlay(at(510, 173)), false, "a 20 px error line in the overlay does not flip it");
  assert.equal(besideOverlay(at(470)), true);
  assert.equal(besideOverlay(at(510), true), true, "nor does it flip back");
  assert.equal(besideOverlay(at(540), true), false);
  // mapInsets follows the remembered side when it is given
  assert.equal(mapInsets({ ...base, wide: false, ...at(510), beside: true }).fitInset.left, 544);
  assert.equal(mapInsets({ ...base, wide: false, ...at(510), beside: false }).fitInset.left, undefined);
});
