// The Discover story header (Hybrid 1, Nov 25; web/src/lib/discover.ts storyLead, cleanSay, sparkGeo): who and when
// first, then what they said with links cut; a narrative's title as a tag marked as a model's; the sparkline's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoryCard } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");

const NOW = 1_770_000_000;
const post = { id: "1895000000000000001", handle: "TheKindDev", text: "Reddit is honestly responsible\nfor memes https://t.co/abc pic.twitter.com/xyz", at: NOW - 5 * 3600, url: "x" };
const card = (o: Partial<StoryCard>): StoryCard => ({ kind: "post", key: "k", post: null, family: null, buyers5m: 0, coinsN: 2, coins: [], ...o });

test("header lead: a post story leads with its @handle and age, says its own words without links; a narrative's title is a model's tag", () => {
  const p = D.storyLead(card({ post }), NOW);
  assert.deepEqual([p.lead, p.when, p.say, p.quoted, p.tag], ["@TheKindDev", "5 h ago", "Reddit is honestly responsible for memes", true, null]);
  assert.ok(p.href?.includes("1895000000000000001"));
  const n = D.storyLead(card({ kind: "narrative", key: "n:7", post, narrative: { id: 7, title: "reddit", theme: "culture & memes" } }), NOW);
  assert.deepEqual([n.lead, n.tag?.title, n.tag?.auto], ["@TheKindDev", "Reddit", true], "titles are shown capitalized");
  const bare = D.storyLead(card({ kind: "narrative", key: "n:8", narrative: { id: 8, title: "turkey pardon", theme: "news" } }), NOW);
  assert.deepEqual([bare.lead, bare.say, bare.quoted, bare.tag?.auto], [null, "Turkey Pardon", false, true]);
  const fam = D.storyLead(card({ kind: "family", key: "F", family: { mint: "F", symbol: "FAM", image: null, startedAt: NOW - 720 } }), NOW);
  assert.deepEqual([fam.lead, fam.say], ["$FAM family", null]);
  assert.equal(D.cleanSay("  https://x.com/a  "), null);
  assert.deepEqual(D.storyLead(null, NOW), { lead: null, href: null, when: "", say: null, quoted: false, tag: null });
});

test("header sparkline: scaled to its own peak; nothing for no series or no buyer", () => {
  const g = D.sparkGeo([0, 5, 10], 100, 30)!;
  assert.equal(g.peak, 10);
  assert.ok(g.line.startsWith("M0.0 29.0") && g.line.endsWith("L100.0 2.0"));
  assert.ok(g.area.endsWith("L100 30L0 30Z"));
  assert.equal(D.sparkGeo([0, 0, 0], 100, 30), null);
  assert.equal(D.sparkGeo(null, 100, 30), null);
  assert.equal(D.sparkGeo([3], 100, 30), null);
});
