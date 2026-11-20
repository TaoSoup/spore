// Wake-ups (GET /api/discover, /api/discover/:mint, SSE `wake`): families whose EXISTING coins are suddenly being bought
// by many more wallets than usual. A backtest over Nov 8-19 2026 found that after a news post the buying lands within
// five minutes on a parent's older children (coins launched days before), not on new launches, and that most of the
// move is over by the time launch counts rise (the launch list this replaces fired 30 min after the move). So the
// signal is buyers of existing children per five minutes, the list is ordered by how recent a wake-up is, and a
// wake-up is pushed on the event stream the moment it starts. The body says what was measured ("buying 14x its
// normal"); it never says a coin will rise, and a linked post is what coincided, not the cause.
//
// The WAKE rule, judged on a TRAILING 5-minute window (t - 300, t] (unix s, block time): count the distinct wallets that
// bought (trade value >= $1) any existing child (launched before the window starts minus 30 min, createdAt < t - 2100,
// or with no known creation time). It fires when that count is >= 50, >= 3 distinct existing coins were bought in the
// window, and the count is >= 5x the parent's trailing mean per 5-minute bucket: over the clock-aligned buckets that
// ENDED at or before the window start, only those actually observed (the history starts at the first trade the
// wake-ups saw, any parent's), at most 288 (24 h), empty ones included. Nothing fires before 6 h (72 such buckets) of
// history: run over 27 h of real trades, a boot that compared the seed's first buckets with an empty ring listed the
// always-busiest family as "buying 1,273x its normal". Why trailing: the rule used to be judged only when a fixed
// bucket closed, so a burst that began mid-bucket waited for the bucket end (or straddled two buckets and fired in
// neither). A backtest over Nov 15-19 2026 that judged the same rule on a trailing window every 15 s caught 92 % of the
// bucket rule's alerts a median 105 s earlier (NVDAx Nov 17: 15:57:15 instead of 16:00, the post at 15:55:16), with
// about a quarter of its own alerts unmatched by the bucket rule; 1- and 2-minute windows were worse. Here the window is
// judged after every $1+ buy of a child (finer than the backtest's 15 s grid) and on the tick (every TICK_MS) for
// parents with a non-empty window, because a coin crossing the 30-minute line and the baseline moving on at a bucket edge
// change the answer without a trade. Finer means sooner (replayed through this class over the same days, its alerts
// came a median 7 s before the grid's) and also more: it catches a window that meets the rule for only a second or two
// between two grid points. Over Nov 15-19 that was 5 of its 115 alerts (about 4 %, 1.4 a day), each at the threshold
// (ratio 5.00-5.04, or exactly 50 buyers), and one of them moved that family's next alert out through the 3 h gap; 110
// of the grid's 123 alerts were matched. Kept: each is a window that met the rule, and making it hold until the next
// tick would match the grid only by delaying every alert.
//
// A busy launch does not become "existing" at 30 minutes. A coin's buyers are ignored for its first 30 minutes, then
// all counted at once, so a launch that was already heavily bought made its family jump to "Nx its normal" the second
// it turned 30 minutes old although nothing had changed: 22 of 117 wake-ups (Nov 15-19 2026) fired within 2 minutes of
// such a crossing, the family's buyers were flat against 10 minutes earlier (median 1.10x; 6.66x for the others), and
// the lead coin was down 30 %+ an hour later in 76 % of them (50 % for the others). So a coin with HELD_BUYERS or more
// distinct $1+ buyers in its minutes 15-30 (age over HELD_FROM_S, up to the 30-minute line) counts as existing only
// from HELD_UNTIL_S (2 h) of age, in the window and in the buckets alike; it is still listed on cards and in trending.
// The buyers are counted as they come, per coin, in a set that stops at 20 (the flag is then set and kept until the coin
// is 2 h old) and is dropped at the coin's first buy past the line. The flag used to be decided at that first buy from
// the parent's last 15 minutes of buckets: when the buy came a few minutes late the busy minutes had left that view
// (927 coins flagged where this measure has 1,044; one start in 3.7 days counted such a coin). The cost, stated: a real
// burst on a coin 30 min to 2 h old that was already busy starts no wake-up (about 3 cases in 3.7 days, alerts 16 to
// 131 minutes later), 6 of 106 starts in the replay still came within 2 minutes of a 30-minute crossing, and the step can reappear at the 2 h line.
// Coins with no known creation time count as existing at once and pass both lines (not covered here). The 30-minute
// line itself is not free either: 43 of 120 wake-ups had 10+ minutes of buying before them that it hid; without it the
// rule gave 2.4x the wake-ups at a third of the hit rate, and at 2 h it lost 45 of 120 and delayed 15 by a median of
// 33 minutes. The 50-buyer floor was re-tested too (20 / 30 / 40: 67 / 34 / 11 extra alerts that never reached 50
// within 3 h, 1 family each with a coin holding 1.5x; the head start at 20 is a median 0 s, p90 23 minutes), and so
// was the order (newest first, by ratio and by buyers were within noise). Left as they are.
//
// A firing window keeps the parent's wake-up going (hotAt = the fire time). A parent without one starts one at the fire
// time, with an alert only when its last alert is 3 h or more behind (else it is listed again, silently). Its first
// coins "since start" are the children bought in the firing window.
//
// Always-busy families start silently. For a parent with a baseline of BUSY_BASE (10) or more buyers per bucket the
// 24 h mean includes its quiet hours, so 5x the mean is reached several times a day (35 of 115 alerts came from 9 such
// families, firing at a median 0.62x of their own busiest bucket of the day). Such a start alerts only when its
// existing-buyer count is at least HIGH_SHARE (0.8) of the parent's highest existing-buyer bucket of the last 24 h
// (`high24`, read from the baseline ring at the fire, the window's own bucket left out). Otherwise the wake-up is
// listed with `silent: true` and the 3 h lock is NOT used; the alert is sent later, once, the first time a firing
// window or a closed bucket of that wake-up reaches the same mark (in the replay 6 of 28 silenced starts went on to
// the day's high within 2-16 minutes). This is noise control, not a quality filter: the busy alerts it keeps did no
// better than the ones it holds back. The replay measured the gate at 1.0x the high (87 + 6 alerts instead of 115);
// 0.8x softens the cliff and was not re-measured. SOL is no parent here (its children are every root
// coin). The clock-aligned 5-minute buckets stay for everything else: the baseline ring, the spark, the ratio shown, and
// the live/cooling/drop rules; a closing bucket no longer starts a wake-up, but one that meets the rule (or 3x, below)
// still counts as hot.
//
// A wake-up is "live" while its latest complete bucket is >= 3x the CURRENT trailing mean (or it fired since that bucket
// ended); then "cooling". It is dropped 1 h after it was last hot or 6 h after its start, whichever comes first. Judged
// against the mean frozen at the start, a family that grew stayed "live" for a day. Live used to end 2 h after the
// start and the drop came 2 h after the last hot bucket: replayed over Nov 15-19 2026 the page then showed 3.89 cooling
// cards per view (0.35 of them at 3x or more, like a family at 21x labelled cooling for its age) and 47 % of a card's
// listed time came after its last hot bucket. With these two changes: 1.99 cooling cards, none at 3x+, live cards 1.09
// to 1.40. The cost: the page is empty 4.6 % of the time (1.1 % before), about one more alert a day, and a family that
// leaves and comes back is listed again silently. A floor of 15 buyers on "hot" was tested and left out: it took the
// label from the quiet families whose wake-ups did best.
//
// What a family body says is measured on one basis. The headline (`ratio`, `buyersEx5m`, `buyers5m`, `coinsTrading`,
// `baseline`) is read from the trailing window at build time, as the rule reads it, so it moves with the coin rows
// under it (frozen per closed bucket it was off by 2x or more in a fifth of 10 s samples). The chart line `sparkEx` is
// existing-child buyers per closed bucket, the same population as the baseline band and the ratio (`spark`, every
// child's buyers, is kept: new launches piling into a family are worth seeing, but drawn against the band they read as
// a multiple the ratio never said). `coins5` and `topShare` say how many coins carry the buying, per build, from the
// same 5-minute buyers the rows show: the 3-coin condition is nominal (in 75 of 113 wake-ups one coin had 70 %+ of
// the buyers), and a label frozen at the start was wrong on a quarter of cards 15 minutes later. They describe; a
// family-wide wake-up is not ranked above a one-coin one. `bought5mUsd` / `sold5mUsd` are the dollars bought and sold
// on the existing children in the trailing 5 minutes: the median firing window has 80 cents sold per dollar bought.
// A fact per build, not a gate and not a tag: silencing on it was tested and had no dose-response.
//
// The post a body shows: among the posts 2+ of its coins link, first one made between POST_BEFORE_S before the start
// and POST_AFTER_S after it (most links, then newest); at the start 83 % of shown posts were such a post, but by 2 h
// later copies' posts and old posts with more links had displaced two thirds of them. Otherwise the vote as before
// (most links, then newest), where a post made more than POST_OLD_S before the start (or with no readable time)
// qualifies only when POST_NEW_COINS or more of the coins linking it were launched since the start minus 30 min: old
// coins sharing a years-old post is not what coincided, an old post that new coins are copying may be. No post
// qualifies: `post` is null.
//
// Cost (the server has a history of event-loop freezes): record() is O(1) amortized per trade. The buckets: a few
// Map/Set operations on the trade's parent, no scan, allocations only for a coin's first trade in a bucket (its stats)
// and a parent's first trade ever (its rings). A parent's bucket closes on its next trade in a later bucket or on the
// tick (over the parents with an open bucket only); closing it is O(1) amortized (the ring is zero-filled lazily, at most
// 289 slots). The trailing window: per parent a time-ordered queue of its $1+ buys of the last 300 s with per-wallet and
// per-coin counts; a buy is pushed once and expired once from the head, and the rule then reads the counts and the ring
// (the mean before the window is the running 288-bucket sum, less the bucket the window starts in, plus the one that
// left: O(1)). A buy of a child 30-35 min old waits in its coin's pending list and is counted once when the coin crosses
// the line (a walk over the seconds since the parent's last judgement, at most 300, only while such a coin is pending).
// Starting a wake-up copies the window's coin counts once, reads the 289-slot ring once for the 24 h high, and, when it
// alerts, walks the window's buys once for the event's breadth (at most ROLL_MAX); it also notes, with nothing counted,
// the coins of the two buckets the window overlaps (O(coins traded in them), once). The busy-launch count is one Set
// add per $1+ buy of a coin 15-30 minutes old, until its set holds 20. The seed's tick costs O(near) per 2 s of seed time (a
// synthetic 2M-row day: 675 ms of seed with it, 682 without). The bodies are built on request in slices (lib/sliced.mjs),
// once per coin-row snapshot and served while that snapshot is current (at most WAKE_TTL_MS).
//
// Memory bound: distinct wallets are exact Sets/Maps keyed by the trades' own `user` strings (no copies): per parent one
// Map for its open bucket (cleared on close), per coin one Set per bucket kept for the last QUIET_BUCKETS closed buckets
// (the 15-minute "moving now" view) and dropped after. So the wallet entries held are at most the $1+ buys of the open
// bucket plus the 3 before it, twice (parent and coin), and each Set stops at SET_MAX entries (counts saturate there;
// health `capped` says when). Each parent with a trade in the last 24 h holds 2 x 289 + 6 x 24 bytes of rings. The
// trailing window holds one small object per $1+ buy of the last 300 s (plus one per wallet and per coin in it), at most
// ROLL_MAX per parent: past that the oldest buy leaves early (the window is then shorter than 300 s for that parent, which
// can only lower its counts; health `rollCapped` counts them). The busy-launch count: one Set of under 20 wallets per
// coin bought ($1+) at 15-30 minutes of age, let go at 20, at its first buy past 30 minutes or by the 10-minute prune,
// at most HELD_MAX coins; the flags: one number per busy launch until it is 2 h 5 min old, at most HELD_MAX. A buy that leaves is let go at once: its slot in the queue
// is nulled (fewer than max(64, held) + 1 8-byte null slots wait per parent until the head is dropped), and a pending
// coin's list is cut once under half of it is still pending (at most twice its buys in the window). A parent whose window
// emptied holds none of it. While seeding, `near` holds the parents whose window may meet the rule without a buy.
//
// Live trades only (model.recordTrade): rows read back from the chain (model.storeFilled) are old and must not start
// a wake-up. The boot seed (model.load) feeds the last 24 h of stored trades through the same path, the trailing window
// included, with events off, so the baselines and the 3 h rule hold across a restart and a wake-up found in history is
// listed without an alert. The seed also runs the tick's window part every 2 s of the rows' block time (over the parents
// whose window may fire without a buy, and on up to now): a wake-up the live process started on the tick, with no buy
// after it, is found again (else its family alerted a second time inside the 3 h after a restart).
// A gap in the stored trades (the server was down) reads as quiet buckets and lowers a baseline until it rolls out.
//
// The creator's 10-minute buy/sell flow (the "sold" fact) is recorded from the same trades while a coin is under
// 10 min old (O(1): one Map entry per young coin that traded, at most LAUNCH_MAX, its launcher's base amounts summed) and written to sqlite
// (`launch_flow`) once the window closed, because the per-mint trim of `trades` deletes a busy coin's launch rows
// within a day. Without a record, the stored rows decide only when they still reach back to the launch; otherwise
// the fact is unknown (asked again later, counted in health `factsUnknown`) and the coin is not left out.
// The same launch window records the sniper share (a Discover row's `safety.sniperPct`): base units bought by wallets
// other than the launcher in the creation slot or the first SNIPE_S seconds, also O(1) per trade, written with it.
//
// The coins a body lists are lib/coinrows.mjs rows over the asked timeframe (?tf=), read from one shared snapshot of
// the last hour's trades: a family lists only coins somebody bought ($1+) in the trailing 5 minutes and none under
// $1,000 of market cap (dust), so a cooling family's old coins drop out instead of filling the page.
import { SOL_MINT } from "./jupiter.mjs";
import { imageProxyUrl } from "./meta.mjs";
import { postOf, postTime, postUrl } from "./narrative.mjs";
import { runSliced } from "./sliced.mjs";
import { performance } from "node:perf_hooks";
import { TF_DEFAULT, SNAP_TTL_MS, isDust } from "./coinrows.mjs";
import { MIN_USD, EXISTING_S, r1, r2, byMint } from "./rowshared.mjs";

