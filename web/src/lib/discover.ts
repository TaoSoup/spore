// The Discover page (pages/Discover.tsx), the map panel's "Moving now" block (map/panel/MovingBlock.tsx) and the wake-up
// alerts (components/WakeAlerts.tsx): families whose existing coins are being bought far above their normal level
// (GET /api/discover, `Discover` in lib/api.ts; SSE `wake`), as words, a sparkline and an order. Pure: no DOM, no
// network, no storage (test/discover.test.mts). Every line says what is measured ("buying 14x its normal", "170 buyers
// in 5 min"), never why, never what a coin will do, and a linked post is only what coincided.
import type { CoinRow, CoinSafety, DiscoverOne, Tf, Trade, TrendRow, WakeCoin, WakeEvent, WakeFamily, WakePost } from "./api";
import { compact, count, plural, short } from "./format";
import { postHandle, postText, safePostUrl } from "./narrative";
import { PRESET_COUNT } from "./trade-settings";

/// How often the page reads the list while its tab is visible (the server caches it 5 s). A wake-up is measured per
/// 5-minute bucket, so a read every 10 s shows a closed bucket within seconds of the server.
export const DISCOVER_POLL_MS = 10_000;
/// "Started N min ago" is re-read from the clock on this interval, without asking the server.
export const AGO_TICK_MS = 15_000;
/// The map panel's block reads its parent again on this interval while the panel is open (and the tab visible).
export const MOVING_POLL_MS = 30_000;
/// The sparkline's points: one per 5-minute bucket over the last 2 h, oldest first.
export const SPARK_POINTS = 24;
/// On a touch screen the list counts as in use for this long after a tap or the start of a scroll on it (a finger gives
/// no hover, so without it the cards would re-sort between taps).
export const TOUCH_HOLD_MS = 5_000;
/// At most one notification per parent in this long (a new wake-up of a parent starts at most once per 3 h anyway).
export const ALERT_GAP_S = 3 * 3600;
/// The stored alert switch (localStorage) and the parents last notified (with when).
export const ALERT_KEY = "spore:wake-alerts";
export const ALERTED_KEY = "spore:wake-alerted";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const whole = (n: unknown): number => (finite(n) && n > 0 ? Math.floor(n) : 0);

/// "just now", "4 min ago", "1 h 20 min ago", "5 h ago": how long ago `at` (unix s) was at `nowS`. A time ahead of the
/// clock (a server a little ahead) reads as just now.
export function minAgo(at: number | null | undefined, nowS: number): string {
  if (!finite(at)) return "";
  const m = Math.floor(Math.max(0, nowS - at) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60), r = m % 60;
  return h < 3 && r > 0 ? `${h} h ${r} min ago` : `${h} h ago`;
}
/// The card's pill: "Started 4 min ago", and "Started 4 min ago · cooling" once the latest bucket fell under 3x.
export const startedText = (f: { startedAt: number; state: string }, nowS: number): string =>
  `Started ${minAgo(f.startedAt, nowS)}${f.state === "cooling" ? " · cooling" : ""}`;

/// A ratio as "14x", "5.2x", "3x": whole from 10x up, one decimal under it ("5.0x" reads "5x").
export function ratioX(r: number | null | undefined): string {
  if (!finite(r) || r <= 0) return "—";
  return r >= 10 ? `${count(Math.round(r))}x` : `${r.toFixed(1).replace(/\.0$/, "")}x`;
}
/// The card's measured line. Live: "Buying 14x its normal · 170 buyers in 5 min · 12 coins trading"; cooling: "Buying
/// 2.1x its normal, down from 14x". The server sends ratio 0 when the parent had no trade in the latest complete
/// bucket: "No buying in the last 5 min, down from 14x" (never "Buying — its normal").
export function ratioLine(f: Pick<WakeFamily, "state" | "ratio" | "peakRatio" | "buyers5m" | "coinsTrading">): string {
  if (!(finite(f.ratio) && f.ratio > 0)) return `No buying in the last 5 min, down from ${ratioX(f.peakRatio)}`;
  if (f.state === "cooling") return `Buying ${ratioX(f.ratio)} its normal, down from ${ratioX(f.peakRatio)}`;
  return `Buying ${ratioX(f.ratio)} its normal · ${plural(whole(f.buyers5m), "buyer")} in 5 min · ${plural(whole(f.coinsTrading), "coin")} trading`;
}

/// A coin's price now against the start, as the "Since start" column: "+61%" (tone up), "−38%" (down), "0%" (flat).
/// A new coin (launched within 30 min of the start, or since) reads "new" whatever the server sends: measured from its
/// first trade it would count its own launch buy (+1,046%). An existing coin without a start price reads "—".
export type Since = { text: string; tone: "up" | "down" | "flat" | "new" };
export function sinceStart(x: number | null | undefined, existing = true): Since {
  if (!existing) return { text: "new", tone: "new" };
  if (!finite(x) || x <= 0) return { text: "—", tone: "flat" };
  const p = (x - 1) * 100, a = Math.abs(p);
  if (a < 0.5) return { text: "0%", tone: "flat" };
  const s = a >= 10 ? count(Math.round(a)) : a.toFixed(1).replace(/\.0$/, "");
  return p > 0 ? { text: `+${s}%`, tone: "up" } : { text: `−${s}%`, tone: "down" };
}

