// The social card behind GET /api/card/<mint>.png (owner 2026-10-23: "the cards showing the bubble
// map"): a server-rendered 1200×630 PNG of one coin's FAMILY drawn the way the live map draws it, so
// a pasted sporepad.com/c/<mint> or /map?focus=<mint> unfurls on X, Telegram and Discord as a crop
// of the map with the shared coin ringed, instead of the site's one static og.png. The picture is
// the family's bubbles (logos clipped to discs, tinted and ringed in the map's depth colours, sized
// by market cap), linked parent → child inside the family's soft hull on the dot-grid ground, with
// the top's title and the shared coin's label; a slim HUD on the left states the facts. Crawlers read
// only the server HTML and fetch og:image once, so everything the card says has to be ready in that
// one request: the facts come from the model in memory (cardData), the logos from the image cache's
// thumbnails on disk (the 64 px ones the map's logo sheets keep; never an upstream fetch on the
// request path: a cold logo of the shared coin or the top gets a short wait for the cache to make it,
// else a letter avatar and a sooner retry, and missing member logos are warmed in the background for
// the next card), the text from the Geist TTFs vendored in lib/fonts (lib/card-fonts.mjs), measured
// from the fonts' own advance tables so nothing ever overflows the card. The layout is pure
// arithmetic (no simulation): the same family draws the same picture, and a 1 500-coin family costs
// one walk and a 72-bubble packing. The svg is rasterized on the image worker thread (the same one
// /api/img thumbnails use), never on the loop: 100-300 ms of CPU per card would otherwise hold up
// SSE, the map and every other response, and the model knows thousands of mints, so a scan can
// always ask for a cold one. Rendered cards are kept per mint for a minute, so a post that fans out
// to many crawlers costs one render; at most CARD_MAX_INFLIGHT cards are being rasterized at once,
// and past that the route sends the site's generic card while the refused card is drawn in the
// background, so the next crawler finds it in the cache.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { familyShares } from "./dominance.mjs";
import { units } from "./pricing.mjs";
import { NATIVE_MINT } from "./sdk.mjs";
import { usd, count, pctOf, ageOf, shortMint, underIt } from "./format.mjs";
import { fonts, parseFont, FAMILY } from "./card-fonts.mjs";

export { fonts, parseFont };
const require = createRequire(import.meta.url);
export const CARD_W = 1200, CARD_H = 630;
/** A rendered card is served from memory this long; the LRU holds at most CARD_LRU_MAX mints. */
export const CARD_TTL_MS = 60_000;
export const CARD_LRU_MAX = 200;
/** A card drawn with a letter avatar for the shared coin or the top (logo not cached yet) is retried this soon, so the next crawler gets the logo. */
export const CARD_PLACEHOLDER_TTL_MS = 5_000;
/** The thumbnail the shared coin and the top embed when their bubble is big (ImageCache serves 64 / 128 / 256), and the one every member embeds. */
export const LOGO_PX = 256;
export const MEMBER_LOGO_PX = 64;
/** A bubble wider than this (radius, px) asks for the 256 px thumbnail; smaller ones read fine at 64. */
export const BIG_LOGO_R = 36;
/** How long a render waits for a cold logo of the shared coin or the top to land; member logos are never waited for. */
export const LOGO_WAIT_MS = 1_500;
/** Member logos missing from disk are warmed for the next card, at most this many per render, and a url at most once a minute. */
export const WARM_MAX = 24;
const WARM_AGAIN_MS = 60_000;
/**
 * How many cards may be rasterizing at once (the token wraps only the drawing: a render waiting for a
 * logo holds none, so eight slow logo waits never block a card whose logos are on disk). The worker
 * draws them one after another, so this bounds its queue to about a second. Past it renderCard
 * answers CARD_BUSY, the route sends the generic card, and the refused card is drawn in the
 * background (a backlog of at most CARD_BACKLOG_MAX mints), so the next fetch hits the LRU.
 */
export const CARD_MAX_INFLIGHT = 8;
export const CARD_BACKLOG_MAX = 32;
export const CARD_BUSY = Object.freeze({ busy: true });
/** At most this many bubbles on a card; the rest of the family is "+N more" in the top's title. */
export const BUBBLE_CAP = 72;
/** The shared coin's direct children drawn (largest first) before the rest of the family. */
export const FOCUS_KIDS = 20;
/** The svg handed to the rasterizer stays under this (base64 logos are most of it): logos are shed, smallest bubbles first, to keep it; never members. */
export const SVG_MAX_BYTES = 800 * 1024;
const SOL_MINT = NATIVE_MINT.toBase58();
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ---------------------------------------------------------------- facts
const createdOf = (c) => (typeof c?.createdAt === "number" && Number.isFinite(c.createdAt) ? c.createdAt : null);
/** `a` was created before `b`: by createdAt, an unknown createdAt after any known one, a tie by mint (web/src/lib/map/firstborn.ts). */
export function earlier(a, b) {
  const ca = createdOf(a), cb = createdOf(b);
  if (ca != null && cb != null && ca !== cb) return ca < cb;
  if ((ca == null) !== (cb == null)) return ca != null;
  return a.mint < b.mint;
}
/**
 * Is `c` the first child among `siblings` (its parent's children, `c` included): the earliest created;
 * an undated earliest counts only when it is the only child (two undated children: no guess).
 */
export function isFirstborn(c, siblings) {
  let best = null, count = 0;
  for (const s of siblings ?? []) { if (!s) continue; count++; if (!best || earlier(s, best)) best = s; }
  return !!best && best.mint === c.mint && (createdOf(best) != null || count === 1);
}

const nowMs = (now) => (typeof now === "function" ? now() : typeof now === "number" && Number.isFinite(now) ? now : Date.now());
const refOf = (model, c) => ({ mint: c.mint, ...model.nameOf(c.mint) });
/** A listed quote asset (USDC, PUMP, a graduated coin) as a ref: the model's quote vocabulary names it. */
const assetRefOf = (model, mint) => ({ mint, name: model.nameOf(mint).name, symbol: model.quoteSymbol({ quoteMint: mint }) });

// The map's dominance table ("mcap", the site's default) for the forest build the model has cached:
// one familyShares pass per map build, shared by every card rendered from it.
const shareTables = new WeakMap(); // mapAll cache entry → Map<top mint, row>
function familyRow(model, top) {
  const built = model.mapAll({ all: true });
  let byMint = shareTables.get(built);
  if (!byMint) {
    byMint = new Map(familyShares(built.body.roots, "mcap").families.map((f) => [f.mint, f]));
    shareTables.set(built, byMint);
  }
  return byMint.get(top) ?? null;
}

/**
 * Everything the card (and the og tags) say about a coin; null for a mint the model does not know.
 * An untracked coin (a foreign pump.fun coin looked up for its page, nobody spawned under it yet) is
 * a plain root with no family below it, so its link unfurls too and invites the first spawn. `root`
 * is the family's top (the depth-0 coin, or the listed asset a depth-0 coin is quoted in), null when
 * the coin is the top itself; `chain` is the refs from the top down to the coin and `lineage` their
 * tickers; `family.under` is how many coins the family has below its top (the top itself, coin or
 * asset, not counted: the number the og:description and the web's share text call "coins under
 * it"); `family.sharePct` is the family's share of the whole map in the site's "mcap" mode;
 * `bubbles` is the picture: the family members picked for it (pickBubbles) and how many are not;
 * `imagePending` says the coin has no image yet while its metadata is still being fetched.
 */
export function cardData(model, mint) {
  try { return buildData(model, mint); } catch { return null; }
}
/**
 * Coins below the family top. A coin top: the model's live descendant count (the og:description of
 * its own card says the same number); an asset top (not a coin, so nothing is computed for it): the
 * forest's family row less the asset node; a top the index has not reached (a ghost parent): what
 * is known under it.
 */
function coinsUnder(model, top, { asset, row, members }) {
  const d = asset ? null : model.computed().get(top.mint)?.descendants;
  if (d != null) return d;
  if (row) return Math.max(0, row.coins - 1);
  return members.reduce((n, m) => n + 1 + (model.computed().get(m.mint)?.descendants ?? 0), 0);
}
function buildData(model, mint) {
  const c = typeof mint === "string" ? model.get(mint) : null;
  if (!c) return null;
  const d = model.computed().get(mint) ?? {};
  const { name, symbol } = model.nameOf(mint);
  const supply = units(c.tokenTotalSupply ?? 0, model.decimalsOf(mint));
  const mcapUsd = d.priceUsd != null && Number.isFinite(d.priceUsd) ? d.priceUsd * supply : null;
  const s = model.scopedAll(c);
  const anc = model.ancestors(mint);                      // nearest first
  const top0 = anc.length ? anc[anc.length - 1] : c;      // the highest coin the model knows in this chain
  const fam = model.assetFamilies();
  const assetMint = top0.depth === 0 && top0.quoteMint && top0.quoteMint !== SOL_MINT && fam.has(top0.quoteMint) ? top0.quoteMint : null;
  // a spawn whose parent is not indexed (yet) still names it, by mint: it is not a root
  const parentMint = c.depth > 0 && typeof c.quoteMint === "string" ? c.quoteMint : null;
  const parent = anc[0] ? refOf(model, anc[0]) : parentMint ? { mint: parentMint, ...model.nameOf(parentMint) } : null;
  // `top` is the family's highest known coin (what the family line names); it is the `root` only when the chain reaches it
  const known = !!assetMint || anc.length > 0;
  const top = assetMint ? assetRefOf(model, assetMint) : anc.length || !parentMint ? refOf(model, top0) : parent;
  const above = assetMint ? [top] : !anc.length && parentMint ? [parent] : [];
  const chain = above.concat([...anc].reverse().concat([c]).map((x) => refOf(model, x))); // top … parent, self
  const lineage = chain.map(tick);
  const siblings = parentMint ? model.childrenOf(parentMint) : assetMint ? fam.get(assetMint) : [];
  const row = familyRow(model, top.mint);
  const under = coinsUnder(model, top, { asset: !!assetMint, row, members: assetMint ? fam.get(assetMint) ?? [] : parentMint ? model.childrenOf(top.mint) : [] });
  const o = model.oursOf(c);
  const family = familyNodes(model, { top, asset: !!assetMint, focus: c, chain: anc });
  const { nodes, omitted } = pickBubbles(family.nodes, mint, BUBBLE_CAP);
  const image = model.imageOfMint(mint);
  return {
    mint, name: name ?? null, symbol: symbol ?? null, image, imagePending: imagePendingOf(model, mint, image),
    depth: c.depth, ours: !!(o.ours || o.oursPending), migrated: !!c.migrated, complete: !!c.complete, createdAt: c.createdAt ?? null,
    mcapUsd, lockedUsd: s.lockedUsd ?? null, children: s.children ?? 0, descendants: s.descendants ?? 0,
    parent, root: known ? top : null, chain, lineage, firstborn: isFirstborn(c, siblings),
    family: { top: { mint: top.mint, symbol: top.symbol ?? null }, under, sharePct: row && row.share > 0 ? row.share * 100 : null },
    bubbles: { nodes, omitted, total: family.nodes.length, valueUsd: family.valueUsd },
  };
}

