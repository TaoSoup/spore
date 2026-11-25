// The trending gate (Discover's "show every coin that meets the attention rules"): the indexer keeps only coins in the
// tree and drops plain SOL-paired launches with no family (lib/indexer.mjs onCreate). The gate watches each dropped
// launch for its first minutes from the curve stream alone (its CreateEvent and TradeEvents, no RPC) and decides
// whether it has drawn real buyers, by the merged Fable spec (local research, Nov 24: "counted buyers", capped inflow and
// four demote checks). A launch that passes is handed to `onPass` with everything seen so far, so the indexer can insert
// it as if it had been tracked from its create (its trades included). The main thresholds are settings (TREND_GATE_*,
// lib/config.mjs), so the measured scores can set them without a code change. Facts only: passing means "real wallets bought it", never "good".
//
// Counted buyer, per coin, over the window from the create:
//  - net buys of at least minNetSol (SOL);
//  - not the creator;
//  - no buy in the create slot or the next `earlySlots` slots, and (optionally) no first buy in the first `earlyAfterS`
//    seconds (bundles land just past the slot rule: the first live check showed passes ~6 s after launch);
//  - at most maxTradesPerWallet trades on the coin;
//  - did not sell back flipShare or more of the SOL it bought within flipS seconds of its first buy, within that time
//    (once a flip, always a flip);
//  - did not first-buy sprayCoins or more distinct watched coins in the sprayS before its first buy here (spray bots).
// Pass: counted >= minCounted and capped inflow (sum of min(net, capSol)) >= minInflowSol within windowS, with none of the
// demote checks failing: trades per wallet > tpw, two-sided wallets share > two, the most common buy size's share of buys
// > uni (0.01 SOL rounding), the largest counted inflow's share > conc.
// Pure apart from the clock it is given; no sqlite, no network.

export const GATE_DEFAULTS = Object.freeze({
  windowS: 600, minCounted: 12, minInflowSol: 3,
  minNetSol: 0.05, earlySlots: 3, earlyAfterS: 0, maxTradesPerWallet: 10, flipShare: 0.8, flipS: 120, sprayCoins: 20, sprayS: 3600, capSol: 3,
  tpw: 6, two: 0.5, uni: 0.3, conc: 0.4,
  /** Launches watched at once (the oldest is dropped past it), trades kept per launch for the promotion. */
  maxWatched: 4000, maxTrades: 5000,
});

const LAMPORTS = 1e9;

export class TrendGate {
  /** `cfg`: GATE_DEFAULTS overrides; `onPass(cand, why)`: a launch passed; `now()`: ms. */
  constructor({ cfg = {}, onPass = () => {}, now = Date.now } = {}) {
    this.cfg = { ...GATE_DEFAULTS, ...cfg };
    this.onPass = onPass; this.now = now;
    this.watched = new Map(); // mint → candidate, in create order
    this.firstBuys = new Map(); // wallet → first-buy times (s) of watched coins, oldest first (the spray rule)
    this.stats = { watched: 0, passed: 0, expired: 0, dropped: 0, full: 0, trades: 0, lastPass: null };
  }

  /** A dropped launch's CreateEvent (decoded) and its slot: watched from now on. */
  create(e, slot) {
    if (!e?.mint || this.watched.has(e.mint)) return;
    this.watched.set(e.mint, { mint: e.mint, create: e, slot: slot ?? null, t: Number(e.timestamp) || Math.floor(this.now() / 1000), trades: [], last: null, full: false, w: new Map(), nTrades: 0, nBuys: 0, two: 0, sizes: new Map(), topSize: 0, counted: 0, inflow: 0, done: false });
    this.stats.watched++;
    while (this.watched.size > this.cfg.maxWatched) { const k = this.watched.keys().next().value; this.watched.delete(k); this.stats.dropped++; }
  }

  /** Whether `mint` is being watched (the indexer decodes a TradeEvent only for these and tracked coins). */
  has(mint) { return this.watched.has(mint); }

