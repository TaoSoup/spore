// A coin's quote chain, as the API describes it (self first, down to the depth-0 root), turned
// into the hop list pump-amm's multi_hop_swap takes. Only chains that bottom out in SOL can be
// traded from a SOL wallet: a root quoted in USDC or a tokenized stock would need that asset.
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { MultiHopHop } from "@pump-fun/pump-sdk";

export type ChainLink = { mint: string; quoteMint: string | null; tokenProgram: string; quoteTokenProgram: string; migrated: boolean; depth: number };
export type Chain = ChainLink[];
export type Side = "buy" | "sell";

const WSOL = NATIVE_MINT.toBase58();
export const isSolRooted = (chain: Chain) => chain.length > 0 && chain[chain.length - 1].depth === 0 && (chain[chain.length - 1].quoteMint === null || chain[chain.length - 1].quoteMint === WSOL);

/// A listed quote asset that is a graduated pump coin itself, with its canonical PumpSwap pool against WSOL
/// (ANSEM, LMAO!, CATE…: lib/trade-route resolveAssetPool). multi_hop_swap can start from SOL in that pool.
export type SolPoolAsset = { mint: string; tokenProgram: string };

/// `chain` (self first) ends at a depth-0 coin quoted in `asset`: the same chain with the asset's SOL pool as its
/// last link, so a buy goes SOL → asset pool → root → … → coin in one multi_hop_swap (and a sell back the same way).
/// The root's quote side takes the asset's real token program (Token-2022 for most pump coins), not the SPL default.
export function withSolPool(chain: Chain, asset: SolPoolAsset): Chain {
  const top = chain[chain.length - 1];
  if (!top || top.depth !== 0 || top.quoteMint !== asset.mint) throw new Error("route: the chain does not end in that asset");
  return [
    ...chain.slice(0, -1),
    { ...top, quoteTokenProgram: asset.tokenProgram },
    { mint: asset.mint, quoteMint: null, tokenProgram: asset.tokenProgram, quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(), migrated: true, depth: 0 },
  ];
}

/// Buy routes walk from the SOL-quoted root up to the coin (each hop buys a coin quoted in the
/// previous hop's coin); sell routes walk down. pump-amm refuses mixed directions, so the whole
/// list is one or the other.
export function hopsFor(chain: Chain, side: Side): MultiHopHop[] {
  if (chain.length === 0) throw new Error("route: empty chain");
  if (chain.length > 6) throw new Error("route: chain deeper than the program allows");
  if (!isSolRooted(chain)) throw new Error("This coin's tree does not reach SOL, so it cannot be traded from a SOL wallet here. Trade it on pump.fun.");
  const hops: MultiHopHop[] = chain.map((l) => ({
    venue: l.migrated ? "pool" : "curve",
    baseMint: new PublicKey(l.mint),
    quoteMint: l.quoteMint ? new PublicKey(l.quoteMint) : NATIVE_MINT,
    baseTokenProgram: new PublicKey(l.tokenProgram),
    quoteTokenProgram: l.quoteMint ? new PublicKey(l.quoteTokenProgram) : TOKEN_PROGRAM_ID,
  }));
  // `chain` is self-first; a buy starts at the root.
  return side === "buy" ? hops.reverse() : hops;
}
