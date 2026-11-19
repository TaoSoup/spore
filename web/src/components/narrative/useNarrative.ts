// The launch timeline of one coin (GET /api/narrative/:mint) for the coin page.
// Debounced 150 ms, so a quick change of coin does not ask per step. While another coin's answer loads, the previous
// coin's answer stays (`stale`); the coin's answer replaces it, and no answer (a 404: not a subject, or a server
// without the route) removes it. Only the current coin's answer is ever shown: one that arrives for a coin already
// left changes nothing on screen (lib/narrative.ts shownAnswer). While the server is fetching post texts (`pending`)
// the hook asks again on a short ladder (nextPollMs) and lays each answer over the lines on screen (mergePoll: texts
// fill in, no line moves; a line the server stops listing stops waiting); when the ladder ends, what never came stops
// waiting (settle). A hidden tab does not ask; coming back restarts the ladder. The list is the one it opened with.
// A read that failed (not a 404) is told apart from "no answer": `failed` is set while the first read of a coin has
// not succeeded, so a caller never states "nothing here" from an error; `retry` asks again at once (`stale`
// meanwhile). The coin page shows nothing either way.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Narrative } from "../../lib/api";
import { useDebounced } from "../../lib/hooks";
import { mergePoll, nextPollMs, settle, shownAnswer } from "../../lib/narrative";

/// A read that did not answer (network, 5xx after the retries, timeout): not the same as a 404's "no answer".
const FAILED = Symbol("failed");
type Got = { mint: string | null; data: Narrative | null; failed?: boolean; loading?: boolean };

export function useNarrative(mint: string | null): { data: Narrative | null; stale: boolean; failed: boolean; retry: () => void } {
  const dm = useDebounced(mint, 150);
  // the last answer, and the mint it answers (a null answer has one too)
  const [got, setGot] = useState<Got>({ mint: null, data: null });
  // a retry runs the read below again
  const [round, setRound] = useState(0);
  const retry = useCallback(() => { setGot((g) => (g.failed ? { ...g, failed: false, loading: true } : g)); setRound((n) => n + 1); }, []);
  useEffect(() => {
    if (!dm) { setGot({ mint: null, data: null }); return; }
    let alive = true, busy = false, tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // this coin's answer as shown
    let cur: Narrative | null = null;
    const hidden = () => typeof document !== "undefined" && document.hidden;
    const show = (n: Narrative | null) => { cur = n; setGot({ mint: dm, data: n }); };
    const ask = (): Promise<Narrative | null | typeof FAILED> => api.narrative(dm).catch((e) => (e instanceof ApiError && e.status === 404 ? null : FAILED));
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
        if (fresh && fresh !== FAILED && cur) show(mergePoll(cur, fresh));
        plan();
      });
    };
    busy = true;
    void ask().then((n) => {
      busy = false;
      if (!alive) return;
      if (n === FAILED) setGot({ mint: dm, data: null, failed: true }); else show(n);
      plan();
    });
    // back on the tab: the ladder starts over
    const onVisible = () => { if (hidden()) return; tries = 0; plan(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [dm, round]);
  // what is on screen: the last answer that was for the coin selected at the time
  const shown = useRef(got);
  shown.current = shownAnswer(shown.current, got, mint);
  const on = shown.current.mint === mint;
  return { data: shown.current.data, stale: !on || !!shown.current.loading, failed: on && !!shown.current.failed, retry };
}
