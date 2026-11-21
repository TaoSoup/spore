// Discover: one view of what is being bought right now, grouped by story (GET /api/stories), in the calm style of
// the Portfolio page. A reader sees at a glance who posted and how big the story is.
// - Story cards, most buyers first. A post card: a circle with the handle's initials, "@handle · 6 min ago" (and
//   "· $SYM family waking" when a waking family chose the same post), the first words of the post on one line (a link
//   to the post on x.com, rebuilt from the id). A family card (a family buying far above its normal level, no usable
//   post): the family's image and "$SYM family · waking up · 12 min". On the right two numbers: buyers in 5 min and
//   coins, summed over the card's coins. Under it up to three coin chips ("$SYM 96 buyers · $41K +38%", "×3 copies"
//   on a folded one) and "+N more"; the head opens the list of all its coins.
// - "No story found · N coins": the coins that link no stored post and whose family is not waking up ("30 of 125
//   coins" when the server sent only the first of them). While narratives are shown it reads "Not in a story card":
//   a coin whose story has no second coin on the page is listed here with its story's title.
// - "N hidden as bot dust · Show": coins left out of both (a market cap over 100 times the liquidity, or under $5
//   bought a buyer), each with a "Paper cap" or "Tiny buys" chip once shown.
// The size pills (All / Small / Mid / Large by market cap, kept in this browser) filter what was received: a card
// whose coins are all filtered out is gone, and a card's numbers count the coins it still shows (lib/discover.ts
// filterStories). A row stays under the pill of its read: a live trade moves its market cap, never the lists.
// Coins with the same ticker and image are folded under the one with the most liquidity and listed
// under it (launch time, liquidity, buyers); none is called the original.
// Narrative tags (a server with NARRATIVES=on, and at least one narrative card in the read; otherwise nothing of this
// is drawn and the page is as described above): a narrative card leads with the story's title in large type and its
// theme as a small pill, no circle; its numbers are buyers in 5 min and new coins in 1 h; its chips come in two
// labelled runs ("New this hour", "Older coins in this story"), and opened it lists the new coins, a thin divider,
// then the older ones. A post or family card whose coins share a narrative shows the theme pill only, and a loose row
// its story's title as a small muted tag. A row of theme pills under the size pills ("All themes" and the themes of
// the narrative cards, in a fixed order by name; the choice is kept in this browser) filters cards and loose rows; it
// combines with the size. A pill once shown stays for the visit and the chosen theme stays in force when its last card
// drops out (the list then says no such story is being bought), so the filter only ever changes by a click. A title is
// written by a language model: untrusted, drawn as a React text node on one line, never as markup or in an address.
// A post is what the coins link, picked by their creators and unchecked: the page says who posted and when, never why
// a coin is bought or what it will do.
// Every list uses one coin row (CoinRow): ticker, a price sparkline over the last hour, market cap with its change over
// the chosen timeframe (1m / 5m / 30m / 1h, the `tf=` of the read, kept in this browser), liquidity, volume, txns,
// buyers, the measured safety chips, and a Buy that shows its amount ("Buy 0.5 SOL"). The amount is one of the trade
// settings' three buy presets (P1 / P2 / P3 in the bar; the amounts are edited in Trade settings), and Buy runs the
// same instant trade as the map and the coin page (components/useInstantTrade.ts: the reader's Trade-with choice signs,
// a locked trading wallet is asked to unlock, a failed check opens the ticket); with instant trades off or no wallet it
// opens the ticket with the amount filled in. No other signing path.
// Live numbers: the SSE "trade" of the coins on screen moves their price, market cap (flashing once), change and
// sparkline between reads (lib/discover.ts liveMerge); the view is read every 10 s while the tab is visible. Nothing
// moves while the lists are in use (a mouse over them, a tap or scroll on them in the last 5 s, or keyboard focus in
// them): cards and rows keep their places and take fresh numbers, a new one is added at the end and one that left
// stays, dimmed; the server's order comes back once the page is idle (storiesView). Under an open ticket, or while a
// Buy is under way, no read is applied.
// Every class here starts with "dsc-" (components/dsc.css; discover.css belongs to the Coins page).
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type Dispatch, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useConnection } from "@solana/wallet-adapter-react";
import { api, errorMessage, pumpUrl, type Coin, type CoinSafety, type CoinSpark, type Stories, type Tf } from "../lib/api";
import {
  AGO_TICK_MS, ALERT_LABEL, ALERT_TITLE, ALL_THEMES, CHIPS_MAX, COPIES_TITLE, DISCOVER_POLL_MS, DUST_NOTE, FOOT_NOTE, GRAD_TITLE, LEFT_PILL, LIQ_TITLE, LOOSE_TITLE, LOOSE_TITLE_NAR, MINT_PREFIX_TITLE, MODEL_NOTE, MOVED_PILL, MOVED_TITLE, REGROUPED_PILL, REGROUPED_TITLE, NEW_COINS_TITLE, NEW_LABEL, OLDER_LABEL,
  SIZES, SIZE_KEY, SLOT_KEY, STORIES_SUB, TAG_NOTE, TAG_TITLE_QUIET, TFS, TF_KEY, TF_TITLE, THEME_KEY, THIN_TEXT, THIN_TITLE, TOUCH_HOLD_MS,
  activeTheme, buyLabel, buyersCell, cardKey, cardTotals, carryLiveStories, chgText, coinSparkLabel, coinSparkPath, coinTag, copiesMark, copiesOf, copyFacts, dustChip, dustLine, emptyFiltered, emptyTrending, filterStories,
  listStatus, liveStories, looseMore, looseTitle, mintPrefix, moreChips, nameIfDiffers, narrativeHead, narrativeOf, narrativeTitle, narrativesOn, normSym, parentTag, parseSize, parseSlot, parseTf, parseTheme, prefsUrl, readPref, repeatedSyms, rowAge, safetyChips,
  splitNew, storiesView, storyChip, storyHead, storyMints, themeLabel, themePills, tradesByMint, txns, urlPrefs, writePref,
  type LiveTrade, type SizeKey, type StoriesView, type StoryCardShown, type StoryShown,
} from "../lib/discover";
import { count, short, usd } from "../lib/format";
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
/// one (dsc.css container queries).
/// `dup`: another row of the list has this ticker, so the start of the mint tells them apart; `extra`: the row's own
/// chips (copies, why it is dust, its parent).
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
        {/* Buyers first and in the brighter ink: it is what the page is about */}
        <span className="dsc-num lead" title={by.title}><span className="dsc-k">Buyers {tf} </span><span className="dsc-v">{by.n}</span>{by.sub && <span className="dsc-sub2">{by.sub}</span>}</span>
        <span className="dsc-num" title={`Market cap; change over ${tf}`}>
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

