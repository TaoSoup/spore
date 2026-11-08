// map3 "feel" gates G1–G14 (binding spec "map3 galaxy, owner list items 1 to 10", section 10): veins visible, violet wash,
// vein attachment, overview coverage, logos, focus flight, drag lag, stay-where-dropped, neighbours untouched, rope chain,
// veins follow, perf/leak, look vs the owner's reference PNGs, ?look=flat. Prints a PASS/FAIL/N/A table and the raw JSON
// (also <out>/map3-feel.json); shots + drag.mp4 + paste.mp4 (CDP Page.startScreencast → ffmpeg) into <out>.
//
//   node --import tsx test/serve-prod.mts --dist <dist> --port 5471 --fixture <scratchpad>/mapThree &
//   node --import tsx test/map3-feel.mts --url http://127.0.0.1:5471 --prod --out <dir> [--ref <galaxy-ref dir>] [--only G1,G6]
//
// Interfaces (all through ?debug: window.__sporeMap and its raw index-based handle __sporeMap.eng): engine.debug.call(name, …)
// passes through to S.debugFns (physics: home, rope, moved; veins: veinPath; visibility: coverage, logoCoverage; focus:
// focusState). A missing one reports "n/a (interface absent)" (status N/A, never a crash); where a fallback measurement
// exists (screen()/logoPx()/chord) it is reported beside it as `fallback`, so a baseline still has numbers.
// Pixel classes (sRGB 0–255): lit max ≥ 64; lime g ≥ 120 && g−r ≥ 20 && g−b ≥ 40; teal g ≥ 110 && b ≥ 100 && g−r ≥ 40;
// violet b−g ≥ 24 && r ≥ g && max ≥ 56; grey max−min ≤ 18 && max ≥ 56. Screenshots are decoded with pngjs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pngjs from "pngjs";
import { INSET_RECT_JS, RAF_PROBE, SETTLED_JS, cli, launchChrome, mapReadyJs, rafStatsJs, sleep, withDebug, type Browser, type Page } from "./map3-cdp.mts";

const { opt, has } = cli();
const BASE = opt("--url", "http://127.0.0.1:5471")!.replace(/\/$/, "");
const PROD = has("--prod");
const OUT = opt("--out", join(process.env.SPORE_TMP ?? tmpdir(), "spore-map3-feel"))!;
const REF = opt("--ref", process.env.MAP3_GALAXY_REF ?? "")!;
const ONLY = new Set((opt("--only", "") ?? "").split(",").filter(Boolean));
const FFMPEG = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const FOCUS_MINT = "9bvuMWQt64eJ5whDPsjwH8q6P1PwaYPnNqj5cihCpump";
const SI_PREFIX = "3VPoXaRc", DRAG_PREFIX = "DzMwArmd";
mkdirSync(OUT, { recursive: true });
const J = JSON.stringify;
const u = (path: string) => withDebug(path, PROD);
const on = (g: string) => ONLY.size === 0 || ONLY.has(g);
const r2 = (v: number) => Math.round(v * 100) / 100, r4 = (v: number) => Math.round(v * 1e4) / 1e4;

type Status = "PASS" | "FAIL" | "N/A";
type Row = { gate: string; check: string; status: Status; value: unknown; need: string };
const rows: Row[] = [];
const raw: Record<string, unknown> = { url: BASE, prod: PROD, out: OUT, startedAt: new Date().toISOString() };
const row = (gate: string, check: string, status: Status, value: unknown, need: string) => { rows.push({ gate, check, status, value, need }); };
const gateNum = (gate: string, check: string, v: number | null | undefined, ok: (x: number) => boolean, need: string, na?: string) => {
  if (v === null || v === undefined || !Number.isFinite(v)) row(gate, check, "N/A", na ?? "n/a (interface absent)", need);
  else row(gate, check, ok(v) ? "PASS" : "FAIL", r4(v), need);
};
const isNA = (v: unknown): v is { na: string } => !!v && typeof v === "object" && "na" in (v as object);
const browsers: Browser[] = [];
const allPages: Page[] = [];

// ------------------------------------------------------------------ page helpers
async function openMap(p: Page, path = "/map") {
  await p.navigate(BASE + u(path), 60_000);
  await p.waitFor(mapReadyJs("three"), 120_000, `three map on ${path}`);
  await p.evalJs(HELPERS);
}
async function settle(p: Page, extraMs = 1500) {
  await p.waitFor(SETTLED_JS, 30_000, "settle").catch(() => null);
  await sleep(extraMs);
  await p.waitFor(SETTLED_JS, 5_000, "settle").catch(() => null);
}
/// window.__qa: page-px screen of an index, the debug passthrough, descendants (BFS), the inset rect, the container origin.
const HELPERS = `(() => {
  const M = __sporeMap, e = M.eng; const m0 = M.anyRoot(); const i0 = e.indexOf(m0); const a = e.screen(i0), b = M.screenOf(m0);
  const o = a && b ? { x: b.x - a.x, y: b.y - a.y } : { x: 0, y: 0 };
  window.__qa = {
    o,
    scr: (i) => { const s = __sporeMap.eng.screen(i); return s ? { x: s.x + o.x, y: s.y + o.y, r: s.r } : null; },
    call: (name, ...args) => { const e = __sporeMap.eng; if (!e) return { na: "no engine" }; let r;
      try { if (typeof e.call === "function") r = e.call(name, ...args); else if (typeof e[name] === "function") r = e[name](...args); else return { na: "n/a (interface absent)" }; }
      catch (err) { return { na: "threw: " + (err && err.message) }; }
      return r == null ? { na: "n/a (interface absent)" } : r; },
    hasCall: () => typeof __sporeMap.eng.call === "function",
    desc: (i) => { const e = __sporeMap.eng, out = [], q = [i], seen = new Set([i]); while (q.length) { const c = q.shift(); for (const k of e.children(c)) { if (seen.has(k)) continue; seen.add(k); out.push(k); q.push(k); } } return out; },
    inset: () => ${INSET_RECT_JS},
    rootOf: (sym, prefix) => { for (const c of __sporeMap.clusters(100000)) { if ((prefix && c.root.startsWith(prefix)) || (!prefix && (__sporeMap.node(c.root) || {}).symbol === sym)) return c.root; } return null; },
  };
  return o;
})()`;
const call = <T = unknown>(p: Page, name: string, ...args: unknown[]) => p.evalJs<T | { na: string }>(`__qa.call(${[J(name), ...args.map((a) => J(a))].join(", ")})`, 60_000).catch((e: Error) => ({ na: `eval failed: ${e.message.slice(0, 120)}` }));

type Img = { w: number; h: number; d: Buffer; file: string };
async function shot(p: Page, name: string): Promise<Img> {
  const file = join(OUT, `${name}.png`);
  const r = await p.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(r.data, "base64"); writeFileSync(file, buf);
  const png = pngjs.PNG.sync.read(buf);
  return { w: png.width, h: png.height, d: png.data, file };
}
function readPng(file: string): Img { const png = pngjs.PNG.sync.read(readFileSync(file)); return { w: png.width, h: png.height, d: png.data, file }; }
type Cls = { n: number; lit: number; lime: number; teal: number; violet: number; grey: number; haze: number; meanLum: number };
/// pixel classes over the pixels where inside(x, y) (image px) holds
function classify(img: Img, inside: (x: number, y: number) => boolean = () => true, box?: { x0: number; y0: number; x1: number; y1: number }): Cls {
  let n = 0, lit = 0, lime = 0, teal = 0, violet = 0, grey = 0, haze = 0, lum = 0;
  const x0 = Math.max(0, Math.floor(box?.x0 ?? 0)), y0 = Math.max(0, Math.floor(box?.y0 ?? 0)), x1 = Math.min(img.w, Math.ceil(box?.x1 ?? img.w)), y1 = Math.min(img.h, Math.ceil(box?.y1 ?? img.h));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!inside(x, y)) continue;
    const i = (y * img.w + x) * 4, r = img.d[i], g = img.d[i + 1], b = img.d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    n++; lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (mx >= 64) lit++;
    if (g >= 120 && g - r >= 20 && g - b >= 40) lime++;
    if (g >= 110 && b >= 100 && g - r >= 40) teal++;
    if (b - g >= 24 && r >= g && mx >= 56) violet++;
    if (mx - mn <= 18 && mx >= 56) grey++;
    if (mx >= 18 && mx < 56 && b - g >= 6) haze++;   // (information) the dim violet nebula haze the violet class (max ≥ 56) cannot see
  }
  const s = (v: number) => (n ? r4(v / n) : 0);
  return { n, lit: s(lit), lime: s(lime), teal: s(teal), violet: s(violet), grey: s(grey), haze: s(haze), meanLum: n ? r2(lum / n) : 0 };
}
const lumAt = (img: Img, x: number, y: number) => { const xi = Math.round(x), yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= img.w || yi >= img.h) return -1; const i = (yi * img.w + xi) * 4; return 0.2126 * img.d[i] + 0.7152 * img.d[i + 1] + 0.0722 * img.d[i + 2]; };
const maxAt = (img: Img, x: number, y: number) => { const xi = Math.round(x), yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= img.w || yi >= img.h) return -1; const i = (yi * img.w + xi) * 4; return Math.max(img.d[i], img.d[i + 1], img.d[i + 2]); };

