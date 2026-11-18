// Discover (GET /api/discover): the parents coins are being launched under right now. A parent is a mint coins are
// priced in (a coin or a listed asset, never SOL); it is listed when two or more of its tracked direct children were
// created in the last hour by two or more launch addresses, so one address spamming launches lists nothing. That is a
// known limit, not a defence: one throwaway second address passes the gate, and the order is the raw launch count
// (README §API). The body counts launches and says what those new coins traded; it says nothing about why, and
// nothing here is a recommendation.
// One pass over the model's by-time index of new coins (model.recentCoins: only the last hours' coins, never the whole
// model), in slices on the shared scheduler (lib/sliced.mjs), shared by the askers that come together and served for
// DISCOVER_TTL_MS.
import { SOL_MINT } from "./jupiter.mjs";
import { imageProxyUrl } from "./meta.mjs";
import { runSliced } from "./sliced.mjs";

/** The window launches are counted in, and the width of one of its bins (s). */
export const WINDOW_S = 3600, BIN_S = 300;
/** A body is served this long; at most this many parents, each with this many of its new coins. */
export const DISCOVER_TTL_MS = 10_000, PARENTS_MAX = 20, TOP_MAX = 2;
/** A parent needs this many new coins and this many distinct launch addresses behind them. */
export const MIN_NEW = 2, MIN_CREATORS = 2;
/** A creation time this far ahead of our clock still counts as now (block time against the server's clock); further ahead is left out. */
const AHEAD_S = 60;
const BINS = WINDOW_S / BIN_S;

const round2 = (x) => Math.round(x * 100) / 100;
/** Best first among one parent's new coins: 24 h volume, then the newest, then the mint. */
const byVolume = (a, b) => b.usd - a.usd || b.at - a.at || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);

export class Discover {
  /** `model`: the index; `now` in ms. */
  constructor({ model, now = Date.now } = {}) {
    this.model = model; this.now = now;
    this.hit = null; // { at (ms), body }
    this.job = null; // the pass under way (askers share it)
    this.stats = { builds: 0, lastBuildMs: null, maxSliceMs: 0, served: 0, lastCoins: null, lastParents: null };
  }
  snapshot() { return { ...this.stats }; }

  /** The body of GET /api/discover (README §API): the cached one while it is under DISCOVER_TTL_MS old, else one pass that every asker waiting for it shares. */
  async serve() {
    this.stats.served++;
    const hit = this.hit;
    if (hit && this.now() - hit.at < DISCOVER_TTL_MS) return hit.body;
    if (!this.job) {
      this.job = runSliced(this.#buildGen()).then((run) => {
        this.stats.builds++; this.stats.lastBuildMs = round2(run.cpuMs);
        if (run.maxSliceMs > this.stats.maxSliceMs) this.stats.maxSliceMs = round2(run.maxSliceMs);
        this.hit = run.value;
        return run.value.body;
      }).finally(() => { this.job = null; });
    }
    return this.job;
  }

  /** The pass, in steps: a yield every 512 new coins, every 1 024 parents, and before the listed parents' refs are made. */
  *#buildGen() {
    const model = this.model, nowMs = this.now(), asOf = Math.floor(nowMs / 1000), vol = model.volumes();
    const parents = new Map(); // parent mint → { mint, n, keys, bins, usd, top }
    let seen = 0, n = 0;
    for (const c of model.recentCoins(asOf - WINDOW_S)) {
      if ((++seen & 511) === 0) yield;
      const p = c.quoteMint;
      if (!p || p === SOL_MINT || !c.tracked || c.createdAt == null) continue;
      // The window is (asOf − WINDOW_S, asOf]: a coin exactly an hour old has left it. Bins are counted back from
      // now, so the last one is always the most recent BIN_S seconds.
      const age = Math.max(0, asOf - c.createdAt);
      if (age >= WINDOW_S || c.createdAt - asOf > AHEAD_S) continue;
      let e = parents.get(p);
      if (!e) parents.set(p, e = { mint: p, n: 0, keys: new Set(), bins: new Array(BINS).fill(0), usd: 0, top: [] });
      const usd = vol.get(c.mint)?.usd;
      const u = Number.isFinite(usd) && usd > 0 ? usd : 0;
      e.n++; e.keys.add(model.creatorKey(c)); // null stands for every coin without a known address: one creator together
      e.bins[BINS - 1 - Math.floor(age / BIN_S)]++; e.usd += u;
      if (round2(u) > 0) { // a coin whose volume would read 0.00 is not shown as traded
        const m = { mint: c.mint, usd: u, at: c.createdAt };
        if (e.top.length < TOP_MAX || byVolume(m, e.top[TOP_MAX - 1]) < 0) { e.top.push(m); e.top.sort(byVolume); if (e.top.length > TOP_MAX) e.top.length = TOP_MAX; }
      }
      n++;
    }
    yield;
    const listed = [];
    seen = 0;
    for (const e of parents.values()) {
      if ((++seen & 1023) === 0) yield;
      if (e.n >= MIN_NEW && e.keys.size >= MIN_CREATORS) listed.push(e);
    }
    listed.sort((a, b) => b.n - a.n || round2(b.usd) - round2(a.usd) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    yield;
    const out = listed.slice(0, PARENTS_MAX).map((e) => {
      const { name, symbol } = model.nameOf(e.mint);
      return {
        mint: e.mint, name, symbol, image: imageProxyUrl(model.imageOfMint(e.mint)),
        new1h: e.n, creators1h: e.keys.size, bins: e.bins, usd24: round2(e.usd),
        top: e.top.map((t) => { const r = model.ref(model.get(t.mint)); return { mint: r.mint, name: r.name, symbol: r.symbol, image: r.image, usd24: round2(t.usd) }; }),
      };
    });
    this.stats.lastCoins = n; this.stats.lastParents = listed.length;
    return { at: nowMs, body: { asOf, windowS: WINDOW_S, binS: BIN_S, parents: out } };
  }
}
