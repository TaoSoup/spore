// map3 debug hooks (spec section 12, the architect's "hooks" list): window.__sporeMap for the headless QA
// scripts, keyed by mint and in page (viewport) CSS px like the classic renderer's, over the engine's
// index-based EngineDebug. Installed only when DEBUG_HOOKS (development, or ?debug on a production
// build); the unregister function deletes it only while it is still this object. window.__sporeMap3 holds
// the engine counters (no instance) and is never deleted, so a script can check that every engine died.
import { DEBUG_HOOKS } from "../../lib/map/debug";
import { imageStats } from "../../lib/map/images";
import type { BubbleNode } from "../../lib/map/types";
import { engineCounters, type EngineDebug, type EngineEvent, type EngineHandle } from "./engine/index.js";

export type Map3DebugCtx = {
  root(): HTMLElement | null; engine(): EngineHandle | null;
  byMint(): ReadonlyMap<string, BubbleNode>; tags(): { wide: ReadonlyMap<string, string> | null; compact: ReadonlyMap<string, string> | null };
  mountedAt: number; dataAt(): number; firstPaintAt(): number; builds(): number; lastBuild(): Record<string, unknown> | null;
  sync(): { stats(): Record<string, unknown>; resetMax(): void } | null;
  fit(): void; focusNode(mint: string): void;
};

type Win = { __sporeMap?: unknown; __sporeMap3?: unknown };
type Pt = { x: number; y: number; r: number };
type Key = string | number;

