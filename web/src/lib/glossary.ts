// Plain-word explanations of pump.fun and Spore terms, shown by <Term> on hover, focus and tap.
// Facts only, no numbers that are not pinned in lib/policy.ts (via lib/copy.ts) or passed in live.
import { AGENT_DOES, CHILD_SPLIT_LINE, ROOT_SPLIT_LINE } from "./copy";

export type TermKey =
  | "root" | "child" | "depth" | "locked" | "curve" | "graduated" | "creatorFee" | "agent" | "mcap"
  | "claim" | "payout" | "subscript" | "mapAll" | "quote" | "slippage" | "impact" | "byAgent" | "volume" | "dominance";

export type TermVars = { maxDepth?: number | null; symbol?: string | null; root?: string | null };

const GLOSSARY: Record<TermKey, { label: string; body: (v: TermVars) => string }> = {
  root: { label: "root", body: () => "The first coin of a tree. Most pump.fun coins are priced in SOL; some are priced in a listed asset (PUMP, USDC, a tokenized stock…) and sit under it on the map. Other coins can launch under a root." },
  child: { label: "child", body: () => "A coin launched under another coin. It is priced in its parent; when the tree reaches SOL, Spore swaps SOL → parent → child for you in one transaction." },
  depth: {
    label: "depth",
    body: (v) => `How far a coin sits from its root: d0 is the root, d1 its child, d2 a grandchild.${v.maxDepth != null ? ` pump.fun allows ${v.maxDepth} levels under a root today.` : ""}`,
  },
  locked: { label: "locked", body: () => "Parent coins held inside this coin's children's curves. Every buy of a child buys the parent and parks it there; when the child graduates it stays locked in the child's pool." },
  curve: { label: "bonding curve", body: () => "New pump.fun coins trade on a bonding curve: the price rises as people buy. When the curve fills, the coin graduates." },
  graduated: { label: "graduated", body: () => "Its bonding curve filled up, so it now trades in a PumpSwap pool, like any pump.fun coin that completes." },
  creatorFee: {
    label: "creator fee",
    body: () => `The cut of every trade pump.fun pays to a coin's creator wallets. Spore writes the split on-chain at launch and it can never change. A root: ${ROOT_SPLIT_LINE}. A child: ${CHILD_SPLIT_LINE}.`,
  },
  agent: { label: "AI agent", body: () => `Every root launched on Spore gets an AI agent with its own wallet. It ${AGENT_DOES}.` },
  byAgent: { label: "launched by an agent", body: (v) => `Named, drawn and launched by ${v.root ? `${v.root}'s` : "a root's"} AI agent from its own wallet.` },
  mcap: { label: "market cap", body: () => "Market cap: price × total supply, in dollars." },
  volume: { label: "24h volume", body: () => "The dollar value of every trade of this coin in the last 24 hours." },
  claim: { label: "claim", body: () => "Creator fees wait in pump.fun vaults until someone pays them out. Anyone can trigger it; the program pays every shareholder, never the person who pressed the button." },
  payout: { label: "pay out", body: () => "Sends the waiting fees to this coin's shareholders. You pay only the network fee." },
  subscript: { label: "small digit", body: () => "The small digit counts the zeros after the point: $0.0₄293 = $0.0000293." },
  mapAll: { label: "the map", body: () => "The map shows every pump.fun coin pair, not only Spore launches; Spore launches have a lime ring." },
  dominance: { label: "dominance", body: () => "A family's share of the whole map: what its root and every pair under it are worth, over the same sum for every family on the map. In locked value (how the map sizes its bubbles; a coin that locks nothing counts a small slice of its market cap) and in market cap." },
  quote: { label: "priced in", body: () => "The currency a coin is priced in: SOL or a listed asset (PUMP, USDC, a tokenized stock…) for a root, the parent coin for a child." },
  slippage: { label: "slippage", body: () => "The most the fill may fall below the quote before the trade cancels." },
  impact: { label: "price impact", body: () => "How far the simulated fill lands from the current price, pump.fun fees included." },
};

export const termLabel = (k: TermKey) => GLOSSARY[k].label;
export const termText = (k: TermKey, vars: TermVars = {}) => GLOSSARY[k].body(vars);
export const TERM_KEYS = Object.keys(GLOSSARY) as TermKey[];
