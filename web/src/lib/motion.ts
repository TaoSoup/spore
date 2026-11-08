// The motion system (DESIGN-ELEVATE §5): the site-wide motion preference and a few small utilities
// every animated surface shares. No dependency: requestAnimationFrame, IntersectionObserver and CSS.
//
// Two switches turn motion off: the OS setting (prefers-reduced-motion) and the footer's "pause
// animations" toggle (html[data-motion="paused"], stored in localStorage). index.html applies the
// stored toggle before the first paint; this module keeps it current and lets React subscribe.
// Under either, loops stop on one still frame and tweens jump to their end.
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

/* ---------- motion preference (moved from components/SporeCanvas.tsx, which re-exports it) */

/** localStorage key of the footer's pause toggle; "paused" when set. */
export const MOTION_KEY = "spore:motion";
const listeners = new Set<() => void>();
const reducedQuery = () => (typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-reduced-motion: reduce)") : null);
const readStored = () => { try { return localStorage.getItem(MOTION_KEY) === "paused"; } catch { return false; } };
let userPaused = readStored();
const apply = () => { if (typeof document !== "undefined") document.documentElement.dataset.motion = userPaused ? "paused" : "on"; };
/** Whether the OS asks for reduced motion right now. */
export const prefersReducedMotion = () => reducedQuery()?.matches ?? false;
/** True when nothing should move: the user's pause toggle or the OS preference. Cheap; call it per frame if needed. */
export const motionPaused = () => userPaused || prefersReducedMotion();
/** Sets the footer toggle (persisted), updates html[data-motion] and notifies every subscriber. */
export function setMotionPaused(v: boolean) {
  userPaused = v;
  try { if (v) localStorage.setItem(MOTION_KEY, "paused"); else localStorage.removeItem(MOTION_KEY); } catch { /* private mode: the choice lasts for the session */ }
  apply();
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  const q = reducedQuery();
  q?.addEventListener("change", l);
  return () => { listeners.delete(l); q?.removeEventListener("change", l); };
}
/** [paused, reducedByOS, setPaused]: re-renders when either switch changes. `paused` already includes the OS preference. */
export function useMotionPref(): [boolean, boolean, (v: boolean) => void] {
  const paused = useSyncExternalStore(subscribe, motionPaused, () => false);
  const reduced = useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
  return [paused, reduced, setMotionPaused];
}
apply();

/* ---------- in view */

/**
 * IntersectionObserver-backed visibility. Returns [ref, inView]. With `once` (default true) the flag
 * latches the first time the element enters; with `once: false` it follows the element in and out.
 * Without IntersectionObserver the element counts as visible.
 *
 * The ref is a stable object whose `current` is backed by state, so an element that mounts later
 * (after a loading state, behind a condition) or is swapped for another is observed too.
 */
export function useInView<T extends Element>(opts: { rootMargin?: string; threshold?: number; once?: boolean } = {}): [RefObject<T | null>, boolean] {
  const { rootMargin = "0px 0px -8% 0px", threshold = 0.12, once = true } = opts;
  const [el, setEl] = useState<T | null>(null);
  const [ref] = useState<RefObject<T | null>>(() => {
    let node: T | null = null;
    return {
      get current() { return node; },
      set current(v: T | null) { if (v !== node) { node = v; setEl(v); } },
    };
  });
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { setInView(true); if (once) io.disconnect(); }
        else if (!once) setInView(false);
      }
    }, { rootMargin, threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [el, rootMargin, threshold, once]);
  return [ref, inView];
}

/* ---------- pointer */

