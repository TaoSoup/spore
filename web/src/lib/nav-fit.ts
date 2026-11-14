// When the header's row stops fitting (App.tsx useNavFits): the decision alone, from the bar's measurements, so it can
// be tested without a browser.

/// What the bar measures.
/// - Unfolded: whether the row overflows the bar, and the links' natural width (the sum of the link items, which never
///   shrink below their text, plus the pill's padding and border) against the width they got.
/// - Folded: the room inside the bar, the wordmark, and the widths of what stays in the bar's right side (the burger
///   not counted: unfolded, it goes).
export type NavMeasure = {
  innerScroll: number; innerClient: number; linksNatural: number; linksClient: number;
  /// the bar's gap between its three parts, and the right side's gap between its buttons (as laid out now)
  gap: number; rightGap: number;
  room: number; word: number; rightItems: number[];
};
/// What the unfolded bar looked like when last shown: the folded layout uses other gaps, so the unfold check uses these.
export type NavMemo = { linksWidth: number; gap: number; rightGap: number };
export const NAV_MEMO0: NavMemo = { linksWidth: 0, gap: 20, rightGap: 10 };
/// The room a folded bar needs beyond the exact fit before it unfolds, so it does not flicker at the edge.
export const UNFOLD_MARGIN = 24;

export function navFold(folded: boolean, m: NavMeasure, memo: NavMemo): { folded: boolean; memo: NavMemo } {
  if (!folded) {
    const over = m.innerScroll > m.innerClient + 1 || m.linksNatural > m.linksClient + 1;
    return { folded: over, memo: { linksWidth: m.linksNatural, gap: m.gap, rightGap: m.rightGap } };
  }
  const right = m.rightItems.reduce((s, w) => s + w, 0) + Math.max(0, m.rightItems.length - 1) * memo.rightGap;
  const need = m.word + memo.linksWidth + right + 2 * memo.gap + UNFOLD_MARGIN;
  return { folded: m.room < need, memo };
}
