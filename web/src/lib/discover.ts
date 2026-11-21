// The Discover page (pages/Discover.tsx), the map panel's "Moving now" block (map/panel/MovingBlock.tsx) and the wake-up
// alerts (components/WakeAlerts.tsx): families whose existing coins are being bought far above their normal level
// (GET /api/discover, `Discover` in lib/api.ts; SSE `wake`), as words, a sparkline and an order. Pure: no DOM, no
// network, no storage (test/discover.test.mts). Every line says what is measured ("buying 14x its normal", "170 buyers
// in 5 min"), never why, never what a coin will do, and a linked post is only what coincided.
import type { CoinRow, CoinSafety, DiscoverOne, DustReason, NarrativeRef, Stories, StoryCard, StoryCopy, StoryRow, StoryTheme, Tf, Trade, TrendRow, WakeCoin, WakeEvent, WakeFamily, WakePost } from "./api";
import { compact, count, plural, short, usd } from "./format";
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
/// The ratio counts existing coins only while "N buyers" counts every coin, so a family full of new launches read
/// "0.9x its normal · 536 buyers". When the two differ by EX_GAP or more the line says how many were in existing coins.
export const EX_GAP = 1.5;
export function ratioLine(f: Pick<WakeFamily, "state" | "ratio" | "peakRatio" | "buyers5m" | "coinsTrading" | "buyersEx5m">): string {
  if (!(finite(f.ratio) && f.ratio > 0)) return `No buying in the last 5 min, down from ${ratioX(f.peakRatio)}`;
  // "down from" only when the peak is above what is printed now: the server raises the peak to the rolling ratio, so
  // a cooling card at its own peak read "Buying 6.2x its normal, down from 6.2x"
  if (f.state === "cooling") return `Buying ${ratioX(f.ratio)} its normal${finite(f.peakRatio) && f.peakRatio > f.ratio && ratioX(f.peakRatio) !== ratioX(f.ratio) ? `, down from ${ratioX(f.peakRatio)}` : ""}`;
  const all = whole(f.buyers5m), ex = f.buyersEx5m;
  const split = finite(ex) && ex >= 0 && all > whole(ex) && all >= EX_GAP * ex ? ` (${count(whole(ex))} in existing coins)` : "";
  return `Buying ${ratioX(f.ratio)} its normal · ${plural(all, "buyer")} in 5 min${split} · ${plural(whole(f.coinsTrading), "coin")} trading`;
}
/// Whether the buying is spread over the family or sits on one coin, as counted: "5 coins with 5+ buyers each" from
/// BREADTH_COINS such coins, "Mostly one coin: $X (82% of buyers)" from a BREADTH_TOP share; nothing in between, and
/// nothing on a cooling card (its counts are near zero). The coin is named only when the server says which it is
/// (its `topSymbol`, or `topMint` among the rows): the first row is not always the most-bought coin of the measured
/// window. Neither line reads as better than the other.
export const BREADTH_COINS = 3;
export const BREADTH_TOP = 0.7;
export function breadthLine(f: Pick<WakeFamily, "state" | "coins5" | "topShare" | "topMint" | "topSymbol" | "coins">): string | null {
  if (f.state !== "live") return null;
  if (finite(f.coins5) && f.coins5 >= BREADTH_COINS) return `${count(whole(f.coins5))} coins with 5+ buyers each`;
  if (!finite(f.topShare) || f.topShare < BREADTH_TOP) return null;
  const pct = Math.round(Math.min(1, f.topShare) * 100);
  const top = typeof f.topMint === "string" && Array.isArray(f.coins) ? f.coins.find((c) => c && c.mint === f.topMint) : undefined;
  const name = typeof f.topSymbol === "string" && f.topSymbol.trim() ? `$${f.topSymbol.trim()}` : top ? (top.symbol ? `$${top.symbol}` : short(top.mint)) : "";
  return `Mostly one coin${name ? `: ${name}` : ""} (${pct}% of buyers)`;
}
/// "$4.5K bought / $3.6K sold, 5 min": the family's trailing 5 minutes as two sums, on any card. A fact in neutral
/// ink: the sign flips within minutes for about half of wake-ups, so it is not a warning and not a tag.
export function flowLine(f: Pick<WakeFamily, "bought5mUsd" | "sold5mUsd">): string | null {
  const b = f.bought5mUsd, s = f.sold5mUsd;
  if (!finite(b) || !finite(s) || b < 0 || s < 0 || (b === 0 && s === 0)) return null;
  return `${usd(b)} bought / ${usd(s)} sold, 5 min`;
}
/// Existing coins only (the server's sums leave new launches out), so the title says so.
export const FLOW_TITLE = "USD bought and sold in this family's existing coins (launched more than 30 min ago) over the last 5 minutes";
/// The card's second line: the breadth and the flow, each only when the server sends it.
export const factsLine = (f: Parameters<typeof breadthLine>[0] & Parameters<typeof flowLine>[0]): string | null =>
  [breadthLine(f), flowLine(f)].filter(Boolean).join(" · ") || null;
