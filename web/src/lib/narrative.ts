// Launch timeline: the X posts a family's coins link in their metadata (GET /api/narrative/:mint, `Narrative` in
// lib/api.ts), as the one-line events the map panel, the coin page and the Discover page show (components/narrative/).
// An event is one post and the coins launched linking it; the list is by the time of the first such coin, newest
// first, as the server sends it. Pure: no DOM, no network (test/narrative.test.mts). The posts are picked by coin
// creators and unverified, so nothing here trusts the body: the link is rebuilt from the id's digits (never the body's
// `url`), a handle is shown only when it has the shape of one, and every word says what is counted (coins linking a
// post, what those coins traded), never what a post did.
import type { Narrative, NarrativeCoin, NarrativeEvent, NarrativeOwn, NarrativeState } from "./api";
import { age, count, plural, short, usd } from "./format";

/// A post id: a positive decimal of at most 19 digits (what fits X's 64-bit ids).
const POST_ID = /^[1-9]\d{0,18}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/// The only link to a post the web opens: built here from the id's digits; null for anything that is not an id.
/// `/i/status/<id>` names no author (X redirects to the real one), so the link claims nothing.
export const safePostUrl = (id: unknown): string | null => (typeof id === "string" && POST_ID.test(id) ? `https://x.com/i/status/${id}` : null);

/// The author's handle, only for a post whose text is known and only when it has the shape of a handle.
export const postHandle = (p: { state: NarrativeState; handle: string | null }): string | null =>
  (p.state === "ok" && typeof p.handle === "string" && HANDLE.test(p.handle) ? p.handle : null);
/// The post's words: only a known text, as plain text for the caller to render as text. Every line break (with the
/// blanks around it) reads as one space, so a line shows the start of the post and an opened line one paragraph.
export const postText = (p: { state: NarrativeState; text: string | null }): string =>
  (p.state === "ok" && typeof p.text === "string" ? p.text.replace(/[ \t]*\n[ \t\n]*/g, " ").trim() : "");
/// The link out of an opened line, and its spoken name (several lines read the same otherwise).
export const POST_LINK = "View post ↗";
export const postLinkAria = (coins: number | null | undefined): string => (typeof coins === "number" && coins > 0 ? `View the post on X, linked by ${plural(coins, "coin")}` : "View the post on X");

const label = (c: { mint: string; symbol: string | null }) => (c.symbol ? `$${c.symbol}` : short(c.mint));
/// Volume worth a figure: a dollar or more.
const hasVol = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1;
/// A coin chip's words: "$JENSEN $1.2K", as its two parts (the 24 h volume is null under $1) and as one string.
export const chipSym = (c: NarrativeCoin): string => label(c);
export const chipVol = (c: NarrativeCoin): string | null => (hasVol(c.usd24) ? usd(c.usd24) : null);
export const chipText = (c: NarrativeCoin): string => { const v = chipVol(c); return v ? `${chipSym(c)} ${v}` : chipSym(c); };

/* ---------- one line */

/// A line's time: "5m", "2h" (lib/format age); nothing for an unknown time.
export const lineAge = (at: number | null | undefined): string => (typeof at === "number" && Number.isFinite(at) ? age(at) : "");
/// A line's words. `lead`: "3 coins" for an event (always there, so the line reads before the post's text is in);
/// null for a coin's own post. `handle` and `text`: only for a known text. A line with nothing else to say reads
/// "Linked post".
export type LineParts = { lead: string | null; handle: string | null; text: string };
export function lineParts(p: NarrativeEvent | NarrativeOwn): LineParts {
  const lead = "coins" in p ? plural(p.coins, "coin") : null;
  const h = postHandle(p), text = postText(p);
  return { lead, handle: h ? `@${h}` : null, text: text || (lead || h ? "" : "Linked post") };
}
/// The line as one string, as it reads across: "3 coins · @tradfi · NVIDIA to announce".
export const lineText = (p: NarrativeEvent | NarrativeOwn): string => { const l = lineParts(p); return [l.lead, l.handle, l.text].filter(Boolean).join(" · "); };
/// The coin at the end of an event's line: the first of its top coins (the server sends them best 24 h volume first).
export const lineChip = (e: { top: NarrativeCoin[] }): NarrativeCoin | null => (Array.isArray(e.top) && e.top.length > 0 ? e.top[0] : null);

/* ---------- the list */

/// Which lines show: the first `collapsed`, or all once opened; `more`: how many "Show N more" would add.
export function shownLines<T>(events: readonly T[], collapsed: number, expanded: boolean): { lines: T[]; more: number } {
  const n = Math.max(1, Math.floor(collapsed));
  return expanded || events.length <= n ? { lines: events.slice(), more: 0 } : { lines: events.slice(0, n), more: events.length - n };
}
export const moreText = (more: number): string => `Show ${count(more)} more`;
/// The list while it is in use (a line is open, or the pointer or the keyboard is on it): exactly the lines that
/// were on screen, in their order, each with what the new read says about it (a line the new read lacks keeps what it
/// showed). Nothing is added, so no line moves under a finger or a reader; the new lines come when the hold ends
/// (`held` null: the new read as it is).
export function heldLines<T extends { id: string }>(fresh: readonly T[], held: readonly T[] | null | undefined): T[] {
  if (!held) return fresh.slice();
  const by = new Map<string, T>();
  for (const e of fresh) if (!by.has(e.id)) by.set(e.id, e);
  return held.map((e) => by.get(e.id) ?? e);
}
/// "14 earlier events", under the last line: the events older than the last one listed, which the server counts and
/// does not list; null when there are none.
export const earlierNote = (earlier: number | null | undefined): string | null => (typeof earlier === "number" && earlier >= 1 ? plural(Math.floor(earlier), "earlier event") : null);
/// "5 other coins link this post"; null when no other coin links the coin's own post.
export function othersLine(own: NarrativeOwn | null | undefined): string | null {
  const n = own?.siblings;
  if (!own || typeof n !== "number" || !(n > 0)) return null;
  return n === 1 ? "1 other coin links this post" : `${count(n)} other coins link this post`;
}

