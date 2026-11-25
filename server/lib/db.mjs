// Persistence on node:sqlite (built in, no native module). The in-memory model (model.mjs) is the
// working set; this layer is the write-through store that makes restarts cheap: coins, mints and
// metadata come back from disk and the backfill continues where it stopped.
//
// Every u64 is stored as a decimal TEXT string: JS numbers lose precision above 2^53 and sqlite's
// INTEGER would silently round. Prices (REAL) are derived values and may lose precision freely.
import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 3;
/** Trade retention per mint (insertTrade): its newest TRADE_KEEP rows whatever their age, and every row of the last TRADE_DAY_S. */
export const TRADE_KEEP = 2000, TRADE_DAY_S = 86_400;

/** The calibration log's columns (story attention, lib/attention.mjs); keyed time first (migrate: a close's rows share a bucket time). */
const CALIB_COLS = `story_key TEXT NOT NULL, t INTEGER NOT NULL, phase TEXT NOT NULL, multiple REAL, buyers5m INTEGER NOT NULL, hour_buyers INTEGER NOT NULL,
  leader_mint TEXT, leader_price_usd REAL, story_buy_usd REAL NOT NULL,
  buyers_1h INTEGER, price_1h REAL, filled_1h INTEGER NOT NULL DEFAULT 0,
  buyers_6h INTEGER, price_6h REAL, filled_6h INTEGER NOT NULL DEFAULT 0, cov_1h INTEGER, cov_6h INTEGER`;
