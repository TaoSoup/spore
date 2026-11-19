// Discover: the families whose existing coins are being bought far above their normal level right now (GET
// /api/discover; the words, the sparkline and the order are lib/discover.ts). A family "wakes up" when, in one
// 5-minute bucket, 50 or more wallets buy 3 or more of its coins launched over 30 min before, at 5x or more its trailing
// 24 h level. The newest is on top and every card says how long ago it started; the "Alert me" button turns on a
// browser notification for the next one (components/WakeAlerts.tsx).
// One card a family: logo, ticker, "Started N min ago" (green while live, amber while cooling), what is measured, a
// sparkline of buyers per 5 min over 2 h on a faint band at its normal level, the X post most of its moving coins link
// (only what coincided, never a cause, and the line says on screen that the coins link it), and the coins moving now with the same Buy as the Portfolio page and the map
// (components/useInstantTrade.ts + TradePresets, or the ticket: no other signing path). A cooling card is folded to
// its head; "Show" opens it.
// The list is read every 10 s while the tab is visible; "N min ago" follows the clock every 15 s without a read. Nothing
// moves while the list is in use (a mouse over it, a tap or scroll on it in the last 5 s, or keyboard focus in it):
// numbers change in place, a card's coins keep their rows and a card does not fold or unfold, a new family is added at
// the end and one that left stays, dimmed; the server's order comes back once the list is idle (lib/discover.ts
// familyRows). Under an open preset popover or ticket nothing is applied at all, a read already under way included, so
// the row under the user's pointer cannot change. A failed refresh keeps what is on screen.
// Every class here starts with "dsc-" (components/dsc.css; discover.css belongs to the Coins page).
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import { useConnection } from "@solana/wallet-adapter-react";
import { api, errorMessage, pumpUrl, type Coin, type Discover as DiscoverBody, type WakeCoin, type WakeFamily } from "../lib/api";
import { AGO_TICK_MS, ALERT_LABEL, ALERT_TITLE, DISCOVER_POLL_MS, FOOT_NOTE, HIDDEN_TITLE, LEFT_PILL, POST_NOTE, TAG_TITLE, TOUCH_HOLD_MS, coinTag, copyLine, familyRows, footLine, postLine, ratioLine, sinceStart, sparkGeom, sparkLabel, startedText, type FamilyRow } from "../lib/discover";
import { age, count, usd } from "../lib/format";
import { useStats, useTick } from "../lib/hooks";
import type { InstantSpec } from "../lib/instant-trade";
import { blockText, hardBlock, loadTradeRoute, type TradeBlock } from "../lib/trade-route";
import { ErrorBox, Logo, Skeleton, nameOf, sym } from "../components/Bits";
import QuickTrade from "../components/QuickTrade";
import TradePresets from "../components/TradePresets";
import { useToast } from "../components/Toast";
import { useInstantTrade, type Opening } from "../components/useInstantTrade";
import { useWakeAlertSwitch } from "../components/WakeAlerts";
import type { Side } from "../lib/pump";
import "../components/primitives.css";
import "../components/dsc.css";

const coinLink = (mint: string) => `/c/${encodeURIComponent(mint)}`;
const mapLink = (mint: string) => `/map?focus=${encodeURIComponent(mint)}`;
const nowS = () => Math.floor(Date.now() / 1000);

/// What a Buy button needs from the page (the same flow as the Portfolio page's Buy): `instant` shows the presets and
/// a preset trades at once (`onInstant`); off (or no wallet yet), Buy opens the ticket (`onTrade`, also "Custom…").
type TradeCtl = {
  opening: Opening; blocked: Record<string, { short: string; body: string }>; instant: boolean; presets: readonly number[];
  ready: () => boolean; onInstant: (mint: string, spec: InstantSpec, label: string) => void; onTrade: (mint: string) => void; onMenu: (open: boolean) => void;
};

