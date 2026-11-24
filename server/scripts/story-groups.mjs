#!/usr/bin/env node
// Stories found from attention, replayed (step 0 of the automatic grouping; nothing in the product changes). Instead of a
// hand-kept table, narratives that have buyers in the window are grouped when their titles share a distinctive word that
// is bursting: launched in at least `minLaunches` coins in the window (a coin counts when its name, symbol or narrative
// title holds the word) and `burst` times its own normal rate over the `baseHours` before. Words on the NEVER lists
// (trump, elon, animals, seasons, generic words, platforms) never make a group. Groups that share most of their members
// merge (half of the smaller one), never through a chain of weak links. Wallet overlap is measured, never used to join:
// it is reported per member so the replay shows whether it would confirm or block joins (wallets that bought more than
// `botCoins` coins in the window are left out of it).
//
//   node scripts/story-groups.mjs --db <sqlite> [--at <ISO>] [--hours 24] [--base-hours 72] [--min-launches 5]
//       [--burst 3] [--expect subjects/labels.json] [--table subjects/table.json] [--json]
//
// With --expect it scores the groups against the hand labels: for each labelled subject, the group holding most of its
// `in` ids, how many of them it holds (recall) and how many `out` ids it wrongly holds. With --table, how many of the
// table's story rows an automatic group finds again (a group holding 2+ of the row's members that have buyers).
// The database is opened read-only; a slim extract (trades, narratives, coin_tags, coins with name/symbol/created_at)
// works as well as the server's file.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { words, wordOk, NEVER, fold } from "./subject-replay.mjs";

// Everyday words that fill model-written titles but never name a story on their own (on top of the NEVER lists).
export const STOP = Object.freeze(["are", "was", "were", "this", "that", "these", "what", "when", "who", "why", "how", "into", "over", "under", "out", "off", "down", "all", "one", "two", "more", "most", "very", "just", "only", "now", "say", "says", "said", "make", "made", "get", "got", "great", "good", "bad", "best", "hope", "support", "dies", "die", "dead", "fees", "fee", "hold", "holder", "holders", "index", "trade", "trading", "save", "usdc", "usd", "btc", "eth", "paired", "pair", "wallet", "wallets", "creator", "community", "first", "second", "after", "before", "against", "about", "like", "love", "big", "old", "new", "his", "her", "him", "she", "they", "them", "their", "has", "have", "had", "will", "can", "not", "but", "its", "movie", "movies", "film", "show", "boss", "final", "part", "three", "series", "season", "episode", "trailer", "version"]);
const NEVER_SET = new Set([...Object.values(NEVER).flat(), ...STOP]);
export const anchorOk = (w) => wordOk(w) && !NEVER_SET.has(w) && !/^\d+$/.test(w);

/**
 * Groups narratives into stories. `narrs`: [{ id, title, buyers, wallets? }]; `launches`: Map word → { now, base } (coins
 * launched in the window and in the base period); `opts`: { minLaunches, burst, hours, baseHours }.
 * Returns [{ key, anchors, members: [{ id, title, buyers }], buyers (distinct or null), sumAngles, why }], largest first.
 */
