// Stories (GET /api/stories): the Discover coin rows grouped by what they have in common, so a reader sees who posted
// and how many coins and buyers gathered around it. Pure: rows and look-ups in, plain objects out; no index, no sqlite,
// no clock of its own. lib/coinrows.mjs picks the candidate rows (the trending rules) and hands them over in rank order.
//
// In order:
// 1. The bot-dust floor (dustWhy): dust rows leave the cards and the loose list and are returned apart with a reason.
// 2. Each coin goes to at most one card: (a) the X post it links, when that post's handle and text are stored and may
//    be shown, whatever its parent; (b) else its family, when that family is waking up (live, not silent); (c) else
//    the loose list. A waking family whose chosen post may be shown has no card of its own: its coins join that post's
//    card, which then carries the family too.
// 3. Inside a card and inside the loose list, coins with the same ticker and the same image fold into one row: the one
//    with the most liquidity leads and lists the others as `copies`. Nothing here says which one came first or which
//    one is "the" coin: the lead is only the deepest pool.
// 2b. With narrative tags (lib/narrtags.mjs: a language model's reading of the coins' public text, which can be wrong):
//    coins left after the dust floor that share a narrative form a "narrative" card when it would hold two or more
//    coins (copies folded count once). Those coins leave the post card, family card or loose list they would be in;
//    the others are placed as in 2. A narrative is context for the reader: nothing here ranks or rates it.
// The numbers state what was measured. A card's `buyers5m` is the sum of its coins' 5-minute buyers (a wallet that
// bought two of them counts twice), copies included; `coinsN` counts every coin of the card, copies included.
import { PAPER_RATIO, TINY_USD, byMint } from "./rowshared.mjs";
import { postTime, postUrl } from "./narrative.mjs";

/** Cards, loose rows and dust rows a body lists at most. */
export const CARDS_MAX = 20, LOOSE_MAX = 30, DUST_MAX = 30;

/** A coin counts as new for this long after its creation (s): a narrative card's `isNew`, `newN` and `olderN`. */
export const NEW_S = 3_600;

const pos = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;

// ---------------------------------------------------------------- story keys
// One key per story, the same in the cards below, in the 5-minute series (lib/attention.mjs, table story_buckets) and in
// GET /api/story-series/:key:
// - a narrative card: "n:<narrative id>" (digits after "n:");
// - a post card: the X post id (snowflake digits, as in the post's URL);
// - a family card: the parent's mint (base58).
// The three never collide: an id has only digits, a mint has letters, "n:" has a colon.
// The series also keeps one row per 5 minutes under SITE_KEY ("*"), the whole site, which is never a card.
const NARR_KEY_RE = /^n:[1-9]\d{0,11}$/, POST_KEY_RE = /^[1-9]\d{0,18}$/, MINT_KEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const SITE_KEY = "*";
/** The key of a story: `kind` "narrative" (id: the narrative id), "post" (id: the post id) or "family" (id: the parent mint). */
export function storyKey(kind, id) {
  if (kind === "narrative") return `n:${id}`;
  if (kind === "post" || kind === "family") return String(id);
  throw new Error(`unknown story kind ${kind}`);
}
/** `{ kind, id }` of a story key (a narrative id as a number), or null for anything else (SITE_KEY included). */
export function parseStoryKey(key) {
  if (typeof key !== "string") return null;
  if (NARR_KEY_RE.test(key)) return { kind: "narrative", id: Number(key.slice(2)) };
  if (POST_KEY_RE.test(key)) return { kind: "post", id: key };
  if (MINT_KEY_RE.test(key)) return { kind: "family", id: key };
  return null;
}
/**
 * The story a coin's trade is filed under, by the cards' own precedence (groupStories below): its narrative when that
 * narrative holds 2+ coins (`narrativeCoins`: the caller's count of them; lib/attention.mjs passes 2 while the narrative
 * is "on": 2+ of its non-dust coins, copies folded, with a $1+ buyer in the last hour, held an hour after); else the post it links, when that post may be shown (`postOk`); else its
 * family, when that family is waking (live, not silent: `family` given), under the family's chosen post when that post
 * may be shown, else under the parent's mint; else null (no story). Pure.
 */
