// The coin page's "Launch a child" fill: what a pasted link is, and a name and ticker suggested from a post's words.
// Deterministic (no model call), pure, tested in test/launch-fill.test.mts. The user edits everything afterwards.
//
// - An X post link (x.com / twitter.com and their www. / mobile. / m. hosts; <handle>/status/<id>, statuses,
//   i/status, i/web/status): its id, which the server's GET /api/post-fill turns into the post's handle and text. X's
//   embed API gives no image, so a post fills the name and the ticker only.
// - An https link to an image file (.png .jpg .jpeg .gif .webp): recognised, but not fetched. The page's security
//   policy lets the browser load images from Spore only, and the server has no fetch of arbitrary images (that would
//   be a new outbound fetcher on Spore's server, the owner's call). The card asks for the file instead.
// - Anything else: not a link it can use.

export type FillLink = { kind: "post"; id: string } | { kind: "image"; url: string } | { kind: "none" };

const POST_HOSTS = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.x.com", "mobile.twitter.com", "m.x.com", "m.twitter.com"]);
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const ID_RE = /^[1-9][0-9]{0,18}$/;
const ID_MAX = 9223372036854775807n;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
/// The longest text taken as a link (the server takes 300 characters).
export const FILL_URL_MAX = 300;

export function parseFillLink(raw: unknown): FillLink {
  if (typeof raw !== "string") return { kind: "none" };
  const t = raw.trim();
  if (!t || t.length > FILL_URL_MAX || /\s/.test(t)) return { kind: "none" };
  let u: URL;
  try { u = new URL(t); } catch { return { kind: "none" }; }
  if (u.username || u.password || u.port) return { kind: "none" };
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if ((u.protocol === "https:" || u.protocol === "http:") && POST_HOSTS.has(host)) {
    const seg = u.pathname.split("/").filter(Boolean);
    let id: string | null = null;
    if (seg.length >= 4 && seg[0] === "i" && seg[1] === "web" && seg[2] === "status") id = seg[3];
    else if (seg.length >= 3 && HANDLE_RE.test(seg[0]) && (seg[1] === "status" || seg[1] === "statuses")) id = seg[2];
    if (id != null && ID_RE.test(id) && BigInt(id) <= ID_MAX) return { kind: "post", id };
    return { kind: "none" };
  }
  if (u.protocol === "https:" && IMAGE_EXT_RE.test(u.pathname)) return { kind: "image", url: u.toString() };
  return { kind: "none" };
}

export const NAME_MAX = 32;
export const SUGGEST_TICKER_MAX = 10;

/// A short clean name from a post: its first line or sentence, without links, @mentions, the # of hashtags, emoji and
/// symbols, cut on a word boundary to at most NAME_MAX characters (UTF-16 units, as the form counts them; never half a
/// letter: styled letters such as math bold are first folded to plain ones, NFKC). Empty text (a post of media only, a blocked word):
/// the author's handle. "" when there is nothing usable.
export function nameFromPost(text: string | null | undefined, handle?: string | null): string {
  let t = String(text ?? "").normalize("NFKC")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bpic\.twitter\.com\/\S+/gi, " ")
    .replace(/(^|\s)@[A-Za-z0-9_]+/g, " ")
    .replace(/#(?=[\p{L}\p{N}])/gu, "");
  // the first line or sentence that has letters in it
  const parts = t.split(/[\n\r]+|(?<=[.!?])\s+/).map((s) => clean(s)).filter((s) => /[\p{L}\p{N}]/u.test(s));
  t = parts[0] ?? "";
  if (!t) t = clean(String(handle ?? "").normalize("NFKC").replace(/_/g, " "));
  return cut(t, NAME_MAX);
}
const clean = (s: string) => s.replace(/[^\p{L}\p{N}' &-]+/gu, " ").replace(/\s+/g, " ").trim().replace(/^[-'& ]+|[-'& ]+$/g, "");
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  // no space to cut on: cut by units, without leaving a lone high surrogate (half of an astral letter) at the end
  return (at > 0 ? head.slice(0, at) : s.slice(0, max).replace(/[\uD800-\uDBFF]$/, "")).trim();
}

/// A ticker from a name: up to SUGGEST_TICKER_MAX uppercase letters and digits (A-Z, 0-9 only). The words joined when
/// they fit; else, with three words or more, their initials; else the joined words cut. "" for a name with none.
export function tickerFromName(name: string | null | undefined): string {
  const words = String(name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (!words.length) return "";
  const joined = words.join("");
  if (joined.length <= SUGGEST_TICKER_MAX) return joined;
  if (words.length >= 3) return words.map((w) => w[0]).join("").slice(0, SUGGEST_TICKER_MAX);
  return joined.slice(0, SUGGEST_TICKER_MAX);
}