  /** A curve TradeEvent (decoded) of a watched launch, with its signature, slot and index in the transaction. */
  trade(e, sig, slot, idx) {
    const c = this.watched.get(e?.mint);
    if (!c || c.done) return;
    const cfg = this.cfg, t = Number(e.timestamp) || Math.floor(this.now() / 1000);
    this.stats.trades++;
    c.last = e;
    if (c.trades.length >= cfg.maxTrades) { if (!c.full) { c.full = true; this.stats.full++; } return; }
    c.trades.push({ e, sig, slot: slot ?? null, idx });
    if (t - c.t > cfg.windowS) return; // past the window: kept for the record, not counted
    c.nTrades++;
    let x = c.w.get(e.user);
    if (!x) c.w.set(e.user, x = { buy: 0, sell: 0, n: 0, first: null, early: false, spray: false, flip: 0, flipBuy: 0, flipped: false, b: false, s: false, k: -1 });
    const wasTwo = x.b && x.s;
    x.n++;
    const q = Number(e.quoteAmount) / LAMPORTS;
    if (e.isBuy) {
      x.buy += q; x.b = true;
      if (x.first == null) {
        x.first = t; x.spray = this.#spray(e.user, t);
        if ((c.slot != null && slot != null && slot <= c.slot + cfg.earlySlots) || (cfg.earlyAfterS > 0 && t - c.t < cfg.earlyAfterS)) x.early = true;
      }
      if (t - x.first <= cfg.flipS) x.flipBuy += q;
      c.nBuys++;
      const k = Math.round(Number(e.quoteAmount) / 1e7), v = (c.sizes.get(k) ?? 0) + 1;
      c.sizes.set(k, v); if (v > c.topSize) c.topSize = v;
    } else { x.sell += q; x.s = true; if (x.first != null && t - x.first <= cfg.flipS) x.flip += q; }
    // a flip (flipShare of the SOL bought in the flip window sold back within it) stays a flip whatever comes later
    if (!x.flipped && x.flipBuy > 0 && x.flip >= cfg.flipShare * x.flipBuy) x.flipped = true;
    if (!wasTwo && x.b && x.s) c.two++;
    const net = x.buy - x.sell;
    const k = e.user !== c.create.creator && !x.early && !x.spray && x.n <= cfg.maxTradesPerWallet && !x.flipped && net >= cfg.minNetSol ? Math.min(net, cfg.capSol) : -1;
    if (x.k >= 0) { c.counted--; c.inflow -= x.k; }
    if (k >= 0) { c.counted++; c.inflow += k; }
    x.k = k;
    if (c.counted >= cfg.minCounted && c.inflow >= cfg.minInflowSol) {
      const d = this.demoteOf(c);
      if (!d.fails.length) this.#pass(c, t, d);
    }
  }

  /** The demote checks of a candidate now: `{ tpw, two, uni, conc, fails: [names] }`. */
  demoteOf(c) {
    const cfg = this.cfg;
    let maxIn = 0; for (const x of c.w.values()) if (x.k > maxIn) maxIn = x.k;
    const r = { tpw: c.w.size ? c.nTrades / c.w.size : 0, two: c.w.size ? c.two / c.w.size : 0, uni: c.nBuys ? c.topSize / c.nBuys : 0, conc: c.inflow > 0 ? maxIn / c.inflow : 1 };
    r.fails = [r.tpw > cfg.tpw && "trades/wallet", r.two > cfg.two && "two-sided", r.uni > cfg.uni && "size uniformity", r.conc > cfg.conc && "concentration"].filter(Boolean);
    return r;
  }

  #pass(c, t, d) {
    c.done = true;
    this.watched.delete(c.mint);
    const why = { at: t, secs: t - c.t, counted: c.counted, inflowSol: Math.round(c.inflow * 100) / 100, wallets: c.w.size, trades: c.nTrades, tpw: r2(d.tpw), two: r2(d.two), uni: r2(d.uni), conc: r2(d.conc) };
    this.stats.passed++; this.stats.lastPass = { mint: c.mint, symbol: c.create.symbol ?? null, ...why };
    this.onPass(c, why);
  }

  /** First-buy times of watched coins by `user` in the spray window before `t`, then this one recorded. */
  #spray(user, t) {
    let a = this.firstBuys.get(user);
    if (!a) this.firstBuys.set(user, a = []);
    const from = t - this.cfg.sprayS;
    while (a.length && a[0] < from) a.shift();
    const n = a.length;
    a.push(t);
    return n >= this.cfg.sprayCoins;
  }

  /** Drops launches past their window (they failed) and stale spray entries; call every minute or so. */
  sweep(nowS = Math.floor(this.now() / 1000)) {
    for (const [m, c] of this.watched) {
      if (nowS - c.t <= this.cfg.windowS + 30) break; // create order: the rest are younger
      this.watched.delete(m); this.stats.expired++;
    }
    const from = nowS - this.cfg.sprayS;
    for (const [u, a] of this.firstBuys) { while (a.length && a[0] < from) a.shift(); if (!a.length) this.firstBuys.delete(u); }
  }

  snapshot() { return { ...this.stats, watching: this.watched.size, wallets: this.firstBuys.size, cfg: { windowS: this.cfg.windowS, minCounted: this.cfg.minCounted, minInflowSol: this.cfg.minInflowSol, earlyAfterS: this.cfg.earlyAfterS } }; }
}

const r2 = (x) => Math.round(x * 100) / 100;

