// Same-word launch bursts (the story gate's "launches" trigger, lib/story-gate.mjs): every pump.fun launch the live
// stream delivers (the indexer's onCreate sees them all, the plain SOL ones it drops included) is split into the
// distinctive words of its name and symbol, and each word keeps the distinct creators that launched with it in the last
// hour. A word launched by 5+ different creators within the hour is bursting: copycat waves that follow a story.
// The words are the story groups' own (scripts/story-groups.mjs anchorOk over scripts/subject-replay.mjs words(): ASCII
// words of 3+ letters, not a standing word like "trump" or "pepe", not a generic one like "coin", not a number), so a
// burst names the same words the automatic groups use. Distinct creators are not distinct people (launch farms use
// many wallets): a burst is a count of launches, never a judgement. Memory only; a restart starts it empty.
import { words } from "../scripts/subject-replay.mjs";
import { anchorOk } from "../scripts/story-groups.mjs";

export const BURST_DEFAULTS = Object.freeze({ windowS: 3600, minCreators: 5, maxWords: 50_000 });

/** The distinctive words of a launch's name and symbol (de-duplicated). */
export function launchWords(name, symbol) {
  const out = new Set();
  for (const w of words(`${name ?? ""} ${symbol ?? ""}`)) if (anchorOk(w)) out.add(w);
  return [...out];
}

export class WordBursts {
  constructor({ cfg = {}, now = Date.now } = {}) {
    this.cfg = { ...BURST_DEFAULTS, ...cfg };
    this.now = now;
    this.byWord = new Map(); // word → Map(creator → last launch time, s)
    this.stats = { launches: 0, words: 0 };
  }
  /** One launch (a decoded CreateEvent: name, symbol, creator, timestamp). */
  add(e) {
    if (!e?.creator) return;
    const t = Number(e.timestamp) || Math.floor(this.now() / 1000);
    this.stats.launches++;
    for (const w of launchWords(e.name, e.symbol)) {
      let m = this.byWord.get(w);
      if (!m) {
        if (this.byWord.size >= this.cfg.maxWords) continue;
        this.byWord.set(w, m = new Map());
      }
      m.delete(e.creator); m.set(e.creator, t); // oldest first
      this.stats.words++;
    }
  }
  /** Distinct creators of `word` in the window ending now. */
  creators(word, nowS = Math.floor(this.now() / 1000)) {
    const m = this.byWord.get(word);
    if (!m) return 0;
    let n = 0;
    for (const t of m.values()) if (t > nowS - this.cfg.windowS) n++;
    return n;
  }
  /** The bursting words now, most creators first: `[{ word, creators }]`. */
  bursts(nowS = Math.floor(this.now() / 1000)) {
    const out = [];
    for (const w of this.byWord.keys()) { const n = this.creators(w, nowS); if (n >= this.cfg.minCreators) out.push({ word: w, creators: n }); }
    return out.sort((a, b) => b.creators - a.creators || (a.word < b.word ? -1 : 1));
  }
  /** Lets go of launches past the window, and words left empty; call every minute or so. */
  sweep(nowS = Math.floor(this.now() / 1000)) {
    const cut = nowS - this.cfg.windowS;
    for (const [w, m] of this.byWord) {
      for (const [c, t] of m) { if (t > cut) break; m.delete(c); }
      if (!m.size) this.byWord.delete(w);
    }
  }
  snapshot(nowS) { const b = this.bursts(nowS); return { ...this.stats, tracked: this.byWord.size, bursting: b.length, top: b.slice(0, 5) }; }
}
