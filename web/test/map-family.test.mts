// The family loader (DESIGN-FAMILY-ALL §6, §7 "Data"): ghost counts and the map's true total, the wire rows to columnar
// chunks, and the store's rules (paging order, dedupe, the snapshot restart, the 2 s abort, LRU evictions, the phone
// cap, the error backoff, search ranking, node identity), against a fake server and an injectable clock. Plus the
// page budget (parse + columnar ≤ 2 ms per 5k rows) and `normalise` keeping the server's `indexed`.
//
//   node --import tsx --test test/map-family.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FAMILY_429_MS, FAMILY_BACKOFF_MS, FAMILY_EXTRA, FAMILY_LIMITS, FAMILY_PAGE, FAMILY_RESTARTS, assetTopIn, coinNode, createFamilyStore, familyOrder, familyTotal, ghostOf, mintAtPos, rowsToChunk, undrawnByTop,
  type FamilyFetch, type FamilyTier, type FamilyTimers,
} from "../src/lib/map/family.ts";
import type { FamilyEvent, FamilyRow, MapFamilyResponse } from "../src/lib/map/family-types.ts";
import { normalise } from "../src/lib/map/nodes.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";
import type { Coin, MapResponse } from "../src/lib/api.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/map3-sample.json", import.meta.url));
const node = (mint: string, parentMint: string | null, o: Partial<BubbleNode> = {}): BubbleNode => ({
  mint, parentMint, depth: parentMint ? 1 : 0, name: null, symbol: mint.toUpperCase(), image: null, mcapUsd: 1_000, lockedUsd: null, children: 0, descendants: 0, migrated: false, ...o,
});
const setOf = (ns: BubbleNode[]) => new Map(ns.map((n) => [n.mint, n]));

