// The story timeline (GET /api/timeline, the /timeline page): every story the 5-minute attention series recorded in a
// window of up to a day, newest start first, with the whole site's buyers per 5 minutes for the band above it. It reads
// what lib/attention.mjs already stored (story_buckets, story_starts); nothing new is recorded for it.
//
// Stories are the series' own keys: a narrative ("n:<id>"), an X post (its id) or a family (the parent's mint). The
// subject blocks ("t:") and automatic groups ("g:") file the same coins a second time, so they are left out here, and so
// is the site row ("*"), which is the band. A story is listed when its busiest 5 minutes in the window had at least
// `min` buyers; the others are counted, not listed. Facts only: what was measured, never a rating.
//
// Cost (the server's loop must not stall): one grouped pass over the window gives each story's peak and first bucket;
// starts are read for the stories over `min`; the order is settled from those alone, and only the STORIES_MAX listed
// stories have their rows read and are described. Pure: look-ups in, a plain object out; no sqlite, no clock of its own.

export const BUCKET_S = 300;
/** The peak sizes (buyers in one 5-minute bucket) a story needs to be listed: only these, so asks share the cache. */
export const MIN_CHOICES = [5, 20, 100], MIN_DEFAULT = 20;
/** Longest window one ask may cover (s), how far back a window may start (s: the series keeps 14 days), stories listed at most. */
export const SPAN_MAX_S = 26 * 3600, BACK_MAX_S = 15 * 86400, STORIES_MAX = 400;

/** Whether a stored story key belongs on the timeline (its own story, not a second filing or the site row). */
export const listedKey = (k) => typeof k === "string" && k !== "*" && !k.startsWith("t:") && !k.startsWith("g:");

/**
 * The body of GET /api/timeline.
 * - `peaks`: one entry per story with buckets in the window, `{ key, peak, firstT }` (its busiest bucket's buyers, its first bucket);
 * - `starts(keys)`: Map key → `{ startAt, source }` of the stored starts;
 * - `rowsOf(keys)`: the window's bucket rows of those stories, `{ key, t, buyers, buyUsd, launches, leaderMint, leaderBuyers, coins }`;
 * - `siteRows`: the site row's buckets `{ t, buyers }`; `describe(key)`: `{ kind, title, ... }`; `coinOf(mint)`: `{ mint, symbol, name, image }` or null.
 * Returns `{ from, to, asOf, bucketS, min, site, stories, listed, hidden, more }`.
 */
export function buildTimeline({ peaks, starts = () => new Map(), rowsOf = () => [], siteRows = [], from, to, min = MIN_DEFAULT, asOf, describe = () => null, coinOf = () => null }) {
  const kept = peaks.filter((p) => listedKey(p.key) && p.peak >= min);
  const hidden = peaks.filter((p) => listedKey(p.key)).length - kept.length;
  const stored = starts(kept.map((p) => p.key));
  // The stored start (a post's time, a family's wake-up, the first buyers) counts when it is not after the story's first
  // bucket in the window: a family that woke again later keeps only its latest wake-up there, which would place
  // yesterday's story at today's time. Otherwise the first bucket is the start; one at the window's edge is carried.
  const placed = kept.map((p) => {
    const s0 = stored.get(p.key) ?? null, st = s0 && s0.startAt < p.firstT + BUCKET_S ? s0 : null;
    const startAt = st?.startAt ?? p.firstT;
    return { ...p, startAt, startSource: st?.source ?? "first-bucket", carried: startAt < from || (!st && p.firstT <= from) };
  });
  placed.sort((a, b) => b.startAt - a.startAt || b.peak - a.peak || (a.key < b.key ? -1 : 1));
  const shown = placed.slice(0, STORIES_MAX);
  const rows = new Map();
  for (const r of rowsOf(shown.map((p) => p.key))) {
    if (r.t < from || r.t >= to) continue;
    let a = rows.get(r.key); if (!a) rows.set(r.key, a = []); a.push(r);
  }
  const stories = [];
  for (const p of shown) {
    const rs = (rows.get(p.key) ?? []).sort((a, b) => a.t - b.t);
    if (!rs.length) continue;
    const firstT = rs[0].t, lastT = rs[rs.length - 1].t;
    let peak = 0, peakT = null, buyUsd = 0, launches = 0, coins = 0;
    const lead = new Map();
    for (const r of rs) {
      if (r.buyers > peak) { peak = r.buyers; peakT = r.t; }
      buyUsd += r.buyUsd || 0; launches += r.launches || 0; coins = Math.max(coins, r.coins || 0);
      if (r.leaderMint && r.leaderBuyers > 0) lead.set(r.leaderMint, (lead.get(r.leaderMint) ?? 0) + r.leaderBuyers);
    }
    // buyers per bucket from the first to the last bucket in the window, 0 where nothing was stored
    const series = new Array(Math.floor((lastT - firstT) / BUCKET_S) + 1).fill(0);
    for (const r of rs) series[Math.floor((r.t - firstT) / BUCKET_S)] = r.buyers;
    let leader = null, best = 0;
    for (const [m, v] of lead) if (v > best || (v === best && leader && m < leader)) { leader = m; best = v; }
    stories.push({
      key: p.key, ...(describe(p.key) ?? { kind: "unknown", title: p.key }),
      startAt: p.startAt, startSource: p.startSource, carried: p.carried,
      firstT, lastT, peak, peakT, buyUsd: Math.round(buyUsd), launches, coins,
      leader: leader ? coinOf(leader) ?? { mint: leader, symbol: null, name: null, image: null } : null,
      series,
    });
  }
  const site = siteRows.filter((r) => r.t >= from && r.t < to).sort((a, b) => a.t - b.t).map((r) => ({ t: r.t, buyers: r.buyers }));
  return { from, to, asOf, bucketS: BUCKET_S, min, site, stories, listed: stories.length, hidden, more: Math.max(0, placed.length - STORIES_MAX) };
}

/** `{ from, to, min }` of a request's query, or `{ error }`. `nowS`: the server's clock. A lone `from` covers 24 h from it. */
export function timelineQuery(q, nowS) {
  const int = (v) => (v == null || v === "" ? null : Number(v));
  const nowB = Math.ceil(nowS / BUCKET_S) * BUCKET_S;
  let from = int(q.from), to = int(q.to);
  const min = int(q.min) ?? MIN_DEFAULT;
  if (to == null) to = from == null ? nowB : Math.min(from + 24 * 3600, nowB);
  if (from == null) from = to - 24 * 3600;
  if (![from, to, min].every(Number.isInteger)) return { error: "from, to and min must be whole numbers (from and to in unix seconds)" };
  if (to <= from || to - from > SPAN_MAX_S) return { error: `to must be after from, by at most ${SPAN_MAX_S / 3600} hours` };
  if (from < nowS - BACK_MAX_S || from > nowS + 3600) return { error: "from must be within the last 15 days" };
  if (!MIN_CHOICES.includes(min)) return { error: `min must be one of ${MIN_CHOICES.join(", ")}` };
  // whole buckets, so asks a few seconds apart share one cached body
  return { from: Math.floor(from / BUCKET_S) * BUCKET_S, to: Math.ceil(to / BUCKET_S) * BUCKET_S, min };
}
