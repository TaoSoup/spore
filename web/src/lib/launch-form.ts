// The launch form's rules, shared by the Launch page (pages/Launch.tsx) and the coin page's "Launch a child" card
// (components/coin/LaunchChild.tsx): one sentence per field that is not valid, in the user's words. Pure.
import { isHttpUrl, normaliseSocial } from "./image";

export const TICKER_RE = /^[A-Z0-9]{1,13}$/;
export const NAME_MAX = 32;
export const DESCRIPTION_MAX = 400;
/// What the ticker field keeps of what is typed: letters and digits, upper case, at most 13.
export const sanitizeTicker = (v: string) => v.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 13);

export type LaunchField = "name" | "symbol" | "description" | "image" | "twitter" | "telegram" | "website" | "firstBuy" | "feeBps";
export const socialBad = (kind: "twitter" | "telegram" | "website", v: string) => v.trim() !== "" && !isHttpUrl(normaliseSocial(kind, v));

/// `firstBuy` / `buyLamports`: the first-buy text and its value (0n when it does not parse); `feeValue`: the creator
/// fee in bps when one is typed (the Launch page's Advanced field; undefined otherwise).
export function launchErrors(f: { name: string; symbol: string; hasImage: boolean; description: string; twitter: string; telegram: string; website: string; firstBuy?: string; buyLamports?: bigint; feeValue?: number }): Partial<Record<LaunchField, string>> {
  const fb = f.firstBuy ?? "";
  return {
    ...(!f.name.trim() ? { name: `Give the coin a name (1–${NAME_MAX} characters)` } : f.name.trim().length > NAME_MAX ? { name: `At most ${NAME_MAX} characters` } : {}),
    ...(!f.symbol ? { symbol: "Pick a ticker: 1–13 letters or digits" } : !TICKER_RE.test(f.symbol) ? { symbol: "Letters and digits only, up to 13" } : {}),
    ...(!f.hasImage ? { image: "Add an image: the coin's face on every card" } : {}),
    ...(f.description.length > DESCRIPTION_MAX ? { description: `At most ${DESCRIPTION_MAX} characters` } : {}),
    ...(socialBad("twitter", f.twitter) ? { twitter: "A profile link or handle, like @spore" } : {}),
    ...(socialBad("telegram", f.telegram) ? { telegram: "A t.me link or handle" } : {}),
    ...(socialBad("website", f.website) ? { website: "A full URL, like https://example.com" } : {}),
    ...(fb.trim() && (f.buyLamports ?? 0n) === 0n ? { firstBuy: "A SOL amount, or leave it empty" } : {}),
    ...(f.feeValue !== undefined && (!Number.isInteger(f.feeValue) || f.feeValue < 0 || f.feeValue > 300) ? { feeBps: "0–300 bps, or leave it empty" } : {}),
  };
}

/// Whether a parent's tree takes a first buy from SOL (the Launch page's `canBuy` for a child): a root priced in SOL, or
/// any deeper parent. A root priced in a listed asset has no SOL route for it.
export const childCanBuy = (parent: { depth: number; quoteMint: string | null }) => (parent.depth === 0 ? parent.quoteMint === null : true);
