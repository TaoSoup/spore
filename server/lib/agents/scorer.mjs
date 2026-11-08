// Momentum scorer for root agents (DESIGN §13): no model, only numbers the index already keeps.
// Inputs per root: the activity counters (lib/activity.mjs: trades and buys in the last hour,
// trades and USD volume over 24 h), its child count, its depth and mayhem flag (only a depth-0,
// non-mayhem coin can take children here) and when its agent last proposed. Output: a score from 0
// to 100 and one human sentence saying why.
//
// Weights (sum 100): trades in the last hour 35, buy share of those 10, 24 h USD volume 25, 24 h
// trade count 10, existing children 15 (a tree that already grows), time since the last proposal 5.
// Every count is taken on a log scale against a "busy" reference so one whale trade does not
// saturate it and a quiet root is not zero.

const W = { t1h: 35, buys: 10, v24: 25, n24: 10, children: 15, fresh: 5 };
const REF = { t1h: 200, v24: 250_000, n24: 2_000, children: 300 };
export const DEFAULTS = { minScore: 40, cooldownMin: 60, maxPerHour: 12 };

const logShare = (x, ref) => Math.min(1, Math.log10(1 + Math.max(0, x)) / Math.log10(1 + ref));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const compactUsd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
const ago = (s) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 172_800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} d ago`);

/**
 * `{ score, reason, parts, launchable }` for one root. `activity` is `Activity.get(mint)` (null when
 * the coin has no trade in 24 h), `lastProposalAt` unix s or null, `now` unix s. `launchable` is
 * false (score 0) when children cannot be launched under the coin here: not a root, or mayhem.
 */
export function scoreRoot({ activity = null, children = 0, depth = 0, mayhem = false, lastProposalAt = null, now = Math.floor(Date.now() / 1000), cooldownMin = DEFAULTS.cooldownMin } = {}) {
  if (depth !== 0) return { score: 0, reason: `not a root (depth ${depth}): agents launch only under depth-0 coins`, parts: null, launchable: false };
  if (mayhem) return { score: 0, reason: "mayhem-mode coins cannot be parents", parts: null, launchable: false };
  const t1h = activity?.t1h ?? 0, buys1h = activity?.buys1h ?? 0, n24 = activity?.trades ?? 0, v24 = activity?.usd ?? 0;
  const since = lastProposalAt == null ? null : Math.max(0, now - lastProposalAt);
  const cooldownS = cooldownMin * 60;
  const parts = {
    t1h: W.t1h * logShare(t1h, REF.t1h),
    // Buy share counts only with some flow behind it, and from 30 % (all sells) to 70 % buys.
    buys: t1h >= 5 ? W.buys * clamp01((buys1h / t1h - 0.3) / 0.4) : 0,
    v24: W.v24 * logShare(v24, REF.v24),
    n24: W.n24 * logShare(n24, REF.n24),
    children: W.children * logShare(children, REF.children),
    // Fresh: nothing proposed yet, or the last proposal is a day old; nothing inside the cooldown.
    fresh: since == null ? W.fresh : W.fresh * clamp01((since - cooldownS) / Math.max(1, 86_400 - cooldownS)),
  };
  const score = Math.round(Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0)));
  const bits = [
    `${children} ${children === 1 ? "child" : "children"}`,
    t1h ? `${t1h} trades/1h (${Math.round((buys1h / t1h) * 100)}% buys)` : "no trades in the last hour",
    n24 ? `${n24} trades and ${compactUsd(v24)} volume in 24 h` : "no trades in 24 h",
    since == null ? "never proposed" : `last proposal ${ago(since)}`,
  ];
  return { score, reason: `momentum ${score}/100: ${bits.join(", ")}`, parts, launchable: true };
}

/**
 * May the agent propose now? Order of checks: launchable, minimum score, the per-root cooldown,
 * then the cap across all agents in the last hour. `{ ok, why }` with `why` null when ok.
 */
export function gate({ score, launchable = true, lastProposalAt = null, proposalsLastHour = 0, now = Math.floor(Date.now() / 1000), minScore = DEFAULTS.minScore, cooldownMin = DEFAULTS.cooldownMin, maxPerHour = DEFAULTS.maxPerHour } = {}) {
  if (!launchable) return { ok: false, why: "children cannot be launched under this coin" };
  if (score < minScore) return { ok: false, why: `score ${score} below the minimum ${minScore}` };
  if (lastProposalAt != null && now - lastProposalAt < cooldownMin * 60) return { ok: false, why: `cooldown: last proposal ${ago(now - lastProposalAt)}, one per ${cooldownMin} min` };
  if (proposalsLastHour >= maxPerHour) return { ok: false, why: `hourly cap: ${proposalsLastHour} proposals across all agents in the last hour (max ${maxPerHour})` };
  return { ok: true, why: null };
}
