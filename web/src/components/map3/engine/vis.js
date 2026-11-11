// vis.js (map3, 2026-11-10: the Key's last-trade filter): which coins the map draws. The Key toggles the four heat classes of
// tokens.js heatClass (bit k of the mask = class k: 0 within 30 min, 1 within 3 h, 2 within 24 h, 3 older or never traded;
// a coin without a heat row is class 3; a coin created within 30 min of heat.at is class 0: visClassOf, the page's rule).
// The page sends MASK_ALL while its heat data is not loaded, so the map never goes blank. DESIGN.md: the layout never moves between builds (a mask change rebuilds the WebGL map from the filtered set: ThreeMap), so nothing here touches a position, a family or a node list: a hidden coin keeps
// its place and is simply not drawn (motion.js owns the live state and every GPU write; bubbles.js, links.js, dust.js,
// swarm.js and labels.js read the levels). Pure: no three, no DOM (test/map3-visibility.test.mts drives it directly).
//   SHOWN   its class bit is in the mask, or it is pinned (the selection and its chain, the focused / page-hovered coin, the
//           page's pins); a newborn is class 0
//   ANCHOR  not shown itself, but an ancestor of a shown coin (its parent chain up to and including the family top, listed
//           asset tops like USDC / PUMP too): drawn at TOK.dim, clickable, its own parent link kept, so no shown coin floats
//   HIDDEN  neither: alpha 0, no hit, no label, no live effect, no logo cell; a link whose child is hidden is hidden
// Families: famVis[f] = the shown coins of family f (+ its virtual ones, below); 0 = the whole family is hidden (top, chip,
// dust speck, colony, title, corona, orbit, nebula). A family top is HIDDEN exactly when its famVis is 0.
// Virtual descendants (virt[i]): a capped asset family's swarm specks are not engine coins. Its ghosts while bit 3 is on and
// its loaded real specks that are shown count as shown descendants of the top (motion.js keeps virt), so the top anchors them.
//
// INDEX ORDER: data.js numbers coins depth-first per family (pre-order), so par[i] < i for every coin with a parent, and a
// newborn (index >= N) hangs from a built coin. visLevels relies on it for its one reverse pass (and falls back to walking
// every chain when an index breaks it).
//
// EXPORTS
//   VIS = {HIDDEN: 0, ANCHOR: 1, SHOWN: 2}, VIS_NAMES[level], MASK_ALL = 15, VIS_ALPHA[code] (code 0 hidden, 1 dim, 2 full)
//   cleanMask(m) -> 0..15 (MASK_ALL for anything that is not a finite number)
//   classShown(mask, cls) -> 0 | 1
//   NEWBORN_S = 1800, visClassOf(age, crt, nowS) -> 0..3   the class the filter files a coin under (lib/map/visibility.ts
//            coinClass, a test pins the parity): its heat class, except that a coin created within NEWBORN_S of the heat
//            clock (crt >= nowS - NEWBORN_S; crt = creation time s, 0 = unknown; nowS = heat.at, 0 = no heat) is class 0.
//            Only the filter reads it (S.vis.cls): a bubble's colour, rim and boost keep its heat class
//   visLevels(par, cls, mask, pinned, famOf, nFam, opts?) -> state   the full computation, O(n)
//            opts: {n (coins in use, default par.length), cap (array size), virt (Int32Array, kept as st.virt), into (a state
//            to recompute in place)}. state = {n, cap, nFam, par, famOf, virt, shown, desc, level, famVis, cnt[level]}
//   visSet(st, i, on, changed?) -> levels changed     one coin's SHOWN flag (a reveal, a hide, a pin): O(depth)
//   visVirt(st, i, d, changed?) -> levels changed     virtual shown descendants of coin i += d: O(depth)
//   visGrow(st, n)                                    indices up to n - 1 join (newborns), HIDDEN until visSet
//   visCounts(st) -> {shown, anchors, hidden}
//   createVis(S, last?) -> S.vis                      index.js, right after ingest: the levels before anything is built, so
//            the first frame of a mount (or a rebuild) never flashes the hidden coins. last = EngineOptions.last
//            {mask, pinned?: mints}. S.vis = {cap, mask, st, level, famVis, par, fam, cls (visClassOf; motion.js keeps it
//            current on every heat payload, trade and birth), virt, a (alpha code per coin),
//            fa (alpha code per family), on (anything not shown: the CPU gates engage), pins (page pins, engine indices),
//            pinMints (page pins the engine does not draw: swarm specks), speck (per family: loaded real specks shown)}
import { TOK, heatClass } from "./tokens.js";

