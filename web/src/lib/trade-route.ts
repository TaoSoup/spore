// Whether a coin can be bought or sold from a SOL wallet in one multi_hop_swap, and the route if so. Shared by the
// trade widget (coin page, phone sheet, the map's quick trade) and the buttons that open it, so a button never leads
// to a dead end and every surface gives the same reason.
//
// A coin's chain (self first, up to its depth-0 root) is tradable from SOL when the root is quoted in SOL, or when the
// root is quoted in a listed asset that is itself a graduated pump coin with its canonical PumpSwap pool against WSOL
// (ANSEM, LMAO!, CATE…: 37 such assets on the local index, Nov 13 2026): the route then starts in that pool. A root
// quoted in PUMP, USDC, HYPE or a tokenized stock has no pump venue against SOL, so pump's program cannot start there.
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { canonicalPumpPoolPdaWithQuote } from "@pump-fun/pump-sdk";
import { api, type Coin } from "./api";
import { useAsync } from "./hooks";
import { withSolPool, type Chain, type SolPoolAsset } from "./pump/route";

/// The most links one multi_hop_swap transaction holds: with Spore's lookup table (pump/alt.ts) a 5-hop buy compiles to
/// ~1,170-1,224 bytes and a 6-hop one overflows 1,232 (measured Nov 13 2026). The program's own depth cap (5 levels: 6
/// coins) is looser; today's chains are at most 3 coins, 4 links with an asset's SOL pool.
export const MAX_ROUTE_LINKS = 5;
const WSOL = NATIVE_MINT.toBase58();
const SPL_TOKEN = TOKEN_PROGRAM_ID.toBase58();
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export type RouteAsset = SolPoolAsset & { symbol: string };
/// Why a coin cannot be traded here. `pending` is the one that passes by itself (a coin on the chain filled its curve
/// and waits for its PumpSwap pool); the others hold until the chain changes.
export type TradeBlock =
  | { kind: "listed"; asset: string; symbol: string }
  | { kind: "mayhem"; coin: Coin }
  | { kind: "gap" }
  | { kind: "deep"; links: number }
  | { kind: "pending"; coin: Coin };
export type TradeRoute = {
  /// Self first; with `via: "pool"` the asset's SOL pool is the last link.
  chain: Chain;
  /// The coin and its ancestors' full records, self first (the asset is not one of them).
  coins: Coin[];
  via: "sol" | "pool";
  asset: RouteAsset | null;
  block: TradeBlock | null;
};

/// The quote symbol as a ticker: "$HYPE"; a short mint ("H74C…") or a missing one stays as it is.
export const assetLabel = (s: string | null | undefined) => (!s ? "its listed asset" : s.includes("…") ? s : `$${s}`);
const tick = (c: { symbol: string | null; mint: string }) => (c.symbol ? `$${c.symbol}` : `${c.mint.slice(0, 4)}…`);

/// The route from the coin's records and, when its root is quoted in a listed asset, that asset's SOL pool (null:
/// none). Pure: the loaders below fetch what it reads.
export function routeOf(coins: Coin[], asset: RouteAsset | null): TradeRoute {
  let chain: Chain = coins.map((c, i) => ({ mint: c.mint, quoteMint: c.quoteMint, tokenProgram: c.tokenProgram, quoteTokenProgram: coins[i + 1]?.tokenProgram ?? SPL_TOKEN, migrated: c.migrated, depth: c.depth }));
  const top = coins[coins.length - 1];
  const out = (block: TradeBlock | null, via: TradeRoute["via"] = "sol", a: RouteAsset | null = null): TradeRoute => ({ chain, coins, via, asset: a, block });
  if (!top || top.depth !== 0) return out({ kind: "gap" });
  const solRoot = top.quoteMint === null || top.quoteMint === WSOL;
  let via: TradeRoute["via"] = "sol", used: RouteAsset | null = null;
  if (!solRoot) {
    if (!asset || asset.mint !== top.quoteMint) return out({ kind: "listed", asset: top.quoteMint!, symbol: top.quoteSymbol });
    chain = withSolPool(chain, asset); via = "pool"; used = asset;
  }
  const mayhem = coins.find((c) => c.mayhem);
  if (mayhem) return out({ kind: "mayhem", coin: mayhem }, via, used);
  if (chain.length > MAX_ROUTE_LINKS) return out({ kind: "deep", links: chain.length }, via, used);
  const pending = coins.find((c) => c.complete && !c.migrated);
  return out(pending ? { kind: "pending", coin: pending } : null, via, used);
}

/// What the user reads about a block: a short title and one or two sentences (no link: the caller adds pump.fun's).
export function blockText(b: TradeBlock, self: { symbol: string | null; mint: string }): { title: string; body: string; short: string } {
  switch (b.kind) {
    case "listed": {
      const a = assetLabel(b.symbol);
      return { title: `Priced in ${a}`, short: `priced in ${a}`, body: `This coin's tree is priced in ${a}, a listed asset with no pump.fun pool against SOL, so pump's multi-hop swap cannot start from a SOL wallet. Trade it on pump.fun.` };
    }
    case "mayhem": {
      const who = b.coin.mint === self.mint ? `${tick(self)} is` : `${tick(b.coin)}, on this coin's chain, is`;
      return { title: "Mayhem-mode coin", short: "a mayhem-mode coin", body: `${who} a mayhem-mode coin, which pump's multi-hop swap cannot route. Trade it on pump.fun.` };
    }
    case "gap":
      return { title: "Route not known yet", short: "route not known yet", body: "Spore does not hold every coin above this one yet, so it cannot build the route. Trade it on pump.fun." };
    case "deep":
      return { title: "Route too deep", short: "route too deep", body: `The route has ${b.links} links, more than pump's multi-hop swap takes in one transaction. Trade it on pump.fun.` };
    case "pending":
      return { title: `${tick(b.coin)} is awaiting migration`, short: `${tick(b.coin)} awaiting migration`, body: `${b.coin.mint === self.mint ? "This coin" : "A coin on this chain"} filled its curve and is moving to a PumpSwap pool; pump blocks trades through it until the migration lands (usually minutes). Spore checks again every 20 seconds.` };
  }
}

