// Who a fee-split wallet is, in words, the same way on every surface (coin-page fee card, claim
// confirm dialogs, the launch split preview, the agent's fee rule). Before this, a root's agent
// wallet read "creator" in one card and "shareholder" in the next.
import { PLATFORM_WALLET } from "./policy";

export type FeeRoleTone = "you" | "agent" | "spore" | "creator" | "other";
export type FeeRoleCtx = {
  /// the connected wallet
  me?: string | null;
  /// the coin's agent wallet (a root with an agent) or the agent that launched it (a child)
  agent?: string | null;
  /// "$SPREAD" → "$SPREAD's agent"
  agentOf?: string | null;
  /// "root": the agent holds the root's 0.20 % slice; "child": the agent launched the coin, so it is also its creator
  agentRole?: "root" | "child" | null;
  /// a known creator wallet (the launch form's creator; a coin page usually does not know it)
  creator?: string | null;
  /// a Spore launch (coin.ours): its split is creator + Spore (+ the root agent), so any wallet that is
  /// neither Spore nor the agent is the creator, even when the curve creator is a fee-config PDA
  inferCreator?: boolean;
};

const PLATFORM = PLATFORM_WALLET.toBase58();

export function feeRole(address: string, ctx: FeeRoleCtx = {}): { label: string; tone: FeeRoleTone } {
  const roles: string[] = [];
  let tone: FeeRoleTone = "other";
  const isAgent = !!ctx.agent && address === ctx.agent;
  if (isAgent) { roles.push(ctx.agentOf ? `${ctx.agentOf}'s agent` : "the root's agent"); tone = "agent"; }
  if (address === PLATFORM) { roles.push("Spore"); if (tone === "other") tone = "spore"; }
  const creator = (ctx.creator && address === ctx.creator) || (isAgent && ctx.agentRole === "child") || (!isAgent && address !== PLATFORM && !!ctx.inferCreator && !ctx.creator);
  if (creator) { roles.push("creator"); if (tone === "other") tone = "creator"; }
  if (ctx.me && address === ctx.me) { roles.unshift("you"); tone = "you"; }
  return { label: roles.length ? roles.join(" · ") : "shareholder", tone };
}

/// One short line under a role, where there is room: what that wallet does with the money.
export const feeRoleNote = (tone: FeeRoleTone): string | null =>
  tone === "spore" ? "buys & locks $SPORE" : tone === "agent" ? "pays for its own launches and AI" : null;
