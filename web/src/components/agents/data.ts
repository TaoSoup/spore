// Data layer of the root-agent pages (DESIGN §13.1). The routes are read-only; new proposals and
// launches arrive over the shared SSE stream as `agent` events and are folded into whatever the
// page holds. Every record is normalised on the way in, so a server that predates a field (wallet,
// totals, launched, activity) still renders instead of crashing a card.
//
// Development: while the local API has no agents to show (no agents routes, so an unknown /api route
// answers 404, or an empty list with the runner off), the pages render ./fixture instead, shaped
// exactly like the contract. Every fallback sits behind `import.meta.env.DEV`, which the production
// build replaces with `false`, so the dead branch and its dynamic import (the fixture chunk) are
// dropped from the bundle.
import { api, ApiError, solscanTx, type ActivityItem, type Agent, type AgentCoin, type AgentDetail, type AgentEvent, type AgentLaunched, type AgentList, type AgentProposal, type AgentTotals } from "../../lib/api";

/// Server default of AGENT_MIN_SCORE in the dry run: the momentum bar's marker. In live mode the
/// score gates nothing; it stays visible as a read on the root's trading.
export const MIN_SCORE = 40;
/// Budget rules an agent lives by (lib/agents-live/budget.mjs + live.mjs defaults), for the derived
/// run state and the copy that explains it. The server's own reason wins whenever it sends one.
export const START_USD = 5;
export const RESERVE_SOL = 0.005;
/// Margin the runner adds on top of the last launch's cost before it launches again.
export const LAUNCH_MARGIN_SOL = 0.003;
export const LAUNCH_NEEDS_SOL = 0.016 + LAUNCH_MARGIN_SOL + RESERVE_SOL; // last launch cost prior + margin + reserve
export const KEEP_SOL = 0.1;
/// The runner claims an agent's share once it is worth this much (lib/agents-live claim threshold).
export const CLAIM_MIN_SOL = 0.002;
/// The 15-minute window in which a live agent counts as busy (its LIVE badge pulses).
export const BUSY_SEC = 15 * 60;
/// The root's three-way fee split (lib/policy.ts ROOT_SPLIT), as percentages of the trade.
export const AGENT_FEE_PCT = "0.20%";

export type Loaded<T> = T & { fixture: boolean };
const notFound = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 400);

const EMPTY_TOTALS: AgentTotals = { launches: 0, launchSol: 0, claimsSol: 0, claimsUsd: null, aiUsd: 0, aiCalls: 0, payoutsSol: 0, payoutsUsdc: 0, lastActivityAt: null };
const B58 = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const n0 = (v: unknown): number => num(v) ?? 0;

/// A base58 signature or null: older ledger lines carried base64 signatures, which no explorer resolves.
export const sig58 = (s: unknown): string | null => (typeof s === "string" && B58.test(s) ? s : null);

/// One activity item with every field present, the signature base58-only and the explorer link filled.
export function normalizeActivity(raw: Partial<ActivityItem> | null | undefined): ActivityItem | null {
  if (!raw || typeof raw !== "object" || !raw.kind) return null;
  const at = toSec(raw.at);
  if (at == null) return null;
  const signature = sig58(raw.signature);
  return {
    at, kind: raw.kind, status: String(raw.status ?? "landed"), title: String(raw.title ?? raw.kind),
    amountSol: num(raw.amountSol), amountUsdc: num(raw.amountUsdc), usd: num(raw.usd),
    mint: raw.mint ?? null, symbol: raw.symbol ?? null, signature, explorer: raw.explorer ?? (signature ? solscanTx(signature) : null),
  };
}
const normalizeLaunched = (l: Partial<AgentLaunched> | null | undefined): AgentLaunched | null => (l && l.mint ? { mint: l.mint, name: l.name ?? null, symbol: l.symbol ?? null, image: l.image ?? null, createdAt: toSec(l.createdAt), signature: sig58(l.signature), why: l.why ?? null, logoSource: l.logoSource ?? null } : null);
const byNewest = <T extends { at?: number | null; createdAt?: number | null }>(a: T, b: T) => (toSec(b.at ?? b.createdAt) ?? 0) - (toSec(a.at ?? a.createdAt) ?? 0);

