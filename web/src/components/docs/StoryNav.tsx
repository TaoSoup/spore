import { useRef } from "react";
import SlidingPill from "../ui/SlidingPill";
import { useActiveSection, useReadProgress } from "./useActiveSection";

export type StoryItem = readonly [id: string, label: string];

/// The "on this page" rail of the long-form pages (How it works, Fees & rules): serif numerals, the
/// section being read lit, a pill that slides to it. Sticky on desktop; hidden on narrower screens,
/// where the sections simply follow one another. A lime line fills the rail as the article is read.
export default function StoryNav({ items, title }: { items: readonly StoryItem[]; title: string }) {
  const active = useActiveSection(items.map(([id]) => id));
  const bar = useRef<HTMLElement>(null);
  useReadProgress(bar, ".story-main");
  return (
    <aside className="story-nav" aria-label="On this page">
      <span className="label">{title}</span>
      <nav>
        <i ref={bar} className="story-nav-progress" aria-hidden="true" />
        <SlidingPill items="a" />
        {items.map(([id, label], i) => (
          <a key={id} href={`#${id}`} className={active === id ? "on" : undefined} aria-current={active === id ? "location" : undefined}>
            <i className="story-nav-n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</i><span>{label}</span>
          </a>
        ))}
      </nav>
    </aside>
  );
}
