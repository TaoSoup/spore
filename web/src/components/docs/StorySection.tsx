import type { ReactNode } from "react";
import Reveal from "../ui/Reveal";
import SectionHead from "../ui/SectionHead";

/// One chapter of a long-form page: the hairline head with its serif numeral, then the reading
/// column and (when there is one) its drawing in a figure beside it, under it on narrow screens.
export default function StorySection({ id, n, title, lede, art, caption, wide = false, className = "", children }: {
  id: string; n: string; title: ReactNode; lede?: ReactNode; art?: ReactNode; caption?: ReactNode; wide?: boolean; className?: string; children: ReactNode;
}) {
  return (
    <Reveal as="section" id={id} className={`story-sec ${className}`.trim()} aria-labelledby={`${id}-h`}>
      <SectionHead n={n} title={title} lede={lede} id={`${id}-h`} />
      <div className={`story-sec-body${art ? " has-art" : ""}${wide ? " wide" : ""}`}>
        <div className="story-prose">{children}</div>
        {art && <figure className="story-fig">{art}{caption && <figcaption>{caption}</figcaption>}</figure>}
      </div>
    </Reveal>
  );
}
