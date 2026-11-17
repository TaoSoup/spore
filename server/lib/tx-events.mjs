// Reading pump transactions back from the chain: what the wallet history scans (lib/pnl-tracker.mjs) and the trade gap
// fill (lib/trade-fill.mjs) share. A getTransaction("json") answer is decoded into the events of tracked coins,
// numbered the way the live path numbers them (indexer onLogs: the event's place among every LIVE_EVENT_PROGRAMS event
// of the transaction), so a row read back and a row the live stream stored for the same trade are one row.
import { eventsInLogs, eventsInInner, decodeEvent } from "./decode.mjs";
import { LIVE_EVENT_PROGRAMS, peekMint, peekPool } from "./indexer.mjs";

export const READ_OPTS = { timeoutMs: 15_000, retries: 1 };
export const SIG_MAX_BYTES = 2 * 1024 * 1024, TX_MAX_BYTES = 2 * 1024 * 1024;
export const TX_PARAMS = { maxSupportedTransactionVersion: 1, encoding: "json", commitment: "confirmed" };
export const tick = () => new Promise((r) => setImmediate(r));
/** Resolves after `ms`, or as soon as `signal` aborts. */
export const abortableSleep = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) return void r();
  const done = () => { clearTimeout(t); signal?.removeEventListener("abort", done); r(); };
  const t = setTimeout(done, Math.min(ms, 2 ** 31 - 1));
  signal?.addEventListener("abort", done, { once: true });
});

/**
 * Every trade event of a tracked coin in one transaction as getTransaction (encoding "json") answers it: pump curve
 * TradeEvents and pump-amm Buy/SellEvents, numbered like the live path does (`idx`, the event's place among every
 * tracked-program event of the transaction), each `{ name, mint, idx, e }` with `e` the decoded event. `truncated`: the
 * node cut the log. A log that is cut, missing, or holds an event of a tracked coin that does not decode is not the last
 * word: both programs also emit every event as an inner instruction to themselves (decode.mjs eventsInInner), and the
 * events are then read from there, numbered the same way, so a row the live stream stored from the part of the log it
 * did get is the same row (`inner: true` marks an answer read this way). `incomplete`: events of tracked coins may
 * still be missing (neither a whole log nor the inner instructions, or an event of a tracked coin that does not decode
 * on either path, such as an old layout), so the caller counts the transaction as unread. A transaction that failed on
 * chain has no events and is complete.
 */
export function eventsOfTx(model, tx) {
  if (!tx?.meta) return { events: [], truncated: false, incomplete: !!tx };
  if (tx.meta.err) return { events: [], truncated: false, incomplete: false };
  const logs = Array.isArray(tx.meta.logMessages) ? tx.meta.logMessages : null; // null: the node kept no log for it
  const logEvents = logs ? eventsInLogs(logs, LIVE_EVENT_PROGRAMS) : [];
  const fromLog = trackedEvents(model, logEvents);
  const truncated = !!logs && logs.some((l) => l === "Log truncated");
  if (logs && !truncated && !fromLog.undecoded) return { events: fromLog.events, truncated: false, incomplete: false };
  // The log does not tell everything: the same events are in the inner instructions, which the node does not cut. They
  // are trusted only when they hold at least every event the log showed (an event only ever logged would be missed).
  const innerEvents = eventsInInner(tx, LIVE_EVENT_PROGRAMS);
  if (innerEvents && innerEvents.length >= logEvents.length) {
    const fromInner = trackedEvents(model, innerEvents);
    return { events: fromInner.events, truncated, incomplete: fromInner.undecoded > 0, inner: true };
  }
  return { events: fromLog.events, truncated, incomplete: true };
}
/** The trade events of tracked coins among a transaction's events (eventsInLogs or eventsInInner: the event's place is its `idx`), and how many events of tracked coins did not decode. */
function trackedEvents(model, events) {
  const out = [];
  let undecoded = 0;
  events.forEach(({ name, data, ix }, idx) => {
    try {
      if (name === "TradeEvent") {
        const mint = peekMint(data);
        if (!model.get(mint)?.tracked) return;
        out.push({ name, mint, idx, e: decodeEvent(name, data) });
      } else if (name === "BuyEvent" || name === "SellEvent") {
        const mint = model.pools.get(peekPool(data));
        if (!mint || !model.get(mint)?.tracked) return;
        out.push({ name, mint, idx, e: decodeEvent(name, data, ix) });
      }
    } catch { undecoded++; } // whose trade it was cannot be told: the transaction counts as unread
  });
  return { events: out, undecoded };
}

/**
 * One getTransaction, retried `retries` more times: `{ tx, error, answered }`, `tx` null when it was not read. `call`
 * is the owner's throttled call `(method, params, maxBytes)`. A transaction that failed on chain (`s.err`) is not
 * fetched at all. `error`: every try threw (the endpoint, not the transaction); `answered`: the endpoint did answer (a
 * null answer is retried: the node may not have it yet). An answer over the byte cap is the same every time: no retry,
 * not an error. A stop (`aborted()`), a spent budget or a cap (`e.budget`, `e.cap`) is thrown to the caller.
 */
export async function readTxWith(call, s, { retries, stats = null, aborted = () => false }) {
  if (s.err) return { tx: null, error: false, answered: false };
  let error = false, answered = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt && stats) stats.txRetries++;
    try {
      const tx = await call("getTransaction", [s.signature, { ...TX_PARAMS }], TX_MAX_BYTES);
      answered = true; error = false;
      if (!tx) continue; // the node does not have it (yet)
      if (stats) stats.txRead++;
      return { tx, error: false, answered };
    } catch (e) {
      if (aborted() || e?.budget || e?.cap) throw e;
      if (e?.tooLarge) { error = false; break; } // the same answer every time
      error = !answered;
    }
  }
  return { tx: null, error, answered };
}
