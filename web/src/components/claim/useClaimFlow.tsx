// The claim flow shared by the Claim page rows: build the permissionless payout in the browser,
// simulate it, show who gets what, then hand it to the wallet. "Claim all" first shows what it is
// about to do (coins, wallet approvals, your part), then runs the same steps for each coin in
// turn, each with its own wallet approval. The server only reports numbers; the transaction is
// assembled from the chain (lib/pump/claim.ts) and nothing is custodial. A payout never pays the
// person who presses the button unless they are a shareholder: the dialog says so in words.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { solscanTx, type FeeShare } from "../../lib/api";
import { buildClaimTx, parseClaimLogs, preflight, sendAndConfirm, type ClaimPayout } from "../../lib/pump";
import { friendlyError } from "../../lib/steps";
import { DRY_FUNDED, drySend, isDry } from "../../lib/dry";
import { amount, feeSol, plural, short, tokens, usd } from "../../lib/format";
import { useDialog } from "../../lib/dialog";
import { agentCoinCached } from "../../lib/agent-index";
import { feeRole, feeRoleNote, type FeeRoleTone } from "../../lib/fee-roles";
import { Logo, sym } from "../Bits";
import { useToast } from "../Toast";
import { MiniArc, ROLE_TONE } from "./art";
import "./claim.css";

export type ClaimTarget = { mint: string; symbol: string | null; image: string | null; quoteSymbol: string; quoteDecimals: number; total: string; perShare: FeeShare[]; depth?: number };
type Phase =
  | { kind: "building"; target: ClaimTarget }
  | { kind: "confirm"; target: ClaimTarget; tx: VersionedTransaction; spent: bigint | null; units: number; payout: ClaimPayout | null }
  | { kind: "sending"; target: ClaimTarget; sig: string | null }
  | { kind: "summary"; targets: ClaimTarget[]; usd: number | null };
/// The coin's agent as /api/agents/coin knows it: a root's own agent, or the agent that launched a child.
type AgentCtx = { mint: string; agent: string | null; agentRole: "root" | "child" | null; agentOf: string | null };

export const ROLE_CLASS: Record<FeeRoleTone, string> = { you: "role-creator", creator: "role-creator", spore: "role-spore", agent: "role-agent", other: "role-other" };

