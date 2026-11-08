// Share texts and links (DESIGN §8 "Share cards"): what a user posts on X from the map's side panel,
// the coin page and the launch success screen. The link travels apart from the text in the intent URL
// and unfurls as the coin's own card (server `/api/card/<mint>.png`), so the text carries what the
// card cannot: one sentence that says where the coin sits in its family. One builder (coinShareText)
// over a flat fact record; the map and the coin page adapt their records to it, so both surfaces say
// the same thing about the same coin. Unknown parts are left out, never written as "—" or "null".
// Force layouts differ per browser, so a shared map view is anchored by mint: `/map?focus=<mint>`
// selects the coin and frames it with its parent and children.
import { count, short, usd } from "../format";
import type { Coin } from "../api";
import { DOM_WORDS, sharePct } from "./dominance";
import type { BubbleNode, SizeMode } from "./types";

const SITE = "https://sporepad.com";
/// X counts the text apart from the link; 200 characters keep the post readable above the card.
export const SHARE_MAX = 200;
/// A coin named only by a long name (no ticker) is cut so the sentence stays a sentence.
const NAME_MAX = 24;
const TAIL = "Live family tree:";

export function mapLink(mint: string, origin?: string): string {
  const o = origin ?? (typeof location !== "undefined" && /^https?:$/.test(location.protocol) ? location.origin : SITE);
  return `${o.replace(/\/$/, "")}/map?focus=${encodeURIComponent(mint)}`;
}

/// The least a coin needs to be named in a post: `$TICKER`, else its name, else a short mint.
export type ShareRef = { mint: string; symbol: string | null; name?: string | null };
export type ShareFacts = {
  self: ShareRef & { depth: number };
  /// The coin it is quoted in; null for a family top, or when the map does not know the parent.
  parent: ShareRef | null;
  /// The family top (the depth-0 root, or a listed asset such as $PUMP); null when `self` is the top.
  root: ShareRef | null;
  /// The first child launched under its parent (lib/map/firstborn). The coin page does not know: false.
  firstborn?: boolean;
  children: number; descendants?: number | null;
  lockedUsd: number | null; mcapUsd?: number | null;
  /// A top's family dominance (lib/map/dominance): its share 0..1 of the whole map in a size mode.
  dominance?: { share: number; mode: SizeMode } | null;
};

const pos = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
export const tick = (r: ShareRef): string => {
  if (r.symbol) return `$${r.symbol.replace(/^\$+/, "")}`;
  const name = r.name?.trim();
  if (name) return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
  return short(r.mint);
};

/// `head — fact, fact. Live family tree:`; without facts the dash goes too.
const sentence = (head: string, facts: readonly string[]) => `${head}${facts.length ? ` — ${facts.join(", ")}` : ""}. ${TAIL}`;
/// The first variant that fits SHARE_MAX (long names, five-digit counts); the last one is cut as a last resort.
const fit = (variants: readonly string[]): string => {
  const ok = variants.find((v) => v.length <= SHARE_MAX);
  if (ok) return ok;
  const last = variants[variants.length - 1];
  return `${last.slice(0, SHARE_MAX - TAIL.length - 3)}… ${TAIL}`;
};

/// The post for a coin. A child: "$KID, first child under $PARENT in the $ROOT family — 12 children,
/// $5.2K locked. Live family tree:" ("first child" only when the firstborn set says so; the family
/// clause only when the parent is not the top itself; a leaf with nothing locked shows its market
/// cap instead). A top: "$ROOT family on Spore — 1,352 coins under it, $120K locked, 41% of all locked
/// value on the map. Live family tree:"; a top with nothing under it says what it is for.
export function coinShareText(f: ShareFacts): string {
  const t = tick(f.self);
  if (f.parent) {
    const under = `${f.firstborn ? ", first child under " : " under "}${tick(f.parent)}`;
    const family = f.root && f.root.mint !== f.parent.mint && f.root.mint !== f.self.mint ? ` in the ${tick(f.root)} family` : "";
    const facts: string[] = [];
    if (pos(f.children)) facts.push(plural(f.children, "child", "children"));
    if (pos(f.lockedUsd)) facts.push(`${usd(f.lockedUsd)} locked`);
    if (!facts.length && pos(f.mcapUsd)) facts.push(`${usd(f.mcapUsd)} mcap`);
    return fit([sentence(`${t}${under}${family}`, facts), sentence(`${t}${under}`, facts), sentence(`${t}${under}`, [])]);
  }
  const below = pos(f.descendants) ? f.descendants : f.children;
  if (pos(below)) {
    const facts = [`${plural(below, "coin", "coins")} under it`];
    if (pos(f.lockedUsd)) facts.push(`${usd(f.lockedUsd)} locked`);
    const d = f.dominance;
    if (d && pos(d.share)) facts.push(`${sharePct(d.share)} ${DOM_WORDS[d.mode]} on the map`);
    return fit([sentence(`${t} family on Spore`, facts), sentence(`${t} family on Spore`, facts.slice(0, 1))]);
  }
  const head = `${t} on Spore${pos(f.mcapUsd) ? ` (${usd(f.mcapUsd)} mcap)` : ""}`;
  return fit([sentence(head, f.self.depth === 0 ? ["a root new coins can launch under"] : []), sentence(`${t} on Spore`, [])]);
}

/// The map's side panel: the node, its parent and its family top from the node set, "1st" from the
/// firstborn set, the family's dominance row when the node is the top.
export function shareText(n: BubbleNode, parent: BubbleNode | null, o: { root?: BubbleNode | null; firstborn?: boolean; dominance?: ShareFacts["dominance"] } = {}): string {
  return coinShareText({
    self: n, parent, root: o.root && o.root.mint !== n.mint ? o.root : null, firstborn: o.firstborn === true,
    children: n.children, descendants: n.descendants, lockedUsd: n.lockedUsd, mcapUsd: n.mcapUsd, dominance: o.dominance ?? null,
  });
}

/// The coin page: the same sentence from the server's coin view (`parent` and `root` are its refs; a
/// depth-0 coin has neither and reads as a top). The page has no firstborn set, so never "first child".
export function coinPageShareText(c: Coin): string {
  return coinShareText({ self: c, parent: c.parent, root: c.root, children: c.children, descendants: c.descendants, lockedUsd: c.lockedUsd, mcapUsd: c.mcapUsd });
}

/// The launch success screen: the creator's own post. A child names the parent every buy routes
/// through (its quote on pump.fun); a root says what it is for. The coin link follows the text.
export function launchShareText(symbol: string, parent: ShareRef | null): string {
  const tag = tick({ mint: "", symbol, name: null });
  if (!parent) return `I just launched ${tag} on Spore — a pump.fun root new coins can grow under. Family tree:`;
  const p = tick(parent);
  return fit([`I just launched ${tag} under ${p} on Spore — every buy routes through ${p}. Family tree:`, `I just launched ${tag} under ${p} on Spore. Family tree:`]);
}
