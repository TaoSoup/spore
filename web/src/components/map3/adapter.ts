// map3 data adapter (spec section 5): the app's node list, heat index, dominance tags and highlight
// predicate turned into what the WebGL engine takes. Pure functions over plain data: no React, no DOM
// (reducedMotionNow only reads matchMedia / the html dataset when they exist), so the unit tests run them
// under tsx in node. The engine never fetches; everything it draws comes through here.
import { familyValueOf, isThinFamily } from "../../lib/map/sizing";
import type { HeatIndex } from "../../lib/map/heat";
import type { BubbleNode, SizeMode } from "../../lib/map/types";
import type { EngineCoin, EngineHeat, EngineTree } from "./engine/index.js";

/// Container width at or below which the engine uses its phone layout (a crossing rebuilds).
export const PHONE_BAND_PX = 700;
/// Container width above which planet labels take the wide dominance tags (else the compact ones).
export const WIDE_PX = 900;
/// A coin the engine does not know is a birth only when it was created this recently (the engine's own
/// maybeBirth window): older coins wait for a rebuild.
export const BIRTH_MAX_AGE_S = 900;

// ---------------------------------------------------------------- tree

export type BuiltInput = { roots: EngineTree[]; mints: Set<string>; count: number; cyclesBroken: number };

/// The node list as the engine's forest (spec 5.2). A node is a root when it has no parent, its parent is
/// not in the list, or it names itself; children keep array order; the walk is pre-order DFS from the
/// roots in array order. A full load stored by useMapData is the server's DFS, so the output reproduces
/// the API order exactly (the engine's per-index jitter depends on it); a node appended later lands as the
/// last child of its parent, or the last root. Nodes no root reaches (a parent cycle) are walked from the
/// first unvisited one in array order, as a root (counted in cyclesBroken). A repeated mint keeps its
/// first occurrence. The coin handed to the engine is the BubbleNode itself.
export function buildRoots(nodes: readonly BubbleNode[]): BuiltInput {
  const n = nodes.length;
  const at = new Map<string, number>();
  const dup = new Uint8Array(n);
  for (let q = 0; q < n; q++) { const m = nodes[q].mint; if (at.has(m)) dup[q] = 1; else at.set(m, q); }
  // children as linked lists in array order (head / tail / next), roots in array order
  const head = new Int32Array(n).fill(-1), tail = new Int32Array(n).fill(-1), next = new Int32Array(n).fill(-1);
  const rootIdx: number[] = [];
  for (let q = 0; q < n; q++) {
    if (dup[q]) continue;
    const pm = nodes[q].parentMint;
    const p = pm ? at.get(pm) : undefined;
    if (p === undefined || p === q) { rootIdx.push(q); continue; }
    if (head[p] < 0) head[p] = q; else next[tail[p]] = q;
    tail[p] = q;
  }
  const seen = new Uint8Array(n);
  const roots: EngineTree[] = [];
  const mints = new Set<string>();
  let count = 0;
  // iterative pre-order walk: a stack of (tree, next child index) frames, children pushed in order
  const walk = (r: number): EngineTree => {
    seen[r] = 1; count++; mints.add(nodes[r].mint);
    const top: EngineTree = { coin: nodes[r], children: [] };
    const stackT: EngineTree[] = [top], stackC: number[] = [head[r]];
    while (stackT.length) {
      const d = stackT.length - 1;
      let c = stackC[d];
      while (c >= 0 && seen[c]) c = next[c]; // a cycle edge back into the walk
      if (c < 0) { stackT.pop(); stackC.pop(); continue; }
      stackC[d] = next[c];
      seen[c] = 1; count++; mints.add(nodes[c].mint);
      const t: EngineTree = { coin: nodes[c], children: [] };
      stackT[d].children.push(t);
      stackT.push(t); stackC.push(head[c]);
    }
    return top;
  };
  for (const r of rootIdx) roots.push(walk(r));
  let cyclesBroken = 0;
  for (let q = 0; q < n; q++) if (!dup[q] && !seen[q]) { roots.push(walk(q)); cyclesBroken++; }
  return { roots, mints, count, cyclesBroken };
}

// ---------------------------------------------------------------- whole-family totals (compact builds)