export function useClaimFlow(onClaimed: () => void) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const dry = isDry();
  const me = dry ? (new URLSearchParams(window.location.search).get("as") || DRY_FUNDED) : (wallet.publicKey?.toBase58() ?? null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [bulk, setBulk] = useState<{ i: number; n: number; done: number } | null>(null);
  const [agentCtx, setAgentCtx] = useState<AgentCtx | null>(null);
  const alive = useRef(true);
  // The row button that opened a dialog gets focus back when it closes.
  const trigger = useRef<HTMLElement | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fmt = (t: ClaimTarget, raw: string | bigint) => amount(tokens(raw, t.quoteDecimals), t.quoteSymbol);

  const prepare = useCallback(async (t: ClaimTarget) => {
    const payer = new PublicKey(me!);
    const tx = await buildClaimTx(connection, payer, new PublicKey(t.mint));
    const pf = await preflight(connection, tx, payer);
    return { tx, spent: pf.spent, units: pf.unitsConsumed, payout: parseClaimLogs(pf.logs) };
  }, [connection, me]);

  const send = useCallback(async (t: ClaimTarget, tx: VersionedTransaction, payout: ClaimPayout | null) => {
    const sig = dry ? await drySend(connection, tx, "claim") : await sendAndConfirm(connection, wallet, tx, [], (s) => { if (alive.current) setPhase({ kind: "sending", target: t, sig: s }); });
    const paid = payout ? `${fmt(t, payout.distributed)} to ${payout.shares.length} wallet${payout.shares.length === 1 ? "" : "s"}` : "the pending fees";
    toast.success(dry ? `Dry run: the ${t.symbol ? "$" + t.symbol : ""} payout passes (${paid})` : `Paid out ${paid}`, dry ? undefined : { href: solscanTx(sig), label: "view transaction" });
    return sig;
  }, [connection, dry, toast, wallet]);

  const busyNow = !!phase || !!bulk;
  /** One coin: simulate, then the confirm dialog decides. */
  const start = useCallback(async (t: ClaimTarget) => {
    if (!me || phase || bulk) return;
    trigger.current = document.activeElement as HTMLElement | null;
    setPhase({ kind: "building", target: t });
    try {
      const r = await prepare(t);
      if (alive.current) setPhase({ kind: "confirm", target: t, ...r });
    } catch (e) { toast.error(friendlyError(e)); if (alive.current) setPhase(null); }
  }, [me, phase, bulk, prepare, toast]);

  const confirm = useCallback(async () => {
    if (phase?.kind !== "confirm") return;
    const { target, tx, payout } = phase;
    setPhase({ kind: "sending", target, sig: null });
    try { await send(target, tx, payout); onClaimed(); }
    catch (e) { toast.error(friendlyError(e)); }
    finally { if (alive.current) setPhase(null); }
  }, [phase, send, onClaimed, toast]);

  /** Every claimable coin in turn; a coin whose simulation fails is skipped, a wallet refusal stops the run. */
  const runAll = useCallback(async (targets: ClaimTarget[]) => {
    if (!me || bulk || !targets.length) return;
    let done = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!alive.current) return;
      setBulk({ i, n: targets.length, done });
      setPhase({ kind: "building", target: t });
      let r: Awaited<ReturnType<typeof prepare>>;
      try { r = await prepare(t); } catch (e) { toast.error(`${t.symbol ? "$" + t.symbol : t.mint.slice(0, 6)}: ${friendlyError(e)}`); continue; }
      setPhase({ kind: "sending", target: t, sig: null });
      try { await send(t, r.tx, r.payout); done++; }
      catch (e) {
        const msg = friendlyError(e);
        toast.error(msg);
        if (/reject|declin|cancel/i.test(String((e as Error)?.message ?? e))) break;
      }
    }
    if (alive.current) { setPhase(null); setBulk(null); }
    onClaimed();
  }, [me, bulk, prepare, send, onClaimed, toast]);

  /** "Claim all": first a summary of what will happen, then `runAll` on Start. */
  const claimAll = useCallback((targets: ClaimTarget[], usdTotal: number | null = null) => {
    if (!me || phase || bulk || !targets.length) return;
    trigger.current = document.activeElement as HTMLElement | null;
    setPhase({ kind: "summary", targets, usd: usdTotal });
  }, [me, phase, bulk]);

  // Who each payout goes to: the agent behind the coin is looked up once per mint (cached a minute).
  const target = phase && phase.kind !== "summary" ? phase.target : null;
  useEffect(() => {
    if (phase?.kind !== "confirm" || !target) return;
    let ok = true;
    agentCoinCached({ mint: target.mint, depth: target.depth ?? 1 })
      .then((ac) => { if (ok) setAgentCtx({ mint: target.mint, agent: ac?.agent?.address ?? null, agentRole: ac?.role ?? null, agentOf: ac?.root ? sym(ac.root) : null }); })
      .catch(() => { if (ok) setAgentCtx({ mint: target.mint, agent: null, agentRole: null, agentOf: null }); });
    return () => { ok = false; };
  }, [phase?.kind, target?.mint, target?.depth]);  // eslint-disable-line react-hooks/exhaustive-deps

  // A dialog that closed while its row button was disabled (sending) could not return focus; do it once the row is free.
  useEffect(() => {
    if (phase || bulk) return;
    const a = document.activeElement;
    if ((!a || a === document.body) && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }, [phase, bulk]);

  const close = () => setPhase(null);
  const confirmRef = useDialog<HTMLDivElement>(phase?.kind === "confirm", close, { initialFocus: primary, returnFocus: trigger });
  const summaryRef = useDialog<HTMLDivElement>(phase?.kind === "summary", close, { initialFocus: primary, returnFocus: trigger });

  const busyMint = target?.mint ?? null;
  const labelFor = (mint: string) => {
    if (busyMint !== mint || !phase || phase.kind === "summary") return null;
    return phase.kind === "building" ? "Simulating…" : phase.kind === "sending" ? (phase.sig ? "Confirming…" : "Waiting for wallet…") : "Review…";
  };

  let dialog: ReactNode = null;
  if (phase?.kind === "confirm") {
    const t = phase.target;
    const rows = (phase.payout?.shares ?? t.perShare.map((s) => ({ address: s.address, bps: s.bps, amount: s.amount }))).map((s) => {
      const a = typeof s.address === "string" ? s.address : (s.address as PublicKey).toBase58();
      const ctx = agentCtx?.mint === t.mint ? agentCtx : null;
      const role = feeRole(a, { me, agent: ctx?.agent, agentRole: ctx?.agentRole, agentOf: ctx?.agentOf, inferCreator: true });
      return { a, amount: s.amount, role };
    });
    const mine = !!me && rows.some((r) => r.a === me);
    const tag = t.symbol ? `$${t.symbol}` : short(t.mint, 4);
    dialog = createPortal(
      <div className="confirm-backdrop" onClick={close}>
        <div ref={confirmRef} className="confirm claim-confirm" role="dialog" aria-modal="true" aria-labelledby="claim-confirm-title" onClick={(e) => e.stopPropagation()}>
          <div className="confirm-head"><Logo src={t.image} label={t.symbol} size={32} /><b id="claim-confirm-title">{mine ? "Claim fees" : "Pay out fees"} · {tag}</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={close}>✕</button></div>
          <div className="confirm-rows">
            <div className="confirm-total"><span className="claim-total-k"><MiniArc size={34} parts={rows.map((r) => ({ v: Number(r.amount) || 0, tone: ROLE_TONE[r.role.tone] }))} />Pays out</span><b className="accent">{fmt(t, phase.payout ? phase.payout.distributed : t.total)}</b></div>
            {rows.map((r) => {
              const note = feeRoleNote(r.role.tone);
              return (
                <div key={r.a} className={`claim-share ${r.role.tone === "you" ? "is-you" : ""}`}>
                  <span><i className={`dot ${ROLE_CLASS[r.role.tone]}`} aria-hidden="true" />{r.role.label}<small className="mono">{short(r.a, 4)}{note ? ` · ${note}` : ""}</small></span>
                  <b>{fmt(t, r.amount)}</b>
                </div>
              );
            })}
            <div><span>Network fee (you pay)</span><b title={`${phase.units.toLocaleString("en-US")} compute units`}>{phase.spent === null ? "—" : phase.spent < 0n ? `+${feeSol(-phase.spent)} net` : feeSol(phase.spent)}</b></div>
          </div>
          <p className="hint">{dry ? "Dry run: the transaction is simulated again instead of signed."
            : mine ? "Simulated on-chain just now. Your part arrives in this wallet together with every other shareholder's."
            : "Simulated on-chain just now. You pay only the network fee; the money goes to the shareholders above, none of it to you."}</p>
          <div className="confirm-actions">
            <button type="button" className="btn ghost" onClick={close}>Cancel</button>
            <button ref={primary} type="button" className={`btn ${mine ? "accent" : "soft"}`} onClick={confirm}>{dry ? "Simulate" : mine ? "Claim in wallet" : "Pay out in wallet"}</button>
          </div>
        </div>
      </div>,
      document.body,
    );
  } else if (phase?.kind === "summary") {
    const n = phase.targets.length;
    dialog = createPortal(
      <div className="confirm-backdrop" onClick={close}>
        <div ref={summaryRef} className="confirm claim-summary" role="dialog" aria-modal="true" aria-labelledby="claim-all-title" onClick={(e) => e.stopPropagation()}>
          <div className="confirm-head"><b id="claim-all-title">Claim all</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={close}>✕</button></div>
          <p className="claim-summary-line mono">{plural(n, "coin")} · {plural(n, "wallet approval")} · your part ≈ {usd(phase.usd)}</p>
          <ul className="claim-summary-coins">
            {phase.targets.slice(0, 6).map((t) => <li key={t.mint}><Logo src={t.image} label={t.symbol} size={20} /><span className="mono">{t.symbol ? `$${t.symbol}` : short(t.mint, 4)}</span></li>)}
            {n > 6 && <li className="muted">+{n - 6} more</li>}
          </ul>
          <p className="hint">{dry ? "Dry run: each payout is simulated instead of signed." : "Each coin is simulated first, then your wallet asks once per coin. Cancel any approval to stop the run; coins already paid out stay paid."}</p>
          <div className="confirm-actions">
            <button type="button" className="btn ghost" onClick={close}>Cancel</button>
            <button ref={primary} type="button" className="btn accent" onClick={() => { const ts = phase.targets; setPhase(null); void runAll(ts); }}>Start</button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return { me, dry, busy: busyNow, bulk, start, claimAll, labelFor, dialog };
}