/// CDP screencast → <dir>/%05d.jpg → mp4 (ffmpeg, 30 fps)
async function screencast(p: Page, name: string) {
  const dir = join(OUT, `${name}-frames`); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  let n = 0;
  const off = p.on("Page.screencastFrame", (q) => { writeFileSync(join(dir, `${String(n++).padStart(5, "0")}.jpg`), Buffer.from(String(q.data), "base64")); void p.send("Page.screencastFrameAck", { sessionId: q.sessionId }).catch(() => null); });
  await p.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
  return async () => {
    await p.send("Page.stopScreencast").catch(() => null); off();
    const mp4 = join(OUT, `${name}.mp4`);
    const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", "30", "-i", join(dir, "%05d.jpg"), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", mp4], { encoding: "utf8" });
    return { frames: n, mp4: r.status === 0 && existsSync(mp4) ? mp4 : null, ffmpeg: r.status === 0 ? "ok" : (r.stderr || r.error?.message || "").slice(0, 200) };
  };
}
const refFile = (name: string) => (REF ? join(REF, name) : "");

// ------------------------------------------------------------------ G5 logos (cold browser, first)
async function g5() {
  const br = await launchChrome({ gpu: "metal", width: 1440, height: 900 }); browsers.push(br);
  const p = await br.newPage(); allPages.push(p);
  const t0 = Date.now();
  await openMap(p, "/map");
  const tReady = Date.now();
  const series: unknown[] = []; let last: Record<string, number> | null = null; let fb: Record<string, number> | null = null;
  const FB = `(() => { const M = __sporeMap, e = M.eng, R = __qa.inset(); let on = 0, img = 0, drawn = 0; for (const c of M.clusters(100000)) { const i = e.indexOf(c.root); const s = __qa.scr(i); if (!s || s.x < R.x0 || s.x > R.x1 || s.y < R.y0 || s.y > R.y1) continue; on++; const n = M.node(c.root); if (n && n.image) { img++; if (e.logoPx(i) > 0) drawn++; } } return { rootsOnScreen: on, rootsWithImage: img, rootsDrawn: drawn }; })()`;
  while (Date.now() - tReady < 8000) {
    const c = await call<Record<string, number>>(p, "logoCoverage");
    fb = await p.evalJs<Record<string, number>>(FB).catch(() => null);
    if (!isNA(c)) last = c as Record<string, number>;
    series.push({ t: Date.now() - tReady, cov: c, fallback: fb });
    await sleep(500);
  }
  const ratio = last && last.rootsWithImage > 0 ? last.rootsDrawn / last.rootsWithImage : null;
  gateNum("G5", "roots drawn with logo / with image @8s (logoCoverage)", ratio, (v) => v >= 0.9, "≥ 0.90");
  raw.g5 = { mountMs: tReady - t0, last, fallbackAt8s: fb, fallbackRatio: fb && fb.rootsWithImage ? r4(fb.rootsDrawn / fb.rootsWithImage) : null, images: await p.evalJs("__sporeMap.images()").catch(() => null), series: series.filter((_, i) => i % 4 === 0 || i === series.length - 1) };
  // children ≥ 10 px within 3 s of a 4× settle
  const kidsAt = async (kRel: number) => {
  await p.evalJs(`__sporeMap.zoomTo(__qa.rootOf("PUMP"), ${kRel})`);
  await p.waitFor(SETTLED_JS, 30_000, "settle 4x").catch(() => null);
  await sleep(3000);
  const kc = await call<Record<string, number>>(p, "logoCoverage");
  const kfb = await p.evalJs<Record<string, number>>(`(() => { const M = __sporeMap, e = M.eng, R = __qa.inset(), top = __qa.rootOf("PUMP"); let n = 0, img = 0, drawn = 0; for (const m of M.members(top)) { const i = e.indexOf(m); if (m === top) continue; const s = __qa.scr(i); if (!s || s.r < 10 || s.x < R.x0 || s.x > R.x1 || s.y < R.y0 || s.y > R.y1) continue; n++; const nd = M.node(m); if (nd && nd.image) { img++; if (e.logoPx(i) > 0) drawn++; } } return { kids10: n, kids10WithImage: img, kids10Drawn: drawn }; })()`).catch(() => null);
  return { kc, kfb };
  };
  let kRel = 4, { kc, kfb } = await kidsAt(4);
  if ((!kfb || kfb.kids10 === 0) && (isNA(kc) || !(kc as Record<string, number>).kids10)) { kRel = 12; ({ kc, kfb } = await kidsAt(12)); }
  const kr = !isNA(kc) && (kc as Record<string, number>).kids10WithImage > 0 ? (kc as Record<string, number>).kids10Drawn / (kc as Record<string, number>).kids10WithImage : null;
  gateNum("G5", `kids ≥10px drawn with logo / with image, 3s after a ${kRel}× $PUMP settle`, kr, (v) => v >= 0.9, "≥ 0.90");
  const e429 = p.responses.filter((r) => r.status === 429);
  row("G5", "HTTP 429 responses (Network.responseReceived)", e429.length === 0 ? "PASS" : "FAIL", e429.length, "0");
  raw.g5kids = { kRel, cov: kc, fallback: kfb, fallbackRatio: kfb && kfb.kids10WithImage ? r4(kfb.kids10Drawn / kfb.kids10WithImage) : null, e429: e429.slice(0, 5), http4xx5xx: p.responses.length };
  raw.g5errors = p.errors.slice(0, 10);
  await p.close(); await br.close(); browsers.splice(browsers.indexOf(br), 1);
}

