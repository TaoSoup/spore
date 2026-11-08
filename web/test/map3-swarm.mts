// map3 swarm gates (DESIGN-FAMILY-ALL.md §7, engine): every coin of a capped asset family as ghost / real dust.
// Prints a | gate | check | status | value | need | table, writes <out>/map3-swarm.json and the look pairs into <out>/look.
//
//   node --import tsx test/make-swarm-fixture.mts --from <live map.json> --out <fx>
//   node --import tsx test/serve-prod.mts --dist <dist> --port <p> --upstream http://127.0.0.1:8795 --fixture <fx>
//   node --import tsx test/map3-swarm.mts --url http://127.0.0.1:<p> --prod --out <dir> [--only look,perf,phone,sw,build,mem,correct]
//       [--gpus metal,swiftshader] [--look galaxy|flat] [--ms 3000]
//
// Sections (each opens its own Chrome; --only picks):
//   look     metal 1440x900 @1 (+ phone 390x844 @2): the same frame with the layer hidden / shown (debug swarmShow), at the
//            overview, $PUMP 4x, $PUMP 12x and deep $USDC, plus the phone overview. Outside every asset family's screen disc
//            >= 99.5 % of pixels within +-2 per channel; inside the discs mean luma +<= 14 sRGB levels (overview), +<= 20 (4x);
//            lime / violet share inside the discs within +-10 % (or +-0.002 absolute when tiny). Pairs + side-by-side PNGs.
//   perf     metal 1440x900 @1 and @2: measure(ms, idle|pan|zoom|hover) p95 <= 17.5 ms at the overview (Σ ghost >= 300k) and at
//            $PUMP 4x / 12x with the family's slots filled by real specks (swarmSynth: the same swarmAdd path).
//   phone    390x844 @2 (metal, the only proxy): overview / 4x fps >= 58; swarm() ghostShown <= 5k and real <= 20k per family.
//   sw       swiftshader 1440x900 @1, overview: frame p95 <= 1.10 x the same build with ?swarm=0.
//   build    metal @1, ?swarm=0 vs on (two mounts each): buildMs / firstFrameMs <= baseline + 50 ms; gl() geometries,
//            programs, textures +1; genSliceMaxMs <= 8, addSliceMaxMs <= 4; no long task >= 50 ms after the first frame
//            through the generation and 3 family loads; builds() unchanged.
//   mem      metal @1: heap after PUMP 76k, USDC 41k, SPCX 17k <= baseline + 60 MB; a 4th family after dropping the first:
//            heap after GC within 10 MB of the 3-family peak minus the dropped family.
//   correct  swarmCheck outside 0, onDrawn <= 1 % of slots, overlaps reported, hash equal across two mounts; Σ ghost + N =
//            __sporeMapPage.indexed().derived (when the page exposes it); with the family endpoint (live, or the mock below
//            when the API answers 404): a loaded speck is known, a clicked speck opens the side panel with its mint, a
//            ?focus= of an unloaded speck flies once its chunk lands, no rebuild through the loads.
// The family-endpoint mock (only when GET /api/map/family/<PUMP> is 404 upstream) answers the fixture's drawn kids first, then
// deterministic base58 mints for the undrawn coins, paged like the server (limit, offset, next, v).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pngjs from "pngjs";
import { INSET_RECT_JS, RAF_PROBE, SETTLED_JS, cli, launchChrome, mapReadyJs, rafStatsJs, sleep, withDebug, type Browser, type GpuMode, type Page } from "./map3-cdp.mts";

const { opt, has } = cli();
const BASE = opt("--url", "http://127.0.0.1:5342")!.replace(/\/$/, "");
const PROD = has("--prod");
const OUT = opt("--out", join(process.env.SPORE_TMP ?? "/tmp", "spore-map3-swarm"))!;
const ONLY = new Set((opt("--only", "") ?? "").split(",").filter(Boolean));
const MS = Number(opt("--ms", "3000"));
const FIXTURE = opt("--fixture", "");   // the fixture dir (for the endpoint mock's drawn kids); optional
const on = (s: string) => ONLY.size === 0 || ONLY.has(s);
mkdirSync(OUT, { recursive: true }); mkdirSync(join(OUT, "look"), { recursive: true });
const J = JSON.stringify;
const u = (path: string) => withDebug(path, PROD);
const r2 = (v: number) => Math.round(v * 100) / 100;

type Status = "PASS" | "FAIL" | "N/A" | "INFO";
type Row = { gate: string; check: string; status: Status; value: unknown; need: string };
const rows: Row[] = [];
const raw: Record<string, unknown> = { url: BASE, startedAt: new Date().toISOString() };
const row = (gate: string, check: string, status: Status, value: unknown, need: string) => { rows.push({ gate, check, status, value, need }); console.log(`  ${status.padEnd(4)} ${gate} ${check}: ${typeof value === "string" ? value : J(value)} (need ${need})`); };
const num = (gate: string, check: string, v: number | null | undefined, ok: (x: number) => boolean, need: string) => {
  if (v === null || v === undefined || !Number.isFinite(v)) row(gate, check, "N/A", "n/a", need); else row(gate, check, ok(v) ? "PASS" : "FAIL", r2(v), need);
};
const browsers: Browser[] = [];

