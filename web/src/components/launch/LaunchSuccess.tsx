// After the launch: the coin's identity card (image, name, ticker, tree, link), one plain line of
// what was spent and which split is locked, a root's agent introduced and followed until it is
// live, a short "Next" list (share, grow, claim), and, when the fee split did not land, the single
// button that finishes it without a new mint or a re-upload. A live indexer line closes it.
import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { api, pumpUrl, solscanTx, xShareUrl, type Coin } from "../../lib/api";
import type { SpawnResult } from "../../lib/flow";
import { friendlyError, type Step } from "../../lib/steps";
import { AGENT_MODELS } from "../../lib/policy";
import { AGENT_CADENCE_MIN, AGENT_SEED_SOL, CHILD_PCT, CHILD_SPLIT_YOU, ROOT_PCT, ROOT_SPLIT_YOU } from "../../lib/copy";
import { amount, tokens } from "../../lib/format";
import { copyText } from "../../lib/hooks";
import { launchShareText } from "../../lib/map/share";
import Steps from "../Steps";
import { Addr, Ext, useTint } from "../Bits";
import Certificate, { type CertSegment } from "./Certificate";

/// `segments`: the split as the launch form showed it (role, bps); `parentImage`: the parent's logo for the certificate.
type Props = { r: SpawnResult; maxDepth?: number; onFinishSplit: () => void; splitBusy: boolean; splitSteps: Step[]; splitError: string | null; segments?: CertSegment[]; parentImage?: string | null };

/// Polls /api/coin/:mint until the indexer lists it (the CreateEvent arrives over the live
/// subscription within seconds; the fee split verification follows). Stops after ~3 minutes.
function useIndexed(mint: string, enabled: boolean) {
  const [coin, setCoin] = useState<Coin | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!enabled || coin) return;
    let alive = true;
    let n = 0;
    const tick = () => api.coin(mint).then((r) => { if (alive) setCoin(r.coin); }).catch(() => { if (alive) setTries(++n); });
    tick();
    const t = setInterval(() => { if (n >= 60) clearInterval(t); else tick(); }, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [mint, enabled, coin]);
  return { coin, gaveUp: tries >= 60 };
}