/// 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 101st, 111th.
export function ordinal(n: number): string {
  const k = Math.floor(n), t = k % 100;
  const suf = t >= 11 && t <= 13 ? "th" : k % 10 === 1 ? "st" : k % 10 === 2 ? "nd" : k % 10 === 3 ? "rd" : "th";
  return `${k}${suf}`;
}
/// Under a new coin's name: "6th copy of this post" when 5 earlier children of the parent link the same post; nothing
/// for the first coin linking it, an existing coin, or no post.
export const copyLine = (c: Pick<WakeCoin, "existing" | "copyOf">): string | null =>
  (!c.existing && finite(c.copyOf) && c.copyOf >= 1 ? `${ordinal(Math.floor(c.copyOf) + 1)} copy of this post` : null);
/// The small tag beside a coin's name.
export const coinTag = (c: Pick<WakeCoin, "existing">): "existing" | "new" => (c.existing ? "existing" : "new");
export const TAG_TITLE = { existing: "Launched more than 30 min before this family woke up", new: "Launched less than 30 min before this family woke up, or since" } as const;
/// The same tag on a family that is not waking up (the map panel's quiet answer measures against now).
export const TAG_TITLE_QUIET = { existing: "Launched more than 30 min ago", new: "Launched in the last 30 min" } as const;

/// The card's foot: "8 more trading · 23 hidden: creator sold out or repeat launch · 4 dust", each part only when it is
/// not 0; null when all are. `footParts` gives each part with its own tooltip.
export const HIDDEN_WHY = "creator sold out or repeat launch";
export const HIDDEN_TITLE = "Left out: the creator sold 90% or more of its own buy within 10 minutes, launched 10 or more coins in the hour before, or launched the same ticker under this parent again.";
export const DUST_TITLE = "Left out: coins trading now with a market cap under $1,000.";
export function footParts(more: number | null | undefined, hidden: number | null | undefined, dust?: number | null): { text: string; title?: string }[] {
  const parts: { text: string; title?: string }[] = [];
  if (whole(more) > 0) parts.push({ text: `${count(whole(more))} more trading` });
  if (whole(hidden) > 0) parts.push({ text: `${count(whole(hidden))} hidden: ${HIDDEN_WHY}`, title: HIDDEN_TITLE });
  if (whole(dust) > 0) parts.push({ text: `${count(whole(dust))} dust`, title: DUST_TITLE });
  return parts;
}
export function footLine(more: number | null | undefined, hidden: number | null | undefined, dust?: number | null): string | null {
  const parts = footParts(more, hidden, dust);
  return parts.length ? parts.map((p) => p.text).join(" · ") : null;
}

/// The muted post line: "Linked post · @handle · 6 min ago · the post's text" once the text is known; before that (or
/// without one) "Post linked by 4 coins". It always says on screen that the coins link it (a phone has no hover for
/// POST_NOTE), so the post never reads as the card's explanation. `href` is rebuilt from the id (never the body's url);
/// null for a bad id, and the line is then shown without a link.
export type PostLine = { href: string | null; handle: string | null; ago: string; text: string; fallback: string; body: string };
export const POST_LEAD = "Linked post";
export function postLine(p: WakePost, nowS: number): PostLine {
  const h = postHandle(p), handle = h ? `@${h}` : null, ago = minAgo(p.at, nowS), text = postText(p);
  const fallback = `Post linked by ${plural(whole(p.coins), "coin")}`;
  const body = handle || text ? [POST_LEAD, handle, ago, text].filter(Boolean).join(" · ") : fallback;
  return { href: safePostUrl(p.id), handle, ago, text, fallback, body };
}
export const POST_NOTE = "Linked by coins in this family; posts are picked by coin creators and aren't checked. It coincided with the buying, nothing more is known.";
/// Under the list: what the page is and is not.
export const FOOT_NOTE = "Most coins that jump give it back within hours. This page shows buying as it happens; it is not a forecast.";

/// The sparkline's geometry in a w × h box: the polyline of `spark` (padded to SPARK_POINTS on the old side, anything
/// that is not a count reads as 0) and the faint band from the floor up to the baseline. The scale's top is the
/// higher of the peak and 1.25 × the baseline, so a quiet family's line does not fill the box.
export type SparkGeom = { points: string; bandY: number; last: { x: number; y: number }; values: number[] };
export function sparkGeom(spark: unknown, baseline: number | null | undefined, w: number, h: number, pad = 2): SparkGeom {
  const src = Array.isArray(spark) ? spark.slice(-SPARK_POINTS) : [];
  const values = [...Array.from({ length: SPARK_POINTS - src.length }, () => 0), ...src.map(whole)];
  const base = finite(baseline) && baseline > 0 ? baseline : 0;
  const top = Math.max(1, ...values, base * 1.25);
  const y = (v: number) => Math.round((h - pad - (v / top) * (h - 2 * pad)) * 10) / 10;
  const x = (i: number) => Math.round((pad + (i * (w - 2 * pad)) / (SPARK_POINTS - 1)) * 10) / 10;
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return { points, bandY: y(base), last: { x: x(SPARK_POINTS - 1), y: y(values[SPARK_POINTS - 1]) }, values };
}
/// The sparkline in words: "Buyers per 5 minutes over the last 2 hours: 170 now, 4 two hours ago, normal is about 12".
export function sparkLabel(f: Pick<WakeFamily, "spark" | "baseline">): string {
  const v = sparkGeom(f.spark, f.baseline, 100, 20).values;
  const base = finite(f.baseline) && f.baseline > 0 ? f.baseline : 0;
  const norm = base >= 10 ? count(Math.round(base)) : base.toFixed(1).replace(/\.0$/, "");
  return `Buyers per 5 minutes over the last 2 hours: ${count(v[SPARK_POINTS - 1])} now, at most ${count(Math.max(...v))}, ${count(v[0])} two hours ago; normal is about ${norm}`;
}

