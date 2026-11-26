// The pieces of a Discover entry that say what it is about (pages/Discover.tsx draws them): the "Subject: what
// happened" line with its chips and its opened body (SubjectLineBlock), and a coin row's own chips and its one muted
// line (RowTags: the "Open post" link of a single coin with nothing to say, its "under $PARENT" mark). Kept apart from
// the page so they can be rendered on their own (test/discover-line.test.mts): no stylesheet, no wallet, no trade.
// Every class starts with "dsc-" (components/dsc.css, loaded by the page). Every text is a stranger's or a model's:
// React text nodes only. The pragma gives tsx (the tests, which read the root tsconfig without `jsx`) the build's JSX runtime.
/** @jsxRuntime automatic */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  COPIES_TITLE, LEFT_PILL, LINE_NOTE, MOVED_PILL, MOVED_TITLE, NEW_ROW_PILL, NEW_ROW_TITLE, NO_POST_TEXT, TAG_NOTE,
  cardPostHref, copiesMark, dustChip, narrativeOf, narrativeTitle, parentTag,
  type StoryShown, type SubjectLine,
} from "../lib/discover";
import type { StoryCard } from "../lib/api";
import { NARRATIVE_FOOT } from "../lib/narrative";

const mapLink = (mint: string) => `/map?focus=${encodeURIComponent(mint)}`;
/// What the link to a post says, on a plain row and in an opened line.
export const OPEN_POST = "Open post";
/// A single coin with nothing to say (no subject line): what its plain row shows under the name (RowTags `sub`), a
/// link to the post its card links, rebuilt from the post's id; nothing without a post.
export const plainRowSub = (card: Pick<StoryCard, "post"> | null | undefined): { text: string; href: string } | undefined => {
  const href = cardPostHref(card);
  return href ? { text: OPEN_POST, href } : undefined;
};

export const XIcon = <svg className="dsc-x" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.9L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" /></svg>;

/// A row's own chips: "No longer listed" for a row kept only while the page is in use (the dimming alone says nothing
/// to a screen reader; "Moved to another story" when the coin is still listed elsewhere), "this hour" on a narrative
/// story's coin created 30-60 minutes ago (newRowPill; a younger one's "new" tag already says it), "×3 copies" on a row others are folded under, why a dust row is dust, and
/// its parent (on the map) where the list mixes parents.
/// `story`: the row also names its narrative (a single coin while narratives are shown): the title as a small muted
/// tag, a text node cut to one line. `sub`: a single coin's post or family, one muted line under its name.
/// `theme`: the row also names its story's theme (a single coin under its subject line, which already says the story):
/// one small muted tag, a model's word.
export function RowTags({ r, parent, story, fresh, sub, theme }: { r: StoryShown; parent: boolean; story?: boolean; fresh?: boolean; sub?: { text: string; href: string | null } | null; theme?: string }) {
  const tag = parent ? parentTag(r) : null, copies = copiesMark(r), dust = dustChip(r.reason), nar = story ? narrativeOf(r) : null;
  const line = sub && sub.text ? (
    <span className="dsc-csub">
      {sub.href
        ? <a href={sub.href} target="_blank" rel="noopener noreferrer" title={`Open the post on X. ${NARRATIVE_FOOT}`}>{XIcon}<span>{sub.text}</span></a>
        : <span>{sub.text}</span>}
    </span>
  ) : null;
  if (!tag && !copies && !dust && !r.left && !nar && !fresh && !theme) return line;
  return (
    <>
      {line}
      <span className="dsc-ptags">
        {fresh && <span className="dsc-pill sm dsc-newp" title={NEW_ROW_TITLE}>{NEW_ROW_PILL}</span>}
        {theme && <span className="dsc-st-ntag" title={TAG_NOTE}><span className="dsc-vh">Theme: </span>{theme}</span>}
        {nar && <span className="dsc-st-ntag" title={TAG_NOTE}><span className="dsc-vh">Story: </span>{narrativeTitle(nar.title)}</span>}
        {r.left && (r.moved
          ? <span className="dsc-pill sm st-left" title={MOVED_TITLE}>{MOVED_PILL}</span>
          : <span className="dsc-pill sm st-left" title="The server stopped listing this coin; the row goes once the page is idle">{LEFT_PILL}</span>)}
        {dust && <span className="dsc-chip" title={dust.title}>{dust.text}</span>}
        {copies && <span className="dsc-chip" title={COPIES_TITLE}>{copies}</span>}
        {tag && r.parent && <Link className="dsc-ptag" to={mapLink(r.parent.mint)} title={`${tag.replace(/^under /, "")} and the coins under it on the map`}>{tag}</Link>}
      </span>
    </>
  );
}

