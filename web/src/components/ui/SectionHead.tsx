// <SectionHead>: the editorial head of a section (DESIGN-ELEVATE §3). A 1 px --rule hairline above,
// a serif numeral ("01") in --faint, the title at --fs-2xl, a one-line lede and an optional action on
// the right. On phones the action drops under the lede.
import type { ReactNode } from "react";
import "./ui.css";

type Props = {
  /** Section numeral, e.g. "01". Optional. */
  n?: string;
  /** The heading (an h2). May contain <em> for the one serif accent word. */
  title: ReactNode;
  /** One sentence under the title (max ~48 ch). */
  lede?: ReactNode;
  /** Right-side action: a link or a button. */
  action?: ReactNode;
  /** id of the h2, for aria-labelledby on the section and in-page links. */
  id?: string;
  /** Heading level (default 2). */
  level?: 2 | 3;
  className?: string;
};

export default function SectionHead({ n, title, lede, action, id, level = 2, className = "" }: Props) {
  const H = level === 3 ? "h3" : "h2";
  return (
    <header className={`shead ${className}`.trim()}>
      {n && <i className="numeral" aria-hidden="true">{n}</i>}
      <div className="shead-text">
        <H id={id} className="shead-title">{title}</H>
        {lede && <p className="shead-lede">{lede}</p>}
      </div>
      {action && <div className="shead-action">{action}</div>}
    </header>
  );
}
