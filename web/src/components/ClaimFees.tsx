// The "Creator fees" card of a coin page (DESIGN §11.6): what the coin's fee-sharing config holds
// right now, who each shareholder is (lib/fee-roles: you, creator, Spore, the root's agent), each
// one's cut, and a Claim button that pays everyone out. The payout is permissionless on-chain, so
// any connected wallet may trigger it; the signature costs the network fee (plus rent for a
// shareholder's missing token account on a token-quoted coin). Built in the browser, simulated
// before the wallet opens, signed by the wallet; the server only reports numbers.
import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { api, solscanTx, type Coin, type Fees } from "../lib/api";
import { buildClaimTx, parseClaimLogs, preflight, sendAndConfirm, type ClaimPayout } from "../lib/pump";
import { friendlyError } from "../lib/steps";
import { DRY_FUNDED, drySend, isDry } from "../lib/dry";
import { useAsync } from "../lib/hooks";
import { useDialog } from "../lib/dialog";
import { useAgentCoin } from "../lib/agent-index";
import { useTradePulse } from "../lib/live-trades";
import { feeRole, feeRoleNote, type FeeRoleTone } from "../lib/fee-roles";
import { CHILD_SPLIT_LINE, OFFICIAL_CA, ROOT_SPLIT_LINE } from "../lib/copy";
import { PLATFORM_WALLET, ROOT_SPLIT } from "../lib/policy";
import { ago, amount, bps, feeSol, tokens, usd } from "../lib/format";
import { Addr, Chip, ErrorBox, Logo, Skeleton, sym } from "./Bits";
import Term from "./Term";
import { useToast } from "./Toast";
import { FeeArc } from "./coin/viz";
import type { Tone } from "./illus/base";
import "./coin/terminal.css";

type Phase =
  | { kind: "idle" }
  | { kind: "building" }
  | { kind: "confirm"; tx: VersionedTransaction; spent: bigint | null; units: number; payout: ClaimPayout | null }
  | { kind: "sending"; sig: string | null };

/// The API caches each coin's figures for 15 s; a claim empties the vault on-chain at once, so the
/// card refetches now (whatever the cache has) and again once the cache has certainly turned over.
const CACHE_MS = 16_000;
/// Fees only grow with trades: refetch on the trade stream, at most every 20 s, with a slow poll as
/// the fallback when the stream is down.
const TRADE_REFETCH_MS = 20_000;
const POLL_MS = 90_000;
const TONE_VAR: Record<FeeRoleTone, string> = { you: "var(--accent)", creator: "var(--split-creator)", spore: "var(--split-spore)", agent: "var(--split-agent)", other: "var(--split-other)" };
/// The same roles in the illustration kit's tones, for the fee arc.
const ARC_TONE: Record<FeeRoleTone, Tone> = { you: "lime", creator: "lime", spore: "ink", agent: "agent", other: "violet" };

