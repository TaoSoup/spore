// The family strip under the coin's name: for a parent, the first five children as a stack of logos
// plus "10 children · 12 in tree" (a press opens the Children tab); for a child with nothing under
// it yet, where it hangs ("under $PARENT · root $ROOT").
import { Link } from "react-router-dom";
import type { Coin } from "../../lib/api";
import { count, plural } from "../../lib/format";
import { Logo, sym } from "../Bits";
import { useLive, type LiveCoin } from "./useLiveCoin";

export default function FamilyStrip({ store, onChildren, showLineage = true }: { store: LiveCoin; onChildren: () => void; showLineage?: boolean }) {
  // Only the counts and the first faces move (a new child); a trade never re-renders the strip.
  const coin = store.coin();
  const nKids = useLive(store, (s) => s.coin.children);
  const nDesc = useLive(store, (s) => s.coin.descendants);
  const children = useLive(store, (s) => s.children);
  if (nKids > 0) {
    const faces = children.slice(0, 5);
    return (
      <button type="button" className="family-strip" onClick={onChildren} title={`See the ${plural(nKids, "coin")} growing under ${sym(coin)}`}>
        <span className="faces" aria-hidden="true">{faces.map((c) => <Logo key={c.mint} src={c.image} label={c.symbol} size={24} />)}</span>
        <span><b className="mono">{count(nKids)}</b> {nKids === 1 ? "child" : "children"}<span className="fam-tree"> · <b className="mono">{count(nDesc)}</b> in tree</span></span>
      </button>
    );
  }
  return showLineage ? <Lineage coin={coin} /> : null;
}

function Lineage({ coin }: { coin: Coin }) {
  const parent = coin.parent ?? coin.ancestors[0] ?? null;
  const root = coin.root ?? coin.ancestors[coin.ancestors.length - 1] ?? null;
  if (!parent) return null;
  return (
    <span className="family-strip lineage">
      <span>under <Link to={`/c/${parent.mint}`}>{sym(parent)}</Link></span>
      {root && root.mint !== parent.mint && <span>root <Link to={`/c/${root.mint}`}>{sym(root)}</Link></span>}
    </span>
  );
}
