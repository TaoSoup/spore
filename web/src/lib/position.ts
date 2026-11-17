// "Your position" on the coin page (components/coin/YourPosition.tsx): what the wallet the header shows holds of the
// coin (from the balance store, lib/balances.ts), its value at the live price, and, from /api/pnl/:wallet joined
// exactly as the Portfolio page joins it (lib/pnl.ts buildPnl), the average buy, the cost and the P&L of this coin.
// Nothing is invented: a figure that is not known is null and the card shows "—" with the reason.
// Pure: no React, no DOM, no fetches, so it runs under node:test (test/position.test.mts). Nothing here returns NaN
// or Infinity.
import type { Pnl } from "./api";
import { buildPnl, DUST_USD, historyLine, pnlAvailable, type PnlRow } from "./pnl";

/// After a landing of the wallet the P&L is asked again at these delays (ms) until the answer has caught up with the
/// trade (pnlCaughtUp); the answer after the last one is taken as it is. The first is the Portfolio's TRADE_SETTLE_MS:
/// a trade's P&L reaches the indexer a few seconds after it lands.
export const LANDING_RELOADS_MS = [4_000, 10_000, 20_000] as const;
/// "Updating after your trade…" ends at the latest this long after the last of those reloads (an answer that never
/// comes, a failed read): the figures are then joined with what the last answer says.
export const SETTLE_GIVE_UP_MS = 15_000;
/// A settle that ended without its answer catching up with a trade that changed this coin's balance (the trade is behind
/// a cut log, which the server catches up at most once a minute per wallet and only on a request, pnl-tracker
/// PNL_CUT_CHECK_MS, or it was indexed late) leaves the figures "behind": marked, and asked again at these delays (ms)
/// after the landing, past that minute, until an answer catches up with the one before the trade (settleBehind,
/// pnlCaughtUp).
export const BEHIND_RELOADS_MS = [65_000, 125_000] as const;
/// How often the P&L is asked again while the server still reads the wallet's history (as the Portfolio page).
export const POSITION_POLL_MS = 5_000;
/// A tab that comes back after the last answer is older than this asks again.
export const POSITION_REVISIT_MS = 60_000;

export const POSITION_UPDATING = "Updating after your trade…";
export const POSITION_FAILED = "P&L could not be read just now.";
export const POSITION_BEHIND = "Your latest trade is not counted yet.";
export const closedNote = (label: string) => `You no longer hold ${label}.`;

const fin = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
const pow10 = (d: number) => 10 ** (Number.isInteger(d) && d >= 0 && d <= 30 ? d : 0);

export type PositionOwner = { address: string; kind: "trading" | "wallet"; locked: boolean };
/// The wallet the header pill shows (WalletMenu.tsx): the trader, else a locked trading wallet (its address is public
/// while locked), else none.
export function positionOwner(o: { traderKind: "trading" | "wallet" | null; traderAddress: string | null; twStatus: "none" | "locked" | "unlocked"; twAddress: string | null }): PositionOwner | null {
  if (o.traderKind && o.traderAddress) return { address: o.traderAddress, kind: o.traderKind, locked: false };
  if (o.twStatus === "locked" && o.twAddress) return { address: o.twAddress, kind: "trading", locked: true };
  return null;
}
/// The card's wallet tag: a name only, never an address.
export const walletLabel = (owner: PositionOwner | null, walletName: string | null): string =>
  !owner ? "" : owner.kind === "trading" ? (owner.locked ? "Trading wallet · locked" : "Trading wallet") : walletName || "Connected wallet";