/// A card on screen: a listed family, or (`left`) one kept after the server stopped listing it, while the list is in
/// use (it is dimmed and says so; it goes once the list is idle).
export type FamilyRow = WakeFamily & { left?: boolean };
const mintOf = (f: { parent?: { mint?: unknown } } | null | undefined): string | null => (f && f.parent && typeof f.parent.mint === "string" ? f.parent.mint : null);
/// The cards after a read. Idle (`hold` false): the fresh list in the server's order (live, newest first, then
/// cooling). In use (`hold`: a mouse over the list, a tap on it in the last few seconds, or keyboard focus in it):
/// nothing on screen moves. The cards keep their order and take the fresh numbers in place (keepShown), a family new to
/// the list is added at the end, and one the server dropped stays where it is with its last numbers, marked `left`. A
/// broken or repeated entry makes no card.
export function familyRows(fresh: { families?: unknown } | null | undefined, shown: readonly FamilyRow[], hold = false): FamilyRow[] {
  const by = new Map<string, WakeFamily>();
  for (const f of fresh && Array.isArray(fresh.families) ? (fresh.families as WakeFamily[]) : []) {
    const m = mintOf(f);
    if (m && !by.has(m)) by.set(m, f);
  }
  if (!hold) return [...by.values()];
  const kept = new Set<string>(), rows: FamilyRow[] = [];
  for (const r of shown) {
    const m = r.parent.mint;
    if (kept.has(m)) continue;
    kept.add(m);
    const f = by.get(m);
    rows.push(f ? keepShown(f, r) : r.left ? r : { ...r, left: true });
  }
  for (const [m, f] of by) if (!kept.has(m)) rows.push(f);
  return rows;
}
/// A held card: the fresh numbers in the shape on screen. The server re-ranks a card's coins at each bucket close and a
/// card turning live -> cooling folds, so a Buy under a resting pointer could become another coin's or another card's.
/// Held, the coins on screen keep their rows (fresh numbers, or their last ones once dropped) and none is added, the
/// shown state (so the fold) stays, and a post or foot line that was not there does not appear. Idle again, the
/// server's card comes back whole.
function keepShown(f: WakeFamily, r: FamilyRow): FamilyRow {
  const fresh = new Map<string, WakeCoin>();
  for (const c of Array.isArray(f.coins) ? f.coins : []) if (c && typeof c.mint === "string" && !fresh.has(c.mint)) fresh.set(c.mint, c);
  const coins = (Array.isArray(r.coins) ? r.coins : []).map((c) => fresh.get(c.mint) ?? c);
  const foot = footLine(r.more, r.hidden, r.dust) !== null;
  return { ...f, coins, state: r.state, post: r.post ? f.post ?? r.post : null, more: foot ? f.more : r.more, hidden: foot ? f.hidden : r.hidden, dust: foot ? f.dust : r.dust };
}
export const LEFT_PILL = "No longer listed";

/// The map panel's block. Caption: "Waking up · started 4 min ago · 14x its normal" for a live family, "Cooling · ..."
/// for a cooling one (the ratio left out when the latest bucket had no buying), else "Moving now"; at most three coins,
/// one line each, and only coins someone bought: a coin that was only sold is not moving.
export function movingCaption(d: DiscoverOne, nowS: number): string {
  if (d.state === "quiet" || !finite(d.startedAt)) return "Moving now";
  const tail = finite(d.ratio) && d.ratio > 0 ? ` · ${ratioX(d.ratio)} its normal` : "";
  return `${d.state === "cooling" ? "Cooling" : "Waking up"} · started ${minAgo(d.startedAt, nowS)}${tail}`;
}
/// A row's buyers: a quiet answer ranks by the last 15 min (the latest 5-min bucket alone is often empty), a waking
/// family by the latest bucket.
export function movingBuyers(d: Pick<DiscoverOne, "state">, c: Pick<WakeCoin, "buyers5m" | "buyers15m">): { n: number; title: string } {
  return d.state === "quiet" && finite(c.buyers15m)
    ? { n: whole(c.buyers15m), title: "Wallets that bought in the last 15 minutes" }
    : { n: whole(c.buyers5m), title: "Wallets that bought in the last 5 minutes" };
}
export const movingCoins = (d: DiscoverOne | null | undefined): WakeCoin[] =>
  (d && Array.isArray(d.coins) ? d.coins.filter((c) => c && typeof c.mint === "string" && (whole(c.buyers5m) > 0 || whole(c.buyers15m) > 0)).slice(0, 3) : []);

