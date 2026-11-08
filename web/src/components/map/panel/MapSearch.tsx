// The map's find box (DESIGN §11.5 "Map v2"). Searches the FULL node set (not only the drawn roots) by
// ticker and name, resolves a pasted mint or pump.fun coin URL, and below the local hits asks the API
// for coins that are not on the map yet (with "Open coin" / "Launch under it"). Focused and empty, it
// lists the last picks. ↑/↓/Enter/Esc drive the list; the `.map-search input` selector is what the
// global "/" shortcut focuses. A listed asset's undrawn coins are on the map too (DESIGN-FAMILY-ALL §6): the loaded ones
// come from the family store with the local hits, and a remote hit (or a pasted mint) quoted in an asset drawn as a
// family top is listed under "On the map"; picking it asks the store for that family ("search") and selects the coin.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Coin } from "../../../lib/api";
import { useDebounced } from "../../../lib/hooks";
import { count, usd } from "../../../lib/format";
import type { BubbleNode } from "../../../lib/map/types";
import type { FamilyStore } from "../../../lib/map/family-types";
import { assetTopIn, coinNode, useFamilyVersion } from "../../../lib/map/family";
import { Logo, nameOf, sym } from "../../Bits";

const MAX_LOCAL = 8, MAX_REMOTE = 5, MAX_RECENT = 8;
const RECENT_KEY = "spore.mapRecent";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUMP_URL = /pump\.fun\/(?:[^\s?#]*\/)?coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/i;

/// A mint from a pasted value: a bare base58 address, or a pump.fun …/coin/<mint> link. Null otherwise.
export function extractMint(q: string): string | null {
  const t = q.trim();
  if (BASE58.test(t)) return t;
  const m = PUMP_URL.exec(t);
  return m ? m[1] : null;
}

type Recent = { mint: string; symbol: string | null; name: string | null; image: string | null };
export function readRecent(): Recent[] {
  try { const raw = localStorage.getItem(RECENT_KEY); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v.filter((x) => x && typeof x.mint === "string").slice(0, MAX_RECENT) : []; } catch { return []; }
}
export function pushRecent(n: Pick<BubbleNode, "mint" | "symbol" | "name" | "image">) {
  try {
    const list = [{ mint: n.mint, symbol: n.symbol, name: n.name, image: n.image }, ...readRecent().filter((x) => x.mint !== n.mint)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage blocked: recents are a convenience */ }
}

type Index = { src: BubbleNode[]; sym: string[]; name: string[] };
const score = (s: string, m: string, needle: string) => (s === needle ? 4 : s.startsWith(needle) ? 3 : m.startsWith(needle) ? 2 : s.includes(needle) || m.includes(needle) ? 1 : 0);

type Props = {
  nodes: BubbleNode[]; byMint: Map<string, BubbleNode>;
  /// Selecting a coin on the map (the page widens the roots when it is outside the drawn ones).
  onPick: (n: BubbleNode) => void;
  /// The family loader (lib/map/family.ts): loaded specks join the local hits. Absent = drawn coins only.
  families?: FamilyStore | null;
};

type Option = { kind: "local"; node: BubbleNode } | { kind: "recent"; node: BubbleNode } | { kind: "family"; node: BubbleNode };
type Hit = [BubbleNode, number];
const hitCmp = (a: Hit, b: Hit) => b[1] - a[1] || (b[0].lockedUsd ?? 0) - (a[0].lockedUsd ?? 0) || (b[0].mcapUsd ?? 0) - (a[0].mcapUsd ?? 0);

export default function MapSearch({ nodes, byMint, onPick, families = null }: Props) {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<Recent[]>([]);
  const dq = useDebounced(q, 120);
  const rq = useDebounced(q, 250);
  const index = useRef<Index | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // The node set changes identity on every live event: effects read it through a ref so a burst of
  // events never re-fires a lookup or a remote search for the same query.
  const byMintRef = useRef(byMint); byMintRef.current = byMint;
  const onPickRef = useRef(onPick); onPickRef.current = onPick;
  const familiesRef = useRef(families); familiesRef.current = families;
  // A pick whose family is not loaded: the store wants it ("search") until the coin is in, the family is done or failed,
  // or the next pick; the page's own "select" want holds it from then on.
  const [sought, setSought] = useState<{ mint: string; top: string } | null>(null);
  useEffect(() => {
    if (!families || !sought) return;
    families.want([sought.top], "search");
    const check = () => { const st = families.info(sought.top)?.state; if (families.familyOf(sought.mint) || st === "done" || st === "error") setSought(null); };
    const off = families.subscribe(check);
    check();
    return () => { off(); families.want([], "search"); };
  }, [families, sought]);
  const mintQ = useMemo(() => extractMint(dq), [dq]);
  // A pasted mint or pump.fun link of a coin on the map selects it straight away: read from the raw input (not the
  // debounced query), so the flight starts on the paste itself. The same mint pasted again picks again (the page re-flies).
  const mintNow = useMemo(() => extractMint(q), [q]);
  useEffect(() => {
    if (!mintNow) return;
    const n = byMintRef.current.get(mintNow) ?? familiesRef.current?.node(mintNow) ?? null;
    if (n) { pushRecent(n); onPickRef.current(n); setQ(""); input.current?.blur(); }
  }, [mintNow]);

  // the loaded specks' hits follow pages that land while the box is open with a query (throttled, 300 ms)
  const famV = useFamilyVersion(families, focused && !!q.trim());
  const local = useMemo<BubbleNode[]>(() => {
    const needle = dq.trim().toLowerCase().replace(/^\$/, "");
    if (!needle || mintQ) return [];
    // The lowercase index is rebuilt only when the node list changed since the last search.
    if (!index.current || index.current.src !== nodes) index.current = { src: nodes, sym: nodes.map((n) => (n.symbol ?? "").toLowerCase()), name: nodes.map((n) => (n.name ?? "").toLowerCase()) };
    const ix = index.current;
    const hits: Hit[] = [];
    for (let i = 0; i < ix.src.length; i++) { const sc = score(ix.sym[i], ix.name[i], needle); if (sc > 0) hits.push([ix.src[i], sc]); }
    hits.sort(hitCmp);
    const top = hits.slice(0, MAX_LOCAL);
    // the loaded specks (ticker only), ranked by the same rules; the best 8 of both lists are the best 8 overall
    if (families) {
      const seen = new Set(top.map(([n]) => n.mint));
      for (const n of families.search(needle, MAX_LOCAL)) if (!seen.has(n.mint) && !byMintRef.current.has(n.mint)) top.push([n, score((n.symbol ?? "").toLowerCase(), "", needle)]);
      top.sort(hitCmp);
    }
    return top.slice(0, MAX_LOCAL).map(([n]) => n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq, nodes, mintQ, families, famV]);

  // Remote: what pump.fun has that the map does not (yet). A pasted mint not on the map asks for that mint.
  const [remote, setRemote] = useState<{ q: string; coins: Coin[]; done: boolean } | null>(null);
  useEffect(() => {
    const m = extractMint(rq);
    const term = (m ?? rq).trim();
    if (term.length < 2 || (m && byMintRef.current.has(m))) { setRemote(null); return; }
    const ac = new AbortController();
    setRemote((r) => (r && r.q === term ? r : { q: term, coins: [], done: false }));
    api.search(term, ac.signal).then((res) => { if (!ac.signal.aborted) setRemote({ q: term, coins: res.coins ?? [], done: true }); }).catch(() => { if (!ac.signal.aborted) setRemote({ q: term, coins: [], done: true }); });
    return () => ac.abort();
  }, [rq]);
  // a remote coin quoted in an asset drawn as a family top is on the map (a speck of that family), the rest is not yet
  const familyHits = useMemo(() => {
    if (!families) return [];
    const have = new Set(local.map((n) => n.mint));
    const out: BubbleNode[] = [];
    for (const c of remote?.coins ?? []) {
      if (out.length >= MAX_REMOTE || byMint.has(c.mint) || have.has(c.mint)) continue;
      const top = assetTopIn(byMint, c.quoteMint);
      if (top) out.push(families.node(c.mint) ?? coinNode(c, top.mint));
    }
    return out;
  }, [remote, byMint, local, families]);
  const offMap = useMemo(() => (remote?.coins ?? []).filter((c) => !byMint.has(c.mint) && !(families && assetTopIn(byMint, c.quoteMint))).slice(0, MAX_REMOTE), [remote, byMint, families]);

  const showRecent = focused && !q.trim();
  const recentNodes = useMemo(() => (showRecent ? recent.map((r) => byMint.get(r.mint) ?? families?.node(r.mint) ?? null).filter((n): n is BubbleNode => !!n) : []), [showRecent, recent, byMint, families]);
  const options: Option[] = useMemo(() => (showRecent ? recentNodes.map((node) => ({ kind: "recent" as const, node }))
    : [...local.map((node) => ({ kind: "local" as const, node })), ...familyHits.map((node) => ({ kind: "family" as const, node }))]), [showRecent, recentNodes, local, familyHits]);
  useEffect(() => setActive(0), [options]);

  const pick = (n: BubbleNode) => {
    // a coin the drawn set does not hold: its family is asked for until it is in
    const top = !byMint.has(n.mint) && n.parentMint ? n.parentMint : null;
    if (top && families && !families.familyOf(n.mint)) setSought({ mint: n.mint, top });
    pushRecent(n); onPick(n); setQ(""); setFocused(false); input.current?.blur();
  };
  const pickRef = useRef(pick); pickRef.current = pick;
  // A pasted mint of a coin quoted in an on-map asset resolves like the hit: selected as soon as the lookup names its quote.
  useEffect(() => {
    if (!mintQ || byMintRef.current.has(mintQ) || !familiesRef.current) return;
    const c = remote && remote.q === mintQ ? remote.coins.find((x) => x.mint === mintQ) : undefined;
    const top = c ? assetTopIn(byMintRef.current, c.quoteMint) : null;
    if (c && top) pickRef.current(familiesRef.current.node(c.mint) ?? coinNode(c, top.mint));
  }, [remote, mintQ]);
  // Close on a click outside the box.
  useEffect(() => {
    if (!focused) return;
    const f = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setFocused(false); };
    document.addEventListener("pointerdown", f);
    return () => document.removeEventListener("pointerdown", f);
  }, [focused]);

  const term = q.trim();
  const notOnMap = mintQ && !byMint.has(mintQ) && !familyHits.some((n) => n.mint === mintQ) ? mintQ : null;
  const notOnMapCoin = notOnMap ? (remote?.coins ?? []).find((c) => c.mint === notOnMap) ?? null : null;
  const open = focused && (showRecent ? recentNodes.length > 0 : !!term);

  const row = (n: BubbleNode, i: number) => {
    const parent = n.parentMint ? byMint.get(n.parentMint) ?? null : null;
    const ctx = parent ? `under ${sym(parent)}` : `root · ${count(n.descendants ?? n.children)} coin${(n.descendants ?? n.children) === 1 ? "" : "s"}`;
    return (
      <button type="button" key={n.mint} role="option" id={`map-opt-${i}`} aria-selected={i === active} data-active={i === active} className="map-result" onMouseEnter={() => setActive(i)} onClick={() => pick(n)}>
        <Logo src={n.image} label={n.symbol} size={20} />
        <span className="map-result-main">
          <span className="map-result-top"><b>{nameOf(n)}</b><span className="mono">{sym(n)}</span>{n.ours && <span className="map-badge spore" title="Launched on Spore">spore</span>}{n.migrated && <span className="map-badge grad" title="Graduated to PumpSwap">grad</span>}</span>
          <span className="map-result-ctx">{ctx}</span>
        </span>
        <span className="map-result-mcap mono">{usd(n.mcapUsd)}</span>
      </button>
    );
  };

  return (
    <div className="map-search" role="search" ref={box}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
      <input ref={input} className="input" type="search" placeholder="Find a coin, paste a mint or pump.fun link…" value={q} aria-label="Find a coin on the map" autoComplete="off" spellCheck={false}
        role="combobox" aria-expanded={open} aria-controls="map-results" aria-activedescendant={open && options[active] ? `map-opt-${active}` : undefined}
        onFocus={() => { setFocused(true); setRecent(readRecent()); }}
        // Focus leaving the box (Tab, a click elsewhere) closes the list; clicks inside keep the input focused (mousedown below).
        onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) setFocused(false); }}
        onChange={(e) => { setQ(e.target.value); setFocused(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === "Enter") { const o = options[active]; if (o) { e.preventDefault(); pick(o.node); } }
          else if (e.key === "Escape") { e.stopPropagation(); if (q) setQ(""); else { setFocused(false); input.current?.blur(); } }
        }} />
      {!q && !focused && <kbd className="map-search-kbd" aria-hidden="true">/</kbd>}
      {open && (
        <div className="map-results" id="map-results" role="listbox" aria-label="Search results" onMouseDown={(e) => e.preventDefault()}>
          {showRecent && <><div className="map-results-head">Recent</div>{recentNodes.map((n, i) => row(n, i))}</>}
          {!showRecent && (
            <>
              {notOnMap ? (
                <div className="map-offmap">
                  <div className="map-offmap-title">{notOnMapCoin ? <><Logo src={notOnMapCoin.image} label={notOnMapCoin.symbol} size={20} /><b>{nameOf(notOnMapCoin)}</b><span className="mono">{sym(notOnMapCoin)}</span></> : <span className="mono">{notOnMap.slice(0, 4)}…{notOnMap.slice(-4)}</span>}</div>
                  <p>{remote && !remote.done ? "Looking it up…" : "Not on the map yet"}</p>
                  <div className="map-offmap-acts"><Link to={`/c/${notOnMap}`} className="btn ghost sm">Open coin</Link><Link to={`/launch?parent=${notOnMap}`} className="btn ghost sm">Launch under it</Link></div>
                </div>
              ) : (
                <>
                  <div className="map-results-head">On the map</div>
                  {local.length === 0 && familyHits.length === 0 ? <div className="none">{dq.trim() === term ? "No coin on the map matches." : "Searching…"}</div> : <>{local.map((n, i) => row(n, i))}{familyHits.map((n, i) => row(n, local.length + i))}</>}
                  {offMap.length > 0 && (
                    <>
                      <div className="map-results-head">On pump.fun · not on the map yet</div>
                      {offMap.map((c) => (
                        <div className="map-remote" key={c.mint}>
                          <Logo src={c.image} label={c.symbol} size={20} />
                          <span className="map-result-main"><span className="map-result-top"><b>{nameOf(c)}</b><span className="mono">{sym(c)}</span></span><span className="map-result-ctx">{c.parent ? `under ${sym(c.parent)}` : "root"} · {usd(c.mcapUsd)}</span></span>
                          <span className="map-remote-acts"><Link to={`/c/${c.mint}`}>Open coin</Link><Link to={`/launch?parent=${c.mint}`}>Launch under it</Link></span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
