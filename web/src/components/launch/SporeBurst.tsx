// The success screen's one-shot spore burst: ~1.2 s of motes thrown out of the new coin's node on a
// canvas laid over the certificate, a soft shock ring, then nothing (the canvas unmounts). Lime,
// teal and violet motes with drag, fading as they slow. Never runs under reduced motion or the
// site's pause toggle; dpr is capped at 1.5.
import { useEffect, useRef, useState } from "react";
import { motionPaused } from "../../lib/motion";

const MS = 1200;
const COLORS = ["182,255,92", "92,224,200", "176,140,255", "234,255,196"];

/// `x`, `y`: the burst origin as fractions of the canvas box.
export default function SporeBurst({ x = 0.5, y = 0.5, n = 110 }: { x?: number; y?: number; n?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(() => motionPaused());
  useEffect(() => {
    const c = ref.current;
    if (done || !c) return;
    const g = c.getContext("2d");
    if (!g) { setDone(true); return; }
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    g.scale(dpr, dpr);
    const ox = w * x, oy = h * y, reach = Math.min(w, h * 1.6);
    const ps = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const v = reach * (0.35 + Math.random() * 0.9);
      return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.82 - reach * 0.06, r: 0.8 + Math.random() * 1.9, c: COLORS[i % COLORS.length], life: 0.55 + Math.random() * 0.45 };
    });
    let raf = 0, last = 0;
    const t0 = performance.now();
    const frame = (t: number) => {
      const u = (t - t0) / MS;
      if (u >= 1 || motionPaused()) { g.clearRect(0, 0, w, h); setDone(true); return; }
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
      last = t;
      g.clearRect(0, 0, w, h);
      g.globalCompositeOperation = "lighter";
      // the shock ring
      const ring = 1 - (1 - Math.min(1, u * 1.6)) ** 3;
      g.beginPath(); g.arc(ox, oy, 24 + ring * reach * 0.5, 0, Math.PI * 2);
      g.strokeStyle = `rgba(182,255,92,${(0.4 * (1 - Math.min(1, u * 1.6))).toFixed(3)})`; g.lineWidth = 1.25; g.stroke();
      for (const p of ps) {
        const k = Math.exp(-dt * 3.2);
        p.vx *= k; p.vy = p.vy * k + reach * 0.12 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        const a = Math.max(0, 1 - u / p.life);
        if (a <= 0) continue;
        g.beginPath(); g.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2); g.fillStyle = `rgba(${p.c},${(a * 0.12).toFixed(3)})`; g.fill();
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fillStyle = `rgba(${p.c},${(a * 0.95).toFixed(3)})`; g.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [done, x, y, n]);
  if (done) return null;
  return <canvas ref={ref} className="spore-burst" aria-hidden="true" />;
}
