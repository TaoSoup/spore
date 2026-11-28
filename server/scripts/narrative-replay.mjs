#!/usr/bin/env node
// Narrative replay: a measurement tool the owner runs by hand. It reads coins from the server's sqlite file (opened
// READ-ONLY: this script never writes to it), runs them through the same tagging path the server uses
// (lib/narrtags.mjs TagEngine: same request and instructions, same boilerplate stripping, same checks on the reply,
// the empty-coin guard and the one-time retitle included) with the narratives kept in memory, in creation
// order, and reports what the grouping looks like and what it cost. Nothing it finds is stored anywhere but --out.
//
//   node scripts/narrative-replay.mjs --db <path to spore.sqlite> --key-file <path> --out <dir>
//        [--model claude-haiku-5-5] [--hours 24] [--max-coins 1500] [--max-usd 0.50] [--min-buyers 10]
//        [--per-min 20] [--in-usd-per-m <n> --out-usd-per-m <n>] [--until <unix seconds>] [--also <mint[,mint...]>]
//        [--dry-run]
//
// --until ends the window at that time instead of at the newest coin in the file, so two runs over a growing file read
// the same coins. --also names up to 50 extra coins that are read AFTER the window's coins, whatever their creation
// time or buyers (as a coin that shows up on the page later would be); the report says where each landed. A mint that
// is not in the file is reported and skipped. They cost like any coin and count toward --max-usd.
// --max-usd is a hard stop for the whole run, also across a UTC midnight: a request is sent only when its worst case
// still fits, and a request that got no answer (a timeout, a dropped connection) stays counted at its worst case,
// because it may have been billed. With ANTHROPIC_CUSTOM_HEADERS set nothing is sent. --dry-run sends nothing (a stand-in
// client answers "none" for every coin), so it shows which coins would be read and roughly how many tokens that is.
// The key is read from --key-file by the client and is never printed; a failed request is named by its class only.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, accessSync, constants as FS } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TagEngine, MemoryTagStore, anthropicClientFactory, estimateInputTokens, priceOf, DEFAULT_MODEL, BATCH, userText } from "../lib/narrtags.mjs";
import { postOf } from "../lib/narrative.mjs";
import { SOL_MINT } from "../lib/jupiter.mjs";

const DEFAULTS = { model: DEFAULT_MODEL, hours: 24, maxCoins: 1500, maxUsd: 0.5, minBuyers: 10, perMin: 20, dryRun: false };
const FLAGS = { "--db": "db", "--key-file": "keyFile", "--model": "model", "--hours": "hours", "--max-coins": "maxCoins", "--max-usd": "maxUsd", "--out": "out", "--min-buyers": "minBuyers", "--per-min": "perMin", "--in-usd-per-m": "inUsdPerM", "--out-usd-per-m": "outUsdPerM", "--until": "until", "--also": "also" };
const NUMERIC = new Set(["hours", "maxCoins", "maxUsd", "minBuyers", "perMin", "inUsdPerM", "outUsdPerM"]);
/** --also: extra coins at most. */
export const ALSO_MAX = 50;
/** The mints of an --also value (a comma-separated string, or an array): trimmed, each once, in the order given. Throws for a bad one. */
export function alsoList(v) {
  const list = [...new Set((Array.isArray(v) ? v : String(v ?? "").split(",")).map((m) => String(m).trim()).filter(Boolean))];
  for (const m of list) if (!/^[A-Za-z0-9]{1,64}$/.test(m)) throw new Error("--also takes mint addresses separated by commas");
  if (list.length > ALSO_MAX) throw new Error(`--also takes at most ${ALSO_MAX} coins`);
  return list;
}

