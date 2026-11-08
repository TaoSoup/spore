import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type Coin } from "../lib/api";
import { age, count, pctCurve, plural, usdCard } from "../lib/format";
import { agentProvenance, useAgentIndex, type AgentProvenance } from "../lib/agent-index";
import { useTradePulse, type TradePulse } from "../lib/live-trades";
import { AgentChip, DepthBadge, Logo, ParentPill, Skeleton, nameOf, sym, useTint } from "./Bits";
import { motionPaused } from "./SporeCanvas";
import Term from "./Term";
import Tilt from "./ui/Tilt";
import "./discover.css";

/* ---------- sparkline data: one request per mint, shared by every card on the page, 2 min TTL.
   Candles are built from live trades, so a quiet coin has none. Cards only ask for coins that
   traded in the last 24 h; the rest show a flat "No trades in 24h" line without a request. */
/// `basis`: what the change is measured over ("24h", or the span of the candles the server has when
/// the last day holds fewer than two, e.g. "3d"), so a delta always names its basis.
export type Spark = { points: number[]; change: number | null; basis: string } | null;
const SPARK_TTL = 120_000, SPARK_RES = 900, SPARK_WINDOW = 24 * 3600;
const sparkCache = new Map<string, { at: number; p: Promise<Spark> }>();
export function loadSpark(mint: string): Promise<Spark> {
  const hit = sparkCache.get(mint);
  if (hit && Date.now() - hit.at < SPARK_TTL) return hit.p;
  const p = api.candles(mint, SPARK_RES).then((r) => {
    const now = Date.now() / 1000;
    const day = r.candles.filter((c) => c.t >= now - SPARK_WINDOW);
    // Fewer than two points in the last day: fall back to everything the server has.
    const use = day.length >= 2 ? day : r.candles;
    if (use.length < 2) return null;
    const points = use.map((c) => c.c);
    const first = use[0].o || use[0].c;
    const basis = day.length >= 2 ? "24h" : age(use[0].t);
    return { points, change: first > 0 ? (points[points.length - 1] - first) / first : null, basis };
  }).catch(() => null);
  sparkCache.set(mint, { at: Date.now(), p });
  return p;
}
/// undefined = not loaded yet, null = nothing to draw. Fetches only once the card is on screen.
export function useSparkline(mint: string, visible: boolean): Spark | undefined {
  const [spark, setSpark] = useState<{ mint: string; s: Spark } | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    loadSpark(mint).then((s) => { if (alive) setSpark({ mint, s }); });
    return () => { alive = false; };
  }, [mint, visible]);
  return spark && spark.mint === mint ? spark.s : undefined;
}
/// Defers work until the element scrolls into view (a grid of 200 cards must not fire 200 fetches).
export function useOnScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "240px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

