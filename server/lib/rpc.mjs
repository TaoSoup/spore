// JSON-RPC client with per-lane request budgets.
//
// The public mainnet RPC allows roughly 100 requests per 10 s per IP (40 per method) and answers
// 429 above that. Every request goes through a token bucket and a concurrency gate, and a 429
// pauses the lane that hit it with growing backoff. There are three lanes: "main" for the indexer
// (backfill, refresh, live), "api" for lookups a request triggers (an unknown coin page, an
// eligibility check) and "proxy" for the browser's own JSON-RPC traffic. The two request-driven
// lanes are small and separate so that one client hammering the API, or a burst of 429s its
// traffic provoked upstream, can slow its own lane but never stall the indexer. Paid RPCs just get
// a higher RPC_RPS.
//
// A second, metered endpoint (`user`, RPC_USER_URL: a Helius key on its free plan) can carry the
// request-driven lanes (api and proxy) while the indexer stays on RPC_URL. It is used sparingly: a
// daily credit budget (kept on disk across restarts), its own request rate under the provider's limit,
// and every refusal (over budget, a 429, a refused key, an error answer) sends the request to RPC_URL
// instead, so a user request is never slower than it was without the second endpoint.
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export class RpcError extends Error {
  constructor(method, code, message, data) { super(`${method}: ${message} (${code})`); this.name = "RpcError"; this.code = code; this.data = data; }
}

/** Resolves after `ms`, or as soon as `signal` aborts (the caller then checks the signal itself). */
const sleep = (ms, signal = null) => new Promise((r) => {
  if (!signal) return void setTimeout(r, ms);
  if (signal.aborted) return void r();
  const done = () => { clearTimeout(t); signal.removeEventListener("abort", done); r(); };
  const t = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
});
/** The error of a call whose caller aborted it (`signal` of `call`): not an RPC failure, so it is not counted as one. */
const abortedError = (method, signal) => Object.assign(new Error(`${method}: ${signal.reason?.message ?? "aborted by the caller"}`), { aborted: true });

export function deriveWsUrl(rpcUrl) {
  // Keep path and query: Helius-style keys live in the query string and are valid on the socket too.
  return rpcUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}
export const redact = (url) => String(url).replace(/(api[-_]?key=)[^&]+/i, "$1…");
export const PROXY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Credits a call costs on the metered endpoint. Helius bills most RPC calls 1 credit and getProgramAccounts 10; the
 * history reads are counted at 10 too, on purpose: counting high only ever spends less than the budget says.
 */
export const CREDIT_COST = { getProgramAccounts: 10, getTransaction: 10, getSignaturesForAddress: 10, getBlock: 10, getBlocks: 10 };
export const creditCost = (method) => CREDIT_COST[method] ?? 1;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Credits spent today (UTC) on the metered endpoint, against a daily limit. Kept in a small JSON file (written at most
 * every few seconds, and on `flush()`), so restarting the server does not start the day's count over.
 */
export class CreditBudget {
  constructor({ limit, file = null, now = Date.now, log = console, saveDelayMs = 5_000 }) {
    this.limit = limit; this.file = file; this.now = now; this.log = log; this.saveDelayMs = saveDelayMs; this.timer = null;
    this.day = utcDay(now()); this.used = 0;
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8"));
        if (saved?.day === this.day && Number.isFinite(saved.used) && saved.used >= 0) this.used = saved.used;
      } catch { /* no file yet, or unreadable: today starts at 0 */ }
    }
  }
  #roll() { const d = utcDay(this.now()); if (d !== this.day) { this.day = d; this.used = 0; } }
  /** Books `cost` credits when they fit in today's limit; false (nothing booked) when they do not. */
  take(cost) {
    this.#roll();
    if (this.used + cost > this.limit) return false;
    this.used += cost;
    if (this.file && !this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.saveDelayMs); this.timer.unref?.(); }
    return true;
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.file) return;
    try { writeFileSync(`${this.file}.tmp`, JSON.stringify({ day: this.day, used: this.used })); renameSync(`${this.file}.tmp`, this.file); }
    catch (e) { this.log.warn?.(`rpc: could not save the credit count: ${e.message}`); }
  }
  snapshot() { this.#roll(); return { day: this.day, used: this.used, limit: this.limit }; }
}

