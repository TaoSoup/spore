// The one-shot continuation after an unlock: a click on the coin page's trade card (a preset, the custom amount) or on
// its "Launch a child" button that found the trading wallet locked opens the unlock (password) form and remembers what
// was clicked. When the wallet turns unlocked, that one trade or launch goes ahead ONCE, through every check it would
// have met on a click (a fresh quote, the cap, the impact, the cost, Spore's launch confirmation): nothing is reused.
// It is dropped, never fired, when anything about it changed since the click:
//   - more than INTENT_TTL_MS (60 s) passed, or the clock went back;
//   - the coin, the page (path) or the kind (trade / launch) is not the one clicked on;
//   - the trading wallet is not the one that was locked at the click (removed, replaced, another key imported);
//   - its key changed: for a trade the side, the amount (the preset's value, the custom text), the slippage and the
//     sign-at-once cap ("the quote" a click asked for); for a launch every field of the form;
//   - the unlock panel closed without an unlock, the tab was hidden or the page left (the caller calls `drop`).
// Pure (no React, no wallet): a click is the only thing that creates an intent (`remember`), and `take` hands it out
// at most once. Tested in test/pending-intent.test.mts.

/// How long a click waits for its unlock.
export const INTENT_TTL_MS = 60_000;

export type IntentKind = "trade" | "launch";
/// `wallet`: the address of the trading wallet that was locked at the click (the one the unlock was asked for).
export type PendingIntent<T> = { kind: IntentKind; mint: string; page: string; key: string; wallet: string; at: number; payload: T };
/// What is true now, to compare the remembered click with.
/// `wallet`: the trading wallet's address now (null: there is none).
export type IntentNow = { kind: IntentKind; mint: string; page: string; key: string; wallet: string | null; now: number; unlocked: boolean };
/// "none": nothing remembered; "wait": still locked, keep it; "fire": go ahead now (once); "drop": forget it.
export type IntentDecision = "none" | "wait" | "fire" | "drop";

export function intentDecision(i: PendingIntent<unknown> | null, n: IntentNow): IntentDecision {
  if (!i) return "none";
  const age = n.now - i.at;
  if (!(age >= 0) || age > INTENT_TTL_MS) return "drop";
  if (i.kind !== n.kind || i.mint !== n.mint || i.page !== n.page || i.key !== n.key) return "drop";
  if (!i.wallet || i.wallet !== n.wallet) return "drop";
  return n.unlocked ? "fire" : "wait";
}

/// The holder of at most one remembered click per kind. `take` returns `{ payload }` once on "fire" and forgets it (a
/// wrapper, so a null or undefined payload still fires); on "drop" it forgets it and returns null; on "wait" it keeps it.
export class OneShot<T> {
  #i: PendingIntent<T> | null = null;
  get pending(): PendingIntent<T> | null { return this.#i; }
  remember(i: PendingIntent<T>): void { this.#i = i; }
  drop(): void { this.#i = null; }
  take(n: IntentNow): { payload: T } | null {
    const d = intentDecision(this.#i, n);
    if (d === "wait" || d === "none") return null;
    const p = this.#i!.payload;
    this.#i = null;
    return d === "fire" ? { payload: p } : null;
  }
}

/// Which button a trade click was: a preset (by its place) or the custom amount.
export type TradeSource = { kind: "preset"; index: number } | { kind: "custom" };
/// The key of a trade click: its side, what the clicked button trades (the preset's value at that place, or the custom
/// text), and the terms its quote is asked with (slippage, cap). Computed again from the card's state when the wallet
/// unlocks: any difference drops the click.
export function tradeIntentKey(o: { side: "buy" | "sell"; source: TradeSource; presets: readonly number[]; custom: string; slippageBps: number; capSol: number }): string {
  const what = o.source.kind === "preset" ? `p${o.source.index}=${o.presets[o.source.index] ?? "?"}` : `c=${o.custom.trim()}`;
  return `${o.side}|${what}|${o.slippageBps}|${o.capSol}`;
}

/// The key of a launch click: every field the launch is built from (the image by its size and both ends of its data:
/// a different picture changes it).
export function launchIntentKey(o: { name: string; symbol: string; image: string | null; devBuy: string; description: string; website: string; twitter: string; telegram: string }): string {
  const img = o.image ? `${o.image.length}:${o.image.slice(0, 48)}:${o.image.slice(-48)}` : "-";
  return JSON.stringify([o.name.trim(), o.symbol, img, o.devBuy, o.description.trim(), o.website.trim(), o.twitter.trim(), o.telegram.trim()]);
}

/// One launch at a time from a card: taken before anything is awaited (a double click in one render cannot pass twice),
/// held across the unlock wait, the confirmation and the sends, released once the flow ends.
export class InFlightLock {
  #held = false;
  get held(): boolean { return this.#held; }
  /// true: the caller owns the lock now and must `release` it; false: something is already in flight.
  take(): boolean { if (this.#held) return false; this.#held = true; return true; }
  release(): void { this.#held = false; }
}
