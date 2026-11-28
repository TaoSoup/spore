// Story attention on Discover (pages/Discover.tsx, components/StoryChart.tsx): the one-line glance under a story's title
// and the geometry of its relative chart, from a card's `attention` (GET /api/stories) and GET /api/story-series/:key.
// Context, never a forecast: the words say what was measured (buyers, how long since the start, which coin most of them
// bought, how that compares with the story's own normal), every phase is drawn in the same neutral style (no arrows, no
// colour for up), and nothing says what comes next. Pure: no React, no DOM (test/story-attention.test.mts).
import type { StoryAttention, StoryCard, StoryNewWhy, StoryPhase, StorySeries } from "./api";
import { count } from "./format";

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const whole = (n: unknown): number => (fin(n) && n > 0 ? Math.floor(n) : 0);

/// What each phase means, for its tooltip: what the last hour looked like, not what comes next.
export const PHASE_TITLE: Record<StoryPhase, string> = {
  new: "New: not enough history yet to say what is normal for this story (it needs 6 h since its first buyers and 12 earlier 5-minute buckets with buyers).",
  rising: "Rising: more buyers in the last 30 min than in the 30 min before (+25 % or more), and above this story's normal.",
  peaked: "Peaked: still near the most buyers this story has had in 30 min, but fewer than in the 30 min before.",
  fading: "Fading: a quarter fewer buyers than in the 30 min before, or half its busiest 30 min or less.",
  steady: "Steady: about as many buyers as in the 30 min before.",
};
/// The "new" tooltip by the gate that failed (the server's `newWhy`): a story with days of history can be "new" because
/// its last hour was quiet, or because the server did not see all of it (a restart).
export const NEW_TITLE: Record<StoryNewWhy, string> = {
  history: PHASE_TITLE.new,
  quiet: "New: too few buyers in the last hour (under 10) to compare with this story's normal.",
  unseen: "New: the server did not see the whole last hour (it restarted), so it does not compare this story with its normal until it has.",
};
export const NORMAL_TITLE = "Normal: this story's share of all buyers on Spore, against its median share over its own history (5-minute buckets older than 1 h). Not a forecast.";
export const CHART_NOTE_RAW = "Buyers per 5 min: this story is too new to have a normal yet";
export const CHART_NOTE_MULT = "Times its normal: its share of all buyers on Spore against its median share";

