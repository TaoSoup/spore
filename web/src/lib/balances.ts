// Every wallet balance the site shows, in one store per tab: the SOL of an owner (`sol:<owner>`) and its balance of a
// coin (`tok:<owner>:<mint>`, read from its associated token account). The header pill, the trading wallet's panel,
// the trade ticket, the launch page and the instant trade all read it, so a trade that lands updates all of them at
// once, from one read.
//
// How it stays right:
//   - A read result replaces what a key shows only if it was answered at a slot at least as new as the one shown: a
//     lagging RPC node never puts an older balance back on screen.
//   - Every read asks for at least the owner's floor slot (minContextSlot): the newest slot a trade of it landed in or
//     a read of it reached. A node that has not caught up answers -32016; the read is tried again after 0.4, 0.8,
//     1.6 and 3.2 s (a network failure too, not a rate limit), then left until the next trigger.
//   - A failure keeps the value on screen and sets `error`: it never reads as a balance of 0. A token account that
//     does not exist, in a read that succeeded, is a real 0 ("never held it": `hasAta` false); so is an owner account
//     that does not exist (0 lamports).
//   - One getMultipleAccounts per owner per tick (the owner and the token accounts watched for it, at most 32 keys a
//     call, never batched: one single call is one Helius credit, a batch goes to the slow lane); reads asked in the
//     same microtask are one read.
//   - When a transaction lands (lib/pump/send.ts tells `landed` with its static keys and slot) every watched owner in
//     it is read again at that slot. The live stream's trades do the same for a watched wallet trading elsewhere (another
//     tab, another device), at most one read per owner per 5 s; the echo of our own trade is already covered and costs
//     nothing.
//   - One 30 s poll for the whole tab, paused while the tab is hidden (on coming back, every watched owner is read
//     once), and no timer at all while nothing is watched. A key nobody watches is kept about a minute, so a page
//     that mounts again shows its last value at once while it reads.
// Safe to import in Node tests: nothing here touches the browser until the first subscriber, and then only behind
// typeof checks.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { errorMessage, type Trade } from "./api";
import { subscribe as subscribeEvents } from "./events";
import { setLandedHook } from "./pump/send";

/// What a key shows. `value`: lamports or base units (null until a read answered); `hasAta`: on a token key, whether
/// its token account exists (null until known; always null on a SOL key); `slot`: the slot of the read that last
/// changed what it shows; `error`: the last read failed (the value is kept).
export type BalanceSnap = { value: bigint | null; hasAta: boolean | null; slot: number; error: string | null };

const POLL_MS = 30_000;
/// A key with no subscriber is dropped after this long.
const IDLE_MS = 60_000;
/// The waits before each new try of a failed read (a node behind the floor slot, a network or proxy hiccup). A rate
/// limit is not tried again here: web3 already asked again on it (five times, over about 7.5 s), and more asks would
/// only keep the limit full while the sends and confirms of a trade need it.
const RETRY_MS = [400, 800, 1_600, 3_200];
/// The live stream's trades of one owner start at most one read per this long; the newest of those that come in
/// between is read once at the end (a busy wallet trades every second or so).
const STREAM_GAP_MS = 5_000;
let streamGapMs = STREAM_GAP_MS; // (tests shorten it)
/// getMultipleAccounts takes at most this many keys a call (and costs one credit for all of them).
const CHUNK = 32;
/// A token account's amount is the u64 at offset 64: only those 8 bytes are asked for. The owner is a system account
/// with no data, and its lamports come back whatever the slice.
const SLICE = { offset: 64, length: 8 };
/// How many owners' landed slots are remembered (the static keys of every landed transaction, most are programs).
const LANDED_KEEP = 512;

const EMPTY: BalanceSnap = Object.freeze({ value: null, hasAta: null, slot: 0, error: null }) as BalanceSnap;

type Entry = {
  key: string; owner: string;
  /// a token key's account (null on a SOL key, or when it could not be derived: `bad` then says why)
  ata: PublicKey | null; token: boolean; bad: string | null;
  /// the one snapshot object React sees, replaced only when what it shows changes
  snap: BalanceSnap;
  /// the newest slot a read of this key reached (the snapshot keeps the slot of its last change)
  slot: number;
  subs: Set<() => void>;
  /// reads in flight that need this key kept (readBalancesNow), though nobody subscribes
  holds: number;
  idleAt: number;
};
type OwnerState = {
  /// the highest slot a successful read of every watched key of this owner reached
  covered: number;
  busy: boolean; busyTarget: number; busyKeys: Set<string>;
  queued: boolean; queuedTarget: number;
  retry: ReturnType<typeof setTimeout> | null; retryTarget: number; tries: number;
  /// when the live stream last led to a read of this owner; the trailing read of the trades held since (`trailSlot`:
  /// the newest of their slots, 0 when none had one)
  streamAt: number; trail: ReturnType<typeof setTimeout> | null; trailSlot: number;
};

