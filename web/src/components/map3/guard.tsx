// What keeps /map on the classic renderer when the WebGL map cannot or should not run (map3 README "Switching
// renderers"). Eager, tiny, no three: Map.tsx imports it next to probe.ts.
//
// - MapBoundary: an error boundary around the lazy ThreeMap. A render or effect exception inside the WebGL map
//   hands the page to the classic renderer (onFallback "mount-error") instead of the route's error page.
// - Sticky fallback: a device whose engine failed to mount or lost its context for good stays on the classic map
//   for STICKY_MS, so it does not download the chunk and fail again on every visit. The record carries the build
//   (the main chunk's URL, which changes with every deploy), so a fix that ships clears it for everyone. A chunk
//   that fails to load is not recorded: that is a deploy in progress, not a device problem.
// - Kill switch: /map-renderer.json (web/public, served from web/dist with a one-hour cache; read with no-store)
//   says {"renderer": "three" | "classic" | "desktop"}. "classic" turns the WebGL map off everywhere, "desktop"
//   turns it off on phones (container band <= 700 px or a coarse pointer). Editing the file on the server needs no
//   rebuild; the next deploy restores the file from web/public. A missing or broken file means "three". The last
//   value read is kept in localStorage, so a returning visitor starts on the right renderer without a flash.
// - ?renderer=three forces the WebGL map and clears the sticky record; ?renderer=classic forces the classic one.
// Every storage access is wrapped: private windows and blocked storage simply skip the memory.
import { Component, type ReactNode } from "react";
import type { FallbackReason } from "./types";

export const STICKY_MS = 24 * 3_600_000;
const STICKY_KEY = "spore:map3:fail";
const FLAG_KEY = "spore:map3:flag";
export const FLAG_URL = "/map-renderer.json";
export type RendererFlag = "three" | "classic" | "desktop";

/// The running build: the URL of the chunk this module is bundled into (hashed in production).
const BUILD = (() => { try { return String(import.meta.url); } catch { return "dev"; } })();
const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } };

/// Reasons worth remembering on this device (a chunk-load failure is a deploy race, a param or probe is re-read anyway).
const STICKY: ReadonlySet<FallbackReason> = new Set<FallbackReason>(["webgl", "mount-error", "context-lost"]);

/// The failure recorded for this build within STICKY_MS, or null.
export function stickyFailure(now = Date.now()): FallbackReason | null {
  const raw = get(STICKY_KEY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as { reason?: unknown; at?: unknown; build?: unknown };
    if (r.build === BUILD && typeof r.at === "number" && now - r.at < STICKY_MS && typeof r.reason === "string") return r.reason as FallbackReason;
  } catch { /* a broken record is dropped below */ }
  set(STICKY_KEY, null);
  return null;
}
export function rememberFailure(reason: FallbackReason, now = Date.now()) {
  if (STICKY.has(reason)) set(STICKY_KEY, JSON.stringify({ reason, at: now, build: BUILD }));
}
export const forgetFailure = () => set(STICKY_KEY, null);

const parseFlag = (v: unknown): RendererFlag => (v === "classic" || v === "desktop" ? v : "three");
/// The last kill-switch value this browser read ("three" when it never read one).
export const cachedFlag = (): RendererFlag => parseFlag(get(FLAG_KEY));
/// Reads the kill switch (no-store) and remembers it; "three" on any failure.
export async function fetchFlag(signal?: AbortSignal): Promise<RendererFlag> {
  let flag: RendererFlag = "three";
  try {
    const res = await fetch(FLAG_URL, { cache: "no-store", credentials: "same-origin", signal });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) flag = parseFlag(((await res.json()) as { renderer?: unknown } | null)?.renderer);
  } catch { if (signal?.aborted) return cachedFlag(); }
  set(FLAG_KEY, flag === "three" ? null : flag);
  return flag;
}
/// Whether a flag turns the WebGL map off for this screen.
export function flagOff(flag: RendererFlag): boolean {
  if (flag === "classic") return true;
  if (flag !== "desktop" || typeof window === "undefined") return false;
  let coarse = false;
  try { coarse = window.matchMedia("(pointer: coarse)").matches; } catch { coarse = false; }
  return window.innerWidth <= 700 || coarse;
}

type BoundaryProps = { onError: (detail: string) => void; children: ReactNode };
/// Catches what the WebGL map throws while rendering or in its effects; renders nothing after an error (the page
/// switches to the classic renderer through onError).
export class MapBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(error: unknown) { this.props.onError(error instanceof Error ? error.message : String(error)); }
  render() { return this.state.failed ? null : this.props.children; }
}