/// An agent as the pages hold it: the contract's fields, each defaulted when a server leaves it out.
export function normalizeAgent(raw: Agent): Agent {
  const t = (raw.totals ?? {}) as Partial<AgentTotals>;
  const launched = (raw.launched ?? []).map(normalizeLaunched).filter((l): l is AgentLaunched => l !== null).sort(byNewest);
  const activity = (raw.activity ?? []).map(normalizeActivity).filter((a): a is ActivityItem => a !== null).sort(byNewest);
  const wallet = raw.wallet && raw.wallet.address ? { address: raw.wallet.address, sol: num(raw.wallet.sol), usdc: num(raw.wallet.usdc), usd: num(raw.wallet.usd), updatedAt: toSec(raw.wallet.updatedAt) } : null;
  return {
    ...raw, wallet, launched, activity,
    totals: { launches: Math.max(n0(t.launches), launched.length), launchSol: n0(t.launchSol), claimsSol: n0(t.claimsSol), claimsUsd: num(t.claimsUsd), aiUsd: n0(t.aiUsd), aiCalls: n0(t.aiCalls), payoutsSol: n0(t.payoutsSol), payoutsUsdc: n0(t.payoutsUsdc), lastActivityAt: toSec(t.lastActivityAt) ?? activity[0]?.at ?? launched[0]?.createdAt ?? null },
    stats: { runs: n0(raw.stats?.runs), proposals: n0(raw.stats?.proposals), lastRunAt: toSec(raw.stats?.lastRunAt), nextRunAt: toSec(raw.stats?.nextRunAt), score: num(raw.stats?.score), scoreReason: raw.stats?.scoreReason ?? null },
  };
}

/// An API that serves nothing about agents: an empty list with the runner off (a local server).
const emptyOff = (r: AgentList) => r.mode === "off" && (r.agents ?? []).length === 0;
/// DEV only: whether this API has no agents to show (no routes at all, or an empty list with the runner off).
const devNoAgents = () => api.agents().then(emptyOff, notFound);
async function fixtureList(): Promise<Loaded<AgentList>> {
  const f = await import("./fixture");
  return { mode: "live", agents: f.agents().map(normalizeAgent), fixture: true };
}

export async function loadAgents(): Promise<Loaded<AgentList>> {
  try {
    const r = await api.agents();
    if (import.meta.env.DEV && emptyOff(r)) return fixtureList();
    return { mode: r.mode, agents: (r.agents ?? []).map(normalizeAgent), fixture: false };
  } catch (e) {
    if (import.meta.env.DEV && notFound(e)) return fixtureList();
    throw e;
  }
}

/// A root without an agent is an answer, not an error: it resolves to `{ missing: true }` so the page
/// can say so whatever the server's 404 message is. Other failures reject as usual.
export type AgentLoad = Loaded<AgentDetail> | { missing: true; fixture: boolean };
export async function loadAgent(root: string): Promise<AgentLoad> {
  try {
    const d = await api.agent(root);
    const agent = normalizeAgent({ ...d.agent, launched: d.launched ?? d.agent.launched, activity: d.activity ?? d.agent.activity });
    return { agent, proposals: d.proposals ?? [], activity: agent.activity, launched: agent.launched, fixture: false };
  } catch (e) {
    if (!notFound(e)) throw e;
    if (import.meta.env.DEV) {
      // A 404 means either "no agent for this root" or "no agents here at all"; only the second uses the fixture.
      if (await devNoAgents()) {
        const d = (await import("./fixture")).detail(root);
        if (!d) return { missing: true, fixture: true };
        const agent = normalizeAgent({ ...d.agent, launched: d.launched, activity: d.activity });
        return { agent, proposals: d.proposals, activity: agent.activity, launched: agent.launched, fixture: true };
      }
    }
    return { missing: true, fixture: false };
  }
}

