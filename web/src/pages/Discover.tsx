// Discover: one list of what is being bought right now (GET /api/stories), in the calm style of the Portfolio page.
// ONE LIST, ONE STYLE: every coin, in a story or not, is the same coin row (CoinRow), and stories and single coins are
// ranked together by buyers over the chosen timeframe (lib/discover.ts oneList: a story by the sum over its coins,
// copies included; a single coin by its own; then more coins, then the order received).
// - A story (two or more coin rows of one card) is a contained block in the list (its own border, a tinted ground,
//   rounded corners; its rows are the same rows, in the same columns): a header of the title (a narrative's,
//   title-cased; "Linked post"; "$SYM family") with its theme pill, on the right the story's buyers over the timeframe
//   in bold and, muted, "buyers · 3 coins · 1 new"; under the title a small muted line: "@handle · 6 min ago" (a link
//   to the post on x.com, rebuilt from the id), a post story's words after it, or a family's "waking up · 12 min"
//   (lib/discover.ts storyHeader). The three coins with the most buyers show; the rest wait behind "+N more coins", which opens in place. A
//   narrative story lists its new coins (created in the last hour, a small "new" pill) first, then the older ones.
// - The subject line (lib/discover.ts subjectLine, SubjectLineBlock below) leads every story header and every single
//   coin that has a story: "Subject: what happened", the subject in the accent, the sentence in ink. With a server
//   that writes post lines (POST_LINES=on) it is a language model's summary of the starting post, marked "AI"; the
//   poster's own words are its hover title and open under it on a click or tap, with a link to the post. Without one
//   it falls back to the poster's words in quote marks, a narrative's title, or the family.
// - A post or family card of one coin, and a loose coin with a story's tag while narratives are shown, is a slim card:
//   the subject line on top, the coin's usual row under it (the theme as one small tag). A loose coin with no story
//   is a plain row.
// - The first 20 entries (a story or a single coin), then "Show 20 more" until all are shown.
// - "N hidden as bot dust · Show": coins left out of the list (a market cap over 100 times the liquidity, or under $5
//   bought a buyer), each with a "Paper cap" or "Tiny buys" chip once shown.
// The size pills (All / Small / Mid / Large by market cap, kept in this browser) filter what was received: a story
// whose coins are all filtered out is gone, and a story's numbers count the coins it still shows (lib/discover.ts
// filterStories, tfTotals). A row stays under the pill of its read: a live trade moves its market cap, never the list.
// Coins with the same ticker and image are folded under the one with the most liquidity and listed under it (launch
// time, liquidity, buyers); none is called the original.
// Narrative tags (a server with NARRATIVES=on, and at least one narrative card in the read; otherwise nothing of this
// is drawn): a row of theme pills under the size pills ("All themes" and the themes of the narrative cards, in a fixed
// order by name; the choice is kept in this browser) keeps the stories of that theme and the single coins tagged with
// it; it combines with the size. A pill once shown stays for the visit and the chosen theme stays in force when its
// last story drops out, so the filter only ever changes by a click. A title is written by a language model:
// untrusted, drawn as a React text node on one line, never as markup or in an address. A post is what the coins link,
// picked by their creators and unchecked: the page says who posted and when, never why a coin is bought or what it
// will do.
// Every number follows the timeframe switch (1m / 5m / 30m / 1h, the `tf=` of the read, kept in this browser): a row's
// buyers ("96 not sold"), market cap change, volume and txns are the read's `tf` numbers, a story's totals and the
// ranking add up those buyers, and the column names say the timeframe ("Buyers · 5m"). The sparkline is the last hour.
// Buy shows its amount ("Buy 0.5 SOL"): one of the trade settings' three buy presets (P1 / P2 / P3 in the bar; the
// amounts are edited in Trade settings), and Buy runs the same instant trade as the map and the coin page
// (components/useInstantTrade.ts: the reader's Trade-with choice signs, a locked trading wallet is asked to unlock, a
// failed check opens the ticket); with instant trades off or no wallet it opens the ticket with the amount filled in.
// No other signing path.
// Live numbers: the SSE "trade" of the coins on screen moves their price, market cap (flashing once), change and
// sparkline between reads (lib/discover.ts liveMerge); the view is read every 10 s while the tab is visible. Nothing
// moves while the list is in use (a mouse over it, a tap or scroll on it in the last 5 s, or keyboard focus in it):
// stories and rows keep their places and take fresh numbers, a new one is added at the end and one that left stays,
// dimmed ("Moved to another story" when it is listed elsewhere now); the ranking comes back once the page is idle
// (storiesView, oneList). Under an open ticket, or while a Buy is under way, no read is applied.
// Every class here starts with "dsc-" (components/dsc.css; discover.css belongs to the Coins page).
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type Dispatch, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useConnection } from "@solana/wallet-adapter-react";
import { api, errorMessage, pumpUrl, type Coin, type CoinSafety, type CoinSpark, type Stories, type Tf } from "../lib/api";
import {
  AGO_TICK_MS, ALERT_LABEL, ALERT_TITLE, ALL_THEMES, COPIES_TITLE, DISCOVER_POLL_MS, DUST_NOTE, FOOT_NOTE, GRAD_TITLE, LEFT_PILL, LIQ_TITLE, MINT_PREFIX_TITLE, MODEL_NOTE, MOVED_PILL, MOVED_TITLE, NEW_ROW_PILL, NEW_ROW_TITLE, REGROUPED_PILL, REGROUPED_TITLE,
  SIZES, SIZE_KEY, SLOT_KEY, STORIES_SUB, TAG_NOTE, TAG_TITLE_QUIET, TFS, TF_KEY, TF_TITLE, THEME_KEY, THIN_TEXT, THIN_TITLE, TOUCH_HOLD_MS, PAGE_ENTRIES,
  activeTheme, angleLine, buyLabel, shareOf, buyersCell, carryLiveStories, chgText, coinSparkLabel, coinSparkPath, coinTag, copiesMark, copiesOf, copyFacts, dustChip, dustLine, emptyFiltered, emptyTrending, filterStories,
  listStatus, liveStories, mintPrefix, moreCoins, nameIfDiffers, newRowPill, narrativeOf, narrativeTitle, narrativesOn, normSym, oneList, pageEntries, parentTag, parseSize, parseSlot, parseTf, parseTheme, prefsUrl, readPref, repeatedSyms, rowAge, safetyChips,
  closeShrunk, showMore, sparkGeo, storiesView, storyHeader, storyMints, storySplit, subjectLine, themeLabel, themePills, LINE_NOTE, NO_POST_TEXT, tfWords, tradesByMint, txns, urlPrefs, writePref,
  type LiveTrade, type OneEntry, type OneOrder, type SizeKey, type StoriesView, type StoryShown, type SubjectLine,
} from "../lib/discover";
import { count, short, usd } from "../lib/format";
import { glance } from "../lib/story-attention";
import StoryChart from "../components/StoryChart";
import { NARRATIVE_FOOT } from "../lib/narrative";
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


