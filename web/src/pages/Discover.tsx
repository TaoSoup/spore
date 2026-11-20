// Discover: two lists of what is being bought right now, in the calm style of the Portfolio page.
// - "Waking up" (GET /api/discover): the families whose existing coins are being bought far above their normal level.
//   A family "wakes up" when, in one 5-minute bucket, 50 or more wallets buy 3 or more of its coins launched over 30 min
//   before, at 5x or more its trailing 24 h level. The newest is on top; a family that is cooling AND under 3x now is
//   folded to one line (its current numbers first). One card a family: the head (ticker, "Started N min ago", what is
//   measured, then how many coins carry the buying and USD bought / sold over 5 min), a chart of buyers of existing
//   coins per 5 min over 2 h (the ratio's own basis, so line, band and ratio agree)
//   with a mark where buying jumped and one where the linked post was posted, the linked X post as a readable block
//   (only what coincided, never a cause: the block says the coins link it and when it was posted against the jump), and
//   the coins being bought now.
// - "Trending" (GET /api/trending): coins in the server's rank (buyers who have not sold, then volume), numbered, each
//   tagged with its parent and whether that family is on the first list. The header sorts the rows received by
//   Buyers, Mcap or Liquidity (the line under the title then says that order); copies of a ticker under one parent
//   fold under the first of them ("+2 same ticker"; roots share no parent and never fold).
// Both lists share one coin row (CoinRow): ticker, a price sparkline over the last hour, market cap with its change over
// the chosen timeframe (1m / 5m / 30m / 1h, the `tf=` of both reads, kept in this browser), liquidity, volume, txns,
// buyers, the measured safety chips, and a Buy that shows its amount ("Buy 0.5 SOL"). The amount is one of the trade
// settings' three buy presets (P1 / P2 / P3 in the header; the amounts are edited in Trade settings), and Buy runs the
// same instant trade as the map and the coin page (components/useInstantTrade.ts: the reader's Trade-with choice signs,
// a locked trading wallet is asked to unlock, a failed check opens the ticket); with instant trades off or no wallet it
// opens the ticket with the amount filled in. No other signing path.
// Live numbers: the SSE "trade" of the coins on screen moves their price, market cap (flashing once), change and
// sparkline between reads (lib/discover.ts liveMerge); the list is read every 10 s while the tab is visible. Nothing
// moves while the list is in use (a mouse over it, a tap or scroll on it in the last 5 s, or keyboard focus in it): rows
// keep their places and take fresh numbers, a new row is added at the end and one that left stays, dimmed; the
// server's order comes back once the list is idle (familyRows / trendRows). Under an open ticket, or while a Buy is
// under way, no read is applied.
// While the order is held the bar says so, and a wake-up that started meanwhile is named in a pill over the list
// ("1 new wake-up: $SQQQ · Show"), which applies the server's order.
// Every class here starts with "dsc-" (components/dsc.css; discover.css belongs to the Coins page).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useConnection } from "@solana/wallet-adapter-react";
import { api, errorMessage, pumpUrl, type Coin, type CoinRow as Row, type CoinSafety, type CoinSpark, type Discover as DiscoverBody, type Tf, type Trending } from "../lib/api";
import {
  AGO_TICK_MS, ALERT_LABEL, ALERT_TITLE, DISCOVER_POLL_MS, FLOW_TITLE, FOOT_NOTE, GRAD_TITLE, GROUP_TITLE, LEFT_PILL, LIQ_TITLE, MINT_PREFIX_TITLE, POST_NOTE, SILENT_TITLE, SLOT_KEY, TAB_KEY,
  TAG_TITLE, TAG_TITLE_QUIET, TFS, TF_KEY, TF_TITLE, THIN_TEXT, THIN_TITLE, TOUCH_HOLD_MS,
  buyLabel, buyersCell, carryLive, carryLiveFamilies, chartAxis, chartMarks, chartSeries, chgText, coinSparkLabel, coinSparkPath, coinTag, coolingLine, copyLine, emptyTrending,
  factsLine, familyChartLabel, familyPill, familyRows, firstOpen, floorLine, flowLine, foldTickers, foldable, footParts, groupChip, heldNews, isFolded, listStatus, liveFamilies, liveRows,
  markLegend, mintPrefix, nameIfDiffers, newsText, normSym, parentTag, parseSlot, parseTab, parseTf, postBlock, postMarkTitle, prefsUrl, ratioLine, readPref, repeatedSyms, rowAge, safetyChips,
  screenMints, sinceStart, sortTrend, sparkGeom, startMarkTitle, startedText, tradesByMint, trendItems, trendRows, trendingSub, txns, urlPrefs, writePref,
  type DscTab, type FamilyRow, type Live, type LiveTrade, type TrendGroup, type TrendShown, type TrendSort, type WakeNews,
} from "../lib/discover";
import { usd } from "../lib/format";
import { useEvents } from "../lib/events";
import { useStats, useTick } from "../lib/hooks";
import type { InstantSpec } from "../lib/instant-trade";
import { blockText, hardBlock, loadTradeRoute, type TradeBlock } from "../lib/trade-route";
import { openTradeSettings } from "../lib/trader";
import { ErrorBox, Logo, Skeleton, nameOf, sym } from "../components/Bits";
import QuickTrade from "../components/QuickTrade";
import { useToast } from "../components/Toast";
import { useInstantTrade, type Opening } from "../components/useInstantTrade";
import { useWakeAlertSwitch } from "../components/WakeAlerts";
import type { Side } from "../lib/pump";
import "../components/primitives.css";
import "../components/dsc.css";

const coinLink = (mint: string) => `/c/${encodeURIComponent(mint)}`;
const mapLink = (mint: string) => `/map?focus=${encodeURIComponent(mint)}`;
const nowS = () => Math.floor(Date.now() / 1000);
const store = () => (typeof window === "undefined" ? null : window.localStorage);
/// Trades of the coins on screen are applied in batches: one render per LIVE_FLUSH_MS however busy the stream is, and
/// at most LIVE_QUEUE_MAX waiting (the oldest go first; the next read covers them).
const LIVE_FLUSH_MS = 250;
const LIVE_QUEUE_MAX = 500;

