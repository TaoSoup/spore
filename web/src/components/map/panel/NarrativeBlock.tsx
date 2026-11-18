// The map panel's linked posts (lib/narrative.ts, components/narrative/): the X posts the selected coin, or the coins
// under it, link in their metadata. Collapsed it is ONE post with a small caption, and its height does not change once
// it is mounted (the row reserves its lines; a poll fills texts in and moves nothing). "Show N more", at the right of
// the caption's line, opens the other posts, the words many of the names share, and the line saying who picked the
// posts; open, it reads "Show less". While another coin's answer
// loads (`stale`) the block stays where it is, dimmed and inert, so the panel does not jump twice. Nothing renders
// for a coin without posts.
import { useEffect, useRef, useState } from "react";
import type { Narrative } from "../../../lib/api";
import { NARRATIVE_FOOT, moreCaption, moreText, narrativeView, siblingsLine, wordsLine } from "../../../lib/narrative";
import { LeadCaption, PostRow } from "../../narrative/NarrativeParts";

type Props = {
  data: Narrative; stale: boolean;
  /// The ticker of the coin the posts are for (`data.mint`: the selected coin, or the previous one while `stale`).
  label: string;
  onPick: (mint: string) => void; onHover: (mint: string | null) => void;
};

export default function NarrativeBlock({ data, stale, label, onPick, onHover }: Props) {
  const { lead, rest, words, empty } = narrativeView(data);
  // open for one coin: another coin's posts start collapsed
  const [openFor, setOpenFor] = useState<string | null>(null);
  useEffect(() => setOpenFor((m) => (m === data.mint ? m : null)), [data.mint]);
  const open = openFor === data.mint;
  // A chip under the pointer lights its bubble; an inert or unmounted chip gets no leave event, so the light is put
  // out here.
  const lit = useRef(false);
  const hoverRef = useRef(onHover); hoverRef.current = onHover;
  const hover = (m: string | null) => { lit.current = m !== null; onHover(m); };
  useEffect(() => { if (stale && lit.current) { lit.current = false; hoverRef.current(null); } }, [stale]);
  useEffect(() => () => { if (lit.current) hoverRef.current(null); }, []);
  if (empty || !lead) return null;
  const more = rest.length > 0 || words.length > 0;
  return (
    <section className="nar-block" aria-label="Posts linked by coins" aria-busy={stale || undefined} inert={stale}>
      <div className="nar-head">
        <LeadCaption lead={lead} label={label} onPick={onPick} title={NARRATIVE_FOOT} />
        {more && <button type="button" className="nar-more linkish" aria-expanded={open} onClick={() => setOpenFor(open ? null : data.mint)}>{open ? "Show less" : moreText(rest.length)}</button>}
      </div>
      <PostRow post={lead.post} lines={2} stat={lead.kind !== "own"} note={lead.kind === "own" ? siblingsLine(lead.post) : null} onPick={onPick} onHover={hover} />
      {open && (
        <>
          {rest.length > 0 && <p className="nar-cap">{moreCaption(label)}</p>}
          {rest.map((p) => <PostRow key={p.id} post={p} lines={2} stat onPick={onPick} onHover={hover} />)}
          {words.length > 0 && <p className="nar-words">{wordsLine(words)}</p>}
          <p className="nar-foot">{NARRATIVE_FOOT}</p>
        </>
      )}
    </section>
  );
}
