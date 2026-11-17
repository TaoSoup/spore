import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type UTCTimestamp } from "lightweight-charts";
import { api, pumpUrl, type Candle, type Candles, type Coin, type Trade } from "../lib/api";
import { useEvents } from "../lib/events";
import { useAsync, useLocalPref } from "../lib/hooks";
import { fillPollDelay, geckoPoolUrl, historyPending, lastMarkOn, liveCandle, pendingOf, sampledSummary, thinChartText } from "../lib/chart-fill";
import { ERROR_MS, MAX_ROWS, PAGE_POLL_MS, applyPage, backHint, firstCursor, freshBack, keepView, keyView, mergeFresh, mergeRange, normalize, pressAt, pressMove, pressMoved, seriesKey, takesAnswer, viewSpan, wantOlder, type Back, type Press } from "../lib/chart-pages";
import { age, clock, signedPct, subscriptSmall, tokens, usd } from "../lib/format";
import { Empty, ErrorBox, Ext, sym } from "./Bits";
import { Delta } from "./Stat";
import { LiveDot } from "./SpawnFeed";
import SlidingPill from "./ui/SlidingPill";
import type { LiveCoin } from "./coin/useLiveCoin";
import "./coin.css";
import "./coin/terminal.css";

const RES: { label: string; sec: number }[] = [{ label: "1m", sec: 60 }, { label: "5m", sec: 300 }, { label: "15m", sec: 900 }, { label: "1h", sec: 3600 }];
const UP = "#b6ff5c", DOWN = "#ff6b7a";
/// This chart (and only this one: sparklines, the map panel and the daily change keep the stored trades' meaning) asks
/// for the coin's history before the server's first stored trade. One object, so data.reload() keeps asking for it.
const WITH_HISTORY = { history: true } as const;
const VOL_UP = "rgba(182,255,92,.34)", VOL_DOWN = "rgba(255,107,122,.34)";
/// The chart library labels its axis and crosshair in UTC; the page (tape, legend, readout) speaks the
/// reader's local time. Series times are shifted by the local offset at the library boundary only: the
/// rows, the buckets and the live-update logic keep real unix seconds.
const TZ = -new Date().getTimezoneOffset() * 60;
const toChart = (t: number) => (t + TZ) as UTCTimestamp;
/// What the candles show: market cap (price × supply, the default), the price in USD, or the price in
/// the quote coin. `Key` is the unit the server keyed the series by.
type Unit = "mcap" | "usd" | "quote";
type Key = "usd" | "quote";

/// Axis and legend need more resolution than the page's 3-figure usd(): candles of one coin sit
/// within a few percent of each other, so five significant digits, subscript notation for dust.
const trim = (s: string) => s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
/// Market cap on the axis: four significant digits with a unit suffix, so neighbouring ticks differ.
const SUFFIX: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
/// Ticks below zero (the axis margin under the lowest candle) get no label: nothing trades below 0.
const fmtCap = (dollars: boolean) => (n: number) => {
  if (!(n > 0)) return "";
  const [k, u] = SUFFIX.find(([k]) => n >= k) ?? [1, ""];
  return `${dollars ? "$" : ""}${trim((n / k).toPrecision(4))}${u}`;
};
const fmtPrice = (unit: Key) => (p: number) => {
  if (!(p > 0)) return "";
  const prefix = unit === "usd" ? "$" : "";
  if (p >= 1000) return prefix + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return prefix + trim(p.toFixed(p >= 100 ? 2 : 4));
  if (p >= 1e-6) return prefix + p.toPrecision(4); // zeros kept: "$0.001440" aligns with "$0.001424"
  return prefix + subscriptSmall(p);
};
/// Dust prices (1e-8 and below) need a minMove far below the library's default or every candle
/// rounds to zero.
const minMoveFor = (rows: Candle[]) => { const lows = rows.map((c) => c.l).filter((x) => x > 0); const min = lows.length ? Math.min(...lows) : 0; return min > 0 ? 10 ** (Math.floor(Math.log10(min)) - 3) : 1e-9; };

type Handles = { chart: IChartApi; candles: ISeriesApi<"Candlestick">; vol: ISeriesApi<"Histogram">; area: ISeriesApi<"Area"> };
/// The histogram asserts on values above ~9e13; a volume that large is a data fault, not a bar.
const safeV = (v: number) => (Number.isFinite(v) && v > 0 ? Math.min(v, 9e13) : 0);

/// A chart failure (a bad candle from the server, a library assertion) must never take the coin
/// page down with it: the section shows the error and a retry instead.
class ChartBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() { return this.state.error ? <section className="card chart"><ErrorBox error={`Chart failed: ${this.state.error}`} retry={() => this.setState({ error: null })} /></section> : this.props.children; }
}

