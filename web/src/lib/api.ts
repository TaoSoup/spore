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
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Candles = { candles: Candle[]; priceKey: "usd" | "quote" };
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
export type RootSort = "locked" | "children" | "new" | "volume";
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
  candles: (mint: string, res = 60, scope?: "all") => request<Candles>(`/candles/${encodeURIComponent(mint)}${qs({ res, scope })}`),
  /// Trade activity per coin for the map (§11.5): 1 h and 24 h counters. 404 on a server that predates it.
  heat: () => request<HeatResponse>("/map/heat", {}, 15_000),
  /// Family shares of the whole map (§11.5 "Dominance"); `mint` narrows `families` to that top's row ([] when it is none).
  dominance: (mode: "locked" | "mcap", mint?: string) => request<DominanceResponse>(`/map/dominance${qs({ mode, mint })}`),
  /// Pending creator fees of one coin (§11.6); the server reads the chain and caches 15 s per mint.
  fees: (mint: string) => request<Fees>(`/fees/${encodeURIComponent(mint)}`),
  claimsFor: (wallet: string) => request<Claims>(`/claims/${encodeURIComponent(wallet)}`, {}, 30_000),
  claims: (limit = 50) => request<Claims>(`/claims${qs({ limit })}`, {}, 30_000),
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
  eventsUrl: `${BASE}/events`,
};

export const pumpUrl = (mint: string) => `https://pump.fun/coin/${mint}`;
export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}`;
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
/// Share intent for a freshly spawned coin (the text is what the user posts; nothing is auto-posted).
export const xShareUrl = (text: string, url: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
export const isApiDown = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504);
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