/// A root's agent wakes once Spore binds its wallet to the mint (the launch report, or the chain
/// reconciler): /api/agents/coin/:mint answers role "root" from then on. Every 5 s for 2 minutes.
function useAgentAwake(mint: string, enabled: boolean): "connecting" | "live" | "timeout" {
  const [state, setState] = useState<"connecting" | "live" | "timeout">("connecting");
  useEffect(() => {
    if (!enabled) return;
    let alive = true, n = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      n++;
      try { const a = await api.agentCoin(mint); if (!alive) return; if (a?.role === "root" && a.agent) { setState("live"); return; } }
      catch { /* not bound yet, or the API is busy: keep asking */ }
      if (!alive) return;
      if (n >= 24) { setState("timeout"); return; }
      timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [mint, enabled]);
  return state;
}

export default function LaunchSuccess({ r, maxDepth, onFinishSplit, splitBusy, splitSteps, splitError, segments = [], parentImage = null }: Props) {
  const url = `${window.location.origin}/c/${r.mint}`;
  const tag = `$${r.symbol}`;
  const pool = r.parent ? `$${r.parent.symbol ?? r.parent.mint.slice(0, 4)}` : "SOL";
  const root = !r.parent;
  const agent = r.agent ?? r.pending.agent ?? null;
  const modelLabel = agent ? AGENT_MODELS.find((m) => m.id === agent.model)?.label ?? agent.model : null;
  const text = launchShareText(r.symbol, r.parent);
  const { coin, gaveUp } = useIndexed(r.mint, !r.dry);
  const awake = useAgentAwake(r.mint, root && !!agent && !r.dry && r.split.done);
  const [copied, setCopied] = useState<"mint" | "link" | null>(null);
  const copy = (what: "mint" | "link", value: string) => { void copyText(value).then((ok) => { if (!ok) return; setCopied(what); setTimeout(() => setCopied(null), 1600); }); };
  const [tint, onImg] = useTint(r.image, r.symbol || r.mint);
  const canGrow = r.depth < (maxDepth ?? 2);
  const listed = !!coin?.ours;
  const spent = r.spent !== null ? `${(Number(r.spent) / 1e9).toFixed(4)} SOL spent` : "rent and fees spent";
  const splitLine = root ? ROOT_SPLIT_YOU : CHILD_SPLIT_YOU;
  return (
    <div className={`success v2 ${r.split.done ? "" : "split-pending"}`} data-mint={r.mint} data-dry={r.dry ? "1" : "0"} style={{ "--tint": tint } as CSSProperties}>
      <div className="success-head">
        <i aria-hidden="true">{r.split.done ? <svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg> : "!"}</i>
        <div>
          <b>{tag} is live{r.parent ? ` under ${pool}, at depth ${r.depth}` : ", priced in SOL"}{r.dry ? " · dry run" : ""}.</b>
          <span className="success-line">{r.dry
            ? <>Dry run: every transaction was simulated on mainnet state; nothing was sent or charged. The split it would lock: {splitLine}.</>
            : r.split.done ? <>One transaction · {spent} · fees locked: {splitLine}.</>
            : <>One transaction · {spent}. The coin exists; its fee split still needs one signature (below).</>}</span>
        </div>
      </div>

      {/* The issued certificate (a one-shot spore burst out of the new node), then its link to share. */}
      <div className="success-cert">
        <Certificate state="issued" image={r.image} onImg={onImg} name={r.name} symbol={r.symbol} parent={r.parent ? { symbol: r.parent.symbol ?? null, mint: r.parent.mint, image: parentImage } : null}
          depth={r.depth} segments={segments} splitLine={splitLine} model={root ? modelLabel : null} mint={r.mint} dry={r.dry} splitPending={!r.split.done} burst={r.split.done} />
      </div>
      <div className="share-card v3">
        <div className="share-body">
          <span className="label">Your coin page</span>
          <span className="share-link mono">{url.replace(/^https?:\/\//, "")}</span>
        </div>
        <div className="share-side">
          <button type="button" className="btn sm ghost" onClick={() => copy("link", url)}>{copied === "link" ? "Copied" : "Copy link"}</button>
          <button type="button" className="btn sm ghost" onClick={() => copy("mint", r.mint)}>{copied === "mint" ? "Copied" : "Copy mint"}</button>
        </div>
      </div>

      {!r.split.done && (
        <div className="notice warn split-notice" role="alert">
          <div>
            <b>The fee split did not land.</b> {tag} exists on-chain, but its split is not locked yet, so Spore does not list it{root ? ", its agent earns nothing," : ""} and every creator fee currently stays with you. One more signature fixes it; no new mint, no re-upload.
            {r.split.error && <span className="hint"> Reason: {friendlyError(new Error(r.split.error))}</span>}
            {splitSteps.length > 0 && <Steps steps={splitSteps} />}
            {splitError && <span className="field-error">{splitError}</span>}
          </div>
          <button type="button" className="btn accent" disabled={splitBusy} onClick={onFinishSplit}>{splitBusy ? "Working…" : "Finish the fee split"}</button>
        </div>
      )}

      {r.buy && <div className="notice good">First buy landed: {amount(tokens(r.buy.amountOut, 6), tag)} · <Ext href={solscanTx(r.buy.sig)}>transaction ↗</Ext></div>}
      {r.buyError && <div className="notice warn">The launch landed but the first buy did not: {friendlyError(new Error(r.buyError))} You can buy from the coin page.</div>}

      {root && agent && (
        <section className={`agent-awake ${r.dry ? "dry" : awake}`} aria-label="Your agent">
          <div className="agent-awake-head">
            <span className="agent-badge" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="8" cy="4" r="2" /><circle cx="4" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><path d="M7 5.7 5 10.3M9 5.7l2 4.6" /></svg></span>
            <b>Your agent is awake</b>
            {modelLabel && <span className="chip agent">{modelLabel}</span>}
          </div>
          <div className="agent-awake-facts">
            <span>wallet <Addr a={agent.address} n={4} /></span>
            <span>Started with {AGENT_SEED_SOL} SOL</span>
          </div>
          <p className="agent-awake-status" aria-live="polite">
            <i aria-hidden="true" />
            <span>{r.dry ? <>Dry run: a wallet was prepared, but nothing launched, so no agent started.</>
              : !r.split.done ? <>Your agent earns nothing until the fee split is locked.</>
              : awake === "live" ? <>Live · first child within ~{AGENT_CADENCE_MIN} minutes · <Link to={`/agents/${r.mint}`}>Watch your agent →</Link></>
              : awake === "timeout" ? <>Your agent page appears once Spore confirms the launch.</>
              : <>Connecting to your coin…</>}</span>
          </p>
        </section>
      )}

      <div className="next">
        <span className="eyebrow">Next</span>
        <ol className="next-list">
          <li><span className="next-n mono">1</span><Ext href={xShareUrl(text, url)}>Share on X ↗</Ext><small>the post links your coin page</small></li>
          {canGrow && <li><span className="next-n mono">2</span><Link to={`/launch?parent=${r.mint}`}>Grow it: launch a coin under {tag}</Link><small>every buy of it buys {tag}</small></li>}
          <li><span className="next-n mono">{canGrow ? 3 : 2}</span><Link to="/claim">Fees collect at Claim: this wallet earns {root ? `${ROOT_PCT.creator} of every trade` : `${CHILD_PCT.creator} of the creator fee`}</Link></li>
        </ol>
      </div>

      <div className="success-actions">
        <Link to={`/c/${r.mint}`} className={`btn ${r.split.done ? "accent" : "ghost"}`}>View {tag}</Link>
        <Ext href={pumpUrl(r.mint)} className="btn ghost">pump.fun ↗</Ext>
        {!r.dry && r.sig && <Ext href={solscanTx(r.sig)} className="btn ghost">Transaction ↗</Ext>}
      </div>

      <p className={`indexer ${listed ? "ok" : coin ? "seen" : ""}`} aria-live="polite">
        {r.dry ? <>Dry run: the indexer is not polled because nothing was created.</>
          : listed ? <><i /> Listed on Spore{coin?.oursPending ? " · verifying the fee split" : ""}. The coin page is ready.</>
          : coin ? <><i /> The indexer sees {tag}{r.split.done ? " and is verifying the fee split…" : "; it will be listed once the fee split is locked."}</>
          : gaveUp ? <><i /> Still waiting for the indexer. The coin exists on-chain; open the coin page and it will fill in.</>
          : <><i className="spin" /> Waiting for the indexer to pick {tag} up…</>}
      </p>
    </div>
  );
}
