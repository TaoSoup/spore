// "Launch timeline" on the coin page: the X posts the coins under this coin link in their metadata, one event a
// line, newest first (/api/narrative, lib/narrative.ts; the lines are components/narrative/). Five lines, the rest
// behind "Show N more"; a click on a line opens that post. A coin with its own post gets "Linked post" instead: the
// post as one line, then how many other coins link it, with those coins. A coin with neither shows its parent's
// newest event under "Under $PARENT". The coins are links to their pages. Nothing shows for a coin without posts, or
// on a server without the route.
import { memo, useId } from "react";
import type { Coin } from "../../lib/api";
import { CAPTION_OWN, CAPTION_TIMELINE, NARRATIVE_FOOT, narrativeView } from "../../lib/narrative";
import { OwnPost, SoloLine, Timeline, UnderCaption } from "../narrative/Timeline";
import { useNarrative } from "../narrative/useNarrative";

function CoinNarrative({ coin }: { coin: Coin }) {
  const { data } = useNarrative(coin.mint);
  const headId = useId();
  // only this coin's answer (the page is rebuilt per coin, so another coin's never lingers here)
  const { own, events, earlier, under, empty } = narrativeView(data && data.mint === coin.mint ? data : null);
  if (empty) return null;
  const title = (text: string) => <h2 id={headId} className="card-label">{text}</h2>;
  return (
    <section className="card coin-narrative" aria-labelledby={headId}>
      {own && (
        <>
          {title("Linked post")}
          <p className="nar-cap">{CAPTION_OWN}</p>
          <OwnPost own={own} />
        </>
      )}
      {events.length > 0 && <Timeline mint={coin.mint} events={events} earlier={earlier} collapsed={5} head={own ? <p className="nar-cap">{CAPTION_TIMELINE}</p> : title(CAPTION_TIMELINE)} />}
      {under && (
        <>
          {title(CAPTION_TIMELINE)}
          <UnderCaption parent={under.parent} />
          <SoloLine post={under.event} at={under.event.at} />
        </>
      )}
      {events.length === 0 && <p className="nar-foot">{NARRATIVE_FOOT}</p>}
    </section>
  );
}

export default memo(CoinNarrative);
