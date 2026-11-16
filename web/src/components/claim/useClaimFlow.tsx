// The claim flow shared by the Claim page rows: build the permissionless payout in the browser,
// simulate it, show who gets what, then hand it to the wallet. "Claim all" first shows what it is
// about to do (coins, wallet approvals, your part), then runs the same steps for each coin in
// turn, each with its own wallet approval. The server only reports numbers; the transaction is
// assembled from the chain (lib/pump/claim.ts) and nothing is custodial. A payout never pays the
// person who presses the button unless they are a shareholder: the dialog says so in words.
//
// The account wallet signs (lib/trader.ts useAccount): the trading wallet when the user has one,
// else the connected extension. The trading wallet signs without a popup, so the confirm dialog
// (one coin) and the summary (Claim all) are the confirmation, and say so; while it is locked a
// claim only opens the unlock panel. Its "Claim all" summary simulates every coin before Start and
// lists each payout with its recipients and its cost; a payout is then signed only if the fresh
// simulation costs no more than the list said (lib/trader.ts withinQuotedCost), and the run can be
// stopped after the current coin. A payout pays the wallets of the coin's fee split whoever
// signs: for a coin launched with the extension the dialog says the part goes to that wallet.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { solscanTx, type FeeShare } from "../../lib/api";
import { buildClaimTx, parseClaimLogs, preflight, sendAndConfirm, type ClaimPayout } from "../../lib/pump";
import { friendlyError } from "../../lib/steps";
import { DRY_FUNDED, drySend, isDry } from "../../lib/dry";
import { amount, feeSol, plural, short, tokens, usd } from "../../lib/format";
import { useDialog } from "../../lib/dialog";
import { agentCoinCached } from "../../lib/agent-index";
import { feeRole, feeRoleNote, type FeeRoleTone } from "../../lib/fee-roles";
import { claimWords, openTradingWallet, paidToOf, payerProblem, useAccount, withinQuotedCost } from "../../lib/trader";
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
/// One coin of the trading wallet's "Claim all" list, as simulated before Start: what its payout costs the signer and
/// who it pays, or why it cannot run now (`fund`: the trading wallet lacks SOL for the fee).
type Quote = { spent: bigint | null; payout: ClaimPayout | null } | { error: string; fund: boolean };
const quoted = (q: Quote | undefined): q is { spent: bigint; payout: ClaimPayout | null } => !!q && !("error" in q) && q.spent !== null;
const costText = (spent: bigint) => (spent < 0n ? `+${feeSol(-spent)} net` : feeSol(spent));
/// The coin's agent as /api/agents/coin knows it: a root's own agent, or the agent that launched a child.
type AgentCtx = { mint: string; agent: string | null; agentRole: "root" | "child" | null; agentOf: string | null };

/// How long a trading-wallet dialog ignores its sign button after it appears (see `armed`).
const ARM_MS = 600;
const UNMEASURED = "The payout simulates fine, but its exact cost could not be measured just now, so nothing was signed. Try again in a moment.";

export const ROLE_CLASS: Record<FeeRoleTone, string> = { you: "role-creator", creator: "role-creator", spore: "role-spore", agent: "role-agent", other: "role-other" };