// ---- loaders (module caches shared by every widget and button on the page)

/// Ancestor records for routes, one light request per ancestor a minute, not one per opening. Migration state can
/// change, so the cache is short; `forgetCoin` drops one (a pending coin being re-checked).
const coinCache = new Map<string, { at: number; p: Promise<Coin> }>();
const COIN_TTL_MS = 60_000;
function coinCached(mint: string): Promise<Coin> {
  const hit = coinCache.get(mint);
  if (hit && Date.now() - hit.at < COIN_TTL_MS) return hit.p;
  const p = api.coin(mint, { children: false, trades: false }).then((r) => r.coin);
  coinCache.set(mint, { at: Date.now(), p });
  p.catch(() => { if (coinCache.get(mint)?.p === p) coinCache.delete(mint); });
  return p;
}
export const forgetCoin = (mint: string) => { coinCache.delete(mint); };

/// A listed asset's SOL pool, or null: its canonical pump pool against WSOL exists, is pump-amm's, holds the asset as
/// base and WSOL as quote, and is not mayhem-mode (multi_hop_swap refuses mayhem venues anywhere: pump-amm 6080). A
/// cashback flag does not matter here: the swap refuses cashback only on the leg that pays the creator fee, the coin
/// bought, and the asset's pool is a middle hop.
/// One getMultipleAccounts (the pool and the asset's mint, whose owner is its token program), cached 10 min.
const POOL_TTL_MS = 10 * 60_000;
const poolCache = new Map<string, { at: number; p: Promise<SolPoolAsset | null> }>();
export function resolveAssetPool(conn: Connection, assetMint: string): Promise<SolPoolAsset | null> {
  const hit = poolCache.get(assetMint);
  if (hit && Date.now() - hit.at < POOL_TTL_MS) return hit.p;
  const p = (async () => {
    const mint = new PublicKey(assetMint);
    const pool = canonicalPumpPoolPdaWithQuote(mint, NATIVE_MINT);
    const [pa, ma] = await conn.getMultipleAccountsInfo([pool, mint], "confirmed");
    return assetPoolFrom(assetMint, pa, ma);
  })();
  poolCache.set(assetMint, { at: Date.now(), p });
  p.catch(() => { if (poolCache.get(assetMint)?.p === p) poolCache.delete(assetMint); });
  return p;
}

type AccountLike = { owner: PublicKey; data: Uint8Array } | null;
/// pump-amm Pool: discriminator 8, bump 1, index 2, creator 32, base_mint at 43, quote_mint at 75, …, is_mayhem_mode
/// at 243 (server/lib/decode.mjs decodePool documents the same layout).
export function assetPoolFrom(assetMint: string, pool: AccountLike, mint: AccountLike): SolPoolAsset | null {
  if (!pool || !mint || pool.owner.toBase58() !== PUMP_AMM) return null;
  const d = pool.data;
  if (d.length < 107) return null;
  const key = (o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
  if (key(43) !== assetMint || key(75) !== WSOL) return null;
  if (d.length > 243 && d[243] === 1) return null;
  return { mint: assetMint, tokenProgram: mint.owner.toBase58() };
}

/// The coin's route: its ancestors' records (cached), a fresh record of a coin waiting for its migration and a recent
/// one of any coin still on its curve (it may have completed or migrated since the caller's record: the hop's venue
/// follows), and the asset's SOL pool when the root is quoted in a listed asset.
export async function loadTradeRoute(conn: Connection, coin: Coin): Promise<TradeRoute> {
  const self = coin.complete && !coin.migrated ? await api.coin(coin.mint, { children: false, trades: false }).then((r) => r.coin).catch(() => coin)
    : !coin.migrated ? await coinCached(coin.mint).then((c) => (c.updatedAt >= coin.updatedAt ? c : coin)).catch(() => coin)
    : coin;
  const ancestors = await Promise.all(coin.ancestors.map((a) => coinCached(a.mint)));
  const coins = [self, ...ancestors];
  const top = coins[coins.length - 1];
  let asset: RouteAsset | null = null;
  if (top.depth === 0 && top.quoteMint && top.quoteMint !== WSOL) {
    const pool = await resolveAssetPool(conn, top.quoteMint);
    if (pool) asset = { ...pool, symbol: top.quoteSymbol };
  }
  return routeOf(coins, asset);
}

/// The route of `coin` (null while it loads or without a coin), keyed by mint: `reload` re-checks it.
export function useTradeRoute(coin: Coin | null) {
  const { connection } = useConnection();
  return useAsync<TradeRoute | null>(() => (coin ? loadTradeRoute(connection, coin) : Promise.resolve(null)), [coin?.mint ?? null]);
}

/// A block a button should honour: every one but `pending`, which the widget explains and re-checks itself.
export const hardBlock = (r: TradeRoute | null | undefined): TradeBlock | null => (r?.block && r.block.kind !== "pending" ? r.block : null);
