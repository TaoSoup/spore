import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type UTCTimestamp } from "lightweight-charts";
import { api, pumpUrl, type Candle, type Coin, type Trade } from "../lib/api";
import { useEvents } from "../lib/events";
import { useAsync, useLocalPref } from "../lib/hooks";
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

/// Sort, dedupe and normalise to seconds: the chart library rejects unsorted or repeated times.
function normalize(rows: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of rows) {
    if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)) continue;
    const t = c.t > 1e12 ? Math.floor(c.t / 1000) : Math.floor(c.t);
    m.set(t, { ...c, t, v: Number.isFinite(c.v) ? c.v : 0 });
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

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
/// aggregation is re-read at most every 30 s so what is shown converges on what it keeps.
/// `onBuy`: the empty state's "Buy" (the page focuses the trade widget, or opens the phone sheet).
/// `live`: the page's live store; the header then reads the same live price and market cap as the
/// price block above it (the OHLC legend keeps the candle's own close).
export default function PriceChart({ coin, onBuy, live }: { coin: Coin; onBuy?: () => void; live?: LiveCoin | null }) {
  return <ChartBoundary resetKey={coin.mint}><Chart coin={coin} onBuy={onBuy} live={live ?? null} /></ChartBoundary>;
}

const UNITS: { k: Unit; label: string }[] = [{ k: "mcap", label: "MC" }, { k: "usd", label: "Price" }];
const resLabel = (sec: number) => RES.find((r) => r.sec === sec)?.label ?? `${Math.round(sec / 60)}m`;
const noStore = () => () => {};
/// A tick label within this many px of the last-value label on the axis is left blank (the label covers it).
const LABEL_CLEAR = 15;