/// A wake-up of a family that is busy most of the time starts without a notification (the server's `silent`).
export const SILENT_TITLE = "No alert was sent for this start: this family's normal level is already high.";

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
/// `map`: the part is a link to the parent on the map, the only place those other coins can be seen.
export function footParts(more: number | null | undefined, hidden: number | null | undefined, dust?: number | null): { text: string; title?: string; map?: true }[] {
  const parts: { text: string; title?: string; map?: true }[] = [];
  if (whole(more) > 0) parts.push({ text: `${count(whole(more))} more trading`, map: true });
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
/// The series the family chart draws: buyers of existing coins (`sparkEx`) when the server sends it, the same
/// population as the band (`baseline`) and the ratio. Not the same moment: the last point is the last complete
/// 5-min bucket, the printed ratio the 5 minutes to now, so the two agree only just after a bucket closes (the label
/// says "last complete 5 min", never "now"). An older server sends only `spark` (every coin), drawn as before. One
/// line either way.
export function chartSeries(f: { spark?: unknown; sparkEx?: unknown }): { series: unknown; ex: boolean } {
  const ex = Array.isArray(f.sparkEx) && f.sparkEx.length > 0;
  return { series: ex ? f.sparkEx : f.spark, ex };
}
export const chartAxis = (ex: boolean): string => (ex ? "buyers of existing coins per 5 min" : "buyers per 5 min");
/// The sparkline in words: "Buyers per 5 minutes over the last 2 hours: 170 in the last complete 5 min, at most 170,
/// 4 two hours ago; normal is about 12". The last point is a closed bucket, so it is not called "now": the headline
/// beside it counts the 5 minutes to now and can differ.
export function sparkLabel(f: Pick<WakeFamily, "spark" | "baseline" | "sparkEx">): string {
  const c = chartSeries(f);
  const v = sparkGeom(c.series, f.baseline, 100, 20).values;
  const base = finite(f.baseline) && f.baseline > 0 ? f.baseline : 0;
  const norm = base >= 10 ? count(Math.round(base)) : base.toFixed(1).replace(/\.0$/, "");
  return `Buyers${c.ex ? " of existing coins" : ""} per 5 minutes over the last 2 hours: ${count(v[SPARK_POINTS - 1])} in the last complete 5 min, at most ${count(Math.max(...v))}, ${count(v[0])} two hours ago; normal is about ${norm}`;
}

/// A card on screen: a listed family, or (`left`) one kept after the server stopped listing it, while the list is in
/// use (it is dimmed and says so; it goes once the list is idle).
/// `fold`: whether the card folds, kept as it was on screen while the list is in use (see keepShown).
export type FamilyRow = WakeFamily & { left?: boolean; fold?: boolean };
/// A family counts as hot from this ratio (the server's LIVE_RATIO).
export const LIVE_RATIO = 3;
/// A card folds to one line only when it is cooling AND buying under 3x now. Folding by the state alone hid a family
/// still at 21x once it was past the age cap (12% of the replayed snapshots had the highest-ratio family folded so).
export const foldable = (f: { state?: string; ratio?: number | null }): boolean => f.state === "cooling" && !(finite(f.ratio) && f.ratio >= LIVE_RATIO);
export const isFolded = (f: { state?: string; ratio?: number | null; fold?: boolean }, open: boolean): boolean => (f.fold ?? foldable(f)) && !open;
/// On the first load only: the first family when every card would be folded, so a first-time reader does not land on
/// grey lines alone (35% of the replayed snapshots). Never on a refresh: opening a card moves what is under it.
export const firstOpen = (rows: readonly FamilyRow[]): string | null => (rows.length > 0 && rows.every((r) => isFolded(r, false)) ? rows[0].parent.mint : null);
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
    rows.push(f ? keepShown(f, r) : r.left ? r : { ...r, left: true, fold: r.fold ?? foldable(r) });
  }
  for (const [m, f] of by) if (!kept.has(m)) rows.push(f);
  return rows;
}
/// A held card: the fresh numbers in the shape on screen. The server re-ranks a card's coins at each bucket close and a
/// card turning live -> cooling folds, so a Buy under a resting pointer could become another coin's or another card's.
/// Held, the coins on screen keep their rows (fresh numbers, or their last ones once dropped) and none is added, the
/// shown state and fold stay (the fold also depends on the ratio, which is fresh), and a post or foot line that was
/// not there does not appear. Idle again, the server's card comes back whole.
function keepShown(f: WakeFamily, r: FamilyRow): FamilyRow {
  const fresh = new Map<string, WakeCoin>();
  for (const c of Array.isArray(f.coins) ? f.coins : []) if (c && typeof c.mint === "string" && !fresh.has(c.mint)) fresh.set(c.mint, c);
  const coins = (Array.isArray(r.coins) ? r.coins : []).map((c) => fresh.get(c.mint) ?? c);
  const foot = footLine(r.more, r.hidden, r.dust) !== null;
  return { ...f, coins, state: r.state, fold: r.fold ?? foldable(r), post: r.post ? f.post ?? r.post : null, more: foot ? f.more : r.more, hidden: foot ? f.hidden : r.hidden, dust: foot ? f.dust : r.dust };
}
export const LEFT_PILL = "No longer listed";
/// A story row or card kept in place while the page is in use although the read lists its coins somewhere else now
/// (a coin joined a story card, or a card was regrouped): still listed, so it is not called dropped.
export const MOVED_PILL = "Moved to another card";
export const MOVED_TITLE = "This coin is now listed on another card or list; this row goes once the page is idle";
export const REGROUPED_PILL = "Regrouped";
export const REGROUPED_TITLE = "The coins of this card are now listed on other cards; this card goes once the page is idle";

/// While the list is in use a new family is added at the end and a card that turned live keeps its cooling shape, so
/// a wake-up could start unseen under a resting pointer. `heldNews` is what the pill above the list names: families
/// in the read that are not on screen (or were marked as gone), or live there and not live on screen, plus those
/// already pending that the server still lists.
export type WakeNews = { key: string; label: string };
const famName = (p: { symbol?: string | null; name?: string | null; mint: string }): string => (p.symbol ? `$${p.symbol}` : p.name || short(p.mint));
export function heldNews(fresh: { families?: unknown } | null | undefined, shown: readonly FamilyRow[], pending: readonly WakeNews[] = []): WakeNews[] {
  const on = new Map<string, FamilyRow>();
  for (const r of shown) if (!on.has(r.parent.mint)) on.set(r.parent.mint, r);
  const was = new Set(pending.map((p) => p.key)), seen = new Set<string>(), out: WakeNews[] = [];
  for (const f of fresh && Array.isArray(fresh.families) ? (fresh.families as WakeFamily[]) : []) {
    const m = mintOf(f);
    if (!m || seen.has(m)) continue;
    seen.add(m);
    const r = on.get(m);
    if (was.has(m) || !r || r.left || (f.state === "live" && r.state !== "live")) out.push({ key: m, label: famName(f.parent) });
  }
  return out;
}
/// "1 new wake-up: $SQQQ", "3 new wake-ups: $A, $B +1"; null for none. The page cuts this part when it is too wide
/// for a phone and keeps "· Show" whole beside it (the only sign the pill can be pressed).
export function newsText(news: readonly WakeNews[]): string | null {
  if (!news.length) return null;
  const names = news.slice(0, 2).map((n) => n.label).join(", ");
  return `${news.length} new wake-up${news.length === 1 ? "" : "s"}: ${names}${news.length > 2 ? ` +${news.length - 2}` : ""}`;
}
/// The quiet word beside the tabs: a failed poll over a list already shown, else that the order is held. Static text,
/// no clock: a ticking "updated N s ago" would be one more moving thing.
export const PAUSED_TEXT = "Order paused while you're here";
export const listStatus = (x: { error: string | null; hasRows: boolean; paused: boolean; stale?: boolean }): string =>
  (x.error && x.hasRows && !x.stale ? "Reconnecting" : x.paused && x.hasRows ? PAUSED_TEXT : "");

