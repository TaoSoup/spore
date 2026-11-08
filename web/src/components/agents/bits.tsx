// Small building blocks shared by the agents list, the agent page, the coin page's agent card and
// the home strip: the avatar with its orbiting agent, the status badge, the chips, the logo tile,
// the fee rule read from the chain, the launched-coin card and the icons. Every number is the API's;
// every sentence about fees and agents comes from lib/copy.ts.
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { solscanAccount, solscanTx, type AgentLaunched, type AgentSim, type AgentSource, type Agent, type Coin, type CoinRef, type Shares } from "../../lib/api";
import { AGENT_CADENCE, PUMP_CREATOR_FEE_PCT, ROOT_PCT } from "../../lib/copy";
import { feeRole, type FeeRoleTone } from "../../lib/fee-roles";
import { ROOT_SPLIT, PLATFORM_WALLET } from "../../lib/policy";
import { age, count, pctCurve, plural, short, sol, usd, usdCard, when } from "../../lib/format";
import { copyText } from "../../lib/hooks";
import { Logo, Skeleton } from "../Bits";
import Term from "../Term";
import { useToast } from "../Toast";
import Tilt from "../ui/Tilt";
import { SplitArc, type Tone } from "../illus/base";
import { useEntrance } from "./entrance";
import { BUSY_SEC, MIN_SCORE, idleFor, modelLabel, runState, toSec, type RunState } from "./data";
import "../agents.css";

/// "0.0261" → "0.026 SOL": two significant figures read better than four decimals for a launch cost.
export const costSol = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 1 ? n.toFixed(2) : parseFloat(n.toPrecision(2))} SOL`);
/// Dollars for model calls and small fees: $0.013 · $0.008 · $2.41 (never "$0.01190").
export const usdSmall = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n >= 1 ? usd(n) : n === 0 ? "$0" : `$${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`);
/// SOL with up to four decimals, no trailing noise: 0.0133 SOL · 0.12 SOL · 0 SOL
export const solShort = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n === 0 ? "0 SOL" : sol(n));
export const usdcAmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(2)} USDC`);
export const agoLabel = (t: number | null | undefined) => { const s = toSec(t); return s == null ? "—" : `${age(s)} ago`; };
/// "$SPREAD's agent": never "spread AGENT agent".
export const agentName = (root: { symbol: string | null; mint: string }) => `${root.symbol ? `$${root.symbol}` : short(root.mint)}'s agent`;
const nowSec = () => Math.floor(Date.now() / 1000);

/// The orbit avatar: the root's logo inside a ring (lime live, amber asleep, grey paused) with the
/// agent, an orange mote, circling it on a tilted orbit. The orbit is a CSS 3D plane (rotate +
/// rotateX) in the same 3D context as the logo, so the mote passes behind the logo at the top and in
/// front of it at the bottom; the mote counter-rotates to keep facing the viewer. Compositor only.
/// `spin="hover"` keeps it still until the card around it is hovered or focused (one ambient loop
/// per page); paused agents keep a still mote.
export function AgentAvatar({ root, state, size = 72, spin = "always" }: { root: CoinRef; state: RunState["state"]; size?: number; spin?: "always" | "hover" }) {
  return (
    <span className={`agent-avatar st-${state} spin-${spin}`} style={{ "--av": `${size}px` } as CSSProperties}>
      <span className="agent-avatar-halo" aria-hidden="true" />
      <Logo src={root.image} label={root.symbol} size={size} className="agent-avatar-img" />
      <span className="agent-orbit" aria-hidden="true"><span className="agent-orbit-spin"><i /></span></span>
    </span>
  );
}

const STATUS_TITLE = `Running: claims its fees every minute and launches a coin under its root ${AGENT_CADENCE} while its wallet can pay`;
/// Status badge: LIVE (its dot pulses only while the agent acted in the last 15 minutes, otherwise
/// "LIVE · idle 1h" with a still dot), asleep (the runner's reason in the title) or paused.
export function StatusBadge({ agent, now }: { agent: Pick<Agent, "status" | "wallet" | "totals" | "sleeping" | "reason">; now?: number }) {
  const s = runState(agent);
  const idle = s.state === "live" ? idleFor(agent, now ?? nowSec()) : null;
  const busy = idle != null && idle < BUSY_SEC;
  const last = toSec(agent.totals.lastActivityAt);
  return (
    <span className={`agent-status st-${s.state} ${busy ? "busy" : ""}`} title={s.state === "live" ? STATUS_TITLE : s.reason ?? undefined}>
      <i aria-hidden="true" />{s.label}{s.state === "live" && last != null && !busy && <small>· idle {age(last)}</small>}
    </span>
  );
}

