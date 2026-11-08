// Spore's published launch policy, pinned in the bundle. The API also states it (/api/eligibility),
// but nothing the server says is allowed to move money: the fee split and the launch fee are
// derived here and the server's copy only has to agree, otherwise the launch refuses to build.
// Pre-deploy security review 2026-10-18, finding #1.
import { PublicKey } from "@solana/web3.js";

/// The platform wallet: fee-split shareholder and launch-fee recipient (DESIGN §11).
export const PLATFORM_WALLET = new PublicKey("FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5");
/// The most the launch transaction may transfer to the platform (0.02 SOL). The server may lower it.
export const MAX_LAUNCH_FEE_LAMPORTS = 20_000_000n;
/// Creator fee split of a CHILD coin in bps: child creator, parent creator, grandparent creator, platform.
export const SPLIT_BPS = [5000, 0, 0, 5000] as const;

/// Creator fee split of a ROOT coin (owner 2026-10-19): pump's creator fee (0.95 % of volume on the
/// AMM, 0.30 % on the curve) goes creator 0.25 % / Spore 0.50 % / the root's agent wallet 0.20 %, i.e.
/// 2632 / 5263 / 2105 bps of whatever accrues. The agent wallet is created by Spore's server for this
/// launch (its key stays on the server); the client pins the bps and refuses any other split.
export const ROOT_SPLIT = { creator: 2632, platform: 5263, agent: 2105 } as const;
/// What a root launch hands its agent wallet inside the same signature (0.01 SOL): the gas the agent
/// needs to claim its first fees, since it is born with nothing. Never more than this.
export const AGENT_SEED_LAMPORTS = 10_000_000n;

/// The language models a root's agent may think with (the creator picks one at launch; the server
/// calls the provider with Spore's key and books the cost per agent).
export const AGENT_MODELS = [
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", note: "fast, ~$0.01 per idea" },
  { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", note: "strongest, ~$0.05 per idea" },
] as const;
export type AgentModelId = (typeof AGENT_MODELS)[number]["id"];
export const DEFAULT_AGENT_MODEL: AgentModelId = "anthropic/claude-sonnet-5.5";
export const isAgentModel = (s: unknown): s is AgentModelId => AGENT_MODELS.some((m) => m.id === s);

export class PolicyError extends Error {
  constructor(message: string) { super(message); this.name = "PolicyError"; }
}

/// The platform coin ($SPORE, launched by the owner on Spore 2026-10-19): the platform's fee share buys and locks it.
export const SPORE_COIN = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
