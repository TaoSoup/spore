import type { Shares } from "../lib/api";
import { bps, short } from "../lib/format";
import { feeRole, feeRoleNote, type FeeRoleTone } from "../lib/fee-roles";
import { PUMP_CREATOR_FEE_PCT } from "../lib/copy";
import { Addr } from "./Bits";
import "./launch.css";

/// `agent`: a root's agent slice (lib/policy.ts ROOT_SPLIT), drawn as its own row; its address is
/// null until the launch prepared the wallet. `unit="trade"` (a root) states each slice as a share
/// of every trade ("0.25% of each trade") with the share of the creator fee underneath; the default
/// `"fee"` states the share of the creator fee. `agentOf` names whose agent it is ("$SPREAD").
type Props = {
  agent?: { bps: number; address: string | null } | null; shares: Shares; you: string | null; creator?: string | null; parentCreator: string | null; grandparentCreator: string | null;
  platform: string; parentSymbol?: string | null; grandparentSymbol?: string | null; title?: string; quoteSymbol?: string | null;
  unit?: "fee" | "trade"; agentOf?: string | null;
};

/// One colour per role, from the --split-* tokens: the creator is always lime (also before a
/// wallet is connected), Spore a quiet grey, the agent orange, anyone else violet.
const ROLE_CLASS: Record<FeeRoleTone, string> = { you: "role-creator", creator: "role-creator", spore: "role-spore", agent: "role-agent", other: "role-other" };
const ofTrade = (b: number) => `${((b / 10_000) * PUMP_CREATOR_FEE_PCT).toFixed(2)}%`;

/// Who earns what from the new coin's creator fees, forever. Two rows by default (creator and
/// Spore, DESIGN §4), three for a root (plus its agent); the server merges duplicates (the platform
/// spawning its own coin, a platform-owned parent), so a single row can carry two roles. Upward
/// shares, when the server re-enables them, are labelled by the parent/grandparent tickers.
export default function SplitPreview({ agent = null, shares, you, creator, parentCreator, grandparentCreator, platform, parentSymbol, grandparentSymbol, title = "Creator fee split", quoteSymbol, unit = "fee", agentOf = null }: Props) {
  const perTrade = unit === "trade";
  const ctx = { me: you, creator: creator ?? you, agent: agent?.address ?? null, agentOf, agentRole: "root" as const };
  type Row = { key: string; address: string | null; bps: number; label: string; tone: FeeRoleTone; isCreator: boolean };
  const rows: Row[] = shares.map((s) => {
    // The server previews a root's creator slot with an empty address until a wallet connects.
    if (!s.address) return { key: `creator-${s.bps}`, address: null, bps: s.bps, label: perTrade ? "you (creator)" : "creator", tone: "creator", isCreator: true };
    const r = feeRole(s.address, ctx);
    let label = r.label;
    if (r.tone === "other") {
      if (parentCreator && s.address === parentCreator) label = parentSymbol ? `$${parentSymbol.replace(/^\$/, "")} creator` : "parent creator";
      else if (grandparentCreator && s.address === grandparentCreator) label = grandparentSymbol ? `$${grandparentSymbol.replace(/^\$/, "")} creator` : "grandparent creator";
      // At launch an unknown wallet can only be the new coin's creator (the form passes `you`).
      else if (you === null && creator === undefined) label = "creator";
    }
    const isCreator = r.tone === "you" || r.tone === "creator" || label === "creator";
    if (perTrade && r.tone === "you") label = "you (creator)";
    else if (r.tone === "you" && !/creator|Spore|agent/.test(label)) label = "you (creator)";
    return { key: s.address, address: s.address, bps: s.bps, label, tone: isCreator ? (r.tone === "you" ? "you" : "creator") : r.tone, isCreator };
  });
  rows.sort((a, b) => Number(b.isCreator) - Number(a.isCreator));
  if (agent) rows.push({ key: "agent", address: agent.address, bps: agent.bps, label: agentOf ? `${agentOf}'s agent` : "your coin's agent", tone: "agent", isCreator: false });
  const total = rows.reduce((s, x) => s + x.bps, 0);
  const value = (b: number) => (perTrade ? `${ofTrade(b)} of each trade once graduated` : bps(b));
  return (
    <div className={`split v2 ${perTrade ? "per-trade" : ""}`}>
      <div className="split-head"><b>{title}</b><span className="muted">{total === 10_000 ? "100% · set once at creation, immutable after" : `${bps(total)} allocated · set once at creation`}</span></div>
      <div className="split-bar" aria-hidden="true">
        {rows.map((r) => <i key={r.key} className={ROLE_CLASS[r.tone]} style={{ width: `${r.bps / 100}%` }} title={`${r.label} ${bps(r.bps)}`} />)}
      </div>
      <ul className="split-rows">
        {rows.map((r) => {
          const note = feeRoleNote(r.tone);
          return (
            <li key={r.key}>
              <i className={`dot ${ROLE_CLASS[r.tone]}`} aria-hidden="true" />
              <span className="split-role">{r.label}{note && <small>{note}</small>}</span>
              {r.address ? <Addr a={r.address} n={4} /> : <span className="split-fill">{r.tone === "agent" ? "wallet made at launch" : "connect to fill"}</span>}
              <b className="mono">{value(r.bps)}{perTrade && <small>{bps(r.bps)} of the fee</small>}</b>
            </li>
          );
        })}
        {!rows.length && <li className="muted">No split data yet{you ? "" : ` — connect a wallet to see your share (${short(platform || null)} is the platform)`}.</li>}
      </ul>
      <p className="hint">{quoteSymbol ? `Paid in ${quoteSymbol}` : "Paid in the coin's quote (SOL for a root, the parent coin for a child)"}: every trade sends its creator fee to these wallets in this proportion. Written on-chain and set once at creation, with the admin revoked, so it can never change.</p>
    </div>
  );
}