/// "Claude Sonnet 5.5": the model the creator picked for this agent.
export function ModelChip({ model }: { model: string | null | undefined }) {
  const label = modelLabel(model);
  if (!label) return null;
  return <span className="agent-model-chip" title="The language model this agent names coins and draws logos with"><Icon kind="brain" />{label}</span>;
}

export function SourceChip({ source }: { source: AgentSource | undefined }) {
  if (!source) return null;
  return <span className={`agent-source ${source}`} title={source === "model" ? "Written by the language model" : "Built without a language model, from the root's own words (keyword extraction, templates, wordplay on the ticker)"}>{source === "model" ? "model" : "template"}</span>;
}

/// Where a coin's logo came from, for the launched cards and the coin page.
export const logoSourceLabel = (s: string | null | undefined): string | null => (s === "image" ? "logo by the image model" : s === "model" ? "logo drawn by the language model" : s === "template" ? "template logo" : null);

/// The generated logo, shown at any size; a missing or broken image becomes a palette tile with the
/// ticker, so the layout never shows a browser placeholder or an empty square.
export function ProposalLogo({ p, palette, size = 64, className = "", eager = false }: { p: { image: string | null; symbol: string | null }; palette?: string[] | null; size?: number; className?: string; eager?: boolean }) {
  const [broken, setBroken] = useState<string | null>(null);
  const [a = "#b6ff5c", b = "#0b3a22"] = palette ?? [];
  const tile = `radial-gradient(circle at 30% 25%, ${a}, ${b})`;
  const s: CSSProperties = { width: size, height: size, borderRadius: Math.round(size * 0.24) };
  // While the image loads (or if it hangs) the palette shows through instead of an empty square.
  if (p.image && broken !== p.image) return <img className={`agent-logo ${className}`} src={p.image} alt="" width={size} height={size} style={{ ...s, background: tile }} loading={eager ? "eager" : "lazy"} decoding="async" onError={() => setBroken(p.image)} />;
  return <div className={`agent-logo tile ${className}`} style={{ ...s, background: tile, fontSize: Math.max(11, Math.round(size * 0.26)) }} aria-hidden="true">{(p.symbol ?? "?").slice(0, 4)}</div>;
}

export function ThemeChips({ themes, max }: { themes: string[]; max?: number }) {
  const shown = max ? themes.slice(0, max) : themes;
  return (
    <ul className="agent-themes" aria-label="Themes">
      {shown.map((t) => <li key={t}>{t}</li>)}
      {max && themes.length > max && <li className="more" title={themes.slice(max).join(", ")}>+{themes.length - max}</li>}
    </ul>
  );
}

export const MOMENTUM_TEXT = "a 0–100 read of the root's last hour and day of trading; it doesn't gate a live agent";
/// Momentum 0..100 from the server's scorer: a read on the root's trading. Lime when busy, amber
/// when warming, grey when quiet; the reason string carries the actual explanation.
export function ScoreBar({ score, reason }: { score: number | null; reason: string | null }) {
  const v = score == null ? null : Math.max(0, Math.min(100, Math.round(score)));
  const tone = v == null ? "none" : v >= MIN_SCORE ? "hot" : v >= MIN_SCORE * 0.6 ? "warm" : "cold";
  return (
    <div className={`agent-score ${tone}`}>
      <div className="agent-score-top">
        <span className="agent-label">Root <Term k="agent" text={MOMENTUM_TEXT}>momentum</Term></span>
        <b className="mono">{v == null ? "—" : v}<small>/100</small></b>
      </div>
      <div className="agent-score-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v ?? 0} aria-label={`Momentum ${v ?? "unknown"} of 100`}>
        <i style={{ transform: `scaleX(${(v ?? 0) / 100})` }} />
      </div>
      {reason && <p className="agent-score-reason">{reason.replace(/^momentum \d+\/100:\s*/i, "")}</p>}
    </div>
  );
}

export const SIMULATED_TEXT = "tried on mainnet without sending, to check it would succeed";
export const CREATE_V2_TEXT = "the pump.fun launch transaction";
/// The server always sends a sim object; one that never ran says so in `err` with no measurements.
const notRun = (sim: AgentSim | null): boolean => !sim || (!sim.ok && sim.bytes == null && sim.unitsConsumed == null && /not simulated/i.test(sim.err ?? ""));

