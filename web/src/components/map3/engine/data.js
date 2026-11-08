// data.js: walk the trees, family stats and dominance (share / rank / planets).
// (map3 port) The engine never fetches: the app hands over the tree (the /api/map wire shape, built by adapter.ts from the
// page's nodes), the heat payload (the /api/map/heat wire shape) and the value functions of both size modes
// (opts.values {locked, mcap}; opts.valueOf = the current mode's).
// Removed from the prototype: fetchHeat, fetchCoin, openFeed, feedCaps, fetchJson and loadData (the app owns the data).
//
// EXPORTS
//   ingest(S, opts)   synchronous; fills on S:
//     heat                             heat payload {at, mint[], last[], n24[], t1h[], buys1h[], v24[]} (an empty one at
//                                      Date.now() when opts.heat is null; heatStatus 'offline')
//     heatStatus                       'ok' | 'offline'
//     nowS                             heat.at (s), the clock every age is measured against
//     heatIdx: Map mint -> heat row
//     per coin (index i, depth-first per family, N total):
//       sym[], img[], mint[], par[] (-1 = family top), gen[], famOf[], kids[][], mc[] (USD, 0 = none),
//       val[] (value weight = opts.valueOf, the coin's part of its family value in the size mode), age[] (s since last trade, Infinity = none in
//       24 h), n24[], crt[] (creation time, s, 0 = unknown)
//     mintIdx: Map mint -> coin index
//     fams[] {id, members[], maxGen, top, value, age, n24, share, rank, planet, valueL, valueM, shareL, shareM, rankL, rankM}
//                   value/share = the current mode's (valueL/shareL locked, valueM/shareM mcap); rankL/rankM = 0-based rank by
//                   that mode's value (ties: more members, then top mint); rank = the MODE-INDEPENDENT order: min(rankL, rankM),
//                   ties by the other rank, then more members, then top mint. So the planet set, the planet/dust partition
//                   and the family order are identical in both size modes; a mode change moves only value/share (chip size).
//     N, total, ranked[], planets[] (the first N_PLANETS of ranked), dust[] (the rest), dustShare, maxShare (the largest
//                   planet share in the current mode)
//     (family-all) f.ghost (asset tops: max(0, top.children - drawn kids), else 0), f.size = members + ghost, ghostTotal
//     famBy(key) -> the best-ranked family whose top symbol matches (case-insensitive, leading '$' ignored), or the
//                   family of a coin mint; else undefined
//   Throws EngineError('empty') for 0 roots.
import { EngineError } from "./state.js";

const emptyHeat = () => ({ at: Date.now() / 1000, mint: [], last: [], n24: [], t1h: [], v24: [], buys1h: [] });
export const validHeat = (h) => !!(h && Array.isArray(h.mint) && Array.isArray(h.last) && Number(h.at) > 0);