/// The column names over the rows (the cells carry their own names for screen readers and narrow lists).
function Cols({ tf }: { tf: Tf }) {
  return (
    <div className="dsc-cols" aria-hidden="true">
      <span>Coin</span><span>Last hour</span><span>Buyers {tf}</span><span>Mcap · {tf}</span><span>Liquidity</span><span>Volume {tf}</span><span>Txns {tf}</span><span />
    </div>
  );
}

const XIcon = <svg className="dsc-x" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.9L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" /></svg>;

/// A row's own chips: "No longer listed" for a row kept only while the page is in use (the dimming alone says nothing
/// to a screen reader; "Moved to another card" when the coin is still listed elsewhere), "×3 copies" on a row others are folded under, why a dust row is dust, and its parent (on the
/// map) where the list mixes parents.
/// `story`: the row also names its narrative (a loose row while narratives are shown): the title as a small muted tag,
/// a text node cut to one line.
function RowTags({ r, parent, story }: { r: StoryShown; parent: boolean; story?: boolean }) {
  const tag = parent ? parentTag(r) : null, copies = copiesMark(r), dust = dustChip(r.reason), nar = story ? narrativeOf(r) : null;
  if (!tag && !copies && !dust && !r.left && !nar) return null;
  return (
    <span className="dsc-ptags">
      {nar && <span className="dsc-st-ntag" title={TAG_NOTE}><span className="dsc-vh">Story: </span>{narrativeTitle(nar.title)}</span>}
      {r.left && (r.moved
        ? <span className="dsc-pill sm st-left" title={MOVED_TITLE}>{MOVED_PILL}</span>
        : <span className="dsc-pill sm st-left" title="The server stopped listing this coin; the row goes once the page is idle">{LEFT_PILL}</span>)}
      {dust && <span className="dsc-chip" title={dust.title}>{dust.text}</span>}
      {copies && <span className="dsc-chip" title={COPIES_TITLE}>{copies}</span>}
      {tag && r.parent && <Link className="dsc-ptag" to={mapLink(r.parent.mint)} title={`${tag.replace(/^under /, "")} and the coins under it on the map`}>{tag}</Link>}
    </span>
  );
}