// ---------------------------------------------------------------- a fake clock and a fake server
function fakeClock() {
  let t = 1_000_000, seq = 0;
  const q: { at: number; fn: () => void; id: number }[] = [];
  const timers: FamilyTimers = {
    set: (fn, ms) => { const id = ++seq; q.push({ at: t + ms, fn, id }); return id; },
    clear: (h) => { const i = q.findIndex((x) => x.id === h); if (i >= 0) q.splice(i, 1); },
  };
  return {
    now: () => t, timers, pending: () => q.length,
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        const n = q[0];
        if (!n || n.at > end) break;
        q.shift(); t = n.at; n.fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };

type Call = { top: string; offset: number; limit: number; v: number | null; at?: string; signal: AbortSignal; done: boolean; resolve: () => void; fail: (e: Error) => void };
class FakeServer {
  fams = new Map<string, { v: number; rows: FamilyRow[]; old: Map<number, FamilyRow[]> }>();
  calls: Call[] = [];
  auto = true;
  failNext = 0;
  /// errors to throw, in order, before the normal answers (an Error with a `status`, as ApiError carries)
  failWith: Error[] = [];
  /// a server that answers `?at=<mint>` with that row (offset = its index); the default ignores `at`, like today's
  atAware = false;
  maxInFlight = 0;
  inFlight = 0;
  perTop = new Map<string, number>();
  maxPerTop = 0;
  add(top: string, rows: FamilyRow[], v = 1) { this.fams.set(top, { v, rows, old: new Map() }); }
  /// a new snapshot: the old one is gone (a pinned `v` then answers the current one)
  rebuild(top: string, rows: FamilyRow[], v: number) { const f = this.fams.get(top)!; f.v = v; f.rows = rows; f.old.clear(); }
  open() { return this.calls.filter((c) => !c.done); }
  fetch: FamilyFetch = (top, q, signal) => new Promise<MapFamilyResponse>((resolve, reject) => {
    this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const n = (this.perTop.get(top) ?? 0) + 1; this.perTop.set(top, n); this.maxPerTop = Math.max(this.maxPerTop, n);
    const end = () => { if (!call.done) { call.done = true; this.inFlight--; this.perTop.set(top, (this.perTop.get(top) ?? 1) - 1); } };
    const call: Call = {
      top, offset: q.offset, limit: q.limit, v: q.v, at: q.at, signal, done: false,
      resolve: () => {
        if (call.done) return;
        end();
        const f = this.fams.get(top);
        if (!f) { reject(new Error("unknown family")); return; }
        const rows = q.v != null && q.v !== f.v ? f.old.get(q.v) : undefined;
        const v = rows ? q.v! : f.v, list = rows ?? f.rows;
        if (this.atAware && q.at) {
          const i = list.findIndex((r) => r[0] === q.at);
          resolve(i < 0 ? { mint: top, v, total: list.length, offset: list.length, next: null, nodes: [] } : { mint: top, v, total: list.length, offset: i, next: i + 1 < list.length ? i + 1 : null, nodes: [list[i]] });
          return;
        }
        const nodes = list.slice(q.offset, q.offset + q.limit);
        const next = q.offset + nodes.length < list.length ? q.offset + nodes.length : null;
        resolve({ mint: top, v, total: list.length, offset: q.offset, next, nodes });
      },
      fail: (e) => { if (call.done) return; end(); reject(e); },
    };
    signal.addEventListener("abort", () => { if (!call.done) { end(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); } });
    this.calls.push(call);
    const failE = this.failWith.shift();
    if (failE) queueMicrotask(() => call.fail(failE));
    else if (this.failNext > 0) { this.failNext--; queueMicrotask(() => call.fail(new Error("Request failed (500)"))); }
    else if (this.auto) queueMicrotask(() => call.resolve());
  });
}
const rowsOf = (prefix: string, n: number, o: { locked?: (i: number) => number | null; sym?: (i: number) => string | null } = {}): FamilyRow[] =>
  Array.from({ length: n }, (_, i) => [`${prefix}${String(i).padStart(6, "0")}`, o.sym ? o.sym(i) : `S${i}`, 3_000 - (i % 997), o.locked ? o.locked(i) : null, 1_790_000_000 + i, (i % 50 === 0 ? 1 : 0) as 0 | 1, i % 7 === 0 ? 1 : 0]);
const tops = (...ms: string[]) => setOf(ms.map((m) => node(m, null, { asset: true, children: 100_000, symbol: m })));
function storeWith(server: FakeServer, opts: { phone?: boolean; tier?: () => FamilyTier; tops?: Map<string, BubbleNode> } = {}) {
  const clock = fakeClock();
  const topsMap = opts.tops ?? new Map<string, BubbleNode>();
  const events: FamilyEvent[] = [];
  const store = createFamilyStore({ fetchPage: server.fetch, topNode: (m) => topsMap.get(m), phone: !!opts.phone, tier: opts.tier, now: clock.now, timers: clock.timers });
  store.subscribe((e) => events.push(e));
  return { store, clock, events };
}

// ---------------------------------------------------------------- ghosts and the true total
test("familyTotal on the fixture: no asset top, so the drawn count", () => {
  const { nodes } = normalise(JSON.parse(readFileSync(FIXTURE, "utf8")) as MapResponse);
  const byMint = setOf(nodes);
  assert.equal(nodes.length, 927);
  assert.equal(undrawnByTop(nodes, byMint).size, 0);
  assert.equal(familyTotal(nodes, byMint), nodes.length);
});

test("familyTotal: a synthetic asset family adds its undrawn coins; SOL tops and a non-top asset add none", () => {
  const { nodes: base } = normalise(JSON.parse(readFileSync(FIXTURE, "utf8")) as MapResponse);
  // $PUMP-like: 49,596 kids, 12 drawn (one of them with 2 kids of its own) → ghost 49,584 = children − drawn kids
  const pump = node("PUMPTOP", null, { asset: true, children: 49_596, descendants: 49_598 });
  const kids = Array.from({ length: 12 }, (_, i) => node(`pk${i}`, "PUMPTOP", { depth: 0, children: i === 0 ? 2 : 0 }));
  const grand = [node("g1", "pk0", { depth: 1 }), node("g2", "pk0", { depth: 1 })];
  // an asset flagged node that is not a top (its parent is drawn) and a SOL top that says more children than it draws
  const solTop = node("SOLTOP", null, { children: 900 });
  const solKid = node("sk", "SOLTOP");
  const nested = node("NESTED", "SOLTOP", { asset: true, children: 50 });
  const nodes = [...base, pump, ...kids, ...grand, solTop, solKid, nested];
  const byMint = setOf(nodes);
  const g = undrawnByTop(nodes, byMint);
  assert.deepEqual([...g.entries()], [["PUMPTOP", 49_584]]);
  assert.equal(familyTotal(nodes, byMint), nodes.length + 49_584);
  // the family's true size = drawn members + ghost = 1 + descendants
  assert.equal(1 + 12 + 2 + 49_584, 1 + pump.descendants!);
  assert.equal(ghostOf(pump, 12), 49_584);
  assert.equal(ghostOf(pump, 60_000), 0, "never negative");
  assert.equal(ghostOf(solTop, 1), 0, "a SOL top has no ghosts");
  assert.equal(ghostOf(null, 0), 0);
  assert.equal(assetTopIn(byMint, "PUMPTOP"), pump);
  assert.equal(assetTopIn(byMint, "NESTED"), null, "an asset under a drawn parent is not a family top");
  assert.equal(assetTopIn(byMint, "SOLTOP"), null);
  assert.equal(assetTopIn(byMint, null), null);
});

// ---------------------------------------------------------------- rows → chunk
test("rowsToChunk: positional rows to columns, NaN for null numbers, skip and malformed rows left out", () => {
  const rows = [
    ["m1", "ONE", 3123, 10.5, 1_790_000_000, 1, 4],
    ["m2", null, null, null, null, 0, 0],
    ["m3", "THREE", 2900, null, 1_790_000_100, 0, 2],
    null, ["", "EMPTY", 1, 1, 1, 0, 0], ["m4", "FOUR", 2800, 0, 1_790_000_200, 0, -3],
  ] as unknown as FamilyRow[];
  const c = rowsToChunk("TOP", 5_000, rows, (m) => m === "m3");
  assert.equal(c.top, "TOP"); assert.equal(c.from, 5_000); assert.equal(c.n, 3);
  assert.deepEqual(c.mints, ["m1", "m2", "m4"]);
  assert.deepEqual(c.symbols, ["ONE", null, "FOUR"]);
  assert.deepEqual([...c.mcapUsd].map((v) => (Number.isNaN(v) ? "NaN" : v)), [3123, "NaN", 2800]);
  assert.deepEqual([...c.lockedUsd].map((v) => (Number.isNaN(v) ? "NaN" : v)), [10.5, "NaN", 0]);
  assert.ok(Number.isNaN(c.createdAt[1]));
  assert.deepEqual([...c.migrated], [1, 0, 0]);
  assert.deepEqual([...c.children], [4, 0, 0], "a negative count is 0");
  assert.equal(c.mcapUsd.length, 3, "right-sized when rows were left out");
  assert.ok(c.mcapUsd instanceof Float64Array && c.migrated instanceof Uint8Array && c.children instanceof Uint32Array);
  const full = rowsToChunk("TOP", 0, rowsOf("x", 10));
  assert.equal(full.n, 10); assert.equal(full.mcapUsd.length, 10);
});

// The best of 25 runs is the code's cost; the median is printed too (npm test runs every file at once, so a run can
// share the CPU with the others).
test("budget: JSON.parse of a 5k-row page + the store's chunk and index ≤ 2 ms (best of 25)", async () => {
  const rows = rowsOf("Ab3dEfGhJkLmNpQrStUvWxYz12345678", 5_000, { sym: (i) => `TICK${i}`, locked: (i) => (i < 60 ? 100 + i : null) });
  const text = JSON.stringify({ mint: "TOP", v: 1, total: 5_000, offset: 0, next: null, nodes: rows });
  const parseMs: number[] = [], chunkMs: number[] = [];
  for (let k = 0; k < 25; k++) {
    let t0 = performance.now();
    const res = JSON.parse(text) as MapFamilyResponse;
    parseMs.push(performance.now() - t0);
    t0 = performance.now();
    const seen = new Map<string, number>(); let j = 0;
    rowsToChunk("TOP", 0, res.nodes, (m) => { if (seen.has(m)) return true; seen.set(m, j++); return false; });
    chunkMs.push(performance.now() - t0);
  }
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const best = (a: number[]) => Math.min(...a);
  const total = best(parseMs) + best(chunkMs);
  console.log(`# 5k page: ${(text.length / 1024).toFixed(0)} KB, parse ${best(parseMs).toFixed(2)} ms + chunk/index ${best(chunkMs).toFixed(2)} ms = ${total.toFixed(2)} ms best of 25 (median ${(med(parseMs) + med(chunkMs)).toFixed(2)} ms)`);
  // the store measures its own part per page too (stats().pageMsMax)
  const server = new FakeServer(); server.add("TOP", rows);
  const { store, clock } = storeWith(server);
  store.want(["TOP"], "view"); await clock.advance(0);
  console.log(`# store page ms ${store.stats().pageMsLast.toFixed(2)} (first page, cold)`);
  assert.ok(total <= 2, `parse + columnar ${total.toFixed(2)} ms per 5k rows`);
});

// ---------------------------------------------------------------- the store
test("store: pages of 5k in order, v from page 0 pinned on the next ones, state partial → done", async () => {
  const server = new FakeServer(); server.add("T", rowsOf("t", 12_345), 77);
  const { store, clock, events } = storeWith(server, { tops: tops("T") });
  assert.equal(store.info("T"), null);
  store.want(["T"], "view");
  assert.equal(store.busy(), true);
  assert.equal(store.info("T")!.state, "loading");
  assert.equal(store.info("T")!.total, 100_000, "before page 0: the top's children");
  await clock.advance(0);
  assert.deepEqual(server.calls.map((c) => [c.offset, c.limit, c.v]), [[0, 5_000, null], [5_000, 5_000, 77], [10_000, 5_000, 77]], "full pages, so every client asks the server for the same ones");
  const chunks = events.filter((e) => e.kind === "chunk").map((e) => (e.kind === "chunk" ? [e.chunk.from, e.chunk.n] : null));
  assert.deepEqual(chunks, [[0, 5_000], [5_000, 5_000], [10_000, 2_345]]);
  assert.deepEqual(store.chunks("T").map((c) => c.from), [0, 5_000, 10_000]);
  const info = store.info("T")!;
  assert.deepEqual({ ...info }, { top: "T", total: 12_345, loaded: 12_345, cap: 12_345, state: "done", v: 77, error: null });
  assert.equal(store.busy(), false);
  assert.ok(events.some((e) => e.kind === "state" && e.info.state === "partial"), "partial between pages");
  assert.equal(store.familyOf("t000100"), "T");
  assert.equal(store.familyOf("nope"), null);
  assert.equal(server.maxPerTop, 1, "one page in flight per family");
  const v0 = store.version();
  store.want(["T"], "view");
  assert.equal(store.version(), v0, "a want that changes nothing emits nothing");
});

test("store: union by priority select > search > panel > view; two pages in flight at most", async () => {
  const server = new FakeServer(); server.auto = false;
  for (const t of ["A", "B", "C", "D"]) server.add(t, rowsOf(t.toLowerCase(), 6_000));
  const { store } = storeWith(server, { tops: tops("A", "B", "C", "D") });
  store.want(["A", "B", "C"], "view");
  store.want(["D"], "select");
  assert.deepEqual(store.stats().wants.select, ["D"]);
  // D (select) was added second, but A and B already held the two slots
  assert.deepEqual(server.open().map((c) => c.top), ["A", "B"]);
  server.open()[0].resolve(); await settle();
  assert.deepEqual(server.open().map((c) => c.top), ["B", "D"], "the freed slot goes to the most wanted family (select), not A's next page");
  assert.ok(server.maxInFlight <= 2);
  // A, B and D hold rows or a request: the desktop limit (3 families) keeps C waiting while all three are wanted
  server.open()[0].resolve(); await settle();
  assert.deepEqual(server.open().map((c) => [c.top, c.offset]), [["D", 0], ["A", 5_000]]);
  assert.equal(store.info("C")!.state, "idle");
  assert.equal(server.maxInFlight, 2);
  assert.equal(server.maxPerTop, 1);
});

test("store: a panel want outranks a view want for the next free slot", async () => {
  const server = new FakeServer(); server.auto = false;
  for (const t of ["A", "B", "C"]) server.add(t, rowsOf(t.toLowerCase(), 12_000));
  const { store } = storeWith(server, { tops: tops("A", "B", "C") });
  store.want(["A", "B"], "view");
  store.want(["C"], "panel");
  assert.deepEqual(server.open().map((c) => c.top), ["A", "B"], "both slots were taken before the panel asked");
  server.open()[0].resolve(); await settle();
  assert.deepEqual(server.open().map((c) => [c.top, c.offset]), [["B", 0], ["C", 0]], "panel (C) before view (A's page 2)");
  store.want(["B"], "search");
  server.open()[0].resolve(); await settle();
  assert.deepEqual(server.open().map((c) => [c.top, c.offset]), [["C", 0], ["B", 5_000]], "search (B) takes the freed slot before view (A); C's page is still in flight");
});

test("store: rows are deduped by mint across pages", async () => {
  const server = new FakeServer();
  const rows = rowsOf("d", 9_000);
  // the second page repeats 300 mints of the first (a list that shifted under the same v)
  const dup = [...rows.slice(0, 5_000), ...rows.slice(4_700, 9_000)];
  server.add("T", dup, 5);
  const { store, clock } = storeWith(server, { tops: tops("T") });
  store.want(["T"], "view"); await clock.advance(0);
  const info = store.info("T")!;
  assert.equal(info.loaded, 9_000);
  assert.equal(store.chunks("T")[1].n, 4_000);
  assert.equal(store.chunks("T")[1].from, 5_000);
  const all = store.chunks("T").flatMap((c) => c.mints);
  assert.equal(new Set(all).size, all.length);
});

test("store: a changed v re-pages from 0 on the new snapshot, keeping every row held: no evict, no re-handed chunks", async () => {
  const server = new FakeServer(); server.auto = false;
  const rows = rowsOf("a", 12_000);
  server.add("T", rows, 1);
  const { store, events } = storeWith(server, { tops: tops("T") });
  store.want(["T"], "view");
  server.open()[0].resolve(); await settle();
  assert.equal(store.info("T")!.loaded, 5_000);
  const n0 = store.node("a000001")!;
  const chunk0 = store.chunks("T")[0];
  // the server rebuilt and dropped snapshot 1 (same coins, a few new ones at the end); page 2 (sent with v=1) is on v=2
  server.rebuild("T", [...rows, ...rowsOf("n", 300)], 2);
  const c = server.open()[0];
  assert.equal(c.v, 1);
  const before = events.length;
  c.resolve(); await settle();
  assert.deepEqual([server.open()[0].offset, server.open()[0].v], [0, 2], "re-paged from offset 0, pinned to the new v");
  assert.equal(store.info("T")!.loaded, 5_000, "rows kept");
  assert.equal(store.node("a000001"), n0, "the same node object");
  server.open()[0].resolve(); await settle();   // page 0 again: every row is held, nothing new
  assert.equal(store.chunks("T").length, 1, "a page of held rows hands nothing out");
  server.open()[0].resolve(); await settle();   // 5k..10k: new to this client
  server.open()[0].resolve(); await settle();   // 10k..12,300: the end of the new list
  const after = events.slice(before);
  assert.equal(after.filter((e) => e.kind === "evict").length, 0, "no evict: nothing the new snapshot lacks");
  assert.deepEqual(after.filter((e) => e.kind === "chunk").map((e) => (e.kind === "chunk" ? [e.chunk.from, e.chunk.n] : null)), [[5_000, 5_000], [10_000, 2_300]]);
  assert.equal(store.chunks("T")[0], chunk0, "the first chunk is untouched");
  const info = store.info("T")!;
  assert.deepEqual([info.loaded, info.total, info.v, info.state], [12_300, 12_300, 2, "done"]);
  assert.equal(store.stats().restarts, 1);
  const all = store.chunks("T").flatMap((x) => x.mints);
  assert.equal(new Set(all).size, all.length, "no mint twice");
});

test("store: rows the new snapshot no longer lists go once the re-page reaches its end (one evict, the rest re-handed out)", async () => {
  const server = new FakeServer(); server.auto = false;
  server.add("T", rowsOf("a", 12_000), 1);
  const { store, events } = storeWith(server, { tops: tops("T") });
  store.want(["T"], "view");
  server.open()[0].resolve(); await settle();
  server.rebuild("T", [...rowsOf("a", 3_000), ...rowsOf("b", 4_000)], 2);
  const before = events.length;
  server.open()[0].resolve(); await settle();
  assert.equal(store.info("T")!.loaded, 5_000, "kept while the pass runs");
  assert.ok(store.node("a004000"), "a row the new snapshot dropped stays until the pass is through");
  server.open()[0].resolve(); await settle();   // 0..5k on v2: a000000..a002999 + b000000..b001999
  assert.equal(events.slice(before).filter((e) => e.kind === "evict").length, 0);
  server.open()[0].resolve(); await settle();   // 5k..7k: the end
  const after = events.slice(before);
  const ev = after.findIndex((e) => e.kind === "evict");
  assert.ok(ev >= 0, "evict once the pass knows the whole list");
  assert.equal(after.filter((e) => e.kind === "evict").length, 1);
  assert.deepEqual(store.chunks("T").map((x) => [x.from, x.n, x.mints[0]]), [[0, 3_000, "a000000"], [0, 2_000, "b000000"], [5_000, 2_000, "b002000"]]);
  assert.equal(store.node("a004000"), null);
  assert.ok(store.node("a000001"));
  assert.equal(store.info("T")!.loaded, 7_000);
  assert.equal(store.info("T")!.state, "done");
  assert.ok(after.slice(ev + 1).filter((e) => e.kind === "chunk").length === 3, "every kept chunk handed out again after the evict");
});

test("store: a server churning snapshots re-pages at most FAMILY_RESTARTS times, then carries on forward", async () => {
  const server = new FakeServer(); server.auto = false;
  server.add("T", rowsOf("a", 30_000), 1);
  const { store } = storeWith(server, { tops: tops("T") });
  store.want(["T"], "view");
  server.open()[0].resolve(); await settle();
  for (let r = 1; r <= FAMILY_RESTARTS + 1; r++) {
    // a page past 0 comes back on a newer snapshot
    server.rebuild("T", rowsOf("a", 30_000), r + 1);
    const c = server.open()[0];
    assert.notEqual(c.offset, 0);
    c.resolve(); await settle();
    if (r <= FAMILY_RESTARTS) {
      const z = server.open()[0];
      assert.deepEqual([z.offset, z.v], [0, r + 1], `restart ${r}: from 0 on v${r + 1}`);
      z.resolve(); await settle();
    } else assert.equal(server.open()[0].offset, 10_000, "past the limit: forward on the newest snapshot");
  }
  assert.equal(store.stats().restarts, FAMILY_RESTARTS + 1);
});

test("store: a family nobody wants for 2 s has its request aborted, its rows kept; wanted again in time = no abort", async () => {
  const server = new FakeServer(); server.auto = false;
  server.add("T", rowsOf("t", 20_000));
  const { store, clock } = storeWith(server, { tops: tops("T") });
  store.want(["T"], "view");
  server.open()[0].resolve(); await settle();
  const second = server.open()[0];
  store.want([], "view");
  await clock.advance(1_900);
  assert.equal(second.signal.aborted, false);
  store.want(["T"], "panel"); // wanted again before 2 s: the timer is gone
  await clock.advance(5_000);
  assert.equal(second.signal.aborted, false);
  store.want([], "panel");
  await clock.advance(1_999);
  assert.equal(second.signal.aborted, false);
  await clock.advance(1);
  assert.equal(second.signal.aborted, true, "aborted at 2 s");
  assert.equal(store.busy(), false);
  const info = store.info("T")!;
  assert.equal(info.loaded, 5_000, "loaded rows kept");
  assert.equal(info.state, "partial");
  assert.equal(server.open().length, 0, "no further page for an unwanted family");
  // wanted again: it resumes where it stopped
  store.want(["T"], "view");
  assert.equal(server.open()[0].offset, 5_000);
});

test("store: LRU over loaded families beyond the desktop limit (3) emits evict and releases the arrays", async () => {
  const server = new FakeServer();
  for (const t of ["A", "B", "C", "D"]) server.add(t, rowsOf(t.toLowerCase(), 3_000));
  const { store, clock, events } = storeWith(server, { tops: tops("A", "B", "C", "D") });
  store.want(["A"], "view"); await clock.advance(100);
  store.want(["B"], "view"); await clock.advance(100);
  store.want(["C"], "view"); await clock.advance(100);
  assert.equal(store.stats().families.length, 3);
  assert.ok(store.node("a000001"));
  store.want(["D"], "view"); await clock.advance(100);
  const ev = events.filter((e) => e.kind === "evict").map((e) => e.top);
  assert.deepEqual(ev, ["A"], "the least recently wanted family goes");
  assert.equal(store.info("A"), null);
  assert.deepEqual(store.chunks("A"), []);
  assert.equal(store.node("a000001"), null);
  assert.equal(store.info("D")!.state, "done");
  assert.deepEqual(store.stats().families.map((f) => f.top).sort(), ["B", "C", "D"]);
  // a wanted family is never evicted for another: with B, C, D and E all wanted, E waits
  server.add("E", rowsOf("e", 10));
  store.want(["B", "C", "D", "E"], "view"); await clock.advance(100);
  assert.equal(store.info("E")!.state, "idle");
  assert.equal(events.filter((e) => e.kind === "evict").length, 1);
});

test("store: phones stop at 20k rows a family and hold 2 families / 40k rows", async () => {
  const server = new FakeServer();
  server.add("P", rowsOf("p", 76_470)); server.add("U", rowsOf("u", 41_450)); server.add("S", rowsOf("s", 17_031));
  const { store, clock, events } = storeWith(server, { phone: true, tops: tops("P", "U", "S") });
  store.want(["P"], "view"); await clock.advance(10);
  const p = store.info("P")!;
  assert.deepEqual([p.loaded, p.total, p.cap, p.state], [20_000, 76_470, 20_000, "done"]);
  assert.equal(server.calls.filter((c) => c.top === "P").length, 4, "4 pages of 5k");
  store.want(["P", "U"], "view"); await clock.advance(10);
  assert.equal(store.info("U")!.loaded, 20_000);
  store.want(["S"], "view"); await clock.advance(10);
  assert.deepEqual(events.filter((e) => e.kind === "evict").map((e) => e.top), ["P"], "2 families on a phone: the older one goes");
  assert.equal(store.info("S")!.loaded, 17_031);
  assert.ok(store.stats().families.reduce((a, f) => a + f.loaded, 0) <= 40_000);
});

test("store: desktop rows limit 150k evicts an unwanted family before it would pass it", async () => {
  const server = new FakeServer();
  server.add("P", rowsOf("p", 76_470)); server.add("U", rowsOf("u", 41_450)); server.add("X", rowsOf("x", 40_000));
  const { store, clock, events } = storeWith(server, { tops: tops("P", "U", "X") });
  store.want(["P", "U"], "view"); await clock.advance(10);
  assert.equal(store.info("P")!.loaded + store.info("U")!.loaded, 117_920);
  store.want(["X"], "view"); await clock.advance(10);
  // 117,920 + 40,000 > 150k: P and U are no longer wanted (the view list was replaced), so the least recently wanted
  // of them (a tie: the first one held) is evicted to make room
  assert.equal(events.filter((e) => e.kind === "evict").length, 1);
  assert.equal(store.info("X")!.loaded, 40_000);
  assert.ok(store.stats().families.reduce((a, f) => a + f.loaded, 0) <= 150_000);
});

test("store: errors back off 2 s, 8 s, 30 s, then the family is in error until wanted anew", async () => {
  const server = new FakeServer(); server.add("T", rowsOf("t", 100));
  server.failNext = 99;
  const { store, clock } = storeWith(server, { tops: tops("T") });
  store.want(["T"], "view"); await settle();
  assert.equal(server.calls.length, 1);
  assert.equal(store.info("T")!.state, "loading", "a retry is pending");
  assert.match(store.info("T")!.error!, /500/);
  assert.deepEqual(FAMILY_BACKOFF_MS, [2_000, 8_000, 30_000]);
  await clock.advance(1_999); assert.equal(server.calls.length, 1);
  await clock.advance(1); assert.equal(server.calls.length, 2, "2nd attempt at 2 s");
  await clock.advance(7_999); assert.equal(server.calls.length, 2);
  await clock.advance(1); assert.equal(server.calls.length, 3, "3rd at +8 s");
  await clock.advance(29_999); assert.equal(server.calls.length, 3);
  await clock.advance(1); assert.equal(server.calls.length, 4, "4th at +30 s");
  assert.equal(store.info("T")!.state, "error");
  await clock.advance(120_000); assert.equal(server.calls.length, 4, "no more attempts");
  store.want(["T"], "view"); assert.equal(server.calls.length, 4, "the same want again changes nothing");
  server.failNext = 0;
  store.want(["T"], "panel"); await settle();
  assert.equal(server.calls.length, 5, "wanted anew: a fresh run");
  assert.equal(store.info("T")!.state, "done");
  assert.equal(store.info("T")!.error, null);
});

test("store: search ranks exact > prefix > substring, then locked, then mcap; max respected", async () => {
  const server = new FakeServer();
  const rows: FamilyRow[] = [
    ["m-sub", "XPUMPX", 9_000, null, null, 0, 0],
    ["m-pre-small", "PUMPKIN", 3_000, null, null, 0, 0],
    ["m-pre-big", "PUMPER", 3_000, 50, null, 0, 0],
    ["m-exact", "pump", 2_500, null, null, 0, 0],
    ["m-pre-mcap", "PUMPED", 4_000, null, null, 0, 0],
    ["m-none", "DOGE", 99_000, 999, null, 0, 0],
    ["m-null", null, 1, null, null, 0, 0],
  ];
  server.add("T", rows);
  const { store, clock } = storeWith(server, { tops: tops("T") });
  store.want(["T"], "view"); await clock.advance(0);
  assert.deepEqual(store.search("$Pump", 8).map((n) => n.mint), ["m-exact", "m-pre-big", "m-pre-mcap", "m-pre-small", "m-sub"]);
  assert.deepEqual(store.search("pump", 2).map((n) => n.mint), ["m-exact", "m-pre-big"]);
  assert.deepEqual(store.search("  ", 8), []);
  assert.deepEqual(store.search("zzz", 8), []);
  const hit = store.search("pump", 1)[0];
  assert.equal(hit, store.node("m-exact"), "search hands out the cached node");
});

test("store: node(mint) is built lazily, cached, parentMint = top, depth 0 under an asset", async () => {
  const server = new FakeServer();
  server.add("T", [["c1", "ONE", 3_100, null, 1_790_000_000, 1, 3]]);
  server.add("K", [["k1", "KID", 2_000, 5, null, 0, 0]]);
  const topsMap = tops("T");
  topsMap.set("K", node("K", "T", { depth: 2, children: 1 }));
  const { store, clock } = storeWith(server, { tops: topsMap });
  store.want(["T", "K"], "view"); await clock.advance(0);
  const a = store.node("c1")!;
  assert.equal(store.node("c1"), a, "same object while loaded");
  assert.deepEqual(a, { mint: "c1", parentMint: "T", depth: 0, name: null, symbol: "ONE", image: null, mcapUsd: 3_100, lockedUsd: null, children: 3, migrated: true, createdAt: 1_790_000_000 });
  const k = store.node("k1")!;
  assert.equal(k.parentMint, "K");
  assert.equal(k.depth, 3, "under a tracked coin: its depth + 1");
  assert.equal(k.createdAt, null);
  assert.equal(store.node("missing"), null);
  store.dispose();
  assert.equal(store.node("c1"), null);
  assert.equal(store.disposed(), true);
});

test("store: chunks and events carry no IndexedDB or useMapData coupling; dispose aborts and goes quiet", async () => {
  const server = new FakeServer(); server.auto = false; server.add("T", rowsOf("t", 10_000));
  const { store, events } = storeWith(server, { tops: tops("T") });
  store.want(["T"], "view");
  const c = server.open()[0];
  const n = events.length;
  store.dispose();
  assert.equal(c.signal.aborted, true);
  c.resolve(); await settle();
  assert.equal(events.length, n, "no event after dispose");
  store.want(["T"], "view");
  assert.equal(server.calls.length, 1);
});

test("familyOrder: one order over every loaded row (a drawn one by its live numbers) plus the drawn kids the rows lack", () => {
  const c0 = rowsToChunk("T", 0, [["a", "A", 3_000, 5, 100, 0, 0], ["b", "B", 9_000, null, 300, 0, 0], ["c", "C", 3_000, 5, 200, 0, 0]]);
  const c1 = rowsToChunk("T", 3, [["d", "D", 4_000, 20, 50, 0, 0], ["e", "E", 1_000, null, 400, 0, 0]]);
  const chunks = [c0, c1];
  const names = (pos: Uint32Array, extra?: BubbleNode[]) => [...pos].map((p) => mintAtPos(chunks, p, extra));
  assert.deepEqual(names(familyOrder(chunks, "locked")), ["d", "a", "c", "b", "e"]);
  assert.deepEqual(names(familyOrder(chunks, "mcap")), ["b", "d", "a", "c", "e"]);
  assert.deepEqual(names(familyOrder(chunks, "new")), ["e", "b", "c", "a", "d"]);
  // "a" is drawn and its live mcap moved to $50k: it sorts by that, it is not skipped
  const live = new Map([["a", node("a", "T", { mcapUsd: 50_000, lockedUsd: 5, createdAt: 100 })]]);
  assert.deepEqual(names(familyOrder(chunks, "mcap", (m) => live.get(m))), ["a", "b", "d", "c", "e"]);
  // a drawn kid the rows do not hold (born since the snapshot) lands where its numbers put it
  const extra = [node("z", "T", { mcapUsd: 5_000, lockedUsd: null, createdAt: 999 })];
  const pos = familyOrder(chunks, "mcap", (m) => live.get(m), extra);
  assert.deepEqual(names(pos, extra), ["a", "b", "z", "d", "c", "e"]);
  assert.equal(pos[2], FAMILY_EXTRA + 0);
  assert.deepEqual(names(familyOrder(chunks, "new", undefined, extra), extra)[0], "z");
  assert.equal(familyOrder([], "locked").length, 0);
});

test("familyOrder: the drawn/undrawn boundary of a real family stays sorted (the $690K undrawn coin above a $1.67K drawn one)", () => {
  // drawn kids: locked 0 with small mcaps; undrawn rows: locked null, one with a big mcap deep in the server order
  const drawn = Array.from({ length: 300 }, (_, i) => node(`d${i}`, "T", { lockedUsd: 0, mcapUsd: 1_670 + i, createdAt: 1 }));
  const rows: FamilyRow[] = [...drawn.map((d): FamilyRow => [d.mint, "D", 1_000, 0, 1, 0, 0]), ["big", "BIG", 690_000, null, 2, 0, 0], ...rowsOf("u", 2_000)];
  const chunks = [rowsToChunk("T", 0, rows)];
  const byMint = new Map(drawn.map((d) => [d.mint, d]));
  for (const sort of ["mcap", "locked"] as const) {
    const pos = familyOrder(chunks, sort, (m) => byMint.get(m));
    assert.equal(pos.length, rows.length);
    const mc = [...pos].map((p) => { const m = mintAtPos(chunks, p)!; const d = byMint.get(m); return d ? d.mcapUsd! : chunks[0].mcapUsd[p % 65_536]; });
    if (sort === "mcap") for (let i = 1; i < mc.length; i++) assert.ok(mc[i] <= mc[i - 1], `mcap sorted at ${i}`);
    assert.equal(mintAtPos(chunks, pos[0]), "big", `${sort}: the $690K coin heads the list (locked 0 = null in the panel's order)`);
  }
});

test("store: the selected coin past a phone's 20k cap is sought on its own and pinned as a 1-row chunk (from = its index)", async () => {
  const server = new FakeServer();
  const rows = rowsOf("p", 49_416);
  server.add("P", rows, 9);
  const { store, clock, events } = storeWith(server, { phone: true, tops: tops("P") });
  const far = rows[20_009][0];
  store.want(["P"], "select"); store.seek(far, "P");
  await clock.advance(10);
  const calls = server.calls.filter((c) => c.top === "P");
  assert.deepEqual(calls.slice(0, 4).map((c) => [c.offset, c.limit, c.at ?? null]), [[0, 5_000, null], [5_000, 5_000, null], [10_000, 5_000, null], [15_000, 5_000, null]], "the tier's 20k first");
  assert.deepEqual(calls.slice(4).map((c) => [c.offset, c.limit, c.at, c.v]), [[20_000, 5_000, far, 9]], "then one seek page: today's server answers the page at offset (it ignores at)");
  const pin = events.filter((e) => e.kind === "chunk").at(-1)!;
  assert.ok(pin.kind === "chunk");
  if (pin.kind === "chunk") assert.deepEqual([pin.chunk.from, pin.chunk.n, pin.chunk.mints[0]], [20_009, 1, far]);
  assert.equal(store.familyOf(far), "P");
  assert.equal(store.node(far)!.parentMint, "P");
  const st = store.stats();
  assert.deepEqual([st.seek!.state, st.seek!.from, st.pinned, st.seekPages], ["found", 20_009, 1, 1]);
  const info = store.info("P")!;
  assert.deepEqual([info.loaded, info.state], [20_001, "done"], "the 20k plus the pinned row; no other row past the cap is kept");
  assert.equal(store.chunks("P").reduce((a, c) => a + c.n, 0), 20_001);
});

test("store: a seek scans page by page to a coin deep in the list; a server that answers ?at= needs one request", async () => {
  const rows = rowsOf("p", 49_416);
  const deep = rows[44_321][0];
  const scan = new FakeServer(); scan.add("P", rows, 3);
  const a = storeWith(scan, { phone: true, tops: tops("P") });
  a.store.want(["P"], "select"); a.store.seek(deep, "P"); await a.clock.advance(10);
  assert.deepEqual(scan.calls.slice(4).map((c) => c.offset), [20_000, 25_000, 30_000, 35_000, 40_000], "five seek pages, rows not kept");
  assert.equal(a.store.stats().seek!.from, 44_321);
  assert.equal(a.store.info("P")!.loaded, 20_001);
  const at = new FakeServer(); at.atAware = true; at.add("P", rows, 3);
  const b = storeWith(at, { phone: true, tops: tops("P") });
  b.store.want(["P"], "select"); b.store.seek(deep, "P"); await b.clock.advance(10);
  assert.deepEqual(at.calls.slice(4).map((c) => [c.offset, c.at]), [[20_000, deep]], "one request");
  assert.deepEqual([b.store.stats().seek!.state, b.store.stats().seek!.from], ["found", 44_321]);
  assert.equal(b.store.chunks("P").at(-1)!.from, 44_321);
});

test("store: a sought coin the family does not list ends 'missing'; no seek while the family still pages; seek(null) clears", async () => {
  const server = new FakeServer(); server.add("P", rowsOf("p", 26_000), 1); server.add("D", rowsOf("d", 8_000), 1);
  const { store, clock } = storeWith(server, { phone: true, tops: tops("P", "D") });
  store.want(["P"], "select"); store.seek("nope", "P"); await clock.advance(10);
  assert.equal(store.stats().seek!.state, "missing");
  assert.deepEqual(server.calls.map((c) => c.offset), [0, 5_000, 10_000, 15_000, 20_000, 25_000]);
  assert.equal(store.info("P")!.loaded, 20_000);
  // desktop pages the whole family: a coin inside it is simply found, no seek request
  const d = storeWith(server, { tops: tops("P", "D") });
  const n0 = server.calls.length;
  d.store.want(["D"], "select"); d.store.seek("d007000", "D"); await d.clock.advance(10);
  assert.equal(d.store.stats().seek!.state, "found");
  assert.equal(server.calls.slice(n0).filter((c) => c.at).length, 0);
  d.store.seek(null); assert.equal(d.store.stats().seek, null);
});

test("store: 404 / 400 are final for the page's life (no retry, a new want does not restart them); 429 waits its Retry-After", async () => {
  const server = new FakeServer(); server.add("T", rowsOf("t", 100));
  server.failWith = [Object.assign(new Error("unknown family"), { status: 404 })];
  const { store, clock } = storeWith(server, { tops: tops("T", "U") });
  store.want(["T"], "view"); await settle();
  assert.equal(store.info("T")!.state, "error");
  assert.equal(store.info("T")!.error, "unknown family");
  await clock.advance(120_000);
  assert.equal(server.calls.length, 1, "never retried");
  store.want([], "view"); await settle();
  store.want(["T"], "panel"); await settle();
  assert.equal(server.calls.length, 1, "wanted anew: still not a family");
  assert.equal(store.info("T")!.state, "error");
  assert.deepEqual(store.stats().gone, ["T"]);
  // a 429 with the limiter's message: waits 12 s, not the 2 s backoff
  const s2 = new FakeServer(); s2.add("T", rowsOf("t", 100));
  s2.failWith = [Object.assign(new Error("rate limited (api: 300 per 60 s), try again in 12 s"), { status: 429 })];
  const b = storeWith(s2, { tops: tops("T") });
  b.store.want(["T"], "view"); await settle();
  assert.equal(b.store.info("T")!.state, "loading", "a retry is pending");
  await b.clock.advance(11_999); assert.equal(s2.calls.length, 1);
  await b.clock.advance(1); assert.equal(s2.calls.length, 2, "retried at its Retry-After");
  assert.equal(b.store.info("T")!.state, "done");
  // a 429 without a readable wait: FAMILY_429_MS
  const s3 = new FakeServer(); s3.add("T", rowsOf("t", 100));
  s3.failWith = [Object.assign(new Error("Request failed (429)"), { status: 429 })];
  const c = storeWith(s3, { tops: tops("T") });
  c.store.want(["T"], "view"); await settle();
  await c.clock.advance(FAMILY_429_MS - 1); assert.equal(s3.calls.length, 1);
  await c.clock.advance(1); assert.equal(s3.calls.length, 2);
});

test("store: the tier follows the engine's (a getter read on every pump): phone ↔ desktop, software caps 20k a family / 40k rows", async () => {
  assert.deepEqual(FAMILY_LIMITS.software, { families: 3, rows: 40_000, perFamily: 20_000 });
  const server = new FakeServer(); server.add("P", rowsOf("p", 49_416)); server.add("U", rowsOf("u", 41_450)); server.add("S", rowsOf("s", 30_000));
  let tier: FamilyTier = "phone";
  const { store, clock } = storeWith(server, { tier: () => tier, tops: tops("P", "U", "S") });
  store.want(["P"], "view"); await clock.advance(10);
  assert.deepEqual([store.info("P")!.loaded, store.info("P")!.state, store.stats().tier], [20_000, "done", "phone"]);
  tier = "desktop";
  store.want(["P"], "panel"); await clock.advance(10);
  assert.deepEqual([store.info("P")!.loaded, store.info("P")!.state, store.stats().tier], [49_416, "done", "desktop"], "a wider map: the rest of the family");
  const sw = storeWith(server, { tier: () => "software", tops: tops("P", "U", "S") });
  sw.store.want(["P", "U", "S"], "view"); await sw.clock.advance(10);
  const held = sw.store.stats().families.map((f) => [f.top, f.loaded]);
  assert.deepEqual(held, [["P", 20_000], ["U", 20_000], ["S", 0]], "software: 20k a family, 40k in all (the engine's caps)");
});

test("coinNode: a light /api/coin as the speck node it stands for", () => {
  const c = { mint: "x", name: "Ex", symbol: "EX", image: "/i.png", mcapUsd: 3_000, lockedUsd: null, children: 0, descendants: 0, migrated: false, createdAt: 1_790_000_000, quoteMint: "T" } as unknown as Coin;
  assert.deepEqual(coinNode(c, "T"), { mint: "x", parentMint: "T", depth: 0, name: "Ex", symbol: "EX", image: "/i.png", mcapUsd: 3_000, lockedUsd: null, children: 0, descendants: 0, migrated: false, createdAt: 1_790_000_000 });
});

test("normalise keeps the server's indexed (null when absent or not a count)", () => {
  const coin = { mint: "r", name: null, symbol: "R", image: null, depth: 0, mcapUsd: 1, lockedUsd: null, children: 0, descendants: 0, migrated: false, createdAt: null };
  assert.equal(normalise({ roots: [{ coin, children: [] }], indexed: 81_874 }).indexed, 81_874);
  assert.equal(normalise({ nodes: [], indexed: 316_000 }).indexed, 316_000, "the since= body carries it too");
  assert.equal(normalise({ roots: [] }).indexed, null);
  assert.equal(normalise({ roots: [], indexed: Number.NaN }).indexed, null);
  assert.equal(normalise({ roots: [], indexed: "9" as unknown as number }).indexed, null);
});

test("store: FAMILY_PAGE is 5k", () => { assert.equal(FAMILY_PAGE, 5_000); });
