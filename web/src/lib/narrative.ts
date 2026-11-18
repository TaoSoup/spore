// Linked posts: the X posts a family's coins link in their metadata (GET /api/narrative/:mint, `Narrative` in
// lib/api.ts), turned into what the map panel and the coin page show (components/narrative/). Pure: no DOM, no network
// (test/narrative.test.mts). The posts are picked by coin creators and unverified, so nothing here trusts the body: the
// link is rebuilt from the id's digits (never the body's `url`), a handle is shown only when it has the shape of one,
// and every word says what is counted (coins linking a post, what those coins traded), never what a post did.
import type { Narrative, NarrativeCoin, NarrativeOwn, NarrativePost, NarrativeState } from "./api";
import { plural, short, usd } from "./format";

/// A post id: a positive decimal of at most 19 digits (what fits X's 64-bit ids).
const POST_ID = /^[1-9]\d{0,18}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/// The only link to a post the web opens: built here from the id's digits; null for anything that is not an id.
/// `/i/status/<id>` names no author (X redirects to the real one), so the link claims nothing.
export const safePostUrl = (id: unknown): string | null => (typeof id === "string" && POST_ID.test(id) ? `https://x.com/i/status/${id}` : null);

/// The author's handle, only for a post whose text is known and only when it has the shape of a handle.
export const postHandle = (p: { state: NarrativeState; handle: string | null }): string | null =>
  (p.state === "ok" && typeof p.handle === "string" && HANDLE.test(p.handle) ? p.handle : null);
/// The post link's words: the author when known, else a plain "View post".
export const postLinkText = (p: { state: NarrativeState; handle: string | null }): string => { const h = postHandle(p); return h ? `@${h} ↗` : "View post ↗"; };
/// How many coins link the post: a family post's count, or the subject and its siblings; null when not known.
const linkers = (p: NarrativePost | NarrativeOwn): number | null => ("coins" in p ? p.coins : p.siblings != null ? p.siblings + 1 : null);
/// The spoken name of a "View post" link (several rows read the same otherwise).
export const postLinkAria = (p: NarrativePost | NarrativeOwn): string => { const n = linkers(p); return typeof n === "number" && n > 0 ? `View the post on X, linked by ${plural(n, "coin")}` : "View the post on X"; };
/// The post's words for a row: only a known text, as plain text for the caller to render as text. A row shows a few
/// clamped lines, so every line break (with the blanks around it) reads as one space: an empty line between a
/// headline and the body would otherwise use up a line of the clamp. The whole post is behind the row's link.
export const postText = (p: { state: NarrativeState; text: string | null }): string =>
  (p.state === "ok" && typeof p.text === "string" ? p.text.replace(/[ \t]*\n[ \t\n]*/g, " ").trim() : "");

const label = (c: { mint: string; symbol: string | null }) => (c.symbol ? `$${c.symbol}` : short(c.mint));
/// Volume worth a figure: a dollar or more.
const hasVol = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n >= 1;

/// What is shown first, what is behind "Show more", the shared words and whether there is anything at all.
/// `lead`: the subject's own post; else the first post its children link; else its parent's best post.
/// `rest`: the other family posts, without the one the own post already shows. `words`: only two or more.
export type NarrativeLead =
  | { kind: "own"; post: NarrativeOwn }
  | { kind: "family"; post: NarrativePost }
  | { kind: "under"; post: NarrativePost; parent: { mint: string; name: string | null; symbol: string | null } };
export type NarrativeView = { lead: NarrativeLead | null; rest: NarrativePost[]; words: { w: string; n: number }[]; empty: boolean };
export function narrativeView(n: Narrative | null | undefined): NarrativeView {
  const posts = n && Array.isArray(n.posts) ? n.posts : [];
  const own = n?.own ?? null, under = n?.under?.post ? n.under : null;
  const lead: NarrativeLead | null = own ? { kind: "own", post: own }
    : posts.length > 0 ? { kind: "family", post: posts[0] }
    : under ? { kind: "under", post: under.post, parent: { mint: under.mint, name: under.name, symbol: under.symbol } }
    : null;
  const rest = own ? posts.filter((p) => p.id !== own.id) : posts.slice(1);
  const words = n && Array.isArray(n.words) && n.words.length >= 2 ? n.words : [];
  return { lead, rest, words, empty: lead === null };
}