/// What a Buy button needs from the page: `instant` trades the amount at once (useInstantTrade), otherwise Buy opens
/// the ticket with it filled in.
type TradeCtl = {
  opening: Opening; blocked: Record<string, { short: string; body: string }>; instant: boolean; sol: number;
  onInstant: (mint: string, spec: InstantSpec, label: string) => void; onTrade: (mint: string, amount: string) => void;
};

function Buy({ mint, label, t }: { mint: string; label: string; t: TradeCtl }) {
  const why = t.blocked[mint];
  if (why) return <span className="dsc-why" title={why.body}>{why.short} · <a href={pumpUrl(mint)} target="_blank" rel="noreferrer">pump.fun ↗</a></span>;
  const busy = t.opening?.mint === mint && t.opening.side === "buy";
  const text = buyLabel(t.sol);
  const press = () => (t.instant ? t.onInstant(mint, { side: "buy", sol: t.sol }, label) : t.onTrade(mint, String(t.sol)));
  return (
    <button type="button" className={`btn sm ghost dsc-buy ${busy ? "is-busy" : ""}`} disabled={!!t.opening} aria-busy={busy} aria-label={`${text} of ${label}`}
      title={t.instant ? `${text} of ${label} at once. The amount is the preset chosen above.` : `Open the trade for ${label} with ${t.sol} SOL filled in`} onClick={press}>{text}</button>
  );
}