// ---------------------------------------------------------------- the family as nodes
/** The market cap a bubble is sized by: the model's liquidity cap when it has one (a 1e9-supply coin on a dollar of liquidity is not a billion-dollar bubble), else the market cap (web/src/lib/map/sizing.ts coinMcap). */
function drawnMcap(model, c, d) {
  const supply = units(c.tokenTotalSupply ?? 0, model.decimalsOf(c.mint));
  const mcapUsd = d?.priceUsd != null && Number.isFinite(d.priceUsd) ? d.priceUsd * supply : null;
  const cap = typeof model.mcapCapOf === "function" ? model.mcapCapOf(c, mcapUsd) : null;
  return cap != null && cap > 0 ? cap : mcapUsd;
}
/**
 * The coin has no image yet but its metadata is still being fetched (a uri with no metadata row,
 * fetched or failed), so one may land any moment: such a card is kept briefly (renderCard), not a
 * minute. A metadata row without an image, or a failed fetch, is not pending: nothing will come.
 */
const imagePendingOf = (model, mint, image) => !image && !!model.mint?.(mint)?.uri && !model.metaFor?.({ mint });
/** One family member as the picture sees it. */
function nodeOf(model, c, parentMint) {
  const { name, symbol } = model.nameOf(c.mint), o = model.oursOf(c), image = model.imageOfMint(c.mint);
  return { mint: c.mint, parentMint, depth: c.depth, symbol: symbol ?? null, name: name ?? null, image, imagePending: imagePendingOf(model, c.mint, image), mcapUsd: drawnMcap(model, c, model.computed().get(c.mint)), migrated: !!c.migrated, ours: !!(o.ours || o.oursPending), asset: false };
}
/**
 * Every member of the focused coin's family, flat, each with its `parentMint` (null for the top): the
 * top first, then a walk down `childrenOf`. An asset top (PUMP, USDC, a stock) is a node of its own,
 * `asset: true`, never priced, its icon from the model. A top the index does not know (a ghost parent)
 * leaves the coin's known chain as the family. `valueUsd` is the family's market cap in all.
 */
function familyNodes(model, { top, asset, focus, chain }) {
  const nodes = [];
  let valueUsd = 0;
  const push = (n) => { nodes.push(n); if (n.mcapUsd > 0) valueUsd += n.mcapUsd; };
  const walk = (c, parentMint) => {
    const stack = [[c, parentMint]];
    while (stack.length) {
      const [x, p] = stack.pop();
      push(nodeOf(model, x, p));
      const kids = model.childrenOf(x.mint);
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], x.mint]);
    }
  };
  if (asset) {
    const { name, symbol } = model.nameOf(top.mint);
    push({ mint: top.mint, parentMint: null, depth: 0, symbol: top.symbol ?? symbol ?? null, name: name ?? null, image: model.imageOfMint(top.mint), imagePending: false, mcapUsd: null, migrated: false, ours: false, asset: true });
    for (const m of model.assetFamilies().get(top.mint) ?? []) walk(m, top.mint);
    return { nodes, valueUsd };
  }
  const topCoin = model.get(top.mint);
  if (topCoin) { walk(topCoin, null); return { nodes, valueUsd }; }
  // a ghost top: the chain below it, nearest ancestor first → the focused coin, parents by mint
  const known = [...chain].reverse();
  known.forEach((a, i) => push(nodeOf(model, a, i === 0 ? null : known[i - 1].mint)));
  push(nodeOf(model, focus, known.length ? known[known.length - 1].mint : null));
  return { nodes, valueUsd };
}

const byMcapDesc = (a, b) => (b.mcapUsd ?? -1) - (a.mcapUsd ?? -1) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
/** `mint`'s ancestors in `byMint` (parentMint links), nearest first, at most 32 hops. */
function ancestorsIn(byMint, mint) {
  const out = [];
  let cur = byMint.get(mint);
  while (cur?.parentMint && out.length < 32) { const p = byMint.get(cur.parentMint); if (!p || p === cur) break; out.push(p); cur = p; }
  return out;
}
/**
 * Which members of a family (familyNodes, flat) a card draws, at most `cap`, deterministically: the
 * focused coin, its ancestor chain up to the top, its direct children (largest market cap first, up
 * to FOCUS_KIDS), then the rest of the family largest first (each with whatever ancestors it needs
 * so every bubble hangs from a drawn parent). Returns the drawn nodes (top first, `focus` and `top`
 * flagged) and `omitted`, how many family members are not drawn.
 */
export function pickBubbles(family, focusMint, cap = BUBBLE_CAP) {
  const byMint = new Map(family.map((n) => [n.mint, n]));
  const focus = byMint.get(focusMint);
  if (!focus) return { nodes: [], omitted: family.length };
  const picked = new Map();
  const add = (n) => { if (!picked.has(n.mint)) picked.set(n.mint, n); };
  const chain = ancestorsIn(byMint, focusMint).reverse(); // top … parent
  for (const a of chain) add(a);
  add(focus);
  const kids = family.filter((n) => n.parentMint === focusMint && n.mint !== focusMint).sort(byMcapDesc);
  for (const k of kids.slice(0, FOCUS_KIDS)) { if (picked.size >= cap) break; add(k); }
  for (const n of [...family].sort(byMcapDesc)) {
    if (picked.size >= cap) break;
    if (picked.has(n.mint)) continue;
    const need = ancestorsIn(byMint, n.mint).filter((a) => !picked.has(a.mint)).reverse();
    if (picked.size + need.length + 1 > cap) continue;
    for (const a of need) add(a);
    add(n);
  }
  const topMint = chain.length ? chain[0].mint : focusMint;
  const nodes = [...picked.values()].map((n) => ({ ...n, focus: n.mint === focusMint, top: n.mint === topMint }));
  // the top first, then the rest as picked (chain, focus, its children, the family largest first)
  nodes.sort((a, b) => (b.top ? 1 : 0) - (a.top ? 1 : 0));
  return { nodes, omitted: Math.max(0, family.length - nodes.length) };
}

// ---------------------------------------------------------------- the picture's geometry (pure)
/** The picture area on the card: the right part, the HUD text never reaches it. */
export const PIC = Object.freeze({ x0: 464, y0: 36, x1: 1168, y1: 594 });
/** Bubble radii (px): members between R_FLOOR and R_CAP by their market cap, the top at least R_TOP_MIN, the shared coin at least R_FOCUS_MIN, nothing drawn under R_SMALLEST. */
export const R_FLOOR = 11, R_CAP = 58, R_TOP_MIN = 44, R_TOP_MAX = 96, R_FOCUS_MIN = 40, R_CHAIN_MIN = 22, R_SMALLEST = 7, R_LONE = 84;
/**
 * The shared coin as drawn (after the fit) is at least R_FOCUS_DRAWN_MIN so its logo reads: its floor
 * is raised up to R_FOCUS_BOOST_MAX against the fit's scale, and members are dropped past that. Of its
 * children, the largest FOCUS_KIDS_KEEP are sized at least R_KID_MIN (a child with no market cap is
 * not a speck beside its parent) and kept unless they would still be drawn under R_KID_SMALLEST (a ring
 * of specks beside the coin reads as noise, not as its children); the rest are members like any other.
 */
export const R_FOCUS_DRAWN_MIN = 30, R_FOCUS_BOOST_MAX = 56, R_KID_MIN = 16, R_KID_SMALLEST = 9, FOCUS_KIDS_KEEP = 8;
/** The shared coin's FOCUS_KIDS_KEEP largest children among `nodes`, as a Set of mints. */
const keptKidsOf = (nodes, focusMint) => new Set(nodes.filter((n) => n.parentMint === focusMint && n.mint !== focusMint).sort(byMcapDesc).slice(0, FOCUS_KIDS_KEEP).map((n) => n.mint));
/** A card with fewer bubbles than SMALL_FAMILY draws them up to SMALL_GROW× bigger (√(SMALL_FAMILY / n)): a family of three is not three specks in an empty picture. */
export const SMALL_FAMILY = 24, SMALL_GROW = 2;
/** The height reserved above the cluster for the top's title (px). */
const TITLE_ROOM = 44;
/**
 * A coin's radius by its own market cap, the map's rule (web/src/lib/map/sizing.ts mcapRadius, map3
 * layout.js rad()) in world units: 0.55 with no market cap; under $2K 0.55 → 1 on a log scale from
 * $300; from $2K 1 + 1.54 · log10(m / 2000), capped at 7. A card bubble is R_FLOOR × this / 0.55,
 * clamped to R_CAP, so a card's bubbles stand to each other as the map's do.
 */