// ------------------------------------------------------------------ G1 G2 G4 G13 G12(perf overview/4×, leak) on one page
async function gLook(br: Browser) {
  const p = await br.newPage({ prelude: [RAF_PROBE] }); allPages.push(p);
  await openMap(p, "/map");
  await p.mouse("mouseMoved", 2, 2);
  await p.evalJs("__sporeMap.fit()");
  await settle(p, 2500);
  const pump = await p.evalJs<string | null>(`__qa.rootOf("PUMP")`);
  const usdc = await p.evalJs<string | null>(`__qa.rootOf("USDC")`);
  raw.roots = { pump, usdc };
  // ---- overview
  const imgA = await shot(p, "overview");
  const ov = await p.evalJs<{ vs: unknown; rect: { x0: number; y0: number; x1: number; y1: number }; geo: Record<string, number>; fams: number; tops: { x: number; y: number; r: number; dust: boolean; on: boolean }[] }>(`(() => {
    const M = __sporeMap, e = M.eng, R = __qa.inset(), cam = M.camera(); const fams = e.families(100000);
    const i0 = fams[0].top, w0 = e.world(i0), s0 = __qa.scr(i0), k = cam.k; const toS = (x, y) => ({ x: s0.x + (x - w0.x) * k, y: s0.y - (y - w0.y) * k });
    let rcl = 0, rout = 0; for (const f of fams) { const d = Math.hypot(f.cx, f.cy) + f.Rc; if (f.planet) rcl = Math.max(rcl, d); rout = Math.max(rout, d); }
    const c0 = toS(0, 0);
    const tops = fams.map((f) => { const s = __qa.scr(f.top); return s ? { x: s.x, y: s.y, r: s.r, dust: !f.planet, on: s.x >= R.x0 && s.x <= R.x1 && s.y >= R.y0 && s.y <= R.y1 } : { x: -1, y: -1, r: 0, dust: !f.planet, on: false }; });
    return { vs: e.veinShare(${J(pump ? "PUMP" : null)}), rect: R, geo: { cx: c0.x, cy: c0.y, rcl: rcl * k, rout: rout * k, k }, fams: fams.length, tops };
  })()`, 90_000);
  const vsA = ov.vs as { share: number } | null;
  gateNum("G1", "veinShare $PUMP disc @overview", vsA?.share, (v) => v >= 0.04, "≥ 0.04 (base 0.0072)", "veinShare missing");
  // G4
  const cov = await call<Record<string, unknown>>(p, "coverage");
  const onScreen = ov.tops.filter((t) => t.on).length, minR = Math.min(...ov.tops.map((t) => t.r));
  const hist = { "<1": 0, "1-3": 0, "3-6": 0, "6+": 0 }; for (const t of ov.tops) hist[t.r < 1 ? "<1" : t.r < 3 ? "1-3" : t.r < 6 ? "3-6" : "6+"]++;
  if (isNA(cov)) {
    row("G4", "coverage(): tops on screen with drawnPx ≥ 3", "N/A", `n/a (interface absent); fallback screen(): ${onScreen}/${ov.fams} on screen, minTopPx ${r2(minR)}`, `${ov.fams}/${ov.fams}, ≥ 3`);
  } else {
    const c = cov as { tops: number; onScreen: number; minTopPx: number };
    row("G4", "coverage(): tops on screen with drawnPx ≥ 3", c.onScreen === c.tops && c.minTopPx >= 3 ? "PASS" : "FAIL", { tops: c.tops, onScreen: c.onScreen, minTopPx: c.minTopPx }, "all on screen, minTopPx ≥ 3");
  }
  row("G4", "fallback screen(): tops on screen, min r", onScreen === ov.fams && minR >= 3 ? "PASS" : "FAIL", { onScreen, of: ov.fams, minR: r2(minR), hist }, `${ov.fams}/${ov.fams}, r ≥ 3`);
  const dusts = ov.tops.filter((t) => t.dust && t.on); const step = Math.max(1, Math.floor(dusts.length / 200)); let litN = 0, sampled = 0;
  const sx = imgA.w / 1440;
  for (let i = 0; i < dusts.length && sampled < 200; i += step) { sampled++; if (maxAt(imgA, dusts[i].x * sx, dusts[i].y * sx) >= 64) litN++; }
  gateNum("G4", "dust-top centre px lit (200 sampled)", sampled ? litN / sampled : null, (v) => v >= 0.95, "≥ 0.95");
  // G13 overview + nebula
  const R = ov.rect, inRect = (x: number, y: number) => x >= R.x0 * sx && x < R.x1 * sx && y >= R.y0 * sx && y < R.y1 * sx;
  const clsA = classify(imgA, inRect);
  const g = ov.geo, ann = (cx: number, cy: number, a: number, b: number) => (x: number, y: number) => { const d = Math.hypot(x - cx, y - cy); return d >= a && d <= b; };
  const nebA = classify(imgA, (x, y) => inRect(x, y) && ann(g.cx * sx, g.cy * sx, 1.1 * g.rcl * sx, g.rout * sx)(x, y));
  const look: Record<string, unknown> = { overview: { ours: clsA, nebulaOurs: nebA, geo: g } };
  // ---- $PUMP 4×
  let imgB: Img | null = null;
  if (pump) {
    await p.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
    await settle(p, 2000);
    imgB = await shot(p, "pump-4x");
    const b = await p.evalJs<{ vs: { share: number } | null; fs: { x: number; y: number; r: number }; root: { x: number; y: number; r: number } }>(`({ vs: __sporeMap.eng.veinShare("PUMP"), fs: __sporeMap.familyScreen(${J(pump)}), root: __sporeMap.screenOf(${J(pump)}) })`, 60_000);
    gateNum("G1", "veinShare $PUMP disc @4×", b.vs?.share, (v) => v >= 0.08, "≥ 0.08 (base 0.010)", "veinShare missing");
    const disc = (x: number, y: number) => inRect(x, y) && Math.hypot(x - b.fs.x * sx, y - b.fs.y * sx) <= b.fs.r * sx;
    const cB = classify(imgB, disc);
    gateNum("G2", "violet share, $PUMP 4× disc (full render)", cB.violet, (v) => v <= 0.03, "≤ 0.03");
    look.pump4x = { ours: classify(imgB, inRect), disc: cB, rootDisc: classify(imgB, (x, y) => Math.hypot(x - b.root.x * sx, y - b.root.y * sx) <= b.root.r * sx) };
    // G12 perf at 4×
    raw.perf4x = await p.evalJs("__sporeMap.measure(3000, 'idle')", 30_000).catch((e: Error) => ({ err: e.message }));
  }
  // ---- deep $USDC
  let imgC: Img | null = null;
  if (usdc) {
    await p.evalJs("__sporeMap.fit()"); await settle(p, 500);
    await p.evalJs(`__sporeMap.fly(${J(usdc)})`); await settle(p, 500);
    await p.evalJs(`__sporeMap.focusFamily("USDC")`, 20_000).catch(() => null); await settle(p, 500);
    const kF = await p.evalJs<number>("__sporeMap.zoom()").catch(() => 0);
    await p.evalJs(`__sporeMap.zoomTo(${J(usdc)}, ${Math.max(2, 2 * (Number(kF) || 0))})`);
    await settle(p, 2000);
    imgC = await shot(p, "usdc-deep");
    const c = await p.evalJs<{ vs: { share: number } | null; fs: { x: number; y: number; r: number }; root: { x: number; y: number; r: number }; cam: unknown }>(`({ vs: __sporeMap.eng.veinShare("USDC"), fs: __sporeMap.familyScreen(${J(usdc)}), root: __sporeMap.screenOf(${J(usdc)}), cam: __sporeMap.camera() })`, 60_000);
    gateNum("G1", "veinShare $USDC disc @deep", c.vs?.share, (v) => v >= 0.06, "≥ 0.06 (base 0.0061)", "veinShare missing");
    const cC = classify(imgC, (x, y) => inRect(x, y) && Math.hypot(x - c.fs.x * sx, y - c.fs.y * sx) <= c.fs.r * sx);
    gateNum("G2", "violet share, deep $USDC (disc ∩ view, full render)", cC.violet, (v) => v <= 0.04, "≤ 0.04");
    look.usdcDeep = { ours: classify(imgC, inRect), disc: cC, rootDisc: classify(imgC, (x, y) => Math.hypot(x - c.root.x * sx, y - c.root.y * sx) <= c.root.r * sx), cam: c.cam, kFocus: kF };
  }
  // ---- G13 vs the references
  const pairs: [string, string, Img | null][] = [["overview", "ref-overview.png", imgA], ["pump4x", "ref-pump-4x.png", imgB], ["usdcDeep", "ref-usdc-deep.png", imgC]];
  for (const [key, rf, img] of pairs) {
    const f = refFile(rf); const L = look[key] as { ours: Cls; rootDisc?: Cls } | undefined;
    if (!f || !existsSync(f) || !img || !L) { row("G13", `${key}: lit/lime/violet vs ${rf}`, "N/A", !f ? "no --ref" : "missing shot/ref", "±35 %"); continue; }
    const ref = readPng(f), cr = classify(ref);
    (L as Record<string, unknown>).ref = cr;
    for (const m of ["lit", "lime", "violet"] as const) {
      const a = L.ours[m], b = cr[m]; const rel = b > 0 ? (a - b) / b : a > 0 ? Infinity : 0;
      row("G13", `${key}: ${m} share vs ref`, Math.abs(rel) <= 0.35 ? "PASS" : "FAIL", { ours: a, ref: b, rel: Number.isFinite(rel) ? r2(rel) : "inf" }, "±35 %");
    }
    row("G13", `${key}: root meanLum vs ref`, "N/A", { ours: L.rootDisc?.meanLum ?? null, ref: "n/a (the ref's root position is not known to the harness)" }, "±35 %");
    if (key === "overview") {
      const s = ref.w / Math.min(1440, imgA.w / sx), mind = Math.min(R.x1 - R.x0, R.y1 - R.y0) / 2, refMind = Math.min(ref.w, ref.h) / 2;
      const a1 = (1.1 * g.rcl / mind) * refMind, a2 = (g.rout / mind) * refMind;
      const nebR = classify(ref, ann(ref.w / 2, ref.h / 2, a1, a2));
      (look.overview as Record<string, unknown>).nebulaRef = { ...nebR, annulusRefPx: [r2(a1), r2(a2)], scale: r2(s) };
      const ratio = nebR.violet > 0 ? nebA.violet / nebR.violet : null;
      gateNum("G13", "nebula: violet in annulus [1.1 Rcl, Rout] / ref's", ratio, (v) => v >= 0.5, "≥ 0.50", "ref annulus has no violet");
      // (information, not in the spec) both violet shares are ≤ 0.0003 on the baseline: the haze class sees the dim nebula
      gateNum("G13", `nebula haze (18 ≤ max < 56, b−g ≥ 6) in the annulus / ref's (info; ours ${nebA.haze}, ref ${nebR.haze})`, nebR.haze > 0 ? nebA.haze / nebR.haze : null, (v) => v >= 0.5, "≥ 0.50", "ref annulus has no haze");
    }
  }
  raw.look = look;
  // ---- G12 perf at the overview
  await p.evalJs("__sporeMap.fit()"); await settle(p, 1000);
  raw.perfOverview = await p.evalJs("__sporeMap.measure(3000, 'idle')", 30_000).catch((e: Error) => ({ err: e.message }));
  const p95o = (raw.perfOverview as { p95?: number })?.p95, p954 = (raw.perf4x as { p95?: number })?.p95;
  gateNum("G12", "p95 frame @overview (measure)", p95o, (v) => v <= 16.8, "≤ 16.8 ms", "measure failed");
  gateNum("G12", "p95 frame @4× (measure)", p954, (v) => v <= 16.8, "≤ 16.8 ms", "measure failed");
  // ---- G12 leak: 5 SPA cycles
  const spa = (path: string) => p.evalJs(`(history.pushState({}, "", ${J(u(path))}), dispatchEvent(new PopStateEvent("popstate")), true)`);
  const cyc: unknown[] = [];
  for (let c = 0; c < 5; c++) {
    await spa("/"); await sleep(800);
    const away = await p.evalJs<{ live: number }>("window.__sporeMap3 ? __sporeMap3.counters() : null").catch(() => null);
    await spa("/map"); await p.waitFor(mapReadyJs("three"), 60_000, "map again").catch(() => null); await sleep(800);
    cyc.push({ away, gl: await p.evalJs("__sporeMap.gl()").catch(() => null) });
  }
  raw.leak = cyc;
  const lives = cyc.map((c) => (c as { away: { live: number } | null }).away?.live ?? -1);
  row("G12", "engineCounters live after leaving /map, 5 cycles", lives.every((v) => v === 0) ? "PASS" : "FAIL", lives, "0 each");
  const tex = cyc.map((c) => (c as { gl: { textures: number; programs: number } | null }).gl);
  const stable = tex.length === 5 && tex.every((t) => t && tex[0] && t.textures === tex[0]!.textures && t.programs === tex[0]!.programs);
  row("G12", "gl textures/programs stable over 5 mounts", stable ? "PASS" : "FAIL", tex.map((t) => t ? `${t.textures}/${t.programs}` : null), "equal");
  return p;
}