/** Bucket width (s), buckets in the 24 h baseline, buckets in the 2 h spark. */
export const BUCKET_S = 300, BASE_BUCKETS = 288, SPARK_BUCKETS = 24;
/** The WAKE rule: existing-child buyers, distinct existing coins, times the baseline; the quiet gap before a new wake-up (s); a child is existing when launched this long before the window (s); a buy counts from this value (USD). */
export const WAKE_BUYERS = 50, WAKE_COINS = 3, WAKE_RATIO = 5, REFIRE_S = 3 * 3600;
export { EXISTING_S, MIN_USD };
/** A launch with this many distinct $1+ buyers between HELD_FROM_S of age (s) and the 30-minute line is existing only from HELD_UNTIL_S of age (s); flags, and coins being counted, kept at most. */
export const HELD_BUYERS = 20, HELD_FROM_S = 900, HELD_UNTIL_S = 2 * 3600, HELD_MAX = 20_000;
/** A parent with this baseline (buyers per bucket) or more alerts only when the firing count is this share of its highest existing-buyer bucket of the last 24 h; else it starts silently and alerts once it gets there. */
export const BUSY_BASE = 10, HIGH_SHARE = 0.8;
/** `coins5` counts coins with this many distinct buyers in the trailing 5 minutes. */
export const BREADTH_BUYERS = 5;
/** The post shown: first one made at most POST_BEFORE_S before the start or POST_AFTER_S after it; one made more than POST_OLD_S before it needs POST_NEW_COINS coins launched since linking it. */
export const POST_BEFORE_S = 3600, POST_AFTER_S = 300, POST_OLD_S = 6 * 3600, POST_NEW_COINS = 2;
/** Buckets of history (observed, ended at or before the window start) the rule needs before it may fire: 6 h. */
export const MIN_SEEN = 72;
/** "live" while the latest complete bucket is this many times the current baseline (or a window fired since); dropped DROP_S after it was last hot (such a bucket, or a firing window) or WAKE_MAX_S after its start, whichever comes first. */
export const LIVE_RATIO = 3, DROP_S = 3600, WAKE_MAX_S = 6 * 3600;
/** A baseline under this many buyers per bucket reads as this many in a ratio (a family nobody bought yesterday would read thousands of times its normal). */
export const BASE_FLOOR = 1;
/** Families listed, coins per family, coins in a quiet answer and the buckets they are ranked over (15 min). */
export const LIST_MAX = 12, COINS_MAX = 6, QUIET_COINS = 3, QUIET_BUCKETS = 3;
/** A body is served as long as the coin-row snapshot it was built from is current: one cache level, never older than this. */
export const WAKE_TTL_MS = SNAP_TTL_MS;
/** Distinct wallets one parent or coin bucket holds at most. */
export const SET_MAX = 20_000;
/** The trailing window the rule is judged on (s), and the $1+ buys one parent's window holds at most (past it the oldest leaves early). */
export const ROLL_S = 300, ROLL_MAX = 20_000;
/** A bucket that ended this recently is closed by the tick only after this grace (s): block times trail our clock by a few seconds. */
export const GRACE_S = 5;
/** The three creator facts that marked dead coins in the backtest: the creator sold >= DEAD_SOLD of its own buy within DEAD_SOLD_S of launch; launched DEAD_LAUNCHES+ coins in the DEAD_LAUNCH_S before; relaunched the same ticker under the same parent. */
export const DEAD_SOLD = 0.9, DEAD_SOLD_S = 600, DEAD_LAUNCHES = 10, DEAD_LAUNCH_S = 3600;
/** Creator facts kept (a coin's are final once it is DEAD_SOLD_S old; a younger one's are asked again after FACT_YOUNG_MS, an unknown one after FACT_UNKNOWN_MS); creator indexes kept. */
export const FACTS_MAX = 50_000, FACT_YOUNG_MS = 30_000, FACT_UNKNOWN_MS = 10 * 60_000, CREATORS_MAX = 2_000;
/** A launch window whose first trade was seen this soon (s) after creation is whole (the dev buy is in the create transaction); launch windows held at most. */
export const LAUNCH_SEEN_S = 30, LAUNCH_MAX = 20_000;
/** The sniper window: buys by others up to this many seconds after creation (or in the creation slot). */
export const SNIPE_S = 3;
/** Family coins looked at per build, at most (most buyers first): each is a row with prices, and dust is left out. */
export const FAMILY_SCAN = 64;
/** Children one quiet answer looks at, at most (ranked by buyers). */
export const QUIET_SCAN = 256;
const TICK_MS = 2_000, WAKES_MAX = 50, QUIET_CACHE = 500, PRUNE_EVERY_S = 600;
const U16 = 0xffff;
/** The baseline ring keeps one bucket more than the 288 it sums, so the mean before a window that starts inside the newest closed bucket is still O(1). */
const RING = BASE_BUCKETS + 1;

const normSym = (s) => (typeof s === "string" ? s.trim().toLowerCase() : "");

function parentState(mint) {
  return {
    mint,
    // the open bucket: its number (-1 when none), wallet → bits (1: bought a child, 2: bought an existing child), counts, coins
    k: -1, buyers: new Map(), exN: 0, allN: 0, trades: 0, exCoins: new Set(), coins: new Map(), // coins: mint → { buyers: Set, trades, usd }
    // closed buckets: existing-child buyers by k % RING (holds the buckets up to `upTo`; exSum sums the newest 288), all-child buyers of the last 24 with their numbers
    ex: new Uint16Array(RING), exSum: 0, upTo: -1, spark: new Uint16Array(SPARK_BUCKETS), sparkK: new Int32Array(SPARK_BUCKETS).fill(-1),
    lastK: -1, lastEx: 0, lastAll: 0, lastTrades: 0,
    hist: [], // the coin maps of the last QUIET_BUCKETS closed buckets, newest first: { k, coins }
    lastBase: 0, // the trailing mean the last closed bucket was judged against
    lastAlert: -Infinity, wake: null, // when the last alert was sent (or would have been, in the seed): a wake-up's start, or a silent one's catch-up
    rt: -Infinity, roll: null, // the trailing window's clock (never goes back: a late print counts as of it) and its state (null when empty)
  };
}

