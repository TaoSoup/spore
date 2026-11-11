// The indexer: backfill (once, resumable), live log subscription, refresh loop (DESIGN §6).
//
// Shape of the work:
//   backfill  getProgramAccounts per depth (and per listed quote asset) → resolve each curve's mint → walk ancestors → mint data
//   live      CreateEvent / TradeEvent / CompleteEvent (+ pump-amm Buy/SellEvent for graduated coins)
//   refresh   hot coins every tick, the whole set on a rolling schedule, SOL price every minute
// All RPC traffic shares one budget (rpc.mjs), so the backfill never starves the live path.
import { USDC_MINT, PUMP_SDK, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, GLOBAL_PDA, QUOTE_CONTROL_PDA, PublicKey, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  bondingCurvePda, canonicalPumpPoolPdaWithQuote, normalizeQuoteMint, feeSharingConfigPda, metaplexPda, pk, b58 } from "./sdk.mjs";
import { BONDING_CURVE_DISCRIMINATOR, decodeCurve, decodeEvent, decodeMint, decodeMetaplex, decodePool, decodeShares, decodeTokenAccount, eventsInLogs, plain } from "./decode.mjs";
import { LogsSubscriber } from "./live.mjs";
import { curvePriceQuote, poolPriceQuote, units } from "./pricing.mjs";