export const mcapRadius = (m) => { const v = m ?? NaN; return !(v > 0) ? 0.55 : v < 2000 ? 0.55 + 0.45 * clamp01(Math.log(v / 300) / Math.log(2000 / 300)) : Math.min(7, 1 + 1.54 * Math.log10(v / 2000)); };
/** Clear space between any two bubbles (px) and between a child and its parent. */
export const GAP = 5, PARENT_GAP = 7;
/** The shared coin's label is tried in LABEL_DIRS directions on LABEL_RINGS rings LABEL_RING_STEP px apart out from its ring. */
const LABEL_DIRS = 16, LABEL_RINGS = 3, LABEL_RING_STEP = 20;
/** The margin the cluster keeps from the picture's edge: the hull's padding plus the focus halo. */
const PIC_MARGIN = 30;
const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
/**
 * Radius per drawn node (Map mint → px). A member grows with its market cap from R_FLOOR (none) to
 * R_CAP by the map's own rule (mcapRadius); the shared coin is at least `focusMin` (R_FOCUS_MIN; layoutFamily
 * raises it against its scale) so its logo reads, its ancestors at least R_CHAIN_MIN, its FOCUS_KIDS_KEEP
 * largest children at least R_KID_MIN;
 * the top is at least 1.3× its largest member and R_TOP_MIN, and grows with the family's member count
 * and market cap up to R_TOP_MAX. A small family (under SMALL_FAMILY bubbles) is drawn up to
 * SMALL_GROW× bigger, every radius alike. A lone coin is one R_LONE disc.
 */
export function sizeBubbles(nodes, { total = nodes.length, valueUsd = 0, focusMin = R_FOCUS_MIN } = {}) {
  const r = new Map();
  if (nodes.length === 1) { r.set(nodes[0].mint, R_LONE); return r; }
  const k = nodes.length < SMALL_FAMILY ? Math.min(SMALL_GROW, Math.sqrt(SMALL_FAMILY / nodes.length)) : 1;
  const members = nodes.filter((n) => !n.top);
  const focus = nodes.find((n) => n.focus), chain = new Set(focus ? ancestorsIn(new Map(nodes.map((n) => [n.mint, n])), focus.mint).map((a) => a.mint) : []);
  const kids = focus ? keptKidsOf(nodes, focus.mint) : new Set();
  let maxMember = 0;
  for (const n of members) {
    let v = Math.min(R_CAP, (R_FLOOR * mcapRadius(n.mcapUsd)) / 0.55) * k;
    if (n.focus) v = Math.max(v, focusMin * k);
    else if (chain.has(n.mint)) v = Math.max(v, R_CHAIN_MIN * k); // a parent on the way to the shared coin stays readable
    else if (kids.has(n.mint)) v = Math.max(v, R_KID_MIN * k); // and so do its largest children
    r.set(n.mint, v);
    if (v > maxMember) maxMember = v;
  }
  const top = nodes.find((n) => n.top);
  if (top) {
    const grown = (30 + 12 * Math.log10(Math.max(1, total) + 1) + 16 * Math.sqrt(clamp01((valueUsd ?? 0) / 2e6))) * k;
    r.set(top.mint, Math.min(R_TOP_MAX * k, Math.max(R_TOP_MIN * k, top.focus ? focusMin * k : 0, 1.3 * maxMember, grown)));
  }
  return r;
}
/** `mint` and every node whose parent chain reaches it (nearest set), as a Set of mints. */
function branchOf(nodes, mint) {
  const out = new Set([mint]);
  let grew = true;
  while (grew) { grew = false; for (const n of nodes) if (!out.has(n.mint) && n.parentMint && out.has(n.parentMint)) { out.add(n.mint); grew = true; } }
  return out;
}
/**
 * Positions (Map mint → { x, y }) for the drawn nodes with radii `r`: the top at the origin, every
 * other node on a ring around its parent at the first spot (rings outward, angles alternating around
 * a start angle that points away from the grandparent) where it overlaps nothing placed yet (`gap`
 * between rims, GAP by default; layoutFamily widens it so the gap survives its down-scaling). The shared coin's branch is placed first, so it sits nearest the top: the chain
 * from the top down to the shared coin, then its children, then every other parent's children,
 * largest first, parents in breadth-first order. No simulation: the same input places the same way.
 */
export function packFamily(nodes, r, focusMint, gap = GAP) {
  const pos = new Map(), placed = [];
  const byMint = new Map(nodes.map((n) => [n.mint, n]));
  const top = nodes.find((n) => n.top) ?? nodes[0];
  if (!top) return pos;
  const put = (n, x, y) => { pos.set(n.mint, { x, y }); placed.push({ x, y, r: r.get(n.mint) ?? R_FLOOR }); };
  put(top, 0, 0);
  const free = (x, y, rr) => { for (const p of placed) { const dx = p.x - x, dy = p.y - y, m = p.r + rr + gap; if (dx * dx + dy * dy < m * m) return false; } return true; };
  const place = (child, parent) => {
    if (pos.has(child.mint)) return;
    const pp = pos.get(parent.mint), rp = r.get(parent.mint) ?? R_FLOOR, rc = r.get(child.mint) ?? R_FLOOR;
    const gp = parent.parentMint ? pos.get(parent.parentMint) : null;
    const theta0 = gp ? Math.atan2(pp.y - gp.y, pp.x - gp.x) : 0;
    for (let rho = rp + rc + gap + (PARENT_GAP - GAP), guard = 0; guard < 400; rho += Math.max(4, rc * 0.6), guard++) {
      const n = Math.max(6, Math.ceil((2 * Math.PI * rho) / (2 * rc + gap)));
      for (let i = 0; i < n; i++) {
        const k = i % 2 ? (i + 1) >> 1 : -(i >> 1);
        const a = theta0 + (k * 2 * Math.PI) / n, x = pp.x + Math.cos(a) * rho, y = pp.y + Math.sin(a) * rho;
        if (free(x, y, rc)) { put(child, x, y); return; }
      }
    }
    put(child, pp.x + rp + rc + 2000, pp.y); // unreachable in practice: 400 rings out there is always room
  };
  const childrenOf = (mint) => nodes.filter((n) => n.parentMint === mint && n.mint !== mint).sort(byMcapDesc);
  // the shared coin's branch first: its chain down from the top, then its children
  const chain = ancestorsIn(byMint, focusMint).reverse(); // top … parent
  const branch = chain.concat(byMint.has(focusMint) ? [byMint.get(focusMint)] : []);
  for (let i = 1; i < branch.length; i++) place(branch[i], branch[i - 1]);
  const focus = byMint.get(focusMint);
  if (focus && pos.has(focus.mint)) for (const k of childrenOf(focus.mint)) place(k, focus);
  // then everything else, parents breadth-first from the top
  const queue = [top];
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (const k of childrenOf(p.mint)) { place(k, p); queue.push(k); }
  }
  for (const n of nodes) if (!pos.has(n.mint)) put(n, 0, 0); // a node whose parent is not drawn (never, after pickBubbles)
  return pos;
}
/**
 * The cluster (positions `pos`, radii `r`, each node's clear margin `pad(n)`) moved into `area`
 * ({ x0, y0, x1, y1 }) and scaled down, uniformly, only when its bounding box is wider or taller
 * than the area (never enlarged): returns `{ s, dx, dy }` with screen = world · s + d.
 */
export function fitCluster(nodes, pos, r, area, pad = () => 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const p = pos.get(n.mint), e = (r.get(n.mint) ?? R_FLOOR) + pad(n);
    if (!p) continue;
    if (p.x - e < x0) x0 = p.x - e; if (p.x + e > x1) x1 = p.x + e; if (p.y - e < y0) y0 = p.y - e; if (p.y + e > y1) y1 = p.y + e;
  }
  if (!Number.isFinite(x0)) return { s: 1, dx: (area.x0 + area.x1) / 2, dy: (area.y0 + area.y1) / 2 };
  const aw = area.x1 - area.x0, ah = area.y1 - area.y0, bw = x1 - x0, bh = y1 - y0;
  const s = Math.min(1, bw > 0 ? aw / bw : 1, bh > 0 ? ah / bh : 1);
  return { s, dx: (area.x0 + area.x1) / 2 - ((x0 + x1) / 2) * s, dy: (area.y0 + area.y1) / 2 - ((y0 + y1) / 2) * s };
}
/**
 * The drawn circles for `nodes` (pickBubbles' output): sized (sizeBubbles), packed (packFamily) and
 * fitted (fitCluster) into the picture area less PIC_MARGIN. The shared coin's floor is raised against
 * the fit's scale (up to R_FOCUS_BOOST_MAX) so it is drawn at R_FOCUS_DRAWN_MIN or more. When the fit
 * would still draw it smaller, or a bubble under R_SMALLEST (a kept child of the shared coin under
 * R_KID_SMALLEST), the smallest droppable members (with their drawn descendants) are dropped and the
 * rest laid out again: never the shared coin or its chain to the top, and its FOCUS_KIDS_KEEP largest
 * children only when they are the too-small ones. The logos (`logoBytes`: mint → bytes on the svg;
 * `logoIds`: mint → the logo's identity, mints sharing one embed it once so its bytes count once)
 * never cost a member: past `maxBytes` they are shed (`noLogo`, letter avatars) smallest bubbles
 * first, the shared coin's and the top's never. The packing gap is widened so that GAP px survive the
 * down-scaling. Returns `{ circles: [{ ...node, x, y, r }], scale, dropped, noLogo }`.
 */
