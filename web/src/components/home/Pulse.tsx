// "Live on Spore" (redesign 2026-10-20, H3): one calm row under the hero with the newest launches,
// agent actions and Spore-coin trades, newest at the left. Backfilled from the feed and the agents'
// own activity, then fed by the shared SSE stream. Never shouts: one trade per 3 s at most, inserts
// wait while the pointer or focus is inside the row, and screen readers get one polite summary per
// 30 s instead of every chip.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { solscanTx, type ActivityItem, type Agent, type AgentEvent, type Coin, type CoinRef, type Trade } from "../../lib/api";
import { useEvents, useStreamStatus } from "../../lib/events";
import { useTick } from "../../lib/hooks";
import { age, usdCard } from "../../lib/format";
import { nameOf, sym } from "../Bits";
import { motionPaused } from "../../lib/motion";
import { agentsCached, eventRoot, toSec } from "../agents/data";

type Kind = "launch" | "agent" | "buy" | "sell";
/// `mint`: the coin a launch is about, so one launch seen three ways (the coin event, the agent event, the
/// agent's activity) shows once, as the agent's line when an agent launched it.
type Item = { id: string; at: number; kind: Kind; text: string; href: string; ext: boolean; mint?: string };

const KEEP = 12, FRESH_S = 120, TRADE_GAP_MS = 3_000, AGENTS_MS = 60_000, ANNOUNCE_MS = 30_000, NEW_MS = 1_600, BACKFILL = 8;
/// The agent kinds the row shows, with the plain fallback used when a title is not fit to print.
const AGENT_KINDS: Partial<Record<ActivityItem["kind"], string>> = { claim: "claimed fees", launch: "launched a coin", payout: "paid out", aifee: "paid its AI bill" };
const DONE = new Set(["landed", "done", "step_landed"]);
const nowS = () => Math.floor(Date.now() / 1000);