async function open(gpu: GpuMode, w: number, h: number, dpr: number, path = "/map", prelude: string[] = []): Promise<{ b: Browser; p: Page }> {
  const mobile = w < 700;
  const b = await launchChrome({ gpu, width: w, height: h, dpr, mobile, touch: mobile });
  browsers.push(b);
  const p = await b.newPage({ width: w, height: h, dpr, mobile, touch: mobile, prelude });
  await mockFamilies(p);
  await p.navigate(BASE + u(path), 120_000);
  await p.waitFor(mapReadyJs("three"), 240_000, `three map on ${path}`);
  return { b, p };
}
async function settle(p: Page, extra = 1200) { await p.waitFor(SETTLED_JS, 60_000, "settle").catch(() => null); await sleep(extra); }
const swarmReady = (p: Page) => p.waitFor(`(() => { const s = __sporeMap.swarm(); return !!s && s.state === "done" && s.fade >= 1; })()`, 60_000, "swarm generated").catch(() => null);
const swarm = (p: Page) => p.evalJs<Record<string, any> | null>("__sporeMap.swarm()");
const topOf = (p: Page, sym: string) => p.evalJs<string | null>(`(() => { const c = __sporeMap.clusters(100000).find((f) => f.title === ${J("$" + sym)}); return c ? c.root : null; })()`);
const close = async (b: Browser) => { await b.close().catch(() => null); const i = browsers.indexOf(b); if (i >= 0) browsers.splice(i, 1); };

// ------------------------------------------------------------------ the family endpoint mock (when the API has none)
let mockOn: boolean | null = null;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeMint = (top: string, q: number) => { let h = 2166136261 >>> 0, s = ""; const key = `${top}:${q}`; for (let i = 0; i < 44; i++) { for (let c = 0; c < key.length; c++) h = Math.imul(h ^ key.charCodeAt(c) ^ i, 16777619) >>> 0; s += B58[h % 58]; } return s; };
let fxBody: { roots: { coin: Record<string, any>; children?: { coin: Record<string, any> }[] }[] } | null = null;
async function mockFamilies(p: Page) {
  if (mockOn === null) {
    const r = await fetch(`${BASE}/api/map/family/pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn?limit=1`).catch(() => null);
    mockOn = !r || r.status === 404;
    raw.familyEndpoint = mockOn ? "mock (upstream 404)" : `live (${r!.status})`;
    if (mockOn) {
      const f = FIXTURE && existsSync(join(FIXTURE, "map.json")) ? join(FIXTURE, "map.json") : null;
      fxBody = f ? JSON.parse(readFileSync(f, "utf8")) : await (await fetch(`${BASE}/api/map?scope=all&limit=all`)).json();
    }
  }
  if (!mockOn || !fxBody) return;
  const byTop = new Map(fxBody.roots.map((r) => [r.coin.mint as string, r]));
  // the coins of the mock exist nowhere else: their light /api/coin (the panel's numbers, and what tells the page the
  // coin is quoted in an on-map asset) answers from the mock too
  const fakeOf = new Map<string, { top: string; j: number }>();
  for (const r of fxBody.roots) if (r.coin.asset) for (let j = 0; j < 64; j++) fakeOf.set(fakeMint(r.coin.mint as string, j), { top: r.coin.mint as string, j });
  await p.intercept(["*/api/map/family/*", "*/api/coin/*"], async (ev) => {
    const url = new URL(ev.request.url), m = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (url.pathname.startsWith("/api/coin/")) {
      const f = fakeOf.get(m);
      if (!f) { await p.pass(ev.requestId); return; }
      const t = byTop.get(f.top)!.coin;
      const coin = { mint: m, name: null, symbol: `G${f.j}`, image: null, description: null, twitter: null, telegram: null, website: null, creator: "11111111111111111111111111111111", quoteMint: f.top, quoteSymbol: t.symbol ?? "?",
        depth: 1, parent: { mint: f.top, name: t.name ?? null, symbol: t.symbol ?? null, image: null, depth: 0 }, root: { mint: f.top, name: t.name ?? null, symbol: t.symbol ?? null, image: null, depth: 0 }, ancestors: [],
        complete: false, migrated: false, pool: null, createdAt: 1792800000, createdSlot: null, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 6, totalSupply: "1000000000000000",
        priceQuote: null, priceSol: null, priceUsd: null, mcapSol: null, mcapUsd: 4100, progress: 0, children: 0, descendants: 0, lockedQuote: "0", lockedUsd: null, volume24hUsd: 0, trades24h: 0,
        holderReward: false, creatorFeeBps: 0, shares: null, updatedAt: Date.now() };
      await p.fulfill(ev.requestId, 200, J({ coin, children: [], trades: [] }));
      return;
    }
    const r = byTop.get(m);
    if (!r) { await p.fulfill(ev.requestId, 404, J({ error: "unknown family" })); return; }
    const kids = (r.children ?? []).map((k) => k.coin).sort((a, b) => (b.lockedUsd ?? -1) - (a.lockedUsd ?? -1) || (b.mcapUsd ?? -1) - (a.mcapUsd ?? -1));
    const total = Math.max(kids.length, Number(r.coin.children) || 0);
    const off = Math.max(0, Number(url.searchParams.get("offset") ?? 0)), lim = Math.max(1, Math.min(10000, Number(url.searchParams.get("limit") ?? 5000)));
    const nodes: unknown[] = [];
    for (let q = off; q < Math.min(total, off + lim); q++) {
      if (q < kids.length) { const c = kids[q]; nodes.push([c.mint, c.symbol ?? null, c.mcapUsd ?? null, c.lockedUsd ?? null, c.createdAt ?? null, c.migrated ? 1 : 0, c.children ?? 0]); }
      else { const j = q - kids.length; nodes.push([fakeMint(m, j), `G${j}`, +(4100 - 1500 * j / Math.max(1, total)).toFixed(1), null, 1792800000 - j * 37, 0, 0]); }
    }
    await p.fulfill(ev.requestId, 200, J({ mint: m, v: 1, total, offset: off, next: off + nodes.length < total ? off + nodes.length : null, nodes }));
  });
}

