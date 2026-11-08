// The agent's ledger read as a diary (redesign 2026-10-20, A3). Raw ledger lines are grouped into
// the entries a person would write: a launch swallows the model calls that led to it, a run of
// claims becomes one line, everything else stays as it is. Titles come from the API verbatim, except
// the few shapes that would otherwise show JSON, URLs or a "?" (humanTitle). Pure functions only, so
// the list card, the detail page and the home strip read the same entries.
import type { ActivityItem, ActivityKind, Agent } from "../../lib/api";
import { AGENT_PAYOUT_TO } from "../../lib/copy";
import { sol, usd } from "../../lib/format";
import { START_USD, runState, toSec } from "./data";

/// A launch absorbs the model calls from this many seconds before it.
export const LAUNCH_WINDOW_SEC = 180;
/// Claims closer together than this merge into one entry.
export const CLAIM_MERGE_SEC = 600;
/// A follow-up step of the same launch (its fee split) within this window joins the launch entry.
const LAUNCH_STEP_SEC = 600;

export type Tone = "ok" | "warn" | "bad";
/// The ledger's statuses: landed/done are fine, anything in flight is amber, failures red.
const TONE: Record<string, Tone> = {
  landed: "ok", done: "ok",
  pending: "warn", sent: "warn", step_landed: "warn", uncertain: "warn",
  failed: "bad", expired: "bad", refused: "bad",
};
export const toneOf = (status: string): Tone => TONE[status] ?? "warn";
/// The chip text of a status that needs attention ("step_landed" means the fee split is still owed).
export const statusLabel = (status: string): string => (status === "step_landed" ? "fee split owed" : status.replace(/_/g, " "));

export const itemKey = (a: ActivityItem): string => `${a.at}:${a.kind}:${a.signature ?? a.title}`;

export type DiaryEntry = {
  /// Stable across polls: the key of the entry's first (oldest) ledger line.
  key: string;
  type: "launch" | "claims" | "single";
  kind: ActivityKind;
  /// Time of the newest line in the entry.
  at: number;
  /// The entry's own lines, newest first: the launch line(s), the merged claims, or the one line.
  items: ActivityItem[];
  /// A launch only: the model calls it absorbed, oldest first.
  steps: ActivityItem[];
  /// The worst status across items and steps.
  tone: Tone;
  /// Every ledger key inside the entry, for arrival highlights.
  keys: string[];
};

const worst = (items: ActivityItem[]): Tone => items.reduce<Tone>((t, a) => { const x = toneOf(a.status); return t === "bad" || x === "bad" ? "bad" : t === "warn" || x === "warn" ? "warn" : "ok"; }, "ok");

/// Groups a ledger (any order) into diary entries, newest first.
export function groupActivity(activity: ActivityItem[]): DiaryEntry[] {
  const asc = [...activity].sort((a, b) => a.at - b.at);
  const absorbed = new Set<ActivityItem>();
  const steps = new Map<ActivityItem, ActivityItem[]>();
  const followUps = new Map<ActivityItem, ActivityItem[]>();
  const mainOf = new Map<string, ActivityItem>();
  for (const l of asc) {
    if (l.kind !== "launch") continue;
    const main = l.mint ? mainOf.get(l.mint) : undefined;
    if (main && l.at - main.at <= LAUNCH_STEP_SEC) { absorbed.add(l); followUps.get(main)?.push(l); continue; }
    if (l.mint) mainOf.set(l.mint, l);
    followUps.set(l, []);
    const mine = asc.filter((a) => a.kind === "ai" && !absorbed.has(a) && a.at <= l.at && l.at - a.at <= LAUNCH_WINDOW_SEC);
    mine.forEach((a) => absorbed.add(a));
    steps.set(l, mine);
  }
  const out: DiaryEntry[] = [];
  for (const a of asc) {
    if (absorbed.has(a)) continue;
    const last = out[out.length - 1];
    if (a.kind === "launch") {
      const items = [a, ...(followUps.get(a) ?? [])];
      const st = steps.get(a) ?? [];
      // The entry's tone is the launch's own: a failed model call before a landed launch shows in the step chain, not as a failed launch.
      out.push({ key: itemKey(a), type: "launch", kind: "launch", at: Math.max(...items.map((x) => x.at)), items: items.reverse(), steps: st, tone: worst(items), keys: [...items, ...st].map(itemKey) });
    } else if (a.kind === "claim" && toneOf(a.status) === "ok" && last?.type === "claims" && a.at - last.at < CLAIM_MERGE_SEC) {
      last.items.unshift(a); last.at = a.at; last.keys.push(itemKey(a));
    } else if (a.kind === "claim" && toneOf(a.status) === "ok") {
      out.push({ key: itemKey(a), type: "claims", kind: "claim", at: a.at, items: [a], steps: [], tone: "ok", keys: [itemKey(a)] });
    } else {
      out.push({ key: itemKey(a), type: "single", kind: a.kind, at: a.at, items: [a], steps: [], tone: toneOf(a.status), keys: [itemKey(a)] });
    }
  }
  return out.map((e) => (e.type === "claims" && e.items.length === 1 ? { ...e, type: "single" as const } : e)).reverse();
}

