// The story timeline page's view logic (pages/Timeline.tsx, GET /api/timeline): the day windows in the reader's own
// time, the hour groups, the words and the chart geometry. No DOM, no network.
import type { Timeline, TimelineGateCoin, TimelineGateStory, TimelineStory } from "./api";

export const BUCKET_S = 300;
export type DayKey = "24h" | "today" | "yesterday" | `d:${string}`;
export const MIN_ITEMS = [
  { key: "100", text: "100+", title: "Stories with 100 or more buyers in their busiest 5 minutes" },
  { key: "20", text: "20+", title: "Stories with 20 or more buyers in their busiest 5 minutes" },
  { key: "5", text: "5+", title: "Stories with 5 or more buyers in their busiest 5 minutes" },
] as const;
export type MinKey = (typeof MIN_ITEMS)[number]["key"];
export const parseMin = (s: string | null): MinKey => (s === "100" || s === "5" ? s : "20");

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** How many days back an earlier day may be (the series keeps 14 days). */
export const DAYS_BACK = 14;
/**
 * `?day=` of the URL: "24h" (default), "today", "yesterday" or "d:YYYY-MM-DD" (an earlier local day, 2 to DAYS_BACK days
 * back). A date that is today or yesterday reads as those; a date that does not exist, is in the future or is older than
 * the series reads as "24h", so the page never asks for a window the server refuses.
 */
export function parseDay(s: string | null, nowMs = Date.now()): DayKey {
  if (s === "today" || s === "yesterday") return s;
  const m = s && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return "24h";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (ymd(d) !== s) return "24h";
  const today = midnight(new Date(nowMs)), back = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (back === 0) return "today";
  if (back === 1) return "yesterday";
  return back >= 2 && back <= DAYS_BACK ? `d:${s}` : "24h";
}
export const dayParam = (k: DayKey) => (k.startsWith("d:") ? k.slice(2) : k);

/** `{ from, to }` (unix s) of a day choice in the reader's local time; "today" and "24h" end now. */
export function windowOf(k: DayKey, nowMs = Date.now()): { from: number; to: number } {
  const now = new Date(nowMs), s = (d: Date) => Math.floor(d.getTime() / 1000), nowS = Math.floor(nowMs / 1000);
  if (k === "24h") return { from: nowS - 86400, to: nowS };
  const m = midnight(now);
  if (k === "today") return { from: s(m), to: nowS };
  const day = k === "yesterday" ? new Date(m.getFullYear(), m.getMonth(), m.getDate() - 1) : new Date(`${k.slice(2)}T00:00:00`);
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  return { from: s(day), to: Math.min(s(next), nowS) };
}
/** The earlier days offered (2 to `n` days back, the series keeps 14), newest first: `[{ key, text }]`. */
export function earlierDays(nowMs = Date.now(), n = DAYS_BACK): { key: DayKey; text: string }[] {
  const m = midnight(new Date(nowMs)), out: { key: DayKey; text: string }[] = [];
  for (let i = 2; i <= n; i++) {
    const d = new Date(m.getFullYear(), m.getMonth(), m.getDate() - i);
    out.push({ key: `d:${ymd(d)}`, text: d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) });
  }
  return out;
}

