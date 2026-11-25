// The story gate (Discover: "stories that are drawing real buyers now"), the story half of the Fable spec (local
// research, Nov 24). For each story card, over the last `windowS` (30 min):
//  - counted buyers: distinct wallets with a $minUsd+ buy of the card's coins (copies included) and more bought than sold
//    there, not the coin's creator, and not a spray wallet (bought botCoins+ distinct coins in the held hour);
//  - capped net inflow: the sum over counted buyers of min(net bought in SOL, capSol);
//  - breadth: coins of the card with breadthBuyers+ counted buyers;
//  - same-word launches: the most distinct creators that launched with one of the card's distinctive words in the hour
//    (lib/word-bursts.mjs);
//  - lift: the story's buyers over the last 30 min against its normal, the median 30-min window of the prior 24 h, never
//    below baseFloor (lib/attention.mjs liftOf: both sides from the same 5-minute series, so they compare like with like;
//    a story under 6 h old with no normal is set against the floor, so a new story is not held back: no "new story" gate;
//    with no series state, or an older story whose normal is not known, the lift is unknown and the story does not pass).
// A story passes with minBuyers counted buyers, minLift lift, minInflowSol inflow and (breadthCoins coins or
// minWordCreators same-word creators). Passing stories rank by lift x ln(1 + buyers). Facts only: a pass says many real
// wallets are buying this story's coins far above its normal level now, never that a coin will rise.
// Pure: trades and look-ups in, a Map out; a generator so the caller can slice it (a yield every 1024 trades).

export const STORY_DEFAULTS = Object.freeze({
  windowS: 1800, minUsd: 1, botCoins: 25, capSol: 3,
  minBuyers: 15, minLift: 3, baseFloor: 3, minInflowSol: 10, breadthCoins: 2, breadthBuyers: 5, minWordCreators: 5,
});

/**
 * `cards`: `[{ key, coins: [{ mint, name, symbol, copies? }], narrative? }]`; `trades`: the held trades `{ m, t, b, u, v }`
 * (mint, time s, is buy, wallet, USD value), oldest first, from `from` to `end` (exclusive) in the array; `nowS`;
 * `solUsd`; `creatorOf(mint)`; `liftOf(key)`: `{ last30, base30 }` (base30 null with no normal) or null;
 * `wordsOf(card)`: its distinctive words; `creatorsOf(word)`: distinct creators in the hour. Returns Map key → value.
 */
export function* storyGateGen({ cards, trades, from = 0, end = trades.length, nowS, solUsd, creatorOf = () => null, liftOf = () => null, wordsOf = () => [], creatorsOf = () => 0, cfg = {} }) {
  const c = { ...STORY_DEFAULTS, ...cfg }, cut = nowS - c.windowS, held = nowS - 3600;
  const of = new Map();
  cards.forEach((card, i) => { for (const r of card.coins ?? []) { of.set(r.mint, i); for (const cp of r.copies ?? []) of.set(cp.mint, i); } });
  const spray = new Map(); // wallet → distinct coins bought ($minUsd+) in the held hour
  const per = cards.map(() => ({ w: new Map(), coins: new Map() })); // wallet → { buy, sell, coins: Set }, coin → Set(wallet)
  for (let i = from, n = 0; i < end; i++) {
    if ((++n & 1023) === 0) yield;
    const e = trades[i];
    if (!e || !e.u || e.t <= held) continue;
    if (e.b && e.v >= c.minUsd) { let s = spray.get(e.u); if (!s) spray.set(e.u, s = new Set()); if (s.size < c.botCoins) s.add(e.m); }
    if (e.t <= cut) continue;
    const ci = of.get(e.m);
    if (ci === undefined) continue;
    if (creatorOf(e.m) === e.u) continue;
    const p = per[ci];
    let x = p.w.get(e.u);
    if (!x) p.w.set(e.u, x = { buy: 0, sell: 0, big: false, coins: new Set() });
    if (e.b) { x.buy += e.v; if (e.v >= c.minUsd) { x.big = true; x.coins.add(e.m); } } else x.sell += e.v;
  }
  yield;
  const out = new Map();
  cards.forEach((card, i) => {
    const p = per[i];
    let buyers = 0, inflowUsd = 0;
    const coinBuyers = new Map();
    for (const [u, x] of p.w) {
      if (!x.big || x.buy <= x.sell || (spray.get(u)?.size ?? 0) >= c.botCoins) continue;
      buyers++;
      inflowUsd += solUsd > 0 ? Math.min((x.buy - x.sell) / solUsd, c.capSol) : 0;
      for (const m of x.coins) coinBuyers.set(m, (coinBuyers.get(m) ?? 0) + 1);
    }
    let coins5 = 0;
    for (const v of coinBuyers.values()) if (v >= c.breadthBuyers) coins5++;
    let word = null;
    for (const w of wordsOf(card) ?? []) { const k = creatorsOf(w); if (k > 0 && (!word || k > word.creators)) word = { word: w, creators: k }; }
    // the lift: the series' last 30 minutes against its normal; a story under 6 h old with no normal against the floor;
    // no series state, or an older story whose normal is not known (not computed yet, too few seen windows): unknown
    const L = liftOf(card.key);
    const last30 = L && Number.isFinite(L.last30) ? L.last30 : null;
    const base30 = L && Number.isFinite(L.base30) ? L.base30 : null;
    const known = last30 != null && (base30 != null || L.old === false);
    const lift = known ? Math.round((last30 / Math.max(c.baseFloor, base30 ?? 0)) * 10) / 10 : null;
    const inflowSol = Math.round(inflowUsd * 10) / 10;
    const fails = [
      buyers < c.minBuyers && "buyers", (lift == null || lift < c.minLift) && "lift", inflowSol < c.minInflowSol && "inflow",
      !(coins5 >= c.breadthCoins || (word?.creators ?? 0) >= c.minWordCreators) && "breadth",
    ].filter(Boolean);
    out.set(card.key, { pass: !fails.length, buyers, lift, last30, base30, inflowSol, coins5, word, fails, score: lift == null ? 0 : Math.round(lift * Math.log(1 + buyers) * 100) / 100 });
  });
  return out;
}

/** Runs a generator to its end (tests, and callers that need no slicing). */
export function drainGate(gen) { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; }