/// One family of the FULL input (every node), for a build made from the Key's filtered set (2026-11-10): its chips, ranks,
/// labels and ghosts stay those of the whole family. id = its index in the full roots (= the full build's family id), start =
/// the pre-order index of its top in the full build (its members follow), locked / mcap = Σ of the value functions over its
/// members in pre-order (the order data.js sums in, so shares are bit-identical), members, kids = the top's drawn children,
/// ghost = the undrawn coins of a listed-asset top (data.js f.ghost over the WHOLE drawn slice).
export type WholeFamily = { id: number; start: number; locked: number; mcap: number; members: number; kids: number; ghost: number };
export type WholeTotals = {
  /** Top mint -> whole family. */
  families: Map<string, WholeFamily>;
  /** Root order (id = index); `start` ascending, so a pre-order index finds its family by binary search. */
  list: WholeFamily[];
  /** Coin mint -> its pre-order index in the full build: the compact layout's per-coin seed (stable across filtered builds). */
  seed: Map<string, number>;
  /** Σ over EVERY family (dropped ones included) and the largest share in each mode (= the full build's S.maxShare). */
  totals: { locked: number; mcap: number };
  maxShare: { locked: number; mcap: number };
  /** The whole map: coins, ghosts and families (the canvas's aria label). */
  coins: number; ghosts: number; familyCount: number;
};
/// Whole-family numbers of the full input (see WholeFamily). O(n).
export function familyTotals(full: BuiltInput, fns: { locked: (c: EngineCoin) => number; mcap: (c: EngineCoin) => number }): WholeTotals {
  const families = new Map<string, WholeFamily>(), list: WholeFamily[] = [], seed = new Map<string, number>();
  const num = (fn: (c: EngineCoin) => number, c: EngineCoin) => { let v: number; try { v = Number(fn(c)); } catch { v = 0; } return Number.isFinite(v) && v > 0 ? v : 0; };
  let k = 0, totL = 0, totM = 0, ghosts = 0;
  const stack: EngineTree[] = [];
  for (const r of full.roots) {
    const w: WholeFamily = { id: list.length, start: k, locked: 0, mcap: 0, members: 0, kids: r.children.length, ghost: 0 };
    stack.length = 0; stack.push(r);
    while (stack.length) {
      const t = stack.pop()!;
      const c = t.coin;
      if (!seed.has(c.mint)) seed.set(c.mint, k);
      k++; w.members++;
      w.locked += num(fns.locked, c); w.mcap += num(fns.mcap, c);
      for (let q = t.children.length - 1; q >= 0; q--) stack.push(t.children[q]);
    }
    const top = r.coin as BubbleNode & { asset?: boolean }, ch = Number(top.children);
    w.ghost = top.asset === true && Number.isFinite(ch) ? Math.max(0, Math.floor(ch) - w.kids) : 0;
    ghosts += w.ghost;
    totL += w.locked; totM += w.mcap;
    list.push(w);
    if (!families.has(top.mint)) families.set(top.mint, w);
  }
  let mL = 0, mM = 0;
  for (const w of list) { const sL = totL > 0 ? w.locked / totL : 0, sM = totM > 0 ? w.mcap / totM : 0; if (sL > mL) mL = sL; if (sM > mM) mM = sM; }
  return { families, list, seed, totals: { locked: totL, mcap: totM }, maxShare: { locked: mL, mcap: mM }, coins: k, ghosts, familyCount: list.length };
}

// ---------------------------------------------------------------- values, shares, heat, tags

const finitePos = (v: number | null | undefined): number => (v != null && Number.isFinite(v) && v > 0 ? v : 0);

/// A coin's part of its family's value in a size mode (lib/map/sizing familyValueOf; server lib/dominance.mjs
/// is the same rule): locked = lockedUsd (a coin that locks nothing adds nothing); mcap = 0 for a listed asset
/// top, else mcapCapUsd ?? mcapUsd. Null, non-finite and negative become 0.
/// With `roots` in "mcap", the members of a thin family (sizing isThinFamily: Σ lockedUsd over the
/// family) take their locked-mode value, as sizing familyWeights and server familyShares do.
export function valueFn(mode: SizeMode, roots?: readonly EngineTree[]): (c: EngineCoin) => number {
  if (mode !== "mcap" || !roots) return (c) => finitePos(familyValueOf(c as BubbleNode, mode));
  const thin = new Set<EngineCoin>();
  const stack: EngineTree[] = [], members: EngineCoin[] = [];
  for (const r of roots) {
    let locked = 0;
    members.length = 0; stack.length = 0; stack.push(r);
    while (stack.length) {
      const t = stack.pop()!;
      members.push(t.coin);
      const l = (t.coin as BubbleNode).lockedUsd;
      if (l != null && l > 0) locked += l;
      for (const k of t.children) stack.push(k);
    }
    if (isThinFamily(members.length, locked)) for (const c of members) thin.add(c);
  }
  return (c) => finitePos(familyValueOf(c as BubbleNode, thin.has(c) ? "locked" : mode));
}
/// Both modes' value functions for the engine (EngineOptions.values; `roots` = the tree it builds, for the thin-family
/// guard in mcap). The engine ranks families by their best rank in either mode, so the planet set and the family
/// order do not change when the size mode does; only the chip sizes (shares) do.
export function valueFns(roots?: readonly EngineTree[]): { locked: (c: EngineCoin) => number; mcap: (c: EngineCoin) => number } {
  return { locked: valueFn("locked"), mcap: valueFn("mcap", roots) };
}

