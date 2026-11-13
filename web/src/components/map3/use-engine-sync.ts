// map3 live sync (spec 5.6-5.13): keeps a mounted engine current with the page's data without ever
// rebuilding it. Trades and pairs come from the tab's one shared stream (lib/events subscribe; nothing
// here opens a connection or fetches), heat from the page's poller, the node list at most once per second
// (births, mcap patches, drift), plus the stream status, reduced motion, the highlight, the Key's last-trade
// filter and the dominance tags. A rebuild is ThreeMap's job: this hook only reports drift through onDrift.
// (compact layout, 2026-11-10) an engine built from the Key's filtered set (`filtered`): a node pass counts only the left-out
// coins the view wants and reveals up to NODE_REVEAL_MAX of them live; its drift adds the engine's own (driftStats: coins
// aged out, added live, wanted from left-out families), checked on node passes, heat polls and every FILTERED_CHECK_MS, under
// the same idle gates and DRIFT_REPEAT_MS, and never while a coin card is open (`select`). A coin the node pass wants that the
// engine already counts as missed counts once.
// Such an engine applies the Key's mask intersected with the build's (`last & buildMask`): a bucket turned on shows nothing it
// has no compact layout for (class-3 ghosts and specks at compact spots) until the rebuild for the wider mask lands; a bucket
// turned off fades at once.
import { useEffect, useMemo, useRef } from "react";
import { subscribe, type StreamStatus } from "../../lib/events";
import type { HeatIndex } from "../../lib/map/heat";
import type { BubbleNode } from "../../lib/map/types";
import { createDiffState, diffNodes, filteredUnknown, heatPayload, highlightTest, quickAfterCache, reducedMotionNow, revealWanted, shouldRebuild, tagFn, type DiffOpts, type DiffState, type DriftInput } from "./adapter";
import { coinClass } from "../../lib/map/visibility";
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
  /** The Key's last-trade filter (bit k = show heat class k, 15 = all) and the mints always shown (the selection's lineage). */
  last: number; pinned: readonly string[];
  builtAt: number;
  firstBuildFromCache: boolean;
  lastInteract: () => number;
  onDrift: (reason: "drift") => void;
  /** (compact layout) The engine on screen was built from the Key's filtered set, with this mask (15 = the whole list). Its
   * node passes count only the unknown coins the view wants (class in both masks, or pinned) and reveal some of them; its own
   * drift (EngineHandle.driftStats) joins the rebuild rule. */
  filtered?: boolean; buildMask?: number;
  /** (compact layout) The page's selection: while a coin card is open a filtered engine never re-compacts (the rule is looked at
   * again when it closes). */
  select?: string | null;
  /** (compact layout) The engine on screen was built from the IndexedDB cache's list by a Key filter's build (filtered, or a
   * toggle's) before the network sync landed: it takes the quick cache rule as the first engine of the mount does. */
  cacheInput?: boolean;
};
export type EngineSyncStats = { dataMsLast: number; dataMsMax: number; births: number; patches: number; unknown: number; removed: number; events: number; heatAt: number; feed: "up" | "down" };
export type EngineSync = { stats(): EngineSyncStats; resetMax(): void };

/// Node passes run at most this often (trailing: the last change always gets a pass).
const SYNC_MS = 1_000;
/// Caught engine errors logged per engine.
const MAX_ERRORS = 3;
/// The first engine of a mount that painted the IndexedDB cache takes the quick drift rule
/// (firstSyncAfterCache) for this long after its build: the network sync lands within it. (compact layout) So does an engine
/// a Key filter's build made from the cache's list (cacheInput; adapter.ts quickAfterCache).
const CACHE_SYNC_WINDOW_MS = 120_000;
/// onDrift is repeated for the same engine at most this often (ThreeMap may be busy rebuilding).
const DRIFT_REPEAT_MS = 60_000;

