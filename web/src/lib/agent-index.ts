// Which coins the AI agents launched, and which roots have an agent, from the one cached
// /api/agents list (components/agents/data.ts agentsCached: ≤ 1 request a minute per tab). Used by
// coin cards, search rows, the Home pulse, the coin header and the fee rows to say "by $SPREAD's
// agent" / "agent live". The rule: a child is agent-launched when its on-chain fee split names a
// public agent wallet (or the agent's launch list has its mint). Never guessed from names.
import { useEffect, useState } from "react";
import type { AgentCoin, AgentStatus, Coin, CoinRef } from "./api";
import { agentsCached, loadAgentCoin, runState, type RunState } from "../components/agents/data";

export type AgentIndexEntry = { root: CoinRef; wallet: string | null; status: AgentStatus; state: RunState["state"]; lastActivityAt: number | null };
export type AgentIndex = {
  ready: boolean;
  /// agent wallet address → its agent
  byWallet: Map<string, AgentIndexEntry>;
  /// root mint → its agent
  byRoot: Map<string, AgentIndexEntry>;
  /// launched mint → the agent that launched it (the list route carries ≤ 12 per agent; shares cover the rest)
  byLaunched: Map<string, AgentIndexEntry>;
};
export type AgentProvenance = { role: "root" | "child"; agent: AgentIndexEntry } | null;

const EMPTY: AgentIndex = { ready: false, byWallet: new Map(), byRoot: new Map(), byLaunched: new Map() };
let built: { at: number; index: AgentIndex } | null = null;

async function build(): Promise<AgentIndex> {
  if (built && Date.now() - built.at < 60_000) return built.index;
  const list = await agentsCached();
  const index: AgentIndex = { ready: true, byWallet: new Map(), byRoot: new Map(), byLaunched: new Map() };
  for (const a of list.agents) {
    const entry: AgentIndexEntry = { root: a.root, wallet: a.wallet?.address ?? null, status: a.status, state: runState(a).state, lastActivityAt: a.totals?.lastActivityAt ?? null };
    index.byRoot.set(a.root.mint, entry);
    if (entry.wallet) index.byWallet.set(entry.wallet, entry);
    for (const l of a.launched ?? []) index.byLaunched.set(l.mint, entry);
  }
  built = { at: Date.now(), index };
  return index;
}

/// The shared index; `ready` is false until the list loaded (or forever on a server without agents).
export function useAgentIndex(): AgentIndex {
  const [index, setIndex] = useState<AgentIndex>(built?.index ?? EMPTY);
  useEffect(() => {
    let alive = true;
    build().then((i) => { if (alive) setIndex(i); }).catch(() => { /* no agents route: stay empty */ });
    return () => { alive = false; };
  }, []);
  return index;
}

/// "root" when the coin has an agent, "child" when an agent launched it, else null.
export function agentProvenance(coin: Pick<Coin, "mint" | "depth" | "shares">, index: AgentIndex): AgentProvenance {
  if (!index.ready) return null;
  if (coin.depth === 0) { const a = index.byRoot.get(coin.mint); return a ? { role: "root", agent: a } : null; }
  const byList = index.byLaunched.get(coin.mint);
  if (byList) return { role: "child", agent: byList };
  for (const s of coin.shares ?? []) { const a = index.byWallet.get(s.address); if (a) return { role: "child", agent: a }; }
  return null;
}

/// GET /api/agents/coin/:mint shared by every card on a coin page (the agent card, the fee card,
/// the header chip): one request per mint per minute.
const coinCache = new Map<string, { at: number; p: Promise<AgentCoin | null> }>();
export function agentCoinCached(coin: { mint: string; depth: number }, maxAgeMs = 60_000): Promise<AgentCoin | null> {
  const hit = coinCache.get(coin.mint);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.p;
  const p = loadAgentCoin(coin);
  coinCache.set(coin.mint, { at: Date.now(), p });
  p.catch(() => { if (coinCache.get(coin.mint)?.p === p) coinCache.delete(coin.mint); });
  return p;
}
export function useAgentCoin(coin: { mint: string; depth: number } | null): AgentCoin | null | undefined {
  const [state, setState] = useState<{ mint: string; v: AgentCoin | null } | null>(null);
  const mint = coin?.mint ?? null, depth = coin?.depth ?? 0;
  useEffect(() => {
    if (!mint) return;
    let alive = true;
    agentCoinCached({ mint, depth }).then((v) => { if (alive) setState({ mint, v }); }).catch(() => { if (alive) setState({ mint, v: null }); });
    return () => { alive = false; };
  }, [mint, depth]);
  return !mint ? null : state && state.mint === mint ? state.v : undefined;
}

/// The same provenance shape from a coin page's /api/agents/coin answer, so the header can use <AgentChip>.
export function provenanceFromAgentCoin(ac: AgentCoin | null | undefined): AgentProvenance {
  if (!ac || !ac.role || !ac.root) return null;
  const a = ac.agent;
  const state = a ? runState({ status: a.status, wallet: a.wallet, totals: a.totals }).state : "live";
  return { role: ac.role, agent: { root: ac.root, wallet: a?.address ?? null, status: a?.status ?? "live", state, lastActivityAt: a?.totals?.lastActivityAt ?? null } };
}
