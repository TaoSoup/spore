// Spore's own confirmation before the trading wallet signs a launch or a fee split (lib/flow.ts SignConfirm): the
// trading wallet signs without a popup, so the page asks itself, after the simulation, with the exact cost, before
// anything is signed. Shared by the Launch page and the coin page's "Launch a child" card.
// What the dialog shows is captured when the flow starts (`AskView`), never read from the form afterwards: the
// transaction on the table was built from those values, and no wallet popup would contradict a changed page.
// The dialog opens seconds after the launch button was pressed, and its sign button is the whole consent. So the focus
// lands on Cancel, never on the button that signs: a stray or repeated Enter or Space answers "no". And the sign button
// does nothing for a moment after the dialog appears (ASK_ARM_MS), so a click already on its way cannot sign either.
// One question at a time: a flow that asks while another question is open answers that one "no" first. Closing the
// dialog, or the page unmounting, answers "no".
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SignConfirm } from "../../lib/flow";
import { useDialog } from "../../lib/dialog";
import { compact, feeSol, lamportsToSol, short, sol } from "../../lib/format";
import { Logo } from "../Bits";

/// How long the confirmation ignores its sign button after it appears.
export const ASK_ARM_MS = 600;

export type AskView = { tag: string; image: string | null; payer: string; root: boolean; parentTag: string; feeLamports: bigint; seedLamports: bigint; split: string; slippage: number };

export function useLaunchAsk(): { confirmWith: (v: AskView) => (c: SignConfirm) => Promise<boolean>; dialog: ReactNode } {
  const [ask, setAsk] = useState<{ c: SignConfirm; v: AskView; done: (ok: boolean) => void } | null>(null);
  const askRef = useRef(ask);
  askRef.current = ask;
  const answer = (ok: boolean) => { const a = askRef.current; if (!a) return; setAsk(null); a.done(ok); };
  useEffect(() => () => { askRef.current?.done(false); }, []);
  const askCancel = useRef<HTMLButtonElement>(null);
  const askAt = useRef(0);
  const askDialog = useDialog<HTMLDivElement>(!!ask, () => answer(false), { initialFocus: askCancel });
  const answerYes = () => { if (performance.now() - askAt.current < ASK_ARM_MS) return; answer(true); };
  const confirmWith = (v: AskView) => (c: SignConfirm) => new Promise<boolean>((done) => { askRef.current?.done(false); askAt.current = performance.now(); setAsk({ c, v, done }); });
  const dialog = ask && createPortal(
    <div className="confirm-backdrop" onClick={() => answer(false)}>
      <div ref={askDialog} className="confirm" role="dialog" aria-modal="true" aria-labelledby="launch-confirm-title" onClick={(ev) => ev.stopPropagation()}>
        <div className="confirm-head"><Logo src={ask.v.image} label={ask.v.tag.slice(1)} size={32} /><b id="launch-confirm-title">{ask.c.kind === "launch" ? "Launch" : "Lock the fee split of"} {ask.v.tag}</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={() => answer(false)}>×</button></div>
        <div className="confirm-rows">
          <div><span>{ask.c.kind === "launch" ? "Creator, pays and signs" : "Pays and signs"}</span><b>Trading wallet · {short(ask.v.payer, 4)}</b></div>
          {ask.c.kind === "launch" && <div><span>Tree</span><b>{ask.v.root ? "New tree · priced in SOL" : `Under ${ask.v.parentTag}`}</b></div>}
          <div><span>{ask.c.kind === "launch" ? "The launch spends" : "This spends"}</span><b className="accent" title="Measured by simulating this exact transaction just now">{feeSol(ask.c.spent)}</b></div>
          {ask.c.kind === "launch" && ask.v.feeLamports > 0n && <div><span>of which launch fee, to Spore</span><b>{sol(lamportsToSol(ask.v.feeLamports))}</b></div>}
          {ask.c.kind === "launch" && ask.v.seedLamports > 0n && <div><span>of which gas for your coin's agent</span><b>{sol(lamportsToSol(ask.v.seedLamports))}</b></div>}
          {ask.c.kind === "launch" && <div><span>Creator fees go to</span><b>{ask.v.split}</b></div>}
          {ask.c.secondSplit && <div><span>Then, without asking again</span><b>the fee split, in a second transaction</b></div>}
          {ask.c.firstBuyLamports > 0n && <div><span>Then, without asking again</span><b>first buy of {sol(lamportsToSol(ask.c.firstBuyLamports))}{ask.c.firstBuyMinOut !== null ? ` · for at least ≈ ${compact(Number(ask.c.firstBuyMinOut) / 1e6)} ${ask.v.tag} (the estimate less ${ask.v.slippage / 100}% slippage), or it is not bought` : ` · up to ${ask.v.slippage / 100}% slippage`}</b></div>}
        </div>
        <p className="hint">{ask.c.kind === "launch"
          ? "Simulated on-chain just now. Your trading wallet signs as soon as you press the button; no wallet popup follows. The fee split is written with the coin and can never be changed."
          : "Simulated on-chain just now. Your trading wallet signs as soon as you press the button; no wallet popup follows. The split is set once and can never be changed."}</p>
        <div className="confirm-actions">
          <button ref={askCancel} type="button" className="btn ghost" onClick={() => answer(false)}>Cancel</button>
          <button type="button" className="btn accent" onClick={answerYes}>{ask.c.kind === "launch" ? `Launch ${ask.v.tag} now` : "Lock the fee split now"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
  return { confirmWith, dialog };
}