// ---- the page's controls: timeframe, tab and buy-amount slot (per-viewer conveniences in localStorage)

/// The timeframes of a coin row's numbers (`tf=` on /api/discover and /api/trending); 5m unless the reader picked another.
export const TFS: readonly Tf[] = ["1m", "5m", "30m", "1h"];
export const DEFAULT_TF: Tf = "5m";
export const TF_KEY = "spore:dsc-tf";
export const TAB_KEY = "spore:dsc-tab";
/// Which of the trade settings' three buy presets (P1, P2, P3) the rows' Buy uses. Only the index is kept here: the
/// amounts stay in the trade settings (lib/trader.ts useTradeSettings), edited in their own dialog.
export const SLOT_KEY = "spore:dsc-slot";
export type DscTab = "waking" | "trending";
export const parseTf = (raw: unknown): Tf => ((TFS as readonly unknown[]).includes(raw) ? (raw as Tf) : DEFAULT_TF);
export const parseTab = (raw: unknown): DscTab => (raw === "trending" ? "trending" : "waking");
export function parseSlot(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d$/.test(raw)) return 0;
  const n = Number(raw);
  return n < PRESET_COUNT ? n : 0;
}
/// Storage is reached through a thunk: reading `localStorage` itself throws where site data is blocked.
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
export function readPref<T>(store: () => Store | null | undefined, key: string, parse: (raw: string | null) => T): T {
  try { return parse(store()?.getItem(key) ?? null); } catch { return parse(null); }
}
export function writePref(store: () => Store | null | undefined, key: string, value: string): void {
  try { store()?.setItem(key, value); } catch { /* blocked storage: the choice lasts for this visit only */ }
}
/// "the last 5 min", "the last minute", "the last hour".
const TF_WORDS: Record<Tf, string> = { "1m": "minute", "5m": "5 min", "30m": "30 min", "1h": "hour" };
export const tfWords = (tf: Tf): string => `the last ${TF_WORDS[tf] ?? TF_WORDS[DEFAULT_TF]}`;
export const TF_TITLE: Record<Tf, string> = { "1m": "Numbers over the last minute", "5m": "Numbers over the last 5 minutes", "30m": "Numbers over the last 30 minutes", "1h": "Numbers over the last hour" };
export const emptyTrending = (tf: Tf): string => `Nothing is being bought in ${tfWords(tf)}.`;
export const trendingSub = (tf: Tf): string => `Coins by how many wallets bought them in ${tfWords(tf)}`;
/// The Buy button's words: "Buy 0.5 SOL".
export const buyLabel = (sol: number): string => `Buy ${finite(sol) && sol > 0 ? +sol.toFixed(4) : "—"} SOL`;

// ---- a coin row's numbers

export type Tone = "up" | "down" | "flat";
/// A change in percent: "+12.3%" up, "−4%" down, "0%" flat under 0.05; whole from 100% up ("+1,150%"); "—" unknown.
export function chgText(chg: number | null | undefined): { text: string; tone: Tone } {
  if (!finite(chg)) return { text: "—", tone: "flat" };
  const a = Math.abs(chg);
  if (a < 0.05) return { text: "0%", tone: "flat" };
  const s = a >= 100 ? count(Math.round(a)) : a.toFixed(1).replace(/\.0$/, "");
  return chg > 0 ? { text: `+${s}%`, tone: "up" } : { text: `−${s}%`, tone: "down" };
}
/// Txns: the total, and buys / sells under it. The two parts are compact ("2.35K"): each sits on its own short line
/// of a cell about 58 px wide on a phone, where "2,345 / 1,567" ran into the next column.
export function txns(tf: CoinRow["tf"]): { total: string; buys: string; sells: string } {
  const b = whole(tf?.buys), s = whole(tf?.sells);
  return tf ? { total: count(b + s), buys: compact(b), sells: compact(s) } : { total: "—", buys: "—", sells: "—" };
}
/// A share as it is shown: whole from 10% up, else 1 dp. The amber rule compares this, not the raw share, so a chip
/// never reads "Top 10 50%" in neutral under "Amber at 50% or more" (the server sends 49.6).
export const shownPct = (n: number): number => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
/// A share of supply: "4%", "0.4%", "12%", "<0.1%".
export function pctText(n: number | null | undefined): string {
  if (!finite(n) || n < 0) return "—";
  if (n === 0) return "0%";
  if (n < 0.1) return "<0.1%";
  const v = shownPct(n);
  return n >= 10 ? `${count(v)}%` : `${v.toFixed(1).replace(/\.0$/, "")}%`;
}

