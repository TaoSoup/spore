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
import { titleFitsName } from "./narrtags.mjs";

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
// - a family card: the parent's mint (base58);
// - a subject block: "t:<subject>" (subjects/table.json). It has no series of its own yet: parseStoryKey rejects it, and
//   the 5-minute close files a block's coins under their narrative, post or family as before.
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
 * theme }` wherever it is listed. `subjectOf(narrative)` (lib/subjects.mjs; null for none): `{ key, title, quiet }` or
 * null; the coins of two or more narratives of one story subject (not quiet) then make one card `{ kind: "narrative",
 * key: "t:...", narrative: { id (the leading angle's), title (the subject's), theme, newCoins1h (summed) }, subject:
 * { key, title, angles: [{ id, title, buyers5m, coinsN }] }, ... }` instead of their own cards (rule 2c).
 * `cards` may hold `{ kind: "narrative", key: "n:<id>", narrative: { id, title, theme,
 * newCoins1h }, post, family: null, buyers5m, coinsN, newN, olderN, coins }` (rule 2b; each coin row has `isNew`;
 * `newN` / `olderN` count every coin, copies included, an unknown creation time as older; `post`: the post of its
 * most-bought coin that links one that may be shown, else null; `newCoins1hOf(id)` gives `newCoins1h`); a post or
 * family card has `narrative`: the one all its coins share, else null. `themes`: `[{ theme, cards }]` of the
 * narrative cards listed, most cards first.
 */
export function groupStories({ rows = [], postIdOf = () => null, postOf = () => null, wakes = new Map(), nowMs = Date.now(), tagOf = null, newCoins1hOf = () => 0, subjectOf = null, keepAll = false, answeredOf = () => false } = {}) {
  const posts = new Map(); // post id → { handle, text } | null, asked once
  const post = (id) => {
    if (id == null) return null;
    if (posts.has(id)) return posts.get(id);
    let p = null;
    try { const v = postOf(id); p = v && typeof v.handle === "string" && v.handle && typeof v.text === "string" ? { handle: v.handle, text: v.text } : null; } catch { p = null; }
    posts.set(id, p);
    return p;
  };
  const dust = [], bins = new Map();
  let loose = [];
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
  // Rule 2c (with `subjectOf`): the coins of two or more narratives of one subject (a story row of subjects/table.json)
  // make one block, whatever each narrative's own count; a subject reached by one narrative only leaves it to rule 2b.
  const sbins = new Map(), subjOfN = new Map(); // subject key → { s, rows, nids }; narrative id → subject key (kept bins)
  if (subjectOf && tags.size) {
    const asked = new Map();
    for (const row of rows) {
      const t = tags.get(row.mint);
      if (!t || dustWhy(row)) continue;
      if (!asked.has(t.id)) { let s = null; try { s = subjectOf(t) ?? null; } catch { s = null; } asked.set(t.id, s && !s.quiet && typeof s.key === "string" && typeof s.title === "string" ? s : null); }
      const s = asked.get(t.id);
      if (!s) continue;
      let b = sbins.get(s.key);
      if (!b) sbins.set(s.key, b = { s, rows: [], nids: new Set() });
      b.rows.push(row); b.nids.add(t.id);
    }
    for (const [k, b] of sbins) if (b.nids.size < 2) sbins.delete(k); else for (const id of b.nids) subjOfN.set(id, k);
  }
  const nbins = new Map(); // narrative id → its rows, in rank order
  if (tags.size) {
    for (const row of rows) {
      const t = tags.get(row.mint);
      if (!t || dustWhy(row) || subjOfN.has(t.id)) continue;
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
    if (nbins.has(tags.get(row.mint)?.id) || subjOfN.has(tags.get(row.mint)?.id)) continue; // on its narrative's or subject's card
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
  // 2d. By name, with tagging: a loose coin the tagger has not read yet (a coin the trending gate just promoted, say; a
  // coin it answered "none" for stays loose) joins the one narrative or subject bin whose title names it
  // (lib/narrtags.mjs titleFitsName, the tagger's own test; a subject is matched by its title and its narratives'
  // titles). Two or more fits: it stays loose. Added before the cards are built, so its copies fold and the counts take
  // it like any coin. The row carries `byName: true` and the narrative it fits (a subject's: the narrative whose title
  // fits, else its first row's); its own tag decides once read.
  if (tagOf && loose.length && (nbins.size || sbins.size)) {
    const fits = (title, row) => { try { return typeof title === "string" && titleFitsName(title, { name: row.name, symbol: row.symbol }); } catch { return false; } };
    const targets = [];
    for (const [, b] of nbins) { const n = tags.get(b[0].mint); targets.push({ titles: [[n.title, n]], add: (r) => b.push(r) }); }
    for (const [, b] of sbins) {
      const own = new Map();
      for (const r of b.rows) { const t = tags.get(r.mint); if (t && !own.has(t.id)) own.set(t.id, t); }
      const first = tags.get(b.rows[0].mint);
      targets.push({ titles: [[b.s.title, first], ...[...own.values()].map((t) => [t.title, t])], add: (r) => b.rows.push(r) });
    }
    const keep = [];
    for (const row of loose) {
      let answered = true;
      try { answered = !!row.narrative || !!answeredOf(row); } catch { answered = true; }
      if (answered) { keep.push(row); continue; }
      const hits = [];
      for (const tg of targets) { const m = tg.titles.find(([title]) => fits(title, row)); if (m) hits.push([tg, m[1]]); }
      if (hits.length !== 1) { keep.push(row); continue; }
      const [tg, n] = hits[0];
      tg.add({ ...row, byName: true, narrative: { id: n.id, title: n.title, theme: n.theme } });
    }
    loose = keep;
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
  // The post shown: of the coins that link a post that may be shown, the one with the most 5-minute buyers (then the mint).
  const bestPost = (b) => {
    for (const r of [...b].sort((x, y) => (y.buyers5m ?? 0) - (x.buyers5m ?? 0) || byMint(x.mint, y.mint))) {
      const own = postIdOf(r) ?? null;
      if (own != null && post(own)) { const p = post(own); return { id: own, handle: p.handle, text: p.text, at: postTime(own, nowMs), url: postUrl(own) }; }
    }
    return null;
  };
  const newCoins = (id) => { try { return Number(newCoins1hOf(id)) || 0; } catch { return 0; } };
  for (const [id, b] of nbins) {
    const n = tags.get(b[0].mint);
    const coins = foldCopies(b.map((r) => ({ ...r, narrative: n, isNew: isNew(r) }))), t = totals(coins);
    let newN = 0;
    for (const r of b) if (isNew(r)) newN++;
    cards.push({
      kind: "narrative", key: storyKey("narrative", id),
      narrative: { id: n.id, title: n.title, theme: n.theme, newCoins1h: newCoins(id) },
      post: bestPost(b),
      family: null,
      buyers5m: t.buyers5m, coinsN: t.coinsN, newN, olderN: b.length - newN, coins,
    });
  }
  // A subject block: a narrative card keyed by the subject ("t:..."), titled by it, its narratives listed as `angles`
  // (most 5-minute buyers first); `narrative.id` / `theme` are the leading angle's, `newCoins1h` the angles' sum.
  for (const [key, b] of sbins) {
    const per = new Map(); // narrative id → { id, title, buyers5m, coinsN }
    const coins = foldCopies(b.rows.map((r) => ({ ...r, narrative: tags.get(r.mint) ?? r.narrative, isNew: isNew(r) }))), t = totals(coins);
    for (const c of coins) {
      const n = c.narrative, x = per.get(n.id) ?? { id: n.id, title: n.title, theme: n.theme, buyers5m: 0, coinsN: 0 };
      const one = totals([c]);
      x.buyers5m += one.buyers5m; x.coinsN += one.coinsN; per.set(n.id, x);
    }
    const angles = [...per.values()].sort((x, y) => y.buyers5m - x.buyers5m || y.coinsN - x.coinsN || x.id - y.id);
    let newN = 0;
    for (const r of b.rows) if (isNew(r)) newN++;
    cards.push({
      kind: "narrative", key,
      narrative: { id: angles[0].id, title: b.s.title, theme: angles[0].theme, newCoins1h: [...b.nids].reduce((s, id) => s + newCoins(id), 0) },
      subject: { key, title: b.s.title, angles: angles.map(({ id, title, buyers5m, coinsN }) => ({ id, title, buyers5m, coinsN })) },
      post: bestPost(b.rows),
      family: null,
      buyers5m: t.buyers5m, coinsN: t.coinsN, newN, olderN: b.rows.length - newN, coins,
    });
  }
  cards.sort((x, y) => y.buyers5m - x.buyers5m || y.coinsN - x.coinsN || byMint(x.key, y.key));
  const sent = foldCopies(loose).slice(0, LOOSE_MAX);
  const l = listCards(cards);
  return { cards: l.cards, ...(keepAll ? { all: cards } : {}), loose: sent, dust, themes: l.themes, hidden: { dust: dustN, cards: l.hidden, loose: loose.length - totals(sent).coinsN } };
}

/**
 * The cards a body lists from a ranked list: the first CARDS_MAX, the themes of those listed, and how many were left
 * out. The story gate (lib/story-gate.mjs, STORY_GATE=on) re-ranks the whole list and lists it again with this.
 */
export function listCards(ranked) {
  const listed = ranked.slice(0, CARDS_MAX), byTheme = new Map();
  for (const c of listed) if (c.kind === "narrative") byTheme.set(c.narrative.theme, (byTheme.get(c.narrative.theme) ?? 0) + 1);
  const themes = [...byTheme].map(([theme, n]) => ({ theme, cards: n })).sort((x, y) => y.cards - x.cards || byMint(x.theme, y.theme));
  return { cards: listed, themes, hidden: Math.max(0, ranked.length - CARDS_MAX) };
}
