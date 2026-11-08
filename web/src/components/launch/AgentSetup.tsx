// A root's agent, set up where the coin is described: which model it thinks with (a radiogroup
// over lib/policy.ts AGENT_MODELS) beside a four-line timeline of what it will do, every number
// from lib/copy.ts. The live AgentsStrip underneath is the proof that agents are running now.
import { useRef, type KeyboardEvent } from "react";
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, type AgentModelId } from "../../lib/policy";
import { AGENT_CADENCE, AGENT_PAYOUT_TO, AGENT_SEED_SOL, ROOT_PCT } from "../../lib/copy";
import AgentsStrip from "../agents/AgentsStrip";
import Term from "../Term";

type Props = { model: AgentModelId; onModel: (m: AgentModelId) => void; locked: boolean };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ICONS = {
  seed: <path d="M8 13.5V8m0 0C8 5.2 6 3.5 3 3.5 3 6.3 5 8 8 8Zm0 0c0-2.8 2-4.5 5-4.5 0 2.8-2 4.5-5 4.5Z" />,
  earn: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v6M6.2 6.6c0-.9.8-1.4 1.8-1.4s1.8.5 1.8 1.3c0 1.9-3.6 1-3.6 2.9 0 .8.8 1.4 1.8 1.4s1.8-.5 1.8-1.4" /></>,
  spawn: <><circle cx="8" cy="4" r="2" /><circle cx="4" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><path d="M7 5.7 5 10.3M9 5.7l2 4.6" /></>,
  out: <><path d="M3 8h9M9 5l3 3-3 3" /><path d="M13.5 3v10" /></>,
} as const;
const Ico = ({ k }: { k: keyof typeof ICONS }) => <svg className="agent-tl-ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[k]}</svg>;

export default function AgentSetup({ model, onModel, locked }: Props) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const label = AGENT_MODELS.find((m) => m.id === model)?.label ?? model;
  const onKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    ev.preventDefault();
    const j = (i + d + AGENT_MODELS.length) % AGENT_MODELS.length;
    if (!locked) onModel(AGENT_MODELS[j].id);
    refs.current[j]?.focus();
  };
  const steps: [keyof typeof ICONS, string][] = [
    ["seed", `Born with ${AGENT_SEED_SOL} SOL, sent from your launch in the same signature, as gas.`],
    ["earn", `Earns ${ROOT_PCT.agent} of every trade of your coin and claims it itself.`],
    ["spawn", `${cap(AGENT_CADENCE)} it launches a child under your coin: names it, draws its logo, and pays its ${label} bill from its own wallet, never yours.`],
    ["out", `Sends its surplus to ${AGENT_PAYOUT_TO}.`],
  ];
  return (
    <div className="agent-setup">
      <div className="agent-setup-head">
        <span className="agent-badge" aria-hidden="true"><Ico k="spawn" /></span>
        <div><b>Your coin's <Term k="agent">AI agent</Term></b><span>Every new tree gets one, with its own wallet. Pick how it thinks.</span></div>
      </div>
      <div className="agent-setup-grid">
        <div className="agent-models v2" role="radiogroup" aria-label="Your agent thinks with">
          {AGENT_MODELS.map((m, i) => {
            const on = model === m.id;
            return (
              <button key={m.id} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} disabled={locked}
                className={`agent-model v2 ${on ? "on" : ""}`} onClick={() => onModel(m.id)} onKeyDown={(ev) => onKey(ev, i)}>
                <span className="agent-model-top"><b>{m.label}</b>{m.id === DEFAULT_AGENT_MODEL && <span className="agent-default">default</span>}</span>
                <small>{m.note}</small>
              </button>
            );
          })}
        </div>
        <ol className="agent-timeline" aria-label="What your agent does">
          {steps.map(([k, text], i) => (
            <li key={k}><span className="agent-tl-n mono">{i + 1}</span><Ico k={k} /><span>{text}</span></li>
          ))}
        </ol>
      </div>
      <p className="hint agent-setup-hint">It reads your name, ticker and description to pick its theme, so write the description for it.</p>
      <div className="agent-proof"><AgentsStrip /></div>
    </div>
  );
}