/// none: no card (no wallet, the balance not read yet, or never ≥ DUST_USD during the visit and not now either);
/// held: the wallet holds the coin (≥ DUST_USD, or the coin has no USD price; once held during the visit it stays held
/// while anything is left, so the card does not flicker around the limit); closed: held during the visit, now 0.
export type PositionMode = "none" | "held" | "closed";
/// `wasHeld`: this visit (same owner and coin) already showed `held`. `balance` null: not known (never read as 0).
export function positionMode(o: { balance: bigint | null; valueUsd: number | null; priced: boolean; wasHeld: boolean; dustUsd?: number }): PositionMode {
  if (o.balance === null) return "none";
  if (o.balance <= 0n) return o.wasHeld ? "closed" : "none";
  const v = fin(o.valueUsd);
  // a coin without a USD price (or a value that could not be worked out) cannot be told to be dust: shown
  if (!o.priced || v === null || v >= (o.dustUsd ?? DUST_USD) || o.wasHeld) return "held";
  return "none";
}

/// The answer narrowed to one coin (same shape; `coins` holds 0 or 1 entry), so a price tick joins one coin only.
export function pnlForMint(pnl: Pnl | null, mint: string): Pnl | null {
  if (!pnl) return null;
  const c = (pnl.coins ?? []).find((x) => x.mint === mint);
  return { ...pnl, coins: c ? [c] : [] };
}

/// True when `after` reflects a trade of this coin that `before` did not: more buys and sells, or another `heldBase`
/// (a coin absent from an answer before and present after counts). Without an answer on either side nothing is known
/// to have caught up: an answer with no earlier one to compare with may still be from before the trade. `n` > 1: that
/// many trades of this coin are missing from `before`, so only buys and sells grown by `n` count (an answer that moved
/// may hold some of them only).
export function pnlCaughtUp(before: Pnl | null, after: Pnl | null, mint: string, n = 1): boolean {
  if (!after || !before) return false;
  const a = (after.coins ?? []).find((x) => x.mint === mint);
  if (!a) return false;
  const b = (before.coins ?? []).find((x) => x.mint === mint);
  const count = (c: typeof a | undefined) => (c ? (fin(c.buys) ?? 0) + (fin(c.sells) ?? 0) : 0);
  if (count(a) - count(b) >= n) return true;
  return n <= 1 && (!b || a.heldBase !== b.heldBase);
}
/// True when the answer's holding of the coin from its trades (`heldBase`) is exactly `token`, the balance read now.
const heldIs = (after: Pnl, mint: string, token: bigint): boolean => {
  const a = (after.coins ?? []).find((x) => x.mint === mint);
  return !!a && a.heldBase === token.toString();
};