const entries = new Map<string, Entry>();
const owners = new Map<string, OwnerState>();
/// owner -> the newest slot a transaction it was in landed (oldest dropped first past LANDED_KEEP)
const landedAt = new Map<string, number>();
const landedSubs = new Set<(owner: string, slot: number) => void>();
let conn: Connection | null = null;
let total = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let sseOff: (() => void) | null = null;
let visOn = false;
let flushQueued = false;
/// watched owners a trade was seen for while the tab was hidden (read when it shows again)
const dirty = new Set<string>();

const solKey = (owner: string) => `sol:${owner}`;
const tokKey = (owner: string, mint: string) => `tok:${owner}:${mint}`;
const hidden = () => typeof document !== "undefined" && document.hidden === true;

function entryFor(owner: string, mint?: string | null, tokenProgram?: string | null): Entry {
  const key = mint ? tokKey(owner, mint) : solKey(owner);
  let e = entries.get(key);
  if (!e) {
    let ata: PublicKey | null = null, bad: string | null = null;
    if (mint) {
      try { ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, new PublicKey(tokenProgram ?? "")); }
      catch (x) { bad = `The token account could not be derived (${errorMessage(x)})`; }
    }
    e = { key, owner, ata, token: !!mint, bad, snap: bad ? { ...EMPTY, error: bad } : EMPTY, slot: 0, subs: new Set(), holds: 0, idleAt: Date.now() };
    entries.set(key, e);
  }
  return e;
}
const ownerState = (owner: string): OwnerState => {
  let st = owners.get(owner);
  if (!st) { st = { covered: 0, busy: false, busyTarget: 0, busyKeys: new Set(), queued: false, queuedTarget: 0, retry: null, retryTarget: 0, tries: 0, streamAt: 0, trail: null, trailSlot: 0 }; owners.set(owner, st); }
  return st;
};
/// The keys of `owner` someone subscribes to now.
const watchedOf = (owner: string): Entry[] => { const out: Entry[] = []; for (const e of entries.values()) if (e.owner === owner && e.subs.size > 0) out.push(e); return out; };
const isWatched = (owner: string) => { for (const e of entries.values()) if (e.owner === owner && e.subs.size > 0) return true; return false; };
const watchedOwners = (): string[] => { const s = new Set<string>(); for (const e of entries.values()) if (e.subs.size > 0) s.add(e.owner); return [...s]; };
/// The slot every read of `owner` asks for at least: its newest landing, or the newest slot any of its keys was read at.
function floor(owner: string): number {
  let f = landedAt.get(owner) ?? 0;
  for (const e of entries.values()) if (e.owner === owner && e.slot > f) f = e.slot;
  return f;
}
const noteLanded = (owner: string, slot: number): boolean => {
  const prev = landedAt.get(owner) ?? 0;
  if (slot <= prev) return false;
  landedAt.delete(owner); landedAt.set(owner, slot);
  if (landedAt.size > LANDED_KEEP) landedAt.delete(landedAt.keys().next().value as string);
  return true;
};

const setSnap = (e: Entry, next: BalanceSnap) => { e.snap = next; for (const f of [...e.subs]) f(); };
/// u64 little-endian: the 8 sliced bytes, or offset 64 of a whole token account (a node that ignored the slice).
function amountOf(d: Uint8Array): bigint | null {
  const off = d.length === 8 ? 0 : d.length >= 72 ? 64 : -1;
  if (off < 0) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[off + i]);
  return v;
}
/// What one account of a read that succeeded says of its key: lamports for an owner (none: 0), the amount for a token
/// account (none: 0 and no account). `null` value: the data is not a token account's.
function readOf(e: Entry, info: AccountInfo<Uint8Array> | null): { value: bigint | null; hasAta: boolean | null } {
  if (!e.token) return { value: info ? BigInt(info.lamports) : 0n, hasAta: null };
  if (!info) return { value: 0n, hasAta: false };
  return { value: amountOf(info.data), hasAta: true };
}
/// One read's answer, at `slot`, for `list` (in the order the accounts were asked). Older than what a key shows: ignored.
function apply(list: Entry[], infos: (AccountInfo<Uint8Array> | null)[], slot: number) {
  list.forEach((e, i) => {
    if (slot < e.slot) return;
    e.slot = slot;
    const r = readOf(e, infos[i] ?? null);
    if (r.value === null) { if (e.snap.error === null) setSnap(e, { ...e.snap, error: "That account is not a token account" }); return; }
    const s = e.snap;
    if (s.value === r.value && s.hasAta === r.hasAta && s.error === null) return;
    setSnap(e, { value: r.value, hasAta: r.hasAta, slot, error: null });
  });
}
const setError = (list: Entry[], msg: string) => { for (const e of list) if (e.snap.error !== msg) setSnap(e, { ...e.snap, error: msg }); };

