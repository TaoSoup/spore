// The family loader (DESIGN-FAMILY-ALL §2, §6). /api/map draws a capped slice of every listed asset's family (USDC,
// PUMP, a tokenized stock …); the coins it leaves out are the asset top's `children` minus its drawn kids (the "ghost"
// count, the helpers below). This store pages those coins in on demand from GET /api/map/family/:mint (5k rows a page,
// biggest first) as columnar chunks, for the engine's dust layer, the side panel's list and the search box.
//
// Rules: the wants of four callers (select > search > panel > view) form one ordered union; one page in flight per
// family and two in total; pages in order, the snapshot `v` from page 0 pinned on the next ones (a different `v` back
// re-pages the family from offset 0 on the new snapshot and keeps every row it holds: no `evict`, no flicker; rows the
// new snapshot no longer has go once that pass reaches the end of the list); rows deduped by mint within a family (a
// coin is quoted in exactly one mint, so two families never share one); a family nobody wants for 2 s has its request
// aborted (its rows stay); beyond the tier's family / row limits the least recently wanted family is evicted (its
// arrays dropped); phones and the engine's software tier stop at 20k rows a family, and the selected coin past that cap
// is sought on its own (`seek`: one row whose `from` is its place in the list) so the engine still draws it and flies
// to it; a failed page retries after 2 s, 8 s and 30 s (a 429 waits at least its Retry-After), then the family is in
// `error` until it is wanted anew; a 400 / 404 (not a family) is final for the page's life. Nothing is persisted (the
// IndexedDB cache holds only the drawn map). Store events never touch useMapData: a consumer subscribes and re-renders
// only what it shows.
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Coin } from "../api";
import type { BubbleNode } from "./types";
import type { FamilyChunk, FamilyEvent, FamilyInfo, FamilyRow, FamilyState, FamilyStore, FamilyWhy, MapFamilyResponse } from "./family-types";

export const FAMILY_PAGE = 5_000;
export const FAMILY_IN_FLIGHT = 2;
/// A family that left every want list keeps its request this long before it is aborted.
export const FAMILY_ABORT_MS = 2_000;
/// Waits before the 2nd, 3rd and 4th attempt of a failed page; the 4th failure puts the family in `error`.
export const FAMILY_BACKOFF_MS: readonly number[] = [2_000, 8_000, 30_000];
/// A 429 whose Retry-After cannot be read waits this long.
export const FAMILY_429_MS = 30_000;
/// A snapshot change re-pages a family from offset 0 at most this many times; past it (a server churning its
/// snapshots) the family carries on forward on the newest one.
export const FAMILY_RESTARTS = 3;
/// The engine's tiers (engine/swarm.js TIERS; engine/state.js: a container ≤ 700 px is a phone, a software rasteriser
/// is its own tier), the store's part: families held at once, rows held at once, rows per family. The row caps are the
/// engine's real-speck caps, so the store never loads rows the engine would drop.
export type FamilyTier = "desktop" | "phone" | "software";
export const FAMILY_LIMITS: Readonly<Record<FamilyTier, { readonly families: number; readonly rows: number; readonly perFamily: number }>> = {
  desktop: { families: 3, rows: 150_000, perFamily: Infinity },
  phone: { families: 2, rows: 40_000, perFamily: 20_000 },
  software: { families: 3, rows: 40_000, perFamily: 20_000 },
};
const WHYS: readonly FamilyWhy[] = ["select", "search", "panel", "view"];

// ---------------------------------------------------------------- pure helpers

/// A family top that is a listed asset: the coins /api/map leaves out of its family = its `children` minus the kids
/// drawn under it (undrawn coins are leaves by construction, so the true size is drawn members + ghost). SOL tops: 0.
export const ghostOf = (top: BubbleNode | null | undefined, drawnKids: number): number =>
  top && top.asset === true ? Math.max(0, (Number.isFinite(top.children) ? top.children : 0) - drawnKids) : 0;

/// Asset top mint → its ghost count, for every asset top among `nodes` (a node whose parent `byMint` does not hold)
/// that has one. One pass over the nodes; nothing when the view has no asset top.
export function undrawnByTop(nodes: readonly BubbleNode[], byMint: ReadonlyMap<string, BubbleNode>): Map<string, number> {
  const kids = new Map<string, number>();
  for (const n of nodes) if (n.asset === true && (!n.parentMint || !byMint.has(n.parentMint))) kids.set(n.mint, 0);
  const out = new Map<string, number>();
  if (!kids.size) return out;
  for (const n of nodes) { const p = n.parentMint; if (p) { const k = kids.get(p); if (k !== undefined) kids.set(p, k + 1); } }
  for (const [top, drawn] of kids) { const g = ghostOf(byMint.get(top), drawn); if (g > 0) out.set(top, g); }
  return out;
}

/// Every coin the drawn map stands for: the drawn nodes plus each asset family's undrawn coins (N + Σ ghost: the
/// engine's canvas label and the server's `indexed`).
export function familyTotal(nodes: readonly BubbleNode[], byMint: ReadonlyMap<string, BubbleNode>): number {
  let t = nodes.length;
  for (const g of undrawnByTop(nodes, byMint).values()) t += g;
  return t;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const cnt = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, 0xffff_ffff) : 0);