/// The rows of one list: each coin, and under it the coins folded into it (same ticker and image), one line each.
/// `among`: the whole list when `rows` is one run of it (a narrative card's new or older coins), so a ticker repeated
/// across the runs still shows the start of its mint.
function Rows({ rows, t, tf, now, parent, story, among }: { rows: readonly StoryShown[]; t: TradeCtl; tf: Tf; now: number; parent: boolean; story?: boolean; among?: readonly StoryShown[] }) {
  const dups = repeatedSyms(among ?? rows);
  return (
    <>
      {rows.map((r) => (
        <Fragment key={r.mint}>
          <CoinRow c={r} t={t} tf={tf} now={now} dup={dups.has(normSym(r.symbol))} extra={<RowTags r={r} parent={parent} story={story} />} />
          {copiesOf(r).map((k) => (
            <li key={k.mint} className="dsc-copyrow" title={COPIES_TITLE}>
              <span className="dsc-vh">Same ticker and image: </span>
              <Link className="dsc-copy-mint" to={coinLink(k.mint)}>{short(k.mint)}</Link>
              <span className="dsc-copy-facts">{copyFacts(k, now)}</span>
            </li>
          ))}
        </Fragment>
      ))}
    </>
  );
}

/// A card's first coins as chips, then "+N more" (which opens the card).
function Chips({ rows, tf, onToggle, label }: { rows: readonly StoryShown[]; tf: Tf; onToggle: () => void; label?: string }) {
  const chips = rows.slice(0, CHIPS_MAX), more = moreChips(rows.length - chips.length);
  return (
    <ul className="dsc-st-chips" aria-label={label}>
      {chips.map((r) => {
        const ch = storyChip(r);
        return (
          <li key={r.mint}>
            <Link className={`dsc-st-chip${r.left ? " left" : ""}`} to={coinLink(r.mint)} title={`${ch.text}. Buyers over 5 min; market cap and its change over ${tf}`}>
              <b>{ch.sym}</b><span>{ch.buyers}</span>
              {ch.mcap && <span><span aria-hidden="true">· </span>{ch.mcap}</span>}
              {ch.chg && <span className={ch.chg.tone}>{ch.chg.text}</span>}
              {ch.copies && <i>{ch.copies}</i>}
            </Link>
          </li>
        );
      })}
      {more && <li><button type="button" className="linkish dsc-link" aria-label={`${more} coins: show every coin of this story`} onClick={onToggle}>{more}</button></li>}
    </ul>
  );
}
/// A theme as a small pill ("AI", "Market crash"); nothing for an unknown theme.
const ThemePill = ({ theme }: { theme: string }) => (theme ? <span className="dsc-pill sm dsc-st-theme" title="The theme a language model gave this story. It can be wrong."><span className="dsc-vh">Theme: </span>{theme}</span> : null);

