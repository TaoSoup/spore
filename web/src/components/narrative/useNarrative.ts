// The linked posts of one coin (GET /api/narrative/:mint) for the map panel and the coin page. Debounced 150 ms like
// the panel's other reads, so an arrow-key walk does not ask per step. While another coin's answer loads, the previous
// coin's answer stays (`stale`: the block is dimmed, not unmounted, so the panel does not jump twice); the selected
// coin's answer replaces it, and no answer (a 404: not a subject, or a server without the route) removes it. Only the
// selected coin's answer is ever shown: one that arrives for a coin the walk has already left changes nothing on
// screen (lib/narrative.ts shownAnswer). While the server is fetching post texts (`pending`) the hook asks again on a
// short ladder (nextPollMs) and lays each answer over the rows on screen (mergePoll: texts fill in, no row moves; a
// row the server stops listing stops waiting); when the ladder ends, what never came stops waiting (settle). A hidden
// tab does not ask; coming back restarts the ladder.
import { useEffect, useRef, useState } from "react";
import { api, type Narrative } from "../../lib/api";
import { useDebounced } from "../../lib/hooks";
import { mergePoll, nextPollMs, settle, shownAnswer } from "../../lib/narrative";

export function useNarrative(mint: string | null): { data: Narrative | null; stale: boolean } {
  const dm = useDebounced(mint, 150);
  // the last answer, and the mint it answers (a null answer has one too)
  const [got, setGot] = useState<{ mint: string | null; data: Narrative | null }>({ mint: null, data: null });
  useEffect(() => {
    if (!dm) { setGot({ mint: null, data: null }); return; }
    let alive = true, busy = false, tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // this coin's answer as shown
    let cur: Narrative | null = null;
    const hidden = () => typeof document !== "undefined" && document.hidden;
    const show = (n: Narrative | null) => { cur = n; setGot({ mint: dm, data: n }); };
    const ask = () => api.narrative(dm).catch(() => null);
    // the next ask, or the end of the ladder; an ask under way plans when it answers
    const plan = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!alive || busy || !cur?.pending || hidden()) return;
      const ms = nextPollMs(tries);
      if (ms === null) { show(settle(cur)); return; }
      timer = setTimeout(poll, ms);
    };
    const poll = () => {
      timer = null; tries++; busy = true;
      void ask().then((fresh) => {
        busy = false;
        if (!alive) return;
        // a failed ask keeps what is shown and counts as a step
        if (fresh && cur) show(mergePoll(cur, fresh));
        plan();
      });
    };
    busy = true;
    void ask().then((n) => { busy = false; if (!alive) return; show(n); plan(); });
    const onVisible = () => { if (!hidden()) tries = 0; plan(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [dm]);
  // what is on screen: the last answer that was for the coin selected at the time
  const shown = useRef(got);
  shown.current = shownAnswer(shown.current, got, mint);
  return { data: shown.current.data, stale: shown.current.mint !== mint };
}
