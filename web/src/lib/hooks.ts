import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Connection, PublicKey } from "@solana/web3.js";
import { api, errorMessage, type Stats } from "./api";
import { subscribe as subscribeEvents } from "./events";

export type Async<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void; setData: (f: (d: T | null) => T | null) => void };

/// Load-per-deps with a stale-result guard. When the deps change (another coin, another sort)
/// the old data is dropped and the skeleton shows, so a page never displays the previous
/// record under a new URL; `reload()` keeps what is on screen and swaps it when the new result
/// lands, so retries and periodic refreshes never flash.
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const key = JSON.stringify(deps);
  const lastKey = useRef(key);
  useEffect(() => {
    let alive = true;
    if (lastKey.current !== key) { lastKey.current = key; setDataState(null); setError(null); setLoading(true); }
    else setLoading((l) => l || data === null);
    fnRef.current().then((d) => { if (alive) { setDataState(d); setError(null); setLoading(false); } })
      .catch((e) => { if (alive) { setError(errorMessage(e)); setLoading(false); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((f: (d: T | null) => T | null) => setDataState(f), []);
  return { data, error, loading, reload, setData };
}

/// Re-render on an interval, for ages ("12s ago") that must tick without refetching.
export function useTick(ms = 10_000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(t); }, [ms]);
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, set] = useState(value);
  useEffect(() => { const t = setTimeout(() => set(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/* ---------- global stats: one module-level store shared by the nav, the footer and every page.
   One fetch when the first subscriber mounts, a 60 s poll only while the tab is visible (a tab coming
   back after a minute or more refetches at once), and SSE "stats" events update every subscriber. */
type StatsState = { stats: Stats | null; error: string | null };
const STATS_POLL_MS = 60_000;
let statsState: StatsState = { stats: null, error: null };
const statsSubs = new Set<() => void>();
let statsTimer: ReturnType<typeof setInterval> | null = null;
let statsSse: (() => void) | null = null;
let statsAt = 0;
let statsBusy = false;
const setStats = (next: StatsState) => { statsState = next; statsSubs.forEach((f) => f()); };
function fetchStats() {
  if (statsBusy) return;
  statsBusy = true;
  api.stats()
    .then((s) => { statsAt = Date.now(); setStats({ stats: s, error: null }); })
    .catch((e) => setStats({ stats: statsState.stats, error: errorMessage(e) }))
    .finally(() => { statsBusy = false; });
}
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
function syncPoll() {
  const want = statsSubs.size > 0 && visible();
  if (want && !statsTimer) {
    statsTimer = setInterval(fetchStats, STATS_POLL_MS);
    if (statsAt && Date.now() - statsAt >= STATS_POLL_MS) fetchStats();
  } else if (!want && statsTimer) { clearInterval(statsTimer); statsTimer = null; }
}
function subscribeStats(f: () => void) {
  statsSubs.add(f);
  if (statsSubs.size === 1) {
    fetchStats();
    statsSse = subscribeEvents({ stats: (s) => { statsAt = Date.now(); setStats({ stats: s, error: null }); } });
    document.addEventListener("visibilitychange", syncPoll);
    syncPoll();
  }
  return () => {
    statsSubs.delete(f);
    if (statsSubs.size > 0) return;
    statsSse?.(); statsSse = null;
    document.removeEventListener("visibilitychange", syncPoll);
    syncPoll();
  };
}
const statsSnapshot = () => statsState;

/// Global stats ({ stats, error }) from the shared store above. The argument is accepted for older
/// callers and ignored: there is one poll for the whole app.
export function useStats(_intervalMs?: number): StatsState {
  return useSyncExternalStore(subscribeStats, statsSnapshot, statsSnapshot);
}

/// Persist a small per-browser preference (slippage, chart resolution). Storage may be blocked in
/// private mode, so every access is guarded and the default wins.
export function useLocalPref<T extends string | number>(key: string, initial: T): [T, (v: T) => void] {
  const [v, set] = useState<T>(() => {
    try { const raw = localStorage.getItem(`spore:${key}`); if (raw !== null) return (typeof initial === "number" ? Number(raw) : raw) as T; } catch { /* private mode */ }
    return initial;
  });
  const setPref = useCallback((n: T) => { set(n); try { localStorage.setItem(`spore:${key}`, String(n)); } catch { /* ignore */ } }, [key]);
  return [v, setPref];
}

/// The connected wallet's SOL balance in lamports (null until known or when no wallet). Polled so
/// a top-up made in the wallet shows up without a reload; `refresh` is for right after a spawn.
export function useSolBalance(conn: Connection, owner: PublicKey | null, intervalMs = 20_000): { lamports: bigint | null; error: string | null; refresh: () => void } {
  const [lamports, setLamports] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = owner?.toBase58() ?? null;
  useEffect(() => {
    if (!owner) { setLamports(null); setError(null); return; }
    let alive = true;
    const tick = () => conn.getBalance(owner, "confirmed").then((n) => { if (alive) { setLamports(BigInt(n)); setError(null); } }).catch((e) => { if (alive) setError(errorMessage(e)); });
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, key, intervalMs, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { lamports, error, refresh };
}

/// `true` while the media query matches; the coin page swaps the sidebar trade widget for a sticky
/// bar + bottom sheet on narrow screens, and rendering only one of them keeps a single set of
/// balance polls and quotes alive.
export function useMediaQuery(query: string): boolean {
  const [m, set] = useState(() => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => set(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

/// Current unix seconds, re-read every `ms`: relative times ("12s") and quote ages tick without
/// a refetch, and every consumer in the tree shares one interval per component.
export function useNow(ms = 1_000): number {
  const [now, set] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => set(Math.floor(Date.now() / 1000)), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/// Clipboard write with the textarea fallback for contexts where the async API is unavailable
/// (http dev origins, older WebViews). Resolves true when the text was copied.
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/// Locks page scroll while a sheet/modal is open (restores the previous value on close).
export function useScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [locked]);
}