/// "dry-run passed · ≈ 0.015 SOL": the pre-flight of a launch (built and simulated before it is sent).
export function SimChip({ sim }: { sim: AgentSim | null }) {
  if (!sim || notRun(sim)) return <span className="agent-sim none" title="No dry run was recorded for this idea">no dry run</span>;
  if (!sim.ok) return <span className="agent-sim bad" title="The dry run of the launch transaction failed"><Icon kind="x" />dry-run failed</span>;
  return <span className="agent-sim ok" title="The launch transaction was built and tried on mainnet without sending"><Icon kind="check" />dry-run passed{sim.estCostSol != null ? ` · ≈ ${costSol(sim.estCostSol)}` : ""}</span>;
}

/// Every field of the simulation record, for an opened idea.
export function SimDetails({ sim }: { sim: AgentSim | null }) {
  if (!sim || notRun(sim)) return null;
  return (
    <dl className={`agent-sim-grid ${sim.ok ? "ok" : "bad"}`}>
      <div><dt>result</dt><dd className={sim.ok ? "good" : "bad"}>{sim.ok ? "would succeed" : "would fail"}</dd></div>
      <div><dt>size</dt><dd className="mono">{sim.bytes != null ? `${count(sim.bytes)} B` : "—"}<small> / 1,232</small></dd></div>
      <div><dt>compute</dt><dd className="mono">{sim.unitsConsumed != null ? `${sim.unitsConsumed.toLocaleString("en-US")} CU` : "—"}</dd></div>
      <div><dt>est. cost</dt><dd className="mono">{costSol(sim.estCostSol)}</dd></div>
      {sim.err && <div className="err"><dt>error</dt><dd className="mono">{sim.err.replace(/(https?:\/\/|www\.)\S+/gi, "").replace(/\{[\s\S]*?(\}|$)/g, "").trim()}</dd></div>}
    </dl>
  );
}

export function Palette({ colors }: { colors: string[] }) {
  return (
    <ul className="agent-palette" aria-label="Palette">
      {colors.map((c) => <li key={c}><i style={{ background: c }} /><span className="mono">{c.toLowerCase()}</span></li>)}
    </ul>
  );
}

export type IconKind = "check" | "x" | "spark" | "brain" | "wallet" | "copy" | "chev" | "launch" | "claim" | "payout" | "aifee" | "ai" | "swap" | "split";
const PATHS: Record<IconKind, string> = {
  check: "M5 12.5l4.2 4.2L19 7",
  x: "M7 7l10 10M17 7L7 17",
  chev: "M8 10l4 4 4-4",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  brain: "M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 3 3 3 0 0 0 2 3v1a3 3 0 0 0 3 3h3V4H9ZM15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 3 3 3 0 0 1-2 3v1a3 3 0 0 1-3 3h-3V4h3Z",
  wallet: "M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v2H5.5A2.5 2.5 0 0 1 3 7.5Zm0 0V17a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1H5.5M16 14h.01",
  copy: "M9 9h10v10H9zM5 15V6.5A1.5 1.5 0 0 1 6.5 5H15",
  launch: "M5 19c1-4 3-6 5-7m4-8c2 2 3 5 2 8-1 2-3 4-6 5l-3-3c1-3 3-5 5-6 2-1 5-1 7-1M9 13l2 2",
  claim: "M12 3v11m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  payout: "M7 17 17 7M9 7h8v8",
  aifee: "M12 3l1.8 4.6L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9l4.2-1.4L12 3ZM7 17 17 7M9 7h8v8",
  ai: "M12 3l1.8 4.6L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9l4.2-1.4L12 3ZM5 16l.8 2 2 .8-2 .8L5 21.5l-.8-1.9-2-.8 2-.8L5 16ZM19 15l.6 1.5 1.5.6-1.5.6L19 19l-.6-1.3-1.5-.6 1.5-.6L19 15Z",
  swap: "M4 8h13l-3-3M20 16H7l3 3",
  split: "M6 4v5a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v5M6 4 4 6m2-2 2 2M18 20l-2-2m2 2 2-2M12 12v8",
};
export function Icon({ kind, className = "" }: { kind: IconKind; className?: string }) {
  return <svg className={`agent-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[kind]} /></svg>;
}

/// An address with a copy button and a Solscan link; `n` characters at each end.
export function AddressRow({ address, n = 4, label = "Address", className = "" }: { address: string; n?: number; label?: string; className?: string }) {
  const toast = useToast();
  const copy = async () => { if (await copyText(address)) toast.success(`${label} copied`); else toast.error(`Could not copy the ${label.toLowerCase()}`); };
  return (
    <span className={`agent-addr ${className}`}>
      <span className="mono" title={address}>{short(address, n)}</span>
      <button type="button" className="agent-addr-btn" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`} title={`Copy ${label.toLowerCase()}`}><Icon kind="copy" /></button>
      <a className="agent-addr-btn" href={solscanAccount(address)} target="_blank" rel="noreferrer" aria-label={`${label} on Solscan`} title="Open on Solscan">solscan ↗</a>
    </span>
  );
}

