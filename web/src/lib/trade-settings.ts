// Trade settings and the rules of an instant trade, as pure functions (no React, no chain, no storage): what the
// stored settings mean, and the decisions lib/instant-trade.ts takes before it signs. The hooks that read and write
// the settings are in lib/trader.ts (useTradeSettings); the dialog that edits them is components/TradeSettings.tsx.
//
// Stored in this browser under "spore:" keys (lib/trader.ts usePref):
//   spore:instant-trades  "on" | "off"       default on
//   spore:buy-presets     "0.1,0.25,0.5,1"   three or four SOL amounts (four by default; a stored list of three stays three)
//   spore:sell-presets    "25,50,75,100"     three or four whole percentages
//   spore:slippage        basis points       the ticket's own setting (TradeWidget), shared with it; with nothing
//                                            stored, instant trades use 5% and the ticket its own 1%
//   spore:instant-sol     SOL                the "sign at once up to" cap (lib/trader.ts useInstantSol)

/// How many presets a list holds: four by default (the coin page's trade card shows four large buttons); a list of three
/// stored before four were offered keeps its three. Any other length is not the user's list: the defaults apply.
export const PRESET_COUNTS: readonly number[] = [3, 4];
export const MAX_PRESET_COUNT = 4;
export const DEFAULT_BUY_PRESETS: readonly number[] = [0.1, 0.25, 0.5, 1];
export const DEFAULT_SELL_PRESETS: readonly number[] = [25, 50, 75, 100];
/// The defaults a stored list of three falls back to slot by slot (the defaults of the three-preset days).
export const DEFAULT_BUY_PRESETS_3: readonly number[] = [0.1, 0.5, 1];
export const DEFAULT_SELL_PRESETS_3: readonly number[] = [25, 50, 100];
/// A buy preset is more than 0 and at most this many SOL, with at most 4 decimals.
export const MAX_BUY_PRESET_SOL = 100;
/// The ticket's slippage (TradeWidget): its default and the range its own control allows, in basis points. A stored
/// value is read with this range wherever it is used, so the ticket and an instant trade apply the same number.
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 5_000;
/// The slippage of an instant trade while nothing is stored (5%): a 1% minimum on a fast coin fails its last simulation
/// so often that the trade would open the ticket instead of trading at once. The ticket keeps its own 1% until a value
/// is stored, here or in the ticket.
export const INSTANT_DEFAULT_SLIPPAGE_BPS = 500;
/// What the Trade settings field accepts: 0.1% to 50%.
export const MIN_SETTINGS_SLIPPAGE_BPS = 10;

