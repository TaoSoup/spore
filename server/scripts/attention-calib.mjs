#!/usr/bin/env node
// Calibration of the story attention (lib/attention.mjs, README §Story attention): what followed each 5-minute snapshot,
// per phase and per band of the multiple of normal. Reads the server's sqlite file READ-ONLY (table `calib`); writes
// nothing anywhere. A measurement for the owner: whether "rising" or "2x its normal" told anything about the next hour.
//
//   node scripts/attention-calib.mjs --db <DATA_DIR>/spore.sqlite [--days 30] [--json]
//
// Per group: n (snapshots), n1h / n6h (outcomes filled), "next h / prev h" (median of the story's buyers in the hour
// after the snapshot over its buyers in the hour up to it; both are sums of 5-minute bucket buyers), "more next h" (share
// of snapshots whose next hour had more buyers than the hour before), and the leading coin's price at +1 h and +6 h over
// its price at the snapshot (median, and the share above 1). Snapshots are taken every 5 minutes for the same story, so
// neighbouring rows overlap: read n as "snapshots", not as independent cases. An outcome counts only when every bucket
// of its window was seen whole (cov_1h = 12, cov_6h = 72): a restart or a downtime would read as fewer buyers;
// `gaps1h` / `gaps6h` count the outcomes left out for that.
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BANDS = Object.freeze([["none", (m) => m == null], ["<1x", (m) => m < 1], ["1-2x", (m) => m < 2], ["2-4x", (m) => m < 4], ["4x+", () => true]]);
export const bandOf = (m) => BANDS.find(([, f]) => f(m))[0];
/** The buckets of a whole 1 h and 6 h window. */
export const FULL_1H = 12, FULL_6H = 72;
const med = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y), i = a.length >> 1; return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2; };
const share = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : null);

/** The table: one group per phase and band seen, `{ phase, band, n, n1h, n6h, gaps1h, gaps6h, nextOverPrev, moreNext, price1h, up1h, price6h, up6h }` (ratios as numbers, null when nothing to say). */
export function calibTable(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.phase}\n${bandOf(r.multiple)}`;
    let g = groups.get(k);
    if (!g) groups.set(k, g = { phase: r.phase, band: bandOf(r.multiple), rows: [] });
    g.rows.push(r);
  }
  const order = (p) => ["new", "rising", "peaked", "steady", "fading"].indexOf(p);
  return [...groups.values()].sort((a, b) => order(a.phase) - order(b.phase) || BANDS.findIndex(([x]) => x === a.band) - BANDS.findIndex(([x]) => x === b.band)).map((g) => {
    const d1 = g.rows.filter((r) => r.filled_1h), d6 = g.rows.filter((r) => r.filled_6h);
    const f1 = d1.filter((r) => r.buyers_1h != null && r.cov_1h >= FULL_1H), f6 = d6.filter((r) => r.buyers_6h != null && r.cov_6h >= FULL_6H);
    const ratio = f1.filter((r) => r.hour_buyers > 0).map((r) => r.buyers_1h / r.hour_buyers);
    const p1 = f1.filter((r) => r.leader_price_usd > 0 && r.price_1h > 0).map((r) => r.price_1h / r.leader_price_usd);
    const p6 = f6.filter((r) => r.leader_price_usd > 0 && r.price_6h > 0).map((r) => r.price_6h / r.leader_price_usd);
    return { phase: g.phase, band: g.band, n: g.rows.length, n1h: f1.length, n6h: f6.length, gaps1h: d1.length - f1.length, gaps6h: d6.length - f6.length, nextOverPrev: med(ratio), moreNext: share(f1.filter((r) => r.hour_buyers > 0), (r) => r.buyers_1h > r.hour_buyers),
      price1h: med(p1), up1h: share(p1, (x) => x > 1), price6h: med(p6), up6h: share(p6, (x) => x > 1) };
  });
}

export function parseArgs(argv) {
  const o = { days: 30, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { o.json = true; continue; }
    const v = argv[++i];
    if (a === "--db") o.db = v;
    else if (a === "--days") { o.days = Number(v); if (!(o.days > 0)) throw new Error("--days must be above 0"); }
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.db) throw new Error("--db <path to the server's sqlite file> is required");
  return o;
}

/** Reads the snapshots of the last `days` (by their newest time) from a read-only database and returns the table. */
export function readCalib(dbPath, days = 30) {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'calib'").get()) throw new Error("this database has no calib table (the server has not run the story attention yet)");
    const newest = Number(db.prepare("SELECT MAX(t) AS t FROM calib").get()?.t ?? 0);
    const rows = db.prepare("SELECT phase, multiple, buyers5m, hour_buyers, leader_price_usd, buyers_1h, price_1h, filled_1h, cov_1h, buyers_6h, price_6h, filled_6h, cov_6h FROM calib WHERE t >= ?").all(newest - Math.round(days * 86_400));
    return { newest, rows: rows.length, table: calibTable(rows) };
  } finally { db.close(); }
}

const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`), x2 = (x) => (x == null ? "-" : x.toFixed(2));
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const o = parseArgs(process.argv.slice(2)), r = readCalib(o.db, o.days);
    if (o.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`calibration: ${r.rows} snapshots, newest ${r.newest ? new Date(r.newest * 1000).toISOString() : "-"}`);
      console.log(["phase", "band", "n", "n1h", "n6h", "gaps 1h/6h", "next h/prev h", "more next h", "price +1h", "up +1h", "price +6h", "up +6h"].join("\t"));
      for (const g of r.table) console.log([g.phase, g.band, g.n, g.n1h, g.n6h, `${g.gaps1h}/${g.gaps6h}`, x2(g.nextOverPrev), pct(g.moreNext), x2(g.price1h), pct(g.up1h), x2(g.price6h), pct(g.up6h)].join("\t"));
    }
  } catch (e) { console.error(`attention-calib: ${e.message}`); process.exit(1); }
}
