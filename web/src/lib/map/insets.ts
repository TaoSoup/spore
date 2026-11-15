// What the page chrome covers on the map, as the bands the engine fits and flies inside (pages/Map.tsx).
//
// Wide (> 900 px): the left column and, with a coin selected, the side panel.
// Narrow: the overlay (stats line, search, pills) sits top-left, at most 520 px wide, and a selection opens a bottom sheet.
// On an upright phone the overlay spans the width, so the free area is the band below it. On a phone held sideways the
// same overlay covers only the left part of a short screen: the band below it is about 110 px high while the area to
// its right is 250 px. `besideOverlay` picks whichever lets a round map be drawn larger.

export type Inset = { left?: number; top?: number; right?: number; bottom?: number };
export type InsetInput = {
  /** the docked desktop layout */
  wide: boolean;
  /** the overlay's right and bottom edges, in page px */
  ovRight: number; ovBottom: number;
  /** the map page's size; 0 until measured */
  pageW: number; pageH: number;
  /** the docked side panel's width, and the bottom sheet's height at peek */
  sideW: number; peekH: number;
  hasSel: boolean;
  /** narrow layouts: the side already chosen (besideOverlay with its memory); left out, it is judged afresh */
  beside?: boolean;
};

/** the size toggle along the bottom edge (narrow layouts) */
const BOTTOM = 56;
/** the zoom buttons' column on the right edge (54 px wide, 10 px in); hidden while a sheet is up */
const ZOOM_COL = 70;

/** Narrow layouts: is the free area to the right of the overlay roomier than the band below it? Judged without a
 *  selection, so opening the sheet never flips the framing. `prev` is the last answer: the other side must win by 24 px
 *  to change it, so a line that comes and goes in the overlay (an update error) or a browser toolbar sliding away cannot
 *  throw the map from one area to the other and back. */
export function besideOverlay(i: Pick<InsetInput, "ovRight" | "ovBottom" | "pageW" | "pageH">, prev = false): boolean {
  if (!(i.pageW > 0 && i.pageH > 0)) return false;
  const below = Math.min(i.pageW, i.pageH - (i.ovBottom + 8) - BOTTOM);
  const beside = Math.min(i.pageW - (i.ovRight + 12) - ZOOM_COL, i.pageH - 16 - BOTTOM);
  return beside >= 120 && beside > below + (prev ? -24 : 24);
}

/** `inset`: where a selection is framed. `fitInset`: where the whole map is framed, whatever is selected. */
export function mapInsets(i: InsetInput): { inset: Inset; fitInset: Inset } {
  if (i.wide) {
    const left = i.ovRight + 12;
    return { inset: { left, top: 16, bottom: 16, right: i.hasSel ? i.sideW + 28 : 16 }, fitInset: { left, top: 16, bottom: 16, right: 16 } };
  }
  const bottom = i.hasSel ? i.peekH + 8 : BOTTOM;
  if (i.beside ?? besideOverlay(i)) {
    const left = i.ovRight + 12;
    return { inset: { left, top: 16, bottom, right: i.hasSel ? 16 : ZOOM_COL }, fitInset: { left, top: 16, bottom: BOTTOM, right: ZOOM_COL } };
  }
  const top = i.ovBottom + 8;
  return { inset: { top, bottom }, fitInset: { top, bottom: BOTTOM } };
}
