// Chain fixtures shared by the wallet P&L tests (pnl.test.mjs) and the trade gap fill tests (trade-fill.test.mjs):
// event payloads, log frames and getTransaction answers, a small tracked tree with an indexer, a fake chain and a fake
// clock. No network.
import anchor from "@coral-xyz/anchor";
import { Db } from "../../lib/db.mjs";
import { Model } from "../../lib/model.mjs";
import { Indexer } from "../../lib/indexer.mjs";
import { EVENT_DISCRIMINATORS } from "../../lib/decode.mjs";
import { BN, PublicKey, pumpIdl, pumpAmmIdl, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from "../../lib/sdk.mjs";
import { PLATFORM, quiet, T22 } from "./tree.mjs";

export const key = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
export const CURVE = PUMP_PROGRAM_ID.toBase58(), AMM = PUMP_AMM_PROGRAM_ID.toBase58();
export const M = key(81), POOL = key(82), KID = key(85), NOPRICE = key(86), UNKNOWN_QUOTE = key(87), FOREIGN = key(88);
export const W = key(60), W2 = key(61), W3 = key(62), OTHER = key(63);
export const T0 = 1_700_000_000;

/** An event's `Program data:` payload, every field a zero of its type unless `set` names it. */
export function payload(idl, name, set) {
  const t = idl.types.find((x) => x.name === name);
  const v = {};
  for (const f of t.type.fields) v[f.name] = f.type === "pubkey" ? new PublicKey(Buffer.alloc(32, 9)) : f.type === "string" ? "x" : f.type === "bool" ? false : typeof f.type === "object" ? [] : new BN(0);
  return Buffer.concat([EVENT_DISCRIMINATORS[name], new anchor.BorshCoder(idl).types.encode(name, { ...v, ...set })]);
}
export const poolEvent = (name, user, { pool = POOL, base = "1000000", quote = "425", at = T0, own = null } = {}) => payload(pumpAmmIdl, name, {
  timestamp: new BN(at), pool: new PublicKey(pool), user: new PublicKey(user), pool_base_token_reserves: new BN("200000000000000"), pool_quote_token_reserves: new BN("85000000000"),
  ...(name === "BuyEvent" ? { base_amount_out: new BN(base), quote_amount_in: new BN(quote), quote_amount_in_with_lp_fee: new BN(quote), user_quote_amount_in: new BN(own ?? 0) } : { base_amount_in: new BN(base), quote_amount_out: new BN(quote), quote_amount_out_without_lp_fee: new BN(quote), user_quote_amount_out: new BN(own ?? quote) }),
});
export const curveTrade = (mint, user, { buy = true, base = "5000000", quote = "700", at = T0 } = {}, more = {}) => payload(pumpIdl, "TradeEvent", {
  ...more,
  mint: new PublicKey(mint), user: new PublicKey(user), timestamp: new BN(at), is_buy: buy, token_amount: new BN(base), quote_mint: new PublicKey(M), quote_amount: new BN(quote),
  virtual_quote_reserves: new BN("2000000000000000"), virtual_token_reserves: new BN("1000000000000000"), real_quote_reserves: new BN("700"), real_token_reserves: new BN("500000000000000"),
});
export const frame = (program, ...events) => [`Program ${program} invoke [1]`, ...events.map((e) => `Program data: ${e.toString("base64")}`), `Program ${program} success`];
export const txOf = (logs, { slot = 100, blockTime = T0, err = null } = {}) => ({ slot, blockTime, meta: { err, logMessages: logs } });

/** M: a SOL coin that graduated (its pool is tracked). KID: on its curve, quoted in M. NOPRICE: quoted in a mint nobody prices. */
export function setup() {
  const db = new Db(":memory:");
  const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load();
  m.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  m.setSolUsd(100);
  const zeros = { virtualTokenReserves: "0", virtualQuoteReserves: "0", realTokenReserves: "0", realQuoteReserves: "0" };
  const curve = { virtualTokenReserves: "1000000000000000", virtualQuoteReserves: "2000000000000000", realTokenReserves: "500000000000000", realQuoteReserves: "0", tokenTotalSupply: "1000000000000000", initialVirtualQuoteReserves: "0", complete: false, migrated: false, creator: "CR" };
  m.upsertCoin({ mint: M, curve: "C_M", depth: 0, quoteMint: null, ...zeros, tokenTotalSupply: "1000000000000000", migrated: true, complete: true, pool: POOL, poolBaseVault: key(83), poolQuoteVault: key(84), poolBase: "200000000000000", poolQuote: "85000000000", poolVirtualQuote: "0", creator: "CR", tracked: true });
  m.upsertCoin({ mint: KID, curve: "C_K", depth: 1, quoteMint: M, ...curve, tracked: true });
  m.upsertCoin({ mint: NOPRICE, curve: "C_N", depth: 0, quoteMint: UNKNOWN_QUOTE, ...curve, tracked: true });
  m.upsertCoin({ mint: FOREIGN, curve: "C_F", depth: 0, quoteMint: null, ...curve, tracked: false });
  for (const [mint, symbol] of [[M, "MMM"], [KID, "KID"], [NOPRICE, "NOP"], [FOREIGN, "FOR"]]) m.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, onchainAt: 1 });
  const ix = new Indexer({ rpc: { snapshot: () => ({}) }, model: m, meta: null, hub: { emit() {} }, log: quiet, opts: { backfill: false } });
  return { db, m, ix };
}
/**
 * A fake chain: `sigs` newest first (`{ signature, blockTime, err }`), `txs` signature → transaction, a function of the
 * attempt number, or an Error to throw. Records every call.
 *
 * With `sigsOf` (address → its signatures, newest first, each with a `slot`), getSignaturesForAddress lists the address
 * asked for, as a node does: `before` one of its own signatures lists those after it; another signature (its slot from
 * `slotOf`, signature → slot) lists the address's signatures in lower slots; an unknown one lists nothing.
 * getSignatureStatuses knows the signatures of the listings and those in `slotOf`.
 */
