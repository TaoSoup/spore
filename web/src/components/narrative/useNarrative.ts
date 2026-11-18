// The launch timeline of one coin (GET /api/narrative/:mint) for the map panel, the coin page and the Discover page.
// Debounced 150 ms like the panel's other reads, so an arrow-key walk does not ask per step. While another coin's
// answer loads, the previous coin's answer stays (`stale`: the block is dimmed, not unmounted, so the panel does not
// jump twice); the selected coin's answer replaces it, and no answer (a 404: not a subject, or a server without the
// route) removes it. Only the selected coin's answer is ever shown: one that arrives for a coin the walk has already
// left changes nothing on screen (lib/narrative.ts shownAnswer). While the server is fetching post texts (`pending`)
// the hook asks again on a short ladder (nextPollMs) and lays each answer over the lines on screen (mergePoll: texts
// fill in, no line moves; a line the server stops listing stops waiting); when the ladder ends, what never came stops
// waiting (settle). A hidden tab does not ask; coming back restarts the ladder.
// `everyMs` (the Discover page's open row): the list is also read again on that interval, so events of coins launched
// meanwhile appear on top (mergeRefresh: a text on screen is never taken away). Off by default: the panel and the
// coin page keep the list they opened with. With it, coming back to the tab reads at once when the list on screen is
// older than one interval (the ticks of a hidden tab are skipped).
// A read that failed (not a 404) is told apart from "no answer": `failed` is set while the first read of a coin has
// not succeeded, so a caller never states "nothing here" from an error; `retry` asks again at once (the block reads
// `stale` meanwhile), and the interval's next read clears it too. The panel and the coin page show nothing either way.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Narrative } from "../../lib/api";
import { useDebounced } from "../../lib/hooks";
import { mergePoll, mergeRefresh, nextPollMs, settle, shownAnswer } from "../../lib/narrative";

/// A read that did not answer (network, 5xx after the retries, timeout): not the same as a 404's "no answer".
const FAILED = Symbol("failed");
type Got = { mint: string | null; data: Narrative | null; failed?: boolean; loading?: boolean };

export function useNarrative(mint: string | null, everyMs = 0): { data: Narrative | null; stale: boolean; failed: boolean; retry: () => void } {
  const dm = useDebounced(mint, 150);
  // the last answer, and the mint it answers (a null answer has one too)
  const [got, setGot] = useState<Got>({ mint: null, data: null });
  // a retry runs the read below again
  const [round, setRound] = useState(0);
  const retry = useCallback(() => { setGot((g) => (g.failed ? { ...g, failed: false, loading: true } : g)); setRound((n) => n + 1); }, []);
  useEffect(() => {
    if (!dm) { setGot({ mint: null, data: null }); return; }
    let alive = true, busy = false, tries = 0;
    // the first read has not succeeded yet; when the last whole read answered
    let failed = false, last = 0;
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
    // the whole list again; a failed read keeps what is shown, and the ladder starts over for the new lines. After a
    // failed first read any answer is taken, a 404's "no answer" too.
    const again = () => {
      if (!alive || busy || hidden()) return;
      if (timer) { clearTimeout(timer); timer = null; }
      busy = true;
      void ask().then((fresh) => {
        busy = false;
        if (!alive) return;
        if (fresh !== FAILED && (fresh || failed)) { tries = 0; failed = false; last = Date.now(); show(fresh ? mergeRefresh(cur, fresh) : null); }
        plan();
      });
    };
    busy = true;
    void ask().then((n) => {
      busy = false;
      if (!alive) return;
      if (n === FAILED) { failed = true; setGot({ mint: dm, data: null, failed: true }); } else { last = Date.now(); show(n); }
      plan();
    });
    const every = everyMs > 0 ? setInterval(again, everyMs) : null;
    // back on the tab: the ladder starts over, and a list older than one interval is read at once
    const onVisible = () => { if (hidden()) return; tries = 0; if (everyMs > 0 && Date.now() - last >= everyMs) again(); else plan(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; if (timer) clearTimeout(timer); if (every) clearInterval(every); document.removeEventListener("visibilitychange", onVisible); };
  }, [dm, everyMs, round]);
  // what is on screen: the last answer that was for the coin selected at the time
  const shown = useRef(got);
  shown.current = shownAnswer(shown.current, got, mint);
  const on = shown.current.mint === mint;
  return { data: shown.current.data, stale: !on || !!shown.current.loading, failed: on && !!shown.current.failed, retry };
}