/* ---------- the fee rule, read from the chain (A5) */
const SPLIT_TONE: Record<FeeRoleTone, Tone> = { creator: "lime", spore: "ink", agent: "agent", you: "lime", other: "violet" };
const SPLIT_VAR: Record<FeeRoleTone, string> = { creator: "var(--split-creator)", spore: "var(--split-spore)", agent: "var(--split-agent)", you: "var(--split-creator)", other: "var(--split-other)" };
const PLATFORM = PLATFORM_WALLET.toBase58();
const tradePct = (bps: number) => `${((bps / 10_000) * PUMP_CREATOR_FEE_PCT).toFixed(2)}%`;
const feePct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
/// The agent's slice of its root's creator fee, as the chain has it. The pinned 0.25 / 0.50 / 0.20
/// rule is drawn only when the agent's slice is on-chain in exactly that shape; otherwise the real
/// slices are drawn with a line that says why they differ.
export function FeeRule({ symbol, shares, agent, loading = false }: { symbol: string; shares: Shares | null | undefined; agent: string | null; loading?: boolean }) {
  // One wrapper in every branch (skeleton, hint, loaded): the entrance follows the same element.
  const [ref, on] = useEntrance<HTMLDivElement>();
  if (loading) {
    return (
      <div className="agent-rule is-loading" ref={ref} aria-busy="true">
        <div className="agent-rule-viz"><Skeleton w="100%" h={196} r={999} className="agent-rule-sk" /></div>
        <div className="agent-rule-side"><Skeleton h={16} w="80%" /><Skeleton h={16} w="70%" /><Skeleton h={16} w="60%" /></div>
      </div>
    );
  }
  if (!shares || shares.length === 0) return <div className="agent-rule is-empty" ref={ref}><p className="hint">The fee split of {symbol} could not be read from the chain just now.</p></div>;
  const agentIn = !!agent && shares.some((s) => s.address === agent);
  const pinned = agentIn && shares.length === 3 && shares.some((s) => s.address === agent && s.bps === ROOT_SPLIT.agent) && shares.some((s) => s.address === PLATFORM && s.bps === ROOT_SPLIT.platform);
  type Slice = { key: string; bps: number; tone: FeeRoleTone; label: string; note: string | null };
  const slices: Slice[] = [...shares].sort((a, b) => b.bps - a.bps).map((s) => {
    const r = feeRole(s.address, { agent, agentOf: `$${symbol.replace(/^\$/, "")}`, agentRole: "root", inferCreator: true });
    const tone = r.tone;
    const label = tone === "agent" ? "this agent" : tone === "spore" ? (s.bps === ROOT_SPLIT.creator + ROOT_SPLIT.platform ? "creator + Spore (same wallet)" : "Spore") : r.label;
    return { key: s.address, bps: s.bps, tone, label, note: tone === "spore" ? "buys & locks $SPORE" : tone === "agent" ? "its income" : null };
  });
  const rows: Slice[] = pinned
    ? [
      { key: "c", bps: ROOT_SPLIT.creator, tone: "creator", label: "creator", note: null },
      { key: "s", bps: ROOT_SPLIT.platform, tone: "spore", label: "Spore", note: "buys & locks $SPORE" },
      { key: "a", bps: ROOT_SPLIT.agent, tone: "agent", label: "this agent", note: "its income" },
    ]
    : slices;
  const pct = (r: Slice) => (pinned ? (r.tone === "creator" ? ROOT_PCT.creator : r.tone === "spore" ? ROOT_PCT.spore : ROOT_PCT.agent) : tradePct(r.bps));
  const merged = agentIn && !pinned && shares.some((s) => s.address === PLATFORM && s.bps === ROOT_SPLIT.creator + ROOT_SPLIT.platform);
  const mine = rows.find((r) => r.tone === "agent") ?? null;
  return (
    <div className="agent-rule" ref={ref}>
      <div className={`agent-rule-viz ${on ? "in" : ""}`} role="img" aria-label={`${symbol}'s creator fee on-chain: ${rows.map((r) => `${r.label} ${pct(r)}`).join(", ")} of every trade`}>
        <svg viewBox="0 0 120 120" fill="none" aria-hidden="true">
          <path className="agent-rule-track" d="M26.06 93.94A48 48 0 1 1 93.94 93.94" />
          <g className="agent-rule-arcs"><SplitArc cx={60} cy={60} r={48} sweep={270} start={135} gap={7} width={5} parts={rows.map((r) => ({ v: r.bps, tone: SPLIT_TONE[r.tone] }))} /></g>
        </svg>
        <span className="agent-rule-mid">
          {mine ? <><b className="mono">{pct(mine)}</b><small>its slice of every trade</small></> : <><b className="mono">{rows.length}</b><small>{rows.length === 1 ? "slice" : "slices"} on-chain, none its own</small></>}
        </span>
      </div>
      <div className="agent-rule-side">
        <ul className="agent-rule-legend">
          {rows.map((r) => (
            <li key={r.key} className={`t-${r.tone}`} title={`${feePct(r.bps)} of ${symbol}'s creator fee`}>
              <i style={{ background: SPLIT_VAR[r.tone] }} aria-hidden="true" />
              <span>{r.label}{r.note && <small>{r.note}</small>}</span>
              <b className="mono">{pct(r)}</b>
              <small className="mono">{feePct(r.bps)} of the fee</small>
            </li>
          ))}
        </ul>
        {!agentIn && <p className="hint">No slice of {symbol} trades: this agent lives on the 50% creator share of the coins it launched, paid in {symbol}.</p>}
        {merged && <p className="hint">{symbol}'s creator wallet is Spore's own, so the creator's {ROOT_PCT.creator} and Spore's {ROOT_PCT.spore} arrive as one slice.</p>}
      </div>
    </div>
  );
}

