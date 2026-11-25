// Typed client for the Spore API (DESIGN.md §7). Types are copied from the contract verbatim so a
// server change shows up as a type error here, not as "undefined" in a card. Every call goes to
// the same origin under /api, which Vite proxies to :8793 in development.
import type { MapFamilyResponse } from "./map/family-types";

export type CoinRef = { mint: string; name: string | null; symbol: string | null; image: string | null; depth: number };
export type Shares = { address: string; bps: number }[];
export type Coin = {
  mint: string; name: string | null; symbol: string | null; image: string | null; description: string | null;
  twitter: string | null; telegram: string | null; website: string | null;
  creator: string; quoteMint: string | null /* null = SOL */; quoteSymbol: string /* "SOL" | "USDC" | parent symbol | short mint */;
  depth: number; parent: CoinRef | null; root: CoinRef | null; ancestors: CoinRef[] /* nearest first, excludes self */;
  complete: boolean; migrated: boolean; pool: string | null; createdAt: number | null; createdSlot: number | null;
  tokenProgram: string; decimals: number; totalSupply: string;
  priceQuote: number | null; priceSol: number | null; priceUsd: number | null; mcapSol: number | null; mcapUsd: number | null; progress: number;
  children: number; descendants: number; lockedQuote: string; lockedUsd: number | null; volume24hUsd: number; trades24h: number;
  holderReward: boolean; creatorFeeBps: number; shares: Shares | null; updatedAt: number;
  /// DESIGN §11.1: launched through Spore (platform wallet in the on-chain fee split), or reported by
  /// the UI right after a spawn and not yet verified. Optional: an older server leaves them out.
  ours?: boolean; oursPending?: boolean;
  /// pump's mayhem mode: such a coin can never be a parent, so the launch button on its card is off.
  mayhem?: boolean;
};
export type Stats = {
  coins: number; roots: number; byDepth: number[]; lockedUsd: number; volume24hUsd: number; solUsd: number | null; maxDepth: number;
  backfill: { done: boolean; total: number; resolved: number }; updatedAt: number;
  /// "ours" lists only coins launched here (§11.1); ourCoins/otherChildren let the UI say how many exist elsewhere.
  mode?: "ours" | "all"; ourCoins?: number; otherChildren?: number;
};
/// `valueUsd`: the trade's size in dollars (null when the quote has no USD price); an older server leaves it out.
export type Trade = { sig: string; mint: string; slot: number; time: number; isBuy: boolean; user: string; baseAmount: string; quoteAmount: string; priceQuote: number; priceUsd: number | null; valueUsd?: number | null };
export type TreeNode = { coin: Coin; children: TreeNode[] };
/// One bubble of the ecosystem map: a CoinRef plus the few numbers a bubble is sized and labelled by.
/// `parentMint` and `updatedAt` arrive on the flat delta variant (DESIGN §11.5); `ours` marks a Spore launch.
export type MapCoin = CoinRef & { mcapUsd: number | null; lockedUsd: number | null; children: number; descendants: number; migrated: boolean; createdAt: number | null; ours?: boolean; oursPending?: boolean; parentMint?: string | null; updatedAt?: number };
export type MapNode = { coin: MapCoin; children: MapNode[] };
/// `GET /api/map` (§11.5). Full form: a tree of every root. Delta form (`since=<ms>`): only the nodes whose
/// `updated_at` moved, flat, each with its `parentMint`; `removed` is reserved. An older server answers the
/// full tree to both, so the client treats whichever list is present as upserts.
/// `indexed` (DESIGN-FAMILY-ALL §4): every coin the map counts, the drawn ones plus each listed asset's coins the body
/// leaves out (its `children` minus the drawn ones); an older server leaves it out.
export type MapResponse = { roots?: MapNode[]; nodes?: MapCoin[]; updated?: MapCoin[]; removed?: string[]; scope?: string; version?: number | string; generatedAt?: number; total?: number; indexed?: number };
export type MapQuery = { limit?: number | "all"; depth?: number; scope?: "ours" | "all"; since?: number };
/// SSE `pair`: a child the live stream saw whose parent is tracked; `parent` lets the client add a root it has not drawn.
export type PairEvent = { coin: MapCoin; parent: MapCoin };
/// SSE `mapdelta`: numbers that moved since the last batch (≤ every 3 s, ≤ 500 entries).
export type MapDeltaEntry = { mint: string; mcapUsd: number | null; lockedUsd: number | null; children: number; descendants: number; migrated: boolean; name?: string | null; symbol?: string | null; image?: string | null };
export type MapDeltaEvent = { at: number; updated: MapDeltaEntry[] };
/// `GET /api/map/heat` (§11.5 "Activity (heat)"): parallel arrays, one entry per tracked coin with at least
/// one trade in the last 24 h, sorted by trades in the last hour, then 24 h volume. `at`, `since` and `last`
/// are unix seconds; `v24` is USD to the cent. A sidecar of /api/map because it decays without row updates.
export type HeatResponse = { at: number; since: number; mint: string[]; t1h: number[]; n24: number[]; v24: number[]; last: number[]; buys1h: number[] };
/// Each map family's share of the whole map's value in one size mode (§11.5 "Dominance"), biggest first;
/// `value` is USD (what the family's top bubble is drawn by), `share` 0..1, `coins` the family's size.
export type DominanceResponse = { mode: "locked" | "mcap"; total: number; families: { mint: string; symbol: string | null; value: number; share: number; coins: number }[] };
/// Lamports are a string on the wire so a big value survives JSON; `sol` is the same amount for display.
export type LaunchFeeInfo = { to: string; lamports: string; sol: number };
/// `pool` names what the new coin is quoted in: "sol" for a root coin (no parent), else the parent mint.
/// A root's eligibility also states the agent slice of its split (lib/policy.ts ROOT_SPLIT): its bps,
/// and the address once a wallet was prepared for this launch (null in the preview).
/// `ready`: false when the server cannot make agent wallets right now (no vault): a root launch must not start.
export type EligibilityAgent = { bps: number; address: string | null; models?: string[]; defaultModel?: string; ready?: boolean; seedLamports?: number };
export type Eligibility = { ok: boolean; reason: string | null; depth: number | null; chain: CoinRef[]; parentCreator: string | null; grandparentCreator: string | null; shares: Shares; platform: string; launchFee?: LaunchFeeInfo | null; pool?: string; agent?: EligibilityAgent | null };
/// The agent wallet the server prepared for one root launch (POST /api/agents/prepare).
export type AgentPrepared = { id: string; address: string; model: string; expiresAt: number };
/// `s: 1`: a price sampled from the chain before the server's first stored trade (o = h = l = c, v = 0): a point on a
/// line, its high, low and volume unknown.
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number; s?: 1 };
/// The server is reading this coin's missed trades back from the chain (a restart, a reconnect: server lib/trade-fill.mjs);
/// `gaps` stretches from `from` to `to` (unix s); "waiting": the gaps have not settled yet (a later ask queues them).
/// Absent when nothing is pending.
export type CandleFill = { state: "queued" | "running" | "waiting"; gaps: number; from: number; to: number };
/// The chart's history before the coin's first stored trade (`history=1`, the coin page's chart only): `loading` while
/// GeckoTerminal is asked, `sampling` while the chain is read, `gecko` the pool whose candles are shown (credit link),
/// `chain` whether chain candles are in the answer ("sampled": some are points).
export type CandleHistory = { state: "loading" | "sampling" | "done"; gecko: string | null; chain: "exact" | "sampled" | null };
export type Candles = { candles: Candle[]; priceKey: "usd" | "quote"; fill?: CandleFill; history?: CandleHistory };
/// One older page of the coin page's chart (`before=`): rows of [from, before), oldest first, in the key asked for.
/// `next`: the `before` of the page below (null: nothing older); `loading`: ask the same page again (nothing to apply);
/// `held`: older candles exist but cannot be fetched now (the rows of [from, before) are still the server's).
export type CandlePage = { candles: Candle[]; priceKey: "usd" | "quote"; from: number; next: number | null;
  state: "loading" | "done" | "held"; gecko?: string | null; chain?: "exact" | "sampled" | null };
