#!/usr/bin/env node
// Subjects over narratives, replayed (slice 0 of the topic layer; nothing in the product changes). The narrative tagger
// (lib/narrtags.mjs) files one story under many narratives when a subject has many angles: by subjects/table.json, in
// the 24 h before Nov 24 2026 01:05 UTC the Jensen Huang return was 35 narratives, 27 with buyers ("jensen the white
// leather jacket", "nvidia reinstates jensen huang ceo", ...) and GTA 6 was 77, 33 with buyers. A subject is a named
// person in one saga, an event, a franchise, a meme, or (as a quiet row) a company; its narratives (angles) are the ones
// whose title holds one of its anchor words as a whole word. This script reads the server's sqlite file READ-ONLY and writes nothing.
//
//   node scripts/subject-replay.mjs --db <DATA_DIR>/spore.sqlite [--hours 24] [--at <ISO>] [--min 3] [--json]
//       lists candidate words: title words held by --min or more narratives that had buyers in the window, each with
//       its narratives, distinct buyers, the words its titles share and the longer words it starts (gta -> gta6);
//       words on the built-in NEVER lists are kept but marked, so whoever picks the subjects sees them too.
//   ... --anchors <table.json> [--expect <labels.json>] [--quiet-share 0.03] [--new-after <narrative id>]
//       folds narratives into the table's subjects and prints each subject: its angles, distinct buyers counted once,
//       share of the site's buyers, whether it would show as a block, and the checks largest angle <= subject <= sum of
//       angles, subject <= site; with --expect, whether the labels hold (exits 2 when one does not); with --new-after,
//       each subject's members with a higher narrative id (ids grow with time: what joined since the last check, to
//       spot wrong joins) and the new narratives with buyers that joined no subject (to spot misses).
//
// table.json: { "quietShare": 0.03, "subjects": [{ "key": "t:huang-jensen", "title": "Jensen Huang", "anchors": ["jensen", "huang"],
//   "exclude": [1069], "include": [513] }, { "key": "t:nvidia", "title": "Nvidia", "anchors": ["nvidia"], "quiet": true }, ...] }.
// A subject's key is fixed in the table ("t:" + lower-case letters, digits and "-"), so editing its anchors later does
// not rename it; without one it is "t:" + the anchors sorted and joined by "-" (never a model-written title).
// Story rows and quiet rows: a story row's word names one story (a person inside one saga, an event, a fictional work, a
// meme or coin's own name). A company, brand or product name keeps making unrelated stories (Nvidia mascot coins, stock
// chatter and the CEO succession on one day), so its row is `quiet`: it folds its narratives as usual, but shows as a
// block only on a window where its distinct buyers reach `quietShare` of the site's (3% by default; --quiet-share), and it
// loses every tie to a story row (only its own `include` can give it a title a story row also holds). A person who simply
// posts a lot gets no row (their coins answer different posts): their words go under the labels' `neverAnchors`.
// A narrative joins one subject at most:
//   1. a subject that lists it under `include` (a title about the subject that holds none of its words, like
//      "nvidia ceo gooner exposed" for Jensen Huang; the first such subject in the table);
//   2. else the subjects whose anchor it holds and that do not exclude it; when there are two or more (listed under
//      `conflicts`): a story row before a quiet row, then the one whose matched anchor is longer, then table order
//      ("nvidia reinstates jensen huang ceo" goes to Jensen Huang, not to Nvidia; "anthropic solves riemann hypothesis"
//      to the Riemann proof, not to Anthropic; "tesla optimus ..." to Optimus, not to Tesla). The order does not depend
//      on how many narratives each subject has, so it cannot flip as counts move.
// labels.json: { "subjects": { "<key>": { "in": [ids], "out": [ids] } }, "neverAnchors": ["christmas", ...],
//   "oneSubjectFor": [[ids that must all land in one and the same subject], ...], "none": [ids that must stand alone],
//   "quiet": [keys that must be quiet rows], "story": [keys that must be story rows], "absent": [keys that must not exist] }.
//   When `quiet` or `story` is given, every row of the table must be in one of them. `absent` checks keys only (a key is
//   hand-written); a word that must never anchor any row goes under `neverAnchors`.
//
// Buyers: distinct wallets with a $1+ buy (trades.value_usd >= 1, as everywhere on Discover) in the window, over the
// coins tagged into the narrative (coin_tags); a wallet in two coins or two angles is counted once for the subject.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Words that never make a subject, with the reason (the "trump" blob of Nov 21; seasons and kinds of thing are themes, not stories). */
export const NEVER = Object.freeze({
  standing: ["trump", "elon", "musk", "doge", "pepe", "wif", "bonk", "biden", "kanye"],
  animal: ["cat", "dog", "inu", "frog", "monkey", "ape", "bear", "bull", "bird", "fish", "pig", "cow", "duck", "horse", "goat", "wolf", "fox", "lion", "tiger", "rabbit", "bunny", "penguin", "whale", "shark", "snake", "rat", "mouse", "owl", "seal", "kitten", "kitty", "puppy", "hippo", "gator", "turkey"],
  season: ["christmas", "xmas", "santa", "thanksgiving", "halloween", "easter", "valentine", "valentines", "holiday", "holidays", "winter", "summer", "new", "year"],
  generic: ["viral", "runner", "post", "posts", "mascot", "charity", "meme", "memes", "coin", "coins", "token", "tokens", "official", "trend", "cult", "run", "the", "and", "for", "with", "from", "his", "her", "its", "you", "your", "our", "not", "back", "first", "last", "ceo", "ai", "agent", "agents", "bot", "app", "game", "games", "video", "photo", "image", "pfp", "art", "music", "song", "dance", "girl", "boy", "man", "woman", "kid", "baby", "king", "queen", "lord", "god", "jesus", "money", "cash", "rich", "poor", "crypto", "stock", "stocks", "market", "chart", "crash", "pump", "moon", "launch", "returns", "return", "news", "event", "day", "week", "time", "life", "world", "people", "fake", "real", "big", "little", "super", "mega", "tiny", "red", "white", "black", "blue", "green", "gold", "golden"],
  platform: ["pumpfun", "pump", "fun", "solana", "sol", "launchpad", "bonkfun", "letsbonk", "raydium", "jupiter", "twitter", "x", "tiktok", "instagram", "youtube", "douyin"],
});
const NEVER_OF = new Map(Object.entries(NEVER).flatMap(([why, ws]) => ws.map((w) => [w, why])));