export function coinStoryKey({ narrativeId = null, narrativeCoins = 0, postId = null, postOk = false, family = null } = {}) {
  if (narrativeId != null && narrativeCoins >= 2) return storyKey("narrative", narrativeId);
  if (postId != null && postOk) return storyKey("post", postId);
  if (family?.mint) return family.postId != null && family.postOk ? storyKey("post", family.postId) : storyKey("family", family.mint);
  return null;
}

/**
 * Why a row is bot dust, or null: "paper" for a market cap over PAPER_RATIO times its real liquidity (only with a
 * known liquidity above zero), "tiny" for under TINY_USD of volume per buyer over the timeframe (only with a buyer).
 */
export function dustWhy(row) {
  if (pos(row?.liqUsd) && pos(row.mcapUsd) && row.mcapUsd > PAPER_RATIO * row.liqUsd) return "paper";
  const b = row?.tf?.buyers, v = row?.tf?.volUsd;
  if (pos(b) && typeof v === "number" && Number.isFinite(v) && v / b < TINY_USD) return "tiny";
  return null;
}

/** What two rows must share to fold: the ticker (trimmed, any case) and the image. Null for a row without either. */
export function copyKey(row) {
  const s = typeof row?.symbol === "string" ? row.symbol.trim().toLowerCase() : "";
  return s && typeof row.image === "string" && row.image ? `${s}\n${row.image}` : null;
}

const liq = (r) => (pos(r.liqUsd) ? r.liqUsd : 0);
/** Deepest pool first, then most 5-minute buyers, then the mint. */
const byDepth = (a, b) => liq(b) - liq(a) || (b.buyers5m ?? 0) - (a.buyers5m ?? 0) || byMint(a.mint, b.mint);

/**
 * `rows` (in rank order) with same-ticker same-image coins folded into one row each: the lead (most liquidity) stands
 * where the best-ranked of them stood and gets `copies: [{ mint, createdAt, firstSeenAt, liqUsd, buyers5m, buyers }]`
 * (`buyers`: the copy's buyers over the row's timeframe, its `tf.buyers`), deepest first. A row that folds nothing is returned as it came (no `copies`). The input rows are not changed.
 */
export function foldCopies(rows) {
  const groups = new Map(), order = [];
  for (const r of rows) {
    const k = copyKey(r);
    let g = k == null ? null : groups.get(k);
    if (!g) { g = [r]; order.push(g); if (k != null) groups.set(k, g); } else g.push(r);
  }
  return order.map((g) => {
    if (g.length === 1) return g[0];
    const [lead, ...rest] = [...g].sort(byDepth);
    return { ...lead, copies: rest.map((r) => ({ mint: r.mint, createdAt: r.createdAt ?? null, firstSeenAt: r.firstSeenAt ?? null, liqUsd: r.liqUsd ?? null, buyers5m: r.buyers5m ?? 0, buyers: r.tf?.buyers ?? 0 })) };
  });
}

/** The 5-minute buyers of folded rows, copies included, and how many coins they are. */
export function totals(rows) {
  let buyers5m = 0, coinsN = 0;
  for (const r of rows) {
    buyers5m += r.buyers5m ?? 0; coinsN++;
    for (const c of r.copies ?? []) { buyers5m += c.buyers5m ?? 0; coinsN++; }
  }
  return { buyers5m, coinsN };
}

