import { Component, Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate, useNavigationType, type Location } from "react-router-dom";
import { SPORE_COIN } from "./lib/policy";
import Mark, { MARK_PATH, MARK_SPORES } from "./components/Mark";
import { ToastProvider } from "./components/Toast";
import { TradingWalletHost } from "./components/TradingWallet";
import WalletMenu from "./components/WalletMenu";
import OfficialCoin from "./components/OfficialCoin";
import LiveNumber from "./components/LiveNumber";
import { Sprout } from "./components/LaunchButton";
import { LiveDot } from "./components/SpawnFeed";
import { motionPaused, useMotionPref } from "./lib/motion";
import SlidingPill from "./components/ui/SlidingPill";
import { useMediaQuery, useStats } from "./lib/hooks";
import { NAV_MEMO0, navFold, type NavMemo } from "./lib/nav-fit";
import { useEvents } from "./lib/events";
import { count } from "./lib/format";
import { ErrorBox } from "./components/Bits";
import { FOOTER_ABOUT, FOOTER_BOTTOM, NON_CUSTODIAL } from "./lib/copy";
import Home from "./pages/Home";
import Explore from "./pages/Explore";
import MapPage from "./pages/Map";
import CoinPage from "./pages/Coin";
import Launch from "./pages/Launch";
import How from "./pages/How";
import Fees from "./pages/Fees";
import Claim from "./pages/Claim";
import NotFound from "./pages/NotFound";
import ApiDocs from "./pages/ApiDocs";
import Agents from "./pages/Agents";
import AgentDetail from "./pages/AgentDetail";
import EmbedTree from "./pages/embed/EmbedTree";
import EmbedMap from "./pages/embed/EmbedMap";
import { EmbedNotFound } from "./pages/embed/common";
import "./components/brand.css";

/// A page that fails to render says so in plain words, inside the shell, instead of blanking the site.
class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="container route-error"><ErrorBox error="This page could not be shown. Reload to try again." retry={() => window.location.reload()} /></div>;
  }
}

export const BRAND = { name: "Spore", tagline: "Coins that grow coins.", title: "Spore — coins that grow coins" };
/// The nav labels name what a visitor came to do; the titles say it in plain words (redesign
/// 2026-10-20). Launch is not a link here: it is the bar's lime pill.
const PRIMARY: readonly (readonly [string, string, string])[] = [
  ["/map", "Map", "Every pump.fun coin pair, live"],
  ["/explore", "Coins", "Every coin launched on Spore"],
  ["/agents", "Agents", "AI agents launching coins on their own"],
  ["/how", "How it works", "How launches, fees and agents work"],
  ["/claim", "Claim fees", "Collect the creator fees your coins earned"],
];
const MORE: readonly (readonly [string, string])[] = [["/fees", "Fees & rules"], ["/docs/api", "API"]];

/// Finds a search box on the current page and focuses it. The pages own their search components;
/// this only knows their markup (the shared Search box and the map's find box).
function focusSearch(): boolean {
  const el = document.querySelector<HTMLInputElement>('.search input, .map-search input, input[type="search"]');
  if (!el) return false;
  el.focus(); el.select();
  return true;
}
const typing = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable); };

/// Back/forward return to where the reader was; a new page starts at the top (instantly, so the
/// smooth scroll-behavior does not animate a page change); a hash scrolls to its element. Pages
/// load their data after mounting, so a restored position is retried once the content has grown.
function useScrollRestoration(loc: Location) {
  const type = useNavigationType();
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => { try { window.history.scrollRestoration = "manual"; } catch { /* older engines */ } }, []);
  useLayoutEffect(() => {
    const save = () => positions.current.set(loc.key, window.scrollY);
    window.addEventListener("scroll", save, { passive: true });
    return () => { save(); window.removeEventListener("scroll", save); };
  }, [loc.key]);
  useLayoutEffect(() => {
    if (loc.hash) { const el = document.getElementById(loc.hash.slice(1)); if (el) { el.scrollIntoView(); return; } }
    const y = type === "POP" ? (positions.current.get(loc.key) ?? 0) : 0;
    window.scrollTo({ top: y, behavior: "instant" });
    if (y > 0) { const t = window.setTimeout(() => { if (Math.abs(window.scrollY - y) > 2) window.scrollTo({ top: y, behavior: "instant" }); }, 300); return () => clearTimeout(t); }
  }, [loc.key, loc.hash, type]);
}

