#!/usr/bin/env node
// Post lines, replayed: a LOG-ONLY tool the owner runs by hand before the new line rules go live. It reads every post
// the server has a stored line for (table post_lines: the OLD subject / happened / kind) from the server's sqlite file,
// opened READ-ONLY (this script never writes to it: the connection is read-only and query-only, and nothing here holds
// a write statement), runs each post through the NEW rules exactly as the server would (lib/post-lines.mjs: the same
// request and instructions, the same batches of 6, the same checks, the re-ask alone with the reason, the lines the
// server writes itself) and writes old and new side by side into one JSON file. Nothing it finds is stored anywhere else.
// (Run while the server is stopped, sqlite itself leaves an empty <file>-wal and a <file>-shm beside the database, as
// any reader of it does; the database file's bytes do not change.)
//
//   node --env-file=<server.env> scripts/post-lines-replay.mjs --db <spore.sqlite> --out <file.json> [--max-usd 1]
//        [--limit <n>] [--per-min 2] [--max-links 300] [--link-gap-ms 4000] [--dry-run]
//
// What it reads from the file: post_lines (the old lines), x_posts (each post's handle and text; a post that is itself
// quoted by another costs no request), the coins that link each post (a coin's metadata `twitter` or `website` naming
// the post's id, joined to its name and ticker through mints.uri; its parent's ticker from coins.quote_mint), the
// stored hint (the lead coin's narrative title) and, when the server has already read them, post_links.
// What it asks the network (the owner runs it; nothing is sent in a test or with --dry-run):
// - X, through lib/xposts.mjs kept in memory: for a post with a t.co link ONE request that reads only the redirect's
//   Location, and for a quoted post on X one read through the embed API. About one request every 4 s (--link-gap-ms),
//   at most 300 in all (--max-links). A link that cannot be read is not waited for.
// - The model, through lib/post-lines.mjs PostLines with a store in memory: the client, model, key file and prices are
//   the server's own settings (NARRATIVE_KEY_FILE, NARRATIVE_MODEL, NARRATIVE_IN_USD_PER_M / NARRATIVE_OUT_USD_PER_M,
//   read from the environment, so run it with --env-file). --max-usd (default 1) is a hard stop for the whole run: a
//   request is sent only when its worst case still fits, and one without an answer stays counted at its worst case.
// The key is read from the key file by the client and is never printed; a failed request is named by its class only.
// --dry-run sends nothing (no X request, no model request): it lists what would be asked and the server-written lines.
// --limit reads only the first n posts (oldest stored line first), for a small trial.
//
// The JSON: { at, db, model, rulesVersion, maxUsd, dryRun, stopped, totals, posts }. Per post: id, handle, text, words,
// old { subject, happened, kind, state }, state ("ok": a model line; "thin": the model found nothing stated;
// "rejected": its line failed the checks twice; "gave-up"; "server": no model call; "not_run": the run stopped first;
// "no_text": no stored post text), new (the line a card would show: the model's, the server's own, or null for no
// line), rejectReasons, source ("post" | "quoted" | "both"), chips, sourceCheck (the log-only clause check), link
// { state, kind, host }, quoted { id, handle, text } | null, chain, coins. totals: posts, requests, failedRequests,
// inputTokens, outputTokens, cacheReadTokens, usd, xRequests, and counts byState, byKind, bySource, byRejectReason.
import { DatabaseSync } from "node:sqlite";
import { accessSync, writeFileSync, mkdirSync, constants as FS } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PostLines, serverLine, planOf, wordCount, LINE_RULES_VERSION, BATCH, PER_MIN, CAPS } from "../lib/post-lines.mjs";
import { XPosts } from "../lib/xposts.mjs";
import { DEFAULT_MODEL, priceOf } from "../lib/narrtags.mjs";
import { flagText, postOf, postTime } from "../lib/narrative.mjs";
import { SOL_MINT } from "../lib/jupiter.mjs";

const DEFAULTS = { maxUsd: 1, perMin: PER_MIN, maxLinks: 300, linkGapMs: 4_000, dryRun: false };
const FLAGS = { "--db": "db", "--out": "out", "--max-usd": "maxUsd", "--limit": "limit", "--per-min": "perMin", "--max-links": "maxLinks", "--link-gap-ms": "linkGapMs" };
const NUMERIC = new Set(["maxUsd", "limit", "perMin", "maxLinks", "linkGapMs"]);
const ID_RE = /^[1-9]\d{0,18}$/;

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
    else o[k] = v;
  }
  if (!o.db) throw new Error("--db <path to the server's sqlite file> is required");
  if (!o.out) throw new Error("--out <file.json> is required");
  return o;
}