export function registerMap3Debug(ctx: Map3DebugCtx): () => void {
  if (!DEBUG_HOOKS || typeof window === "undefined") return () => {};
  const w = window as unknown as Win;
  if (!w.__sporeMap3) w.__sporeMap3 = { counters: engineCounters };

  const H = () => ctx.engine();
  const E = (): EngineDebug | null => ctx.engine()?.debug ?? null;
  const idxOf = (e: EngineDebug, mint: string) => (typeof mint === "string" ? e.indexOf(mint) : -1);
  const mintAt = (e: EngineDebug, i: number) => (i >= 0 ? e.mintAt(i) : null);
  const mints = (e: EngineDebug, list: number[]) => { const out: string[] = []; for (const i of list) { const m = e.mintAt(i); if (m) out.push(m); } return out; };
  /// The engine container's origin in page px (the layer fills the root's padding box).
  const origin = () => { const r = ctx.root(); if (!r) return { left: 0, top: 0 }; const b = r.getBoundingClientRect(); return { left: b.left + r.clientLeft, top: b.top + r.clientTop }; };
  const toPage = (p: Pt | null): Pt | null => { if (!p) return null; const o = origin(); return { x: p.x + o.left, y: p.y + o.top, r: p.r }; };
  /// A mint the engine draws → its index (the engine's debug functions take indices); anything else is
  /// handed over as is (a ticker: the engine resolves it to the biggest family with that symbol).
  const keyOf = (e: EngineDebug, k: Key): Key => { if (typeof k === "number") return k; const i = e.indexOf(k); return i >= 0 ? i : k; };
  const sync = () => ctx.sync()?.stats() ?? null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const dbg = {
    renderer: () => "three" as const,
    mountedAt: () => ctx.mountedAt,
    dataAt: () => ctx.dataAt(),
    firstPaintAt: () => ctx.firstPaintAt(),
    builds: () => ctx.builds(),
    lastBuild: () => ctx.lastBuild(),

    nodes: () => E()?.coins() ?? 0,
    has: (mint: string) => !!H()?.knows(mint),
    node: (mint: string) => {
      const e = E(); if (!e) return null;
      const i = idxOf(e, mint); if (i < 0) return null;
      const p = e.world(i); if (!p) return null;
      return { ...(ctx.byMint().get(mint) ?? { mint }), r: p.r, x: p.x, y: p.y };
    },
    screenOf: (mint: string) => { const e = E(); if (!e) return null; const i = idxOf(e, mint); return i < 0 ? null : toPage(e.screen(i)); },
    familyScreen: (mint: string) => { const e = E(); if (!e) return null; const i = idxOf(e, mint); return i < 0 ? null : toPage(e.familyScreen(i)); },
    zoom: () => H()?.zoom() ?? 0,
    camera: () => H()?.camera() ?? null,
    fit: () => ctx.fit(),
    fly: (mint: string) => { if (!H()?.knows(mint)) return false; ctx.focusNode(mint); return true; },
    zoomTo: (mint: string, kRel: number) => { const e = E(); if (!e) return false; const i = idxOf(e, mint); if (i < 0) return false; e.zoomTo(i, kRel); return true; },
    focusFamily: (key: string) => E()?.focusFamily(key) ?? Promise.resolve(null),
    flying: () => E()?.flying() ?? false,
    settled: () => E()?.settled() ?? false,
    selected: () => H()?.selected() ?? null,
    hovered: () => { const e = E(); return e ? mintAt(e, e.hovered()) : null; },
    hoverCluster: () => { const e = E(); return e ? mintAt(e, e.hoverTop()) : null; },
    children: (mint: string) => { const e = E(); if (!e) return []; const i = idxOf(e, mint); return i < 0 ? [] : mints(e, e.children(i)); },
    members: (mint: string) => { const e = E(); if (!e) return []; const i = idxOf(e, mint); return i < 0 ? [] : mints(e, e.members(i)); },
    clusters: (n = 10) => {
      const e = E(); if (!e) return [];
      const { wide, compact } = ctx.tags();
      return e.families(n).map((f) => {
        const root = e.mintAt(f.top) ?? "";
        return { root, count: f.count, size: f.size ?? f.count, title: f.title, tag: wide?.get(root) ?? "", tagC: compact?.get(root) ?? "", share: f.share, rank: f.rank, planet: f.planet, cx: f.cx, cy: f.cy, cr: f.Rc, hullN: 0 };
      });
    },
    sample: (n = 10) => {
      const e = E(); const out: { mint: string; parent: string }[] = [];
      if (!e || !(n > 0)) return out;
      // families by value (planets first), each walked top-down: every child with its parent
      for (const f of e.families(e.coins())) {
        for (const p of e.members(f.top)) {
          const pm = e.mintAt(p); if (!pm) continue;
          for (const c of e.children(p)) { const cm = e.mintAt(c); if (!cm) continue; out.push({ mint: cm, parent: pm }); if (out.length >= n) return out; }
        }
      }
      return out;
    },
    anyRoot: () => { const e = E(); if (!e) return null; const f = e.families(1)[0]; return f ? e.mintAt(f.top) : null; },
    pick: (x: number, y: number) => {
      const e = E(); if (!e) return { node: null, cluster: null, via: "none" as const };
      const o = origin(), r = e.pick(x - o.left, y - o.top);
      return { node: mintAt(e, r.i), cluster: mintAt(e, r.top), via: r.via };
    },
    clusterAt: (x: number, y: number) => { const e = E(); if (!e) return null; const o = origin(); return mintAt(e, e.pick(x - o.left, y - o.top).top); },
    lastTrade: (mint: string) => { const e = E(); if (!e) return 0; const i = idxOf(e, mint); return i < 0 ? 0 : e.lastTrade(i); },
    t1h: (mint: string) => { const e = E(); if (!e) return 0; const i = idxOf(e, mint); return i < 0 ? 0 : e.t1h(i); },
    fx: () => E()?.fx() ?? 0,
    titles: () => { const e = E(); return e ? mints(e, e.titles()) : []; },
    taggedTitles: () => { const e = E(); return e ? mints(e, e.taggedTitles()) : []; },
    labels: () => E()?.labelCount() ?? 0,
    drawn: () => E()?.drawnCount() ?? 0,
    frameStats: () => H()?.frameStats() ?? null,
    resetFrames: () => { E()?.resetFrames(); },
    images: imageStats,
    logo: (mint: string) => { const e = E(); if (!e) return 0; const i = idxOf(e, mint); return i < 0 ? 0 : e.logoPx(i); },
    testHighlight: (kind: "ours" | "min1k" | null) => {
      const e = E(); if (!e) return 0;
      if (!kind) return e.testHighlight(null);
      const byMint = ctx.byMint();
      // the page's hl tests (lib/map/highlight hlTest) for the two keys that need no context
      const pred = kind === "ours" ? (n: BubbleNode) => !!n.ours : (n: BubbleNode) => (n.mcapUsd ?? 0) >= 1_000;
      return e.testHighlight((i) => { const m = e.mintAt(i); const n = m ? byMint.get(m) : undefined; return !!n && pred(n); });
    },
    hl: (mint: string) => { const e = E(); if (!e) return 0; const i = idxOf(e, mint); return i < 0 ? 0 : e.hlBit(i); },
    xy: (list: string[]) => {
      const e = E(); const out: number[] = [];
      for (const m of list) { const i = e ? idxOf(e, m) : -1; const p = e && i >= 0 ? e.world(i) : null; if (p) out.push(p.x, p.y); else out.push(NaN, NaN); }
      return out;
    },
    idx: (list: string[]) => { const e = E(); return list.map((m) => (e ? idxOf(e, m) : -1)); },
    allXY: () => { const e = E(); if (!e) return { n: 0, x: [] as number[], y: [] as number[] }; const a = e.allXY(); return { n: a.n, x: Array.from(a.x.subarray(0, a.n)), y: Array.from(a.y.subarray(0, a.n)) }; },
    drag: () => { const e = E(); const d = e?.drag(); return e && d ? { node: e.mintAt(d.i), root: mintAt(e, d.top), n: 1, rigid: d.rigid } : null; },
    draws: () => E()?.renders() ?? 0,
    worker: () => {
      const e = E(); if (!e) return null;
      const s = e.sim();
      return { ticks: s.ticks, tickMs: s.tickMs, frames: e.renders(), n: e.coins(), alpha: s.alpha, settled: !s.active, at: performance.now() };
    },
    dataMs: () => { const s = sync(); return { last: num(s?.dataMsLast), max: num(s?.dataMsMax) }; },
    resetDataMs: () => { ctx.sync()?.resetMax(); },
    sync: () => sync(),
    engine: () => {
      const e = E(); if (!e) return null;
      const r = ctx.root(), g = e.gl(), m = e.motion(), l = e.live();
      return { ...e.build(), w: r?.clientWidth ?? 0, h: r?.clientHeight ?? 0, contextLost: g.contextLost, reduced: m.reduced, feed: l.feed };
    },
    gl: () => E()?.gl() ?? null,
    tip: () => { const e = E(); if (!e) return null; const t = e.tip(); return { on: t.on, mint: mintAt(e, t.i), dock: t.dock, text: t.text }; },
    measure: (ms: number, mode: "idle" | "pan" | "zoom" | "hover") => E()?.measure(ms, mode) ?? Promise.resolve(null),
    dragCoin: (key: Key, dx?: number, dy?: number, ms?: number, opts?: { hold?: number }) => { const e = E(); return e ? e.dragCoin(keyOf(e, key), dx, dy, ms, opts) : Promise.resolve(null); },
    feed: (name: "trade" | "pair", data: unknown) => E()?.feed({ name, data } as EngineEvent) ?? null,
    live: () => E()?.live() ?? null,
    motion: () => E()?.motion() ?? null,
    labelStats: () => E()?.labels() ?? null,
    overlapCheck: () => E()?.overlapCheck() ?? null,
    dustCheck: () => E()?.dustCheck() ?? null,
    limeShare: () => E()?.limeShare() ?? null,
    hdrCheck: () => E()?.hdrCheck() ?? null,
    /// The engine's look: build().look once the engine reports it, else the root's look-* class (Map.tsx ?look).
    look: () => { const e = E(); let b: Record<string, unknown> = {}; try { b = e?.build() ?? {}; } catch { b = {}; } if (b.look === "galaxy" || b.look === "flat") return b.look; return ctx.root()?.classList.contains("look-galaxy") ? "galaxy" : "flat"; },
    /// (family-all) the swarm layer (EngineSwarmStats: tier, slots, ghosts shown, real specks, queue, slice timings)
    swarm: () => { const e = E(); if (!e) return null; try { return typeof e.swarm === "function" ? e.swarm() : null; } catch { return null; } },
    /// (family-all) the engine's ghosted families (top mint, ghost, slots, real, cap)
    swarmFamilies: () => H()?.swarmFamilies() ?? [],
    /// (family-all, QA) the engine side of a store eviction: the family's real specks back to ghosts
    swarmDrop: (top: string) => { H()?.swarmDrop(top); },
    veinShare: () => { const e = E(); if (!e) return null; try { return e.veinShare?.() ?? null; } catch { return null; } },
    linkMaxPx: () => E()?.linkMaxPx() ?? null,
    hover: (key: Key | null) => { const e = E(); if (!e) return null; return e.hover(key == null ? null : keyOf(e, key)); },
    /// Any engine debug function by name (S.debugFns: coverage, logoCoverage, rope, home, moved, veinPath, focusState ...);
    /// index-based arguments and results, null when the engine or the function is absent.
    call: (name: string, ...a: unknown[]) => { const e = E(); if (!e || typeof e.call !== "function") return null; try { return e.call(name, ...a); } catch { return null; } },
    /// The focus pulse of the last paste / pick: its coin (mint), t and dim (0..1), drawn radius (CSS px), zoom, pinned label.
    focusState: () => { const e = E(); if (!e) return null; let s: ReturnType<EngineDebug["focusState"]> = null; try { s = typeof e.focusState === "function" ? e.focusState() : null; } catch { s = null; } return s ? { ...s, mint: mintAt(e, s.i), screen: s.i >= 0 ? toPage(e.screen(s.i)) : null } : null; },
    /// The raw index-based EngineDebug of the current engine (null while none is mounted).
    get eng() { return E(); },
  };

  w.__sporeMap = dbg;
  return () => { if (w.__sporeMap === dbg) delete w.__sporeMap; };
}
