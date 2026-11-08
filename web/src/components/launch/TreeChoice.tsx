// Step 1 of the launch form, "Where your coin grows": a two-tile radiogroup (a new tree priced in
// SOL, or a coin under an existing one), then, for the second, the parent search and a row of
// popular parents. Once a parent is set its tile becomes the parent's mini-card. The `?parent=`
// URL stays the source of truth; the page owns it and this component only asks to change it.
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type Coin } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { usdCard, plural } from "../../lib/format";
import { AGENT_SEED_SOL, CHILD_SPLIT_YOU, ROOT_SPLIT_YOU } from "../../lib/copy";
import Search from "../Search";
import Term from "../Term";
import { DepthBadge, ErrorBox, Logo, Skeleton, sym } from "../Bits";
import { TileArt } from "./art";

export type Tree = "root" | "child";
type Props = {
  tree: Tree; parent: Coin | null; parentLoading: boolean; parentError: string | null; reloadParent: () => void;
  /// "root" drops the parent; "child" opens the parent search (the form below is kept either way).
  onChoose: (t: Tree) => void; onPickParent: (c: Coin) => void;
  /// true while the search is open over a chosen parent ("Change").
  picking: boolean; setPicking: (v: boolean) => void;
  maxDepth: number | null; locked: boolean; agentPaused: boolean;
};

const Check = () => <span className="tile-check" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>;
const Dot = ({ tone = "" }: { tone?: string }) => <i className={`tile-dot ${tone}`} aria-hidden="true" />;