/// "4 min", "3 h", "2 d", "5 mo", "1 yr": a span of minutes, rounded down to its largest unit.
export function spanWords(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d} d`;
  const mo = Math.floor(d / 30.4);
  return mo < 12 ? `${mo} mo` : `${Math.floor(d / 365)} yr`;
}

/// "2.4×", "12×": one decimal under 10, whole above.
export const timesWords = (x: number): string => (x < 10 ? `${(Math.round(x * 10) / 10).toFixed(1)}×` : `${Math.round(x)}×`);

/// A coin's ticker as drawn ("$NEEDLE"): letters, digits and a few marks, at most 12; null when nothing is left.
export function tickerWords(symbol: string | null | undefined): string | null {
  if (typeof symbol !== "string") return null;
  const s = symbol.replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 12);
  return s ? `$${s}` : null;
}

export type Glance = {
  phase: StoryPhase; phaseTitle: string; muted: boolean;
  /// the buyers of the last complete 5 minutes ("12") with its label and tooltip; when that is 0 and the current 5
  /// minutes have buyers, those so far, labelled so
  partial: boolean;
  buyers: string; buyersLabel: string; buyersTitle: string;
  /// "started 18 min ago" / "first linked 3 h ago" ("" without a start)
  start: string;
  /// "$NEEDLE leads · 31%" ("" without a leader)
  leader: string;
  /// "2.4× its normal", null for a story with no normal yet
  multiple: string | null; multipleTitle: string;
};
/// Story keys one series request may name (the server's SERIES_KEYS_MAX, server/lib/attention.mjs).
export const SERIES_KEYS_MAX = 24;
/// The key a story chart reads (GET /api/story-series): a card of several stories asks for its keys, comma-separated
/// (the server sums them per bucket), at most SERIES_KEYS_MAX of them: the first, the largest by the card's precedence;
/// a card of one story, its own key.
export function chartKeyOf(card: Pick<StoryCard, "key" | "keys">): string {
  return card.keys && card.keys.length > 1 ? card.keys.slice(0, SERIES_KEYS_MAX).join(",") : card.key;
}

/// The glance line of a story block, or null for a card without `attention` (an older server).
export function glance(att: StoryAttention | null | undefined, nowS: number): Glance | null {
  if (!att || typeof att !== "object") return null;
  const phase: StoryPhase = (["new", "rising", "peaked", "fading", "steady"] as const).includes(att.phase) ? att.phase : "new";
  const last = whole(att.buyers5m?.last), now = whole(att.buyers5m?.now);
  const minutes = fin(att.startAt) ? Math.max(0, (nowS - att.startAt) / 60) : fin(att.minutes) ? att.minutes : null;
  const start = minutes == null ? "" : `${att.startSource === "post" ? "first linked" : "started"} ${minutes < 1 ? "just now" : `${spanWords(minutes)} ago`}`;
  const sym = tickerWords(att.leader?.symbol);
  const share = fin(att.leader?.share) ? Math.round(Math.min(1, Math.max(0, att.leader.share)) * 100) : null;
  const why: StoryNewWhy = att.newWhy === "quiet" || att.newWhy === "unseen" ? att.newWhy : "history";
  // no buyer in the last complete 5 minutes but some in the current ones: show those, labelled as a partial count
  const partial = last === 0 && now > 0;
  return {
    phase, phaseTitle: phase === "new" ? NEW_TITLE[why] : PHASE_TITLE[phase], muted: phase === "new", partial,
    buyers: count(partial ? now : last), buyersLabel: partial ? "buyers so far · this 5 min" : "buyers · 5 min",
    buyersTitle: partial
      ? "Wallets that bought $1 or more of this story's coins so far in the current 5 minutes (none in the last complete 5 minutes, or none counted yet)"
      : `Wallets that bought $1 or more of this story's coins in the last complete 5 minutes (${count(now)} so far in the current 5 minutes)`,
    start,
    leader: sym && share != null ? `${sym} leads · ${share}%` : "",
    multiple: fin(att.multiple) && att.multiple >= 0 ? `${timesWords(att.multiple)} its normal` : null,
    multipleTitle: NORMAL_TITLE,
  };
}

// ---- the chart

export type ChartMode = "multiple" | "buyers";
/// "multiple" when the story has a normal that means something (the server's `baseline.ready`), else raw buyers.
export const chartMode = (s: Pick<StorySeries, "baseline"> | null | undefined): ChartMode => (s?.baseline?.ready && fin(s.baseline.ratio) && s.baseline.ratio > 0 ? "multiple" : "buyers");

/// One point per 5-minute bucket from the series' first bucket to the last complete one before `asOf` (the right edge
/// is now: a story that went quiet ends on its zeros, so a fade shows as plainly as a rise), a bucket missing as 0
/// buyers (the story had no buyer in it). `x`: seconds since `origin`; `y`: the multiple of normal, or buyers; `buyers`
/// the real count for the tooltip. Nothing is drawn before the first bucket (not seen is not zero); with the origin at
/// the start, the axis begins there (`from` 0) so the post mark is on it.
export type AttPoint = { t: number; x: number; y: number; buyers: number; siteBuyers: number };
export type AttSeries = { mode: ChartMode; origin: number; originKind: "start" | "first"; points: AttPoint[]; postX: number | null; from: number };
/// The chart's points: x from the story's start (its post's time when it has one) when that start is at most a day
/// before the first bucket, else from the first bucket (a post a year old would squeeze the whole series to the right).
/// `postAt`: the post to mark (null for none); its x when it falls inside the series.
export function attSeries(s: StorySeries, postAt: number | null = null): AttSeries {
  const mode = chartMode(s), b = Math.max(60, whole(s.bucketS) || 300);
  const rows = (s.buckets ?? []).filter((r) => fin(r.t)).sort((x, y) => x.t - y.t);
  const firstT = rows[0]?.t ?? null;
  const near = fin(s.startAt) && firstT != null && firstT - s.startAt <= 86_400 && s.startAt <= firstT + b;
  const origin = near ? (s.startAt as number) : firstT ?? 0;
  const ratio = mode === "multiple" ? (s.baseline as { ratio: number }).ratio : 1;
  const points: AttPoint[] = [];
  if (firstT != null) {
    const by = new Map(rows.map((r) => [r.t, r]));
    const lastT = rows[rows.length - 1].t;
    // to the last complete bucket (never the one still open: its count is partial)
    const lastClosed = fin(s.asOf) ? (Math.floor(s.asOf / b) - 1) * b : lastT;
    const end = lastClosed > lastT ? lastT + Math.floor((lastClosed - lastT) / b) * b : lastT;
    // at most 14 days of buckets back from the end; a series longer than that is cut to its newest part
    for (let t = Math.max(firstT, end - 4032 * b); t <= end; t += b) {
      const r = by.get(t), buyers = whole(r?.buyers), site = whole(r?.siteBuyers);
      const y = mode === "multiple" ? (site > 0 ? buyers / site / ratio : 0) : buyers;
      points.push({ t, x: t - origin, y: fin(y) ? y : 0, buyers, siteBuyers: site });
    }
  }
  const from = points.length ? (near ? Math.min(0, points[0].x) : points[0].x) : 0;
  const px = fin(postAt) && points.length && postAt - origin >= from - b && postAt - origin <= points[points.length - 1].x + b ? postAt - origin : null;
  return { mode, origin, originKind: near ? "start" : "first", points, postX: px, from };
}