function Chart({ coin, onBuy, live }: { coin: Coin; onBuy?: () => void; live: LiveCoin | null }) {
  const [res, setRes] = useLocalPref<number>("chart-res", 300);
  // Older stored values ("usd", "quote") still mean what they meant.
  const [unitPref, setUnitPref] = useLocalPref<string>("chart-unit", "mcap");
  const data = useAsync(() => api.candles(coin.mint, res), [coin.mint, res]);
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

  /// Axis ticks: the library draws the last-value label over the tick marks without hiding them, so a
  /// tick within LABEL_CLEAR px of the last close is left blank. Re-applied when the last close moves.
  const fmtRef = useRef(fmt);
  const lastY = useRef<number | null>(null);
  const tickFmt = useCallback((values: number[]) => {
    const h = handles.current, last = rows.current[rows.current.length - 1];
    const y0 = h && last ? h.candles.priceToCoordinate(last.c) : null;
    return values.map((v) => {
      const y = y0 != null && h ? h.candles.priceToCoordinate(v) : null;
      return y != null && y0 != null && Math.abs(y - y0) < LABEL_CLEAR ? "" : fmtRef.current(v);
    });
  }, []);
  const refreshTicks = useCallback((force: boolean) => {
    const h = handles.current, last = rows.current[rows.current.length - 1];
    const y = h && last ? h.candles.priceToCoordinate(last.c) : null;
    if (!h || (!force && y != null && lastY.current != null && Math.abs(y - lastY.current) < 1)) return;
    lastY.current = y;
    h.chart.applyOptions({ localization: { priceFormatter: fmtRef.current, tickmarksPriceFormatter: tickFmt } });
  }, [tickFmt]);

  /// The glowing last price: an HTML dot on the last close, moved whenever the view or the data does.
  const placeDot = useCallback(() => {
    const h = handles.current, el = dot.current, last = rows.current[rows.current.length - 1];
    if (!h || !el) return;
    const x = last ? h.chart.timeScale().timeToCoordinate(toChart(last.t)) : null;
    const y = last ? h.candles.priceToCoordinate(last.c) : null;
    if (x == null || y == null) { el.style.opacity = "0"; return; }
    el.style.opacity = "1";
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.dataset.dir = last.c >= last.o ? "up" : "down";
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
    const area = chart.addSeries(AreaSeries, { lineColor: "rgba(182,255,92,.42)", lineWidth: 1, topColor: "rgba(182,255,92,.2)", bottomColor: "rgba(182,255,92,0)", lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    const candles = chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceLineColor: "rgba(182,255,92,.55)", priceLineStyle: LineStyle.Dotted, lastValueVisible: true });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.subscribeCrosshairMove((p: MouseEventParams) => {
      const t = typeof p.time === "number" ? p.time : null;
      setHover(t == null ? null : rows.current.find((c) => c.t === t - TZ) ?? null);
      setAt(t == null || !p.point ? null : { x: p.point.x, y: p.point.y });
    });
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; placeDot(); }); };
    chart.timeScale().subscribeVisibleLogicalRangeChange(later);
    chart.timeScale().subscribeSizeChange(later);
    handles.current = { chart, candles, vol, area };
    return () => { cancelAnimationFrame(raf); chart.remove(); handles.current = null; };
  }, [placeDot]);

  // Full (re)load: resolution or unit changed, or the server series was re-read.
  useEffect(() => {
    const h = handles.current; const d = data.data;
    if (!h || !d) return;
    const raw = normalize(d.candles);
    rows.current = raw.map((c) => ({ ...c, o: c.o * factor, h: c.h * factor, l: c.l * factor, c: c.c * factor, v: c.v * vScale }));
    fmtRef.current = fmt;
    h.chart.applyOptions({ localization: { priceFormatter: fmt, tickmarksPriceFormatter: tickFmt } });
    h.candles.applyOptions({ priceFormat: { type: "custom", formatter: fmt, minMove: minMoveFor(rows.current) } });
    h.area.applyOptions({ priceFormat: { type: "custom", formatter: fmt, minMove: minMoveFor(rows.current) } });
    h.area.setData(rows.current.map((c) => ({ time: toChart(c.t), value: c.c })));
    h.candles.setData(rows.current.map((c) => ({ time: toChart(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    h.vol.setData(rows.current.map((c) => ({ time: toChart(c.t), value: safeV(c.v), color: c.c >= c.o ? VOL_UP : VOL_DOWN })));
    h.chart.timeScale().fitContent();
    keyIdx.current = null;
    setVersion((v) => v + 1);
    // The price scale settles over the next frames (autoscale, the axis width): place the dot after it.
    requestAnimationFrame(() => requestAnimationFrame(() => { placeDot(); refreshTicks(true); }));
    const t = setTimeout(() => { placeDot(); refreshTicks(false); }, 250);
    return () => clearTimeout(t);
  }, [data.data, factor, fmt, vScale, placeDot, tickFmt, refreshTicks]);

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
      let c: Candle;
      if (bucket === last.t) c = { ...last, h: Math.max(last.h, p), l: Math.min(last.l, p), c: p, v: last.v + v };
      else if (bucket > last.t) c = { t: bucket, o: last.c, h: Math.max(last.c, p), l: Math.min(last.c, p), c: p, v };
      else return; // older than the last bucket: the server's re-read below will place it
      if (bucket === last.t) rows.current[rows.current.length - 1] = c; else rows.current.push(c);
      h.area.update({ time: toChart(c.t), value: c.c });
      h.candles.update({ time: toChart(c.t), open: c.o, high: c.h, low: c.l, close: c.c });
      h.vol.update({ time: toChart(c.t), value: safeV(c.v), color: c.c >= c.o ? VOL_UP : VOL_DOWN });
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
  const change = useMemo(() => (first && last && first.o > 0 ? last.c / first.o - 1 : null), [first, last, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownValue = hover ? hover.c : liveValue ?? last?.c ?? null;
  const headline = shownValue == null ? "—" : unit === "mcap" ? (dollars ? usd(shownValue) : `${fmtCap(false)(shownValue)} ${coin.quoteSymbol}`) : fmt(shownValue);
  const notOurs = data.error && !data.data && /not a spore coin/i.test(data.error);
  const thin = !!data.data && n < 2;
  // Arrow keys step the crosshair candle by candle (Home/End jump); Escape lets go.
  const onKey = (e: ReactKeyboardEvent) => {
    const h = handles.current;
    if (!h || n === 0) return;
    if (e.key === "Escape") { keyIdx.current = null; h.chart.clearCrosshairPosition(); setHover(null); setAt(null); return; }
    const cur = keyIdx.current ?? n - 1;
    const next = e.key === "ArrowLeft" ? cur - 1 : e.key === "ArrowRight" ? cur + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(n - 1, keyIdx.current == null && (e.key === "ArrowLeft" || e.key === "ArrowRight") ? n - 1 : next));
    keyIdx.current = i;
    const c = rows.current[i];
    h.chart.setCrosshairPosition(c.c, toChart(c.t), h.candles);
    const x = h.chart.timeScale().timeToCoordinate(toChart(c.t)), y = h.candles.priceToCoordinate(c.c);
    setHover(c);
    setAt(x != null && y != null ? { x, y } : null);
  };
  const legend = hover ?? last ?? null;
  const summary = `${sym(coin)} ${unit === "mcap" ? "market cap" : "price"}, ${n} candles at ${resLabel(res)}${change != null ? `, ${change >= 0 ? "up" : "down"} ${Math.abs(change * 100).toFixed(1)} % in view` : ""}. Use the arrow keys to read each candle.`;
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
          {!hover && change != null && n >= 2 && <Delta ratio={change} label="in view" title={`From the first candle's open to the last close (${n} candles at ${resLabel(res)})`} />}
          {hover && <span className="chart-when mono">{clock(hover.t)}</span>}
          {/* The last candle can be hours old while the header shows today's price: say when it closed.
              Without a live price the header is the last candle's close, and says so. */}
          {!hover && last && liveValue == null && <span className="chart-when">last candle{Date.now() / 1000 - (last.t + res) > 3_600 ? ` · ${age(last.t + res)} ago` : ""}</span>}
          {!hover && last && liveValue != null && Date.now() / 1000 - (last.t + res) > 3_600 && <span className="chart-when">last trade {age(last.t + res)} ago</span>}
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
          <span><i>O</i>{fmt(legend.o)}</span><span><i>H</i>{fmt(legend.h)}</span><span><i>L</i>{fmt(legend.l)}</span><span><i>C</i><em>{fmt(legend.c)}</em></span><span><i>V</i>{priceKey === "usd" ? usd(legend.v) : legend.v.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
          {legend.o > 0 && <span className="ohlc-chg"><em>{signedPct(legend.c / legend.o - 1)}</em></span>}
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
              <b>{n === 0 ? "No trades yet — the chart starts with the first buy." : "Not enough price points yet — the chart fills in as trades land."}</b>
              {onBuy && <button type="button" className="btn soft sm" onClick={onBuy}>Buy {sym(coin)}</button>}
            </div>
          </div>
        )}
      </div>
      {!overlay && !thin && (
        <div className="chart-foot">
          <span>{n} candles · {resLabel(res)} · {unitLabel}{base !== priceKey ? ` · converted at today's ${coin.quoteSymbol} rate` : ""}{change != null && <span className="sr-only">, {signedPct(change)} in view</span>}</span>
          <LiveDot />
        </div>
      )}
    </section>
  );
}
