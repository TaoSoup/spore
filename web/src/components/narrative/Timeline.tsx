// The launch timeline the map panel (map/panel/NarrativeBlock.tsx), the coin page (coin/CoinNarrative.tsx) and the
// Discover page (pages/Discover.tsx) share: one event a line, newest first. A line is one fixed height: the time, a
// dot on the rail, "3 coins · @handle · the post's text" cut with an ellipsis, and the top coin as a chip. While the
// post's text is fetched the line shows the coin count alone, and the text fills in without moving anything. A click
// opens the line in place (the whole text, the link out, up to three coins); one line is open at a time. While a line
// is open, or the pointer or the keyboard is on the list, a new read adds no line (lib/narrative.ts heldLines): the
// lines on screen stay where they are and the new ones come once the list is left. Everything
// from the body is rendered as plain React text; the link to a post is rebuilt from its id (lib/narrative.ts
// safePostUrl), never taken from the body.
import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { NarrativeCoin, NarrativeEvent, NarrativeOwn } from "../../lib/api";
import { useTick } from "../../lib/hooks";
import { NARRATIVE_FOOT, POST_LINK, chipSym, chipVol, earlierNote, heldLines, lineAge, lineChip, lineParts, lineText, moreText, othersLine, postLinkAria, postText, safePostUrl, shownLines } from "../../lib/narrative";
import { Logo, Skeleton, nameOf, sym } from "../Bits";
import "./narrative.css";

/// With `onPick` the coins are buttons that select on the map (and light their bubble while pointed at); without it
/// they are links to the coin's page.
export type Picks = { onPick?: (mint: string) => void; onHover?: (mint: string | null) => void };

/// One coin linking a post: logo, ticker, 24 h volume.
export function CoinChip({ coin: c, onPick, onHover }: { coin: NarrativeCoin } & Picks) {
  const vol = chipVol(c);
  const body = <><Logo src={c.image} label={c.symbol} size={16} /><b>{chipSym(c)}</b>{vol && <span>{vol}</span>}</>;
  // picked whether or not the coin is drawn: the page's select handles a coin the map does not show
  return onPick
    ? <button type="button" className="nar-chip" title={nameOf(c)} onClick={() => onPick(c.mint)} onMouseEnter={() => onHover?.(c.mint)} onFocus={() => onHover?.(c.mint)} onMouseLeave={() => onHover?.(null)} onBlur={() => onHover?.(null)}>{body}</button>
    : <Link to={`/c/${c.mint}`} className="nar-chip" title={nameOf(c)}>{body}</Link>;
}
/// Up to three coins linking a post. Nothing for an empty list.
export function CoinChips({ coins, onPick, onHover }: { coins: NarrativeCoin[] } & Picks) {
  const top = Array.isArray(coins) ? coins.slice(0, 3) : [];
  if (top.length === 0) return null;
  return <div className="nar-chips">{top.map((c) => <CoinChip key={c.mint} coin={c} onPick={onPick} onHover={onHover} />)}</div>;
}