/// Family-top mint → share of value (Σ value over the family / Σ over every family), as the engine
/// computes it. With every root drawn this equals lib/map/dominance byTop share (for the tests).
export function familyShares(input: BuiltInput, valueOf: (c: EngineCoin) => number): Map<string, number> {
  const vals: number[] = [];
  let total = 0;
  const stack: EngineTree[] = [];
  for (const r of input.roots) {
    let v = 0;
    stack.push(r);
    while (stack.length) {
      const t = stack.pop()!;
      v += finitePos(valueOf(t.coin));
      // pushed in reverse so members are summed in pre-order (the same order as the engine and dominance)
      for (let k = t.children.length - 1; k >= 0; k--) stack.push(t.children[k]);
    }
    vals.push(v);
    total += v;
  }
  const out = new Map<string, number>();
  input.roots.forEach((r, k) => out.set(r.coin.mint, total > 0 ? vals[k] / total : 0));
  return out;
}

/// The heat index as the wire's parallel arrays (rows in Map order); null in, null out.
export function heatPayload(h: HeatIndex | null): EngineHeat | null {
  if (!h) return null;
  const n = h.rows.size;
  const mint = new Array<string>(n), last = new Array<number>(n), n24 = new Array<number>(n), t1h = new Array<number>(n), v24 = new Array<number>(n), buys1h = new Array<number>(n);
  let k = 0;
  for (const [m, r] of h.rows) { mint[k] = m; last[k] = r.last; n24[k] = r.n24; t1h[k] = r.t1h; v24[k] = r.v24; buys1h[k] = r.buys1h; k++; }
  return { at: h.at, mint, last, n24, t1h, v24, buys1h };
}

/// Family-top mint → the dominance tag the page prints ("23%"), or null (no percent).
export function tagFn(tags: ReadonlyMap<string, string> | null | undefined): (topMint: string) => string | null {
  return (m) => tags?.get(m) ?? null;
}

// ---------------------------------------------------------------- live node sync

/// The node objects the engine has seen, by mint (identity diff for patches; the built set for `removed`).
export type DiffState = { seen: Map<string, BubbleNode> };
export function createDiffState(nodes: readonly BubbleNode[]): DiffState {
  const seen = new Map<string, BubbleNode>();
  for (const n of nodes) seen.set(n.mint, n);
  return { seen };
}

/// A known coin's change for EngineHandle.patchCoins: the market cap always, `image` only when the logo URL changed.
export type NodePatch = { mint: string; mcapUsd: number | null; image?: string | null };
export type NodeDiff = { births: { coin: BubbleNode; parent: BubbleNode | null }[]; patches: NodePatch[]; unknown: number; removed: number; wanted: string[] };
/// A filtered (compact) build's diff rules; absent = every unknown coin counts (a mask-15 build: today's behaviour).
export type DiffOpts = {
  /** Only these unknown coins count (their class is in the mask, or they are pinned); the rest were left out on purpose. */
  wanted?: (n: BubbleNode) => boolean;
  /** Collect up to this many wanted unknown mints (not births) into NodeDiff.wanted: the sync reveals them live. */
  wantMax?: number;
  /** A birth may hang from a parent the engine does not know but the page holds (the engine reveals the parent first). */
  pageParents?: boolean;
};

