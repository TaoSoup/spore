// Jupiter's Swap API v2 `/build` (Metis routing): the raw instructions of a swap, which the browser compiles into its own
// transaction, simulates and has the wallet sign (web/src/lib/jup.ts). Used for coins priced in a listed asset that has no
// pump SOL pool (tokenized stocks, HYPE, PUMP, USDC…): pump's multi_hop_swap cannot start from SOL there, Jupiter routes
// SOL → that asset → the coin's curve or pool in one transaction (DESIGN: "quick trade", Nov 13 2026).
//
// The server asks, not the browser: one place paces the requests under Jupiter's limit (keyless 0.5/s on api.jup.ag, a
// free key 1/s, the `x-api-key` header), keeps an optional key out of the web bundle, and limits the endpoint to swaps
// between SOL and a coin this index tracks, so it is no general-purpose Jupiter relay. /build charges no Jupiter fee
// (https://developers.jup.ag/docs/api-reference/swap/build.md) and is ExactIn only.

export const SOL_MINT = "So11111111111111111111111111111111111111112";
/// Jupiter's on-chain aggregator program (the swapInstruction of every /build answer).
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
/// The byte budget asked for the bare swap: the browser adds a compute-unit limit and price (~ 60 bytes) and signs.
export const JUP_MAX_BYTES = 1_120;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 2_000_000;
const QUEUE_MAX = 8;

export class JupiterError extends Error { constructor(status, message) { super(message); this.status = status; this.name = "JupiterError"; } }

export class Jupiter {
  /**
   * `url`: the Swap API v2 base (https://api.jup.ag/swap/v2); `apiKey`: optional (sent as x-api-key, never logged);
   * `rps`: requests per second this server may make (keyless 0.5).
   */
  constructor({ url, apiKey = "", rps = 0.5, fetch = globalThis.fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console } = {}) {
    this.url = url.replace(/\/+$/, ""); this.apiKey = apiKey; this.gapMs = Math.ceil(1_000 / rps);
    this.fetch = fetch; this.now = now; this.sleep = sleep; this.log = log;
    // `tail`: the turn of the last call in line (a strict FIFO); `lastAt`: when the last call went out.
    this.tail = Promise.resolve(); this.lastAt = -Infinity; this.waiting = 0; this.pausedUntil = 0;
    this.stats = { calls: 0, ok: 0, noRoute: 0, errors: 0, rateLimited: 0, refused: 0, dropped: 0, lastError: null, lastMs: null };
  }
  snapshot() { return { ...this.stats, keyed: !!this.apiKey, gapMs: this.gapMs, waiting: this.waiting }; }

  /**
   * One /build. `q`: { inputMint, outputMint, amount (string, base units), taker, slippageBps }. Resolves with Jupiter's
   * JSON on 200; throws JupiterError(status) otherwise (400 "No routes found", 429 rate-limited, 502 unreachable, 499
   * dropped). Calls go one at a time in arrival order, each `gapMs` after the last and after any pause a 429 set: a call
   * holds its turn until Jupiter answered, so the next one always sees that answer's pause. More than QUEUE_MAX waiting
   * answer 429 at once (a burst of quotes is dropped, not queued for minutes). `signal`: the asker went away (the browser
   * dropped the quote); a call whose turn comes after that is dropped without spending one of Jupiter's requests.
   */
  async build(q, { signal } = {}) {
    if (this.waiting >= QUEUE_MAX) { this.stats.refused++; throw new JupiterError(429, "Jupiter is busy: too many quotes waiting"); }
    this.waiting++;
    let queued = true, release;
    const prev = this.tail;
    this.tail = new Promise((r) => { release = r; });
    const leave = () => { if (queued) { queued = false; this.waiting--; } };
    try {
      await prev;
      for (;;) {
        if (signal?.aborted) { this.stats.dropped++; throw new JupiterError(499, "the quote was dropped before Jupiter was asked"); }
        const at = Math.max(this.lastAt + this.gapMs, this.pausedUntil);
        if (at <= this.now()) break;
        await this.sleep(at - this.now());
      }
      leave();
      this.lastAt = this.now();
      return await this.#send(q, signal);
    } finally { leave(); release(); }
  }

  async #send(q, signal) {
    const p = new URLSearchParams({ inputMint: q.inputMint, outputMint: q.outputMint, amount: q.amount, taker: q.taker, slippageBps: String(q.slippageBps), maxBytes: String(JUP_MAX_BYTES) });
    const headers = { accept: "application/json", ...(this.apiKey ? { "x-api-key": this.apiKey } : {}) };
    const t0 = this.now();
    this.stats.calls++;
    let res, text;
    try {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      res = await this.fetch(`${this.url}/build?${p}`, { headers, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      text = await res.text();
    } catch (e) {
      if (signal?.aborted) { this.stats.dropped++; throw new JupiterError(499, "the quote was dropped"); }
      this.stats.errors++; this.stats.lastError = e.message;
      throw new JupiterError(502, `Jupiter did not answer (${e.name === "TimeoutError" ? "timeout" : e.message})`);
    }
    this.stats.lastMs = this.now() - t0;
    if (text.length > MAX_BODY) { this.stats.errors++; throw new JupiterError(502, "Jupiter's answer is too large"); }
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (res.status === 200 && body && body.swapInstruction) { this.stats.ok++; return body; }
    const msg = (body && typeof body.error === "string" ? body.error : text.slice(0, 200)) || `HTTP ${res.status}`;
    if (res.status === 429) {
      this.stats.rateLimited++;
      // x-ratelimit-reset: unix seconds when a slot frees (https://developers.jup.ag/docs/portal/rate-limits.md)
      const reset = Number(res.headers.get?.("x-ratelimit-reset"));
      this.pausedUntil = Math.max(this.pausedUntil, Number.isFinite(reset) && reset > 0 ? Math.min(reset * 1000, this.now() + 60_000) : this.now() + 5_000);
      throw new JupiterError(429, "Jupiter is rate-limiting quotes; try again in a few seconds");
    }
    if (res.status === 400 && /no route/i.test(msg)) { this.stats.noRoute++; throw new JupiterError(400, "Jupiter found no route for this trade"); }
    this.stats.errors++; this.stats.lastError = `${res.status} ${msg}`;
    throw new JupiterError(res.status >= 500 || res.status === 200 ? 502 : res.status, `Jupiter: ${msg}`);
  }
}