/// Wire rows → one columnar chunk (null numbers become NaN, a null child count 0). `skip(mint)` leaves a row out (the
/// store's dedupe); a malformed row is left out too, so `n` can be below rows.length while `from` stays the index of
/// the page's first row in the family's full list.
export function rowsToChunk(top: string, from: number, rows: readonly FamilyRow[], skip?: (mint: string) => boolean): FamilyChunk {
  const len = rows.length;
  const mints: string[] = [], symbols: (string | null)[] = [];
  let mcapUsd = new Float64Array(len), lockedUsd = new Float64Array(len), createdAt = new Float64Array(len), migrated = new Uint8Array(len), children = new Uint32Array(len);
  let n = 0;
  for (let i = 0; i < len; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || typeof r[0] !== "string" || !r[0]) continue;
    if (skip && skip(r[0])) continue;
    mints.push(r[0]); symbols.push(typeof r[1] === "string" ? r[1] : null);
    mcapUsd[n] = num(r[2]); lockedUsd[n] = num(r[3]); createdAt[n] = num(r[4]); migrated[n] = r[5] ? 1 : 0; children[n] = cnt(r[6]);
    n++;
  }
  // a short chunk gets right-sized copies, so no page keeps a 5k-row buffer alive for a few rows
  if (n < len) { mcapUsd = mcapUsd.slice(0, n); lockedUsd = lockedUsd.slice(0, n); createdAt = createdAt.slice(0, n); migrated = migrated.slice(0, n); children = children.slice(0, n); }
  return { top, from, n, mints, symbols, mcapUsd, lockedUsd, createdAt, migrated, children };
}

/// The rows of `c` at `idx` (ascending) as a chunk of their own, `from` kept (a restart pass dropped the others).
function subChunk(c: FamilyChunk, idx: readonly number[]): FamilyChunk {
  const n = idx.length;
  const out: FamilyChunk = { top: c.top, from: c.from, n, mints: [], symbols: [], mcapUsd: new Float64Array(n), lockedUsd: new Float64Array(n), createdAt: new Float64Array(n), migrated: new Uint8Array(n), children: new Uint32Array(n) };
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    out.mints.push(c.mints[i]); out.symbols.push(c.symbols[i]);
    out.mcapUsd[k] = c.mcapUsd[i]; out.lockedUsd[k] = c.lockedUsd[i]; out.createdAt[k] = c.createdAt[i]; out.migrated[k] = c.migrated[i]; out.children[k] = c.children[i];
  }
  return out;
}

const nul = (v: number): number | null => (Number.isFinite(v) ? v : null);

/// A coin of the light /api/coin as the map node a loaded speck would be (parent = the asset top it is quoted in):
/// the page's pending selection and the search box's "on the map" hit for a coin whose family is not loaded yet.
export const coinNode = (c: Coin, top: string): BubbleNode => ({
  mint: c.mint, parentMint: top, depth: 0, name: c.name ?? null, symbol: c.symbol ?? null, image: c.image ?? null,
  mcapUsd: c.mcapUsd ?? null, lockedUsd: c.lockedUsd ?? null, children: c.children ?? 0, descendants: c.descendants ?? 0,
  migrated: !!c.migrated, createdAt: c.createdAt ?? null,
});

/// The node `mint` would hang from on the map when it is a coin quoted in a listed asset drawn as a family top.
export const assetTopIn = (byMint: ReadonlyMap<string, BubbleNode>, quoteMint: string | null | undefined): BubbleNode | null => {
  const t = quoteMint ? byMint.get(quoteMint) : undefined;
  return t && t.asset === true && (!t.parentMint || !byMint.has(t.parentMint)) ? t : null;
};

/// The search box's ticker score (MapSearch: exact 4, prefix 3, name prefix 2, substring 1); a loaded coin has no name.
export const tickerScore = (symLower: string, needle: string): number => (!symLower ? 0 : symLower === needle ? 4 : symLower.startsWith(needle) ? 3 : symLower.includes(needle) ? 1 : 0);
const zero = (v: number) => (Number.isFinite(v) ? v : 0);