/// While the drawn set has drifted but the map is not idle yet, the drift rule is checked again this often.
const RECHECK_MS = 2_000;
/// (compact layout) a filtered build drifts by itself (heat ageing, trades, reveals): its rule is also checked this often, and
/// after every heat poll, even while the node list does not change.
const FILTERED_CHECK_MS = 30_000;
/// (compact layout) wanted unknown coins a node pass reveals live (the rest count as drift); lasting refusals (a family the build
/// left out) do not use it (adapter.ts revealWanted).
const NODE_REVEAL_MAX = 32;
/// (compact layout) wanted unknown mints a node pass keeps for the drift count's de-duplication against the engine's missed set.
const WANTED_KEEP = 50_000;

/// "Now" on the clock a timestamp was taken with: epoch ms (Date.now) or the page clock (performance.now).
const nowLike = (t: number) => (t > 1e12 ? Date.now() : performance.now());

/// errors: caught engine errors so far; diff: the identity state of the node passes; seq: 1 for the first
/// engine of this mount; driftAt / heatAt: the last onDrift (page ms) and the last heat poll sent (unix s).
/// unknown / removed: the last node pass's counts (the drift checks between passes reuse them); wanted: (compact layout) the
/// wanted unknown mints of that pass (at most WANTED_KEEP), which the drift checks count once against the engine's missed set.
/// relinked: coins the engine draws in another family than their page parent (adapter diffNodes), summed until the rebuild;
/// checked: the first node pass of this engine compared every known coin (later passes only the changed ones).
type PerEngine = { engine: EngineHandle | null; errors: number; diff: DiffState | null; seq: number; driftAt: number; heatAt: number; unknown: number; removed: number; wanted: string[]; relinked: number; checked: boolean };
const perEngine = (engine: EngineHandle | null, seq: number): PerEngine => ({ engine, errors: 0, diff: null, seq, driftAt: -Infinity, heatAt: -Infinity, unknown: 0, removed: 0, wanted: [], relinked: 0, checked: false });


