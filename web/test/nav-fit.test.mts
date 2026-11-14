// The header's fold decision (web/src/lib/nav-fit.ts): unfolded, it folds when the row overflows or the links get less
// than their natural width; folded, it unfolds only once the unfolded row (its own gaps, remembered) fits with a margin.
import { test } from "node:test";
import assert from "node:assert/strict";
const { navFold, NAV_MEMO0, UNFOLD_MARGIN } = await import("../src/lib/nav-fit.ts");

// an 1100 px window (24 px gutters): the unfolded bar, as measured in the browser
const open = { innerScroll: 1052, innerClient: 1052, linksNatural: 411, linksClient: 411, gap: 20, rightGap: 10, room: 1004, word: 91, rightItems: [95, 140] };

test("unfolded: stays while it fits, and remembers its links' width and its own gaps", () => {
  assert.deepEqual(navFold(false, open, NAV_MEMO0), { folded: false, memo: { linksWidth: 411, gap: 20, rightGap: 10 } });
});

test("unfolded: folds when the row overflows, or the links are squeezed below their natural width (what overlapped)", () => {
  assert.equal(navFold(false, { ...open, innerScroll: 1300 }, NAV_MEMO0).folded, true);
  assert.equal(navFold(false, { ...open, linksClient: 167 }, NAV_MEMO0).folded, true, "a 600 px right side squeezed the links to 167 px");
  assert.equal(navFold(false, { ...open, linksClient: 410.5 }, NAV_MEMO0).folded, false, "sub-pixel rounding is not overflow");
  // fractional widths (getBoundingClientRect) as the hook measures them: at 125 % scaling five links sum to their pill
  assert.equal(navFold(false, { ...open, linksNatural: 410.8, linksClient: 410.8 }, NAV_MEMO0).folded, false);
  assert.equal(navFold(false, { ...open, linksNatural: 412.4, linksClient: 410.8 }, NAV_MEMO0).folded, true, "1.6 px short is a squeeze");
});

test("folded: unfolds when word + links + right side + the UNFOLDED gaps + margin fit; the folded gaps do not count", () => {
  const memo = { linksWidth: 411, gap: 20, rightGap: 10 };
  // folded, the bar is a flex row with 12 px gaps and the right side 8 px: those are not what the unfolded row needs
  const folded = { ...open, gap: 12, rightGap: 8, linksNatural: 0, linksClient: 0 };
  const need = 91 + 411 + (95 + 10 + 140) + 2 * 20 + UNFOLD_MARGIN; // 811
  assert.equal(navFold(true, { ...folded, room: need }, memo).folded, false, "exactly enough: unfolds");
  assert.equal(navFold(true, { ...folded, room: need - 1 }, memo).folded, true, "one pixel short: stays folded");
  assert.deepEqual(navFold(true, { ...folded, room: need - 1 }, memo).memo, memo, "nothing is re-learned while folded");
  // the right side changes while folded (a longer or shorter wallet label): measured live
  assert.equal(navFold(true, { ...folded, rightItems: [95, 600], room: 1004 }, memo).folded, true);
  assert.equal(navFold(true, { ...folded, rightItems: [95, 140], room: 1004 }, memo).folded, false);
  // an "api down" pill joins the right side: one more item and one more gap
  assert.equal(navFold(true, { ...folded, rightItems: [90, 95, 140], room: need + 90 + 10 - 1 }, memo).folded, true);
  assert.equal(navFold(true, { ...folded, rightItems: [90, 95, 140], room: need + 90 + 10 }, memo).folded, false);
});