const nowS = () => Math.floor(Date.now() / 1000);
const SOL_MINT = NATIVE_MINT.toBase58(); // encoded once: toBase58() is a base58 encode per call
const USDC_MINT_STR = String(USDC_MINT);
/** Programs whose events the live subscription acts on; a CPI into another program cannot inject events. */
const LIVE_EVENT_PROGRAMS = new Set([PUMP_PROGRAM_ID.toBase58(), PUMP_AMM_PROGRAM_ID.toBase58()]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const DEPTH_OFFSET = 141; // BondingCurve.depth (DESIGN §2)
const QUOTE_MINT_OFFSET = 83; // BondingCurve.quote_mint (measured on live curves: a coin quoted in $gmonad, $gmonad quoted in MON)
// The slice of a BondingCurve the asset walk reads, from offset 32: real_quote_reserves u64 at 0, `complete` at 16
// (48), quote_mint at 51..83 (83..115), depth at 109 (141). A staged row that holds only this slice is shorter than
// CURVE_FULL_MIN and gets its full account fetched before it is resolved.
const CURVE_SLICE_OFFSET = 32, CURVE_SLICE_LEN = 110, CURVE_FULL_MIN = 142;
const ZERO_KEY_HEX = "0".repeat(64);
const sliceCurve = (buf) => { const q = buf.subarray(QUOTE_MINT_OFFSET - CURVE_SLICE_OFFSET, QUOTE_MINT_OFFSET - CURVE_SLICE_OFFSET + 32); return { rq: Number(buf.readBigUInt64LE(0)), complete: buf[48 - CURVE_SLICE_OFFSET] === 1, quoteMint: q.toString("hex") === ZERO_KEY_HEX ? null : new PublicKey(q).toBase58(), depth: buf[DEPTH_OFFSET - CURVE_SLICE_OFFSET] }; };
/** Full re-scan of a depth (getProgramAccountsV2 on Helius walks the whole pump key space, ~8 min per depth); the live stream covers the rest. */
const BACKFILL_RESCAN_S = 7 * 24 * 3600;
/** Listed-asset scans cost the same full walk each; the live stream adds their new coins, so a month between walks. */
const ASSET_RESCAN_S = 30 * 24 * 3600;
const SHARES_TTL_S = 6 * 3600;
// A quote mint whose bonding-curve PDA the chain answered as no pump curve (no account, another owner, bytes that do
// not decode) is not asked about again by ensureAncestors for this long. Coins quoted in assets that are not in
// QuoteControl (tokenized stocks, TSLA, META, ...: 13 on the local index, Nov 11 2026) keep those mints missing for
// good, and every live spawn under a new parent used to ask for all of them again, in each round.
export const NOT_CURVE_TTL_MS = 30 * 60_000;
// On-demand lookups (/api/coin, eligibility) remember whether a mint is a pump coin for this long,
// so a stream of requests for the same mint costs one RPC round, not one per request.
const FETCH_CACHE_MS = 60_000;
const FETCH_CACHE_MAX = 2_000;
// A coin younger than this gets its fee-sharing config re-read on every refresh: a spawn through
// Spore writes the config in (or right after) the create transaction, and the "ours" flag depends on it.
const YOUNG_S = 30 * 60;
// A migrated pool that prices other coins (the quote mint of tracked children) is re-read once per this
// window instead of once per full pass, so a child's chain price does not trail its parent's pool.
const PRICING_POOL_MS = 4 * 60_000;
// Mint records (name, symbol and the metadata uri that leads to a coin's logo). resolveOne stores only the
// token program, so every resolved backfill batch reads its own mints at once; the catch-up reads the ones
// stored before that (or whose batch read failed): a bounded slice soon after boot and every 10 min after,
// on the main lane like the rest. A mint read without a uri is tried again once a day, not every run.
export const MINT_CATCHUP_FIRST_MS = 60_000;
export const MINT_CATCHUP_MS = 10 * 60_000;
export const MINT_CATCHUP_MAX = 2_000;
const MINT_URI_RETRY_S = 24 * 3600;
// The rolling refresh's place in model.tracked(), kept across restarts (backfill_state): a full pass takes
// hours on a big index, and a cursor back at 0 on every boot left the tail of the list never refreshed.
export const REFRESH_CURSOR_KEY = "refresh:cursor";
// Map stream (DESIGN §11.5): a `pair` is announced at most once per mint within this window (the
// create path and the enrich path both try), and `mapdelta` batches are flushed on this timer with
// at most this many entries each (largest locked value first; the rest carry over).
export const PAIR_DEDUPE_MS = 60_000;
export const MAPDELTA_MS = 3_000;
export const MAPDELTA_MAX = 500;
// Listed quote mints with a CoinGecko id: trees rooted in a coin quoted in one of these get USD
// (and SOL) prices. PUMP is the common case; tokenized stocks have no public price feed here.
const QUOTE_PRICE_IDS = { pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: "pump-fun" };
// Every other listed quote (tokenized stocks, CARDS, WBTC, ...) is priced from Jupiter's public price
// API, at most 50 mints per call, calls one after another; a price backed by less than this much
// liquidity is ignored (thin pools quote anything). CoinGecko's mints above are never overwritten.
export const JUP_PRICE = "https://lite-api.jup.ag/price/v3?ids=";
export const JUP_BATCH = 50;
export const JUP_MIN_LIQ_USD = 5_000;
export const QUOTE_USD_MS = 120_000;
const COINGECKO = `https://api.coingecko.com/api/v3/simple/price?ids=${["solana", ...Object.values(QUOTE_PRICE_IDS)].join(",")}&vs_currencies=usd&include_market_cap=true`;

export class Indexer {
  // #listedQuotes(): the Set, and the whitelist array and QuoteControl object it was built from.
  #listed = null; #listedFrom = [];
  constructor({ rpc, model, meta, hub, log = console, opts = {} }) {
    this.rpc = rpc; this.model = model; this.meta = meta; this.hub = hub; this.log = log;
    this.opts = { backfill: true, backfillLimit: Infinity, refreshMs: 30_000, fullRefreshMs: 20 * 60_000, wsUrl: null, createdAtProbe: true,
      mintCatchupFirstMs: MINT_CATCHUP_FIRST_MS, mintCatchupMs: MINT_CATCHUP_MS, mintCatchupMax: MINT_CATCHUP_MAX, ...opts };
    this.live = null; this.timers = []; this.stopped = false;
    this.globalRaw = null; this.quoteControlRaw = null; this.globalAt = 0;
    // `cursor` comes back from the db on the first refresh with a non-empty list (#restoreCursor).
    this.hot = new Set(); this.cursor = 0; this.cursorRestored = false; this.pricingCursor = 0; this.refreshing = false;
    // A mint run in flight (#mintLane): catchUpMintInfo, or a whole-index read (ensureAllMintInfo) the catch-up would only
    // duplicate; `mintRun` settles when it ends.
    this.mintCatchingUp = false; this.mintRun = null;
    this.fetchCache = new Map(); // mint → { at, found } for fetchCoin
    this.notCurve = new Map();   // quote mint → when the chain said it is no pump curve (ensureAncestors, NOT_CURVE_TTL_MS)
    this.pairSent = new Map();   // mint → when its `pair` event went out (dedupe)
    this.assetScanning = false;  // the asset walk (scanAssetQuotes) in flight
    this.state = { phase: "idle", backfillStartedAt: null, backfillDoneAt: null, lastRefreshAt: null, lastError: null, created: { probed: 0, found: 0 }, map: { pairs: 0, deltas: 0, deltaEntries: 0 },
      mints: { batchRead: 0, batchFailed: 0, catchUpRuns: 0, catchUpRead: 0, unread: null, lastCatchUpAt: null } };
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    await this.loadGlobal();
    this.live = new LogsSubscriber({ wsUrl: this.opts.wsUrl, programId: PUMP_PROGRAM_ID.toBase58(), log: this.log, onLogs: (n) => this.onLogs(n), onConnect: () => { this.refresh({ reason: "reconnect" }).catch(() => {}); } }).start();
    this.refreshSolUsd().catch(() => {});
    this.timers.push(setInterval(() => this.refreshSolUsd().catch(() => {}), 60_000));
    this.refreshQuoteUsd().catch(() => {});
    this.timers.push(setInterval(() => this.refreshQuoteUsd().catch(() => {}), QUOTE_USD_MS));
    this.backfillPoolVq().then(() => this.refreshPricingPools()).catch(() => {}); // pool virtual quotes never read, then every pool that prices other coins (biggest families first)
    this.timers.push(setInterval(() => this.refresh({ reason: "tick" }).catch((e) => this.log.warn(`refresh: ${e.message}`)), this.opts.refreshMs));
    this.timers.push(setInterval(() => this.loadGlobal().catch(() => {}), 10 * 60_000));
    this.timers.push(setInterval(() => { try { this.flushMapDelta(); } catch (e) { this.log.warn(`mapdelta: ${e.message}`); } }, MAPDELTA_MS));
    // Mint records stored unread (thousands on a full index): a first slice once the live phase is up, then one per interval.
    // Timers, not awaited, so start() and the backfill never wait on it; clearInterval in stop() clears the timeout too.
    const catchUp = () => this.catchUpMintInfo().catch((e) => this.log.warn(`mints: catch-up: ${e.message}`));
    this.timers.push(setTimeout(catchUp, this.opts.mintCatchupFirstMs), setInterval(catchUp, this.opts.mintCatchupMs));
    if (this.opts.backfill) this.runBackfill().catch((e) => { this.state.lastError = e.message; this.log.error(`backfill failed: ${e.stack ?? e}`); });
    else { this.model.setBackfill({ done: true, ...this.model.db.backfillStats() }); this.state.phase = "live"; }
  }
  stop() { this.stopped = true; this.live?.stop(); for (const t of this.timers) clearInterval(t); }

  snapshot() { return { ...this.state, backfill: this.model.backfill, rpc: this.rpc.snapshot(), live: this.live?.snapshot() ?? null, meta: this.meta?.snapshot?.() ?? this.meta?.stats ?? null }; }

  // ---------------------------------------------------------------- map stream (DESIGN §11.5)
  /**
   * `pair`: a coin with a tracked parent, both as map nodes, so an open map can add the child (and
   * the root when it is not drawn yet). Sent in both listing modes; at most once per mint per
   * `PAIR_DEDUPE_MS`, since the create path tries before and after the parent chain is pulled.
   * Returns true when an event went out.
   */
  announcePair(mint) {
    const c = this.model.get(mint);
    if (!c || !c.tracked || !c.quoteMint) return false;
    // A coin quoted in a listed asset (depth 0 on chain): its family top is the asset's bubble, not a coin.
    const underAsset = c.depth < 1 && c.quoteMint !== SOL_MINT && !this.model.coins.has(c.quoteMint);
    if (c.depth < 1 && !underAsset) return false;
    const p = underAsset ? null : this.model.get(c.quoteMint);
    if (!underAsset && (!p || !p.tracked)) return false;
    const at = this.pairSent.get(mint);
    if (at != null && Date.now() - at < PAIR_DEDUPE_MS) return false;
    this.pairSent.set(mint, Date.now());
    if (this.pairSent.size > 5_000) for (const [m, t] of this.pairSent) { if (Date.now() - t >= PAIR_DEDUPE_MS) this.pairSent.delete(m); if (this.pairSent.size <= 2_500) break; }
    this.state.map.pairs++;
    // `parentMint` on both halves, as on a `since=` node, so a client that does not hold the parent yet can hang it under its own parent instead of drawing it as a root.
    const parent = underAsset ? { ...this.model.assetMapRef(c.quoteMint), parentMint: null } : { ...this.model.mapRef(p, true), parentMint: p.depth > 0 ? p.quoteMint ?? null : null };
    this.hub?.emit("pair", { coin: { ...this.model.mapRef(c, true), parentMint: c.quoteMint }, parent });
    return true;
  }
  /**
   * `mapdelta`: the coins whose map node changed since the last flush (trades, refresh ticks,
   * completes, a resolved name or logo), with the numbers and labels a bubble shows. Only sent when
   * something changed; capped at `MAPDELTA_MAX` entries, largest locked value first, the rest wait
   * for the next flush. Returns the payload (null when nothing changed).
   */
  flushMapDelta() {
    const mints = this.model.takeDirty();
    if (!mints.length) return null;
    const entries = [];
    for (const mint of mints) {
      const c = this.model.get(mint);
      if (!c || !c.tracked) continue;
      const r = this.model.mapRef(c, true);
      entries.push({ mint, mcapUsd: r.mcapUsd, mcapCapUsd: r.mcapCapUsd ?? null, lockedUsd: r.lockedUsd, children: r.children, descendants: r.descendants, migrated: r.migrated, name: r.name, symbol: r.symbol, image: r.image });
    }
    if (!entries.length) return null;
    entries.sort((a, b) => (b.lockedUsd ?? -1) - (a.lockedUsd ?? -1));
    if (entries.length > MAPDELTA_MAX) this.model.requeueDirty(entries.splice(MAPDELTA_MAX).map((e) => e.mint));
    const payload = { at: Date.now(), updated: entries };
    this.state.map.deltas++; this.state.map.deltaEntries += entries.length;
    this.hub?.emit("mapdelta", payload);
    return payload;
  }

  /** pump `Global` + `QuoteControl`, kept raw (BN) for the SDK's admission math and plain for the API. */
  async loadGlobal() {
    const [g, qc] = await this.rpc.getMultipleAccounts([GLOBAL_PDA.toBase58(), QUOTE_CONTROL_PDA.toBase58()]);
    if (!g) throw new Error("pump Global account not found");
    this.globalRaw = PUMP_SDK.decodeGlobal({ ...g, owner: pk(g.owner) });
    this.quoteControlRaw = qc ? PUMP_SDK.decodeQuoteControl({ ...qc, owner: pk(qc.owner) }) : null;
    this.globalAt = Date.now();
    const p = plain(this.globalRaw);
    this.model.setGlobal({ maxCurveDepth: p.maxCurveDepth, createV2Enabled: p.createV2Enabled, initialRealTokenReserves: p.initialRealTokenReserves, initialVirtualTokenReserves: p.initialVirtualTokenReserves, initialVirtualSolReserves: p.initialVirtualSolReserves, tokenTotalSupply: p.tokenTotalSupply, whitelistedQuoteMints: p.whitelistedQuoteMints, creatorFeeConfigurable: p.creatorFeeConfigurable, maxConfigurableCreatorFeeBps: p.maxConfigurableCreatorFeeBps, isHolderRewardEnabled: p.isHolderRewardEnabled, quoteControlMints: this.quoteControlRaw ? this.quoteControlRaw.mints.length : 0 });
  }

  async refreshSolUsd() {
    try {
      const r = await fetch(COINGECKO, { signal: AbortSignal.timeout(6_000) });
      if (r.ok) {
        const j = await r.json();
        if (j?.solana?.usd > 0) this.model.setSolUsd(Number(j.solana.usd));
        for (const [mint, id] of Object.entries(QUOTE_PRICE_IDS)) if (j?.[id]?.usd > 0) this.model.setQuoteUsd(mint, Number(j[id].usd));
        // The asset's circulating market cap (its bubble's mcap; on-chain supply overstates PUMP about x2).
        for (const [mint, id] of Object.entries(QUOTE_PRICE_IDS)) if (j?.[id]?.usd_market_cap > 0) this.model.setQuoteMcap(mint, Number(j[id].usd_market_cap));
      }
    } catch { /* keep the last prices (DESIGN §6.3) */ }
  }

  /**
   * USD prices of the listed quote mints CoinGecko does not cover (the keys of assetFamilies() that are
   * not SOL, not USDC, not a coin we track and not a CoinGecko mint), from Jupiter in batches of 50,
   * sequential, 6 s each. Accepted: usdPrice > 0 with liquidity absent or >= JUP_MIN_LIQ_USD. Written
   * with one setQuoteUsdMany (one bump); a failed batch keeps the last values. Returns the accepted map.
   */
  async refreshQuoteUsd({ fetchImpl = this.opts.fetch ?? fetch } = {}) {
    const skip = new Set([SOL_MINT, USDC_MINT_STR, ...Object.keys(QUOTE_PRICE_IDS)]);
    const mints = [...this.model.assetFamilies().keys()].filter((m) => !skip.has(m) && !this.model.get(m)?.tracked);
    const got = {};
    for (const batch of chunks(mints, JUP_BATCH)) {
      try {
        const r = await fetchImpl(JUP_PRICE + batch.join(","), { signal: AbortSignal.timeout(6_000) });
        if (!r.ok) continue;
        const j = await r.json();
        for (const m of batch) {
          // A Token-2022 ScaledUiAmount mint (tokenized stocks, pre-IPO tokens): usdPrice is per scaled UI unit, while every
          // quote price here is per raw amount / 10^decimals, so the prescaled price is the one to use when Jupiter gives it.
          const e = j?.[m]; const pre = Number(e?.scaledUiConfig?.usdPricePrescaled);
          const p = pre > 0 && Number.isFinite(pre) ? pre : Number(e?.usdPrice); const liq = e?.liquidity;
          if (p > 0 && Number.isFinite(p) && (liq == null || Number(liq) >= JUP_MIN_LIQ_USD)) got[m] = p;
        }
      } catch { /* keep the last prices for this batch */ }
    }
    if (Object.keys(got).length) this.model.setQuoteUsdMany(got);
    return got;
  }

  // ---------------------------------------------------------------- backfill
  async runBackfill() {
    const db = this.model.db;
    this.state.phase = "backfill:scan"; this.state.backfillStartedAt = nowS();
    const maxDepth = this.model.global?.maxCurveDepth ?? 0;
    for (let d = 1; d <= maxDepth; d++) {
      const scannedAt = db.backfillGet(`scanned:${d}`, 0);
      if (nowS() - scannedAt < BACKFILL_RESCAN_S) continue;
      const t0 = Date.now();
      const rows = await this.rpc.getProgramAccounts(PUMP_PROGRAM_ID.toBase58(), [
        { memcmp: { offset: 0, bytes: bs58(BONDING_CURVE_DISCRIMINATOR) } },
        { memcmp: { offset: DEPTH_OFFSET, bytes: bs58(Buffer.from([d])) } },
      ]);
      db.transaction(() => {
        for (const { pubkey, account } of rows) {
          let c; try { c = decodeCurve(account.data, pubkey); } catch { continue; }
          db.backfillCurveUpsert({ curve: pubkey, depth: c.depth, quoteMint: c.quoteMint, data: account.data.toString("base64"), graduated: c.complete || c.migrated, rq: Number(BigInt(c.realQuoteReserves)) });
        }
      });
      db.backfillSet(`scanned:${d}`, nowS());
      this.log.info(`backfill: depth ${d}: ${rows.length} curves in ${Date.now() - t0} ms`);
    }
    this.model.setBackfill({ ...db.backfillStats() });

    this.state.phase = "backfill:resolve";
    await this.resolveCurves();
    this.state.phase = "backfill:ancestors";
    await this.ensureAncestors();
    this.state.phase = "backfill:mints";
    await this.ensureAllMintInfo();
    this.model.setBackfill({ done: true, ...db.backfillStats() });
    this.state.backfillDoneAt = nowS();
    this.log.info(`backfill: done (${this.model.backfill.resolved}/${this.model.backfill.total} curves, ${this.model.coins.size} coins)`);
    this.state.phase = "backfill:enrich";
    await this.ensurePools();
    await this.ensureShares();
    if (this.opts.createdAtProbe) await this.probeCreatedAt();
    this.state.phase = "live";
    // Coins quoted in a listed asset (USDC, PUMP, MON, …) are depth 0 on chain, so the depth scans never see
    // them; before this only the ones with a child (found through its ancestor walk) reached the asset's
    // family. One streamed walk of the whole pump key space (~5 min, ASSET_RESCAN_S apart) stages every one of
    // them, after the service is live so the site never waits on it; the live stream adds the new ones between walks.
    await this.scanAssetQuotes().catch((e) => this.log.warn(`backfill: assets: ${e.message}`));
  }

  /**
   * Turns staged curves into coins. A curve stores no mint, so the token accounts the curve owns
   * are listed (Token-2022 first, SPL Token for older coins): the one whose mint is not the quote
   * mint is the coin's mint. Priority: graduated first, then biggest raise, then deepest, so the
   * leaderboard fills with the coins that matter first. `backfillLimit` bounds dev runs. Each batch's
   * coins get their mint records read before the next batch (#readBatchMints), not after the whole
   * backfill drains (days on a full index), so their names and logos show while it runs.
   */
  async resolveCurves() {
    const db = this.model.db;
    const limit = this.opts.backfillLimit;
    const concurrency = Math.max(1, this.rpc.concurrency);
    for (;;) {
      if (this.stopped) return;
      const stats = db.backfillStats();
      if (stats.resolved >= limit) { this.log.info(`backfill: BACKFILL_LIMIT=${limit} reached (${stats.resolved} resolved)`); return; }
      const batch = db.backfillPending(Math.min(50, limit - stats.resolved));
      if (!batch.length) return;
      await this.#fillCurveData(batch);
      let i = 0;
      const stored = [];
      await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
        while (i < batch.length && !this.stopped) {
          const row = batch[i++];
          if (!row.data) { db.backfillFail(row.curve, "curve account gone"); continue; }
          try { const mint = await this.resolveOne(row); if (mint) stored.push(mint); } catch (e) { db.backfillFail(row.curve, e.message); this.log.warn(`backfill: ${row.curve}: ${e.message}`); }
        }
      }));
      this.model.setBackfill({ ...db.backfillStats() });
      await this.#readBatchMints(stored);
    }
  }
  /**
   * The mint records of a resolved batch that were never read (and of their quote mints: the parent
   * #resolveByMint just stored for free): one getMultipleAccounts per 100, one Metaplex round for SPL
   * mints, new uris to the metadata fetcher. Never throws: a failed read is logged and left to the
   * catch-up (catchUpMintInfo), so resolveCurves goes on. Returns how many mints were read.
   */
  async #readBatchMints(mints) {
    if (!mints.length || this.stopped) return 0;
    let want = [];
    try {
      want = this.#unreadMints(mints.map((m) => this.model.get(m)).filter(Boolean));
      if (!want.length) return 0;
      await this.#readMints(want, this.rpc);
      this.state.mints.batchRead += want.length;
      return want.length;
    } catch (e) {
      this.state.mints.batchFailed += want.length;
      this.log.warn(`backfill: mint info for ${want.length} mints: ${e.message} (left to the catch-up)`);
      return 0;
    }
  }

  /** Resolves one staged curve into a coin; returns its mint. */
  async resolveOne(row) {
    const db = this.model.db;
    const curve = decodeCurve(Buffer.from(row.data, "base64"), row.curve);
    // Already known (live CreateEvent or a child's quote mint pointed here): no RPC needed.
    const known = this.model.byCurve(row.curve);
    if (known) { db.backfillResolve(row.curve, known.mint); return known.mint; }
    let accounts = await this.rpc.getTokenAccountsByOwner(row.curve, TOKEN_2022_PROGRAM_ID.toBase58());
    if (!accounts.some((a) => a.mint !== curve.quoteMint)) accounts = accounts.concat(await this.rpc.getTokenAccountsByOwner(row.curve, TOKEN_PROGRAM_ID.toBase58()));
    const base = accounts.find((a) => a.mint !== curve.quoteMint);
    if (!base) throw new Error("no base token account on the curve");
    this.model.setMint({ mint: base.mint, tokenProgram: base.tokenProgram });
    this.model.upsertCoin({ mint: base.mint, ...curve, tracked: true });
    db.backfillResolve(row.curve, base.mint);
    // The parent curve is now identified for free: its mint is this coin's quote mint.
    if (curve.quoteMint) this.#resolveByMint(curve.quoteMint);
    return base.mint;
  }
  #resolveByMint(mint) {
    const db = this.model.db;
    const key = bondingCurvePda(mint).toBase58();
    const row = db.backfillCurve(key);
    if (!row || row.resolvedAt) return;
    const curve = decodeCurve(Buffer.from(row.data, "base64"), key);
    this.model.upsertCoin({ mint, ...curve, tracked: true });
    db.backfillResolve(key, mint);
  }
  /**
   * Every bonding curve quoted in a listed asset (depth 0 with a quote mint), staged for `resolveCurves` like
   * the depth scans' rows: one streamed walk of the pump program reading a 110-byte slice of each curve (real
   * quote reserves, `complete`, quote mint, depth), at most once per ASSET_RESCAN_S and one at a time. A staged
   * row holds only that slice; `resolveCurves` fetches the full accounts for such rows in batches. Then the
   * new coins are resolved, their parents, mint data and pools pulled. Returns how many curves were new.
   */
  async scanAssetQuotes() {
    const db = this.model.db, key = "scanned:assets";
    if (this.assetScanning || nowS() - db.backfillGet(key, 0) < ASSET_RESCAN_S) return 0;
    this.assetScanning = true;
    try {
      const t0 = Date.now();
      const rows = [];
      const r = await this.rpc.scanProgramAccounts(PUMP_PROGRAM_ID.toBase58(), { filters: [{ memcmp: { offset: 0, bytes: bs58(BONDING_CURVE_DISCRIMINATOR) } }], dataSlice: { offset: CURVE_SLICE_OFFSET, length: CURVE_SLICE_LEN } }, (pubkey, slice) => {
        if (slice.length < CURVE_SLICE_LEN) return;
        const c = sliceCurve(slice);
        if (!c.quoteMint || c.depth !== 0) return;
        rows.push({ curve: pubkey, depth: 0, quoteMint: c.quoteMint, data: slice.toString("base64"), graduated: c.complete, rq: c.rq });
      });
      let staged = 0;
      db.transaction(() => {
        for (const row of rows) {
          if (this.model.byCurve(row.curve) || db.backfillCurve(row.curve)?.resolvedAt) continue;
          db.backfillCurveUpsert(row); staged++;
        }
      });
      db.backfillSet(key, nowS());
      this.model.setBackfill({ ...db.backfillStats() });
      this.log.info(`backfill: assets: ${r.accounts} curves walked (${r.pages} pages), ${rows.length} quoted in a listed asset, ${staged} new, in ${Math.round((Date.now() - t0) / 1000)} s`);
      if (staged) {
        await this.resolveCurves();
        await this.ensureAncestors();
        await this.ensureAllMintInfo();
        await this.ensurePools();
        this.model.setBackfill({ ...db.backfillStats() });
      }
      return staged;
    } finally { this.assetScanning = false; }
  }
  /** Rows staged by the asset walk hold a slice of the curve: fetch the full accounts (100 per call) and persist them. */
  async #fillCurveData(batch) {
    const short = batch.filter((r) => Buffer.from(r.data, "base64").length < CURVE_FULL_MIN);
    if (!short.length) return;
    const db = this.model.db;
    for (const part of chunks(short, 100)) {
      const infos = await this.rpc.getMultipleAccounts(part.map((r) => r.curve));
      infos.forEach((info, i) => {
        const row = part[i];
        if (!info) { row.data = null; return; }
        try {
          const c = decodeCurve(info.data, row.curve);
          row.data = info.data.toString("base64");
          db.backfillCurveUpsert({ curve: row.curve, depth: c.depth, quoteMint: c.quoteMint, data: row.data, graduated: c.complete || c.migrated, rq: Number(BigInt(c.realQuoteReserves)) });
        } catch { row.data = null; }
      });
    }
  }

  /**
   * Every tracked coin's quote-mint chain down to depth 0 lives in the model (DESIGN §6.1). An ancestor that
   * arrives already migrated gets its pool (vaults + virtual quote) read right away: without it every coin
   * below it has no price until the rolling refresh reaches it (up to FULL_REFRESH_MS).
   *
   * Each round runs on the event loop, so it walks the quote mints in use (the keys of the model's child index:
   * every coin with a quote mint sits in its quote mint's set; ~8k keys for 155k coins) against a Set of the
   * listed quotes, and skips mints the chain said are no pump curve (`notCurve`, NOT_CURVE_TTL_MS). Before that,
   * a round walked every coin and base58-encoded up to 231 QuoteControl keys per coin quoted in an asset:
   * ~20 s of blocked event loop per round on the local index (Nov 11 2026), two rounds per new parent.
   */
  async ensureAncestors({ rpc = this.rpc } = {}) {
    const addedMints = [];
    const now = Date.now();
    for (const [m, at] of this.notCurve) if (now - at >= NOT_CURVE_TTL_MS) this.notCurve.delete(m);
    for (let round = 0; round <= 6; round++) {
      const listed = this.#listedQuotes(), mints = [];
      for (const [q, kids] of this.model.children) if (kids.size && !this.model.coins.has(q) && !listed.has(q) && !this.notCurve.has(q)) mints.push(q);
      if (!mints.length) break;
      const keys = mints.map((m) => bondingCurvePda(m).toBase58());
      const infos = await rpc.getMultipleAccounts(keys);
      let added = 0;
      infos.forEach((info, i) => {
        let cur = null;
        if (info && info.owner === PUMP_PROGRAM_ID.toBase58()) { try { cur = decodeCurve(info.data, keys[i]); } catch { /* not a curve */ } }
        if (!cur) { this.notCurve.set(mints[i], Date.now()); return; }
        try { this.model.upsertCoin({ mint: mints[i], ...cur, tracked: true }); added++; addedMints.push(mints[i]); } catch (e) { this.log.warn(`backfill: ancestor ${mints[i]}: ${e.message}`); }
      });
      this.log.info(`backfill: ancestors round ${round}: ${added}/${mints.length} added`);
      if (!added) break;
    }
    const migrated = addedMints.map((m) => this.model.get(m)).filter((c) => c?.migrated);
    if (migrated.length) await this.ensurePools(migrated, { rpc });
  }
  /**
   * SOL, the Global's whitelisted quote mints and the QuoteControl mints, as base58 strings in one Set. Rebuilt only
   * when loadGlobal (every 10 min) replaced the whitelist array or the decoded QuoteControl: a toBase58() is a bn.js
   * encode of a few microseconds, which ensureAncestors used to pay per coin and QuoteControl key.
   */
  #listedQuotes() {
    const wl = this.model.global?.whitelistedQuoteMints ?? null, qc = this.quoteControlRaw ?? null;
    if (!this.#listed || this.#listedFrom[0] !== wl || this.#listedFrom[1] !== qc) {
      this.#listed = new Set([SOL_MINT, ...(wl ?? []), ...(qc?.mints ?? []).map((m) => m.mint.toBase58())]);
      this.#listedFrom = [wl, qc];
    }
    return this.#listed;
  }
  #isListedQuote(mint) { return this.#listedQuotes().has(mint); }

  /**
   * Decimals, token program and on-chain name/symbol/uri for every mint we reference (coins and
   * their non-SOL quote mints). Token-2022 mints carry metadata in the mint account itself; SPL
   * mints fall back to the Metaplex PDA. Then the off-chain JSON is queued (lazy, cached).
   */
  async ensureMintInfo(only = null, { rpc = this.rpc } = {}) {
    const mints = this.#unreadMints(only ?? this.model.coins.values());
    const n = await this.#readMints(mints, rpc);
    if (mints.length) this.log.info(`mints: ${mints.length} fetched (${n.metaplex} via Metaplex)`);
  }
  /**
   * ensureMintInfo over the whole index (the backfill's "backfill:mints" phase, the asset walk), on the mint lane: a
   * catch-up already running finishes first (what it read is not read again), and the catch-up timer skips while this
   * runs (it would read a slice of the same mints a second time).
   */
  async ensureAllMintInfo() {
    while (this.mintCatchingUp) await this.mintRun;
    return this.#mintLane(() => this.ensureMintInfo());
  }
  /** Runs `fn` as the one mint run in flight (`mintCatchingUp`, settled `mintRun`); the caller checked that none is. */
  async #mintLane(fn) {
    this.mintCatchingUp = true;
    let settle; this.mintRun = new Promise((r) => { settle = r; });
    try { return await fn(); } finally { this.mintCatchingUp = false; this.mintRun = null; settle(); }
  }
  /** The mints of `coins` and their non-SOL quote mints whose record is missing, has no decimals or was never read on chain. */
  #unreadMints(coins) {
    const wanted = new Set();
    const consider = (m) => { if (!m || m === SOL_MINT) return; const info = this.model.mint(m); if (!info || info.decimals == null || !info.onchainAt) wanted.add(m); };
    for (const c of coins) { consider(c.mint); consider(c.quoteMint); }
    return [...wanted];
  }
  /**
   * Reads the mint accounts of `mints` (100 per call) and, for the ones without Token-2022 metadata, their
   * Metaplex PDA, then hands every uri to the metadata fetcher; that last step also runs when a call
   * failed, so what was stored before it still gets fetched. Returns `{ metaplex }` (Metaplex lookups).
   */
  async #readMints(mints, rpc) {
    const needMetaplex = [];
    try {
      for (const part of chunks(mints, 100)) {
        const infos = await rpc.getMultipleAccounts(part);
        infos.forEach((info, i) => {
          const mint = part[i];
          if (!info) { this.model.setMint({ mint, onchainAt: nowS() }); return; }
          const m = decodeMint(info.data, info.owner);
          if (!m) { this.model.setMint({ mint, onchainAt: nowS() }); return; }
          this.model.setMint({ mint, decimals: m.decimals, tokenProgram: m.tokenProgram, supply: m.supply, ...(m.metadata ?? {}), onchainAt: m.metadata ? nowS() : 0 });
          if (!m.metadata) needMetaplex.push(mint);
        });
      }
      for (const part of chunks(needMetaplex, 100)) {
        const infos = await rpc.getMultipleAccounts(part.map((m) => metaplexPda(m).toBase58()));
        infos.forEach((info, i) => { const md = info ? decodeMetaplex(info.data) : null; this.model.setMint({ mint: part[i], ...(md ?? {}), onchainAt: nowS() }); });
      }
    } finally {
      for (const m of mints) { const uri = this.model.mint(m)?.uri; if (uri) this.meta?.request(uri); }
    }
    return { metaplex: needMetaplex.length };
  }
  /**
   * Mint records the backfill stored unread (resolveOne keeps only the token program, and the whole-index
   * ensureMintInfo runs only once resolveCurves drains, days away on a full index) or whose batch read
   * failed. Up to `max` mints per run (a multiple of the 100 per call keeps the calls full): never-read
   * ones first, then ones read without a uri more than MINT_URI_RETRY_S ago; within each, the biggest
   * families first (direct children of the family top, from the model's child index: no derived numbers
   * needed), a listed asset's own mint (the top of a family) before any coin. One run at a time, on the
   * main lane. Logs one line per run (none while nothing is left and nothing was left last time).
   * Returns `{ unread, noUri, read, withUri, metaplex, ms }`, or null when a run is already going
   * (another catch-up, or the whole-index read: ensureAllMintInfo).
   */
  async catchUpMintInfo({ max = this.opts.mintCatchupMax } = {}) {
    if (this.mintCatchingUp || this.stopped) return null;
    return this.#mintLane(async () => {
      const t0 = Date.now(), retryBefore = nowS() - MINT_URI_RETRY_S, TOP = Number.MAX_SAFE_INTEGER;
      const kids = (m) => this.model.children.get(m)?.size ?? 0;
      const family = (c) => { const anc = this.model.ancestors(c.mint); return kids((anc.length ? anc[anc.length - 1] : c).mint); };
      const unread = [], noUri = [], seen = new Set();
      // The weight is computed only for mints that are picked (thousands), not for every coin.
      const pick = (m, weight) => {
        if (!m || m === SOL_MINT || seen.has(m)) return;
        seen.add(m);
        const info = this.model.mint(m);
        if (!info || !info.onchainAt) unread.push([m, weight()]);
        else if (!info.uri && info.onchainAt < retryBefore) noUri.push([m, weight()]);
      };
      for (const c of this.model.coins.values()) {
        if (!c.tracked) continue;
        pick(c.mint, () => family(c));
        // A quote mint that is not a coin is a listed asset (PUMP, USDC, …): its bubble tops a family.
        if (c.quoteMint && !this.model.coins.has(c.quoteMint)) pick(c.quoteMint, () => TOP);
      }
      const byWeight = (a, b) => b[1] - a[1];
      const todo = [...unread.sort(byWeight), ...noUri.sort(byWeight)].slice(0, Math.max(0, max)).map(([m]) => m);
      const out = { unread: unread.length, noUri: noUri.length, read: 0, withUri: 0, metaplex: 0, ms: 0 };
      const last = this.state.mints.unread;
      this.state.mints.catchUpRuns++; this.state.mints.lastCatchUpAt = nowS(); this.state.mints.unread = unread.length;
      if (!todo.length) {
        if (last !== 0) this.log.info("mints: catch-up: every mint record read");
        return out;
      }
      let error = null;
      try { out.metaplex = (await this.#readMints(todo, this.rpc)).metaplex; } catch (e) { error = e; }
      // Read = stamped by this run (a never-read mint had 0, a uri-less one an older stamp); a failed call leaves its part unstamped.
      for (const m of todo) { const info = this.model.mint(m); if (info?.onchainAt > retryBefore) out.read++; if (info?.uri) out.withUri++; }
      out.ms = Date.now() - t0;
      this.state.mints.catchUpRead += out.read;
      this.state.mints.unread = unread.reduce((n, [m]) => n + (this.model.mint(m)?.onchainAt ? 0 : 1), 0);
      const line = `mints: catch-up: ${out.read}/${todo.length} read (${unread.length} never read, ${noUri.length} without a uri), ${out.withUri} with a uri, ${out.metaplex} via Metaplex, in ${out.ms} ms`;
      if (error) this.log.warn(`${line}; stopped: ${error.message}`); else this.log.info(line);
      return out;
    });
  }

  /**
   * Canonical pool, vault addresses and the pool's signed `virtual_quote_reserves` for migrated coins (the
   * price and locked source after graduation), then their vault balances. A coin whose pool is already
   * known but whose virtual quote was never read (rows written before it priced the pool) is read straight
   * from its pool account. Returns `{ coins, read, vqNonZero, vqNegative }`.
   */
  async ensurePools(only = null, { rpc = this.rpc } = {}) {
    const coins = [...(only ?? this.model.coins.values())].filter((c) => c.migrated && (!c.poolQuoteVault || c.poolVirtualQuote == null));
    const n = { coins: coins.length, read: 0, vqNonZero: 0, vqNegative: 0 };
    for (const part of chunks(coins, 100)) {
      const pools = part.map((c) => c.pool ?? canonicalPumpPoolPdaWithQuote(pk(c.mint), normalizeQuoteMint(c.quoteMint ? pk(c.quoteMint) : null)).toBase58());
      const infos = await rpc.getMultipleAccounts(pools);
      infos.forEach((info, i) => {
        const p = info ? decodePool(info.data) : null;
        if (!p) return;
        n.read++;
        const vq = BigInt(p.virtualQuoteReserves);
        if (vq !== 0n) n.vqNonZero++;
        if (vq < 0n) n.vqNegative++;
        this.model.upsertCoin({ mint: part[i].mint, pool: pools[i], poolBaseVault: p.baseVault, poolQuoteVault: p.quoteVault, poolVirtualQuote: p.virtualQuoteReserves });
      });
    }
    // The pool accounts were just read: only the vault balances are left.
    await this.refreshVaults(coins.map((c) => this.model.get(c.mint)).filter((c) => c?.poolQuoteVault), { rpc, pools: false });
    if (only == null && coins.length) this.log.info(`pools: ${coins.length} migrated coins to read; ${n.read} pools read, vq != 0 ${n.vqNonZero}, vq < 0 ${n.vqNegative}`);
    this.state.pools = n;
    return n;
  }
  /** One pass of ensurePools over every coin (start-up backfill of the pool virtual quote); concurrent calls share it. */
  backfillPoolVq() {
    this.vqBackfill ??= this.ensurePools().catch((e) => { this.log.warn(`pools: ${e.message}`); return null; }).finally(() => { this.vqBackfill = null; });
    return this.vqBackfill;
  }
  /** Migrated coins whose pool prices tracked children (they are those children's quote mint), most children first. */
  pricingPools() {
    const out = [];
    for (const [mint, kids] of this.model.children) {
      if (!kids.size) continue;
      const c = this.model.get(mint);
      if (!c?.migrated || !c.poolBaseVault || !c.poolQuoteVault) continue;
      let n = 0;
      for (const m of kids) if (this.model.get(m)?.tracked) n++;
      if (n) out.push([c, n]);
    }
    return out.sort((a, b) => b[1] - a[1] || (a[0].mint < b[0].mint ? -1 : 1)).map(([c]) => c);
  }
  /** The next slice of pricingPools() for one refresh tick, sized so the whole set is re-read once per PRICING_POOL_MS. */
  pricingSlice() {
    const all = this.pricingPools();
    if (!all.length) return [];
    const n = Math.min(all.length, Math.max(20, Math.ceil(all.length * this.opts.refreshMs / PRICING_POOL_MS)));
    const at = this.pricingCursor % all.length;
    this.pricingCursor = (at + n) % all.length;
    return Array.from({ length: n }, (_, i) => all[(at + i) % all.length]);
  }
  /** One pass of refreshVaults over every pool that prices other coins (start-up, after the virtual-quote backfill). */
  async refreshPricingPools({ rpc = this.rpc } = {}) {
    const pools = this.pricingPools();
    if (!pools.length) return 0;
    await this.refreshVaults(pools, { rpc });
    this.state.pricingPoolsAt = nowS();
    this.log.info(`pools: ${pools.length} pricing pools re-read`);
    return pools.length;
  }
  /**
   * Vault balances of migrated coins and, with `pools` (the default), the pool account itself for its signed
   * `virtual_quote_reserves`, re-read every time (nothing proves it never changes): [pool, base vault, quote
   * vault] per coin, 33 coins (99 accounts) per call. A pool account that does not decode keeps the last value.
   */
  async refreshVaults(coins, { rpc = this.rpc, pools = true } = {}) {
    const withPool = coins.filter((c) => c.poolBaseVault && c.poolQuoteVault);
    for (const part of chunks(withPool, pools ? 33 : 50)) {
      const keys = [], at = [];
      for (const c of part) { at.push(keys.length); if (pools && c.pool) keys.push(c.pool); keys.push(c.poolBaseVault, c.poolQuoteVault); }
      const infos = await rpc.getMultipleAccounts(keys);
      part.forEach((c, i) => {
        let k = at[i];
        let p = null;
        if (pools && c.pool) { p = infos[k] ? decodePool(infos[k].data) : null; k++; }
        const base = infos[k] ? decodeTokenAccount(infos[k].data) : null, quote = infos[k + 1] ? decodeTokenAccount(infos[k + 1].data) : null;
        if (base && quote) this.model.upsertCoin({ mint: c.mint, poolBase: base.amount, poolQuote: quote.amount, ...(p ? { poolVirtualQuote: p.virtualQuoteReserves } : {}), refreshedAt: nowS() });
      });
    }
  }

  /** Fee-sharing configs (pump-fees) for depth ≥ 1 coins; re-read every 6 h, or now with `force`. */
  async ensureShares(only = null, { force = false } = {}) {
    // Children always; a root (depth 0) only when it can be one of ours: reported through /api/spawned
    // (feePaid set), listed or pending, or already carrying a config. Plain pump.fun roots never need it.
    const wants = (c) => c.depth >= 1 || c.feePaid != null || c.shares != null || this.model.isOurCoin(c);
    const coins = [...(only ?? this.model.coins.values())].filter((c) => wants(c) && (force || nowS() - (c.sharesAt ?? 0) > SHARES_TTL_S));
    for (const part of chunks(coins, 100)) {
      const infos = await this.rpc.getMultipleAccounts(part.map((c) => feeSharingConfigPda(pk(c.mint)).toBase58()));
      infos.forEach((info, i) => this.model.upsertCoin({ mint: part[i].mint, shares: info ? decodeShares(info.data) : null, sharesAt: nowS() }));
    }
    if (coins.length) this.model.sweepPending(); // a config naming the platform confirms a pending spawn
  }
  isYoung(c) { return c.createdAt != null && nowS() - c.createdAt < YOUNG_S; }

  /**
   * A spawn the API verified on-chain (POST /api/spawned, lib/spawned.mjs): insert it from its own
   * CreateEvent when given (roots included — the launch tab defaults to a SOL-quoted root, which the
   * live path ignores), make sure it is tracked, record the launch fee it paid, read its
   * fee-sharing config right away and keep it hot. Returns the coin, or null when the mint has no
   * bonding curve (yet): the pending flag still holds it in the feed for a few minutes. Only verified
   * spawns reach this method, which is what justifies tracking a coin on the caller's word.
   */
  async adopt(mint, { create = null, slot = null, feePaid = null } = {}) {
    if (create && create.mint === mint) this.#insertCreate(create, slot, feePaid != null ? { feePaid: String(feePaid) } : {});
    let c = this.model.get(mint);
    if (!c) { try { c = await this.fetchCoin(mint); } catch (e) { this.log.warn(`adopt ${mint}: ${e.message}`); } }
    if (!c) return null;
    if (!c.tracked || (feePaid != null && c.feePaid == null)) c = this.model.upsertCoin({ mint, tracked: true, createdAt: c.createdAt ?? nowS(), createdProbe: true, ...(feePaid != null ? { feePaid: String(feePaid) } : {}) });
    try { await this.#enrich(mint, c.quoteMint); } catch (e) { this.log.warn(`adopt ${mint}: ${e.message}`); }
    this.hot.add(mint);
    const fresh = this.model.get(mint);
    if (fresh && this.model.isOurCoin(fresh)) this.hub?.emit("coin", this.model.view(fresh, { all: true }));
    this.announcePair(mint);
    return fresh;
  }

  /**
   * Creation time for backfilled coins: the oldest signature on the curve. One call for a coin with
   * under 1 000 transactions; busier coins get up to three more pages, then give up (null stays).
   */
  async probeCreatedAt() {
    const todo = [...this.model.coins.values()].filter((c) => c.tracked && c.createdAt == null && !c.createdProbe)
      .sort((a, b) => b.depth - a.depth || Number(BigInt(b.realQuoteReserves)) - Number(BigInt(a.realQuoteReserves)));
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(2, todo.length) }, async () => {
      while (i < todo.length && !this.stopped) {
        const c = todo[i++];
        try {
          let before, oldest = null, pages = 0, full = true;
          while (full && pages < 4) {
            const sigs = await this.rpc.getSignaturesForAddress(c.curve, before ? { before } : {});
            pages++;
            if (sigs.length) { oldest = sigs[sigs.length - 1]; before = oldest.signature; }
            full = sigs.length >= 1000;
          }
          this.state.created.probed++;
          if (oldest && !full) { this.state.created.found++; this.model.upsertCoin({ mint: c.mint, createdAt: oldest.blockTime ?? null, createdSlot: oldest.slot ?? null, createdProbe: true }); }
          else this.model.upsertCoin({ mint: c.mint, createdProbe: true });
        } catch (e) { this.log.warn(`createdAt ${c.mint}: ${e.message}`); }
      }
    }));
    if (todo.length) this.log.info(`createdAt: ${this.state.created.found}/${todo.length} resolved`);
  }

  // ---------------------------------------------------------------- live
  onLogs({ slot, signature, err, logs }) {
    if (err) return;
    const events = eventsInLogs(logs, LIVE_EVENT_PROGRAMS);
    if (!events.length) return;
    events.forEach(({ name, data }, idx) => {
      try {
        if (name === "CreateEvent") this.#onCreate(decodeEvent(name, data), slot);
        else if (name === "TradeEvent") { if (this.model.coins.has(peekMint(data))) this.#onTrade(decodeEvent(name, data), signature, slot, idx); }
        else if (name === "CompleteEvent") { const e = decodeEvent(name, data); if (this.model.coins.has(e.mint)) this.#onComplete(e); }
        else if (name === "BuyEvent" || name === "SellEvent") { const e = decodeEvent(name, data); const mint = this.model.pools.get(e.pool); if (mint) this.#onPoolTrade(mint, e, signature, slot, idx); }
      } catch (e) { this.state.lastError = `${name}: ${e.message}`; }
    });
  }

  #onCreate(e, slot) { this.onCreate(e, slot); }
  /**
   * A CreateEvent from the live stream. Depth 0 coins are only interesting as parents, except a coin quoted
   * in a listed asset (USDC, MON, …): pump.fun counts it as a root, the map draws it under the asset's bubble
   * (model.assetFamilies), so it joins the tree like a spawn. A depth ≥ 1 coin is a spawn and joins the tree.
   */
  onCreate(e, slot) {
    const assetQuoted = e.depth < 1 && !!e.quoteMint && e.quoteMint !== SOL_MINT;
    if (e.depth < 1 && !assetQuoted) return;
    this.#insertCreate(e, slot);
    // The map hears about the pair at once when the parent is already tracked (both modes), and
    // after the parent chain is pulled otherwise (announcePair dedupes the second try).
    this.announcePair(e.mint);
    // In "ours" mode a spawn is announced only once its sharing config names the platform (or the
    // UI reported it); the config lands in the same transaction, so it is read right away.
    const emit = () => { const c = this.model.get(e.mint); if (c && (this.model.mode === "all" || this.model.isOurCoin(c))) this.hub?.emit("coin", this.model.view(c, { all: true })); this.announcePair(e.mint); };
    this.#enrich(e.mint, e.quoteMint).catch((x) => this.log.warn(`create ${e.mint}: ${x.message}`)).finally(emit);
    this.log.info(`live: spawn ${e.symbol} (${e.mint}) depth ${e.depth} under ${e.quoteMint ?? "SOL"}`);
  }
  /** The coin a CreateEvent describes, straight into the tree (no RPC): curve state at creation, mint data, metadata queued. */
  #insertCreate(e, slot, extra = {}) {
    const quoted = e.virtualQuoteReserves !== "0";
    this.model.upsertCoin({
      mint: e.mint, curve: e.bondingCurve, depth: e.depth, quoteMint: e.quoteMint, creator: e.creator, tracked: true,
      virtualTokenReserves: e.virtualTokenReserves, virtualQuoteReserves: quoted ? e.virtualQuoteReserves : e.virtualSolReserves,
      realTokenReserves: e.realTokenReserves, realQuoteReserves: "0", tokenTotalSupply: e.tokenTotalSupply, initialVirtualQuoteReserves: quoted ? e.virtualQuoteReserves : e.virtualSolReserves,
      complete: false, migrated: false, mayhem: !!e.isMayhemMode, holderReward: !!e.isHolderReward, creatorFeeBps: e.creatorFeeBps,
      createdAt: e.timestamp, createdSlot: slot ?? null, createdProbe: true, ...extra,
    });
    this.model.setMint({ mint: e.mint, decimals: 6, tokenProgram: e.tokenProgram, name: e.name || null, symbol: e.symbol || null, uri: e.uri || null, onchainAt: nowS() });
    if (e.uri) this.meta?.request(e.uri, { front: true });
    this.hot.add(e.mint);
  }
  /** Unknown parent (a depth-0 coin that just became one): pull its chain; then mint data and the sharing config of the coin itself. */
  async #enrich(mint, quoteMint) {
    if (quoteMint && !this.model.coins.has(quoteMint) && !this.#isListedQuote(quoteMint)) await this.ensureAncestors();
    // A parent that was only looked at on demand (untracked, memory only) is a parent now: it
    // joins the tree so the map and the leaderboard can draw the pair.
    const parent = quoteMint ? this.model.get(quoteMint) : null;
    if (parent && !parent.tracked) this.model.upsertCoin({ mint: quoteMint, tracked: true });
    const self = [this.model.get(mint)].filter(Boolean);
    await this.ensureMintInfo(self);
    await this.ensureShares(self, { force: true });
  }

  #onTrade(e, sig, slot, idx) {
    const coin = this.model.get(e.mint);
    if (!coin || coin.migrated) return;
    const c = this.model.upsertCoin({ mint: e.mint, virtualQuoteReserves: e.virtualQuoteReserves, virtualTokenReserves: e.virtualTokenReserves, realQuoteReserves: e.realQuoteReserves, realTokenReserves: e.realTokenReserves });
    const baseDecimals = this.model.decimalsOf(c.mint), quoteDecimals = this.model.quoteDecimals(c);
    const priceQuote = curvePriceQuote(c, baseDecimals, quoteDecimals) ?? (units(e.quoteAmount, quoteDecimals) / Math.max(units(e.tokenAmount, baseDecimals), 1e-12));
    this.#recordTrade(c, { sig, idx, slot: slot ?? 0, time: e.timestamp || nowS(), isBuy: e.isBuy, user: e.user, baseAmount: e.tokenAmount, quoteAmount: e.quoteAmount, priceQuote });
  }
  #onPoolTrade(mint, e, sig, slot, idx) {
    const c = this.model.upsertCoin({ mint, poolBase: e.poolBaseReserves, poolQuote: e.poolQuoteReserves });
    const baseDecimals = this.model.decimalsOf(mint), quoteDecimals = this.model.quoteDecimals(c);
    const priceQuote = poolPriceQuote(e.poolQuoteReserves, e.poolBaseReserves, baseDecimals, quoteDecimals, c.poolVirtualQuote);
    if (priceQuote == null) return;
    this.#recordTrade(c, { sig, idx, slot: slot ?? 0, time: e.timestamp || nowS(), isBuy: e.isBuy, user: e.user, baseAmount: e.baseAmount, quoteAmount: e.quoteAmount, priceQuote });
  }
  #recordTrade(c, t) {
    // One coin's chain, not the whole forest: the upsert just bumped the version, and a full
    // recompute per trade (≈ 90 ms at 15k coins) would eat the live path.
    const d = this.model.priceOf(c.mint);
    const quoteUsd = this.#quoteUsd(c);
    const trade = { ...t, mint: c.mint, priceUsd: d?.priceUsd ?? null, valueUsd: quoteUsd != null ? units(t.quoteAmount, this.model.quoteDecimals(c)) * quoteUsd : null };
    this.model.recordTrade(trade);
    this.hot.add(c.mint);
    this.hub?.emit("trade", { sig: trade.sig, mint: trade.mint, slot: trade.slot, time: trade.time, isBuy: trade.isBuy, user: trade.user, baseAmount: trade.baseAmount, quoteAmount: trade.quoteAmount, priceQuote: trade.priceQuote, priceUsd: trade.priceUsd, valueUsd: trade.valueUsd });
  }
  #quoteUsd(c) { return this.model.quoteUsdOf(c.quoteMint); }
  #onComplete(e) {
    const c = this.model.upsertCoin({ mint: e.mint, complete: true });
    this.hot.add(e.mint);
    this.hub?.emit("coin", this.model.view(c, { all: true }));
    this.log.info(`live: ${e.mint} completed its curve`);
  }

  // ---------------------------------------------------------------- refresh loop
  /**
   * One tick: hot coins (live activity or API views in the last two minutes) plus a rolling slice
   * of every tracked coin sized so the whole set is re-read once per `fullRefreshMs`. Curves come
   * from one getMultipleAccounts per 100; migrated coins also get their vault balances.
   */
  async refresh({ reason = "tick" } = {}) {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const all = this.model.tracked();
      if (!this.cursorRestored && all.length) this.#restoreCursor(all);
      const perTick = Math.max(50, Math.ceil(all.length * this.opts.refreshMs / this.opts.fullRefreshMs));
      const slice = all.length ? Array.from({ length: Math.min(perTick, all.length) }, (_, i) => all[(this.cursor + i) % all.length]) : [];
      this.cursor = all.length ? (this.cursor + slice.length) % all.length : 0;
      if (all.length) this.#saveCursor(all);
      const recent = Date.now() - 120_000;
      // Views older than the hot window are dead weight; on-demand coins nobody looks at any more leave memory.
      this.model.pruneTouched(120_000);
      this.model.evictUntracked();
      // Hot = live activity, recent API views, spawns the UI reported (pending "ours") and young coins:
      // all of them get their curve and sharing config re-read every tick.
      const hotMints = new Set([...this.hot, ...[...this.model.touched].filter(([, t]) => t > recent).map(([m]) => m), ...this.model.pendingMints()]);
      this.hot.clear();
      for (const c of all) if (this.isYoung(c)) hotMints.add(c.mint);
      const set = new Map(slice.map((c) => [c.mint, c]));
      for (const m of hotMints) { const c = this.model.get(m); if (c) set.set(m, c); }
      const coins = [...set.values()];
      if (!coins.length) return;
      const newlyMigrated = new Set();
      for (const part of chunks(coins, 100)) {
        const infos = await this.rpc.getMultipleAccounts(part.map((c) => c.curve));
        infos.forEach((info, i) => {
          if (!info) return;
          try {
            const cur = decodeCurve(info.data, part[i].curve);
            const wasMigrated = part[i].migrated;
            this.model.upsertCoin({ mint: part[i].mint, ...cur, refreshedAt: nowS() });
            if (cur.migrated && !wasMigrated) newlyMigrated.add(part[i].mint);
          } catch { /* account changed type; keep the last state */ }
        });
      }
      // Re-read the model: the objects in `coins` predate the upserts above.
      const fresh = coins.map((c) => this.model.get(c.mint)).filter(Boolean);
      await this.ensurePools(fresh.filter((c) => newlyMigrated.has(c.mint) || (c.migrated && !c.poolQuoteVault)));
      const vaults = new Map(fresh.filter((c) => c.migrated && c.poolQuoteVault && !newlyMigrated.has(c.mint)).map((c) => [c.mint, c]));
      for (const c of this.pricingSlice()) if (!newlyMigrated.has(c.mint)) vaults.set(c.mint, c);
      await this.refreshVaults([...vaults.values()]);
      this.state.lastVaultsAt = nowS();
      await this.ensureMintInfo(fresh);
      await this.ensureShares(fresh.filter((c) => hotMints.has(c.mint) || nowS() - (c.sharesAt ?? 0) > SHARES_TTL_S), { force: true });
      for (const c of coins) { const uri = this.model.mint(c.mint)?.uri; if (uri) this.meta?.request(uri, { front: hotMints.has(c.mint) }); }
      this.state.lastRefreshAt = nowS();
      this.hub?.emit("stats", this.model.stats());
    } finally { this.refreshing = false; }
  }
  /**
   * The cursor the last run saved: the index of the mint it would have refreshed next when that mint is
   * still listed (coins added or evicted before it shift indexes), else the saved index when it is still
   * inside the list, else 0 (the list got shorter: a new pass). model.tracked() keeps the db's row order
   * across restarts, so the index alone is a good fallback. Once per Indexer, on the first non-empty list.
   */
  #restoreCursor(all) {
    this.cursorRestored = true;
    try {
      const saved = this.model.db.backfillGet(REFRESH_CURSOR_KEY, null);
      if (!saved || typeof saved !== "object") return;
      const at = typeof saved.mint === "string" ? all.findIndex((c) => c.mint === saved.mint) : -1;
      this.cursor = at >= 0 ? at : Number.isInteger(saved.i) && saved.i >= 0 && saved.i < all.length ? saved.i : 0;
    } catch (e) { this.log.warn(`refresh: cursor not restored: ${e.message}`); }
  }
  /** One small row per tick (backfill_state, like the scan stamps): the index and the mint the next tick starts at. */
  #saveCursor(all) {
    try { this.model.db.backfillSet(REFRESH_CURSOR_KEY, { i: this.cursor, mint: all[this.cursor]?.mint ?? null }); } catch { /* a lost cursor only means a pass restarts at 0 */ }
  }

  // ---------------------------------------------------------------- on-demand (API)
  /**
   * Live curve state for one mint (used by eligibility and unknown-coin lookups); null when it is
   * not a pump coin. `rpc` lets request-driven callers use the "api" lane. The verdict is remembered
   * for a minute: a positive one serves the model's copy, a negative one answers without the chain.
   */
  async fetchCoin(mint, { rpc = this.rpc } = {}) {
    const hit = this.fetchCache.get(mint);
    if (hit && Date.now() - hit.at < FETCH_CACHE_MS) {
      if (!hit.found) return null;
      const cached = this.model.get(mint);
      if (cached) return cached;
    }
    const result = await this.#fetchCoin(mint, rpc);
    this.fetchCache.set(mint, { at: Date.now(), found: !!result });
    if (this.fetchCache.size > FETCH_CACHE_MAX) this.fetchCache.delete(this.fetchCache.keys().next().value);
    return result;
  }
  async #fetchCoin(mint, rpc) {
    const curveKey = bondingCurvePda(mint).toBase58();
    const [info, mintInfo] = await rpc.getMultipleAccounts([curveKey, mint]);
    if (!info || info.owner !== PUMP_PROGRAM_ID.toBase58()) return null;
    const cur = decodeCurve(info.data, curveKey);
    const m = mintInfo ? decodeMint(mintInfo.data, mintInfo.owner) : null;
    if (m) this.model.setMint({ mint, decimals: m.decimals, tokenProgram: m.tokenProgram, supply: m.supply, ...(m.metadata ?? {}), onchainAt: m.metadata ? nowS() : 0 });
    const known = this.model.get(mint);
    // A coin we did not track yet (a depth-0 coin without children) is kept untracked: it shows on its
    // own page and in eligibility but stays out of the feed and the leaderboard until it has a child.
    const c = this.model.upsertCoin({ mint, ...cur, tracked: known ? known.tracked : false, refreshedAt: nowS() });
    if (c.quoteMint && !this.model.coins.has(c.quoteMint) && !this.#isListedQuote(c.quoteMint)) await this.ensureAncestors({ rpc });
    if (!m?.metadata) await this.ensureMintInfo([c], { rpc });
    if (c.migrated && !c.poolQuoteVault) await this.ensurePools([c], { rpc }); else if (c.migrated) await this.refreshVaults([c], { rpc });
    return this.model.get(mint);
  }
}

/** base58 of raw bytes for memcmp filters (bs58 is a transitive dependency; a tiny encoder avoids relying on it). */
export function bs58(buf) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of buf) n = n * 256n + BigInt(b);
  let out = ""; while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = "1" + out; }
  return out;
}
/** The `mint` field of a TradeEvent is its first field: 32 bytes after the discriminator. */
export const peekMint = (data) => new PublicKey(data.subarray(8, 40)).toBase58();
