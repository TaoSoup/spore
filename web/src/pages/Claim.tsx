// The Claim page (DESIGN §11.7): connect a wallet, see every coin whose fee-sharing config names it
// with what is waiting and its part, and claim one coin or all of them. Below, the Spore launches
// with the most fees waiting: a payout is permissionless, so anyone may trigger one (the signer pays
// the network fee, the program pays the shareholders, never the person who pressed the button).
// Numbers come from /api/claims; transactions are built and simulated in the browser and signed by
// the account wallet (useClaimFlow: the trading wallet when the user has one, else the connected
// extension). With both, the coins whose split names the connected wallet are listed under the
// trading wallet's own: the trading wallet runs their payouts and the part goes to the connected wallet.
// Both lists are refreshed together and counted together in "your part" and "Claim all".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { api, type ClaimCoin, type ClaimTotals } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { amount, bps, tokens, usd, usdCard } from "../lib/format";
import { CHILD_SPLIT_LINE, ROOT_SPLIT_LINE, SPORE_BUYBACK } from "../lib/copy";
import { termText } from "../lib/glossary";
import { feeRole } from "../lib/fee-roles";
import { agentProvenance, useAgentIndex, type AgentIndex } from "../lib/agent-index";
import { DepthBadge, Logo, SkeletonRows, nameOf, sym } from "../components/Bits";
import SporeCanvas from "../components/SporeCanvas";
import Term from "../components/Term";
import { useClaimFlow, type ClaimTarget } from "../components/claim/useClaimFlow";
import { ConnectArt, CountUp, MiniArc, ROLE_TONE } from "../components/claim/art";
import EmptySpore from "../components/illus/EmptySpore";
import { ROOT_SPLIT, SPLIT_BPS } from "../lib/policy";
import "../components/claim/claim.css";

const POLL_MS = 30_000;
const CACHE_MS = 16_000; // the API caches each coin for 15 s; refetch after a claim once it has turned over
const target = (c: ClaimCoin): ClaimTarget => ({ mint: c.mint, symbol: c.symbol, image: c.image, quoteSymbol: c.quoteSymbol, quoteDecimals: c.quoteDecimals, total: c.total, perShare: c.perShare, depth: c.depth });
const fmt = (c: { quoteDecimals: number; quoteSymbol: string }, raw: string) => amount(tokens(raw, c.quoteDecimals), c.quoteSymbol);
const AUTO_CLAIMED = "Its agent claims this coin on its own, so it can read 0 right after a payout. That money already went to the shareholders.";

/// "Your part" over both of the user's wallets: the sums per quote coin, and in dollars.
function addTotals(a: ClaimTotals | undefined, b: ClaimTotals | undefined): ClaimTotals | undefined {
  if (!a || !b) return a ?? b;
  const byQuote = a.byQuote.map((q) => ({ ...q }));
  for (const q of b.byQuote) {
    const hit = byQuote.find((x) => x.quoteMint === q.quoteMint);
    if (hit) { hit.amount = (BigInt(hit.amount) + BigInt(q.amount)).toString(); hit.usd += q.usd; } else byQuote.push({ ...q });
  }
  return { usd: a.usd + b.usd, byQuote };
}

/// A plain error card: no raw server text outside the details toggle.
function LoadError({ error, retry, what }: { error: string; retry: () => void; what: string }) {
  return (
    <div className="claim-error" role="alert">
      <span><b>Could not load {what}.</b> Spore's API did not answer; your fees are safe on-chain.</span>
      <button type="button" className="btn sm ghost" onClick={retry}>Retry</button>
      <details><summary>details</summary><span className="mono">{error.replace(/https?:\/\/\S+/g, "…")}</span></details>
    </div>
  );
}

