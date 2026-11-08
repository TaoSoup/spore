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

export type NodeDiff = { births: { coin: BubbleNode; parent: BubbleNode | null }[]; patches: { mint: string; mcapUsd: number | null }[]; unknown: number; removed: number };

/// One pass over the node list (spec 5.7), O(n):
/// - births: coins the engine does not know whose parent it knows, created within BIRTH_MAX_AGE_S of nowS
///   (unix s), with the parent node when the page holds it;
/// - patches: known coins whose node object changed since the last pass and whose mcapUsd differs (a
///   known coin seen for the first time, such as a birth the engine placed, is only recorded);
/// - unknown: coins the engine does not know that are not births;
/// - removed: coins in the state's set (what the engine built, plus coins recorded since) that are no
///   longer in the list.
/// Updates `state.seen` for the known coins.
export function diffNodes(state: DiffState, nodes: readonly BubbleNode[], byMint: ReadonlyMap<string, BubbleNode>, knows: (mint: string) => boolean, nowS: number): NodeDiff {
  const births: NodeDiff["births"] = [], patches: NodeDiff["patches"] = [];
  const seen = state.seen;
  const minCreated = nowS - BIRTH_MAX_AGE_S;
  let unknown = 0, present = 0;
  for (const n of nodes) {
    const m = n.mint;
    const prev = seen.get(m);
    if (prev !== undefined) present++;
    if (knows(m)) {
      if (prev === n) continue;
      if (prev !== undefined && !Object.is(prev.mcapUsd, n.mcapUsd)) patches.push({ mint: m, mcapUsd: n.mcapUsd });
      if (prev === undefined) present++;
      seen.set(m, n);
      continue;
    }
    const pm = n.parentMint;
    const c = n.createdAt;
    if (pm && pm !== m && knows(pm) && typeof c === "number" && Number.isFinite(c) && c >= minCreated) births.push({ coin: n, parent: byMint.get(pm) ?? null });
    else unknown++;
  }
  return { births, patches, unknown, removed: Math.max(0, seen.size - present) };
}

export type DriftInput = { unknown: number; removed: number; coins: number; idleMs: number; sinceBuildMs: number; firstSyncAfterCache: boolean };

/// Rebuild when the drawn set drifted from the data by max(200, 1 % of the coins) and the map is idle:
/// 3 s idle on the first sync after a cache paint, else 10 s idle and at least 10 min since the build.
export function shouldRebuild(d: DriftInput): boolean {
  if (d.unknown + d.removed < Math.max(200, 0.01 * d.coins)) return false;
  if (d.firstSyncAfterCache) return d.idleMs >= 3_000;
  return d.idleMs >= 10_000 && d.sinceBuildMs >= 600_000;
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