// ------------------------------------------------------------------ pixels
type Img = { w: number; h: number; d: Buffer };
const readPng = (file: string): Img => { const png = pngjs.PNG.sync.read(readFileSync(file)); return { w: png.width, h: png.height, d: png.data }; };
const luma = (d: Buffer, o: number) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
const isLime = (r: number, g: number, b: number) => g >= 120 && g - r >= 20 && g - b >= 40;
const isViolet = (r: number, g: number, b: number) => b - g >= 24 && r >= g && Math.max(r, g, b) >= 56;
type Disc = { x: number; y: number; r: number };
function compare(off: Img, onI: Img, discs: Disc[], rect: { x0: number; y0: number; x1: number; y1: number }, scale: number) {
  const inDisc = (x: number, y: number) => { for (const c of discs) { const dx = x / scale - c.x, dy = y / scale - c.y; if (dx * dx + dy * dy <= c.r * c.r) return true; } return false; };
  let outN = 0, outSame = 0, inN = 0, lumOff = 0, lumOn = 0, limeOff = 0, limeOn = 0, vioOff = 0, vioOn = 0, maxDiffOut = 0;
  for (let y = 0; y < off.h; y++) for (let x = 0; x < off.w; x++) {
    const o = (y * off.w + x) * 4, a = off.d, b = onI.d;
    // outside = no asset disc covers the pixel (page chrome over a disc counts as inside); the inside stats keep to the
    // map's inset rect
    const disc = inDisc(x, y), inRect = x / scale >= rect.x0 && x / scale <= rect.x1 && y / scale >= rect.y0 && y / scale <= rect.y1;
    if (!disc) {
      outN++; const dm = Math.max(Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2]));
      if (dm <= 2) outSame++; if (dm > maxDiffOut) maxDiffOut = dm;
    } else if (inRect) {
      inN++; lumOff += luma(a, o); lumOn += luma(b, o);
      if (isLime(a[o], a[o + 1], a[o + 2])) limeOff++; if (isLime(b[o], b[o + 1], b[o + 2])) limeOn++;
      if (isViolet(a[o], a[o + 1], a[o + 2])) vioOff++; if (isViolet(b[o], b[o + 1], b[o + 2])) vioOn++;
    }
  }
  return { outN, outSame: outN ? outSame / outN : 1, maxDiffOut, inN, lumOff: inN ? lumOff / inN : 0, lumOn: inN ? lumOn / inN : 0, dLum: inN ? (lumOn - lumOff) / inN : 0,
    limeOff: inN ? limeOff / inN : 0, limeOn: inN ? limeOn / inN : 0, vioOff: inN ? vioOff / inN : 0, vioOn: inN ? vioOn / inN : 0 };
}
function sideBySide(a: Img, b: Img, file: string) {
  const png = new pngjs.PNG({ width: a.w * 2 + 8, height: a.h });
  png.data.fill(255);
  for (let y = 0; y < a.h; y++) { a.d.copy(png.data, (y * png.width) * 4, y * a.w * 4, (y + 1) * a.w * 4); b.d.copy(png.data, (y * png.width + a.w + 8) * 4, y * b.w * 4, (y + 1) * b.w * 4); }
  writeFileSync(file, pngjs.PNG.sync.write(png));
}
const shareOk = (a: number, b: number) => Math.abs(b - a) <= Math.max(0.1 * a, 0.002);

