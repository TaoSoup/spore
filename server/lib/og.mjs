// Link previews (2026-10-23). When a coin link (/c/<mint> or /map?focus=<mint>) is pasted into X,
// Telegram or Discord, the crawler reads the server's index.html and never runs the app, so the
// only tags it sees are the static og:/twitter: block of web/index.html. This module turns the
// card data of one coin (lib/card.mjs `cardData`) into that coin's own tags and splices them into
// the block web/index.html fences with `<!-- og:start -->` / `<!-- og:end -->`; og:image points at
// the server-rendered card, /card/<mint>.png (also /api/card/), the coin's family drawn as the map (its alt says so). Everything here is text in, text out; api.mjs
// wires it into the SPA sender. Every value is attribute-escaped: names come from chain metadata.
// Numbers come from lib/format.mjs, the vocabulary the card is drawn with, so the text under the
// picture never disagrees with it.
import { usd, plural, pctOf, shortMint, underIt } from "./format.mjs";

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const OG_START = "<!-- og:start -->";
export const OG_END = "<!-- og:end -->";
/** The card's pixel size (mirrors CARD_W / CARD_H of lib/card.mjs, not imported so this file stays pure text). */
export const OG_IMAGE_W = 1200;
export const OG_IMAGE_H = 630;
const SITE = "Spore";
const DEFAULT_PUBLIC_URL = "https://sporepad.com";
/** og:image changes URL once a minute so a crawler that re-checks a link sees fresh numbers, while one minute of its cache stays valid. */
export const OG_IMAGE_VERSION_MS = 60_000;
const TITLE_MAX = 110, DESCRIPTION_MAX = 300, ALT_MAX = 400, NAME_MAX = 60;

