// The coin page's agent card (redesign 2026-10-20, A9; elevated 2026-10-24: the orbit avatar and the
// agents' glass skin, same props and classes). A ROOT with an agent gets "This coin's
// agent": what it earns and does in one sentence, four small numbers, the latest coin it launched and
// a link to its page, in at most 320 px. A coin an agent launched gets "Launched by $ROOT's agent":
// the agent's reason and the on-chain proof. Both read the coin page's one shared
// GET /api/agents/coin/:mint (lib/agent-index useAgentCoin); a live launch swaps the latest row in.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { solscanTx, type AgentLaunched, type Coin } from "../../lib/api";
import { AGENT_CADENCE, AGENT_PAYOUT_TO, PUMP_CREATOR_FEE_PCT, ROOT_PCT } from "../../lib/copy";
import { ROOT_SPLIT } from "../../lib/policy";
import { useAgentCoin } from "../../lib/agent-index";
import { useEvents } from "../../lib/events";
import { useNow } from "../../lib/hooks";
import { age, count, short, usd } from "../../lib/format";
import { Logo, sym } from "../Bits";
import LiveNumber from "../LiveNumber";
import { AddressRow, AgentAvatar, agentName, agoLabel, logoSourceLabel, Mini, ModelChip, StatusBadge, usdSmall } from "./bits";
import { BUSY_SEC, agentsCached, eventRoot, runState, sig58, toSec } from "./data";

/// The agent's slice of its root's trades, from the coin's on-chain split when the page has it (a root
/// launched before the split rule, like $SPORE, gives its agent none), else the pinned rule.
function earnsLine(S: string, shares: Coin["shares"] | undefined, agent: string | null): string {
  const tail = `launches a coin under ${S} ${AGENT_CADENCE}, pays its AI bill and sends the surplus to ${AGENT_PAYOUT_TO}.`;
  const slice = shares && agent ? shares.find((s) => s.address === agent) ?? null : undefined;
  if (slice === null) return `It has no slice of ${S} trades: it lives on the 50% creator share of the coins it launches. It ${tail}`;
  const pct = !slice || slice.bps === ROOT_SPLIT.agent ? ROOT_PCT.agent : `${((slice.bps / 10_000) * PUMP_CREATOR_FEE_PCT).toFixed(2)}%`;
  return `Earns ${pct} of every ${S} trade in its own wallet, claims it, ${tail}`;
}