/// One pass over the node list (spec 5.7), O(n):
/// - births: coins the engine does not know whose parent it knows, created within BIRTH_MAX_AGE_S of nowS
///   (unix s), with the parent node when the page holds it;
/// - patches: known coins whose node object changed since the last pass and whose mcapUsd or image differs
///   (`image` is set only when the URL changed: a since= delta or a mapdelta that brings a logo the build did
///   not have; the engine copied img[] at build and would never see it otherwise); a known coin seen for the
///   first time, such as a birth the engine placed, is only recorded;
/// - unknown: coins the engine does not know that are not births;
/// - removed: coins in the state's set (what the engine built, plus coins recorded since) that are no
///   longer in the list.
/// Updates `state.seen` for the known coins. `o`: a filtered build's rules (DiffOpts).
export function diffNodes(state: DiffState, nodes: readonly BubbleNode[], byMint: ReadonlyMap<string, BubbleNode>, knows: (mint: string) => boolean, nowS: number, o: DiffOpts = {}): NodeDiff {
  const births: NodeDiff["births"] = [], patches: NodeDiff["patches"] = [], wanted: string[] = [];
  const seen = state.seen, want = o.wanted, wantMax = o.wantMax ?? 0, pageParents = !!o.pageParents;
  const minCreated = nowS - BIRTH_MAX_AGE_S;
  let unknown = 0, present = 0;
  for (const n of nodes) {
    const m = n.mint;
    const prev = seen.get(m);
    if (prev !== undefined) present++;
    if (knows(m)) {
      if (prev === n) continue;
      if (prev !== undefined) {
        if ((prev.image ?? null) !== (n.image ?? null)) patches.push({ mint: m, mcapUsd: n.mcapUsd, image: n.image ?? null });
        else if (!Object.is(prev.mcapUsd, n.mcapUsd)) patches.push({ mint: m, mcapUsd: n.mcapUsd });
      }
      if (prev === undefined) present++;
      seen.set(m, n);
      continue;
    }
    const pm = n.parentMint;
    const c = n.createdAt;
    // the age window first: only a coin younger than BIRTH_MAX_AGE_S needs the parent lookups (a filtered build leaves ~95 % of
    // the list unknown, and knows() misses are the slow path)
    if (pm && pm !== m && typeof c === "number" && Number.isFinite(c) && c >= minCreated && (knows(pm) || (pageParents && byMint.has(pm)))) births.push({ coin: n, parent: byMint.get(pm) ?? null });
    else if (!want) unknown++;
    else if (want(n)) { unknown++; if (wanted.length < wantMax) wanted.push(m); }
  }
  return { births, patches, unknown, removed: Math.max(0, seen.size - present), wanted };
}

/// (compact layout) A node pass's live reveals (use-engine-sync): the wanted mints in order, until `max` of them got an answer
/// that is not a lasting refusal. "family" and "parent" hold for the build's life (the engine answers them again from a cache,
/// O(1)), so they do not use the budget: a run of coins from families the build left out cannot starve a placeable coin after
/// it. At most `scan` mints are looked at. Returns the reveals that used the budget.
export function revealWanted(wanted: readonly string[], reveal: (mint: string) => string, max: number, scan = 4_096): number {
  let used = 0;
  for (let k = 0; k < wanted.length && k < scan && used < max; k++) { const r = reveal(wanted[k]); if (r !== "family" && r !== "parent") used++; }
  return used;
}

/// A filtered (compact) engine's own drift (EngineHandle.driftStats): built coins, built coins hidden since the build (heat
/// ageing, under the build's own mask), coins revealed live (hover reveals not counted), coins the view wants that could not be
/// placed, those of them whose whole family the build left out (`family`: never placed live), the reveal room used up, and a
/// selection that is only a revealed stand-in.
export type FilteredDrift = { built: number; hidden: number; revealed: number; missed: number; family: number; full: boolean; select: boolean };
/// (compact layout) The drift count of a filtered build's wanted unknown coins, each once: the node pass's count (`unknown`), less
/// those of its `collected` mints the engine has drawn since or already counts in FilteredDrift.missed (`stillOut` =
/// EngineDriftStats.wanted, the collected ones still out and not missed; absent = all of them).
export function filteredUnknown(unknown: number, collected: number, stillOut: number | undefined): number {
  return Math.max(0, unknown - Math.max(0, collected - (stillOut ?? collected)));
}
/// card: (compact layout) a coin card is open (the page has a selection); read by the filtered branch only.
export type DriftInput = { unknown: number; removed: number; coins: number; idleMs: number; sinceBuildMs: number; firstSyncAfterCache: boolean; filtered?: FilteredDrift; card?: boolean };