export const clock = (t: number) => new Date(t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
/** The start of the local hour `t` is in, cut from the instant itself (rebuilding it from local fields would fold the
 * repeated hour of a daylight-saving fall-back night into one). */
const hourOf = (t: number) => { const off = -new Date(t * 1000).getTimezoneOffset() * 60; return t - ((((t + off) % 3600) + 3600) % 3600); };

/**
 * Stories by the local hour they started in, newest hour first; stories that started before the window go last, apart.
 * `alsoHours`: hour starts with something else to show (the gates' passes), listed even with no story of their own.
 */
export function hourGroups(stories: readonly TimelineStory[], alsoHours: Iterable<number> = []): { key: string; t: number | null; label: string; stories: TimelineStory[] }[] {
  const by = new Map<number, TimelineStory[]>(), before: TimelineStory[] = [];
  for (const s of stories) {
    if (s.carried) { before.push(s); continue; }
    const h = hourOf(s.startAt);
    let a = by.get(h); if (!a) by.set(h, a = []); a.push(s);
  }
  for (const h of alsoHours) if (!by.has(h)) by.set(h, []);
  const out: { key: string; t: number | null; label: string; stories: TimelineStory[] }[] = [...by].sort((a, b) => b[0] - a[0]).map(([h, a]) => ({ key: String(h), t: h, label: `${clock(h)} – ${clock(h + 3600)}`, stories: a }));
  if (before.length) out.push({ key: "before", t: null, label: "Started earlier, still bought in this window", stories: before.sort((a, b) => b.peak - a.peak) });
  return out;
}
/** The gates' passes by the local hour they happened in: the coin gate's launches and the story gate's passes of stories that are not rows. */
export function gateHours(t: Pick<Timeline, "gateCoins" | "gateStories">): Map<number, { coins: TimelineGateCoin[]; stories: TimelineGateStory[] }> {
  const out = new Map<number, { coins: TimelineGateCoin[]; stories: TimelineGateStory[] }>();
  const at = (h: number) => { let x = out.get(h); if (!x) out.set(h, x = { coins: [], stories: [] }); return x; };
  for (const c of t.gateCoins ?? []) at(hourOf(c.at)).coins.push(c);
  for (const s of t.gateStories ?? []) at(hourOf(s.firstAt)).stories.push(s);
  for (const x of out.values()) x.coins.sort((a, b) => b.at - a.at);
  return out;
}
/** "9× normal · 25 buyers": a story gate pass in a few words. */
export const gateWords = (g: { best: { lift: number; buyers: number } }) => `${g.best.lift}× normal · ${g.best.buyers} buyers`;
/** "8 s", "3 min", "1 h 5 min": time from a launch to its gate pass. */
export function secsWords(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** "2 h 10 m", "35 m", "5 m": how long a story had stored buckets in the window (first to last bucket, inclusive). */
export function spanWords(s: Pick<TimelineStory, "firstT" | "lastT">): string {
  const m = Math.round((s.lastT - s.firstT + BUCKET_S) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}` : `${m} m`;
}
export const KIND_WORD: Record<string, string> = { post: "Post", narrative: "Story", family: "Family" };
/** A story's title, as text (a narrative title is a language model's; a post's text is the poster's). */
export function titleOf(s: TimelineStory): string {
  if (s.kind === "post") return s.handle ? s.title || "(no text)" : "An X post (not stored)";
  return s.title || "Untitled story";
}

/** The path of a small line chart of `ys` in a `w` × `h` box, scaled to its own peak (an empty string for nothing). */
export function sparkPath(ys: readonly number[], w: number, h: number): string {
  if (!ys.length) return "";
  const max = Math.max(1, ...ys), n = ys.length, x = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w), y = (v: number) => h - 1 - (v / max) * (h - 2);
  if (n === 1) return `M${(w / 2 - 2).toFixed(1)},${y(ys[0]).toFixed(1)}H${(w / 2 + 2).toFixed(1)}`;
  return ys.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
}

/** The band: the site's buyers per 5 minutes over the window as an area path, and where each listed story started. */
export function bandGeo(t: Pick<Timeline, "from" | "to" | "site" | "stories">, w: number, h: number) {
  const span = Math.max(BUCKET_S, t.to - t.from), x = (time: number) => Math.min(w, Math.max(0, ((time - t.from) / span) * w));
  const max = Math.max(1, ...t.site.map((p) => p.buyers)), y = (v: number) => h - (v / max) * (h - 4);
  // one closed piece per run of consecutive buckets: a stretch the server did not record is drawn empty, never bridged
  let area = "";
  for (let i = 0; i < t.site.length; ) {
    let j = i;
    while (j + 1 < t.site.length && t.site[j + 1].t - t.site[j].t <= BUCKET_S) j++;
    const run = t.site.slice(i, j + 1);
    area += `M${x(run[0].t).toFixed(1)},${h}` + run.map((p) => `L${x(p.t).toFixed(1)},${y(p.buyers).toFixed(1)}`).join("") + `L${x(run[run.length - 1].t).toFixed(1)},${h}Z`;
    i = j + 1;
  }
  const peakMax = Math.max(1, ...t.stories.map((s) => s.peak));
  const marks = t.stories.filter((s) => !s.carried).map((s) => ({ key: s.key, x: x(s.startAt), len: 6 + Math.sqrt(s.peak / peakMax) * (h * 0.45), gate: !!s.gate }));
  return { area, marks, max, x, w, h };
}
/** Labels along the band: whole local hours every `step` hours (3 for a day, 1 for a few hours), as `{ x: 0-1, text }`; a window over a day boundary names the day at midnight. */
export function axisTicks(from: number, to: number): { at: number; text: string }[] {
  const span = to - from, step = span > 12 * 3600 ? 3 : span > 4 * 3600 ? 1 : 0.5, out: { at: number; text: string }[] = [];
  if (span <= 0) return out;
  const d = new Date(from * 1000), h0 = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime() / 1000;
  for (let t = h0; t <= to; t += Math.min(step, 1) * 3600) {
    if (t <= from + span * 0.03 || t >= to - span * 0.03) continue;
    const dt = new Date(t * 1000);
    if (step >= 1 && dt.getHours() % step !== 0) continue;
    out.push({ at: (t - from) / span, text: dt.getHours() === 0 && dt.getMinutes() === 0 ? `${dt.toLocaleDateString("en-US", { weekday: "short" })} ${dt.getDate()}` : clock(t) });
  }
  return out;
}
/** The site bucket that holds `time` (the 5 minutes starting at its `t`), or null where nothing was recorded. */
export function nearestSite(site: Timeline["site"], time: number) {
  for (const p of site) if (time >= p.t && time < p.t + BUCKET_S) return p;
  return null;
}