/// The agent side of a coin page. A server without the route (404) hides the cards, except that a
/// root with an agent in the shared list still gets its card from there (the older shape).
export async function loadAgentCoin(coin: { mint: string; depth: number }): Promise<AgentCoin | null> {
  try {
    const r = await api.agentCoin(coin.mint);
    if (import.meta.env.DEV && (!r || !r.role) && await devNoAgents()) return (await import("./fixture")).coin(coin.mint);
    if (!r || !r.role) return null;
    if (r.agent) r.agent = { ...r.agent, wallet: r.agent.wallet && r.agent.wallet.address ? { ...r.agent.wallet, sol: num(r.agent.wallet.sol), usdc: num(r.agent.wallet.usdc), usd: num(r.agent.wallet.usd), updatedAt: toSec(r.agent.wallet.updatedAt) } : null, totals: { ...EMPTY_TOTALS, ...r.agent.totals } };
    if (r.launch) r.launch = { ...r.launch, signature: sig58(r.launch.signature), at: toSec(r.launch.at) };
    return r;
  } catch (e) {
    if (!notFound(e)) throw e;
    if (import.meta.env.DEV) {
      if (await devNoAgents()) return (await import("./fixture")).coin(coin.mint);
    }
    if (coin.depth !== 0) return null;
    const list = await agentsCached().catch(() => null);
    const a = list?.agents.find((x) => x.root.mint === coin.mint);
    return a ? { role: "root", root: a.root, agent: { address: a.wallet?.address ?? null, status: a.status, wallet: a.wallet, totals: a.totals, model: a.model ?? null }, launch: null } : null;
  }
}

/// The agent list shared by the home strip and the coin pages' fallback: one request per minute at
/// most, however many pages are opened. A failure is not cached, so the next page tries again.
let cached: { at: number; p: Promise<Loaded<AgentList>> } | null = null;
export function agentsCached(maxAgeMs = 60_000) {
  if (!cached || Date.now() - cached.at > maxAgeMs) {
    const p = loadAgents();
    cached = { at: Date.now(), p };
    p.catch(() => { if (cached?.p === p) cached = null; });
  }
  return cached.p;
}

/// Timestamps are unix seconds like every other record of the API; a millisecond value (13 digits)
/// is accepted so a server that sends `Date.now()` still renders the right age.
export const toSec = (t: number | null | undefined): number | null => (t == null || !Number.isFinite(t) ? null : t > 1e12 ? Math.floor(t / 1000) : t);
export const eventRoot = (e: AgentEvent): string | null => (typeof e.root === "string" ? e.root : e.root?.mint ?? null);
const sameId = (a: AgentProposal | null | undefined, b: AgentProposal) => !!a && String(a.id) === String(b.id);

/// An agent after a live event: the proposal becomes the latest, the count moves once (a replayed
/// event is ignored), and when the event says the coin was launched it joins `launched`, the
/// totals and the activity at once instead of waiting for the next poll.
export function withProposal(a: Agent, p: AgentEvent["proposal"]): Agent {
  const at = toSec(p.createdAt) ?? Math.floor(Date.now() / 1000);
  let next = a;
  if (!sameId(a.latest, p)) next = { ...a, latest: p, stats: { ...a.stats, proposals: a.stats.proposals + 1, lastRunAt: Math.max(toSec(a.stats.lastRunAt) ?? 0, at) || a.stats.lastRunAt } };
  const l = p.launched;
  if (l?.mint && !next.launched.some((x) => x.mint === l.mint)) {
    const signature = sig58(l.signature);
    const item: ActivityItem = { at, kind: "launch", status: "landed", title: `Launched $${p.symbol}`, amountSol: p.sim?.estCostSol ?? null, amountUsdc: null, usd: null, mint: l.mint, symbol: p.symbol, signature, explorer: signature ? solscanTx(signature) : null };
    next = {
      ...next,
      launched: [{ mint: l.mint, name: p.name, symbol: p.symbol, image: p.image, createdAt: at, signature, why: p.why ?? null, logoSource: p.logoSource ?? null }, ...next.launched],
      activity: [item, ...next.activity].slice(0, 200),
      totals: { ...next.totals, launches: next.totals.launches + 1, launchSol: next.totals.launchSol + (p.sim?.estCostSol ?? 0), lastActivityAt: Math.max(next.totals.lastActivityAt ?? 0, at) },
    };
  }
  return next;
}
export function detailWithProposal(d: AgentDetail, p: AgentEvent["proposal"]): AgentDetail {
  const agent = withProposal(d.agent, p);
  const proposals = d.proposals.some((x) => sameId(x, p)) ? d.proposals : [p, ...d.proposals].slice(0, 50);
  return { agent, proposals, activity: agent.activity, launched: agent.launched };
}

