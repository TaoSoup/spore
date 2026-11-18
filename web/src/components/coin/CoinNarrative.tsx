// "Linked posts" on the coin page: the X posts this coin, or the coins under it, link in their metadata
// (/api/narrative, lib/narrative.ts; the rows are components/narrative/). The first post with a caption saying whose
// link it is, the first post of the coin's children after it, the others behind "Show N more", the words many of the
// children's names share, and always the line saying who picked the posts. The coins are links to their pages.
// Nothing shows for a coin without posts, or on a server without the route.
import { memo, useId, useState } from "react";
import type { Coin } from "../../lib/api";
import { NARRATIVE_FOOT, moreCaption, moreText, narrativeView, siblingsLine, wordsLine } from "../../lib/narrative";
import { LeadCaption, PostRow } from "../narrative/NarrativeParts";
import { useNarrative } from "../narrative/useNarrative";
import { sym } from "../Bits";

function CoinNarrative({ coin }: { coin: Coin }) {
  const { data } = useNarrative(coin.mint);
  const [open, setOpen] = useState(false);
  const headId = useId();
  // only this coin's answer (the page is rebuilt per coin, so another coin's never lingers here)
  const { lead, rest, words } = narrativeView(data && data.mint === coin.mint ? data : null);
  if (!lead) return null;
  const label = sym(coin);
  return (
    <section className="card coin-narrative" aria-labelledby={headId}>
      <h2 id={headId} className="card-label">Linked posts</h2>
      <LeadCaption lead={lead} label={label} />
      <PostRow post={lead.post} lines={3} stat={lead.kind !== "own"} note={lead.kind === "own" ? siblingsLine(lead.post) : null} />
      {/* the coin's own post is not one its children link: the posts after it get their own caption */}
      {rest.length > 0 && lead.kind === "own" && <p className="nar-cap">{moreCaption(label)}</p>}
      {(open ? rest : rest.slice(0, 1)).map((p) => <PostRow key={p.id} post={p} lines={3} stat />)}
      {rest.length > 1 && <button type="button" className="nar-more linkish" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : moreText(rest.length - 1)}</button>}
      {words.length > 0 && <p className="nar-words">{wordsLine(words)}</p>}
      <p className="nar-foot">{NARRATIVE_FOOT}</p>
    </section>
  );
}

export default memo(CoinNarrative);