/// The safety chips: measured shares of supply, neutral, amber at or above a stated threshold (named in the title).
/// "…" for the two chain figures (dev, top 10) while the server is still reading them ("pending" is about those reads;
/// the sniper share comes from the recorded launch, known or not at once); a figure that is not known is not shown.
/// A known figure shows whatever the state: the sniper share stays when the chain read failed ("unknown").
export const SAFETY_AMBER = { dev: 10, top10: 50, snipers: 20 } as const;
export type SafetyChip = { key: keyof typeof SAFETY_AMBER; text: string; amber: boolean; pending: boolean; title: string };
const SAFETY_WORDS = {
  dev: { label: "Dev", title: (p: string) => `The creator's wallet holds ${p} of the supply now. Amber at ${SAFETY_AMBER.dev}% or more.`, wait: "Reading the creator's holding from the chain" },
  top10: { label: "Top 10", title: (p: string) => `The 10 largest holders hold ${p} of the supply, not counting the bonding curve or pool. Amber at ${SAFETY_AMBER.top10}% or more.`, wait: "Reading the largest holders from the chain" },
  snipers: { label: "Snipers", title: (p: string) => `Wallets other than the creator bought ${p} of the supply in the launch block or the first 3 seconds. Amber at ${SAFETY_AMBER.snipers}% or more.`, wait: "Reading the launch buys" },
} as const;
export function safetyChips(s: CoinSafety | null | undefined): SafetyChip[] {
  if (!s || typeof s !== "object") return [];
  const vals = { dev: s.devPct, top10: s.top10Pct, snipers: s.sniperPct };
  const out: SafetyChip[] = [];
  for (const key of ["dev", "top10", "snipers"] as const) {
    const v = vals[key], w = SAFETY_WORDS[key];
    if (finite(v) && v >= 0) out.push({ key, text: `${w.label} ${pctText(v)}`, amber: shownPct(v) >= SAFETY_AMBER[key], pending: false, title: w.title(pctText(v)) });
    else if (s.state === "pending" && key !== "snipers") out.push({ key, text: `${w.label} …`, amber: false, pending: true, title: w.wait });
  }
  return out;
}

/// A coin row's sparkline: the USD close of each 2-minute step over the last hour (30 points, oldest first) in a w x h
/// box. Steps before the first trade (null) are skipped, so the line starts where the coin's trading does; the scale is
/// the points' own low to high. Green ("up") when the last close is at or above the first, red ("down") otherwise.
export const COIN_SPARK_POINTS = 30;
export type CoinSparkGeom = { d: string; tone: Tone; first: number | null; last: number | null };
export function coinSparkPath(p: unknown, w: number, h: number, pad = 1.5): CoinSparkGeom {
  const src = Array.isArray(p) ? p.slice(-COIN_SPARK_POINTS) : [];
  const off = COIN_SPARK_POINTS - src.length;
  const pts: { i: number; v: number }[] = [];
  src.forEach((v, i) => { if (finite(v) && v > 0) pts.push({ i: i + off, v }); });
  if (!pts.length) return { d: "", tone: "flat", first: null, last: null };
  let lo = Infinity, hi = -Infinity;
  for (const q of pts) { if (q.v < lo) lo = q.v; if (q.v > hi) hi = q.v; }
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const x = (i: number) => r1(pad + (i * (w - 2 * pad)) / (COIN_SPARK_POINTS - 1));
  const y = (v: number) => r1(hi === lo ? h / 2 : h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad));
  // one point alone is drawn as a short level stroke, so a coin with a single trade still shows a mark
  const d = pts.length === 1
    ? `M${r1(x(pts[0].i) - 2)},${y(pts[0].v)}L${x(pts[0].i)},${y(pts[0].v)}`
    : pts.map((q, k) => `${k ? "L" : "M"}${x(q.i)},${y(q.v)}`).join("");
  const first = pts[0].v, last = pts[pts.length - 1].v;
  return { d, tone: last >= first ? "up" : "down", first, last };
}
export function coinSparkLabel(g: Pick<CoinSparkGeom, "first" | "last">): string {
  if (!finite(g.first) || !finite(g.last)) return "Price over the last hour: no trades";
  return `Price over the last hour: ${chgText((g.last / g.first - 1) * 100).text} from the first trade shown to the last`;
}

// ---- live numbers between reads (SSE "trade")

