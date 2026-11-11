// The in-memory working set: every coin and mint the indexer knows, the parent → children index and
// the derived numbers the API serves (prices up the quote chain, locked value, descendants).
//
// Everything mutating the tree goes through here so sqlite stays in sync and every reader sees one
// consistent snapshot. Derived numbers are recomputed at most once per `version` bump, so a burst
// of live trades costs one pass, not one per request.
import { USDC_MINT, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "./sdk.mjs";
import { priceQuoteOf, chainPrices, progressOf, units, mcapCapOf, liqQuoteOf } from "./pricing.mjs";
import { imageProxyUrl } from "./meta.mjs";
import { Activity } from "./activity.mjs";
import { drain, runSliced } from "./sliced.mjs";

const nowS = () => Math.floor(Date.now() / 1000);
/**
 * computed() walks every indexed coin (about 345k on mainnet, 1-3 s on the VPS) and every live trade bumps
 * the version, so the map flush (every 3 s), refresh and stats used to re-run it back to back and starve the
 * event loop (API answers took 2-9 s). On a large index a new pass starts at most every COMPUTED_MIN_MS and
 * runs in the background on the sliced scheduler (sliced.mjs: SLICE_MS of the event loop per turn, shared with
 * the map jobs); callers get the last finished table meanwhile (they read it with ?. / ?? {}). Small indexes
 * (tests, a fresh devnet) recompute synchronously.
 */
export const COMPUTED_MIN_MS = 5_000;
export const COMPUTED_THROTTLE_MIN_COINS = 20_000;
const SOL_DECIMALS = 9;
// `PublicKey.toBase58()` encodes on every call (bn.js); `decimalsOf` runs millions of times per
// derived pass at 15k coins, so the SOL mint is compared as a string constant.
const SOL_MINT = NATIVE_MINT.toBase58();
/** The optional mcapCapUsd field: present only when the coin's mcap is capped by its liquidity. */
const capField = (cap) => (cap != null ? { mcapCapUsd: cap } : {});
const shortMint = (m) => `${m.slice(0, 4)}…${m.slice(-4)}`;
/** A USD value of a family row: 4 significant digits, null when unknown. */
const p4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toPrecision(4));
/** A family row's raw sort key: the value, or -1 when unknown (mapAll's and assetDrawn's `?? -1`). */
const sortKey = (x) => (x == null || !Number.isFinite(x) ? -1 : x);
// A verified spawn (POST /api/spawned) stays "pending ours" this long while the indexer looks for
// the fee-sharing config that proves it (DESIGN §11.1); a genuine split lands within seconds of the
// create, so anything still unconfirmed after this is not ours and the flag drops.
export const PENDING_TTL_MS = 10 * 60_000;
// Pending entries are bounded: beyond this the oldest is dropped, so the map can never grow past
// what a few minutes of real launches need.
export const PENDING_MAX = 500;
// The whole-forest map (DESIGN §11.5) is rebuilt at most once per this window, and only when the
// model version moved; the delta variant (`since=`) shares the window.
export const MAP_CACHE_MS = 10_000;
/**
 * since= deltas kept: at most this many entries, and at most this many nodes over all of them, the oldest dropped
 * first. A cursor older than the index gives the whole forest flat (~93k nodes, ~70 MB with its encoded bytes on the
 * local index), so the entry count alone let 64 of those pile up.
 */
export const MAP_SINCE_ENTRIES = 64;
export const MAP_SINCE_NODES = 250_000;
/** How many coins of a listed asset's family the full map draws (every coin with children or younger than a day, then the biggest by locked value); the rest stay in the index and in the family's counts. */
export const ASSET_FAMILY_DRAW = 300;
// Family snapshots (`/api/map/family/:mint`, DESIGN-FAMILY-ALL §4): every coin of one family, biggest
// first, with mapRef's numbers. A snapshot is rebuilt like the map (version moved and MAP_CACHE_MS passed)
// and stays readable by its `v` for FAMILY_SNAPSHOT_MS after its last read, so a client paging through it
// sees one list. Held snapshots sit in two pools with an estimated byte budget each, least recently read
// dropped first: the listed-asset families (PUMP, USDC, …: few, big, the ones a client pages through) and
// every other family (a tracked coin's children: small, but any tracked mint can be asked for). A request
// for a small family therefore never pushes out an asset family that a client is paging. A leaf is never held.
export const FAMILY_SNAPSHOT_MS = 120_000;
/** Estimated bytes the held snapshots of listed-asset families may take, and those of every other family. */
export const FAMILY_ASSET_BYTES = 128 * 2 ** 20;
export const FAMILY_COIN_BYTES = 16 * 2 ** 20;
/**
 * The estimate: a fixed cost per snapshot, per row (113 B/row measured on the local index's $PUMP, 50k
 * rows), and per byte of a kept encoded page (its bytes plus its gzip and brotli, ≈ 0.5 each; the JSON text
 * is dropped once encoded).
 */
export const FAMILY_SNAP_BYTES = 1_024;
export const FAMILY_ROW_BYTES = 128;
export const FAMILY_PAGE_COPIES = 2;
/** Rows per family page by default, and the most one page may ask for. */
export const FAMILY_PAGE = 5_000;
export const FAMILY_PAGE_MAX = 10_000;
/** Encoded pages kept per snapshot (one per distinct offset/limit asked), and their estimated bytes at most (oldest out first). */
export const FAMILY_PAGES = 64;
export const FAMILY_PAGE_BYTES = 32 * 2 ** 20;
// The map's heat sidecar (`/api/map/heat`, DESIGN §11.5) is rebuilt at most once per this window:
// it decays with the clock, not with model versions, so it has no version key.
export const HEAT_CACHE_MS = 15_000;
// Coin fields whose change alters a map node or the coin page; bookkeeping stamps are left out so
// a refresh tick that re-reads an unchanged curve does not mark the coin as updated.
// `creatorFee` (fees accrued on the curve, read by the treasury) lives in memory only and moves
// with every trade without touching a bubble.
const STAMP_SKIP = new Set(["refreshedAt", "sharesAt", "createdProbe", "updatedAt", "mint", "creatorFee"]);
// Fields of a child that move its parent's locked value / child count.
const PARENT_KEYS = ["realQuoteReserves", "migrated", "poolQuote", "tracked"];
const same = (a, b) => (a === b ? true : typeof a === "object" && typeof b === "object" && a !== null && b !== null ? JSON.stringify(a) === JSON.stringify(b) : false);

export class Model {
  constructor(db, { platformWallet, splitBps, platformMinBps = null, mode = "all", now = Date.now, log = console, assetFamilyDraw = ASSET_FAMILY_DRAW, mapSinceNodes = MAP_SINCE_NODES } = {}) {
    this.db = db; this.log = log; this.now = now; this.assetFamilyDraw = assetFamilyDraw; this.mapSinceNodes = mapSinceNodes;
    this.platformWallet = platformWallet; this.splitBps = splitBps;
    // The platform share a sharing config must carry to count as ours: the configured platform
    // slice (50% by default). Mere presence is not enough — anyone can write a config that names
    // the platform at 1 bps and would otherwise be listed as a Spore launch.
    this.platformMinBps = Math.max(1, Number(platformMinBps ?? splitBps?.[3] ?? 5000));
    this.mode = mode === "ours" ? "ours" : "all"; // "ours": the API shows only coins whose fee split includes the platform (DESIGN §11.1)
    this.pending = new Map();       // mint → { at (ms), sig }: spawns the UI reported, awaiting their sharing config
    this.scopeVersion = -1; this.scopeCache = null;
    this.coins = new Map(); this.mints = new Map(); this.meta = new Map();
    this.imageUrls = new Set();     // every image URL the API has handed out (the proxy serves only these)
    this.children = new Map();      // quoteMint → Set<child mint>
    this.curves = new Map();        // bonding curve address → mint (the curve itself does not store it)
    this.pools = new Map();         // pool address → mint (graduated coins; maps pump-amm events back)
    this.solUsd = null; this.solUsdAt = 0;
    this.quoteUsd = new Map();      // USD price of listed non-SOL quote mints we can price (PUMP, …)
    this.quoteMcap = new Map();     // circulating USD market cap of a listed quote asset, where the price feed gives one (PUMP)
    this.global = null;             // decoded pump Global (plain)
    this.backfill = { done: false, total: 0, resolved: 0 };
    this.version = 0; this.derivedVersion = -1; this.derived = new Map(); this.derivedAt = 0; this.derivedMs = 0; this.computeSliceMinCoins = COMPUTED_THROTTLE_MIN_COINS;
    // `computed()` runs after every version bump (each live trade is one), so its per-coin inputs are
    // memoized: a coin object is never mutated once indexed (upsertCoin builds a new one), so its
    // quote price and the value it locks in its parent are cached by object identity; descendant
    // counts change only when the parent → child structure does (`structVersion`).
    this.pqMemo = new WeakMap();    // coin → { pq, bd, qd, dv }: dv = `decVersion` the decimals were read at
    this.decVersion = 0;            // moves when any mint's decimals change
    this.lockMemo = new WeakMap();  // coin → bigint it locks in its parent
    this.structVersion = 0; this.descVersion = -1; this.descCache = new Map();
    // Exact 24 h / 1 h trade counters per mint, seeded from sqlite at load and fed by recordTrade.
    // They include trades the 2 000-rows-per-mint SQL trim later deletes (db.insertTrade), so a mint
    // with more than 2 000 trades in 24 h can exceed a SQL recount until the next restart re-seeds.
    this.activity = new Activity({ now: () => Math.floor(this.now() / 1000) });
    this.heatCache = null;
    this.touched = new Map();       // mint → last API access (ms); the refresh loop prioritises these
    this.updatedAt = nowS();
    // Map delta-sync (DESIGN §11.5): coins whose node changed since the last `mapdelta` flush, the
    // uri → mints index that turns a resolved metadata JSON into stamped coins, the cached forest
    // and the time of the last full build (stamps never fall behind it, see #stamp).
    this.dirty = new Set();
    this.byUri = new Map();         // metadata uri → Set<mint>
    this.mapCache = null; this.mapSinceCache = new Map(); this.totalCache = null;
    this.lastGeneratedAt = 0;
    this.mapStats = { builds: 0, lastBuildMs: null, maxBuildMs: 0, lastSlices: null, maxSliceMs: 0 }; // full-forest builds (health); slices: of the last sliced build, maxSliceMs: the longest one so far
  }