/* ---------- a coin the agent launched, with its market (A7) */
/// `market`: the coin from the root's children (undefined while loading, null when not indexed).
export function LaunchedCard({ coin, market, palette, eager = false, fresh = false }: { coin: AgentLaunched; market: Coin | null | undefined; palette?: string[] | null; eager?: boolean; fresh?: boolean }) {
  const name = coin.name ?? coin.symbol ?? short(coin.mint, 6);
  const graduated = !!market?.migrated;
  return (
    <Tilt as="article" max={5} className={`agent-launched ${graduated ? "grad" : ""} ${fresh ? "is-new" : ""}`}>
      <span className="agent-launched-light" aria-hidden="true" />
      <header className="agent-launched-head">
        <ProposalLogo p={coin} palette={palette} size={44} eager={eager} />
        <div className="agent-launched-title">
          <Link to={`/c/${coin.mint}`} className="agent-launched-link"><b>{name}</b></Link>
          <span className="mono">{coin.symbol ? `$${coin.symbol}` : short(coin.mint)} · <span title={when(coin.createdAt)}>{coin.createdAt ? age(coin.createdAt) : "—"}</span></span>
        </div>
        {graduated && <span className="chip good" title="Its bonding curve filled; it now trades in a PumpSwap pool">graduated</span>}
      </header>
      {coin.why ? <p className="agent-why">{coin.why}</p> : <p className="agent-why muted">{logoSourceLabel(coin.logoSource) ?? "launched under its root"}</p>}
      <div className="agent-launched-metrics">
        {market === undefined ? <Skeleton h={18} w="70%" />
          : market === null ? <span className="muted">not indexed yet</span>
          : <><b className="mono" title="market cap">{usdCard(market.mcapUsd)}<small> mcap</small></b><span className="mono">vol 24h {usdCard(market.volume24hUsd)} · {plural(market.trades24h, "trade")}</span></>}
      </div>
      <footer className="agent-launched-foot">
        {market ? (
          <>
            <span className="agent-curve" aria-hidden="true"><i style={{ transform: `scaleX(${graduated ? 1 : market.progress > 0 ? Math.max(0.02, Math.min(1, market.progress)) : 0})` }} /></span>
            <span className="mono">{graduated ? "graduated · PumpSwap" : `${pctCurve(market.progress)} to graduation`}</span>
          </>
        ) : <span />}
        {coin.signature && <a href={solscanTx(coin.signature)} target="_blank" rel="noreferrer" className="agent-tx" title="Launch transaction on Solscan">tx ↗</a>}
      </footer>
    </Tilt>
  );
}

/// A label + value cell for the small stat grids (coin page card, pays-for-itself sub line).
export function Mini({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return <div className="agent-mini-stat" title={title}><dt>{label}</dt><dd className="mono">{children}</dd></div>;
}
