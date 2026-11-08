// One number vocabulary for everything the server writes for people: the share card (lib/card.mjs)
// and the og:description under it (lib/og.mjs) read the same figure the same way, and both match the
// web (web/src/lib/format.ts, web/src/lib/map/dominance.ts sharePct), so a post, its unfurl and the
// page agree. Anything that is not a usable number comes back null and the caller leaves that part
// out: nothing here ever prints "NaN", "undefined", "—" or an exponent. No fonts, no wasm, so og.mjs
// can import it without pulling the renderer.
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const UNITS = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
/** Three significant figures with a unit suffix: 1.23M · 45.6K · 789 */
const sig3 = (n) => {
  const [k, u] = UNITS.find(([k]) => n >= k) ?? [1, ""];
  const m = n / k, dp = m < 10 ? 2 : m < 100 ? 1 : 0;
  return m.toFixed(dp).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + u;
};
/** Dollars as the site's cards show them: "$3.68K" · "$11.91" · "$0.4218" · "< $0.01" · "$0"; null unless a finite number ≥ 0. */
export function usd(n) {
  if (!finite(n) || n < 0) return null;
  if (n >= 1e3) return `$${sig3(n)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toPrecision(4)}`;
  return n === 0 ? "$0" : "< $0.01";
}
/** Counts: separators under 100 000, compact above: "17" · "1,284" · "128K"; null unless a finite number ≥ 0. */
export const count = (n) => (!finite(n) || n < 0 ? null : n < 100_000 ? Math.round(n).toLocaleString("en-US") : sig3(n));
/** "1 child" · "12 children" (count()); null when the count is not usable. */
export const plural = (n, one, many) => { const c = count(n); return c == null ? null : `${c} ${n === 1 ? one : many}`; };
/** "1,352 coins under it" · "1 coin under it": what a family has below its top, said the same way on the card's family line and in the og:description (web/src/lib/map/share.ts says it too); null when unknown. */
export const underIt = (n) => { const p = plural(n, "coin", "coins"); return p == null ? null : `${p} under it`; };
/** A family's share of the map, percent in, as the map's dominance chips say it: "41%" · "4.6%" · "<0.1%"; null for nothing or an unknown share. */
export const pctOf = (p) => (!finite(p) || p <= 0 ? null : p < 0.05 ? "<0.1%" : p < 9.95 ? `${p.toFixed(1)}%` : `${Math.round(Math.min(100, p))}%`);
/** Age of a coin from its createdAt (unix s) at `nowMs`: "12s" · "3m" · "5h" · "2d"; null when either is unknown. */
export const ageOf = (createdAt, nowMs) => {
  if (!finite(createdAt) || !finite(nowMs)) return null;
  const s = Math.max(0, Math.floor(nowMs / 1000) - createdAt);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
/** "7xKX…gAsU": a mint for a line that has no name for it (web/src/lib/format.ts short()). */
export const shortMint = (m) => (typeof m === "string" && m.length > 10 ? `${m.slice(0, 4)}…${m.slice(-4)}` : String(m ?? ""));
