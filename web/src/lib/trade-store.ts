// The trades this browser sent and has not seen settle: written the moment the wallet returns a signature, cleared
// when it confirms or fails. A tab closed or reloaded mid-flight (or a status check that never answered) leaves the
// record, so the trade widget can say whether that trade landed before the user sends another one.
import type { Side } from "./pump/route";

export type PendingTrade = { sig: string; mint: string; symbol: string | null; side: Side; at: number };
const KEY = "spore:trades-pending";
/// Older than this, a record is dropped unread: a blockhash lives ~90 s, and the widget only asks about recent ones.
export const PENDING_TRADE_TTL_MS = 30 * 60_000;
const MAX = 8;

type Store = Pick<Storage, "getItem" | "setItem">;
const store = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

function read(s: Store, now: number): PendingTrade[] {
  try {
    const v = JSON.parse(s.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((t): t is PendingTrade => !!t && typeof t.sig === "string" && typeof t.mint === "string" && typeof t.at === "number" && now - t.at < PENDING_TRADE_TTL_MS) : [];
  } catch { return []; }
}
function write(s: Store, list: PendingTrade[]) { try { s.setItem(KEY, JSON.stringify(list.slice(-MAX))); } catch { /* storage full or blocked: nothing to remember */ } }

export function savePendingTrade(t: PendingTrade, s: Store | null = store(), now = Date.now()) {
  if (!s) return;
  write(s, [...read(s, now).filter((x) => x.sig !== t.sig), t]);
}
export function clearPendingTrade(sig: string, s: Store | null = store(), now = Date.now()) {
  if (!s) return;
  write(s, read(s, now).filter((x) => x.sig !== sig));
}
/// The newest unsettled trade of `mint`, or null.
export function pendingTradeOf(mint: string, s: Store | null = store(), now = Date.now()): PendingTrade | null {
  if (!s) return null;
  const mine = read(s, now).filter((x) => x.mint === mint);
  return mine.length ? mine[mine.length - 1] : null;
}
