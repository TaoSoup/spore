// The parts the map panel (map/panel/NarrativeBlock.tsx) and the coin page (coin/CoinNarrative.tsx) build their linked
// posts from: one post as a row, the coins linking it as chips, the caption over the first row. Everything from the
// body is rendered as plain React text; the link to a post is rebuilt from its id (lib/narrative.ts safePostUrl), never
// taken from the body. A row keeps its height from the moment it is mounted: the text area always holds exactly
// `lines` lines (bars while the text is fetched, the text, or nothing), so a text arriving later moves nothing.
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { NarrativeCoin, NarrativeOwn, NarrativePost } from "../../lib/api";
import { ago } from "../../lib/format";
import { CAPTION_OWN, chipSym, chipVol, familyCaption, postHandle, postLinkAria, postLinkText, postStat, postStatTitle, postText, safePostUrl, type NarrativeLead } from "../../lib/narrative";
import { Logo, Skeleton, nameOf, sym } from "../Bits";
import "./narrative.css";

/// With `onPick` the coins are buttons that select on the map (and light their bubble while pointed at); without it
/// they are links to the coin's page.
type Picks = { onPick?: (mint: string) => void; onHover?: (mint: string | null) => void };

/// Up to three coins linking a post: logo, ticker, 24 h volume. Nothing for an empty list.
export function CoinChips({ coins, onPick, onHover }: { coins: NarrativeCoin[] } & Picks) {
  const top = Array.isArray(coins) ? coins.slice(0, 3) : [];
  if (top.length === 0) return null;
  return (
    <div className="nar-chips">
      {top.map((c) => {
        const vol = chipVol(c);
        const body = <><Logo src={c.image} label={c.symbol} size={16} /><b>{chipSym(c)}</b>{vol && <span>{vol}</span>}</>;
        // picked whether or not the coin is drawn: the page's select handles a coin the map does not show
        return onPick
          ? <button type="button" key={c.mint} className="nar-chip" title={nameOf(c)} onClick={() => onPick(c.mint)} onMouseEnter={() => onHover?.(c.mint)} onFocus={() => onHover?.(c.mint)} onMouseLeave={() => onHover?.(null)} onBlur={() => onHover?.(null)}>{body}</button>
          : <Link key={c.mint} to={`/c/${c.mint}`} className="nar-chip" title={nameOf(c)}>{body}</Link>;
      })}
    </div>
  );
}

/// One post. Line 1: the link out (the author when the text is known, else "View post") and the post's age; with
/// `stat`, the coins linking it and their 24 h volume on the right. Line 2: the text, clamped to `lines` lines.
/// `note`: one quiet line under the text. Line 3: the coins.
export function PostRow({ post, stat = false, lines, note = null, onPick, onHover }: { post: NarrativePost | NarrativeOwn; stat?: boolean; lines: number; note?: string | null } & Picks) {
  const href = safePostUrl(post.id);
  const handle = postHandle(post);
  const text = postText(post);
  return (
    <div className="nar-row">
      <div className="nar-top">
        {href
          ? <a className="nar-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={handle ? undefined : postLinkAria(post)}>{postLinkText(post)}</a>
          : <span className="nar-link">{handle ? `@${handle}` : "Post"}</span>}
        {typeof post.at === "number" && <span className="nar-at">· {ago(post.at)}</span>}
        {stat && "coins" in post && <span className="nar-stat mono" title={postStatTitle(post)}>{postStat(post)}</span>}
      </div>
      <div className="nar-text" style={{ "--nar-lines": String(lines) } as CSSProperties} aria-busy={post.state === "wait" || undefined}>
        {post.state === "wait"
          ? Array.from({ length: lines }, (_, i) => <Skeleton key={i} h={10} w={i === lines - 1 && lines > 1 ? "62%" : "100%"} />)
          : text ? <p>{text}</p> : null}
      </div>
      {note && <p className="nar-note">{note}</p>}
      <CoinChips coins={post.top} onPick={onPick} onHover={onHover} />
    </div>
  );
}

/// The small line over the first row, saying whose link it is: the coin's own, its children's (`label`: the coin's
/// ticker), or its parent's (the parent is a button on the map, a link on the coin page).
export function LeadCaption({ lead, label, onPick, title }: { lead: NarrativeLead; label: string; onPick?: (mint: string) => void; title?: string }) {
  if (lead.kind === "own") return <p className="nar-cap" title={title}>{CAPTION_OWN}</p>;
  if (lead.kind === "family") return <p className="nar-cap" title={title}>{familyCaption(label)}</p>;
  const p = lead.parent;
  return (
    <p className="nar-cap nar-cap-pick" title={title}>
      Under {onPick
        ? <button type="button" className="linkish" onClick={() => onPick(p.mint)} title={`Select ${nameOf(p)}`}>{sym(p)}</button>
        : <Link to={`/c/${p.mint}`} className="linkish" title={nameOf(p)}>{sym(p)}</Link>}
    </p>
  );
}