function ClaimFees({ coin }: { coin: Coin }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  // Dev dry mode (`?dry=1`, development builds only): the claim is simulated instead of signed,
  // from the funded probe wallet or `?as=<pubkey>` so a shareholder's "you" row can be reviewed.
  const dry = isDry();
  const me = dry ? (new URLSearchParams(window.location.search).get("as") || DRY_FUNDED) : (wallet.publicKey?.toBase58() ?? null);
  const fees = useAsync(() => api.fees(coin.mint), [coin.mint]);
  const agentCoin = useAgentCoin(coin);
  const pulse = useTradePulse(coin.mint);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [lastSig, setLastSig] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const busy = phase.kind !== "idle";
  const confirmOpen = phase.kind === "confirm";
  // The claim button is disabled while the claim simulates, so focus is restored to it explicitly.
  const claimBtn = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialog<HTMLDivElement>(confirmOpen, () => setPhase({ kind: "idle" }), { returnFocus: claimBtn });

  // Refetch while trades arrive (≤ every 20 s, trailing so the last trade of a burst is counted),
  // never under a claim in progress or in a background tab.
  const lastFetch = useRef(Date.now());
  useEffect(() => { if (fees.data) lastFetch.current = Date.now(); }, [fees.data]);
  useEffect(() => {
    if (!pulse || busy) return;
    const wait = Math.max(0, TRADE_REFETCH_MS - (Date.now() - lastFetch.current));
    const t = setTimeout(() => { if (!document.hidden) { lastFetch.current = Date.now(); fees.reload(); } }, wait);
    return () => clearTimeout(t);
  }, [pulse, busy, fees.reload]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden && !busy && Date.now() - lastFetch.current > POLL_MS / 2) fees.reload(); }, POLL_MS);
    return () => clearInterval(t);
  }, [fees.reload, busy]);

  const f = fees.data;
  const dec = f?.quoteDecimals ?? (coin.quoteMint === null ? 9 : 6);
  const unit = f?.quoteSymbol ?? coin.quoteSymbol;
  const fmt = (raw: string | bigint) => amount(tokens(raw, dec), unit);
  const agentRoot = agentCoin?.root ?? (coin.depth === 0 ? coin : coin.root);
  const role = (addr: string) => feeRole(addr, { me, agent: agentCoin?.agent?.address ?? null, agentOf: agentRoot ? sym(agentRoot) : null, agentRole: agentCoin?.role ?? null, inferCreator: !!coin.ours });

  // Why there is nothing to press, in plain words. The API's own reason wins when it has one.
  const noSplit = !!f && (coin.holderReward || !f.shares?.length);
  const total = f ? tokens(f.total, dec) : 0;
  const rows = f ? (f.perShare.length ? f.perShare : (f.shares ?? []).map((s) => ({ ...s, amount: "0" }))) : [];
  const mine = !!me && rows.some((r) => r.address === me);
  // The policy sentence only where the on-chain config has the policy's shape (a root: the agent's
  // slice; a child: Spore in a two-way split). Older or hand-made configs show their rows only.
  const platform = PLATFORM_WALLET.toBase58();
  const shaped = coin.depth === 0 ? rows.some((r) => r.bps === ROOT_SPLIT.agent) : rows.length === 2 && rows.some((r) => r.address === platform);
  const policy = (coin.ours || coin.oursPending) && shaped ? (coin.depth === 0 ? `Root split: ${ROOT_SPLIT_LINE}, written on-chain at launch.` : `Child split: ${CHILD_SPLIT_LINE}.`) : null;

  const start = async () => {
    if (!me || !f) return;
    setPhase({ kind: "building" });
    try {
      const payer = new PublicKey(me);
      const tx = await buildClaimTx(connection, payer, new PublicKey(coin.mint));
      const pf = await preflight(connection, tx, payer);
      if (!alive.current) return;
      setPhase({ kind: "confirm", tx, spent: pf.spent, units: pf.unitsConsumed, payout: parseClaimLogs(pf.logs) });
    } catch (e) {
      toast.error(friendlyError(e));
      if (alive.current) setPhase({ kind: "idle" });
    }
  };
  const confirm = async () => {
    if (phase.kind !== "confirm") return;
    const { tx, payout } = phase;
    setPhase({ kind: "sending", sig: null });
    try {
      const sig = dry ? await drySend(connection, tx, "claim") : await sendAndConfirm(connection, wallet, tx, [], (s) => { if (alive.current) setPhase({ kind: "sending", sig: s }); });
      const paid = payout ? `${fmt(payout.distributed)} to ${payout.shares.length} wallet${payout.shares.length === 1 ? "" : "s"}` : "the pending fees";
      toast.success(dry ? `Dry run: the claim passes (${paid})` : `Claimed ${paid}`, dry ? undefined : { href: solscanTx(sig), label: "view transaction" });
      if (!alive.current) return;
      setLastSig(dry ? null : sig);
      fees.reload();
      setTimeout(() => { if (alive.current) fees.reload(); }, CACHE_MS);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      if (alive.current) setPhase({ kind: "idle" });
    }
  };

  const working = phase.kind === "building" ? "Simulating…" : phase.kind === "sending" ? (phase.sig ? "Confirming…" : "Waiting for your wallet…") : null;
  const zero = !!f && !noSplit && total <= 0;

  return (
    <section className={`card fees ${zero || noSplit ? "is-quiet" : ""}`} aria-busy={fees.loading} aria-labelledby="fees-title">
      <div className="fees-head">
        <h2 id="fees-title" className="card-label"><Term k="creatorFee">Creator fees</Term></h2>
        {f && f.claimable && <Chip tone="accent" title="Pending fees can be paid out now">to claim</Chip>}
        {f && !f.claimable && !noSplit && total > 0 && <Chip tone="warn" title={f.reason ?? undefined}>below minimum</Chip>}
        <button type="button" className="fees-refresh" onClick={fees.reload} disabled={fees.loading || busy} aria-label="Refresh fees" title="Refresh">↻</button>
      </div>

      {fees.loading && !f && <div className="stack-2"><Skeleton w="55%" h={26} /><Skeleton h={8} r={999} /><Skeleton h={14} /><Skeleton h={14} /></div>}
      {fees.error && !f && <ErrorBox compact error={fees.error} retry={fees.reload} />}

      {f && noSplit && (
        <p className="fees-quiet">{coin.holderReward ? (f.reason ?? "Creator fees of this coin go to its holders, so there is no fee split to claim through.") : (f.reason ?? "No fee-sharing config: creator fees stay with the creator's wallet, so there is nothing to claim here.")}</p>
      )}

      {f && !noSplit && (
        <>
          <div className={`fees-body ${zero ? "zero" : ""}`}>
          <FeeArc
            parts={rows.map((r) => ({ key: r.address, v: r.bps, tone: ARC_TONE[role(r.address).tone], label: role(r.address).label }))}
            center={zero ? <span className="zero">0</span> : amount(total)}
            dense={!zero && amount(total).length > 6}
            sub={zero ? `${unit} · nothing pending` : f.totalUsd != null ? <>{unit} · ≈ {usd(f.totalUsd)}</> : `${unit} pending`}
            label={`${zero ? "Nothing pending" : `${fmt(f.total)} pending`}. Split: ${rows.map((r) => `${role(r.address).label} ${bps(r.bps)}`).join(", ")}`} />
          <div className="fees-side">
          {zero ? <p className="fees-quiet">No fees pending — every trade adds to this.</p> : (
            <div className="fees-total">
              <span className="fees-unit">recipients · paid in {unit}</span>
            </div>
          )}
          {zero ? (
            // Nothing pending: one line of who gets what, so the empty card stays short.
            <ul className="fees-legend" aria-label="Who receives the creator fees">
              {rows.map((s) => { const r = role(s.address); return <li key={s.address} className={`tone-${r.tone}`} title={s.address}><i className="dot" style={{ background: TONE_VAR[r.tone] }} aria-hidden="true" />{r.label} <b className="mono">{bps(s.bps)}</b></li>; })}
            </ul>
          ) : (
          <ul className="fees-rows" aria-label="Who receives the creator fees">
            {rows.map((s) => {
              const r = role(s.address);
              const note = feeRoleNote(r.tone);
              const label = r.tone === "spore" ? <Link to={`/c/${OFFICIAL_CA}`}>{r.label}</Link>
                : r.tone === "agent" && agentRoot ? <Link to={`/agents/${agentRoot.mint}`}>{r.label}</Link>
                : r.label;
              return (
                <li key={s.address} className={`tone-${r.tone}`}>
                  <i className="dot" style={{ background: TONE_VAR[r.tone] }} aria-hidden="true" />
                  <span className="fees-who">
                    <span className="split-role">{label}</span>
                    <span className="fees-sub"><Addr a={s.address} n={4} />{note && <> · {note}</>}</span>
                  </span>
                  <b className="mono fees-amt">{fmt(s.amount)}<small>{bps(s.bps)}</small></b>
                </li>
              );
            })}
          </ul>
          )}
          </div>
          </div>
          {policy && !zero && <p className="fees-policy">{policy}</p>}
          {!zero && (
            <details className="fees-where">
              <summary>Where the fees sit</summary>
              <div className="fees-parts">
                <span><i>curve</i> {fmt(f.bucket)}</span><span><i>vault</i> {fmt(f.vault)}</span>{f.migrated && <span><i>pool</i> {fmt(f.amm)}</span>}
              </div>
            </details>
          )}

          {f.claimable && (
            !me ? <div className="fees-connect"><WalletMultiButton>Connect wallet to claim</WalletMultiButton></div>
            : <button ref={claimBtn} type="button" className={`btn block ${mine ? "accent" : "soft"}`} disabled={busy} onClick={start}>{working ?? (mine ? `Claim ${fmt(f.total)}` : `Pay out ${fmt(f.total)}`)}</button>
          )}
          {f.claimable && <p className="hint">Anyone may <Term k="claim">claim</Term>: the signature pays the network fee{f.quoteMint ? " (and rent for a shareholder's missing token account)" : ""}, and the program pays the wallets above in these proportions.</p>}
          {!f.claimable && total > 0 && f.reason && <p className="hint">{f.reason}</p>}
          {lastSig && <p className="hint">Last claim: <a href={solscanTx(lastSig)} target="_blank" rel="noreferrer">view transaction ↗</a></p>}
          {!zero && <div className="fees-foot"><span>updated {ago(f.updatedAt)}</span>{dry && <span className="warn">dry run</span>}</div>}
        </>
      )}

      {confirmOpen && f && createPortal(
        <div className="confirm-backdrop" onClick={() => setPhase({ kind: "idle" })}>
          <div ref={dialogRef} className="confirm" role="dialog" aria-modal="true" aria-labelledby="claim-confirm-title" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-head"><Logo src={coin.image} label={coin.symbol} size={32} /><b id="claim-confirm-title">Claim fees · {sym(coin)}</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={() => setPhase({ kind: "idle" })}>×</button></div>
            <div className="confirm-rows">
              <div><span>Pays out</span><b className="accent">{phase.payout ? fmt(phase.payout.distributed) : fmt(f.total)}</b></div>
              {(phase.payout?.shares ?? f.perShare.map((s) => ({ address: s.address, bps: s.bps, amount: s.amount }))).map((s) => {
                const a = typeof s.address === "string" ? s.address : s.address.toBase58();
                const r = role(a);
                return <div key={a}><span className={r.tone === "you" ? "accent" : ""}>{r.label} · {a.slice(0, 4)}…{a.slice(-4)}</span><b className={r.tone === "you" ? "accent" : ""}>{fmt(s.amount)}</b></div>;
              })}
              <div><span>Network fee</span><b title={`${phase.units.toLocaleString("en-US")} compute units`}>{phase.spent === null ? "—" : phase.spent < 0n ? `+${feeSol(-phase.spent)} net` : feeSol(phase.spent)}</b></div>
            </div>
            <p className="hint">{dry ? "Dry run: the transaction is simulated again instead of signed." : "Simulated on-chain just now. Your wallet shows the final simulation before you sign; nothing is custodial."}</p>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => setPhase({ kind: "idle" })}>Cancel</button>
              <button type="button" className="btn accent" onClick={confirm}>{dry ? "Simulate claim" : "Claim in wallet"}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}

export default memo(ClaimFees);

/// A short "fees to claim" marker for cards and feed rows when a coin's pending total is known.
export const FeesChip = ({ fees }: { fees: Fees | null | undefined }) => (fees && fees.claimable ? <Chip tone="accent" title={`${amount(tokens(fees.total, fees.quoteDecimals), fees.quoteSymbol)} of creator fees waiting`}>fees to claim</Chip> : null);
