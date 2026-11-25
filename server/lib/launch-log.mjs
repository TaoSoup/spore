// LAUNCH_LOG: a measurement log of every pump.fun bonding-curve launch and trade the live stream delivers, tracked or
// not. The indexer keeps only coins in the tree (lib/indexer.mjs onCreate drops plain SOL-paired roots), so this is the
// only record of the launches Discover does not show yet; local/backtest/trend scores attention gates against it.
// Its own sqlite file (not spore.sqlite), rows buffered and written in one transaction a few seconds apart, older rows
// trimmed hourly. Off unless LAUNCH_LOG names a file.
import { DatabaseSync } from "node:sqlite";

export class LaunchLog {
  constructor({ file, keepHours = 72, flushMs = 3000, log = console } = {}) {
    this.log = log; this.keepS = keepHours * 3600;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;
CREATE TABLE IF NOT EXISTS creates (mint TEXT PRIMARY KEY, slot INTEGER, t INTEGER, seen INTEGER, name TEXT, symbol TEXT, uri TEXT, creator TEXT, depth INTEGER, quote TEXT, mayhem INTEGER);
CREATE TABLE IF NOT EXISTS trades (sig TEXT, i INTEGER, slot INTEGER, mint TEXT, t INTEGER, buy INTEGER, user TEXT, q REAL, vq REAL, vt REAL, quote TEXT, PRIMARY KEY (sig, i)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS trades_mint_t ON trades (mint, t);
CREATE INDEX IF NOT EXISTS trades_t ON trades (t);
CREATE INDEX IF NOT EXISTS creates_t ON creates (t);`);
    this.insC = this.db.prepare("INSERT OR IGNORE INTO creates VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    this.insT = this.db.prepare("INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    this.buf = []; this.stats = { creates: 0, trades: 0, errors: 0, lastError: "" };
    this.timers = [setInterval(() => this.flush(), flushMs), setInterval(() => this.trim(), 3600_000)];
    for (const t of this.timers) t.unref?.();
  }
  create(e, slot) {
    this.stats.creates++;
    this.buf.push([this.insC, [e.mint, slot ?? null, e.timestamp, Math.floor(Date.now() / 1000), e.name || null, e.symbol || null, e.uri || null, e.creator ?? null, e.depth, e.quoteMint ?? null, e.isMayhemMode ? 1 : 0]]);
  }
  trade(e, sig, slot, i) {
    this.stats.trades++;
    this.buf.push([this.insT, [sig, i, slot ?? null, e.mint, e.timestamp, e.isBuy ? 1 : 0, e.user, Number(e.quoteAmount), Number(e.virtualQuoteReserves), Number(e.virtualTokenReserves), e.quoteMint ?? null]]);
  }
  flush() {
    if (!this.buf.length) return;
    const rows = this.buf; this.buf = [];
    try {
      this.db.exec("BEGIN");
      for (const [st, a] of rows) st.run(...a);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.stats.errors++; this.stats.lastError = e.message;
    }
  }
  trim() {
    const cut = Math.floor(Date.now() / 1000) - this.keepS;
    try { this.db.prepare("DELETE FROM trades WHERE t < ?").run(cut); this.db.prepare("DELETE FROM creates WHERE t < ?").run(cut); }
    catch (e) { this.stats.errors++; this.stats.lastError = e.message; }
  }
  snapshot() { return { ...this.stats, buffered: this.buf.length }; }
  close() { for (const t of this.timers) clearInterval(t); this.flush(); this.db.close(); }
}
