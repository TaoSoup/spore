#!/usr/bin/env node
// Pre-registered events (server/prereg/events.json, README §Story attention): each event's result by the rule written
// down before its date (lib/attention.mjs eventResult). Reads the server's sqlite file READ-ONLY (table event_buckets, which
// is never trimmed and carries the site's buyers of every bucket the recorder watched, so a result reads the same on any
// later day); writes nothing anywhere.
//
//   node scripts/event-results.mjs --db <DATA_DIR>/spore.sqlite [--events prereg/events.json] [--json]
//
// An event whose after window has not ended yet is reported as "OPEN" with what is there so far.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseEvent, eventResult, EVENTS_FILE, BUCKET_S } from "../lib/attention.mjs";

export function parseArgs(argv) {
  const o = { events: fileURLToPath(EVENTS_FILE), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { o.json = true; continue; }
    const v = argv[++i];
    if (a === "--db") o.db = v; else if (a === "--events") o.events = v; else throw new Error(`unknown option ${a}`);
  }
  if (!o.db) throw new Error("--db <path to the server's sqlite file> is required");
  return o;
}

/** Every event's result from an open database handle `db` (node:sqlite) and the events file's parsed JSON; `nowS` decides OPEN. */
export function eventResults(db, doc, nowS = Math.floor(Date.now() / 1000)) {
  const evQ = db.prepare("SELECT t, buyers, pre_buyers, new_buyers, site_buyers FROM event_buckets WHERE event_id = ? AND t >= ? AND t < ?");
  const out = [];
  for (const raw of doc.events ?? []) {
    let ev;
    try { ev = parseEvent(raw); } catch (e) { out.push({ id: raw?.id ?? "?", error: e.message }); continue; }
    const from = Math.min(ev.recFrom, ev.windows.baseline[0]) - BUCKET_S, to = ev.recTo + BUCKET_S;
    const rs = evQ.all(ev.id, from, to);
    const rows = new Map(rs.map((r) => [Number(r.t), { buyers: r.buyers, preBuyers: r.pre_buyers, newBuyers: r.new_buyers }]));
    // the denominator and the buckets watched: the event's own rows (a bucket with no row was not watched)
    const site = new Map(rs.map((r) => [Number(r.t), r.site_buyers]));
    const res = eventResult(ev, rows, site);
    if (nowS < ev.windows.after[1]) { res.verdict = "OPEN"; res.why = `the after window ends ${new Date(ev.windows.after[1] * 1000).toISOString()}`; }
    out.push({ what: ev.what, ...res });
  }
  return out;
}

const pct = (x) => (x == null ? "-" : `${(x * 100).toFixed(2)}%`);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const doc = JSON.parse(readFileSync(resolve(o.events), "utf8"));
    const db = new DatabaseSync(resolve(o.db), { readOnly: true });
    let res;
    try {
      db.exec("PRAGMA query_only = ON");
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_buckets'").get()) throw new Error("this database has no event_buckets table (the server has not run the recorder yet)");
      res = eventResults(db, doc);
    } finally { db.close(); }
    if (o.json) console.log(JSON.stringify(res, null, 2));
    else for (const r of res) {
      if (r.error) { console.log(`${r.id}: skipped (${r.error})`); continue; }
      console.log(`${r.id} (${new Date(r.T * 1000).toISOString()}): ${r.verdict} - ${r.why}`);
      console.log(`  share of site buyers: baseline ${pct(r.baseline.share)} (${r.baseline.observed} buckets), pre ${pct(r.pre.share)}, event ${pct(r.event.share)}, after ${pct(r.after.share)}; comparison p90 ${pct(r.p90)} over ${r.comparison.length} days`);
      console.log(`  pre-existing coins: baseline ${pct(r.preBaseline.share)}, event ${pct(r.preEvent.share)}`);
    }
  } catch (e) { console.error(`event-results: ${e.message}`); process.exit(1); }
}