export const VIS = Object.freeze({ HIDDEN: 0, ANCHOR: 1, SHOWN: 2 });
export const VIS_NAMES = Object.freeze(["hidden", "anchor", "shown"]);
export const MASK_ALL = 15;
// alpha per code: 0 hidden, 1 dim (an anchor, or a coin the ?hl highlight does not match), 2 full
export const VIS_ALPHA = Object.freeze([0, TOK.dim, 1]);
// newborn indices the state keeps room for past N (bubbles.js holds 512 spare instances)
const BORN_ROOM = 1024;

export const cleanMask = (m) => (typeof m === "number" && Number.isFinite(m) ? (m | 0) & MASK_ALL : MASK_ALL);
export const classShown = (mask, c) => (mask >> (c >= 0 && c <= 3 ? c : 3)) & 1;
// a coin created this recently (s, on the heat clock) counts as traded within 30 min (lib/map/visibility.ts NEWBORN_S)
export const NEWBORN_S = 1800;
export const visClassOf = (age, crt, nowS) => (crt > 0 && nowS > 0 && crt >= nowS - NEWBORN_S ? 0 : heatClass(age));

function alloc(cap, nFam) {
  return { n: 0, cap, nFam, par: null, famOf: null, virt: null, shown: new Uint8Array(cap), desc: new Int32Array(cap), level: new Uint8Array(cap), famVis: new Int32Array(Math.max(1, nFam)), cnt: new Int32Array(3) };
}
// one coin's level from its flags; counts and the changed list follow
function relevel(st, i, changed) {
  const l = st.shown[i] ? 2 : st.desc[i] > 0 ? 1 : 0, o = st.level[i];
  if (l === o) return 0;
  st.level[i] = l; st.cnt[o]--; st.cnt[l]++;
  if (changed) changed.push(i);
  return 1;
}

export function visLevels(par, cls, mask, pinned, famOf, nFam, opts = {}) {
  const n = Math.max(0, opts.n ?? par.length), cap = Math.max(n, opts.cap || 0);
  const into = opts.into;
  const st = into && into.cap >= n && into.nFam >= nFam ? into : alloc(cap, nFam);
  st.n = n; st.par = par; st.famOf = famOf;
  if (opts.virt) st.virt = opts.virt;
  const { shown, desc, level, famVis, cnt } = st, virt = st.virt, m = cleanMask(mask);
  shown.fill(0); desc.fill(0); famVis.fill(0);
  for (let i = 0; i < n; i++) shown[i] = classShown(m, cls[i]);
  if (pinned) for (const i of pinned) if (i >= 0 && i < n) shown[i] = 1;
  if (virt) for (let i = 0; i < n; i++) if (virt[i]) desc[i] = virt[i];
  // shown descendants: one reverse pass (pre-order: a coin's whole subtree sits at higher indices)
  let ordered = true;
  for (let i = n - 1; i >= 0; i--) { const p = par[i]; if (p < 0) continue; if (p >= i) { ordered = false; break; } desc[p] += desc[i] + shown[i]; }
  if (!ordered) {   // an index out of pre-order: walk every chain (O(sum of depths), bounded against cycles)
    desc.fill(0);
    if (virt) for (let i = 0; i < n; i++) if (virt[i]) desc[i] = virt[i];
    for (let i = 0; i < n; i++) {
      const w = shown[i] + (virt ? virt[i] : 0); if (!w) continue;
      for (let p = par[i], g = 0; p >= 0 && g < n; p = par[p], g++) desc[p] += w;
    }
  }
  for (let i = 0; i < n; i++) { const f = famOf[i]; if (f >= 0 && f < nFam) famVis[f] += shown[i] + (virt ? virt[i] : 0); }
  cnt.fill(0);
  for (let i = 0; i < n; i++) { const l = shown[i] ? 2 : desc[i] > 0 ? 1 : 0; level[i] = l; cnt[l]++; }
  for (let i = n; i < st.cap; i++) level[i] = 0;
  return st;
}