/// A landing heard and not caught up yet (usePosition): the answer compared with (null: none yet), the balance the
/// figures were joined with before it, how many of its reloads have gone out, the number of the first P&L request sent
/// at or after its first reload (Infinity until then; requests are numbered as they are sent), whether it replaced
/// another landing's settle or began while the figures were behind (two trades close together), whether `before` is an
/// answer held when the landing was heard (`pre`; an answer taken later as the baseline may already count the trade, so
/// it never marks the figures behind), and how many earlier trades of this coin `before` is known not to count (`lag`:
/// the settle began while the figures were behind, from that behind answer). `landings`: the landings heard in it;
/// `moves`: how often this coin's balance read changed during it (settleSaw), from `base` to the last seen (`seen`).
export type Settle = { before: Pnl | null; base: bigint | null; fired: number; from: number; multi: boolean; pre: boolean; lag: number; landings: number; moves: number; seen: bigint | null };
/// The figures left behind by a settle: the answer to compare later ones with and how many trades of this coin it lacks.
export type Behind = { ans: Pnl; n: number };
/// The settle a landing of the wallet starts (usePosition): `prev` the settle running (null: none), `behind` the
/// figures left behind by an earlier one, `latest` the answer now, `base` the balance the figures were joined with.
/// A landing while one is settling keeps that one's answer and balance (its change still counts) and waits for the
/// newest: the last reload decides (an answer that moved may hold the first trade only). A landing while the figures
/// are behind does the same from the behind answer: an answer that catches up with the earlier trade only must not end
/// it. With no answer yet the one taken later as the baseline may already count the trade (`pre` false). `base` is the
/// balance as the landing is heard (before the store's read at its slot), never one kept from an earlier answer: a
/// change before the landing (a transfer, a read that came late) is not this landing's trade.
export function landingSettle(prev: Settle | null, behind: Behind | null, latest: Pnl | null, base: bigint | null): Settle {
  if (prev) return { ...prev, fired: 0, from: Infinity, multi: true, landings: prev.landings + 1 };
  const fresh = { base, fired: 0, from: Infinity, landings: 1, moves: 0, seen: base };
  if (behind) return { ...fresh, before: behind.ans, multi: true, pre: true, lag: behind.n };
  return { ...fresh, before: latest, multi: false, pre: !!latest, lag: 0 };
}
/// Settle `s` saw this coin's balance read as `token` (usePosition, on every change while it runs): a change from the
/// last one seen is one more move.
export function settleSaw(s: Settle, token: bigint | null): void {
  if (token === null || token === s.seen) return;
  s.moves++; s.seen = token;
}
/// How many trades of this coin settle `s` holds, with `token` the balance now: its balance's moves (a move to `token`
/// not seen yet included; a buy then a sell are two, also when they bring the balance back to where it was), at most
/// one per landing heard (another coin's landing moves nothing; a read that changed twice in one landing is one trade).
export function settleTrades(s: Settle, token: bigint | null): number {
  return Math.min(s.landings, s.moves + (token !== null && token !== s.seen ? 1 : 0));
}
/// What the answer to request number `seq` does to settle `s`. "baseline": it was asked before the landing's first
/// reload, so it may not hold the trade yet (the indexer needs a few seconds), or there is nothing to compare it with:
/// it never ends the settle, and becomes the answer compared with when there was none. "end": an answer after the last
/// reload, or one that caught up with a single landing. "wait": not yet. After two landings an answer that moved may
/// hold the first trade only, so only the last reload ends it (or the give-up after it). With no answer from before a
/// single landing (`pre` false) an answer whose holding of the coin is the balance now (`token`, moved since the
/// landing) counts the trade and ends it, whenever it was asked: it would never move again to "catch up".
export function settleStep(s: Settle, after: Pnl, seq: number, mint: string, token: bigint | null = null): "baseline" | "wait" | "end" {
  if (seq >= s.from && s.fired >= LANDING_RELOADS_MS.length) return "end";
  if (!s.pre && !s.multi && token !== null && token !== s.base && heldIs(after, mint, token)) return "end";
  if (seq < s.from || !s.before) return "baseline";
  if (s.multi) return "wait";
  return pnlCaughtUp(s.before, after, mint) ? "end" : "wait";
}
/// Whether settle `s`, ending now with `latest` the last answer and `token` this coin's balance, leaves the figures
/// behind: the balance moved during the settle (trades of this coin, not another's: settleTrades, every one counted,
/// so an answer holding the first of two does not clear it) or the settle began behind, and the answer still has not
/// caught up with the one before those trades. Only an answer held when the landing was heard (`pre`) is known to be
/// from before the trade. Returns what to compare later answers with, or null (nothing to compare with: not marked).
export function settleBehind(s: Settle, latest: Pnl | null, token: bigint | null, mint: string): Behind | null {
  const n = s.lag + settleTrades(s, token);
  return n > 0 && s.pre && s.before && !pnlCaughtUp(s.before, latest, mint, n) ? { ans: s.before, n } : null;
}