// ------------------------------------------------------------------ G6 focus (?focus, typed paste, phone)
async function focusRun(p: Page, how: "url" | "paste", label: string, minR: number, cast: boolean) {
  const out: Record<string, unknown> = { how };
  const stop = cast ? await screencast(p, "paste") : null;
  if (how === "url") {
    await p.navigate(BASE + u(`/map?focus=${FOCUS_MINT}`), 60_000);
    await p.waitFor(mapReadyJs("three"), 120_000, "three map (focus)");
    await p.evalJs(HELPERS);
  } else {
    await openMap(p, "/map"); await settle(p, 800);
    await p.evalJs(`(() => { const i = document.querySelector(".map-search input"); if (i) { i.focus(); i.click(); } return !!i; })()`);
    await sleep(150);
    await p.insertText(FOCUS_MINT);
    await sleep(600);
    const sel = await p.evalJs<string | null>("__sporeMap.selected()");
    if (sel !== FOCUS_MINT) { await p.key("Enter"); out.pressedEnter = true; }
  }
  // sample focusState on every frame in the page
  await p.evalJs(`(() => { const R = window.__qaFS = []; const i = __sporeMap.eng.indexOf(${J(FOCUS_MINT)}); const t0 = performance.now(); const loop = () => { const f = __qa.call("focusState"); R.push([performance.now() - t0, f && !f.na ? Number(f.t) || 0 : null, __sporeMap.flying() ? 1 : 0]); if (performance.now() - t0 < 9000) requestAnimationFrame(loop); }; requestAnimationFrame(loop); return i; })()`);
  // pulse start: focusState.t > 0, else (fallback) the flight's arrival
  const tStart = Date.now();
  const startKind = await p.waitFor<string>(`(() => { const R = window.__qaFS; const l = R[R.length - 1]; if (!l) return null; if (l[1] !== null && l[1] > 0) return "focusState"; if (l[1] === null && !__sporeMap.flying() && __sporeMap.settled() && (R.some((e) => e[2] === 1) || l[0] > 1500)) return R.some((e) => e[2] === 1) ? "arrival" : "settled (no flight seen)"; return null; })()`, 12_000, "focus pulse / arrival", 30).catch(() => "timeout");
  const tP = Date.now(); out.startKind = startKind; out.startAfterMs = tP - tStart;
  await sleep(Math.max(0, 500 - (Date.now() - tP)));
  const s05 = await p.evalJs<{ x: number; y: number; r: number } | null>(`__sporeMap.screenOf(${J(FOCUS_MINT)})`);
  const i05 = await shot(p, `focus-${label}-0.5s`);
  const f06 = await p.evalJs<{ x: number; y: number; r: number } | null>(`__sporeMap.familyScreen(${J(FOCUS_MINT)})`);
  const i06 = await shot(p, `focus-${label}-0.6s`); out.t06 = Date.now() - tP;
  await sleep(Math.max(0, 3500 - (Date.now() - tP)));
  const i35 = await shot(p, `focus-${label}-3.5s`);
  await sleep(Math.max(0, 6000 - (Date.now() - tP)));
  const end = await p.evalJs<{ s: { x: number; y: number; r: number } | null; R: { x0: number; y0: number; x1: number; y1: number }; sel: string | null; panel: boolean; label: boolean; sym: string | null; fs: unknown; fsTrace: number[][]; k: number }>(`(() => {
    const M = __sporeMap, s = M.screenOf(${J(FOCUS_MINT)}), n = M.node(${J(FOCUS_MINT)}) || {}; const sym = n.symbol || null;
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05; };
    const side = [...document.querySelectorAll(".map-side, .map-sheet")].find((e) => vis(e)) || null; // the phone panel is the docked .map-sheet
    const label = !!sym && [...document.querySelectorAll(".m3-labels .lb, .m3 .lb")].some((e) => vis(e) && (e.textContent || "").includes(sym));
    return { s, R: __qa.inset(), sel: M.selected(), panel: !!side && vis(side), label, sym, fs: __qa.call("focusState"), fsTrace: window.__qaFS.filter((_, i) => i % 6 === 0).slice(0, 200), k: M.zoom() };
  })()`);
  if (stop) out.cast = await stop();
  const sx = i05.w / ((await p.evalJs<number>("innerWidth")) || 1440);
  out.end = { s: end.s, sel: end.sel, panel: end.panel, label: end.label, sym: end.sym, fs: end.fs, k: end.k };
  const s = end.s, R = end.R;
  const inside = !!s && s.x - s.r >= R.x0 - 1 && s.x + s.r <= R.x1 + 1 && s.y - s.r >= R.y0 - 1 && s.y + s.r <= R.y1 + 1;
  row("G6", `${label}: coin r inside the inset rect`, s && s.r >= minR && inside ? "PASS" : "FAIL", { r: s ? r2(s.r) : null, inside }, `r ≥ ${minR} px, inside`);
  // t > 0 duration from the page's per-frame trace
  const tr = await p.evalJs<number[][]>("window.__qaFS");
  const pos = tr.filter((e) => e[1] !== null && (e[1] as number) > 0);
  if (!tr.length || tr.every((e) => e[1] === null)) row("G6", `${label}: focusState t > 0 duration`, "N/A", "n/a (interface absent)", "2.0–3.0 s");
  else { const d = pos.length ? (pos[pos.length - 1][0] - pos[0][0]) / 1000 : 0; row("G6", `${label}: focusState t > 0 duration`, d >= 2 && d <= 3 ? "PASS" : "FAIL", r2(d), "2.0–3.0 s"); }
  row("G6", `${label}: label of the coin in the DOM`, end.label ? "PASS" : "FAIL", { sym: end.sym, label: end.label }, "visible .lb with the symbol");
  if (s05) {
    const cx = s05.x * sx, cy = s05.y * sx, a = (s05.r + 2) * sx, b = (s05.r + 14) * sx;
    const c = classify(i05, (x, y) => { const d = Math.hypot(x - cx, y - cy); return d >= a && d <= b; }, { x0: cx - b, y0: cy - b, x1: cx + b + 1, y1: cy + b + 1 });
    gateNum("G6", `${label}: lime share in annulus [r+2, r+14] @0.5s`, c.n ? c.lime : null, (v) => v >= 0.25, "≥ 0.25", "coin not on screen");
  } else row("G6", `${label}: lime share in annulus @0.5s`, "FAIL", "coin not found", "≥ 0.25");
  if (f06) {
    const inR = (x: number, y: number) => x >= R.x0 * sx && x < R.x1 * sx && y >= R.y0 * sx && y < R.y1 * sx;
    let outside = (x: number, y: number) => inR(x, y) && Math.hypot(x - f06.x * sx, y - f06.y * sx) > f06.r * sx;
    let region = "outside the family disc";
    if (classify(i06, outside).n < 0.1 * classify(i06, inR).n && s05) { const c = s05; outside = (x: number, y: number) => inR(x, y) && Math.hypot(x - c.x * sx, y - c.y * sx) > (c.r + 16) * sx; region = "outside the coin's r+16 (the family disc covers ≥ 90 % of the view)"; }
    const a = classify(i06, outside).meanLum, b = classify(i35, outside).meanLum; out.lumRegion = region;
    gateNum("G6", `${label}: mean lum ${region === "outside the family disc" ? "outside family disc" : "outside coin r+16"} @0.6s / @3.5s`, b > 0 ? a / b : null, (v) => v <= 0.7, "≤ 0.70", "no luminance at 3.5 s");
    out.lum = { at06: a, at35: b };
  }
  row("G6", `${label}: side panel open + selected`, end.panel && end.sel === FOCUS_MINT ? "PASS" : "FAIL", { panel: end.panel, selected: end.sel }, ".map-side visible, selected = mint");
  return out;
}
async function g6(br: Browser) {
  const p = await br.newPage(); allPages.push(p);
  raw.g6url = await focusRun(p, "url", "url", 80, false).catch((e: Error) => ({ err: e.message }));
  const q = await br.newPage(); allPages.push(q);
  raw.g6paste = await focusRun(q, "paste", "paste", 80, true).catch((e: Error) => ({ err: e.message }));
  const ph = await br.newPage({ width: 390, height: 844, dpr: 2, mobile: true, touch: true }); allPages.push(ph);
  raw.g6phone = await focusRun(ph, "url", "phone", 50, false).catch((e: Error) => ({ err: e.message }));
  await p.close(); await q.close(); await ph.close();
}