/// A row on screen can carry `flash` (the market cap moved on a trade: its cell flashes once; `n` restarts the
/// animation), `liveAt` (the on-chain time of the last trade applied, so an older trade arriving late changes nothing)
/// and `liveRecvAt` (when that trade reached this page, ms on this browser's clock: what a read is compared with, see
/// carryLive).
export type Flash = { dir: "up" | "down"; n: number };
export type Live = { flash?: Flash; liveAt?: number; liveRecvAt?: number };
/// `at`: when the SSE trade arrived here (Date.now()).
export type LiveTrade = Pick<Trade, "mint" | "time" | "priceUsd"> & { at?: number };
const r1dp = (n: number) => Math.round(n * 10) / 10;
/// A row after one trade of its coin: the price, the market cap (scaled by new / old price), the change against the
/// timeframe's start price, and the sparkline's last close (the window slides on when the trade is in a later step;
/// the steps passed over keep the last close, as the server fills them). Anything else waits for the next read.
/// Returns the same object when the trade does not apply. `quiet`: no flash (a live price carried over a read).
export function liveMerge<R extends CoinRow & Live>(row: R, t: LiveTrade, quiet = false): R {
  const p = t.priceUsd;
  if (!row || t.mint !== row.mint || !finite(p) || p <= 0 || !finite(t.time)) return row;
  if (finite(row.liveAt) && t.time < row.liveAt) return row;
  const old = row.priceUsd;
  const mcapUsd = finite(old) && old > 0 && finite(row.mcapUsd) ? row.mcapUsd * (p / old) : row.mcapUsd;
  const tf = row.tf && finite(row.tf.p0) && row.tf.p0 > 0 ? { ...row.tf, chg: r1dp((p / row.tf.p0 - 1) * 100) } : row.tf;
  let spark = row.spark;
  if (spark && Array.isArray(spark.p) && spark.p.length && finite(spark.from) && finite(spark.step) && spark.step > 0) {
    const len = spark.p.length, idx = Math.floor((t.time - spark.from) / spark.step);
    if (idx === len - 1) spark = { ...spark, p: [...spark.p.slice(0, -1), p] };
    else if (idx >= len) {
      const k = Math.min(len, idx - len + 1);
      let close: number | null = null;
      for (let i = len - 1; i >= 0 && close === null; i--) { const v = spark.p[i]; if (finite(v)) close = v; }
      const pts = [...spark.p.slice(k), ...Array.from({ length: k - 1 }, () => close), p];
      spark = { ...spark, from: spark.from + (idx - len + 1) * spark.step, p: pts.slice(-len) };
    }
  }
  const dir = finite(old) ? (p > old ? "up" : p < old ? "down" : null) : null;
  const flash = !quiet && dir ? { dir, n: (row.flash?.n ?? 0) + 1 } : row.flash;
  return { ...row, priceUsd: p, mcapUsd, tf, spark, flash, liveAt: t.time, liveRecvAt: finite(t.at) ? t.at : row.liveRecvAt };
}
/// The trades of a batch by mint, oldest first.
export function tradesByMint(ts: readonly LiveTrade[]): Map<string, LiveTrade[]> {
  const by = new Map<string, LiveTrade[]>();
  for (const t of ts) if (t && typeof t.mint === "string") { const l = by.get(t.mint); if (l) l.push(t); else by.set(t.mint, [t]); }
  for (const l of by.values()) l.sort((a, b) => a.time - b.time);
  return by;
}
/// Rows after a batch of trades; the same array when none applied (so nothing renders again).
export function liveRows<R extends CoinRow & Live>(rows: readonly R[], by: Map<string, LiveTrade[]>): R[] {
  let changed = false;
  const out = rows.map((r) => {
    const ts = r ? by.get(r.mint) : undefined;
    if (!ts) return r;
    let n = r;
    for (const t of ts) n = liveMerge(n, t);
    if (n !== r) changed = true;
    return n;
  });
  return changed ? out : (rows as R[]);
}
export function liveFamilies<F extends { coins: (CoinRow & Live)[] }>(rows: readonly F[], by: Map<string, LiveTrade[]>): F[] {
  let changed = false;
  const out = rows.map((f) => {
    if (!Array.isArray(f.coins)) return f;
    const coins = liveRows(f.coins, by);
    if (coins === f.coins) return f;
    changed = true;
    return { ...f, coins };
  });
  return changed ? out : (rows as F[]);
}
/// How long before a read's answer arrived a live trade may have reached the page and still be missing from it: the
/// server caches the answer 5 s (wakeups.mjs WAKE_TTL_MS) and it takes a moment to arrive. Not the answer's `asOf`: that
/// is the server's clock, a trade's time is the chain's (a few seconds behind on a busy slot or a lagging indexer), so
/// comparing the two dropped a live price on most reads of a busy coin.
export const LIVE_CARRY_MS = 7_000;
/// After a read (its answer arrived at `readAt`, ms on this browser's clock): a coin whose last live trade arrived
/// within LIVE_CARRY_MS before that keeps the live price, so a read does not pull the market cap back and forth. The
/// stream gives trades in the order the server applies them, so a trade that arrived earlier is in the answer. A row
/// not carried keeps `liveAt` as a floor, so a trade older than one already applied (late on the stream) does not
/// move the server's newer price back.
export function carryLive<R extends CoinRow & Live>(fresh: readonly R[], shown: readonly (CoinRow & Live)[], readAt: number, windowMs = LIVE_CARRY_MS): R[] {
  const was = new Map<string, CoinRow & Live>();
  for (const r of shown) if (r && finite(r.liveAt)) was.set(r.mint, r);
  if (!was.size) return fresh as R[];
  return fresh.map((r) => {
    const w = r ? was.get(r.mint) : undefined;
    if (!w) return r;
    const recent = finite(w.liveRecvAt) && w.liveRecvAt > readAt - windowMs && finite(w.priceUsd);
    if (!recent) return finite(r.liveAt) ? r : { ...r, liveAt: w.liveAt };
    const n = liveMerge(r, { mint: r.mint, time: w.liveAt as number, priceUsd: w.priceUsd as number, at: w.liveRecvAt }, true);
    return n === r ? r : { ...n, flash: w.flash };
  });
}
export function carryLiveFamilies<F extends { coins: (CoinRow & Live)[] }>(fresh: readonly F[], shown: readonly F[], readAt: number, windowMs = LIVE_CARRY_MS): F[] {
  const all = shown.flatMap((f) => (Array.isArray(f.coins) ? f.coins : []));
  if (!all.some((c) => c && finite(c.liveAt))) return fresh as F[];
  return fresh.map((f) => (Array.isArray(f.coins) ? { ...f, coins: carryLive(f.coins, all, readAt, windowMs) } : f));
}
/// The mints whose trades the page follows: the coin rows on screen (a folded card shows none).
export function screenMints(fams: readonly { coins?: { mint: string }[]; state?: string }[] | null, trend: readonly { mint: string }[] | null, opened?: ReadonlySet<string>): Set<string> {
  const s = new Set<string>();
  for (const f of fams ?? []) {
    const folded = f.state === "cooling" && !(opened && "parent" in f && opened.has((f as { parent: { mint: string } }).parent.mint));
    if (!folded) for (const c of Array.isArray(f.coins) ? f.coins : []) if (c && typeof c.mint === "string") s.add(c.mint);
  }
  for (const r of trend ?? []) if (r && typeof r.mint === "string") s.add(r.mint);
  return s;
}