export default function Claim() {
  useEffect(() => { document.title = "Claim fees · Spore"; return () => { document.title = "Spore"; }; }, []);
  const pub = useAsync(() => api.claims(50), []);
  // Latest reloaders, read when a claim lands (the flow hook is created before the wallet-keyed fetch).
  const reloadRef = useRef<{ mine: () => void; pub: () => void }>({ mine: () => {}, pub: () => {} });
  reloadRef.current.pub = pub.reload;
  const onClaimed = useCallback(() => { const r = () => { reloadRef.current.mine(); reloadRef.current.pub(); }; r(); setTimeout(r, CACHE_MS); }, []);
  const flow = useClaimFlow(onClaimed);
  const index = useAgentIndex();
  const mine = useAsync(() => (flow.me ? api.claimsFor(flow.me) : Promise.resolve(null)), [flow.me]);
  // The connected wallet beside a trading wallet: the coins it launched still pay it.
  const mine2 = useAsync(() => (flow.also ? api.claimsFor(flow.also) : Promise.resolve(null)), [flow.also]);
  reloadRef.current.mine = () => { mine.reload(); if (flow.also) mine2.reload(); };
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden && !flow.busy) { mine.reload(); if (flow.also) mine2.reload(); pub.reload(); } }, POLL_MS);
    return () => clearInterval(t);
  }, [mine.reload, mine2.reload, pub.reload, flow.busy, flow.also]);

  // Phones get one sticky connect bar, shown once the "Your coins" connect button scrolled away.
  const connectBox = useRef<HTMLDivElement>(null);
  const [connectInView, setConnectInView] = useState(true);
  useEffect(() => {
    const el = connectBox.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setConnectInView(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [flow.me]);

  const rows = mine.data?.coins ?? [];
  // The connected wallet's coins, without those already listed for the trading wallet (a split that names both).
  const rows2 = useMemo(() => { const seen = new Set(rows.map((c) => c.mint)); return (flow.also ? mine2.data?.coins ?? [] : []).filter((c) => !seen.has(c.mint)); }, [rows, mine2.data, flow.also]);
  const claimable = useMemo(() => [...rows, ...rows2].filter((c) => c.claimable), [rows, rows2]);
  const totals = addTotals(mine.data?.totals, flow.also ? mine2.data?.totals : undefined);
  // the second list is still being read for the first time, or could not be read: the page must not say "nothing"
  const waiting2 = !!flow.also && !mine2.data && mine2.loading;
  const failed2 = !!flow.also && !mine2.data && !!mine2.error;

  return (
    <>
      <SporeCanvas density={0.4} />
      <div className={`container claim-page claim-v2 ${flow.me ? "" : "no-wallet"}`}>
        <div className="page-head">
          <span className="eyebrow">Claim</span>
          <h1>Claim <em>fees</em></h1>
          <p className="lead">Creator fees wait in pump.fun vaults until someone <Term k="claim">pays them out</Term>. Connect the wallet that launched a coin to see what it earned.</p>
          <ul className="claim-facts" aria-label="How creator fees split">
            <li><MiniArc size={30} parts={[{ v: ROOT_SPLIT.creator, tone: "lime" }, { v: ROOT_SPLIT.platform, tone: "ink" }, { v: ROOT_SPLIT.agent, tone: "agent" }]} /><span className="claim-fact-k">new tree</span><span className="mono">{ROOT_SPLIT_LINE}</span></li>
            <li><MiniArc size={30} parts={[{ v: SPLIT_BPS[0], tone: "lime" }, { v: SPLIT_BPS[3], tone: "ink" }]} /><span className="claim-fact-k">coin under a parent</span><span className="mono">{CHILD_SPLIT_LINE}</span></li>
            <li className="claim-fact-note">{SPORE_BUYBACK}</li>
          </ul>
        </div>

        <section className="card pad claim-card mine" aria-busy={mine.loading} aria-labelledby="claim-mine-h">
          <div className="claim-head">
            <i className="numeral claim-n" aria-hidden="true">01</i>
            <div>
              <h2 id="claim-mine-h" className="claim-h">Your coins</h2>
              <p className="muted claim-sub">{flow.me ? <>{flow.dry ? "dry run as " : flow.silent ? (flow.locked ? "trading wallet, locked " : "trading wallet ") : "wallet "}<span className="mono">{flow.me.slice(0, 4)}…{flow.me.slice(-4)}</span> · every coin whose fee split names it</> : "Every coin whose fee split names your wallet, across Spore."}</p>
            </div>
            {totals && rows.length + rows2.length > 0 && (
              <div className="claim-totals">
                <div><em>your part</em><CountUp value={totals.usd} format={usdCard} className={totals.usd > 0 ? "accent" : "zero"} /></div>
                <div className="claim-quotes">{totals.byQuote.filter((q) => BigInt(q.amount) > 0n).map((q) => <span key={q.quoteMint ?? "SOL"} className="mono">{amount(tokens(q.amount, q.quoteDecimals), q.quoteSymbol)}</span>)}</div>
                <button type="button" className="btn accent" disabled={flow.bulk ? flow.bulk.stopping : flow.busy || claimable.length === 0} title={flow.bulk ? "Stops after the coin in flight; coins already paid out stay paid" : undefined}
                  onClick={() => (flow.bulk ? flow.stop() : flow.claimAll(claimable.map(target), totals.usd))}>
                  {flow.bulk ? (flow.bulk.stopping ? "Stopping…" : `Stop · claiming ${flow.bulk.i + 1} of ${flow.bulk.n}`) : flow.locked ? `Unlock to claim (${claimable.length})` : `Claim all (${claimable.length})`}
                </button>
              </div>
            )}
          </div>

          {!flow.me ? (
            <div className="claim-connect" ref={connectBox}>
              <div className="claim-connect-art" aria-hidden="true"><ConnectArt /></div>
              <p className="muted">Connect the wallet you launched with. Nothing is sent until you approve a payout in it.</p>
              <WalletMultiButton>Connect wallet</WalletMultiButton>
            </div>
          ) : mine.loading && !mine.data ? <SkeletonRows n={3} h={64} />
            : mine.error && !mine.data ? <LoadError error={mine.error} retry={mine.reload} what="your coins" />
            : rows.length === 0 && waiting2 ? <SkeletonRows n={3} h={64} />
            : rows.length === 0 && failed2 ? <LoadError error={mine2.error!} retry={mine2.reload} what="the coins of your connected wallet" />
            : rows.length === 0 && rows2.length === 0 ? (
              <div className="claim-empty">
                <EmptySpore className="claim-empty-art" />
                <b>No fees waiting for this wallet yet.</b>
                <p className="muted">Launch a coin on Spore and this wallet earns from every trade: 0.25% of a root's trades, or 50% of a child's creator fee.</p>
                <Link to="/launch" className="btn accent">Launch a coin</Link>
              </div>
            ) : (
              <>
                {rows.length > 0 && <ClaimTable rows={rows} mine flow={flow} index={index} />}
                {flow.also && rows2.length > 0 && (
                  <>
                    <p className="muted claim-sub">Launched with your connected wallet <span className="mono">{flow.also.slice(0, 4)}…{flow.also.slice(-4)}</span>: your trading wallet runs the payout, and your part goes to that wallet.</p>
                    <ClaimTable rows={rows2} mine me={flow.also} flow={flow} index={index} />
                  </>
                )}
                {failed2 && <LoadError error={mine2.error!} retry={mine2.reload} what="the coins of your connected wallet" />}
              </>
            )}
        </section>

        <section className="card pad claim-card public" aria-labelledby="claim-pub-h">
          <div className="claim-head">
            <i className="numeral claim-n" aria-hidden="true">02</i>
            <div>
              <h2 id="claim-pub-h" className="claim-h">Fees waiting across Spore</h2>
              <p className="muted claim-sub">Anyone can trigger a payout. The money goes to the shareholders, never to whoever presses the button.</p>
            </div>
            {pub.data && pub.data.coins.length > 0 && <div className="claim-totals"><div><em>waiting</em><CountUp value={pub.data.totals.usd} format={usdCard} className={pub.data.totals.usd > 0 ? "" : "zero"} /></div></div>}
          </div>
          {pub.loading && !pub.data ? <SkeletonRows n={4} h={64} />
            : pub.error && !pub.data ? <LoadError error={pub.error} retry={pub.reload} what="the fees waiting" />
            : !pub.data?.coins.length ? <div className="claim-empty"><EmptySpore className="claim-empty-art" /><b>Nothing waiting right now.</b><p className="muted">Every payout went out. Fees build up again with every trade of a Spore coin.</p></div>
            : <ClaimTable rows={pub.data.coins} flow={flow} index={index} />}
        </section>
      </div>
      {flow.dialog}
      {!flow.me && !connectInView && (
        <div className="claim-connect-bar" role="region" aria-label="Connect wallet">
          <span>Pay out or claim with your wallet</span>
          <WalletMultiButton>Connect wallet to claim</WalletMultiButton>
        </div>
      )}
    </>
  );
}

function ClaimTable({ rows, mine = false, flow, index, me = flow.me }: { rows: ClaimCoin[]; mine?: boolean; flow: ReturnType<typeof useClaimFlow>; index: AgentIndex; me?: string | null }) {
  return (
    <div className={`claim-table ${mine ? "mine" : "public"}`} role="table" aria-label={mine ? "Your coins with creator fees" : "Coins with fees waiting"}>
      <div className="claim-row claim-th" role="row">
        <span role="columnheader">Coin</span>
        {mine ? <span role="columnheader">Your share</span> : <span role="columnheader">Goes to</span>}
        <span role="columnheader">Waiting</span>
        {mine && <span role="columnheader">Your part</span>}
        <span role="columnheader"><span className="sr-only">Action</span></span>
      </div>
      {rows.map((c) => {
        const busyLabel = flow.labelFor(c.mint);
        const zero = BigInt(c.total) === 0n;
        const prov = agentProvenance({ mint: c.mint, depth: c.depth, shares: c.shares }, index);
        const ctx = { me, agent: prov?.agent.wallet ?? null, agentRole: prov?.role ?? null, agentOf: prov ? sym(prov.agent.root) : null, inferCreator: true };
        const shares = c.perShare.length ? c.perShare : (c.shares ?? []).map((s) => ({ ...s, amount: "0" }));
        const roles = shares.map((s) => ({ s, r: feeRole(s.address, ctx) }));
        const autoClaimed = c.depth === 0 && !!index.byRoot.get(c.mint);
        return (
          <div key={c.mint} className={`claim-row ${zero ? "dim" : ""}`} role="row">
            <span role="cell" className="claim-coin-cell">
              <Link to={`/c/${c.mint}`} className="claim-coin">
                <Logo src={c.image} label={c.symbol} size={36} className="ring" />
                <span><b>{nameOf(c)}</b><small className="mono">{sym(c)}</small></span>
              </Link>
              <DepthBadge depth={c.depth} />
            </span>
            {mine ? <span role="cell" className="mono claim-share-cell" data-label="Your share"><MiniArc parts={[{ v: c.yourBps ?? 0, tone: "lime" }, { v: 10_000 - (c.yourBps ?? 0), tone: "ink" }]} /><span>{bps(c.yourBps ?? 0)}<small>of the fee</small></span></span>
              : (
                <span role="cell" className="claim-to" data-label="Goes to">
                  <MiniArc parts={roles.map(({ s, r }) => ({ v: s.bps, tone: ROLE_TONE[r.tone] }))} />
                  <span className="claim-recipients">{roles.map(({ s, r }, i) => <span key={s.address} className={`rcp ${r.tone}`}>{i > 0 && <span className="sep" aria-hidden="true"> · </span>}{r.label} {bps(s.bps)}</span>)}</span>
                  {autoClaimed && <span className="chip agent auto-claimed"><Term k="agent" text={AUTO_CLAIMED}>auto-claimed</Term></span>}
                </span>
              )}
            <span role="cell" data-label="Waiting"><b className={`mono ${zero ? "zero" : ""}`}>{fmt(c, c.total)}</b>{c.totalUsd != null && !zero && <small>{usd(c.totalUsd)}</small>}</span>
            {mine && <span role="cell" data-label="Your part"><b className={`mono ${zero ? "zero" : "accent"}`}>{fmt(c, c.yourAmount ?? "0")}</b>{c.yourUsd != null && !zero && <small>{usd(c.yourUsd)}</small>}</span>}
            <span role="cell" className="claim-act">
              {!flow.me ? <span className="muted claim-why need-wallet">connect a wallet</span>
                : !c.claimable ? <span className="muted claim-why" title={c.reason ?? undefined}>{zero ? "nothing yet" : "below minimum"}</span>
                : mine ? <button type="button" className="btn accent sm" disabled={flow.busy} title={flow.locked ? "Your trading wallet signs the payout: unlock it first" : undefined} onClick={() => flow.start(target(c))}>{busyLabel ?? (flow.locked ? "Unlock to claim" : "Claim")}</button>
                : <button type="button" className="btn ghost sm" disabled={flow.busy} title={flow.locked ? "Your trading wallet signs the payout: unlock it first" : termText("payout")} onClick={() => flow.start(target(c))}>{busyLabel ?? (flow.locked ? "Unlock to pay out" : "Pay out")}</button>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