export function fakeChain(sigs, txs, { onCall = null, sigsOf = null, slotOf = null } = {}) {
  const calls = [], tries = new Map();
  return {
    calls,
    count: (method) => calls.filter((c) => c.method === method).length,
    call: async (method, params, opts) => {
      calls.push({ method, params, opts });
      if (onCall) await onCall(method, params, calls);
      if (opts?.signal?.aborted) throw Object.assign(new Error("aborted"), { aborted: true });
      if (method === "getSignaturesForAddress") {
        const { limit, before } = params[1];
        if (sigsOf) {
          const list = sigsOf.get(params[0]) ?? [];
          if (!before) return list.slice(0, limit);
          const i = list.findIndex((s) => s.signature === before);
          if (i >= 0) return list.slice(i + 1, i + 1 + limit);
          if (!slotOf?.has(before)) return [];
          const slot = slotOf.get(before);
          return list.filter((s) => s.slot < slot).slice(0, limit);
        }
        const from = before ? sigs.findIndex((s) => s.signature === before) + 1 : 0;
        return sigs.slice(from, from + limit);
      }
      if (method === "getSignatureStatuses") {
        // Known: a signature of some listing, or one with a slot in `slotOf` (the anchors a node resolves).
        const known = (s) => slotOf?.has(s) || sigs.some((x) => x.signature === s) || [...(sigsOf?.values() ?? [])].some((l) => l.some((x) => x.signature === s));
        return { context: { slot: 1 }, value: params[0].map((s) => (known(s) ? { slot: slotOf?.get(s) ?? 1, confirmations: null, err: null, confirmationStatus: "finalized" } : null)) };
      }
      if (method === "getTransaction") {
        const n = (tries.get(params[0]) ?? 0) + 1; tries.set(params[0], n);
        let v = txs.get(params[0]);
        if (typeof v === "function") v = v(n);
        if (v instanceof Error) throw v;
        return v ?? null;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}
/** A clock the throttle sleeps on: sleeping only moves it. */
export function fakeClock(start = T0 * 1000) {
  const c = { t: start, slept: [], now: () => c.t, sleep: async (ms) => { c.slept.push(ms); c.t += ms; } };
  return c;
}