export function layoutFamily(nodes, focusMint, { total, valueUsd, area = PIC, logoBytes = null, logoIds = null, maxBytes = SVG_MAX_BYTES } = {}) {
  const inner = { x0: area.x0 + PIC_MARGIN, y0: area.y0 + PIC_MARGIN + (nodes.length > 1 ? TITLE_ROOM : 0), x1: area.x1 - PIC_MARGIN, y1: area.y1 - PIC_MARGIN };
  const byMint = new Map(nodes.map((n) => [n.mint, n]));
  const hard = new Set([focusMint, ...ancestorsIn(byMint, focusMint).map((a) => a.mint)]); // never dropped
  const kept = keptKidsOf(nodes, focusMint);
  const noLogo = new Set();
  const place = (set, gap, focusMin) => {
    const r = sizeBubbles(set, { total, valueUsd, focusMin }), pos = packFamily(set, r, focusMint, gap);
    const { s, dx, dy } = fitCluster(set, pos, r, inner, (n) => (n.focus ? 12 : n.top ? 8 : 0));
    return { s, circles: set.map((n) => { const p = pos.get(n.mint); return { ...n, x: p.x * s + dx, y: p.y * s + dy, r: (r.get(n.mint) ?? R_FLOOR) * s }; }) };
  };
  const b64 = (c) => Math.ceil((logoBytes?.get(c.mint) ?? 0) / 3) * 4;
  const floorAt = (s) => Math.max(R_FOCUS_MIN, Math.min(R_FOCUS_BOOST_MAX, R_FOCUS_DRAWN_MIN / s));
  const small = (c) => c.r < (kept.has(c.mint) ? R_KID_SMALLEST : R_SMALLEST) - 1e-6;
  let set = nodes, dropped = 0, scale = 1, out = null;
  for (let round = 0; round < 32; round++) {
    out = place(set, GAP / Math.max(0.2, scale), floorAt(scale));
    if (Math.abs(out.s - scale) > 0.05) { scale = out.s; out = place(set, GAP / Math.max(0.2, scale), floorAt(scale)); } // the gap and the floor are set for this scale
    scale = out.s;
    const { circles } = out;
    const focus = circles.find((c) => c.focus);
    const tiny = circles.some(small), dim = !!focus && focus.r < R_FOCUS_DRAWN_MIN - 1e-6;
    if (!tiny && !dim) break; // the byte budget alone never moves a bubble: logos go instead (below)
    const droppable = circles.filter((c) => !hard.has(c.mint) && (!kept.has(c.mint) || small(c))).sort((a, b) => a.r - b.r);
    if (!droppable.length) break;
    // too small: the small ones go, other members before the shared coin's kept children (the cluster shrinks and they may
    // grow past the line); a tiny node that cannot go, or a dim shared coin: the smallest eighth of the rest, so the scale grows
    const tooSmall = droppable.filter(small), tooSmallOther = tooSmall.filter((c) => !kept.has(c.mint));
    const pick = tiny && tooSmallOther.length ? tooSmallOther : tiny && tooSmall.length ? tooSmall : droppable.slice(0, Math.max(1, droppable.length >> 3));
    const gone = new Set();
    for (const c of pick) for (const m of branchOf(set, c.mint)) if (!hard.has(m)) gone.add(m);
    set = set.filter((n) => !gone.has(n.mint)); dropped += gone.size;
  }
  // over the byte budget: logos are shed (letter avatars; the layout does not move), the smallest bubbles' first (a 64 px logo in
  // a 10 px disc is a smear anyway), never the shared coin's or the top's (the picture is about them; should those two alone not
  // fit, nothing else can give). A logo shared by several bubbles costs its bytes once and is freed only when its last bubble sheds it.
  const bytesOf = (circles) => { const seen = new Set(); let n = 0; for (const c of circles) { const b = noLogo.has(c.mint) ? 0 : b64(c), id = logoIds?.get(c.mint) ?? c.mint; if (b && !seen.has(id)) { seen.add(id); n += b; } } return n; };
  for (const c of out.circles.filter((c) => !c.focus && !c.top && b64(c) > 0).sort((a, b) => a.r - b.r)) { if (bytesOf(out.circles) <= maxBytes) break; noLogo.add(c.mint); }
  return { circles: out.circles, scale: out.s, dropped, noLogo };
}
/** The convex hull of points [{ x, y }] (Andrew's monotone chain), counter-clockwise; fewer than 3 points come back as given. */
export function convexHull(points) {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
/**
 * The hull's padding (px): the rims are padded by HULL_PAD_IN before the hull is taken, its corners
 * are cut back by at most HULL_CUT (smoothHull), and the path is stroked HULL_PAD_OUT wide with round
 * joins. A corner cut of HULL_CUT on both edges moves the path under HULL_CUT inward (HULL_CUT / √2
 * at a right angle), so every bubble keeps HULL_PAD_IN + HULL_PAD_OUT − HULL_CUT ≥ 8 px of blob around
 * it, and the blob reaches at most HULL_PAD_IN + HULL_PAD_OUT + 1 px beyond a rim, within PIC_MARGIN.
 */
export const HULL_PAD_IN = 16, HULL_PAD_OUT = 12, HULL_CUT = 20;
/**
 * A closed polygon with its corners rounded: `passes` rounds of corner cutting (Chaikin's scheme),
 * each replacing every vertex by two points along its edges, a quarter of the edge or `cut` px from
 * the vertex, whichever is nearer. The result lies inside the polygon, within `cut` of it; fewer
 * than 3 points come back as given.
 */
export function smoothHull(points, { passes = 2, cut = HULL_CUT } = {}) {
  let p = points;
  for (let k = 0; k < passes && p.length >= 3; k++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], len = Math.hypot(b.x - a.x, b.y - a.y);
      const t = len > 0 ? Math.min(0.25, cut / len) : 0.25;
      q.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, { x: b.x + (a.x - b.x) * t, y: b.y + (a.y - b.y) * t });
    }
    p = q;
  }
  return p;
}
/** Points along a closed polygon's rim every `step` px or less (its vertices included), in path order. */
export function rimPoints(poly, step = 16) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

// ---------------------------------------------------------------- text: cleaning, coverage, measuring, fitting
/** Attribute- and text-safe XML. Every string drawn on the card goes through here. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
/** One line of plain text: NFC, tabs and newlines as spaces, no control or format characters, single spaces. */
// eslint-disable-next-line no-control-regex -- control and format characters are what this strips
const clean = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, "").replace(/\s+/g, " ").trim();
const face = (font, weight) => fonts().metrics[`${font}:${weight}`] ?? fonts().metrics[`${font}:400`];
/** The characters of `s` the face can draw (resvg draws a tofu box for the rest), as one trimmed line. */
export function renderable(s, font = "sans", weight = 400) {
  const m = face(font, weight);
  let out = "";
  for (const ch of clean(s)) if (m.cmap.has(ch.codePointAt(0))) out += ch;
  return out.replace(/\s+/g, " ").trim();
}
/**
 * `s` as one clean line when the face can draw all of it, else "": a string the font can only draw
 * part of ("日本CAT", "Cat 🐱") is not that string, and showing the part would title the coin by a
 * name it does not have.
 */
export function drawable(s, font = "sans", weight = 400) {
  const c = clean(s);
  return c && renderable(c, font, weight) === c ? c : "";
}
/** Width in px of `s` set in a face at `size` px with `ls` px of letter-spacing; unknown glyphs count 0.6 em (resvg's box is narrower). */
export function measure(s, { font = "sans", weight = 400, size = 16, ls = 0 } = {}) {
  const m = face(font, weight);
  let w = 0, n = 0;
  for (const ch of String(s ?? "")) {
    const g = m.cmap.get(ch.codePointAt(0));
    w += (g == null ? 0.6 : m.adv[Math.min(g, m.nhm - 1)] / m.upem) * size; n++;
  }
  return w + ls * n;
}
/** `s`, or its longest prefix plus "…" that measures within `maxW` ("" when not even "…" fits). */
export function fit(s, style, maxW) {
  const text = String(s ?? "");
  if (measure(text, style) <= maxW) return text;
  const cps = [...text];
  for (let n = cps.length - 1; n > 0; n--) {
    const t = `${cps.slice(0, n).join("").trimEnd()}…`;
    if (measure(t, style) <= maxW) return t;
  }
  return measure("…", style) <= maxW ? "…" : "";
}
/**
 * How a coin is named on the card: "$TICKER", else the name (cut at 24), else its short mint
 * (web/src/lib/map/share.ts tick()), each only when the font can draw the whole of it (a CJK, emoji
 * or mixed-script ticker is not drawable here, and half of it would be a different ticker).
 * `address` says the short mint had to stand in, so it is drawn as an address.
 */
export function label(ref) {
  const sym = drawable(String(ref?.symbol ?? "").replace(/^\$+/, ""), "sans", 700);
  if (sym) return { text: `$${sym}`, address: false };
  const name = drawable(ref?.name, "sans", 700);
  if (name) return { text: name.length > 24 ? `${name.slice(0, 23)}…` : name, address: false };
  return { text: shortMint(ref?.mint), address: true };
}
export const tick = (ref) => label(ref).text;
/** The letter a bubble shows without a logo: the ticker's (else the name's) first character the mono face can draw, upper-cased; "" when none. */
export function letterOf(ref) {
  for (const s of [String(ref?.symbol ?? "").replace(/^\$+/, ""), ref?.name]) {
    const ch = [...clean(s)].find((c) => c !== " ");
    if (ch && renderable(ch, "mono", 500) === ch) return ch.toUpperCase();
  }
  return "";
}

// ---------------------------------------------------------------- the picture
/** The map's palette (web/src/components/map/store.ts COLORS, HULL) and the card's own inks. */
export const COLORS = ["#b6ff5c", "#5ce0c8", "#b08cff", "#ffcf5c"];
export const HULL = "#a8c4b0";
const C = { bg: "#07100b", bg2: "#0f2217", ink: "#e8f3e8", ink2: "#c6d9c9", muted: "#8ea596", faint: "#7d9a85", accent: "#b6ff5c", violet: "#b08cff", white: "#ffffff", title: "#eef6ef", tail: "#8fa597", tailOn: "#cfe9b0" };
const colorOf = (n) => (n.asset ? HULL : COLORS[Math.min(Math.max(0, n.depth | 0), COLORS.length - 1)]);
const HX = 52, HW = 400; // the HUD column
const CAP = 0.71; // Geist cap height, em
const S = {
  ticker: { font: "sans", weight: 700, size: 60 }, address: { font: "mono", weight: 500, size: 40 }, name: { font: "sans", weight: 400, size: 26 }, lineage: { font: "mono", weight: 400, size: 24 },
  pill: { font: "mono", weight: 500, size: 20, ls: 1.6 }, chip: { font: "mono", weight: 500, size: 13, ls: 1.3 },
  label: { font: "mono", weight: 500, size: 22, ls: 1.2 }, value: { font: "mono", weight: 500, size: 34 }, family: { font: "mono", weight: 400, size: 22 },
  mark: { font: "sans", weight: 600, size: 26 }, sub: { font: "mono", weight: 400, size: 15 },
  title: { font: "mono", weight: 500, size: 26 }, tail: { font: "mono", weight: 400, size: 22 }, focus: { font: "mono", weight: 500, size: 26 }, letter: { font: "mono", weight: 500, size: 10 },
};
/** The HUD ticker's sizes, largest first: a ticker is set at the first one it fits the column at, and cut (fit) only at the last. */
export const TICKER_SIZES = [60, 52, 46, 40];
/** The lineage line's sizes, largest first (the smaller is the card's floor for body text). */
export const LINEAGE_SIZES = [24, 22];
/**
 * The ticker style whose size is the largest in TICKER_SIZES at which `s` plus `extra` (the "1ST" pill
 * and its gap, for a firstborn) measure within `maxW`; when none fits with the extra, the largest at
 * which `s` alone does (the pill then moves to the lineage line); the last when none does.
 */
