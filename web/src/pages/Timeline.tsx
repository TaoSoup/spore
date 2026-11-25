// The story timeline (/timeline, GET /api/timeline): every story Spore's 5-minute attention series recorded in a day,
// by when it started, so a reader can look back at what happened ("what did we see at 19:30?"). In the calm style of
// Discover: one row style, big numbers over sentences.
// - The bar: the day (Last 24 h / Today / Yesterday / an earlier day, in the reader's own time) and the size (stories
//   whose busiest 5 minutes had 100+ / 20+ / 5+ buyers). Both live in the URL, so a view can be shared.
// - The band: the whole site's buyers per 5 minutes over the window, with a tick where each listed story started
//   (taller for a bigger peak). Pointing at it reads the time and the site's buyers; a tick jumps to its story.
// - The list: stories grouped by the local hour they started in, newest first; stories that started before the window
//   and were still bought in it come last. A row: start time, kind and title (a post's author and words, a narrative's
//   title, a family's ticker), the story's buyers per 5 minutes as a small line, its peak, its leading coin, and its
//   coins and active time.
// Facts only: what was measured, never a rating. A narrative title is written by a language model and a post's text by
// its author: both are untrusted, drawn as text nodes, never as markup or in an address (the post link is rebuilt from
// its id by the server). Every class here starts with "tl-" (components/timeline.css).
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { api, errorMessage, type Timeline as TimelineBody, type TimelineStory } from "../lib/api";
import { count, usd } from "../lib/format";
import { Logo } from "../components/Bits";
import {
  KIND_WORD, MIN_ITEMS, axisTicks, bandGeo, clock, dayParam, earlierDays, hourGroups, nearestSite, parseDay, parseMin, sparkPath, spanWords, titleOf, windowOf,
  type DayKey, type MinKey,
} from "../lib/timeline";
import "../components/primitives.css";
import "../components/dsc.css";
import "../components/timeline.css";

const DAY_ITEMS = [
  { key: "24h", text: "Last 24 h", title: "The last 24 hours up to now" },
  { key: "today", text: "Today", title: "Since midnight, your time" },
  { key: "yesterday", text: "Yesterday", title: "Yesterday, midnight to midnight, your time" },
] as const;

function Seg<K extends string>({ label, items, value, onChange }: { label: string; items: readonly { key: K; text: string; title: string }[]; value: K | null; onChange: (k: K) => void }) {
  return (
    <div className="dsc-seg" role="radiogroup" aria-label={label}>
      {items.map((x) => <button key={x.key} type="button" role="radio" aria-checked={x.key === value} className={x.key === value ? "on" : ""} title={x.title} onClick={() => onChange(x.key)}>{x.text}</button>)}
    </div>
  );
}

