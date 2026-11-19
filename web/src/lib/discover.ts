// The Discover page (pages/Discover.tsx), the map panel's "Moving now" block (map/panel/MovingBlock.tsx) and the wake-up
// alerts (components/WakeAlerts.tsx): families whose existing coins are being bought far above their normal level
// (GET /api/discover, `Discover` in lib/api.ts; SSE `wake`), as words, a sparkline and an order. Pure: no DOM, no
// network, no storage (test/discover.test.mts). Every line says what is measured ("buying 14x its normal", "170 buyers
// in 5 min"), never why, never what a coin will do, and a linked post is only what coincided.
import type { DiscoverOne, WakeCoin, WakeEvent, WakeFamily, WakePost } from "./api";
import { count, plural, short } from "./format";
import { postHandle, postText, safePostUrl } from "./narrative";

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

/// The card's foot: "8 more trading · 23 hidden: creator sold out or repeat launch", each part only when it is not 0;
/// null when both are.
export const HIDDEN_WHY = "creator sold out or repeat launch";
export function footLine(more: number | null | undefined, hidden: number | null | undefined): string | null {
  const parts: string[] = [];
  if (whole(more) > 0) parts.push(`${count(whole(more))} more trading`);
  if (whole(hidden) > 0) parts.push(`${count(whole(hidden))} hidden: ${HIDDEN_WHY}`);
  return parts.length ? parts.join(" · ") : null;
}
export const HIDDEN_TITLE = "Left out: the creator sold 90% or more of its own buy within 10 minutes, launched 10 or more coins in the hour before, or launched the same ticker under this parent again.";

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
  const foot = footLine(r.more, r.hidden) !== null;
  return { ...f, coins, state: r.state, post: r.post ? f.post ?? r.post : null, more: foot ? f.more : r.more, hidden: foot ? f.hidden : r.hidden };
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
