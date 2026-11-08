// map3 live sync (spec 5.6-5.13): keeps a mounted engine current with the page's data without ever
// rebuilding it. Trades and pairs come from the tab's one shared stream (lib/events subscribe; nothing
// here opens a connection or fetches), heat from the page's poller, the node list at most once per second
// (births, mcap patches, drift), plus the stream status, reduced motion, the highlight and the dominance
// tags. A rebuild is ThreeMap's job: this hook only reports drift through onDrift.
import { useEffect, useMemo, useRef } from "react";
import { subscribe, type StreamStatus } from "../../lib/events";
import type { HeatIndex } from "../../lib/map/heat";
import type { BubbleNode } from "../../lib/map/types";
import { createDiffState, diffNodes, heatPayload, highlightTest, reducedMotionNow, shouldRebuild, tagFn, type DiffState } from "./adapter";
import type { EngineHandle } from "./engine/index.js";
import type { FamilyStore } from "../../lib/map/family-types";

export type EngineSyncParams = {
  engine: EngineHandle | null;
  nodes: readonly BubbleNode[];
  byMint: ReadonlyMap<string, BubbleNode>;
  fresh: Set<string>;
  heat: HeatIndex | null;
  streamStatus: StreamStatus;
  highlight: ((n: BubbleNode) => boolean) | null;
  tags: ReadonlyMap<string, string> | null;
  /** (family-all) the family loader: a loaded speck's node answers the highlight predicate (absent = specks never match). */
  families?: FamilyStore | null;
  builtAt: number;
  firstBuildFromCache: boolean;
  lastInteract: () => number;
  onDrift: (reason: "drift") => void;
};
export type EngineSyncStats = { dataMsLast: number; dataMsMax: number; births: number; patches: number; unknown: number; removed: number; events: number; heatAt: number; feed: "up" | "down" };
export type EngineSync = { stats(): EngineSyncStats; resetMax(): void };

/// Node passes run at most this often (trailing: the last change always gets a pass).
const SYNC_MS = 1_000;
/// Caught engine errors logged per engine.
const MAX_ERRORS = 3;
/// The first engine of a mount that painted the IndexedDB cache takes the quick drift rule
/// (firstSyncAfterCache) for this long after its build: the network sync lands within it.
const CACHE_SYNC_WINDOW_MS = 120_000;
/// onDrift is repeated for the same engine at most this often (ThreeMap may be busy rebuilding).
const DRIFT_REPEAT_MS = 60_000;

/// While the drawn set has drifted but the map is not idle yet, the drift rule is checked again this often.
const RECHECK_MS = 2_000;

/// "Now" on the clock a timestamp was taken with: epoch ms (Date.now) or the page clock (performance.now).
const nowLike = (t: number) => (t > 1e12 ? Date.now() : performance.now());

/// errors: caught engine errors so far; diff: the identity state of the node passes; seq: 1 for the first
/// engine of this mount; driftAt / heatAt: the last onDrift (page ms) and the last heat poll sent (unix s).
type PerEngine = { engine: EngineHandle | null; errors: number; diff: DiffState | null; seq: number; driftAt: number; heatAt: number };
const perEngine = (engine: EngineHandle | null, seq: number): PerEngine => ({ engine, errors: 0, diff: null, seq, driftAt: -Infinity, heatAt: -Infinity });