export default function Timeline() {
  const [params, setParams] = useSearchParams();
  const day = parseDay(params.get("day")), min = parseMin(params.get("min"));
  const set = (k: "day" | "min", v: string) => { const p = new URLSearchParams(params); p.set(k, v); setParams(p, { replace: true }); };
  const [data, setData] = useState<TimelineBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { document.title = "Story timeline · Spore"; return () => { document.title = "Spore"; }; }, []);
  // "Last 24 h" and "Today" end now: read again every 2 minutes while the tab is visible
  useEffect(() => {
    if (day !== "24h" && day !== "today") return;
    const id = setInterval(() => { if (document.visibilityState === "visible") setTick((n) => n + 1); }, 120_000);
    return () => clearInterval(id);
  }, [day]);
  useEffect(() => {
    let alive = true;
    const w = windowOf(day);
    setBusy(true); setError(null);
    api.timeline(w.from, w.to, Number(min)).then((d) => { if (alive) { setData(d); setBusy(false); } }, (e) => { if (alive) { setError(errorMessage(e)); setBusy(false); } });
    return () => { alive = false; };
  }, [day, min, tick]);
  const earlier = useMemo(() => earlierDays(), []);
  const groups = useMemo(() => (data ? hourGroups(data.stories) : []), [data]);
  // a link to one story (#tl-…, a band tick or a shared address): its row exists only once the read is in, so the
  // jump is made then, once per address
  const { hash } = useLocation();
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !hash || jumped.current === hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) { jumped.current = hash; el.scrollIntoView({ block: "center" }); }
  }, [data, hash]);
  const dayValue = DAY_ITEMS.some((x) => x.key === day) ? (day as (typeof DAY_ITEMS)[number]["key"]) : null;
  return (
    <div className="dsc-page tl-page">
      <header className="dsc-top">
        <div className="dsc-top-text">
          <h1>Story timeline</h1>
          <p className="dsc-sub">Every story Spore recorded, by when it started. Buyers are wallets that bought in a 5-minute window.</p>
        </div>
        <Link to="/discover" className="dsc-link">Back to Discover</Link>
      </header>
      <div className="dsc-bar">
        <div className="dsc-bar-l tl-days">
          <Seg label="Day" items={DAY_ITEMS} value={dayValue} onChange={(k) => set("day", k)} />
          <select className="tl-select" aria-label="An earlier day" value={day.startsWith("d:") ? day : ""} onChange={(e) => e.target.value && set("day", dayParam(e.target.value as DayKey))}>
            <option value="">Earlier day…</option>
            {earlier.map((d) => <option key={d.key} value={d.key}>{d.text}</option>)}
          </select>
        </div>
        <div className="dsc-ctl">
          <span className="tl-ctl-label">Peak buyers / 5 min</span>
          <Seg label="Smallest peak listed" items={MIN_ITEMS} value={min} onChange={(k: MinKey) => set("min", k)} />
        </div>
      </div>
      {error && !data && <div className="dsc-empty">The story history could not be read just now ({error}).</div>}
      {!data && !error && <div className="tl-skel" aria-busy="true">Reading the story history…</div>}
      {data && (
        <div className={`tl-body${busy ? " stale" : ""}`} aria-busy={busy || undefined}>
          {error && <p className="dsc-stale-err">The last read failed ({error}); showing the one before.</p>}
          <Band data={data} />
          <p className="tl-count">
            <b>{count(data.listed)}</b> {data.listed === 1 ? "story" : "stories"} with {data.min}+ buyers in their busiest 5 minutes
            {data.hidden > 0 && <span> · {count(data.hidden)} smaller not listed</span>}
            {data.more > 0 && <span> · {count(data.more)} more not shown (narrow the window)</span>}
          </p>
          {groups.length === 0 ? (
            <div className="dsc-empty">No story reached {data.min} buyers in 5 minutes in this window. {data.min > 5 && <button type="button" className="linkish dsc-link" onClick={() => set("min", "5")}>Show smaller ones</button>}</div>
          ) : groups.map((g) => (
            <section key={g.key} className="tl-hour" aria-label={g.label}>
              <h2 className="tl-hour-h">{g.label}<span>{g.stories.length}</span></h2>
              <ol className="tl-list">{g.stories.map((s) => <Row key={s.key} s={s} />)}</ol>
            </section>
          ))}
          <p className="dsc-note">
            From Spore's 5-minute attention series, kept 14 days and recorded only while the server runs: a gap means it was not watching, not that nothing happened.
            A story is one narrative (its title written by a language model, which can be wrong), one X post the coins link, or one family of coins.
            A peak counts the wallets that bought the story's coins in one 5-minute window. Nothing here says what a coin will do.
          </p>
        </div>
      )}
    </div>
  );
}

const anchorOf = (key: string) => `tl-${key.replace(/[^A-Za-z0-9]/g, "-")}`;