/// The map panel's block. Caption: "Waking up · started 4 min ago · 14x its normal" for a live family, "Cooling · ..."
/// for a cooling one (the ratio left out when nobody bought in the last 5 min), else "Moving now"; at most three coins,
/// one line each, and only coins someone bought: a coin that was only sold is not moving.
export function movingCaption(d: DiscoverOne, nowS: number): string {
  if (d.state === "quiet" || !finite(d.startedAt)) return "Moving now";
  const tail = finite(d.ratio) && d.ratio > 0 ? ` · ${ratioX(d.ratio)} its normal` : "";
  return `${d.state === "cooling" ? "Cooling" : "Waking up"} · started ${minAgo(d.startedAt, nowS)}${tail}`;
}
/// A row's buyers: a quiet answer ranks by the last 15 min (the latest 5-min bucket alone is often empty), a waking
/// family by the trailing 5 minutes.
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
/// `?tab=` and `?tf=` name a view in the address; on load a valid one wins over the stored choice.
export function urlPrefs(search: string | null | undefined): { tab: DscTab | null; tf: Tf | null } {
  const q = new URLSearchParams(search ?? "");
  const tab = q.get("tab"), tf = q.get("tf");
  return { tab: tab === "waking" || tab === "trending" ? tab : null, tf: (TFS as readonly unknown[]).includes(tf) ? (tf as Tf) : null };
}
/// The address with one of them changed ("/discover?tab=trending&tf=1h#x"), the other keys and the hash kept. The page
/// writes it with history.replaceState, not through the router: a router navigation, replace included, makes the
/// shell scroll to the top, and the tab or timeframe under the finger would jump away.
export function prefsUrl(loc: { pathname: string; search?: string | null; hash?: string | null }, k: "tab" | "tf", v: string): string {
  const q = new URLSearchParams(loc.search ?? "");
  q.set(k, v);
  return `${loc.pathname}?${q.toString()}${loc.hash ?? ""}`;
}
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
/// The 1m list only holds coins with `floor` or more buyers in the last 60 s (one or two buyers there is noise), so it
/// can be short or empty, and the page says how many met it.
/// `candidates` is counted before the creator checks, the $1,000 floor and the cap of 50, so it can be above the rows
/// listed (relaunches and dust are the coins that get 5 buyers in a minute): both numbers are said when they differ,
/// and an empty list says the coins were left out, not that there were none. `floor5m`: on 30m / 1h the list is empty
/// when no coin had that many buyers in the last 5 min, whatever was bought earlier in the hour.
export const LEFT_OUT_WHY = "left out by the creator checks or under a $1,000 market cap";
export function emptyTrending(tf: Tf, floor?: number | null, candidates?: number | null, floor5m?: number | null): string {
  const n = whole(candidates), f = whole(floor), f5 = whole(floor5m);
  if (tf === "1m" && f > 1) return n > 0 ? `${plural(n, "coin")} had ${f} or more buyers in the last minute; none is listed (${LEFT_OUT_WHY}).` : `No coin had ${f} or more buyers in the last minute.`;
  if (n > 0) return `${plural(n, "coin")} met the list's buyer count for ${tfWords(tf)}; none is listed (${LEFT_OUT_WHY}).`;
  return f5 > 1 ? `No coin had ${f5} or more buyers in the last 5 min.` : `Nothing is being bought in ${tfWords(tf)}.`;
}
/// `listed`: the rows the server sent.
export function floorLine(b: { floor?: number | null; candidates?: number | null } | null | undefined, tf: Tf, listed?: number | null): string | null {
  if (tf !== "1m" || !b || whole(b.floor) <= 1 || !finite(b.candidates) || b.candidates < 0) return null;
  const n = whole(b.candidates), shown = finite(listed) && listed >= 0 && whole(listed) < n ? ` · ${whole(listed) === 0 ? "none" : count(whole(listed))} listed` : "";
  return `${plural(n, "coin")} with ${whole(b.floor)}+ buyers in the last minute${shown}`;
}
/// What the list is ordered by. `byHolding`: the rows carry `tf.holding` (a newer server ranks by it). `sort`: a
/// header column the reader chose; the line then says that order, not the server's rank.
export const SORT_WORDS: Record<"buyers" | "mcap" | "liq", string> = { buyers: "buyers", mcap: "market cap", liq: "liquidity" };
export const trendingSub = (tf: Tf, byHolding = false, sort: "rank" | "buyers" | "mcap" | "liq" = "rank"): string =>
  (sort !== "rank" ? `Coins bought in ${tfWords(tf)}, sorted by ${sort === "buyers" ? "buyers in that time" : SORT_WORDS[sort]}, largest first` : byHolding ? `Coins by wallets that bought in ${tfWords(tf)} and have not sold since` : `Coins by how many wallets bought them in ${tfWords(tf)}`);
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
/// The Buyers cell: the count, and under it how many of them have not sold ("96 not sold": wallets with no sell of the
/// coin after their first buy in the window) when the server sends it. Never the bare word "holding".
export function buyersCell(t: CoinRow["tf"], tf: Tf): { n: string; sub: string | null; title: string } {
  const title = `Wallets that bought $1 or more over ${tf}`;
  if (!t) return { n: "—", sub: null, title };
  const h = t.holding;
  if (!finite(h) || h < 0) return { n: count(t.buyers), sub: null, title };
  return { n: count(t.buyers), sub: `${count(whole(h))} not sold`, title: `${title}; ${count(whole(h))} of them have not sold it since their first buy in that time` };
}
/// Tickers repeat down a list (5-8 a snapshot), so two rows could look the same. A ticker is compared as the server's
/// normSym does: trimmed, lowercase.
export const normSym = (s: unknown): string => (typeof s === "string" ? s.trim().toLowerCase() : "");
/// The tickers more than one row of a list or card carries: those rows show the start of their mint.
export function repeatedSyms(rows: readonly ({ symbol?: string | null } | null | undefined)[] | null | undefined): Set<string> {
  const seen = new Set<string>(), twice = new Set<string>();
  for (const r of rows ?? []) { const k = normSym(r?.symbol); if (!k) continue; if (seen.has(k)) twice.add(k); else seen.add(k); }
  return twice;
}
export const mintPrefix = (mint: string): string => mint.slice(0, 4);
export const MINT_PREFIX_TITLE = "The first 4 characters of this coin's address: another row has the same ticker";
/// The name beside the ticker, only when it says something the ticker does not (ignoring case and a leading "$"): it
/// would repeat the ticker on a third to half of the rows.
export function nameIfDiffers(c: { name?: string | null; symbol?: string | null }): string | null {
  const n = typeof c.name === "string" ? c.name.trim() : "";
  const bare = (x: string) => normSym(x).replace(/^\$/, "");
  return n && bare(n) !== bare(c.symbol ?? "") ? n : null;
}
/// The age slot. A coin whose launch the index did not see has no age: it shows how long ago its first stored trade
/// was, as a lower bound ("seen 40m+"), never "old" (a third of such coins first traded under 2 hours ago).
const shortSpan = (s: number): string => { const v = Math.max(0, Math.floor(s)); return v < 60 ? `${v}s` : v < 3600 ? `${Math.floor(v / 60)}m` : v < 86400 ? `${Math.floor(v / 3600)}h` : `${Math.floor(v / 86400)}d`; };
export function rowAge(c: Pick<CoinRow, "createdAt" | "firstSeenAt">, nowS: number): { text: string; title: string } {
  if (finite(c.createdAt) && c.createdAt > 0) return { text: shortSpan(nowS - c.createdAt), title: "Age" };
  if (finite(c.firstSeenAt) && c.firstSeenAt > 0) return { text: `seen ${shortSpan(nowS - c.firstSeenAt)}+`, title: "Launch not seen; counted from the first trade we stored" };
  return { text: "—", title: "Age unknown: the launch was not seen" };
}
export const GRAD_TITLE = "Graduated: trades on a pool, off the bonding curve";
export const LIQ_TITLE = "Liquidity: the real quote side of the curve or pool, in USD";
/// A market cap of $1M or more over 100 times the liquidity: a note on the figure, in neutral ink.
export const THIN_TEXT = "thin";
export const THIN_TITLE = "This market cap is over 100 times the liquidity: a small part of the supply is in the pool, so small trades move the figure.";
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
export function screenMints(fams: readonly { coins?: { mint: string }[]; state?: string; ratio?: number | null; fold?: boolean }[] | null, trend: readonly { mint: string }[] | null, opened?: ReadonlySet<string>): Set<string> {
  const s = new Set<string>();
  for (const f of fams ?? []) {
    const folded = isFolded(f, !!(opened && "parent" in f && opened.has((f as { parent: { mint: string } }).parent.mint)));
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
/// A phone has no hover for the marks' titles: one line under the chart names each mark that is drawn.
export function markLegend(m: { start: number | null; post: number | null }): { kind: "start" | "post"; text: string }[] {
  const out: { kind: "start" | "post"; text: string }[] = [];
  if (m.start !== null) out.push({ kind: "start", text: "buying jumped" });
  if (m.post !== null) out.push({ kind: "post", text: "linked post" });
  return out;
}
export function familyChartLabel(f: Pick<WakeFamily, "spark" | "baseline" | "startedAt" | "post" | "sparkEx"> & { sparkFrom?: number }, bucketS: number, nowS: number): string {
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
/// A post made more than OLD_POST_S before the start did not coincide with it: "Posted 914 days before buying jumped"
/// read as the reason. It is named as an older post with its date ("Older post, posted May 2024"; the gap up to a
/// day), and how many coins launched around this wake-up link it when the server counts them.
export const OLD_POST_S = 6 * 3600;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/// "Nov 12" within about ten months of now, "May 2024" before that (UTC: a date, not a moment).
export function postDate(at: number, nowS: number): string {
  const d = new Date(at * 1000);
  return nowS - at < 300 * 86400 ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function postLead(p: Pick<WakePost, "at" | "lead" | "newCoins">, startedAt: number | null | undefined, nowS: number): string {
  const lead = p.lead !== undefined ? p.lead : finite(p.at) && finite(startedAt) ? startedAt - p.at : null;
  if (finite(lead) && lead > OLD_POST_S) {
    const at = finite(p.at) ? p.at : finite(startedAt) ? startedAt - lead : null;
    const posted = lead > 86400 && at !== null ? `posted ${postDate(at, nowS)}` : `posted ${durText(lead)} before buying jumped`;
    return `Older post, ${posted}${whole(p.newCoins) > 0 ? ` · linked by ${plural(whole(p.newCoins), "new coin")}` : ""}`;
  }
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
/// A cooling card folded to one line, the current numbers first: "$SYM · cooling · 1.8x now · 22 buyers / 5 min ·
/// started 34 min ago · peak 6.3x". The line is cut with an ellipsis on a phone, and the cut then takes the peak, not
/// what the family is doing now.
export function coolingLine(f: Pick<WakeFamily, "parent" | "startedAt" | "peakRatio"> & { ratio?: number | null; buyers5m?: number | null }, nowS: number): string {
  const p = f.parent, name = p.symbol ? `$${p.symbol}` : p.name || short(p.mint);
  const now = finite(f.ratio) && f.ratio > 0 ? `${ratioX(f.ratio)} now` : "";
  const buyers = !finite(f.buyers5m) ? "" : whole(f.buyers5m) > 0 ? `${plural(whole(f.buyers5m), "buyer")} / 5 min` : "no buying in 5 min";
  return [name, "cooling", now, buyers, `started ${minAgo(f.startedAt, nowS)}`, finite(f.peakRatio) && f.peakRatio > 0 ? `peak ${ratioX(f.peakRatio)}` : ""].filter(Boolean).join(" · ");
}

// ---- the Trending tab

/// A trending row on screen (`left`: the server stopped listing it while the list was in use; dimmed, gone once idle).
/// `rank`: its place in the server's order (1-based), whatever column the reader sorted by; `under`: the mint of the
/// row it is folded under (a copy: same ticker, same parent).
export type TrendShown = TrendRow & Live & { left?: boolean; rank?: number; under?: string };
/// The header's sort: "rank" is the server's order; the others sort the rows received, largest first.
export type TrendSort = "rank" | "buyers" | "mcap" | "liq";
const sortVal = (r: TrendShown, k: TrendSort): number | null => {
  const v = k === "buyers" ? r.tf?.buyers : k === "mcap" ? r.mcapUsd : k === "liq" ? r.liqUsd : null;
  return finite(v) ? v : null;
};
/// Rows in the chosen order: a column sorts largest first with unknown values last, ties (and "rank") by the server's
/// rank. A new array; the rows themselves are not changed.
export function sortTrend<R extends TrendShown>(rows: readonly R[], sort: TrendSort): R[] {
  const rk = (r: R) => (finite(r.rank) ? r.rank : Infinity);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    if (sort !== "rank") {
      const x = sortVal(a.r, sort), y = sortVal(b.r, sort);
      if (x !== y) return x === null ? 1 : y === null ? -1 : y - x;
    }
    const d = rk(a.r) - rk(b.r);
    return d || a.i - b.i;
  }).map((x) => x.r);
}
/// Same ticker under the same parent: the first row in the order stays, the copies are marked `under` it and shown
/// behind a "+2 same ticker" chip. Same ticker under another parent is another story and keeps its row, and so does
/// a row without a parent: two roots priced in SOL share no parent, only a ticker (no group key). `keep`: mints
/// never folded away whatever their group (a row whose Buy shows a block reason must stay in sight). A group is
/// left unfolded when a copy's market cap is FOLD_MCAP_X or more above the shown row's (or the shown row's is not
/// known): the large one must not sit hidden behind a small one.
export const FOLD_MCAP_X = 10;
export const groupKey = (r: { symbol?: string | null; parent?: { mint?: unknown } | null }): string | null => { const k = normSym(r.symbol); return k && r.parent && typeof r.parent.mint === "string" && r.parent.mint ? `${k}|${r.parent.mint}` : null; };
export function foldTickers<R extends TrendShown>(rows: readonly R[], keep?: ReadonlySet<string> | null): R[] {
  const groups = new Map<string, R[]>();
  for (const r of rows) { const k = groupKey(r); if (!k) continue; const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); }
  const under = new Map<string, string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const lead = g[0], lm = lead.mcapUsd;
    if (g.slice(1).some((c) => finite(c.mcapUsd) && c.mcapUsd > 0 && (!finite(lm) || lm <= 0 || c.mcapUsd >= FOLD_MCAP_X * lm))) continue;
    for (const c of g.slice(1)) if (!keep?.has(c.mint)) under.set(c.mint, lead.mint);
  }
  return rows.map((r) => { const u = under.get(r.mint); if (u === r.under) return r; const n = { ...r }; if (u) n.under = u; else delete n.under; return n; });
}
/// The rows after a read, held like the families (familyRows): idle, the chosen order (`sort`) with the copies folded
/// again; in use, the rows on screen keep their places and their fold with fresh numbers, a new coin goes last (as
/// its own row) and one that left stays, marked. `keep`: see foldTickers.
export function trendRows(fresh: { rows?: unknown } | null | undefined, shown: readonly TrendShown[], hold = false, sort: TrendSort = "rank", keep?: ReadonlySet<string> | null): TrendShown[] {
  const by = new Map<string, TrendShown>();
  for (const r of fresh && Array.isArray(fresh.rows) ? (fresh.rows as TrendRow[]) : []) if (r && typeof r.mint === "string" && !by.has(r.mint)) by.set(r.mint, { ...r, rank: by.size + 1 });
  if (!hold) return foldTickers(sortTrend([...by.values()], sort), keep);
  const kept = new Set<string>(), rows: TrendShown[] = [];
  for (const r of shown) {
    if (kept.has(r.mint)) continue;
    kept.add(r.mint);
    const f = by.get(r.mint);
    rows.push(f ? (r.under ? { ...f, under: r.under } : f) : r.left ? r : { ...r, left: true });
  }
  for (const [m, r] of by) if (!kept.has(m)) rows.push(r);
  return rows;
}
/// The list as drawn: each row, a leader with its group (how many copies are folded under it, the largest copy's
/// market cap when it is above the leader's, whether the reader opened it), and an opened group's copies in place
/// after their leader. `expanded` holds group keys (ticker + parent), so an open group stays open over the reads.
export type TrendGroup = { key: string; n: number; largest: number | null; open: boolean };
export type TrendItem<R> = { row: R; group: TrendGroup | null; copy: boolean };
export function trendItems<R extends TrendShown>(rows: readonly R[], expanded: ReadonlySet<string>): TrendItem<R>[] {
  const mints = new Set(rows.map((r) => r.mint)), kids = new Map<string, R[]>();
  const folded = (r: R): string | null => (r.under && r.under !== r.mint && mints.has(r.under) ? r.under : null);
  for (const r of rows) { const u = folded(r); if (!u) continue; const k = kids.get(u); if (k) k.push(r); else kids.set(u, [r]); }
  const out: TrendItem<R>[] = [];
  for (const r of rows) {
    if (folded(r)) continue;
    const ks = kids.get(r.mint), key = groupKey(r);
    if (!ks || !key) { out.push({ row: r, group: null, copy: false }); continue; }
    const big = Math.max(0, ...ks.map((c) => (finite(c.mcapUsd) ? c.mcapUsd : 0)));
    const open = expanded.has(key);
    out.push({ row: r, group: { key, n: ks.length, largest: big > 0 && finite(r.mcapUsd) && big > r.mcapUsd ? big : null, open }, copy: false });
    if (open) for (const c of ks) out.push({ row: c, group: null, copy: true });
  }
  return out;
}
export const groupChip = (g: TrendGroup): string => (g.open ? `Hide ${count(g.n)} same ticker` : `+${count(g.n)} same ticker${g.largest !== null ? ` · largest ${usd(g.largest)}` : ""}`);
export const GROUP_TITLE = "Other coins with this ticker under the same parent, folded under the first of them in this order";
/// The small tags of a trending row: "under $FIONA" (its parent) and the family's state when it is on Discover.
export const parentTag = (r: Pick<TrendRow, "parent">): string | null => (r.parent && typeof r.parent.mint === "string" ? `under ${r.parent.symbol ? `$${r.parent.symbol}` : short(r.parent.mint)}` : null);
export const familyPill = (r: Pick<TrendRow, "family">): string | null => (r.family === "live" ? "waking up" : r.family === "cooling" ? "cooling" : null);

// ---- stories (GET /api/stories): the page's one view, grouped by the post or the family behind the buying

/// A coin row of the page (`left`: the server stopped listing it here while the page was in use; dimmed, gone once idle.
/// `moved`, on a `left` row or card: the read still lists the coin, or every coin of the card, somewhere else).
/// `size`: the size pill the row is under, set from the market cap of the read that put it on screen and kept while
/// the page is in use. A live trade moves the market cap shown, never the pill: a coin crossing $100K under a resting
/// pointer would take its row out and move every Buy under it.
export type StoryShown = StoryRow & Live & { left?: boolean; moved?: boolean; reason?: DustReason; size?: Exclude<SizeKey, "all"> | null };
export type StoryCardShown = Omit<StoryCard, "coins"> & { coins: StoryShown[]; left?: boolean; moved?: boolean };
/// What the page holds between reads. `hiddenDust`: every dust coin the server counted (`dust` lists at most 30).
/// `hiddenLoose`: the coins of no card past the loose rows sent.
/// `tagging`: the server tags narratives (`tagging.on`); `themes`: the themes of its narrative cards, most cards first
/// (while the page is in use: in the order shown, a theme the read no longer has kept with its last count).
export type StoriesView = { cards: StoryCardShown[]; loose: StoryShown[]; dust: StoryShown[]; hiddenDust: number; hiddenCards: number; hiddenLoose: number; tagging: boolean; themes: StoryTheme[] };

/// The size pills, by market cap: small under $100K, mid $100K to $5M, large over $5M. A coin without a known market
/// cap is only under "All".
export type SizeKey = "all" | "small" | "mid" | "large";
export const SIZE_KEY = "spore:dsc-size";
export const SMALL_MAX_USD = 100_000;
export const LARGE_MIN_USD = 5_000_000;
export const SIZES: readonly { key: SizeKey; text: string; title: string }[] = [
  { key: "all", text: "All", title: "Coins of every market cap" },
  { key: "small", text: "Small", title: "Market cap under $100K" },
  { key: "mid", text: "Mid", title: "Market cap $100K to $5M" },
  { key: "large", text: "Large", title: "Market cap over $5M" },
];
export const parseSize = (raw: unknown): SizeKey => (raw === "small" || raw === "mid" || raw === "large" ? raw : "all");
export function sizeOf(mcapUsd: number | null | undefined): Exclude<SizeKey, "all"> | null {
  if (!finite(mcapUsd) || mcapUsd < 0) return null;
  return mcapUsd < SMALL_MAX_USD ? "small" : mcapUsd <= LARGE_MIN_USD ? "mid" : "large";
}
/// A row of the view is under the pill it was read into (`size`); anything else is sized by its market cap.
export const inSize = (r: { mcapUsd?: number | null; size?: Exclude<SizeKey, "all"> | null }, size: SizeKey): boolean =>
  size === "all" || (r.size !== undefined ? r.size : sizeOf(r.mcapUsd)) === size;

/// The copies folded under a row (same ticker and image; the row shown has the most liquidity). A broken entry is dropped.
export const copiesOf = (r: { copies?: unknown } | null | undefined): StoryCopy[] =>
  (r && Array.isArray(r.copies) ? (r.copies as StoryCopy[]).filter((c) => c && typeof c.mint === "string") : []);
/// A card's two numbers from the rows it shows: buyers in 5 min and coins, each counting a row and its copies. A row
/// the server stopped listing (kept dimmed while the page is in use) is not counted.
export function cardTotals(coins: readonly (Pick<StoryShown, "buyers5m" | "left"> & { copies?: unknown })[]): { buyers5m: number; coinsN: number } {
  let buyers5m = 0, coinsN = 0;
  for (const c of coins) {
    if (!c || c.left) continue;
    buyers5m += whole(c.buyers5m); coinsN += 1;
    for (const k of copiesOf(c)) { buyers5m += whole(k.buyers5m); coinsN += 1; }
  }
  return { buyers5m, coinsN };
}
/// The view under a size pill: each list keeps the rows of that size (a folded copy has no market cap of its own and
/// goes with the row it is under), a card left without a coin is gone, and a card's two numbers count what it still
/// shows. The order is the one received: a card does not move when the pill changes its numbers. A row's size is the
/// one of its read (see StoryShown `size`), so a live trade never adds or removes a row or a card.
/// `dustN`: "N hidden as bot dust". Under "All" the server's count of every dust coin; under a size only the dust
/// rows received can be told apart, so it counts those.
export type StoriesShown = { cards: StoryCardShown[]; loose: StoryShown[]; dust: StoryShown[]; dustN: number; total: number };
/// `theme` (a theme pill, "all" for none) combines with the size: only the cards whose narrative has that theme, and
/// the loose and dust rows tagged with it. A card is of its own narrative's theme, whatever its coins carry.
export function filterStories(v: StoriesView, size: SizeKey, theme: string = ALL_THEMES): StoriesShown {
  const any = theme === ALL_THEMES, unfiltered = size === "all" && any, cards: StoryCardShown[] = [];
  const rowOk = (r: StoryShown) => inSize(r, size) && (any || themeOf(r.narrative) === theme);
  for (const c of v.cards) {
    if (!any && themeOf(c.narrative) !== theme) continue;
    const coins = size === "all" ? c.coins : c.coins.filter((r) => inSize(r, size));
    if (!coins.length) continue;
    // a card kept after the server dropped it shows its last numbers
    cards.push(c.left ? { ...c, coins } : { ...c, coins, ...cardTotals(coins) });
  }
  const loose = unfiltered ? v.loose : v.loose.filter(rowOk);
  const dust = unfiltered ? v.dust : v.dust.filter(rowOk);
  return { cards, loose, dust, dustN: unfiltered ? Math.max(whole(v.hiddenDust), dust.length) : dust.length, total: cards.length + loose.length };
}

// ---- narrative tags (a server with NARRATIVES=on): stories named by a language model from each coin's public text.
// Context only: a title says what the coins are about, never what they will do.

/// The theme pills' "no filter" key and where the choice is kept.
export const ALL_THEMES = "all";
export const THEME_KEY = "spore:dsc-theme";
/// Model-written text made plain: control, zero-width and direction-override characters dropped, blank runs cut to one space.
function plainText(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}
/// A theme as a key: trimmed, lower case; null for anything that is not a short piece of text (or is the "all" key).
const themeKey = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const t = plainText(raw).toLowerCase();
  return t && t.length <= 40 && t !== ALL_THEMES ? t : null;
};
export const themeOf = (n: { theme?: unknown } | null | undefined): string | null => (n && typeof n === "object" ? themeKey(n.theme) : null);
/// The stored pill: a theme key, else "all". Whether that theme is on the page now is `activeTheme`'s question.
export const parseTheme = (raw: unknown): string => themeKey(raw) ?? ALL_THEMES;
/// A theme as words: "ai" reads "AI", anything else takes a capital first letter ("Market crash", "Tech & products").
const THEME_WORDS: Record<string, string> = { ai: "AI" };
export function themeLabel(theme: unknown): string {
  const t = themeKey(theme);
  return t ? THEME_WORDS[t] ?? t[0].toUpperCase() + t.slice(1) : "";
}
/// A story's title as shown: made plain, cut to TITLE_MAX characters, and title-cased ("trump tariff panic" reads
/// "Trump Tariff Panic"). A word that already has a capital is left as written ("AI", "iPhone"), and the short joining
/// words stay small after the first. "Untitled story" when nothing is left. The page renders it as a text node.
export const TITLE_MAX = 60;
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"]);
export function narrativeTitle(raw: unknown): string {
  const t = typeof raw === "string" ? plainText(raw) : "";
  if (!t) return "Untitled story";
  const cut = t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
  return cut.split(" ").map((w, i) => (w !== w.toLowerCase() || (i > 0 && SMALL_WORDS.has(w)) ? w : w.replace(/\p{Ll}/u, (ch) => ch.toUpperCase()))).join(" ");
}
/// A usable narrative of a row or card: a number id and a title; null otherwise.
export function narrativeOf(x: { narrative?: unknown } | null | undefined): NarrativeRef | null {
  const n = x && typeof x === "object" ? (x.narrative as Partial<NarrativeRef> | null | undefined) : null;
  return n && typeof n === "object" && finite(n.id) && typeof n.title === "string" ? { id: n.id, title: n.title, theme: typeof n.theme === "string" ? n.theme : "" } : null;
}
/// Whether the page shows anything of the narratives: the server tags them and at least one narrative card is listed.
/// Without that the page is the one without tagging: no theme pills, no theme on a card, no tag on a loose row, no note.
export const narrativesOn = (v: Pick<StoriesView, "tagging" | "cards"> | null | undefined): boolean => !!v && v.tagging === true && v.cards.some((c) => c.kind === "narrative");
/// The theme pills: "All themes", then every theme with a narrative card (the server's list, a broken or repeated
/// entry dropped; counted from the cards on screen when the server sent no list) and every theme of `keep` (the pills
/// this page has shown before and the reader's stored choice: a pill does not vanish, and the choice stays in force,
/// when its last card drops out). The order is fixed, by name with "other" last, never by the counts: a pill does not
/// change places between reads. The count is in the title only.
export type ThemePill = { key: string; text: string; title: string };
const byThemeName = (a: string, b: string): number => (a === "other" ? 1 : 0) - (b === "other" ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0);
export function themePills(v: Pick<StoriesView, "themes" | "cards">, keep: Iterable<string> = []): ThemePill[] {
  const n = new Map<string, number>();
  for (const t of Array.isArray(v.themes) ? v.themes : []) { const k = themeOf(t); if (k && !n.has(k) && whole(t.cards) > 0) n.set(k, whole(t.cards)); }
  if (!n.size) for (const c of v.cards) { const k = c.kind === "narrative" && !c.left ? themeOf(c.narrative) : null; if (k) n.set(k, (n.get(k) ?? 0) + 1); }
  for (const raw of keep) { const k = themeKey(raw); if (k && !n.has(k)) n.set(k, 0); }
  if (!n.size) return [];
  const keys = [...n.keys()].sort(byThemeName);
  return [{ key: ALL_THEMES, text: "All themes", title: "Stories of every theme" }, ...keys.map((k) => ({ key: k, text: themeLabel(k), title: `Only stories tagged ${themeLabel(k)}: ${n.get(k) ? `${count(n.get(k) ?? 0)} now` : "none right now"}` }))];
}
/// The theme in force: the stored one while it has a pill, else "all" (an unknown theme filters nothing).
export const activeTheme = (stored: string, pills: readonly ThemePill[]): string => (stored !== ALL_THEMES && pills.some((p) => p.key === stored) ? stored : ALL_THEMES);
/// A narrative card's coins in two runs, each in the order received: created in the last hour (`isNew`), and older.
export function splitNew<R extends { isNew?: boolean }>(coins: readonly R[]): { fresh: R[]; older: R[] } {
  const fresh: R[] = [], older: R[] = [];
  for (const c of coins) (c && c.isNew === true ? fresh : older).push(c);
  return { fresh, older };
}
export const NEW_LABEL = "New this hour";
export const OLDER_LABEL = "Older coins in this story";
/// A narrative card's head: the title, its theme as words ("" when unknown), the second number (`newCoins`: coins of
/// the story created in the last 60 min, as the server counted them over every tagged coin) and, when the card has a
/// post, one quiet line "@handle · 6 min ago" with the post's address rebuilt from its id (null for a bad id).
export type NarrativeHead = { title: string; theme: string; newCoins: number; post: { text: string; href: string | null } | null };
export function narrativeHead(c: Pick<StoryCard, "narrative" | "post">, nowS: number): NarrativeHead {
  const n = c.narrative;
  let post: NarrativeHead["post"] = null;
  if (c.post && typeof c.post === "object") {
    const h = postHandle({ state: "ok" as const, handle: c.post.handle });
    post = { text: [h ? `@${h}` : "Linked post", relTime(c.post.at, nowS)].filter(Boolean).join(" · "), href: safePostUrl(c.post.id) };
  }
  return { title: narrativeTitle(n?.title), theme: themeLabel(n?.theme), newCoins: whole(n?.newCoins1h), post };
}
export const NEW_COINS_TITLE = "Coins tagged with this story that were created in the last 60 minutes";
/// Added to the page's note while narratives are shown.
export const MODEL_NOTE = "Stories are grouped by a language model reading each coin's public text. It can be wrong.";
export const TAG_NOTE = "The story a language model read in this coin's public text. It can be wrong.";
/// The empty line under a filter names the filters that are on.
export function emptyFiltered(size: SizeKey, theme: string = ALL_THEMES): string {
  return theme !== ALL_THEMES ? `No ${themeLabel(theme)} story${size !== "all" ? " of this size" : ""} is being bought right now.` : "No coin of this size is being bought right now.";
}