/**
 * The stories of `rows` (coin rows in rank order, each with `parent: { mint } | null`).
 * `postIdOf(row)`: the id of the X post the coin links, or null. `postOf(id)`: `{ handle, text }` when that post's
 * handle and text are stored and may be shown, else null (not fetched, gone, flagged). `wakes`: parent mint →
 * `{ mint, symbol, image, startedAt, postId }` for the families waking up now (live, not silent; `postId`: the post the
 * family's card shows, or null). `nowMs`: the clock a post's time is checked against.
 *
 * Returns `{ cards, loose, dust, hidden: { dust, cards, loose } }`:
 * - `cards`: `{ kind: "post" | "family", key, post: { id, handle, text, at, url } | null, family: { mint, symbol, image,
 *   startedAt } | null, buyers5m, coinsN, coins }`, most `buyers5m` first, then `coinsN`, then `key`; at most
 *   CARDS_MAX (`hidden.cards`: how many more there were). `key` is the post id or the family's mint; `post.at` is
 *   when the post was made (unix s, from its id; null when the id carries no time).
 * - `loose`: the folded rows of no card, at most LOOSE_MAX (`hidden.loose`: the coins of no card that are not in it,
 *   copies counted). `dust`: the dust rows with `reason`, at most DUST_MAX;
 *   `hidden.dust` counts all of them.
 *
 * `tagOf(row)`: the coin's narrative `{ id, title, theme }` or null; null (the default) for no tagging at all, and the
 * result is then exactly as described above plus `themes: []`. With it: a tagged row carries `narrative: { id, title,
 * theme }` wherever it is listed; `cards` may hold `{ kind: "narrative", key: "n:<id>", narrative: { id, title, theme,
 * newCoins1h }, post, family: null, buyers5m, coinsN, newN, olderN, coins }` (rule 2b; each coin row has `isNew`;
 * `newN` / `olderN` count every coin, copies included, an unknown creation time as older; `post`: the post of its
 * most-bought coin that links one that may be shown, else null; `newCoins1hOf(id)` gives `newCoins1h`); a post or
 * family card has `narrative`: the one all its coins share, else null. `themes`: `[{ theme, cards }]` of the
 * narrative cards listed, most cards first.
 */