/** The model settings the server's post lines use, read from the environment the way lib/config.mjs reads them. Never the key itself. */
export function settingsOf(env = process.env) {
  const num = (k) => (env[k] != null && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : null);
  return { keyFile: env.NARRATIVE_KEY_FILE || null, model: env.NARRATIVE_MODEL || DEFAULT_MODEL, inUsdPerM: num("NARRATIVE_IN_USD_PER_M"), outUsdPerM: num("NARRATIVE_OUT_USD_PER_M") };
}

/** The store PostLines needs, in memory: the lines of this run and ONE spend sum for the whole run (the cap is --max-usd, whatever the day). */
class RunStore {
  constructor() { this.lines = new Map(); this.spend = { inTokens: 0, outTokens: 0, usd: 0, requests: 0 }; }
  lineGet(id) { return this.lines.get(id) ?? null; }
  lineSet(l) { this.lines.set(l.postId, { ...l, chips: Array.isArray(l.chips) ? l.chips : [] }); }
  lineCounts() { return { ok: 0, rejected: 0, gaveUp: 0, thin: 0 }; }
  lineRulesReset() { return { reset: false, from: LINE_RULES_VERSION, lines: 0 }; }
  spendGet() { return { ...this.spend }; }
  spendAdd(_day, { inTokens = 0, outTokens = 0, usd = 0, requests = 0 } = {}) { const s = this.spend; s.inTokens += inTokens; s.outTokens += outTokens; s.usd = Math.max(0, s.usd + usd); s.requests += requests; }
}

/** A stand-in client for --dry-run: it is never called (a dry run asks nothing), and says so if it ever were. */
const noClient = () => async () => { throw Object.assign(new Error("a dry run sends nothing"), { code: "DRY" }); };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = (m, k) => { m[k] = (m[k] ?? 0) + 1; };

/**
 * Runs the replay and returns its report (also written to `out`). `clientFactory` (the model client; tests pass a
 * fake), `fetch` (X; tests pass a fake), `sleep(ms)`, `now`, `print` and `env` are injectable. Without a clientFactory
 * the real client is made from the environment's settings (settingsOf). The database is only ever read.
 */