export function tickerStyle(s, maxW, extra = 0) {
  for (const need of extra > 0 ? [extra, 0] : [0]) for (const size of TICKER_SIZES) { const st = { ...S.ticker, size }; if (measure(s, st) + need <= maxW) return st; }
  return { ...S.ticker, size: TICKER_SIZES[TICKER_SIZES.length - 1] };
}
const attrs = ({ font, weight, size, ls = 0 }) => `font-family="${FAMILY[font]}" font-weight="${weight}" font-size="${size}"${ls ? ` letter-spacing="${ls}"` : ""}`;
/** A <text> of `parts` ([{ t, fill, ...style }]) at a baseline; every part is escaped here. `outline` strokes it in the background colour first, the way the map outlines labels over bubbles. */
const text = (x, y, style, parts, { anchor = "start", outline = false } = {}) =>
  `<text x="${x}" y="${y}" ${attrs(style)}${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}${outline ? ` stroke="${C.bg}" stroke-width="${Math.max(4, style.size * 0.22).toFixed(1)}" stroke-linejoin="round" paint-order="stroke"` : ""}>${parts.map((p) => `<tspan fill="${p.fill}"${p.weight && p.weight !== style.weight ? ` font-weight="${p.weight}"` : ""}>${esc(p.t)}</tspan>`).join("")}</text>`;
const widthOf = (style, parts) => parts.reduce((w, p) => w + measure(p.t, { ...style, weight: p.weight ?? style.weight }), 0);
/** A rounded outline chip with uppercase mono text, its left edge at `x`; returns its svg and width. */
function chip(x, yMid, label, style, color, { h = 28, padX = 12 } = {}) {
  const t = label.toUpperCase(), w = Math.ceil(measure(t, style) + 2 * padX);
  const baseline = yMid + (CAP * style.size) / 2;
  return { w, svg: `<rect x="${x + 0.5}" y="${yMid - h / 2 + 0.5}" width="${w - 1}" height="${h - 1}" rx="${(h - 1) / 2}" fill="none" stroke="${color}" stroke-opacity="0.75"/>${text(x + padX, baseline, style, [{ t, fill: color }])}` };
}
const f1 = (v) => (Math.round(v * 10) / 10).toString();
const pngUri = (png) => `data:image/png;base64,${png.toString("base64")}`;

/**
 * The family picture: ground, hull, links, bubbles, the top's title and the shared coin's label, all
 * inside PIC. `logos` maps mint → PNG bytes; `data` is cardData. Returns `{ svg, drawn }`, `drawn` the
 * number of bubbles in the picture (after layoutFamily's drops).
 */
