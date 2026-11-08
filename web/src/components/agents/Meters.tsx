// The agent's gauges (elevation 2026-10-24): the fee jar (its share waiting in the root's fee vault,
// against the claim threshold), the launch fund (its wallet, against what the next launch needs) and
// "does it pay for itself?" (what it claimed against what it spent). Each is an instrument arc: a
// 240° hairline track with ticks, the value drawn in its tone with a glowing head, the number in the
// middle counting up the first time it is seen. Arcs move by stroke-dashoffset and a rotated head
// (no layout), and jump to their value under reduced or paused motion.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ActivityItem, AgentTotals, AgentWallet, Fees } from "../../lib/api";
import { AGENT_SEED_SOL } from "../../lib/copy";
import { count, usd } from "../../lib/format";
import { countUp } from "../../lib/motion";
import { instant, useEntrance } from "./entrance";
import { Skeleton } from "../Bits";
import LiveNumber from "../LiveNumber";
import Term from "../Term";
import { CLAIM_MIN_SOL, KEEP_SOL } from "./data";
import { solShort, usdSmall } from "./bits";
import EarnedSpent from "./EarnedSpent";

export const CLAIM_TEXT = "move earned fees from the coin's fee vault into the wallets in its split";
export const FEE_VAULT_TEXT = "where a coin's creator fees wait until someone claims them";

/* ---------- the arc instrument */
const SWEEP = 240, START = 150, R = 42;
const pt = (deg: number, r = R) => { const a = (deg * Math.PI) / 180; return [50 + r * Math.cos(a), 50 + r * Math.sin(a)]; };
const arcPath = (from: number, to: number, r = R) => { const [x1, y1] = pt(from, r), [x2, y2] = pt(to, r); return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`; };
const TRACK = arcPath(START, START + SWEEP);
const TICKS = Array.from({ length: 13 }, (_, i) => { const d = START + (SWEEP * i) / 12, [x1, y1] = pt(d, 46.5), [x2, y2] = pt(d, i % 3 === 0 ? 49.5 : 48.2); return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`; }).join("");
const [HX, HY] = pt(START);
export type ArcTone = "lime" | "teal" | "agent" | "good" | "violet";


/**
 * A 240° arc gauge. `f` is the filled fraction (0..1, null when unknown: track only); `parts` draws
 * two or more tones end to end instead (earned vs spent). `children` sit in the middle.
 */