const accountKey = (e: Entry) => (e.token ? e.ata! : new PublicKey(e.owner));
/// One getMultipleAccounts per 32 keys (one call for any owner here), at `confirmed`, at least at `minSlot`. Several
/// calls answer at several slots: the oldest is the one the whole answer is sure of.
async function fetchAccounts(c: Connection, keys: PublicKey[], minSlot: number): Promise<{ slot: number; infos: (AccountInfo<Uint8Array> | null)[] }> {
  const cfg = { commitment: "confirmed" as const, dataSlice: SLICE, ...(minSlot > 0 ? { minContextSlot: minSlot } : {}) };
  const parts: Promise<Awaited<ReturnType<Connection["getMultipleAccountsInfoAndContext"]>>>[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) parts.push(c.getMultipleAccountsInfoAndContext(keys.slice(i, i + CHUNK), cfg));
  const res = await Promise.all(parts);
  return { slot: Math.min(...res.map((r) => r.context.slot)), infos: res.flatMap((r) => r.value) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/// Whether a failed read is worth another try soon: a node behind the floor (-32016), or the network, a timeout, a 5xx
/// (no JSON-RPC code). Not a rate limit (web3 already asked again on it), nor any other JSON-RPC answer (the same ask
/// gets the same answer).
function retryable(x: unknown): boolean {
  const code = (x as { code?: unknown } | null)?.code;
  if (code === -32016) return true;
  if (code === 429 || code === -32429 || /^429\b|too many requests|rate.?limit/i.test(errorMessage(x))) return false;
  return typeof code !== "number";
}

const cancelRetry = (owner: string, slot: number) => {
  const st = owners.get(owner);
  if (st?.retry && slot >= st.retryTarget) { clearTimeout(st.retry); st.retry = null; st.tries = 0; }
};

/// Ask for a read of every watched key of `owner`, at least at `target` (and always at least at its floor). Run in a
/// microtask, so whatever asks in the same turn is one read; a read in flight that already asks as much answers it.
function request(owner: string, target = 0) {
  const st = ownerState(owner);
  const want = Math.max(target, floor(owner));
  if (st.busy && st.busyTarget >= want && watchedOf(owner).every((e) => st.busyKeys.has(e.key))) return;
  st.queued = true;
  if (want > st.queuedTarget) st.queuedTarget = want;
  if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
}
function flush() {
  flushQueued = false;
  for (const [o, st] of owners) if (st.queued && !st.busy) void runOwner(o);
}
async function runOwner(owner: string) {
  const st = ownerState(owner);
  const c = conn;
  const list = watchedOf(owner).filter((e) => !e.bad);
  st.queued = false;
  const target = Math.max(st.queuedTarget, floor(owner));
  st.queuedTarget = 0;
  if (!c || !list.length) return;
  st.busy = true; st.busyTarget = target; st.busyKeys = new Set(list.map((e) => e.key));
  try {
    const { slot, infos } = await fetchAccounts(c, list.map(accountKey), target);
    apply(list, infos, slot);
    if (slot > st.covered) st.covered = slot;
    st.tries = 0;
    cancelRetry(owner, slot);
  } catch (x) {
    // tried again a few times, at the same target; then the error is shown (the values stay) until the next trigger.
    // A rate limit (or another JSON-RPC refusal) is shown at once. A try that falls due in a hidden tab is left to
    // the read on coming back.
    if (retryable(x) && st.tries < RETRY_MS.length) {
      st.retryTarget = Math.max(st.retry ? st.retryTarget : 0, target);
      if (!st.retry && total > 0) st.retry = setTimeout(() => { st.retry = null; if (hidden()) dirty.add(owner); else request(owner, st.retryTarget); }, RETRY_MS[st.tries++]);
    } else { st.tries = 0; setError(list, errorMessage(x)); }
  } finally {
    st.busy = false; st.busyKeys = new Set();
    if (st.queued && !flushQueued) { flushQueued = true; queueMicrotask(flush); }
  }
}

/// A transaction landed at `slot` with these keys (lib/pump/send.ts calls it; so does the live stream). The landing
/// listeners hear of every owner at once (a slot newer than the last one heard for it), then every watched owner the
/// reads have not covered at that slot is read at it.
export function landed(list: string[], slot: number) {
  if (!(slot > 0)) return;
  const fresh = list.filter((o) => noteLanded(o, slot));
  for (const o of fresh) for (const f of [...landedSubs]) { try { f(o, slot); } catch (e) { console.error("landed listener", e); } }
  for (const o of list) {
    if (!isWatched(o)) continue;
    const st = ownerState(o);
    if (slot <= st.covered) continue;
    if (hidden()) { dirty.add(o); continue; }
    if ((st.busy && st.busyTarget >= slot) || (st.queued && st.queuedTarget >= slot)) continue;
    request(o, slot);
  }
}
setLandedHook(landed);

/// Told synchronously of every owner of a landed transaction, with its slot (the Portfolio page reloads its own
/// figures from it).
export function subscribeLanded(cb: (owner: string, slot: number) => void): () => void {
  landedSubs.add(cb);
  return () => { landedSubs.delete(cb); };
}

/// A trade on the live stream: a watched wallet traded (here, in another tab, on another device). At most one read per
/// STREAM_GAP_MS per owner comes from here: a trade within that time of the last one is held, and the newest held is
/// read once when the time is up (the landing listeners hear of it then too). A trade sent here is not held back:
/// lib/pump/send.ts tells `landed` directly.
function onTrade(t: Pick<Trade, "user" | "slot">) {
  const o = t.user;
  if (!o || !isWatched(o)) return;
  const st = ownerState(o);
  const slot = t.slot > 0 ? t.slot : 0;
  const wait = st.streamAt + streamGapMs - Date.now();
  if (wait > 0 || st.trail) {
    if (slot > st.trailSlot) st.trailSlot = slot;
    if (!st.trail) st.trail = setTimeout(() => { st.trail = null; const s = st.trailSlot; st.trailSlot = 0; streamRead(o, s); }, Math.max(0, wait));
    return;
  }
  streamRead(o, slot);
}
function streamRead(o: string, slot: number) {
  if (!isWatched(o)) return;
  ownerState(o).streamAt = Date.now();
  // a slot: read at it, unless a read already reached it (the echo of a trade sent here); none: read at the floor
  if (slot > 0) landed([o], slot);
  else if (hidden()) dirty.add(o);
  else request(o);
}

/// Read `owner`'s watched keys again now (at its floor slot).
export function refresh(owner: string) { if (isWatched(owner)) request(owner); }

function sweep() {
  const now = Date.now();
  for (const [k, e] of entries) if (e.subs.size === 0 && e.holds === 0 && now - e.idleAt > IDLE_MS) entries.delete(k);
  for (const [o, st] of owners) {
    if (st.busy || st.queued || st.retry || st.trail) continue;
    let has = false;
    for (const e of entries.values()) if (e.owner === o) { has = true; break; }
    if (!has) owners.delete(o);
  }
}
function tick() { sweep(); for (const o of watchedOwners()) request(o); }
function syncPoll() {
  const want = total > 0 && !hidden();
  if (want && !pollTimer) pollTimer = setInterval(tick, POLL_MS);
  else if (!want && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function onVisibility() {
  syncPoll();
  if (hidden()) return;
  dirty.clear();
  for (const o of watchedOwners()) request(o);
}
function start() {
  if (typeof window !== "undefined" && typeof EventSource !== "undefined" && !sseOff) sseOff = subscribeEvents({ trade: onTrade });
  if (typeof document !== "undefined" && !visOn) { document.addEventListener("visibilitychange", onVisibility); visOn = true; }
  syncPoll();
}
function stop() {
  sseOff?.(); sseOff = null;
  if (visOn) { document.removeEventListener("visibilitychange", onVisibility); visOn = false; }
  syncPoll();
  for (const st of owners.values()) {
    if (st.retry) clearTimeout(st.retry);
    if (st.trail) clearTimeout(st.trail);
    st.retry = null; st.tries = 0; st.trail = null; st.trailSlot = 0;
  }
  dirty.clear();
}

/// Subscribe `cb` to one key. The first subscriber of a key reads it (with its owner's other keys, in one call).
function watch(c: Connection, owner: string, mint: string | null, tokenProgram: string | null, cb: () => void): () => void {
  conn = c;
  sweep();
  const e = entryFor(owner, mint, tokenProgram);
  const first = e.subs.size === 0;
  e.subs.add(cb);
  if (++total === 1) start();
  if (first) request(owner);
  return () => {
    if (!e.subs.delete(cb)) return;
    if (e.subs.size === 0) e.idleAt = Date.now();
    if (--total === 0) stop();
  };
}
const snapOf = (key: string | null): BalanceSnap => (key ? entries.get(key)?.snap ?? EMPTY : EMPTY);
const noop = () => () => {};

/// The balances of `owner`: its SOL, and with `coin` its balance of that coin. `token` null: not known (not read yet,
/// or the read failed); `hasAta` false also while unknown (a buy then counts the account's rent, the safe side).
/// Keyed on the strings, so a new PublicKey or coin object each render is the same subscription.
export function useBalances(c: Connection, owner: PublicKey | null, coin?: { mint: string; tokenProgram: string } | null): { sol: bigint | null; token: bigint | null; hasAta: boolean; error: string | null } {
  const o = owner?.toBase58() ?? null;
  const mint = coin?.mint ?? null, tp = coin?.tokenProgram ?? null;
  const subSol = useCallback((cb: () => void) => (o ? watch(c, o, null, null, cb) : noop()), [c, o]);
  const subTok = useCallback((cb: () => void) => (o && mint ? watch(c, o, mint, tp, cb) : noop()), [c, o, mint, tp]);
  const solKeyNow = o ? solKey(o) : null, tokKeyNow = o && mint ? tokKey(o, mint) : null;
  const sol = useSyncExternalStore(subSol, () => snapOf(solKeyNow), () => snapOf(solKeyNow));
  const tok = useSyncExternalStore(subTok, () => snapOf(tokKeyNow), () => snapOf(tokKeyNow));
  return useMemo(() => ({ sol: sol.value, token: tokKeyNow ? tok.value : null, hasAta: tokKeyNow ? tok.hasAta === true : false, error: sol.error ?? (tokKeyNow ? tok.error : null) }), [sol, tok, tokKeyNow]);
}

/// A fresh read of `owner`'s SOL and its balance of `mint`, now, at least at its floor slot (one call, tried again as
/// any read is), for a trade about to be sized from it. Its answer also goes into the store. All null (and `hasAta`
/// false) when it could not be read: never a 0 that was not read.
export async function readBalancesNow(c: Connection, owner: PublicKey | string, mint: string, tokenProgram: string): Promise<{ sol: bigint | null; token: bigint | null; hasAta: boolean; slot: number }> {
  const o = typeof owner === "string" ? owner : owner.toBase58();
  if (!conn) conn = c;
  const sol = entryFor(o), tok = entryFor(o, mint, tokenProgram);
  const failed = { sol: null, token: null, hasAta: false, slot: 0 };
  if (tok.bad) return failed;
  sol.holds++; tok.holds++;
  try {
    for (let i = 0; ; i++) {
      try {
        const { slot, infos } = await fetchAccounts(c, [new PublicKey(o), tok.ata!], floor(o));
        apply([sol, tok], infos, slot);
        cancelRetry(o, slot);
        const s = readOf(sol, infos[0] ?? null), t = readOf(tok, infos[1] ?? null);
        return { sol: s.value, token: t.value, hasAta: t.value !== null && t.hasAta === true, slot };
      } catch (x) {
        // a rate limit is not waited out here: the trade is sized from this read, and says it could not be read
        if (i >= RETRY_MS.length || !retryable(x)) return failed;
        await sleep(RETRY_MS[i]);
      }
    }
  } finally {
    sol.holds--; tok.holds--;
    const now = Date.now();
    if (sol.subs.size === 0) sol.idleAt = now;
    if (tok.subs.size === 0) tok.idleAt = now;
  }
}

/// For tests only: a trade from the live stream, and a clean store.
export const balancesTesting = {
  trade: onTrade,
  reset() {
    stop();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    entries.clear(); owners.clear(); landedAt.clear(); landedSubs.clear(); dirty.clear();
    total = 0; conn = null; streamGapMs = STREAM_GAP_MS;
  },
  streamGap: (ms: number) => { streamGapMs = ms; },
  watch: (c: Connection, owner: string, mint: string | null, tokenProgram: string | null, cb: () => void) => watch(c, owner, mint, tokenProgram, cb),
  snap: (owner: string, mint?: string) => snapOf(mint ? tokKey(owner, mint) : solKey(owner)),
  timers: () => ({ poll: pollTimer !== null, retries: [...owners.values()].filter((s) => s.retry).length, trails: [...owners.values()].filter((s) => s.trail).length }),
};
