// One root agent in the /agents grid (elevation 2026-10-24), read top to bottom as a character card:
// the orbit avatar, who it is and whether it runs, what it is doing now, two instrument arcs (the
// launch fund, earned against spent), its last three diary entries on a little rail and the latest
// coin it launched. The card leans toward the pointer and its light follows it (Tilt) in the agent's
// palette tint. The title link stretches over the whole card (no nested anchors), so the card opens
// the agent page from anywhere.
import { useMemo, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { Agent } from "../../lib/api";
import { age, count, usd } from "../../lib/format";
import { nameOf } from "../Bits";
import Tilt from "../ui/Tilt";
import { AgentAvatar, agentName, Icon, ModelChip, ProposalLogo, StatusBadge } from "./bits";
import { LaunchFund, PaysForItself } from "./Meters";
import { entryTitle, groupActivity, statusLabel, statusSentence, toneOf } from "./diary";
import { launchNeed, paletteTint, runState } from "./data";

export default function AgentCard({ agent, now, solUsd, fresh = false }: { agent: Agent; now: number; solUsd: number | null | undefined; fresh?: boolean }) {
  const { root, profile, totals } = agent;
  const tint = paletteTint(profile?.palette);
  const state = runState(agent);
  const entries = useMemo(() => groupActivity(agent.activity), [agent.activity]);
  const need = launchNeed(agent);
  const last = agent.launched[0] ?? null;
  return (
    <Tilt as="article" max={3} lift={2} className={`agent-card st-${state.state} ${fresh ? "is-new" : ""}`} style={tint ? ({ "--tint": tint } as CSSProperties) : undefined}>
      <span className="agent-card-light" aria-hidden="true" />
      <header className="agent-card-head">
        <AgentAvatar root={root} state={state.state} size={52} spin="hover" />
        <div className="agent-card-title">
          <h3><Link to={`/agents/${root.mint}`} className="agent-card-link">{agentName(root)}</Link></h3>
          <div className="agent-card-sub">
            <StatusBadge agent={agent} now={now} />
            <span className="muted">{nameOf(root)}</span>
          </div>
        </div>
      </header>

      <p className="agent-card-status">{statusSentence(agent, entries, now, need)}</p>

      <div className="agent-card-inst">
        <LaunchFund wallet={agent.wallet} need={need} size="sm" />
        <PaysForItself totals={totals} wallet={agent.wallet} solUsd={solUsd} compact />
      </div>

      {entries.length > 0 && (
        <ol className="agent-card-diary" aria-label="Latest diary entries">
          {entries.slice(0, 3).map((e) => (
            <li key={e.key} className={`k-${e.kind} t-${e.tone}`}>
              <span className="agent-card-node" aria-hidden="true"><Icon kind={e.kind} /></span>
              <span className="agent-card-diary-text">{entryTitle(e)}{e.tone !== "ok" && <em> · {statusLabel([...e.items, ...e.steps].find((a) => toneOf(a.status) === e.tone)?.status ?? "")}</em>}</span>
              <time className="mono">{now - e.at < 60 ? "now" : age(e.at)}</time>
            </li>
          ))}
        </ol>
      )}

      {last ? (
        <div className="agent-card-latest">
          <ProposalLogo p={last} palette={profile?.palette} size={40} />
          <div>
            <p><b>{last.name ?? last.symbol ?? "—"}</b>{last.symbol && <span className="mono">${last.symbol}</span>}<span className="mono muted">· {last.createdAt ? age(last.createdAt) : "—"}</span></p>
            <p className="agent-card-why">{last.why ?? "its latest launch under the root"}</p>
          </div>
        </div>
      ) : (
        <p className="agent-card-latest empty-line">{state.state === "paused" ? "Paused: nothing is launched while it is off." : "Nothing launched yet: its first coin goes out once its wallet can pay for a launch."}</p>
      )}

      <footer className="agent-card-foot">
        <ModelChip model={agent.model} />
        <span className="mono">{count(totals.launches)} coin{totals.launches === 1 ? "" : "s"} · earned {totals.claimsUsd ? usd(totals.claimsUsd) : "none yet"}</span>
        <span className="agent-card-open" aria-hidden="true">open <span className="arrow">→</span></span>
      </footer>
    </Tilt>
  );
}
