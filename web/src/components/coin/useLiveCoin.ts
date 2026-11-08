// The coin page's live layer: one external store per mint that owns the page record (coin, tape,
// children) and folds the event stream into it. SSE trades are coalesced in an animation frame and
// committed at most four times a second, so a busy coin re-renders the few subscribers (price
// block, market-cap and volume tiles, phone bar, tape) a handful of times a second, never the page.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Coin, CoinPage, Trade } from "../../lib/api";
import { subscribe as subscribeEvents } from "../../lib/events";
import { tokens } from "../../lib/format";

/// The API hands over the last 50 trades; the tape keeps that many and links the explorer for the rest.
export const MAX_TRADES = 50;
const COMMIT_MS = 250;
const TICK_GAP_MS = 600;
const FRESH_MS = 4_000;
export const NEW_CHILD_MS = 60_000;

export type PriceTick = { id: number; dir: "up" | "down"; at: number };
export type LiveCoinState = {
  coin: Coin;
  trades: Trade[];
  children: Coin[];
  /// signatures that arrived over the stream in the last few seconds (their rows arrive with .is-new)
  fresh: ReadonlySet<string>;
  /// child mints that arrived over the stream → arrival time (ms); a "new" chip shows for a minute
  newKids: ReadonlyMap<string, number>;
  /// the last price move, at most one per 600 ms
  tick: PriceTick | null;
  /// bumps once per new child so the Children count pulses
  kidPulse: number;
};

const priceOf = (c: Coin) => c.priceUsd ?? c.priceQuote;
/// A trade's size in dollars: the server's figure, else price × amount.
export const tradeUsd = (t: Trade, decimals: number): number | null => t.valueUsd ?? (t.priceUsd != null ? t.priceUsd * tokens(t.baseAmount, decimals) : null);

export class LiveCoin {
  readonly mint: string;
  private state: LiveCoinState;
  private listeners = new Set<() => void>();
  private pendingTrades: Trade[] = [];
  private pendingKids: { coin: Coin; direct: boolean }[] = [];
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastCommit = 0;
  private lastSlot = 0;
  private tickId = 0;
  private solUsd: number | null = null;
  private expiry: ReturnType<typeof setTimeout>[] = [];

  constructor(page: CoinPage) {
    this.mint = page.coin.mint;
    this.lastSlot = page.trades.reduce((m, t) => Math.max(m, t.slot), 0);
    this.state = { coin: page.coin, trades: page.trades.slice(0, MAX_TRADES), children: page.children, fresh: new Set(), newKids: new Map(), tick: null, kidPulse: 0 };
  }

  get = () => this.state;
  /// The current coin record, for readers that should not subscribe (the trade widget, the share menu).
  coin = () => this.state.coin;
  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  setSolUsd(v: number | null) { this.solUsd = v; }

  /// Subscribes to the event stream; the returned function stops it and drops every timer.
  start(): () => void {
    const off = subscribeEvents({
      trade: (t) => { if (t.mint === this.mint) { this.pendingTrades.push(t); this.schedule(); } },
      coin: (c) => {
        if (c.mint === this.mint) return;
        const direct = c.parent?.mint === this.mint;
        if (direct || c.ancestors?.some((a) => a.mint === this.mint)) { this.pendingKids.push({ coin: c, direct }); this.schedule(); }
      },
    });
    return () => {
      off();
      if (this.frame) cancelAnimationFrame(this.frame);
      if (this.timer) clearTimeout(this.timer);
      this.expiry.forEach(clearTimeout);
      this.frame = 0; this.timer = null; this.expiry = [];
    };
  }

  private schedule() {
    if (this.frame || this.timer) return;
    const wait = Math.max(0, COMMIT_MS - (Date.now() - this.lastCommit));
    // A background tab gets no animation frames; a timer keeps the tab title current there.
    const go = () => { this.timer = null; if (typeof document !== "undefined" && document.hidden) this.commit(); else this.frame = requestAnimationFrame(() => { this.frame = 0; this.commit(); }); };
    if (wait > 0) this.timer = setTimeout(go, wait);
    else go();
  }