const W = 100, H = 28, PAD = 3;
/// Sparkline v2 (DESIGN-ELEVATE §8): the close series as a 1.25 px line over a gradient area (the tone at
/// 28 % fading out), a hairline at the first close for reference, and the latest value as a round glowing
/// dot. The SVG stretches to its box with non-scaling strokes; the dot is an HTML element placed in percent,
/// so it stays round at any width. `tone` colours it by the period's direction.
export function Sparkline({ points, tone, className = "" }: { points: number[]; tone: "up" | "down" | "flat"; className?: string }) {
  const gid = `sg${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const d = useMemo(() => {
    const min = Math.min(...points), max = Math.max(...points), span = max - min;
    const y = (p: number) => (span > 0 ? H - PAD - ((p - min) / span) * (H - PAD * 2) : H / 2);
    const step = points.length > 1 ? W / (points.length - 1) : W;
    const xy = points.map((p, i) => [i * step, y(p)] as const);
    const line = xy.map(([x, yy], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${yy.toFixed(2)}`).join(" ");
    return { line, area: `${line} L${W} ${H} L0 ${H} Z`, last: xy[xy.length - 1], base: y(points[0]) };
  }, [points]);
  return (
    <span className={`spark-v2 ${tone} ${className}`.trim()}>
      <svg className={`spark ${tone}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".28" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient>
        </defs>
        <line className="spark-base" x1="0" x2={W} y1={d.base} y2={d.base} />
        <path className="spark-area" d={d.area} fill={`url(#${gid})`} />
        <path className="spark-line" d={d.line} />
      </svg>
      <i className="spark-last" aria-hidden="true" style={{ left: `${d.last[0]}%`, top: `${(d.last[1] / H) * 100}%` }} />
    </span>
  );
}
/// The honest flat line of a coin with nothing to draw: a dashed hairline ending in a dim dot, and the reason.
export function SparkNone({ text }: { text: string }) {
  return <span className="spark-none"><span className="spark-none-t">{text}</span><i aria-hidden="true" /></span>;
}

/* ---------- small shared pieces (Explore's table and rows use them too) */
export const sparkTone = (s: Spark | undefined): "up" | "down" | "flat" => (s?.change == null ? "flat" : s.change > 0.0005 ? "up" : s.change < -0.0005 ? "down" : "flat");
/// "+12%" · "−3.4%" · "0.0%": one decimal under 10 %.
export const changeText = (x: number) => { const p = Math.abs(x * 100); return `${x > 0.0005 ? "+" : x < -0.0005 ? "−" : ""}${p.toFixed(p < 10 ? 1 : 0)}%`; };
/// The change over the spark's basis as a chip: "+12% · 24h".
export function ChangeChip({ spark, className = "" }: { spark: Spark | undefined; className?: string }) {
  if (!spark || spark.change == null) return null;
  const tone = sparkTone(spark);
  return <span className={`chg ${tone} ${className}`} title={spark.basis === "24h" ? "Price change over the last 24 hours" : `Price change since its first recorded trade (${spark.basis} ago)`}>{changeText(spark.change)}<i> · {spark.basis}</i></span>;
}
const NEW_S = 15 * 60, LIVE_MS = 10_000, ACTIVE_MS = 120_000, RING_MS = 1_200, RING_GAP_MS = 2_500;
/// Re-render every `ms` while `on` (a card that is not new and not trading costs no timer).
function useEvery(ms: number, on: boolean) {
  const [, set] = useState(0);
  useEffect(() => { if (!on) return; const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t); }, [ms, on]);
}
/// A one-shot buy/sell ring when a trade lands: at most one per card per 2.5 s, none while motion is paused.
function useRing(pulse: TradePulse | null): "buy" | "sell" | null {
  const [ring, setRing] = useState<"buy" | "sell" | null>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenAt = pulse?.seenAt ?? 0, isBuy = pulse?.isBuy ?? true;
  useEffect(() => {
    if (!seenAt || Date.now() - seenAt > LIVE_MS) return;
    const now = Date.now();
    if (now - last.current < RING_GAP_MS || motionPaused()) return;
    last.current = now;
    setRing(isBuy ? "buy" : "sell");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRing(null), RING_MS);
  }, [seenAt, isBuy]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return ring;
}
const isZero = (n: number | null | undefined) => n === 0;

/// The one status a card shows at its right edge, by priority: new (under 15 min) · active now (3+ trades seen,
/// the latest under 2 min ago) · verifying · migrating · graduated. One slot, so a card never changes height.
function Status({ coin, newFor, active }: { coin: Coin; newFor: number | null; active: boolean }) {
  if (newFor == null && active) return <span className="chip accent cc-active" title="Three or more trades seen in the last couple of minutes"><i aria-hidden="true" />active now</span>;
  if (newFor != null) return <span className={`chip accent cc-new ${newFor < ACTIVE_MS / 1000 ? "fresh-dot" : ""}`} title={coin.createdAt ? `Launched ${new Date(coin.createdAt * 1000).toLocaleString()}` : undefined}><i aria-hidden="true" />new<span className="cc-new-age"> · {age(coin.createdAt)}</span></span>;
  if (coin.oursPending) return <span className="chip warn" title="Reported as a Spore launch; the fee split is being verified on-chain">verifying</span>;
  if (coin.complete && !coin.migrated) return <span className="chip warn" title="Its bonding curve is full; the move to a PumpSwap pool is pending">migrating</span>;
  if (coin.migrated) return <span className="chip good" title="Its bonding curve filled; it trades in a PumpSwap pool">graduated</span>;
  return null;
}

/// The live text after a trade: "buy · 12s ago · $24".
const liveUsd = (v: number) => (v >= 1 && v < 1000 ? `$${Math.round(v)}` : usdCard(v));
const pulseText = (p: TradePulse) => `${p.isBuy ? "buy" : "sell"} · ${Math.max(0, Math.round((Date.now() - p.seenAt) / 1000))}s ago${p.valueUsd != null ? ` · ${liveUsd(p.valueUsd)}` : ""}`;

/// Agent provenance drawn on the logo: an orange mote on an orbit ring, dashed when an agent named, drew and
/// launched this coin, a fine solid ring when the coin is a root with its own agent. The words stay in the chip.
const AgentOrbit = ({ prov }: { prov: AgentProvenance }) => (prov ? <span className={`cc-orbit ${prov.role}`} aria-hidden="true"><i /></span> : null);