function Buy({ mint, label, t }: { mint: string; label: string; t: TradeCtl }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  // a trade under way anywhere on the page, or instant trades turned off, closes the presets
  const off = !!t.opening || !t.instant;
  useEffect(() => { if (off) setMenu(false); }, [off]);
  const open = menu && !off, onMenu = t.onMenu;
  useEffect(() => { if (!open) return; onMenu(true); return () => onMenu(false); }, [open, onMenu]);
  const why = t.blocked[mint];
  if (why) return <span className="dsc-why" title={why.body}>{why.short} · <a href={pumpUrl(mint)} target="_blank" rel="noreferrer">pump.fun ↗</a></span>;
  const busy = t.opening?.mint === mint && t.opening.side === "buy";
  const press = () => {
    if (!t.instant) { t.onTrade(mint); return; }
    if (menu) { setMenu(false); return; }
    // a locked trading wallet is asked to unlock, and nothing else happens
    if (t.ready()) setMenu(true);
  };
  return (
    <>
      <button ref={ref} type="button" className={`btn sm ghost dsc-buy ${busy ? "is-busy" : ""}`} disabled={!!t.opening} aria-busy={busy} aria-label={`Buy ${label}`}
        {...(t.instant ? { "aria-haspopup": "dialog" as const, "aria-expanded": open } : {})} onClick={press}>Buy</button>
      {open && (
        <TradePresets side="buy" label={`Buy ${label}`} anchor={ref.current} presets={t.presets.map((v) => `${v} SOL`)}
          onPick={(i) => t.onInstant(mint, { side: "buy", sol: t.presets[i] }, label)} onCustom={() => t.onTrade(mint)} onClose={() => setMenu(false)} />
      )}
    </>
  );
}