  load() {
    for (const m of this.db.allMints()) { this.mints.set(m.mint, m); this.#indexUri(m.mint, null, m.uri); }
    this.decVersion++;
    for (const m of this.db.allMeta()) { this.meta.set(m.uri, m); if (m.image) this.imageUrls.add(m.image); }
    for (const c of this.db.allCoins()) this.#index(c);
    this.solUsd = this.db.kvGet("solUsd"); this.solUsdAt = this.db.kvGet("solUsdAt", 0);
    this.quoteUsd = new Map(Object.entries(this.db.kvGet("quoteUsd", {})));
    this.quoteMcap = new Map(Object.entries(this.db.kvGet("quoteMcap", {})));
    this.global = this.db.kvGet("global");
    this.pending = new Map(Object.entries(this.db.kvGet("oursPending", {})));
    for (const [mint, url] of Object.entries(this.db.kvGet("assetIcons", {}) ?? {})) if (typeof url === "string" && url.startsWith("https://")) { this.assetIcons.set(mint, url); this.imageUrls.add(url); }
    const t0 = performance.now();
    const seeded = this.activity.seed(this.db.tradesWindow(Math.floor(this.now() / 1000) - this.activity.dayS));
    this.activity.seededMs = Math.round(performance.now() - t0);
    this.#bump();
    this.log.info?.(`model: ${this.coins.size} coins, ${this.mints.size} mints, ${this.meta.size} metadata entries loaded`);
    this.log.info?.(`activity seeded ${seeded} trades in ${this.activity.seededMs} ms`);
  }

  #bump() { this.version++; this.updatedAt = nowS(); }
  /**
   * Marks a coin's map node as changed: `updatedAt` (ms) moves forward and the mint joins the
   * `mapdelta` batch. Stamps are kept strictly after the last full map build, so a change that lands
   * in the same millisecond as a `generatedAt` is still caught by `since=<generatedAt>`.
   */
  #stamp(mint, { persist = true } = {}) {
    const c = this.coins.get(mint);
    if (!c) return;
    const at = Math.max(this.now(), this.lastGeneratedAt + 1, (c.updatedAt ?? 0) + 1);
    c.updatedAt = at;
    this.dirty.add(mint);
    if (persist && c.tracked) this.db.touchCoin(mint, at);
  }
  #indexUri(mint, oldUri, newUri) {
    if (oldUri === newUri) return;
    if (oldUri) { const s = this.byUri.get(oldUri); if (s) { s.delete(mint); if (!s.size) this.byUri.delete(oldUri); } }
    if (newUri) { if (!this.byUri.has(newUri)) this.byUri.set(newUri, new Set()); this.byUri.get(newUri).add(mint); }
  }
  /** Mints (coins or not) whose on-chain uri is this one. */
  mintsOfUri(uri) { return [...(this.byUri.get(uri) ?? [])]; }
  /** Drains the set of coins whose map node changed since the last call (the `mapdelta` batch). */
  takeDirty() { const out = [...this.dirty]; this.dirty.clear(); return out; }
  /** Puts mints back for the next batch (a capped `mapdelta` carries the rest over). */
  requeueDirty(mints) { for (const m of mints) this.dirty.add(m); }
  #index(c) {
    const prev = this.coins.get(c.mint);
    if (prev && prev.quoteMint !== c.quoteMint) this.children.get(prev.quoteMint)?.delete(c.mint);
    if (!prev || prev.quoteMint !== c.quoteMint || prev.tracked !== c.tracked) this.structVersion++;
    this.coins.set(c.mint, c);
    if (c.quoteMint) { if (!this.children.has(c.quoteMint)) this.children.set(c.quoteMint, new Set()); this.children.get(c.quoteMint).add(c.mint); }
    if (c.curve) this.curves.set(c.curve, c.mint);
    if (c.pool) this.pools.set(c.pool, c.mint);
  }
  byCurve(curve) { const m = this.curves.get(curve); return m ? this.coins.get(m) ?? null : null; }

  // ---------------------------------------------------------------- mutations
  /**
   * Inserts or merges a coin. Unknown fields keep their previous value; `tracked` only ever turns
   * on. Untracked coins (an on-demand lookup of a foreign coin nobody spawned under) live in memory
   * only and are evicted when nobody looks at them (`evictUntracked`), so browsing pump.fun through
   * /api/coin cannot grow the database.
   */
  upsertCoin(partial) {
    const prev = this.coins.get(partial.mint);
    const patch = stripUndefined(partial);
    const c = {
      tracked: true, complete: false, migrated: false, mayhem: false, holderReward: false, creatorFeeBps: 0,
      virtualTokenReserves: "0", virtualQuoteReserves: "0", realTokenReserves: "0", realQuoteReserves: "0", tokenTotalSupply: "0", initialVirtualQuoteReserves: "0",
      pool: null, poolBaseVault: null, poolQuoteVault: null, poolBase: null, poolQuote: null, poolVirtualQuote: null,
      createdAt: null, createdSlot: null, createdProbe: false, shares: null, sharesAt: 0, refreshedAt: 0, feePaid: null,
      ...prev, ...patch, updatedAt: prev?.updatedAt ?? 0,
    };
    // Tracked only ever turns on: an explicit `tracked: true` (or a brand-new coin without the flag)
    // joins the tree; a later reserve update of an untracked coin leaves it untracked.
    c.tracked = prev ? !!(prev.tracked || partial.tracked === true) : partial.tracked !== false;
    // `updatedAt` (ms) moves only when something a map node or coin page shows actually changed:
    // the rolling refresh re-reads every curve and most of them come back identical.
    const changed = !prev || Object.keys(patch).some((k) => !STAMP_SKIP.has(k) && !same(prev[k], c[k])) || prev.tracked !== c.tracked;
    this.#index(c);
    if (changed) {
      c.updatedAt = Math.max(this.now(), this.lastGeneratedAt + 1, (prev?.updatedAt ?? 0) + 1);
      this.dirty.add(c.mint);
    }
    if (c.tracked) this.db.upsertCoin(c);
    if (changed) {
      // The parent's locked value and child count follow from the child's state.
      const parentMoved = !prev || PARENT_KEYS.some((k) => !same(prev[k], c[k]));
      if (prev && prev.quoteMint && prev.quoteMint !== c.quoteMint) this.#stamp(prev.quoteMint);
      if (c.quoteMint && c.tracked && (parentMoved || prev?.quoteMint !== c.quoteMint)) this.#stamp(c.quoteMint);
      this.#bump();
    }
    return c;
  }
  /**
   * Drops untracked coins nobody asked for in `idleMs` (no children, not pending, not viewed):
   * they were fetched for a coin page or an eligibility check and would otherwise accumulate for
   * every pump.fun coin ever viewed. Returns how many were removed.
   */
  evictUntracked({ idleMs = 10 * 60_000 } = {}) {
    const cutoff = Date.now() - idleMs;
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.tracked || this.pending.has(c.mint) || (this.children.get(c.mint)?.size ?? 0) > 0) continue;
      if ((this.touched.get(c.mint) ?? 0) > cutoff || (c.updatedAt ?? 0) > cutoff) continue;
      this.coins.delete(c.mint);
      if (c.curve) this.curves.delete(c.curve);
      if (c.pool) this.pools.delete(c.pool);
      if (c.quoteMint) this.children.get(c.quoteMint)?.delete(c.mint);
      this.touched.delete(c.mint);
      n++;
    }
    if (n) { this.structVersion++; this.#bump(); }
    return n;
  }
  /** Forgets API views older than `maxAgeMs`: the refresh loop only reads newer ones, so older entries are dead weight. */
  pruneTouched(maxAgeMs = 120_000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [m, t] of this.touched) if (t <= cutoff) this.touched.delete(m);
  }
  setMint(info) {
    const prev = this.mints.get(info.mint) ?? { mint: info.mint, decimals: null, tokenProgram: null, supply: null, name: null, symbol: null, uri: null, onchainAt: 0 };
    const m = { ...prev, ...stripUndefined(info) };
    this.mints.set(m.mint, m);
    if (prev.decimals !== m.decimals) this.decVersion++;
    this.#indexUri(m.mint, prev.uri, m.uri);
    this.db.upsertMint(m);
    // A name, ticker or metadata pointer that just resolved changes the coin's label on the map.
    if (prev.name !== m.name || prev.symbol !== m.symbol || prev.uri !== m.uri) this.#stamp(m.mint);
    this.#bump();
    return m;
  }
  setMeta(uri, meta) {
    const prev = this.meta.get(uri);
    const m = { uri, ...meta };
    this.meta.set(uri, m);
    if (m.image) this.imageUrls.add(m.image);
    this.db.metaSet(m);
    // A logo that just arrived (or changed) reaches every coin behind this uri: `since=` and `mapdelta`.
    if ((prev?.image ?? null) !== (m.image ?? null)) {
      for (const mint of this.mintsOfUri(uri)) this.#stamp(mint);
      if (m.image) this.#imageSeen(m.image);
    }
    this.#bump();
  }
  /**
   * Called with every image URL the moment the model first learns it (a metadata image, a listed asset's icon):
   * index.mjs points it at ImageCache.enqueueThumb, so the logo's thumbnail is made at first sight, not when the
   * next warm pass reaches it (or never, when its host dies first). Never throws into the caller.
   */
  onImage = null;
  #imageSeen(url) { try { this.onImage?.(url); } catch (e) { this.log.warn?.(`model: onImage: ${e?.message ?? e}`); } }
  /** Has the API handed out this image URL (so the proxy may fetch it)? */
  knownImage(url) { return this.imageUrls.has(url); }
  /**
   * The raw image URL behind a mint's logo (the one ref()/view()/assetMapRef wrap with imageProxyUrl),
   * or null: the metadata image when the coin's JSON has one, else a listed asset's stored icon.
   * GET /api/logo-sheet resolves its mints through this, so a sheet cell is the same file /api/img serves.
   */
  imageOfMint(mint) { return this.metaFor({ mint })?.image ?? this.assetIcons.get(mint) ?? null; }
  /** Is a file of our metadata host (`<sha256>.<ext>`) the uri or image of any coin we know? */
  referencesMetaFile(name) {
    const tail = `/m/${name}`;
    for (const m of this.mints.values()) if (m.uri && m.uri.endsWith(tail)) return true;
    for (const m of this.meta.values()) if (m.image && m.image.endsWith(tail)) return true;
    return false;
  }
  setSolUsd(v) { if (v > 0) { this.solUsd = v; this.solUsdAt = nowS(); this.db.kvSet("solUsd", v); this.db.kvSet("solUsdAt", this.solUsdAt); this.#bump(); } }
  setQuoteUsd(mint, v) { if (v > 0) { this.quoteUsd.set(mint, v); this.db.kvSet("quoteUsd", Object.fromEntries(this.quoteUsd)); this.#bump(); } }
  /**
   * A listed quote asset's circulating USD market cap, from the same CoinGecko call that prices it: what its
   * map bubble shows as mcap (display only, the asset top still counts 0 in mcap sizing). Bumps only when it moved.
   */
  setQuoteMcap(mint, v) {
    const n = Number(v);
    if (!(n > 0) || !Number.isFinite(n) || this.quoteMcap.get(mint) === n) return false;
    this.quoteMcap.set(mint, n); this.db.kvSet("quoteMcap", Object.fromEntries(this.quoteMcap)); this.#bump();
    return true;
  }
  /** The stored circulating market cap of a listed quote asset, or null. */
  quoteMcapOf(mint) { return this.quoteMcap.get(mint) ?? null; }
  /** Many listed quote prices at once (the Jupiter refresh): one kvSet and one bump, only when a value moved. Returns how many changed. */
  setQuoteUsdMany(obj) {
    let n = 0;
    for (const [mint, v0] of Object.entries(obj ?? {})) {
      const v = Number(v0);
      if (!(v > 0) || !Number.isFinite(v) || this.quoteUsd.get(mint) === v) continue;
      this.quoteUsd.set(mint, v); n++;
    }
    if (n) { this.db.kvSet("quoteUsd", Object.fromEntries(this.quoteUsd)); this.#bump(); }
    return n;
  }
  /**
   * USD per 1 unit of a depth-0 coin's quote when that quote is "other" (neither SOL nor USDC): the
   * listed price. A root whose quote is itself a coin we hold only happens on a cycle (the chain walk
   * stops at a mint it already visited), which has no price.
   */
  #rootOtherUsd(root) {
    const q = root.quoteMint;
    if (q == null || this.coins.has(q)) return null;
    return this.quoteUsd.get(q) ?? null;
  }
  /** USD per 1 unit of a coin's quote read from a computed() table (no chain walk): what liqUsd multiplies by. */
  #quoteUsdIn(mint, d) {
    if (mint == null || mint === SOL_MINT) return this.solUsd;
    if (mint === USDC_MINT) return 1;
    if (this.coins.has(mint)) return d.get(mint)?.priceUsd ?? null;
    return this.quoteUsd.get(mint) ?? null;
  }
  /** mcapCapUsd of a coin (sizing by mcap, pricing.mjs LIQ_X): the capped value, or null when uncapped or the liquidity is unknown. */
  mcapCapOf(c, mcapUsd, d = this.computed()) {
    if (!(mcapUsd > 0)) return null;
    const q = liqQuoteOf(c, this.quoteDecimals(c));
    const qu = q != null ? this.#quoteUsdIn(c.quoteMint, d) : null;
    return qu != null ? mcapCapOf(mcapUsd, q * qu) : null;
  }
  /** USD per 1 unit of a quote mint: SOL price, 1 for USDC, a tracked pump coin's own price, a known listed quote, else null. */
  quoteUsdOf(mint) {
    if (mint == null || mint === SOL_MINT) return this.solUsd;
    if (mint === USDC_MINT) return 1;
    if (this.coins.has(mint)) return this.priceOf(mint)?.priceUsd ?? null;
    return this.quoteUsd.get(mint) ?? null;
  }
  /**
   * Prices of one coin from its own quote chain (≤ depth + 1 coins), without recomputing the whole
   * forest: the live trade path calls this right after it changed the coin, when `computed()` would
   * start a full pass for every trade. Same math as `computed()`.
   */
  priceOf(mint) {
    const c = this.coins.get(mint);
    if (!c) return null;
    const chain = [c, ...this.ancestors(mint)];
    const root = chain[chain.length - 1];
    const quoteOf = (x) => priceQuoteOf(x, this.decimalsOf(x.mint), this.quoteDecimals(x));
    const priceQuote = quoteOf(c);
    if (root.depth !== 0) return { priceQuote, priceSol: null, priceUsd: null };
    const kind = this.rootQuoteKind(root);
    return { priceQuote, ...chainPrices(chain.map(quoteOf), kind, this.solUsd, kind === "other" ? this.#rootOtherUsd(root) : null) };
  }
  setGlobal(g) { this.global = g; this.db.kvSet("global", g); this.#bump(); }
  setBackfill(b) { this.backfill = { ...this.backfill, ...b }; }
  /** Stores a trade; only a row sqlite did not have yet is counted (a replayed event never counts twice). */
  recordTrade(t) { if (this.db.insertTrade(t)) this.activity.record(t); this.#bump(); }
  touch(mint) { this.touched.set(mint, Date.now()); }

  // ---------------------------------------------------------------- "ours" (DESIGN §11.1)
  /** Proven ours: the on-chain fee-sharing config pays the platform wallet at least its configured share. */
  isOurs(c) { return !!c?.shares?.some((s) => s.address === this.platformWallet && s.bps >= this.platformMinBps); }
  /** The launch fee a verified spawn paid (lamports as a string), from the coin or its pending record. */
  feePaidOf(c) { return c?.feePaid ?? this.pending.get(c?.mint)?.feePaid ?? null; }
  oursOf(c) {
    const ours = this.isOurs(c);
    const p = !ours && this.pending.get(c?.mint);
    return { ours, oursPending: !!p && this.now() - p.at < PENDING_TTL_MS };
  }
  /** Ours or still pending: what the feed, the roots and the counts are built from in ours mode. */
  isOurCoin(c) { const o = this.oursOf(c); return o.ours || o.oursPending; }
  /** `at` (ms) anchors the pending window to the launch transaction's block time, so re-posting an old signature cannot restart it. */
  markPending(mint, sig, { feePaid = null, at = null } = {}) {
    this.pending.delete(mint);
    while (this.pending.size >= PENDING_MAX) this.pending.delete(this.pending.keys().next().value); // insertion order: the oldest goes
    this.pending.set(mint, { at: Math.min(at ?? this.now(), this.now()), sig: sig ?? null, feePaid: feePaid != null ? String(feePaid) : null });
    this.#stamp(mint); // the node's `oursPending` flag changed
    this.#persistPending(); this.#bump();
  }
  /** Drops pending entries that expired or that the sharing config confirmed; bumps only when something changed. */
  sweepPending() {
    let changed = false;
    for (const [mint, p] of this.pending) {
      if (this.now() - p.at >= PENDING_TTL_MS || this.isOurs(this.coins.get(mint))) { this.pending.delete(mint); this.#stamp(mint); changed = true; }
    }
    if (changed) { this.#persistPending(); this.#bump(); }
    return changed;
  }
  pendingMints() { this.sweepPending(); return [...this.pending.keys()]; }
  /**
   * scope().ours.size without building the scope (a 155k-entry set, ~100 ms on the local index, and every trade
   * moves the version it is cached by): `/api/health` reports it and is polled every few seconds. The same
   * count, cached per version; free when the scope is current.
   */
  ourCount() {
    this.sweepPending();
    if (this.scopeVersion === this.version && this.scopeCache) return this.scopeCache.ours.size;
    if (this.ourCountCache?.version === this.version) return this.ourCountCache.n;
    let n = 0;
    for (const c of this.coins.values()) if (c.tracked && this.isOurCoin(c)) n++;
    this.ourCountCache = { version: this.version, n };
    return n;
  }
  ourCountCache = null;
  #persistPending() { this.db.kvSet("oursPending", Object.fromEntries(this.pending)); }

  /**
   * The visible set and its own counts, recomputed per version. `ours` = tracked coins that are ours
   * or pending; `inScope` = those plus every ancestor (served as context); `derived` = per in-scope
   * mint: children shown, our descendants, locked value over our direct children, and how many
   * direct children on pump.fun the scope leaves out (`otherChildren`). In "all" mode the scope is
   * the whole tree and the global numbers apply.
   */
  scope() {
    this.sweepPending();
    if (this.scopeVersion === this.version) return this.scopeCache;
    const v = this.version, sc = drain(this.#scopeGen());
    this.scopeCache = sc; this.scopeVersion = v;
    return sc;
  }
  /** scope()'s pass as a generator (it yields every 2k coins: ~100 ms on the local index), for the sliced map jobs; the caller swept and caches. */
  *#scopeGen() {
    const ours = new Set(); const inScope = new Set(); const derived = new Map();
    const d = this.computed();
    let n = 0;
    for (const c of this.coins.values()) { if ((++n & 2047) === 0) yield; if (c.tracked && this.isOurCoin(c)) ours.add(c.mint); }
    if (this.mode === "all") {
      for (const c of this.coins.values()) { if ((++n & 2047) === 0) yield; if (c.tracked) inScope.add(c.mint); }
    } else {
      for (const m of ours) { inScope.add(m); for (const a of this.ancestors(m)) inScope.add(a.mint); }
      const memo = new Map();
      const desc = (mint) => {
        if (memo.has(mint)) return memo.get(mint);
        memo.set(mint, 0); // cycle guard; depth strictly grows on chain
        let n = 0;
        for (const m of this.children.get(mint) ?? []) if (inScope.has(m)) n += (ours.has(m) ? 1 : 0) + desc(m);
        memo.set(mint, n); return n;
      };
      for (const mint of inScope) {
        let shown = 0, locked = 0n;
        for (const m of this.children.get(mint) ?? []) {
          if (!inScope.has(m)) continue;
          shown++;
          const ch = this.coins.get(m);
          if (ours.has(m) && ch) locked += BigInt((ch.migrated ? ch.poolQuote : ch.realQuoteReserves) ?? 0);
        }
        const e = d.get(mint);
        const lockedUsd = e?.priceUsd != null ? units(locked, this.decimalsOf(mint)) * e.priceUsd : null;
        derived.set(mint, { children: shown, descendants: desc(mint), lockedQuote: locked, lockedUsd, otherChildren: (e?.children ?? 0) - shown });
      }
    }
    return { ours, inScope, derived };
  }
  /** scoped(c) from a map job's computed row `e` and scope `sc` (scoped reads both live, and the scope is rebuilt per version). */
  #scopedIn(c, e, sc) {
    const d = e ?? {};
    if (this.mode === "all") return { children: d.children ?? 0, descendants: d.descendants ?? 0, lockedQuote: d.lockedQuote ?? 0n, lockedUsd: d.lockedUsd ?? null, otherChildren: 0 };
    return sc.derived.get(c.mint) ?? { children: 0, descendants: 0, lockedQuote: 0n, lockedUsd: d.priceUsd != null ? 0 : null, otherChildren: d.children ?? 0 };
  }
  /** Scoped counts for a coin, or the "nothing of ours below it" row for a foreign coin viewed directly. */
  scoped(c) {
    const d = this.computed().get(c.mint) ?? {};
    if (this.mode === "all") return { children: d.children ?? 0, descendants: d.descendants ?? 0, lockedQuote: d.lockedQuote ?? 0n, lockedUsd: d.lockedUsd ?? null, otherChildren: 0 };
    return this.scope().derived.get(c.mint) ?? { children: 0, descendants: 0, lockedQuote: 0n, lockedUsd: d.priceUsd != null ? 0 : null, otherChildren: d.children ?? 0 };
  }
  /** Whole-ecosystem counts for a coin regardless of the mode: what the map draws when it shows every pump.fun pair. */
  scopedAll(c) {
    const d = this.computed().get(c.mint) ?? {};
    return { children: d.children ?? 0, descendants: d.descendants ?? 0, lockedQuote: d.lockedQuote ?? 0n, lockedUsd: d.lockedUsd ?? null, otherChildren: 0 };
  }
  /**
   * Listed quote assets (PUMP, USDC, WBTC, tokenized stocks, graduated coins such as $baton) that
   * tracked depth-0 coins are quoted in. pump.fun counts a coin quoted in a listed asset as a root
   * (depth 0), so without this the full map has no node above those coins: the asset becomes the
   * top of its family, and every coin quoted in it is drawn under it, with or without children.
   */
  assetFamilies() {
    if (this.assetVersion === this.version && this.assetCache) return this.assetCache;
    const fam = drain(this.#assetFamiliesGen());
    this.assetCache = fam; this.assetVersion = this.version;
    return fam;
  }
  /** assetFamilies' pass as a generator (it yields every 2k coins): the sliced map jobs run it, the method drains it. */
  *#assetFamiliesGen() {
    const fam = new Map();
    let n = 0;
    for (const c of this.coins.values()) {
      if ((++n & 2047) === 0) yield;
      if (!c.tracked || c.depth !== 0 || !c.quoteMint || c.quoteMint === SOL_MINT) continue;
      let list = fam.get(c.quoteMint);
      if (!list) { list = []; fam.set(c.quoteMint, list); }
      list.push(c);
    }
    return fam;
  }
  /**
   * The slice of each listed asset's family the full map draws (ASSET_FAMILY_DRAW): every coin that has
   * children or is younger than a day, then the biggest by locked value, then by price. Tens of thousands
   * of coins sit under PUMP or USDC alone and nearly all of them never traded; the family's bubble still
   * counts them all (assetMapRef), the index and the search still know them.
   */
  assetDrawn() {
    if (this.drawnVersion === this.version && this.drawnCache) return this.drawnCache;
    const d = this.computed();
    const out = drain(this.#assetDrawnGen(d, this.assetFamilies()));
    this.drawnCache = out; this.drawnVersion = this.version;
    return out;
  }
  /**
   * assetDrawn's pass as a generator over `fam` with the computed table `d`. The rest of a family is ordered by
   * keys read once per coin (locked value, then price, both descending, -1 when unknown): the same comparisons as
   * reading them from `d` in the comparator, so the same order, without two Map lookups per comparison (USDC's
   * 21k coins took ~100 ms that way).
   */
  *#assetDrawnGen(d, fam) {
    const out = new Map(), cap = this.assetFamilyDraw, dayAgo = Math.floor(this.now() / 1000) - 86_400;
    let n = 0;
    for (const [asset, kids] of fam) {
      const keep = new Set(), rest = [];
      for (const k of kids) {
        if ((++n & 2047) === 0) yield;
        if ((d.get(k.mint)?.children ?? 0) > 0 || (k.createdAt ?? 0) > dayAgo) keep.add(k.mint); else rest.push(k);
      }
      if (keep.size < cap && rest.length) {
        const lk = new Float64Array(rest.length), pk = new Float64Array(rest.length), order = new Array(rest.length);
        for (let i = 0; i < rest.length; i++) { const e = d.get(rest[i].mint); lk[i] = e?.lockedUsd ?? -1; pk[i] = e?.priceUsd ?? -1; order[i] = i; }
        yield;
        order.sort((a, b) => lk[b] - lk[a] || pk[b] - pk[a]);
        for (const i of order) { if (keep.size >= cap) break; keep.add(rest[i].mint); }
      }
      out.set(asset, keep);
    }
    return out;
  }
  // Logos of listed quote assets whose mint metadata has no image (USDC, WBTC, WETH, …): mint → the
  // token's listed https icon (lib/asset-icons.mjs). The mint's own metadata image always wins
  // (assetMapRef); every stored icon is registered with the image proxy (knownImage).
  assetIcons = new Map();
  /** Stores asset icons ({ mint: https URL } or a Map), persisted in kv "assetIcons". Returns how many changed. */
  setAssetIcons(icons) {
    let n = 0;
    for (const [mint, url] of icons instanceof Map ? icons : Object.entries(icons ?? {})) {
      if (typeof mint !== "string" || typeof url !== "string" || !url.startsWith("https://") || this.assetIcons.get(mint) === url) continue;
      this.assetIcons.set(mint, url); this.imageUrls.add(url); n++;
      this.#imageSeen(url);
      // The asset node rides the next `since=` delta with a member (mapSince adds the asset of a changed member).
      const member = this.assetFamilies().get(mint)?.[0];
      if (member) this.#stamp(member.mint);
    }
    if (n) { this.db.kvSet("assetIcons", Object.fromEntries(this.assetIcons)); this.#bump(); }
    return n;
  }
  /** The stored icon URL of a listed asset mint, or null. */
  assetIconOf(mint) { return this.assetIcons.get(mint) ?? null; }
  /** The bubble of a listed quote asset: its name and logo from the mint metadata, the value its family has locked in it. */
  assetMapRef(mint, fam = null, dt = null) { return drain(this.#assetMapRefGen(mint, fam, dt)); }
  /** assetMapRef as a generator (it yields every 2k family coins: USDC's 21k took up to ~30 ms), for the sliced map jobs. */
  *#assetMapRefGen(mint, fam = null, dt = null) {
    const kids = (fam ?? this.assetFamilies()).get(mint) ?? [];
    const d = dt ?? this.computed();
    const { name, symbol } = this.nameOf(mint);
    const dec = this.decimalsOf(mint), quoteUsd = this.quoteUsdOf(mint);
    let locked = 0n, descendants = 0, updatedAt = 0, n = 0;
    for (const k of kids) {
      if ((++n & 2047) === 0) yield;
      // what computed() memoizes per coin object (lockMemo): the same BigInt, made once per coin state
      let v = this.lockMemo.get(k);
      if (v === undefined) { v = BigInt((k.migrated ? k.poolQuote : k.realQuoteReserves) ?? 0); this.lockMemo.set(k, v); }
      locked += v;
      descendants += 1 + (d.get(k.mint)?.descendants ?? 0);
      updatedAt = Math.max(updatedAt, k.updatedAt ?? 0);
    }
    const supply = this.mints.get(mint)?.supply;
    return {
      mint, name, symbol, image: imageProxyUrl(this.metaFor({ mint })?.image ?? this.assetIcons.get(mint)), depth: 0, ours: false, oursPending: false, asset: true,
      mcapUsd: this.quoteMcapOf(mint) ?? (quoteUsd != null && supply != null ? quoteUsd * units(supply, dec) : null),
      lockedUsd: quoteUsd != null ? units(locked, dec) * quoteUsd : null,
      children: kids.length, descendants, otherChildren: 0, migrated: false, createdAt: null, updatedAt,
    };
  }
  /**
   * Raw logo URLs the map wants as thumbnails from far (ImageCache.warm), most wanted first: every family top (a root
   * with a child, a listed asset top, with its stored icon when its metadata has no image), the direct children of the
   * bigFamilies largest families, then the coins every other listed-asset family draws (assetDrawn: they are on the map
   * like any root's children, so they no longer wait behind every tracked coin), and with `all` every other tracked
   * coin's logo after them (the map draws a child's logo from 4.5 px, so a zoom into ANY family asks for its children;
   * a cold family cost 2-5 s of sheet re-asks before this). A listed asset's family competes for "largest" by its coin
   * count and its drawn coins stand for its children.
   */
  warmImageUrls(bigFamilies = 60, all = false) {
    const out = new Set();
    const add = (mint) => { const u = this.imageOfMint(mint); if (u) out.add(u); };
    const roots = this.allRoots(), d = this.computed(), fams = this.assetFamilies(), drawn = this.assetDrawn();
    for (const r of roots) add(r.mint);
    for (const mint of fams.keys()) add(mint);
    // the drawn coins of a listed asset's family, biggest first (mapAll's order): its children on the map
    const drawnKids = (asset) => [...(drawn.get(asset) ?? [])].sort((a, b) => sortKey(d.get(b)?.lockedUsd) - sortKey(d.get(a)?.lockedUsd) || sortKey(d.get(b)?.priceUsd) - sortKey(d.get(a)?.priceUsd));
    const families = [
      ...roots.map((r) => ({ size: d.get(r.mint)?.descendants ?? 0, kids: () => this.childrenOf(r.mint).map((k) => k.mint) })),
      ...[...fams].map(([asset, members]) => ({ size: members.length, kids: () => drawnKids(asset) })),
    ];
    families.sort((a, b) => b.size - a.size);
    for (const f of families.slice(0, bigFamilies)) for (const mint of f.kids()) add(mint);
    for (const asset of fams.keys()) for (const mint of drawnKids(asset)) add(mint);
    if (all) for (const c of this.tracked()) add(c.mint);
    return [...out];
  }
  /** Every depth-0 coin with at least one child on pump.fun, regardless of the mode. */
  allRoots() { const d = this.computed(); return this.tracked().filter((c) => c.depth === 0 && (d.get(c.mint)?.children ?? 0) > 0); }
  inScope(mint) { return this.scope().inScope.has(mint); }
  /** Direct children the API may show: every tracked child in "all" mode, in-scope ones in "ours" mode. */
  visibleChildren(mint) { const kids = this.childrenOf(mint); return this.mode === "all" ? kids : kids.filter((c) => this.scope().inScope.has(c.mint)); }
  /** Feed rows: every spawn (depth ≥ 1) in "all" mode; in "ours" mode every coin launched here, roots included. */
  visibleSpawns() { const sc = this.scope(); return this.tracked().filter((c) => (this.mode === "all" ? c.depth >= 1 : sc.ours.has(c.mint))); }
  /** Leaderboard rows: depth-0 coins with children, or in "ours" mode with at least one of our coins below them. */
  visibleRoots() {
    if (this.mode === "all") { const d = this.computed(); return this.tracked().filter((c) => c.depth === 0 && (d.get(c.mint)?.children ?? 0) > 0); }
    const sc = this.scope();
    return this.tracked().filter((c) => c.depth === 0 && sc.inScope.has(c.mint) && (sc.derived.get(c.mint)?.descendants ?? 0) > 0);
  }

  // ---------------------------------------------------------------- lookups
  get(mint) { return this.coins.get(mint) ?? null; }
  mint(mint) { return this.mints.get(mint) ?? null; }
  decimalsOf(mint) { if (mint == null || mint === SOL_MINT) return SOL_DECIMALS; return this.mints.get(mint)?.decimals ?? 6; }
  quoteDecimals(c) { return this.decimalsOf(c.quoteMint); }
  nameOf(mint) { const m = this.mints.get(mint); return { name: m?.name ?? null, symbol: m?.symbol ?? null }; }
  quoteSymbol(c) {
    if (c.quoteMint == null) return "SOL";
    if (c.quoteMint === USDC_MINT) return "USDC";
    return this.mints.get(c.quoteMint)?.symbol || shortMint(c.quoteMint);
  }
  /** "sol" | "usdc" | "other" for a depth-0 coin's own quote (what chain pricing roots in). */
  rootQuoteKind(root) { return root.quoteMint == null ? "sol" : root.quoteMint === USDC_MINT ? "usdc" : "other"; }
  /** Ancestors nearest first (parent, grandparent, …) as far as the model knows them; cycle-safe. */
  ancestors(mint) {
    const out = []; const seen = new Set([mint]);
    let c = this.coins.get(mint);
    while (c && c.quoteMint && !seen.has(c.quoteMint)) {
      const p = this.coins.get(c.quoteMint);
      if (!p) break;
      out.push(p); seen.add(p.mint); c = p;
    }
    return out;
  }
  childrenOf(mint) {
    const out = [], set = this.children.get(mint);
    if (set) for (const m of set) { const c = this.coins.get(m); if (c && c.tracked) out.push(c); }
    return out;
  }
  tracked() { return [...this.coins.values()].filter((c) => c.tracked); }
  metaFor(c) { const uri = this.mints.get(c.mint)?.uri; return uri ? this.meta.get(uri) ?? null : null; }

  // ---------------------------------------------------------------- derived numbers
  /** Prices, locked value and descendant counts for every coin, recomputed when the version moved. */
  computed() {
    if (this.derivedVersion === this.version) return this.derived;
    // Small index (tests, a fresh devnet) or the first pass after start: one synchronous pass.
    if (this.derivedVersion < 0 || this.coins.size < this.computeSliceMinCoins) {
      const gen = this.#computePass();
      while (!gen.next().done);
      return this.derived;
    }
    // Large index (about 345k coins on mainnet, 1-3 s per pass): refresh in the background in short slices
    // so the event loop keeps answering requests, and serve the last table meanwhile (numbers a few seconds old).
    this.#startSlicedPass();
    return this.derived;
  }
  #computeJob = null;
  #startSlicedPass() {
    if (this.#computeJob || Date.now() - this.derivedAt < COMPUTED_MIN_MS) return;
    // On the scheduler the map jobs share (sliced.mjs): one SLICE_MS budget per event-loop turn for all of them.
    this.#computeJob = runSliced(this.#computePass())
      .catch((e) => { this.log?.warn?.(`computed: ${e?.message ?? e}`); })
      .finally(() => { this.#computeJob = null; });
  }
  /** One full pass as a generator: it yields every few hundred coins so a caller can spread it over ticks. */
  *#computePass() {
    const t0 = Date.now(), version = this.version, structVersion = this.structVersion;
    const d = new Map();
    let n = 0;
    for (const c of this.coins.values()) {
      if ((++n & 511) === 0) yield;
      let m = this.pqMemo.get(c);
      if (!m || m.dv !== this.decVersion) {
        const bd = this.decimalsOf(c.mint), qd = this.quoteDecimals(c);
        if (!m || m.bd !== bd || m.qd !== qd) { m = { pq: priceQuoteOf(c, bd, qd), bd, qd, dv: 0 }; this.pqMemo.set(c, m); }
        m.dv = this.decVersion;
      }
      d.set(c.mint, { priceQuote: m.pq, priceSol: null, priceUsd: null, lockedQuote: 0n, lockedUsd: null, descendants: 0, children: 0 });
    }
    // Self first, then the ancestors as far as the model knows them (the walk `ancestors()` does,
    // cycle-safe), into two scratch arrays reused for every coin. A coin indexed while a sliced pass ran
    // has no row yet: its chain is skipped and priced by the next pass.
    const chain = [], steps = [];
    chains: for (const c of this.coins.values()) {
      if ((++n & 511) === 0) yield;
      chain.length = 0; chain.push(c);
      for (let x = c; x.quoteMint && !inChain(chain, x.quoteMint);) { const p = this.coins.get(x.quoteMint); if (!p) break; chain.push(p); x = p; }
      const root = chain[chain.length - 1];
      // A chain that does not reach a depth-0 coin cannot be priced in SOL or USD yet (ancestor missing).
      if (root.depth !== 0) continue;
      steps.length = chain.length;
      for (let k = 0; k < chain.length; k++) { const row = d.get(chain[k].mint); if (!row) continue chains; steps[k] = row.priceQuote; }
      const kind = this.rootQuoteKind(root);
      Object.assign(d.get(c.mint), chainPrices(steps, kind, this.solUsd, kind === "other" ? this.#rootOtherUsd(root) : null));
    }
    // Locked quote = Σ children (raw units of the parent's token: realQuoteReserves on the curve, the
    // pool's quote vault after migration). Descendants = recursive child count, children = direct.
    for (const [parent, set] of this.children) {
      if ((++n & 511) === 0) yield;
      const e = d.get(parent); if (!e) continue;
      let locked = 0n, k = 0;
      for (const m of set) {
        const ch = this.coins.get(m); if (!ch || !ch.tracked) continue;
        k++;
        let v = this.lockMemo.get(ch);
        if (v === undefined) { v = BigInt((ch.migrated ? ch.poolQuote : ch.realQuoteReserves) ?? 0); this.lockMemo.set(ch, v); }
        locked += v;
      }
      e.children = k; e.lockedQuote = locked;
      const parentCoin = this.coins.get(parent);
      e.lockedUsd = e.priceUsd != null && parentCoin ? units(locked, this.decimalsOf(parent)) * e.priceUsd : null;
    }
    if (this.descVersion !== structVersion) {
      const memo = new Map(); const visiting = new Set();
      const desc = (mint) => {
        if (memo.has(mint)) return memo.get(mint);
        if (visiting.has(mint)) return 0; // malformed data guard; depth strictly grows on chain
        visiting.add(mint);
        let c = 0;
        for (const m of this.children.get(mint) ?? []) { const ch = this.coins.get(m); if (ch && ch.tracked) c += 1 + desc(m); }
        visiting.delete(mint); memo.set(mint, c); return c;
      };
      for (const c of this.coins.values()) { if ((++n & 511) === 0) yield; desc(c.mint); }
      this.descCache = memo; this.descVersion = structVersion;
    }
    for (const [mint, e] of d) { if ((++n & 4095) === 0) yield; e.descendants = this.descCache.get(mint) ?? 0; } // one row per coin: 37-75 ms in one step at 155k
    this.derived = d; this.derivedVersion = version; this.derivedAt = Date.now(); this.derivedMs = this.derivedAt - t0;
  }
  /** 24 h volume/trade counts per mint (Map<mint, { trades, usd }>), live from the in-memory activity counters. */
  volumes() { return this.activity.volumes(); }
  /**
   * The map's heat sidecar (DESIGN §11.5): per-mint activity of every tracked coin with a trade in the
   * last 24 h, whatever the listing mode. Rebuilt at most once per `HEAT_CACHE_MS`; the entry carries
   * a `prepared` slot the HTTP layer fills with the encoded bytes, like `mapAll`.
   */
  heatEntry() {
    const hit = this.heatCache;
    if (hit && this.now() - hit.at < HEAT_CACHE_MS) return hit;
    const t0 = performance.now();
    const body = this.activity.heat({ keep: (mint) => !!this.coins.get(mint)?.tracked });
    this.heatCache = { at: this.now(), body, prepared: null, buildMs: Math.round(performance.now() - t0) };
    return this.heatCache;
  }

  // ---------------------------------------------------------------- API views (DESIGN §7)
  ref(c) { const { name, symbol } = this.nameOf(c.mint); return { mint: c.mint, name, symbol, image: imageProxyUrl(this.metaFor(c)?.image), depth: c.depth, ...this.oursOf(c) }; }
  /** CoinRef plus the few numbers a bubble needs. Skips the ancestor walk and the volume join that
   *  make `view()` cost more, because the map asks for hundreds of coins per request. */
  mapRef(c, all = false, dt = null, sc = null) {
    // `dt`, `sc`: the computed() table and the scope a map job took once (the build calls this ~90k times, and the
    // scope is rebuilt per version); with `all`, scopedAll's numbers come from the same row, without a second
    // computed() call and an object per call.
    const tab = dt ?? this.computed();
    const e = tab.get(c.mint), d = e ?? {};
    const s = all ? null : (sc || this.mode === "all") ? this.#scopedIn(c, e, sc) : this.scoped(c); // mode "all" reads no scope
    const supply = units(c.tokenTotalSupply, this.decimalsOf(c.mint));
    const mcapUsd = d.priceUsd != null ? d.priceUsd * supply : null;
    const cap = this.mcapCapOf(c, mcapUsd, tab);
    return {
      ...this.ref(c), mcapUsd, ...capField(cap),
      lockedUsd: s ? s.lockedUsd : d.lockedUsd ?? null, children: s ? s.children : d.children ?? 0, descendants: s ? s.descendants : d.descendants ?? 0, otherChildren: s ? s.otherChildren : 0,
      migrated: c.migrated, createdAt: c.createdAt,
    };
  }

  // ---------------------------------------------------------------- the whole-forest map (DESIGN §11.5)
  /** Deepest level the full map descends to: the program's current depth cap (every descendant), never less than 2. */
  mapDepth() { return Math.max(2, this.global?.maxCurveDepth ?? 2); }
  /** Roots the map draws: every depth-0 coin with a child (`all`), or the roots of the listing scope. */
  mapRoots(all) {
    if (!all) return this.visibleRoots();
    const fam = this.assetFamilies();
    const solRoots = this.allRoots().filter((c) => !fam.has(c.quoteMint ?? ""));
    return [...solRoots, ...[...fam.keys()].map((mint) => ({ mint, asset: true, depth: -1 }))];
  }
  /** A family's children on the map: all of them, except a listed asset's family, which is capped (assetDrawn). */
  mapChildren(mint, all) {
    if (!all) return this.visibleChildren(mint);
    return this.#kidsIn(mint, all, this.assetDrawn(), null);
  }
  /** mapChildren from what a map job took: `drawn` (assetDrawn's map) with `all`; without, visibleChildren on the job's scope `sc`. */
  #kidsIn(mint, all, drawn, sc) {
    const kids = this.childrenOf(mint);
    if (!all) return this.mode === "all" ? kids : kids.filter((c) => sc.inScope.has(c.mint));
    const dr = drawn.get(mint);
    return dr ? kids.filter((k) => dr.has(k.mint)) : kids;
  }
  /**
   * The cache and job key of the scope a body is built in: `all` (scope=all, the map's) or the listing mode's. In
   * mode "all" the two differ (no asset tops, no drawn cap without scope=all), so they never share an entry.
   */
  #scopeKey(all) { return all ? "all" : `scoped-${this.mode}`; }
  /**
   * What every map job reads first, once: the computed() table; with `all` the listed-asset families and their drawn
   * sets; without it in mode "ours" the listing scope (`sc`, whose first step sweeps the pending spawns that ran out:
   * read live, the scope would be rebuilt in every slice while trades move the version); then the roots (mapRoots'
   * list and order). Without `all` in mode "all" the scope holds every tracked coin, so nothing needs it. The
   * per-version caches are used when current and refilled when nothing moved while this ran (always, in one go).
   */
  *#mapCtxGen(all) {
    const scoped = !all && this.mode !== "all";
    if (scoped) this.sweepPending();
    const v0 = this.version, d = this.computed();
    let fam = null, drawn = null, sc = null;
    if (all) {
      fam = this.assetVersion === v0 && this.assetCache ? this.assetCache : yield* this.#assetFamiliesGen();
      drawn = this.drawnVersion === v0 && this.drawnCache ? this.drawnCache : yield* this.#assetDrawnGen(d, fam);
      if (this.version === v0) { this.assetCache = fam; this.assetVersion = v0; this.drawnCache = drawn; this.drawnVersion = v0; }
    } else if (scoped) {
      sc = this.scopeVersion === v0 && this.scopeCache ? this.scopeCache : yield* this.#scopeGen();
      if (this.version === v0) { this.scopeCache = sc; this.scopeVersion = v0; }
    }
    const roots = yield* this.#rootsGen(all, fam, d, sc);
    return { version: v0, d, fam, drawn, sc, roots };
  }
  /**
   * mapRoots(all) from a job's context: with `all` the depth-0 coins with a child (allRoots' order) not drawn under
   * an asset, then the asset tops; without, visibleRoots() (its order) on the job's table and scope.
   */
  *#rootsGen(all, fam, d, sc) {
    const out = [], byKids = all || this.mode === "all";
    let n = 0;
    for (const c of this.coins.values()) {
      if ((++n & 2047) === 0) yield;
      if (!c.tracked || c.depth !== 0) continue;
      if (byKids ? (d.get(c.mint)?.children ?? 0) > 0 && !(all && fam.has(c.quoteMint ?? "")) : sc.inScope.has(c.mint) && (sc.derived.get(c.mint)?.descendants ?? 0) > 0) out.push(c);
    }
    if (all) for (const mint of fam.keys()) out.push({ mint, asset: true, depth: -1 });
    return out;
  }
  /**
   * A node's children in map order: locked value (scopedAll's, or scoped's without `all`), then price, both
   * descending and -1 when unknown, ties in mapChildren's order. The keys are read once per child: the same
   * comparisons the old comparator made with two lookups per side, so the same order.
   */
  #sortKids(kids, all, d, sc) {
    const n = kids.length;
    if (n < 2) return kids;
    const lk = new Float64Array(n), pk = new Float64Array(n), order = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = kids[i], e = d.get(c.mint);
      lk[i] = (all ? e?.lockedUsd ?? null : this.#scopedIn(c, e, sc).lockedUsd) ?? -1;
      pk[i] = e?.priceUsd ?? -1;
      order[i] = i;
    }
    order.sort((a, b) => lk[b] - lk[a] || pk[b] - pk[a]);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = kids[order[i]];
    return out;
  }
  /**
   * Every root and every descendant as `{ coin: mapRef, children }` nodes, no fan-out cap. Built
   * from `mapRef` only (no `view()`: no ancestor walk, no volume join), cached per model version
   * and at most once per `MAP_CACHE_MS` so a burst of opens shares one build. The cache entry
   * carries `body`, `total`, `indexed` and the slots the HTTP layer fills with the encoded bytes.
   * Roots and children are ordered by locked value, biggest first. This builds at once (tests, the
   * card); the HTTP routes await mapAllAsync, the same build in slices.
   */
  mapAll({ all = true, depth = this.mapDepth() } = {}) {
    const key = `${this.#scopeKey(all)}:${depth}`;
    const hit = this.#mapHit(key);
    if (hit) return hit;
    const t0 = performance.now();
    const entry = drain(this.#mapBuildGen({ all, depth, key, shared: false }));
    return this.#installMap(entry, performance.now() - t0, null);
  }
  /**
   * mapAll on the sliced scheduler (sliced.mjs): the whole-forest build took ~1.5 s of one block on the local index
   * (155k coins, 92k nodes). Resolves with the same entry, under mapAll's cache rule. Callers of one key share one
   * build; builds of different keys (scope, depth) run one after another, as the synchronous ones did: each holds
   * its tree and then its encoded bytes, so side by side they multiplied the peak memory.
   */
  mapAllAsync({ all = true, depth = this.mapDepth() } = {}) {
    const key = `${this.#scopeKey(all)}:${depth}`;
    const hit = this.#mapHit(key);
    if (hit) return Promise.resolve(hit);
    let job = this.#mapJobs.get(key);
    if (!job) {
      const build = () => this.#mapHit(key) ?? runSliced(this.#mapBuildGen({ all, depth, key, shared: true })).then((run) => this.#installMap(run.value, run.cpuMs, run));
      job = this.#buildQueue.then(build).finally(() => this.#mapJobs.delete(key));
      this.#buildQueue = job.then(() => {}, () => {});
      this.#mapJobs.set(key, job);
    }
    return job;
  }
  #mapJobs = new Map(); // key → its build, queued or running
  #buildQueue = Promise.resolve(); // the build queued last: the next one starts when it ends
  #sinceJobs = new Map(); // since key → the sliced delta in flight
  /**
   * `ctx:` / `counts:` + scope key + model version → { done, value, error }: a job's context (#mapCtxGen) or whole-tree
   * counts (#countsGen) that the other jobs started at the same version wait for instead of making their own (a
   * burst of since= requests at one version made one walk with the synchronous code, through the per-version caches).
   */
  #shared = new Map();
  *#sharedGen(key, make) {
    const cur = this.#shared.get(key);
    if (cur) {
      while (!cur.done) yield;
      if (cur.error) throw cur.error;
      return cur.value;
    }
    const s = { done: false, value: undefined, error: null };
    this.#shared.set(key, s);
    try { s.value = yield* make(); return s.value; } catch (e) { s.error = e; throw e; } finally { s.done = true; if (this.#shared.get(key) === s) this.#shared.delete(key); }
  }
  /** #mapCtxGen shared by the jobs started at one version (only jobs on the scheduler: a drained job cannot wait). */
  *#ctxShared(all) {
    if (!all && this.mode !== "all") this.sweepPending(); // the version the key names is the swept one
    return yield* this.#sharedGen(`ctx:${this.#scopeKey(all)}:${this.version}`, () => this.#mapCtxGen(all));
  }
  /** #countsGen shared the same way. */
  *#countsShared(all, ctx) {
    return yield* this.#sharedGen(`counts:${this.#scopeKey(all)}:${ctx.version}`, () => this.#countsGen(all, ctx));
  }
  #mapHit(key) {
    const hit = this.mapCache;
    return hit && hit.key === key && (hit.version === this.version || this.now() - hit.at < MAP_CACHE_MS) ? hit : null;
  }
  /** The build, as a generator (yields every 32 nodes): returns the entry, not yet cached (#installMap). */
  *#mapBuildGen({ all, depth, key, shared }) {
    const generatedAt = this.now();
    // Before anything is read: a change made while a sliced build runs is stamped after generatedAt, so the
    // client's next since=<generatedAt> carries it (stamps never fall behind lastGeneratedAt, see #stamp).
    this.lastGeneratedAt = Math.max(this.lastGeneratedAt, generatedAt);
    // Without `all` in mode "ours" the build reads the listing scope, whose first step sweeps the pending spawns that
    // ran out (a version bump). Sweep before the version is read, as the synchronous build did (in visibleRoots, before
    // it read the version at its end), so the body's version and ETag are the swept state's.
    if (!all && this.mode !== "all") this.sweepPending();
    const version = this.version;
    const ctx = shared ? yield* this.#ctxShared(all) : yield* this.#mapCtxGen(all);
    const { d, fam, drawn, sc } = ctx, self = this;
    let total = 0, n = 0;
    const seen = new Set(), nested = new Set(); // for `indexed` (#indexedIn)
    const assetRefs = new Map(); // an asset top's bubble is read for the root order and drawn once: one pass over its family
    function* assetRef(mint) { let r = assetRefs.get(mint); if (!r) { r = yield* self.#assetMapRefGen(mint, fam, d); assetRefs.set(mint, r); } return r; }
    function* node(c, left, root) {
      total++; seen.add(c.mint); if (!root && fam?.has(c.mint)) nested.add(c.mint);
      const coin = c.asset ? yield* assetRef(c.mint) : self.mapRef(c, all, d, sc);
      const children = [];
      if (left > 0) for (const k of self.#sortKids(self.#kidsIn(c.mint, all, drawn, sc), all, d, sc)) children.push(yield* node(k, left - 1, false));
      if ((++n & 31) === 0) yield;
      return { coin, children };
    }
    const list = ctx.roots, locked = new Float64Array(list.length), order = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      locked[i] = (r.asset ? (yield* assetRef(r.mint)).lockedUsd : all ? d.get(r.mint)?.lockedUsd ?? null : this.#scopedIn(r, d.get(r.mint), sc).lockedUsd) ?? -1;
      order[i] = i;
      // an asset top's bubble sums its whole family (USDC: 21k coins): one per step, the asset tops come last
      if (r.asset || (i & 63) === 63) yield;
    }
    order.sort((a, b) => locked[b] - locked[a]);
    yield;
    const roots = [];
    for (const i of order) { const r = list[i]; roots.push(yield* node(r, r.asset ? depth + 1 : depth, true)); }
    const body = { roots, scope: all ? "all" : this.mode, version, generatedAt, total };
    return { key, all, version, at: generatedAt, body, total, prepared: null, buildMs: 0, indexed: this.#indexedIn(seen.size, nested, all, ctx), depth };
  }
  /** Caches a finished build (a slower one never replaces a newer one of the same key) and counts it in mapStats. */
  #installMap(entry, ms, run) {
    entry.buildMs = Math.round(ms);
    const cur = this.mapCache;
    if (!cur || cur.key !== entry.key || cur.at <= entry.at) {
      this.mapCache = entry;
      // the counts of the default-depth tree only: a shallower build's node count is not the map's (since= reports it)
      if (this.version === entry.version && entry.depth === this.mapDepth()) {
        this.totalCache = { all: entry.all, version: entry.version, total: entry.total };
        this.indexedCache = { all: entry.all, version: entry.version, n: entry.indexed };
      }
    }
    const st = this.mapStats;
    st.builds++; st.lastBuildMs = entry.buildMs; st.maxBuildMs = Math.max(st.maxBuildMs, entry.buildMs);
    if (run) { st.lastSlices = run.slices; st.maxSliceMs = Math.max(st.maxSliceMs ?? 0, Math.round(run.maxSliceMs)); }
    return entry;
  }
  /** Number of nodes the full map holds right now (a cheap walk when no build is cached for this version). */
  mapTotal(all = true) {
    if (this.totalCache?.version === this.version && this.totalCache.all === all) return this.totalCache.total;
    return drain(this.#countsGen(all, drain(this.#mapCtxGen(all)))).total;
  }
  /**
   * mapTotal and mapIndexed in one walk of the default-depth tree from a job's context, as a generator; the
   * per-version caches answer when current and are refilled when nothing moved since the context was taken.
   */
  *#countsGen(all, ctx) {
    const tc = this.totalCache, ic = this.indexedCache;
    const totalHit = tc?.version === this.version && tc.all === all, indexedHit = ic?.version === this.version && ic.all === all;
    if (totalHit && indexedHit) return { total: tc.total, indexed: ic.n };
    const depth = this.mapDepth(), fam = ctx.fam, self = this;
    let total = 0, n = 0;
    const seen = new Set(), nested = new Set();
    function* walk(c, left, root) {
      total++; seen.add(c.mint); if (!root && fam?.has(c.mint)) nested.add(c.mint);
      if ((++n & 255) === 0) yield;
      if (left > 0) for (const k of self.#kidsIn(c.mint, all, ctx.drawn, ctx.sc)) yield* walk(k, left - 1, false);
    }
    for (const r of ctx.roots) yield* walk(r, r.asset ? depth + 1 : depth, true);
    const indexed = this.#indexedIn(seen.size, nested, all, ctx);
    if (this.version === ctx.version) {
      if (!totalHit) this.totalCache = { all, version: ctx.version, total };
      if (!indexedHit) this.indexedCache = { all, version: ctx.version, n: indexed };
    }
    return { total: totalHit ? tc.total : total, indexed: indexedHit ? ic.n : indexed };
  }
  /**
   * Is this coin drawn by the full map: a root with children, or a child whose parent chain reaches a tracked root?
   * Without `all` the listing scope applies: the job's snapshot in mode "ours"; in mode "all" it is every tracked coin.
   */
  #onMapIn(c, all, ctx) {
    if (!c.tracked) return false;
    const scoped = !all && this.mode !== "all";
    if (scoped && !ctx.sc.inScope.has(c.mint)) return false;
    if (c.depth === 0) return (all && !!c.quoteMint && c.quoteMint !== SOL_MINT && (ctx.drawn.get(c.quoteMint)?.has(c.mint) ?? false)) || this.#kidsIn(c.mint, all, ctx.drawn, ctx.sc).length > 0;
    if (c.depth > this.mapDepth()) return false;
    const anc = this.ancestors(c.mint);
    return anc.length > 0 && anc[anc.length - 1].depth === 0 && anc.every((a) => a.tracked && (!scoped || ctx.sc.inScope.has(a.mint)));
  }
  /**
   * Delta sync: the nodes whose `updatedAt` (ms) is after `since`, flat, each with its `parentMint`
   * (null for a root). `removed` is reserved (coins are never deleted from the tree). `total` says
   * how many nodes the full map holds, so a client can tell a stale cache from a complete one.
   * This builds at once; the HTTP routes await mapSinceAsync, the same delta in slices.
   */
  mapSince({ all = true, since = 0 } = {}) {
    const key = `${this.#scopeKey(all)}:${since}`;
    const hit = this.#sinceHit(key);
    if (hit) return hit;
    return this.#installSince(drain(this.#mapSinceGen({ all, since, key, shared: false })));
  }
  /**
   * mapSince on the sliced scheduler: its whole-tree counts (total, indexed) took ~0.6 s of one block on the local
   * index. Callers of one key share the job; jobs started at one model version share the context and the counts.
   * Deltas of different cursors run side by side, not queued like full builds: deliberately (review, Nov 11 2026), as a
   * queue would lose that sharing and make a simultaneous burst slower, and bursts are rare on a one-user site.
   */
  mapSinceAsync({ all = true, since = 0 } = {}) {
    const key = `${this.#scopeKey(all)}:${since}`;
    const hit = this.#sinceHit(key);
    if (hit) return Promise.resolve(hit);
    let job = this.#sinceJobs.get(key);
    if (!job) {
      job = runSliced(this.#mapSinceGen({ all, since, key, shared: true })).then((run) => this.#installSince(run.value)).finally(() => this.#sinceJobs.delete(key));
      this.#sinceJobs.set(key, job);
    }
    return job;
  }
  #sinceHit(key) {
    const hit = this.mapSinceCache.get(key);
    return hit && (hit.version === this.version || this.now() - hit.at < MAP_CACHE_MS) ? hit : null;
  }
  /** Caches a delta: at most MAP_SINCE_ENTRIES of them and mapSinceNodes nodes in all, the oldest out first (the one installed stays). */
  #installSince(entry) {
    this.mapSinceCache.set(entry.key, entry);
    let nodes = 0;
    for (const e of this.mapSinceCache.values()) nodes += e.body.nodes.length;
    for (const [k, e] of this.mapSinceCache) {
      if (this.mapSinceCache.size <= MAP_SINCE_ENTRIES && nodes <= this.mapSinceNodes) break;
      if (e === entry) continue;
      this.mapSinceCache.delete(k); nodes -= e.body.nodes.length;
    }
    return entry;
  }
  *#mapSinceGen({ all, since, key, shared }) {
    const generatedAt = this.now();
    this.lastGeneratedAt = Math.max(this.lastGeneratedAt, generatedAt); // before anything is read, as in #mapBuildGen
    const ctx = shared ? yield* this.#ctxShared(all) : yield* this.#mapCtxGen(all);
    const fam = all ? ctx.fam : new Map();
    // The version the job's reads start from (ctx: after the listing scope's sweep in mode "ours"); the delta's own sweep
    // below moves it. Anything else that moves the version while the job runs can be missing from the body, so the
    // entry is then matched only through MAP_CACHE_MS, not by version (#sinceHit), however long the model stays quiet.
    let v = ctx.version;
    // Without `all` in mode "all" the synchronous delta swept the pending spawns that ran out when it met the first
    // tracked coin changed after `since` (its scope() call), then read the version: the same here.
    let sweep = !all && this.mode === "all";
    const nodes = [], assets = new Set();
    let n = 0;
    for (const c of this.coins.values()) {
      if ((++n & 1023) === 0) yield;
      if (!((c.updatedAt ?? 0) > since)) continue;
      if (sweep && c.tracked) { sweep = false; const before = this.version; this.sweepPending(); if (before === v) v = this.version; }
      if (!this.#onMapIn(c, all, ctx)) continue;
      const underAsset = c.depth === 0 && fam.has(c.quoteMint ?? "");
      if (underAsset) assets.add(c.quoteMint);
      nodes.push({ ...this.mapRef(c, all, ctx.d, ctx.sc), parentMint: c.depth > 0 || underAsset ? c.quoteMint : null });
      if ((nodes.length & 63) === 0) yield; // an old cursor draws nearly every coin it scans
    }
    for (const mint of assets) { nodes.push({ ...(yield* this.#assetMapRefGen(mint, ctx.fam, ctx.d)), parentMint: null }); yield; }
    yield;
    nodes.sort((a, b) => (b.lockedUsd ?? -1) - (a.lockedUsd ?? -1));
    const counts = shared ? yield* this.#countsShared(all, ctx) : yield* this.#countsGen(all, ctx);
    const version = this.version; // the body's, read last as the synchronous delta did: after any sweep above
    const body = { nodes, removed: [], generatedAt, total: counts.total, version };
    return { key, version: this.version === v ? version : -1, at: generatedAt, body, prepared: null, indexed: counts.indexed };
  }

  /**
   * Coins of listed-asset families the full map leaves undrawn (Σ assetFamilies − assetDrawn; 0 without
   * `all`, which draws no asset family). Cached per version.
   */
  mapUndrawn(all = true) {
    if (!all) return 0;
    if (this.undrawnCache?.version === this.version) return this.undrawnCache.n;
    const drawn = this.assetDrawn();
    let n = 0;
    for (const [asset, kids] of this.assetFamilies()) n += Math.max(0, kids.length - (drawn.get(asset)?.size ?? 0));
    this.undrawnCache = { version: this.version, n };
    return n;
  }
  undrawnCache = null;
  /**
   * `indexed` of the /api map bodies (DESIGN-FAMILY-ALL §4.5): every coin the full map stands for, each once.
   * The drawn tree can hold a coin twice: a listed asset quoted in another listed asset ($baton in PUMP) is a
   * drawn child of that asset and the top of its own family, with the same drawn subtree under both. A client
   * keeps one node per mint, under the parent (nodes.ts upsert keeps a known parentMint), so that asset is no
   * family top there and its undrawn coins get no ghost. `indexed` = distinct drawn mints + the undrawn coins
   * of every asset family not drawn inside another one, which is the client's `familyTotal` at sync. `total`
   * keeps counting nodes (the body and /v1 are unchanged). Cached per version (the default-depth tree).
   */
  mapIndexed(all = true) {
    if (this.indexedCache?.version === this.version && this.indexedCache.all === all) return this.indexedCache.n;
    return drain(this.#countsGen(all, drain(this.#mapCtxGen(all)))).indexed;
  }
  indexedCache = null;
  /** `indexed` from a walk's distinct mints and nested asset tops, with the job's families and drawn sets (mapUndrawn's sum). */
  #indexedIn(distinct, nested, all, ctx) {
    if (!all) return distinct;
    const { fam, drawn } = ctx;
    let n = distinct;
    for (const [asset, kids] of fam) n += Math.max(0, kids.length - (drawn.get(asset)?.size ?? 0));
    for (const a of nested) n -= Math.max(0, (fam.get(a)?.length ?? 0) - (drawn.get(a)?.size ?? 0));
    return n;
  }

  // ---------------------------------------------------------------- family snapshots (DESIGN-FAMILY-ALL §4)
  // Each pool is a Map `${mint}:${v}` → snapshot in least-recently-read order, with the estimated bytes it holds.
  familyPools = {
    asset: { snaps: new Map(), bytes: 0, budget: FAMILY_ASSET_BYTES },
    coin: { snaps: new Map(), bytes: 0, budget: FAMILY_COIN_BYTES },
  };
  familyCurrent = new Map();  // mint → its newest held snapshot
  familyStats = { builds: 0, lastBuildMs: null, maxBuildMs: 0, lastOwnMs: null, maxOwnMs: 0, evicted: 0 }; // own = without the shared computed() pass
  /**
   * The coins of one family: a listed asset's coins (assetFamilies, every one of them, drawn or not),
   * else a tracked coin's tracked direct children (childrenOf, [] for a leaf), else null. Always the
   * all-scope view (the map's), whatever the listing mode.
   */
  familyMembers(mint) {
    const asset = this.assetFamilies().get(mint);
    if (asset) return asset;
    const c = this.coins.get(mint);
    return c && c.tracked ? this.childrenOf(mint) : null;
  }
  /**
   * A family's snapshot `{ mint, v, at, version, rows, pages, buildMs, ownMs, readAt, bytes, pool }`, or null when
   * `mint` is neither a listed asset with coins nor a tracked coin. `v` (a snapshot's build time, ms) returns
   * that snapshot while it is held; otherwise the current one, rebuilt only when the version moved and
   * MAP_CACHE_MS passed (the build is synchronous, so concurrent requests share it). Rows are positional:
   * `[mint, symbol, mcapUsd, lockedUsd, createdAt, migrated 0|1, children]`, mapRef(c, true)'s fields with
   * USD to 4 significant digits, ordered by locked value, then price (raw, desc; -1 when unknown), then mint:
   * mapAll's and assetDrawn's keys. `pages` is the HTTP layer's slot for encoded pages (familyPagePut).
   * A leaf's snapshot (no rows, not an asset) is built per request and never held: nothing to page through.
   */
  familyEntry(mint, v = null) {
    const now = this.now();
    const pools = [this.familyPools.asset, this.familyPools.coin];
    for (const pool of pools) for (const s of pool.snaps.values()) { if (now - s.readAt < FAMILY_SNAPSHOT_MS) break; this.#dropFamily(s); }
    if (v != null) for (const pool of pools) { const held = pool.snaps.get(`${mint}:${v}`); if (held) return this.#readFamily(held, now); }
    const cur = this.familyCurrent.get(mint);
    if (cur && (cur.version === this.version || now - cur.at < MAP_CACHE_MS)) return this.#readFamily(cur, now);
    const t0 = performance.now(); // buildMs includes the shared per-version passes (computed, assetFamilies) when this build pays them, like mapAll's
    const members = this.familyMembers(mint);
    if (!members) return null;
    const d = this.computed(), n = members.length, t1 = performance.now();
    const rows = new Array(n), locked = new Float64Array(n), price = new Float64Array(n), order = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = members[i], e = d.get(c.mint);
      rows[i] = this.#familyRow(c, e);
      locked[i] = sortKey(e?.lockedUsd); price[i] = sortKey(e?.priceUsd); order[i] = i;
    }
    order.sort((a, b) => locked[b] - locked[a] || price[b] - price[a] || (rows[a][0] < rows[b][0] ? -1 : rows[a][0] > rows[b][0] ? 1 : 0));
    // v = the build time (ms), above every v of this family still held, so a clock step back never reuses one.
    let at = now;
    for (const pool of pools) for (const s of pool.snaps.values()) if (s.mint === mint && s.v >= at) at = s.v + 1;
    const snap = { mint, v: at, at, version: this.version, rows: order.map((i) => rows[i]), pages: new Map(), pageBytes: 0, bytes: FAMILY_SNAP_BYTES + n * FAMILY_ROW_BYTES, buildMs: 0, ownMs: 0, readAt: now, pool: null };
    snap.buildMs = Math.round(performance.now() - t0); snap.ownMs = Math.round(performance.now() - t1);
    const asset = this.assetFamilies().has(mint);
    if (n === 0 && !asset) { if (cur) this.familyCurrent.delete(mint); return snap; } // a leaf
    const pool = asset ? this.familyPools.asset : this.familyPools.coin;
    snap.pool = pool;
    pool.snaps.set(`${mint}:${snap.v}`, snap); pool.bytes += snap.bytes;
    this.familyCurrent.set(mint, snap);
    this.#fitFamilies(pool, snap);
    const st = this.familyStats;
    st.builds++; st.lastBuildMs = snap.buildMs; st.maxBuildMs = Math.max(st.maxBuildMs, snap.buildMs); st.lastOwnMs = snap.ownMs; st.maxOwnMs = Math.max(st.maxOwnMs, snap.ownMs);
    return snap;
  }
  /**
   * Keeps an encoded page of `snap` under `key` (the HTTP layer's (offset, limit) cache): at most FAMILY_PAGES
   * pages and FAMILY_PAGE_BYTES of them per snapshot, oldest out first; their bytes count in the snapshot's pool.
   */
  familyPagePut(snap, key, page) {
    const w = (p) => p.bytes.length * FAMILY_PAGE_COPIES;
    const old = snap.pages.get(key);
    if (old) { snap.pages.delete(key); snap.pageBytes -= w(old); }
    snap.pages.set(key, page); snap.pageBytes += w(page);
    for (const [k, p] of snap.pages) {
      if (p === page || (snap.pages.size <= FAMILY_PAGES && snap.pageBytes <= FAMILY_PAGE_BYTES)) break;
      snap.pages.delete(k); snap.pageBytes -= w(p);
    }
    const bytes = FAMILY_SNAP_BYTES + snap.rows.length * FAMILY_ROW_BYTES + snap.pageBytes;
    if (snap.pool) { snap.pool.bytes += bytes - snap.bytes; snap.bytes = bytes; this.#fitFamilies(snap.pool, snap); } else snap.bytes = bytes;
    return page;
  }
  /** Held family snapshots per pool (count, estimated bytes, budget), for /api/health. */
  familyHeld() {
    const { asset, coin } = this.familyPools;
    const one = (p) => ({ held: p.snaps.size, bytes: p.bytes, budget: p.budget });
    return { held: asset.snaps.size + coin.snaps.size, bytes: asset.bytes + coin.bytes, asset: one(asset), coin: one(coin) };
  }
  /**
   * One family row: mapRef(c, true)'s symbol, mcapUsd, lockedUsd, createdAt, migrated and children, read
   * from the same sources (mints, computed()) without building the whole mapRef object, which cost ~3× more
   * over a 50k-coin family. map-family.test.mjs holds every row equal to mapRef's fields.
   */
  #familyRow(c, e) {
    const mcapUsd = e?.priceUsd != null ? e.priceUsd * units(c.tokenTotalSupply, this.decimalsOf(c.mint)) : null;
    return [c.mint, this.mints.get(c.mint)?.symbol ?? null, p4(mcapUsd), p4(e?.lockedUsd ?? null), c.createdAt ?? null, c.migrated ? 1 : 0, e?.children ?? 0];
  }
  #readFamily(s, now) { const key = `${s.mint}:${s.v}`; s.readAt = now; s.pool.snaps.delete(key); s.pool.snaps.set(key, s); return s; }
  #dropFamily(s) {
    s.pool.snaps.delete(`${s.mint}:${s.v}`); s.pool.bytes -= s.bytes; s.pool = null;
    if (this.familyCurrent.get(s.mint) === s) this.familyCurrent.delete(s.mint);
  }
  /** Drops the least recently read snapshots of `pool` until it fits its budget; `keep` (the one being served) stays. */
  #fitFamilies(pool, keep) {
    if (pool.bytes <= pool.budget) return;
    for (const s of pool.snaps.values()) {
      if (pool.bytes <= pool.budget) break;
      if (s !== keep) { this.#dropFamily(s); this.familyStats.evicted++; }
    }
  }

  /**
   * The full coin view. `all`: children, descendants and locked value over every pump.fun child
   * (scopedAll, what the map draws); without it the listing-mode scope (scoped), which in "ours"
   * mode counts only Spore launches. The coin page, /api/tree, /api/search and the SSE "coin" event
   * ask for `all`; /api/roots, /api/feed, /api/stats and `scope=ours` keep the listing scope.
   */
  view(c, { all = false } = {}) {
    const d = this.computed().get(c.mint) ?? {};
    const { name, symbol } = this.nameOf(c.mint);
    const meta = this.metaFor(c);
    const anc = this.ancestors(c.mint);
    const vol = this.volumes().get(c.mint);
    const decimals = this.decimalsOf(c.mint);
    const supply = units(c.tokenTotalSupply, decimals);
    const mintInfo = this.mints.get(c.mint);
    const s = all ? this.scopedAll(c) : this.scoped(c);
    return {
      mint: c.mint, name, symbol, image: imageProxyUrl(meta?.image), description: meta?.description ?? null,
      twitter: meta?.twitter ?? null, telegram: meta?.telegram ?? null, website: meta?.website ?? null,
      creator: c.creator, quoteMint: c.quoteMint, quoteSymbol: this.quoteSymbol(c), quoteDecimals: this.quoteDecimals(c),
      depth: c.depth, parent: anc[0] ? this.ref(anc[0]) : null, root: anc.length ? this.ref(anc[anc.length - 1]) : null, ancestors: anc.map((a) => this.ref(a)),
      complete: c.complete, migrated: c.migrated, pool: c.pool, createdAt: c.createdAt, createdSlot: c.createdSlot,
      tokenProgram: mintInfo?.tokenProgram ?? TOKEN_2022_PROGRAM_ID.toBase58(), decimals, totalSupply: c.tokenTotalSupply,
      priceQuote: d.priceQuote ?? null, priceSol: d.priceSol ?? null, priceUsd: d.priceUsd ?? null,
      mcapSol: d.priceSol != null ? d.priceSol * supply : null, mcapUsd: d.priceUsd != null ? d.priceUsd * supply : null,
      ...capField(this.mcapCapOf(c, d.priceUsd != null ? d.priceUsd * supply : null)),
      progress: progressOf(c, this.global?.initialRealTokenReserves),
      children: s.children, descendants: s.descendants, lockedQuote: s.lockedQuote.toString(), lockedUsd: s.lockedUsd, otherChildren: s.otherChildren,
      volume24hUsd: vol?.usd ?? 0, trades24h: vol?.trades ?? 0,
      holderReward: c.holderReward, creatorFeeBps: c.creatorFeeBps, shares: c.shares, updatedAt: Math.floor((c.updatedAt ?? 0) / 1000), // seconds on the coin page; the row holds ms
      curve: c.curve, mayhem: c.mayhem, tracked: c.tracked, ...this.oursOf(c), feePaid: this.feePaidOf(c),
    };
  }

  /**
   * In "ours" mode the counts cover our coins (locked value and volume also include the context
   * ancestors) and `otherChildren` is how many direct children on pump.fun the scope leaves out,
   * so the UI can say "and N other children on pump.fun".
   */
  stats() {
    const sc = this.scope();
    const maxDepth = this.global?.maxCurveDepth ?? 0;
    const byDepth = new Array(Math.max(maxDepth + 1, 1)).fill(0);
    let coins = 0, lockedUsd = 0, otherChildren = 0;
    for (const mint of this.mode === "all" ? sc.inScope : sc.ours) {
      const c = this.coins.get(mint); if (!c) continue;
      coins++;
      if (c.depth < byDepth.length) byDepth[c.depth]++; else byDepth[c.depth] = (byDepth[c.depth] ?? 0) + 1;
    }
    for (const mint of sc.inScope) { const c = this.coins.get(mint); if (!c) continue; const s = this.scoped(c); lockedUsd += s.lockedUsd ?? 0; otherChildren += s.otherChildren; }
    const roots = this.visibleRoots().length;
    let volume24hUsd = 0; for (const [mint, v] of this.volumes()) if (sc.inScope.has(mint)) volume24hUsd += v.usd;
    return { coins, roots, byDepth, lockedUsd, volume24hUsd, solUsd: this.solUsd, maxDepth, backfill: { ...this.backfill }, updatedAt: this.updatedAt, mode: this.mode, ourCoins: sc.ours.size, otherChildren };
  }
}

function inChain(chain, mint) { for (let i = 0; i < chain.length; i++) if (chain[i].mint === mint) return true; return false; }
function stripUndefined(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)); }
