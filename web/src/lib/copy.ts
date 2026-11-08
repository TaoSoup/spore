// Every sentence about fees, agents and what Spore is comes from here (redesign 2026-10-20), so
// the Home hero, the footer, the launch form and the agent pages can never disagree again. The
// percentages are derived from lib/policy.ts (the split the launch actually signs), not typed.
import { AGENT_SEED_LAMPORTS, ROOT_SPLIT, SPLIT_BPS, SPORE_COIN } from "./policy";

/// pump.fun's creator fee on a graduated coin, in % of volume (DESIGN §13.1). A ROOT's split turns
/// it into "% of every trade": 2632 / 5263 / 2105 bps of 0.95 % = 0.25 % / 0.50 % / 0.20 %.
export const PUMP_CREATOR_FEE_PCT = 0.95;
const ofTrade = (bps: number) => `${((bps / 10_000) * PUMP_CREATOR_FEE_PCT).toFixed(2)}%`;
const ofFee = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/// A root's creator fee as a share of every trade.
export const ROOT_PCT = { creator: ofTrade(ROOT_SPLIT.creator), spore: ofTrade(ROOT_SPLIT.platform), agent: ofTrade(ROOT_SPLIT.agent) } as const;
/// The same split as a share of the creator fee itself (what the on-chain config stores).
export const ROOT_FEE_SHARE = { creator: ofFee(ROOT_SPLIT.creator), spore: ofFee(ROOT_SPLIT.platform), agent: ofFee(ROOT_SPLIT.agent) } as const;
/// A child's creator fee: creator and Spore halves of the fee, paid in the parent coin.
export const CHILD_PCT = { creator: ofFee(SPLIT_BPS[0]), spore: ofFee(SPLIT_BPS[3]) } as const;

/// "you 0.25% · Spore 0.50% · your coin's agent 0.20% of every trade" (the launching creator's view).
export const ROOT_SPLIT_YOU = `you ${ROOT_PCT.creator} · Spore ${ROOT_PCT.spore} · your coin's agent ${ROOT_PCT.agent} of every trade once graduated (pump pays 0.30% on the curve, 0.95% after)`;
/// "creator 0.25% · Spore 0.50% · the root's agent 0.20% of every trade" (anyone's view).
export const ROOT_SPLIT_LINE = `creator ${ROOT_PCT.creator} · Spore ${ROOT_PCT.spore} · the root's agent ${ROOT_PCT.agent} of every trade once graduated (0.30% tier on the curve)`;
/// "creator 50% · Spore 50%, paid in the parent coin".
export const CHILD_SPLIT_LINE = `creator ${CHILD_PCT.creator} · Spore ${CHILD_PCT.spore}, paid in the parent coin`;
/// "you 50% · Spore 50%, paid in the parent coin".
export const CHILD_SPLIT_YOU = `you ${CHILD_PCT.creator} · Spore ${CHILD_PCT.spore}, paid in the parent coin`;
/// Compact tile value and its caption: "0.25 / 0.50 / 0.20" · "root: you / Spore / agent · child: 50 / 50" is NOT used
/// (the "50 / 50" spelling is banned by test/copy.test.mts); use ROOT_TILE + CHILD_SPLIT_LINE instead.
export const ROOT_TILE = `${ROOT_PCT.creator.replace("%", "")} / ${ROOT_PCT.spore.replace("%", "")} / ${ROOT_PCT.agent.replace("%", "")}`;

export const SPORE_BUYBACK = "Spore's share buys $SPORE and locks it.";
export const NO_LAUNCH_FEE = "No launch fee, only network rent.";
/// DESIGN §11.2: mint + curve + fee-sharing config + vault ≈ 0.025 SOL. An estimate; always shown with "~".
export const NETWORK_RENT_SOL = 0.025;
export const AGENT_SEED_SOL = Number(AGENT_SEED_LAMPORTS) / 1e9;

/// Live agents launch on every third one-minute tick (server lib/agents-live/live.mjs).
export const AGENT_CADENCE_MIN = 3;
export const AGENT_CADENCE = `every ${AGENT_CADENCE_MIN} minutes`;
/// OWNER TO CONFIRM before deploy: the server pays agent surplus to AGENT_PAYOUT_ADDRESS (one wallet,
/// its activity titles say "to the owner"); the brief says "to the creator". Change it here only.
export const AGENT_PAYOUT_TO = "the creator";
/// One sentence, used wherever an agent is introduced.
export const AGENT_LINE = `Every root launched on Spore gets a live AI agent with its own wallet. It claims its fees, launches a new coin under its root ${AGENT_CADENCE}, pays its own AI bill and sends its surplus to ${AGENT_PAYOUT_TO}.`;
/// The same, as a clause after "Its agent …" / "The agent …".
export const AGENT_DOES = `claims its fees, launches a new coin under its root ${AGENT_CADENCE}, pays its AI bill and sends its surplus to ${AGENT_PAYOUT_TO}`;

/// What Spore is, in one sentence (the Home hero and the coin page's "New to Spore?" strip).
export const WHAT_IS_SPORE = "Launch a pump.fun coin and let new coins grow under it: every buy of a child buys its parent and locks it.";
export const WHAT_IS_SPORE_SUB = `Every root gets a live AI agent that launches a new coin under it ${AGENT_CADENCE}. ${NO_LAUNCH_FEE}`;
export const LISTS_SCOPE = "Lists show coins launched on Spore; the map shows every pump.fun pair.";
export const MAP_SCOPE = "The map shows the whole pump.fun pair ecosystem, not only Spore coins.";
export const TRUST_POINTS = ["No launch fee", "You sign every transaction", "Fee split locked on-chain at launch"] as const;
export const NON_CUSTODIAL = "Nothing custodial: every transaction is built in your browser and signed by your wallet.";

export const OFFICIAL_CA = SPORE_COIN;
export const OFFICIAL_NOTE = `Spore's share of every creator fee (${ROOT_PCT.spore} of root trades, half of child fees) is collected, swapped into $SPORE and locked.`;

/// Footer and meta copy (index.html cannot import this; test/copy.test.mts checks it agrees).
export const FOOTER_ABOUT = `A pump.fun launchpad for coin family trees. Launch a root with SOL; coins grow under it. Root fee: ${ROOT_SPLIT_LINE}. Child fee: ${CHILD_SPLIT_LINE}. ${SPORE_BUYBACK} ${LISTS_SCOPE}`;
export const FOOTER_BOTTOM = "no launch fee · Spore earns only its share of creator fees · no keys, no funds, no promises";
export const META_DESCRIPTION = "Spore is a pump.fun launchpad for coin family trees. Launch a root with SOL and it gets its own live AI agent; launch coins under any coin. No launch fee, only network rent. Nothing custodial.";

/// Phrases that contradict the facts above. test/copy.test.mts fails when one appears in web/src
/// (.tsx/.ts, except this file, lib/pump/** and the map) or in index.html.
export const BANNED_PHRASES = [
  "half the fees", "keep half", "fee when a coin is launched", "every few minutes", "0.02 SOL per launch",
  "half of creator fees is all", "Spore's half", "its half of", "half of its creator fee", "50/50", "50 / 50",
  "Only coins launched here are listed",
] as const;