/// Buyers per 5 min over the last 2 h, oldest on the left, on a faint band from the floor up to the family's normal
/// level. The box stretches to its cell; the stroke keeps its width.
function Spark({ f }: { f: WakeFamily }) {
  const W = 240, H = 40;
  const g = sparkGeom(f.spark, f.baseline, W, H);
  return (
    <svg className="dsc-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={sparkLabel(f)}>
      <rect className="dsc-spark-band" x="0" y={g.bandY} width={W} height={Math.max(0, H - g.bandY)} />
      <polyline className="dsc-spark-line" points={g.points} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const XIcon = <svg className="dsc-x" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.9L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" /></svg>;

/// The post most of the moving coins link: one muted line, cut to one line, opening the post on X. It starts with
/// "Linked post" on screen; the full note is the tooltip and, for assistive tech, the line's description.
function Post({ f, now }: { f: WakeFamily; now: number }) {
  const id = useId();
  if (!f.post) return null;
  const p = postLine(f.post, now);
  const inner = <>{XIcon}<span>{p.body}</span></>;
  const note = <span id={id} className="dsc-vh">{POST_NOTE}</span>;
  return p.href
    ? <><a className="dsc-post" href={p.href} target="_blank" rel="noopener noreferrer" title={`${p.body}\n\n${POST_NOTE}`} aria-describedby={id}>{inner}</a>{note}</>
    : <><p className="dsc-post" title={POST_NOTE} aria-describedby={id}>{inner}</p>{note}</>;
}

function CoinRow({ c, t }: { c: WakeCoin; t: TradeCtl }) {
  const tag = coinTag(c), since = sinceStart(c.sinceStart, c.existing), copy = copyLine(c);
  return (
    <li className="dsc-coin">
      <Link to={coinLink(c.mint)} className="dsc-coin-name" title={nameOf(c)}>
        <Logo src={c.image} label={c.symbol} size={22} />
        <span className="dsc-coin-id">
          <span className="dsc-coin-top"><b>{sym(c)}</b><i className={`dsc-tag ${tag}`} title={TAG_TITLE[tag]}>{tag}</i></span>
          {copy && <span className="dsc-copy">{copy}</span>}
        </span>
      </Link>
      <span className="dsc-num"><span className="dsc-k">Age </span>{c.createdAt ? age(c.createdAt) : "—"}</span>
      <span className="dsc-num"><span className="dsc-k">Mcap </span>{usd(c.mcapUsd)}</span>
      <span className={`dsc-num dsc-since ${since.tone}`}><span className="dsc-k">Since start </span>{since.text}</span>
      <span className="dsc-num"><span className="dsc-k">Buyers 5m </span>{count(c.buyers5m)}</span>
      {/* a blocked coin's reason takes its own line on a phone, so the number columns keep their width */}
      <span className={`dsc-act${t.blocked[c.mint] ? " blocked" : ""}`}><Buy mint={c.mint} label={sym(c)} t={t} /></span>
    </li>
  );
}

function Card({ f, now, open, onToggle, t }: { f: FamilyRow; now: number; open: boolean; onToggle: () => void; t: TradeCtl }) {
  const p = f.parent;
  const folded = f.state === "cooling" && !open;
  const foot = footLine(f.more, f.hidden);
  const coins = Array.isArray(f.coins) ? f.coins : [];
  const pill = f.left ? LEFT_PILL : startedText(f, now);
  return (
    // state classes are "st-" prefixed: the app's global .live (the stream dot, styles.css) lowercases text and turns
    // every <i> inside into a 7 px dot, which drew the existing/new tag as a dot over the ticker
    <li className={`dsc-card st-${f.state}${f.left ? " left" : ""}${folded ? " folded" : ""}`}>
      <div className="dsc-head">
        <Logo src={p.image} label={p.symbol} size={32} />
        <div className="dsc-title">
          <span className="dsc-name">
            <Link to={p.isCoin ? coinLink(p.mint) : mapLink(p.mint)} title={p.isCoin ? `${nameOf(p)}: chart and trading` : `${nameOf(p)} and the coins under it on the map`}><b>{sym(p)}</b></Link>
            <span className={`dsc-pill st-${f.left ? "left" : f.state}`}><i aria-hidden="true" />{pill}</span>
          </span>
          <p className="dsc-line" title={ratioLine(f)}>{ratioLine(f)}</p>
        </div>
        {!folded && <Spark f={f} />}
      </div>
      {!folded && (
        <>
          <Post f={f} now={now} />
          {coins.length > 0 && (
            <section className="dsc-coins" aria-label={`Coins under ${sym(p)} moving now`}>
              <div className="dsc-cols" aria-hidden="true"><span>Coins moving now</span><span>Age</span><span>Mcap</span><span>Since start</span><span>Buyers 5m</span><span /></div>
              <ul>{coins.map((c) => <CoinRow key={c.mint} c={c} t={t} />)}</ul>
            </section>
          )}
        </>
      )}
      {(foot || f.state === "cooling") && (
        <p className="dsc-foot">
          {foot && <span title={f.hidden > 0 ? HIDDEN_TITLE : undefined}>{foot}</span>}
          {f.state === "cooling" && <button type="button" className="linkish dsc-link" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} ${sym(p)}`} onClick={onToggle}>{folded ? "Show" : "Hide"}</button>}
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

export default function Discover() {
  useEffect(() => { document.title = "Discover · Spore"; return () => { document.title = "Spore"; }; }, []);
  useTick(AGO_TICK_MS);
  const now = nowS();
  const [rows, setRows] = useState<FamilyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // the cooling cards the reader opened
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const { stats } = useStats();
  const { connection } = useConnection();
  const toast = useToast();

  // ---- Buy: the Portfolio page's flow (components/useInstantTrade.ts), with the reader's Trade-with choice signing
  const [trade, setTrade] = useState<{ coin: Coin; side: Side; amount?: string } | null>(null);
  const [blocked, setBlocked] = useState<Record<string, { short: string; body: string }>>({});
  const showBlock = useCallback((block: TradeBlock, coin: Coin) => {
    const b = blockText(block, coin);
    // a gap passes once the index holds the coins above: it is said once and the button stays, so the next click checks again
    if (block.kind === "gap") toast.info(`${b.title}. ${b.body}`);
    else setBlocked((m) => ({ ...m, [coin.mint]: { short: b.short, body: b.body } }));
  }, [toast]);
  const { ready, opening, busy, begin, end, alive, settings, hasWallet, run: onInstant } = useInstantTrade({ onTicket: setTrade, onBlocked: showBlock }, { signer: "chosen" });
  // Buy through the ticket: it needs the coin's full record; a route check that fails (the RPC) opens it anyway
  const onTrade = useCallback(async (mint: string) => {
    if (busy() || !ready()) return;
    begin(mint, "buy");
    try {
      const { coin } = await api.coin(mint, { children: false, trades: false });
      const route = await loadTradeRoute(connection, coin).catch(() => null);
      if (!alive.current) return;
      const block = hardBlock(route);
      if (!block) setTrade({ coin, side: "buy" });
      else showBlock(block, coin);
    } catch (e) {
      toast.error(`Could not open the trade: ${errorMessage(e)}`);
    } finally {
      end();
    }
  }, [connection, toast, ready, showBlock, busy, begin, end, alive]);
  const [menus, setMenus] = useState(0);
  const onMenu = useCallback((open: boolean) => setMenus((n) => Math.max(0, n + (open ? 1 : -1))), []);
  const t: TradeCtl = { opening, blocked, instant: settings.instant && hasWallet, presets: settings.buyPresets, ready, onInstant, onTrade, onMenu };
  // nothing is read under an open popover or ticket (the row under the pointer must not change)
  const frozen = menus > 0 || !!trade;
  const frozenRef = useRef(frozen); frozenRef.current = frozen;

  // ---- the list, and its order held while it is in use
  // a mouse over the list; a finger gives no hover (pointerleave follows every tap), so a touch or pen holds the list
  // for TOUCH_HOLD_MS after its last pointerdown on it (a tap, or the start of a scroll), and a timer settles it after
  const over = useRef(false);
  const touchedAt = useRef(0);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listEl = useRef<HTMLUListElement>(null);
  // only keyboard focus counts (a clicked button keeps focus on Windows, which would hold the order for good)
  const held = () => over.current || Date.now() - touchedAt.current < TOUCH_HOLD_MS || !!listEl.current?.querySelector(":focus-visible");
  const lastBody = useRef<DiscoverBody | null>(null);
  // the latest read, applied: in the server's shape once idle, merged into what is on screen while still held (a read
  // that landed under a popover is applied when it closes)
  const settle = () => {
    const d = lastBody.current;
    if (frozenRef.current || !d) return;
    const hold = held();
    setRows((was) => (was ? familyRows(d, was, hold) : was));
  };
  const settleRef = useRef(settle); settleRef.current = settle;
  useEffect(settle, [frozen]);
  const touched = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse") return;
    touchedAt.current = Date.now();
    clearTimeout(touchTimer.current);
    touchTimer.current = setTimeout(() => settleRef.current(), TOUCH_HOLD_MS + 50);
  };
  useEffect(() => () => clearTimeout(touchTimer.current), []);
  useEffect(() => {
    let alive = true, busy = false, last = 0;
    const load = () => {
      if (busy || document.hidden || frozenRef.current) return;
      busy = true;
      api.discover().then((d) => {
        if (!alive) return;
        last = Date.now(); lastBody.current = d;
        setError(null);
        // a popover or ticket opened while this read was under way: kept for settle, not applied under it
        if (frozenRef.current) return;
        setRows((was) => familyRows(d, was ?? [], held()));
      }, (e) => { if (alive) setError(errorMessage(e)); }).finally(() => { busy = false; });
    };
    load();
    const timer = setInterval(load, DISCOVER_POLL_MS);
    // back on the tab: read at once when the list on screen is older than one interval
    const onVisible = () => { if (!document.hidden && Date.now() - last >= DISCOVER_POLL_MS) load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [nonce]);
  const toggle = (mint: string) => setOpened((s) => { const n = new Set(s); if (n.has(mint)) n.delete(mint); else n.add(mint); return n; });

  return (
    <div className="dsc-page">
      <header className="dsc-top">
        <div className="dsc-top-text">
          <h1>Discover</h1>
          <p className="dsc-sub">Families buying far above their normal level, newest first</p>
        </div>
        <AlertButton />
      </header>
      {rows === null ? (
        error
          ? <ErrorBox error="The list could not be loaded." retry={() => { setError(null); setNonce((n) => n + 1); }} details={error} />
          : <ul className="dsc-list" aria-busy="true" aria-label="Loading the list">{Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="dsc-card dsc-skel"><div className="dsc-skel-head"><Skeleton h={32} w={32} r={999} /><span><Skeleton h={14} w={`${40 - i * 6}%`} /><Skeleton h={10} w={`${64 - i * 8}%`} /></span></div><Skeleton h={10} /><Skeleton h={10} w="80%" /></li>
          ))}</ul>
      ) : rows.length === 0 ? (
        <p className="dsc-empty">No family is buying far above its normal level right now.</p>
      ) : (
        <ul className="dsc-list" aria-label="Families buying far above their normal level" ref={listEl}
          onPointerEnter={(e) => { if (e.pointerType === "mouse") over.current = true; }} onPointerDown={touched}
          onPointerLeave={(e) => { if (e.pointerType === "mouse") { over.current = false; settle(); } }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) queueMicrotask(settle); }}>
          {rows.map((f) => <Card key={f.parent.mint} f={f} now={now} open={opened.has(f.parent.mint)} onToggle={() => toggle(f.parent.mint)} t={t} />)}
        </ul>
      )}
      <p className="dsc-note">{FOOT_NOTE}</p>
      {trade && <QuickTrade coin={trade.coin} side={trade.side} amount={trade.amount} solUsd={stats?.solUsd ?? null} onClose={() => setTrade(null)} />}
    </div>
  );
}