// ---- the family card: chart markers, the post as a block, the folded line

/// Where the wake-up's start and the post's time fall on the family chart (sparkGeom's x, as a percent of its width):
/// null outside the 2 h it shows. A time in the bucket after the last complete one sits on the last point.
export function chartMarks(f: { sparkFrom?: number | null; startedAt: number | null; post?: { at: number | null } | null }, bucketS: number, w = 240, pad = 2): { start: number | null; post: number | null } {
  const at = (t: number | null | undefined): number | null => {
    if (!finite(f.sparkFrom) || !finite(t) || !(bucketS > 0)) return null;
    const i = (t - f.sparkFrom) / bucketS;
    if (i < 0 || i >= SPARK_POINTS + 1) return null;
    const x = pad + (Math.min(i, SPARK_POINTS - 1) * (w - 2 * pad)) / (SPARK_POINTS - 1);
    return Math.round((x / w) * 1000) / 10;
  };
  return { start: at(f.startedAt), post: at(f.post?.at) };
}
export const startMarkTitle = (startedAt: number, nowS: number): string => `Buying jumped here: the wake-up started ${minAgo(startedAt, nowS)}`;
export const postMarkTitle = (at: number, nowS: number): string => `The linked post was posted here, ${minAgo(at, nowS)}`;
/// The family chart in words: the sparkline's sentence, then the two markers when they are shown.
export function familyChartLabel(f: Pick<WakeFamily, "spark" | "baseline" | "startedAt" | "post"> & { sparkFrom?: number }, bucketS: number, nowS: number): string {
  const m = chartMarks(f, bucketS);
  return [sparkLabel(f), m.start !== null ? startMarkTitle(f.startedAt, nowS) : "", m.post !== null && f.post && finite(f.post.at) ? postMarkTitle(f.post.at, nowS) : ""].filter(Boolean).join(". ");
}