/// The chart's own drawn states: a faint plot that is still being read (loading), or a baseline with
/// one dormant node where the first trade will land (empty). Same hairlines as the live chart.
function ChartDrawing({ kind }: { kind: "loading" | "empty" }) {
  const grid = [0.2, 0.4, 0.6, 0.8];
  const path = "M0 150C40 146 70 120 110 126S170 92 210 98 280 70 320 78 390 52 430 60 500 40 540 46 600 30 640 34";
  return (
    <svg className={`chart-draw is-${kind}`} viewBox="0 0 640 200" preserveAspectRatio="none" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="chart-draw-a" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#b6ff5c" stopOpacity=".16" /><stop offset="1" stopColor="#b6ff5c" stopOpacity="0" /></linearGradient>
      </defs>
      {grid.map((g) => <line key={g} x1="0" x2="640" y1={g * 200} y2={g * 200} stroke="rgba(255,255,255,.05)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
      {kind === "loading" ? (
        <>
          <path d={`${path}L640 200L0 200Z`} fill="url(#chart-draw-a)" className="chart-draw-area" />
          <path d={path} fill="none" stroke="#b6ff5c" strokeOpacity=".5" strokeWidth="1.25" strokeDasharray="3 6" vectorEffect="non-scaling-stroke" className="chart-draw-line" />
        </>
      ) : (
        <line x1="0" x2="640" y1="150" y2="150" stroke="#b6ff5c" strokeOpacity=".3" strokeWidth="1.25" strokeDasharray="2 6" vectorEffect="non-scaling-stroke" className="chart-draw-line" />
      )}
    </svg>
  );
}


/// Candles + volume from /api/candles, as market cap (the default), USD price or quote price. The
/// chart instance lives for the component's whole life: resolution and unit changes swap the data,
/// live trades extend the last candle in place (no flash, no refit), and the server's own
/// aggregation is re-read at most every 30 s so what is shown converges on what it keeps. Once the
/// user moves the chart, older candles load a page at a time as the first one nears the left edge
/// (lib/chart-pages.ts), prepended without moving the candles in view.
/// `onBuy`: the empty state's "Buy" (the page focuses the trade widget, or opens the phone sheet).
/// `live`: the page's live store; the header then reads the same live price and market cap as the
/// price block above it (the OHLC legend keeps the candle's own close).
/// `aside`: a live line for the foot, beside the live dot (the coin page's last trade); shown in every state.
/// The plot takes the height its card is given (the coin page sizes the card to the window) or the CSS default.
export default function PriceChart({ coin, onBuy, live, aside }: { coin: Coin; onBuy?: () => void; live?: LiveCoin | null; aside?: ReactNode }) {
  return <ChartBoundary resetKey={coin.mint}><Chart coin={coin} onBuy={onBuy} live={live ?? null} aside={aside} /></ChartBoundary>;
}

const UNITS: { k: Unit; label: string }[] = [{ k: "mcap", label: "MC" }, { k: "usd", label: "Price" }];
const resLabel = (sec: number) => RES.find((r) => r.sec === sec)?.label ?? `${Math.round(sec / 60)}m`;
const noStore = () => () => {};
/// A tick label within this many px of the last-value label on the axis is left blank (the label covers it).
const LABEL_CLEAR = 15;

function Chart({ coin, onBuy, live, aside }: { coin: Coin; onBuy?: () => void; live: LiveCoin | null; aside?: ReactNode }) {
  const [res, setRes] = useLocalPref<number>("chart-res", 300);
  // Older stored values ("usd", "quote") still mean what they meant.
  const [unitPref, setUnitPref] = useLocalPref<string>("chart-unit", "mcap");
  const data = useAsync(() => api.candles(coin.mint, res, undefined, WITH_HISTORY), [coin.mint, res]);
  const priceKey: Key = data.data?.priceKey ?? "usd";
  // Server candles are in `priceKey`; the other unit is derived with the coin's current USD-per-
  // quote rate, so historical candles in the derived unit are an approximation (flagged in the foot).
  const rate = coin.priceUsd != null && coin.priceQuote != null && coin.priceQuote > 0 ? coin.priceUsd / coin.priceQuote : null;
  const canToggle = rate != null && coin.quoteSymbol !== "USDC";
  const usdOk = priceKey === "usd" || rate != null;
  const unit: Unit = unitPref === "quote" && (canToggle || priceKey === "quote") ? "quote" : unitPref === "usd" ? "usd" : "mcap";
  const base: Key = unit === "quote" || !usdOk ? "quote" : "usd";
  const conv = base === priceKey || rate == null ? 1 : base === "usd" ? rate : 1 / rate;
  const supply = tokens(coin.totalSupply, coin.decimals);
  const factor = conv * (unit === "mcap" ? supply : 1);
  const dollars = base === "usd";
  const unitLabel = unit === "mcap" ? `MC in ${dollars ? "USD" : coin.quoteSymbol}` : dollars ? "USD" : coin.quoteSymbol;
  // A quote-keyed series carries volume in raw quote units (the indexer sums quoteAmount as
  // stored); USD series are already in dollars. SOL has 9 decimals, pump coins and USDC 6.
  const quoteDecimals = (coin as Coin & { quoteDecimals?: number }).quoteDecimals ?? (coin.quoteMint === null ? 9 : 6);
  const vScale = priceKey === "usd" ? 1 : 1 / 10 ** quoteDecimals;
  const fmt = useMemo(() => (unit === "mcap" ? fmtCap(dollars) : fmtPrice(base)), [unit, dollars, base]);
  // The header's resting value: the coin's live price or market cap in the chart's unit (the same
  // figure the price block shows), not the last candle's close, which can lag it. A primitive, so the
  // chart re-renders only when it changes.
  const liveValue = useSyncExternalStore(live ? live.subscribe : noStore, () => {
    const c = live ? live.get().coin : coin;
    const v = unit === "mcap"
      ? dollars ? c.mcapUsd ?? (c.priceUsd != null ? c.priceUsd * supply : null)
        : c.quoteMint === null && c.mcapSol != null ? c.mcapSol : c.priceQuote != null ? c.priceQuote * supply : null
      : dollars ? c.priceUsd : c.priceQuote;
    return v != null && Number.isFinite(v) && v > 0 ? v : null;
  });

  const box = useRef<HTMLDivElement>(null);
  const handles = useRef<Handles | null>(null);
  const rows = useRef<Candle[]>([]);
  const [version, setVersion] = useState(0);
  const [hover, setHover] = useState<Candle | null>(null);
  // Where the crosshair is (px in the stage), for the readout pill that follows the pointer or finger.
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const lastReload = useRef(0);
  const dot = useRef<HTMLSpanElement>(null);
  const keyIdx = useRef<number | null>(null);
  // Older pages (lib/chart-pages.ts). `kept`: the series' raw rows (server units, its price key), the newest window's
  // and every page's; `rows` is them scaled to the display unit. `gen` is bumped on every reset: an answer of an older
  // generation is dropped. `series` is what the pages are asked in; `lastData` tells a re-read from a unit change.
  const kept = useRef<Candle[]>([]);
  const back = useRef<Back>(freshBack("", null));
  const gen = useRef(0);
  const series = useRef<{ mint: string; res: number; key: Key } | null>(null);
  const lastData = useRef<Candles | null>(null);
  const retryT = useRef(0), waitT = useRef(0), settleT = useRef(0);
  const [, setBackTick] = useState(0);
  const backTick = () => setBackTick((x) => x + 1);
  // The visible rows' first and last indices: the "in view" change.
  const [span, setSpan] = useState<[number, number] | null>(null);
  const olderRef = useRef<() => void>(() => {});
  const spanRef = useRef<() => void>(() => {});

  /// Axis ticks: the library draws the last-value label over the tick marks without hiding them, so a
  /// tick within LABEL_CLEAR px of the last close is left blank. Re-applied when the last close moves.
  /// Prices become pixels through the area series: it has a point for every row, while a sampled chain price is only
  /// whitespace in the candles (a series without a bar in view converts nothing). Both share the right price scale.
  const fmtRef = useRef(fmt);
  const lastY = useRef<number | null>(null);
  const tickFmt = useCallback((values: number[]) => {
    const h = handles.current, last = rows.current[rows.current.length - 1];
    const y0 = h && last ? h.area.priceToCoordinate(last.c) : null;
    return values.map((v) => {
      const y = y0 != null && h ? h.area.priceToCoordinate(v) : null;
      return y != null && y0 != null && Math.abs(y - y0) < LABEL_CLEAR ? "" : fmtRef.current(v);
    });
  }, []);
  const refreshTicks = useCallback((force: boolean) => {
    const h = handles.current, last = rows.current[rows.current.length - 1];
    const y = h && last ? h.area.priceToCoordinate(last.c) : null;
    if (!h || (!force && y != null && lastY.current != null && Math.abs(y - lastY.current) < 1)) return;
    lastY.current = y;
    h.chart.applyOptions({ localization: { priceFormatter: fmtRef.current, tickmarksPriceFormatter: tickFmt } });
  }, [tickFmt]);
  const ticksRef = useRef(refreshTicks);
  ticksRef.current = refreshTicks;

  /// The glowing last price: an HTML dot on the last close, moved whenever the view or the data does.
  const placeDot = useCallback(() => {
    const h = handles.current, el = dot.current, last = rows.current[rows.current.length - 1];
    if (!h || !el) return;
    const x = last ? h.chart.timeScale().timeToCoordinate(toChart(last.t)) : null;
    const y = last ? h.area.priceToCoordinate(last.c) : null;
    if (x == null || y == null) { el.style.opacity = "0"; return; }
    el.style.opacity = "1";
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.dataset.dir = last.c >= last.o ? "up" : "down";
  }, []);

  /// The last-value label and price line sit on the candles, or on the line when the newest row is a sampled price
  /// (lib/chart-fill.ts lastMarkOn): the candles' would be missing, or stuck on an older candle's close.
  const markOn = useRef<"area" | "candles">("candles");
  const placeMarks = useCallback(() => {
    const h = handles.current, on = lastMarkOn(rows.current);
    if (!h || on === markOn.current) return;
    markOn.current = on;
    h.candles.applyOptions({ lastValueVisible: on === "candles", priceLineVisible: on === "candles" });
    h.area.applyOptions({ lastValueVisible: on === "area", priceLineVisible: on === "area" });
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#90a797", fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 11, attributionLogo: false },
      // The site is English: month names on the axis and the crosshair follow it, not the OS locale.
      localization: { locale: "en-US" },
      // Hairlines on the value axis only; no boxed plot area.
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,.055)" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "rgba(237,245,238,.22)", style: LineStyle.Dashed, width: 1, labelBackgroundColor: "#112a1b" }, horzLine: { color: "rgba(182,255,92,.3)", style: LineStyle.Dashed, width: 1, labelBackgroundColor: "#112a1b" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      handleScale: { axisPressedMouseMove: true }, handleScroll: { vertTouchDrag: false },
    });
    // The gradient area under the closes sits behind the candles (added first, drawn first).
    const area = chart.addSeries(AreaSeries, { lineColor: "rgba(182,255,92,.42)", lineWidth: 1, topColor: "rgba(182,255,92,.2)", bottomColor: "rgba(182,255,92,0)", lastValueVisible: false, priceLineVisible: false, priceLineColor: "rgba(182,255,92,.55)", priceLineStyle: LineStyle.Dotted, crosshairMarkerVisible: false });
    const candles = chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceLineColor: "rgba(182,255,92,.55)", priceLineStyle: LineStyle.Dotted, lastValueVisible: true });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.subscribeCrosshairMove((p: MouseEventParams) => {
      const t = typeof p.time === "number" ? p.time : null;
      setHover(t == null ? null : rows.current.find((c) => c.t === t - TZ) ?? null);
      setAt(t == null || !p.point ? null : { x: p.point.x, y: p.point.y });
    });
    let raf = 0;
    // The view moved: the dot follows, the "in view" span is read again, and older candles load when the first one nears the edge.
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; placeDot(); olderRef.current(); spanRef.current(); }); };
    // Nothing older loads before the user moves the chart (a drag or pinch that changes the view, the wheel; keys in
    // onKey). A tap, a click, a page scroll that starts on the chart, or a finger held still to read the crosshair while
    // the chart shifts or refits by itself does not count, so the chart keeps refitting as history arrives and asks for
    // no page (lib/chart-pages.ts pressMoved).
    let press: Press | null = null;
    const range = () => chart.timeScale().getVisibleLogicalRange();
    const down = (e: PointerEvent | TouchEvent) => {
      // A second pointer or finger while one is held: a pinch (the first press keeps its view and place).
      const second = "touches" in e ? e.touches.length > 1 : !e.isPrimary;
      if (second) { press = pressMove(press, 0, 0, true); return; }
      const at = "touches" in e ? e.touches[0] : e;
      press = pressAt(range(), at.clientX, at.clientY);
    };
    const move = (e: PointerEvent | TouchEvent) => {
      if (!press) return;
      if ("touches" in e) { if (e.touches[0]) press = pressMove(press, e.touches[0].clientX, e.touches[0].clientY, e.touches.length > 1); }
      else if (e.isPrimary) press = pressMove(press, e.clientX, e.clientY);
    };
    const up = () => { press = null; };
    const wheel = () => { back.current.moved = true; };
    const onRange = (r: { from: number; to: number } | null) => { if (pressMoved(press, r)) back.current.moved = true; later(); };
    for (const ev of ["pointerdown", "touchstart"] as const) el.addEventListener(ev, down, { passive: true });
    for (const ev of ["pointermove", "touchmove"] as const) window.addEventListener(ev, move, { passive: true });
    for (const ev of ["pointerup", "pointercancel", "touchend", "touchcancel"] as const) window.addEventListener(ev, up, { passive: true });
    el.addEventListener("wheel", wheel, { passive: true });
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.timeScale().subscribeSizeChange(later);
    // The time scale reports width changes only. The box's height follows the window on the coin page, and the price
    // coordinates move with it: after autoSize's own resize and the price scale's relayout (the next frames, then a
    // settle), place the dot again and re-check the tick labels near it.
    let raf2 = 0, settle = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf2);
      raf2 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => { raf2 = 0; placeDot(); ticksRef.current(false); }); });
      clearTimeout(settle);
      settle = window.setTimeout(() => { placeDot(); ticksRef.current(false); }, 160);
    });
    ro.observe(el);
    handles.current = { chart, candles, vol, area }; markOn.current = "candles";
    return () => {
      for (const ev of ["pointerdown", "touchstart"] as const) el.removeEventListener(ev, down);
      for (const ev of ["pointermove", "touchmove"] as const) window.removeEventListener(ev, move);
      for (const ev of ["pointerup", "pointercancel", "touchend", "touchcancel"] as const) window.removeEventListener(ev, up);
      el.removeEventListener("wheel", wheel);
      cancelAnimationFrame(raf); cancelAnimationFrame(raf2); clearTimeout(settle); ro.disconnect(); chart.remove(); handles.current = null;
    };
  }, [placeDot]);

  /// Draws `kept` in the display unit. `fit`: fit the whole series (a new series, or one the user has not moved and that
  /// has no older pages); otherwise the view keeps the same candles (lib/chart-pages.ts keepView: rows prepended by a
  /// page or replaced by a re-read do not move it), and the keyboard's candle stays the same candle.
  const draw = useCallback(({ fit }: { fit: boolean }) => {
    const h = handles.current;
    if (!h) return;
    const ts = h.chart.timeScale();
    const r0 = ts.getVisibleLogicalRange(), old = rows.current;
    rows.current = kept.current.map((c) => ({ ...c, o: c.o * factor, h: c.h * factor, l: c.l * factor, c: c.c * factor, v: c.v * vScale }));
    fmtRef.current = fmt;
    h.chart.applyOptions({ localization: { priceFormatter: fmt, tickmarksPriceFormatter: tickFmt } });
    h.candles.applyOptions({ priceFormat: { type: "custom", formatter: fmt, minMove: minMoveFor(rows.current) } });
    h.area.applyOptions({ priceFormat: { type: "custom", formatter: fmt, minMove: minMoveFor(rows.current) } });
    // A sampled chain price (`s`) is a point on the area's line only: no body, no volume bar (its highs, lows and volume
    // are not known), so a sampled stretch reads as the faint line through real prices.
    h.area.setData(rows.current.map((c) => ({ time: toChart(c.t), value: c.c })));
    h.candles.setData(rows.current.map((c) => (c.s ? { time: toChart(c.t) } : { time: toChart(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    h.vol.setData(rows.current.map((c) => (c.s ? { time: toChart(c.t) } : { time: toChart(c.t), value: safeV(c.v), color: c.c >= c.o ? VOL_UP : VOL_DOWN })));
    placeMarks();
    if (fit) ts.fitContent();
    else {
      const v = keepView(r0 ? { from: r0.from, to: r0.to } : null, old, rows.current), cur = ts.getVisibleLogicalRange();
      if (v && (!cur || Math.abs(cur.from - v.from) > 0.01 || Math.abs(cur.to - v.to) > 0.01)) ts.setVisibleLogicalRange(v);
    }
    if (keyIdx.current != null) {
      const t = old[keyIdx.current]?.t, i = t == null ? -1 : rows.current.findIndex((c) => c.t >= t);
      keyIdx.current = rows.current.length ? Math.max(0, Math.min(rows.current.length - 1, i < 0 ? rows.current.length - 1 : i)) : null;
    }
    setVersion((v) => v + 1);
    // The price scale settles over the next frames (autoscale, the axis width): place the dot after it.
    requestAnimationFrame(() => requestAnimationFrame(() => { placeDot(); refreshTicks(true); spanRef.current(); }));
    clearTimeout(settleT.current);
    settleT.current = window.setTimeout(() => { placeDot(); refreshTicks(false); }, 250);
  }, [factor, fmt, vScale, placeDot, placeMarks, tickFmt, refreshTicks]);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // Older pages are dropped with the coin or the resolution (and on unmount): no answer or retry of theirs lands. The
  // answer on screen then is the previous series' until useAsync drops it: it must not seed the new one (a new factor
  // redraws in the same commit), so it is marked stale.
  const dataNow = useRef(data.data);
  dataNow.current = data.data;
  const staleData = useRef<Candles | null>(null);
  useEffect(() => () => {
    gen.current++; clearTimeout(retryT.current); clearTimeout(waitT.current);
    back.current = freshBack("", null);
    staleData.current = dataNow.current;
  }, [coin.mint, res]);
  useEffect(() => () => clearTimeout(settleT.current), []);

  // Full (re)load: a new series (coin, resolution or price key: the pages reset and the view fits), a re-read of the same
  // series (the 30 s reload, the fill/history poll: merged under the pages, the view kept once the user moved it or
  // pages are loaded), or only the display unit changed (MC, Price, quote: redrawn from the same raw rows).
  useEffect(() => {
    const d = data.data;
    if (!handles.current || !d || d === staleData.current) return;
    const sk = seriesKey(coin.mint, res, d.priceKey);
    if (sk !== back.current.key) {
      gen.current++; clearTimeout(retryT.current); clearTimeout(waitT.current);
      kept.current = normalize(d.candles);
      back.current = freshBack(sk, firstCursor(kept.current, res, coin.createdAt));
      series.current = { mint: coin.mint, res, key: d.priceKey };
      lastData.current = d;
      draw({ fit: true });
      keyIdx.current = null;
      setSpan(null); backTick();
    } else if (d !== lastData.current) {
      lastData.current = d;
      kept.current = mergeFresh(kept.current, d.candles);
      const b = back.current;
      // Before any page the cursor follows the newest window's first row (history arriving, a thin chart filling in).
      if (!b.pages && !b.busy && b.state === "idle") b.cursor = firstCursor(kept.current, res, coin.createdAt);
      draw({ fit: !b.moved && !b.pages });
    } else draw({ fit: false });
  }, [data.data, draw]); // eslint-disable-line react-hooks/exhaustive-deps

  /// Asks for the page below `back.cursor`, one at a time: a `loading` answer is asked again (the request counts as in
  /// flight meanwhile), a page lands without moving the view, and the next is asked only while the edge is still near.
  const loadOlder = () => {
    const b = back.current, s = series.current, hi = b.cursor;
    if (hi == null || !s) return;
    const g = gen.current;
    b.busy = true; backTick();
    const settle = (next: Back) => {
      back.current = next; backTick();
      if (next.state === "held") { clearTimeout(waitT.current); waitT.current = window.setTimeout(() => olderRef.current(), Math.max(0, next.heldUntil - Date.now()) + 50); }
    };
    api.candlesBefore(s.mint, s.res, s.key, hi).then((page) => {
      if (!takesAnswer(g, gen.current)) return;
      if (page.priceKey !== s.key) throw new Error("another price key");
      const r = applyPage(back.current, page, hi, Date.now());
      if (r.apply) {
        kept.current = mergeRange(kept.current, r.apply.rows, r.apply.lo, r.apply.hi);
        drawRef.current({ fit: false });
        if (kept.current.length >= MAX_ROWS && r.back.cursor != null) r.back.state = "full";
      }
      if (r.retryInMs != null) {
        settle({ ...r.back, busy: true });
        const again = () => { if (!takesAnswer(g, gen.current)) return; if (document.visibilityState === "hidden") { retryT.current = window.setTimeout(again, PAGE_POLL_MS); return; } loadRef.current(); };
        retryT.current = window.setTimeout(again, r.retryInMs);
        return;
      }
      settle({ ...r.back, busy: false });
      requestAnimationFrame(() => olderRef.current());
    }).catch(() => {
      if (!takesAnswer(g, gen.current)) return;
      // No error box: the chart itself is fine; older candles are tried again later.
      settle({ ...back.current, busy: false, state: "held", heldUntil: Date.now() + ERROR_MS });
    });
  };
  const loadRef = useRef(loadOlder);
  loadRef.current = loadOlder;
  /// Loads the next older page when the user moved the chart and its first candle is near the left edge.
  const maybeOlder = () => {
    const h = handles.current;
    if (!h) return;
    const r = h.chart.timeScale().getVisibleLogicalRange();
    if (wantOlder(back.current, r ? { from: r.from, to: r.to } : null, rows.current.length, Date.now())) loadOlder();
  };
  olderRef.current = maybeOlder;
  spanRef.current = () => {
    const r = handles.current?.chart.timeScale().getVisibleLogicalRange();
    const next = viewSpan(r ? { from: r.from, to: r.to } : null, rows.current.length);
    setSpan((prev) => (prev && next && prev[0] === next[0] && prev[1] === next[1]) || (!prev && !next) ? prev : next);
  };

  // Missed trades being read back (`fill`) or earlier history being read (`history` loading or sampling): ask again
  // every 5 s for 3 min, then every 30 s until nothing is pending (lib/chart-fill.ts; a hidden tab skips its asks). An
  // answer is applied only when it moved on (pendingOf: loading to sampling, sampling to done, the fill cleared; the
  // full reload above then refits the view, and this effect restarts for the new key or ends); one that did not is
  // dropped, so the view does not refit every 5 s. Each ask also keeps the coin in the server's queues.
  const pending = data.data ? pendingOf(data.data) : null;
  const filling = !!data.data?.fill, histPending = historyPending(data.data?.history);
  const hist = data.data?.history;
  const gecko = hist?.gecko ?? back.current.gecko;
  useEffect(() => {
    if (!pending) return;
    let n = 0, alive = true, t = 0;
    const next = () => { if (alive) t = window.setTimeout(ask, fillPollDelay(n)); };
    const ask = () => {
      if (document.visibilityState === "hidden") return next();
      n++;
      api.candles(coin.mint, res, undefined, WITH_HISTORY).then((d) => { if (!alive) return; if (pendingOf(d) === pending) next(); else data.setData(() => d); }).catch(next);
    };
    next();
    return () => { alive = false; clearTimeout(t); };
  }, [pending, coin.mint, res]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: extend or open the last candle from the trade event, then let the server re-aggregate.
  useEvents({ trade: (t: Trade) => {
    if (t.mint !== coin.mint) return;
    const h = handles.current;
    const raw = priceKey === "usd" ? t.priceUsd : t.priceQuote;
    if (h && raw != null && raw > 0 && rows.current.length) {
      const p = raw * factor;
      const bucket = Math.floor(t.time / res) * res;
      const last = rows.current[rows.current.length - 1];
      // Volume in the unit the rows hold: USD for a USD series, whole quote tokens otherwise.
      const v = priceKey === "usd" ? (t.valueUsd ?? (t.priceUsd ?? 0) * tokens(t.baseAmount, coin.decimals)) : tokens(t.quoteAmount, quoteDecimals);
      const c: Candle | null = liveCandle(last, bucket, p, v);
      if (!c) return; // older than the last bucket: the server's re-read below will place it
      if (bucket === last.t) rows.current[rows.current.length - 1] = c; else rows.current.push(c);
      // The raw rows get the same row in server units (the price as keyed, volume unscaled), so a redraw before the
      // next re-read (a page landing, a unit change) keeps it.
      const rawLast = kept.current[kept.current.length - 1], rc = rawLast ? liveCandle(rawLast, bucket, raw, v / vScale) : null;
      if (rc) { if (bucket === rawLast.t) kept.current[kept.current.length - 1] = rc; else kept.current.push(rc); }
      h.area.update({ time: toChart(c.t), value: c.c });
      h.candles.update({ time: toChart(c.t), open: c.o, high: c.h, low: c.l, close: c.c });
      h.vol.update({ time: toChart(c.t), value: safeV(c.v), color: c.c >= c.o ? VOL_UP : VOL_DOWN });
      placeMarks();
      setVersion((x) => x + 1);
      requestAnimationFrame(() => requestAnimationFrame(() => { placeDot(); refreshTicks(false); }));
      // A fresh print: the last-price dot rings once (CSS; still under reduced motion).
      const d = dot.current;
      if (d) { d.classList.remove("ping"); void d.offsetWidth; d.classList.add("ping"); }
    }
    const now = Date.now();
    if (now - lastReload.current > 30_000) { lastReload.current = now; data.reload(); }
  } });

  const n = rows.current.length;
  const first = rows.current[0], last = rows.current[n - 1];
  // "in view": the first visible candle's open to the last visible one's close (the whole series before the first view event).
  const change = useMemo(() => {
    const a = span ? rows.current[Math.min(span[0], n - 1)] : first, z = span ? rows.current[Math.min(span[1], n - 1)] : last;
    return a && z && a.o > 0 ? z.c / a.o - 1 : null;
  }, [first, last, span, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownValue = hover ? hover.c : liveValue ?? last?.c ?? null;
  const headline = shownValue == null ? "—" : unit === "mcap" ? (dollars ? usd(shownValue) : `${fmtCap(false)(shownValue)} ${coin.quoteSymbol}`) : fmt(shownValue);
  const notOurs = data.error && !data.data && /not a spore coin/i.test(data.error);
  const thin = !!data.data && n < 2;
  // Leaving the thin state: the full reload fitted the view while the box was still 0 px tall (coin.css .is-thin), so
  // the candles sat squeezed against the right edge. Fit again once the box has its size (earlier history or a fill
  // can turn a thin chart into a full one while the page is open).
  const wasThin = useRef(thin);
  useEffect(() => {
    const was = wasThin.current; wasThin.current = thin;
    if (!was || thin) return;
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => { handles.current?.chart.timeScale().fitContent(); placeDot(); refreshTicks(true); }); });
    return () => cancelAnimationFrame(raf);
  }, [thin, placeDot, refreshTicks]);
  // Arrow keys step the crosshair candle by candle (Home/End jump); Escape lets go.
  const onKey = (e: ReactKeyboardEvent) => {
    const h = handles.current;
    if (!h || n === 0) return;
    if (e.key === "Escape") { keyIdx.current = null; h.chart.clearCrosshairPosition(); setHover(null); setAt(null); return; }
    const cur = keyIdx.current ?? n - 1;
    const next = e.key === "ArrowLeft" ? cur - 1 : e.key === "ArrowRight" ? cur + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next == null) return;
    e.preventDefault();
    // The left arrow on the first candle, or Home: older candles (the crosshair stays on its candle when they land).
    if (e.key === "Home" || (e.key === "ArrowLeft" && keyIdx.current === 0)) { back.current.moved = true; maybeOlder(); }
    const i = Math.max(0, Math.min(n - 1, keyIdx.current == null && (e.key === "ArrowLeft" || e.key === "ArrowRight") ? n - 1 : next));
    keyIdx.current = i;
    const c = rows.current[i], ts = h.chart.timeScale(), r = ts.getVisibleLogicalRange();
    // Keys cannot drag: a candle outside the view is brought into it (a moved view, so nothing refits it). After a page
    // landed right-anchored, Home and the left arrow then reach the new rows, and the view's change (subscribed above)
    // asks for the next page at the left edge, as a drag would.
    const v = keyView(r ? { from: r.from, to: r.to } : null, i);
    if (v) { back.current.moved = true; ts.setVisibleLogicalRange(v); }
    h.chart.setCrosshairPosition(c.c, toChart(c.t), h.area);
    const x = ts.timeToCoordinate(toChart(c.t)), y = h.area.priceToCoordinate(c.c);
    setHover(c);
    setAt(x != null && y != null ? { x, y } : null);
  };
  const legend = hover ?? last ?? null;
  const summary = `${sym(coin)} ${unit === "mcap" ? "market cap" : "price"}, ${n} candles at ${resLabel(res)}${change != null ? `, ${change >= 0 ? "up" : "down"} ${Math.abs(change * 100).toFixed(1)} % in view` : ""}${sampledSummary(rows.current)}. Use the arrow keys to read each candle; the left arrow on the first one loads older candles.`;
  const overlay = data.loading ? <div className="chart-loading"><ChartDrawing kind="loading" /><span className="chart-state mono" role="status">reading candles…</span></div>
    // In "ours" mode the server keeps candles only for Spore launches (DESIGN §11.1); a parent
    // from the wider tree is not an error, it just has no chart here.
    : notOurs ? <Empty title="No price history here" hint={<>Spore keeps charts for its own launches. <Ext href={pumpUrl(coin.mint)}>See this coin's chart on pump.fun ↗</Ext></>} />
    : data.error && !data.data ? <ErrorBox error={data.error} retry={data.reload} />
    : null;

  return (
    <section className={`card chart ${overlay ? "is-overlay" : ""} ${thin ? "is-thin" : ""}`} aria-label={`${sym(coin)} chart`}>
      <div className="chart-head">
        <div className="chart-legend" aria-live="off">
          <span className="chart-k">{unit === "mcap" ? "MC" : "Price"}</span>
          <b className="chart-v mono">{headline}</b>
          {!hover && change != null && n >= 2 && <Delta ratio={change} label="in view" title="From the first candle in view to the last one in view" />}
          {hover && <span className="chart-when mono">{clock(hover.t)}</span>}
          {/* The last candle can be hours old while the header shows today's price: say when it closed.
              Without a live price the header is the last candle's close, and says so. */}
          {!hover && last && liveValue == null && <span className="chart-when">last candle{Date.now() / 1000 - (last.t + res) > 3_600 ? ` · ${age(last.t + res)} ago` : ""}</span>}
          {/* The coin page's foot aside says when the last trade was (from the trade itself): said once per card. */}
          {!hover && !aside && last && liveValue != null && Date.now() / 1000 - (last.t + res) > 3_600 && <span className="chart-when">last trade {age(last.t + res)} ago</span>}
        </div>
        <div className="chart-ctl">
          <span className="seg" role="group" aria-label="Chart unit">
            <SlidingPill />
            {UNITS.map((u) => <button key={u.k} type="button" aria-pressed={unit === u.k} onClick={() => setUnitPref(u.k)} title={u.k === "mcap" ? "Market cap: price × total supply" : undefined}>{u.label}</button>)}
            {canToggle && <button type="button" aria-pressed={unit === "quote"} onClick={() => setUnitPref("quote")} title={priceKey === "usd" ? `Price in ${coin.quoteSymbol}, converted at today's rate` : `Price in ${coin.quoteSymbol}`}>{coin.quoteSymbol}</button>}
          </span>
          <span className="seg" role="group" aria-label="Candle size">
            <SlidingPill />
            {RES.map((r) => <button key={r.sec} type="button" aria-pressed={res === r.sec} onClick={() => setRes(r.sec)}>{r.label}</button>)}
          </span>
        </div>
      </div>
      {legend && !overlay && !thin && (
        <div className={`ohlc-legend mono ${legend.c >= legend.o ? "up" : "down"} ${hover ? "is-hover" : ""}`} aria-hidden="true">
          {legend.s ? (
            // A sampled chain price: only its close is known.
            <><span><i>C</i><em>{fmt(legend.c)}</em></span><span className="ohlc-note">sampled</span></>
          ) : (
            <>
              <span><i>O</i>{fmt(legend.o)}</span><span><i>H</i>{fmt(legend.h)}</span><span><i>L</i>{fmt(legend.l)}</span><span><i>C</i><em>{fmt(legend.c)}</em></span><span><i>V</i>{priceKey === "usd" ? usd(legend.v) : legend.v.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
              {legend.o > 0 && <span className="ohlc-chg"><em>{signedPct(legend.c / legend.o - 1)}</em></span>}
            </>
          )}
        </div>
      )}
      <div className="chart-stage" tabIndex={!overlay && !thin ? 0 : -1} role={!overlay && !thin ? "img" : undefined} aria-label={!overlay && !thin ? summary : undefined} onKeyDown={onKey} onBlur={() => { if (keyIdx.current != null) { keyIdx.current = null; handles.current?.chart.clearCrosshairPosition(); setHover(null); setAt(null); } }}>
        <div ref={box} className="chart-box" aria-hidden="true" />
        <span ref={dot} className="chart-dot" aria-hidden="true" style={{ opacity: 0 }} hidden={!!overlay || thin} />
        {hover && at && !overlay && !thin && (
          <span className={`chart-tip mono ${at.x > (box.current?.clientWidth ?? 0) * 0.62 ? "flip" : ""}`} style={{ transform: `translate(${at.x.toFixed(0)}px, ${Math.max(8, at.y).toFixed(0)}px)` }} aria-hidden="true">
            <b className={hover.c >= hover.o ? "up" : "down"}>{unit === "mcap" ? (dollars ? usd(hover.c) : `${fmtCap(false)(hover.c)} ${coin.quoteSymbol}`) : fmt(hover.c)}</b>
            <small>{new Date(hover.t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {clock(hover.t).slice(0, 5)}</small>
          </span>
        )}
        {overlay && <div className="chart-overlay">{overlay}</div>}
        {thin && !overlay && (
          <div className="chart-empty">
            <ChartDrawing kind="empty" />
            <span className="chart-seed" aria-hidden="true" />
            <div className="chart-empty-text">
              <b>{thinChartText(n, filling, histPending)}</b>
              {onBuy && !filling && !histPending && <button type="button" className="btn soft sm" onClick={onBuy}>Buy {sym(coin)}</button>}
            </div>
          </div>
        )}
      </div>
      {(aside || (!overlay && !thin)) && (
        <div className="chart-foot">
          {!overlay && !thin && <span className="chart-foot-k">{n} candles · {resLabel(res)} · {unitLabel}{base !== priceKey ? ` · converted at today's ${coin.quoteSymbol} rate` : ""}{filling ? " · filling missed trades…" : ""}
            {histPending ? " · reading earlier history…" : ""}
            {backHint(back.current, n)}
            {/* The credit for GeckoTerminal's candles, shown whenever they are in view (the newest window's or older pages'). */}
            {gecko && <> · earlier: <Ext href={geckoPoolUrl(gecko)}>GeckoTerminal ↗</Ext></>}
            {(hist?.chain === "sampled" || back.current.chain === "sampled") && <span title="A line through a few real trades; highs, lows and volume are not known there"> · some earlier prices sampled from the chain</span>}
            {hist?.chain === "exact" ? " · earlier trades read from the chain" : ""}
            {change != null && <span className="sr-only">, {signedPct(change)} in view</span>}</span>}
          <span className="chart-foot-live">{aside}<LiveDot /></span>
        </div>
      )}
    </section>
  );
}