export function useEngineSync(p: EngineSyncParams): EngineSync {
  const props = useRef(p);
  props.current = p;
  const st = useRef<EngineSyncStats>({ dataMsLast: 0, dataMsMax: 0, births: 0, patches: 0, unknown: 0, removed: 0, events: 0, heatAt: 0, feed: "down" });
  const record = (ms: number) => { const s = st.current; s.dataMsLast = ms; if (ms > s.dataMsMax) s.dataMsMax = ms; };

  // Per-engine bookkeeping, reset when the engine changes (this effect is declared first, so it runs
  // before the others of the same commit; a StrictMode re-run with the same engine keeps it).
  const cur = useRef<PerEngine>(perEngine(null, 0));
  const engineSeq = useRef(0);
  const { engine } = p;
  useEffect(() => {
    if (cur.current.engine === engine) return;
    if (engine) engineSeq.current++;
    cur.current = perEngine(engine, engineSeq.current);
  }, [engine]);
  const fail = (e: unknown) => { if (cur.current.errors++ < MAX_ERRORS) console.error("map3", e); };

  // Trades and pairs from the shared stream, one subscription per engine.
  useEffect(() => {
    if (!engine) return;
    return subscribe({
      trade: (t) => {
        const t0 = performance.now();
        try { engine.applyEvent({ name: "trade", data: { mint: t.mint, time: t.time, isBuy: t.isBuy, valueUsd: t.valueUsd ?? null } }); } catch (e) { fail(e); }
        st.current.events++; record(performance.now() - t0);
      },
      pair: (ev) => {
        const t0 = performance.now();
        try { engine.applyEvent({ name: "pair", data: { coin: ev.coin, parent: ev.parent ?? null } }); } catch (e) { fail(e); }
        st.current.events++; record(performance.now() - t0);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // Heat: only a newer poll (identity-only changes are live trades the engine already got as events).
  const { heat } = p;
  useEffect(() => {
    if (!engine || !heat) return;
    const c = cur.current;
    if (!(heat.at > c.heatAt)) return;
    c.heatAt = heat.at;
    const t0 = performance.now();
    try { const payload = heatPayload(heat); if (payload) engine.setHeat(payload); } catch (e) { fail(e); }
    st.current.heatAt = heat.at;
    record(performance.now() - t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, heat]);

  // Stream status.
  const { streamStatus } = p;
  useEffect(() => {
    if (!engine) return;
    const feed = streamStatus === "live" ? "up" : "down";
    st.current.feed = feed;
    try { engine.setFeed(feed); } catch (e) { fail(e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, streamStatus]);

  // Reduced motion, live: the OS setting and the site's pause switch (html[data-motion]).
  useEffect(() => {
    if (!engine) return;
    let last: boolean | null = null;
    const apply = () => {
      const on = reducedMotionNow();
      if (on === last) return;
      last = on;
      try { engine.setReducedMotion(on); } catch (e) { fail(e); }
    };
    apply();
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    mq?.addEventListener("change", apply);
    const mo = typeof MutationObserver === "function" && typeof document !== "undefined" ? new MutationObserver(apply) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    return () => { mq?.removeEventListener("change", apply); mo?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // Highlight: on a new predicate (births are re-covered by the node pass while one is set).
  const { highlight, byMint, families } = p;
  const nodeOf = useMemo(() => (families ? (m: string) => families.node(m) : undefined), [families]);
  useEffect(() => {
    if (!engine) return;
    try { engine.setHighlight(highlightTest(highlight, byMint, nodeOf)); } catch (e) { fail(e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, highlight, byMint, nodeOf]);

  // Dominance tags (ThreeMap picks the wide or compact map).
  const { tags } = p;
  useEffect(() => {
    if (!engine) return;
    try { engine.setTags(tagFn(tags)); } catch (e) { fail(e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tags]);

  // The node list, at most once per second (trailing).
  const lastPass = useRef(-Infinity);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { nodes } = p;
  useEffect(() => {
    if (!engine) return;
    const run = () => {
      timer.current = null;
      const c = cur.current, e = c.engine;
      if (!e) return;
      lastPass.current = performance.now();
      const q = props.current;
      const t0 = performance.now();
      try {
        q.fresh.clear(); // the classic renderer drains this; the engine does not use it
        // empty at first: the first pass records every coin the engine knows (one walk of the list, no patches)
        if (!c.diff) c.diff = createDiffState([]);
        const d = diffNodes(c.diff, q.nodes, q.byMint, (m) => e.knows(m), Date.now() / 1000);
        for (const b of d.births) {
          try { e.applyEvent({ name: "pair", data: { coin: b.coin, parent: b.parent } }); } catch (err) { fail(err); }
        }
        if (d.patches.length) e.patchCoins(d.patches);
        if (q.highlight) e.setHighlight(highlightTest(q.highlight, q.byMint, q.families ? (m: string) => q.families!.node(m) : undefined));
        const s = st.current;
        s.births += d.births.length; s.patches += d.patches.length; s.unknown = d.unknown; s.removed = d.removed;
        record(performance.now() - t0);
        const li = q.lastInteract(), built = q.builtAt;
        const sinceBuildMs = Math.max(0, nowLike(built) - built);
        const input = {
          unknown: d.unknown, removed: d.removed, coins: q.nodes.length,
          idleMs: Math.max(0, nowLike(li) - li), sinceBuildMs,
          firstSyncAfterCache: q.firstBuildFromCache && c.seq === 1 && sinceBuildMs < CACHE_SYNC_WINDOW_MS,
        };
        const now = performance.now();
        if (shouldRebuild(input)) { if (now - c.driftAt >= DRIFT_REPEAT_MS) { c.driftAt = now; q.onDrift("drift"); } }
        // drifted, but not idle (or not old) enough yet: look again soon even when no data arrives meanwhile
        else if (shouldRebuild({ ...input, idleMs: Infinity, sinceBuildMs: Infinity }) && !timer.current) timer.current = setTimeout(run, RECHECK_MS);
      } catch (err) { fail(err); record(performance.now() - t0); }
    };
    if (!timer.current) timer.current = setTimeout(run, Math.max(0, lastPass.current + SYNC_MS - performance.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, nodes]);
  // The pending pass dies with the engine and with the component.
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, [engine]);

  return useMemo<EngineSync>(() => ({
    stats: () => ({ ...st.current }),
    resetMax: () => { st.current.dataMsMax = 0; },
  }), []);
}