function pictureSvg(data, logos) {
  const nodes = data.bubbles?.nodes ?? [];
  if (!nodes.length) return { svg: "", drawn: 0 };
  // each distinct logo is embedded once (a <symbol> in the defs; a family's members often share one image) and drawn per
  // bubble with <use>, so a shared image costs the svg its bytes once
  const uriOf = new Map(), idOf = new Map(); // mint → data uri; data uri → the symbol's id
  for (const n of nodes) { const png = logos.get(n.mint); if (!png) continue; const u = pngUri(png); uriOf.set(n.mint, u); if (!idOf.has(u)) idOf.set(u, `l${idOf.size}`); }
  const logoBytes = new Map(nodes.map((n) => [n.mint, logos.get(n.mint)?.length ?? 0])), logoIds = new Map([...uriOf].map(([m, u]) => [m, idOf.get(u)]));
  const { circles, dropped, noLogo } = layoutFamily(nodes, data.mint, { total: data.bubbles.total, valueUsd: data.bubbles.valueUsd, logoBytes, logoIds, maxBytes: SVG_MAX_BYTES - 64 * 1024 });
  const byMint = new Map(circles.map((c) => [c.mint, c]));
  const focus = byMint.get(data.mint) ?? circles[0], top = circles.find((c) => c.top) ?? circles[0];
  const chain = new Set(ancestorsIn(byMint, data.mint).map((a) => a.mint)); // dashed rings
  const total = data.bubbles.total, omitted = (data.bubbles.omitted ?? 0) + dropped;
  const defs = [], out = [];
  // --- ground: the map's dot grid, clipped to the picture
  defs.push(`<pattern id="grid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${C.accent}" fill-opacity="0.07"/></pattern>`);
  defs.push(`<clipPath id="pic"><rect x="${PIC.x0 - 40}" y="0" width="${CARD_W - PIC.x0 + 40}" height="${CARD_H}"/></clipPath>`);
  for (let i = 0; i < COLORS.length; i++) defs.push(`<radialGradient id="gl${i}"><stop offset="0.375" stop-color="${COLORS[i]}" stop-opacity="0.38"/><stop offset="0.69" stop-color="${COLORS[i]}" stop-opacity="0.1"/><stop offset="1" stop-color="${COLORS[i]}" stop-opacity="0"/></radialGradient>`);
  defs.push(`<radialGradient id="glA"><stop offset="0.375" stop-color="${HULL}" stop-opacity="0.3"/><stop offset="0.69" stop-color="${HULL}" stop-opacity="0.08"/><stop offset="1" stop-color="${HULL}" stop-opacity="0"/></radialGradient>`);
  defs.push(`<radialGradient id="halo"><stop offset="0.55" stop-color="${C.accent}" stop-opacity="0.28"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>`);
  out.push(`<rect x="${PIC.x0 - 40}" y="0" width="${CARD_W - PIC.x0 + 40}" height="${CARD_H}" fill="url(#grid)"/>`);
  // --- hull: the map's soft blob around the members: the convex hull of the rims padded by HULL_PAD_IN, its corners
  // rounded (smoothHull), stroked HULL_PAD_OUT wide with round joins, a faint lime rim beneath; every bubble stays
  // inside (the smoothing cuts a corner by less than the padding), and the whole stays within PIC_MARGIN
  let hull = null; // the blob's path, kept for the shared coin's label when it has to float outside
  if (circles.length >= 2) {
    const pts = [];
    for (const c of circles) for (let k = 0; k < 12; k++) pts.push({ x: c.x + Math.cos((k * Math.PI) / 6) * (c.r + HULL_PAD_IN), y: c.y + Math.sin((k * Math.PI) / 6) * (c.r + HULL_PAD_IN) });
    hull = smoothHull(convexHull(pts));
    const d = hull.map((p, i) => `${i ? "L" : "M"}${f1(p.x)} ${f1(p.y)}`).join("") + "Z";
    out.push(`<path d="${d}" fill="none" stroke="${C.accent}" stroke-opacity="0.13" stroke-width="${HULL_PAD_OUT * 2 + 2}" stroke-linejoin="round"/>`,
      `<path d="${d}" fill="${HULL}" fill-opacity="0.045" stroke="${HULL}" stroke-opacity="0.06" stroke-width="${HULL_PAD_OUT * 2}" stroke-linejoin="round"/>`);
  } else {
    out.push(`<circle cx="${f1(focus.x)}" cy="${f1(focus.y)}" r="${f1(focus.r + 40)}" fill="none" stroke="${C.accent}" stroke-opacity="0.22"/>`);
  }
  // --- links parent → child in the parent's colour, fainter and thinner for a big family (the map's size classes)
  const [linkA, linkW] = total > 800 ? [0.18, 1.1] : total > 200 ? [0.22, 1.2] : [0.3, 1.4];
  const links = [];
  for (const c of circles) { const p = c.parentMint ? byMint.get(c.parentMint) : null; if (p) links.push(`<line x1="${f1(p.x)}" y1="${f1(p.y)}" x2="${f1(c.x)}" y2="${f1(c.y)}" stroke="${colorOf(p)}" stroke-opacity="${linkA}"/>`); }
  if (links.length) out.push(`<g stroke-width="${linkW}">${links.join("")}</g>`);
  // --- bubbles, largest first so the small ones sit on top, the shared coin last
  const order = [...circles].sort((a, b) => (a.focus ? 1 : 0) - (b.focus ? 1 : 0) || b.r - a.r);
  const bodies = [], used = new Set(); // the symbols the bubbles draw (a shed logo is not embedded)
  order.forEach((c, i) => {
    const col = colorOf(c), r = c.r, x = f1(c.x), y = f1(c.y);
    if (c.top || c.focus) bodies.push(`<circle cx="${x}" cy="${y}" r="${f1(r * 1.6)}" fill="url(#${c.asset ? "glA" : `gl${Math.min(Math.max(0, c.depth | 0), 3)}`})"/>`);
    if (c.focus) bodies.push(`<circle cx="${x}" cy="${y}" r="${f1(r + 44)}" fill="url(#halo)"/>`);
    bodies.push(`<circle cx="${x}" cy="${y}" r="${f1(r)}" fill="${col}" fill-opacity="0.2"/>`);
    const id = noLogo.has(c.mint) ? null : idOf.get(uriOf.get(c.mint));
    if (id && r >= 6) {
      // the logo, cover-fitted into the symbol's unit box and scaled to the disc by the <use>, clipped half a pixel inside the rim
      used.add(id);
      defs.push(`<clipPath id="c${i}"><circle cx="${x}" cy="${y}" r="${f1(r - 0.5)}"/></clipPath>`);
      bodies.push(`<g clip-path="url(#c${i})"><use href="#${id}" x="${f1(c.x - r)}" y="${f1(c.y - r)}" width="${f1(2 * r)}" height="${f1(2 * r)}"/></g>`,
        `<circle cx="${x}" cy="${y}" r="${f1(r - 0.5)}" fill="${col}" fill-opacity="0.14"/>`);
    } else if (r >= 6) {
      // no logo: the ticker's letter; a ticker and name the mono face cannot draw (an emoji coin before its logo is cached) show the mint's first character, never an empty disc
      const ch = letterOf(c) || [...shortMint(c.mint)][0] || "";
      if (ch) bodies.push(text(x, f1(c.y + (CAP * r * 0.95) / 2), { ...S.letter, size: Math.max(9, Math.round(r * 0.95)) }, [{ t: ch, fill: col }], { anchor: "middle" }));
    }
    const anc = chain.has(c.mint);
    bodies.push(`<circle cx="${x}" cy="${y}" r="${f1(r)}" fill="none" stroke="${col}" stroke-opacity="${anc ? 0.95 : 0.8}" stroke-width="1.4"${anc ? ' stroke-dasharray="5 5"' : ""}/>`);
    if (c.migrated && r >= 7) { const a = -Math.PI / 4; bodies.push(`<circle cx="${f1(c.x + Math.cos(a) * r)}" cy="${f1(c.y + Math.sin(a) * r)}" r="3.2" fill="${C.white}" stroke="${C.bg}" stroke-width="1.2"/>`); }
    if (c.ours && !c.focus) bodies.push(`<circle cx="${x}" cy="${y}" r="${f1(r + 3)}" fill="none" stroke="${C.accent}" stroke-opacity="0.95" stroke-width="1.6"/>`, `<circle cx="${x}" cy="${y}" r="${f1(r + 6)}" fill="none" stroke="${C.accent}" stroke-opacity="0.35"/>`);
    if (c.focus) bodies.push(`<circle cx="${x}" cy="${y}" r="${f1(r + 6)}" fill="none" stroke="${C.accent}" stroke-width="3"/>`);
  });
  for (const [u, id] of idOf) if (used.has(id)) defs.push(`<symbol id="${id}" viewBox="0 0 64 64" preserveAspectRatio="xMidYMid slice"><image width="64" height="64" preserveAspectRatio="xMidYMid slice" href="${u}"/></symbol>`);
  // --- the top's title ("$ROOT" + muted "199 coins · 4.6% of the map · +N more") above the top; lime when the top is the shared coin
  const labels = [];
  let leader = ""; // the floating label's hairline, drawn with the links, beneath the bubbles (never across a logo)
  let titleBox = null; // { x, y0, x1, y1 }: the floating label keeps clear of it
  const clampX = (cx, w) => Math.min(PIC.x1 - 8 - w, Math.max(PIC.x0 + 8, cx - w / 2));
  // how much bubble a label box (baseline y, cap height h) would cover: the sum of the radii of the circles it touches, the top
  // counting fourfold (a name over the root is the worst place for it), a letter avatar half (no logo is hidden under it); the
  // spot with the least wins
  const crowd = (x, y, w, h) => circles.reduce((n, c) => {
    const nx = Math.max(x, Math.min(c.x, x + w)), ny = Math.max(y - h, Math.min(c.y, y + 2)), dx = c.x - nx, dy = c.y - ny;
    return n + (dx * dx + dy * dy < c.r * c.r ? (c.top ? 4 : noLogo.has(c.mint) || !logos.get(c.mint) ? 0.5 : 1) * c.r : 0);
  }, 0);
  if (circles.length >= 2) {
    const on = top.focus, head = { t: tick(top), fill: on ? C.accent : C.title };
    const coins = underIt(data.family?.under)?.replace(/ under it$/, "") ?? null, share = pctOf(data.family?.sharePct) ? `${pctOf(data.family.sharePct)} of the map` : null, more = omitted > 0 ? `+${count(omitted)} more` : null;
    const maxW = PIC.x1 - PIC.x0 - 16, headW = measure(head.t, S.title) + measure(" ", S.tail); // a leading space would collapse in svg: the tail starts one space later
    // the tail gives way a part at a time rather than being cut mid-number: the share first, then the count; "+N more"
    // (what the picture does not show) stays as long as anything fits
    let tail = "";
    for (const bits of [[coins, share, more], [coins, more], [more], [coins], [share], []]) {
      const t = bits.filter(Boolean).length ? `· ${bits.filter(Boolean).join(" · ")}` : "";
      if (headW + measure(t, S.tail) <= maxW) { tail = t; break; }
    }
    const w = headW + measure(tail, S.tail);
    // above the whole cluster and its hull rim, over the top's column: the map's title floats above its tree
    const clusterTop = Math.min(...circles.map((c) => c.y - c.r));
    const x = clampX(top.x, w), y = Math.max(PIC.y0 + 26, clusterTop - HULL_PAD_IN - HULL_PAD_OUT - 8);
    titleBox = { x0: x, y0: y - S.title.size * CAP, x1: x + w, y1: y };
    labels.push(text(f1(x), f1(y), S.title, [head], { outline: true }), tail ? text(f1(x + headW), f1(y), S.tail, [{ t: tail, fill: on ? C.tailOn : C.tail }], { outline: true }) : "");
  }
  // --- the shared coin's label (+ the "1ST" pill) beside its ring, unless it is the top (its title names it): the least
  // crowded spot of LABEL_DIRS directions on LABEL_RINGS rings out from the ring (below first, then clockwise; a nearer ring
  // wins a tie, below wins one on the same ring); when every spot covers a bubble the label is set at the tail size
  // (S.tail, the card's smallest body text) and placed again, so a neighbour's logo stays visible; boxed in on every side
  // even so (a crowded family around the coin), it floats outside the family's blob the way the map's labels float beside
  // crowded clusters: at the nearest rim point whose box covers no bubble and not the title, a hairline leader to the ring
  if (!focus.top || circles.length < 2) {
    const t = tick(focus);
    const pill = data.firstborn ? chip(0, 0, "1st", S.pill, C.accent, { h: 32, padX: 12 }) : null;
    // the label's box at a style: text width w0, full width w, cap height h; the pill stands 8 px (yp) above and below the text
    const boxOf = (st) => { const w0 = measure(t, st), h = st.size * CAP, yp = pill ? 8 : 0; return { w0, w: w0 + (pill ? pill.w + 12 : 0), h, yp, hp: h + 2 * yp }; };
    const spotsAt = (st) => {
      const { w0, w, h, yp, hp } = boxOf(st), d = focus.r + 16;
      let best = null;
      for (let ring = 0; ring < LABEL_RINGS; ring++) for (let i = 0; i < LABEL_DIRS; i++) {
        const a = Math.PI / 2 + (i * 2 * Math.PI) / LABEL_DIRS, ca = Math.cos(a), sa = Math.sin(a); // 0 = below, then clockwise on screen
        const reach = d + ring * LABEL_RING_STEP + Math.abs(ca) * (w / 2) + Math.abs(sa) * (h / 2 + 6); // the box's half-extent along the direction
        const cx = focus.x + ca * reach, cy = focus.y + sa * reach + h / 2; // cy: the baseline of a box centred there
        const x = clampX(cx, w), y = Math.min(PIC.y1 - 8, Math.max(PIC.y0 + 26, cy));
        const n = crowd(x, y + yp, w, hp) + ring * 0.5;
        if (!best || n < best.n) best = { x, y, n };
      }
      return { ...best, w0, st };
    };
    // the bubbles a leader from the shared coin to `p` would cross, as crowd() counts them (the top fourfold): the rim nearest
    // the coin may lie past the top or a big neighbour, and the coin's own side is the one the leader crosses least
    const crossed = (p) => {
      const dx = p.x - focus.x, dy = p.y - focus.y, l2 = dx * dx + dy * dy;
      return circles.reduce((n, c) => {
        if (c.focus) return n;
        const t = Math.max(0, Math.min(1, ((c.x - focus.x) * dx + (c.y - focus.y) * dy) / l2)), qx = focus.x + dx * t, qy = focus.y + dy * t;
        return n + ((c.x - qx) ** 2 + (c.y - qy) ** 2 < c.r * c.r ? (c.top ? 4 : 1) * c.r : 0);
      }, 0);
    };
    const outsideAt = (st) => {
      if (!hull) return null;
      const { w0, w, h, yp, hp } = boxOf(st);
      const rim = rimPoints(hull).filter((p) => dist2(p, focus) > 0).map((p) => ({ p, cost: Math.sqrt(dist2(p, focus)) + crossed(p) })).sort((a, b) => a.cost - b.cost);
      for (const { p } of rim) {
        const len = Math.hypot(p.x - focus.x, p.y - focus.y);
        const ca = (p.x - focus.x) / len, sa = (p.y - focus.y) / len; // outward: the hull is convex, so past its rim along this ray is outside it
        const reach = HULL_PAD_OUT + 12 + Math.abs(ca) * (w / 2) + Math.abs(sa) * (hp / 2); // from the rim to the box's centre
        const x = clampX(p.x + ca * reach, w), y = Math.min(PIC.y1 - 8, Math.max(PIC.y0 + 26, p.y + sa * reach + h / 2));
        if (crowd(x, y + yp, w, hp) > 0 || (titleBox && x < titleBox.x1 + 6 && titleBox.x0 < x + w + 6 && y - h - yp < titleBox.y1 + 6 && titleBox.y0 < y + yp + 6)) continue;
        // the leader: from just outside the ring toward the box's nearest point, stopping short of it
        const q = { x: Math.min(x + w, Math.max(x, focus.x)), y: Math.min(y + yp, Math.max(y - h - yp, focus.y)) }, dq = Math.hypot(q.x - focus.x, q.y - focus.y);
        const ux = (q.x - focus.x) / dq, uy = (q.y - focus.y) / dq, r0 = focus.r + 8;
        const leader = dq > r0 + 4 ? `<line x1="${f1(focus.x + ux * r0)}" y1="${f1(focus.y + uy * r0)}" x2="${f1(q.x - ux * 3)}" y2="${f1(q.y - uy * 3)}" stroke="${C.accent}" stroke-opacity="0.6" stroke-width="1"/>` : "";
        return { x, y, n: 0, w0, st, leader };
      }
      return null;
    };
    let best = spotsAt(S.focus);
    if (best.n >= 1) best = spotsAt({ ...S.focus, size: S.tail.size });
    if (best.n >= 1) best = outsideAt(S.focus) ?? outsideAt({ ...S.focus, size: S.tail.size }) ?? best;
    const { x, y, w0, st } = best;
    leader = best.leader ?? "";
    labels.push(text(f1(x), f1(y), st, [{ t, fill: C.accent }], { outline: true }));
    if (pill) labels.push(chip(x + w0 + 12, y - (CAP * st.size) / 2, "1st", S.pill, C.accent, { h: 32, padX: 12 }).svg);
  }
  out.push(leader, bodies.join(""), labels.join(""));
  return { svg: `<defs>${defs.join("")}</defs><g clip-path="url(#pic)">${out.join("")}</g>`, drawn: circles.length };
}