export function useClaimFlow(onClaimed: () => void) {
  const { connection } = useConnection();
  const account = useAccount();
  const toast = useToast();
  const dry = isDry();
  const me = dry ? (new URLSearchParams(window.location.search).get("as") || DRY_FUNDED) : account.address;
  /// The trading wallet signs: no extension popup follows a button, so the dialogs are the confirmation.
  const silent = !dry && account.kind === "trading";
  const locked = !dry && account.locked;
  /// The connected extension beside a trading wallet: not the account, but coins launched with it pay it.
  const also = !dry && account.kind === "trading" && account.ext.address && account.ext.address !== account.address ? account.ext.address : null;
  /// Which of the user's wallets a fee share pays (a dry run has one: the wallet it runs as).
  const ownerOf = (a: string): "trading" | "wallet" | null => (dry ? (a === me ? "wallet" : null) : account.walletOf(a));
  const askUnlock = useCallback(() => { openTradingWallet(); toast.info("Unlock your trading wallet to claim: it signs the payout."); }, [toast]);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [bulk, setBulk] = useState<{ i: number; n: number; done: number; stopping: boolean } | null>(null);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const quoteRun = useRef(0);
  const stopRef = useRef(false);
  const [agentCtx, setAgentCtx] = useState<AgentCtx | null>(null);
  const alive = useRef(true);
  // The row button that opened a dialog gets focus back when it closes.
  const trigger = useRef<HTMLElement | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  // With the trading wallet a dialog's sign button is the whole consent (no wallet popup follows), and the dialog
  // opens by itself once the simulation is back. So the focus lands on Cancel, never on the button that signs (a held
  // or repeated Enter from the row's button answers "no"), and that button does nothing for a moment after the dialog
  // appears. With the extension the focus stays on the primary button, as before: its popup is the consent.
  const cancel = useRef<HTMLButtonElement>(null);
  const shownAt = useRef(0);
  const armed = () => !silent || performance.now() - shownAt.current >= ARM_MS;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fmt = (t: ClaimTarget, raw: string | bigint) => amount(tokens(raw, t.quoteDecimals), t.quoteSymbol);

  const prepare = useCallback(async (t: ClaimTarget) => {
    const payer = new PublicKey(me!);
    const tx = await buildClaimTx(connection, payer, new PublicKey(t.mint));
    const pf = await preflight(connection, tx, payer);
    return { tx, spent: pf.spent, units: pf.unitsConsumed, payout: parseClaimLogs(pf.logs) };
  }, [connection, me]);

  const send = useCallback(async (t: ClaimTarget, tx: VersionedTransaction, payout: ClaimPayout | null) => {
    if (!dry && !account.sender) throw new Error(account.locked ? "The trading wallet is locked: unlock it to claim" : "Connect a wallet first");
    // built for the wallet that was the account when the dialog opened: never handed to another one
    if (!dry && !account.sender!.publicKey?.equals(tx.message.staticAccountKeys[0])) throw new Error("Your wallet changed while the claim was open. Nothing was signed; start the claim again.");
    const sig = dry ? await drySend(connection, tx, "claim") : await sendAndConfirm(connection, account.sender!, tx, [], (s) => { if (alive.current) setPhase({ kind: "sending", target: t, sig: s }); });
    const paid = payout ? `${fmt(t, payout.distributed)} to ${payout.shares.length} wallet${payout.shares.length === 1 ? "" : "s"}` : "the pending fees";
    toast.success(dry ? `Dry run: the ${t.symbol ? "$" + t.symbol : ""} payout passes (${paid})` : `Paid out ${paid}`, dry ? undefined : { href: solscanTx(sig), label: "view transaction" });
    return sig;
  }, [connection, dry, toast, account.sender, account.locked]);

  /// A failure, in the payer's words: a trading wallet without SOL for the fee is named, with its deposit view.
  const fail = useCallback((e: unknown, prefix = "") => {
    const p = payerProblem(friendlyError(e), silent);
    toast.error(prefix + p.text);
    if (p.fund) openTradingWallet("deposit");
    return p;
  }, [silent, toast]);

  const busyNow = !!phase || !!bulk;
  /** One coin: simulate, then the confirm dialog decides. */
  const start = useCallback(async (t: ClaimTarget) => {
    if (!me || phase || bulk) return;
    if (locked) { askUnlock(); return; }
    trigger.current = document.activeElement as HTMLElement | null;
    setPhase({ kind: "building", target: t });
    try {
      const r = await prepare(t);
      // the trading wallet signs only a cost the dialog could show (as "Claim all" does: withinQuotedCost)
      if (silent && r.spent === null) throw new Error(UNMEASURED);
      shownAt.current = performance.now();
      if (alive.current) setPhase({ kind: "confirm", target: t, ...r });
    } catch (e) { fail(e); if (alive.current) setPhase(null); }
  }, [me, phase, bulk, prepare, fail, locked, askUnlock, silent]);

  const confirm = useCallback(async () => {
    if (phase?.kind !== "confirm" || !armed()) return;
    const { target, tx, payout } = phase;
    setPhase({ kind: "sending", target, sig: null });
    try { await send(target, tx, payout); onClaimed(); }
    catch (e) { fail(e); }
    finally { if (alive.current) setPhase(null); }
  }, [phase, send, onClaimed, fail, silent]);  // eslint-disable-line react-hooks/exhaustive-deps

  /** Every claimable coin in turn; a coin whose simulation fails is skipped, a wallet refusal stops the run, and so
   *  does `stop` (after the current coin). `limits` (the trading wallet): each coin's cost as the list showed it; a
   *  payout whose fresh simulation costs more is not signed. */
  const runAll = useCallback(async (targets: ClaimTarget[], limits: Record<string, bigint> | null = null) => {
    if (!me || bulk || !targets.length) return;
    stopRef.current = false;
    let done = 0;
    const tagOf = (t: ClaimTarget) => (t.symbol ? "$" + t.symbol : t.mint.slice(0, 6));
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!alive.current || stopRef.current) break;
      setBulk({ i, n: targets.length, done, stopping: false });
      setPhase({ kind: "building", target: t });
      let r: Awaited<ReturnType<typeof prepare>>;
      try { r = await prepare(t); } catch (e) { if (fail(e, `${tagOf(t)}: `).fund) break; continue; }
      if (!alive.current || stopRef.current) break;
      if (limits && !withinQuotedCost(limits[t.mint] ?? null, r.spent)) {
        toast.error(`${tagOf(t)}: its cost changed since the list (${r.spent === null ? "it could not be measured" : `now ${costText(r.spent)}`}), so it was not signed. Claim it on its own.`);
        continue;
      }
      setPhase({ kind: "sending", target: t, sig: null });
      try { await send(t, r.tx, r.payout); done++; }
      catch (e) {
        const p = fail(e);
        // a refusal in the wallet, a trading wallet that locked meanwhile or ran out of SOL: the rest would fail the same way
        if (p.fund || /reject|declin|cancel|trading wallet is locked/i.test(String((e as Error)?.message ?? e))) break;
      }
    }
    // A run that did not pay out every coin says so, when the trading wallet signed it (no popups told the user which
    // coins went through) or the run was stopped. The extension's run is otherwise as it always was.
    if (done < targets.length && (limits || stopRef.current)) toast.info(`Claim all ended: ${done} of ${targets.length} paid out, ${targets.length - done} not. Coins paid out stay paid.`);
    if (alive.current) { setPhase(null); setBulk(null); }
    onClaimed();
  }, [me, bulk, prepare, send, onClaimed, toast, fail]);
  /** Ends a running "Claim all" after the coin in flight. */
  const stop = useCallback(() => { stopRef.current = true; setBulk((b) => (b ? { ...b, stopping: true } : b)); }, []);

  /** The trading wallet's list: every coin simulated before Start, so the summary can say what each payout costs. */
  const quoteAll = useCallback(async (targets: ClaimTarget[]) => {
    const run = ++quoteRun.current;
    setQuotes({});
    for (const t of targets) {
      let q: Quote;
      try { const r = await prepare(t); q = { spent: r.spent, payout: r.payout }; }
      catch (e) { const p = payerProblem(friendlyError(e), true); q = { error: p.text, fund: p.fund }; }
      if (!alive.current || quoteRun.current !== run) return;
      setQuotes((m) => ({ ...m, [t.mint]: q }));
    }
  }, [prepare]);

  /** "Claim all": first a summary of what will happen, then `runAll` on Start. */
  const claimAll = useCallback((targets: ClaimTarget[], usdTotal: number | null = null) => {
    if (!me || phase || bulk || !targets.length) return;
    if (locked) { askUnlock(); return; }
    trigger.current = document.activeElement as HTMLElement | null;
    shownAt.current = performance.now();
    setPhase({ kind: "summary", targets, usd: usdTotal });
    if (silent) void quoteAll(targets);
  }, [me, phase, bulk, locked, askUnlock, silent, quoteAll]);

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

  const close = () => { quoteRun.current++; setPhase(null); };
  const firstFocus = silent ? cancel : primary;
  const confirmRef = useDialog<HTMLDivElement>(phase?.kind === "confirm", close, { initialFocus: firstFocus, returnFocus: trigger });
  const summaryRef = useDialog<HTMLDivElement>(phase?.kind === "summary", close, { initialFocus: firstFocus, returnFocus: trigger });

  const busyMint = target?.mint ?? null;
  const labelFor = (mint: string) => {
    if (busyMint !== mint || !phase || phase.kind === "summary") return null;
    return phase.kind === "building" ? "Simulating…" : phase.kind === "sending" ? (phase.sig ? "Confirming…" : silent ? "Signing…" : "Waiting for wallet…") : "Review…";
  };

  let dialog: ReactNode = null;
  if (phase?.kind === "confirm") {
    const t = phase.target;
    const rows = (phase.payout?.shares ?? t.perShare.map((s) => ({ address: s.address, bps: s.bps, amount: s.amount }))).map((s) => {
      const a = typeof s.address === "string" ? s.address : (s.address as PublicKey).toBase58();
      const ctx = agentCtx?.mint === t.mint ? agentCtx : null;
      const own = ownerOf(a);
      const role = feeRole(a, { me: own ? a : me, agent: ctx?.agent, agentRole: ctx?.agentRole, agentOf: ctx?.agentOf, inferCreator: true });
      return { a, amount: s.amount, role, own };
    });
    // where the user's part goes: the account wallet when the split names it, else the connected wallet it names
    const paidTo = paidToOf(rows.map((r) => r.own));
    const mine = !!paidTo;
    const words = claimWords({ dry, silent, paidTo, extLabel: account.ext.address ? short(account.ext.address, 4) : null });
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
                  <span><i className={`dot ${ROLE_CLASS[r.role.tone]}`} aria-hidden="true" />{r.role.label}<small className="mono">{short(r.a, 4)}{also && r.own ? ` · ${r.own === "trading" ? "trading wallet" : "connected wallet"}` : ""}{note ? ` · ${note}` : ""}</small></span>
                  <b>{fmt(t, r.amount)}</b>
                </div>
              );
            })}
            <div><span>{silent ? "Network fee (your trading wallet pays)" : "Network fee (you pay)"}</span><b title={`${phase.units.toLocaleString("en-US")} compute units`}>{phase.spent === null ? "—" : phase.spent < 0n ? `+${feeSol(-phase.spent)} net` : feeSol(phase.spent)}</b></div>
          </div>
          <p className="hint">{words.hint}</p>
          <div className="confirm-actions">
            <button ref={cancel} type="button" className="btn ghost" onClick={close}>Cancel</button>
            <button ref={primary} type="button" className={`btn ${mine ? "accent" : "soft"}`} onClick={confirm}>{words.button}</button>
          </div>
        </div>
      </div>,
      document.body,
    );
  } else if (phase?.kind === "summary" && silent) {
    // The trading wallet asks nothing per coin, so this list is the whole confirmation: every coin simulated just now,
    // with what it pays out, to whom, and what it costs the trading wallet. Start signs only the coins listed with a
    // cost, and each only if it still costs no more.
    const n = phase.targets.length;
    const list = phase.targets.map((t) => ({ t, q: quotes[t.mint] as Quote | undefined }));
    const checked = list.filter((x) => x.q).length;
    const ready = list.filter((x) => quoted(x.q));
    // Each figure is the trading wallet's SOL before the payout minus after it (lib/pump/simulate.ts): the network fee
    // plus rent, less any SOL the payout pays to the trading wallet itself as a shareholder of a SOL-quoted coin. Such
    // a coin shows as "+… net", and then the total is a net figure too and is labelled as one.
    const cost = ready.reduce((a, x) => a + (quoted(x.q) ? x.q.spent : 0n), 0n);
    const received = ready.some((x) => quoted(x.q) && x.q.spent < 0n);
    const fund = list.some((x) => x.q && "error" in x.q && x.q.fund);
    const toExt = !!also && phase.targets.some((t) => t.perShare.some((s) => s.address === also));
    const startAll = () => {
      if (!armed()) return;
      const limits: Record<string, bigint> = {};
      for (const x of ready) if (quoted(x.q)) limits[x.t.mint] = x.q.spent;
      quoteRun.current++;
      setPhase(null);
      void runAll(ready.map((x) => x.t), limits);
    };
    dialog = createPortal(
      <div className="confirm-backdrop" onClick={close}>
        <div ref={summaryRef} className="confirm claim-summary" role="dialog" aria-modal="true" aria-labelledby="claim-all-title" onClick={(e) => e.stopPropagation()}>
          <div className="confirm-head"><b id="claim-all-title">Claim all</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={close}>✕</button></div>
          <p className="claim-summary-line mono">{plural(n, "coin")} · signed by your trading wallet {short(me ?? "", 4)} · your part ≈ {usd(phase.usd)}</p>
          <ul className="claim-sum-rows" aria-busy={checked < n}>
            {list.map(({ t, q }) => {
              const tag = t.symbol ? `$${t.symbol}` : short(t.mint, 4);
              const shares = (quoted(q) && q.payout ? q.payout.shares : t.perShare).map((s) => {
                const a = typeof s.address === "string" ? s.address : (s.address as PublicKey).toBase58();
                const own = ownerOf(a);
                const who = own ? (also ? (own === "trading" ? "your trading wallet" : "your connected wallet") : "you") : feeRole(a).label;
                return `${who} ${short(a, 4)} ${fmt(t, s.amount)}`;
              });
              return (
                <li key={t.mint} className={`claim-sum-row ${q && !quoted(q) ? "is-off" : ""}`}>
                  <Logo src={t.image} label={t.symbol} size={20} />
                  <span><span className="mono">{tag} · pays out {fmt(t, quoted(q) && q.payout ? q.payout.distributed : t.total)}</span><small className="mono">{q && "error" in q ? (q.fund ? "needs SOL in your trading wallet" : q.error) : `to ${shares.join(" · ")}`}</small></span>
                  <b className="mono">{!q ? "simulating…" : quoted(q) ? `costs ${costText(q.spent)}` : "not signed"}</b>
                </li>
              );
            })}
          </ul>
          <div className="claim-sum-total"><span>{checked < n ? `Simulating ${checked + 1} of ${n}…` : received ? `Net change of your trading wallet's SOL over ${plural(ready.length, "payout")}: the network fees and rent it pays, less the SOL these payouts pay to it` : `Network fees and rent for ${plural(ready.length, "payout")}, paid by your trading wallet`}</span><b className="mono">{checked < n ? "" : costText(cost)}</b></div>
          {fund && <p className="hint">Your trading wallet pays the network fee of every payout and does not hold enough SOL. <button type="button" className="linkish" onClick={() => { close(); openTradingWallet("deposit"); }}>Add SOL to it</button></p>}
          <p className="hint">Simulated on-chain just now. Start signs these payouts one after another with your trading wallet: no wallet popup follows. Each is simulated again right before it is signed and is left out if it would cost more than shown here; the cost is the network fee plus the rent of a shareholder's missing token account{received ? " (for a coin marked net: less the SOL it pays to your trading wallet, so the fee and rent are inside that figure)" : ""}. The button that opened this list stops the run after the coin in flight.{toExt ? ` For coins launched with your connected wallet ${short(also, 4)}, your part goes to that wallet, not to the trading wallet.` : ""} Coins already paid out stay paid.</p>
          <div className="confirm-actions">
            <button ref={cancel} type="button" className="btn ghost" onClick={close}>Cancel</button>
            <button ref={primary} type="button" className="btn accent" disabled={checked < n || ready.length === 0} onClick={startAll}>{checked < n ? "Simulating…" : ready.length === 0 ? "Nothing to sign" : `Start · sign ${plural(ready.length, "payout")}`}</button>
          </div>
        </div>
      </div>,
      document.body,
    );
  } else if (phase?.kind === "summary") {
    const n = phase.targets.length;
    const shown = phase.targets.slice(0, 6);
    dialog = createPortal(
      <div className="confirm-backdrop" onClick={close}>
        <div ref={summaryRef} className="confirm claim-summary" role="dialog" aria-modal="true" aria-labelledby="claim-all-title" onClick={(e) => e.stopPropagation()}>
          <div className="confirm-head"><b id="claim-all-title">Claim all</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={close}>✕</button></div>
          <p className="claim-summary-line mono">{plural(n, "coin")} · {plural(n, "wallet approval")} · your part ≈ {usd(phase.usd)}</p>
          <ul className="claim-summary-coins">
            {shown.map((t) => <li key={t.mint}><Logo src={t.image} label={t.symbol} size={20} /><span className="mono">{t.symbol ? `$${t.symbol}` : short(t.mint, 4)}</span></li>)}
            {n > shown.length && <li className="muted">+{n - shown.length} more</li>}
          </ul>
          <p className="hint">{dry ? "Dry run: each payout is simulated instead of signed."
            : "Each coin is simulated first, then your wallet asks once per coin. Cancel any approval to stop the run; coins already paid out stay paid."}</p>
          <div className="confirm-actions">
            <button type="button" className="btn ghost" onClick={close}>Cancel</button>
            <button ref={primary} type="button" className="btn accent" onClick={() => { const ts = phase.targets; setPhase(null); void runAll(ts); }}>Start</button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return { me, dry, busy: busyNow, bulk, start, claimAll, stop, labelFor, dialog, silent, locked, also };
}
