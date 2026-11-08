import { useEffect, useRef } from "react";
import { useEvents } from "../lib/events";
import { motionPaused, useMotionPref } from "../lib/motion";

/// `sy` is the screen y of the current frame (parallax applied), stored on the spore so a frame
/// allocates nothing.
type Spore = { x: number; y: number; sy: number; r: number; vx: number; vy: number; hue: number; phase: number; speed: number; near: boolean };
type Live = { x: number; y: number; born: number; phase: number };
const RGB = ["182,255,92", "176,140,255", "92,224,200"]; // lime, violet, teal
const LINK = 96;          // px: near spores closer than this get a faint connecting thread
const SPRITE = 48;        // base sprite radius; drawn scaled per spore
const PARALLAX = { far: 0.035, near: 0.11 };
const FRAME_MS = 33;      // 30 fps
const NEAR_ALPHA = 0.7, FAR_ALPHA = 0.42, THREAD_ALPHA = 0.14, BUCKETS = 8;
const STOP_AT = 1.5;      // screens of scroll after which the field parks on a still frame
const LIVE_R = 3.2, LIVE_RISE = 0.4, LIVE_MS = 6_000, LIVE_EVERY_MS = 3_000, LIVE_MAX = 3;

/* ---------- motion preference: lives in lib/motion.ts now; re-exported here so every existing
   import of these names from this file keeps working. */
export { MOTION_KEY, motionPaused, prefersReducedMotion, setMotionPaused, useMotionPref } from "../lib/motion";

/// One glow sprite per colour, rendered once: a drawImage per spore is far cheaper than a
/// radial gradient per spore per frame, which is what made the old canvas warm phones up.
function sprite(rgb: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const s = SPRITE * 2;
  c.width = c.height = s;
  const g = c.getContext("2d");
  if (!g) return c;
  const glow = g.createRadialGradient(SPRITE, SPRITE, 0, SPRITE, SPRITE, SPRITE);
  glow.addColorStop(0, `rgba(${rgb},.6)`);
  glow.addColorStop(0.3, `rgba(${rgb},.18)`);
  glow.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = glow; g.fillRect(0, 0, s, s);
  g.fillStyle = `rgba(${rgb},1)`; g.beginPath(); g.arc(SPRITE, SPRITE, SPRITE / 8, 0, Math.PI * 2); g.fill();
  return c;
}

/// Thread colours, precomputed per hue in alpha buckets so a frame never builds a colour string.
const THREAD_STYLES = RGB.map((rgb) => Array.from({ length: BUCKETS }, (_, i) => `rgba(${rgb},${(((i + 1) / BUCKETS) * THREAD_ALPHA).toFixed(3)})`));