const launchItem = (c: Coin): Item => ({
  id: `c:${c.mint}`, at: c.createdAt ?? nowS(), kind: "launch", href: `/c/${c.mint}`, ext: false, mint: c.mint,
  text: c.parent ? `${nameOf(c)} ${sym(c)} launched under ${sym(c.parent)}` : `New root ${sym(c)}`,
});
/// "$SPREAD's agent · Claimed 0.0072 SOL from $SPREAD": the server's title verbatim, unless it carries
/// raw data (a brace or a URL), in which case the plain verb stands in.
function agentItem(root: CoinRef, a: ActivityItem): Item | null {
  const plain = AGENT_KINDS[a.kind];
  if (!plain || !DONE.has(a.status)) return null;
  const title = /[{]|http/i.test(a.title) ? plain : a.title;
  const launched = a.kind === "launch" && a.mint ? a.mint : undefined;
  return { id: launched ? `a:launch:${launched}` : `a:${root.mint}:${a.kind}:${a.at}:${a.signature ?? a.title}`, at: a.at, kind: "agent", text: `${sym(root)}'s agent · ${title}`, href: a.explorer ?? `/agents/${root.mint}`, ext: !!a.explorer, mint: launched };
}
const merge = (cur: Item[], add: Item[]) => {
  const seen = new Set(cur.map((i) => i.id));
  const fresh = add.filter((i) => !seen.has(i.id));
  if (!fresh.length) return cur;
  const byAgent = new Set([...cur, ...fresh].filter((i) => i.kind === "agent" && i.mint).map((i) => i.mint));
  return [...fresh, ...cur].filter((i) => !(i.kind === "launch" && i.mint && byAgent.has(i.mint))).sort((a, b) => b.at - a.at).slice(0, KEEP);
};

const Glyph = ({ kind }: { kind: Kind }) => kind === "agent"
  ? <svg className="pulse-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3.5c.55 4.3 2.9 6.6 7.2 7.2-4.3.55-6.65 2.9-7.2 7.2-.55-4.3-2.9-6.65-7.2-7.2 4.3-.6 6.65-2.9 7.2-7.2Z" /></svg>
  : kind === "launch"
    ? <svg className="pulse-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22V10" /><path d="M12 14c0-3.5 2.5-6 6-6h2c0 3.5-2.5 6-6 6h-2Z" /><path d="M12 10C12 6.5 9.5 4 6 4H4c0 3.5 2.5 6 6 6h2Z" /></svg>
    : <svg className="pulse-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === "buy" ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}</svg>;

/// `coins`: Spore's launches from the page's /api/feed call (null while it loads). They seed the
/// backfill and name the mints whose trades the row reports.
export default function Pulse({ coins }: { coins: Coin[] | null }) {
  const [items, setItems] = useState<Item[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [agentsDone, setAgentsDone] = useState(false);
  const [summary, setSummary] = useState("");
  const status = useStreamStatus();
  useTick(10_000);
  const agents = useRef<Agent[]>([]);
  const hold = useRef({ hover: false, focus: false });
  const queue = useRef<Item[]>([]);
  const unread = useRef(0);
  const pending = useRef<{ t: Trade; v: number } | null>(null);
  const tradeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTrade = useRef(0);
  const track = useRef<HTMLDivElement>(null);
  const lefts = useRef(new Map<string, number>());

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const symbols = useMemo(() => new Map((coins ?? []).map((c) => [c.mint, sym(c)])), [coins]);
  const symbolsRef = useRef(symbols);
  symbolsRef.current = symbols;

  const add = (list: Item[], live: boolean) => {
    if (!list.length) return;
    if (live && (hold.current.hover || hold.current.focus)) { queue.current.push(...list); return; }
    setItems((cur) => merge(cur, list));
    if (!live) return;
    unread.current += list.length;
    const ids = list.map((i) => i.id);
    setFresh((s) => new Set([...s, ...ids]));
    setTimeout(() => setFresh((s) => { const n = new Set(s); ids.forEach((id) => n.delete(id)); return n; }), NEW_MS);
  };
  const release = () => {
    if (hold.current.hover || hold.current.focus || !queue.current.length) return;
    const q = queue.current;
    queue.current = [];
    add(q, true);
  };

  // Backfill: the newest launches, then each agent's latest actions, merged by time.
  useEffect(() => { if (coins) add(coins.slice(0, BACKFILL).map(launchItem), false); }, [coins]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    const read = (first: boolean) => agentsCached().then((r) => {
      if (!alive) return;
      agents.current = r.agents;
      const list = r.agents.flatMap((a) => a.activity.slice(0, first ? 4 : 12).map((x) => agentItem(a.root, x)).filter((x): x is Item => x !== null));
      if (first) add(list, false);
      else {
        // A re-read: what is newer than the row slides in as live, anything older merges silently.
        const top = itemsRef.current[0]?.at ?? 0;
        add(list.filter((i) => i.at <= top), false);
        add(list.filter((i) => i.at > top), true);
      }
    }, () => { /* no agents routes, or the API is down: the other sources still run */ }).finally(() => { if (alive) setAgentsDone(true); });
    void read(true);
    const t = setInterval(() => { if (document.visibilityState === "visible") void read(false); }, AGENTS_MS);
    return () => { alive = false; clearInterval(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const flushTrade = () => {
    tradeTimer.current = null;
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    lastTrade.current = Date.now();
    const s = symbolsRef.current.get(p.t.mint) ?? sym({ symbol: null, mint: p.t.mint });
    const side = p.t.isBuy ? "buy" : "sell";
    add([{ id: `t:${p.t.sig}`, at: toSec(p.t.time) ?? nowS(), kind: side, text: `${side} ${usdCard(p.v)} of ${s}`, href: `/c/${p.t.mint}`, ext: false }], true);
  };
  useEffect(() => () => { if (tradeTimer.current) clearTimeout(tradeTimer.current); }, []);

  useEvents({
    coin: (c) => add([launchItem(c)], true),
    agent: (e: AgentEvent) => {
      const l = e.proposal.launched;
      if (!l?.mint) return;
      const mint = eventRoot(e);
      const ref = typeof e.root === "object" ? e.root : agents.current.find((a) => a.root.mint === mint)?.root;
      const root = ref ?? (mint ? { mint, symbol: null, name: null, image: null, depth: 0 } : null);
      if (!root) return;
      const sig = l.signature ?? null;
      add([{ id: `a:launch:${l.mint}`, at: toSec(e.proposal.createdAt) ?? nowS(), kind: "agent", text: `${sym(root)}'s agent · Launched $${e.proposal.symbol}`, href: sig ? solscanTx(sig) : `/agents/${root.mint}`, ext: !!sig, mint: l.mint }], true);
    },
    trade: (t) => {
      if (document.hidden || !symbolsRef.current.has(t.mint)) return;
      const v = t.valueUsd;
      if (v == null || !(v >= 1)) return;
      if (!pending.current || v > pending.current.v) pending.current = { t, v };
      if (!tradeTimer.current) tradeTimer.current = setTimeout(flushTrade, Math.max(0, lastTrade.current + TRADE_GAP_MS - Date.now()));
    },
  });

  // One polite summary per 30 s at most, never the chips themselves.
  useEffect(() => {
    const t = setInterval(() => {
      if (!unread.current) return;
      setSummary(`${unread.current} new event${unread.current === 1 ? "" : "s"} on Spore`);
      unread.current = 0;
    }, ANNOUNCE_MS);
    return () => clearInterval(t);
  }, []);

  // FLIP: chips that moved slide from where they were; the new one enters from the left (CSS).
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const prev = lefts.current, next = new Map<string, number>();
    const move = prev.size > 0 && !motionPaused();
    for (const node of Array.from(el.children) as HTMLElement[]) {
      const id = node.dataset.id;
      if (!id) continue;
      const x = node.offsetLeft;
      next.set(id, x);
      const was = prev.get(id);
      if (move && was !== undefined && was !== x && node.offsetWidth > 0) node.animate([{ transform: `translateX(${was - x}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(.16,1,.3,1)" });
    }
    lefts.current = next;
  }, [items]);

  const loading = coins === null || !agentsDone;
  if (!loading && items.length === 0) return null;
  const last = items[0]?.at ?? null;
  const lastLaunch = items.find((i) => i.kind === "launch")?.at ?? coins?.[0]?.createdAt ?? null;
  const tone = status === "idle" ? "off" : last != null && nowS() - last < FRESH_S ? "live" : "quiet";
  const label = tone === "off" ? "offline" : tone === "live" ? `last event ${age(last)} ago` : lastLaunch != null ? `quiet · last launch ${age(lastLaunch)} ago` : "quiet";
  const setHold = (k: "hover" | "focus", v: boolean) => { hold.current[k] = v; if (!v) release(); };

  return (
    <section className="pulse" aria-label="Live on Spore"
      onPointerEnter={() => setHold("hover", true)} onPointerLeave={() => setHold("hover", false)}
      onFocus={() => setHold("focus", true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHold("focus", false); }}>
      <div className="pulse-head">
        <i className={`pulse-dot ${tone}`} aria-hidden="true" />
        <b>Live on Spore</b>
        <span className="pulse-fresh">{loading ? "connecting" : label}</span>
      </div>
      <div ref={track} className="pulse-track" role="log" aria-live="off" aria-label="Live activity on Spore">
        {loading && items.length === 0
          ? Array.from({ length: 6 }, (_, i) => <span key={i} className="sk pulse-sk" aria-hidden="true" />)
          : items.map((it) => {
            const body = <><Glyph kind={it.kind} /><span className="pulse-text">{it.text}</span><time className="pulse-age" dateTime={new Date(it.at * 1000).toISOString()}>{age(it.at)}</time></>;
            const cls = `pulse-chip ${it.kind} ${fresh.has(it.id) ? "is-new" : ""}`;
            return it.ext
              ? <a key={it.id} data-id={it.id} className={cls} href={it.href} target="_blank" rel="noreferrer" title="Open the transaction on Solscan">{body}</a>
              : <Link key={it.id} data-id={it.id} className={cls} to={it.href}>{body}</Link>;
          })}
      </div>
      <p className="sr-only" aria-live="polite">{summary}</p>
    </section>
  );
}