type CardProps = { c: StoryCardShown; now: number; open: boolean; onToggle: () => void; t: TradeCtl; tf: Tf };
/// One story: who (or which family), how many buyers and coins, its first coins as chips; the head opens every coin.
/// `nar`: narratives are shown, so a card whose coins share one carries its theme pill.
function StoryCard({ c, now, open, onToggle, t, tf, nar }: CardProps & { nar: boolean }) {
  const id = useId();
  const h = storyHead(c, now);
  const fam = c.family;
  const coinsWord = c.coinsN === 1 ? "coin" : "coins";
  const theme = nar ? themeLabel(narrativeOf(c)?.theme) : "";
  const who = (
    <button type="button" className="dsc-st-who" aria-expanded={open} aria-controls={open ? id : undefined} title={open ? "Hide this story's coins" : "Show every coin of this story"}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      <b>{h.who}</b>{h.when && <span> · {h.when}</span>}{h.tail && <span> · {h.tail}</span>}{c.left && <span title={c.moved ? REGROUPED_TITLE : undefined}> · {c.moved ? REGROUPED_PILL : LEFT_PILL}</span>}
    </button>
  );
  return (
    <li className={`dsc-card dsc-story${open ? " open" : ""}${c.left ? " left" : ""}`}>
      {/* the whole head toggles for a mouse or a finger; the button inside is the same control for a keyboard */}
      <div className="dsc-st-head" onClick={onToggle}>
        {h.kind === "post" ? <span className="dsc-st-av" aria-hidden="true">{h.initials}</span> : <Logo src={fam?.image} label={fam?.symbol} size={40} />}
        <div className="dsc-st-id">
          {theme ? <div className="dsc-st-line">{who}<ThemePill theme={theme} /></div> : who}
          {h.href && (
            <a className="dsc-st-text" href={h.href} target="_blank" rel="noopener noreferrer" title={`Open the post on X. ${NARRATIVE_FOOT}`} onClick={(e) => e.stopPropagation()}>
              {XIcon}<span>{h.text || "View post"}</span>
            </a>
          )}
        </div>
        <div className="dsc-st-nums">
          <span className="dsc-st-n" title="Wallets that bought $1 or more in the last 5 minutes, added up over this story's coins"><b>{count(c.buyers5m)}</b><span>buyers · 5 min</span></span>
          <span className="dsc-st-n" title="Coins of this story being bought now, folded copies counted"><b>{count(c.coinsN)}</b><span>{coinsWord}</span></span>
        </div>
      </div>
      {open ? (
        <>
          <section id={id} className="dsc-coins" aria-label={`Coins of ${h.who}`}>
            <Cols tf={tf} />
            <ul><Rows rows={c.coins} t={t} tf={tf} now={now} parent={c.kind === "post"} /></ul>
          </section>
          <p className="dsc-foot"><button type="button" className="linkish dsc-link" onClick={onToggle}>Hide coins</button></p>
        </>
      ) : <Chips rows={c.coins} tf={tf} onToggle={onToggle} />}
    </li>
  );
}

