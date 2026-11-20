// What lib/wakeups.mjs and lib/coinrows.mjs must agree on, in one place: the two files import each other's lists, and
// the 30-minute line was a named constant in one and a literal 1800 in the other.

/** A buy counts as a buyer from this value (USD): the wake rule, the rows' buyers and the trending rank alike. */
export const MIN_USD = 1;
/** A child is "existing" once launched this long (s) before the moment it is measured from. */
export const EXISTING_S = 1800;

export const r1 = (x) => Math.round(x * 10) / 10;
export const r2 = (x) => Math.round(x * 100) / 100;
/** Sort order of two mints (or any two strings): the last tie-break of every list, so equal rows never swap between builds. */
export const byMint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