export function Arc({ f, tone = "lime", parts, size = "md", label, sheen = 0, children }: { f: number | null; tone?: ArcTone; parts?: { v: number; tone: ArcTone }[]; size?: "sm" | "md" | "lg"; label: string; sheen?: number; children?: ReactNode }) {
  const [ref, seen] = useEntrance<HTMLSpanElement>();
  const shown = seen ? Math.max(0, Math.min(1, f ?? 0)) : 0;
  const full = (f ?? 0) >= 1;
  const total = parts ? parts.reduce((n, p) => n + Math.max(0, p.v), 0) : 0;
  let acc = 0;
  return (
    <span ref={ref} className={`agent-arc ${size} t-${tone} ${full ? "full" : ""} ${seen ? "in" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, f ?? 0) * 100)} aria-label={label}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <path className="agent-arc-ticks" d={TICKS} />
        <path className="agent-arc-track" d={TRACK} />
        {parts && total > 0 ? parts.map((p, i) => {
          const len = (p.v / total) * 100, off = acc;
          acc += len;
          return <path key={i} className={`agent-arc-part t-${p.tone}`} d={TRACK} pathLength={100} strokeDasharray={`${Math.max(0, len - (i ? 1.6 : 0)).toFixed(2)} 200`} strokeDashoffset={seen ? -(off + (i ? 1.6 : 0)) : 0} style={{ opacity: seen ? 1 : 0 }} />;
        }) : f != null && (
          <>
            <path className="agent-arc-val" d={TRACK} pathLength={100} strokeDasharray="100 200" strokeDashoffset={100 - shown * 100} />
            <g className="agent-arc-head" style={{ transform: `rotate(${(shown * SWEEP).toFixed(2)}deg)` }}><circle cx={HX} cy={HY} r={f > 0 ? 3.2 : 0} /></g>
          </>
        )}
        {sheen > 0 && <path key={sheen} className="agent-arc-sheen" d={TRACK} pathLength={100} strokeDasharray="14 200" />}
      </svg>
      {children && <span className="agent-arc-mid">{children}</span>}
    </span>
  );
}

/// A number that counts up from zero the first time it is seen, then follows its value.
export function CountNum({ value, format, className = "" }: { value: number; format: (n: number) => string; className?: string }) {
  const [ref, seen] = useEntrance<HTMLSpanElement>();
  const fmt = useRef(format);
  fmt.current = format;
  // The text is this component's own (React renders no child), so the tween can write it freely.
  // Before the first paint it reads zero when it will count, else the value (no flash either way).
  const first = useRef(value);
  useLayoutEffect(() => { const el = ref.current; if (!el) return; const v = instant() ? first.current : 0; el.dataset.value = String(v); el.textContent = fmt.current(v); }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !seen) return;
    return countUp(el, value, (n) => fmt.current(n), 900);
  }, [seen, value, ref]);
  return <span ref={ref} className={`num-display ${className}`} />;
}

/// 0.0204 · 0.000025 (a nearly empty jar still shows what is in it) · 0
const sol4 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n === 0 ? "0" : n < 0.001 ? n.toFixed(6).replace(/0+$/, "") : n.toFixed(4));
const sol3 = (n: number) => n.toFixed(3);
const pct = (f: number) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;

/// Fee jar: the agent's own `perShare` entry from GET /api/fees/:root, against the claim threshold.
export function FeeJar({ fees, loading, agent, symbol, sheen = 0 }: { fees: Fees | null; loading: boolean; agent: string | null; symbol: string; sheen?: number }) {
  const head = <span className="agent-label">Fee jar</span>;
  if (loading && !fees) return <div className="agent-gauge" aria-busy="true"><Skeleton w={132} h={132} r={66} /><div className="agent-gauge-text">{head}<Skeleton w={120} h={22} /><Skeleton w="80%" h={12} /></div></div>;
  if (!fees) return <div className="agent-gauge"><Arc f={null} tone="teal" label="Fee jar: not read" size="lg"><b className="num-display">—</b></Arc><div className="agent-gauge-text">{head}<p className="agent-gauge-note">Its share of {symbol}'s <Term k="claim" text={FEE_VAULT_TEXT}>fee vault</Term> could not be read just now.</p></div></div>;
  const mine = agent ? fees.perShare.find((s) => s.address === agent) : undefined;
  if (!mine) return <div className="agent-gauge"><Arc f={null} tone="teal" label="Fee jar: no slice" size="lg"><b className="num-display">0</b><small>no slice</small></Arc><div className="agent-gauge-text">{head}<p className="agent-gauge-note">No slice of {symbol} trades: this agent lives on the 50% creator share of the coins it launched, paid in {symbol}.</p></div></div>;
  const x = Number(mine.amount) / 10 ** fees.quoteDecimals;
  const isSol = fees.quoteMint == null;
  const full = isSol && x >= CLAIM_MIN_SOL;
  const f = isSol ? Math.min(1, x / CLAIM_MIN_SOL) : null;
  return (
    <div className={`agent-gauge ${full ? "full" : ""}`}>
      <Arc f={f} tone="teal" size="lg" sheen={sheen} label={`Fee jar: ${sol4(x)} of ${CLAIM_MIN_SOL} SOL`}>
        {isSol ? <><b><CountNum value={x} format={sol4} /></b><small>of {CLAIM_MIN_SOL} SOL</small></> : <><b className="num-display">{x.toPrecision(3)}</b><small>{fees.quoteSymbol}</small></>}
      </Arc>
      <div className="agent-gauge-text">
        {head}
        <span className="agent-gauge-big mono">{isSol ? pct(f ?? 0) : "—"}<small> full</small></span>
        <p className="agent-gauge-note">{full ? <>full · it <Term k="claim" text={CLAIM_TEXT}>claims</Term> on its next pass</> : <><Term k="claim" text={CLAIM_TEXT}>claims</Term> when full · its share waiting in {symbol}'s <Term k="claim" text={FEE_VAULT_TEXT}>fee vault</Term></>}</p>
      </div>
    </div>
  );
}

/// Launch fund: the wallet's SOL against what the next launch needs.
export function LaunchFund({ wallet, need, size = "md" }: { wallet: AgentWallet | null; need: number; size?: "sm" | "md" }) {
  const s = wallet?.sol ?? null;
  const full = s != null && s >= need;
  const f = s == null ? null : need > 0 ? Math.min(1, s / need) : 0;
  const label = `Launch fund: ${sol4(s)} of ${sol3(need)} SOL`;
  if (size === "sm") {
    return (
      <div className="agent-inst">
        <Arc f={f} tone="lime" size="sm" label={label}><b className="num-display">{f == null ? "—" : pct(f)}</b></Arc>
        <div className="agent-inst-text">
          <span className="agent-label">Launch fund</span>
          <span className="mono agent-inst-val">{s == null ? "not read yet" : <><b>{sol4(s)}</b> / {sol3(need)} SOL</>}</span>
          <span className={`agent-inst-note ${full ? "good" : ""}`}>{s == null ? "wallet not read" : full ? "ready to launch" : "filling from fees"}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={`agent-gauge ${full ? "full" : ""}`}>
      <Arc f={f} tone="lime" size="lg" label={label}>
        {s == null ? <b className="num-display">—</b> : <><b><CountNum value={s} format={sol4} /></b><small>of {sol3(need)} SOL</small></>}
      </Arc>
      <div className="agent-gauge-text">
        <span className="agent-label">Launch fund</span>
        <span className="agent-gauge-big mono">{f == null ? "—" : pct(f)}<small> full</small></span>
        <p className="agent-gauge-note">{s == null ? "Its wallet has not been read yet." : full ? "full · its next coin goes out on its next pass" : "next coin when full · it fills from claimed fees"}</p>
        {s != null && <span className="agent-gauge-live mono">wallet <LiveNumber value={s} format={sol4} /> SOL</span>}
      </div>
    </div>
  );
}

export type Economy = { earned: number | null; spent: number | null; pays: boolean | null };
/// earned = what it claimed (at today's prices); spent = launches at the SOL price + its AI bill.
export function economy(t: AgentTotals, solUsd: number | null | undefined): Economy {
  const spent = solUsd != null ? t.launchSol * solUsd + t.aiUsd : null;
  const earned = t.claimsUsd;
  return { earned, spent, pays: earned != null && spent != null ? earned >= spent : null };
}
const none = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n === 0 ? "none yet" : usd(n));
export const PAYS_HINT = `Its only income is creator fees. It was born with ${AGENT_SEED_SOL} SOL from its creator; everything after that it earned.`;
/// "1.07×": what it earned for every dollar it spent.
const ratio = (e: Economy) => (e.earned == null || e.spent == null || e.spent <= 0 ? null : e.earned / e.spent);
const ratioText = (r: number | null) => (r == null ? "—" : r >= 10 ? `${Math.round(r)}×` : `${r.toFixed(2)}×`);

/// The full panel (agent page: verdict, the earned-vs-spent areas, the ledger) or a small arc
/// instrument (list cards).
export function PaysForItself({ totals, wallet, solUsd, compact = false, activity }: { totals: AgentTotals; wallet: AgentWallet | null; solUsd: number | null | undefined; compact?: boolean; activity?: ActivityItem[] }) {
  const e = economy(totals, solUsd);
  const chip = e.pays == null ? null : e.pays ? <span className="chip good" title={PAYS_HINT}>pays for itself</span> : <span className="chip warn" title={PAYS_HINT}>still on its seed money</span>;
  const spentText = e.spent != null ? none(e.spent) : `${solShort(totals.launchSol)} + ${usdSmall(totals.aiUsd)}`;
  const has = e.earned != null && e.spent != null && e.earned + e.spent > 0;
  const r = ratio(e);
  if (compact) {
    return (
      <div className="agent-inst">
        <Arc f={has ? 1 : null} parts={has ? [{ v: e.earned ?? 0, tone: "good" }, { v: e.spent ?? 0, tone: "violet" }] : undefined} size="sm" label={has ? `Earned ${usd(e.earned ?? 0)}, spent ${usd(e.spent ?? 0)}` : "Nothing earned or spent yet"}>
          <b className="num-display">{ratioText(r)}</b>
        </Arc>
        <div className="agent-inst-text">
          <span className="agent-label">Earned · spent</span>
          <span className="mono agent-inst-val"><b className="good">{none(e.earned)}</b> · <b className="spent">{spentText}</b></span>
          {e.pays != null ? <span className={`agent-inst-note ${e.pays ? "good" : "warn"}`}>{e.pays ? "pays for itself" : "on its seed money"}</span> : <span className="agent-inst-note">no ledger yet</span>}
        </div>
      </div>
    );
  }
  const paid = totals.payoutsSol > 0 || totals.payoutsUsdc > 0 ? `${solShort(totals.payoutsSol)}${totals.payoutsUsdc > 0 ? ` + ${totals.payoutsUsdc.toFixed(2)} USDC` : ""}` : `nothing yet · pays out above ${KEEP_SOL} SOL`;
  return (
    <div className="agent-pays">
      <div className="agent-pays-head">
        <p className="agent-pays-line mono"><span className="agent-pays-k"><i className="good" aria-hidden="true" />earned</span><b className="good"><LiveNumber value={e.earned} format={none} /></b><span className="agent-pays-k"><i className="spent" aria-hidden="true" />spent</span><b className="spent">{e.spent != null ? <LiveNumber value={e.spent} format={none} /> : spentText}</b></p>
        <span className="agent-pays-verdict">{r != null && <span className="agent-pays-ratio mono" title="earned for every dollar spent">{ratioText(r)}</span>}{chip}</span>
      </div>
      {activity && <EarnedSpent activity={activity} solUsd={solUsd} />}
      <p className="hint">{PAYS_HINT}</p>
      <dl className="agent-pays-sub">
        <div><dt>launches</dt><dd className="mono">{totals.launches ? `${count(totals.launches)} · ${solShort(totals.launchSol)}` : "none yet"}</dd></div>
        <div><dt>model calls</dt><dd className="mono">{totals.aiCalls ? `${count(totals.aiCalls)} · ${usdSmall(totals.aiUsd)}` : "none yet"}</dd></div>
        <div><dt>paid out</dt><dd className="mono">{paid}</dd></div>
        <div><dt>wallet</dt><dd className="mono">{wallet ? <><LiveNumber value={wallet.sol} format={solShort} />{wallet.usd != null && <> ≈ <LiveNumber value={wallet.usd} format={usd} /></>}</> : "not read yet"}</dd></div>
        <div><dt>SOL price</dt><dd className="mono">{solUsd != null ? usd(solUsd) : "—"}</dd></div>
      </dl>
    </div>
  );
}