/* ---------- titles */
const REFUSED_402 = "Skipped the model: its USDC payment was refused (402). Named this coin from a template instead.";
const FALLBACK: Record<ActivityKind, string> = {
  launch: "Launched a coin", claim: "Claimed fees", payout: "Paid out", aifee: "Paid its AI bill",
  ai: "Called its model", swap: "Swapped SOL for USDC", split: "Finished a fee split",
};
/// JSON, links or an unread amount ("?") never reach the page.
export const hasJunk = (t: string): boolean => /[{}]|https?:\/\/|www\.|\?\s/i.test(t);

/// The line shown for one ledger item: the API's title, except the shapes a person should never see.
export function humanTitle(a: ActivityItem): string {
  const t = (a.title ?? "").trim();
  if (a.kind === "ai" && a.status === "refused") return /\b402\b/.test(t) ? REFUSED_402 : "Skipped the model: its payment was refused.";
  if (a.kind === "swap" && a.amountSol == null && a.amountUsdc == null) return "Swapped SOL for USDC";
  if (!t || hasJunk(t) || t.length > 140) return FALLBACK[a.kind];
  return t;
}
/// The raw title with JSON and links taken out, for the title attribute and the details toggle.
export const rawDetail = (t: string): string => t.replace(/\{[\s\S]*?(\}|$)/g, " ").replace(/(https?:\/\/|www\.)\S+/gi, " ").replace(/\s+/g, " ").replace(/[\s:,;]+$/, "").trim();
/// Lower-case clause for "{ROOT}'s agent · claimed fees" lines.
export const kindPhrase = (k: ActivityKind): string => FALLBACK[k].replace(/^./, (c) => c.toLowerCase());

const usdTiny = (n: number) => (n >= 1 ? usd(n) : `$${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`);
/// Dollars in diary lines: $5.05 · $0.57 · < $0.01 (exact values stay in the API).
export const usd2 = (n: number) => (n >= 1 ? usd(n) : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? "< $0.01" : "$0");
const symList = (items: ActivityItem[]) => {
  const s = [...new Set(items.map((a) => (a.symbol ? `$${a.symbol}` : null)).filter((x): x is string => !!x))];
  return s.length <= 2 ? s.join(" and ") : `${s.slice(0, 2).join(", ")} +${s.length - 2}`;
};
export type ClaimSum = { n: number; sol: number; usd: number | null; from: string };
export function claimSum(items: ActivityItem[]): ClaimSum {
  const solSum = items.reduce((n, a) => n + (a.amountSol ?? 0), 0);
  const usds = items.filter((a) => a.usd != null);
  return { n: items.length, sol: solSum, usd: usds.length ? usds.reduce((n, a) => n + (a.usd ?? 0), 0) : null, from: symList(items) };
}

/// One line per entry: "Launched $BREACH" · "Claimed 6 times from $SPREAD · 0.0483 SOL ≈ $5.05".
export function entryTitle(e: DiaryEntry): string {
  if (e.type === "launch") { const l = e.items[e.items.length - 1]; return l.symbol ? `Launched $${l.symbol}` : humanTitle(l); }
  if (e.type === "claims") {
    const c = claimSum(e.items);
    const money = [c.sol > 0 ? sol(c.sol) : null, c.usd != null && c.usd > 0 ? `≈ ${usd2(c.usd)}` : null].filter(Boolean).join(" ");
    return `Claimed ${c.n} times${c.from ? ` from ${c.from}` : ""}${money ? ` · ${money}` : ""}`;
  }
  return humanTitle(e.items[0]);
}

/// The model calls of a launch as a chain: "thought · Claude Sonnet 5.5 $0.016", "drew a logo $0.008".
export function stepLabel(a: ActivityItem): string {
  const t = humanTitle(a);
  const cost = a.usd != null && a.usd > 0 && toneOf(a.status) === "ok" ? ` ${usdTiny(a.usd)}` : "";
  const thought = /^Thought with (.+?)(?:\s*\(\$[\d.]+\))?$/.exec(t);
  const label = thought ? `thought · ${thought[1]}` : /^Drew a logo/i.test(t) ? "drew a logo" : a.status === "refused" ? "skipped the model" : t.replace(/\s*\(\$[\d.]+\)$/, "").replace(/^./, (c) => c.toLowerCase());
  return `${label}${a.status === "failed" ? " (failed)" : ""}${cost}`;
}

