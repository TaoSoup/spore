// Discover: the parents getting new coins right now (GET /api/discover; the words and bars are lib/discover.ts).
// One row a parent, most new coins in the last hour first: logo, name, the count, a strip of twelve bars (launches per
// five minutes, oldest on the left) and the two new coins that traded most. A click on a row opens that parent's
// launch timeline under it (components/narrative/Timeline, the same lines the map panel and the coin page show), with
// quiet links to the map and the coin page; one row is open at a time. The list is read again every 15 s while the
// tab is visible: rows are keyed by mint, so a refresh changes numbers without a flash. No row moves while the list
// is in use (the pointer is over it, a row has focus or a row is open): the numbers change in place, a new parent is
// added at the end and a parent that left stays, dimmed and marked; the server's order is applied when the list is
// next idle (lib/discover.ts discoverRows). A failed refresh keeps what is on screen.
// Every class here starts with "dsc-" (components/dsc.css; discover.css belongs to the Coins page).
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, errorMessage, type Discover as DiscoverBody } from "../lib/api";
import { BARS, DISCOVER_POLL_MS, LEFT_NOTE, LEFT_SHORT, barHeights, barsLabel, countWords, creatorsNote, discoverRows, leading, windowLabel, type DiscoverRow } from "../lib/discover";
import { count } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { narrativeView } from "../lib/narrative";
import { ErrorBox, Logo, Skeleton, nameOf, sym } from "../components/Bits";
import { Timeline } from "../components/narrative/Timeline";
import { useNarrative } from "../components/narrative/useNarrative";
import "../components/primitives.css";
import "../components/dsc.css";

const mapLink = (mint: string) => `/map?focus=${encodeURIComponent(mint)}`;
const coinLink = (mint: string) => `/c/${encodeURIComponent(mint)}`;
/// An open timeline is read again on this interval, so events of coins launched meanwhile appear on top.
const TIMELINE_EVERY_MS = 30_000;

type Listed = { rows: DiscoverRow[]; windowS: number; binS: number };

/// The twelve bars: plain divs, the tallest bin the strip's full height, an empty bin a stub; the last is the newest.
function Bars({ p, binS, windowS }: { p: DiscoverRow; binS: number; windowS: number }) {
  const h = barHeights(p.bins);
  return (
    <span className="dsc-bars" role="img" aria-label={barsLabel(p, binS, windowS)}>
      {h.map((x, i) => <i key={i} className={x > 0 ? (i === BARS - 1 ? "now" : undefined) : "none"} style={x > 0 ? { height: `${Math.max(8, Math.round(x * 100))}%` } : undefined} />)}
    </span>
  );
}

/// What an open row shows: the parent's timeline, with how many creators launched the new coins (or that the parent
/// left the list) and the links to the map and, when the parent has a record here, its coin page (a listed asset such
/// as a stock token may have none; one small read tells). A timeline that could not be read says so, with Retry:
/// "no posts" is said only for an answer.
function Open({ p }: { p: DiscoverRow }) {
  const { data, stale, failed, retry } = useNarrative(p.mint, TIMELINE_EVERY_MS);
  const page = useAsync(() => api.coin(p.mint, { children: false, trades: false }).then(() => true, () => false), [p.mint]);
  const view = narrativeView(data && data.mint === p.mint ? data : null);
  const by = creatorsNote(p);
  const links = (
    <p className="dsc-links">
      {p.left ? <span>{LEFT_NOTE}</span> : by && <span>{by}</span>}
      <Link to={mapLink(p.mint)} title={`${nameOf(p)} and the coins under it on the map`}>Open on map</Link>
      {page.data === true && <Link to={coinLink(p.mint)} title={`${nameOf(p)}: chart and trading`}>Coin page</Link>}
    </p>
  );
  if (stale) return <>{links}<div className="dsc-wait" aria-busy="true" aria-label="Loading the timeline"><Skeleton h={10} /><Skeleton h={10} /><Skeleton h={10} w="62%" /></div></>;
  if (failed) return <>{links}<p className="dsc-none" role="status">Couldn't load the timeline.<button type="button" className="linkish dsc-link" onClick={retry}>Retry</button></p></>;
  if (view.events.length === 0) return <>{links}<p className="dsc-none">No posts linked by coins under {sym(p)} yet.</p></>;
  return <Timeline mint={p.mint} events={view.events} earlier={view.earlier} collapsed={5} head={links} />;
}