/// "28 coins · $12.3K vol": the coins linking the post and what they traded in 24 h (left out under $1).
export const postStat = (p: { coins: number; usd24: number }): string => `${plural(p.coins, "coin")}${hasVol(p.usd24) ? ` · ${usd(p.usd24)} vol` : ""}`;
/// The same in sentences, saying what the numbers are not.
export const postStatTitle = (p: { coins: number; usd24: number }): string => {
  const one = p.coins === 1;
  return `${plural(p.coins, "coin")} ${one ? "links" : "link"} to this post.${hasVol(p.usd24) ? ` ${one ? "It" : "They"} traded ${usd(p.usd24)} in the last 24 h.` : ""} This is not a measure of the post.`;
};
/// "Also linked by 5 other coins under $NVDAx"; null when no other coin links the post (or there is no parent).
export function siblingsLine(own: NarrativeOwn | null | undefined): string | null {
  const n = own?.siblings;
  if (!own || typeof n !== "number" || !(n > 0)) return null;
  return `Also linked by ${plural(n, "other coin")}${own.parent ? ` under ${label(own.parent)}` : ""}`;
}
/// A coin chip's words: "$JENSEN $1.2K", as its two parts (the 24 h volume is null under $1) and as one string.
export const chipSym = (c: NarrativeCoin): string => label(c);
export const chipVol = (c: NarrativeCoin): string | null => (hasVol(c.usd24) ? usd(c.usd24) : null);
export const chipText = (c: NarrativeCoin): string => { const v = chipVol(c); return v ? `${chipSym(c)} ${v}` : chipSym(c); };
/// The small line over the first row: whose link it is (`label`: the subject's ticker), and over the rest.
export const CAPTION_OWN = "Linked by this coin's creator";
export const familyCaption = (label: string): string => `Linked by coins under ${label}`;
export const moreCaption = (label: string): string => `More posts linked by coins under ${label}`;
/// The button that opens the rest: the other posts counted, or plain "Show more" when only the words are behind it.
export const moreText = (posts: number): string => (posts > 0 ? `Show ${posts} more` : "Show more");
/// "Common words in names: jensen · senate · cat".
export const wordsLine = (words: { w: string }[]): string => `Common words in names: ${words.map((x) => x.w).join(" · ")}`;
/// Under every list of posts: who picked them, and that nobody checked.
export const NARRATIVE_FOOT = "Posts are picked by coin creators, not checked, and their authors may have nothing to do with these coins.";

/* ---------- asking again while post texts are fetched */

type Row = { id: string; state: NarrativeState; handle: string | null; text: string | null };
const rowsOf = (n: Narrative): Row[] => [...(n.posts ?? []), ...(n.own ? [n.own] : []), ...(n.under?.post ? [n.under.post] : [])];
/// Some row still waits for its text.
export const anyWait = (n: Narrative): boolean => rowsOf(n).some((r) => r.state === "wait");

/// A later answer for the same coin, laid over what is on screen: the rows shown keep their order, their count and
/// their numbers, and take only `state`, `handle` and `text` from the fresh body, by id. A row the fresh body lacks
/// keeps what it had, except that it stops waiting ("wait" reads as "idle"): the server no longer lists the post (it
/// turned out not to be available, or fell out of the list), so no text is coming for it. So a poll fills texts in
/// and never moves, adds or removes a row. `pending` follows the rows shown, so the asking ends as soon as none of
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
    posts: (shown.posts ?? []).map(take),
    own: shown.own ? take(shown.own) : shown.own,
    under: shown.under?.post ? { ...shown.under, post: take(shown.under.post) } : shown.under,
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
    posts: (n.posts ?? []).map(idle),
    own: n.own ? idle(n.own) : n.own,
    under: n.under?.post ? { ...n.under, post: idle(n.under.post) } : n.under,
    pending: false,
  };
}
