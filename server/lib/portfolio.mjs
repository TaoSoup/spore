// GET /api/portfolio/:wallet: what one wallet holds and the coins it launched, for the /portfolio page.
//
// Holdings are the wallet's token accounts under the SPL Token program and Token-2022, read on the RPC
// lane the caller hands in (the "api" lane: the metered user endpoint first, RPC_URL when it refuses),
// together with its SOL balance: three calls per wallet. Only mints the index tracks are listed; the
// rest are counted. Launched coins come from the model's creator index, so no request scans all coins.
// A failed chain read never fails the request: `holdingsOk` is false or `solLamports` null instead.
// The chain reads are bounded twice: a token-account answer over PORTFOLIO_MAX_BYTES is not read to
// the end or parsed (an exchange or pool authority owns hundreds of thousands of accounts), and the
// three reads together get PORTFOLIO_DEADLINE_MS, after which they are aborted and the body answers
// with what it has (a rate-limited RPC would otherwise keep the request waiting through its pauses).
//
// One body per wallet is kept PORTFOLIO_CACHE_MS, so a page that polls costs at most one RPC round per
// wallet per window, and requests that arrive while a read is under way share it.
//
// Right after a trade the page asks with `after` (the slot its trade landed in): a body is then served
// only if every read of it succeeded and its `slot` (the lowest context slot of its reads) is at least
// that, and an in-flight read is shared only if it was started for at least that slot. Otherwise a new
// read starts with minContextSlot = after, so a node that has not caught up answers -32016 (retried a few
// times, PORTFOLIO_SLOT_RETRIES x PORTFOLIO_SLOT_RETRY_MS, inside the same deadline) instead of the old
// balance. Without `after` nothing changes: any fresh body is served, any read under way is shared.
// A node still behind after the retries (or too far behind to catch up in them) is asked once more without
// the floor: the body is then complete at that node's own, lower slot, which does not satisfy `after`, so
// the page asks again on its next reload and meanwhile shows the balance as it was, never "could not be
// read". A read with a floor that still comes back degraded (the RPC failed) does not replace a complete
// body cached for the wallet: its callers get that body. And `after` more than PORTFOLIO_AFTER_SLACK slots
// past the newest slot the reads have seen (carried forward at 400 ms a slot) is no floor: no node has
// that slot yet, so a made-up `after` cannot make every request a new read that burns RPC credits.
import { PublicKey, NATIVE_MINT, USDC_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./sdk.mjs";
import { units } from "./pricing.mjs";

export const PORTFOLIO_CACHE_MS = 10_000;
/** A body whose chain read failed is kept this long only, so the page recovers soon after the RPC does. */
export const PORTFOLIO_FAIL_MS = 3_000;
export const PORTFOLIO_CACHE_MAX = 500;
export const PORTFOLIO_LAUNCHED_MAX = 200;
/**
 * The largest getTokenAccountsByOwner answer read, per token program. An account with the 72-byte slice
 * is about 300 bytes of JSON, so 4 MB is roughly 13 000 token accounts per program; a wallet above that
 * gets `holdingsOk: false`.
 */
export const PORTFOLIO_MAX_BYTES = 4 * 1024 * 1024;
/** All chain reads of one wallet together: past this they are aborted and the body degrades. */
export const PORTFOLIO_DEADLINE_MS = 12_000;
/** Per chain read: one retry and a short timeout, the page shows "could not read" rather than wait. */
const READ_OPTS = { timeoutMs: 10_000, retries: 1 };
/** A read asked with minContextSlot that the node is not at yet (JSON-RPC -32016): tried again this often, this far apart. */
export const PORTFOLIO_SLOT_RETRIES = 4;
export const PORTFOLIO_SLOT_RETRY_MS = 400;
const BEHIND = -32016;
/** A -32016 answer whose node is at least this many slots (about 10 s) below the floor will not catch up within the retries: asked without the floor at once. */
const FAR_BEHIND = 24;
/** `after` more than this many slots (about a minute) past the newest slot seen is ignored. */
export const PORTFOLIO_AFTER_SLACK = 150;
const SLOT_MS = 400;
/** Token accounts decoded per event-loop turn (a wallet may own thousands). */
const DECODE_SLICE = 256;
const SOL_MINT = NATIVE_MINT.toBase58();
const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
const tick = () => new Promise((r) => setImmediate(r));

/** `{ mint, name, symbol, image }` of a coin's parent (its quote mint), null for a root quoted in SOL. */
function parentRef(model, c) {
  const q = c.quoteMint;
  if (q == null || q === SOL_MINT) return null;
  const p = model.get(q);
  if (p) { const r = model.ref(p); return { mint: q, name: r.name, symbol: r.symbol, image: r.image }; }
  // A quote the index does not hold as a coin (USDC, a listed asset): only its symbol, when known.
  return { mint: q, name: null, symbol: q === USDC_MINT ? "USDC" : model.mint(q)?.symbol || null, image: null };
}

/**
 * The portfolio's CoinRef of a coin: identity, parent, price and heat. `d` is a computed() table.
 * `creator` is the launching wallet where the index has it (`launcher`), else the curve's creator,
 * which is the fee-sharing config's address once a config exists; the caller passes the wallet itself
 * for a coin it lists as launched by that wallet.
 */
export function portfolioRef(model, c, d = model.computed(), creator = c.launcher ?? c.creator ?? null) {
  const r = model.ref(c);
  const priceUsd = d.get(c.mint)?.priceUsd ?? null;
  const a = model.activity.get(c.mint); // null without a trade in the last 24 h
  return {
    mint: c.mint, name: r.name, symbol: r.symbol, image: r.image, depth: c.depth, parent: parentRef(model, c), creator,
    mcapUsd: priceUsd != null ? priceUsd * units(c.tokenTotalSupply, model.decimalsOf(c.mint)) : null, priceUsd,
    vol24Usd: a?.usd ?? 0, trades1h: a?.t1h ?? 0, trades24h: a?.trades ?? 0, lastTradeAt: a?.last ?? null,
    graduated: !!c.migrated, createdAt: c.createdAt ?? null,
  };
}

/**
 * Raw balance per mint over a wallet's token accounts of both token programs, zero balances left out:
 * `{ balances: Map<mint, { amount: bigint, accounts }>, slot }`, `slot` the lower context slot of the two
 * answers (null when one has none). Only the first 72 bytes of each account are asked for (mint, owner,
 * amount), not the parsed form, which is several times larger for a busy wallet. `ask(fn)` wraps each
 * call (the -32016 retry) and hands `fn` the shared part of the call config (commitment, minContextSlot).
 */
async function readTokenBalances(rpc, wallet, opts, ask) {
  const lists = await Promise.all(TOKEN_PROGRAMS.map((programId) =>
    ask((cfg) => rpc.call("getTokenAccountsByOwner", [wallet, { programId }, { encoding: "base64", ...cfg, dataSlice: { offset: 0, length: 72 } }], { ...opts, maxBytes: PORTFOLIO_MAX_BYTES }))));
  const slot = lowestSlot(lists);
  const out = new Map();
  let n = 0;
  for (const list of lists) {
    for (const x of list?.value ?? []) {
      if (++n % DECODE_SLICE === 0) await tick();
      const buf = Buffer.from(x?.account?.data?.[0] ?? "", "base64");
      if (buf.length < 72) continue;
      const amount = buf.readBigUInt64LE(64);
      if (amount === 0n) continue;
      const mint = new PublicKey(buf.subarray(0, 32)).toBase58();
      const e = out.get(mint);
      if (e) { e.amount += amount; e.accounts++; } else out.set(mint, { amount, accounts: 1 });
    }
  }
  return { balances: out, slot };
}

/** The lowest context slot over RPC answers, null when any of them carries none. */
function lowestSlot(answers) {
  let low = null;
  for (const a of answers) {
    const s = a?.context?.slot;
    if (!Number.isSafeInteger(s) || s < 0) return null;
    low = low == null ? s : Math.min(low, s);
  }
  return low;
}

/** `after` as the route hands it in: a positive safe integer, else 0 (no floor). */
const floorOf = (after) => (Number.isSafeInteger(after) && after > 0 ? after : 0);

export function createPortfolio({ model, rpc, now = Date.now, log = console, cacheMs = PORTFOLIO_CACHE_MS, failMs = PORTFOLIO_FAIL_MS, max = PORTFOLIO_CACHE_MAX, deadlineMs = PORTFOLIO_DEADLINE_MS, slotRetries = PORTFOLIO_SLOT_RETRIES, slotRetryMs = PORTFOLIO_SLOT_RETRY_MS }) {
  const cache = new Map(); // wallet → { at, ttl, body, promise, minSlot }
  // fresher: requests with `after` that passed over a cached body or a read under way as too old;
  // behind: -32016 answers retried (the node was not at the asked slot yet); unfloored: reads asked again
  // without the floor once the node stayed behind; kept: degraded reads with a floor that left the complete
  // body they passed over in place; implausible: `after` past the newest slot seen, taken as no floor.
  const stats = { builds: 0, hits: 0, shared: 0, failed: 0, late: 0, fresher: 0, behind: 0, unfloored: 0, kept: 0, implausible: 0 };
  const warn = (what, wallet, e) => log.warn?.(`portfolio ${wallet}: ${what}: ${String(e?.message ?? e).slice(0, 160)}`);
  /** Every chain read succeeded: the only kind of body that can answer a request with `after`. */
  const complete = (body) => body.holdingsOk && body.solLamports != null && body.slot != null;
  // The newest slot any read here has seen (an answer's context, or the node's own slot in a -32016), and when.
  let tip = 0, tipAt = 0;
  const seen = (s) => { if (Number.isSafeInteger(s) && s > tip) { tip = s; tipAt = now(); } };
  /** A floor some node can have reached: nothing seen yet, or within the slack of the newest slot seen, carried forward. */
  const plausible = (floor) => !tip || floor <= tip + Math.max(0, now() - tipAt) / SLOT_MS + PORTFOLIO_AFTER_SLACK;

  async function build(wallet, floor) {
    stats.builds++;
    // One deadline for the three reads. The signal ends them inside the RPC client (the request under way and
    // every wait); the race ends this build's wait on them whatever the client does with the signal, so a read
    // that never settles cannot hold the wallet's cache entry.
    const ac = new AbortController();
    const late = new Promise((_, reject) => ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true }));
    late.catch(() => {});
    const timer = setTimeout(() => { stats.late++; ac.abort(new Error(`no answer within ${deadlineMs} ms`)); }, deadlineMs);
    const opts = { ...READ_OPTS, signal: ac.signal };
    const read = (fn) => Promise.race([Promise.resolve().then(fn), late]);
    // With a floor every read carries minContextSlot; a node below it answers -32016, which is asked again a
    // few times, a short pause apart (cut short by the deadline). Still behind after that, or so far behind
    // (the node's slot rides along in the error) that the pauses cannot be enough, the read is asked once
    // without the floor: its answer is complete at the node's own slot, which is lower than `after`, so the
    // page asks again later. Any other error goes up as before.
    const plain = { commitment: "confirmed" };
    const cfg = floor ? { ...plain, minContextSlot: floor } : plain;
    const pause = (ms) => new Promise((r) => { const id = setTimeout(r, ms); ac.signal.addEventListener("abort", () => { clearTimeout(id); r(); }, { once: true }); });
    const ask = async (fn) => {
      for (let n = 0; ; n++) {
        try { return await fn(cfg); } catch (e) {
          if (e?.code !== BEHIND || ac.signal.aborted) throw e;
          const at = e.data?.contextSlot;
          seen(at);
          if (n >= slotRetries || (Number.isSafeInteger(at) && floor - at >= FAR_BEHIND)) { stats.unfloored++; return await fn(plain); }
          stats.behind++;
          await pause(slotRetryMs);
          if (ac.signal.aborted) throw ac.signal.reason;
        }
      }
    };
    let sol, tokens;
    try {
      [sol, tokens] = await Promise.all([
        read(() => ask((c) => rpc.call("getBalance", [wallet, c], opts))).then((b) => ({ lamports: BigInt(b?.value ?? b), slot: lowestSlot([b]) })).catch((e) => { warn("balance read failed", wallet, e); return null; }),
        read(() => readTokenBalances(rpc, wallet, opts, ask)).catch((e) => { warn("token accounts read failed", wallet, e); return null; }),
      ]);
    } finally {
      // Ends whatever of this build is still going once its answer is decided: a token read whose twin already
      // failed may sit in a -32016 pause, and must not ask the RPC again for a body that is already answered.
      clearTimeout(timer);
      if (!ac.signal.aborted) ac.abort(new Error("portfolio read finished"));
    }
    // The chain state the body shows is at least this slot: the lowest of its reads, null when one failed or had no context.
    const slot = sol?.slot != null && tokens?.slot != null ? Math.min(sol.slot, tokens.slot) : null;
    seen(sol?.slot); seen(tokens?.slot);
    const d = model.computed();
    const created = model.createdBy(wallet).sort((a, b) => (b.createdAt ?? -1) - (a.createdAt ?? -1) || (a.mint < b.mint ? -1 : 1));
    // A coin listed as launched names the wallet as its creator wherever it appears, also among the holdings.
    const mine = new Set(created.map((c) => c.mint));
    const refOf = (c) => (mine.has(c.mint) ? portfolioRef(model, c, d, wallet) : portfolioRef(model, c, d));
    const holdings = [];
    let untracked = 0;
    for (const [mint, { amount, accounts }] of tokens?.balances ?? []) {
      const c = model.get(mint);
      if (!c || !c.tracked) { untracked += accounts; continue; }
      const decimals = model.decimalsOf(mint), uiAmount = units(amount, decimals), coin = refOf(c);
      holdings.push({ mint, amount: amount.toString(), decimals, uiAmount, valueUsd: coin.priceUsd != null ? uiAmount * coin.priceUsd : null, coin });
    }
    holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1) || b.uiAmount - a.uiAmount || (a.mint < b.mint ? -1 : 1));
    return {
      wallet, at: Math.floor(now() / 1000), slot, solLamports: sol != null ? sol.lamports.toString() : null,
      holdingsOk: tokens != null, holdings, untracked,
      launched: created.slice(0, PORTFOLIO_LAUNCHED_MAX).map(refOf), launchedTotal: created.length,
    };
  }

  return {
    /**
     * The wallet's portfolio body: the cached one while it is fresh, else one read shared by every caller.
     * With `after` (a slot) only a complete body at that slot or later, or a read started for it, will do;
     * else a new read replaces the entry. A read it passed over still answers its own callers, but writes
     * only its own (no longer cached) entry, so it can never put an older body over the newer one. A read
     * with a floor that comes back degraded leaves the complete body it passed over in place, and answers
     * with that body (its slot, lower than `after`, tells the page to ask again).
     */
    get(wallet, { after = 0 } = {}) {
      let floor = floorOf(after);
      if (floor && !plausible(floor)) { stats.implausible++; floor = 0; }
      const hit = cache.get(wallet);
      let prev = null; // a fresh complete body this read passes over: what stands if the read comes back degraded
      if (hit?.promise) {
        if (hit.minSlot >= floor) { stats.shared++; return hit.promise; }
        stats.fresher++;
      } else if (hit && now() - hit.at < hit.ttl) {
        if (!floor || (complete(hit.body) && hit.body.slot >= floor)) { stats.hits++; return Promise.resolve(hit.body); }
        stats.fresher++;
        if (complete(hit.body)) prev = hit;
      }
      const e = { at: 0, ttl: 0, body: null, promise: null, minSlot: floor };
      e.promise = build(wallet, floor).then((body) => {
        const ok = body.holdingsOk && body.solLamports != null;
        if (!ok) stats.failed++;
        if (!ok && prev && now() - prev.at < prev.ttl) {
          stats.kept++;
          if (cache.get(wallet) === e) { cache.delete(wallet); cache.set(wallet, prev); }
          e.at = prev.at; e.ttl = prev.ttl; e.body = prev.body; e.promise = null;
          return prev.body;
        }
        e.at = now(); e.ttl = ok ? cacheMs : failMs; e.body = body; e.promise = null;
        return body;
      }, (err) => { if (cache.get(wallet) === e) cache.delete(wallet); throw err; });
      cache.delete(wallet); cache.set(wallet, e);
      while (cache.size > max) cache.delete(cache.keys().next().value); // oldest first
      return e.promise;
    },
    snapshot() { return { cached: cache.size, ...stats }; },
  };
}
