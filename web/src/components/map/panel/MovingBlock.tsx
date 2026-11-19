// The map panel's "Moving now" block (GET /api/discover/:mint, lib/discover.ts): the coins under the selected coin that
// the most wallets are buying right now, up to three, one line each (ticker, existing / new, market cap, buyers in
// 5 min, or in 15 min for a quiet family), each a link to its coin page that lights its bubble while pointed at. When the selected coin's family is
// waking up (listed on Discover) the caption says so: "Waking up · started 4 min ago · 14x its normal" ("Cooling · ..."
// once it cools); otherwise it is "Moving now". Only coins someone bought are listed (one only sold is not moving). At most about 110 px, the same at every answer. Nothing renders for a coin without moving children.
// The answer is read when the coin is selected (debounced 150 ms like the panel's other reads, so an arrow-key walk
// does not ask per step) and again every 30 s while the tab is visible. While another coin's answer loads (`stale`)
// the block stays where it is, dimmed and inert, so the panel does not jump twice; a failed read keeps what is shown,
// and a 404 (an unknown mint, or a server without the route) removes it. Every hook runs before the early return.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, type DiscoverOne } from "../../../lib/api";
import { AGO_TICK_MS, MOVING_POLL_MS, TAG_TITLE, TAG_TITLE_QUIET, coinTag, movingBuyers, movingCaption, movingCoins } from "../../../lib/discover";
import { count, usd } from "../../../lib/format";
import { useDebounced, useTick } from "../../../lib/hooks";
import { shownAnswer } from "../../../lib/narrative";
import { Logo, nameOf, sym } from "../../Bits";

const FAILED = Symbol("failed");
type Got = { mint: string | null; data: DiscoverOne | null };

/// The selected coin's answer; `stale` while the answer on screen is another coin's.
export function useMovingNow(mint: string | null): { data: DiscoverOne | null; stale: boolean } {
  const dm = useDebounced(mint, 150);
  const [got, setGot] = useState<Got>({ mint: null, data: null });
  useEffect(() => {
    if (!dm) { setGot({ mint: null, data: null }); return; }
    let alive = true, busy = false;
    const read = (first: boolean) => {
      if (busy || (!first && document.hidden)) return;
      busy = true;
      void api.discoverOf(dm).then((d): DiscoverOne | null | typeof FAILED => d, (e) => (e instanceof ApiError && e.status === 404 ? null : FAILED)).then((d) => {
        busy = false;
        if (!alive) return;
        // a failed first read shows nothing for this coin; a failed later read keeps what is shown
        if (d === FAILED) { if (first) setGot({ mint: dm, data: null }); return; }
        setGot({ mint: dm, data: d });
      });
    };
    read(true);
    const t = setInterval(() => read(false), MOVING_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [dm]);
  // what is on screen: the last answer that was for the coin selected at the time
  const shown = useRef(got);
  shown.current = shownAnswer(shown.current, got, mint);
  return { data: shown.current.data, stale: shown.current.mint !== mint };
}

type Props = { data: DiscoverOne; stale: boolean; onHover: (mint: string | null) => void };

export default function MovingBlock({ data, stale, onHover }: Props) {
  useTick(AGO_TICK_MS);
  // A row under the pointer lights its bubble; an inert or unmounted row gets no leave event, so the light is put out here.
  const lit = useRef(false);
  const hoverRef = useRef(onHover); hoverRef.current = onHover;
  const hover = (m: string | null) => { lit.current = m !== null; onHover(m); };
  useEffect(() => { if (stale && lit.current) { lit.current = false; hoverRef.current(null); } }, [stale]);
  useEffect(() => () => { if (lit.current) hoverRef.current(null); }, []);
  const coins = movingCoins(data);
  if (coins.length === 0) return null;
  const waking = data.state === "live" || data.state === "cooling";
  // a quiet family has not woken up: its tag is measured against now
  const tagTitle = waking ? TAG_TITLE : TAG_TITLE_QUIET;
  return (
    <section className="map-moving" aria-label={`Coins under ${sym(data.parent)} moving now`} aria-busy={stale || undefined} inert={stale}>
      <p className={`map-moving-cap${waking ? ` st-${data.state}` : ""}`}>{waking && <i aria-hidden="true" />}<span>{movingCaption(data, Math.floor(Date.now() / 1000))}</span></p>
      <ul onMouseLeave={() => hover(null)}>
        {coins.map((c) => {
          const tag = coinTag(c), b = movingBuyers(data, c);
          return (
            <li key={c.mint}>
              <Link to={`/c/${encodeURIComponent(c.mint)}`} className="map-moving-row" title={nameOf(c)} onMouseEnter={() => hover(c.mint)} onFocus={() => hover(c.mint)} onBlur={() => hover(null)}>
                <Logo src={c.image} label={c.symbol} size={16} />
                <span className="map-moving-id"><b>{sym(c)}</b><i className={tag} title={tagTitle[tag]}>{tag}</i></span>
                <span className="mono" title="Market cap">{usd(c.mcapUsd)}</span>
                <span className="mono muted" title={b.title}>{count(b.n)} {b.n === 1 ? "buyer" : "buyers"}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