/// A span of time: "6 min", "1 h 23 min", "5 h", "3 days".
export function durText(s: number): string {
  const m = Math.round(Math.abs(s) / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return h < 3 && r > 0 ? `${h} h ${r} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}
/// When the post was posted, against the start of the buying: "Posted 6 min before buying jumped", "... after ...",
/// "Posted as buying jumped" within a minute; without a lead "Posted 3 h ago"; "" when its time is unknown. Only the
/// order in time: a post is what coincided, never the cause.
export function postLead(p: Pick<WakePost, "at" | "lead">, startedAt: number | null | undefined, nowS: number): string {
  const lead = p.lead !== undefined ? p.lead : finite(p.at) && finite(startedAt) ? startedAt - p.at : null;
  if (finite(lead)) return Math.abs(lead) < 60 ? "Posted as buying jumped" : `Posted ${durText(lead)} ${lead > 0 ? "before" : "after"} buying jumped`;
  return finite(p.at) ? `Posted ${minAgo(p.at, nowS)}` : "";
}
/// The post's words as a block: the known text with its paragraphs (blank runs cut to one empty line), plain text.
export const postBody = (p: Pick<WakePost, "state" | "text">): string =>
  (p.state === "ok" && typeof p.text === "string" ? p.text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "");
export type PostBlock = { href: string | null; handle: string | null; lead: string; text: string; linked: string };
export function postBlock(p: WakePost, startedAt: number | null | undefined, nowS: number): PostBlock {
  const h = postHandle(p);
  return { href: safePostUrl(p.id), handle: h ? `@${h}` : null, lead: postLead(p, startedAt, nowS), text: postBody(p), linked: `Linked by ${plural(whole(p.coins), "coin")}` };
}
/// A cooling card folded to one line: "$SYM · cooling · started 1 h 23 min ago · down from 19x".
export function coolingLine(f: Pick<WakeFamily, "parent" | "startedAt" | "peakRatio">, nowS: number): string {
  const p = f.parent, name = p.symbol ? `$${p.symbol}` : p.name || short(p.mint);
  return [name, "cooling", `started ${minAgo(f.startedAt, nowS)}`, finite(f.peakRatio) && f.peakRatio > 0 ? `down from ${ratioX(f.peakRatio)}` : ""].filter(Boolean).join(" · ");
}

// ---- the Trending tab

/// A trending row on screen (`left`: the server stopped listing it while the list was in use; dimmed, gone once idle).
export type TrendShown = TrendRow & Live & { left?: boolean };
/// The rows after a read, held like the families (familyRows): idle, the server's order; in use, the rows on screen
/// keep their places with fresh numbers, a new coin goes last and one that left stays, marked.
export function trendRows(fresh: { rows?: unknown } | null | undefined, shown: readonly TrendShown[], hold = false): TrendShown[] {
  const by = new Map<string, TrendRow>();
  for (const r of fresh && Array.isArray(fresh.rows) ? (fresh.rows as TrendRow[]) : []) if (r && typeof r.mint === "string" && !by.has(r.mint)) by.set(r.mint, r);
  if (!hold) return [...by.values()];
  const kept = new Set<string>(), rows: TrendShown[] = [];
  for (const r of shown) {
    if (kept.has(r.mint)) continue;
    kept.add(r.mint);
    const f = by.get(r.mint);
    rows.push(f ?? (r.left ? r : { ...r, left: true }));
  }
  for (const [m, r] of by) if (!kept.has(m)) rows.push(r);
  return rows;
}
/// The small tags of a trending row: "under $FIONA" (its parent) and the family's state when it is on Discover.
export const parentTag = (r: Pick<TrendRow, "parent">): string | null => (r.parent && typeof r.parent.mint === "string" ? `under ${r.parent.symbol ? `$${r.parent.symbol}` : short(r.parent.mint)}` : null);
export const familyPill = (r: Pick<TrendRow, "family">): string | null => (r.family === "live" ? "waking up" : r.family === "cooling" ? "cooling" : null);

// ---- alerts

/// The alert button. "unsupported": the browser can't show a notification from a page (none at all, or only through a
/// service worker, as Chrome on Android, which this site does not register); "denied": the reader (or the browser) blocked
/// them for this site, and only the browser's own settings can undo that, so the button says so and offers nothing.
export type AlertUi = "unsupported" | "denied" | "on" | "off";
export function alertUi(permission: string | null | undefined, enabled: boolean): AlertUi {
  if (permission !== "granted" && permission !== "denied" && permission !== "default") return "unsupported";
  if (permission === "denied") return "denied";
  return permission === "granted" && enabled ? "on" : "off";
}
export const ALERT_LABEL: Record<AlertUi, string> = {
  off: "Alert me when a family wakes up",
  on: "Alerts on",
  denied: "Notifications are blocked for this site",
  unsupported: "This browser can't show notifications",
};
export const ALERT_TITLE: Record<AlertUi, string> = {
  off: "A browser notification when a family starts buying far above its normal level, while this site is open in a tab",
  on: "Notifications are on while this site is open in a tab. Click to turn them off.",
  denied: "Allow notifications for this site in your browser's settings to use alerts.",
  unsupported: "This browser can't show notifications from this site.",
};

/// When each parent was last notified (unix s). Read from storage, so anything that is not a time is dropped.
export type AlertMemo = Record<string, number>;
export function parseAlertMemo(raw: string | null | undefined): AlertMemo {
  const out: AlertMemo = {};
  if (!raw) return out;
  try {
    const o = JSON.parse(raw) as unknown;
    if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (finite(v)) out[k] = v;
  } catch { /* a broken value is an empty memo */ }
  return out;
}
/// Whether a wake-up of `mint` gets a notification now: not when one was shown for that parent less than `gapS` ago.
export const alertDue = (memo: AlertMemo, mint: string, nowS: number, gapS = ALERT_GAP_S): boolean =>
  !(finite(memo[mint]) && nowS - memo[mint] < gapS && nowS >= memo[mint]);
/// The memo after a notification for `mint`: entries older than the gap are dropped, so it stays small.
export function noteAlert(memo: AlertMemo, mint: string, nowS: number, gapS = ALERT_GAP_S): AlertMemo {
  const out: AlertMemo = {};
  for (const [k, v] of Object.entries(memo)) if (nowS - v < gapS && v <= nowS) out[k] = v;
  out[mint] = nowS;
  return out;
}
/// Only a wake-up that started in the last 30 min is notified (a reconnecting stream, or a clock far off, must not
/// bring up an old one).
export const wakeFresh = (e: Pick<WakeEvent, "startedAt">, nowS: number): boolean => finite(e.startedAt) && nowS - e.startedAt < 1800;
/// The notification: "$NVDAx is waking up · buying 14x its normal", with the buyers as its body.
export function alertText(e: WakeEvent): { title: string; body: string } {
  const p = e.parent;
  const name = p.symbol ? `$${p.symbol}` : p.name || short(p.mint);
  return { title: `${name} is waking up · buying ${ratioX(e.ratio)} its normal`, body: `${plural(whole(e.buyers5m), "buyer")} in 5 min across its coins` };
}