/** A title's words: lower case, split on anything that is not a letter or digit, de-duplicated, in order. */
export function words(title) {
  return [...new Set(String(title ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
}
/** Whether a word can stand for a subject at all: 3+ characters with a letter (so "128" and "6" are not). */
export const wordOk = (w) => w.length >= 3 && /[a-z]/.test(w);

/**
 * Candidate subject words. `narrs`: [{ id, title, buyers, wallets? }] (only narratives that had buyers in the window are
 * counted). A word held by `min` or more of them is a candidate: `{ word, never, n, buyers, sumAngles, members, coWords,
 * variants }` (`buyers`: the union of the members' wallets when they carry `wallets`, else null; `coWords`: other words
 * held by half or more of its members; `variants`: longer words of other titles that start with it, like gta6).
 */
export function candidates(narrs, { min = 3, top = 40 } = {}) {
  const live = narrs.filter((n) => n.buyers > 0);
  const by = new Map();
  for (const n of live) for (const w of words(n.title)) if (wordOk(w)) { let a = by.get(w); if (!a) by.set(w, a = []); a.push(n); }
  const all = new Set(live.flatMap((n) => words(n.title)));
  const out = [];
  for (const [word, ms] of by) {
    if (ms.length < min) continue;
    const co = new Map();
    for (const m of ms) for (const w of words(m.title)) if (w !== word && wordOk(w)) co.set(w, (co.get(w) ?? 0) + 1);
    const u = ms.every((m) => m.wallets) ? new Set(ms.flatMap((m) => [...m.wallets])).size : null;
    out.push({
      word, never: NEVER_OF.get(word) ?? null, n: ms.length, buyers: u, sumAngles: ms.reduce((s, m) => s + m.buyers, 0),
      members: [...ms].sort((a, b) => b.buyers - a.buyers || a.id - b.id).slice(0, top).map((m) => ({ id: m.id, title: m.title, buyers: m.buyers })),
      coWords: [...co].filter(([, k]) => k * 2 >= ms.length).sort((a, b) => b[1] - a[1]).map(([w]) => w),
      variants: [...all].filter((w) => w !== word && w.startsWith(word) && w.length <= word.length + 3).sort(),
    });
  }
  return out.sort((a, b) => b.n - a.n || (b.buyers ?? b.sumAngles) - (a.buyers ?? a.sumAngles) || (a.word < b.word ? -1 : 1));
}

/** The default share of the site's buyers a quiet row needs before it shows as a block. */
export const QUIET_SHARE = 0.03;
const isFraction = (x) => typeof x === "number" && x > 0 && x < 1;

/**
 * The table, checked: each subject gets its key, anchor set and `quiet` flag. Throws on a subject with no anchors, a
 * malformed key, a key used twice, a `quiet` that is not true or false, or a `quietShare` that is not a number in (0, 1).
 */
export function readTable(table) {
  const seen = new Set();
  if (table?.quietShare != null && !isFraction(table.quietShare)) throw new Error("quietShare must be a fraction between 0 and 1");
  return (table?.subjects ?? []).map((s, i) => {
    if (s.quiet != null && typeof s.quiet !== "boolean") throw new Error(`subject ${i + 1} (${s.title ?? "?"}) has a quiet flag that is not true or false`);
    const anchors = [...new Set((s.anchors ?? []).map((w) => String(w).toLowerCase().trim()).filter(Boolean))].sort();
    if (!anchors.length) throw new Error(`subject ${i + 1} (${s.title ?? "?"}) has no anchors`);
    const key = s.key ?? `t:${anchors.join("-")}`;
    if (!/^t:[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) throw new Error(`subject ${i + 1} (${s.title ?? "?"}) has a malformed key ${key}`);
    if (seen.has(key)) throw new Error(`two subjects have the key ${key}`);
    seen.add(key);
    return { key, title: String(s.title ?? anchors.join(" ")), anchors: new Set(anchors), quiet: s.quiet === true, exclude: new Set((s.exclude ?? []).map(Number)), include: new Set((s.include ?? []).map(Number)) };
  });
}

/** The anchors of subject `s` that title-words `ws` hold (none when `s` excludes narrative `id`). */
const heldBy = (s, id, ws) => (s.exclude.has(id) ? [] : [...s.anchors].filter((a) => ws.has(a)));

/**
 * Folds narratives into subjects. Returns `{ subjects, conflicts, siteBuyers, quietShare }`: per subject `{ key, title,
 * anchors, quiet, members: [{ id, title, buyers }], angles (members with buyers), buyers (distinct, or null without
 * wallets), sumAngles, largest, share (of siteBuyers), shows (the block would replace the cards: 2+ angles with buyers,
 * and for a quiet row a share of quietShare or more), ok (largest <= buyers <= sumAngles, buyers <= siteBuyers) }`;
 * `conflicts`: narratives holding anchors of two or more subjects, with the one they joined by the tie rule (see the
 * head of this file) and the others. `quietShare`: `opts.quietShare`, else the table's, else QUIET_SHARE.
 */
export function fold(narrs, table, siteBuyers = null, opts = {}) {
  const subs = readTable(table).map((s) => ({ ...s, members: [] }));
  const quietShare = opts.quietShare ?? table?.quietShare ?? QUIET_SHARE;
  if (!isFraction(quietShare)) throw new Error("quietShare must be a fraction between 0 and 1");
  const wordsOf = new Map(narrs.map((n) => [n.id, new Set(words(n.title))]));
  const conflicts = [];
  for (const n of narrs) {
    const ws = wordsOf.get(n.id);
    const inc = subs.find((s) => s.include.has(n.id));
    if (inc) { inc.members.push(n); continue; }
    const hit = subs.map((s, i) => ({ s, i, held: heldBy(s, n.id, ws) })).filter((h) => h.held.length);
    if (!hit.length) continue;
    const longest = (h) => Math.max(...h.held.map((a) => a.length));
    hit.sort((a, b) => Number(a.s.quiet) - Number(b.s.quiet) || longest(b) - longest(a) || a.i - b.i);
    hit[0].s.members.push(n);
    if (hit.length > 1) conflicts.push({ id: n.id, title: n.title, joined: hit[0].s.key, alsoHeld: hit.slice(1).map((h) => h.s.key) });
  }
  const subjects = subs.map((s) => {
    const members = [...s.members].sort((a, b) => b.buyers - a.buyers || a.id - b.id);
    const angles = members.filter((m) => m.buyers > 0);
    const buyers = members.every((m) => m.wallets) ? new Set(members.flatMap((m) => [...m.wallets])).size : null;
    const sumAngles = angles.reduce((x, m) => x + m.buyers, 0), largest = angles[0]?.buyers ?? 0;
    const ok = buyers == null ? null : largest <= buyers && buyers <= sumAngles && (siteBuyers == null || buyers <= siteBuyers);
    const share = buyers != null && siteBuyers ? buyers / siteBuyers : null;
    return {
      key: s.key, title: s.title, anchors: [...s.anchors], quiet: s.quiet, members: members.map((m) => ({ id: m.id, title: m.title, buyers: m.buyers })), angles: angles.length,
      buyers, sumAngles, largest, share, shows: angles.length >= 2 && (!s.quiet || (share != null && share >= quietShare)), ok,
    };
  });
  return { subjects, conflicts, siteBuyers, quietShare };
}

/**
 * New narratives (id above `after`) with buyers that joined no subject, most buyers first: possible misses, which need an
 * `include` or a new anchor (a title like "nvidia ceo gooner exposed" holds none of Jensen Huang's words).
 */
export function newLoose(narrs, result, after) {
  const joined = new Set(result.subjects.flatMap((s) => s.members.map((m) => m.id)));
  return narrs.filter((n) => n.id > after && n.buyers > 0 && !joined.has(n.id)).sort((a, b) => b.buyers - a.buyers || a.id - b.id).map((n) => ({ id: n.id, title: n.title, buyers: n.buyers }));
}

/** Checks the labels against a fold. Returns `{ pass, failures: [string] }`. */
export function checkLabels(result, labels) {
  const failures = [];
  const byKey = new Map(result.subjects.map((s) => [s.key, s]));
  const subjectOf = new Map(result.subjects.flatMap((s) => s.members.map((m) => [m.id, s.key])));
  for (const [key, l] of Object.entries(labels?.subjects ?? {})) {
    const s = byKey.get(key);
    if (!s) { failures.push(`${key}: no such subject in the table`); continue; }
    const ids = new Set(s.members.map((m) => m.id));
    for (const id of l.in ?? []) if (!ids.has(Number(id))) failures.push(`${key}: narrative ${id} should be in it${subjectOf.has(Number(id)) ? ` (it is in ${subjectOf.get(Number(id))})` : ""}`);
    for (const id of l.out ?? []) if (ids.has(Number(id))) failures.push(`${key}: narrative ${id} should not be in it`);
  }
  for (const id of labels?.none ?? []) if (subjectOf.has(Number(id))) failures.push(`narrative ${id} should stand alone (it is in ${subjectOf.get(Number(id))})`);
  for (const key of labels?.quiet ?? []) if (byKey.has(key) && !byKey.get(key).quiet) failures.push(`${key}: should be a quiet row`);
  for (const key of labels?.story ?? []) if (byKey.has(key) && byKey.get(key).quiet) failures.push(`${key}: should be a story row`);
  for (const key of [...(labels?.quiet ?? []), ...(labels?.story ?? [])]) if (!byKey.has(key)) failures.push(`${key}: no such subject in the table`);
  if (labels?.quiet || labels?.story) {
    const kinds = new Set([...(labels.quiet ?? []), ...(labels.story ?? [])]);
    for (const key of byKey.keys()) if (!kinds.has(key)) failures.push(`${key}: not labelled quiet or story`);
  }
  for (const key of labels?.absent ?? []) if (byKey.has(key)) failures.push(`${key}: should not be in the table`);
  const anchorsUsed = new Set(result.subjects.flatMap((s) => s.anchors));
  for (const w of labels?.neverAnchors ?? []) if (anchorsUsed.has(String(w).toLowerCase())) failures.push(`"${w}" is an anchor but must never be one`);
  for (const group of labels?.oneSubjectFor ?? []) {
    const keys = new Set(group.map((id) => subjectOf.get(Number(id)) ?? "none"));
    if (keys.size !== 1 || keys.has("none")) failures.push(`narratives ${group.join(", ")} should share one subject (they are in ${[...keys].join(", ")})`);
  }
  return { pass: failures.length === 0, failures };
}

/** Reads the narratives with their window's wallets from a read-only database. `untilT`/`hours`: the window. */
export function readNarratives(dbPath, { untilT = Math.floor(Date.now() / 1000), hours = 24 } = {}) {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'narratives'").get()) throw new Error("this database has no narratives table (the tagger has never run)");
    const sinceT = untilT - Math.round(hours * 3600);
    const ns = db.prepare("SELECT id, title, theme FROM narratives ORDER BY id").all();
    const coins = db.prepare("SELECT mint FROM coin_tags WHERE narrative_id = ?");
    const buys = db.prepare("SELECT DISTINCT user FROM trades WHERE mint = ? AND time >= ? AND time < ? AND is_buy = 1 AND value_usd >= 1");
    const narrs = ns.map((n) => {
      const wallets = new Set(), ms = coins.all(n.id).map((r) => r.mint);
      for (const m of ms) for (const r of buys.iterate(m, sinceT, untilT)) wallets.add(r.user);
      return { id: Number(n.id), title: n.title, theme: n.theme, coins: ms.length, buyers: wallets.size, wallets };
    });
    const siteBuyers = Number(db.prepare("SELECT COUNT(DISTINCT user) AS n FROM trades WHERE time >= ? AND time < ? AND is_buy = 1 AND value_usd >= 1").get(sinceT, untilT).n);
    return { sinceT, untilT, narrs, siteBuyers };
  } finally { db.close(); }
}

export function parseArgs(argv) {
  const o = { hours: 24, min: 3, json: false, at: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { o.json = true; continue; }
    const v = argv[++i];
    if (v == null) throw new Error(`${a} needs a value`);
    if (a === "--db") o.db = v;
    else if (a === "--hours") { o.hours = Number(v); if (!(o.hours > 0)) throw new Error("--hours must be above 0"); }
    else if (a === "--min") { o.min = Number(v); if (!(o.min >= 2)) throw new Error("--min must be 2 or more"); }
    else if (a === "--at") { o.at = Math.floor(Date.parse(v) / 1000); if (!Number.isFinite(o.at)) throw new Error("--at must be an ISO time"); }
    else if (a === "--anchors") o.anchors = v;
    else if (a === "--expect") o.expect = v;
    else if (a === "--quiet-share") { o.quietShare = Number(v); if (!(o.quietShare > 0 && o.quietShare < 1)) throw new Error("--quiet-share must be a fraction between 0 and 1 (0.03 = 3%)"); }
    else if (a === "--new-after") { o.newAfter = Number(v); if (!Number.isInteger(o.newAfter) || o.newAfter < 0) throw new Error("--new-after must be a narrative id"); }
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.db) throw new Error("--db <path to the server's sqlite file> is required");
  for (const f of ["expect", "quietShare", "newAfter"]) if (o[f] != null && !o.anchors) throw new Error(`--${f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs --anchors`);
  return o;
}

const pct = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const r = readNarratives(o.db, { untilT: o.at ?? undefined, hours: o.hours });
    const head = `window ${new Date(r.sinceT * 1000).toISOString()} .. ${new Date(r.untilT * 1000).toISOString()}: ${r.narrs.length} narratives, ${r.narrs.filter((n) => n.buyers > 0).length} with buyers; site buyers ${r.siteBuyers}`;
    if (!o.anchors) {
      const c = candidates(r.narrs, { min: o.min });
      if (o.json) console.log(JSON.stringify({ sinceT: r.sinceT, untilT: r.untilT, siteBuyers: r.siteBuyers, candidates: c }, null, 2));
      else {
        console.log(head);
        for (const x of c) console.log(`${x.word}${x.never ? ` [never: ${x.never}]` : ""}: ${x.n} narratives, ${x.buyers} buyers (${pct(x.buyers / r.siteBuyers)}), with ${x.coWords.slice(0, 5).join(" ") || "-"}${x.variants.length ? `, variants ${x.variants.join(" ")}` : ""}\n  ${x.members.slice(0, 6).map((m) => `#${m.id} "${m.title}" ${m.buyers}`).join(" | ")}`);
      }
    } else {
      const res = fold(r.narrs, JSON.parse(readFileSync(resolve(o.anchors), "utf8")), r.siteBuyers, { quietShare: o.quietShare });
      const chk = o.expect ? checkLabels(res, JSON.parse(readFileSync(resolve(o.expect), "utf8"))) : null;
      const fresh = (s) => (o.newAfter == null ? [] : s.members.filter((m) => m.id > o.newAfter));
      const loose = o.newAfter == null ? [] : newLoose(r.narrs, res, o.newAfter);
      if (o.json) console.log(JSON.stringify({ sinceT: r.sinceT, untilT: r.untilT, ...res, labels: chk, ...(o.newAfter != null ? { newAfter: o.newAfter, newMembers: Object.fromEntries(res.subjects.map((s) => [s.key, fresh(s)])), newLoose: loose } : {}) }, null, 2));
      else {
        console.log(`${head}; quiet rows show at ${pct(res.quietShare)} of site buyers`);
        const why = (s) => (s.shows ? "" : s.angles < 2 ? " (stays as cards: under 2 angles)" : ` (stays as cards: quiet, under ${pct(res.quietShare)})`);
        for (const s of res.subjects) {
          console.log(`\n${s.key} "${s.title}"${s.quiet ? " [quiet]" : ""}: ${s.members.length} narratives, ${s.angles} with buyers${why(s)}; ${s.buyers} buyers (${pct(s.share)}), angles sum ${s.sumAngles}, largest ${s.largest}${s.ok === false ? "  CHECK FAILED" : ""}`);
          console.log(`  ${s.members.filter((m) => m.buyers > 0).slice(0, 8).map((m) => `#${m.id} "${m.title}" ${m.buyers}`).join(" | ") || "-"}`);
          const f = fresh(s);
          if (f.length) console.log(`  new after #${o.newAfter}: ${f.map((m) => `#${m.id} "${m.title}" ${m.buyers}`).join(" | ")}`);
        }
        if (o.newAfter != null) console.log(`\nnew after #${o.newAfter} in no subject (${loose.length} with buyers): ${loose.slice(0, 20).map((m) => `#${m.id} "${m.title}" ${m.buyers}`).join(" | ") || "-"}`);
        if (res.conflicts.length) console.log(`\nconflicts (joined by the tie rule): ${res.conflicts.map((c) => `#${c.id} "${c.title}" -> ${c.joined} (also ${c.alsoHeld.join(", ")})`).join("; ")}`);
        if (chk) console.log(`\nlabels: ${chk.pass ? "PASS" : `FAIL\n  ${chk.failures.join("\n  ")}`}`);
      }
      if (chk && !chk.pass) process.exitCode = 2;
    }
  } catch (e) { console.error(`subject-replay: ${e.message}`); process.exit(1); }
}