/// The "Subject: what happened" line (lib/discover.ts subjectLine), the same on a single coin's card and in a story's
/// header: the subject in the accent with a colon, then the sentence in ink (two lines at most, never cut to one with
/// an ellipsis); on the right, small and muted, the "AI" badge of a model-written line, the chips that say where it
/// came from ("via quoted post @handle", "quoted post from 2024", "post does not name this coin", "AI group", "no
/// post": facts about our own data, kept out of the sentence), who posted and how long ago (an outlined chip for a post
/// older than a week); on a phone that sits on its own short line under the sentence. With a post the line is the
/// summary of a native <details>: hovering shows the poster's own words, a click, a tap or Enter opens them in full,
/// and the post it quotes under them, each with its handle and a link to the post on X (rebuilt from the id); a
/// model-written line also carries the note that a model wrote the summary. Without a post there is nothing to open
/// and it is plain text. Every text is a stranger's or a model's: React text nodes only.
/// `pill`: a state pill drawn before the subject (a story that left the read).
export function SubjectLineBlock({ L, pill }: { L: SubjectLine; pill?: ReactNode }) {
  const cls = `dsc-ln${L.tone === "personal" ? " dsc-ln-personal" : L.tone === "light" ? " dsc-ln-light" : ""}${L.quote ? " dsc-ln-quote" : ""}`;
  const inner = (
    <>
      <span className="dsc-ln-t">
        {pill}
        <b className="dsc-ln-s">{L.subject}:</b>{" "}
        <span className="dsc-ln-h">{L.quote ? `“${L.happened}”` : L.happened}</span>
      </span>
      {(L.badge || L.chips.length > 0 || L.who || L.when || L.old) && (
        <span className="dsc-ln-m">
          {L.badge && <span className="dsc-ln-ai" title={L.badge.title}>{L.badge.text}<span className="dsc-vh">: {L.badge.title}</span></span>}
          {L.chips.map((c) => <span key={c.text} className="dsc-ln-chip" title={c.title}>{c.text}<span className="dsc-vh">: {c.title}</span></span>)}
          {L.who && <span className="dsc-ln-who">{L.who}</span>}
          {L.old ? <span className="dsc-ln-old" title="How old the linked post is">{L.old}</span> : L.when && <span className="dsc-ln-when">{L.when}</span>}
        </span>
      )}
    </>
  );
  if (!L.href && !L.words && !L.quoted) return <div className={cls}><div className="dsc-ln-sum">{inner}</div></div>;
  const open = (href: string | null) => href && <a className="dsc-link" href={href} target="_blank" rel="noopener noreferrer" title={`Open the post on X. ${NARRATIVE_FOOT}`}>{XIcon}{OPEN_POST}</a>;
  const words = (w: string | null) => (w ? <p className="dsc-ln-words">{w}</p> : <p className="dsc-ln-words dsc-ln-nowords">{NO_POST_TEXT}</p>);
  const Q = L.quoted;
  return (
    <details className={cls}>
      <summary className="dsc-ln-sum" title={L.words ? `${L.who ? `${L.who}: ` : ""}${L.words}` : undefined}>{inner}</summary>
      <div className="dsc-ln-body">
        {Q ? (
          <>
            {/* two posts: the starting post, then the post it quotes, each under who wrote it and with its own link */}
            <div className="dsc-ln-post">
              <p className="dsc-ln-by">{["Starting post", L.who, L.old ?? L.when].filter(Boolean).join(" · ")}</p>
              {words(L.words)}
              {L.href && <p className="dsc-ln-foot">{open(L.href)}</p>}
            </div>
            <div className="dsc-ln-post">
              <p className="dsc-ln-by">{["Quoted post", Q.who, Q.old ?? Q.when].filter(Boolean).join(" · ")}</p>
              {words(Q.words)}
              {Q.href && <p className="dsc-ln-foot">{open(Q.href)}</p>}
            </div>
            {L.auto && <p className="dsc-ln-foot"><span>{LINE_NOTE}</span></p>}
          </>
        ) : (
          <>
            {words(L.words)}
            <p className="dsc-ln-foot">
              {L.auto && <span>{LINE_NOTE}</span>}
              {open(L.href)}
            </p>
          </>
        )}
      </div>
    </details>
  );
}