/// What the agent is doing right now, for the status badge: running, asleep (with the runner's
/// reason), waiting for funds, or paused. The server's own `sleeping`/`reason` win; otherwise the
/// wallet is read against the budget rules the runner applies (budget.mjs canStart, the reserve).
export type RunState = { state: "live" | "asleep" | "paused"; label: string; reason: string | null };
export function runState(a: Pick<Agent, "status" | "wallet" | "totals" | "sleeping" | "reason">): RunState {
  if (a.status === "paused") return { state: "paused", label: "paused", reason: "Paused by the operator. It keeps its wallet and runs nothing until it is enabled again." };
  if (a.sleeping === true) return { state: "asleep", label: "asleep", reason: a.reason ?? null };
  if (a.sleeping === false) return { state: "live", label: "live", reason: a.reason && a.reason !== "running" ? a.reason : null };
  const w = a.wallet;
  if (!w) return { state: "live", label: "live", reason: null };
  if (a.totals.launches === 0 && w.usd != null && w.usd < START_USD) return { state: "asleep", label: "asleep", reason: `wallet holds $${w.usd.toFixed(2)}, needs $${START_USD.toFixed(2)} to start` };
  if (w.sol != null && w.sol < RESERVE_SOL + 0.00001) return { state: "asleep", label: "asleep", reason: `wallet under the ${RESERVE_SOL} SOL reserve` };
  if (w.sol != null && w.sol < LAUNCH_NEEDS_SOL) return { state: "live", label: "live", reason: `waiting for fees: ${w.sol.toFixed(4)} SOL, a launch needs about ${LAUNCH_NEEDS_SOL.toFixed(3)}` };
  return { state: "live", label: "live", reason: null };
}

/// What the next launch needs in the wallet: the newest launch's cost plus the runner's margin and
/// reserve; before any launch is in view, the average launch so far, else the budget prior.
export function launchNeed(a: Pick<Agent, "activity" | "totals">): number {
  const last = a.activity.find((x) => x.kind === "launch" && x.amountSol != null && x.amountSol > 0)?.amountSol;
  const avg = a.totals.launches > 0 && a.totals.launchSol > 0 ? a.totals.launchSol / a.totals.launches : null;
  const cost = last ?? avg;
  return cost != null ? cost + LAUNCH_MARGIN_SOL + RESERVE_SOL : LAUNCH_NEEDS_SOL;
}

/// Seconds since the agent last did anything (its newest ledger line), or null.
export const idleFor = (a: Pick<Agent, "totals">, now: number): number | null => { const t = toSec(a.totals.lastActivityAt); return t == null ? null : Math.max(0, now - t); };

/// The public name of the model an agent thinks with ("anthropic/claude-sonnet-5.5" → "Claude Sonnet 5.5").
export function modelLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = /claude-(sonnet|opus|haiku)-([\d.]+)/i.exec(id);
  if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}`;
  const g = /gpt-([\w.-]+)/i.exec(id);
  if (g) return `GPT-${g[1]}`;
  return id.split("/").pop() ?? id;
}

/// "#b6ff5c" → "182,255,92" for the --tint variable; null for anything that is not a 3/6-digit hex.
export function hexRgb(hex: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(",");
}
/// The most vivid palette colour that still reads on the dark surface (lightness 30–92 %, closest to
/// 60 % preferred), so a card's glow follows the agent's palette without a near-black or pale tint.
/// Null when none fits.
export function paletteTint(palette: string[] | null | undefined): string | null {
  let best: { rgb: string; score: number } | null = null;
  for (const c of palette ?? []) {
    const rgb = hexRgb(c);
    if (!rgb) continue;
    const [r, g, b] = rgb.split(",").map((v) => Number(v) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (l < 0.3 || l > 0.92) continue;
    const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    const score = sat - Math.abs(l - 0.6);
    if (!best || score > best.score) best = { rgb, score };
  }
  return best?.rgb ?? null;
}
