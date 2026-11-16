// Whether an element can still be seen inside the boxes that clip it: a popover hung from a button (TradePresets.tsx)
// closes once its button scrolls out of a scrolling panel (the map's side panel, the phone's bottom sheet), instead of
// floating over whatever is there. The rule is pure (tested in test/instant-outcome.test.mts); `clipAncestorsOf`
// reads the page.

export type Box = { left: number; top: number; right: number; bottom: number };
/// An ancestor that clips its content on one axis or both (overflow other than visible).
export type Clip = { box: Box; x: boolean; y: boolean };

/// True when `a` lies wholly outside one of the clipping boxes on an axis that box clips: nothing of it shows.
export function clippedOut(a: Box, clips: readonly Clip[]): boolean {
  for (const c of clips) {
    if (c.x && (a.right <= c.box.left || a.left >= c.box.right)) return true;
    if (c.y && (a.bottom <= c.box.top || a.top >= c.box.bottom)) return true;
  }
  return false;
}

/// The ancestors of `el` that clip it, nearest first, up to (not including) the body; the walk ends at a fixed one
/// (nothing above it clips it).
export function clipAncestorsOf(el: Element): { el: Element; x: boolean; y: boolean }[] {
  const out: { el: Element; x: boolean; y: boolean }[] = [];
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    const x = s.overflowX !== "visible", y = s.overflowY !== "visible";
    if (x || y) out.push({ el: p, x, y });
    if (s.position === "fixed") break;
  }
  return out;
}
