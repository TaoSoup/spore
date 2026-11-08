// The last trade of a coin as the live stream saw it, for cards and rows that only want a pulse
// ("buy · 12s ago", a ring that lights once). One SSE subscription for the whole page; only mints
// that a mounted component asked for are tracked, and listeners are flushed at most once a second
// so a busy coin never re-renders a grid per trade. Numbers on cards still come from the API.
import { useCallback, useSyncExternalStore } from "react";
import { subscribe as subscribeEvents } from "./events";
import type { Trade } from "./api";

export type TradePulse = { seenAt: number /* ms */; time: number /* unix s, chain time */; isBuy: boolean; valueUsd: number | null; n: number /* trades seen since the page opened */ };

const pulses = new Map<string, TradePulse>();
const listeners = new Map<string, Set<() => void>>();
const dirty = new Set<string>();
let unsubscribe: (() => void) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 1_000;

function onTrade(t: Trade) {
  if (!listeners.has(t.mint)) return;
  const prev = pulses.get(t.mint);
  pulses.set(t.mint, { seenAt: Date.now(), time: t.time, isBuy: t.isBuy, valueUsd: t.valueUsd ?? null, n: (prev?.n ?? 0) + 1 });
  dirty.add(t.mint);
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}
function flush() {
  flushTimer = null;
  const mints = [...dirty];
  dirty.clear();
  for (const m of mints) listeners.get(m)?.forEach((f) => f());
}
function watch(mint: string, f: () => void) {
  let set = listeners.get(mint);
  if (!set) { set = new Set(); listeners.set(mint, set); }
  set.add(f);
  if (!unsubscribe) unsubscribe = subscribeEvents({ trade: onTrade });
  return () => {
    set!.delete(f);
    if (set!.size === 0) { listeners.delete(mint); pulses.delete(mint); }
    if (listeners.size === 0 && unsubscribe) { unsubscribe(); unsubscribe = null; }
  };
}

/// The latest trade seen for `mint` since the page opened, or null. Pass enabled=false (e.g. while
/// the card is off screen) to stop tracking it.
export function useTradePulse(mint: string | null | undefined, enabled = true): TradePulse | null {
  const key = enabled && mint ? mint : null;
  const sub = useCallback((f: () => void) => (key ? watch(key, f) : () => {}), [key]);
  const get = useCallback(() => (key ? pulses.get(key) ?? null : null), [key]);
  return useSyncExternalStore(sub, get, () => null);
}