export default function CoinAgentCard({ coin }: { coin: Pick<Coin, "mint" | "symbol" | "depth" | "name"> & Partial<Pick<Coin, "shares">> }) {
  const data = useAgentCoin(coin);
  const now = useNow(15_000);
  const [latest, setLatest] = useState<{ mint: string; l: AgentLaunched | null; fresh: boolean } | null>(null);
  const [extra, setExtra] = useState<{ mint: string; launches: number; at: number | null }>({ mint: coin.mint, launches: 0, at: null });
  const isRoot = data?.role === "root";
  // The coin route carries no launch list; the shared agent list (already loaded for the page's agent chips) has the newest launch.
  useEffect(() => {
    if (!isRoot) return;
    let alive = true;
    agentsCached().then((l) => { if (alive) setLatest({ mint: coin.mint, l: l.agents.find((a) => a.root.mint === coin.mint)?.launched[0] ?? null, fresh: false }); }, () => { /* the card works without it */ });
    return () => { alive = false; };
  }, [isRoot, coin.mint]);
  // A launch by this root's agent, live: the latest row swaps in and the count moves (one event per mint).
  const seen = useRef(new Set<string>());
  useEvents({
    agent: (e) => {
      const l = e.proposal.launched;
      if (eventRoot(e) !== coin.mint || !l?.mint || seen.current.has(l.mint)) return;
      seen.current.add(l.mint);
      const p = e.proposal, at = toSec(p.createdAt) ?? Math.floor(Date.now() / 1000);
      setLatest({ mint: coin.mint, l: { mint: l.mint, name: p.name, symbol: p.symbol, image: p.image, createdAt: at, signature: sig58(l.signature), why: p.why ?? null, logoSource: p.logoSource ?? null }, fresh: true });
      setExtra((x) => ({ mint: coin.mint, launches: (x.mint === coin.mint ? x.launches : 0) + 1, at }));
    },
  }, coin.depth === 0);

  if (!data || !data.role || !data.root) return null;
  const a = data.agent;
  if (data.role === "root" && a) {
    const S = sym(coin);
    const add = extra.mint === coin.mint ? extra : { launches: 0, at: null };
    const totals = { ...a.totals, launches: a.totals.launches + add.launches, lastActivityAt: Math.max(toSec(a.totals.lastActivityAt) ?? 0, add.at ?? 0) || null };
    const l = latest?.mint === coin.mint ? latest : null;
    const lastAt = totals.lastActivityAt;
    return (
      <section className="card agent-coin" aria-label={`${S}'s agent`}>
        <div className="agent-coin-head">
          <AgentAvatar root={data.root} state={runState({ status: a.status, wallet: a.wallet, totals }).state} size={26} spin="hover" />
          <span className="agent-coin-title">This coin's agent</span>
          <StatusBadge agent={{ status: a.status, wallet: a.wallet, totals }} now={now} />
          {/* An idle badge already says how long ago; a busy one gets the exact last action. */}
          {lastAt && now - lastAt < BUSY_SEC ? <span className={`agent-coin-last mono ${now - lastAt < 60 ? "recent" : ""}`} title="Its newest claim, launch, payout or model call">last action {agoLabel(lastAt)}</span> : null}
        </div>
        <p className="agent-coin-line">{earnsLine(S, coin.shares, a.address ?? a.wallet?.address ?? null)}</p>
        <dl className="agent-coin-stats">
          <Mini label="Wallet" title={a.wallet ? `${a.wallet.sol ?? "—"} SOL · ${a.wallet.usdc ?? 0} USDC` : undefined}>{a.wallet?.usd != null ? <>≈ <LiveNumber value={a.wallet.usd} format={usd} /></> : "—"}</Mini>
          <Mini label="Launched"><LiveNumber value={totals.launches} format={count} kind="count" /></Mini>
          <Mini label="Claimed">{totals.claimsUsd ? <LiveNumber value={totals.claimsUsd} format={usd} /> : "none yet"}</Mini>
          <Mini label="AI spent">{totals.aiUsd ? usdSmall(totals.aiUsd) : "none yet"}</Mini>
          {totals.payoutsSol > 0 && <Mini label="Paid out">{`${totals.payoutsSol.toFixed(4)} SOL`}</Mini>}
        </dl>
        {l?.l && (
          <Link to={`/c/${l.l.mint}`} className={`agent-coin-latest ${l.fresh ? "is-new" : ""}`} key={l.l.mint}>
            <Logo src={l.l.image} label={l.l.symbol ?? l.l.name} size={44} className="agent-coin-logo" />
            <span className="agent-coin-latest-text">
              <span className="agent-coin-latest-name"><b>{l.l.name ?? l.l.symbol ?? short(l.l.mint)}</b>{l.l.symbol && <span className="mono">${l.l.symbol}</span>}<span className="mono muted">· {l.l.createdAt ? age(l.l.createdAt) : "—"}</span></span>
              <span className="agent-coin-why">{l.l.why ?? "its latest launch under this coin"}</span>
            </span>
          </Link>
        )}
        <div className="agent-coin-foot"><ModelChip model={a.model} /><Link to={`/agents/${coin.mint}`} className="more">Open the agent →</Link></div>
      </section>
    );
  }
  if (data.role === "child") {
    const root = data.root, l = data.launch;
    const at = toSec(l?.at);
    return (
      <section className="card agent-coin child" aria-label={`Launched by ${agentName(root)}`}>
        <div className="agent-coin-head">
          <span className="agent-coin-title">Launched by an agent</span>
          {a && <StatusBadge agent={{ status: a.status, wallet: a.wallet, totals: a.totals }} now={now} />}
        </div>
        <Link to={`/agents/${root.mint}`} className="agent-coin-root">
          <Logo src={root.image} label={root.symbol} size={40} className="agent-coin-logo" />
          <span className="agent-coin-latest-text">
            <b>Launched by {agentName(root)}</b>
            <span className="mono muted">{at ? agoLabel(at) : "on its own"}{logoSourceLabel(l?.logoSource) ? ` · ${logoSourceLabel(l?.logoSource)}` : ""}</span>
          </span>
        </Link>
        {l?.why && <blockquote className="agent-coin-quote"><span className="agent-label">Why</span>{l.why}</blockquote>}
        <details className="agent-coin-proof">
          <summary>On-chain proof</summary>
          <dl className="kv">
            <dt>Agent wallet</dt><dd>{a?.address ? <AddressRow address={a.address} label="Agent wallet address" /> : "—"}</dd>
            <dt>Launch tx</dt><dd>{l?.signature ? <a className="mono" href={solscanTx(l.signature)} target="_blank" rel="noreferrer" title={l.signature}>{short(l.signature, 6)} ↗</a> : <span className="muted">—</span>}</dd>
            <dt>Root</dt><dd><Link to={`/c/${root.mint}`}>{sym(root)}</Link></dd>
            {a?.model && <><dt>Model</dt><dd><ModelChip model={a.model} /></dd></>}
          </dl>
          <p className="hint">The agent named this coin, drew its logo and signed the launch from its own wallet. Its creator fees go creator 50% (the agent) · Spore 50%, paid in {sym(root)}.</p>
        </details>
        <Link to={`/agents/${root.mint}`} className="more">Open {agentName(root)} →</Link>
      </section>
    );
  }
  return null;
}
