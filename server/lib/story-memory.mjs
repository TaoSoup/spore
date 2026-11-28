// Story memory (sticky groups, lib/stories.mjs head 6): what the Discover grouping placed where, so the next build keeps
// it. One per timeframe, held by lib/coinrows.mjs, in memory only: a restart starts it empty and the first build after
// it groups afresh (the cards then are what the grouping alone makes, and are kept from there).
//
// - coins: mint → { key, at, seenAt }: the card key the coin was last placed in, since when (`at`, unix s) and when it
//   was last in a card (`seenAt`). A coin not in any card for UNLISTED_S is forgotten: placed afresh when it returns.
// - cards: key → { firstAt, labelAt, seenAt, head, postId, lead }: when the key first led a card (a merge keeps the
//   older one), when a coin last carried that story's own label (`labelAt`), when the card was last built (`seenAt`),
//   its story as it stands (`head`, lib/stories.mjs headOf: lets the card lead again while no coin carries the label),
//   the post it shows (`postId`) and the coin its header line was taken from (`lead`, lib/coin-lines.mjs headerLine
//   `keep`). A card whose key has carried no label for UNLABELLED_S is forgotten, and its coins with it; so is a card
//   not built for UNLISTED_S.
// Both are bounded (COINS_MAX, CARDS_MAX): the least recently refreshed go first. Pure but for the clock it is given.

/** A coin (or card) not listed for this long (s) is forgotten: it is placed afresh. */
export const UNLISTED_S = 3_600;
/** A card whose story key has carried no label for this long (s) is forgotten, and its coins are placed afresh. */
export const UNLABELLED_S = 6 * 3_600;
/** Coins and cards remembered at most, per timeframe. */
export const COINS_MAX = 5_000, CARDS_MAX = 1_000;

export class StoryMemory {
  constructor({ coinsMax = COINS_MAX, cardsMax = CARDS_MAX } = {}) {
    this.coins = new Map(); // least recently refreshed first
    this.cards = new Map();
    this.coinsMax = coinsMax; this.cardsMax = cardsMax;
  }

  /** What lib/stories.mjs groupStories reads as `sticky` at `nowS`: only what has not run out. */
  view(nowS) {
    this.expire(nowS);
    return {
      keyOf: (mint) => this.coins.get(mint)?.key ?? null,
      cardOf: (key) => { const c = this.cards.get(key); return c ? { at: c.firstAt, head: c.head, postId: c.postId } : null; },
    };
  }

  /** Stores a grouping's placements (groupStories' `placed`, `kept`, `liveKeys` with `sticky` given) made at `nowS`. */
  record(g, nowS) {
    if (!g?.placed) return;
    for (const [key, k] of g.kept) {
      const c = this.cards.get(key);
      const next = c ? { ...c, seenAt: nowS, head: k.head ?? c.head, postId: k.postId ?? null } : { firstAt: nowS, labelAt: nowS, seenAt: nowS, head: k.head, postId: k.postId ?? null, lead: null };
      if (g.liveKeys?.has(key)) next.labelAt = nowS;
      this.cards.delete(key); this.cards.set(key, next);
    }
    for (const [mint, key] of g.placed) {
      const c = this.coins.get(mint);
      this.coins.delete(mint); this.coins.set(mint, { key, at: c?.key === key ? c.at : nowS, seenAt: nowS });
    }
    this.expire(nowS);
  }

  /** The coin the card `key`'s header line was taken from, or null. */
  leadOf(key) { return this.cards.get(key)?.lead ?? null; }
  /** Keeps `mint` as the coin card `key`'s header line comes from (a card not remembered: nothing). */
  setLead(key, mint) { const c = this.cards.get(key); if (c) c.lead = mint ?? null; }

  /** Forgets what ran out at `nowS` (see the head of the file) and trims to the caps. */
  expire(nowS) {
    for (const [key, c] of this.cards) if (nowS - c.labelAt > UNLABELLED_S || nowS - c.seenAt > UNLISTED_S) this.cards.delete(key);
    while (this.cards.size > this.cardsMax) this.cards.delete(this.cards.keys().next().value);
    for (const [mint, c] of this.coins) {
      if (nowS - c.seenAt > UNLISTED_S || !this.cards.has(c.key)) this.coins.delete(mint);
    }
    while (this.coins.size > this.coinsMax) this.coins.delete(this.coins.keys().next().value);
  }

  get size() { return { coins: this.coins.size, cards: this.cards.size }; }
}