  private emit() { this.listeners.forEach((f) => f()); }

  private commit() {
    this.lastCommit = Date.now();
    const trades = this.pendingTrades; this.pendingTrades = [];
    const kids = this.pendingKids; this.pendingKids = [];
    if (!trades.length && !kids.length) return;
    const s = this.state;
    let coin = s.coin;
    let tape = s.trades;
    let fresh: Set<string> | null = null;
    const before = priceOf(coin);
    for (const t of trades) {
      if (tape.some((x) => x.sig === t.sig)) continue;
      tape = [t, ...tape];
      (fresh ??= new Set(s.fresh)).add(t.sig);
      const value = tradeUsd(t, coin.decimals) ?? 0;
      coin = { ...coin, trades24h: coin.trades24h + 1, volume24hUsd: coin.volume24hUsd + value };
      // An older trade that arrives late never moves the price back.
      if (t.slot >= this.lastSlot) {
        this.lastSlot = t.slot;
        const supply = tokens(coin.totalSupply, coin.decimals);
        const priceUsd = t.priceUsd ?? coin.priceUsd;
        const priceSol = priceUsd != null && this.solUsd ? priceUsd / this.solUsd : coin.priceSol;
        coin = { ...coin, priceQuote: t.priceQuote, priceUsd, priceSol, mcapUsd: priceUsd != null ? priceUsd * supply : coin.mcapUsd, mcapSol: priceSol != null ? priceSol * supply : coin.mcapSol };
      }
    }
    if (tape !== s.trades) tape = [...tape].sort((a, b) => b.slot - a.slot || b.time - a.time).slice(0, MAX_TRADES);
    let children = s.children;
    let newKids: Map<string, number> | null = null;
    let kidPulse = s.kidPulse;
    for (const { coin: c, direct } of kids) {
      if (direct && children.some((x) => x.mint === c.mint)) continue;
      if (direct) {
        children = [c, ...children];
        (newKids ??= new Map(s.newKids)).set(c.mint, Date.now());
        coin = { ...coin, children: coin.children + 1 };
        kidPulse += 1;
      }
      coin = { ...coin, descendants: coin.descendants + 1 };
    }
    let tick = s.tick;
    const after = priceOf(coin);
    if (before != null && after != null && after !== before && (!tick || Date.now() - tick.at >= TICK_GAP_MS)) tick = { id: ++this.tickId, dir: after > before ? "up" : "down", at: Date.now() };
    this.state = { coin, trades: tape, children, fresh: fresh ?? s.fresh, newKids: newKids ?? s.newKids, tick, kidPulse };
    if (fresh) this.later(FRESH_MS, () => { const f = new Set(this.state.fresh); trades.forEach((t) => f.delete(t.sig)); return { fresh: f }; });
    if (newKids) this.later(NEW_CHILD_MS + 50, () => { const m = new Map(this.state.newKids); for (const [k, at] of m) if (Date.now() - at >= NEW_CHILD_MS) m.delete(k); return { newKids: m }; });
    this.emit();
  }

  private later(ms: number, patch: () => Partial<LiveCoinState>) {
    const t = setTimeout(() => { this.expiry = this.expiry.filter((x) => x !== t); this.state = { ...this.state, ...patch() }; this.emit(); }, ms);
    this.expiry.push(t);
  }
}

/// One store per loaded record: a reload (Retry, a locked fee split) starts a fresh one.
export function useLiveCoinStore(page: CoinPage | null, solUsd: number | null): LiveCoin | null {
  const store = useMemo(() => (page ? new LiveCoin(page) : null), [page]);
  useEffect(() => store?.start(), [store]);
  useEffect(() => { store?.setSolUsd(solUsd); }, [store, solUsd]);
  return store;
}

/// Subscribes to one slice of the store. `pick` must return a field of the state (or a primitive),
/// never a fresh object, or React would see a new snapshot on every read.
export function useLive<T>(store: LiveCoin, pick: (s: LiveCoinState) => T): T {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()), () => pick(store.get()));
}