export function useEngineSync(p: EngineSyncParams): EngineSync {
  const props = useRef(p);
  props.current = p;
  // the coins that already asked for a rebuild because the engine drew them in another family than their page parent
  const relinkTried = useRef(new Set<string>());
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

  // The drift rule (adapter.ts shouldRebuild) for the engine on screen, from the last node pass's counts and, for a filtered
  // (compact) build, the engine's own drift. Returns true when the data drifted enough to rebuild once the map is idle (and
  // old) enough. A filtered build re-checks itself every RECHECK_MS while that holds (a node pass may not come); while a coin
  // card is open it does not re-layout at all (DriftInput.card): the effect below looks again when the card closes.
  const driftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const evalDrift = (): boolean => {
    const c = cur.current, e = c.engine, q = props.current;
    if (!e) return false;
    const li = q.lastInteract(), built = q.builtAt;
    const sinceBuildMs = Math.max(0, nowLike(built) - built);
    let filtered: DriftInput["filtered"], unknown = c.unknown;
    if (q.filtered) {
      const s = e.driftStats(c.wanted);
      if (s && s.filtered) { filtered = { built: s.built, hidden: s.hidden, revealed: s.revealed, missed: s.missed, family: s.family ?? 0, full: s.full, select: s.select }; unknown = filteredUnknown(c.unknown, c.wanted.length, s.wanted); }
    }
    const input: DriftInput = {
      unknown, removed: c.removed, coins: q.nodes.length,
      idleMs: Math.max(0, nowLike(li) - li), sinceBuildMs,
      firstSyncAfterCache: quickAfterCache({ firstBuildFromCache: q.firstBuildFromCache, seq: c.seq, cacheInput: !!q.cacheInput, sinceBuildMs }, CACHE_SYNC_WINDOW_MS),
      filtered, card: q.select != null, relinked: c.relinked,
    };
    const now = performance.now();
    if (shouldRebuild(input)) { if (now - c.driftAt >= DRIFT_REPEAT_MS) { c.driftAt = now; q.onDrift("drift"); } return false; }
    const pending = shouldRebuild({ ...input, idleMs: Infinity, sinceBuildMs: Infinity });
    if (pending && filtered && !driftTimer.current) driftTimer.current = setTimeout(() => { driftTimer.current = null; try { evalDrift(); } catch (err) { fail(err); } }, RECHECK_MS);
    return pending;
  };
  // a filtered build drifts by itself: look every FILTERED_CHECK_MS (the heat poll below looks too)
  const { filtered } = p;
  useEffect(() => {
    if (!engine || !filtered) return;
    const id = setInterval(() => { try { evalDrift(); } catch (err) { fail(err); } }, FILTERED_CHECK_MS);
    return () => { clearInterval(id); if (driftTimer.current) { clearTimeout(driftTimer.current); driftTimer.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, filtered]);
  // (compact layout) a coin card that closes: a re-compaction held for it may run now (the idle gates still apply)
  const cardOpen = p.select != null;
  useEffect(() => {
    if (!engine || !filtered || cardOpen) return;
    try { evalDrift(); } catch (err) { fail(err); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, filtered, cardOpen]);

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
    // (compact layout) a heat poll ages coins out of a filtered build and reveals others: its drift may have moved
    if (props.current.filtered) { try { evalDrift(); } catch (e) { fail(e); } }
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

  // The last-trade filter: on a new mask or a new selection (the engine started with both, EngineOptions.last; the call is
  // idempotent there). The engine recomputes the levels once, O(n); trades and heat polls move coins across it by themselves.
  // (compact layout) a filtered engine gets the Key's mask within the build's (see the header).
  const { last, pinned, buildMask: bm } = p;
  const lastIn = filtered ? last & (bm ?? 15) : last;
  useEffect(() => {
    if (!engine) return;
    try { engine.setLastFilter(lastIn, pinned); } catch (e) { fail(e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, lastIn, pinned]);

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
        // (compact layout) a filtered build left coins out on purpose: only the ones the view wants count (their class is in
        // both the build's mask and the Key's, or they are pinned), and the first NODE_REVEAL_MAX of them come in live
        const o: DiffOpts = {};
        if (q.filtered) {
          const pin = new Set(q.pinned), mk = (q.buildMask ?? 15) & q.last & 15, h = q.heat;
          o.wanted = (n) => pin.has(n.mint) || ((mk >> coinClass(n, h)) & 1) === 1;
          o.wantMax = WANTED_KEEP; o.pageParents = true;
        }
        o.topOf = (m) => e.topOf(m); o.checkAll = !c.checked;
        const d = diffNodes(c.diff, q.nodes, q.byMint, (m) => e.knows(m), Date.now() / 1000, o);
        // each coin may ask for one rebuild per page: one the rebuild cannot fix (a parent cycle the build broke) never loops
        c.checked = true;
        for (const m of d.relinked) if (!relinkTried.current.has(m)) { relinkTried.current.add(m); c.relinked++; }
        if (c.relinked) { try { evalDrift(); } catch (err) { fail(err); } }
        for (const b of d.births) {
          try { e.applyEvent({ name: "pair", data: { coin: b.coin, parent: b.parent } }); } catch (err) { fail(err); }
        }
        // the first NODE_REVEAL_MAX that can still be placed come in live; a refusal lands in the engine's missed set, and the
        // drift check counts the mint once (filteredUnknown), however many paths (this pass, a heat poll, a trade) wanted it
        if (d.wanted.length) revealWanted(d.wanted, (m) => { try { return e.reveal(m, "node"); } catch (err) { fail(err); return "error"; } }, NODE_REVEAL_MAX);
        let unknown = d.unknown;
        if (q.filtered) { try { const ds = e.driftStats(d.wanted); unknown = filteredUnknown(d.unknown, d.wanted.length, ds?.wanted); } catch (err) { fail(err); } }
        if (d.patches.length) e.patchCoins(d.patches);
        if (q.highlight) e.setHighlight(highlightTest(q.highlight, q.byMint, q.families ? (m: string) => q.families!.node(m) : undefined));
        const s = st.current;
        s.births += d.births.length; s.patches += d.patches.length; s.unknown = Math.max(0, unknown); s.removed = d.removed;
        c.unknown = d.unknown; c.removed = d.removed; c.wanted = d.wanted;
        record(performance.now() - t0);
        // drifted, but not idle (or not old) enough yet: look again soon even when no data arrives meanwhile (a filtered
        // build re-checks by itself: evalDrift)
        if (evalDrift() && !q.filtered && !timer.current) timer.current = setTimeout(run, RECHECK_MS);
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