/// One line and, when open, what is behind it. `at`: the time the line shows (an event: its first coin; a coin's own
/// post: the post). `chips`: whether the opened line lists the coins (an own post lists them under the line instead).
function Line({ post, at, open, onToggle, chips = true, onPick, onHover }: { post: NarrativeEvent | NarrativeOwn; at: number | null; open: boolean; onToggle: () => void; chips?: boolean } & Picks) {
  const id = useId();
  const { lead, handle, text } = lineParts(post);
  const chip = "coins" in post ? lineChip(post) : null;
  const href = safePostUrl(post.id);
  const full = postText(post);
  return (
    <li className="nar-item">
      <div className="nar-line">
        <button type="button" className="nar-line-btn" aria-expanded={open} aria-controls={open ? id : undefined} title={open ? undefined : lineText(post)} onClick={onToggle}>
          <span className="nar-age mono">{lineAge(at)}</span>
          <i className="nar-dot" aria-hidden="true" />
          <span className="nar-say" aria-busy={post.state === "wait" || undefined}>
            {lead && <b>{lead}</b>}{handle && <span className="nar-handle">{handle}</span>}{text && <span>{text}</span>}
          </span>
        </button>
        {chip && <CoinChip coin={chip} onPick={onPick} onHover={onHover} />}
      </div>
      {open && (
        <div className="nar-open" id={id}>
          {post.state === "wait" ? <Skeleton h={10} w="62%" /> : full ? <p className="nar-full">{full}</p> : null}
          <div className="nar-open-foot">
            {href && <a className="nar-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={postLinkAria("coins" in post ? post.coins : null)}>{POST_LINK}</a>}
            {chips && <CoinChips coins={post.top} onPick={onPick} onHover={onHover} />}
          </div>
        </div>
      )}
    </li>
  );
}

/// One line on its own (a coin's own post, or its parent's newest event), opened and closed by itself.
export function SoloLine({ post, at, chips = true, onPick, onHover }: { post: NarrativeEvent | NarrativeOwn; at: number | null; chips?: boolean } & Picks) {
  // open for one post: another coin's line starts closed
  const [openId, setOpenId] = useState<string | null>(null);
  useTick(30_000);
  return <ol className="nar-list"><Line post={post} at={at} chips={chips} open={openId === post.id} onToggle={() => setOpenId((o) => (o === post.id ? null : post.id))} onPick={onPick} onHover={onHover} /></ol>;
}

/// A coin's own post: its line, then the other coins under the same parent linking the same post.
export function OwnPost({ own, onPick, onHover }: { own: NarrativeOwn } & Picks) {
  const others = othersLine(own);
  return (
    <>
      <SoloLine post={own} at={own.at} chips={false} onPick={onPick} onHover={onHover} />
      {others && <div className="nar-others"><span className="nar-note">{others}</span><CoinChips coins={own.top} onPick={onPick} onHover={onHover} /></div>}
    </>
  );
}

/// "Under $PARENT", over the parent's newest event (the parent is a button on the map, a link on the coin page).
export function UnderCaption({ parent: p, onPick, title }: { parent: { mint: string; name: string | null; symbol: string | null }; onPick?: (mint: string) => void; title?: string }) {
  return (
    <p className="nar-cap nar-cap-pick" title={title}>
      Under {onPick
        ? <button type="button" className="linkish" onClick={() => onPick(p.mint)} title={`Select ${nameOf(p)}`}>{sym(p)}</button>
        : <Link to={`/c/${p.mint}`} className="linkish" title={nameOf(p)}>{sym(p)}</Link>}
    </p>
  );
}

type Props = {
  /// The coin the events are for: what is open belongs to one coin, another coin's list starts collapsed.
  mint: string;
  events: NarrativeEvent[]; earlier: number;
  /// Lines shown before "Show N more".
  collapsed: number;
  /// The start of the first line (a caption, a card's heading, quiet links); "Show N more" sits at its right end.
  head?: ReactNode;
  /// "always": the note on who picked the posts is under the list; "open": only once a line or the list is opened
  /// (the map panel, where the collapsed block is kept small).
  foot?: "always" | "open";
} & Picks;

export function Timeline({ mint, events, earlier, collapsed, head = null, foot = "always", onPick, onHover }: Props) {
  // which line is open and whether the list is; kept with the coin it is for
  const [st, setSt] = useState<{ mint: string; open: string | null; all: boolean }>({ mint, open: null, all: false });
  const cur = st.mint === mint ? st : { mint, open: null, all: false };
  // the ages move on without a new answer
  useTick(30_000);
  // the pointer is over the list / the keyboard is in it
  const [over, setOver] = useState(false);
  const [within, setWithin] = useState(false);
  // the events as last drawn: while the list is in use they are the ones a new read is laid over, so none is added
  const drawn = useRef<{ mint: string; events: NarrativeEvent[] } | null>(null);
  const all = heldLines(events, (cur.open !== null || over || within) && drawn.current?.mint === mint ? drawn.current.events : null);
  drawn.current = { mint, events: all };
  const { lines, more } = shownLines(all, collapsed, cur.all);
  const few = shownLines(all, collapsed, false).lines;
  // the list has more lines than it shows collapsed: "Show N more", or "Show less" once opened
  const can = more > 0 || cur.all && lines.length > few.length;
  // a line closed with the list (it is behind "Show N more" again) is not left open
  const open = cur.open !== null && lines.some((e) => e.id === cur.open) ? cur.open : null;
  const note = more === 0 ? earlierNote(earlier) : null;
  return (
    <div className="nar-tl">
      {(head || can) && (
        <div className="nar-head">
          {head ?? <span />}
          {can && <button type="button" className="nar-more linkish" aria-expanded={cur.all} onClick={() => setSt({ mint, open: cur.all && !few.some((e) => e.id === open) ? null : open, all: !cur.all })}>{cur.all ? "Show less" : moreText(more)}</button>}
        </div>
      )}
      <ol className="nar-list" onPointerEnter={() => setOver(true)} onPointerLeave={() => setOver(false)} onFocus={(e) => { if ((e.target as Element).matches(":focus-visible")) setWithin(true); }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setWithin(false); }}>
        {lines.map((e) => <Line key={e.id} post={e} at={e.at} open={open === e.id} onToggle={() => setSt({ mint, all: cur.all, open: open === e.id ? null : e.id })} onPick={onPick} onHover={onHover} />)}
      </ol>
      {note && <p className="nar-note">{note}</p>}
      {(foot === "always" || open !== null || cur.all) && <p className="nar-foot">{NARRATIVE_FOOT}</p>}
    </div>
  );
}