/// One visit's card state (one wallet, one coin): held during it, the settle running, the last answer, the figures
/// left behind, when it was answered. Kept outside the component (usePosition): the phone and desktop layouts mount the
/// card at different places on the page, so crossing the breakpoint (a tablet turned, a window resized) mounts a new
/// one, which takes the visit over instead of starting again (a closed position would vanish, a settle be lost).
export type Visit = {
  key: string; held: { current: boolean }; settle: { current: Settle | null }; latest: { current: Pnl | null };
  behind: { current: Behind | null }; answeredAt: { current: number }; mounts: number; leftAt: number;
};
/// A card mounted this soon after the visit's last one left (or after it began) takes it over; later, a visit starts
/// over (the page left and came back). The breakpoint's remount happens within one commit.
export const VISIT_HANDOFF_MS = 2_000;
let visitNow: Visit | null = null;
/// The visit of `key` (`${owner}:${mint}`): the one held when it is still mounted or just left, else a new one (a new
/// wallet or coin, A → B → A, or a page visited again, starts over).
export function visitFor(key: string, nowMs: number): Visit {
  const v = visitNow;
  if (v && v.key === key && (v.mounts > 0 || nowMs - v.leftAt < VISIT_HANDOFF_MS)) return v;
  return visitNow = { key, held: { current: false }, settle: { current: null }, latest: { current: null }, behind: { current: null }, answeredAt: { current: 0 }, mounts: 0, leftAt: nowMs };
}
/// A card showing visit `v` mounted; the returned function is its unmount (at `nowMs`).
export function visitMount(v: Visit): (nowMs: number) => void {
  v.mounts++;
  return (nowMs) => { v.mounts--; v.leftAt = nowMs; };
}

/// Where the P&L read stands: no answer yet, failed with no answer, answered without P&L (history off, the server full,
/// its store failed), a trade of this coin landed and the answer has not caught up, or there.
export type PnlState = "loading" | "failed" | "off" | "updating" | "ok";
export type PositionView = {
  mode: PositionMode;
  balance: number | null;          // whole tokens
  valueUsd: number | null; valueSol: number | null;
  row: PnlRow | null;              // null unless pnl "ok" (never a row joined with a stale cost)
  pnl: PnlState;
  behind: boolean;                 // pnl "ok" but a trade of this coin is not counted in it yet: the cost figures are marked
  status: string | null;           // the card's one status line, null when there is nothing to say
};
/// Everything the card shows, from the store values and the answer (already the wallet's; narrowed or not).
/// `stale`: a landing changed this coin's balance and the answer has not caught up ("updating"). `label`: the coin as
/// the page names it ($FOO), for the closed note. `solUsd` / `quoteUsd`: prices the page knows (quotePrices uses the
/// answer's own figures first). `behind`: a settle ended and the answer has still not caught up (settleBehind).
export function positionView(i: { mode: PositionMode; mint: string; label?: string; balanceRaw: bigint | null; decimals: number;
  priceUsd: number | null; priceSol: number | null; quoteMint: string | null; solUsd: number | null; quoteUsd: number | null;
  pnl: Pnl | null; pnlError: boolean; stale: boolean; behind?: boolean }): PositionView {
  const raw = i.balanceRaw;
  const balance = raw === null ? null : fin(Number(raw) / pow10(i.decimals));
  const pu = fin(i.priceUsd), ps = fin(i.priceSol);
  const valueUsd = balance !== null && pu !== null ? fin(balance * pu) : null;
  const valueSol = balance !== null && ps !== null ? fin(balance * ps) : null;
  const pnl = i.pnl;
  const state: PnlState = !pnl ? (i.pnlError ? "failed" : "loading") : !pnlAvailable(pnl) ? "off" : i.stale ? "updating" : "ok";
  let row: PnlRow | null = null;
  if (state === "ok" && i.mode !== "none") {
    const held = raw !== null && raw > 0n;
    row = buildPnl(pnlForMint(pnl, i.mint), held ? [{ mint: i.mint, amount: raw.toString(), valueUsd }] : [],
      { quoteUsd: [[null, i.solUsd], [i.quoteMint, i.quoteUsd]], dustUsd: DUST_USD }).byMint.get(i.mint) ?? null;
  }
  const behind = state === "ok" && !!i.behind;
  const line = state === "updating" ? POSITION_UPDATING : state === "failed" ? POSITION_FAILED : historyLine(pnl, true);
  const status = line ?? (behind ? POSITION_BEHIND : i.mode === "closed" ? closedNote(i.label || "this coin") : null);
  return { mode: i.mode, balance, valueUsd, valueSol, row, pnl: state, behind, status };
}