/** One line of plain text: control characters and runs of whitespace collapsed, trimmed, capped with an ellipsis. */
export function oneLine(s, max = DESCRIPTION_MAX) {
  // eslint-disable-next-line no-control-regex -- control characters are what this strips
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
/** HTML attribute escaping for a double-quoted value (also `'` and `>`, so the tag line never breaks). */
export function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** `$TICKER`, else the name, else a shortened mint: never empty for a coin that exists. */
export function tickerOf(c) {
  const sym = oneLine(c?.symbol, 24).replace(/^\$+/, "");
  if (sym) return `$${sym}`;
  const name = oneLine(c?.name, NAME_MAX);
  return name || shortMint(c?.mint);
}
/** The coin is its family's top: no coin above it and no listed asset (such as $PUMP) above it either. */
const isTop = (d) => !d?.parent && !d?.root;

/** "$KID under $PARENT · Spore"; "$ROOT · Spore" for a family top; "$KID quoted in $PUMP · Spore" for a depth-0 coin paired with a listed asset. */
export function ogTitle(d) {
  const self = tickerOf(d);
  const above = d?.parent ? `under ${tickerOf(d.parent)}` : d?.root ? `quoted in ${tickerOf(d.root)}` : null;
  return oneLine(above ? `${self} ${above} · ${SITE}` : `${self} · ${SITE}`, TITLE_MAX);
}
/**
 * One line, in the words the site's share texts use (web/src/lib/map/share.ts): the name (when it
 * says more than the ticker), "mcap $12.4K", what is under the coin (a top: "1,352 coins under it";
 * a child: "12 children", plus descendants when the family goes deeper; "no children yet"), "$5.2K
 * locked", the first-child mark, the family's share of the map (a top: "41% of the Spore map"; a
 * member: "$PUMP family holds 4.3% of the map") and, from depth 2, the lineage, named here with
 * tickerOf from the card data's `chain` (the refs from the top down to the coin), so a CJK or emoji
 * ticker the card's font cannot draw still reads "$🎃" in the text, never a short mint; the card's
 * own `lineage` strings stand in when there is no chain. A missing number drops its part rather
 * than printing "null".
 */
export function ogDescription(d) {
  const parts = [];
  const name = oneLine(d?.name, NAME_MAX);
  if (name && name.toLowerCase() !== oneLine(d?.symbol, 24).replace(/^\$+/, "").toLowerCase()) parts.push(name);
  const mcap = usd(d?.mcapUsd);
  if (mcap) parts.push(`mcap ${mcap}`);
  const kids = Number.isInteger(d?.children) && d.children >= 0 ? d.children : null;
  const all = Number.isInteger(d?.descendants) && d.descendants > (kids ?? 0) ? d.descendants : null;
  if (kids === 0) parts.push("no children yet");
  else if (kids != null && isTop(d)) parts.push(underIt(all ?? kids)); // the card's family line says this number the same way
  else if (kids != null) { parts.push(plural(kids, "child", "children")); if (all != null) parts.push(plural(all, "descendant", "descendants")); }
  // dust under a cent is not worth a part ("< $0.01 locked" says nothing)
  const locked = d?.lockedUsd >= 0.01 ? usd(d.lockedUsd) : null;
  if (locked) parts.push(`${locked} locked`);
  if (d?.firstborn && d.parent) parts.push(`first child of ${tickerOf(d.parent)}`);
  else if (d?.firstborn && d.root) parts.push(`first coin quoted in ${tickerOf(d.root)}`);
  const share = pctOf(d?.family?.sharePct);
  if (share) parts.push(isTop(d) || !d.family?.top ? `${share} of the ${SITE} map` : `${tickerOf(d.family.top)} family holds ${share} of the map`);
  const chain = Array.isArray(d?.chain) && d.chain.length ? d.chain.map((c) => tickerOf(c)) : Array.isArray(d?.lineage) ? d.lineage : [];
  if (chain.length > 2) parts.push(chain.map((t) => oneLine(t, 26)).join(" › "));
  if (!parts.length) parts.push(`A coin on ${SITE}, the pump.fun family-tree launchpad.`);
  return oneLine(parts.join(" · "), DESCRIPTION_MAX);
}
/** The card URL with the minute as a version: `<publicUrl>/card/<mint>.png?v=<minute>` (outside /api/, which robots.txt closes to crawlers). */
export function ogImageUrl(d, { publicUrl = DEFAULT_PUBLIC_URL, now = Date.now() } = {}) {
  return `${trimSlash(publicUrl)}/card/${d.mint}.png?v=${Math.floor(now / OG_IMAGE_VERSION_MS)}`;
}
/**
 * The canonical form of the pasted link: the map link stays a map link (`/map?focus=<mint>`), anything
 * else is the coin page (`/c/<mint>`). Extra query parameters never reach the tags, so two shares of
 * the same coin unfurl as one object and nothing from the URL is echoed back into the page.
 */
export function ogPath(path, mint) {
  const p = String(path ?? "").split("?")[0];
  return /^\/map\/?$/.test(p) ? `/map?focus=${mint}` : `/c/${mint}`;
}
const trimSlash = (u) => String(u ?? DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
const meta = (attr, key, value) => `    <meta ${attr}="${key}" content="${escapeAttr(value)}" />`;

/** The whole og:/twitter: block for one coin, as index.html lines (4-space indent), every value escaped. */
export function ogTags(d, { publicUrl = DEFAULT_PUBLIC_URL, path = "/", now = Date.now() } = {}) {
  const title = ogTitle(d), description = ogDescription(d), image = ogImageUrl(d, { publicUrl, now });
  const url = `${trimSlash(publicUrl)}${ogPath(path, d.mint)}`;
  const alt = oneLine(`Family map of ${tickerOf(d)} on ${SITE}: ${description}`, ALT_MAX);
  return [
    meta("property", "og:site_name", SITE),
    meta("property", "og:type", "website"),
    meta("property", "og:locale", "en_US"),
    meta("property", "og:url", url),
    meta("property", "og:title", title),
    meta("property", "og:description", description),
    meta("property", "og:image", image),
    meta("property", "og:image:type", "image/png"),
    meta("property", "og:image:width", String(OG_IMAGE_W)),
    meta("property", "og:image:height", String(OG_IMAGE_H)),
    meta("property", "og:image:alt", alt),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:title", title),
    meta("name", "twitter:description", description),
    meta("name", "twitter:image", image),
    meta("name", "twitter:image:alt", alt),
  ].join("\n");
}

/** Replaces what lies between the markers with `tags` (markers kept); the html unchanged when either marker is missing or out of order. */
export function injectOg(html, tags) {
  const s = html.indexOf(OG_START);
  if (s < 0) return html;
  const e = html.indexOf(OG_END, s + OG_START.length);
  if (e < 0) return html;
  return `${html.slice(0, s + OG_START.length)}\n${tags}\n    ${html.slice(e)}`;
}

/** The mint a page request is about: GET/HEAD /c/<mint> or /map?focus=<mint> (base58, 32-44 chars); null for every other request. */
export function cardMintFor(req) {
  if (req?.method !== "GET" && req?.method !== "HEAD") return null;
  const path = String(req.path ?? "");
  const coin = /^\/c\/([^/]+)\/?$/.exec(path);
  if (coin) return MINT_RE.test(coin[1]) ? coin[1] : null;
  if (!/^\/map\/?$/.test(path)) return null;
  const focus = req.query?.focus;
  return typeof focus === "string" && MINT_RE.test(focus) ? focus : null;
}