function Row({ p, open, onToggle, binS, windowS }: { p: DiscoverRow; open: boolean; onToggle: () => void; binS: number; windowS: number }) {
  const id = useId();
  const lead = leading(p);
  const note = p.left ? LEFT_NOTE : creatorsNote(p);
  return (
    <li className={`dsc-row${open ? " open" : ""}${p.left ? " left" : ""}`}>
      <div className="dsc-head">
        <Logo src={p.image} label={p.symbol} size={28} />
        {/* the button's hit area is the whole head (dsc.css), over the count and the bars, so the tooltip is the
            button's; the same words are in its name for a screen reader and in the open row for everyone. The coin
            links lie over the button. */}
        <button type="button" className="dsc-name" aria-expanded={open} aria-controls={open ? id : undefined} title={note ?? undefined} onClick={onToggle}>
          <b>{sym(p)}</b><span>{nameOf(p)}</span>{note && <span className="sr-only">{note}</span>}
        </button>
        <span className="dsc-count">
          {p.left ? LEFT_SHORT : <><b>{count(p.new1h)}</b> {countWords(p)} · {windowLabel(windowS)}</>}
        </span>
        <Bars p={p} binS={binS} windowS={windowS} />
        <span className="dsc-lead">
          {lead.length > 0 && <>Leading {lead.map((c, i) => <Fragment key={c.mint}>{i > 0 && " · "}<Link to={coinLink(c.mint)} title={`${c.sym}: ${c.vol} traded in 24 h`}>{c.sym} <span>{c.vol}</span></Link></Fragment>)}</>}
        </span>
        <svg className="dsc-chev" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
      </div>
      {open && <div className="dsc-open" id={id}><Open p={p} /></div>}
    </li>
  );
}

export default function Discover() {
  useEffect(() => { document.title = "Discover · Spore"; return () => { document.title = "Spore"; }; }, []);
  const [list, setList] = useState<Listed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const openRef = useRef(open); openRef.current = open;
  // the list is in use: the pointer is over it, a row has focus or a row is open. Rows do not move then.
  const over = useRef(false);
  const rowsEl = useRef<HTMLUListElement>(null);
  // only keyboard focus counts (a clicked button keeps focus on Windows, which would hold the order for good); focus is asked of the page, not kept: a focused control that is removed fires no blur in every browser
  const held = () => over.current || !!rowsEl.current?.querySelector(":focus-visible") || openRef.current !== null;
  // the last answer, to apply its order once the list is idle
  const lastBody = useRef<DiscoverBody | null>(null);
  const settle = () => {
    const d = lastBody.current;
    if (held() || !d) return;
    setList((was) => (was ? { ...was, rows: discoverRows(d, was.rows, null) } : was));
  };
  // a row was closed: the order (and a row that left the list) waits no longer, unless the list is still in use
  useEffect(settle, [open]);
  useEffect(() => {
    let alive = true, busy = false, last = 0;
    const load = () => {
      if (busy || document.hidden) return;
      busy = true;
      api.discover().then((d: DiscoverBody) => {
        if (!alive) return;
        last = Date.now(); lastBody.current = d;
        setList((was) => ({ rows: discoverRows(d, was?.rows ?? [], openRef.current, held()), windowS: d.windowS, binS: d.binS }));
        setError(null);
      }, (e) => { if (alive) setError(errorMessage(e)); }).finally(() => { busy = false; });
    };
    load();
    const t = setInterval(load, DISCOVER_POLL_MS);
    // back on the tab: read at once when the list on screen is older than one interval
    const onVisible = () => { if (!document.hidden && Date.now() - last >= DISCOVER_POLL_MS) load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [nonce]);
  // a row that left the list stays where it is until the list is idle (settle): closing a row moves no other row
  const toggle = (mint: string) => setOpen(open === mint ? null : mint);
  return (
    <div className="dsc-page">
      <header className="dsc-top">
        <h1>Discover</h1>
        <p className="dsc-sub">Parents with the most new coins in the last hour</p>
      </header>
      {list === null ? (
        error
          ? <ErrorBox error="The list could not be loaded." retry={() => { setError(null); setNonce((n) => n + 1); }} details={error} />
          : <ul className="dsc-rows" aria-busy="true" aria-label="Loading the list">{Array.from({ length: 6 }, (_, i) => <li key={i} className="dsc-row"><div className="dsc-skel"><Skeleton h={28} w={28} r={999} /><Skeleton h={12} w={`${46 - i * 4}%`} /></div></li>)}</ul>
      ) : list.rows.length === 0 ? (
        <p className="dsc-empty">No parent has a run of new coins right now. <Link to="/map" className="dsc-link">Open the map</Link></p>
      ) : (
        <ul className="dsc-rows" aria-label="Parents getting new coins" ref={rowsEl}
          onPointerEnter={() => { over.current = true; }} onPointerLeave={() => { over.current = false; settle(); }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) queueMicrotask(settle); }}>
          {list.rows.map((p) => <Row key={p.mint} p={p} open={open === p.mint} onToggle={() => toggle(p.mint)} binS={list.binS} windowS={list.windowS} />)}
        </ul>
      )}
    </div>
  );
}
