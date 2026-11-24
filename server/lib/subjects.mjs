// Subjects on Discover (GET /api/stories): one subject (a person inside one saga, an event, a franchise, a meme) is
// often split by the narrative tagger over many narratives; on Nov 23 2026 the Jensen Huang return was 35 of them. The
// table (subjects/table.json, made and checked with scripts/subject-replay.mjs, README §Subject replay) names each
// subject's anchor words; a narrative whose title holds one as a whole word belongs to it, and the story cards fold
// the narratives of one subject into one block (lib/stories.mjs). Quiet rows (company and brand names) never fold here:
// they would need the site's share of buyers, which the cards do not compute yet, so their narratives stay as cards.
import { readFileSync } from "node:fs";
import { readTable, words } from "../scripts/subject-replay.mjs";

export const TABLE_URL = new URL("../subjects/table.json", import.meta.url);

/**
 * The subject of a narrative `{ id, title }`, by the table's rules: a subject that `include`s the id (first in the
 * table), else the subjects whose anchor the title holds as a whole word and that do not `exclude` it, a story row before
 * a quiet row, then the longer matched anchor, then table order. Returns `{ key, title, quiet }` or null. `table`: the
 * parsed table.json (checked by readTable, which throws on a bad one).
 */
export function subjectMatcher(table) {
  const subs = readTable(table);
  const memo = new Map(); // `${id}\n${title}` → subject | null (a retitle asks again)
  return (n) => {
    if (!n || !Number.isInteger(n.id) || typeof n.title !== "string") return null;
    const k = `${n.id}\n${n.title}`;
    if (memo.has(k)) return memo.get(k);
    let out = subs.find((s) => s.include.has(n.id)) ?? null;
    if (!out) {
      const ws = new Set(words(n.title));
      let best = null, bestLen = 0;
      for (const s of subs) {
        if (s.exclude.has(n.id)) continue;
        let len = 0;
        for (const a of s.anchors) if (ws.has(a) && a.length > len) len = a.length;
        if (!len) continue;
        if (!best || (best.quiet && !s.quiet) || (best.quiet === s.quiet && len > bestLen)) { best = s; bestLen = len; }
      }
      out = best;
    }
    const v = out ? { key: out.key, title: out.title, quiet: out.quiet } : null;
    if (memo.size > 50_000) memo.clear();
    memo.set(k, v);
    return v;
  };
}

/** The matcher of the table file, or null (logged) when it is missing or bad: the cards then stay as they were. */
export function loadSubjects(url = TABLE_URL, log = console) {
  try { return subjectMatcher(JSON.parse(readFileSync(url, "utf8"))); } catch (e) { log.warn?.(`subjects: table not used: ${e?.message ?? e}`); return null; }
}