/// Drifting glowing spores in two depth layers (far: small and dim, near: larger and brighter, each
/// with its own scroll parallax) plus faint threads between near neighbours near the top of the page.
/// Calm by design (redesign 2026-10-20): drawn at 30 fps, at most 90 spores (60 and no threads on
/// phones), the canvas fades as the reader scrolls and stops on a still frame past 1.5 screens. A new
/// launch on the event stream sends one bright lime spore up from the bottom edge. rAF stops while the
/// tab is hidden; a paused motion preference (OS or the footer toggle) gets one still frame; dpr is
/// capped at 1.5; resizes are debounced so a phone's address bar does not rebuild the field.
export default function SporeCanvas({ density = 1 }: { density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [paused] = useMotionPref();
  const onLaunch = useRef<() => void>(() => {});
  useEvents({ coin: () => onLaunch.current() });
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = paused;
    const sprites = RGB.map(sprite);
    let w = 0, h = 0, raf = 0, running = false, last = 0, phone = false, scrollY = window.scrollY, vh = window.innerHeight;
    let spores: Spore[] = [], near: Spore[] = [], resizeTimer = 0, lastLaunch = 0;
    const live: Live[] = [];
    const make = (fromBottom = false): Spore => {
      const isNear = Math.random() < 0.4;
      return {
        x: Math.random() * w, y: fromBottom ? h + 20 : Math.random() * h, sy: 0,
        r: isNear ? 1.6 + Math.random() * 1.8 : 0.6 + Math.random() * 0.9,
        vx: (Math.random() - 0.5) * (isNear ? 0.1 : 0.05), vy: -(isNear ? 0.06 + Math.random() * 0.14 : 0.03 + Math.random() * 0.06),
        hue: Math.random() < 0.18 ? 1 : Math.random() < 0.22 ? 2 : 0,
        phase: Math.random() * Math.PI * 2, speed: 0.4 + Math.random() * 0.8, near: isNear,
      };
    };
    // Screen y with parallax, wrapped so a scrolled page never empties the canvas.
    const screenY = (s: Spore) => { const span = h + 40; const y = (s.y - scrollY * (s.near ? PARALLAX.near : PARALLAX.far) + 20) % span; return (y < 0 ? y + span : y) - 20; };
    const draw = (t: number, k: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (const s of spores) {
        if (k > 0) {
          s.x += (s.vx + Math.sin(t * 0.0004 * s.speed + s.phase) * (s.near ? 0.14 : 0.06)) * k;
          s.y += s.vy * k;
          if (s.y < -20) { const near0 = s.near; Object.assign(s, make(true)); s.near = near0; }
          if (s.x < -20) s.x = w + 20; else if (s.x > w + 20) s.x = -20;
        }
        s.sy = screenY(s);
      }
      // Threads only on wide screens and only while the top of the page is in view.
      if (!phone && scrollY < vh * 0.6) {
        ctx.lineWidth = 1;
        for (let i = 0; i < near.length; i++) {
          const a = near[i];
          for (let j = i + 1; j < near.length; j++) {
            const b = near[j];
            const dx = a.x - b.x, dy = a.sy - b.sy;
            const d2 = dx * dx + dy * dy;
            if (d2 > LINK * LINK) continue;
            const bucket = Math.min(BUCKETS - 1, Math.floor((1 - Math.sqrt(d2) / LINK) * BUCKETS));
            ctx.strokeStyle = THREAD_STYLES[a.hue][bucket];
            ctx.beginPath(); ctx.moveTo(a.x, a.sy); ctx.lineTo(b.x, b.sy); ctx.stroke();
          }
        }
      }
      for (const s of spores) {
        const twinkle = k === 0 ? 0.8 : 0.55 + 0.45 * Math.sin(t * 0.0012 * s.speed + s.phase);
        ctx.globalAlpha = twinkle * (s.near ? NEAR_ALPHA : FAR_ALPHA);
        const size = s.r * 16;
        ctx.drawImage(sprites[s.hue], s.x - size / 2, s.sy - size / 2, size, size);
      }
      // Launch spores: screen space, no parallax; rise at twice the near speed and fade over 6 s.
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        const age = t - p.born;
        if (age > LIVE_MS || p.y < -30) { live.splice(i, 1); continue; }
        p.y -= LIVE_RISE * k;
        p.x += Math.sin(age * 0.0015 + p.phase) * 0.25 * k;
        ctx.globalAlpha = Math.min(1, age / 300) * (1 - age / LIVE_MS);
        const size = LIVE_R * 16;
        ctx.drawImage(sprites[0], p.x - size / 2, p.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };
    const resize = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      w = canvas.clientWidth; h = canvas.clientHeight; vh = window.innerHeight;
      phone = w < 760;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const area = (w * h) / 14_000;
      const n = Math.max(0, Math.round((phone ? Math.min(60, area) : Math.min(90, Math.max(32, area))) * density));
      spores = Array.from({ length: n }, () => make());
      near = spores.filter((s) => s.near);
      live.length = 0;
      if (!running) draw(performance.now(), 0);
    };
    // Far down a long page the field is barely visible: draw one still frame and stop until the reader
    // scrolls back up.
    const parked = () => scrollY > vh * STOP_AT;
    const loop = (t: number) => {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      const dt = t - last;
      if (dt < FRAME_MS) return;
      last = t;
      draw(t, Math.min(dt, 100) / 16.7);
    };
    const start = () => { if (running || still || document.hidden || parked()) return; running = true; last = performance.now(); raf = requestAnimationFrame(loop); };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    const fade = () => { canvas.style.opacity = String(Math.max(0.15, 1 - scrollY / (vh * 0.9))); };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onScroll = () => {
      scrollY = window.scrollY;
      fade();
      if (parked()) { if (running) { stop(); draw(performance.now(), 0); } }
      else if (!running && !still) start();
      else if (still) draw(0, 0);
    };
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(resize, 120); };
    onLaunch.current = () => {
      const now = performance.now();
      if (!running || motionPaused() || now - lastLaunch < LIVE_EVERY_MS || live.length >= LIVE_MAX) return;
      lastLaunch = now;
      live.push({ x: w / 2 + (Math.random() - 0.5) * 40, y: h + 12, born: now, phase: Math.random() * Math.PI * 2 });
    };
    fade();
    resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => { stop(); onLaunch.current = () => {}; clearTimeout(resizeTimer); window.removeEventListener("resize", onResize); window.removeEventListener("scroll", onScroll); document.removeEventListener("visibilitychange", onVisibility); };
  }, [density, paused]);
  return <canvas ref={ref} className="spores" aria-hidden="true" />;
}