/// `otherChildren`: children of this coin that exist on pump.fun but were not launched here (ours mode).
export type CoinPage = { coin: Coin; children: Coin[]; trades: Trade[]; otherChildren?: number };
/// `GET /api/fees/:mint` (DESIGN §11.6): the creator fees waiting for a coin, read live from the
/// curve's bucket, the sharing config's creator vault and (migrated) the pump-amm vault, all in raw
/// units of the coin's quote (lamports for SOL, parent-token units otherwise) as strings. `perShare`
/// is each shareholder's cut of `total`; `claimable` is false with a `reason` when there is no
/// sharing config, the coin pays holders instead, or nothing is distributable yet.
export type FeeShare = { address: string; bps: number; amount: string };
export type Fees = {
  mint: string; quoteMint: string | null /* null = SOL */; quoteSymbol: string; quoteDecimals: number; quoteUsd: number | null;
  shares: Shares | null; bucket: string; vault: string; amm: string; total: string; totalUsd: number | null; perShare: FeeShare[];
  migrated: boolean; claimable: boolean; reason: string | null; updatedAt: number;
};
/// One row of the Claim page (DESIGN §11.7): a coin's pending fees plus, for a wallet, its part.
export type ClaimCoin = CoinRef & Fees & { yourBps?: number; yourAmount?: string; yourUsd?: number | null };
export type ClaimTotals = { usd: number; byQuote: { quoteMint: string | null; quoteSymbol: string; quoteDecimals: number; amount: string; usd: number }[] };
export type Claims = { wallet?: string; coins: ClaimCoin[]; totals: ClaimTotals; updatedAt: number };
/// `GET /api/portfolio/:wallet`: what one wallet holds and the coins it launched. A coin's parent is the coin it is
/// priced in (null for a root); a parent the index does not track still comes with its mint (name and image null,
/// symbol = the quote symbol when known). Times are unix seconds.
export type PortfolioParent = { mint: string; name: string | null; symbol: string | null; image: string | null };
export type PortfolioCoin = {
  mint: string; name: string | null; symbol: string | null; image: string | null; depth: number;
  parent: PortfolioParent | null; creator: string | null;
  mcapUsd: number | null; priceUsd: number | null; vol24Usd: number | null; trades1h: number | null; trades24h?: number | null; lastTradeAt: number | null;
  graduated: boolean; createdAt: number | null;
};
/// `amount` is raw units as a string, `uiAmount` the same in whole tokens; `valueUsd` is null without a USD price.
export type PortfolioHolding = { mint: string; amount: string; decimals: number; uiAmount: number; valueUsd: number | null; coin: PortfolioCoin };
/// `solLamports`: null when the balance read failed. `holdingsOk`: false when the token-account read failed (`holdings`
/// is then empty). `holdings`: only mints the index tracks, amount > 0, largest value first; `untracked` counts the
/// other token accounts with a balance. `launched`: coins whose creator is the wallet, newest first, at most 200 of
/// `launchedTotal`.
export type Portfolio = {
  wallet: string; at: number; solLamports: string | null; holdingsOk: boolean; holdings: PortfolioHolding[];
  untracked: number; launched: PortfolioCoin[]; launchedTotal: number;
  /// The lowest chain slot the server's reads answered at; null when a read failed (a degraded body), absent on a
  /// server that predates it.
  slot?: number | null;
};
/// `GET /api/pnl/:wallet` and `GET /api/activity/:wallet`: the wallet's own trades and what they made.
/// `history`: the one-off read of the wallet's past transactions. `scanned` of `total` while it runs; `cut`: older
/// trades were left out (`since` = block time of the oldest transaction read); `unread`: transactions that could not
/// be read; `gap`: trades since that time may be missing until a catch-up ran. "off": the read is disabled; "full":
/// the server tracks no more wallets (the coins are then empty).
export type PnlHistory = {
  state: "queued" | "running" | "done" | "failed" | "off" | "full";
  scanned: number; total: number; cut: boolean; unread: number; since: number | null; trackedAt: number | null; gap: number | null;
};
/// One coin the wallet traded. Amounts are strings in smallest units: `*Base` of the coin, `*Quote` of its quote
/// (`quoteMint` null = SOL, else the parent token), fees of the venue included. `boughtX`, `soldX`, `realizedQuote`
/// (signed), `buys` and `sells` cover the window asked for (`since`); `costQuote` (the cost of `heldBase`), `heldBase`
/// (what the trades say is still held), `partial` (tokens were sold or held without a recorded buy), `firstAt` and
/// `lastAt` cover everything stored. `*UsdNow`: the quote amount at TODAY's price of the quote, null without one.
export type PnlCoin = {
  mint: string; coin: { name: string | null; symbol: string | null; image: string | null };
  quoteMint: string | null; quoteSymbol: string; quoteDecimals: number; baseDecimals: number;
  boughtBase: string; boughtQuote: string; soldBase: string; soldQuote: string;
  realizedQuote: string; costQuote: string; heldBase: string;
  partial: boolean; buys: number; sells: number; firstAt: number; lastAt: number;
  realizedUsdNow: number | null; costUsdNow: number | null;
};
/// `ok: false`: the server's store failed (`history` null, no coins). `since`: the window used (rounded down to a
/// minute), null = everything. `trades`: the wallet's stored trades. `coins`: newest `lastAt` first.
export type Pnl = {
  ok: boolean; wallet: string; at: number; since: number | null; history: PnlHistory | null; trades: number; coins: PnlCoin[];
  totals: { realizedUsdNow: number | null; costUsdNow: number | null; unpriced: number };
};
/// `GET /api/pnl/:wallet/series`: the wallet's CUMULATIVE realized profit over time inside the window, in USD at
/// today's price of each coin's quote, time ascending: { t: window start (the first trade for all time), usd: 0 }, a
/// point per sell that realizes profit (240 at most, bucketed by time above that), then { t: at, usd: the total }, which
/// equals /api/pnl's totals.realizedUsdNow for the same `since`. `solUsd`: the SOL price now. `unpriced`: coins left
/// out because their quote has no price. Asking does not make the server track the wallet: an untracked wallet
/// answers no points. `ok: false`: the store failed (no points).
export type PnlSeriesPoint = { t: number; usd: number };
export type PnlSeries = { ok: boolean; wallet: string; at: number; since: number | null; solUsd: number | null; points: PnlSeriesPoint[]; unpriced: number };
/// One trade of the wallet. `quoteAmount`: what the wallet paid (buy) or received (sell), venue fees included.
export type WalletTrade = {
  sig: string; mint: string; coin: { name: string | null; symbol: string | null; image: string | null } | null;
  side: "buy" | "sell"; baseAmount: string; quoteAmount: string; baseDecimals: number;
  quoteMint: string | null; quoteSymbol: string | null; quoteDecimals: number | null; time: number;
};
/// `tracked`: the server keeps this wallet's trades (asking for the activity does not start that; /api/pnl does).
/// `trades`: newest first. `next`: pass back as `before` for the page after, null at the end.
export type WalletActivity = { ok: boolean; wallet: string; at: number; tracked: boolean; history: PnlHistory | null; trades: WalletTrade[]; next: string | null };
/// Root agents (DESIGN §13 + §13.1, live): every root launched on Spore gets an agent with its own
/// Solana wallet. The root's fee split sends the agent 0.20 % of every trade; the agent claims its
/// fees, thinks with a language model, launches coins under its root and pays its surplus to the
/// owner. Everything it does is in `activity` (its ledger) and `launched` (the registry).
/// `source` says whether a language model or the deterministic fallback (the root's own words)
/// produced a profile or proposal.
export type AgentSource = "model" | "fallback";
export type AgentProfile = {
  summary: string; themes: string[]; tone: string; avoid: string[]; palette: string[] /* 2-3 hex colours */;
  source?: AgentSource; builtAt?: number | null;
};
/// The simulated create_v2 launch: serialized size, compute used and the estimated SOL cost.
export type AgentSim = { ok: boolean; bytes: number | null; unitsConsumed: number | null; estCostSol: number | null; err: string | null };
export type AgentProposal = {
  /// The agent's one-line reason for this coin, right now (the hype line); null for template ideas.
  why?: string | null;
  /// Where the logo came from: "image" (image model), "model" (SVG drawn by the language model) or "template".
  logoSource?: string | null;
  id: string | number; createdAt: number; name: string; symbol: string; description: string;
  image: string | null /* /api/agents/img/<id>.png */; score: number; reason: string; sim: AgentSim | null;
  source: AgentSource; runnersUp: { name: string; symbol: string }[];
  /// The table keeps rejected proposals too; an API that only returns proposed ones leaves these out.
  status?: "proposed" | "rejected"; rejectedReason?: string | null;
};
export type AgentStats = { runs: number; proposals: number; lastRunAt: number | null; nextRunAt: number | null; score: number | null; scoreReason: string | null };
/// "paused" = switched off by the operator; anything else is a running agent ("dry" is the
/// registry's historical name for an enabled agent; the server's `mode` says whether launches are live).
export type AgentStatus = "live" | "dry" | "paused";
/// The agent's wallet as the server last read it (live snapshot, or the RPC with a 60 s cache).
export type AgentWallet = { address: string; sol: number | null; usdc: number | null; usd: number | null; updatedAt: number | null };
/// Lifetime sums from the agent's ledger. `aiUsd` is the estimated model spend booked to this agent.
export type AgentTotals = { launches: number; launchSol: number; claimsSol: number; claimsUsd: number | null; aiUsd: number; aiCalls: number; payoutsSol: number; payoutsUsdc: number; lastActivityAt: number | null };
/// A coin the agent launched under its root (registry `agent_launches` joined with the proposal).
export type AgentLaunched = { mint: string; name: string | null; symbol: string | null; image: string | null; createdAt: number | null; signature: string | null; why: string | null; logoSource: string | null };
export type ActivityKind = "launch" | "claim" | "payout" | "aifee" | "ai" | "swap" | "split";
/// One ledger line, made human: "Launched $RUMORMILL", "Claimed 0.0549 SOL from $SPREAD", "Paid 0.12
/// SOL to the owner", "Thought with Claude Sonnet 5.5 ($0.013)", "Drew a logo ($0.008)". `status` is
/// the ledger's (pending | sent | step_landed | landed | failed | expired | uncertain | done | refused).
/// `signature` is base58 or null (never base64); `explorer` is its Solscan link.
export type ActivityItem = { at: number; kind: ActivityKind; status: string; title: string; amountSol: number | null; amountUsdc: number | null; usd: number | null; mint: string | null; symbol: string | null; signature: string | null; explorer: string | null };
export type Agent = {
  root: CoinRef; status: AgentStatus; profile: AgentProfile | null; stats: AgentStats; latest: AgentProposal | null;
  wallet: AgentWallet | null; totals: AgentTotals;
  launched: AgentLaunched[] /* newest first; ≤ 12 in the list, all on the detail */;
  activity: ActivityItem[] /* newest first; ≤ 8 in the list, ≤ 200 on the detail */;
  /// Optional extras a server may add: the model it thinks with, and whether the runner put it to
  /// sleep (with the reason, e.g. "wallet holds $2.41, needs $5.00 to start"). Derived from the
  /// wallet when absent (components/agents/data.ts runState).
  model?: string | null; sleeping?: boolean | null; reason?: string | null;
};
/// `mode`: "live" when agents launch, "dry" when they only propose, "off" when the server only serves what is stored.
export type AgentList = { mode?: "off" | "dry" | "live"; agents: Agent[] };
export type AgentDetail = { agent: Agent; proposals: AgentProposal[] /* newest first, ≤ 50 */; activity: ActivityItem[]; launched: AgentLaunched[] };
/// `GET /api/agents/coin/:mint`: what a coin page needs. `role` is "root" when the mint has an agent,
/// "child" when an agent launched it, null otherwise (never a 404).
export type AgentCoinRole = "root" | "child" | null;
export type AgentCoin = {
  role: AgentCoinRole; root: CoinRef | null;
  agent: { address: string | null; status: AgentStatus; wallet: AgentWallet | null; totals: AgentTotals; model: string | null } | null;
  launch: { signature: string | null; at: number | null; why: string | null; logoSource: string | null; proposalId: string | null } | null;
};
/// SSE `agent`: a new proposal; a live agent adds `launched` once the coin is on-chain. `root` is the
/// root mint (a CoinRef is accepted too).
export type AgentEvent = { root: string | CoinRef; proposal: AgentProposal & { launched?: { mint: string; signature: string | null } | null } };
/// `GET /api/narrative/:mint`: the X posts the coins of a family link in their metadata, as a timeline. For a parent,
/// one EVENT per post its children link, newest first (`events`); for a child, its own post and how many other coins
/// under its parent link the same one (`own`); for a child with neither, its parent's newest event (`under`). The posts
/// are picked by coin creators and unverified. Times are unix seconds. The web never follows `url`: it rebuilds the
/// link from the id (lib/narrative.ts safePostUrl), and renders `handle` and `text` as plain text only.
/// A coin linking a post, with its 24 h volume in USD.
export type NarrativeCoin = { mint: string; name: string | null; symbol: string | null; image: string | null; usd24: number };
/// "ok": the text is known; "wait": it is being fetched (expected within ~40 s); "none": not available; "idle": not
/// fetched now. `handle` and `text` are set only with "ok" (`text` may be "": a media-only post).
export type NarrativeState = "ok" | "wait" | "none" | "idle";
/// One post linked by coins of the subject. `at`: when the FIRST such coin was created; `lastAt`: the last;
/// `postAt`: the post's own time read from its id; `coins`: how many coins link it; `usd24`: their summed 24 h
/// volume; `top`: up to 3 of them.
export type NarrativeEvent = { id: string; url: string; at: number; lastAt: number; postAt: number; coins: number; usd24: number; state: NarrativeState; handle: string | null; text: string | null; top: NarrativeCoin[] };
/// The subject's own post (`at`: the post's time, null when unknown). `siblings`: the other coins under `parent` linking it (null without a parent); `top`: up to 3 of them.
export type NarrativeOwn = { id: string; url: string; at: number | null; state: NarrativeState; handle: string | null; text: string | null; siblings: number | null; top: NarrativeCoin[]; parent: { mint: string; name: string | null; symbol: string | null } | null };
/// The parent (`mint`, `name`, `symbol`) and its newest listed event, for a coin with no post of its own.
export type NarrativeUnder = { mint: string; name: string | null; symbol: string | null; event: NarrativeEvent };
/// `members`: the subject's children counted; `linked`: those with a post; `events`: at most 12, by `at` newest
/// first; `earlier`: events not listed; `pending`: some state is "wait", so asking again soon is worth it.
export type Narrative = { mint: string; asOf: number; members: number; linked: number; events: NarrativeEvent[]; earlier: number; own: NarrativeOwn | null; under: NarrativeUnder | null; pending: boolean };
/// `GET /api/discover`: the families whose existing coins are being bought far above their normal level (a "wake-up").
/// Per parent and per 5-minute bucket (`bucketS`) the server counts the distinct wallets that bought (>= $1) a child
/// launched more than 30 min before the bucket; a bucket fires at >= 50 such buyers over >= 3 coins and >= 5x the
/// parent's trailing-24 h mean per bucket, and a new wake-up starts at most once per 3 h a parent. At most 12 families:
/// "live" first (newest `startedAt` first), then "cooling". Every figure is measured; none says why or what comes next.
export type WakeParent = { mint: string; name: string | null; symbol: string | null; image: string | null; isCoin: boolean };
/// The X post linked by the most children that traded since the start (>= 2 of them). `at`: the post's time; `coins`:
/// how many of those children link it; `handle` / `text` / `state` as in a narrative event (the server's post fetcher).
/// The web never follows `url`: it rebuilds the link from the id (lib/narrative.ts safePostUrl).
/// `lead`: startedAt - at in seconds (positive: posted before buying jumped), null when `at` is unknown; `text` is the
/// stored text, up to 600 characters.
export type WakePost = { id: string; url: string; at: number | null; handle: string | null; text: string | null; state: NarrativeState; coins: number; lead?: number | null;
  /// `newCoins`: how many of the linking coins were launched since 30 min before the start (a newer server).
  newCoins?: number };