export type FamilySortKey = "locked" | "mcap" | "new";
/// Positions at or above this in a familyOrder result are `extra[pos - FAMILY_EXTRA]` (chunk indices stay far below).
export const FAMILY_EXTRA = 0xf000_0000;
/// The side panel's one order over a family's coins (its kidCmp / SORTS rules: market cap, then locked value, then
/// mint; newest first with the same tie-break; the "locked" key is locked value first): every loaded row, a drawn one included (`live(mint)` = the drawn node, whose live numbers it is
/// sorted by), plus `extra`, the drawn kids the rows do not hold (born since the snapshot). Returns packed positions
/// `chunk index * 65536 + row` (a page is ≤ 10k rows) and `FAMILY_EXTRA + i` for extra[i], so only the slice the panel
/// shows ever becomes nodes.
export function familyOrder(chunks: readonly FamilyChunk[], sort: FamilySortKey, live?: (mint: string) => BubbleNode | null | undefined, extra: readonly BubbleNode[] = []): Uint32Array {
  let m = extra.length;
  for (const c of chunks) m += c.n;
  const pos = new Uint32Array(m), lk = new Float64Array(m), mc = new Float64Array(m), cr = new Float64Array(m), mint: string[] = [];
  let k = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    for (let i = 0; i < c.n; i++) {
      const d = live ? live(c.mints[i]) : null;
      pos[k] = ci * 65_536 + i; mint[k] = c.mints[i];
      if (d) { lk[k] = d.lockedUsd ?? 0; mc[k] = d.mcapUsd ?? 0; cr[k] = d.createdAt ?? 0; }
      else { lk[k] = zero(c.lockedUsd[i]); mc[k] = zero(c.mcapUsd[i]); cr[k] = zero(c.createdAt[i]); }
      k++;
    }
  }
  for (let e = 0; e < extra.length; e++) {
    const d = extra[e];
    pos[k] = FAMILY_EXTRA + e; mint[k] = d.mint; lk[k] = d.lockedUsd ?? 0; mc[k] = d.mcapUsd ?? 0; cr[k] = d.createdAt ?? 0;
    k++;
  }
  const ix = new Uint32Array(k);
  for (let i = 0; i < k; i++) ix[i] = i;
  const byMintAsc = (a: number, b: number) => (mint[a] < mint[b] ? -1 : mint[a] > mint[b] ? 1 : 0);
  const kidL = (a: number, b: number) => lk[b] - lk[a] || mc[b] - mc[a] || byMintAsc(a, b);   // the "locked" key's order
  const kidM = (a: number, b: number) => mc[b] - mc[a] || lk[b] - lk[a] || byMintAsc(a, b);   // SidePanel's kidCmp: market cap first
  const cmp = sort === "mcap" ? kidM : sort === "new" ? (a: number, b: number) => cr[b] - cr[a] || kidM(a, b) : kidL;
  ix.sort(cmp);
  const out = new Uint32Array(k);
  for (let i = 0; i < k; i++) out[i] = pos[ix[i]];
  return out;
}
/// The mint at a packed position of familyOrder (`extra` resolves the drawn kids it was given).
export const mintAtPos = (chunks: readonly FamilyChunk[], p: number, extra?: readonly BubbleNode[]): string | null =>
  p >= FAMILY_EXTRA ? extra?.[p - FAMILY_EXTRA]?.mint ?? null : chunks[Math.floor(p / 65_536)]?.mints[p % 65_536] ?? null;

/// The engine's software tier, read from a canvas the engine already holds a WebGL context on (getContext returns that
/// same context: nothing new is created). Null when there is no canvas or no context yet.
export function softwareGl(canvas: HTMLCanvasElement | null | undefined): boolean | null {
  if (!canvas) return null;
  try {
    const gl = canvas.getContext("webgl2");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe/i.test(r);
  } catch { return null; }
}

/// An HTTP status on an error (ApiError's `status`), 0 when there is none.
const statusOf = (e: unknown): number => { const s = (e as { status?: unknown } | null)?.status; return typeof s === "number" ? s : 0; };
/// A 429's wait in ms: its `retryAfter` (s), else the "try again in N s" of the API limiter's message, else FAMILY_429_MS.
const retryAfterMs = (e: unknown): number => {
  const ra = (e as { retryAfter?: unknown } | null)?.retryAfter;
  if (typeof ra === "number" && Number.isFinite(ra) && ra >= 0) return ra * 1_000;
  const m = /try again in (\d+(?:\.\d+)?)\s*s/i.exec(errorMessage(e));
  return m ? Number(m[1]) * 1_000 : FAMILY_429_MS;
};

// ---------------------------------------------------------------- the store

/// `at` (a seek, see FamilyStoreHandle.seek): the mint the request looks for. A server that answers `?at=` returns that
/// row with `offset` = its index; one that does not returns the page at `offset`, which the seek scans.
export type FamilyFetch = (top: string, q: { offset: number; limit: number; v: number | null; at?: string }, signal: AbortSignal) => Promise<MapFamilyResponse>;
export type FamilyTimers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
export type FamilyStoreOptions = {
  fetchPage: FamilyFetch;
  /// The drawn node of a family top (its `asset` flag and depth, its `children` before page 0 says the total).
  topNode: (mint: string) => BubbleNode | null | undefined;
  /// Phone tier (§2): 2 families, 40k rows, 20k rows a family. `tier` overrides it.
  phone?: boolean;
  /// The engine's tier, read on every pump (the page follows the map's width and the engine's renderer).
  tier?: FamilyTier | (() => FamilyTier);
  now?: () => number;
  /// Injectable timers (tests); default setTimeout / clearTimeout.
  timers?: FamilyTimers;
};
export type FamilySeekState = "wait" | "seeking" | "found" | "missing";
export type FamilyStats = {
  phone: boolean; tier: FamilyTier; inFlight: number; version: number; pages: number; evictions: number; restarts: number; errors: number;
  /// ms spent turning a page's rows into a chunk and its index (the JSON parse is the fetch's), last and worst.
  pageMsLast: number; pageMsMax: number;
  /// the same for the last 64 pages, oldest first
  pageMs: number[];
  /// seek pages asked for, rows the store pinned past a family's cap
  seekPages: number; pinned: number;
  seek: { mint: string; top: string; state: FamilySeekState; at: number | null; from: number | null } | null;
  /// families whose 400 / 404 is final for this page
  gone: string[];
  wants: Record<FamilyWhy, string[]>;
  families: (FamilyInfo & { chunks: number; wanted: boolean })[];
};
export type FamilyStoreHandle = FamilyStore & {
  /// The page's selection when it is a coin of a family that is not loaded (null clears it). Once the family has loaded
  /// what its tier allows and the coin is not among its rows, the store pages on past the cap (keeping none of those
  /// rows) until it finds the coin, then emits it as a 1-row chunk whose `from` is its index in the family's list.
  seek(mint: string | null, top?: string | null): void;
  stats(): FamilyStats; disposed(): boolean;
};