/// "0.25" → 0.25; null for anything that is not a SOL amount a preset may hold.
export function parseBuyPreset(text: string): number | null {
  const t = text.trim();
  if (!/^(\d+(\.\d{0,4})?|\.\d{1,4})$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= MAX_BUY_PRESET_SOL ? n : null;
}
/// "50" → 50; null for anything that is not a whole percentage from 1 to 100.
export function parseSellPreset(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 100 ? n : null;
}
function parseList(raw: string | null | undefined, one: (s: string) => number | null, fallback: readonly number[], fallback3: readonly number[]): number[] {
  if (typeof raw !== "string") return [...fallback];
  const parts = raw.split(",");
  if (!PRESET_COUNTS.includes(parts.length)) return [...fallback];
  const slots = parts.length === 3 ? fallback3 : fallback;
  // a slot that does not parse takes its default; the others stay as the user set them
  return parts.map((p, i) => one(p) ?? slots[i]);
}
/// The stored buy presets (SOL), or the defaults: always three or four valid amounts (four when nothing is stored).
export const parseBuyPresets = (raw: string | null | undefined): number[] => parseList(raw, parseBuyPreset, DEFAULT_BUY_PRESETS, DEFAULT_BUY_PRESETS_3);
/// The stored sell presets (percent), or the defaults: always three or four whole percentages.
export const parseSellPresets = (raw: string | null | undefined): number[] => parseList(raw, parseSellPreset, DEFAULT_SELL_PRESETS, DEFAULT_SELL_PRESETS_3);
export const formatPresets = (list: readonly number[]): string => list.join(",");
/// Instant trades are on unless the user turned them off.
export const parseInstantOn = (raw: string | null | undefined): boolean => raw !== "off";
/// Whether a valid slippage is stored (a number above 0): until one is, each side uses its own default.
export function slippageStored(raw: string | null | undefined): boolean {
  if (raw == null || raw.trim() === "") return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}
/// The stored slippage in basis points, held to the ticket's range (whole basis points, 1 to 5,000); `fallback` when
/// nothing valid is stored (the ticket's 1% by default, INSTANT_DEFAULT_SLIPPAGE_BPS for an instant trade).
export function parseSlippageBps(raw: string | null | undefined, fallback: number = DEFAULT_SLIPPAGE_BPS): number {
  if (!slippageStored(raw)) return fallback;
  return Math.min(MAX_SLIPPAGE_BPS, Math.max(MIN_SLIPPAGE_BPS, Math.round(Number(raw))));
}
/// "2.5" (percent) → 250 basis points; null outside 0.1% to 50% or with more than 2 decimals (the Trade settings field).
export function slippagePctToBps(text: string): number | null {
  const t = text.trim();
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= MIN_SETTINGS_SLIPPAGE_BPS && bps <= MAX_SLIPPAGE_BPS ? bps : null;
}

/// `slippageBps`: what an instant trade uses (the stored value, else 5%); `slippageStored`: whether the ticket uses the
/// same one (it does once a value is stored).
export type TradeSettings = { instant: boolean; buyPresets: number[]; sellPresets: number[]; slippageBps: number; slippageStored: boolean };
export function parseTradeSettings(raw: { instant?: string | null; buy?: string | null; sell?: string | null; slippage?: string | null }): TradeSettings {
  return { instant: parseInstantOn(raw.instant), buyPresets: parseBuyPresets(raw.buy), sellPresets: parseSellPresets(raw.sell),
    slippageBps: parseSlippageBps(raw.slippage, INSTANT_DEFAULT_SLIPPAGE_BPS), slippageStored: slippageStored(raw.slippage) };
}

// ---- the rules of an instant trade

/// A buy preset in lamports, exactly: presets have at most 4 decimals, so the amount is a whole number of 1/10,000 SOL.
export function solToLamports(solAmount: number): bigint {
  if (!Number.isFinite(solAmount) || solAmount <= 0) return 0n;
  return BigInt(Math.round(solAmount * 10_000)) * 100_000n;
}
/// "0.1" for a field or a ticket prefilled with a preset.
export const presetText = (solAmount: number): string => String(solAmount);

/// The base units a sell of `pct` percent of `balance` sends: all of it at 100 (nothing left behind), otherwise the
/// share rounded down to a whole base unit. 0n when there is nothing to sell or the percentage is not one.
export function sellAmountOf(balance: bigint, pct: number): bigint {
  if (balance <= 0n || !Number.isInteger(pct) || pct < 1) return 0n;
  if (pct >= 100) return balance;
  return (balance * BigInt(pct)) / 100n;
}

/// Whether a trade is over the "sign at once up to N SOL" cap: its SOL value is the SOL paid on a buy, the SOL the
/// quote gives on a sell. The cap is the trading wallet's (it signs with no popup): a cap of 0 holds every trade back.
/// A connected wallet shows its own approval for each trade, so no cap applies to it.
export function overCap(o: { trader: "trading" | "wallet"; lamports: bigint; capSol: number }): boolean {
  if (o.trader !== "trading") return false;
  if (!(o.capSol > 0)) return true;
  return Number(o.lamports) / 1e9 > o.capSol;
}

/// How far a quote's fill lands from the spot price (SOL per token), fees included: 0.03 = 3% worse than spot. null
/// without a spot price. The trade ticket shows the same figure.
export function tradeImpact(o: { side: "buy" | "sell"; amountIn: bigint; amountOut: bigint; decimals: number; spot: number | null | undefined }): number | null {
  const spot = o.spot;
  if (!spot || !(spot > 0) || o.amountIn <= 0n) return null;
  const unit = 10 ** o.decimals;
  if (o.side === "buy") {
    const inSol = Number(o.amountIn) / 1e9, outTokens = Number(o.amountOut) / unit;
    return 1 - outTokens / (inSol / spot);
  }
  const inTok = Number(o.amountIn) / unit, outSol = Number(o.amountOut) / 1e9;
  return 1 - outSol / (inTok * spot);
}
/// An instant trade is not signed when its quote lands more than this far from spot (15%): the ticket opens instead,
/// where the figure is shown before anything is signed. The ticket paints the same threshold red.
export const MAX_INSTANT_IMPACT = 0.15;
/// A quote that lands more than this much BETTER than spot (5%) does not mean a good fill: it means the spot price it
/// is measured against (the index's, read a moment before) is out of date, and an out-of-date spot hides the real
/// impact by as much as it is off. Such a trade is not signed either; the ticket shows the numbers.
export const MAX_INSTANT_GAIN = 0.05;
/// "ok": within the limits. "high": worse than the limit. "stale": so much better than spot that the spot price cannot
/// be trusted. "unknown": no figure (no spot price). Only "ok" is signed.
export function impactDecision(impact: number | null): "ok" | "high" | "stale" | "unknown" {
  if (impact === null || !Number.isFinite(impact)) return "unknown";
  if (impact > MAX_INSTANT_IMPACT) return "high";
  return impact < -MAX_INSTANT_GAIN ? "stale" : "ok";
}

/// An earlier trade of the same coin that this browser sent and never saw settle (lib/trade-store.ts). A transaction
/// can land only while its blockhash lives (about 90 s): one the chain has not seen this long after it was sent cannot
/// land any more.
export const UNSETTLED_HOLD_MS = 150_000;
/// What an instant trade does about such a record. `state`: what the chain says of its signature ("unread": the chain
/// could not be asked). "go": it settled or can no longer land, the record is dropped and the trade goes on. "hold":
/// it may still be in flight or its fate is not known, so no second trade is signed beside it; the ticket says so.
export function unsettledDecision(state: "confirmed" | "failed" | "unknown" | "unread", ageMs: number): "go" | "hold" {
  if (state === "confirmed" || state === "failed") return "go";
  if (state === "unknown" && ageMs >= UNSETTLED_HOLD_MS) return "go";
  return "hold";
}

/// The largest "sign at once up to" the settings dialog takes, in SOL: a typing slip must not switch the limit off.
export const MAX_CAP_SOL = 1_000;
/// The text of the "sign at once up to" field as a cap in SOL: empty is 0 (every trade opens the ticket); null for
/// anything that is not a number from 0 to MAX_CAP_SOL with at most 9 decimals.
export function parseCapSol(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  if (!/^(\d+(\.\d{0,9})?|\.\d{1,9})$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= MAX_CAP_SOL ? n : null;
}

/// Lamports kept back on a buy: the WSOL scratch account's rent is refunded in the same transaction but has to be
/// there at the start.
export const BUY_HEADROOM_LAMPORTS = 2_100_000n;
/// What a buy needs in the wallet: the amount, the network fee, the rent of accounts it opens and the headroom.
export const buyNeedLamports = (amountIn: bigint, feeLamports: bigint, rentLamports: bigint): bigint => amountIn + feeLamports + rentLamports + BUY_HEADROOM_LAMPORTS;

/// What the simulation of an instant trade may show the wallet spending beyond the trade itself, the fee and the rent
/// counted beforehand (0.01 SOL): room for an account a venue opens inside the swap. More than that is not signed.
export const INSTANT_COST_SLACK_LAMPORTS = 10_000_000n;
/// Whether the simulated spend of the exact transaction is what the trade should cost: a buy spends at most the
/// amount plus fee, rent and slack; a sell at most fee, rent and slack (it normally brings SOL in). A spend that
/// could not be measured (null) is never accepted.
export function costWithin(o: { side: "buy" | "sell"; spent: bigint | null; amountIn: bigint; feeLamports: bigint; rentLamports: bigint }): boolean {
  if (o.spent === null) return false;
  const extra = o.feeLamports + o.rentLamports + INSTANT_COST_SLACK_LAMPORTS;
  return o.spent <= (o.side === "buy" ? o.amountIn + extra : extra);
}