/* ---------- day and time */
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/// "Today" · "Yesterday" · "Oct 18" (shown upper-case).
export function dayLabel(at: number, now: number): string {
  const d = new Date(at * 1000);
  const diff = Math.round((dayStart(new Date(now * 1000)) - dayStart(d)) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
export const clockHM = (at: number): string => new Date(at * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

/* ---------- filters */
export type DiaryFilter = "all" | "launches" | "fees" | "ai";
export const FILTER_KINDS: Record<Exclude<DiaryFilter, "all">, ActivityKind[]> = { launches: ["launch"], fees: ["claim", "payout", "split", "swap"], ai: ["ai", "aifee"] };
export const filterActivity = (activity: ActivityItem[], f: DiaryFilter): ActivityItem[] => (f === "all" ? activity : activity.filter((a) => FILTER_KINDS[f].includes(a.kind)));

/* ---------- live diff */
/// The ledger keys that were not in the previous poll (none on the first read).
export function diffActivity(prev: Set<string> | null, next: ActivityItem[]): { keys: Set<string>; fresh: Set<string> } {
  const keys = new Set(next.map(itemKey));
  const fresh = new Set<string>();
  if (prev) for (const k of keys) if (!prev.has(k)) fresh.add(k);
  return { keys, fresh };
}

/* ---------- 24 h activity */
export type HourBucket = { start: number; launch: number; claim: number; ai: number; other: number; total: number };
/// 24 clock-hour buckets ending with the current hour, oldest first, plus the busiest one.
export function hourBuckets(activity: ActivityItem[], now: number): { buckets: HourBucket[]; total: number; busiest: HourBucket | null } {
  const h = new Date(now * 1000); h.setMinutes(0, 0, 0);
  const cur = Math.floor(h.getTime() / 1000);
  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, i) => ({ start: cur - (23 - i) * 3600, launch: 0, claim: 0, ai: 0, other: 0, total: 0 }));
  let total = 0;
  for (const a of activity) {
    const t = toSec(a.at);
    if (t == null || t > now + 60) continue;
    const i = 23 - Math.floor((cur + 3600 - 1 - t) / 3600);
    if (i < 0 || i > 23) continue;
    const b = buckets[i];
    if (a.kind === "launch") b.launch++; else if (a.kind === "claim") b.claim++; else if (a.kind === "ai" || a.kind === "aifee") b.ai++; else b.other++;
    b.total++; total++;
  }
  const busiest = total ? buckets.reduce((m, b) => (b.total > m.total ? b : m)) : null;
  return { buckets, total, busiest };
}

/* ---------- the status sentence */
/// What the agent is doing, in one sentence: the first case that applies (paused, asleep, just did
/// something, saving for its next coin, ready).
export function statusSentence(a: Pick<Agent, "status" | "wallet" | "totals" | "sleeping" | "reason">, entries: DiaryEntry[], now: number, need: number): string {
  const s = runState(a);
  if (s.state === "paused") return "Paused by the operator. It keeps its wallet and runs nothing until it is enabled again.";
  if (s.state === "asleep") {
    const w = a.wallet;
    if (w?.usd != null && (w.usd < START_USD || /needs \$/.test(s.reason ?? ""))) return `Asleep: its wallet holds ${usd(w.usd)} and it needs ${usd(START_USD)} to start.`;
    return s.reason ? `Asleep: ${s.reason.replace(/\.$/, "")}.` : "Asleep until its wallet can pay for a launch.";
  }
  const e = entries[0];
  if (e && now - e.at < 120) return justDid(e);
  const w = a.wallet?.sol;
  if (w != null && w < need) return `Saving for its next coin: ${w.toFixed(4)} of ${need.toFixed(3)} SOL.`;
  return "Ready to launch its next coin on its next pass.";
}

/// The newest entry in the past tense: "Just claimed 0.0043 SOL from $SPREAD."
export function justDid(e: DiaryEntry): string {
  const a = e.items[0];
  if (e.tone === "bad") return `Its last try did not go through: ${entryTitle(e).replace(/\.$/, "")}.`;
  switch (e.kind) {
    case "launch": { const l = e.items[e.items.length - 1]; return `Just launched ${l.symbol ? `$${l.symbol}` : "a coin under its root"}.`; }
    case "claim": {
      const c = claimSum(e.items);
      const from = c.from ? ` from ${c.from}` : "";
      return c.sol > 0 ? `Just claimed ${sol(c.sol)}${from}.` : c.usd != null && c.usd > 0 ? `Just claimed ≈ ${usd2(c.usd)} in fees${from}.` : `Just claimed its fees${from}.`;
    }
    case "payout": return a.amountSol != null ? `Just paid ${sol(a.amountSol)} to ${AGENT_PAYOUT_TO}.` : `Just paid its surplus to ${AGENT_PAYOUT_TO}.`;
    case "aifee": return `Just paid its AI bill${a.usd != null ? ` (${usdTiny(a.usd)})` : ""}.`;
    case "ai": return "Just thought with its model.";
    case "swap": return "Just swapped SOL for USDC.";
    case "split": return "Just finished a fee split.";
  }
}
