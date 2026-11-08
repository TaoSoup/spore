// Warms the live server's logo thumbnails before the map3 logo gate (test/map3-flat.mts G1). Read-only GETs:
// GET <upstream>/api/map?scope=all&limit=all, then every family top's image plus the gen-1 children's images of the
// 60 biggest families (by descendants), each as <image>&w=64, at concurrency 24 and at most 60 req/s (the API allows
// 6,000/min per IP for /api/img). Prints, per pass, the status histogram, the share answered with x-img-thumb and the
// p50/p90 latency; then runs the same list a second time (warm) with the same stats.
//   node --import tsx test/map3-warm.mts [--upstream https://sporepad.com] [--w 64] [--families 60] [--conc 24] [--rps 60] [--out <file.json>]
import { writeFileSync } from "node:fs";
import { cli } from "./map3-cdp.mts";

const { opt } = cli();
const UP = (opt("--upstream", "https://sporepad.com") ?? "https://sporepad.com").replace(/\/$/, "");
const W = Number(opt("--w", "64")), FAMS = Number(opt("--families", "60")), CONC = Number(opt("--conc", "24")), RPS = Number(opt("--rps", "60"));
const OUT = opt("--out", null);
const UA = "spore-qa-warm";

type Coin = { mint: string; image?: string | null; descendants?: number; children?: number };
type Tree = { coin: Coin; children?: Tree[] };

const t0 = Date.now();
const map = await fetch(`${UP}/api/map?scope=all&limit=all`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60_000) }).then((r) => {
  if (!r.ok) throw new Error(`/api/map ${r.status}`);
  return r.json() as Promise<{ roots: Tree[] }>;
});
const roots = map.roots ?? [];
const imgOf = (c: Coin) => (c.image && c.image.startsWith("/api/img") ? c.image : null);
const urls = new Set<string>();
for (const r of roots) { const u = imgOf(r.coin); if (u) urls.add(u); }
const tops = urls.size;
const big = [...roots].sort((a, b) => (b.coin.descendants ?? b.coin.children ?? 0) - (a.coin.descendants ?? a.coin.children ?? 0)).slice(0, FAMS);
for (const r of big) for (const k of r.children ?? []) { const u = imgOf(k.coin); if (u) urls.add(u); }
const list = [...urls].map((u) => `${UP}${u}${u.includes("?") ? "&" : "?"}w=${W}`);
console.log(`map: ${roots.length} roots in ${Date.now() - t0} ms; ${tops} top images + ${list.length - tops} gen-1 child images of the ${big.length} biggest families = ${list.length} GETs (w=${W})`);

type Stat = { n: number; status: Record<string, number>; thumb: number; thumbShare: number; p50: number; p90: number; max: number; wallMs: number; s429: number };
async function pass(label: string): Promise<Stat> {
  const lat: number[] = [], status: Record<string, number> = {};
  let thumb = 0, next = 0, started = 0;
  const tStart = Date.now();
  const gate = async () => { // ≤ RPS starts per second
    for (;;) { const due = tStart + (started / RPS) * 1000; const wait = due - Date.now(); if (wait <= 0) break; await new Promise((ok) => setTimeout(ok, wait)); }
    started++;
  };
  const worker = async () => {
    while (next < list.length) {
      const u = list[next++];
      await gate();
      const t = performance.now();
      let code = "err";
      try {
        const r = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
        await r.arrayBuffer();
        code = String(r.status);
        if (r.headers.get("x-img-thumb")) thumb++;
      } catch (e) { code = (e as Error).name === "TimeoutError" ? "timeout" : "err"; }
      lat.push(performance.now() - t);
      status[code] = (status[code] ?? 0) + 1;
      if (lat.length % 500 === 0) console.log(`  ${label}: ${lat.length}/${list.length} in ${((Date.now() - tStart) / 1000).toFixed(0)} s · ${JSON.stringify(status)}`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  lat.sort((a, b) => a - b);
  const q = (f: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * f))] ?? 0);
  const s: Stat = { n: lat.length, status, thumb, thumbShare: lat.length ? +(thumb / lat.length).toFixed(4) : 0, p50: q(0.5), p90: q(0.9), max: Math.round(lat[lat.length - 1] ?? 0), wallMs: Date.now() - tStart, s429: status["429"] ?? 0 };
  console.log(`${label}: ${s.n} GETs in ${(s.wallMs / 1000).toFixed(1)} s · status ${JSON.stringify(s.status)} · x-img-thumb ${(s.thumbShare * 100).toFixed(1)}% · p50 ${s.p50} ms · p90 ${s.p90} ms · max ${s.max} ms`);
  return s;
}
const cold = await pass("pass 1 (cold)");
const warm = await pass("pass 2 (warm)");
const res = { upstream: UP, w: W, roots: roots.length, topImages: tops, childImages: list.length - tops, families: big.length, conc: CONC, rps: RPS, cold, warm, at: new Date().toISOString() };
if (OUT) writeFileSync(OUT, JSON.stringify(res, null, 1));
if (cold.s429 || warm.s429) { console.log(`FAIL: ${cold.s429 + warm.s429} HTTP 429`); process.exitCode = 1; }
