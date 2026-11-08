import type { ReactNode } from "react";
import { FeeArc, type ArcPart } from "./illus/StoryIllus";

export type DialRow = ArcPart & { value: string; who: ReactNode; detail?: ReactNode };

/// The fee arc as an instrument: the 270° dial with its reading in the middle and one ledger line per
/// shareholder beside it (role glyph, share in mono, who, what it pays for). Shares are weights from
/// the policy; the printed values come from lib/copy.ts.
export default function FeeDial({ title, note, read, readSub, rows, size = 240, compact = false }: {
  title: ReactNode; note?: ReactNode; read: ReactNode; readSub: ReactNode; rows: DialRow[]; size?: number; compact?: boolean;
}) {
  return (
    <div className={`story-dial${compact ? " compact" : ""}`}>
      <div className="story-dial-face" role="img" aria-label={`${typeof title === "string" ? `${title}: ` : ""}${rows.map((r) => `${typeof r.who === "string" ? r.who : r.key} ${r.value}`).join(", ")}`}>
        <FeeArc parts={rows} size={size} />
        <div className="story-dial-read" aria-hidden="true"><b className="num-display">{read}</b><span>{readSub}</span></div>
      </div>
      {!compact && (
        <div className="story-dial-legend">
          <div className="story-dial-head"><b>{title}</b>{note && <span>{note}</span>}</div>
          <ul>
            {rows.map((r) => (
              <li key={r.key} className={`tone-${r.tone}`}>
                <i aria-hidden="true" />
                <b className="num-display">{r.value}</b>
                <span>{r.who}{r.detail && <small>{r.detail}</small>}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