/// A child moving now. `existing`: created before startedAt - 30 min (or with no known creation time); `sinceStart`:
/// last price / price at startedAt, null for a new coin (its first trade would count its own launch buy) or when
/// unknown; `copyOf`: for a new coin linking a post, how many earlier children of the parent link the same one (5: the
/// 6th copy); `buyers15m`: only in a quiet answer, the distinct $1+ buyers over the last 3 complete buckets.
/// The coin row shared by a family's coins, /api/trending and the quiet /api/discover/:mint answer. `tf`: the chosen
/// timeframe (`p0` the USD price at its start, `chg` percent priceUsd vs p0, `buyers` distinct $1+ buyers); `liqUsd`: the
/// curve or pool's quote side in USD; `spark`: the USD close of each 2-minute step over the last hour, oldest first,
/// null before the first trade; `safety`: measured shares of supply (1 dp), "pending" until the chain was read.
export type Tf = "1m" | "5m" | "30m" | "1h";
/// `holding` (a newer server): the window's buyers with no sell of the coin after their first buy in it.
export type CoinTf = { p0: number | null; chg: number | null; volUsd: number; buys: number; sells: number; buyers: number; holding?: number };
export type CoinSpark = { from: number; step: number; p: (number | null)[] };
export type CoinSafety = { devPct: number | null; top10Pct: number | null; sniperPct: number | null; state: "ok" | "pending" | "unknown" };
export type WakeCoin = {
  mint: string; name: string | null; symbol: string | null; image: string | null; createdAt: number | null; existing: boolean; mcapUsd: number | null;
  priceUsd?: number | null; sinceStart: number | null; buyers5m: number; buyers15m?: number; copyOf?: number | null;
  tf?: CoinTf; liqUsd?: number | null; spark?: CoinSpark; safety?: CoinSafety;
  /// From a newer server, all optional. `firstSeenAt`: the first stored trade of a coin whose launch was not seen
  /// (only when createdAt is null); `graduated`: trades on a pool, off the bonding curve; `thin`: a market cap of
  /// $1M or more that is over 100 times the liquidity.
  firstSeenAt?: number | null; graduated?: boolean; thin?: boolean;
};
export type CoinRow = WakeCoin;
export type WakeState = "live" | "cooling";
/// One family waking up. On a newer server the headline is the trailing 5 minutes at build time, one basis: `ratio` =
/// `buyersEx5m` / max(`baseline`, 1) (buyers of existing coins over the trailing-24 h mean per bucket), `buyers5m`
/// every coin's buyers, `coinsTrading` the coins with a $1+ buy; `trades5m` is still the last complete bucket's. An
/// older server measured them all on the latest complete bucket. `state`: "live" while a complete bucket is at 3x or
/// more (or it fired since), else "cooling", so a cooling family's `ratio` can be over 3. `spark`: distinct buyers per bucket for the last 2 h, OLDEST first (24 points, the last is the latest
/// complete bucket); `coins`: at most 6, most buyers first; `more`: other children that traded in the last 5 min;
/// `hidden`: children that traded since the start left out by the creator checks (sold out early, mass or repeat launch).
export type WakeFamily = {
  parent: WakeParent; startedAt: number; state: WakeState; ratio: number; peakRatio: number;
  buyers5m: number; trades5m: number; spark: number[]; baseline: number; coinsTrading: number;
  post: WakePost | null; coins: WakeCoin[]; more: number; hidden: number;
  /// `sparkFrom`: the start of the first spark bucket (unix s); `dust`: children trading now under a $1,000 market cap, left out.
  sparkFrom?: number; dust?: number;
  /// From a newer server, all optional. `sparkEx` / `buyersEx5m`: `spark` / `buyers5m` counting existing coins only,
  /// the same population as `ratio` and `baseline`, not the same moment (the last point is the last complete bucket, `ratio` the 5 minutes to now); `bought5mUsd` / `sold5mUsd`:
  /// USD bought and sold in existing coins over the trailing 5 min (new launches left out); `coins5`: coins with 5+ distinct buyers in the measured window;
  /// `topShare`: the most-bought coin's share of that window's buyers (0-1), `topMint` / `topSymbol` that coin; `silent`:
  /// the wake-up started without an alert (a family that is busy most of the time; false again once its alert is sent).
  /// `high24`: the parent's highest existing-buyer bucket in the 24 h before the start (not shown).
  sparkEx?: number[]; buyersEx5m?: number; bought5mUsd?: number; sold5mUsd?: number; coins5?: number; topShare?: number | null; topMint?: string | null; topSymbol?: string | null; silent?: boolean; high24?: number | null;
};
/// Every listed coin has a buyer in the last 5 min and a market cap of $1,000 or more (or unknown).
export type Discover = { asOf: number; bucketS: number; tf?: Tf; families: WakeFamily[] };
/// `GET /api/trending`: up to 50 coins by distinct $1+ buyers over the timeframe, then volume (a newer server: by the
/// buyers who have not sold, `tf.holding`). `parent`: null for a root; `family`: whether that parent is listed on
/// Discover now. `floor`: the buyers a coin needs over this timeframe to be listed (5 on 1m, else 0); `floor5m`: the
/// buyers in the last 5 min it needs to enter (3 on 30m and 1h, else 0; not worded on the page); `candidates`: the
/// coins that met them, before the creator checks, dust and the cap of 50, so it can be above `rows.length`.
export type TrendRow = CoinRow & { parent: { mint: string; symbol: string | null; image: string | null } | null; family: WakeState | null };
export type Trending = { asOf: number; tf: Tf; rows: TrendRow[]; floor?: number; floor5m?: number; candidates?: number };
/// `GET /api/stories`: the trending candidates grouped by what is behind the buying. A coin is in at most one place: a
/// card of the X post it links (`kind` "post", across parents; `family` set when a waking family chose that post), a card
/// of its waking family (`kind` "family"), `loose` (no story found), or `dust` (left out: `reason` "paper", a market cap
/// over 100 times the liquidity, or "tiny", under $5 volume a buyer). Coins with the same ticker and image are folded
/// under the one with the most liquidity (`copies`; none of them is called the original). `post.at` and
/// `family.startedAt` are unix seconds; the web rebuilds the post link from the id (lib/narrative.ts safePostUrl).
/// A card's `buyers5m` and `coinsN` count its coins and their copies; `hidden.dust` counts every dust coin (at most 30
/// are sent), `hidden.cards` the cards past the 20 sent, `hidden.loose` the coins of no card past the 30 loose rows sent.
/// `buyers`: the copy's buyers over the read's `tf` (its `tf.buyers`; a server before it sent none).
export type StoryCopy = { mint: string; createdAt: number | null; firstSeenAt: number | null; liqUsd: number | null; buyers5m: number; buyers?: number };
/// Narrative tags (a newer server with NARRATIVES=on): a language model reads each coin's public text and names the story it
/// belongs to. `title` is model-written, untrusted text (shown as plain text only); `theme` is one of the server's fixed
/// lower-case themes. Context only. A row anywhere may carry its `narrative`; a row of a "narrative" card carries
/// `isNew` (created within the last 60 min; an unknown launch time counts as older).
export type NarrativeRef = { id: number; title: string; theme: string };
export type StoryRow = TrendRow & { copies?: StoryCopy[]; narrative?: NarrativeRef | null; isNew?: boolean };
export type DustReason = "paper" | "tiny";
export type DustRow = StoryRow & { reason: DustReason };
export type StoryPost = { id: string; handle: string | null; text: string | null; at: number | null; url: string };
export type StoryFamily = { mint: string; symbol: string | null; image: string | null; startedAt: number | null };
/// `kind` "narrative" (key "n:<id>"): the coins that share one narrative, two or more of them; `narrative.newCoins1h`
/// counts every tagged coin of it created in the last 60 min, `post` is the usable post of its most-bought coin that has
/// one, `family` is null, `newN` / `olderN` split its coins by `isNew`. A "post" or "family" card carries `narrative`
/// (without the count) when all its coins share one. A subject block (key "t:..."): a "narrative" card for two or more
/// narratives of one subject (the server's subjects table: Jensen Huang, say), `narrative.title` the subject's, its
/// narratives in `subject.angles`, most 5-minute buyers first.
export type StoryAngle = { id: number; title: string; buyers5m: number; coinsN: number };
export type StoryCard = {
  kind: "post" | "family" | "narrative"; key: string; post: StoryPost | null; family: StoryFamily | null; buyers5m: number; coinsN: number; coins: StoryRow[];
  narrative?: (NarrativeRef & { newCoins1h?: number }) | null; newN?: number; olderN?: number;
  subject?: { key: string; title: string; angles: StoryAngle[] } | null;
  /// distinct wallets with a $1+ buy over the timeframe across all the card's coins (copies included), each counted once (a newer server)
  buyers?: number | null;
  attention?: StoryAttention | null;
  /// The story gate (a server with STORY_GATE=on; absent otherwise): over the last 30 min, its counted buyers, its lift
  /// against its own normal, capped net inflow in SOL, coins with 5+ buyers, its busiest same-word launch burst. A passing
  /// story is listed first, by `score` (lift x ln(1 + buyers)). Facts, never a forecast.
  gate?: StoryGate | null;
};
export type StoryGate = { pass: boolean; buyers30m: number; lift: number; inflowSol: number; coins5: number; word: { word: string; creators: number } | null; score: number };
/// Story attention (a newer server; absent on an older one): how many wallets the story draws now, as context, never a
/// forecast. `phase` describes the last hour against the hour before and the story's own peak ("new": no normal yet,
/// under 6 h of history, 12 baseline buckets or 10 buyers in the last hour). `buyers5m.last`: distinct wallets that
/// bought $1+ of the story's coins in the last complete 5-minute bucket; `now`: so far in the open one. `multiple`: the
/// story's share of all buyers on Spore in that bucket over its median share in its own history (null for "new").
/// `startAt` (unix s): the post's time (`startSource` "post"), the family's wake-up ("wake") or the first bucket with a
/// buyer ("buyers"). `leader.share`: 0-1 of the card's coin buyers over the last two buckets.
export type StoryPhase = "new" | "rising" | "peaked" | "fading" | "steady";
/// Why a story is "new": too little history (6 h, 12 buckets), too few buyers in the last hour, or a last hour the server
/// did not see whole (a restart).
export type StoryNewWhy = "history" | "quiet" | "unseen";
export type StoryAttention = {
  phase: StoryPhase; buyers5m: { now: number; last: number }; multiple: number | null; newWhy?: StoryNewWhy | null;
  startAt: number | null; startSource: "post" | "wake" | "buyers" | null; minutes: number | null;
  leader: { mint: string; symbol: string | null; share: number } | null;
};
/// `GET /api/story-series/:key`: the story's 5-minute buckets (`t` its start, unix s) of up to the last 14 days, oldest
/// first, with its start and normal (`baseline.ratio`: its median share of site buyers; `ready`: enough history for a
/// multiple to mean something). `partial`: the bucket the server started in.
export type StoryBucket = { t: number; buyers: number; siteBuyers: number; launchesFast: number; launches: number; buyUsd: number; partial: boolean };
/// GET /api/timeline (server lib/timeline.mjs): the stories the 5-minute series stored in a window, newest start first.
export type TimelineStory = {
  key: string; kind: "narrative" | "post" | "family" | "unknown"; title: string; theme?: string | null; handle?: string | null; url?: string | null; mint?: string;
  startAt: number; startSource: string; carried: boolean; firstT: number; lastT: number; peak: number; peakT: number; buyUsd: number; launches: number; coins: number;
  leader: { mint: string; symbol: string | null; name: string | null; image: string | null } | null; series: number[];
};
export type Timeline = { from: number; to: number; asOf: number; bucketS: number; min: number; site: { t: number; buyers: number }[]; stories: TimelineStory[]; listed: number; hidden: number; more: number };
export type StorySeries = {
  key: string; asOf: number; bucketS: number; startAt: number | null; startSource: "post" | "wake" | "buyers" | null; firstBuyersAt: number | null;
  baseline: { ratio: number; buckets: number; ready: boolean } | null; buckets: StoryBucket[];
};
/// `tagging.on` false (or absent, an older server): no narrative anywhere. `capped`: the daily spend cap was reached.
export type StoryTagging = { on: boolean; tagged?: number; pending?: number; capped?: boolean };
export type StoryTheme = { theme: string; cards: number };
export type Stories = { asOf: number; tf: Tf; cards: StoryCard[]; loose: StoryRow[]; dust: DustRow[]; hidden: { dust: number; cards?: number; loose?: number }; floor?: number; floor5m?: number; candidates?: number; tagging?: StoryTagging; themes?: StoryTheme[]; siteBuyers?: number | null };
/// `GET /api/discover/:mint`: the family when it is listed, else "quiet" with the top 3 children by buyers in the last
/// 15 min (`sinceStart` null) and the other figures null or 0. 404 for a mint the server does not know.
export type DiscoverQuiet = {
  parent: WakeParent; state: "quiet"; startedAt: null; ratio: null; peakRatio: null; buyers5m: number; trades5m: number;
  spark: number[] | null; baseline: number | null; coinsTrading: number; post: null; coins: WakeCoin[]; more: number; hidden: number;
  /// `dust`: children bought in the last 15 min under a $1,000 market cap, left out.
  sparkFrom?: null; dust?: number;
  /// A newer server sends the family's newer keys here too, null where a quiet parent has no measure (`buyersEx5m`
  /// is the last complete bucket's). Declared so a read of the union stays typed; none is shown for a quiet parent.
  sparkEx?: null; buyersEx5m?: number; bought5mUsd?: null; sold5mUsd?: null; coins5?: null; topShare?: null; topMint?: null; topSymbol?: null; silent?: false; high24?: null;
};
export type DiscoverOne = WakeFamily | DiscoverQuiet;
/// SSE `wake`: a wake-up's alert, published once. A newer server adds `alertedAt`: when the alert was sent, which is
/// `startedAt` except for a family that started without one (busy most of the time) and reached its mark later;
/// `ratio` and `buyers5m` are then as of `alertedAt`. `coins5` / `topShare` / `topSymbol` / `high24` as on a family.
export type WakeEvent = { parent: { mint: string; symbol: string | null; name: string | null }; startedAt: number; ratio: number; buyers5m: number;
  alertedAt?: number; coins5?: number; topShare?: number | null; topSymbol?: string | null; high24?: number | null };