type Fam = {
  top: string;
  chunks: FamilyChunk[];
  /// loaded-order index of each chunk's first row
  starts: number[];
  /// mint → loaded-order index
  rowOf: Map<string, number>;
  nodes: Map<string, BubbleNode>;
  lower: (string[] | undefined)[];
  loaded: number;
  /// the server's total once a page came back, else null (info() then reads the top's `children`)
  total: number | null;
  /// next server offset; null = the server said the list ended
  next: number | null;
  v: number | null;
  error: string | null;
  fails: number;
  ctrl: AbortController | null;
  reserved: number;
  retry: unknown;
  abortT: unknown;
  lastWanted: number;
  info: FamilyInfo | null;
  /// a re-page after a snapshot change: every mint the new snapshot listed so far, and how many of them the family holds
  /// (its count while the pass runs: rows the new snapshot may no longer list do not use up the cap)
  pass: { seen: Set<string>; held: number } | null;
  restarts: number;
};
type Seek = { mint: string; top: string; state: FamilySeekState; at: number | null; v: number | null; from: number | null };

export function createFamilyStore(opts: FamilyStoreOptions): FamilyStoreHandle {
  const { fetchPage, topNode } = opts;
  const now = opts.now ?? (() => Date.now());
  const timers: FamilyTimers = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const tierNow = (): FamilyTier => {
    const t = typeof opts.tier === "function" ? opts.tier() : opts.tier;
    return t === "desktop" || t === "phone" || t === "software" ? t : opts.phone ? "phone" : "desktop";
  };
  let tier = tierNow();
  let lim = FAMILY_LIMITS[tier];
  const fams = new Map<string, Fam>();
  /// top → the 400 / 404 message: not a family, for the page's life
  const gone = new Map<string, string>();
  const wants: Record<FamilyWhy, string[]> = { select: [], search: [], panel: [], view: [] };
  const listeners = new Set<(e: FamilyEvent) => void>();
  let order: string[] = [];
  let rank = new Map<string, number>();
  let inFlight = 0, ver = 0, dead = false, pumping = false, again = false;
  let sk: Seek | null = null;
  const st = { pages: 0, evictions: 0, restarts: 0, errors: 0, pageMsLast: 0, pageMsMax: 0, seekPages: 0, pinned: 0 };
  const pageMs: number[] = [];

  const emit = (e: FamilyEvent) => {
    ver++;
    for (const fn of Array.from(listeners)) { try { fn(e); } catch (err) { console.error("family store listener", err); } }
  };
  const estTotal = (f: Fam) => f.total ?? Math.max(0, topNode(f.top)?.children ?? 0);
  const capOf = (f: Fam) => Math.min(lim.perFamily, f.total ?? Infinity);
  /// the rows that count against the cap: all held, or during a restart pass the held ones the new snapshot listed
  const counted = (f: Fam) => (f.pass ? f.pass.held : f.loaded);
  const final = (f: Fam) => f.fails > FAMILY_BACKOFF_MS.length;
  const stateOf = (f: Fam): FamilyState => {
    if (f.ctrl || (f.retry != null && rank.has(f.top))) return "loading";
    if (final(f)) return "error";
    if (f.next === null || (f.total !== null && counted(f) >= capOf(f))) return "done";
    return f.loaded > 0 ? "partial" : "idle";
  };
  const infoOf = (f: Fam): FamilyInfo => {
    const total = estTotal(f);
    return { top: f.top, total, loaded: f.loaded, cap: Math.min(lim.perFamily, total), state: stateOf(f), v: f.v, error: f.error };
  };
  /// Recomputes a family's info and emits `state` when anything in it moved.
  const touch = (f: Fam) => {
    if (dead || fams.get(f.top) !== f) return;
    const i = infoOf(f), p = f.info;
    if (p && p.state === i.state && p.loaded === i.loaded && p.total === i.total && p.cap === i.cap && p.v === i.v && p.error === i.error) return;
    f.info = i;
    emit({ kind: "state", top: f.top, info: i });
  };
  const newFam = (top: string): Fam => {
    const g = gone.get(top);
    return { top, chunks: [], starts: [], rowOf: new Map(), nodes: new Map(), lower: [], loaded: 0, total: null, next: g === undefined ? 0 : null, v: null, error: g ?? null, fails: g === undefined ? 0 : Infinity, ctrl: null, reserved: 0, retry: null, abortT: null, lastWanted: now(), info: null, pass: null, restarts: 0 };
  };
  const stopRequest = (f: Fam) => {
    if (!f.ctrl) return;
    const c = f.ctrl;
    f.ctrl = null; inFlight--; f.reserved = 0;
    c.abort();
  };
  const clearTimers = (f: Fam) => {
    if (f.retry != null) { timers.clear(f.retry); f.retry = null; }
    if (f.abortT != null) { timers.clear(f.abortT); f.abortT = null; }
  };
  const dropRows = (f: Fam) => { f.chunks = []; f.starts = []; f.rowOf = new Map(); f.nodes = new Map(); f.lower = []; f.loaded = 0; f.pass = null; };
  /// Drops a family: its request, its timers, its arrays; `evict` when it had handed out chunks.
  const evict = (f: Fam) => {
    stopRequest(f); clearTimers(f);
    const had = f.chunks.length > 0;
    dropRows(f);
    fams.delete(f.top);
    if (had) { st.evictions++; emit({ kind: "evict", top: f.top }); }
  };
  const holds = (f: Fam) => f.loaded > 0 || !!f.ctrl;
  const rowsHeld = () => { let r = 0; for (const f of fams.values()) r += f.loaded + f.reserved; return r; };
  /// Evicts the least recently wanted family nobody wants (never `keep`); false when there is none.
  const evictIdle = (keep: Fam): boolean => {
    let best: Fam | null = null;
    for (const f of fams.values()) if (f !== keep && holds(f) && !rank.has(f.top) && (!best || f.lastWanted < best.lastWanted)) best = f;
    if (!best) return false;
    evict(best);
    return true;
  };
  const needsPage = (f: Fam) => !f.ctrl && f.retry == null && !final(f) && f.next !== null && counted(f) < capOf(f);
  /// Appends a chunk of new rows (indexed already) and hands it out.
  const push = (f: Fam, chunk: FamilyChunk, base: number) => {
    f.chunks.push(chunk); f.starts.push(base); f.loaded = base + chunk.n; f.lower.push(undefined);
    emit({ kind: "chunk", top: f.top, chunk });
  };
  /// The end of a restart pass: the rows the new snapshot no longer lists go (one `evict`, then the rest re-handed out
  /// in the same order). Nothing to drop = nothing emitted.
  const settlePass = (f: Fam) => {
    const seen = f.pass?.seen;
    f.pass = null;
    if (!seen || f.rowOf.size === 0) return;
    let missing = 0;
    for (const m of f.rowOf.keys()) if (!seen.has(m)) missing++;
    if (!missing) return;
    const old = f.chunks, nodes = f.nodes;
    f.chunks = []; f.starts = []; f.rowOf = new Map(); f.nodes = new Map(); f.lower = []; f.loaded = 0;
    const kept: FamilyChunk[] = [];
    for (const c of old) {
      const idx: number[] = [];
      for (let i = 0; i < c.n; i++) if (seen.has(c.mints[i])) idx.push(i);
      if (!idx.length) continue;
      const nc = idx.length === c.n ? c : subChunk(c, idx);
      for (let i = 0; i < nc.n; i++) { const m = nc.mints[i]; f.rowOf.set(m, f.loaded + i); const n = nodes.get(m); if (n) f.nodes.set(m, n); }
      f.chunks.push(nc); f.starts.push(f.loaded); f.lower.push(undefined); f.loaded += nc.n;
      kept.push(nc);
    }
    st.evictions++;
    emit({ kind: "evict", top: f.top });
    for (const c of kept) emit({ kind: "chunk", top: f.top, chunk: c });
  };

  const onPage = (f: Fam, offset: number, res: MapFamilyResponse) => {
    if (!res || !Array.isArray(res.nodes) || typeof res.v !== "number" || !Number.isFinite(res.v)) { onFail(f, new Error("bad family page")); return; }
    const total = typeof res.total === "number" && Number.isFinite(res.total) && res.total >= 0 ? res.total : null;
    if (f.v !== null && res.v !== f.v) {
      // the snapshot this family was paging through is gone: page the new one from 0, keeping every row held (the
      // dedupe skips them, so nothing flickers); what the new one no longer lists goes when the pass is through
      st.restarts++; f.restarts++;
      f.v = res.v; f.total = total ?? f.total;
      if (f.restarts <= FAMILY_RESTARTS) {
        f.pass = { seen: new Set(), held: 0 };
        f.next = 0;
        if (offset !== 0) { touch(f); return; }
      } else f.pass = null;
    }
    const t0 = performance.now();
    f.v = res.v;
    f.total = total ?? f.total;
    const base = f.loaded, rowOf = f.rowOf, pass = f.pass, cap = capOf(f);
    let k = 0;
    // dedupe and index in the same pass; past the per-family cap (phones) the rest of the page is left out
    const chunk = rowsToChunk(f.top, offset, res.nodes, (m) => {
      if (pass) { if (pass.seen.has(m)) return true; pass.seen.add(m); }
      if (rowOf.has(m)) { if (pass) pass.held++; return true; }
      if ((pass ? pass.held : base + k) >= cap) return true;
      rowOf.set(m, base + k++);
      if (pass) pass.held++;
      return false;
    });
    const ended = res.next == null || typeof res.next !== "number" || res.next <= offset || res.nodes.length === 0;
    f.next = ended ? null : res.next;
    f.fails = 0; f.error = null;
    const ms = performance.now() - t0;
    st.pages++; st.pageMsLast = ms; if (ms > st.pageMsMax) st.pageMsMax = ms;
    pageMs.push(Math.round(ms * 100) / 100); if (pageMs.length > 64) pageMs.shift();
    if (chunk.n > 0) push(f, chunk, base);
    // a pass that reached the end knows the whole new list; one the cap stopped keeps what it holds
    if (f.pass && ended) settlePass(f);
    else if (f.pass && f.pass.held >= capOf(f)) f.pass = null;
    touch(f);
  };
  /// A seek page: the sought row (pinned as a 1-row chunk), or where to look next, or the end of the list (missing).
  const onSeek = (f: Fam, s: Seek, offset: number, res: MapFamilyResponse) => {
    if (!res || !Array.isArray(res.nodes) || typeof res.v !== "number" || !Number.isFinite(res.v)) { onFail(f, new Error("bad family page")); return; }
    st.seekPages++;
    f.fails = 0; f.error = null;
    s.v = res.v;
    const i = res.nodes.findIndex((r) => Array.isArray(r) && r[0] === s.mint);
    if (i >= 0) {
      const at = (typeof res.offset === "number" && Number.isFinite(res.offset) ? res.offset : offset) + i;
      const base = f.loaded;
      const chunk = rowsToChunk(f.top, at, [res.nodes[i]], (m) => { if (f.rowOf.has(m)) return true; f.rowOf.set(m, base); return false; });
      s.state = "found"; s.from = at;
      if (chunk.n > 0) { st.pinned++; push(f, chunk, base); }
    } else if (typeof res.next === "number" && res.next > offset && res.nodes.length > 0) s.at = res.next;
    else s.state = "missing";
    touch(f);
  };
  const onFail = (f: Fam, err: unknown) => {
    st.errors++;
    const status = statusOf(err);
    f.error = errorMessage(err);
    if (status === 400 || status === 404) {
      // not a family (a bad mint, or neither an asset nor a tracked coin): final for this page, never retried
      gone.set(f.top, f.error);
      f.fails = Infinity; f.next = null;
      if (sk && sk.top === f.top && sk.state !== "found") sk.state = "missing";
      touch(f);
      return;
    }
    f.fails++;
    if (f.fails <= FAMILY_BACKOFF_MS.length) {
      const wait = Math.max(FAMILY_BACKOFF_MS[f.fails - 1], status === 429 ? retryAfterMs(err) : 0);
      f.retry = timers.set(() => { f.retry = null; if (fams.get(f.top) === f) { touch(f); pump(); } }, wait);
    }
    touch(f);
  };
  const run = (f: Fam, q: { offset: number; limit: number; v: number | null; at?: string }, reserve: number, done: (res: MapFamilyResponse) => void) => {
    const ctrl = new AbortController();
    f.ctrl = ctrl; f.reserved = reserve; inFlight++;
    let p: Promise<MapFamilyResponse>;
    try { p = fetchPage(f.top, q, ctrl.signal); } catch (e) { p = Promise.reject(e); }
    p.then((res) => {
      if (f.ctrl !== ctrl || dead) return;
      f.ctrl = null; inFlight--; f.reserved = 0;
      done(res);
      pump();
    }, (err) => {
      if (f.ctrl !== ctrl || dead) return;
      f.ctrl = null; inFlight--; f.reserved = 0;
      onFail(f, err);
      pump();
    });
  };
  const start = (f: Fam, limit: number) => {
    const offset = f.next ?? 0;
    run(f, { offset, limit, v: f.v }, limit, (res) => onPage(f, offset, res));
  };
  /// The sought coin's family has loaded what it may (its cap, or the rows limit holds it back) and the coin is not in it.
  const seekable = (f: Fam | undefined, s: Seek | null): f is Fam =>
    !!f && !!s && s.state !== "found" && s.state !== "missing" && rank.has(f.top) && !f.ctrl && f.retry == null && !final(f)
    && f.total !== null && f.next !== null && !f.rowOf.has(s.mint);
  const startSeek = (f: Fam, s: Seek) => {
    const offset = s.at ?? f.next ?? 0;
    s.state = "seeking"; s.at = offset;
    run(f, { offset, limit: FAMILY_PAGE, v: s.v ?? f.v, at: s.mint }, 0, (res) => { if (sk === s) onSeek(f, s, offset, res); });
  };

  const pumpOnce = () => {
    const t = now();
    tier = tierNow(); lim = FAMILY_LIMITS[tier];
    // 1. every wanted family exists, is stamped, and loses a pending abort
    for (const top of order) {
      let f = fams.get(top);
      if (!f) { f = newFam(top); fams.set(top, f); }
      f.lastWanted = t;
      if (f.abortT != null) { timers.clear(f.abortT); f.abortT = null; }
    }
    // 2. an unwanted family's request is aborted after FAMILY_ABORT_MS; one that holds nothing is forgotten
    for (const f of Array.from(fams.values())) {
      if (rank.has(f.top)) continue;
      if (f.ctrl && f.abortT == null) f.abortT = timers.set(() => { f.abortT = null; if (!dead && fams.get(f.top) === f && !rank.has(f.top) && f.ctrl) { stopRequest(f); touch(f); pump(); } }, FAMILY_ABORT_MS);
      if (!holds(f) && !f.chunks.length) { clearTimers(f); fams.delete(f.top); }
    }
    // 3. the tier's family limit (wanted first, in want order; then the most recently wanted)
    const holders = Array.from(fams.values()).filter(holds);
    if (holders.length > lim.families) {
      holders.sort((a, b) => (rank.get(a.top) ?? Infinity) - (rank.get(b.top) ?? Infinity) || b.lastWanted - a.lastWanted);
      for (const f of holders.slice(lim.families)) evict(f);
    }
    // 4. pages, most wanted family first, two in flight at most
    for (const top of order) {
      if (inFlight >= FAMILY_IN_FLIGHT) break;
      const f = fams.get(top);
      if (!f || !needsPage(f)) continue;
      if (!holds(f)) {
        let n = 0;
        for (const g of fams.values()) if (holds(g)) n++;
        if (n >= lim.families && !evictIdle(f)) continue;
      }
      // full pages (the server prepares each (offset, limit) once per snapshot for every client); only the phone cap
      // and the rows limit cut one short
      const want = Math.min(FAMILY_PAGE, lim.perFamily - counted(f));
      let room = lim.rows - rowsHeld();
      while (room < want && evictIdle(f)) room = lim.rows - rowsHeld();
      const limit = Math.min(want, room);
      if (limit < 1) continue;
      start(f, limit);
    }
    // 5. the selection past its family's cap: one request at a time, rows not kept. A coin the family's own pages
    // brought in is found; one a fully paged family does not list is missing.
    if (sk && sk.state !== "found" && sk.state !== "missing") {
      const f = fams.get(sk.top);
      if (f && f.rowOf.has(sk.mint)) sk.state = "found";
      else if (f && !f.ctrl && f.total !== null && (f.next === null || final(f))) sk.state = "missing";
      else if (inFlight < FAMILY_IN_FLIGHT && seekable(f, sk)) startSeek(f, sk);
    }
    for (const f of Array.from(fams.values())) touch(f);
  };
  const pump = () => {
    if (dead) return;
    if (pumping) { again = true; return; }
    pumping = true;
    try { let guard = 0; do { again = false; pumpOnce(); } while (again && ++guard < 16); } finally { pumping = false; }
  };
  const famOf = (mint: string): Fam | null => { for (const f of fams.values()) if (f.rowOf.has(mint)) return f; return null; };
  const chunkAt = (f: Fam, idx: number): number => {
    let lo = 0, hi = f.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (f.starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo;
  };

  const store: FamilyStoreHandle = {
    want(tops, why) {
      if (dead || !WHYS.includes(why)) return;
      const prev = new Set(wants[why]);
      const next = Array.from(new Set(tops.filter((m) => typeof m === "string" && m.length > 0)));
      wants[why] = next;
      // a family in `error` that a caller asks for anew gets a fresh run of attempts (never one that is not a family)
      for (const m of next) { const f = fams.get(m); if (f && !prev.has(m) && final(f) && !gone.has(m)) { f.fails = 0; f.error = null; } }
      const seen = new Set<string>(); order = [];
      for (const w of WHYS) for (const m of wants[w]) if (!seen.has(m)) { seen.add(m); order.push(m); }
      rank = new Map(order.map((m, i) => [m, i]));
      pump();
    },
    seek(mint, top) {
      if (dead) return;
      const m = typeof mint === "string" && mint ? mint : null, t = typeof top === "string" && top ? top : null;
      if (!m || !t) { sk = null; return; }
      if (sk && sk.mint === m && sk.top === t) return;
      // a request of the previous seek runs out; its answer is ignored (sk !== s)
      sk = { mint: m, top: t, state: "wait", at: null, v: null, from: null };
      pump();
    },
    info(top) { const f = fams.get(top); return f ? (f.info ?? infoOf(f)) : null; },
    chunks(top) { return fams.get(top)?.chunks ?? []; },
    node(mint) {
      const f = famOf(mint);
      if (!f) return null;
      const hit = f.nodes.get(mint);
      if (hit) return hit;
      const idx = f.rowOf.get(mint)!;
      const ci = chunkAt(f, idx), c = f.chunks[ci], i = idx - f.starts[ci];
      const t = topNode(f.top);
      const n: BubbleNode = {
        mint, parentMint: f.top, depth: t?.asset ? 0 : (t?.depth ?? 0) + 1, name: null, symbol: c.symbols[i], image: null,
        mcapUsd: nul(c.mcapUsd[i]), lockedUsd: nul(c.lockedUsd[i]), children: c.children[i], migrated: c.migrated[i] === 1, createdAt: nul(c.createdAt[i]),
      };
      f.nodes.set(mint, n);
      return n;
    },
    familyOf(mint) { return famOf(mint)?.top ?? null; },
    search(needle, max) {
      const q = needle.trim().toLowerCase().replace(/^\$/, "");
      if (!q || max < 1) return [];
      // the best `max` hits, kept sorted (score, then locked, then mcap, as MapSearch ranks)
      const best: { f: Fam; ci: number; i: number; s: number; l: number; m: number }[] = [];
      const better = (s: number, l: number, m: number, b: (typeof best)[number]) => s - b.s || l - b.l || m - b.m;
      for (const f of fams.values()) {
        for (let ci = 0; ci < f.chunks.length; ci++) {
          const c = f.chunks[ci];
          const low = f.lower[ci] ?? (f.lower[ci] = c.symbols.map((s) => (s ?? "").toLowerCase()));
          for (let i = 0; i < c.n; i++) {
            const s = tickerScore(low[i], q);
            if (!s) continue;
            const l = zero(c.lockedUsd[i]), m = zero(c.mcapUsd[i]);
            if (best.length >= max && better(s, l, m, best[best.length - 1]) <= 0) continue;
            let at = best.length;
            while (at > 0 && better(s, l, m, best[at - 1]) > 0) at--;
            best.splice(at, 0, { f, ci, i, s, l, m });
            if (best.length > max) best.pop();
          }
        }
      }
      return best.map((h) => store.node(h.f.chunks[h.ci].mints[h.i])).filter((n): n is BubbleNode => !!n);
    },
    busy() { return inFlight > 0; },
    version() { return ver; },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    dispose() {
      if (dead) return;
      dead = true;
      for (const f of fams.values()) { stopRequest(f); clearTimers(f); dropRows(f); }
      fams.clear(); listeners.clear(); inFlight = 0; sk = null;
      for (const w of WHYS) wants[w] = [];
      order = []; rank = new Map();
    },
    disposed() { return dead; },
    stats() {
      return {
        phone: tier === "phone", tier, inFlight, version: ver, ...st, pageMs: pageMs.slice(),
        seek: sk ? { mint: sk.mint, top: sk.top, state: sk.state, at: sk.at, from: sk.from } : null,
        gone: Array.from(gone.keys()),
        wants: { select: wants.select.slice(), search: wants.search.slice(), panel: wants.panel.slice(), view: wants.view.slice() },
        families: Array.from(fams.values()).map((f) => ({ ...infoOf(f), chunks: f.chunks.length, wanted: rank.has(f.top) })),
      };
    },
  };
  return store;
}

// ---------------------------------------------------------------- React

/// One store per Map page, disposed on unmount (a development double mount gets a fresh one). `byMint` is the page's
/// live node map (the same Map for the life of the page), read through a ref whenever the store needs a top. `tier` is
/// read on every pump, so the store's caps follow the engine's as the map's width or renderer changes.
export function useFamilyStore({ byMint, tier }: { byMint: ReadonlyMap<string, BubbleNode>; tier: () => FamilyTier }): FamilyStoreHandle {
  const byMintRef = useRef(byMint); byMintRef.current = byMint;
  const tierRef = useRef(tier); tierRef.current = tier;
  const make = () => createFamilyStore({ fetchPage: (top, q, signal) => api.mapFamily(top, q, signal), topNode: (m) => byMintRef.current.get(m), tier: () => tierRef.current() });
  const [store, setStore] = useState(make);
  useEffect(() => {
    if (store.disposed()) { setStore(make()); return; }
    return () => store.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);
  return store;
}

/// `families.node(mint)` kept current: re-renders the caller only when that node appears, changes or goes (never per
/// page of some other family's rows). Null mint or store → null.
export function useFamilyNode(families: FamilyStore | null | undefined, mint: string | null): BubbleNode | null {
  const read = () => (families && mint ? families.node(mint) : null);
  const [n, setN] = useState<BubbleNode | null>(read);
  useEffect(() => {
    if (!families || !mint) { setN(null); return; }
    setN(families.node(mint));
    return families.subscribe((e) => { if (e.kind !== "state") setN(families.node(mint)); });
  }, [families, mint]);
  return families && mint && n && n.mint === mint ? n : null;
}

/// One family's info and a version that moves with its rows, for a panel that lists them: updates at most every
/// `ms` while pages land, at once on an evict or a state change that is not just more rows.
export function useFamilyInfo(families: FamilyStore | null | undefined, top: string | null, ms = 300): { info: FamilyInfo | null; version: number } {
  const [s, setS] = useState<{ info: FamilyInfo | null; version: number }>(() => ({ info: families && top ? families.info(top) : null, version: 0 }));
  useEffect(() => {
    if (!families || !top) { setS({ info: null, version: 0 }); return; }
    let t: ReturnType<typeof setTimeout> | null = null, last = 0, alive = true;
    const flush = () => { t = null; last = Date.now(); if (alive) setS((p) => ({ info: families.info(top), version: p.version + 1 })); };
    flush();
    const off = families.subscribe((e) => {
      if (e.top !== top) return;
      const urgent = e.kind === "evict" || (e.kind === "state" && e.info.state !== "loading" && e.info.state !== "partial");
      if (urgent) { if (t) clearTimeout(t); flush(); return; }
      if (!t) t = setTimeout(flush, Math.max(0, last + ms - Date.now()));
    });
    return () => { alive = false; off(); if (t) clearTimeout(t); };
  }, [families, top, ms]);
  return s;
}

/// The store's version, re-read at most every `ms` while `on` (a search box with a query): what it lists from loaded
/// rows follows pages that land while it is open, without a render per page.
export function useFamilyVersion(families: FamilyStore | null | undefined, on: boolean, ms = 300): number {
  const [v, setV] = useState(() => families?.version() ?? 0);
  useEffect(() => {
    if (!families || !on) return;
    let t: ReturnType<typeof setTimeout> | null = null, last = 0, alive = true;
    const flush = () => { t = null; last = Date.now(); if (alive) setV(families.version()); };
    flush();
    const off = families.subscribe(() => { if (!t) t = setTimeout(flush, Math.max(0, last + ms - Date.now())); });
    return () => { alive = false; off(); if (t) clearTimeout(t); };
  }, [families, on, ms]);
  return v;
}
