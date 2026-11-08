// Root agents: the momentum score (bounds, what moves it, the depth/mayhem gate) and the proposal
// gates (minimum score, per-root cooldown, hourly cap across agents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRoot, gate, DEFAULTS } from "../lib/agents/scorer.mjs";

const NOW = 1_800_000_000;
const busy = { t1h: 180, buys1h: 120, trades: 1900, usd: 240_000 };
const quiet = { t1h: 0, buys1h: 0, trades: 3, usd: 12 };

test("score: 0-100, busy roots outrank quiet ones, every part moves it, reason names the numbers", () => {
  const hi = scoreRoot({ activity: busy, children: 300, now: NOW });
  const lo = scoreRoot({ activity: quiet, children: 1, now: NOW });
  const none = scoreRoot({ activity: null, children: 0, now: NOW });
  for (const s of [hi, lo, none]) { assert.ok(s.score >= 0 && s.score <= 100, String(s.score)); assert.equal(s.launchable, true); }
  assert.ok(hi.score >= 90, `busy ${hi.score}`);
  assert.ok(lo.score < 25, `quiet ${lo.score}`);
  assert.equal(none.score, 5, "only the never-proposed bonus");
  assert.match(hi.reason, /^momentum \d+\/100: 300 children, 180 trades\/1h \(67% buys\), 1900 trades and \$240\.0K volume in 24 h, never proposed$/);
  assert.match(none.reason, /no trades in the last hour, no trades in 24 h/);
  // Each input moves the score in its direction.
  const base = { activity: { t1h: 20, buys1h: 10, trades: 200, usd: 5_000 }, children: 10, now: NOW };
  const s0 = scoreRoot(base).score;
  assert.ok(scoreRoot({ ...base, activity: { ...base.activity, t1h: 60, buys1h: 30 } }).score > s0, "trades/1h");
  assert.ok(scoreRoot({ ...base, activity: { ...base.activity, buys1h: 18 } }).score > s0, "buy share");
  assert.ok(scoreRoot({ ...base, activity: { ...base.activity, usd: 50_000 } }).score > s0, "volume");
  assert.ok(scoreRoot({ ...base, children: 100 }).score > s0, "children");
  // A sell-only hour earns no buy points; a handful of trades is too little to judge buy share.
  assert.equal(scoreRoot({ activity: { t1h: 50, buys1h: 0, trades: 50, usd: 100 }, now: NOW }).parts.buys, 0);
  assert.equal(scoreRoot({ activity: { t1h: 4, buys1h: 4, trades: 4, usd: 10 }, now: NOW }).parts.buys, 0);
});

test("score: recency of the last proposal — nothing inside the cooldown, full after a day", () => {
  const p = (ago) => scoreRoot({ activity: busy, children: 50, now: NOW, lastProposalAt: ago == null ? null : NOW - ago, cooldownMin: 60 });
  assert.equal(p(30 * 60).parts.fresh, 0);
  assert.equal(p(60 * 60).parts.fresh, 0);
  assert.ok(p(12 * 3600).parts.fresh > 0 && p(12 * 3600).parts.fresh < 5);
  assert.equal(p(86_400).parts.fresh, 5); assert.equal(p(null).parts.fresh, 5);
  assert.match(p(30 * 60).reason, /last proposal 30 min ago/);
  assert.match(p(5 * 3600).reason, /last proposal 5 h ago/);
});

test("score: only depth-0, non-mayhem coins can be launched under (score 0, not launchable)", () => {
  const d1 = scoreRoot({ activity: busy, children: 300, depth: 1, now: NOW });
  assert.deepEqual([d1.score, d1.launchable], [0, false]); assert.match(d1.reason, /not a root \(depth 1\)/);
  const m = scoreRoot({ activity: busy, children: 300, mayhem: true, now: NOW });
  assert.deepEqual([m.score, m.launchable], [0, false]); assert.match(m.reason, /mayhem/);
  assert.deepEqual(gate({ score: 99, launchable: false, now: NOW }), { ok: false, why: "children cannot be launched under this coin" });
});

test("gates: minimum score, per-root cooldown, hourly cap across agents, in that order", () => {
  const g = (o) => gate({ now: NOW, minScore: 40, cooldownMin: 60, maxPerHour: 12, ...o });
  assert.deepEqual(g({ score: 40 }), { ok: true, why: null });
  assert.match(g({ score: 39 }).why, /score 39 below the minimum 40/);
  assert.match(g({ score: 80, lastProposalAt: NOW - 59 * 60 }).why, /^cooldown: last proposal 59 min ago, one per 60 min$/);
  assert.equal(g({ score: 80, lastProposalAt: NOW - 60 * 60 }).ok, true, "exactly the cooldown later is allowed");
  assert.match(g({ score: 80, proposalsLastHour: 12 }).why, /hourly cap: 12 proposals .* \(max 12\)/);
  assert.equal(g({ score: 80, proposalsLastHour: 11 }).ok, true);
  assert.match(g({ score: 10, lastProposalAt: NOW, proposalsLastHour: 99 }).why, /below the minimum/, "minimum score is checked first");
  assert.equal(gate({ score: 40, now: NOW }).ok, true, "defaults: 40 / 60 min / 12 per hour");
  assert.deepEqual([DEFAULTS.minScore, DEFAULTS.cooldownMin, DEFAULTS.maxPerHour], [40, 60, 12]);
});
