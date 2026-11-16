// What a coin's pool is priced in when that is not SOL: the parent, or a root's listed quote.
import type { Coin } from "./api";

const STABLES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);

export type ParentRef = { mint: string; symbol: string | null; image: string | null };
/// The token the coin's pool is quoted in, when it is not SOL: the parent (a child), or a listed asset (a root).
/// Nothing for a dollar stablecoin either: its price says nothing.
export function parentOf(coin: Pick<Coin, "parent" | "quoteMint" | "quoteSymbol">): ParentRef | null {
  if (coin.parent) return { mint: coin.parent.mint, symbol: coin.parent.symbol ?? coin.quoteSymbol, image: coin.parent.image };
  if (coin.quoteMint && !STABLES.has(coin.quoteMint)) return { mint: coin.quoteMint, symbol: coin.quoteSymbol || null, image: null };
  return null;
}