/**
 * The card as SVG for `data` (cardData). `logos` maps mint → PNG bytes (Buffer) of the bubbles' logos
 * (a 64 or 256 px thumbnail; a mint without one gets a letter avatar); `logo` is the shared coin's
 * alone, for callers that have just that; `host` is the site shown by the wordmark. Pure: the same
 * input draws the same svg.
 */
export function cardSvg(data, { logo = null, logos = null, host = "sporepad.com", now = null } = {}) {
  const parts = [];
  const pngs = new Map(logos instanceof Map ? logos : Object.entries(logos ?? {}));
  if (isPng(logo)) pngs.set(data.mint, logo);
  for (const [k, v] of pngs) if (!isPng(v)) pngs.delete(k);
  // a coin with no drawable ticker or name is titled by its mint, set as an address (mono, smaller, muted) so it
  // never reads as a name; a name the font can only draw part of is left out rather than shown cut
  const { text: self, address } = label(data), name = address ? "" : drawable(data.name, "sans", 400);
  // --- backdrop: deep green-black, the picture on the right, a scrim behind the HUD, a lime glow top-left, a violet one bottom-right, a hairline frame
  parts.push(`<rect width="${CARD_W}" height="${CARD_H}" fill="${C.bg}"/>`);
  const pic = pictureSvg(data, pngs);
  parts.push(pic.svg);
  parts.push(`<defs><linearGradient id="scrim" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${C.bg}" stop-opacity="1"/><stop offset="0.72" stop-color="${C.bg}" stop-opacity="0.88"/><stop offset="1" stop-color="${C.bg}" stop-opacity="0"/></linearGradient>`,
    `<radialGradient id="g1"><stop offset="0" stop-color="${C.accent}" stop-opacity="0.14"/><stop offset="0.5" stop-color="${C.accent}" stop-opacity="0.03"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="g2"><stop offset="0" stop-color="${C.violet}" stop-opacity="0.08"/><stop offset="1" stop-color="${C.violet}" stop-opacity="0"/></radialGradient></defs>`,
    `<rect x="0" y="0" width="${PIC.x0 + 40}" height="${CARD_H}" fill="url(#scrim)"/>`,
    `<circle cx="120" cy="40" r="520" fill="url(#g1)"/><circle cx="1180" cy="640" r="420" fill="url(#g2)"/>`,
    `<rect x="0.5" y="0.5" width="${CARD_W - 1}" height="${CARD_H - 1}" fill="none" stroke="${C.accent}" stroke-opacity="0.2"/>`);
  // --- status chips, top-left
  let xc = HX;
  for (const [on, label, color] of [[data.ours, "launched on Spore", C.accent], [data.migrated, "graduated", C.violet]]) {
    if (!on) continue;
    const ch = chip(xc, 58, label, S.chip, color); parts.push(ch.svg); xc += ch.w + 10;
  }
  // --- ticker (+ the "1st" pill), name, lineage: a column that flows (no name line, no gap). A ticker too wide
  // for the column at 60 px is set smaller (TICKER_SIZES: 10 pump.fun characters fit at 52; a firstborn's pill
  // counts, so it stays beside the ticker at a smaller size rather than moving down) and only cut past 40.
  let y = 156;
  const pill = data.firstborn ? chip(0, 0, "1st", S.pill, C.accent, { h: 34, padX: 12 }) : null;
  const titleStyle = address ? S.address : tickerStyle(self, HW, pill ? 18 + pill.w : 0);
  const tickerText = fit(self, titleStyle, HW), tickerW = measure(tickerText, titleStyle);
  parts.push(text(HX, y, titleStyle, [{ t: tickerText, fill: address ? C.ink2 : C.ink }]));
  let pillLeft = pill;
  if (pill && tickerW + 18 + pill.w <= HW) { parts.push(chip(HX + tickerW + 18, y - (CAP * titleStyle.size) / 2, "1st", S.pill, C.accent, { h: 34, padX: 12 }).svg); pillLeft = null; }
  if (name && name.toLowerCase() !== self.replace(/^\$/, "").toLowerCase()) { y += 42; parts.push(text(HX, y, S.name, [{ t: fit(name, S.name, HW), fill: C.muted }])); }
  y += 40;
  const { parts: lineage, style: lineageStyle } = lineageParts(data, HW - (pillLeft ? pillLeft.w + 14 : 0));
  parts.push(text(HX, y, lineageStyle, lineage));
  if (pillLeft) parts.push(chip(HX + widthOf(lineageStyle, lineage) + 14, y - (CAP * lineageStyle.size) / 2, "1st", S.pill, C.accent, { h: 34, padX: 12 }).svg);
  // --- the stat rows, label over value: MCAP with AGE beside it, LOCKED BY CHILDREN (dust under a cent hidden, as the og:description
  // hides it), CHILDREN or CHILDREN / DESCENDANTS (a leaf shows none: the family line says where it sits); an unknown figure hides its row
  y += 28;
  parts.push(`<line x1="${HX}" y1="${y}" x2="${HX + HW}" y2="${y}" stroke="${C.white}" stroke-opacity="0.08"/>`);
  const locked = data.lockedUsd >= 0.01 ? usd(data.lockedUsd) : null;
  const rows = [[["mcap", usd(data.mcapUsd)], ["age", ageOf(data.createdAt, now)]], [["locked by children", locked]], childrenColumn(data)].map((r) => r.filter(([, v]) => v != null)).filter((r) => r.length);
  for (const row of rows) {
    y += 32; let x = HX;
    for (const [label, value] of row) {
      parts.push(text(x, y, S.label, [{ t: label.toUpperCase(), fill: C.muted }]), text(x, y + 34, S.value, [{ t: value, fill: C.ink }]));
      x += Math.max(measure(label.toUpperCase(), S.label), measure(value, S.value)) + 44;
    }
    y += 40;
  }
  // --- the family block (two lines), then the wordmark and site, bottom-left
  const yFamily = 520, yMark = 586, ySub = 610;
  const [line1, line2] = familyParts(data, self, HW);
  parts.push(text(HX, yFamily, S.family, line1));
  if (line2) parts.push(text(HX, yFamily + 28, S.family, line2));
  parts.push(`<circle cx="${HX + 7}" cy="${yMark - 9}" r="6" fill="${C.accent}"/>`, text(HX + 22, yMark, S.mark, [{ t: "spore", fill: C.ink }]));
  parts.push(text(HX, ySub, S.sub, [{ t: host, fill: C.muted }, { t: " · pump.fun pair", fill: C.faint }]));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">${parts.join("")}</svg>`;
}
/** The children row of the stats: none for a leaf, "CHILDREN n" when nothing goes deeper, else "CHILDREN / DESCENDANTS n / m". */
function childrenColumn(data) {
  const kids = count(data.children), all = count(data.descendants);
  if (kids == null || !(data.children > 0)) return [];
  return data.descendants > data.children && all != null ? [["children / descendants", `${kids} / ${all}`]] : [["children", kids]];
}
/**
 * The lineage line, `{ parts, style }`: "↳ under $PARENT · under $ROOT" for a child, "root · quoted in
 * SOL" / "quoted in $ASSET" for a depth-0 coin. Two long tickers do not fit the column at the line's
 * 24 px, so the line steps down: the same at LINEAGE_SIZES' smaller size (22 px, the card's floor),
 * then "↳ under $PARENT · $ROOT" at either, then the parent alone, shortened to fit.
 */
function lineageParts(data, maxW) {
  const styles = LINEAGE_SIZES.map((size) => ({ ...S.lineage, size }));
  const first = (choices) => { for (const [st, parts] of choices) if (widthOf(st, parts) <= maxW) return { parts, style: st }; return null; };
  if (!data.parent) {
    const asset = data.root ? tick(data.root) : null;
    const parts = asset ? [{ t: "quoted in ", fill: C.muted }, { t: asset, fill: C.ink2 }] : [{ t: "root", fill: C.accent }, { t: " · quoted in ", fill: C.muted }, { t: "SOL", fill: C.ink2 }];
    return first(styles.map((st) => [st, parts])) ?? { parts: [{ t: "root", fill: C.accent }], style: styles[0] };
  }
  const p = tick(data.parent), r = data.root && data.root.mint !== data.parent.mint ? tick(data.root) : null;
  const head = [{ t: "↳ ", fill: C.accent }, { t: "under ", fill: C.muted }];
  if (r) {
    const full = [...head, { t: p, fill: C.ink2 }, { t: " · under ", fill: C.muted }, { t: r, fill: C.ink2 }], short = [...head, { t: p, fill: C.ink2 }, { t: " · ", fill: C.muted }, { t: r, fill: C.ink2 }];
    const hit = first([...styles.map((st) => [st, full]), ...styles.map((st) => [st, short])]);
    if (hit) return hit;
  }
  const st = styles[0];
  return { parts: [...head, { t: fit(p, st, maxW - widthOf(st, head)), fill: C.ink2 }], style: st };
}
/**
 * The family block, two lines: "$TOP family · 4.6% of the map" over "1,352 coins under it" (the count
 * the og:description says, lib/format.mjs underIt); a lone coin: "no children yet" over "be the first
 * to spawn under it". Each line shortened to fit; the second may be null.
 */