export default function TreeChoice({ tree, parent, parentLoading, parentError, reloadParent, onChoose, onPickParent, picking, setPicking, maxDepth, locked, agentPaused }: Props) {
  const tiles = useRef<(HTMLDivElement | null)[]>([]);
  const uid = useId();
  // The search takes focus only when the visitor chose the second tile on purpose (click / Enter),
  // never while arrowing through the radiogroup.
  const [focusSearch, setFocusSearch] = useState(false);
  const child = tree === "child";
  const searching = child && (!parent || picking);
  const popular = useAsync(() => (searching ? api.roots("children", 6).then((r) => r.roots) : Promise.resolve<Coin[] | null>(null)), [searching]);

  const choose = (t: Tree, viaKeys = false) => {
    if (locked) return;
    setFocusSearch(t === "child" && !viaKeys);
    if (t !== tree) onChoose(t);
    else if (t === "child" && parent && !viaKeys) setPicking(true);
  };
  const onKey = (ev: KeyboardEvent<HTMLDivElement>, t: Tree) => {
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(ev.key)) {
      ev.preventDefault();
      const next: Tree = t === "root" ? "child" : "root";
      choose(next, true);
      tiles.current[next === "root" ? 0 : 1]?.focus();
    } else if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); choose(t); }
  };
  // Each tile is named by its title line and described by the rest (the facts or the parent card).
  const tile = (t: Tree, i: number, body: ReactNode, label: string) => {
    const on = tree === t;
    return (
      <div ref={(el) => { tiles.current[i] = el; }} role="radio" aria-checked={on} aria-disabled={locked || undefined} aria-labelledby={`${uid}-${t}-name`} aria-describedby={`${uid}-${t}-body`} tabIndex={on ? 0 : -1}
        className={`tree-tile ${t} ${on ? "on" : ""}`} onClick={() => choose(t)} onKeyDown={(ev) => onKey(ev, t)}>
        <span id={`${uid}-${t}-name`} className="sr-only">{label}</span>
        {on && <Check />}
        <div className="tile-stage" aria-hidden="true"><TileArt kind={t} /></div>
        <div id={`${uid}-${t}-body`} className="tile-body">{body}</div>
      </div>
    );
  };

  return (
    <div className="tree-choice">
      <div className="tree-tiles" role="radiogroup" aria-label="Where your coin grows">
        {tile("root", 0, <>
          <div className="tile-head"><b>New tree</b><DepthBadge depth={0} title="a new tree's first coin sits at depth 0" /></div>
          <ul className="tile-facts">
            <li><Dot tone="sol" /><span>Priced in SOL</span></li>
            <li className={agentPaused ? "paused" : "agent"}><Dot tone="agent" /><span>{agentPaused ? "Its AI agent: paused for a moment" : "Gets its own AI agent"}</span></li>
            <li><Dot /><span>Fees: <span className="tile-split">{ROOT_SPLIT_YOU}</span></span></li>
            <li><Dot /><span>Costs network rent + {AGENT_SEED_SOL} SOL agent gas</span></li>
          </ul>
        </>, "New tree: priced in SOL, gets its own AI agent")}
        {tile("child", 1, child && parent && !picking ? (
          <>
            <div className="tile-head"><b>Grow an existing tree</b></div>
            <div className="parent-mini">
              <Logo src={parent.image} label={parent.symbol} size={40} className="ring" />
              <div className="parent-mini-text">
                <span className="parent-mini-name"><span className="tile-kicker">under</span><b className="mono">{sym(parent)}</b></span>
                <span className="parent-mini-facts"><span>MC <b className="mono">{usdCard(parent.mcapUsd)}</b></span><span><b className="mono">{plural(parent.children, "child", "children")}</b></span></span>
                <span className="parent-mini-depth">your coin: depth {parent.depth + 1}</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="tile-head"><b>Grow an existing tree</b>{child && parentLoading && <Skeleton w={60} h={18} r={9} />}</div>
            <ul className="tile-facts">
              <li><Dot tone="parent" /><span>Priced in a parent coin</span></li>
              <li><Dot /><span>Every buy of your coin buys the parent</span></li>
              <li><Dot /><span>Fees: <span className="tile-split">{CHILD_SPLIT_YOU}</span></span></li>
              <li><Dot tone="none" /><span>No agent</span></li>
            </ul>
          </>
        ), parent && child ? `Grow an existing tree: under ${sym(parent)}` : "Grow an existing tree: priced in a parent coin")}
      </div>

      <p className="tree-terms">Every coin is <Term k="quote">priced in</Term> something: a new tree in SOL, a coin you grow under a parent in that parent. <Term k="depth" vars={{ maxDepth }}>Depth</Term> counts the steps down from the root.</p>

      {child && parent && !picking && (
        <div className="tree-parent-actions">
          {!locked && <button type="button" className="btn sm ghost" onClick={() => { setFocusSearch(true); setPicking(true); }}>Change parent</button>}
          <Link to={`/c/${parent.mint}`} className="tree-link">{sym(parent)} coin page →</Link>
        </div>
      )}
      {child && parentError && !parent && !parentLoading && <ErrorBox error={parentError} retry={reloadParent} compact />}

      {searching && !locked && (
        <div className="tree-search">
          <div className="tree-search-row">
            <Search size="md" label="Parent coin" placeholder="Parent coin: ticker, name or mint" autoFocus={focusSearch} note={(c) => (maxDepth != null && c.depth >= maxDepth ? "depth cap" : null)} onPick={(c) => { setPicking(false); onPickParent(c); }} />
            {parent && <button type="button" className="btn ghost" onClick={() => setPicking(false)}>Cancel</button>}
          </div>
          <div className="popular" aria-label="Popular parents">
            <span className="popular-label">Popular parents</span>
            <div className="popular-row">
              {popular.loading && !popular.data ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} w={132} h={40} r={20} />)
                : popular.error && !popular.data ? <span className="muted popular-note">Could not load popular parents. Search by name, ticker or mint instead.</span>
                : (popular.data ?? []).length === 0 ? <span className="muted popular-note">No trees on Spore yet. Search any pump.fun coin.</span>
                : (popular.data ?? []).map((c) => (
                  <button key={c.mint} type="button" className="parent-chip" onClick={() => { setPicking(false); onPickParent(c); }}>
                    <Logo src={c.image} label={c.symbol} size={24} />
                    <b className="mono">{sym(c)}</b>
                    <span>{plural(c.children, "child", "children")}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