/// One A/B at the current camera: hide the layer, shoot, show it, shoot; the asset discs from the engine.
async function lookPair(p: Page, name: string, scale: number) {
  const offF = join(OUT, "look", `${name}-off.png`), onF = join(OUT, "look", `${name}-on.png`), off2F = join(OUT, "look", `${name}-off2.png`);
  await p.evalJs(`__sporeMap.call("swarmShow", false)`); await sleep(400); await p.shot(offF);
  await sleep(400); await p.shot(off2F);   // the noise floor: two frames without the layer
  await p.evalJs(`__sporeMap.call("swarmShow", true)`); await sleep(400); await p.shot(onF);
  const discs = await p.evalJs<Disc[]>(`(() => { const out = []; for (const f of __sporeMap.swarmFamilies()) { const s = __sporeMap.familyScreen(f.top); if (s) out.push({ x: s.x, y: s.y, r: s.r }); } return out; })()`);
  const rect = await p.evalJs<{ x0: number; y0: number; x1: number; y1: number }>(INSET_RECT_JS);
  const a = readPng(offF), b = readPng(onF);
  sideBySide(a, b, join(OUT, "look", `${name}-pair.png`));
  const c = compare(a, b, discs, rect, scale), noise = compare(a, readPng(off2F), discs, rect, scale);
  return { ...c, discs: discs.length, files: [offF, onF], noiseOutSame: noise.outSame, noiseDLum: noise.dLum };
}

// ------------------------------------------------------------------ sections
/// The look pairs are taken with prefers-reduced-motion emulated (the page switches the engine live): the dust field's
/// drift, the live coins' breathing and the trade pulses would otherwise differ between the two frames of a pair.
const still = (p: Page) => p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
async function sectionLook() {
  console.log("[look] metal 1440x900 @1");
  const { b, p } = await open("metal", 1440, 900, 1);
  try {
    await still(p);
    await settle(p, 1500); await swarmReady(p); await settle(p, 800);
    const out: Record<string, unknown> = {};
    const views: [string, string | null, number][] = [["overview", null, 0], ["pump-4x", "PUMP", 4], ["pump-12x", "PUMP", 12]];
    for (const [name, sym, k] of views) {
      if (sym) { const t = await topOf(p, sym); if (!t) continue; await p.evalJs(`__sporeMap.zoomTo(${J(t)}, ${k})`); await settle(p, 1500); }
      const c = await lookPair(p, name, 1);
      out[name] = c;
      const lumMax = name === "overview" ? 14 : name === "pump-4x" ? 20 : Infinity;
      num("look", `${name}: outside the asset discs, share of pixels within +-2`, c.outSame, (v) => v >= 0.995, ">= 0.995");
      if (Number.isFinite(lumMax)) num("look", `${name}: mean luma delta inside the discs (sRGB levels)`, c.dLum, (v) => v <= lumMax, `<= ${lumMax}`);
      else row("look", `${name}: mean luma delta inside the discs`, "INFO", r2(c.dLum), "information");
      row("look", `${name}: lime share in the discs off -> on`, shareOk(c.limeOff, c.limeOn) ? "PASS" : "FAIL", `${c.limeOff.toFixed(4)} -> ${c.limeOn.toFixed(4)}`, "+-10 %");
      row("look", `${name}: violet share in the discs off -> on`, shareOk(c.vioOff, c.vioOn) ? "PASS" : "FAIL", `${c.vioOff.toFixed(4)} -> ${c.vioOn.toFixed(4)}`, "+-10 %");
      row("look", `${name}: noise floor (off vs off): outside within +-2, luma delta`, "INFO", `${c.noiseOutSame.toFixed(4)}, ${c.noiseDLum.toFixed(2)}`, "information");
    }
    const usdc = await topOf(p, "USDC");
    if (usdc) {
      await p.evalJs(`__sporeMap.focusFamily("USDC")`); await settle(p, 1200);
      const k = await p.evalJs<number>("__sporeMap.zoom()"); await p.evalJs(`__sporeMap.zoomTo(${J(usdc)}, ${k * 2})`); await settle(p, 1500);
      const c = await lookPair(p, "usdc-deep", 1); out["usdc-deep"] = c;
      num("look", "usdc-deep: outside the asset discs within +-2", c.outSame, (v) => v >= 0.995, ">= 0.995");
      row("look", "usdc-deep: mean luma delta inside the discs", "INFO", r2(c.dLum), "information");
    }
    const g4 = await p.evalJs<unknown>(`__sporeMap.call("coverage")`).catch(() => null);
    out.coverage = g4;
    raw.look = out;
  } finally { await close(b); }
  console.log("[look] phone 390x844 @2");
  const ph = await open("metal", 390, 844, 2);
  try {
    await still(ph.p);
    await settle(ph.p, 1500); await swarmReady(ph.p); await settle(ph.p, 800);
    const c = await lookPair(ph.p, "phone-overview", 2);
    (raw.look as Record<string, unknown>)["phone-overview"] = c;
    num("look", "phone overview: outside the asset discs within +-2", c.outSame, (v) => v >= 0.995, ">= 0.995");
    num("look", "phone overview: mean luma delta inside the discs", c.dLum, (v) => v <= 14, "<= 14");
  } finally { await close(ph.b); }
}