export function visSet(st, i, on, changed = null) {
  if (!(i >= 0 && i < st.n)) return 0;
  const v = on ? 1 : 0;
  if (st.shown[i] === v) return 0;
  st.shown[i] = v;
  const d = v ? 1 : -1, f = st.famOf[i];
  if (f >= 0 && f < st.nFam) st.famVis[f] += d;
  let k = relevel(st, i, changed);
  for (let p = st.par[i], g = 0; p >= 0 && g < st.n; p = st.par[p], g++) { st.desc[p] += d; k += relevel(st, p, changed); }
  return k;
}

export function visVirt(st, i, d, changed = null) {
  if (!d || !(i >= 0 && i < st.n)) return 0;
  if (!st.virt) st.virt = new Int32Array(st.cap);
  st.virt[i] += d; st.desc[i] += d;
  const f = st.famOf[i];
  if (f >= 0 && f < st.nFam) st.famVis[f] += d;
  let k = relevel(st, i, changed);
  for (let p = st.par[i], g = 0; p >= 0 && g < st.n; p = st.par[p], g++) { st.desc[p] += d; k += relevel(st, p, changed); }
  return k;
}

export function visGrow(st, n) {
  n = Math.min(n, st.cap);
  for (let i = st.n; i < n; i++) { st.shown[i] = 0; st.desc[i] = st.virt ? st.virt[i] : 0; st.level[i] = 0; st.cnt[0]++; }
  if (n > st.n) st.n = n;
}

export const visCounts = (st) => ({ shown: st.cnt[2], anchors: st.cnt[1], hidden: st.cnt[0] });

export function createVis(S, last = null) {
  const N = S.N | 0, fams = S.fams || [], nF = fams.length, cap = N + BORN_ROOM;
  const par = new Int32Array(cap).fill(-1), fam = new Int32Array(cap).fill(-1), cls = new Uint8Array(cap).fill(3), virt = new Int32Array(cap);
  // the filter's class (visClassOf): no heat at build (an empty payload stamped now) = no heat clock, as on the page
  const crt = S.crt || null, nowS = S.heatStatus === "offline" ? 0 : Number(S.nowS) || 0;
  for (let i = 0; i < N; i++) { par[i] = S.par[i]; fam[i] = S.famOf[i]; cls[i] = visClassOf(S.age[i], crt ? crt[i] : 0, nowS); }
  const mask = cleanMask(last ? last.mask : MASK_ALL);
  const idx = (m) => { const i = typeof m === "string" && S.mintIdx ? S.mintIdx.get(m) : undefined; return i === undefined ? -1 : i; };
  const pins = new Set(), pinMints = [];
  if (last && Array.isArray(last.pinned)) for (const m of last.pinned) { const i = idx(m); if (i >= 0) pins.add(i); else if (typeof m === "string") pinMints.push(m); }
  // the coin selected at mount is shown from the first frame (motion.js pins it as its selection right after)
  const sel = idx(S.opts && S.opts.select), pinList = [...pins]; if (sel >= 0) pinList.push(sel);
  // a capped family's ghosts are class 3: while bit 3 is on they anchor their top
  const ghostsOn = !(S.opts && S.opts.swarm === false) && (mask & 8) !== 0;
  if (ghostsOn) for (const f of fams) if (f.ghost > 0 && f.top >= 0 && f.top < N) virt[f.top] += 1;
  const st = visLevels(par, cls, mask, pinList, fam, nF, { n: N, cap, virt });
  const a = new Uint8Array(cap), fa = new Uint8Array(Math.max(1, nF));
  for (let i = 0; i < N; i++) a[i] = st.level[i];   // no highlight at build: the code is the level
  for (let f = 0; f < nF; f++) fa[f] = st.famVis[f] > 0 ? 2 : 0;
  return { cap, mask, st, level: st.level, famVis: st.famVis, par, fam, cls, virt, a, fa, on: st.cnt[2] < st.n, pins, pinMints, speck: new Uint8Array(Math.max(1, nF)) };
}