/** The options of a command line; throws with a readable message for a bad one. */
export function parseArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v = null;
    if (a === "--dry-run") { o.dryRun = true; continue; }
    const eq = a.indexOf("=");
    if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    if (!Object.hasOwn(FLAGS, a)) throw new Error(`unknown option ${a}`);
    if (v == null) v = argv[++i];
    if (v == null || v === "") throw new Error(`${a} needs a value`);
    const k = FLAGS[a];
    if (NUMERIC.has(k)) { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${a} must be a number ≥ 0`); o[k] = n; }
    else if (k === "until") { const n = Number(v); if (!Number.isInteger(n) || n <= 0 || n >= 1e11) throw new Error("--until must be a time in unix seconds"); o.until = n; }
    else if (k === "also") o.also = alsoList([...(o.also ?? []), ...String(v).split(",")]);
    else o[k] = v;
  }
  if (!o.db) throw new Error("--db <path to the server's sqlite file> is required");
  if (!o.out) throw new Error("--out <dir> is required");
  if (!o.dryRun && !o.keyFile) throw new Error("--key-file <path> is required (or --dry-run)");
  if (!(o.hours > 0)) throw new Error("--hours must be above 0");
  o.maxCoins = Math.floor(o.maxCoins); o.minBuyers = Math.max(1, Math.floor(o.minBuyers)); o.perMin = Math.max(1, o.perMin);
  return o;
}

/** A client that asks nobody: every coin "none", with a rough token count as its usage. */
const dryClientFactory = () => async () => ({ messages: { create: async (req) => {
  const n = (userText(req.messages[0]).match(/^\{"n":/gm) ?? []).length;
  return { stop_reason: "end_turn", usage: { input_tokens: estimateInputTokens(req), output_tokens: 12 * n + 8 }, content: [{ type: "text", text: JSON.stringify({ coins: Array.from({ length: n }, (_, i) => ({ n: i + 1, kind: "none", id: 0, title: "", theme: "other", retitle: "" })) }) }] };
} } });

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** One bad coin fails its batch of 20 and each half down to itself: 6 unusable replies in a row. More than that ends the run. */
const BAD_RUN_STOP = 8;
/** The tag store of a run: its spend is one sum for the whole run (the engine's cap is per day; here the day never changes). */
class RunStore extends MemoryTagStore {
  spendGet() { return super.spendGet("run"); }
  spendAdd(_day, d) { super.spendAdd("run", d); }
}

/**
 * Runs the replay and returns its report (also written to <out>/replay.json). `clientFactory` (tests), `print`,
 * `sleep` and `now` are injectable; without a clientFactory the real client is used, or the stand-in with dryRun.
 */
export async function runReplay(opts, { clientFactory = null, print = console.log, sleep = sleepMs, now = Date.now } = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (o.until != null && !(Number.isInteger(o.until) && o.until > 0)) throw new Error("--until must be a time in unix seconds");
  const also = alsoList(o.also ?? []);
  const price = priceOf(o.model, o);
  if (!price) throw new Error(`no price is known for model ${o.model}: give --in-usd-per-m and --out-usd-per-m`);
  if (!clientFactory && !o.dryRun && process.env.ANTHROPIC_CUSTOM_HEADERS) throw new Error("ANTHROPIC_CUSTOM_HEADERS is set in the environment: unset it first (its headers would go out with every request)");
  if (!clientFactory && !o.dryRun) { try { accessSync(o.keyFile, FS.R_OK); } catch (e) { throw new Error(`--key-file is not a readable file (${e.code ?? "error"})`); } }
  const db = new DatabaseSync(resolve(o.db), { readOnly: true });
  let report;
  try {
    db.exec("PRAGMA query_only = ON");
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    // The window ends at the newest coin in the file (a copy of the database may be hours old), or at --until.
    const end = o.until ?? Number(db.prepare("SELECT MAX(created_at) AS t FROM coins").get()?.t ?? 0);
    if (!end) throw new Error("the database has no dated coins");
    const from = end - Math.round(o.hours * 3600);
    // One ordered pass over the window's coins (the coins_created index); per coin its distinct $1+ buyers are counted
    // on the (mint, time) index and the count stops at the bar.
    const buyersQ = db.prepare("SELECT COUNT(*) AS n FROM (SELECT DISTINCT user FROM trades WHERE mint = ? AND is_buy = 1 AND value_usd >= 1 LIMIT ?)");
    // As on the server, only a coin of the index is a parent (not USDC or another plain quote asset): one primary-key lookup.
    const isCoinQ = db.prepare("SELECT 1 AS x FROM coins WHERE mint = ?");
    const eligible = [];
    let created = 0;
    for (const c of db.prepare("SELECT mint, created_at, quote_mint FROM coins WHERE created_at > ? AND created_at <= ? AND tracked = 1 ORDER BY created_at ASC, mint ASC").iterate(from, end)) {
      created++;
      if (Number(buyersQ.get(c.mint, o.minBuyers).n) >= o.minBuyers) eligible.push({ mint: c.mint, createdAt: Number(c.created_at), parent: c.quote_mint && c.quote_mint !== SOL_MINT && isCoinQ.get(c.quote_mint) ? c.quote_mint : null });
    }
    // The newest --max-coins of them, still in creation order, so narratives build up as they would live.
    const picked = eligible.slice(Math.max(0, eligible.length - o.maxCoins));
    // --also: coins read after the window's, whatever their creation time or buyers. One already among the window's
    // coins is not read twice; one that is not in the file is reported and skipped.
    const inWindow = new Set(picked.map((c) => c.mint)), alsoQ = db.prepare("SELECT mint, created_at, quote_mint FROM coins WHERE mint = ?");
    const extra = [], alsoRows = [];
    for (const m of also) {
      const c = alsoQ.get(m);
      alsoRows.push({ mint: m, found: !!c, inWindow: inWindow.has(m) });
      if (c && !inWindow.has(m)) extra.push({ mint: c.mint, createdAt: Number(c.created_at), parent: c.quote_mint && c.quote_mint !== SOL_MINT && isCoinQ.get(c.quote_mint) ? c.quote_mint : null });
    }
    const mintQ = db.prepare("SELECT name, symbol, uri FROM mints WHERE mint = ?"), metaQ = db.prepare("SELECT description, twitter, website FROM meta WHERE uri = ?");
    const postQ = has("x_posts") ? db.prepare("SELECT state, handle, text, flagged FROM x_posts WHERE id = ?") : null;
    const store = new RunStore();
    const describe = (c) => {
      const m = mintQ.get(c.mint) ?? {}, meta = m.uri ? metaQ.get(m.uri) ?? null : null;
      let post = null;
      const pid = postOf(meta);
      if (pid && postQ) { const p = postQ.get(pid); if (p && p.state === "ok" && !p.flagged && p.text) post = { handle: p.handle, text: p.text }; }
      let parent = null;
      if (c.parent) { const pm = mintQ.get(c.parent) ?? {}; const pt = store.tagGet(c.parent); parent = { name: pm.name ?? null, symbol: pm.symbol ?? null, narrative: pt?.narrativeId != null ? store.narrGet(pt.narrativeId)?.title ?? null : null }; }
      return { mint: c.mint, name: m.name ?? null, symbol: m.symbol ?? null, description: meta?.description ?? null, website: meta?.website ?? null, twitter: meta?.twitter ?? null, post, parent, asks: 0, createdAt: c.createdAt };
    };
    const quietLog = { info() {}, warn: (m) => print(String(m)) };
    const engine = new TagEngine({ store, model: o.model, clientFactory: clientFactory ?? (o.dryRun ? dryClientFactory() : anthropicClientFactory(o.keyFile)), dailyUsd: o.maxUsd, perMin: o.dryRun ? 1e6 : o.perMin, price: o, badRunPause: BAD_RUN_STOP, now, log: quietLog });
    print(`narrative replay${o.dryRun ? " (DRY RUN: nothing is sent to a model)" : ""}: ${created} tracked coins created in the ${o.hours} h before ${new Date(end * 1000).toISOString()}${o.until != null ? " (--until)" : ""}, ${eligible.length} with ${o.minBuyers}+ buyers, reading the newest ${picked.length}${also.length ? ` and then ${extra.length} of the ${also.length} --also coins` : ""} with model ${o.model}, at most $${o.maxUsd}`);
    const names = new Map(), gaveUp = [];
    let stopped = null, read = 0, alsoRead = 0, pauses = 0;
    // A batch whose reply was not the expected JSON is split in two and asked again; a single coin that fails is left out.
    // The --also coins come last, in batches of their own, so every window coin was read before the first of them.
    const work = [];
    for (let i = 0; i < picked.length; i += BATCH) work.push(picked.slice(i, i + BATCH));
    for (let i = 0; i < extra.length; i += BATCH) work.push(extra.slice(i, i + BATCH));
    const t0 = now();
    while (work.length && !stopped) {
      const part = work.shift(), batch = part.map(describe);
      for (const d of batch) names.set(d.mint, { name: d.name, symbol: d.symbol });
      const r = await engine.tag(batch);
      if (r.ok) { for (const m of r.done.keys()) { if (inWindow.has(m)) read++; else alsoRead++; } for (const m of r.missed) gaveUp.push(m); continue; }
      if (r.why === "rate" || r.why === "paused") { work.unshift(part); await sleep(r.waitMs ?? 1000); continue; }
      if (r.why === "capped") { stopped = "capped"; break; }
      // Unusable replies one after another, more than one bad coin's halving makes: the model or a setting, not a coin. Stop paying for it.
      if (r.why === "malformed" && r.systemic) { stopped = r.cls === "malformed" ? "unusable_replies" : r.cls; break; }
      if (r.why === "malformed" || r.why === "too_large") { if (part.length > 1) { const h = Math.ceil(part.length / 2); work.unshift(part.slice(0, h), part.slice(h)); } else gaveUp.push(part[0].mint); continue; }
      if (["auth", "billing", "model_not_found", "bad_request", "no_client", "no_price", "store"].includes(r.why)) { stopped = r.why; break; }
      // rate limited, overloaded, a server or network error: the engine paused itself; try again after it, a few times
      if (++pauses > 8) { stopped = r.why; break; }
      work.unshift(part);
    }
    // The run's cost is what the cap went by: real usage, and the worst case of any request that got no answer.
    const s = engine.stats, secs = Math.max(1, (now() - t0) / 1000), usdRun = store.spendGet().usd;
    // The counts and shares are the window's coins only, so a run with --also compares with one without; the groups
    // list every coin filed, an --also coin marked `also: true`.
    const byNarr = new Map();
    let none = 0;
    for (const t of store.tags.values()) { if (t.narrativeId == null) { if (inWindow.has(t.mint)) none++; continue; } let l = byNarr.get(t.narrativeId); if (!l) byNarr.set(t.narrativeId, l = []); l.push(t.mint); }
    const narrs = [...byNarr].map(([id, mints]) => ({ ...store.narrGet(id), coins: mints.map((m) => ({ mint: m, ...names.get(m), ...(inWindow.has(m) ? {} : { also: true }) })) })).sort((a, b) => b.coins.length - a.coins.length || a.id - b.id);
    const tagged = read - none, perCoin = read + alsoRead ? usdRun / (read + alsoRead) : 0;
    // Where each --also coin landed: under a narrative (`title`), "none", or not read (not in the file, the run stopped first, or its reply could not be used).
    const alsoOut = alsoRows.map((a) => {
      const t = a.found ? store.tagGet(a.mint) : null, m = a.found ? mintQ.get(a.mint) ?? {} : {};
      const n = t?.narrativeId != null ? store.narrGet(t.narrativeId) : null;
      return { mint: a.mint, name: m.name ?? null, symbol: m.symbol ?? null, found: a.found, inWindow: a.inWindow, read: !!t, title: n?.title ?? null, theme: n?.theme ?? null, line: t?.line ?? null };
    });
    // "A day at that rate": every coin that met the bar in the window, scaled to 24 h, at this run's cost per coin.
    const perDay = perCoin * eligible.length * (24 / o.hours);
    report = {
      at: new Date(now()).toISOString(), dryRun: !!o.dryRun, model: o.model, hours: o.hours, minBuyers: o.minBuyers, maxUsd: o.maxUsd, windowEnd: end, until: o.until ?? null,
      coinsCreated: created, coinsEligible: eligible.length, coinsPicked: picked.length, coinsRead: read, alsoRead, coinsLeftOut: gaveUp.length, stopped,
      requests: s.requests, failedRequests: s.failed, malformedReplies: s.malformed, inputTokens: s.inTokens, outputTokens: s.outTokens, cacheReadTokens: s.cacheReadTokens,
      usd: usdRun, usdPerCoin: perCoin, usdPerDayAtThisRate: perDay, seconds: Math.round(secs),
      tagged, none, taggedShare: read ? tagged / read : 0, narratives: narrs.length, merged: s.merged,
      forcedNone: s.forcedNone, retitled: s.retitled, retitleRefused: s.retitleRefused,
      price: { inUsdPerM: price.inUsdPerM, outUsdPerM: price.outUsdPerM },
      groups: narrs, noneCoins: [...store.tags.values()].filter((t) => t.narrativeId == null && inWindow.has(t.mint)).map((t) => ({ mint: t.mint, ...names.get(t.mint) })),
      also: alsoOut,
    };
  } finally { db.close(); }
  mkdirSync(resolve(o.out), { recursive: true });
  const file = join(resolve(o.out), "replay.json");
  writeFileSync(file, JSON.stringify(report, null, 1));
  const r = report, usd = (x) => `$${x.toFixed(4)}`, pct = (x) => `${(x * 100).toFixed(1)} %`;
  print(`coins read: ${r.coinsRead} of ${r.coinsPicked}${r.also.length ? ` (and ${r.alsoRead} --also coins after them)` : ""}${r.coinsLeftOut ? ` (${r.coinsLeftOut} left out after replies that could not be used)` : ""}${r.stopped ? `; stopped early: ${r.stopped}` : ""}`);
  print(`requests: ${r.requests} (${r.failedRequests} failed, ${r.malformedReplies} unusable replies), ${r.seconds} s`);
  print(`tokens: ${r.inputTokens} in (${r.cacheReadTokens} read from cache), ${r.outputTokens} out${r.dryRun ? " (rough estimates: nothing was sent)" : ""}`);
  print(`cost: ${usd(r.usd)}${r.failedRequests ? " (a request without an answer is counted at its worst case)" : ""} (${r.coinsRead + r.alsoRead ? `$${r.usdPerCoin.toFixed(6)}` : "-"} a coin) at $${r.price.inUsdPerM} / $${r.price.outUsdPerM} per million tokens in / out`);
  print(`projected a day at this rate: ${usd(r.usdPerDayAtThisRate)} (${r.coinsEligible} coins met the bar in ${r.hours} h)`);
  print(`tagged: ${r.tagged} (${pct(r.taggedShare)}), none: ${r.none} (${pct(r.coinsRead ? r.none / r.coinsRead : 0)}); narratives: ${r.narratives} (${r.merged} titles merged into an existing one)`);
  print(`guards: ${r.forcedNone} coins with no text stored as none (the model filed them under a title that does not name them); wider titles: ${r.retitled} applied, ${r.retitleRefused} refused`);
  const label = (c) => `${c.name ?? "?"}${c.symbol ? ` (${c.symbol})` : ""}`.replace(/\s+/g, " ").slice(0, 60);
  if (r.also.length) print("");
  for (const a of r.also) {
    if (!a.found) { print(`also: ${a.mint} is not in the file (skipped)`); continue; }
    const who = `${a.name ?? a.mint}${a.symbol ? ` ($${a.symbol})` : ""}`.replace(/\s+/g, " ").slice(0, 60);
    print(`also: ${who} -> ${a.title ?? (a.read ? "none" : "not read")}${a.inWindow ? " (one of the window's coins: read in its place there)" : ""}`);
  }
  if (r.groups.length) print("\nthe largest narratives:");
  for (const g of r.groups.slice(0, 25)) print(`  ${String(g.coins.length).padStart(4)}  [${g.theme}] ${g.title}: ${g.coins.slice(0, 12).map(label).join(", ")}${g.coins.length > 12 ? ", ..." : ""}`);
  const singles = r.groups.filter((g) => g.coins.length === 1);
  for (let i = singles.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [singles[i], singles[j]] = [singles[j], singles[i]]; }
  if (singles.length) print(`\n${Math.min(20, singles.length)} of the ${singles.length} narratives with one coin:`);
  for (const g of singles.slice(0, 20)) print(`        [${g.theme}] ${g.title}: ${label(g.coins[0])}`);
  print(`\nwritten: ${file}`);
  print("The grouping is a language model's reading of public coin text. It can be wrong, and it says nothing about any coin's price.");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`narrative-replay: ${e.message}`); process.exit(2); }
  runReplay(opts).then(() => process.exit(0), (e) => { console.error(`narrative-replay: ${String(e?.message ?? e).slice(0, 300)}`); process.exit(1); });
}