function Band({ data }: { data: TimelineBody }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hot, setHot] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => { const n = Math.round(el.clientWidth); if (n > 0) setW(n); };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const h = w < 520 ? 64 : 84;
  const g = useMemo(() => bandGeo(data, w, h), [data, w, h]);
  // on the box, not the svg: the tick links lie over the svg, and a pointer over one must still read the band
  const track = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0) setHot(data.from + ((e.clientX - r.left) / r.width) * (data.to - data.from));
  };
  const p = hot != null ? nearestSite(data.site, hot) : null;
  const peak = data.site.reduce((a, x) => (x.buyers > a.buyers ? x : a), { t: 0, buyers: 0 });
  const read = p ? `${clock(p.t)} · ${count(p.buyers)} buyers` : hot != null ? `${clock(hot)} · not recorded` : peak.buyers ? `busiest ${clock(peak.t)} · ${count(peak.buyers)}` : "";
  return (
    <div className="tl-band">
      <div className="tl-band-head">
        <span>Whole site · buyers per 5 min</span>
        <span className="tl-band-read" aria-hidden="true">{read}</span>
      </div>
      <div ref={box} className="tl-band-box" style={{ height: h }} onPointerMove={track} onPointerDown={track} onPointerLeave={() => setHot(null)}>
        <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
          aria-label={`Buyers per 5 minutes on the whole site, ${clock(data.from)} to ${clock(data.to)}${peak.buyers ? `, busiest at ${clock(peak.t)} with ${peak.buyers}` : ""}; ${data.stories.length} story starts marked.`}>
          {g.area && <path className="tl-band-area" d={g.area} />}
          {g.marks.map((m) => <line key={m.key} className="tl-band-mark" x1={m.x} x2={m.x} y1={h} y2={h - m.len} vectorEffect="non-scaling-stroke" />)}
          {p && <line className="tl-band-hot" x1={g.x(p.t)} x2={g.x(p.t)} y1={0} y2={h} vectorEffect="non-scaling-stroke" />}
        </svg>
        {/* the ticks as links over the band, for a pointer and a keyboard alike */}
        <div className="tl-band-links">
          {g.marks.map((m) => <a key={m.key} href={`#${anchorOf(m.key)}`} style={{ left: `${(m.x / w) * 100}%` }} tabIndex={-1} aria-hidden="true" />)}
        </div>
      </div>
      <div className="tl-band-axis" aria-hidden="true">
        {axisTicks(data.from, data.to).map((t) => <span key={t.at} style={{ left: `${t.at * 100}%` }}>{t.text}</span>)}
      </div>
    </div>
  );
}

function Row({ s }: { s: TimelineStory }) {
  const title = titleOf(s);
  const d = sparkPath(s.series, 96, 26);
  return (
    <li className="tl-row" id={anchorOf(s.key)}>
      <time className="tl-time" dateTime={new Date(s.startAt * 1000).toISOString()} title={s.startSource === "post" ? "The post's time" : s.startSource === "first-bucket" ? "Its first recorded 5 minutes" : "When its buying began"}>{clock(s.startAt)}</time>
      <div className="tl-main">
        <div className="tl-title">
          <span className={`dsc-pill sm tl-kind k-${s.kind}`}>{KIND_WORD[s.kind] ?? "Story"}</span>
          <span className="tl-title-text" title={title}>{title}</span>
        </div>
        <div className="tl-sub">
          {s.kind === "post" && s.handle && (s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="dsc-link">@{s.handle}</a> : <span>@{s.handle}</span>)}
          {s.kind === "narrative" && s.theme && <span>{s.theme}</span>}
          {s.kind === "family" && s.mint && <Link to={`/c/${s.mint}`} className="dsc-link">parent coin</Link>}
          <span>{count(s.coins)} {s.coins === 1 ? "coin" : "coins"}</span>
          <span>active {spanWords(s)}</span>
          {s.buyUsd > 0 && <span>{usd(s.buyUsd)} bought</span>}
        </div>
      </div>
      <svg className="tl-spark" width="96" height="26" viewBox="0 0 96 26" role="img" aria-label={`Buyers per 5 minutes, ${s.series.length} buckets, peak ${s.peak} at ${clock(s.peakT)}`}>
        <path d={d} />
      </svg>
      <div className="tl-peak" title={`Busiest 5 minutes at ${clock(s.peakT)}`}>
        <b>{count(s.peak)}</b><span>peak · {clock(s.peakT)}</span>
      </div>
      {s.leader ? (
        <Link to={`/c/${s.leader.mint}`} className="tl-lead" title={s.leader.name ?? undefined}>
          <Logo src={s.leader.image} label={s.leader.symbol} size={22} />
          <span>{s.leader.symbol ? `$${s.leader.symbol}` : s.leader.mint.slice(0, 6)}</span>
        </Link>
      ) : <span className="tl-lead none" />}
    </li>
  );
}