async function measureAll(p: Page, tag: string, modes: string[]) {
  const res: Record<string, any> = {};
  for (const m of modes) res[m] = await p.evalJs(`__sporeMap.measure(${MS}, ${J(m)})`, 60_000);
  for (const m of modes) num("perf", `${tag} ${m} p95 (ms)`, res[m]?.p95, (v) => v <= 17.5, "<= 17.5");
  return res;
}
async function sectionPerf() {
  for (const dpr of [1, 2]) {
    console.log(`[perf] metal 1440x900 @${dpr}`);
    const { b, p } = await open("metal", 1440, 900, dpr);
    try {
      await settle(p, 1500); await swarmReady(p); await settle(p, 800);
      const st = await swarm(p);
      row("perf", `@${dpr} ghost slots drawn`, (st?.ghostVisible ?? 0) >= 300000 ? "PASS" : "INFO", st?.ghostVisible, ">= 300,000 (fixture)");
      const ov = await measureAll(p, `@${dpr} overview`, ["idle", "pan", "zoom", "hover"]);
      const pump = await topOf(p, "PUMP");
      const synth = await p.evalJs<number>(`__sporeMap.call("swarmSynth", ${J(pump)}, 200000)`);
      await p.waitFor(`(() => { const s = __sporeMap.swarm(); return s && s.queued === 0; })()`, 60_000, "real specks drained").catch(() => null);
      const st2 = await swarm(p);
      const pf = (st2?.byFamily ?? []).find((f: any) => f.top === pump);
      row("perf", `@${dpr} $PUMP real specks`, (pf?.real ?? 0) >= 76000 ? "PASS" : "INFO", { queued: synth, real: pf?.real, slots: pf?.slots }, ">= 76k (the family's slots)");
      const res: Record<string, unknown> = { overview: ov, swarm: st2 && { ...st2, byFamily: undefined } };
      for (const k of [4, 12]) { await p.evalJs(`__sporeMap.zoomTo(${J(pump)}, ${k})`); await settle(p, 1500); res[`pump${k}x`] = await measureAll(p, `@${dpr} $PUMP ${k}x (real)`, ["idle", "pan", "zoom", "hover"]); }
      res.quality = await p.evalJs("(__sporeMap.motion() || {}).quality || null");
      const perf = (raw.perf ??= {}) as Record<string, unknown>;
      perf[`@${dpr}`] = res;
      row("perf", `@${dpr} errors`, p.errors.length === 0 ? "PASS" : "FAIL", p.errors.slice(0, 3), "0");
    } finally { await close(b); }
  }
}
async function sectionPhone() {
  console.log("[phone] metal 390x844 @2");
  const { b, p } = await open("metal", 390, 844, 2);
  try {
    await settle(p, 1500); await swarmReady(p); await settle(p, 800);
    const res: Record<string, any> = {};
    for (const m of ["idle", "pan", "zoom"]) { res[m] = await p.evalJs(`__sporeMap.measure(${MS}, ${J(m)})`, 60_000); num("phone", `overview ${m} fps`, res[m]?.fps, (v) => v >= 58, ">= 58"); }
    const pump = await topOf(p, "PUMP");
    await p.evalJs(`__sporeMap.call("swarmSynth", ${J(pump)}, 200000)`);
    await p.waitFor(`(() => { const s = __sporeMap.swarm(); return s && s.queued === 0; })()`, 60_000, "drained").catch(() => null);
    await p.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`); await settle(p, 1500);
    for (const m of ["idle", "pan", "zoom"]) { res[`pump4x-${m}`] = await p.evalJs(`__sporeMap.measure(${MS}, ${J(m)})`, 60_000); num("phone", `$PUMP 4x ${m} fps`, res[`pump4x-${m}`]?.fps, (v) => v >= 58, ">= 58"); }
    const st = await swarm(p);
    const maxGhost = Math.max(0, ...(st?.byFamily ?? []).map((f: any) => f.ghostShown)), maxReal = Math.max(0, ...(st?.byFamily ?? []).map((f: any) => f.real));
    row("phone", "tier", st?.tier === "phone" ? "PASS" : "FAIL", st?.tier, "phone");
    num("phone", "ghosts shown per family (max)", maxGhost, (v) => v <= 5000, "<= 5,000");
    num("phone", "real specks per family (max)", maxReal, (v) => v <= 20000, "<= 20,000");
    raw.phone = { ...res, swarm: st };
  } finally { await close(b); }
}
async function sectionSw() {
  const res: Record<string, any> = {};
  for (const off of [true, false]) {
    console.log(`[sw] swiftshader 1440x900 @1 ${off ? "?swarm=0" : "swarm on"}`);
    const { b, p } = await open("swiftshader", 1440, 900, 1, off ? "/map?swarm=0" : "/map");
    try {
      await settle(p, 2500); if (!off) await swarmReady(p); await sleep(1500);
      res[off ? "off" : "on"] = { idle: await p.evalJs(`__sporeMap.measure(${Math.max(MS, 6000)}, "idle")`, 120_000), swarm: off ? null : await swarm(p) };
    } finally { await close(b); }
  }
  const a = res.off?.idle?.p95, c = res.on?.idle?.p95;
  num("sw", "overview frame p95 on / ?swarm=0", a > 0 && c > 0 ? c / a : null, (v) => v <= 1.10, "<= 1.10");
  row("sw", "p95 off -> on (ms), tier", "INFO", { off: a, on: c, tier: res.on?.swarm?.tier, ghosts: res.on?.swarm?.ghostVisible }, "information");
  raw.sw = res;
}
async function sectionBuild() {
  const res: Record<string, any> = { off: [], on: [] };
  for (const off of [true, false]) for (let n = 0; n < 2; n++) {
    console.log(`[build] metal 1440x900 @1 ${off ? "?swarm=0" : "swarm on"} #${n + 1}`);
    const { b, p } = await open("metal", 1440, 900, 1, off ? "/map?swarm=0" : "/map", [RAF_PROBE]);
    try {
      const t0 = await p.evalJs<number>("__sporeMap.firstPaintAt()");
      await settle(p, 1500); if (!off) await swarmReady(p); await sleep(800);
      const lb = await p.evalJs<Record<string, any>>("__sporeMap.lastBuild()"), gl = await p.evalJs<Record<string, any>>("__sporeMap.gl()");
      const r: Record<string, any> = { buildMs: lb.buildMs, firstFrameMs: lb.firstFrameMs, maxTask: lb.buildMaxTaskMs, gl, builds: await p.evalJs("__sporeMap.builds()") };
      if (!off) {
        // three family loads through swarmAdd, inside the long-task window
        for (const s of ["PUMP", "USDC", "SPCX"]) { const t = await topOf(p, s); if (t) await p.evalJs(`__sporeMap.call("swarmSynth", ${J(t)}, 200000)`); }
        await p.waitFor(`(() => { const s = __sporeMap.swarm(); return s && s.queued === 0; })()`, 60_000, "drained").catch(() => null);
        await sleep(800);
        r.swarm = await swarm(p); r.buildsAfter = await p.evalJs("__sporeMap.builds()");
        r.raf = await p.evalJs(rafStatsJs(t0));
        r.longTasks = await p.evalJs(`(window.__raf ? __raf.lt : []).filter((e) => e.s >= ${t0}).map((e) => Math.round(e.d))`);
      }
      res[off ? "off" : "on"].push(r);
    } finally { await close(b); }
  }
  const mean = (a: any[], k: string) => a.reduce((s, r) => s + (Number(r[k]) || 0), 0) / Math.max(1, a.length);
  const bOff = mean(res.off, "buildMs"), bOn = mean(res.on, "buildMs"), fOff = mean(res.off, "firstFrameMs"), fOn = mean(res.on, "firstFrameMs");
  num("build", "buildMs on - off (ms, mean of 2)", bOn - bOff, (v) => v <= 50, "<= 50");
  num("build", "firstFrameMs on - off (ms, mean of 2)", fOn - fOff, (v) => v <= 50, "<= 50");
  const g0 = res.off[0]?.gl, g1 = res.on[0]?.gl;
  if (g0 && g1) for (const k of ["geometries", "programs", "textures"]) num("build", `gl() ${k} on - off`, g1[k] - g0[k], (v) => v <= 1, "+1");
  const on0 = res.on[0] ?? {};
  num("build", "genSliceMaxMs", on0.swarm?.genSliceMaxMs, (v) => v <= 8, "<= 8");
  num("build", "addSliceMaxMs", on0.swarm?.addSliceMaxMs, (v) => v <= 4, "<= 4");
  const lt = Math.max(0, ...((on0.longTasks as number[]) ?? []));
  num("build", "longest task after the first frame (generation + 3 loads, ms)", lt, (v) => v < 50, "< 50");
  num("build", "rebuilds through the loads", (on0.buildsAfter ?? 0) - (on0.builds ?? 0), (v) => v === 0, "0");
  raw.build = res;
}
async function sectionMem() {
  console.log("[mem] metal 1440x900 @1");
  const { b, p } = await open("metal", 1440, 900, 1);
  try {
    await settle(p, 1500); await swarmReady(p); await sleep(800);
    const base = await p.heapMB();
    const tops: Record<string, string | null> = {};
    for (const s of ["PUMP", "USDC", "SPCX", "SPYx"]) tops[s] = await topOf(p, s);
    const load = async (s: string) => { if (!tops[s]) return; await p.evalJs(`__sporeMap.call("swarmSynth", ${J(tops[s])}, 200000)`); await p.waitFor(`(() => { const s = __sporeMap.swarm(); return s && s.queued === 0; })()`, 60_000, "drained").catch(() => null); };
    for (const s of ["PUMP", "USDC", "SPCX"]) await load(s);
    await sleep(500);
    const peak3 = await p.heapMB();
    // the store's LRU drops the least wanted family when a 4th comes in: the engine side of it is swarmDrop
    const dropOk = await p.evalJs<boolean>(`(() => { const h = window.__sporeMap; if (!h || typeof h.swarmDrop !== "function") return false; h.swarmDrop(${J(tops.PUMP)}); return true; })()`).catch(() => false);
    await sleep(600);
    const afterDrop = await p.heapMB();
    await load("SPYx");
    await sleep(600);
    const after = await p.heapMB();
    const st = await swarm(p);
    const real = (t: string | null) => (st?.byFamily ?? []).find((f: any) => f.top === t)?.real ?? null;
    num("mem", "heap with 3 families loaded - baseline (MB)", peak3 - base, (v) => v <= 60, "<= 60");
    num("mem", "heap after dropping $PUMP and loading a 4th - 3-family peak (MB)", dropOk ? after - peak3 : null, (v) => v <= 10, "<= 10 (engine arrays; the store's rows are the DATA lane's)");
    row("mem", "heap steps (MB)", "INFO", { base, peak3, afterDrop, after, pumpRealAfterDrop: real(tops.PUMP), spyxReal: real(tops.SPYx) }, "information");
    raw.mem = { base, peak3, afterDrop, after, swarm: st && { ...st, byFamily: undefined } };
  } finally { await close(b); }
}
async function sectionCorrect() {
  console.log("[correct] metal 1440x900 @1, two mounts");
  const hashes: number[] = [];
  for (let n = 0; n < 2; n++) {
    const { b, p } = await open("metal", 1440, 900, 1);
    try {
      await settle(p, 1500); await swarmReady(p); await sleep(500);
      const c = await p.evalJs<Record<string, any>>(`__sporeMap.call("swarmCheck")`);
      hashes.push(c.hash);
      if (n === 0) {
        num("correct", "slots outside their family disc", c.outside, (v) => v === 0, "0");
        num("correct", "slots on a drawn coin (share)", c.onDrawnShare, (v) => v <= 0.01, "<= 0.01");
        row("correct", "forced overlaps (reported)", "INFO", c.overlaps, "reported");
        const st = await swarm(p), n0 = await p.evalJs<number>("__sporeMap.nodes()");
        const page = await p.evalJs<Record<string, any> | null>(`(() => { const P = window.__sporeMapPage; return P && typeof P.indexed === "function" ? P.indexed() : null; })()`).catch(() => null);
        const ghost = (st?.byFamily ?? []).reduce((s: number, f: any) => s + f.ghost, 0);
        if (page && Number.isFinite(page.derived)) num("correct", "Σ ghost + N - indexed().derived", ghost + n0 - page.derived, (v) => v === 0, "0");
        else row("correct", "Σ ghost + N vs indexed().derived", "N/A", { ghost, n: n0, page }, "the page hook (DATA lane)");
        // the store path: want $PUMP through the page (onSwarmWant fires when it fills the view)
        const pump = await topOf(p, "PUMP");
        const b0 = await p.evalJs<number>("__sporeMap.builds()");
        await p.evalJs(`__sporeMap.zoomTo(${J(pump)}, 12)`); await settle(p, 1500);
        const loaded = await p.waitFor<number>(`(() => { const s = __sporeMap.swarm(); const f = s && s.byFamily.find((x) => x.top === ${J(pump)}); return f && f.real > 0 && s.queued === 0 ? f.real : 0; })()`, 90_000, "store chunks").catch(() => 0);
        row("correct", "$PUMP real specks from the store (onSwarmWant -> want -> swarmAdd)", loaded > 0 ? "PASS" : "FAIL", loaded, "> 0");
        { const sl = await swarm(p); num("correct", "drain slice max through the store path (ms)", sl?.addSliceMaxMs, (v) => v <= 4, "<= 4"); row("correct", "drain slices: p95 (ms), count", "INFO", { p95: sl?.drainSliceP95Ms, n: sl?.drainSlices, slow: sl?.drainSlow }, "information"); }
        if (loaded > 0) {
          // a speck near the centre of the view: pick it through the engine, then a real click
          const hit = await p.evalJs<{ x: number; y: number; mint: string } | null>(`(() => {
            const r = document.querySelector(".bm.m3").getBoundingClientRect(), cx = r.left + r.width * 0.55, cy = r.top + r.height * 0.5;
            for (let d = 0; d < 260; d += 3) for (let a = 0; a < 6.283; a += 0.35) { const x = cx + d * Math.cos(a), y = cy + d * Math.sin(a); const k = __sporeMap.pick(x, y); if (k.via === "dust" && k.node) return { x, y, mint: k.node }; }
            return null; })()`);
          if (hit) {
            row("correct", "a loaded speck is known (knows / has)", (await p.evalJs<boolean>(`__sporeMap.has(${J(hit.mint)})`)) ? "PASS" : "FAIL", hit.mint.slice(0, 8), "true");
            await p.hover(hit.x, hit.y); await sleep(700);
            const tip = await p.evalJs<{ on: boolean; mint: string | null; text: string } | null>("__sporeMap.tip()");
            const pin = await p.evalJs<boolean>(`(() => { const e = document.querySelector(".m3-pin"); return !!e && e.classList.contains("on") && (e.textContent || "").length > 0; })()`);
            row("correct", "a hovered speck: tooltip (ticker, market cap, family size, last trade) + pinned name", tip?.on && tip.mint === hit.mint && /Family/.test(tip.text) && /coins/.test(tip.text) && pin ? "PASS" : "FAIL", { tip: tip?.text?.slice(0, 160), pin }, "tooltip on the speck, pinned name");
            await p.click(hit.x, hit.y); await sleep(1500);
            const sel = await p.evalJs<string | null>("__sporeMap.selected()");
            const side = await p.evalJs<boolean>(`(() => { const s = document.querySelector(".map-side, .map-sheet"); return !!s && s.getBoundingClientRect().width > 0 && (s.textContent || "").length > 0; })()`);
            row("correct", "a clicked speck: engine selection + side panel", sel === hit.mint && side ? "PASS" : "FAIL", { selected: sel?.slice(0, 8), want: hit.mint.slice(0, 8), panel: side, url: (await p.evalJs<string>("location.search")).slice(0, 80) }, "selected = the speck, panel open");
            await p.shot(join(OUT, "look", "speck-selected.png"));
          } else row("correct", "a clicked speck", "N/A", "no speck under the probe", "a speck in view");
        }
        num("correct", "rebuilds through the store loads", (await p.evalJs<number>("__sporeMap.builds()")) - b0, (v) => v === 0, "0");
        raw.correct = { check: c, swarm: st && { ...st, byFamily: st.byFamily.slice(0, 5) }, page };
      }
    } finally { await close(b); }
  }
  row("correct", "slot hash across two mounts", hashes.length === 2 && hashes[0] === hashes[1] ? "PASS" : "FAIL", hashes, "equal");
  // ?focus= of an unloaded speck: the page wants its family, the chunk lands, the flight follows (mock or live endpoint)
  if (mockOn && fxBody) {
    const pumpRoot = fxBody.roots.find((r) => r.coin.symbol === "PUMP");
    const m = pumpRoot ? fakeMint(pumpRoot.coin.mint as string, 7) : null;
    if (m) {
      const { b, p } = await open("metal", 1440, 900, 1, `/map?focus=${m}`);
      try {
        const ok = await p.waitFor<boolean>(`(() => __sporeMap.selected() === ${J(m)} && __sporeMap.has(${J(m)}))()`, 60_000, "speck selected").catch(() => false);
        await settle(p, 2500);
        const sc = await p.evalJs<{ x: number; y: number } | null>(`__sporeMap.screenOf(${J(m)})`);
        const rect = await p.evalJs<{ x0: number; y0: number; x1: number; y1: number }>(INSET_RECT_JS);
        const inView = !!sc && sc.x > rect.x0 && sc.x < rect.x1 && sc.y > rect.y0 && sc.y < rect.y1;
        row("correct", "?focus= an unloaded speck: selected and flown to once its chunk lands", ok && inView ? "PASS" : "FAIL", { ok, inView, zoom: await p.evalJs("__sporeMap.zoom()") }, "selected, in the inset rect");
        await p.shot(join(OUT, "look", "speck-focus.png"));
      } finally { await close(b); }
    }
  } else row("correct", "?focus= an unloaded speck", "N/A", "needs /api/coin of a real undrawn mint (live endpoint)", "mock only");
}

try {
  if (on("look")) await sectionLook();
  if (on("perf")) await sectionPerf();
  if (on("phone")) await sectionPhone();
  if (on("sw")) await sectionSw();
  if (on("build")) await sectionBuild();
  if (on("mem")) await sectionMem();
  if (on("correct")) await sectionCorrect();
} catch (e) {
  row("run", "script", "FAIL", (e as Error).message.slice(0, 300), "no exception");
} finally {
  for (const b of browsers.slice()) await b.close().catch(() => null);
}
raw.rows = rows;
writeFileSync(join(OUT, "map3-swarm.json"), JSON.stringify(raw, null, 1));
console.log("\n| gate | check | status | value | need |\n|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.gate} | ${r.check} | ${r.status} | ${typeof r.value === "string" ? r.value : J(r.value)} | ${r.need} |`);
const bad = rows.filter((r) => r.status === "FAIL");
console.log(`\n${rows.filter((r) => r.status === "PASS").length} PASS, ${bad.length} FAIL, ${rows.filter((r) => r.status === "N/A").length} N/A`);
process.exit(bad.length ? 1 : 0);