export function ingest(S, opts) {
  const roots = Array.isArray(opts.roots) ? opts.roots.filter((r) => r && r.coin && r.coin.mint) : [];
  if (!roots.length) throw new EngineError("empty", "no coins to draw");
  const heatOk = validHeat(opts.heat);
  const heat = heatOk ? opts.heat : emptyHeat();
  const heatIdx = new Map(); const nowS = Number(heat.at) || Date.now() / 1000;
  for (let i = 0; i < heat.mint.length; i++) heatIdx.set(heat.mint[i], i);
  const sym = [], img = [], mint = [], par = [], gen = [], famOf = [], kids = [], mc = [], val = [], age = [], n24 = [], crt = [];
  const fams = [];
  // (map3 port; size modes 2026-10-21) a coin's part of its family value in each mode: sizing.familyValueOf through the
  // adapter (opts.values), the same rules built in when absent; opts.valueOf = the current mode's. Non-finite or negative = 0.
  const vals = opts.values && typeof opts.values === "object" ? opts.values : {};
  const fnL = typeof vals.locked === "function" ? vals.locked : (c) => c.lockedUsd;
  const fnM = typeof vals.mcap === "function" ? vals.mcap : (c) => (c.asset ? 0 : c.mcapCapUsd ?? c.mcapUsd);
  const vf = typeof opts.valueOf === "function" ? opts.valueOf : opts.mode === "mcap" ? fnM : fnL;
  const num = (fn, c) => { let v; try { v = Number(fn(c)); } catch { v = 0; } return Number.isFinite(v) && v > 0 ? v : 0; };
  const valueOf = (c) => num(vf, c);
  const add = (node, p, g, f) => {
    const i = sym.length, c = node.coin;
    sym.push(c.symbol || c.name || String(c.mint).slice(0, 4)); img.push(c.image || null); mint.push(c.mint);
    par.push(p); gen.push(g); famOf.push(f.id); kids.push([]); mc.push(c.mcapCapUsd > 0 ? c.mcapCapUsd : c.mcapUsd > 0 ? c.mcapUsd : 0);   /* (flat fix) liquidity-capped mcap when the server sends one */ val.push(valueOf(c));
    f.valueL += num(fnL, c); f.valueM += num(fnM, c);
    crt.push(Number(c.createdAt) > 0 ? Number(c.createdAt) : 0);
    const h = heatIdx.get(c.mint);
    age.push(h === undefined ? Infinity : Math.max(0, nowS - heat.last[h])); n24.push(h === undefined ? 0 : Number(heat.n24 && heat.n24[h]) || 0);
    if (p >= 0) kids[p].push(i);
    f.members.push(i); if (g > f.maxGen) f.maxGen = g;
    return i;
  };
  // (map3 port) the prototype's recursive walk, as an explicit pre-order stack (same order; no recursion-depth limit)
  for (const r of roots) {
    const f = { id: fams.length, members: [], maxGen: 0, valueL: 0, valueM: 0 }; fams.push(f);
    const stack = [[r, -1, 0]];
    while (stack.length) {
      const [node, p, g] = stack.pop();
      const i = add(node, p, g, f);
      if (p < 0) f.top = i;
      const ch = Array.isArray(node.children) ? node.children : [];
      for (let q = ch.length - 1; q >= 0; q--) if (ch[q] && ch[q].coin && ch[q].coin.mint) stack.push([ch[q], i, g + 1]);
    }
  }
  const N = sym.length;
  // (family-all, DESIGN-FAMILY-ALL.md §2) a listed-asset top carries its TRUE child count (children); the server draws a
  // capped slice. ghost = the undrawn coins (asset tops only: a SOL family is drawn whole), size = the family's true size
  // (members + ghost = 1 + top.descendants: undrawn coins are leaves). Family VALUE stays the drawn slice.
  let ghostTotal = 0;
  for (const f of fams) {
    const c = roots[f.id] && roots[f.id].coin, ch = c ? Number(c.children) : 0;
    f.ghost = c && c.asset === true && Number.isFinite(ch) ? Math.max(0, Math.floor(ch) - kids[f.top].length) : 0;
    f.size = f.members.length + f.ghost;
    ghostTotal += f.ghost;
  }
  let total = 0;
  for (const f of fams) { let v = 0, a = Infinity, t = 0; for (const i of f.members) { v += val[i]; if (age[i] < a) a = age[i]; t += n24[i]; } f.value = v; f.age = a; f.n24 = t; total += v; }
  for (const f of fams) f.share = total > 0 ? f.value / total : 0;
  // (size modes) both modes' shares and ranks; the family order is min(rankL, rankM) so it is the same in both modes
  let totL = 0, totM = 0;
  for (const f of fams) { totL += f.valueL; totM += f.valueM; }
  for (const f of fams) { f.shareL = totL > 0 ? f.valueL / totL : 0; f.shareM = totM > 0 ? f.valueM / totM : 0; }
  const tie = (a, b) => b.members.length - a.members.length || (mint[a.top] < mint[b.top] ? -1 : mint[a.top] > mint[b.top] ? 1 : 0);
  fams.slice().sort((a, b) => b.valueL - a.valueL || tie(a, b)).forEach((f, r) => { f.rankL = r; });
  fams.slice().sort((a, b) => b.valueM - a.valueM || tie(a, b)).forEach((f, r) => { f.rankM = r; });
  let ranked = fams.slice().sort((a, b) => Math.min(a.rankL, a.rankM) - Math.min(b.rankL, b.rankM) || Math.max(a.rankL, a.rankM) - Math.max(b.rankL, b.rankM) || tie(a, b));
  // opts.order (a mode switch): the previous engine's family order by top mint, kept as is so prices that ticked between the
  // two builds cannot move the planet set or the order; a family it does not list follows in the computed order.
  if (Array.isArray(opts.order) && opts.order.length) {
    const prev = new Map(); opts.order.forEach((m, k) => { if (typeof m === "string" && !prev.has(m)) prev.set(m, k); });
    const at = new Map(ranked.map((f, k) => [f, k]));
    const key = (f) => { const k = prev.get(mint[f.top]); return k === undefined ? Infinity : k; };
    ranked = ranked.slice().sort((a, b) => key(a) - key(b) || at.get(a) - at.get(b));
  }
  ranked.forEach((f, r) => { f.rank = r; f.planet = r < S.N_PLANETS; });
  const planets = ranked.slice(0, S.N_PLANETS), dust = ranked.slice(S.N_PLANETS);
  let maxShare = 0; for (const f of planets) if (f.share > maxShare) maxShare = f.share;
  const mintIdx = new Map(); for (let i = 0; i < N; i++) mintIdx.set(mint[i], i);
  const bare = (s) => String(s || "").replace(/^\$+/, "").toLowerCase();
  const famBy = (s) => {
    if (s == null || s === "") return undefined;
    const i = mintIdx.get(String(s));
    if (i !== undefined) return fams[famOf[i]];
    const q = bare(s);
    return ranked.find((x) => bare(sym[x.top]) === q);
  };
  Object.assign(S, {
    heat, heatStatus: heatOk ? "ok" : "offline", nowS, heatIdx, sym, img, mint, mintIdx, par, gen, famOf, kids, mc, val, age, n24, crt,
    fams, N, total, ranked, planets, dust, ghostTotal,
    dustShare: dust.reduce((s, f) => s + f.share, 0),
    maxShare: maxShare || 1,
    famBy,
  });
  Object.assign(S.debug.map, { coins: N, families: fams.length, planets: planets.length, dust: dust.length, ghosts: ghostTotal });
}
