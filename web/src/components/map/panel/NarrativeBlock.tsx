// The map panel's launch timeline (lib/narrative.ts, components/narrative/): the X posts the coins under the selected
// coin link in their metadata, one event a line, newest first. Collapsed it is a caption and three lines (about
// 110 px), and its height does not change once it is mounted (a line is one height with or without its text; a poll
// fills texts in and moves nothing). "Show N more", at the right of the caption's line, opens the other events; a
// click on a line opens that post. A coin with its own post shows that as one line, with the other coins linking it;
// a coin with neither shows its parent's newest event. While another coin's answer loads (`stale`) the block stays
// where it is, dimmed and inert, so the panel does not jump twice. Nothing renders for a coin without posts.
import { useEffect, useRef } from "react";
import type { Narrative } from "../../../lib/api";
import { CAPTION_OWN, CAPTION_TIMELINE, NARRATIVE_FOOT, narrativeView } from "../../../lib/narrative";
import { OwnPost, SoloLine, Timeline, UnderCaption } from "../../narrative/Timeline";

type Props = {
  data: Narrative; stale: boolean;
  /// The ticker of the coin the events are for (`data.mint`: the selected coin, or the previous one while `stale`).
  label: string;
  onPick: (mint: string) => void; onHover: (mint: string | null) => void;
};

export default function NarrativeBlock({ data, stale, label, onPick, onHover }: Props) {
  const { own, events, earlier, under, empty } = narrativeView(data);
  // A chip under the pointer lights its bubble; an inert or unmounted chip gets no leave event, so the light is put
  // out here.
  const lit = useRef(false);
  const hoverRef = useRef(onHover); hoverRef.current = onHover;
  const hover = (m: string | null) => { lit.current = m !== null; onHover(m); };
  useEffect(() => { if (stale && lit.current) { lit.current = false; hoverRef.current(null); } }, [stale]);
  useEffect(() => () => { if (lit.current) hoverRef.current(null); }, []);
  if (empty) return null;
  return (
    <section className="nar-block" aria-label={`Posts linked by coins${under ? "" : ` under ${label}`}`} aria-busy={stale || undefined} inert={stale}>
      {own && (
        <>
          <p className="nar-cap" title={NARRATIVE_FOOT}>{CAPTION_OWN}</p>
          <OwnPost key={own.id} own={own} onPick={onPick} onHover={hover} />
        </>
      )}
      {/* beside an own post the timeline starts with one line, so the block keeps its size */}
      {events.length > 0 && <Timeline mint={data.mint} events={events} earlier={earlier} collapsed={own ? 1 : 3} foot="open" head={<p className="nar-cap" title={NARRATIVE_FOOT}>{CAPTION_TIMELINE}</p>} onPick={onPick} onHover={hover} />}
      {under && (
        <>
          <UnderCaption parent={under.parent} onPick={onPick} title={NARRATIVE_FOOT} />
          <SoloLine key={under.event.id} post={under.event} at={under.event.at} onPick={onPick} onHover={hover} />
        </>
      )}
    </section>
  );
}
