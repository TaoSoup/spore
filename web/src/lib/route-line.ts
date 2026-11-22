// The route of a trade as the ticket and the coin page's trade card show it: SOL → (the listed asset whose SOL pool the
// route starts in) → the root → … → the coin on a buy, the reverse on a sell; on the Jupiter route the mints of its
// last quote (unknown before one: SOL → the coin's quote asset → the coin). Pure: shared by components/TradeWidget.tsx
// and components/coin/TradeCard.tsx so the two never say different things.
import { KNOWN_MINTS, SOL_MINT, jupPath, type JupLeg } from "./jup";
import { short } from "./format";
import { assetLabel, type TradeRoute } from "./trade-route";

export type RouteItem = { key: string; label: string; image: string | null; symbol: string | null };
type CoinLike = { mint: string; symbol: string | null; image: string | null; quoteMint: string | null; quoteSymbol: string | null };
/// The ticker as the pages show it (components/Bits.tsx sym): "$SYM", or the short mint.
const tick = (c: { symbol: string | null; mint: string }) => (c.symbol ? `$${c.symbol}` : short(c.mint));

/// `jupLegs`: the legs of the last Jupiter quote of this side (null before one, or on the pump route).
export function routeItems(route: Pick<TradeRoute, "coins" | "asset" | "via"> | null | undefined, coin: CoinLike, side: "buy" | "sell", jupLegs: Pick<JupLeg, "inputMint" | "outputMint">[] | null = null): RouteItem[] {
  if (!route) return [];
  const isJup = route.via === "jupiter";
  const mintLabel = (m: string) => (m === SOL_MINT ? "SOL" : m === coin.mint ? tick(coin) : m === coin.quoteMint ? assetLabel(coin.quoteSymbol) : KNOWN_MINTS[m] ?? `${m.slice(0, 4)}…`);
  let path: RouteItem[];
  if (isJup) {
    const mints = jupLegs ? (side === "sell" ? jupPath(jupLegs).reverse() : jupPath(jupLegs)) : [SOL_MINT, ...(coin.quoteMint ? [coin.quoteMint] : []), coin.mint];
    path = mints.map((m) => (m === SOL_MINT ? { key: "quote", label: "SOL", image: null, symbol: null } : { key: m, label: mintLabel(m), image: m === coin.mint ? coin.image : null, symbol: m === coin.mint ? coin.symbol : mintLabel(m).replace(/^\$/, "") }));
  } else {
    const asset = route.asset;
    path = [{ key: "quote", label: "SOL", image: null, symbol: null },
      ...(asset ? [{ key: asset.mint, label: assetLabel(asset.symbol), image: null, symbol: asset.symbol }] : []),
      ...[...route.coins].reverse().map((c) => ({ key: c.mint, label: tick(c), image: c.image, symbol: c.symbol }))];
  }
  if (side === "sell") path.reverse();
  return path;
}

/// "SOL → $ROOT → $SYM" and "1 hop" / "3 hops" / "Jupiter": the one-line route of the compact ticket and the card.
export function routeLine(route: (Pick<TradeRoute, "coins" | "asset" | "via"> & { chain: readonly unknown[] }) | null | undefined, coin: CoinLike, side: "buy" | "sell", jupLegs: Pick<JupLeg, "inputMint" | "outputMint">[] | null = null): { path: string; hops: string } | null {
  if (!route) return null;
  const hops = route.chain.length;
  return { path: routeItems(route, coin, side, jupLegs).map((p) => p.label).join(" → "), hops: route.via === "jupiter" ? "Jupiter" : hops <= 1 ? "1 hop" : `${hops} hops` };
}