/** One token bucket + concurrency gate + 429 pause. */
class Lane {
  constructor(name, { rps, concurrency }) {
    this.name = name; this.rps = rps; this.capacity = Math.max(1, Math.ceil(rps * 2)); this.tokens = this.capacity; this.refilledAt = Date.now();
    this.concurrency = concurrency; this.inFlight = 0; this.waiters = [];
    this.pausedUntil = 0; this.backoffMs = 0;
  }
  snapshot() { return { inFlight: this.inFlight, queued: this.waiters.length, pausedMs: Math.max(0, this.pausedUntil - Date.now()) }; }
}

/** Reads a body up to `max` bytes as text; throws when the upstream answer is larger. */
async function readText(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return res.text();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { reader.cancel().catch(() => {}); throw Object.assign(new Error(`response over ${max} bytes`), { tooLarge: true }); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class Rpc {
  constructor({ url, rps = 6, concurrency = 4, timeoutMs = 30_000, log = console, fetchImpl = fetch, backoffMinMs = 1_000, backoffMaxMs = 30_000, apiRps = null, proxyRps = null, apiConcurrency = 2, proxyConcurrency = 2, pnlRps = null, pnlConcurrency = 2, fillRps = null, fillConcurrency = 2, user = null } = {}) {
    if (!url) throw new Error("RPC url required");
    this.url = url; this.log = log; this.gpaV2 = false; this.timeoutMs = timeoutMs; this.fetch = fetchImpl;
    this.backoffMinMs = backoffMinMs; this.backoffMaxMs = backoffMaxMs;
    this.rps = rps; this.concurrency = concurrency;
    // Request-driven lanes default to a quarter of the indexer's rate: enough for a coin page or a
    // launch flow, far too little to starve the refresh loop.
    this.lanes = {
      main: new Lane("main", { rps, concurrency }),
      api: new Lane("api", { rps: apiRps ?? Math.max(1, rps / 4), concurrency: apiConcurrency }),
      proxy: new Lane("proxy", { rps: proxyRps ?? Math.max(1, rps / 4), concurrency: proxyConcurrency }),
      // Wallet history scans (lib/pnl-tracker.mjs): background reads on RPC_URL only, never the metered endpoint
      // (a wallet's 1 000 transactions would be two thirds of its day), on their own budget so a scan neither
      // waits behind the indexer nor holds up a visitor's lookup.
      pnl: new Lane("pnl", { rps: pnlRps ?? Math.max(1, rps / 4), concurrency: pnlConcurrency }),
      // Trade gap fill (lib/trade-fill.mjs): RPC_URL only, never the metered user endpoint (#useUser serves api/proxy only).
      fill: new Lane("fill", { rps: fillRps ?? Math.max(1, rps / 4), concurrency: fillConcurrency }),
    };
    this.stats = { calls: 0, errors: 0, rateLimited: 0, lastError: null };
    this.id = 0;
    // The metered endpoint for the api and proxy lanes (see the top of this file). Its own lane holds its rate, and a
    // one-at-a-time "send" lane its sendTransaction rate (Helius' free plan: 10 requests/s, 1 sendTransaction/s).
    this.user = null;
    if (user?.url && user.url !== url) {
      const { url: userUrl, rps: userRps = 5, concurrency: userConcurrency = 4, sendRps = 1, dailyCredits = 15_000, creditsFile = null, now = Date.now } = user;
      this.user = { url: userUrl, host: new URL(userUrl).host, budget: new CreditBudget({ limit: dailyCredits, file: creditsFile, now, log }), offUntil: 0, calls: 0, fallbacks: 0, overDay: null };
      this.lanes.user = new Lane("user", { rps: userRps, concurrency: userConcurrency });
      this.lanes.send = new Lane("send", { rps: sendRps, concurrency: 1 });
      this.lanes.send.capacity = 1; this.lanes.send.tokens = 1; // no burst: the provider counts sends per second
    }
  }

  /**
   * Whether this request goes to the metered endpoint: only for the api and proxy lanes, while the endpoint is neither
   * paused by a 429 nor switched off by a refused key, and only when its credits fit in today's budget (booked here).
   */
  #useUser(lane, methods) {
    const u = this.user;
    if (!u || (lane !== "api" && lane !== "proxy")) return false;
    const now = Date.now();
    if (now < u.offUntil || now < this.lanes.user.pausedUntil || (methods.includes("sendTransaction") && now < this.lanes.send.pausedUntil)) return false;
    if (!u.budget.take(methods.reduce((t, m) => t + creditCost(m), 0))) {
      const day = u.budget.day;
      if (u.overDay !== day) { u.overDay = day; this.log.info?.(`rpc: ${u.host} used today's ${u.budget.limit} credits; user requests go to the free RPC until 00:00 UTC`); }
      return false;
    }
    u.calls++;
    return true;
  }
  /** The metered endpoint refused this request: the caller retries it on RPC_URL. A refused key switches it off for 10 min. */
  #userRefused(status) {
    const u = this.user;
    u.fallbacks++;
    if (status === 401 || status === 403) {
      if (Date.now() >= u.offUntil) this.log.warn?.(`rpc: ${u.host} refused the request (HTTP ${status}: a wrong or disabled key?); user requests go to the free RPC for 10 min`);
      u.offUntil = Date.now() + 10 * 60_000;
    }
  }
  /** The metered endpoint's state for /api/health: its host only, never the URL (the key is in it). */
  userSnapshot() {
    const u = this.user;
    if (!u) return null;
    return { host: u.host, credits: u.budget.snapshot(), calls: u.calls, fallbacks: u.fallbacks, offMs: Math.max(0, u.offUntil - Date.now()), pausedMs: Math.max(0, this.lanes.user.pausedUntil - Date.now()) };
  }
  /** Saves the day's credit count now (shutdown). */
  close() { this.user?.budget.flush(); }

  // The main lane's state stays reachable under its historical names (health, tests).
  get pausedUntil() { return this.lanes.main.pausedUntil; }
  get backoffMs() { return this.lanes.main.backoffMs; }
  set backoffMs(v) { this.lanes.main.backoffMs = v; }
  get inFlight() { return this.lanes.main.inFlight; }
  get waiters() { return this.lanes.main.waiters; }

  /**
   * The same client on another budget: `rpc.lane("api").getMultipleAccounts(...)` runs every
   * helper of this class through the "api" bucket. The returned object inherits from this instance,
   * so the helpers (which call `this.call`) pick the lane up without knowing about it.
   */
  lane(name) {
    if (!this.lanes[name]) throw new Error(`unknown rpc lane ${name}`);
    const base = this;
    return Object.assign(Object.create(this), { laneName: name, call: (method, params = [], opts = {}) => base.call(method, params, { ...opts, lane: name }), lane: (n) => base.lane(n) });
  }

  // ---- budget: token bucket + semaphore, per lane
  // With a `signal` (a caller's deadline) both waits end when it aborts: #take then returns without a token and
  // #enter answers false without a slot, so an abandoned call neither sleeps through a 429 pause nor queues.
  async #take(L, signal = null) {
    for (;;) {
      if (signal?.aborted) return;
      const now = Date.now();
      if (now < L.pausedUntil) { await sleep(L.pausedUntil - now, signal); continue; }
      L.tokens = Math.min(L.capacity, L.tokens + ((now - L.refilledAt) / 1000) * L.rps);
      L.refilledAt = now;
      if (L.tokens >= 1) { L.tokens -= 1; return; }
      await sleep(Math.ceil(((1 - L.tokens) / L.rps) * 1000), signal);
    }
  }
  async #enter(L, signal = null) {
    if (signal?.aborted) return false;
    if (L.inFlight < L.concurrency) { L.inFlight++; return true; }
    const got = await new Promise((resolve) => {
      const turn = () => { signal?.removeEventListener("abort", quit); resolve(true); };
      const quit = () => { const i = L.waiters.indexOf(turn); if (i >= 0) { L.waiters.splice(i, 1); resolve(false); } };
      L.waiters.push(turn);
      signal?.addEventListener("abort", quit, { once: true });
    });
    if (got) L.inFlight++;
    return got;
  }
  #leave(L) { L.inFlight--; const next = L.waiters.shift(); if (next) next(); }
  #rateLimited(L, retryAfterSec) {
    this.stats.rateLimited++;
    // Concurrent requests that were already in flight all come back 429 together; that burst is one
    // event, so the backoff only grows when a 429 arrives after the previous pause has ended.
    if (Date.now() < L.pausedUntil) return;
    L.backoffMs = Math.min(this.backoffMaxMs, Math.max(this.backoffMinMs, L.backoffMs * 2 || this.backoffMinMs, (retryAfterSec || 0) * 1000));
    L.pausedUntil = Date.now() + L.backoffMs;
    L.tokens = 0;
  }

  /**
   * One JSON-RPC call on a lane's budget, retried as described at the top of this file. Two options bound a call
   * made for a request (lib/portfolio.mjs): `maxBytes` stops reading an answer larger than that and throws at once
   * (the other endpoint or a retry would answer the same; 0 = no cap), and `signal` is the caller's overall deadline:
   * once it aborts, the request under way is cut, no wait (429 pause, token bucket, concurrency queue, retry delay)
   * goes on and the call throws.
   */
  async call(method, params = [], { timeoutMs = this.timeoutMs, retries = 3, lane = "main", maxBytes = 0, signal = null } = {}) {
    let attempt = 0, rateLimitHits = 0, free = false;
    for (;;) {
      if (signal?.aborted) throw abortedError(method, signal);
      // The metered endpoint first (api and proxy lanes only); once it refused this request, RPC_URL takes the rest of it.
      const user = !free && this.#useUser(lane, [method]);
      const L = user ? this.lanes.user : (this.lanes[lane] ?? this.lanes.main);
      if (user && method === "sendTransaction") await this.#take(this.lanes.send, signal);
      await this.#take(L, signal);
      if (!(await this.#enter(L, signal))) throw abortedError(method, signal);
      this.stats.calls++;
      let res, text;
      try {
        res = await this.fetch(user ? this.user.url : this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }), signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs) });
        text = maxBytes ? await readText(res, maxBytes) : await res.text();
        if (maxBytes && text.length > maxBytes) throw Object.assign(new Error(`response over ${maxBytes} bytes`), { tooLarge: true }); // a body without a stream reader
      } catch (e) {
        this.#leave(L);
        if (signal?.aborted) throw abortedError(method, signal);
        if (e?.tooLarge) { this.stats.errors++; this.stats.lastError = `${method}: ${e.message}`; throw Object.assign(new Error(`${method}: ${e.message}`), { tooLarge: true }); }
        if (user) { this.#userRefused(0); free = true; continue; }
        this.stats.errors++; this.stats.lastError = `${method}: ${e.message}`;
        if (attempt++ >= retries) throw e;
        await sleep(1_000 * 2 ** attempt, signal);
        continue;
      }
      this.#leave(L);
      if (res.status === 429) {
        this.#rateLimited(L, Number(res.headers.get("retry-after")));
        if (user) { this.#userRefused(429); free = true; continue; }
        if (++rateLimitHits > 12) throw new Error(`${method}: rate limited ${rateLimitHits} times`);
        continue;
      }
      if (!res.ok) {
        if (user) { this.#userRefused(res.status); free = true; continue; }
        this.stats.errors++; this.stats.lastError = `${method}: HTTP ${res.status}`;
        if (attempt++ >= retries) throw new Error(`${method}: HTTP ${res.status}`);
        await sleep(1_000 * 2 ** attempt, signal);
        continue;
      }
      let json;
      try { json = JSON.parse(text); } catch {
        if (user) { this.#userRefused(0); free = true; continue; }
        this.stats.errors++; if (attempt++ >= retries) throw new Error(`${method}: bad JSON from RPC`); continue;
      }
      if (json.error) {
        // Some providers answer rate limits inside the JSON envelope rather than with HTTP 429 (Helius: -32429).
        if (json.error.code === 429 || json.error.code === -32429 || /too many requests|rate limit|max usage/i.test(json.error.message ?? "")) {
          this.#rateLimited(L);
          if (user) { this.#userRefused(429); free = true; continue; }
          if (++rateLimitHits > 12) throw new RpcError(method, json.error.code, json.error.message);
          continue;
        }
        if (json.error.code === -32005 && user) { this.#userRefused(0); free = true; continue; } // behind: the other endpoint
        if (json.error.code === -32005 && attempt++ < retries) { await sleep(1_000, signal); continue; } // node is behind / unhealthy
        this.stats.errors++; this.stats.lastError = `${method}: ${json.error.message}`;
        throw new RpcError(method, json.error.code, json.error.message, json.error.data);
      }
      L.backoffMs = 0;
      return json.result;
    }
  }

  // ---- helpers (all return plain data; account data as Buffer)
  static account(v) { return v ? { owner: v.owner, lamports: v.lamports, data: Buffer.from(v.data[0], "base64"), executable: v.executable } : null; }

  /** Accounts for `keys` (strings), chunked by 100; result aligned with input, null for missing. */
  async getMultipleAccounts(keys, { chunk = 100, commitment = "confirmed" } = {}) {
    const out = new Array(keys.length).fill(null);
    for (let i = 0; i < keys.length; i += chunk) {
      const slice = keys.slice(i, i + chunk);
      const r = await this.call("getMultipleAccounts", [slice, { encoding: "base64", commitment }]);
      r.value.forEach((v, j) => { out[i + j] = Rpc.account(v); });
    }
    return out;
  }
  async getAccountInfo(key, { commitment = "confirmed" } = {}) {
    const r = await this.call("getAccountInfo", [key, { encoding: "base64", commitment }]);
    return Rpc.account(r.value);
  }
  /**
   * `[{pubkey, account}]` for every account of `program` matching the memcmp `filters`.
   * Helius refuses plain getProgramAccounts on programs with millions of accounts (pump.fun has
   * ~10 M) and asks for getProgramAccountsV2, a paginated scan: each call returns the matches of
   * one slice of the key space plus a `paginationKey` for the next one, until it is null. The
   * switch is made on the first refusal and remembered for the life of the process.
   */
  async getProgramAccounts(program, filters, { commitment = "confirmed", dataSlice } = {}) {
    const cfg = { encoding: "base64", commitment, filters };
    if (dataSlice) cfg.dataSlice = dataSlice;
    if (!this.gpaV2) {
      try {
        const r = await this.call("getProgramAccounts", [program, cfg], { timeoutMs: 120_000 });
        return r.map((x) => ({ pubkey: x.pubkey, account: Rpc.account(x.account) }));
      } catch (e) {
        if (!(e instanceof RpcError) || !/getProgramAccountsV2/i.test(e.message)) throw e;
        this.gpaV2 = true;
        this.log.info?.("rpc: getProgramAccounts refused by the provider, switching to getProgramAccountsV2 pagination");
      }
    }
    const out = [];
    let paginationKey = null, pages = 0;
    const t0 = Date.now();
    do {
      const r = await this.call("getProgramAccountsV2", [program, { ...cfg, limit: 10_000, ...(paginationKey ? { paginationKey } : {}) }], { timeoutMs: 120_000 });
      for (const x of r.accounts ?? []) out.push({ pubkey: x.pubkey, account: Rpc.account(x.account) });
      paginationKey = r.paginationKey ?? null;
      if (++pages % 100 === 0) this.log.info?.(`rpc: getProgramAccountsV2 page ${pages}, ${out.length} matches, ${Math.round((Date.now() - t0) / 1000)} s`);
    } while (paginationKey);
    this.log.info?.(`rpc: getProgramAccountsV2 done: ${pages} pages, ${out.length} matches, ${Math.round((Date.now() - t0) / 1000)} s`);
    return out;
  }
  /**
   * Streams every account of `program` matching `filters` to `onAccount(pubkey, data)` page by page
   * (getProgramAccountsV2, 10 000 per page), never holding the whole set: a walk of all ~10 M pump curves
   * with a `dataSlice` of a few bytes is ~3 200 pages and a few minutes, and would be gigabytes as one
   * array. Returns `{ pages, accounts }`.
   */
  async scanProgramAccounts(program, { filters = [], dataSlice = null, commitment = "confirmed" } = {}, onAccount) {
    const cfg = { encoding: "base64", commitment, filters, ...(dataSlice ? { dataSlice } : {}), limit: 10_000 };
    let paginationKey = null, pages = 0, accounts = 0;
    const t0 = Date.now();
    do {
      const r = await this.call("getProgramAccountsV2", [program, { ...cfg, ...(paginationKey ? { paginationKey } : {}) }], { timeoutMs: 120_000 });
      for (const x of r.accounts ?? []) { accounts++; onAccount(x.pubkey, Buffer.from(x.account.data[0], "base64")); }
      paginationKey = r.paginationKey ?? null;
      if (++pages % 500 === 0) this.log.info?.(`rpc: scan page ${pages}, ${accounts} accounts, ${Math.round((Date.now() - t0) / 1000)} s`);
    } while (paginationKey);
    return { pages, accounts };
  }
  /** Parsed token accounts of `owner` under `programId`: `[{pubkey, mint, amount, tokenProgram}]`. */
  async getTokenAccountsByOwner(owner, programId, { commitment = "confirmed" } = {}) {
    const r = await this.call("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment }]);
    return r.value.map((x) => ({ pubkey: x.pubkey, mint: x.account.data.parsed.info.mint, amount: x.account.data.parsed.info.tokenAmount.amount, tokenProgram: x.account.owner }));
  }
  async getSignaturesForAddress(address, opts = {}) {
    return this.call("getSignaturesForAddress", [address, { limit: 1000, commitment: "confirmed", ...opts }]);
  }
  /** Mainnet carries v1 transactions (2026); an RPC refuses the fetch unless the client accepts them. */
  async getTransaction(sig) {
    return this.call("getTransaction", [sig, { maxSupportedTransactionVersion: 1, encoding: "json", commitment: "confirmed" }]);
  }
  async getSlot() { return this.call("getSlot", [{ commitment: "confirmed" }]); }

  /**
   * Raw pass-through for the browser proxy on its own lane: body forwarded verbatim, the answer
   * relayed up to `maxBytes` (a getTokenAccountsByOwner of a whale is megabytes; nothing the
   * browser legitimately asks for is).
   */
  async proxy(body, { timeoutMs = 20_000, maxBytes = PROXY_MAX_BYTES } = {}) {
    // A single call may go to the metered endpoint; a batch stays on RPC_URL (free plans may refuse batches).
    const methods = Array.isArray(body) ? null : [String(body?.method)];
    for (let free = !methods; ; free = true) {
      const user = !free && this.#useUser("proxy", methods);
      const L = user ? this.lanes.user : this.lanes.proxy;
      if (user && methods.includes("sendTransaction")) await this.#take(this.lanes.send);
      await this.#take(L);
      await this.#enter(L);
      this.stats.calls++;
      let res, text;
      try {
        try { res = await this.fetch(user ? this.user.url : this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
        catch (e) { if (user) { this.#userRefused(0); continue; } throw e; }
        text = await readText(res, maxBytes);
      } finally { this.#leave(L); }
      if (res.status === 429) {
        this.#rateLimited(L, Number(res.headers.get("retry-after")));
        if (user) { if (methods.includes("sendTransaction")) this.#rateLimited(this.lanes.send); this.#userRefused(429); continue; }
      } else if (user && !res.ok) { this.#userRefused(res.status); continue; }
      else L.backoffMs = 0;
      return { status: res.status, text };
    }
  }

  snapshot() { return { ...this.stats, ...this.lanes.main.snapshot() }; }
  /** Per-lane budget state for /api/health. */
  laneSnapshot() { return Object.fromEntries(Object.values(this.lanes).map((L) => [L.name, { rps: L.rps, ...L.snapshot() }])); }
}
