// Holder facts (the `safety` of a Discover coin row, lib/coinrows.mjs): how much of a coin's supply its creator holds
// now (`devPct`) and the 10 largest holders hold (`top10Pct`, the bonding curve's and the pool's vault left out: they
// hold the unsold supply, not a holder). Stated as measured numbers; the page colours one at most, above a threshold
// it names. Read from the chain, so bounded on every side (the server has a history of event-loop freezes and the RPC
// is shared with the indexer):
// - only for coins a list actually shows (lib/coinrows.mjs asks per row it builds; nothing walks the index);
// - one coin at a time, at most HOLDERS_PER_MIN calls in any 60 s. At 2-3 calls a coin that is about 10-15 coins a
//   minute, often fewer than the lists show, so the waiting is ordered: first reads (a coin never read, a row new to a
//   list) go before refreshes (a coin read before), and a wish whose coin nobody asked for again within the TTL (it
//   left every list) is let go unread. At most HOLDERS_QUEUE_MAX wait, about what the cap reads in one TTL; past that a
//   refresh makes room for a first read, else the new wish is refused (its row asks again on its next build). Never
//   the oldest wish: every build asks the top rows first, so dropping the oldest starved exactly the rows people see;
// - on the RPC's "holders" lane (RPC_URL only, never the metered user endpoint: these reads repeat every 5 min per
//   listed coin while someone has Discover open, and would spend the day's credits that visitors' lookups need);
// - cached HOLDERS_TTL_MS per coin, at most HOLDERS_CACHE_MAX coins. A stale answer is served while its refresh waits,
//   up to twice the TTL old; older it says "pending" again (a dev who sold out 20 min ago must not read as holding
//   now). A failed read answers "unknown" and is tried again after HOLDERS_FAIL_MS.
// A coin costs 2 calls (getTokenLargestAccounts, then the owners of those 20 accounts via getMultipleAccounts with a
// 32-byte data slice), plus 1 (getTokenAccountsByOwner of the creator for this mint) when the creator is not among
// the 20 largest. Until its first read a row says `state: "pending"`.
import { PublicKey } from "./sdk.mjs";

/** Cache life (ms), calls per 60 s, coins waiting at most, coins cached at most, the wait after a failed read (ms). */
export const HOLDERS_TTL_MS = 5 * 60_000, HOLDERS_PER_MIN = 30, HOLDERS_QUEUE_MAX = 75, HOLDERS_CACHE_MAX = 2_000, HOLDERS_FAIL_MS = 2 * 60_000;
/** Holders summed in top10Pct; the most calls one coin costs (what must fit in the minute before it starts). */
export const TOP_N = 10, CALLS_MAX = 3;

const r1 = (x) => Math.round(x * 10) / 10;
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
/** A share of `supply` in percent, 1 dp (in BigInt to 1e-4 first: supplies are 1e15 raw units, past a double's exact range). */
const pct = (amt, supply) => (supply > 0n ? r1(Number((amt * 1_000_000n) / supply) / 10_000) : null);

