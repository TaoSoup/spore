// Spore in numbers as a bento (DESIGN-ELEVATE §8, §9): what children lock is the hero figure, with the
// price line of $SPORE over the last week drawn behind it (the coin whose tree locks the most; the line
// names itself, so it is never read as the locked series). The smaller tiles carry their own small
// instruments: launches split by depth, and how many roots have grown a tree. Every number is the API's.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { countUp, motionPaused, useInView } from "../../lib/motion";
import { api, type Stats } from "../../lib/api";
import { count, plural, usd } from "../../lib/format";
import { SPORE_COIN } from "../../lib/policy";
import { Stat, StatStrip } from "../Stat";
import LiveNumber from "../LiveNumber";
import Term from "../Term";
import { ErrorBox } from "../Bits";

const W = 400, H = 120, WEEK = 7 * 24 * 3600;

/// $SPORE's hourly closes over the last week as a gradient area; null while loading or with < 2 points.
function useSporeWeek(enabled: boolean): { pts: number[]; change: number | null } | null {
  const [s, set] = useState<{ pts: number[]; change: number | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api.candles(SPORE_COIN, 3600).then((r) => {
      const now = Date.now() / 1000;
      const c = r.candles.filter((x) => x.t >= now - WEEK);
      if (!alive || c.length < 2) return;
      const first = c[0].o || c[0].c, last = c[c.length - 1].c;
      set({ pts: c.map((x) => x.c), change: first > 0 ? (last - first) / first : null });
    }, () => { /* no candles: the tile keeps its number and no line */ });
    return () => { alive = false; };
  }, [enabled]);
  return s;
}

function WeekSpark({ pts }: { pts: number[] }) {
  const d = useMemo(() => {
    const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || hi || 1;
    const xy = pts.map((p, i) => [(i / (pts.length - 1)) * W, H - 10 - ((p - lo) / span) * (H - 30)] as const);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
    return { line, area: `${line}L${W} ${H}L0 ${H}Z`, last: xy[xy.length - 1] };
  }, [pts]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="bento-spark">
      <defs><linearGradient id="bento-spark-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".28" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path d={d.area} fill="url(#bento-spark-fill)" />
      <path d={d.line} className="bento-spark-line" pathLength={1} />
    </svg>
  );
}

/// The hero figure: counts up from zero the first time the bento scrolls into view, then tweens to each
/// new value (lib/motion countUp; paused motion writes the value at once).
function HeroNumber({ value, format }: { value: number | null | undefined; format: (n: number) => string }) {
  const [ref, seen] = useInView<HTMLSpanElement>({ threshold: 0.4 });
  useEffect(() => {
    const el = ref.current;
    if (!el || value == null) return;
    // paused motion and automation (screenshots, crawlers) never count up: they get the real value at once,
    // like <Reveal>, so an off-screen capture never reads $0
    if (!seen) {
      if (motionPaused() || navigator.webdriver === true) { el.dataset.value = String(value); el.textContent = format(value); }
      else if (el.dataset.value === undefined) el.textContent = format(0);
      return;
    }
    return countUp(el, value, format, 1100);
  }, [seen, value, format, ref]);
  return <span ref={ref} className="ln" />;
}

/// Launches by depth as one stacked bar (roots · children · grandchildren, in the depth colours), each
/// part at least 2 px so a small count still reads as a part, and the counts under it with their key.
const DEPTHS = [["root", "root", "roots"], ["child", "child", "children"], ["grand", "grandchild", "grandchildren"]] as const;
function DepthBar({ d }: { d: number[] }) {
  const v = [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
  return (
    <span className="bento-depth">
      <span className="bento-depth-bar" aria-hidden="true">
        {DEPTHS.map(([k], i) => v[i] > 0 && <i key={k} className={k} style={{ flexGrow: v[i] } as CSSProperties} />)}
      </span>
      <span className="bento-depth-key">
        {DEPTHS.map(([k, one, many], i) => <span key={k}><i className={k} aria-hidden="true" />{plural(v[i], one, many)}</span>)}
      </span>
    </span>
  );
}

export default function Numbers({ stats, error }: { stats: Stats | null; error: string | null }) {
  const week = useSporeWeek(true);
  const ours = stats?.mode === "ours";
  const launches = stats ? (ours ? stats.ourCoins ?? stats.coins : stats.coins) : null;
  const loading = !stats && !error;
  const d = stats?.byDepth ?? [];
  const locked = stats?.lockedUsd ?? 0;
  const rootsLaunched = d[0] ?? 0;
  const treeShare = stats && rootsLaunched > 0 ? Math.min(1, stats.roots / rootsLaunched) : 0;
  return (
    <div className="home-stats">
      <StatStrip className="bento">
        <Stat xl hero={locked > 0} className="b-hero" icon="lock" label={<Term k="locked">Locked by children</Term>} value={<HeroNumber value={stats?.lockedUsd} format={usd} />} loading={loading}
          sub={<><span>parent coins held inside child curves</span>{week && <span className="bento-spark-key"><i aria-hidden="true" />line: $SPORE price, 7 days{week.change != null ? ` (${week.change >= 0 ? "+" : ""}${(week.change * 100).toFixed(1)}%)` : ""}</span>}</>}
          spark={week ? <WeekSpark pts={week.pts} /> : undefined} />
        <Stat className="b-launch" icon="tree" label={ours || !stats ? "Spore launches" : "Coins indexed"} value={<LiveNumber value={launches} format={count} kind="count" />} loading={loading}
          sub={stats ? <DepthBar d={d} /> : undefined} />
        <Stat className="b-trees" icon="depth" label="Trees" value={<LiveNumber value={stats?.roots} format={count} kind="count" />} loading={loading}
          sub={stats ? <><span className="bento-meter" aria-hidden="true"><i style={{ "--w": `${treeShare * 100}%` } as CSSProperties} /></span><span>roots with at least one coin under them</span></> : undefined} />
        <Stat className="b-vol" icon="volume" label="24h volume" value={<LiveNumber value={stats?.volume24hUsd} format={usd} />} loading={loading}
          sub={stats ? `${ours ? "trading in Spore launches" : "trading in indexed coins"}${stats.solUsd ? ` · SOL ${usd(stats.solUsd)}` : ""}` : undefined} />
      </StatStrip>
      {error && !stats && <ErrorBox error="The numbers did not load. They refresh on their own every 30 seconds." />}
      {stats && !stats.backfill.done && <div className="notice info">Indexing the tree: {count(stats.backfill.resolved)} of {count(stats.backfill.total)} curves resolved. Lists fill in as it goes.</div>}
    </div>
  );
}
