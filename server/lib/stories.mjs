// Stories (GET /api/stories): the Discover coin rows grouped by what they have in common, so a reader sees who posted
// and how many coins and buyers gathered around it. Pure: rows and look-ups in, plain objects out; no index, no sqlite,
// no clock of its own. lib/coinrows.mjs picks the candidate rows (the trending rules) and hands them over in rank order.
//
// In order:
// 1. The bot-dust floor (dustWhy): dust rows leave the cards and the loose list and are returned apart with a reason.
// 2. Labels. Each coin left gets every story it belongs to, each a label keyed like the story (storyKey below):
//    - the X post it links, when that post's handle and text are stored and may be shown, whatever its parent;
//    - its family, when that family is waking up (live, not silent; `wakes`): the label of the family's chosen post when
//      that post may be shown (the family's coins are that post's story, as the 5-minute series files them), else the
//      family's own (the parent's mint); the family's parent coin itself carries that label too, when a coin of the
//      family is on the page (alone it would join nothing);
//    - with narrative tags (lib/narrtags.mjs: a language model's reading of the coins' public text, which can be wrong):
//      its narrative, when two or more coins on the page share it (copies folded count once); or, with `subjectOf`, its
//      subject ("t:..."), when its narrative is one of two or more narratives of one story subject (subjects/table.json,
//      not quiet) on the page. A coin carries at most one of the two.
//    - By name (2d): a coin of no label that the tagger has not read yet takes the label of the one narrative or subject
//      whose title names it (marked `byName`).
// 3. The chaining guard. Tags can be wrong, so one coin must not glue two stories together. For each narrative or
//    subject label L: the groups that all the OTHER labels make (as labelled, before any cut). A group that holds exactly
//    ONE coin of L (copies folded) is a lone bridge, and is cut there (that coin loses L and stays with its group), when
//    that group has two or more other coins AND what L would join it to (L's coins of no other label, plus the other
//    groups L touches, whole) is two or more coins: both sides are stories of their own. So a 2-coin narrative whose
//    coins sit in two big post stories joins neither, and a small post holding one coin of each of two big narratives
//    glues neither to it. A narrative or subject label with fewer than two coins left is dropped. Every label is read
//    against the same uncut labels, so the result does not depend on their order. (2d runs after it.)
// 4. Linking: coins that share any label are joined (union-find); each connected group with a label is one card, the
//    coins of no label are the loose list. The card's primary story (its kind, key and title fields) is chosen by a fixed
//    precedence: subject > narrative > post > family (KIND_RANK); among labels of one kind, the one carried by the most
//    coins (copies folded), then the most 5-minute buyers, then the key. A card of two or more stories lists them all in
//    `keys` (primary first) and `parts`; the 5-minute series files each coin under ONE key (coinStoryKey), so a card's
//    attention and chart sum its `keys` (lib/attention.mjs). A narrative is context for the reader: nothing here ranks
//    or rates it.
// 5. Inside a card and inside the loose list, coins with the same ticker and the same image fold into one row: the one
//    with the most liquidity leads and lists the others as `copies`. Nothing here says which one came first or which
//    one is "the" coin: the lead is only the deepest pool.
// The numbers state what was measured. A card's `buyers5m` is the sum of its coins' 5-minute buyers (a wallet that
// bought two of them counts twice), copies included; `coinsN` counts every coin of the card, copies included.
import { PAPER_RATIO, TINY_USD, byMint } from "./rowshared.mjs";
import { postTime, postUrl } from "./narrative.mjs";
import { titleFitsName } from "./narrtags.mjs";
import { wordCount } from "./post-lines.mjs";

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