export function autoGroup(narrs, launches, { minLaunches = 5, burst = 3, steady = 15, hours = 24, baseHours = 72, yieldWords = new Set(), bots = new Set(), minOverlap = 0.1, minSecond = 20 } = {}) {
  const live = narrs.filter((n) => n.buyers > 0);
  const byWord = new Map();
  for (const n of live) for (const w of words(n.title)) if (anchorOk(w)) { let a = byWord.get(w); if (!a) byWord.set(w, a = []); a.push(n); }
  const cands = [];
  for (const [w, ms] of byWord) {
    if (ms.length < 2) continue;
    const L = launches.get(w) ?? { now: 0, base: 0 };
    const normal = (L.base / Math.max(1, baseHours)) * hours; // expected launches in a window this long
    // a story by launches: at least minLaunches coins named with it, bursting against its own normal or steadily busy
    const byLaunch = L.now >= minLaunches && (L.now >= burst * Math.max(normal, 1 / burst) || L.now >= steady);
    // a story by buyers: its narratives share buyers (median share of each one's wallets also among the others',
    // wallets on many coins left out), and its second narrative has real buyers (two tiny ones overlap by chance)
    const second = [...ms].sort((a, b) => b.buyers - a.buyers)[1]?.buyers ?? 0;
    const ov = ms.every((m) => m.wallets) ? medianOverlap(ms, bots) : 0;
    const byBuyers = ov >= minOverlap && second >= minSecond;
    // shared buyers are required: in the Nov 23-24 replay every group made by launches alone was unrelated titles
    // (0-1% shared buyers); launches add context and a surge reason
    if (!byBuyers) continue;
    cands.push({ anchors: [w], ids: new Set(ms.map((m) => m.id)), launches: L.now, normal, ov, why: [byLaunch && "launches", byBuyers && "shared buyers"].filter(Boolean).join(" + ") });
  }
  // merge candidates sharing at least half of the smaller one's members (no chaining: a merged group is compared by
  // its own members again, but only candidates that overlap it directly join)
  cands.sort((a, b) => b.ids.size - a.ids.size || b.launches - a.launches || (a.anchors[0] < b.anchors[0] ? -1 : 1));
  const groups = [];
  for (const c of cands) {
    const g = groups.find((x) => { let k = 0; for (const id of c.ids) if (x.ids.has(id)) k++; return k * 2 >= Math.min(c.ids.size, x.ids.size); });
    if (g) { g.anchors.push(...c.anchors); for (const id of c.ids) g.ids.add(id); g.launches = Math.max(g.launches, c.launches); }
    else groups.push({ anchors: [...c.anchors], ids: new Set(c.ids), launches: c.launches, normal: c.normal, via: c.why });
  }
  // one group per narrative: a story group before a company group (yieldWords: the table's quiet rows), then the
  // group with more buyers in the window (the dominant story), then more launches
  const byId = new Map(live.map((n) => [n.id, n]));
  const weight = (g) => { let b = 0; for (const id of g.ids) b += byId.get(id)?.buyers ?? 0; return b; };
  const yields = (g) => g.anchors.every((a) => yieldWords.has(a));
  const owner = new Map();
  for (const g of [...groups].sort((a, b) => Number(yields(a)) - Number(yields(b)) || weight(b) - weight(a) || b.launches - a.launches)) for (const id of g.ids) if (!owner.has(id)) owner.set(id, g);
  const out = [];
  for (const g of groups) {
    const members = [...g.ids].filter((id) => owner.get(id) === g).map((id) => byId.get(id)).sort((a, b) => b.buyers - a.buyers || a.id - b.id);
    if (members.length < 2) continue;
    // checked again after the shared titles went to their owner: a group that qualified through another story's
    // titles (Nvidia through Jensen's) and no longer shares buyers is dropped, its narratives stay single cards
    if (members.every((m) => m.wallets) && (medianOverlap(members, bots) < minOverlap || (members[1]?.buyers ?? 0) < minSecond)) continue;
    const buyers = members.every((m) => m.wallets) ? new Set(members.flatMap((m) => [...m.wallets])).size : null;
    out.push({ key: `t:${[...new Set(g.anchors)].sort().join("-")}`, anchors: [...new Set(g.anchors)].sort(), members: members.map((m) => ({ id: m.id, title: m.title, buyers: m.buyers })), buyers, sumAngles: members.reduce((s, m) => s + m.buyers, 0), why: `${g.via}: ${g.launches} launches vs ${g.normal.toFixed(1)} normal` });
  }
  return out.sort((a, b) => (b.buyers ?? b.sumAngles) - (a.buyers ?? a.sumAngles));
}

/** The median, over narratives `ms`, of the share of each one's wallets (bots left out) also bought by the others. */
export function medianOverlap(ms, bots = new Set()) {
  const sets = ms.map((m) => new Set([...m.wallets].filter((w) => !bots.has(w))));
  const vals = sets.map((own, i) => {
    if (!own.size) return null;
    let k = 0;
    for (const w of own) { for (let j = 0; j < sets.length; j++) if (j !== i && sets[j].has(w)) { k++; break; } }
    return k / own.size;
  }).filter((v) => v != null).sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)] : 0;
}