/// `/` focuses search (jumping to Explore when the page has none), `L` opens the launch page.
/// Nothing fires while typing or with a modifier held, so browser shortcuts keep working.
function useShortcuts(loc: Location) {
  const nav = useNavigate();
  const wantSearch = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || typing(e.target)) return;
      if (e.key === "/") { e.preventDefault(); if (!focusSearch()) { wantSearch.current = true; nav("/explore"); } }
      else if (e.key === "l" || e.key === "L") {
        // On the map with a coin selected, L launches under that coin (the map page handles it).
        if (window.location.pathname === "/map" && new URLSearchParams(window.location.search).has("focus")) return;
        e.preventDefault(); nav("/launch");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);
  useEffect(() => {
    if (!wantSearch.current) return;
    wantSearch.current = false;
    const raf = requestAnimationFrame(() => { if (!focusSearch()) setTimeout(focusSearch, 120); });
    return () => cancelAnimationFrame(raf);
  }, [loc.pathname]);
}

/// Canonical and og:url follow the route (the origin comes from the page itself; index.html set
/// the initial values). Pages set their own "<Page> · Spore" titles; the home page gets the brand one.
function useRouteMeta() {
  const loc = useLocation();
  useEffect(() => {
    // A map link is addressed by the coin it focuses (the server's og:url for it carries ?focus= too); nothing else from the query is part of the address.
    const focus = loc.pathname === "/map" ? new URLSearchParams(loc.search).get("focus") : null;
    const url = `${window.location.origin}${loc.pathname}${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`;
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", url);
    document.querySelector('meta[property="og:url"]')?.setAttribute("content", url);
    if (loc.pathname === "/") document.title = BRAND.title;
  }, [loc.pathname, loc.search]);
}

function MotionToggle() {
  const [paused, reduced, setPaused] = useMotionPref();
  return (
    <button type="button" className="motion-toggle" aria-pressed={paused} disabled={reduced} onClick={() => setPaused(!paused)}
      title={reduced ? "Your system asks for reduced motion, so animations are already off" : paused ? "Resume the background spores and other animations" : "Stop the background spores and other animations"}>
      <i aria-hidden="true" />{reduced ? "Animations off (system)" : paused ? "Animations paused" : "Pause animations"}
    </button>
  );
}

/// The entry route of this tab session, read by the coin page's "New to Spore?" strip. Written during
/// the shell's first render (before any page renders or runs an effect), once per tab session.
const ENTRY_KEY = "spore.entry";
function recordEntry() {
  try { if (!sessionStorage.getItem(ENTRY_KEY)) sessionStorage.setItem(ENTRY_KEY, window.location.pathname); } catch { /* storage blocked: the strip falls back to its own rule */ }
  return true;
}

/// The bar falls back to its compact form (the links in the ☰ sheet) whenever its row does not fit, at any width: a new
/// button in the bar can never slide under the links. Folded, it unfolds as soon as the row would fit again: the bar's
/// own parts are measured live (on wide screens the wallet stays in the bar when folded), the links at the natural width
/// they last had on show, plus the gaps and a margin, so it does not flicker at the edge.
function useNavFits(ref: { current: HTMLElement | null }, paused: boolean): boolean {
  const [tight, setTight] = useState(false);
  const folded = useRef(false), memo = useRef<NavMemo>(NAV_MEMO0), pausedRef = useRef(paused);
  const checkRef = useRef<(() => void) | null>(null);
  pausedRef.current = paused;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const part = (sel: string) => el.querySelector<HTMLElement>(sel);
    const px = (v: string) => parseFloat(v) || 0;
    const check = () => {
      // a phone always shows the ☰ sheet, and an open sheet is no row to measure
      if (pausedRef.current) return;
      const links = part(".nav-links"), right = part(".nav-right"), word = part(".wordmark");
      if (!links || !right || !word) return;
      const cs = getComputedStyle(el), ls = getComputedStyle(links), rs = getComputedStyle(right);
      // the links' natural width: their items (which keep their text's width) plus the pill's padding and border, so a
      // squeezed pill or the sheet's leftover highlight cannot pass for it
      // (fractional widths: five rounded widths can add up to 2 px more than the one rounded width they fill)
      const items = [...links.querySelectorAll<HTMLElement>(":scope > a.nav-item")];
      const linksNatural = items.reduce((t, a) => t + a.getBoundingClientRect().width, 0) + px(ls.paddingLeft) + px(ls.paddingRight) + px(ls.borderLeftWidth) + px(ls.borderRightWidth);
      const rightItems = [...right.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains("burger") && getComputedStyle(c).display !== "none").map((c) => c.offsetWidth);
      const next = navFold(folded.current, {
        innerScroll: el.scrollWidth, innerClient: el.clientWidth, linksNatural, linksClient: links.getBoundingClientRect().width,
        gap: px(cs.columnGap) || 20, rightGap: px(rs.columnGap) || 10,
        room: el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight), word: word.offsetWidth, rightItems,
      }, memo.current);
      memo.current = next.memo;
      if (next.folded !== folded.current) { folded.current = next.folded; setTight(next.folded); }
    };
    checkRef.current = check;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const c of [...el.children]) ro.observe(c);
    check();
    return () => { ro.disconnect(); checkRef.current = null; };
  }, [ref]);
  // measuring resumes (the sheet closed, a phone turned wide): check now, a size may not change to trigger it
  useLayoutEffect(() => { if (!paused) checkRef.current?.(); }, [paused]);
  return !tight;
}

