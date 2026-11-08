import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage, type Coin } from "../lib/api";
import { useDebounced } from "../lib/hooks";
import { age, short, usdCard } from "../lib/format";
import { SPORE_COIN } from "../lib/policy";
import { agentProvenance, useAgentIndex, type AgentIndex } from "../lib/agent-index";
import { AgentChip, Logo, nameOf, sym, useTint } from "./Bits";
import "./search.css";

/// `label`: the input's accessible name (the placeholder is not one). `note`: an optional warning chip per row
/// (the launch form marks parents at the depth cap). `md` (48 px) sits between the toolbar box and the hero box.
type Props = { onPick?: (c: Coin) => void; placeholder?: string; size?: "sm" | "md" | "lg"; autoFocus?: boolean; clearOnPick?: boolean; label?: string; note?: (c: Coin) => string | null };

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/// The coin's depth as lineage lines: one hairline per ancestor in that ancestor's colour (root lime, child
/// teal), ending in a node in the coin's own depth colour. A root is a single lime node.
const DepthLine = ({ depth }: { depth: number }) => (
  <span className={`sr-depth d${Math.min(depth, 3)}`} aria-hidden="true">
    {Array.from({ length: Math.min(depth, 3) }, (_, i) => <i key={i} className={`l${i}`} />)}
    <b />
  </span>
);

/// One result: depth lines, the logo in its own colour, name · $TICKER · badges | market cap, lineage · age · mint | 24 h volume.
function Row({ c, i, active, dup, n, index, id, onEnter, onPick }: { c: Coin; i: number; active: boolean; dup: boolean; n: string | null | undefined; index: AgentIndex; id: string; onEnter: () => void; onPick: () => void }) {
  const [tint, onImg] = useTint(c.image, c.mint);
  const official = c.mint === SPORE_COIN;
  return (
    <div id={id} data-i={i} role="option" aria-selected={active} className={`search-row ${active ? "active" : ""} ${official ? "official" : ""}`} style={{ "--tint": tint } as CSSProperties}
      onMouseEnter={onEnter} onMouseDown={(e) => { e.preventDefault(); onPick(); }}>
      <DepthLine depth={c.depth} />
      <Logo src={c.image} label={c.symbol} size={32} className="ring" onLoad={onImg} />
      <span className="sr-l1">
        <b className="sr-name">{nameOf(c)}</b>
        <span className="sr-sym">{sym(c)}</span>
        {official && <span className="chip accent sr-chip" title="The official $SPORE coin"><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m2.5 6.5 2.5 2.5 4.5-6" /></svg>official</span>}
        {c.ours ? <span className="chip sr-chip sr-spore" title="Launched on Spore">Spore</span> : !official && <span className="chip sr-chip sr-pf" title="A pump.fun coin not launched on Spore">pump.fun</span>}
        <AgentChip prov={agentProvenance(c, index)} link={false} />
        {n && <span className="chip warn sr-chip">{n}</span>}
      </span>
      <span className={`sr-mc ${c.mcapUsd === 0 ? "is-zero" : ""}`} title="Market cap">{c.mcapUsd != null ? usdCard(c.mcapUsd) : "—"}</span>
      <span className="sr-l2">
        <span>{c.parent ? `↳ under ${sym(c.parent)}` : c.depth === 0 ? "root" : `d${c.depth}`}</span>
        {c.createdAt != null && <span> · {age(c.createdAt)}</span>}
        <span> · <span className={`sr-mint ${dup ? "dup" : ""}`} title={c.mint}>{short(c.mint, 4)}</span></span>
      </span>
      <span className={`sr-vol ${c.volume24hUsd > 0 ? "" : "is-zero"}`}>{c.volume24hUsd > 0 || c.trades24h > 0 ? `24h vol ${usdCard(c.volume24hUsd)}` : "no trades"}</span>
    </div>
  );
}

/// Typeahead over /api/search: name/ticker prefix or an exact mint. Stale responses are aborted so
/// a fast typist never sees results for an older query. Arrow keys + Enter pick; Esc closes.
/// Rows tell look-alikes apart: the official $SPORE always comes first with a check, Spore launches
/// and plain pump.fun coins are marked, and when two results share a ticker their mints are shown brighter.
export default function Search({ onPick, placeholder = "Search name, ticker or mint", size = "sm", autoFocus = false, clearOnPick = true, label, note }: Props) {
  const nav = useNavigate();
  const index = useAgentIndex();
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 220);
  const [results, setResults] = useState<Coin[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (dq.length < 1) { setResults([]); setError(null); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    api.search(dq, ctl.signal).then((r) => { setResults(r.coins); setError(null); setActive(0); })
      .catch((e) => { if ((e as Error).name !== "AbortError") { setResults([]); setError(errorMessage(e)); } })
      .finally(() => { if (!ctl.signal.aborted) setBusy(false); });
    return () => ctl.abort();
  }, [dq]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // The official coin first, whatever the server's order; tickers that appear more than once.
  const rows = useMemo(() => {
    const official = results.filter((c) => c.mint === SPORE_COIN);
    return official.length ? [...official, ...results.filter((c) => c.mint !== SPORE_COIN)] : results;
  }, [results]);
  const dupes = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of rows) { const k = (c.symbol ?? "").toLowerCase(); if (k) n.set(k, (n.get(k) ?? 0) + 1); }
    return n;
  }, [rows]);
  // keep the highlighted row in view while arrowing through a long list
  useEffect(() => { pop.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  const pick = (c: Coin) => {
    setOpen(false);
    if (clearOnPick) setQ("");
    if (onPick) onPick(c); else nav(`/c/${c.mint}`);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!rows.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % rows.length); setOpen(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + rows.length) % rows.length); setOpen(true); }
    else if (e.key === "Enter") { e.preventDefault(); const c = rows[active]; if (c) pick(c); }
  };
  const showList = open && q.trim().length > 0;
  const optId = (i: number) => `${listId}-o${i}`;
  return (
    <div className={`search ${size}`} ref={box}>
      <svg className="search-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M13.5 13.5 18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      <input className="input" value={q} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} autoComplete="off" enterKeyHint="search" role="combobox" aria-label={label ?? placeholder} aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={showList && rows.length ? optId(active) : undefined}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey} />
      {busy && <span className="search-busy" aria-hidden="true" />}
      {showList && (
        <div className="search-pop" id={listId} role="listbox" ref={pop} aria-label="Matching coins">
          {error ? <div className="search-note" role="status">Search is not answering right now. Try again in a moment.</div>
            : rows.length === 0 ? (busy ? <div className="search-note">Searching…</div> : <div className="search-note">{MINT_RE.test(q.trim()) ? "No pump.fun coin has this mint (or it was created seconds ago — try again)." : `No coin matches “${q.trim()}”.`}</div>)
            : rows.map((c, i) => (
              <Row key={c.mint} c={c} i={i} id={optId(i)} active={i === active} dup={(dupes.get((c.symbol ?? "").toLowerCase()) ?? 0) > 1} n={note?.(c)} index={index}
                onEnter={() => setActive(i)} onPick={() => pick(c)} />
            ))}
          {rows.length > 0 && !error && <div className="search-keys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>}
        </div>
      )}
    </div>
  );
}