export class Holders {
  /** `rpc`: a client (its "holders" lane) with `call(method, params)`; `model` for coins and creators; `now` in ms; `timers` for tests. */
  constructor({ model, rpc = null, now = Date.now, log = console, perMin = HOLDERS_PER_MIN, ttlMs = HOLDERS_TTL_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.model = model; this.rpc = rpc; this.now = now; this.log = log; this.perMin = perMin; this.ttlMs = ttlMs;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.cache = new Map();  // mint → { at (the read's time), next (ms: when it is queued again), ok, devPct, top10Pct }, oldest first
    // Mints waiting → when a row last asked for them (ms), oldest wish first: those with no read yet, and stale ones.
    this.first = new Map(); this.refresh = new Map();
    this.calls = [];         // times (ms) of the calls of the last 60 s, oldest first
    this.running = null; this.timer = null; this.stopped = false;
    this.stats = { asked: 0, queued: 0, dropped: 0, refused: 0, unasked: 0, reads: 0, ok: 0, failed: 0, calls: 0, capWaits: 0, lastError: null };
  }
  stop() { this.stopped = true; if (this.timer) { this.clearTimer(this.timer); this.timer = null; } }
  snapshot() { return { lane: "holders", perMin: this.perMin, cached: this.cache.size, queue: this.first.size + this.refresh.size, queueFirst: this.first.size, running: !!this.running, callsLastMin: this.#recent(), ...this.stats }; }

  /**
   * `{ devPct, top10Pct, state }` for coin `c` now, never waiting: "ok" with the cached read while it is under twice
   * the TTL old (a stale one queues its refresh), "pending" with nulls while its first read waits or the last read got
   * too old, "unknown" with nulls after a failed read (tried again after HOLDERS_FAIL_MS) or for a coin that cannot be
   * read (no RPC, no supply).
   */
  get(c) {
    this.stats.asked++;
    const none = (state) => ({ devPct: null, top10Pct: null, state });
    if (!this.rpc || !c?.mint || !(big(c.tokenTotalSupply) > 0n)) return none("unknown");
    const hit = this.cache.get(c.mint), t = this.now();
    if (!hit) { this.#want(c.mint, this.first, t); return none("pending"); }
    // Read before: it waits with the refreshes in its place, also once too old to show (when the lists want more coins
    // than the cap reads, the refreshes go round in turn; a coin never read still goes first).
    if (t >= hit.next) this.#want(c.mint, this.refresh, t);
    if (hit.ok) return t - hit.at <= 2 * this.ttlMs ? { devPct: hit.devPct, top10Pct: hit.top10Pct, state: "ok" } : none("pending");
    return none("unknown");
  }

  /** Queues `mint` in `q` (first reads or refreshes), or notes the newer ask of one already waiting (its place kept). */
  #want(mint, q, t) {
    if (this.stopped || this.running === mint) return;
    if (q.has(mint)) { q.set(mint, t); return; }
    (q === this.first ? this.refresh : this.first).delete(mint); // one place each (a cache entry let go while waiting)
    if (this.first.size + this.refresh.size >= HOLDERS_QUEUE_MAX) {
      this.#dropUnasked(this.first, t); this.#dropUnasked(this.refresh, t);
      if (this.first.size + this.refresh.size >= HOLDERS_QUEUE_MAX) {
        // A row with numbers can wait for them; one with none cannot: a refresh gives up its place, else no room.
        if (q === this.first && this.refresh.size) { this.refresh.delete(this.refresh.keys().next().value); this.stats.dropped++; }
        else { this.stats.refused++; return; }
      }
    }
    q.set(mint, t); this.stats.queued++;
    this.#pump();
  }
  /** Lets go the wishes at `q`'s head that nobody asked for again within the TTL (O(1) per wish, each let go once). */
  #dropUnasked(q, t) {
    for (const [m, at] of q) { if (t - at <= this.ttlMs) break; q.delete(m); this.stats.unasked++; }
  }
  /** Calls made in the last 60 s (the window's old ones let go). */
  #recent() { const cut = this.now() - 60_000; while (this.calls.length && this.calls[0] <= cut) this.calls.shift(); return this.calls.length; }

  /** Starts the next read when none runs and CALLS_MAX more calls fit in the minute; otherwise waits for the oldest call to leave it. */
  #pump() {
    const t = this.now();
    this.#dropUnasked(this.first, t); this.#dropUnasked(this.refresh, t);
    if (this.running || this.timer || this.stopped || !(this.first.size + this.refresh.size)) return;
    if (this.#recent() + CALLS_MAX > this.perMin) {
      this.stats.capWaits++;
      const wait = this.calls.length ? Math.max(50, this.calls[0] + 60_000 - this.now() + 10) : 60_000; // none in the minute: a cap under CALLS_MAX (tests)
      this.timer = this.setTimer(() => { this.timer = null; this.#pump(); }, wait);
      this.timer?.unref?.();
      return;
    }
    const q = this.first.size ? this.first : this.refresh, mint = q.keys().next().value;
    q.delete(mint);
    this.running = mint;
    this.done = this.#read(mint).finally(() => { this.running = null; this.#pump(); });
  }
  /** Resolves once the queue is empty or waiting on the minute's cap (tests). */
  async settle() { while (this.running) await this.done; }

  async #call(method, params) {
    this.calls.push(this.now()); this.stats.calls++;
    return this.rpc.call(method, params);
  }

  /** One coin's read (2-3 calls); the answer, or the failure, goes to the cache. */
  async #read(mint) {
    this.stats.reads++;
    const c = this.model.coins.get(mint);
    const supply = big(c?.tokenTotalSupply);
    let entry;
    try {
      if (!c || !(supply > 0n)) throw new Error("no supply known");
      const L = await this.#call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
      const list = (L?.value ?? []).filter((x) => typeof x?.address === "string").map((x) => ({ address: x.address, amount: big(x.amount) }));
      let owners = [];
      if (list.length) {
        const r = await this.#call("getMultipleAccounts", [list.map((x) => x.address), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 32, length: 32 } }]);
        owners = (r?.value ?? []).map((v) => { try { const b = Buffer.from(v.data[0], "base64"); return b.length === 32 ? new PublicKey(b).toBase58() : null; } catch { return null; } });
      }
      // The curve's and the pool's vaults hold the supply nobody bought: owned by the curve and the pool accounts.
      const skipOwner = new Set([c.curve, c.pool].filter(Boolean)), skipAddr = new Set([c.poolBaseVault].filter(Boolean));
      const byOwner = new Map();
      list.forEach((x, i) => {
        const o = owners[i] ?? `?${x.address}`; // an account whose owner did not read counts as its own holder
        if (skipOwner.has(o) || skipAddr.has(x.address)) return;
        byOwner.set(o, (byOwner.get(o) ?? 0n) + x.amount);
      });
      const top = [...byOwner.values()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, TOP_N).reduce((s, v) => s + v, 0n);
      const key = this.model.creatorKey?.(c) ?? null;
      let dev = null;
      if (key) {
        if (byOwner.has(key)) dev = byOwner.get(key);
        else {
          const r = await this.#call("getTokenAccountsByOwner", [key, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
          dev = (r?.value ?? []).reduce((s, x) => s + big(x?.account?.data?.parsed?.info?.tokenAmount?.amount), 0n);
        }
      }
      entry = { at: this.now(), next: this.now() + this.ttlMs, ok: true, devPct: dev == null ? null : pct(dev, supply), top10Pct: pct(top, supply) };
      this.stats.ok++;
    } catch (e) {
      this.stats.failed++; this.stats.lastError = String(e?.message ?? e).slice(0, 160);
      const old = this.cache.get(mint);
      // A refresh that failed keeps the last good read while it is under twice its age limit (then "unknown").
      const next = this.now() + HOLDERS_FAIL_MS;
      entry = old?.ok && this.now() - old.at < 2 * this.ttlMs ? { ...old, next } : { at: this.now(), next, ok: false, devPct: null, top10Pct: null };
    }
    this.cache.delete(mint); this.cache.set(mint, entry);
    while (this.cache.size > HOLDERS_CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
  }
}