/// Restarts a one-shot CSS class (the mark's bud, the pill's ring) without re-rendering React.
function flash(el: Element | null | undefined, cls: string, ms: number) {
  if (!el || motionPaused()) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}

/// FOOTER_ABOUT with each "$SPORE" linked to the official coin page.
function AboutCopy() {
  const parts = FOOTER_ABOUT.split("$SPORE");
  return <p>{parts.map((p, i) => <Fragment key={i}>{p}{i < parts.length - 1 && <NavLink to={`/c/${SPORE_COIN}`}>$SPORE</NavLink>}</Fragment>)}</p>;
}

/// The bar gains blur and a hairline once the page has scrolled (state flips only on the threshold).
function useScrolled(px = 8): boolean {
  const [scrolled, setScrolled] = useState(() => typeof window !== "undefined" && window.scrollY > px);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > px);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [px]);
  return scrolled;
}

/// Route transitions (DESIGN-ELEVATE §5): the outgoing page fades for 120 ms, then the incoming one
/// rises 12 px and fades in (CSS). Returns the location to render and whether the old page is leaving.
/// A change of only the query or hash (the launch form's parent, a map focus) keeps the page mounted
/// and switches at once, as does paused or reduced motion. The nav reads the real location, so its
/// active pill moves immediately.
const ROUTE_OUT_MS = 120;
function useRouteTransition(): [Location, boolean] {
  const loc = useLocation();
  const [shown, setShown] = useState(loc);
  const [leaving, setLeaving] = useState(false);
  useLayoutEffect(() => {
    if (loc === shown) return;
    if (loc.pathname === shown.pathname || motionPaused()) { setShown(loc); setLeaving(false); return; }
    setLeaving(true);
    const t = window.setTimeout(() => { setShown(loc); setLeaving(false); }, ROUTE_OUT_MS);
    return () => window.clearTimeout(t);
  }, [loc, shown]);
  return [shown, leaving];
}

/// The footer's watermark: "spore" set huge with the mark's seed as its "o" (the same geometry as
/// components/Mark), at 12 % alpha, bleeding off the bottom edge. Decorative.
function FooterWordmark() {
  return (
    <div className="footer-mark" aria-hidden="true">
      <span>sp</span>
      <svg className="footer-mark-o" viewBox="6 2 58 60" focusable="false">
        <defs>
          <linearGradient id="fm-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b6ff5c" stopOpacity=".13" /><stop offset=".7" stopColor="#b6ff5c" stopOpacity=".03" /><stop offset="1" stopColor="#b6ff5c" stopOpacity="0" /></linearGradient>
        </defs>
        <path d={MARK_PATH} fill="url(#fm-fill)" stroke="rgba(182,255,92,.13)" strokeWidth=".3" />
        {MARK_SPORES.map((p) => <circle key={p.fill} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} fillOpacity=".09" stroke={p.fill} strokeOpacity=".2" strokeWidth=".3" />)}
      </svg>
      <span>re</span>
    </div>
  );
}