/// What a coin's block shows. `own`: the coin's own post. `events`: the timeline of the coins under it. `under`: its
/// parent's newest event, only for a coin with neither. `empty`: nothing at all.
export type NarrativeView = {
  own: NarrativeOwn | null; events: NarrativeEvent[]; earlier: number;
  under: { event: NarrativeEvent; parent: { mint: string; name: string | null; symbol: string | null } } | null;
  empty: boolean;
};
export function narrativeView(n: Narrative | null | undefined): NarrativeView {
  const events = n && Array.isArray(n.events) ? n.events : [];
  const own = n?.own ?? null;
  const under = !own && events.length === 0 && n?.under?.event ? { event: n.under.event, parent: { mint: n.under.mint, name: n.under.name, symbol: n.under.symbol } } : null;
  const earlier = n && typeof n.earlier === "number" && n.earlier >= 1 ? Math.floor(n.earlier) : 0;
  return { own, events, earlier, under, empty: !own && events.length === 0 && !under };
}

export const CAPTION_TIMELINE = "Launch timeline";
export const CAPTION_OWN = "Linked by this coin's creator";
/// Under every list: who picked the posts, and that nobody checked.
export const NARRATIVE_FOOT = "Posts are picked by coin creators and aren't checked.";

/* ---------- asking again while post texts are fetched */

type Row = { id: string; state: NarrativeState; handle: string | null; text: string | null };
const rowsOf = (n: Narrative): Row[] => [...(n.events ?? []), ...(n.own ? [n.own] : []), ...(n.under?.event ? [n.under.event] : [])];
/// Some line still waits for its text.
export const anyWait = (n: Narrative): boolean => rowsOf(n).some((r) => r.state === "wait");

/// A later answer for the same coin, laid over what is on screen: the lines shown keep their order, their count and
/// their numbers, and take only `state`, `handle` and `text` from the fresh body, by id. A line the fresh body lacks
/// keeps what it had, except that it stops waiting ("wait" reads as "idle"): the server no longer lists the post (it
/// turned out not to be available, or fell out of the list), so no text is coming for it. So a poll fills texts in
/// and never moves, adds or removes a line. `pending` follows the lines shown, so the asking ends as soon as none of
/// them waits. A body for another coin replaces everything.
export function mergePoll(shown: Narrative, fresh: Narrative | null | undefined): Narrative {
  if (!fresh) return shown;
  if (fresh.mint !== shown.mint) return fresh;
  const by = new Map<string, Row>();
  for (const r of rowsOf(fresh)) if (!by.has(r.id)) by.set(r.id, r);
  const take = <T extends Row>(r: T): T => {
    const f = by.get(r.id);
    return f ? { ...r, state: f.state, handle: f.handle, text: f.text } : r.state === "wait" ? { ...r, state: "idle" } : r;
  };
  const out: Narrative = {
    ...shown,
    events: (shown.events ?? []).map(take),
    own: shown.own ? take(shown.own) : shown.own,
    under: shown.under?.event ? { ...shown.under, event: take(shown.under.event) } : shown.under,
  };
  out.pending = anyWait(out);
  return out;
}

/// A new read of the same coin's list (the Discover page reads an open timeline again while coins keep launching):
/// the new body is shown as it is, new events on top, except that a text on screen is not taken away: a line the new
/// body has without its text ("wait" or "idle") keeps the `state`, `handle` and `text` it showed.
export function mergeRefresh(shown: Narrative | null | undefined, fresh: Narrative): Narrative {
  if (!shown || shown.mint !== fresh.mint) return fresh;
  const known = new Map<string, Row>();
  for (const r of rowsOf(shown)) if (r.state === "ok" && !known.has(r.id)) known.set(r.id, r);
  const keep = <T extends Row>(r: T): T => {
    const k = r.state === "wait" || r.state === "idle" ? known.get(r.id) : undefined;
    return k ? { ...r, state: k.state, handle: k.handle, text: k.text } : r;
  };
  const out: Narrative = {
    ...fresh,
    events: (fresh.events ?? []).map(keep),
    own: fresh.own ? keep(fresh.own) : fresh.own,
    under: fresh.under?.event ? { ...fresh.under, event: keep(fresh.under.event) } : fresh.under,
  };
  out.pending = anyWait(out);
  return out;
}

/// Which answer is on screen for the selected coin: the newest one when it is for that coin, else the one already
/// shown. An answer for a coin that is no longer selected is never shown (the block neither switches to that coin's
/// posts nor disappears); the caller keeps it, and it shows if that coin is selected again.
export const shownAnswer = <T extends { mint: string | null }>(shown: T, got: T, mint: string | null): T => (got.mint === mint ? got : shown);

/// The wait before the next ask while texts are pending: 2.5 s, 5 s, 10 s, 20 s, then no more (null).
const LADDER_MS = [2_500, 5_000, 10_000, 20_000];
export const nextPollMs = (tries: number): number | null => LADDER_MS[tries] ?? null;

/// The asking has ended: a text that never came is not waited for any more ("wait" reads as "idle").
export function settle(n: Narrative): Narrative {
  const idle = <T extends Row>(r: T): T => (r.state === "wait" ? { ...r, state: "idle" } : r);
  return {
    ...n,
    events: (n.events ?? []).map(idle),
    own: n.own ? idle(n.own) : n.own,
    under: n.under?.event ? { ...n.under, event: idle(n.under.event) } : n.under,
    pending: false,
  };
}