/** Per member: the share of its (non-bot) wallets also among the rest of its group's wallets. Measured only. */
export function overlaps(group, narrsById, bots = new Set()) {
  const ws = (id) => new Set([...(narrsById.get(id)?.wallets ?? [])].filter((w) => !bots.has(w)));
  return group.members.map((m) => {
    const own = ws(m.id), rest = new Set();
    for (const o of group.members) if (o.id !== m.id) for (const w of ws(o.id)) rest.add(w);
    let k = 0; for (const w of own) if (rest.has(w)) k++;
    return { id: m.id, overlap: own.size ? k / own.size : null };
  });
}

/** Scores groups against hand labels ({ subjects: { key: { in, out } } }): per labelled subject, the best group. */
export function scoreLabels(groups, labels, activeIds) {
  const res = [];
  for (const [key, l] of Object.entries(labels?.subjects ?? {})) {
    const inIds = (l.in ?? []).map(Number).filter((id) => activeIds.has(id)), outIds = new Set((l.out ?? []).map(Number));
    let best = null, bestK = 0;
    for (const g of groups) { const ids = new Set(g.members.map((m) => m.id)); const k = inIds.filter((id) => ids.has(id)).length; if (k > bestK) { best = g; bestK = k; } }
    const wrong = best ? best.members.filter((m) => outIds.has(m.id)).map((m) => m.id) : [];
    res.push({ key, activeIn: inIds.length, group: best?.key ?? null, found: bestK, wrong });
  }
  return res;
}

/** Narratives with their window's wallets, the site's buyers, and launches per word now and in the base period. */
export function readWindow(dbPath, { untilT, hours = 24, baseHours = 72, botCoins = 25 }) {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const sinceT = untilT - hours * 3600, baseT = sinceT - baseHours * 3600;
    const narrs = db.prepare("SELECT id, title FROM narratives ORDER BY id").all().map((n) => ({ id: Number(n.id), title: n.title }));
    const tagOf = new Map(db.prepare("SELECT mint, narrative_id FROM coin_tags").all().map((r) => [r.mint, Number(r.narrative_id)]));
    const titleOf = new Map(narrs.map((n) => [n.id, n.title]));
    const wallets = new Map(narrs.map((n) => [n.id, new Set()])), coinsOf = new Map(), site = new Set();
    for (const r of db.prepare("SELECT mint, user FROM trades WHERE time >= ? AND time < ? AND is_buy = 1 AND value_usd >= 1").iterate(sinceT, untilT)) {
      site.add(r.user);
      let s = coinsOf.get(r.user); if (!s) coinsOf.set(r.user, s = new Set()); s.add(r.mint);
      const id = tagOf.get(r.mint); if (id != null) wallets.get(id)?.add(r.user);
    }
    const bots = new Set([...coinsOf].filter(([, s]) => s.size > botCoins).map(([w]) => w));
    for (const n of narrs) { n.wallets = wallets.get(n.id) ?? new Set(); n.buyers = n.wallets.size; }
    const launches = new Map();
    const bump = (w, k) => { let L = launches.get(w); if (!L) launches.set(w, L = { now: 0, base: 0 }); L[k]++; };
    for (const c of db.prepare("SELECT mint, name, symbol, created_at FROM coins WHERE created_at >= ? AND created_at < ?").iterate(baseT, untilT)) {
      const k = c.created_at >= sinceT ? "now" : "base";
      for (const w of new Set([...words(c.name), ...words(c.symbol)])) if (anchorOk(w)) bump(w, k);
    }
    return { sinceT, untilT, narrs, siteBuyers: site.size, launches, bots };
  } finally { db.close(); }
}