/// Rebuild when the drawn set drifted from the data by max(200, 1 % of the coins) and the map is idle:
/// 3 s idle on the first sync after a cache paint, else 10 s idle and at least 10 min since the build.
/// A filtered (compact) build (d.filtered): the churn also counts its hidden, revealed and missed coins, against min(that,
/// max(100, 10 % of the built coins)), so the map re-compacts around what is shown; a coin the view wants from a family the build
/// left out (f.family: never placed live) is enough by itself once the build is FAMILY_WAKE_MS old (a dormant family's trade is
/// common, so a shorter wait would re-lay an idle map out every 10 min); the reveal room used up re-compacts
/// after 10 s idle and at least 2 min since the build (never on the spot: refusals keep counting meanwhile). Never while a coin
/// card is open (d.card): a relayout under it would move the coin the viewer reads about (it waits for the card to close; a
/// selection that is only a revealed stand-in, f.select, is not a reason either: ThreeMap's select echo rebuilds an explicit
/// pick at once instead). `unknown` is the caller's count of wanted unknown coins NOT already in f.missed (each coin counts
/// once).
/// (compact layout) how old a filtered build must be before a coin wanted from a family it left out re-compacts it by itself.
export const FAMILY_WAKE_MS = 1_800_000;
export function shouldRebuild(d: DriftInput): boolean {
  const f = d.filtered;
  if (f) {
    if (d.card) return false;
    if (f.full) return d.idleMs >= 10_000 && d.sinceBuildMs >= 120_000;
    const churn = d.unknown + d.removed + f.hidden + f.revealed + f.missed;
    const drifted = churn >= Math.min(Math.max(200, 0.01 * d.coins), Math.max(100, 0.1 * f.built));
    if (!drifted && !(f.family > 0)) return false;
    if (drifted && d.firstSyncAfterCache) return d.idleMs >= 3_000;
    return d.idleMs >= 10_000 && d.sinceBuildMs >= (drifted ? 600_000 : FAMILY_WAKE_MS);
  }
  if (d.unknown + d.removed < Math.max(200, 0.01 * d.coins)) return false;
  if (d.firstSyncAfterCache) return d.idleMs >= 3_000;
  return d.idleMs >= 10_000 && d.sinceBuildMs >= 600_000;
}

/// The quick drift rule after a cache paint (DriftInput.firstSyncAfterCache), within `windowMs` of the engine's build: the first
/// engine of a mount that painted the IndexedDB cache (seq 1), and (compact layout) an engine a Key filter's build made from the
/// cache's list before the network sync landed (`cacheInput`: a "last" rebuild can replace the first engine before that).
export function quickAfterCache(o: { firstBuildFromCache: boolean; seq: number; cacheInput: boolean; sinceBuildMs: number }, windowMs: number): boolean {
  return ((o.firstBuildFromCache && o.seq === 1) || o.cacheInput) && o.sinceBuildMs < windowMs;
}

/// (compact layout) Whether a size-mode rebuild keeps the family order of the engine on screen (EngineOptions.order, SPEC 3.3):
/// only when THAT engine was built with the same mask (the last build started may be an aborted one of another mask), and never
/// from a filtered engine into a full build (its order lists only the families it held: data.js would demote all the others).
export function keepsOrder(shown: { mask: number; filtered: boolean } | null, mask: number, filtered: boolean): boolean {
  return !!shown && shown.mask === mask && (filtered || !shown.filtered);
}

/// (galaxy) The viewer's drags kept across a mount's rebuilds (ThreeMap): a full build's offsets, and those of the filtered builds
/// of one mask (a filtered build designs other spots). filtMask = the mask of the filtered engine that LANDED with `filt`.
export type MoveOffset = { dx: number; dy: number };
export type MovedMaps = { full: Map<string, MoveOffset>; filt: Map<string, MoveOffset>; filtMask: number };
/// The map a build starts from and records into: the full one, the filtered one of the same mask, else a new one that becomes
/// `filt` only when its engine lands (movedLanded), so a build that is aborted (a toggle back) changes nothing.
export function movedFor(mv: MovedMaps, filtered: boolean, mask: number): Map<string, MoveOffset> {
  return !filtered ? mv.full : mv.filtMask === mask ? mv.filt : new Map();
}
export function movedLanded(mv: MovedMaps, filtered: boolean, mask: number, map: Map<string, MoveOffset>): void {
  if (filtered) { mv.filt = map; mv.filtMask = mask; }
}

/// The page's highlight predicate as a per-mint test for the engine's mask (a mint the page does not
/// hold never matches); null when there is no highlight. (family-all) `extra` resolves a coin the page holds outside
/// the node list (a loaded speck of a capped family: the family store's node).
export function highlightTest(pred: ((n: BubbleNode) => boolean) | null, byMint: ReadonlyMap<string, BubbleNode>, extra?: (mint: string) => BubbleNode | null | undefined): ((mint: string) => boolean) | null {
  if (!pred) return null;
  return (mint) => { const n = byMint.get(mint) ?? (extra ? extra(mint) : undefined); return !!n && pred(n); };
}

/// Reduced motion now: the OS setting, or the site's own pause (html[data-motion="paused"]).
export function reducedMotionNow(): boolean {
  try {
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
    return typeof document !== "undefined" && document.documentElement?.dataset?.motion === "paused";
  } catch { return false; }
}