export async function runReplay(opts, { clientFactory = null, fetch = globalThis.fetch, sleep = sleepMs, now = Date.now, print = console.log, env = process.env } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const dbFile = resolve(o.db), outFile = resolve(o.out);
  if (outFile === dbFile || /\.sqlite(?:-wal|-shm)?$/i.test(outFile)) throw new Error("--out must be a JSON file of its own, never the database");
  const set = settingsOf(env), cfg = { on: true, keyFile: set.keyFile, model: set.model, dailyUsd: o.maxUsd, inUsdPerM: set.inUsdPerM, outUsdPerM: set.outUsdPerM };
  if (o.dryRun && !priceOf(cfg.model, cfg)) { cfg.inUsdPerM = 0; cfg.outUsdPerM = 0; } // nothing is sent: no price is needed
  if (!o.dryRun) {
    if (!priceOf(cfg.model, cfg)) throw new Error(`no price is known for model ${String(cfg.model).slice(0, 60)}: set NARRATIVE_IN_USD_PER_M and NARRATIVE_OUT_USD_PER_M as the server has them`);
    if (!clientFactory) {
      if (env.ANTHROPIC_CUSTOM_HEADERS) throw new Error("ANTHROPIC_CUSTOM_HEADERS is set in the environment: unset it first (its headers would go out with every request)");
      if (!cfg.keyFile) throw new Error("NARRATIVE_KEY_FILE is not set: run with --env-file=<the server's env file> (or use --dry-run)");
      try { accessSync(cfg.keyFile, FS.R_OK); } catch (e) { throw new Error(`NARRATIVE_KEY_FILE is not a readable file (${e.code ?? "error"})`); }
    }
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const report = { at: new Date(now()).toISOString(), db: dbFile, model: cfg.model, rulesVersion: LINE_RULES_VERSION, maxUsd: o.maxUsd, dryRun: !!o.dryRun, stopped: null, totals: null, posts: [] };
  try {
    db.exec("PRAGMA query_only = ON");
    const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has("post_lines") || !has("x_posts")) throw new Error("the database has no post_lines / x_posts table: nothing to replay");
    // ---- what the file holds
    let old = db.prepare("SELECT post_id, subject, happened, kind, state, coin FROM post_lines ORDER BY at ASC, post_id ASC").all().filter((r) => ID_RE.test(String(r.post_id)));
    if (o.limit > 0) old = old.slice(0, Math.floor(o.limit));
    const wanted = new Set(old.map((r) => String(r.post_id)));
    const postQ = db.prepare("SELECT id, state, handle, text, flagged, fetched_at, asked_at, recheck_at FROM x_posts WHERE id = ?");
    const linkQ = has("post_links") ? db.prepare("SELECT post_id, to_kind, to_post_id, host, tries, next_try_at, at FROM post_links WHERE post_id = ?") : null;
    // The coins that link each post: one pass over the metadata that names a post, one over the mints for their names.
    const uris = new Map(); // uri → { id, description }
    for (const m of db.prepare("SELECT uri, description, twitter, website FROM meta WHERE twitter LIKE '%status%' OR website LIKE '%status%'").iterate()) {
      const id = postOf({ twitter: m.twitter, website: m.website });
      if (id && wanted.has(id)) uris.set(m.uri, { id, description: m.description ?? null });
    }
    const coinsOf = new Map(); // post id → [{ mint, name, symbol, parent, text }]
    if (uris.size) {
      const coinQ = has("coins") ? db.prepare("SELECT quote_mint FROM coins WHERE mint = ?") : null, nameQ = db.prepare("SELECT symbol FROM mints WHERE mint = ?");
      for (const m of db.prepare("SELECT mint, name, symbol, uri FROM mints WHERE uri IS NOT NULL").iterate()) {
        const u = uris.get(m.uri);
        if (!u) continue;
        const q = coinQ?.get(m.mint)?.quote_mint ?? null;
        const parent = q && q !== SOL_MINT ? nameQ.get(q)?.symbol ?? null : null;
        let l = coinsOf.get(u.id);
        if (!l) coinsOf.set(u.id, l = []);
        l.push({ mint: m.mint, name: m.name ?? null, symbol: m.symbol ?? null, parent, text: u.description });
      }
    }
    const hintQ = has("coin_tags") && has("narratives") ? db.prepare("SELECT n.title AS title FROM coin_tags t JOIN narratives n ON n.id = t.narrative_id WHERE t.mint = ?") : null;
    // ---- X, in memory: reads come from the file, writes stay in this process
    const store = {
      kvGet: () => null, kvSet() {}, xpostSet() {}, xpostDel() {}, xpostTouchMany: () => 0, xpostPrune: () => 0, xpostCount: () => 0, linkSet() {}, linkPrune: () => 0,
      xpostGet: (id) => { const r = postQ.get(id); return r ? { id: r.id, state: r.state, handle: r.handle, text: r.text, flagged: !!r.flagged, fetchedAt: r.fetched_at, askedAt: r.asked_at, recheckAt: Number.MAX_SAFE_INTEGER } : null; },
      linkGet: (id) => { const r = linkQ?.get(id); return r ? { postId: r.post_id, kind: r.to_kind ?? null, toId: r.to_post_id ?? null, host: r.host ?? null, tries: r.tries, nextTryAt: r.next_try_at, at: r.at } : null; },
    };
    const perMin = Math.max(1, Math.round(60_000 / Math.max(500, o.linkGapMs)));
    // Link and quoted-post reads are the low class: they stop at half the day, so the day is twice --max-links.
    const xp = new XPosts({ perMin, daily: Math.max(2, Math.floor(o.maxLinks) * 2), db: store, fetch: o.dryRun ? async () => { throw new Error("a dry run sends nothing"); } : fetch, now, sleep: (ms) => sleep(ms), log: { info() {}, warn() {} }, flag: (t) => flagText(t) });
    const quiet = { info() {}, warn: (m) => print(String(m)) };
    const posts = old.map((r) => {
      const id = String(r.post_id), p = xp.peek(id);
      const coins = [...(coinsOf.get(id) ?? [])].sort((a, b) => (b.mint === r.coin) - (a.mint === r.coin) || (a.mint < b.mint ? -1 : 1));
      return { id, old: { subject: r.subject ?? null, happened: r.happened ?? null, kind: r.kind ?? null, state: r.state }, post: p && p.state === "ok" && !p.flagged && typeof p.text === "string" ? { handle: p.handle ?? "", text: p.text, at: postTime(id, now()) } : null, coins, lead: coins[0]?.mint ?? (typeof r.coin === "string" ? r.coin : null) };
    });
    const live = posts.filter((p) => p.post);
    print(`post lines replay${o.dryRun ? " (DRY RUN: nothing is sent to X or to a model)" : ""}: ${posts.length} stored lines, ${live.length} with their post's text, under line rules version ${LINE_RULES_VERSION}, model ${cfg.model}, at most $${o.maxUsd}`);
    // ---- the quoted posts: every link's redirect, then the quoted post's text, a few at a time, until nothing moves
    if (!o.dryRun) {
      let pauses = 0;
      for (let round = 0; round < 200; round++) {
        let waiting = 0;
        for (const p of live) if (xp.quoteOf(p.id).state === "wait") waiting++;
        const before = xp.snapshot().callsToday;
        await xp.idle();
        const s = xp.snapshot();
        if (!waiting) break;
        if (s.callsToday === before) {
          // nothing went out: the reads are paused (wait it out, three times at most), or the run's requests are used up
          const pause = Math.max(s.pausedMs, s.links.pausedMs);
          if (pause > 0 && pauses++ < 3) { print(`  X asked for a pause: waiting ${Math.round(pause / 1000)} s`); await sleep(pause + 100); continue; }
          break;
        }
        print(`  links: ${s.links.calls} read, ${s.callsToday} requests to X so far, ${waiting} posts were still waiting`);
      }
    }
    // ---- the model, exactly as the server runs it: the same PostLines, a store in memory
    const results = new Map();
    const lines = new PostLines({ db: new RunStore(), cfg, on: true, clientFactory: clientFactory ?? (o.dryRun ? noClient() : null), now, perMin: Math.max(1, o.perMin), fillMs: 0, log: quiet, onResult: (r) => results.set(r.id, r) });
    if (!lines.on) throw new Error("the post lines could not start with these settings (see the line above)");
    const cards = new Map();
    for (const p of live) {
      const q = xp.quoteOf(p.id, { queue: false });
      const hint = p.lead && hintQ ? hintQ.get(p.lead)?.title ?? null : null;
      const info = { mint: p.lead, handle: p.post.handle, text: p.post.text, at: p.post.at, link: { state: q.state === "wait" ? "unread" : q.state, kind: q.kind }, quoted: q.quoted, chain: q.chain, coins: p.coins.slice(0, CAPS.coins).map((c) => ({ name: c.name, symbol: c.symbol, parent: c.parent, text: c.text })), hint };
      const all = p.coins.map((c) => ({ name: c.name, symbol: c.symbol, parent: c.parent }));
      const own = () => serverLine({ post: { text: p.post.text }, linkKind: q.kind, linkHost: q.host ?? null, coins: all, title: hint, titleAi: !!hint, grouped: false, familySymbol: null });
      cards.set(p.id, { q, info, own, plan: planOf(info), offered: o.dryRun ? (planOf(info).ask ? "would_ask" : "server") : lines.offer(p.id, info) });
    }
    const asked = [...cards.values()].filter((c) => c.offered === "queued").length;
    if (!o.dryRun && asked) {
      print(`  ${asked} posts go to the model in batches of ${BATCH}, ${lines.perMin} requests a minute; ${live.length - asked} are the server's own (no model call)`);
      let fails = 0, lastFailed = 0, lastReq = -1;
      while (lines.pending() > 0) {
        await lines.pump();
        const s = lines.snapshot();
        if (lines.pending() === 0) break;
        if (lines.capped()) { report.stopped = "max_usd"; break; }
        // a setting, not a post: the key, the account, the model's name or the request itself. Waiting does not mend it.
        if (["auth", "billing", "model_not_found", "bad_request", "no_client"].includes(s.lastError)) { report.stopped = s.lastError; break; }
        if (s.failed > lastFailed) { lastFailed = s.failed; if (++fails > 8) { report.stopped = s.lastError ?? "failed"; break; } }
        if (s.requests !== lastReq) { lastReq = s.requests; print(`  model: ${s.requests} requests, ${results.size} of ${asked} posts settled, $${s.usdToday.toFixed(4)}`); }
        await sleep(Math.max(250, lines.pausedMs(), lines.rateWaitMs()));
      }
    }
    lines.stop(); xp.stop();
    // ---- the report
    const totals = { posts: posts.length, withText: live.length, askedModel: asked, requests: 0, failedRequests: 0, unusableReplies: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, usd: 0, xRequests: 0, links: null, sourceCheckWeak: 0, byState: {}, byKind: {}, bySource: {}, byRejectReason: {}, byOldKind: {}, noLine: 0 };
    for (const p of posts) {
      const c = cards.get(p.id) ?? null, r = results.get(p.id) ?? null;
      const row = { id: p.id, handle: p.post?.handle ?? null, text: p.post?.text ?? null, words: p.post ? wordCount(p.post.text) : 0, old: p.old, state: null, new: null, rejectReasons: [], source: null, chips: [], sourceCheck: null,
        link: c ? { state: c.q.state, kind: c.q.kind, host: c.q.host } : null, quoted: c?.q.quoted ? { id: c.q.quoted.id, handle: c.q.quoted.handle, text: c.q.quoted.text } : null, chain: c?.q.chain ? { id: c.q.chain.id, handle: c.q.chain.handle, text: c.q.chain.text } : null,
        coins: p.coins.map((k) => ({ mint: k.mint, name: k.name, symbol: k.symbol, parent: k.parent })) };
      if (!c) row.state = "no_text";
      else if (r) {
        row.state = r.state; row.rejectReasons = r.reasons; row.tries = r.tries ?? []; row.source = r.source; row.chips = r.chips; row.sourceCheck = r.clauses;
        // what a card shows: the model's line, else what the server writes itself for a post settled without one
        row.new = r.state === "ok" ? { ...r.line, by: "model" } : c.own();
        if (r.clauses?.some((x) => !x.ok)) totals.sourceCheckWeak++;
      } else if (c.offered === "server") { row.state = "server"; row.new = c.own(); }
      else { row.state = c.offered === "would_ask" ? "would_ask" : "not_run"; }
      if (row.new) { row.chips = row.new.chips ?? row.chips; row.new = { subject: row.new.subject, happened: row.new.happened, kind: row.new.kind, by: row.new.by ?? "model", quote: !!row.new.quote }; }
      else if (c && row.state !== "not_run" && row.state !== "would_ask") totals.noLine++;
      tally(totals.byState, row.state); tally(totals.byOldKind, p.old.kind ?? p.old.state);
      if (row.new) tally(totals.byKind, row.new.by === "server" ? (row.new.quote ? "server:quote" : "server") : row.new.kind);
      if (row.source) tally(totals.bySource, row.source);
      for (const why of row.rejectReasons) tally(totals.byRejectReason, why);
      report.posts.push(row);
    }
    const s = lines.snapshot(), x = xp.snapshot();
    Object.assign(totals, { requests: s.requests, failedRequests: s.failed, unusableReplies: s.malformed, inputTokens: s.inTokens, outputTokens: s.outTokens, cacheReadTokens: s.cacheReadTokens, usd: Math.round(s.usdToday * 1e6) / 1e6, xRequests: x.callsToday, links: { read: x.links.calls, posts: x.links.posts, articles: x.links.articles, websites: x.links.websites, pictures: x.links.pictures, unread: x.links.unread } });
    report.totals = totals;
  } finally { db.close(); }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 1));
  const t = report.totals, list = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  print(`posts: ${t.posts} (${t.withText} with text); by outcome: ${list(t.byState)}${report.stopped ? `; stopped early: ${report.stopped}` : ""}`);
  print(`lines a card would show: ${list(t.byKind)}; no line at all: ${t.noLine}`);
  print(`model: ${t.requests} requests (${t.failedRequests} failed, ${t.unusableReplies} unusable replies), ${t.inputTokens} tokens in (${t.cacheReadTokens} from cache), ${t.outputTokens} out, $${t.usd.toFixed(4)}${t.failedRequests ? " (a request without an answer is counted at its worst case)" : ""}`);
  print(`X: ${t.xRequests} requests (${t.links.read} links read: ${t.links.posts} posts, ${t.links.articles} articles, ${t.links.websites} websites, ${t.links.pictures} pictures, ${t.links.unread} unread)`);
  print(`refused by the checks: ${list(t.byRejectReason)}; lines with a clause the log-only source check doubts: ${t.sourceCheckWeak}`);
  print(`written: ${outFile}`);
  print("The lines are a language model's summaries of what strangers posted. They can be wrong, and they say nothing about any coin's price.");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`post-lines-replay: ${e.message}`); process.exit(2); }
  runReplay(opts).then(() => process.exit(0), (e) => { console.error(`post-lines-replay: ${String(e?.message ?? e).slice(0, 300)}`); process.exit(1); });
}