const CALIB_INDEXES = "CREATE INDEX IF NOT EXISTS calib_due1 ON calib(t) WHERE filled_1h = 0; CREATE INDEX IF NOT EXISTS calib_due6 ON calib(t) WHERE filled_6h = 0;";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backfill_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mints (
  mint TEXT PRIMARY KEY, decimals INTEGER, token_program TEXT, supply TEXT,
  name TEXT, symbol TEXT, uri TEXT, onchain_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS coins (
  mint TEXT PRIMARY KEY, curve TEXT NOT NULL, depth INTEGER NOT NULL, quote_mint TEXT, creator TEXT NOT NULL,
  tracked INTEGER NOT NULL DEFAULT 1,
  vtr TEXT NOT NULL DEFAULT '0', vqr TEXT NOT NULL DEFAULT '0', rtr TEXT NOT NULL DEFAULT '0', rqr TEXT NOT NULL DEFAULT '0',
  supply TEXT NOT NULL DEFAULT '0', ivqr TEXT NOT NULL DEFAULT '0',
  complete INTEGER NOT NULL DEFAULT 0, migrated INTEGER NOT NULL DEFAULT 0, mayhem INTEGER NOT NULL DEFAULT 0,
  holder_reward INTEGER NOT NULL DEFAULT 0, creator_fee_bps INTEGER NOT NULL DEFAULT 0,
  pool TEXT, pool_base_vault TEXT, pool_quote_vault TEXT, pool_base TEXT, pool_quote TEXT,
  created_at INTEGER, created_slot INTEGER, created_probe INTEGER NOT NULL DEFAULT 0,
  shares TEXT, shares_at INTEGER NOT NULL DEFAULT 0,
  refreshed_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
  fee_paid TEXT, pool_vquote TEXT, launcher TEXT
);
CREATE INDEX IF NOT EXISTS coins_quote ON coins(quote_mint);
CREATE INDEX IF NOT EXISTS coins_depth ON coins(depth);
CREATE INDEX IF NOT EXISTS coins_created ON coins(created_at);
CREATE TABLE IF NOT EXISTS trades (
  sig TEXT NOT NULL, mint TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
  slot INTEGER NOT NULL, time INTEGER NOT NULL, is_buy INTEGER NOT NULL, user TEXT NOT NULL,
  base_amount TEXT NOT NULL, quote_amount TEXT NOT NULL,
  price_quote REAL NOT NULL, price_usd REAL, value_usd REAL,
  PRIMARY KEY (sig, mint, idx)
);
CREATE INDEX IF NOT EXISTS trades_mint_time ON trades(mint, time);
CREATE INDEX IF NOT EXISTS trades_time ON trades(time);
CREATE TABLE IF NOT EXISTS meta (
  uri TEXT PRIMARY KEY, image TEXT, description TEXT, twitter TEXT, telegram TEXT, website TEXT,
  fetched_at INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, dead_streak INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS backfill_curves (
  curve TEXT PRIMARY KEY, depth INTEGER NOT NULL, quote_mint TEXT, data TEXT NOT NULL,
  graduated INTEGER NOT NULL DEFAULT 0, rq REAL NOT NULL DEFAULT 0,
  mint TEXT, resolved_at INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE INDEX IF NOT EXISTS backfill_pending ON backfill_curves(resolved_at, graduated, rq, depth);
CREATE TABLE IF NOT EXISTS uploads (
  name TEXT PRIMARY KEY, kind TEXT NOT NULL, pair TEXT, ip TEXT, bytes INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_at ON uploads(at);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT, hash TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'partner', created_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER,
  requests INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agents (
  root_mint TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'dry' CHECK (status IN ('dry', 'paused')),
  profile_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_run_at INTEGER, next_run_at INTEGER, runs INTEGER NOT NULL DEFAULT 0, proposals INTEGER NOT NULL DEFAULT 0,
  last_score INTEGER, last_reason TEXT
);
CREATE TABLE IF NOT EXISTS agent_proposals (
  id TEXT PRIMARY KEY, root_mint TEXT NOT NULL, created_at INTEGER NOT NULL,
  name TEXT NOT NULL, symbol TEXT NOT NULL, description TEXT NOT NULL, image_file TEXT,
  score INTEGER NOT NULL, reason TEXT NOT NULL, sim_json TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'rejected')), rejected_reason TEXT,
  source TEXT NOT NULL DEFAULT 'fallback', runners_json TEXT, metadata_uri TEXT
);
CREATE INDEX IF NOT EXISTS agent_proposals_root ON agent_proposals(root_mint, created_at);
CREATE INDEX IF NOT EXISTS agent_proposals_created ON agent_proposals(created_at);
CREATE TABLE IF NOT EXISTS img_fail (
  url TEXT PRIMARY KEY, kind TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 1,
  failed_at INTEGER NOT NULL, retry_at INTEGER NOT NULL, gone_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pnl_wallets (
  wallet TEXT PRIMARY KEY, added_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', before_sig TEXT, oldest_time INTEGER,
  scanned INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
  cut INTEGER NOT NULL DEFAULT 0, rows INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, failed_at INTEGER NOT NULL DEFAULT 0, error TEXT, gap_from INTEGER
);
CREATE TABLE IF NOT EXISTS wallet_trades (
  wallet TEXT NOT NULL, sig TEXT NOT NULL, mint TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
  slot INTEGER NOT NULL DEFAULT 0, time INTEGER NOT NULL, is_buy INTEGER NOT NULL,
  base_amount TEXT NOT NULL, quote_amount TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, sig, mint, idx)
);
CREATE TABLE IF NOT EXISTS pnl_unread (
  wallet TEXT NOT NULL, sig TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL, next_at INTEGER, errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, sig)
);
CREATE INDEX IF NOT EXISTS pnl_unread_due ON pnl_unread(next_at) WHERE next_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS fill_coins (
  mint TEXT PRIMARY KEY,
  done TEXT NOT NULL DEFAULT '[]',
  whole TEXT NOT NULL DEFAULT '[]',
  partial TEXT NOT NULL DEFAULT '[]',
  day INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
  rows INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, cut INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fill_coins_at ON fill_coins(at);
CREATE TABLE IF NOT EXISTS chart_history (
  mint TEXT NOT NULL, res INTEGER NOT NULL, unit TEXT NOT NULL, state TEXT NOT NULL,
  pools TEXT NOT NULL DEFAULT '[]', cov_from INTEGER NOT NULL, cov_to INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL, asked_at INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '[]', mig_at INTEGER,
  PRIMARY KEY (mint, res, unit)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS chart_history_asked ON chart_history(asked_at);
CREATE TABLE IF NOT EXISTS chart_samples (
  mint TEXT PRIMARY KEY, state TEXT NOT NULL, from_t INTEGER NOT NULL, to_t INTEGER NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, asked_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '[]', retry_ext INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chart_samples_asked ON chart_samples(asked_at);
CREATE TABLE IF NOT EXISTS x_posts (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, handle TEXT, text TEXT, flagged INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL, asked_at INTEGER NOT NULL, recheck_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS x_posts_asked ON x_posts(asked_at);
CREATE TABLE IF NOT EXISTS launch_flow (mint TEXT PRIMARY KEY, bought REAL NOT NULL, sold REAL NOT NULL, created_at INTEGER NOT NULL, sniped REAL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS narratives (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, theme TEXT NOT NULL, key TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, retitled INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS narratives_key ON narratives(key);
CREATE INDEX IF NOT EXISTS narratives_seen ON narratives(last_seen_at);
CREATE TABLE IF NOT EXISTS coin_tags (
  mint TEXT PRIMARY KEY, narrative_id INTEGER, tagged_at INTEGER NOT NULL, model TEXT,
  asks INTEGER NOT NULL DEFAULT 1, had_post INTEGER NOT NULL DEFAULT 0, bare INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS coin_tags_narrative ON coin_tags(narrative_id);
CREATE TABLE IF NOT EXISTS narrative_spend (
  day TEXT PRIMARY KEY, in_tokens INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS story_buckets (
  story_key TEXT NOT NULL, t INTEGER NOT NULL, buyers INTEGER NOT NULL, buy_usd REAL NOT NULL, sells INTEGER NOT NULL,
  launches_fast INTEGER NOT NULL, launches INTEGER NOT NULL, site_buyers INTEGER NOT NULL,
  leader_mint TEXT, leader_buyers INTEGER NOT NULL DEFAULT 0, coins INTEGER NOT NULL, flags INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (story_key, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS story_buckets_t ON story_buckets(t);
-- One row per coin of a story per 5-minute bucket (lib/attention.mjs): its buyers, buy USD, sells and last price, the
-- story it was filed under (n:, post, family), the subject or automatic group it belongs to (t:, or null) and its copy
-- key (same ticker and image: copycats). The outcome study reads price change and peak per coin from these.
CREATE TABLE IF NOT EXISTS story_coins (
  t INTEGER NOT NULL, mint TEXT NOT NULL, story_key TEXT NOT NULL, subject_key TEXT, group_key TEXT,
  buyers INTEGER NOT NULL, buy_usd REAL NOT NULL, sells INTEGER NOT NULL, price_usd REAL, copy_key TEXT,
  PRIMARY KEY (t, mint)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS story_starts (
  story_key TEXT PRIMARY KEY, start_at INTEGER NOT NULL, source TEXT NOT NULL, first_buyers_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS calib (
  ${CALIB_COLS},
  PRIMARY KEY (t, story_key)
) WITHOUT ROWID;
${CALIB_INDEXES}
CREATE TABLE IF NOT EXISTS coin_days (
  mint TEXT NOT NULL, day TEXT NOT NULL, high_usd REAL, low_usd REAL, close_usd REAL, close_t INTEGER,
  buyers INTEGER NOT NULL DEFAULT 0, buys INTEGER NOT NULL DEFAULT 0, trades INTEGER NOT NULL DEFAULT 0, volume_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (mint, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS event_buckets (
  event_id TEXT NOT NULL, t INTEGER NOT NULL, buyers INTEGER NOT NULL, pre_buyers INTEGER NOT NULL, new_buyers INTEGER NOT NULL,
  pre_coins INTEGER NOT NULL, new_coins INTEGER NOT NULL, site_buyers INTEGER NOT NULL, flags INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, t)
) WITHOUT ROWID;
`;

const now = () => Math.floor(Date.now() / 1000);

export class Db {
  /**
   * `busyMs`: how long a write waits for another connection's write lock before failing. The API-key
   * CLI (scripts/keys.mjs) writes to the same file as the running server; its transactions take
   * well under a millisecond, so a short wait turns a would-be SQLITE_BUSY into a tiny pause.
   */
  constructor(file, { busyMs = 2_000, rebuild = true } = {}) {
    this.rebuild = rebuild; // one-time table rebuilds (calib below): the server only, never a script beside a running server
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.tradeAdds = new Map(); // mint → rows inserted since its last trim (insertTrade)
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA temp_store = MEMORY;`);
    this.migrate();
    this.#prepare();
  }

  /** Idempotent: CREATE IF NOT EXISTS for the base schema, then per-version column additions. */
  migrate() {
    this.db.exec(SCHEMA);
    const current = Number(this.db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get()?.value ?? 0);
    // v2: the launch fee a verified spawn paid. Guarded by the column's absence rather than the
    // version alone, since a fresh database already has it from the CREATE TABLE above.
    if (current < 2 && !this.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "fee_paid")) this.db.exec("ALTER TABLE coins ADD COLUMN fee_paid TEXT");
    // A migrated coin's pool `virtual_quote_reserves` (signed i128 as decimal TEXT), part of its pool price
    // (pricing.mjs poolPriceQuote). Guarded by the column's absence alone, so it needs no version bump.
    if (!this.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "pool_vquote")) this.db.exec("ALTER TABLE coins ADD COLUMN pool_vquote TEXT");
    // `coins.launcher`: the wallet of the coin's CreateEvent (`creator` follows the curve, which names the fee-sharing
    // config's PDA once one exists). Guarded by the column's absence alone, like pool_vquote; rows from before stay
    // NULL, and the model then goes by `creator` and the fee shares (lib/model.mjs #launchWallets).
    if (!this.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "launcher")) this.db.exec("ALTER TABLE coins ADD COLUMN launcher TEXT");
    // v3: `coins.updated_at` moves from seconds to milliseconds (the map's delta-sync stamp,
    // DESIGN §11.5: `since=<ms>` returns the rows with `updated_at > since`) and `meta.attempts`
    // counts consecutive failed fetches so the retry backoff survives a restart.
    if (current < 3) {
      if (!this.db.prepare("PRAGMA table_info(meta)").all().some((c) => c.name === "attempts")) this.db.exec("ALTER TABLE meta ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE coins SET updated_at = updated_at * 1000 WHERE updated_at > 0 AND updated_at < 100000000000");
    }
    // `meta.dead_streak`: consecutive "dead" failures (a non-IPFS host's 404/410, a name that does not resolve); the
    // weekly retry needs META_DEAD_AFTER of them in a row (lib/meta.mjs metaRetryS). Guarded by the column's absence
    // alone, like pool_vquote; rows from before start at 0, so none is asked weekly before it failed that way 5 times.
    if (!this.db.prepare("PRAGMA table_info(meta)").all().some((c) => c.name === "dead_streak")) this.db.exec("ALTER TABLE meta ADD COLUMN dead_streak INTEGER NOT NULL DEFAULT 0");
    // `api_keys` (partner API keys, DESIGN §12) and `agents` / `agent_proposals` (root agents,
    // DESIGN §13; statements in lib/agents/registry.mjs) are new tables only, so CREATE IF NOT
    // EXISTS above is their migration. So is `img_fail` (the image proxy's failed downloads and
    // undrawable logos with their kind and next retry, lib/meta.mjs ImageCache; times in ms).
    // `pnl_wallets` / `wallet_trades` (the wallets whose profit and loss was asked for and their own trades, lib/pnl-tracker.mjs)
    // are new tables only as well. wallet_trades is never touched by the per-mint trim of `trades`. Its `ord` (the order of
    // a wallet's transactions inside one slot) and pnl_wallets' `gap_from` came a build later: added when absent, and the
    // index follows the order every read uses (time, slot, ord, idx), so a page of a wallet's trades is never sorted.
    if (!this.db.prepare("PRAGMA table_info(wallet_trades)").all().some((c) => c.name === "ord")) this.db.exec("ALTER TABLE wallet_trades ADD COLUMN ord INTEGER NOT NULL DEFAULT 0");
    if (!this.db.prepare("PRAGMA table_info(pnl_wallets)").all().some((c) => c.name === "gap_from")) this.db.exec("ALTER TABLE pnl_wallets ADD COLUMN gap_from INTEGER");
    this.db.exec("DROP INDEX IF EXISTS wallet_trades_time; CREATE INDEX IF NOT EXISTS wallet_trades_order ON wallet_trades(wallet, time, slot, ord, idx)");
    // `pnl_unread` (the transactions of a tracked wallet its history scan could not read, kept to be tried again:
    // lib/pnl-tracker.mjs; times in ms, `next_at` null = given up) is a new table only. Its `errors` (tries in a row the
    // endpoint did not answer at all, which are not tries of the transaction) is added when a table made before it has none.
    if (!this.db.prepare("PRAGMA table_info(pnl_unread)").all().some((c) => c.name === "errors")) this.db.exec("ALTER TABLE pnl_unread ADD COLUMN errors INTEGER NOT NULL DEFAULT 0");
    // `img_fail.gone_attempts`: the permanent failures since the last success, carried across temporary ones in between
    // (lib/meta.mjs ImageCache #fail), so a url alternating 404 and 502 still reaches the weekly wait. Guarded by the
    // column's absence alone, like dead_streak (a table made before it has none); old rows start at 0, and a "gone" row
    // counts with its own `attempts` anyway.
    if (!this.db.prepare("PRAGMA table_info(img_fail)").all().some((c) => c.name === "gone_attempts")) this.db.exec("ALTER TABLE img_fail ADD COLUMN gone_attempts INTEGER NOT NULL DEFAULT 0");
    // `fill_coins` (the trade gap fill's state per coin, lib/trade-fill.mjs) is a new table only as well: `done`, the JSON
    // gap ids finished for the coin (filled, cut, or skipped as irrelevant); `whole`, those filled completely (the listing
    // reached the gap's start and nothing was left unread), which a child's USD price relies on; `partial`, those in which
    // a transaction was left unread or decoded incomplete (a later run skips it, so such a gap is never whole); `day` and `calls`, its
    // chain calls on that UTC day (FILL_COIN_DAILY); totals of rows, unread transactions and cut gaps (health,
    // debugging); and `at`, the unix s of its last save, by which rows older than the fill's 48 h are pruned.
    // `chart_history` and `chart_samples` (the chart history before a coin's first stored trade, lib/chart-history.mjs)
    // are new tables only as well: one row of GeckoTerminal candles per (mint, res, unit) with the state and stretch of its
    // last fetch (`data` a JSON [[t,o,h,l,c,v],…], unit 'usd' or 'quote'; the SOL/USD reference under SOL's mint), and
    // per coin the prices sampled from the chain (`data` [[time, priceQuote, priceUsd|null, quoteAtoms, exact],…], the
    // stretch [from_t, to_t), `retry_at` 0 = final, `retry_ext` 1 when that retry is an extension an outage or the day's
    // cap stopped); both pruned by `asked_at` (unix s, written at most hourly). `retry_ext` came a build later: added
    // when absent, like gone_attempts. So did `mig_at` (a graduated coin's row: the bucket where its pool's candles meet
    // its curve's, the migration's, once the curve was fetched; null otherwise or in rows written before it).
    // `x_posts` (the linked posts' texts, lib/xposts.mjs) is a new table only too: one row per X post id with what X's
    // embed API answered, `state` 'ok' (with `handle` and `text`; `flagged` 1 = the text is withheld and stored empty) or
    // 'none' (no such post, or not shown to us), the unix s of the fetch, of the next recheck and of the last ask
    // (`asked_at`, written at most hourly, by which rows are pruned).
    // `launch_flow` (lib/wakeups.mjs, the "creator sold its buy within 10 min" fact) is a new table only too: per coin the
    // base units its launcher bought and sold in its first 10 min, written once that window was seen whole, because the
    // per-mint trim of `trades` deletes a busy coin's launch rows within a day. One row per tracked child, like `coins`.
    // `launch_flow.sniped` (the base units non-creator wallets bought in the launch slot or the first 3 s, the Discover
    // row's sniper share) came later: null in rows written before it, which then read as unknown.
    // `narratives`, `coin_tags` and `narrative_spend` (the narrative tags, lib/narrtags.mjs) are new tables only too:
    // a narrative's title and theme with `key` (its title folded for the near-duplicate check, unique) and the unix s it
    // was made and last given to a coin; per coin the narrative a language model put it under (`narrative_id` NULL = it
    // answered "none"), when, by which model, how many times the coin was asked about (`asks`) and whether its linked
    // post's text was part of the last ask (`had_post`) and whether that ask carried neither a description nor a post
    // (`bare`, added later: 0 in older rows); and per UTC day ('YYYY-MM-DD') the tokens, USD and requests
    // spent, which is what the daily cap goes by across restarts. `narratives.retitled` (1 = its title was widened once,
    // which is the only time it may be: lib/narrtags.mjs TagEngine #retitle) came later: added when absent, 0 in older
    // rows. The version of the tagging rules the stored answers were made under is the kv row 'narr_rules_version'
    // (narrRulesReset below; not a schema version: the tables stay, their rows go).
    // `story_buckets`, `story_starts`, `calib`, `coin_days` and `event_buckets` (story attention, lib/attention.mjs) are new
    // tables only too: what each story drew per 5 minutes (one row per story with a trade in it, plus one `story_key` '*'
    // row for the whole site; `t` the bucket's start, unix s; `flags` 1 = the bucket the process started in, partial),
    // kept 14 days by a sliced trim of its own (never by the trades trim); when each story started and saw its first
    // buyers; a snapshot per story every 5 minutes with what followed 1 h and 6 h later and how many of those buckets the
    // server saw whole (`cov_1h` / `cov_6h`, added when absent; kept 90 days); per coin per UTC day
    // ('YYYY-MM-DD') its high, low and close USD price, buyers, buys, trades and volume (never trimmed); and per
    // pre-registered event (server/prereg/events.json) the buyers of its matching coins per 5 minutes (never trimmed).
    if (!this.db.prepare("PRAGMA table_info(launch_flow)").all().some((c) => c.name === "sniped"))this.db.exec("ALTER TABLE launch_flow ADD COLUMN sniped REAL");
    if (!this.db.prepare("PRAGMA table_info(chart_samples)").all().some((c) => c.name === "retry_ext")) this.db.exec("ALTER TABLE chart_samples ADD COLUMN retry_ext INTEGER NOT NULL DEFAULT 0");
    if (!this.db.prepare("PRAGMA table_info(chart_history)").all().some((c) => c.name === "mig_at")) this.db.exec("ALTER TABLE chart_history ADD COLUMN mig_at INTEGER");
    if (!this.db.prepare("PRAGMA table_info(coin_tags)").all().some((c) => c.name === "bare")) this.db.exec("ALTER TABLE coin_tags ADD COLUMN bare INTEGER NOT NULL DEFAULT 0");
    if (!this.db.prepare("PRAGMA table_info(narratives)").all().some((c) => c.name === "retitled")) this.db.exec("ALTER TABLE narratives ADD COLUMN retitled INTEGER NOT NULL DEFAULT 0");
    const calibCols = this.db.prepare("PRAGMA table_info(calib)").all();
    for (const c of ["cov_1h", "cov_6h"]) if (!calibCols.some((x) => x.name === c)) this.db.exec(`ALTER TABLE calib ADD COLUMN ${c} INTEGER`);
    // calib keyed time first (Nov 23 2026; it was story first): a close writes ~300 snapshots of one bucket time and fills
    // ~300 outcomes of one or two bucket times, which key-first spread over one page per story (~250-280 WAL pages a
    // commit on a copy of the live rows; time first, ~20), about 750 fewer pages a close, so the close brings on fewer
    // WAL checkpoints. Rebuilt once, in one transaction; the time index it needed goes.
    const calibFirst = calibCols.find((c) => c.pk === 1)?.name;
    if (this.rebuild && calibFirst !== "t") {
      const cols = "story_key, t, phase, multiple, buyers5m, hour_buyers, leader_mint, leader_price_usd, story_buy_usd, buyers_1h, price_1h, filled_1h, buyers_6h, price_6h, filled_6h, cov_1h, cov_6h";
      this.db.exec("BEGIN");
      try {
        this.db.exec(`CREATE TABLE calib_new (${CALIB_COLS}, PRIMARY KEY (t, story_key)) WITHOUT ROWID; INSERT INTO calib_new (${cols}) SELECT ${cols} FROM calib; DROP TABLE calib; ALTER TABLE calib_new RENAME TO calib; ${CALIB_INDEXES}`);
        this.db.exec("COMMIT");
      } catch (e) { try { this.db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
    }
    if (this.rebuild || calibFirst === "t") this.db.exec("DROP INDEX IF EXISTS calib_t"); // a story-first table still needs it (its trim)
    if (current < SCHEMA_VERSION) this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  #prepare() {
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      kvGet: p("SELECT value FROM kv WHERE key = ?"),
      kvSet: p("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)"),
      bfGet: p("SELECT value FROM backfill_state WHERE key = ?"),
      bfSet: p("INSERT OR REPLACE INTO backfill_state (key, value) VALUES (?, ?)"),
      bfAll: p("SELECT key, value FROM backfill_state"),
      mintUpsert: p(`INSERT INTO mints (mint, decimals, token_program, supply, name, symbol, uri, onchain_at) VALUES (@mint, @decimals, @tokenProgram, @supply, @name, @symbol, @uri, @onchainAt)
        ON CONFLICT(mint) DO UPDATE SET decimals = COALESCE(excluded.decimals, decimals), token_program = COALESCE(excluded.token_program, token_program), supply = COALESCE(excluded.supply, supply),
        name = COALESCE(excluded.name, name), symbol = COALESCE(excluded.symbol, symbol), uri = COALESCE(excluded.uri, uri), onchain_at = MAX(excluded.onchain_at, onchain_at)`),
      mintsAll: p("SELECT * FROM mints"),
      coinUpsert: p(`INSERT INTO coins (mint, curve, depth, quote_mint, creator, tracked, vtr, vqr, rtr, rqr, supply, ivqr, complete, migrated, mayhem, holder_reward, creator_fee_bps,
          pool, pool_base_vault, pool_quote_vault, pool_base, pool_quote, pool_vquote, created_at, created_slot, created_probe, shares, shares_at, refreshed_at, updated_at, fee_paid, launcher)
        VALUES (@mint, @curve, @depth, @quoteMint, @creator, @tracked, @vtr, @vqr, @rtr, @rqr, @supply, @ivqr, @complete, @migrated, @mayhem, @holderReward, @creatorFeeBps,
          @pool, @poolBaseVault, @poolQuoteVault, @poolBase, @poolQuote, @poolVirtualQuote, @createdAt, @createdSlot, @createdProbe, @shares, @sharesAt, @refreshedAt, @updatedAt, @feePaid, @launcher)
        ON CONFLICT(mint) DO UPDATE SET curve = excluded.curve, depth = excluded.depth, quote_mint = excluded.quote_mint, creator = excluded.creator, tracked = MAX(excluded.tracked, tracked),
          vtr = excluded.vtr, vqr = excluded.vqr, rtr = excluded.rtr, rqr = excluded.rqr, supply = excluded.supply, ivqr = excluded.ivqr,
          complete = excluded.complete, migrated = excluded.migrated, mayhem = excluded.mayhem, holder_reward = excluded.holder_reward, creator_fee_bps = excluded.creator_fee_bps,
          pool = excluded.pool, pool_base_vault = excluded.pool_base_vault, pool_quote_vault = excluded.pool_quote_vault, pool_base = excluded.pool_base, pool_quote = excluded.pool_quote, pool_vquote = excluded.pool_vquote,
          created_at = COALESCE(excluded.created_at, created_at), created_slot = COALESCE(excluded.created_slot, created_slot), created_probe = MAX(excluded.created_probe, created_probe),
          shares = COALESCE(excluded.shares, shares), shares_at = MAX(excluded.shares_at, shares_at), refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at,
          fee_paid = COALESCE(excluded.fee_paid, fee_paid), launcher = COALESCE(excluded.launcher, launcher)`),
      coinsAll: p("SELECT * FROM coins"),
      coinTouch: p("UPDATE coins SET updated_at = ? WHERE mint = ? AND updated_at < ?"),
      tradeInsert: p(`INSERT OR IGNORE INTO trades (sig, mint, idx, slot, time, is_buy, user, base_amount, quote_amount, price_quote, price_usd, value_usd)
        VALUES (@sig, @mint, @idx, @slot, @time, @isBuy, @user, @baseAmount, @quoteAmount, @priceQuote, @priceUsd, @valueUsd)`),
      tradeTrim: p("DELETE FROM trades WHERE mint = ? AND rowid NOT IN (SELECT rowid FROM trades WHERE mint = ? ORDER BY time DESC, rowid DESC LIMIT ?)"),
      tradeTrimOld: p("DELETE FROM trades WHERE mint = ?1 AND time < ?2 AND rowid NOT IN (SELECT rowid FROM trades WHERE mint = ?1 ORDER BY time DESC, rowid DESC LIMIT ?3)"),
      tradeCount: p("SELECT COUNT(*) AS n FROM trades WHERE mint = ?"),
      // A trade's place: time (1 s), then its slot (rows read back later by the gap fill, lib/trade-fill.mjs, can be stored
      // after live rows of the same second, or a child's after the rest of its own), then the rowid (the arrival order).
      tradesFor: p("SELECT * FROM trades WHERE mint = ? ORDER BY time DESC, slot DESC, rowid DESC LIMIT ?"),
      tradesSince: p("SELECT * FROM trades WHERE mint = ? AND time >= ? ORDER BY time ASC, slot ASC, rowid ASC"),
      // An older page of the coin page's chart (/api/candles before=): [from, to), and the newest trade below a page.
      tradesRange: p("SELECT * FROM trades WHERE mint = ? AND time >= ? AND time < ? ORDER BY time ASC, slot ASC, rowid ASC"),
      tradeTimeBefore: p("SELECT MAX(time) AS t FROM trades WHERE mint = ? AND time < ?"),
      tradesWindow: p("SELECT mint, slot, time, is_buy, value_usd, price_usd, user, base_amount FROM trades WHERE time >= ? ORDER BY time, rowid"),
      // A launcher's own buys and sells of its coin in a time range (lib/wakeups.mjs: "the creator sold its buy within 10 min").
      // The (mint, time) index narrows the rows; amounts are u64 strings, summed as REAL (a ratio needs no more precision).
      creatorFlow: p("SELECT is_buy, SUM(CAST(base_amount AS REAL)) AS amt FROM trades WHERE mint = ? AND time >= ? AND time < ? AND user = ? GROUP BY is_buy"),
      tradeFirstTime: p("SELECT MIN(time) AS t FROM trades WHERE mint = ?"),
      // The newest stored USD price of a mint (lib/wakeups.mjs: a coin the model prices in its parent only); (mint, time) index, newest first.
      lastPriceUsd: p("SELECT price_usd FROM trades WHERE mint = ? AND price_usd > 0 ORDER BY time DESC LIMIT 1"),
      launchFlowGet: p("SELECT bought, sold, created_at, sniped FROM launch_flow WHERE mint = ?"),
      sniperFlow: p("SELECT COALESCE(SUM(CAST(base_amount AS REAL)), 0) AS amt FROM trades WHERE mint = ?1 AND time >= ?2 AND time <= ?3 AND is_buy = 1 AND user != ?4 AND (time <= ?5 OR slot = ?6)"),
      // The first whole record wins: a late print in a coin's window seen after it was written must not replace it.
      launchFlowPut: p("INSERT OR IGNORE INTO launch_flow (mint, bought, sold, created_at, sniped) VALUES (?, ?, ?, ?, ?)"),
      vol24: p("SELECT COUNT(*) AS n, COALESCE(SUM(value_usd), 0) AS usd FROM trades WHERE mint = ? AND time >= ?"),
      vol24All: p("SELECT mint, COUNT(*) AS n, COALESCE(SUM(value_usd), 0) AS usd FROM trades WHERE time >= ? GROUP BY mint"),
      metaGet: p("SELECT * FROM meta WHERE uri = ?"),
      metaAll: p("SELECT * FROM meta"),
      metaSet: p(`INSERT OR REPLACE INTO meta (uri, image, description, twitter, telegram, website, fetched_at, ok, error, attempts, dead_streak) VALUES (@uri, @image, @description, @twitter, @telegram, @website, @fetchedAt, @ok, @error, @attempts, @deadStreak)`),
      bfCurveUpsert: p(`INSERT INTO backfill_curves (curve, depth, quote_mint, data, graduated, rq) VALUES (@curve, @depth, @quoteMint, @data, @graduated, @rq)
        ON CONFLICT(curve) DO UPDATE SET depth = excluded.depth, quote_mint = excluded.quote_mint, data = excluded.data, graduated = excluded.graduated, rq = excluded.rq`),
      bfCurvePending: p("SELECT curve, depth, quote_mint, data FROM backfill_curves WHERE resolved_at = 0 AND error IS NULL ORDER BY graduated DESC, rq DESC, depth DESC LIMIT ?"),
      bfCurveResolve: p("UPDATE backfill_curves SET mint = ?, resolved_at = ?, error = NULL WHERE curve = ?"),
      bfCurveFail: p("UPDATE backfill_curves SET error = ?, resolved_at = ? WHERE curve = ?"),
      bfCurveStats: p("SELECT COUNT(*) AS total, SUM(resolved_at > 0 AND error IS NULL) AS resolved, SUM(error IS NOT NULL) AS failed FROM backfill_curves"),
      bfCurveByKey: p("SELECT curve, depth, quote_mint, data, mint, resolved_at FROM backfill_curves WHERE curve = ?"),
      bfCurveState: p("SELECT resolved_at > 0 AND error IS NULL AS resolved, error IS NOT NULL AS failed FROM backfill_curves WHERE curve = ?"),
      bfCurvesUnresolvedKeys: p("SELECT curve FROM backfill_curves WHERE resolved_at = 0"),
      uploadInsert: p("INSERT OR IGNORE INTO uploads (name, kind, pair, ip, bytes, at) VALUES (@name, @kind, @pair, @ip, @bytes, @at)"),
      uploadStale: p("SELECT name, kind, pair, at FROM uploads WHERE at < ? ORDER BY at ASC LIMIT ?"),
      uploadDelete: p("DELETE FROM uploads WHERE name = ?"),
      uploadPairCount: p("SELECT COUNT(*) AS n FROM uploads WHERE kind = 'json' AND pair = ?"),
      uploadCount: p("SELECT COUNT(*) AS n FROM uploads"),
      priceBefore: p("SELECT price_quote, price_usd, time FROM trades WHERE mint = ? AND time <= ? ORDER BY time DESC, slot DESC, rowid DESC LIMIT 1"),
      priceAfter: p("SELECT price_quote, price_usd, time FROM trades WHERE mint = ? AND time > ? ORDER BY time ASC, slot ASC, rowid ASC LIMIT 1"),
      usdPriceBefore: p("SELECT price_usd, time FROM trades WHERE mint = ? AND time <= ? AND price_usd IS NOT NULL ORDER BY time DESC, slot DESC, rowid DESC LIMIT 1"),
      // The trade gap fill (lib/trade-fill.mjs): whether a signature is stored (a primary-key prefix), the listing's anchor,
      // a count that stops at its cap, and the bounds of what the mint's retention keeps.
      tradeHas: p("SELECT 1 AS x FROM trades WHERE sig = ? AND mint = ? LIMIT 1"),
      tradeAfter: p("SELECT sig, time FROM trades WHERE mint = ? AND time > ? ORDER BY time ASC, slot ASC, rowid ASC LIMIT 1"),
      tradesBetween: p("SELECT COUNT(*) AS n FROM (SELECT 1 FROM trades WHERE mint = ? AND time > ? AND time <= ? LIMIT ?)"),
      tradeOldest: p("SELECT MIN(time) AS t FROM trades WHERE mint = ?"),
      tradeNth: p("SELECT time FROM trades WHERE mint = ? ORDER BY time DESC, rowid DESC LIMIT 1 OFFSET ?"),
      fillCoinGet: p("SELECT * FROM fill_coins WHERE mint = ?"),
      fillCoinSet: p("INSERT OR REPLACE INTO fill_coins (mint, done, whole, partial, day, calls, rows, unread, cut, at) VALUES (@mint, @done, @whole, @partial, @day, @calls, @rows, @unread, @cut, @at)"),
      fillCoinsPrune: p("DELETE FROM fill_coins WHERE at < ?"),
      // The chart history (lib/chart-history.mjs). The kept key (?2-?4: the SOL/USD reference row) survives both prunes
      // while a samples row was written since ?1 (?4 '' keeps nothing).
      histGet: p("SELECT * FROM chart_history WHERE mint = ? AND res = ? AND unit = ?"),
      histSet: p(`INSERT OR REPLACE INTO chart_history (mint, res, unit, state, pools, cov_from, cov_to, fetched_at, asked_at, data, mig_at)
        VALUES (@mint, @res, @unit, @state, @pools, @covFrom, @covTo, @fetchedAt, @askedAt, @data, @migAt)`),
      histTouch: p("UPDATE chart_history SET asked_at = ?1 WHERE mint = ?2 AND res = ?3 AND unit = ?4 AND asked_at < ?1"),
      histPruneOld: p(`DELETE FROM chart_history WHERE asked_at < ?1
        AND NOT (mint = ?2 AND res = ?3 AND unit = ?4 AND EXISTS (SELECT 1 FROM chart_samples WHERE at >= ?1))`),
      histPruneOver: p(`DELETE FROM chart_history WHERE (mint, res, unit) IN (SELECT mint, res, unit FROM chart_history
        WHERE NOT (mint = ?2 AND res = ?3 AND unit = ?4 AND EXISTS (SELECT 1 FROM chart_samples WHERE at >= ?1)) ORDER BY asked_at ASC LIMIT ?5)`),
      histCount: p("SELECT COUNT(*) AS n FROM chart_history"),
      // The linked posts' texts (lib/xposts.mjs).
      xpostGet: p("SELECT * FROM x_posts WHERE id = ?"),
      xpostSet: p(`INSERT OR REPLACE INTO x_posts (id, state, handle, text, flagged, fetched_at, asked_at, recheck_at)
        VALUES (@id, @state, @handle, @text, @flagged, @fetchedAt, @askedAt, @recheckAt)`),
      xpostDel: p("DELETE FROM x_posts WHERE id = ?"),
      xpostTouch: p("UPDATE x_posts SET asked_at = ?1 WHERE id = ?2 AND asked_at < ?1"),
      xpostPruneOld: p("DELETE FROM x_posts WHERE asked_at < ?"),
      xpostPruneOver: p("DELETE FROM x_posts WHERE id IN (SELECT id FROM x_posts ORDER BY asked_at ASC, id ASC LIMIT ?)"),
      xpostCount: p("SELECT COUNT(*) AS n FROM x_posts"),
      // The narrative tags (lib/narrtags.mjs).
      narrRecent: p("SELECT id, title, theme FROM narratives ORDER BY last_seen_at DESC, id DESC LIMIT ?"),
      narrGet: p("SELECT id, title, theme FROM narratives WHERE id = ?"),
      narrByKey: p("SELECT id, title, theme FROM narratives WHERE key = ?"),
      narrAdd: p("INSERT INTO narratives (title, theme, key, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"),
      narrTouch: p("UPDATE narratives SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at < ?1"),
      narrCount: p("SELECT COUNT(*) AS n FROM narratives"),
      narrRetitled: p("SELECT retitled FROM narratives WHERE id = ?"),
      narrRetitle: p("UPDATE narratives SET title = ?, key = ?, retitled = 1 WHERE id = ? AND retitled = 0"),
      narrTagged: p("SELECT COUNT(*) AS n FROM coin_tags WHERE narrative_id = ?"),
      narrWipe: p("DELETE FROM narratives"),
      tagWipe: p("DELETE FROM coin_tags"),
      tagGet: p("SELECT mint, narrative_id, tagged_at, model, asks, had_post, bare FROM coin_tags WHERE mint = ?"),
      tagSet: p(`INSERT OR REPLACE INTO coin_tags (mint, narrative_id, tagged_at, model, asks, had_post, bare)
        VALUES (:mint, :narrativeId, :at, :model, :asks, :hadPost, :bare)`),
      tagCounts: p("SELECT COUNT(narrative_id) AS tagged, COUNT(*) AS n FROM coin_tags"),
      tagRecentCreated: p("SELECT c.mint AS mint, t.narrative_id AS id, c.created_at AS created_at FROM coins c JOIN coin_tags t ON t.mint = c.mint WHERE c.created_at > ? AND t.narrative_id IS NOT NULL"),
      spendGet: p("SELECT in_tokens, out_tokens, usd, requests FROM narrative_spend WHERE day = ?"),
      spendAdd: p(`INSERT INTO narrative_spend (day, in_tokens, out_tokens, usd, requests) VALUES (:day, :inTokens, :outTokens, :usd, :requests)
        ON CONFLICT(day) DO UPDATE SET in_tokens = in_tokens + :inTokens, out_tokens = out_tokens + :outTokens, usd = MAX(0, usd + :usd), requests = requests + :requests`),
      // Deep rows (data longer than ?1 bytes: grown backward by older pages) asked before ?3, or past the ?2 most recently asked.
      // octet_length reads a value's size from the record header; length() of TEXT loads (and counts) the whole value, which
      // read every row's data on each hourly prune.
      histDeep: p(`SELECT mint, res, unit FROM chart_history WHERE octet_length(data) > ?1 AND (asked_at < ?3 OR (mint, res, unit) NOT IN
        (SELECT mint, res, unit FROM chart_history WHERE octet_length(data) > ?1 ORDER BY asked_at DESC LIMIT ?2))`),
      samplesGet: p("SELECT * FROM chart_samples WHERE mint = ?"),
      samplesSet: p(`INSERT OR REPLACE INTO chart_samples (mint, state, from_t, to_t, calls, at, asked_at, retry_at, retry_ext, data)
        VALUES (@mint, @state, @fromT, @toT, @calls, @at, @askedAt, @retryAt, @retryExt, @data)`),
      samplesTouch: p("UPDATE chart_samples SET asked_at = ?1 WHERE mint = ?2 AND asked_at < ?1"),
      samplesPruneOld: p("DELETE FROM chart_samples WHERE asked_at < ?"),
      samplesPruneOver: p("DELETE FROM chart_samples WHERE rowid IN (SELECT rowid FROM chart_samples ORDER BY asked_at ASC LIMIT ?)"),
      samplesCount: p("SELECT COUNT(*) AS n FROM chart_samples"),
      keyInsert: p("INSERT INTO api_keys (name, contact, hash, tier, created_at) VALUES (?, ?, ?, ?, ?)"),
      keyByHash: p("SELECT id, name, tier, revoked_at FROM api_keys WHERE hash = ?"),
      keysAll: p("SELECT id, name, contact, tier, created_at, revoked_at, last_used_at, requests FROM api_keys ORDER BY id"),
      keyRevoke: p("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"),
      keyUsage: p("UPDATE api_keys SET requests = requests + ?, last_used_at = MAX(COALESCE(last_used_at, 0), ?) WHERE id = ?"),
      imgFailAll: p("SELECT url, kind, error, attempts, gone_attempts, failed_at, retry_at FROM img_fail"),
      imgFailSet: p("INSERT OR REPLACE INTO img_fail (url, kind, error, attempts, gone_attempts, failed_at, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      imgFailDelete: p("DELETE FROM img_fail WHERE url = ?"),
      imgFailPrune: p("DELETE FROM img_fail WHERE retry_at < ?"),
      imgFailDropKind: p("DELETE FROM img_fail WHERE kind = ?"),
      pnlWalletsAll: p("SELECT * FROM pnl_wallets"),
      pnlWalletInsert: p("INSERT OR IGNORE INTO pnl_wallets (wallet, added_at, last_seen_at, state) VALUES (?, ?, ?, ?)"),
      pnlWalletSeen: p("UPDATE pnl_wallets SET last_seen_at = ? WHERE wallet = ?"),
      pnlWalletSave: p(`UPDATE pnl_wallets SET state = @state, before_sig = @beforeSig, oldest_time = @oldestTime, scanned = @scanned, total = @total, unread = @unread,
        cut = @cut, rows = @rows, attempts = @attempts, failed_at = @failedAt, error = @error, gap_from = @gapFrom WHERE wallet = @wallet`),
      pnlWalletsGap: p("UPDATE pnl_wallets SET gap_from = MIN(COALESCE(gap_from, ?1), ?1) WHERE added_at <= ?1"),
      pnlWalletRows: p("UPDATE pnl_wallets SET rows = ?, cut = ? WHERE wallet = ?"),
      pnlWalletDelete: p("DELETE FROM pnl_wallets WHERE wallet = ?"),
      walletTradeInsert: p(`INSERT OR IGNORE INTO wallet_trades (wallet, sig, mint, idx, slot, time, is_buy, base_amount, quote_amount, ord)
        VALUES (@wallet, @sig, @mint, @idx, @slot, @time, @isBuy, @baseAmount, @quoteAmount, @ord)`),
      // Trade order = the index's order: time, slot, ord (the transaction's place in its slot), idx, then the rowid.
      walletTradesPage: p(`SELECT rowid AS id, sig, mint, idx, slot, ord, time, is_buy, base_amount, quote_amount FROM wallet_trades
        WHERE wallet = ?1 AND (time, slot, ord, idx, rowid) > (?2, ?3, ?4, ?5, ?6) ORDER BY time ASC, slot ASC, ord ASC, idx ASC, rowid ASC LIMIT ?7`),
      walletTradesNewest: p(`SELECT rowid AS id, sig, mint, idx, slot, ord, time, is_buy, base_amount, quote_amount FROM wallet_trades
        WHERE wallet = ?1 AND (time, slot, ord, idx, rowid) < (?2, ?3, ?4, ?5, ?6) ORDER BY time DESC, slot DESC, ord DESC, idx DESC, rowid DESC LIMIT ?7`),
      walletTradeAt: p("SELECT rowid AS id, time, slot, ord, idx FROM wallet_trades WHERE rowid = ? AND wallet = ?"),
      walletTradesTrim: p("DELETE FROM wallet_trades WHERE rowid IN (SELECT rowid FROM wallet_trades WHERE wallet = ? ORDER BY time ASC, slot ASC, ord ASC, idx ASC, rowid ASC LIMIT ?)"),
      walletTradesDrop: p("DELETE FROM wallet_trades WHERE wallet = ?"),
      walletTradesCount: p("SELECT COUNT(*) AS n FROM wallet_trades WHERE wallet = ?"),
      pnlUnreadInsert: p("INSERT OR IGNORE INTO pnl_unread (wallet, sig, ord, attempts, added_at, next_at) VALUES (?, ?, ?, 0, ?, ?)"),
      pnlUnreadHas: p("SELECT 1 AS x FROM pnl_unread WHERE wallet = ? AND sig = ?"),
      pnlUnreadDelete: p("DELETE FROM pnl_unread WHERE wallet = ? AND sig = ?"),
      pnlUnreadDrop: p("DELETE FROM pnl_unread WHERE wallet = ?"),
      pnlUnreadTried: p("UPDATE pnl_unread SET attempts = ?, next_at = ?, errors = ? WHERE wallet = ? AND sig = ?"),
      pnlUnreadDue: p("SELECT wallet, sig, ord, attempts, next_at, errors FROM pnl_unread WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at ASC LIMIT ?"),
      pnlUnreadNext: p("SELECT MIN(next_at) AS at FROM pnl_unread WHERE next_at IS NOT NULL"),
      pnlUnreadCount: p("SELECT COUNT(*) AS n FROM pnl_unread"),
      pnlUnreadCountOf: p("SELECT COUNT(*) AS n FROM pnl_unread WHERE wallet = ?"),
      pnlUnreadOf: p("SELECT wallet, sig, ord, attempts, next_at, errors FROM pnl_unread WHERE wallet = ? ORDER BY added_at ASC, sig ASC"),
      pnlWalletsUnstored: p("SELECT wallet FROM pnl_wallets WHERE unread > 0 AND NOT EXISTS (SELECT 1 FROM pnl_unread u WHERE u.wallet = pnl_wallets.wallet)"),
      // Story attention (lib/attention.mjs): every read goes by a primary key or the t index.
      storyBucketPut: p(`INSERT OR REPLACE INTO story_buckets (story_key, t, buyers, buy_usd, sells, launches_fast, launches, site_buyers, leader_mint, leader_buyers, coins, flags)
        VALUES (:key, :t, :buyers, :buyUsd, :sells, :launchesFast, :launches, :siteBuyers, :leaderMint, :leaderBuyers, :coins, :flags)`),
      storyRows: p("SELECT t, buyers, buy_usd, sells, launches_fast, launches, site_buyers, leader_mint, leader_buyers, coins, flags FROM story_buckets WHERE story_key = ? AND t >= ? ORDER BY t ASC LIMIT ?"),
      storyBuyersIn: p("SELECT COALESCE(SUM(buyers), 0) AS n, COUNT(*) AS c FROM story_buckets WHERE story_key = ? AND t >= ? AND t < ?"),
      siteSeenIn: p("SELECT COUNT(*) AS c FROM story_buckets WHERE story_key = '*' AND t >= ? AND t < ? AND (flags & 1) = 0"),
      storyBaseRows: p("SELECT t, buyers, site_buyers, flags FROM story_buckets WHERE story_key = ? AND t >= ? ORDER BY t ASC LIMIT ?"),
      // story by story ("+": through the time index, sorted, not a walk of the whole key), so one step's rows share pages;
      // storyTrim bounds the window to the oldest hour, so the sort is of one hour's rows however long the backlog
      storyCoinPut: p("INSERT OR REPLACE INTO story_coins (t, mint, story_key, subject_key, group_key, buyers, buy_usd, sells, price_usd, copy_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      storyCoinsTrim: p("DELETE FROM story_coins WHERE (t, mint) IN (SELECT t, mint FROM story_coins WHERE t < ? ORDER BY t LIMIT ?)"),
      storyTrim: p("DELETE FROM story_buckets WHERE (story_key, t) IN (SELECT story_key, t FROM story_buckets WHERE t < ? ORDER BY +story_key LIMIT ?)"),
      storyMinT: p("SELECT MIN(t) AS m FROM story_buckets"),
      storyStartGet: p("SELECT start_at, source, first_buyers_at FROM story_starts WHERE story_key = ?"),
      // the story timeline (lib/timeline.mjs): every story's buckets in a window (the t index), and the starts of a list of keys
      // the story timeline (lib/timeline.mjs): one grouped pass over the window (the t index) for each story's peak and first
      // bucket, then the window's rows of the listed stories only (the primary key, one range per story)
      timelinePeaks: p("SELECT story_key, max(buyers) AS peak, min(t) AS first_t FROM story_buckets WHERE t >= ?1 AND t < ?2 AND story_key <> '*' AND substr(story_key, 1, 2) NOT IN ('t:', 'g:') GROUP BY story_key"),
      timelineRowsOf: p("SELECT b.story_key, b.t, b.buyers, b.buy_usd, b.launches, b.leader_mint, b.leader_buyers, b.coins FROM json_each(?3) k JOIN story_buckets b ON b.story_key = k.value AND b.t >= ?1 AND b.t < ?2"),
      timelineStarts: p("SELECT story_key, start_at, source FROM story_starts WHERE story_key IN (SELECT value FROM json_each(?))"),
      storyStartPut: p(`INSERT INTO story_starts (story_key, start_at, source, first_buyers_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(story_key) DO UPDATE SET start_at = excluded.start_at, source = excluded.source, updated_at = excluded.updated_at`),
      calibPut: p(`INSERT OR IGNORE INTO calib (story_key, t, phase, multiple, buyers5m, hour_buyers, leader_mint, leader_price_usd, story_buy_usd)
        VALUES (:key, :t, :phase, :multiple, :buyers5m, :hourBuyers, :leaderMint, :leaderPriceUsd, :storyBuyUsd)`),
      calibDue1: p("SELECT story_key, t, leader_mint FROM calib WHERE filled_1h = 0 AND t <= ? ORDER BY t ASC LIMIT ?"),
      calibDue6: p("SELECT story_key, t, leader_mint FROM calib WHERE filled_6h = 0 AND t <= ? ORDER BY t ASC LIMIT ?"),
      calibFill1: p("UPDATE calib SET buyers_1h = ?, price_1h = ?, cov_1h = ?, filled_1h = 1 WHERE story_key = ? AND t = ?"),
      calibFill6: p("UPDATE calib SET buyers_6h = ?, price_6h = ?, cov_6h = ?, filled_6h = 1 WHERE story_key = ? AND t = ?"),
      calibTrim: p("DELETE FROM calib WHERE (story_key, t) IN (SELECT story_key, t FROM calib WHERE t < ? LIMIT ?)"),
      coinDayAdd: p(`INSERT INTO coin_days (mint, day, high_usd, low_usd, close_usd, close_t, buyers, buys, trades, volume_usd)
        VALUES (:mint, :day, :high, :low, :close, :closeT, :buyers, :buys, :trades, :volume)
        ON CONFLICT(mint, day) DO UPDATE SET
          high_usd = CASE WHEN excluded.high_usd IS NULL THEN high_usd WHEN high_usd IS NULL OR excluded.high_usd > high_usd THEN excluded.high_usd ELSE high_usd END,
          low_usd = CASE WHEN excluded.low_usd IS NULL THEN low_usd WHEN low_usd IS NULL OR excluded.low_usd < low_usd THEN excluded.low_usd ELSE low_usd END,
          close_usd = CASE WHEN excluded.close_t IS NOT NULL AND (close_t IS NULL OR excluded.close_t >= close_t) THEN excluded.close_usd ELSE close_usd END,
          close_t = CASE WHEN excluded.close_t IS NOT NULL AND (close_t IS NULL OR excluded.close_t >= close_t) THEN excluded.close_t ELSE close_t END,
          buyers = buyers + excluded.buyers, buys = buys + excluded.buys, trades = trades + excluded.trades, volume_usd = volume_usd + excluded.volume_usd`),
      coinDaysOf: p("SELECT day, high_usd, low_usd, close_usd, close_t, buyers, buys, trades, volume_usd FROM coin_days WHERE mint = ? AND day >= ? ORDER BY day ASC"),
      eventBucketPut: p(`INSERT OR REPLACE INTO event_buckets (event_id, t, buyers, pre_buyers, new_buyers, pre_coins, new_coins, site_buyers, flags)
        VALUES (:id, :t, :buyers, :preBuyers, :newBuyers, :preCoins, :newCoins, :siteBuyers, :flags)`),
    };
  }

  transaction(fn) {
    const bf = this.#bf && { ...this.#bf }; // the backfill counts as they were, for a rollback
    this.db.exec("BEGIN");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) {
      this.#bf = bf; // first: SQLite may have rolled the transaction back itself (a full disk, an I/O error), and then ROLLBACK throws
      try { this.db.exec("ROLLBACK"); } catch (r) { if (this.db.isTransaction !== false) throw r; } // none left to roll back: the first error is the one to report
      throw e;
    }
  }

  kvGet(key, fallback = null) { const r = this.q.kvGet.get(key); return r ? JSON.parse(r.value) : fallback; }
  kvSet(key, value) { this.q.kvSet.run(key, JSON.stringify(value)); }
  backfillGet(key, fallback = null) { const r = this.q.bfGet.get(key); return r ? JSON.parse(r.value) : fallback; }
  backfillSet(key, value) { this.q.bfSet.run(key, JSON.stringify(value)); }
  backfillAll() { return Object.fromEntries(this.q.bfAll.all().map((r) => [r.key, JSON.parse(r.value)])); }

  upsertMint(m) { this.q.mintUpsert.run({ mint: m.mint, decimals: m.decimals ?? null, tokenProgram: m.tokenProgram ?? null, supply: m.supply ?? null, name: m.name ?? null, symbol: m.symbol ?? null, uri: m.uri ?? null, onchainAt: m.onchainAt ?? 0 }); }
  allMints() { return this.q.mintsAll.all().map((r) => ({ mint: r.mint, decimals: r.decimals, tokenProgram: r.token_program, supply: r.supply, name: r.name, symbol: r.symbol, uri: r.uri, onchainAt: r.onchain_at })); }

  upsertCoin(c) {
    this.q.coinUpsert.run({
      mint: c.mint, curve: c.curve, depth: c.depth, quoteMint: c.quoteMint ?? null, creator: c.creator, tracked: c.tracked ? 1 : 0,
      vtr: c.virtualTokenReserves, vqr: c.virtualQuoteReserves, rtr: c.realTokenReserves, rqr: c.realQuoteReserves, supply: c.tokenTotalSupply, ivqr: c.initialVirtualQuoteReserves ?? "0",
      complete: c.complete ? 1 : 0, migrated: c.migrated ? 1 : 0, mayhem: c.mayhem ? 1 : 0, holderReward: c.holderReward ? 1 : 0, creatorFeeBps: c.creatorFeeBps ?? 0,
      pool: c.pool ?? null, poolBaseVault: c.poolBaseVault ?? null, poolQuoteVault: c.poolQuoteVault ?? null, poolBase: c.poolBase ?? null, poolQuote: c.poolQuote ?? null, poolVirtualQuote: c.poolVirtualQuote ?? null,
      createdAt: c.createdAt ?? null, createdSlot: c.createdSlot ?? null, createdProbe: c.createdProbe ? 1 : 0, shares: c.shares ? JSON.stringify(c.shares) : null, sharesAt: c.sharesAt ?? 0,
      refreshedAt: c.refreshedAt ?? 0, updatedAt: c.updatedAt ?? Date.now(), feePaid: c.feePaid ?? null, launcher: c.launcher ?? null,
    });
  }
  /** Moves a coin's `updated_at` (ms) forward without rewriting the row (a child's trade changes the parent's locked value). */
  touchCoin(mint, at) { this.q.coinTouch.run(at, mint, at); }
  allCoins() {
    return this.q.coinsAll.all().map((r) => ({
      mint: r.mint, curve: r.curve, depth: r.depth, quoteMint: r.quote_mint, creator: r.creator, tracked: !!r.tracked,
      virtualTokenReserves: r.vtr, virtualQuoteReserves: r.vqr, realTokenReserves: r.rtr, realQuoteReserves: r.rqr, tokenTotalSupply: r.supply, initialVirtualQuoteReserves: r.ivqr,
      complete: !!r.complete, migrated: !!r.migrated, mayhem: !!r.mayhem, holderReward: !!r.holder_reward, creatorFeeBps: r.creator_fee_bps,
      pool: r.pool, poolBaseVault: r.pool_base_vault, poolQuoteVault: r.pool_quote_vault, poolBase: r.pool_base, poolQuote: r.pool_quote, poolVirtualQuote: r.pool_vquote ?? null,
      createdAt: r.created_at, createdSlot: r.created_slot, createdProbe: !!r.created_probe, shares: r.shares ? JSON.parse(r.shares) : null, sharesAt: r.shares_at,
      refreshedAt: r.refreshed_at, updatedAt: r.updated_at, feePaid: r.fee_paid ?? null, launcher: r.launcher ?? null,
    }));
  }

  /**
   * Inserts a trade. Returns whether the row is new: a replayed (sig, mint, idx) — both live streams can
   * deliver one transaction — is ignored, so the in-memory activity counters never count it twice.
   *
   * Retention per mint (DESIGN §6.5): its newest `keep` rows (2 000) whatever their age, and every row of the last
   * 24 h up to `max` (50 000). The 24 h part is what the activity counters are seeded from at boot: a graduated coin
   * makes thousands of pool trades a day, and capped at 2 000 its 24 h volume fell to its last hour or two on every
   * restart. The trim runs once per `every` new rows of a mint, not per insert: on a mint at the cap it used to cost
   * 1.5 ms a trade (a 2 000-row subquery to delete one row).
   */
  insertTrade(t, keep = TRADE_KEEP, { max = 50_000, every = 200, dayS = TRADE_DAY_S } = {}) {
    const r = this.q.tradeInsert.run({ sig: t.sig, mint: t.mint, idx: t.idx ?? 0, slot: t.slot, time: t.time, isBuy: t.isBuy ? 1 : 0, user: t.user, baseAmount: t.baseAmount, quoteAmount: t.quoteAmount, priceQuote: t.priceQuote, priceUsd: t.priceUsd ?? null, valueUsd: t.valueUsd ?? null });
    if (!(Number(r.changes) > 0)) return false;
    const n = (this.tradeAdds.get(t.mint) ?? 0) + 1;
    if (n < every) { this.tradeAdds.set(t.mint, n); return true; }
    this.tradeAdds.delete(t.mint);
    this.q.tradeTrimOld.run(t.mint, Math.floor(Date.now() / 1000) - dayS, keep);
    if (max > keep) this.q.tradeTrim.run(t.mint, t.mint, max);
    return true;
  }
  static trade(r) { return { sig: r.sig, mint: r.mint, slot: r.slot, time: r.time, isBuy: !!r.is_buy, user: r.user, baseAmount: r.base_amount, quoteAmount: r.quote_amount, priceQuote: r.price_quote, priceUsd: r.price_usd, valueUsd: r.value_usd }; }
  tradesFor(mint, limit = 50) { return this.q.tradesFor.all(mint, limit).map(Db.trade); }
  tradesSince(mint, since) { return this.q.tradesSince.all(mint, since).map(Db.trade); }
  /** The mint's trades with `from <= time < to`, in (time, slot, rowid) order (as tradesSince). */
  tradesRange(mint, from, to) { return this.q.tradesRange.all(mint, from, to).map(Db.trade); }
  /** The time of the mint's newest trade strictly before `t`; null when it has none. */
  tradeTimeBefore(mint, t) { return this.q.tradeTimeBefore.get(mint, t)?.t ?? null; }
  /** Every stored trade at or after `sinceS`, oldest first (trades_time index): what seeds the activity counters at boot. */
  /** Trades since `sinceS` in time order, one at a time: the boot seed reads millions of rows, and as one array they were 1.7 GB of heap at 3M. */
  *tradesWindow(sinceS) { for (const r of this.q.tradesWindow.iterate(sinceS)) yield { mint: r.mint, slot: r.slot, time: r.time, isBuy: !!r.is_buy, valueUsd: r.value_usd, priceUsd: r.price_usd, user: r.user, baseAmount: r.base_amount }; }
  /** `{ bought, sold }`: base units (as numbers) `user` bought and sold of `mint` with `from <= time < to`. */
  creatorFlow(mint, from, to, user) {
    let bought = 0, sold = 0;
    for (const r of this.q.creatorFlow.all(mint, from, to, user)) { if (r.is_buy) bought = r.amt ?? 0; else sold = r.amt ?? 0; }
    return { bought, sold };
  }
  /** The time of the mint's oldest stored trade, or null. */
  tradeFirstTime(mint) { return this.q.tradeFirstTime.get(mint)?.t ?? null; }
  /** The USD price of the mint's newest stored trade that has one, or null. */
  lastPriceUsd(mint) { return this.q.lastPriceUsd.get(mint)?.price_usd ?? null; }
  /** A coin's launch-window creator flow `{ bought, sold, createdAt, sniped }` (lib/wakeups.mjs; `sniped` null when not recorded), or null. */
  launchFlowGet(mint) { const r = this.q.launchFlowGet.get(mint); return r ? { bought: r.bought, sold: r.sold, createdAt: r.created_at, sniped: r.sniped ?? null } : null; }
  /** Writes it unless the coin has one; returns whether it was written. */
  launchFlowPut(mint, bought, sold, createdAt, sniped = null) { return Number(this.q.launchFlowPut.run(mint, bought, sold, createdAt, sniped).changes) > 0; }
  /**
   * Base units (as a number) wallets other than `user` bought of `mint` from its creation `at` through `at + snipeS`, or in
   * its creation slot `slot` (null: none) up to `at + upToS`: the sniper share's rows while they still reach the launch.
   */
  sniperFlow(mint, at, snipeS, user, slot = null, upToS = 600) { return this.q.sniperFlow.get(mint, at, at + upToS, user, at + snipeS, slot ?? -1)?.amt ?? 0; }
  volume24h(mint) { const r = this.q.vol24.get(mint, now() - 86_400); return { trades: r.n, usd: r.usd }; }
  /** A fresh GROUP BY over 24 h of trades; the API reads the in-memory counters (activity.mjs) instead, this is their reference. */
  volume24hAll() { return new Map(this.q.vol24All.all(now() - 86_400).map((r) => [r.mint, { trades: r.n, usd: r.usd }])); }

  metaGet(uri) { const r = this.q.metaGet.get(uri); return r ? Db.meta(r) : null; }
  allMeta() { return this.q.metaAll.all().map(Db.meta); }
  static meta(r) { return { uri: r.uri, image: r.image, description: r.description, twitter: r.twitter, telegram: r.telegram, website: r.website, fetchedAt: r.fetched_at, ok: !!r.ok, error: r.error, attempts: r.attempts ?? 0, deadStreak: r.dead_streak ?? 0 }; }
  metaSet(m) { this.q.metaSet.run({ uri: m.uri, image: m.image ?? null, description: m.description ?? null, twitter: m.twitter ?? null, telegram: m.telegram ?? null, website: m.website ?? null, fetchedAt: m.fetchedAt ?? now(), ok: m.ok ? 1 : 0, error: m.error ?? null, attempts: m.attempts ?? 0, deadStreak: m.deadStreak ?? 0 }); }

  backfillCurveUpsert(c) {
    // one lookup, not #bfWrite's two: the asset walk upserts tens of thousands of rows in one transaction, and an upsert
    // never touches resolved_at or error, so a row it creates is pending and a row it updates keeps its state
    const isNew = this.#bf ? this.#bfState(c.curve) == null : false;
    const r = this.q.bfCurveUpsert.run({ curve: c.curve, depth: c.depth, quoteMint: c.quoteMint ?? null, data: c.data, graduated: c.graduated ? 1 : 0, rq: c.rq });
    if (isNew && this.#bf) this.#bf.total++;
    return r;
  }
  backfillPending(limit) { return this.q.bfCurvePending.all(limit).map((r) => ({ curve: r.curve, depth: r.depth, quoteMint: r.quote_mint, data: r.data })); }
  backfillResolve(curve, mint) { this.#bfWrite(curve, () => this.q.bfCurveResolve.run(mint, now(), curve)); }
  backfillFail(curve, error) { this.#bfWrite(curve, () => this.q.bfCurveFail.run(String(error).slice(0, 200), now(), curve)); }
  /**
   * `{ total, resolved, failed }` over backfill_curves. Counted once, then kept: every write through this class moves
   * them (the upsert, #bfWrite) and a rolled-back transaction restores them. The COUNT reads every row (~450k with their curve
   * data on the local index) and held the event loop ~0.25 s, twice per resolve batch (Nov 13 2026). A row changed
   * by another process (a manual reset of failed rows) shows after backfillRecount() or a restart.
   */
  backfillStats() {
    if (!this.#bf) { const r = this.q.bfCurveStats.get(); this.#bf = { total: r.total ?? 0, resolved: r.resolved ?? 0, failed: r.failed ?? 0 }; }
    return { ...this.#bf };
  }
  /** backfillStats() counted again from the table. */
  backfillRecount() { this.#bf = null; return this.backfillStats(); }
  #bf = null;
  /** The row's state ("resolved" | "failed" | "pending", null when absent) before and after `write`, applied to the counts. */
  #bfWrite(curve, write) {
    if (!this.#bf) return write();
    const before = this.#bfState(curve), r = write(), after = this.#bfState(curve);
    if (before !== after) {
      const b = this.#bf;
      if (before == null) b.total++; else if (before !== "pending") b[before]--;
      if (after == null) b.total--; else if (after !== "pending") b[after]++;
    }
    return r;
  }
  #bfState(curve) { const r = this.q.bfCurveState.get(curve); return !r ? null : r.failed ? "failed" : r.resolved ? "resolved" : "pending"; }
  backfillCurve(curve) { const r = this.q.bfCurveByKey.get(curve); return r ? { curve: r.curve, depth: r.depth, quoteMint: r.quote_mint, data: r.data, mint: r.mint, resolvedAt: r.resolved_at } : null; }
  backfillUnresolvedCurves() { return new Set(this.q.bfCurvesUnresolvedKeys.all().map((r) => r.curve)); }

  // Ledger of the files /api/upload wrote (metahost.mjs garbage-collects unclaimed ones; files
  // written by other tools are not listed and therefore never touched).
  uploadRecord(u) { this.q.uploadInsert.run({ name: u.name, kind: u.kind, pair: u.pair ?? null, ip: u.ip ?? null, bytes: u.bytes ?? 0, at: u.at ?? now() }); }
  uploadsStale(before, limit = 500) { return this.q.uploadStale.all(before, limit).map((r) => ({ name: r.name, kind: r.kind, pair: r.pair, at: r.at })); }
  uploadForget(name) { this.q.uploadDelete.run(name); }
  uploadsUsingImage(name) { return this.q.uploadPairCount.get(name).n; }
  uploadCount() { return this.q.uploadCount.get().n; }

  /**
   * The price a coin last traded at, at or before `t` (unix s), else its first trade after `t`:
   * the reference of a 24 h change (the second case is a coin whose history starts inside the window).
   */
  /** A mint's price row at time `t`: its last trade at or before it (priceAt), its first one after it (priceAfterT). */
  priceAt(mint, t) { const r = this.q.priceBefore.get(mint, t); return r ? { priceQuote: r.price_quote, priceUsd: r.price_usd, time: r.time } : null; }
  /** A mint's last trade at or before `t` that has a USD price, `{ priceUsd, time }` (a trade stored while its quote's USD was unknown is skipped). */
  usdPriceAt(mint, t) { const r = this.q.usdPriceBefore.get(mint, t); return r ? { priceUsd: r.price_usd, time: r.time } : null; }
  priceAfterT(mint, t) { const r = this.q.priceAfter.get(mint, t); return r ? { priceQuote: r.price_quote, priceUsd: r.price_usd, time: r.time } : null; }
  // ---- the trade gap fill (lib/trade-fill.mjs)
  tradeHas(sig, mint) { return !!this.q.tradeHas.get(sig, mint); }
  tradeAfter(mint, t) { const r = this.q.tradeAfter.get(mint, t); return r ? { sig: r.sig, time: r.time } : null; }
  /** The mint's trades with a time in (a, b], counted up to `cap` (the count stops there, so a busy coin costs no more). */
  tradesBetween(mint, a, b, cap = 1000) { return this.q.tradesBetween.get(mint, a, b, cap).n; }
  tradeOldestTime(mint) { return this.q.tradeOldest.get(mint)?.t ?? null; }
  /** The time of the mint's n-th newest trade (1 = the newest); null when it has fewer. */
  tradeNthTime(mint, n) { return n >= 1 ? this.q.tradeNth.get(mint, n - 1)?.time ?? null : null; }
  /** The fill's row of a mint, its gap id lists as Sets; null when it has none. */
  fillCoin(mint) {
    const r = this.q.fillCoinGet.get(mint);
    if (!r) return null;
    const ids = (v) => { try { const a = JSON.parse(v); return new Set(Array.isArray(a) ? a.filter(Number.isInteger) : []); } catch { return new Set(); } };
    return { mint: r.mint, done: ids(r.done), whole: ids(r.whole), partial: ids(r.partial), day: r.day, calls: r.calls, rows: r.rows, unread: r.unread, cut: r.cut, at: r.at };
  }
  fillCoinSave(f) { this.q.fillCoinSet.run({ mint: f.mint, done: JSON.stringify([...f.done]), whole: JSON.stringify([...f.whole]), partial: JSON.stringify([...(f.partial ?? [])]), day: f.day ?? 0, calls: f.calls ?? 0, rows: f.rows ?? 0, unread: f.unread ?? 0, cut: f.cut ?? 0, at: f.at ?? 0 }); }
  fillCoinsPrune(beforeS) { return Number(this.q.fillCoinsPrune.run(beforeS).changes); }
  // ---- the chart history (lib/chart-history.mjs): rows come back raw (`pools` and `data` JSON strings), the caller parses them once into its cache
  histGet(mint, res, unit) { return this.q.histGet.get(mint, res, unit) ?? null; }
  histSet(r) { this.q.histSet.run({ mint: r.mint, res: r.res, unit: r.unit, state: r.state, pools: typeof r.pools === "string" ? r.pools : JSON.stringify(r.pools ?? []), covFrom: r.covFrom, covTo: r.covTo, fetchedAt: r.fetchedAt, askedAt: r.askedAt, data: typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? []), migAt: r.migAt ?? null }); }
  histTouch(mint, res, unit, askedAt) { return Number(this.q.histTouch.run(askedAt, mint, res, unit).changes) > 0; }
  samplesGet(mint) { return this.q.samplesGet.get(mint) ?? null; }
  samplesSet(r) { this.q.samplesSet.run({ mint: r.mint, state: r.state, fromT: r.fromT, toT: r.toT, calls: r.calls ?? 0, at: r.at, askedAt: r.askedAt, retryAt: r.retryAt ?? 0, retryExt: r.retryExt ? 1 : 0, data: typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? []) }); }
  samplesTouch(mint, askedAt) { return Number(this.q.samplesTouch.run(askedAt, mint).changes) > 0; }
  /**
   * Drops rows of both tables not asked for since `beforeS`, then the least recently asked past `maxRows` and
   * `maxSampleRows`; `keep` (`{ mint, res, unit }`: the SOL/USD reference) stays while any samples row was written since
   * `beforeS`. Returns how many rows went.
   */
  histPrune(beforeS, maxRows, maxSampleRows, keep = null) {
    const k = [keep?.mint ?? "", keep?.res ?? 0, keep?.unit ?? ""];
    return this.transaction(() => {
      let n = Number(this.q.samplesPruneOld.run(beforeS).changes) + Number(this.q.histPruneOld.run(beforeS, ...k).changes);
      const hs = this.q.histCount.get().n - maxRows;
      if (hs > 0) n += Number(this.q.histPruneOver.run(beforeS, ...k, hs).changes);
      const ss = this.q.samplesCount.get().n - maxSampleRows;
      if (ss > 0) n += Number(this.q.samplesPruneOver.run(ss).changes);
      return n;
    });
  }
  /**
   * Keys `{ mint, res, unit }` of the rows whose data JSON is longer than `minBytes` that were asked before `beforeS` or
   * are past the `keep` most recently asked such rows (lib/chart-history.mjs trims them to their newest candles).
   */
  histDeep(minBytes, keep, beforeS) { return this.q.histDeep.all(minBytes, keep, beforeS).map((r) => ({ mint: r.mint, res: r.res, unit: r.unit })); }
  histCounts() { return { history: this.q.histCount.get().n, samples: this.q.samplesCount.get().n }; }
  // ---- the linked posts' texts (lib/xposts.mjs): one row per X post id, times in unix s
  xpostGet(id) { const r = this.q.xpostGet.get(id); return r ? { id: r.id, state: r.state, handle: r.handle, text: r.text, flagged: !!r.flagged, fetchedAt: r.fetched_at, askedAt: r.asked_at, recheckAt: r.recheck_at } : null; }
  xpostSet(r) { this.q.xpostSet.run({ id: r.id, state: r.state, handle: r.handle ?? null, text: r.text ?? null, flagged: r.flagged ? 1 : 0, fetchedAt: r.fetchedAt, askedAt: r.askedAt, recheckAt: r.recheckAt }); }
  xpostDel(id) { return Number(this.q.xpostDel.run(id).changes) > 0; }
  xpostTouch(id, at) { return Number(this.q.xpostTouch.run(at, id).changes) > 0; }
  /** Writes many asked-for times (`[[id, at]]`) in one transaction; returns how many rows moved. */
  xpostTouchMany(rows) { let n = 0; if (rows.length) this.transaction(() => { for (const [id, at] of rows) n += Number(this.q.xpostTouch.run(at, id).changes); }); return n; }
  /** Drops the rows not asked for since `beforeS`, then the least recently asked past `maxRows`; returns how many went. */
  xpostPrune(beforeS, maxRows) { return this.transaction(() => { let n = Number(this.q.xpostPruneOld.run(beforeS).changes); const over = this.q.xpostCount.get().n - maxRows; if (over > 0) n += Number(this.q.xpostPruneOver.run(over).changes); return n; }); }
  xpostCount() { return this.q.xpostCount.get().n; }

  // ---- the narrative tags (lib/narrtags.mjs): the store its tagger reads and writes; times in unix s
  narrRecent(limit = 150) { return this.q.narrRecent.all(limit).map((r) => ({ id: Number(r.id), title: r.title, theme: r.theme })); }
  narrGet(id) { const r = this.q.narrGet.get(id); return r ? { id: Number(r.id), title: r.title, theme: r.theme } : null; }
  narrByKey(key) { const r = this.q.narrByKey.get(key); return r ? { id: Number(r.id), title: r.title, theme: r.theme } : null; }
  narrAdd({ title, theme, key, at }) { return Number(this.q.narrAdd.run(title, theme, key, at, at).lastInsertRowid); }
  narrTouch(id, at) { this.q.narrTouch.run(at, id); }
  narrCount() { return this.q.narrCount.get().n; }
  /** Whether narrative `id` had its one retitle. */
  narrRetitled(id) { return !!this.q.narrRetitled.get(id)?.retitled; }
  /** Gives narrative `id` a new title and key, once in its life (the theme stays); false when it was retitled before or is not there. */
  narrRetitle(id, title, key) { return Number(this.q.narrRetitle.run(title, key, id).changes) > 0; }
  /** Coins stored under narrative `id` (the coin_tags_narrative index). */
  narrTagged(id) { return this.q.narrTagged.get(id).n; }
  /**
   * The tagging rules changed (lib/narrtags.mjs applyTagRules): when the version stored under `key` is below `version`
   * (no row = 1), every row of `coin_tags` and `narratives` is deleted and `version` stored, in one transaction;
   * `narrative_spend` is not touched. `{ reset, from, tags, narratives }`: whether it ran, the version before, the rows deleted.
   */
  narrRulesReset(key, version) {
    const from = Number(this.kvGet(key, 1)) || 1;
    if (from >= version) return { reset: false, from, tags: 0, narratives: 0 };
    return this.transaction(() => {
      const tags = Number(this.q.tagWipe.run().changes), narratives = Number(this.q.narrWipe.run().changes);
      this.kvSet(key, version);
      return { reset: true, from, tags, narratives };
    });
  }
  tagGet(mint) { const r = this.q.tagGet.get(mint); return r ? { mint: r.mint, narrativeId: r.narrative_id == null ? null : Number(r.narrative_id), at: r.tagged_at, model: r.model, asks: r.asks, hadPost: !!r.had_post, bare: !!r.bare } : null; }
  tagSet(t) { this.q.tagSet.run({ mint: t.mint, narrativeId: t.narrativeId ?? null, at: t.at, model: t.model ?? null, asks: t.asks ?? 1, hadPost: t.hadPost ? 1 : 0, bare: t.bare ? 1 : 0 }); }
  /** `{ tagged, none }`: coins under a narrative, and coins the model answered "none" for. */
  tagCounts() { const r = this.q.tagCounts.get(); return { tagged: r.tagged, none: r.n - r.tagged }; }
  /** The tagged coins created after `sinceS`, `[{ mint, id, createdAt }]` (the coins_created index: a boot read of the last hour). */
  tagRecentCreated(sinceS) { return this.q.tagRecentCreated.all(sinceS).map((r) => ({ mint: r.mint, id: Number(r.id), createdAt: r.created_at })); }
  spendGet(day) { const r = this.q.spendGet.get(day); return r ? { inTokens: r.in_tokens, outTokens: r.out_tokens, usd: r.usd, requests: r.requests } : { inTokens: 0, outTokens: 0, usd: 0, requests: 0 }; }
  spendAdd(day, { inTokens = 0, outTokens = 0, usd = 0, requests = 0 } = {}) { this.q.spendAdd.run({ day, inTokens, outTokens, usd, requests }); }
  priceRef(mint, t) { const r = this.q.priceBefore.get(mint, t) ?? this.q.priceAfter.get(mint, t); return r ? { priceQuote: r.price_quote, priceUsd: r.price_usd, time: r.time } : null; }

  // Partner API keys (lib/apikeys.mjs owns the logic; only the sha256 of a key is ever stored).
  apiKeyInsert({ name, contact = null, hash, tier = "partner", createdAt = now() }) { return Number(this.q.keyInsert.run(name, contact, hash, tier, createdAt).lastInsertRowid); }
  apiKeyByHash(hash) { const r = this.q.keyByHash.get(hash); return r ? { id: r.id, name: r.name, tier: r.tier, revokedAt: r.revoked_at } : null; }
  apiKeys() { return this.q.keysAll.all().map((r) => ({ id: r.id, name: r.name, contact: r.contact, tier: r.tier, createdAt: r.created_at, revokedAt: r.revoked_at, lastUsedAt: r.last_used_at, requests: r.requests })); }
  apiKeyRevoke(id, at = now()) { return Number(this.q.keyRevoke.run(at, id).changes) > 0; }
  /** Adds batched per-key counters (`[{ id, requests, lastUsedAt }]`) in one transaction. */
  apiKeyUsage(rows) { if (rows.length) this.transaction(() => { for (const r of rows) this.q.keyUsage.run(r.requests, r.lastUsedAt, r.id); }); }

  // The image proxy's failure memory (lib/meta.mjs ImageCache): one row per url that failed, with its
  // kind ("gone" | "temp" | "nothumb"), consecutive attempts, the permanent failures since the last
  // success (`goneAttempts`) and the time (ms) it may be tried again.
  imgFailAll() { return this.q.imgFailAll.all().map((r) => ({ url: r.url, kind: r.kind, error: r.error, attempts: r.attempts, goneAttempts: r.gone_attempts ?? 0, at: r.failed_at, retryAt: r.retry_at })); }
  imgFailSet(f) { this.q.imgFailSet.run(f.url, f.kind, f.error == null ? null : String(f.error).slice(0, 200), f.attempts ?? 1, f.goneAttempts ?? 0, f.at ?? Date.now(), f.retryAt ?? Date.now()); }
  imgFailDelete(url) { this.q.imgFailDelete.run(url); }
  /** Forgets rows whose retry time is before `before` (ms); returns how many went. */
  imgFailPrune(before) { return Number(this.q.imgFailPrune.run(before).changes); }
  imgFailDropKind(kind) { return Number(this.q.imgFailDropKind.run(kind).changes); }

  // Wallet profit and loss (lib/pnl-tracker.mjs owns the logic): the tracked wallets with their history-scan state,
  // and each tracked wallet's own trades. Every read goes by the primary key or the (wallet, time) index.
  static pnlWallet(r) { return { wallet: r.wallet, addedAt: r.added_at, lastSeenAt: r.last_seen_at, state: r.state, beforeSig: r.before_sig ?? null, oldestTime: r.oldest_time ?? null, scanned: r.scanned, total: r.total, unread: r.unread, cut: !!r.cut, rows: r.rows, attempts: r.attempts, failedAt: r.failed_at, error: r.error ?? null, gapFrom: r.gap_from ?? null }; }
  pnlWallets() { return this.q.pnlWalletsAll.all().map(Db.pnlWallet); }
  pnlWalletAdd(wallet, at, state = "queued") { return Number(this.q.pnlWalletInsert.run(wallet, at, at, state).changes) > 0; }
  pnlWalletSeen(wallet, at) { this.q.pnlWalletSeen.run(at, wallet); }
  pnlWalletSave(w) { this.q.pnlWalletSave.run({ wallet: w.wallet, state: w.state, beforeSig: w.beforeSig ?? null, oldestTime: w.oldestTime ?? null, scanned: w.scanned, total: w.total, unread: w.unread, cut: w.cut ? 1 : 0, rows: w.rows, attempts: w.attempts ?? 0, failedAt: w.failedAt ?? 0, error: w.error == null ? null : String(w.error).slice(0, 200), gapFrom: w.gapFrom ?? null }); }
  /** Every wallet tracked at or before `at` may have missed trades since then (the server was down): its `gap_from` moves back to it. */
  pnlWalletsGap(at) { return Number(this.q.pnlWalletsGap.run(at).changes); }
  pnlWalletRows(wallet, rows, cut) { this.q.pnlWalletRows.run(rows, cut ? 1 : 0, wallet); }
  /** Forgets a wallet and its trades (eviction); returns how many trade rows went. */
  pnlWalletDrop(wallet) { return this.transaction(() => { this.q.pnlWalletDelete.run(wallet); this.q.pnlUnreadDrop.run(wallet); return Number(this.q.walletTradesDrop.run(wallet).changes); }); }
  // The transactions a wallet's scan could not read (at most a couple of hundred per wallet): the signature, the `ord`
  // its trades get, how often it was tried again and when it is tried next (ms; null = given up: the row stays, so the
  // transaction is not counted a second time).
  static pnlUnread(r) { return { wallet: r.wallet, sig: r.sig, ord: r.ord, attempts: r.attempts, nextAt: r.next_at ?? null, errors: r.errors ?? 0 }; }
  /** Remembers an unread transaction; false when it is stored already. */
  pnlUnreadAdd(wallet, sig, ord, addedAt, nextAt) { return Number(this.q.pnlUnreadInsert.run(wallet, sig, ord ?? 0, addedAt, nextAt ?? null).changes) > 0; }
  pnlUnreadHas(wallet, sig) { return !!this.q.pnlUnreadHas.get(wallet, sig); }
  /** Forgets one (it was read); true when it was stored. */
  pnlUnreadDelete(wallet, sig) { return Number(this.q.pnlUnreadDelete.run(wallet, sig).changes) > 0; }
  /** Forgets a wallet's; returns how many went. */
  pnlUnreadDrop(wallet) { return Number(this.q.pnlUnreadDrop.run(wallet).changes); }
  /** After one more try: `attempts` (the endpoint answered, the transaction still does not read) or `errors` (it did not answer, in a row) moved on. */
  pnlUnreadTried(wallet, sig, attempts, nextAt, errors = 0) { this.q.pnlUnreadTried.run(attempts, nextAt ?? null, errors, wallet, sig); }
  /** Those whose next try is due at `at` (ms), the longest waiting first. */
  pnlUnreadDue(at, limit = 20) { return this.q.pnlUnreadDue.all(at, limit).map(Db.pnlUnread); }
  /** When the next one is due (ms), null when none waits. */
  pnlUnreadNext() { return this.q.pnlUnreadNext.get()?.at ?? null; }
  pnlUnreadCount(wallet = null) { return wallet == null ? this.q.pnlUnreadCount.get().n : this.q.pnlUnreadCountOf.get(wallet).n; }
  pnlUnreadOf(wallet) { return this.q.pnlUnreadOf.all(wallet).map(Db.pnlUnread); }
  /** Wallets that count unread transactions but have none stored (rows from before they were stored). */
  pnlWalletsUnstored() { return this.q.pnlWalletsUnstored.all().map((r) => r.wallet); }
  /** Inserts one trade of a tracked wallet; false when the row (wallet, sig, mint, idx) is already there. */
  insertWalletTrade(wallet, t) { return Number(this.q.walletTradeInsert.run({ wallet, sig: t.sig, mint: t.mint, idx: t.idx ?? 0, slot: t.slot ?? 0, time: t.time, isBuy: t.isBuy ? 1 : 0, baseAmount: String(t.baseAmount), quoteAmount: String(t.quoteAmount), ord: t.ord ?? 0 }).changes) > 0; }
  static walletTrade(r) { return { id: r.id, sig: r.sig, mint: r.mint, idx: r.idx, slot: r.slot, ord: r.ord, time: r.time, isBuy: !!r.is_buy, baseAmount: r.base_amount, quoteAmount: r.quote_amount }; }
  /**
   * A wallet's trades in trade order, oldest first: `limit` rows after the row `after` (a row this returned, null = from
   * the start). The caller pages through them between event-loop turns; each page is one range of the index.
   */
  walletTradesPage(wallet, after = null, limit = 2000) {
    const m = Number.MIN_SAFE_INTEGER, a = after ?? { time: m, slot: m, ord: m, idx: m, id: m };
    return this.q.walletTradesPage.all(wallet, a.time, a.slot, a.ord, a.idx, a.id, limit).map(Db.walletTrade);
  }
  /** A wallet's newest trades in trade order, newest first: `limit` rows before the place `before` (`{ time, slot, ord, idx, id }`, null = from the newest). */
  walletTradesNewest(wallet, before = null, limit = 50) {
    const M = Number.MAX_SAFE_INTEGER, b = before ?? { time: M, slot: M, ord: M, idx: M, id: M };
    return this.q.walletTradesNewest.all(wallet, b.time, b.slot, b.ord, b.idx, b.id, limit).map(Db.walletTrade);
  }
  /** The place of one stored trade of the wallet (an activity cursor), null when the row is gone. */
  walletTradeAt(wallet, id) { return this.q.walletTradeAt.get(id, wallet) ?? null; }
  /** Removes a wallet's `n` oldest trades; returns how many went. */
  walletTradesTrim(wallet, n) { return Number(this.q.walletTradesTrim.run(wallet, n).changes); }
  walletTradesCount(wallet) { return this.q.walletTradesCount.get(wallet).n; }

  // ---- story attention (lib/attention.mjs): times in unix s; a bucket's `t` is its start (a multiple of 300)
  /** Writes story bucket rows (`[{ key, t, buyers, buyUsd, sells, launchesFast, launches, siteBuyers, leaderMint, leaderBuyers, coins, flags }]`) in one transaction. */
  storyBucketsPut(rows) {
    if (!rows.length) return;
    this.transaction(() => { for (const r of rows) this.q.storyBucketPut.run({ key: r.key, t: r.t, buyers: r.buyers, buyUsd: r.buyUsd ?? 0, sells: r.sells ?? 0, launchesFast: r.launchesFast ?? 0, launches: r.launches ?? 0, siteBuyers: r.siteBuyers ?? 0, leaderMint: r.leaderMint ?? null, leaderBuyers: r.leaderBuyers ?? 0, coins: r.coins ?? 0, flags: r.flags ?? 0 }); });
  }
  /** Writes per-coin story rows (`[{ t, mint, storyKey, subjectKey, groupKey, buyers, buyUsd, sells, priceUsd, copyKey }]`) in one transaction. */
  storyCoinsPut(rows) {
    if (!rows.length) return;
    this.transaction(() => { for (const r of rows) this.q.storyCoinPut.run(r.t, r.mint, r.storyKey, r.subjectKey ?? null, r.groupKey ?? null, r.buyers, r.buyUsd ?? 0, r.sells ?? 0, r.priceUsd ?? null, r.copyKey ?? null); });
  }
  /** Deletes at most `limit` per-coin story rows older than `beforeT`, oldest first; returns how many went. */
  storyCoinsTrim(beforeT, limit) { return Number(this.q.storyCoinsTrim.run(beforeT, limit).changes); }
  /** A story's rows from `sinceT` on, oldest first, at most `limit`. */
  storyRows(key, sinceT, limit = 5000) {
    return this.q.storyRows.all(key, sinceT, limit).map((r) => ({ t: r.t, buyers: r.buyers, buyUsd: r.buy_usd, sells: r.sells, launchesFast: r.launches_fast, launches: r.launches, siteBuyers: r.site_buyers, leaderMint: r.leader_mint, leaderBuyers: r.leader_buyers, coins: r.coins, flags: r.flags }));
  }
  /** A story's rows from `sinceT` on for its baseline (lib/attention.mjs baselineOf): `[{ t, buyers, siteBuyers, flags }]`, oldest first, at most `limit`. */
  storyBaseRows(key, sinceT, limit) { return this.q.storyBaseRows.all(key, sinceT, limit).map((r) => ({ t: r.t, buyers: r.buyers, siteBuyers: r.site_buyers, flags: r.flags })); }
  /** `{ buyers, rows }`: the sum of a story's bucket buyers with `from <= t < to`, and how many rows that was. */
  storyBuyersIn(key, from, to) { const r = this.q.storyBuyersIn.get(key, from, to); return { buyers: Number(r.n), rows: Number(r.c) }; }
  /** How many site rows ('*') with `from <= t < to` are not partial: the buckets of that window the server saw whole. */
  siteSeenIn(from, to) { return Number(this.q.siteSeenIn.get(from, to).c); }
  /** Deletes at most `limit` story bucket rows older than `beforeT`, from the oldest hour of them, story by story; returns how many went (0: none older is left). */
  storyTrim(beforeT, limit) {
    const m = this.q.storyMinT.get()?.m;
    if (m == null || m >= beforeT) return 0;
    return Number(this.q.storyTrim.run(Math.min(beforeT, m + 3600), limit).changes);
  }
  /** The story timeline's grouped pass: `[{ key, peak, firstT }]` per story with buckets in `from <= t < to`, site row and t:/g: filings left out. */
  timelinePeaks(from, to) { return this.q.timelinePeaks.all(from, to).map((r) => ({ key: r.story_key, peak: r.peak, firstT: r.first_t })); }
  /** The window's rows of the stories `keys`: `[{ key, t, buyers, buyUsd, launches, leaderMint, leaderBuyers, coins }]`. */
  timelineRowsOf(keys, from, to) { return keys.length ? this.q.timelineRowsOf.all(from, to, JSON.stringify(keys)).map((r) => ({ key: r.story_key, t: r.t, buyers: r.buyers, buyUsd: r.buy_usd, launches: r.launches, leaderMint: r.leader_mint, leaderBuyers: r.leader_buyers, coins: r.coins })) : []; }
  /** Map key to `{ startAt, source }` for the stored starts of `keys`. */
  timelineStarts(keys) { const m = new Map(); if (keys.length) for (const r of this.q.timelineStarts.all(JSON.stringify(keys))) m.set(r.story_key, { startAt: r.start_at, source: r.source }); return m; }
  storyStartGet(key) { const r = this.q.storyStartGet.get(key); return r ? { startAt: r.start_at, source: r.source, firstBuyersAt: r.first_buyers_at } : null; }
  /** Writes story starts (`[{ key, startAt, source, firstBuyersAt }]`) in one transaction: a new row, or a moved `startAt` (first_buyers_at never changes). */
  storyStartsPut(rows, at) { if (rows.length) this.transaction(() => { for (const r of rows) this.q.storyStartPut.run(r.key, r.startAt, r.source, r.firstBuyersAt, at); }); }
  /** Writes calibration snapshots in one transaction (one per story and bucket: a second is ignored). */
  calibPut(rows) {
    if (!rows.length) return;
    this.transaction(() => { for (const r of rows) this.q.calibPut.run({ key: r.key, t: r.t, phase: r.phase, multiple: r.multiple ?? null, buyers5m: r.buyers5m, hourBuyers: r.hourBuyers, leaderMint: r.leaderMint ?? null, leaderPriceUsd: r.leaderPriceUsd ?? null, storyBuyUsd: r.storyBuyUsd ?? 0 }); });
  }
  /** Snapshots whose 1 h (`h` 1) or 6 h (`h` 6) outcome is not filled, with `t <= upToT`, oldest first: `[{ key, t, leaderMint }]`. */
  calibDue(h, upToT, limit) { return (h === 6 ? this.q.calibDue6 : this.q.calibDue1).all(upToT, limit).map((r) => ({ key: r.story_key, t: r.t, leaderMint: r.leader_mint })); }
  /** Fills outcomes (`[{ key, t, buyers, priceUsd, cov }]`; `cov`: the window's buckets seen whole) of horizon `h` (1 or 6) in one transaction. */
  calibFill(h, rows) { if (rows.length) this.transaction(() => { const q = h === 6 ? this.q.calibFill6 : this.q.calibFill1; for (const r of rows) q.run(r.buyers ?? null, r.priceUsd ?? null, r.cov ?? null, r.key, r.t); }); }
  calibTrim(beforeT, limit) { return Number(this.q.calibTrim.run(beforeT, limit).changes); }
  /** Adds coin-day deltas (`[{ mint, day, high, low, close, closeT, buyers, buys, trades, volume }]`) in one transaction: high/low widen, the newest close wins, counts add up. */
  coinDaysAdd(rows) {
    if (!rows.length) return;
    this.transaction(() => { for (const r of rows) this.q.coinDayAdd.run({ mint: r.mint, day: r.day, high: r.high ?? null, low: r.low ?? null, close: r.close ?? null, closeT: r.closeT ?? null, buyers: r.buyers ?? 0, buys: r.buys ?? 0, trades: r.trades ?? 0, volume: r.volume ?? 0 }); });
  }
  /** A coin's day rows from `sinceDay` ('YYYY-MM-DD') on, oldest first. */
  coinDays(mint, sinceDay = "0000-00-00") { return this.q.coinDaysOf.all(mint, sinceDay).map((r) => ({ day: r.day, highUsd: r.high_usd, lowUsd: r.low_usd, closeUsd: r.close_usd, closeT: r.close_t, buyers: r.buyers, buys: r.buys, trades: r.trades, volumeUsd: r.volume_usd })); }
  /** Writes event bucket rows (`[{ id, t, buyers, preBuyers, newBuyers, preCoins, newCoins, siteBuyers, flags }]`) in one transaction. */
  eventBucketsPut(rows) {
    if (!rows.length) return;
    this.transaction(() => { for (const r of rows) this.q.eventBucketPut.run({ id: r.id, t: r.t, buyers: r.buyers, preBuyers: r.preBuyers, newBuyers: r.newBuyers, preCoins: r.preCoins, newCoins: r.newCoins, siteBuyers: r.siteBuyers, flags: r.flags ?? 0 }); });
  }

  /** Folds the WAL into the main file so a shutdown (or a file-level copy) leaves one complete file. */
  checkpoint() { try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* read-only or already closed */ } }
  /** One passive checkpoint on the main connection: `{ busy, log, done }` frames (busy: another connection was checkpointing; log -1) (lib/checkpointer.mjs, when the log has not started over for long). */
  checkpointPassive() { const r = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(); return { busy: !!r.busy, log: r.log, done: r.checkpointed }; }
  /** The main connection's automatic checkpoint, in log pages (0: off; lib/checkpointer.mjs runs it in a worker). */
  autoCheckpoint(pages) { this.db.exec(`PRAGMA wal_autocheckpoint = ${Math.max(0, Math.floor(pages))}`); }
  /** The size (bytes) the log file is cut back to when it starts over. */
  journalSizeLimit(bytes) { this.db.exec(`PRAGMA journal_size_limit = ${Math.max(-1, Math.floor(bytes))}`); }
  /** Consistent online copy to `file` (node:sqlite's backup API; safe while the server writes). */
  async backup(file) { return backup(this.db, file); }
  close() { this.checkpoint(); this.db.close(); }
}