export type AttGeo = { w: number; h: number; xs: number[]; ys: number[]; line: string; oneY: number | null; postPx: number | null; max: number; x0: number; x1: number };
/// The geometry in a `w` × `h` box: a line through the points (x by time), the scale from 0 to the highest point (at
/// least 2× in "multiple" mode, so the dashed 1× line is always on it, at least 5 buyers in "buyers" mode); null for
/// fewer than two points.
export function attGeo(a: AttSeries, w: number, h: number, padX = 4, padY = 8): AttGeo | null {
  const p = a.points;
  if (p.length < 2 || !fin(w) || !fin(h) || w <= 0 || h <= 0) return null;
  let max = 0;
  for (const q of p) if (q.y > max) max = q.y;
  max = Math.max(max, a.mode === "multiple" ? 2 : 5) * 1.1;
  const x0 = fin(a.from) ? Math.min(a.from, p[0].x) : p[0].x, x1 = p[p.length - 1].x, dx = x1 - x0 || 1;
  const iw = Math.max(0, w - 2 * padX), ih = Math.max(0, h - 2 * padY);
  const px = (x: number) => padX + ((x - x0) / dx) * iw, py = (y: number) => padY + (1 - y / max) * ih;
  const xs = p.map((q) => px(q.x)), ys = p.map((q) => py(q.y));
  let line = "";
  xs.forEach((x, i) => { line += `${i ? "L" : "M"}${x.toFixed(1)} ${ys[i].toFixed(1)}`; });
  return { w, h, xs, ys, line, oneY: a.mode === "multiple" ? py(1) : null, postPx: a.postX == null ? null : Math.min(w - padX, Math.max(padX, px(a.postX))), max, x0, x1 };
}

/// The point nearest pixel `x`; -1 for none.
export function nearestAt(xs: readonly number[], x: number): number {
  let best = -1, d = Infinity;
  xs.forEach((v, i) => { const e = Math.abs(v - x); if (e < d) { d = e; best = i; } });
  return best;
}

/// "+18 min", "+3 h" after the chart's origin ("" for a negative or unknown span).
export const afterWords = (x: number): string => (fin(x) && x >= 0 ? `+${spanWords(x / 60)}` : "");

/// The hover line of a point: "14 buyers · 2.1× normal · +2 h after the start".
export function pointWords(a: AttSeries, q: AttPoint): string {
  const parts = [`${count(q.buyers)} ${q.buyers === 1 ? "buyer" : "buyers"}`];
  if (a.mode === "multiple") parts.push(`${timesWords(q.y)} normal`);
  const after = afterWords(q.x);
  if (after) parts.push(`${after} after ${a.originKind === "start" ? "the start" : "the first bucket"}`);
  return parts.join(" · ");
}