function familyParts(data, self, maxW) {
  const st = S.family, f = data.family;
  const top = data.root ? tick(data.root) : self;
  if (!data.root && !(f.under > 0)) return [[{ t: "no children yet", fill: C.ink2 }], [{ t: fit("be the first to spawn under it", st, maxW), fill: C.muted }]];
  const share = pctOf(f.sharePct), below = underIt(f.under);
  let line1 = null;
  for (const tail of [share ? ` · ${share} of the map` : "", ""]) {
    const parts = [{ t: top, fill: C.ink2, weight: 500 }, { t: ` family${tail}`, fill: C.muted }];
    if (widthOf(st, parts) <= maxW) { line1 = parts; break; }
  }
  line1 ??= [{ t: fit(`${top} family`, { ...st, weight: 500 }, maxW), fill: C.ink2, weight: 500 }];
  return [line1, below ? [{ t: fit(below, st, maxW), fill: C.muted }] : null];
}

// ---------------------------------------------------------------- raster
const isPng = (b) => Buffer.isBuffer(b) && b.length > 24 && b.subarray(0, 8).equals(PNG_MAGIC);
let ready = null;
async function resvg() {
  ready ??= (async () => {
    const mod = await import("@resvg/resvg-wasm");
    // One wasm per thread, and agents/logo.mjs owns its initWasm on the main thread (a second call throws):
    // let it go first, as img-worker.mjs does, then tolerate "already initialized".
    try { const { renderLogo } = await import("./agents/logo.mjs"); await renderLogo({ symbol: "A", palette: [], seed: "init" }); } catch { /* the init below decides */ }
    try { await mod.initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))); }
    catch (e) { if (!/already initiali[sz]ed/i.test(String(e?.message ?? e))) throw e; }
    return mod;
  })();
  ready.catch(() => { ready = null; });
  return ready;
}
/** The in-process rasterizer: the same drawing as the worker's (img-worker.mjs renderCardSvg), on this thread. */
async function rasterizeHere(svg) {
  const { Resvg } = await resvg();
  const r = new Resvg(svg, { fitTo: { mode: "original" }, font: { fontBuffers: fonts().buffers, loadSystemFonts: false, defaultFontFamily: FAMILY.sans } });
  try { const out = r.render(); try { return Buffer.from(out.asPng()); } finally { out.free?.(); } } finally { r.free(); }
}
/**
 * PNG bytes of a card svg (CARD_W × CARD_H) set in the bundled Geist faces. `work` is the ImgWork
 * (ImageCache.work) whose thread draws it, so the loop stays free; without one, or when the worker
 * fails this one job (it died mid-card, it cannot be spawned), the card is drawn here.
 */
export async function rasterize(svg, work = null) {
  if (work && typeof work.card === "function") {
    try { const png = await work.card({ svg }); if (isPng(png)) return png; } catch { /* drawn here instead */ }
  }
  return rasterizeHere(svg);
}

// ---------------------------------------------------------------- logos
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const readThumb = (images, url, w) => { try { const b = images?.thumbBytes?.(url, w); return isPng(b) ? b : null; } catch { return null; } };
/**
 * Starts making the `w` px PNG of `url` in the image cache, the way /api/img makes it (`get` +
 * `thumb`: the cache's own negative memory of a dead upstream still holds, but not `warm`'s
 * hours-long skip list, which a rate-limited bulk pass fills with perfectly fetchable logos); a cache
 * without those two gets a warm ask. Returns the job (never rejects; its result is not the PNG: the
 * caller re-reads the thumbnail from disk), null when the cache can make nothing.
 */
function makeLogo(images, url, w) {
  const make = typeof images?.get === "function" && typeof images.thumb === "function"
    ? async () => { const hit = await images.get(url); return hit ? images.thumb(url, hit, w) : null; }
    : typeof images?.warm === "function" ? () => images.warm([url], w, 1) : null;
  return make ? Promise.resolve().then(make).catch(() => null) : null;
}
const warmAsked = new Map(); // url → when it was last asked for, so a family's cards do not re-ask every render
/**
 * The logos a card's bubbles embed (Map mint → PNG): members from the 64 px thumbnails on disk (a
 * missing one is a letter avatar now and warmed for later, at most WARM_MAX per render, each url at
 * most once a minute, never waited for); the shared coin and the top from the 256 px thumbnail when
 * their bubble is big (BIG_LOGO_R), else 64 px, the other size standing in, and a cold one made the
 * way /api/img makes it, both at once, and waited for up to `waitMs` in all (one wait, not one per
 * logo). `placeholder` says one of those two is missing, or has no image yet while its metadata is
 * still being fetched (`imagePending`: the route asks the fetcher for it first, so it lands soon).
 */
async function gatherLogos(images, data, waitMs, t) {
  const logos = new Map();
  const nodes = data.bubbles?.nodes ?? [];
  if (!images || !nodes.length) return { logos, placeholder: !!images && (!!data.image || !!data.imagePending) };
  const radii = sizeBubbles(nodes, { total: data.bubbles.total, valueUsd: data.bubbles.valueUsd });
  const missing = [], cold = [], jobs = [];
  let placeholder = false;
  for (const n of nodes) {
    if (!n.image) { if (n.imagePending && (n.focus || n.top)) placeholder = true; continue; }
    if (n.focus || n.top) {
      const big = (radii.get(n.mint) ?? 0) > BIG_LOGO_R, want = big ? LOGO_PX : MEMBER_LOGO_PX, other = big ? MEMBER_LOGO_PX : LOGO_PX;
      const png = readThumb(images, n.image, want) ?? readThumb(images, n.image, other);
      if (png) { logos.set(n.mint, png); continue; }
      const job = makeLogo(images, n.image, want);
      if (job) jobs.push(job);
      cold.push({ n, want, other });
      continue;
    }
    const png = readThumb(images, n.image, MEMBER_LOGO_PX);
    if (png) logos.set(n.mint, png);
    else if (missing.length < WARM_MAX && t - (warmAsked.get(n.image) ?? -Infinity) > WARM_AGAIN_MS) { missing.push(n.image); warmAsked.set(n.image, t); }
  }
  if (missing.length && typeof images.warm === "function") { Promise.resolve().then(() => images.warm(missing, MEMBER_LOGO_PX, 4)).catch(() => null); }
  if (warmAsked.size > 5_000) for (const [k, at] of warmAsked) if (t - at > WARM_AGAIN_MS) warmAsked.delete(k);
  if (cold.length) {
    if (jobs.length && waitMs > 0) await Promise.race([Promise.allSettled(jobs), sleep(waitMs)]);
    for (const { n, want, other } of cold) {
      const png = jobs.length && waitMs > 0 ? readThumb(images, n.image, want) ?? readThumb(images, n.image, other) : null;
      if (png) logos.set(n.mint, png); else placeholder = true;
    }
  }
  return { logos, placeholder };
}

// ---------------------------------------------------------------- cache, admission, backlog
const lru = new Map();      // key → { at, out, placeholder }
const inflight = new Map(); // key → Promise<out>
const backlog = new Map();  // key → { svg, data, placeholder, t, work, maxInflight }: refused renders, drawn when a slot frees
let drawing = 0;            // cards holding a rasterize slot
const remember = (key, entry) => { lru.delete(key); lru.set(key, entry); while (lru.size > CARD_LRU_MAX) lru.delete(lru.keys().next().value); };
/** Forgets every rendered card and the backlog (tests). */
export function resetCards() { lru.clear(); backlog.clear(); warmAsked.clear(); }
/** Rasterizes `svg` under a drawing slot, remembers the card and hands the next backlog entry its slot. */
async function draw(key, { svg, data, placeholder, t, work, maxInflight }) {
  drawing++;
  let png;
  try { png = await rasterize(svg, work); }
  finally { drawing--; drain(maxInflight); }
  const out = { png, etag: `"${createHash("sha1").update(png).digest("base64url").slice(0, 20)}"`, data, placeholder };
  remember(key, { at: t, out, placeholder });
  return out;
}
function drain(maxInflight) {
  while (drawing < maxInflight && backlog.size) {
    const [key, b] = backlog.entries().next().value;
    backlog.delete(key);
    if (inflight.has(key)) continue;
    const job = draw(key, b).catch(() => null).finally(() => { if (inflight.get(key) === job) inflight.delete(key); });
    inflight.set(key, job);
  }
}
/**
 * `{ png, etag, data, placeholder }` for a mint, null when the model does not know it, CARD_BUSY
 * (`{ busy: true }`, no picture) when `maxInflight` cards are already being rasterized (the refused
 * card is then drawn in the background, so the next ask finds it). One render per mint per
 * CARD_TTL_MS (CARD_PLACEHOLDER_TTL_MS when the shared coin's or the top's logo was not cached yet:
 * `placeholder` says so, and the route caches such a card as briefly), concurrent asks share one
 * render. `etag` is a quoted strong validator of the bytes. `images` is the ImageCache (or anything
 * with `thumbBytes(url, w)` and `warm(urls, w, n)`; its `work` draws the card off the loop); without
 * one every bubble is a letter avatar.
 */
export async function renderCard({ model, images = null, mint, publicUrl = "https://sporepad.com", now, logoWaitMs = LOGO_WAIT_MS, maxInflight = CARD_MAX_INFLIGHT } = {}) {
  const t = nowMs(now), key = `${publicUrl}|${mint}`;
  const hit = lru.get(key);
  if (hit && t - hit.at < (hit.placeholder ? CARD_PLACEHOLDER_TTL_MS : CARD_TTL_MS)) { remember(key, hit); return hit.out; }
  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      const data = cardData(model, mint, { now: t });
      if (!data) return null;
      const { logos, placeholder } = await gatherLogos(images, data, logoWaitMs, t); // no slot held while a logo is waited for
      let host = "sporepad.com";
      try { host = new URL(publicUrl).host || host; } catch { /* the default */ }
      const entry = { svg: cardSvg(data, { logos, host, now: t }), data, placeholder, t, work: images?.work ?? null, maxInflight };
      if (drawing >= maxInflight) {
        if (!backlog.has(key) && backlog.size < CARD_BACKLOG_MAX) backlog.set(key, entry);
        return CARD_BUSY;
      }
      return draw(key, entry);
    })().finally(() => { if (inflight.get(key) === job) inflight.delete(key); });
    inflight.set(key, job);
  }
  return job;
}
/** How many cards are being rasterized right now (tests, /api/health). */
export const cardsInflight = () => drawing;
/** How many refused cards wait to be drawn in the background (tests, /api/health). */
export const cardsBacklog = () => backlog.size;