/**
 * A parent's trailing window: `a` its $1+ buys in time order from `h` on, `{ t, u, m, usd, st }` (st 2: counted as a
 * buy of an existing child, 1: of a child 30-35 min old, counted once it crosses the line, 0: of a new child, -1:
 * left); `w` wallet → { all, ex } entries, `c` coin → { n, ex, usd }, with the number of wallets and coins with an
 * existing entry (exN, exC) and of wallets with any (allN); `pend` coin → its pending entries, `pendAt` the second
 * from which a pending coin counts → those coins, `promoT` the second the window was last moved to.
 */
function rollState(t) {
  return { a: [], h: 0, w: new Map(), c: new Map(), exN: 0, exC: 0, allN: 0, pend: new Map(), pendAt: new Map(), promoT: t };
}

export class Wakeups {
  /** `model`: the index (read only); `hub`: the SSE hub `wake` events go to; `narrative`: lib/narrative.mjs for post texts and copies (optional); `now` in ms. */
  constructor({ model, hub = null, narrative = null, now = Date.now, log = console } = {}) {
    this.model = model; this.hub = hub; this.narrative = narrative; this.now = now; this.log = log;
    this.parents = new Map(); // parent mint → state
    this.open = new Set();    // parents with an open bucket
    this.waking = new Set();  // parents with a wake-up listed (live or cooling)
    this.holding = new Set(); // parents whose `hist` holds coin buckets (the tick trims them to the 15-minute view)
    this.rolling = new Set(); // parents with a non-empty trailing window (the tick expires and judges them)
    // While seeding only: parents whose window may meet the rule without a buy (a pending coin, or 50 buyers over 3 coins
    // held back by the ratio, the history or an open bucket), and the block time the seed's own tick last ran at.
    this.near = new Set(); this.seedT = -Infinity;
    this.seeding = false; this.prunedAt = 0;
    this.held = new Map();    // busy launch mint → the creation time the existing tests use for it (its own + HELD_UNTIL_S - EXISTING_S), until it is 2 h 5 min old
    this.early = new Map();   // coin mint → { at: its creation time, u: Set of its $1+ buyers in its minutes 15-30 }, while under HELD_BUYERS
    this.firstK = null;       // the bucket of the first trade seen (any coin): where the observed history starts
    this.launch = new Map();  // coin mint → { at, first, key, bought, sold }: launch windows still open, about in creation order
    this.facts = new Map();   // coin mint → { why, unknown, until (ms) }, oldest first
    this.creatorIdx = new Map(); // creator key → { size, times, firsts }, oldest first
    this.snipes = new Map();  // coin mint → { pct, until (ms) }: sniper shares, oldest first
    this.hits = new Map(); this.jobs = new Map(); // per timeframe: the last list build ({ at, snap, built: every family it built by parent, body }), the build under way
    this.quiet = new Map(); this.quietJobs = new Map(); // keyed tf + newline + mint
    this.listed = new Set(); this.listedAt = null; // the parents the list shows (at most LIST_MAX), as of second listedAt: familyState
    this.timer = null;
    this.stats = { trades: 0, seedRows: 0, seedMs: null, closes: 0, started: 0, seededWakes: 0, events: 0, capped: 0, builds: 0, lastBuildMs: null, maxSliceMs: 0, served: 0, quietBuilt: 0, factQueries: 0, factsUnknown: 0, launchSaved: 0, launchSkipped: 0, launchDropped: 0, relisted: 0, rollCapped: 0, live: 0, cooling: 0,
      // heldBack: launches flagged busy (20 buyers in their minutes 15-30); startedYoung: alerts whose most-bought EXISTING
      // coin (the coins the rule counted, not a launch bought beside them) was under 2 h old (36 % before the flag, 14 %
      // expected; counted over every coin it read 44 %); silenced / caughtUp: starts the always-busy gate held back, and those that
      // alerted later (lastCatchUpS: how long after the start); lastQuietMs / quietMaxSliceMs: a quiet answer's CPU and
      // longest slice; lastWaitMs: what the last uncached list request waited for, wall clock ({ snap, groups, build, total }).
      heldBack: 0, startedYoung: 0, silenced: 0, caughtUp: 0, lastCatchUpS: null, lastQuietMs: null, quietMaxSliceMs: 0, lastWaitMs: null };
  }
  attach({ hub, narrative } = {}) { if (hub !== undefined) this.hub = hub; if (narrative !== undefined) this.narrative = narrative; return this; }
  /** Closes due buckets and expires and judges the trailing windows every TICK_MS. */
  start() { if (!this.timer) { this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.log.warn?.(`wakeups: ${e?.message ?? e}`); } }, TICK_MS); this.timer.unref?.(); } return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
  snapshot() {
    let held = 0, buys = 0;
    for (const P of this.open) held += P.buyers.size;
    for (const P of this.rolling) buys += P.roll.a.length - P.roll.h;
    return { parents: this.parents.size, open: this.open.size, waking: this.waking.size, walletsOpen: held, rolling: this.rolling.size, rollHeld: buys, heldFlags: this.held.size, heldCounting: this.early.size, facts: this.facts.size, launching: this.launch.size, seenBuckets: this.firstK == null ? 0 : Math.max(0, Math.floor(this.#nowS() / BUCKET_S) - this.firstK), ...this.stats };
  }

  #nowS() { return Math.floor(this.now() / 1000); }
  /** The latest bucket every parent has closed by now (the grace applied). */
  #complete(nowS) { return Math.floor((nowS - GRACE_S) / BUCKET_S) - 1; }

  // ---------------------------------------------------------------- the feed
  /**
   * The boot seed: stored trades in time order, through record() with no event published. Between rows the seed runs the
   * tick's trailing-window part on the rows' clock (#seedTo): a wake-up the live process started on the tick (a child
   * crossing the 30-minute line, the baseline moving on at a bucket edge, no buy after) is found again, so its alert
   * still holds the 3 h gap after a restart. It steps on past the last row up to now (as the live tick would, as of 5 s
   * ago): the newest row only says the process was up until then, and a restart is mostly short. After a long outage
   * this may list (silently) a wake-up whose tick the process missed; that errs towards no second alert.
   */
  beginSeed() { this.seeding = true; this.seedT = -Infinity; this.near.clear(); this.seedT0 = performance.now(); }
  endSeed() { this.#seedTo(this.#nowS() - GRACE_S + 1); this.near.clear(); this.tick(); this.seeding = false; this.stats.seedMs = Math.round(performance.now() - this.seedT0); }

  /**
   * The seed's tick, every TICK_MS of block time before `time` (a row's): only over `near`, because a window's counts
   * fall without a buy and so cannot meet the rule unless it has a pending coin or 50 buyers over 3 coins already (the
   * rest are expired at their next buy or by the end tick, as live). O(near) per 2 s of seed time, and none while no
   * parent is near: the steps of a gap in the rows run only while a window that may fire is still open (300 s at most).
   */
  #seedTo(time) {
    const step = TICK_MS / 1000;
    if (!this.near.size) { this.seedT = time; return; }
    for (let s = this.seedT + step; s < time && this.near.size; s += step) {
      this.seedT = s;
      const cur = Math.floor(s / BUCKET_S);
      for (const P of this.near) {
        // the live tick closes an ended bucket before it judges (rows come in time order: no late print to wait for)
        if (P.k >= 0 && P.k < cur) this.#close(P);
        this.#rollAt(P, s);
      }
    }
    if (!this.near.size) this.seedT = time;
  }

  /**
   * Counts one trade `{ mint, time, isBuy, valueUsd, user }` of a tracked child, and judges the parent's trailing window
   * after a $1+ buy. O(1) amortized: see the head of the file. A trade older than its parent's open bucket (a late print)
   * counts in the open one; one older than the last closed bucket counts in the bucket after it; in the trailing window
   * it counts as of the window's clock.
   */
  record(t) {
    const time = Math.floor(Number(t?.time));
    if (!Number.isFinite(time)) return;
    let k = Math.floor(time / BUCKET_S);
    // The observed history starts at the first trade of any coin: a bucket before it was not watched, not quiet.
    if (this.firstK == null) this.firstK = k;
    if (this.seeding && time > this.seedT) this.#seedTo(time);
    const c = this.model.coins.get(t.mint);
    if (!c || !c.tracked) return;
    // Every tracked coin's launch window, a SOL root's too: /api/trending lists roots, with their creator facts and sniper share.
    if (c.createdAt != null && time >= c.createdAt && time < c.createdAt + DEAD_SOLD_S) this.#launchTrade(c, t, time);
    const p = c.quoteMint;
    if (!p || p === SOL_MINT) return;
    if (this.seeding) this.stats.seedRows++; else this.stats.trades++;
    let P = this.parents.get(p);
    if (!P) this.parents.set(p, P = parentState(p));
    if (P.k >= 0) { if (k > P.k) this.#close(P); else k = P.k; }
    if (P.k < 0) { if (k <= P.lastK) k = P.lastK + 1; P.k = k; this.open.add(P); }
    const x = typeof t.valueUsd === "number" && Number.isFinite(t.valueUsd) ? t.valueUsd : 0;
    P.trades++;
    let s = P.coins.get(c.mint);
    if (!s) P.coins.set(c.mint, s = { buyers: new Set(), trades: 0, usd: 0 });
    s.trades++; s.usd += x;
    const buy = t.isBuy && x >= MIN_USD && typeof t.user === "string";
    let born = null;
    if (buy) {
      if (c.createdAt != null && time > c.createdAt + HELD_FROM_S && time <= c.createdAt + EXISTING_S) this.#early(c, t.user);
      born = this.#born(c, time > P.rt ? time : P.rt);
      const existing = born == null || born < k * BUCKET_S - EXISTING_S;
      const had = P.buyers.get(t.user) ?? 0, bits = had | 1 | (existing ? 2 : 0);
      if (bits !== had) {
        if (!had && P.buyers.size >= SET_MAX) this.stats.capped++;
        else { P.buyers.set(t.user, bits); if (!had) P.allN++; if (existing && !(had & 2)) P.exN++; }
      }
      if (existing) P.exCoins.add(c.mint);
      if (s.buyers.size < SET_MAX) s.buyers.add(t.user); else if (!s.buyers.has(t.user)) this.stats.capped++;
    }
    const w = P.wake;
    if (w) { let e = w.coins.get(c.mint); if (!e) w.coins.set(c.mint, e = { trades: 0, usd: 0 }); e.trades++; e.usd += x; }
    // After the wake-up's coins: a wake-up this buy starts takes its coins from the window, this buy included.
    if (buy) this.#roll(P, c, born, t.user, x, time);
  }

  /**
   * One $1+ buy of coin `c` in its minutes 15-30 (the trade's own time): its HELD_BUYERS-th distinct wallet there flags
   * it as a busy launch (the head of the file). O(1): one Set add; the set is let go at 20.
   */
  #early(c, user) {
    const H = this.held, E = this.early, m = c.mint;
    if (H.has(m)) return;
    let s = E.get(m);
    if (!s) { E.set(m, s = { at: c.createdAt, u: new Set() }); if (E.size > HELD_MAX) E.delete(E.keys().next().value); }
    s.u.add(user);
    if (s.u.size < HELD_BUYERS) return;
    E.delete(m);
    H.set(m, c.createdAt + HELD_UNTIL_S - EXISTING_S); this.stats.heldBack++;
    if (H.size > HELD_MAX) H.delete(H.keys().next().value);
  }

  /**
   * The creation time the existing tests use for coin `c` at second `t` (null: none known, existing at once). Its own,
   * except for a busy launch (#early), which reads as launched HELD_UNTIL_S - EXISTING_S later. O(1): a number compare
   * for a coin under 30 min or over 2 h 5 min old, one Map read between (and the coin's count of its minutes 15-30 is
   * let go: it stayed under 20).
   */
  #born(c, t) {
    const ca = c.createdAt;
    if (ca == null) return null;
    const age = t - ca;
    if (age <= EXISTING_S || age > HELD_UNTIL_S + ROLL_S) return ca;
    if (this.early.size) this.early.delete(c.mint);
    return this.held.get(c.mint) ?? ca;
  }

  // ---------------------------------------------------------------- the trailing window
  /** One $1+ buy into the parent's trailing window, then the rule. `ca`: the coin's creation time as the existing tests read it (#born). */
  #roll(P, c, ca, user, usd, time) {
    const t = time > P.rt ? time : P.rt;
    P.rt = t;
    let R = P.roll;
    if (!R) { P.roll = R = rollState(t); this.rolling.add(P); }
    else this.#advance(R, t);
    if (R.a.length - R.h >= ROLL_MAX) { const e = R.a[R.h]; R.a[R.h++] = null; this.#leave(R, e); this.stats.rollCapped++; }
    const m = c.mint;
    // existing: launched before the window start minus 30 min; pending: crosses that line before this buy leaves the window
    const st = ca == null || ca < t - ROLL_S - EXISTING_S ? 2 : ca < t - EXISTING_S ? 1 : 0;
    const e = { t, u: user, m, usd, st };
    R.a.push(e);
    let W = R.w.get(user);
    if (!W) { R.w.set(user, W = { all: 0, ex: 0 }); R.allN++; }
    W.all++;
    let C = R.c.get(m);
    if (!C) R.c.set(m, C = { n: 0, ex: 0, usd: 0 });
    C.n++; C.usd += usd;
    if (st === 2) this.#count(R, W, C);
    else if (st === 1) {
      let ps = R.pend.get(m);
      if (!ps) {
        R.pend.set(m, ps = { m, list: [], live: 0, dead: false });
        // the first second t' with ca < t' - 2100: in (promoT, promoT + ROLL_S] (this buy is at promoT, ca in [t - 2100, t - 1800))
        const at = Math.floor(ca) + ROLL_S + EXISTING_S + 1;
        let l = R.pendAt.get(at);
        if (!l) R.pendAt.set(at, l = []);
        l.push(ps);
      }
      ps.list.push(e); ps.live++;
    }
    this.#judge(P, R, t);
  }

  #count(R, W, C) { if (W.ex++ === 0) R.exN++; if (C.ex++ === 0) R.exC++; }

  /**
   * An entry leaves the window (expired, or the oldest past ROLL_MAX); the caller has already nulled its slot. A pending
   * coin's list is cut to its pending entries once fewer than half of it are (amortized O(1): each one left before), so
   * it holds at most twice its buys still in the window, not every buy of a heavily bought coin since it was first bought.
   */
  #leave(R, e) {
    const st = e.st, W = R.w.get(e.u), C = R.c.get(e.m);
    e.st = -1;
    if (st === 2) { if (--W.ex === 0) R.exN--; if (--C.ex === 0) R.exC--; }
    else if (st === 1) {
      const ps = R.pend.get(e.m);
      if (ps) {
        if (--ps.live === 0) { ps.dead = true; ps.list = []; R.pend.delete(e.m); }
        else if (ps.live * 2 < ps.list.length) ps.list = ps.list.filter((x) => x.st === 1);
      }
    }
    if (--W.all === 0) { R.w.delete(e.u); R.allN--; }
    if (--C.n === 0) R.c.delete(e.m); else C.usd -= e.usd;
  }

  /** Moves the window to end at `t`: expires the buys at or before t - ROLL_S from the head, then counts the pending coins that crossed the line. */
  #advance(R, t) {
    const a = R.a, cut = t - ROLL_S;
    // A slot is let go as its buy leaves (the entry and the wallet string it points to are then free), and the head of
    // nulls is dropped once it is most of the array and 64 or more: amortized O(1), and fewer than max(64, held) + 1
    // null slots per parent. (A head kept until 1 024 held every buy of a parent bought less often than that a day.)
    while (R.h < a.length && a[R.h].t <= cut) { const e = a[R.h]; a[R.h++] = null; this.#leave(R, e); }
    if (R.h === a.length) { R.a = []; R.h = 0; }
    else if (R.h >= 64 && R.h * 2 > a.length) { R.a = a.slice(R.h); R.h = 0; }
    if (!R.pend.size) { if (R.pendAt.size) R.pendAt.clear(); R.promoT = t; return; }
    // Every pending coin counts from a second in (promoT, promoT + ROLL_S]: a longer step lifts them all.
    if (t - R.promoT >= ROLL_S) { for (const ps of R.pend.values()) this.#lift(R, ps); R.pend.clear(); R.pendAt.clear(); }
    else for (let s = R.promoT + 1; s <= t; s++) {
      const l = R.pendAt.get(s);
      if (!l) continue;
      R.pendAt.delete(s);
      for (const ps of l) if (!ps.dead) { this.#lift(R, ps); R.pend.delete(ps.m); }
    }
    R.promoT = t;
  }

  /** A pending coin crossed the 30-minute line: its buys still in the window count as buys of an existing child. */
  #lift(R, ps) {
    const C = R.c.get(ps.m);
    for (const e of ps.list) if (e.st === 1) { e.st = 2; this.#count(R, R.w.get(e.u), C); }
    ps.dead = true; ps.list = [];
  }

  /**
   * The rule on the window (t - ROLL_S, t]. The mean is over the buckets that ended at or before its start: up to
   * bucket j - 1, where j = floor(t / BUCKET_S) - 1 is the bucket the window starts in. O(1): the ring sums the newest
   * 288 closed buckets; when those include bucket j, it is taken out and the one before the 288 put back.
   */
  #judge(P, R, t) {
    const may = R.exN >= WAKE_BUYERS && R.exC >= WAKE_COINS;
    if (this.seeding) { if (may || R.pend.size) this.near.add(P); else this.near.delete(P); }
    if (!may || this.firstK == null) return;
    const j = Math.floor(t / BUCKET_S) - 1;
    if (j - this.firstK < MIN_SEEN) return;
    // A bucket inside the baseline still open (a late print reopened one behind the window): the tick closes it and judges again.
    const base = this.#baseAt(P, j);
    if (base == null || R.exN < WAKE_RATIO * base) return;
    let w = P.wake;
    // A wake-up past its time (1 h after it was last hot, 6 h after its start) is over even when no tick dropped it yet.
    if (w && this.#over(w, t)) { P.wake = w = null; this.waking.delete(P); }
    if (w) {
      if (t > w.hotAt) w.hotAt = t;
      // A silent start that has now reached the mark it was held back for: its one alert, late.
      if (w.silent && R.exN >= HIGH_SHARE * w.high24) this.#catchUp(P, t, R.exN / Math.max(base, BASE_FLOOR), R.allN, () => this.#windowBreadth(R));
      return;
    }
    // Without one it starts one, which alerts only 3 h after the last alert: a family bursting every 2-3 h is listed
    // after each burst (it used to be swallowed while the 3 h lock moved on).
    const high24 = this.#high24(P, j);
    let alert = t - P.lastAlert >= REFIRE_S, silent = false;
    if (!alert) this.stats.relisted++;
    // An always-busy family under its own high of the day: listed, no alert, and the 3 h lock is left for the catch-up.
    else if (base >= BUSY_BASE && R.exN < HIGH_SHARE * high24) { alert = false; silent = true; this.stats.silenced++; }
    else P.lastAlert = t;
    this.#start(P, R, t, base, alert, silent, high24);
  }

  /**
   * The parent's mean existing-child buyers per bucket over the buckets that ended at or before the start of the window
   * whose first bucket is `j` (the observed ones, at most 288; 0 when none), or null while it cannot be read: a bucket
   * inside it is still open, or one past `j` has closed. O(1) amortized (the head of the file).
   */
  #baseAt(P, j) {
    if ((P.k >= 0 && P.k < j) || P.upTo > j) return null;
    if (P.upTo < j - 1) this.#fillTo(P, j - 1);
    const sum = P.upTo === j ? P.exSum - P.ex[j % RING] + P.ex[(j - BASE_BUCKETS) % RING] : P.exSum;
    const cover = Math.min(BASE_BUCKETS, j - this.firstK);
    return cover > 0 ? sum / cover : 0;
  }

  /** The parent's highest existing-buyer bucket of the last 24 h, bucket `j` (the one the window starts in) left out. 289 slots, read at a start only (after #baseAt filled the ring). */
  #high24(P, j) {
    const ex = P.ex, skip = P.upTo === j ? j % RING : -1;
    let hi = 0;
    for (let i = 0; i < RING; i++) if (i !== skip && ex[i] > hi) hi = ex[i];
    return hi;
  }

  /**
   * How many coins carry the buying: `per` yields [mint, distinct buyers]; `total` the distinct buyers over all of them.
   * Among equals the first one yielded is the top coin (a body yields in its list's order, so that is its first row).
   * `isEx` (an alert's): whether a coin counted as existing; `exTop` is then the most-bought of those, for health only.
   */
  #breadthOf(per, total, isEx = null) {
    let coins5 = 0, top = 0, topMint = null, exN = 0, exTop = null;
    for (const [m, n] of per) {
      if (n >= BREADTH_BUYERS) coins5++;
      if (n > top) { top = n; topMint = m; }
      if (n > exN && isEx?.(m)) { exN = n; exTop = m; }
    }
    return { coins5, topShare: top > 0 ? r2(Math.min(1, top / Math.max(total, top))) : null, topMint, exTop };
  }
  /**
   * The firing window's breadth: distinct buyers per coin from its buys (its per-coin counts are buys, not wallets), over
   * every coin bought in it, a launch too (as `buyers5m` and a body's breadth are). One walk, at most ROLL_MAX, only
   * when an event is sent.
   */
  #windowBreadth(R) {
    const per = new Map();
    for (let i = R.h; i < R.a.length; i++) { const e = R.a[i]; let s = per.get(e.m); if (!s) per.set(e.m, s = new Set()); s.add(e.u); }
    return this.#breadthOf((function* () { for (const [m, s] of per) yield [m, s.size]; })(), R.allN, (m) => R.c.get(m).ex > 0);
  }

  /** The `wake` event, as of second `at` (a wake-up's start, or a silent one's catch-up). */
  #emit(P, at, ratio, buyers5m, breadth) {
    const w = P.wake;
    this.stats.started++;
    const b = breadth();
    // On the coins the rule fired on: the event's own top coin may be a launch under 30 minutes old the rule ignores.
    const top = b.exTop ? this.model.coins.get(b.exTop) : null;
    if (top?.createdAt != null && at - top.createdAt < HELD_UNTIL_S) this.stats.startedYoung++;
    if (!this.hub) return;
    const { name, symbol } = this.model.nameOf(P.mint);
    try {
      this.hub.emit("wake", { parent: { mint: P.mint, symbol, name }, startedAt: w.startedAt, alertedAt: at, ratio: r1(ratio), buyers5m, coins5: b.coins5, topShare: b.topShare, topSymbol: b.topMint ? this.model.nameOf(b.topMint).symbol ?? null : null, high24: w.high24 });
      this.stats.events++;
    } catch (e) { this.log.warn?.(`wakeups: event: ${e?.message ?? e}`); }
  }

  /** A silent wake-up reached the mark: the alert it did not send at its start, and the 3 h lock from now. */
  #catchUp(P, at, ratio, buyers5m, breadth) {
    const w = P.wake;
    w.silent = false; P.lastAlert = at;
    if (this.seeding) { this.stats.seededWakes++; return; }
    this.stats.caughtUp++; this.stats.lastCatchUpS = at - w.startedAt;
    this.#emit(P, at, ratio, buyers5m, breadth);
  }

  /** The tick's part for one parent with a window: moves it to `tr` (never back) and judges it; an emptied one is let go. */
  #rollAt(P, tr) {
    const R = P.roll, t = tr > P.rt ? tr : P.rt;
    P.rt = t;
    this.#advance(R, t);
    if (R.h === R.a.length) { P.roll = null; this.rolling.delete(P); this.near.delete(P); return; }
    this.#judge(P, R, t);
  }

  /** A trade inside a coin's first DEAD_SOLD_S: its launcher's base amount is summed (O(1)). */
  #launchTrade(c, t, time) {
    let e = this.launch.get(c.mint);
    if (!e) {
      const key = this.model.creatorKey(c);
      if (!key) return; // nobody to attribute the trades to: the stored rows decide later, while they last
      this.launch.set(c.mint, e = { at: c.createdAt, first: time, key, bought: 0, sold: 0, snipe: 0, slot: c.createdSlot ?? null });
      if (this.launch.size > LAUNCH_MAX) { this.launch.delete(this.launch.keys().next().value); this.stats.launchDropped++; }
    }
    const a = Number(t.baseAmount);
    if (!(a > 0)) return;
    if (t.user === e.key) { if (t.isBuy) e.bought += a; else e.sold += a; return; }
    // Anyone else buying in the creation slot or its first seconds: the sniper share (a bot's buy lands in the launch block).
    if (t.isBuy && (time <= e.at + SNIPE_S || (e.slot != null && Number(t.slot) === e.slot))) e.snipe += a;
  }

  /**
   * Writes the launch windows that closed (GRACE_S ago) to sqlite. Only one seen from the launch on: a window first seen
   * later (the boot seed's 24 h cutting through it, a restart) may lack the dev buy, and a partial buy against later
   * sales would read "sold".
   */
  #saveLaunches(nowS) {
    const due = [];
    for (const [m, e] of this.launch) {
      if (nowS - GRACE_S < e.at + DEAD_SOLD_S) break; // opened about in creation order: the rest closes later (one out of order waits)
      this.launch.delete(m);
      if (e.first > e.at + LAUNCH_SEEN_S) { this.stats.launchSkipped++; continue; }
      due.push([m, e]);
    }
    if (!due.length) return;
    const db = this.model.db;
    const put = () => { for (const [m, e] of due) if (db.launchFlowPut(m, e.bought, e.sold, e.at, e.snipe)) this.stats.launchSaved++; };
    try { if (due.length > 1 && !db.db?.isTransaction) db.transaction(put); else put(); }
    catch (e) { this.log.warn?.(`wakeups: launch flows: ${e?.message ?? e}`); }
  }

  /** Writes zeros for the buckets after `upTo` up to `k` (the buckets the parent had no trade in); each one's bucket 288 back leaves the sum. */
  #fillTo(P, k) {
    if (P.upTo < 0 || k - P.upTo >= RING) { if (P.upTo >= 0) { P.ex.fill(0); P.exSum = 0; } P.upTo = k; return; }
    for (let j = P.upTo + 1; j <= k; j++) { P.exSum -= P.ex[(j - BASE_BUCKETS) % RING]; P.ex[j % RING] = 0; }
    if (k > P.upTo) P.upTo = k;
  }

  /** Closes the parent's open bucket: the rings, the wake-up's numbers, whether it was hot (it starts no wake-up: the trailing window does). */
  #close(P) {
    const k = P.k, T = (k + 1) * BUCKET_S;
    this.stats.closes++;
    this.#fillTo(P, k - 1);
    // The mean over the buckets observed before this one (a parent's buckets before its first trade are zeros in its ring).
    const seen = this.firstK == null ? 0 : k - this.firstK, cover = Math.min(BASE_BUCKETS, seen);
    const base = cover > 0 ? P.exSum / cover : 0, exN = P.exN, allN = P.allN;
    const v = Math.min(exN, U16);
    P.exSum += v - P.ex[(k - BASE_BUCKETS) % RING]; P.ex[k % RING] = v; P.upTo = k;
    P.spark[k % SPARK_BUCKETS] = Math.min(allN, U16); P.sparkK[k % SPARK_BUCKETS] = k;
    P.lastK = k; P.lastEx = exN; P.lastAll = allN; P.lastTrades = P.trades; P.lastBase = base;
    P.hist.unshift({ k, coins: P.coins });
    if (P.hist.length > QUIET_BUCKETS) P.hist.length = QUIET_BUCKETS;
    this.holding.add(P);
    // A wake-up past its time (1 h after its last hot bucket, 6 h after its start) is over even when no tick dropped it yet.
    if (P.wake && this.#over(P.wake, k * BUCKET_S)) { P.wake = null; this.waking.delete(P); }
    const w = P.wake;
    if (w) {
      const b = Math.max(base, BASE_FLOOR), ratio = exN / b;
      w.ratio = ratio; if (ratio > w.peak) w.peak = ratio;
      // A bucket that meets the WAKE rule or is 3x keeps it hot (never back past a later firing window).
      const fires = seen >= MIN_SEEN && exN >= WAKE_BUYERS && P.exCoins.size >= WAKE_COINS && exN >= WAKE_RATIO * base;
      if ((fires || exN >= LIVE_RATIO * b) && T > w.hotAt) w.hotAt = T;
      // A silent start whose bucket reached the mark (its windows may each have stayed under it).
      if (w.silent && exN >= HIGH_SHARE * w.high24) {
        const coins = P.coins, exCoins = P.exCoins;
        this.#catchUp(P, T, ratio, allN, () => this.#breadthOf((function* () { for (const [m, s] of coins) yield [m, s.buyers.size]; })(), allN, (m) => exCoins.has(m)));
      }
    }
    P.k = -1; P.buyers.clear(); P.exN = 0; P.allN = 0; P.trades = 0; P.exCoins.clear(); P.coins = new Map();
    this.open.delete(P);
  }

  /** Whether a wake-up is over at unix s `s`: 1 h after it was last hot or 6 h after its start. */
  #over(w, s) { return s - w.hotAt >= DROP_S || s - w.startedAt >= WAKE_MAX_S; }
  /** Live: hot in the latest complete bucket `L` or since it ended, however long ago it started (a family at 21x was labelled cooling because it was 2 h 24 min old). */
  #live(w, L) { return w.hotAt >= (L + 1) * BUCKET_S; }

  /**
   * A wake-up starts at T (the fire time); the children bought ($1+) in the firing window are its first "since start"
   * (O(coins in it), once). The other coins traded in the two buckets the window overlaps (only sold, or bought for
   * under $1) are noted with nothing counted: a body sums its dollars over the wake-up's coins, and without them the
   * dollars sold in its first 5 minutes left out a coin sold just before the start until it traded again (up to 42 % of
   * the firing window's sold dollars; the card read "more bought than sold" in 2 of 107 starts where the reverse was
   * true). `alert`: send `wake`; `silent`: held back by the always-busy gate until it reaches HIGH_SHARE of `high24`.
   */
  #start(P, R, T, base, alert, silent, high24) {
    const coins = new Map();
    for (const [m, s] of R.c) coins.set(m, { trades: s.n, usd: s.usd });
    const k0 = Math.floor(T / BUCKET_S) - 1, note = (map) => { for (const m of map.keys()) if (!coins.has(m)) coins.set(m, { trades: 0, usd: 0 }); };
    if (P.k >= k0) note(P.coins);
    for (const h of P.hist) { if (h.k < k0) break; note(h.coins); }
    const ratio = R.exN / Math.max(base, BASE_FLOOR);
    P.wake = { startedAt: T, ratio, peak: ratio, hotAt: T, coins, prices: new Map(), silent, high24 };
    this.waking.add(P);
    if (this.seeding) { if (alert) this.stats.seededWakes++; return; }
    if (alert) this.#emit(P, T, ratio, R.allN, () => this.#windowBreadth(R));
  }

  /**
   * Closes every bucket that ended (GRACE_S ago), moves each non-empty trailing window to end GRACE_S ago (its buys
   * expire, pending coins cross the line, the baseline moves on at a bucket edge) and judges it, lets go of coin buckets
   * past the 15 minutes, drops wake-ups past their time, writes the launch windows that closed, and now and then forgets
   * parents quiet for 24 h.
   */
  tick(nowS = this.#nowS()) {
    const cur = Math.floor((nowS - GRACE_S) / BUCKET_S), tr = nowS - GRACE_S;
    for (const P of this.open) if (P.k < cur) this.#close(P);
    for (const P of this.rolling) this.#rollAt(P, tr);
    // A parent that went quiet lets go of its coin buckets once they are older than the 15-minute view.
    for (const P of this.holding) { while (P.hist.length && P.hist[P.hist.length - 1].k < cur - QUIET_BUCKETS) P.hist.pop(); if (!P.hist.length) this.holding.delete(P); }
    for (const P of this.waking) if (this.#over(P.wake, nowS)) { P.wake = null; this.waking.delete(P); }
    this.#saveLaunches(nowS);
    if (!this.seeding && nowS - this.prunedAt >= PRUNE_EVERY_S) {
      this.prunedAt = nowS;
      for (const [m, P] of this.parents) if (P.k < 0 && !P.wake && !P.roll && P.lastK < cur - BASE_BUCKETS && nowS - P.lastAlert >= REFIRE_S) this.parents.delete(m);
      // A flag is read only while its coin is under 2 h 5 min old (the stored time is that less 30 min and 5 min); a
      // count nobody added to past the 30-minute line is done. Both walks are over at most HELD_MAX entries, every 10 min.
      for (const [m, v] of this.held) if (nowS - v > EXISTING_S + ROLL_S) this.held.delete(m);
      for (const [m, s] of this.early) if (nowS - s.at > EXISTING_S + ROLL_S) this.early.delete(m);
    }
  }

  // ---------------------------------------------------------------- creator facts
  /** One creator's launches: sorted creation times, and per `parent\nticker` the first coin. Rebuilt when the creator's set changed size. */
  #creatorIndex(key) {
    const set = this.model.creators?.get(key);
    if (!set) return null;
    let e = this.creatorIdx.get(key);
    if (e && e.size === set.size) { this.creatorIdx.delete(key); this.creatorIdx.set(key, e); return e; }
    const times = [], firsts = new Map();
    for (const m of set) {
      const x = this.model.coins.get(m);
      if (!x || x.createdAt == null) continue;
      times.push(x.createdAt);
      const sym = normSym(this.model.nameOf(m).symbol);
      if (!sym || !x.quoteMint) continue;
      const fk = `${x.quoteMint}\n${sym}`, f = firsts.get(fk);
      if (!f || x.createdAt < f.at || (x.createdAt === f.at && m < f.mint)) firsts.set(fk, { at: x.createdAt, mint: m });
    }
    times.sort((a, b) => a - b);
    e = { size: set.size, times: Float64Array.from(times), firsts };
    this.creatorIdx.delete(key); this.creatorIdx.set(key, e);
    while (this.creatorIdx.size > CREATORS_MAX) this.creatorIdx.delete(this.creatorIdx.keys().next().value);
    return e;
  }

  /**
   * Why a coin is left out ("sold" | "spree" | "relaunch"), or null. Cached: final once the coin is DEAD_SOLD_S old,
   * except an unknown "sold" fact (its launch rows are gone and nothing recorded it) and a coin with no known creator
   * (one may come with its fee shares), both asked again after FACT_UNKNOWN_MS.
   */
  deadWhy(c, nowMs = this.now()) {
    const hit = this.facts.get(c.mint);
    if (hit && nowMs < hit.until) return hit.why;
    const key = this.model.creatorKey(c), nowS = Math.floor(nowMs / 1000);
    let why = null, unknown = false;
    if (key && c.createdAt != null) {
      const idx = this.#creatorIndex(key);
      if (idx) {
        const t = idx.times, lo = c.createdAt - DEAD_LAUNCH_S;
        let a = 0, b = t.length;
        while (a < b) { const mid = (a + b) >> 1; if (t[mid] < lo) a = mid + 1; else b = mid; }
        let n = 0;
        for (let i = a; i < t.length && t[i] < c.createdAt && n < DEAD_LAUNCHES; i++) n++;
        if (n >= DEAD_LAUNCHES) why = "spree";
        const sym = normSym(this.model.nameOf(c.mint).symbol);
        const f = sym && c.quoteMint ? idx.firsts.get(`${c.quoteMint}\n${sym}`) : null;
        if (!why && f && f.mint !== c.mint) why = "relaunch";
      }
      if (!why) { const f = this.#launchFlow(c, key, nowS); if (!f) unknown = true; else if (f.bought > 0 && f.sold >= DEAD_SOLD * f.bought) why = "sold"; }
    }
    const young = c.createdAt != null && nowS - c.createdAt < DEAD_SOLD_S;
    const until = young ? nowMs + FACT_YOUNG_MS : unknown || !key ? nowMs + FACT_UNKNOWN_MS : Infinity;
    const old = this.facts.get(c.mint);
    if (old) { this.facts.delete(c.mint); if (old.unknown) this.stats.factsUnknown--; }
    this.facts.set(c.mint, { why, unknown, until });
    if (unknown) this.stats.factsUnknown++;
    while (this.facts.size > FACTS_MAX) { const [m, f] = this.facts.entries().next().value; this.facts.delete(m); if (f.unknown) this.stats.factsUnknown--; }
    return why;
  }

  /**
   * The launcher's `{ bought, sold }` in the coin's first DEAD_SOLD_S, or null when unknown. A young coin's rows are all
   * stored; an older one's come from its record (sqlite, else the window still open in memory), else from the rows when
   * they still reach back to the launch (the trim deletes a coin's oldest rows first), which are then recorded.
   */
  #launchFlow(c, key, nowS) {
    const db = this.model.db, end = c.createdAt + DEAD_SOLD_S;
    if (nowS < end) { this.stats.factQueries++; return db.creatorFlow(c.mint, c.createdAt, end, key); }
    const rec = db.launchFlowGet(c.mint);
    if (rec) return rec;
    const e = this.launch.get(c.mint);
    if (e && e.key === key && e.first <= c.createdAt + LAUNCH_SEEN_S) return e;
    this.stats.factQueries++;
    const first = db.tradeFirstTime(c.mint);
    if (first == null || first > c.createdAt + LAUNCH_SEEN_S) return null;
    const f = db.creatorFlow(c.mint, c.createdAt, end, key);
    if (db.launchFlowPut(c.mint, f.bought, f.sold, c.createdAt, db.sniperFlow(c.mint, c.createdAt, SNIPE_S, key, c.createdSlot ?? null, DEAD_SOLD_S))) this.stats.launchSaved++;
    return f;
  }

  /**
   * The share of supply (percent, 1 dp) wallets other than the launcher bought in the coin's creation slot or its first
   * SNIPE_S seconds, or null when unknown (no launcher known, the window not seen from the launch, or no record and the
   * launch rows gone). From the open launch window, else its sqlite record, else the stored rows while they reach the
   * launch. Cached like the creator facts: final once known and the coin is 10 min old, a young one asked again after
   * FACT_YOUNG_MS, an unknown one after FACT_UNKNOWN_MS.
   */
  sniperOf(c, nowMs = this.now()) {
    const hit = this.snipes.get(c.mint);
    if (hit && nowMs < hit.until) return hit.pct;
    const db = this.model.db, key = this.model.creatorKey(c), at = c.createdAt, nowS = Math.floor(nowMs / 1000);
    let supply = 0;
    try { supply = Number(BigInt(c.tokenTotalSupply ?? 0)); } catch { supply = 0; }
    let v = null;
    if (key && at != null && supply > 0 && nowS >= at + SNIPE_S + GRACE_S) {
      const e = this.launch.get(c.mint);
      if (e && e.key === key && e.first <= at + LAUNCH_SEEN_S) v = e.snipe;
      else {
        const rec = db.launchFlowGet(c.mint);
        if (rec?.sniped != null) v = rec.sniped;
        else {
          this.stats.factQueries++;
          const first = db.tradeFirstTime(c.mint);
          if (first != null && first <= at + LAUNCH_SEEN_S) v = db.sniperFlow(c.mint, at, SNIPE_S, key, c.createdSlot ?? null, DEAD_SOLD_S);
        }
      }
    }
    const pct = v == null ? null : r1((v / supply) * 100);
    const young = at != null && nowS < at + DEAD_SOLD_S;
    this.snipes.delete(c.mint);
    this.snipes.set(c.mint, { pct, until: young ? nowMs + FACT_YOUNG_MS : v == null ? nowMs + FACT_UNKNOWN_MS : Infinity });
    while (this.snipes.size > FACTS_MAX) this.snipes.delete(this.snipes.keys().next().value);
    return pct;
  }

  // ---------------------------------------------------------------- bodies
  #parentRef(mint) {
    const { name, symbol } = this.model.nameOf(mint);
    return { mint, name, symbol, image: imageProxyUrl(this.model.imageOfMint(mint)), isCoin: !!this.model.get(mint)?.tracked };
  }
  #postState(id) {
    const n = this.narrative;
    if (!n?.postState) return { state: "idle", handle: null, text: null };
    try { return n.postState(id); } catch (e) { this.log.warn?.(`wakeups: post ${id}: ${e?.message ?? e}`); return { state: "idle", handle: null, text: null }; }
  }

  /**
   * `"live"` / `"cooling"` for a parent whose family the list shows now (among its first LIST_MAX, the list's own
   * order), else null: the trending rows' family tag, which the page words as "listed under Waking up". A family
   * waking past the 12th is not on that list, so it gets no tag. The order is worked out at most once a second (a
   * sort of the waking parents, a few dozen), not per row.
   */
  familyState(mint, nowS = this.#nowS()) {
    const P = this.parents.get(mint), w = P?.wake;
    if (!w || this.#over(w, nowS)) return null;
    if (this.listedAt !== nowS) {
      this.listedAt = nowS;
      this.listed = new Set(this.#order(nowS, true).slice(0, LIST_MAX).map((a) => a.P));
    }
    if (!this.listed.has(P)) return null;
    return this.#live(w, Math.max(this.#complete(nowS), P.lastK)) ? "live" : "cooling";
  }
  /** The waking parents in the list's order: live first, newest start first, then cooling ones; `skipOver` leaves out wake-ups already over (no tick ran). */
  #order(nowS, skipOver = false) {
    const Lg = this.#complete(nowS), act = [];
    for (const P of this.waking) {
      if (skipOver && this.#over(P.wake, nowS)) continue;
      const L = Math.max(Lg, P.lastK);
      act.push({ P, L, live: this.#live(P.wake, L) });
    }
    return act.sort((a, b) => (b.live - a.live) || b.P.wake.startedAt - a.P.wake.startedAt || byMint(a.P.mint, b.P.mint));
  }
  /** A coin's `sinceStart` when its parent is waking (null otherwise): what a trending row shows beside the family's. */
  sinceStartOf(c) {
    const w = c?.quoteMint ? this.parents.get(c.quoteMint)?.wake : null;
    return w ? this.#sinceStart(c, w) : null;
  }
  /**
   * An existing coin's price now over its price at the wake-up's start (its last trade at or before it, else its first
   * after), in USD when both have one (what a holder sees), else in the parent; 2 dp. Null for a new coin: measured from
   * its first trade it would count its own launch buy (the web shows "new").
   */
  #sinceStart(c, w) {
    if (!(c.createdAt == null || c.createdAt < w.startedAt - EXISTING_S)) return null;
    const model = this.model, m = c.mint, pr = model.priceOf(m);
    let p0 = w.prices.get(m);
    if (!p0) { p0 = model.db.priceRef(m, w.startedAt); if (p0) w.prices.set(m, p0); }
    if (!p0 || !pr) return null;
    if (p0.priceUsd > 0 && pr.priceUsd != null && Number.isFinite(pr.priceUsd)) return r2(pr.priceUsd / p0.priceUsd);
    if (p0.priceQuote > 0 && Number.isFinite(pr.priceQuote)) return r2(pr.priceQuote / p0.priceQuote);
    return null;
  }

  /**
   * A family's coin (README §API): the lib/coinrows.mjs row over timeframe `tf` with the family's `sinceStart` and
   * `copyOf` (a new coin that links an X post: how many earlier children of the parent link it; null otherwise).
   */
  #coin(c, { snap, tf, w, groups, postId, px }) {
    const row = this.model.coinRows.row(c, snap, tf, { at: w.startedAt, sinceStart: this.#sinceStart(c, w), px, safety: false });
    let copyOf = null;
    if (!row.existing && postId && groups) {
      const g = groups.get(postId);
      copyOf = 0;
      if (g) for (const x of g.mints) { if (x === c.mint) continue; const o = this.model.coins.get(x); if (o?.createdAt != null && o.createdAt < c.createdAt) copyOf++; }
    }
    row.copyOf = copyOf;
    return row;
  }

  /**
   * The post a family shows (the head of the file), or null. `posts`: id → { n, fresh }, the coins traded since the
   * start that link it and how many of those were launched since the start minus 30 min. Posts made around the start
   * first, then the vote among those that qualify; one X does not show is passed over (three are tried at most).
   */
  #pickPost(posts, w, nowMs) {
    const T = w.startedAt, near = [], rest = [];
    for (const [id, v] of posts) {
      if (v.n < 2) continue;
      const at = postTime(id, nowMs), p = { id, at, n: v.n, fresh: v.fresh };
      if (at != null && at >= T - POST_BEFORE_S && at <= T + POST_AFTER_S) near.push(p);
      // Old coins sharing an old post is not what coincided with this; an old post new coins are copying may be.
      else if ((at != null && at >= T - POST_OLD_S) || v.fresh >= POST_NEW_COINS) rest.push(p);
    }
    const vote = (x, y) => y.n - x.n || (y.at ?? 0) - (x.at ?? 0) || byMint(x.id, y.id);
    near.sort(vote); rest.sort(vote);
    for (const p of [...near, ...rest].slice(0, 3)) {
      const s = this.#postState(p.id);
      if (s.state === "none") continue;
      // `lead`: how long before the wake-up's start the post was made (negative: after it). What coincided, not a cause.
      return { id: p.id, url: postUrl(p.id), at: p.at, handle: s.state === "ok" ? s.handle : null, text: s.state === "ok" ? s.text : null, state: s.state, coins: p.n, newCoins: p.fresh, lead: p.at == null ? null : T - p.at };
    }
    return null;
  }

  /**
   * One family of the list, in steps (a yield after every coin: a coin's first creator check may read sqlite, and the
   * shared scheduler keeps stepping one job until its 8 ms are spent, so the yields cost nothing). Its coins:
   * the children traded since the start that somebody bought ($1+) in the trailing 5 minutes (`buyers5m` from the
   * snapshot), most such buyers first, then USD volume since the start, then the mint; creator-fact coins left out
   * (counted in `hidden`), dust (a known market cap under $1,000) left out and counted in `dust` (among the
   * FAMILY_SCAN looked at), at most COINS_MAX listed, the rest counted in `more`. All four count coins with a $1+ buy
   * in the trailing 5 minutes, the basis of the headline's `coinsTrading`, so rows + more + hidden + dust is that
   * number (the snapshot and the window are read up to 5 s apart). They used to count any trade, a sale too: a card
   * read "3 coins trading" over 3 rows and "5 more trading" (more coins traded than were bought in 282 of 321 samples).
   * The headline is read from the trailing window last, with no yield after it, so its numbers belong to one moment.
   */
  *#familyGen(P, L, nowMs, groups, px, snap, tf, listed) {
    const model = this.model, w = P.wake, fresh = P.lastK === L;
    const cands = [], posts = new Map();
    // "existing" as the rule's window reads it as of the snapshot, a busy launch's hold included
    const line = snap.nowS - ROLL_S - EXISTING_S, since = w.startedAt - EXISTING_S;
    let hidden = 0, bought = 0, sold = 0;
    for (const [m, e] of w.coins) {
      yield;
      const c = model.coins.get(m);
      if (!c || !c.tracked) continue;
      // a coin only noted at the start (#start) has not traded since: no vote
      const postId = e.trades > 0 ? postOf(model.metaFor(c)) : null;
      if (postId) {
        let v = posts.get(postId);
        if (!v) posts.set(postId, v = { n: 0, fresh: 0 });
        v.n++; if (c.createdAt != null && c.createdAt >= since) v.fresh++;
      }
      const T = snap.per.get(m)?.tf[1], buyers = T ? T.buyers : 0;
      // Dollars are a fact of the family whoever launched the coin: a creator-fact coin's count too.
      if (T) { const born = c.createdAt == null ? null : this.held.get(m) ?? c.createdAt; if (born == null || born < line) { bought += T.bv; sold += T.v - T.bv; } }
      if (this.deadWhy(c, nowMs)) { if (buyers) hidden++; continue; }
      cands.push({ c, buyers, usd: e.usd, postId });
    }
    cands.sort((x, y) => y.buyers - x.buyers || y.usd - x.usd || byMint(x.c.mint, y.c.mint));
    yield;
    const post = this.#pickPost(posts, w, nowMs);
    const coins = [];
    let dust = 0, more = 0, looked = 0, i = 0;
    for (; i < cands.length; i++) {
      const x = cands[i];
      if (coins.length >= COINS_MAX || x.buyers < 1 || looked >= FAMILY_SCAN) break; // ranked by buyers: the rest have none
      looked++;
      const row = this.#coin(x.c, { snap, tf, w, groups, postId: x.postId, px });
      yield;
      if (isDust(row)) { dust++; continue; }
      // Kept and in a listed family: only now may it queue holder reads (lib/holders.mjs reads ~10-15 coins a minute,
      // and the 38 families built past the list would take most of that from the rows people see).
      row.safety = listed ? this.model.coinRows.safetyOf(x.c) : null;
      coins.push(row);
    }
    for (; i < cands.length && cands[i].buyers >= 1; i++) more++; // ranked by buyers: the rest have none
    // From here on no yield: the trailing window as it is now (the tick moved it at the start of the build, and it
    // goes on taking buys between steps), and the closed buckets.
    const spark = new Array(SPARK_BUCKETS), sparkEx = new Array(SPARK_BUCKETS);
    for (let j = 0; j < SPARK_BUCKETS; j++) {
      const k = L - SPARK_BUCKETS + 1 + j, s = ((k % SPARK_BUCKETS) + SPARK_BUCKETS) % SPARK_BUCKETS;
      spark[j] = P.sparkK[s] === k ? P.spark[s] : 0;
      // the baseline ring holds the closed buckets up to `upTo` (a later one is not written yet: nobody traded in it)
      sparkEx[j] = k >= 0 && k <= P.upTo && k > P.upTo - RING ? P.ex[k % RING] : 0;
    }
    const R = P.roll, nowS = Math.floor(nowMs / 1000), tw = Math.max(P.rt, nowS - GRACE_S);
    // The mean as the rule reads it for the window ending now; the last closed bucket's when it cannot be read.
    const base = (this.firstK == null ? null : this.#baseAt(P, Math.floor(tw / BUCKET_S) - 1)) ?? P.lastBase;
    const exN = R ? R.exN : 0, allN = R ? R.allN : 0, ratio = exN / Math.max(base, BASE_FLOOR);
    // so the headline never reads above "down from"
    if (ratio > w.peak) w.peak = ratio;
    // Breadth from the buyers the rows show (creator-fact coins are in neither); `cands` is in the list's own order,
    // so the most-bought coin is the first row unless that one is dust.
    const b = this.#breadthOf((function* () { for (const x of cands) { if (x.buyers < 1) break; yield [x.c.mint, x.buyers]; } })(), allN);
    return {
      parent: this.#parentRef(P.mint), startedAt: w.startedAt, state: this.#live(w, L) ? "live" : "cooling",
      ratio: r1(ratio), peakRatio: r1(w.peak), buyers5m: allN, trades5m: fresh ? P.lastTrades : 0,
      spark, sparkFrom: (L - SPARK_BUCKETS + 1) * BUCKET_S, baseline: r1(base),
      // coins with a $1+ buy in the trailing 5 minutes (the window holds buys only)
      coinsTrading: R ? R.c.size : 0, post, coins, more, hidden, dust,
      sparkEx, buyersEx5m: exN, bought5mUsd: r2(bought), sold5mUsd: r2(sold),
      coins5: b.coins5, topShare: b.topShare, topMint: b.topMint, topSymbol: b.topMint ? model.nameOf(b.topMint).symbol ?? null : null,
      silent: !!w.silent, high24: w.high24 ?? null,
    };
  }

  /** The list over timeframe `tf`, in steps: live wake-ups first, newest start first, then cooling ones. */
  *#buildGen(groupsBy, snap, tf) {
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000);
    this.tick(nowS);
    const act = this.#order(nowS);
    const built = new Map(), families = [], px = new Map();
    let live = 0;
    for (const a of act.slice(0, WAKES_MAX)) {
      yield;
      // Families past LIST_MAX are built only for /api/discover/:mint; their coins queue no holder reads here.
      const f = yield* this.#familyGen(a.P, a.L, nowMs, groupsBy.get(a.P.mint) ?? null, px, snap, tf, families.length < LIST_MAX);
      built.set(a.P.mint, f); families.push(f);
      if (f.state === "live") live++;
    }
    this.stats.live = live; this.stats.cooling = families.length - live;
    return { at: nowMs, snap, built, body: { asOf: nowS, bucketS: BUCKET_S, tf, families: families.slice(0, LIST_MAX) } };
  }

  /**
   * The narrative's post groups (for copyOf) of each waking parent with a new coin traded since the start: each is a
   * walk over the parent's children (sliced, cached 30 s there), so a family of old coins only does not ask for one.
   */
  async #groups() {
    const out = new Map(), n = this.narrative;
    if (!n?.groupsOf) return out;
    const want = [];
    for (const P of this.waking) {
      if (want.length >= WAKES_MAX) break;
      const cut = P.wake.startedAt - EXISTING_S;
      for (const m of P.wake.coins.keys()) { const at = this.model.coins.get(m)?.createdAt; if (at != null && at >= cut) { want.push(P); break; } }
    }
    await Promise.all(want.map(async (P) => {
      try { out.set(P.mint, await n.groupsOf(P.mint)); } catch (e) { this.log.warn?.(`wakeups: groups ${P.mint}: ${e?.message ?? e}`); }
    }));
    return out;
  }

  /**
   * The body of GET /api/discover?tf= (README §API): built once per coin-row snapshot per timeframe and served while
   * that snapshot is current (at most WAKE_TTL_MS), one build shared by the askers that come together.
   */
  async serve(tf = TF_DEFAULT) {
    this.stats.served++;
    const rows = this.model.coinRows, hit = this.hits.get(tf);
    if (hit && hit.snap === rows.current()) return hit.body;
    let job = this.jobs.get(tf);
    if (!job) {
      // Where an uncached request's wait goes (wall clock): the snapshot, the narrative's groups, the build itself.
      const t0 = performance.now(), wait = { snap: 0, groups: 0, build: 0, total: 0 };
      const timed = (key, p) => p.then((v) => { wait[key] = r2(performance.now() - t0); return v; });
      let t1 = t0;
      job = Promise.all([timed("groups", this.#groups()), timed("snap", rows.snap())]).then(([g, snap]) => { t1 = performance.now(); return runSliced(this.#buildGen(g, snap, tf)); }).then((run) => {
        const t2 = performance.now();
        wait.build = r2(t2 - t1); wait.total = r2(t2 - t0); this.stats.lastWaitMs = wait;
        this.stats.builds++; this.stats.lastBuildMs = r2(run.cpuMs);
        if (run.maxSliceMs > this.stats.maxSliceMs) this.stats.maxSliceMs = r2(run.maxSliceMs);
        this.hits.set(tf, run.value);
        return run.value.body;
      }).finally(() => this.jobs.delete(tf));
      this.jobs.set(tf, job);
    }
    return job;
  }
  /** Drops the cached bodies and the coin-row snapshot (tests; a body is otherwise served while its snapshot is current). */
  forget() { this.hits.clear(); this.quiet.clear(); this.model.coinRows.hit = null; this.model.coinRows.trend.clear(); }

  /**
   * The body of GET /api/discover/:mint?tf=: the family object when `mint` is waking, else the quiet shape (README §API);
   * null for SOL and for a mint that is neither a tracked coin nor a parent.
   */
  async serveOne(mint, tf = TF_DEFAULT) {
    const model = this.model;
    if (typeof mint !== "string" || mint === SOL_MINT) return null;
    if (!model.get(mint)?.tracked && !model.children?.get(mint)?.size) return null;
    await this.serve(tf);
    const f = this.hits.get(tf)?.built.get(mint);
    // A family built past the list has no safety yet: filled on a copy now that someone opened it (the build stays as built).
    if (f) return f.coins.some((r) => r.safety == null) ? { ...f, coins: f.coins.map((r) => (r.safety == null ? { ...r, safety: this.#safety(r.mint) } : r)) } : f;
    const key = `${tf}\n${mint}`;
    const hit = this.quiet.get(key);
    if (hit && hit.snap === model.coinRows.current()) return hit.body;
    let job = this.quietJobs.get(key);
    if (!job) {
      job = model.coinRows.snap().then((snap) => runSliced(this.#quietGen(mint, snap, tf))).then((run) => {
        this.stats.quietBuilt++; this.stats.lastQuietMs = r2(run.cpuMs);
        if (run.maxSliceMs > this.stats.quietMaxSliceMs) this.stats.quietMaxSliceMs = r2(run.maxSliceMs);
        this.quiet.delete(key); this.quiet.set(key, run.value);
        while (this.quiet.size > QUIET_CACHE) this.quiet.delete(this.quiet.keys().next().value);
        return run.value.body;
      }).finally(() => this.quietJobs.delete(key));
      this.quietJobs.set(key, job);
    }
    return job;
  }

  #safety(mint) {
    const c = this.model.coins.get(mint);
    return c ? this.model.coinRows.safetyOf(c) : { devPct: null, top10Pct: null, sniperPct: null, state: "unknown" };
  }

  /**
   * The quiet answer, in steps: the 3 children most wallets bought ($1+) in the last 3 complete buckets, never one with
   * no such buyer (a coin only sold is not moving) and never dust (counted in `dust`). A yield every 256 entries merged
   * and after every coin examined, at most QUIET_SCAN examined: a coin's first creator check may read sqlite, and many
   * left out would be one long step.
   */
  *#quietGen(mint, snap, tf) {
    const nowMs = this.now(), nowS = Math.floor(nowMs / 1000);
    this.tick(nowS);
    const P = this.parents.get(mint), L = Math.max(this.#complete(nowS), P?.lastK ?? -1), fresh = !!P && P.lastK === L;
    const last = fresh ? P.hist[0].coins : null;
    const per = new Map(); // coin mint → { set, own, trades }
    let n = 0;
    for (const h of P?.hist ?? []) {
      if (h.k < L - QUIET_BUCKETS + 1 || h.k > L) continue;
      for (const [m, s] of h.coins) {
        if ((++n & 255) === 0) yield;
        const u = per.get(m);
        if (!u) { per.set(m, { set: s.buyers, own: false, trades: s.trades }); continue; }
        if (!u.own) { u.set = new Set(u.set); u.own = true; }
        for (const x of s.buyers) u.set.add(x);
        u.trades += s.trades;
      }
    }
    yield;
    const ranked = [...per].sort((a, b) => b[1].set.size - a[1].set.size || b[1].trades - a[1].trades || byMint(a[0], b[0]));
    const coins = [], px = new Map();
    let seen = 0, dust = 0;
    for (const [m, u] of ranked) {
      if (coins.length >= QUIET_COINS || u.set.size === 0 || seen >= QUIET_SCAN) break; // ranked by buyers: the rest have none
      seen++;
      yield;
      const c = this.model.coins.get(m);
      if (!c || !c.tracked || this.deadWhy(c, nowMs)) continue;
      const row = this.model.coinRows.row(c, snap, tf, { at: nowS, px, safety: false });
      yield;
      if (isDust(row)) { dust++; continue; }
      row.safety = this.model.coinRows.safetyOf(c);
      row.copyOf = null; row.buyers15m = u.set.size;
      coins.push(row);
    }
    // The family keys a quiet parent has no measure for are null (README §API); its buyers are the last closed bucket's.
    return {
      at: nowMs, snap,
      body: {
        parent: this.#parentRef(mint), startedAt: null, state: "quiet", ratio: null, peakRatio: null,
        buyers5m: fresh ? P.lastAll : 0, trades5m: fresh ? P.lastTrades : 0, spark: null, sparkFrom: null, baseline: null,
        coinsTrading: last ? last.size : 0, post: null, coins, more: 0, hidden: 0, dust,
        sparkEx: null, buyersEx5m: fresh ? P.lastEx : 0, bought5mUsd: null, sold5mUsd: null,
        coins5: null, topShare: null, topMint: null, topSymbol: null, silent: false, high24: null,
      },
    };
  }
}