/// A narrative card: the story's title in large type with its theme pill, buyers in 5 min and new coins in 1 h, then
/// the coins as two labelled runs of chips (new this hour, older); the head opens every coin, new ones first.
/// The title is a language model's words: a text node on one line, nothing else is done with it.
function NarrativeCard({ c, now, open, onToggle, t, tf }: CardProps) {
  const id = useId();
  const h = narrativeHead(c, now);
  const { fresh, older } = splitNew(c.coins);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <li className={`dsc-card dsc-story dsc-st-nar${open ? " open" : ""}${c.left ? " left" : ""}`}>
      <div className="dsc-st-head" onClick={onToggle}>
        <div className="dsc-st-id">
          <div className="dsc-st-line">
            <button type="button" className="dsc-st-title" aria-expanded={open} aria-controls={open ? id : undefined} title={open ? "Hide this story's coins" : "Show every coin of this story"}
              onClick={(e) => { e.stopPropagation(); onToggle(); }}>{h.title}</button>
            <ThemePill theme={h.theme} />
            {c.left && <span className="dsc-pill sm st-left" title={c.moved ? REGROUPED_TITLE : undefined}>{c.moved ? REGROUPED_PILL : LEFT_PILL}</span>}
          </div>
          {h.post && (h.post.href
            ? <a className="dsc-st-text dsc-st-quiet" href={h.post.href} target="_blank" rel="noopener noreferrer" title={`Open the post on X. ${NARRATIVE_FOOT}`} onClick={stop}>{XIcon}<span>{h.post.text}</span></a>
            : <span className="dsc-st-text dsc-st-quiet"><span>{h.post.text}</span></span>)}
        </div>
        <div className="dsc-st-nums">
          <span className="dsc-st-n" title="Wallets that bought $1 or more in the last 5 minutes, added up over this story's coins"><b>{count(c.buyers5m)}</b><span>buyers · 5 min</span></span>
          <span className="dsc-st-n" title={NEW_COINS_TITLE}><b>{count(h.newCoins)}</b><span>{h.newCoins === 1 ? "new coin" : "new coins"} · 1 h</span></span>
        </div>
      </div>
      {open ? (
        <>
          <section id={id} className="dsc-coins" aria-label={`Coins of the story ${h.title}`}>
            <Cols tf={tf} />
            <ul>
              <Rows rows={fresh} among={c.coins} t={t} tf={tf} now={now} parent />
              {fresh.length > 0 && older.length > 0 && <li className="dsc-st-div">{OLDER_LABEL}</li>}
              <Rows rows={older} among={c.coins} t={t} tf={tf} now={now} parent />
            </ul>
          </section>
          <p className="dsc-foot"><button type="button" className="linkish dsc-link" onClick={onToggle}>Hide coins</button></p>
        </>
      ) : (
        <div className="dsc-st-runs">
          {fresh.length > 0 && <><span className="dsc-st-lbl" aria-hidden="true">{NEW_LABEL}</span><Chips rows={fresh} tf={tf} onToggle={onToggle} label={NEW_LABEL} /></>}
          {older.length > 0 && <><span className="dsc-st-lbl" aria-hidden="true">{OLDER_LABEL}</span><Chips rows={older} tf={tf} onToggle={onToggle} label={OLDER_LABEL} /></>}
        </div>
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
  const looseN = shown ? cardTotals(shown.loose).coinsN : 0;
  // the loose coins the server did not send: in the count under All; under a size they cannot be told apart, so a line says so
  // (the same under a theme: what was not sent has no theme to go by)
  const unfiltered = size === "all" && theme === ALL_THEMES;
  const looseHead = looseTitle(looseN, unfiltered ? view?.hiddenLoose ?? 0 : 0, nar), looseNote = unfiltered ? null : looseMore(view?.hiddenLoose ?? 0);
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
      {shown.cards.length > 0 && (
        <ul className="dsc-list" aria-label="Stories, most buyers first">
          {shown.cards.map((c) => {
            const k = cardKey(c), p = { c, now, open: opened.has(k), onToggle: () => toggle(k), t, tf: shownTf };
            return c.kind === "narrative" ? <NarrativeCard key={k} {...p} /> : <StoryCard key={k} {...p} nar={nar} />;
          })}
        </ul>
      )}
      {unfiltered && view.hiddenCards > 0 && <p className="dsc-more-note">{count(view.hiddenCards)} smaller {view.hiddenCards === 1 ? "story is" : "stories are"} not shown.</p>}
      {shown.loose.length > 0 && (
        <section className="dsc-sec" aria-label={looseHead}>
          <h2 className="dsc-h2" title={nar ? LOOSE_TITLE_NAR : LOOSE_TITLE}>{looseHead}</h2>
          <div className="dsc-card dsc-trend">
            <div className="dsc-coins"><Cols tf={shownTf} /><ul><Rows rows={shown.loose} t={t} tf={shownTf} now={now} parent story={nar} /></ul></div>
          </div>
          {looseNote && <p className="dsc-more-note">{looseNote}</p>}
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
                  <div className="dsc-coins"><Cols tf={shownTf} /><ul><Rows rows={shown.dust} t={t} tf={shownTf} now={now} parent /></ul></div>
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
        <AlertButton />
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