export type RootSort = "locked" | "children" | "new" | "volume";
/// `GET /api/jup/build`: Jupiter's Swap API v2 /build answer, relayed as is (https://developers.jup.ag/docs/api-reference/swap/build.md).
/// Amounts are base units as strings. Each instruction is { programId, accounts, data (base64) }.
export type JupBuildQuery = { inputMint: string; outputMint: string; amount: string; taker: string; slippageBps: number };
export type JupInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
export type JupRouteLeg = { percent?: number; bps?: number; swapInfo: { ammKey: string; label?: string; inputMint: string; outputMint: string; inAmount?: string; outAmount?: string } };
export type JupBuild = {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string; swapMode?: string;
  slippageBps: number; priceImpactPct?: string | number | null; routePlan: JupRouteLeg[];
  computeBudgetInstructions?: JupInstruction[] | null; setupInstructions?: JupInstruction[] | null; swapInstruction: JupInstruction;
  cleanupInstruction?: JupInstruction | null; otherInstructions?: JupInstruction[] | null; tipInstruction?: JupInstruction | null;
  addressesByLookupTableAddress?: Record<string, string[]> | null;
};
export type UploadBody = { name: string; symbol: string; description: string; image: string; twitter: string; telegram: string; website: string };

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = "ApiError"; this.status = status; }
}

