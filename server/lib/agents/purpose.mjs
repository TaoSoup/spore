// What an agent coin says about itself (owner 2026-10-19): every coin an agent launches exists to
// pump its root — each trade of the child routes through the root and parks root tokens in the
// child's curve — and its "website" is the root agent's page on Spore, so anyone who finds the coin
// on pump.fun lands on the agent that made it.
export const DEFAULT_PUBLIC_URL = "https://sporepad.com";
const DESC_LIMIT = 400; // metahost caps the metadata description at 400 characters

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

/** The root agent's public page: `https://sporepad.com/agents/<rootMint>`. */
export function agentSiteUrl(rootMint, publicUrl = DEFAULT_PUBLIC_URL) {
  return `${String(publicUrl || DEFAULT_PUBLIC_URL).replace(/\/$/, "")}/agents/${rootMint}`;
}

/** The purpose tail every agent coin carries, e.g. "By the $SPREAD agent, built to pump $SPREAD: every trade buys $SPREAD." */
export function purposeLine(rootSymbol) {
  const t = rootSymbol ? `$${String(rootSymbol).replace(/^\$/, "")}` : "its root";
  return `By the ${t} agent, built to pump ${t}: every trade of this coin buys ${t}.`;
}

/** The line a coin named after a real person carries (people briefs, DESIGN §13.3): a tribute, not the person's own coin. */
export function tributeLine(name) {
  return `Unofficial fan tribute, not affiliated with or endorsed by ${String(name).trim()}.`;
}

/**
 * The metadata description of an agent coin: the idea's description, its hype line and the purpose,
 * within the host's 400-character limit (the purpose is never dropped; the description is clipped).
 * `tribute` (a person's name, for a people brief): the hype line is about that person (no "Why now:"
 * label) and the tribute line follows the purpose, never dropped either.
 */
export function purposeDescription(idea, rootSymbol, { tribute = null } = {}) {
  const purpose = purposeLine(rootSymbol);
  const why = String(idea?.why ?? "").trim();
  const base = String(idea?.description ?? "").trim();
  const tail = tribute
    ? `${why ? ` — ${why}` : ""} · ${purpose} ${tributeLine(tribute)}`
    : `${why ? ` — Why now: ${why}` : ""} · ${purpose}`;
  const room = DESC_LIMIT - tail.length;
  return `${room > 20 ? clip(base, room) : ""}${tail}`.trim();
}