/// How long ago, for a post that can be minutes or years old: "just now", "6 min ago", "5 h ago", "3 d ago", then the
/// date ("Nov 12", "May 2024"). "" when the time is not known (a post id from before X's timed ids).
export function relTime(at: number | null | undefined, nowS: number): string {
  if (!finite(at)) return "";
  const m = Math.floor(Math.max(0, nowS - at) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} d ago` : postDate(at, nowS);
}
/// The two letters in a post card's circle, from the handle: the first letters of its first two words ("elon_musk",
/// "ElonMusk": "EM"), else its first two characters ("poster": "PO"); "?" without a handle. Upper case.
export function initials(handle: string | null | undefined): string {
  const h = typeof handle === "string" ? handle.replace(/^@/, "").trim() : "";
  const words = h.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}
const famLabel = (f: { symbol?: string | null; mint: string }): string => (f.symbol ? `$${f.symbol}` : short(f.mint));
/// A card's head. Post card: who "@handle", when "6 min ago", `tail` "$SYM family waking" when a waking family chose
/// the same post, `text` the post's words on one line ("" for a media-only post) and `href` the post on x.com (rebuilt
/// from the id). Family card: who "$SYM family", when "waking up · 12 min" (since its start). `line` is the whole first
/// line. Only who posted, when, and what is waking: a post is what the coins link, never the reason.
export type StoryHead = { kind: "post" | "family"; who: string; when: string; tail: string | null; line: string; text: string; href: string | null; initials: string | null };
export function storyHead(c: Pick<StoryCard, "kind" | "post" | "family">, nowS: number): StoryHead {
  const f = c.family && typeof c.family.mint === "string" ? c.family : null;
  if (c.post) {
    const p = { state: "ok" as const, handle: c.post.handle, text: c.post.text };
    const h = postHandle(p);
    const who = h ? `@${h}` : "Linked post", when = relTime(c.post.at, nowS), tail = f ? `${famLabel(f)} family waking` : null;
    return { kind: "post", who, when, tail, line: [who, when, tail].filter(Boolean).join(" · "), text: postText(p), href: safePostUrl(c.post.id), initials: initials(h) };
  }
  const who = f ? `${famLabel(f)} family` : "Family";
  const when = f && finite(f.startedAt) ? `waking up · ${durText(nowS - f.startedAt)}` : "waking up";
  return { kind: "family", who, when, tail: null, line: `${who} · ${when}`, text: "", href: null, initials: null };
}
/// How many chips a card shows before "+N more".
export const CHIPS_MAX = 3;
/// "×3 copies" on a row with two others folded under it: three coins that look the same, none named as the first.
export const copiesMark = (r: { copies?: unknown } | null | undefined): string | null => { const n = copiesOf(r).length; return n > 0 ? `×${count(n + 1)} copies` : null; };
export const COPIES_TITLE = "Coins with the same ticker and image, folded into one row. The row shown is the one with the most liquidity; nothing here says which came first.";
/// A coin chip: "$SYM 96 buyers · $41K +38%" (buyers over 5 min, as the card's number; the market cap and its change
/// over the chosen timeframe), then "×3 copies" on a folded one.
export type StoryChip = { sym: string; buyers: string; mcap: string; chg: { text: string; tone: Tone } | null; copies: string | null; text: string };
export function storyChip(r: Pick<StoryShown, "mint" | "symbol" | "buyers5m" | "mcapUsd" | "tf"> & { copies?: unknown }): StoryChip {
  const s = r.symbol ? `$${r.symbol}` : short(r.mint), buyers = plural(whole(r.buyers5m), "buyer"), mcap = finite(r.mcapUsd) ? usd(r.mcapUsd) : "";
  const chg = mcap && finite(r.tf?.chg) ? chgText(r.tf?.chg) : null, copies = copiesMark(r);
  return { sym: s, buyers, mcap, chg, copies, text: `${s} ${buyers}${mcap ? ` · ${mcap}${chg ? ` ${chg.text}` : ""}` : ""}${copies ? ` · ${copies}` : ""}` };
}
export const moreChips = (n: number): string | null => (whole(n) > 0 ? `+${count(whole(n))} more` : null);
/// A folded copy as one line under its row: when it launched (or was first seen trading), its liquidity, its buyers.
export function copyFacts(c: StoryCopy, nowS: number): string {
  const seen = finite(c.createdAt) && c.createdAt > 0 ? `launched ${relTime(c.createdAt, nowS)}` : finite(c.firstSeenAt) && c.firstSeenAt > 0 ? `first seen ${relTime(c.firstSeenAt, nowS)}` : "";
  return [seen, finite(c.liqUsd) ? `${usd(c.liqUsd)} liquidity` : "", `${plural(whole(c.buyers5m), "buyer")} in 5 min`].filter(Boolean).join(" · ");
}
/// The words around the lists.
export const STORIES_SUB = "What is being bought now, grouped by the post or family behind it";
/// `more`: the coins of no card the server did not send: "No story found · 30 of 125 coins". `nar` (narratives are
/// shown): a row here can carry a story's title (a story with one coin on the page gets no card), so the heading says
/// what the list is, "Not in a story card · 12 coins".
export const looseTitle = (n: number, more = 0, nar = false): string => {
  const lead = nar ? "Not in a story card" : "No story found";
  return whole(more) > 0 ? `${lead} · ${count(whole(n))} of ${plural(whole(n) + whole(more), "coin")}` : `${lead} · ${plural(whole(n), "coin")}`;
};
/// Under a size pill the coins not sent cannot be told apart by size: one line says how many there are.
export const looseMore = (more: number): string | null => (whole(more) > 0 ? `${plural(whole(more), "more coin")} of any size ${whole(more) === 1 ? "is" : "are"} not shown.` : null);
export const LOOSE_TITLE = "Coins being bought that link no stored post and whose family is not waking up";
export const LOOSE_TITLE_NAR = "Coins being bought that are on no story card: no story shared with another listed coin, no stored post, and a family that is not waking up";
export const dustLine = (n: number): string => `${count(whole(n))} hidden as bot dust`;
export const DUST_NOTE = "Left out of the lists above: a market cap over 100 times the liquidity, or under $5 bought per buyer.";
export const DUST_CHIP: Record<DustReason, { text: string; title: string }> = {
  paper: { text: "Paper cap", title: "Market cap over 100 times the liquidity" },
  tiny: { text: "Tiny buys", title: "Under $5 of volume per buyer over the chosen timeframe" },
};
export const dustChip = (reason: unknown): { text: string; title: string } | null => (reason === "paper" || reason === "tiny" ? DUST_CHIP[reason] : null);

/// The rows of a read, each under the size pill of its market cap in that read.
const cleanRows = (rows: unknown, seen: Set<string>): StoryShown[] => {
  const out: StoryShown[] = [];
  for (const r of Array.isArray(rows) ? (rows as StoryShown[]) : []) if (r && typeof r.mint === "string" && !seen.has(r.mint)) { seen.add(r.mint); out.push({ ...r, size: sizeOf(r.mcapUsd) }); }
  return out;
};
/// Held rows: the ones on screen keep their places and their size pill with the fresh numbers, a new one goes last,
/// and one the server dropped stays, marked `left`.
function holdRows(fresh: StoryShown[], shown: readonly StoryShown[]): StoryShown[] {
  const by = new Map(fresh.map((r) => [r.mint, r] as const)), kept = new Set<string>(), out: StoryShown[] = [];
  for (const r of shown) {
    if (kept.has(r.mint)) continue;
    kept.add(r.mint);
    const f = by.get(r.mint);
    if (!f) { out.push(r.left ? r : { ...r, left: true }); continue; }
    // a held row also stays in its run of a narrative card (new this hour / older): turning an hour old must not move it
    const keepSize = r.size !== undefined && r.size !== f.size, keepNew = r.isNew !== undefined && r.isNew !== f.isNew;
    out.push(keepSize || keepNew ? { ...f, size: keepSize ? r.size : f.size, isNew: keepNew ? r.isNew : f.isNew } : f);
  }
  for (const [m, r] of by) if (!kept.has(m)) out.push(r);
  return out;
}
/// A held `left` row says whether its coin is still listed somewhere in the read (`listed`): `moved` then, and plain
/// `left` again when the coin later drops out altogether. Checked on every read.
const markMoved = (rows: StoryShown[], listed: ReadonlySet<string>): StoryShown[] =>
  rows.map((r) => (r.left && (r.moved === true) !== listed.has(r.mint) ? { ...r, moved: listed.has(r.mint) } : r));
/// Held themes: the ones shown keep their order (fresh counts; the last count for one the read no longer has), a new one goes last.
function holdThemes(fresh: StoryTheme[], shown: readonly StoryTheme[]): StoryTheme[] {
  const by = new Map(fresh.map((t) => [themeOf(t), t] as const)), kept = new Set<string | null>(), out: StoryTheme[] = [];
  for (const t of shown) { const k = themeOf(t); if (kept.has(k)) continue; kept.add(k); out.push(by.get(k) ?? t); }
  for (const [k, t] of by) if (!kept.has(k)) out.push(t);
  return out;
}
/// A card's identity over reads.
export const cardKey = (c: Pick<StoryCard, "kind" | "key">): string => `${c.kind}:${c.key}`;
/// The view after a read. Idle (`hold` false): the server's cards and lists as sent (a broken or repeated card or row
/// is dropped; a coin shows once). In use (`hold`: a mouse over the lists, a tap in the last few seconds, keyboard
/// focus): nothing on screen moves. Cards keep their order and their coins' order with fresh numbers, a new card or
/// row goes last, and one the server dropped stays with its last numbers, marked `left`, until the page is idle
/// (`moved` too when its coin is still listed elsewhere: it joined a story card, say). The themes are held the same way.
export function storiesView(fresh: Partial<Stories> | null | undefined, shown: StoriesView | null, hold = false): StoriesView {
  const seen = new Set<string>(), keys = new Set<string>(), cards: StoryCardShown[] = [];
  for (const c of fresh && Array.isArray(fresh.cards) ? fresh.cards : []) {
    if (!c || typeof c.key !== "string" || (c.kind !== "post" && c.kind !== "family" && c.kind !== "narrative") || keys.has(cardKey(c))) continue;
    // a narrative card is nothing without its narrative
    if (c.kind === "narrative" && !narrativeOf(c)) continue;
    const coins = cleanRows(c.coins, seen);
    if (!coins.length) continue;
    keys.add(cardKey(c));
    cards.push({ ...c, post: c.post ?? null, family: c.family ?? null, coins });
  }
  const loose = cleanRows(fresh?.loose, seen), dust = cleanRows(fresh?.dust, seen);
  const themes = (fresh && Array.isArray(fresh.themes) ? fresh.themes : []).filter((t) => t && typeof t.theme === "string");
  const next: StoriesView = { cards, loose, dust, hiddenDust: whole(fresh?.hidden?.dust), hiddenCards: whole(fresh?.hidden?.cards), hiddenLoose: whole(fresh?.hidden?.loose), tagging: fresh?.tagging?.on === true, themes };
  if (!hold || !shown) return next;
  const by = new Map(cards.map((c) => [cardKey(c), c] as const)), kept = new Set<string>(), held: StoryCardShown[] = [];
  for (const c of shown.cards) {
    const k = cardKey(c);
    if (kept.has(k)) continue;
    kept.add(k);
    const f = by.get(k);
    if (f) { held.push({ ...f, coins: markMoved(holdRows(f.coins, c.coins), seen) }); continue; }
    // a card the read no longer has: regrouped when every coin of it is listed elsewhere now
    const moved = c.coins.length > 0 && c.coins.every((r) => seen.has(r.mint));
    held.push(c.left && (c.moved === true) === moved ? c : { ...c, left: true, moved });
  }
  for (const [k, c] of by) if (!kept.has(k)) held.push(c);
  return { ...next, themes: holdThemes(themes, shown.themes), cards: held, loose: markMoved(holdRows(loose, shown.loose), seen), dust: markMoved(holdRows(dust, shown.dust), seen) };
}
/// Live trades over the whole view; the same object when none applied.
export function liveStories(v: StoriesView, by: Map<string, LiveTrade[]>): StoriesView {
  const cards = liveFamilies(v.cards, by), loose = liveRows(v.loose, by), dust = liveRows(v.dust, by);
  return cards === v.cards && loose === v.loose && dust === v.dust ? v : { ...v, cards, loose, dust };
}
/// A read applied over live prices (see carryLive): a coin keeps its live price wherever the read put it.
export function carryLiveStories(fresh: StoriesView, shown: StoriesView | null, readAt: number, windowMs = LIVE_CARRY_MS): StoriesView {
  if (!shown) return fresh;
  const all = [...shown.cards.flatMap((c) => c.coins), ...shown.loose, ...shown.dust];
  if (!all.some((c) => c && finite(c.liveAt))) return fresh;
  return { ...fresh, cards: fresh.cards.map((c) => ({ ...c, coins: carryLive(c.coins, all, readAt, windowMs) })), loose: carryLive(fresh.loose, all, readAt, windowMs), dust: carryLive(fresh.dust, all, readAt, windowMs) };
}
/// The mints whose trades the page follows: every coin of the cards (their chips show a market cap) and the loose
/// list, and the dust rows only while they are shown.
export function storyMints(v: StoriesView | null, withDust = false): Set<string> {
  const s = new Set<string>();
  if (!v) return s;
  for (const c of v.cards) for (const r of c.coins) s.add(r.mint);
  for (const r of v.loose) s.add(r.mint);
  if (withDust) for (const r of v.dust) s.add(r.mint);
  return s;
}

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
/// Only an alert sent in the last 30 min is notified (a reconnecting stream, or a clock far off, must not bring up an
/// old one). Measured from `alertedAt` when the server sends it: a family that started without an alert gets its one
/// alert later, and by its start time that alert would be dropped here.
export const wakeFresh = (e: Pick<WakeEvent, "startedAt" | "alertedAt">, nowS: number): boolean => {
  const at = finite(e.alertedAt) ? e.alertedAt : e.startedAt;
  return finite(at) && nowS - at < 1800;
};
/// The notification: "$NVDAx is waking up · buying 14x its normal", with the buyers as its body.
export function alertText(e: WakeEvent): { title: string; body: string } {
  const p = e.parent;
  const name = p.symbol ? `$${p.symbol}` : p.name || short(p.mint);
  return { title: `${name} is waking up · buying ${ratioX(e.ratio)} its normal`, body: `${plural(whole(e.buyers5m), "buyer")} in 5 min across its coins` };
}
