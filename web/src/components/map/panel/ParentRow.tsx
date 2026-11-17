// The side panel's "Priced in $PARENT" row: what the selected coin's pool is paired with, at a glance (a child's
// liquidity is its parent token, so the parent's moves change the child's dollar price and value). The parent's logo,
// ticker, USD price, change and a small 24 h line, from the same feed as the coin page's card (one request per parent
// a minute while shown). Pressing it selects the parent on the map when it is drawn there (a listed asset too, which
// has no record), else opens its coin page once the index is known to track it; otherwise it is plain text.
// The panel passes the parent (SidePanel: from the coin's record, or the parent drawn on the map while that loads),
// so the row stays put while one sibling after another is selected. `compact` (the phone peek): one line, the label
// inline, no 24 h line.
import { Link } from "react-router-dom";
import { signedPct, usd } from "../../../lib/format";
import type { ParentRef } from "../../../lib/priced-in";
import { Logo } from "../../Bits";
import { daySpark, changeWords } from "../../coin/change";
import { plainUsd, useParentReading } from "../../coin/ParentPrice";
import { Sparkline, sparkTone } from "../../coin/viz";

type Props = { parent: ParentRef; loaded: number | null; onMap: (mint: string) => boolean; onPick: (mint: string) => void; compact?: boolean };

export default function ParentRow({ parent: ref, loaded, onMap, onPick, compact = false }: Props) {
  const r = useParentReading(ref, loaded, null);
  const { delta, priceUsd, label, image, pc, tracked } = r;
  const spark = compact ? null : daySpark(r.candles, r.now);
  const tone = sparkTone(delta?.ratio ?? (spark ? spark[spark.length - 1] / spark[0] - 1 : null));
  // a day or more goes without saying (the line is a day; the title has the basis); a parent younger than a day says
  // since when ("5h"), so its change does not read as a 24 h one
  const young = delta != null && delta.short !== "24h" && !delta.short.endsWith("d");
  const chg = delta && (
    <span className={`map-chg ${delta.ratio > 0.0005 ? "up" : delta.ratio < -0.0005 ? "down" : "none"}`} title={delta.title}>
      {signedPct(delta.ratio)}{young && ` · ${delta.short}`}
    </span>
  );
  const body = (
    <>
      <Logo src={image} label={pc?.symbol ?? ref.symbol} size={compact ? 16 : 20} className="map-parent-logo" />
      <span className="map-parent-id">
        <em>priced in</em>
        <span className="map-parent-v"><b className="map-parent-k">{label}</b><span className="mono">{priceUsd != null ? usd(priceUsd) : "—"}</span></span>
      </span>
      {chg}
      {spark && <span className="map-parent-spark" aria-hidden="true"><Sparkline points={spark} tone={tone} w={56} h={22} /></span>}
    </>
  );
  const said = [`Priced in ${label}`, priceUsd != null ? `${label} price ${plainUsd(priceUsd)}` : `${label} price unknown`, changeWords(delta)].filter(Boolean).join(", ");
  const what = `${label}: the token this coin's pool is paired with`;
  const cls = `map-parent${compact ? " compact" : ""}`;
  // drawn on the map: select it (no record needed); tracked: its page; unknown yet or not tracked: plain text
  if (onMap(ref.mint)) return <button type="button" className={cls} onClick={() => onPick(ref.mint)} aria-label={`${said}. Select ${label} on the map`} title={`${what}. Select it on the map`}>{body}</button>;
  if (tracked) return <Link to={`/c/${ref.mint}`} className={cls} aria-label={`${said}. Open ${label}`} title={`${what}. Open its page`}>{body}</Link>;
  return <div className={cls} role="group" aria-label={said} title={what}>{body}</div>;
}