type Props = {
  coin: Coin; fresh?: boolean; size?: "md" | "lg" | "row"; rank?: number;
  /// The action slot (callers pass `<LaunchButton variant="soft">`, or `variant="icon"` in the row size).
  action?: ReactNode; spark?: boolean;
  /// Follow the coin's live trades (a ring, "active now", "buy · 12s ago"). Off-screen cards never subscribe.
  live?: boolean;
  /// The program's depth cap (stats.maxDepth), for the depth badge's explanation.
  maxDepth?: number;
};

/// The card used in grids and feeds (v3, 2026-10-24). Five slots: head (logo with the agent orbit, name,
/// $TICKER · age, one status), lineage (depth, parent or root, agent), signal (market cap + change +
/// sparkline v2), two numbers, the curve; then a quiet launch action. The card leans toward the pointer
/// (Tilt) and a light in the coin's own colour follows it. The name is a stretched link that covers the
/// card, so ctrl/cmd-click opens a new tab and every inner link, chip and Term stays its own target.
/// `--tint` is the coin image's dominant colour (hash hue until the image loads): logo ring, light and bloom.
export default function CoinCard({ coin, fresh = false, size = "md", rank, action, spark = true, live = true, maxDepth }: Props) {
  const [tint, onImg] = useTint(coin.image, coin.mint);
  const [ref, seen] = useOnScreen<HTMLElement>();
  const index = useAgentIndex();
  const prov = agentProvenance(coin, index);
  const traded = coin.trades24h > 0;
  const sp = useSparkline(coin.mint, spark && seen && traded);
  const pulse = useTradePulse(coin.mint, seen && live);
  const ring = useRing(pulse);
  const nowMs = Date.now();
  const ageS = coin.createdAt != null ? nowMs / 1000 - coin.createdAt : null;
  const newFor = ageS != null && ageS >= 0 && ageS < NEW_S ? ageS : null;
  const pulseFresh = !!pulse && nowMs - pulse.seenAt < LIVE_MS;
  const active = !!pulse && pulse.n >= 3 && nowMs - pulse.seenAt < ACTIVE_MS;
  useEvery(pulseFresh ? 1_000 : 10_000, pulseFresh || active || newFor != null);
  const cls = ["coin-card", "cc", size, fresh ? "fresh is-new" : "", coin.oursPending ? "pending" : "", ring ? `pulse-${ring}` : "", action ? "has-action" : "", spark ? "" : "no-spark", newFor != null ? "is-newborn" : ""].filter(Boolean).join(" ");
  const style = { "--tint": tint } as CSSProperties;
  const link = <Link className="coin-card-link stretch-link" to={`/c/${coin.mint}`} title={nameOf(coin)}>{nameOf(coin)}</Link>;
  const ageEl = <time className="cc-age" dateTime={coin.createdAt ? new Date(coin.createdAt * 1000).toISOString() : undefined} title={coin.createdAt ? new Date(coin.createdAt * 1000).toLocaleString() : undefined}>{age(coin.createdAt)}</time>;

  if (size === "row") return <CoinRow {...{ coin, cls, style, link, ageEl, refEl: ref, onImg, rank, action, prov, newFor, sp, spark, traded }} />;

  const vol0 = isZero(coin.volume24hUsd) && coin.trades24h === 0;
  const lockedLive = (coin.lockedUsd ?? 0) >= 0.01;
  return (
    <Tilt as="article" max={3} lift={2} className={cls} style={style} aria-label={`${nameOf(coin)} ${sym(coin)}`}>
      <span className="cc-light" aria-hidden="true" />
      <div className="cc-head" ref={ref as React.RefObject<HTMLDivElement | null>}>
        <span className="cc-logo">
          <Logo src={coin.image} label={coin.symbol} size={size === "lg" ? 56 : 44} className="ring" onLoad={onImg} />
          <AgentOrbit prov={prov} />
          {rank != null && <span className="cc-rank" aria-label={`rank ${rank}`}>#{rank}</span>}
        </span>
        <div className="cc-title">
          <b className="cc-name">{link}</b>
          <span className="cc-sub"><span className="cc-sym">{sym(coin)}</span>{newFor == null && <> · {ageEl}</>}<span className="cc-status"><Status coin={coin} newFor={newFor} active={active} /></span></span>
        </div>
      </div>

      {/* An agent launches under its own root: next to "under $ROOT" its chip shortens to "✦ agent" (full text stays in its title and accessible name). */}
      <div className={`cc-lineage ${prov?.role === "child" && prov.agent.root.mint === coin.parent?.mint ? "same-root" : ""}`}>
        <DepthBadge depth={coin.depth} term maxDepth={maxDepth} />
        {coin.parent ? <ParentPill parent={coin.parent} /> : <span className="pill root">root{coin.descendants > 0 ? ` · ${count(coin.descendants)} in tree` : ""}</span>}
        <AgentChip prov={prov} />
      </div>

      <div className="cc-signal">
        <div className="cc-mc">
          <span className="cc-label"><Term k="mcap">Market cap</Term></span>
          <span className="cc-mc-row"><b className={`cc-mc-v ${isZero(coin.mcapUsd) ? "is-zero" : ""}`}>{usdCard(coin.mcapUsd)}</b><ChangeChip spark={sp} /></span>
        </div>
        {spark && (
          <div className="cc-spark" aria-hidden="true">
            {!traded ? <SparkNone text="No trades in 24h" />
              : sp === null ? <SparkNone text="Chart starts after a few trades" />
              : sp === undefined ? <span className="spark-skel" />
              : <Sparkline points={sp.points} tone={sparkTone(sp)} />}
          </div>
        )}
      </div>

      <div className="cc-nums">
        <div>
          <span className="cc-label">Volume 24h</span>
          <b className={vol0 ? "is-zero" : ""}>{vol0 ? "none" : usdCard(coin.volume24hUsd)}</b>
        </div>
        {coin.children > 0 ? (
          <div>
            <span className="cc-label">Children</span>
            <b>{count(coin.children)}{coin.descendants > coin.children && <small> · {count(coin.descendants)} in tree</small>}</b>
            <span className="cc-locked"><Term k="locked">locked</Term> <span className={lockedLive ? "accent" : "is-zero"}>{usdCard(coin.lockedUsd)}</span></span>
          </div>
        ) : (
          <div>
            <span className="cc-label">Trades 24h</span>
            <b className={coin.trades24h === 0 ? "is-zero" : ""}>{plural(coin.trades24h, "trade")}</b>
          </div>
        )}
      </div>

      <div className="cc-curve">
        <div className="cc-curve-line">
          {coin.migrated
            ? <span className="cc-curve-l"><Term k="graduated">Graduated</Term> · trading on PumpSwap</span>
            : <span className="cc-curve-l pct"><Term k="curve">Bonding curve</Term> <b className={coin.progress > 0 ? "" : "is-zero"}>{pctCurve(coin.progress)}</b></span>}
          {/* the trade count rides here only when the numbers slot shows children instead; a quiet coin's
              "no trades" is already the signal row's flat line, so it is not repeated */}
          {pulseFresh && pulse ? <span className={`cc-live ${pulse.isBuy ? "buy" : "sell"}`}>{pulseText(pulse)}</span>
            : coin.children > 0 && traded ? <span className="cc-trades">{plural(coin.trades24h, "trade")} · 24h</span>
            : coin.children > 0 && !spark ? <span className="cc-trades is-zero">no trades · 24h</span>
            : null}
        </div>
        {coin.migrated ? <span className="cc-bar done" aria-hidden="true"><i /></span>
          : <span className="cc-bar" role="progressbar" aria-label="Bonding curve progress, to graduation" aria-valuenow={Math.round(coin.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(coin.progress > 0 ? 1.5 : 0, Math.min(100, coin.progress * 100))}%` }} /></span>}
      </div>

      {action && <div className="coin-card-action cc-action">{action}</div>}
    </Tilt>
  );
}

/// size "row": one line of the list view (and of phones): logo, name + one chip, "$TICKER · age · ↳ $PARENT",
/// then, when the row is wide enough (a container query), the 24 h sparkline and the 24 h volume as their
/// own mono columns; market cap over the change (or the 24 h volume), and the icon launch button.
function CoinRow({ coin, cls, style, link, ageEl, refEl, onImg, rank, action, prov, newFor, sp, spark, traded }: {
  coin: Coin; cls: string; style: CSSProperties; link: ReactNode; ageEl: ReactNode; refEl: React.RefObject<HTMLElement | null>; onImg: (img: HTMLImageElement) => void;
  rank?: number; action?: ReactNode; prov: AgentProvenance; newFor: number | null; sp: Spark | undefined; spark: boolean; traded: boolean;
}) {
  const chip = newFor != null ? <span className="chip accent cc-new"><i aria-hidden="true" />new</span>
    : prov ? <AgentChip prov={prov} />
    : coin.migrated ? <span className="chip good" title="Its bonding curve filled; it trades in a PumpSwap pool">graduated</span>
    : coin.oursPending ? <span className="chip warn" title="Reported as a Spore launch; the fee split is being verified on-chain">verifying</span> : null;
  const vol = coin.volume24hUsd;
  return (
    <article ref={refEl} className={cls} style={style} aria-label={`${nameOf(coin)} ${sym(coin)}`}>
      <span className="cc-logo">
        <Logo src={coin.image} label={coin.symbol} size={40} className="ring" onLoad={onImg} />
        <AgentOrbit prov={prov} />
        {rank != null && <span className="cc-rank" aria-label={`rank ${rank}`}>#{rank}</span>}
      </span>
      <div className="cr-main">
        <span className="cr-l1"><b className="cc-name">{link}</b>{chip}</span>
        <span className="cr-l2"><span className="cc-sym">{sym(coin)}</span> · {ageEl} · {coin.parent ? <span className="cr-under">↳ {sym(coin.parent)}</span> : <span className="cr-root">root{coin.descendants > 0 ? ` · ${count(coin.descendants)} below` : ""}</span>}</span>
      </div>
      {spark && (
        <div className="cr-spark" aria-hidden="true">
          {!traded ? <SparkNone text="no trades" /> : sp === null ? <SparkNone text="few trades" /> : sp === undefined ? <span className="spark-skel" /> : <Sparkline points={sp.points} tone={sparkTone(sp)} />}
        </div>
      )}
      <div className={`cr-vol2 ${vol > 0 ? "" : "is-zero"}`} title="Volume, last 24 hours">{vol > 0 ? usdCard(vol) : "none"}</div>
      <div className="cr-num">
        <b className={isZero(coin.mcapUsd) ? "is-zero" : ""} title="Market cap">{usdCard(coin.mcapUsd)}</b>
        {sp && sp.change != null ? <ChangeChip spark={sp} />
          : <span className={`cr-vol ${vol > 0 ? "" : "is-zero"}`}>{vol > 0 ? `vol ${usdCard(vol)}` : coin.trades24h > 0 ? plural(coin.trades24h, "trade") : "no trades"}</span>}
      </div>
      <div className="cr-act">{action}</div>
    </article>
  );
}

/// A skeleton bar inside the real slot's wrapper (same line box), so a skeleton is as tall as the card.
const Sk = ({ w, h }: { w: number | string; h: number }) => <Skeleton w={w} h={h} className="sk-in" />;

/// The loading state of a CoinCard, block for block (same slots, same heights), so a grid does not
/// jump when data lands. "row" is the list row.
export function CoinCardSkeleton({ size = "md" }: { size?: "md" | "lg" | "row" }) {
  if (size === "row") return (
    <div className="coin-card cc row sk-card" aria-hidden="true">
      <span className="cc-logo"><Skeleton w={40} h={40} r={20} /></span>
      <div className="cr-main"><Skeleton w="62%" h={15} /><Skeleton w="44%" h={11} /></div>
      <div className="cr-spark"><span className="spark-skel" /></div>
      <div className="cr-vol2"><Skeleton w={52} h={13} /></div>
      <div className="cr-num"><Skeleton w={64} h={15} /><Skeleton w={44} h={11} /></div>
      <div className="cr-act"><Skeleton w={36} h={36} r={18} /></div>
    </div>
  );
  const logo = size === "lg" ? 56 : 44;
  return (
    <div className={`coin-card cc ${size} has-action sk-card`} aria-hidden="true">
      <div className="cc-head"><span className="cc-logo"><Skeleton w={logo} h={logo} r={logo / 2} /></span><div className="cc-title"><b className="cc-name"><Sk w="70%" h={14} /></b><span className="cc-sub"><Sk w="48%" h={11} /></span></div></div>
      <div className="cc-lineage"><Skeleton w={40} h={22} r={11} /><Skeleton w={110} h={22} r={11} /></div>
      <div className="cc-signal"><div className="cc-mc"><span className="cc-label"><Sk w={78} h={10} /></span><span className="cc-mc-row"><b className="cc-mc-v"><Sk w={96} h={18} /></b></span></div><div className="cc-spark"><span className="spark-skel" /></div></div>
      <div className="cc-nums"><div><span className="cc-label"><Sk w={72} h={10} /></span><b><Sk w={56} h={13} /></b></div><div><span className="cc-label"><Sk w={64} h={10} /></span><b><Sk w={48} h={13} /></b></div></div>
      <div className="cc-curve"><div className="cc-curve-line"><span><Sk w={120} h={11} /></span></div><span className="cc-bar" /></div>
      <div className="coin-card-action cc-action"><Skeleton h={40} r={20} /></div>
    </div>
  );
}