/** The precedence of a card's primary story over the labels of its coins (lower first): see groupStories. */
export const KIND_RANK = Object.freeze({ subject: 0, narrative: 1, post: 2, family: 3 });

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
 * - A card made of two or more stories (the linking step, head of the file) also has `keys`: every member story's key,
 *   the primary's (`key`) first, then by the same precedence; and `parts: [{ kind: "subject" | "narrative" | "post" |
 *   "family", key, title, coinsN, buyers5m }]` in the same order (`title`: the narrative's or subject's title, the
 *   post's handle, the family's ticker; `coinsN` / `buyers5m`: the card's coins that carry that story, copies included).
 *   A card of one story has neither (its keys are [key]).
 *
 * `tagOf(row)`: the coin's narrative `{ id, title, theme }` or null; null (the default) for no tagging at all, and the
 * result is then exactly as described above plus `themes: []`. With it: a tagged row carries `narrative: { id, title,
 * theme }` wherever it is listed. `subjectOf(narrative)` (lib/subjects.mjs; null for none): `{ key, title, quiet }` or
 * null; the coins of two or more narratives of one story subject (not quiet) then carry the subject's label instead of
 * their narrative's, and a card led by it is `{ kind: "narrative", key: "t:...", narrative: { id (the leading angle's),
 * title (the subject's), theme, newCoins1h (summed) }, subject: { key, title, angles: [{ id, title, buyers5m, coinsN }]
 * }, ... }` (`angles`: over the card's coins that carry the subject).
 * `cards` may hold `{ kind: "narrative", key: "n:<id>", narrative: { id, title, theme, newCoins1h }, post, family,
 * buyers5m, coinsN, newN, olderN, coins }` (a card led by a narrative; each coin row has `isNew`; `newN` / `olderN`
 * count every coin, copies included, an unknown creation time as older; `post`: the post of its most-bought coin that
 * links one that may be shown and has words, else null; `family`: the waking family on the card, else null;
 * `newCoins1hOf(id)` gives `newCoins1h`); a post or family card has `narrative`: the one all its coins share, else
 * null. `themes`: `[{ theme, cards }]` of the narrative cards listed, most cards first.
 */
export function groupStories({ rows = [], postIdOf = () => null, postOf = () => null, wakes = new Map(), nowMs = Date.now(), tagOf = null, newCoins1hOf = () => 0, subjectOf = null, keepAll = false, answeredOf = () => false } = {}) {
  const posts = new Map(); // post id → { handle, text } | null, asked once
  const post = (id) => {
    if (id == null) return null;
    if (posts.has(id)) return posts.get(id);
    let p = null;
    try { const v = postOf(id); p = v && typeof v.handle === "string" && v.handle && typeof v.text === "string" ? { handle: v.handle, text: v.text, ...(v.quotes === true ? { quotes: true } : null) } : null; } catch { p = null; }
    posts.set(id, p);
    return p;
  };
  const dust = [];
  let dustN = 0;
  // Narrative tags, asked once per row; a tagged row is listed as a copy that carries its narrative.
  const tags = new Map(); // mint → { id, title, theme }
  if (tagOf) for (const row of rows) {
    let t = null;
    try { t = tagOf(row) ?? null; } catch { t = null; }
    if (t && Number.isInteger(t.id) && typeof t.title === "string" && typeof t.theme === "string") tags.set(row.mint, { id: t.id, title: t.title, theme: t.theme });
  }
  const tagged = (row) => { const t = tags.get(row.mint); return t ? { ...row, narrative: t } : row; };
  // 1. The dust floor; `live` are the other rows, in rank order.
  const live = [];
  for (const row of rows) {
    const why = dustWhy(row);
    if (why) { dustN++; if (dust.length < DUST_MAX) dust.push({ ...tagged(row), reason: why }); continue; }
    live.push(row);
  }
  // Which subjects hold two or more narratives (not quiet), and which narratives outside them hold two or more coins
  // (copies folded count once): only those are labels.
  const subj = new Map(), subjOfN = new Map(); // subject key → { s, nids }; narrative id → subject key (kept)
  if (subjectOf && tags.size) {
    const asked = new Map();
    for (const row of live) {
      const t = tags.get(row.mint);
      if (!t) continue;
      if (!asked.has(t.id)) { let s = null; try { s = subjectOf(t) ?? null; } catch { s = null; } asked.set(t.id, s && !s.quiet && typeof s.key === "string" && typeof s.title === "string" ? s : null); }
      const s = asked.get(t.id);
      if (!s) continue;
      let b = subj.get(s.key);
      if (!b) subj.set(s.key, b = { s, nids: new Set() });
      b.nids.add(t.id);
    }
    for (const [k, b] of subj) if (b.nids.size < 2) subj.delete(k); else for (const id of b.nids) subjOfN.set(id, k);
  }
  const nrows = new Map(); // narrative id → its rows
  for (const row of live) {
    const t = tags.get(row.mint);
    if (!t || subjOfN.has(t.id)) continue;
    let b = nrows.get(t.id);
    if (!b) nrows.set(t.id, b = []);
    b.push(row);
  }
  for (const [id, b] of nrows) if (foldCopies(b).length < 2) nrows.delete(id);
  // 2. The labels of each coin (by index in `live`). A label: { kind, key, id, idx: Set of indices, n (a narrative's
  // tag), s (a subject) }.
  const labels = new Map(), lab = live.map(() => new Set()), byName = new Map(); // index → the narrative it was placed by name under
  const label = (i, kind, id, extra) => {
    const key = kind === "subject" ? id : storyKey(kind, id);
    let L = labels.get(key);
    if (!L) labels.set(key, L = { kind, key, id, idx: new Set(), ...extra });
    L.idx.add(i); lab[i].add(key);
  };
  const unlabel = (L, i) => { L.idx.delete(i); lab[i].delete(L.key); };
  // A waking family's label: its chosen post's when that post may be shown (the family's coins are then that post's
  // story, as the 5-minute series files them: coinStoryKey), else the parent's mint. `famOf`: index → the waking family's
  // mint (the card's `family`).
  const famLabel = (i, w) => { famOf.set(i, w.mint); if (w.postId != null && post(w.postId)) label(i, "post", w.postId); else label(i, "family", w.mint); };
  const famOf = new Map(), kids = new Set(); // the waking families with a coin of theirs on the page
  live.forEach((row, i) => {
    const own = postIdOf(row) ?? null;
    if (own != null && post(own)) label(i, "post", own);
    const wake = row.parent?.mint ? wakes.get(row.parent.mint) ?? null : null;
    if (wake) { famLabel(i, wake); kids.add(wake.mint); }
    const t = tags.get(row.mint);
    if (t && subjOfN.has(t.id)) label(i, "subject", subjOfN.get(t.id), { s: subj.get(subjOfN.get(t.id)).s, nids: subj.get(subjOfN.get(t.id)).nids });
    else if (t && nrows.has(t.id)) label(i, "narrative", t.id, { n: t });
  });
  // The waking family's parent coin itself takes its family's label, when a coin of that family is on the page (alone it
  // would join nothing).
  live.forEach((row, i) => { const self = wakes.get(row.mint) ?? null; if (self && kids.has(self.mint) && !famOf.has(i)) famLabel(i, self); });
  const ck = live.map((r) => copyKey(r) ?? `\0${r.mint}`); // copies are one coin
  const distinct = (idx) => { const s = new Set(); for (const i of idx) s.add(ck[i]); return s.size; };
  // The chaining guard (head of the file): for each narrative or subject label, the groups the OTHER labels make (all of
  // them, as labelled, before any cut: the result does not depend on the order of the labels); a group that holds
  // exactly one of its coins (copies folded) is a lone bridge, cut when both sides are stories of their own.
  const cuts = [];
  for (const L of labels.values()) {
    if (L.kind !== "narrative" && L.kind !== "subject") continue;
    const uf0 = unionFind(live.length), inOther = new Set();
    for (const M of labels.values()) if (M !== L) { uf0.joinAll(M.idx); for (const i of M.idx) inOther.add(i); }
    const per = new Map(), free = []; // group root → L's indices in it; L's coins of no other label
    for (const i of L.idx) {
      if (!inOther.has(i)) { free.push(i); continue; }
      const r = uf0.find(i);
      let a = per.get(r);
      if (!a) per.set(r, a = []);
      a.push(i);
    }
    if (per.size + (free.length ? 1 : 0) < 2) continue; // L joins nothing that is joined already
    const members = new Map(); // group root (of the groups L touches) → all its indices
    live.forEach((_, i) => { if (!inOther.has(i)) return; const r = uf0.find(i); if (per.has(r)) { let m = members.get(r); if (!m) members.set(r, m = []); m.push(i); } });
    for (const [r, mine] of per) {
      if (distinct(mine) !== 1) continue;
      const own = members.get(r).filter((j) => !L.idx.has(j)), rest = [...free];
      for (const [r2, m] of members) if (r2 !== r) rest.push(...m);
      if (distinct(own) >= 2 && distinct(rest) >= 2) for (const i of mine) cuts.push([L, i]);
    }
  }
  for (const [L, i] of cuts) unlabel(L, i);
  for (const L of labels.values()) if ((L.kind === "narrative" || L.kind === "subject") && distinct(L.idx) < 2) for (const i of [...L.idx]) unlabel(L, i); // too few coins left to be a story
  for (const [k, L] of labels) if (!L.idx.size) labels.delete(k);
  // 2d. By name, with tagging: a coin of no label that the tagger has not read yet (a coin the trending gate just
  // promoted, say; a coin it answered "none" for stays loose) takes the label of the one narrative or subject whose title
  // names it (lib/narrtags.mjs titleFitsName, the tagger's own test; a subject is matched by its title and its
  // narratives' titles). Two or more fits: no label. The row carries `byName: true` and the narrative it fits (a
  // subject's: the narrative whose title fits, else its first coin's); its own tag decides once read.
  if (tagOf && labels.size) {
    const fits = (title, row) => { try { return typeof title === "string" && titleFitsName(title, { name: row.name, symbol: row.symbol }); } catch { return false; } };
    const targets = [];
    for (const L of labels.values()) {
      if (L.kind === "narrative") targets.push({ L, titles: [[L.n.title, L.n]] });
      else if (L.kind === "subject") {
        const own = new Map();
        for (const i of L.idx) { const t = tags.get(live[i].mint); if (t && !own.has(t.id)) own.set(t.id, t); }
        const first = tags.get(live[Math.min(...L.idx)].mint);
        targets.push({ L, titles: [[L.s.title, first], ...[...own.values()].map((t) => [t.title, t])] });
      }
    }
    live.forEach((row, i) => {
      if (lab[i].size || !targets.length) return;
      let answered = true;
      try { answered = tags.has(row.mint) || !!answeredOf(row); } catch { answered = true; }
      if (answered) return;
      const hits = [];
      for (const tg of targets) { const m = tg.titles.find(([title]) => fits(title, row)); if (m) hits.push([tg, m[1]]); }
      if (hits.length !== 1) return;
      const [tg, n] = hits[0];
      tg.L.idx.add(i); lab[i].add(tg.L.key);
      byName.set(i, { id: n.id, title: n.title, theme: n.theme });
    });
  }
  // 3. One card per connected component of coins that share a label.
  const uf = unionFind(live.length);
  for (const L of labels.values()) uf.joinAll(L.idx);
  const comps = new Map(); // root → indices, rank order
  let loose = [];
  live.forEach((row, i) => {
    if (!lab[i].size) { loose.push(tagged(row)); return; }
    const r = uf.find(i);
    let c = comps.get(r);
    if (!c) comps.set(r, c = []);
    c.push(i);
  });
  const nowS = Math.floor(nowMs / 1000);
  const isNew = (r) => typeof r.createdAt === "number" && r.createdAt > nowS - NEW_S;
  const rowOf = (i) => { const n = byName.get(i); return n ? { ...live[i], byName: true, narrative: n } : tagged(live[i]); };
  // The post shown on a narrative card: of the coins that link a post that may be shown AND has words of its own (links
  // and pictures aside) or quotes a post that has (postOf's `quotes`), the one with the most 5-minute buyers (then the
  // mint). A post that is only a link or a picture never leads a grouped card: it says nothing about the story, and the
  // card's counted line says more.
  const bestPost = (b) => {
    for (const r of [...b].sort((x, y) => (y.buyers5m ?? 0) - (x.buyers5m ?? 0) || byMint(x.mint, y.mint))) {
      const own = postIdOf(r) ?? null;
      const p = own != null ? post(own) : null;
      if (p && (wordCount(p.text) > 0 || p.quotes === true)) return { id: own, handle: p.handle, text: p.text, at: postTime(own, nowMs), url: postUrl(own) };
    }
    return null;
  };
  const newCoins = (id) => { try { return Number(newCoins1hOf(id)) || 0; } catch { return 0; } };
  const cards = [];
  for (const idx of comps.values()) {
    // the stories of the component, by the precedence: kind, then most coins (copies folded), most 5-minute buyers, key
    const keys = new Set();
    for (const i of idx) for (const k of lab[i]) keys.add(k);
    const parts = [...keys].map((k) => {
      const L = labels.get(k), carried = idx.filter((i) => L.idx.has(i));
      let buyers5m = 0;
      for (const i of carried) buyers5m += live[i].buyers5m ?? 0;
      return { L, carried, folded: distinct(carried), buyers5m, coinsN: carried.length };
    }).sort((x, y) => KIND_RANK[x.L.kind] - KIND_RANK[y.L.kind] || y.folded - x.folded || y.buyers5m - x.buyers5m || byMint(x.L.key, y.L.key));
    const P = parts[0].L;
    // the card's family: of the waking families of its coins, the one whose coins brought the most 5-minute buyers, then the mint
    const famB = new Map();
    for (const i of idx) if (famOf.has(i)) famB.set(famOf.get(i), (famB.get(famOf.get(i)) ?? 0) + (live[i].buyers5m ?? 0));
    const fam = [...famB].sort((x, y) => y[1] - x[1] || byMint(x[0], y[0]))[0]?.[0] ?? null, w = fam == null ? null : wakes.get(fam);
    const family = w ? { mint: w.mint, symbol: w.symbol ?? null, image: w.image ?? null, startedAt: w.startedAt ?? null } : null;
    const grouped = P.kind === "narrative" || P.kind === "subject";
    const out = idx.map((i) => (grouped ? { ...rowOf(i), isNew: isNew(live[i]) } : rowOf(i)));
    const coins = foldCopies(out), t = totals(coins);
    let card;
    if (grouped) {
      let newN = 0;
      for (const i of idx) if (isNew(live[i])) newN++;
      const common = { post: bestPost(out), family, buyers5m: t.buyers5m, coinsN: t.coinsN, newN, olderN: idx.length - newN, coins };
      if (P.kind === "narrative") card = { kind: "narrative", key: P.key, narrative: { id: P.n.id, title: P.n.title, theme: P.n.theme, newCoins1h: newCoins(P.n.id) }, ...common };
      else {
        // a subject: its narratives listed as `angles` (most 5-minute buyers first) over the coins that carry it;
        // `narrative.id` / `theme` are the leading angle's, `newCoins1h` the angles' sum
        const per = new Map(); // narrative id → { id, title, theme, buyers5m, coinsN }
        for (const c of foldCopies(parts[0].carried.map((i) => out[idx.indexOf(i)]))) {
          const n = c.narrative, x = per.get(n.id) ?? { id: n.id, title: n.title, theme: n.theme, buyers5m: 0, coinsN: 0 };
          const one = totals([c]);
          x.buyers5m += one.buyers5m; x.coinsN += one.coinsN; per.set(n.id, x);
        }
        const angles = [...per.values()].sort((x, y) => y.buyers5m - x.buyers5m || y.coinsN - x.coinsN || x.id - y.id);
        card = {
          kind: "narrative", key: P.key,
          narrative: { id: angles[0].id, title: P.s.title, theme: angles[0].theme, newCoins1h: [...P.nids].reduce((s, id) => s + newCoins(id), 0) },
          subject: { key: P.key, title: P.s.title, angles: angles.map(({ id, title, buyers5m, coinsN }) => ({ id, title, buyers5m, coinsN })) },
          ...common,
        };
      }
    } else {
      const p = P.kind === "post" ? post(P.id) : null;
      // With tagging: the narrative every coin of the card shares, else null. Without: no such field.
      const one = tagOf ? out.reduce((s, r) => (s === undefined ? r.narrative ?? null : s && r.narrative?.id === s.id ? s : null), undefined) ?? null : undefined;
      card = {
        kind: P.kind, key: P.key,
        post: p ? { id: P.id, handle: p.handle, text: p.text, at: postTime(P.id, nowMs), url: postUrl(P.id) } : null,
        family, buyers5m: t.buyers5m, coinsN: t.coinsN, coins,
        ...(one === undefined ? null : { narrative: one }),
      };
    }
    if (parts.length > 1) {
      card.keys = parts.map((x) => x.L.key);
      card.parts = parts.map((x) => ({ kind: x.L.kind, key: x.L.key, title: partTitle(x.L, post, wakes), coinsN: x.coinsN, buyers5m: x.buyers5m }));
    }
    cards.push(card);
  }
  cards.sort((x, y) => y.buyers5m - x.buyers5m || y.coinsN - x.coinsN || byMint(x.key, y.key));
  const sent = foldCopies(loose).slice(0, LOOSE_MAX);
  const l = listCards(cards);
  return { cards: l.cards, ...(keepAll ? { all: cards } : {}), loose: sent, dust, themes: l.themes, hidden: { dust: dustN, cards: l.hidden, loose: loose.length - totals(sent).coinsN } };
}

/** A part's title: the narrative's or subject's title, the post's handle, the family's ticker (null when unknown). */
function partTitle(L, post, wakes) {
  if (L.kind === "narrative") return L.n.title;
  if (L.kind === "subject") return L.s.title;
  if (L.kind === "post") return post(L.id)?.handle ?? null;
  return wakes.get(L.id)?.symbol ?? null;
}

/** Union-find over 0..n-1 (path halving, union by size). */
function unionFind(n) {
  const up = Array.from({ length: n }, (_, i) => i), size = new Array(n).fill(1);
  const find = (i) => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i]; } return i; };
  const join = (a, b) => { a = find(a); b = find(b); if (a === b) return; if (size[a] < size[b]) [a, b] = [b, a]; up[b] = a; size[a] += size[b]; };
  return { find, joinAll: (idx) => { let first = null; for (const i of idx) { if (first == null) first = i; else join(first, i); } } };
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
