// The agent's diary on its page (elevation 2026-10-24): a vertical rail timeline. Grouped entries
// under sticky day headings, a time column, then the rail with one glowing node per entry in its
// kind's colour (launch lime with the coin's logo, claim teal, payout green, model calls violet),
// one line per entry and a status chip only when something is wrong. Filters (all · launches ·
// fees · AI) regroup the matching ledger lines behind a sliding pill; 12 entries at a time.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { solscanTx, type ActivityItem, type AgentLaunched } from "../../lib/api";
import { short, when } from "../../lib/format";
import SlidingPill from "../ui/SlidingPill";
import { Icon, ProposalLogo, solShort, usdcAmt } from "./bits";
import { clockHM, dayLabel, entryTitle, usd2, filterActivity, groupActivity, humanTitle, rawDetail, statusLabel, stepLabel, toneOf, type DiaryEntry, type DiaryFilter } from "./diary";

const PAGE = 12;
const FILTERS: [DiaryFilter, string][] = [["all", "all"], ["launches", "launches"], ["fees", "fees"], ["ai", "AI"]];

export default function Diary({ activity, now, launched, palette, newKeys }: { activity: ActivityItem[]; now: number; launched: AgentLaunched[]; palette?: string[] | null; newKeys: Set<string> }) {
  const [filter, setFilter] = useState<DiaryFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const byFilter = useMemo(() => Object.fromEntries(FILTERS.map(([f]) => [f, groupActivity(filterActivity(activity, f))])) as Record<DiaryFilter, DiaryEntry[]>, [activity]);
  const byMint = useMemo(() => new Map(launched.map((l) => [l.mint, l])), [launched]);
  const entries = byFilter[filter];
  const shown = entries.slice(0, limit);
  const days = useMemo(() => {
    const out: { label: string; entries: DiaryEntry[] }[] = [];
    for (const e of shown) {
      const label = dayLabel(e.at, now);
      if (out[out.length - 1]?.label !== label) out.push({ label, entries: [] });
      out[out.length - 1].entries.push(e);
    }
    return out;
  }, [shown, now]);

  if (activity.length === 0) return <div className="empty"><b>No entries yet</b><p>Every claim, launch, payout and model call lands here the moment the agent makes it, with its transaction.</p></div>;
  return (
    <div className="agent-diary">
      <div className="seg agent-filter" role="group" aria-label="Show">
        <SlidingPill />
        {FILTERS.map(([f, label]) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => { setFilter(f); setLimit(PAGE); }} disabled={f !== "all" && byFilter[f].length === 0}>
            {label}<span className="agent-filter-n">{byFilter[f].length}</span>
          </button>
        ))}
      </div>
      {entries.length === 0 ? <div className="empty"><b>Nothing of that kind yet</b></div> : (
        <>
          {days.map((d) => (
            <section key={d.label} className="agent-day" aria-label={d.label}>
              <h3 className="agent-day-head mono">{d.label}</h3>
              <ol>
                {d.entries.map((e) => <EntryRow key={e.key} e={e} coin={e.type === "launch" ? byMint.get(e.items[0].mint ?? "") ?? null : null} palette={palette} fresh={e.keys.some((k) => newKeys.has(k))} />)}
              </ol>
            </section>
          ))}
          {entries.length > limit && <button type="button" className="btn ghost sm agent-more" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, entries.length - limit)} more ({entries.length - limit} left)</button>}
        </>
      )}
    </div>
  );
}

const amounts = (a: ActivityItem) => [a.amountSol != null ? solShort(a.amountSol) : null, a.amountUsdc != null && a.kind !== "ai" ? usdcAmt(a.amountUsdc) : null, a.usd != null && a.kind !== "ai" && a.kind !== "aifee" ? `≈ ${usd2(a.usd)}` : null].filter(Boolean).join(" ");
const Tx = ({ a, label = "tx" }: { a: ActivityItem; label?: string }) => (a.signature ? <a className="agent-tx" href={a.explorer ?? solscanTx(a.signature)} target="_blank" rel="noreferrer" title={`${short(a.signature, 6)} on Solscan`}>{label} ↗</a> : null);

