// The map's node record: what every bubble is drawn from, and what the client cache stores per mint.
// Flat (parent by mint) so a tree, a delta list and a live event all become the same thing.
export type BubbleNode = {
  mint: string; parentMint: string | null; depth: number;
  name: string | null; symbol: string | null; image: string | null;
  mcapUsd: number | null; lockedUsd: number | null; children: number; descendants?: number; migrated: boolean;
  ours?: boolean; createdAt?: number | null; updatedAt?: number;
  /// A listed quote asset drawn as a family top (USDC, PUMP, CARDS, a tokenized stock): its own market cap
  /// never counts in "mcap" mode, its family weighs the sum of its members.
  asset?: boolean;
  /// The server's liquidity cap (LIQ_X × the quote liquidity behind the price), sent only when the market
  /// cap exceeds it; "mcap" mode sizes the coin by it instead of mcapUsd. Null/absent = uncapped.
  mcapCapUsd?: number | null;
  /// Last layout position (world units), restored from the cache so a warm open paints without settling.
  x?: number; y?: number;
};
export type SizeMode = "locked" | "mcap";
export type RootsLimit = "all" | 200 | 60;