export function parseArgs(argv) {
  const o = { hours: 24, baseHours: 72, minLaunches: 5, burst: 3, steady: 15, json: false, at: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { o.json = true; continue; }
    const v = argv[++i];
    if (v == null) throw new Error(`${a} needs a value`);
    if (a === "--db") o.db = v;
    else if (a === "--at") { o.at = Math.floor(Date.parse(v) / 1000); if (!Number.isFinite(o.at)) throw new Error("--at must be an ISO time"); }
    else if (a === "--hours") o.hours = Number(v);
    else if (a === "--base-hours") o.baseHours = Number(v);
    else if (a === "--min-launches") o.minLaunches = Number(v);
    else if (a === "--burst") o.burst = Number(v);
    else if (a === "--steady") o.steady = Number(v);
    else if (a === "--expect") o.expect = v;
    else if (a === "--table") o.table = v;
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.db) throw new Error("--db is required");
  for (const k of ["hours", "baseHours", "minLaunches", "burst"]) if (!(o[k] > 0)) throw new Error(`--${k} must be above 0`);
  return o;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const w = readWindow(o.db, { untilT: o.at ?? Math.floor(Date.now() / 1000), hours: o.hours, baseHours: o.baseHours });
    const yieldWords = new Set(o.table ? JSON.parse(readFileSync(resolve(o.table), "utf8")).subjects.filter((x) => x.quiet).flatMap((x) => x.anchors) : []);
    const groups = autoGroup(w.narrs, w.launches, { ...o, yieldWords, bots: w.bots });
    const byId = new Map(w.narrs.map((n) => [n.id, n]));
    const active = new Set(w.narrs.filter((n) => n.buyers > 0).map((n) => n.id));
    for (const g of groups) { g.share = g.buyers != null && w.siteBuyers ? g.buyers / w.siteBuyers : null; g.overlap = overlaps(g, byId, w.bots); }
    const score = o.expect ? scoreLabels(groups, JSON.parse(readFileSync(resolve(o.expect), "utf8")), active) : null;
    let table = null;
    if (o.table) {
      const f = fold(w.narrs, JSON.parse(readFileSync(resolve(o.table), "utf8")), w.siteBuyers);
      table = f.subjects.filter((s) => !s.quiet && s.angles >= 2).map((s) => {
        const ids = new Set(s.members.filter((m) => m.buyers > 0).map((m) => m.id));
        let best = null, k = 0;
        for (const g of groups) { const n = g.members.filter((m) => ids.has(m.id)).length; if (n > k) { k = n; best = g.key; } }
        return { key: s.key, angles: ids.size, group: best, held: k, found: k >= 2 };
      });
    }
    if (o.json) console.log(JSON.stringify({ sinceT: w.sinceT, untilT: w.untilT, siteBuyers: w.siteBuyers, bots: w.bots.size, groups, score, table }, null, 2));
    else {
      console.log(`window ${new Date(w.sinceT * 1000).toISOString()} .. ${new Date(w.untilT * 1000).toISOString()}: ${active.size} narratives with buyers, site ${w.siteBuyers} buyers, ${w.bots.size} wallets on ${">"}25 coins left out of overlaps; ${groups.length} groups (min ${o.minLaunches} launches, ${o.burst}x normal)`);
      for (const g of groups) {
        const ov = g.overlap.map((x) => x.overlap).filter((x) => x != null).sort((a, b) => a - b);
        console.log(`\n${g.key}: ${g.members.length} narratives, ${g.buyers} buyers (${g.share != null ? (g.share * 100).toFixed(1) : "-"}%), ${g.why}, median wallet overlap ${ov.length ? (ov[Math.floor(ov.length / 2)] * 100).toFixed(0) + "%" : "-"}`);
        console.log(`  ${g.members.slice(0, 8).map((m) => `#${m.id} "${m.title}" ${m.buyers}`).join(" | ")}${g.members.length > 8 ? ` | +${g.members.length - 8}` : ""}`);
      }
      if (score) { console.log("\nlabels:"); for (const s of score) console.log(`  ${s.key}: ${s.found}/${s.activeIn} active 'in' narratives in ${s.group ?? "no group"}; wrongly held 'out': ${s.wrong.length ? s.wrong.join(", ") : "none"}`); }
      if (table) { console.log(`\ntable story rows found again: ${table.filter((t) => t.found).length}/${table.length}`); for (const t of table) console.log(`  ${t.key}: ${t.found ? `in ${t.group} (${t.held}/${t.angles} angles)` : `not found (${t.held}/${t.angles})`}`); }
    }
  } catch (e) { console.error(`story-groups: ${e.message}`); process.exit(1); }
}