/// The title with its success check glued to the last word, so the check never wraps onto a line of its own.
function Titled({ text }: { text: string }) {
  const i = text.lastIndexOf(" ");
  return <>{i > 0 ? text.slice(0, i + 1) : ""}<span className="agent-nowrap">{i > 0 ? text.slice(i + 1) : text}<Icon kind="check" className="agent-ok" /></span></>;
}
function StatusChip({ e }: { e: DiaryEntry }) {
  const bad = e.items.find((a) => toneOf(a.status) === e.tone);
  return <span className={`chip ${e.tone === "bad" ? "bad" : "warn"} agent-st`}>{statusLabel(bad?.status ?? "")}</span>;
}

function EntryRow({ e, coin, palette, fresh }: { e: DiaryEntry; coin: AgentLaunched | null; palette?: string[] | null; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const head = e.items[e.items.length - 1];
  const title = entryTitle(e);
  const raw = e.type === "single" && humanTitle(head) !== head.title ? rawDetail(head.title) : null;
  return (
    <li className={`agent-entry k-${e.kind} t-${e.tone} ${fresh ? "is-new" : ""}`}>
      <time className="agent-entry-time mono" dateTime={new Date(e.at * 1000).toISOString()} title={when(e.at)}>{clockHM(e.at)}</time>
      <span className="agent-entry-node">
        {e.type === "launch"
          ? (coin ? <ProposalLogo p={coin} palette={palette} size={40} className="agent-entry-logo" /> : <span className="agent-entry-ico big" aria-hidden="true"><Icon kind="launch" /></span>)
          : <span className="agent-entry-ico" aria-hidden="true"><Icon kind={e.kind} /></span>}
      </span>
      <div className="agent-entry-body">
        <p className="agent-entry-title">
          {e.type === "launch" && head.mint
            ? <Link to={`/c/${head.mint}`}>{e.tone === "ok" ? <Titled text={title} /> : title}</Link>
            : <span title={raw ?? undefined}>{e.tone === "ok" ? <Titled text={title} /> : title}</span>}
          {e.tone !== "ok" && <StatusChip e={e} />}
          {e.type === "claims" && <button type="button" className="agent-disclose" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={`${clockHM(e.items[e.items.length - 1].at)}–${clockHM(e.at)}`}>{open ? "hide" : `show ${e.items.length}`}<Icon kind="chev" /></button>}
        </p>
        {e.type === "launch" && (coin?.why ? <p className="agent-entry-why">{coin.why}</p> : null)}
        {e.type === "launch" ? (
          <p className="agent-entry-chain mono">
            {e.steps.length > 0 && <span className="steps">{e.steps.map((s, i) => <span key={i} className={`step t-${toneOf(s.status)}`}>{stepLabel(s)}<i aria-hidden="true">→</i></span>)}</span>}
            <span className="landed"><span className="step">launched {head.amountSol != null ? solShort(head.amountSol) : ""}{head.usd != null ? ` ≈ ${usd2(head.usd)}` : ""}</span>
              {e.items.map((l) => <Tx key={itemTx(l)} a={l} label={e.items.length > 1 ? (l === head ? "tx" : "split tx") : "tx"} />)}</span>
          </p>
        ) : e.type === "claims" ? (
          open && (
            <ul className="agent-entry-sub">
              {e.items.map((a, i) => <li key={i} className="mono"><span>{clockHM(a.at)}</span><span>{humanTitle(a)}</span><Tx a={a} /></li>)}
            </ul>
          )
        ) : (
          (amounts(head) || head.mint || head.signature || raw) && (
            <p className="agent-entry-meta mono">
              {amounts(head) && <span>{amounts(head)}</span>}
              {head.mint && e.kind !== "claim" && <Link to={`/c/${head.mint}`} title={head.mint}>{head.symbol ? `$${head.symbol}` : short(head.mint)}</Link>}
              <Tx a={head} />
              {raw && <button type="button" className="agent-disclose" aria-expanded={open} onClick={() => setOpen((o) => !o)}>details<Icon kind="chev" /></button>}
            </p>
          )
        )}
        {raw && open && <p className="agent-entry-raw mono">{raw}</p>}
      </div>
    </li>
  );
}
const itemTx = (a: ActivityItem) => `${a.at}-${a.signature ?? a.status}`;