export function groupStories({ rows = [], postIdOf = () => null, postOf = () => null, wakes = new Map(), nowMs = Date.now(), tagOf = null, newCoins1hOf = () => 0 } = {}) {
  const posts = new Map(); // post id → { handle, text } | null, asked once
  const post = (id) => {
    if (id == null) return null;
    if (posts.has(id)) return posts.get(id);
    let p = null;
    try { const v = postOf(id); p = v && typeof v.handle === "string" && v.handle && typeof v.text === "string" ? { handle: v.handle, text: v.text } : null; } catch { p = null; }
    posts.set(id, p);
    return p;
  };
  const dust = [], bins = new Map(), loose = [];
  let dustN = 0;
  // Narrative tags, asked once per row; a tagged row is listed as a copy that carries its narrative.
  const tags = new Map(); // mint → { id, title, theme }
  if (tagOf) for (const row of rows) {
    let t = null;
    try { t = tagOf(row) ?? null; } catch { t = null; }
    if (t && Number.isInteger(t.id) && typeof t.title === "string" && typeof t.theme === "string") tags.set(row.mint, { id: t.id, title: t.title, theme: t.theme });
  }
  const tagged = (row) => { const t = tags.get(row.mint); return t ? { ...row, narrative: t } : row; };
  // Rule 2b: which narratives hold two or more coins that are not dust (copies folded count once).
  const nbins = new Map(); // narrative id → its rows, in rank order
  if (tags.size) {
    for (const row of rows) {
      const t = tags.get(row.mint);
      if (!t || dustWhy(row)) continue;
      let b = nbins.get(t.id);
      if (!b) nbins.set(t.id, b = []);
      b.push(row);
    }
    for (const [id, b] of nbins) if (foldCopies(b).length < 2) nbins.delete(id);
  }
  const nowS = Math.floor(nowMs / 1000);
  const isNew = (r) => typeof r.createdAt === "number" && r.createdAt > nowS - NEW_S;
  const bin = (kind, id) => { const key = `${kind}:${id}`; let b = bins.get(key); if (!b) bins.set(key, b = { kind, id, rows: [], fams: new Map() }); return b; };
  for (const row of rows) {
    const why = dustWhy(row);
    if (why) { dustN++; if (dust.length < DUST_MAX) dust.push({ ...tagged(row), reason: why }); continue; }
    if (nbins.has(tags.get(row.mint)?.id)) continue; // on its narrative's card
    const own = postIdOf(row) ?? null, wake = row.parent?.mint ? wakes.get(row.parent.mint) ?? null : null;
    if (own != null && post(own)) {
      // The coin's own link comes first: it is counted under the post its creator pointed at, whatever its family shows.
      const b = bin("post", own);
      b.rows.push(tagged(row));
      if (wake && wake.postId === own) b.fams.set(wake.mint, (b.fams.get(wake.mint) ?? 0) + (row.buyers5m ?? 0));
    } else if (wake) {
      const b = wake.postId != null && post(wake.postId) ? bin("post", wake.postId) : bin("family", wake.mint);
      b.rows.push(tagged(row));
      b.fams.set(wake.mint, (b.fams.get(wake.mint) ?? 0) + (row.buyers5m ?? 0));
    } else loose.push(tagged(row));
  }
  const cards = [];
  for (const b of bins.values()) {
    const coins = foldCopies(b.rows), t = totals(coins);
    // Two families can show the same post: the card names the one that brought the most buyers (then the mint).
    const fam = [...b.fams].sort((x, y) => y[1] - x[1] || byMint(x[0], y[0]))[0]?.[0] ?? null, w = fam == null ? null : wakes.get(fam);
    const p = b.kind === "post" ? post(b.id) : null;
    // With tagging: the narrative every coin of the card shares, else null. Without: no such field.
    const one = tagOf ? b.rows.reduce((t, r) => (t === undefined ? r.narrative ?? null : t && r.narrative?.id === t.id ? t : null), undefined) ?? null : undefined;
    cards.push({
      kind: b.kind, key: storyKey(b.kind, b.id),
      post: p ? { id: b.id, handle: p.handle, text: p.text, at: postTime(b.id, nowMs), url: postUrl(b.id) } : null,
      family: w ? { mint: w.mint, symbol: w.symbol ?? null, image: w.image ?? null, startedAt: w.startedAt ?? null } : null,
      buyers5m: t.buyers5m, coinsN: t.coinsN, coins,
      ...(one === undefined ? null : { narrative: one }),
    });
  }
  for (const [id, b] of nbins) {
    const n = tags.get(b[0].mint);
    const coins = foldCopies(b.map((r) => ({ ...r, narrative: n, isNew: isNew(r) }))), t = totals(coins);
    // The post shown: of the coins that link a post that may be shown, the one with the most 5-minute buyers (then the mint).
    let p = null, pid = null;
    for (const r of [...b].sort((x, y) => (y.buyers5m ?? 0) - (x.buyers5m ?? 0) || byMint(x.mint, y.mint))) {
      const own = postIdOf(r) ?? null;
      if (own != null && post(own)) { pid = own; p = post(own); break; }
    }
    let newN = 0;
    for (const r of b) if (isNew(r)) newN++;
    let nc = 0;
    try { nc = Number(newCoins1hOf(id)) || 0; } catch { nc = 0; }
    cards.push({
      kind: "narrative", key: storyKey("narrative", id),
      narrative: { id: n.id, title: n.title, theme: n.theme, newCoins1h: nc },
      post: p ? { id: pid, handle: p.handle, text: p.text, at: postTime(pid, nowMs), url: postUrl(pid) } : null,
      family: null,
      buyers5m: t.buyers5m, coinsN: t.coinsN, newN, olderN: b.length - newN, coins,
    });
  }
  cards.sort((x, y) => y.buyers5m - x.buyers5m || y.coinsN - x.coinsN || byMint(x.key, y.key));
  const sent = foldCopies(loose).slice(0, LOOSE_MAX);
  const listed = cards.slice(0, CARDS_MAX), byTheme = new Map();
  for (const c of listed) if (c.kind === "narrative") byTheme.set(c.narrative.theme, (byTheme.get(c.narrative.theme) ?? 0) + 1);
  const themes = [...byTheme].map(([theme, n]) => ({ theme, cards: n })).sort((x, y) => y.cards - x.cards || byMint(x.theme, y.theme));
  return { cards: listed, loose: sent, dust, themes, hidden: { dust: dustN, cards: Math.max(0, cards.length - CARDS_MAX), loose: loose.length - totals(sent).coinsN } };
}