/** Live pointer state: x/y as 0..1 of the viewport (lerped), vx/vy in viewport fractions per second. */
export type PointerState = { x: number; y: number; vx: number; vy: number };
const pointer: PointerState = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
const target = { x: 0.5, y: 0.5 };
let pointerUsers = 0, pointerRaf = 0, pointerLast = 0;
const onPointerMove = (e: PointerEvent) => { target.x = e.clientX / Math.max(1, window.innerWidth); target.y = e.clientY / Math.max(1, window.innerHeight); if (!pointerRaf) pointerRaf = requestAnimationFrame(pointerTick); };
function pointerTick(t: number) {
  const dt = Math.min(0.1, pointerLast ? (t - pointerLast) / 1000 : 1 / 60);
  pointerLast = t;
  const k = 1 - Math.exp(-dt * 10);
  const nx = pointer.x + (target.x - pointer.x) * k, ny = pointer.y + (target.y - pointer.y) * k;
  pointer.vx = dt > 0 ? (nx - pointer.x) / dt : 0; pointer.vy = dt > 0 ? (ny - pointer.y) / dt : 0;
  pointer.x = nx; pointer.y = ny;
  if (Math.abs(target.x - nx) + Math.abs(target.y - ny) > 0.0005) pointerRaf = requestAnimationFrame(pointerTick);
  else { pointerRaf = 0; pointerLast = 0; pointer.vx = pointer.vy = 0; }
}
/**
 * The global pointer, shared by the whole app (one listener, attached while any component uses it).
 * Returns a live object whose fields update without re-rendering: read it inside a rAF loop.
 */
export function usePointer(): PointerState {
  useEffect(() => {
    if (pointerUsers++ === 0) window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => { if (--pointerUsers === 0) { window.removeEventListener("pointermove", onPointerMove); cancelAnimationFrame(pointerRaf); pointerRaf = 0; } };
  }, []);
  return pointer;
}

/* ---------- rAF loop */

/**
 * A requestAnimationFrame loop calling fn(dt seconds, t ms). It runs only while the tab is visible,
 * motion is not paused, `enabled` is not false and (when `el` is given) the element is on screen.
 * `fps` caps the rate (e.g. 30). When it stops, nothing else is drawn: draw a still frame yourself.
 */
export function useRafLoop(fn: (dt: number, t: number) => void, opts: { el?: RefObject<Element | null>; fps?: number; enabled?: boolean } = {}): void {
  const { el, fps, enabled = true } = opts;
  const cb = useRef(fn);
  useEffect(() => { cb.current = fn; });
  const [paused] = useMotionPref();
  useEffect(() => {
    if (!enabled || paused) return;
    let raf = 0, last = 0, visible = !el, running = false;
    const minMs = fps ? 1000 / fps - 1 : 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (!last) { last = t; return; }
      const d = t - last;
      if (d < minMs) return;
      last = t;
      cb.current(Math.min(d, 100) / 1000, t);
    };
    const sync = () => {
      const want = visible && !document.hidden;
      if (want && !running) { running = true; last = 0; raf = requestAnimationFrame(frame); }
      else if (!want && running) { running = false; cancelAnimationFrame(raf); }
    };
    let io: IntersectionObserver | null = null;
    const node = el?.current;
    if (node && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); sync(); });
      io.observe(node);
    } else visible = true;
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => { running = false; cancelAnimationFrame(raf); io?.disconnect(); document.removeEventListener("visibilitychange", sync); };
  }, [el, fps, enabled, paused]);
}

/* ---------- spring */

/**
 * One step of a damped spring (semi-implicit Euler, sub-stepped for stability).
 * Returns [position, velocity]. Defaults are near critically damped for a unit mass.
 */
export function spring(pos: number, vel: number, target: number, dt: number, stiffness = 170, damping = 26): [number, number] {
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const a = -stiffness * (pos - target) - damping * vel;
    vel += a * h;
    pos += vel * h;
  }
  return [pos, vel];
}

/* ---------- count up */

/**
 * Counts the element's text from 0 (or its current data-value) up to `to` with an ease-out over `ms`.
 * Under paused motion it writes the final value at once. Returns a cancel function.
 */
export function countUp(el: HTMLElement, to: number, format: (n: number) => string, ms = 900): () => void {
  const fromAttr = Number(el.dataset.value);
  const from = Number.isFinite(fromAttr) ? fromAttr : 0;
  el.dataset.value = String(to);
  if (motionPaused() || !Number.isFinite(to) || from === to) { el.textContent = format(to); return () => {}; }
  let raf = 0;
  const t0 = performance.now();
  const step = (t: number) => {
    const u = Math.min(1, (t - t0) / ms), e = 1 - (1 - u) ** 4;
    el.textContent = format(from + (to - from) * e);
    if (u < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => { cancelAnimationFrame(raf); el.textContent = format(to); };
}

/** Whether the primary pointer is coarse (touch): tilt and hover-only effects stay off there. */
export const coarsePointer = () => typeof window !== "undefined" && "matchMedia" in window && window.matchMedia("(pointer: coarse)").matches;