const BASE = "/api";

/// A read that failed to reach the API, or hit the tunnel while the API restarts (502/503/504), is
/// retried a few times over ~6 s before the page is told the API is down: a service restart takes
/// seconds, and a page that was open through one should recover on its own.
const RETRY_DELAYS_MS = [1_200, 2_200, 3_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const retriable = !init.method || init.method === "GET";
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce<T>(path, init, timeoutMs);
    } catch (e) {
      const transient = e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504);
      if (!retriable || !transient || init.signal || attempt >= RETRY_DELAYS_MS.length) throw e;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function requestOnce<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  // The caller's signal (search typeahead cancels stale queries) wins; otherwise a timeout
  // keeps a dead API from leaving skeletons on screen forever.
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, signal, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("The API is unreachable", 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body: handled below */ }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error || (res.status === 502 || res.status === 503 || res.status === 504 ? "The API is restarting, retrying…" : `Request failed (${res.status})`);
    throw new ApiError(msg, res.status);
  }
  if (json === null) throw new ApiError("Empty response", res.status);
  return json as T;
}

/// A caller's signal that also ends after `ms` (request() drops its own timeout when it is given a signal).
const withTimeout = (signal: AbortSignal, ms: number): AbortSignal =>
  typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function" ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : signal;

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/// `reason`: why a post not stored was not asked for ("busy", "budget", "limit", ...), when it was not.
export type PostFill = { id: string; state: "ok" | "none" | "wait" | "idle"; handle: string | null; text: string | null; reason?: string };
export const api = {
  stats: () => request<Stats>("/stats"),
  feed: (limit = 50, before?: number) => request<{ coins: Coin[] }>(`/feed${qs({ limit, before })}`),
  roots: (sort: RootSort = "locked", limit = 50, offset = 0) => request<{ roots: Coin[] }>(`/roots${qs({ sort, limit, offset })}`),
  /// `children: false` / `trades: false` ask the server to leave those lists empty (the map's side panel
  /// needs only the coin); the fields are always present. An older server ignores the flags.
  coin: (mint: string, opts?: { children?: boolean; trades?: boolean }) => request<CoinPage>(`/coin/${encodeURIComponent(mint)}${qs({ children: opts?.children === false ? 0 : undefined, trades: opts?.trades === false ? 0 : undefined })}`),
  tree: (mint: string, depth = 2) => request<TreeNode>(`/tree/${encodeURIComponent(mint)}${qs({ depth })}`),
  /// `scope: "all"` = every pump.fun pair the indexer knows (the map), not only Spore launches;
  /// `limit: "all"` = no root cap; `since` = only what changed after that `generatedAt` (§11.5).
  /// The full tree can be a few MB, so it gets a longer timeout than a card fetch.
  /// With `limit: "all"` the depth is left to the server (its program depth cap), so every client shares one cached build.
  map: ({ limit = 60, depth, scope = "ours", since }: MapQuery = {}) => request<MapResponse>(`/map${qs({ limit, depth: depth ?? (limit === "all" ? undefined : 2), scope: scope === "all" ? "all" : undefined, since })}`, {}, 60_000),
  /// One page of the coins quoted in `mint` (a listed asset or any tracked coin), biggest first (DESIGN-FAMILY-ALL §3a/§4).
  /// `v` pins the server's snapshot after page 0; the caller's signal cancels it, and 30 s ends it either way. `at` (a
  /// seek for one coin): a server that knows it answers that coin's row with `offset` = its index, one that does not
  /// answers the page at `offset` as usual (the caller scans it).
  mapFamily: (mint: string, q: { offset?: number; limit?: number; v?: number | null; at?: string }, signal?: AbortSignal) => request<MapFamilyResponse>(`/map/family/${encodeURIComponent(mint)}${qs({ offset: q.offset, limit: q.limit, v: q.v, at: q.at })}`, signal ? { signal: withTimeout(signal, 30_000) } : {}, 30_000),
  /// `scope: "all"` opens the candles of any tracked coin (the map's side panel); without it the route stays ours-only.
  candles: (mint: string, res = 60, scope?: "all", opts?: { history?: boolean }) =>
    request<Candles>(`/candles/${encodeURIComponent(mint)}${qs({ res, scope, history: opts?.history ? 1 : undefined })}`),
  /// The coin page's chart scrolled back: the page of `res` candles below `before` (unix s), in the series' key.
  candlesBefore: (mint: string, res: number, key: "usd" | "quote", before: number) =>
    request<CandlePage>(`/candles/${encodeURIComponent(mint)}${qs({ res, history: 1, before, key })}`),
  /// Trade activity per coin for the map (§11.5): 1 h and 24 h counters. 404 on a server that predates it.
  heat: () => request<HeatResponse>("/map/heat", {}, 15_000),
  /// Family shares of the whole map (§11.5 "Dominance"); `mint` narrows `families` to that top's row ([] when it is none).
  dominance: (mode: "locked" | "mcap", mint?: string) => request<DominanceResponse>(`/map/dominance${qs({ mode, mint })}`),
  /// Pending creator fees of one coin (§11.6); the server reads the chain and caches 15 s per mint.
  fees: (mint: string) => request<Fees>(`/fees/${encodeURIComponent(mint)}`),
  claimsFor: (wallet: string) => request<Claims>(`/claims/${encodeURIComponent(wallet)}`, {}, 30_000),
  claims: (limit = 50) => request<Claims>(`/claims${qs({ limit })}`, {}, 30_000),
  /// One wallet's holdings and launched coins; 400 on a bad address. The server reads the wallet's token accounts.
  /// `after`: a trade of the wallet landed at that slot, so the answer must be read at it or later (the server reads
  /// again instead of serving its 10 s cache); such a reload also skips the browser's cache. An older server ignores it.
  /// `fresh`: skip the browser's cache without `after` (its copy may be from before a trade, see Portfolio.tsx).
  portfolio: (wallet: string, after?: number, fresh = false) => {
    const a = after && after > 0 ? after : undefined;
    return request<Portfolio>(`/portfolio/${encodeURIComponent(wallet)}${qs({ after: a })}`, a || fresh ? { cache: "no-store" } : {}, 30_000);
  },
  /// What the wallet's trades made, per coin; `since` (unix s) windows the bought / sold / realized figures. The first
  /// request for a wallet starts the server's one-off read of its history. 429 when rate limited.
  pnl: (wallet: string, since?: number | null) => request<Pnl>(`/pnl/${encodeURIComponent(wallet)}${qs({ since })}`, {}, 20_000),
  /// The wallet's cumulative realized profit over time, for the chart; `since` as in `pnl`. 429 when rate limited.
  pnlSeries: (wallet: string, since?: number | null) => request<PnlSeries>(`/pnl/${encodeURIComponent(wallet)}/series${qs({ since })}`, {}, 20_000),
  /// The wallet's trades, newest first; `before` is the `next` cursor of the page above (or a unix time).
  activity: (wallet: string, q: { limit?: number; before?: string | number | null } = {}) => request<WalletActivity>(`/activity/${encodeURIComponent(wallet)}${qs({ limit: q.limit, before: q.before })}`, {}, 20_000),
  search: (q: string, signal?: AbortSignal) => request<{ coins: Coin[] }>(`/search${qs({ q })}`, { signal }),
  eligibility: (mint: string, creator?: string | null) => request<Eligibility>(`/eligibility/${encodeURIComponent(mint)}${qs({ creator })}`),
  /// The SOL pool: a root coin needs no parent, but the split and launch fee are still the server's.
  eligibilitySol: (creator?: string | null) => request<Eligibility>(`/eligibility/sol${qs({ creator })}`),
  upload: (body: UploadBody) => request<{ metadataUri: string }>("/upload", { method: "POST", body: JSON.stringify(body) }, 45_000),
  /// Tells the indexer a spawn just landed so the coin is listed as ours before its sharing config
  /// is verified on-chain (§11.1). The server may answer with any small JSON object. The signature
  /// is optional: a launch recovered from the chain (the wallet never returned one) is reported too.
  spawned: (mint: string, sig: string | null = null, agent: { id: string; model: string } | null = null) => request<unknown>("/spawned", { method: "POST", body: JSON.stringify({ mint, ...(sig ? { sig } : {}), ...(agent ? { agent } : {}) }) }, 10_000),
  /// Prepares the agent wallet of a root about to launch: the server makes a keypair, keeps its key
  /// and answers the public address that goes into the fee split; `spawned` with the id binds it to the mint.
  agentPrepare: (creator: string, model: string) => request<AgentPrepared>("/agents/prepare", { method: "POST", body: JSON.stringify({ creator, model }) }, 10_000),
  /// Root agents (§13.1): read-only. 404 on a server without agents (or for a root without one).
  agents: () => request<AgentList>("/agents"),
  agent: (root: string) => request<AgentDetail>(`/agents/${encodeURIComponent(root)}`),
  /// The agent side of one coin: its own agent (a root) or the agent that launched it (a child). A
  /// server without the route answers 404; the page then shows nothing.
  agentCoin: (mint: string) => request<AgentCoin>(`/agents/coin/${encodeURIComponent(mint)}`),
  /// The posts linked by a family's coins, as a timeline (see `Narrative`). 404 for a mint that is not a subject, and on a server
  /// without the route; the UI then shows nothing.
  narrative: (mint: string) => request<Narrative>(`/narrative/${encodeURIComponent(mint)}`),
  /// One X post by its link (server README §API GET /api/post-fill): its handle and text once stored, else "wait" (ask
  /// again) or "idle"; 404 when the server does not fetch post texts. Only x.com / twitter.com status links are taken.
  postFill: (url: string) => request<PostFill>(`/post-fill${qs({ url })}`),
  /// The families buying far above their normal level (see `Discover`); the server caches it 5 s.
  /// `tf` sets the timeframe of each coin row's numbers (the server's default is 5m and is left out of the URL).
  discover: (tf?: Tf) => request<Discover>(`/discover${qs({ tf })}`),
  /// One parent's wake-up, or its quiet "moving now" coins (see `DiscoverOne`); 404 for an unknown mint.
  discoverOf: (mint: string, tf?: Tf) => request<DiscoverOne>(`/discover/${encodeURIComponent(mint)}${qs({ tf })}`),
  /// The coins most wallets bought over the timeframe (see `Trending`); the server caches it 5 s.
  trending: (tf?: Tf) => request<Trending>(`/trending${qs({ tf })}`),
  /// The same coins grouped by story (see `Stories`); the server caches it 5 s.
  stories: (tf?: Tf) => request<Stories>(`/stories${qs({ tf })}`),
  /// One story's 5-minute series (a card's `key`; the colon of "n:<id>" is encoded).
  storySeries: (key: string, since?: number) => request<StorySeries>(`/story-series/${encodeURIComponent(key)}${qs({ since })}`),
  timeline: (from: number, to: number, min: number) => request<Timeline>(`/timeline${qs({ from, to, min })}`),
  /// Whether this server routes swaps through Jupiter (lib/jup.ts); 404 on a server without the route.
  jupStatus: () => request<{ enabled: boolean }>("/jup/status", {}, 10_000),
  /// Jupiter's /build for a swap between SOL and a tracked coin, asked by the server (it paces Jupiter's rate limit).
  /// Never retried here: a 502/503 is Jupiter's or the server's answer, not a restart, and the caller's quote timer
  /// asks again. The server may queue a few seconds behind other quotes, hence the longer timeout.
  jupBuild: (q: JupBuildQuery, signal?: AbortSignal) => request<JupBuild>(`/jup/build${qs(q)}`, { signal: signal ? withTimeout(signal, 30_000) : AbortSignal.timeout(30_000) }, 30_000),
  eventsUrl: `${BASE}/events`,
};

export const pumpUrl = (mint: string) => `https://pump.fun/coin/${mint}`;
export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}`;
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
/// Share intent for a freshly spawned coin (the text is what the user posts; nothing is auto-posted).
export const xShareUrl = (text: string, url: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
export const isApiDown = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504);
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