function Shell() {
  const loc = useLocation();
  const [shown, leaving] = useRouteTransition();
  const { stats, error } = useStats();
  const [menu, setMenu] = useState(false);
  useState(recordEntry); // during the first render, so a page can read it in its own first render
  const menuRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const wordRef = useRef<HTMLAnchorElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const scrolled = useScrolled();
  // phones always use the ☰ sheet; wider screens when the row does not fit
  const phone = useMediaQuery("(max-width: 759.98px)");
  const fits = useNavFits(innerRef, phone || menu);
  const compact = phone || !fits;
  // the ☰ sheet belongs to the compact bar: it closes when the bar unfolds (a phone turned wide, a window widened)
  useEffect(() => { if (!compact) setMenu(false); }, [compact]);
  useScrollRestoration(shown);
  useShortcuts(shown);
  useRouteMeta();
  const closeMenu = useCallback(() => setMenu(false), []);
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  // The phone menu closes on Escape (focus returns to its button) and on a tap outside it; opening it
  // moves focus to its first link.
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLAnchorElement>(":scope > a.nav-item")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(false); burgerRef.current?.focus(); } };
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (!menuRef.current?.contains(t) && !burgerRef.current?.contains(t)) setMenu(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [menu]);
  // A launch landed: the mark buds and the launches pill rings once (CSS, no re-render).
  useEvents({ coin: () => { flash(wordRef.current?.querySelector(".mark"), "bud", 600); flash(pillRef.current, "ring", 1200); } });
  // The map fills the viewport and its canvas turns wheel events into zoom, so a footer under it
  // could never be scrolled to; the map route drops the page padding and the footer instead. The
  // shell follows the page being shown, so the layout swaps together with the page.
  const isMap = shown.pathname === "/map";
  const ours = stats?.mode === "ours";
  const launches = ours ? stats?.ourCoins ?? stats?.coins : stats?.coins;
  const down = !!error && !stats;
  const indexing = !!stats && !stats.backfill.done;
  const pillTitle = down ? "The Spore API is not answering right now" : stats ? (ours ? `${count(launches)} coins launched on Spore` : `${count(stats.coins)} coins indexed`) : "Connecting to the API";
  const pillBody = down ? "api down" : !stats ? "…" : indexing ? `indexing ${count(stats.backfill.resolved)}/${count(stats.backfill.total)}`
    : <><LiveNumber value={launches} format={count} kind="count" />{ours ? " launches" : " coins"}</>;
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className={`nav ${scrolled ? "scrolled" : ""} ${isMap ? "solid" : ""} ${menu ? "menu-open" : ""} ${compact ? "compact" : ""}`}>
        <div className="nav-inner" ref={innerRef}>
          <NavLink ref={wordRef} to="/" className="wordmark" aria-label="Spore home"><Mark /><span className="wordmark-text" aria-hidden="true">spore</span></NavLink>
          <nav id="primary-nav" ref={menuRef} className={`nav-links ${menu ? "open" : ""}`} aria-label="Primary">
            <SlidingPill hover items="a.nav-item" />
            {menu && phone && <div className="nav-sheet-wallet"><WalletMenu inline onAction={() => { closeMenu(); burgerRef.current?.focus(); }} /></div>}
            {PRIMARY.map(([to, label, title], i) => <NavLink key={to} to={to} title={title} className="nav-item" style={{ "--i": i } as CSSProperties}>{label}</NavLink>)}
            {/* The phone sheet is the only nav there, so the footer's links join it. */}
            {MORE.map(([to, label], i) => <NavLink key={to} to={to} className="sheet-only" onClick={closeMenu} style={{ "--i": PRIMARY.length + i } as CSSProperties}>{label}</NavLink>)}
          </nav>
          <div className="nav-right">
            {/* the API's state: only when it is down (the footer, and the map's panel, carry the live counts and indexing) */}
            {down && <span ref={pillRef} className="api-pill down" title={pillTitle}><LiveDot short /><span aria-hidden="true">{pillBody}</span><span className="sr-only">{pillTitle}</span></span>}
            <NavLink to="/launch" className="btn sm accent nav-launch" title="Launch a coin (shortcut: L)"><Sprout />Launch</NavLink>
            {!phone && <WalletMenu onOpen={closeMenu} />}
            <button ref={burgerRef} type="button" className="burger" aria-label={menu ? "Close menu" : "Open menu"} aria-expanded={menu} aria-controls="primary-nav" onClick={() => setMenu((m) => !m)}><i /><i /><i /></button>
          </div>
        </div>
      </header>
      {!isMap && <OfficialCoin />}
      <main id="main" tabIndex={-1} className={isMap ? "map-main" : undefined}>
        {/* Keyed by path so a page change plays the transition; search-param changes (the launch form's parent) keep the page mounted. */}
        <div className={`route ${leaving ? "leaving" : ""}`} key={shown.pathname}>
          <RouteBoundary><Routes location={shown}>
            <Route path="/" element={<Home />} />
            <Route path="/explore" element={<Explore />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/c/:mint" element={<CoinPage />} />
            <Route path="/launch" element={<Launch />} />
            {/* Old links and share posts say /spawn; it renders the same page. */}
            <Route path="/spawn" element={<Launch />} />
            <Route path="/how" element={<How />} />
            <Route path="/fees" element={<Fees />} />
            <Route path="/claim" element={<Claim />} />
            <Route path="/docs/api" element={<ApiDocs />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/:root" element={<AgentDetail />} />
            <Route path="*" element={<NotFound />} />
          </Routes></RouteBoundary>
        </div>
      </main>
      <TradingWalletHost />
      {!isMap && <footer className="footer">
        <div className="footer-grid">
          <div className="footer-col footer-about">
            <span className="footer-brand"><Mark size={22} /><b>{BRAND.name}</b><span>· {BRAND.tagline}</span></span>
            <AboutCopy />
            <p>{NON_CUSTODIAL}</p>
            <p className="footer-risk">Memecoins are risky; read <NavLink to="/fees">the fees and rules</NavLink> first.</p>
          </div>
          <div className="footer-col footer-site">
            <h4>Spore</h4>
            <nav className="footer-nav cols" aria-label="Footer">
              {PRIMARY.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}
              <NavLink to="/launch">Launch a coin</NavLink>
              {MORE.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}
            </nav>
          </div>
          <div className="footer-col">
            <h4>Elsewhere</h4>
            <nav className="footer-nav" aria-label="External links">
              <a href="https://x.com/Sporemap" target="_blank" rel="noreferrer">X · @Sporemap <span className="ext" aria-hidden="true">↗</span></a>
              <a href="https://pump.fun" target="_blank" rel="noreferrer">pump.fun <span className="ext" aria-hidden="true">↗</span></a>
              <a href="https://solscan.io" target="_blank" rel="noreferrer">Solscan <span className="ext" aria-hidden="true">↗</span></a>
            </nav>
          </div>
          <div className="footer-col">
            <h4>Display</h4>
            <MotionToggle />
            <div className="kbd-row" aria-label="Keyboard shortcuts"><span><kbd>/</kbd> search</span><span><kbd>L</kbd> launch</span><span><kbd>Esc</kbd> close</span></div>
          </div>
        </div>
        <div className="footer-bottom">
          <span className="footer-live" title={pillTitle}><LiveDot short />{down ? "api down" : !stats ? "connecting…" : indexing ? `indexing ${count(stats.backfill.resolved)}/${count(stats.backfill.total)}` : `${count(launches)} ${ours ? "launches" : "coins"}`}{stats?.solUsd ? ` · SOL $${stats.solUsd.toFixed(2)}` : ""}</span>
          <span>{FOOTER_BOTTOM}</span>
        </div>
        <FooterWordmark />
      </footer>}
    </div>
  );
}

/// Embeds (DESIGN §12) render outside the site shell: no nav, footer, official strip, toasts or
/// shortcuts, just the widget filling a partner's iframe. Any other /embed/ path is a small 404.
function Embeds() {
  return (
    <Routes>
      <Route path="/embed/tree/:mint" element={<EmbedTree />} />
      <Route path="/embed/map" element={<EmbedMap />} />
      <Route path="*" element={<EmbedNotFound />} />
    </Routes>
  );
}

export default function App() {
  const loc = useLocation();
  if (loc.pathname === "/embed" || loc.pathname.startsWith("/embed/")) return <Embeds />;
  return <ToastProvider><Shell /></ToastProvider>;
}