/// The price over the last hour, one point per 2 minutes; green when the last close is at or above the first.
function PriceSpark({ s }: { s: CoinSpark | undefined }) {
  const W = 80, H = 24;
  const g = coinSparkPath(s?.p, W, H);
  return (
    <svg className={`dsc-cspark ${g.tone}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={coinSparkLabel(g)}>
      {g.d && <path d={g.d} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/// Measured shares of supply; amber at or above the threshold named in each chip's title.
function Safety({ s }: { s: CoinSafety | undefined }) {
  const chips = safetyChips(s);
  if (!chips.length) return null;
  return <span className="dsc-safety">{chips.map((c) => <span key={c.key} className={`dsc-chip${c.amber ? " amber" : ""}${c.pending ? " pending" : ""}`} title={c.title}>{c.text}</span>)}</span>;
}

type ShownRow = Row & Live & { left?: boolean };
/// One coin, shared by both lists: a table row on a wide screen, two lines in a narrow list and three in a phone-width
/// one (dsc.css container queries).
/// `rank`: its place in the server's order (Trending); `dup`: another row of the list has this ticker, so the start
/// of the mint tells them apart; `copy`: a row opened from a "+N same ticker" group.
function CoinRow({ c, t, tf, now, tagTitle, extra, since, rank, dup, copy: isCopy }: {
  c: ShownRow; t: TradeCtl; tf: Tf; now: number; tagTitle: Record<"existing" | "new", string>; extra?: ReactNode; since?: boolean; rank?: number | null; dup?: boolean; copy?: boolean;
}) {
  const tag = coinTag(c), copy = copyLine(c), ch = chgText(c.tf?.chg), x = txns(c.tf), by = buyersCell(c.tf, tf), ag = rowAge(c, now), nm = nameIfDiffers(c);
  const s0 = since && c.existing ? sinceStart(c.sinceStart, true) : null;
  // written twice: in the name line, and first on the tags line of a phone-width list (dsc.css shows one of the two)
  const meta = (
    <>
      <i className={`dsc-tag ${tag}`} title={tagTitle[tag]}>{tag}</i>
      {c.graduated === true && <i className="dsc-tag grad" title={GRAD_TITLE}>grad</i>}
      <span className="dsc-age" title={ag.title}>{ag.text}</span>
    </>
  );
  const mcapTitle = s0 && s0.text !== "—" ? `Market cap; change over ${tf}. Since this family woke up: ${s0.text}` : `Market cap; change over ${tf}`;
  return (
    <li className={`dsc-coin${c.left ? " left" : ""}${rank !== undefined ? " ranked" : ""}${isCopy ? " copy" : ""}`}>
      <div className="dsc-coin-main">
        <Link to={coinLink(c.mint)} className="dsc-coin-name" title={nameOf(c)}>
          {rank !== undefined && <span className="dsc-rank" title="Place in the list's own order">{rank ?? ""}<span className="dsc-vh">. </span></span>}
          <Logo src={c.image} label={c.symbol} size={24} />
          <span className="dsc-coin-id">
            <span className="dsc-coin-top">
              <b>{sym(c)}</b>
              {dup && <span className="dsc-mintp" title={MINT_PREFIX_TITLE}>{mintPrefix(c.mint)}</span>}
              {nm && <span className="dsc-coin-nm">{nm}</span>}
              <span className="dsc-meta in">{meta}</span>
            </span>
            {copy && <span className="dsc-copy">{copy}</span>}
          </span>
        </Link>
        <span className="dsc-coin-tags"><span className="dsc-meta out">{meta}</span>{extra}<Safety s={c.safety} /></span>
      </div>
      <span className="dsc-chart"><PriceSpark s={c.spark} /></span>
      <div className="dsc-nums">
        {/* Buyers first and in the brighter ink: it is what the lists are about, and "not sold" is what Trending ranks by */}
        <span className="dsc-num lead" title={by.title}><span className="dsc-k">Buyers {tf} </span><span className="dsc-v">{by.n}</span>{by.sub && <span className="dsc-sub2">{by.sub}</span>}</span>
        <span className="dsc-num" title={mcapTitle}>
          <span className="dsc-k">Mcap </span>
          {/* the key restarts the flash on each moving trade; a read without one remounts it plain */}
          <span key={c.flash?.n ?? 0} className={`dsc-v${c.flash ? ` dsc-flash ${c.flash.dir}` : ""}`}>{usd(c.mcapUsd)}</span>
          <span className="dsc-sub2 dsc-mc">
            <span className={ch.tone}>{ch.text}</span>
            {c.thin === true && <><span className="dsc-dot" aria-hidden="true"> · </span><span className="dsc-thin" title={THIN_TITLE}>{THIN_TEXT}<span className="dsc-vh">: market cap over 100 times the liquidity</span></span></>}
          </span>
        </span>
        <span className="dsc-num" title={LIQ_TITLE}><span className="dsc-k">Liquidity </span><span className="dsc-v">{usd(c.liqUsd)}</span></span>
        <span className="dsc-num" title={`Volume over ${tf}`}><span className="dsc-k">Volume {tf} </span><span className="dsc-v">{c.tf ? usd(c.tf.volUsd) : "—"}</span></span>
        {/* buys and sells on one line when they fit (they wrap to two when not), each with a letter and the word for
            screen readers: never told apart by colour alone */}
        <span className="dsc-num" title={`Trades over ${tf}: buys (B) and sells (S)`}>
          <span className="dsc-k">Txns {tf} </span><span className="dsc-v">{x.total}</span>
          <span className="dsc-sub2 dsc-bs">
            <span className="up"><span aria-hidden="true">B </span>{x.buys}<span className="dsc-vh"> buys</span></span>
            <span className="down"><span aria-hidden="true">S </span>{x.sells}<span className="dsc-vh"> sells</span></span>
          </span>
        </span>
      </div>
      {/* a blocked coin's reason takes its own line in a narrow list, so the numbers keep their width */}
      <span className={`dsc-act${t.blocked[c.mint] ? " blocked" : ""}`}><Buy mint={c.mint} label={sym(c)} t={t} /></span>
    </li>
  );
}

/// The column names over the rows (the cells carry their own names for screen readers and narrow lists). With
/// `onSort` (Trending) three of them are buttons that sort the rows received, largest first; pressing the chosen one
/// again gives the list's own order back. The list is a <ul>, not a table, so the buttons say pressed, not aria-sort.
function Cols({ tf, first, sort, onSort }: { tf: Tf; first: string; sort?: TrendSort; onSort?: (k: TrendSort) => void }) {
  const cell = (k: Exclude<TrendSort, "rank">, text: string) => (onSort ? (
    <button type="button" className={`dsc-sortb${sort === k ? " on" : ""}`} aria-pressed={sort === k} onClick={() => onSort(sort === k ? "rank" : k)}
      title={sort === k ? "Sorted by this column, largest first. Press again for the list's own order." : "Sort the rows by this column, largest first"}>{text}{sort === k && <span aria-hidden="true"> ↓</span>}</button>
  ) : <span aria-hidden="true">{text}</span>);
  return (
    <div className="dsc-cols" role={onSort ? "group" : undefined} aria-label={onSort ? "Sort the rows" : undefined}>
      <span aria-hidden="true">{first}</span><span aria-hidden="true">Last hour</span>{cell("buyers", `Buyers ${tf}`)}{cell("mcap", `Mcap · ${tf}`)}{cell("liq", "Liquidity")}
      <span aria-hidden="true">Volume {tf}</span><span aria-hidden="true">Txns {tf}</span><span aria-hidden="true" />
    </div>
  );
}

const XIcon = <svg className="dsc-x" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.9L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" /></svg>;

/// Buyers per 5 min over the last 2 h on a faint band at the family's normal level, with a line where buying jumped
/// and an X where the linked post was posted (when it falls inside the 2 h). One line, on the ratio's basis (buyers of
/// existing coins, lib/discover.ts chartSeries). Its last point is the last complete 5-min bucket; the ratio printed
/// above it counts the 5 minutes to now, so the two meet only just after a bucket closes. A touch or narrow screen
/// has no hover for the marks, so a line under the chart names the ones drawn (dsc.css shows it there).
function FamilyChart({ f, bucketS, now }: { f: FamilyRow; bucketS: number; now: number }) {
  const W = 600, H = 56;
  const cs = chartSeries(f);
  const g = sparkGeom(cs.series, f.baseline, W, H);
  const m = chartMarks(f, bucketS, W);
  const postAt = f.post?.at;
  const postX = typeof postAt === "number" ? m.post : null;
  const legend = markLegend({ start: m.start, post: postX });
  return (
    <div className="dsc-fchart-wrap">
      <div className="dsc-fchart" role="img" aria-label={familyChartLabel(f, bucketS, now)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <rect className="dsc-spark-band" x="0" y={g.bandY} width={W} height={Math.max(0, H - g.bandY)} />
          <polyline className="dsc-spark-line" points={g.points} vectorEffect="non-scaling-stroke" />
        </svg>
        {m.start !== null && <span className="dsc-mark start" style={{ left: `${m.start}%` }} title={startMarkTitle(f.startedAt, now)} aria-label={startMarkTitle(f.startedAt, now)} />}
        {postX !== null && typeof postAt === "number" && <span className="dsc-mark post" style={{ left: `${postX}%` }} title={postMarkTitle(postAt, now)} aria-label={postMarkTitle(postAt, now)}><i>{XIcon}</i></span>}
        <span className="dsc-axis" aria-hidden="true"><span>2 h ago</span><span>{chartAxis(cs.ex)}</span><span>now</span></span>
      </div>
      {legend.length > 0 && <p className="dsc-legend" aria-hidden="true">{legend.map((l) => <span key={l.kind} className={l.kind}>{l.kind === "post" ? XIcon : <i />}{l.text}</span>)}</p>}
    </div>
  );
}

/// The post most of the moving coins link, as a block: who, when against the jump, the text (3 lines, "Show more"),
/// and "View post" (the link is rebuilt from the id). The note on what a linked post is goes with it.
function PostBlock({ f, now }: { f: FamilyRow; now: number }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const textEl = useRef<HTMLParagraphElement>(null);
  const b = f.post ? postBlock(f.post, f.startedAt, now) : null;
  const text = b?.text ?? "";
  // "Show more" only when the 3 clamped lines hide something, measured again when the width changes
  useLayoutEffect(() => {
    const el = textEl.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  if (!b) return null;
  return (
    <div className="dsc-postb" aria-describedby={id}>
      <p className="dsc-postb-head" title={POST_NOTE}>{XIcon}<span>Linked post</span>{b.handle && <b>{b.handle}</b>}<span className="dsc-postb-coins">{b.linked}</span></p>
      {b.lead && <p className="dsc-postb-lead">{b.lead}</p>}
      {text && <p ref={textEl} className={`dsc-postb-text${open ? " open" : ""}`}>{text}</p>}
      {((text && (long || open)) || b.href) && (
        <p className="dsc-postb-act">
          {text && (long || open) && <button type="button" className="linkish dsc-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : "Show more"}</button>}
          {b.href && <a className="dsc-link" href={b.href} target="_blank" rel="noopener noreferrer">View post ↗</a>}
        </p>
      )}
      <span id={id} className="dsc-vh">{POST_NOTE}</span>
    </div>
  );
}

function Card({ f, now, open, onToggle, t, tf, bucketS }: { f: FamilyRow; now: number; open: boolean; onToggle: () => void; t: TradeCtl; tf: Tf; bucketS: number }) {
  const p = f.parent;
  // folded only when cooling AND under 3x now (the fold is kept as shown while the list is in use)
  const canFold = f.fold ?? foldable(f);
  const folded = isFolded(f, open);
  const left = f.left ? " left" : "";
  // Show and Hide are different buttons in different trees, so the pressed one unmounts: focus moves to its
  // counterpart, or a keyboard reader would land on the page top and the list would stop being held
  const toggleEl = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const press = (e: { currentTarget: HTMLButtonElement }) => { refocus.current = document.activeElement === e.currentTarget; onToggle(); };
  useLayoutEffect(() => { if (refocus.current) { refocus.current = false; toggleEl.current?.focus(); } }, [folded]);
  if (folded) {
    const line = coolingLine(f, now);
    return (
      <li className={`dsc-card st-cooling folded${left}`}>
        <div className="dsc-fold">
          <Logo src={p.image} label={p.symbol} size={20} />
          <span className="dsc-fold-text" title={line}>{f.left ? `${line} · ${LEFT_PILL}` : line}</span>
          <button ref={toggleEl} type="button" className="linkish dsc-link" aria-expanded={false} aria-label={`Show ${sym(p)}`} onClick={press}>Show</button>
        </div>
      </li>
    );
  }
  const foot = footParts(f.more, f.hidden, f.dust);
  const coins = Array.isArray(f.coins) ? f.coins : [];
  const dups = repeatedSyms(coins);
  const pill = f.left ? LEFT_PILL : startedText(f, now);
  const facts = factsLine(f);
  return (
    // state classes are "st-" prefixed: the app's global .live (the stream dot, styles.css) lowercases text and turns
    // every <i> inside into a 7 px dot
    <li className={`dsc-card st-${f.state}${left}`}>
      <div className="dsc-head">
        <Logo src={p.image} label={p.symbol} size={32} />
        <div className="dsc-title">
          <span className="dsc-name">
            <Link to={p.isCoin ? coinLink(p.mint) : mapLink(p.mint)} title={p.isCoin ? `${nameOf(p)}: chart and trading` : `${nameOf(p)} and the coins under it on the map`}><b>{sym(p)}</b></Link>
            <span className={`dsc-pill st-${f.left ? "left" : f.state}`} title={f.silent === true && !f.left ? SILENT_TITLE : undefined}><i aria-hidden="true" />{pill}</span>
          </span>
          <p className="dsc-line" title={ratioLine(f)}>{ratioLine(f)}</p>
          {/* how many coins carry the buying, and USD bought / sold over 5 min: counts, in the muted ink, no verdict */}
          {facts && <p className="dsc-facts" title={flowLine(f) ? FLOW_TITLE : undefined}>{facts}</p>}
        </div>
      </div>
      <FamilyChart f={f} bucketS={bucketS} now={now} />
      {f.post && <PostBlock f={f} now={now} />}
      {coins.length > 0 && (
        <section className="dsc-coins" aria-label={`Coins under ${sym(p)} being bought now`}>
          <Cols tf={tf} first="Being bought now" />
          <ul>{coins.map((c) => <CoinRow key={c.mint} c={c} t={t} tf={tf} now={now} tagTitle={TAG_TITLE} since dup={dups.has(normSym(c.symbol))} />)}</ul>
        </section>
      )}
      {(foot.length > 0 || canFold) && (
        <p className="dsc-foot">
          {/* the other coins trading are only on the map: the count links there */}
          <span>{foot.map((x, i) => <span key={x.text} title={x.title}>{i > 0 ? " · " : ""}{x.map ? <Link className="dsc-link" to={mapLink(p.mint)} title={`${sym(p)} and the coins under it on the map`}>{x.text}</Link> : x.text}</span>)}</span>
          {canFold && <button ref={toggleEl} type="button" className="linkish dsc-link" aria-expanded={true} aria-label={`Hide ${sym(p)}`} onClick={press}>Hide</button>}
        </p>
      )}
    </li>
  );
}

/// A trending row's tags: its parent (on the map), the family's state when that family is on the first list, and
/// "No longer listed" for a row kept only while the list is in use (the dimming alone says nothing to a screen reader).
function TrendTags({ r, group, onGroup }: { r: TrendShown; group: TrendGroup | null; onGroup: (key: string) => void }) {
  const tag = parentTag(r), pill = familyPill(r);
  if (!tag && !pill && !r.left && !group) return null;
  return (
    <span className="dsc-ptags">
      {group && <button type="button" className="dsc-chip dsc-group" aria-expanded={group.open} title={GROUP_TITLE} onClick={() => onGroup(group.key)}>{groupChip(group)}</button>}
      {r.left && <span className="dsc-pill sm st-left" title="The server stopped listing this coin; the row goes once the list is idle">{LEFT_PILL}</span>}
      {tag && r.parent && <Link className="dsc-ptag" to={mapLink(r.parent.mint)} title={`${tag.replace(/^under /, "")} and the coins under it on the map`}>{tag}</Link>}
      {pill && <span className={`dsc-pill sm st-${r.family}`} title={r.family === "live" ? "This family is listed under Waking up" : "This family is listed under Waking up, cooling"}><i aria-hidden="true" />{pill}</span>}
    </span>
  );
}

function AlertButton() {
  const { ui, toggle } = useWakeAlertSwitch();
  const live = ui === "on" || ui === "off";
  return (
    <button type="button" className={`btn sm ${ui === "on" ? "soft" : "ghost"} dsc-alert`} aria-pressed={ui === "on"} disabled={!live} title={ALERT_TITLE[ui]} onClick={toggle}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
      {ALERT_LABEL[ui]}
    </button>
  );
}

/// Arrow keys between the buttons of a tab list or a radio group (one tab stop for the group).
function roveKeys<K extends string>(keys: readonly K[], value: K, set: (k: K) => void) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    // React clears currentTarget once the handler returns: kept for the focus after the re-render
    const group = e.currentTarget;
    const i = (keys.indexOf(value) + d + keys.length) % keys.length;
    set(keys[i]);
    queueMicrotask(() => group.querySelectorAll<HTMLElement>("[role=radio],[role=tab]")[i]?.focus());
  };
}
function Seg<K extends string>({ label, items, value, onChange }: { label: string; items: readonly { key: K; text: string; title: string }[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="dsc-seg" role="radiogroup" aria-label={label} onKeyDown={roveKeys(items.map((x) => x.key), value, onChange)}>
      {items.map((x) => <button key={x.key} type="button" role="radio" aria-checked={x.key === value} tabIndex={x.key === value ? 0 : -1} className={x.key === value ? "on" : ""} title={x.title} onClick={() => onChange(x.key)}>{x.text}</button>)}
    </div>
  );
}

// ---- a list read every 10 s, held while in use

type HeldList<R> = {
  rows: R[] | null; setRows: Dispatch<SetStateAction<R[] | null>>; error: string | null; stale: boolean; retry: () => void;
  /// the key the rows on screen were read for (the timeframe their numbers and labels belong to)
  shownKey: string | null;
  /// the last read was applied with the order held; `pending`: what started meanwhile (`news`); `showNow` applies
  /// the server's order whatever is in use
  paused: boolean; pending: WakeNews[]; showNow: () => void;
  listRef: (el: HTMLUListElement | null) => void;
  listProps: { onPointerEnter: (e: ReactPointerEvent) => void; onPointerDown: (e: ReactPointerEvent) => void; onPointerLeave: (e: ReactPointerEvent) => void; onBlur: (e: ReactFocusEvent<HTMLUListElement>) => void };
};
/// `key` names what is read (the timeframe): rows of another key are `stale` (dimmed) until the first read of this one.
/// `merge` gets when the read's answer arrived (ms, this browser's clock), for carryLive.
/// `news` (optional): what a held merge of this answer leaves unseen, given the rows on screen and what was pending.
function useHeldList<B, R>(enabled: boolean, key: string, read: () => Promise<B>, merge: (b: B, was: R[], hold: boolean, readAt: number) => R[], frozen: boolean,
  news?: (b: B, was: R[], pending: WakeNews[]) => WakeNews[]): HeldList<R> {
  const [rows, setRows] = useState<R[] | null>(null);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const readRef = useRef(read); readRef.current = read;
  const mergeRef = useRef(merge); mergeRef.current = merge;
  const frozenRef = useRef(frozen); frozenRef.current = frozen;
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState<WakeNews[]>([]);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const newsRef = useRef(news); newsRef.current = news;
  // after a merge: whether the order was held, and what that left unseen (nothing once the server's order is applied)
  const note = (d: B, hold: boolean) => {
    const was = rowsRef.current, on = hold && was !== null;
    const next = on && newsRef.current ? newsRef.current(d, was, pendingRef.current) : [];
    setPaused(on);
    setPending((p) => (next.length === 0 && p.length === 0 ? p : next));
  };
  // a mouse over the list; a finger gives no hover (pointerleave follows every tap), so a touch or pen holds the list
  // for TOUCH_HOLD_MS after its last pointerdown on it (a tap, or the start of a scroll), and a timer settles it after
  const over = useRef(false);
  const touchedAt = useRef(0);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listEl = useRef<HTMLUListElement | null>(null);
  // a list removed under a resting mouse gets no pointerleave (a tab switched with the arrow keys, an empty answer):
  // the flag is cleared with it, or the list would stay held for good once shown again
  const listRef = useCallback((el: HTMLUListElement | null) => { listEl.current = el; if (!el) over.current = false; }, []);
  // only keyboard focus counts (a clicked button keeps focus on Windows, which would hold the order for good)
  const held = () => over.current || Date.now() - touchedAt.current < TOUCH_HOLD_MS || !!listEl.current?.querySelector(":focus-visible");
  // the latest answer, with the key it was read for and when it arrived
  const lastBody = useRef<{ d: B; key: string; at: number } | null>(null);
  // the latest read, applied: in the server's shape once idle, merged into what is on screen while still held (a read
  // that landed under the ticket is applied when it closes, and its key is then the one on screen)
  const settle = () => {
    const b = lastBody.current;
    if (frozenRef.current || b === null) return;
    if (rowsRef.current === null) return;
    const hold = held();
    note(b.d, hold);
    setRows((was) => (was ? mergeRef.current(b.d, was, hold, b.at) : was));
    setLoadedKey(b.key);
  };
  const showNow = useCallback(() => {
    const b = lastBody.current;
    if (frozenRef.current || b === null) return;
    setRows((was) => (was ? mergeRef.current(b.d, was, false, b.at) : was));
    setLoadedKey(b.key);
    setPaused(false);
    setPending((p) => (p.length ? [] : p));
  }, []);
  const settleRef = useRef(settle); settleRef.current = settle;
  useEffect(() => settleRef.current(), [frozen]);
  useEffect(() => () => clearTimeout(touchTimer.current), []);
  useEffect(() => {
    if (!enabled) return;
    let alive = true, busy = false, last = 0;
    const load = () => {
      if (busy || document.hidden || frozenRef.current) return;
      busy = true;
      readRef.current().then((d) => {
        if (!alive) return;
        const at = Date.now();
        last = at; lastBody.current = { d, key, at };
        setError(null);
        // the ticket opened while this read was under way: kept for settle, not applied under it
        if (frozenRef.current) return;
        const hold = held();
        note(d, hold);
        setRows((was) => mergeRef.current(d, was ?? [], hold, at));
        setLoadedKey(key);
      }, (e) => { if (alive) setError(errorMessage(e)); }).finally(() => { busy = false; });
    };
    load();
    const timer = setInterval(load, DISCOVER_POLL_MS);
    // back on the tab: read at once when the list on screen is older than one interval
    const onVisible = () => { if (!document.hidden && Date.now() - last >= DISCOVER_POLL_MS) load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, nonce]);
  const retry = useCallback(() => { setError(null); setNonce((n) => n + 1); }, []);
  const listProps: HeldList<R>["listProps"] = {
    onPointerEnter: (e) => { if (e.pointerType === "mouse") over.current = true; },
    onPointerDown: (e) => {
      if (e.pointerType === "mouse") return;
      touchedAt.current = Date.now();
      clearTimeout(touchTimer.current);
      touchTimer.current = setTimeout(() => settleRef.current(), TOUCH_HOLD_MS + 50);
    },
    onPointerLeave: (e) => { if (e.pointerType === "mouse") { over.current = false; settle(); } },
    onBlur: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) queueMicrotask(() => settleRef.current()); },
  };
  return { rows, setRows, error, stale: rows !== null && loadedKey !== key, retry, shownKey: loadedKey, paused, pending, showNow, listRef, listProps };
}

const Skel = ({ n = 3 }: { n?: number }) => (
  <ul className="dsc-list" aria-busy="true" aria-label="Loading the list">{Array.from({ length: n }, (_, i) => (
    <li key={i} className="dsc-card dsc-skel"><div className="dsc-skel-head"><Skeleton h={32} w={32} r={999} /><span><Skeleton h={14} w={`${40 - i * 6}%`} /><Skeleton h={10} w={`${64 - i * 8}%`} /></span></div><Skeleton h={10} /><Skeleton h={10} w="80%" /></li>
  ))}</ul>
);

const TABS: readonly { key: DscTab; text: string }[] = [{ key: "waking", text: "Waking up" }, { key: "trending", text: "Trending" }];

export default function Discover() {
  useEffect(() => { document.title = "Discover · Spore"; return () => { document.title = "Spore"; }; }, []);
  useTick(AGO_TICK_MS);
  const now = nowS();
  const uid = useId();
  // ?tab= and ?tf= name the view: on load a valid one wins over the stored choice, and a change is written back to
  // the address (no history entry per click), so it can be kept or passed on. Written with history.replaceState and
  // the router's own state object, not setParams: to the shell any router navigation is a new page and it scrolls to
  // the top (App.tsx useScrollRestoration), which took the tab or timeframe out from under the finger
  const [params] = useSearchParams();
  const [tab, setTabState] = useState<DscTab>(() => urlPrefs(params.toString()).tab ?? readPref(store, TAB_KEY, parseTab));
  const [tf, setTfState] = useState<Tf>(() => urlPrefs(params.toString()).tf ?? readPref(store, TF_KEY, parseTf));
  const [slot, setSlotState] = useState<number>(() => readPref(store, SLOT_KEY, parseSlot));
  const setUrl = (k: "tab" | "tf", v: string) => { try { window.history.replaceState(window.history.state, "", prefsUrl(window.location, k, v)); } catch { /* the address is a convenience; the choice is kept in storage */ } };
  const setTab = (v: DscTab) => { setTabState(v); writePref(store, TAB_KEY, v); setUrl("tab", v); };
  const setTf = (v: Tf) => { setTfState(v); writePref(store, TF_KEY, v); setUrl("tf", v); };
  const setSlot = (v: number) => { setSlotState(v); writePref(store, SLOT_KEY, String(v)); };
  // the cooling cards the reader opened
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const { stats } = useStats();
  const { connection } = useConnection();
  const toast = useToast();

  // ---- Buy: the map's and coin page's flow (components/useInstantTrade.ts), with the reader's Trade-with choice signing
  const [trade, setTrade] = useState<{ coin: Coin; side: Side; amount?: string } | null>(null);
  const [blocked, setBlocked] = useState<Record<string, { short: string; body: string }>>({});
  const showBlock = useCallback((block: TradeBlock, coin: Coin) => {
    const b = blockText(block, coin);
    // a gap passes once the index holds the coins above: it is said once and the button stays, so the next click checks again
    if (block.kind === "gap") toast.info(`${b.title}. ${b.body}`);
    else setBlocked((m) => ({ ...m, [coin.mint]: { short: b.short, body: b.body } }));
  }, [toast]);
  const { ready, opening, busy, begin, end, alive, settings, hasWallet, run: onInstant } = useInstantTrade({ onTicket: setTrade, onBlocked: showBlock }, { signer: "chosen" });
  // Buy through the ticket (instant trades off, or no wallet yet): it needs the coin's full record; a route check that
  // fails (the RPC) opens it anyway
  const onTrade = useCallback(async (mint: string, amount: string) => {
    if (busy() || !ready()) return;
    begin(mint, "buy");
    try {
      const { coin } = await api.coin(mint, { children: false, trades: false });
      const route = await loadTradeRoute(connection, coin).catch(() => null);
      if (!alive.current) return;
      const block = hardBlock(route);
      if (!block) setTrade({ coin, side: "buy", amount });
      else showBlock(block, coin);
    } catch (e) {
      toast.error(`Could not open the trade: ${errorMessage(e)}`);
    } finally {
      end();
    }
  }, [connection, toast, ready, showBlock, busy, begin, end, alive]);
  const presets = settings.buyPresets;
  const sol = presets[slot] ?? presets[0];
  const t: TradeCtl = { opening, blocked, instant: settings.instant && hasWallet, sol, onInstant, onTrade };
  // nothing read is applied under the open ticket (the row under the pointer must not change), nor while a Buy is
  // under way: an unlock prompt or a slow trade outlasts the 5 s touch hold, and an idle read could then fold the row
  // with the busy button under a new copy of its ticker
  const frozen = !!trade || !!opening;
  // a row showing why it cannot be bought is never folded under another (the reason must stay in sight)
  const blockedRef = useRef<ReadonlySet<string>>(new Set());
  blockedRef.current = useMemo(() => new Set(Object.keys(blocked)), [blocked]);

  // ---- the two lists (only the tab on screen is read)
  // a live price is carried over a read by when it arrived against when the read arrived (one clock, this browser's)
  const mergeFams = useCallback((d: DiscoverBody, was: FamilyRow[], hold: boolean, readAt: number) => carryLiveFamilies(familyRows(d, was, hold), was, readAt), []);
  // Trending: the header's sort (the rows received, re-sorted at each idle read and held like any order while the
  // list is in use), and the "+N same ticker" groups the reader opened (by ticker + parent, so they stay open over reads)
  const [sort, setSortState] = useState<TrendSort>("rank");
  const sortRef = useRef(sort); sortRef.current = sort;
  const [groups, setGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (key: string) => setGroups((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // the list's floor as the server applied it (1m: coins with 5+ buyers in the last minute), with the timeframe it is for
  // and how many rows it sent: `candidates` is counted before the creator checks, dust and the cap, so the two can differ
  const [trendMeta, setTrendMeta] = useState<{ tf: Tf; floor?: number; floor5m?: number; candidates?: number; listed: number } | null>(null);
  const mergeTrend = useCallback((d: Trending, was: TrendShown[], hold: boolean, readAt: number) => carryLive(trendRows(d, was, hold, sortRef.current, blockedRef.current), was, readAt), []);
  const famNews = useCallback((d: DiscoverBody, was: FamilyRow[], pending: WakeNews[]) => heldNews(d, was, pending), []);
  const [bucketS, setBucketS] = useState(300);
  const fam = useHeldList<DiscoverBody, FamilyRow>(tab === "waking", tf, () => api.discover(tf).then((d) => { if (d.bucketS > 0) setBucketS(d.bucketS); return d; }), mergeFams, frozen, famNews);
  const trend = useHeldList<Trending, TrendShown>(tab === "trending", tf, () => api.trending(tf).then((d) => { setTrendMeta({ tf, floor: d.floor, floor5m: d.floor5m, candidates: d.candidates, listed: Array.isArray(d.rows) ? d.rows.length : 0 }); return d; }), mergeTrend, frozen);
  const toggle = (mint: string) => setOpened((s) => { const n = new Set(s); if (n.has(mint)) n.delete(mint); else n.add(mint); return n; });
  const setSort = (k: TrendSort) => { setSortState(k); trend.setRows((r) => (r ? foldTickers(sortTrend(r, k), blockedRef.current) : r)); };
  // the first load only: when every card would be a folded line, the first family is opened (never on a refresh:
  // that would move what is under the pointer)
  const autoOpened = useRef(false);
  useLayoutEffect(() => {
    if (autoOpened.current || fam.rows === null) return;
    autoOpened.current = true;
    const m = firstOpen(fam.rows);
    if (m) setOpened((s) => new Set(s).add(m));
  }, [fam.rows]);

  // ---- live numbers: the trades of the coins on screen, applied in batches
  const mints = useMemo(() => (tab === "waking" ? screenMints(fam.rows, null, opened) : screenMints(null, trend.rows)), [tab, fam.rows, trend.rows, opened]);
  const mintsRef = useRef(mints); mintsRef.current = mints;
  const queue = useRef<LiveTrade[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setFams = fam.setRows, setTrend = trend.setRows;
  const flush = useCallback(() => {
    flushTimer.current = undefined;
    const q = queue.current;
    queue.current = [];
    if (!q.length) return;
    const by = tradesByMint(q);
    setFams((r) => (r ? liveFamilies(r, by) : r));
    setTrend((r) => (r ? liveRows(r, by) : r));
  }, [setFams, setTrend]);
  useEvents({
    trade: (tr) => {
      if (!mintsRef.current.has(tr.mint) || !(typeof tr.priceUsd === "number" && tr.priceUsd > 0)) return;
      if (queue.current.length >= LIVE_QUEUE_MAX) queue.current.shift();
      queue.current.push({ mint: tr.mint, time: tr.time, priceUsd: tr.priceUsd, at: Date.now() });
      if (flushTimer.current === undefined) flushTimer.current = setTimeout(flush, LIVE_FLUSH_MS);
    },
  }, mints.size > 0);
  useEffect(() => () => clearTimeout(flushTimer.current), []);

  const tabId = (k: DscTab) => `${uid}-tab-${k}`, panelId = `${uid}-panel`;
  const tfItems = TFS.map((k) => ({ key: k, text: k, title: TF_TITLE[k] }));
  const slotKeys = presets.map((_, i) => String(i));
  const slotItems = presets.map((v, i) => ({ key: String(i), text: `P${i + 1}`, title: `Buy ${v} SOL` }));

  // while the first read of a new timeframe is under way the rows still hold the last one's numbers: they keep its
  // labels (dimmed), and a read that fails says so with a retry instead of leaving them under the new labels silently
  const famTf = fam.stale ? parseTf(fam.shownKey) : tf, trendTf = trend.stale ? parseTf(trend.shownKey) : tf;
  const staleErr = (x: { stale: boolean; error: string | null; retry: () => void }, was: Tf) => (x.stale && x.error ? (
    <p className="dsc-stale-err" role="status" title={x.error}>
      Could not load the {tf} numbers; the dimmed rows show {was}. <button type="button" className="linkish dsc-link" onClick={x.retry}>Retry</button>
    </p>
  ) : null);
  const news = newsText(fam.pending);
  const cur = tab === "waking" ? fam : trend;
  const status = listStatus({ error: cur.error, hasRows: !!cur.rows?.length, paused: cur.paused, stale: cur.stale });
  const meta = trendMeta && trendMeta.tf === trendTf ? trendMeta : null;
  const trendDups = useMemo(() => repeatedSyms(trend.rows), [trend.rows]);
  const items = useMemo(() => trendItems(trend.rows ?? [], groups), [trend.rows, groups]);
  const byHolding = !!trend.rows?.some((r) => typeof r.tf?.holding === "number");
  const famView = fam.rows === null ? (
    fam.error ? <ErrorBox error="The list could not be loaded." retry={fam.retry} details={fam.error} /> : <Skel />
  ) : fam.rows.length === 0 ? (
    <p className="dsc-empty">No family is buying far above its normal level right now. <button type="button" className="linkish dsc-link" onClick={() => setTab("trending")}>See trending coins</button></p>
  ) : (
    <>
      {staleErr(fam, famTf)}
      {/* a wake-up that started while the order is held: named here, over the list (the wrapper takes no height, so
          nothing under the pointer moves); Show applies the server's order */}
      <div className="dsc-new" role="status">
        {/* the names are cut when two long tickers do not fit a phone; "· Show" keeps its width */}
        {news && <button type="button" className="dsc-new-pill" title={`${news}. Show the list in its current order`} onClick={fam.showNow}><span className="dsc-new-names">{news}</span><span className="dsc-new-show">· <u>Show</u></span></button>}
      </div>
      <ul className={`dsc-list${fam.stale ? " stale" : ""}`} aria-busy={fam.stale || undefined} aria-label="Families buying far above their normal level" ref={fam.listRef} {...fam.listProps}>
        {fam.rows.map((f) => <Card key={f.parent.mint} f={f} now={now} open={opened.has(f.parent.mint)} onToggle={() => toggle(f.parent.mint)} t={t} tf={famTf} bucketS={bucketS} />)}
      </ul>
    </>
  );
  const trendView = trend.rows === null ? (
    trend.error ? <ErrorBox error="The list could not be loaded." retry={trend.retry} details={trend.error} /> : <Skel n={1} />
  ) : trend.rows.length === 0 ? (
    <p className="dsc-empty">{emptyTrending(tf, meta?.floor, meta?.candidates, meta?.floor5m)}</p>
  ) : (
    <>
      {staleErr(trend, trendTf)}
      <section className={`dsc-card dsc-trend${trend.stale ? " stale" : ""}`} aria-busy={trend.stale || undefined}>
        <div className="dsc-coins">
          <Cols tf={trendTf} first="Coin" sort={sort} onSort={setSort} />
          <ul aria-label={trendingSub(trendTf, byHolding, sort)} ref={trend.listRef} {...trend.listProps}>
            {items.map(({ row: r, group, copy }) => (
              <CoinRow key={r.mint} c={r} t={t} tf={trendTf} now={now} tagTitle={TAG_TITLE_QUIET} rank={r.rank ?? null} dup={trendDups.has(normSym(r.symbol))} copy={copy}
                extra={<TrendTags r={r} group={group} onGroup={toggleGroup} />} />
            ))}
          </ul>
        </div>
      </section>
    </>
  );

  return (
    <div className="dsc-page">
      <header className="dsc-top">
        <div className="dsc-top-text">
          <h1>Discover</h1>
          <p className="dsc-sub">{tab === "waking" ? "Families buying far above their normal level, newest first" : [trendingSub(tf, byHolding, sort), floorLine(meta, tf, meta?.listed)].filter(Boolean).join(" · ")}</p>
        </div>
        <AlertButton />
      </header>
      <div className="dsc-bar">
        <div className="dsc-bar-l">
          <div className="dsc-tabs" role="tablist" aria-label="Lists" onKeyDown={roveKeys(TABS.map((x) => x.key), tab, setTab)}>
            {TABS.map((x) => (
              <button key={x.key} id={tabId(x.key)} type="button" role="tab" aria-selected={tab === x.key} aria-controls={panelId} tabIndex={tab === x.key ? 0 : -1}
                className={tab === x.key ? "on" : ""} onClick={() => setTab(x.key)}>{x.text}</button>
            ))}
          </div>
          {/* one quiet word: the order is held while the list is in use, or a poll failed. Cut, never wrapped, so it
              cannot push the bar or the list */}
          <span className="dsc-status" role="status" title={status || undefined}>{status}</span>
        </div>
        <div className="dsc-ctl">
          <Seg label="Timeframe" items={tfItems} value={tf} onChange={setTf} />
          <span className="dsc-slots">
            <Seg label="Buy amount" items={slotItems} value={slotKeys[slot] ?? "0"} onChange={(k) => setSlot(parseSlot(k))} />
            <b className="dsc-amt" title={t.instant ? "Buy trades this amount at once" : "Buy opens the trade with this amount filled in"}>{sol} SOL</b>
            <button type="button" className="linkish dsc-link" title="Change the three amounts in Trade settings" onClick={() => openTradeSettings()}>Edit</button>
          </span>
        </div>
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(tab)} className="dsc-panel">
        {tab === "waking" ? famView : trendView}
      </div>
      <p className="dsc-note">{FOOT_NOTE}</p>
      {trade && <QuickTrade coin={trade.coin} side={trade.side} amount={trade.amount} solUsd={stats?.solUsd ?? null} onClose={() => setTrade(null)} />}
    </div>
  );
}