/// One coin, shared by every list: a table row on a wide screen, two lines in a narrow list and three in a phone-width
/// one (dsc.css container queries; on a phone the liquidity, volume and txns cells, marked `opt`, are not drawn).
/// `dup`: another row of the list has this ticker, so the start of the mint tells them apart; `extra`: the row's own
/// chips (copies, why it is dust, its parent, its story).
function CoinRow({ c, t, tf, now, extra, dup }: { c: StoryShown; t: TradeCtl; tf: Tf; now: number; extra?: ReactNode; dup?: boolean }) {
  const tag = coinTag(c), ch = chgText(c.tf?.chg), x = txns(c.tf), by = buyersCell(c.tf, tf), ag = rowAge(c, now), nm = nameIfDiffers(c);
  // written twice: in the name line, and first on the tags line of a phone-width list (dsc.css shows one of the two)
  const meta = (
    <>
      <i className={`dsc-tag ${tag}`} title={TAG_TITLE_QUIET[tag]}>{tag}</i>
      {c.graduated === true && <i className="dsc-tag grad" title={GRAD_TITLE}>grad</i>}
      <span className="dsc-age" title={ag.title}>{ag.text}</span>
    </>
  );
  return (
    <li className={`dsc-coin${c.left ? " left" : ""}`}>
      <div className="dsc-coin-main">
        <Link to={coinLink(c.mint)} className="dsc-coin-name" title={nameOf(c)}>
          <Logo src={c.image} label={c.symbol} size={24} />
          <span className="dsc-coin-id">
            <span className="dsc-coin-top">
              <b>{sym(c)}</b>
              {dup && <span className="dsc-mintp" title={MINT_PREFIX_TITLE}>{mintPrefix(c.mint)}</span>}
              {nm && <span className="dsc-coin-nm">{nm}</span>}
              <span className="dsc-meta in">{meta}</span>
            </span>
          </span>
        </Link>
        <span className="dsc-coin-tags"><span className="dsc-meta out">{meta}</span>{extra}<Safety s={c.safety} /></span>
      </div>
      <span className="dsc-chart"><PriceSpark s={c.spark} /></span>
      <div className="dsc-nums">
        {/* Buyers first and in the brighter ink: it is what the list is ranked by */}
        <span className="dsc-num lead" title={by.title}><span className="dsc-k">Buyers · {tf} </span><span className="dsc-v">{by.n}</span>{by.sub && <span className="dsc-sub2">{by.sub}</span>}</span>
        <span className="dsc-num" title={`Market cap; change over ${tfWords(tf)}`}>
          <span className="dsc-k">Mcap · {tf} </span>
          {/* the key restarts the flash on each moving trade; a read without one remounts it plain */}
          <span key={c.flash?.n ?? 0} className={`dsc-v${c.flash ? ` dsc-flash ${c.flash.dir}` : ""}`}>{usd(c.mcapUsd)}</span>
          <span className="dsc-sub2 dsc-mc">
            <span className={ch.tone}>{ch.text}</span>
            {c.thin === true && <><span className="dsc-dot" aria-hidden="true"> · </span><span className="dsc-thin" title={THIN_TITLE}>{THIN_TEXT}<span className="dsc-vh">: market cap over 100 times the liquidity</span></span></>}
          </span>
        </span>
        <span className="dsc-num opt" title={LIQ_TITLE}><span className="dsc-k">Liquidity </span><span className="dsc-v">{usd(c.liqUsd)}</span></span>
        <span className="dsc-num opt" title={`Volume over ${tfWords(tf)}`}><span className="dsc-k">Volume · {tf} </span><span className="dsc-v">{c.tf ? usd(c.tf.volUsd) : "—"}</span></span>
        {/* buys and sells on one line when they fit (they wrap to two when not), each with a letter and the word for
            screen readers: never told apart by colour alone */}
        <span className="dsc-num opt" title={`Trades over ${tfWords(tf)}: buys (B) and sells (S)`}>
          <span className="dsc-k">Txns · {tf} </span><span className="dsc-v">{x.total}</span>
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

/// The column names over the rows (the cells carry their own names for screen readers and narrow lists). Each names
/// the timeframe its numbers are over.
function Cols({ tf }: { tf: Tf }) {
  return (
    <div className="dsc-cols" aria-hidden="true">
      <span>Coin</span><span>Last hour</span><span>Buyers · {tf}</span><span>Mcap · {tf}</span><span className="opt">Liquidity</span><span className="opt">Volume · {tf}</span><span className="opt">Txns · {tf}</span><span />
    </div>
  );
}

const XIcon = <svg className="dsc-x" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.9L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" /></svg>;

/// A row's own chips: "No longer listed" for a row kept only while the page is in use (the dimming alone says nothing
/// to a screen reader; "Moved to another story" when the coin is still listed elsewhere), "this hour" on a narrative
/// story's coin created 30-60 minutes ago (newRowPill; a younger one's "new" tag already says it), "×3 copies" on a row others are folded under, why a dust row is dust, and
/// its parent (on the map) where the list mixes parents.
/// `story`: the row also names its narrative (a single coin while narratives are shown): the title as a small muted
/// tag, a text node cut to one line. `sub`: a single coin's post or family, one muted line under its name.
/// `theme`: the row also names its story's theme (a single coin under its subject line, which already says the story):
/// one small muted tag, a model's word.
function RowTags({ r, parent, story, fresh, sub, theme }: { r: StoryShown; parent: boolean; story?: boolean; fresh?: boolean; sub?: { text: string; href: string | null } | null; theme?: string }) {
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

type RowOpts = { t: TradeCtl; tf: Tf; now: number; dups: ReadonlySet<string>; site: number | null };
/// One coin row and, under it, the coins folded into it (same ticker and image), one line each.
function RowAndCopies({ r, o, parent, story, fresh, sub, theme }: { r: StoryShown; o: RowOpts; parent: boolean; story?: boolean; fresh?: boolean; sub?: { text: string; href: string | null } | null; theme?: string }) {
  return (
    <>
      <CoinRow c={r} t={o.t} tf={o.tf} now={o.now} dup={o.dups.has(normSym(r.symbol))} extra={<RowTags r={r} parent={parent} story={story} fresh={fresh} sub={sub} theme={theme} />} />
      {copiesOf(r).map((k) => (
        <li key={k.mint} className="dsc-copyrow" title={COPIES_TITLE}>
          <span className="dsc-vh">Same ticker and image: </span>
          <Link className="dsc-copy-mint" to={coinLink(k.mint)}>{short(k.mint)}</Link>
          <span className="dsc-copy-facts">{copyFacts(k, o.now, o.tf)}</span>
        </li>
      ))}
    </>
  );
}

/// The rows of a plain list (the dust): each coin and its folded copies.
function Rows({ rows, o, parent }: { rows: readonly StoryShown[]; o: RowOpts; parent: boolean }) {
  return <>{rows.map((r) => <Fragment key={r.mint}><RowAndCopies r={r} o={o} parent={parent} /></Fragment>)}</>;
}

/// The header sparkline's drawing box (CSS stretches it).
const SPARK_W = 128, SPARK_H = 32;

/// The "Subject: what happened" line (lib/discover.ts subjectLine), the same on a single coin's card and in a story's
/// header: the subject in the accent with a colon, then the sentence in ink (two lines at most, never cut to one with
/// an ellipsis); on the right, small and muted, the "AI" badge, who posted and how long ago (an outlined chip for a post
/// older than a week); on a phone that sits on its own short line under the sentence. With a post the line is the
/// summary of a native <details>: hovering shows the poster's own words, a click, a tap or Enter opens them in full
/// with the note that a model wrote the summary and a link to the post on X (rebuilt from the id). Without a post
/// there is nothing to open and it is plain text. Every text is a stranger's or a model's: React text nodes only.
/// `pill`: a state pill drawn before the subject (a story that left the read).
function SubjectLineBlock({ L, pill }: { L: SubjectLine; pill?: ReactNode }) {
  const cls = `dsc-ln${L.tone === "personal" ? " dsc-ln-personal" : L.tone === "light" ? " dsc-ln-light" : ""}${L.quote ? " dsc-ln-quote" : ""}`;
  const inner = (
    <>
      <span className="dsc-ln-t">
        {pill}
        <b className="dsc-ln-s">{L.subject}:</b>{" "}
        <span className="dsc-ln-h">{L.quote ? `“${L.happened}”` : L.happened}</span>
      </span>
      {(L.badge || L.who || L.when || L.old) && (
        <span className="dsc-ln-m">
          {L.badge && <span className="dsc-ln-ai" title={L.badge.title}>{L.badge.text}<span className="dsc-vh">: {L.badge.title}</span></span>}
          {L.who && <span className="dsc-ln-who">{L.who}</span>}
          {L.old ? <span className="dsc-ln-old" title="How old the linked post is">{L.old}</span> : L.when && <span className="dsc-ln-when">{L.when}</span>}
        </span>
      )}
    </>
  );
  if (!L.href && !L.words) return <div className={cls}><div className="dsc-ln-sum">{inner}</div></div>;
  return (
    <details className={cls}>
      <summary className="dsc-ln-sum" title={L.words ? `${L.who ? `${L.who}: ` : ""}${L.words}` : undefined}>{inner}</summary>
      <div className="dsc-ln-body">
        {L.words ? <p className="dsc-ln-words">{L.words}</p> : <p className="dsc-ln-words dsc-ln-nowords">{NO_POST_TEXT}</p>}
        <p className="dsc-ln-foot">
          {L.auto && <span>{LINE_NOTE}</span>}
          {L.href && <a className="dsc-link" href={L.href} target="_blank" rel="noopener noreferrer" title={`Open the post on X. ${NARRATIVE_FOOT}`}>{XIcon}Open post</a>}
        </p>
      </div>
    </details>
  );
}

/// One entry of the list. A single coin with a story (a one-coin post or family card, or a loose coin with a story's
/// tag while narratives are shown): a slim card, the subject line on top and the coin's usual row under it, its copies
/// folded under that as ever; a loose coin with no story is a plain row. A story: a block with a header (not a
/// control), its first three rows, and "+N more coins", which opens the rest in place.
/// `nar`: narratives are shown.
function Entry({ e, o, nar, open, onToggle, chart, onChart }: { e: OneEntry; o: RowOpts; nar: boolean; open: boolean; onToggle: () => void; chart: boolean; onChart: () => void }) {
  const id = useId(), chartId = useId();
  const parent = e.card?.kind !== "family";
  if (!e.head) {
    const r = e.rows[0];
    if (!r) return null;
    // a one-coin card the read no longer has: its row says so, as a row would
    const row = e.left && !r.left ? { ...r, left: true, moved: e.moved } : r;
    const SL = subjectLine(e.card, o.now, nar, { row: r, coinsN: e.card ? e.coinsN : 1 });
    if (!SL) return <RowAndCopies r={row} o={o} parent={parent} />;
    // the theme as one small tag in the row: the line above already names the story
    const theme = nar ? themeLabel((narrativeOf(e.card) ?? narrativeOf(r))?.theme) : "";
    return (
      <li className="dsc-solo">
        <SubjectLineBlock L={SL} />
        <ul className="dsc-st-rows" aria-label={`${SL.subject}: ${sym(r)}`}>
          <RowAndCopies r={row} o={o} parent={parent} theme={theme || undefined} />
        </ul>
      </li>
    );
  }
  const h = storyHeader(e, o.now, nar);
  const { shown, more } = storySplit(e.rows, open);
  const isNar = e.card?.kind === "narrative";
  const label = h.kind === "narrative" ? `Story: ${h.title}` : h.kind === "post" ? `${h.title} ${h.sub}` : h.title;
  // story attention (a newer server): the phase, its multiple of normal when it has one, the buyers of the last 5
  // minutes, how long since the start, the leading coin; and the control that opens the chart (lib/story-attention.ts)
  const g = glance(e.card?.attention, o.now);
  const ang = angleLine(e.card);
  const share = e.distinct ? shareOf(e.buyers, o.site, tfWords(o.tf)) : null;
  // a subject block has no attention record of its own yet: no phase, no 5-minute count, no chart; its leading coin stays
  const subj = !!e.card?.subject;
  // the header's parts: the subject line (subjectLine), the 5-minute figure when the story has an attention record, its sparkline
  const SL = subjectLine(e.card, o.now, nar, { coinsN: e.coinsN });
  const theme = nar ? themeLabel(narrativeOf(e.card)?.theme) : "";
  const five = !!(g && e.card && !subj);
  const sp = sparkGeo(e.card?.attention?.spark, SPARK_W, SPARK_H);
  return (
    <li className={`dsc-story${e.left ? " left" : ""}`}>
      {/* the header: the subject line (who or what, and what happened: a model's summary of the starting post, the
          poster's own words one tap away; SubjectLineBlock); on the right the buyers of the last 5 minutes, big, and the
          story's last 3 hours as a small shape; one line of facts under a hairline. */}
      <div className="dsc-hx">
        <div className="dsc-hx-main">
          {SL && <SubjectLineBlock L={SL} pill={e.left ? <span className="dsc-pill sm st-left" title={e.moved ? REGROUPED_TITLE : "The server stopped listing this story; it goes once the page is idle"}>{e.moved ? REGROUPED_PILL : LEFT_PILL}</span> : undefined} />}
        </div>
        <div className="dsc-hx-att">
          <div className="dsc-hx-num" title={five ? g!.buyersTitle : e.distinct ? `Wallets that bought over ${tfWords(o.tf)}, each counted once across the coins of this story` : `Buyers over ${tfWords(o.tf)}, added up over the coins of this story`}>
            <b>{five ? g!.buyers : h.total}</b><span>{five ? g!.buyersLabel : `${h.unit} · ${tfWords(o.tf)}`}</span>
          </div>
          {sp && (
            <div className="dsc-hx-sp" aria-hidden="true">
              <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none"><path className="a" d={sp.area} /><path className="l" d={sp.line} vectorEffect="non-scaling-stroke" /></svg>
              <span><em>3 h ago</em><em>now</em></span>
            </div>
          )}
        </div>
        <div className="dsc-hx-facts">
          {five && <span className={`dsc-ph${g!.muted ? " mute" : ""}`} title={g!.phaseTitle}><span className="dsc-vh">Attention: </span>{g!.phase}</span>}
          {five && g!.start && <span>{g!.start}</span>}
          {g?.leader && <span className="dsc-gl-lead">{g.leader}</span>}
          {/* the timeframe's buyers, unless the timeframe is the big figure's own 5 minutes */}
          {five && (o.tf !== "5m" || h.total !== g!.buyers) && <span title={e.distinct ? `Wallets that bought over ${tfWords(o.tf)}, each counted once across the coins of this story` : `Buyers over ${tfWords(o.tf)}, added up over the coins of this story`}><b>{h.total}</b> {h.unit} · {tfWords(o.tf)}</span>}
          {share && <span className="dsc-hx-share" title={share.title}><b>{share.text}</b> of all tracked buyers</span>}
          <span>{h.count}</span>
          {five && <span className={`dsc-hx-x${g!.multiple ? "" : " none"}`} title={g!.multipleTitle}>{g!.multiple ?? "no normal level yet"}</span>}
          {ang && <span className="dsc-hx-ang" title={ang.title}>{ang.text}</span>}
          {/* the theme, a model's word: one small muted word on the facts line (not drawn on a phone) */}
          {theme && <span className="dsc-hx-th" title={TAG_NOTE}><span className="dsc-vh">Theme: </span>{theme}</span>}
          {five && <button type="button" className="linkish dsc-link dsc-hx-chart" aria-expanded={chart} aria-controls={chartId} onClick={onChart}>{chart ? "Hide chart" : "Chart"}</button>}
        </div>
      </div>
      {five && chart && e.card && <div id={chartId}><StoryChart storyKey={e.card.key} postAt={e.card.post?.at ?? null} label={label} /></div>}
      <ul id={id} className="dsc-st-rows" aria-label={`Coins of ${label}`}>
        {shown.map((r) => <Fragment key={r.mint}><RowAndCopies r={r} o={o} parent={parent} fresh={newRowPill(r, isNar)} /></Fragment>)}
      </ul>
      {more > 0 && (
        <p className="dsc-st-more">
          <button type="button" className="linkish dsc-link" aria-expanded={open} aria-controls={id} onClick={onToggle}>{moreCoins(more, open)}</button>
        </p>
      )}
    </li>
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
function Seg<K extends string>({ label, items, value, onChange, wrap }: { label: string; items: readonly { key: K; text: string; title: string }[]; value: K; onChange: (k: K) => void; wrap?: boolean }) {
  return (
    <div className={`dsc-seg${wrap ? " dsc-seg-wrap" : ""}`} role="radiogroup" aria-label={label} onKeyDown={roveKeys(items.map((x) => x.key), value, onChange)}>
      {items.map((x) => <button key={x.key} type="button" role="radio" aria-checked={x.key === value} tabIndex={x.key === value ? 0 : -1} className={x.key === value ? "on" : ""} title={x.title} onClick={() => onChange(x.key)}>{x.text}</button>)}
    </div>
  );
}

// ---- the view, read every 10 s and held while in use

type Held<S> = {
  state: S | null; setState: Dispatch<SetStateAction<S | null>>; error: string | null; stale: boolean; retry: () => void;
  /// the key the state on screen was read for (the timeframe its numbers and labels belong to)
  shownKey: string | null;
  /// the last read was applied with the order held
  paused: boolean;
  areaRef: (el: HTMLDivElement | null) => void;
  areaProps: { onPointerEnter: (e: ReactPointerEvent) => void; onPointerDown: (e: ReactPointerEvent) => void; onPointerLeave: (e: ReactPointerEvent) => void; onBlur: (e: ReactFocusEvent<HTMLDivElement>) => void };
};
/// `key` names what is read (the timeframe): a state of another key is `stale` (dimmed) until the first read of this
/// one. `merge` gets what is on screen, whether the order is held, and when the read's answer arrived (ms, this
/// browser's clock), for the live prices.
function useHeld<B, S>(key: string, read: () => Promise<B>, merge: (b: B, was: S | null, hold: boolean, readAt: number) => S, frozen: boolean): Held<S> {
  const [state, setState] = useState<S | null>(null);
  const stateRef = useRef(state); stateRef.current = state;
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const readRef = useRef(read); readRef.current = read;
  const mergeRef = useRef(merge); mergeRef.current = merge;
  const frozenRef = useRef(frozen); frozenRef.current = frozen;
  const [paused, setPaused] = useState(false);
  // a mouse over the lists; a finger gives no hover (pointerleave follows every tap), so a touch or pen holds them
  // for TOUCH_HOLD_MS after its last pointerdown there (a tap, or the start of a scroll), and a timer settles it after
  const over = useRef(false);
  const touchedAt = useRef(0);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const areaEl = useRef<HTMLDivElement | null>(null);
  const areaRef = useCallback((el: HTMLDivElement | null) => { areaEl.current = el; if (!el) over.current = false; }, []);
  // only keyboard focus counts (a clicked button keeps focus on Windows, which would hold the order for good)
  const held = () => over.current || Date.now() - touchedAt.current < TOUCH_HOLD_MS || !!areaEl.current?.querySelector(":focus-visible");
  // the latest answer, with the key it was read for and when it arrived
  const lastBody = useRef<{ d: B; key: string; at: number } | null>(null);
  // the latest read, applied: in the server's shape once idle, merged into what is on screen while still held (a read
  // that landed under the ticket is applied when it closes, and its key is then the one on screen)
  const settle = () => {
    const b = lastBody.current;
    if (frozenRef.current || b === null || stateRef.current === null) return;
    const hold = held();
    setPaused(hold);
    setState((was) => (was ? mergeRef.current(b.d, was, hold, b.at) : was));
    setLoadedKey(b.key);
  };
  const settleRef = useRef(settle); settleRef.current = settle;
  useEffect(() => settleRef.current(), [frozen]);
  useEffect(() => () => clearTimeout(touchTimer.current), []);
  useEffect(() => {
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
        const hold = held() && stateRef.current !== null;
        setPaused(hold);
        setState((was) => mergeRef.current(d, was, hold, at));
        setLoadedKey(key);
      }, (e) => { if (alive) setError(errorMessage(e)); }).finally(() => { busy = false; });
    };
    load();
    const timer = setInterval(load, DISCOVER_POLL_MS);
    // back on the tab: read at once when the view on screen is older than one interval
    const onVisible = () => { if (!document.hidden && Date.now() - last >= DISCOVER_POLL_MS) load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const retry = useCallback(() => { setError(null); setNonce((n) => n + 1); }, []);
  const areaProps: Held<S>["areaProps"] = {
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
  return { state, setState, error, stale: state !== null && loadedKey !== key, retry, shownKey: loadedKey, paused, areaRef, areaProps };
}

const Skel = ({ n = 3 }: { n?: number }) => (
  <ul className="dsc-list" aria-busy="true" aria-label="Loading the list">{Array.from({ length: n }, (_, i) => (
    <li key={i} className="dsc-card dsc-skel"><div className="dsc-skel-head"><Skeleton h={32} w={32} r={999} /><span><Skeleton h={14} w={`${40 - i * 6}%`} /><Skeleton h={10} w={`${64 - i * 8}%`} /></span></div><Skeleton h={10} /><Skeleton h={10} w="80%" /></li>
  ))}</ul>
);

export default function Discover() {
  useEffect(() => { document.title = "Discover · Spore"; return () => { document.title = "Spore"; }; }, []);
  useTick(AGO_TICK_MS);
  const now = nowS();
  // ?tf= names the timeframe: on load a valid one wins over the stored choice, and a change is written back to the
  // address (no history entry per click), so it can be kept or passed on. Written with history.replaceState and the
  // router's own state object, not setParams: to the shell any router navigation is a new page and it scrolls to the
  // top (App.tsx useScrollRestoration), which took the timeframe out from under the finger
  const [params] = useSearchParams();
  const [tf, setTfState] = useState<Tf>(() => urlPrefs(params.toString()).tf ?? readPref(store, TF_KEY, parseTf));
  const [slot, setSlotState] = useState<number>(() => readPref(store, SLOT_KEY, parseSlot));
  const [size, setSizeState] = useState<SizeKey>(() => readPref(store, SIZE_KEY, parseSize));
  const setTf = (v: Tf) => {
    setTfState(v); writePref(store, TF_KEY, v);
    try { window.history.replaceState(window.history.state, "", prefsUrl(window.location, "tf", v)); } catch { /* the address is a convenience; the choice is kept in storage */ }
  };
  const setSlot = (v: number) => { setSlotState(v); writePref(store, SLOT_KEY, String(v)); };
  const setSize = (v: SizeKey) => { setSizeState(v); writePref(store, SIZE_KEY, v); };
  // the theme pill as stored; it is in force while that theme has a pill (activeTheme), and it keeps its pill for the visit
  const [themePref, setThemeState] = useState<string>(() => readPref(store, THEME_KEY, parseTheme));
  const setTheme = (v: string) => { setThemeState(v); writePref(store, THEME_KEY, v); };
  // the stories the reader opened (by card key, so they stay open over the reads), and whether the dust is shown
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) => setOpened((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // the stories whose chart the reader opened (by entry key; a chart reads its series once, when opened)
  const [charts, setCharts] = useState<ReadonlySet<string>>(() => new Set());
  const toggleChart = (key: string) => setCharts((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const [showDust, setShowDust] = useState(false);
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
  // under way: an unlock prompt or a slow trade outlasts the 5 s touch hold, and an idle read could then move the row
  // with the busy button to another card
  const frozen = !!trade || !!opening;

  // ---- the view
  // the list's floors as the server applied them, with the timeframe they are for (the empty line's words)
  const [meta, setMeta] = useState<{ tf: Tf; floor?: number; floor5m?: number; candidates?: number } | null>(null);
  // a live price is carried over a read by when it arrived against when the read arrived (one clock, this browser's)
  const merge = useCallback((d: Stories, was: StoriesView | null, hold: boolean, readAt: number) => carryLiveStories(storiesView(d, was, hold), was, readAt), []);
  const held = useHeld<Stories, StoriesView>(tf, () => api.stories(tf).then((d) => { setMeta({ tf, floor: d.floor, floor5m: d.floor5m, candidates: d.candidates }); return d; }), merge, frozen);
  const view = held.state;
  // narratives: drawn only when the server tags them and the read holds a narrative card
  const nar = narrativesOn(view);
  // The pills this visit has shown, and the stored choice: they keep their pill when their last card drops out, so
  // the bar does not lose a pill, and the filter does not come off, without a click.
  const pillsSeen = useRef<Set<string>>(new Set());
  const pills = useMemo(() => {
    if (!view || !view.tagging) return [];
    const keep = pillsSeen.current;
    if (themePref !== ALL_THEMES) keep.add(themePref);
    if (!nar && keep.size === 0) return [];
    const p = themePills(view, keep);
    for (const x of p) if (x.key !== ALL_THEMES) keep.add(x.key);
    return p;
  }, [view, nar, themePref]);
  const theme = activeTheme(themePref, pills);
  const shown = useMemo(() => (view ? filterStories(view, size, theme) : null), [view, size, theme]);
  // ---- one list: stories and single coins ranked together by buyers over the timeframe (lib/discover.ts oneList).
  // While the list is in use (the last read was applied held) the entries and their rows keep the order on screen.
  const orderRef = useRef<OneOrder | null>(null);
  const list = useMemo(() => {
    if (!shown) return null;
    const r = oneList(shown, nowS(), orderRef.current, held.paused);
    orderRef.current = r.order;
    return r.entries;
  }, [shown, held.paused]);
  // a story opened, then cut by a read to the rows always shown, is closed again: grown back later it shows three
  // rows and "+N more coins", not everything at once. A story off this list (another page, a filter, one read) stays open.
  useEffect(() => {
    if (!list) return;
    setOpened((s) => closeShrunk(s, list));
  }, [list]);
  // the entries shown: the first PAGE_ENTRIES, and PAGE_ENTRIES more a click; back to one page on another timeframe or filter
  const [limit, setLimit] = useState(PAGE_ENTRIES);
  useEffect(() => { setLimit(PAGE_ENTRIES); }, [tf, size, theme]);

  // ---- live numbers: the trades of the coins on screen, applied in batches
  const mints = useMemo(() => storyMints(view, showDust), [view, showDust]);
  const mintsRef = useRef(mints); mintsRef.current = mints;
  const queue = useRef<LiveTrade[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setView = held.setState;
  const flush = useCallback(() => {
    flushTimer.current = undefined;
    const q = queue.current;
    queue.current = [];
    if (!q.length) return;
    const by = tradesByMint(q);
    setView((v) => (v ? liveStories(v, by) : v));
  }, [setView]);
  useEvents({
    trade: (tr) => {
      if (!mintsRef.current.has(tr.mint) || !(typeof tr.priceUsd === "number" && tr.priceUsd > 0)) return;
      if (queue.current.length >= LIVE_QUEUE_MAX) queue.current.shift();
      queue.current.push({ mint: tr.mint, time: tr.time, priceUsd: tr.priceUsd, at: Date.now() });
      if (flushTimer.current === undefined) flushTimer.current = setTimeout(flush, LIVE_FLUSH_MS);
    },
  }, mints.size > 0);
  useEffect(() => () => clearTimeout(flushTimer.current), []);

  const tfItems = TFS.map((k) => ({ key: k, text: k, title: TF_TITLE[k] }));
  const slotKeys = presets.map((_, i) => String(i));
  const slotItems = presets.map((v, i) => ({ key: String(i), text: `P${i + 1}`, title: `Buy ${v} SOL` }));

  // while the first read of a new timeframe is under way the rows still hold the last one's numbers: they keep its
  // labels (dimmed), and a read that fails says so with a retry instead of leaving them under the new labels silently
  const shownTf = held.stale ? parseTf(held.shownKey) : tf;
  const status = listStatus({ error: held.error, hasRows: view !== null, paused: held.paused, stale: held.stale });
  const m = meta && meta.tf === shownTf ? meta : null;
  const unfiltered = size === "all" && theme === ALL_THEMES;
  const page = pageEntries(list ?? [], limit);
  // a ticker repeated anywhere on the page shows the start of its mint
  const dups = useMemo(() => repeatedSyms(page.shown.flatMap((e) => e.rows)), [page.shown]);
  const o: RowOpts = { t, tf: shownTf, now, dups, site: view?.siteBuyers ?? null };
  const body = view === null || shown === null ? (
    held.error ? <ErrorBox error="The list could not be loaded." retry={held.retry} details={held.error} /> : <Skel />
  ) : (
    <>
      {held.stale && held.error && (
        <p className="dsc-stale-err" role="status" title={held.error}>
          Could not load the {tf} numbers; the dimmed rows show {shownTf}. <button type="button" className="linkish dsc-link" onClick={held.retry}>Retry</button>
        </p>
      )}
      {shown.total === 0 && (
        !unfiltered && view.cards.length + view.loose.length > 0
          ? <p className="dsc-empty">{emptyFiltered(size, theme)} <button type="button" className="linkish dsc-link" onClick={() => { setSize("all"); if (theme !== ALL_THEMES) setTheme(ALL_THEMES); }}>{theme === ALL_THEMES ? "Show all sizes" : "Show everything"}</button></p>
          : <p className="dsc-empty">{emptyTrending(shownTf, m?.floor, m?.candidates, m?.floor5m)}</p>
      )}
      {page.shown.length > 0 && (
        <section className="dsc-sec" aria-label={`Stories and coins, most buyers over ${tfWords(shownTf)} first`}>
          <div className="dsc-card dsc-trend">
            <div className="dsc-coins">
              <Cols tf={shownTf} />
              <ul className="dsc-one">
                {page.shown.map((e) => <Entry key={e.key} e={e} o={o} nar={nar} open={opened.has(e.key)} onToggle={() => toggle(e.key)} chart={charts.has(e.key)} onChart={() => toggleChart(e.key)} />)}
              </ul>
            </div>
          </div>
          {page.rest > 0 && (
            <p className="dsc-page-more"><button type="button" className="btn sm ghost" onClick={() => setLimit(page.shown.length + PAGE_ENTRIES)}>{showMore(page.rest)}</button></p>
          )}
        </section>
      )}
      {shown.dustN > 0 && (
        <section className="dsc-sec" aria-label="Hidden as bot dust">
          <p className="dsc-dust-line">
            <span title={DUST_NOTE}>{dustLine(shown.dustN)}</span><span aria-hidden="true"> · </span>
            <button type="button" className="linkish dsc-link" aria-expanded={showDust} onClick={() => setShowDust((v) => !v)}>{showDust ? "Hide" : "Show"}</button>
          </p>
          {showDust && (
            <>
              <p className="dsc-more-note">{DUST_NOTE}{shown.dustN > shown.dust.length ? ` Showing ${count(shown.dust.length)} of ${count(shown.dustN)}.` : ""}</p>
              {shown.dust.length > 0 && (
                <div className="dsc-card dsc-trend">
                  <div className="dsc-coins"><Cols tf={shownTf} /><ul><Rows rows={shown.dust} o={o} parent /></ul></div>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </>
  );

  return (
    <div className="dsc-page">
      <header className="dsc-top">
        <div className="dsc-top-text">
          <h1>Discover</h1>
          <p className="dsc-sub">{STORIES_SUB}</p>
        </div>
        <span className="dsc-top-r">
          <Link to="/timeline" className="dsc-link" title="Every story Spore recorded, by when it started">Story timeline</Link>
          <AlertButton />
        </span>
      </header>
      <div className="dsc-bar">
        <div className="dsc-bar-l">
          <Seg label="Coin size by market cap" items={SIZES} value={size} onChange={setSize} />
          {/* one quiet word: the order is held while the page is in use, or a poll failed. Cut, never wrapped, so it
              cannot push the bar or the lists */}
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
        {/* the theme pills, a second row under the size pills: only while narratives are shown; they wrap, never scroll */}
        {pills.length > 0 && <div className="dsc-themes"><Seg wrap label="Story theme" items={pills} value={theme} onChange={setTheme} /></div>}
      </div>
      <div className={`dsc-panel${held.stale ? " stale" : ""}`} aria-busy={held.stale || undefined} ref={held.areaRef} {...held.areaProps}>
        {body}
      </div>
      <p className="dsc-note">{FOOT_NOTE} {NARRATIVE_FOOT}{nar ? ` ${MODEL_NOTE}` : ""}</p>
      {trade && <QuickTrade coin={trade.coin} side={trade.side} amount={trade.amount} solUsd={stats?.solUsd ?? null} onClose={() => setTrade(null)} />}
    </div>
  );
}