// ------------------------------------------------------------------ G7 G8 G9 G11 G10 G12(held) G3 drag page
const RECORDER = (g: number, parent: number) => `(() => {
  const M = __sporeMap, e = M.eng, g = ${g}, par = ${parent};
  const sub = new Set([g, ...__qa.desc(g)]); const base = e.allXY(); const X0 = base.x, Y0 = base.y, n = base.n;
  const R = window.__qaRec = { frames: [], ptr: null, stop: false, nbMax: 0, nbFams: new Set(), subN: sub.size };
  window.addEventListener("pointermove", (ev) => { R.ptr = { x: ev.clientX, y: ev.clientY }; }, true);
  window.addEventListener("pointerdown", (ev) => { R.ptr = { x: ev.clientX, y: ev.clientY }; }, true);
  const famTop = (i) => e.topOf(i);
  const loop = () => {
    if (R.stop) return;
    const a = e.allXY(); let mx = 0, at = -1;
    for (let i = 0; i < n; i++) { if (sub.has(i)) continue; const d = Math.abs(a.x[i] - X0[i]) + Math.abs(a.y[i] - Y0[i]); if (d > mx) { mx = d; at = i; } }
    if (mx > R.nbMax) R.nbMax = mx; if (mx > 0 && at >= 0) R.nbFams.add(famTop(at));
    const s = e.screen(g), sp = e.screen(par); const vp = __qa.call("veinPath", g, 16);
    let vEnd = null; if (vp && !vp.na && vp.pts && vp.pts.length > 1) { const p0 = vp.pts[0], p1 = vp.pts[vp.pts.length - 1]; vEnd = [Math.hypot(p0.x - sp.x, p0.y - sp.y), Math.hypot(p1.x - s.x, p1.y - s.y)]; }
    R.frames.push({ t: performance.now(), ptr: R.ptr ? { x: R.ptr.x, y: R.ptr.y } : null, c: { x: s.x + __qa.o.x, y: s.y + __qa.o.y }, nb: mx, vEnd, dragging: !!e.drag() });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return { subN: sub.size, n };
})()`;
type Frame = { t: number; ptr: { x: number; y: number } | null; c: { x: number; y: number }; nb: number; vEnd: number[] | null; dragging: boolean };
async function realDrag(p: Page, from: { x: number; y: number }, dx: number, dy: number, ms: number, moves: number) {
  await p.mouse("mouseMoved", from.x, from.y); await sleep(30);
  await p.mouse("mousePressed", from.x, from.y); await sleep(20);
  const t0 = Date.now();
  for (let k = 1; k <= moves; k++) {
    const f = k / moves; await p.mouse("mouseMoved", from.x + dx * f, from.y + dy * f, { buttons: 1, button: "left" });
    const wait = t0 + (ms * k) / moves - Date.now(); if (wait > 0) await sleep(wait);
  }
  await sleep(34);
  await p.mouse("mouseReleased", from.x + dx, from.y + dy);
  return Date.now() - t0;
}
async function gDrag(br: Browser) {
  const p = await br.newPage({ prelude: [RAF_PROBE] }); allPages.push(p);
  await openMap(p, "/map");
  const pump = await p.evalJs<string | null>(`__qa.rootOf("PUMP")`);
  if (!pump) { row("G7", "drag", "FAIL", "no $PUMP", ""); return; }
  // 8×, not 4×: at 4× the drag coin is drawn 5.66 px, under the engine’s 6 px grab floor, so a real press pans the map
  await p.evalJs(`__sporeMap.zoomTo(${J(pump)}, 8)`); await settle(p, 1500);
  await p.mouse("mouseMoved", 2, 2);
  const info = await p.evalJs<{ g: number; mint: string; par: number; s: { x: number; y: number; r: number }; k: number; kidsOfG: number }>(`(() => {
    const M = __sporeMap, e = M.eng, top = e.indexOf(${J(pump)}); const kids = e.children(top);
    let g = kids.find((i) => (e.mintAt(i) || "").startsWith(${J(DRAG_PREFIX)}));
    if (g === undefined) { let best = -1, br = 0; for (const i of kids) { const s = __qa.scr(i); if (s && s.r > br) { br = s.r; best = i; } } g = best; }
    return { g, mint: e.mintAt(g), par: top, s: __qa.scr(g), k: M.camera().k, kidsOfG: e.children(g).length };
  })()`);
  raw.dragCoin = info;
  const stopCast = await screencast(p, "drag");
  const rec = await p.evalJs<{ subN: number; n: number }>(RECORDER(info.g, info.par));
  const home0 = await p.evalJs<{ x: number; y: number }>(`__sporeMap.eng.world(${info.g})`);
  const desc0 = await p.evalJs<number[]>(`(() => { const e = __sporeMap.eng, a = e.allXY(); const d = __qa.desc(${info.g}); return [].concat(...d.map((i) => [i, a.x[i], a.y[i]])); })()`);
  // drag 1: 250 px in 146 ms, 9 moves
  const D1 = { dx: 250, dy: 0 };
  const tRel = Date.now(); const dur1 = await realDrag(p, info.s, D1.dx, D1.dy, 146, 9);
  await sleep(120);
  await sleep(Math.max(0, 1500 - (Date.now() - tRel)));
  const at15 = await p.evalJs<{ x: number; y: number }>(`__sporeMap.screenOf(${J(info.mint)})`);
  await shot(p, "drag-rest");
  await sleep(Math.max(0, 3000 - (Date.now() - tRel)));
  const at3 = await p.evalJs<{ mean: number; n: number }>(`(() => { const e = __sporeMap.eng, a = e.allXY(), d = ${J(desc0)}; let s = 0, n = 0; for (let j = 0; j < d.length; j += 3) { const i = d[j]; s += Math.hypot(a.x[i] - d[j + 1], a.y[i] - d[j + 2]); n++; } return { mean: n ? s / n : 0, n }; })()`);
  const f1 = await p.evalJs<Frame[]>("window.__qaRec.frames.splice(0)");
  // lag over the drag frames: |(ptr − ptr0) − (coin − coin0)|
  const lagOf = (fr: Frame[], from: { x: number; y: number }) => { const c0 = fr.length ? fr[0].c : from; let mx = 0, n = 0; for (const f of fr) { if (!f.dragging || !f.ptr) continue; n++; const lx = (f.ptr.x - from.x) - (f.c.x - c0.x), ly = (f.ptr.y - from.y) - (f.c.y - c0.y); mx = Math.max(mx, Math.hypot(lx, ly)); } return { maxLagPx: r2(mx), frames: n }; };
  const pre = f1.filter((f) => !f.dragging && f.t < (f1.find((x) => x.dragging)?.t ?? 0));
  const c0 = pre.length ? pre[pre.length - 1].c : f1[0]?.c ?? info.s;
  const lag1 = (() => { let mx = 0, n = 0; for (const f of f1) { if (!f.dragging || !f.ptr) continue; n++; mx = Math.max(mx, Math.hypot((f.ptr.x - info.s.x) - (f.c.x - c0.x), (f.ptr.y - info.s.y) - (f.c.y - c0.y))); } return { maxLagPx: r2(mx), frames: n }; })();
  void lagOf;
  row("G7", "drag 250 px / 146 ms (9 moves): max |pointer − coin|", lag1.frames ? (lag1.maxLagPx <= 2 ? "PASS" : "FAIL") : "FAIL", { ...lag1, durMs: dur1 }, "≤ 2 px (base 0.1)");
  const drop = { x: c0.x + D1.dx, y: c0.y + D1.dy };
  const dd = Math.hypot(at15.x - drop.x, at15.y - drop.y), ratio = Math.hypot(at15.x - c0.x, at15.y - c0.y) / Math.hypot(D1.dx, D1.dy);
  row("G8", "1.5 s after release: coin at the drop point", dd <= 2 && ratio >= 0.95 ? "PASS" : "FAIL", { dropDeltaPx: r2(dd), dispRatio: r2(ratio) }, "≤ 2 px, ≥ 95 %");
  const dragW = Math.hypot(D1.dx, D1.dy) / info.k;
  row("G8", "3 s: mean descendant displacement / drag", at3.n === 0 ? "N/A" : at3.mean / dragW >= 0.9 ? "PASS" : "FAIL", at3.n === 0 ? `no descendants of the grabbed coin (${info.mint})` : { ratio: r2(at3.mean / dragW), n: at3.n }, "≥ 0.90");
  const nb1 = await p.evalJs<{ nbMax: number; fams: number }>("({ nbMax: __qaRec.nbMax, fams: __qaRec.nbFams.size })");
  const vE = f1.filter((f) => f.dragging && f.vEnd);
  // drag 2: 400 px in 100 ms
  const s2 = await p.evalJs<{ x: number; y: number }>(`__sporeMap.screenOf(${J(info.mint)})`);
  const D2 = { dx: -400, dy: 60 };
  const dur2 = await realDrag(p, s2, D2.dx, D2.dy, 100, 6);
  await sleep(400);
  const f2 = await p.evalJs<Frame[]>("window.__qaRec.frames.splice(0)");
  const firstDrag2 = f2.findIndex((f) => f.dragging); const c02 = firstDrag2 > 0 ? f2[firstDrag2 - 1].c : s2;
  let mx2 = 0, n2 = 0; for (const f of f2) { if (!f.dragging || !f.ptr) continue; n2++; mx2 = Math.max(mx2, Math.hypot((f.ptr.x - s2.x) - (f.c.x - c02.x), (f.ptr.y - s2.y) - (f.c.y - c02.y))); }
  row("G7", "drag 400 px / 100 ms: max |pointer − coin|", n2 && mx2 <= 2 ? "PASS" : "FAIL", { maxLagPx: r2(mx2), frames: n2, durMs: dur2 }, "≤ 2 px");
  vE.push(...f2.filter((f) => f.dragging && f.vEnd));
  const nb2 = await p.evalJs<{ nbMax: number; fams: number }>("({ nbMax: __qaRec.nbMax, fams: __qaRec.nbFams.size })");
  row("G9", "max |Δ| of every coin outside g ∪ D, every frame (world u)", nb2.nbMax === 0 ? "PASS" : "FAIL", { maxWorld: r4(nb2.nbMax), maxPx: r2(nb2.nbMax * info.k), families: nb2.fams, afterDrag1: r4(nb1.nbMax) }, "0.0 (base 65.8 px, 111 families)");
  if (!vE.length) row("G11", "veinPath endpoints vs live centres, every drag frame", "N/A", "n/a (interface absent)", "≤ 1 px");
  else { const m = Math.max(...vE.map((f) => Math.max(...(f.vEnd as number[])))); row("G11", "veinPath endpoints vs live centres, every drag frame", m <= 1 ? "PASS" : "FAIL", { maxPx: r2(m), frames: vE.length }, "≤ 1 px"); }
  // G12 while held: press, wiggle 1.5 s
  {
    const sh = await p.evalJs<{ x: number; y: number }>(`__sporeMap.screenOf(${J(info.mint)})`);
    await p.mouse("mouseMoved", sh.x, sh.y); await p.mouse("mousePressed", sh.x, sh.y);
    const t0 = await p.evalJs<number>("performance.now()"); const tt = Date.now(); let k = 0;
    while (Date.now() - tt < 1600) { k++; await p.mouse("mouseMoved", sh.x + 8 + 6 * Math.sin(k / 5), sh.y + 6 * Math.cos(k / 5), { buttons: 1, button: "left" }); await sleep(16); }
    const st = await p.evalJs<{ p95: number }>(rafStatsJs(t0));
    // back to the press point before the release, so the held wiggle adds no displacement to G8's expected drag
    await p.mouse("mouseMoved", sh.x, sh.y, { buttons: 1, button: "left" }); await sleep(50);
    await p.mouse("mouseReleased", sh.x, sh.y);
    raw.perfHeld = st;
    gateNum("G12", "p95 frame while a coin is held (rAF timestamps)", st?.p95, (v) => v <= 16.8, "≤ 16.8 ms", "no rAF probe");
  }
  await sleep(1500);
  raw.drag = { rec, home0, desc: desc0.length / 3, frames1: f1.length, frames2: f2.length, at15, at3, rope: await call(p, "rope"), moved: await call(p, "moved"), home: await call(p, "home", info.g) };
  await p.evalJs("window.__qaRec.stop = true");
  raw.dragCast = await stopCast();
  // G8 persistence: a resize, then compare world(g) with a fresh mount's (the size control left the page 2026-10-25)
  await p.viewport(1280, 800, 1, false); await sleep(800); await p.viewport(1440, 900, 1, false); await settle(p, 800);
  const wNow = await p.evalJs<{ x: number; y: number } | null>(`__sporeMap.eng.world(__sporeMap.eng.indexOf(${J(info.mint)}))`);
  const fresh = await br.newPage(); allPages.push(fresh);
  await openMap(fresh, "/map");
  const wFresh = await fresh.evalJs<{ x: number; y: number } | null>(`__sporeMap.eng.world(__sporeMap.eng.indexOf(${J(info.mint)}))`);
  await fresh.close();
  const expW = Math.hypot((D1.dx + D2.dx) / info.k, (D1.dy + D2.dy) / info.k);
  const got = wNow && wFresh ? Math.hypot(wNow.x - wFresh.x, wNow.y - wFresh.y) : null;
  row("G8", "after a resize: displacement vs fresh mount", got !== null && got / expW >= 0.9 ? "PASS" : "FAIL", { ratio: got !== null ? r2(got / expW) : null, wNow, wFresh, home0 }, "≥ 0.90 of both drags");
  // drag-mid shot (not measured): a slow held drag of g, the frame taken while held
  {
    const sm = await p.evalJs<{ x: number; y: number } | null>(`__sporeMap.screenOf(${J(info.mint)})`);
    if (sm) {
      await p.mouse("mouseMoved", sm.x, sm.y); await p.mouse("mousePressed", sm.x, sm.y);
      for (let k = 1; k <= 10; k++) { await p.mouse("mouseMoved", sm.x + 16 * k, sm.y - 6 * k, { buttons: 1, button: "left" }); await sleep(16); }
      await sleep(60); await shot(p, "drag-mid");
      await p.mouse("mouseReleased", sm.x + 160, sm.y - 60); await settle(p, 500);
    }
  }
  // G10 chain on the $PUMP top: 600 ms, 200 px
  await p.evalJs("__sporeMap.fit()"); await settle(p, 300);
  await p.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`); await settle(p, 1200);
  const topS = await p.evalJs<{ x: number; y: number; r: number }>(`__sporeMap.screenOf(${J(pump)})`);
  await p.evalJs(`(() => { const e = __sporeMap.eng, top = e.indexOf(${J(pump)}); const kids = e.children(top); const R = window.__qaChain = { f: [], stop: false }; const loop = () => { if (R.stop) return; const a = e.allXY(); R.f.push({ t: performance.now(), top: [a.x[top], a.y[top]], k: kids.map((i) => [a.x[i], a.y[i]]), dragging: !!e.drag(), rope: __qa.call("rope") }); requestAnimationFrame(loop); }; requestAnimationFrame(loop); return kids.length; })()`);
  await sleep(100);
  const tRel2 = await (async () => { await realDrag(p, topS, 200, 0, 600, 36); return p.evalJs<number>("performance.now()"); })();
  await sleep(3200);
  const ch = await p.evalJs<{ t: number; top: number[]; k: number[][]; dragging: boolean; rope: unknown }[]>("(() => { window.__qaChain.stop = true; return window.__qaChain.f; })()");
  if (ch.length > 2) {
    const f0 = ch[0], dirx = 1, kN = f0.k.length;
    const mid = ch.filter((f) => f.dragging); const midF = mid[Math.floor(mid.length / 2)];
    let trail = 0; if (midF) for (let j = 0; j < kN; j++) { const dt = midF.top[0] - f0.top[0], dk = midF.k[j][0] - f0.k[j][0]; if (dt - dk > 1e-3) trail++; }
    row("G10", "mid-drag: gen-1 kids trailing the top (lag > 0)", midF && trail > kN * 0.5 ? "PASS" : "FAIL", { trailing: trail, of: kN }, "> 0 (most kids)");
    const post = ch.filter((f) => f.t > tRel2);
    let restAt: number | null = null;
    for (let i = 1; i < post.length; i++) { let mv = 0; for (let j = 0; j < kN; j++) mv = Math.max(mv, Math.hypot(post[i].k[j][0] - post[i - 1].k[j][0], post[i].k[j][1] - post[i - 1].k[j][1])); if (mv * (topS.r ? 1 : 1) > 0.5 / 1e9 && mv > 1e-4) restAt = post[i].t - tRel2; }
    const ropeNA = isNA(ch[ch.length - 1].rope);
    gateNum("G10", "descendants at rest after release (last kid motion, s)", restAt === null ? 0 : restAt / 1000, (v) => v <= 1.2, "≤ 1.2 s");
    const last = post[post.length - 1] ?? ch[ch.length - 1]; const ov: number[] = [];
    for (let j = 0; j < kN; j++) { const fin = last.k[j][0] - f0.k[j][0]; if (Math.abs(fin) < 1e-3) continue; let mx = -Infinity; for (const f of post) mx = Math.max(mx, (f.k[j][0] - f0.k[j][0] - fin) * dirx); ov.push(mx / Math.abs(fin)); }
    ov.sort((a, b) => a - b); const med = ov.length ? ov[Math.floor(ov.length / 2)] : null;
    gateNum("G10", "overshoot (median over gen-1 kids)", med, (v) => v >= 0.02 && v <= 0.2, "2–20 %", "no kid has a final displacement (they returned home)");
    raw.chain = { frames: ch.length, kids: kN, restAt, rope: ropeNA ? "n/a (interface absent)" : ch[ch.length - 1].rope, topFinalDx: last.top[0] - f0.top[0] };
  }
  await p.close();
}

// ------------------------------------------------------------------ G3 attachment ($SI at 8× and the focus view)
async function g3(br: Browser) {
  const p = await br.newPage(); allPages.push(p);
  await openMap(p, "/map");
  const si = await p.evalJs<string | null>(`__qa.rootOf(null, ${J(SI_PREFIX)})`);
  if (!si) { row("G3", "attachment", "FAIL", `no root ${SI_PREFIX}…`, ""); return; }
  const measure = async (tag: string) => {
    const pairs = await p.evalJs<{ p: number; c: number; vp: unknown; sp: { x: number; y: number; r: number }; sc: { x: number; y: number; r: number } }[]>(`(() => {
      const e = __sporeMap.eng, top = e.indexOf(${J(si)}); const W = innerWidth, H = innerHeight; const out = []; const q = [top];
      while (q.length && out.length < 10) { const pp = q.shift(); for (const c of e.children(pp)) { q.push(c); const sp = __qa.scr(pp), sc = __qa.scr(c); if (!sp || !sc) continue; if (sc.x < 0 || sc.y < 0 || sc.x > W || sc.y > H || sp.x < 0 || sp.y < 0 || sp.x > W || sp.y > H) continue; if (Math.hypot(sc.x - sp.x, sc.y - sp.y) < sp.r + sc.r + 3) continue; out.push({ p: pp, c, vp: __qa.call("veinPath", c, 16), sp, sc }); if (out.length >= 10) break; } }
      return out;
    })()`);
    const img = await shot(p, `attach-${tag}`);
    const sx = img.w / 1440;
    // background luminance: the 10th percentile of the map inset rect (the app panels are excluded)
    const IR = await p.evalJs<{ x0: number; y0: number; x1: number; y1: number }>("__qa.inset()"); const lums: number[] = []; for (let y = Math.ceil(IR.y0 * sx); y < IR.y1 * sx; y += 5) for (let x = Math.ceil(IR.x0 * sx); x < IR.x1 * sx; x += 5) lums.push(lumAt(img, x, y)); lums.sort((a, b) => a - b);
    const bg = lums[Math.floor(lums.length * 0.1)], thr = bg + 24;
    const res: unknown[] = []; let worst = 0, viaPath = 0;
    for (const pr of pairs) {
      const vp = pr.vp as { pts?: { x: number; y: number }[] } | { na: string };
      let pts: { x: number; y: number }[];
      if (!isNA(vp) && vp.pts && vp.pts.length > 1) { pts = vp.pts.map((q) => ({ x: q.x + 0, y: q.y + 0 })); viaPath++; const o = await p.evalJs<{ x: number; y: number }>("__qa.o"); pts = pts.map((q) => ({ x: q.x + o.x, y: q.y + o.y })); }
      else pts = [{ x: pr.sp.x, y: pr.sp.y }, { x: pr.sc.x, y: pr.sc.y }];
      // walk the polyline in 0.5 px steps (CSS px), outside both drawn discs minus 1 px, record dark runs
      const seq: { d: number; dark: boolean; nearP: boolean; nearC: boolean }[] = []; let acc = 0;
      for (let s = 0; s < pts.length - 1; s++) { const a = pts[s], b = pts[s + 1], L = Math.hypot(b.x - a.x, b.y - a.y); for (let t = 0; t < L; t += 0.5) { const x = a.x + ((b.x - a.x) * t) / L, y = a.y + ((b.y - a.y) * t) / L; const dp = Math.hypot(x - pr.sp.x, y - pr.sp.y), dc = Math.hypot(x - pr.sc.x, y - pr.sc.y); if (dp < pr.sp.r - 1 || dc < pr.sc.r - 1) { acc += 0.5; continue; } seq.push({ d: acc, dark: lumAt(img, x * sx, y * sx) < thr, nearP: dp < pr.sp.r + 20, nearC: dc < pr.sc.r + 20, l: Math.round(lumAt(img, x * sx, y * sx)) } as { d: number; dark: boolean; nearP: boolean; nearC: boolean }); acc += 0.5; } }
      // the family glow lifts the floor near a family: also require "halfway between the local background (10th percentile of a ring
      // r+4..r+24 around each end) and the band's own median"; a sample darker than max(bg + 24, that) is dark
      const ringBg = (c: { x: number; y: number; r: number }) => { const v: number[] = []; for (let rr = c.r + 4; rr <= c.r + 24; rr += 4) for (let a = 0; a < 6.283; a += 0.2) { const l = lumAt(img, (c.x + rr * Math.cos(a)) * sx, (c.y + rr * Math.sin(a)) * sx); if (l >= 0) v.push(l); } v.sort((x, y) => x - y); return v.length ? v[Math.floor(v.length * 0.1)] : bg; };
      const mids = seq.slice(Math.floor(seq.length * 0.25), Math.ceil(seq.length * 0.75)).map((q) => (q as unknown as { l: number }).l).sort((x, y) => x - y);
      const band = mids.length ? mids[Math.floor(mids.length / 2)] : 0, lbP = ringBg(pr.sp), lbC = ringBg(pr.sc);
      const thrP = Math.max(thr, lbP + 0.5 * (band - lbP)), thrC = Math.max(thr, lbC + 0.5 * (band - lbC));
      for (const q of seq) { const l = (q as unknown as { l: number }).l; q.dark = l < (q.nearC && !q.nearP ? thrC : q.nearP && !q.nearC ? thrP : Math.max(thrP, thrC)); }
      let runP = 0, runC = 0, runMid = 0, cur = 0;
      // the longest dark run within 20 px of each rim (the sphere's own anti-aliased edge may be lit, so the run need not touch it)
      let cp = 0, cc = 0;
      for (const q of seq) { cp = q.dark && q.nearP ? cp + 0.5 : 0; runP = Math.max(runP, cp); cc = q.dark && q.nearC ? cc + 0.5 : 0; runC = Math.max(runC, cc); cur = q.dark ? cur + 0.5 : 0; runMid = Math.max(runMid, cur); }
      worst = Math.max(worst, runP, runC);
      res.push({ band, lbP: r2(lbP), lbC: r2(lbC), prof: seq.filter((_, i) => i % 4 === 0).map((q) => (q as unknown as { l: number }).l), sp: pr.sp, sc: pr.sc, p: pr.p, c: pr.c, gapAtParentPx: runP, gapAtChildPx: runC, maxDarkRunPx: runMid, rP: r2(pr.sp.r), rC: r2(pr.sc.r), samples: seq.length });
    }
    return { pairs: res, bg: r2(bg), worstRimGapPx: worst, viaVeinPath: viaPath, n: pairs.length };
  };
  await p.evalJs(`__sporeMap.zoomTo(${J(si)}, 8)`); await settle(p, 2000); await p.mouse("mouseMoved", 2, 2);
  const a = await measure("si-8x");
  const st = (m: { worstRimGapPx: number; viaVeinPath: number; n: number }) => (m.n === 0 ? "FAIL" : m.viaVeinPath === 0 ? "N/A" : m.worstRimGapPx <= 1 ? "PASS" : "FAIL") as Status;
  row("G3", "$SI 8×: max dark run at either rim, 10 pairs", st(a), { worstRimGapPx: a.worstRimGapPx, pairs: a.n, viaVeinPath: a.viaVeinPath, note: a.viaVeinPath ? "veinPath" : "n/a (veinPath absent): chord fallback measured" }, "≤ 1 px (base 6–13 px at the child)");
  await p.evalJs("__sporeMap.fit()"); await settle(p, 300);
  await p.evalJs(`__sporeMap.focusFamily("SI")`, 20_000).catch(() => null); await settle(p, 300);
  const kF = await p.evalJs<number>("__sporeMap.zoom()").catch(() => 0);
  await p.evalJs(`__sporeMap.zoomTo(${J(si)}, ${Math.max(8, 2 * (Number(kF) || 0))})`); await settle(p, 2000); await p.mouse("mouseMoved", 2, 2);
  const dp = await measure("si-deep");
  row("G3", `$SI family-framed ×2 (zoom ${r2(Math.max(8, 2 * (Number(kF) || 0)))}): max dark run at either rim`, st(dp), { worstRimGapPx: dp.worstRimGapPx, pairs: dp.n, viaVeinPath: dp.viaVeinPath }, "≤ 1 px (information: deeper than 8×)");
  // the focus view of the biggest gen-1 $SI child
  const kid = await p.evalJs<string | null>(`(() => { const e = __sporeMap.eng, top = e.indexOf(${J(si)}); let best = -1, br = -1; for (const c of e.children(top)) { const w = e.world(c); if (w && w.r > br) { br = w.r; best = c; } } return best >= 0 ? e.mintAt(best) : null; })()`);
  if (kid) { await p.evalJs(`__sporeMap.fly(${J(kid)})`); await settle(p, 3200); }
  const b = await measure("si-focus");
  row("G3", "$SI focus view: max dark run at either rim", st(b), { worstRimGapPx: b.worstRimGapPx, pairs: b.n, viaVeinPath: b.viaVeinPath, kid }, "≤ 1 px");
  raw.g3 = { si, at8x: a, deep: dp, kF, focus: b };
  await p.close();
}

// ------------------------------------------------------------------ G14 flat
async function g14(br: Browser) {
  const p = await br.newPage(); allPages.push(p);
  let ok = true, look: unknown = null;
  try { await p.navigate(BASE + u("/map?look=flat"), 60_000); await p.waitFor(mapReadyJs("three"), 120_000, "flat map"); await sleep(2000); look = await p.evalJs("__sporeMap.look()"); }
  catch (e) { ok = false; look = (e as Error).message; }
  const errs = p.errors.filter((e) => !/\/api\/candles/.test(e));
  row("G14", "?look=flat mounts, 0 errors", ok && look === "flat" && errs.length === 0 ? "PASS" : "FAIL", { look, errors: errs.slice(0, 3) }, "flat, 0 errors");
  await p.close();
}

// ------------------------------------------------------------------ main
const t00 = Date.now();
const step = async (name: string, f: () => Promise<unknown>) => { const t = Date.now(); try { await f(); } catch (e) { row(name, "harness", "FAIL", `crashed: ${(e as Error).message.slice(0, 300)}`, "no crash"); } (raw.timings ||= {} as Record<string, number>); (raw.timings as Record<string, number>)[name] = Date.now() - t; };
try {
  if (on("G5")) await step("G5", g5);
  const br = await launchChrome({ gpu: "metal", width: 1440, height: 900 }); browsers.push(br);
  if (["G1", "G2", "G4", "G13", "G12"].some(on)) await step("G1/G2/G4/G13/G12", () => gLook(br));
  if (on("G6")) await step("G6", () => g6(br));
  if (["G7", "G8", "G9", "G10", "G11"].some(on)) await step("G7-G11", () => gDrag(br));
  if (on("G3")) await step("G3", () => g3(br));
  if (on("G14")) await step("G14", () => g14(br));
} finally {
  const errs = [...new Set(allPages.flatMap((p) => p.errors))].filter((e) => !/\/api\/candles/.test(e));
  row("G12", "console errors (all pages, /api/candles 404 ignored)", errs.length === 0 ? "PASS" : "FAIL", errs.length, "0");
  raw.consoleErrors = errs.slice(0, 20);
  raw.netErrors = [...new Set(allPages.flatMap((p) => p.netErrors))].slice(0, 20);
  for (const b of browsers) await b.close().catch(() => null);
}
raw.ms = Date.now() - t00;
raw.rows = rows;
const counts = { PASS: rows.filter((r) => r.status === "PASS").length, FAIL: rows.filter((r) => r.status === "FAIL").length, "N/A": rows.filter((r) => r.status === "N/A").length };
raw.counts = counts; raw.ok = counts.FAIL === 0 && counts["N/A"] === 0;
writeFileSync(join(OUT, "map3-feel.json"), JSON.stringify(raw, null, 2));
const cell = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 140);
console.log("\n| gate | check | status | value | need |\n|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.gate} | ${r.check} | ${r.status} | ${cell(r.value)} | ${r.need} |`);
console.log(`\n${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts["N/A"]} N/A — ${join(OUT, "map3-feel.json")}`);
console.log(JSON.stringify({ ok: raw.ok, counts, rows }, null, 0).slice(0, 200000));
process.exit(raw.ok ? 0 : 1);
